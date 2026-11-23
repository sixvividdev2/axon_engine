import * as THREE from 'three';
import {
  BodycamGearRattleKind,
  BodycamMeleeAttackType,
  BodycamSurfaceMaterial,
  BodycamWeaponAudioCue,
  BodycamWeaponCueOptions,
  IBodycamAudioSource,
} from '../../bodycam-sdk';
import { CaliberId } from '../../data/calibers';

export class AudioEngine implements IBodycamAudioSource {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLowpass: BiquadFilterNode | null = null;
  private micShaper: WaveShaperNode | null = null;
  private micCompressor: DynamicsCompressorNode | null = null;
  private dryBus: GainNode | null = null;
  private wetBus: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private interiorWetBus: GainNode | null = null;
  private interiorConvolver: ConvolverNode | null = null;

  private windGain: GainNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windDuckTimeout = 0;
  private currentIndoor = false;
  private currentInteriorMaterial: 'concrete' | 'wood' | 'metal' | 'outdoor' = 'outdoor';

  private noiseBuffer: AudioBuffer | null = null;
  private clipDrive = 4.5;
  private masterVolume = 0.85;
  private gearRattleGain = 0.72;
  private initialized = false;

  private lastHeartbeatMs = 0;
  private lastBreathMs = 0;
  private activeTinnitusOsc: OscillatorNode | null = null;
  private activeTinnitusGain: GainNode | null = null;
  private readonly listenerPos = new THREE.Vector3();
  private activeZombieVocals = 0;
  private activeZombieSteps = 0;

  public ensureInitialized(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    // Master out
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);
    this.masterGain = master;

    // Master trauma concussion low-pass filter (muffles world audio during head trauma)
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 22000;
    lp.Q.value = 0.7;
    lp.connect(master);
    this.masterLowpass = lp;

    // Bodycam chest-mic DynamicsCompressorNode -> limits loud shots and ducks wind
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 6;
    comp.ratio.value = 14;
    comp.attack.value = 0.0015;
    comp.release.value = 0.24;
    comp.connect(lp);
    this.micCompressor = comp;

    // Bodycam chest-mic WaveShaperNode -> authentic capsule saturation on transients
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.makeClipCurve(this.clipDrive);
    shaper.oversample = '2x';
    shaper.connect(comp);
    this.micShaper = shaper;

    // Dry & Wet buses feed into chest mic shaper -> compressor
    const dry = ctx.createGain();
    dry.gain.value = 1.0;
    dry.connect(shaper);
    this.dryBus = dry;

    const convolver = ctx.createConvolver();
    convolver.buffer = this.createImpulseResponse(ctx, 1.8, 2.8, false);
    this.convolver = convolver;

    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    wet.connect(convolver);
    convolver.connect(shaper);
    this.wetBus = wet;

    // Tight interior slapback convolver for rooms/bunkers/garages
    const intConvolver = ctx.createConvolver();
    intConvolver.buffer = this.createImpulseResponse(ctx, 0.48, 3.6, true);
    this.interiorConvolver = intConvolver;

    const intWet = ctx.createGain();
    intWet.gain.value = 0.0;
    intWet.connect(intConvolver);
    intConvolver.connect(shaper);
    this.interiorWetBus = intWet;

    // Reusable white noise buffer (2 seconds)
    this.noiseBuffer = this.createNoiseBuffer(ctx, 2.0);

    // Start desolate wind ambience
    this.startWindAmbience();

    this.initialized = true;
  }

  private makeClipCurve(drive: number): Float32Array<ArrayBuffer> {
    const samples = 1024;
    const buf = new ArrayBuffer(samples * 4);
    const curve = new Float32Array(buf);
    const k = Math.max(0.5, drive * 8);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft-hard asymmetric chest mic capsule clipping
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private createImpulseResponse(
    ctx: AudioContext,
    durationSec: number,
    decay: number,
    tightInterior: boolean,
  ): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = impulse.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        const white = (Math.random() * 2 - 1) * env;
        lp = lp * (tightInterior ? 0.38 : 0.65) + white * (tightInterior ? 0.62 : 0.35);
        let slap = lp;
        if (tightInterior) {
          // Crisp 12ms / 26ms / 48ms room slapback reflections
          if (
            i === Math.floor(ctx.sampleRate * 0.012) ||
            i === Math.floor(ctx.sampleRate * 0.026) ||
            i === Math.floor(ctx.sampleRate * 0.048)
          ) {
            slap += (Math.random() * 2 - 1) * 0.78;
          }
        } else if (i === Math.floor(ctx.sampleRate * 0.045) || i === Math.floor(ctx.sampleRate * 0.11)) {
          slap += (Math.random() * 2 - 1) * 0.55;
        }
        ch[i] = slap;
      }
    }
    return impulse;
  }

  private startWindAmbience(): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 340;
    bp.Q.value = 1.6;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 720;

    // Subtle wind gust LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.14;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);
    lfo.start();

    const windGain = ctx.createGain();
    windGain.gain.value = 0.0968; // Reduced 12% from 0.11

    src.connect(bp);
    bp.connect(lp);
    lp.connect(windGain);
    windGain.connect(this.dryBus);
    src.start();

    this.windGain = windGain;
    this.windSource = src;
  }

  public setSettings(clipDrive: number, masterVolume: number): void {
    this.clipDrive = clipDrive;
    this.masterVolume = masterVolume;
    if (this.micShaper) {
      this.micShaper.curve = this.makeClipCurve(clipDrive);
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(masterVolume, this.ctx.currentTime, 0.04);
    }
  }

  public updateListener(
    position: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    up: Readonly<THREE.Vector3>,
  ): void {
    this.listenerPos.copy(position);
    if (!this.ctx) return;
    const listener = this.ctx.listener;
    if (listener.positionX) {
      const t = this.ctx.currentTime;
      listener.positionX.setValueAtTime(position.x, t);
      listener.positionY.setValueAtTime(position.y, t);
      listener.positionZ.setValueAtTime(position.z, t);
      listener.forwardX.setValueAtTime(forward.x, t);
      listener.forwardY.setValueAtTime(forward.y, t);
      listener.forwardZ.setValueAtTime(forward.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
    }
  }

  private createHRTFPanner(pos: Readonly<THREE.Vector3>, refDist = 2.0, maxDist = 110): PannerNode | null {
    if (!this.ctx) return null;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDist;
    panner.maxDistance = maxDist;
    panner.rolloffFactor = 1.15;
    panner.positionX.setValueAtTime(pos.x, this.ctx.currentTime);
    panner.positionY.setValueAtTime(pos.y, this.ctx.currentTime);
    panner.positionZ.setValueAtTime(pos.z, this.ctx.currentTime);
    return panner;
  }

  public setInteriorAcoustics(
    isIndoor: boolean,
    material: 'concrete' | 'wood' | 'metal' | 'outdoor',
  ): void {
    if (this.currentIndoor === isIndoor && this.currentInteriorMaterial === material) return;
    this.currentIndoor = isIndoor;
    this.currentInteriorMaterial = material;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const targetWind = isIndoor ? 0.01936 : 0.0968; // Reduced 12%
    const targetOutWet = isIndoor ? 0.05 : 0.34;
    const targetIntWet = isIndoor
      ? material === 'concrete'
        ? 0.48
        : material === 'metal'
          ? 0.56
          : 0.32
      : 0.0;

    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(targetWind, t, 0.15);
    }
    if (this.wetBus) {
      this.wetBus.gain.setTargetAtTime(targetOutWet, t, 0.12);
    }
    if (this.interiorWetBus) {
      this.interiorWetBus.gain.setTargetAtTime(targetIntWet, t, 0.12);
    }
  }

  private duckAmbientWind(durationSec = 0.85, targetGain = 0.0132): void {
    if (!this.ctx || !this.windGain) return;
    const t = this.ctx.currentTime;
    const restoreGain = this.currentIndoor ? 0.01936 : 0.0968;
    this.windGain.gain.cancelScheduledValues(t);
    this.windGain.gain.setValueAtTime(this.windGain.gain.value, t);
    this.windGain.gain.linearRampToValueAtTime(Math.min(targetGain, restoreGain), t + 0.015);
    this.windGain.gain.exponentialRampToValueAtTime(restoreGain, t + durationSec);
    window.clearTimeout(this.windDuckTimeout);
  }

  public playGunshot(pos: THREE.Vector3, caliberId: CaliberId, suppressed: boolean): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const panner = this.createHRTFPanner(pos, 1.5, 160);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // Calibrate boom & snap by caliber
    const heavy = caliberId === '762x39_ps' || caliberId === '12ga_00buck';
    const rifle = caliberId === '545x39_7n6' || caliberId === '556x45_m855' || heavy;

    // 1. Sub-bass punch / chest thump (clips the WaveShaper authentically!)
    const thumpOsc = ctx.createOscillator();
    thumpOsc.type = 'triangle';
    thumpOsc.frequency.setValueAtTime(suppressed ? 130 : heavy ? 115 : 155, t);
    thumpOsc.frequency.exponentialRampToValueAtTime(34, t + (suppressed ? 0.07 : 0.14));

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(suppressed ? 0.65 : rifle ? 2.4 : 1.7, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + (suppressed ? 0.08 : 0.18));
    thumpOsc.connect(thumpGain);
    thumpGain.connect(panner);
    thumpOsc.start(t);
    thumpOsc.stop(t + 0.2);

    // 2. Muzzle blast noise burst
    const blast = ctx.createBufferSource();
    blast.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = suppressed ? 'lowpass' : 'bandpass';
    bp.frequency.setValueAtTime(suppressed ? 950 : rifle ? 1650 : 1950, t);
    bp.frequency.exponentialRampToValueAtTime(suppressed ? 240 : 380, t + (suppressed ? 0.09 : 0.26));
    bp.Q.value = 0.7;

    const blastGain = ctx.createGain();
    const peakGain = suppressed ? 0.52 : rifle ? 2.8 : 2.1;
    blastGain.gain.setValueAtTime(peakGain, t);
    blastGain.gain.exponentialRampToValueAtTime(0.001, t + (suppressed ? 0.11 : heavy ? 0.34 : 0.25));

    blast.connect(bp);
    bp.connect(blastGain);
    blastGain.connect(panner);
    blast.start(t);
    blast.stop(t + 0.38);

    // 3. Mechanical bolt clack
    const boltOsc = ctx.createOscillator();
    boltOsc.type = 'square';
    boltOsc.frequency.setValueAtTime(2400, t + 0.012);
    boltOsc.frequency.exponentialRampToValueAtTime(750, t + 0.042);
    const boltGain = ctx.createGain();
    boltGain.gain.setValueAtTime(0.18, t + 0.012);
    boltGain.gain.exponentialRampToValueAtTime(0.001, t + 0.048);
    boltOsc.connect(boltGain);
    boltGain.connect(panner);
    boltOsc.start(t + 0.012);
    boltOsc.stop(t + 0.055);

    if (!suppressed) {
      this.duckAmbientWind(1.1, 0.01);
    }
  }

  public playDryFire(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(3400, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.025);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);

    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.035);
  }

  public playReloadFoley(stage: 'out' | 'in' | 'rack' | 'check'): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = stage === 'rack' ? 'sawtooth' : 'square';
    const baseFreq = stage === 'out' ? 900 : stage === 'in' ? 680 : stage === 'rack' ? 1450 : 1100;
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.42, t + 0.055);

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.065);

    osc.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  public playWeaponCue(cue: BodycamWeaponAudioCue, options?: BodycamWeaponCueOptions): void {
    if (cue === 'fire') {
      const pos = options?.position ?? new THREE.Vector3();
      const cal: CaliberId =
        (options?.caliberId as CaliberId | undefined) ??
        (options?.weightClass === 'pistol'
          ? '9x19_fmj'
          : options?.weightClass === 'heavy_rifle'
            ? '762x39_ps'
            : '545x39_7n6');
      this.playGunshot(pos, cal, Boolean(options?.suppressed));
      return;
    }
    if (cue === 'dryfire') {
      this.playDryFire();
      return;
    }

    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(options?.intensity ?? 1.0, 0.2, 1.8);
    const isPistol = options?.weightClass === 'pistol';
    const pitchScale = isPistol ? 1.24 : options?.weightClass === 'heavy_rifle' ? 0.86 : 1.0;

    if (cue === 'ads_rustle') {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(740 * pitchScale, t);
      bp.frequency.exponentialRampToValueAtTime(480 * pitchScale, t + 0.13);
      bp.Q.value = 1.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.065 * amp, t + 0.022);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.dryBus);
      src.start(t, Math.random() * 1.1, 0.15);
      return;
    }

    if (cue === 'mag_out') {
      const click = ctx.createOscillator();
      click.type = 'square';
      click.frequency.setValueAtTime(2100 * pitchScale, t);
      click.frequency.exponentialRampToValueAtTime(780 * pitchScale, t + 0.018);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.16 * amp, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.024);
      click.connect(cg);
      cg.connect(this.dryBus);
      click.start(t);
      click.stop(t + 0.03);

      const slide = ctx.createBufferSource();
      slide.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1650 * pitchScale, t + 0.015);
      bp.frequency.exponentialRampToValueAtTime(920 * pitchScale, t + 0.12);
      bp.Q.value = 2.8;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, t + 0.012);
      sg.gain.linearRampToValueAtTime(0.15 * amp, t + 0.032);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.125);
      slide.connect(bp);
      bp.connect(sg);
      sg.connect(this.dryBus);
      slide.start(t + 0.012, Math.random() * 1.1, 0.14);
      return;
    }

    if (cue === 'mag_in') {
      const thump = ctx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(240 * pitchScale, t);
      thump.frequency.exponentialRampToValueAtTime(78, t + 0.055);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.28 * amp, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.068);
      thump.connect(tg);
      tg.connect(this.dryBus);
      thump.start(t);
      thump.stop(t + 0.075);

      const latch = ctx.createOscillator();
      latch.type = 'square';
      latch.frequency.setValueAtTime(1920 * pitchScale, t + 0.026);
      latch.frequency.exponentialRampToValueAtTime(640 * pitchScale, t + 0.058);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200 * pitchScale;
      bp.Q.value = 1.8;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0.22 * amp, t + 0.026);
      lg.gain.exponentialRampToValueAtTime(0.001, t + 0.068);
      latch.connect(bp);
      bp.connect(lg);
      lg.connect(this.dryBus);
      latch.start(t + 0.026);
      latch.stop(t + 0.075);
      return;
    }

    // 'rack'
    const pull = ctx.createBufferSource();
    pull.buffer = this.noiseBuffer;
    const pbp = ctx.createBiquadFilter();
    pbp.type = 'bandpass';
    pbp.frequency.setValueAtTime(2150 * pitchScale, t);
    pbp.frequency.exponentialRampToValueAtTime(3100 * pitchScale, t + 0.068);
    pbp.Q.value = 3.2;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.001, t);
    pg.gain.linearRampToValueAtTime(0.19 * amp, t + 0.015);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    pull.connect(pbp);
    pbp.connect(pg);
    pg.connect(this.dryBus);
    pull.start(t, Math.random() * 1.0, 0.09);

    const slamT = t + (isPistol ? 0.08 : 0.105);
    const slam = ctx.createOscillator();
    slam.type = 'sawtooth';
    slam.frequency.setValueAtTime(1680 * pitchScale, slamT);
    slam.frequency.exponentialRampToValueAtTime(420 * pitchScale, slamT + 0.045);
    const sbp = ctx.createBiquadFilter();
    sbp.type = 'bandpass';
    sbp.frequency.value = 2100 * pitchScale;
    sbp.Q.value = 1.9;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.26 * amp, slamT);
    sg.gain.exponentialRampToValueAtTime(0.001, slamT + 0.055);
    slam.connect(sbp);
    sbp.connect(sg);
    sg.connect(this.dryBus);
    slam.start(slamT);
    slam.stop(slamT + 0.062);
  }

  public playFootstep(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.15, 2.0);
    const pitchJitter = 0.92 + Math.random() * 0.16;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    if (surface === 'grass') {
      filter.frequency.value = 760 * pitchJitter;
      filter.Q.value = 0.85;
    } else if (surface === 'wood') {
      filter.frequency.value = 320 * pitchJitter;
      filter.Q.value = 2.4;
    } else if (surface === 'metal') {
      filter.frequency.value = 1180 * pitchJitter;
      filter.Q.value = 3.2;
    } else if (surface === 'puddle') {
      filter.frequency.value = 1480 * pitchJitter;
      filter.Q.value = 0.7;
    } else if (surface === 'gravel' || surface === 'glass') {
      filter.frequency.value = 2150 * pitchJitter;
      filter.Q.value = 1.1;
    } else {
      filter.frequency.value = 540 * pitchJitter;
      filter.Q.value = 1.5;
    }

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.145 * amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.095);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.dryBus);
    if (this.currentIndoor && this.interiorWetBus) {
      g.connect(this.interiorWetBus);
    }
    src.start(t, Math.random() * 0.5, 0.11);
  }

  public playGearRattle(kind: BodycamGearRattleKind, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const gainScale = this.gearRattleGain * THREE.MathUtils.clamp(intensity, 0.15, 2.0);
    if (gainScale < 0.02) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Plate carrier fabric rustle
    const fabric = ctx.createBufferSource();
    fabric.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      kind === 'crouch' ? 1150 : kind === 'vault' ? 1480 : kind === 'melee' ? 1540 : 1650;
    bp.Q.value = 1.25;
    const dur =
      kind === 'landing'
        ? 0.19
        : kind === 'vault'
          ? 0.22
          : kind === 'crouch'
            ? 0.16
            : kind === 'melee'
              ? 0.15
              : 0.09;
    const fg = ctx.createGain();
    fg.gain.setValueAtTime(0.001, t);
    fg.gain.linearRampToValueAtTime(
      (kind === 'landing' || kind === 'vault'
        ? 0.085
        : kind === 'melee'
          ? 0.072
          : kind === 'crouch'
            ? 0.055
            : 0.032) * gainScale,
      t + 0.018,
    );
    fg.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    fabric.connect(bp);
    bp.connect(fg);
    fg.connect(this.dryBus);
    fabric.start(t, Math.random() * 1.1, dur + 0.02);

    // Subtle metallic sling swivel / buckle clink on heavy maneuvers
    if (
      kind === 'landing' ||
      kind === 'vault' ||
      kind === 'weapon_swap' ||
      kind === 'melee' ||
      Math.random() < 0.45
    ) {
      const clink = ctx.createOscillator();
      clink.type = 'triangle';
      const baseHz = 2700 + Math.random() * 1400;
      clink.frequency.setValueAtTime(baseHz, t + 0.012);
      clink.frequency.exponentialRampToValueAtTime(baseHz * 0.72, t + 0.052);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(
        (kind === 'landing' || kind === 'vault' || kind === 'melee' ? 0.028 : 0.015) * gainScale,
        t + 0.012,
      );
      cg.gain.exponentialRampToValueAtTime(0.0006, t + 0.058);
      clink.connect(cg);
      cg.connect(this.dryBus);
      clink.start(t + 0.012);
      clink.stop(t + 0.062);
    }
  }

  public playHandSlap(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.2, 1.8);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const baseHz = surface === 'metal' ? 190 : surface === 'wood' ? 140 : 120;
    osc.frequency.setValueAtTime(baseHz * (0.94 + Math.random() * 0.12), t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.18 * amp, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
    osc.connect(og);
    og.connect(this.dryBus);
    if (this.currentIndoor && this.interiorWetBus) og.connect(this.interiorWetBus);
    osc.start(t);
    osc.stop(t + 0.08);

    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = surface === 'metal' ? 1700 : surface === 'wood' ? 920 : 1280;
    bp.Q.value = surface === 'metal' ? 2.4 : 1.15;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.13 * amp, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
    slap.connect(bp);
    bp.connect(sg);
    sg.connect(this.dryBus);
    slap.start(t, Math.random() * 0.8, 0.075);
  }

  public playBootScuff(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.2, 1.8);

    const scrape = ctx.createBufferSource();
    scrape.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(surface === 'metal' ? 1450 : 940, t);
    bp.frequency.linearRampToValueAtTime(surface === 'metal' ? 950 : 540, t + 0.13);
    bp.Q.value = 1.65;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.14 * amp, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.145);
    scrape.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    if (this.currentIndoor && this.interiorWetBus) g.connect(this.interiorWetBus);
    scrape.start(t, Math.random() * 0.9, 0.16);
  }

  public playMeleeWhoosh(attackType: BodycamMeleeAttackType): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const isKick = attackType === 'kick';
    const isCross = attackType === 'cross';
    const isBash = attackType === 'bash';
    const dur = isKick ? 0.21 : isCross ? 0.17 : isBash ? 0.15 : 0.125;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(isKick ? 460 : isCross ? 680 : isBash ? 580 : 880, t);
    bp.frequency.exponentialRampToValueAtTime(isKick ? 190 : isCross ? 290 : isBash ? 250 : 380, t + dur);
    bp.Q.value = isKick ? 1.5 : 1.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(isKick ? 0.25 : isCross ? 0.20 : isBash ? 0.19 : 0.15, t + dur * 0.28);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.7, dur + 0.02);
  }

  public playMeleeImpact(
    pos: Readonly<THREE.Vector3>,
    attackType: BodycamMeleeAttackType,
    surface: BodycamSurfaceMaterial | 'flesh',
    intensity = 1.0,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.3, 1.8);
    const isKick = attackType === 'kick';
    const isCross = attackType === 'cross';
    const isBash = attackType === 'bash';
    const isFlesh = surface === 'flesh';

    const panner = this.createHRTFPanner(pos, 1.0, 42);
    const dest: AudioNode = panner ?? this.dryBus;
    if (panner) {
      panner.connect(this.dryBus);
      if (this.wetBus) panner.connect(this.wetBus);
      if (this.currentIndoor && this.interiorWetBus) panner.connect(this.interiorWetBus);
    }

    // 1. Heavy kinetic body/boot sub-thud (drives mic overload subtly on hard impacts)
    const bodyOsc = ctx.createOscillator();
    bodyOsc.type = isFlesh ? 'sine' : 'triangle';
    const startHz = isKick ? (isFlesh ? 128 : 158) : isCross || isBash ? 150 : 175;
    const endHz = isKick ? 34 : 46;
    const bodyDur = isKick ? 0.175 : isCross || isBash ? 0.135 : 0.105;
    bodyOsc.frequency.setValueAtTime(startHz * (0.94 + Math.random() * 0.12), t);
    bodyOsc.frequency.exponentialRampToValueAtTime(endHz, t + bodyDur);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime((isKick ? 0.68 : isCross || isBash ? 0.50 : 0.38) * amp, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + bodyDur + 0.015);
    bodyOsc.connect(bodyGain);
    bodyGain.connect(dest);
    bodyOsc.start(t);
    bodyOsc.stop(t + bodyDur + 0.025);

    // 2. Meaty smack / boot-leather crack / surface transient
    const crack = ctx.createBufferSource();
    crack.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = isFlesh
      ? isKick
        ? 640
        : 920
      : surface === 'metal'
        ? 1900
        : surface === 'wood'
          ? 740
          : 1180;
    bp.Q.value = isFlesh ? 0.95 : surface === 'metal' ? 2.6 : 1.3;

    const crackDur = isKick ? 0.115 : 0.085;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime((isKick ? 0.56 : isCross || isBash ? 0.42 : 0.32) * amp, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + crackDur);
    crack.connect(bp);
    bp.connect(cg);
    cg.connect(dest);
    crack.start(t, Math.random() * 0.6, crackDur + 0.015);

    // 3. Secondary metallic/wood resonance on rigid barriers/doors/rifles
    if (surface === 'metal' || surface === 'wood' || isBash) {
      const ring = ctx.createOscillator();
      ring.type = surface === 'metal' ? 'triangle' : 'sine';
      const ringHz = surface === 'metal' ? 680 + Math.random() * 240 : 190 + Math.random() * 60;
      ring.frequency.setValueAtTime(ringHz, t);
      ring.frequency.exponentialRampToValueAtTime(ringHz * 0.62, t + 0.14);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime((surface === 'metal' ? 0.19 : 0.14) * amp, t);
      rg.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      ring.connect(rg);
      rg.connect(dest);
      ring.start(t);
      ring.stop(t + 0.16);
    }
  }

  public playTacticalSwitchClick(on: boolean): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(on ? 2350 : 1650, t);
    osc.frequency.exponentialRampToValueAtTime(on ? 1150 : 760, t + 0.02);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.11, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.024);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.028);
  }

  public playGlassShatter(pos: Readonly<THREE.Vector3>, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.3, 1.5);
    const panner = this.createHRTFPanner(pos, 1.5, 65);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // Crisp initial crack + high-passed glass burst
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.62 * amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    src.connect(hp);
    hp.connect(g);
    g.connect(panner);
    src.start(t, Math.random() * 0.3, 0.28);

    // Scattered high-frequency shard tinkles
    for (let i = 0; i < 6; i++) {
      const delay = 0.02 + i * 0.032 + Math.random() * 0.025;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(3400 + Math.random() * 3200, t + delay);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.11 * amp * (1 - i * 0.11), t + delay);
      sg.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.065);
      osc.connect(sg);
      sg.connect(panner);
      osc.start(t + delay);
      osc.stop(t + delay + 0.075);
    }
  }

  public playDoorCreak(pos: THREE.Vector3, opening: boolean): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.wetBus) return;
    const t = this.ctx.currentTime;
    const panner = this.createHRTFPanner(pos, 1.0, 28);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // Metallic latch click
    const latch = this.ctx.createOscillator();
    latch.type = 'square';
    latch.frequency.setValueAtTime(880, t);
    latch.frequency.exponentialRampToValueAtTime(220, t + 0.04);
    const lg = this.ctx.createGain();
    lg.gain.setValueAtTime(0.24, t);
    lg.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    latch.connect(lg);
    lg.connect(panner);
    latch.start(t);
    latch.stop(t + 0.05);

    // Hinge groan
    const creak = this.ctx.createOscillator();
    creak.type = 'sawtooth';
    creak.frequency.setValueAtTime(opening ? 145 : 195, t + 0.04);
    creak.frequency.linearRampToValueAtTime(opening ? 210 : 120, t + 0.42);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 5.5;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.001, t + 0.04);
    cg.gain.linearRampToValueAtTime(0.11, t + 0.15);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.46);
    creak.connect(bp);
    bp.connect(cg);
    cg.connect(panner);
    creak.start(t + 0.04);
    creak.stop(t + 0.48);
  }

  public playImpact(pos: THREE.Vector3, materialType: 'concrete' | 'wood' | 'metal' | 'flesh'): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const t = this.ctx.currentTime;
    const panner = this.createHRTFPanner(pos, 1.5, 80);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    if (materialType === 'metal') {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2600 + Math.random() * 800, t);
      osc.frequency.exponentialRampToValueAtTime(1100, t + 0.18);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.19);
      osc.connect(g);
      g.connect(panner);
      osc.start(t);
      osc.stop(t + 0.2);
      return;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = materialType === 'flesh' ? 280 : materialType === 'wood' ? 680 : 1400;
    bp.Q.value = 1.4;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(materialType === 'flesh' ? 0.34 : 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    src.connect(bp);
    bp.connect(g);
    g.connect(panner);
    src.start(t, Math.random() * 0.5, 0.09);
  }

  public playZombieVocal(
    pos: Readonly<THREE.Vector3>,
    kind: 'rasp' | 'alert' | 'hurt' | 'moan' | 'groan' | 'snarl' | 'lunge' | 'death',
    opts?: { distanceM?: number; pitchScale?: number; intensity?: number },
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const dist = opts?.distanceM ?? pos.distanceTo(this.listenerPos);
    if (dist > 40) return;

    const mappedKind =
      kind === 'rasp' ? (dist < 14 ? 'groan' : 'moan') : kind === 'alert' ? (dist < 8 ? 'snarl' : 'lunge') : kind;
    const isAggressive = mappedKind === 'snarl' || mappedKind === 'lunge';
    const maxVoices = isAggressive || mappedKind === 'death' ? 8 : 6;
    if (this.activeZombieVocals >= maxVoices) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const pitch = THREE.MathUtils.clamp(opts?.pitchScale ?? 1.0, 0.72, 1.32);
    const intensity = THREE.MathUtils.clamp(opts?.intensity ?? 1.0, 0.4, 1.8);

    const prox = THREE.MathUtils.clamp(1 - dist / 34, 0, 1);
    const closeBoost = THREE.MathUtils.clamp(1 - dist / 9.5, 0, 1);
    const veryClose = THREE.MathUtils.clamp(1 - dist / 4.8, 0, 1);
    const horrorGain = (0.58 + prox * 0.48 + closeBoost * 0.65 + veryClose * 0.42) * intensity;

    const panner = this.createHRTFPanner(pos, isAggressive ? 2.6 : 2.1, 44);
    if (!panner) return;
    panner.rolloffFactor = 1.02;

    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = THREE.MathUtils.clamp(
      (isAggressive ? 2200 : 1450) + prox * 2500 + closeBoost * 3800,
      1200,
      9500,
    );

    const drySend = ctx.createGain();
    drySend.gain.value = 0.62 + closeBoost * 0.56;
    const wetSend = ctx.createGain();
    wetSend.gain.value = 0.56 - closeBoost * 0.22;

    airLp.connect(panner);
    panner.connect(drySend);
    panner.connect(wetSend);
    drySend.connect(this.dryBus);
    wetSend.connect(this.wetBus);
    if (this.interiorWetBus) {
      wetSend.connect(this.interiorWetBus);
    }

    this.activeZombieVocals += 1;

    const dur =
      mappedKind === 'moan'
        ? 0.95 + Math.random() * 0.4
        : mappedKind === 'groan'
          ? 0.68 + Math.random() * 0.28
          : mappedKind === 'snarl'
            ? 0.48 + Math.random() * 0.24
            : mappedKind === 'lunge'
              ? 0.42 + Math.random() * 0.16
              : mappedKind === 'death'
                ? 0.8 + Math.random() * 0.25
                : 0.24 + Math.random() * 0.1;

    const f0Start =
      (mappedKind === 'lunge'
        ? 162
        : mappedKind === 'snarl'
          ? 124
          : mappedKind === 'groan'
            ? 98
            : mappedKind === 'hurt'
              ? 126
              : mappedKind === 'death'
                ? 114
                : 78) *
      pitch *
      (0.92 + Math.random() * 0.16);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0Start, t);
    osc1.frequency.linearRampToValueAtTime(
      f0Start * (mappedKind === 'lunge' ? 1.52 : mappedKind === 'snarl' ? 1.26 : mappedKind === 'death' ? 0.7 : 1.04),
      t + dur * 0.34,
    );
    osc1.frequency.exponentialRampToValueAtTime(
      Math.max(32, f0Start * (mappedKind === 'death' ? 0.4 : 0.74)),
      t + dur,
    );

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(isAggressive ? 33 : mappedKind === 'moan' ? 18 : 25, t);
    const fmGain = ctx.createGain();
    fmGain.gain.value = isAggressive ? 15 : 8;
    lfo.connect(fmGain);
    fmGain.connect(osc1.frequency);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(isAggressive ? 680 : 380, t);
    f1.frequency.exponentialRampToValueAtTime(isAggressive ? 1050 : 250, t + dur);
    f1.Q.value = isAggressive ? 2.5 : 3.4;

    const vocalEnv = ctx.createGain();
    const peakVocal = Math.min(1.1, (isAggressive ? 0.44 : 0.28) * horrorGain);
    vocalEnv.gain.setValueAtTime(0.001, t);
    vocalEnv.gain.linearRampToValueAtTime(peakVocal, t + (isAggressive ? 0.032 : 0.09));
    vocalEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc1.connect(f1);
    f1.connect(vocalEnv);
    vocalEnv.connect(airLp);

    // Wet breath / sibilant snarl hiss layer
    const breath = ctx.createBufferSource();
    breath.buffer = this.noiseBuffer;
    const breathBp = ctx.createBiquadFilter();
    breathBp.type = 'bandpass';
    breathBp.frequency.setValueAtTime(isAggressive ? 2450 : 1380, t);
    breathBp.frequency.exponentialRampToValueAtTime(isAggressive ? 1700 : 780, t + dur);
    breathBp.Q.value = isAggressive ? 1.6 : 2.1;

    const breathEnv = ctx.createGain();
    const peakBreath = Math.min(
      0.92,
      ((isAggressive ? 0.32 : 0.16) + closeBoost * 0.34 + veryClose * 0.22) * horrorGain,
    );
    breathEnv.gain.setValueAtTime(0.001, t);
    breathEnv.gain.linearRampToValueAtTime(peakBreath, t + 0.05);
    breathEnv.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.04);

    breath.connect(breathBp);
    breathBp.connect(breathEnv);
    breathEnv.connect(airLp);

    const stopAt = t + dur + 0.06;
    osc1.start(t);
    osc1.stop(stopAt);
    lfo.start(t);
    lfo.stop(stopAt);
    breath.start(t, Math.random() * 0.75, dur + 0.08);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.activeZombieVocals = Math.max(0, this.activeZombieVocals - 1);
      try {
        airLp.disconnect();
        panner.disconnect();
        drySend.disconnect();
        wetSend.disconnect();
      } catch {
        // already disconnected
      }
    };
    breath.onended = cleanup;
    osc1.onended = cleanup;
  }

  public playZombieFootstep(
    pos: Readonly<THREE.Vector3>,
    opts?: { distanceM?: number; speedMps?: number; surface?: BodycamSurfaceMaterial; isDrag?: boolean },
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const dist = opts?.distanceM ?? pos.distanceTo(this.listenerPos);
    if (dist > 24 || this.activeZombieSteps >= 6) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const speedMps = opts?.speedMps ?? 2.2;
    const surface = opts?.surface ?? 'concrete';
    const isDrag = opts?.isDrag ?? speedMps < 2.15;

    const closeFactor = THREE.MathUtils.clamp(1 - dist / 15, 0, 1);
    const veryClose = THREE.MathUtils.clamp(1 - dist / 6.0, 0, 1);
    const speedWeight = THREE.MathUtils.clamp(speedMps / 3.3, 0.56, 1.38);
    const amp = (0.36 + closeFactor * 0.64 + veryClose * 0.36) * speedWeight;

    const panner = this.createHRTFPanner(pos, 2.0, 26);
    if (!panner) return;
    panner.rolloffFactor = 1.08;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    this.activeZombieSteps += 1;

    const thump = ctx.createOscillator();
    thump.type = surface === 'metal' ? 'triangle' : 'sine';
    thump.frequency.setValueAtTime((surface === 'metal' ? 126 : 92) * (0.92 + Math.random() * 0.16), t);
    thump.frequency.exponentialRampToValueAtTime(34, t + 0.082);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(Math.min(0.8, 0.42 * amp), t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
    thump.connect(tg);
    tg.connect(panner);
    thump.start(t);
    thump.stop(t + 0.11);

    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = surface === 'wood' ? 560 : surface === 'metal' ? 1820 : 980;
    bp.Q.value = 1.35;
    const sg = ctx.createGain();
    const slapDur = isDrag ? 0.15 : 0.08;
    sg.gain.setValueAtTime(0.001, t);
    sg.gain.linearRampToValueAtTime(Math.min(0.65, 0.32 * amp), t + (isDrag ? 0.032 : 0.008));
    sg.gain.exponentialRampToValueAtTime(0.001, t + slapDur);
    slap.connect(bp);
    bp.connect(sg);
    sg.connect(panner);
    slap.start(t, Math.random() * 0.9, slapDur + 0.03);

    slap.onended = () => {
      this.activeZombieSteps = Math.max(0, this.activeZombieSteps - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  public playFlashlightClick(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2200, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.015);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.025);
  }

  public playPickup(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, 0.2, 0.09);
  }

  public playMagPackClick(fillRatio = 0.5): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const tension = 1 + THREE.MathUtils.clamp(fillRatio, 0, 1) * 0.28;

    // Two-stage brass-on-steel feed-lip snap ("click-clack")
    const snap = this.ctx.createOscillator();
    snap.type = 'triangle';
    snap.frequency.setValueAtTime(2150 * tension, t);
    snap.frequency.exponentialRampToValueAtTime(780 * tension, t + 0.022);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.24, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.028);
    snap.connect(sg);
    sg.connect(this.dryBus);
    snap.start(t);
    snap.stop(t + 0.032);

    const seat = this.ctx.createOscillator();
    seat.type = 'square';
    seat.frequency.setValueAtTime(1320 * tension, t + 0.024);
    seat.frequency.exponentialRampToValueAtTime(520 * tension, t + 0.052);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1950;
    bp.Q.value = 2.0;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime(0.16, t + 0.024);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.056);
    seat.connect(bp);
    bp.connect(cg);
    cg.connect(this.dryBus);
    seat.start(t + 0.024);
    seat.stop(t + 0.06);
  }

  public playMagUnloadClick(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const pop = this.ctx.createOscillator();
    pop.type = 'sine';
    pop.frequency.setValueAtTime(1680, t);
    pop.frequency.exponentialRampToValueAtTime(920, t + 0.032);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.038);
    pop.connect(g);
    g.connect(this.dryBus);
    pop.start(t);
    pop.stop(t + 0.042);
  }

  public playInhale(intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const amp = Math.max(0.4, Math.min(1.3, intensity));
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(360, t);
    bp.frequency.exponentialRampToValueAtTime(790, t + 0.24);
    bp.Q.value = 1.9;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.062 * amp, t + 0.14);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.29);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.5, 0.32);
  }

  public playExhaleGasp(depleted: boolean): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(depleted ? 840 : 610, t);
    bp.frequency.exponentialRampToValueAtTime(depleted ? 310 : 340, t + (depleted ? 0.46 : 0.34));
    bp.Q.value = depleted ? 1.45 : 1.65;

    const g = this.ctx.createGain();
    const peak = depleted ? 0.145 : 0.082;
    const dur = depleted ? 0.50 : 0.35;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.5, dur + 0.04);

    if (depleted) {
      // Follow-up recovery gasp inhale (~0.56s later) so depletion feels distinctly physiological
      const rT = t + 0.54;
      const rec = this.ctx.createBufferSource();
      rec.buffer = this.noiseBuffer;
      const rbp = this.ctx.createBiquadFilter();
      rbp.type = 'bandpass';
      rbp.frequency.setValueAtTime(420, rT);
      rbp.frequency.exponentialRampToValueAtTime(860, rT + 0.28);
      rbp.Q.value = 1.6;
      const rg = this.ctx.createGain();
      rg.gain.setValueAtTime(0.001, rT);
      rg.gain.linearRampToValueAtTime(0.088, rT + 0.14);
      rg.gain.exponentialRampToValueAtTime(0.001, rT + 0.38);
      rec.connect(rbp);
      rbp.connect(rg);
      rg.connect(this.dryBus);
      rec.start(rT, Math.random() * 0.5, 0.42);
    }
  }

  public playBreathCue(
    kind: 'inhale' | 'exhale' | 'exhale_depleted' | 'low_o2_pulse',
    intensity = 1.0,
  ): void {
    if (kind === 'inhale') {
      this.playInhale(intensity);
      return;
    }
    if (kind === 'exhale') {
      this.playExhaleGasp(false);
      return;
    }
    if (kind === 'exhale_depleted') {
      this.playExhaleGasp(true);
      return;
    }
    // Subtle low-oxygen cardiac lub-dub pulse while approaching breath depletion
    this.ensureInitialized();
    const vol = 0.085 + Math.max(0, Math.min(1, intensity)) * 0.09;
    this.triggerHeartbeat(vol);
  }

  public playStomachGrowl(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(84, t);
    osc.frequency.linearRampToValueAtTime(62, t + 0.24);
    osc.frequency.linearRampToValueAtTime(76, t + 0.44);
    osc.frequency.linearRampToValueAtTime(52, t + 0.68);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 210;
    lp.Q.value = 2.8;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.075, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.72);

    osc.connect(lp);
    lp.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.76);
  }

  public playFatigueSigh(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(490, t);
    bp.frequency.exponentialRampToValueAtTime(290, t + 0.6);
    bp.Q.value = 2.1;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.068, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.64);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.4, 0.68);
  }

  public playConsume(kind: 'food' | 'drink'): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    if (kind === 'drink') {
      for (let i = 0; i < 3; i++) {
        const offset = i * 0.14;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(340 + i * 35, t + offset);
        osc.frequency.exponentialRampToValueAtTime(160, t + offset + 0.09);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.001, t + offset);
        g.gain.linearRampToValueAtTime(0.11, t + offset + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.1);
        osc.connect(g);
        g.connect(this.dryBus);
        osc.start(t + offset);
        osc.stop(t + offset + 0.11);
      }
      return;
    }

    for (let i = 0; i < 2; i++) {
      const offset = i * 0.15;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1450 + i * 220;
      bp.Q.value = 1.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.14, t + offset);
      g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.09);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.dryBus);
      src.start(t + offset, Math.random() * 0.3, 0.11);
    }
  }

  public playPinPull(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;

    // Sharp metallic ring-twist + pin extraction snap
    const ring = this.ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(2850, t);
    ring.frequency.exponentialRampToValueAtTime(1450, t + 0.06);
    const rg = this.ctx.createGain();
    rg.gain.setValueAtTime(0.24, t);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    ring.connect(rg);
    rg.connect(this.dryBus);
    ring.start(t);
    ring.stop(t + 0.08);
  }

  public playGrenadePinPull(): void {
    this.playPinPull();
  }

  public playGrenadeLeverSnap(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;

    // Crisp striker snap + metallic spoon ping + soft fuse hiss kick
    const snap = this.ctx.createOscillator();
    snap.type = 'square';
    snap.frequency.setValueAtTime(2350, t);
    snap.frequency.exponentialRampToValueAtTime(760, t + 0.036);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.22, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.042);
    snap.connect(sg);
    sg.connect(this.dryBus);
    snap.start(t);
    snap.stop(t + 0.05);

    const ping = this.ctx.createOscillator();
    ping.type = 'triangle';
    ping.frequency.setValueAtTime(3600, t + 0.02);
    ping.frequency.exponentialRampToValueAtTime(1950, t + 0.085);
    const pg = this.ctx.createGain();
    pg.gain.setValueAtTime(0.14, t + 0.02);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
    ping.connect(pg);
    pg.connect(this.dryBus);
    ping.start(t + 0.02);
    ping.stop(t + 0.10);

    const fizz = this.ctx.createBufferSource();
    fizz.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3200;
    hp.Q.value = 1.4;
    const fg = this.ctx.createGain();
    fg.gain.setValueAtTime(0.065, t + 0.025);
    fg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    fizz.connect(hp);
    hp.connect(fg);
    fg.connect(this.dryBus);
    fizz.start(t + 0.025, 0, 0.24);
  }

  public playWhoosh(heavy = false): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(heavy ? 380 : 620, t);
    bp.frequency.exponentialRampToValueAtTime(heavy ? 180 : 280, t + 0.16);
    bp.Q.value = 1.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(heavy ? 0.28 : 0.20, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.4, 0.2);
  }

  public playExplosion(pos: THREE.Vector3): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const panner = this.createHRTFPanner(pos, 3.0, 220);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // 1. Massive chest-mic-clipping sub-bass pressure wave
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sawtooth';
    subOsc.frequency.setValueAtTime(105, t);
    subOsc.frequency.exponentialRampToValueAtTime(22, t + 0.48);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(4.8, t);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.56);
    subOsc.connect(subGain);
    subGain.connect(panner);
    subOsc.start(t);
    subOsc.stop(t + 0.58);

    // 2. Broadband concussive blast crack + low-pass roar (drives WaveShaper hard)
    const blast = ctx.createBufferSource();
    blast.buffer = this.noiseBuffer;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3400, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.95);
    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(5.2, t);
    blastGain.gain.exponentialRampToValueAtTime(0.001, t + 1.05);
    blast.connect(lp);
    lp.connect(blastGain);
    blastGain.connect(panner);
    blast.start(t, 0, 1.1);

    // 3. Delayed shrapnel & falling debris crackle
    const debris = ctx.createBufferSource();
    debris.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1900;
    hp.Q.value = 0.9;
    const dg = ctx.createGain();
    dg.gain.setValueAtTime(0.001, t + 0.08);
    dg.gain.linearRampToValueAtTime(0.95, t + 0.14);
    dg.gain.exponentialRampToValueAtTime(0.001, t + 0.85);
    debris.connect(hp);
    hp.connect(dg);
    dg.connect(panner);
    debris.start(t + 0.08, 0.3, 0.85);

    this.duckAmbientWind(1.8, 0.006);
  }

  public triggerConcussion(severity: number): void {
    this.ensureInitialized();
    if (!this.ctx || !this.masterGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = THREE.MathUtils.clamp(severity, 0.2, 1.0);

    // Stop prior tinnitus tone cleanly so consecutive hits don't stack loudly
    this.stopTinnitusNode();

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(4150 + Math.random() * 240, t);

    const g = ctx.createGain();
    const dur = 1.6 + s * 2.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.048 * s, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    // Route straight to masterGain (bypassing masterLowpass) so ringing cuts through muffled world
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + dur + 0.04);

    this.activeTinnitusOsc = osc;
    this.activeTinnitusGain = g;
  }

  public setTraumaAcoustics(muffleLevel: number): void {
    if (!this.ctx || !this.masterLowpass) return;
    const m = THREE.MathUtils.clamp(muffleLevel, 0, 1);
    const targetCutoff = THREE.MathUtils.lerp(22000, 650, Math.pow(m, 0.72));
    this.masterLowpass.frequency.setTargetAtTime(targetCutoff, this.ctx.currentTime, 0.06);
  }

  private stopTinnitusNode(): void {
    try {
      this.activeTinnitusOsc?.stop();
    } catch {
      // already stopped
    }
    this.activeTinnitusOsc?.disconnect();
    this.activeTinnitusGain?.disconnect();
    this.activeTinnitusOsc = null;
    this.activeTinnitusGain = null;
  }

  public resetTraumaAudio(): void {
    this.stopTinnitusNode();
    if (this.ctx && this.masterLowpass) {
      this.masterLowpass.frequency.setValueAtTime(22000, this.ctx.currentTime);
    }
  }

  public tickBiometrics(
    health: number,
    stamina: number,
    bleeding: boolean,
    nowMs: number,
    heartbeatSeverity?: number,
    raggedBreathSeverity?: number,
  ): void {
    if (!this.ctx || !this.dryBus) return;

    const hbSev =
      heartbeatSeverity !== undefined
        ? heartbeatSeverity
        : health < 62 || bleeding
          ? Math.max(bleeding ? 0.55 : 0, (65 - health) / 65)
          : 0;

    if (hbSev > 0.12) {
      const clampedSev = Math.min(1, hbSev);
      const intervalMs = 920 - clampedSev * 420;
      if (nowMs - this.lastHeartbeatMs > intervalMs) {
        this.lastHeartbeatMs = nowMs;
        this.triggerHeartbeat(0.08 + clampedSev * 0.24);
      }
    }

    const breathSev = Math.max(
      stamina < 0.35 ? (0.35 - stamina) / 0.35 : 0,
      raggedBreathSeverity !== undefined
        ? raggedBreathSeverity
        : health < 48
          ? (48 - health) / 48
          : 0,
    );

    if (breathSev > 0.14) {
      const clampedBreath = Math.min(1, breathSev);
      const breathInterval = 1480 - clampedBreath * 580;
      if (nowMs - this.lastBreathMs > breathInterval) {
        this.lastBreathMs = nowMs;
        this.triggerBreath(0.035 + clampedBreath * 0.095);
      }
    }
  }

  private triggerHeartbeat(volume: number): void {
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    for (const offset of [0, 0.16]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(offset === 0 ? 58 : 48, t + offset);
      osc.frequency.exponentialRampToValueAtTime(28, t + offset + 0.11);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(volume * (offset === 0 ? 1 : 0.72), t + offset);
      g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.12);
      osc.connect(g);
      g.connect(this.dryBus);
      osc.start(t + offset);
      osc.stop(t + offset + 0.13);
    }
  }

  private triggerBreath(volume: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.14);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.4, 0.45);
  }

  public dispose(): void {
    window.clearTimeout(this.windDuckTimeout);
    this.stopTinnitusNode();
    try {
      this.windSource?.stop();
    } catch {
      // ignore if already stopped
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.activeZombieVocals = 0;
    this.activeZombieSteps = 0;
    this.initialized = false;
  }
}

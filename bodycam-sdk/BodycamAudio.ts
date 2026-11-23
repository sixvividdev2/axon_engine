import * as THREE from 'three';
import {
  BodycamBreathCueKind,
  BodycamGearRattleKind,
  BodycamWeaponAudioCue,
  BodycamWeaponCueOptions,
  IBodycamAudioSource,
} from './IBodycamAudioSource';
import { BodycamMeleeAttackType, BodycamSurfaceMaterial } from './types';

export type ZombieVocalKind = 'moan' | 'groan' | 'snarl' | 'lunge' | 'hurt' | 'death';

export interface ZombieVocalAudioOptions {
  distanceM?: number;
  pitchScale?: number;
  intensity?: number;
}

export interface ZombieFootstepAudioOptions {
  distanceM?: number;
  speedMps?: number;
  surface?: BodycamSurfaceMaterial;
  isDrag?: boolean;
}

/**
 * Self-contained Bodycam Chest-Mic Web Audio Engine:
 *  - Surface-aware procedural footsteps (concrete, wood, metal, gravel, puddle, grass, asphalt)
 *  - Tactical Gear / Plate-Carrier Vest Rattle layer scaled by movement, crouch/stand, & landing shock
 *  - Vault & Mantle surface-matched hand-slap, boot scuff, and tempered glass shatter foley
 *  - HRTF 3D spatialization, dynamic interior/exterior convolution reverb
 *  - Horror-mix proximity-scaled spatial zombie vocalizations & footsteps with strict voice budgeting
 *  - Soft-clipping WaveShaperNode + DynamicsCompressorNode chest-mic saturation chain
 */
export class BodycamAudio implements IBodycamAudioSource {
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
  private windBandpass: BiquadFilterNode | null = null;
  private windLowpass: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainSource: AudioBufferSourceNode | null = null;
  private rainHighpass: BiquadFilterNode | null = null;
  private rainLowpass: BiquadFilterNode | null = null;
  private currentWindTargetGain = 0.032;
  private currentRainTargetGain = 0.0;
  private currentIndoor = false;
  private currentInteriorMaterial: 'concrete' | 'wood' | 'metal' | 'outdoor' = 'outdoor';
  private windDuckUntilSec = 0;
  private lastWindAudioPushSec = -1;
  private nvgHumOsc: OscillatorNode | null = null;
  private nvgHumGain: GainNode | null = null;

  private noiseBuffer: AudioBuffer | null = null;
  private clipDrive = 4.5;
  private masterVolume = 0.85;
  private gearRattleGain = 0.75;
  private initialized = false;
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

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    // Master output
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);
    this.masterGain = master;

    // Trauma concussion lowpass
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 22000;
    lp.Q.value = 0.7;
    lp.connect(master);
    this.masterLowpass = lp;

    // Chest-mic DynamicsCompressorNode -> limits loud shots and ducks wind
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 6;
    comp.ratio.value = 14;
    comp.attack.value = 0.0015;
    comp.release.value = 0.24;
    comp.connect(lp);
    this.micCompressor = comp;

    // Chest-mic WaveShaperNode -> authentic soft-clipping capsule saturation
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.makeClipCurve(this.clipDrive);
    shaper.oversample = '2x';
    shaper.connect(comp);
    this.micShaper = shaper;

    // Dry bus -> shaper -> compressor
    const dry = ctx.createGain();
    dry.gain.value = 1.0;
    dry.connect(shaper);
    this.dryBus = dry;

    // Exterior open-air convolution reverb
    const convolver = ctx.createConvolver();
    convolver.buffer = this.createImpulseResponse(ctx, 1.85, 2.75, false);
    this.convolver = convolver;

    const wet = ctx.createGain();
    wet.gain.value = 0.34;
    wet.connect(convolver);
    convolver.connect(shaper);
    this.wetBus = wet;

    // Tight interior slapback convolution reverb (concrete bunker / CQB corridor)
    const intConvolver = ctx.createConvolver();
    intConvolver.buffer = this.createImpulseResponse(ctx, 0.56, 3.3, true);
    this.interiorConvolver = intConvolver;

    const intWet = ctx.createGain();
    intWet.gain.value = 0.0;
    intWet.connect(intConvolver);
    intConvolver.connect(shaper);
    this.interiorWetBus = intWet;

    this.noiseBuffer = this.createNoiseBuffer(ctx, 2.5);
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
        lp = lp * (tightInterior ? 0.36 : 0.65) + white * (tightInterior ? 0.64 : 0.35);
        let slap = lp;
        if (tightInterior) {
          if (
            i === Math.floor(ctx.sampleRate * 0.011) ||
            i === Math.floor(ctx.sampleRate * 0.025) ||
            i === Math.floor(ctx.sampleRate * 0.047)
          ) {
            slap += (Math.random() * 2 - 1) * 0.82;
          }
        } else if (i === Math.floor(ctx.sampleRate * 0.045) || i === Math.floor(ctx.sampleRate * 0.115)) {
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
    bp.frequency.value = 260;
    bp.Q.value = 1.5;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 540;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.14;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 115;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);
    lfo.start();

    const windGain = ctx.createGain();
    windGain.gain.value = this.currentWindTargetGain;

    src.connect(bp);
    bp.connect(lp);
    lp.connect(windGain);
    windGain.connect(this.dryBus);
    src.start();

    this.windGain = windGain;
    this.windSource = src;
    this.windBandpass = bp;
    this.windLowpass = lp;

    // Rain sheet patter ambient loop (muted until rainIntensity > 0)
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = this.noiseBuffer;
    rSrc.loop = true;

    const rHp = ctx.createBiquadFilter();
    rHp.type = 'highpass';
    rHp.frequency.value = 950;

    const rLp = ctx.createBiquadFilter();
    rLp.type = 'lowpass';
    rLp.frequency.value = 4600;

    const rGain = ctx.createGain();
    rGain.gain.value = 0;

    rSrc.connect(rHp);
    rHp.connect(rLp);
    rLp.connect(rGain);
    rGain.connect(this.dryBus);
    rSrc.start(0, 0.7);

    this.rainSource = rSrc;
    this.rainHighpass = rHp;
    this.rainLowpass = rLp;
    this.rainGain = rGain;
  }

  public setSettings(clipDrive: number, masterVolume: number, gearRattleGain = 0.75): void {
    this.clipDrive = clipDrive;
    this.masterVolume = masterVolume;
    this.gearRattleGain = gearRattleGain;
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

  private createHRTFPanner(
    pos: Readonly<THREE.Vector3>,
    refDist = 2.0,
    maxDist = 110,
  ): PannerNode | null {
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
    const targetWind = isIndoor ? this.currentWindTargetGain * 0.18 : this.currentWindTargetGain;
    const targetRain = isIndoor ? this.currentRainTargetGain * 0.24 : this.currentRainTargetGain;
    const targetOutWet = isIndoor ? 0.05 : 0.34;
    const targetIntWet = isIndoor
      ? material === 'concrete'
        ? 0.56
        : material === 'metal'
          ? 0.62
          : 0.34
      : 0.0;

    if (t >= this.windDuckUntilSec) {
      this.windGain?.gain.setTargetAtTime(targetWind, t, 0.14);
    }
    this.rainGain?.gain.setTargetAtTime(targetRain, t, 0.14);
    if (this.rainLowpass) {
      this.rainLowpass.frequency.setTargetAtTime(
        isIndoor ? (material === 'metal' ? 2100 : 1250) : 4600,
        t,
        0.14,
      );
    }
    this.wetBus?.gain.setTargetAtTime(targetOutWet, t, 0.12);
    this.interiorWetBus?.gain.setTargetAtTime(targetIntWet, t, 0.12);
  }

  public setWindWeather(windSpeedMps: number, gust01: number, rainIntensity: number): void {
    // Wind scales smoothly from near-silent calm (0.008) to rushing gale (0.145)
    const speedNorm = THREE.MathUtils.clamp((windSpeedMps - 1.0) / 21.0, 0, 1);
    const windGain = 0.008 + speedNorm * 0.088 + THREE.MathUtils.clamp(gust01, 0, 1) * 0.048 * (0.35 + speedNorm * 0.65);
    const rainGain = THREE.MathUtils.clamp(rainIntensity, 0, 1) * 0.082;
    this.currentWindTargetGain = windGain;
    this.currentRainTargetGain = rainGain;
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    // Throttle continuous weather audio automation to ~12 Hz to prevent Web Audio automation queue jitter
    if (this.lastWindAudioPushSec >= 0 && t - this.lastWindAudioPushSec < 0.08) return;
    this.lastWindAudioPushSec = t;

    const effectiveWind = this.currentIndoor ? windGain * 0.18 : windGain;
    const effectiveRain = this.currentIndoor ? rainGain * 0.24 : rainGain;
    // Do not interrupt an active gunshot wind-duck envelope
    if (t >= this.windDuckUntilSec) {
      this.windGain?.gain.setTargetAtTime(effectiveWind, t, 0.18);
    }
    if (this.windBandpass) {
      this.windBandpass.frequency.setTargetAtTime(210 + speedNorm * 240 + gust01 * 120, t, 0.22);
    }
    if (this.windLowpass) {
      this.windLowpass.frequency.setTargetAtTime(420 + speedNorm * 580 + gust01 * 210, t, 0.22);
    }
    this.rainGain?.gain.setTargetAtTime(effectiveRain, t, 0.22);
  }

  public playThunder(intensity = 0.85): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.3, 1.2) * (this.currentIndoor ? 0.58 : 1.0);

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(520, t);
    lp.frequency.exponentialRampToValueAtTime(68, t + 2.4);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.48 * amp, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.14 * amp, t + 0.75);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.5);

    src.connect(lp);
    lp.connect(g);
    this.connectToOutputBuses(g, true);
    src.start(t, Math.random() * 0.4, 2.55);
  }

  public playPdaPowerSound(turningOn: boolean): void {
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Tactile dome switch press click
    const click = ctx.createOscillator();
    click.type = 'triangle';
    click.frequency.setValueAtTime(turningOn ? 1850 : 1420, t);
    click.frequency.exponentialRampToValueAtTime(460, t + 0.018);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.14, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.022);
    click.connect(cg);
    cg.connect(this.dryBus);
    click.start(t);
    click.stop(t + 0.025);

    // Subtle OLED boot/shutdown chirp
    const chime = ctx.createOscillator();
    chime.type = 'sine';
    const startFreq = turningOn ? 640 : 880;
    const endFreq = turningOn ? 980 : 420;
    chime.frequency.setValueAtTime(startFreq, t + 0.04);
    chime.frequency.exponentialRampToValueAtTime(endFreq, t + 0.14);
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.001, t + 0.04);
    gg.gain.linearRampToValueAtTime(0.045, t + 0.055);
    gg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    chime.connect(gg);
    gg.connect(this.dryBus);
    chime.start(t + 0.04);
    chime.stop(t + 0.17);
  }

  public playPdaButtonClick(): void {
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2200, t);
    osc.frequency.exponentialRampToValueAtTime(780, t + 0.014);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.045, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.016);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.02);
  }

  public playRadioChirp(kind: 'open' | 'ack' = 'open'): void {
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // VHF squelch burst
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1750;
    bp.Q.value = 3.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.001, t);
    ng.gain.linearRampToValueAtTime(0.075, t + 0.008);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
    nSrc.connect(bp);
    bp.connect(ng);
    ng.connect(this.dryBus);
    nSrc.start(t, Math.random() * 0.8, 0.075);

    // Dual telemetry beep
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'ack' ? 1480 : 1240, t);
    if (kind === 'ack') {
      osc.frequency.setValueAtTime(1760, t + 0.045);
    }
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.045, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og);
    og.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.095);
  }

  public playNvgFlipSound(flipDown: boolean): void {
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Wilcox shroud mechanical detent clack
    const clack = ctx.createOscillator();
    clack.type = 'triangle';
    clack.frequency.setValueAtTime(flipDown ? 940 : 1180, t + 0.04);
    clack.frequency.exponentialRampToValueAtTime(180, t + 0.09);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.16, t + 0.04);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    clack.connect(cg);
    cg.connect(this.dryBus);
    clack.start(t + 0.04);
    clack.stop(t + 0.11);

    // High-voltage image intensifier tube startup whine when flipped down
    if (flipDown) {
      const whine = ctx.createOscillator();
      whine.type = 'sine';
      whine.frequency.setValueAtTime(4200, t + 0.12);
      whine.frequency.exponentialRampToValueAtTime(7400, t + 0.42);
      const wg = ctx.createGain();
      wg.gain.setValueAtTime(0.0005, t + 0.12);
      wg.gain.linearRampToValueAtTime(0.018, t + 0.22);
      wg.gain.exponentialRampToValueAtTime(0.0008, t + 0.58);
      whine.connect(wg);
      wg.connect(this.dryBus);
      whine.start(t + 0.12);
      whine.stop(t + 0.6);
    }
  }

  public playIrIlluminatorClick(turningOn: boolean): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(turningOn ? 2350 : 1780, t);
    osc.frequency.exponentialRampToValueAtTime(turningOn ? 880 : 620, t + 0.016);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.085, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.024);
  }

  public setNvgTubeHum(active: boolean): void {
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (active) {
      if (!this.nvgHumOsc || !this.nvgHumGain) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 5850;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        osc.connect(g);
        g.connect(this.dryBus);
        osc.start(t);
        this.nvgHumOsc = osc;
        this.nvgHumGain = g;
      }
      this.nvgHumGain.gain.setTargetAtTime(0.0032, t, 0.14);
    } else if (this.nvgHumGain) {
      this.nvgHumGain.gain.setTargetAtTime(0.00001, t, 0.08);
    }
  }

  private duckAmbientWind(durationSec = 0.85, targetGain = 0.0105): void {
    if (!this.ctx || !this.windGain) return;
    const t = this.ctx.currentTime;
    const restoreGain = Math.max(
      0.0012,
      this.currentIndoor ? this.currentWindTargetGain * 0.18 : this.currentWindTargetGain,
    );
    const duckTarget = Math.max(0.001, Math.min(targetGain, restoreGain * 0.65));
    // Skip ducking when wind is already quieter than or equal to target (e.g. calm/indoor)
    if (restoreGain <= 0.0025 || duckTarget >= restoreGain * 0.92) return;

    const param = this.windGain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => AudioParam };
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(Math.max(0.001, param.value), t);
    }
    param.linearRampToValueAtTime(duckTarget, t + 0.015);
    param.exponentialRampToValueAtTime(restoreGain, t + durationSec);
    this.windDuckUntilSec = t + durationSec + 0.04;
  }

  private connectToOutputBuses(node: AudioNode, sendOutdoorWet = false): void {
    if (!this.dryBus) return;
    node.connect(this.dryBus);
    if (sendOutdoorWet && this.wetBus) {
      node.connect(this.wetBus);
    }
    if (this.currentIndoor && this.interiorWetBus) {
      node.connect(this.interiorWetBus);
    }
  }

  /**
   * Procedural surface-specific boot heel-strike synthesizer.
   * Distinct physical timbre for concrete, wood, metal, gravel, puddle, grass, and asphalt.
   */
  public playFootstep(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.15, 2.0);
    const pitchJitter = 0.92 + Math.random() * 0.16;

    // 1. Subtle low-end boot heel thud (present on every hard surface)
    const heelOsc = ctx.createOscillator();
    heelOsc.type = 'sine';
    const heelStart =
      surface === 'wood' ? 145 : surface === 'metal' ? 195 : surface === 'puddle' ? 95 : 115;
    heelOsc.frequency.setValueAtTime(heelStart * pitchJitter, t);
    heelOsc.frequency.exponentialRampToValueAtTime(38, t + 0.065);
    const heelGain = ctx.createGain();
    const heelVol =
      surface === 'gravel' || surface === 'grass' ? 0.055 * amp : surface === 'puddle' ? 0.08 * amp : 0.14 * amp;
    heelGain.gain.setValueAtTime(heelVol, t);
    heelGain.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
    heelOsc.connect(heelGain);
    this.connectToOutputBuses(heelGain);
    heelOsc.start(t);
    heelOsc.stop(t + 0.085);

    if (surface === 'concrete' || surface === 'asphalt') {
      // Crisp hard rubber sole slap + fine surface grit scuff
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = (surface === 'asphalt' ? 760 : 620) * pitchJitter;
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.16 * amp, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.075);
      src.connect(bp);
      bp.connect(g);
      this.connectToOutputBuses(g);
      src.start(t, Math.random() * 1.2, 0.085);

      // High grit scuff
      const grit = ctx.createBufferSource();
      grit.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2400;
      const gg = ctx.createGain();
      gg.gain.setValueAtTime(0.045 * amp, t + 0.01);
      gg.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
      grit.connect(hp);
      hp.connect(gg);
      this.connectToOutputBuses(gg);
      grit.start(t + 0.01, Math.random() * 1.2, 0.06);
      return;
    }

    if (surface === 'wood') {
      // Hollow resonant wooden plank knock + brief board creak
      const plank = ctx.createOscillator();
      plank.type = 'triangle';
      plank.frequency.setValueAtTime(245 * pitchJitter, t);
      plank.frequency.exponentialRampToValueAtTime(118 * pitchJitter, t + 0.09);
      const pbp = ctx.createBiquadFilter();
      pbp.type = 'bandpass';
      pbp.frequency.value = 340 * pitchJitter;
      pbp.Q.value = 3.2;
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.24 * amp, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
      plank.connect(pbp);
      pbp.connect(pg);
      this.connectToOutputBuses(pg);
      plank.start(t);
      plank.stop(t + 0.12);

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 410 * pitchJitter;
      bp.Q.value = 2.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.15 * amp, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
      src.connect(bp);
      bp.connect(g);
      this.connectToOutputBuses(g);
      src.start(t, Math.random() * 1.2, 0.11);
      return;
    }

    if (surface === 'metal') {
      // Industrial steel grate dual-mode metallic clang + sharp sole strike
      const modes = [980, 2140, 3420];
      for (let i = 0; i < modes.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(modes[i] * pitchJitter, t);
        osc.frequency.exponentialRampToValueAtTime(modes[i] * 0.94 * pitchJitter, t + 0.14);
        const mg = ctx.createGain();
        mg.gain.setValueAtTime((i === 0 ? 0.13 : i === 1 ? 0.085 : 0.045) * amp, t);
        mg.gain.exponentialRampToValueAtTime(0.001, t + (0.14 - i * 0.025));
        osc.connect(mg);
        this.connectToOutputBuses(mg, true);
        osc.start(t);
        osc.stop(t + 0.16);
      }

      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1850 * pitchJitter;
      bp.Q.value = 3.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.14 * amp, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
      src.connect(bp);
      bp.connect(g);
      this.connectToOutputBuses(g);
      src.start(t, Math.random() * 1.2, 0.095);
      return;
    }

    if (surface === 'gravel') {
      // Multi-grain shifting crushed stone crunch (4 staggered granular micro-bursts)
      for (let i = 0; i < 4; i++) {
        const delay = i * (0.018 + Math.random() * 0.014);
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = (1550 + i * 620 + Math.random() * 480) * pitchJitter;
        bp.Q.value = 1.9;
        const g = ctx.createGain();
        const peak = (i === 0 ? 0.19 : 0.12 - i * 0.018) * amp;
        g.gain.setValueAtTime(0.001, t + delay);
        g.gain.linearRampToValueAtTime(peak, t + delay + 0.008);
        g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.055);
        src.connect(bp);
        bp.connect(g);
        this.connectToOutputBuses(g);
        src.start(t + delay, Math.random() * 1.4, 0.065);
      }
      return;
    }

    if (surface === 'puddle') {
      // Wet boot splash sweep + sparkling droplet spray
      const splash = ctx.createBufferSource();
      splash.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(720 * pitchJitter, t);
      bp.frequency.exponentialRampToValueAtTime(2950 * pitchJitter, t + 0.07);
      bp.frequency.exponentialRampToValueAtTime(1100, t + 0.20);
      bp.Q.value = 1.3;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, t);
      sg.gain.linearRampToValueAtTime(0.24 * amp, t + 0.018);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.21);
      splash.connect(bp);
      bp.connect(sg);
      this.connectToOutputBuses(sg, true);
      splash.start(t, Math.random() * 1.0, 0.23);

      // Droplet spatter
      const spray = ctx.createBufferSource();
      spray.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3400;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.09 * amp, t + 0.03);
      dg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      spray.connect(hp);
      hp.connect(dg);
      this.connectToOutputBuses(dg);
      spray.start(t + 0.03, Math.random() * 1.0, 0.17);
      return;
    }

    // Grass / soil fallback
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 820 * pitchJitter;
    bp.Q.value = 0.85;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.13 * amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
    src.connect(bp);
    bp.connect(g);
    this.connectToOutputBuses(g);
    src.start(t, Math.random() * 1.2, 0.11);
  }

  /**
   * Tactical Gear / Plate-Carrier Vest Rattle synthesizer.
   * Layers nylon Cordura rub, sling creak, and subtle polymer mag/buckle micro-clacks.
   * Scaled by movement intensity, crouch/stand posture transitions, and landing impact shock.
   */
  public playGearRattle(
    kind: BodycamGearRattleKind,
    intensity = 1.0,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || this.gearRattleGain <= 0.01) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const scale = THREE.MathUtils.clamp(intensity, 0.15, 2.2) * this.gearRattleGain;

    // 1. Plate-carrier Cordura / canvas fabric rub
    const rub = ctx.createBufferSource();
    rub.buffer = this.noiseBuffer;
    const rubBp = ctx.createBiquadFilter();
    rubBp.type = 'bandpass';
    rubBp.frequency.setValueAtTime(
      kind === 'crouch'
        ? 540
        : kind === 'landing'
          ? 460
          : kind === 'vault' || kind === 'melee'
            ? 620
            : 680 + Math.random() * 160,
      t,
    );
    rubBp.Q.value = 1.65;
    const rubDur =
      kind === 'crouch'
        ? 0.19
        : kind === 'landing'
          ? 0.24
          : kind === 'vault'
            ? 0.22
            : kind === 'melee'
              ? 0.16
              : 0.11;
    const rubGain = ctx.createGain();
    const rubPeak =
      (kind === 'landing'
        ? 0.13
        : kind === 'vault'
          ? 0.11
          : kind === 'melee'
            ? 0.095
            : kind === 'crouch'
              ? 0.085
              : 0.052) * scale;
    rubGain.gain.setValueAtTime(0.001, t);
    rubGain.gain.linearRampToValueAtTime(rubPeak, t + 0.022);
    rubGain.gain.exponentialRampToValueAtTime(0.001, t + rubDur);
    rub.connect(rubBp);
    rubBp.connect(rubGain);
    this.connectToOutputBuses(rubGain);
    rub.start(t, Math.random() * 1.5, rubDur + 0.02);

    // 2. Subtle polymer mag pouch / metal sling swivel clink on heavier motion
    if (
      kind === 'landing' ||
      kind === 'vault' ||
      kind === 'melee' ||
      kind === 'weapon_swap' ||
      (kind === 'step' && intensity > 0.65)
    ) {
      const clinkCount = kind === 'landing' || kind === 'vault' ? 2 : 1;
      for (let i = 0; i < clinkCount; i++) {
        const delay = 0.012 + i * 0.048 + Math.random() * 0.018;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        const f = (2350 + Math.random() * 950) * (kind === 'landing' ? 0.92 : 1.0);
        osc.frequency.setValueAtTime(f, t + delay);
        osc.frequency.exponentialRampToValueAtTime(f * 0.52, t + delay + 0.028);

        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1600;

        const cg = ctx.createGain();
        const peak =
          (kind === 'landing'
            ? 0.065
            : kind === 'vault'
              ? 0.052
              : kind === 'melee'
                ? 0.046
                : kind === 'weapon_swap'
                  ? 0.05
                  : 0.026) * scale;
        cg.gain.setValueAtTime(peak, t + delay);
        cg.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.032);
        osc.connect(hp);
        hp.connect(cg);
        this.connectToOutputBuses(cg);
        osc.start(t + delay);
        osc.stop(t + delay + 0.038);
      }
    }
  }

  /**
   * Surface-matched tactical glove palm-slap / brace impact for vaulting & mantling.
   */
  public playHandSlap(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.2, 1.8);
    const jitter = 0.92 + Math.random() * 0.16;

    // 1. Muffled gloved palm meat thump
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    const startFreq = surface === 'metal' ? 190 : surface === 'wood' ? 165 : 132;
    thump.frequency.setValueAtTime(startFreq * jitter, t);
    thump.frequency.exponentialRampToValueAtTime(48, t + 0.058);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.18 * amp, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.068);
    thump.connect(tg);
    this.connectToOutputBuses(tg);
    thump.start(t);
    thump.stop(t + 0.075);

    // 2. Leather glove slap + surface texture grit
    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      (surface === 'metal' ? 1450 : surface === 'wood' ? 680 : 940) * jitter;
    bp.Q.value = surface === 'metal' ? 2.4 : 1.4;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.001, t);
    sg.gain.linearRampToValueAtTime(0.19 * amp, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.078);
    slap.connect(bp);
    bp.connect(sg);
    this.connectToOutputBuses(sg);
    slap.start(t, Math.random() * 1.3, 0.09);

    // 3. Metallic shipping-container hollow ring when slapping metal ledges
    if (surface === 'metal') {
      const ring = ctx.createOscillator();
      ring.type = 'triangle';
      ring.frequency.setValueAtTime(310 * jitter, t);
      ring.frequency.exponentialRampToValueAtTime(245 * jitter, t + 0.14);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.14 * amp, t);
      rg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      ring.connect(rg);
      this.connectToOutputBuses(rg, true);
      ring.start(t);
      ring.stop(t + 0.17);
    }
  }

  /**
   * Surface-matched rubber boot sole scrape / kick-off scuff during climb & high mantle.
   */
  public playBootScuff(surface: BodycamSurfaceMaterial, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.2, 1.8);
    const jitter = 0.9 + Math.random() * 0.2;

    const scuff = ctx.createBufferSource();
    scuff.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const fStart = surface === 'metal' ? 1850 : surface === 'wood' ? 820 : 1280;
    bp.frequency.setValueAtTime(fStart * jitter, t);
    bp.frequency.exponentialRampToValueAtTime(fStart * 0.55 * jitter, t + 0.14);
    bp.Q.value = 1.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.16 * amp, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.155);
    scuff.connect(bp);
    bp.connect(g);
    this.connectToOutputBuses(g);
    scuff.start(t, Math.random() * 1.1, 0.17);

    if (surface === 'metal') {
      const thud = ctx.createOscillator();
      thud.type = 'triangle';
      thud.frequency.setValueAtTime(220 * jitter, t);
      thud.frequency.exponentialRampToValueAtTime(115, t + 0.11);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.15 * amp, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      thud.connect(tg);
      this.connectToOutputBuses(tg, true);
      thud.start(t);
      thud.stop(t + 0.13);
    }
  }

  /**
   * Tempered window glass shatter + cascading shard tinkles.
   */
  public playGlassShatter(pos: Readonly<THREE.Vector3>, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.3, 1.8);

    const panner = this.createHRTFPanner(pos, 1.8, 95);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // 1. Sharp initial pane burst
    const burst = ctx.createBufferSource();
    burst.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.58 * amp, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    burst.connect(hp);
    hp.connect(bg);
    bg.connect(panner);
    burst.start(t, Math.random() * 0.8, 0.26);

    // 2. Cascading high-frequency crystalline shard tinkles
    for (let i = 0; i < 9; i++) {
      const delay = 0.015 + i * 0.032 + Math.random() * 0.055;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const freq = 3400 + Math.random() * 4400;
      osc.frequency.setValueAtTime(freq, t + delay);
      osc.frequency.exponentialRampToValueAtTime(freq * (0.9 + Math.random() * 0.08), t + delay + 0.08);
      const sg = ctx.createGain();
      const peak = (0.14 - i * 0.01) * amp;
      sg.gain.setValueAtTime(Math.max(0.02, peak), t + delay);
      sg.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.085);
      osc.connect(sg);
      sg.connect(panner);
      osc.start(t + delay);
      osc.stop(t + delay + 0.095);
    }
  }

  /**
   * Crisp sleeve/boot air-cut whoosh for alternating jabs, crosses, rifle bashes, and push-kicks.
   */
  public playMeleeWhoosh(attackType: BodycamMeleeAttackType): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const heavy = attackType === 'kick' || attackType === 'cross';
    const dur = attackType === 'kick' ? 0.22 : attackType === 'cross' ? 0.17 : 0.13;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const fStart = attackType === 'kick' ? 240 : attackType === 'cross' ? 360 : 480;
    const fPeak = attackType === 'kick' ? 620 : attackType === 'cross' ? 920 : 1220;
    bp.frequency.setValueAtTime(fStart, t);
    bp.frequency.exponentialRampToValueAtTime(fPeak, t + dur * 0.42);
    bp.frequency.exponentialRampToValueAtTime(fStart * 0.72, t + dur);
    bp.Q.value = heavy ? 1.55 : 1.9;

    const g = ctx.createGain();
    const peakGain = attackType === 'kick' ? 0.24 : attackType === 'cross' ? 0.19 : 0.14;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(peakGain, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    src.connect(bp);
    bp.connect(g);
    this.connectToOutputBuses(g);
    src.start(t, Math.random() * 1.1, dur + 0.03);
  }

  /**
   * Visceral meaty blunt thud / heavy tactical boot-slam impact that drives the chest-mic chain.
   */
  public playMeleeImpact(
    pos: Readonly<THREE.Vector3>,
    attackType: BodycamMeleeAttackType,
    surface: BodycamSurfaceMaterial | 'flesh',
    intensity = 1.0,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.35, 1.8);
    const isKick = attackType === 'kick';
    const isHeavy = isKick || attackType === 'cross' || attackType === 'bash';

    const panner = this.createHRTFPanner(pos, 1.5, 85);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    // 1. Sub-bass chest/boot pressure thump
    const thump = ctx.createOscillator();
    thump.type = isKick ? 'triangle' : 'sine';
    const startHz = isKick ? 118 : isHeavy ? 148 : 172;
    const endHz = isKick ? 32 : 44;
    thump.frequency.setValueAtTime(startHz * (0.94 + Math.random() * 0.12), t);
    thump.frequency.exponentialRampToValueAtTime(endHz, t + (isKick ? 0.145 : 0.095));

    const tg = ctx.createGain();
    tg.gain.setValueAtTime((isKick ? 0.92 : isHeavy ? 0.62 : 0.44) * amp, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + (isKick ? 0.16 : 0.11));
    thump.connect(tg);
    tg.connect(panner);
    thump.start(t);
    thump.stop(t + 0.18);

    // 2. Surface-matched transient slap / crunch
    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      surface === 'flesh'
        ? isKick
          ? 290
          : 420
        : surface === 'wood'
          ? 520
          : surface === 'metal'
            ? 1650
            : 1120;
    bp.Q.value = surface === 'metal' ? 2.6 : 1.35;

    const sg = ctx.createGain();
    sg.gain.setValueAtTime((isKick ? 0.56 : 0.38) * amp, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + (isKick ? 0.13 : 0.085));
    slap.connect(bp);
    bp.connect(sg);
    sg.connect(panner);
    slap.start(t, Math.random() * 0.9, 0.15);

    // 3. Resonant overtone for metal plates / wooden door slams
    if (surface === 'metal' || surface === 'wood') {
      const ring = ctx.createOscillator();
      ring.type = 'triangle';
      const baseF = surface === 'metal' ? 1480 + Math.random() * 280 : 195 + Math.random() * 35;
      ring.frequency.setValueAtTime(baseF, t);
      ring.frequency.exponentialRampToValueAtTime(baseF * (surface === 'metal' ? 0.96 : 0.65), t + 0.18);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime((isKick ? 0.34 : 0.22) * amp, t);
      rg.gain.exponentialRampToValueAtTime(0.001, t + (surface === 'metal' ? 0.26 : 0.16));
      ring.connect(rg);
      rg.connect(panner);
      ring.start(t);
      ring.stop(t + 0.28);
    }
  }

  public playGunshot(
    pos: Readonly<THREE.Vector3>,
    weightClass: 'pistol' | 'carbine' | 'heavy_rifle',
    suppressed: boolean,
    isSubsonic = false,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const panner = this.createHRTFPanner(pos, 1.5, isSubsonic && suppressed ? 45 : 160);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    const heavy = weightClass === 'heavy_rifle';
    const rifle = weightClass === 'carbine' || heavy;
    const subSupp = suppressed && isSubsonic;

    // 1. Sub-bass pressure punch (saturates the WaveShaper chest mic when loud!)
    const thumpOsc = ctx.createOscillator();
    thumpOsc.type = 'triangle';
    thumpOsc.frequency.setValueAtTime(
      subSupp ? 115 : suppressed ? 130 : heavy ? 112 : rifle ? 140 : 162,
      t,
    );
    thumpOsc.frequency.exponentialRampToValueAtTime(32, t + (subSupp ? 0.045 : suppressed ? 0.07 : 0.15));

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(
      subSupp ? 0.24 : suppressed ? 0.62 : heavy ? 2.8 : rifle ? 2.3 : 1.75,
      t,
    );
    thumpGain.gain.exponentialRampToValueAtTime(0.001, t + (subSupp ? 0.055 : suppressed ? 0.08 : 0.19));
    thumpOsc.connect(thumpGain);
    thumpGain.connect(panner);
    thumpOsc.start(t);
    thumpOsc.stop(t + 0.21);

    // 2. Muzzle blast crack (suppressed subsonic has no supersonic flight crack)
    const blast = ctx.createBufferSource();
    blast.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = suppressed ? 'lowpass' : 'bandpass';
    bp.frequency.setValueAtTime(
      subSupp ? 520 : suppressed ? 950 : heavy ? 1480 : rifle ? 1720 : 1980,
      t,
    );
    bp.frequency.exponentialRampToValueAtTime(
      subSupp ? 140 : suppressed ? 240 : 360,
      t + (subSupp ? 0.055 : suppressed ? 0.09 : 0.26),
    );
    bp.Q.value = 0.7;

    const blastGain = ctx.createGain();
    blastGain.gain.setValueAtTime(
      subSupp ? 0.22 : suppressed ? 0.50 : heavy ? 3.1 : rifle ? 2.65 : 2.05,
      t,
    );
    blastGain.gain.exponentialRampToValueAtTime(
      0.001,
      t + (subSupp ? 0.07 : suppressed ? 0.11 : heavy ? 0.34 : 0.25),
    );
    blast.connect(bp);
    bp.connect(blastGain);
    blastGain.connect(panner);
    blast.start(t);
    blast.stop(t + 0.38);

    // 3. Mechanical bolt carrier / firing-pin snap
    const boltOsc = ctx.createOscillator();
    boltOsc.type = 'square';
    boltOsc.frequency.setValueAtTime(heavy ? 2100 : 2500, t + 0.012);
    boltOsc.frequency.exponentialRampToValueAtTime(720, t + 0.044);
    const boltGain = ctx.createGain();
    boltGain.gain.setValueAtTime(subSupp ? 0.22 : 0.18, t + 0.012);
    boltGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    boltOsc.connect(boltGain);
    boltGain.connect(panner);
    boltOsc.start(t + 0.012);
    boltOsc.stop(t + 0.056);

    if (!suppressed) {
      this.duckAmbientWind(1.0, 0.01);
    }
  }

  public playImpact(
    pos: Readonly<THREE.Vector3>,
    materialType: 'concrete' | 'wood' | 'metal' | 'steel_plate' | 'paper' | 'puddle',
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createHRTFPanner(pos, 2.0, 95);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    if (materialType === 'steel_plate' || materialType === 'metal') {
      // Crisp AR500 reactive steel plate ring (fundamental + metallic harmonic overtone)
      const base = materialType === 'steel_plate' ? 1850 + Math.random() * 260 : 2500 + Math.random() * 600;
      const freqs = materialType === 'steel_plate' ? [base, base * 1.49, base * 2.13] : [base, base * 1.62];
      const dur = materialType === 'steel_plate' ? 0.58 : 0.20;
      for (let i = 0; i < freqs.length; i++) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freqs[i], t);
        osc.frequency.exponentialRampToValueAtTime(freqs[i] * 0.985, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(i === 0 ? 0.42 : i === 1 ? 0.24 : 0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur * (1 - i * 0.18));
        osc.connect(g);
        g.connect(panner);
        osc.start(t);
        osc.stop(t + dur + 0.03);
      }
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      materialType === 'paper' ? 2400 : materialType === 'wood' ? 720 : materialType === 'puddle' ? 1200 : 1450;
    bp.Q.value = materialType === 'paper' ? 1.8 : 1.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(materialType === 'paper' ? 0.18 : 0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (materialType === 'puddle' ? 0.16 : 0.085));
    src.connect(bp);
    bp.connect(g);
    g.connect(panner);
    src.start(t, Math.random() * 0.8, 0.18);
  }

  /**
   * Spatialized supersonic grazing ricochet whine / Doppler zing.
   */
  public playRicochet(
    pos: Readonly<THREE.Vector3>,
    speedMps: number,
    surface: BodycamSurfaceMaterial,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.wetBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createHRTFPanner(pos, 2.0, 120);
    if (!panner) return;
    panner.connect(this.dryBus);
    panner.connect(this.wetBus);
    if (this.interiorWetBus) {
      panner.connect(this.interiorWetBus);
    }

    const energyNorm = THREE.MathUtils.clamp(speedMps / 750, 0.35, 1.35);
    const startHz =
      (surface === 'metal' ? 3250 : surface === 'puddle' ? 1950 : 2550) *
      (0.88 + Math.random() * 0.28) *
      Math.min(1.2, 0.8 + energyNorm * 0.35);
    const midHz = startHz * (0.58 + Math.random() * 0.18);
    const endHz = midHz * 0.42;
    const dur = 0.24 + Math.random() * 0.14;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(startHz, t);
    osc.frequency.exponentialRampToValueAtTime(midHz, t + dur * 0.35);
    osc.frequency.exponentialRampToValueAtTime(endHz, t + dur);

    // Subtle spin warble (tumble modulation)
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 34 + Math.random() * 26;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = startHz * 0.06;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(startHz * 0.85, t);
    bp.frequency.exponentialRampToValueAtTime(endHz * 1.15, t + dur);
    bp.Q.value = 3.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.28 * Math.min(1.2, energyNorm), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    osc.connect(bp);
    bp.connect(g);
    g.connect(panner);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
  }

  public playTacticalSwitchClick(highPitch = false): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(highPitch ? 2850 : 2150, t);
    osc.frequency.exponentialRampToValueAtTime(highPitch ? 1250 : 880, t + 0.016);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.022);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.028);
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
    osc.stop(t + 0.072);
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
    g.gain.setValueAtTime(0.36, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.035);
  }

  /**
   * Procedural mechanical weapon cue synthesizer synced to WeaponAnimator beats.
   * Covers mag_out, mag_in, rack (2-stage steel bolt/slide), ads_rustle, dryfire, and fire.
   */
  public playWeaponCue(cue: BodycamWeaponAudioCue, options?: BodycamWeaponCueOptions): void {
    if (cue === 'fire') {
      const pos = options?.position ?? new THREE.Vector3();
      this.playGunshot(
        pos,
        options?.weightClass ?? 'carbine',
        Boolean(options?.suppressed),
        Boolean(options?.isSubsonic),
      );
      if (options?.muzzleComp && !options?.suppressed && this.ctx && this.dryBus && this.noiseBuffer) {
        // Extra crisp compensator port crack
        const t = this.ctx.currentTime;
        const crack = this.ctx.createBufferSource();
        crack.buffer = this.noiseBuffer;
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'bandpass';
        hp.frequency.setValueAtTime(2650, t);
        hp.Q.value = 1.2;
        const cg = this.ctx.createGain();
        cg.gain.setValueAtTime(0.42, t);
        cg.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
        crack.connect(hp);
        hp.connect(cg);
        this.connectToOutputBuses(cg, true);
        crack.start(t, Math.random() * 0.6, 0.10);
      }
      return;
    }
    if (cue === 'mode_toggle') {
      this.playTacticalSwitchClick(true);
      return;
    }
    if (cue === 'dryfire') {
      this.playDryFire();
      return;
    }
    if (cue === 'gunsmith_snap') {
      this.ensureInitialized();
      if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const amp = THREE.MathUtils.clamp(options?.intensity ?? 1.0, 0.3, 1.6);

      // Stage 1: Crisp Picatinny / dovetail rail slide friction
      const slide = ctx.createBufferSource();
      slide.buffer = this.noiseBuffer;
      const sbp = ctx.createBiquadFilter();
      sbp.type = 'bandpass';
      sbp.frequency.setValueAtTime(2600, t);
      sbp.frequency.exponentialRampToValueAtTime(1400, t + 0.036);
      sbp.Q.value = 3.4;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.14 * amp, t);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.042);
      slide.connect(sbp);
      sbp.connect(sg);
      sg.connect(this.dryBus);
      slide.start(t, Math.random() * 1.1, 0.05);

      // Stage 2: Spring detent ratchet click (~24ms)
      const ratchet = ctx.createOscillator();
      ratchet.type = 'square';
      ratchet.frequency.setValueAtTime(3400, t + 0.022);
      ratchet.frequency.exponentialRampToValueAtTime(1280, t + 0.044);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.19 * amp, t + 0.022);
      rg.gain.exponentialRampToValueAtTime(0.001, t + 0.048);
      ratchet.connect(rg);
      rg.connect(this.dryBus);
      ratchet.start(t + 0.022);
      ratchet.stop(t + 0.052);

      // Stage 3: Solid machined steel seating lock thud (~36ms)
      const lock = ctx.createOscillator();
      lock.type = 'triangle';
      lock.frequency.setValueAtTime(520, t + 0.032);
      lock.frequency.exponentialRampToValueAtTime(140, t + 0.075);
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0.24 * amp, t + 0.032);
      lg.gain.exponentialRampToValueAtTime(0.001, t + 0.082);
      lock.connect(lg);
      lg.connect(this.dryBus);
      lock.start(t + 0.032);
      lock.stop(t + 0.088);
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
      // Soft tactical sleeve / stock cheek-weld rustle + micro sling contact
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(740 * pitchScale, t);
      bp.frequency.exponentialRampToValueAtTime(480 * pitchScale, t + 0.13);
      bp.Q.value = 1.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.068 * amp, t + 0.022);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.145);
      src.connect(bp);
      bp.connect(g);
      this.connectToOutputBuses(g);
      src.start(t, Math.random() * 1.4, 0.16);
      return;
    }

    if (cue === 'mag_out') {
      // 1. Mag catch release click
      const click = ctx.createOscillator();
      click.type = 'square';
      click.frequency.setValueAtTime(2100 * pitchScale, t);
      click.frequency.exponentialRampToValueAtTime(780 * pitchScale, t + 0.018);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.16 * amp, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.024);
      click.connect(cg);
      this.connectToOutputBuses(cg);
      click.start(t);
      click.stop(t + 0.03);

      // 2. Magazine body friction slide out of magwell
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
      this.connectToOutputBuses(sg);
      slide.start(t + 0.012, Math.random() * 1.2, 0.14);
      return;
    }

    if (cue === 'mag_in') {
      // 1. Solid polymer/steel seating thump
      const thump = ctx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(240 * pitchScale, t);
      thump.frequency.exponentialRampToValueAtTime(78, t + 0.055);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.28 * amp, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.068);
      thump.connect(tg);
      this.connectToOutputBuses(tg);
      thump.start(t);
      thump.stop(t + 0.075);

      // 2. Positive locking latch snap
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
      this.connectToOutputBuses(lg);
      latch.start(t + 0.026);
      latch.stop(t + 0.075);
      return;
    }

    if (cue === 'bolt_open' || cue === 'bolt_lock') {
      const unlock = cue === 'bolt_open';
      const click = ctx.createOscillator();
      click.type = 'triangle';
      click.frequency.setValueAtTime(unlock ? 1480 : 1220, t);
      click.frequency.exponentialRampToValueAtTime(unlock ? 620 : 380, t + 0.042);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.24 * amp, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.052);
      click.connect(cg);
      this.connectToOutputBuses(cg, !unlock);
      click.start(t);
      click.stop(t + 0.06);
      return;
    }

    if (cue === 'bolt_pull' || cue === 'bolt_push') {
      const isPull = cue === 'bolt_pull';
      const slide = ctx.createBufferSource();
      slide.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(isPull ? 1850 : 1550, t);
      bp.frequency.exponentialRampToValueAtTime(isPull ? 2650 : 1150, t + 0.085);
      bp.Q.value = 3.0;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, t);
      sg.gain.linearRampToValueAtTime(0.18 * amp, t + 0.015);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
      slide.connect(bp);
      bp.connect(sg);
      this.connectToOutputBuses(sg);
      slide.start(t, Math.random() * 1.1, 0.11);
      return;
    }

    if (cue === 'suppressor_twist') {
      // Fine-pitch machined steel barrel thread friction scrape + subtle tactile collar rub
      const scrape = ctx.createBufferSource();
      scrape.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      const baseHz = (2400 + Math.random() * 320) * pitchScale;
      bp.frequency.setValueAtTime(baseHz, t);
      bp.frequency.exponentialRampToValueAtTime(baseHz * 1.38, t + 0.085);
      bp.frequency.exponentialRampToValueAtTime(baseHz * 0.92, t + 0.16);
      bp.Q.value = 5.2;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.001, t);
      sg.gain.linearRampToValueAtTime(0.145 * amp, t + 0.025);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
      scrape.connect(bp);
      bp.connect(sg);
      this.connectToOutputBuses(sg);
      scrape.start(t, Math.random() * 1.2, 0.19);

      // High harmonic metallic thread ring overtone
      const ring = ctx.createOscillator();
      ring.type = 'triangle';
      ring.frequency.setValueAtTime(3180 * pitchScale, t + 0.01);
      ring.frequency.exponentialRampToValueAtTime(2680 * pitchScale, t + 0.13);
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.001, t + 0.01);
      rg.gain.linearRampToValueAtTime(0.042 * amp, t + 0.04);
      rg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      ring.connect(rg);
      this.connectToOutputBuses(rg);
      ring.start(t + 0.01);
      ring.stop(t + 0.15);
      return;
    }

    if (cue === 'suppressor_lock') {
      // Crisp steel barrel-shoulder seating detent click + damped solid collar stop
      const detent = ctx.createOscillator();
      detent.type = 'square';
      detent.frequency.setValueAtTime(3650 * pitchScale, t);
      detent.frequency.exponentialRampToValueAtTime(1180 * pitchScale, t + 0.026);
      const dbp = ctx.createBiquadFilter();
      dbp.type = 'bandpass';
      dbp.frequency.value = 2600 * pitchScale;
      dbp.Q.value = 2.4;
      const dg = ctx.createGain();
      dg.gain.setValueAtTime(0.24 * amp, t);
      dg.gain.exponentialRampToValueAtTime(0.001, t + 0.036);
      detent.connect(dbp);
      dbp.connect(dg);
      this.connectToOutputBuses(dg);
      detent.start(t);
      detent.stop(t + 0.042);

      const seat = ctx.createOscillator();
      seat.type = 'triangle';
      seat.frequency.setValueAtTime(480 * pitchScale, t + 0.008);
      seat.frequency.exponentialRampToValueAtTime(145 * pitchScale, t + 0.068);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.22 * amp, t + 0.008);
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.078);
      seat.connect(sg);
      this.connectToOutputBuses(sg);
      seat.start(t + 0.008);
      seat.stop(t + 0.085);
      return;
    }

    // 'rack': 2-stage steel bolt carrier / slide pull back + spring slam forward into battery
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
    this.connectToOutputBuses(pg);
    pull.start(t, Math.random() * 1.1, 0.09);

    // Stage 2: steel bolt/slide slam forward (~95ms later)
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
    this.connectToOutputBuses(sg, true);
    slam.start(slamT);
    slam.stop(slamT + 0.062);
  }

  /**
   * Diegetic hold-breath audio cues:
   *  - 'inhale': soft close-mic bandpass intake sweep on engaging steady aim
   *  - 'exhale': relaxed release exhale when releasing early
   *  - 'exhale_depleted': sharp depleted exhale gasp + follow-up recovery breath
   *  - 'low_o2_pulse': subtle sub-bass double cardiac thump when breath reserve is critically low
   */
  public playBreathCue(kind: BodycamBreathCueKind, intensity = 1.0): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(intensity, 0.35, 1.35);

    if (kind === 'low_o2_pulse') {
      const vol = (0.075 + Math.min(1, amp) * 0.075);
      for (const offset of [0, 0.16]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(offset === 0 ? 58 : 48, t + offset);
        osc.frequency.exponentialRampToValueAtTime(28, t + offset + 0.11);
        const g = ctx.createGain();
        g.gain.setValueAtTime(vol * (offset === 0 ? 1 : 0.72), t + offset);
        g.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.12);
        osc.connect(g);
        g.connect(this.dryBus);
        osc.start(t + offset);
        osc.stop(t + offset + 0.13);
      }
      return;
    }

    if (!this.noiseBuffer) return;

    if (kind === 'inhale') {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(360, t);
      bp.frequency.exponentialRampToValueAtTime(780, t + 0.24);
      bp.Q.value = 1.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.062 * amp, t + 0.14);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.29);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.dryBus);
      src.start(t, Math.random() * 0.5, 0.32);
      return;
    }

    const depleted = kind === 'exhale_depleted';
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(depleted ? 840 : 610, t);
    bp.frequency.exponentialRampToValueAtTime(depleted ? 310 : 340, t + (depleted ? 0.46 : 0.34));
    bp.Q.value = depleted ? 1.45 : 1.65;
    const g = ctx.createGain();
    const peak = (depleted ? 0.145 : 0.082) * amp;
    const dur = depleted ? 0.50 : 0.35;
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.dryBus);
    src.start(t, Math.random() * 0.5, dur + 0.04);

    if (depleted) {
      // Secondary recovery intake gasp so depletion feels physically distinct from early release
      const rT = t + 0.54;
      const rec = ctx.createBufferSource();
      rec.buffer = this.noiseBuffer;
      const rbp = ctx.createBiquadFilter();
      rbp.type = 'bandpass';
      rbp.frequency.setValueAtTime(420, rT);
      rbp.frequency.exponentialRampToValueAtTime(860, rT + 0.28);
      rbp.Q.value = 1.6;
      const rg = ctx.createGain();
      rg.gain.setValueAtTime(0.001, rT);
      rg.gain.linearRampToValueAtTime(0.088 * amp, rT + 0.14);
      rg.gain.exponentialRampToValueAtTime(0.001, rT + 0.38);
      rec.connect(rbp);
      rbp.connect(rg);
      rg.connect(this.dryBus);
      rec.start(rT, Math.random() * 0.5, 0.42);
    }
  }

  /**
   * Crisp tactical grenade safety-pin ring yank (pulling pin alone does NOT ignite fuse).
   */
  public playGrenadePinPull(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 1. Cotter-pin unbending & metallic ring yank scrape
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(2750, t);
    osc.frequency.exponentialRampToValueAtTime(4350, t + 0.058);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.072);
    osc.connect(g);
    this.connectToOutputBuses(g);
    osc.start(t);
    osc.stop(t + 0.08);

    // Subtle steel-on-steel scrape transient
    const scrape = ctx.createBufferSource();
    scrape.buffer = this.noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 3900;
    hp.Q.value = 3.2;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.09, t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.048);
    scrape.connect(hp);
    hp.connect(sg);
    this.connectToOutputBuses(sg);
    scrape.start(t, Math.random() * 1.1, 0.055);
  }

  /**
   * Spring-loaded safety lever (spoon) fly-off ping + percussion primer ignition pop.
   */
  public playGrenadeLeverSnap(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 1. Spring-loaded spoon metallic ping
    const ping = ctx.createOscillator();
    ping.type = 'square';
    ping.frequency.setValueAtTime(2280, t);
    ping.frequency.exponentialRampToValueAtTime(840, t + 0.036);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2350;
    bp.Q.value = 2.8;
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.22, t);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.046);
    ping.connect(bp);
    bp.connect(pg);
    this.connectToOutputBuses(pg);
    ping.start(t);
    ping.stop(t + 0.052);

    // 2. Percussion primer strike pop + pyrotechnic delay fuse sizzle start (~22ms later)
    const popT = t + 0.022;
    const pop = ctx.createBufferSource();
    pop.buffer = this.noiseBuffer;
    const popBp = ctx.createBiquadFilter();
    popBp.type = 'bandpass';
    popBp.frequency.setValueAtTime(1650, popT);
    popBp.frequency.exponentialRampToValueAtTime(580, popT + 0.045);
    popBp.Q.value = 1.4;
    const popG = ctx.createGain();
    popG.gain.setValueAtTime(0.26, popT);
    popG.gain.exponentialRampToValueAtTime(0.001, popT + 0.052);
    pop.connect(popBp);
    popBp.connect(popG);
    this.connectToOutputBuses(popG);
    pop.start(popT, Math.random() * 0.9, 0.06);

    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    const hissHp = ctx.createBiquadFilter();
    hissHp.type = 'highpass';
    hissHp.frequency.value = 4600;
    const hissG = ctx.createGain();
    hissG.gain.setValueAtTime(0.001, popT + 0.015);
    hissG.gain.linearRampToValueAtTime(0.065, popT + 0.045);
    hissG.gain.exponentialRampToValueAtTime(0.001, popT + 0.42);
    hiss.connect(hissHp);
    hissHp.connect(hissG);
    this.connectToOutputBuses(hissG);
    hiss.start(popT + 0.015, Math.random() * 0.6, 0.44);
  }

  /**
   * Concussive flashbang ear-muffle lowpass dip + realistic dual-sine high-frequency tinnitus fade.
   */
  public playFlashbangTinnitus(intensity: number): void {
    this.ensureInitialized();
    if (!this.ctx || !this.masterGain || !this.masterLowpass) return;
    const amp = THREE.MathUtils.clamp(intensity, 0.08, 1.0);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const holdDur = 0.65 + amp * 1.45;
    const recoverDur = 2.8 + amp * 3.4;

    // 1. Slam masterLowpass down to simulate concussive acoustic threshold shift (muffled ears)
    const lpFreq = this.masterLowpass.frequency;
    lpFreq.cancelScheduledValues(t);
    lpFreq.setValueAtTime(Math.max(280, lpFreq.value), t);
    const minCutoff = THREE.MathUtils.lerp(2400, 340, amp);
    lpFreq.exponentialRampToValueAtTime(minCutoff, t + 0.04);
    lpFreq.setValueAtTime(minCutoff, t + holdDur * 0.55);
    lpFreq.exponentialRampToValueAtTime(22000, t + holdDur + recoverDur);

    // 2. Dual-sine inner-ear tinnitus ringing routed straight to masterGain (post-lowpass)
    const ringVol = 0.16 * Math.pow(amp, 1.15);
    const freqs = [4320 + Math.random() * 180, 6180 + Math.random() * 240];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], t);
      osc.frequency.linearRampToValueAtTime(freqs[i] * 0.985, t + holdDur + recoverDur);

      const rg = ctx.createGain();
      const peak = i === 0 ? ringVol : ringVol * 0.42;
      rg.gain.setValueAtTime(0.0001, t);
      rg.gain.linearRampToValueAtTime(peak, t + 0.035);
      rg.gain.setValueAtTime(peak * 0.92, t + holdDur * 0.6);
      rg.gain.exponentialRampToValueAtTime(0.0001, t + holdDur + recoverDur);

      osc.connect(rg);
      rg.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + holdDur + recoverDur + 0.06);
    }
  }

  /**
   * Mechanical LPVO magnification ring throw-lever ratchet click.
   */
  public playZoomRatchetClick(zoomLevel = 1): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const pitchScale = 0.9 + THREE.MathUtils.clamp((zoomLevel - 1) / 5, 0, 1) * 0.25;

    // 1. Machined aluminum throw-lever detent snap
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1920 * pitchScale, t);
    osc.frequency.exponentialRampToValueAtTime(740 * pitchScale, t + 0.022);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.026);
    osc.connect(g);
    this.connectToOutputBuses(g);
    osc.start(t);
    osc.stop(t + 0.032);

    // 2. Knurled O-ring rubberized ring glide brush
    const brush = ctx.createBufferSource();
    brush.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1480 * pitchScale;
    bp.Q.value = 2.4;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.065, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    brush.connect(bp);
    bp.connect(bg);
    this.connectToOutputBuses(bg);
    brush.start(t, Math.random() * 0.8, 0.052);
  }

  /**
   * Crisp 0.1 MRAD scope elevation / windage turret mechanical ball-detent click.
   */
  public playTurretClick(up = true): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    const fStart = up ? 3150 : 2650;
    osc.frequency.setValueAtTime(fStart, t);
    osc.frequency.exponentialRampToValueAtTime(fStart * 0.42, t + 0.014);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = up ? 2900 : 2400;
    bp.Q.value = 3.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.17, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.019);

    osc.connect(bp);
    bp.connect(g);
    this.connectToOutputBuses(g);
    osc.start(t);
    osc.stop(t + 0.024);
  }

  /**
   * Spatialized metallic grenade/canister floor & wall bounce clink.
   */
  public playGrenadeBounce(position: Readonly<THREE.Vector3>, speed = 4.5): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = THREE.MathUtils.clamp(speed / 9.0, 0.14, 1.0);
    const jitter = 0.9 + Math.random() * 0.22;

    const panner = this.createHRTFPanner(position, 2.2, 48);
    const dest: AudioNode = panner ?? this.dryBus;
    if (panner) {
      this.connectToOutputBuses(panner, true);
    }

    // Hollow cast-iron/aluminum canister ring
    const ring = ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.setValueAtTime(1420 * jitter, t);
    ring.frequency.exponentialRampToValueAtTime(890 * jitter, t + 0.075);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.19 * amp, t);
    rg.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
    ring.connect(rg);
    rg.connect(dest);
    ring.start(t);
    ring.stop(t + 0.095);

    // Impact grit transient
    const grit = ctx.createBufferSource();
    grit.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1850 * jitter;
    bp.Q.value = 1.9;
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.18 * amp, t);
    gg.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
    grit.connect(bp);
    bp.connect(gg);
    gg.connect(dest);
    if (panner) {
      ring.onended = () => {
        try {
          panner.disconnect();
        } catch {
          // already disconnected
        }
      };
    }
    grit.start(t, Math.random() * 1.1, 0.065);
  }

  /**
   * Spatialized tactical ordnance detonation synthesizer for frag, flashbang, smoke, and thermite.
   */
  public playExplosion(
    position: Readonly<THREE.Vector3>,
    kind: 'frag' | 'flash' | 'smoke' | 'thermite',
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const panner = this.createHRTFPanner(position, kind === 'smoke' ? 4.5 : 8.5, 145);
    const dest: AudioNode = panner ?? this.dryBus;
    if (panner) {
      this.connectToOutputBuses(panner, true);
    }

    if (kind === 'frag') {
      this.duckAmbientWind(1.35, 0.006);

      // 1. Sub-bass overpressure shockwave punch
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(118, t);
      sub.frequency.exponentialRampToValueAtTime(24, t + 0.55);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.95, t);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.68);
      sub.connect(subGain);
      subGain.connect(dest);
      sub.start(t);
      sub.stop(t + 0.72);

      // 2. Concussive detonation crack + rolling debris rumble
      const blast = ctx.createBufferSource();
      blast.buffer = this.noiseBuffer;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4600, t);
      lp.frequency.exponentialRampToValueAtTime(240, t + 0.95);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.001, t);
      bg.gain.linearRampToValueAtTime(0.92, t + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
      blast.connect(lp);
      lp.connect(bg);
      bg.connect(dest);
      blast.start(t, 0, 1.25);

      // 3. High-velocity shrapnel snap
      const crack = ctx.createBufferSource();
      crack.buffer = this.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = 2600;
      hp.Q.value = 0.9;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.55, t);
      cg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      crack.connect(hp);
      hp.connect(cg);
      cg.connect(dest);
      crack.start(t, Math.random() * 0.6, 0.18);
      return;
    }

    if (kind === 'flash') {
      this.duckAmbientWind(1.1, 0.008);

      // Sharp magnesium-perchlorate concussive bang
      const bang = ctx.createBufferSource();
      bang.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2900, t);
      bp.frequency.exponentialRampToValueAtTime(750, t + 0.28);
      bp.Q.value = 0.8;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.9, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      bang.connect(bp);
      bp.connect(bg);
      bg.connect(dest);
      bang.start(t, 0, 0.38);

      const punch = ctx.createOscillator();
      punch.type = 'triangle';
      punch.frequency.setValueAtTime(240, t);
      punch.frequency.exponentialRampToValueAtTime(52, t + 0.18);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.62, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      punch.connect(pg);
      pg.connect(dest);
      punch.start(t);
      punch.stop(t + 0.24);
      return;
    }

    if (kind === 'smoke') {
      // Primer pop + pressurized gas hiss plume
      const pop = ctx.createOscillator();
      pop.type = 'sine';
      pop.frequency.setValueAtTime(280, t);
      pop.frequency.exponentialRampToValueAtTime(85, t + 0.08);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.32, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      pop.connect(pg);
      pg.connect(dest);
      pop.start(t);
      pop.stop(t + 0.12);

      const hiss = ctx.createBufferSource();
      hiss.buffer = this.noiseBuffer;
      hiss.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2400, t);
      bp.frequency.exponentialRampToValueAtTime(1350, t + 2.4);
      bp.Q.value = 1.4;
      const hg = ctx.createGain();
      hg.gain.setValueAtTime(0.001, t + 0.04);
      hg.gain.linearRampToValueAtTime(0.34, t + 0.22);
      hg.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
      hiss.connect(bp);
      bp.connect(hg);
      hg.connect(dest);
      hiss.start(t + 0.04);
      hiss.stop(t + 2.65);
      return;
    }

    // 'thermite': intense igniter crack + white-hot magnesium crackle hiss
    const ign = ctx.createBufferSource();
    ign.buffer = this.noiseBuffer;
    const ihp = ctx.createBiquadFilter();
    ihp.type = 'bandpass';
    ihp.frequency.setValueAtTime(1950, t);
    ihp.frequency.exponentialRampToValueAtTime(620, t + 0.45);
    ihp.Q.value = 1.1;
    const ig = ctx.createGain();
    ig.gain.setValueAtTime(0.68, t);
    ig.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    ign.connect(ihp);
    ihp.connect(ig);
    ig.connect(dest);
    ign.start(t, 0, 0.55);

    const burn = ctx.createBufferSource();
    burn.buffer = this.noiseBuffer;
    burn.loop = true;
    const bbp = ctx.createBiquadFilter();
    bbp.type = 'bandpass';
    bbp.frequency.value = 3400;
    bbp.Q.value = 0.85;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.001, t + 0.08);
    bg.gain.linearRampToValueAtTime(0.26, t + 0.28);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 2.9);
    burn.connect(bbp);
    bbp.connect(bg);
    bg.connect(dest);
    burn.start(t + 0.08);
    burn.stop(t + 2.95);
    if (panner) {
      burn.onended = () => {
        try {
          panner.disconnect();
        } catch {
          // already disconnected
        }
      };
    }
  }

  /**
   * Subtle tactical HUD/comms radio ping chirp with distinct timbre per ping category:
   *  - 'location': crisp single high-tech sonar tick
   *  - 'enemy': urgent double-pip hostile alert chime
   *  - 'item': warm resonant supply/station lock-on tone
   */
  public playTacticalPing(kind: 'location' | 'enemy' | 'item'): void {
    this.ensureInitialized();
    if (!this.ctx || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    if (kind === 'enemy') {
      // Crisp urgent double-pip
      for (let i = 0; i < 2; i++) {
        const start = t + i * 0.062;
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(i === 0 ? 1180 : 1480, start);
        osc.frequency.exponentialRampToValueAtTime(i === 0 ? 960 : 1220, start + 0.048);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.001, start);
        g.gain.linearRampToValueAtTime(0.11, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0008, start + 0.055);

        osc.connect(g);
        g.connect(this.dryBus);
        osc.start(start);
        osc.stop(start + 0.06);
      }
      return;
    }

    if (kind === 'item') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(740, t);
      osc.frequency.exponentialRampToValueAtTime(1120, t + 0.085);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.105, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.11);

      osc.connect(g);
      g.connect(this.dryBus);
      osc.start(t);
      osc.stop(t + 0.12);
      return;
    }

    // 'location'
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1040, t);
    osc.frequency.exponentialRampToValueAtTime(840, t + 0.065);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.095, t + 0.007);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.08);

    osc.connect(g);
    g.connect(this.dryBus);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  private lastSquadRadioChirpMs = 0;

  /**
   * Synthesizes an authentic VHF/UHF tactical squad radio squelch burst:
   * PTT key-up click + brief band-limited static carrier + distinct category roger-beep release.
   */
  public playSquadRadioChirp(category: 'threat' | 'economy' | 'status' | 'ack'): void {
    const nowMs = performance.now();
    if (nowMs - this.lastSquadRadioChirpMs < 550) return;
    this.lastSquadRadioChirpMs = nowMs;

    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 1. Key-up VHF squelch static burst (band-limited 950..2400 Hz)
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(category === 'threat' ? 1750 : 1420, t);
    bp.Q.setValueAtTime(2.6, t);

    const staticGain = ctx.createGain();
    staticGain.gain.setValueAtTime(0.0005, t);
    staticGain.gain.linearRampToValueAtTime(0.055, t + 0.012);
    staticGain.gain.exponentialRampToValueAtTime(0.014, t + 0.042);
    staticGain.gain.linearRampToValueAtTime(0.012, t + 0.14);
    staticGain.gain.linearRampToValueAtTime(0.042, t + 0.155);
    staticGain.gain.exponentialRampToValueAtTime(0.0005, t + 0.195);

    src.connect(bp);
    bp.connect(staticGain);
    staticGain.connect(this.dryBus);
    src.start(t, Math.random() * 0.4);
    src.stop(t + 0.21);

    // 2. Category-distinct tactical roger-beep / PTT tail
    const tones =
      category === 'threat'
        ? [1340, 1620]
        : category === 'economy'
          ? [880, 1180]
          : category === 'ack'
            ? [1060, 1060]
            : [980];

    for (let i = 0; i < tones.length; i++) {
      const start = t + 0.145 + i * 0.048;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tones[i], start);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0008, start);
      og.gain.linearRampToValueAtTime(0.052, start + 0.005);
      og.gain.exponentialRampToValueAtTime(0.0006, start + 0.042);
      osc.connect(og);
      og.connect(this.dryBus);
      osc.start(start);
      osc.stop(start + 0.046);
    }
  }

  /**
   * Horror-mix 3D HRTF spatialized zombie vocalization with proximity-escalated intensity:
   *  - Distant (> 16m): hollow reverberant corridor moans with air-absorption rolloff
   *  - Mid-range (7–16m): phlegmy wet rasping groans with throat-flutter modulation
   *  - Close-range (< 7m): aggressive snarls, wet sibilant breath hiss, and chest rumble
   *  - Combat cues: tearing lunge shrieks, bullet/melee hurt barks, and wet collapsing death rattles
   */
  public playZombieVocal(
    pos: Readonly<THREE.Vector3>,
    kind: ZombieVocalKind,
    opts?: ZombieVocalAudioOptions,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const dist = opts?.distanceM ?? pos.distanceTo(this.listenerPos);
    if (dist > 38) return;

    const maxVoices = kind === 'lunge' || kind === 'snarl' || kind === 'death' ? 8 : 6;
    if (this.activeZombieVocals >= maxVoices) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const pitch = THREE.MathUtils.clamp(opts?.pitchScale ?? 1.0, 0.72, 1.32);
    const intensity = THREE.MathUtils.clamp(opts?.intensity ?? 1.0, 0.4, 1.8);

    // Horror-mix proximity shaping: ramps sharply inside 9.5m and surges inside 4.8m
    const prox = THREE.MathUtils.clamp(1 - dist / 32, 0, 1);
    const closeBoost = THREE.MathUtils.clamp(1 - dist / 9.5, 0, 1);
    const veryClose = THREE.MathUtils.clamp(1 - dist / 4.8, 0, 1);
    const horrorGain = (0.58 + prox * 0.48 + closeBoost * 0.65 + veryClose * 0.42) * intensity;

    const isAggressive = kind === 'snarl' || kind === 'lunge';
    const panner = this.createHRTFPanner(pos, isAggressive ? 2.6 : 2.1, 42);
    if (!panner) return;
    panner.rolloffFactor = 1.02;

    // Air-absorption filter: distant sounds sound dark & hollow, close snarls stay razor-sharp
    const airLp = ctx.createBiquadFilter();
    airLp.type = 'lowpass';
    airLp.frequency.value = THREE.MathUtils.clamp(
      (isAggressive ? 2200 : 1450) + prox * 2500 + closeBoost * 3800,
      1200,
      9500,
    );
    airLp.Q.value = 0.7;

    const drySend = ctx.createGain();
    drySend.gain.value = 0.62 + closeBoost * 0.56;
    const wetSend = ctx.createGain();
    wetSend.gain.value = 0.58 - closeBoost * 0.24;

    airLp.connect(panner);
    panner.connect(drySend);
    panner.connect(wetSend);
    drySend.connect(this.dryBus);
    wetSend.connect(this.wetBus);
    if (this.interiorWetBus) {
      wetSend.connect(this.interiorWetBus);
    }

    this.activeZombieVocals += 1;

    // Per-class spectral & temporal profile
    let dur = 0.92;
    let f0Start = 86 * pitch;
    let f0Mid = 78 * pitch;
    let f0End = 64 * pitch;
    let rattleHz = 20;
    let rattleDepth = 0.28;
    let f1Start = 350;
    let f1End = 260;
    let f2Start = 840;
    let f2End = 620;
    let vocalAmp = 0.24;
    let breathAmp = 0.14;
    let breathFreqStart = 1280;
    let breathFreqEnd = 900;
    let breathQ = 2.2;
    let useDualOsc = false;
    let useSubRumble = false;

    if (kind === 'moan') {
      dur = 0.95 + Math.random() * 0.42;
      f0Start = (72 + Math.random() * 22) * pitch;
      f0Mid = f0Start * (0.94 + Math.random() * 0.08);
      f0End = f0Start * 0.74;
      rattleHz = 15 + Math.random() * 6;
      rattleDepth = 0.24;
      f1Start = 330 + Math.random() * 60;
      f1End = 245;
      f2Start = 780 + Math.random() * 110;
      f2End = 560;
      vocalAmp = 0.25;
      breathAmp = 0.11 + closeBoost * 0.14;
      breathFreqStart = 1150;
      breathFreqEnd = 780;
      useDualOsc = true;
    } else if (kind === 'groan') {
      dur = 0.68 + Math.random() * 0.30;
      f0Start = (94 + Math.random() * 24) * pitch;
      f0Mid = f0Start * 1.12;
      f0End = f0Start * 0.72;
      rattleHz = 24 + Math.random() * 9;
      rattleDepth = 0.38;
      f1Start = 450 + Math.random() * 70;
      f1End = 310;
      f2Start = 1160 + Math.random() * 140;
      f2End = 820;
      vocalAmp = 0.30;
      breathAmp = 0.18 + closeBoost * 0.24;
      breathFreqStart = 1650;
      breathFreqEnd = 1180;
      useDualOsc = true;
      useSubRumble = closeBoost > 0.12;
    } else if (kind === 'snarl') {
      dur = 0.48 + Math.random() * 0.26;
      f0Start = (118 + Math.random() * 34) * pitch;
      f0Mid = f0Start * 1.28;
      f0End = f0Start * 0.78;
      rattleHz = 31 + Math.random() * 12;
      rattleDepth = 0.48;
      f1Start = 640 + Math.random() * 110;
      f1End = 460;
      f2Start = 1720 + Math.random() * 260;
      f2End = 2320;
      vocalAmp = 0.42;
      breathAmp = 0.30 + closeBoost * 0.38 + veryClose * 0.24;
      breathFreqStart = 2450;
      breathFreqEnd = 1720;
      breathQ = 1.65;
      useDualOsc = true;
      useSubRumble = true;
    } else if (kind === 'lunge') {
      dur = 0.42 + Math.random() * 0.16;
      f0Start = (158 + Math.random() * 32) * pitch;
      f0Mid = f0Start * 1.56;
      f0End = f0Start * 0.86;
      rattleHz = 36 + Math.random() * 10;
      rattleDepth = 0.45;
      f1Start = 840;
      f1End = 1260;
      f2Start = 2120;
      f2End = 2820;
      vocalAmp = 0.48;
      breathAmp = 0.34 + closeBoost * 0.34 + veryClose * 0.22;
      breathFreqStart = 2780;
      breathFreqEnd = 1980;
      breathQ = 1.55;
      useDualOsc = true;
      useSubRumble = true;
    } else if (kind === 'hurt') {
      dur = 0.22 + Math.random() * 0.11;
      f0Start = (128 + Math.random() * 26) * pitch;
      f0Mid = f0Start * 0.92;
      f0End = f0Start * 0.58;
      rattleHz = 28;
      rattleDepth = 0.32;
      f1Start = 540;
      f1End = 320;
      f2Start = 1320;
      f2End = 780;
      vocalAmp = 0.30;
      breathAmp = 0.16;
      breathFreqStart = 1850;
      breathFreqEnd = 980;
    } else {
      // 'death': wet collapsing exhale rattle
      dur = 0.78 + Math.random() * 0.28;
      f0Start = (114 + Math.random() * 22) * pitch;
      f0Mid = f0Start * 0.72;
      f0End = Math.max(36, f0Start * 0.40);
      rattleHz = 24;
      rattleDepth = 0.44;
      f1Start = 460;
      f1End = 210;
      f2Start = 1120;
      f2End = 480;
      vocalAmp = 0.32;
      breathAmp = 0.26;
      breathFreqStart = 1220;
      breathFreqEnd = 440;
      breathQ = 1.45;
      useDualOsc = true;
    }

    // 1. Primary vocal cord oscillator + throat-rattle LFO (AM + subtle FM vocal fry)
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0Start, t);
    osc1.frequency.linearRampToValueAtTime(f0Mid, t + dur * 0.34);
    osc1.frequency.exponentialRampToValueAtTime(Math.max(32, f0End), t + dur);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(rattleHz, t);
    if (kind === 'death') {
      lfo.frequency.exponentialRampToValueAtTime(9, t + dur);
    }

    const fmDepth = ctx.createGain();
    fmDepth.gain.value = isAggressive ? 16 : 9;
    lfo.connect(fmDepth);
    fmDepth.connect(osc1.frequency);

    const vocalMix = ctx.createGain();
    vocalMix.gain.value = 1.0;
    osc1.connect(vocalMix);

    let osc2: OscillatorNode | null = null;
    if (useDualOsc) {
      osc2 = ctx.createOscillator();
      osc2.type = kind === 'moan' ? 'triangle' : 'sawtooth';
      const detuneRatio = kind === 'moan' ? 0.504 : isAggressive ? 1.072 : 0.992;
      osc2.frequency.setValueAtTime(f0Start * detuneRatio, t);
      osc2.frequency.linearRampToValueAtTime(f0Mid * detuneRatio, t + dur * 0.34);
      osc2.frequency.exponentialRampToValueAtTime(Math.max(28, f0End * detuneRatio), t + dur);
      const o2Gain = ctx.createGain();
      o2Gain.gain.value = kind === 'moan' ? 0.65 : 0.52;
      osc2.connect(o2Gain);
      o2Gain.connect(vocalMix);
    }

    // Dual vocal-tract formants (F1 throat cavity + F2 snarl/mouth resonance)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.setValueAtTime(f1Start, t);
    f1.frequency.exponentialRampToValueAtTime(Math.max(140, f1End), t + dur);
    f1.Q.value = isAggressive ? 2.5 : 3.5;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.setValueAtTime(f2Start, t);
    f2.frequency.exponentialRampToValueAtTime(Math.max(260, f2End), t + dur);
    f2.Q.value = isAggressive ? 2.2 : 2.9;

    const f2Gain = ctx.createGain();
    f2Gain.gain.value = isAggressive ? 0.85 : 0.55;

    const amNode = ctx.createGain();
    amNode.gain.value = 1.0;
    const amDepth = ctx.createGain();
    amDepth.gain.value = rattleDepth;
    lfo.connect(amDepth);
    amDepth.connect(amNode.gain);

    const vocalEnv = ctx.createGain();
    const peakVocal = Math.min(1.15, vocalAmp * horrorGain);
    const attackSec = kind === 'lunge' || kind === 'hurt' ? 0.025 : kind === 'snarl' ? 0.045 : 0.11;
    vocalEnv.gain.setValueAtTime(0.001, t);
    vocalEnv.gain.linearRampToValueAtTime(peakVocal, t + attackSec);
    vocalEnv.gain.setValueAtTime(peakVocal * 0.88, t + dur * 0.52);
    vocalEnv.gain.exponentialRampToValueAtTime(0.001, t + dur);

    vocalMix.connect(f1);
    vocalMix.connect(f2);
    f1.connect(amNode);
    f2.connect(f2Gain);
    f2Gain.connect(amNode);
    amNode.connect(vocalEnv);
    vocalEnv.connect(airLp);

    // 2. Wet raspy breath / close-range sibilant hiss layer
    const breath = ctx.createBufferSource();
    breath.buffer = this.noiseBuffer;
    const breathBp = ctx.createBiquadFilter();
    breathBp.type = 'bandpass';
    breathBp.frequency.setValueAtTime(breathFreqStart, t);
    breathBp.frequency.exponentialRampToValueAtTime(Math.max(320, breathFreqEnd), t + dur);
    breathBp.Q.value = breathQ;

    const breathEnv = ctx.createGain();
    const peakBreath = Math.min(0.95, breathAmp * horrorGain);
    breathEnv.gain.setValueAtTime(0.001, t);
    breathEnv.gain.linearRampToValueAtTime(peakBreath, t + Math.min(0.09, dur * 0.2));
    breathEnv.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.04);

    breath.connect(breathBp);
    breathBp.connect(breathEnv);
    breathEnv.connect(airLp);

    // 3. Close-range chest-rumble undertone (drives chest-mic saturation when an infected is right behind you)
    if (useSubRumble && closeBoost > 0.05) {
      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      sub.frequency.setValueAtTime(66 * pitch, t);
      sub.frequency.exponentialRampToValueAtTime(38 * pitch, t + dur * 0.88);
      const subGain = ctx.createGain();
      const peakSub = Math.min(0.55, (0.16 + closeBoost * 0.28 + veryClose * 0.16) * intensity);
      subGain.gain.setValueAtTime(0.001, t);
      subGain.gain.linearRampToValueAtTime(peakSub, t + 0.04);
      subGain.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.9);
      sub.connect(subGain);
      subGain.connect(panner);
      sub.start(t);
      sub.stop(t + dur * 0.94);
    }

    const stopAt = t + dur + 0.06;
    osc1.start(t);
    osc1.stop(stopAt);
    osc2?.start(t);
    osc2?.stop(stopAt);
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

  /**
   * Horror-mix 3D HRTF spatialized zombie footsteps:
   *  - Slow shamblers produce an eerie dragging grit scuff followed by a dull heel thud
   *  - Sprinting infected produce heavier, sharper stomping thuds that escalate sharply inside 12m
   */
  public playZombieFootstep(
    pos: Readonly<THREE.Vector3>,
    opts?: ZombieFootstepAudioOptions,
  ): void {
    this.ensureInitialized();
    if (!this.ctx || !this.noiseBuffer || !this.dryBus || !this.wetBus) return;
    const dist = opts?.distanceM ?? pos.distanceTo(this.listenerPos);
    if (dist > 24) return;
    if (this.activeZombieSteps >= 6) return;

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

    // 1. Heavy floor-coupled heel thump (low rumble felt strongly when sprinting close behind player)
    const thump = ctx.createOscillator();
    thump.type = surface === 'metal' ? 'triangle' : 'sine';
    const thumpStart = surface === 'metal' ? 128 : surface === 'wood' ? 102 : 90;
    const thumpEnd = surface === 'metal' ? 46 : 33;
    const jitter = 0.92 + Math.random() * 0.16;
    thump.frequency.setValueAtTime(thumpStart * jitter, t);
    thump.frequency.exponentialRampToValueAtTime(thumpEnd, t + 0.082);

    const tg = ctx.createGain();
    tg.gain.setValueAtTime(Math.min(0.82, 0.42 * amp), t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.095);
    thump.connect(tg);
    tg.connect(panner);
    thump.start(t);
    thump.stop(t + 0.11);

    // 2. Surface-matched sole slap / grit crunch
    const slap = ctx.createBufferSource();
    slap.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      surface === 'metal'
        ? 1850
        : surface === 'wood'
          ? 560
          : surface === 'puddle'
            ? 1480
            : surface === 'gravel' || surface === 'grass'
              ? 680
              : 1020;
    bp.Q.value = surface === 'metal' ? 2.4 : 1.3;

    const sg = ctx.createGain();
    const slapDur = isDrag ? 0.155 : 0.078;
    sg.gain.setValueAtTime(0.001, t);
    sg.gain.linearRampToValueAtTime(Math.min(0.68, (isDrag ? 0.28 : 0.34) * amp), t + (isDrag ? 0.035 : 0.008));
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

  /**
   * Exposes the active Web Audio context and chest-mic output buses so open-world
   * environmental ambience and spatial wildlife audio share the same HRTF listener,
   * interior muffling state, and chest-mic saturation/compressor chain.
   */
  public getExternalAudioBus(): {
    ctx: AudioContext;
    dryBus: GainNode;
    wetBus: GainNode | null;
    interiorWetBus: GainNode | null;
    isIndoor: boolean;
    listenerPos: Readonly<THREE.Vector3>;
  } | null {
    if (!this.ctx || !this.dryBus) return null;
    return {
      ctx: this.ctx,
      dryBus: this.dryBus,
      wetBus: this.wetBus,
      interiorWetBus: this.interiorWetBus,
      isIndoor: this.currentIndoor,
      listenerPos: this.listenerPos,
    };
  }

  public dispose(): void {
    try {
      this.windSource?.stop();
    } catch {
      // already stopped
    }
    try {
      this.rainSource?.stop();
    } catch {
      // already stopped
    }
    try {
      this.nvgHumOsc?.stop();
    } catch {
      // already stopped
    }
    this.nvgHumOsc = null;
    this.nvgHumGain = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.activeZombieVocals = 0;
    this.activeZombieSteps = 0;
    this.initialized = false;
  }
}


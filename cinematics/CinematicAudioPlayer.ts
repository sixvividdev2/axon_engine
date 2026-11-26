import { CinematicVoiceCue } from './cinematicVoiceManifest';

export type CinematicAmbienceKind = 'none' | 'drone_wind' | 'helicopter' | 'apc_diesel' | 'bunker_hum';

/**
 * 3-Bus AAA Runtime Cinematic Audio Engine:
 * 1. Voice Bus: Plays pre-baked static WAV files from `/audio/cinematics/` through a crisp
 *    tactical radio bandpass chain (zero runtime LLM calls). If a static WAV is unavailable,
 *    plays only a clean tactical radio PTT squelch click (NEVER harsh sawtooth oscillator beeps).
 * 2. Foley & Vehicle Bus: Multi-layered helicopter rotor chop + turbine whine, revving APC
 *    diesel + gravel roll, metallic armored door slams, tactical boot footsteps, and punchy
 *    5.56 corridor gunshots with room reverb tail & brass casing clinks.
 * 3. Subtle Dark-Military Score Bus: Warm low sub-bass pad (D2/A2 fifth through resonant LPF)
 *    with gentle act-driven intensity swell (`setScoreIntensity`).
 *
 * Includes automatic Web Audio autoplay unlock on first pointer/key interaction and exact
 * `[Space]` Pause / Resume via `AudioContext.suspend()` / `resume()`.
 */
export class CinematicAudioPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private foleyGain: GainNode | null = null;
  private scoreGain: GainNode | null = null;
  private radioBandpass: BiquadFilterNode | null = null;

  private readonly decodedCache = new Map<string, AudioBuffer | null>();
  private readonly activeSources = new Set<AudioScheduledSourceNode>();

  private ambienceKind: CinematicAmbienceKind = 'none';
  private ambienceNodes: AudioNode[] = [];
  private ambienceSources: AudioScheduledSourceNode[] = [];
  private apcEngineOsc: OscillatorNode | null = null;
  private apcFilterNode: BiquadFilterNode | null = null;

  private scoreStarted = false;
  private scoreSources: AudioScheduledSourceNode[] = [];
  private scoreNodes: AudioNode[] = [];
  private scoreTargetLevel = 0.0;

  private paused = false;
  private disposed = false;
  private unlockListenersBound = false;

  constructor() {
    this.bindAutoplayUnlockListeners();
  }

  private bindAutoplayUnlockListeners(): void {
    if (this.unlockListenersBound || typeof window === 'undefined') return;
    this.unlockListenersBound = true;
    window.addEventListener('pointerdown', this.handleUserUnlock, { passive: true });
    window.addEventListener('keydown', this.handleUserUnlock, { passive: true });
  }

  private readonly handleUserUnlock = (): void => {
    if (this.disposed) return;
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended' && !this.paused) {
      void ctx.resume().catch(() => undefined);
    }
  };

  public unlockAudio(): void {
    this.handleUserUnlock();
  }

  public isAudioBlocked(): boolean {
    if (this.paused || this.disposed) return false;
    return this.ctx !== null && this.ctx.state === 'suspended';
  }

  private ensureContext(): AudioContext | null {
    if (this.disposed || typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      try {
        const ctx = new AudioCtx();
        const master = ctx.createGain();
        master.gain.value = 0.78;
        master.connect(ctx.destination);

        // Bus 1: Tactical Radio Voice
        const voice = ctx.createGain();
        voice.gain.value = 0.96;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1520;
        bp.Q.value = 0.62;
        voice.connect(bp);
        bp.connect(master);

        // Bus 2: Vehicle Ambience + One-Shot Foley
        const amb = ctx.createGain();
        amb.gain.value = 0.36;
        amb.connect(master);

        const foley = ctx.createGain();
        foley.gain.value = 0.72;
        foley.connect(master);

        // Bus 3: Subtle Dark-Military Ambient Score
        const score = ctx.createGain();
        score.gain.value = 0.0001;
        score.connect(master);

        this.ctx = ctx;
        this.masterGain = master;
        this.voiceGain = voice;
        this.radioBandpass = bp;
        this.ambienceGain = amb;
        this.foleyGain = foley;
        this.scoreGain = score;

        this.initSubtleScoreBed(ctx, score);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended' && !this.paused) {
      void this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  private initSubtleScoreBed(ctx: AudioContext, scoreOut: GainNode): void {
    if (this.scoreStarted) return;
    this.scoreStarted = true;
    const now = ctx.currentTime;

    // Warm dark D-minor / fifth cinematic drone (D2 73.4Hz + A2 110Hz + soft detuned sub D1 36.7Hz)
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 210;
    lpf.Q.value = 1.1;

    // Slow breathing filter LFO so the score swells organically without ever fatiguing
    const filterLfo = ctx.createOscillator();
    filterLfo.type = 'sine';
    filterLfo.frequency.value = 0.14;
    const filterLfoGain = ctx.createGain();
    filterLfoGain.gain.value = 65;
    filterLfo.connect(filterLfoGain);
    filterLfoGain.connect(lpf.frequency);

    const oscSub = ctx.createOscillator();
    oscSub.type = 'sine';
    oscSub.frequency.value = 36.71;
    const gSub = ctx.createGain();
    gSub.gain.value = 0.38;

    const oscRoot = ctx.createOscillator();
    oscRoot.type = 'triangle';
    oscRoot.frequency.value = 73.42;
    const gRoot = ctx.createGain();
    gRoot.gain.value = 0.28;

    const oscFifth = ctx.createOscillator();
    oscFifth.type = 'triangle';
    oscFifth.frequency.value = 110.0;
    const gFifth = ctx.createGain();
    gFifth.gain.value = 0.16;

    // Subtle heartbeat low-end pulse (0.85 Hz)
    const pulseLfo = ctx.createOscillator();
    pulseLfo.type = 'sine';
    pulseLfo.frequency.value = 0.85;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.08;
    pulseLfo.connect(pulseDepth);
    pulseDepth.connect(gRoot.gain);

    oscSub.connect(gSub).connect(lpf);
    oscRoot.connect(gRoot).connect(lpf);
    oscFifth.connect(gFifth).connect(lpf);
    lpf.connect(scoreOut);

    oscSub.start(now);
    oscRoot.start(now);
    oscFifth.start(now);
    filterLfo.start(now);
    pulseLfo.start(now);

    this.scoreSources.push(oscSub, oscRoot, oscFifth, filterLfo, pulseLfo);
    this.scoreNodes.push(lpf, filterLfoGain, gSub, gRoot, gFifth, pulseDepth);
  }

  /**
   * Smoothly dials the subtle dark-military cinematic score bed (0 = silent, 1 = dramatic tension peak).
   */
  public setScoreIntensity(level01: number): void {
    const clamped = Math.max(0, Math.min(1, level01));
    if (Math.abs(clamped - this.scoreTargetLevel) < 0.02) return;
    this.scoreTargetLevel = clamped;
    const ctx = this.ensureContext();
    if (!ctx || !this.scoreGain) return;
    const now = ctx.currentTime;
    const targetGain = Math.max(0.0001, clamped * 0.24);
    this.scoreGain.gain.cancelScheduledValues(now);
    this.scoreGain.gain.setTargetAtTime(targetGain, now, 0.45);
  }

  public preloadCues(cues: readonly CinematicVoiceCue[]): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    for (const c of cues) {
      if (this.decodedCache.has(c.id)) continue;
      this.decodedCache.set(c.id, null);
      void this.fetchAndDecode(c, ctx);
    }
  }

  private async fetchAndDecode(cue: CinematicVoiceCue, ctx: AudioContext): Promise<void> {
    try {
      const res = await fetch(cue.audioUrl);
      if (!res.ok) return;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) return;
      const arr = await res.arrayBuffer();
      if (arr.byteLength < 64 || this.disposed) return;
      const decoded = await ctx.decodeAudioData(arr.slice(0));
      if (!this.disposed) {
        this.decodedCache.set(cue.id, decoded);
      }
    } catch {
      // Static WAV not baked yet — clean radio PTT squelch only (never harsh oscillator beeps)
    }
  }

  public playVoiceCue(cue: CinematicVoiceCue): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.voiceGain || this.paused) return;

    // Crisp tactical radio PTT click-in + brief mic static burst
    this.playRadioSquelch(ctx, 0.065, 0.16);

    const cached = this.decodedCache.get(cue.id);
    if (cached) {
      const src = ctx.createBufferSource();
      src.buffer = cached;
      src.connect(this.voiceGain);
      this.trackSource(src);
      src.start(ctx.currentTime + 0.06);
      src.onended = () => {
        this.activeSources.delete(src);
        if (!this.disposed && !this.paused && this.ctx) {
          this.playRadioSquelch(this.ctx, 0.045, 0.1);
        }
      };
    }
  }

  /**
   * Modulates APC diesel engine pitch/rumble during acceleration or deceleration (0 = idle, 1 = full rev).
   */
  public setVehicleThrottle(throttle01: number): void {
    if (!this.ctx || !this.apcEngineOsc || !this.apcFilterNode) return;
    const t = Math.max(0, Math.min(1, throttle01));
    const now = this.ctx.currentTime;
    this.apcEngineOsc.frequency.setTargetAtTime(48 + t * 38, now, 0.2);
    this.apcFilterNode.frequency.setTargetAtTime(125 + t * 145, now, 0.2);
  }

  public playDoorSlam(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    const now = ctx.currentTime;

    // Heavy armored steel thud + latch clack
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(108, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.16);
    g.gain.setValueAtTime(0.45, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    osc.connect(g).connect(this.foleyGain);
    this.trackSource(osc);
    osc.start(now);
    osc.stop(now + 0.2);

    const latch = ctx.createOscillator();
    const lg = ctx.createGain();
    latch.type = 'square';
    latch.frequency.setValueAtTime(640, now + 0.03);
    latch.frequency.exponentialRampToValueAtTime(260, now + 0.08);
    lg.gain.setValueAtTime(0.11, now + 0.03);
    lg.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    latch.connect(lg).connect(this.foleyGain);
    this.trackSource(latch);
    latch.start(now + 0.03);
    latch.stop(now + 0.095);
  }

  public playFootstep(surface: 'tarmac' | 'concrete' = 'tarmac'): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    const now = ctx.currentTime;

    const len = Math.floor(ctx.sampleRate * 0.065);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.8);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = surface === 'concrete' ? 520 : 380;
    filt.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    src.connect(filt).connect(g).connect(this.foleyGain);
    this.trackSource(src);
    src.start(now);
  }

  public playGunshot(isKillShot = false, isSquadmate = false): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    const now = ctx.currentTime;
    const scale = isSquadmate ? 0.65 : 1.0;

    // Punchy 5.56 supersonic crack + concrete corridor reverberant tail
    const bufferLen = Math.floor(ctx.sampleRate * 0.34);
    const noiseBuf = ctx.createBuffer(1, bufferLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < bufferLen; i++) {
      const u = i / bufferLen;
      const crack = u < 0.14 ? Math.pow(1 - u / 0.14, 1.5) : 0;
      const tail = Math.pow(1 - u, 3.2) * 0.32;
      data[i] = (Math.random() * 2 - 1) * (crack + tail);
    }

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isSquadmate ? 2100 : 3600, now);
    filter.frequency.exponentialRampToValueAtTime(280, now + 0.32);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * scale, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.33);
    noise.connect(filter).connect(g).connect(this.foleyGain);
    this.trackSource(noise);
    noise.start(now);

    // Chest-thumping bolt/chamber punch
    const punch = ctx.createOscillator();
    const punchGain = ctx.createGain();
    punch.type = 'triangle';
    punch.frequency.setValueAtTime(isSquadmate ? 130 : 165, now);
    punch.frequency.exponentialRampToValueAtTime(38, now + 0.09);
    punchGain.gain.setValueAtTime(0.42 * scale, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    punch.connect(punchGain).connect(this.foleyGain);
    this.trackSource(punch);
    punch.start(now);
    punch.stop(now + 0.11);

    // Metallic brass shell casing clink bouncing on concrete 0.24s later
    if (!isSquadmate) {
      const clink = ctx.createOscillator();
      const cg = ctx.createGain();
      clink.type = 'sine';
      clink.frequency.setValueAtTime(4200 + Math.random() * 600, now + 0.24);
      cg.gain.setValueAtTime(0.045, now + 0.24);
      cg.gain.exponentialRampToValueAtTime(0.0005, now + 0.3);
      clink.connect(cg).connect(this.foleyGain);
      this.trackSource(clink);
      clink.start(now + 0.24);
      clink.stop(now + 0.31);
    }

    // Tactile body impact thud on confirmed kill shots
    if (isKillShot) {
      const thud = ctx.createOscillator();
      const tg = ctx.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(92, now + 0.045);
      thud.frequency.exponentialRampToValueAtTime(32, now + 0.16);
      tg.gain.setValueAtTime(0.28, now + 0.045);
      tg.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
      thud.connect(tg).connect(this.foleyGain);
      this.trackSource(thud);
      thud.start(now + 0.045);
      thud.stop(now + 0.18);
    }
  }

  public setAmbience(kind: CinematicAmbienceKind): void {
    if (kind === this.ambienceKind) return;
    this.stopAmbience();
    this.ambienceKind = kind;
    if (kind === 'none') return;

    const ctx = this.ensureContext();
    if (!ctx || !this.ambienceGain) return;

    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.001, now);
    bus.gain.linearRampToValueAtTime(1.0, now + 0.6);
    bus.connect(this.ambienceGain);
    this.ambienceNodes.push(bus);

    if (kind === 'helicopter') {
      // Multi-layered twin-blade rotor chop + smooth jet turbine whine + open-bay wind rush
      const noise = this.createLoopNoise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 175;
      const rotorGain = ctx.createGain();
      rotorGain.gain.value = 0.52;

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 11.2;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.34;
      lfo.connect(lfoDepth);
      lfoDepth.connect(rotorGain.gain);

      const wind = this.createLoopNoise(ctx);
      const windBp = ctx.createBiquadFilter();
      windBp.type = 'bandpass';
      windBp.frequency.value = 620;
      windBp.Q.value = 1.1;
      const windGain = ctx.createGain();
      windGain.gain.value = 0.12;

      const turbine = ctx.createOscillator();
      turbine.type = 'triangle';
      turbine.frequency.value = 392;
      const turbFilter = ctx.createBiquadFilter();
      turbFilter.type = 'bandpass';
      turbFilter.frequency.value = 780;
      turbFilter.Q.value = 4.0;
      const turbGain = ctx.createGain();
      turbGain.gain.value = 0.045;

      noise.connect(lp).connect(rotorGain).connect(bus);
      wind.connect(windBp).connect(windGain).connect(bus);
      turbine.connect(turbFilter).connect(turbGain).connect(bus);

      noise.start(now);
      lfo.start(now);
      wind.start(now);
      turbine.start(now);
      this.ambienceSources.push(noise, lfo, wind, turbine);
      this.ambienceNodes.push(lp, rotorGain, lfoDepth, windBp, windGain, turbFilter, turbGain);
    } else if (kind === 'apc_diesel') {
      // Deep armored diesel V8 rumble + subtle tire/gravel roll
      const engine = ctx.createOscillator();
      engine.type = 'sawtooth';
      engine.frequency.value = 50;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 135;
      const eg = ctx.createGain();
      eg.gain.value = 0.32;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 13.5;
      const ld = ctx.createGain();
      ld.gain.value = 5.5;
      lfo.connect(ld);
      ld.connect(engine.frequency);

      const rumble = this.createLoopNoise(ctx);
      const rlp = ctx.createBiquadFilter();
      rlp.type = 'lowpass';
      rlp.frequency.value = 190;
      const rg = ctx.createGain();
      rg.gain.value = 0.18;

      engine.connect(lp).connect(eg).connect(bus);
      rumble.connect(rlp).connect(rg).connect(bus);

      engine.start(now);
      lfo.start(now);
      rumble.start(now);
      this.apcEngineOsc = engine;
      this.apcFilterNode = lp;
      this.ambienceSources.push(engine, lfo, rumble);
      this.ambienceNodes.push(lp, eg, ld, rlp, rg);
    } else if (kind === 'drone_wind' || kind === 'bunker_hum') {
      const noise = this.createLoopNoise(ctx);
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = kind === 'drone_wind' ? 380 : 115;
      filt.Q.value = kind === 'drone_wind' ? 1.2 : 2.6;
      const g = ctx.createGain();
      g.gain.value = kind === 'drone_wind' ? 0.24 : 0.15;
      noise.connect(filt).connect(g).connect(bus);
      noise.start(now);
      this.ambienceSources.push(noise);
      this.ambienceNodes.push(filt, g);
    }
  }

  private createLoopNoise(ctx: AudioContext): AudioBufferSourceNode {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      ch[i] = last * 2.8;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  private playRadioSquelch(ctx: AudioContext, dur: number, vol: number): void {
    if (!this.foleyGain) return;
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.sin((i / len) * Math.PI);
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1850;
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(bp).connect(g).connect(this.foleyGain);
    this.trackSource(src);
    src.start(now);
  }

  /** Deep distant artillery / mortar detonation thump with rolling low-pass valley echo. */
  public playDistantArtillery(intensity01 = 0.85): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    const lvl = Math.max(0.2, Math.min(1, intensity01));

    // Low sub-bass concussive thud
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(66, now);
    sub.frequency.exponentialRampToValueAtTime(22, now + 0.42);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.42 * lvl, now);
    subG.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    sub.connect(subG).connect(this.foleyGain);
    this.trackSource(sub);
    sub.start(now);
    sub.stop(now + 0.6);

    // Filtered low-end distant rumble & debris roll
    const dur = 1.15;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const u = i / len;
      const env = Math.pow(1 - u, 1.75) * (0.75 + 0.25 * Math.sin(u * 26));
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(340, now);
    lp.frequency.exponentialRampToValueAtTime(110, now + dur);
    const ng = ctx.createGain();
    ng.gain.value = 0.36 * lvl;
    noise.connect(lp).connect(ng).connect(this.foleyGain);
    this.trackSource(noise);
    noise.start(now);
  }

  /** Heavy 7.62mm helicopter pintle door-gunner shot with punchy low bark and metallic link clatter. */
  public playDoorGunnerBurst(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;

    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(135, now);
    thump.frequency.exponentialRampToValueAtTime(42, now + 0.085);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.32, now);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
    thump.connect(tg).connect(this.foleyGain);
    this.trackSource(thump);
    thump.start(now);
    thump.stop(now + 0.1);

    const len = Math.floor(ctx.sampleRate * 0.13);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.2);
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const crack = ctx.createBufferSource();
    crack.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 920;
    bp.Q.value = 0.7;
    const cg = ctx.createGain();
    cg.gain.value = 0.34;
    crack.connect(bp).connect(cg).connect(this.foleyGain);
    this.trackSource(crack);
    crack.start(now);
  }

  /** Distinct sharper incoming hostile AK/SMG muzzle report + supersonic crack in corridor firefights. */
  public playEnemyIncomingShot(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.foleyGain || this.paused) return;
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;

    const len = Math.floor(ctx.sampleRate * 0.16);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, 2.6);
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 1750;
    hp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = 0.24;
    src.connect(hp).connect(g).connect(this.foleyGain);
    this.trackSource(src);
    src.start(now);
  }

  private trackSource(src: AudioScheduledSourceNode): void {
    this.activeSources.add(src);
    src.onended = () => {
      this.activeSources.delete(src);
    };
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.ctx) return;
    if (paused) {
      if (this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => undefined);
      }
    } else if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  public stopAmbience(): void {
    for (const s of this.ambienceSources) {
      try {
        s.stop();
      } catch {
        // Already stopped
      }
      try {
        s.disconnect();
      } catch {
        // Ignore
      }
    }
    for (const n of this.ambienceNodes) {
      try {
        n.disconnect();
      } catch {
        // Ignore
      }
    }
    this.ambienceSources = [];
    this.ambienceNodes = [];
    this.apcEngineOsc = null;
    this.apcFilterNode = null;
    this.ambienceKind = 'none';
  }

  public stopAll(): void {
    this.stopAmbience();
    for (const s of this.scoreSources) {
      try {
        s.stop();
      } catch {
        // Ignore
      }
      try {
        s.disconnect();
      } catch {
        // Ignore
      }
    }
    for (const n of this.scoreNodes) {
      try {
        n.disconnect();
      } catch {
        // Ignore
      }
    }
    this.scoreSources = [];
    this.scoreNodes = [];
    this.scoreStarted = false;

    for (const s of this.activeSources) {
      try {
        s.stop();
      } catch {
        // Ignore
      }
    }
    this.activeSources.clear();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.unlockListenersBound && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.handleUserUnlock);
      window.removeEventListener('keydown', this.handleUserUnlock);
      this.unlockListenersBound = false;
    }
    this.stopAll();
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.masterGain = null;
    this.voiceGain = null;
    this.ambienceGain = null;
    this.foleyGain = null;
    this.scoreGain = null;
    this.radioBandpass = null;
    this.decodedCache.clear();
  }
}

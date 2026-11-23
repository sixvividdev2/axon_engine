import * as THREE from 'three';
import type { BodycamAudio } from '../../../../bodycam-sdk/BodycamAudio';
import type { OpenWorldBiomeId, OpenWorldWeatherId } from '../types';
import {
  createTerrainSample,
  createWaterProximitySample,
  queryWaterProximity,
  sampleOpenWorldTerrain,
} from './OpenWorldTerrain';

export type AmbienceSfxCueId =
  | 'wind_foliage_bed'
  | 'water_marsh_bed'
  | 'owl_hoot'
  | 'cricket_chirp'
  | 'frog_croak'
  | 'wolf_howl'
  | 'wolf_growl'
  | 'wolf_snarl'
  | 'deer_snort'
  | 'deer_hoofstep'
  | 'insect_squish'
  | 'field_harvest';

export type AmbienceSfxManifest = Record<AmbienceSfxCueId, string[]>;

/**
 * Drop-in Audio Manifest with automatic procedural Web Audio fallback.
 * Leave arrays empty for 100% zero-dependency procedural synthesis (zero 404s),
 * or drop real `.ogg` / `.mp3` paths (e.g. `/audio/wildlife/wolf_howl_01.ogg`)
 * into any cue slot via `registerAmbienceSfxOverrides()` to seamlessly override it.
 */
export const DEFAULT_AMBIENCE_SFX_MANIFEST: Readonly<AmbienceSfxManifest> = {
  wind_foliage_bed: [],
  water_marsh_bed: [],
  owl_hoot: [],
  cricket_chirp: [],
  frog_croak: [],
  wolf_howl: [],
  wolf_growl: [],
  wolf_snarl: [],
  deer_snort: [],
  deer_hoofstep: [],
  insect_squish: [],
  field_harvest: [],
};

export interface AmbienceFrameContext {
  dt: number;
  timeOfDayHours: number;
  nightFactor: number;
  weather: OpenWorldWeatherId;
  windSpeedMps: number;
  gust01: number;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerSpeedMps: number;
  biome: OpenWorldBiomeId;
  /** Optional canopy roost positions near player (world x, y, z triplets) */
  nearbyTreeRoosts?: ReadonlyArray<{ x: number; y: number; z: number }>;
}

export interface AmbienceAudioTelemetry {
  suppressedRemainingSec: number;
  waterBedWeight: number;
  windBedWeight: number;
  owlWindowActive: boolean;
  cricketWindowActive: boolean;
  activeCricketClusters: number;
  customCueLoadedCount: number;
}

interface CricketCluster {
  x: number;
  y: number;
  z: number;
  active: boolean;
  duckGain: number;
  nextChirpSec: number;
  basePitchHz: number;
}

// Zero-GC module scratch helpers
const _terrainScratch = createTerrainSample();
const _waterScratch = createWaterProximitySample();

/**
 * Computes whether a given hour (0..24) falls inside an overnight wrap window [startH..endH].
 */
export function isHourInWindow(hour: number, startH: number, endH: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  if (startH <= endH) {
    return h >= startH && h <= endH;
  }
  return h >= startH || h <= endH;
}

/**
 * Spatial Audio & Environmental Ambience Engine (`AmbienceAudioSystem`):
 * - Shares `BodycamAudio`'s Web Audio context, HRTF listener, chest-mic compression,
 *   and indoor/outdoor muffling state (zero extra AudioContext instances).
 * - Continuous procedural beds: Wind & Foliage (altitude + velocity + biome) and
 *   Water & Marsh (distance to river/marsh/estuary/reservoir).
 * - Virtual 3D point emitters for Owls (night conifer canopies, 30–90m) and
 *   Crickets (dusk/night grass clusters with smooth 3.5m proximity ducking).
 * - Strictly diegetic entity-bound emitters for physical Wolves, Deer, Frogs & Insect Squish.
 * - Full ballistic suppression (`onBallisticImpulse`) silencing ambient fauna within 120m for 15–30s.
 */
export class OpenWorldAmbienceAudio {
  private readonly bodycamAudio: BodycamAudio;
  private readonly manifest: AmbienceSfxManifest;
  private readonly customBuffers = new Map<AmbienceSfxCueId, AudioBuffer[]>();
  private readonly loadingCues = new Set<AmbienceSfxCueId>();

  // Shared audio graph state attached lazily once BodycamAudio unlocks AudioContext
  private graphReady = false;
  private ctx: AudioContext | null = null;
  private pinkNoiseBuffer: AudioBuffer | null = null;
  private brownNoiseBuffer: AudioBuffer | null = null;

  // Continuous Wind & Foliage Bed
  private foliageWindSrc: AudioBufferSourceNode | null = null;
  private foliageWindBp: BiquadFilterNode | null = null;
  private foliageWindLp: BiquadFilterNode | null = null;
  private foliageWindLfo: OscillatorNode | null = null;
  private foliageWindGain: GainNode | null = null;

  // Continuous Water & Marsh Bed
  private waterBedSrc: AudioBufferSourceNode | null = null;
  private waterBedBp: BiquadFilterNode | null = null;
  private waterBedLp: BiquadFilterNode | null = null;
  private waterBedLfo: OscillatorNode | null = null;
  private waterBedGain: GainNode | null = null;

  // Ballistic acoustic suppression (gunshots/explosions hush ambient fauna for 15–30s)
  private suppressedUntilSec = 0;
  private elapsedSec = 0;
  private lastBedPushSec = -1;
  private nextOwlHootSec = 6.5;

  // 6 grass/shrub cricket cluster slots around player
  private readonly cricketClusters: CricketCluster[] = [];
  private lastCricketAnchorX = 99999;
  private lastCricketAnchorZ = 99999;

  // Voice concurrency guards to keep Web Audio graph ultra-light (< 0.15ms)
  private activeOneShots = 0;
  private readonly maxConcurrentOneShots = 14;
  private lastWaterWeight = 0;
  private lastWindWeight = 0;
  private lastOwlActive = false;
  private lastCricketActive = false;
  private disposed = false;

  constructor(
    bodycamAudio: BodycamAudio,
    manifestOverrides?: Partial<AmbienceSfxManifest>,
  ) {
    this.bodycamAudio = bodycamAudio;
    this.manifest = {
      wind_foliage_bed: [...DEFAULT_AMBIENCE_SFX_MANIFEST.wind_foliage_bed],
      water_marsh_bed: [...DEFAULT_AMBIENCE_SFX_MANIFEST.water_marsh_bed],
      owl_hoot: [...DEFAULT_AMBIENCE_SFX_MANIFEST.owl_hoot],
      cricket_chirp: [...DEFAULT_AMBIENCE_SFX_MANIFEST.cricket_chirp],
      frog_croak: [...DEFAULT_AMBIENCE_SFX_MANIFEST.frog_croak],
      wolf_howl: [...DEFAULT_AMBIENCE_SFX_MANIFEST.wolf_howl],
      wolf_growl: [...DEFAULT_AMBIENCE_SFX_MANIFEST.wolf_growl],
      wolf_snarl: [...DEFAULT_AMBIENCE_SFX_MANIFEST.wolf_snarl],
      deer_snort: [...DEFAULT_AMBIENCE_SFX_MANIFEST.deer_snort],
      deer_hoofstep: [...DEFAULT_AMBIENCE_SFX_MANIFEST.deer_hoofstep],
      insect_squish: [...DEFAULT_AMBIENCE_SFX_MANIFEST.insect_squish],
      field_harvest: [...DEFAULT_AMBIENCE_SFX_MANIFEST.field_harvest],
    };

    if (manifestOverrides) {
      this.registerCustomAudioOverrides(manifestOverrides);
    }

    for (let i = 0; i < 6; i++) {
      this.cricketClusters.push({
        x: 0,
        y: 0,
        z: 0,
        active: false,
        duckGain: 1,
        nextChirpSec: 0.4 + i * 0.35,
        basePitchHz: 4150 + (i % 3) * 260,
      });
    }
  }

  /**
   * Registers custom `.ogg` / `.mp3` sample URLs for any ambience or wildlife cue.
   * Empty arrays keep procedural synthesis active; failed fetches fall back automatically.
   */
  public registerCustomAudioOverrides(overrides: Partial<AmbienceSfxManifest>): void {
    const keys = Object.keys(overrides) as AmbienceSfxCueId[];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const urls = overrides[k];
      if (!urls) continue;
      this.manifest[k] = urls.filter((u) => typeof u === 'string' && u.trim().length > 0);
      this.customBuffers.delete(k);
      this.loadingCues.delete(k);
    }
    if (this.graphReady) {
      this.preloadConfiguredCustomCues();
    }
  }

  public getManifestSnapshot(): Readonly<AmbienceSfxManifest> {
    return this.manifest;
  }

  /**
   * Hook into weapon fire / explosion event bus:
   * Immediately silences crickets, frogs, and owls within 120m for 15–30 seconds.
   */
  public onBallisticImpulse(
    originX: number,
    originZ: number,
    decibels: number,
    listenerX?: number,
    listenerZ?: number,
  ): boolean {
    const bus = this.bodycamAudio.getExternalAudioBus();
    const lx = listenerX ?? bus?.listenerPos.x ?? originX;
    const lz = listenerZ ?? bus?.listenerPos.z ?? originZ;
    const dist = Math.hypot(originX - lx, originZ - lz);
    const effectiveRadius = decibels >= 145 ? 120 : decibels >= 120 ? 75 : 42;
    if (dist > effectiveRadius) return false;

    const prox = Math.max(0, 1 - dist / effectiveRadius);
    const dbNorm = THREE.MathUtils.clamp((decibels - 105) / 60, 0.25, 1.0);
    const silenceDurationSec = 15 + 15 * prox * dbNorm; // 15s .. 30s
    this.suppressedUntilSec = Math.max(this.suppressedUntilSec, this.elapsedSec + silenceDurationSec);
    return true;
  }

  public isFaunaSuppressed(): boolean {
    return this.elapsedSec < this.suppressedUntilSec;
  }

  public getSuppressedRemainingSec(): number {
    return Math.max(0, this.suppressedUntilSec - this.elapsedSec);
  }

  public getTelemetry(): AmbienceAudioTelemetry {
    let activeCrickets = 0;
    for (let i = 0; i < this.cricketClusters.length; i++) {
      if (this.cricketClusters[i].active && this.cricketClusters[i].duckGain > 0.1) {
        activeCrickets++;
      }
    }
    return {
      suppressedRemainingSec: this.getSuppressedRemainingSec(),
      waterBedWeight: this.lastWaterWeight,
      windBedWeight: this.lastWindWeight,
      owlWindowActive: this.lastOwlActive,
      cricketWindowActive: this.lastCricketActive,
      activeCricketClusters: activeCrickets,
      customCueLoadedCount: this.customBuffers.size,
    };
  }

  private ensureGraphAttached(): boolean {
    if (this.disposed) return false;
    if (this.graphReady && this.ctx && this.ctx.state !== 'closed') return true;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return false;

    const ctx = bus.ctx;
    this.ctx = ctx;
    this.pinkNoiseBuffer = this.createPinkNoiseBuffer(ctx, 4.0);
    this.brownNoiseBuffer = this.createBrownNoiseBuffer(ctx, 4.0);

    // 1. Continuous Foliage Wind Bed (filtered pink noise + gentle LFO)
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = this.pinkNoiseBuffer;
    wSrc.loop = true;

    const wBp = ctx.createBiquadFilter();
    wBp.type = 'bandpass';
    wBp.frequency.value = 620;
    wBp.Q.value = 0.85;

    const wLp = ctx.createBiquadFilter();
    wLp.type = 'lowpass';
    wLp.frequency.value = 1850;

    const wLfo = ctx.createOscillator();
    wLfo.type = 'sine';
    wLfo.frequency.value = 0.19;
    const wLfoGain = ctx.createGain();
    wLfoGain.gain.value = 160;
    wLfo.connect(wLfoGain);
    wLfoGain.connect(wBp.frequency);
    wLfo.start();

    const wGain = ctx.createGain();
    wGain.gain.value = 0.0001;

    wSrc.connect(wBp);
    wBp.connect(wLp);
    wLp.connect(wGain);
    wGain.connect(bus.dryBus);
    wSrc.start();

    this.foliageWindSrc = wSrc;
    this.foliageWindBp = wBp;
    this.foliageWindLp = wLp;
    this.foliageWindLfo = wLfo;
    this.foliageWindGain = wGain;

    // 2. Continuous Water / Marsh Bed (filtered brown noise + wave/current ripple LFO)
    const mSrc = ctx.createBufferSource();
    mSrc.buffer = this.brownNoiseBuffer;
    mSrc.loop = true;

    const mBp = ctx.createBiquadFilter();
    mBp.type = 'bandpass';
    mBp.frequency.value = 390;
    mBp.Q.value = 0.65;

    const mLp = ctx.createBiquadFilter();
    mLp.type = 'lowpass';
    mLp.frequency.value = 1150;

    const mLfo = ctx.createOscillator();
    mLfo.type = 'sine';
    mLfo.frequency.value = 0.27;
    const mLfoGain = ctx.createGain();
    mLfoGain.gain.value = 95;
    mLfo.connect(mLfoGain);
    mLfoGain.connect(mBp.frequency);
    mLfo.start();

    const mGain = ctx.createGain();
    mGain.gain.value = 0.0001;

    mSrc.connect(mBp);
    mBp.connect(mLp);
    mLp.connect(mGain);
    mGain.connect(bus.dryBus);
    mSrc.start(0, 1.1);

    this.waterBedSrc = mSrc;
    this.waterBedBp = mBp;
    this.waterBedLp = mLp;
    this.waterBedLfo = mLfo;
    this.waterBedGain = mGain;

    this.graphReady = true;
    this.preloadConfiguredCustomCues();
    return true;
  }

  private preloadConfiguredCustomCues(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const cueIds = Object.keys(this.manifest) as AmbienceSfxCueId[];
    for (let i = 0; i < cueIds.length; i++) {
      const cueId = cueIds[i];
      const urls = this.manifest[cueId];
      if (!urls || urls.length === 0 || this.loadingCues.has(cueId) || this.customBuffers.has(cueId)) {
        continue;
      }
      this.loadingCues.add(cueId);
      void Promise.all(
        urls.map(async (url) => {
          try {
            const res = await fetch(url);
            if (!res.ok) return null;
            const arr = await res.arrayBuffer();
            return await ctx.decodeAudioData(arr);
          } catch {
            return null;
          }
        }),
      ).then((decoded) => {
        if (this.disposed) return;
        const valid = decoded.filter((b): b is AudioBuffer => b !== null);
        if (valid.length > 0) {
          this.customBuffers.set(cueId, valid);
        }
      });
    }
  }

  private createPinkNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    // Paul Kellet refined pink noise filter
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.065;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  private createBrownNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const out = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.024 * white) / 1.024;
      out[i] = Math.max(-1, Math.min(1, last * 3.1));
    }
    return buffer;
  }

  /**
   * Advances ambience beds, virtual night owls, and grass-anchored cricket clusters.
   * Zero per-frame heap allocations in the hot update loop.
   */
  public update(frame: AmbienceFrameContext): void {
    const dt = Math.min(0.1, Math.max(0, frame.dt));
    this.elapsedSec += dt;

    const owlWindow = isHourInWindow(frame.timeOfDayHours, 21.0, 5.0);
    const cricketWindow = isHourInWindow(frame.timeOfDayHours, 19.5, 6.0);
    this.lastOwlActive = owlWindow;
    this.lastCricketActive = cricketWindow;

    // Evaluate water proximity & wind modulation regardless of whether AudioContext is unlocked yet
    queryWaterProximity(frame.playerX, frame.playerZ, frame.playerY - 1.5, _waterScratch);
    const altitudeNorm = THREE.MathUtils.clamp(frame.playerY / 380, 0, 1);
    const velocityNorm = THREE.MathUtils.clamp(frame.playerSpeedMps / 7.5, 0, 1);
    const windSpeedNorm = THREE.MathUtils.clamp((frame.windSpeedMps - 1.0) / 18.0, 0, 1);
    const forestFoliageFactor =
      frame.biome === 'temperate_conifer_valley'
        ? 1.0
        : frame.biome === 'coastal_port_marsh'
          ? 0.72
          : frame.biome === 'highland_steppe_quarry'
            ? 0.58
            : 0.85;

    const windBedWeight = THREE.MathUtils.clamp(
      (0.18 + windSpeedNorm * 0.55 + altitudeNorm * 0.35 + frame.gust01 * 0.25 + velocityNorm * 0.16) *
        forestFoliageFactor,
      0,
      1,
    );
    this.lastWindWeight = windBedWeight;
    this.lastWaterWeight = _waterScratch.waterAudioWeight;

    // Refresh cricket cluster anchors when operator moves > 16m
    if (
      Math.hypot(
        frame.playerX - this.lastCricketAnchorX,
        frame.playerZ - this.lastCricketAnchorZ,
      ) > 16
    ) {
      this.refreshCricketClusters(frame.playerX, frame.playerZ);
    }

    // Update proximity ducking smoothly on every cricket cluster (< 3.5m moving player -> ducks to 0)
    const movingFactor = frame.playerSpeedMps > 0.35 ? 1.0 : 0.35;
    const duckLerp = 1 - Math.exp(-dt * 4.5);
    for (let i = 0; i < this.cricketClusters.length; i++) {
      const c = this.cricketClusters[i];
      if (!c.active) {
        c.duckGain = 0;
        continue;
      }
      const dist = Math.hypot(c.x - frame.playerX, c.z - frame.playerZ);
      const targetDuck =
        dist < 3.5 ? (1 - movingFactor) * 0.18 : THREE.MathUtils.clamp((dist - 3.5) / 4.5, 0, 1);
      c.duckGain += (targetDuck - c.duckGain) * duckLerp;
    }

    if (!this.ensureGraphAttached() || !this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;

    const nowAudio = this.ctx.currentTime;
    const indoorScale = bus.isIndoor ? 0.2 : 1.0;

    // 1. Update continuous procedural beds at ~10 Hz (avoids Web Audio automation queue churn)
    if (this.lastBedPushSec < 0 || this.elapsedSec - this.lastBedPushSec >= 0.1) {
      this.lastBedPushSec = this.elapsedSec;

      if (this.foliageWindGain && this.foliageWindBp && this.foliageWindLp) {
        const targetWindGain = (0.006 + windBedWeight * 0.044) * indoorScale;
        const bpFreq = 380 + altitudeNorm * 520 + velocityNorm * 240 + frame.gust01 * 210;
        const lpFreq = 1100 + altitudeNorm * 1400 + windSpeedNorm * 900;
        this.foliageWindGain.gain.setTargetAtTime(targetWindGain, nowAudio, 0.22);
        this.foliageWindBp.frequency.setTargetAtTime(bpFreq, nowAudio, 0.25);
        this.foliageWindLp.frequency.setTargetAtTime(bus.isIndoor ? lpFreq * 0.45 : lpFreq, nowAudio, 0.25);
      }

      if (this.waterBedGain && this.waterBedBp && this.waterBedLp) {
        const wWeight = _waterScratch.waterAudioWeight;
        const waterKindGain =
          _waterScratch.waterKind === 'river'
            ? 0.052
            : _waterScratch.waterKind === 'coast'
              ? 0.046
              : _waterScratch.waterKind === 'marsh'
                ? 0.032
                : 0.028;
        const targetWaterGain = (0.0001 + wWeight * wWeight * waterKindGain) * indoorScale;
        const waterBpFreq = _waterScratch.waterKind === 'river' ? 520 : _waterScratch.waterKind === 'coast' ? 280 : 360;
        this.waterBedGain.gain.setTargetAtTime(targetWaterGain, nowAudio, 0.24);
        this.waterBedBp.frequency.setTargetAtTime(waterBpFreq, nowAudio, 0.25);
        this.waterBedLp.frequency.setTargetAtTime(bus.isIndoor ? 620 : 1280, nowAudio, 0.25);
      }
    }

    // 2. Acoustic suppression gate (gunshots/explosions hush owls & crickets for 15–30s)
    if (this.isFaunaSuppressed()) {
      return;
    }

    // Heavy mountain rain suppresses insects & owls naturally
    const rainSuppress = frame.weather === 'mountain_rain';

    // 3. Virtual Night Owls (21:00–05:00, Temperate Conifer canopy roosts 30–90m away, y + 8..15m)
    if (owlWindow && !rainSuppress && frame.biome === 'temperate_conifer_valley') {
      if (this.elapsedSec >= this.nextOwlHootSec) {
        this.nextOwlHootSec = this.elapsedSec + 11.0 + Math.random() * 17.0;
        const roost = this.pickOwlRoostPosition(frame);
        if (roost) {
          this.playOwlHootAt(roost.x, roost.y, roost.z, bus.isIndoor);
        }
      }
    }

    // 4. Grass/Shrub Cricket Clusters (19:30–06:00, proximity ducking inside 3.5m)
    if (cricketWindow && !rainSuppress) {
      for (let i = 0; i < this.cricketClusters.length; i++) {
        const c = this.cricketClusters[i];
        if (!c.active || c.duckGain < 0.08) continue;
        if (this.elapsedSec >= c.nextChirpSec) {
          c.nextChirpSec = this.elapsedSec + 1.15 + Math.random() * 2.1;
          this.playCricketChirpAt(c.x, c.y, c.z, c.basePitchHz, c.duckGain * indoorScale);
        }
      }
    }
  }

  private refreshCricketClusters(playerX: number, playerZ: number): void {
    this.lastCricketAnchorX = playerX;
    this.lastCricketAnchorZ = playerZ;
    for (let i = 0; i < this.cricketClusters.length; i++) {
      const c = this.cricketClusters[i];
      const angle = (i / this.cricketClusters.length) * Math.PI * 2 + Math.random() * 0.7;
      const dist = 7.5 + (i % 3) * 7.5 + Math.random() * 5.0;
      const wx = playerX + Math.cos(angle) * dist;
      const wz = playerZ + Math.sin(angle) * dist;
      sampleOpenWorldTerrain(wx, wz, _terrainScratch);
      const validGrassCell =
        !_terrainScratch.isWater &&
        !_terrainScratch.isRoad &&
        !_terrainScratch.isSitePad &&
        !_terrainScratch.isQuarryPit &&
        _terrainScratch.height < 275;
      c.active = validGrassCell;
      c.x = wx;
      c.y = _terrainScratch.height + 0.35;
      c.z = wz;
      c.nextChirpSec = this.elapsedSec + 0.3 + Math.random() * 1.8;
    }
  }

  private pickOwlRoostPosition(
    frame: AmbienceFrameContext,
  ): { x: number; y: number; z: number } | null {
    if (frame.nearbyTreeRoosts && frame.nearbyTreeRoosts.length > 0) {
      // Pick a canopy roost within 30m..90m
      let attempts = Math.min(8, frame.nearbyTreeRoosts.length);
      while (attempts-- > 0) {
        const idx = Math.floor(Math.random() * frame.nearbyTreeRoosts.length);
        const r = frame.nearbyTreeRoosts[idx];
        const d = Math.hypot(r.x - frame.playerX, r.z - frame.playerZ);
        if (d >= 30 && d <= 92) {
          return { x: r.x, y: r.y + 8 + Math.random() * 7, z: r.z };
        }
      }
    }
    // Fallback deterministic forest canopy point in 35m..85m ring
    const angle = Math.random() * Math.PI * 2;
    const dist = 35 + Math.random() * 50;
    const wx = frame.playerX + Math.cos(angle) * dist;
    const wz = frame.playerZ + Math.sin(angle) * dist;
    sampleOpenWorldTerrain(wx, wz, _terrainScratch);
    if (_terrainScratch.biome !== 'temperate_conifer_valley' || _terrainScratch.isWater) {
      return null;
    }
    return { x: wx, y: _terrainScratch.height + 9.5 + Math.random() * 5.5, z: wz };
  }

  private createSpatialPanner(
    x: number,
    y: number,
    z: number,
    refDist: number,
    maxDist: number,
    rolloff = 1.15,
  ): PannerNode | null {
    if (!this.ctx) return null;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDist;
    panner.maxDistance = maxDist;
    panner.rolloffFactor = rolloff;
    const t = this.ctx.currentTime;
    panner.positionX.setValueAtTime(x, t);
    panner.positionY.setValueAtTime(y, t);
    panner.positionZ.setValueAtTime(z, t);
    return panner;
  }

  private tryPlayCustomBuffer(
    cueId: AmbienceSfxCueId,
    x: number,
    y: number,
    z: number,
    gainLevel: number,
    refDist: number,
    maxDist: number,
    playbackRate = 1.0,
    sendWet = true,
  ): boolean {
    const buffers = this.customBuffers.get(cueId);
    if (!buffers || buffers.length === 0 || !this.ctx) return false;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return false;
    if (this.activeOneShots >= this.maxConcurrentOneShots) return true;

    const ctx = this.ctx;
    const buf = buffers[Math.floor(Math.random() * buffers.length)];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;

    const g = ctx.createGain();
    g.gain.value = gainLevel;

    const panner = this.createSpatialPanner(x, y, z, refDist, maxDist);
    if (!panner) return false;

    src.connect(g);
    g.connect(panner);
    panner.connect(bus.dryBus);
    if (sendWet && bus.wetBus) panner.connect(bus.wetBus);
    if (bus.isIndoor && bus.interiorWetBus) panner.connect(bus.interiorWetBus);

    this.activeOneShots++;
    src.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
    src.start();
    return true;
  }

  /**
   * Night canopy owl multi-syllable hoot ("hoo · hoo-hoooo") with distance low-pass attenuation.
   */
  private playOwlHootAt(x: number, y: number, z: number, isIndoor: boolean): void {
    if (!this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 110) return;

    const amp = (isIndoor ? 0.35 : 0.85) * THREE.MathUtils.clamp(1.15 - dist / 110, 0.25, 1.0);
    if (this.tryPlayCustomBuffer('owl_hoot', x, y, z, amp * 0.65, 8, 120, 0.94 + Math.random() * 0.12)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 8.0, 125, 1.05);
    if (!panner) return;

    // Distance low-pass attenuation (far canopy hoots sound softer & warmer)
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = THREE.MathUtils.lerp(1450, 520, THREE.MathUtils.clamp(dist / 95, 0, 1));

    lp.connect(panner);
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    const baseHz = 355 + Math.random() * 55;
    // 3-syllable Great Horned / Tawny Owl rhythm
    const syllables = [
      { offset: 0.0, dur: 0.24, pitch: 1.0, peak: 0.14 },
      { offset: 0.38, dur: 0.18, pitch: 1.04, peak: 0.12 },
      { offset: 0.66, dur: 0.54, pitch: 0.93, peak: 0.15 },
    ];

    this.activeOneShots++;
    let lastOsc: OscillatorNode | null = null;
    for (let i = 0; i < syllables.length; i++) {
      const s = syllables[i];
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const st = t + s.offset;
      osc.frequency.setValueAtTime(baseHz * s.pitch * 0.96, st);
      osc.frequency.linearRampToValueAtTime(baseHz * s.pitch, st + s.dur * 0.28);
      osc.frequency.exponentialRampToValueAtTime(baseHz * s.pitch * 0.87, st + s.dur);

      // Gentle breath harmonic
      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(baseHz * s.pitch * 2.0, st);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0005, st);
      g.gain.linearRampToValueAtTime(s.peak * amp, st + s.dur * 0.22);
      g.gain.exponentialRampToValueAtTime(0.0008, st + s.dur);

      const g2 = ctx.createGain();
      g2.gain.value = 0.09;

      osc.connect(g);
      osc2.connect(g2);
      g2.connect(g);
      g.connect(lp);

      osc.start(st);
      osc2.start(st);
      osc.stop(st + s.dur + 0.03);
      osc2.stop(st + s.dur + 0.03);
      lastOsc = osc;
    }

    if (lastOsc) {
      lastOsc.onended = () => {
        this.activeOneShots = Math.max(0, this.activeOneShots - 1);
        try {
          lp.disconnect();
          panner.disconnect();
        } catch {
          // already disconnected
        }
      };
    }
  }

  /**
   * Spatialized grass-cluster cricket stridulation (4-pulse harmonic chirp).
   */
  private playCricketChirpAt(
    x: number,
    y: number,
    z: number,
    baseHz: number,
    gainScale: number,
  ): void {
    if (!this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    if (
      this.tryPlayCustomBuffer(
        'cricket_chirp',
        x,
        y,
        z,
        gainScale * 0.14,
        2.5,
        36,
        0.95 + Math.random() * 0.1,
        false,
      )
    ) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 2.5, 36, 1.35);
    if (!panner) return;
    panner.connect(bus.dryBus);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f = baseHz * (0.97 + Math.random() * 0.06);
    osc.frequency.setValueAtTime(f, t);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    const pulses = 3 + (Math.random() > 0.5 ? 1 : 0);
    const peak = 0.034 * gainScale;
    for (let p = 0; p < pulses; p++) {
      const ps = t + p * 0.052;
      env.gain.setValueAtTime(0.0001, ps);
      env.gain.linearRampToValueAtTime(peak, ps + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0002, ps + 0.036);
    }

    osc.connect(env);
    env.connect(panner);
    this.activeOneShots++;
    osc.start(t);
    osc.stop(t + pulses * 0.052 + 0.02);
    osc.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  // ============================================================================
  // DIEGETIC ENTITY-ANCHORED FAUNA AUDIO (ZERO FAKE EMITTERS)
  // ============================================================================

  /**
   * Diegetic 3D frog ribbit/croak emitted strictly from a physical FrogEntity position.
   */
  public playFrogCroak(x: number, y: number, z: number, pitchScale = 1.0): void {
    if (this.isFaunaSuppressed()) return;
    if (!this.ensureGraphAttached() || !this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 42) return;

    const amp = bus.isIndoor ? 0.25 : 0.9;
    if (this.tryPlayCustomBuffer('frog_croak', x, y, z, amp * 0.45, 2.2, 42, pitchScale)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 2.0, 42, 1.25);
    if (!panner) return;
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    // Sawtooth vocal sac pulse train through resonant formant bandpass ("rrrib-bit")
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const f0 = 155 * pitchScale;
    osc.frequency.setValueAtTime(f0 * 0.85, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.45, t + 0.11);
    osc.frequency.setValueAtTime(f0 * 0.92, t + 0.14);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.65, t + 0.25);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(480 * pitchScale, t);
    bp.frequency.exponentialRampToValueAtTime(980 * pitchScale, t + 0.24);
    bp.Q.value = 4.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0005, t);
    g.gain.linearRampToValueAtTime(0.11 * amp, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.004, t + 0.12);
    g.gain.linearRampToValueAtTime(0.13 * amp, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.29);

    osc.connect(bp);
    bp.connect(g);
    g.connect(panner);

    this.activeOneShots++;
    osc.start(t);
    osc.stop(t + 0.31);
    osc.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Diegetic 3D wolf howl emitted strictly from a physical WolfEntity head transform (synced to head tilt).
   */
  public playWolfHowl(x: number, y: number, z: number, isAlpha = true): void {
    if (!this.ensureGraphAttached() || !this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 260) return;

    const amp = bus.isIndoor ? 0.38 : 1.0;
    const rate = isAlpha ? 0.9 + Math.random() * 0.08 : 1.08 + Math.random() * 0.14;
    if (this.tryPlayCustomBuffer('wolf_howl', x, y, z, amp * 0.85, 14, 260, rate, true)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = isAlpha ? 2.65 : 2.1;
    const panner = this.createSpatialPanner(x, y, z, 14.0, 260, 0.92);
    if (!panner) return;
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    // Dual detuned formant oscillators + vibrato + breathy noise
    const baseHz = (isAlpha ? 248 : 305) * (0.94 + Math.random() * 0.12);
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(baseHz * 0.72, t);
    osc1.frequency.exponentialRampToValueAtTime(baseHz * 1.38, t + 0.42);
    osc1.frequency.linearRampToValueAtTime(baseHz * 1.44, t + dur * 0.62);
    osc1.frequency.exponentialRampToValueAtTime(baseHz * 0.86, t + dur);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseHz * 1.44, t);
    osc2.frequency.exponentialRampToValueAtTime(baseHz * 2.75, t + 0.44);
    osc2.frequency.exponentialRampToValueAtTime(baseHz * 1.72, t + dur);

    const vib = ctx.createOscillator();
    vib.frequency.value = 5.4;
    const vibG = ctx.createGain();
    vibG.gain.value = 7.5;
    vib.connect(vibG);
    vibG.connect(osc1.frequency);

    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.setValueAtTime(480, t);
    formant.frequency.linearRampToValueAtTime(860, t + 0.55);
    formant.frequency.linearRampToValueAtTime(540, t + dur);
    formant.Q.value = 3.6;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = THREE.MathUtils.lerp(2200, 720, THREE.MathUtils.clamp(dist / 220, 0, 1));

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0005, t);
    env.gain.linearRampToValueAtTime(0.24 * amp, t + 0.36);
    env.gain.linearRampToValueAtTime(0.20 * amp, t + dur * 0.72);
    env.gain.exponentialRampToValueAtTime(0.0006, t + dur);

    const osc2G = ctx.createGain();
    osc2G.gain.value = 0.28;

    osc1.connect(formant);
    osc2.connect(osc2G);
    osc2G.connect(formant);
    formant.connect(lp);
    lp.connect(env);
    env.connect(panner);

    this.activeOneShots++;
    osc1.start(t);
    osc2.start(t);
    vib.start(t);
    osc1.stop(t + dur + 0.05);
    osc2.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);

    osc1.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Diegetic 3D wolf low chest growl (within ~15m during stalking/encircling/pack tension).
   */
  public playWolfGrowl(x: number, y: number, z: number, intensity = 0.85): void {
    if (!this.ensureGraphAttached() || !this.ctx) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 34) return;

    const amp = THREE.MathUtils.clamp(intensity, 0.3, 1.3) * (bus.isIndoor ? 0.45 : 1.0);
    if (this.tryPlayCustomBuffer('wolf_growl', x, y, z, amp * 0.65, 2.5, 34, 0.92 + Math.random() * 0.16)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.68 + Math.random() * 0.25;
    const panner = this.createSpatialPanner(x, y, z, 2.4, 36, 1.15);
    if (!panner) return;
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    // Guttural low sawtooth AM-modulated by 26 Hz vocal fold rattle
    const carrier = ctx.createOscillator();
    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(78 + Math.random() * 18, t);
    carrier.frequency.linearRampToValueAtTime(64, t + dur);

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = 25 + Math.random() * 7;
    const modGain = ctx.createGain();
    modGain.gain.value = 22;
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 220;
    bp.Q.value = 2.1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0005, t);
    g.gain.linearRampToValueAtTime(0.22 * amp, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    carrier.connect(bp);
    bp.connect(g);
    g.connect(panner);

    this.activeOneShots++;
    carrier.start(t);
    mod.start(t);
    carrier.stop(t + dur + 0.03);
    mod.stop(t + dur + 0.03);
    carrier.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Diegetic 3D wolf lunge snarl / jaw snap.
   */
  public playWolfSnarl(x: number, y: number, z: number): void {
    if (!this.ensureGraphAttached() || !this.ctx || !this.pinkNoiseBuffer) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 45) return;

    if (this.tryPlayCustomBuffer('wolf_snarl', x, y, z, 0.85, 2.5, 45, 0.94 + Math.random() * 0.12)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 2.5, 48, 1.05);
    if (!panner) return;
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    // Sharp aggressive bark-snarl burst + raspy exhale
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(290, t);
    osc.frequency.exponentialRampToValueAtTime(115, t + 0.24);

    const noise = ctx.createBufferSource();
    noise.buffer = this.pinkNoiseBuffer;
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 1150;
    nBp.Q.value = 1.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);

    osc.connect(g);
    noise.connect(nBp);
    nBp.connect(g);
    g.connect(panner);

    this.activeOneShots++;
    osc.start(t);
    osc.stop(t + 0.36);
    noise.start(t, Math.random() * 1.5, 0.36);
    osc.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Diegetic 3D deer alert snort / alarm blow when startled into bolting.
   */
  public playDeerSnort(x: number, y: number, z: number): void {
    if (!this.ensureGraphAttached() || !this.ctx || !this.pinkNoiseBuffer) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 70) return;

    if (this.tryPlayCustomBuffer('deer_snort', x, y, z, 0.55, 3.5, 70, 0.94 + Math.random() * 0.12)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 3.5, 72, 1.15);
    if (!panner) return;
    panner.connect(bus.dryBus);
    if (bus.wetBus) panner.connect(bus.wetBus);

    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1650, t);
    bp.frequency.exponentialRampToValueAtTime(740, t + 0.22);
    bp.Q.value = 2.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);

    src.connect(bp);
    bp.connect(g);
    g.connect(panner);

    this.activeOneShots++;
    src.start(t, Math.random() * 2.0, 0.28);
    src.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Subtle 3D deer bounding hoof-step thud.
   */
  public playDeerHoofstep(x: number, y: number, z: number, speedMps: number): void {
    if (!this.ensureGraphAttached() || !this.ctx || !this.pinkNoiseBuffer) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    const dist = Math.hypot(x - bus.listenerPos.x, z - bus.listenerPos.z);
    if (dist > 45) return;

    if (this.tryPlayCustomBuffer('deer_hoofstep', x, y, z, 0.32, 2.0, 45, 0.9 + Math.random() * 0.2, false)) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const panner = this.createSpatialPanner(x, y, z, 2.0, 45, 1.3);
    if (!panner) return;
    panner.connect(bus.dryBus);

    const amp = THREE.MathUtils.clamp(speedMps / 9.5, 0.3, 1.0);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(118 + Math.random() * 26, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.065);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.11 * amp, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.075);

    osc.connect(g);
    g.connect(panner);
    this.activeOneShots++;
    osc.start(t);
    osc.stop(t + 0.085);
    osc.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        panner.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Subtle boot-sole chitin crunch when stepping directly on a spider or ant (< 0.22m).
   */
  public playInsectSquish(x: number, y: number, z: number, isSpider: boolean): void {
    if (!this.ensureGraphAttached() || !this.ctx || !this.pinkNoiseBuffer) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;

    if (
      this.tryPlayCustomBuffer(
        'insect_squish',
        x,
        y,
        z,
        isSpider ? 0.36 : 0.22,
        1.0,
        8.0,
        isSpider ? 0.9 : 1.25,
        false,
      )
    ) {
      return;
    }
    if (this.activeOneShots >= this.maxConcurrentOneShots) return;

    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoiseBuffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.setValueAtTime(isSpider ? 2450 : 3400, t);
    hp.frequency.exponentialRampToValueAtTime(isSpider ? 1100 : 1800, t + 0.048);
    hp.Q.value = 2.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(isSpider ? 0.14 : 0.085, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.055);

    src.connect(hp);
    hp.connect(g);
    g.connect(bus.dryBus);

    this.activeOneShots++;
    src.start(t, Math.random() * 2.0, 0.065);
    src.onended = () => {
      this.activeOneShots = Math.max(0, this.activeOneShots - 1);
      try {
        g.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  /**
   * Tactile field-dressing knife/fabric foley when harvesting a downed wolf or deer.
   */
  public playFieldHarvest(x: number, y: number, z: number): void {
    if (!this.ensureGraphAttached() || !this.ctx || !this.pinkNoiseBuffer) return;
    const bus = this.bodycamAudio.getExternalAudioBus();
    if (!bus) return;
    if (this.tryPlayCustomBuffer('field_harvest', x, y, z, 0.55, 1.5, 16, 1.0, false)) {
      return;
    }
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const delay = i * 0.12;
      const src = ctx.createBufferSource();
      src.buffer = this.pinkNoiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1450 + i * 520, t + delay);
      bp.frequency.exponentialRampToValueAtTime(640, t + delay + 0.1);
      bp.Q.value = 1.9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t + delay);
      g.gain.linearRampToValueAtTime(0.16, t + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.11);
      src.connect(bp);
      bp.connect(g);
      g.connect(bus.dryBus);
      src.start(t + delay, Math.random() * 2.0, 0.13);
    }
  }

  public dispose(): void {
    this.disposed = true;
    try {
      this.foliageWindSrc?.stop();
      this.foliageWindLfo?.stop();
      this.waterBedSrc?.stop();
      this.waterBedLfo?.stop();
    } catch {
      // already stopped
    }
    try {
      this.foliageWindGain?.disconnect();
      this.waterBedGain?.disconnect();
    } catch {
      // already disconnected
    }
    this.foliageWindSrc = null;
    this.foliageWindLfo = null;
    this.foliageWindGain = null;
    this.waterBedSrc = null;
    this.waterBedLfo = null;
    this.waterBedGain = null;
    this.customBuffers.clear();
    this.loadingCues.clear();
    this.graphReady = false;
    this.ctx = null;
  }
}

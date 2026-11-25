export type GraphicsQualityId = 'performance' | 'balanced' | 'high' | 'ultra';

export interface GraphicsQualityProfile {
  id: GraphicsQualityId;
  label: string;
  shortLabel: string;
  description: string;
  maxDpr: number;
  /** Balanced WebGL2 pixel ratio cap for the 4km Open World theater to prevent HiDPI fragment bottlenecks */
  openWorldMaxDpr: number;
  antialias: boolean;
  castShadows: boolean;
  shadowMapSize: number;
  foliageDensity: number;
  microDetailDensity: number;
  maxAccentLights: number;
  fogDensityScale: number;
  envIntensityScale: number;
  anisotropyCap: number;
}

export const GRAPHICS_QUALITY_ORDER: readonly GraphicsQualityId[] = [
  'performance',
  'balanced',
  'high',
  'ultra',
];

export const GRAPHICS_QUALITY_PROFILES: Record<GraphicsQualityId, GraphicsQualityProfile> = {
  performance: {
    id: 'performance',
    label: 'Performance',
    shortLabel: 'PERF',
    description: 'Peak framerate · Lighter foliage & micro-props, shadows disabled',
    maxDpr: 1.0,
    openWorldMaxDpr: 1.0,
    antialias: false,
    castShadows: false,
    shadowMapSize: 512,
    foliageDensity: 0.35,
    microDetailDensity: 0.35,
    maxAccentLights: 4,
    fogDensityScale: 1.12,
    envIntensityScale: 0.9,
    anisotropyCap: 2,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    shortLabel: 'BAL',
    description: 'Normal balance · Crisp shadows, instanced foliage & smooth 60 FPS',
    maxDpr: 1.5,
    openWorldMaxDpr: 1.15,
    antialias: true,
    castShadows: true,
    shadowMapSize: 1024,
    foliageDensity: 0.72,
    microDetailDensity: 0.72,
    maxAccentLights: 9,
    fogDensityScale: 1.0,
    envIntensityScale: 1.0,
    anisotropyCap: 4,
  },
  high: {
    id: 'high',
    label: 'High',
    shortLabel: 'HIGH',
    description: 'Rich foliage, high-res shadows, detailed interiors & full lighting',
    maxDpr: 1.75,
    openWorldMaxDpr: 1.45,
    antialias: true,
    castShadows: true,
    shadowMapSize: 2048,
    foliageDensity: 1.0,
    microDetailDensity: 1.0,
    maxAccentLights: 15,
    fogDensityScale: 0.92,
    envIntensityScale: 1.05,
    anisotropyCap: 8,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    shortLabel: 'ULTRA',
    description: 'Maximum visual density, 4K shadow maps, lush foliage & micro-clutter',
    maxDpr: 2.0,
    openWorldMaxDpr: 1.75,
    antialias: true,
    castShadows: true,
    shadowMapSize: 4096,
    foliageDensity: 1.4,
    microDetailDensity: 1.35,
    maxAccentLights: 22,
    fogDensityScale: 0.85,
    envIntensityScale: 1.1,
    anisotropyCap: 16,
  },
};

export function isValidGraphicsQuality(val: unknown): val is GraphicsQualityId {
  return val === 'performance' || val === 'balanced' || val === 'high' || val === 'ultra';
}

export function getGraphicsQualityProfile(id: GraphicsQualityId | undefined): GraphicsQualityProfile {
  return GRAPHICS_QUALITY_PROFILES[id && isValidGraphicsQuality(id) ? id : 'balanced'];
}

export interface DistancePerformanceSettings {
  /** Standard / Battle / Conquest / Survival render distance in meters (default 220m) */
  renderDistanceM: number;
  /** 4km Open World render distance in meters (default 300m) */
  openWorldRenderDistanceM: number;
  /** Distance beyond which remote/AI/zombie/wildlife skeletal animations run at half rate (default 75m) */
  reduceAnimationDistanceM: number;
}

export const RENDER_DISTANCE_LIMITS = {
  min: 100,
  max: 400,
  step: 10,
  default: 220,
} as const;

export const OPEN_WORLD_RENDER_DISTANCE_LIMITS = {
  min: 140,
  max: 650,
  step: 10,
  default: 300,
} as const;

export const REDUCE_ANIMATION_DISTANCE_LIMITS = {
  min: 25,
  max: 180,
  step: 5,
  default: 75,
} as const;

/** AAA distance fog begins this many meters before the active render distance */
export const HORIZON_FOG_LEAD_M = 15;

const STORAGE_KEY = 'axon_graphics_quality_v1';
const ADAPTIVE_SCALING_STORAGE_KEY = 'axon_adaptive_scaling_v1';
const RENDER_DIST_STORAGE_KEY = 'axon_render_distance_m_v1';
const OW_RENDER_DIST_STORAGE_KEY = 'axon_ow_render_distance_m_v1';
const REDUCE_ANIM_DIST_STORAGE_KEY = 'axon_reduce_anim_distance_m_v1';

type QualityListener = (quality: GraphicsQualityId) => void;
type AdaptiveScalingListener = (enabled: boolean) => void;
type DistanceSettingsListener = (settings: Readonly<DistancePerformanceSettings>) => void;

function clampStep(val: number, min: number, max: number, step: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  const clamped = Math.max(min, Math.min(max, val));
  return Math.round(clamped / step) * step;
}

class GraphicsQualityStore {
  private current: GraphicsQualityId = 'balanced';
  private adaptiveScalingEnabled = false;
  private distanceSettings: DistancePerformanceSettings = {
    renderDistanceM: RENDER_DISTANCE_LIMITS.default,
    openWorldRenderDistanceM: OPEN_WORLD_RENDER_DISTANCE_LIMITS.default,
    reduceAnimationDistanceM: REDUCE_ANIMATION_DISTANCE_LIMITS.default,
  };
  private readonly listeners = new Set<QualityListener>();
  private readonly adaptiveListeners = new Set<AdaptiveScalingListener>();
  private readonly distanceListeners = new Set<DistanceSettingsListener>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (isValidGraphicsQuality(raw)) {
        this.current = raw;
      }
      const adaptiveRaw = window.localStorage.getItem(ADAPTIVE_SCALING_STORAGE_KEY);
      if (adaptiveRaw === '1' || adaptiveRaw === 'true') {
        this.adaptiveScalingEnabled = true;
      } else {
        this.adaptiveScalingEnabled = false;
      }
      const rdRaw = window.localStorage.getItem(RENDER_DIST_STORAGE_KEY);
      if (rdRaw !== null) {
        this.distanceSettings.renderDistanceM = clampStep(
          Number(rdRaw),
          RENDER_DISTANCE_LIMITS.min,
          RENDER_DISTANCE_LIMITS.max,
          RENDER_DISTANCE_LIMITS.step,
          RENDER_DISTANCE_LIMITS.default,
        );
      }
      const owRdRaw = window.localStorage.getItem(OW_RENDER_DIST_STORAGE_KEY);
      if (owRdRaw !== null) {
        this.distanceSettings.openWorldRenderDistanceM = clampStep(
          Number(owRdRaw),
          OPEN_WORLD_RENDER_DISTANCE_LIMITS.min,
          OPEN_WORLD_RENDER_DISTANCE_LIMITS.max,
          OPEN_WORLD_RENDER_DISTANCE_LIMITS.step,
          OPEN_WORLD_RENDER_DISTANCE_LIMITS.default,
        );
      }
      const animRaw = window.localStorage.getItem(REDUCE_ANIM_DIST_STORAGE_KEY);
      if (animRaw !== null) {
        this.distanceSettings.reduceAnimationDistanceM = clampStep(
          Number(animRaw),
          REDUCE_ANIMATION_DISTANCE_LIMITS.min,
          REDUCE_ANIMATION_DISTANCE_LIMITS.max,
          REDUCE_ANIMATION_DISTANCE_LIMITS.step,
          REDUCE_ANIMATION_DISTANCE_LIMITS.default,
        );
      }
    } catch {
      // Ignore storage access errors
    }
  }

  public getQuality(): GraphicsQualityId {
    return this.current;
  }

  public getProfile(): GraphicsQualityProfile {
    return GRAPHICS_QUALITY_PROFILES[this.current];
  }

  public setQuality(next: GraphicsQualityId): void {
    if (!isValidGraphicsQuality(next) || next === this.current) return;
    this.current = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
    for (const fn of this.listeners) {
      fn(this.current);
    }
  }

  public subscribe(fn: QualityListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  public isAdaptiveScalingEnabled(): boolean {
    return this.adaptiveScalingEnabled;
  }

  public setAdaptiveScalingEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (next === this.adaptiveScalingEnabled) return;
    this.adaptiveScalingEnabled = next;
    try {
      window.localStorage.setItem(ADAPTIVE_SCALING_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    for (const fn of this.adaptiveListeners) {
      fn(this.adaptiveScalingEnabled);
    }
  }

  public subscribeAdaptiveScaling(fn: AdaptiveScalingListener): () => void {
    this.adaptiveListeners.add(fn);
    return () => {
      this.adaptiveListeners.delete(fn);
    };
  }

  public getDistanceSettings(): Readonly<DistancePerformanceSettings> {
    return this.distanceSettings;
  }

  public getRenderDistanceM(): number {
    return this.distanceSettings.renderDistanceM;
  }

  public getOpenWorldRenderDistanceM(): number {
    return this.distanceSettings.openWorldRenderDistanceM;
  }

  public getReduceAnimationDistanceM(): number {
    return this.distanceSettings.reduceAnimationDistanceM;
  }

  public setRenderDistanceM(val: number): void {
    const next = clampStep(
      val,
      RENDER_DISTANCE_LIMITS.min,
      RENDER_DISTANCE_LIMITS.max,
      RENDER_DISTANCE_LIMITS.step,
      RENDER_DISTANCE_LIMITS.default,
    );
    if (next === this.distanceSettings.renderDistanceM) return;
    this.distanceSettings = { ...this.distanceSettings, renderDistanceM: next };
    try {
      window.localStorage.setItem(RENDER_DIST_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
    this.notifyDistanceListeners();
  }

  public setOpenWorldRenderDistanceM(val: number): void {
    const next = clampStep(
      val,
      OPEN_WORLD_RENDER_DISTANCE_LIMITS.min,
      OPEN_WORLD_RENDER_DISTANCE_LIMITS.max,
      OPEN_WORLD_RENDER_DISTANCE_LIMITS.step,
      OPEN_WORLD_RENDER_DISTANCE_LIMITS.default,
    );
    if (next === this.distanceSettings.openWorldRenderDistanceM) return;
    this.distanceSettings = { ...this.distanceSettings, openWorldRenderDistanceM: next };
    try {
      window.localStorage.setItem(OW_RENDER_DIST_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
    this.notifyDistanceListeners();
  }

  public setReduceAnimationDistanceM(val: number): void {
    const next = clampStep(
      val,
      REDUCE_ANIMATION_DISTANCE_LIMITS.min,
      REDUCE_ANIMATION_DISTANCE_LIMITS.max,
      REDUCE_ANIMATION_DISTANCE_LIMITS.step,
      REDUCE_ANIMATION_DISTANCE_LIMITS.default,
    );
    if (next === this.distanceSettings.reduceAnimationDistanceM) return;
    this.distanceSettings = { ...this.distanceSettings, reduceAnimationDistanceM: next };
    try {
      window.localStorage.setItem(REDUCE_ANIM_DIST_STORAGE_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
    this.notifyDistanceListeners();
  }

  public subscribeDistanceSettings(fn: DistanceSettingsListener): () => void {
    this.distanceListeners.add(fn);
    return () => {
      this.distanceListeners.delete(fn);
    };
  }

  private notifyDistanceListeners(): void {
    const snap = this.distanceSettings;
    for (const fn of this.distanceListeners) {
      fn(snap);
    }
  }
}

export const graphicsQualityStore = new GraphicsQualityStore();

export interface AdaptivePerformanceState {
  tier: 0 | 1 | 2 | 3;
  dprScale: number;
  effectiveDpr: number;
  godraysAllowed: boolean;
  skySteps: number;
  changed: boolean;
}

/**
 * Opt-in adaptive resolution & secondary effect controller (OFF by default).
 * Uses EMA frametime smoothing + 2.5s cooldown hysteresis so DPR never thrashes frame-to-frame.
 */
export class AdaptivePerformanceController {
  private tier: 0 | 1 | 2 | 3 = 0;
  private emaFrameMs = 16.0;
  private lastStepTimeSec = -10;
  private baseMaxDpr = 1.5;
  private baseCastShadows = true;
  private readonly useOpenWorldCap: boolean;

  public readonly state: AdaptivePerformanceState = {
    tier: 0,
    dprScale: 1.0,
    effectiveDpr: 1.0,
    godraysAllowed: true,
    skySteps: 10,
    changed: false,
  };

  constructor(baseProfile: GraphicsQualityProfile, useOpenWorldCap = false) {
    this.useOpenWorldCap = useOpenWorldCap;
    this.syncProfile(baseProfile);
  }

  public syncProfile(baseProfile: GraphicsQualityProfile): void {
    this.baseMaxDpr = this.useOpenWorldCap ? baseProfile.openWorldMaxDpr : baseProfile.maxDpr;
    this.baseCastShadows = baseProfile.castShadows;
    this.applyTier(this.tier, true);
  }

  public reset(baseProfile: GraphicsQualityProfile): void {
    this.tier = 0;
    this.emaFrameMs = 16.0;
    this.lastStepTimeSec = -10;
    this.syncProfile(baseProfile);
  }

  private applyTier(nextTier: 0 | 1 | 2 | 3, forceNotify = false): boolean {
    const changed = forceNotify || nextTier !== this.tier;
    this.tier = nextTier;
    const dprScales = [1.0, 0.88, 0.78, 0.72] as const;
    const dprScale = dprScales[nextTier];
    const nativeDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const targetMaxDpr = Math.max(0.72, this.baseMaxDpr * dprScale);
    this.state.tier = nextTier;
    this.state.dprScale = dprScale;
    this.state.effectiveDpr = Math.min(nativeDpr, targetMaxDpr);
    this.state.godraysAllowed = this.baseCastShadows && nextTier < 2;
    this.state.skySteps = nextTier === 0 ? 10 : nextTier === 1 ? 8 : 6;
    this.state.changed = changed;
    return changed;
  }

  public update(
    rawFrameMs: number,
    enabled: boolean,
    nowSec: number,
  ): Readonly<AdaptivePerformanceState> {
    if (!enabled) {
      if (this.tier !== 0) {
        this.applyTier(0, true);
      } else {
        this.state.changed = false;
      }
      return this.state;
    }

    // Ignore extreme tab-switch pauses (> 180ms)
    if (rawFrameMs > 0 && rawFrameMs < 180) {
      this.emaFrameMs = this.emaFrameMs * 0.92 + rawFrameMs * 0.08;
    }

    this.state.changed = false;
    if (nowSec - this.lastStepTimeSec < 2.5) {
      return this.state;
    }

    if (this.emaFrameMs > 19.8 && this.tier < 3) {
      const next = (this.tier + 1) as 0 | 1 | 2 | 3;
      this.lastStepTimeSec = nowSec;
      this.applyTier(next, true);
    } else if (this.emaFrameMs < 14.0 && this.tier > 0) {
      const next = (this.tier - 1) as 0 | 1 | 2 | 3;
      this.lastStepTimeSec = nowSec;
      this.applyTier(next, true);
    }

    return this.state;
  }
}

import { useEffect, useState } from 'react';

export function useGraphicsQuality(): [GraphicsQualityId, (q: GraphicsQualityId) => void, GraphicsQualityProfile] {
  const [quality, setQualityState] = useState<GraphicsQualityId>(() =>
    graphicsQualityStore.getQuality(),
  );

  useEffect(() => {
    return graphicsQualityStore.subscribe((next) => setQualityState(next));
  }, []);

  return [
    quality,
    (q) => graphicsQualityStore.setQuality(q),
    GRAPHICS_QUALITY_PROFILES[quality],
  ];
}

export function useAdaptiveScaling(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() =>
    graphicsQualityStore.isAdaptiveScalingEnabled(),
  );

  useEffect(() => {
    return graphicsQualityStore.subscribeAdaptiveScaling((next) => setEnabledState(next));
  }, []);

  return [enabled, (next) => graphicsQualityStore.setAdaptiveScalingEnabled(next)];
}

export function useDistancePerformanceSettings(): [
  Readonly<DistancePerformanceSettings>,
  {
    setRenderDistanceM: (val: number) => void;
    setOpenWorldRenderDistanceM: (val: number) => void;
    setReduceAnimationDistanceM: (val: number) => void;
  },
] {
  const [settings, setSettings] = useState<Readonly<DistancePerformanceSettings>>(() =>
    graphicsQualityStore.getDistanceSettings(),
  );

  useEffect(() => {
    return graphicsQualityStore.subscribeDistanceSettings((next) => setSettings(next));
  }, []);

  return [
    settings,
    {
      setRenderDistanceM: (val) => graphicsQualityStore.setRenderDistanceM(val),
      setOpenWorldRenderDistanceM: (val) => graphicsQualityStore.setOpenWorldRenderDistanceM(val),
      setReduceAnimationDistanceM: (val) => graphicsQualityStore.setReduceAnimationDistanceM(val),
    },
  ];
}

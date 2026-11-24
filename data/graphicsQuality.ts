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

const STORAGE_KEY = 'axon_graphics_quality_v1';
const ADAPTIVE_SCALING_STORAGE_KEY = 'axon_adaptive_scaling_v1';

type QualityListener = (quality: GraphicsQualityId) => void;
type AdaptiveScalingListener = (enabled: boolean) => void;

class GraphicsQualityStore {
  private current: GraphicsQualityId = 'balanced';
  private adaptiveScalingEnabled = false;
  private readonly listeners = new Set<QualityListener>();
  private readonly adaptiveListeners = new Set<AdaptiveScalingListener>();

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

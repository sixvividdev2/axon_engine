export type GraphicsQualityId = 'performance' | 'balanced' | 'high' | 'ultra';

export interface GraphicsQualityProfile {
  id: GraphicsQualityId;
  label: string;
  shortLabel: string;
  description: string;
  maxDpr: number;
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

type QualityListener = (quality: GraphicsQualityId) => void;

class GraphicsQualityStore {
  private current: GraphicsQualityId = 'balanced';
  private readonly listeners = new Set<QualityListener>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (isValidGraphicsQuality(raw)) {
        this.current = raw;
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
}

export const graphicsQualityStore = new GraphicsQualityStore();

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

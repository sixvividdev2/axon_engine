import { useEffect, useState } from 'react';

const HEADSHOT_SFX_STORAGE_KEY = 'axon_headshot_sfx_v1';

type HeadshotSfxListener = (enabled: boolean) => void;

const listeners = new Set<HeadshotSfxListener>();

let cachedEnabled: boolean | null = null;

function readInitialHeadshotSfx(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) {
    return false;
  }
  try {
    const raw = window.localStorage.getItem(HEADSHOT_SFX_STORAGE_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  } catch {
    // Ignore storage access errors in restricted frames
  }
  return false;
}

/**
 * Returns whether the opt-in Headshot Indicator SFX (fleshy thud + wet blood splat)
 * is currently enabled. Disabled by default (`false`) for full immersion.
 */
export function isHeadshotSfxEnabled(): boolean {
  if (cachedEnabled === null) {
    cachedEnabled = readInitialHeadshotSfx();
  }
  return cachedEnabled;
}

export function setHeadshotSfxEnabled(enabled: boolean): void {
  const next = Boolean(enabled);
  cachedEnabled = next;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(HEADSHOT_SFX_STORAGE_KEY, next ? 'true' : 'false');
    } catch {
      // Ignore storage quota or sandbox errors
    }
  }
  listeners.forEach((fn) => {
    try {
      fn(next);
    } catch {
      // Isolate listener errors
    }
  });
}

export function subscribeHeadshotSfx(listener: HeadshotSfxListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Resets cached state (for unit tests). */
export function resetHeadshotSfxCacheForTest(): void {
  cachedEnabled = null;
}

export function useHeadshotSfxPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() => isHeadshotSfxEnabled());

  useEffect(() => {
    return subscribeHeadshotSfx((next) => setEnabledState(next));
  }, []);

  const update = (next: boolean) => {
    setHeadshotSfxEnabled(next);
  };

  return [enabled, update];
}

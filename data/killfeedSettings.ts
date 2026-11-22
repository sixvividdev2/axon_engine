import { useEffect, useState } from 'react';

export type LobbyKillfeedPolicy = 'player_choice' | 'force_on' | 'force_off';

export interface EffectiveKillfeedState {
  enabled: boolean;
  overriddenByHost: boolean;
  overrideLabel: string | null;
}

export function isValidLobbyKillfeedPolicy(val: unknown): val is LobbyKillfeedPolicy {
  return val === 'player_choice' || val === 'force_on' || val === 'force_off';
}

export function resolveEffectiveKillfeed(
  personalEnabled: boolean,
  lobbyPolicy?: LobbyKillfeedPolicy | null,
): EffectiveKillfeedState {
  if (lobbyPolicy === 'force_on') {
    return {
      enabled: true,
      overriddenByHost: true,
      overrideLabel: 'Host Override · Forced On',
    };
  }
  if (lobbyPolicy === 'force_off') {
    return {
      enabled: false,
      overriddenByHost: true,
      overrideLabel: 'Host Override · Forced Off',
    };
  }
  return {
    enabled: personalEnabled,
    overriddenByHost: false,
    overrideLabel: null,
  };
}

export function formatKillfeedPolicyLabel(policy: LobbyKillfeedPolicy): string {
  switch (policy) {
    case 'force_on':
      return 'Force On';
    case 'force_off':
      return 'Force Off';
    default:
      return 'Player Choice';
  }
}

const STORAGE_KEY = 'axon_player_killfeed_enabled_v1';

type KillfeedListener = (enabled: boolean) => void;

class KillfeedPreferenceStore {
  private enabled = true;
  private readonly listeners = new Set<KillfeedListener>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === '0' || raw === 'false') {
        this.enabled = false;
      } else if (raw === '1' || raw === 'true') {
        this.enabled = true;
      }
    } catch {
      // Ignore storage errors
    }
  }

  public getEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(next: boolean): void {
    const clean = Boolean(next);
    if (clean === this.enabled) return;
    this.enabled = clean;
    try {
      window.localStorage.setItem(STORAGE_KEY, clean ? '1' : '0');
    } catch {
      // Ignore storage errors
    }
    for (const fn of this.listeners) {
      fn(this.enabled);
    }
  }

  public subscribe(fn: KillfeedListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const killfeedPreferenceStore = new KillfeedPreferenceStore();

export function useKillfeedPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() => killfeedPreferenceStore.getEnabled());

  useEffect(() => {
    return killfeedPreferenceStore.subscribe((next) => setEnabledState(next));
  }, []);

  return [enabled, (val) => killfeedPreferenceStore.setEnabled(val)];
}

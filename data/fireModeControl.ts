import type { BodycamWeaponProfile } from '../bodycam-sdk';

export type SelectableFireMode = 'auto' | 'semi' | 'pump';

const STORAGE_KEY = 'bodycam_weapon_fire_modes_v1';

/**
 * Maps legacy weapon profile aliases to their canonical firearm IDs so a player's
 * saved fire mode (e.g., M4A1 set to SEMI in Tutorial or Gym) stays identical across
 * Hideout, Zombies Outpost, Combat, and Open World without ever resetting on swap/unequip.
 */
const CANONICAL_FIRE_MODE_IDS: Record<string, string> = {
  m4_556: 'm4a1',
  aks74u_545: 'aks74u',
  ak74u_545: 'aks74u',
  akm_762: 'akm',
  pm_9x19: 'mp443_grach',
  mp133_12ga: 'remington_870',
};

export function canonicalizeFireModeWeaponId(weaponId: string): string {
  return CANONICAL_FIRE_MODE_IDS[weaponId] ?? weaponId;
}

export function isSingleShotFireMode(mode: BodycamWeaponProfile['fireMode']): boolean {
  return mode === 'semi' || mode === 'bolt' || mode === 'pump';
}

export function getEffectiveFireRpm(
  prof: Pick<BodycamWeaponProfile, 'id' | 'rpm' | 'toggleablePumpSemi'>,
  effectiveMode: BodycamWeaponProfile['fireMode'],
): number {
  if (prof.toggleablePumpSemi || canonicalizeFireModeWeaponId(prof.id) === 'spas12') {
    return effectiveMode === 'semi' ? 240 : 85;
  }
  return prof.rpm;
}

export function shouldCyclePumpOnShot(
  prof: Pick<BodycamWeaponProfile, 'id' | 'toggleablePumpSemi'>,
  effectiveMode: BodycamWeaponProfile['fireMode'],
): boolean | undefined {
  if (prof.toggleablePumpSemi || canonicalizeFireModeWeaponId(prof.id) === 'spas12') {
    return effectiveMode === 'pump';
  }
  return undefined;
}

export function formatFireModeLabel(mode: BodycamWeaponProfile['fireMode']): string {
  switch (mode) {
    case 'auto':
      return 'AUTO';
    case 'semi':
      return 'SEMI';
    case 'bolt':
      return 'BOLT';
    case 'pump':
      return 'PUMP';
    default:
      return 'SEMI';
  }
}

export function supportsFireModeToggle(
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode' | 'holdClass' | 'magCapacity'> & {
    toggleablePumpSemi?: boolean;
  },
): boolean {
  if (prof.magCapacity <= 0 || prof.holdClass === 'melee_1h' || prof.holdClass === 'unarmed') {
    return false;
  }
  const canonId = canonicalizeFireModeWeaponId(prof.id);
  return canonId === 'spas12' || Boolean(prof.toggleablePumpSemi) || prof.fireMode === 'auto';
}

function readOverrideForId(
  weaponId: string,
  overrides: Record<string, SelectableFireMode>,
): SelectableFireMode | undefined {
  const canonId = canonicalizeFireModeWeaponId(weaponId);
  return overrides[canonId] ?? overrides[weaponId];
}

function writeOverrideForId(
  weaponId: string,
  mode: SelectableFireMode,
  overrides: Record<string, SelectableFireMode>,
): void {
  const canonId = canonicalizeFireModeWeaponId(weaponId);
  overrides[canonId] = mode;
  if (canonId !== weaponId) {
    delete overrides[weaponId];
  }
}

export function getEffectiveFireMode(
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode'> & { toggleablePumpSemi?: boolean },
  overrides: Record<string, SelectableFireMode> = fireModeStore.getOverrides(),
): BodycamWeaponProfile['fireMode'] {
  const canonId = canonicalizeFireModeWeaponId(prof.id);
  const override = readOverrideForId(prof.id, overrides);
  if (!override) return prof.fireMode;
  if ((canonId === 'spas12' || prof.toggleablePumpSemi) && (override === 'pump' || override === 'semi')) {
    return override;
  }
  if (prof.fireMode === 'auto' && (override === 'auto' || override === 'semi')) {
    return override;
  }
  return prof.fireMode;
}

export function toggleWeaponFireMode(
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode' | 'holdClass' | 'magCapacity'> & {
    toggleablePumpSemi?: boolean;
  },
  overrides?: Record<string, SelectableFireMode>,
): {
  toggled: boolean;
  nextMode: BodycamWeaponProfile['fireMode'];
  label: string;
} {
  if (!overrides) {
    return fireModeStore.toggle(prof);
  }
  if (!supportsFireModeToggle(prof)) {
    return {
      toggled: false,
      nextMode: prof.fireMode,
      label: formatFireModeLabel(prof.fireMode),
    };
  }

  const canonId = canonicalizeFireModeWeaponId(prof.id);
  if (canonId === 'spas12' || prof.toggleablePumpSemi) {
    const current = getEffectiveFireMode(prof, overrides);
    const next: SelectableFireMode = current === 'pump' ? 'semi' : 'pump';
    writeOverrideForId(prof.id, next, overrides);
    return {
      toggled: true,
      nextMode: next,
      label: next === 'semi' ? 'SEMI-AUTO' : 'PUMP',
    };
  }

  const current = getEffectiveFireMode(prof, overrides);
  const next: SelectableFireMode = current === 'auto' ? 'semi' : 'auto';
  writeOverrideForId(prof.id, next, overrides);
  return {
    toggled: true,
    nextMode: next,
    label: next === 'auto' ? 'FULL-AUTO' : 'SEMI-AUTO',
  };
}

type FireModeListener = () => void;

class PersistentFireModeStore {
  private overrides: Record<string, SelectableFireMode> = {};
  private readonly listeners = new Set<FireModeListener>();

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    this.overrides = {};
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [k, v] of Object.entries(parsed)) {
        if (v === 'auto' || v === 'semi' || v === 'pump') {
          this.overrides[canonicalizeFireModeWeaponId(k)] = v;
        }
      }
    } catch {
      // Ignore storage access/parse failures in restricted environments
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.overrides));
    } catch {
      // Ignore storage quota/access failures
    }
  }

  private notify(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  public getOverrides(): Record<string, SelectableFireMode> {
    return this.overrides;
  }

  public getEffectiveMode(
    prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode'> & { toggleablePumpSemi?: boolean },
  ): BodycamWeaponProfile['fireMode'] {
    return getEffectiveFireMode(prof, this.overrides);
  }

  public setMode(weaponId: string, mode: SelectableFireMode): void {
    const canonId = canonicalizeFireModeWeaponId(weaponId);
    if (this.overrides[canonId] === mode) return;
    this.overrides[canonId] = mode;
    this.saveToStorage();
    this.notify();
  }

  public toggle(
    prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode' | 'holdClass' | 'magCapacity'> & {
      toggleablePumpSemi?: boolean;
    },
  ): {
    toggled: boolean;
    nextMode: BodycamWeaponProfile['fireMode'];
    label: string;
  } {
    const res = toggleWeaponFireMode(prof, this.overrides);
    if (res.toggled) {
      this.saveToStorage();
      this.notify();
    }
    return res;
  }

  public subscribe(listener: FireModeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public reloadFromStorage(): void {
    this.loadFromStorage();
    this.notify();
  }

  public resetForTesting(): void {
    this.overrides = {};
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore
    }
    this.notify();
  }
}

export const fireModeStore = new PersistentFireModeStore();

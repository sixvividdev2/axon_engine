import type { BodycamWeaponProfile } from '../bodycam-sdk';

export type SelectableFireMode = 'auto' | 'semi' | 'pump';

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
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode' | 'holdClass' | 'magCapacity'>,
): boolean {
  if (prof.magCapacity <= 0 || prof.holdClass === 'melee_1h' || prof.holdClass === 'unarmed') {
    return false;
  }
  return prof.id === 'spas12' || prof.fireMode === 'auto';
}

export function getEffectiveFireMode(
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode'>,
  overrides: Record<string, SelectableFireMode>,
): BodycamWeaponProfile['fireMode'] {
  const override = overrides[prof.id];
  if (!override) return prof.fireMode;
  if (prof.id === 'spas12' && (override === 'pump' || override === 'semi')) {
    return override;
  }
  if (prof.fireMode === 'auto' && (override === 'auto' || override === 'semi')) {
    return override;
  }
  return prof.fireMode;
}

export function toggleWeaponFireMode(
  prof: Pick<BodycamWeaponProfile, 'id' | 'fireMode' | 'holdClass' | 'magCapacity'>,
  overrides: Record<string, SelectableFireMode>,
): {
  toggled: boolean;
  nextMode: BodycamWeaponProfile['fireMode'];
  label: string;
} {
  if (!supportsFireModeToggle(prof)) {
    return {
      toggled: false,
      nextMode: prof.fireMode,
      label: formatFireModeLabel(prof.fireMode),
    };
  }

  if (prof.id === 'spas12') {
    const current = getEffectiveFireMode(prof, overrides);
    const next: SelectableFireMode = current === 'pump' ? 'semi' : 'pump';
    overrides[prof.id] = next;
    return {
      toggled: true,
      nextMode: next,
      label: next === 'semi' ? 'SEMI-AUTO' : 'PUMP',
    };
  }

  const current = getEffectiveFireMode(prof, overrides);
  const next: SelectableFireMode = current === 'auto' ? 'semi' : 'auto';
  overrides[prof.id] = next;
  return {
    toggled: true,
    nextMode: next,
    label: next === 'auto' ? 'FULL-AUTO' : 'SEMI-AUTO',
  };
}

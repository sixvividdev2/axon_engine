export type TacticalEquipmentId =
  | 'm67_frag'
  | 'm84_flash'
  | 'm18_smoke'
  | 'an_m14_thermite';

export type TacticalEquipmentCategory = 'lethal' | 'tactical';

export type TacticalBeltSlot =
  | 'left_hip'
  | 'right_hip'
  | 'front_left'
  | 'rear_belt';

export interface TacticalEquipmentDef {
  id: TacticalEquipmentId;
  name: string;
  shortName: string;
  killfeedLabel: string;
  category: TacticalEquipmentCategory;
  description: string;
  weightKg: number;
  fuseSec: number;
  /** Real-world pyrotechnic delay burn variance (+/- seconds) */
  fuseVarianceSec: number;
  cookable: boolean;
  /** High-density inner lethal core (m) for frag / direct stun core for flash */
  lethalRadiusM: number;
  /** Outer casualty / effective effect radius (m) */
  blastRadiusM: number;
  maxDamage: number;
  effectDurationSec: number;
  maxCarry: number;
  throwSpeedMps: number;
  accentHex: string;
  bodyHex: number;
  bandHex: number;
}

export interface TacticalBeltSlotDef {
  id: TacticalBeltSlot;
  label: string;
  shortLabel: string;
  description: string;
}

export const DEFAULT_TACTICAL_EQUIPMENT_ID: TacticalEquipmentId = 'm67_frag';
export const DEFAULT_TACTICAL_BELT_SLOT: TacticalBeltSlot = 'front_left';

export const TACTICAL_BELT_SLOTS: readonly TacticalBeltSlotDef[] = [
  {
    id: 'front_left',
    label: 'Front-Left Rig',
    shortLabel: 'F-LEFT',
    description: 'Angled quick-draw MOLLE clip on front-left waist (visible on look-down).',
  },
  {
    id: 'left_hip',
    label: 'Left Hip Pouch',
    shortLabel: 'L-HIP',
    description: 'Support-hand flank mount ahead of the dump pouch.',
  },
  {
    id: 'right_hip',
    label: 'Right Hip Clip',
    shortLabel: 'R-HIP',
    description: 'Strong-side waist mount forward of the pistol holster.',
  },
  {
    id: 'rear_belt',
    label: 'Rear Lumbar Pack',
    shortLabel: 'REAR',
    description: 'Twin horizontal lower-back MOLLE belt carriage.',
  },
] as const;

export const TACTICAL_EQUIPMENT_CATALOG: Record<TacticalEquipmentId, TacticalEquipmentDef> = {
  m67_frag: {
    id: 'm67_frag',
    name: 'M67 Frag Grenade',
    shortName: 'M67 FRAG',
    killfeedLabel: 'M67 FRAG',
    category: 'lethal',
    description:
      'Comp-B fragmentation grenade. Pulling pin unlocks spoon; releasing lever starts a 4.0–5.0s chemical delay. 5m lethal / 15m casualty shard matrix.',
    weightKg: 0.4,
    fuseSec: 4.5,
    fuseVarianceSec: 0.5,
    cookable: true,
    lethalRadiusM: 5.0,
    blastRadiusM: 15.0,
    maxDamage: 185,
    effectDurationSec: 0.4,
    maxCarry: 4,
    throwSpeedMps: 15.8,
    accentHex: '#f59e0b',
    bodyHex: 0x3b4832,
    bandHex: 0xd9a82b,
  },
  m84_flash: {
    id: 'm84_flash',
    name: 'M84 Flashbang',
    shortName: 'M84 STUN',
    killfeedLabel: 'M84 STUN',
    category: 'tactical',
    description:
      '175 dB magnesium-perchlorate stun grenade. Causes full bodycam CMOS sensor overload, burn-in afterimage, and tinnitus.',
    weightKg: 0.24,
    fuseSec: 1.75,
    fuseVarianceSec: 0.2,
    cookable: true,
    lethalRadiusM: 4.5,
    blastRadiusM: 14.0,
    maxDamage: 18,
    effectDurationSec: 4.4,
    maxCarry: 2,
    throwSpeedMps: 16.5,
    accentHex: '#38bdf8',
    bodyHex: 0x2d333a,
    bandHex: 0x60a5fa,
  },
  m18_smoke: {
    id: 'm18_smoke',
    name: 'M18 Smoke Canister',
    shortName: 'M18 SMOKE',
    killfeedLabel: 'M18 SMOKE',
    category: 'tactical',
    description:
      'Rapid-blooming tactical screening smoke canister that blocks AI line-of-sight and masks movement lanes for 14 seconds.',
    weightKg: 0.54,
    fuseSec: 1.5,
    fuseVarianceSec: 0.15,
    cookable: false,
    lethalRadiusM: 0,
    blastRadiusM: 7.5,
    maxDamage: 0,
    effectDurationSec: 14.0,
    maxCarry: 2,
    throwSpeedMps: 14.8,
    accentHex: '#94a3b8',
    bodyHex: 0x454e3c,
    bandHex: 0xdc4a3a,
  },
  an_m14_thermite: {
    id: 'an_m14_thermite',
    name: 'AN-M14 Thermite',
    shortName: 'AN-M14 INC',
    killfeedLabel: 'AN-M14 THERMITE',
    category: 'lethal',
    description:
      'Incendiary magnesium-thermite canister creating a blazing 6.5s area-denial burn zone.',
    weightKg: 0.9,
    fuseSec: 2.1,
    fuseVarianceSec: 0.2,
    cookable: true,
    lethalRadiusM: 2.4,
    blastRadiusM: 4.8,
    maxDamage: 52, // DPS tick damage (4.8m burn zone over 6.5s)
    effectDurationSec: 6.5,
    maxCarry: 2,
    throwSpeedMps: 13.6,
    accentHex: '#fb923c',
    bodyHex: 0x272a2e,
    bandHex: 0xf97316,
  },
};

export const TACTICAL_EQUIPMENT_LIST: readonly TacticalEquipmentDef[] = [
  TACTICAL_EQUIPMENT_CATALOG.m67_frag,
  TACTICAL_EQUIPMENT_CATALOG.m84_flash,
  TACTICAL_EQUIPMENT_CATALOG.m18_smoke,
  TACTICAL_EQUIPMENT_CATALOG.an_m14_thermite,
];

export function isTacticalEquipmentId(value: unknown): value is TacticalEquipmentId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(TACTICAL_EQUIPMENT_CATALOG, value)
  );
}

export function normalizeTacticalEquipmentId(value: unknown): TacticalEquipmentId {
  if (isTacticalEquipmentId(value)) return value;
  return DEFAULT_TACTICAL_EQUIPMENT_ID;
}

export function isTacticalBeltSlot(value: unknown): value is TacticalBeltSlot {
  return (
    value === 'front_left' ||
    value === 'left_hip' ||
    value === 'right_hip' ||
    value === 'rear_belt'
  );
}

export function normalizeTacticalBeltSlot(value: unknown): TacticalBeltSlot {
  return isTacticalBeltSlot(value) ? value : DEFAULT_TACTICAL_BELT_SLOT;
}

export function getTacticalEquipmentDef(id: unknown): TacticalEquipmentDef {
  return TACTICAL_EQUIPMENT_CATALOG[normalizeTacticalEquipmentId(id)];
}

/**
 * Compute detonation probability [0.12 .. 0.96] when a physical grenade mounted on
 * an operator's waist belt is struck by a bullet. Any caliber can set off a live fuse
 * or sympathetic detonation, while heavier rifle / magnum / shotgun energies and
 * AP / incendiary / tracer rounds scale sharply higher.
 */
export function computeBeltGrenadeDetonationChance(
  impactEnergyJ: number,
  ammoCategory?: string,
): number {
  const energy = Math.max(0, Number.isFinite(impactEnergyJ) ? impactEnergyJ : 550);
  // Smooth energy curve:
  // ~140 J (.22LR) -> ~18%, ~480 J (9mm) -> ~30%, ~1750 J (5.56) -> ~58%,
  // ~3300 J (7.62x51 / 12ga slug) -> ~79%, ~4800+ J (.338 / .50) -> ~92%+
  let chance = 0.14 + (1 - Math.exp(-energy / 2450)) * 0.80;

  if (ammoCategory) {
    const cat = ammoCategory.toLowerCase();
    if (cat.includes('incendiary') || cat.includes('dragon') || cat.includes('tracer')) {
      chance += 0.18;
    } else if (cat.includes('ap') || cat.includes('armor') || cat.includes('slug') || cat.includes('magnum')) {
      chance += 0.10;
    } else if (cat.includes('subsonic') || cat.includes('hp') || cat.includes('frangible')) {
      chance -= 0.04;
    }
  }

  return Math.max(0.12, Math.min(0.96, chance));
}


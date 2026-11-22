import { WeaponCategory, WeaponRailType } from '../bodycam-sdk/types';
import { BaseCaliberId } from './calibers';

export type AttachmentSlot =
  | 'railAdapter'
  | 'optic'
  | 'canted'
  | 'muzzle'
  | 'tactical'
  | 'foregrip'
  | 'magazine';

export type ForegripPoseStyle = 'none' | 'vertical' | 'angled';

export type ReticleColorId = 'red' | 'green' | 'amber' | 'cyan';

export interface ReticleColorOption {
  id: ReticleColorId;
  label: string;
  hex: number;
  swatch: string;
}

export const RETICLE_COLOR_OPTIONS: readonly ReticleColorOption[] = [
  { id: 'red', label: 'Red', hex: 0xff281b, swatch: '#ff3426' },
  { id: 'green', label: 'Green', hex: 0x36ff5e, swatch: '#38f263' },
  { id: 'amber', label: 'Amber', hex: 0xffaa1d, swatch: '#ffb020' },
  { id: 'cyan', label: 'Cyan', hex: 0x32e6ff, swatch: '#38e6ff' },
];

export function isValidReticleColorId(val: unknown): val is ReticleColorId {
  return val === 'red' || val === 'green' || val === 'amber' || val === 'cyan';
}

export function resolveReticleColorHex(
  colorId?: ReticleColorId | null,
  fallbackHex = 0xff281b,
): number {
  if (!colorId) return fallbackHex;
  const opt = RETICLE_COLOR_OPTIONS.find((o) => o.id === colorId);
  return opt ? opt.hex : fallbackHex;
}

/**
 * Modular firearm attachment state.
 * Stored directly on WeaponInstance.attachments and persisted in SaveManager.
 */
export interface WeaponAttachments {
  /** Dedicated rail mount adapter (e.g. Zenitco B-13 AK dovetail-to-Picatinny or HK MP5 claw mount) */
  railAdapter?: string | null;
  optic?: string | null;
  canted?: string | null;
  muzzle?: string | null;
  /** True when the player owns an installed suppressor in `muzzle` but has unscrewed and stowed it in their vest pouch. */
  suppressorStowed?: boolean;
  tactical?: string | null;
  foregrip?: string | null;
  magazine?: string | null;
  reticleColor?: ReticleColorId | null;
  cantedReticleColor?: ReticleColorId | null;
  /** Persisted ammo variant ID & ballistic zero configuration per firearm */
  selectedAmmoId?: string | null;
  zeroDistanceM?: number;
  zeroElevationMrad?: number;
}

export function getOwnedSuppressorDef(attachments?: WeaponAttachments | null): AttachmentDef | null {
  const id = attachments?.muzzle;
  if (!id) return null;
  const def = ATTACHMENTS[id];
  return def && def.slot === 'muzzle' && def.isSuppressor ? def : null;
}

export interface WeaponInstance {
  id: string;
  weaponId: string;
  attachments: WeaponAttachments;
  selectedAmmoId?: string;
  zeroDistanceM?: number;
  zeroElevationMrad?: number;
  chambered?: boolean;
  ammoInMag?: number;
}

export interface AttachmentDef {
  id: string;
  name: string;
  shortName: string;
  slot: AttachmentSlot;
  description: string;
  compatibleWeapons: readonly string[];
  compatibleRails?: readonly WeaponRailType[];
  compatibleCategories?: readonly WeaponCategory[];
  excludedWeapons?: readonly string[];
  requiresSuppressorSupport?: boolean;

  // Physical & handling deltas
  massKg: number;
  ergonomicsDelta: number; // + faster ADS / crisper handling, - heavier/slower
  extraLengthM: number; // Added barrel length for muzzle devices (wall pullback + socket shift)

  // Ballistic / recoil multipliers (1.0 = neutral)
  recoilPitchMult: number;
  recoilYawMult: number;
  sightMisalignMult: number;
  velocityMult?: number;

  // Optics
  reticleType?:
    | 'kobra_chevron'
    | 'eotech_holo'
    | 't2_dot'
    | 'rmr_dot'
    | 'pso_prism'
    | 'lpvo_mildot'
    | 'sniper_mildot';
  hasIlluminatedReticle?: boolean;
  opticHeightOffsetM?: number;
  opticEyeReliefM?: number;
  adsZoomFactor?: number; // >1.0 reduces ADS HFOV for magnified prism/scopes
  hasVariableZoom?: boolean;
  zoomLevels?: readonly number[];
  ocularRadiusM?: number;

  // Muzzle
  isSuppressor?: boolean;
  acousticRadiusMult?: number;
  muzzleFlashScale?: number;

  // Tactical
  enablesFlashlight?: boolean;
  enablesLaser?: boolean;

  // Foregrip IK override
  foregripPose?: ForegripPoseStyle;
  leftHandSocketOffset?: readonly [number, number, number];
  leftHandRotOffset?: readonly [number, number, number];
  leftGripCurl?: number;

  // Rail Adapter
  grantsPicatinnyRail?: boolean;
  requiresPicatinnyRail?: boolean;

  // Magazine / Caliber Conversion
  capacityOverride?: number;
  reloadDurationMult?: number;
  caliberOverride?: BaseCaliberId;
  barrelLengthOverrideM?: number;
}

export interface WeaponCompatMeta {
  railType: WeaponRailType;
  category: WeaponCategory;
  supportsSuppressor: boolean;
  supportsCanted?: boolean;
  supportsForegrip?: boolean;
  supportsLaser?: boolean;
  isRevolver?: boolean;
}

/**
 * Self-contained weapon compatibility metadata (zero circular imports) covering all
 * 42 arsenal firearms + legacy Survival weapon IDs.
 */
export const WEAPON_COMPAT_META: Record<string, WeaponCompatMeta> = {
  // Legacy Survival aliases
  pm_9x19: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  aks74u_545: { railType: 'dovetail_ak', category: 'pdws', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  ak74u_545: { railType: 'dovetail_ak', category: 'pdws', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  m4_556: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  akm_762: { railType: 'dovetail_ak', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  mp133_12ga: { railType: 'picatinny_top', category: 'shotguns', supportsSuppressor: false, supportsCanted: true, supportsLaser: true },

  // 1. Carbines (5)
  m4a1: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  hk416: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  fn_scar_l: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  sig_mcx: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  colt_c8: { railType: 'picatinny_top', category: 'carbines', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },

  // 2. Compact Carbines & PDWs (5)
  aks74u: { railType: 'dovetail_ak', category: 'pdws', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  ak105: { railType: 'dovetail_ak', category: 'pdws', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  sig_sg552: { railType: 'picatinny_top', category: 'pdws', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  hk_mp5: { railType: 'mp5_claw', category: 'pdws', supportsSuppressor: true, supportsCanted: false, supportsForegrip: true, supportsLaser: true },
  fn_p90: { railType: 'p90_rail', category: 'pdws', supportsSuppressor: true, supportsCanted: false, supportsForegrip: false, supportsLaser: true },

  // 3. Bolt-Action Precision Rifles (6)
  remington_m24: { railType: 'picatinny_top', category: 'bolt_action', supportsSuppressor: true, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  ai_awm: { railType: 'picatinny_top', category: 'bolt_action', supportsSuppressor: true, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  mosin_m91_30: { railType: 'dovetail_ak', category: 'bolt_action', supportsSuppressor: false, supportsCanted: false, supportsForegrip: false, supportsLaser: false },
  sv_98: { railType: 'picatinny_top', category: 'bolt_action', supportsSuppressor: true, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  barrett_mrad: { railType: 'picatinny_top', category: 'bolt_action', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  colt_c19: { railType: 'picatinny_top', category: 'bolt_action', supportsSuppressor: false, supportsCanted: false, supportsForegrip: false, supportsLaser: false },

  // 4. Designated Marksman Rifles (6)
  dragunov_svd: { railType: 'dovetail_ak', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  mk14_ebr: { railType: 'picatinny_top', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  kac_m110: { railType: 'picatinny_top', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  hk_g28: { railType: 'picatinny_top', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  fn_scar_h_pr: { railType: 'picatinny_top', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  colt_c20: { railType: 'picatinny_top', category: 'dmrs', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },

  // 5. Service & Magnum Pistols (8)
  makarov_pm: { railType: 'none_revolver', category: 'pistols', supportsSuppressor: false, supportsLaser: false },
  mp443_grach: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  pl15: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  beretta_m9: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  sig_p226: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  glock_17: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  jericho_941: { railType: 'pistol_milled', category: 'pistols', supportsSuppressor: true, supportsLaser: true },
  desert_eagle_xix: { railType: 'picatinny_top', category: 'pistols', supportsSuppressor: false, supportsLaser: true },

  // 6. Tactical Shotguns (6)
  benelli_m4: { railType: 'picatinny_top', category: 'shotguns', supportsSuppressor: true, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  mossberg_590a1: { railType: 'picatinny_top', category: 'shotguns', supportsSuppressor: false, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  remington_870: { railType: 'picatinny_top', category: 'shotguns', supportsSuppressor: false, supportsCanted: true, supportsForegrip: false, supportsLaser: true },
  saiga_12: { railType: 'dovetail_ak', category: 'shotguns', supportsSuppressor: true, supportsCanted: true, supportsForegrip: true, supportsLaser: true },
  ks_23: { railType: 'none_revolver', category: 'shotguns', supportsSuppressor: false, supportsCanted: false, supportsForegrip: false, supportsLaser: false },
  spas_12: { railType: 'picatinny_top', category: 'shotguns', supportsSuppressor: false, supportsCanted: false, supportsForegrip: false, supportsLaser: true },

  // 7. Revolvers (6)
  nagant_m1895: { railType: 'nagant_threaded', category: 'revolvers', supportsSuppressor: true, isRevolver: true },
  sw_model_10: { railType: 'none_revolver', category: 'revolvers', supportsSuppressor: false, isRevolver: true },
  webley_mk6: { railType: 'none_revolver', category: 'revolvers', supportsSuppressor: false, isRevolver: true },
  colt_python: { railType: 'none_revolver', category: 'revolvers', supportsSuppressor: false, isRevolver: true },
  sw_model_29: { railType: 'none_revolver', category: 'revolvers', supportsSuppressor: false, isRevolver: true },
  chiappa_rhino: { railType: 'picatinny_top', category: 'revolvers', supportsSuppressor: false, supportsLaser: true, isRevolver: true },
};

export const ATTACHMENT_SLOTS: readonly { slot: AttachmentSlot; pinLabel: string; title: string }[] = [
  { slot: 'railAdapter', pinLabel: 'ADAPTER', title: 'Rail Adapter Mount' },
  { slot: 'optic', pinLabel: 'OPTIC', title: 'Optics & Sights' },
  { slot: 'canted', pinLabel: 'CANT', title: '45° Canted Backup Optic' },
  { slot: 'muzzle', pinLabel: 'MUZZLE', title: 'Muzzle Devices' },
  { slot: 'tactical', pinLabel: 'RAIL', title: 'Tactical Light / Laser' },
  { slot: 'foregrip', pinLabel: 'GRIP', title: 'Forend & Grips' },
  { slot: 'magazine', pinLabel: 'MAG / CONV', title: 'Magazine & Caliber Conv.' },
];

export const ATTACHMENTS: Record<string, AttachmentDef> = {
  // === RAIL ADAPTERS ===
  rail_b13_dovetail: {
    id: 'rail_b13_dovetail',
    name: 'Zenitco B-13 Dovetail-to-Picatinny Rail',
    shortName: 'B-13 Rail',
    slot: 'railAdapter',
    description: 'CNC-milled Russian side-rail bridge converting AK/SVD/Saiga dovetails to a full MIL-STD-1913 Picatinny top rail.',
    compatibleWeapons: ['aks74u', 'ak105', 'dragunov_svd', 'saiga_12', 'aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleRails: ['dovetail_ak'],
    excludedWeapons: ['mosin_m91_30'],
    massKg: 0.16,
    ergonomicsDelta: -1,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.0,
    grantsPicatinnyRail: true,
  },
  rail_mp5_claw: {
    id: 'rail_mp5_claw',
    name: 'HK MFI Low-Profile MP5 Claw Rail',
    shortName: 'MP5 Claw',
    slot: 'railAdapter',
    description: 'Four-point steel claw mount clamping onto the MP5 receiver slots to provide a MIL-STD-1913 Picatinny optic rail.',
    compatibleWeapons: ['hk_mp5'],
    compatibleRails: ['mp5_claw'],
    massKg: 0.13,
    ergonomicsDelta: -1,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.0,
    grantsPicatinnyRail: true,
  },

  // === CANONICAL REAL-LIFE OPTICS ===
  optic_pso1m2: {
    id: 'optic_pso1m2',
    name: 'PSO-1M2 4×24 Prism',
    shortName: 'PSO-1M2 4×',
    slot: 'optic',
    description: 'Fixed 4.0× Soviet side-rail dovetail prism scope with rubber eyecup, 1.7m stadiametric rangefinder, and illuminated amber/red chevrons.',
    compatibleWeapons: ['aks74u', 'ak105', 'dragunov_svd', 'saiga_12', 'aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleRails: ['dovetail_ak'],
    compatibleCategories: ['dmrs', 'bolt_action', 'carbines', 'pdws', 'shotguns'],
    massKg: 0.62,
    ergonomicsDelta: -8,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.05,
    reticleType: 'pso_prism',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.044,
    opticEyeReliefM: 0.112,
    adsZoomFactor: 4.0,
    hasVariableZoom: false,
    zoomLevels: [4.0],
    ocularRadiusM: 0.0144,
  },
  optic_razor_1_6: {
    id: 'optic_razor_1_6',
    name: 'Vortex Razor HD Gen II-E 1–6×24 LPVO',
    shortName: 'Razor 1–6×',
    slot: 'optic',
    description: 'Variable 1.0×–6.0× HD LPVO in 30mm cantilever mount with rotating magnification throw lever & daylight-bright JM-1/Mil-Dot reticle.',
    compatibleWeapons: [
      'm4a1', 'hk416', 'fn_scar_l', 'sig_mcx', 'colt_c8', 'sig_sg552', 'fn_p90',
      'remington_m24', 'ai_awm', 'sv_98', 'barrett_mrad', 'colt_c19',
      'mk14_ebr', 'kac_m110', 'hk_g28', 'fn_scar_h_pr', 'colt_c20',
      'm4_556',
    ],
    compatibleRails: ['picatinny_top', 'p90_rail'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action'],
    excludedWeapons: ['desert_eagle_xix', 'chiappa_rhino', 'mosin_m91_30'],
    requiresPicatinnyRail: true,
    massKg: 0.61,
    ergonomicsDelta: -10,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.04,
    reticleType: 'lpvo_mildot',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.044,
    opticEyeReliefM: 0.118,
    adsZoomFactor: 1.0,
    hasVariableZoom: true,
    zoomLevels: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    ocularRadiusM: 0.0152,
  },
  optic_rmr_type2: {
    id: 'optic_rmr_type2',
    name: 'Trijicon RMR Type 2 1× Reflex',
    shortName: 'RMR Type 2',
    slot: 'optic',
    description: 'Parallax-collimated 3.25 MOA reflex sight with light-reactive glass. Mounts direct to milled pistol slides or via Picatinny riser on long guns.',
    compatibleWeapons: [],
    compatibleRails: ['pistol_milled', 'picatinny_top', 'p90_rail'],
    compatibleCategories: ['pistols', 'shotguns', 'pdws', 'carbines', 'dmrs', 'revolvers'],
    excludedWeapons: ['mosin_m91_30'],
    requiresPicatinnyRail: true,
    massKg: 0.042,
    ergonomicsDelta: 6,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.91,
    reticleType: 'rmr_dot',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.022,
    opticEyeReliefM: 0.24,
    adsZoomFactor: 1.03,
  },
  // Legacy alias retained for existing saved loadouts
  optic_rmr_micro: {
    id: 'optic_rmr_micro',
    name: 'Trijicon RMR Type 2 Micro RDS',
    shortName: 'RMR RDS',
    slot: 'optic',
    description: 'Ruggedized milled-slide / low-profile 3.25 MOA reflex red dot for pistols, shotguns, and P90 rails.',
    compatibleWeapons: [],
    compatibleRails: ['pistol_milled', 'picatinny_top', 'p90_rail'],
    compatibleCategories: ['pistols', 'shotguns', 'pdws', 'carbines', 'revolvers'],
    requiresPicatinnyRail: true,
    massKg: 0.04,
    ergonomicsDelta: 6,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.92,
    reticleType: 'rmr_dot',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.022,
    opticEyeReliefM: 0.24,
    adsZoomFactor: 1.03,
  },
  optic_kobra_rd: {
    id: 'optic_kobra_rd',
    name: 'Kobra EKP-1S-03 Reflex',
    shortName: 'Kobra RD',
    slot: 'optic',
    description: 'Russian dovetail reflex sight with parallax-free 3-bar chevron reticle.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleRails: ['dovetail_ak'],
    excludedWeapons: ['mosin_m91_30'],
    massKg: 0.38,
    ergonomicsDelta: 4,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.94,
    reticleType: 'kobra_chevron',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.044,
    opticEyeReliefM: 0.23,
    adsZoomFactor: 1.08,
  },
  optic_eotech_holo: {
    id: 'optic_eotech_holo',
    name: 'EOTech EXPS3 Holographic',
    shortName: 'EXPS3 Holo',
    slot: 'optic',
    description: 'Ruggedized holographic sight with wide window and 68 MOA circle-dot.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762', 'mp133_12ga'],
    compatibleRails: ['picatinny_top', 'mp5_claw', 'p90_rail', 'dovetail_ak'],
    excludedWeapons: ['desert_eagle_xix', 'chiappa_rhino', 'mosin_m91_30'],
    massKg: 0.32,
    ergonomicsDelta: 5,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.90,
    reticleType: 'eotech_holo',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.042,
    opticEyeReliefM: 0.22,
    adsZoomFactor: 1.12,
  },
  optic_t2_red_dot: {
    id: 'optic_t2_red_dot',
    name: 'Aimpoint Micro T-2 Red Dot',
    shortName: 'Micro T-2',
    slot: 'optic',
    description: 'Compact sealed 20mm tube red dot with crisp 2 MOA LED emitter & AR notch coating.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762', 'mp133_12ga'],
    compatibleRails: ['picatinny_top', 'mp5_claw', 'p90_rail', 'dovetail_ak'],
    excludedWeapons: ['desert_eagle_xix', 'mosin_m91_30'],
    massKg: 0.14,
    ergonomicsDelta: 6,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.90,
    reticleType: 't2_dot',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.042,
    opticEyeReliefM: 0.22,
    adsZoomFactor: 1.05,
  },
  optic_pso1_4x: {
    id: 'optic_pso1_4x',
    name: 'PSO-1 / PU Side-Mount 4x24 Scope',
    shortName: 'PSO-1 4x',
    slot: 'optic',
    description: 'Classic Soviet dovetail 4x sniper optic with stadiametric rangefinder & illuminated chevrons.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleRails: ['dovetail_ak'],
    compatibleCategories: ['dmrs', 'bolt_action', 'carbines', 'pdws'],
    massKg: 0.62,
    ergonomicsDelta: -9,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.06,
    reticleType: 'pso_prism',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.044,
    opticEyeReliefM: 0.115,
    adsZoomFactor: 4.0,
    hasVariableZoom: true,
    zoomLevels: [2.8, 4.0],
    ocularRadiusM: 0.0148,
  },
  optic_pso4: {
    id: 'optic_pso4',
    name: 'PSO-4M2 2.8x/4x Prism Scope',
    shortName: 'PSO-4 4x',
    slot: 'optic',
    description: 'Magnified Russian rangefinder prism scope with PiP HDR glass & 2.8x/4x zoom.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762', 'm4_556'],
    compatibleRails: ['picatinny_top', 'dovetail_ak'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action'],
    excludedWeapons: ['desert_eagle_xix', 'chiappa_rhino'],
    massKg: 0.62,
    ergonomicsDelta: -10,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.08,
    reticleType: 'pso_prism',
    hasIlluminatedReticle: false,
    opticHeightOffsetM: 0.042,
    opticEyeReliefM: 0.115,
    adsZoomFactor: 4.0,
    hasVariableZoom: true,
    zoomLevels: [2.8, 4.0],
    ocularRadiusM: 0.0148,
  },
  optic_lpvo_1_6: {
    id: 'optic_lpvo_1_6',
    name: 'Razor HD 1-6x24 LPVO (Legacy)',
    shortName: '1-6x LPVO',
    slot: 'optic',
    description: 'Variable 1x–6x low-power tactical optic with PiP HDR glass & illuminated Mil-Dot.',
    compatibleWeapons: ['m4_556'],
    compatibleRails: ['picatinny_top', 'p90_rail'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action'],
    excludedWeapons: ['desert_eagle_xix', 'chiappa_rhino', 'mosin_m91_30'],
    requiresPicatinnyRail: true,
    massKg: 0.68,
    ergonomicsDelta: -12,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.06,
    reticleType: 'lpvo_mildot',
    hasIlluminatedReticle: true,
    opticHeightOffsetM: 0.044,
    opticEyeReliefM: 0.120,
    adsZoomFactor: 1.0,
    hasVariableZoom: true,
    zoomLevels: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
    ocularRadiusM: 0.0152,
  },
  optic_nightforce_atacr: {
    id: 'optic_nightforce_atacr',
    name: 'Nightforce ATACR 5-25x56 F1',
    shortName: 'ATACR 5-25x',
    slot: 'optic',
    description: 'Long-range first focal plane precision rifle scope with 5x/10x/16x/25x magnification and Mil-XT grid.',
    compatibleWeapons: [],
    compatibleRails: ['picatinny_top'],
    compatibleCategories: ['bolt_action', 'dmrs'],
    massKg: 1.08,
    ergonomicsDelta: -18,
    extraLengthM: 0,
    recoilPitchMult: 0.96,
    recoilYawMult: 0.98,
    sightMisalignMult: 1.12,
    reticleType: 'sniper_mildot',
    hasIlluminatedReticle: false,
    opticHeightOffsetM: 0.048,
    opticEyeReliefM: 0.118,
    adsZoomFactor: 10.0,
    hasVariableZoom: true,
    zoomLevels: [5.0, 10.0, 16.0, 25.0],
    ocularRadiusM: 0.0175,
  },

  // === 45° CANTED BACKUP OPTICS (Compact 1x Red Dot / Holo only) ===
  canted_t2_red_dot: {
    id: 'canted_t2_red_dot',
    name: '45° Offset Mount + Micro T-2 RDS',
    shortName: '45° T-2 RDS',
    slot: 'canted',
    description: '45° canted offset rail mount with compact Micro T-2 2 MOA red dot. Toggle [B] for canted ADS.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762', 'mp133_12ga'],
    compatibleRails: ['picatinny_top', 'dovetail_ak'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'shotguns'],
    massKg: 0.18,
    ergonomicsDelta: -1,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.96,
    reticleType: 't2_dot',
    hasIlluminatedReticle: true,
    opticEyeReliefM: 0.21,
    adsZoomFactor: 1.04,
  },
  canted_eotech_holo: {
    id: 'canted_eotech_holo',
    name: '45° Offset Mount + EXPS3 Holo',
    shortName: '45° EXPS3',
    slot: 'canted',
    description: '45° canted offset mount carrying an EOTech holographic sight for instant CQB sight picture.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762', 'mp133_12ga'],
    compatibleRails: ['picatinny_top', 'dovetail_ak'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'shotguns'],
    massKg: 0.35,
    ergonomicsDelta: -3,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.94,
    reticleType: 'eotech_holo',
    hasIlluminatedReticle: true,
    opticEyeReliefM: 0.22,
    adsZoomFactor: 1.05,
  },
  canted_kobra_rd: {
    id: 'canted_kobra_rd',
    name: '45° Offset Mount + Open Reflex',
    shortName: '45° Reflex',
    slot: 'canted',
    description: '45° canted offset mount with open-hood chevron reflex sight for quick close-range transitions.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762', 'mp133_12ga'],
    compatibleRails: ['picatinny_top', 'dovetail_ak'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'shotguns'],
    massKg: 0.24,
    ergonomicsDelta: -2,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.95,
    reticleType: 'kobra_chevron',
    hasIlluminatedReticle: true,
    opticEyeReliefM: 0.22,
    adsZoomFactor: 1.04,
  },

  // === MUZZLES ===
  muzzle_pbs4_545: {
    id: 'muzzle_pbs4_545',
    name: 'RC2 / PBS-4 Tactical Rifle Suppressor',
    shortName: 'Rifle Supp.',
    slot: 'muzzle',
    description: 'Baffled intermediate/full-power rifle sound suppressor. Cuts blast & flash.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762', 'm4_556'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs'],
    requiresSuppressorSupport: true,
    excludedWeapons: ['hk_mp5'],
    massKg: 0.56,
    ergonomicsDelta: -9,
    extraLengthM: 0.165,
    recoilPitchMult: 0.88,
    recoilYawMult: 0.92,
    sightMisalignMult: 0.94,
    velocityMult: 1.015,
    isSuppressor: true,
    acousticRadiusMult: 0.28,
    muzzleFlashScale: 0.14,
  },
  muzzle_338_suppressor: {
    id: 'muzzle_338_suppressor',
    name: 'TBAC 338 Ultra Precision Suppressor',
    shortName: '.338 Supp.',
    slot: 'muzzle',
    description: 'Titanium long-range precision suppressor rated up to .338 Lapua & .338 Norma Magnum.',
    compatibleWeapons: [],
    compatibleCategories: ['bolt_action', 'dmrs'],
    requiresSuppressorSupport: true,
    massKg: 0.62,
    ergonomicsDelta: -10,
    extraLengthM: 0.22,
    recoilPitchMult: 0.78,
    recoilYawMult: 0.85,
    sightMisalignMult: 0.90,
    velocityMult: 1.02,
    isSuppressor: true,
    acousticRadiusMult: 0.30,
    muzzleFlashScale: 0.10,
  },
  muzzle_9mm_suppressor: {
    id: 'muzzle_9mm_suppressor',
    name: 'Osprey / Tirant 9mm Suppressor',
    shortName: '9mm Supp.',
    slot: 'muzzle',
    description: 'Threaded 9x19mm pistol & SMG silencer with Nielsen booster piston.',
    compatibleWeapons: ['pm_9x19', 'hk_mp5'],
    compatibleCategories: ['pistols'],
    requiresSuppressorSupport: true,
    massKg: 0.31,
    ergonomicsDelta: -5,
    extraLengthM: 0.152,
    recoilPitchMult: 0.86,
    recoilYawMult: 0.90,
    sightMisalignMult: 0.92,
    velocityMult: 1.01,
    isSuppressor: true,
    acousticRadiusMult: 0.25,
    muzzleFlashScale: 0.12,
  },
  muzzle_nagant_bramit: {
    id: 'muzzle_nagant_bramit',
    name: 'Bramit Gas-Seal Revolver Suppressor',
    shortName: 'Bramit Supp.',
    slot: 'muzzle',
    description: 'Historic Soviet rubber-wipe silencer exploiting the Nagant M1895 forward-sealing cylinder.',
    compatibleWeapons: ['nagant_m1895'],
    compatibleRails: ['nagant_threaded'],
    requiresSuppressorSupport: true,
    massKg: 0.26,
    ergonomicsDelta: -4,
    extraLengthM: 0.145,
    recoilPitchMult: 0.84,
    recoilYawMult: 0.90,
    sightMisalignMult: 0.90,
    velocityMult: 0.98,
    isSuppressor: true,
    acousticRadiusMult: 0.20,
    muzzleFlashScale: 0.08,
  },
  muzzle_salvo_12ga: {
    id: 'muzzle_salvo_12ga',
    name: 'Salvo 12 Modular Shotgun Suppressor',
    shortName: 'Salvo 12 Supp.',
    slot: 'muzzle',
    description: 'Heavy rectangular baffled 12-gauge suppressor for semi-auto tactical shotguns.',
    compatibleWeapons: ['benelli_m4', 'saiga_12'],
    compatibleCategories: ['shotguns'],
    requiresSuppressorSupport: true,
    massKg: 0.78,
    ergonomicsDelta: -12,
    extraLengthM: 0.205,
    recoilPitchMult: 0.82,
    recoilYawMult: 0.88,
    sightMisalignMult: 0.92,
    velocityMult: 1.01,
    isSuppressor: true,
    acousticRadiusMult: 0.34,
    muzzleFlashScale: 0.15,
  },
  muzzle_comp_ak: {
    id: 'muzzle_comp_ak',
    name: 'DTK-2 / SureFire Ported Muzzle Brake',
    shortName: 'Ported Brake',
    slot: 'muzzle',
    description: 'Dual-baffle compensator brake. Cuts vertical muzzle climb at the cost of louder blast & flash.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762', 'm4_556'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action'],
    excludedWeapons: ['fn_p90', 'hk_mp5', 'mosin_m91_30', 'colt_c19'],
    massKg: 0.15,
    ergonomicsDelta: -2,
    extraLengthM: 0.056,
    recoilPitchMult: 0.72,
    recoilYawMult: 0.86,
    sightMisalignMult: 0.84,
    isSuppressor: false,
    acousticRadiusMult: 1.38,
    muzzleFlashScale: 1.65,
  },

  // === TACTICAL ===
  tac_flashlight: {
    id: 'tac_flashlight',
    name: 'Klesh-2 / X300 Tactical Weapon Light',
    shortName: 'WML Light',
    slot: 'tactical',
    description: 'Rail-mounted high-candela LED weapon light. Enables [F] flashlight toggle.',
    compatibleWeapons: ['pm_9x19', 'aks74u_545', 'ak74u_545', 'm4_556', 'akm_762', 'mp133_12ga'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'pistols', 'shotguns', 'revolvers'],
    excludedWeapons: ['mosin_m91_30', 'colt_c19', 'makarov_pm', 'ks_23', 'nagant_m1895', 'sw_model_10', 'webley_mk6', 'colt_python', 'sw_model_29'],
    massKg: 0.14,
    ergonomicsDelta: -2,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.0,
    enablesFlashlight: true,
    enablesLaser: false,
  },
  tac_laser_red: {
    id: 'tac_laser_red',
    name: 'Perst-4 Visible/IR Laser',
    shortName: 'Perst-4 Laser',
    slot: 'tactical',
    description: 'Precision collimated aiming laser emitter. Enables [L] laser & [Alt+L] IR mode.',
    compatibleWeapons: ['pm_9x19', 'aks74u_545', 'ak74u_545', 'm4_556', 'akm_762'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'pistols', 'shotguns', 'revolvers'],
    excludedWeapons: ['mosin_m91_30', 'colt_c19', 'makarov_pm', 'ks_23', 'nagant_m1895', 'sw_model_10', 'webley_mk6', 'colt_python', 'sw_model_29'],
    massKg: 0.18,
    ergonomicsDelta: -2,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.96,
    enablesFlashlight: false,
    enablesLaser: true,
  },
  tac_peq_combo: {
    id: 'tac_peq_combo',
    name: 'AN/PEQ-15 + Scout Light Combo',
    shortName: 'PEQ + Light',
    slot: 'tactical',
    description: 'Dual FDE laser designator and scout floodlight module. Enables both [F] & [L].',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'm4_556', 'akm_762'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action', 'shotguns'],
    excludedWeapons: ['mosin_m91_30', 'colt_c19', 'ks_23'],
    massKg: 0.31,
    ergonomicsDelta: -4,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 0.95,
    enablesFlashlight: true,
    enablesLaser: true,
  },

  // === FOREGRIPS ===
  grip_vertical_rk: {
    id: 'grip_vertical_rk',
    name: 'Zenitco RK-1 Vertical Foregrip',
    shortName: 'RK-1 VFG',
    slot: 'foregrip',
    description: 'Knurled vertical grip. Shifts support hand into a locked fist grip & stabilizes rapid fire.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs'],
    excludedWeapons: ['fn_p90', 'dragunov_svd'],
    massKg: 0.19,
    ergonomicsDelta: 8,
    extraLengthM: 0,
    recoilPitchMult: 0.82,
    recoilYawMult: 0.78,
    sightMisalignMult: 0.80,
    foregripPose: 'vertical',
    leftHandSocketOffset: [0.004, -0.052, 0.008],
    leftHandRotOffset: [-0.08, 0.18, -0.62],
    leftGripCurl: 1.02,
  },
  grip_angled_afg: {
    id: 'grip_angled_afg',
    name: 'AFG-2 Angled Forend Grip',
    shortName: 'AFG-2 Grip',
    slot: 'foregrip',
    description: 'Low-profile c-clamp angled foregrip. Maximizes target transition & ADS speed.',
    compatibleWeapons: ['m4_556', 'aks74u_545', 'ak74u_545', 'akm_762'],
    compatibleCategories: ['carbines', 'pdws', 'dmrs', 'bolt_action'],
    excludedWeapons: ['fn_p90', 'mosin_m91_30', 'colt_c19', 'dragunov_svd'],
    massKg: 0.11,
    ergonomicsDelta: 14,
    extraLengthM: 0,
    recoilPitchMult: 0.90,
    recoilYawMult: 0.88,
    sightMisalignMult: 0.88,
    foregripPose: 'angled',
    leftHandSocketOffset: [0.0, -0.018, -0.006],
    leftHandRotOffset: [0.04, 0.08, -0.18],
    leftGripCurl: 0.86,
  },

  // === MAGAZINES & CALIBER CONVERSIONS ===
  mag_pm_12: {
    id: 'mag_pm_12',
    name: 'Compact Flush Pistol Magazine',
    shortName: 'Compact Mag',
    slot: 'magazine',
    description: 'Flush-fit steel pistol magazine. Lighter balance & faster draw.',
    compatibleWeapons: ['pm_9x19', 'mp443_grach', 'pl15', 'beretta_m9', 'sig_p226', 'glock_17', 'jericho_941'],
    massKg: -0.04,
    ergonomicsDelta: 5,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.0,
    capacityOverride: 12,
    reloadDurationMult: 0.90,
  },
  mag_ak_30: {
    id: 'mag_ak_30',
    name: '30-Rd Standard AK Magazine',
    shortName: '30rd Std',
    slot: 'magazine',
    description: 'Standard 30-round polymer/stamped steel AK magazine.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762', 'aks74u', 'ak105'],
    massKg: 0.0,
    ergonomicsDelta: 2,
    extraLengthM: 0,
    recoilPitchMult: 1.0,
    recoilYawMult: 1.0,
    sightMisalignMult: 1.0,
    capacityOverride: 30,
    reloadDurationMult: 1.0,
  },
  mag_ak_45_bakelite: {
    id: 'mag_ak_45_bakelite',
    name: '45-Rd RPK-74 Bakelite Mag',
    shortName: '45rd Bakelite',
    slot: 'magazine',
    description: 'Extended curved AG-4S marbled bakelite magazine. +50% capacity with added weight.',
    compatibleWeapons: ['aks74u_545', 'ak74u_545', 'akm_762', 'aks74u', 'ak105'],
    massKg: 0.26,
    ergonomicsDelta: -8,
    extraLengthM: 0,
    recoilPitchMult: 0.95,
    recoilYawMult: 0.98,
    sightMisalignMult: 0.96,
    capacityOverride: 45,
    reloadDurationMult: 1.14,
  },
  mag_m4_60_quad: {
    id: 'mag_m4_60_quad',
    name: '60-Rd SureFire Quad-Stack Mag',
    shortName: '60rd Quad',
    slot: 'magazine',
    description: 'Double-capacity 5.56 quad-column casket magazine. Heavy front-bottom mass.',
    compatibleWeapons: ['m4_556', 'm4a1', 'hk416', 'fn_scar_l', 'sig_mcx', 'colt_c8'],
    massKg: 0.44,
    ergonomicsDelta: -13,
    extraLengthM: 0,
    recoilPitchMult: 0.92,
    recoilYawMult: 0.96,
    sightMisalignMult: 0.94,
    capacityOverride: 60,
    reloadDurationMult: 1.22,
  },
  mag_ar10_20: {
    id: 'mag_ar10_20',
    name: '20-Rd KAC / SCAR-H Steel DMR Mag',
    shortName: '20rd DMR',
    slot: 'magazine',
    description: 'Extended 20-round 7.62x51mm steel magazine for sustained DMR engagements.',
    compatibleWeapons: ['dragunov_svd', 'mk14_ebr', 'kac_m110', 'hk_g28', 'fn_scar_h_pr', 'colt_c20'],
    massKg: 0.22,
    ergonomicsDelta: -5,
    extraLengthM: 0,
    recoilPitchMult: 0.96,
    recoilYawMult: 0.98,
    sightMisalignMult: 0.97,
    capacityOverride: 20,
    reloadDurationMult: 1.08,
  },
  mag_saiga_10: {
    id: 'mag_saiga_10',
    name: '10-Rd SGM 12ga Box Magazine',
    shortName: '10rd 12ga',
    slot: 'magazine',
    description: 'Extended 10-shell polymer box magazine for Saiga-12 tactical shotguns.',
    compatibleWeapons: ['saiga_12'],
    massKg: 0.34,
    ergonomicsDelta: -7,
    extraLengthM: 0,
    recoilPitchMult: 0.94,
    recoilYawMult: 0.96,
    sightMisalignMult: 0.95,
    capacityOverride: 10,
    reloadDurationMult: 1.15,
  },

  // === MODULAR CALIBER CONVERSIONS (Barrett MRAD & Desert Eagle XIX) ===
  conv_mrad_300nm: {
    id: 'conv_mrad_300nm',
    name: 'Mk22 .300 Norma Magnum Barrel Kit',
    shortName: '.300 NM Kit',
    slot: 'magazine',
    description: 'SOCOM 26-inch .300 Norma Magnum barrel & bolt-head conversion (~5,960 J extreme long-range ballistics).',
    compatibleWeapons: ['barrett_mrad'],
    massKg: 0.45,
    ergonomicsDelta: -4,
    extraLengthM: 0.05,
    recoilPitchMult: 1.24,
    recoilYawMult: 1.15,
    sightMisalignMult: 1.08,
    velocityMult: 1.04,
    caliberOverride: '300_nm',
    capacityOverride: 10,
    reloadDurationMult: 1.04,
  },
  conv_mrad_338nm: {
    id: 'conv_mrad_338nm',
    name: 'Mk22 .338 Norma Magnum Barrel Kit',
    shortName: '.338 NM Kit',
    slot: 'magazine',
    description: 'Heavy 27-inch .338 Norma Magnum barrel & bolt conversion (300gr Hybrid OTM, BC 0.822, ~6,635 J).',
    compatibleWeapons: ['barrett_mrad'],
    massKg: 0.72,
    ergonomicsDelta: -8,
    extraLengthM: 0.075,
    recoilPitchMult: 1.42,
    recoilYawMult: 1.24,
    sightMisalignMult: 1.14,
    velocityMult: 1.05,
    caliberOverride: '338_nm',
    capacityOverride: 8,
    reloadDurationMult: 1.08,
  },
  conv_deagle_44: {
    id: 'conv_deagle_44',
    name: 'Desert Eagle .44 Magnum Conversion',
    shortName: '.44 Mag Kit',
    slot: 'magazine',
    description: 'Swap barrel, bolt, and 8-round magazine to .44 Magnum for flatter recovery & +1 capacity.',
    compatibleWeapons: ['desert_eagle_xix'],
    massKg: -0.04,
    ergonomicsDelta: 6,
    extraLengthM: 0,
    recoilPitchMult: 0.76,
    recoilYawMult: 0.82,
    sightMisalignMult: 0.84,
    caliberOverride: '44_mag',
    capacityOverride: 8,
    reloadDurationMult: 0.96,
  },
  conv_deagle_357: {
    id: 'conv_deagle_357',
    name: 'Desert Eagle .357 Magnum Conversion',
    shortName: '.357 Mag Kit',
    slot: 'magazine',
    description: 'Swap barrel, bolt, and 9-round magazine to .357 Magnum for rapid follow-up control.',
    compatibleWeapons: ['desert_eagle_xix'],
    massKg: -0.08,
    ergonomicsDelta: 10,
    extraLengthM: 0,
    recoilPitchMult: 0.58,
    recoilYawMult: 0.68,
    sightMisalignMult: 0.72,
    caliberOverride: '357_mag',
    capacityOverride: 9,
    reloadDurationMult: 0.92,
  },
};

export interface DerivedWeaponStats {
  totalMassKg: number;
  ergonomics: number; // 0..100 normalized handling score
  adsSpeedMult: number;
  barrelLengthM: number;
  velocityMult: number;
  caliberOverride: BaseCaliberId | null;
  magCapacity: number;
  reloadDurationMult: number;
  recoilPitchMult: number;
  recoilYawMult: number;
  sightMisalignMult: number;
  adsZoomFactor: number;
  opticZoomLevels: readonly number[];
  isMagnifiedOptic: boolean;
  hasCantedOptic: boolean;
  isSuppressed: boolean;
  hasCompensator: boolean;
  hasFlashlight: boolean;
  hasLaser: boolean;
  acousticRadiusMult: number;
  muzzleFlashScale: number;
  foregripPose: ForegripPoseStyle;
}

export function hasMountedPicatinnyAdapter(attachments?: WeaponAttachments | null): boolean {
  if (!attachments?.railAdapter) return false;
  return Boolean(ATTACHMENTS[attachments.railAdapter]?.grantsPicatinnyRail);
}

/**
 * Returns the rail adapter ID required to mount `def` onto `weaponId` if the weapon lacks
 * a native Picatinny rail, or `null` if no adapter is required (or already mounted).
 */
export function getRequiredRailAdapterId(
  def: AttachmentDef,
  weaponId: string,
  attachments?: WeaponAttachments | null,
): string | null {
  if (def.slot !== 'optic' || !def.requiresPicatinnyRail) return null;
  const meta = WEAPON_COMPAT_META[weaponId];
  if (!meta) return null;
  if (meta.railType === 'picatinny_top' || meta.railType === 'p90_rail') return null;
  if (meta.railType === 'pistol_milled' && def.compatibleRails?.includes('pistol_milled')) {
    return null;
  }
  if (meta.railType === 'dovetail_ak' && weaponId !== 'mosin_m91_30') {
    return hasMountedPicatinnyAdapter(attachments) ? null : 'rail_b13_dovetail';
  }
  if (meta.railType === 'mp5_claw') {
    return hasMountedPicatinnyAdapter(attachments) ? null : 'rail_mp5_claw';
  }
  return null;
}

export function isAttachmentCompatible(
  def: AttachmentDef,
  weaponId: string,
  attachments?: WeaponAttachments | null,
): boolean {
  if (def.excludedWeapons && def.excludedWeapons.includes(weaponId)) {
    return false;
  }
  const meta = WEAPON_COMPAT_META[weaponId];
  const explicitMatch = def.compatibleWeapons.includes(weaponId);

  if (def.slot === 'canted') {
    if ((def.adsZoomFactor ?? 1) > 1.2 || def.hasVariableZoom) {
      return false;
    }
    if (meta && meta.supportsCanted === false) return false;
  }
  if (def.requiresSuppressorSupport && meta && !meta.supportsSuppressor) {
    return false;
  }
  if (def.slot === 'foregrip' && meta && meta.supportsForegrip === false) {
    return false;
  }
  if (def.enablesLaser && meta && meta.supportsLaser === false) {
    return false;
  }

  // Rail-adapter gating for Picatinny optics on Soviet dovetail / MP5 claw receivers:
  // If an adapter is mounted, treat the receiver as having a picatinny_top rail (and block direct dovetail-only scopes like PSO-1M2 while the B-13 bridge occupies the dovetail!).
  const adapterMounted = hasMountedPicatinnyAdapter(attachments);
  if (def.slot === 'optic' && meta) {
    if (
      adapterMounted &&
      (meta.railType === 'dovetail_ak' || meta.railType === 'mp5_claw') &&
      def.compatibleRails &&
      def.compatibleRails.includes('dovetail_ak') &&
      !def.compatibleRails.includes('picatinny_top')
    ) {
      // Dovetail side-rail is occupied by B-13 bridge; PSO-1M2 cannot co-mount with B-13
      return false;
    }
    if (
      def.requiresPicatinnyRail &&
      (meta.railType === 'dovetail_ak' || meta.railType === 'mp5_claw')
    ) {
      if (!adapterMounted) return false;
      const catOk = !def.compatibleCategories || def.compatibleCategories.includes(meta.category);
      return catOk;
    }
  }

  if (explicitMatch) return true;
  if (!meta) return false;

  const effectiveRail: WeaponRailType =
    adapterMounted && (meta.railType === 'dovetail_ak' || meta.railType === 'mp5_claw')
      ? 'picatinny_top'
      : meta.railType;
  const railOk = !def.compatibleRails || def.compatibleRails.includes(effectiveRail);
  const catOk = !def.compatibleCategories || def.compatibleCategories.includes(meta.category);
  const hasRule = Boolean(def.compatibleRails || def.compatibleCategories);
  return hasRule && railOk && catOk;
}

export function getCompatibleAttachments(
  weaponId: string,
  slot: AttachmentSlot,
  attachments?: WeaponAttachments | null,
  includeAdapterLocked = false,
): AttachmentDef[] {
  const out: AttachmentDef[] = [];
  for (const key of Object.keys(ATTACHMENTS)) {
    const def = ATTACHMENTS[key];
    if (def.slot !== slot) continue;
    // Hide legacy duplicate aliases from Gunsmith picklists while keeping them loadable from saves
    if (def.id === 'optic_rmr_micro' || def.id === 'optic_lpvo_1_6' || def.id === 'optic_pso1_4x') {
      continue;
    }
    if (isAttachmentCompatible(def, weaponId, attachments)) {
      out.push(def);
    } else if (
      includeAdapterLocked &&
      slot === 'optic' &&
      getRequiredRailAdapterId(def, weaponId, attachments) !== null &&
      isAttachmentCompatible(def, weaponId, {
        ...attachments,
        railAdapter: getRequiredRailAdapterId(def, weaponId, attachments),
      })
    ) {
      out.push(def);
    }
  }
  return out;
}

export function getZeroDistancePresets(category: WeaponCategory): readonly number[] {
  if (category === 'dmrs' || category === 'bolt_action') {
    return [25, 50, 100, 150, 200, 300, 500, 600, 800];
  }
  if (category === 'pistols' || category === 'revolvers' || category === 'shotguns') {
    return [25, 50, 100, 150, 200];
  }
  return [25, 50, 100, 150, 200, 300];
}

export function getDefaultZeroDistanceM(category: WeaponCategory): number {
  if (category === 'pistols' || category === 'revolvers' || category === 'shotguns') return 25;
  if (category === 'dmrs' || category === 'bolt_action') return 100;
  return 50;
}

export function getBallisticSimMaxRangeM(category: WeaponCategory): number {
  if (category === 'dmrs' || category === 'bolt_action') return 800;
  if (category === 'pistols' || category === 'revolvers' || category === 'shotguns') return 200;
  return 400;
}

export function createBareAttachments(): WeaponAttachments {
  return {
    railAdapter: null,
    optic: null,
    canted: null,
    muzzle: null,
    tactical: null,
    foregrip: null,
    magazine: null,
    reticleColor: 'red',
    cantedReticleColor: 'red',
  };
}

export function normalizeWeaponAttachments(
  weaponId: string,
  attachments?: WeaponAttachments | null,
): WeaponAttachments {
  const clean: WeaponAttachments = {};
  if (!attachments) return clean;

  // Normalize railAdapter first because optic compatibility depends on it!
  if (attachments.railAdapter) {
    const adapterDef = ATTACHMENTS[attachments.railAdapter];
    if (
      adapterDef &&
      adapterDef.slot === 'railAdapter' &&
      isAttachmentCompatible(adapterDef, weaponId)
    ) {
      clean.railAdapter = adapterDef.id;
    }
  }

  const slots: AttachmentSlot[] = ['optic', 'canted', 'muzzle', 'tactical', 'foregrip', 'magazine'];
  for (const s of slots) {
    let id = attachments[s];
    if (!id) continue;
    // Upgrade legacy saved aliases cleanly to canonical IDs when compatible
    if (id === 'optic_rmr_micro') id = 'optic_rmr_type2';
    if (id === 'optic_lpvo_1_6') id = 'optic_razor_1_6';
    if (id === 'optic_pso1_4x') id = 'optic_pso1m2';

    const def = ATTACHMENTS[id];
    if (def && def.slot === s && isAttachmentCompatible(def, weaponId, clean)) {
      clean[s] = id;
    }
  }
  if (clean.muzzle && ATTACHMENTS[clean.muzzle]?.isSuppressor && attachments.suppressorStowed === true) {
    clean.suppressorStowed = true;
  }
  if (isValidReticleColorId(attachments.reticleColor)) {
    clean.reticleColor = attachments.reticleColor;
  }
  if (isValidReticleColorId(attachments.cantedReticleColor)) {
    clean.cantedReticleColor = attachments.cantedReticleColor;
  }
  if (typeof attachments.selectedAmmoId === 'string' && attachments.selectedAmmoId.length > 0) {
    clean.selectedAmmoId = attachments.selectedAmmoId;
  }
  if (typeof attachments.zeroDistanceM === 'number' && Number.isFinite(attachments.zeroDistanceM)) {
    clean.zeroDistanceM = Math.max(15, Math.min(1000, Math.round(attachments.zeroDistanceM)));
  }
  if (
    typeof attachments.zeroElevationMrad === 'number' &&
    Number.isFinite(attachments.zeroElevationMrad)
  ) {
    clean.zeroElevationMrad = Math.max(-15, Math.min(25, Math.round(attachments.zeroElevationMrad * 10) / 10));
  }
  return clean;
}

export function computeDerivedWeaponStats(
  baseMassKg: number,
  baseBarrelLengthM: number,
  baseMagCapacity: number,
  attachments?: WeaponAttachments | null,
): DerivedWeaponStats {
  const baseErgo = baseMassKg < 1.3 ? 82 : baseMassKg < 3.2 ? 64 : 52;
  let totalMassKg = baseMassKg;
  let ergonomics = baseErgo;
  let barrelLengthM = baseBarrelLengthM;
  let velocityMult = 1.0;
  let caliberOverride: BaseCaliberId | null = null;
  let magCapacity = baseMagCapacity;
  let reloadDurationMult = 1.0;
  let recoilPitchMult = 1.0;
  let recoilYawMult = 1.0;
  let sightMisalignMult = 1.0;
  let adsZoomFactor = 1.0;
  let opticZoomLevels: readonly number[] = [];
  let hasCantedOptic = false;
  let isSuppressed = false;
  let hasCompensator = false;
  let hasFlashlight = false;
  let hasLaser = false;
  let acousticRadiusMult = 1.0;
  let muzzleFlashScale = 1.0;
  let foregripPose: ForegripPoseStyle = 'none';

  if (attachments) {
    const ids = [
      attachments.railAdapter,
      attachments.optic,
      attachments.canted,
      attachments.muzzle,
      attachments.tactical,
      attachments.foregrip,
      attachments.magazine,
    ];
    for (const id of ids) {
      if (!id) continue;
      const def = ATTACHMENTS[id];
      if (!def) continue;
      // When the owned suppressor is stowed in the chest pouch, it is physically off the barrel:
      // do not apply barrel-mounted length, velocity, recoil, acoustic, or flash suppression modifiers.
      if (def.isSuppressor && attachments.suppressorStowed) continue;

      totalMassKg += def.massKg;
      ergonomics += def.ergonomicsDelta;
      barrelLengthM += def.extraLengthM;
      if (def.velocityMult !== undefined) {
        velocityMult *= def.velocityMult;
      }
      if (def.caliberOverride) {
        caliberOverride = def.caliberOverride;
      }
      recoilPitchMult *= def.recoilPitchMult;
      recoilYawMult *= def.recoilYawMult;
      sightMisalignMult *= def.sightMisalignMult;
      if (def.slot === 'optic' && def.adsZoomFactor && def.adsZoomFactor > adsZoomFactor) {
        adsZoomFactor = def.adsZoomFactor;
      }
      if (def.slot === 'optic' && def.zoomLevels && def.zoomLevels.length > 0) {
        opticZoomLevels = def.zoomLevels;
      }
      if (def.slot === 'canted' && ((def.adsZoomFactor ?? 1) <= 1.2 && !def.hasVariableZoom)) {
        hasCantedOptic = true;
      }
      if (def.isSuppressor) {
        isSuppressed = true;
      }
      if (def.slot === 'muzzle' && !def.isSuppressor) {
        hasCompensator = true;
      }
      if (def.acousticRadiusMult !== undefined) {
        acousticRadiusMult *= def.acousticRadiusMult;
      }
      if (def.muzzleFlashScale !== undefined) {
        muzzleFlashScale *= def.muzzleFlashScale;
      }
      if (def.enablesFlashlight) hasFlashlight = true;
      if (def.enablesLaser) hasLaser = true;
      if (def.foregripPose && def.foregripPose !== 'none') {
        foregripPose = def.foregripPose;
      }
      if (def.capacityOverride !== undefined) {
        magCapacity = def.capacityOverride;
      }
      if (def.reloadDurationMult !== undefined) {
        reloadDurationMult *= def.reloadDurationMult;
      }
    }
  }

  totalMassKg = Math.max(0, totalMassKg);
  ergonomics = Math.max(15, Math.min(100, Math.round(ergonomics)));

  // Ergonomics (64 baseline = 1.0x ADS speed) gently scales ADS snap speed and recoil inertia damping
  const adsSpeedMult = Math.max(0.68, Math.min(1.28, 0.78 + (ergonomics / 100) * 0.42));
  const isMagnifiedOptic = adsZoomFactor > 1.2 || opticZoomLevels.some((z) => z > 1.2);

  return {
    totalMassKg,
    ergonomics,
    adsSpeedMult,
    barrelLengthM,
    velocityMult,
    caliberOverride,
    magCapacity,
    reloadDurationMult,
    recoilPitchMult,
    recoilYawMult,
    sightMisalignMult,
    adsZoomFactor,
    opticZoomLevels,
    isMagnifiedOptic,
    hasCantedOptic,
    isSuppressed,
    hasCompensator,
    hasFlashlight,
    hasLaser,
    acousticRadiusMult,
    muzzleFlashScale,
    foregripPose,
  };
}

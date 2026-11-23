export type OperatorId = 'MALE' | 'FEMALE';

export const VALID_OPERATOR_IDS: readonly OperatorId[] = ['MALE', 'FEMALE'] as const;
export const DEFAULT_OPERATOR_ID: OperatorId = 'MALE';
export const OPERATOR_STORAGE_KEY = 'bfps.operator.v1';

export interface OperatorProfileSpec {
  readonly id: OperatorId;
  readonly label: string;
  readonly callsign: string;
  readonly role: string;
  readonly heightM: number;
  readonly massKg: number;
  readonly shoulderWidthM: number;
  readonly hipWidthM: number;
  readonly chestGearClearanceMm: number;
  readonly summary: string;

  // Parametric anatomical sculpting ratios (identical canonical bone axes & camera mount height)
  readonly shoulderHalfSpanX: number;
  readonly clavicleOffsetX: number;
  readonly torsoWidthScale: number;
  readonly waistWidthScale: number;
  readonly pelvisWidthScale: number;
  readonly pelvisDepthScale: number;
  readonly chestDepthScale: number;
  readonly chestContourOffsetZ: number;
  readonly chestContourScale: readonly [number, number, number];
  readonly gluteContourScale: readonly [number, number, number];
  readonly armRadiusScale: number;
  readonly forearmRadiusScale: number;
  readonly handScale: number;
  readonly thighRadiusScale: number;
  readonly shinRadiusScale: number;
  readonly upperArmLen: number;
  readonly lowerArmLen: number;
  readonly thighLen: number;
  readonly shinLen: number;
  readonly ankleHeight: number;
  readonly hipOffsetX: number;
}

export const OPERATOR_PROFILES: Readonly<Record<OperatorId, OperatorProfileSpec>> = {
  MALE: {
    id: 'MALE',
    label: 'Male',
    callsign: 'VANGUARD-01',
    role: 'Assault Breacher',
    heightM: 1.80,
    massKg: 84,
    shoulderWidthM: 0.46,
    hipWidthM: 0.34,
    chestGearClearanceMm: 22,
    summary: 'Standard ballistic carrier frame with broad deltoid silhouette and reinforced forearm armor.',
    shoulderHalfSpanX: 0.135,
    clavicleOffsetX: 0.055,
    torsoWidthScale: 1.0,
    waistWidthScale: 1.0,
    pelvisWidthScale: 1.0,
    pelvisDepthScale: 1.0,
    chestDepthScale: 1.0,
    chestContourOffsetZ: -0.044,
    chestContourScale: [0.056, 0.048, 0.026],
    gluteContourScale: [0.068, 0.064, 0.042],
    armRadiusScale: 1.0,
    forearmRadiusScale: 1.0,
    handScale: 1.0,
    thighRadiusScale: 1.0,
    shinRadiusScale: 1.0,
    upperArmLen: 0.31,
    lowerArmLen: 0.29,
    thighLen: 0.41,
    shinLen: 0.40,
    ankleHeight: 0.085,
    hipOffsetX: 0.10,
  },
  FEMALE: {
    id: 'FEMALE',
    label: 'Female',
    callsign: 'VALKYRIE-02',
    role: 'Recon Specialist',
    heightM: 1.78,
    massKg: 68,
    shoulderWidthM: 0.40,
    hipWidthM: 0.36,
    chestGearClearanceMm: 20,
    summary: 'Contoured tactical SAPI rig with athletic waist taper, balanced shoulder sweep, and identical weapon ergonomics.',
    shoulderHalfSpanX: 0.118,
    clavicleOffsetX: 0.048,
    torsoWidthScale: 0.89,
    waistWidthScale: 0.83,
    pelvisWidthScale: 1.04,
    pelvisDepthScale: 1.05,
    chestDepthScale: 0.94,
    chestContourOffsetZ: -0.056,
    chestContourScale: [0.055, 0.052, 0.036],
    gluteContourScale: [0.075, 0.072, 0.052],
    armRadiusScale: 0.87,
    forearmRadiusScale: 0.88,
    handScale: 0.95,
    thighRadiusScale: 0.97,
    shinRadiusScale: 0.92,
    upperArmLen: 0.31,
    lowerArmLen: 0.29,
    thighLen: 0.41,
    shinLen: 0.40,
    ankleHeight: 0.085,
    hipOffsetX: 0.102,
  },
} as const;

export function isOperatorId(val: unknown): val is OperatorId {
  return val === 'MALE' || val === 'FEMALE';
}

export function normalizeOperatorId(val: unknown): OperatorId {
  if (typeof val === 'string') {
    const upper = val.trim().toUpperCase();
    if (upper === 'MALE' || upper === 'FEMALE') {
      return upper;
    }
  }
  return DEFAULT_OPERATOR_ID;
}

// ============================================================================
// OPERATOR TACTICAL GEAR CUSTOMIZATION (Gloves, Helmets, NVG Mounts, Uniform)
// ============================================================================

export type OperatorGearUniformId = 'team_a' | 'team_b' | 'ffa' | 'infection';

export type GloveColorId =
  | 'charcoal'
  | 'coyote'
  | 'olive'
  | 'slate'
  | 'sand'
  | 'crimson'
  | 'uniform';

export type HelmetTypeId = 'mich' | 'mil_tec';

export type HelmetColorId =
  | 'black'
  | 'olive_drab'
  | 'desert_tan'
  | 'ranger_green'
  | 'coyote_brown'
  | 'uniform';

export type NvgMountId = 'none' | 'pvs7' | 'arnvg';

export interface OperatorGearConfig {
  uniformId: OperatorGearUniformId;
  glovesEnabled: boolean;
  gloveColor: GloveColorId;
  helmetType: HelmetTypeId;
  helmetColor: HelmetColorId;
  nvgMount: NvgMountId;
}

export const OPERATOR_GEAR_STORAGE_KEY = 'bfps.operator.gear.v1';

export const DEFAULT_OPERATOR_GEAR: Readonly<OperatorGearConfig> = {
  uniformId: 'team_a',
  glovesEnabled: true,
  gloveColor: 'charcoal',
  helmetType: 'mil_tec',
  helmetColor: 'black',
  nvgMount: 'none',
};

export interface GloveColorSpec {
  readonly id: GloveColorId;
  readonly label: string;
  readonly swatchHex: string;
  readonly rgb: readonly [number, number, number];
  readonly palmRgb: readonly [number, number, number];
}

export const GLOVE_COLOR_LIST: readonly GloveColorSpec[] = [
  { id: 'charcoal', label: 'Charcoal', swatchHex: '#24272c', rgb: [32, 36, 42], palmRgb: [48, 52, 58] },
  { id: 'coyote', label: 'Coyote', swatchHex: '#735c43', rgb: [98, 78, 56], palmRgb: [118, 96, 70] },
  { id: 'olive', label: 'Olive Drab', swatchHex: '#4b553d', rgb: [62, 70, 50], palmRgb: [78, 82, 62] },
  { id: 'slate', label: 'Navy Slate', swatchHex: '#334459', rgb: [44, 58, 76], palmRgb: [58, 72, 90] },
  { id: 'sand', label: 'Desert Sand', swatchHex: '#a89474', rgb: [148, 130, 102], palmRgb: [164, 146, 118] },
  { id: 'crimson', label: 'Oxblood', swatchHex: '#6b2828', rgb: [92, 34, 34], palmRgb: [74, 30, 30] },
  { id: 'uniform', label: 'Match Kit', swatchHex: '#59636e', rgb: [44, 48, 52], palmRgb: [60, 62, 66] },
] as const;

export const GLOVE_COLOR_MAP: Readonly<Record<GloveColorId, GloveColorSpec>> = Object.fromEntries(
  GLOVE_COLOR_LIST.map((s) => [s.id, s]),
) as Record<GloveColorId, GloveColorSpec>;

export interface HelmetTypeSpec {
  readonly id: HelmetTypeId;
  readonly label: string;
  readonly shortLabel: string;
  readonly hasMount: boolean;
  readonly summary: string;
}

export const HELMET_TYPE_LIST: readonly HelmetTypeSpec[] = [
  {
    id: 'mich',
    label: 'MICH-2000',
    shortLabel: 'MICH',
    hasMount: false,
    summary: 'Full-cut ballistic shell with clean brow and no NVG shroud mount.',
  },
  {
    id: 'mil_tec',
    label: 'Mil-Tec High-Cut',
    shortLabel: 'MIL-TEC',
    hasMount: true,
    summary: 'High-cut tactical helmet with side ARC rails, ear-pro, and Wilcox NVG shroud.',
  },
] as const;

export interface HelmetColorSpec {
  readonly id: HelmetColorId;
  readonly label: string;
  readonly swatchHex: string;
  readonly hex: number;
}

export const HELMET_COLOR_LIST: readonly HelmetColorSpec[] = [
  { id: 'black', label: 'Matte Black', swatchHex: '#1f2328', hex: 0x20242a },
  { id: 'olive_drab', label: 'Olive Drab', swatchHex: '#434d36', hex: 0x3b4430 },
  { id: 'desert_tan', label: 'Desert Tan', swatchHex: '#9c8868', hex: 0x8f7c5e },
  { id: 'ranger_green', label: 'Ranger Green', swatchHex: '#4a5448', hex: 0x434d42 },
  { id: 'coyote_brown', label: 'Coyote Brown', swatchHex: '#6b563f', hex: 0x614d38 },
  { id: 'uniform', label: 'Match Kit', swatchHex: '#59636e', hex: 0x2c333c },
] as const;

export const HELMET_COLOR_MAP: Readonly<Record<HelmetColorId, HelmetColorSpec>> = Object.fromEntries(
  HELMET_COLOR_LIST.map((s) => [s.id, s]),
) as Record<HelmetColorId, HelmetColorSpec>;

export interface NvgMountSpec {
  readonly id: NvgMountId;
  readonly label: string;
  readonly shortLabel: string;
  readonly phosphorLabel: string;
  readonly summary: string;
}

export const NVG_MOUNT_LIST: readonly NvgMountSpec[] = [
  {
    id: 'none',
    label: 'No Mount',
    shortLabel: 'NONE',
    phosphorLabel: 'Unaided',
    summary: 'Empty Wilcox shroud with zero optical weight.',
  },
  {
    id: 'pvs7',
    label: 'AGM PVS-7 NL2 / NL1',
    shortLabel: 'PVS-7',
    phosphorLabel: 'Gen 2+ P43 Green',
    summary: 'Classic bi-ocular housing with Gen 2+ tube, ABC auto-gating, and built-in IR illuminator.',
  },
  {
    id: 'arnvg',
    label: 'AB Nightvision RNVG-A (ARNVG)',
    shortLabel: 'ARNVG',
    phosphorLabel: 'MIL40 P45 White',
    summary: '7075 aluminum articulating dual-tube kit with MIL-STD-810H durability and MIL40 white-phosphor optics.',
  },
] as const;

const VALID_UNIFORMS = new Set<string>(['team_a', 'team_b', 'ffa', 'infection']);
const VALID_GLOVE_COLORS = new Set<string>(GLOVE_COLOR_LIST.map((g) => g.id));
const VALID_HELMET_TYPES = new Set<string>(['mich', 'mil_tec']);
const VALID_HELMET_COLORS = new Set<string>(HELMET_COLOR_LIST.map((h) => h.id));
const VALID_NVG_MOUNTS = new Set<string>(['none', 'pvs7', 'arnvg']);

export function normalizeOperatorGearConfig(raw: unknown): OperatorGearConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const uniformId: OperatorGearUniformId =
    typeof obj.uniformId === 'string' && VALID_UNIFORMS.has(obj.uniformId)
      ? (obj.uniformId as OperatorGearUniformId)
      : DEFAULT_OPERATOR_GEAR.uniformId;
  const glovesEnabled =
    typeof obj.glovesEnabled === 'boolean' ? obj.glovesEnabled : DEFAULT_OPERATOR_GEAR.glovesEnabled;
  const gloveColor: GloveColorId =
    typeof obj.gloveColor === 'string' && VALID_GLOVE_COLORS.has(obj.gloveColor)
      ? (obj.gloveColor as GloveColorId)
      : DEFAULT_OPERATOR_GEAR.gloveColor;
  const helmetType: HelmetTypeId =
    typeof obj.helmetType === 'string' && VALID_HELMET_TYPES.has(obj.helmetType)
      ? (obj.helmetType as HelmetTypeId)
      : DEFAULT_OPERATOR_GEAR.helmetType;
  const helmetColor: HelmetColorId =
    typeof obj.helmetColor === 'string' && VALID_HELMET_COLORS.has(obj.helmetColor)
      ? (obj.helmetColor as HelmetColorId)
      : DEFAULT_OPERATOR_GEAR.helmetColor;
  const rawNvg: NvgMountId =
    typeof obj.nvgMount === 'string' && VALID_NVG_MOUNTS.has(obj.nvgMount)
      ? (obj.nvgMount as NvgMountId)
      : DEFAULT_OPERATOR_GEAR.nvgMount;
  // MICH helmet has NO shroud mount — always enforce 'none'
  const nvgMount: NvgMountId = helmetType === 'mil_tec' ? rawNvg : 'none';

  return {
    uniformId,
    glovesEnabled,
    gloveColor,
    helmetType,
    helmetColor,
    nvgMount,
  };
}

// ============================================================================
// CANONICAL SHARED RIG CONTRACT (OperatorRigContract)
// ============================================================================

export const PRIMARY_BONE_NAMES = [
  'root',
  'pelvis',
  'spine_01',
  'spine_02',
  'spine_03',
  'neck_01',
  'head',
  'clavicle_l',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'clavicle_r',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'toe_l',
  'thigh_r',
  'calf_r',
  'foot_r',
  'toe_r',
] as const;

export type PrimaryBoneName = (typeof PRIMARY_BONE_NAMES)[number];

export const SECONDARY_BONE_NAMES = [
  'sec_chest_l',
  'sec_chest_r',
  'sec_glute_l',
  'sec_glute_r',
  'sec_bicep_l',
  'sec_tricep_l',
  'sec_forearm_l',
  'sec_bicep_r',
  'sec_tricep_r',
  'sec_forearm_r',
] as const;

export type SecondaryBoneName = (typeof SECONDARY_BONE_NAMES)[number];

export const SOCKET_AND_POLE_NAMES = [
  'socket_weapon_r',
  'socket_weapon_holster',
  'socket_bodycam_mount',
  'ik_pole_elbow_l',
  'ik_pole_elbow_r',
] as const;

export type SocketAndPoleName = (typeof SOCKET_AND_POLE_NAMES)[number];

export const HIT_ZONE_NODE_NAMES = [
  'hz_head',
  'hz_neck',
  'hz_chest',
  'hz_abdomen',
  'hz_pelvis',
  'hz_upperarm_l',
  'hz_forearm_l',
  'hz_hand_l',
  'hz_upperarm_r',
  'hz_forearm_r',
  'hz_hand_r',
  'hz_thigh_l',
  'hz_calf_l',
  'hz_foot_l',
  'hz_thigh_r',
  'hz_calf_r',
  'hz_foot_r',
] as const;

export type HitZoneNodeName = (typeof HIT_ZONE_NODE_NAMES)[number];

export const RAGDOLL_NODE_NAMES = [
  'hz_pelvis',
  'hz_abdomen',
  'hz_chest',
  'hz_neck',
  'hz_head',
  'hz_upperarm_l',
  'hz_forearm_l',
  'hz_upperarm_r',
  'hz_forearm_r',
  'hz_thigh_l',
  'hz_calf_l',
  'hz_foot_l',
  'hz_thigh_r',
  'hz_calf_r',
  'hz_foot_r',
] as const;

export type RagdollNodeName = (typeof RAGDOLL_NODE_NAMES)[number];

export type CanonicalRigNodeName =
  | PrimaryBoneName
  | SecondaryBoneName
  | SocketAndPoleName
  | HitZoneNodeName;

export const CANONICAL_RIG_PARENT_MAP: Readonly<Record<Exclude<CanonicalRigNodeName, 'root'>, CanonicalRigNodeName>> = {
  // Primary Spine & Head
  pelvis: 'root',
  spine_01: 'pelvis',
  spine_02: 'spine_01',
  spine_03: 'spine_02',
  neck_01: 'spine_03',
  head: 'neck_01',

  // Primary Arms
  clavicle_l: 'spine_03',
  upperarm_l: 'clavicle_l',
  lowerarm_l: 'upperarm_l',
  hand_l: 'lowerarm_l',
  clavicle_r: 'spine_03',
  upperarm_r: 'clavicle_r',
  lowerarm_r: 'upperarm_r',
  hand_r: 'lowerarm_r',

  // Primary Legs
  thigh_l: 'pelvis',
  calf_l: 'thigh_l',
  foot_l: 'calf_l',
  toe_l: 'foot_l',
  thigh_r: 'pelvis',
  calf_r: 'thigh_r',
  foot_r: 'calf_r',
  toe_r: 'foot_r',

  // Secondary Soft-Tissue Nodes
  sec_chest_l: 'spine_03',
  sec_chest_r: 'spine_03',
  sec_glute_l: 'pelvis',
  sec_glute_r: 'pelvis',
  sec_bicep_l: 'upperarm_l',
  sec_tricep_l: 'upperarm_l',
  sec_forearm_l: 'lowerarm_l',
  sec_bicep_r: 'upperarm_r',
  sec_tricep_r: 'upperarm_r',
  sec_forearm_r: 'lowerarm_r',

  // Sockets & IK Poles
  socket_weapon_r: 'hand_r',
  socket_weapon_holster: 'pelvis',
  socket_bodycam_mount: 'spine_03',
  ik_pole_elbow_l: 'spine_03',
  ik_pole_elbow_r: 'spine_03',

  // Hit-Zone Nodes
  hz_head: 'head',
  hz_neck: 'neck_01',
  hz_chest: 'spine_03',
  hz_abdomen: 'spine_01',
  hz_pelvis: 'pelvis',
  hz_upperarm_l: 'upperarm_l',
  hz_forearm_l: 'lowerarm_l',
  hz_hand_l: 'hand_l',
  hz_upperarm_r: 'upperarm_r',
  hz_forearm_r: 'lowerarm_r',
  hz_hand_r: 'hand_r',
  hz_thigh_l: 'thigh_l',
  hz_calf_l: 'calf_l',
  hz_foot_l: 'foot_l',
  hz_thigh_r: 'thigh_r',
  hz_calf_r: 'calf_r',
  hz_foot_r: 'foot_r',
} as const;

export const OPERATOR_RIG_CONTRACT = {
  scaleTolerance: 0.001,
  restAxisDotMin: 0.999,
  minChestGearClearanceM: 0.018, // 18 mm rest clearance behind front plate carrier
  bodycamMountMinForwardClearanceM: 0.008, // Forward of front plate exterior
  primaryBones: PRIMARY_BONE_NAMES,
  secondaryBones: SECONDARY_BONE_NAMES,
  socketsAndPoles: SOCKET_AND_POLE_NAMES,
  hitZones: HIT_ZONE_NODE_NAMES,
  ragdollNodes: RAGDOLL_NODE_NAMES,
  parentMap: CANONICAL_RIG_PARENT_MAP,
} as const;

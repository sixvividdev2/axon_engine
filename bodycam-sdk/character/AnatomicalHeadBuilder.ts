import * as THREE from 'three';
import {
  DEFAULT_FACE_PRESET_ID,
  EyewearId,
  FaceGearId,
  FacePresetId,
  HelmetTypeId,
  normalizeFacePresetId,
  pickFacePresetFromSeed,
} from '../operator/OperatorTypes';

export const FACIAL_MORPH_TARGET_NAMES = [
  'brow_inner_up',
  'brow_outer_up',
  'brow_furrow_down',
  'eye_blink_l',
  'eye_blink_r',
  'eye_squint_l',
  'eye_squint_r',
  'eye_wide',
  'cheek_raise',
  'sneer_snarl_l',
  'sneer_snarl_r',
  'jaw_open',
  'mouth_tense_grimace',
  'lip_pull_upper',
  'lip_corner_snarl',
] as const;

export type FacialMorphTargetName = (typeof FACIAL_MORPH_TARGET_NAMES)[number];
export const FACIAL_MORPH_COUNT = FACIAL_MORPH_TARGET_NAMES.length;

export const FACIAL_MORPH_INDEX: Readonly<Record<FacialMorphTargetName, number>> =
  Object.fromEntries(
    FACIAL_MORPH_TARGET_NAMES.map((name, idx) => [name, idx]),
  ) as Record<FacialMorphTargetName, number>;

export type AnatomicalHeadVariant = 'male' | 'female' | 'zombie';
export type ZombieHairStyle = 'tattered' | 'bald';

export type HairCutProfileId =
  | 'male_high_tight'
  | 'male_short_crop'
  | 'male_buzz_fade'
  | 'female_swept_bun'
  | 'female_parted_bun'
  | 'female_close_fade_bun'
  | 'zombie_tattered'
  | 'zombie_bald';

export interface SkinTonePalette {
  readonly baseHex: string;
  readonly shadowHex: string;
  readonly highlightHex: string;
  readonly lipHex: string;
  readonly blushHex: string;
  readonly jawCoolHex: string;
  readonly browHex: string;
  readonly hairHex: string;
  readonly hairHighlightHex: string;
  readonly stubbleAlpha: number;
  readonly irisHex: string;
  readonly irisRimHex: string;
  readonly wristHex: number;
}

export interface HeadAnatomyProfile {
  readonly variant: AnatomicalHeadVariant;
  readonly facePreset: FacePresetId;
  readonly hairCut: HairCutProfileId;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly occipitalBoost: number;
  readonly parietalBoost: number;
  readonly jawWidthBoost: number;
  readonly jawDropBoost: number;
  readonly chinWidth: number;
  readonly chinProjection: number;
  readonly chinFlatten: number;
  readonly browProjection: number;
  readonly browHeightOffset: number;
  readonly noseBridgeProjection: number;
  readonly noseTipProjection: number;
  readonly noseWidthScale: number;
  readonly cheekboneBoost: number;
  readonly buccalHollow: number;
  readonly lipFullness: number;
  readonly eyeSpacingX: number;
  readonly eyeCenterY: number;
  readonly eyeCenterZ: number;
  readonly hairCrownThickness: number;
  readonly hairSideThickness: number;
  readonly hairlineY: number;
  readonly templeRecession: number;
  readonly browThickness: number;
  readonly browArch: number;
  readonly femaleBunScale: number;
  readonly palette: SkinTonePalette;
}

export const HUMAN_SKIN_PALETTES: readonly SkinTonePalette[] = [
  // Male 01 / Breacher (fair-warm skin, hazel eyes, dark brown fade, light stubble)
  {
    baseHex: '#c99c80',
    shadowHex: '#926750',
    highlightHex: '#dfb69c',
    lipHex: '#9a6058',
    blushHex: '#bc7566',
    jawCoolHex: '#6c6862',
    browHex: '#2b2019',
    hairHex: '#2a2019',
    hairHighlightHex: '#46362b',
    stubbleAlpha: 0.16,
    irisHex: '#5d6e54',
    irisRimHex: '#202b1d',
    wristHex: 0xb78b70,
  },
  // Male 02 / Recon (olive-tan skin, dark brown eyes, textured short crop, dense stubble)
  {
    baseHex: '#b48364',
    shadowHex: '#80573e',
    highlightHex: '#ca9a7b',
    lipHex: '#8b544c',
    blushHex: '#a56555',
    jawCoolHex: '#585650',
    browHex: '#1f1814',
    hairHex: '#1e1713',
    hairHighlightHex: '#382c24',
    stubbleAlpha: 0.24,
    irisHex: '#4b3726',
    irisRimHex: '#1b120b',
    wristHex: 0xa27458,
  },
  // Male 03 / Heavy (deep rich brown skin, dark amber eyes, crisp buzz fade)
  {
    baseHex: '#7a513b',
    shadowHex: '#4f3122',
    highlightHex: '#92664d',
    lipHex: '#633b35',
    blushHex: '#784839',
    jawCoolHex: '#3f3834',
    browHex: '#15110f',
    hairHex: '#14100e',
    hairHighlightHex: '#2a221d',
    stubbleAlpha: 0.14,
    irisHex: '#352319',
    irisRimHex: '#120b07',
    wristHex: 0x6e4834,
  },
  // Female 01 / Valkyrie (light neutral-warm skin, blue-grey eyes, chestnut swept cut)
  {
    baseHex: '#cfa388',
    shadowHex: '#996f57',
    highlightHex: '#e3bca3',
    lipHex: '#a4655d',
    blushHex: '#c27e6f',
    jawCoolHex: '#8b7a72',
    browHex: '#3a291f',
    hairHex: '#38261c',
    hairHighlightHex: '#594030',
    stubbleAlpha: 0,
    irisHex: '#4e6d84',
    irisRimHex: '#1d2d39',
    wristHex: 0xbd9279,
  },
  // Female 02 / Marksman (warm olive skin, green-hazel eyes, sleek dark parted crown)
  {
    baseHex: '#b9896b',
    shadowHex: '#855c43',
    highlightHex: '#ce9f82',
    lipHex: '#945850',
    blushHex: '#ad6d5d',
    jawCoolHex: '#786c63',
    browHex: '#221a15',
    hairHex: '#211915',
    hairHighlightHex: '#3c2e26',
    stubbleAlpha: 0,
    irisHex: '#566f53',
    irisRimHex: '#1e2c1c',
    wristHex: 0xa6795d,
  },
  // Female 03 / Specialist (rich deep brown skin, dark espresso eyes, close textured fade)
  {
    baseHex: '#7e553e',
    shadowHex: '#533525',
    highlightHex: '#956a50',
    lipHex: '#6a403a',
    blushHex: '#7d4c3e',
    jawCoolHex: '#4a3d38',
    browHex: '#171210',
    hairHex: '#15110f',
    hairHighlightHex: '#2c241f',
    stubbleAlpha: 0,
    irisHex: '#322218',
    irisRimHex: '#120b07',
    wristHex: 0x714c37,
  },
] as const;

const ZOMBIE_SKIN_PALETTE: SkinTonePalette = {
  baseHex: '#76806c',
  shadowHex: '#3a3e34',
  highlightHex: '#8f9783',
  lipHex: '#492727',
  blushHex: '#5b4442',
  jawCoolHex: '#3e423e',
  browHex: '#252720',
  hairHex: '#23201b',
  hairHighlightHex: '#3b352d',
  stubbleAlpha: 0.18,
  irisHex: '#8b968a',
  irisRimHex: '#382927',
  wristHex: 0x6d7764,
};

const MALE_PRESET_PROFILES: Readonly<Record<FacePresetId, HeadAnatomyProfile>> = {
  face_01: {
    variant: 'male',
    facePreset: 'face_01',
    hairCut: 'male_high_tight',
    rx: 0.0775,
    ry: 0.1005,
    rz: 0.093,
    occipitalBoost: 0.0165,
    parietalBoost: 0.0065,
    jawWidthBoost: 0.0085,
    jawDropBoost: 0.003,
    chinWidth: 0.024,
    chinProjection: 0.0155,
    chinFlatten: 0.0038,
    browProjection: 0.0112,
    browHeightOffset: 0.0,
    noseBridgeProjection: 0.0135,
    noseTipProjection: 0.0185,
    noseWidthScale: 1.0,
    cheekboneBoost: 0.0065,
    buccalHollow: 0.0028,
    lipFullness: 0.0056,
    eyeSpacingX: 0.0312,
    eyeCenterY: 0.1035,
    eyeCenterZ: -0.0705,
    hairCrownThickness: 0.0042,
    hairSideThickness: 0.0018,
    hairlineY: 0.146,
    templeRecession: 0.012,
    browThickness: 0.0042,
    browArch: 0.0022,
    femaleBunScale: 0,
    palette: HUMAN_SKIN_PALETTES[0],
  },
  face_02: {
    variant: 'male',
    facePreset: 'face_02',
    hairCut: 'male_short_crop',
    rx: 0.0755,
    ry: 0.1015,
    rz: 0.0935,
    occipitalBoost: 0.017,
    parietalBoost: 0.0055,
    jawWidthBoost: 0.0062,
    jawDropBoost: 0.002,
    chinWidth: 0.0205,
    chinProjection: 0.0168,
    chinFlatten: 0.0032,
    browProjection: 0.0108,
    browHeightOffset: 0.001,
    noseBridgeProjection: 0.015,
    noseTipProjection: 0.0195,
    noseWidthScale: 0.94,
    cheekboneBoost: 0.0085,
    buccalHollow: 0.0045,
    lipFullness: 0.0054,
    eyeSpacingX: 0.0308,
    eyeCenterY: 0.1038,
    eyeCenterZ: -0.0705,
    hairCrownThickness: 0.0052,
    hairSideThickness: 0.0024,
    hairlineY: 0.143,
    templeRecession: 0.009,
    browThickness: 0.0045,
    browArch: 0.0026,
    femaleBunScale: 0,
    palette: HUMAN_SKIN_PALETTES[1],
  },
  face_03: {
    variant: 'male',
    facePreset: 'face_03',
    hairCut: 'male_buzz_fade',
    rx: 0.079,
    ry: 0.100,
    rz: 0.0935,
    occipitalBoost: 0.016,
    parietalBoost: 0.0072,
    jawWidthBoost: 0.0102,
    jawDropBoost: 0.0038,
    chinWidth: 0.026,
    chinProjection: 0.0152,
    chinFlatten: 0.0044,
    browProjection: 0.0124,
    browHeightOffset: -0.0008,
    noseBridgeProjection: 0.0125,
    noseTipProjection: 0.0175,
    noseWidthScale: 1.15,
    cheekboneBoost: 0.0078,
    buccalHollow: 0.0022,
    lipFullness: 0.0072,
    eyeSpacingX: 0.0318,
    eyeCenterY: 0.1032,
    eyeCenterZ: -0.0705,
    hairCrownThickness: 0.0028,
    hairSideThickness: 0.0015,
    hairlineY: 0.144,
    templeRecession: 0.0075,
    browThickness: 0.0044,
    browArch: 0.0018,
    femaleBunScale: 0,
    palette: HUMAN_SKIN_PALETTES[2],
  },
};

const FEMALE_PRESET_PROFILES: Readonly<Record<FacePresetId, HeadAnatomyProfile>> = {
  face_01: {
    variant: 'female',
    facePreset: 'face_01',
    hairCut: 'female_swept_bun',
    rx: 0.0725,
    ry: 0.0965,
    rz: 0.0885,
    occipitalBoost: 0.0155,
    parietalBoost: 0.0052,
    jawWidthBoost: 0.0022,
    jawDropBoost: 0.0005,
    chinWidth: 0.0165,
    chinProjection: 0.0125,
    chinFlatten: 0.0024,
    browProjection: 0.0072,
    browHeightOffset: 0.0018,
    noseBridgeProjection: 0.0115,
    noseTipProjection: 0.0162,
    noseWidthScale: 0.88,
    cheekboneBoost: 0.0072,
    buccalHollow: 0.0034,
    lipFullness: 0.0062,
    eyeSpacingX: 0.0305,
    eyeCenterY: 0.1038,
    eyeCenterZ: -0.0685,
    hairCrownThickness: 0.0040,
    hairSideThickness: 0.0025,
    hairlineY: 0.141,
    templeRecession: 0.0045,
    browThickness: 0.0030,
    browArch: 0.0038,
    femaleBunScale: 1.0,
    palette: HUMAN_SKIN_PALETTES[3],
  },
  face_02: {
    variant: 'female',
    facePreset: 'face_02',
    hairCut: 'female_parted_bun',
    rx: 0.0732,
    ry: 0.0972,
    rz: 0.089,
    occipitalBoost: 0.016,
    parietalBoost: 0.0056,
    jawWidthBoost: 0.0034,
    jawDropBoost: 0.001,
    chinWidth: 0.0178,
    chinProjection: 0.013,
    chinFlatten: 0.0026,
    browProjection: 0.0078,
    browHeightOffset: 0.0012,
    noseBridgeProjection: 0.0122,
    noseTipProjection: 0.0168,
    noseWidthScale: 0.92,
    cheekboneBoost: 0.0066,
    buccalHollow: 0.0026,
    lipFullness: 0.0065,
    eyeSpacingX: 0.0308,
    eyeCenterY: 0.1036,
    eyeCenterZ: -0.0685,
    hairCrownThickness: 0.0044,
    hairSideThickness: 0.0028,
    hairlineY: 0.139,
    templeRecession: 0.004,
    browThickness: 0.0033,
    browArch: 0.0034,
    femaleBunScale: 1.06,
    palette: HUMAN_SKIN_PALETTES[4],
  },
  face_03: {
    variant: 'female',
    facePreset: 'face_03',
    hairCut: 'female_close_fade_bun',
    rx: 0.0738,
    ry: 0.0968,
    rz: 0.0895,
    occipitalBoost: 0.0162,
    parietalBoost: 0.006,
    jawWidthBoost: 0.0038,
    jawDropBoost: 0.0012,
    chinWidth: 0.0185,
    chinProjection: 0.0128,
    chinFlatten: 0.0028,
    browProjection: 0.0076,
    browHeightOffset: 0.0015,
    noseBridgeProjection: 0.011,
    noseTipProjection: 0.0158,
    noseWidthScale: 1.04,
    cheekboneBoost: 0.0084,
    buccalHollow: 0.003,
    lipFullness: 0.0076,
    eyeSpacingX: 0.0312,
    eyeCenterY: 0.1034,
    eyeCenterZ: -0.0685,
    hairCrownThickness: 0.0026,
    hairSideThickness: 0.0016,
    hairlineY: 0.140,
    templeRecession: 0.005,
    browThickness: 0.0032,
    browArch: 0.0036,
    femaleBunScale: 0.78,
    palette: HUMAN_SKIN_PALETTES[5],
  },
};

const ZOMBIE_ANATOMY_PROFILE: HeadAnatomyProfile = {
  variant: 'zombie',
  facePreset: DEFAULT_FACE_PRESET_ID,
  hairCut: 'zombie_tattered',
  rx: 0.0745,
  ry: 0.100,
  rz: 0.0925,
  occipitalBoost: 0.0155,
  parietalBoost: 0.005,
  jawWidthBoost: 0.0055,
  jawDropBoost: 0.0025,
  chinWidth: 0.020,
  chinProjection: 0.015,
  chinFlatten: 0.0035,
  browProjection: 0.0132,
  browHeightOffset: -0.001,
  noseBridgeProjection: 0.0125,
  noseTipProjection: 0.0145,
  noseWidthScale: 0.96,
  cheekboneBoost: 0.0105,
  buccalHollow: 0.0125,
  lipFullness: 0.0044,
  eyeSpacingX: 0.0312,
  eyeCenterY: 0.1035,
  eyeCenterZ: -0.0705,
  hairCrownThickness: 0.0034,
  hairSideThickness: 0.002,
  hairlineY: 0.148,
  templeRecession: 0.018,
  browThickness: 0.0034,
  browArch: 0.0015,
  femaleBunScale: 0,
  palette: ZOMBIE_SKIN_PALETTE,
};

export function resolveZombieHairStyleFromSeed(seed: number): ZombieHairStyle {
  // Deterministic 55% tattered hair cap / 45% bald necrotic scalp mix across infected hordes
  const bucket = Math.abs(Math.floor(seed * 2654435761)) % 20;
  return bucket < 11 ? 'tattered' : 'bald';
}

export function getHeadAnatomyProfile(
  variant: AnatomicalHeadVariant,
  facePreset: FacePresetId = DEFAULT_FACE_PRESET_ID,
): HeadAnatomyProfile {
  if (variant === 'zombie') return ZOMBIE_ANATOMY_PROFILE;
  const preset = normalizeFacePresetId(facePreset);
  return variant === 'female' ? FEMALE_PRESET_PROFILES[preset] : MALE_PRESET_PROFILES[preset];
}

export function getSkinTonePalette(
  seed: number,
  variant: AnatomicalHeadVariant,
  facePreset?: FacePresetId,
): SkinTonePalette {
  if (variant === 'zombie') {
    return ZOMBIE_SKIN_PALETTE;
  }
  const resolvedPreset = facePreset ? normalizeFacePresetId(facePreset) : pickFacePresetFromSeed(seed);
  return getHeadAnatomyProfile(variant, resolvedPreset).palette;
}

// ============================================================================
// MATH HELPERS & CONTINUOUS ANATOMICAL HEAD SURFACE EVALUATOR
// ============================================================================

function gaussian(d: number, sigma: number): number {
  const t = d / sigma;
  return Math.exp(-0.5 * t * t);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function seededRand(seed: number): () => number {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hash2D(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Analytic cubic-to-spherical projection (maps [-1,1]^3 cube boundary to unit sphere
 * with ultra-uniform quad density and zero polar pinching).
 */
function spherifyCubePoint(cx: number, cy: number, cz: number, out: THREE.Vector3): THREE.Vector3 {
  const x2 = cx * cx;
  const y2 = cy * cy;
  const z2 = cz * cz;
  const ux = cx * Math.sqrt(Math.max(0, 1 - y2 * 0.5 - z2 * 0.5 + (y2 * z2) / 3));
  const uy = cy * Math.sqrt(Math.max(0, 1 - z2 * 0.5 - x2 * 0.5 + (z2 * x2) / 3));
  const uz = cz * Math.sqrt(Math.max(0, 1 - x2 * 0.5 - y2 * 0.5 + (x2 * y2) / 3));
  const len = Math.hypot(ux, uy, uz) || 1;
  return out.set(ux / len, uy / len, uz / len);
}

/**
 * Continuous anatomical surface deformation from unit sphere direction (ux, uy, uz)
 * to sculpted head coordinates in meters (facing -Z, origin y=0 at upper neck base).
 * Shared identically by the cube-sphere head, offset hair cap shell, and 3D brow strips.
 */
function evaluateAnatomicalHeadPoint(
  ux: number,
  uy: number,
  uz: number,
  p: HeadAnatomyProfile,
  out: THREE.Vector3,
): THREE.Vector3 {
  const isZombie = p.variant === 'zombie';
  const isFemale = p.variant === 'female';
  const cy = 0.104;
  const cz = -0.004;

  // Base craniofacial ellipsoid
  let x = ux * p.rx;
  let y = cy + uy * p.ry;
  let z = cz + uz * p.rz;

  // 1. Cranium volume: upper-rear parietal dome + strong occipital lobe curving out
  // behind the neck before tucking cleanly inward at the nuchal ridge / nape.
  if (uz > -0.05) {
    const occipitalLobe =
      smoothstep(0.05, 0.72, uz) *
      smoothstep(0.064, 0.118, y) *
      smoothstep(0.205, 0.155, y);
    z += occipitalLobe * p.occipitalBoost;

    const parietalBoss =
      smoothstep(-0.05, 0.52, uz) *
      gaussian(Math.abs(x) - p.rx * 0.76, 0.026) *
      gaussian(y - 0.148, 0.032);
    x += Math.sign(x) * parietalBoss * p.parietalBoost;
    y += occipitalLobe * 0.003;

    // Nuchal tuck below occipital bone into rear neck
    const nuchalTuck = smoothstep(0.25, 0.80, uz) * smoothstep(0.072, 0.032, y);
    z -= nuchalTuck * 0.015;
  }

  // 2. Temple inward contour (slight temporal fossa above zygomatic arch)
  const templeW =
    gaussian(Math.abs(x) - p.rx * 0.90, 0.016) *
    gaussian(y - 0.122, 0.022) *
    gaussian(z - -0.022, 0.028);
  x -= Math.sign(x) * templeW * (isZombie ? 0.0095 : 0.0052);

  // 3. Defined Mandible, Gonial Angles & Slightly Flattened Anterior Chin Plane
  // Widen gonial corners below the ears so jaw never pinches into an egg cone
  const gonialMask =
    gaussian(Math.abs(x) - (isFemale ? 0.052 : 0.057), 0.017) *
    gaussian(y - 0.044, 0.018) *
    gaussian(z - -0.016, 0.028);
  x += Math.sign(x) * gonialMask * p.jawWidthBoost;
  y -= gonialMask * p.jawDropBoost;

  // Mandibular body ramp connecting gonial angle cleanly forward to the chin plane
  const jawRamus =
    smoothstep(0.076, 0.046, y) *
    smoothstep(0.016, 0.036, y) *
    smoothstep(0.012, -0.062, z) *
    gaussian(Math.abs(x) - (isFemale ? 0.036 : 0.041), 0.022);
  x += Math.sign(x) * jawRamus * (p.jawWidthBoost * 0.58);
  z -= jawRamus * 0.0045;

  // Anterior chin plane (mental protuberance): flattened front face instead of conical tip
  const chinBand =
    smoothstep(-0.15, -0.78, uz) *
    gaussian(y - 0.025, 0.016) *
    gaussian(x, p.chinWidth);
  const chinSideSquare =
    smoothstep(-0.20, -0.78, uz) *
    gaussian(y - 0.026, 0.015) *
    gaussian(Math.abs(x) - p.chinWidth * 0.68, 0.010);
  z -= chinBand * p.chinProjection + chinSideSquare * (p.chinFlatten * 1.15);
  // Subtle front-center flattening on the chin pad
  z += chinBand * gaussian(x, 0.010) * p.chinFlatten;
  y -= chinBand * 0.0038;

  // Labiomental crease indent directly above chin & below lower lip
  const labioFold =
    smoothstep(-0.55, -0.88, uz) *
    gaussian(x, 0.020) *
    gaussian(y - 0.037, 0.0055);
  z += labioFold * 0.0038;

  // Posterior & submental neck cylinder transition (strictly beneath chin & behind jaw shelf)
  if (y < 0.030) {
    const neckBlend = smoothstep(0.030, -0.004, y) * smoothstep(-0.056, -0.006, z);
    const neckR = isFemale ? 0.043 : 0.049;
    const horizR = Math.hypot(x, z - 0.010);
    if (horizR > 1e-4) {
      const targetR = THREE.MathUtils.lerp(horizR, neckR, neckBlend * 0.86);
      const s = targetR / horizR;
      x *= s;
      z = 0.010 + (z - 0.010) * s;
    }
    y -= smoothstep(0.018, -0.004, y) * 0.024;
  }

  // 4. Protruding Supraorbital Brow Ridge & Glabella (overhangs recessed eyes naturally)
  const browY = 0.121 + p.browHeightOffset;
  const browArchOffset = Math.sin(Math.min(1, Math.abs(x) / 0.046) * Math.PI) * p.browArch;
  const browRidge =
    gaussian(y - (browY + browArchOffset), 0.0105) *
    smoothstep(-0.042, -0.080, z) *
    gaussian(x, 0.048);
  z -= browRidge * p.browProjection;

  // Forehead slight frontal plane (gentle vertical flatness above brow)
  const foreheadPlane =
    smoothstep(-0.45, -0.86, uz) *
    gaussian(x, 0.042) *
    gaussian(y - 0.145, 0.018);
  z += foreheadPlane * 0.0022;

  // 5. Deeply Recessed Eye Sockets + Sculpted Upper/Lower Eyelid Hoods
  const frontOrbMask = smoothstep(-0.040, -0.072, z);
  for (const side of [-1, 1]) {
    const ex = side * p.eyeSpacingX;
    const dx = x - ex;
    const dy = y - p.eyeCenterY;

    // Broad orbital basin depression (pushes surrounding eye socket back -Z -> +Z inward)
    const basinDist = Math.hypot(dx / 0.0205, (dy - 0.001) / 0.0145);
    const orbitalBasin = Math.exp(-basinDist * basinDist * 1.15) * frontOrbMask;
    z += orbitalBasin * (isZombie ? 0.0115 : 0.0085);

    // Deep recessed eye aperture socket cradling the recessed eyeball
    const orbDist = Math.hypot(dx / 0.0142, dy / 0.0092);
    const socketPocket = Math.exp(-orbDist * orbDist * 1.45) * frontOrbMask;
    z += socketPocket * (isZombie ? 0.0195 : 0.0175);

    // Sculpted upper eyelid fold (slightly overhanging) & lower lid rim
    const upperLidRim =
      gaussian(dx, 0.0135) * gaussian(dy - 0.0098, 0.0038) * frontOrbMask;
    const lowerLidRim =
      gaussian(dx, 0.0130) * gaussian(dy + 0.0086, 0.0036) * frontOrbMask;
    z -= upperLidRim * 0.0044 + lowerLidRim * 0.0030;
  }

  // 6. Anatomical Nose: Nasion Bridge Dip, Crisp Dorsum, Sharp Tip, Columella & Nostril Wings
  const noseFront = smoothstep(-0.052, -0.082, z);
  // Nasion indentation right between the eyes below glabella
  const nasionDip = noseFront * gaussian(x, 0.0095) * gaussian(y - 0.107, 0.0062);
  z += nasionDip * 0.0052;

  // Dorsal nose bridge descending from nasion to tip
  const noseBridge =
    noseFront *
    gaussian(x, 0.0072 * p.noseWidthScale) *
    smoothstep(0.111, 0.098, y) *
    smoothstep(0.074, 0.084, y);
  // Sharper nasal tip
  const noseTip =
    noseFront *
    gaussian(x, 0.0082 * p.noseWidthScale) *
    gaussian(y - 0.079, 0.0074);
  // Subtle underside slope below tip into philtrum
  const noseUnder =
    noseFront *
    gaussian(x, 0.010 * p.noseWidthScale) *
    gaussian(y - 0.071, 0.0042);
  // Alar nostril wings
  const nostrilWing =
    noseFront *
    gaussian(Math.abs(x) - 0.0112 * p.noseWidthScale, 0.0048) *
    gaussian(y - 0.0755, 0.0048);

  z -=
    noseBridge * p.noseBridgeProjection +
    noseTip * p.noseTipProjection +
    nostrilWing * (0.0068 * p.noseWidthScale);
  z += noseUnder * 0.0042;
  y -= noseTip * 0.0028;

  // 7. Zygomatic Cheekbones + Sub-malar Buccal Contour
  const cheek =
    gaussian(Math.abs(x) - (isFemale ? 0.043 : 0.046), 0.0155) *
    gaussian(y - 0.084, 0.013) *
    smoothstep(-0.032, -0.074, z);
  z -= cheek * p.cheekboneBoost;
  x += Math.sign(x) * cheek * (p.cheekboneBoost * 0.35);

  const buccalHollow =
    gaussian(Math.abs(x) - 0.042, 0.014) *
    gaussian(y - 0.058, 0.014) *
    smoothstep(-0.028, -0.068, z);
  z += buccalHollow * p.buccalHollow;

  // 8. Recessed Philtrum + Two-Part Upper/Lower Lip Shelf + Oral Fissure
  const mouthFront = smoothstep(-0.056, -0.080, z);
  // Vertical philtrum groove between nose base and upper lip Cupid's bow
  const philtrumGroove =
    mouthFront * gaussian(x, 0.0042) * gaussian(y - 0.0645, 0.0052);
  const philtrumRidges =
    mouthFront * gaussian(Math.abs(x) - 0.0068, 0.0032) * gaussian(y - 0.064, 0.0048);
  z += philtrumGroove * 0.0032;
  z -= philtrumRidges * 0.0018;

  // Upper lip with Cupid's bow dip & tubercle, lower lip shelf, recessed oral slit
  const mouthWidthMask = mouthFront * gaussian(x, 0.0225);
  const cupidsBow = 1 - 0.22 * gaussian(x, 0.0038) + 0.10 * gaussian(Math.abs(x) - 0.0065, 0.004);
  const upperLipProfile = mouthWidthMask * gaussian(y - 0.0582, 0.0038) * cupidsBow;
  const lowerLipProfile = mouthWidthMask * gaussian(y - 0.0476, 0.0044) * gaussian(x, 0.021);
  const mouthSlit = mouthWidthMask * gaussian(y - 0.053, 0.0024);

  z -= upperLipProfile * p.lipFullness + lowerLipProfile * (p.lipFullness * 0.96);
  z += mouthSlit * 0.0092;

  // 9. Sculpted Ears (slim helix + subtle concha indent, fits cleanly under ear-pro/MICH)
  const earX = Math.abs(x) - p.rx * 0.93;
  const earHelix =
    gaussian(earX, 0.012) * gaussian(y - 0.097, 0.019) * gaussian(z - 0.007, 0.013);
  const earConcha =
    gaussian(earX, 0.010) * gaussian(y - 0.096, 0.009) * gaussian(z - 0.003, 0.007);
  x += Math.sign(x) * (earHelix * 0.0085 - earConcha * 0.0032);

  return out.set(x, y, z);
}

/**
 * Computes the unit outward normal of the anatomical head surface at unit sphere direction (ux, uy, uz)
 * using tangent-plane finite differences.
 */
function evaluateAnatomicalHeadNormal(
  ux: number,
  uy: number,
  uz: number,
  p: HeadAnatomyProfile,
  outNormal: THREE.Vector3,
): THREE.Vector3 {
  const eps = 0.012;
  // Build an orthonormal tangent basis (t1, t2) on the unit sphere
  let t1x: number;
  let t1y: number;
  let t1z: number;
  if (Math.abs(uy) < 0.9) {
    t1x = -uz;
    t1y = 0;
    t1z = ux;
  } else {
    t1x = 1;
    t1y = 0;
    t1z = 0;
  }
  const t1Len = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= t1Len;
  t1y /= t1Len;
  t1z /= t1Len;

  // t2 = u x t1
  const t2x = uy * t1z - uz * t1y;
  const t2y = uz * t1x - ux * t1z;
  const t2z = ux * t1y - uy * t1x;

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const pD = new THREE.Vector3();

  const evalUnit = (dx: number, dy: number, dz: number, dest: THREE.Vector3) => {
    const l = Math.hypot(dx, dy, dz) || 1;
    evaluateAnatomicalHeadPoint(dx / l, dy / l, dz / l, p, dest);
  };

  evalUnit(ux + t1x * eps, uy + t1y * eps, uz + t1z * eps, pA);
  evalUnit(ux - t1x * eps, uy - t1y * eps, uz - t1z * eps, pB);
  evalUnit(ux + t2x * eps, uy + t2y * eps, uz + t2z * eps, pC);
  evalUnit(ux - t2x * eps, uy - t2y * eps, uz - t2z * eps, pD);

  pA.sub(pB);
  pC.sub(pD);
  outNormal.crossVectors(pA, pC);
  if (outNormal.lengthSq() < 1e-10) {
    return outNormal.set(ux, uy, uz).normalize();
  }
  outNormal.normalize();
  // Guarantee outward orientation
  if (outNormal.x * ux + outNormal.y * uy + outNormal.z * uz < 0) {
    outNormal.negate();
  }
  return outNormal;
}

/**
 * Evaluates all 15 facial morph deltas at a given sculpted head vertex (x, y, z)
 * so both the cube-sphere head and the 3D brow strips deform in exact lockstep.
 */
function evaluateMorphDelta(
  name: FacialMorphTargetName,
  x: number,
  y: number,
  z: number,
  p: HeadAnatomyProfile,
  out: THREE.Vector3,
): THREE.Vector3 {
  const frontFaceMask = smoothstep(-0.036, -0.072, z);
  const browY = 0.122 + p.browHeightOffset;
  const eyeX = p.eyeSpacingX;
  const eyeY = p.eyeCenterY;

  switch (name) {
    case 'brow_inner_up': {
      const m = frontFaceMask * gaussian(x, 0.022) * gaussian(y - browY, 0.012);
      return out.set(0, m * 0.0056, -m * 0.0012);
    }
    case 'brow_outer_up': {
      const m = frontFaceMask * gaussian(Math.abs(x) - 0.038, 0.014) * gaussian(y - browY, 0.012);
      return out.set(0, m * 0.0052, -m * 0.001);
    }
    case 'brow_furrow_down': {
      const m = frontFaceMask * gaussian(x, 0.044) * gaussian(y - (browY - 0.001), 0.013);
      return out.set(-Math.sign(x) * m * 0.0028, -m * 0.0058, -m * 0.0024);
    }
    case 'eye_blink_l': {
      const uL = frontFaceMask * gaussian(x + eyeX, 0.014) * gaussian(y - (eyeY + 0.0075), 0.0068);
      const lL = frontFaceMask * gaussian(x + eyeX, 0.014) * gaussian(y - (eyeY - 0.0085), 0.0062);
      return out.set(0, -uL * 0.0135 + lL * 0.0032, -(uL + lL) * 0.0042);
    }
    case 'eye_blink_r': {
      const uR = frontFaceMask * gaussian(x - eyeX, 0.014) * gaussian(y - (eyeY + 0.0075), 0.0068);
      const lR = frontFaceMask * gaussian(x - eyeX, 0.014) * gaussian(y - (eyeY - 0.0085), 0.0062);
      return out.set(0, -uR * 0.0135 + lR * 0.0032, -(uR + lR) * 0.0042);
    }
    case 'eye_squint_l': {
      const uL = frontFaceMask * gaussian(x + eyeX, 0.014) * gaussian(y - (eyeY + 0.0075), 0.0068);
      const lL = frontFaceMask * gaussian(x + eyeX, 0.014) * gaussian(y - (eyeY - 0.0085), 0.0062);
      return out.set(-uL * 0.0008, lL * 0.0055 - uL * 0.0035, -(lL + uL) * 0.002);
    }
    case 'eye_squint_r': {
      const uR = frontFaceMask * gaussian(x - eyeX, 0.014) * gaussian(y - (eyeY + 0.0075), 0.0068);
      const lR = frontFaceMask * gaussian(x - eyeX, 0.014) * gaussian(y - (eyeY - 0.0085), 0.0062);
      return out.set(uR * 0.0008, lR * 0.0055 - uR * 0.0035, -(lR + uR) * 0.002);
    }
    case 'eye_wide': {
      const uBoth =
        frontFaceMask *
        (gaussian(x + eyeX, 0.014) + gaussian(x - eyeX, 0.014)) *
        gaussian(y - (eyeY + 0.0075), 0.0068);
      const lBoth =
        frontFaceMask *
        (gaussian(x + eyeX, 0.014) + gaussian(x - eyeX, 0.014)) *
        gaussian(y - (eyeY - 0.0085), 0.0062);
      return out.set(0, uBoth * 0.0052 - lBoth * 0.0022, -uBoth * 0.0015);
    }
    case 'cheek_raise': {
      const m = frontFaceMask * gaussian(Math.abs(x) - 0.039, 0.016) * gaussian(y - 0.083, 0.014);
      return out.set(0, m * 0.0048, -m * 0.0032);
    }
    case 'sneer_snarl_l': {
      const m = frontFaceMask * gaussian(x + 0.019, 0.013) * gaussian(y - 0.068, 0.013);
      return out.set(-m * 0.0025, m * 0.0068, -m * 0.0025);
    }
    case 'sneer_snarl_r': {
      const m = frontFaceMask * gaussian(x - 0.019, 0.013) * gaussian(y - 0.068, 0.013);
      return out.set(m * 0.0025, m * 0.0068, -m * 0.0025);
    }
    case 'jaw_open': {
      const lowerJawMask =
        smoothstep(0.0545, 0.044, y) *
        smoothstep(0.025, -0.035, z) *
        smoothstep(0.005, 0.024, y);
      if (lowerJawMask <= 0.001) return out.set(0, 0, 0);
      const hingeY = 0.072;
      const hingeZ = -0.020;
      const relY = y - hingeY;
      const relZ = z - hingeZ;
      const angle = lowerJawMask * 0.40;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const rotY = relY * cosA + relZ * sinA;
      const rotZ = -relY * sinA + relZ * cosA;
      return out.set(0, hingeY + rotY - y, hingeZ + rotZ - z);
    }
    case 'mouth_tense_grimace': {
      const m = frontFaceMask * gaussian(y - 0.053, 0.010) * gaussian(x, 0.028);
      return out.set(Math.sign(x) * m * 0.0042, -m * 0.0008, m * 0.0026);
    }
    case 'lip_pull_upper': {
      const m =
        frontFaceMask * gaussian(x, 0.022) * smoothstep(0.051, 0.059, y) * gaussian(y - 0.060, 0.008);
      return out.set(0, m * 0.0065, -m * 0.0032);
    }
    case 'lip_corner_snarl': {
      const m = frontFaceMask * gaussian(Math.abs(x) - 0.023, 0.010) * gaussian(y - 0.054, 0.009);
      return out.set(Math.sign(x) * m * 0.0045, m * 0.0034, m * 0.0022);
    }
  }
}

// ============================================================================
// CUBE-SPHERE BASE TOPOLOGY (24x24 PER FACE, ZERO POLAR PINCHING, SEAM-SAFE UVS)
// ============================================================================

interface CubeSphereTemplate {
  readonly unitDirs: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly vertCount: number;
  readonly gridN: number;
}

let cachedCubeSphereTemplate: CubeSphereTemplate | null = null;

function buildCubeSphereTemplate(gridN = 24): CubeSphereTemplate {
  if (cachedCubeSphereTemplate && cachedCubeSphereTemplate.gridN === gridN) {
    return cachedCubeSphereTemplate;
  }

  const dirs: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const tmp = new THREE.Vector3();

  // Compute spherical UV with u=0.5 along front midline (-Z) and wrap at rear (+Z).
  // `seamSide` resolves vertices lying directly on the rear meridian (ux === 0, uz > 0):
  //   -1 => u = 0.0 (left rear side), +1 => u = 1.0 (right rear side).
  const pushVertex = (cx: number, cy: number, cz: number, seamSide: -1 | 0 | 1): number => {
    spherifyCubePoint(cx, cy, cz, tmp);
    dirs.push(tmp.x, tmp.y, tmp.z);

    let u: number;
    if (seamSide !== 0 && Math.abs(tmp.x) < 1e-6 && tmp.z > 0) {
      u = seamSide < 0 ? 0.0 : 1.0;
    } else {
      const az = Math.atan2(tmp.x, -tmp.z); // 0 at -Z front, ±PI at +Z rear
      u = 0.5 + az / (2 * Math.PI);
    }
    const v = 0.5 + Math.asin(THREE.MathUtils.clamp(tmp.y, -1, 1)) / Math.PI;
    uvs.push(u, v);
    return dirs.length / 3 - 1;
  };

  // Emit a subdivided rectangular patch on a cube face with outward-facing CCW winding.
  // `mapCube(a, b)` maps patch coords (a in [a0, a1], b in [b0, b1]) -> [cx, cy, cz].
  const emitFacePatch = (
    segsA: number,
    segsB: number,
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    seamSide: -1 | 0 | 1,
    mapCube: (a: number, b: number) => readonly [number, number, number],
  ) => {
    const startIdx = dirs.length / 3;
    const stride = segsA + 1;
    for (let ib = 0; ib <= segsB; ib++) {
      const b = THREE.MathUtils.lerp(b0, b1, ib / segsB);
      for (let ia = 0; ia <= segsA; ia++) {
        const a = THREE.MathUtils.lerp(a0, a1, ia / segsA);
        const [cx, cy, cz] = mapCube(a, b);
        pushVertex(cx, cy, cz, seamSide);
      }
    }

    // Check outward winding on the center quad once
    const midA = Math.floor(segsA / 2);
    const midB = Math.floor(segsB / 2);
    const i0 = startIdx + midB * stride + midA;
    const i1 = i0 + 1;
    const i2 = i0 + stride;
    const v0 = new THREE.Vector3(dirs[i0 * 3], dirs[i0 * 3 + 1], dirs[i0 * 3 + 2]);
    const v1 = new THREE.Vector3(dirs[i1 * 3], dirs[i1 * 3 + 1], dirs[i1 * 3 + 2]);
    const v2 = new THREE.Vector3(dirs[i2 * 3], dirs[i2 * 3 + 1], dirs[i2 * 3 + 2]);
    const triNorm = new THREE.Vector3().subVectors(v1, v0).cross(new THREE.Vector3().subVectors(v2, v0));
    const flip = triNorm.dot(v0) < 0;

    for (let ib = 0; ib < segsB; ib++) {
      for (let ia = 0; ia < segsA; ia++) {
        const a = startIdx + ib * stride + ia;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (flip) {
          indices.push(a, d, b, a, c, d);
        } else {
          indices.push(a, b, d, a, d, c);
        }
      }
    }
  };

  const half = gridN / 2;
  // 1. Front face (-Z): continuous u around 0.5
  emitFacePatch(gridN, gridN, -1, 1, -1, 1, 0, (a, b) => [a, b, -1]);
  // 2. Right face (+X): continuous u in [0.625, 0.875]
  emitFacePatch(gridN, gridN, -1, 1, -1, 1, 0, (a, b) => [1, b, a]);
  // 3. Left face (-X): continuous u in [0.125, 0.375]
  emitFacePatch(gridN, gridN, -1, 1, -1, 1, 0, (a, b) => [-1, b, -a]);

  // 4. Rear face (+Z): split cleanly along ux = 0 so NO triangle crosses the u=0/u=1 seam
  emitFacePatch(half, gridN, -1, 0, -1, 1, -1, (a, b) => [a, b, 1]);
  emitFacePatch(half, gridN, 0, 1, -1, 1, 1, (a, b) => [a, b, 1]);

  // 5. Top face (+Y): split along ux = 0 so rear half never crosses the u=0/u=1 seam
  emitFacePatch(half, gridN, -1, 0, -1, 1, -1, (a, b) => [a, 1, b]);
  emitFacePatch(half, gridN, 0, 1, -1, 1, 1, (a, b) => [a, 1, b]);

  // 6. Bottom face (-Y): split along ux = 0 so rear half never crosses the u=0/u=1 seam
  emitFacePatch(half, gridN, -1, 0, -1, 1, -1, (a, b) => [a, -1, b]);
  emitFacePatch(half, gridN, 0, 1, -1, 1, 1, (a, b) => [a, -1, b]);

  cachedCubeSphereTemplate = {
    unitDirs: new Float32Array(dirs),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    vertCount: dirs.length / 3,
    gridN,
  };
  return cachedCubeSphereTemplate;
}

/**
 * Computes seamless vertex normals across duplicated cube-face and UV-seam vertices
 * by accumulating triangle normals into spatially welded position buckets.
 */
function computeWeldedSmoothNormals(geo: THREE.BufferGeometry): void {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const idxAttr = geo.getIndex();
  const vCount = posAttr.count;
  const normals = new Float32Array(vCount * 3);

  const buckets = new Map<string, number[]>();
  const keyOf = (i: number): string =>
    `${Math.round(posAttr.getX(i) * 20000)},${Math.round(posAttr.getY(i) * 20000)},${Math.round(posAttr.getZ(i) * 20000)}`;

  for (let i = 0; i < vCount; i++) {
    const k = keyOf(i);
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(i);
  }

  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const pC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const fn = new THREE.Vector3();

  const triCount = idxAttr ? idxAttr.count / 3 : vCount / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = idxAttr ? idxAttr.getX(t * 3) : t * 3;
    const i1 = idxAttr ? idxAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(t * 3 + 2) : t * 3 + 2;

    pA.fromBufferAttribute(posAttr, i0);
    pB.fromBufferAttribute(posAttr, i1);
    pC.fromBufferAttribute(posAttr, i2);
    ab.subVectors(pB, pA);
    ac.subVectors(pC, pA);
    fn.crossVectors(ab, ac);

    normals[i0 * 3] += fn.x;
    normals[i0 * 3 + 1] += fn.y;
    normals[i0 * 3 + 2] += fn.z;
    normals[i1 * 3] += fn.x;
    normals[i1 * 3 + 1] += fn.y;
    normals[i1 * 3 + 2] += fn.z;
    normals[i2 * 3] += fn.x;
    normals[i2 * 3 + 1] += fn.y;
    normals[i2 * 3 + 2] += fn.z;
  }

  // Sum welded duplicate vertices & normalize
  for (const group of buckets.values()) {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let j = 0; j < group.length; j++) {
      const vi = group[j];
      sx += normals[vi * 3];
      sy += normals[vi * 3 + 1];
      sz += normals[vi * 3 + 2];
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    sx /= len;
    sy /= len;
    sz /= len;
    for (let j = 0; j < group.length; j++) {
      const vi = group[j];
      normals[vi * 3] = sx;
      normals[vi * 3 + 1] = sy;
      normals[vi * 3 + 2] = sz;
    }
  }

  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

// ============================================================================
// CACHED CUBE-SPHERE ANATOMICAL HEAD GEOMETRY + 15 MORPH TARGETS
// ============================================================================

const sharedHeadGeoCache = new Map<string, THREE.BufferGeometry>();

export function getSharedAnatomicalHeadGeometry(
  variant: AnatomicalHeadVariant,
  facePreset: FacePresetId = DEFAULT_FACE_PRESET_ID,
): THREE.BufferGeometry {
  const resolvedPreset = variant === 'zombie' ? DEFAULT_FACE_PRESET_ID : normalizeFacePresetId(facePreset);
  const cacheKey = `${variant}_${resolvedPreset}`;
  const cached = sharedHeadGeoCache.get(cacheKey);
  if (cached) return cached;

  const profile = getHeadAnatomyProfile(variant, resolvedPreset);
  const tmpl = buildCubeSphereTemplate(24);
  const vertCount = tmpl.vertCount;

  const basePositions = new Float32Array(vertCount * 3);
  const morphArrays: Record<FacialMorphTargetName, Float32Array> = {} as Record<
    FacialMorphTargetName,
    Float32Array
  >;
  for (const name of FACIAL_MORPH_TARGET_NAMES) {
    morphArrays[name] = new Float32Array(vertCount * 3);
  }

  const pt = new THREE.Vector3();
  const delta = new THREE.Vector3();

  for (let i = 0; i < vertCount; i++) {
    const ux = tmpl.unitDirs[i * 3];
    const uy = tmpl.unitDirs[i * 3 + 1];
    const uz = tmpl.unitDirs[i * 3 + 2];

    evaluateAnatomicalHeadPoint(ux, uy, uz, profile, pt);
    const x = pt.x;
    const y = pt.y;
    const z = pt.z;

    basePositions[i * 3] = x;
    basePositions[i * 3 + 1] = y;
    basePositions[i * 3 + 2] = z;

    for (let m = 0; m < FACIAL_MORPH_COUNT; m++) {
      const name = FACIAL_MORPH_TARGET_NAMES[m];
      evaluateMorphDelta(name, x, y, z, profile, delta);
      const arr = morphArrays[name];
      arr[i * 3] = x + delta.x;
      arr[i * 3 + 1] = y + delta.y;
      arr[i * 3 + 2] = z + delta.z;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(basePositions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(tmpl.uvs), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(tmpl.indices), 1));
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = FACIAL_MORPH_TARGET_NAMES.map((name) => {
    const attr = new THREE.BufferAttribute(morphArrays[name], 3);
    attr.name = name;
    return attr;
  });

  computeWeldedSmoothNormals(geo);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  sharedHeadGeoCache.set(cacheKey, geo);
  return geo;
}

// ============================================================================
// SEPARATE OFFSET PROCEDURAL HAIR CAP / FADE SHELL (+1.5mm TO +5mm NORMAL OFFSET)
// ============================================================================

const sharedHairCapGeoCache = new Map<string, THREE.BufferGeometry>();

/**
 * Evaluates a signed scalp hair coverage mask (<= 0 outside hair, > 0 inside hair, 0..1 thickness weight)
 * with crisp forehead hairline, natural temple peaks, tapered sideburns, ear clearance arch, and rear nape.
 */
function evaluateHairMaskAndThickness(
  x: number,
  y: number,
  z: number,
  ux: number,
  uy: number,
  uz: number,
  p: HeadAnatomyProfile,
  zombieHairStyle: ZombieHairStyle,
): { inside: boolean; thickness: number } {
  if (p.variant === 'zombie' && zombieHairStyle === 'bald') {
    return { inside: false, thickness: 0 };
  }

  const absX = Math.abs(x);
  // Azimuth around head: 0 = front midline (-Z), PI/2 = ear, PI = rear nape (+Z)
  const az = Math.atan2(absX, -z);
  const frontness = smoothstep(Math.PI * 0.55, 0.0, az); // 1 at front, 0 at ears/back
  const rearness = smoothstep(Math.PI * 0.38, Math.PI * 0.85, az); // 0 front, 1 rear occiput

  // Forehead hairline height with natural temple peak recession (male) or gentle curve (female)
  const templePeak =
    gaussian(az - 0.58, 0.24) * p.templeRecession;
  const widowPeak =
    p.hairCut === 'female_swept_bun' || p.hairCut === 'male_short_crop'
      ? -gaussian(az, 0.16) * 0.0035
      : 0;
  let hairlineY = p.hairlineY + templePeak + widowPeak;

  // Transition down over sideburns (az ~ 1.05..1.42) then arch cleanly ABOVE the ear (az ~ 1.45..1.85),
  // then curve down into the tapered rear nape (az > 1.95 -> y ~ 0.058..0.068).
  const sideburnZone = gaussian(az - 1.18, 0.16);
  const earArchZone = gaussian(az - 1.62, 0.22);
  const napeCurve = smoothstep(1.65, 2.35, az);

  // Base side-to-back hairline boundary
  const sideBaseY = THREE.MathUtils.lerp(hairlineY, 0.114, smoothstep(0.65, 1.15, az));
  let boundaryY = THREE.MathUtils.lerp(
    sideBaseY,
    p.variant === 'female' ? 0.056 : 0.064,
    napeCurve,
  );

  // Sculpted sideburn drop in front of ears
  const sideburnDrop =
    p.hairCut === 'male_high_tight'
      ? 0.015
      : p.hairCut === 'male_buzz_fade'
        ? 0.018
        : p.hairCut === 'male_short_crop'
          ? 0.024
          : 0.020;
  boundaryY -= sideburnZone * sideburnDrop;

  // Clean arch over upper ear helix so hair cap never swallows the ear
  boundaryY += earArchZone * 0.012;

  // Subtle tapered nape V-contour on the back of the neck
  if (az > 2.35) {
    boundaryY -= gaussian(az - Math.PI, 0.34) * 0.006;
  }

  // Distance above hairline boundary
  const aboveLine = y - boundaryY;
  if (aboveLine < -0.002) {
    return { inside: false, thickness: 0 };
  }

  // Zombie tattered patchy hair: deterministic ragged bald patches & uneven length
  if (p.variant === 'zombie') {
    const patchNoise =
      Math.sin(ux * 11.3 + uz * 9.7) * Math.cos(uy * 13.1 - ux * 7.4) +
      0.5 * Math.sin(ux * 23.0 - uy * 19.0 + uz * 17.0);
    if (patchNoise < -0.22 || aboveLine < 0.004) {
      return { inside: false, thickness: 0 };
    }
    const edgeT = smoothstep(0.004, 0.024, aboveLine);
    const clump = 0.65 + 0.55 * Math.max(0, patchNoise);
    return {
      inside: true,
      thickness: THREE.MathUtils.lerp(0.0014, p.hairCrownThickness * clump, edgeT),
    };
  }

  // Fade transition from crisp stepped hairline edge up into full crown thickness
  const fadeRamp = smoothstep(-0.001, 0.026, aboveLine);
  const crownWeight = smoothstep(0.132, 0.168, y);

  let baseOffset = THREE.MathUtils.lerp(p.hairSideThickness, p.hairCrownThickness, crownWeight);

  // Hair-cut specific crown sculpting
  if (p.hairCut === 'male_high_tight') {
    // Crisp high fade: tight sides below y=0.145, fuller crew crown above
    const highFadeStep = smoothstep(0.140, 0.156, y);
    baseOffset = THREE.MathUtils.lerp(0.0016, p.hairCrownThickness, highFadeStep);
    baseOffset += frontness * highFadeStep * 0.0012;
  } else if (p.hairCut === 'male_short_crop') {
    // Textured short crop with slightly fuller forward fringe & subtle surface texture waves
    const wave =
      (Math.sin(x * 160 + z * 95) * 0.5 + Math.cos(x * 110 - z * 140) * 0.5) * 0.00075 * crownWeight;
    baseOffset += frontness * crownWeight * 0.0016 + wave;
  } else if (p.hairCut === 'male_buzz_fade') {
    // Tight uniform buzz fade (+1.5mm sides -> +2.8mm crown)
    baseOffset = THREE.MathUtils.lerp(0.0015, p.hairCrownThickness, smoothstep(0.125, 0.155, y));
  } else if (p.hairCut === 'female_swept_bun') {
    // Smooth swept volume pulling back toward the rear low bun
    baseOffset += (0.0008 * rearness + 0.0007 * crownWeight);
  } else if (p.hairCut === 'female_parted_bun') {
    // Subtle off-center part groove along x ≈ -0.014 on top crown
    const partGroove = gaussian(x + 0.014, 0.0065) * smoothstep(0.155, 0.185, y) * (1 - rearness * 0.6);
    baseOffset = Math.max(0.0018, baseOffset - partGroove * 0.0016);
  } else if (p.hairCut === 'female_close_fade_bun') {
    const wave = Math.sin(x * 210) * Math.cos(z * 210) * 0.00045 * crownWeight;
    baseOffset += wave;
  }

  // Crisp stepped edge thickness (at least +1.3mm at the hairline edge, zero feather-to-skin z-fighting)
  const finalThickness = THREE.MathUtils.lerp(0.0013, baseOffset, fadeRamp);
  return { inside: true, thickness: finalThickness };
}

/**
 * Builds and caches a separate procedural offset hair cap shell matching the exact
 * cube-sphere scalp profile of `(variant, facePreset)` with stepped hairline, temple peaks,
 * sideburns, and rear nape contour.
 */
export function getSharedHairCapGeometry(
  variant: AnatomicalHeadVariant,
  facePreset: FacePresetId = DEFAULT_FACE_PRESET_ID,
  zombieHairStyle: ZombieHairStyle = 'tattered',
): THREE.BufferGeometry | null {
  if (variant === 'zombie' && zombieHairStyle === 'bald') {
    return null;
  }

  const resolvedPreset = variant === 'zombie' ? DEFAULT_FACE_PRESET_ID : normalizeFacePresetId(facePreset);
  const cacheKey = `${variant}_${resolvedPreset}_${variant === 'zombie' ? zombieHairStyle : 'std'}`;
  const cached = sharedHairCapGeoCache.get(cacheKey);
  if (cached) return cached;

  const profile = getHeadAnatomyProfile(variant, resolvedPreset);
  const tmpl = buildCubeSphereTemplate(24);
  const vertCount = tmpl.vertCount;

  const insideFlags = new Uint8Array(vertCount);
  const scalpPositions = new Float32Array(vertCount * 3);
  const capPositions = new Float32Array(vertCount * 3);
  const pt = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (let i = 0; i < vertCount; i++) {
    const ux = tmpl.unitDirs[i * 3];
    const uy = tmpl.unitDirs[i * 3 + 1];
    const uz = tmpl.unitDirs[i * 3 + 2];

    evaluateAnatomicalHeadPoint(ux, uy, uz, profile, pt);
    scalpPositions[i * 3] = pt.x;
    scalpPositions[i * 3 + 1] = pt.y;
    scalpPositions[i * 3 + 2] = pt.z;

    const evalRes = evaluateHairMaskAndThickness(
      pt.x,
      pt.y,
      pt.z,
      ux,
      uy,
      uz,
      profile,
      zombieHairStyle,
    );
    if (evalRes.inside) {
      insideFlags[i] = 1;
      evaluateAnatomicalHeadNormal(ux, uy, uz, profile, nrm);
      capPositions[i * 3] = pt.x + nrm.x * evalRes.thickness;
      capPositions[i * 3 + 1] = pt.y + nrm.y * evalRes.thickness;
      capPositions[i * 3 + 2] = pt.z + nrm.z * evalRes.thickness;
    } else {
      capPositions[i * 3] = pt.x;
      capPositions[i * 3 + 1] = pt.y;
      capPositions[i * 3 + 2] = pt.z;
    }
  }

  // Extract triangles where all 3 vertices are inside the scalp hair mask,
  // plus build a clean 1.3mm stepped hairline rim skirt along boundary edges so the hair cap has real physical volume!
  const remap = new Int32Array(vertCount).fill(-1);
  const outPos: number[] = [];
  const outUvs: number[] = [];
  const outIdx: number[] = [];

  const getRemapped = (oldIdx: number): number => {
    let r = remap[oldIdx];
    if (r !== -1) return r;
    r = outPos.length / 3;
    remap[oldIdx] = r;
    outPos.push(capPositions[oldIdx * 3], capPositions[oldIdx * 3 + 1], capPositions[oldIdx * 3 + 2]);
    // Directional hair UVs: wrap cleanly around azimuth and elevation
    outUvs.push(tmpl.uvs[oldIdx * 2] * 3.0, tmpl.uvs[oldIdx * 2 + 1] * 3.0);
    return r;
  };

  // Track directed half-edges to detect open hairline perimeter edges for stepped skirt closure
  const edgeCounts = new Map<string, { a: number; b: number; count: number }>();
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const entry = edgeCounts.get(key);
    if (entry) {
      entry.count++;
    } else {
      edgeCounts.set(key, { a, b, count: 1 });
    }
  };

  const triCount = tmpl.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = tmpl.indices[t * 3];
    const i1 = tmpl.indices[t * 3 + 1];
    const i2 = tmpl.indices[t * 3 + 2];
    if (insideFlags[i0] && insideFlags[i1] && insideFlags[i2]) {
      const n0 = getRemapped(i0);
      const n1 = getRemapped(i1);
      const n2 = getRemapped(i2);
      outIdx.push(n0, n1, n2);
      addEdge(i0, i1);
      addEdge(i1, i2);
      addEdge(i2, i0);
    }
  }

  // Add subtle stepped skirt along the open hairline boundary down to the scalp surface (tucked +0.2mm inside)
  for (const edge of edgeCounts.values()) {
    if (edge.count !== 1) continue;
    const { a, b } = edge;
    const ra = remap[a];
    const rb = remap[b];
    if (ra === -1 || rb === -1) continue;

    // Only skirt genuine hairline boundary edges (skip cube-face split boundaries that share 3D position)
    const sa = outPos.length / 3;
    outPos.push(scalpPositions[a * 3], scalpPositions[a * 3 + 1], scalpPositions[a * 3 + 2]);
    outUvs.push(tmpl.uvs[a * 2] * 3.0, tmpl.uvs[a * 2 + 1] * 3.0);

    const sb = outPos.length / 3;
    outPos.push(scalpPositions[b * 3], scalpPositions[b * 3 + 1], scalpPositions[b * 3 + 2]);
    outUvs.push(tmpl.uvs[b * 2] * 3.0, tmpl.uvs[b * 2 + 1] * 3.0);

    outIdx.push(ra, sb, rb, ra, sa, sb);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(outUvs, 2));
  geo.setIndex(outIdx);
  computeWeldedSmoothNormals(geo);
  geo.computeBoundingSphere();

  sharedHairCapGeoCache.set(cacheKey, geo);
  return geo;
}

// ============================================================================
// RAISED 3D DEFORMING EYEBROW STRIPS (CONFORMED TO SUPRAORBITAL BROW + MORPHS)
// ============================================================================

const sharedBrowGeoCache = new Map<string, THREE.BufferGeometry>();

/**
 * Builds and caches thin, slightly raised 3D left & right eyebrow ridge strips conformed
 * directly to the preset's supraorbital ridge, with all 15 facial morph attributes baked
 * so sharing `headMesh.morphTargetInfluences` drives brow furrows & raises automatically.
 */
export function getSharedBrowStripsGeometry(
  variant: AnatomicalHeadVariant,
  facePreset: FacePresetId = DEFAULT_FACE_PRESET_ID,
): THREE.BufferGeometry {
  const resolvedPreset = variant === 'zombie' ? DEFAULT_FACE_PRESET_ID : normalizeFacePresetId(facePreset);
  const cacheKey = `${variant}_${resolvedPreset}`;
  const cached = sharedBrowGeoCache.get(cacheKey);
  if (cached) return cached;

  const p = getHeadAnatomyProfile(variant, resolvedPreset);
  const segU = 10; // medial -> lateral
  const segV = 3; // bottom -> ridge peak -> top

  const basePos: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const pt = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  for (const side of [-1, 1]) {
    const baseVertOffset = basePos.length / 3;
    for (let iv = 0; iv <= segV; iv++) {
      const vf = iv / segV; // 0 = lower edge, 0.5 = center ridge, 1 = upper edge
      const vCentered = (vf - 0.5) * 2; // -1..+1
      const crossProfile = Math.cos(vCentered * Math.PI * 0.5); // 0 at edges, 1 at spine

      for (let iu = 0; iu <= segU; iu++) {
        const uf = iu / segU; // 0 = inner glabella end, 1 = outer tail
        const lengthTaper = Math.sin(Math.pow(uf, 0.72) * Math.PI);
        const halfH = p.browThickness * (0.35 + 0.75 * lengthTaper);

        // Azimuth along the supraorbital brow from inner corner to outer temple tail
        const az = side * THREE.MathUtils.lerp(0.14, 0.64, uf);
        const archLift = Math.sin(Math.pow(uf, 0.85) * Math.PI) * (p.browArch + 0.0024);
        const targetY = 0.1205 + p.browHeightOffset + archLift + vCentered * halfH;

        // Convert (az, targetY) back to unit sphere direction (ux, uy, uz)
        const uy = THREE.MathUtils.clamp((targetY - 0.104) / p.ry, -0.95, 0.95);
        const horiz = Math.sqrt(Math.max(0.01, 1 - uy * uy));
        const ux = Math.sin(az) * horiz;
        const uz = -Math.cos(az) * horiz;

        evaluateAnatomicalHeadPoint(ux, uy, uz, p, pt);
        evaluateAnatomicalHeadNormal(ux, uy, uz, p, nrm);

        // Raised +1.4mm at center ridge, tucked flush (+0.25mm) at edges so zero floating gap
        const lift = 0.00025 + crossProfile * (0.00135 * (0.45 + 0.55 * lengthTaper));
        basePos.push(pt.x + nrm.x * lift, pt.y + nrm.y * lift, pt.z + nrm.z * lift);
        uvs.push(uf, vf);
      }
    }

    const stride = segU + 1;
    for (let iv = 0; iv < segV; iv++) {
      for (let iu = 0; iu < segU; iu++) {
        const a = baseVertOffset + iv * stride + iu;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (side > 0) {
          indices.push(a, b, d, a, d, c);
        } else {
          indices.push(a, d, b, a, c, d);
        }
      }
    }
  }

  const vertCount = basePos.length / 3;
  const morphAttrs: THREE.BufferAttribute[] = [];
  const delta = new THREE.Vector3();

  for (let m = 0; m < FACIAL_MORPH_COUNT; m++) {
    const name = FACIAL_MORPH_TARGET_NAMES[m];
    const arr = new Float32Array(vertCount * 3);
    const isBrowMorph =
      name === 'brow_inner_up' || name === 'brow_outer_up' || name === 'brow_furrow_down';
    for (let i = 0; i < vertCount; i++) {
      const bx = basePos[i * 3];
      const by = basePos[i * 3 + 1];
      const bz = basePos[i * 3 + 2];
      if (isBrowMorph) {
        evaluateMorphDelta(name, bx, by, bz, p, delta);
        arr[i * 3] = bx + delta.x;
        arr[i * 3 + 1] = by + delta.y;
        arr[i * 3 + 2] = bz + delta.z;
      } else {
        arr[i * 3] = bx;
        arr[i * 3 + 1] = by;
        arr[i * 3 + 2] = bz;
      }
    }
    const attr = new THREE.BufferAttribute(arr, 3);
    attr.name = name;
    morphAttrs.push(attr);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(basePos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = morphAttrs;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  sharedBrowGeoCache.set(cacheKey, geo);
  return geo;
}

// ============================================================================
// CACHED PROCEDURAL ZONED SKIN, MICRO-PORE NORMAL, HAIR STRAND & WET EYE TEXTURES
// ============================================================================

interface SkinTextureSet {
  readonly map: THREE.CanvasTexture;
  readonly roughnessMap: THREE.CanvasTexture;
}

interface HairTextureSet {
  readonly map: THREE.CanvasTexture;
  readonly normalMap: THREE.CanvasTexture;
}

const skinTextureCache = new Map<string, SkinTextureSet>();
const hairTextureCache = new Map<string, HairTextureSet>();
const scleraTextureCache = new Map<string, THREE.CanvasTexture>();
let sharedSkinPoreNormalTex: THREE.CanvasTexture | null = null;

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Generates and caches a single global 256x256 tileable tangent-space micro-pore / skin grain
 * normal map shared across every character head (zero redundant VRAM on RX 480).
 */
export function getSharedSkinPoreNormalTexture(): THREE.CanvasTexture {
  if (sharedSkinPoreNormalTex) return sharedSkinPoreNormalTex;

  const S = 256;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');

  if (ctx && typeof ctx.createImageData === 'function' && typeof ctx.putImageData === 'function') {
    // Synthesize periodic heightfield (subtle dermal pores + fine micro-creases)
    const height = new Float32Array(S * S);
    const rand = seededRand(8821);

    // Base micro-grain
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const nx = (x / S) * Math.PI * 2;
        const ny = (y / S) * Math.PI * 2;
        const weave =
          Math.sin(nx * 14 + Math.cos(ny * 10) * 0.7) * 0.14 +
          Math.cos(ny * 16 + Math.sin(nx * 12) * 0.7) * 0.14;
        height[y * S + x] = 0.5 + weave * 0.18 + (rand() - 0.5) * 0.14;
      }
    }

    // Organic recessed skin pores (periodic wrapped stamps)
    for (let p = 0; p < 520; p++) {
      const px = Math.floor(rand() * S);
      const py = Math.floor(rand() * S);
      const r = 1.3 + rand() * 2.1;
      const depth = 0.22 + rand() * 0.26;
      const radCeil = Math.ceil(r);
      for (let dy = -radCeil; dy <= radCeil; dy++) {
        for (let dx = -radCeil; dx <= radCeil; dx++) {
          const d = Math.hypot(dx, dy) / r;
          if (d >= 1) continue;
          const wx = (px + dx + S) % S;
          const wy = (py + dy + S) % S;
          const dimple = Math.cos(d * Math.PI * 0.5);
          height[wy * S + wx] -= dimple * dimple * depth;
        }
      }
    }

    const img = ctx.createImageData(S, S);
    const data = img.data;
    const strength = 2.6;

    for (let y = 0; y < S; y++) {
      const ym = (y - 1 + S) % S;
      const yp = (y + 1) % S;
      for (let x = 0; x < S; x++) {
        const xm = (x - 1 + S) % S;
        const xp = (x + 1) % S;
        const dx = (height[y * S + xp] - height[y * S + xm]) * strength;
        const dy = (height[yp * S + x] - height[ym * S + x]) * strength;
        const nx = -dx;
        const ny = -dy;
        const nz = 1.0;
        const invLen = 1 / Math.hypot(nx, ny, nz);
        const idx = (y * S + x) * 4;
        data[idx] = Math.round((nx * invLen * 0.5 + 0.5) * 255);
        data[idx + 1] = Math.round((ny * invLen * 0.5 + 0.5) * 255);
        data[idx + 2] = Math.round((nz * invLen * 0.5 + 0.5) * 255);
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  } else if (ctx) {
    // Fallback for lightweight mock canvases in Node unit tests
    ctx.fillStyle = 'rgb(128,128,255)';
    ctx.fillRect(0, 0, S, S);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 7);
  tex.needsUpdate = true;
  sharedSkinPoreNormalTex = tex;
  return tex;
}

/**
 * Generates and caches directional hair-strand albedo + normal maps for offset hair cap shells.
 */
export function getSharedHairTextures(
  hairHex: string,
  highlightHex: string,
  anisotropy = 4,
): HairTextureSet {
  const key = `${hairHex}_${highlightHex}`;
  const cached = hairTextureCache.get(key);
  if (cached) return cached;

  const S = 256;
  const colCanvas = createCanvas(S, S);
  const cctx = colCanvas.getContext('2d')!;
  cctx.fillStyle = hairHex;
  cctx.fillRect(0, 0, S, S);

  const rand = seededRand(hash2D(hairHex.charCodeAt(1) || 1, hairHex.charCodeAt(2) || 2, 13) * 9973);
  for (let i = 0; i < 1600; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 10 + rand() * 26;
    cctx.globalAlpha = 0.14 + rand() * 0.28;
    cctx.strokeStyle = i % 4 === 0 ? highlightHex : '#0c0a09';
    cctx.lineWidth = 0.9 + rand() * 1.1;
    cctx.beginPath();
    cctx.moveTo(x, y);
    cctx.lineTo(x + (rand() - 0.5) * 3.5, y + len);
    cctx.stroke();
  }
  cctx.globalAlpha = 1;

  // Directional strand normal map
  const nrmCanvas = createCanvas(S, S);
  const nctx = nrmCanvas.getContext('2d')!;
  nctx.fillStyle = 'rgb(128,128,255)';
  nctx.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 2) {
    const ridge = Math.sin(x * 0.95) * 36 + (rand() - 0.5) * 28;
    const r = Math.max(70, Math.min(185, Math.round(128 + ridge)));
    const g = Math.max(96, Math.min(160, Math.round(128 + (rand() - 0.5) * 22)));
    nctx.fillStyle = `rgb(${r},${g},242)`;
    nctx.fillRect(x, 0, 2, S);
  }

  const map = new THREE.CanvasTexture(colCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = Math.min(8, Math.max(1, anisotropy));
  map.needsUpdate = true;

  const normalMap = new THREE.CanvasTexture(nrmCanvas);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = Math.min(8, Math.max(1, anisotropy));
  normalMap.needsUpdate = true;

  const set: HairTextureSet = { map, normalMap };
  hairTextureCache.set(key, set);
  return set;
}

/**
 * Generates and caches realistic 512x512 zonal PBR facial skin color + roughness CanvasTextures.
 * - Warm undertones on cheeks, nose tip, and ears
 * - Cooler olive/slate jaw & beard-shadow tinting
 * - Darker ambient occlusion inside nostrils, eye corners, orbital creases, philtrum & lip line
 * - Zonal roughness: 0.38–0.45 (rgb 98..115) on forehead/nose/cheekbones; 0.65–0.75 (rgb 166..192) on jaw/neck
 * - No flat painted brown hair helmet on scalp (handled by separate offset hair cap mesh!)
 */
export function getSharedSkinTextures(
  variant: AnatomicalHeadVariant,
  toneSeed: number,
  anisotropy = 4,
  facePreset?: FacePresetId,
): SkinTextureSet {
  const resolvedPreset =
    variant === 'zombie'
      ? DEFAULT_FACE_PRESET_ID
      : facePreset
        ? normalizeFacePresetId(facePreset)
        : pickFacePresetFromSeed(toneSeed);
  const bucket = variant === 'zombie' ? 'zombie_v2' : `${variant}_${resolvedPreset}_v2`;
  const existing = skinTextureCache.get(bucket);
  if (existing) return existing;

  const profile = getHeadAnatomyProfile(variant, resolvedPreset);
  const palette = profile.palette;

  const W = 512;
  const H = 512;
  const colorCanvas = createCanvas(W, H);
  const ctx = colorCanvas.getContext('2d')!;

  const roughCanvas = createCanvas(W, H);
  const rctx = roughCanvas.getContext('2d')!;

  // 1. Base dermal tone
  ctx.fillStyle = palette.baseHex;
  ctx.fillRect(0, 0, W, H);

  // 2. Base skin roughness: jaw / neck / sides at 0.68–0.74 (rgb 174..190) for human, 0.86 for zombie
  rctx.fillStyle = variant === 'zombie' ? 'rgb(220,220,220)' : 'rgb(180,180,180)';
  rctx.fillRect(0, 0, W, H);

  const cx = W * 0.5;
  const eyeY = H * 0.495;
  const browY = H * 0.432;
  const noseTipY = H * 0.575;
  const mouthY = H * 0.658;
  const eyeOffsetX = W * 0.068;

  // Forehead, nose bridge & cheekbone highlights (subtle warm dermal bounce)
  const tZoneGrad = ctx.createRadialGradient(cx, H * 0.41, 8, cx, H * 0.46, W * 0.19);
  tZoneGrad.addColorStop(0, palette.highlightHex);
  tZoneGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = tZoneGrad;
  ctx.fillRect(cx - W * 0.22, H * 0.24, W * 0.44, H * 0.42);

  // Zonal Roughness: T-zone (forehead + nose bridge) -> 0.39–0.44 (rgb 100..112)
  const foreheadRough = rctx.createRadialGradient(cx, H * 0.38, 6, cx, H * 0.42, W * 0.14);
  foreheadRough.addColorStop(0, variant === 'zombie' ? 'rgba(170,170,170,0.65)' : 'rgba(102,102,102,0.92)');
  foreheadRough.addColorStop(1, 'rgba(180,180,180,0)');
  rctx.fillStyle = foreheadRough;
  rctx.fillRect(cx - W * 0.18, H * 0.24, W * 0.36, H * 0.36);

  const noseRough = rctx.createRadialGradient(cx, noseTipY - H * 0.02, 3, cx, noseTipY - H * 0.02, W * 0.045);
  noseRough.addColorStop(0, variant === 'zombie' ? 'rgba(162,162,162,0.6)' : 'rgba(98,98,98,0.95)');
  noseRough.addColorStop(1, 'rgba(180,180,180,0)');
  rctx.fillStyle = noseRough;
  rctx.fillRect(cx - W * 0.06, H * 0.47, W * 0.12, H * 0.16);

  // Cheekbones slightly smoother (~0.44, rgb 112) + warm vascular flush on cheeks, nose & ears
  for (const side of [-1, 1]) {
    const chkX = cx + side * W * 0.092;
    const chkY = H * 0.558;
    const chkGrad = ctx.createRadialGradient(chkX, chkY, 4, chkX, chkY, W * 0.082);
    chkGrad.addColorStop(0, palette.blushHex);
    chkGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = variant === 'zombie' ? 0.22 : 0.32;
    ctx.fillStyle = chkGrad;
    ctx.beginPath();
    ctx.arc(chkX, chkY, W * 0.082, 0, Math.PI * 2);
    ctx.fill();

    // Cheekbone roughness highlight
    const chkRough = rctx.createRadialGradient(chkX, chkY - H * 0.015, 3, chkX, chkY - H * 0.015, W * 0.055);
    chkRough.addColorStop(0, variant === 'zombie' ? 'rgba(176,176,176,0.5)' : 'rgba(114,114,114,0.85)');
    chkRough.addColorStop(1, 'rgba(180,180,180,0)');
    rctx.fillStyle = chkRough;
    rctx.beginPath();
    rctx.arc(chkX, chkY - H * 0.015, W * 0.055, 0, Math.PI * 2);
    rctx.fill();

    // Warm translucent ear flush (ears sit at u ≈ 0.5 ± 0.25)
    const earX = cx + side * W * 0.252;
    const earGrad = ctx.createRadialGradient(earX, H * 0.52, 2, earX, H * 0.52, W * 0.048);
    earGrad.addColorStop(0, palette.blushHex);
    earGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = variant === 'zombie' ? 0.18 : 0.28;
    ctx.fillStyle = earGrad;
    ctx.beginPath();
    ctx.ellipse(earX, H * 0.52, W * 0.036, H * 0.058, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ear concha inner crease AO
    ctx.globalAlpha = 0.38;
    ctx.fillStyle = palette.shadowHex;
    ctx.beginPath();
    ctx.ellipse(earX - side * W * 0.005, H * 0.525, W * 0.014, H * 0.026, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle nose-tip capillary warmth
  const noseWarm = ctx.createRadialGradient(cx, noseTipY, 2, cx, noseTipY, W * 0.036);
  noseWarm.addColorStop(0, palette.blushHex);
  noseWarm.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = variant === 'zombie' ? 0.18 : 0.26;
  ctx.fillStyle = noseWarm;
  ctx.beginPath();
  ctx.arc(cx, noseTipY, W * 0.036, 0, Math.PI * 2);
  ctx.fill();

  // Cooler olive/slate jaw & beard-shadow zone + higher roughness (~0.72, rgb 188) on jaw & neck
  const jawCoolGrad = ctx.createRadialGradient(cx, H * 0.72, W * 0.03, cx, H * 0.72, W * 0.16);
  jawCoolGrad.addColorStop(0, palette.jawCoolHex);
  jawCoolGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = variant === 'male' ? 0.18 + palette.stubbleAlpha * 0.45 : variant === 'zombie' ? 0.32 : 0.08;
  ctx.fillStyle = jawCoolGrad;
  ctx.fillRect(cx - W * 0.20, H * 0.58, W * 0.40, H * 0.28);

  // Higher matte roughness along lower jaw & neck (0.72–0.75)
  rctx.fillStyle = variant === 'zombie' ? 'rgb(228,228,228)' : 'rgb(190,190,190)';
  rctx.fillRect(0, H * 0.70, W, H * 0.30);

  // Orbital depth AO, crease fold & dark lash line / inner-outer canthus shading
  for (const side of [-1, 1]) {
    const ex = cx + side * eyeOffsetX;
    const orbGrad = ctx.createRadialGradient(ex, eyeY, 2, ex, eyeY, W * 0.050);
    orbGrad.addColorStop(0, variant === 'zombie' ? '#191517' : palette.shadowHex);
    orbGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = variant === 'zombie' ? 0.88 : 0.58;
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, W * 0.050, H * 0.033, 0, 0, Math.PI * 2);
    ctx.fill();

    // Inner & outer eye corner crevice AO
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#241714';
    ctx.beginPath();
    ctx.arc(ex - side * W * 0.024, eyeY + H * 0.002, W * 0.007, 0, Math.PI * 2);
    ctx.arc(ex + side * W * 0.025, eyeY + H * 0.001, W * 0.006, 0, Math.PI * 2);
    ctx.fill();

    // Upper eyelid crease & lash line darkening
    ctx.globalAlpha = variant === 'zombie' ? 0.76 : 0.54;
    ctx.strokeStyle = '#18110f';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(ex - W * 0.026, eyeY - H * 0.005);
    ctx.quadraticCurveTo(ex, eyeY - H * 0.015, ex + W * 0.026, eyeY - H * 0.004);
    ctx.stroke();

    // Subtle soft under-brow skin shadow (actual brow hairs are rendered as 3D strips!)
    ctx.globalAlpha = 0.24;
    ctx.strokeStyle = palette.shadowHex;
    ctx.lineWidth = variant === 'female' ? 3.5 : 5.0;
    ctx.beginPath();
    ctx.moveTo(ex - side * W * 0.030, browY + H * 0.005);
    ctx.quadraticCurveTo(ex, browY - H * 0.006, ex + side * W * 0.034, browY + H * 0.004);
    ctx.stroke();
  }

  // Deep crevice AO inside nostrils, alar crease & philtrum shadow
  ctx.globalAlpha = 0.68;
  ctx.fillStyle = '#231512';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * W * 0.015, noseTipY + H * 0.011, W * 0.010, H * 0.0065, side * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.26;
  ctx.fillStyle = palette.shadowHex;
  ctx.beginPath();
  ctx.ellipse(cx, mouthY - H * 0.035, W * 0.009, H * 0.016, 0, 0, Math.PI * 2);
  ctx.fill();

  // Two-part sculpted upper & lower lips + dark oral fissure AO + labiomental shadow
  ctx.globalAlpha = variant === 'zombie' ? 0.80 : 0.74;
  ctx.fillStyle = palette.lipHex;
  ctx.beginPath();
  ctx.ellipse(cx, mouthY - H * 0.007, W * 0.035, H * 0.0085, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, mouthY + H * 0.008, W * 0.031, H * 0.0095, 0, 0, Math.PI * 2);
  ctx.fill();

  // Lip glossiness slightly lower roughness (~0.46)
  rctx.fillStyle = 'rgba(122,122,122,0.8)';
  rctx.beginPath();
  rctx.ellipse(cx, mouthY + H * 0.002, W * 0.034, H * 0.014, 0, 0, Math.PI * 2);
  rctx.fill();

  // Dark lip commissure seam & corner AO
  ctx.globalAlpha = 0.90;
  ctx.strokeStyle = variant === 'zombie' ? '#240b0b' : '#3d1d1a';
  ctx.lineWidth = 2.1;
  ctx.beginPath();
  ctx.moveTo(cx - W * 0.035, mouthY);
  ctx.quadraticCurveTo(cx, mouthY + H * 0.002, cx + W * 0.035, mouthY);
  ctx.stroke();

  // Subtle shadow directly under lower lip (labiomental fold)
  ctx.globalAlpha = 0.30;
  ctx.fillStyle = palette.shadowHex;
  ctx.beginPath();
  ctx.ellipse(cx, mouthY + H * 0.028, W * 0.024, H * 0.007, 0, 0, Math.PI * 2);
  ctx.fill();

  // Subtle follicle root shading tucked underneath the 3D offset hair cap (prevents bright skin gap at hairline,
  // WITHOUT painting an opaque brown mannequin helmet onto the scalp!)
  if (variant !== 'zombie') {
    const scalpShadow = ctx.createLinearGradient(0, 0, 0, H * 0.34);
    scalpShadow.addColorStop(0, palette.hairHex);
    scalpShadow.addColorStop(0.72, palette.shadowHex);
    scalpShadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = scalpShadow;
    ctx.fillRect(0, 0, W, H * 0.33);
  }

  // Male beard stubble grain (tailored per male preset) or Zombie necrotic veins/blood
  const rand = seededRand(
    variant === 'zombie' ? 991 : 401 + resolvedPreset.charCodeAt(resolvedPreset.length - 1) * 53,
  );
  if (variant === 'male' && palette.stubbleAlpha > 0) {
    const dotCount = Math.round(650 + palette.stubbleAlpha * 3800);
    ctx.globalAlpha = palette.stubbleAlpha * 1.1;
    ctx.fillStyle = palette.hairHex;
    for (let s = 0; s < dotCount; s++) {
      const sx = cx + (rand() - 0.5) * W * 0.25;
      const sy = mouthY - H * 0.024 + rand() * H * 0.145;
      const distMouth = Math.hypot((sx - cx) / 1.15, sy - mouthY);
      if (distMouth < W * 0.034) continue;
      ctx.fillRect(sx, sy, 1.35, 1.35);
    }
  } else if (variant === 'zombie') {
    // Coagulated mouth blood + necrotic bruises + dark subdermal veins (looks great on bald skulls too!)
    ctx.globalAlpha = 0.68;
    ctx.fillStyle = '#470d0e';
    ctx.beginPath();
    ctx.ellipse(cx + W * 0.005, mouthY + H * 0.024, W * 0.036, H * 0.028, 0.12, 0, Math.PI * 2);
    ctx.fill();

    // Mottled necrotic scalp lesions for bald & tattered zombies
    for (let b = 0; b < 45; b++) {
      ctx.fillStyle = b % 3 === 0 ? '#3a2d33' : '#586250';
      ctx.globalAlpha = 0.14 + rand() * 0.18;
      ctx.beginPath();
      ctx.arc(rand() * W, rand() * H * 0.52, 6 + rand() * 20, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = '#2d2228';
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.46;
    for (let v = 0; v < 36; v++) {
      let vx = rand() * W;
      let vy = H * 0.12 + rand() * H * 0.60;
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      for (let seg = 0; seg < 4; seg++) {
        vx += (rand() - 0.5) * 18;
        vy += (rand() - 0.35) * 14;
        ctx.lineTo(vx, vy);
      }
      ctx.stroke();
    }
  }

  // Subtle organic dermal micro-variation noise
  ctx.globalAlpha = 0.085;
  for (let pIdx = 0; pIdx < 1600; pIdx++) {
    ctx.fillStyle = pIdx % 2 === 0 ? palette.shadowHex : palette.highlightHex;
    ctx.fillRect(rand() * W, rand() * H, 1.4, 1.4);
  }
  ctx.globalAlpha = 1;

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, Math.max(1, anisotropy));
  map.needsUpdate = true;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.anisotropy = Math.min(8, Math.max(1, anisotropy));
  roughnessMap.needsUpdate = true;

  const set: SkinTextureSet = { map, roughnessMap };
  skinTextureCache.set(bucket, set);
  return set;
}

/**
 * Generates and caches high-detail eyeball sclera + recessed iris bowl + dark limbal ring
 * + subtle upper-eyelid shadow band across the top 15% of the sclera/cornea.
 */
export function getSharedEyeballTexture(
  variant: AnatomicalHeadVariant,
  toneSeed: number,
  facePreset?: FacePresetId,
): THREE.CanvasTexture {
  const resolvedPreset =
    variant === 'zombie'
      ? DEFAULT_FACE_PRESET_ID
      : facePreset
        ? normalizeFacePresetId(facePreset)
        : pickFacePresetFromSeed(toneSeed);
  const palette = getSkinTonePalette(toneSeed, variant, resolvedPreset);
  const key = variant === 'zombie' ? 'zombie_v2' : `${variant}_${resolvedPreset}_eye_v2`;
  const cached = scleraTextureCache.get(key);
  if (cached) return cached;

  const W = 256;
  const H = 256;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d')!;

  // Sclera base with subtle periphery radial darkening
  ctx.fillStyle = variant === 'zombie' ? '#b0a79b' : '#ebe4dd';
  ctx.fillRect(0, 0, W, H);

  const cx = W * 0.5;
  const cy = H * 0.5;

  const scleraVig = ctx.createRadialGradient(cx, cy, W * 0.14, cx, cy, W * 0.45);
  scleraVig.addColorStop(0, 'rgba(0,0,0,0)');
  scleraVig.addColorStop(1, variant === 'zombie' ? 'rgba(65,42,40,0.42)' : 'rgba(162,126,118,0.28)');
  ctx.fillStyle = scleraVig;
  ctx.fillRect(0, 0, W, H);

  // Fine sclera capillaries
  const rand = seededRand(variant === 'zombie' ? 777 : 213);
  ctx.strokeStyle = variant === 'zombie' ? '#7a2522' : '#c97874';
  ctx.globalAlpha = variant === 'zombie' ? 0.65 : 0.24;
  ctx.lineWidth = variant === 'zombie' ? 1.5 : 0.85;
  const veinCount = variant === 'zombie' ? 28 : 12;
  for (let i = 0; i < veinCount; i++) {
    const ang = rand() * Math.PI * 2;
    const r0 = W * 0.15;
    const r1 = W * (0.28 + rand() * 0.14);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.quadraticCurveTo(
      cx + Math.cos(ang + 0.15) * (r0 + r1) * 0.5,
      cy + Math.sin(ang + 0.15) * (r0 + r1) * 0.5,
      cx + Math.cos(ang) * r1,
      cy + Math.sin(ang) * r1,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Recessed iris bowl + crisp dark limbal ring
  const irisR = W * 0.116;
  // Dark limbal outer ring
  ctx.fillStyle = palette.irisRimHex;
  ctx.beginPath();
  ctx.arc(cx, cy, irisR * 1.04, 0, Math.PI * 2);
  ctx.fill();

  // Inner iris bowl gradient (darker upper edge for recessed depth under cornea)
  const irisGrad = ctx.createRadialGradient(
    cx,
    cy + irisR * 0.12,
    irisR * 0.18,
    cx,
    cy,
    irisR * 0.96,
  );
  irisGrad.addColorStop(0, palette.irisHex);
  irisGrad.addColorStop(0.68, palette.irisHex);
  irisGrad.addColorStop(0.92, palette.irisRimHex);
  irisGrad.addColorStop(1, '#0e0c0b');
  ctx.fillStyle = irisGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, irisR * 0.96, 0, Math.PI * 2);
  ctx.fill();

  // Radial iris fibers & collarette
  ctx.strokeStyle = variant === 'zombie' ? '#aeb8ad' : palette.irisRimHex;
  ctx.globalAlpha = 0.30;
  ctx.lineWidth = 1.0;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * irisR * 0.36, cy + Math.sin(a) * irisR * 0.36);
    ctx.lineTo(cx + Math.cos(a) * irisR * 0.90, cy + Math.sin(a) * irisR * 0.90);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Deep black pupil + subtle cataract haze on zombie
  const pupilR = variant === 'zombie' ? irisR * 0.42 : irisR * 0.35;
  ctx.fillStyle = variant === 'zombie' ? '#2c312e' : '#050608';
  ctx.beginPath();
  ctx.arc(cx, cy, pupilR, 0, Math.PI * 2);
  ctx.fill();

  if (variant === 'zombie') {
    const catGrad = ctx.createRadialGradient(cx, cy, 1, cx, cy, irisR * 0.85);
    catGrad.addColorStop(0, 'rgba(205, 212, 200, 0.42)');
    catGrad.addColorStop(1, 'rgba(205, 212, 200, 0)');
    ctx.fillStyle = catGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, irisR, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Crisp wet catchlight reflection on iris
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    ctx.beginPath();
    ctx.arc(cx - irisR * 0.28, cy - irisR * 0.28, irisR * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle upper-eyelid cast shadow band across the top ~15% of the visible eyeball
  const lidBandTop = cy - H * 0.24;
  const lidBandBot = cy - H * 0.045;
  const lidShadow = ctx.createLinearGradient(0, lidBandTop, 0, lidBandBot);
  lidShadow.addColorStop(0, 'rgba(18, 13, 12, 0.56)');
  lidShadow.addColorStop(0.55, 'rgba(24, 18, 16, 0.32)');
  lidShadow.addColorStop(1, 'rgba(24, 18, 16, 0.0)');
  ctx.fillStyle = lidShadow;
  ctx.fillRect(0, lidBandTop, W, lidBandBot - lidBandTop);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  scleraTextureCache.set(key, tex);
  return tex;
}

// ============================================================================
// SHARED ANATOMICAL HEAD ASSEMBLY + HAIR CAP + 3D BROWS + FACE GEAR + EYEWEAR
// ============================================================================

let sharedEyeballGeo: THREE.BufferGeometry | null = null;
function getSharedEyeballGeo(): THREE.BufferGeometry {
  if (!sharedEyeballGeo) {
    sharedEyeballGeo = new THREE.SphereGeometry(0.0118, 20, 16, Math.PI * 0.5, Math.PI * 2);
  }
  return sharedEyeballGeo;
}

let sharedFemaleBunGeo: THREE.BufferGeometry | null = null;
function getSharedFemaleBunGeo(): THREE.BufferGeometry {
  if (!sharedFemaleBunGeo) {
    sharedFemaleBunGeo = new THREE.SphereGeometry(0.036, 14, 12);
  }
  return sharedFemaleBunGeo;
}

export interface BuiltAnatomicalHeadAssembly {
  readonly root: THREE.Group;
  readonly headMesh: THREE.Mesh;
  readonly hairCapMesh: THREE.Mesh;
  readonly browMesh: THREE.Mesh;
  readonly femaleBunMesh: THREE.Mesh | null;
  readonly zombieHairStyle: ZombieHairStyle | null;
  readonly eyeL: THREE.Group;
  readonly eyeR: THREE.Group;
  readonly eyeBallL: THREE.Mesh;
  readonly eyeBallR: THREE.Mesh;
  readonly oralCavityMesh: THREE.Mesh;
  readonly upperTeethMesh: THREE.Mesh;
  readonly lowerTeethMesh: THREE.Mesh;
  readonly morphTargetInfluences: number[];
  readonly allMeshes: THREE.Mesh[];
  readonly faceGearGroups: {
    readonly neckGaiter: THREE.Group;
    readonly balaclava: THREE.Group;
  };
  readonly eyewearGroups: {
    readonly clearGlasses: THREE.Group;
    readonly tintedVisor: THREE.Group;
  };
  readonly disposables: Array<{ dispose: () => void }>;
  getFacePreset: () => FacePresetId;
  applyFacePreset: (facePreset: FacePresetId) => void;
  applyFaceGear: (faceGear: FaceGearId) => void;
  applyEyewear: (eyewear: EyewearId) => void;
  applyHeadgearClearance: (helmetType: HelmetTypeId, faceGear?: FaceGearId) => void;
}

export interface BuildHeadAssemblyParams {
  variant: AnatomicalHeadVariant;
  toneSeed: number;
  facePreset?: FacePresetId;
  zombieHairStyle?: ZombieHairStyle;
  anisotropy?: number;
  hoodMaterial: THREE.Material;
  frameMaterial: THREE.Material;
  jawParentForLowerTeeth?: THREE.Object3D;
  /** Optional custom local pivot position for lower teeth if parented directly to jawPivot */
  lowerTeethInJawOffset?: readonly [number, number, number];
  /** Whether faceGear & eyewear sub-meshes should also be generated (human operators) */
  includeGearAndEyewear?: boolean;
}

export function buildAnatomicalHeadAssembly(
  params: BuildHeadAssemblyParams,
): BuiltAnatomicalHeadAssembly {
  const {
    variant,
    toneSeed,
    anisotropy = 4,
    hoodMaterial,
    frameMaterial,
    jawParentForLowerTeeth,
    lowerTeethInJawOffset,
    includeGearAndEyewear = true,
  } = params;

  let activeFacePreset: FacePresetId =
    variant === 'zombie'
      ? DEFAULT_FACE_PRESET_ID
      : params.facePreset
        ? normalizeFacePresetId(params.facePreset)
        : pickFacePresetFromSeed(toneSeed);

  const zombieHairStyle: ZombieHairStyle | null =
    variant === 'zombie'
      ? (params.zombieHairStyle ?? resolveZombieHairStyleFromSeed(toneSeed))
      : null;

  let activeHelmetType: HelmetTypeId = 'none';
  let activeFaceGear: FaceGearId = 'neck_gaiter';

  const disposables: Array<{ dispose: () => void }> = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposables.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposables.push(m);
    return m;
  };

  const root = new THREE.Group();
  root.name = 'anatomical_head_root';

  let profile = getHeadAnatomyProfile(variant, activeFacePreset);

  // 1. Cube-Sphere Anatomical Head Mesh with Zoned Roughness & Global Micro-Pore Normal Map
  const skinTex = getSharedSkinTextures(variant, toneSeed, anisotropy, activeFacePreset);
  const poreNormalMap = getSharedSkinPoreNormalTexture();
  const skinMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: skinTex.map,
      roughnessMap: skinTex.roughnessMap,
      normalMap: poreNormalMap,
      normalScale: new THREE.Vector2(0.15, 0.15),
      roughness: 1.0, // Driven 1:1 by zoned roughnessMap (0.38..0.45 T-zone, 0.65..0.75 jaw/neck)
      metalness: 0.02,
    }),
  );

  const headGeo = getSharedAnatomicalHeadGeometry(variant, activeFacePreset);
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.name = 'anatomical_head_mesh';
  headMesh.renderOrder = 0;
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  headMesh.updateMorphTargets();
  if (!headMesh.morphTargetInfluences || headMesh.morphTargetInfluences.length !== FACIAL_MORPH_COUNT) {
    headMesh.morphTargetInfluences = new Array<number>(FACIAL_MORPH_COUNT).fill(0);
  }
  const sharedInfluences = headMesh.morphTargetInfluences;
  root.add(headMesh);

  // 2. Separate Offset Procedural Hair Cap Shell (+1.5mm..4.5mm normal offset, matte 0.90 roughness)
  const hairTex = getSharedHairTextures(
    profile.palette.hairHex,
    profile.palette.hairHighlightHex,
    anisotropy,
  );
  const hairMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: hairTex.map,
      normalMap: hairTex.normalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: variant === 'zombie' ? 0.94 : 0.90,
      metalness: 0.02,
    }),
  );

  const initialHairGeo = getSharedHairCapGeometry(
    variant,
    activeFacePreset,
    zombieHairStyle ?? 'tattered',
  );
  const hairCapMesh = new THREE.Mesh(
    initialHairGeo ?? trackGeo(new THREE.BufferGeometry()),
    hairMat,
  );
  hairCapMesh.name = 'anatomical_hair_cap';
  hairCapMesh.visible = initialHairGeo !== null;
  hairCapMesh.castShadow = true;
  hairCapMesh.receiveShadow = true;
  root.add(hairCapMesh);

  // Female tactical low bun matched to the hair cap material
  let femaleBunMesh: THREE.Mesh | null = null;
  if (variant === 'female') {
    femaleBunMesh = new THREE.Mesh(getSharedFemaleBunGeo(), hairMat);
    femaleBunMesh.name = 'anatomical_female_hair_bun';
    const bs = profile.femaleBunScale;
    femaleBunMesh.scale.set(0.92 * bs, 0.84 * bs, 1.12 * bs);
    femaleBunMesh.position.set(0, 0.068, 0.110);
    femaleBunMesh.castShadow = true;
    femaleBunMesh.receiveShadow = true;
    root.add(femaleBunMesh);
  }

  // 3. Thin Raised 3D Brow Ridge Strips (deform automatically via shared morphTargetInfluences!)
  const browMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(profile.palette.browHex),
      normalMap: hairTex.normalMap,
      normalScale: new THREE.Vector2(0.32, 0.32),
      roughness: 0.92,
      metalness: 0.01,
    }),
  );
  const browGeo = getSharedBrowStripsGeometry(variant, activeFacePreset);
  const browMesh = new THREE.Mesh(browGeo, browMat);
  browMesh.name = 'anatomical_brow_strips';
  browMesh.updateMorphTargets();
  browMesh.morphTargetInfluences = sharedInfluences;
  browMesh.castShadow = false;
  browMesh.receiveShadow = true;
  root.add(browMesh);

  // 4. Oral interior & teeth
  const oralMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: variant === 'zombie' ? 0x280d0e : 0x2b1516,
      roughness: 0.9,
      metalness: 0.0,
    }),
  );
  const teethMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: variant === 'zombie' ? 0xa39577 : 0xddd6c8,
      roughness: variant === 'zombie' ? 0.56 : 0.34,
      metalness: 0.02,
    }),
  );

  const oralCavityMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.042, 0.022, 0.028)), oralMat);
  oralCavityMesh.position.set(0, 0.053, -0.066);
  oralCavityMesh.renderOrder = 0;

  const upperTeethMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.017, 0.017, 0.006, 10, 1, false, Math.PI * 0.62, Math.PI * 0.76)),
    teethMat,
  );
  upperTeethMesh.position.set(0, 0.0565, -0.067);
  upperTeethMesh.renderOrder = 0;

  const lowerTeethMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 0.0055, 10, 1, false, Math.PI * 0.62, Math.PI * 0.76)),
    teethMat,
  );
  lowerTeethMesh.renderOrder = 0;
  if (jawParentForLowerTeeth) {
    const off = lowerTeethInJawOffset ?? [0, -0.016, -0.047];
    lowerTeethMesh.position.set(off[0], off[1], off[2]);
    jawParentForLowerTeeth.add(lowerTeethMesh);
  } else {
    lowerTeethMesh.position.set(0, 0.049, -0.066);
    root.add(lowerTeethMesh);
  }
  root.add(oralCavityMesh, upperTeethMesh);

  // 5. Recessed Independent Eyeballs with Wet Clearcoat Cornea Shader
  const eyeTex = getSharedEyeballTexture(variant, toneSeed, activeFacePreset);
  const eyeMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      map: eyeTex,
      roughness: variant === 'zombie' ? 0.28 : 0.05,
      metalness: 0.0,
      clearcoat: variant === 'zombie' ? 0.45 : 1.0,
      clearcoatRoughness: variant === 'zombie' ? 0.22 : 0.04,
      reflectivity: 0.95,
    }),
  );

  const eyeL = new THREE.Group();
  eyeL.name = 'eye_l';
  eyeL.position.set(-profile.eyeSpacingX, profile.eyeCenterY, profile.eyeCenterZ);

  const eyeR = new THREE.Group();
  eyeR.name = 'eye_r';
  eyeR.position.set(profile.eyeSpacingX, profile.eyeCenterY, profile.eyeCenterZ);

  const eyeGeo = getSharedEyeballGeo();
  const eyeBallL = new THREE.Mesh(eyeGeo, eyeMat);
  eyeBallL.name = 'eyeball_l';
  eyeBallL.renderOrder = 1;

  const eyeBallR = new THREE.Mesh(eyeGeo, eyeMat);
  eyeBallR.name = 'eyeball_r';
  eyeBallR.renderOrder = 1;

  eyeL.add(eyeBallL);
  eyeR.add(eyeBallR);
  root.add(eyeL, eyeR);

  const allMeshes: THREE.Mesh[] = [
    headMesh,
    hairCapMesh,
    browMesh,
    oralCavityMesh,
    upperTeethMesh,
    lowerTeethMesh,
    eyeBallL,
    eyeBallR,
  ];
  if (femaleBunMesh) {
    allMeshes.push(femaleBunMesh);
  }

  // Face Gear Groups (Neck Gaiter vs Full Balaclava) with >= 3.5mm radial clearance
  const neckGaiterGroup = new THREE.Group();
  neckGaiterGroup.name = 'face_gear_neck_gaiter';
  const balaclavaGroup = new THREE.Group();
  balaclavaGroup.name = 'face_gear_balaclava';

  // Eyewear Groups (Clear Glasses vs Tinted Visor) with >= 3.5mm brow/nose clearance
  const clearGlassesGroup = new THREE.Group();
  clearGlassesGroup.name = 'eyewear_clear_glasses';
  const tintedVisorGroup = new THREE.Group();
  tintedVisorGroup.name = 'eyewear_tinted_visor';

  if (includeGearAndEyewear) {
    const scaleX = variant === 'female' ? 0.94 : 1.0;

    // 1. Neck Gaiter (sits over lower neck + chin line with generous mandibular clearance)
    const gaiterLower = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.066 * scaleX, 0.069 * scaleX, 0.056, 16)),
      hoodMaterial,
    );
    gaiterLower.scale.set(1.02, 1.0, 1.08);
    gaiterLower.position.set(0, 0.008, -0.005);

    const gaiterChin = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.070 * scaleX, 0.066 * scaleX, 0.028, 16)),
      hoodMaterial,
    );
    gaiterChin.scale.set(1.04, 1.0, 1.15);
    gaiterChin.position.set(0, 0.036, -0.011);
    neckGaiterGroup.add(gaiterLower, gaiterChin);
    root.add(neckGaiterGroup);
    allMeshes.push(gaiterLower, gaiterChin);

    // 2. Full Balaclava (covers neck, jaw, cheeks, nose bridge & crown with sculpted eye aperture)
    const balaLowerMask = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.084 * scaleX, 0.072 * scaleX, 0.088, 18)),
      hoodMaterial,
    );
    balaLowerMask.scale.set(1.0, 1.0, 1.18);
    balaLowerMask.position.set(0, 0.044, -0.007);

    const balaNoseBridge = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.022, 0.024, 0.024)),
      hoodMaterial,
    );
    balaNoseBridge.position.set(0, 0.084, -0.095);
    balaNoseBridge.rotation.x = -0.18;

    const balaHoodCrown = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.092 * scaleX, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.56)),
      hoodMaterial,
    );
    balaHoodCrown.scale.set(0.94, 1.04, 1.16);
    balaHoodCrown.position.set(0, 0.118, 0.004);
    balaHoodCrown.rotation.x = -0.06;

    const balaRearNape = new THREE.Mesh(
      trackGeo(
        new THREE.CylinderGeometry(
          0.088 * scaleX,
          0.074 * scaleX,
          0.074,
          16,
          1,
          false,
          -Math.PI * 0.58,
          Math.PI * 1.16,
        ),
      ),
      hoodMaterial,
    );
    balaRearNape.position.set(0, 0.088, 0.014);

    balaclavaGroup.add(balaLowerMask, balaNoseBridge, balaHoodCrown, balaRearNape);
    root.add(balaclavaGroup);
    allMeshes.push(balaLowerMask, balaNoseBridge, balaHoodCrown, balaRearNape);

    // Helper: sculpted double-curved polycarbonate visor / eye-pro shield geometry
    const createCurvedVisorShieldGeo = (opts: {
      scaleX: number;
      rx: number;
      rz: number;
      zCenter: number;
      azSpan: number;
      yTop: number;
      yBotCheek: number;
      yBotNose: number;
      browForwardBow: number;
      cheekForwardBow: number;
      segU?: number;
      segV?: number;
    }): THREE.BufferGeometry => {
      const segU = opts.segU ?? 28;
      const segV = opts.segV ?? 12;
      const positions: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];

      for (let iv = 0; iv <= segV; iv++) {
        const vFrac = iv / segV;
        for (let iu = 0; iu <= segU; iu++) {
          const uFrac = iu / segU;
          const az = (uFrac - 0.5) * 2 * opts.azSpan;
          const absU = Math.abs(az) / opts.azSpan;

          const noseArch = Math.exp(-Math.pow(absU / 0.24, 2));
          const cornerSweep = Math.pow(absU, 2.2) * 0.008;
          const yBot = THREE.MathUtils.lerp(opts.yBotCheek, opts.yBotNose, noseArch) + cornerSweep;
          const yTopCurve = opts.yTop - Math.pow(absU, 2.1) * 0.006;
          const y = THREE.MathUtils.lerp(yBot, yTopCurve, vFrac);

          const domeProfile = Math.sin(vFrac * Math.PI);
          const tiltZ = THREE.MathUtils.lerp(opts.cheekForwardBow, opts.browForwardBow, vFrac);
          const radialBoost = domeProfile * 0.0045 + tiltZ;

          const x = Math.sin(az) * (opts.rx + radialBoost * 0.4) * opts.scaleX;
          const z = opts.zCenter - Math.cos(az) * (opts.rz + radialBoost);

          positions.push(x, y, z);
          uvs.push(uFrac, vFrac);
        }
      }

      for (let iv = 0; iv < segV; iv++) {
        for (let iu = 0; iu < segU; iu++) {
          const a = iv * (segU + 1) + iu;
          const b = a + 1;
          const c = a + (segU + 1);
          const d = c + 1;
          indices.push(a, b, d, a, d, c);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    };

    const createCurvedBrowRimGeo = (opts: {
      scaleX: number;
      rx: number;
      rz: number;
      zCenter: number;
      azSpan: number;
      yHeight: number;
      thickness: number;
      forwardTilt: number;
    }): THREE.TubeGeometry => {
      const pts: THREE.Vector3[] = [];
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const az = (t - 0.5) * 2 * opts.azSpan;
        const absU = Math.abs(az) / opts.azSpan;
        const x = Math.sin(az) * opts.rx * opts.scaleX;
        const y = opts.yHeight - Math.pow(absU, 2.1) * 0.006;
        const z = opts.zCenter - Math.cos(az) * (opts.rz + opts.forwardTilt);
        pts.push(new THREE.Vector3(x, y, z));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      return new THREE.TubeGeometry(curve, 24, opts.thickness, 8, false);
    };

    // 3. Clear Ballistic Glasses
    const clearLensMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xe2f1ff,
        roughness: 0.05,
        metalness: 0.04,
        clearcoat: 1.0,
        clearcoatRoughness: 0.03,
        reflectivity: 0.92,
        ior: 1.52,
        envMapIntensity: 1.5,
        transparent: true,
        opacity: 0.28,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );

    const clearBrowRim = new THREE.Mesh(
      trackGeo(
        createCurvedBrowRimGeo({
          scaleX,
          rx: 0.081,
          rz: 0.084,
          zCenter: -0.020,
          azSpan: 0.94,
          yHeight: 0.119,
          thickness: 0.0036,
          forwardTilt: 0.003,
        }),
      ),
      frameMaterial,
    );

    const clearLens = new THREE.Mesh(
      trackGeo(
        createCurvedVisorShieldGeo({
          scaleX,
          rx: 0.080,
          rz: 0.083,
          zCenter: -0.020,
          azSpan: 0.92,
          yTop: 0.118,
          yBotCheek: 0.091,
          yBotNose: 0.099,
          browForwardBow: 0.003,
          cheekForwardBow: 0.0,
        }),
      ),
      clearLensMat,
    );
    clearLens.renderOrder = 6;

    const nosePad = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.011, 0.011, 0.009)),
      frameMaterial,
    );
    nosePad.position.set(0, 0.098, -0.100);

    for (const side of [-1, 1]) {
      const templeArm = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.0045, 0.0055, 0.088)),
        frameMaterial,
      );
      templeArm.position.set(side * 0.069 * scaleX, 0.113, -0.032);
      templeArm.rotation.y = -side * 0.06;
      clearGlassesGroup.add(templeArm);
      allMeshes.push(templeArm);
    }

    clearGlassesGroup.add(clearBrowRim, clearLens, nosePad);
    root.add(clearGlassesGroup);
    allMeshes.push(clearBrowRim, clearLens, nosePad);

    // 4. Tinted Ballistic Visor
    const tintedVisorMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x0e1722,
        roughness: 0.06,
        metalness: 0.18,
        clearcoat: 1.0,
        clearcoatRoughness: 0.04,
        reflectivity: 0.96,
        ior: 1.54,
        envMapIntensity: 1.85,
        transparent: true,
        opacity: 0.72,
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );

    const visorGasketMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x15181d,
        roughness: 0.82,
        metalness: 0.08,
      }),
    );

    const visorHardwareMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x262c35,
        roughness: 0.34,
        metalness: 0.78,
      }),
    );

    const visorBrowSeal = new THREE.Mesh(
      trackGeo(
        createCurvedBrowRimGeo({
          scaleX,
          rx: 0.089,
          rz: 0.092,
          zCenter: -0.018,
          azSpan: 1.08,
          yHeight: 0.132,
          thickness: 0.0052,
          forwardTilt: 0.005,
        }),
      ),
      visorGasketMat,
    );

    const lowerRimPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 18; i++) {
      const uFrac = i / 18;
      const az = (uFrac - 0.5) * 2 * 1.05;
      const absU = Math.abs(az) / 1.05;
      const noseArch = Math.exp(-Math.pow(absU / 0.24, 2));
      const cornerSweep = Math.pow(absU, 2.2) * 0.008;
      const y = THREE.MathUtils.lerp(0.080, 0.092, noseArch) + cornerSweep;
      const x = Math.sin(az) * 0.088 * scaleX;
      const z = -0.018 - Math.cos(az) * 0.091;
      lowerRimPts.push(new THREE.Vector3(x, y, z));
    }
    const visorLowerTrim = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(lowerRimPts), 24, 0.0024, 6, false)),
      visorGasketMat,
    );

    const visorShield = new THREE.Mesh(
      trackGeo(
        createCurvedVisorShieldGeo({
          scaleX,
          rx: 0.088,
          rz: 0.091,
          zCenter: -0.018,
          azSpan: 1.05,
          yTop: 0.132,
          yBotCheek: 0.080,
          yBotNose: 0.092,
          browForwardBow: 0.005,
          cheekForwardBow: 0.0,
        }),
      ),
      tintedVisorMat,
    );
    visorShield.renderOrder = 6;

    for (const side of [-1, 1]) {
      const hingeDisc = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.009, 14)),
        visorHardwareMat,
      );
      hingeDisc.rotation.z = Math.PI * 0.5;
      hingeDisc.position.set(side * 0.080 * scaleX, 0.114, -0.044);

      const hingeBolt = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.0045, 0.0045, 0.011, 6)),
        frameMaterial,
      );
      hingeBolt.rotation.z = Math.PI * 0.5;
      hingeBolt.position.set(side * 0.081 * scaleX, 0.114, -0.044);

      const railBracket = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.008, 0.015, 0.052)),
        visorHardwareMat,
      );
      railBracket.position.set(side * 0.080 * scaleX, 0.116, -0.020);
      railBracket.rotation.y = -side * 0.08;

      tintedVisorGroup.add(hingeDisc, hingeBolt, railBracket);
      allMeshes.push(hingeDisc, hingeBolt, railBracket);
    }

    tintedVisorGroup.add(visorBrowSeal, visorLowerTrim, visorShield);
    root.add(tintedVisorGroup);
    allMeshes.push(visorBrowSeal, visorLowerTrim, visorShield);
  }

  for (const m of allMeshes) {
    if (m !== browMesh) {
      m.castShadow = true;
    }
    m.receiveShadow = true;
  }

  const syncHairVisibilityAndClearance = () => {
    const hasHairGeo =
      variant === 'zombie' ? zombieHairStyle !== 'bald' : true;
    const blockedByBalaclava = includeGearAndEyewear && activeFaceGear === 'balaclava';
    hairCapMesh.visible = hasHairGeo && !blockedByBalaclava;

    if (hairCapMesh.visible) {
      if (activeHelmetType === 'mich' || activeHelmetType === 'mil_tec') {
        // Compress hair cap crown gently inside helmet padding so zero strands poke through shell
        hairCapMesh.scale.set(0.986, 0.968, 0.984);
        hairCapMesh.position.set(0, 0.003, 0);
      } else {
        hairCapMesh.scale.set(1, 1, 1);
        hairCapMesh.position.set(0, 0, 0);
      }
    }

    if (femaleBunMesh) {
      femaleBunMesh.visible = !blockedByBalaclava;
    }
  };

  const applyFaceGear = (faceGear: FaceGearId) => {
    activeFaceGear = faceGear;
    neckGaiterGroup.visible = includeGearAndEyewear && faceGear === 'neck_gaiter';
    balaclavaGroup.visible = includeGearAndEyewear && faceGear === 'balaclava';
    syncHairVisibilityAndClearance();
  };

  const applyEyewear = (eyewear: EyewearId) => {
    clearGlassesGroup.visible = includeGearAndEyewear && eyewear === 'clear_glasses';
    tintedVisorGroup.visible = includeGearAndEyewear && eyewear === 'tinted_visor';
  };

  const applyHeadgearClearance = (helmetType: HelmetTypeId, faceGear?: FaceGearId) => {
    activeHelmetType = helmetType;
    if (faceGear !== undefined) {
      activeFaceGear = faceGear;
      neckGaiterGroup.visible = includeGearAndEyewear && faceGear === 'neck_gaiter';
      balaclavaGroup.visible = includeGearAndEyewear && faceGear === 'balaclava';
    }
    syncHairVisibilityAndClearance();
  };

  const applyFacePreset = (nextPreset: FacePresetId) => {
    if (variant === 'zombie') return;
    const normalized = normalizeFacePresetId(nextPreset);
    if (normalized === activeFacePreset) return;
    activeFacePreset = normalized;
    profile = getHeadAnatomyProfile(variant, activeFacePreset);

    // Hot-swap cached cube-sphere geometry, hair cap, 3D brows & textures cleanly
    const nextHeadGeo = getSharedAnatomicalHeadGeometry(variant, activeFacePreset);
    headMesh.geometry = nextHeadGeo;
    headMesh.updateMorphTargets();
    // Preserve exact shared morphTargetInfluences array reference so FacialExpressionController stays wired!
    headMesh.morphTargetInfluences = sharedInfluences;

    const nextHairGeo = getSharedHairCapGeometry(variant, activeFacePreset);
    if (nextHairGeo) {
      hairCapMesh.geometry = nextHairGeo;
    }

    const nextBrowGeo = getSharedBrowStripsGeometry(variant, activeFacePreset);
    browMesh.geometry = nextBrowGeo;
    browMesh.updateMorphTargets();
    browMesh.morphTargetInfluences = sharedInfluences;

    const nextSkinTex = getSharedSkinTextures(variant, toneSeed, anisotropy, activeFacePreset);
    skinMat.map = nextSkinTex.map;
    skinMat.roughnessMap = nextSkinTex.roughnessMap;
    skinMat.needsUpdate = true;

    const nextHairTex = getSharedHairTextures(
      profile.palette.hairHex,
      profile.palette.hairHighlightHex,
      anisotropy,
    );
    hairMat.map = nextHairTex.map;
    hairMat.normalMap = nextHairTex.normalMap;
    hairMat.needsUpdate = true;

    browMat.color.set(profile.palette.browHex);
    browMat.normalMap = nextHairTex.normalMap;
    browMat.needsUpdate = true;

    const nextEyeTex = getSharedEyeballTexture(variant, toneSeed, activeFacePreset);
    eyeMat.map = nextEyeTex;
    eyeMat.needsUpdate = true;

    eyeL.position.set(-profile.eyeSpacingX, profile.eyeCenterY, profile.eyeCenterZ);
    eyeR.position.set(profile.eyeSpacingX, profile.eyeCenterY, profile.eyeCenterZ);

    if (femaleBunMesh) {
      const bs = profile.femaleBunScale;
      femaleBunMesh.scale.set(0.92 * bs, 0.84 * bs, 1.12 * bs);
    }

    syncHairVisibilityAndClearance();
  };

  applyFaceGear('neck_gaiter');
  applyEyewear('none');

  return {
    root,
    headMesh,
    hairCapMesh,
    browMesh,
    femaleBunMesh,
    zombieHairStyle,
    eyeL,
    eyeR,
    eyeBallL,
    eyeBallR,
    oralCavityMesh,
    upperTeethMesh,
    lowerTeethMesh,
    morphTargetInfluences: sharedInfluences,
    allMeshes,
    faceGearGroups: {
      neckGaiter: neckGaiterGroup,
      balaclava: balaclavaGroup,
    },
    eyewearGroups: {
      clearGlasses: clearGlassesGroup,
      tintedVisor: tintedVisorGroup,
    },
    disposables,
    getFacePreset: () => activeFacePreset,
    applyFacePreset,
    applyFaceGear,
    applyEyewear,
    applyHeadgearClearance,
  };
}

import * as THREE from 'three';
import { EyewearId, FaceGearId } from '../operator/OperatorTypes';

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

export interface SkinTonePalette {
  readonly baseHex: string;
  readonly shadowHex: string;
  readonly highlightHex: string;
  readonly lipHex: string;
  readonly blushHex: string;
  readonly browHex: string;
  readonly stubbleAlpha: number;
  readonly irisHex: string;
  readonly irisRimHex: string;
  readonly wristHex: number;
}

export const HUMAN_SKIN_PALETTES: readonly SkinTonePalette[] = [
  {
    baseHex: '#c6987e',
    shadowHex: '#936852',
    highlightHex: '#dab097',
    lipHex: '#9a5f58',
    blushHex: '#b47463',
    browHex: '#2f241d',
    stubbleAlpha: 0.14,
    irisHex: '#4f6d82',
    irisRimHex: '#1f2e3a',
    wristHex: 0xb68a71,
  },
  {
    baseHex: '#b58468',
    shadowHex: '#845942',
    highlightHex: '#ca9a7e',
    lipHex: '#8d564e',
    blushHex: '#a36756',
    browHex: '#251b16',
    stubbleAlpha: 0.16,
    irisHex: '#5c4632',
    irisRimHex: '#241a11',
    wristHex: 0xa3755b,
  },
  {
    baseHex: '#9c6e52',
    shadowHex: '#6c4732',
    highlightHex: '#b08264',
    lipHex: '#784840',
    blushHex: '#8b5848',
    browHex: '#1c1512',
    stubbleAlpha: 0.15,
    irisHex: '#483828',
    irisRimHex: '#1c140d',
    wristHex: 0x8b6047,
  },
  {
    baseHex: '#7d553e',
    shadowHex: '#523424',
    highlightHex: '#92674d',
    lipHex: '#633c36',
    blushHex: '#6e4537',
    browHex: '#16110f',
    stubbleAlpha: 0.12,
    irisHex: '#36271d',
    irisRimHex: '#150e09',
    wristHex: 0x6f4b36,
  },
  {
    baseHex: '#cfa68a',
    shadowHex: '#9b7359',
    highlightHex: '#e0bba0',
    lipHex: '#a26a62',
    blushHex: '#bc816e',
    browHex: '#3f3126',
    stubbleAlpha: 0.10,
    irisHex: '#5d7356',
    irisRimHex: '#232e20',
    wristHex: 0xbd947a,
  },
] as const;

export function getSkinTonePalette(seed: number, variant: AnatomicalHeadVariant): SkinTonePalette {
  if (variant === 'zombie') {
    return {
      baseHex: '#76806c',
      shadowHex: '#3c4036',
      highlightHex: '#8e9682',
      lipHex: '#4b2a29',
      blushHex: '#584440',
      browHex: '#272922',
      stubbleAlpha: 0.18,
      irisHex: '#889488',
      irisRimHex: '#3a2a28',
      wristHex: 0x6d7764,
    };
  }
  const idx = Math.abs(Math.floor(seed)) % HUMAN_SKIN_PALETTES.length;
  return HUMAN_SKIN_PALETTES[idx];
}

// ============================================================================
// CACHED PROCEDURAL ANATOMICAL HEAD BUFFERGEOMETRY + 15 MORPH TARGETS
// ============================================================================

const sharedHeadGeoCache = new Map<AnatomicalHeadVariant, THREE.BufferGeometry>();

function gaussian(d: number, sigma: number): number {
  const t = d / sigma;
  return Math.exp(-0.5 * t * t);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Builds and caches a sculpted anatomical human/zombie head BufferGeometry
 * facing local -Z (origin at base of head/upper neck y=0, crown ~y=0.206m,
 * eye centers at x = ±0.0315m, y = 0.104m, z = -0.075m) with 15 facial
 * morph targets baked directly into `morphAttributes.position`.
 *
 * Uses SphereGeometry rotated via phiStart = PI*0.5 so the UV seam (u=0/1)
 * is tucked cleanly at the rear of the skull (+Z) and u=0.5 sits dead-center
 * along the front facial midline (-Z).
 */
export function getSharedAnatomicalHeadGeometry(
  variant: AnatomicalHeadVariant,
): THREE.BufferGeometry {
  const cached = sharedHeadGeoCache.get(variant);
  if (cached) return cached;

  const isFemale = variant === 'female';
  const isZombie = variant === 'zombie';

  const geo = new THREE.SphereGeometry(1, 64, 48, Math.PI * 0.5, Math.PI * 2);
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const vertCount = posAttr.count;

  // Base head dimensions in meters (kept within helmet interior bounds with >= 3mm clearance)
  const rx = isFemale ? 0.073 : isZombie ? 0.075 : 0.078;
  const ry = isFemale ? 0.097 : 0.101;
  const rz = isFemale ? 0.089 : 0.094;
  const cy = 0.104;
  const cz = -0.004;

  const basePositions = new Float32Array(vertCount * 3);
  const morphArrays: Record<FacialMorphTargetName, Float32Array> = {} as Record<
    FacialMorphTargetName,
    Float32Array
  >;
  for (const name of FACIAL_MORPH_TARGET_NAMES) {
    morphArrays[name] = new Float32Array(vertCount * 3);
  }

  for (let i = 0; i < vertCount; i++) {
    // Unit sphere direction
    const ux = posAttr.getX(i);
    const uy = posAttr.getY(i);
    const uz = posAttr.getZ(i);

    // Base craniofacial ellipsoid
    let x = ux * rx;
    let y = cy + uy * ry;
    let z = cz + uz * rz;

    // 1. Occipital fullness (rear cranium) & subtle parietal dome
    if (uz > 0.1 && uy > -0.1) {
      const occ = smoothstep(0.1, 0.75, uz) * smoothstep(-0.1, 0.4, uy);
      z += occ * 0.009;
    }

    // 2. Temple inward taper
    const templeW =
      gaussian(Math.abs(x) - 0.068, 0.018) *
      gaussian(y - 0.120, 0.025) *
      gaussian(z - -0.024, 0.030);
    x -= Math.sign(x) * templeW * (isZombie ? 0.0085 : 0.0055);

    // 3. Mandibular jawline & tapered neck transition
    // Lower face anterior chin/jaw forward projection vs posterior neck cylinder taper
    const chinFactor =
      smoothstep(-0.02, -0.75, uz) * gaussian(y - 0.022, 0.022) * gaussian(x, 0.032);
    z -= chinFactor * (isFemale ? 0.010 : 0.014);
    y -= chinFactor * 0.004;

    // Jaw corners (gonion)
    const jawCorner =
      gaussian(Math.abs(x) - 0.056, 0.016) *
      gaussian(y - 0.036, 0.016) *
      gaussian(z - -0.024, 0.024);
    x += Math.sign(x) * jawCorner * (isFemale ? -0.003 : 0.0045);

    // Neck cylinder taper below mandible/occiput (y < 0.034)
    if (y < 0.034) {
      const neckBlend = smoothstep(0.034, -0.002, y) * smoothstep(-0.065, -0.010, z);
      const neckR = isFemale ? 0.044 : 0.050;
      const horizR = Math.hypot(x, z - 0.008);
      if (horizR > 1e-4) {
        const targetR = THREE.MathUtils.lerp(horizR, neckR, neckBlend * 0.85);
        const s = targetR / horizR;
        x *= s;
        z = 0.008 + (z - 0.008) * s;
      }
      y -= smoothstep(0.02, -0.002, y) * 0.024;
    }

    // 4. Supraorbital brow ridge
    const browRidge =
      gaussian(y - 0.122, 0.011) *
      smoothstep(-0.045, -0.082, z) *
      gaussian(x, 0.046);
    z -= browRidge * (isFemale ? 0.0045 : isZombie ? 0.0095 : 0.0075);

    // 5. Recessed eye sockets + sculpted upper/lower eyelid rims
    // Eye centers are at x = ±0.0315, y = 0.104, z ≈ -0.075 (eyeball radius 0.0125)
    for (const side of [-1, 1]) {
      const ex = side * 0.0315;
      const dx = x - ex;
      const dy = y - 0.104;
      const frontMask = smoothstep(-0.048, -0.076, z);

      // Deep socket indentation around cornea center (oval: wider horizontally)
      const orbDist = Math.hypot(dx / 0.0145, dy / 0.0095);
      const socketPocket = Math.exp(-orbDist * orbDist * 1.35) * frontMask;
      z += socketPocket * (isZombie ? 0.021 : 0.0185);

      // Upper & lower lid margin bulge cradling the recessed eyeball
      const lidApertureMask =
        gaussian(dx, 0.014) *
        (gaussian(dy - 0.010, 0.0042) + gaussian(dy + 0.0085, 0.0038)) *
        frontMask;
      z -= lidApertureMask * 0.0028;
    }

    // 6. Nose bridge, tip, and alae
    const noseBridge =
      gaussian(x, 0.0085) * smoothstep(-0.055, -0.085, z) * gaussian(y - 0.095, 0.019);
    const noseTip =
      gaussian(x, 0.0095) * smoothstep(-0.065, -0.088, z) * gaussian(y - 0.080, 0.0085);
    const nostrilFlare =
      gaussian(Math.abs(x) - 0.011, 0.0055) *
      smoothstep(-0.068, -0.088, z) *
      gaussian(y - 0.076, 0.0055);
    z -= noseBridge * 0.012 + noseTip * 0.016 + nostrilFlare * 0.0055;
    y -= noseTip * 0.0025;

    // 7. Zygomatic cheekbones + zombie buccal cheek hollow
    const cheek =
      gaussian(Math.abs(x) - 0.045, 0.015) *
      gaussian(y - 0.084, 0.013) *
      smoothstep(-0.035, -0.075, z);
    z -= cheek * (isZombie ? 0.0085 : 0.0055);

    const buccalHollow =
      gaussian(Math.abs(x) - 0.042, 0.014) *
      gaussian(y - 0.056, 0.014) *
      smoothstep(-0.030, -0.070, z);
    z += buccalHollow * (isZombie ? 0.011 : isFemale ? 0.0025 : 0.0015);

    // 8. Sculpted upper & lower lips + recessed oral fissure at y = 0.053
    const mouthFront = smoothstep(-0.058, -0.082, z) * gaussian(x, 0.023);
    const upperLipProfile = mouthFront * gaussian(y - 0.0585, 0.0042) * (1 - 0.25 * gaussian(x, 0.004));
    const lowerLipProfile = mouthFront * gaussian(y - 0.0475, 0.0046);
    const mouthSlit = mouthFront * gaussian(y - 0.053, 0.0026);
    z -= upperLipProfile * 0.0055 + lowerLipProfile * 0.0050;
    z += mouthSlit * 0.0085;

    // 9. Subtle sculpted ears (slim enough to fit under PelTor ear-pro & MICH ear-flares)
    const earMask =
      gaussian(Math.abs(x) - rx * 0.92, 0.012) *
      gaussian(y - 0.098, 0.020) *
      gaussian(z - 0.005, 0.014);
    x += Math.sign(x) * earMask * 0.0075;

    basePositions[i * 3] = x;
    basePositions[i * 3 + 1] = y;
    basePositions[i * 3 + 2] = z;

    // =========================================================================
    // BAKE ALL 15 ANATOMICAL MORPH TARGET DELTAS (ABSOLUTE RELATIVE OFFSETS)
    // =========================================================================
    const writeDelta = (name: FacialMorphTargetName, dx: number, dy: number, dz: number) => {
      const arr = morphArrays[name];
      arr[i * 3] = x + dx;
      arr[i * 3 + 1] = y + dy;
      arr[i * 3 + 2] = z + dz;
    };

    const frontFaceMask = smoothstep(-0.042, -0.076, z);

    // Brows
    const innerBrowMask =
      frontFaceMask * gaussian(x, 0.022) * gaussian(y - 0.123, 0.012);
    const outerBrowMask =
      frontFaceMask * gaussian(Math.abs(x) - 0.038, 0.014) * gaussian(y - 0.122, 0.012);
    const furrowMask =
      frontFaceMask * gaussian(x, 0.042) * gaussian(y - 0.121, 0.013);

    writeDelta('brow_inner_up', 0, innerBrowMask * 0.0055, -innerBrowMask * 0.0012);
    writeDelta('brow_outer_up', 0, outerBrowMask * 0.0052, -outerBrowMask * 0.001);
    writeDelta(
      'brow_furrow_down',
      -Math.sign(x) * furrowMask * 0.0028,
      -furrowMask * 0.0058,
      -furrowMask * 0.0025,
    );

    // Eyelids (left = x < 0, right = x > 0)
    const upperLidMaskL =
      frontFaceMask * gaussian(x + 0.0315, 0.014) * gaussian(y - 0.111, 0.0068);
    const lowerLidMaskL =
      frontFaceMask * gaussian(x + 0.0315, 0.014) * gaussian(y - 0.095, 0.0062);
    const upperLidMaskR =
      frontFaceMask * gaussian(x - 0.0315, 0.014) * gaussian(y - 0.111, 0.0068);
    const lowerLidMaskR =
      frontFaceMask * gaussian(x - 0.0315, 0.014) * gaussian(y - 0.095, 0.0062);

    // Blink sweeps upper lid down cleanly over front of eyeball (small -Z bow clears cornea)
    writeDelta(
      'eye_blink_l',
      0,
      -upperLidMaskL * 0.0135 + lowerLidMaskL * 0.0032,
      -(upperLidMaskL + lowerLidMaskL) * 0.0042,
    );
    writeDelta(
      'eye_blink_r',
      0,
      -upperLidMaskR * 0.0135 + lowerLidMaskR * 0.0032,
      -(upperLidMaskR + lowerLidMaskR) * 0.0042,
    );

    // Squint raises lower lid + narrows upper lid
    writeDelta(
      'eye_squint_l',
      -upperLidMaskL * 0.0008,
      lowerLidMaskL * 0.0055 - upperLidMaskL * 0.0035,
      -(lowerLidMaskL + upperLidMaskL) * 0.002,
    );
    writeDelta(
      'eye_squint_r',
      upperLidMaskR * 0.0008,
      lowerLidMaskR * 0.0055 - upperLidMaskR * 0.0035,
      -(lowerLidMaskR + upperLidMaskR) * 0.002,
    );

    // Wide lifts both upper lids & opens lower slightly
    const upperBoth = upperLidMaskL + upperLidMaskR;
    const lowerBoth = lowerLidMaskL + lowerLidMaskR;
    writeDelta(
      'eye_wide',
      0,
      upperBoth * 0.0052 - lowerBoth * 0.0022,
      -upperBoth * 0.0015,
    );

    // Cheeks & Sneer/Snarl
    const cheekMask =
      frontFaceMask * gaussian(Math.abs(x) - 0.039, 0.016) * gaussian(y - 0.083, 0.014);
    writeDelta('cheek_raise', 0, cheekMask * 0.0048, -cheekMask * 0.0032);

    const snarlMaskL =
      frontFaceMask * gaussian(x + 0.019, 0.013) * gaussian(y - 0.068, 0.013);
    const snarlMaskR =
      frontFaceMask * gaussian(x - 0.019, 0.013) * gaussian(y - 0.068, 0.013);
    writeDelta('sneer_snarl_l', -snarlMaskL * 0.0025, snarlMaskL * 0.0068, -snarlMaskL * 0.0025);
    writeDelta('sneer_snarl_r', snarlMaskR * 0.0025, snarlMaskR * 0.0068, -snarlMaskR * 0.0025);

    // Jaw Open: smoothly rotates lower jaw/chin/lower-lip around TMJ hinge (y=0.072, z=-0.020)
    // Strictly affects vertices below oral slit (y < 0.0545) and forward of neck back
    const lowerJawMask =
      smoothstep(0.0545, 0.044, y) *
      smoothstep(0.025, -0.035, z) *
      smoothstep(0.005, 0.024, y);
    if (lowerJawMask > 0.001) {
      const hingeY = 0.072;
      const hingeZ = -0.020;
      const relY = y - hingeY;
      const relZ = z - hingeZ;
      const angle = lowerJawMask * 0.40; // ~23 deg clean anatomical open
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const rotY = relY * cosA + relZ * sinA;
      const rotZ = -relY * sinA + relZ * cosA;
      writeDelta('jaw_open', 0, hingeY + rotY - y, hingeZ + rotZ - z);
    } else {
      writeDelta('jaw_open', 0, 0, 0);
    }

    // Mouth Tense Grimace
    const grimaceMask =
      frontFaceMask * gaussian(y - 0.053, 0.010) * gaussian(x, 0.028);
    writeDelta(
      'mouth_tense_grimace',
      Math.sign(x) * grimaceMask * 0.0042,
      -grimaceMask * 0.0008,
      grimaceMask * 0.0026,
    );

    // Lip Pull Upper (exposes upper teeth cleanly in snarl/aggression)
    const upperLipPullMask =
      frontFaceMask * gaussian(x, 0.022) * smoothstep(0.051, 0.059, y) * gaussian(y - 0.060, 0.008);
    writeDelta('lip_pull_upper', 0, upperLipPullMask * 0.0065, -upperLipPullMask * 0.0032);

    // Lip Corner Snarl
    const cornerSnarlMask =
      frontFaceMask * gaussian(Math.abs(x) - 0.023, 0.010) * gaussian(y - 0.054, 0.009);
    writeDelta(
      'lip_corner_snarl',
      Math.sign(x) * cornerSnarlMask * 0.0045,
      cornerSnarlMask * 0.0034,
      cornerSnarlMask * 0.0022,
    );
  }

  posAttr.array.set(basePositions);
  posAttr.needsUpdate = true;

  // Build Three.js morphAttributes + dictionary
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = FACIAL_MORPH_TARGET_NAMES.map((name) => {
    const attr = new THREE.BufferAttribute(morphArrays[name], 3);
    attr.name = name;
    return attr;
  });

  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  sharedHeadGeoCache.set(variant, geo);
  return geo;
}

// ============================================================================
// CACHED PROCEDURAL SKIN + ROUGHNESS + EYEBALL TEXTURES
// ============================================================================

interface SkinTextureSet {
  readonly map: THREE.CanvasTexture;
  readonly roughnessMap: THREE.CanvasTexture;
}

const skinTextureCache = new Map<string, SkinTextureSet>();
const scleraTextureCache = new Map<string, THREE.CanvasTexture>();

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function seededRand(seed: number): () => number {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generates and caches realistic PBR facial skin color + T-zone roughness CanvasTextures.
 * UV layout matches `SphereGeometry(..., phiStart = PI/2)`:
 *   u = 0.5 -> front facial midline (-Z)
 *   v = 0.5 -> nose/eye band (Three.js v=1 top crown, v=0 bottom neck, Canvas y = (1-v)*H)
 */
export function getSharedSkinTextures(
  variant: AnatomicalHeadVariant,
  toneSeed: number,
  anisotropy = 4,
): SkinTextureSet {
  const palette = getSkinTonePalette(toneSeed, variant);
  const bucket = variant === 'zombie' ? 'zombie' : `${variant}_${Math.abs(Math.floor(toneSeed)) % HUMAN_SKIN_PALETTES.length}`;
  const existing = skinTextureCache.get(bucket);
  if (existing) return existing;

  const W = 512;
  const H = 512;
  const colorCanvas = createCanvas(W, H);
  const ctx = colorCanvas.getContext('2d')!;

  const roughCanvas = createCanvas(W, H);
  const rctx = roughCanvas.getContext('2d')!;

  // Base dermal tone
  ctx.fillStyle = palette.baseHex;
  ctx.fillRect(0, 0, W, H);

  // Base skin roughness (matte ~0.76, T-zone slightly glossier ~0.48)
  rctx.fillStyle = variant === 'zombie' ? 'rgb(218,218,218)' : 'rgb(192,192,192)';
  rctx.fillRect(0, 0, W, H);

  const cx = W * 0.5;
  // Anatomical y centers in canvas coords (y = (1 - (cy_head + ry*cos(theta)) -> unit theta mapping))
  // Eye center y=0.104 aligns closely with canvas y ≈ 0.49 * H
  const eyeY = H * 0.485;
  const browY = H * 0.435;
  const noseTipY = H * 0.565;
  const mouthY = H * 0.655;
  const eyeOffsetX = W * 0.068;

  // Forehead / nose bridge warm highlight
  const tZoneGrad = ctx.createRadialGradient(cx, H * 0.42, 6, cx, H * 0.45, W * 0.20);
  tZoneGrad.addColorStop(0, palette.highlightHex);
  tZoneGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = tZoneGrad;
  ctx.fillRect(cx - W * 0.22, H * 0.22, W * 0.44, H * 0.45);

  // T-zone oil specularity on roughness map
  const tRoughGrad = rctx.createRadialGradient(cx, H * 0.46, 6, cx, H * 0.48, W * 0.14);
  tRoughGrad.addColorStop(0, variant === 'zombie' ? 'rgba(165,165,165,0.65)' : 'rgba(122,122,122,0.85)');
  tRoughGrad.addColorStop(1, 'rgba(192,192,192,0)');
  rctx.fillStyle = tRoughGrad;
  rctx.fillRect(cx - W * 0.16, H * 0.25, W * 0.32, H * 0.40);

  // Subtle subsurface warmth across cheeks & nose
  for (const side of [-1, 1]) {
    const chkGrad = ctx.createRadialGradient(
      cx + side * W * 0.095,
      H * 0.555,
      4,
      cx + side * W * 0.095,
      H * 0.555,
      W * 0.085,
    );
    chkGrad.addColorStop(0, palette.blushHex);
    chkGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = variant === 'zombie' ? 0.24 : 0.30;
    ctx.fillStyle = chkGrad;
    ctx.beginPath();
    ctx.arc(cx + side * W * 0.095, H * 0.555, W * 0.085, 0, Math.PI * 2);
    ctx.fill();
  }

  // Orbital depth & dark under-eye shadow
  for (const side of [-1, 1]) {
    const ex = cx + side * eyeOffsetX;
    const orbGrad = ctx.createRadialGradient(ex, eyeY, 2, ex, eyeY, W * 0.048);
    orbGrad.addColorStop(0, variant === 'zombie' ? '#1c181a' : palette.shadowHex);
    orbGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = variant === 'zombie' ? 0.85 : 0.52;
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, W * 0.048, H * 0.032, 0, 0, Math.PI * 2);
    ctx.fill();

    // Lash line darkening
    ctx.globalAlpha = variant === 'zombie' ? 0.72 : 0.45;
    ctx.strokeStyle = '#1b1412';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(ex - W * 0.025, eyeY - H * 0.006);
    ctx.quadraticCurveTo(ex, eyeY - H * 0.015, ex + W * 0.025, eyeY - H * 0.005);
    ctx.stroke();

    // Sculpted eyebrow hair strokes
    ctx.globalAlpha = variant === 'zombie' ? 0.58 : 0.85;
    ctx.strokeStyle = palette.browHex;
    ctx.lineWidth = variant === 'female' ? 3.2 : 4.4;
    ctx.beginPath();
    ctx.moveTo(ex - side * W * 0.030, browY + H * 0.005);
    ctx.quadraticCurveTo(ex, browY - H * 0.008, ex + side * W * 0.034, browY + H * 0.004);
    ctx.stroke();
  }

  // Nostril shadows + philtrum
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = palette.shadowHex;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + side * W * 0.016, noseTipY + H * 0.012, W * 0.011, H * 0.007, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Upper & lower lips + dark mouth line
  ctx.globalAlpha = variant === 'zombie' ? 0.78 : 0.72;
  ctx.fillStyle = palette.lipHex;
  ctx.beginPath();
  ctx.ellipse(cx, mouthY - H * 0.007, W * 0.036, H * 0.009, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, mouthY + H * 0.008, W * 0.032, H * 0.010, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.88;
  ctx.strokeStyle = variant === 'zombie' ? '#240b0b' : '#4a2622';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(cx - W * 0.034, mouthY);
  ctx.quadraticCurveTo(cx, mouthY + H * 0.002, cx + W * 0.034, mouthY);
  ctx.stroke();

  // Jaw / beard stubble or zombie blood & veins
  const rand = seededRand(variant === 'zombie' ? 991 : 401 + Math.floor(toneSeed) * 37);
  if (variant === 'male' && palette.stubbleAlpha > 0) {
    ctx.globalAlpha = palette.stubbleAlpha;
    ctx.fillStyle = '#241c18';
    for (let s = 0; s < 900; s++) {
      const sx = cx + (rand() - 0.5) * W * 0.24;
      const sy = mouthY - H * 0.02 + rand() * H * 0.14;
      const distMouth = Math.hypot(sx - cx, sy - mouthY);
      if (distMouth < W * 0.036) continue;
      ctx.fillRect(sx, sy, 1.4, 1.4);
    }
  } else if (variant === 'zombie') {
    // Subdermal dark necrotic veins + coagulated mouth blood
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = '#470d0e';
    ctx.beginPath();
    ctx.ellipse(cx + W * 0.005, mouthY + H * 0.025, W * 0.036, H * 0.028, 0.12, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#312328';
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.42;
    for (let v = 0; v < 26; v++) {
      let vx = cx + (rand() - 0.5) * W * 0.34;
      let vy = H * 0.34 + rand() * H * 0.38;
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

  // Subtle organic skin pore noise & combat grime across face
  ctx.globalAlpha = 0.09;
  for (let p = 0; p < 1400; p++) {
    ctx.fillStyle = p % 2 === 0 ? palette.shadowHex : palette.highlightHex;
    ctx.fillRect(rand() * W, rand() * H, 1.5, 1.5);
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
 * Generates and caches high-detail eyeball sclera + iris + pupil CanvasTexture.
 * Uses SphereGeometry(r, 24, 18, Math.PI * 0.5, Math.PI * 2) so u=0.5, v=0.5 faces directly -Z!
 */
export function getSharedEyeballTexture(
  variant: AnatomicalHeadVariant,
  toneSeed: number,
): THREE.CanvasTexture {
  const palette = getSkinTonePalette(toneSeed, variant);
  const key = variant === 'zombie' ? 'zombie' : `human_${Math.abs(Math.floor(toneSeed)) % HUMAN_SKIN_PALETTES.length}`;
  const cached = scleraTextureCache.get(key);
  if (cached) return cached;

  const W = 256;
  const H = 256;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d')!;

  // Sclera base
  ctx.fillStyle = variant === 'zombie' ? '#b3aba0' : '#ede7e1';
  ctx.fillRect(0, 0, W, H);

  const cx = W * 0.5;
  const cy = H * 0.5;

  // Subtle bloodshot capillaries radiating around sclera edges
  const rand = seededRand(variant === 'zombie' ? 777 : 213);
  ctx.strokeStyle = variant === 'zombie' ? '#7a2522' : '#c97874';
  ctx.globalAlpha = variant === 'zombie' ? 0.65 : 0.28;
  ctx.lineWidth = variant === 'zombie' ? 1.5 : 0.9;
  const veinCount = variant === 'zombie' ? 28 : 12;
  for (let i = 0; i < veinCount; i++) {
    const ang = rand() * Math.PI * 2;
    const r0 = W * 0.16;
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

  // Iris gradient + radial fibers + limbal ring
  const irisR = W * 0.118;
  const irisGrad = ctx.createRadialGradient(cx, cy, irisR * 0.25, cx, cy, irisR);
  irisGrad.addColorStop(0, palette.irisHex);
  irisGrad.addColorStop(0.75, palette.irisHex);
  irisGrad.addColorStop(1, palette.irisRimHex);
  ctx.fillStyle = irisGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, irisR, 0, Math.PI * 2);
  ctx.fill();

  // Radial iris striations
  ctx.strokeStyle = variant === 'zombie' ? '#aeb8ad' : palette.irisRimHex;
  ctx.globalAlpha = 0.28;
  ctx.lineWidth = 1.0;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * irisR * 0.42, cy + Math.sin(a) * irisR * 0.42);
    ctx.lineTo(cx + Math.cos(a) * irisR * 0.92, cy + Math.sin(a) * irisR * 0.92);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Pupil + subtle milky cataract haze on zombie
  const pupilR = variant === 'zombie' ? irisR * 0.42 : irisR * 0.36;
  ctx.fillStyle = variant === 'zombie' ? '#2c312e' : '#08090b';
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
    // Crisp specular catchlight glint
    ctx.fillStyle = 'rgba(255,255,255,0.68)';
    ctx.beginPath();
    ctx.arc(cx - irisR * 0.28, cy - irisR * 0.28, irisR * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  scleraTextureCache.set(key, tex);
  return tex;
}

// ============================================================================
// SHARED ANATOMICAL HEAD ASSEMBLY + FACE GEAR + EYEWEAR BUILDERS
// ============================================================================

let sharedEyeballGeo: THREE.BufferGeometry | null = null;
function getSharedEyeballGeo(): THREE.BufferGeometry {
  if (!sharedEyeballGeo) {
    sharedEyeballGeo = new THREE.SphereGeometry(0.0124, 20, 16, Math.PI * 0.5, Math.PI * 2);
  }
  return sharedEyeballGeo;
}

export interface BuiltAnatomicalHeadAssembly {
  readonly root: THREE.Group;
  readonly headMesh: THREE.Mesh;
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
  applyFaceGear: (faceGear: FaceGearId) => void;
  applyEyewear: (eyewear: EyewearId) => void;
}

export interface BuildHeadAssemblyParams {
  variant: AnatomicalHeadVariant;
  toneSeed: number;
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

  const skinTex = getSharedSkinTextures(variant, toneSeed, anisotropy);
  const skinMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: skinTex.map,
      roughnessMap: skinTex.roughnessMap,
      roughness: variant === 'zombie' ? 0.86 : 0.72,
      metalness: 0.02,
    }),
  );

  const headGeo = getSharedAnatomicalHeadGeometry(variant);
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.name = 'anatomical_head_mesh';
  headMesh.renderOrder = 0;
  headMesh.castShadow = true;
  headMesh.receiveShadow = true;
  // Ensure morph target dictionary + zeroed array of length 15
  headMesh.updateMorphTargets();
  if (!headMesh.morphTargetInfluences || headMesh.morphTargetInfluences.length !== FACIAL_MORPH_COUNT) {
    headMesh.morphTargetInfluences = new Array<number>(FACIAL_MORPH_COUNT).fill(0);
  }
  root.add(headMesh);

  // Oral interior & teeth (zero MeshBasicMaterial — strictly MeshStandardMaterial!)
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
  oralCavityMesh.position.set(0, 0.053, -0.068);
  oralCavityMesh.renderOrder = 0;

  const upperTeethMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.017, 0.017, 0.006, 10, 1, false, Math.PI * 0.62, Math.PI * 0.76)),
    teethMat,
  );
  upperTeethMesh.position.set(0, 0.0565, -0.069);
  upperTeethMesh.renderOrder = 0;

  const lowerTeethMesh = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 0.0055, 10, 1, false, Math.PI * 0.62, Math.PI * 0.76)),
    teethMat,
  );
  lowerTeethMesh.renderOrder = 0;
  if (jawParentForLowerTeeth) {
    const off = lowerTeethInJawOffset ?? [0, -0.016, -0.049];
    lowerTeethMesh.position.set(off[0], off[1], off[2]);
    jawParentForLowerTeeth.add(lowerTeethMesh);
  } else {
    lowerTeethMesh.position.set(0, 0.049, -0.068);
    root.add(lowerTeethMesh);
  }
  root.add(oralCavityMesh, upperTeethMesh);

  // Independent Eyeballs (eye_l at x=-0.0315, eye_r at x=+0.0315; recessed cleanly in sockets)
  const eyeTex = getSharedEyeballTexture(variant, toneSeed);
  const eyeMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: eyeTex,
      roughness: variant === 'zombie' ? 0.36 : 0.14,
      metalness: 0.02,
    }),
  );

  const eyeL = new THREE.Group();
  eyeL.name = 'eye_l';
  eyeL.position.set(-0.0315, 0.104, -0.075);

  const eyeR = new THREE.Group();
  eyeR.name = 'eye_r';
  eyeR.position.set(0.0315, 0.104, -0.075);

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
    oralCavityMesh,
    upperTeethMesh,
    lowerTeethMesh,
    eyeBallL,
    eyeBallR,
  ];

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

    // 1. Neck Gaiter (sits over lower neck + chin tip, leaves nose/cheeks/eyes exposed)
    const gaiterLower = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.064 * scaleX, 0.068 * scaleX, 0.056, 16)),
      hoodMaterial,
    );
    gaiterLower.scale.set(1.0, 1.0, 1.06);
    gaiterLower.position.set(0, 0.008, -0.006);

    const gaiterChin = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.066 * scaleX, 0.064 * scaleX, 0.028, 16)),
      hoodMaterial,
    );
    gaiterChin.scale.set(1.02, 1.0, 1.12);
    gaiterChin.position.set(0, 0.036, -0.012);
    neckGaiterGroup.add(gaiterLower, gaiterChin);
    root.add(neckGaiterGroup);
    allMeshes.push(gaiterLower, gaiterChin);

    // 2. Full Balaclava (covers neck, jaw, cheeks, nose bridge & crown with sculpted eye aperture)
    const balaLowerMask = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.082 * scaleX, 0.070 * scaleX, 0.088, 18)),
      hoodMaterial,
    );
    balaLowerMask.scale.set(0.98, 1.0, 1.16);
    balaLowerMask.position.set(0, 0.044, -0.008);

    const balaNoseBridge = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.022, 0.024, 0.022)),
      hoodMaterial,
    );
    balaNoseBridge.position.set(0, 0.084, -0.092);
    balaNoseBridge.rotation.x = -0.18;

    const balaHoodCrown = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.089 * scaleX, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.56)),
      hoodMaterial,
    );
    balaHoodCrown.scale.set(0.94, 1.04, 1.10);
    balaHoodCrown.position.set(0, 0.118, -0.002);
    balaHoodCrown.rotation.x = -0.08;

    const balaRearNape = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.084 * scaleX, 0.072 * scaleX, 0.072, 16, 1, false, -Math.PI * 0.58, Math.PI * 1.16)),
      hoodMaterial,
    );
    balaRearNape.position.set(0, 0.088, 0.008);

    balaclavaGroup.add(balaLowerMask, balaNoseBridge, balaHoodCrown, balaRearNape);
    root.add(balaclavaGroup);
    allMeshes.push(balaLowerMask, balaNoseBridge, balaHoodCrown, balaRearNape);

    // 3. Clear Ballistic Glasses
    // NOTE: Keep `depthWrite: true` and use `renderOrder: 6` so opaque eyeballs (renderOrder 1)
    // and facial skin (renderOrder 0) render cleanly before the lens while satisfying strict
    // `headGroup` depthWrite invariants when headShadowOnly = false!
    const clearLensMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xdbeafe,
        roughness: 0.08,
        metalness: 0.15,
        transparent: true,
        opacity: 0.26,
        depthWrite: true,
      }),
    );

    const topRim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.128 * scaleX, 0.007, 0.018)),
      frameMaterial,
    );
    topRim.position.set(0, 0.118, -0.097);

    const clearLens = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.068 * scaleX, 0.068 * scaleX, 0.028, 18, 1, false, Math.PI * 0.72, Math.PI * 0.56)),
      clearLensMat,
    );
    clearLens.scale.set(1.0, 1.0, 0.58);
    clearLens.position.set(0, 0.104, -0.061);
    clearLens.renderOrder = 6;

    const nosePad = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.012, 0.012, 0.010)),
      frameMaterial,
    );
    nosePad.position.set(0, 0.095, -0.100);

    for (const side of [-1, 1]) {
      const templeArm = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.005, 0.006, 0.092)),
        frameMaterial,
      );
      templeArm.position.set(side * 0.066 * scaleX, 0.114, -0.048);
      clearGlassesGroup.add(templeArm);
      allMeshes.push(templeArm);
    }

    clearGlassesGroup.add(topRim, clearLens, nosePad);
    root.add(clearGlassesGroup);
    allMeshes.push(topRim, clearLens, nosePad);

    // 4. Tinted Ballistic Visor (smoke polycarbonate wraparound shield)
    const tintedVisorMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x151d24,
        roughness: 0.12,
        metalness: 0.78,
        transparent: true,
        opacity: 0.86,
        depthWrite: true,
      }),
    );
    const visorBrow = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.136 * scaleX, 0.008, 0.022)),
      frameMaterial,
    );
    visorBrow.position.set(0, 0.121, -0.099);

    const visorShield = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.072 * scaleX, 0.071 * scaleX, 0.036, 20, 1, false, Math.PI * 0.68, Math.PI * 0.64)),
      tintedVisorMat,
    );
    visorShield.scale.set(1.0, 1.0, 0.60);
    visorShield.position.set(0, 0.105, -0.060);
    visorShield.renderOrder = 6;

    for (const side of [-1, 1]) {
      const visorArm = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.006, 0.010, 0.088)),
        frameMaterial,
      );
      visorArm.position.set(side * 0.070 * scaleX, 0.114, -0.045);
      tintedVisorGroup.add(visorArm);
      allMeshes.push(visorArm);
    }

    tintedVisorGroup.add(visorBrow, visorShield);
    root.add(tintedVisorGroup);
    allMeshes.push(visorBrow, visorShield);
  }

  for (const m of allMeshes) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

  const applyFaceGear = (faceGear: FaceGearId) => {
    neckGaiterGroup.visible = includeGearAndEyewear && faceGear === 'neck_gaiter';
    balaclavaGroup.visible = includeGearAndEyewear && faceGear === 'balaclava';
  };

  const applyEyewear = (eyewear: EyewearId) => {
    clearGlassesGroup.visible = includeGearAndEyewear && eyewear === 'clear_glasses';
    tintedVisorGroup.visible = includeGearAndEyewear && eyewear === 'tinted_visor';
  };

  applyFaceGear('neck_gaiter');
  applyEyewear('none');

  return {
    root,
    headMesh,
    eyeL,
    eyeR,
    eyeBallL,
    eyeBallR,
    oralCavityMesh,
    upperTeethMesh,
    lowerTeethMesh,
    morphTargetInfluences: headMesh.morphTargetInfluences,
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
    applyFaceGear,
    applyEyewear,
  };
}

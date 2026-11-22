import * as THREE from 'three';
import type { OperatorUniformId } from '../data/multiplayer';

export type { OperatorUniformId };

export interface ProceduralFabricSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export interface TacticalUniformPreset {
  id: OperatorUniformId;
  label: string;
  sleeveRgb: [number, number, number];
  pantsRgb: [number, number, number];
  vestRgb: [number, number, number];
  pouchTintHex: number;
  gloveRgb: [number, number, number];
  palmRgb: [number, number, number];
  bootRgb: [number, number, number];
  helmetHex: number;
  hoodHex: number;
  hardwareHex: number;
  iffTrimHex: number;
  iffEmissiveHex: number;
  iffEmissiveIntensity: number;
  visorHex: number;
  watchEmissiveHex: number;
  camoPattern: 'urban_ripstop' | 'arid_gorka' | 'charcoal_contractor' | 'olive_bdu';
  seedOffset: number;
}

/**
 * Distinct per-team tactical uniform presets shared across:
 *  - Local FPS viewmodel character (`CharacterSkeleton`)
 *  - Remote human operators (`RemotePlayerManager`)
 *  - Tactical Battle AI combatants (`BattleBotAI`)
 */
export const TACTICAL_UNIFORM_PRESETS: Record<OperatorUniformId, TacticalUniformPreset> = {
  team_a: {
    id: 'team_a',
    label: 'Coalition Urban Slate',
    sleeveRgb: [46, 62, 82], // Midnight Slate Navy Crye combat shirt
    pantsRgb: [39, 51, 66], // Matching slate tactical trousers
    vestRgb: [54, 60, 68], // Dark Graphite SAPI plate carrier
    pouchTintHex: 0x8d99a6, // Cool steel-grey mag pouches
    gloveRgb: [32, 36, 42], // Charcoal carbon-knuckle gloves
    palmRgb: [48, 52, 58],
    bootRgb: [28, 30, 34], // Matte black composite boots
    helmetHex: 0x24303d,
    hoodHex: 0x1d2630,
    hardwareHex: 0x1c2026,
    iffTrimHex: 0x38bdf8, // Coalition Cyan IFF strobe/patch
    iffEmissiveHex: 0x0c4a6e,
    iffEmissiveIntensity: 0.7,
    visorHex: 0x0b1622,
    watchEmissiveHex: 0x0e3a4a,
    camoPattern: 'urban_ripstop',
    seedOffset: 101,
  },
  team_b: {
    id: 'team_b',
    label: 'OPFOR Arid Incursion',
    sleeveRgb: [122, 104, 78], // Arid Sand / Khaki Gorka combat top
    pantsRgb: [78, 72, 54], // Olive-earth reinforced trousers
    vestRgb: [94, 72, 50], // Coyote / Russet-tan SAPI plate carrier
    pouchTintHex: 0xc8b290, // Warm desert-khaki pouches
    gloveRgb: [68, 58, 46], // Coyote-brown tactical gloves
    palmRgb: [92, 76, 58],
    bootRgb: [76, 63, 46], // Desert suede tactical boots
    helmetHex: 0x453b2c,
    hoodHex: 0x352e23,
    hardwareHex: 0x26211c,
    iffTrimHex: 0xf97316, // High-contrast Amber-Orange OPFOR IFF band
    iffEmissiveHex: 0x7c2d12,
    iffEmissiveIntensity: 0.72,
    visorHex: 0x1a130c,
    watchEmissiveHex: 0x4a250e,
    camoPattern: 'arid_gorka',
    seedOffset: 211,
  },
  ffa: {
    id: 'ffa',
    label: 'Independent Contractor',
    sleeveRgb: [56, 60, 64], // Weathered Ash / Charcoal jacket
    pantsRgb: [42, 46, 50], // Dark slate contractor pants
    vestRgb: [36, 38, 42], // Matte-black plate carrier
    pouchTintHex: 0xa6967a, // Ranger-tan utility pouches
    gloveRgb: [34, 34, 36], // Black leather tactical gloves
    palmRgb: [54, 48, 42],
    bootRgb: [30, 30, 32], // Black tactical boots
    helmetHex: 0x26292e,
    hoodHex: 0x1f2226,
    hardwareHex: 0x1a1c1f,
    iffTrimHex: 0xf59e0b, // Muted Amber-Gold contractor trim
    iffEmissiveHex: 0x78350f,
    iffEmissiveIntensity: 0.52,
    visorHex: 0x111317,
    watchEmissiveHex: 0x3d2a0d,
    camoPattern: 'charcoal_contractor',
    seedOffset: 307,
  },
  infection: {
    id: 'infection',
    label: 'Containment Unit BDU',
    sleeveRgb: [68, 76, 58], // Classic Olive-Drab ripstop BDU sleeves
    pantsRgb: [58, 60, 52], // Tactical olive field trousers
    vestRgb: [78, 72, 54], // Weathered khaki SAPI plate carrier
    pouchTintHex: 0xbab39d, // Khaki mag pouches
    gloveRgb: [44, 46, 42], // Dark olive tactical gloves
    palmRgb: [60, 54, 46],
    bootRgb: [38, 35, 31], // Weathered combat boots
    helmetHex: 0x2d3328,
    hoodHex: 0x252822,
    hardwareHex: 0x202225,
    iffTrimHex: 0x84cc16, // Containment Bio-Green IFF squad glint
    iffEmissiveHex: 0x365314,
    iffEmissiveIntensity: 0.6,
    visorHex: 0x0f1512,
    watchEmissiveHex: 0x15281f,
    camoPattern: 'olive_bdu',
    seedOffset: 17,
  },
};

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 53.3) * 43758.5453123;
  return n - Math.floor(n);
}

/**
 * Generates procedural ripstop twill fabric PBR texture maps (albedo, normal, roughness)
 * with subtle per-faction camo/weave variation.
 */
export function buildFabricTextureSet(
  baseRgb: [number, number, number],
  weaveContrast: number,
  wearStrength: number,
  roughBase: number,
  seed: number,
  anisotropy: number,
  camoPattern: TacticalUniformPreset['camoPattern'] = 'olive_bdu',
): ProceduralFabricSet {
  const size = 128;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const actx = albedo.getContext('2d')!;
  const aimg = actx.createImageData(size, size);

  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rctx = rough.getContext('2d')!;
  const rimg = rctx.createImageData(size, size);

  const norm = document.createElement('canvas');
  norm.width = size;
  norm.height = size;
  const nctx = norm.getContext('2d')!;
  const nimg = nctx.createImageData(size, size);

  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rip = x % 8 === 0 || y % 8 === 0 ? 1 : 0;
      const twill = ((x + y) % 2 === 0 ? 0.5 : -0.5) * weaveContrast;
      const dirt = (hash2(Math.floor(x / 6), Math.floor(y / 6), seed) - 0.5) * wearStrength;
      const grain = (hash2(x, y, seed + 7) - 0.5) * 0.08;

      // Subtle faction-distinct camo blotches (multi-scale macro cells)
      let camoShift = 0;
      if (camoPattern === 'arid_gorka') {
        const patch = hash2(Math.floor(x / 18), Math.floor(y / 14), seed + 31);
        camoShift = patch > 0.66 ? 0.14 : patch < 0.24 ? -0.14 : 0;
      } else if (camoPattern === 'urban_ripstop') {
        const patch = hash2(Math.floor(x / 16), Math.floor(y / 16), seed + 47);
        camoShift = patch > 0.72 ? -0.1 : patch < 0.22 ? 0.08 : 0;
      } else if (camoPattern === 'charcoal_contractor') {
        const streak = hash2(Math.floor(x / 20), Math.floor(y / 10), seed + 59);
        camoShift = streak > 0.7 ? 0.09 : streak < 0.25 ? -0.08 : 0;
      } else {
        const blotch = hash2(Math.floor(x / 14), Math.floor(y / 14), seed + 23);
        camoShift = blotch > 0.7 ? -0.1 : blotch < 0.22 ? 0.08 : 0;
      }

      const shade = 1 + twill + dirt + grain + camoShift - rip * 0.06;
      const idx = (y * size + x) * 4;
      aimg.data[idx] = THREE.MathUtils.clamp(Math.round(baseRgb[0] * shade), 8, 240);
      aimg.data[idx + 1] = THREE.MathUtils.clamp(Math.round(baseRgb[1] * shade), 8, 240);
      aimg.data[idx + 2] = THREE.MathUtils.clamp(Math.round(baseRgb[2] * shade), 8, 240);
      aimg.data[idx + 3] = 255;

      const rVal = THREE.MathUtils.clamp(
        Math.round((roughBase + dirt * 0.25 - rip * 0.04) * 255),
        80,
        252,
      );
      rimg.data[idx] = rVal;
      rimg.data[idx + 1] = rVal;
      rimg.data[idx + 2] = rVal;
      rimg.data[idx + 3] = 255;

      heights[y * size + x] = rip * 0.35 + twill * 0.8 + grain;
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * 2.2;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const idx = (y * size + x) * 4;
      nimg.data[idx] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 3] = 255;
    }
  }

  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 2);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;

  const normalMap = new THREE.CanvasTexture(norm);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(2, 2);
  normalMap.anisotropy = anisotropy;

  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.set(2, 2);
  roughnessMap.anisotropy = anisotropy;

  return { map, normalMap, roughnessMap };
}

export interface TacticalUniformMaterialBundle {
  id: OperatorUniformId;
  sleeveMat: THREE.MeshStandardMaterial;
  pantsMat: THREE.MeshStandardMaterial;
  vestMat: THREE.MeshStandardMaterial;
  pouchMat: THREE.MeshStandardMaterial;
  gloveMat: THREE.MeshStandardMaterial;
  bootMat: THREE.MeshStandardMaterial;
  soleMat: THREE.MeshStandardMaterial;
  knuckleMat: THREE.MeshStandardMaterial;
  hardwareMat: THREE.MeshStandardMaterial;
  helmetMat: THREE.MeshStandardMaterial;
  hoodMat: THREE.MeshStandardMaterial;
  skinMat: THREE.MeshStandardMaterial;
  visorMat: THREE.MeshStandardMaterial;
  iffTrimMat: THREE.MeshStandardMaterial;
  gunMat: THREE.MeshStandardMaterial;
  gunAccentMat: THREE.MeshStandardMaterial;
  flashMat: THREE.MeshBasicMaterial;
  laserMat: THREE.MeshBasicMaterial;
  lightGlowMat: THREE.MeshBasicMaterial;
  dispose: () => void;
}

/**
 * Caches one procedural PBR material bundle per `OperatorUniformId` so all remote players
 * and Battle AI bots on the same team share identical ripstop fabric textures with zero duplication.
 */
export class TacticalUniformMaterialLibrary {
  private readonly bundles = new Map<OperatorUniformId, TacticalUniformMaterialBundle>();
  private readonly anisotropy: number;

  constructor(maxAnisotropy = 4) {
    this.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  }

  public getBundle(uniformId: OperatorUniformId): TacticalUniformMaterialBundle {
    const existing = this.bundles.get(uniformId);
    if (existing) return existing;

    const preset = TACTICAL_UNIFORM_PRESETS[uniformId] ?? TACTICAL_UNIFORM_PRESETS.team_a;
    const s = preset.seedOffset;

    const sleeveTex = buildFabricTextureSet(
      preset.sleeveRgb,
      0.08,
      0.14,
      0.88,
      s + 17,
      this.anisotropy,
      preset.camoPattern,
    );
    const pantsTex = buildFabricTextureSet(
      preset.pantsRgb,
      0.09,
      0.18,
      0.9,
      s + 43,
      this.anisotropy,
      preset.camoPattern,
    );
    const vestTex = buildFabricTextureSet(
      preset.vestRgb,
      0.12,
      0.14,
      0.84,
      s + 71,
      this.anisotropy,
      preset.camoPattern,
    );
    const bootTex = buildFabricTextureSet(
      preset.bootRgb,
      0.04,
      0.22,
      0.74,
      s + 109,
      this.anisotropy,
      'olive_bdu',
    );
    const gloveTex = buildFabricTextureSet(
      preset.gloveRgb,
      0.14,
      0.18,
      0.78,
      s + 137,
      this.anisotropy,
      'olive_bdu',
    );

    const texSets = [sleeveTex, pantsTex, vestTex, bootTex, gloveTex];

    const sleeveMat = new THREE.MeshStandardMaterial({
      map: sleeveTex.map,
      normalMap: sleeveTex.normalMap,
      roughnessMap: sleeveTex.roughnessMap,
      roughness: 0.92,
      metalness: 0.03,
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      map: pantsTex.map,
      normalMap: pantsTex.normalMap,
      roughnessMap: pantsTex.roughnessMap,
      roughness: 0.94,
      metalness: 0.03,
    });
    const vestMat = new THREE.MeshStandardMaterial({
      map: vestTex.map,
      normalMap: vestTex.normalMap,
      roughnessMap: vestTex.roughnessMap,
      roughness: 0.86,
      metalness: 0.06,
    });
    const pouchMat = new THREE.MeshStandardMaterial({
      map: vestTex.map,
      normalMap: vestTex.normalMap,
      color: preset.pouchTintHex,
      roughness: 0.88,
      metalness: 0.05,
    });
    const gloveMat = new THREE.MeshStandardMaterial({
      map: gloveTex.map,
      normalMap: gloveTex.normalMap,
      roughnessMap: gloveTex.roughnessMap,
      roughness: 0.8,
      metalness: 0.06,
    });
    const bootMat = new THREE.MeshStandardMaterial({
      map: bootTex.map,
      normalMap: bootTex.normalMap,
      roughnessMap: bootTex.roughnessMap,
      roughness: 0.76,
      metalness: 0.08,
    });
    const soleMat = new THREE.MeshStandardMaterial({
      color: 0x181818,
      roughness: 0.95,
      metalness: 0.04,
    });
    const knuckleMat = new THREE.MeshStandardMaterial({
      color: 0x17191b,
      roughness: 0.38,
      metalness: 0.28,
    });
    const hardwareMat = new THREE.MeshStandardMaterial({
      color: preset.hardwareHex,
      roughness: 0.36,
      metalness: 0.72,
    });
    const helmetMat = new THREE.MeshStandardMaterial({
      color: preset.helmetHex,
      roughness: 0.72,
      metalness: 0.14,
    });
    const hoodMat = new THREE.MeshStandardMaterial({
      color: preset.hoodHex,
      roughness: 0.92,
      metalness: 0.02,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0x9f7c67,
      roughness: 0.76,
      metalness: 0.02,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: preset.visorHex,
      roughness: 0.18,
      metalness: 0.76,
    });
    const iffTrimMat = new THREE.MeshStandardMaterial({
      color: preset.iffTrimHex,
      emissive: preset.iffEmissiveHex,
      emissiveIntensity: preset.iffEmissiveIntensity,
      roughness: 0.42,
      metalness: 0.15,
    });
    const gunMat = new THREE.MeshStandardMaterial({
      color: 0x191b1f,
      roughness: 0.44,
      metalness: 0.72,
    });
    const gunAccentMat = new THREE.MeshStandardMaterial({
      color: 0x2c2f34,
      roughness: 0.56,
      metalness: 0.42,
    });
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffe08a,
      transparent: true,
      opacity: 0.94,
    });
    const laserMat = new THREE.MeshBasicMaterial({
      color: uniformId === 'team_b' ? 0xf97316 : 0x22c55e,
      transparent: true,
      opacity: 0.48,
    });
    const lightGlowMat = new THREE.MeshBasicMaterial({
      color: 0xfff8dc,
      transparent: true,
      opacity: 0.88,
    });

    const allMats: THREE.Material[] = [
      sleeveMat,
      pantsMat,
      vestMat,
      pouchMat,
      gloveMat,
      bootMat,
      soleMat,
      knuckleMat,
      hardwareMat,
      helmetMat,
      hoodMat,
      skinMat,
      visorMat,
      iffTrimMat,
      gunMat,
      gunAccentMat,
      flashMat,
      laserMat,
      lightGlowMat,
    ];

    const bundle: TacticalUniformMaterialBundle = {
      id: uniformId,
      sleeveMat,
      pantsMat,
      vestMat,
      pouchMat,
      gloveMat,
      bootMat,
      soleMat,
      knuckleMat,
      hardwareMat,
      helmetMat,
      hoodMat,
      skinMat,
      visorMat,
      iffTrimMat,
      gunMat,
      gunAccentMat,
      flashMat,
      laserMat,
      lightGlowMat,
      dispose: () => {
        for (const m of allMats) m.dispose();
        for (const t of texSets) {
          t.map.dispose();
          t.normalMap.dispose();
          t.roughnessMap.dispose();
        }
      },
    };

    this.bundles.set(uniformId, bundle);
    return bundle;
  }

  public dispose(): void {
    for (const bundle of this.bundles.values()) {
      bundle.dispose();
    }
    this.bundles.clear();
  }
}

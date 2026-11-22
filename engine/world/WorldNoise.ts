import { BiomeId } from '../types';

export const WATER_LEVEL = -0.35;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer 2D spatial hash -> [0, 1) */
export function hash2DInt(seed: number, ix: number, iz: number): number {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function hashChunk(worldSeed: number, chunkX: number, chunkZ: number, salt = 0): number {
  let h = (worldSeed ^ Math.imul(chunkX + 73856093, 19349663) ^ Math.imul(chunkZ - 83492791, 83492791) ^ Math.imul(salt, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function valueNoise2D(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2DInt(seed, ix, iz);
  const b = hash2DInt(seed, ix + 1, iz);
  const c = hash2DInt(seed, ix, iz + 1);
  const d = hash2DInt(seed, ix + 1, iz + 1);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

export function fbm2D(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(x * freq, z * freq, seed + i * 101);
    norm += amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export function ridgedFbm2D(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, z * freq, seed + i * 131);
    const ridge = 1.0 - Math.abs(n * 2.0 - 1.0);
    sum += amp * ridge * ridge;
    norm += amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum / norm;
}

export interface TerrainBaseSample {
  rawHeight: number;
  biome: BiomeId;
  moisture: number;
  temperature: number;
  riverFactor: number;
  lakeFactor: number;
  oasisFactor: number;
  mountainFactor: number;
  isWater: boolean;
}

/**
 * Evaluates deterministic world-space landforms & biomes:
 * plains, forest_valley, mountains, rivers, lakes, ponds, ocean, swamps, desert, oasis.
 */
export function sampleTerrainBase(worldSeed: number, wx: number, wz: number): TerrainBaseSample {
  const distOrigin = Math.hypot(wx, wz);
  // Safe plains/clearing envelope near (0,0) so wake-up spawn & starter road/POI stay dry and gentle
  const starterBlend = smoothstep(70, 145, distOrigin);

  // Domain warp coordinates for natural organic biome boundaries
  const warpX = (fbm2D(wx * 0.0028, wz * 0.0028, worldSeed + 17, 2) - 0.5) * 90;
  const warpZ = (fbm2D(wx * 0.0028 + 31.7, wz * 0.0028 - 19.3, worldSeed + 29, 2) - 0.5) * 90;
  const sx = wx + warpX;
  const sz = wz + warpZ;

  // Macro climate fields
  const rawCont = fbm2D(sx * 0.0014, sz * 0.0014, worldSeed + 101, 3);
  const continentalness = lerp(0.66, rawCont, starterBlend);

  const rawTemp = fbm2D(sx * 0.0019 + 12.1, sz * 0.0019 + 7.4, worldSeed + 203, 3);
  const temperature = lerp(0.45, rawTemp, starterBlend);

  const rawMoist = fbm2D(sx * 0.0021 - 5.3, sz * 0.0021 + 19.8, worldSeed + 307, 3);
  const moisture = lerp(0.55, rawMoist, starterBlend);

  // Broad valleys vs rolling plains vs ridged mountains
  const rawRidgeCtrl = fbm2D(sx * 0.0024 + 4.0, sz * 0.0024 - 8.0, worldSeed + 409, 3);
  const mountainFactor = smoothstep(0.58, 0.78, rawRidgeCtrl) * starterBlend;
  const valleyMask = smoothstep(0.42, 0.22, rawRidgeCtrl);

  const hillDetail = (fbm2D(wx * 0.011, wz * 0.011, worldSeed + 503, 4) - 0.45) * 3.8;
  const microBump = (fbm2D(wx * 0.045, wz * 0.045, worldSeed + 607, 2) - 0.5) * 0.55;

  // Mountain elevation using ridged multifractal
  const mountainRidge = ridgedFbm2D(wx * 0.0065, wz * 0.0065, worldSeed + 709, 4);
  const mountainHeight = mountainFactor * (3.5 + mountainRidge * 19.5);

  // Desert dunes (wind-aligned sinusoidal + noise ridges)
  const isDesertClimate = temperature > 0.62 && moisture < 0.44;
  const desertBlend = smoothstep(0.60, 0.70, temperature) * smoothstep(0.46, 0.36, moisture) * starterBlend;

  const dunePhase = wx * 0.065 + wz * 0.032 + fbm2D(wx * 0.012, wz * 0.012, worldSeed + 811, 2) * 3.8;
  const duneWave = (1.0 - Math.abs(Math.sin(dunePhase))) * 2.6 + fbm2D(wx * 0.015, wz * 0.015, worldSeed + 823, 2) * 1.4;

  // Desert Oasis pockets: quantized 180m cells inside desert climate
  let oasisFactor = 0;
  let oasisDepression = 0;
  if (desertBlend > 0.25) {
    const cellSize = 180;
    const gx = Math.floor(wx / cellSize);
    const gz = Math.floor(wz / cellSize);
    const cellSeed = hash2DInt(worldSeed + 919, gx, gz);
    if (cellSeed > 0.58) {
      const ox = (gx + 0.28 + hash2DInt(worldSeed + 929, gx, gz) * 0.44) * cellSize;
      const oz = (gz + 0.28 + hash2DInt(worldSeed + 937, gx, gz) * 0.44) * cellSize;
      const dOasis = Math.hypot(wx - ox, wz - oz);
      oasisFactor = smoothstep(26, 8, dOasis) * desertBlend;
      const pool = smoothstep(13, 4, dOasis);
      oasisDepression = pool * 1.75;
    }
  }

  // Swamp lowlands
  const swampBlend =
    smoothstep(0.60, 0.72, moisture) *
    smoothstep(0.42, 0.56, continentalness) *
    (1 - mountainFactor) *
    starterBlend;
  const swampPoolNoise = fbm2D(wx * 0.024, wz * 0.024, worldSeed + 1013, 3);
  const swampHeight = -0.05 + (swampPoolNoise - 0.52) * 1.45;

  // Ocean shelf (low continentalness)
  const oceanFactor = smoothstep(0.32, 0.18, continentalness) * starterBlend;

  // Winding Rivers (domain-warped contour line)
  const riverNoise = fbm2D(wx * 0.0022 + 17.5, wz * 0.0022 - 11.2, worldSeed + 1103, 3);
  const riverDist = Math.abs(riverNoise - 0.5);
  const riverMask =
    smoothstep(0.036, 0.008, riverDist) *
    (1 - mountainFactor * 0.85) *
    (1 - oceanFactor) *
    starterBlend;

  // Lakes & Small Ponds
  const lakeNoise = fbm2D(wx * 0.0055 - 9.1, wz * 0.0055 + 4.3, worldSeed + 1201, 3);
  const pondNoise = fbm2D(wx * 0.022 + 2.7, wz * 0.022 - 6.4, worldSeed + 1217, 2);
  const lakeFactor = Math.max(
    smoothstep(0.24, 0.15, lakeNoise) * (1 - desertBlend * 0.85),
    smoothstep(0.21, 0.12, pondNoise) * (1 - desertBlend) * 0.85,
  ) * (1 - mountainFactor) * starterBlend;

  // Combine base height
  let baseH = 0.85 + hillDetail * (1 - valleyMask * 0.45) + microBump;
  if (valleyMask > 0.01) {
    baseH -= valleyMask * 0.65;
  }

  // Blend in desert dunes
  baseH = lerp(baseH, 1.05 + duneWave, desertBlend);
  // Carve oasis basin in desert
  baseH -= oasisDepression;
  // Blend in swamp
  baseH = lerp(baseH, swampHeight, swampBlend);
  // Add mountains
  baseH += mountainHeight;
  // Carve rivers, lakes, ponds
  baseH -= riverMask * 1.65;
  baseH -= lakeFactor * 1.45;
  // Drop into ocean shelf
  baseH = lerp(baseH, -2.6 + microBump * 0.4, oceanFactor);

  // Determine canonical BiomeId
  let biome: BiomeId = 'plains';
  if (oceanFactor > 0.55 || baseH < -1.45) {
    biome = 'ocean';
  } else if (oasisFactor > 0.25) {
    biome = 'oasis';
  } else if (mountainFactor > 0.45) {
    biome = 'mountains';
  } else if (swampBlend > 0.45) {
    biome = 'swamp';
  } else if (desertBlend > 0.45 || isDesertClimate) {
    biome = 'desert';
  } else if (moisture > 0.5 || valleyMask > 0.35) {
    biome = 'forest_valley';
  }

  return {
    rawHeight: baseH,
    biome,
    moisture,
    temperature,
    riverFactor: riverMask,
    lakeFactor,
    oasisFactor,
    mountainFactor,
    isWater: baseH < WATER_LEVEL,
  };
}

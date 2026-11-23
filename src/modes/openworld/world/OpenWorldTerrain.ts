import type { OpenWorldBiomeId, PmcFactionId, SubFactionId } from '../types';

export const WORLD_SIZE_M = 4096;
export const WORLD_HALF_M = WORLD_SIZE_M * 0.5; // 2048m
export const CHUNK_SIZE_M = 256;
export const WORLD_GRID_CHUNKS = WORLD_SIZE_M / CHUNK_SIZE_M; // 16 x 16
export const SEA_LEVEL_M = 0.0;
export const RESERVOIR_LEVEL_M = 306.0;
export const WORLD_SEED = 40961337;

export interface BiomeMetaSpec {
  readonly id: OpenWorldBiomeId;
  readonly name: string;
  readonly shortName: string;
  readonly elevationRangeLabel: string;
  readonly minElevationM: number;
  readonly maxElevationM: number;
  readonly tacticalRole: string;
  readonly accentHex: string;
}

export const OPENWORLD_BIOMES: Readonly<Record<OpenWorldBiomeId, BiomeMetaSpec>> = {
  coastal_port_marsh: {
    id: 'coastal_port_marsh',
    name: 'Coastal Port & Marsh Delta',
    shortName: 'Coastal Port',
    elevationRangeLabel: '0m – 15m',
    minElevationM: 0,
    maxElevationM: 15,
    tacticalRole: 'Patrol boat insertion, amphibious flanking, close-quarters container fights.',
    accentHex: '#38bdf8',
  },
  temperate_conifer_valley: {
    id: 'temperate_conifer_valley',
    name: 'Temperate Conifer & Pine Valley',
    shortName: 'Conifer Valley',
    elevationRangeLabel: '15m – 120m',
    minElevationM: 15,
    maxElevationM: 120,
    tacticalRole: 'Infantry ambush corridors, convoy roadblocks, medium-range engagements.',
    accentHex: '#4ade80',
  },
  highland_steppe_quarry: {
    id: 'highland_steppe_quarry',
    name: 'Highland Steppe & Quarry Plateaus',
    shortName: 'Highland Quarry',
    elevationRangeLabel: '120m – 260m',
    minElevationM: 120,
    maxElevationM: 260,
    tacticalRole: 'Long-range DMR/sniper sightlines, armored maneuver warfare, convoy intercepts.',
    accentHex: '#f59e0b',
  },
  alpine_ridge_dam: {
    id: 'alpine_ridge_dam',
    name: 'Alpine Ridge & Dam Reservoir',
    shortName: 'Alpine Dam',
    elevationRangeLabel: '260m – 450m+',
    minElevationM: 260,
    maxElevationM: 465,
    tacticalRole: 'Fortified bunkers, helicopter insertion valleys, high-risk loot vaults.',
    accentHex: '#e2e8f0',
  },
} as const;

export interface OpenWorldLandmarkSpec {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly biomeId: OpenWorldBiomeId;
  readonly worldX: number;
  readonly worldZ: number;
  readonly padRadiusM: number;
  readonly targetElevationM: number;
  readonly kind: 'port' | 'railyard' | 'quarry' | 'radar' | 'dam' | 'fob_alpha' | 'fob_bravo';
  readonly subFactionId?: SubFactionId;
  readonly pmcFactionId?: PmcFactionId;
  readonly summary: string;
}

export const OPENWORLD_LANDMARKS: readonly OpenWorldLandmarkSpec[] = [
  {
    id: 'landmark_port_terminal',
    name: 'Delta Container Terminal & Drydock',
    shortLabel: 'Coastal Port',
    biomeId: 'coastal_port_marsh',
    worldX: -540,
    worldZ: 1260,
    padRadiusM: 160,
    targetElevationM: 4.5,
    kind: 'port',
    subFactionId: 'dockworkers_syndicate',
    summary: 'Gantry cranes, stacked shipping containers, and Syndicate maritime drydocks.',
  },
  {
    id: 'landmark_fob_alpha',
    name: 'PMC Alpha Forward Base',
    shortLabel: 'Alpha FOB',
    biomeId: 'temperate_conifer_valley',
    worldX: -1120,
    worldZ: 680,
    padRadiusM: 110,
    targetElevationM: 32,
    kind: 'fob_alpha',
    pmcFactionId: 'pmc_alpha',
    summary: 'PMC Alpha surgical medbay, helipad, and coastal highway staging yard.',
  },
  {
    id: 'landmark_timberline_railyard',
    name: 'Timberline Rail Yard & River Bridge',
    shortLabel: 'Conifer Valley',
    biomeId: 'temperate_conifer_valley',
    worldX: -160,
    worldZ: 240,
    padRadiusM: 130,
    targetElevationM: 58,
    kind: 'railyard',
    summary: 'Freight depot and logging road junction inside the central pine valley.',
  },
  {
    id: 'landmark_steppe_quarry',
    name: 'Steppe Open-Pit Quarry & Radar Array',
    shortLabel: 'Highland Quarry',
    biomeId: 'highland_steppe_quarry',
    worldX: 480,
    worldZ: -380,
    padRadiusM: 155,
    targetElevationM: 178,
    kind: 'quarry',
    subFactionId: 'highland_militia',
    summary: 'Terraced limestone quarry benches overlooked by twin concrete radar dishes.',
  },
  {
    id: 'landmark_fob_bravo',
    name: 'PMC Bravo Highland Outpost',
    shortLabel: 'Bravo FOB',
    biomeId: 'highland_steppe_quarry',
    worldX: 1160,
    worldZ: -640,
    padRadiusM: 110,
    targetElevationM: 214,
    kind: 'fob_bravo',
    pmcFactionId: 'pmc_bravo',
    summary: 'PMC Bravo trauma clinic, armor motorpool, and steppe artillery overlook.',
  },
  {
    id: 'landmark_alpine_dam',
    name: 'Korsakov Hydroelectric Dam & Reservoir',
    shortLabel: 'Alpine Dam',
    biomeId: 'alpine_ridge_dam',
    worldX: 180,
    worldZ: -1360,
    padRadiusM: 140,
    targetElevationM: 318,
    kind: 'dam',
    subFactionId: 'alpine_remnant',
    summary: 'Concrete arch dam, mountain spillway, and snow-dusted Remnant bunkers.',
  },
] as const;

export interface TerrainSample {
  height: number;
  biome: OpenWorldBiomeId;
  slope: number;
  isWater: boolean;
  isReservoir: boolean;
  isRoad: boolean;
  isQuarryPit: boolean;
  r: number;
  g: number;
  b: number;
}

export function createTerrainSample(): TerrainSample {
  return {
    height: 0,
    biome: 'temperate_conifer_valley',
    slope: 0,
    isWater: false,
    isReservoir: false,
    isRoad: false,
    isQuarryPit: false,
    r: 0.3,
    g: 0.35,
    b: 0.25,
  };
}

// ============================================================================
// DETERMINISTIC NOISE PRIMITIVES (Zero-allocation)
// ============================================================================

function hash2D(seed: number, ix: number, iz: number): number {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

export function chunkHash(cx: number, cz: number, salt = 0): number {
  let h =
    (WORLD_SEED ^
      Math.imul(cx + 73856093, 19349663) ^
      Math.imul(cz - 83492791, 83492791) ^
      Math.imul(salt, 2654435761)) |
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

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

function valueNoise2D(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2D(seed, ix, iz);
  const b = hash2D(seed, ix + 1, iz);
  const c = hash2D(seed, ix, iz + 1);
  const d = hash2D(seed, ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2D(x: number, z: number, seed: number, octaves: number): number {
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

function ridgedFbm2D(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, z * freq, seed + i * 137);
    const r = 1.0 - Math.abs(n * 2.0 - 1.0);
    sum += amp * r * r;
    norm += amp;
    freq *= 2.08;
    amp *= 0.5;
  }
  return sum / norm;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const denom = e1 - e0;
  if (Math.abs(denom) < 1e-6) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / denom));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ============================================================================
// CHUNK GRID HELPERS (16 x 16 chunks of 256m x 256m = 4,096m x 4,096m)
// ============================================================================

export function worldToChunkCoord(worldPos: number): number {
  const idx = Math.floor((worldPos + WORLD_HALF_M) / CHUNK_SIZE_M);
  return Math.max(0, Math.min(WORLD_GRID_CHUNKS - 1, idx));
}

export function chunkCoordToWorldCenter(chunkIndex: number): number {
  return -WORLD_HALF_M + (chunkIndex + 0.5) * CHUNK_SIZE_M;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function isValidChunkCoord(cx: number, cz: number): boolean {
  return cx >= 0 && cx < WORLD_GRID_CHUNKS && cz >= 0 && cz < WORLD_GRID_CHUNKS;
}

// ============================================================================
// HIGHWAY & RIVER CORRIDOR DISTANCE HELPERS
// ============================================================================

function highwayCenterXAtZ(z: number): number {
  // Sweeping N-S tactical highway from Coastal Port (-540, 1260) -> Rail Yard (-160, 240)
  // -> Steppe Quarry (480, -380) -> Alpine Dam approach (180, -1360)
  const t = (1400 - z) / 2800; // 0 in south, 1 in north
  return -520 + 980 * smoothstep(0.05, 0.72, t) - 280 * smoothstep(0.68, 1.0, t) + Math.sin(z * 0.0022) * 95;
}

function riverCenterXAtZ(z: number): number {
  // Mountain river descending from the Dam spillway (180, -1360) through Conifer Valley to Coastal Marsh
  return 180 - smoothstep(-1360, 1400, z) * 520 + Math.sin(z * 0.0031) * 145;
}

// ============================================================================
// AUTHORITATIVE 4-BIOME HEIGHTFIELD EVALUATOR
// ============================================================================

/**
 * Evaluates raw ground height (in meters) at world coordinate `(x, z)` across the 4km × 4km theater.
 * Stratifies cleanly across the 4 ecological elevation bands:
 *   1. Coastal Port & Marsh Delta:       0m – 15m
 *   2. Temperate Conifer & Pine Valley: 15m – 120m
 *   3. Highland Steppe & Quarry:       120m – 260m
 *   4. Alpine Ridge & Dam Reservoir:   260m – 450m+
 */
export function evaluateOpenWorldHeight(x: number, z: number): number {
  // Clamp evaluation gently beyond the 4km border for outer horizon skirts
  const cx = Math.max(-WORLD_HALF_M - 256, Math.min(WORLD_HALF_M + 256, x));
  const cz = Math.max(-WORLD_HALF_M - 256, Math.min(WORLD_HALF_M + 256, z));

  // South-to-North macro elevation axis:
  // z = +2048 (South Coast, 0m) -> z = -2048 (North Alpine Peaks, 450m+)
  const northT = smoothstep(1550, -1850, cz); // 0 in deep south, 1 in far north
  const eastBias = (cx / WORLD_HALF_M) * 0.06;
  const macroT = Math.max(0, Math.min(1, northT + eastBias));

  // Piece-wise smooth macro profile matching the 4 elevation bands:
  //   0.00–0.22 -> Coastal Port & Marsh (0..14m)
  //   0.22–0.52 -> Temperate Conifer Valley (15..118m)
  //   0.52–0.78 -> Highland Steppe Plateau (120..255m)
  //   0.78–1.00 -> Alpine Ridge Peaks (260..445m)
  let baseH = 0;
  if (macroT < 0.22) {
    baseH = lerp(-3.5, 13.5, smoothstep(0.0, 0.22, macroT));
  } else if (macroT < 0.52) {
    baseH = lerp(13.5, 118.0, smoothstep(0.22, 0.52, macroT));
  } else if (macroT < 0.78) {
    baseH = lerp(118.0, 256.0, smoothstep(0.52, 0.78, macroT));
  } else {
    baseH = lerp(256.0, 415.0, smoothstep(0.78, 1.0, macroT));
  }

  // Multi-scale organic terrain relief scaled by biome band
  const rolling = (fbm2D(cx * 0.0014, cz * 0.0014, WORLD_SEED + 17, 4) - 0.5) * 2.0;
  const detail = (fbm2D(cx * 0.0055, cz * 0.0055, WORLD_SEED + 73, 3) - 0.5) * 2.0;
  const ridge = ridgedFbm2D(cx * 0.0019, cz * 0.0019, WORLD_SEED + 211, 4);

  const valleyWeight = smoothstep(0.16, 0.30, macroT) * (1 - smoothstep(0.48, 0.62, macroT));
  const steppeWeight = smoothstep(0.48, 0.60, macroT) * (1 - smoothstep(0.74, 0.86, macroT));
  const alpineWeight = smoothstep(0.70, 0.88, macroT);
  const coastalWeight = 1 - smoothstep(0.14, 0.28, macroT);

  let h = baseH;
  // Coastal tidal channels & marsh islets
  h += coastalWeight * (rolling * 4.5 + detail * 1.4);
  // Conifer valley forested ridges & gullies
  h += valleyWeight * (rolling * 26.0 + detail * 4.2 + (ridge - 0.35) * 18.0);
  // Highland steppe broad terraced mesas
  h += steppeWeight * (rolling * 22.0 + detail * 3.5 + (ridge - 0.4) * 20.0);
  // Alpine sharp granite peaks reaching 450m+
  h += alpineWeight * (ridge * 110.0 - 24.0 + rolling * 24.0 + detail * 6.5);

  // Carve central river channel below the dam down to the coastal estuary
  if (cz > -1340) {
    const rx = riverCenterXAtZ(cz);
    const distR = Math.abs(cx - rx);
    const riverWidth = lerp(28, 72, smoothstep(-1300, 1400, cz));
    if (distR < riverWidth * 2.2) {
      const riverCut = 1.0 - smoothstep(riverWidth * 0.38, riverWidth * 2.1, distR);
      const carveDepth = lerp(26.0, 7.5, smoothstep(-1300, 1300, cz));
      h -= riverCut * carveDepth;
    }
  }

  // Open-pit terraced quarry basin near Highland Quarry (480, -380)
  const qdx = cx - 640;
  const qdz = cz - -340;
  const qDist = Math.hypot(qdx, qdz);
  if (qDist < 195) {
    const pitFactor = 1.0 - smoothstep(55, 195, qDist);
    // Quantize into 4 quarry benches
    const rawCut = pitFactor * 42.0;
    const steppedCut = Math.floor(rawCut / 9.5) * 9.5 + (rawCut % 9.5) * 0.28;
    h -= steppedCut;
  }

  // Alpine Dam Reservoir basin behind the dam wall (north of z = -1395 around x = 180)
  const resDx = (cx - 180) / 360;
  const resDz = (cz - -1620) / 215;
  const resR = Math.hypot(resDx, resDz);
  if (resR < 1.15 && cz < -1375) {
    const basinFactor = 1.0 - smoothstep(0.45, 1.15, resR);
    h = lerp(h, RESERVOIR_LEVEL_M - 18.0, basinFactor * 0.88);
  }

  // Southern coastline ocean drop-off (z > 1580)
  if (cz > 1480) {
    const seaDrop = smoothstep(1480, 1920, cz);
    h = lerp(h, -9.0, seaDrop);
  }

  // Gentle flattening pads for major named landmarks so structures sit cleanly grounded
  for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
    const lm = OPENWORLD_LANDMARKS[i];
    const dist = Math.hypot(cx - lm.worldX, cz - lm.worldZ);
    const outer = lm.padRadiusM * 1.65;
    if (dist < outer) {
      const blend = 1.0 - smoothstep(lm.padRadiusM * 0.55, outer, dist);
      h = lerp(h, lm.targetElevationM, blend * 0.92);
    }
  }

  // Natural perimeter alpine cliff wall along northern edge so world never ends in an abrupt drop
  const edgeX = Math.abs(cx) - (WORLD_HALF_M - 160);
  if (edgeX > 0 && cz < 1100) {
    const wallT = smoothstep(0, 160, edgeX);
    h += wallT * lerp(18, 85, macroT);
  }

  return h;
}

export function classifyOpenWorldBiome(height: number, z: number): OpenWorldBiomeId {
  if (height < 15.0 || (z > 1180 && height < 22.0)) {
    return 'coastal_port_marsh';
  }
  if (height < 120.0) {
    return 'temperate_conifer_valley';
  }
  if (height < 260.0) {
    return 'highland_steppe_quarry';
  }
  return 'alpine_ridge_dam';
}

/**
 * Full zero-allocation terrain & biome sample at `(x, z)`.
 * Writes into `out` if supplied (required for hot paths & chunk builders).
 */
export function sampleOpenWorldTerrain(
  x: number,
  z: number,
  out: TerrainSample = createTerrainSample(),
): TerrainSample {
  const h = evaluateOpenWorldHeight(x, z);
  const hx = evaluateOpenWorldHeight(x + 4.0, z);
  const hz = evaluateOpenWorldHeight(x, z + 4.0);
  const dx = (hx - h) * 0.25;
  const dz = (hz - h) * 0.25;
  const slope = Math.min(1, Math.hypot(dx, dz));

  const biome = classifyOpenWorldBiome(h, z);
  const isReservoir = z < -1375 && Math.hypot((x - 180) / 360, (z + 1620) / 215) < 1.0 && h < RESERVOIR_LEVEL_M;
  const isWater = h <= SEA_LEVEL_M || isReservoir;

  const hwDist = Math.abs(x - highwayCenterXAtZ(z));
  const isRoad = !isWater && z > -1360 && z < 1340 && hwDist < 7.5 && slope < 0.42;
  const isQuarryPit = Math.hypot(x - 640, z + 340) < 185;

  // Deterministic biome PBR albedo tinting (vertex colors blended with procedural detail texture)
  let r = 0.26;
  let g = 0.31;
  let b = 0.22;

  if (isRoad) {
    r = 0.24;
    g = 0.24;
    b = 0.25;
  } else if (isQuarryPit) {
    // Pale fractured limestone & industrial dust
    r = 0.46;
    g = 0.44;
    b = 0.39;
  } else if (biome === 'coastal_port_marsh') {
    if (h < 1.8) {
      // Wet estuarine silt & sand
      r = 0.33;
      g = 0.31;
      b = 0.26;
    } else {
      // Marsh reed turf & weathered concrete gravel
      r = 0.27;
      g = 0.32;
      b = 0.23;
    }
  } else if (biome === 'temperate_conifer_valley') {
    const pineFloor = smoothstep(15, 115, h);
    r = lerp(0.21, 0.25, pineFloor);
    g = lerp(0.31, 0.29, pineFloor);
    b = lerp(0.18, 0.19, pineFloor);
  } else if (biome === 'highland_steppe_quarry') {
    const aridT = smoothstep(120, 255, h);
    r = lerp(0.36, 0.43, aridT);
    g = lerp(0.35, 0.38, aridT);
    b = lerp(0.24, 0.27, aridT);
  } else {
    // Alpine granite -> snow-dusted ridge above 335m (unless sheer cliff)
    const snowT = smoothstep(322, 372, h) * (1.0 - smoothstep(0.45, 0.72, slope));
    r = lerp(0.34, 0.84, snowT);
    g = lerp(0.36, 0.87, snowT);
    b = lerp(0.38, 0.91, snowT);
  }

  // Expose rock strata on steep cliffs across all biomes
  if (slope > 0.38 && !isRoad) {
    const rockT = smoothstep(0.38, 0.68, slope);
    r = lerp(r, 0.33, rockT);
    g = lerp(g, 0.34, rockT);
    b = lerp(b, 0.35, rockT);
  }

  out.height = h;
  out.biome = biome;
  out.slope = slope;
  out.isWater = isWater;
  out.isReservoir = isReservoir;
  out.isRoad = isRoad;
  out.isQuarryPit = isQuarryPit;
  out.r = r;
  out.g = g;
  out.b = b;
  return out;
}

export function getNearestLandmark(x: number, z: number): {
  landmark: OpenWorldLandmarkSpec;
  distanceM: number;
} {
  let best = OPENWORLD_LANDMARKS[0];
  let bestDist = Infinity;
  for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
    const lm = OPENWORLD_LANDMARKS[i];
    const d = Math.hypot(x - lm.worldX, z - lm.worldZ);
    if (d < bestDist) {
      bestDist = d;
      best = lm;
    }
  }
  return { landmark: best, distanceM: bestDist };
}

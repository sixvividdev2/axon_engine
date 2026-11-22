import { POI_TEMPLATES, PoiTemplateId } from '../../data/poiTemplates';
import { BiomeId } from '../types';
import { hash2DInt, mulberry32, sampleTerrainBase, WATER_LEVEL } from './WorldNoise';

export const CHUNK_SIZE = 64;
export const MACRO_BLOCK_SIZE = 192; // 3 chunks
export const PRIMARY_ROAD_X_OFFSET = -14;
export const PRIMARY_ROAD_Z_OFFSET = -128;

export interface RoadQueryResult {
  onAsphalt: boolean;
  onShoulder: boolean;
  isBridgeCauseway: boolean;
  roadInfluence: number; // 0..1 terrain flatten factor
  roadY: number;
  nearestPrimaryDist: number;
  isPrimaryNS: boolean;
  isPrimaryEW: boolean;
  centerlineDist: number;
}

export interface PoiPlacement {
  id: string;
  templateId: PoiTemplateId;
  centerX: number;
  centerZ: number;
  baseY: number;
  /** 0 = faces -X, 1 = faces +Z, 2 = faces +X, 3 = faces -Z (counter-clockwise 90 deg steps) */
  rotQuarterTurns: 0 | 1 | 2 | 3;
  halfW: number;
  halfD: number;
  padMargin: number;
  isStarterPoi?: boolean;
}

interface StreetSegment {
  axis: 'x' | 'z';
  coord: number; // x if axis='z' (runs N-S), z if axis='x' (runs E-W)
  minSpan: number;
  maxSpan: number;
  halfWidth: number;
  shoulderWidth: number;
  blendWidth: number;
}

interface MacroBlockData {
  bx: number;
  bz: number;
  isTownCluster: boolean;
  secondaryStreets: StreetSegment[];
  pois: PoiPlacement[];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function rotateLocalOffset(
  lx: number,
  lz: number,
  turns: 0 | 1 | 2 | 3,
): { x: number; z: number } {
  switch (turns) {
    case 0:
      return { x: lx, z: lz };
    case 1:
      return { x: lz, z: -lx };
    case 2:
      return { x: -lx, z: -lz };
    case 3:
      return { x: -lz, z: lx };
  }
}

export function rotateBoxExtents(w: number, d: number, turns: 0 | 1 | 2 | 3): { w: number; d: number } {
  return turns % 2 === 0 ? { w, d } : { w: d, d: w };
}

export class RoadNetwork {
  public readonly worldSeed: number;
  private blockCache = new Map<string, MacroBlockData>();

  constructor(worldSeed: number) {
    this.worldSeed = worldSeed;
  }

  private getMacroBlockCoords(wx: number, wz: number): { bx: number; bz: number } {
    const bx = Math.floor((wx - PRIMARY_ROAD_X_OFFSET) / MACRO_BLOCK_SIZE);
    const bz = Math.floor((wz - PRIMARY_ROAD_Z_OFFSET) / MACRO_BLOCK_SIZE);
    return { bx, bz };
  }

  public getMacroBlock(bx: number, bz: number): MacroBlockData {
    const key = `${bx},${bz}`;
    const existing = this.blockCache.get(key);
    if (existing) return existing;

    const x0 = bx * MACRO_BLOCK_SIZE + PRIMARY_ROAD_X_OFFSET;
    const z0 = bz * MACRO_BLOCK_SIZE + PRIMARY_ROAD_Z_OFFSET;
    const x1 = x0 + MACRO_BLOCK_SIZE;
    const z1 = z0 + MACRO_BLOCK_SIZE;

    const blockSeed =
      (this.worldSeed ^ Math.imul(bx + 193, 73856093) ^ Math.imul(bz - 97, 83492791)) >>> 0;
    const rand = mulberry32(blockSeed);

    const centerSample = sampleTerrainBase(this.worldSeed, x0 + MACRO_BLOCK_SIZE * 0.5, z0 + MACRO_BLOCK_SIZE * 0.5);
    const suitableForTown =
      centerSample.biome !== 'ocean' &&
      centerSample.mountainFactor < 0.42 &&
      centerSample.rawHeight > WATER_LEVEL + 0.15;

    // ~22% of suitable macro-blocks form Town Clusters
    const isStarterBlock = bx === 0 && bz === 0;
    const isTownCluster = !isStarterBlock && suitableForTown && hash2DInt(this.worldSeed + 551, bx, bz) < 0.24;

    const secondaryStreets: StreetSegment[] = [];
    const pois: PoiPlacement[] = [];

    const tryPlacePoi = (
      id: string,
      templateId: PoiTemplateId,
      cx: number,
      cz: number,
      turns: 0 | 1 | 2 | 3,
      isStarterPoi = false,
    ): boolean => {
      const tpl = POI_TEMPLATES[templateId];
      const ext = rotateBoxExtents(tpl.footprintWidth, tpl.footprintDepth, turns);
      const halfW = ext.w * 0.5;
      const halfD = ext.d * 0.5;

      // Keep inside block borders (clear of primary highways)
      if (cx - halfW < x0 + 9 || cx + halfW > x1 - 9 || cz - halfD < z0 + 9 || cz + halfD > z1 - 9) {
        return false;
      }

      // Check secondary street clearance
      for (const st of secondaryStreets) {
        if (st.axis === 'z') {
          if (Math.abs(cx - st.coord) < halfW + st.shoulderWidth + 1.5) return false;
        } else {
          if (Math.abs(cz - st.coord) < halfD + st.shoulderWidth + 1.5) return false;
        }
      }

      // Check overlap with existing POIs in block
      for (const other of pois) {
        if (
          Math.abs(cx - other.centerX) < halfW + other.halfW + 6 &&
          Math.abs(cz - other.centerZ) < halfD + other.halfD + 6
        ) {
          return false;
        }
      }

      const tSample = sampleTerrainBase(this.worldSeed, cx, cz);
      if (!isStarterPoi && (tSample.biome === 'ocean' || tSample.mountainFactor > 0.55)) {
        return false;
      }

      const roadRefY = this.computeRoadHeightRaw(cx, cz);
      const baseY = Math.max(WATER_LEVEL + 0.58, isStarterPoi ? 0.0 : lerp(tSample.rawHeight, roadRefY, 0.72));

      pois.push({
        id,
        templateId,
        centerX: cx,
        centerZ: cz,
        baseY,
        rotQuarterTurns: turns,
        halfW,
        halfD,
        padMargin: tpl.padMargin,
        isStarterPoi,
      });
      return true;
    };

    if (isStarterBlock) {
      // Starter clearing & roadside POIs matching wake-up sightline
      tryPlacePoi('poi_starter_house', 'abandoned_house', 8.0, -2.5, 0, true);
      tryPlacePoi('poi_starter_checkpoint', 'roadside_checkpoint', -2.5, -36.0, 0, true);
      // Deeper exploration POIs in starter macro-block
      tryPlacePoi('poi_starter_store', 'corner_store', 64.0, 46.0, 1, false);
      tryPlacePoi('poi_starter_bunker', 'concrete_bunker', 112.0, -48.0, 2, false);
      tryPlacePoi('poi_starter_garage', 'industrial_garage', 156.0, 12.0, 2, false);
    } else if (isTownCluster) {
      // Secondary neighborhood / industrial streets connecting primary highways
      const streetX = x0 + (rand() < 0.5 ? 64 : 96);
      const streetZ = z0 + 96;
      secondaryStreets.push(
        {
          axis: 'z',
          coord: streetX,
          minSpan: z0,
          maxSpan: z1,
          halfWidth: 2.8,
          shoulderWidth: 4.1,
          blendWidth: 8.5,
        },
        {
          axis: 'x',
          coord: streetZ,
          minSpan: x0,
          maxSpan: x1,
          halfWidth: 2.8,
          shoulderWidth: 4.1,
          blendWidth: 8.5,
        },
      );

      const townPool: PoiTemplateId[] = [
        'corner_store',
        'abandoned_house',
        'abandoned_house',
        'industrial_garage',
        'roadside_checkpoint',
        'concrete_bunker',
      ];

      // Place POIs along the secondary streets & highway corners
      const candidates: Array<{ cx: number; cz: number; turns: 0 | 1 | 2 | 3 }> = [
        { cx: streetX - 15, cz: z0 + 34, turns: 2 },
        { cx: streetX + 15, cz: z0 + 38, turns: 0 },
        { cx: streetX - 15, cz: z0 + 66, turns: 2 },
        { cx: streetX + 16, cz: z0 + 134, turns: 0 },
        { cx: streetX - 15, cz: z0 + 152, turns: 2 },
        { cx: x0 + 34, cz: streetZ - 15, turns: 1 },
        { cx: x0 + 148, cz: streetZ + 15, turns: 3 },
        { cx: x0 + 18, cz: z0 + 48, turns: 0 },
      ];

      let poiIdx = 0;
      for (const c of candidates) {
        if (rand() < 0.78) {
          const tplId = townPool[Math.floor(rand() * townPool.length)];
          tryPlacePoi(`poi_${bx}_${bz}_${poiIdx++}`, tplId, c.cx, c.cz, c.turns);
        }
      }
    } else {
      // Sparse rural roadside POIs along primary highways
      const ruralPool: PoiTemplateId[] = [
        'abandoned_house',
        'roadside_checkpoint',
        'industrial_garage',
        'concrete_bunker',
      ];
      if (rand() < 0.72) {
        const tplId = ruralPool[Math.floor(rand() * ruralPool.length)];
        const cz = z0 + 36 + rand() * 110;
        tryPlacePoi(`poi_${bx}_${bz}_w`, tplId, x0 + 17.5, cz, 0);
      }
      if (rand() < 0.55) {
        const tplId = ruralPool[Math.floor(rand() * ruralPool.length)];
        const cx = x0 + 42 + rand() * 108;
        tryPlacePoi(`poi_${bx}_${bz}_n`, tplId, cx, z0 + 17.5, 3);
      }
    }

    const data: MacroBlockData = { bx, bz, isTownCluster, secondaryStreets, pois };
    this.blockCache.set(key, data);

    // Keep cache bounded cleanly
    if (this.blockCache.size > 128) {
      const oldest = this.blockCache.keys().next().value;
      if (oldest !== undefined) this.blockCache.delete(oldest);
    }
    return data;
  }

  /** Smoothed road deck height (clamped above water so bridges/causeways cross rivers cleanly) */
  private computeRoadHeightRaw(wx: number, wz: number): number {
    if (Math.hypot(wx, wz) < 60) return 0;
    const s0 = sampleTerrainBase(this.worldSeed, wx, wz);
    const s1 = sampleTerrainBase(this.worldSeed, wx + 14, wz + 14);
    const s2 = sampleTerrainBase(this.worldSeed, wx - 14, wz - 14);
    const avg = (s0.rawHeight * 0.5 + s1.rawHeight * 0.25 + s2.rawHeight * 0.25) * 0.72;
    return Math.max(WATER_LEVEL + 0.72, Math.min(8.5, avg));
  }

  public queryRoad(wx: number, wz: number): RoadQueryResult {
    // Primary highways every 192m
    const nearestXIndex = Math.round((wx - PRIMARY_ROAD_X_OFFSET) / MACRO_BLOCK_SIZE);
    const nearestZIndex = Math.round((wz - PRIMARY_ROAD_Z_OFFSET) / MACRO_BLOCK_SIZE);
    const primaryX = nearestXIndex * MACRO_BLOCK_SIZE + PRIMARY_ROAD_X_OFFSET;
    const primaryZ = nearestZIndex * MACRO_BLOCK_SIZE + PRIMARY_ROAD_Z_OFFSET;

    const dxPrimary = Math.abs(wx - primaryX);
    const dzPrimary = Math.abs(wz - primaryZ);

    let minDist = Math.min(dxPrimary, dzPrimary);
    let halfW = 3.7;
    let shoulderW = 5.6;
    let blendW = 12.0;
    let isPrimaryNS = dxPrimary <= dzPrimary && dxPrimary < 8;
    let isPrimaryEW = dzPrimary < dxPrimary && dzPrimary < 8;
    let roadSampleX = dxPrimary <= dzPrimary ? primaryX : wx;
    let roadSampleZ = dzPrimary < dxPrimary ? primaryZ : wz;

    // Check secondary town streets in containing macro-block
    const { bx, bz } = this.getMacroBlockCoords(wx, wz);
    const block = this.getMacroBlock(bx, bz);
    for (const st of block.secondaryStreets) {
      if (st.axis === 'z') {
        if (wz >= st.minSpan && wz <= st.maxSpan) {
          const d = Math.abs(wx - st.coord);
          if (d < minDist) {
            minDist = d;
            halfW = st.halfWidth;
            shoulderW = st.shoulderWidth;
            blendW = st.blendWidth;
            isPrimaryNS = false;
            isPrimaryEW = false;
            roadSampleX = st.coord;
            roadSampleZ = wz;
          }
        }
      } else {
        if (wx >= st.minSpan && wx <= st.maxSpan) {
          const d = Math.abs(wz - st.coord);
          if (d < minDist) {
            minDist = d;
            halfW = st.halfWidth;
            shoulderW = st.shoulderWidth;
            blendW = st.blendWidth;
            isPrimaryNS = false;
            isPrimaryEW = false;
            roadSampleX = wx;
            roadSampleZ = st.coord;
          }
        }
      }
    }

    const onAsphalt = minDist <= halfW;
    const onShoulder = !onAsphalt && minDist <= shoulderW;
    const roadInfluence = 1 - smoothstep(shoulderW, blendW, minDist);
    const roadY = this.computeRoadHeightRaw(roadSampleX, roadSampleZ);
    const baseUnder = sampleTerrainBase(this.worldSeed, wx, wz);
    const isBridgeCauseway = (onAsphalt || onShoulder) && baseUnder.rawHeight < WATER_LEVEL + 0.12;

    return {
      onAsphalt,
      onShoulder,
      isBridgeCauseway,
      roadInfluence,
      roadY,
      nearestPrimaryDist: Math.min(dxPrimary, dzPrimary),
      isPrimaryNS,
      isPrimaryEW,
      centerlineDist: minDist,
    };
  }

  public getPOIsIntersectingChunk(cx: number, cz: number): PoiPlacement[] {
    const cMinX = cx * CHUNK_SIZE;
    const cMaxX = cMinX + CHUNK_SIZE;
    const cMinZ = cz * CHUNK_SIZE;
    const cMaxZ = cMinZ + CHUNK_SIZE;

    const minB = this.getMacroBlockCoords(cMinX - 32, cMinZ - 32);
    const maxB = this.getMacroBlockCoords(cMaxX + 32, cMaxZ + 32);
    const out: PoiPlacement[] = [];

    for (let bx = minB.bx; bx <= maxB.bx; bx++) {
      for (let bz = minB.bz; bz <= maxB.bz; bz++) {
        const block = this.getMacroBlock(bx, bz);
        for (const p of block.pois) {
          const margin = p.padMargin + 4;
          if (
            p.centerX + p.halfW + margin >= cMinX &&
            p.centerX - p.halfW - margin <= cMaxX &&
            p.centerZ + p.halfD + margin >= cMinZ &&
            p.centerZ - p.halfD - margin <= cMaxZ
          ) {
            out.push(p);
          }
        }
      }
    }
    return out;
  }

  public getTerrainHeight(wx: number, wz: number): number {
    const base = sampleTerrainBase(this.worldSeed, wx, wz);
    let h = base.rawHeight;

    const road = this.queryRoad(wx, wz);
    if (road.roadInfluence > 0.001) {
      h = lerp(h, road.roadY, road.roadInfluence);
    }

    // Flatten smoothly beneath POI footprint pads
    const { bx, bz } = this.getMacroBlockCoords(wx, wz);
    const block = this.getMacroBlock(bx, bz);
    for (const p of block.pois) {
      const dx = Math.max(0, Math.abs(wx - p.centerX) - p.halfW);
      const dz = Math.max(0, Math.abs(wz - p.centerZ) - p.halfD);
      const edgeDist = Math.hypot(dx, dz);
      if (edgeDist < p.padMargin) {
        const blend = 1 - smoothstep(0.5, p.padMargin, edgeDist);
        h = lerp(h, p.baseY, blend);
      }
    }

    return h;
  }

  public getBiomeAt(wx: number, wz: number): BiomeId {
    return sampleTerrainBase(this.worldSeed, wx, wz).biome;
  }

  public getStarterSpawn(): { x: number; y: number; z: number; yaw: number } {
    const x = -4.2;
    const z = 16.5;
    return {
      x,
      y: this.getTerrainHeight(x, z),
      z,
      yaw: 0.08,
    };
  }
}

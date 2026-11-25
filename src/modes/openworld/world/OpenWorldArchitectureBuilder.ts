import * as THREE from 'three';
import type { BodycamSurfaceMaterial } from '../../../../bodycam-sdk/types';
import type { DynamicPropSpawnSpec } from '../../../../bodycam-sdk/physics/DynamicPhysicsPropSystem';
import type { GraphicsQualityProfile } from '../../../../data/graphicsQuality';
import { MACRO_OCCLUDER_LAYER } from './OpenWorldAtmosphere';
import {
  applyAtmosphericHeightFog,
  type AtmoFogSharedUniforms,
} from './OpenWorldAtmosphericFogShader';
import {
  BakedHorizonTower,
  BakedOpenWorldSite,
  BakedRiverBridge,
  BakedRoadSegment,
  getBakedHorizonTowers,
  getBakedRiverBridges,
  getBridgesInChunk,
  getRoadSegmentsInChunk,
  getSitesInChunk,
  IndoorVolume,
  SolidObb,
  WalkDeck,
} from './OpenWorldCivilizationTopology';
import {
  CHUNK_SIZE_M,
  chunkHash,
  evaluateOpenWorldHeight,
  mulberry32,
  OPENWORLD_LANDMARKS,
  OpenWorldLandmarkSpec,
  SEA_LEVEL_M,
} from './OpenWorldTerrain';
import {
  FOB_GUARD_TOWER_DECK_HEIGHT_M,
  FobCompoundSpec,
  getFobCompoundsOverlappingRect,
  getFobGuardTowerSpecs,
} from './OpenWorldFobLayout';

// ============================================================================
// PROCEDURAL CANVAS TEXTURES (100% Local, Headless-Node Safe)
// ============================================================================

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  repeatX = 1,
  repeatY = 1,
  aniso = 4,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

function createHighwayAsphaltTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4101);

  // Dark weathered aggregate asphalt base
  ctx.fillStyle = '#2d3034';
  ctx.fillRect(0, 0, 256, 256);

  // Fine mineral grain & aggregate speckle
  for (let i = 0; i < 6500; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    const v = 34 + Math.floor(rand() * 34);
    ctx.fillStyle = `rgb(${v},${v + 1},${v + 2})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Subtle dark wheel-track wear in both lanes
  ctx.fillStyle = 'rgba(15,17,20,0.22)';
  ctx.fillRect(46, 0, 26, 256);
  ctx.fillRect(88, 0, 24, 256);
  ctx.fillRect(144, 0, 24, 256);
  ctx.fillRect(184, 0, 26, 256);

  // Gravel-dusted outer edge shoulders
  ctx.fillStyle = 'rgba(110,104,90,0.34)';
  ctx.fillRect(0, 0, 14, 256);
  ctx.fillRect(242, 0, 14, 256);

  // Crisp weathered white edge lines
  ctx.fillStyle = 'rgba(220,224,220,0.78)';
  ctx.fillRect(18, 0, 5, 256);
  ctx.fillRect(233, 0, 5, 256);

  // Double amber highway centerlines
  ctx.fillStyle = 'rgba(218,162,48,0.88)';
  ctx.fillRect(122, 0, 4, 256);
  ctx.fillRect(130, 0, 4, 256);

  // Tar cracks & weathering patches
  ctx.strokeStyle = 'rgba(18,20,22,0.52)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 14; i++) {
    ctx.beginPath();
    let x = rand() * 256;
    let y = rand() * 256;
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (rand() - 0.5) * 28;
      y += rand() * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  return finalizeTexture(canvas, 1, 1);
}

function createFobSpurTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4102);

  ctx.fillStyle = '#34373b';
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 5800; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    const v = 40 + Math.floor(rand() * 34);
    ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Dusty shoulders
  ctx.fillStyle = 'rgba(116,108,92,0.42)';
  ctx.fillRect(0, 0, 18, 256);
  ctx.fillRect(238, 0, 18, 256);

  // Faded white shoulder stripes
  ctx.fillStyle = 'rgba(205,208,204,0.6)';
  ctx.fillRect(22, 0, 4, 256);
  ctx.fillRect(230, 0, 4, 256);

  // Dashed amber centerline
  ctx.fillStyle = 'rgba(212,158,52,0.82)';
  ctx.fillRect(126, 20, 4, 88);
  ctx.fillRect(126, 148, 4, 88);

  return finalizeTexture(canvas, 1, 1);
}

function createDirtTrailTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4103);

  ctx.fillStyle = '#6f5c46';
  ctx.fillRect(0, 0, 256, 256);

  // Compacted twin wheel ruts
  ctx.fillStyle = '#534332';
  ctx.fillRect(46, 0, 44, 256);
  ctx.fillRect(166, 0, 44, 256);

  // Central grassy/gravel crown
  ctx.fillStyle = 'rgba(92,102,64,0.34)';
  ctx.fillRect(102, 0, 52, 256);

  // Gravel pebbles & earth grain
  for (let i = 0; i < 6200; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    const l = 68 + Math.floor(rand() * 58);
    ctx.fillStyle = `rgb(${l + 14},${l + 2},${Math.max(20, l - 18)})`;
    ctx.fillRect(x, y, 2, 2);
  }

  return finalizeTexture(canvas, 1, 1);
}

function createClapboardWallTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4104);

  ctx.fillStyle = '#d4d0c8';
  ctx.fillRect(0, 0, 256, 256);

  // Horizontal lap siding courses with shadow seams
  const plankH = 16;
  for (let y = 0; y < 256; y += plankH) {
    const shade = 200 + Math.floor((rand() - 0.5) * 18);
    ctx.fillStyle = `rgb(${shade},${shade - 2},${shade - 6})`;
    ctx.fillRect(0, y, 256, plankH - 2);
    ctx.fillStyle = 'rgba(40,42,46,0.38)';
    ctx.fillRect(0, y + plankH - 2, 256, 2);
  }

  // Subtle grime & rain weathering
  for (let i = 0; i < 2400; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    const a = 0.04 + rand() * 0.08;
    ctx.fillStyle = `rgba(45,42,38,${a.toFixed(3)})`;
    ctx.fillRect(x, y, 2, 4);
  }

  return finalizeTexture(canvas, 1, 1);
}

function createCorrugatedRoofTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4105);

  ctx.fillStyle = '#757b82';
  ctx.fillRect(0, 0, 256, 256);

  for (let x = 0; x < 256; x += 8) {
    ctx.fillStyle = 'rgba(210,218,224,0.22)';
    ctx.fillRect(x, 0, 3, 256);
    ctx.fillStyle = 'rgba(28,32,36,0.34)';
    ctx.fillRect(x + 4, 0, 3, 256);
  }
  // Rust patina streaks
  for (let i = 0; i < 900; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    ctx.fillStyle = `rgba(128,68,38,${(0.05 + rand() * 0.14).toFixed(3)})`;
    ctx.fillRect(x, y, 3, 7);
  }

  return finalizeTexture(canvas, 1, 1);
}

function createConcreteTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4106);

  ctx.fillStyle = '#9b9e9c';
  ctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 5500; i++) {
    const x = Math.floor(rand() * 256);
    const y = Math.floor(rand() * 256);
    const v = 132 + Math.floor(rand() * 44);
    ctx.fillStyle = `rgb(${v},${v},${v - 2})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Expansion joint grid
  ctx.strokeStyle = 'rgba(55,58,60,0.32)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 126, 126);
  ctx.strokeRect(129, 1, 126, 126);
  ctx.strokeRect(1, 129, 126, 126);
  ctx.strokeRect(129, 129, 126, 126);

  return finalizeTexture(canvas, 1, 1);
}

function createBarnTimberTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = mulberry32(4107);

  ctx.fillStyle = '#9c8c7c';
  ctx.fillRect(0, 0, 256, 256);

  const plankW = 16;
  for (let x = 0; x < 256; x += plankW) {
    const s = 138 + Math.floor((rand() - 0.5) * 28);
    ctx.fillStyle = `rgb(${s + 14},${s},${s - 12})`;
    ctx.fillRect(x, 0, plankW - 2, 256);
    ctx.fillStyle = 'rgba(30,22,18,0.42)';
    ctx.fillRect(x + plankW - 2, 0, 2, 256);
  }
  return finalizeTexture(canvas, 1, 1);
}

function createHighwaySignTexture(): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 128);
  if (!res) return null;
  const { canvas, ctx } = res;

  ctx.fillStyle = '#18543a';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#e5ece7';
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 240, 112);

  ctx.fillStyle = '#eef4ef';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('RTE 41 NORTH', 128, 52);
  ctx.font = 'bold 18px monospace';
  ctx.fillStyle = '#f2c94c';
  ctx.fillText('FOB · QUARRY · DAM', 128, 92);

  return finalizeTexture(canvas, 1, 1);
}

// ============================================================================
// MERGED BUFFER GEOMETRY ACCUMULATOR (Zero Draw-Call Explosion)
// ============================================================================

type ArchMaterialKey =
  | 'concrete'
  | 'concreteDark'
  | 'wallSiding'
  | 'barnWood'
  | 'roofMetal'
  | 'steel'
  | 'woodTrim'
  | 'fasciaTint'
  | 'emissiveCanopy'
  | 'emissiveFlood'
  | 'emissiveBeacon';

interface GeometryBucket {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
  vertexCount: number;
}

export interface AuditedArchBox {
  readonly mat: ArchMaterialKey;
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly yaw: number;
}

class ChunkGeometryBatcher {
  private readonly buckets = new Map<ArchMaterialKey, GeometryBucket>();
  private readonly chunkOriginX: number;
  private readonly chunkOriginZ: number;
  private readonly auditLog: AuditedArchBox[] | null;

  constructor(chunkOriginX: number, chunkOriginZ: number, auditLog: AuditedArchBox[] | null = null) {
    this.chunkOriginX = chunkOriginX;
    this.chunkOriginZ = chunkOriginZ;
    this.auditLog = auditLog;
  }

  private getBucket(mat: ArchMaterialKey): GeometryBucket {
    let b = this.buckets.get(mat);
    if (!b) {
      b = { positions: [], normals: [], uvs: [], colors: [], indices: [], vertexCount: 0 };
      this.buckets.set(mat, b);
    }
    return b;
  }

  /**
   * Appends an oriented world-space box into the chunk-local merged geometry buffer.
   */
  public addBox(
    mat: ArchMaterialKey,
    wx: number,
    wy: number,
    wz: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    colorR = 1,
    colorG = 1,
    colorB = 1,
  ): void {
    if (this.auditLog) {
      this.auditLog.push({ mat, wx, wy, wz, sx, sy, sz, yaw });
    }
    const b = this.getBucket(mat);
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const ox = wx - this.chunkOriginX;
    const oz = wz - this.chunkOriginZ;
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;

    const uvScale = 0.25;

    const pushFace = (
      nx: number,
      ny: number,
      nz: number,
      v0x: number,
      v0y: number,
      v0z: number,
      v1x: number,
      v1y: number,
      v1z: number,
      v2x: number,
      v2y: number,
      v2z: number,
      v3x: number,
      v3y: number,
      v3z: number,
      uSpan: number,
      vSpan: number,
    ) => {
      const rnx = nx * cosY + nz * sinY;
      const rnz = -nx * sinY + nz * cosY;
      const base = b.vertexCount;

      const verts = [
        [v0x, v0y, v0z, 0, 0],
        [v1x, v1y, v1z, uSpan * uvScale, 0],
        [v2x, v2y, v2z, uSpan * uvScale, vSpan * uvScale],
        [v3x, v3y, v3z, 0, vSpan * uvScale],
      ];

      for (let i = 0; i < 4; i++) {
        const vx = verts[i][0];
        const vy = verts[i][1];
        const vz = verts[i][2];
        const px = ox + vx * cosY + vz * sinY;
        const py = wy + vy;
        const pz = oz - vx * sinY + vz * cosY;
        b.positions.push(px, py, pz);
        b.normals.push(rnx, ny, rnz);
        b.uvs.push(verts[i][3], verts[i][4]);
        b.colors.push(colorR, colorG, colorB);
      }
      b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      b.vertexCount += 4;
    };

    // +Z (Front)
    pushFace(0, 0, 1, -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz, sx, sy);
    // -Z (Back)
    pushFace(0, 0, -1, hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz, sx, sy);
    // +X (Right)
    pushFace(1, 0, 0, hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz, sz, sy);
    // -X (Left)
    pushFace(-1, 0, 0, -hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz, sz, sy);
    // +Y (Top)
    pushFace(0, 1, 0, -hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz, sx, sz);
    // -Y (Bottom)
    pushFace(0, -1, 0, -hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz, sx, sz);
  }

  /**
   * Appends a pitched gable roof prism (ridge running along local X or local Z)
   * with slight eave overhang, plus solid gable end triangles.
   */
  public addGableRoof(
    roofMat: ArchMaterialKey,
    gableMat: ArchMaterialKey,
    wx: number,
    eaveY: number,
    wz: number,
    widthX: number,
    depthZ: number,
    ridgeHeight: number,
    yaw: number,
    roofR: number,
    roofG: number,
    roofB: number,
    gableR: number,
    gableG: number,
    gableB: number,
  ): void {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const ox = wx - this.chunkOriginX;
    const oz = wz - this.chunkOriginZ;

    const hx = widthX * 0.5 + 0.35;
    const hz = depthZ * 0.5 + 0.35;
    const ghx = widthX * 0.5;
    const ghz = depthZ * 0.5;

    const rb = this.getBucket(roofMat);
    const gb = this.getBucket(gableMat);

    const addQuad = (
      b: GeometryBucket,
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      p3: [number, number, number],
      nx: number,
      ny: number,
      nz: number,
      r: number,
      g: number,
      bl: number,
      uSpan: number,
      vSpan: number,
    ) => {
      const rnx = nx * cosY + nz * sinY;
      const rnz = -nx * sinY + nz * cosY;
      const base = b.vertexCount;
      const pts: Array<[number, number, number, number, number]> = [
        [p0[0], p0[1], p0[2], 0, 0],
        [p1[0], p1[1], p1[2], uSpan * 0.25, 0],
        [p2[0], p2[1], p2[2], uSpan * 0.25, vSpan * 0.25],
        [p3[0], p3[1], p3[2], 0, vSpan * 0.25],
      ];
      for (let i = 0; i < 4; i++) {
        const vx = pts[i][0];
        const vy = pts[i][1];
        const vz = pts[i][2];
        b.positions.push(ox + vx * cosY + vz * sinY, eaveY + vy, oz - vx * sinY + vz * cosY);
        b.normals.push(rnx, ny, rnz);
        b.uvs.push(pts[i][3], pts[i][4]);
        b.colors.push(r, g, bl);
      }
      b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      b.vertexCount += 4;
    };

    const addTri = (
      b: GeometryBucket,
      p0: [number, number, number],
      p1: [number, number, number],
      p2: [number, number, number],
      nx: number,
      ny: number,
      nz: number,
      r: number,
      g: number,
      bl: number,
    ) => {
      const rnx = nx * cosY + nz * sinY;
      const rnz = -nx * sinY + nz * cosY;
      const base = b.vertexCount;
      const pts = [p0, p1, p2];
      for (let i = 0; i < 3; i++) {
        const vx = pts[i][0];
        const vy = pts[i][1];
        const vz = pts[i][2];
        b.positions.push(ox + vx * cosY + vz * sinY, eaveY + vy, oz - vx * sinY + vz * cosY);
        b.normals.push(rnx, ny, rnz);
        b.uvs.push(i === 1 ? 1 : 0, i === 2 ? 1 : 0);
        b.colors.push(r, g, bl);
      }
      b.indices.push(base, base + 1, base + 2);
      b.vertexCount += 3;
    };

    // Ridge runs along local X; roof slopes down toward +Z and -Z
    const slopeLen = Math.hypot(hz, ridgeHeight);
    const snY = hz / slopeLen;
    const snZ = ridgeHeight / slopeLen;

    // Front (+Z) roof slope (top + underside soffit)
    addQuad(
      rb,
      [-hx, -0.08, hz],
      [hx, -0.08, hz],
      [hx, ridgeHeight, 0],
      [-hx, ridgeHeight, 0],
      0,
      snY,
      snZ,
      roofR,
      roofG,
      roofB,
      hx * 2,
      slopeLen,
    );
    addQuad(
      rb,
      [hx, -0.14, hz],
      [-hx, -0.14, hz],
      [-hx, ridgeHeight - 0.14, 0],
      [hx, ridgeHeight - 0.14, 0],
      0,
      -snY,
      -snZ,
      roofR * 0.72,
      roofG * 0.72,
      roofB * 0.72,
      hx * 2,
      slopeLen,
    );

    // Back (-Z) roof slope (top + underside)
    addQuad(
      rb,
      [hx, -0.08, -hz],
      [-hx, -0.08, -hz],
      [-hx, ridgeHeight, 0],
      [hx, ridgeHeight, 0],
      0,
      snY,
      -snZ,
      roofR,
      roofG,
      roofB,
      hx * 2,
      slopeLen,
    );
    addQuad(
      rb,
      [-hx, -0.14, -hz],
      [hx, -0.14, -hz],
      [hx, ridgeHeight - 0.14, 0],
      [-hx, ridgeHeight - 0.14, 0],
      0,
      -snY,
      snZ,
      roofR * 0.72,
      roofG * 0.72,
      roofB * 0.72,
      hx * 2,
      slopeLen,
    );

    // Gable end triangles (+X and -X, double-sided for interior view)
    addTri(gb, [ghx, 0, ghz], [ghx, 0, -ghz], [ghx, ridgeHeight - 0.05, 0], 1, 0, 0, gableR, gableG, gableB);
    addTri(gb, [ghx, 0, -ghz], [ghx, 0, ghz], [ghx, ridgeHeight - 0.05, 0], -1, 0, 0, gableR * 0.85, gableG * 0.85, gableB * 0.85);
    addTri(gb, [-ghx, 0, -ghz], [-ghx, 0, ghz], [-ghx, ridgeHeight - 0.05, 0], -1, 0, 0, gableR, gableG, gableB);
    addTri(gb, [-ghx, 0, ghz], [-ghx, 0, -ghz], [-ghx, ridgeHeight - 0.05, 0], 1, 0, 0, gableR * 0.85, gableG * 0.85, gableB * 0.85);
  }

  public finalizeToGroup(
    group: THREE.Group,
    materials: Record<ArchMaterialKey, THREE.Material>,
    ownedGeometries: THREE.BufferGeometry[],
    castShadow: boolean,
    receiveShadow: boolean,
    outShadowCasters?: THREE.Object3D[],
  ): number {
    let meshCount = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.vertexCount === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3));
      geo.setIndex(bucket.indices);
      geo.computeBoundingSphere();

      const mesh = new THREE.Mesh(geo, materials[key]);
      const isEmissive =
        key === 'emissiveCanopy' || key === 'emissiveFlood' || key === 'emissiveBeacon';
      mesh.castShadow = castShadow && !isEmissive;
      mesh.receiveShadow = receiveShadow && !isEmissive;
      if (!isEmissive) {
        mesh.layers.enable(MACRO_OCCLUDER_LAYER);
        outShadowCasters?.push(mesh);
      }
      group.add(mesh);
      ownedGeometries.push(geo);
      meshCount++;
    }
    return meshCount;
  }
}

// ============================================================================
// COMPOSITE INSTANCED PROP GEOMETRIES (Vehicles, Streetlights, Guardrails, Signs)
// ============================================================================

function mergeBoxDefs(
  boxes: ReadonlyArray<{ x: number; y: number; z: number; sx: number; sy: number; sz: number; rx?: number }>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let vertOffset = 0;

  const tmpGeo = new THREE.BoxGeometry(1, 1, 1);
  const posAttr = tmpGeo.attributes.position as THREE.BufferAttribute;
  const normAttr = tmpGeo.attributes.normal as THREE.BufferAttribute;
  const idx = tmpGeo.index!;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const rotMat = new THREE.Matrix4();

  for (const b of boxes) {
    rotMat.makeRotationX(b.rx ?? 0);
    for (let i = 0; i < posAttr.count; i++) {
      v.set(posAttr.getX(i) * b.sx, posAttr.getY(i) * b.sy, posAttr.getZ(i) * b.sz);
      n.set(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      if (b.rx) {
        v.applyMatrix4(rotMat);
        n.applyMatrix4(rotMat);
      }
      positions.push(v.x + b.x, v.y + b.y, v.z + b.z);
      normals.push(n.x, n.y, n.z);
    }
    for (let i = 0; i < idx.count; i++) {
      indices.push(vertOffset + idx.getX(i));
    }
    vertOffset += posAttr.count;
  }
  tmpGeo.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Composite multi-part civilian vehicle hull (chassis, hood, cabin roof, trunk/bed)
 * paired with a dark trim/wheels/glass geometry so parked wrecks look unmistakably like cars/pickups.
 */
function buildCompositeVehicleGeometries(): {
  bodyGeo: THREE.BufferGeometry;
  trimGeo: THREE.BufferGeometry;
} {
  // Painted body: lower body, hood, cabin pillars/roof, fenders
  const bodyGeo = mergeBoxDefs([
    { x: 0, y: 0.68, z: 0, sx: 1.84, sy: 0.56, sz: 4.35 },        // Main chassis hull
    { x: 0, y: 1.18, z: -0.18, sx: 1.56, sy: 0.52, sz: 2.05 },    // Cabin greenhouse frame
    { x: 0, y: 0.94, z: 1.38, sx: 1.72, sy: 0.16, sz: 1.35 },     // Hood crown
    { x: 0, y: 0.94, z: -1.62, sx: 1.72, sy: 0.18, sz: 0.95 },    // Rear deck/trunk
  ]);

  // Dark trim: 4 tires, front/rear bumpers, windshield/windows recess, grille
  const trimGeo = mergeBoxDefs([
    { x: -0.88, y: 0.34, z: 1.32, sx: 0.28, sy: 0.66, sz: 0.66 }, // FL tire
    { x: 0.88, y: 0.34, z: 1.32, sx: 0.28, sy: 0.66, sz: 0.66 },  // FR tire
    { x: -0.88, y: 0.34, z: -1.32, sx: 0.28, sy: 0.66, sz: 0.66 }, // RL tire
    { x: 0.88, y: 0.34, z: -1.32, sx: 0.28, sy: 0.66, sz: 0.66 },  // RR tire
    { x: 0, y: 0.44, z: 2.22, sx: 1.86, sy: 0.22, sz: 0.18 },      // Front bumper
    { x: 0, y: 0.44, z: -2.22, sx: 1.86, sy: 0.22, sz: 0.18 },     // Rear bumper
    { x: 0, y: 1.22, z: -0.16, sx: 1.60, sy: 0.36, sz: 1.82 },     // Tinted side windows
    { x: 0, y: 1.21, z: 0.88, sx: 1.44, sy: 0.36, sz: 0.14, rx: -0.42 }, // Windshield
    { x: 0, y: 1.21, z: -1.24, sx: 1.44, sy: 0.34, sz: 0.14, rx: 0.38 }, // Rear glass
  ]);

  return { bodyGeo, trimGeo };
}

function buildStreetlightGeometries(): {
  poleGeo: THREE.BufferGeometry;
  lampGeo: THREE.BufferGeometry;
} {
  const poleGeo = mergeBoxDefs([
    { x: 0, y: 0.25, z: 0, sx: 0.42, sy: 0.5, sz: 0.42 },       // Concrete base plinth
    { x: 0, y: 4.1, z: 0, sx: 0.16, sy: 7.4, sz: 0.16 },        // Tapered steel mast
    { x: 0, y: 7.65, z: 1.15, sx: 0.12, sy: 0.12, sz: 2.4 },    // Cantilever arm over road
    { x: 0, y: 7.56, z: 2.25, sx: 0.38, sy: 0.14, sz: 0.72 },   // Luminaire housing
  ]);
  const lampGeo = mergeBoxDefs([
    { x: 0, y: 7.45, z: 2.25, sx: 0.30, sy: 0.08, sz: 0.58 },   // Emissive sodium diffuser
  ]);
  return { poleGeo, lampGeo };
}

function buildUtilityPoleGeo(): THREE.BufferGeometry {
  return mergeBoxDefs([
    { x: 0, y: 4.4, z: 0, sx: 0.24, sy: 9.2, sz: 0.24 },         // Creosote timber pole
    { x: 0, y: 8.45, z: 0, sx: 2.3, sy: 0.16, sz: 0.16 },        // Upper crossarm
    { x: 0, y: 7.75, z: 0, sx: 1.65, sy: 0.14, sz: 0.14 },       // Lower crossarm
    { x: -0.95, y: 8.62, z: 0, sx: 0.12, sy: 0.2, sz: 0.12 },    // Ceramic insulator L
    { x: 0.95, y: 8.62, z: 0, sx: 0.12, sy: 0.2, sz: 0.12 },     // Ceramic insulator R
  ]);
}

function buildGuardrailSegmentGeo(): THREE.BufferGeometry {
  return mergeBoxDefs([
    { x: 0, y: 0.72, z: 0, sx: 0.14, sy: 0.32, sz: 4.2 },        // W-beam steel rail
    { x: 0, y: 0.45, z: -1.5, sx: 0.12, sy: 0.95, sz: 0.12 },    // Steel I-post A
    { x: 0, y: 0.45, z: 1.5, sx: 0.12, sy: 0.95, sz: 0.12 },     // Steel I-post B
  ]);
}

function buildJerseyBarrierGeo(): THREE.BufferGeometry {
  return mergeBoxDefs([
    { x: 0, y: 0.18, z: 0, sx: 0.62, sy: 0.36, sz: 2.85 },       // Wide flared base
    { x: 0, y: 0.64, z: 0, sx: 0.32, sy: 0.64, sz: 2.85 },       // Tapered upper wall
  ]);
}

function buildHighwaySignGeometries(): {
  postGeo: THREE.BufferGeometry;
  boardGeo: THREE.BufferGeometry;
} {
  const postGeo = mergeBoxDefs([
    { x: -0.9, y: 1.6, z: 0, sx: 0.1, sy: 3.4, sz: 0.1 },
    { x: 0.9, y: 1.6, z: 0, sx: 0.1, sy: 3.4, sz: 0.1 },
  ]);
  const boardGeo = new THREE.BoxGeometry(2.5, 1.25, 0.08);
  boardGeo.translate(0, 2.85, 0.06);
  return { postGeo, boardGeo };
}

function buildMidBuildingSilhouetteGeo(): THREE.BufferGeometry {
  return mergeBoxDefs([
    { x: 0, y: 2.1, z: 0, sx: 9.6, sy: 4.2, sz: 7.8 },
    { x: 0, y: 4.85, z: 0, sx: 10.2, sy: 1.5, sz: 6.4 },
  ]);
}

// ============================================================================
// LOCAL-TO-WORLD HELPER FOR ENTERABLE BUILDING LAYOUTS
// ============================================================================

interface LocalTransform {
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly yaw: number;
  readonly cosY: number;
  readonly sinY: number;
}

function makeTransform(wx: number, wy: number, wz: number, yaw: number): LocalTransform {
  return { wx, wy, wz, yaw, cosY: Math.cos(yaw), sinY: Math.sin(yaw) };
}

function localToWorldXZ(t: LocalTransform, lx: number, lz: number): { x: number; z: number } {
  return {
    x: t.wx + lx * t.cosY + lz * t.sinY,
    z: t.wz - lx * t.sinY + lz * t.cosY,
  };
}

function hexToRgbTuple(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

// Muted regional residential clapboard wall palettes (slate, ochre, sage, cream, faded terracotta, weathered blue-grey)
const HOUSE_WALL_PALETTE: readonly number[] = [
  0xb9b2a4, // Warm weathered plaster
  0x8e999e, // Coastal weathered slate
  0x9aa28d, // Conifer valley sage
  0xb99d79, // Steppe ochre
  0xa47b6a, // Faded terracotta brick
  0x9a958d, // Highland ash grey
];

const ROOF_METAL_PALETTE: readonly number[] = [
  0x4f565d, // Dark galvanized slate
  0x6b4b3e, // Weathered oxide brown
  0x46544a, // Pine tin green
  0x5a5f66, // Ash steel
];

const VEHICLE_BODY_PALETTE: readonly number[] = [
  0x6c757d, // Faded silver-grey
  0x36495c, // Weathered navy
  0x7c3a2d, // Rust red pickup
  0x4f5d47, // Olive utility truck
  0xc8c5bc, // Dusty white cargo van
  0x7a6a4d, // Tan station wagon
];

// Scratch transforms for instanced hardware placement
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

export interface ChunkArchitectureOutput {
  instanceCount: number;
  meshCount: number;
  propSpawns: DynamicPropSpawnSpec[];
}

/**
 * Unified Procedural Open World Architecture, Road Ribbon, Bridge & Roadside Infrastructure Builder.
 * - Produces merged chunk buffers (1 draw call per material) + instanced roadside hardware.
 * - Emits synchronized `SolidObb[]`, `WalkDeck[]`, and `IndoorVolume[]` for enterable interiors,
 *   doorway pass-through, waist-high window shooting, bridge traversal, and acoustic switching.
 * - Zero dynamic PointLights: night glow driven via shared emissive material sync.
 */
export class OpenWorldArchitectureBuilder {
  private readonly isSoftwareGl: boolean;

  // Shared textures
  private readonly textures: THREE.Texture[] = [];

  // Shared PBR material bank
  private readonly archMaterials: Record<ArchMaterialKey, THREE.MeshStandardMaterial>;
  private readonly highwayMat: THREE.MeshStandardMaterial;
  private readonly spurMat: THREE.MeshStandardMaterial;
  private readonly dirtMat: THREE.MeshStandardMaterial;
  private readonly midRoadMat: THREE.MeshStandardMaterial;
  private readonly vehicleBodyMat: THREE.MeshStandardMaterial;
  private readonly vehicleTrimMat: THREE.MeshStandardMaterial;
  private readonly streetlightPoleMat: THREE.MeshStandardMaterial;
  private readonly streetlightEmissiveMat: THREE.MeshStandardMaterial;
  private readonly utilityPoleMat: THREE.MeshStandardMaterial;
  private readonly powerLineMat: THREE.LineBasicMaterial;
  private readonly guardrailMat: THREE.MeshStandardMaterial;
  private readonly barrierMat: THREE.MeshStandardMaterial;
  private readonly signPostMat: THREE.MeshStandardMaterial;
  private readonly signBoardMat: THREE.MeshStandardMaterial;
  private readonly midSiteMat: THREE.MeshStandardMaterial;

  // Shared instanced base geometries
  private readonly vehicleBodyGeo: THREE.BufferGeometry;
  private readonly vehicleTrimGeo: THREE.BufferGeometry;
  private readonly streetlightPoleGeo: THREE.BufferGeometry;
  private readonly streetlightLampGeo: THREE.BufferGeometry;
  private readonly utilityPoleGeo: THREE.BufferGeometry;
  private readonly guardrailGeo: THREE.BufferGeometry;
  private readonly barrierGeo: THREE.BufferGeometry;
  private readonly signPostGeo: THREE.BufferGeometry;
  private readonly signBoardGeo: THREE.BufferGeometry;
  private readonly midSiteGeo: THREE.BufferGeometry;

  private nightFactor = 0;
  private shadowsEnabled = true;

  constructor(isSoftwareGl = false, atmoFogUniforms?: AtmoFogSharedUniforms) {
    this.isSoftwareGl = isSoftwareGl;
    this.shadowsEnabled = !isSoftwareGl;

    const hwTex = createHighwayAsphaltTexture();
    const spurTex = createFobSpurTexture();
    const dirtTex = createDirtTrailTexture();
    const wallTex = createClapboardWallTexture();
    const roofTex = createCorrugatedRoofTexture();
    const concTex = createConcreteTexture();
    const barnTex = createBarnTimberTexture();
    const signTex = createHighwaySignTexture();

    for (const t of [hwTex, spurTex, dirtTex, wallTex, roofTex, concTex, barnTex, signTex]) {
      if (t) this.textures.push(t);
    }

    // Shared architectural PBR materials (explicit FrontSide backface culling + vertexColors)
    this.archMaterials = {
      concrete: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: concTex,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.04,
        side: THREE.FrontSide,
      }),
      concreteDark: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: concTex,
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.06,
        side: THREE.FrontSide,
      }),
      wallSiding: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: wallTex,
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.02,
        side: THREE.FrontSide,
      }),
      barnWood: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: barnTex,
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.02,
        side: THREE.FrontSide,
      }),
      roofMetal: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: roofTex,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.42,
        side: THREE.FrontSide,
      }),
      steel: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.46,
        metalness: 0.68,
        side: THREE.FrontSide,
      }),
      woodTrim: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.02,
        side: THREE.FrontSide,
      }),
      fasciaTint: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.52,
        metalness: 0.25,
        side: THREE.FrontSide,
      }),
      emissiveCanopy: new THREE.MeshStandardMaterial({
        color: 0xd8e8f2,
        emissive: 0xdcf4ff,
        emissiveIntensity: 0.15,
        roughness: 0.35,
        metalness: 0.1,
        side: THREE.FrontSide,
      }),
      emissiveFlood: new THREE.MeshStandardMaterial({
        color: 0xffe4b8,
        emissive: 0xffc878,
        emissiveIntensity: 0.15,
        roughness: 0.35,
        metalness: 0.1,
        side: THREE.FrontSide,
      }),
      emissiveBeacon: new THREE.MeshStandardMaterial({
        color: 0xd92626,
        emissive: 0xff2a2a,
        emissiveIntensity: 0.4,
        roughness: 0.25,
        metalness: 0.1,
        side: THREE.FrontSide,
      }),
    };

    // Road ribbon materials with polygonOffset to eliminate Z-fighting against terrain
    this.highwayMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: hwTex,
      roughness: 0.9,
      metalness: 0.03,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.spurMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: spurTex,
      roughness: 0.91,
      metalness: 0.02,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.dirtMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: dirtTex,
      roughness: 0.96,
      metalness: 0.0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.midRoadMat = new THREE.MeshStandardMaterial({
      color: 0x3b3f44,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    // Instanced roadside hardware materials (explicit FrontSide backface culling)
    this.vehicleBodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.56,
      metalness: 0.42,
      side: THREE.FrontSide,
    });
    this.vehicleTrimMat = new THREE.MeshStandardMaterial({
      color: 0x1e2227,
      roughness: 0.72,
      metalness: 0.24,
      side: THREE.FrontSide,
    });
    this.streetlightPoleMat = new THREE.MeshStandardMaterial({
      color: 0x5c646b,
      roughness: 0.48,
      metalness: 0.62,
      side: THREE.FrontSide,
    });
    this.streetlightEmissiveMat = new THREE.MeshStandardMaterial({
      color: 0xffe4b8,
      emissive: 0xffa838,
      emissiveIntensity: 0.1,
      roughness: 0.3,
      metalness: 0.1,
      side: THREE.FrontSide,
    });
    this.utilityPoleMat = new THREE.MeshStandardMaterial({
      color: 0x4b3b2e,
      roughness: 0.94,
      metalness: 0.02,
      side: THREE.FrontSide,
    });
    this.powerLineMat = new THREE.LineBasicMaterial({
      color: 0x1b1e22,
      transparent: true,
      opacity: 0.75,
    });
    this.guardrailMat = new THREE.MeshStandardMaterial({
      color: 0x879098,
      roughness: 0.46,
      metalness: 0.66,
      side: THREE.FrontSide,
    });
    this.barrierMat = new THREE.MeshStandardMaterial({
      color: 0x8d908e,
      map: concTex,
      roughness: 0.88,
      metalness: 0.04,
      side: THREE.FrontSide,
    });
    this.signPostMat = new THREE.MeshStandardMaterial({
      color: 0x676f77,
      roughness: 0.5,
      metalness: 0.62,
      side: THREE.FrontSide,
    });
    this.signBoardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: signTex,
      roughness: 0.42,
      metalness: 0.15,
      side: THREE.FrontSide,
    });
    this.midSiteMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.08,
      side: THREE.FrontSide,
    });

    if (atmoFogUniforms) {
      applyAtmosphericHeightFog(this.archMaterials.concrete, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.concreteDark, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.wallSiding, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.barnWood, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.roofMetal, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.steel, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.woodTrim, atmoFogUniforms);
      applyAtmosphericHeightFog(this.archMaterials.fasciaTint, atmoFogUniforms);
      applyAtmosphericHeightFog(this.highwayMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.spurMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.dirtMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.midRoadMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.vehicleBodyMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.vehicleTrimMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.streetlightPoleMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.utilityPoleMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.guardrailMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.barrierMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.signPostMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.signBoardMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.midSiteMat, atmoFogUniforms);
    }

    // Shared composite instanced geometries
    const veh = buildCompositeVehicleGeometries();
    this.vehicleBodyGeo = veh.bodyGeo;
    this.vehicleTrimGeo = veh.trimGeo;
    const sl = buildStreetlightGeometries();
    this.streetlightPoleGeo = sl.poleGeo;
    this.streetlightLampGeo = sl.lampGeo;
    this.utilityPoleGeo = buildUtilityPoleGeo();
    this.guardrailGeo = buildGuardrailSegmentGeo();
    this.barrierGeo = buildJerseyBarrierGeo();
    const sg = buildHighwaySignGeometries();
    this.signPostGeo = sg.postGeo;
    this.signBoardGeo = sg.boardGeo;
    this.midSiteGeo = buildMidBuildingSilhouetteGeo();
  }

  /**
   * Synchronizes night-time emissive intensity across all streetlights, gas station canopies,
   * checkpoint floodlights, and aviation beacons (zero dynamic PointLights, zero allocations).
   */
  public setNightFactor(nightFactor: number): void {
    const clamped = Math.max(0, Math.min(1, nightFactor));
    if (Math.abs(clamped - this.nightFactor) < 0.005) return;
    this.nightFactor = clamped;

    const glow = clamped * clamped * (3 - 2 * clamped);
    this.streetlightEmissiveMat.emissiveIntensity = 0.05 + glow * 2.15;
    this.archMaterials.emissiveCanopy.emissiveIntensity = 0.08 + glow * 1.95;
    this.archMaterials.emissiveFlood.emissiveIntensity = 0.06 + glow * 2.1;
    this.archMaterials.emissiveBeacon.emissiveIntensity = 0.35 + glow * 2.45;
  }

  public getNightFactor(): number {
    return this.nightFactor;
  }

  public getStreetlightEmissiveIntensity(): number {
    return this.streetlightEmissiveMat.emissiveIntensity;
  }

  public applyQualityProfile(profile: GraphicsQualityProfile): void {
    this.shadowsEnabled = !this.isSoftwareGl && profile.castShadows;
    const cap = Math.max(1, profile.anisotropyCap);
    for (let i = 0; i < this.textures.length; i++) {
      this.textures[i].anisotropy = cap;
      this.textures[i].needsUpdate = true;
    }
  }

  public getSharedMaterials(): THREE.Material[] {
    return [
      ...Object.values(this.archMaterials),
      this.highwayMat,
      this.spurMat,
      this.dirtMat,
      this.midRoadMat,
      this.vehicleBodyMat,
      this.vehicleTrimMat,
      this.streetlightPoleMat,
      this.streetlightEmissiveMat,
      this.utilityPoleMat,
      this.guardrailMat,
      this.barrierMat,
      this.signPostMat,
      this.signBoardMat,
      this.midSiteMat,
    ];
  }

  // ============================================================================
  // HORIZON LAYER: 3 STEEL-TRUSS RIVER BRIDGES + 8 WATER TOWERS / RADIO MASTS
  // ============================================================================

  /**
   * Builds persistent horizon-visible steel-truss river bridges, municipal water towers,
   * and tall red/white guyed lattice radio masts directly into the streamer's `horizonGroup`.
   */
  public populateHorizonCivilization(
    horizonGroup: THREE.Group,
    horizonDisposables: Array<{ dispose(): void }>,
  ): void {
    const batcher = new ChunkGeometryBatcher(0, 0);
    const guyWirePositions: number[] = [];

    // 1. All 3 Elevated Steel-Truss River Bridges (visible across the whole 4km valley)
    const bridges = getBakedRiverBridges();
    for (let i = 0; i < bridges.length; i++) {
      this.appendSteelTrussBridgeGeometry(batcher, bridges[i]);
    }

    // 2. All 8 Vertical Regional Landmarks (4 Municipal Water Towers + 4 Guyed Radio Masts)
    const towers = getBakedHorizonTowers();
    for (let i = 0; i < towers.length; i++) {
      const t = towers[i];
      if (t.kind === 'water_tower') {
        this.appendWaterTowerGeometry(batcher, t);
      } else {
        this.appendRadioMastGeometry(batcher, t, guyWirePositions);
      }
    }

    const ownedGeos: THREE.BufferGeometry[] = [];
    batcher.finalizeToGroup(
      horizonGroup,
      this.archMaterials,
      ownedGeos,
      !this.isSoftwareGl,
      !this.isSoftwareGl,
    );
    for (const g of ownedGeos) horizonDisposables.push(g);

    if (guyWirePositions.length > 0) {
      const wireGeo = new THREE.BufferGeometry();
      wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(guyWirePositions, 3));
      wireGeo.computeBoundingSphere();
      const lines = new THREE.LineSegments(wireGeo, this.powerLineMat);
      horizonGroup.add(lines);
      horizonDisposables.push(wireGeo);
    }
  }

  private appendSteelTrussBridgeGeometry(batcher: ChunkGeometryBatcher, b: BakedRiverBridge): void {
    const t = makeTransform(b.centerX, b.deckY, b.centerZ, b.yaw);
    const halfLen = b.lengthM * 0.5;
    const halfW = b.widthM * 0.5;
    const slope = (b.endY - b.startY) / Math.max(1, b.lengthM);

    const addBridgePart = (
      mat: ArchMaterialKey,
      lx: number,
      lyOffsetFromDeck: number,
      lz: number,
      sx: number,
      sy: number,
      sz: number,
      r: number,
      g: number,
      bl: number,
    ) => {
      const p = localToWorldXZ(t, lx, lz);
      const deckYAtZ = b.deckY + lz * slope;
      batcher.addBox(mat, p.x, deckYAtZ + lyOffsetFromDeck, p.z, sx, sy, sz, b.yaw, r, g, bl);
    };

    // Segmented roadway concrete/asphalt deck slab along span (follows slight start->end grade cleanly)
    const bays = Math.max(6, Math.round(b.lengthM / 12));
    const bayLen = b.lengthM / bays;
    for (let i = 0; i < bays; i++) {
      const lz = -halfLen + (i + 0.5) * bayLen;
      // Roadway surface slab (exact bayLen abutment avoids bay-joint coplanar Z-fighting)
      addBridgePart('concreteDark', 0, -0.35, lz, b.widthM, 0.7, bayLen, 0.34, 0.36, 0.38);
      // Raised sidewalk/curb shoulders seated cleanly on top of deck (+0.00..+0.34)
      addBridgePart('concrete', -halfW + 0.55, 0.17, lz, 1.05, 0.34, bayLen, 0.64, 0.66, 0.65);
      addBridgePart('concrete', halfW - 0.55, 0.17, lz, 1.05, 0.34, bayLen, 0.64, 0.66, 0.65);
      // Steel underside longitudinal girders seated strictly below deck (-1.55..-0.70)
      addBridgePart('steel', -halfW + 1.2, -1.125, lz, 0.45, 0.85, bayLen, 0.32, 0.36, 0.40);
      addBridgePart('steel', halfW - 1.2, -1.125, lz, 0.45, 0.85, bayLen, 0.32, 0.36, 0.40);

      // Side steel safety guardrails (solid ballistic cover!)
      addBridgePart('steel', -halfW + 0.18, 0.92, lz, 0.22, 0.36, bayLen, 0.50, 0.54, 0.56);
      addBridgePart('steel', halfW - 0.18, 0.92, lz, 0.22, 0.36, bayLen, 0.50, 0.54, 0.56);

      // Upper steel truss chords & overhead portal bracing on interior bays
      if (i > 0 && i < bays - 1) {
        addBridgePart('steel', -halfW + 0.24, 5.4, lz, 0.38, 0.42, bayLen, 0.30, 0.35, 0.38);
        addBridgePart('steel', halfW - 0.24, 5.4, lz, 0.38, 0.42, bayLen, 0.30, 0.35, 0.38);
        // Overhead portal crossbeam every bay
        addBridgePart('steel', 0, 5.4, lz - bayLen * 0.5, b.widthM - 0.86, 0.38, 0.38, 0.32, 0.36, 0.40);
      }

      // Vertical truss posts seated cleanly atop curb (0.34) up to upper chord underside (5.19)
      const postZ = -halfLen + i * bayLen;
      if (i > 0) {
        const postBot = 0.34;
        const postH = 5.19 - postBot;
        addBridgePart('steel', -halfW + 0.24, postBot + postH * 0.5, postZ, 0.36, postH, 0.36, 0.34, 0.38, 0.42);
        addBridgePart('steel', halfW - 0.24, postBot + postH * 0.5, postZ, 0.36, postH, 0.36, 0.34, 0.38, 0.42);
      }
    }

    // 2 heavy reinforced concrete river piers seated cleanly beneath cap beam [-20.25..-2.45]
    for (const pierFrac of [-0.24, 0.24]) {
      const pz = pierFrac * b.lengthM;
      addBridgePart('concrete', -halfW + 1.4, -11.35, pz, 2.2, 17.8, 3.2, 0.58, 0.60, 0.58);
      addBridgePart('concrete', halfW - 1.4, -11.35, pz, 2.2, 17.8, 3.2, 0.58, 0.60, 0.58);
      addBridgePart('concrete', 0, -1.65, pz, b.widthM - 0.3, 1.6, 3.4, 0.56, 0.58, 0.56);
    }

    // Heavy concrete end abutments seated deeply into both riverbanks cleanly outside bridge span
    for (const endSign of [-1, 1]) {
      const az = endSign * (halfLen + 2.25);
      addBridgePart('concrete', 0, -5.0, az, b.widthM + 2.4, 10.2, 4.4, 0.62, 0.63, 0.60);
      // End approach wing walls seated cleanly atop abutment edge
      addBridgePart('concrete', -halfW - 0.85, 0.75, az, 0.65, 1.3, 4.4, 0.65, 0.66, 0.64);
      addBridgePart('concrete', halfW + 0.85, 0.75, az, 0.65, 1.3, 4.4, 0.65, 0.66, 0.64);
    }
  }

  private appendWaterTowerGeometry(batcher: ChunkGeometryBatcher, t: BakedHorizonTower): void {
    const baseY = t.groundY;
    const h = t.heightM;
    const legH = h * 0.68;
    const spread = 3.8;

    // Concrete foundation pad
    batcher.addBox('concrete', t.x, baseY - 0.4, t.z, 10.5, 2.2, 10.5, 0, 0.62, 0.64, 0.62);

    // 4 heavy steel corner support columns
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        batcher.addBox(
          'steel',
          t.x + sx * spread,
          baseY + legH * 0.5,
          t.z + sz * spread,
          0.62,
          legH,
          0.62,
          0,
          0.46,
          0.51,
          0.54,
        );
      }
    }

    // Horizontal cross-bracing rings at 2 heights (butted cleanly inside corner columns)
    const braceSpan = spread * 2 - 0.62;
    for (const frac of [0.35, 0.7]) {
      const ry = baseY + legH * frac;
      batcher.addBox('steel', t.x, ry, t.z + spread, braceSpan, 0.34, 0.34, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x, ry, t.z - spread, braceSpan, 0.34, 0.34, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x + spread, ry, t.z, 0.34, 0.34, braceSpan, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x - spread, ry, t.z, 0.34, 0.34, braceSpan, 0, 0.42, 0.47, 0.50);
    }

    // Central riser pipe
    batcher.addBox('steel', t.x, baseY + legH * 0.5, t.z, 1.3, legH + 1.0, 1.3, 0, 0.38, 0.42, 0.46);

    // Elevated steel tank body (rotated prism inset 4cm vertically so caps never Z-fight) + catwalk + cap
    const tankY = baseY + legH + 3.6;
    batcher.addBox('steel', t.x, tankY, t.z, 8.2, 6.8, 8.2, 0, 0.62, 0.67, 0.69);
    batcher.addBox('steel', t.x, tankY, t.z, 8.2, 6.72, 8.2, Math.PI * 0.25, 0.60, 0.65, 0.67);
    // Catwalk ring
    batcher.addBox('steel', t.x, baseY + legH + 0.3, t.z, 10.6, 0.32, 10.6, 0, 0.36, 0.40, 0.44);
    // Conical cap silhouette + aviation finial beacon
    batcher.addBox('roofMetal', t.x, tankY + 4.2, t.z, 6.8, 1.6, 6.8, Math.PI * 0.25, 0.44, 0.49, 0.52);
    batcher.addBox('roofMetal', t.x, tankY + 5.6, t.z, 3.6, 1.2, 3.6, 0, 0.44, 0.49, 0.52);
    batcher.addBox('emissiveBeacon', t.x, tankY + 6.625, t.z, 0.65, 0.85, 0.65, 0, 1, 1, 1);
  }

  private appendRadioMastGeometry(
    batcher: ChunkGeometryBatcher,
    t: BakedHorizonTower,
    guyWirePositions: number[],
  ): void {
    const baseY = t.groundY;
    const h = t.heightM;

    // Concrete equipment shelter & mast pedestal
    batcher.addBox('concrete', t.x, baseY - 0.3, t.z, 6.0, 2.2, 6.0, 0, 0.60, 0.62, 0.60);
    batcher.addBox('concreteDark', t.x + 5.2, baseY + 1.2, t.z + 2.5, 4.4, 2.8, 3.4, 0.2, 0.56, 0.58, 0.57);

    // Alternating red & white lattice mast sections
    const segCount = 8;
    const segH = h / segCount;
    const ringH = 0.22;
    const railH = Math.max(0.2, segH - ringH);
    for (let s = 0; s < segCount; s++) {
      const frac = s / segCount;
      const w = 2.4 - frac * 1.45;
      const sy = baseY + s * segH + railH * 0.5;
      const isRed = s % 2 === 0;
      const r = isRed ? 0.78 : 0.86;
      const g = isRed ? 0.22 : 0.87;
      const b = isRed ? 0.18 : 0.85;

      // 4 lattice corner rails (stopping cleanly below horizontal ring brace)
      const o = w * 0.45;
      for (const cx of [-o, o]) {
        for (const cz of [-o, o]) {
          batcher.addBox('fasciaTint', t.x + cx, sy, t.z + cz, 0.24, railH, 0.24, 0, r, g, b);
        }
      }
      // Horizontal ring brace
      batcher.addBox('fasciaTint', t.x, baseY + (s + 1) * segH - ringH * 0.5, t.z, w, ringH, w, 0, r, g, b);
    }

    // Microwave dish & antenna arrays near upper third
    const dishY = baseY + h * 0.74;
    batcher.addBox('steel', t.x + 1.4, dishY, t.z, 0.45, 2.1, 2.1, 0.35, 0.82, 0.85, 0.88);
    batcher.addBox('steel', t.x - 1.4, dishY - 3.0, t.z + 0.4, 0.45, 1.8, 1.8, -0.5, 0.82, 0.85, 0.88);

    // Night-visible red aviation obstruction beacons (mid & crown)
    batcher.addBox('emissiveBeacon', t.x, baseY + h * 0.56, t.z, 0.9, 0.9, 0.9, 0, 1, 1, 1);
    batcher.addBox('emissiveBeacon', t.x, baseY + h + 0.9, t.z, 1.15, 1.4, 1.15, 0, 1, 1, 1);

    // 3 directional guy wires anchored to ground
    const anchorDist = h * 0.42;
    for (let k = 0; k < 3; k++) {
      const ang = (k / 3) * Math.PI * 2 + 0.4;
      const ax = t.x + Math.cos(ang) * anchorDist;
      const az = t.z + Math.sin(ang) * anchorDist;
      const ay = evaluateOpenWorldHeight(ax, az);
      batcher.addBox('concrete', ax, ay + 0.2, az, 1.2, 1.2, 1.2, ang, 0.62, 0.64, 0.62);

      // Upper & lower guy cables
      guyWirePositions.push(t.x, baseY + h * 0.86, t.z, ax, ay + 0.5, az);
      guyWirePositions.push(t.x, baseY + h * 0.5, t.z, ax, ay + 0.5, az);
    }
  }

  // ============================================================================
  // ACTIVE CHUNK POPULATION (Roads, Enterable Buildings, Bridge Physics, Hardware)
  // ============================================================================

  public populateActiveChunk(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    ownedGeometries: THREE.BufferGeometry[],
    instancedMeshes: THREE.InstancedMesh[],
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    outShadowCasters?: THREE.Object3D[],
  ): ChunkArchitectureOutput {
    let instanceCount = 0;
    let meshCount = 0;

    // 1. Register Bridge Physics (WalkDecks & Parapet/Truss SolidObbs) for any bridge touching this chunk
    const chunkBridges = getBridgesInChunk(cx, cz);
    for (let i = 0; i < chunkBridges.length; i++) {
      this.registerBridgePhysics(chunkBridges[i], outObbs, outDecks);
    }

    // 2. Terrain-conforming Road Ribbon Meshes (Highway, FOB Spurs, Dirt Trails)
    const roadSegments = getRoadSegmentsInChunk(cx, cz);
    if (roadSegments.length > 0) {
      meshCount += this.buildChunkRoadRibbons(
        roadSegments,
        centerX,
        centerZ,
        group,
        ownedGeometries,
        false,
      );
    }

    // 3. Enterable Sites owned by this chunk (Gas Stations, Houses, Barns, Checkpoints)
    const batcher = new ChunkGeometryBatcher(centerX, centerZ);
    const vehiclePlacements: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> = [];
    const streetlightPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }> = [];
    const barrierPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }> = [];

    const chunkSites = getSitesInChunk(cx, cz);
    const halfChunk = CHUNK_SIZE_M * 0.5;
    for (let i = 0; i < chunkSites.length; i++) {
      const site = chunkSites[i];
      // Build physics for every site touching this chunk (handles boundary overlaps cleanly)
      // Build visual geometry ONLY in the site's owning chunk to prevent double-rendering!
      const ownsVisuals =
        site.x >= centerX - halfChunk &&
        site.x < centerX + halfChunk &&
        site.z >= centerZ - halfChunk &&
        site.z < centerZ + halfChunk;

      this.buildSite(
        site,
        ownsVisuals ? batcher : null,
        outObbs,
        outDecks,
        outIndoor,
        ownsVisuals ? vehiclePlacements : null,
        ownsVisuals ? streetlightPlacements : null,
        ownsVisuals ? barrierPlacements : null,
      );
    }

    // 3b. Full Military FOB Compounds (Alpha FOB & Bravo FOB) overlapping this chunk
    const overlappingFobs = getFobCompoundsOverlappingRect(
      centerX - halfChunk,
      centerX + halfChunk,
      centerZ - halfChunk,
      centerZ + halfChunk,
    );
    for (let i = 0; i < overlappingFobs.length; i++) {
      const fob = overlappingFobs[i];
      const ownsFobVisuals =
        fob.worldX >= centerX - halfChunk &&
        fob.worldX < centerX + halfChunk &&
        fob.worldZ >= centerZ - halfChunk &&
        fob.worldZ < centerZ + halfChunk;
      this.buildFobCompound(
        fob,
        ownsFobVisuals ? batcher : null,
        outObbs,
        outDecks,
        outIndoor,
        ownsFobVisuals ? vehiclePlacements : null,
        ownsFobVisuals ? streetlightPlacements : null,
        ownsFobVisuals ? barrierPlacements : null,
      );
    }

    // 3c. Secondary Major Open World POI Tactical Cover, Landmarks & Floodlight Poles
    for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
      const lm = OPENWORLD_LANDMARKS[i];
      if (
        lm.kind !== 'port' &&
        lm.kind !== 'railyard' &&
        lm.kind !== 'quarry' &&
        lm.kind !== 'dam'
      ) {
        continue;
      }
      const reach = 48;
      if (
        lm.worldX + reach < centerX - halfChunk ||
        lm.worldX - reach > centerX + halfChunk ||
        lm.worldZ + reach < centerZ - halfChunk ||
        lm.worldZ - reach > centerZ + halfChunk
      ) {
        continue;
      }
      const ownsPoiVisuals =
        lm.worldX >= centerX - halfChunk &&
        lm.worldX < centerX + halfChunk &&
        lm.worldZ >= centerZ - halfChunk &&
        lm.worldZ < centerZ + halfChunk;
      this.buildMajorPoiTacticalSetDressing(
        lm,
        ownsPoiVisuals ? batcher : null,
        outObbs,
        ownsPoiVisuals ? streetlightPlacements : null,
        ownsPoiVisuals ? barrierPlacements : null,
      );
    }

    meshCount += batcher.finalizeToGroup(
      group,
      this.archMaterials,
      ownedGeometries,
      this.shadowsEnabled,
      this.shadowsEnabled,
      outShadowCasters,
    );

    // 4. Roadside Hardware along paved segments owned by this chunk (Guardrails, Utility Poles + Power Lines, Signs, Streetlights, Abandoned Cars)
    instanceCount += this.populateRoadsideHardware(
      cx,
      cz,
      centerX,
      centerZ,
      roadSegments,
      vehiclePlacements,
      streetlightPlacements,
      barrierPlacements,
      group,
      ownedGeometries,
      instancedMeshes,
      outObbs,
      outShadowCasters,
    );

    // 5. Emit deterministic chunk-streamed dynamic physics props (bottles, cans, wind-blown papers, cartons)
    const propSpawns: DynamicPropSpawnSpec[] = [];
    const ownerTag = `${cx},${cz}`;
    const randProp = mulberry32(chunkHash(cx * 31 + 7, cz * 47 + 19));

    // 5a. FOB Compound tables, range benches, courtyard wind papers & storage crates
    for (let i = 0; i < overlappingFobs.length; i++) {
      const fob = overlappingFobs[i];
      const ownsFob =
        fob.worldX >= centerX - halfChunk &&
        fob.worldX < centerX + halfChunk &&
        fob.worldZ >= centerZ - halfChunk &&
        fob.worldZ < centerZ + halfChunk;
      if (!ownsFob) continue;
      const ft: LocalTransform = {
        wx: fob.worldX,
        wy: fob.baseY,
        wz: fob.worldZ,
        yaw: fob.yaw,
        cosY: fob.cosY,
        sinY: fob.sinY,
      };
      const pushFobProp = (
        kind: DynamicPropSpawnSpec['kind'],
        lx: number,
        ly: number,
        lz: number,
        yaw = 0,
        roll = 0,
      ) => {
        const w = localToWorldXZ(ft, lx, lz);
        propSpawns.push({ kind, x: w.x, y: fob.baseY + ly, z: w.z, yaw: yaw + fob.yaw, roll, ownerTag });
      };

      // Command Bunker tactical map table dossiers, coffee/soda cans & bottles
      pushFobProp('paper_sheet', -3.6, 1.24, 2.35, 0.25);
      pushFobProp('paper_sheet', -3.1, 1.24, 2.55, -0.4);
      pushFobProp('soda_can', -2.7, 1.24, 2.15, 0.9);
      pushFobProp('glass_bottle_amber', -2.5, 1.24, 2.68, 1.5);
      // Armory gunsmith bench bottles, ration tins & cardboard ammo cartons
      pushFobProp('glass_bottle_green', 18.6, 1.18, -5.25, 0.4);
      pushFobProp('ration_tin', 19.3, 1.18, -5.15, 1.1);
      pushFobProp('cardboard_box', 16.5, 0.25, -5.4, 0.2);
      // Field Hospital medical supply clutter
      pushFobProp('glass_bottle_amber', 14.5, 0.24, 11.4, 0.8);
      pushFobProp('paper_sheet', 17.8, 0.22, 9.2, 0.5);
      // Barracks & Mess Tent bottles/cans/tins
      pushFobProp('glass_bottle_green', -32.2, 1.14, 19.1, 0.3);
      pushFobProp('soda_can', -32.6, 1.14, 19.35, 1.8);
      pushFobProp('ration_tin', -31.8, 1.14, 18.95, 2.1);
      // Shooting-range firing line shootable bottles & cans!
      for (let b = 0; b < 5; b++) {
        pushFobProp(
          b % 3 === 0 ? 'glass_bottle_green' : b % 3 === 1 ? 'glass_bottle_amber' : 'soda_can',
          -20.5 + b * 0.48,
          1.12,
          -26.2,
          b * 0.8,
        );
      }
      // Outdoor wind-swept papers & floor cans across the FOB courtyard tarmac & helipad edge
      for (let p = 0; p < 8; p++) {
        const px = -14 + randProp() * 28;
        const pz = -14 + randProp() * 30;
        pushFobProp(p < 6 ? 'paper_sheet' : 'soda_can', px, 0.14, pz, randProp() * 6.28, p >= 6 ? Math.PI * 0.5 : 0);
      }
    }

    // 5b. Settlement buildings (bungalows, convenience stores, barns, checkpoints)
    for (let i = 0; i < chunkSites.length; i++) {
      const site = chunkSites[i];
      if (
        site.x < centerX - halfChunk ||
        site.x >= centerX + halfChunk ||
        site.z < centerZ - halfChunk ||
        site.z >= centerZ + halfChunk
      ) {
        continue;
      }
      const sy = site.groundY + 0.22;
      propSpawns.push(
        { kind: 'glass_bottle_green', x: site.x - 1.2 + randProp() * 2.4, y: sy, z: site.z - 1.2 + randProp() * 2.4, yaw: randProp() * 6.28, ownerTag },
        { kind: 'soda_can', x: site.x - 1.4 + randProp() * 2.8, y: sy, z: site.z - 1.4 + randProp() * 2.8, yaw: randProp() * 6.28, roll: Math.PI * 0.5, ownerTag },
        { kind: 'paper_sheet', x: site.x + (randProp() - 0.5) * 4.5, y: sy, z: site.z + (randProp() - 0.5) * 4.5, yaw: randProp() * 6.28, ownerTag },
        { kind: 'paper_sheet', x: site.x + (randProp() - 0.5) * 7.5, y: site.groundY + 0.08, z: site.z + (randProp() - 0.5) * 7.5, yaw: randProp() * 6.28, ownerTag },
        { kind: i % 2 === 0 ? 'cardboard_box' : 'ration_tin', x: site.x + 1.8, y: sy, z: site.z - 1.4, yaw: randProp() * 1.4, ownerTag },
      );
    }

    // 5c. Roadside wind-blown paper & litter along paved highways
    if (roadSegments.length > 0 && propSpawns.length < 18) {
      const seg = roadSegments[Math.floor(randProp() * roadSegments.length)];
      const mx = (seg.ax + seg.bx) * 0.5;
      const mz = (seg.az + seg.bz) * 0.5;
      if (
        mx >= centerX - halfChunk &&
        mx < centerX + halfChunk &&
        mz >= centerZ - halfChunk &&
        mz < centerZ + halfChunk
      ) {
        const my = evaluateOpenWorldHeight(mx, mz) + 0.1;
        for (let k = 0; k < 3; k++) {
          propSpawns.push({
            kind: k < 2 ? 'paper_sheet' : 'soda_can',
            x: mx + (randProp() - 0.5) * 6.0,
            y: my,
            z: mz + (randProp() - 0.5) * 6.0,
            yaw: randProp() * 6.28,
            roll: k === 2 ? Math.PI * 0.5 : 0,
            ownerTag,
          });
        }
      }
    }

    return { instanceCount, meshCount, propSpawns };
  }

  /**
   * Mid-Range Shell (`5 × 5` outer ring): lightweight road ribbons + accurate building silhouettes
   * positioned at the true settlement/gas-station/barn locations (zero random floating boxes).
   */
  public populateMidChunk(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    ownedGeometries: THREE.BufferGeometry[],
    instancedMeshes: THREE.InstancedMesh[],
  ): number {
    const roadSegments = getRoadSegmentsInChunk(cx, cz);
    if (roadSegments.length > 0) {
      this.buildChunkRoadRibbons(roadSegments, centerX, centerZ, group, ownedGeometries, true);
    }

    const chunkSites = getSitesInChunk(cx, cz);
    const halfChunk = CHUNK_SIZE_M * 0.5;
    const placements: Array<{ lx: number; y: number; lz: number; sx: number; sy: number; sz: number; yaw: number; hex: number }> = [];

    for (let i = 0; i < chunkSites.length; i++) {
      const s = chunkSites[i];
      if (
        s.x < centerX - halfChunk ||
        s.x >= centerX + halfChunk ||
        s.z < centerZ - halfChunk ||
        s.z >= centerZ + halfChunk
      ) {
        continue;
      }
      let sx = 1.0;
      let sy = 1.0;
      let sz = 1.0;
      let hex = HOUSE_WALL_PALETTE[s.variantSeed % HOUSE_WALL_PALETTE.length];
      if (s.kind === 'gas_station') {
        sx = 1.55;
        sy = 1.15;
        sz = 1.65;
        hex = s.brandColorHex ?? 0x8e5446;
      } else if (s.kind === 'barn') {
        sx = 1.45;
        sy = 1.35;
        sz = 1.25;
        hex = 0x7a342a;
      } else if (s.kind === 'checkpoint') {
        sx = 0.65;
        sy = 0.72;
        sz = 0.65;
        hex = 0x6f7372;
      } else if (s.kind === 'camp_outpost') {
        sx = 0.76;
        sy = 0.68;
        sz = 0.76;
        hex = 0x565e45;
      } else if (s.kind === 'house_cabin') {
        sx = 0.85;
        sy = 0.88;
        sz = 0.85;
      }

      placements.push({
        lx: s.x - centerX,
        y: s.groundY - 0.5,
        lz: s.z - centerZ,
        sx,
        sy,
        sz,
        yaw: s.yaw,
        hex,
      });
    }

    if (placements.length === 0) return 0;
    const inst = new THREE.InstancedMesh(this.midSiteGeo, this.midSiteMat, placements.length);
    inst.layers.enable(MACRO_OCCLUDER_LAYER);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      _dummy.position.set(p.lx, p.y, p.lz);
      _dummy.rotation.set(0, p.yaw, 0);
      _dummy.scale.set(p.sx, p.sy, p.sz);
      _dummy.updateMatrix();
      inst.setMatrixAt(i, _dummy.matrix);
      _color.setHex(p.hex);
      inst.setColorAt(i, _color);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    group.add(inst);
    instancedMeshes.push(inst);
    return placements.length;
  }

  // ============================================================================
  // BRIDGE PHYSICS REGISTRATION
  // ============================================================================

  private registerBridgePhysics(
    b: BakedRiverBridge,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
  ): void {
    const slopeAlongZ = (b.endY - b.startY) / Math.max(1, b.lengthM);
    const halfLen = b.lengthM * 0.5;
    const halfW = b.widthM * 0.5;

    // Walkable bridge roadway deck (extended slightly past abutments for seamless ramp transitions)
    outDecks.push({
      cx: b.centerX,
      cz: b.centerZ,
      hx: halfW - 0.15,
      hz: halfLen + 2.4,
      cosY: b.cosY,
      sinY: b.sinY,
      baseY: b.deckY,
      slopeAlongZ,
      thicknessM: 0.7,
      surface: 'asphalt',
    });

    // Side steel guardrails / truss parapets as solid OBBs (blocks players from falling off & gives ballistic cover)
    const t = makeTransform(b.centerX, b.deckY, b.centerZ, b.yaw);
    const bays = Math.max(4, Math.round(b.lengthM / 20));
    const bayLen = b.lengthM / bays;
    for (let i = 0; i < bays; i++) {
      const lz = -halfLen + (i + 0.5) * bayLen;
      const deckYAtZ = b.deckY + lz * slopeAlongZ;
      for (const side of [-1, 1]) {
        const p = localToWorldXZ(t, side * (halfW - 0.18), lz);
        outObbs.push({
          cx: p.x,
          cy: deckYAtZ + 0.65,
          cz: p.z,
          hx: 0.22,
          hy: 0.68,
          hz: bayLen * 0.5 + 0.08,
          cosY: b.cosY,
          sinY: b.sinY,
          surface: 'metal',
          blocksBullets: true,
          blocksPlayer: true,
        });
      }
    }
  }

  // ============================================================================
  // TERRAIN-CONFORMING ROAD RIBBON BUILDER
  // ============================================================================

  private buildChunkRoadRibbons(
    segments: readonly BakedRoadSegment[],
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    ownedGeometries: THREE.BufferGeometry[],
    isMidLod: boolean,
  ): number {
    const halfChunk = CHUNK_SIZE_M * 0.5;
    const byTier: Record<'highway' | 'fob_spur' | 'dirt_trail', { pos: number[]; norm: number[]; uv: number[]; idx: number[]; vc: number }> = {
      highway: { pos: [], norm: [], uv: [], idx: [], vc: 0 },
      fob_spur: { pos: [], norm: [], uv: [], idx: [], vc: 0 },
      dirt_trail: { pos: [], norm: [], uv: [], idx: [], vc: 0 },
    };

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.isBridge) continue;
      if (isMidLod && seg.tier === 'dirt_trail') continue;

      // Own each segment by the chunk containing its midpoint so adjacent chunks never overlap ribbons
      const mx = (seg.ax + seg.bx) * 0.5;
      const mz = (seg.az + seg.bz) * 0.5;
      if (
        mx < centerX - halfChunk ||
        mx >= centerX + halfChunk ||
        mz < centerZ - halfChunk ||
        mz >= centerZ + halfChunk
      ) {
        continue;
      }

      const b = byTier[seg.tier];
      const hw = seg.halfWidthM;
      const subSlices = isMidLod ? 1 : Math.max(2, Math.ceil(seg.lengthM / 8));
      const yLift = seg.tier === 'dirt_trail' ? 0.045 : 0.065;
      const uvRepeatLen = seg.tier === 'dirt_trail' ? 10 : 14;

      // Cross-section offsets: left edge, center crown, right edge
      const crossFrac = isMidLod ? [-1, 1] : [-1, 0, 1];
      const crossCols = crossFrac.length;
      const baseVertex = b.vc;

      for (let s = 0; s <= subSlices; s++) {
        const t = s / subSlices;
        const cx = seg.ax + (seg.bx - seg.ax) * t;
        const cz = seg.az + (seg.bz - seg.az) * t;
        const vCoord = (seg.distFromStartM + seg.lengthM * t) / uvRepeatLen;

        for (let c = 0; c < crossCols; c++) {
          const cf = crossFrac[c];
          const wx = cx + seg.perpX * hw * cf;
          const wz = cz + seg.perpZ * hw * cf;
          const crownBoost = cf === 0 ? 0.035 : 0;
          const wy = Math.max(SEA_LEVEL_M + 0.35, evaluateOpenWorldHeight(wx, wz)) + yLift + crownBoost;

          b.pos.push(wx - centerX, wy, wz - centerZ);
          b.norm.push(0, 1, 0);
          b.uv.push((cf + 1) * 0.5, vCoord);
          b.vc++;
        }
      }

      for (let s = 0; s < subSlices; s++) {
        for (let c = 0; c < crossCols - 1; c++) {
          const r0 = baseVertex + s * crossCols + c;
          const r1 = r0 + 1;
          const r2 = r0 + crossCols;
          const r3 = r2 + 1;
          b.idx.push(r0, r2, r1, r1, r2, r3);
        }
      }
    }

    let created = 0;
    const tierOrder: Array<'highway' | 'fob_spur' | 'dirt_trail'> = ['highway', 'fob_spur', 'dirt_trail'];
    for (const tier of tierOrder) {
      const b = byTier[tier];
      if (b.vc === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setIndex(b.idx);
      geo.computeVertexNormals();
      geo.computeBoundingSphere();

      const mat = isMidLod
        ? this.midRoadMat
        : tier === 'highway'
          ? this.highwayMat
          : tier === 'fob_spur'
            ? this.spurMat
            : this.dirtMat;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = !this.isSoftwareGl && !isMidLod;
      mesh.castShadow = false;
      group.add(mesh);
      ownedGeometries.push(geo);
      created++;
    }
    return created;
  }

  // ============================================================================
  // ENTERABLE SITE BUILDERS (HOUSES, GAS STATIONS, BARNS, CHECKPOINTS)
  // ============================================================================

  private addSolidBox(
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    mat: ArchMaterialKey,
    surface: BodycamSurfaceMaterial,
    lx: number,
    ly: number,
    lz: number,
    sx: number,
    sy: number,
    sz: number,
    r: number,
    g: number,
    b: number,
    blocksPlayer = true,
    blocksBullets = true,
  ): void {
    const p = localToWorldXZ(t, lx, lz);
    const wy = t.wy + ly;
    if (batcher) {
      batcher.addBox(mat, p.x, wy, p.z, sx, sy, sz, t.yaw, r, g, b);
    }
    if (blocksPlayer || blocksBullets) {
      outObbs.push({
        cx: p.x,
        cy: wy,
        cz: p.z,
        hx: sx * 0.5,
        hy: sy * 0.5,
        hz: sz * 0.5,
        cosY: t.cosY,
        sinY: t.sinY,
        surface,
        blocksBullets,
        blocksPlayer,
      });
    }
  }

  /**
   * Builds a wall along local X (at fixed `lz`) with an optional open doorway or waist-high window bay.
   */
  private addWallAlongX(
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    mat: ArchMaterialKey,
    surface: BodycamSurfaceMaterial,
    xMin: number,
    xMax: number,
    lz: number,
    baseY: number,
    wallH: number,
    thick: number,
    r: number,
    g: number,
    b: number,
    opening?: {
      kind: 'door' | 'window';
      center: number;
      width: number;
      sillH?: number;
      topH?: number;
    },
  ): void {
    if (!opening) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        (xMin + xMax) * 0.5,
        baseY + wallH * 0.5,
        lz,
        xMax - xMin,
        wallH,
        thick,
        r,
        g,
        b,
      );
      return;
    }

    const oMin = Math.max(xMin + 0.25, opening.center - opening.width * 0.5);
    const oMax = Math.min(xMax - 0.25, opening.center + opening.width * 0.5);
    const leftW = oMin - xMin;
    const rightW = xMax - oMax;

    if (leftW > 0.08) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        xMin + leftW * 0.5,
        baseY + wallH * 0.5,
        lz,
        leftW,
        wallH,
        thick,
        r,
        g,
        b,
      );
    }
    if (rightW > 0.08) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        oMax + rightW * 0.5,
        baseY + wallH * 0.5,
        lz,
        rightW,
        wallH,
        thick,
        r,
        g,
        b,
      );
    }

    const openW = oMax - oMin;
    const openMid = (oMin + oMax) * 0.5;

    if (opening.kind === 'door') {
      const doorTop = opening.topH ?? 2.38;
      const lintelH = wallH - doorTop;
      if (lintelH > 0.08) {
        this.addSolidBox(
          t,
          batcher,
          outObbs,
          mat,
          surface,
          openMid,
          baseY + doorTop + lintelH * 0.5,
          lz,
          openW,
          lintelH,
          thick,
          r,
          g,
          b,
        );
      }
      // Subtle timber door jamb trim (inset cleanly inside opening so zero overlap with wall/floor/lintel)
      if (batcher) {
        const jambH = Math.max(0.2, doorTop - 0.02);
        const jambY = t.wy + baseY + 0.01 + jambH * 0.5;
        const pL = localToWorldXZ(t, oMin + 0.035, lz);
        const pR = localToWorldXZ(t, oMax - 0.035, lz);
        batcher.addBox('woodTrim', pL.x, jambY, pL.z, 0.06, jambH, thick + 0.05, t.yaw, 0.34, 0.27, 0.22);
        batcher.addBox('woodTrim', pR.x, jambY, pR.z, 0.06, jambH, thick + 0.05, t.yaw, 0.34, 0.27, 0.22);
      }
    } else {
      // Waist-high window bay: lower sill blocks crouching cover + bullets; open middle allows aiming/shooting!
      const sillH = opening.sillH ?? 0.96;
      const winTop = opening.topH ?? 2.16;
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        openMid,
        baseY + sillH * 0.5,
        lz,
        openW,
        sillH,
        thick,
        r,
        g,
        b,
      );
      const lintelH = wallH - winTop;
      if (lintelH > 0.08) {
        this.addSolidBox(
          t,
          batcher,
          outObbs,
          mat,
          surface,
          openMid,
          baseY + winTop + lintelH * 0.5,
          lz,
          openW,
          lintelH,
          thick,
          r,
          g,
          b,
        );
      }
      // Recessed window sill ledge (clear of side pillars and proud of sill top)
      if (batcher) {
        const pMid = localToWorldXZ(t, openMid, lz);
        batcher.addBox('woodTrim', pMid.x, t.wy + baseY + sillH + 0.03, pMid.z, Math.max(0.2, openW - 0.02), 0.06, thick + 0.12, t.yaw, 0.38, 0.33, 0.28);
      }
    }
  }

  /**
   * Builds a wall along local Z (at fixed `lx`) with an optional open doorway or waist-high window bay.
   */
  private addWallAlongZ(
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    mat: ArchMaterialKey,
    surface: BodycamSurfaceMaterial,
    zMin: number,
    zMax: number,
    lx: number,
    baseY: number,
    wallH: number,
    thick: number,
    r: number,
    g: number,
    b: number,
    opening?: {
      kind: 'door' | 'window';
      center: number;
      width: number;
      sillH?: number;
      topH?: number;
    },
  ): void {
    if (!opening) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        lx,
        baseY + wallH * 0.5,
        (zMin + zMax) * 0.5,
        thick,
        wallH,
        zMax - zMin,
        r,
        g,
        b,
      );
      return;
    }

    const oMin = Math.max(zMin + 0.25, opening.center - opening.width * 0.5);
    const oMax = Math.min(zMax - 0.25, opening.center + opening.width * 0.5);
    const backLen = oMin - zMin;
    const frontLen = zMax - oMax;

    if (backLen > 0.08) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        lx,
        baseY + wallH * 0.5,
        zMin + backLen * 0.5,
        thick,
        wallH,
        backLen,
        r,
        g,
        b,
      );
    }
    if (frontLen > 0.08) {
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        lx,
        baseY + wallH * 0.5,
        oMax + frontLen * 0.5,
        thick,
        wallH,
        frontLen,
        r,
        g,
        b,
      );
    }

    const openW = oMax - oMin;
    const openMid = (oMin + oMax) * 0.5;

    if (opening.kind === 'door') {
      const doorTop = opening.topH ?? 2.38;
      const lintelH = wallH - doorTop;
      if (lintelH > 0.08) {
        this.addSolidBox(
          t,
          batcher,
          outObbs,
          mat,
          surface,
          lx,
          baseY + doorTop + lintelH * 0.5,
          openMid,
          thick,
          lintelH,
          openW,
          r,
          g,
          b,
        );
      }
      if (batcher) {
        const jambH = Math.max(0.2, doorTop - 0.02);
        const jambY = t.wy + baseY + 0.01 + jambH * 0.5;
        const pB = localToWorldXZ(t, lx, oMin + 0.035);
        const pF = localToWorldXZ(t, lx, oMax - 0.035);
        batcher.addBox('woodTrim', pB.x, jambY, pB.z, thick + 0.05, jambH, 0.06, t.yaw, 0.34, 0.27, 0.22);
        batcher.addBox('woodTrim', pF.x, jambY, pF.z, thick + 0.05, jambH, 0.06, t.yaw, 0.34, 0.27, 0.22);
      }
    } else {
      const sillH = opening.sillH ?? 0.96;
      const winTop = opening.topH ?? 2.16;
      this.addSolidBox(
        t,
        batcher,
        outObbs,
        mat,
        surface,
        lx,
        baseY + sillH * 0.5,
        openMid,
        thick,
        sillH,
        openW,
        r,
        g,
        b,
      );
      const lintelH = wallH - winTop;
      if (lintelH > 0.08) {
        this.addSolidBox(
          t,
          batcher,
          outObbs,
          mat,
          surface,
          lx,
          baseY + winTop + lintelH * 0.5,
          openMid,
          thick,
          lintelH,
          openW,
          r,
          g,
          b,
        );
      }
      if (batcher) {
        const pMid = localToWorldXZ(t, lx, openMid);
        batcher.addBox('woodTrim', pMid.x, t.wy + baseY + sillH + 0.03, pMid.z, thick + 0.12, 0.06, Math.max(0.2, openW - 0.02), t.yaw, 0.38, 0.33, 0.28);
      }
    }
  }

  private buildSite(
    site: BakedOpenWorldSite,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
    lightsOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
    barriersOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    const t = makeTransform(site.x, site.groundY, site.z, site.yaw);
    switch (site.kind) {
      case 'house_cabin':
        this.buildHouse(site, t, 7.6, 6.4, 3.05, false, false, batcher, outObbs, outDecks, outIndoor, vehiclesOut);
        break;
      case 'house_bungalow':
        this.buildHouse(site, t, 10.4, 7.6, 3.15, true, false, batcher, outObbs, outDecks, outIndoor, vehiclesOut);
        break;
      case 'house_homestead':
        this.buildHouse(site, t, 11.4, 8.2, 3.2, true, true, batcher, outObbs, outDecks, outIndoor, vehiclesOut);
        break;
      case 'gas_station':
        this.buildGasStation(site, t, batcher, outObbs, outDecks, outIndoor, vehiclesOut, lightsOut);
        break;
      case 'barn':
        this.buildBarn(site, t, batcher, outObbs, outDecks, outIndoor, vehiclesOut);
        break;
      case 'checkpoint':
        this.buildCheckpoint(site, t, batcher, outObbs, outDecks, outIndoor, lightsOut, barriersOut);
        break;
      case 'camp_outpost':
        this.buildCampOutpost(site, t, batcher, outObbs, outDecks, outIndoor, vehiclesOut, barriersOut);
        break;
    }
  }

  private buildHouse(
    site: BakedOpenWorldSite,
    t: LocalTransform,
    widthX: number,
    depthZ: number,
    wallH: number,
    twoRoom: boolean,
    hasPorch: boolean,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
  ): void {
    const [wr, wg, wb] = hexToRgbTuple(HOUSE_WALL_PALETTE[site.variantSeed % HOUSE_WALL_PALETTE.length]);
    const [rr, rg, rb] = hexToRgbTuple(ROOF_METAL_PALETTE[(site.variantSeed + 1) % ROOF_METAL_PALETTE.length]);
    const hx = widthX * 0.5;
    const hz = depthZ * 0.5;
    const floorTopY = 0.24;
    const thick = 0.26;

    // 1. Deep Concrete Foundation Plinth (top = t.wy + 0.15, supporting wood floor slab [0.15..0.24] with zero overlap)
    if (batcher) {
      batcher.addBox('concrete', t.wx, t.wy - 0.85, t.wz, widthX + 0.3, 2.0, depthZ + 0.3, t.yaw, 0.62, 0.63, 0.60);
      // Warm timber interior floor deck sitting cleanly atop foundation plinth
      batcher.addBox('barnWood', t.wx, t.wy + 0.195, t.wz, widthX - 0.16, 0.09, depthZ - 0.16, t.yaw, 0.68, 0.54, 0.40);
    }

    // Walkable interior floor + entry threshold
    outDecks.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx + 0.35,
      hz: hz + (hasPorch ? 1.8 : 0.45),
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorTopY,
      slopeAlongZ: 0,
      thicknessM: 0.3,
      surface: 'wood',
    });

    // Front Porch deck & posts for homesteads (starts cleanly outside house foundation plinth at hz + 0.15)
    if (hasPorch && batcher) {
      const porchFound = localToWorldXZ(t, 0, hz + 1.0);
      const porchRoof = localToWorldXZ(t, 0, hz + 0.9);
      batcher.addBox('concrete', porchFound.x, t.wy - 0.80, porchFound.z, widthX * 0.72, 2.0, 1.70, t.yaw, 0.60, 0.61, 0.59);
      // Porch canopy & 2 slender timber posts seated on porch deck (top 0.20) up to canopy underside
      batcher.addBox('roofMetal', porchRoof.x, t.wy + floorTopY + 2.68, porchRoof.z, widthX * 0.74, 0.16, 1.95, t.yaw, rr, rg, rb);
      for (const px of [-widthX * 0.31, widthX * 0.31]) {
        const pp = localToWorldXZ(t, px, hz + 1.68);
        batcher.addBox('woodTrim', pp.x, t.wy + 0.20 + 1.32, pp.z, 0.18, 2.64, 0.18, t.yaw, 0.45, 0.36, 0.28);
      }
    }

    // 2. Exterior Walls with Open Front Doorway (+Z), Waist-High Windows & Rear Door (for 2-room houses)
    const frontDoorW = 1.55;
    this.addWallAlongX(t, batcher, outObbs, 'wallSiding', 'wood', -hx, hx, hz - thick * 0.5, floorTopY, wallH, thick, wr, wg, wb, {
      kind: 'door',
      center: 0,
      width: frontDoorW,
      topH: 2.38,
    });

    // Rear wall (-Z): Rear escape door for 2-room houses, window for 1-room cabins
    this.addWallAlongX(
      t,
      batcher,
      outObbs,
      'wallSiding',
      'wood',
      -hx,
      hx,
      -hz + thick * 0.5,
      floorTopY,
      wallH,
      thick,
      wr,
      wg,
      wb,
      twoRoom
        ? { kind: 'door', center: -hx * 0.35, width: 1.48, topH: 2.35 }
        : { kind: 'window', center: 0, width: 1.85, sillH: 0.96, topH: 2.16 },
    );

    // Left (-X) & Right (+X) exterior walls with waist-high shooting windows
    this.addWallAlongZ(t, batcher, outObbs, 'wallSiding', 'wood', -hz + thick, hz - thick, -hx + thick * 0.5, floorTopY, wallH, thick, wr, wg, wb, {
      kind: 'window',
      center: 0,
      width: 1.8,
      sillH: 0.96,
      topH: 2.16,
    });
    this.addWallAlongZ(t, batcher, outObbs, 'wallSiding', 'wood', -hz + thick, hz - thick, hx - thick * 0.5, floorTopY, wallH, thick, wr, wg, wb, {
      kind: 'window',
      center: 0,
      width: 1.8,
      sillH: 0.96,
      topH: 2.16,
    });

    // 3. Interior Room Partition with Open Pass-Through Doorway (for 2-room bungalows & homesteads)
    if (twoRoom) {
      this.addWallAlongZ(
        t,
        batcher,
        outObbs,
        'wallSiding',
        'wood',
        -hz + thick,
        hz - thick,
        0.5,
        floorTopY,
        wallH - 0.08,
        0.18,
        wr * 0.92,
        wg * 0.92,
        wb * 0.92,
        { kind: 'door', center: 0.4, width: 1.5, topH: 2.32 },
      );
    }

    // 4. Ceiling / Pitched Gable Roof + Overhead Ballistic Slab
    const eaveY = t.wy + floorTopY + wallH;
    if (batcher) {
      batcher.addGableRoof(
        'roofMetal',
        'wallSiding',
        t.wx,
        eaveY,
        t.wz,
        widthX,
        depthZ,
        Math.min(2.3, depthZ * 0.28),
        t.yaw,
        rr,
        rg,
        rb,
        wr * 0.95,
        wg * 0.95,
        wb * 0.95,
      );
    }
    // Roof solid OBB stops bullets from above & enforces indoor ceiling clearance
    outObbs.push({
      cx: t.wx,
      cy: eaveY + 0.22,
      cz: t.wz,
      hx: hx + 0.3,
      hy: 0.22,
      hz: hz + 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      surface: 'metal',
      blocksBullets: true,
      blocksPlayer: true,
    });

    // 5. Interior Tactical Cover & Micro-Clutter (Wooden Table, Stacked Supply Crate, Wall Cabinet & Rear Bench)
    this.addSolidBox(
      t,
      batcher,
      outObbs,
      'woodTrim',
      'wood',
      -hx + 1.35,
      floorTopY + 0.48,
      hz - 1.55,
      1.3,
      0.96,
      0.85,
      0.52,
      0.40,
      0.28,
    );
    // Supply crate cleanly inset atop front-left table (zero coplanar faces)
    this.addSolidBox(
      t,
      batcher,
      outObbs,
      'woodTrim',
      'wood',
      -hx + 1.35,
      floorTopY + 0.96 + 0.20,
      hz - 1.55,
      0.58,
      0.40,
      0.42,
      0.38,
      0.42,
      0.28,
      false,
      true,
    );
    // Upgraded bungalow lived-in interior dressing: dining chairs, kitchen counter, wall cabinet & exposed timber rafters
    if (batcher) {
      const c1 = localToWorldXZ(t, -hx + 2.28, hz - 1.55);
      batcher.addBox('woodTrim', c1.x, t.wy + floorTopY + 0.26, c1.z, 0.44, 0.52, 0.44, t.yaw + 0.22, 0.44, 0.34, 0.24);
      const c2 = localToWorldXZ(t, -hx + 1.35, hz - 2.38);
      batcher.addBox('woodTrim', c2.x, t.wy + floorTopY + 0.26, c2.z, 0.44, 0.52, 0.44, t.yaw - 0.18, 0.44, 0.34, 0.24);
      // Upper wall cupboard mounted cleanly above the right-rear kitchen counter
      const kPos = localToWorldXZ(t, hx - 1.35, -hz + 0.72);
      batcher.addBox('steel', kPos.x, t.wy + floorTopY + 1.82, kPos.z, 1.12, 0.62, 0.40, t.yaw, 0.62, 0.64, 0.62);
      // Exposed overhead ceiling rafters
      for (const rz of [-hz * 0.45, 0, hz * 0.45]) {
        const rp = localToWorldXZ(t, 0, rz);
        batcher.addBox('woodTrim', rp.x, t.wy + floorTopY + wallH - 0.12, rp.z, widthX - 0.5, 0.14, 0.14, t.yaw, 0.34, 0.26, 0.19);
      }
    }
    this.addSolidBox(
      t,
      batcher,
      outObbs,
      'woodTrim',
      'wood',
      hx - 1.35,
      floorTopY + 0.44,
      -hz + 1.35,
      1.15,
      0.88,
      0.95,
      0.48,
      0.38,
      0.26,
    );
    // Tall steel/timber storage locker in front-right corner (clear of front doorway)
    this.addSolidBox(
      t,
      batcher,
      outObbs,
      'steel',
      'metal',
      hx - 1.15,
      floorTopY + 0.85,
      hz - 1.45,
      0.76,
      1.70,
      0.62,
      0.36,
      0.40,
      0.42,
    );
    // Back-left wooden chest/bench (clear of rear door & left wall)
    this.addSolidBox(
      t,
      batcher,
      outObbs,
      'woodTrim',
      'wood',
      -hx + 1.05,
      floorTopY + 0.36,
      -hz + 1.15,
      1.05,
      0.72,
      0.62,
      0.46,
      0.35,
      0.24,
    );

    // 6. Indoor Acoustic Volume
    outIndoor.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx - 0.28,
      hz: hz - 0.28,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorTopY - 0.1,
      maxY: eaveY + 0.2,
      material: 'wood',
    });

    // 7. Occasional parked civilian car beside larger homesteads/bungalows
    if (vehiclesOut && site.variantSeed % 3 === 0) {
      const vp = localToWorldXZ(t, hx + 3.4, 1.5);
      const vy = evaluateOpenWorldHeight(vp.x, vp.z);
      const colorHex = VEHICLE_BODY_PALETTE[site.variantSeed % VEHICLE_BODY_PALETTE.length];
      vehiclesOut.push({ wx: vp.x, wy: vy, wz: vp.z, yaw: t.yaw + 0.08, colorHex });
    }
  }

  private buildGasStation(
    site: BakedOpenWorldSite,
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
    lightsOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    const [br, bg, bb] = hexToRgbTuple(site.brandColorHex ?? 0xb93829);
    const padTopY = 0.12;

    // 1. Wide Concrete Forecourt Slab (-1.8m subterranean skirt) + WalkDeck
    if (batcher) {
      batcher.addBox('concrete', t.wx, t.wy - 0.88, t.wz, 26.0, 2.0, 22.0, t.yaw, 0.72, 0.73, 0.71);
    }
    outDecks.push({
      cx: t.wx,
      cz: t.wz,
      hx: 13.0,
      hz: 11.0,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + padTopY,
      slopeAlongZ: 0,
      thicknessM: 0.3,
      surface: 'concrete',
    });

    // 2. Drive-Under Illuminated Canopy (+4.8m Z in front of mini-mart)
    const canopyZ = 4.8;
    const canopyH = 4.65;
    // 4 steel structural canopy columns (solid ballistic cover)
    for (const px of [-4.6, 4.6]) {
      for (const pz of [canopyZ - 2.4, canopyZ + 2.4]) {
        this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', px, padTopY + canopyH * 0.5, pz, 0.44, canopyH, 0.44, 0.78, 0.80, 0.82);
      }
    }
    // Canopy roof slab + vibrant brand fascia trim (inset vertically inside slab height to avoid coplanar top) + soffit lights
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'metal', 0, padTopY + canopyH + 0.32, canopyZ, 14.4, 0.56, 9.2, 0.84, 0.85, 0.86);
    if (batcher) {
      const cp = localToWorldXZ(t, 0, canopyZ);
      batcher.addBox('fasciaTint', cp.x, t.wy + padTopY + canopyH + 0.32, cp.z, 14.65, 0.44, 9.45, t.yaw, br, bg, bb);
      // 4 glowing soffit ceiling fixtures under canopy (no PointLights!)
      for (const lx of [-3.6, 0, 3.6]) {
        const lp = localToWorldXZ(t, lx, canopyZ);
        batcher.addBox('emissiveCanopy', lp.x, t.wy + padTopY + canopyH - 0.01, lp.z, 1.5, 0.06, 3.2, t.yaw, 1, 1, 1);
      }
    }

    // 3. Dual Fuel Pump Islands with 4 Multi-Part Dispensers (solid metal cover!)
    for (const islandX of [-3.2, 3.2]) {
      // Concrete curb island
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', islandX, padTopY + 0.14, canopyZ, 1.45, 0.28, 6.2, 0.66, 0.68, 0.68, false, true);
      for (const pumpZ of [canopyZ - 1.5, canopyZ + 1.5]) {
        // Fuel dispenser cabinet
        this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', islandX, padTopY + 0.96, pumpZ, 0.76, 1.65, 0.96, 0.88, 0.88, 0.86);
        if (batcher) {
          const dp = localToWorldXZ(t, islandX, pumpZ);
          batcher.addBox('fasciaTint', dp.x, t.wy + padTopY + 1.68, dp.z, 0.80, 0.32, 1.0, t.yaw, br, bg, bb);
        }
      }
      // Protective yellow steel bollards at island ends
      for (const bz of [canopyZ - 2.85, canopyZ + 2.85]) {
        this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', islandX, padTopY + 0.52, bz, 0.22, 1.0, 0.22, 0.86, 0.68, 0.16);
      }
    }

    // 4. Roadside Fuel Price Pylon Sign (corner of forecourt)
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 10.6, padTopY + 3.6, 8.6, 0.45, 7.2, 0.45, 0.56, 0.60, 0.64);
    if (batcher) {
      const py = localToWorldXZ(t, 10.6, 8.6);
      batcher.addBox('fasciaTint', py.x, t.wy + padTopY + 6.4, py.z, 2.5, 2.2, 0.48, t.yaw, br, bg, bb);
      batcher.addBox('emissiveCanopy', py.x, t.wy + padTopY + 6.3, py.z, 2.1, 1.35, 0.54, t.yaw, 1, 1, 1);
    }

    // 5. Enterable Mini-Mart Store Building (12.4m × 7.6m at -6.2m Z)
    const storeZ = -6.2;
    const storeW = 12.4;
    const storeD = 7.6;
    const shx = storeW * 0.5;
    const shz = storeD * 0.5;
    const storeFloorY = padTopY + 0.12;
    const storeH = 3.35;
    const wt = 0.28;

    // Front wall facing forecourt (+Z): Wide 2.1m open entrance door + left/right panoramic waist-high windows
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', -shx, -1.05, storeZ + shz - wt * 0.5, storeFloorY, storeH, wt, 0.80, 0.79, 0.76, {
      kind: 'window',
      center: -3.6,
      width: 3.1,
      sillH: 0.96,
      topH: 2.3,
    });
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', 1.05, shx, storeZ + shz - wt * 0.5, storeFloorY, storeH, wt, 0.80, 0.79, 0.76, {
      kind: 'window',
      center: 3.6,
      width: 3.1,
      sillH: 0.96,
      topH: 2.3,
    });
    // Overhead door lintel above the 2.1m entrance gap [-1.05, +1.05]
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', 0, storeFloorY + 2.4 + (storeH - 2.4) * 0.5, storeZ + shz - wt * 0.5, 2.1, storeH - 2.4, wt, 0.80, 0.79, 0.76);

    // Back wall (-Z): solid concrete with rear high window
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', -shx, shx, storeZ - shz + wt * 0.5, storeFloorY, storeH, wt, 0.76, 0.75, 0.72, {
      kind: 'window',
      center: 2.2,
      width: 2.0,
      sillH: 1.1,
      topH: 2.2,
    });

    // Left side wall (-X): Rear side escape door (1.55m wide) for flanking!
    this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', storeZ - shz + wt, storeZ + shz - wt, -shx + wt * 0.5, storeFloorY, storeH, wt, 0.78, 0.77, 0.74, {
      kind: 'door',
      center: storeZ - 1.1,
      width: 1.55,
      topH: 2.35,
    });

    // Right side wall (+X): Waist-high side window
    this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', storeZ - shz + wt, storeZ + shz - wt, shx - wt * 0.5, storeFloorY, storeH, wt, 0.78, 0.77, 0.74, {
      kind: 'window',
      center: storeZ + 0.4,
      width: 2.2,
      sillH: 0.98,
      topH: 2.18,
    });

    // Store floor plinth sitting cleanly atop forecourt pad [padTopY .. storeFloorY]
    if (batcher) {
      const sp = localToWorldXZ(t, 0, storeZ);
      batcher.addBox('concreteDark', sp.x, t.wy + padTopY + 0.06, sp.z, storeW + 0.1, 0.12, storeD + 0.1, t.yaw, 0.60, 0.62, 0.61);
    }

    // Store flat roof slab + brand fascia stripe (inset vertically inside slab height) + rooftop AC unit
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', 0, storeFloorY + storeH + 0.22, storeZ, storeW + 0.6, 0.44, storeD + 0.6, 0.50, 0.52, 0.54);
    if (batcher) {
      const sp = localToWorldXZ(t, 0, storeZ);
      batcher.addBox('fasciaTint', sp.x, t.wy + storeFloorY + storeH + 0.22, sp.z, storeW + 0.72, 0.32, storeD + 0.72, t.yaw, br, bg, bb);
      const ac = localToWorldXZ(t, 3.2, storeZ - 1.0);
      batcher.addBox('steel', ac.x, t.wy + storeFloorY + storeH + 0.915, ac.z, 1.8, 0.95, 1.4, t.yaw, 0.62, 0.65, 0.67);
    }

    // Interior Store Props: L-Checkout Counter + Register, Merch Shelving, Beverage Cooler, Storage Rack & Partition
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -3.4, storeFloorY + 0.52, storeZ + 1.4, 2.8, 1.04, 0.72, 0.56, 0.44, 0.32);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', -3.85, storeFloorY + 1.04 + 0.21, storeZ + 1.4, 0.54, 0.42, 0.44, 0.26, 0.28, 0.30, false, true);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 1.4, storeFloorY + 0.82, storeZ + 0.6, 0.62, 1.64, 2.8, 0.62, 0.66, 0.68);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 3.9, storeFloorY + 0.82, storeZ + 0.6, 0.62, 1.64, 2.8, 0.62, 0.66, 0.68);
    // Rear beverage cooler cabinet (clear of rear window at x=2.2 and right wall)
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 4.5, storeFloorY + 1.02, storeZ - shz + 0.84, 1.9, 2.04, 0.72, 0.72, 0.78, 0.82);
    // Back storage room supply rack
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.2, storeFloorY + 0.85, storeZ - 2.65, 1.75, 1.70, 0.62, 0.46, 0.38, 0.28);
    // Upgraded store interior dressing: stocked merchandise layers, ceiling conduit beams & backroom pallet stack
    if (batcher) {
      for (const sx of [1.4, 3.9]) {
        for (const szOff of [-0.75, 0.1, 0.85]) {
          const mp = localToWorldXZ(t, sx, storeZ + 0.6 + szOff);
          batcher.addBox('fasciaTint', mp.x, t.wy + storeFloorY + 1.78, mp.z, 0.44, 0.26, 0.56, t.yaw, 0.68, 0.34, 0.24);
        }
      }
      // Overhead steel ceiling beams & electrical tray
      for (const bz of [storeZ - 1.8, storeZ + 0.4, storeZ + 2.4]) {
        const bp = localToWorldXZ(t, 0, bz);
        batcher.addBox('steel', bp.x, t.wy + storeFloorY + storeH - 0.1, bp.z, storeW - 0.6, 0.12, 0.14, t.yaw, 0.36, 0.40, 0.44);
      }
      // Backroom wooden supply pallet
      const pal = localToWorldXZ(t, -2.5, storeZ - 2.6);
      batcher.addBox('woodTrim', pal.x, t.wy + storeFloorY + 0.08, pal.z, 1.05, 0.16, 1.05, t.yaw, 0.54, 0.42, 0.28);
      batcher.addBox('woodTrim', pal.x, t.wy + storeFloorY + 0.42, pal.z, 0.72, 0.52, 0.68, t.yaw + 0.14, 0.48, 0.38, 0.26);
    }
    // Back storage room partition with open pass-through
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', -shx + wt, 0.4, storeZ - 1.5, storeFloorY, storeH - 0.1, 0.18, 0.74, 0.74, 0.72, {
      kind: 'door',
      center: -1.4,
      width: 1.5,
      topH: 2.3,
    });
    // Exterior propane cylinder exchange cage cleanly outside +X store wall
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', shx + 0.95, padTopY + 0.72, storeZ - 1.8, 1.2, 1.44, 1.8, 0.64, 0.68, 0.70);

    // Store interior acoustic volume
    const storeWorldCenter = localToWorldXZ(t, 0, storeZ);
    outIndoor.push({
      cx: storeWorldCenter.x,
      cz: storeWorldCenter.z,
      hx: shx - 0.3,
      hz: shz - 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + storeFloorY - 0.1,
      maxY: t.wy + storeFloorY + storeH + 0.15,
      material: 'concrete',
    });

    // Rear industrial steel dumpster (solid tactical cover)
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', -shx - 2.1, padTopY + 0.78, storeZ - 1.6, 1.75, 1.55, 2.4, 0.25, 0.36, 0.28);

    // Parked forecourt abandoned car + perimeter streetlights
    if (vehiclesOut) {
      const vp = localToWorldXZ(t, -7.8, canopyZ + 0.8);
      vehiclesOut.push({
        wx: vp.x,
        wy: t.wy + padTopY,
        wz: vp.z,
        yaw: t.yaw + 0.15,
        colorHex: VEHICLE_BODY_PALETTE[(site.variantSeed + 2) % VEHICLE_BODY_PALETTE.length],
      });
    }
    if (lightsOut) {
      const l1 = localToWorldXZ(t, -10.8, 8.8);
      const l2 = localToWorldXZ(t, 10.2, -3.5);
      lightsOut.push({ wx: l1.x, wy: t.wy + padTopY, wz: l1.z, yaw: t.yaw + Math.PI * 0.75 });
      lightsOut.push({ wx: l2.x, wy: t.wy + padTopY, wz: l2.z, yaw: t.yaw - Math.PI * 0.5 });
    }
  }

  private buildBarn(
    site: BakedOpenWorldSite,
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
  ): void {
    const widthX = 13.6;
    const depthZ = 9.8;
    const hx = widthX * 0.5;
    const hz = depthZ * 0.5;
    const floorY = 0.2;
    const wallH = 4.6;
    const wt = 0.28;

    // Weathered rustic oxide red or weathered timber barn color
    const isRedBarn = site.variantSeed % 2 === 0;
    const wr = isRedBarn ? 0.58 : 0.48;
    const wg = isRedBarn ? 0.24 : 0.40;
    const wb = isRedBarn ? 0.20 : 0.32;

    if (batcher) {
      batcher.addBox('concrete', t.wx, t.wy - 0.88, t.wz, widthX + 0.3, 2.0, depthZ + 0.3, t.yaw, 0.58, 0.58, 0.56);
      batcher.addBox('barnWood', t.wx, t.wy + 0.16, t.wz, widthX - 0.16, 0.08, depthZ - 0.16, t.yaw, 0.56, 0.45, 0.34);
    }

    outDecks.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx + 0.3,
      hz: hz + 0.4,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorY,
      slopeAlongZ: 0,
      thicknessM: 0.28,
      surface: 'wood',
    });

    // Wide 2.8m open front (+Z) & rear (-Z) barn doorways
    this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', -hx, hx, hz - wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: 0,
      width: 2.8,
      topH: 3.1,
    });
    this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', -hx, hx, -hz + wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: 0,
      width: 2.8,
      topH: 3.1,
    });

    // Left & Right side walls with waist-high windows
    this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', -hz + wt, hz - wt, -hx + wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'window',
      center: 0,
      width: 2.2,
      sillH: 1.0,
      topH: 2.25,
    });
    this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', -hz + wt, hz - wt, hx - wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'window',
      center: 0,
      width: 2.2,
      sillH: 1.0,
      topH: 2.25,
    });

    // Steep pitched barn roof + solid roof OBB
    const eaveY = t.wy + floorY + wallH;
    if (batcher) {
      batcher.addGableRoof('roofMetal', 'barnWood', t.wx, eaveY, t.wz, widthX, depthZ, 3.1, t.yaw, 0.42, 0.45, 0.48, wr, wg, wb);
    }
    outObbs.push({
      cx: t.wx,
      cy: eaveY + 0.25,
      cz: t.wz,
      hx: hx + 0.35,
      hy: 0.25,
      hz: hz + 0.35,
      cosY: t.cosY,
      sinY: t.sinY,
      surface: 'metal',
      blocksBullets: true,
      blocksPlayer: true,
    });

    // Interior hay bales, stacked upper bale, workbench & timber crates for tactical gunfight cover
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.2, floorY + 0.65, 1.8, 1.9, 1.3, 1.4, 0.68, 0.58, 0.30);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.2, floorY + 1.3 + 0.42, 1.8, 1.35, 0.84, 1.0, 0.72, 0.61, 0.32, false, true);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', 4.1, floorY + 0.65, -1.6, 1.8, 1.3, 1.8, 0.64, 0.54, 0.28);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.0, floorY + 0.55, -2.6, 1.5, 1.1, 1.3, 0.48, 0.38, 0.26);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', 4.4, floorY + 0.48, 2.6, 2.1, 0.96, 0.82, 0.44, 0.34, 0.24);

    outIndoor.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx - 0.3,
      hz: hz - 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorY - 0.1,
      maxY: eaveY + 0.2,
      material: 'wood',
    });

    if (vehiclesOut) {
      const vp = localToWorldXZ(t, hx + 3.8, -1.2);
      vehiclesOut.push({
        wx: vp.x,
        wy: evaluateOpenWorldHeight(vp.x, vp.z),
        wz: vp.z,
        yaw: t.yaw + 1.42,
        colorHex: 0x4f5d47,
      });
    }
  }

  private buildCheckpoint(
    site: BakedOpenWorldSite,
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    lightsOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
    barriersOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    // Checkpoint sits across road (local Z = road direction, local X = across road).
    // Guard shack sits on right shoulder (+6.8m X) with open doorway & 360° observation windows.
    const gx = 6.8;
    const gw = 4.4;
    const gd = 4.2;
    const floorY = 0.18;
    const wallH = 2.95;
    const wt = 0.24;

    if (batcher) {
      const gp = localToWorldXZ(t, gx, 0);
      batcher.addBox('concrete', gp.x, t.wy - 0.85, gp.z, gw + 0.3, 2.04, gd + 0.3, t.yaw, 0.58, 0.60, 0.58);
    }

    const shackCenter = localToWorldXZ(t, gx, 0);
    outDecks.push({
      cx: shackCenter.x,
      cz: shackCenter.z,
      hx: gw * 0.5 + 0.3,
      hz: gd * 0.5 + 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorY,
      slopeAlongZ: 0,
      thicknessM: 0.25,
      surface: 'concrete',
    });

    // Road-facing wall (-X of shack): open 1.5m doorway
    this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', -gd * 0.5, gd * 0.5, gx - gw * 0.5 + wt * 0.5, floorY, wallH, wt, 0.64, 0.66, 0.63, {
      kind: 'door',
      center: 0,
      width: 1.5,
      topH: 2.3,
    });
    // Back wall (+X of shack): solid with high slot
    this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', -gd * 0.5, gd * 0.5, gx + gw * 0.5 - wt * 0.5, floorY, wallH, wt, 0.62, 0.64, 0.61);
    // Front (+Z) & Rear (-Z) observation window walls
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', gx - gw * 0.5 + wt, gx + gw * 0.5 - wt, gd * 0.5 - wt * 0.5, floorY, wallH, wt, 0.64, 0.66, 0.63, {
      kind: 'window',
      center: gx,
      width: 2.3,
      sillH: 1.0,
      topH: 2.15,
    });
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', gx - gw * 0.5 + wt, gx + gw * 0.5 - wt, -gd * 0.5 + wt * 0.5, floorY, wallH, wt, 0.64, 0.66, 0.63, {
      kind: 'window',
      center: gx,
      width: 2.3,
      sillH: 1.0,
      topH: 2.15,
    });
    // Flat roof overhang + interior tactical desk & comms radio terminal
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', gx, floorY + wallH + 0.16, 0, gw + 0.9, 0.32, gd + 0.9, 0.44, 0.47, 0.48);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', gx + 1.1, floorY + 0.46, 0.9, 1.1, 0.92, 0.72, 0.46, 0.38, 0.28);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', gx + 1.1, floorY + 0.92 + 0.18, 0.9, 0.56, 0.36, 0.40, 0.26, 0.30, 0.32, false, true);

    outIndoor.push({
      cx: shackCenter.x,
      cz: shackCenter.z,
      hx: gw * 0.5 - 0.26,
      hz: gd * 0.5 - 0.26,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorY - 0.1,
      maxY: t.wy + floorY + wallH + 0.15,
      material: 'concrete',
    });

    // Opposite HESCO / sandbag firing bastion (-6.4m X, side wings flush-butted to -5.35 without overlap) + rear ammo crate stack
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -6.4, 0.62, 0, 2.1, 1.24, 4.4, 0.64, 0.58, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -4.5, 0.62, 2.2, 1.7, 1.24, 1.2, 0.64, 0.58, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -4.5, 0.62, -2.2, 1.7, 1.24, 1.2, 0.64, 0.58, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -8.25, 0.44, 0, 1.1, 0.88, 1.75, 0.42, 0.44, 0.30);

    // Striped Counterweight Boom Gate Pedestal + Overhead Gate Arm (raised 2.6m clear so operators walk freely beneath)
    this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', 4.3, 0.65, 0, 0.62, 1.3, 0.62, 0.82, 0.22, 0.18);
    if (batcher) {
      const armP = localToWorldXZ(t, 0.4, 0);
      batcher.addBox('fasciaTint', armP.x, t.wy + 2.75, armP.z, 7.6, 0.14, 0.14, t.yaw, 0.88, 0.22, 0.18);
      // Floodlight tower mast next to guard shack
      const flP = localToWorldXZ(t, gx + 1.6, -gd * 0.5 - 1.2);
      batcher.addBox('steel', flP.x, t.wy + 3.8, flP.z, 0.24, 7.6, 0.24, t.yaw, 0.46, 0.50, 0.54);
      batcher.addBox('emissiveFlood', flP.x, t.wy + 7.55, flP.z, 1.1, 0.42, 0.36, t.yaw, 1, 1, 1);
    }

    // Angled Jersey Barrier S-Chicane (2 barriers left/front, 2 barriers right/rear — wide weaving pass-through!)
    const chicaneDefs = [
      { lx: -2.2, lz: 5.5, dyaw: 0.32 },
      { lx: 2.2, lz: -5.5, dyaw: 0.32 },
    ];
    for (const c of chicaneDefs) {
      const bp = localToWorldXZ(t, c.lx, c.lz);
      const by = evaluateOpenWorldHeight(bp.x, bp.z);
      const bYaw = t.yaw + Math.PI * 0.5 + c.dyaw;
      if (barriersOut) {
        barriersOut.push({ wx: bp.x, wy: by, wz: bp.z, yaw: bYaw });
      }
      outObbs.push({
        cx: bp.x,
        cy: by + 0.52,
        cz: bp.z,
        hx: 0.35,
        hy: 0.52,
        hz: 1.45,
        cosY: Math.cos(bYaw),
        sinY: Math.sin(bYaw),
        surface: 'concrete',
        blocksBullets: true,
        blocksPlayer: true,
      });
    }

    if (lightsOut) {
      const lp = localToWorldXZ(t, -6.2, 5.0);
      lightsOut.push({ wx: lp.x, wy: t.wy, wz: lp.z, yaw: t.yaw + Math.PI * 0.5 });
    }
    void site;
  }

  /**
   * Enterable roadside militia/logging field camp outpost:
   * - Walk-in timber/canvas field shelter with open doorway, rear observation window & indoor wood acoustics
   * - Front sandbag/HESCO firing barricade, stacked supply pallets, fuel drums, floodlight mast & parked utility truck
   */
  private buildCampOutpost(
    site: BakedOpenWorldSite,
    t: LocalTransform,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
    barriersOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    const widthX = 6.2;
    const depthZ = 4.6;
    const hx = widthX * 0.5;
    const hz = depthZ * 0.5;
    const floorY = 0.16;
    const wallH = 2.75;
    const wt = 0.2;

    // Olive-drab militia camp vs weathered timber logging camp tint
    const isMilitia = site.variantSeed % 2 === 1;
    const wr = isMilitia ? 0.36 : 0.50;
    const wg = isMilitia ? 0.40 : 0.42;
    const wb = isMilitia ? 0.29 : 0.32;

    // 1. Foundation concrete pad (top = t.wy + 0.16) + WalkDeck
    if (batcher) {
      batcher.addBox('concrete', t.wx, t.wy - 0.84, t.wz, widthX + 0.3, 2.0, depthZ + 0.3, t.yaw, 0.54, 0.55, 0.52);
    }
    outDecks.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx + 0.3,
      hz: hz + 0.35,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorY,
      slopeAlongZ: 0,
      thicknessM: 0.25,
      surface: 'wood',
    });

    // 2. Shelter Walls (Z-walls trimmed cleanly inside X-walls so zero corner overlap)
    this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', -hx, hx, hz - wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: 0,
      width: 1.85,
      topH: 2.28,
    });
    this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', -hx, hx, -hz + wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'window',
      center: 0,
      width: 1.95,
      sillH: 1.0,
      topH: 2.15,
    });
    this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', -hz + wt, hz - wt, -hx + wt * 0.5, floorY, wallH, wt, wr, wg, wb);
    this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', -hz + wt, hz - wt, hx - wt * 0.5, floorY, wallH, wt, wr, wg, wb);

    // 3. Pitched corrugated roof + roof ballistic OBB
    const eaveY = t.wy + floorY + wallH;
    if (batcher) {
      batcher.addGableRoof('roofMetal', 'barnWood', t.wx, eaveY, t.wz, widthX, depthZ, 1.35, t.yaw, 0.38, 0.41, 0.42, wr, wg, wb);
    }
    outObbs.push({
      cx: t.wx,
      cy: eaveY + 0.2,
      cz: t.wz,
      hx: hx + 0.3,
      hy: 0.2,
      hz: hz + 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      surface: 'metal',
      blocksBullets: true,
      blocksPlayer: true,
    });

    // 4. Interior Supply Crate & Radio Desk (seated cleanly on floorY, clear of walls & doorway)
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -1.85, floorY + 0.42, -1.15, 1.2, 0.84, 0.85, 0.42, 0.38, 0.26);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 1.75, floorY + 0.44, -1.1, 1.3, 0.88, 0.72, 0.34, 0.38, 0.40);

    outIndoor.push({
      cx: t.wx,
      cz: t.wz,
      hx: hx - 0.24,
      hz: hz - 0.24,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorY - 0.1,
      maxY: eaveY + 0.2,
      material: 'wood',
    });

    // 5. Exterior Fortified Camp Cover: Sandbag Barricade, Stacked Pallets, Fuel Drums & Floodlight Mast
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', 0, 0.56, 5.4, 4.2, 1.12, 0.95, 0.62, 0.57, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.9, 0.55, 1.2, 1.6, 1.1, 1.4, 0.48, 0.39, 0.28);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.9, 1.1 + 0.34, 1.2, 1.1, 0.68, 0.95, 0.38, 0.42, 0.29, false, true);
    this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', 4.8, 0.48, 0.8, 0.72, 0.96, 0.72, 0.62, 0.24, 0.20);
    this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', 5.7, 0.48, 1.45, 0.72, 0.96, 0.72, 0.28, 0.42, 0.30);

    if (batcher) {
      const flP = localToWorldXZ(t, -4.6, -3.4);
      batcher.addBox('steel', flP.x, t.wy + 3.2, flP.z, 0.22, 6.4, 0.22, t.yaw, 0.44, 0.48, 0.52);
      batcher.addBox('emissiveFlood', flP.x, t.wy + 6.56, flP.z, 0.86, 0.32, 0.34, t.yaw, 1, 1, 1);
    }

    if (barriersOut) {
      for (const side of [-1, 1]) {
        const bp = localToWorldXZ(t, side * 3.8, 5.2);
        const by = evaluateOpenWorldHeight(bp.x, bp.z);
        const bYaw = t.yaw + Math.PI * 0.5 + side * 0.35;
        barriersOut.push({ wx: bp.x, wy: by, wz: bp.z, yaw: bYaw });
        outObbs.push({
          cx: bp.x,
          cy: by + 0.52,
          cz: bp.z,
          hx: 0.35,
          hy: 0.52,
          hz: 1.45,
          cosY: Math.cos(bYaw),
          sinY: Math.sin(bYaw),
          surface: 'concrete',
          blocksBullets: true,
          blocksPlayer: true,
        });
      }
    }

    if (vehiclesOut) {
      const vp = localToWorldXZ(t, 5.8, -3.4);
      vehiclesOut.push({
        wx: vp.x,
        wy: evaluateOpenWorldHeight(vp.x, vp.z),
        wz: vp.z,
        yaw: t.yaw + 0.35,
        colorHex: VEHICLE_BODY_PALETTE[site.variantSeed % VEHICLE_BODY_PALETTE.length],
      });
    }
  }

  // ============================================================================
  // FULL MILITARY FOB COMPOUND BUILDER (Alpha FOB & Bravo FOB)
  // ============================================================================

  /**
   * Secondary Major POI Tactical Cover & Atmosphere (Port, Railyard, Quarry, Alpine Dam).
   * Keeps a 14m radius clear around landmark center so flagpoles/terminals/spawns remain unobstructed.
   * Uses the chunk batcher + instanced barriers/floodlights for zero additional draw calls.
   */
  private buildMajorPoiTacticalSetDressing(
    lm: OpenWorldLandmarkSpec,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    lightsOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
    barriersOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    const addCoverBox = (
      matKey: ArchMaterialKey,
      dx: number,
      dz: number,
      sx: number,
      sy: number,
      sz: number,
      yaw: number,
      r: number,
      g: number,
      b: number,
      surface: BodycamSurfaceMaterial,
      yOffset = 0,
    ): void => {
      const wx = lm.worldX + dx;
      const wz = lm.worldZ + dz;
      const gy = evaluateOpenWorldHeight(wx, wz);
      if (gy <= SEA_LEVEL_M + 0.2) return;
      const cy = gy + yOffset + sy * 0.5;
      if (batcher) {
        batcher.addBox(matKey, wx, cy, wz, sx, sy, sz, yaw, r, g, b);
      }
      outObbs.push({
        cx: wx,
        cy,
        cz: wz,
        hx: sx * 0.5,
        hy: sy * 0.5,
        hz: sz * 0.5,
        cosY: Math.cos(yaw),
        sinY: Math.sin(yaw),
        surface,
        blocksBullets: true,
        blocksPlayer: true,
      });
    };

    const addPoiBarrier = (dx: number, dz: number, yaw: number): void => {
      const wx = lm.worldX + dx;
      const wz = lm.worldZ + dz;
      const gy = evaluateOpenWorldHeight(wx, wz);
      if (gy <= SEA_LEVEL_M + 0.2) return;
      if (barriersOut) {
        barriersOut.push({ wx, wy: gy, wz, yaw });
      }
      outObbs.push({
        cx: wx,
        cy: gy + 0.52,
        cz: wz,
        hx: 1.45,
        hy: 0.52,
        hz: 0.36,
        cosY: Math.cos(yaw),
        sinY: Math.sin(yaw),
        surface: 'concrete',
        blocksBullets: true,
        blocksPlayer: true,
      });
    };

    const addPoiLight = (dx: number, dz: number, yaw: number): void => {
      if (!lightsOut) return;
      const wx = lm.worldX + dx;
      const wz = lm.worldZ + dz;
      const gy = evaluateOpenWorldHeight(wx, wz);
      if (gy <= SEA_LEVEL_M + 0.2) return;
      lightsOut.push({ wx, wy: gy, wz, yaw });
    };

    if (lm.kind === 'port') {
      // Stacked maritime shipping containers creating multi-lane CQB lanes around the Container Terminal
      addCoverBox('roofMetal', -22, -18, 6.2, 2.6, 2.45, 0.08, 0.22, 0.38, 0.52, 'metal');
      addCoverBox('roofMetal', -22, -18, 6.1, 2.5, 2.4, 0.08, 0.58, 0.26, 0.22, 'metal', 2.6);
      addCoverBox('roofMetal', 21, -17, 6.2, 2.6, 2.45, -0.14, 0.28, 0.44, 0.32, 'metal');
      addCoverBox('roofMetal', -21, 19, 6.2, 2.6, 2.45, 0.22, 0.56, 0.42, 0.22, 'metal');
      addCoverBox('roofMetal', 23, 18, 6.2, 2.6, 2.45, -0.06, 0.24, 0.36, 0.48, 'metal');
      addCoverBox('roofMetal', 23, 18, 6.1, 2.5, 2.4, -0.06, 0.42, 0.44, 0.46, 'metal', 2.6);
      addCoverBox('steel', 0, -24, 4.4, 1.35, 1.8, 0, 0.42, 0.44, 0.46, 'metal');
      addPoiBarrier(-15, 0, Math.PI * 0.5);
      addPoiBarrier(15, 0, Math.PI * 0.5);
      addPoiBarrier(0, 17, 0);
      addPoiLight(-28, -26, Math.PI * 0.25);
      addPoiLight(28, -26, -Math.PI * 0.25);
      addPoiLight(-28, 26, Math.PI * 0.75);
      addPoiLight(28, 26, -Math.PI * 0.75);
    } else if (lm.kind === 'railyard') {
      // Parked freight boxcars & stacked logging timber bunks framing railyard lanes
      addCoverBox('roofMetal', -24, -14, 11.4, 3.2, 2.85, 0.04, 0.48, 0.24, 0.20, 'metal');
      addCoverBox('roofMetal', 24, 15, 11.4, 3.2, 2.85, 0.04, 0.28, 0.36, 0.44, 'metal');
      addCoverBox('barnWood', -18, 17, 5.2, 1.45, 2.2, 0.12, 0.52, 0.38, 0.26, 'wood');
      addCoverBox('barnWood', 19, -16, 5.2, 1.45, 2.2, -0.18, 0.48, 0.35, 0.24, 'wood');
      addCoverBox('concrete', 0, -22, 6.4, 1.15, 1.4, 0, 0.54, 0.54, 0.52, 'concrete');
      addPoiBarrier(-16, -2, Math.PI * 0.5);
      addPoiBarrier(16, 2, Math.PI * 0.5);
      addPoiBarrier(0, 19, 0);
      addPoiLight(-28, -22, Math.PI * 0.25);
      addPoiLight(28, -22, -Math.PI * 0.25);
      addPoiLight(-28, 24, Math.PI * 0.75);
      addPoiLight(28, 24, -Math.PI * 0.75);
    } else if (lm.kind === 'quarry') {
      // Limestone quarry reinforced concrete blast shelters & equipment cover blocks
      addCoverBox('concrete', -22, -16, 5.6, 2.4, 3.2, 0.24, 0.64, 0.61, 0.55, 'concrete');
      addCoverBox('concrete', 22, -16, 5.6, 2.4, 3.2, -0.24, 0.62, 0.59, 0.53, 'concrete');
      addCoverBox('concreteDark', -20, 18, 6.0, 1.65, 1.8, 0.15, 0.56, 0.53, 0.48, 'concrete');
      addCoverBox('concreteDark', 20, 18, 6.0, 1.65, 1.8, -0.15, 0.56, 0.53, 0.48, 'concrete');
      addCoverBox('steel', 0, -24, 4.2, 2.1, 2.4, 0, 0.52, 0.44, 0.24, 'metal');
      addPoiBarrier(-15, 2, Math.PI * 0.5);
      addPoiBarrier(15, -2, Math.PI * 0.5);
      addPoiBarrier(0, 18, 0);
      addPoiLight(-26, -24, Math.PI * 0.25);
      addPoiLight(26, -24, -Math.PI * 0.25);
      addPoiLight(-26, 24, Math.PI * 0.75);
      addPoiLight(26, 24, -Math.PI * 0.75);
    } else if (lm.kind === 'dam') {
      // Alpine Remnant reinforced concrete dam parapets & armored generator enclosures
      addCoverBox('concrete', -21, -15, 6.2, 1.85, 1.5, 0.1, 0.68, 0.70, 0.72, 'concrete');
      addCoverBox('concrete', 21, -15, 6.2, 1.85, 1.5, -0.1, 0.68, 0.70, 0.72, 'concrete');
      addCoverBox('steel', -20, 17, 4.8, 2.35, 2.6, 0.06, 0.40, 0.46, 0.52, 'metal');
      addCoverBox('steel', 20, 17, 4.8, 2.35, 2.6, -0.06, 0.40, 0.46, 0.52, 'metal');
      addCoverBox('concreteDark', 0, -23, 7.2, 1.35, 1.2, 0, 0.62, 0.64, 0.67, 'concrete');
      addPoiBarrier(-16, 0, Math.PI * 0.5);
      addPoiBarrier(16, 0, Math.PI * 0.5);
      addPoiBarrier(0, 18, 0);
      addPoiLight(-25, -22, Math.PI * 0.25);
      addPoiLight(25, -22, -Math.PI * 0.25);
      addPoiLight(-25, 22, Math.PI * 0.75);
      addPoiLight(25, 22, -Math.PI * 0.75);
    }
  }

  private buildFobCompound(
    fob: FobCompoundSpec,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    vehiclesOut: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }> | null,
    lightsOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
    barriersOut: Array<{ wx: number; wy: number; wz: number; yaw: number }> | null,
  ): void {
    const t = makeTransform(fob.worldX, fob.baseY, fob.worldZ, fob.yaw);
    const isAlpha = fob.faction === 'pmc_alpha';
    const [accentR, accentG, accentB] = isAlpha ? [0.22, 0.52, 0.72] : [0.76, 0.50, 0.16];
    const [oliveR, oliveG, oliveB] = [0.32, 0.36, 0.25];
    const [hescoR, hescoG, hescoB] = [0.64, 0.58, 0.45];

    // 1. Concrete Compound Pads & Entry Road Apron (non-overlapping flush seam at lz = +39.0)
    const yardP = localToWorldXZ(t, 0, -2.0);
    const apronP = localToWorldXZ(t, 0, 44.75);
    const heliP = localToWorldXZ(t, 2.0, 21.5);
    if (batcher) {
      // Main central courtyard tarmac spanning full HESCO interior (lz in [-43..+39], top = t.wy + 0.08)
      batcher.addBox('concreteDark', yardP.x, t.wy - 0.34, yardP.z, 86, 0.84, 82, t.yaw, 0.44, 0.45, 0.44);
      // Checkpoint concrete approach apron extending to spur road (lz in [+39.0..+50.5], top = t.wy + 0.08)
      batcher.addBox('concreteDark', apronP.x, t.wy - 0.34, apronP.z, 22, 0.84, 11.5, t.yaw, 0.40, 0.41, 0.40);
      // Helipad concrete apron at (2.0, 21.5, top = t.wy + 0.16, embedded -0.70m)
      batcher.addBox('concrete', heliP.x, t.wy - 0.27, heliP.z, 13.5, 0.86, 13.5, t.yaw, 0.54, 0.55, 0.53);
      // Crisp H markings with zero bar intersection overlap
      batcher.addBox('fasciaTint', heliP.x, t.wy + 0.175, heliP.z, 2.8, 0.03, 0.9, t.yaw, accentR, accentG, accentB);
      const heliLeft = localToWorldXZ(t, 2.0 - 1.85, 21.5);
      const heliRight = localToWorldXZ(t, 2.0 + 1.85, 21.5);
      batcher.addBox('fasciaTint', heliLeft.x, t.wy + 0.175, heliLeft.z, 0.9, 0.03, 5.4, t.yaw, accentR, accentG, accentB);
      batcher.addBox('fasciaTint', heliRight.x, t.wy + 0.175, heliRight.z, 0.9, 0.03, 5.4, t.yaw, accentR, accentG, accentB);
    }
    outDecks.push(
      {
        cx: yardP.x,
        cz: yardP.z,
        hx: 43.2,
        hz: 41.2,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + 0.08,
        slopeAlongZ: 0,
        thicknessM: 0.9,
        surface: 'concrete',
      },
      {
        cx: apronP.x,
        cz: apronP.z,
        hx: 11.2,
        hz: 6.0,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + 0.08,
        slopeAlongZ: 0,
        thicknessM: 0.9,
        surface: 'concrete',
      },
      {
        cx: heliP.x,
        cz: heliP.z,
        hx: 6.75,
        hz: 6.75,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + 0.16,
        slopeAlongZ: 0,
        thicknessM: 0.9,
        surface: 'concrete',
      },
    );

    // 2. Perimeter HESCO Bastion Security Walls (cleanly mitered/butted at corners with zero overlap)
    // North (-Z) continuous wall (lx in [-43.85..+43.85], lz in [-43.85..-42.55])
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', 0, 0.98, -43.2, 87.7, 3.46, 1.3, hescoR, hescoG, hescoB);
    // East (+X) continuous wall strictly between North & South walls (lz in [-42.55..+38.55])
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', 43.2, 0.98, -2.0, 1.3, 3.46, 81.1, hescoR, hescoG, hescoB);
    // West (-X) wall with side pedestrian tactical sally-port at lz = -22 (leaving [-24..-20] open)
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -43.2, 0.98, -33.275, 1.3, 3.46, 18.55, hescoR, hescoG, hescoB);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -43.2, 0.98, 9.275, 1.3, 3.46, 58.55, hescoR, hescoG, hescoB);
    // South (+Z) front wall split cleanly around the 10.4m Main Military Checkpoint Sally-Port [-5.2..+5.2]
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -24.525, 0.98, 39.2, 38.65, 3.46, 1.3, hescoR, hescoG, hescoB);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', 24.525, 0.98, 39.2, 38.65, 3.46, 1.3, hescoR, hescoG, hescoB);

    // 3. Military Base Checkpoint Entry + Guardhouse Booth + Overhead Canopy + Boom Gate Pedestal (at lz = +40)
    {
      const gz = 40.0;
      const bx = 6.8;
      const bw = 4.4;
      const bd = 4.2;
      const bFloor = 0.18;
      const bWallH = 3.0;
      const wt = 0.24;

      if (batcher) {
        const gp = localToWorldXZ(t, bx, gz);
        batcher.addBox('concrete', gp.x, t.wy - 0.72, gp.z, bw + 0.3, 1.8, bd + 0.3, t.yaw, 0.56, 0.58, 0.56);
        // Overhead checkpoint steel inspection canopy spanning the entry lanes [-5.5..+5.5]
        const canP = localToWorldXZ(t, 0, gz);
        batcher.addBox('steel', canP.x, t.wy + 4.35, canP.z, 12.2, 0.34, 5.4, t.yaw, 0.34, 0.38, 0.42);
        batcher.addBox('fasciaTint', canP.x, t.wy + 4.35, canP.z, 12.35, 0.22, 5.55, t.yaw, accentR, accentG, accentB);
        // Canopy columns (stopping cleanly at canopy underside 4.18)
        for (const cx of [-5.2, 4.9]) {
          for (const cz of [gz - 2.1, gz + 2.1]) {
            const cp = localToWorldXZ(t, cx, cz);
            batcher.addBox('steel', cp.x, t.wy + 2.13, cp.z, 0.28, 4.10, 0.28, t.yaw, 0.38, 0.41, 0.44);
          }
        }
        // Under-canopy floodlight bar
        batcher.addBox('emissiveCanopy', canP.x, t.wy + 4.14, canP.z, 8.0, 0.08, 0.85, t.yaw, 1, 1, 1);
      }

      const boothWorld = localToWorldXZ(t, bx, gz);
      outDecks.push({
        cx: boothWorld.x,
        cz: boothWorld.z,
        hx: bw * 0.5 + 0.25,
        hz: bd * 0.5 + 0.25,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + bFloor,
        slopeAlongZ: 0,
        thicknessM: 0.25,
        surface: 'concrete',
      });

      this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', gz - bd * 0.5, gz + bd * 0.5, bx - bw * 0.5 + wt * 0.5, bFloor, bWallH, wt, 0.62, 0.64, 0.62, {
        kind: 'door',
        center: gz,
        width: 1.45,
        topH: 2.3,
      });
      this.addWallAlongZ(t, batcher, outObbs, 'concrete', 'concrete', gz - bd * 0.5, gz + bd * 0.5, bx + bw * 0.5 - wt * 0.5, bFloor, bWallH, wt, 0.60, 0.62, 0.60);
      this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', bx - bw * 0.5 + wt, bx + bw * 0.5 - wt, gz + bd * 0.5 - wt * 0.5, bFloor, bWallH, wt, 0.62, 0.64, 0.62, {
        kind: 'window',
        center: bx,
        width: 2.3,
        sillH: 1.0,
        topH: 2.2,
      });
      this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', bx - bw * 0.5 + wt, bx + bw * 0.5 - wt, gz - bd * 0.5 + wt * 0.5, bFloor, bWallH, wt, 0.62, 0.64, 0.62, {
        kind: 'window',
        center: bx,
        width: 2.3,
        sillH: 1.0,
        topH: 2.2,
      });
      this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', bx, bFloor + bWallH + 0.16, gz, bw + 0.8, 0.32, bd + 0.8, 0.42, 0.45, 0.46);
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', bx + 0.9, bFloor + 0.46, gz + 0.9, 1.1, 0.92, 0.72, 0.46, 0.38, 0.28);

      outIndoor.push({
        cx: boothWorld.x,
        cz: boothWorld.z,
        hx: bw * 0.5 - 0.24,
        hz: bd * 0.5 - 0.24,
        cosY: t.cosY,
        sinY: t.sinY,
        minY: t.wy + bFloor - 0.1,
        maxY: t.wy + bFloor + bWallH + 0.15,
        material: 'concrete',
      });

      // Opposite sandbag checkpoint bunker (-6.8, gz) + Boom Gate Pedestal (+3.85, gz)
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -6.8, 0.65, gz, 2.2, 1.3, 4.4, hescoR, hescoG, hescoB);
      this.addSolidBox(t, batcher, outObbs, 'fasciaTint', 'metal', 3.85, 0.65, gz, 0.56, 1.3, 0.56, 0.82, 0.22, 0.18);

      // Gate Jersey-Barrier S-Chicane (keeps vehicles/runners weaving cleanly)
      for (const c of [
        { lx: -2.0, lz: gz + 6.4, dyaw: 0.28 },
        { lx: 2.0, lz: gz - 5.6, dyaw: 0.28 },
      ]) {
        const bp = localToWorldXZ(t, c.lx, c.lz);
        const bYaw = t.yaw + Math.PI * 0.5 + c.dyaw;
        if (barriersOut) {
          barriersOut.push({ wx: bp.x, wy: t.wy, wz: bp.z, yaw: bYaw });
        }
        outObbs.push({
          cx: bp.x,
          cy: t.wy + 0.52,
          cz: bp.z,
          hx: 0.35,
          hy: 0.52,
          hz: 1.45,
          cosY: Math.cos(bYaw),
          sinY: Math.sin(bYaw),
          surface: 'concrete',
          blocksBullets: true,
          blocksPlayer: true,
        });
      }

      if (lightsOut) {
        const l1 = localToWorldXZ(t, -6.5, gz + 4.8);
        const l2 = localToWorldXZ(t, 6.5, gz - 4.8);
        lightsOut.push({ wx: l1.x, wy: t.wy, wz: l1.z, yaw: t.yaw + Math.PI * 0.5 });
        lightsOut.push({ wx: l2.x, wy: t.wy, wz: l2.z, yaw: t.yaw - Math.PI * 0.5 });
      }
    }

    // 4. Four Climbable Corner Guard Towers (with Switchback Staircase + Sniper Deck + Parapets + Floodlights)
    const towers = getFobGuardTowerSpecs(fob.id);
    const towerDeckH = FOB_GUARD_TOWER_DECK_HEIGHT_M;
    for (let ti = 0; ti < towers.length; ti++) {
      const tw = towers[ti];
      const tx = tw.localX;
      const tz = tw.localZ;
      const halfTw = 2.35;

      // Tower foundation & corner steel columns (foundation top = 0.12 proudly above tarmac 0.08)
      if (batcher) {
        const twP = localToWorldXZ(t, tx, tz);
        batcher.addBox('concreteDark', twP.x, t.wy - 0.63, twP.z, 5.2, 1.5, 5.2, t.yaw, 0.48, 0.50, 0.48);
        // Deck slab & underside steel framing
        batcher.addBox('steel', twP.x, t.wy + towerDeckH - 0.14, twP.z, halfTw * 2 + 0.25, 0.28, halfTw * 2 + 0.25, t.yaw, 0.38, 0.42, 0.45);
        // Overhead watchtower canopy roof
        batcher.addBox('roofMetal', twP.x, t.wy + towerDeckH + 2.75, twP.z, halfTw * 2 + 0.8, 0.20, halfTw * 2 + 0.8, t.yaw, 0.34, 0.38, 0.40);
        // Floodlight bar mounted under roof edge
        batcher.addBox('emissiveFlood', twP.x, t.wy + towerDeckH + 2.56, twP.z, 1.4, 0.18, 1.4, t.yaw, 1, 1, 1);
      }

      // 4 structural corner posts (base to canopy underside)
      const postBot = 0.12;
      const postTop = towerDeckH + 2.65;
      const postH = postTop - postBot;
      for (const sx of [-halfTw + 0.16, halfTw - 0.16]) {
        for (const sz of [-halfTw + 0.16, halfTw - 0.16]) {
          this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', tx + sx, postBot + postH * 0.5, tz + sz, 0.28, postH, 0.28, 0.35, 0.39, 0.42);
        }
      }

      // Guard tower upper walkable deck + overhead roof OBB
      const twCenter = localToWorldXZ(t, tx, tz);
      outDecks.push({
        cx: twCenter.x,
        cz: twCenter.z,
        hx: halfTw,
        hz: halfTw,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + towerDeckH,
        slopeAlongZ: 0,
        thicknessM: 0.35,
        surface: 'metal',
      });
      outObbs.push({
        cx: twCenter.x,
        cy: t.wy + towerDeckH + 2.75,
        cz: twCenter.z,
        hx: halfTw + 0.3,
        hy: 0.15,
        hz: halfTw + 0.3,
        cosY: t.cosY,
        sinY: t.sinY,
        surface: 'metal',
        blocksBullets: true,
        blocksPlayer: true,
      });

      // Waist-high sandbag/steel parapet walls (1.02m high, trimmed strictly between corner posts)
      const pH = 1.02;
      const pSpan = halfTw * 2 - 0.64;
      const stairSide = tx < 0 ? 1 : -1; // Stair climbs along interior-facing X flank
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', tx, towerDeckH + pH * 0.5, tz - halfTw + 0.18, pSpan, pH, 0.24, hescoR, hescoG, hescoB);
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', tx, towerDeckH + pH * 0.5, tz + halfTw - 0.18, pSpan, pH, 0.24, hescoR, hescoG, hescoB);
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', tx - stairSide * (halfTw - 0.18), towerDeckH + pH * 0.5, tz, 0.24, pH, pSpan, hescoR, hescoG, hescoB);

      // Exterior Climbable Staircase (14 wide metal stair treads stepping cleanly up to landing bridge)
      const stepCount = 14;
      const stairX = tx + stairSide * (halfTw + 0.85);
      const stepDirZ = tz < 0 ? 1 : -1; // climb inward from tower side
      for (let s = 1; s <= stepCount; s++) {
        const frac = s / (stepCount + 1);
        const stepY = frac * towerDeckH;
        const stepLz = tz - stepDirZ * 2.2 + stepDirZ * frac * 4.2;
        const stepWorld = localToWorldXZ(t, stairX, stepLz);
        if (batcher) {
          batcher.addBox('steel', stepWorld.x, t.wy + stepY - 0.08, stepWorld.z, 1.35, 0.16, 0.55, t.yaw, 0.42, 0.46, 0.50);
        }
        outDecks.push({
          cx: stepWorld.x,
          cz: stepWorld.z,
          hx: 0.72,
          hz: 0.34,
          cosY: t.cosY,
          sinY: t.sinY,
          baseY: t.wy + stepY,
          slopeAlongZ: 0,
          thicknessM: 0.24,
          surface: 'metal',
        });
      }
      // Upper stair landing bridge spanning strictly outside deck overhang (halfTw + 0.13 .. halfTw + 0.85)
      const landLz = tz + stepDirZ * 2.0;
      const landWorld = localToWorldXZ(t, tx + stairSide * (halfTw + 0.49), landLz);
      if (batcher) {
        batcher.addBox('steel', landWorld.x, t.wy + towerDeckH - 0.13, landWorld.z, 0.72, 0.22, 1.3, t.yaw, 0.40, 0.44, 0.48);
      }
      outDecks.push({
        cx: landWorld.x,
        cz: landWorld.z,
        hx: 0.65,
        hz: 0.7,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + towerDeckH - 0.02,
        slopeAlongZ: 0,
        thicknessM: 0.3,
        surface: 'metal',
      });
    }

    // 5. Command & Quartermaster Station Bunker (at lx = -5.5, lz = +4.0, houses `fob_terminal`)
    this.buildFobConcreteStation(t, -5.5, 4.0, 11.0, 8.0, 3.6, batcher, outObbs, outDecks, outIndoor, {
      wallColor: [0.58, 0.60, 0.58],
      accentColor: [accentR, accentG, accentB],
      doorWall: 'front',
      backDoor: true,
      hasCommsMast: true,
      stationKind: 'command',
    });

    // 6. Field Hospital & Surgical Aid Tent (at lx = +18.0, lz = +9.0, houses `fob_resupply`)
    this.buildFobTent(t, 18.0, 9.0, 12.0, 8.0, 3.2, batcher, outObbs, outDecks, outIndoor, {
      roofColor: [0.84, 0.86, 0.85],
      wallColor: [0.42, 0.47, 0.34],
      isMedicalHospital: true,
    });

    // 7. Fortified FOB Armory & Stash Lockers (at lx = +18.0, lz = -7.0, houses `armory_stash`)
    this.buildFobConcreteStation(t, 18.0, -7.0, 11.0, 8.0, 3.5, batcher, outObbs, outDecks, outIndoor, {
      wallColor: [0.52, 0.54, 0.55],
      accentColor: [accentR, accentG, accentB],
      doorWall: 'left',
      backDoor: false,
      hasCommsMast: false,
      stationKind: 'armory',
    });

    // 8. Barracks Bunkhouse + 2 Logistics/Billeting Field Tents + Motorpool Bay
    this.buildFobConcreteStation(t, -29.0, 19.0, 12.0, 9.0, 3.4, batcher, outObbs, outDecks, outIndoor, {
      wallColor: [0.56, 0.55, 0.50],
      accentColor: [oliveR, oliveG, oliveB],
      doorWall: 'right',
      backDoor: true,
      hasCommsMast: false,
      stationKind: 'barracks',
    });
    this.buildFobTent(t, -29.0, 5.5, 10.0, 6.2, 2.9, batcher, outObbs, outDecks, outIndoor, {
      roofColor: [0.34, 0.39, 0.27],
      wallColor: [0.30, 0.34, 0.24],
      isMedicalHospital: false,
    });
    this.buildFobTent(t, 29.0, 21.0, 10.0, 6.2, 2.9, batcher, outObbs, outDecks, outIndoor, {
      roofColor: [0.36, 0.38, 0.28],
      wallColor: [0.31, 0.33, 0.25],
      isMedicalHospital: false,
    });

    // Motorpool Covered Shelter Bay (+31.5, -6.5 -> shifted to +31.5, +8.0? No, Armory is +18,-7 & Hosp is +18,+9 -> put Motorpool at (+32.5, +6.5))
    {
      const mx = 32.5;
      const mz = 6.5;
      const mw = 8.4;
      const md = 10.0;
      const mh = 4.0;
      const mp = localToWorldXZ(t, mx, mz);
      if (batcher) {
        batcher.addBox('concrete', mp.x, t.wy - 0.25, mp.z, mw + 0.6, 0.70, md + 0.6, t.yaw, 0.50, 0.51, 0.50);
        batcher.addBox('roofMetal', mp.x, t.wy + mh, mp.z, mw + 0.8, 0.22, md + 0.8, t.yaw, 0.36, 0.40, 0.38);
      }
      outDecks.push({
        cx: mp.x,
        cz: mp.z,
        hx: mw * 0.5 + 0.35,
        hz: md * 0.5 + 0.35,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + 0.10,
        slopeAlongZ: 0,
        thicknessM: 0.75,
        surface: 'concrete',
      });
      for (const sx of [-mw * 0.46, mw * 0.46]) {
        for (const sz of [-md * 0.45, 0, md * 0.45]) {
          this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', mx + sx, 0.10 + (mh - 0.21) * 0.5, mz + sz, 0.24, mh - 0.21, 0.24, 0.38, 0.41, 0.44);
        }
      }
      // FOB Courtyard Staging Upgrades: Fuel drum bund beside motorpool, diesel generator cage beside HQ,
      // and raised wooden gun-range shooting bench shelf (hosts shootable physics bottles & cans!)
      if (batcher) {
        // Fuel drum pallet + 4 oil drums beside motorpool (-X flank)
        const bund = localToWorldXZ(t, mx - mw * 0.5 - 1.55, mz - 2.2);
        batcher.addBox('concreteDark', bund.x, t.wy + 0.14, bund.z, 1.85, 0.14, 1.85, t.yaw, 0.36, 0.38, 0.40);
        for (const ox of [-0.42, 0.42]) {
          for (const oz of [-0.42, 0.42]) {
            const dp = localToWorldXZ(t, mx - mw * 0.5 - 1.55 + ox, mz - 2.2 + oz);
            batcher.addBox('fasciaTint', dp.x, t.wy + 0.65, dp.z, 0.58, 0.88, 0.58, t.yaw, 0.62, 0.24, 0.20);
          }
        }
        // Caged diesel generator beside Command Bunker (-X flank)
        const gen = localToWorldXZ(t, -12.6, 4.2);
        batcher.addBox('concreteDark', gen.x, t.wy + 0.14, gen.z, 2.5, 0.16, 1.55, t.yaw, 0.42, 0.44, 0.45);
        batcher.addBox('steel', gen.x, t.wy + 0.78, gen.z, 2.15, 1.12, 1.12, t.yaw, 0.34, 0.42, 0.30);
        batcher.addBox('steel', gen.x, t.wy + 1.54, gen.z, 0.26, 0.44, 0.26, t.yaw, 0.24, 0.26, 0.28);
        // Gun-range wooden shooting shelf at firing line (-19.5, -26.2)
        const shelf = localToWorldXZ(t, -19.5, -26.2);
        batcher.addBox('woodTrim', shelf.x, t.wy + 0.96, shelf.z, 3.2, 0.10, 0.72, t.yaw, 0.52, 0.40, 0.28);
        const legL = localToWorldXZ(t, -20.85, -26.2);
        const legR = localToWorldXZ(t, -18.15, -26.2);
        batcher.addBox('steel', legL.x, t.wy + 0.48, legL.z, 0.12, 0.92, 0.62, t.yaw, 0.32, 0.35, 0.38);
        batcher.addBox('steel', legR.x, t.wy + 0.48, legR.z, 0.12, 0.92, 0.62, t.yaw, 0.32, 0.35, 0.38);
      }
      outObbs.push({
        cx: mp.x,
        cy: t.wy + mh,
        cz: mp.z,
        hx: mw * 0.5 + 0.4,
        hy: 0.15,
        hz: md * 0.5 + 0.4,
        cosY: t.cosY,
        sinY: t.sinY,
        surface: 'metal',
        blocksBullets: true,
        blocksPlayer: true,
      });
      if (vehiclesOut) {
        vehiclesOut.push({
          wx: mp.x,
          wy: t.wy + 0.10,
          wz: mp.z,
          yaw: t.yaw,
          colorHex: 0x4f5d47,
        });
      }
    }

    // 9. Barracks Live-Fire Gun Range (3 Lanes at lx in [+20..+37], lz in [-37..-17])
    {
      const rx = 28.0;
      const shootZ = -18.5;
      const rangePadP = localToWorldXZ(t, rx, -28.0);
      if (batcher) {
        batcher.addBox('concreteDark', rangePadP.x, t.wy - 0.25, rangePadP.z, 17.5, 0.70, 21.0, t.yaw, 0.46, 0.45, 0.42);
        // Overhead shooting shed awning above shooter benches
        const shedP = localToWorldXZ(t, rx, shootZ);
        batcher.addBox('roofMetal', shedP.x, t.wy + 3.15, shedP.z, 16.5, 0.18, 4.2, t.yaw, 0.36, 0.40, 0.36);
        batcher.addBox('emissiveFlood', shedP.x, t.wy + 2.98, shedP.z, 10.0, 0.08, 0.35, t.yaw, 1, 1, 1);
      }
      outDecks.push({
        cx: rangePadP.x,
        cz: rangePadP.z,
        hx: 8.8,
        hz: 10.6,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + 0.10,
        slopeAlongZ: 0,
        thicknessM: 0.75,
        surface: 'concrete',
      });
      // Shooting canopy support posts & concrete firing tables for 3 lanes
      for (const laneX of [22.5, 28.0, 33.5]) {
        this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', laneX, 0.52, shootZ - 0.6, 1.85, 0.88, 0.85, 0.48, 0.38, 0.28);
        // Lane divider stall partitions beside shooter
        this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', laneX - 2.6, 1.35, shootZ - 0.4, 0.14, 2.5, 2.2, 0.42, 0.35, 0.25);
      }
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', 36.1, 1.35, shootZ - 0.4, 0.14, 2.5, 2.2, 0.42, 0.35, 0.25);
      // Heavy Armored Backstop Berm Wall behind live-fire targets (lz = -37.2, skirted into terrain)
      this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', rx, 1.325, -37.2, 17.2, 3.95, 1.4, 0.54, 0.50, 0.42);
    }

    // 10. Barracks Walled CQB Shoot-House Range (lx in [0..+16], lz in [-36..-22])
    {
      const cx = 8.0;
      const cz = -29.0;
      const cw = 16.0;
      const cd = 14.0;
      const floorY = 0.18;
      const wallH = 2.95;
      const wt = 0.22;
      const houseCenter = localToWorldXZ(t, cx, cz);

      if (batcher) {
        batcher.addBox('concrete', houseCenter.x, t.wy - 0.21, houseCenter.z, cw + 0.4, 0.78, cd + 0.4, t.yaw, 0.52, 0.52, 0.50);
      }
      outDecks.push({
        cx: houseCenter.x,
        cz: houseCenter.z,
        hx: cw * 0.5 + 0.3,
        hz: cd * 0.5 + 0.3,
        cosY: t.cosY,
        sinY: t.sinY,
        baseY: t.wy + floorY,
        slopeAlongZ: 0,
        thicknessM: 0.24,
        surface: 'concrete',
      });

      // Outer CQB walls (X-walls trimmed between Z-wall thicknesses so corners never overlap)
      this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', cz - cd * 0.5, cz + cd * 0.5, cx - cw * 0.5 + wt * 0.5, floorY, wallH, wt, 0.50, 0.44, 0.34, {
        kind: 'door',
        center: cz,
        width: 2.0,
        topH: 2.4,
      });
      this.addWallAlongZ(t, batcher, outObbs, 'barnWood', 'wood', cz - cd * 0.5, cz + cd * 0.5, cx + cw * 0.5 - wt * 0.5, floorY, wallH, wt, 0.50, 0.44, 0.34, {
        kind: 'door',
        center: cz + 2.5,
        width: 1.65,
        topH: 2.4,
      });
      this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', cx - cw * 0.5 + wt, cx + cw * 0.5 - wt, cz - cd * 0.5 + wt * 0.5, floorY, wallH, wt, 0.50, 0.44, 0.34);
      this.addWallAlongX(t, batcher, outObbs, 'barnWood', 'wood', cx - cw * 0.5 + wt, cx + cw * 0.5 - wt, cz + cd * 0.5 - wt * 0.5, floorY, wallH, wt, 0.50, 0.44, 0.34, {
        kind: 'door',
        center: cx - 3.5,
        width: 1.75,
        topH: 2.4,
      });

      // Interior CQB Shoot-House Room Partitions & Breaching Doorways (X-partition split cleanly at Z-partition seam)
      this.addWallAlongZ(t, batcher, outObbs, 'woodTrim', 'wood', cz - cd * 0.5 + wt, cz + 1.5, cx - 0.5, floorY, wallH - 0.1, 0.18, 0.56, 0.48, 0.35, {
        kind: 'door',
        center: cz - 3.2,
        width: 1.55,
        topH: 2.35,
      });
      this.addWallAlongX(t, batcher, outObbs, 'woodTrim', 'wood', cx - cw * 0.5 + wt, cx - 0.59, cz - 0.2, floorY, wallH - 0.1, 0.18, 0.56, 0.48, 0.35);
      this.addWallAlongX(t, batcher, outObbs, 'woodTrim', 'wood', cx - 0.41, cx + cw * 0.5 - wt, cz - 0.2, floorY, wallH - 0.1, 0.18, 0.56, 0.48, 0.35, {
        kind: 'door',
        center: cx + 3.4,
        width: 1.65,
        topH: 2.35,
      });
      // Interior cover barricade inside East CQB bay
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx + 4.2, floorY + 0.65, cz + 3.2, 2.0, 1.3, 0.45, 0.48, 0.40, 0.30);
    }

    // Exterior compound floodlight posts along main internal avenues
    if (lightsOut) {
      for (const [lx, lz, dyaw] of [
        [-12, 22, 0],
        [12, 22, Math.PI],
        [12, -16, Math.PI],
      ] as const) {
        const lp = localToWorldXZ(t, lx, lz);
        lightsOut.push({ wx: lp.x, wy: t.wy, wz: lp.z, yaw: t.yaw + dyaw });
      }
    }
  }

  private buildFobConcreteStation(
    t: LocalTransform,
    cx: number,
    cz: number,
    widthX: number,
    depthZ: number,
    wallH: number,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    opts: {
      wallColor: [number, number, number];
      accentColor: [number, number, number];
      doorWall: 'front' | 'left' | 'right';
      backDoor: boolean;
      hasCommsMast: boolean;
      stationKind: 'command' | 'armory' | 'barracks';
    },
  ): void {
    const hx = widthX * 0.5;
    const hz = depthZ * 0.5;
    const floorY = 0.22;
    const wt = 0.28;
    const [wr, wg, wb] = opts.wallColor;
    const [ar, ag, ab] = opts.accentColor;
    const centerWorld = localToWorldXZ(t, cx, cz);

    if (batcher) {
      // Concrete foundation plinth stops at t.wy + 0.16; interior floor slab [0.16..0.22] sits cleanly atop it (zero coplanar Z-fighting)
      batcher.addBox('concrete', centerWorld.x, t.wy - 0.74, centerWorld.z, widthX + 0.4, 1.8, depthZ + 0.4, t.yaw, 0.52, 0.53, 0.51);
      batcher.addBox('concreteDark', centerWorld.x, t.wy + 0.19, centerWorld.z, widthX - 0.12, 0.06, depthZ - 0.12, t.yaw, 0.42, 0.44, 0.44);
    }
    outDecks.push({
      cx: centerWorld.x,
      cz: centerWorld.z,
      hx: hx + 0.35,
      hz: hz + 0.35,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorY,
      slopeAlongZ: 0,
      thicknessM: 0.28,
      surface: 'concrete',
    });

    // +Z wall
    this.addWallAlongX(
      t, batcher, outObbs, 'concrete', 'concrete', cx - hx, cx + hx, cz + hz - wt * 0.5, floorY, wallH, wt, wr, wg, wb,
      opts.doorWall === 'front'
        ? { kind: 'door', center: cx, width: 2.1, topH: 2.45 }
        : { kind: 'window', center: cx, width: 2.6, sillH: 1.05, topH: 2.15 },
    );
    // -Z wall
    this.addWallAlongX(
      t, batcher, outObbs, 'concrete', 'concrete', cx - hx, cx + hx, cz - hz + wt * 0.5, floorY, wallH, wt, wr, wg, wb,
      opts.backDoor
        ? { kind: 'door', center: cx - 1.5, width: 1.65, topH: 2.38 }
        : { kind: 'window', center: cx, width: 2.2, sillH: 1.05, topH: 2.15 },
    );
    // -X wall
    this.addWallAlongZ(
      t, batcher, outObbs, 'concrete', 'concrete', cz - hz + wt, cz + hz - wt, cx - hx + wt * 0.5, floorY, wallH, wt, wr, wg, wb,
      opts.doorWall === 'left'
        ? { kind: 'door', center: cz, width: 2.0, topH: 2.45 }
        : { kind: 'window', center: cz, width: 2.4, sillH: 1.05, topH: 2.15 },
    );
    // +X wall
    this.addWallAlongZ(
      t, batcher, outObbs, 'concrete', 'concrete', cz - hz + wt, cz + hz - wt, cx + hx - wt * 0.5, floorY, wallH, wt, wr, wg, wb,
      opts.doorWall === 'right'
        ? { kind: 'door', center: cz, width: 2.0, topH: 2.45 }
        : { kind: 'window', center: cz, width: 2.4, sillH: 1.05, topH: 2.15 },
    );

    // Concrete roof slab + faction fascia trim
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', cx, floorY + wallH + 0.20, cz, widthX + 0.7, 0.40, depthZ + 0.7, 0.42, 0.44, 0.45);
    if (batcher) {
      batcher.addBox('fasciaTint', centerWorld.x, t.wy + floorY + wallH + 0.22, centerWorld.z, widthX + 0.8, 0.22, depthZ + 0.8, t.yaw, ar, ag, ab);
      batcher.addBox('emissiveCanopy', centerWorld.x, t.wy + floorY + wallH - 0.04, centerWorld.z, 3.2, 0.06, 0.42, t.yaw, 1, 1, 1);
      if (opts.hasCommsMast) {
        const mastP = localToWorldXZ(t, cx + 2.8, cz - 1.8);
        batcher.addBox('steel', mastP.x, t.wy + floorY + wallH + 5.8, mastP.z, 0.42, 11.2, 0.42, t.yaw, 0.46, 0.50, 0.54);
        batcher.addBox('emissiveBeacon', mastP.x, t.wy + floorY + wallH + 11.5, mastP.z, 0.55, 0.55, 0.55, t.yaw, 1, 1, 1);
      }
    }

    // Station-specific interior props & architectural dressing (zero coplanar faces, merged into chunk batcher)
    if (batcher) {
      // Overhead steel ceiling joists & electrical cable tray across every concrete FOB bunker
      for (const jz of [-hz * 0.5, 0, hz * 0.5]) {
        const jp = localToWorldXZ(t, cx, cz + jz);
        batcher.addBox('steel', jp.x, t.wy + floorY + wallH - 0.12, jp.z, widthX - 0.7, 0.14, 0.14, t.yaw, 0.30, 0.34, 0.38);
      }
      const trayP = localToWorldXZ(t, cx - hx + 1.15, cz);
      batcher.addBox('steel', trayP.x, t.wy + floorY + wallH - 0.24, trayP.z, 0.26, 0.08, depthZ - 1.0, t.yaw, 0.26, 0.29, 0.32);
    }

    if (opts.stationKind === 'command') {
      // Tactical map briefing table + raised holo console, dual server racks, wall situation board, 4 chairs & footlocker
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx + 2.2, floorY + 0.48, cz - 1.6, 2.6, 0.96, 1.3, 0.34, 0.38, 0.42);
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx + 2.2, floorY + 0.96 + 0.12, cz - 1.6, 1.8, 0.24, 0.86, 0.22, 0.28, 0.34, false, true);
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx - 3.6, floorY + 1.05, cz - 2.6, 1.4, 2.1, 0.75, 0.30, 0.34, 0.36);
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx + 3.5, floorY + 0.36, cz + 1.8, 1.3, 0.72, 0.74, 0.38, 0.42, 0.28);
      if (batcher) {
        // Secondary server rack + glowing green telemetry LED bar
        const srv2 = localToWorldXZ(t, cx - 2.0, cz - 2.6);
        batcher.addBox('steel', srv2.x, t.wy + floorY + 1.05, srv2.z, 1.2, 2.1, 0.72, t.yaw, 0.26, 0.30, 0.34);
        batcher.addBox('emissiveCanopy', srv2.x, t.wy + floorY + 1.68, srv2.z + 0.38 * t.cosY, 0.85, 0.08, 0.05, t.yaw, 0.28, 0.88, 0.46);
        // Wall situation briefing board mounted on rear wall
        const boardP = localToWorldXZ(t, cx + 1.8, cz - hz + 0.46);
        batcher.addBox('concreteDark', boardP.x, t.wy + floorY + 1.72, boardP.z, 2.8, 1.35, 0.09, t.yaw, 0.22, 0.26, 0.30);
        // 4 folding chairs flanking the central sand-table
        for (const chx of [cx + 1.35, cx + 3.05]) {
          const chF = localToWorldXZ(t, chx, cz - 0.55);
          batcher.addBox('woodTrim', chF.x, t.wy + floorY + 0.26, chF.z, 0.44, 0.52, 0.44, t.yaw + 0.15, 0.36, 0.38, 0.32);
          const chB = localToWorldXZ(t, chx, cz - 2.65);
          batcher.addBox('woodTrim', chB.x, t.wy + floorY + 0.26, chB.z, 0.44, 0.52, 0.44, t.yaw - 0.12, 0.36, 0.38, 0.32);
        }
      }
    } else if (opts.stationKind === 'armory') {
      // 5 Steel Player Stash Lockers along back/right interior walls + Weapon Rack + Gunsmith Bench + Toolboard + Ammo Pallets
      for (let k = 0; k < 5; k++) {
        const lx = cx - 3.2 + k * 1.45;
        this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', lx, floorY + 1.05, cz - hz + 0.75, 1.15, 2.1, 0.72, 0.28, 0.34, 0.30);
      }
      // Gunsmith workbench + inset ammo crate + armor plate case + weapon rack
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx + 1.2, floorY + 0.46, cz + 1.8, 3.2, 0.92, 0.95, 0.46, 0.36, 0.26);
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx + 1.2, floorY + 0.92 + 0.22, cz + 1.8, 1.15, 0.44, 0.62, 0.34, 0.40, 0.26, false, true);
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx - 2.4, floorY + 0.38, cz + 1.9, 1.1, 0.76, 0.78, 0.30, 0.34, 0.36);
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx + hx - 0.85, floorY + 0.95, cz - 0.4, 0.65, 1.9, 3.4, 0.32, 0.36, 0.38);
      if (batcher) {
        // Wall tool pegboard mounted over gunsmith bench + steel cage divider post
        const pegP = localToWorldXZ(t, cx + 1.2, cz + hz - 0.46);
        batcher.addBox('steel', pegP.x, t.wy + floorY + 1.66, pegP.z, 2.6, 1.05, 0.08, t.yaw, 0.32, 0.36, 0.38);
        // Stacked olive ammo tins atop steel storage case
        const tinP = localToWorldXZ(t, cx - 2.4, cz + 1.9);
        batcher.addBox('fasciaTint', tinP.x, t.wy + floorY + 0.92, tinP.z, 0.62, 0.28, 0.44, t.yaw + 0.18, 0.32, 0.42, 0.26);
      }
    } else {
      // Barracks: double bunk frames with mattress pads, footlockers, field mess table & benches
      for (const bx of [cx - 3.8, cx - 1.2, cx + 1.4]) {
        this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', bx, floorY + 0.85, cz - 2.6, 1.1, 1.7, 2.1, 0.36, 0.38, 0.34);
        this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', bx, floorY + 0.28, cz + 2.4, 0.95, 0.56, 0.55, 0.36, 0.38, 0.26);
        if (batcher) {
          // Olive bunk mattresses (lower & upper) + pillow blocks
          const mp = localToWorldXZ(t, bx, cz - 2.6);
          batcher.addBox('wallSiding', mp.x, t.wy + floorY + 0.52, mp.z, 0.96, 0.16, 1.92, t.yaw, 0.44, 0.48, 0.38);
          batcher.addBox('wallSiding', mp.x, t.wy + floorY + 1.48, mp.z, 0.96, 0.16, 1.92, t.yaw, 0.44, 0.48, 0.38);
        }
      }
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx - 3.5, floorY + 0.44, cz + 0.2, 1.75, 0.88, 1.05, 0.48, 0.38, 0.28);
      if (batcher) {
        // Mess bench beside barracks table
        const bench = localToWorldXZ(t, cx - 3.5, cz + 1.05);
        batcher.addBox('woodTrim', bench.x, t.wy + floorY + 0.24, bench.z, 1.55, 0.44, 0.34, t.yaw, 0.44, 0.35, 0.25);
      }
    }

    outIndoor.push({
      cx: centerWorld.x,
      cz: centerWorld.z,
      hx: hx - 0.3,
      hz: hz - 0.3,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorY - 0.1,
      maxY: t.wy + floorY + wallH + 0.15,
      material: 'concrete',
    });
  }

  private buildFobTent(
    t: LocalTransform,
    cx: number,
    cz: number,
    widthX: number,
    depthZ: number,
    wallH: number,
    batcher: ChunkGeometryBatcher | null,
    outObbs: SolidObb[],
    outDecks: WalkDeck[],
    outIndoor: IndoorVolume[],
    opts: {
      roofColor: [number, number, number];
      wallColor: [number, number, number];
      isMedicalHospital: boolean;
    },
  ): void {
    const hx = widthX * 0.5;
    const hz = depthZ * 0.5;
    const floorY = 0.18;
    const wt = 0.16;
    const [rr, rg, rb] = opts.roofColor;
    const [wr, wg, wb] = opts.wallColor;
    const centerWorld = localToWorldXZ(t, cx, cz);

    if (batcher) {
      // Foundation top = t.wy + 0.14; interior floor slab [0.14..0.18] rests flush atop foundation
      batcher.addBox('concrete', centerWorld.x, t.wy - 0.71, centerWorld.z, widthX + 0.4, 1.7, depthZ + 0.4, t.yaw, 0.54, 0.55, 0.52);
      batcher.addBox('concreteDark', centerWorld.x, t.wy + 0.16, centerWorld.z, widthX - 0.12, 0.04, depthZ - 0.12, t.yaw, 0.45, 0.47, 0.46);
    }
    outDecks.push({
      cx: centerWorld.x,
      cz: centerWorld.z,
      hx: hx + 0.35,
      hz: hz + 0.35,
      cosY: t.cosY,
      sinY: t.sinY,
      baseY: t.wy + floorY,
      slopeAlongZ: 0,
      thicknessM: 0.25,
      surface: 'concrete',
    });

    // Open canvas tent flaps on +X/-X (or -X/+Z for Field Hospital) + canvas side walls
    this.addWallAlongZ(t, batcher, outObbs, 'wallSiding', 'wood', cz - hz, cz + hz, cx - hx + wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: cz,
      width: 2.6,
      topH: 2.45,
    });
    this.addWallAlongZ(t, batcher, outObbs, 'wallSiding', 'wood', cz - hz, cz + hz, cx + hx - wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: cz,
      width: 2.6,
      topH: 2.45,
    });
    this.addWallAlongX(t, batcher, outObbs, 'wallSiding', 'wood', cx - hx + wt, cx + hx - wt, cz + hz - wt * 0.5, floorY, wallH, wt, wr, wg, wb, {
      kind: 'door',
      center: cx,
      width: 2.4,
      topH: 2.4,
    });
    this.addWallAlongX(t, batcher, outObbs, 'wallSiding', 'wood', cx - hx + wt, cx + hx - wt, cz - hz + wt * 0.5, floorY, wallH, wt, wr, wg, wb);

    const eaveY = t.wy + floorY + wallH;
    if (batcher) {
      batcher.addGableRoof('wallSiding', 'wallSiding', centerWorld.x, eaveY, centerWorld.z, widthX, depthZ, 1.55, t.yaw, rr, rg, rb, wr, wg, wb);
      batcher.addBox('emissiveCanopy', centerWorld.x, eaveY - 0.12, centerWorld.z, 3.0, 0.06, 0.36, t.yaw, 1, 1, 1);
      if (opts.isMedicalHospital) {
        // Bold crimson Red Cross insignia atop the Field Hospital roof ridge (non-overlapping arms)
        batcher.addBox('fasciaTint', centerWorld.x, eaveY + 1.56, centerWorld.z, 2.6, 0.10, 0.72, t.yaw, 0.85, 0.14, 0.14);
        const crossN = localToWorldXZ(t, cx, cz - 0.83);
        const crossS = localToWorldXZ(t, cx, cz + 0.83);
        batcher.addBox('fasciaTint', crossN.x, eaveY + 1.56, crossN.z, 0.72, 0.10, 0.94, t.yaw, 0.85, 0.14, 0.14);
        batcher.addBox('fasciaTint', crossS.x, eaveY + 1.56, crossS.z, 0.72, 0.10, 0.94, t.yaw, 0.85, 0.14, 0.14);
      }
    }

    if (opts.isMedicalHospital) {
      // Field Hospital surgical beds/cots, stainless IV poles, surgical trolley, privacy screen & trauma supply cabinets
      for (const mx of [cx - 3.6, cx - 1.2, cx + 1.2, cx + 3.6]) {
        this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', mx, floorY + 0.35, cz - 2.3, 1.0, 0.7, 2.0, 0.75, 0.78, 0.78);
        if (batcher) {
          // Pillow + stainless IV stand pole beside each surgical cot
          const pil = localToWorldXZ(t, mx, cz - 3.02);
          batcher.addBox('wallSiding', pil.x, t.wy + floorY + 0.78, pil.z, 0.66, 0.12, 0.34, t.yaw, 0.88, 0.90, 0.92);
          const ivp = localToWorldXZ(t, mx + 0.64, cz - 2.85);
          batcher.addBox('steel', ivp.x, t.wy + floorY + 0.96, ivp.z, 0.05, 1.92, 0.05, t.yaw, 0.76, 0.80, 0.82);
          batcher.addBox('steel', ivp.x, t.wy + floorY + 1.94, ivp.z, 0.34, 0.04, 0.04, t.yaw, 0.76, 0.80, 0.82);
        }
      }
      this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', cx - 3.5, floorY + 0.85, cz + 2.5, 2.2, 1.7, 0.65, 0.80, 0.82, 0.84);
      if (batcher) {
        // Wheeled stainless instrument trolley & crimson medical privacy screen
        const cart = localToWorldXZ(t, cx + 2.8, cz + 2.2);
        batcher.addBox('steel', cart.x, t.wy + floorY + 0.45, cart.z, 0.95, 0.88, 0.62, t.yaw + 0.14, 0.74, 0.78, 0.80);
        const scr = localToWorldXZ(t, cx, cz - 2.3);
        batcher.addBox('wallSiding', scr.x, t.wy + floorY + 0.96, scr.z, 0.08, 1.85, 1.9, t.yaw, 0.68, 0.78, 0.76);
      }
    } else {
      // Supply crates, field mess tables, benches & storage racks inside logistics/billeting tent
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx - 2.5, floorY + 0.55, cz - 1.6, 1.6, 1.1, 1.2, 0.44, 0.38, 0.28);
      this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', cx + 2.4, floorY + 0.55, cz - 1.6, 1.6, 1.1, 1.2, 0.38, 0.42, 0.30);
      if (batcher) {
        // Folding field mess table + benches + corner storage rack
        const mt = localToWorldXZ(t, cx, cz + 1.4);
        batcher.addBox('woodTrim', mt.x, t.wy + floorY + 0.42, mt.z, 2.2, 0.82, 0.85, t.yaw, 0.48, 0.39, 0.28);
        const mb = localToWorldXZ(t, cx, cz + 2.15);
        batcher.addBox('woodTrim', mb.x, t.wy + floorY + 0.22, mb.z, 2.0, 0.42, 0.32, t.yaw, 0.44, 0.35, 0.26);
      }
    }

    outIndoor.push({
      cx: centerWorld.x,
      cz: centerWorld.z,
      hx: hx - 0.25,
      hz: hz - 0.25,
      cosY: t.cosY,
      sinY: t.sinY,
      minY: t.wy + floorY - 0.1,
      maxY: eaveY + 0.2,
      material: 'wood',
    });
  }

  // ============================================================================
  // INSTANCED ROADSIDE HARDWARE (Guardrails, Poles + Power Lines, Cars, Signs, Lights)
  // ============================================================================

  private populateRoadsideHardware(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    roadSegments: readonly BakedRoadSegment[],
    vehiclePlacements: Array<{ wx: number; wy: number; wz: number; yaw: number; colorHex: number }>,
    streetlightPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }>,
    barrierPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }>,
    group: THREE.Group,
    ownedGeometries: THREE.BufferGeometry[],
    instancedMeshes: THREE.InstancedMesh[],
    outObbs: SolidObb[],
    outShadowCasters?: THREE.Object3D[],
  ): number {
    const rand = mulberry32(chunkHash(cx, cz, 811));
    const halfChunk = CHUNK_SIZE_M * 0.5;

    const polePlacements: Array<{ wx: number; wy: number; wz: number; yaw: number; routeId: string; distM: number }> = [];
    const guardrailPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }> = [];
    const signPlacements: Array<{ wx: number; wy: number; wz: number; yaw: number }> = [];

    for (let i = 0; i < roadSegments.length; i++) {
      const seg = roadSegments[i];
      if (seg.isBridge) continue;

      const mx = (seg.ax + seg.bx) * 0.5;
      const mz = (seg.az + seg.bz) * 0.5;
      if (
        mx < centerX - halfChunk ||
        mx >= centerX + halfChunk ||
        mz < centerZ - halfChunk ||
        mz >= centerZ + halfChunk
      ) {
        continue;
      }

      const segYaw = Math.atan2(seg.dirX, seg.dirZ);

      // 1. Utility poles & catenary power lines every ~56m along paved roads
      if (seg.tier === 'highway' || seg.tier === 'fob_spur') {
        const prevSlot = Math.floor(seg.distFromStartM / 56);
        const nextSlot = Math.floor((seg.distFromStartM + seg.lengthM) / 56);
        if (nextSlot > prevSlot) {
          const offset = seg.halfWidthM + 2.45;
          const px = mx + seg.perpX * offset;
          const pz = mz + seg.perpZ * offset;
          const py = evaluateOpenWorldHeight(px, pz);
          if (py > SEA_LEVEL_M + 0.8) {
            polePlacements.push({
              wx: px,
              wy: py - 0.15,
              wz: pz,
              yaw: segYaw,
              routeId: seg.routeId,
              distM: seg.distFromStartM,
            });
          }
        }

        // 2. W-Beam Steel Guardrails on steeper hillsides or highway outer edges
        const sideOffset = seg.halfWidthM + 0.85;
        const leftY = evaluateOpenWorldHeight(mx - seg.perpX * (sideOffset + 3.5), mz - seg.perpZ * (sideOffset + 3.5));
        const rightY = evaluateOpenWorldHeight(mx + seg.perpX * (sideOffset + 3.5), mz + seg.perpZ * (sideOffset + 3.5));
        const centerY = evaluateOpenWorldHeight(mx, mz);

        for (const side of [-1, 1]) {
          const drop = centerY - (side < 0 ? leftY : rightY);
          if (drop > 0.72 || (seg.tier === 'highway' && (i % 7 === 0))) {
            const count = Math.max(2, Math.floor(seg.lengthM / 4.25));
            for (let g = 0; g < count; g++) {
              const frac = (g + 0.5) / count;
              const gx = seg.ax + (seg.bx - seg.ax) * frac + seg.perpX * sideOffset * side;
              const gz = seg.az + (seg.bz - seg.az) * frac + seg.perpZ * sideOffset * side;
              const gy = evaluateOpenWorldHeight(gx, gz);
              guardrailPlacements.push({ wx: gx, wy: gy, wz: gz, yaw: segYaw });
              outObbs.push({
                cx: gx,
                cy: gy + 0.52,
                cz: gz,
                hx: 0.16,
                hy: 0.52,
                hz: 2.1,
                cosY: Math.cos(segYaw),
                sinY: Math.sin(segYaw),
                surface: 'metal',
                blocksBullets: true,
                blocksPlayer: true,
              });
            }
          }
        }

        // 3. Highway Route Signs periodically along Route 41 & FOB Spurs
        if (i % 11 === 3) {
          const sx = mx - seg.perpX * (seg.halfWidthM + 2.1);
          const sz = mz - seg.perpZ * (seg.halfWidthM + 2.1);
          const sy = evaluateOpenWorldHeight(sx, sz);
          if (sy > SEA_LEVEL_M + 0.8) {
            signPlacements.push({ wx: sx, wy: sy, wz: sz, yaw: segYaw });
          }
        }

        // 4. Occasional Sodium-Vapor Streetlights along FOB spurs & Highway junctions
        if (i % 6 === 2) {
          const lx = mx - seg.perpX * (seg.halfWidthM + 1.5);
          const lz = mz - seg.perpZ * (seg.halfWidthM + 1.5);
          const ly = evaluateOpenWorldHeight(lx, lz);
          if (ly > SEA_LEVEL_M + 0.8) {
            streetlightPlacements.push({ wx: lx, wy: ly, wz: lz, yaw: segYaw + Math.PI * 0.5 });
          }
        }

        // 5. Abandoned Civilian Cars / Pickups pulled onto highway shoulders (solid tactical cover!)
        if (rand() < 0.22) {
          const side = rand() > 0.5 ? 1 : -1;
          const vx = mx + seg.perpX * (seg.halfWidthM - 0.55) * side;
          const vz = mz + seg.perpZ * (seg.halfWidthM - 0.55) * side;
          const vy = evaluateOpenWorldHeight(vx, vz);
          if (vy > SEA_LEVEL_M + 0.8) {
            const vYaw = segYaw + (rand() - 0.5) * 0.28 + (side < 0 ? Math.PI : 0);
            const colorHex = VEHICLE_BODY_PALETTE[Math.floor(rand() * VEHICLE_BODY_PALETTE.length)];
            vehiclePlacements.push({ wx: vx, wy: vy, wz: vz, yaw: vYaw, colorHex });
          }
        }
      }
    }

    let totalInstances = 0;

    // Emit Instanced Abandoned Vehicles (body + dark trim/wheels + SolidObb metal ballistic cover)
    if (vehiclePlacements.length > 0) {
      const n = vehiclePlacements.length;
      const bodies = new THREE.InstancedMesh(this.vehicleBodyGeo, this.vehicleBodyMat, n);
      const trims = new THREE.InstancedMesh(this.vehicleTrimGeo, this.vehicleTrimMat, n);
      bodies.castShadow = this.shadowsEnabled;
      bodies.receiveShadow = this.shadowsEnabled;
      trims.castShadow = false;

      for (let i = 0; i < n; i++) {
        const p = vehiclePlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        bodies.setMatrixAt(i, _dummy.matrix);
        trims.setMatrixAt(i, _dummy.matrix);
        _color.setHex(p.colorHex);
        bodies.setColorAt(i, _color);

        // Register solid vehicle hull OBB (blocks players & bullets!)
        outObbs.push({
          cx: p.wx,
          cy: p.wy + 0.82,
          cz: p.wz,
          hx: 0.96,
          hy: 0.82,
          hz: 2.24,
          cosY: Math.cos(p.yaw),
          sinY: Math.sin(p.yaw),
          surface: 'metal',
          blocksBullets: true,
          blocksPlayer: true,
        });
      }
      bodies.instanceMatrix.needsUpdate = true;
      trims.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      bodies.computeBoundingSphere();
      trims.computeBoundingSphere();
      group.add(bodies, trims);
      instancedMeshes.push(bodies, trims);
      outShadowCasters?.push(bodies);
      totalInstances += n * 2;
    }

    // Emit Instanced Streetlights (Pole + Shared Night-Emissive Lamp Diffuser)
    if (streetlightPlacements.length > 0) {
      const n = streetlightPlacements.length;
      const poles = new THREE.InstancedMesh(this.streetlightPoleGeo, this.streetlightPoleMat, n);
      const lamps = new THREE.InstancedMesh(this.streetlightLampGeo, this.streetlightEmissiveMat, n);
      poles.castShadow = false;
      for (let i = 0; i < n; i++) {
        const p = streetlightPlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        poles.setMatrixAt(i, _dummy.matrix);
        lamps.setMatrixAt(i, _dummy.matrix);
      }
      poles.instanceMatrix.needsUpdate = true;
      lamps.instanceMatrix.needsUpdate = true;
      poles.computeBoundingSphere();
      lamps.computeBoundingSphere();
      group.add(poles, lamps);
      instancedMeshes.push(poles, lamps);
      totalInstances += n * 2;
    }

    // Emit Instanced Utility Poles + Hanging Catenary Power Lines (1 LineSegments per chunk)
    if (polePlacements.length > 0) {
      const n = polePlacements.length;
      const poles = new THREE.InstancedMesh(this.utilityPoleGeo, this.utilityPoleMat, n);
      poles.castShadow = false;
      for (let i = 0; i < n; i++) {
        const p = polePlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        poles.setMatrixAt(i, _dummy.matrix);
      }
      poles.instanceMatrix.needsUpdate = true;
      poles.computeBoundingSphere();
      group.add(poles);
      instancedMeshes.push(poles);
      totalInstances += n;

      // Connect consecutive poles on the same route with sagging twin catenary cables
      const lineVerts: number[] = [];
      for (let i = 0; i < n - 1; i++) {
        const a = polePlacements[i];
        const b = polePlacements[i + 1];
        if (a.routeId !== b.routeId) continue;
        const dist = Math.hypot(b.wx - a.wx, b.wz - a.wz);
        if (dist > 85 || dist < 8) continue;

        const aCos = Math.cos(a.yaw);
        const aSin = Math.sin(a.yaw);
        const bCos = Math.cos(b.yaw);
        const bSin = Math.sin(b.yaw);

        for (const wireX of [-0.95, 0.95]) {
          const ax = a.wx - centerX + wireX * aCos;
          const ay = a.wy + 8.6;
          const az = a.wz - centerZ - wireX * aSin;
          const bx = b.wx - centerX + wireX * bCos;
          const by = b.wy + 8.6;
          const bz = b.wz - centerZ - wireX * bSin;

          const sag = Math.min(1.65, dist * 0.022);
          const steps = 4;
          for (let s = 0; s < steps; s++) {
            const t0 = s / steps;
            const t1 = (s + 1) / steps;
            const sag0 = 4 * t0 * (1 - t0) * sag;
            const sag1 = 4 * t1 * (1 - t1) * sag;
            lineVerts.push(
              ax + (bx - ax) * t0,
              ay + (by - ay) * t0 - sag0,
              az + (bz - az) * t0,
              ax + (bx - ax) * t1,
              ay + (by - ay) * t1 - sag1,
              az + (bz - az) * t1,
            );
          }
        }
      }
      if (lineVerts.length > 0) {
        const wireGeo = new THREE.BufferGeometry();
        wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
        wireGeo.computeBoundingSphere();
        const wires = new THREE.LineSegments(wireGeo, this.powerLineMat);
        group.add(wires);
        ownedGeometries.push(wireGeo);
      }
    }

    // Emit Instanced W-Beam Steel Guardrails
    if (guardrailPlacements.length > 0) {
      const n = guardrailPlacements.length;
      const rails = new THREE.InstancedMesh(this.guardrailGeo, this.guardrailMat, n);
      rails.castShadow = false;
      rails.receiveShadow = this.shadowsEnabled;
      for (let i = 0; i < n; i++) {
        const p = guardrailPlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        rails.setMatrixAt(i, _dummy.matrix);
      }
      rails.instanceMatrix.needsUpdate = true;
      rails.computeBoundingSphere();
      group.add(rails);
      instancedMeshes.push(rails);
      totalInstances += n;
    }

    // Emit Instanced Checkpoint Jersey Barriers
    if (barrierPlacements.length > 0) {
      const n = barrierPlacements.length;
      const barriers = new THREE.InstancedMesh(this.barrierGeo, this.barrierMat, n);
      barriers.castShadow = this.shadowsEnabled;
      barriers.receiveShadow = this.shadowsEnabled;
      for (let i = 0; i < n; i++) {
        const p = barrierPlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        barriers.setMatrixAt(i, _dummy.matrix);
      }
      barriers.instanceMatrix.needsUpdate = true;
      barriers.computeBoundingSphere();
      group.add(barriers);
      instancedMeshes.push(barriers);
      outShadowCasters?.push(barriers);
      totalInstances += n;
    }

    // Emit Instanced Highway Signs
    if (signPlacements.length > 0) {
      const n = signPlacements.length;
      const posts = new THREE.InstancedMesh(this.signPostGeo, this.signPostMat, n);
      const boards = new THREE.InstancedMesh(this.signBoardGeo, this.signBoardMat, n);
      for (let i = 0; i < n; i++) {
        const p = signPlacements[i];
        _dummy.position.set(p.wx - centerX, p.wy, p.wz - centerZ);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        posts.setMatrixAt(i, _dummy.matrix);
        boards.setMatrixAt(i, _dummy.matrix);
      }
      posts.instanceMatrix.needsUpdate = true;
      boards.instanceMatrix.needsUpdate = true;
      posts.computeBoundingSphere();
      boards.computeBoundingSphere();
      group.add(posts, boards);
      instancedMeshes.push(posts, boards);
      totalInstances += n * 2;
    }

    return totalInstances;
  }

  public dispose(): void {
    for (const tex of this.textures) tex.dispose();
    this.textures.length = 0;

    for (const mat of Object.values(this.archMaterials)) mat.dispose();
    this.highwayMat.dispose();
    this.spurMat.dispose();
    this.dirtMat.dispose();
    this.midRoadMat.dispose();
    this.vehicleBodyMat.dispose();
    this.vehicleTrimMat.dispose();
    this.streetlightPoleMat.dispose();
    this.streetlightEmissiveMat.dispose();
    this.utilityPoleMat.dispose();
    this.powerLineMat.dispose();
    this.guardrailMat.dispose();
    this.barrierMat.dispose();
    this.signPostMat.dispose();
    this.signBoardMat.dispose();
    this.midSiteMat.dispose();

    this.vehicleBodyGeo.dispose();
    this.vehicleTrimGeo.dispose();
    this.streetlightPoleGeo.dispose();
    this.streetlightLampGeo.dispose();
    this.utilityPoleGeo.dispose();
    this.guardrailGeo.dispose();
    this.barrierGeo.dispose();
    this.signPostGeo.dispose();
    this.signBoardGeo.dispose();
    this.midSiteGeo.dispose();
  }

  /**
   * Diagnostic audit helper (used by automated Z-fighting/coplanarity tests)
   * that returns all box primitives emitted for a given FOB compound or baked site.
   */
  public auditFobCompoundBoxes(fob: FobCompoundSpec): AuditedArchBox[] {
    const log: AuditedArchBox[] = [];
    const batcher = new ChunkGeometryBatcher(fob.worldX, fob.worldZ, log);
    this.buildFobCompound(fob, batcher, [], [], [], null, null, null);
    return log;
  }

  public auditSiteBoxes(site: BakedOpenWorldSite): AuditedArchBox[] {
    const log: AuditedArchBox[] = [];
    const batcher = new ChunkGeometryBatcher(site.x, site.z, log);
    this.buildSite(site, batcher, [], [], [], null, null, null);
    return log;
  }

  public auditHorizonCivilizationBoxes(): AuditedArchBox[] {
    const log: AuditedArchBox[] = [];
    const batcher = new ChunkGeometryBatcher(0, 0, log);
    const wires: number[] = [];
    for (const b of getBakedRiverBridges()) this.appendSteelTrussBridgeGeometry(batcher, b);
    for (const t of getBakedHorizonTowers()) {
      if (t.kind === 'water_tower') this.appendWaterTowerGeometry(batcher, t);
      else this.appendRadioMastGeometry(batcher, t, wires);
    }
    return log;
  }
}

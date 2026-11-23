import * as THREE from 'three';
import type { BodycamSurfaceMaterial } from '../../../../bodycam-sdk/types';
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
  SEA_LEVEL_M,
} from './OpenWorldTerrain';

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

class ChunkGeometryBatcher {
  private readonly buckets = new Map<ArchMaterialKey, GeometryBucket>();
  private readonly chunkOriginX: number;
  private readonly chunkOriginZ: number;

  constructor(chunkOriginX: number, chunkOriginZ: number) {
    this.chunkOriginX = chunkOriginX;
    this.chunkOriginZ = chunkOriginZ;
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

  constructor(isSoftwareGl = false, atmoFogUniforms?: AtmoFogSharedUniforms) {
    this.isSoftwareGl = isSoftwareGl;

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

    // Shared architectural PBR materials (vertexColors enabled for zero-draw-call facade tinting)
    this.archMaterials = {
      concrete: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: concTex,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.04,
      }),
      concreteDark: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: concTex,
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.06,
      }),
      wallSiding: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: wallTex,
        vertexColors: true,
        roughness: 0.86,
        metalness: 0.02,
      }),
      barnWood: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: barnTex,
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.02,
      }),
      roofMetal: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: roofTex,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.42,
      }),
      steel: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.46,
        metalness: 0.68,
      }),
      woodTrim: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.02,
      }),
      fasciaTint: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.52,
        metalness: 0.25,
      }),
      emissiveCanopy: new THREE.MeshStandardMaterial({
        color: 0xd8e8f2,
        emissive: 0xdcf4ff,
        emissiveIntensity: 0.15,
        roughness: 0.35,
        metalness: 0.1,
      }),
      emissiveFlood: new THREE.MeshStandardMaterial({
        color: 0xffe4b8,
        emissive: 0xffc878,
        emissiveIntensity: 0.15,
        roughness: 0.35,
        metalness: 0.1,
      }),
      emissiveBeacon: new THREE.MeshStandardMaterial({
        color: 0xd92626,
        emissive: 0xff2a2a,
        emissiveIntensity: 0.4,
        roughness: 0.25,
        metalness: 0.1,
      }),
    };

    // Road ribbon materials with polygonOffset to eliminate Z-fighting against terrain
    this.highwayMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: hwTex,
      roughness: 0.9,
      metalness: 0.03,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.spurMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: spurTex,
      roughness: 0.91,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.dirtMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: dirtTex,
      roughness: 0.96,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.midRoadMat = new THREE.MeshStandardMaterial({
      color: 0x3b3f44,
      roughness: 0.95,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    // Instanced roadside hardware materials
    this.vehicleBodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.56,
      metalness: 0.42,
    });
    this.vehicleTrimMat = new THREE.MeshStandardMaterial({
      color: 0x1e2227,
      roughness: 0.72,
      metalness: 0.24,
    });
    this.streetlightPoleMat = new THREE.MeshStandardMaterial({
      color: 0x5c646b,
      roughness: 0.48,
      metalness: 0.62,
    });
    this.streetlightEmissiveMat = new THREE.MeshStandardMaterial({
      color: 0xffe4b8,
      emissive: 0xffa838,
      emissiveIntensity: 0.1,
      roughness: 0.3,
      metalness: 0.1,
    });
    this.utilityPoleMat = new THREE.MeshStandardMaterial({
      color: 0x4b3b2e,
      roughness: 0.94,
      metalness: 0.02,
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
    });
    this.barrierMat = new THREE.MeshStandardMaterial({
      color: 0x8d908e,
      map: concTex,
      roughness: 0.88,
      metalness: 0.04,
    });
    this.signPostMat = new THREE.MeshStandardMaterial({
      color: 0x676f77,
      roughness: 0.5,
      metalness: 0.62,
    });
    this.signBoardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: signTex,
      roughness: 0.42,
      metalness: 0.15,
    });
    this.midSiteMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.08,
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
      // Roadway surface slab
      addBridgePart('concreteDark', 0, -0.35, lz, b.widthM, 0.7, bayLen + 0.12, 0.34, 0.36, 0.38);
      // Raised sidewalk/curb shoulders on both sides
      addBridgePart('concrete', -halfW + 0.55, 0.12, lz, 1.05, 0.34, bayLen + 0.1, 0.64, 0.66, 0.65);
      addBridgePart('concrete', halfW - 0.55, 0.12, lz, 1.05, 0.34, bayLen + 0.1, 0.64, 0.66, 0.65);
      // Steel underside longitudinal girders
      addBridgePart('steel', -halfW + 1.2, -1.05, lz, 0.45, 0.85, bayLen + 0.1, 0.32, 0.36, 0.40);
      addBridgePart('steel', halfW - 1.2, -1.05, lz, 0.45, 0.85, bayLen + 0.1, 0.32, 0.36, 0.40);

      // Side steel safety guardrails (solid ballistic cover!)
      addBridgePart('steel', -halfW + 0.18, 0.92, lz, 0.22, 0.36, bayLen + 0.08, 0.50, 0.54, 0.56);
      addBridgePart('steel', halfW - 0.18, 0.92, lz, 0.22, 0.36, bayLen + 0.08, 0.50, 0.54, 0.56);

      // Upper steel truss chords & overhead portal bracing on interior bays
      if (i > 0 && i < bays - 1) {
        addBridgePart('steel', -halfW + 0.24, 5.4, lz, 0.38, 0.42, bayLen + 0.1, 0.30, 0.35, 0.38);
        addBridgePart('steel', halfW - 0.24, 5.4, lz, 0.38, 0.42, bayLen + 0.1, 0.30, 0.35, 0.38);
        // Overhead portal crossbeam every bay
        addBridgePart('steel', 0, 5.4, lz - bayLen * 0.5, b.widthM - 0.4, 0.38, 0.38, 0.32, 0.36, 0.40);
      }

      // Vertical truss posts at bay joints
      const postZ = -halfLen + i * bayLen;
      if (i > 0) {
        const postH = i === 1 || i === bays - 1 ? 5.6 : 5.6;
        addBridgePart('steel', -halfW + 0.24, postH * 0.5, postZ, 0.36, postH, 0.36, 0.34, 0.38, 0.42);
        addBridgePart('steel', halfW - 0.24, postH * 0.5, postZ, 0.36, postH, 0.36, 0.34, 0.38, 0.42);
      }
    }

    // 2 heavy reinforced concrete river piers sunk deep (-18m) below river floor
    for (const pierFrac of [-0.24, 0.24]) {
      const pz = pierFrac * b.lengthM;
      addBridgePart('concrete', -halfW + 1.4, -10.5, pz, 2.2, 19.5, 3.2, 0.58, 0.60, 0.58);
      addBridgePart('concrete', halfW - 1.4, -10.5, pz, 2.2, 19.5, 3.2, 0.58, 0.60, 0.58);
      addBridgePart('concrete', 0, -1.65, pz, b.widthM - 0.6, 1.6, 2.6, 0.56, 0.58, 0.56);
    }

    // Heavy concrete end abutments seated deeply into both riverbanks
    for (const endSign of [-1, 1]) {
      const az = endSign * (halfLen + 1.8);
      addBridgePart('concrete', 0, -5.0, az, b.widthM + 2.4, 10.2, 4.4, 0.62, 0.63, 0.60);
      // End approach wing walls
      addBridgePart('concrete', -halfW - 0.85, 0.55, az, 0.65, 1.3, 4.8, 0.65, 0.66, 0.64);
      addBridgePart('concrete', halfW + 0.85, 0.55, az, 0.65, 1.3, 4.8, 0.65, 0.66, 0.64);
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

    // Horizontal cross-bracing rings at 2 heights
    for (const frac of [0.35, 0.7]) {
      const ry = baseY + legH * frac;
      batcher.addBox('steel', t.x, ry, t.z + spread, spread * 2, 0.34, 0.34, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x, ry, t.z - spread, spread * 2, 0.34, 0.34, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x + spread, ry, t.z, 0.34, 0.34, spread * 2, 0, 0.42, 0.47, 0.50);
      batcher.addBox('steel', t.x - spread, ry, t.z, 0.34, 0.34, spread * 2, 0, 0.42, 0.47, 0.50);
    }

    // Central riser pipe
    batcher.addBox('steel', t.x, baseY + legH * 0.5, t.z, 1.3, legH + 1.0, 1.3, 0, 0.38, 0.42, 0.46);

    // Elevated steel tank body (octagonal composite from 2 rotated square prisms) + catwalk + cap
    const tankY = baseY + legH + 3.6;
    batcher.addBox('steel', t.x, tankY, t.z, 8.2, 6.8, 8.2, 0, 0.62, 0.67, 0.69);
    batcher.addBox('steel', t.x, tankY, t.z, 8.2, 6.8, 8.2, Math.PI * 0.25, 0.60, 0.65, 0.67);
    // Catwalk ring
    batcher.addBox('steel', t.x, baseY + legH + 0.3, t.z, 10.6, 0.32, 10.6, 0, 0.36, 0.40, 0.44);
    // Conical cap silhouette + aviation finial beacon
    batcher.addBox('roofMetal', t.x, tankY + 4.2, t.z, 6.8, 1.6, 6.8, Math.PI * 0.25, 0.44, 0.49, 0.52);
    batcher.addBox('roofMetal', t.x, tankY + 5.4, t.z, 3.6, 1.2, 3.6, 0, 0.44, 0.49, 0.52);
    batcher.addBox('emissiveBeacon', t.x, tankY + 6.5, t.z, 0.65, 0.85, 0.65, 0, 1, 1, 1);
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
    for (let s = 0; s < segCount; s++) {
      const frac = s / segCount;
      const w = 2.4 - frac * 1.45;
      const sy = baseY + (s + 0.5) * segH;
      const isRed = s % 2 === 0;
      const r = isRed ? 0.78 : 0.86;
      const g = isRed ? 0.22 : 0.87;
      const b = isRed ? 0.18 : 0.85;

      // 4 lattice corner rails
      const o = w * 0.45;
      for (const cx of [-o, o]) {
        for (const cz of [-o, o]) {
          batcher.addBox('fasciaTint', t.x + cx, sy, t.z + cz, 0.24, segH, 0.24, 0, r, g, b);
        }
      }
      // Horizontal ring brace
      batcher.addBox('fasciaTint', t.x, baseY + (s + 1) * segH, t.z, w, 0.22, w, 0, r, g, b);
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

    meshCount += batcher.finalizeToGroup(
      group,
      this.archMaterials,
      ownedGeometries,
      !this.isSoftwareGl,
      !this.isSoftwareGl,
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
    );

    return { instanceCount, meshCount };
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
      // Subtle timber door jamb trim (visual only, flush inside jamb)
      if (batcher) {
        const pL = localToWorldXZ(t, oMin + 0.03, lz);
        const pR = localToWorldXZ(t, oMax - 0.03, lz);
        batcher.addBox('woodTrim', pL.x, t.wy + baseY + doorTop * 0.5, pL.z, 0.07, doorTop, thick + 0.06, t.yaw, 0.34, 0.27, 0.22);
        batcher.addBox('woodTrim', pR.x, t.wy + baseY + doorTop * 0.5, pR.z, 0.07, doorTop, thick + 0.06, t.yaw, 0.34, 0.27, 0.22);
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
      // Recessed window sill ledge
      if (batcher) {
        const pMid = localToWorldXZ(t, openMid, lz);
        batcher.addBox('woodTrim', pMid.x, t.wy + baseY + sillH + 0.02, pMid.z, openW + 0.14, 0.08, thick + 0.12, t.yaw, 0.38, 0.33, 0.28);
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
        batcher.addBox('woodTrim', pMid.x, t.wy + baseY + sillH + 0.02, pMid.z, thick + 0.12, 0.08, openW + 0.14, t.yaw, 0.38, 0.33, 0.28);
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

    // 1. Deep Concrete Foundation Plinth (-1.8m subterranean skirt prevents any hillside floating)
    if (batcher) {
      batcher.addBox('concrete', t.wx, t.wy - 0.82, t.wz, widthX + 0.3, 2.08, depthZ + 0.3, t.yaw, 0.62, 0.63, 0.60);
      // Warm timber interior floor deck
      batcher.addBox('barnWood', t.wx, t.wy + floorTopY - 0.04, t.wz, widthX - 0.2, 0.08, depthZ - 0.2, t.yaw, 0.68, 0.54, 0.40);
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

    // Front Porch deck & posts for homesteads
    if (hasPorch && batcher) {
      const porchCenter = localToWorldXZ(t, 0, hz + 0.9);
      batcher.addBox('concrete', porchCenter.x, t.wy - 0.78, porchCenter.z, widthX * 0.72, 2.0, 1.85, t.yaw, 0.60, 0.61, 0.59);
      // Porch canopy & 2 slender timber posts
      batcher.addBox('roofMetal', porchCenter.x, t.wy + floorTopY + 2.68, porchCenter.z, widthX * 0.74, 0.16, 1.95, t.yaw, rr, rg, rb);
      for (const px of [-widthX * 0.31, widthX * 0.31]) {
        const pp = localToWorldXZ(t, px, hz + 1.68);
        batcher.addBox('woodTrim', pp.x, t.wy + floorTopY + 1.35, pp.z, 0.18, 2.7, 0.18, t.yaw, 0.45, 0.36, 0.28);
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

    // 5. Interior Tactical Cover Props (Wooden Table / Supply Crates — clear of doorway sightlines)
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
    // Canopy roof slab + vibrant brand fascia trim + night-emissive ceiling light panels
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'metal', 0, padTopY + canopyH + 0.32, canopyZ, 14.4, 0.56, 9.2, 0.84, 0.85, 0.86);
    if (batcher) {
      const cp = localToWorldXZ(t, 0, canopyZ);
      batcher.addBox('fasciaTint', cp.x, t.wy + padTopY + canopyH + 0.36, cp.z, 14.65, 0.48, 9.45, t.yaw, br, bg, bb);
      // 4 glowing soffit ceiling fixtures under canopy (no PointLights!)
      for (const lx of [-3.6, 0, 3.6]) {
        const lp = localToWorldXZ(t, lx, canopyZ);
        batcher.addBox('emissiveCanopy', lp.x, t.wy + padTopY + canopyH - 0.02, lp.z, 1.5, 0.08, 3.2, t.yaw, 1, 1, 1);
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

    // Store flat roof slab + brand fascia stripe + rooftop AC unit
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', 0, storeFloorY + storeH + 0.22, storeZ, storeW + 0.6, 0.44, storeD + 0.6, 0.50, 0.52, 0.54);
    if (batcher) {
      const sp = localToWorldXZ(t, 0, storeZ);
      batcher.addBox('fasciaTint', sp.x, t.wy + storeFloorY + storeH + 0.28, sp.z, storeW + 0.72, 0.36, storeD + 0.72, t.yaw, br, bg, bb);
      const ac = localToWorldXZ(t, 3.2, storeZ - 1.0);
      batcher.addBox('steel', ac.x, t.wy + storeFloorY + storeH + 0.92, ac.z, 1.8, 0.95, 1.4, t.yaw, 0.62, 0.65, 0.67);
    }

    // Interior Store Props: L-Checkout Counter, 2 Merch Shelving Aisles, Back Office Partition
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -3.4, storeFloorY + 0.52, storeZ + 1.4, 2.8, 1.04, 0.72, 0.56, 0.44, 0.32);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 1.4, storeFloorY + 0.82, storeZ + 0.6, 0.62, 1.64, 2.8, 0.62, 0.66, 0.68);
    this.addSolidBox(t, batcher, outObbs, 'steel', 'metal', 3.9, storeFloorY + 0.82, storeZ + 0.6, 0.62, 1.64, 2.8, 0.62, 0.66, 0.68);
    // Back storage room partition with open pass-through
    this.addWallAlongX(t, batcher, outObbs, 'concrete', 'concrete', -shx + wt, 0.4, storeZ - 1.5, storeFloorY, storeH - 0.1, 0.18, 0.74, 0.74, 0.72, {
      kind: 'door',
      center: -1.4,
      width: 1.5,
      topH: 2.3,
    });

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
      batcher.addBox('concrete', t.wx, t.wy - 0.85, t.wz, widthX + 0.3, 2.08, depthZ + 0.3, t.yaw, 0.58, 0.58, 0.56);
      batcher.addBox('barnWood', t.wx, t.wy + floorY - 0.04, t.wz, widthX - 0.2, 0.08, depthZ - 0.2, t.yaw, 0.56, 0.45, 0.34);
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

    // Interior hay bales & timber crates for tactical gunfight cover
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.2, floorY + 0.65, 1.8, 1.9, 1.3, 1.4, 0.68, 0.58, 0.30);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', 4.1, floorY + 0.65, -1.6, 1.8, 1.3, 1.8, 0.64, 0.54, 0.28);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', -4.0, floorY + 0.55, -2.6, 1.5, 1.1, 1.3, 0.48, 0.38, 0.26);

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
    // Flat roof overhang + interior tactical desk
    this.addSolidBox(t, batcher, outObbs, 'concreteDark', 'concrete', gx, floorY + wallH + 0.16, 0, gw + 0.9, 0.32, gd + 0.9, 0.44, 0.47, 0.48);
    this.addSolidBox(t, batcher, outObbs, 'woodTrim', 'wood', gx + 1.1, floorY + 0.46, 0.9, 1.1, 0.92, 0.72, 0.46, 0.38, 0.28);

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

    // Opposite HESCO / sandbag firing bastion (-6.4m X)
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -6.4, 0.62, 0, 2.1, 1.24, 4.4, 0.64, 0.58, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -5.6, 0.62, 2.2, 2.2, 1.24, 1.2, 0.64, 0.58, 0.46);
    this.addSolidBox(t, batcher, outObbs, 'concrete', 'concrete', -5.6, 0.62, -2.2, 2.2, 1.24, 1.2, 0.64, 0.58, 0.46);

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
        if (rand() < 0.14) {
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
      bodies.castShadow = !this.isSoftwareGl;
      bodies.receiveShadow = !this.isSoftwareGl;
      trims.castShadow = !this.isSoftwareGl;

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
      totalInstances += n * 2;
    }

    // Emit Instanced Streetlights (Pole + Shared Night-Emissive Lamp Diffuser)
    if (streetlightPlacements.length > 0) {
      const n = streetlightPlacements.length;
      const poles = new THREE.InstancedMesh(this.streetlightPoleGeo, this.streetlightPoleMat, n);
      const lamps = new THREE.InstancedMesh(this.streetlightLampGeo, this.streetlightEmissiveMat, n);
      poles.castShadow = !this.isSoftwareGl;
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
      poles.castShadow = !this.isSoftwareGl;
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
      rails.castShadow = !this.isSoftwareGl;
      rails.receiveShadow = !this.isSoftwareGl;
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
      barriers.castShadow = !this.isSoftwareGl;
      barriers.receiveShadow = !this.isSoftwareGl;
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
}

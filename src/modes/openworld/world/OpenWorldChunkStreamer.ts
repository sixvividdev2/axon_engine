import * as THREE from 'three';
import type { BodycamInteriorSample, BodycamSurfaceMaterial } from '../../../../bodycam-sdk/types';
import type { GraphicsQualityProfile } from '../../../../data/graphicsQuality';
import { OpenWorldArchitectureBuilder } from './OpenWorldArchitectureBuilder';
import { MACRO_OCCLUDER_LAYER } from './OpenWorldAtmosphere';
import {
  FOB_GUARD_TOWER_DECK_HEIGHT_M,
  type FobCompoundId,
  getFobCompoundSpec,
  getFobGuardTowerSpecs,
  getFobTerminalAnchor,
  isFobCompoundId,
} from './OpenWorldFobLayout';
import {
  applyAtmosphericHeightFog,
  type AtmoFogSharedUniforms,
} from './OpenWorldAtmosphericFogShader';
import { FoliageAnchorPoint, OpenWorldFoliageBuilder } from './OpenWorldFoliageBuilder';
import {
  isEligibleOccluderObb,
  type OpenWorldOcclusionCuller,
} from './OpenWorldOcclusionCuller';
import {
  getBakedOpenWorldSites,
  hasOverheadClearanceAgainstObbs,
  IndoorVolume,
  isOnCivilizationClearance,
  ObbRaycastHit,
  queryBridgeDeckHeight,
  raycastAgainstObbs,
  resolveCapsuleHorizontalAgainstObbs,
  sampleIndoorVolumeFromList,
  sampleWalkDeckHeightFromList,
  SolidObb,
  WalkDeck,
} from './OpenWorldCivilizationTopology';
import {
  CHUNK_SIZE_M,
  chunkCoordToWorldCenter,
  chunkHash,
  chunkKey,
  createTerrainSample,
  evaluateOpenWorldHeight,
  isValidChunkCoord,
  mulberry32,
  OPENWORLD_LANDMARKS,
  RESERVOIR_LEVEL_M,
  sampleOpenWorldTerrain,
  sampleOpenWorldTerrainFromHeight,
  SEA_LEVEL_M,
  WORLD_HALF_M,
  WORLD_SIZE_M,
  worldToChunkCoord,
} from './OpenWorldTerrain';

export type ChunkLodTier = 'active' | 'mid';

export interface ActiveHeightfieldCollider {
  readonly cx: number;
  readonly cz: number;
  readonly minX: number;
  readonly minZ: number;
  readonly segs: number;
  readonly stepM: number;
  readonly heights: Float32Array;
}

interface StreamedChunkRecord {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly centerX: number;
  readonly centerZ: number;
  readonly lod: ChunkLodTier;
  readonly group: THREE.Group;
  readonly bounds: THREE.Box3;
  readonly terrainGeo: THREE.BufferGeometry;
  readonly ownedGeometries: THREE.BufferGeometry[];
  readonly instancedMeshes: THREE.InstancedMesh[];
  readonly batchedMeshes: THREE.BatchedMesh[];
  readonly microMeshes: THREE.Object3D[];
  readonly shadowCasterMeshes: THREE.Object3D[];
  readonly solidObbs: SolidObb[];
  readonly occluderObbs: SolidObb[];
  readonly occludableBatches: Array<{ obj: THREE.Object3D; worldBox: THREE.Box3; isMicro: boolean }>;
  readonly walkDecks: WalkDeck[];
  readonly indoorVolumes: IndoorVolume[];
  readonly treeRoosts: FoliageAnchorPoint[];
  readonly logAnchors: FoliageAnchorPoint[];
  readonly rockAnchors: FoliageAnchorPoint[];
  readonly collider: ActiveHeightfieldCollider | null;
  readonly instanceCount: number;
}

interface PendingChunkSpec {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly lod: ChunkLodTier;
  readonly priority: number;
}

interface AmbientSmokePuff {
  readonly baseX: number;
  readonly baseY: number;
  readonly baseZ: number;
  readonly phase: number;
  readonly riseSpeed: number;
  readonly maxHeightM: number;
  readonly driftAngle: number;
  readonly baseScale: number;
}

export interface StreamerStats {
  centerChunkX: number;
  centerChunkZ: number;
  activeChunkCount: number;
  midChunkCount: number;
  totalLoadedChunks: number;
  visibleChunkCount: number;
  culledBehindChunkCount: number;
  occludedChunkCount: number;
  occludedObjectCount: number;
  activeInstanceCount: number;
  activeBatchedMeshCount: number;
  disposedChunkCount: number;
  landmarkCount: number;
}

const ACTIVE_TERRAIN_SEGS = 28;
const MID_TERRAIN_SEGS = 10;
const HLOD_TERRAIN_SEGS = 64;

// Module-scope zero-GC scratch helpers
const _sample = createTerrainSample();
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _cullFrustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _paddedBox = new THREE.Box3();
const _smokeDummy = new THREE.Object3D();

function createProceduralTerrainTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, size, size);
  const rand = mulberry32(991122);
  for (let i = 0; i < 6500; i++) {
    const x = Math.floor(rand() * size);
    const y = Math.floor(rand() * size);
    const w = 1 + Math.floor(rand() * 3);
    const v = 175 + Math.floor(rand() * 68);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, y, w, w);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createTerrainChunkGeometry(
  cx: number,
  cz: number,
  segs: number,
  heightfieldOut?: Float32Array,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(CHUNK_SIZE_M, CHUNK_SIZE_M, segs, segs);
  geo.rotateX(-Math.PI * 0.5);

  const centerX = chunkCoordToWorldCenter(cx);
  const centerZ = chunkCoordToWorldCenter(cz);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const vertCount = pos.count;
  const cols = segs + 1;
  const invStep = segs / CHUNK_SIZE_M;
  const heights = heightfieldOut && heightfieldOut.length >= vertCount
    ? heightfieldOut
    : new Float32Array(vertCount);
  const colors = new Float32Array(vertCount * 3);

  // Pass 1: Evaluate authoritative terrain height ONCE per vertex (3x fewer analytical FBM evals)
  for (let i = 0; i < vertCount; i++) {
    const wx = centerX + pos.getX(i);
    const wz = centerZ + pos.getZ(i);
    const h = evaluateOpenWorldHeight(wx, wz);
    heights[i] = h;
    pos.setY(i, h);
  }

  // Pass 2: Derive slope via finite difference on cached height grid & classify biome vertex colors
  for (let iz = 0; iz <= segs; iz++) {
    const izNext = iz < segs ? iz + 1 : iz - 1;
    const row = iz * cols;
    const rowNext = izNext * cols;
    for (let ix = 0; ix <= segs; ix++) {
      const i = row + ix;
      const ixNext = ix < segs ? ix + 1 : ix - 1;
      const h = heights[i];
      const dx = (heights[row + ixNext] - h) * invStep;
      const dz = (heights[rowNext + ix] - h) * invStep;
      const slope = Math.min(1, Math.hypot(dx, dz));
      const wx = centerX + pos.getX(i);
      const wz = centerZ + pos.getZ(i);
      sampleOpenWorldTerrainFromHeight(wx, wz, h, slope, _sample);
      colors[i * 3] = _sample.r;
      colors[i * 3 + 1] = _sample.g;
      colors[i * 3 + 2] = _sample.b;
    }
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function sampleColliderHeightAndSlope(
  collider: ActiveHeightfieldCollider,
  worldX: number,
  worldZ: number,
  out: { height: number; slope: number },
): void {
  const fx = (worldX - collider.minX) / collider.stepM;
  const fz = (worldZ - collider.minZ) / collider.stepM;
  const ix = Math.max(0, Math.min(collider.segs - 1, Math.floor(fx)));
  const iz = Math.max(0, Math.min(collider.segs - 1, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - ix));
  const tz = Math.max(0, Math.min(1, fz - iz));
  const cols = collider.segs + 1;
  const h00 = collider.heights[iz * cols + ix];
  const h10 = collider.heights[iz * cols + ix + 1];
  const h01 = collider.heights[(iz + 1) * cols + ix];
  const h11 = collider.heights[(iz + 1) * cols + ix + 1];
  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  out.height = h0 + (h1 - h0) * tz;
  const invStep = 1 / collider.stepM;
  const dhx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) * invStep;
  const dhz = ((h01 - h00) * (1 - tx) + (h11 - h10) * tx) * invStep;
  out.slope = Math.min(1, Math.hypot(dhx, dhz));
}

/**
 * Creates a grounded bottom-center cylinder/cone/box shared geometry for InstancedMesh props.
 */
function buildGroundedConiferCanopyGeo(): THREE.BufferGeometry {
  // Multi-tier conifer silhouette baked into a single indexed BufferGeometry (1 draw call for all pines)
  const tiers = [
    { y0: 2.0, y1: 5.2, r0: 2.15, r1: 0.72 },
    { y0: 4.3, y1: 7.4, r0: 1.72, r1: 0.45 },
    { y0: 6.5, y1: 9.8, r0: 1.18, r1: 0.05 },
  ];
  const radial = 7;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  let baseIndex = 0;
  for (const tier of tiers) {
    const dy = tier.y1 - tier.y0;
    const dr = tier.r0 - tier.r1;
    const invLen = 1 / Math.hypot(dy, dr);
    const ny = dr * invLen;
    const nr = dy * invLen;

    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions.push(ca * tier.r0, tier.y0, sa * tier.r0);
      normals.push(ca * nr, ny, sa * nr);
      positions.push(ca * tier.r1, tier.y1, sa * tier.r1);
      normals.push(ca * nr, ny, sa * nr);
    }

    for (let i = 0; i < radial; i++) {
      const a = baseIndex + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    baseIndex += (radial + 1) * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Compact 4-sided 2-tier conifer silhouette for 5x5 mid-range shells and 4km horizon forest canopy.
 * Only 16 triangles per tree with outward normals for FrontSide hardware backface culling.
 */
function buildMidConiferGeo(): THREE.BufferGeometry {
  const tiers = [
    { y0: 0.45, y1: 5.6, r0: 2.25, r1: 0.58 },
    { y0: 4.5, y1: 9.9, r0: 1.48, r1: 0.05 },
  ];
  const radial = 4;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  let baseIndex = 0;
  for (const tier of tiers) {
    const dy = tier.y1 - tier.y0;
    const dr = tier.r0 - tier.r1;
    const invLen = 1 / Math.hypot(dy, dr);
    const ny = dr * invLen;
    const nr = dy * invLen;

    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions.push(ca * tier.r0, tier.y0, sa * tier.r0);
      normals.push(ca * nr, ny, sa * nr);
      positions.push(ca * tier.r1, tier.y1, sa * tier.r1);
      normals.push(ca * nr, ny, sa * nr);
    }

    for (let i = 0; i < radial; i++) {
      const a = baseIndex + i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    baseIndex += (radial + 1) * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Merges composite box parts into a compact indexed BufferGeometry with identical
 * `position` + `normal` attributes for zero-draw-call `THREE.BatchedMesh` heterogeneous prop packing.
 */
function buildCompositeBatchedPropGeo(
  boxes: ReadonlyArray<{ x: number; y: number; z: number; sx: number; sy: number; sz: number }>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const posAttr = unitBox.attributes.position as THREE.BufferAttribute;
  const normAttr = unitBox.attributes.normal as THREE.BufferAttribute;
  const idx = unitBox.index!;
  let vertOffset = 0;

  for (const b of boxes) {
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(
        posAttr.getX(i) * b.sx + b.x,
        posAttr.getY(i) * b.sy + b.y,
        posAttr.getZ(i) * b.sz + b.z,
      );
      normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
    }
    for (let i = 0; i < idx.count; i++) {
      indices.push(vertOffset + idx.getX(i));
    }
    vertOffset += posAttr.count;
  }
  unitBox.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 4km × 4km 3-Ring Chunk Streamer (`3×3` Active Ring, `5×5` Mid-Range Shell, `4km+` Horizon Proxy).
 * - Uses shared PBR materials and front-packed `InstancedMesh` batches to stay well under 150 draw calls.
 * - Explicitly `.dispose()`s every unloaded or LOD-swapped chunk's geometries and buffers.
 */
export class OpenWorldChunkStreamer {
  public readonly rootGroup = new THREE.Group();
  private readonly chunksGroup = new THREE.Group();
  private readonly horizonGroup = new THREE.Group();

  private readonly loadedChunks = new Map<string, StreamedChunkRecord>();
  private readonly activeChunks: StreamedChunkRecord[] = [];
  private readonly fobHorizonGroups = new Map<FobCompoundId, THREE.Group>();
  private readonly activeTreeRoosts: FoliageAnchorPoint[] = [];
  private readonly activeLogAnchors: FoliageAnchorPoint[] = [];
  private readonly activeRockAnchors: FoliageAnchorPoint[] = [];
  private readonly isSoftwareGl: boolean;
  private readonly archBuilder: OpenWorldArchitectureBuilder;
  private readonly foliageBuilder: OpenWorldFoliageBuilder;

  // Shared reusable materials & base geometries (disposed on streamer teardown)
  private readonly terrainTexture: THREE.CanvasTexture | null;
  private readonly activeTerrainMat: THREE.MeshStandardMaterial;
  private readonly midTerrainMat: THREE.MeshStandardMaterial;
  private readonly hlodTerrainMat: THREE.MeshStandardMaterial;

  private readonly trunkGeo: THREE.CylinderGeometry;
  private readonly trunkMat: THREE.MeshStandardMaterial;
  private readonly canopyGeo: THREE.BufferGeometry;
  private readonly canopyMat: THREE.MeshStandardMaterial;
  private readonly midTreeGeo: THREE.BufferGeometry;
  private readonly midTreeMat: THREE.MeshStandardMaterial;
  private readonly boulderGeo: THREE.DodecahedronGeometry;
  private readonly boulderMat: THREE.MeshStandardMaterial;
  private readonly scrubGeo: THREE.ConeGeometry;
  private readonly scrubMat: THREE.MeshStandardMaterial;
  private readonly containerGeo: THREE.BoxGeometry;
  private readonly containerMat: THREE.MeshStandardMaterial;
  private readonly midBuildingGeo: THREE.BoxGeometry;
  private readonly midBuildingMat: THREE.MeshStandardMaterial;

  // 1-draw-call ambient rising smoke plumes anchored to contested checkpoints & militia camps
  private readonly smokeGeo: THREE.OctahedronGeometry;
  private readonly smokeMat: THREE.MeshBasicMaterial;
  private ambientSmokeMesh: THREE.InstancedMesh | null = null;
  private readonly smokePuffs: AmbientSmokePuff[] = [];
  private smokeClockSec = 0;

  // Shared heterogeneous static prop library for per-chunk `THREE.BatchedMesh` (1 draw call / chunk)
  private readonly batchedPropGeos: THREE.BufferGeometry[];
  private readonly batchedPropMat: THREE.MeshStandardMaterial;
  private readonly batchedPropTotalVerts: number;
  private readonly batchedPropTotalIndices: number;

  // Horizon proxy disposable resources & occlusion metadata
  private readonly horizonDisposables: Array<{ dispose(): void }> = [];
  private readonly landmarkOccluderAabbs: Array<{
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }> = [];
  private readonly horizonOccludables: Array<{
    obj: THREE.Object3D;
    box: THREE.Box3;
    fobId?: FobCompoundId;
  }> = [];
  private readonly horizonFullScreenTargets: THREE.Object3D[] = [];

  private readonly atmoFogUniforms?: AtmoFogSharedUniforms;
  private readonly pendingQueue: PendingChunkSpec[] = [];
  private readonly desiredMap = new Map<string, { cx: number; cz: number; lod: ChunkLodTier }>();
  private lastCenterCx = -999;
  private lastCenterCz = -999;
  private disposedChunkCount = 0;
  private activeInstanceCount = 0;
  private visibleChunkCount = 0;
  private culledBehindChunkCount = 0;
  private occludedChunkCount = 0;
  private occludedObjectCount = 0;
  private propDensityScale = 1.0;
  private shadowsEnabled = true;

  constructor(
    scene: THREE.Scene,
    isSoftwareGl = false,
    atmoFogUniforms?: AtmoFogSharedUniforms,
  ) {
    this.isSoftwareGl = isSoftwareGl;
    this.atmoFogUniforms = atmoFogUniforms;
    this.archBuilder = new OpenWorldArchitectureBuilder(isSoftwareGl, atmoFogUniforms);
    this.foliageBuilder = new OpenWorldFoliageBuilder(scene, isSoftwareGl, atmoFogUniforms);
    this.rootGroup.name = 'openworld_streaming_root';
    this.chunksGroup.name = 'openworld_chunk_rings';
    this.horizonGroup.name = 'openworld_horizon_proxy';
    this.rootGroup.add(this.horizonGroup);
    this.rootGroup.add(this.chunksGroup);

    // Procedural terrain grain texture & shared PBR terrain materials (strict FrontSide backface culling)
    this.terrainTexture = createProceduralTerrainTexture();
    this.activeTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.terrainTexture,
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.FrontSide,
    });
    this.midTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 2,
    });
    this.hlodTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });

    // Shared bottom-center instanced prop geometries (all solid 3D meshes strictly FrontSide)
    this.trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 3.6, 6);
    this.trunkGeo.translate(0, 1.8, 0);
    this.trunkMat = new THREE.MeshStandardMaterial({
      color: 0x4b382a,
      roughness: 0.94,
      metalness: 0.0,
      side: THREE.FrontSide,
    });

    this.canopyGeo = buildGroundedConiferCanopyGeo();
    this.canopyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.foliageBuilder.applyWindToConiferMaterial(this.canopyGeo, this.canopyMat);

    this.midTreeGeo = buildMidConiferGeo();
    this.midTreeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.FrontSide,
    });

    this.boulderGeo = new THREE.DodecahedronGeometry(1.0, 0);
    this.boulderGeo.translate(0, 0.55, 0);
    this.boulderMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.04,
      side: THREE.FrontSide,
    });

    this.scrubGeo = new THREE.ConeGeometry(0.75, 1.4, 5);
    this.scrubGeo.translate(0, 0.7, 0);
    this.scrubMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.FrontSide,
    });

    this.containerGeo = new THREE.BoxGeometry(2.5, 2.6, 6.1);
    this.containerGeo.translate(0, 1.3, 0);
    this.containerMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.38,
      side: THREE.FrontSide,
    });

    this.midBuildingGeo = new THREE.BoxGeometry(10, 6.5, 14);
    this.midBuildingGeo.translate(0, 3.25, 0);
    this.midBuildingMat = new THREE.MeshStandardMaterial({
      color: 0x676d74,
      roughness: 0.84,
      metalness: 0.14,
      side: THREE.FrontSide,
    });

    this.smokeGeo = new THREE.OctahedronGeometry(1.0, 1);
    this.smokeMat = new THREE.MeshBasicMaterial({
      color: 0xb0b8be,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    // 5 heterogeneous composite static props packed into 1 THREE.BatchedMesh per active chunk:
    // 0: Timber supply crate stack, 1: Twin fuel drum pallet, 2: Tiered sandbag emplacement,
    // 3: Field diesel generator skids, 4: Rugged tactical comms/ammo case
    this.batchedPropGeos = [
      buildCompositeBatchedPropGeo([
        { x: 0, y: 0.42, z: 0, sx: 1.25, sy: 0.84, sz: 0.92 },
        { x: 0.12, y: 1.06, z: -0.05, sx: 0.84, sy: 0.44, sz: 0.68 },
      ]),
      buildCompositeBatchedPropGeo([
        { x: 0, y: 0.08, z: 0, sx: 1.35, sy: 0.16, sz: 1.1 },
        { x: -0.32, y: 0.62, z: -0.18, sx: 0.56, sy: 0.92, sz: 0.56 },
        { x: 0.34, y: 0.62, z: 0.16, sx: 0.56, sy: 0.92, sz: 0.56 },
      ]),
      buildCompositeBatchedPropGeo([
        { x: 0, y: 0.22, z: 0, sx: 2.3, sy: 0.44, sz: 0.68 },
        { x: 0, y: 0.62, z: 0.04, sx: 1.95, sy: 0.36, sz: 0.52 },
        { x: 0, y: 0.94, z: 0.06, sx: 1.45, sy: 0.28, sz: 0.4 },
      ]),
      buildCompositeBatchedPropGeo([
        { x: 0, y: 0.12, z: 0, sx: 1.5, sy: 0.24, sz: 0.86 },
        { x: -0.08, y: 0.68, z: 0, sx: 1.22, sy: 0.88, sz: 0.72 },
        { x: 0.56, y: 0.96, z: 0.24, sx: 0.16, sy: 0.62, sz: 0.16 },
      ]),
      buildCompositeBatchedPropGeo([
        { x: 0, y: 0.28, z: 0, sx: 0.96, sy: 0.56, sz: 0.54 },
        { x: 0, y: 0.58, z: 0, sx: 1.02, sy: 0.08, sz: 0.58 },
      ]),
    ];
    let bVerts = 0;
    let bIndices = 0;
    for (const g of this.batchedPropGeos) {
      bVerts += g.attributes.position.count;
      bIndices += g.index ? g.index.count : 0;
    }
    this.batchedPropTotalVerts = bVerts;
    this.batchedPropTotalIndices = bIndices;
    this.batchedPropMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.22,
      side: THREE.FrontSide,
    });

    if (this.atmoFogUniforms) {
      applyAtmosphericHeightFog(this.activeTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.midTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.hlodTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.trunkMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.canopyMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.midTreeMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.boulderMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.scrubMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.containerMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.midBuildingMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.batchedPropMat, this.atmoFogUniforms);
    }

    this.buildHorizonProxyLayer();
    scene.add(this.rootGroup);
  }

  /**
   * Persistent 4km+ Horizon Proxy Layer:
   * - Full 4,096m × 4,096m low-poly HLOD terrain skirt (-2.2m offset under active chunks to avoid Z-fighting)
   * - Coastal sea plane & Alpine Dam Reservoir surface
   * - Composite 3–12 part major vertical landmarks visible across the entire theater
   */
  private buildHorizonProxyLayer(): void {
    // 1. Full 4km HLOD terrain silhouette
    const hlodGeo = new THREE.PlaneGeometry(WORLD_SIZE_M + 512, WORLD_SIZE_M + 512, HLOD_TERRAIN_SEGS, HLOD_TERRAIN_SEGS);
    hlodGeo.rotateX(-Math.PI * 0.5);
    const pos = hlodGeo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i);
      const wz = pos.getZ(i);
      sampleOpenWorldTerrain(wx, wz, _sample);
      pos.setY(i, _sample.height - 3.8);
      colors[i * 3] = _sample.r;
      colors[i * 3 + 1] = _sample.g;
      colors[i * 3 + 2] = _sample.b;
    }
    hlodGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    hlodGeo.computeVertexNormals();
    hlodGeo.computeBoundingSphere();

    const hlodMesh = new THREE.Mesh(hlodGeo, this.hlodTerrainMat);
    hlodMesh.receiveShadow = false;
    hlodMesh.castShadow = false;
    hlodMesh.layers.enable(MACRO_OCCLUDER_LAYER);
    this.horizonGroup.add(hlodMesh);
    this.horizonDisposables.push(hlodGeo);

    // 2. Coastal Sea & Estuary Water Sheet
    const seaGeo = new THREE.PlaneGeometry(WORLD_SIZE_M + 1400, 1800, 1, 1);
    seaGeo.rotateX(-Math.PI * 0.5);
    const seaMat = new THREE.MeshStandardMaterial({
      color: 0x16384c,
      roughness: 0.24,
      metalness: 0.35,
      side: THREE.FrontSide,
    });
    const seaMesh = new THREE.Mesh(seaGeo, seaMat);
    seaMesh.position.set(0, SEA_LEVEL_M, 1560);
    this.horizonGroup.add(seaMesh);
    this.horizonFullScreenTargets.push(seaMesh);
    this.horizonDisposables.push(seaGeo, seaMat);

    // 3. Alpine Hydroelectric Reservoir Water Surface (north of Dam)
    const resGeo = new THREE.CircleGeometry(330, 28);
    resGeo.rotateX(-Math.PI * 0.5);
    const resMat = new THREE.MeshStandardMaterial({
      color: 0x1a465c,
      roughness: 0.22,
      metalness: 0.38,
      side: THREE.FrontSide,
    });
    const resMesh = new THREE.Mesh(resGeo, resMat);
    resMesh.scale.set(1.05, 1, 0.62);
    resMesh.position.set(180, RESERVOIR_LEVEL_M, -1620);
    this.horizonGroup.add(resMesh);
    this.horizonFullScreenTargets.push(resMesh);
    this.horizonDisposables.push(resGeo, resMat);

    // 4. Composite 3–12 Part Vertical Landmarks (visible across 4km for heli flight & optics)
    const concreteMat = new THREE.MeshStandardMaterial({
      color: 0x7d807e,
      roughness: 0.86,
      metalness: 0.05,
      side: THREE.FrontSide,
    });
    const darkConcreteMat = new THREE.MeshStandardMaterial({
      color: 0x4b4f52,
      roughness: 0.88,
      metalness: 0.08,
      side: THREE.FrontSide,
    });
    const craneOrangeMat = new THREE.MeshStandardMaterial({
      color: 0xb94d24,
      roughness: 0.52,
      metalness: 0.48,
      side: THREE.FrontSide,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x5c6670,
      roughness: 0.42,
      metalness: 0.68,
      side: THREE.FrontSide,
    });
    const dishWhiteMat = new THREE.MeshStandardMaterial({
      color: 0xd6dbe0,
      roughness: 0.48,
      metalness: 0.22,
      side: THREE.FrontSide,
    });
    const alphaBeaconMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0c4a6e,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.2,
      side: THREE.FrontSide,
    });
    const bravoBeaconMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0x7c2d12,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.2,
      side: THREE.FrontSide,
    });
    if (this.atmoFogUniforms) {
      applyAtmosphericHeightFog(seaMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(resMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(concreteMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(darkConcreteMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(craneOrangeMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(steelMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(dishWhiteMat, this.atmoFogUniforms);
    }
    this.horizonDisposables.push(
      concreteMat,
      darkConcreteMat,
      craneOrangeMat,
      steelMat,
      dishWhiteMat,
      alphaBeaconMat,
      bravoBeaconMat,
    );

    const registerGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.horizonDisposables.push(g);
      return g;
    };

    for (const lm of OPENWORLD_LANDMARKS) {
      const baseH = evaluateOpenWorldHeight(lm.worldX, lm.worldZ);
      const group = new THREE.Group();
      group.name = lm.id;
      group.position.set(lm.worldX, baseH, lm.worldZ);

      if (lm.kind === 'dam') {
        // Composite Hydroelectric Dam: Main arch wall, 4 buttress piers, powerhouse, intake tower, red aviation beacon
        const wallGeo = registerGeo(new THREE.BoxGeometry(220, 52, 22));
        const wall = new THREE.Mesh(wallGeo, concreteMat);
        wall.position.set(0, 14, -18);
        group.add(wall);

        const crestGeo = registerGeo(new THREE.BoxGeometry(226, 4.5, 16));
        const crest = new THREE.Mesh(crestGeo, darkConcreteMat);
        crest.position.set(0, 41.5, -18);
        group.add(crest);

        const pierGeo = registerGeo(new THREE.BoxGeometry(11, 56, 30));
        for (let i = -2; i <= 2; i++) {
          const pier = new THREE.Mesh(pierGeo, darkConcreteMat);
          pier.position.set(i * 44, 15, -15);
          group.add(pier);
        }

        const powerGeo = registerGeo(new THREE.BoxGeometry(74, 22, 26));
        const powerhouse = new THREE.Mesh(powerGeo, steelMat);
        powerhouse.position.set(-48, 8, 12);
        group.add(powerhouse);

        const mastGeo = registerGeo(new THREE.CylinderGeometry(0.4, 1.1, 24, 6));
        const mast = new THREE.Mesh(mastGeo, steelMat);
        mast.position.set(78, 55, -18);
        group.add(mast);
      } else if (lm.kind === 'port') {
        // Composite Coastal Port Gantry Cranes (x2) + Pier Apron + Warehouse
        const pierGeo = registerGeo(new THREE.BoxGeometry(190, 6, 66));
        const pier = new THREE.Mesh(pierGeo, darkConcreteMat);
        pier.position.set(0, -1.5, 0);
        group.add(pier);

        const legGeo = registerGeo(new THREE.BoxGeometry(2.2, 34, 2.2));
        const boomGeo = registerGeo(new THREE.BoxGeometry(10, 3.2, 54));
        const cabGeo = registerGeo(new THREE.BoxGeometry(5.5, 4.2, 6.5));
        for (const offsetX of [-52, 28]) {
          const crane = new THREE.Group();
          crane.position.set(offsetX, 1.5, 6);
          for (const lx of [-5.5, 5.5]) {
            for (const lz of [-7, 7]) {
              const leg = new THREE.Mesh(legGeo, craneOrangeMat);
              leg.position.set(lx, 17, lz);
              crane.add(leg);
            }
          }
          const boom = new THREE.Mesh(boomGeo, craneOrangeMat);
          boom.position.set(0, 33, 6);
          crane.add(boom);
          const cab = new THREE.Mesh(cabGeo, steelMat);
          cab.position.set(0, 27, 14);
          crane.add(cab);
          group.add(crane);
        }

        const shedGeo = registerGeo(new THREE.BoxGeometry(58, 13, 24));
        const shed = new THREE.Mesh(shedGeo, steelMat);
        shed.position.set(-14, 7.5, -24);
        group.add(shed);
      } else if (lm.kind === 'quarry') {
        // Composite Radar Array & Quarry Processing Tower
        const bunkerGeo = registerGeo(new THREE.BoxGeometry(44, 10, 34));
        const bunker = new THREE.Mesh(bunkerGeo, concreteMat);
        bunker.position.set(0, 5, 0);
        group.add(bunker);

        const pedGeo = registerGeo(new THREE.CylinderGeometry(3.2, 4.4, 14, 8));
        const dishGeo = registerGeo(new THREE.SphereGeometry(10.5, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42));
        for (const ox of [-16, 16]) {
          const ped = new THREE.Mesh(pedGeo, darkConcreteMat);
          ped.position.set(ox, 16, -2);
          group.add(ped);
          const dish = new THREE.Mesh(dishGeo, dishWhiteMat);
          dish.position.set(ox, 24, 1);
          dish.rotation.x = Math.PI * 0.34;
          group.add(dish);
        }

        const towerGeo = registerGeo(new THREE.CylinderGeometry(0.6, 2.2, 46, 6));
        const tower = new THREE.Mesh(towerGeo, steelMat);
        tower.position.set(0, 28, -14);
        group.add(tower);
      } else if (lm.kind === 'railyard') {
        // Composite Timberline Freight Depot + Rail Loading Gantry
        const depotGeo = registerGeo(new THREE.BoxGeometry(52, 11, 20));
        const depot = new THREE.Mesh(depotGeo, darkConcreteMat);
        depot.position.set(0, 5.5, -14);
        group.add(depot);

        const roofGeo = registerGeo(new THREE.BoxGeometry(56, 2.2, 23));
        const roof = new THREE.Mesh(roofGeo, steelMat);
        roof.position.set(0, 12, -14);
        group.add(roof);

        const carGeo = registerGeo(new THREE.BoxGeometry(18, 4.2, 3.6));
        for (let i = -1; i <= 1; i++) {
          const car = new THREE.Mesh(carGeo, craneOrangeMat);
          car.position.set(i * 22, 2.3, 10);
          group.add(car);
        }
      } else if (isFobCompoundId(lm.id)) {
        // PMC Alpha / Bravo FOB: Distant Command radio mast + 4 corner perimeter guard tower silhouettes
        const beaconMat = lm.kind === 'fob_alpha' ? alphaBeaconMat : bravoBeaconMat;
        const termAnchor = getFobTerminalAnchor(lm.id);
        const relTermX = termAnchor.worldX - lm.worldX;
        const relTermZ = termAnchor.worldZ - lm.worldZ;

        const mastShaftGeo = registerGeo(new THREE.BoxGeometry(1.4, 24, 1.4));
        const mastShaft = new THREE.Mesh(mastShaftGeo, steelMat);
        mastShaft.position.set(relTermX, 12, relTermZ);
        group.add(mastShaft);

        const beaconGeo = registerGeo(new THREE.BoxGeometry(1.5, 2.0, 1.5));
        const beacon = new THREE.Mesh(beaconGeo, beaconMat);
        beacon.position.set(relTermX, 24.8, relTermZ);
        group.add(beacon);

        const towerPillarGeo = registerGeo(
          new THREE.BoxGeometry(2.6, FOB_GUARD_TOWER_DECK_HEIGHT_M + 0.6, 2.6),
        );
        const towerRoofGeo = registerGeo(new THREE.BoxGeometry(4.0, 0.5, 4.0));
        const towers = getFobGuardTowerSpecs(lm.id);
        for (const tw of towers) {
          const rx = tw.worldX - lm.worldX;
          const rz = tw.worldZ - lm.worldZ;
          const pillar = new THREE.Mesh(towerPillarGeo, concreteMat);
          pillar.position.set(rx, (FOB_GUARD_TOWER_DECK_HEIGHT_M + 0.6) * 0.5, rz);
          const roof = new THREE.Mesh(towerRoofGeo, darkConcreteMat);
          roof.position.set(rx, FOB_GUARD_TOWER_DECK_HEIGHT_M + 3.1, rz);
          group.add(pillar, roof);
        }
        this.fobHorizonGroups.set(lm.id, group);
      }

      if (lm.kind === 'dam') {
        this.landmarkOccluderAabbs.push(
          {
            minX: lm.worldX - 110,
            minY: baseH - 12,
            minZ: lm.worldZ - 29,
            maxX: lm.worldX + 110,
            maxY: baseH + 40,
            maxZ: lm.worldZ - 7,
          },
          {
            minX: lm.worldX - 85,
            minY: baseH - 3,
            minZ: lm.worldZ - 1,
            maxX: lm.worldX - 11,
            maxY: baseH + 19,
            maxZ: lm.worldZ + 25,
          },
        );
      } else if (lm.kind === 'port') {
        this.landmarkOccluderAabbs.push({
          minX: lm.worldX - 43,
          minY: baseH + 1,
          minZ: lm.worldZ - 36,
          maxX: lm.worldX + 15,
          maxY: baseH + 14,
          maxZ: lm.worldZ - 12,
        });
      } else if (lm.kind === 'quarry') {
        this.landmarkOccluderAabbs.push({
          minX: lm.worldX - 22,
          minY: baseH,
          minZ: lm.worldZ - 17,
          maxX: lm.worldX + 22,
          maxY: baseH + 10,
          maxZ: lm.worldZ + 17,
        });
      } else if (lm.kind === 'railyard') {
        this.landmarkOccluderAabbs.push({
          minX: lm.worldX - 26,
          minY: baseH,
          minZ: lm.worldZ - 24,
          maxX: lm.worldX + 26,
          maxY: baseH + 11,
          maxZ: lm.worldZ - 4,
        });
      }

      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material !== alphaBeaconMat && obj.material !== bravoBeaconMat) {
          obj.layers.enable(MACRO_OCCLUDER_LAYER);
        }
      });
      this.horizonGroup.add(group);
      group.updateMatrixWorld(true);
      const lmBox = new THREE.Box3().setFromObject(group);
      if (!lmBox.isEmpty()) {
        this.horizonOccludables.push({
          obj: group,
          box: lmBox,
          fobId: isFobCompoundId(lm.id) ? lm.id : undefined,
        });
      }
    }

    // 5. Persistent Steel-Truss River Bridges + Regional Water Towers & Guyed Radio Masts
    this.archBuilder.populateHorizonCivilization(this.horizonGroup, this.horizonDisposables);

    // 6. 4km Horizon Forest Canopy Belt (1 InstancedMesh draw call painting far valleys & alpine ridges)
    const hRand = mulberry32(414199);
    const horizonTrees: Array<{ wx: number; wy: number; wz: number; scale: number; yaw: number; tint: number }> = [];
    const maxHorizonTrees = 960;
    for (let i = 0; i < 2200 && horizonTrees.length < maxHorizonTrees; i++) {
      const wx = (hRand() - 0.5) * (WORLD_SIZE_M - 160);
      const wz = (hRand() - 0.5) * (WORLD_SIZE_M - 160);
      sampleOpenWorldTerrain(wx, wz, _sample);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.isQuarryPit || _sample.slope > 0.44) {
        continue;
      }
      if (isOnCivilizationClearance(wx, wz, 8.0)) continue;
      let nearLm = false;
      for (let k = 0; k < OPENWORLD_LANDMARKS.length; k++) {
        const lm = OPENWORLD_LANDMARKS[k];
        if (Math.hypot(wx - lm.worldX, wz - lm.worldZ) < lm.padRadiusM * 0.72) {
          nearLm = true;
          break;
        }
      }
      if (nearLm) continue;

      let prob = 0;
      if (_sample.biome === 'temperate_conifer_valley') prob = 0.76;
      else if (_sample.biome === 'alpine_ridge_dam' && _sample.height < 328) prob = 0.42;
      else if (_sample.biome === 'highland_steppe_quarry') prob = 0.16;
      else if (_sample.biome === 'coastal_port_marsh' && _sample.height > 5.0) prob = 0.12;
      if (hRand() > prob) continue;

      horizonTrees.push({
        wx,
        wy: _sample.height - 1.2,
        wz,
        scale: 1.15 + hRand() * 0.62,
        yaw: hRand() * Math.PI * 2,
        tint: hRand(),
      });
    }
    if (horizonTrees.length > 0) {
      const horizonForest = new THREE.InstancedMesh(this.midTreeGeo, this.midTreeMat, horizonTrees.length);
      horizonForest.name = 'horizon_forest_canopy';
      horizonForest.castShadow = false;
      horizonForest.receiveShadow = false;
      horizonForest.layers.enable(MACRO_OCCLUDER_LAYER);
      for (let i = 0; i < horizonTrees.length; i++) {
        const t = horizonTrees[i];
        _dummy.position.set(t.wx, t.wy, t.wz);
        _dummy.rotation.set(0, t.yaw, 0);
        _dummy.scale.set(t.scale, t.scale * (0.9 + t.tint * 0.25), t.scale);
        _dummy.updateMatrix();
        horizonForest.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.1 + t.tint * 0.06, 0.21 + t.tint * 0.1, 0.12 + t.tint * 0.05);
        horizonForest.setColorAt(i, _color);
      }
      horizonForest.instanceMatrix.needsUpdate = true;
      if (horizonForest.instanceColor) horizonForest.instanceColor.needsUpdate = true;
      horizonForest.computeBoundingSphere();
      this.horizonGroup.add(horizonForest);
      this.horizonFullScreenTargets.push(horizonForest);
      this.horizonDisposables.push(horizonForest);
    }

    // 7. Ambient Rising Smoke Plumes at Contested Roadblocks & Militia Field Camps (1 InstancedMesh draw call)
    const sites = getBakedOpenWorldSites();
    this.smokePuffs.length = 0;
    const smokeSites = sites.filter((s) => s.kind === 'checkpoint' || s.kind === 'camp_outpost');
    const puffsPerSite = 6;
    for (let sIdx = 0; sIdx < smokeSites.length; sIdx++) {
      const s = smokeSites[sIdx];
      const baseX = s.x + Math.cos(s.yaw) * 4.2;
      const baseZ = s.z - Math.sin(s.yaw) * 4.2;
      const baseY = s.groundY + 1.1;
      for (let p = 0; p < puffsPerSite; p++) {
        this.smokePuffs.push({
          baseX,
          baseY,
          baseZ,
          phase: (p / puffsPerSite) + (sIdx * 0.13) % 1,
          riseSpeed: 0.14 + (p % 3) * 0.025,
          maxHeightM: 22 + (sIdx % 3) * 5,
          driftAngle: 0.55 + (sIdx % 4) * 0.18,
          baseScale: 0.75 + (p % 3) * 0.22,
        });
      }
    }
    if (this.smokePuffs.length > 0) {
      const smokeMesh = new THREE.InstancedMesh(this.smokeGeo, this.smokeMat, this.smokePuffs.length);
      smokeMesh.name = 'openworld_ambient_smoke';
      smokeMesh.castShadow = false;
      smokeMesh.receiveShadow = false;
      smokeMesh.frustumCulled = false;
      this.ambientSmokeMesh = smokeMesh;
      this.horizonGroup.add(smokeMesh);
      this.horizonFullScreenTargets.push(smokeMesh);
      this.updateAmbientSmoke(0.016);
    }
  }

  public applyQualityProfile(profile: GraphicsQualityProfile, rebuildExisting = false): void {
    const prevShadows = this.shadowsEnabled;
    const prevDensity = this.propDensityScale;
    this.propDensityScale = THREE.MathUtils.clamp(profile.foliageDensity, 0.25, 1.45);
    this.shadowsEnabled = !this.isSoftwareGl && profile.castShadows;
    if (this.terrainTexture) {
      this.terrainTexture.anisotropy = Math.max(1, profile.anisotropyCap);
      this.terrainTexture.needsUpdate = true;
    }
    this.archBuilder.applyQualityProfile(profile);
    this.foliageBuilder.applyQualityProfile(profile);

    if (
      rebuildExisting &&
      (prevShadows !== this.shadowsEnabled || Math.abs(prevDensity - this.propDensityScale) > 0.05) &&
      this.lastCenterCx !== -999
    ) {
      // Mark all loaded chunks for incremental re-streaming without freezing
      const cx = this.lastCenterCx;
      const cz = this.lastCenterCz;
      for (const [key, rec] of this.loadedChunks) {
        if (rec.cx === cx && rec.cz === cz) continue;
        this.disposeChunkRecord(rec);
        this.loadedChunks.delete(key);
      }
      this.lastCenterCx = -999;
      this.lastCenterCz = -999;
      this.update(chunkCoordToWorldCenter(cx), chunkCoordToWorldCenter(cz), false);
    }
  }

  public prewarmShaders(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ): void {
    if (this.isSoftwareGl) return;
    const prewarmGroup = new THREE.Group();
    prewarmGroup.name = 'openworld_shader_prewarm';
    const boxGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const vertCount = boxGeo.attributes.position.count;
    const colors = new Float32Array(vertCount * 3).fill(1);
    const sway = new Float32Array(vertCount).fill(0.5);
    boxGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    boxGeo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));

    const mats: THREE.Material[] = [
      this.activeTerrainMat,
      this.midTerrainMat,
      this.trunkMat,
      this.canopyMat,
      this.midTreeMat,
      this.boulderMat,
      this.scrubMat,
      this.containerMat,
      this.midBuildingMat,
      this.batchedPropMat,
      ...this.archBuilder.getSharedMaterials(),
      ...this.foliageBuilder.getSharedMaterials(),
    ];

    const tempMeshes: THREE.InstancedMesh[] = [];
    const identity = new THREE.Matrix4().makeTranslation(0, -1200, 0);
    for (let i = 0; i < mats.length; i++) {
      const inst = new THREE.InstancedMesh(boxGeo, mats[i], 1);
      inst.setMatrixAt(0, identity);
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      prewarmGroup.add(inst);
      tempMeshes.push(inst);
    }

    scene.add(prewarmGroup);
    try {
      renderer.compile(scene, camera);
    } catch {
      // Non-fatal fallback
    }
    scene.remove(prewarmGroup);
    for (let i = 0; i < tempMeshes.length; i++) {
      tempMeshes[i].dispose();
    }
    boxGeo.dispose();
  }

  private rebuildActiveArrays(): void {
    this.activeChunks.length = 0;
    this.activeTreeRoosts.length = 0;
    this.activeLogAnchors.length = 0;
    this.activeRockAnchors.length = 0;
    let instances = 0;
    for (const rec of this.loadedChunks.values()) {
      instances += rec.instanceCount;
      if (rec.lod === 'active') {
        this.activeChunks.push(rec);
        for (let i = 0; i < rec.treeRoosts.length; i++) this.activeTreeRoosts.push(rec.treeRoosts[i]);
        for (let i = 0; i < rec.logAnchors.length; i++) this.activeLogAnchors.push(rec.logAnchors[i]);
        for (let i = 0; i < rec.rockAnchors.length; i++) this.activeRockAnchors.push(rec.rockAnchors[i]);
      }
    }
    this.activeInstanceCount = instances;

    // Hide coarse FOB horizon proxy blocks whenever the detailed active FOB chunk is loaded
    // so distant placeholder tower pillars never poke through the real 4-post guard towers
    for (const [fobId, proxyGroup] of this.fobHorizonGroups) {
      const spec = getFobCompoundSpec(fobId);
      const fobKey = chunkKey(worldToChunkCoord(spec.worldX), worldToChunkCoord(spec.worldZ));
      const rec = this.loadedChunks.get(fobKey);
      proxyGroup.visible = !(rec && rec.lod === 'active');
    }
  }

  /**
   * Streams chunks around `(worldX, worldZ)` into:
   * - `3 × 3` Active Ring (Chebyshev distance `<= 1`)
   * - `5 × 5` Outer Mid-Range Shell (Chebyshev distance `=== 2`)
   * Builds the immediate center chunk synchronously so terrain collision is always valid,
   * then builds remaining missing ring chunks via a prioritized time-budgeted queue
   * (`synchronous = true` drains immediately during boot or landmark teleport).
   */
  public update(worldX: number, worldZ: number, synchronous = true): boolean {
    const centerCx = worldToChunkCoord(worldX);
    const centerCz = worldToChunkCoord(worldZ);
    if (centerCx === this.lastCenterCx && centerCz === this.lastCenterCz) {
      if (synchronous && this.pendingQueue.length > 0) {
        return this.flushStreamQueue(Number.POSITIVE_INFINITY);
      }
      return false;
    }

    this.lastCenterCx = centerCx;
    this.lastCenterCz = centerCz;

    // 1. Identify desired chunks in the 5 x 5 neighborhood
    this.desiredMap.clear();
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cx = centerCx + dx;
        const cz = centerCz + dz;
        if (!isValidChunkCoord(cx, cz)) continue;
        const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
        const lod: ChunkLodTier = chebyshev <= 1 ? 'active' : 'mid';
        this.desiredMap.set(chunkKey(cx, cz), { cx, cz, lod });
      }
    }

    // 2. Dispose chunks outside the 5 x 5 window OR requiring LOD transition
    for (const [key, rec] of this.loadedChunks) {
      const want = this.desiredMap.get(key);
      if (!want || want.lod !== rec.lod) {
        this.disposeChunkRecord(rec);
        this.loadedChunks.delete(key);
      }
    }

    // 3. Build center chunk immediately for guaranteed physics ground & queue remaining missing chunks
    const centerKey = chunkKey(centerCx, centerCz);
    const centerWant = this.desiredMap.get(centerKey);
    if (centerWant && !this.loadedChunks.has(centerKey)) {
      const built = this.buildChunkRecord(centerWant.cx, centerWant.cz, centerWant.lod);
      this.loadedChunks.set(centerKey, built);
      this.chunksGroup.add(built.group);
    }

    this.pendingQueue.length = 0;
    for (const [key, spec] of this.desiredMap) {
      if (this.loadedChunks.has(key)) continue;
      const dx = spec.cx - centerCx;
      const dz = spec.cz - centerCz;
      const cheb = Math.max(Math.abs(dx), Math.abs(dz));
      const priority = cheb * 100 + dx * dx + dz * dz;
      this.pendingQueue.push({ key, cx: spec.cx, cz: spec.cz, lod: spec.lod, priority });
    }
    this.pendingQueue.sort((a, b) => a.priority - b.priority);

    if (synchronous) {
      this.flushStreamQueue(Number.POSITIVE_INFINITY);
    } else {
      this.flushStreamQueue(3.5);
    }

    this.rebuildActiveArrays();
    return true;
  }

  /**
   * Builds queued outer chunks within a strict millisecond budget per frame so turning inward
   * or crossing chunk boundaries never triggers multi-frame CPU hitches.
   */
  public flushStreamQueue(budgetMs = 3.5): boolean {
    if (this.pendingQueue.length === 0) return false;
    const startMs = typeof performance !== 'undefined' ? performance.now() : 0;
    let builtAny = false;

    while (this.pendingQueue.length > 0) {
      const spec = this.pendingQueue.shift()!;
      const want = this.desiredMap.get(spec.key);
      if (!want || want.lod !== spec.lod || this.loadedChunks.has(spec.key)) {
        continue;
      }
      const built = this.buildChunkRecord(spec.cx, spec.cz, spec.lod);
      this.loadedChunks.set(spec.key, built);
      this.chunksGroup.add(built.group);
      builtAny = true;

      if (
        Number.isFinite(budgetMs) &&
        typeof performance !== 'undefined' &&
        performance.now() - startMs >= budgetMs
      ) {
        break;
      }
    }

    if (builtAny) {
      this.rebuildActiveArrays();
    }
    return builtAny;
  }

  private buildChunkRecord(cx: number, cz: number, lod: ChunkLodTier): StreamedChunkRecord {
    const key = chunkKey(cx, cz);
    const group = new THREE.Group();
    group.name = `chunk_${cx}_${cz}_${lod}`;
    const centerX = chunkCoordToWorldCenter(cx);
    const centerZ = chunkCoordToWorldCenter(cz);
    group.position.set(centerX, 0, centerZ);

    const segs = lod === 'active' ? ACTIVE_TERRAIN_SEGS : MID_TERRAIN_SEGS;
    let collider: ActiveHeightfieldCollider | null = null;
    let heightsBuf: Float32Array | undefined;
    if (lod === 'active') {
      heightsBuf = new Float32Array((segs + 1) * (segs + 1));
      collider = {
        cx,
        cz,
        minX: centerX - CHUNK_SIZE_M * 0.5,
        minZ: centerZ - CHUNK_SIZE_M * 0.5,
        segs,
        stepM: CHUNK_SIZE_M / segs,
        heights: heightsBuf,
      };
    }

    const terrainGeo = createTerrainChunkGeometry(cx, cz, segs, heightsBuf);
    terrainGeo.computeBoundingBox();
    const tbb = terrainGeo.boundingBox;
    const minY = tbb ? tbb.min.y - 2.0 : -10;
    const maxY = tbb ? tbb.max.y + 34.0 : 120;
    const halfChunk = CHUNK_SIZE_M * 0.5;
    const bounds = new THREE.Box3(
      new THREE.Vector3(centerX - halfChunk, minY, centerZ - halfChunk),
      new THREE.Vector3(centerX + halfChunk, maxY, centerZ + halfChunk),
    );

    const terrainMesh = new THREE.Mesh(
      terrainGeo,
      lod === 'active' ? this.activeTerrainMat : this.midTerrainMat,
    );
    terrainMesh.receiveShadow = this.shadowsEnabled && lod === 'active';
    terrainMesh.castShadow = false;
    terrainMesh.layers.enable(MACRO_OCCLUDER_LAYER);
    group.add(terrainMesh);

    const ownedGeometries: THREE.BufferGeometry[] = [terrainGeo];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    const batchedMeshes: THREE.BatchedMesh[] = [];
    const microMeshes: THREE.Object3D[] = [];
    const shadowCasterMeshes: THREE.Object3D[] = [];
    const solidObbs: SolidObb[] = [];
    const occluderObbs: SolidObb[] = [];
    const occludableBatches: Array<{ obj: THREE.Object3D; worldBox: THREE.Box3; isMicro: boolean }> = [];
    const walkDecks: WalkDeck[] = [];
    const indoorVolumes: IndoorVolume[] = [];
    const treeRoosts: FoliageAnchorPoint[] = [];
    let logAnchors: FoliageAnchorPoint[] = [];
    let rockAnchors: FoliageAnchorPoint[] = [];
    let instanceCount = 0;

    if (lod === 'active') {
      const archRes = this.archBuilder.populateActiveChunk(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        ownedGeometries,
        instancedMeshes,
        solidObbs,
        walkDecks,
        indoorVolumes,
        shadowCasterMeshes,
      );
      instanceCount += archRes.instanceCount;
      const fastSampleScratch = { height: 0, slope: 0 };
      const fastHeightSlope = collider
        ? (wx: number, wz: number, out: { height: number; slope: number }) =>
            sampleColliderHeightAndSlope(collider, wx, wz, out)
        : undefined;
      instanceCount += this.populateActiveChunkProps(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        instancedMeshes,
        batchedMeshes,
        microMeshes,
        shadowCasterMeshes,
        occludableBatches,
        treeRoosts,
        collider,
        fastSampleScratch,
      );
      const foliageRes = this.foliageBuilder.populateActiveChunkFoliage(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        instancedMeshes,
        fastHeightSlope,
        microMeshes,
      );
      instanceCount += foliageRes.instanceCount;
      logAnchors = foliageRes.logAnchors;
      rockAnchors = foliageRes.rockAnchors;

      for (let i = 0; i < solidObbs.length; i++) {
        if (isEligibleOccluderObb(solidObbs[i])) {
          occluderObbs.push(solidObbs[i]);
        }
      }
    } else {
      instanceCount = this.archBuilder.populateMidChunk(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        ownedGeometries,
        instancedMeshes,
      );
      instanceCount += this.populateMidChunkTrees(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        instancedMeshes,
      );
    }

    return {
      key,
      cx,
      cz,
      centerX,
      centerZ,
      lod,
      group,
      bounds,
      terrainGeo,
      ownedGeometries,
      instancedMeshes,
      batchedMeshes,
      microMeshes,
      shadowCasterMeshes,
      solidObbs,
      occluderObbs,
      occludableBatches,
      walkDecks,
      indoorVolumes,
      treeRoosts,
      logAnchors,
      rockAnchors,
      collider,
      instanceCount,
    };
  }

  /**
   * Populates a single 1-draw-call `InstancedMesh` of low-poly 2-tier conifer silhouettes
   * across each `5 × 5` mid-range chunk so mid-distance valleys and hillsides stay richly forested.
   */
  private populateMidChunkTrees(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    outMeshes: THREE.InstancedMesh[],
  ): number {
    const rand = mulberry32(chunkHash(cx, cz, 73));
    const placements: Array<{ lx: number; y: number; lz: number; scale: number; yaw: number; tint: number }> = [];
    const attempts = Math.round(78 * this.propDensityScale);

    for (let i = 0; i < attempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      const h = evaluateOpenWorldHeight(wx, wz);
      sampleOpenWorldTerrainFromHeight(wx, wz, h, 0.14, _sample);

      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.isQuarryPit) continue;
      if (isOnCivilizationClearance(wx, wz, 5.2)) continue;

      let prob = 0;
      if (_sample.biome === 'temperate_conifer_valley') prob = 0.88;
      else if (_sample.biome === 'alpine_ridge_dam' && _sample.height < 332) prob = 0.44;
      else if (_sample.biome === 'highland_steppe_quarry') prob = 0.22;
      else if (_sample.biome === 'coastal_port_marsh' && _sample.height > 4.8) prob = 0.16;

      if (rand() <= prob) {
        placements.push({
          lx,
          y: h - 0.25,
          lz,
          scale: 0.92 + rand() * 0.42,
          yaw: rand() * Math.PI * 2,
          tint: rand(),
        });
      }
    }

    if (placements.length === 0) return 0;
    const mesh = new THREE.InstancedMesh(this.midTreeGeo, this.midTreeMat, placements.length);
    mesh.name = `mid_conifers_${cx}_${cz}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.enable(MACRO_OCCLUDER_LAYER);

    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      _dummy.position.set(p.lx, p.y, p.lz);
      _dummy.rotation.set(0, p.yaw, 0);
      _dummy.scale.set(p.scale, p.scale * (0.92 + p.tint * 0.22), p.scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
      _color.setRGB(0.11 + p.tint * 0.07, 0.22 + p.tint * 0.11, 0.12 + p.tint * 0.06);
      mesh.setColorAt(i, _color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    outMeshes.push(mesh);
    return placements.length;
  }

  private populateActiveChunkProps(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    outMeshes: THREE.InstancedMesh[],
    outBatchedMeshes: THREE.BatchedMesh[],
    outMicroMeshes: THREE.Object3D[],
    outShadowCasters: THREE.Object3D[],
    outOccludableBatches: Array<{ obj: THREE.Object3D; worldBox: THREE.Box3; isMicro: boolean }>,
    outTreeRoosts: FoliageAnchorPoint[],
    collider: ActiveHeightfieldCollider | null,
    hsScratch: { height: number; slope: number },
  ): number {
    const rand = mulberry32(chunkHash(cx, cz, 41));

    const sampleFast = (wx: number, wz: number): void => {
      if (collider) {
        sampleColliderHeightAndSlope(collider, wx, wz, hsScratch);
        sampleOpenWorldTerrainFromHeight(wx, wz, hsScratch.height, hsScratch.slope, _sample);
      } else {
        const h = evaluateOpenWorldHeight(wx, wz);
        sampleOpenWorldTerrainFromHeight(wx, wz, h, 0.1, _sample);
      }
    };

    // Pre-collect front-packed placements by category
    const treePlacements: Array<{ lx: number; y: number; lz: number; scale: number; yaw: number; tint: number }> = [];
    const boulderPlacements: Array<{ lx: number; y: number; lz: number; sx: number; sy: number; sz: number; yaw: number; tint: number }> = [];
    const scrubPlacements: Array<{ lx: number; y: number; lz: number; scale: number; yaw: number; r: number; g: number; b: number }> = [];
    const containerPlacements: Array<{ lx: number; y: number; lz: number; yaw: number; tint: number }> = [];

    // Check proximity to major landmarks so we keep helipads/dam faces unobstructed
    const isNearLandmark = (wx: number, wz: number): boolean => {
      for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
        const lm = OPENWORLD_LANDMARKS[i];
        if (Math.hypot(wx - lm.worldX, wz - lm.worldZ) < lm.padRadiusM * 0.52) return true;
      }
      return false;
    };

    // 1. Clustered Conifer Groves & Alpine Timberline Forests (~2.5x denser with 0 extra draw calls)
    const halfBound = CHUNK_SIZE_M * 0.5 - 4;
    const treeAttempts = Math.round(92 * this.propDensityScale);
    for (let i = 0; i < treeAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleFast(wx, wz);

      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.isQuarryPit || _sample.slope > 0.44) continue;
      if (isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 3.8)) continue;

      let spawnChance = 0.0;
      let clusterCount = 0;
      if (_sample.biome === 'temperate_conifer_valley') {
        spawnChance = 0.92;
        clusterCount = 2;
      } else if (_sample.biome === 'highland_steppe_quarry') {
        spawnChance = 0.28;
        clusterCount = 1;
      } else if (_sample.biome === 'alpine_ridge_dam' && _sample.height < 332) {
        spawnChance = 0.48;
        clusterCount = 1;
      } else if (_sample.biome === 'coastal_port_marsh' && _sample.height > 4.5) {
        spawnChance = 0.22;
        clusterCount = 1;
      }

      if (rand() <= spawnChance) {
        const baseBiome = _sample.biome;
        treePlacements.push({
          lx,
          y: _sample.height - 0.15,
          lz,
          scale: 0.85 + rand() * 0.38,
          yaw: rand() * Math.PI * 2,
          tint: rand(),
        });
        if (baseBiome === 'temperate_conifer_valley' && outTreeRoosts.length < 18) {
          outTreeRoosts.push({ x: wx, y: _sample.height, z: wz });
        }

        // Organic satellite grove trees around primary pine for dense woodland silhouettes
        for (let sat = 0; sat < clusterCount; sat++) {
          const satA = rand() * Math.PI * 2;
          const satR = 4.6 + rand() * 6.4;
          const slx = lx + Math.cos(satA) * satR;
          const slz = lz + Math.sin(satA) * satR;
          if (Math.abs(slx) > halfBound || Math.abs(slz) > halfBound) continue;
          const swx = centerX + slx;
          const swz = centerZ + slz;
          sampleFast(swx, swz);
          if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.isQuarryPit || _sample.slope > 0.44) {
            continue;
          }
          if (isNearLandmark(swx, swz) || isOnCivilizationClearance(swx, swz, 3.8)) continue;
          treePlacements.push({
            lx: slx,
            y: _sample.height - 0.15,
            lz: slz,
            scale: 0.72 + rand() * 0.44,
            yaw: rand() * Math.PI * 2,
            tint: rand(),
          });
        }
      }
    }

    // 2. Boulders & Rock Outcrops (Steppe, Quarry, Alpine, Coastal breakwaters)
    const boulderAttempts = Math.round(28 * this.propDensityScale);
    for (let i = 0; i < boulderAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 12);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 12);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleFast(wx, wz);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 3.5)) continue;

      const rockProb =
        _sample.biome === 'alpine_ridge_dam' || _sample.isQuarryPit
          ? 0.72
          : _sample.biome === 'highland_steppe_quarry'
            ? 0.55
            : 0.26;
      if (rand() <= rockProb) {
        const baseS = 0.9 + rand() * 2.1;
        boulderPlacements.push({
          lx,
          y: _sample.height - 0.22,
          lz,
          sx: baseS * (0.85 + rand() * 0.3),
          sy: baseS * (0.62 + rand() * 0.45),
          sz: baseS * (0.85 + rand() * 0.3),
          yaw: rand() * Math.PI * 2,
          tint: rand(),
        });
      }
    }

    // 3. Coastal Marsh Reeds, Steppe Scrub Tufts & Roadside Hedgerow Bushes
    const scrubAttempts = Math.round(74 * this.propDensityScale);
    for (let i = 0; i < scrubAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleFast(wx, wz);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.slope > 0.5 || isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 2.2)) continue;
      if (_sample.biome === 'alpine_ridge_dam' && _sample.height > 340) continue;

      if (rand() <= 0.72) {
        const isMarsh = _sample.biome === 'coastal_port_marsh';
        const isSteppe = _sample.biome === 'highland_steppe_quarry';
        scrubPlacements.push({
          lx,
          y: _sample.height - 0.08,
          lz,
          scale: 0.78 + rand() * 0.62,
          yaw: rand() * Math.PI * 2,
          r: isSteppe ? 0.46 : isMarsh ? 0.34 : 0.22,
          g: isSteppe ? 0.42 : isMarsh ? 0.41 : 0.36,
          b: isSteppe ? 0.24 : isMarsh ? 0.22 : 0.17,
        });
      }
    }

    // 4. Tactical Industrial Shipping Containers / Field Barricades (near Port & Quarry, never blocking roads or buildings)
    const containerAttempts = 12;
    for (let i = 0; i < containerAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 24);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 24);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleFast(wx, wz);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.slope > 0.16) continue;
      if (isOnCivilizationClearance(wx, wz, 4.5)) continue;
      const industrialZone = _sample.biome === 'coastal_port_marsh' || _sample.isQuarryPit;
      if (!industrialZone || rand() > 0.32) continue;

      containerPlacements.push({
        lx,
        y: _sample.height,
        lz,
        yaw: Math.floor(rand() * 4) * (Math.PI * 0.5),
        tint: rand(),
      });
    }

    let total = 0;

    // Emit front-packed InstancedMesh batches (only if count > 0) + tight world AABBs for occlusion culling
    if (treePlacements.length > 0) {
      const count = treePlacements.length;
      const trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, count);
      const canopies = new THREE.InstancedMesh(this.canopyGeo, this.canopyMat, count);
      trunks.castShadow = false;
      canopies.castShadow = this.shadowsEnabled;
      canopies.receiveShadow = this.shadowsEnabled;
      canopies.layers.enable(MACRO_OCCLUDER_LAYER);

      const treeBox = new THREE.Box3();
      for (let i = 0; i < count; i++) {
        const p = treePlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        const sy = p.scale * (0.92 + p.tint * 0.22);
        _dummy.scale.set(p.scale, sy, p.scale);
        _dummy.updateMatrix();
        trunks.setMatrixAt(i, _dummy.matrix);
        canopies.setMatrixAt(i, _dummy.matrix);

        const wx = centerX + p.lx;
        const wz = centerZ + p.lz;
        const rad = 2.4 * p.scale;
        treeBox.min.x = Math.min(treeBox.min.x, wx - rad);
        treeBox.min.y = Math.min(treeBox.min.y, p.y);
        treeBox.min.z = Math.min(treeBox.min.z, wz - rad);
        treeBox.max.x = Math.max(treeBox.max.x, wx + rad);
        treeBox.max.y = Math.max(treeBox.max.y, p.y + 10.2 * sy);
        treeBox.max.z = Math.max(treeBox.max.z, wz + rad);

        _color.setRGB(0.12 + p.tint * 0.08, 0.24 + p.tint * 0.12, 0.13 + p.tint * 0.06);
        canopies.setColorAt(i, _color);
      }
      trunks.instanceMatrix.needsUpdate = true;
      canopies.instanceMatrix.needsUpdate = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      trunks.computeBoundingSphere();
      canopies.computeBoundingSphere();
      group.add(trunks, canopies);
      outMeshes.push(trunks, canopies);
      outShadowCasters.push(canopies);
      outOccludableBatches.push(
        { obj: trunks, worldBox: treeBox, isMicro: false },
        { obj: canopies, worldBox: treeBox, isMicro: false },
      );
      total += count * 2;
    }

    if (boulderPlacements.length > 0) {
      const count = boulderPlacements.length;
      const rocks = new THREE.InstancedMesh(this.boulderGeo, this.boulderMat, count);
      rocks.castShadow = false;
      rocks.receiveShadow = false;
      const rockBox = new THREE.Box3();
      for (let i = 0; i < count; i++) {
        const p = boulderPlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(p.tint * 0.4, p.yaw, p.tint * 0.3);
        _dummy.scale.set(p.sx, p.sy, p.sz);
        _dummy.updateMatrix();
        rocks.setMatrixAt(i, _dummy.matrix);
        const shade = 0.34 + p.tint * 0.18;
        _color.setRGB(shade, shade * 0.99, shade * 0.95);
        rocks.setColorAt(i, _color);

        const wx = centerX + p.lx;
        const wz = centerZ + p.lz;
        const rad = Math.max(p.sx, p.sz) * 1.15;
        rockBox.min.x = Math.min(rockBox.min.x, wx - rad);
        rockBox.min.y = Math.min(rockBox.min.y, p.y - 0.5);
        rockBox.min.z = Math.min(rockBox.min.z, wz - rad);
        rockBox.max.x = Math.max(rockBox.max.x, wx + rad);
        rockBox.max.y = Math.max(rockBox.max.y, p.y + p.sy * 1.65);
        rockBox.max.z = Math.max(rockBox.max.z, wz + rad);
      }
      rocks.instanceMatrix.needsUpdate = true;
      if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
      rocks.computeBoundingSphere();
      group.add(rocks);
      outMeshes.push(rocks);
      outOccludableBatches.push({ obj: rocks, worldBox: rockBox, isMicro: false });
      total += count;
    }

    if (scrubPlacements.length > 0) {
      const count = scrubPlacements.length;
      const scrubs = new THREE.InstancedMesh(this.scrubGeo, this.scrubMat, count);
      const scrubBox = new THREE.Box3();
      for (let i = 0; i < count; i++) {
        const p = scrubPlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.scale, p.scale * 0.9, p.scale);
        _dummy.updateMatrix();
        scrubs.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(p.r, p.g, p.b);
        scrubs.setColorAt(i, _color);

        const wx = centerX + p.lx;
        const wz = centerZ + p.lz;
        const rad = p.scale * 0.9;
        scrubBox.min.x = Math.min(scrubBox.min.x, wx - rad);
        scrubBox.min.y = Math.min(scrubBox.min.y, p.y);
        scrubBox.min.z = Math.min(scrubBox.min.z, wz - rad);
        scrubBox.max.x = Math.max(scrubBox.max.x, wx + rad);
        scrubBox.max.y = Math.max(scrubBox.max.y, p.y + p.scale * 1.5);
        scrubBox.max.z = Math.max(scrubBox.max.z, wz + rad);
      }
      scrubs.instanceMatrix.needsUpdate = true;
      if (scrubs.instanceColor) scrubs.instanceColor.needsUpdate = true;
      scrubs.computeBoundingSphere();
      group.add(scrubs);
      outMeshes.push(scrubs);
      outMicroMeshes.push(scrubs);
      outOccludableBatches.push({ obj: scrubs, worldBox: scrubBox, isMicro: true });
      total += count;
    }

    if (containerPlacements.length > 0) {
      const count = containerPlacements.length;
      const containers = new THREE.InstancedMesh(this.containerGeo, this.containerMat, count);
      containers.castShadow = this.shadowsEnabled;
      containers.receiveShadow = this.shadowsEnabled;
      containers.layers.enable(MACRO_OCCLUDER_LAYER);
      const palette = [0x2f536e, 0x823626, 0x3b4d38, 0x5c574d];
      const containerBox = new THREE.Box3();
      for (let i = 0; i < count; i++) {
        const p = containerPlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        containers.setMatrixAt(i, _dummy.matrix);
        _color.setHex(palette[Math.floor(p.tint * palette.length) % palette.length]);
        containers.setColorAt(i, _color);

        const wx = centerX + p.lx;
        const wz = centerZ + p.lz;
        containerBox.min.x = Math.min(containerBox.min.x, wx - 3.3);
        containerBox.min.y = Math.min(containerBox.min.y, p.y);
        containerBox.min.z = Math.min(containerBox.min.z, wz - 3.3);
        containerBox.max.x = Math.max(containerBox.max.x, wx + 3.3);
        containerBox.max.y = Math.max(containerBox.max.y, p.y + 2.8);
        containerBox.max.z = Math.max(containerBox.max.z, wz + 3.3);
      }
      containers.instanceMatrix.needsUpdate = true;
      if (containers.instanceColor) containers.instanceColor.needsUpdate = true;
      containers.computeBoundingSphere();
      group.add(containers);
      outMeshes.push(containers);
      outShadowCasters.push(containers);
      outOccludableBatches.push({ obj: containers, worldBox: containerBox, isMicro: false });
      total += count;
    }

    // 5. Heterogeneous Static Tactical Field Props packed into a single THREE.BatchedMesh (1 draw call)
    const batchedPlacements: Array<{
      lx: number;
      y: number;
      lz: number;
      yaw: number;
      kindIdx: number;
      colorHex: number;
    }> = [];
    const propPalette = [0x6e5a42, 0x3b4d3f, 0x8f846b, 0x4b5563, 0x7c4534];
    const propAttempts = Math.round(32 * this.propDensityScale);
    for (let i = 0; i < propAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 22);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 22);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleFast(wx, wz);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.slope > 0.22) continue;
      if (isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 4.0)) continue;
      if (rand() > 0.58) continue;

      const kindIdx = Math.floor(rand() * this.batchedPropGeos.length) % this.batchedPropGeos.length;
      const colorHex = propPalette[(kindIdx + Math.floor(rand() * 2)) % propPalette.length];
      batchedPlacements.push({
        lx,
        y: _sample.height - 0.04,
        lz,
        yaw: rand() * Math.PI * 2,
        kindIdx,
        colorHex,
      });
    }

    if (batchedPlacements.length > 0) {
      const bm = new THREE.BatchedMesh(
        batchedPlacements.length,
        this.batchedPropTotalVerts,
        this.batchedPropTotalIndices,
        this.batchedPropMat,
      );
      bm.castShadow = this.shadowsEnabled;
      bm.receiveShadow = this.shadowsEnabled;

      const geoIds: number[] = [];
      for (let g = 0; g < this.batchedPropGeos.length; g++) {
        geoIds.push(bm.addGeometry(this.batchedPropGeos[g]));
      }

      const propBox = new THREE.Box3();
      for (let i = 0; i < batchedPlacements.length; i++) {
        const p = batchedPlacements[i];
        const instId = bm.addInstance(geoIds[p.kindIdx]);
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        bm.setMatrixAt(instId, _dummy.matrix);
        _color.setHex(p.colorHex);
        bm.setColorAt(instId, _color);

        const wx = centerX + p.lx;
        const wz = centerZ + p.lz;
        propBox.min.x = Math.min(propBox.min.x, wx - 1.6);
        propBox.min.y = Math.min(propBox.min.y, p.y);
        propBox.min.z = Math.min(propBox.min.z, wz - 1.6);
        propBox.max.x = Math.max(propBox.max.x, wx + 1.6);
        propBox.max.y = Math.max(propBox.max.y, p.y + 1.6);
        propBox.max.z = Math.max(propBox.max.z, wz + 1.6);
      }

      bm.computeBoundingSphere();
      group.add(bm);
      outBatchedMeshes.push(bm);
      outMicroMeshes.push(bm);
      outShadowCasters.push(bm);
      outOccludableBatches.push({ obj: bm, worldBox: propBox, isMicro: true });
      total += batchedPlacements.length;
    }

    return total;
  }

  /**
   * Ensures chunks inside the directional shadow frustum (`<= 115m`) are temporarily enabled
   * before a shadow-map render pass so structures/trees behind the player still cast shadows into view.
   */
  public prepareForShadowPass(playerX: number, playerZ: number): void {
    const halfChunk = CHUNK_SIZE_M * 0.5;
    for (const rec of this.loadedChunks.values()) {
      if (rec.lod !== 'active') continue;
      const dx = Math.max(0, Math.abs(playerX - rec.centerX) - halfChunk);
      const dz = Math.max(0, Math.abs(playerZ - rec.centerZ) - halfChunk);
      const nearDist = Math.hypot(dx, dz);
      if (nearDist <= 115.0) {
        rec.group.visible = true;
        const cast = this.shadowsEnabled;
        for (let i = 0; i < rec.shadowCasterMeshes.length; i++) {
          rec.shadowCasterMeshes[i].castShadow = cast;
        }
      }
    }
  }

  /**
   * Populates the conservative software Hi-Z occlusion buffer with nearby large solid structures
   * (FOB perimeter blast walls, concrete buildings, houses, barns, gas stations, and major vertical
   * landmarks like the Hydroelectric Dam, Port Warehouse, Quarry Bunker, and Railyard Depot).
   */
  public prepareOcclusionCuller(
    culler: OpenWorldOcclusionCuller,
    camera: THREE.PerspectiveCamera,
    camX: number,
    camY: number,
    camZ: number,
  ): void {
    culler.beginFrame(camera, camX, camY, camZ);

    // 1. Submit pre-filtered large solid structural OBBs from nearby active chunks
    for (let i = 0; i < this.activeChunks.length; i++) {
      const rec = this.activeChunks[i];
      const dx = rec.centerX - camX;
      const dz = rec.centerZ - camZ;
      if (dx * dx + dz * dz > 340 * 340) continue;
      const obbs = rec.occluderObbs;
      for (let j = 0; j < obbs.length; j++) {
        culler.addOccluderObb(obbs[j]);
      }
    }

    // 2. Submit massive opaque vertical landmark hulls (Dam wall, Port Warehouse, Quarry Bunker, Railyard Depot)
    for (let i = 0; i < this.landmarkOccluderAabbs.length; i++) {
      const b = this.landmarkOccluderAabbs[i];
      culler.addOccluderAabb(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
    }

    culler.finalizeOccluders();
  }

  /**
   * Zero-GC camera frustum + behind-the-player + conservative software occlusion culling,
   * micro-foliage distance culling (`> 140m`), and shadow-caster radius gating (`<= 105m`).
   * - Always keeps chunks within `22m` 360° safety halo visible so rapid 180° turns never reveal holes.
   * - Expands each chunk's world AABB by `+18m` XZ turn padding for seamless peripheral visibility.
   * - When `keepShadowHalo` is true (on 15Hz shadow-refresh frames), keeps active chunks within `<= 105m`
   *   visible so objects behind the player still cast directional shadows into the player's field of view.
   * - When `culler` is supplied, hides entire chunks, distant prop batches, and horizon landmarks
   *   completely blocked by large solid structures (buildings, FOB blast walls, Dam/Port/Quarry/Railyard).
   */
  public applyCameraCullingAndLods(
    camera: THREE.PerspectiveCamera,
    playerX: number,
    playerZ: number,
    keepShadowHalo = false,
    culler?: OpenWorldOcclusionCuller,
  ): { visibleChunks: number; culledChunks: number; occludedChunks: number; occludedObjects: number } {
    camera.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _cullFrustum.setFromProjectionMatrix(_projScreenMatrix);

    const halfChunk = CHUNK_SIZE_M * 0.5;
    let visibleChunks = 0;
    let culledChunks = 0;
    let occludedChunks = 0;
    let occludedObjects = 0;

    for (const rec of this.loadedChunks.values()) {
      const dx = Math.max(0, Math.abs(playerX - rec.centerX) - halfChunk);
      const dz = Math.max(0, Math.abs(playerZ - rec.centerZ) - halfChunk);
      const nearDist = Math.hypot(dx, dz);

      _paddedBox.min.set(rec.bounds.min.x - 18, rec.bounds.min.y - 4, rec.bounds.min.z - 18);
      _paddedBox.max.set(rec.bounds.max.x + 18, rec.bounds.max.y + 8, rec.bounds.max.z + 18);

      const inSafetyHalo = nearDist <= 22.0;
      const inShadowRange = keepShadowHalo && rec.lod === 'active' && nearDist <= 105.0;
      const inFrustum = inSafetyHalo || inShadowRange || _cullFrustum.intersectsBox(_paddedBox);

      let occluded = false;
      if (inFrustum && culler && !inSafetyHalo && !inShadowRange) {
        occluded = culler.isBoxOccluded(rec.bounds, 22.0);
      }

      const visible = inFrustum && !occluded;
      rec.group.visible = visible;
      if (visible) {
        visibleChunks++;
        if (rec.lod === 'active') {
          const showMicro = nearDist <= 140.0;
          for (let i = 0; i < rec.microMeshes.length; i++) {
            rec.microMeshes[i].visible = showMicro;
          }
          // Per-batch occlusion culling for non-occluder prop/foliage batches inside visible active chunks
          if (culler && !inShadowRange) {
            for (let i = 0; i < rec.occludableBatches.length; i++) {
              const batch = rec.occludableBatches[i];
              if (batch.isMicro && !showMicro) continue;
              const batchOccluded = culler.isBoxOccluded(batch.worldBox, 16.0);
              batch.obj.visible = !batchOccluded;
              if (batchOccluded) occludedObjects++;
            }
          } else {
            for (let i = 0; i < rec.occludableBatches.length; i++) {
              const batch = rec.occludableBatches[i];
              if (!batch.isMicro) batch.obj.visible = true;
            }
          }
          const castShadow = this.shadowsEnabled && nearDist <= 105.0;
          for (let i = 0; i < rec.shadowCasterMeshes.length; i++) {
            rec.shadowCasterMeshes[i].castShadow = castShadow;
          }
        }
      } else if (occluded) {
        occludedChunks++;
        culledChunks++;
      } else {
        culledChunks++;
      }
    }

    // Horizon landmark occlusion culling (Dam, Port, Quarry, Railyard, distant FOB silhouettes)
    for (let i = 0; i < this.horizonOccludables.length; i++) {
      const item = this.horizonOccludables[i];
      let baseVisible = true;
      if (item.fobId) {
        const spec = getFobCompoundSpec(item.fobId);
        const fobKey = chunkKey(worldToChunkCoord(spec.worldX), worldToChunkCoord(spec.worldZ));
        const rec = this.loadedChunks.get(fobKey);
        baseVisible = !(rec && rec.lod === 'active');
      }
      if (!baseVisible) {
        item.obj.visible = false;
        continue;
      }
      const lmInFrustum = _cullFrustum.intersectsBox(item.box);
      const lmOccluded = Boolean(lmInFrustum && culler && culler.isBoxOccluded(item.box, 24.0));
      item.obj.visible = lmInFrustum && !lmOccluded;
      if (lmOccluded) occludedObjects++;
    }

    // Full-screen indoor wall occlusion: when every viewport pixel is blocked closer than 45m,
    // safely hide full-theater horizon forest, distant water sheets, and rising smoke plumes.
    const fullScreenOccluded = Boolean(culler && culler.isScreenFullyOccludedBeyond(camera, 45.0));
    for (let i = 0; i < this.horizonFullScreenTargets.length; i++) {
      this.horizonFullScreenTargets[i].visible = !fullScreenOccluded;
      if (fullScreenOccluded) occludedObjects++;
    }

    this.visibleChunkCount = visibleChunks;
    this.culledBehindChunkCount = culledChunks;
    this.occludedChunkCount = occludedChunks;
    this.occludedObjectCount = occludedObjects;
    return { visibleChunks, culledChunks, occludedChunks, occludedObjects };
  }

  /**
   * Steps 1-draw-call rising ambient smoke plumes above contested checkpoints & militia field camps.
   */
  public updateAmbientSmoke(dt: number): void {
    const mesh = this.ambientSmokeMesh;
    if (!mesh || this.smokePuffs.length === 0) return;
    this.smokeClockSec += Math.min(0.05, Math.max(0, dt));
    const tClock = this.smokeClockSec;

    for (let i = 0; i < this.smokePuffs.length; i++) {
      const p = this.smokePuffs[i];
      const u = (p.phase + tClock * p.riseSpeed) % 1.0;
      const drift = u * 9.5;
      const sx = p.baseX + Math.cos(p.driftAngle) * drift + Math.sin(tClock * 0.7 + i) * 0.65;
      const sy = p.baseY + u * p.maxHeightM;
      const sz = p.baseZ + Math.sin(p.driftAngle) * drift + Math.cos(tClock * 0.6 + i) * 0.65;
      const env = Math.sin(u * Math.PI);
      const scale = Math.max(0.08, p.baseScale * (0.7 + u * 2.4) * (0.35 + env * 0.85));

      _smokeDummy.position.set(sx, sy, sz);
      _smokeDummy.rotation.set(tClock * 0.25 + i, tClock * 0.18 + i * 0.5, 0);
      _smokeDummy.scale.set(scale, scale * 0.78, scale);
      _smokeDummy.updateMatrix();
      mesh.setMatrixAt(i, _smokeDummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Synchronizes night-time emissives across streetlights, gas station canopies,
   * checkpoint floodlights, and aviation beacons (zero dynamic PointLights).
   */
  public setNightFactor(nightFactor: number): void {
    this.archBuilder.setNightFactor(nightFactor);
  }

  public updateFoliageWindAndGrass(
    elapsedSec: number,
    windSpeedMps: number,
    gust01: number,
    wetness01: number,
    playerX: number,
    playerZ: number,
    camForwardX?: number,
    camForwardZ?: number,
  ): void {
    this.foliageBuilder.update(
      elapsedSec,
      windSpeedMps,
      gust01,
      wetness01,
      playerX,
      playerZ,
      (x, z) => this.sampleTerrainHeightOnly(x, z),
      camForwardX,
      camForwardZ,
    );
  }

  public getActiveTreeRoosts(): ReadonlyArray<FoliageAnchorPoint> {
    return this.activeTreeRoosts;
  }

  public getActiveLogAnchors(): ReadonlyArray<FoliageAnchorPoint> {
    return this.activeLogAnchors;
  }

  public getActiveRockAnchors(): ReadonlyArray<FoliageAnchorPoint> {
    return this.activeRockAnchors;
  }

  public getStreetlightEmissiveIntensity(): number {
    return this.archBuilder.getStreetlightEmissiveIntensity();
  }

  /**
   * Samples raw bilinear terrain height (excluding buildings/bridges) from active chunks or exact evaluator.
   */
  public sampleTerrainHeightOnly(worldX: number, worldZ: number): number {
    const cx = worldToChunkCoord(worldX);
    const cz = worldToChunkCoord(worldZ);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (!rec || !rec.collider) {
      return evaluateOpenWorldHeight(worldX, worldZ);
    }

    const col = rec.collider;
    const fx = (worldX - col.minX) / col.stepM;
    const fz = (worldZ - col.minZ) / col.stepM;
    const ix = Math.max(0, Math.min(col.segs - 1, Math.floor(fx)));
    const iz = Math.max(0, Math.min(col.segs - 1, Math.floor(fz)));
    const tx = Math.max(0, Math.min(1, fx - ix));
    const tz = Math.max(0, Math.min(1, fz - iz));

    const stride = col.segs + 1;
    const h00 = col.heights[iz * stride + ix];
    const h10 = col.heights[iz * stride + ix + 1];
    const h01 = col.heights[(iz + 1) * stride + ix];
    const h11 = col.heights[(iz + 1) * stride + ix + 1];

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * tz;
  }

  /**
   * Samples physics ground height from the active `3 × 3` chunk's bilinear heightfield collider,
   * elevated cleanly onto river bridge decks when standing on a bridge span.
   */
  public sampleGroundHeight(worldX: number, worldZ: number): number {
    const terrainH = this.sampleTerrainHeightOnly(worldX, worldZ);
    const bridge = queryBridgeDeckHeight(worldX, worldZ);
    if (bridge.onBridge) {
      return Math.max(terrainH, bridge.deckY);
    }
    return terrainH;
  }

  /**
   * Samples walkable ground height including active enterable building floors, gas forecourts,
   * and steel-truss river bridge decks relative to the operator's current foot height.
   */
  public sampleGroundAndDeckHeight(worldX: number, worldZ: number, referenceY: number): number {
    let bestH = this.sampleGroundHeight(worldX, worldZ);
    const cx = worldToChunkCoord(worldX);
    const cz = worldToChunkCoord(worldZ);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (rec && rec.walkDecks.length > 0) {
      const deck = sampleWalkDeckHeightFromList(rec.walkDecks, worldX, worldZ, referenceY);
      if (deck.found && deck.topY > bestH) {
        bestH = deck.topY;
      }
    }
    return bestH;
  }

  public sampleWalkDeckSurface(
    worldX: number,
    worldZ: number,
    referenceY: number,
  ): BodycamSurfaceMaterial | null {
    const cx = worldToChunkCoord(worldX);
    const cz = worldToChunkCoord(worldZ);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (rec && rec.walkDecks.length > 0) {
      const deck = sampleWalkDeckHeightFromList(rec.walkDecks, worldX, worldZ, referenceY);
      if (deck.found) return deck.surface;
    }
    const bridge = queryBridgeDeckHeight(worldX, worldZ);
    if (bridge.onBridge) return 'asphalt';
    return null;
  }

  /**
   * Resolves horizontal player capsule collision against all solid OBB walls, vehicles,
   * fuel pumps, shelving, guardrails, and bridge parapets in the current active chunk.
   */
  public resolveCapsuleHorizontal(
    posX: number,
    footY: number,
    posZ: number,
    radius: number,
    height: number,
    maxStepUpM: number,
    outPos: { x: number; z: number; hitWall: boolean; wallNormalX: number; wallNormalZ: number },
  ): void {
    outPos.x = posX;
    outPos.z = posZ;
    outPos.hitWall = false;
    outPos.wallNormalX = 0;
    outPos.wallNormalZ = 0;

    const cx = worldToChunkCoord(posX);
    const cz = worldToChunkCoord(posZ);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (!rec || rec.solidObbs.length === 0) return;

    resolveCapsuleHorizontalAgainstObbs(
      rec.solidObbs,
      posX,
      footY,
      posZ,
      radius,
      height,
      maxStepUpM,
      outPos,
    );
  }

  public hasOverheadClearance(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    crouchHeight: number,
    standHeight: number,
  ): boolean {
    const cx = worldToChunkCoord(x);
    const cz = worldToChunkCoord(z);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (!rec || rec.solidObbs.length === 0) return true;
    return hasOverheadClearanceAgainstObbs(
      rec.solidObbs,
      x,
      baseY,
      z,
      radius,
      crouchHeight,
      standHeight,
    );
  }

  /**
   * Zero-GC raycast against all active `3 × 3` chunk solid structures (walls, roofs, vehicles,
   * barriers, fuel dispensers, bridge guardrails). Leaves open doorways & windows clear!
   */
  public raycastActiveStructures(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    outHit: ObbRaycastHit,
  ): boolean {
    let anyHit = false;
    for (let i = 0; i < this.activeChunks.length; i++) {
      const obbs = this.activeChunks[i].solidObbs;
      if (obbs.length === 0) continue;
      if (raycastAgainstObbs(obbs, ox, oy, oz, dx, dy, dz, near, outHit)) {
        anyHit = true;
      }
    }
    return anyHit;
  }

  public sampleIndoorAt(
    x: number,
    y: number,
    z: number,
    outSample: BodycamInteriorSample,
  ): void {
    const cx = worldToChunkCoord(x);
    const cz = worldToChunkCoord(z);
    const rec = this.loadedChunks.get(chunkKey(cx, cz));
    if (rec && rec.indoorVolumes.length > 0) {
      const res = sampleIndoorVolumeFromList(rec.indoorVolumes, x, y, z);
      outSample.isIndoor = res.isIndoor;
      outSample.material = res.material;
      return;
    }
    outSample.isIndoor = false;
    outSample.material = 'outdoor';
  }

  public getActiveStructureStats(): { obbCount: number; deckCount: number; indoorVolumeCount: number } {
    let obbCount = 0;
    let deckCount = 0;
    let indoorVolumeCount = 0;
    for (let i = 0; i < this.activeChunks.length; i++) {
      obbCount += this.activeChunks[i].solidObbs.length;
      deckCount += this.activeChunks[i].walkDecks.length;
      indoorVolumeCount += this.activeChunks[i].indoorVolumes.length;
    }
    return { obbCount, deckCount, indoorVolumeCount };
  }

  public getStats(): StreamerStats {
    let activeChunkCount = 0;
    let midChunkCount = 0;
    let activeBatchedMeshCount = 0;
    for (const rec of this.loadedChunks.values()) {
      if (rec.lod === 'active') {
        activeChunkCount++;
        activeBatchedMeshCount += rec.batchedMeshes.length;
      } else {
        midChunkCount++;
      }
    }
    return {
      centerChunkX: this.lastCenterCx,
      centerChunkZ: this.lastCenterCz,
      activeChunkCount,
      midChunkCount,
      totalLoadedChunks: this.loadedChunks.size,
      visibleChunkCount: this.visibleChunkCount || this.loadedChunks.size,
      culledBehindChunkCount: this.culledBehindChunkCount,
      occludedChunkCount: this.occludedChunkCount,
      occludedObjectCount: this.occludedObjectCount,
      activeInstanceCount: this.activeInstanceCount,
      activeBatchedMeshCount,
      disposedChunkCount: this.disposedChunkCount,
      landmarkCount: OPENWORLD_LANDMARKS.length,
    };
  }

  public getLoadedChunkKeysByLod(): { active: string[]; mid: string[] } {
    const active: string[] = [];
    const mid: string[] = [];
    for (const rec of this.loadedChunks.values()) {
      if (rec.lod === 'active') active.push(rec.key);
      else mid.push(rec.key);
    }
    return { active, mid };
  }

  private disposeChunkRecord(rec: StreamedChunkRecord): void {
    this.chunksGroup.remove(rec.group);
    for (const inst of rec.instancedMeshes) {
      inst.dispose();
    }
    for (const bm of rec.batchedMeshes) {
      bm.dispose();
    }
    for (const geo of rec.ownedGeometries) {
      geo.dispose();
    }
    this.disposedChunkCount += 1;
  }

  public dispose(): void {
    for (const rec of this.loadedChunks.values()) {
      this.disposeChunkRecord(rec);
    }
    this.loadedChunks.clear();
    this.activeChunks.length = 0;

    for (const d of this.horizonDisposables) {
      d.dispose();
    }
    this.horizonDisposables.length = 0;

    if (this.ambientSmokeMesh) {
      this.ambientSmokeMesh.dispose();
      this.ambientSmokeMesh = null;
    }
    this.smokePuffs.length = 0;

    this.archBuilder.dispose();
    this.foliageBuilder.dispose();

    this.terrainTexture?.dispose();
    this.activeTerrainMat.dispose();
    this.midTerrainMat.dispose();
    this.hlodTerrainMat.dispose();
    this.trunkGeo.dispose();
    this.trunkMat.dispose();
    this.canopyGeo.dispose();
    this.canopyMat.dispose();
    this.midTreeGeo.dispose();
    this.midTreeMat.dispose();
    this.boulderGeo.dispose();
    this.boulderMat.dispose();
    this.scrubGeo.dispose();
    this.scrubMat.dispose();
    this.containerGeo.dispose();
    this.containerMat.dispose();
    this.midBuildingGeo.dispose();
    this.midBuildingMat.dispose();
    this.smokeGeo.dispose();
    this.smokeMat.dispose();
    for (const g of this.batchedPropGeos) {
      g.dispose();
    }
    this.batchedPropMat.dispose();

    this.rootGroup.parent?.remove(this.rootGroup);
  }
}

export { WORLD_HALF_M };

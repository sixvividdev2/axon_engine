import * as THREE from 'three';
import type { BodycamInteriorSample, BodycamSurfaceMaterial } from '../../../../bodycam-sdk/types';
import { OpenWorldArchitectureBuilder } from './OpenWorldArchitectureBuilder';
import {
  applyAtmosphericHeightFog,
  type AtmoFogSharedUniforms,
} from './OpenWorldAtmosphericFogShader';
import { FoliageAnchorPoint, OpenWorldFoliageBuilder } from './OpenWorldFoliageBuilder';
import {
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
  readonly lod: ChunkLodTier;
  readonly group: THREE.Group;
  readonly terrainGeo: THREE.BufferGeometry;
  readonly ownedGeometries: THREE.BufferGeometry[];
  readonly instancedMeshes: THREE.InstancedMesh[];
  readonly solidObbs: SolidObb[];
  readonly walkDecks: WalkDeck[];
  readonly indoorVolumes: IndoorVolume[];
  readonly treeRoosts: FoliageAnchorPoint[];
  readonly logAnchors: FoliageAnchorPoint[];
  readonly rockAnchors: FoliageAnchorPoint[];
  readonly collider: ActiveHeightfieldCollider | null;
  readonly instanceCount: number;
}

export interface StreamerStats {
  centerChunkX: number;
  centerChunkZ: number;
  activeChunkCount: number;
  midChunkCount: number;
  totalLoadedChunks: number;
  activeInstanceCount: number;
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
  const colors = new Float32Array(vertCount * 3);

  for (let i = 0; i < vertCount; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const wx = centerX + lx;
    const wz = centerZ + lz;
    sampleOpenWorldTerrain(wx, wz, _sample);
    pos.setY(i, _sample.height);
    if (heightfieldOut && i < heightfieldOut.length) {
      heightfieldOut[i] = _sample.height;
    }
    colors[i * 3] = _sample.r;
    colors[i * 3 + 1] = _sample.g;
    colors[i * 3 + 2] = _sample.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
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
  private readonly boulderGeo: THREE.DodecahedronGeometry;
  private readonly boulderMat: THREE.MeshStandardMaterial;
  private readonly scrubGeo: THREE.ConeGeometry;
  private readonly scrubMat: THREE.MeshStandardMaterial;
  private readonly containerGeo: THREE.BoxGeometry;
  private readonly containerMat: THREE.MeshStandardMaterial;
  private readonly midBuildingGeo: THREE.BoxGeometry;
  private readonly midBuildingMat: THREE.MeshStandardMaterial;

  // Horizon proxy disposable resources
  private readonly horizonDisposables: Array<{ dispose(): void }> = [];

  private readonly atmoFogUniforms?: AtmoFogSharedUniforms;
  private lastCenterCx = -999;
  private lastCenterCz = -999;
  private disposedChunkCount = 0;
  private activeInstanceCount = 0;

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

    // Procedural terrain grain texture & shared PBR terrain materials
    this.terrainTexture = createProceduralTerrainTexture();
    this.activeTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.terrainTexture,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.midTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
    });
    this.hlodTerrainMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
    });

    // Shared bottom-center instanced prop geometries
    this.trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 3.6, 6);
    this.trunkGeo.translate(0, 1.8, 0);
    this.trunkMat = new THREE.MeshStandardMaterial({ color: 0x4b382a, roughness: 0.94, metalness: 0.0 });

    this.canopyGeo = buildGroundedConiferCanopyGeo();
    this.canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.0 });
    this.foliageBuilder.applyWindToConiferMaterial(this.canopyGeo, this.canopyMat);

    this.boulderGeo = new THREE.DodecahedronGeometry(1.0, 0);
    this.boulderGeo.translate(0, 0.55, 0);
    this.boulderMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.04 });

    this.scrubGeo = new THREE.ConeGeometry(0.75, 1.4, 5);
    this.scrubGeo.translate(0, 0.7, 0);
    this.scrubMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0 });

    this.containerGeo = new THREE.BoxGeometry(2.5, 2.6, 6.1);
    this.containerGeo.translate(0, 1.3, 0);
    this.containerMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.38 });

    this.midBuildingGeo = new THREE.BoxGeometry(10, 6.5, 14);
    this.midBuildingGeo.translate(0, 3.25, 0);
    this.midBuildingMat = new THREE.MeshStandardMaterial({ color: 0x676d74, roughness: 0.84, metalness: 0.14 });

    if (this.atmoFogUniforms) {
      applyAtmosphericHeightFog(this.activeTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.midTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.hlodTerrainMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.trunkMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.canopyMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.boulderMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.scrubMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.containerMat, this.atmoFogUniforms);
      applyAtmosphericHeightFog(this.midBuildingMat, this.atmoFogUniforms);
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
      pos.setY(i, _sample.height - 2.4);
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
    this.horizonGroup.add(hlodMesh);
    this.horizonDisposables.push(hlodGeo);

    // 2. Coastal Sea & Estuary Water Sheet
    const seaGeo = new THREE.PlaneGeometry(WORLD_SIZE_M + 1400, 1800, 1, 1);
    seaGeo.rotateX(-Math.PI * 0.5);
    const seaMat = new THREE.MeshStandardMaterial({
      color: 0x16384c,
      roughness: 0.24,
      metalness: 0.35,
    });
    const seaMesh = new THREE.Mesh(seaGeo, seaMat);
    seaMesh.position.set(0, SEA_LEVEL_M, 1560);
    this.horizonGroup.add(seaMesh);
    this.horizonDisposables.push(seaGeo, seaMat);

    // 3. Alpine Hydroelectric Reservoir Water Surface (north of Dam)
    const resGeo = new THREE.CircleGeometry(330, 28);
    resGeo.rotateX(-Math.PI * 0.5);
    const resMat = new THREE.MeshStandardMaterial({
      color: 0x1a465c,
      roughness: 0.22,
      metalness: 0.38,
    });
    const resMesh = new THREE.Mesh(resGeo, resMat);
    resMesh.scale.set(1.05, 1, 0.62);
    resMesh.position.set(180, RESERVOIR_LEVEL_M, -1620);
    this.horizonGroup.add(resMesh);
    this.horizonDisposables.push(resGeo, resMat);

    // 4. Composite 3–12 Part Vertical Landmarks (visible across 4km for heli flight & optics)
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x7d807e, roughness: 0.86, metalness: 0.05 });
    const darkConcreteMat = new THREE.MeshStandardMaterial({ color: 0x4b4f52, roughness: 0.88, metalness: 0.08 });
    const craneOrangeMat = new THREE.MeshStandardMaterial({ color: 0xb94d24, roughness: 0.52, metalness: 0.48 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x5c6670, roughness: 0.42, metalness: 0.68 });
    const dishWhiteMat = new THREE.MeshStandardMaterial({ color: 0xd6dbe0, roughness: 0.48, metalness: 0.22 });
    const alphaBeaconMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0c4a6e,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.2,
    });
    const bravoBeaconMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0x7c2d12,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.2,
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
      } else {
        // PMC Alpha / Bravo FOB: Helipad apron + Watchtower + Command Hangar + Faction Beacon
        const beaconMat = lm.kind === 'fob_alpha' ? alphaBeaconMat : bravoBeaconMat;
        const padGeo = registerGeo(new THREE.CylinderGeometry(16, 16.5, 1.2, 16));
        const pad = new THREE.Mesh(padGeo, darkConcreteMat);
        pad.position.set(0, 0.5, 0);
        group.add(pad);

        const hangarGeo = registerGeo(new THREE.BoxGeometry(28, 9.5, 18));
        const hangar = new THREE.Mesh(hangarGeo, steelMat);
        hangar.position.set(-24, 4.75, -10);
        group.add(hangar);

        const towerShaftGeo = registerGeo(new THREE.BoxGeometry(4.5, 22, 4.5));
        const towerShaft = new THREE.Mesh(towerShaftGeo, concreteMat);
        towerShaft.position.set(22, 11, -14);
        group.add(towerShaft);

        const cabGeo = registerGeo(new THREE.BoxGeometry(7.6, 3.8, 7.6));
        const cab = new THREE.Mesh(cabGeo, darkConcreteMat);
        cab.position.set(22, 23, -14);
        group.add(cab);

        const beaconGeo = registerGeo(new THREE.BoxGeometry(1.4, 2.2, 1.4));
        const beacon = new THREE.Mesh(beaconGeo, beaconMat);
        beacon.position.set(22, 26, -14);
        group.add(beacon);
      }

      this.horizonGroup.add(group);
    }

    // 5. Persistent Steel-Truss River Bridges + Regional Water Towers & Guyed Radio Masts
    this.archBuilder.populateHorizonCivilization(this.horizonGroup, this.horizonDisposables);
  }

  /**
   * Streams chunks around `(worldX, worldZ)` into:
   * - `3 × 3` Active Ring (Chebyshev distance `<= 1`)
   * - `5 × 5` Outer Mid-Range Shell (Chebyshev distance `=== 2`)
   * Explicitly `.dispose()`s any chunk leaving the `5 × 5` footprint or switching LOD.
   */
  public update(worldX: number, worldZ: number): boolean {
    const centerCx = worldToChunkCoord(worldX);
    const centerCz = worldToChunkCoord(worldZ);
    if (centerCx === this.lastCenterCx && centerCz === this.lastCenterCz) {
      return false;
    }

    this.lastCenterCx = centerCx;
    this.lastCenterCz = centerCz;

    // 1. Identify desired chunks in the 5 x 5 neighborhood
    const desired = new Map<string, { cx: number; cz: number; lod: ChunkLodTier }>();
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cx = centerCx + dx;
        const cz = centerCz + dz;
        if (!isValidChunkCoord(cx, cz)) continue;
        const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
        const lod: ChunkLodTier = chebyshev <= 1 ? 'active' : 'mid';
        desired.set(chunkKey(cx, cz), { cx, cz, lod });
      }
    }

    // 2. Dispose chunks outside the 5 x 5 window OR requiring LOD transition
    for (const [key, rec] of this.loadedChunks) {
      const want = desired.get(key);
      if (!want || want.lod !== rec.lod) {
        this.disposeChunkRecord(rec);
        this.loadedChunks.delete(key);
      }
    }

    // 3. Build missing chunks
    for (const [key, spec] of desired) {
      if (this.loadedChunks.has(key)) continue;
      const built = this.buildChunkRecord(spec.cx, spec.cz, spec.lod);
      this.loadedChunks.set(key, built);
      this.chunksGroup.add(built.group);
    }

    // Recompute active chunk list, fauna anchors & instance totals (zero-GC iteration in hot path)
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
    return true;
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
    const terrainMesh = new THREE.Mesh(
      terrainGeo,
      lod === 'active' ? this.activeTerrainMat : this.midTerrainMat,
    );
    terrainMesh.receiveShadow = !this.isSoftwareGl && lod === 'active';
    terrainMesh.castShadow = false;
    group.add(terrainMesh);

    const ownedGeometries: THREE.BufferGeometry[] = [terrainGeo];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    const solidObbs: SolidObb[] = [];
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
      );
      instanceCount += archRes.instanceCount;
      instanceCount += this.populateActiveChunkProps(cx, cz, centerX, centerZ, group, instancedMeshes, treeRoosts);
      const foliageRes = this.foliageBuilder.populateActiveChunkFoliage(
        cx,
        cz,
        centerX,
        centerZ,
        group,
        instancedMeshes,
      );
      instanceCount += foliageRes.instanceCount;
      logAnchors = foliageRes.logAnchors;
      rockAnchors = foliageRes.rockAnchors;
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
    }

    return {
      key,
      cx,
      cz,
      lod,
      group,
      terrainGeo,
      ownedGeometries,
      instancedMeshes,
      solidObbs,
      walkDecks,
      indoorVolumes,
      treeRoosts,
      logAnchors,
      rockAnchors,
      collider,
      instanceCount,
    };
  }

  private populateActiveChunkProps(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    outMeshes: THREE.InstancedMesh[],
    outTreeRoosts: FoliageAnchorPoint[],
  ): number {
    const rand = mulberry32(chunkHash(cx, cz, 41));

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

    // 1. Conifer & Pine Forest / Alpine Timberline Trees
    const treeAttempts = 54;
    for (let i = 0; i < treeAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleOpenWorldTerrain(wx, wz, _sample);

      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.isQuarryPit || _sample.slope > 0.44) continue;
      if (isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 3.8)) continue;

      let spawnChance = 0.0;
      if (_sample.biome === 'temperate_conifer_valley') spawnChance = 0.88;
      else if (_sample.biome === 'highland_steppe_quarry') spawnChance = 0.24;
      else if (_sample.biome === 'alpine_ridge_dam' && _sample.height < 332) spawnChance = 0.42;
      else if (_sample.biome === 'coastal_port_marsh' && _sample.height > 4.5) spawnChance = 0.18;

      if (rand() <= spawnChance) {
        treePlacements.push({
          lx,
          y: _sample.height - 0.15,
          lz,
          scale: 0.85 + rand() * 0.35, // ±15%+ organic scale variation
          yaw: rand() * Math.PI * 2,
          tint: rand(),
        });
        if (_sample.biome === 'temperate_conifer_valley' && outTreeRoosts.length < 14) {
          outTreeRoosts.push({ x: wx, y: _sample.height, z: wz });
        }
      }
    }

    // 2. Boulders & Rock Outcrops (Steppe, Quarry, Alpine, Coastal breakwaters)
    const boulderAttempts = 28;
    for (let i = 0; i < boulderAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 12);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 12);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleOpenWorldTerrain(wx, wz, _sample);
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

    // 3. Coastal Marsh Reeds & Steppe Scrub Tufts
    const scrubAttempts = 40;
    for (let i = 0; i < scrubAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleOpenWorldTerrain(wx, wz, _sample);
      if (_sample.isWater || _sample.isRoad || _sample.isSitePad || _sample.slope > 0.5 || isNearLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 2.2)) continue;
      if (_sample.biome === 'alpine_ridge_dam' && _sample.height > 340) continue;

      if (rand() <= 0.65) {
        const isMarsh = _sample.biome === 'coastal_port_marsh';
        const isSteppe = _sample.biome === 'highland_steppe_quarry';
        scrubPlacements.push({
          lx,
          y: _sample.height - 0.08,
          lz,
          scale: 0.75 + rand() * 0.55,
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
      sampleOpenWorldTerrain(wx, wz, _sample);
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

    // Emit front-packed InstancedMesh batches (only if count > 0)
    if (treePlacements.length > 0) {
      const count = treePlacements.length;
      const trunks = new THREE.InstancedMesh(this.trunkGeo, this.trunkMat, count);
      const canopies = new THREE.InstancedMesh(this.canopyGeo, this.canopyMat, count);
      trunks.castShadow = !this.isSoftwareGl;
      canopies.castShadow = !this.isSoftwareGl;
      canopies.receiveShadow = !this.isSoftwareGl;

      for (let i = 0; i < count; i++) {
        const p = treePlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.scale, p.scale * (0.92 + p.tint * 0.22), p.scale);
        _dummy.updateMatrix();
        trunks.setMatrixAt(i, _dummy.matrix);
        canopies.setMatrixAt(i, _dummy.matrix);

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
      total += count * 2;
    }

    if (boulderPlacements.length > 0) {
      const count = boulderPlacements.length;
      const rocks = new THREE.InstancedMesh(this.boulderGeo, this.boulderMat, count);
      rocks.castShadow = !this.isSoftwareGl;
      rocks.receiveShadow = !this.isSoftwareGl;
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
      }
      rocks.instanceMatrix.needsUpdate = true;
      if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
      rocks.computeBoundingSphere();
      group.add(rocks);
      outMeshes.push(rocks);
      total += count;
    }

    if (scrubPlacements.length > 0) {
      const count = scrubPlacements.length;
      const scrubs = new THREE.InstancedMesh(this.scrubGeo, this.scrubMat, count);
      for (let i = 0; i < count; i++) {
        const p = scrubPlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.scale, p.scale * 0.9, p.scale);
        _dummy.updateMatrix();
        scrubs.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(p.r, p.g, p.b);
        scrubs.setColorAt(i, _color);
      }
      scrubs.instanceMatrix.needsUpdate = true;
      if (scrubs.instanceColor) scrubs.instanceColor.needsUpdate = true;
      scrubs.computeBoundingSphere();
      group.add(scrubs);
      outMeshes.push(scrubs);
      total += count;
    }

    if (containerPlacements.length > 0) {
      const count = containerPlacements.length;
      const containers = new THREE.InstancedMesh(this.containerGeo, this.containerMat, count);
      containers.castShadow = !this.isSoftwareGl;
      containers.receiveShadow = !this.isSoftwareGl;
      const palette = [0x2f536e, 0x823626, 0x3b4d38, 0x5c574d];
      for (let i = 0; i < count; i++) {
        const p = containerPlacements[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        containers.setMatrixAt(i, _dummy.matrix);
        _color.setHex(palette[Math.floor(p.tint * palette.length) % palette.length]);
        containers.setColorAt(i, _color);
      }
      containers.instanceMatrix.needsUpdate = true;
      if (containers.instanceColor) containers.instanceColor.needsUpdate = true;
      containers.computeBoundingSphere();
      group.add(containers);
      outMeshes.push(containers);
      total += count;
    }

    return total;
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
  ): void {
    this.foliageBuilder.update(
      elapsedSec,
      windSpeedMps,
      gust01,
      wetness01,
      playerX,
      playerZ,
      (x, z) => this.sampleTerrainHeightOnly(x, z),
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
    for (const rec of this.loadedChunks.values()) {
      if (rec.lod === 'active') activeChunkCount++;
      else midChunkCount++;
    }
    return {
      centerChunkX: this.lastCenterCx,
      centerChunkZ: this.lastCenterCz,
      activeChunkCount,
      midChunkCount,
      totalLoadedChunks: this.loadedChunks.size,
      activeInstanceCount: this.activeInstanceCount,
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
    this.boulderGeo.dispose();
    this.boulderMat.dispose();
    this.scrubGeo.dispose();
    this.scrubMat.dispose();
    this.containerGeo.dispose();
    this.containerMat.dispose();
    this.midBuildingGeo.dispose();
    this.midBuildingMat.dispose();

    this.rootGroup.parent?.remove(this.rootGroup);
  }
}

export { WORLD_HALF_M };

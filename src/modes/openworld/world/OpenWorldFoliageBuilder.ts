import * as THREE from 'three';
import type { GraphicsQualityProfile } from '../../../../data/graphicsQuality';
import {
  applyWindFoliageShader,
  assignHeightSwayAttribute,
  createWindShaderUniforms,
  WindShaderUniforms,
} from '../../../../engine/world/WindFoliageShader';
import {
  applyAtmosphericHeightFog,
  type AtmoFogSharedUniforms,
} from './OpenWorldAtmosphericFogShader';
import { isOnCivilizationClearance } from './OpenWorldCivilizationTopology';
import { isInsideFobCompound } from './OpenWorldFobLayout';
import {
  CHUNK_SIZE_M,
  chunkHash,
  createTerrainSample,
  createWaterProximitySample,
  mulberry32,
  OPENWORLD_LANDMARKS,
  queryWaterProximity,
  sampleOpenWorldTerrain,
  sampleOpenWorldTerrainFromHeight,
} from './OpenWorldTerrain';

export interface FoliageAnchorPoint {
  x: number;
  y: number;
  z: number;
}

export interface ChunkFoliageBuildResult {
  instanceCount: number;
  logAnchors: FoliageAnchorPoint[];
  rockAnchors: FoliageAnchorPoint[];
}

// Module-scope zero-GC scratch helpers
const _sample = createTerrainSample();
const _water = createWaterProximitySample();
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

function mergeIndexedParts(
  parts: Array<{ pos: number[]; norm: number[]; idx: number[]; sway?: number[] }>,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const sways: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    const vertCount = part.pos.length / 3;
    for (let i = 0; i < part.pos.length; i++) positions.push(part.pos[i]);
    for (let i = 0; i < part.norm.length; i++) normals.push(part.norm[i]);
    if (part.sway) {
      for (let i = 0; i < part.sway.length; i++) sways.push(part.sway[i]);
    } else {
      for (let i = 0; i < vertCount; i++) sways.push(0);
    }
    for (let i = 0; i < part.idx.length; i++) indices.push(part.idx[i] + vertexOffset);
    vertexOffset += vertCount;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aSway', new THREE.Float32BufferAttribute(sways, 1));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Multi-blade arched grass tuft (5 tapered blades fanned organically, bottom-center grounded).
 */
function buildGrassTuftGeo(): THREE.BufferGeometry {
  const parts: Array<{ pos: number[]; norm: number[]; idx: number[]; sway: number[] }> = [];
  const bladeCount = 5;
  for (let b = 0; b < bladeCount; b++) {
    const angle = (b / bladeCount) * Math.PI * 2 + (b % 2) * 0.28;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const tx = -sa;
    const tz = ca;
    const rOff = 0.08 + (b % 3) * 0.05;
    const h = 0.42 + (b % 3) * 0.14;
    const lean = 0.16 + (b % 2) * 0.11;
    const w0 = 0.055;
    const w1 = 0.032;

    const bx = ca * rOff;
    const bz = sa * rOff;
    const mx = bx + ca * lean * 0.48;
    const mz = bz + sa * lean * 0.48;
    const tipX = bx + ca * lean;
    const tipZ = bz + sa * lean;

    const pos = [
      bx - tx * w0, 0.0, bz - tz * w0,
      bx + tx * w0, 0.0, bz + tz * w0,
      mx - tx * w1, h * 0.56, mz - tz * w1,
      mx + tx * w1, h * 0.56, mz + tz * w1,
      tipX, h, tipZ,
    ];
    const norm = [
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.45, 0.89, sa * 0.45,
      ca * 0.45, 0.89, sa * 0.45,
      ca * 0.55, 0.83, sa * 0.55,
    ];
    const sway = [0.0, 0.0, 0.42, 0.42, 1.0];
    const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4];
    parts.push({ pos, norm, idx, sway });
  }
  return mergeIndexedParts(parts);
}

/**
 * Radial woodland fern rosette (7 arching tapered fronds with natural mid-arch droop).
 */
function buildFernRosetteGeo(): THREE.BufferGeometry {
  const parts: Array<{ pos: number[]; norm: number[]; idx: number[]; sway: number[] }> = [];
  const fronds = 7;
  for (let f = 0; f < fronds; f++) {
    const angle = (f / fronds) * Math.PI * 2 + (f % 2) * 0.18;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const tx = -sa;
    const tz = ca;
    const len = 0.68 + (f % 3) * 0.15;
    const peakY = 0.36 + (f % 2) * 0.1;
    const tipY = 0.16 + (f % 3) * 0.04;
    const wBase = 0.05;
    const wMid = 0.17;
    const wOuter = 0.1;

    const pos = [
      -tx * wBase, 0.02, -tz * wBase,
      tx * wBase, 0.02, tz * wBase,
      ca * len * 0.42 - tx * wMid, peakY, sa * len * 0.42 - tz * wMid,
      ca * len * 0.42 + tx * wMid, peakY, sa * len * 0.42 + tz * wMid,
      ca * len * 0.78 - tx * wOuter, peakY * 0.78, sa * len * 0.78 - tz * wOuter,
      ca * len * 0.78 + tx * wOuter, peakY * 0.78, sa * len * 0.78 + tz * wOuter,
      ca * len, tipY, sa * len,
    ];
    const norm = [
      0, 1, 0,
      0, 1, 0,
      ca * 0.2, 0.97, sa * 0.2,
      ca * 0.2, 0.97, sa * 0.2,
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.45, 0.89, sa * 0.45,
    ];
    const sway = [0.0, 0.0, 0.35, 0.35, 0.75, 0.75, 1.0];
    const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6];
    parts.push({ pos, norm, idx, sway });
  }
  return mergeIndexedParts(parts);
}

/**
 * Tall wetland rush & cattail cluster (6 vertical reed stalks + thick seed-head spikes).
 */
function buildMarshRushGeo(): THREE.BufferGeometry {
  const parts: Array<{ pos: number[]; norm: number[]; idx: number[]; sway: number[] }> = [];
  const reeds = 6;
  for (let r = 0; r < reeds; r++) {
    const a = (r / reeds) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tx = -sa;
    const tz = ca;
    const off = 0.08 + (r % 2) * 0.09;
    const h = 1.05 + (r % 3) * 0.34;
    const lean = 0.14 + (r % 2) * 0.08;
    const w0 = 0.036;
    const w1 = r < 2 ? 0.052 : 0.022; // Cattail head swell on 2 tallest stalks

    const bx = ca * off;
    const bz = sa * off;
    const pos = [
      bx - tx * w0, 0, bz - tz * w0,
      bx + tx * w0, 0, bz + tz * w0,
      bx + ca * lean * 0.65 - tx * w1, h * 0.72, bz + sa * lean * 0.65 - tz * w1,
      bx + ca * lean * 0.65 + tx * w1, h * 0.72, bz + sa * lean * 0.65 + tz * w1,
      bx + ca * lean, h, bz + sa * lean,
    ];
    const norm = [
      ca * 0.3, 0.95, sa * 0.3,
      ca * 0.3, 0.95, sa * 0.3,
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.35, 0.93, sa * 0.35,
      ca * 0.4, 0.91, sa * 0.4,
    ];
    const sway = [0.0, 0.0, 0.62, 0.62, 1.0];
    const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4];
    parts.push({ pos, norm, idx, sway });
  }
  return mergeIndexedParts(parts);
}

/**
 * Gnarled dead brush / bramble thicket built from forked crooked stems.
 */
function buildDeadBrushGeo(): THREE.BufferGeometry {
  const parts: Array<{ pos: number[]; norm: number[]; idx: number[]; sway: number[] }> = [];
  const branches = 6;
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + (i % 2) * 0.35;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tx = -sa;
    const tz = ca;
    const h = 0.55 + (i % 3) * 0.24;
    const spread = 0.32 + (i % 2) * 0.22;
    const w0 = 0.032;
    const w1 = 0.016;
    const kinkX = ca * spread * 0.45 + tx * ((i % 2 === 0 ? 1 : -1) * 0.09);
    const kinkZ = sa * spread * 0.45 + tz * ((i % 2 === 0 ? 1 : -1) * 0.09);

    const pos = [
      -tx * w0, 0, -tz * w0,
      tx * w0, 0, tz * w0,
      kinkX - tx * w1, h * 0.55, kinkZ - tz * w1,
      kinkX + tx * w1, h * 0.55, kinkZ + tz * w1,
      ca * spread, h, sa * spread,
    ];
    const norm = [
      ca * 0.4, 0.9, sa * 0.4,
      ca * 0.4, 0.9, sa * 0.4,
      ca * 0.5, 0.86, sa * 0.5,
      ca * 0.5, 0.86, sa * 0.5,
      ca * 0.6, 0.8, sa * 0.6,
    ];
    const sway = [0.0, 0.0, 0.28, 0.28, 0.65];
    const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4];
    parts.push({ pos, norm, idx, sway });
  }
  return mergeIndexedParts(parts);
}

/**
 * Angular multi-faceted field rock (distinct silhouette from round boulders, embedded bottom pivot).
 */
function buildFieldRockGeo(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.45, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const jitter = 0.82 + Math.abs(Math.sin(x * 7.3 + z * 5.1 + y * 3.7)) * 0.36;
    pos.setXYZ(i, x * jitter * 1.15, Math.max(-0.14, y * 0.68) + 0.16, z * jitter);
  }
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Fallen weathered timber log (tapered horizontal cylinder resting cleanly on ground).
 */
function buildFallenLogGeo(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.18, 0.27, 3.6, 7, 1, false);
  geo.rotateZ(Math.PI * 0.5);
  geo.translate(0, 0.17, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Ground stick / snapped forest branch with slight organic crook.
 */
function buildStickBranchGeo(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.018, 0.036, 1.15, 5, 2, false);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + Math.sin(y * 3.1) * 0.045);
  }
  geo.rotateZ(Math.PI * 0.5);
  geo.translate(0, 0.032, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Cut/broken conifer tree stump with flared root base.
 */
function buildStumpGeo(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.28, 0.44, 0.62, 7);
  geo.translate(0, 0.28, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function deterministicCellHash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(salt, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function isNearMajorLandmark(wx: number, wz: number): boolean {
  for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
    const lm = OPENWORLD_LANDMARKS[i];
    if (Math.hypot(wx - lm.worldX, wz - lm.worldZ) < lm.padRadiusM * 0.54) return true;
  }
  return false;
}

/**
 * Biome-Aware Wind-Animated Foliage & Natural Ground Clutter System:
 * - Streams instanced Grass Tufts, Woodland Ferns, Marsh Rushes & Cattails, Dead Brush,
 *   Field Rocks, Fallen Logs, Forest Sticks/Driftwood, and Broken Stumps per active 256m chunk.
 * - Maintains a 1-draw-call high-density Near-Player Micro-Grass Skirt (`~38m` ring)
 *   snapped to deterministic world cells for lush ground-level bodycam immersion with zero popping.
 * - Drives all living vegetation via Axon's shared `WindFoliageShader` uniforms (wind speed,
 *   rolling gusts, and rain wetness sheen).
 */
export class OpenWorldFoliageBuilder {
  public readonly windUniforms: WindShaderUniforms;
  public readonly nearGrassMesh: THREE.InstancedMesh;

  private readonly isSoftwareGl: boolean;
  private densityScale = 1.0;
  private shadowsEnabled = true;
  private readonly grassGeo: THREE.BufferGeometry;
  private readonly grassMat: THREE.MeshStandardMaterial;
  private readonly fernGeo: THREE.BufferGeometry;
  private readonly fernMat: THREE.MeshStandardMaterial;
  private readonly rushGeo: THREE.BufferGeometry;
  private readonly rushMat: THREE.MeshStandardMaterial;
  private readonly brushGeo: THREE.BufferGeometry;
  private readonly brushMat: THREE.MeshStandardMaterial;
  private readonly rockGeo: THREE.BufferGeometry;
  private readonly rockMat: THREE.MeshStandardMaterial;
  private readonly logGeo: THREE.BufferGeometry;
  private readonly logMat: THREE.MeshStandardMaterial;
  private readonly stickGeo: THREE.BufferGeometry;
  private readonly stickMat: THREE.MeshStandardMaterial;
  private readonly stumpGeo: THREE.BufferGeometry;
  private readonly stumpMat: THREE.MeshStandardMaterial;

  // Deterministic near-player grass ring state (zero-GC, 15x15 = 225 cells max, ~26m radius)
  private readonly nearRingGridRadius = 7;
  private readonly nearRingCellM = 3.8;
  private readonly nearRingCapacity: number;
  private lastNearCellX = 999999;
  private lastNearCellZ = 999999;

  constructor(
    scene: THREE.Scene,
    isSoftwareGl = false,
    atmoFogUniforms?: AtmoFogSharedUniforms,
  ) {
    this.isSoftwareGl = isSoftwareGl;
    this.windUniforms = createWindShaderUniforms();

    // Living Wind-Animated Geometries & Shared Materials
    this.grassGeo = buildGrassTuftGeo();
    this.grassMat = applyWindFoliageShader(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      this.windUniforms,
      { swayScale: 0.34 },
    );

    this.fernGeo = buildFernRosetteGeo();
    this.fernMat = applyWindFoliageShader(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      this.windUniforms,
      { swayScale: 0.25 },
    );

    this.rushGeo = buildMarshRushGeo();
    this.rushMat = applyWindFoliageShader(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.84,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      this.windUniforms,
      { swayScale: 0.42 },
    );

    this.brushGeo = buildDeadBrushGeo();
    this.brushMat = applyWindFoliageShader(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.94,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
      this.windUniforms,
      { swayScale: 0.14 },
    );

    // Static Mineral & Woody Ground Clutter
    this.rockGeo = buildFieldRockGeo();
    this.rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.91,
      metalness: 0.03,
    });

    this.logGeo = buildFallenLogGeo();
    this.logMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.stickGeo = buildStickBranchGeo();
    this.stickMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.0,
    });

    this.stumpGeo = buildStumpGeo();
    this.stumpMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.93,
      metalness: 0.0,
    });

    if (atmoFogUniforms) {
      applyAtmosphericHeightFog(this.grassMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.fernMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.rushMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.brushMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.rockMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.logMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.stickMat, atmoFogUniforms);
      applyAtmosphericHeightFog(this.stumpMat, atmoFogUniforms);
    }

    // Near-player dense micro-grass ring (1 draw call)
    const side = this.nearRingGridRadius * 2 + 1;
    this.nearRingCapacity = side * side;
    this.nearGrassMesh = new THREE.InstancedMesh(this.grassGeo, this.grassMat, this.nearRingCapacity);
    this.nearGrassMesh.name = 'openworld_near_grass_ring';
    this.nearGrassMesh.castShadow = false;
    this.nearGrassMesh.receiveShadow = false;
    this.nearGrassMesh.frustumCulled = false;
    this.nearGrassMesh.count = 0;
    scene.add(this.nearGrassMesh);
  }

  public applyQualityProfile(profile: GraphicsQualityProfile): void {
    this.densityScale = THREE.MathUtils.clamp(profile.foliageDensity, 0.25, 1.45);
    this.shadowsEnabled = !this.isSoftwareGl && profile.castShadows;
    this.nearGrassMesh.receiveShadow = false;
  }

  public getSharedMaterials(): THREE.Material[] {
    return [
      this.grassMat,
      this.fernMat,
      this.rushMat,
      this.brushMat,
      this.rockMat,
      this.logMat,
      this.stickMat,
      this.stumpMat,
    ];
  }

  /**
   * Hooks the chunk streamer's conifer canopies into the exact same GPU wind & rain wetness shader.
   */
  public applyWindToConiferMaterial(
    canopyGeo: THREE.BufferGeometry,
    canopyMat: THREE.MeshStandardMaterial,
  ): void {
    assignHeightSwayAttribute(canopyGeo, 1.8, 9.8, 1.75);
    applyWindFoliageShader(canopyMat, this.windUniforms, {
      swayScale: 0.22,
      fallbackYMin: 1.8,
      fallbackYSpan: 8.0,
    });
  }

  /**
   * Advances GPU wind & wetness shader uniforms and refreshes the near-player dense micro-grass skirt
   * whenever the operator crosses a 3.2m world cell. Zero per-frame heap allocations.
   */
  public update(
    elapsedSec: number,
    windSpeedMps: number,
    gust01: number,
    wetness01: number,
    playerX: number,
    playerZ: number,
    sampleGroundHeight: (x: number, z: number) => number,
  ): void {
    this.windUniforms.uTime.value = elapsedSec;
    this.windUniforms.uWindStrength.value = THREE.MathUtils.clamp(
      0.16 + (windSpeedMps / 16.0) * 0.62 + gust01 * 0.26,
      0.12,
      1.15,
    );
    this.windUniforms.uGustFreq.value = 0.65 + (windSpeedMps / 22.0) * 0.75;
    this.windUniforms.uWetness.value = THREE.MathUtils.clamp(wetness01, 0, 1);

    const cellX = Math.floor(playerX / this.nearRingCellM);
    const cellZ = Math.floor(playerZ / this.nearRingCellM);
    if (cellX !== this.lastNearCellX || cellZ !== this.lastNearCellZ) {
      this.rebuildNearGrassRing(cellX, cellZ, sampleGroundHeight);
    }
  }

  private rebuildNearGrassRing(
    centerCellX: number,
    centerCellZ: number,
    sampleGroundHeight: (x: number, z: number) => number,
  ): void {
    this.lastNearCellX = centerCellX;
    this.lastNearCellZ = centerCellZ;
    const rad = this.nearRingGridRadius;
    const step = this.nearRingCellM;
    const maxDistSq = (rad * step) * (rad * step);
    const centerWx = (centerCellX + 0.5) * step;
    const centerWz = (centerCellZ + 0.5) * step;

    // Skip rebuilding grass tufts when operator is inside a paved FOB compound
    if (isInsideFobCompound(centerWx, centerWz, 4)) {
      if (this.nearGrassMesh.count !== 0) {
        this.nearGrassMesh.count = 0;
        this.nearGrassMesh.instanceMatrix.needsUpdate = true;
      }
      return;
    }

    let count = 0;
    for (let dz = -rad; dz <= rad; dz++) {
      const iz = centerCellZ + dz;
      for (let dx = -rad; dx <= rad; dx++) {
        const ix = centerCellX + dx;
        const h0 = deterministicCellHash(ix, iz, 13);
        const h1 = deterministicCellHash(ix, iz, 29);
        const h2 = deterministicCellHash(ix, iz, 53);

        const wx = (ix + 0.12 + h0 * 0.76) * step;
        const wz = (iz + 0.12 + h1 * 0.76) * step;
        const distSq = (wx - centerWx) * (wx - centerWx) + (wz - centerWz) * (wz - centerWz);
        if (distSq > maxDistSq) continue;
        if (isNearMajorLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 2.1)) continue;

        // Fast bilinear heightfield lookup (avoids 3x analytical FBM evaluations per cell)
        const y = sampleGroundHeight(wx, wz);
        const yx = sampleGroundHeight(wx + 2.5, wz);
        const yz = sampleGroundHeight(wx, wz + 2.5);
        const slope = Math.min(1, Math.hypot((yx - y) * 0.4, (yz - y) * 0.4));
        sampleOpenWorldTerrainFromHeight(wx, wz, y, slope, _sample);

        if (
          _sample.isWater ||
          _sample.isRoad ||
          _sample.isSitePad ||
          _sample.isQuarryPit ||
          _sample.slope > 0.44 ||
          _sample.height > 325
        ) {
          continue;
        }

        // Biome density gating (Conifer Valley & Marsh densest, Alpine sparse)
        const chance =
          _sample.biome === 'temperate_conifer_valley'
            ? 0.86
            : _sample.biome === 'coastal_port_marsh'
              ? 0.72
              : _sample.biome === 'highland_steppe_quarry'
                ? 0.68
                : 0.25;
        if (h2 > chance) continue;

        const scale = 0.85 + h0 * 0.75;
        _dummy.position.set(wx, y - 0.04, wz);
        _dummy.rotation.set(0, h1 * Math.PI * 2, 0);
        _dummy.scale.set(scale, scale * (0.85 + h2 * 0.45), scale);
        _dummy.updateMatrix();
        this.nearGrassMesh.setMatrixAt(count, _dummy.matrix);

        if (_sample.biome === 'highland_steppe_quarry') {
          _color.setRGB(0.45 + h0 * 0.1, 0.41 + h1 * 0.08, 0.21 + h2 * 0.05);
        } else if (_sample.biome === 'coastal_port_marsh') {
          _color.setRGB(0.27 + h0 * 0.08, 0.36 + h1 * 0.08, 0.19 + h2 * 0.05);
        } else {
          _color.setRGB(0.18 + h0 * 0.08, 0.34 + h1 * 0.11, 0.15 + h2 * 0.05);
        }
        this.nearGrassMesh.setColorAt(count, _color);
        count++;
        if (count >= this.nearRingCapacity) break;
      }
      if (count >= this.nearRingCapacity) break;
    }

    this.nearGrassMesh.count = count;
    this.nearGrassMesh.instanceMatrix.needsUpdate = true;
    if (this.nearGrassMesh.instanceColor) {
      this.nearGrassMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Populates biome-appropriate instanced Grass Tufts, Ferns, Marsh Rushes, Dead Brush,
   * Field Rocks, Fallen Logs, Sticks/Driftwood, and Tree Stumps for an active 256m chunk.
   */
  public populateActiveChunkFoliage(
    cx: number,
    cz: number,
    centerX: number,
    centerZ: number,
    group: THREE.Group,
    outMeshes: THREE.InstancedMesh[],
    fastHeightSlope?: (wx: number, wz: number, out: { height: number; slope: number }) => void,
  ): ChunkFoliageBuildResult {
    const rand = mulberry32(chunkHash(cx, cz, 719));
    const hsScratch = { height: 0, slope: 0 };
    const sampleChunkTerrain = (wx: number, wz: number): void => {
      if (fastHeightSlope) {
        fastHeightSlope(wx, wz, hsScratch);
        sampleOpenWorldTerrainFromHeight(wx, wz, hsScratch.height, hsScratch.slope, _sample);
      } else {
        sampleOpenWorldTerrain(wx, wz, _sample);
      }
    };
    const logAnchors: FoliageAnchorPoint[] = [];
    const rockAnchors: FoliageAnchorPoint[] = [];

    const grassList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; r: number; g: number; b: number }> = [];
    const fernList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; tint: number }> = [];
    const rushList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; tint: number }> = [];
    const brushList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; tint: number }> = [];
    const rockList: Array<{ lx: number; y: number; lz: number; sx: number; sy: number; sz: number; yaw: number; tint: number }> = [];
    const logList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; pitch: number; tint: number }> = [];
    const stickList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; tint: number }> = [];
    const stumpList: Array<{ lx: number; y: number; lz: number; s: number; yaw: number; tint: number }> = [];

    const dScale = this.densityScale;
    const grassAttempts = Math.round(150 * dScale);
    const fernAttempts = Math.round(88 * dScale);
    const rushAttempts = Math.round(95 * dScale);
    const brushAttempts = Math.round(56 * dScale);
    const rockAttempts = Math.round(64 * dScale);
    const logAttempts = Math.round(24 * dScale);
    const stickAttempts = Math.round(68 * dScale);
    const stumpAttempts = Math.round(16 * dScale);

    // 1. Mid-range Chunk Grass Tufts (fills out hills/clearings beyond the 35m near-player skirt)
    for (let i = 0; i < grassAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.isQuarryPit ||
        _sample.slope > 0.44 ||
        _sample.height > 320 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 2.4)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'temperate_conifer_valley'
          ? 0.85
          : _sample.biome === 'highland_steppe_quarry'
            ? 0.72
            : _sample.biome === 'coastal_port_marsh'
              ? 0.65
              : 0.25;
      if (rand() > prob) continue;

      const t = rand();
      const isSteppe = _sample.biome === 'highland_steppe_quarry';
      const isMarsh = _sample.biome === 'coastal_port_marsh';
      grassList.push({
        lx,
        y: _sample.height - 0.04,
        lz,
        s: 1.05 + rand() * 0.85,
        yaw: rand() * Math.PI * 2,
        r: isSteppe ? 0.48 + t * 0.1 : isMarsh ? 0.28 + t * 0.07 : 0.19 + t * 0.08,
        g: isSteppe ? 0.42 + t * 0.09 : isMarsh ? 0.37 + t * 0.08 : 0.35 + t * 0.11,
        b: isSteppe ? 0.22 + t * 0.05 : isMarsh ? 0.19 + t * 0.05 : 0.15 + t * 0.05,
      });
    }

    // 2. Woodland Ferns (Temperate Conifer shade + damp marsh edges)
    for (let i = 0; i < fernAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.isQuarryPit ||
        _sample.slope > 0.42 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 2.6)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'temperate_conifer_valley'
          ? 0.84
          : _sample.biome === 'coastal_port_marsh' && _sample.height > 2.2
            ? 0.42
            : _sample.biome === 'alpine_ridge_dam' && _sample.height < 305
              ? 0.22
              : 0.04;
      if (rand() > prob) continue;
      fernList.push({
        lx,
        y: _sample.height - 0.03,
        lz,
        s: 0.8 + rand() * 0.65,
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
    }

    // 3. Marsh Rush & Cattails (Riverbanks, Coastal Marsh Delta, Wetland Edges — frog cover!)
    for (let i = 0; i < rushAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 8);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (_sample.isRoad || _sample.isSitePad || isNearMajorLandmark(wx, wz) || isOnCivilizationClearance(wx, wz, 2.5)) {
        continue;
      }
      queryWaterProximity(wx, wz, _sample.height, _water);
      const inWetZone =
        _water.isFrogHabitat ||
        (_water.waterKind !== 'none' && _water.distanceToWaterM <= 18 && _water.waterDepthM < 0.28);
      if (!inWetZone) continue;

      rushList.push({
        lx,
        y: _sample.height - 0.06,
        lz,
        s: 0.82 + rand() * 0.62,
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
    }

    // 4. Dead Brush & Brambles (Highland Steppe, Quarry rims, Alpine scrub, Forest edges)
    for (let i = 0; i < brushAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.slope > 0.5 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 2.4)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'highland_steppe_quarry'
          ? 0.78
          : _sample.biome === 'alpine_ridge_dam'
            ? 0.52
            : 0.42;
      if (rand() > prob) continue;
      brushList.push({
        lx,
        y: _sample.height - 0.05,
        lz,
        s: 0.85 + rand() * 0.72,
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
    }

    // 5. Small Field Rocks & Scree Pebbles (complements large chunk boulders)
    for (let i = 0; i < rockAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 2.4)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'alpine_ridge_dam' || _sample.isQuarryPit
          ? 0.82
          : _sample.biome === 'highland_steppe_quarry'
            ? 0.65
            : 0.46;
      if (rand() > prob) continue;
      const baseS = 0.45 + rand() * 1.05;
      rockList.push({
        lx,
        y: _sample.height - 0.06,
        lz,
        sx: baseS * (0.85 + rand() * 0.4),
        sy: baseS * (0.65 + rand() * 0.45),
        sz: baseS * (0.85 + rand() * 0.4),
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
      if (rockAnchors.length < 18) {
        rockAnchors.push({ x: wx, y: _sample.height, z: wz });
      }
    }

    // 6. Fallen Logs & Mossy Timber (Conifer Valley, forest edges, coastal driftwood)
    for (let i = 0; i < logAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 16);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 16);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.isQuarryPit ||
        _sample.slope > 0.34 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 4.2)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'temperate_conifer_valley'
          ? 0.72
          : _sample.biome === 'coastal_port_marsh'
            ? 0.34
            : _sample.biome === 'highland_steppe_quarry'
              ? 0.18
              : 0.12;
      if (rand() > prob) continue;

      logList.push({
        lx,
        y: _sample.height - 0.04,
        lz,
        s: 0.75 + rand() * 0.65,
        yaw: rand() * Math.PI * 2,
        pitch: (_sample.slope * 0.35) * (rand() > 0.5 ? 1 : -1),
        tint: rand(),
      });
      logAnchors.push({ x: wx, y: _sample.height, z: wz });
    }

    // 7. Sticks, Branches & Shoreline Driftwood
    for (let i = 0; i < stickAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 10);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.slope > 0.44 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 2.2)
      ) {
        continue;
      }
      const prob =
        _sample.biome === 'temperate_conifer_valley'
          ? 0.76
          : _sample.biome === 'coastal_port_marsh'
            ? 0.52
            : 0.28;
      if (rand() > prob) continue;
      stickList.push({
        lx,
        y: _sample.height - 0.01,
        lz,
        s: 0.65 + rand() * 0.85,
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
    }

    // 8. Broken Tree Stumps in Conifer Clearings
    for (let i = 0; i < stumpAttempts; i++) {
      const lx = (rand() - 0.5) * (CHUNK_SIZE_M - 16);
      const lz = (rand() - 0.5) * (CHUNK_SIZE_M - 16);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      sampleChunkTerrain(wx, wz);
      if (
        _sample.isWater ||
        _sample.isRoad ||
        _sample.isSitePad ||
        _sample.biome !== 'temperate_conifer_valley' ||
        _sample.slope > 0.32 ||
        isNearMajorLandmark(wx, wz) ||
        isOnCivilizationClearance(wx, wz, 3.6)
      ) {
        continue;
      }
      if (rand() > 0.55) continue;
      stumpList.push({
        lx,
        y: _sample.height - 0.06,
        lz,
        s: 0.8 + rand() * 0.55,
        yaw: rand() * Math.PI * 2,
        tint: rand(),
      });
    }

    let total = 0;

    if (grassList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.grassGeo, this.grassMat, grassList.length);
      mesh.receiveShadow = false;
      for (let i = 0; i < grassList.length; i++) {
        const p = grassList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s * 0.95, p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(p.r, p.g, p.b);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += grassList.length;
    }

    if (fernList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.fernGeo, this.fernMat, fernList.length);
      mesh.receiveShadow = false;
      for (let i = 0; i < fernList.length; i++) {
        const p = fernList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s, p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.18 + p.tint * 0.09, 0.34 + p.tint * 0.14, 0.14 + p.tint * 0.06);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += fernList.length;
    }

    if (rushList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.rushGeo, this.rushMat, rushList.length);
      mesh.receiveShadow = false;
      for (let i = 0; i < rushList.length; i++) {
        const p = rushList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s * (0.9 + p.tint * 0.3), p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.24 + p.tint * 0.1, 0.33 + p.tint * 0.1, 0.16 + p.tint * 0.05);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += rushList.length;
    }

    if (brushList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.brushGeo, this.brushMat, brushList.length);
      for (let i = 0; i < brushList.length; i++) {
        const p = brushList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s, p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.36 + p.tint * 0.12, 0.3 + p.tint * 0.1, 0.21 + p.tint * 0.07);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += brushList.length;
    }

    if (rockList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.rockGeo, this.rockMat, rockList.length);
      mesh.receiveShadow = false;
      for (let i = 0; i < rockList.length; i++) {
        const p = rockList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(p.tint * 0.3, p.yaw, p.tint * 0.25);
        _dummy.scale.set(p.sx, p.sy, p.sz);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        const shade = 0.36 + p.tint * 0.2;
        _color.setRGB(shade, shade * 0.98, shade * 0.93);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += rockList.length;
    }

    if (logList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.logGeo, this.logMat, logList.length);
      mesh.castShadow = false;
      mesh.receiveShadow = this.shadowsEnabled;
      for (let i = 0; i < logList.length; i++) {
        const p = logList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(p.pitch, p.yaw, 0);
        _dummy.scale.set(p.s, p.s * 0.92, p.s * 0.92);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        // Mossy cedar / weathered driftwood variation
        _color.setRGB(0.28 + p.tint * 0.11, 0.23 + p.tint * 0.09, 0.16 + p.tint * 0.06);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += logList.length;
    }

    if (stickList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.stickGeo, this.stickMat, stickList.length);
      for (let i = 0; i < stickList.length; i++) {
        const p = stickList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s, p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.32 + p.tint * 0.14, 0.25 + p.tint * 0.1, 0.17 + p.tint * 0.07);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += stickList.length;
    }

    if (stumpList.length > 0) {
      const mesh = new THREE.InstancedMesh(this.stumpGeo, this.stumpMat, stumpList.length);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < stumpList.length; i++) {
        const p = stumpList[i];
        _dummy.position.set(p.lx, p.y, p.lz);
        _dummy.rotation.set(0, p.yaw, 0);
        _dummy.scale.set(p.s, p.s, p.s);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        _color.setRGB(0.3 + p.tint * 0.08, 0.23 + p.tint * 0.06, 0.16 + p.tint * 0.05);
        mesh.setColorAt(i, _color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      outMeshes.push(mesh);
      total += stumpList.length;
    }

    return {
      instanceCount: total,
      logAnchors,
      rockAnchors,
    };
  }

  public dispose(): void {
    this.nearGrassMesh.parent?.remove(this.nearGrassMesh);
    this.nearGrassMesh.dispose();
    this.grassGeo.dispose();
    this.grassMat.dispose();
    this.fernGeo.dispose();
    this.fernMat.dispose();
    this.rushGeo.dispose();
    this.rushMat.dispose();
    this.brushGeo.dispose();
    this.brushMat.dispose();
    this.rockGeo.dispose();
    this.rockMat.dispose();
    this.logGeo.dispose();
    this.logMat.dispose();
    this.stickGeo.dispose();
    this.stickMat.dispose();
    this.stumpGeo.dispose();
    this.stumpMat.dispose();
  }
}

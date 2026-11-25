import * as THREE from 'three';
import type { BodycamInteriorSample } from '../../../../bodycam-sdk/types';
import { graphicsQualityStore } from '../../../../data/graphicsQuality';
import { OpenWorldAmbienceAudio, isHourInWindow } from './OpenWorldAmbienceAudio';
import {
  createRoadQueryResult,
  createSitePadQueryResult,
  getBakedOpenWorldSites,
  isOnCivilizationClearance,
  queryRoadNetwork,
  querySitePad,
} from './OpenWorldCivilizationTopology';
import { isInsideFobCompound } from './OpenWorldFobLayout';
import { FoliageAnchorPoint } from './OpenWorldFoliageBuilder';
import type { OpenWorldOcclusionCuller } from './OpenWorldOcclusionCuller';
import {
  createTerrainSample,
  createWaterProximitySample,
  OPENWORLD_LANDMARKS,
  queryWaterProximity,
  sampleOpenWorldTerrain,
  SEA_LEVEL_M,
} from './OpenWorldTerrain';

export type WolfPackState =
  | 'PATROL'
  | 'STALK'
  | 'HUNT_PREY'
  | 'PACK_FIGHT'
  | 'ENCIRCLE'
  | 'LUNGE'
  | 'FLEE';

export type DeerHerdState = 'GRAZE' | 'ALERT' | 'BOLT';

export interface WolfBitePlayerEvent {
  wolfId: string;
  packId: string;
  damageHp: number;
  bleedDurationSec: number;
  sprintSlowDurationSec: number;
  originX: number;
  originY: number;
  originZ: number;
}

export interface WildlifeHarvestPrompt {
  entityId: string;
  species: 'wolf' | 'deer';
  label: string;
  sublabel: string;
  distanceM: number;
  cashValueUsd: number;
}

export interface WildlifeHarvestResult {
  entityId: string;
  species: 'wolf' | 'deer';
  pelts: number;
  meatKg: number;
  cashUsd: number;
  supplyMedicalOrRations: number;
  summaryLabel: string;
}

export interface InsectSquishResult {
  squishedCount: number;
  spidersSquished: number;
  antsSquished: number;
  bootGrime01: number;
}

export interface WildlifeUpdateContext {
  dt: number;
  elapsedSec: number;
  timeOfDayHours: number;
  nightFactor: number;
  windSpeedMps: number;
  isRaining: boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerYawRad: number;
  playerSpeedMps: number;
  playerCrouched: boolean;
  playerSprinting: boolean;
  playerAlive: boolean;
  playerOnFoot: boolean;
  flashlightOn: boolean;
  nearbyLogs?: ReadonlyArray<FoliageAnchorPoint>;
  nearbyRocks?: ReadonlyArray<FoliageAnchorPoint>;
  occlusionCuller?: OpenWorldOcclusionCuller;
  sampleIndoorAt?: (x: number, y: number, z: number, out: BodycamInteriorSample) => void;
  onWolfBitePlayer?: (ev: WolfBitePlayerEvent) => void;
}

export interface WildlifeSummaryTelemetry {
  activeWolfPacks: number;
  aliveWolves: number;
  aliveDeer: number;
  activeFrogs: number;
  activeButterflies: number;
  activeInsects: number;
  totalSquishedInsects: number;
  bootGrime01: number;
  harvestableCarcasses: number;
}

// ============================================================================
// INTERNAL DATA STRUCTURES
// ============================================================================

interface WolfRigParts {
  root: THREE.Group;
  bodyPivot: THREE.Group;
  neckPivot: THREE.Group;
  jawPivot: THREE.Group;
  tailPivot: THREE.Group;
  legFL: THREE.Mesh;
  legFR: THREE.Mesh;
  legBL: THREE.Mesh;
  legBR: THREE.Mesh;
  hitbox: THREE.Mesh;
}

interface WolfEntity {
  id: string;
  packId: string;
  isAlpha: boolean;
  rig: WolfRigParts;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  harvested: boolean;
  gaitPhase: number;
  howlTimer: number;
  biteCooldown: number;
  growlCooldown: number;
  flankAngleOffset: number;
  lungeTimer: number;
  deathRoll: number;
}

interface WolfPackBlackboard {
  id: string;
  homeX: number;
  homeZ: number;
  patrolX: number;
  patrolZ: number;
  state: WolfPackState;
  stateTimer: number;
  howlCooldown: number;
  aggroScore: number;
  fearScore: number;
  targetDeerId: string | null;
  rivalPackId: string | null;
  fleeDirX: number;
  fleeDirZ: number;
  members: WolfEntity[];
}

interface DeerRigParts {
  root: THREE.Group;
  bodyPivot: THREE.Group;
  neckPivot: THREE.Group;
  earL: THREE.Mesh;
  earR: THREE.Mesh;
  tailPivot: THREE.Group;
  legFL: THREE.Mesh;
  legFR: THREE.Mesh;
  legBL: THREE.Mesh;
  legBR: THREE.Mesh;
  hitbox: THREE.Mesh;
}

interface DeerEntity {
  id: string;
  herdId: string;
  isBuck: boolean;
  rig: DeerRigParts;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  harvested: boolean;
  gaitPhase: number;
  earTwitchPhase: number;
  grazeBlend: number;
  hoofCooldown: number;
  deathRoll: number;
}

interface DeerHerdBlackboard {
  id: string;
  homeX: number;
  homeZ: number;
  state: DeerHerdState;
  stateTimer: number;
  boltDirX: number;
  boltDirZ: number;
  snortCooldown: number;
  members: DeerEntity[];
}

interface FrogInstanceState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hopProgress: number; // 0 = crouched idle, >0..1 = mid-air extended leap
  hopStartX: number;
  hopStartY: number;
  hopStartZ: number;
  hopEndX: number;
  hopEndY: number;
  hopEndZ: number;
  submergedTimer: number;
  croakCooldown: number;
  pitchScale: number;
  spawnBlend: number;
}

interface ButterflyInstanceState {
  active: boolean;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  phase: number;
  freqA: number;
  freqB: number;
  scatterVy: number;
  scatterTimer: number;
  spawnBlend: number;
}

interface InsectInstanceState {
  active: boolean;
  isSpider: boolean;
  habitat: 'wilderness' | 'building';
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  turnTimer: number;
  trailCenterX: number;
  trailCenterZ: number;
  trailAngle: number;
  squishedTimer: number;
  spawnBlend: number;
}

export interface DynamicSpawnAuditEntry {
  kind: 'wolf_pack' | 'deer_herd' | 'frog' | 'butterfly' | 'spider' | 'ant';
  x: number;
  y: number;
  z: number;
  distFromPlayerM: number;
  dotForward: number;
  terrainOccluded: boolean;
}

// Zero-GC scratch helpers
const _terrain = createTerrainSample();
const _water = createWaterProximitySample();
const _habitatTerrain = createTerrainSample();
const _habitatRoad = createRoadQueryResult();
const _habitatPad = createSitePadQueryResult();
const _indoorScratch: BodycamInteriorSample = { isIndoor: false, material: 'outdoor' };
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

export type InsectHabitatKind = 'wilderness' | 'building' | 'forbidden';

// Minimum clearances keeping deer strictly in deep wilderness away from civilization
const DEER_MIN_ROAD_DIST_M = 65;
const DEER_MIN_SITE_DIST_M = 95;
const DEER_MIN_LANDMARK_DIST_M = 140;

// Sparse caps so insects appear primarily in wilderness and only occasionally inside/around buildings
const MAX_BUILDING_SPIDERS = 2;
const MAX_BUILDING_ANTS = 5;
const BUILDING_SPIDER_SPAWN_CHANCE = 0.34;
const BUILDING_ANT_TRAIL_SPAWN_CHANCE = 0.24;

/**
 * Returns true ONLY for deep wilderness terrain suitable for deer herds:
 * temperate conifer forests, wild highland steppe (outside quarry pits), or lower alpine timberline,
 * strictly well away from paved/dirt roads (`>= 65m`), settlements/camps/houses (`>= 95m`),
 * FOB compounds, and major industrial landmarks (`>= 140m`).
 */
export function isDeerWildernessHabitat(wx: number, wz: number): boolean {
  if (isInsideFobCompound(wx, wz)) return false;

  sampleOpenWorldTerrain(wx, wz, _habitatTerrain);
  if (
    _habitatTerrain.isWater ||
    _habitatTerrain.isRoad ||
    _habitatTerrain.isSitePad ||
    _habitatTerrain.isQuarryPit ||
    _habitatTerrain.slope > 0.36
  ) {
    return false;
  }

  const validBiome =
    _habitatTerrain.biome === 'temperate_conifer_valley' ||
    _habitatTerrain.biome === 'highland_steppe_quarry' ||
    (_habitatTerrain.biome === 'alpine_ridge_dam' && _habitatTerrain.height < 245);
  if (!validBiome) return false;

  queryRoadNetwork(wx, wz, _habitatRoad);
  if (_habitatRoad.tier !== 'none' && _habitatRoad.distanceM < DEER_MIN_ROAD_DIST_M) {
    return false;
  }

  querySitePad(wx, wz, _habitatPad);
  if (_habitatPad.onPad || _habitatPad.blend > 0.01) {
    return false;
  }

  const sites = getBakedOpenWorldSites();
  const minSiteSq = DEER_MIN_SITE_DIST_M * DEER_MIN_SITE_DIST_M;
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const dx = wx - s.x;
    const dz = wz - s.z;
    if (dx * dx + dz * dz < minSiteSq) {
      return false;
    }
  }

  for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
    const lm = OPENWORLD_LANDMARKS[i];
    const minD = Math.max(DEER_MIN_LANDMARK_DIST_M, lm.padRadiusM + 65);
    const dx = wx - lm.worldX;
    const dz = wz - lm.worldZ;
    if (dx * dx + dz * dz < minD * minD) {
      return false;
    }
  }

  return true;
}

/**
 * Classifies an insect candidate position into:
 * - `'wilderness'`: natural forest floor, marsh bank, wild steppe grass/logs/rocks well off roads & pads
 * - `'building'`: inside enterable houses/barns/cabins/homesteads/camp structures or right along their walls
 * - `'forbidden'`: highways, roads, shoulders, bridges, open forecourts/tarmac, FOB courtyards, water, high alpine rock/snow
 */
export function classifyInsectHabitat(
  wx: number,
  wy: number,
  wz: number,
  indoorSample?: Pick<BodycamInteriorSample, 'isIndoor' | 'material'> | null,
): InsectHabitatKind {
  // 1. Enterable civilian building interior (exclude military FOB compound interiors/courtyards)
  if (indoorSample?.isIndoor && !isInsideFobCompound(wx, wz)) {
    return 'building';
  }

  // Reject concrete military FOB compounds on open tarmac/courtyards
  if (isInsideFobCompound(wx, wz)) {
    return 'forbidden';
  }

  // Reject all roadways, shoulders, bridges, and immediate roadside gravel
  queryRoadNetwork(wx, wz, _habitatRoad);
  if (
    _habitatRoad.onRoad ||
    _habitatRoad.onShoulder ||
    _habitatRoad.onBridge ||
    (_habitatRoad.tier !== 'none' &&
      _habitatRoad.distanceM <= _habitatRoad.halfWidthM + _habitatRoad.shoulderM + 5.0)
  ) {
    return 'forbidden';
  }

  // Check proximity to rustic/residential building footprints (houses, barns, camp outposts)
  const sites = getBakedOpenWorldSites();
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const dx = wx - s.x;
    const dz = wz - s.z;
    const distSq = dx * dx + dz * dz;
    const isRuralBuilding =
      s.kind === 'house_cabin' ||
      s.kind === 'house_bungalow' ||
      s.kind === 'house_homestead' ||
      s.kind === 'barn' ||
      s.kind === 'camp_outpost';
    if (isRuralBuilding && distSq <= 7.8 * 7.8 && wy >= s.groundY - 0.6) {
      return 'building';
    }
    // Keep open gas station forecourts, checkpoint concrete, and outer parking pads insect-free
    const padLimit = s.padRadiusM + 3.0;
    if (distSq <= padLimit * padLimit) {
      return 'forbidden';
    }
  }

  querySitePad(wx, wz, _habitatPad);
  if (_habitatPad.onPad || _habitatPad.blend > 0.12) {
    return 'forbidden';
  }

  // Keep major industrial landmarks (Dam concrete, Port tarmac, Quarry pit, Railyard apron) insect-free
  for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
    const lm = OPENWORLD_LANDMARKS[i];
    const excl = lm.padRadiusM * 0.85;
    const dx = wx - lm.worldX;
    const dz = wz - lm.worldZ;
    if (dx * dx + dz * dz < excl * excl) {
      return 'forbidden';
    }
  }

  sampleOpenWorldTerrain(wx, wz, _habitatTerrain);
  if (
    _habitatTerrain.isWater ||
    _habitatTerrain.isRoad ||
    _habitatTerrain.isSitePad ||
    _habitatTerrain.isQuarryPit ||
    _habitatTerrain.slope > 0.48 ||
    _habitatTerrain.height > 265
  ) {
    return 'forbidden';
  }

  if (
    _habitatTerrain.biome === 'temperate_conifer_valley' ||
    _habitatTerrain.biome === 'coastal_port_marsh' ||
    _habitatTerrain.biome === 'highland_steppe_quarry' ||
    (_habitatTerrain.biome === 'alpine_ridge_dam' && _habitatTerrain.height < 245)
  ) {
    return 'wilderness';
  }

  return 'forbidden';
}

// Spread-out macro-fauna budgets & 50% reduced ground insect pools
const MAX_WOLF_PACKS = 3;
const MAX_DEER_HERDS = 3;
const FROG_POOL_SIZE = 24;
const BUTTERFLY_POOL_SIZE = 28;
const SPIDER_POOL_SIZE = 7; // Reduced by 50% (was 14)
const ANT_POOL_SIZE = 18; // Reduced by 50% (was 36)
const SPLAT_POOL_SIZE = 32;

// Spread-out spatial separation & spawn-ring distances
const WOLF_SPAWN_MIN_DIST_M = 135;
const WOLF_SPAWN_MAX_DIST_M = 270;
const WOLF_DESPAWN_DIST_M = 390;
const WOLF_MIN_PACK_SEPARATION_M = 175;
const WOLF_MIN_DEER_SEPARATION_M = 85;

const DEER_SPAWN_MIN_DIST_M = 110;
const DEER_SPAWN_MAX_DIST_M = 245;
const DEER_DESPAWN_DIST_M = 365;
const DEER_MIN_HERD_SEPARATION_M = 155;
const DEER_MIN_WOLF_SEPARATION_M = 85;

const FROG_MIN_SEPARATION_M = 3.8;
const BUTTERFLY_MIN_SEPARATION_M = 4.5;
const SPIDER_MIN_SEPARATION_M = 3.2;
const ANT_TRAIL_MIN_SEPARATION_M = 5.0;

/**
 * Ultra-conservative rear blind-spot threshold (`cos(102.7°) = -0.22`).
 * Even with an ultra-wide 110° bodycam lens + head roll/sway, any point with
 * `dot(dirToPoint, cameraForward) <= -0.22` is strictly behind the player's camera frustum.
 */
const HIDDEN_REAR_DOT_MAX = -0.22;

export const WILDLIFE_POOL_BUDGETS = {
  maxWolfPacks: MAX_WOLF_PACKS,
  maxDeerHerds: MAX_DEER_HERDS,
  frogs: FROG_POOL_SIZE,
  butterflies: BUTTERFLY_POOL_SIZE,
  spiders: SPIDER_POOL_SIZE,
  ants: ANT_POOL_SIZE,
  totalInsects: SPIDER_POOL_SIZE + ANT_POOL_SIZE,
  wolfMinPackSeparationM: WOLF_MIN_PACK_SEPARATION_M,
  deerMinHerdSeparationM: DEER_MIN_HERD_SEPARATION_M,
} as const;

function wrapAngleDiff(target: number, current: number): number {
  let d = (target - current + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
}

/**
 * Builds a 2-triangle hinged wing butterfly geometry animated on the GPU via `onBeforeCompile`.
 */
function buildButterflyWingGeometry(): THREE.BufferGeometry {
  // Two triangular wings hinged along x = 0 (left wing x < 0, right wing x > 0)
  const positions = new Float32Array([
    // Left wing triangle
    0.0, 0.0, -0.025,
    -0.062, 0.015, -0.042,
    -0.045, 0.0, 0.048,
    // Right wing triangle
    0.0, 0.0, -0.025,
    0.045, 0.0, 0.048,
    0.062, 0.015, -0.042,
  ]);
  const normals = new Float32Array([
    0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0,
  ]);
  // aWingSide: -1 left tip, +1 right tip, 0 body hinge
  const wingSide = new Float32Array([0, -1, -0.8, 0, 0.8, 1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aWingSide', new THREE.BufferAttribute(wingSide, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds a compact ground frog silhouette (crouched body + hind thighs, bottom-center grounded).
 */
function buildFrogGeometry(): THREE.BufferGeometry {
  const geo = new THREE.DodecahedronGeometry(0.085, 0);
  geo.scale(1.0, 0.62, 1.38);
  geo.translate(0, 0.052, 0);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds a low-poly multi-segment spider silhouette with `aLegPhase` attribute for GPU scuttle.
 */
function buildSpiderGeometry(): THREE.BufferGeometry {
  // Abdomen + cephalothorax + 4 crossed leg pairs in one tiny BufferGeometry
  const positions: number[] = [];
  const normals: number[] = [];
  const legPhase: number[] = [];
  const indices: number[] = [];

  const pushBox = (
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    phase: number,
  ) => {
    const base = positions.length / 3;
    const verts = [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ];
    for (let i = 0; i < 8; i++) {
      positions.push(verts[i][0], verts[i][1], verts[i][2]);
      normals.push(0, 1, 0);
      legPhase.push(phase);
    }
    const faces = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ];
    for (let i = 0; i < faces.length; i++) indices.push(base + faces[i]);
  };

  // Abdomen & head
  pushBox(0, 0.022, -0.028, 0.022, 0.016, 0.028, 0);
  pushBox(0, 0.018, 0.014, 0.015, 0.012, 0.016, 0);
  // 4 pairs of scuttling legs (alternating phase sign)
  for (let i = 0; i < 4; i++) {
    const zOff = -0.018 + i * 0.014;
    const ph = i % 2 === 0 ? 1.0 : -1.0;
    pushBox(-0.042, 0.011, zOff, 0.03, 0.004, 0.004, ph);
    pushBox(0.042, 0.011, zOff, 0.03, 0.004, 0.004, -ph);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aLegPhase', new THREE.Float32BufferAttribute(legPhase, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Builds a tiny segmented woodland ant silhouette with GPU leg scuttle attribute.
 */
function buildAntGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const legPhase: number[] = [];
  const indices: number[] = [];

  const pushBox = (
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    phase: number,
  ) => {
    const base = positions.length / 3;
    const verts = [
      [cx - hx, cy - hy, cz - hz],
      [cx + hx, cy - hy, cz - hz],
      [cx + hx, cy + hy, cz - hz],
      [cx - hx, cy + hy, cz - hz],
      [cx - hx, cy - hy, cz + hz],
      [cx + hx, cy - hy, cz + hz],
      [cx + hx, cy + hy, cz + hz],
      [cx - hx, cy + hy, cz + hz],
    ];
    for (let i = 0; i < 8; i++) {
      positions.push(verts[i][0], verts[i][1], verts[i][2]);
      normals.push(0, 1, 0);
      legPhase.push(phase);
    }
    const faces = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ];
    for (let i = 0; i < faces.length; i++) indices.push(base + faces[i]);
  };

  // Gaster, thorax, head
  pushBox(0, 0.011, -0.022, 0.01, 0.008, 0.014, 0);
  pushBox(0, 0.01, 0.0, 0.007, 0.006, 0.01, 0);
  pushBox(0, 0.011, 0.018, 0.008, 0.007, 0.009, 0);
  // 3 pairs of legs
  for (let i = 0; i < 3; i++) {
    const zOff = -0.008 + i * 0.008;
    const ph = i % 2 === 0 ? 1.0 : -1.0;
    pushBox(-0.018, 0.006, zOff, 0.012, 0.003, 0.003, ph);
    pushBox(0.018, 0.006, zOff, 0.012, 0.003, 0.003, -ph);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aLegPhase', new THREE.Float32BufferAttribute(legPhase, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Three-Tier Living Fauna & Micro-Fauna Simulation Manager:
 * - Tier 1 (Articulated Composite Meshes): Rare Wolf Packs (hunt deer often, rival packs
 *   occasionally, operators rarely via 90° FOV flanking ring) & Deer Herds (organic alarm).
 * - Tier 2 (GPU Instanced Hop/Drift): Physical Marsh/River Frogs (diegetic croaks + 4m water hop)
 *   & Daytime Butterflies (GPU vertex-shader wing flap + sprint/bullet scatter).
 * - Tier 3 (12m Boot-Bubble Walkers): Spiders & Ants with GPU leg scuttle + Boot Squish mechanic
 *   (< 0.22m footstep crunch, splat decal ring buffer & boot grime).
 * - Budgeted well under <= 0.5ms/frame CPU overhead with zero per-frame allocations.
 */
export class WildlifeManager {
  public readonly rootGroup = new THREE.Group();
  /** Live wolf and deer hitbox meshes for `OpenWorldBodycamAdapter.raycast` */
  public readonly hitMeshes: THREE.Object3D[] = [];

  private readonly scene: THREE.Scene;
  private readonly sampleGroundHeight: (x: number, z: number) => number;
  private readonly ambienceAudio: OpenWorldAmbienceAudio;
  private readonly isSoftwareGl: boolean;

  // Macro-fauna state
  private readonly wolfPacks: WolfPackBlackboard[] = [];
  private readonly deerHerds: DeerHerdBlackboard[] = [];
  private readonly entitiesById = new Map<string, { kind: 'wolf'; entity: WolfEntity; pack: WolfPackBlackboard } | { kind: 'deer'; entity: DeerEntity; herd: DeerHerdBlackboard }>();
  private nextEntitySeq = 1;
  private spawnCheckAccum = 0;
  private microFaunaAccum = 0;

  // Shared macro-fauna geometries & materials
  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];
  private readonly wolfAlphaMat: THREE.MeshStandardMaterial;
  private readonly wolfBetaMat: THREE.MeshStandardMaterial;
  private readonly wolfDarkMat: THREE.MeshStandardMaterial;
  private readonly wolfEyeMat: THREE.MeshStandardMaterial;
  private readonly deerCoatMat: THREE.MeshStandardMaterial;
  private readonly deerBellyMat: THREE.MeshStandardMaterial;
  private readonly deerAntlerMat: THREE.MeshStandardMaterial;
  private readonly hitboxMat: THREE.MeshBasicMaterial;

  // Micro-fauna GPU instanced pools
  private readonly frogMesh: THREE.InstancedMesh;
  private readonly frogs: FrogInstanceState[] = [];
  private readonly butterflyMesh: THREE.InstancedMesh;
  private readonly butterflies: ButterflyInstanceState[] = [];
  private readonly butterflyTimeUniform = { value: 0 };
  private readonly spiderMesh: THREE.InstancedMesh;
  private readonly spiders: InsectInstanceState[] = [];
  private readonly antMesh: THREE.InstancedMesh;
  private readonly ants: InsectInstanceState[] = [];
  private readonly insectTimeUniform = { value: 0 };
  private readonly splatMesh: THREE.InstancedMesh;
  private splatWriteCursor = 0;
  private splatCount = 0;

  // Boot squish & unseen-spawn audit tracking
  private totalSquishedInsects = 0;
  private bootGrime01 = 0;
  private frogRepopAccum = 0;
  private butterflyRepopAccum = 0;
  private insectRepopAccum = 0;
  private readonly recentDynamicSpawns: DynamicSpawnAuditEntry[] = [];
  private readonly antTrailCenters: Array<{
    x: number;
    z: number;
    active: boolean;
    habitat: 'wilderness' | 'building';
  }> = [
    { x: 0, z: 0, active: false, habitat: 'wilderness' },
    { x: 0, z: 0, active: false, habitat: 'wilderness' },
  ];

  constructor(
    scene: THREE.Scene,
    sampleGroundHeight: (x: number, z: number) => number,
    ambienceAudio: OpenWorldAmbienceAudio,
    isSoftwareGl = false,
  ) {
    this.scene = scene;
    this.sampleGroundHeight = sampleGroundHeight;
    this.ambienceAudio = ambienceAudio;
    this.isSoftwareGl = isSoftwareGl;
    this.rootGroup.name = 'openworld_wildlife_root';

    // Shared PBR fauna materials (varied roughness, organic desaturated palettes, strict FrontSide backface culling)
    this.wolfAlphaMat = new THREE.MeshStandardMaterial({
      color: 0x3a3d40,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.wolfBetaMat = new THREE.MeshStandardMaterial({
      color: 0x565a5e,
      roughness: 0.9,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.wolfDarkMat = new THREE.MeshStandardMaterial({
      color: 0x222427,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.wolfEyeMat = new THREE.MeshStandardMaterial({
      color: 0xe6b84c,
      emissive: 0x8f6b18,
      emissiveIntensity: 0.75,
      roughness: 0.25,
      metalness: 0.1,
      side: THREE.FrontSide,
    });
    this.deerCoatMat = new THREE.MeshStandardMaterial({
      color: 0x7c5c3e,
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.deerBellyMat = new THREE.MeshStandardMaterial({
      color: 0xd4cab8,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.FrontSide,
    });
    this.deerAntlerMat = new THREE.MeshStandardMaterial({
      color: 0xb8ad98,
      roughness: 0.72,
      metalness: 0.04,
      side: THREE.FrontSide,
    });
    this.hitboxMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.FrontSide });
    this.sharedMats.push(
      this.wolfAlphaMat,
      this.wolfBetaMat,
      this.wolfDarkMat,
      this.wolfEyeMat,
      this.deerCoatMat,
      this.deerBellyMat,
      this.deerAntlerMat,
      this.hitboxMat,
    );

    // 1. Frogs InstancedMesh
    const frogGeo = buildFrogGeometry();
    const frogMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.05,
      side: THREE.FrontSide,
    });
    this.sharedGeos.push(frogGeo);
    this.sharedMats.push(frogMat);
    this.frogMesh = new THREE.InstancedMesh(frogGeo, frogMat, FROG_POOL_SIZE);
    this.frogMesh.frustumCulled = false;
    this.frogMesh.count = 0;
    this.rootGroup.add(this.frogMesh);
    for (let i = 0; i < FROG_POOL_SIZE; i++) {
      this.frogs.push({
        active: false,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        hopProgress: 0,
        hopStartX: 0,
        hopStartY: 0,
        hopStartZ: 0,
        hopEndX: 0,
        hopEndY: 0,
        hopEndZ: 0,
        submergedTimer: 0,
        croakCooldown: 2 + Math.random() * 8,
        pitchScale: 0.84 + Math.random() * 0.34,
        spawnBlend: 1,
      });
    }

    // 2. Butterflies InstancedMesh (GPU vertex shader hinged wing flap)
    const bflyGeo = buildButterflyWingGeometry();
    const bflyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.65,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const bflyTimeU = this.butterflyTimeUniform;
    bflyMat.customProgramCacheKey = () => 'axon_butterfly_flap_v1';
    bflyMat.onBeforeCompile = (shader) => {
      shader.uniforms.uBflyTime = bflyTimeU;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uBflyTime;
          attribute float aWingSide;
          `,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float instSeed = 0.0;
          #ifdef USE_INSTANCING
            instSeed = instanceMatrix[3][0] * 1.73 + instanceMatrix[3][2] * 2.11;
          #endif
          float flap = sin(uBflyTime * 15.5 + instSeed) * 0.92;
          float cF = cos(flap * abs(aWingSide));
          float sF = sin(flap * abs(aWingSide));
          float wx = transformed.x;
          float wy = transformed.y;
          transformed.x = wx * cF - wy * sF * sign(aWingSide);
          transformed.y = abs(wx) * sF + wy * cF;
          `,
        );
    };
    this.sharedGeos.push(bflyGeo);
    this.sharedMats.push(bflyMat);
    this.butterflyMesh = new THREE.InstancedMesh(bflyGeo, bflyMat, BUTTERFLY_POOL_SIZE);
    this.butterflyMesh.frustumCulled = false;
    this.butterflyMesh.count = 0;
    this.rootGroup.add(this.butterflyMesh);
    for (let i = 0; i < BUTTERFLY_POOL_SIZE; i++) {
      this.butterflies.push({
        active: false,
        anchorX: 0,
        anchorY: 0,
        anchorZ: 0,
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        phase: Math.random() * Math.PI * 2,
        freqA: 0.45 + Math.random() * 0.4,
        freqB: 0.72 + Math.random() * 0.45,
        scatterVy: 0,
        scatterTimer: 0,
        spawnBlend: 1,
      });
    }

    // 3. Spiders & Ants InstancedMeshes with GPU leg-scuttle vertex animation
    const insectTimeU = this.insectTimeUniform;
    const makeInsectMat = (hex: number, key: string) => {
      const m = new THREE.MeshStandardMaterial({
        color: hex,
        roughness: 0.52,
        metalness: 0.08,
        side: THREE.FrontSide,
      });
      m.customProgramCacheKey = () => key;
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uInsectTime = insectTimeU;
        shader.vertexShader = shader.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            uniform float uInsectTime;
            attribute float aLegPhase;
            `,
          )
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            if (abs(aLegPhase) > 0.1) {
              float seed = 0.0;
              #ifdef USE_INSTANCING
                seed = instanceMatrix[3][0] * 11.3 + instanceMatrix[3][2] * 7.9;
              #endif
              float sc = sin(uInsectTime * 24.0 + seed) * aLegPhase;
              transformed.z += sc * 0.008;
              transformed.y += max(0.0, sc) * 0.005;
            }
            `,
          );
      };
      return m;
    };

    const spiderGeo = buildSpiderGeometry();
    const spiderMat = makeInsectMat(0x28211b, 'axon_spider_scuttle_v1');
    const antGeo = buildAntGeometry();
    const antMat = makeInsectMat(0x3a2014, 'axon_ant_scuttle_v1');
    this.sharedGeos.push(spiderGeo, antGeo);
    this.sharedMats.push(spiderMat, antMat);

    this.spiderMesh = new THREE.InstancedMesh(spiderGeo, spiderMat, SPIDER_POOL_SIZE);
    this.spiderMesh.frustumCulled = false;
    this.spiderMesh.count = 0;
    this.antMesh = new THREE.InstancedMesh(antGeo, antMat, ANT_POOL_SIZE);
    this.antMesh.frustumCulled = false;
    this.antMesh.count = 0;
    this.rootGroup.add(this.spiderMesh, this.antMesh);

    for (let i = 0; i < SPIDER_POOL_SIZE; i++) {
      this.spiders.push({
        active: false,
        isSpider: true,
        habitat: 'wilderness',
        x: 0,
        y: 0,
        z: 0,
        yaw: Math.random() * Math.PI * 2,
        speed: 0.24 + Math.random() * 0.28,
        turnTimer: 1 + Math.random() * 3,
        trailCenterX: 0,
        trailCenterZ: 0,
        trailAngle: 0,
        squishedTimer: 0,
        spawnBlend: 1,
      });
    }
    for (let i = 0; i < ANT_POOL_SIZE; i++) {
      this.ants.push({
        active: false,
        isSpider: false,
        habitat: 'wilderness',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        speed: 0.16 + Math.random() * 0.14,
        turnTimer: 0,
        trailCenterX: 0,
        trailCenterZ: 0,
        trailAngle: (i / ANT_POOL_SIZE) * Math.PI * 2,
        squishedTimer: 0,
        spawnBlend: 1,
      });
    }

    // 4. Flat Splat Decal Ring Buffer for squished insects (with polygonOffset to prevent Z-fighting)
    const splatGeo = new THREE.CircleGeometry(0.055, 7);
    splatGeo.rotateX(-Math.PI * 0.5);
    const splatMat = new THREE.MeshStandardMaterial({
      color: 0x2a241b,
      roughness: 0.45,
      metalness: 0.02,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.sharedGeos.push(splatGeo);
    this.sharedMats.push(splatMat);
    this.splatMesh = new THREE.InstancedMesh(splatGeo, splatMat, SPLAT_POOL_SIZE);
    this.splatMesh.frustumCulled = false;
    this.splatMesh.count = 0;
    this.rootGroup.add(this.splatMesh);

    scene.add(this.rootGroup);
  }

  // ============================================================================
  // COMPOSITE ARTICULATED RIG BUILDERS (WOLVES & DEER)
  // ============================================================================

  private createWolfRig(entityId: string, isAlpha: boolean): WolfRigParts {
    const root = new THREE.Group();
    const scale = isAlpha ? 1.12 : 0.96 + Math.random() * 0.08;
    root.scale.setScalar(scale);

    const coatMat = isAlpha ? this.wolfAlphaMat : this.wolfBetaMat;
    const bodyPivot = new THREE.Group();
    bodyPivot.position.y = 0.62;
    root.add(bodyPivot);

    // 1. Torso + shoulder chest ruff
    const torsoGeo = new THREE.BoxGeometry(0.34, 0.34, 0.92);
    const torso = new THREE.Mesh(torsoGeo, coatMat);
    torso.castShadow = !this.isSoftwareGl;
    torso.receiveShadow = !this.isSoftwareGl;
    bodyPivot.add(torso);

    const ruffGeo = new THREE.BoxGeometry(0.4, 0.38, 0.36);
    const ruff = new THREE.Mesh(ruffGeo, this.wolfDarkMat);
    ruff.position.set(0, 0.02, 0.3);
    ruff.castShadow = !this.isSoftwareGl;
    bodyPivot.add(ruff);

    // 2. Articulated Neck + Head + Snout + Lower Jaw + Ears + Eyes
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 0.14, 0.44);
    bodyPivot.add(neckPivot);

    const headGeo = new THREE.BoxGeometry(0.24, 0.22, 0.28);
    const head = new THREE.Mesh(headGeo, coatMat);
    head.position.set(0, 0.1, 0.12);
    head.castShadow = !this.isSoftwareGl;
    neckPivot.add(head);

    const snoutGeo = new THREE.BoxGeometry(0.13, 0.1, 0.22);
    const snout = new THREE.Mesh(snoutGeo, this.wolfDarkMat);
    snout.position.set(0, 0.08, 0.32);
    neckPivot.add(snout);

    const jawPivot = new THREE.Group();
    jawPivot.position.set(0, 0.03, 0.22);
    neckPivot.add(jawPivot);
    const jawGeo = new THREE.BoxGeometry(0.11, 0.05, 0.19);
    const jaw = new THREE.Mesh(jawGeo, this.wolfDarkMat);
    jaw.position.set(0, -0.02, 0.09);
    jawPivot.add(jaw);

    const earGeo = new THREE.ConeGeometry(0.055, 0.14, 4);
    const earL = new THREE.Mesh(earGeo, this.wolfDarkMat);
    earL.position.set(-0.085, 0.24, 0.08);
    const earR = new THREE.Mesh(earGeo, this.wolfDarkMat);
    earR.position.set(0.085, 0.24, 0.08);
    neckPivot.add(earL, earR);

    const eyeGeo = new THREE.BoxGeometry(0.035, 0.025, 0.02);
    const eyeL = new THREE.Mesh(eyeGeo, this.wolfEyeMat);
    eyeL.position.set(-0.075, 0.13, 0.26);
    const eyeR = new THREE.Mesh(eyeGeo, this.wolfEyeMat);
    eyeR.position.set(0.075, 0.13, 0.26);
    neckPivot.add(eyeL, eyeR);

    // 3. Bushy Tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.04, -0.45);
    bodyPivot.add(tailPivot);
    const tailGeo = new THREE.BoxGeometry(0.11, 0.11, 0.48);
    const tail = new THREE.Mesh(tailGeo, this.wolfDarkMat);
    tail.position.set(0, -0.08, -0.22);
    tail.rotation.x = -0.35;
    tailPivot.add(tail);

    // 4. Four Articulated Legs (top-pivoted for procedural 4-leg gait)
    const legGeo = new THREE.BoxGeometry(0.1, 0.56, 0.11);
    legGeo.translate(0, -0.28, 0);
    const legFL = new THREE.Mesh(legGeo, coatMat);
    legFL.position.set(-0.13, -0.06, 0.32);
    const legFR = new THREE.Mesh(legGeo, coatMat);
    legFR.position.set(0.13, -0.06, 0.32);
    const legBL = new THREE.Mesh(legGeo, coatMat);
    legBL.position.set(-0.13, -0.06, -0.32);
    const legBR = new THREE.Mesh(legGeo, coatMat);
    legBR.position.set(0.13, -0.06, -0.32);
    bodyPivot.add(legFL, legFR, legBL, legBR);

    // 5. Raycast Hitbox Proxy
    const hitboxGeo = new THREE.BoxGeometry(0.56, 0.72, 1.32);
    const hitbox = new THREE.Mesh(hitboxGeo, this.hitboxMat);
    hitbox.position.set(0, 0.04, 0.06);
    hitbox.userData.openWorldWildlifeId = entityId;
    bodyPivot.add(hitbox);

    this.sharedGeos.push(torsoGeo, ruffGeo, headGeo, snoutGeo, jawGeo, earGeo, eyeGeo, tailGeo, legGeo, hitboxGeo);

    return { root, bodyPivot, neckPivot, jawPivot, tailPivot, legFL, legFR, legBL, legBR, hitbox };
  }

  private createDeerRig(entityId: string, isBuck: boolean): DeerRigParts {
    const root = new THREE.Group();
    const scale = isBuck ? 1.08 : 0.94 + Math.random() * 0.08;
    root.scale.setScalar(scale);

    const bodyPivot = new THREE.Group();
    bodyPivot.position.y = 0.94;
    root.add(bodyPivot);

    // 1. Torso & Pale Belly
    const torsoGeo = new THREE.BoxGeometry(0.42, 0.44, 1.18);
    const torso = new THREE.Mesh(torsoGeo, this.deerCoatMat);
    torso.castShadow = !this.isSoftwareGl;
    torso.receiveShadow = !this.isSoftwareGl;
    bodyPivot.add(torso);

    const bellyGeo = new THREE.BoxGeometry(0.36, 0.14, 0.96);
    const belly = new THREE.Mesh(bellyGeo, this.deerBellyMat);
    belly.position.set(0, -0.19, 0);
    bodyPivot.add(belly);

    // 2. Neck, Head, Ears & Optional Branching Antlers
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 0.16, 0.52);
    bodyPivot.add(neckPivot);

    const neckGeo = new THREE.BoxGeometry(0.19, 0.46, 0.22);
    const neck = new THREE.Mesh(neckGeo, this.deerCoatMat);
    neck.position.set(0, 0.22, 0.06);
    neck.rotation.x = 0.28;
    neckPivot.add(neck);

    const headGeo = new THREE.BoxGeometry(0.2, 0.2, 0.34);
    const head = new THREE.Mesh(headGeo, this.deerCoatMat);
    head.position.set(0, 0.44, 0.24);
    neckPivot.add(head);

    const earGeo = new THREE.BoxGeometry(0.045, 0.16, 0.08);
    const earL = new THREE.Mesh(earGeo, this.deerCoatMat);
    earL.position.set(-0.12, 0.56, 0.12);
    earL.rotation.z = 0.45;
    const earR = new THREE.Mesh(earGeo, this.deerCoatMat);
    earR.position.set(0.12, 0.56, 0.12);
    earR.rotation.z = -0.45;
    neckPivot.add(earL, earR);

    if (isBuck) {
      const antlerMainGeo = new THREE.CylinderGeometry(0.016, 0.025, 0.48, 5);
      const antlerTineGeo = new THREE.CylinderGeometry(0.01, 0.016, 0.24, 4);
      for (const side of [-1, 1]) {
        const beam = new THREE.Mesh(antlerMainGeo, this.deerAntlerMat);
        beam.position.set(side * 0.12, 0.72, 0.15);
        beam.rotation.z = -side * 0.48;
        beam.rotation.x = -0.2;
        neckPivot.add(beam);

        const tine = new THREE.Mesh(antlerTineGeo, this.deerAntlerMat);
        tine.position.set(side * 0.22, 0.84, 0.2);
        tine.rotation.x = 0.45;
        neckPivot.add(tine);
      }
      this.sharedGeos.push(antlerMainGeo, antlerTineGeo);
    }

    // 3. White Flagging Tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.08, -0.58);
    bodyPivot.add(tailPivot);
    const tailGeo = new THREE.BoxGeometry(0.12, 0.24, 0.08);
    const tail = new THREE.Mesh(tailGeo, this.deerBellyMat);
    tail.position.set(0, -0.1, -0.04);
    tailPivot.add(tail);

    // 4. Slender Articulated Legs
    const legGeo = new THREE.BoxGeometry(0.09, 0.86, 0.1);
    legGeo.translate(0, -0.43, 0);
    const legFL = new THREE.Mesh(legGeo, this.deerCoatMat);
    legFL.position.set(-0.14, -0.08, 0.44);
    const legFR = new THREE.Mesh(legGeo, this.deerCoatMat);
    legFR.position.set(0.14, -0.08, 0.44);
    const legBL = new THREE.Mesh(legGeo, this.deerCoatMat);
    legBL.position.set(-0.14, -0.08, -0.44);
    const legBR = new THREE.Mesh(legGeo, this.deerCoatMat);
    legBR.position.set(0.14, -0.08, -0.44);
    bodyPivot.add(legFL, legFR, legBL, legBR);

    // 5. Raycast Hitbox Proxy
    const hitboxGeo = new THREE.BoxGeometry(0.66, 0.95, 1.55);
    const hitbox = new THREE.Mesh(hitboxGeo, this.hitboxMat);
    hitbox.position.set(0, 0.12, 0.08);
    hitbox.userData.openWorldWildlifeId = entityId;
    bodyPivot.add(hitbox);

    this.sharedGeos.push(torsoGeo, bellyGeo, neckGeo, headGeo, earGeo, tailGeo, legGeo, hitboxGeo);

    return { root, bodyPivot, neckPivot, earL, earR, tailPivot, legFL, legFR, legBL, legBR, hitbox };
  }

  // ============================================================================
  // PUBLIC BALLISTIC, FOOTSTEP & INTERACTION HOOKS
  // ============================================================================

  public isEntityAlive(entityId: string): boolean {
    const rec = this.entitiesById.get(entityId);
    return Boolean(rec && rec.entity.alive);
  }

  /**
   * Damages a wolf or deer struck by player gunfire or grenade shrapnel.
   */
  public applyDamageToEntity(
    entityId: string,
    damage: number,
    attackerX: number,
    attackerZ: number,
  ): { hit: boolean; killed: boolean; species: 'wolf' | 'deer' } | null {
    const rec = this.entitiesById.get(entityId);
    if (!rec || !rec.entity.alive) return null;

    rec.entity.hp = Math.max(0, rec.entity.hp - Math.max(1, damage));
    const killed = rec.entity.hp <= 0;

    if (rec.kind === 'wolf') {
      const pack = rec.pack;
      if (killed) {
        rec.entity.alive = false;
        rec.entity.rig.hitbox.visible = false;
        pack.fearScore += 0.65;
        this.ambienceAudio.playWolfSnarl(rec.entity.x, rec.entity.y + 0.6, rec.entity.z);
        // Pack flees if Alpha falls or casualties mount
        if (rec.entity.isAlpha || pack.fearScore >= 1.2) {
          this.triggerPackFlee(pack, attackerX, attackerZ);
        }
      } else {
        // Wounded wolf either rallies defensively or scatters
        this.ambienceAudio.playWolfSnarl(rec.entity.x, rec.entity.y + 0.6, rec.entity.z);
        if (pack.members.filter((m) => m.alive).length >= 3 && pack.fearScore < 0.8) {
          pack.state = 'ENCIRCLE';
          pack.stateTimer = 14;
          pack.aggroScore = Math.max(pack.aggroScore, 1.0);
        } else {
          this.triggerPackFlee(pack, attackerX, attackerZ);
        }
      }
      return { hit: true, killed, species: 'wolf' };
    }

    // Deer hit
    const herd = rec.herd;
    if (killed) {
      rec.entity.alive = false;
      rec.entity.rig.hitbox.visible = false;
    }
    this.triggerDeerHerdBolt(herd, attackerX, attackerZ);
    return { hit: true, killed, species: 'deer' };
  }

  /**
   * Ballistic shockwave hook (gunshots & explosions):
   * - Startles deer herds within 120m into bolting
   * - Scatters butterflies upward
   * - Either scatters or draws cautious wolf pack interest depending on distance & pack size
   */
  public onBallisticImpulse(originX: number, originZ: number, decibels: number): void {
    const radius = decibels >= 145 ? 125 : 80;

    // 1. Bolt deer herds (organic tactical alarm across valleys!)
    for (let i = 0; i < this.deerHerds.length; i++) {
      const herd = this.deerHerds[i];
      const leader = herd.members.find((m) => m.alive);
      if (!leader) continue;
      if (Math.hypot(leader.x - originX, leader.z - originZ) <= radius) {
        this.triggerDeerHerdBolt(herd, originX, originZ);
      }
    }

    // 2. Wolf packs react based on distance & pack size
    for (let i = 0; i < this.wolfPacks.length; i++) {
      const pack = this.wolfPacks[i];
      const aliveMembers = pack.members.filter((m) => m.alive);
      if (aliveMembers.length === 0) continue;
      const anchor = aliveMembers[0];
      const dist = Math.hypot(anchor.x - originX, anchor.z - originZ);
      if (dist > radius) continue;

      if (dist < 42 || decibels >= 158 || aliveMembers.length <= 2) {
        pack.fearScore += 1.0;
        this.triggerPackFlee(pack, originX, originZ);
      } else if (pack.state === 'PATROL' && Math.random() < 0.35) {
        // Distant gunfire may make a bold pack investigate cautiously from afar
        pack.patrolX = anchor.x + (originX - anchor.x) * 0.45;
        pack.patrolZ = anchor.z + (originZ - anchor.z) * 0.45;
        pack.state = 'STALK';
        pack.stateTimer = 10;
      }
    }

    // 3. Disperse nearby butterflies upward
    this.notifyBulletPass(originX, originZ, 24);
  }

  /**
   * Flushes daytime butterflies sharply upward if a bullet passes nearby.
   */
  public notifyBulletPass(worldX: number, worldZ: number, radiusM = 8.0): void {
    const rSq = radiusM * radiusM;
    for (let i = 0; i < this.butterflies.length; i++) {
      const b = this.butterflies[i];
      if (!b.active) continue;
      const dx = b.x - worldX;
      const dz = b.z - worldZ;
      if (dx * dx + dz * dz <= rSq) {
        b.scatterVy = 2.6 + Math.random() * 1.8;
        b.scatterTimer = 2.4;
      }
    }
  }

  /**
   * Boot Squish Mechanic bound directly to first-person footstep contact events:
   * Checks `distanceXZ(footPos, insectPos) < 0.22m` across spiders and ants,
   * triggers subtle crunch audio, collapses the instance, stamps a flat splat decal,
   * and applies subtle boot-sole grime.
   */
  public handlePlayerFootstep(footX: number, footY: number, footZ: number): InsectSquishResult {
    let squished = 0;
    let spidersSq = 0;
    let antsSq = 0;
    const squishRadSq = 0.22 * 0.22;

    const checkList = (list: InsectInstanceState[]) => {
      for (let i = 0; i < list.length; i++) {
        const ins = list[i];
        if (!ins.active || ins.squishedTimer > 0) continue;
        const dx = ins.x - footX;
        const dz = ins.z - footZ;
        if (dx * dx + dz * dz <= squishRadSq) {
          ins.squishedTimer = 16.0;
          ins.active = false;
          squished++;
          if (ins.isSpider) spidersSq++;
          else antsSq++;
          this.stampSplatDecal(ins.x, ins.y, ins.z, ins.isSpider ? 1.2 : 0.72);
          this.ambienceAudio.playInsectSquish(ins.x, ins.y, ins.z, ins.isSpider);
        }
      }
    };

    checkList(this.spiders);
    checkList(this.ants);

    if (squished > 0) {
      this.totalSquishedInsects += squished;
      this.bootGrime01 = Math.min(1, this.bootGrime01 + squished * 0.14);
    } else if (this.bootGrime01 > 0) {
      // Walking naturally rubs off tiny boot-sole grime over subsequent steps
      this.bootGrime01 = Math.max(0, this.bootGrime01 - 0.025);
    }

    return {
      squishedCount: squished,
      spidersSquished: spidersSq,
      antsSquished: antsSq,
      bootGrime01: this.bootGrime01,
    };
  }

  private stampSplatDecal(x: number, y: number, z: number, scale: number): void {
    _dummy.position.set(x, y + 0.014, z);
    _dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
    _dummy.scale.set(scale, 1, scale * (0.8 + Math.random() * 0.4));
    _dummy.updateMatrix();
    this.splatMesh.setMatrixAt(this.splatWriteCursor, _dummy.matrix);
    this.splatWriteCursor = (this.splatWriteCursor + 1) % SPLAT_POOL_SIZE;
    this.splatCount = Math.min(SPLAT_POOL_SIZE, this.splatCount + 1);
    this.splatMesh.count = this.splatCount;
    this.splatMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Finds the nearest downed, unharvested wolf or deer carcass within 3.4m for `[F]` Field-Dressing.
   */
  public findNearestHarvestableCarcass(px: number, pz: number): WildlifeHarvestPrompt | null {
    let best: WildlifeHarvestPrompt | null = null;
    let bestDist = 3.4;

    for (const rec of this.entitiesById.values()) {
      const e = rec.entity;
      if (e.alive || e.harvested) continue;
      const d = Math.hypot(e.x - px, e.z - pz);
      if (d < bestDist) {
        bestDist = d;
        const isWolf = rec.kind === 'wolf';
        const value = isWolf ? (rec.entity.isAlpha ? 520 : 400) : 340;
        best = {
          entityId: e.id,
          species: rec.kind,
          label: isWolf
            ? rec.entity.isAlpha
              ? 'Field-Dress Alpha Timber Wolf'
              : 'Field-Dress Timber Wolf'
            : 'Field-Dress Forest Deer',
          sublabel: isWolf
            ? `Harvest Pelt + Meat (+$${value} FOB Bounty)`
            : `Harvest Hide + Venison (+$${value} FOB Bounty)`,
          distanceM: d,
          cashValueUsd: value,
        };
      }
    }
    return best;
  }

  /**
   * Executes `[F]` Field Harvesting on a downed wolf or deer carcass.
   */
  public harvestCarcass(entityId: string): WildlifeHarvestResult | null {
    const rec = this.entitiesById.get(entityId);
    if (!rec || rec.entity.alive || rec.entity.harvested) return null;

    rec.entity.harvested = true;
    rec.entity.rig.root.visible = false;
    this.ambienceAudio.playFieldHarvest(rec.entity.x, rec.entity.y + 0.3, rec.entity.z);

    if (rec.kind === 'wolf') {
      const isAlpha = rec.entity.isAlpha;
      const cashUsd = isAlpha ? 520 : 400;
      return {
        entityId,
        species: 'wolf',
        pelts: 1,
        meatKg: isAlpha ? 6 : 4,
        cashUsd,
        supplyMedicalOrRations: isAlpha ? 5 : 3,
        summaryLabel: isAlpha
          ? `Harvested Alpha Wolf Pelt & Meat (+$${cashUsd})`
          : `Harvested Timber Wolf Pelt & Meat (+$${cashUsd})`,
      };
    }

    return {
      entityId,
      species: 'deer',
      pelts: 1,
      meatKg: 9,
      cashUsd: 340,
      supplyMedicalOrRations: 4,
      summaryLabel: 'Harvested Deer Hide & Venison (+$340)',
    };
  }

  // ============================================================================
  // MAIN PER-FRAME ECOSYSTEM UPDATE (<= 0.5ms BUDGET)
  // ============================================================================

  private animFrameTick = 0;

  public update(ctx: WildlifeUpdateContext): void {
    const dt = Math.min(0.05, Math.max(0.001, ctx.dt));
    this.animFrameTick = (this.animFrameTick + 1) & 0x7fffffff;
    this.butterflyTimeUniform.value = ctx.elapsedSec;
    this.insectTimeUniform.value = ctx.elapsedSec;

    // 1. Periodic ecological spawner / despawner around player (~1.2 Hz)
    this.spawnCheckAccum += dt;
    if (this.spawnCheckAccum >= 0.85) {
      this.spawnCheckAccum = 0;
      this.maintainMacroFaunaPopulation(ctx);
    }

    // 2. Step Deer Herds first so Wolves can actively hunt live deer positions
    this.updateDeerHerds(dt, ctx);

    // 3. Step Wolf Packs (Patrol, Hunt Deer, Rival Pack Fights, Rare Operator Encircle/Lunge)
    this.updateWolfPacks(dt, ctx);

    // 4-6. Step micro-fauna (frogs, butterflies, spiders & ants) at 20Hz outside concrete FOB compounds
    this.microFaunaAccum += dt;
    if (this.microFaunaAccum >= 0.05) {
      const microDt = Math.min(0.1, this.microFaunaAccum);
      this.microFaunaAccum = 0;
      if (isInsideFobCompound(ctx.playerX, ctx.playerZ)) {
        this.frogMesh.count = 0;
        this.butterflyMesh.count = 0;
        this.spiderMesh.count = 0;
        this.antMesh.count = 0;
      } else {
        this.updateFrogs(microDt, ctx);
        this.updateButterflies(microDt, ctx);
        this.updateInsects(microDt, ctx);
      }
    }
  }

  /**
   * Computes normalized dot product against the player's horizontal camera look vector
   * (`fwd = (-sin(yaw), -cos(yaw))` in Three.js YXZ convention).
   */
  private computePlayerForwardDot(
    wx: number,
    wz: number,
    ctx: Pick<WildlifeUpdateContext, 'playerX' | 'playerZ' | 'playerYawRad'>,
  ): number {
    const dx = wx - ctx.playerX;
    const dz = wz - ctx.playerZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return 1;
    const fwdX = -Math.sin(ctx.playerYawRad);
    const fwdZ = -Math.cos(ctx.playerYawRad);
    return (dx * fwdX + dz * fwdZ) / dist;
  }

  /**
   * Checks whether a terrain hill/ridge physically blocks the line of sight between the
   * operator's eye and a candidate spawn point.
   */
  private isTerrainOccludedFromPlayer(
    wx: number,
    wy: number,
    wz: number,
    ctx: Pick<WildlifeUpdateContext, 'playerX' | 'playerY' | 'playerZ'>,
    entityHeightM: number,
  ): boolean {
    const eyeY = ctx.playerY + 1.68;
    const targetTopY = wy + entityHeightM + 0.35;
    const steps = 7;
    for (let s = 1; s <= steps; s++) {
      const t = 0.14 + (s / (steps + 1)) * 0.74;
      const sx = ctx.playerX + (wx - ctx.playerX) * t;
      const sz = ctx.playerZ + (wz - ctx.playerZ) * t;
      const losY = eyeY + (targetTopY - eyeY) * t;
      const groundH = this.sampleGroundHeight(sx, sz);
      if (groundH > losY + 1.6) {
        return true;
      }
    }
    return false;
  }

  /**
   * Unseen-Spawn Visibility Gate:
   * Returns `true` ONLY when `(wx, wy, wz)` is guaranteed unseen by the player:
   * - Never within 6m of the operator.
   * - Strictly outside the ultra-wide bodycam forward FOV (`dotForward <= -0.22`, i.e. >102° off-axis, behind shoulders), OR
   * - For distant macro-fauna (`>= 140m`) only, physically occluded behind a terrain ridge (`>= 1.6m` crest).
   */
  public isHiddenFromPlayerView(
    wx: number,
    wy: number,
    wz: number,
    ctx: Pick<WildlifeUpdateContext, 'playerX' | 'playerY' | 'playerZ' | 'playerYawRad'>,
    entityHeightM = 1.0,
    allowTerrainOcclusion = false,
  ): boolean {
    const dist = Math.hypot(wx - ctx.playerX, wz - ctx.playerZ);
    if (dist < 6.0) return false;

    const dotForward = this.computePlayerForwardDot(wx, wz, ctx);
    if (dotForward <= HIDDEN_REAR_DOT_MAX) {
      return true;
    }
    if (allowTerrainOcclusion && dist >= 140.0) {
      return this.isTerrainOccludedFromPlayer(wx, wy, wz, ctx, entityHeightM);
    }
    return false;
  }

  /**
   * Samples a world-space polar angle strictly inside the player's rear blind-spot arc
   * (centered directly behind camera look direction ± 65° -> always `dotForward <= -0.42`).
   */
  private sampleRearBlindSpotAngle(playerYawRad: number): number {
    // Camera forward is (-sin(yaw), -cos(yaw)); rear direction is (+sin(yaw), +cos(yaw))
    const rearAngle = Math.atan2(Math.cos(playerYawRad), Math.sin(playerYawRad));
    const spreadRad = (Math.random() - 0.5) * (Math.PI * 0.72); // ±64.8° around straight behind
    return rearAngle + spreadRad;
  }

  private recordDynamicSpawn(
    kind: DynamicSpawnAuditEntry['kind'],
    wx: number,
    wy: number,
    wz: number,
    ctx: Pick<WildlifeUpdateContext, 'playerX' | 'playerY' | 'playerZ' | 'playerYawRad'>,
    entityHeightM: number,
  ): void {
    const dist = Math.hypot(wx - ctx.playerX, wz - ctx.playerZ);
    const dotForward = this.computePlayerForwardDot(wx, wz, ctx);
    const terrainOccluded =
      dotForward > HIDDEN_REAR_DOT_MAX
        ? this.isTerrainOccludedFromPlayer(wx, wy, wz, ctx, entityHeightM)
        : false;
    this.recentDynamicSpawns.push({
      kind,
      x: wx,
      y: wy,
      z: wz,
      distFromPlayerM: dist,
      dotForward,
      terrainOccluded,
    });
    if (this.recentDynamicSpawns.length > 96) {
      this.recentDynamicSpawns.shift();
    }
  }

  private maintainMacroFaunaPopulation(ctx: WildlifeUpdateContext): void {
    // Despawn only when far beyond visual horizon/fog (or already harvested and behind/far)
    for (let i = this.wolfPacks.length - 1; i >= 0; i--) {
      const pack = this.wolfPacks[i];
      const ref = pack.members[0];
      const allGone = pack.members.every((m) => !m.alive && m.harvested);
      const dist = ref ? Math.hypot(ref.x - ctx.playerX, ref.z - ctx.playerZ) : 999;
      if (allGone || dist > WOLF_DESPAWN_DIST_M) {
        this.despawnWolfPack(i);
      }
    }
    for (let i = this.deerHerds.length - 1; i >= 0; i--) {
      const herd = this.deerHerds[i];
      const ref = herd.members[0];
      const allGone = herd.members.every((m) => !m.alive && m.harvested);
      const dist = ref ? Math.hypot(ref.x - ctx.playerX, ref.z - ctx.playerZ) : 999;
      if (allGone || dist > DEER_DESPAWN_DIST_M) {
        this.despawnDeerHerd(i);
      }
    }

    // Rare Wolf Packs (~1 pack per 2-3 active 256m chunks, 3x spawn weight at night)
    const desiredPacks = ctx.nightFactor > 0.45 ? MAX_WOLF_PACKS : 2;
    if (this.wolfPacks.length < desiredPacks) {
      const nightSpawnChance = ctx.nightFactor > 0.45 ? 0.55 : 0.18;
      if (Math.random() <= nightSpawnChance || this.wolfPacks.length === 0) {
        this.trySpawnWolfPackNear(ctx);
      }
    }

    // Deer Herds (Conifer clearings & Highland Steppe, 2-5 deer per herd, widely dispersed)
    if (this.deerHerds.length < MAX_DEER_HERDS) {
      this.trySpawnDeerHerdNear(ctx);
    }
  }

  /**
   * Explicitly spawns a wolf pack at `(wx, wz)` (also useful for deterministic tests).
   */
  public spawnWolfPackAt(wx: number, wz: number, memberCount = 3): string {
    const packId = `wolf_pack_${this.nextEntitySeq++}`;
    const members: WolfEntity[] = [];
    const clampedCount = Math.max(2, Math.min(5, memberCount));

    const pack: WolfPackBlackboard = {
      id: packId,
      homeX: wx,
      homeZ: wz,
      patrolX: wx + (Math.random() - 0.5) * 75,
      patrolZ: wz + (Math.random() - 0.5) * 75,
      state: 'PATROL',
      stateTimer: 8 + Math.random() * 10,
      howlCooldown: 6 + Math.random() * 16,
      aggroScore: 0,
      fearScore: 0,
      targetDeerId: null,
      rivalPackId: null,
      fleeDirX: 1,
      fleeDirZ: 0,
      members,
    };

    for (let i = 0; i < clampedCount; i++) {
      const isAlpha = i === 0;
      const entityId = `wolf_${this.nextEntitySeq++}`;
      const offA = (i / clampedCount) * Math.PI * 2;
      const mx = wx + Math.cos(offA) * (isAlpha ? 0 : 5.5);
      const mz = wz + Math.sin(offA) * (isAlpha ? 0 : 5.5);
      const my = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(mx, mz));
      const rig = this.createWolfRig(entityId, isAlpha);
      rig.root.position.set(mx, my, mz);
      this.rootGroup.add(rig.root);
      this.hitMeshes.push(rig.hitbox);

      const wolf: WolfEntity = {
        id: entityId,
        packId,
        isAlpha,
        rig,
        x: mx,
        y: my,
        z: mz,
        vx: 0,
        vz: 0,
        yaw: Math.random() * Math.PI * 2,
        hp: isAlpha ? 95 : 70,
        maxHp: isAlpha ? 95 : 70,
        alive: true,
        harvested: false,
        gaitPhase: Math.random() * Math.PI * 2,
        howlTimer: 0,
        biteCooldown: 0,
        growlCooldown: 1 + Math.random() * 3,
        flankAngleOffset: isAlpha ? 0 : (i % 2 === 0 ? 1 : -1) * (1.75 + Math.floor(i / 2) * 0.55),
        lungeTimer: 0,
        deathRoll: 0,
      };
      members.push(wolf);
      this.entitiesById.set(entityId, { kind: 'wolf', entity: wolf, pack });
    }

    this.wolfPacks.push(pack);
    return packId;
  }

  /**
   * Explicitly spawns a deer herd at `(wx, wz)` (also useful for deterministic tests).
   */
  public spawnDeerHerdAt(wx: number, wz: number, memberCount = 3): string {
    const herdId = `deer_herd_${this.nextEntitySeq++}`;
    const members: DeerEntity[] = [];
    const clampedCount = Math.max(2, Math.min(5, memberCount));

    const herd: DeerHerdBlackboard = {
      id: herdId,
      homeX: wx,
      homeZ: wz,
      state: 'GRAZE',
      stateTimer: 10 + Math.random() * 14,
      boltDirX: 1,
      boltDirZ: 0,
      snortCooldown: 0,
      members,
    };

    for (let i = 0; i < clampedCount; i++) {
      const isBuck = i === 0;
      const entityId = `deer_${this.nextEntitySeq++}`;
      const offA = (i / clampedCount) * Math.PI * 2;
      const mx = wx + Math.cos(offA) * (3.8 + i * 1.9);
      const mz = wz + Math.sin(offA) * (3.8 + i * 1.9);
      const my = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(mx, mz));
      const rig = this.createDeerRig(entityId, isBuck);
      rig.root.position.set(mx, my, mz);
      this.rootGroup.add(rig.root);
      this.hitMeshes.push(rig.hitbox);

      const deer: DeerEntity = {
        id: entityId,
        herdId,
        isBuck,
        rig,
        x: mx,
        y: my,
        z: mz,
        vx: 0,
        vz: 0,
        yaw: Math.random() * Math.PI * 2,
        hp: 65,
        maxHp: 65,
        alive: true,
        harvested: false,
        gaitPhase: Math.random() * Math.PI * 2,
        earTwitchPhase: Math.random() * Math.PI * 2,
        grazeBlend: 0.8,
        hoofCooldown: 0,
        deathRoll: 0,
      };
      members.push(deer);
      this.entitiesById.set(entityId, { kind: 'deer', entity: deer, herd });
    }

    this.deerHerds.push(herd);
    return herdId;
  }

  private trySpawnWolfPackNear(ctx: WildlifeUpdateContext): void {
    const px = ctx.playerX;
    const pz = ctx.playerZ;
    for (let attempt = 0; attempt < 16; attempt++) {
      // Strongly bias behind camera blind-spot; occasionally probe distant occluded ridges
      const angle =
        attempt < 12
          ? this.sampleRearBlindSpotAngle(ctx.playerYawRad)
          : Math.random() * Math.PI * 2;
      const dist =
        WOLF_SPAWN_MIN_DIST_M +
        Math.random() * (WOLF_SPAWN_MAX_DIST_M - WOLF_SPAWN_MIN_DIST_M);
      const wx = px + Math.cos(angle) * dist;
      const wz = pz + Math.sin(angle) * dist;
      sampleOpenWorldTerrain(wx, wz, _terrain);
      if (
        _terrain.isWater ||
        _terrain.isRoad ||
        _terrain.isSitePad ||
        _terrain.slope > 0.42 ||
        isOnCivilizationClearance(wx, wz, 22)
      ) {
        continue;
      }
      // Wolves live primarily in Temperate Conifer & forest edges
      const validHabitat =
        _terrain.biome === 'temperate_conifer_valley' ||
        (_terrain.biome === 'highland_steppe_quarry' && _terrain.height < 165);
      if (!validHabitat) continue;

      // Spread out spawns: enforce wide pack-to-pack & initial deer separation
      let tooClose = false;
      for (let i = 0; i < this.wolfPacks.length; i++) {
        const ref = this.wolfPacks[i].members[0];
        if (ref && Math.hypot(ref.x - wx, ref.z - wz) < WOLF_MIN_PACK_SEPARATION_M) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      for (let i = 0; i < this.deerHerds.length; i++) {
        const ref = this.deerHerds[i].members[0];
        if (ref && Math.hypot(ref.x - wx, ref.z - wz) < WOLF_MIN_DEER_SEPARATION_M) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const wy = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(wx, wz));
      // Guarantee NO player can ever see the pack or any flanking member pop in
      if (!this.isHiddenFromPlayerView(wx, wy, wz, ctx, 1.15, true)) {
        continue;
      }
      let memberVisible = false;
      for (let k = 0; k < 4; k++) {
        const oa = (k / 4) * Math.PI * 2;
        const ox = wx + Math.cos(oa) * 6.0;
        const oz = wz + Math.sin(oa) * 6.0;
        const oy = this.sampleGroundHeight(ox, oz);
        if (!this.isHiddenFromPlayerView(ox, oy, oz, ctx, 1.15, true)) {
          memberVisible = true;
          break;
        }
      }
      if (memberVisible) continue;

      const size = 3 + Math.floor(Math.random() * 3); // 1 Alpha + 2..4 Betas
      this.spawnWolfPackAt(wx, wz, size);
      this.recordDynamicSpawn('wolf_pack', wx, wy, wz, ctx, 1.15);
      return;
    }
  }

  private trySpawnDeerHerdNear(ctx: WildlifeUpdateContext): void {
    const px = ctx.playerX;
    const pz = ctx.playerZ;
    for (let attempt = 0; attempt < 24; attempt++) {
      // Bias behind player's wide FOV, or allow distant ridge-occluded valleys
      const angle =
        attempt < 18
          ? this.sampleRearBlindSpotAngle(ctx.playerYawRad)
          : Math.random() * Math.PI * 2;
      const dist =
        DEER_SPAWN_MIN_DIST_M +
        Math.random() * (DEER_SPAWN_MAX_DIST_M - DEER_SPAWN_MIN_DIST_M);
      const wx = px + Math.cos(angle) * dist;
      const wz = pz + Math.sin(angle) * dist;

      // Strictly focus deer into deep wilderness well away from roads, settlements, FOBs & landmarks
      if (!isDeerWildernessHabitat(wx, wz)) {
        continue;
      }

      // Spread out spawns: enforce wide herd-to-herd & wolf separation
      let tooClose = false;
      for (let i = 0; i < this.deerHerds.length; i++) {
        const ref = this.deerHerds[i].members[0];
        if (ref && Math.hypot(ref.x - wx, ref.z - wz) < DEER_MIN_HERD_SEPARATION_M) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      for (let i = 0; i < this.wolfPacks.length; i++) {
        const ref = this.wolfPacks[i].members[0];
        if (ref && Math.hypot(ref.x - wx, ref.z - wz) < DEER_MIN_WOLF_SEPARATION_M) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const wy = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(wx, wz));
      // Guarantee NO player can ever see the deer herd pop in
      if (!this.isHiddenFromPlayerView(wx, wy, wz, ctx, 1.65, true)) {
        continue;
      }
      let memberVisible = false;
      for (let k = 0; k < 4; k++) {
        const oa = (k / 4) * Math.PI * 2;
        const ox = wx + Math.cos(oa) * 8.5;
        const oz = wz + Math.sin(oa) * 8.5;
        const oy = this.sampleGroundHeight(ox, oz);
        if (!this.isHiddenFromPlayerView(ox, oy, oz, ctx, 1.65, true)) {
          memberVisible = true;
          break;
        }
      }
      if (memberVisible) continue;

      const size = 2 + Math.floor(Math.random() * 4); // 2..5 deer
      this.spawnDeerHerdAt(wx, wz, size);
      this.recordDynamicSpawn('deer_herd', wx, wy, wz, ctx, 1.65);
      return;
    }
  }

  private despawnWolfPack(index: number): void {
    const pack = this.wolfPacks[index];
    for (let i = 0; i < pack.members.length; i++) {
      const m = pack.members[i];
      this.rootGroup.remove(m.rig.root);
      this.entitiesById.delete(m.id);
      const hi = this.hitMeshes.indexOf(m.rig.hitbox);
      if (hi >= 0) this.hitMeshes.splice(hi, 1);
    }
    this.wolfPacks.splice(index, 1);
  }

  private despawnDeerHerd(index: number): void {
    const herd = this.deerHerds[index];
    for (let i = 0; i < herd.members.length; i++) {
      const m = herd.members[i];
      this.rootGroup.remove(m.rig.root);
      this.entitiesById.delete(m.id);
      const hi = this.hitMeshes.indexOf(m.rig.hitbox);
      if (hi >= 0) this.hitMeshes.splice(hi, 1);
    }
    this.deerHerds.splice(index, 1);
  }

  // ============================================================================
  // DEER HERD AI (GRAZE -> ALERT -> BOLT)
  // ============================================================================

  private triggerDeerHerdBolt(herd: DeerHerdBlackboard, threatX: number, threatZ: number): void {
    const ref = herd.members.find((m) => m.alive);
    if (!ref) return;
    const dx = ref.x - threatX;
    const dz = ref.z - threatZ;
    const len = Math.hypot(dx, dz) || 1;
    herd.boltDirX = dx / len;
    herd.boltDirZ = dz / len;
    if (herd.state !== 'BOLT' && herd.snortCooldown <= 0) {
      this.ambienceAudio.playDeerSnort(ref.x, ref.y + 1.1, ref.z);
      herd.snortCooldown = 6.0;
    }
    herd.state = 'BOLT';
    herd.stateTimer = 8.5 + Math.random() * 4.5;
  }

  private updateDeerHerds(dt: number, ctx: WildlifeUpdateContext): void {
    // High acoustic/visual detection radius: 45m sprinting, 30m walking, 18m crouched
    const playerDetectRadius = ctx.playerSprinting ? 45 : ctx.playerCrouched ? 18 : 30;

    for (let h = 0; h < this.deerHerds.length; h++) {
      const herd = this.deerHerds[h];
      herd.stateTimer -= dt;
      herd.snortCooldown = Math.max(0, herd.snortCooldown - dt);

      const leader = herd.members.find((m) => m.alive);
      if (!leader) continue;

      // Threat check 1: Player proximity
      if (ctx.playerOnFoot && ctx.playerAlive) {
        const pDist = Math.hypot(leader.x - ctx.playerX, leader.z - ctx.playerZ);
        if (pDist < playerDetectRadius * 0.65) {
          this.triggerDeerHerdBolt(herd, ctx.playerX, ctx.playerZ);
        } else if (pDist < playerDetectRadius && herd.state === 'GRAZE') {
          herd.state = 'ALERT';
          herd.stateTimer = 2.4;
          if (herd.snortCooldown <= 0) {
            this.ambienceAudio.playDeerSnort(leader.x, leader.y + 1.1, leader.z);
            herd.snortCooldown = 5.5;
          }
        }
      }

      // Threat check 2: Stalking/hunting wolves
      for (let w = 0; w < this.wolfPacks.length; w++) {
        const wolf = this.wolfPacks[w].members.find((m) => m.alive);
        if (!wolf) continue;
        if (Math.hypot(leader.x - wolf.x, leader.z - wolf.z) < 34) {
          this.triggerDeerHerdBolt(herd, wolf.x, wolf.z);
          break;
        }
      }

      if (herd.state === 'ALERT' && herd.stateTimer <= 0) {
        const pDist = Math.hypot(leader.x - ctx.playerX, leader.z - ctx.playerZ);
        if (pDist < playerDetectRadius * 1.1) {
          this.triggerDeerHerdBolt(herd, ctx.playerX, ctx.playerZ);
        } else {
          herd.state = 'GRAZE';
          herd.stateTimer = 12;
        }
      } else if (herd.state === 'BOLT' && herd.stateTimer <= 0) {
        herd.state = 'GRAZE';
        if (isDeerWildernessHabitat(leader.x, leader.z)) {
          herd.homeX = leader.x;
          herd.homeZ = leader.z;
        }
        herd.stateTimer = 14;
      }

      for (let i = 0; i < herd.members.length; i++) {
        const d = herd.members[i];
        if (!d.alive) {
          d.deathRoll = Math.min(Math.PI * 0.48, d.deathRoll + dt * 4.2);
          d.rig.bodyPivot.rotation.z = d.deathRoll;
          d.rig.bodyPivot.position.y = THREE.MathUtils.lerp(0.94, 0.28, d.deathRoll / (Math.PI * 0.48));
          continue;
        }

        let targetVx = 0;
        let targetVz = 0;
        if (herd.state === 'BOLT') {
          const speed = 8.4 + (i % 3) * 0.45;
          // Steer bolting deer away from roadways/settlements if they approach civilization
          const nextProbeX = d.x + herd.boltDirX * 14;
          const nextProbeZ = d.z + herd.boltDirZ * 14;
          if (isOnCivilizationClearance(nextProbeX, nextProbeZ, 28)) {
            const tmpX = -herd.boltDirZ;
            const tmpZ = herd.boltDirX;
            herd.boltDirX = tmpX;
            herd.boltDirZ = tmpZ;
          }
          targetVx = herd.boltDirX * speed;
          targetVz = herd.boltDirZ * speed;
        } else if (herd.state === 'GRAZE') {
          // Gentle herd cohesion wander around wilderness clearing
          const driftA = ctx.elapsedSec * 0.14 + i * 2.1;
          const tx = herd.homeX + Math.cos(driftA) * 8.5;
          const tz = herd.homeZ + Math.sin(driftA) * 8.5;
          const dx = tx - d.x;
          const dz = tz - d.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 2.2) {
            targetVx = (dx / dist) * 1.15;
            targetVz = (dz / dist) * 1.15;
          }
        }

        d.vx += (targetVx - d.vx) * Math.min(1, dt * 4.5);
        d.vz += (targetVz - d.vz) * Math.min(1, dt * 4.5);
        d.x += d.vx * dt;
        d.z += d.vz * dt;
        const gh = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(d.x, d.z));
        d.y = gh;

        const speed = Math.hypot(d.vx, d.vz);
        if (speed > 0.2) {
          const desiredYaw = Math.atan2(d.vx, d.vz);
          d.yaw += wrapAngleDiff(desiredYaw, d.yaw) * Math.min(1, dt * 7.5);
        }

        const dDistPlayer = Math.hypot(d.x - ctx.playerX, d.z - ctx.playerZ);
        const deerBehind =
          dDistPlayer > 14.0 && this.computePlayerForwardDot(d.x, d.z, ctx) < HIDDEN_REAR_DOT_MAX;
        const deerOccluded =
          !deerBehind &&
          dDistPlayer > 14.0 &&
          Boolean(ctx.occlusionCuller?.isSphereOccluded(d.x, d.y + 0.95, d.z, 1.35, 14.0));
        const deerHidden = deerBehind || deerOccluded;
        d.rig.root.visible = !d.harvested && !deerHidden;

        const bound = herd.state === 'BOLT' ? Math.max(0, Math.sin(d.gaitPhase)) * 0.28 : 0;
        d.rig.root.position.set(d.x, d.y + bound, d.z);
        d.rig.root.rotation.y = d.yaw;

        const reduceAnimDistM = graphicsQualityStore.getReduceAnimationDistanceM();
        const deerBeyondReduce = dDistPlayer > reduceAnimDistM;
        const animateDeerNow = !deerHidden && (!deerBeyondReduce || ((i + this.animFrameTick) & 1) === 0);
        if (animateDeerNow) {
          const animDt = deerBeyondReduce ? dt * 2.0 : dt;
          // Articulated bounding gait + ear twitch + white flagging tail
          d.gaitPhase += animDt * (speed > 3 ? 13.5 : speed * 4.2);
          d.earTwitchPhase += animDt * 3.1;
          const targetGraze = herd.state === 'GRAZE' && speed < 0.5 ? 1.0 : 0.0;
          d.grazeBlend += (targetGraze - d.grazeBlend) * Math.min(1, animDt * 3.5);

          const swing = Math.min(1, speed / 4.5) * 0.65;
          const fSwing = Math.sin(d.gaitPhase) * swing;
          const bSwing = Math.sin(d.gaitPhase + (herd.state === 'BOLT' ? 0.55 : Math.PI)) * swing;
          d.rig.legFL.rotation.x = fSwing;
          d.rig.legFR.rotation.x = herd.state === 'BOLT' ? fSwing * 0.92 : -fSwing;
          d.rig.legBL.rotation.x = bSwing;
          d.rig.legBR.rotation.x = herd.state === 'BOLT' ? bSwing * 0.92 : -bSwing;

          // Grazing head bow vs Alert head-high + ear twitch + white flag tail
          d.rig.neckPivot.rotation.x = d.grazeBlend * 1.05;
          const twitch = Math.sin(d.earTwitchPhase * 2.7) > 0.88 ? 0.28 : 0;
          d.rig.earL.rotation.z = 0.45 + twitch;
          d.rig.earR.rotation.z = -0.45 - twitch * 0.7;
          d.rig.tailPivot.rotation.x = herd.state === 'BOLT' ? 1.35 : 0.08;
        }

        // Subtle hoof-step audio when bolting near player
        d.hoofCooldown = Math.max(0, d.hoofCooldown - dt);
        if (herd.state === 'BOLT' && d.hoofCooldown <= 0 && i === 0) {
          this.ambienceAudio.playDeerHoofstep(d.x, d.y, d.z, speed);
          d.hoofCooldown = 0.34 + Math.random() * 0.14;
        }
      }
    }
  }

  // ============================================================================
  // WOLF PACK AI (HUNT DEER OFTEN · RIVAL PACK FIGHTS · RARE OPERATOR FLANKING)
  // ============================================================================

  private triggerPackFlee(pack: WolfPackBlackboard, threatX: number, threatZ: number): void {
    const alpha = pack.members.find((m) => m.alive);
    if (!alpha) return;
    const dx = alpha.x - threatX;
    const dz = alpha.z - threatZ;
    const len = Math.hypot(dx, dz) || 1;
    pack.fleeDirX = dx / len;
    pack.fleeDirZ = dz / len;
    pack.state = 'FLEE';
    pack.stateTimer = 11.0;
    pack.targetDeerId = null;
    pack.rivalPackId = null;
  }

  private updateWolfPacks(dt: number, ctx: WildlifeUpdateContext): void {
    // 3x aggro weight at night, still rare against human operators
    const nightWeight = ctx.nightFactor > 0.45 ? 3.0 : 1.0;
    const playerForwardX = -Math.sin(ctx.playerYawRad);
    const playerForwardZ = -Math.cos(ctx.playerYawRad);

    for (let p = 0; p < this.wolfPacks.length; p++) {
      const pack = this.wolfPacks[p];
      const aliveMembers = pack.members.filter((m) => m.alive);
      if (aliveMembers.length === 0) {
        // Still animate death collapse on downed wolves
        this.animateDeadWolves(pack, dt);
        continue;
      }

      const alpha = aliveMembers[0];
      pack.stateTimer -= dt;
      pack.howlCooldown -= dt;
      pack.fearScore = Math.max(0, pack.fearScore - dt * 0.06);

      const distToPlayer = Math.hypot(alpha.x - ctx.playerX, alpha.z - ctx.playerZ);

      // Flashlight reaction: shining beam directly onto wolves scares/deters them
      if (ctx.flashlightOn && ctx.playerOnFoot && distToPlayer < 36) {
        const toWolfX = (alpha.x - ctx.playerX) / Math.max(0.1, distToPlayer);
        const toWolfZ = (alpha.z - ctx.playerZ) / Math.max(0.1, distToPlayer);
        const aimDot = toWolfX * playerForwardX + toWolfZ * playerForwardZ;
        if (aimDot > 0.82) {
          pack.fearScore += dt * 0.65;
          if (pack.fearScore > 1.35 && pack.state !== 'FLEE') {
            this.triggerPackFlee(pack, ctx.playerX, ctx.playerZ);
          }
        }
      }

      // Pack-wide state arbitration (Priority: FLEE -> HUNT_PREY (deer) -> PACK_FIGHT -> rare OPERATOR stalk)
      if (pack.state === 'FLEE') {
        if (pack.stateTimer <= 0) {
          pack.state = 'PATROL';
          pack.homeX = alpha.x;
          pack.homeZ = alpha.z;
          pack.stateTimer = 12;
        }
      } else {
        // 1. Check for nearby live deer (wolves OFTEN hunt deer!)
        if (pack.state === 'PATROL' || pack.state === 'STALK') {
          let bestDeer: DeerEntity | null = null;
          let bestDeerDist = 96;
          for (let h = 0; h < this.deerHerds.length; h++) {
            const members = this.deerHerds[h].members;
            for (let di = 0; di < members.length; di++) {
              const deer = members[di];
              if (!deer.alive) continue;
              const dd = Math.hypot(deer.x - alpha.x, deer.z - alpha.z);
              if (dd < bestDeerDist) {
                bestDeerDist = dd;
                bestDeer = deer;
              }
            }
          }
          if (bestDeer) {
            pack.state = 'HUNT_PREY';
            pack.targetDeerId = bestDeer.id;
            pack.stateTimer = 18;
          }
        }

        // 2. Check for rival wolf pack clash (wolves SOMETIMES fight rival packs!)
        if (pack.state === 'PATROL' && this.wolfPacks.length >= 2) {
          for (let op = 0; op < this.wolfPacks.length; op++) {
            if (op === p) continue;
            const other = this.wolfPacks[op];
            const otherAlpha = other.members.find((m) => m.alive);
            if (!otherAlpha) continue;
            const packDist = Math.hypot(otherAlpha.x - alpha.x, otherAlpha.z - alpha.z);
            if (packDist < 68 && pack.fearScore < 0.6) {
              pack.state = 'PACK_FIGHT';
              pack.rivalPackId = other.id;
              pack.stateTimer = 16;
              if (other.state === 'PATROL') {
                other.state = 'PACK_FIGHT';
                other.rivalPackId = pack.id;
                other.stateTimer = 16;
              }
              break;
            }
          }
        }

        // 3. Rare operator hunt (only when operator encroaches closely & pack has strength, 3x weight at night)
        if (
          ctx.playerOnFoot &&
          ctx.playerAlive &&
          (pack.state === 'PATROL' || pack.state === 'STALK') &&
          aliveMembers.length >= 3 &&
          pack.fearScore < 0.5
        ) {
          const triggerDist = ctx.nightFactor > 0.45 ? 36 : 22;
          if (distToPlayer < triggerDist) {
            // Accumulate slow rare aggro so packs don't auto-aggro on sight during daytime
            pack.aggroScore += dt * 0.09 * nightWeight;
            if (pack.aggroScore >= 1.0) {
              pack.state = 'ENCIRCLE';
              pack.stateTimer = 20;
            } else if (pack.aggroScore >= 0.45) {
              pack.state = 'STALK';
              pack.stateTimer = 10;
            }
          } else {
            pack.aggroScore = Math.max(0, pack.aggroScore - dt * 0.08);
          }
        }
      }

      // Sync Alpha territorial howl with head-tilt animation (diegetic 3D audio strictly from wolf transform)
      if (pack.state === 'PATROL' && pack.howlCooldown <= 0 && !this.ambienceAudio.isFaunaSuppressed()) {
        pack.howlCooldown = (ctx.nightFactor > 0.45 ? 18 : 34) + Math.random() * 22;
        alpha.howlTimer = 2.6;
        this.ambienceAudio.playWolfHowl(alpha.x, alpha.y + 0.9, alpha.z, true);
        if (aliveMembers.length > 1) {
          const beta = aliveMembers[1];
          beta.howlTimer = 2.1;
          this.ambienceAudio.playWolfHowl(beta.x, beta.y + 0.8, beta.z, false);
        }
      }

      // Refresh patrol waypoint
      if (pack.state === 'PATROL' && pack.stateTimer <= 0) {
        const a = Math.random() * Math.PI * 2;
        const r = 18 + Math.random() * 44;
        pack.patrolX = pack.homeX + Math.cos(a) * r;
        pack.patrolZ = pack.homeZ + Math.sin(a) * r;
        pack.stateTimer = 9 + Math.random() * 8;
      }

      // Resolve active prey deer or rival wolf target
      const preyRec = pack.targetDeerId ? this.entitiesById.get(pack.targetDeerId) : null;
      const preyDeer = preyRec && preyRec.kind === 'deer' && preyRec.entity.alive ? preyRec.entity : null;
      if (pack.state === 'HUNT_PREY' && (!preyDeer || pack.stateTimer <= 0)) {
        pack.state = 'PATROL';
        pack.targetDeerId = null;
        pack.stateTimer = 8;
      }

      const rivalPack = pack.rivalPackId
        ? this.wolfPacks.find((rp) => rp.id === pack.rivalPackId) ?? null
        : null;
      const rivalWolf = rivalPack?.members.find((m) => m.alive) ?? null;
      if (pack.state === 'PACK_FIGHT' && (!rivalWolf || pack.stateTimer <= 0)) {
        pack.state = 'PATROL';
        pack.rivalPackId = null;
        pack.stateTimer = 10;
      }

      if ((pack.state === 'ENCIRCLE' || pack.state === 'LUNGE') && (!ctx.playerAlive || !ctx.playerOnFoot || distToPlayer > 70)) {
        pack.state = 'PATROL';
        pack.aggroScore = 0;
        pack.stateTimer = 8;
      }

      // Step every wolf in the pack
      for (let i = 0; i < pack.members.length; i++) {
        const w = pack.members[i];
        if (!w.alive) {
          w.deathRoll = Math.min(Math.PI * 0.48, w.deathRoll + dt * 4.5);
          w.rig.bodyPivot.rotation.z = w.deathRoll;
          w.rig.bodyPivot.position.y = THREE.MathUtils.lerp(0.62, 0.22, w.deathRoll / (Math.PI * 0.48));
          continue;
        }

        w.howlTimer = Math.max(0, w.howlTimer - dt);
        w.biteCooldown = Math.max(0, w.biteCooldown - dt);
        w.growlCooldown = Math.max(0, w.growlCooldown - dt);
        w.lungeTimer = Math.max(0, w.lungeTimer - dt);

        let goalX = pack.patrolX + Math.cos(i * 2.1) * 4.5;
        let goalZ = pack.patrolZ + Math.sin(i * 2.1) * 4.5;
        let moveSpeed = 2.6;
        let jawOpen = 0.0;

        if (w.howlTimer > 0) {
          // Pause briefly to tilt head skyward during howl
          moveSpeed = 0.0;
          jawOpen = 0.48;
        } else if (pack.state === 'FLEE') {
          goalX = w.x + pack.fleeDirX * 28;
          goalZ = w.z + pack.fleeDirZ * 28;
          moveSpeed = 7.4;
        } else if (pack.state === 'HUNT_PREY' && preyDeer) {
          // Coordinated pursuit of live deer!
          const spread = w.isAlpha ? 0 : (i % 2 === 0 ? 1 : -1) * 3.5;
          goalX = preyDeer.x + spread;
          goalZ = preyDeer.z - spread * 0.6;
          moveSpeed = 7.6;
          const distPrey = Math.hypot(preyDeer.x - w.x, preyDeer.z - w.z);
          if (distPrey < 2.35 && w.biteCooldown <= 0) {
            w.biteCooldown = 1.4;
            w.lungeTimer = 0.35;
            jawOpen = 0.72;
            this.ambienceAudio.playWolfSnarl(w.x, w.y + 0.65, w.z);
            preyDeer.hp = Math.max(0, preyDeer.hp - 26);
            if (preyDeer.hp <= 0) {
              preyDeer.alive = false;
              preyDeer.rig.hitbox.visible = false;
              pack.state = 'PATROL';
              pack.homeX = preyDeer.x;
              pack.homeZ = preyDeer.z;
              pack.patrolX = preyDeer.x;
              pack.patrolZ = preyDeer.z;
              pack.targetDeerId = null;
              pack.stateTimer = 14;
            }
          }
        } else if (pack.state === 'PACK_FIGHT' && rivalWolf) {
          // Territorial rival wolf pack clash!
          goalX = rivalWolf.x + Math.cos(ctx.elapsedSec * 1.4 + i) * 2.2;
          goalZ = rivalWolf.z + Math.sin(ctx.elapsedSec * 1.4 + i) * 2.2;
          moveSpeed = 6.2;
          const distRival = Math.hypot(rivalWolf.x - w.x, rivalWolf.z - w.z);
          if (distRival < 12 && w.growlCooldown <= 0) {
            this.ambienceAudio.playWolfGrowl(w.x, w.y + 0.6, w.z, 0.95);
            w.growlCooldown = 2.4 + Math.random() * 2.2;
          }
          if (distRival < 2.2 && w.biteCooldown <= 0) {
            w.biteCooldown = 1.65;
            w.lungeTimer = 0.35;
            jawOpen = 0.75;
            this.ambienceAudio.playWolfSnarl(w.x, w.y + 0.65, w.z);
            rivalWolf.hp = Math.max(0, rivalWolf.hp - 18);
            if (rivalWolf.hp <= 0) {
              rivalWolf.alive = false;
              rivalWolf.rig.hitbox.visible = false;
              if (rivalPack) {
                this.triggerPackFlee(rivalPack, w.x, w.z);
              }
            }
          }
        } else if (pack.state === 'STALK') {
          goalX = ctx.playerX + Math.cos(w.flankAngleOffset) * 20;
          goalZ = ctx.playerZ + Math.sin(w.flankAngleOffset) * 20;
          moveSpeed = 3.2;
          if (distToPlayer < 16 && w.growlCooldown <= 0) {
            this.ambienceAudio.playWolfGrowl(w.x, w.y + 0.6, w.z, 0.75);
            w.growlCooldown = 3.5 + Math.random() * 2.5;
          }
        } else if (pack.state === 'ENCIRCLE' || pack.state === 'LUNGE') {
          // Tactical Flanking Ring:
          // Alpha holds front & growls (~8.5m ahead of player), Betas flank outside player's 90° FOV cone!
          const playerLookAngle = Math.atan2(playerForwardX, playerForwardZ);
          if (w.isAlpha) {
            const frontDist = 8.5;
            goalX = ctx.playerX + Math.sin(playerLookAngle) * frontDist;
            goalZ = ctx.playerZ + Math.cos(playerLookAngle) * frontDist;
            moveSpeed = 4.8;
            if (distToPlayer < 16 && w.growlCooldown <= 0) {
              this.ambienceAudio.playWolfGrowl(w.x, w.y + 0.65, w.z, 1.0);
              w.growlCooldown = 2.6 + Math.random() * 1.8;
            }
          } else {
            // Betas circle outside the 90° cone (±115°..±165° behind/side of operator) before lunging
            const flankAngle = playerLookAngle + w.flankAngleOffset + Math.sin(ctx.elapsedSec * 0.7 + i) * 0.25;
            const ringRadius = w.biteCooldown <= 0 ? 1.4 : 9.2;
            goalX = ctx.playerX + Math.sin(flankAngle) * ringRadius;
            goalZ = ctx.playerZ + Math.cos(flankAngle) * ringRadius;
            moveSpeed = w.biteCooldown <= 0 ? 7.4 : 5.6;

            const dPlayer = Math.hypot(ctx.playerX - w.x, ctx.playerZ - w.z);
            if (dPlayer < 4.5 && w.biteCooldown <= 0 && w.lungeTimer <= 0) {
              w.lungeTimer = 0.42;
              this.ambienceAudio.playWolfSnarl(w.x, w.y + 0.65, w.z);
            }
            if (dPlayer < 2.05 && w.biteCooldown <= 0) {
              w.biteCooldown = 3.4;
              jawOpen = 0.8;
              ctx.onWolfBitePlayer?.({
                wolfId: w.id,
                packId: pack.id,
                damageHp: 14,
                bleedDurationSec: 12,
                sprintSlowDurationSec: 7.5,
                originX: w.x,
                originY: w.y + 0.65,
                originZ: w.z,
              });
            }
          }
        }

        // Steering & heightfield grounding
        const dx = goalX - w.x;
        const dz = goalZ - w.z;
        const distGoal = Math.hypot(dx, dz);
        const tvx = distGoal > 0.6 && moveSpeed > 0 ? (dx / distGoal) * moveSpeed : 0;
        const tvz = distGoal > 0.6 && moveSpeed > 0 ? (dz / distGoal) * moveSpeed : 0;
        w.vx += (tvx - w.vx) * Math.min(1, dt * 5.2);
        w.vz += (tvz - w.vz) * Math.min(1, dt * 5.2);
        w.x += w.vx * dt;
        w.z += w.vz * dt;
        w.y = Math.max(SEA_LEVEL_M + 0.15, this.sampleGroundHeight(w.x, w.z));

        const speed = Math.hypot(w.vx, w.vz);
        if (speed > 0.18) {
          const desiredYaw = Math.atan2(w.vx, w.vz);
          w.yaw += wrapAngleDiff(desiredYaw, w.yaw) * Math.min(1, dt * 8.0);
        } else if (pack.state === 'ENCIRCLE') {
          const faceYaw = Math.atan2(ctx.playerX - w.x, ctx.playerZ - w.z);
          w.yaw += wrapAngleDiff(faceYaw, w.yaw) * Math.min(1, dt * 6.0);
        }

        // Behind-player & occlusion visual culling (> 14m safety halo): hide rig & skip skeletal writes while keeping AI active
        const wDistPlayer = Math.hypot(w.x - ctx.playerX, w.z - ctx.playerZ);
        const wolfBehind =
          wDistPlayer > 14.0 && this.computePlayerForwardDot(w.x, w.z, ctx) < HIDDEN_REAR_DOT_MAX;
        const wolfOccluded =
          !wolfBehind &&
          wDistPlayer > 14.0 &&
          Boolean(ctx.occlusionCuller?.isSphereOccluded(w.x, w.y + 0.65, w.z, 1.05, 14.0));
        const wolfHidden = wolfBehind || wolfOccluded;
        w.rig.root.visible = !w.harvested && !wolfHidden;
        w.rig.root.position.set(w.x, w.y, w.z);
        w.rig.root.rotation.y = w.yaw;

        const reduceAnimDistM = graphicsQualityStore.getReduceAnimationDistanceM();
        const wolfBeyondReduce = wDistPlayer > reduceAnimDistM;
        const animateWolfNow = !wolfHidden && (!wolfBeyondReduce || ((i + this.animFrameTick) & 1) === 0);
        if (animateWolfNow) {
          const animDt = wolfBeyondReduce ? dt * 2.0 : dt;
          // Procedural 4-leg gait + jaw snap + head-tilt howl animation
          w.gaitPhase += animDt * (speed > 4 ? 13.0 : speed * 3.8);
          const legAmp = Math.min(0.72, speed * 0.11);
          w.rig.legFL.rotation.x = Math.sin(w.gaitPhase) * legAmp;
          w.rig.legFR.rotation.x = Math.sin(w.gaitPhase + Math.PI) * legAmp;
          w.rig.legBL.rotation.x = Math.sin(w.gaitPhase + Math.PI * 0.85) * legAmp;
          w.rig.legBR.rotation.x = Math.sin(w.gaitPhase - Math.PI * 0.15) * legAmp;

          const targetNeckPitch = w.howlTimer > 0 ? -0.78 : pack.state === 'STALK' ? 0.25 : 0.0;
          w.rig.neckPivot.rotation.x += (targetNeckPitch - w.rig.neckPivot.rotation.x) * Math.min(1, animDt * 6.0);
          const targetJaw = w.lungeTimer > 0 ? 0.72 : jawOpen;
          w.rig.jawPivot.rotation.x += (targetJaw - w.rig.jawPivot.rotation.x) * Math.min(1, animDt * 10.0);
          w.rig.tailPivot.rotation.y = Math.sin(ctx.elapsedSec * 4.0 + i) * 0.22;
        }
      }
    }
  }

  private animateDeadWolves(pack: WolfPackBlackboard, dt: number): void {
    for (let i = 0; i < pack.members.length; i++) {
      const w = pack.members[i];
      if (!w.alive) {
        w.deathRoll = Math.min(Math.PI * 0.48, w.deathRoll + dt * 4.5);
        w.rig.bodyPivot.rotation.z = w.deathRoll;
        w.rig.bodyPivot.position.y = THREE.MathUtils.lerp(0.62, 0.22, w.deathRoll / (Math.PI * 0.48));
      }
    }
  }

  // ============================================================================
  // TIER 2: PHYSICAL FROGS (35m WATER/MARSH POOL + DIEGETIC CROAKS + 4m HOP)
  // ============================================================================

  private updateFrogs(dt: number, ctx: WildlifeUpdateContext): void {
    this.frogRepopAccum += dt;
    const doRepop = this.frogRepopAccum >= 0.4;
    if (doRepop) this.frogRepopAccum = 0;

    let visibleCount = 0;
    let spawnedThisTick = 0;
    const silent = this.ambienceAudio.isFaunaSuppressed();

    for (let i = 0; i < this.frogs.length; i++) {
      const f = this.frogs[i];
      if (f.active) {
        const distPlayer = Math.hypot(f.x - ctx.playerX, f.z - ctx.playerZ);
        if (distPlayer > 42) {
          f.active = false;
        }
      }

      // Repopulate inactive frog slots ONLY behind player FOV & widely spaced along shoreline
      if (!f.active && doRepop && spawnedThisTick < 3) {
        const a = this.sampleRearBlindSpotAngle(ctx.playerYawRad);
        const r = 10 + Math.random() * 24;
        const wx = ctx.playerX + Math.cos(a) * r;
        const wz = ctx.playerZ + Math.sin(a) * r;
        const gh = this.sampleGroundHeight(wx, wz);
        if (this.isHiddenFromPlayerView(wx, gh, wz, ctx, 0.25, false)) {
          queryWaterProximity(wx, wz, gh, _water);
          if (_water.isFrogHabitat) {
            let crowded = false;
            for (let j = 0; j < this.frogs.length; j++) {
              const other = this.frogs[j];
              if (other.active && Math.hypot(other.x - wx, other.z - wz) < FROG_MIN_SEPARATION_M) {
                crowded = true;
                break;
              }
            }
            if (!crowded) {
              f.active = true;
              f.x = wx;
              f.y = gh;
              f.z = wz;
              f.yaw = Math.random() * Math.PI * 2;
              f.hopProgress = 0;
              f.submergedTimer = 0;
              f.croakCooldown = 1.5 + Math.random() * 7.5;
              f.spawnBlend = 0.01;
              spawnedThisTick++;
              this.recordDynamicSpawn('frog', wx, gh, wz, ctx, 0.25);
            }
          }
        }
      }

      if (!f.active) continue;

      if (f.submergedTimer > 0) {
        f.submergedTimer = Math.max(0, f.submergedTimer - dt);
        continue;
      }

      f.spawnBlend = Math.min(1, f.spawnBlend + dt * 1.8);
      const distPlayer = Math.hypot(f.x - ctx.playerX, f.z - ctx.playerZ);

      // Startle hop into water when player approaches within 4.0m
      if (f.hopProgress === 0 && distPlayer < 4.0 && ctx.playerOnFoot) {
        const dx = f.x - ctx.playerX;
        const dz = f.z - ctx.playerZ;
        const len = Math.hypot(dx, dz) || 1;
        f.hopStartX = f.x;
        f.hopStartY = f.y;
        f.hopStartZ = f.z;
        f.hopEndX = f.x + (dx / len) * 2.1;
        f.hopEndZ = f.z + (dz / len) * 2.1;
        f.hopEndY = this.sampleGroundHeight(f.hopEndX, f.hopEndZ);
        f.yaw = Math.atan2(dx, dz);
        f.hopProgress = 0.001;
      } else if (f.hopProgress === 0) {
        // Diegetic croak strictly from physical frog transform (stops when player < 4m or gunshots)
        f.croakCooldown -= dt;
        if (f.croakCooldown <= 0) {
          f.croakCooldown = (ctx.nightFactor > 0.35 ? 4.5 : 8.5) + Math.random() * 9.0;
          if (!silent && distPlayer >= 4.0 && distPlayer < 35) {
            this.ambienceAudio.playFrogCroak(f.x, f.y + 0.1, f.z, f.pitchScale);
          }
        }
      }

      let sx = 1.0 * f.spawnBlend;
      let sy = 0.85 * f.spawnBlend;
      let sz = 1.0 * f.spawnBlend;
      if (f.hopProgress > 0) {
        f.hopProgress += dt * 2.7;
        const t = Math.min(1, f.hopProgress);
        f.x = THREE.MathUtils.lerp(f.hopStartX, f.hopEndX, t);
        f.z = THREE.MathUtils.lerp(f.hopStartZ, f.hopEndZ, t);
        f.y = THREE.MathUtils.lerp(f.hopStartY, f.hopEndY, t) + Math.sin(t * Math.PI) * 0.58;
        // Extended leap morph/scale state
        sx = 0.82;
        sy = 0.9;
        sz = 1.65;
        if (f.hopProgress >= 1) {
          f.hopProgress = 0;
          f.submergedTimer = 9.0 + Math.random() * 6.0; // Hides in reeds/water after leaping
          continue;
        }
      }

      _dummy.position.set(f.x, f.y, f.z);
      _dummy.rotation.set(f.hopProgress > 0 ? -0.35 : 0, f.yaw, 0);
      _dummy.scale.set(sx, sy, sz);
      _dummy.updateMatrix();
      this.frogMesh.setMatrixAt(visibleCount, _dummy.matrix);
      _color.setRGB(0.22 + (i % 3) * 0.04, 0.36 + (i % 4) * 0.04, 0.16);
      this.frogMesh.setColorAt(visibleCount, _color);
      visibleCount++;
    }

    this.frogMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.frogMesh.instanceMatrix.needsUpdate = true;
      if (this.frogMesh.instanceColor) this.frogMesh.instanceColor.needsUpdate = true;
    }
  }

  // ============================================================================
  // TIER 2: DAYTIME BUTTERFLIES (30m DRIFT + VERTEX WING FLAP + UNSEEN SPAWN)
  // ============================================================================

  private updateButterflies(dt: number, ctx: WildlifeUpdateContext): void {
    const dayActive =
      isHourInWindow(ctx.timeOfDayHours, 6.0, 19.0) &&
      !ctx.isRaining &&
      ctx.windSpeedMps < 11.5;

    const deepNight = !isHourInWindow(ctx.timeOfDayHours, 5.5, 19.6);
    if (!dayActive && (deepNight || ctx.isRaining || ctx.windSpeedMps >= 12.5)) {
      for (let i = 0; i < this.butterflies.length; i++) {
        this.butterflies[i].active = false;
      }
      this.butterflyMesh.count = 0;
      return;
    }

    this.butterflyRepopAccum += dt;
    const allowRepop = dayActive && this.butterflyRepopAccum >= 0.25;
    if (allowRepop) this.butterflyRepopAccum = 0;

    let visibleCount = 0;
    let spawnedThisTick = 0;
    const palette = [0xd8c37c, 0x89a9c4, 0xd49654, 0xe4e0d2];

    for (let i = 0; i < this.butterflies.length; i++) {
      const b = this.butterflies[i];
      if (b.active) {
        const dist = Math.hypot(b.x - ctx.playerX, b.z - ctx.playerZ);
        if (dist > 36) b.active = false;
      }

      // Spawn strictly behind camera frustum & spread cleanly across clearing
      if (!b.active && allowRepop && spawnedThisTick < 3) {
        const a = this.sampleRearBlindSpotAngle(ctx.playerYawRad);
        const r = 12.0 + Math.random() * 18.0;
        const wx = ctx.playerX + Math.cos(a) * r;
        const wz = ctx.playerZ + Math.sin(a) * r;
        const wy = this.sampleGroundHeight(wx, wz) + 0.85 + Math.random() * 1.45;
        if (this.isHiddenFromPlayerView(wx, wy, wz, ctx, 0.3, false)) {
          sampleOpenWorldTerrain(wx, wz, _terrain);
          if (
            !_terrain.isWater &&
            !_terrain.isRoad &&
            _terrain.height < 260 &&
            (_terrain.biome === 'temperate_conifer_valley' ||
              _terrain.biome === 'highland_steppe_quarry' ||
              _terrain.biome === 'coastal_port_marsh')
          ) {
            let crowded = false;
            for (let j = 0; j < this.butterflies.length; j++) {
              const other = this.butterflies[j];
              if (
                other.active &&
                Math.hypot(other.anchorX - wx, other.anchorZ - wz) < BUTTERFLY_MIN_SEPARATION_M
              ) {
                crowded = true;
                break;
              }
            }
            if (!crowded) {
              b.active = true;
              b.anchorX = wx;
              b.anchorZ = wz;
              b.anchorY = wy;
              b.x = wx;
              b.y = wy + 1.1; // Drift gently down from canopy/reeds
              b.z = wz;
              b.scatterTimer = 0;
              b.scatterVy = 0;
              b.spawnBlend = 0.01;
              spawnedThisTick++;
              this.recordDynamicSpawn('butterfly', wx, wy, wz, ctx, 0.3);
            }
          }
        }
      }

      if (!b.active) continue;

      // Dusk departure: smoothly ascend into tree canopy instead of instant pop-out
      if (!dayActive) {
        b.y += 1.65 * dt;
        b.spawnBlend = Math.max(0, b.spawnBlend - dt * 0.55);
        if (b.spawnBlend <= 0.02 || b.y > b.anchorY + 8.5) {
          b.active = false;
          continue;
        }
      } else {
        b.spawnBlend = Math.min(1, b.spawnBlend + dt * 1.35);
      }

      // Sprint through -> disperse upward!
      if (ctx.playerSprinting && ctx.playerOnFoot) {
        const dp = Math.hypot(b.x - ctx.playerX, b.z - ctx.playerZ);
        if (dp < 4.5 && b.scatterTimer <= 0) {
          b.scatterVy = 2.4 + Math.random() * 1.5;
          b.scatterTimer = 2.2;
        }
      }

      b.phase += dt;
      const prevX = b.x;
      const prevZ = b.z;
      // Organic curl-noise / Lissajous figure-8 drift
      const lx = Math.sin(b.phase * b.freqA) * 2.1 + Math.cos(b.phase * b.freqB * 1.3) * 0.85;
      const lz = Math.cos(b.phase * b.freqB) * 2.1 + Math.sin(b.phase * b.freqA * 1.7) * 0.85;
      b.x = b.anchorX + lx;
      b.z = b.anchorZ + lz;
      if (b.scatterTimer > 0) {
        b.scatterTimer = Math.max(0, b.scatterTimer - dt);
        b.y += b.scatterVy * dt;
        b.scatterVy *= Math.exp(-dt * 1.1);
      } else if (dayActive) {
        const targetY = b.anchorY + Math.sin(b.phase * 2.4) * 0.35;
        b.y += (targetY - b.y) * Math.min(1, dt * 2.5);
      }
      b.yaw = Math.atan2(b.x - prevX, b.z - prevZ);

      _dummy.position.set(b.x, b.y, b.z);
      _dummy.rotation.set(0, b.yaw, 0);
      _dummy.scale.setScalar((1.0 + (i % 3) * 0.14) * b.spawnBlend);
      _dummy.updateMatrix();
      this.butterflyMesh.setMatrixAt(visibleCount, _dummy.matrix);
      _color.setHex(palette[i % palette.length]);
      this.butterflyMesh.setColorAt(visibleCount, _color);
      visibleCount++;
    }

    this.butterflyMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.butterflyMesh.instanceMatrix.needsUpdate = true;
      if (this.butterflyMesh.instanceColor) this.butterflyMesh.instanceColor.needsUpdate = true;
    }
  }

  // ============================================================================
  // TIER 3: SPIDERS & ANTS (50% REDUCED, UNSEEN REAR-ARC SPAWNING, BOOT SQUISH)
  // ============================================================================

  private updateInsects(dt: number, ctx: WildlifeUpdateContext): void {
    if (!ctx.playerOnFoot) {
      this.spiderMesh.count = 0;
      this.antMesh.count = 0;
      return;
    }

    this.insectRepopAccum += dt;
    const allowRepop = this.insectRepopAccum >= 0.45;
    if (allowRepop) this.insectRepopAccum = 0;

    // 1. Solitary Spiders (50% reduced pool = 7, wilderness primary + occasional sparse building interiors)
    let activeBuildingSpiders = 0;
    for (let i = 0; i < this.spiders.length; i++) {
      if (this.spiders[i].active && this.spiders[i].habitat === 'building') {
        activeBuildingSpiders++;
      }
    }

    let spiderCount = 0;
    let spidersSpawned = 0;
    for (let i = 0; i < this.spiders.length; i++) {
      const s = this.spiders[i];
      if (s.squishedTimer > 0) {
        s.squishedTimer = Math.max(0, s.squishedTimer - dt);
        continue;
      }
      if (s.active && Math.hypot(s.x - ctx.playerX, s.z - ctx.playerZ) > 14.5) {
        if (s.habitat === 'building') activeBuildingSpiders = Math.max(0, activeBuildingSpiders - 1);
        s.active = false;
      }
      if (!s.active && allowRepop && spidersSpawned < 2) {
        const angle = this.sampleRearBlindSpotAngle(ctx.playerYawRad);
        const radius = 6.5 + Math.random() * 5.7;
        let sx = ctx.playerX + Math.cos(angle) * radius;
        let sz = ctx.playerZ + Math.sin(angle) * radius;

        // Strongly bias wilderness spiders toward nearby fallen logs or rocks behind player's view
        if (ctx.nearbyLogs && ctx.nearbyLogs.length > 0 && Math.random() < 0.55) {
          const pick = ctx.nearbyLogs[i % ctx.nearbyLogs.length];
          const d = Math.hypot(pick.x - ctx.playerX, pick.z - ctx.playerZ);
          if (d >= 6.2 && d <= 12.2 && this.isHiddenFromPlayerView(pick.x, pick.y, pick.z, ctx, 0.15, false)) {
            sx = pick.x + (Math.random() - 0.5) * 1.4;
            sz = pick.z + (Math.random() - 0.5) * 1.4;
          }
        } else if (ctx.nearbyRocks && ctx.nearbyRocks.length > 0 && Math.random() < 0.42) {
          const pick = ctx.nearbyRocks[i % ctx.nearbyRocks.length];
          const d = Math.hypot(pick.x - ctx.playerX, pick.z - ctx.playerZ);
          if (d >= 6.2 && d <= 12.2 && this.isHiddenFromPlayerView(pick.x, pick.y, pick.z, ctx, 0.15, false)) {
            sx = pick.x + (Math.random() - 0.5) * 1.3;
            sz = pick.z + (Math.random() - 0.5) * 1.3;
          }
        }

        const sy = this.sampleGroundHeight(sx, sz);
        if (
          Math.hypot(sx - ctx.playerX, sz - ctx.playerZ) <= 12.5 &&
          this.isHiddenFromPlayerView(sx, sy, sz, ctx, 0.15, false)
        ) {
          if (ctx.sampleIndoorAt) {
            ctx.sampleIndoorAt(sx, sy + 0.5, sz, _indoorScratch);
          } else {
            _indoorScratch.isIndoor = false;
            _indoorScratch.material = 'outdoor';
          }
          const habitat = classifyInsectHabitat(sx, sy, sz, _indoorScratch);
          const habitatAllowed =
            habitat === 'wilderness' ||
            (habitat === 'building' &&
              activeBuildingSpiders < MAX_BUILDING_SPIDERS &&
              Math.random() < BUILDING_SPIDER_SPAWN_CHANCE);

          if (habitatAllowed) {
            let crowded = false;
            for (let j = 0; j < this.spiders.length; j++) {
              const other = this.spiders[j];
              if (other.active && Math.hypot(other.x - sx, other.z - sz) < SPIDER_MIN_SEPARATION_M) {
                crowded = true;
                break;
              }
            }
            if (!crowded) {
              s.active = true;
              s.habitat = habitat as 'wilderness' | 'building';
              if (s.habitat === 'building') activeBuildingSpiders++;
              s.x = sx;
              s.z = sz;
              s.y = sy;
              s.yaw = Math.random() * Math.PI * 2;
              s.turnTimer = 0.8 + Math.random() * 2.5;
              s.spawnBlend = 0.05;
              spidersSpawned++;
              this.recordDynamicSpawn('spider', sx, sy, sz, ctx, 0.12);
            }
          }
        }
      }
      if (!s.active) continue;

      s.spawnBlend = Math.min(1, s.spawnBlend + dt * 2.2);
      s.turnTimer -= dt;
      if (s.turnTimer <= 0) {
        s.turnTimer = 0.7 + Math.random() * 2.2;
        s.yaw += (Math.random() - 0.5) * 1.9;
      }
      const nextSx = s.x + Math.sin(s.yaw) * s.speed * dt;
      const nextSz = s.z + Math.cos(s.yaw) * s.speed * dt;
      // Keep wandering wilderness spiders off paved roads/tarmac
      if (s.habitat === 'wilderness' && isOnCivilizationClearance(nextSx, nextSz, 2.5)) {
        s.yaw += Math.PI * 0.75;
      } else {
        s.x = nextSx;
        s.z = nextSz;
      }
      s.y = this.sampleGroundHeight(s.x, s.z);

      _dummy.position.set(s.x, s.y + 0.005, s.z);
      _dummy.rotation.set(0, s.yaw, 0);
      _dummy.scale.setScalar((1.0 + (i % 3) * 0.18) * s.spawnBlend);
      _dummy.updateMatrix();
      this.spiderMesh.setMatrixAt(spiderCount, _dummy.matrix);
      spiderCount++;
    }
    this.spiderMesh.count = spiderCount;
    if (spiderCount > 0) this.spiderMesh.instanceMatrix.needsUpdate = true;

    // 2. Ants (50% reduced pool = 18 across 2 widely spaced rear-arc pheromone trails;
    //    focused in wilderness and only occasionally inside/around rural buildings)
    if (allowRepop) {
      let activeBuildingTrails = 0;
      for (let tIdx = 0; tIdx < this.antTrailCenters.length; tIdx++) {
        if (this.antTrailCenters[tIdx].active && this.antTrailCenters[tIdx].habitat === 'building') {
          activeBuildingTrails++;
        }
      }
      for (let tIdx = 0; tIdx < this.antTrailCenters.length; tIdx++) {
        const tc = this.antTrailCenters[tIdx];
        if (tc.active && Math.hypot(tc.x - ctx.playerX, tc.z - ctx.playerZ) > 13.0) {
          if (tc.habitat === 'building') activeBuildingTrails = Math.max(0, activeBuildingTrails - 1);
          tc.active = false;
        }
        if (!tc.active) {
          const baseRear = this.sampleRearBlindSpotAngle(ctx.playerYawRad);
          const dist = 7.4 + Math.random() * 3.8;
          const cx = ctx.playerX + Math.cos(baseRear) * dist;
          const cz = ctx.playerZ + Math.sin(baseRear) * dist;
          const cy = this.sampleGroundHeight(cx, cz);
          const other = this.antTrailCenters[1 - tIdx];
          const farFromOther =
            !other.active || Math.hypot(other.x - cx, other.z - cz) >= ANT_TRAIL_MIN_SEPARATION_M;
          if (farFromOther && this.isHiddenFromPlayerView(cx, cy, cz, ctx, 0.12, false)) {
            if (ctx.sampleIndoorAt) {
              ctx.sampleIndoorAt(cx, cy + 0.5, cz, _indoorScratch);
            } else {
              _indoorScratch.isIndoor = false;
              _indoorScratch.material = 'outdoor';
            }
            const habitat = classifyInsectHabitat(cx, cy, cz, _indoorScratch);
            const allowed =
              habitat === 'wilderness' ||
              (habitat === 'building' &&
                activeBuildingTrails < 1 &&
                Math.random() < BUILDING_ANT_TRAIL_SPAWN_CHANCE);
            if (allowed) {
              tc.x = cx;
              tc.z = cz;
              tc.habitat = habitat as 'wilderness' | 'building';
              tc.active = true;
              if (tc.habitat === 'building') activeBuildingTrails++;
            }
          }
        }
      }
    }

    let activeBuildingAnts = 0;
    for (let i = 0; i < this.ants.length; i++) {
      if (this.ants[i].active && this.ants[i].habitat === 'building') activeBuildingAnts++;
    }

    let antCount = 0;
    let antsSpawned = 0;
    for (let i = 0; i < this.ants.length; i++) {
      const a = this.ants[i];
      if (a.squishedTimer > 0) {
        a.squishedTimer = Math.max(0, a.squishedTimer - dt);
        continue;
      }
      if (a.active && Math.hypot(a.x - ctx.playerX, a.z - ctx.playerZ) > 14.5) {
        if (a.habitat === 'building') activeBuildingAnts = Math.max(0, activeBuildingAnts - 1);
        a.active = false;
      }
      if (!a.active && allowRepop && antsSpawned < 3) {
        const trailIdx = i % this.antTrailCenters.length;
        const tc = this.antTrailCenters[trailIdx];
        if (tc.active && (tc.habitat === 'wilderness' || activeBuildingAnts < MAX_BUILDING_ANTS)) {
          const angle = (i / ANT_POOL_SIZE) * Math.PI * 2;
          const r = 1.2 + (trailIdx % 2) * 0.5;
          const ax = tc.x + Math.cos(angle) * r;
          const az = tc.z + Math.sin(angle) * r;
          const ay = this.sampleGroundHeight(ax, az);
          if (this.isHiddenFromPlayerView(ax, ay, az, ctx, 0.1, false)) {
            a.active = true;
            a.habitat = tc.habitat;
            if (a.habitat === 'building') activeBuildingAnts++;
            a.trailCenterX = tc.x;
            a.trailCenterZ = tc.z;
            a.trailAngle = angle;
            a.x = ax;
            a.z = az;
            a.y = ay;
            a.spawnBlend = 0.05;
            antsSpawned++;
            this.recordDynamicSpawn('ant', ax, ay, az, ctx, 0.1);
          }
        }
      }
      if (!a.active) continue;

      a.spawnBlend = Math.min(1, a.spawnBlend + dt * 2.4);
      const trailR = 1.2 + (i % 2) * 0.5;
      a.trailAngle += (a.speed / trailR) * dt;
      const prevX = a.x;
      const prevZ = a.z;
      a.x = a.trailCenterX + Math.cos(a.trailAngle) * trailR + Math.sin(a.trailAngle * 3.0) * 0.14;
      a.z = a.trailCenterZ + Math.sin(a.trailAngle) * trailR + Math.cos(a.trailAngle * 2.0) * 0.14;
      a.y = this.sampleGroundHeight(a.x, a.z);
      a.yaw = Math.atan2(a.x - prevX, a.z - prevZ);

      _dummy.position.set(a.x, a.y + 0.004, a.z);
      _dummy.rotation.set(0, a.yaw, 0);
      _dummy.scale.setScalar(a.spawnBlend);
      _dummy.updateMatrix();
      this.antMesh.setMatrixAt(antCount, _dummy.matrix);
      antCount++;
    }
    this.antMesh.count = antCount;
    if (antCount > 0) this.antMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Read-only test/diagnostic helpers for verifying pack states, unseen spawns, and insects.
   */
  public getWolfPackStates(): Array<{ id: string; state: WolfPackState; aliveCount: number }> {
    return this.wolfPacks.map((p) => ({
      id: p.id,
      state: p.state,
      aliveCount: p.members.filter((m) => m.alive).length,
    }));
  }

  public getDeerHerdStates(): Array<{ id: string; state: DeerHerdState; aliveCount: number }> {
    return this.deerHerds.map((h) => ({
      id: h.id,
      state: h.state,
      aliveCount: h.members.filter((m) => m.alive).length,
    }));
  }

  public getRecentDynamicSpawns(): ReadonlyArray<DynamicSpawnAuditEntry> {
    return this.recentDynamicSpawns;
  }

  /** Places an insect deterministically (used in unit tests for boot squish verification). */
  public debugPlaceInsectAt(index: number, x: number, y: number, z: number, isSpider: boolean): void {
    const pool = isSpider ? this.spiders : this.ants;
    const ins = pool[index % pool.length];
    ins.active = true;
    ins.squishedTimer = 0;
    ins.spawnBlend = 1;
    ins.x = x;
    ins.y = y;
    ins.z = z;
  }

  public getTelemetry(): WildlifeSummaryTelemetry {
    let aliveWolves = 0;
    let aliveDeer = 0;
    let harvestableCarcasses = 0;

    for (const rec of this.entitiesById.values()) {
      if (rec.entity.alive) {
        if (rec.kind === 'wolf') aliveWolves++;
        else aliveDeer++;
      } else if (!rec.entity.harvested) {
        harvestableCarcasses++;
      }
    }

    return {
      activeWolfPacks: this.wolfPacks.length,
      aliveWolves,
      aliveDeer,
      activeFrogs: this.frogMesh.count,
      activeButterflies: this.butterflyMesh.count,
      activeInsects: this.spiderMesh.count + this.antMesh.count,
      totalSquishedInsects: this.totalSquishedInsects,
      bootGrime01: this.bootGrime01,
      harvestableCarcasses,
    };
  }

  public dispose(): void {
    for (let i = this.wolfPacks.length - 1; i >= 0; i--) {
      this.despawnWolfPack(i);
    }
    for (let i = this.deerHerds.length - 1; i >= 0; i--) {
      this.despawnDeerHerd(i);
    }
    this.entitiesById.clear();
    this.hitMeshes.length = 0;

    this.frogMesh.dispose();
    this.butterflyMesh.dispose();
    this.spiderMesh.dispose();
    this.antMesh.dispose();
    this.splatMesh.dispose();

    for (let i = 0; i < this.sharedGeos.length; i++) this.sharedGeos[i].dispose();
    for (let i = 0; i < this.sharedMats.length; i++) this.sharedMats[i].dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;

    this.scene.remove(this.rootGroup);
  }
}

export { WildlifeManager as OpenWorldWildlifeManager };


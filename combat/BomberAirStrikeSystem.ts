import * as THREE from 'three';
import { BodycamAudio } from '../bodycam-sdk/BodycamAudio';
import {
  ActiveAirStrikeSummary,
  ENABLE_CONQUEST_FIRE_SUPPORT,
  GameAirStrikeLaunchPacket,
  TeamFireSupportState,
} from '../data/multiplayer';
import {
  MortarEmplacementSystem,
  MortarExclusionZone,
  MortarFriendlyPosition,
} from './MortarEmplacementSystem';

export const MAX_BOMBER_POOL = 2; // Hard cap: 1 pooled tactical strike jet per team
export const AIR_STRIKE_COOLDOWN_SEC = 150;
export const AIR_STRIKE_CORRIDOR_LENGTH_M = 65;
export const AIR_STRIKE_DANGER_CLOSE_RADIUS_M = 45;
export const AIR_STRIKE_HQ_EXCLUSION_RADIUS_M = 65;
export const AIR_STRIKE_BOMB_COUNT = 6;
export const AIR_STRIKE_BOMB_RELEASE_INTERVAL_SEC = 0.16;
export const AIR_STRIKE_BLAST_RADIUS_M = 16.5;
export const AIR_STRIKE_BLAST_MAX_DAMAGE = 165;
export const AIR_STRIKE_SECTOR_CONTROL_MIN_RATIO = 0.5;
export const AIR_STRIKE_MAX_TRIANGLES_PER_AIRCRAFT = 3500;
export const AIR_STRIKE_FLIGHT_ALTITUDE_M = 58;
export const AIR_STRIKE_APPROACH_DIST_M = 250;
export const AIR_STRIKE_EGRESS_DIST_M = 270;
export const AIR_STRIKE_TOTAL_DURATION_SEC = 6.2;
export const AIR_STRIKE_BOMB_FLIGHT_SEC = 1.15;
const AIR_STRIKE_GRAVITY_MPS2 = 9.81;

const FLARES_PER_STRIKE = 3;
const PUFFS_PER_FLARE = 6;
const MAX_FLARE_CANISTERS = MAX_BOMBER_POOL * FLARES_PER_STRIKE; // 6
const MAX_FLARE_PUFFS = MAX_FLARE_CANISTERS * PUFFS_PER_FLARE; // 36

export interface CorridorEndpoints {
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  dirX: number;
  dirZ: number;
  lengthM: number;
}

export interface CorridorDangerCloseResult {
  dangerClose: boolean;
  minFriendlyDistM: number;
  friendliesInZone: number;
}

export interface DeterministicBombDrop {
  index: number;
  releaseTimeSec: number;
  flightTimeSec: number;
  impactTimeSec: number;
  releaseX: number;
  releaseY: number;
  releaseZ: number;
  velX: number;
  velY: number;
  velZ: number;
  impactX: number;
  impactY: number;
  impactZ: number;
}

export interface AirStrikeTargetEvaluation {
  sectorsHeld: number;
  totalSectors: number;
  hasSectorControl: boolean;
  inHqExclusion: boolean;
  airspaceBusy: boolean;
  cooldownSec: number;
  dangerClose: boolean;
  minFriendlyDistM: number;
  canCall: boolean;
  blockReason: string | null;
}

export interface AirStrikeRequestResult {
  ok: boolean;
  strikeId?: string;
  dangerClose: boolean;
  minFriendlyDistM: number;
  reason?: string;
  packet?: GameAirStrikeLaunchPacket;
}

export interface AirStrikeRadioEvent {
  strikeId: string;
  team: 'A' | 'B';
  callerName: string;
  headingDeg: number;
  message: string;
  dangerClose: boolean;
  centerX: number;
  centerZ: number;
}

export interface TeamAirStrikeState {
  team: 'A' | 'B';
  airStrikeCooldownSec: number;
  airStrikeMaxCooldownSec: number;
  activeStrike: boolean;
  activeStrikeId: string | null;
  activeBomberId: string | null;
  callerPlayerId: string | null;
  callerName: string;
}

interface PooledBomberSlot {
  slotIndex: number;
  team: 'A' | 'B';
  bomberId: string;
  root: THREE.Group;
  triangleCount: number;
  active: boolean;
  strikeId: string;
  callerId: string;
  callerName: string;
  centerX: number;
  centerZ: number;
  headingRad: number;
  corridorLengthM: number;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
  dirX: number;
  dirZ: number;
  baseGroundY: number;
  seed: number;
  elapsedSec: number;
  totalDurationSec: number;
  bombPlan: DeterministicBombDrop[];
  nextBombIndex: number;
  aircraftX: number;
  aircraftY: number;
  aircraftZ: number;
  flarePositions: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

interface ColoredGeoPart {
  geo: THREE.BufferGeometry;
  color: number;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

// Reusable zero-GC scratch math objects
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Exact 2D analytical point-to-segment distance between point (px, pz) and line segment [(ax, az), (bx, bz)].
 */
export function pointToSegmentDistance2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-8) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  const projX = ax + t * dx;
  const projZ = az + t * dz;
  return Math.hypot(px - projX, pz - projZ);
}

/**
 * Computes the 65m bombing corridor endpoints centered at (centerX, centerZ) along headingRad.
 * Convention matches Conquest maps & TacticalPdaDevice: heading 0 = North (-Z), +PI/2 = East (+X).
 */
export function computeCorridorEndpoints(
  centerX: number,
  centerZ: number,
  headingRad: number,
  lengthM = AIR_STRIKE_CORRIDOR_LENGTH_M,
): CorridorEndpoints {
  const dirX = Math.sin(headingRad);
  const dirZ = -Math.cos(headingRad);
  const half = lengthM * 0.5;
  return {
    startX: centerX - dirX * half,
    startZ: centerZ - dirZ * half,
    endX: centerX + dirX * half,
    endZ: centerZ + dirZ * half,
    dirX,
    dirZ,
    lengthM,
  };
}

/**
 * Evaluates exact 45m Danger Close distance along the entire 65m bombing corridor segment.
 */
export function evaluateCorridorDangerClose(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  friendlyPositions: readonly MortarFriendlyPosition[],
  radiusM = AIR_STRIKE_DANGER_CLOSE_RADIUS_M,
): CorridorDangerCloseResult {
  let minFriendlyDistM = Infinity;
  let friendliesInZone = 0;
  for (let i = 0; i < friendlyPositions.length; i++) {
    const f = friendlyPositions[i];
    const d = pointToSegmentDistance2D(f.x, f.z, startX, startZ, endX, endZ);
    if (d < minFriendlyDistM) minFriendlyDistM = d;
    if (d <= radiusM) friendliesInZone++;
  }
  return {
    dangerClose: friendliesInZone > 0,
    minFriendlyDistM: Number.isFinite(minFriendlyDistM) ? minFriendlyDistM : Infinity,
    friendliesInZone,
  };
}

/**
 * Evaluates whether any point along the 65m bombing corridor segment overlaps either team's 65m HQ exclusion cylinder.
 */
export function isCorridorInHqExclusion(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  exclusionZones: readonly MortarExclusionZone[],
  radiusM = AIR_STRIKE_HQ_EXCLUSION_RADIUS_M,
): boolean {
  for (let i = 0; i < exclusionZones.length; i++) {
    const zZone = exclusionZones[i];
    if (zZone.kind !== 'hq') continue;
    const d = pointToSegmentDistance2D(zZone.x, zZone.z, startX, startZ, endX, endZ);
    if (d <= Math.max(radiusM, zZone.radiusM)) {
      return true;
    }
  }
  return false;
}

/** Deterministic Mulberry32 PRNG for synchronized host/client 6-bomb corridors. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Computes the deterministic 6-bomb release & ground impact plan along a 65m corridor (~13m spacing, 0.16s interval).
 * Host and remote clients invoking this with the same packet parameters produce bit-identical coordinates.
 */
export function computeDeterministicBombPlan(opts: {
  centerX: number;
  centerZ: number;
  headingRad: number;
  corridorLengthM?: number;
  seed: number;
  baseGroundY: number;
  getGroundHeight?: (x: number, z: number) => number;
  totalDurationSec?: number;
}): DeterministicBombDrop[] {
  const lengthM = opts.corridorLengthM ?? AIR_STRIKE_CORRIDOR_LENGTH_M;
  const totalDurationSec = opts.totalDurationSec ?? AIR_STRIKE_TOTAL_DURATION_SEC;
  const endpoints = computeCorridorEndpoints(opts.centerX, opts.centerZ, opts.headingRad, lengthM);
  const rightX = -endpoints.dirZ;
  const rightZ = endpoints.dirX;
  const rng = mulberry32(opts.seed);
  const getGround = opts.getGroundHeight ?? (() => opts.baseGroundY);

  // Release starts ~35% into total flyby duration so the jet sweeps overhead while dropping 6 bombs over ~0.8s
  const firstReleaseTimeSec = totalDurationSec * 0.34;
  const cruiseAltY = opts.baseGroundY + AIR_STRIKE_FLIGHT_ALTITUDE_M;
  const plan: DeterministicBombDrop[] = [];

  for (let i = 0; i < AIR_STRIKE_BOMB_COUNT; i++) {
    const frac = AIR_STRIKE_BOMB_COUNT > 1 ? i / (AIR_STRIKE_BOMB_COUNT - 1) : 0.5;
    const alongOffset = (frac - 0.5) * lengthM;
    const longJitter = (rng() - 0.5) * 2.2;
    const latJitter = (rng() - 0.5) * 4.6;

    const impactX = opts.centerX + endpoints.dirX * (alongOffset + longJitter) + rightX * latJitter;
    const impactZ = opts.centerZ + endpoints.dirZ * (alongOffset + longJitter) + rightZ * latJitter;
    const impactY = getGround(impactX, impactZ);

    const releaseTimeSec = Number((firstReleaseTimeSec + i * AIR_STRIKE_BOMB_RELEASE_INTERVAL_SEC).toFixed(4));
    const flightTimeSec = AIR_STRIKE_BOMB_FLIGHT_SEC;
    const impactTimeSec = Number((releaseTimeSec + flightTimeSec).toFixed(4));

    // Compute exact aircraft position at releaseTimeSec so bombs visually drop from the fuselage pylons
    const releaseProgress = Math.max(0, Math.min(1, releaseTimeSec / totalDurationSec));
    const totalPathDist = AIR_STRIKE_APPROACH_DIST_M + lengthM + AIR_STRIKE_EGRESS_DIST_M;
    const pathOffsetM = -AIR_STRIKE_APPROACH_DIST_M - lengthM * 0.5 + releaseProgress * totalPathDist;
    const releaseX = opts.centerX + endpoints.dirX * pathOffsetM;
    const releaseZ = opts.centerZ + endpoints.dirZ * pathOffsetM;
    const releaseY = cruiseAltY - 1.2;

    // Exact kinematic initial velocity so sampleMortarArcPosition (G = 9.81, wind = 0) lands on (impactX, impactY, impactZ)
    const velX = (impactX - releaseX) / flightTimeSec;
    const velZ = (impactZ - releaseZ) / flightTimeSec;
    const velY = (impactY - releaseY + 0.5 * AIR_STRIKE_GRAVITY_MPS2 * flightTimeSec * flightTimeSec) / flightTimeSec;

    plan.push({
      index: i,
      releaseTimeSec,
      flightTimeSec,
      impactTimeSec,
      releaseX: Number(releaseX.toFixed(3)),
      releaseY: Number(releaseY.toFixed(3)),
      releaseZ: Number(releaseZ.toFixed(3)),
      velX: Number(velX.toFixed(3)),
      velY: Number(velY.toFixed(3)),
      velZ: Number(velZ.toFixed(3)),
      impactX: Number(impactX.toFixed(3)),
      impactY: Number(impactY.toFixed(3)),
      impactZ: Number(impactZ.toFixed(3)),
    });
  }

  return plan;
}

/** Deterministic string fingerprint for verifying identical host/client bomb corridors in tests. */
export function computeBombPlanHash(plan: readonly DeterministicBombDrop[]): string {
  return plan
    .map(
      (b) =>
        `${b.index}:${b.releaseTimeSec.toFixed(2)}:${b.impactX.toFixed(2)},${b.impactZ.toFixed(2)}`,
    )
    .join('|');
}

function formatCooldownMmSs(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function headingRadToMagneticDeg(headingRad: number): number {
  const deg = Math.round(((THREE.MathUtils.radToDeg(headingRad) % 360) + 360) % 360);
  return deg === 360 ? 0 : deg;
}

function mergeColoredParts(parts: readonly ColoredGeoPart[]): THREE.BufferGeometry {
  let totalVerts = 0;
  const prepared: Array<{ geo: THREE.BufferGeometry; color: THREE.Color }> = [];
  const tmpMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpEuler = new THREE.Euler();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const cloned = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.pos || p.rot || p.scale) {
      tmpPos.set(p.pos?.[0] ?? 0, p.pos?.[1] ?? 0, p.pos?.[2] ?? 0);
      tmpEuler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.set(p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.scale?.[2] ?? 1);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      cloned.applyMatrix4(tmpMat);
    }
    if (!cloned.getAttribute('normal')) {
      cloned.computeVertexNormals();
    }
    const posAttr = cloned.getAttribute('position');
    totalVerts += posAttr.count;
    prepared.push({ geo: cloned, color: new THREE.Color(p.color) });
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);

  let offset = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { geo, color } = prepared[i];
    const posAttr = geo.getAttribute('position');
    const normAttr = geo.getAttribute('normal');
    const count = posAttr.count;
    for (let v = 0; v < count; v++) {
      const idx = (offset + v) * 3;
      positions[idx] = posAttr.getX(v);
      positions[idx + 1] = posAttr.getY(v);
      positions[idx + 2] = posAttr.getZ(v);
      normals[idx] = normAttr.getX(v);
      normals[idx + 1] = normAttr.getY(v);
      normals[idx + 2] = normAttr.getZ(v);
      colors[idx] = color.r;
      colors[idx + 1] = color.g;
      colors[idx + 2] = color.b;
    }
    offset += count;
    geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

export function countGeometryTriangles(geo: THREE.BufferGeometry): number {
  if (geo.index) return Math.floor(geo.index.count / 3);
  const pos = geo.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

export function countObjectTriangles(root: THREE.Object3D): number {
  let tris = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat) ? mat.every((m) => !m.visible) : !mat.visible) return;
    const base = countGeometryTriangles(mesh.geometry);
    const inst = obj as THREE.InstancedMesh;
    tris += inst.isInstancedMesh ? base * inst.count : base;
  });
  return tris;
}

/**
 * Builds a procedural composite twin-engine tactical Close Air Support strike jet (A-10 / Su-25 silhouette).
 * Batched into 5 material-grouped meshes (~1,500 triangles total, strictly < 3,500 tris, castShadow = false).
 * Forward nose aligns along -Z so headingRad=0 faces North cleanly.
 */
export function buildStrikeJetRig(
  team: 'A' | 'B',
  disposables: Array<{ dispose: () => void }> = [],
): { root: THREE.Group; triangleCount: number; disposables: Array<{ dispose: () => void }> } {
  const root = new THREE.Group();
  root.name = `StrikeJet_${team}`;

  const airframeBase = team === 'A' ? 0x5c6670 : 0x54594c;
  const airframeDark = team === 'A' ? 0x3b434b : 0x393d34;
  const teamStripe = team === 'A' ? 0x6ba6d9 : 0xc96444;
  const gunmetal = 0x2d3238;
  const ordnanceOlive = 0x4b5738;

  // 1. Matte armored airframe (fuselage, nose cone, straight high-lift wings, horizontal stabilizer, twin vertical tail fins)
  const rawFuselage = new THREE.CylinderGeometry(0.68, 0.56, 10.2, 8);
  const rawNose = new THREE.ConeGeometry(0.68, 3.0, 8);
  const rawTailCone = new THREE.ConeGeometry(0.56, 2.6, 8);
  const rawWing = new THREE.BoxGeometry(15.6, 0.24, 2.35);
  const rawWingTip = new THREE.BoxGeometry(0.85, 0.22, 1.75);
  const rawHStab = new THREE.BoxGeometry(5.6, 0.16, 1.35);
  const rawVFin = new THREE.BoxGeometry(0.16, 2.15, 1.65);
  const rawPylon = new THREE.BoxGeometry(0.14, 0.42, 1.25);
  const rawStripe = new THREE.BoxGeometry(1.15, 0.26, 2.40);

  const airframeGeo = mergeColoredParts([
    // Main fuselage along Z (-Z is forward)
    { geo: rawFuselage, color: airframeBase, pos: [0, 0, 0.3], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawNose, color: airframeDark, pos: [0, -0.05, -6.3], rot: [-Math.PI * 0.5, 0, 0] },
    { geo: rawTailCone, color: airframeDark, pos: [0, 0.04, 6.7], rot: [Math.PI * 0.5, 0, 0] },
    // Straight high-lift CAS main wing + downturned winglets
    { geo: rawWing, color: airframeBase, pos: [0, -0.18, -0.35] },
    { geo: rawWingTip, color: airframeDark, pos: [-8.12, -0.34, -0.25], rot: [0, 0, 0.32] },
    { geo: rawWingTip, color: airframeDark, pos: [8.12, -0.34, -0.25], rot: [0, 0, -0.32] },
    // Team IFF wing bands
    { geo: rawStripe, color: teamStripe, pos: [-4.6, -0.17, -0.35] },
    { geo: rawStripe, color: teamStripe, pos: [4.6, -0.17, -0.35] },
    // Horizontal stabilizer + twin vertical tail fins (A-10 silhouette)
    { geo: rawHStab, color: airframeBase, pos: [0, 0.38, 6.45] },
    { geo: rawVFin, color: airframeDark, pos: [-2.75, 1.32, 6.55], rot: [0.12, 0, -0.08] },
    { geo: rawVFin, color: airframeDark, pos: [2.75, 1.32, 6.55], rot: [0.12, 0, 0.08] },
    // 6 Underwing ordnance pylons
    { geo: rawPylon, color: airframeDark, pos: [-5.6, -0.46, -0.35] },
    { geo: rawPylon, color: airframeDark, pos: [-3.4, -0.46, -0.35] },
    { geo: rawPylon, color: airframeDark, pos: [-1.8, -0.46, -0.35] },
    { geo: rawPylon, color: airframeDark, pos: [1.8, -0.46, -0.35] },
    { geo: rawPylon, color: airframeDark, pos: [3.4, -0.46, -0.35] },
    { geo: rawPylon, color: airframeDark, pos: [5.6, -0.46, -0.35] },
  ]);
  rawFuselage.dispose();
  rawNose.dispose();
  rawTailCone.dispose();
  rawWing.dispose();
  rawWingTip.dispose();
  rawHStab.dispose();
  rawVFin.dispose();
  rawPylon.dispose();
  rawStripe.dispose();

  const airframeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.22,
  });
  const airframeMesh = new THREE.Mesh(airframeGeo, airframeMat);
  airframeMesh.castShadow = false;
  airframeMesh.receiveShadow = false;

  // 2. Metallic twin dorsal turbofan nacelles + nose cannon + slung Mk-82 bombs
  const rawNacelle = new THREE.CylinderGeometry(0.56, 0.48, 3.8, 10);
  const rawMount = new THREE.BoxGeometry(1.15, 0.26, 1.35);
  const rawCannon = new THREE.CylinderGeometry(0.11, 0.13, 1.85, 6);
  const rawBomb = new THREE.CylinderGeometry(0.14, 0.11, 1.55, 6);

  const metalGeo = mergeColoredParts([
    // Twin rear-mounted turbofan nacelles above rear fuselage
    { geo: rawNacelle, color: gunmetal, pos: [-1.35, 0.88, 2.75], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawNacelle, color: gunmetal, pos: [1.35, 0.88, 2.75], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawMount, color: airframeDark, pos: [-0.82, 0.52, 2.65], rot: [0, 0, 0.45] },
    { geo: rawMount, color: airframeDark, pos: [0.82, 0.52, 2.65], rot: [0, 0, -0.45] },
    // GAU-8 rotary nose cannon barrel
    { geo: rawCannon, color: 0x202428, pos: [0, -0.32, -7.8], rot: [Math.PI * 0.5, 0, 0] },
    // 6 underwing Mk-82 aerial bombs
    { geo: rawBomb, color: ordnanceOlive, pos: [-5.6, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBomb, color: ordnanceOlive, pos: [-3.4, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBomb, color: ordnanceOlive, pos: [-1.8, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBomb, color: ordnanceOlive, pos: [1.8, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBomb, color: ordnanceOlive, pos: [3.4, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBomb, color: ordnanceOlive, pos: [5.6, -0.76, -0.35], rot: [Math.PI * 0.5, 0, 0] },
  ]);
  rawNacelle.dispose();
  rawMount.dispose();
  rawCannon.dispose();
  rawBomb.dispose();

  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.36,
    metalness: 0.80,
  });
  const metalMesh = new THREE.Mesh(metalGeo, metalMat);
  metalMesh.castShadow = false;
  metalMesh.receiveShadow = false;

  // 3. Smoked polycarbonate bubble canopy
  const canopyGeo = new THREE.SphereGeometry(0.58, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.52);
  canopyGeo.scale(0.95, 0.88, 2.75);
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x162430,
    roughness: 0.12,
    metalness: 0.86,
  });
  const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
  canopyMesh.position.set(0, 0.45, -3.25);
  canopyMesh.castShadow = false;
  canopyMesh.receiveShadow = false;

  // 4. Emissive turbofan exhaust glow + wingtip navigation strobes
  const rawBurner = new THREE.ConeGeometry(0.38, 1.65, 8);
  const rawStrobe = new THREE.SphereGeometry(0.14, 6, 4);
  const glowGeo = mergeColoredParts([
    { geo: rawBurner, color: 0xff9b38, pos: [-1.35, 0.88, 5.42], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawBurner, color: 0xff9b38, pos: [1.35, 0.88, 5.42], rot: [Math.PI * 0.5, 0, 0] },
    { geo: rawStrobe, color: 0xff3d2e, pos: [-8.3, -0.32, -0.25] },
    { geo: rawStrobe, color: 0x35e06b, pos: [8.3, -0.32, -0.25] },
  ]);
  rawBurner.dispose();
  rawStrobe.dispose();
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
  });
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.castShadow = false;
  glowMesh.receiveShadow = false;

  // 5. Twin wingtip aerodynamic contrail ribbons
  const rawTrail = new THREE.PlaneGeometry(0.28, 24.0);
  const contrailGeo = mergeColoredParts([
    { geo: rawTrail, color: 0xe2eaf2, pos: [-8.2, -0.35, 11.8], rot: [-Math.PI * 0.5, 0, 0] },
    { geo: rawTrail, color: 0xe2eaf2, pos: [8.2, -0.35, 11.8], rot: [-Math.PI * 0.5, 0, 0] },
  ]);
  rawTrail.dispose();
  const contrailMat = new THREE.MeshBasicMaterial({
    color: 0xe2eaf2,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const contrailMesh = new THREE.Mesh(contrailGeo, contrailMat);
  contrailMesh.castShadow = false;
  contrailMesh.receiveShadow = false;

  root.add(airframeMesh, metalMesh, canopyMesh, glowMesh, contrailMesh);
  disposables.push(
    airframeGeo,
    airframeMat,
    metalGeo,
    metalMat,
    canopyGeo,
    canopyMat,
    glowGeo,
    glowMat,
    contrailGeo,
    contrailMat,
  );

  const triangleCount = countObjectTriangles(root);
  return { root, triangleCount, disposables };
}

/**
 * Conquest Phase 4 Bomber Air Strike System.
 *
 * Enforces strict RX 480 hardware & multiplayer invariants:
 *  - Hard cap: MAX_BOMBER_POOL = 2 procedural twin-engine strike jets (1 per team, < 3,500 tris each, castShadow = false)
 *  - Zero CPU tick (0ms) when idle
 *  - Host-authoritative >=50% sector control gating, 150s team cooldown, 65m HQ exclusion overlap rejection, and concurrent airspace lock
 *  - Deterministic 6-bomb run along 65m corridor (~0.16s interval, ~13m spacing) routed through MortarEmplacementSystem's shared 16-slot ordnance pool, 24-slot FIFO scorch decals, 1 dynamic blast PointLight, and 12-voice audio pool
 *  - Pooled InstancedMesh corridor ground smoke flares (crimson-orange enemy / amber-gold friendly) + P0-protected Doppler jet roar
 */
export class BomberAirStrikeSystem {
  public readonly root = new THREE.Group();
  private enabled: boolean = ENABLE_CONQUEST_FIRE_SUPPORT;
  private isHost: boolean;
  private readonly mortarSystem: MortarEmplacementSystem;
  private readonly audio?: BodycamAudio;
  private readonly getGroundHeight: (x: number, z: number) => number;
  private readonly onLaunchBroadcast?: (packet: GameAirStrikeLaunchPacket) => void;
  private readonly onRadioCallout?: (event: AirStrikeRadioEvent) => void;

  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly bomberPool: [PooledBomberSlot, PooledBomberSlot];
  private readonly teamStates: Record<'A' | 'B', TeamAirStrikeState>;
  private readonly flareCanisterInst: THREE.InstancedMesh;
  private readonly flareSmokeInst: THREE.InstancedMesh;
  private readonly seenStrikeIds = new Set<string>();
  private strikeSeq = 1;
  private lastCpuMs = 0;
  private flaresVisible = false;

  constructor(opts: {
    scene: THREE.Scene;
    mortarSystem: MortarEmplacementSystem;
    isHost: boolean;
    audio?: BodycamAudio;
    getGroundHeight?: (x: number, z: number) => number;
    onLaunchBroadcast?: (packet: GameAirStrikeLaunchPacket) => void;
    onRadioCallout?: (event: AirStrikeRadioEvent) => void;
    enabled?: boolean;
  }) {
    this.isHost = opts.isHost;
    this.mortarSystem = opts.mortarSystem;
    this.audio = opts.audio;
    this.getGroundHeight = opts.getGroundHeight ?? (() => 0);
    this.onLaunchBroadcast = opts.onLaunchBroadcast;
    this.onRadioCallout = opts.onRadioCallout;
    this.enabled = opts.enabled ?? ENABLE_CONQUEST_FIRE_SUPPORT;

    this.root.name = 'ConquestBomberAirStrikes';
    this.root.visible = this.enabled;
    opts.scene.add(this.root);

    const rigA = buildStrikeJetRig('A', this.disposables);
    rigA.root.visible = false;
    this.root.add(rigA.root);

    const rigB = buildStrikeJetRig('B', this.disposables);
    rigB.root.visible = false;
    this.root.add(rigB.root);

    const makeSlot = (
      slotIndex: number,
      team: 'A' | 'B',
      rig: { root: THREE.Group; triangleCount: number },
    ): PooledBomberSlot => ({
      slotIndex,
      team,
      bomberId: `eagle_${team.toLowerCase()}_1`,
      root: rig.root,
      triangleCount: rig.triangleCount,
      active: false,
      strikeId: '',
      callerId: '',
      callerName: '',
      centerX: 0,
      centerZ: 0,
      headingRad: 0,
      corridorLengthM: AIR_STRIKE_CORRIDOR_LENGTH_M,
      startX: 0,
      startZ: 0,
      endX: 0,
      endZ: 0,
      dirX: 0,
      dirZ: -1,
      baseGroundY: 0,
      seed: 1,
      elapsedSec: 0,
      totalDurationSec: AIR_STRIKE_TOTAL_DURATION_SEC,
      bombPlan: [],
      nextBombIndex: 0,
      aircraftX: 0,
      aircraftY: AIR_STRIKE_FLIGHT_ALTITUDE_M,
      aircraftZ: 0,
      flarePositions: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    });

    this.bomberPool = [makeSlot(0, 'A', rigA), makeSlot(1, 'B', rigB)];

    this.teamStates = {
      A: {
        team: 'A',
        airStrikeCooldownSec: 0,
        airStrikeMaxCooldownSec: AIR_STRIKE_COOLDOWN_SEC,
        activeStrike: false,
        activeStrikeId: null,
        activeBomberId: null,
        callerPlayerId: null,
        callerName: '',
      },
      B: {
        team: 'B',
        airStrikeCooldownSec: 0,
        airStrikeMaxCooldownSec: AIR_STRIKE_COOLDOWN_SEC,
        activeStrike: false,
        activeStrikeId: null,
        activeBomberId: null,
        callerPlayerId: null,
        callerName: '',
      },
    };

    // Pooled InstancedMesh corridor ground smoke flares (2 draw calls total, zero per-frame allocations)
    const canisterGeo = new THREE.CylinderGeometry(0.11, 0.13, 0.34, 6);
    const canisterMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.flareCanisterInst = new THREE.InstancedMesh(canisterGeo, canisterMat, MAX_FLARE_CANISTERS);
    this.flareCanisterInst.name = 'AirStrikeFlareCanistersInst';
    this.flareCanisterInst.castShadow = false;
    this.flareCanisterInst.receiveShadow = false;
    this.flareCanisterInst.frustumCulled = false;
    this.flareCanisterInst.visible = false;

    const smokeGeo = new THREE.IcosahedronGeometry(0.95, 0);
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    });
    this.flareSmokeInst = new THREE.InstancedMesh(smokeGeo, smokeMat, MAX_FLARE_PUFFS);
    this.flareSmokeInst.name = 'AirStrikeFlareSmokeInst';
    this.flareSmokeInst.castShadow = false;
    this.flareSmokeInst.receiveShadow = false;
    this.flareSmokeInst.frustumCulled = false;
    this.flareSmokeInst.visible = false;

    for (let i = 0; i < MAX_FLARE_CANISTERS; i++) {
      this.flareCanisterInst.setMatrixAt(i, _zeroMatrix);
    }
    for (let i = 0; i < MAX_FLARE_PUFFS; i++) {
      this.flareSmokeInst.setMatrixAt(i, _zeroMatrix);
    }
    this.flareCanisterInst.instanceMatrix.needsUpdate = true;
    this.flareSmokeInst.instanceMatrix.needsUpdate = true;

    this.root.add(this.flareCanisterInst, this.flareSmokeInst);
    this.disposables.push(canisterGeo, canisterMat, smokeGeo, smokeMat);

    this.pushTeamStateToMortar('A');
    this.pushTeamStateToMortar('B');
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    this.root.visible = this.enabled;
    if (!this.enabled) {
      for (let i = 0; i < this.bomberPool.length; i++) {
        const slot = this.bomberPool[i];
        slot.active = false;
        slot.root.visible = false;
        slot.bombPlan = [];
      }
      for (const team of ['A', 'B'] as const) {
        const ts = this.teamStates[team];
        ts.activeStrike = false;
        ts.activeStrikeId = null;
        ts.activeBomberId = null;
        ts.callerPlayerId = null;
        ts.callerName = '';
        this.pushTeamStateToMortar(team);
      }
      this.clearAllFlares();
      this.lastCpuMs = 0;
    }
  }

  public setHostAuthority(isHost: boolean): void {
    this.isHost = isHost;
  }

  public getTeamAirStrikeState(team: 'A' | 'B'): TeamAirStrikeState {
    return { ...this.teamStates[team] };
  }

  public getActiveAirStrikeSummaries(): ActiveAirStrikeSummary[] {
    const out: ActiveAirStrikeSummary[] = [];
    for (let i = 0; i < this.bomberPool.length; i++) {
      const s = this.bomberPool[i];
      if (!s.active) continue;
      out.push({
        strikeId: s.strikeId,
        team: s.team,
        callerId: s.callerId,
        callerName: s.callerName,
        centerX: s.centerX,
        centerZ: s.centerZ,
        headingRad: s.headingRad,
        corridorLengthM: s.corridorLengthM,
        startX: s.startX,
        startZ: s.startZ,
        endX: s.endX,
        endZ: s.endZ,
        seed: s.seed,
        elapsedSec: s.elapsedSec,
        totalDurationSec: s.totalDurationSec,
        dangerClose: false,
        progress01: THREE.MathUtils.clamp(s.elapsedSec / Math.max(0.1, s.totalDurationSec), 0, 1),
        aircraftX: s.aircraftX,
        aircraftZ: s.aircraftZ,
      });
    }
    return out;
  }

  /**
   * Evaluates target corridor for live 3D TAC-PDA feedback (exact readiness & block messaging).
   */
  public evaluateAirStrikeTarget(opts: {
    team: 'A' | 'B';
    centerX: number;
    centerZ: number;
    headingRad: number;
    sectorsHeld: number;
    totalSectors: number;
    exclusionZones: readonly MortarExclusionZone[];
    friendlyPositions: readonly MortarFriendlyPosition[];
  }): AirStrikeTargetEvaluation {
    const endpoints = computeCorridorEndpoints(
      opts.centerX,
      opts.centerZ,
      opts.headingRad,
      AIR_STRIKE_CORRIDOR_LENGTH_M,
    );
    const dc = evaluateCorridorDangerClose(
      endpoints.startX,
      endpoints.startZ,
      endpoints.endX,
      endpoints.endZ,
      opts.friendlyPositions,
      AIR_STRIKE_DANGER_CLOSE_RADIUS_M,
    );
    const inHqExclusion = isCorridorInHqExclusion(
      endpoints.startX,
      endpoints.startZ,
      endpoints.endX,
      endpoints.endZ,
      opts.exclusionZones,
      AIR_STRIKE_HQ_EXCLUSION_RADIUS_M,
    );
    const ts = this.teamStates[opts.team];
    const hasSectorControl =
      opts.totalSectors > 0 &&
      opts.sectorsHeld / opts.totalSectors >= AIR_STRIKE_SECTOR_CONTROL_MIN_RATIO;

    let blockReason: string | null = null;
    if (!this.enabled) {
      blockReason = 'FIRE SUPPORT OFFLINE';
    } else if (!hasSectorControl) {
      blockReason = `REQUIRES >= 50% SECTORS (${opts.sectorsHeld}/${opts.totalSectors} HELD)`;
    } else if (ts.activeStrike) {
      blockReason = 'AIRSPACE BUSY — STRIKE INBOUND';
    } else if (inHqExclusion) {
      blockReason = 'HQ NO-FIRE ZONE (65M)';
    } else if (ts.airStrikeCooldownSec > 0.05) {
      blockReason = `AIR STRIKE COOLDOWN · ${formatCooldownMmSs(ts.airStrikeCooldownSec)}`;
    }

    return {
      sectorsHeld: opts.sectorsHeld,
      totalSectors: opts.totalSectors,
      hasSectorControl,
      inHqExclusion,
      airspaceBusy: ts.activeStrike,
      cooldownSec: ts.airStrikeCooldownSec,
      dangerClose: dc.dangerClose,
      minFriendlyDistM: dc.minFriendlyDistM,
      canCall: blockReason === null,
      blockReason,
    };
  }

  /**
   * Host-authoritative Bomber Air Strike dispatch:
   *  - Enforces >= 50% Conquest sector control
   *  - Enforces 150s team cooldown & airspace exclusivity (concurrent call returns "Airspace Busy — Strike Inbound" without burning cooldown)
   *  - Rejects any 65m corridor overlapping either team's 65m HQ exclusion cylinder (without burning cooldown)
   *  - Snapshots callerId & callerName, triggers P0 Doppler roar + corridor flares + radio callout, and emits GameAirStrikeLaunchPacket
   */
  public requestAirStrike(opts: {
    callerId: string;
    callerName: string;
    callerTeam: 'A' | 'B';
    centerX: number;
    centerZ: number;
    headingRad: number;
    sectorsHeld: number;
    totalSectors: number;
    exclusionZones: readonly MortarExclusionZone[];
    friendlyPositions: readonly MortarFriendlyPosition[];
    seed?: number;
  }): AirStrikeRequestResult {
    const evalRes = this.evaluateAirStrikeTarget({
      team: opts.callerTeam,
      centerX: opts.centerX,
      centerZ: opts.centerZ,
      headingRad: opts.headingRad,
      sectorsHeld: opts.sectorsHeld,
      totalSectors: opts.totalSectors,
      exclusionZones: opts.exclusionZones,
      friendlyPositions: opts.friendlyPositions,
    });

    if (!evalRes.canCall) {
      // Exact human-readable rejection reasons with ZERO cooldown consumption
      let reason = evalRes.blockReason ?? 'Air Strike Unavailable';
      if (evalRes.airspaceBusy) {
        reason = 'Airspace Busy — Strike Inbound';
      } else if (!evalRes.hasSectorControl) {
        reason = `Requires >= 50% Sectors (${opts.sectorsHeld}/${opts.totalSectors} Held)`;
      } else if (evalRes.inHqExclusion) {
        reason = 'Corridor Overlaps 65m HQ No-Fire Zone';
      } else if (evalRes.cooldownSec > 0.05) {
        reason = `Air Strike Cooldown (${formatCooldownMmSs(evalRes.cooldownSec)})`;
      }
      return {
        ok: false,
        dangerClose: evalRes.dangerClose,
        minFriendlyDistM: evalRes.minFriendlyDistM,
        reason,
      };
    }

    const seed =
      opts.seed !== undefined && Number.isFinite(opts.seed)
        ? (opts.seed >>> 0) || 1
        : (((Date.now() & 0xffffff) ^ (this.strikeSeq * 2654435761)) >>> 0) || 1;
    const strikeId = `as_${opts.callerTeam}_${this.strikeSeq++}_${seed & 0xffff}`;
    const endpoints = computeCorridorEndpoints(
      opts.centerX,
      opts.centerZ,
      opts.headingRad,
      AIR_STRIKE_CORRIDOR_LENGTH_M,
    );
    const packet: GameAirStrikeLaunchPacket = {
      type: 'game:air_strike_launch',
      strikeId,
      team: opts.callerTeam,
      callerId: opts.callerId,
      callerName: opts.callerName,
      centerX: opts.centerX,
      centerZ: opts.centerZ,
      headingRad: opts.headingRad,
      corridorLengthM: AIR_STRIKE_CORRIDOR_LENGTH_M,
      startX: endpoints.startX,
      startZ: endpoints.startZ,
      endX: endpoints.endX,
      endZ: endpoints.endZ,
      seed,
      totalDurationSec: AIR_STRIKE_TOTAL_DURATION_SEC,
      dangerClose: evalRes.dangerClose,
      ts: Date.now(),
    };

    const ts = this.teamStates[opts.callerTeam];
    ts.airStrikeCooldownSec = AIR_STRIKE_COOLDOWN_SEC;
    ts.airStrikeMaxCooldownSec = AIR_STRIKE_COOLDOWN_SEC;
    ts.activeStrike = true;
    ts.activeStrikeId = strikeId;
    ts.activeBomberId = this.bomberPool[opts.callerTeam === 'A' ? 0 : 1].bomberId;
    ts.callerPlayerId = opts.callerId;
    ts.callerName = opts.callerName;
    this.pushTeamStateToMortar(opts.callerTeam);

    this.activateStrikeFromPacket(packet, evalRes.dangerClose);
    this.onLaunchBroadcast?.(packet);

    return {
      ok: true,
      strikeId,
      dangerClose: evalRes.dangerClose,
      minFriendlyDistM: evalRes.minFriendlyDistM,
      packet,
    };
  }

  /** Replays a host-authoritative air-strike launch packet deterministically on remote clients. */
  public applyRemoteLaunchPacket(packet: GameAirStrikeLaunchPacket): void {
    if (!this.enabled) return;
    if (this.seenStrikeIds.has(packet.strikeId)) return;

    const ts = this.teamStates[packet.team];
    ts.activeStrike = true;
    ts.activeStrikeId = packet.strikeId;
    ts.activeBomberId = this.bomberPool[packet.team === 'A' ? 0 : 1].bomberId;
    ts.callerPlayerId = packet.callerId;
    ts.callerName = packet.callerName;
    if (ts.airStrikeCooldownSec <= 0) {
      ts.airStrikeCooldownSec = AIR_STRIKE_COOLDOWN_SEC;
    }
    this.pushTeamStateToMortar(packet.team);

    this.activateStrikeFromPacket(packet, false);
  }

  /** Applies host-authoritative team cooldown & airspace sync snapshot on non-host clients. */
  public applyRemoteSyncPacket(
    teams?: [TeamFireSupportState, TeamFireSupportState],
    activeAirStrikes?: ActiveAirStrikeSummary[],
  ): void {
    if (teams && teams.length === 2) {
      for (const incoming of teams) {
        if (incoming.team !== 'A' && incoming.team !== 'B') continue;
        const ts = this.teamStates[incoming.team];
        ts.airStrikeCooldownSec = Math.max(0, incoming.airStrikeCooldownSec);
        ts.airStrikeMaxCooldownSec = Math.max(1, incoming.airStrikeMaxCooldownSec || AIR_STRIKE_COOLDOWN_SEC);
        if (typeof incoming.activeStrike === 'boolean') {
          ts.activeStrike = incoming.activeStrike;
        } else {
          ts.activeStrike = Boolean(incoming.activeBomberId);
        }
        ts.activeBomberId = incoming.activeBomberId ?? null;
        ts.callerPlayerId = incoming.callerPlayerId ?? null;
        ts.activeStrikeId = incoming.activeStrikeId ?? null;
      }
    }

    if (Array.isArray(activeAirStrikes)) {
      // If a remote slot finished on host and is absent from snapshot, ensure local team lock matches
      const activeTeams = new Set<'A' | 'B'>();
      for (const s of activeAirStrikes) {
        activeTeams.add(s.team);
      }
      for (const team of ['A', 'B'] as const) {
        const slot = this.bomberPool[team === 'A' ? 0 : 1];
        if (!activeTeams.has(team) && !slot.active) {
          this.teamStates[team].activeStrike = false;
          this.teamStates[team].activeStrikeId = null;
          this.teamStates[team].activeBomberId = null;
        }
      }
    }
  }

  /**
   * Zero-GC per-frame update.
   * Fast-paths to ~0ms CPU when no aircraft are flying.
   */
  public update(
    dt: number,
    opts: {
      localPlayerPos?: Readonly<THREE.Vector3>;
      localPlayerTeam?: 'A' | 'B';
    } = {},
  ): void {
    if (!this.enabled) {
      this.lastCpuMs = 0;
      return;
    }

    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    const hasActiveA = this.bomberPool[0].active;
    const hasActiveB = this.bomberPool[1].active;
    const hasCooldownA = this.teamStates.A.airStrikeCooldownSec > 0;
    const hasCooldownB = this.teamStates.B.airStrikeCooldownSec > 0;

    // 0ms idle fast-path when no strikes are active and no cooldowns are counting down
    if (!hasActiveA && !hasActiveB && !hasCooldownA && !hasCooldownB) {
      this.lastCpuMs = 0;
      return;
    }

    const tStart = typeof performance !== 'undefined' ? performance.now() : 0;

    // Tick per-team 150s air-strike cooldowns
    if (hasCooldownA) {
      this.teamStates.A.airStrikeCooldownSec = Math.max(0, this.teamStates.A.airStrikeCooldownSec - safeDt);
      this.pushTeamStateToMortar('A');
    }
    if (hasCooldownB) {
      this.teamStates.B.airStrikeCooldownSec = Math.max(0, this.teamStates.B.airStrikeCooldownSec - safeDt);
      this.pushTeamStateToMortar('B');
    }

    if (!hasActiveA && !hasActiveB) {
      if (this.flaresVisible) {
        this.clearAllFlares();
      }
      this.lastCpuMs = typeof performance !== 'undefined' ? performance.now() - tStart : 0;
      return;
    }

    const localTeam = opts.localPlayerTeam ?? 'A';
    let anyActive = false;

    for (let i = 0; i < this.bomberPool.length; i++) {
      const slot = this.bomberPool[i];
      if (!slot.active) continue;

      slot.elapsedSec += safeDt;

      // Release deterministic bombs along the 65m corridor into MortarEmplacementSystem's shared 16-slot pool
      while (
        slot.nextBombIndex < slot.bombPlan.length &&
        slot.elapsedSec >= slot.bombPlan[slot.nextBombIndex].releaseTimeSec
      ) {
        const drop = slot.bombPlan[slot.nextBombIndex++];
        this.mortarSystem.spawnExternalOrdnance({
          shellId: `${slot.strikeId}_b${drop.index}`,
          sourceId: slot.bomberId,
          callerId: slot.callerId,
          callerName: slot.callerName,
          callerTeam: slot.team,
          weaponKind: 'bomber_air_strike',
          weaponName: 'BOMBER AIR STRIKE',
          origin: _vA.set(drop.releaseX, drop.releaseY, drop.releaseZ),
          vel: _vB.set(drop.velX, drop.velY, drop.velZ),
          impactPos: _vC.set(drop.impactX, drop.impactY, drop.impactZ),
          flightTimeSec: drop.flightTimeSec,
          blastRadiusM: AIR_STRIKE_BLAST_RADIUS_M,
          maxDamage: AIR_STRIKE_BLAST_MAX_DAMAGE,
          scaleMult: 1.55,
          windAffected: false,
        });
      }

      if (slot.elapsedSec >= slot.totalDurationSec) {
        slot.active = false;
        slot.root.visible = false;
        slot.bombPlan = [];
        const ts = this.teamStates[slot.team];
        if (ts.activeStrikeId === slot.strikeId) {
          ts.activeStrike = false;
          ts.activeStrikeId = null;
          ts.activeBomberId = null;
          ts.callerPlayerId = null;
          ts.callerName = '';
          this.pushTeamStateToMortar(slot.team);
        }
        continue;
      }

      anyActive = true;
      this.updateAircraftKinematics(slot);
    }

    if (anyActive) {
      this.updateCorridorFlares(localTeam);
    } else if (this.flaresVisible) {
      this.clearAllFlares();
    }

    this.lastCpuMs = typeof performance !== 'undefined' ? performance.now() - tStart : 0;
  }

  public getDiagnostics(): {
    enabled: boolean;
    maxPoolSize: number;
    activeAircraftCount: number;
    trianglesPerAircraft: number;
    totalPooledAircraftTriangles: number;
    lastCpuMs: number;
  } {
    let activeAircraftCount = 0;
    for (let i = 0; i < this.bomberPool.length; i++) {
      if (this.bomberPool[i].active) activeAircraftCount++;
    }
    const maxTris = Math.max(this.bomberPool[0].triangleCount, this.bomberPool[1].triangleCount);
    return {
      enabled: this.enabled,
      maxPoolSize: MAX_BOMBER_POOL,
      activeAircraftCount,
      trianglesPerAircraft: maxTris,
      totalPooledAircraftTriangles: this.bomberPool[0].triangleCount + this.bomberPool[1].triangleCount,
      lastCpuMs: this.lastCpuMs,
    };
  }

  public dispose(): void {
    this.clearAllFlares();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pushTeamStateToMortar(team: 'A' | 'B'): void {
    const ts = this.teamStates[team];
    this.mortarSystem.syncTeamAirStrikeState(team, {
      airStrikeCooldownSec: ts.airStrikeCooldownSec,
      airStrikeMaxCooldownSec: ts.airStrikeMaxCooldownSec,
      activeBomberId: ts.activeBomberId,
      activeStrike: ts.activeStrike,
      callerPlayerId: ts.callerPlayerId,
      activeStrikeId: ts.activeStrikeId,
    });
  }

  private activateStrikeFromPacket(packet: GameAirStrikeLaunchPacket, dangerClose: boolean): void {
    this.seenStrikeIds.add(packet.strikeId);
    if (this.seenStrikeIds.size > 64) {
      const oldest = this.seenStrikeIds.values().next().value;
      if (oldest) this.seenStrikeIds.delete(oldest);
    }

    const slot = this.bomberPool[packet.team === 'A' ? 0 : 1];
    const corridorLen = packet.corridorLengthM || AIR_STRIKE_CORRIDOR_LENGTH_M;
    const endpoints = computeCorridorEndpoints(
      packet.centerX,
      packet.centerZ,
      packet.headingRad,
      corridorLen,
    );
    const baseGroundY = this.getGroundHeight(packet.centerX, packet.centerZ);

    slot.active = true;
    slot.strikeId = packet.strikeId;
    slot.callerId = packet.callerId;
    slot.callerName = packet.callerName;
    slot.centerX = packet.centerX;
    slot.centerZ = packet.centerZ;
    slot.headingRad = packet.headingRad;
    slot.corridorLengthM = corridorLen;
    slot.startX = endpoints.startX;
    slot.startZ = endpoints.startZ;
    slot.endX = endpoints.endX;
    slot.endZ = endpoints.endZ;
    slot.dirX = endpoints.dirX;
    slot.dirZ = endpoints.dirZ;
    slot.baseGroundY = baseGroundY;
    slot.seed = packet.seed;
    slot.elapsedSec = 0;
    slot.totalDurationSec = packet.totalDurationSec || AIR_STRIKE_TOTAL_DURATION_SEC;
    slot.nextBombIndex = 0;
    slot.bombPlan = computeDeterministicBombPlan({
      centerX: packet.centerX,
      centerZ: packet.centerZ,
      headingRad: packet.headingRad,
      corridorLengthM: corridorLen,
      seed: packet.seed,
      baseGroundY,
      getGroundHeight: this.getGroundHeight,
      totalDurationSec: slot.totalDurationSec,
    });

    // Position 3 corridor ground smoke flares at start (0m), mid (32.5m), and end (65m)
    slot.flarePositions[0].set(
      endpoints.startX,
      this.getGroundHeight(endpoints.startX, endpoints.startZ),
      endpoints.startZ,
    );
    slot.flarePositions[1].set(packet.centerX, baseGroundY, packet.centerZ);
    slot.flarePositions[2].set(
      endpoints.endX,
      this.getGroundHeight(endpoints.endX, endpoints.endZ),
      endpoints.endZ,
    );

    slot.root.visible = true;
    this.updateAircraftKinematics(slot);

    // P0-protected Doppler turbofan jet flyby audio (steals lower-priority voices cleanly inside 12-voice pool)
    const flybyAudioPos = _vA.set(packet.centerX, baseGroundY + AIR_STRIKE_FLIGHT_ALTITUDE_M * 0.5, packet.centerZ);
    this.audio?.playBomberDopplerFlyby(flybyAudioPos, slot.totalDurationSec);

    // Tactical radio callout with magnetic heading
    const headingDeg = headingRadToMagneticDeg(packet.headingRad);
    const headingStr = String(headingDeg).padStart(3, '0');
    const message = `Eagle-1 inbound on heading ${headingStr}°, corridor hot`;
    this.onRadioCallout?.({
      strikeId: packet.strikeId,
      team: packet.team,
      callerName: packet.callerName,
      headingDeg,
      message,
      dangerClose,
      centerX: packet.centerX,
      centerZ: packet.centerZ,
    });
  }

  private updateAircraftKinematics(slot: PooledBomberSlot): void {
    const progress = THREE.MathUtils.clamp(slot.elapsedSec / Math.max(0.1, slot.totalDurationSec), 0, 1);
    const totalPathDist = AIR_STRIKE_APPROACH_DIST_M + slot.corridorLengthM + AIR_STRIKE_EGRESS_DIST_M;
    const pathOffsetM = -AIR_STRIKE_APPROACH_DIST_M - slot.corridorLengthM * 0.5 + progress * totalPathDist;

    // Smooth low-altitude CAS profile: shallow dive on approach, level bomb run across corridor, climbing bank on egress
    let altOffset = 0;
    let pitchRad = 0;
    let rollRad = 0;
    if (progress < 0.30) {
      const p = 1 - progress / 0.30;
      altOffset = p * p * 18;
      pitchRad = -0.07 * p;
      rollRad = Math.sin(progress * Math.PI * 2) * 0.08;
    } else if (progress > 0.62) {
      const e = (progress - 0.62) / 0.38;
      altOffset = e * e * 46;
      pitchRad = 0.28 * e;
      rollRad = (slot.team === 'A' ? 1 : -1) * Math.sin(e * Math.PI * 0.85) * 0.55;
    } else {
      // Level weapons-release pass across the 65m corridor
      pitchRad = 0.015;
      rollRad = Math.sin((progress - 0.30) * 14) * 0.04;
    }

    const ax = slot.centerX + slot.dirX * pathOffsetM;
    const az = slot.centerZ + slot.dirZ * pathOffsetM;
    const ay = slot.baseGroundY + AIR_STRIKE_FLIGHT_ALTITUDE_M + altOffset;

    slot.aircraftX = ax;
    slot.aircraftY = ay;
    slot.aircraftZ = az;

    slot.root.position.set(ax, ay, az);
    // Mesh nose faces -Z; rotating Y by -headingRad aligns -Z with (sin(h), 0, -cos(h))
    _euler.set(pitchRad, -slot.headingRad, rollRad, 'YXZ');
    slot.root.quaternion.setFromEuler(_euler);
  }

  private updateCorridorFlares(localPlayerTeam: 'A' | 'B'): void {
    this.flaresVisible = true;
    this.flareCanisterInst.visible = true;
    this.flareSmokeInst.visible = true;

    for (let i = 0; i < MAX_FLARE_CANISTERS; i++) {
      this.flareCanisterInst.setMatrixAt(i, _zeroMatrix);
    }
    for (let i = 0; i < MAX_FLARE_PUFFS; i++) {
      this.flareSmokeInst.setMatrixAt(i, _zeroMatrix);
    }

    _quat.identity();
    for (let s = 0; s < this.bomberPool.length; s++) {
      const slot = this.bomberPool[s];
      if (!slot.active) continue;

      const isFriendly = slot.team === localPlayerTeam;
      // Crimson-orange for enemy strikes, amber-gold for friendly strikes
      const canisterHex = isFriendly ? 0xffb830 : 0xff3b24;
      const smokeHex = isFriendly ? 0xe5aa3e : 0xd9482e;
      const fadeEnvelope =
        slot.elapsedSec > slot.totalDurationSec - 0.9
          ? Math.max(0, (slot.totalDurationSec - slot.elapsedSec) / 0.9)
          : Math.min(1, slot.elapsedSec * 3.5);

      for (let f = 0; f < FLARES_PER_STRIKE; f++) {
        const canisterIdx = s * FLARES_PER_STRIKE + f;
        const fp = slot.flarePositions[f];
        _scale.set(1, 1, 1);
        _mat4.compose(_vA.set(fp.x, fp.y + 0.17, fp.z), _quat, _scale);
        this.flareCanisterInst.setMatrixAt(canisterIdx, _mat4);
        _color.setHex(canisterHex);
        this.flareCanisterInst.setColorAt(canisterIdx, _color);

        // 6 animated billowing smoke puffs rising cleanly above each flare canister
        for (let p = 0; p < PUFFS_PER_FLARE; p++) {
          const puffIdx = canisterIdx * PUFFS_PER_FLARE + p;
          const cycle = (slot.elapsedSec * 0.72 + p / PUFFS_PER_FLARE + f * 0.17) % 1;
          const riseY = 0.45 + cycle * 9.5;
          const drift = cycle * 2.4;
          const puffScale = (0.45 + cycle * 1.85) * Math.sin(cycle * Math.PI) * fadeEnvelope;
          if (puffScale <= 0.03) continue;
          _scale.setScalar(puffScale);
          _mat4.compose(
            _vA.set(
              fp.x + Math.sin(cycle * 6.2 + p) * 0.55 + drift * 0.55,
              fp.y + riseY,
              fp.z + Math.cos(cycle * 5.4 + f) * 0.55 + drift * 0.35,
            ),
            _quat,
            _scale,
          );
          this.flareSmokeInst.setMatrixAt(puffIdx, _mat4);
          _color.setHex(smokeHex);
          this.flareSmokeInst.setColorAt(puffIdx, _color);
        }
      }
    }

    this.flareCanisterInst.instanceMatrix.needsUpdate = true;
    this.flareSmokeInst.instanceMatrix.needsUpdate = true;
    if (this.flareCanisterInst.instanceColor) this.flareCanisterInst.instanceColor.needsUpdate = true;
    if (this.flareSmokeInst.instanceColor) this.flareSmokeInst.instanceColor.needsUpdate = true;
  }

  private clearAllFlares(): void {
    this.flaresVisible = false;
    this.flareCanisterInst.visible = false;
    this.flareSmokeInst.visible = false;
    for (let i = 0; i < MAX_FLARE_CANISTERS; i++) {
      this.flareCanisterInst.setMatrixAt(i, _zeroMatrix);
    }
    for (let i = 0; i < MAX_FLARE_PUFFS; i++) {
      this.flareSmokeInst.setMatrixAt(i, _zeroMatrix);
    }
    this.flareCanisterInst.instanceMatrix.needsUpdate = true;
    this.flareSmokeInst.instanceMatrix.needsUpdate = true;
  }
}

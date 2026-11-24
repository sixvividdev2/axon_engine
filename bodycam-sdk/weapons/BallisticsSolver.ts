import * as THREE from 'three';
import {
  BALLISTIC_MATERIALS,
  BallisticMaterialId,
  computeCriticalRicochetDeg,
  mapSurfaceToBallisticMaterial,
} from '../../data/ballisticMaterials';
import { AmmoVariantDef } from '../../data/calibers';
import { classifyBallisticFlyby, SPEED_OF_SOUND_MPS } from '../BodycamAudio';
import { IBodycamAudioSource } from '../IBodycamAudioSource';
import {
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  createRaycastResult,
  IBodycamWorldAdapter,
} from '../types';

export type TerminalOutcome = 'ricochet' | 'fragment' | 'penetrate' | 'stop';

export const BALLISTIC_FLYBY_MAX_RADIUS_M = 4.5;

export interface BallisticFlybyPcaResult {
  triggered: boolean;
  t: number;
  missDistM: number;
  approachingAfter: boolean;
}

export interface BallisticFlybyContext {
  listenerHeadPos: Readonly<THREE.Vector3>;
  /** Optional listener right-vector (world space) used to determine left/right micro-flinch roll sign */
  listenerRightDir?: Readonly<THREE.Vector3>;
  audio?: IBodycamAudioSource;
  maxRadiusM?: number;
  onSupersonicNearMiss?: (
    flinchDeg: number,
    sideSign: number,
    speedMs: number,
    missDistM: number,
  ) => void;
}

const _pcaD = new THREE.Vector3();
const _pcaToHead = new THREE.Vector3();
const _pcaClosest = new THREE.Vector3();
const _pcaOffset = new THREE.Vector3();

/**
 * Zero-GC Point of Closest Approach (PCA) projection of listenerHeadPos onto segment [prevPos, currPos].
 * Triggers when the projectile passes closest approach (0 < t < 1, or transitions approaching -> receding)
 * and perpendicular miss distance r <= maxRadiusM (default 4.5m).
 */
export function evaluateBallisticFlybyPCA(
  prevPos: Readonly<THREE.Vector3>,
  currPos: Readonly<THREE.Vector3>,
  headPos: Readonly<THREE.Vector3>,
  maxRadiusM = BALLISTIC_FLYBY_MAX_RADIUS_M,
  wasApproaching = false,
  outClosestPos: THREE.Vector3 = _pcaClosest,
): BallisticFlybyPcaResult {
  _pcaD.subVectors(currPos, prevPos);
  const dLenSq = _pcaD.lengthSq();
  if (dLenSq < 1e-8) {
    outClosestPos.copy(currPos);
    return {
      triggered: false,
      t: 0,
      missDistM: headPos.distanceTo(currPos),
      approachingAfter: false,
    };
  }

  _pcaToHead.subVectors(headPos, prevPos);
  const rawT = _pcaToHead.dot(_pcaD) / dLenSq;
  const t = THREE.MathUtils.clamp(rawT, 0, 1);
  outClosestPos.copy(prevPos).addScaledVector(_pcaD, t);
  const missDistM = headPos.distanceTo(outClosestPos);

  // If rawT >= 1, head is still ahead of currPos (projectile approaching); if rawT < 1, projectile passed PCA
  const approachingAfter = rawT >= 1.0;
  const passedPCA = (rawT > 0 && rawT < 1) || (wasApproaching && rawT <= 0);
  const triggered = passedPCA && missDistM <= maxRadiusM;

  return {
    triggered,
    t,
    missDistM,
    approachingAfter,
  };
}

/**
 * Computes supersonic / caliber-scaled acoustic flyby capture radius (capped at maxRadiusM, default 4.5m).
 * Heavy supersonic rounds (.50 AE / 7.62mm) reach the full 4.5m shockwave cone; subsonic rounds have a tighter wake.
 */
export function computeBallisticFlybyRadiusM(
  speedMs: number,
  caliberMm = 5.56,
  energyJ = 1600,
  maxRadiusM = BALLISTIC_FLYBY_MAX_RADIUS_M,
): number {
  const cls = classifyBallisticFlyby(speedMs, 1.0, caliberMm, energyJ);
  return Math.min(maxRadiusM, cls.effectiveMaxRadiusM);
}

function inferCaliberMmFromAmmo(ammo: AmmoVariantDef | null): number {
  if (!ammo) return 5.56;
  const id = `${ammo.caliberId} ${ammo.id}`.toLowerCase();
  if (id.includes('50') || id.includes('127')) return 12.7;
  if (id.includes('12g') || id.includes('buck')) return 8.4;
  if (id.includes('338') || id.includes('858')) return 8.6;
  if (id.includes('45')) return 11.43;
  if (id.includes('9x')) return 9.0;
  if (id.includes('762') || id.includes('308') || id.includes('300')) return 7.62;
  if (id.includes('545')) return 5.45;
  if (id.includes('57')) return 5.7;
  return 5.56;
}

export interface BallisticImpactEvent {
  outcome: TerminalOutcome;
  ammo: AmmoVariantDef;
  weaponId: string;
  material: BallisticMaterialId;
  surface: BodycamSurfaceMaterial;
  object: THREE.Object3D | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  incomingDir: THREE.Vector3;
  outgoingDir: THREE.Vector3;
  impactSpeedMs: number;
  impactEnergyJ: number;
  grazingAngleDeg: number;
  distanceM: number;
  isFragment: boolean;
  bounceIndex: number;
  exitPoint: THREE.Vector3;
  penetrationThicknessM: number;
}

export interface BallisticShotParams {
  origin: Readonly<THREE.Vector3>;
  direction: Readonly<THREE.Vector3>;
  ammo: AmmoVariantDef;
  weaponId: string;
  barrelVelocityMult?: number;
  attachmentVelocityMult?: number;
  weaponSpreadMOA?: number;
  audio?: IBodycamAudioSource;
  /** True for local player's own shots (excluded from incoming flyby audio); false for AI / remote players */
  isLocalPlayer?: boolean;
  /** Optional explicit nominal projectile caliber in mm for flyby acoustic weight */
  caliberMm?: number;
}

interface PooledProjectile {
  active: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  muzzleOrigin: THREE.Vector3;
  vel: THREE.Vector3;
  massKg: number;
  bc: number;
  penetrationPower: number;
  ammo: AmmoVariantDef | null;
  weaponId: string;
  distanceTraveled: number;
  maxDistanceM: number;
  age: number;
  bouncesLeft: number;
  bounceCount: number;
  isFragment: boolean;
  isLocalPlayer: boolean;
  hasTriggeredFlyby: boolean;
  wasApproachingHead: boolean;
  caliberMm: number;
  audio: IBodycamAudioSource | undefined;
}

interface PooledSpark {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface PooledDecal {
  active: boolean;
  age: number;
  mesh: THREE.Mesh;
}

interface PooledTracer {
  active: boolean;
  life: number;
  mesh: THREE.Mesh;
}

const MAX_PROJECTILES = 96;
const MAX_SPARKS = 112;
const MAX_DECALS = 96;
const MAX_TRACERS = 64;
const GRAVITY_MPS2 = 9.81;
const AIR_DENSITY_SEA = 1.225;

export interface BallisticTrajectoryPoint {
  distanceM: number;
  yRelSightM: number;
  dropCm: number;
  dropMrad: number;
  velocityMs: number;
  energyJ: number;
  damageAtRange: number;
  damageRatio: number;
  tofMs: number;
  supersonic: boolean;
}

export interface BallisticRangeGate extends BallisticTrajectoryPoint {
  label: string;
}

export interface BallisticTrajectoryProfile {
  muzzleVelocityMs: number;
  muzzleEnergyJ: number;
  heightOverBoreM: number;
  zeroDistanceM: number;
  zeroElevationMrad: number;
  zeroPitchRad: number;
  nearZeroM: number | null;
  farZeroM: number | null;
  maxRangeM: number;
  points: BallisticTrajectoryPoint[];
  rangeGates: BallisticRangeGate[];
}

export interface ZeroSolveParams {
  muzzleVelocityMs: number;
  bc: number;
  heightOverBoreM: number;
  zeroDistanceM: number;
  extraElevationMrad?: number;
}

export interface TrajectorySimParams {
  ammo: AmmoVariantDef;
  barrelVelocityMult?: number;
  attachmentVelocityMult?: number;
  heightOverBoreM: number;
  zeroDistanceM: number;
  extraElevationMrad?: number;
  maxRangeM: number;
  sampleStepM?: number;
  baseDamage?: number;
}

export interface MaterialPenetrationParams {
  ammo: AmmoVariantDef;
  impactSpeedMs: number;
  material: BallisticMaterialId;
  thicknessM: number;
  obliquityDeg: number; // 0 = perpendicular head-on, 90 = parallel grazing
  barrelVelocityMult?: number;
  attachmentVelocityMult?: number;
}

export interface MaterialPenetrationResult {
  outcome: TerminalOutcome;
  material: BallisticMaterialId;
  impactSpeedMs: number;
  impactEnergyJ: number;
  exitSpeedMs: number;
  exitEnergyJ: number;
  exitDamageRatio: number;
  grazingAngleDeg: number;
  criticalRicochetDeg: number;
  penetrationDepthCm: number;
  effectiveThicknessCm: number;
  spallShards: number;
}

function computeG1DragFactor(speedMs: number, bc: number): number {
  const mach = speedMs / SPEED_OF_SOUND_MPS;
  let cd = 0.24;
  if (mach >= 0.85 && mach < 1.2) {
    const t = (mach - 0.85) / 0.35;
    cd = 0.24 + t * 0.34;
  } else if (mach >= 1.2) {
    cd = 0.58 / Math.pow(mach, 0.32);
  }
  return (0.5 * AIR_DENSITY_SEA * speedMs * cd * 0.00046) / Math.max(0.05, bc);
}

function computeCorePenMult(coreType: AmmoVariantDef['coreType'], matId: BallisticMaterialId): number {
  if (matId !== 'steel' && matId !== 'concrete') return 1.0;
  switch (coreType) {
    case 'tungsten_ap':
      return 1.22;
    case 'solid_steel':
      return 1.18;
    case 'steel_core_ap':
      return 1.05;
    case 'lead_fmj':
      return 0.86;
    case 'lead_jhp':
      return 0.52;
    case 'soft_lead':
      return 0.48;
    case 'frangible_pellet':
      return 0.30;
    default:
      return 1.0;
  }
}

/**
 * Pure 2D RK2 vertical ballistic integrator (identical drag/gravity kernel to live 3D projectiles).
 * Returns bullet vertical elevation relative to sightline (m) at `targetDistM`.
 */
function integrateYAtDistance(
  muzzleVelocityMs: number,
  bc: number,
  heightOverBoreM: number,
  launchPitchRad: number,
  targetDistM: number,
): number {
  let x = 0;
  let y = -Math.max(0.01, heightOverBoreM);
  let vx = Math.cos(launchPitchRad) * muzzleVelocityMs;
  let vy = Math.sin(launchPitchRad) * muzzleVelocityMs;
  const dt = 0.002;
  let t = 0;

  while (x < targetDistM && t < 5.0) {
    const spd1 = Math.hypot(vx, vy);
    if (spd1 < 25) break;
    const df1 = computeG1DragFactor(spd1, bc);
    const ax1 = -vx * df1;
    const ay1 = -GRAVITY_MPS2 - vy * df1;

    const vxMid = vx + ax1 * dt * 0.5;
    const vyMid = vy + ay1 * dt * 0.5;
    const spd2 = Math.hypot(vxMid, vyMid);
    const df2 = computeG1DragFactor(spd2, bc);
    const ax2 = -vxMid * df2;
    const ay2 = -GRAVITY_MPS2 - vyMid * df2;

    const prevX = x;
    const prevY = y;
    x += vxMid * dt;
    y += vyMid * dt;
    vx += ax2 * dt;
    vy += ay2 * dt;
    t += dt;

    if (x >= targetDistM) {
      const frac = (targetDistM - prevX) / Math.max(1e-6, x - prevX);
      return prevY + (y - prevY) * frac;
    }
  }
  return y;
}

/**
 * Solves exact bore upward pitch (radians) required for the bullet to cross the sightline
 * at `zeroDistanceM` given physical Height-Over-Bore, plus optional extra MRAD turret dial.
 */
export function solveZeroPitchRad(params: ZeroSolveParams): number {
  const v0 = Math.max(80, params.muzzleVelocityMs);
  const bc = Math.max(0.05, params.bc);
  const hob = Math.max(0.01, params.heightOverBoreM);
  const zeroDist = THREE.MathUtils.clamp(params.zeroDistanceM, 10, 1200);

  let lo = -0.02;
  let hi = 0.14;
  for (let iter = 0; iter < 18; iter++) {
    const mid = (lo + hi) * 0.5;
    const yAtZero = integrateYAtDistance(v0, bc, hob, mid, zeroDist);
    if (yAtZero < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const basePitch = (lo + hi) * 0.5;
  const turretRad = (params.extraElevationMrad ?? 0) * 0.001;
  return basePitch + turretRad;
}

/**
 * Maps terminal damage ratio (1.0 = peak muzzle lethality -> 0.0 = spent round)
 * to a military-grade Green -> Yellow -> Orange -> Red RGB tuple (0..1).
 */
export function sampleDamageColorRGB(damageRatio: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(damageRatio, 0, 1);
  if (t >= 0.66) {
    // Vivid tactical green (#22c55e) -> lime-yellow (#eab308)
    const u = (1.0 - t) / 0.34;
    out.setRGB(
      THREE.MathUtils.lerp(0.13, 0.92, u),
      THREE.MathUtils.lerp(0.88, 0.78, u),
      THREE.MathUtils.lerp(0.36, 0.10, u),
    );
  } else if (t >= 0.33) {
    // Yellow (#eab308) -> amber-orange (#f97316)
    const u = (0.66 - t) / 0.33;
    out.setRGB(
      THREE.MathUtils.lerp(0.92, 0.98, u),
      THREE.MathUtils.lerp(0.78, 0.44, u),
      THREE.MathUtils.lerp(0.10, 0.08, u),
    );
  } else {
    // Orange (#f97316) -> crimson red (#ef4444)
    const u = (0.33 - t) / 0.33;
    out.setRGB(
      THREE.MathUtils.lerp(0.98, 0.94, u),
      THREE.MathUtils.lerp(0.44, 0.16, u),
      THREE.MathUtils.lerp(0.08, 0.18, u),
    );
  }
  return out;
}

/**
 * Single Source of Truth trajectory profile shared by Gunsmith 3D Wireframe Ballistics Sim
 * and live BallisticsSolver firing.
 */
export function simulateTrajectoryProfile(params: TrajectorySimParams): BallisticTrajectoryProfile {
  const { ammo } = params;
  const v0 = BallisticsSolver.computeMuzzleVelocityMs(
    ammo,
    params.barrelVelocityMult ?? 1.0,
    params.attachmentVelocityMult ?? 1.0,
  );
  const massKg = Math.max(0.0005, ammo.bulletMassGrams * 0.001);
  const muzzleEnergyJ = 0.5 * massKg * v0 * v0;
  const hob = Math.max(0.015, params.heightOverBoreM);
  const zeroDist = Math.max(15, params.zeroDistanceM);
  const extraMrad = params.extraElevationMrad ?? 0;
  const maxRangeM = Math.max(50, params.maxRangeM);
  const stepM = Math.max(1, params.sampleStepM ?? Math.max(2, Math.round(maxRangeM / 120)));

  const zeroPitchRad = solveZeroPitchRad({
    muzzleVelocityMs: v0,
    bc: ammo.ballisticCoefficient,
    heightOverBoreM: hob,
    zeroDistanceM: zeroDist,
    extraElevationMrad: extraMrad,
  });

  const baseDamage =
    params.baseDamage ??
    THREE.MathUtils.clamp((muzzleEnergyJ / 38) * ammo.fleshExpansionMult, 24, 165);

  const makePoint = (distM: number, yRelSightM: number, spdMs: number, tofSec: number): BallisticTrajectoryPoint => {
    const energyJ = 0.5 * massKg * spdMs * spdMs;
    // Damage scales primarily with retained kinetic energy & velocity expansion threshold
    const velRatio = THREE.MathUtils.clamp(spdMs / Math.max(1, v0), 0, 1.1);
    const energyRatio = THREE.MathUtils.clamp(energyJ / Math.max(1, muzzleEnergyJ), 0, 1.1);
    const damageRatio = THREE.MathUtils.clamp(energyRatio * 0.72 + velRatio * 0.28, 0.08, 1.0);
    const dropCm = yRelSightM * 100;
    const dropMrad = distM > 1 ? (yRelSightM / distM) * 1000 : 0;
    return {
      distanceM: distM,
      yRelSightM,
      dropCm,
      dropMrad,
      velocityMs: spdMs,
      energyJ,
      damageAtRange: baseDamage * damageRatio,
      damageRatio,
      tofMs: tofSec * 1000,
      supersonic: spdMs >= SPEED_OF_SOUND_MPS,
    };
  };

  const points: BallisticTrajectoryPoint[] = [];
  points.push(makePoint(0, -hob, v0, 0));

  const gateDistances = [25, 50, 100, 150, 200, 300, 400, 500, 600, 800].filter((d) => d <= maxRangeM);
  if (gateDistances.length === 0 || gateDistances[gateDistances.length - 1] < maxRangeM) {
    gateDistances.push(maxRangeM);
  }
  const rangeGates: BallisticRangeGate[] = [];
  let nextGateIdx = 0;

  let x = 0;
  let y = -hob;
  let vx = Math.cos(zeroPitchRad) * v0;
  let vy = Math.sin(zeroPitchRad) * v0;
  let t = 0;
  const dt = 0.002;
  let nextSampleX = stepM;
  let nearZeroM: number | null = null;
  let farZeroM: number | null = null;

  while (x < maxRangeM && t < 5.5) {
    const spd1 = Math.hypot(vx, vy);
    if (spd1 < 35) break;
    const df1 = computeG1DragFactor(spd1, ammo.ballisticCoefficient);
    const ax1 = -vx * df1;
    const ay1 = -GRAVITY_MPS2 - vy * df1;

    const vxMid = vx + ax1 * dt * 0.5;
    const vyMid = vy + ay1 * dt * 0.5;
    const spd2 = Math.hypot(vxMid, vyMid);
    const df2 = computeG1DragFactor(spd2, ammo.ballisticCoefficient);
    const ax2 = -vxMid * df2;
    const ay2 = -GRAVITY_MPS2 - vyMid * df2;

    const prevX = x;
    const prevY = y;
    const prevSpd = spd1;
    const prevT = t;

    x += vxMid * dt;
    y += vyMid * dt;
    vx += ax2 * dt;
    vy += ay2 * dt;
    t += dt;
    const currSpd = Math.hypot(vx, vy);

    // Detect sightline zero crossings (y == 0)
    if (prevY < 0 && y >= 0 && nearZeroM === null) {
      const f = (0 - prevY) / Math.max(1e-6, y - prevY);
      nearZeroM = prevX + (x - prevX) * f;
    } else if (prevY > 0 && y <= 0 && farZeroM === null) {
      const f = (0 - prevY) / Math.max(1e-6, prevY - y);
      farZeroM = prevX + (x - prevX) * f;
    }

    while (nextGateIdx < gateDistances.length && x >= gateDistances[nextGateIdx]) {
      const gd = gateDistances[nextGateIdx];
      const f = THREE.MathUtils.clamp((gd - prevX) / Math.max(1e-6, x - prevX), 0, 1);
      const gy = prevY + (y - prevY) * f;
      const gSpd = prevSpd + (currSpd - prevSpd) * f;
      const gT = prevT + (t - prevT) * f;
      rangeGates.push({
        ...makePoint(gd, gy, gSpd, gT),
        label: `${gd}m`,
      });
      nextGateIdx++;
    }

    while (nextSampleX <= maxRangeM && x >= nextSampleX) {
      const f = THREE.MathUtils.clamp((nextSampleX - prevX) / Math.max(1e-6, x - prevX), 0, 1);
      const sy = prevY + (y - prevY) * f;
      const sSpd = prevSpd + (currSpd - prevSpd) * f;
      const sT = prevT + (t - prevT) * f;
      points.push(makePoint(nextSampleX, sy, sSpd, sT));
      nextSampleX += stepM;
    }
  }

  return {
    muzzleVelocityMs: v0,
    muzzleEnergyJ,
    heightOverBoreM: hob,
    zeroDistanceM: zeroDist,
    zeroElevationMrad: extraMrad,
    zeroPitchRad,
    nearZeroM,
    farZeroM,
    maxRangeM,
    points,
    rangeGates,
  };
}

/**
 * Deterministic Single-Source material penetration / ricochet / spall evaluation
 * using the exact same equations as `BallisticsSolver.resolveImpact`.
 */
export function simulateMaterialPenetration(params: MaterialPenetrationParams): MaterialPenetrationResult {
  const { ammo, impactSpeedMs, material } = params;
  const mat = BALLISTIC_MATERIALS[material];
  const v0 = BallisticsSolver.computeMuzzleVelocityMs(
    ammo,
    params.barrelVelocityMult ?? 1.0,
    params.attachmentVelocityMult ?? 1.0,
  );
  const massKg = Math.max(0.0005, ammo.bulletMassGrams * 0.001);
  const impactEnergyJ = 0.5 * massKg * impactSpeedMs * impactSpeedMs;
  const nominalKE = 0.5 * massKg * v0 * v0;
  const initialPenPower = ammo.penetrationRating * 68 + Math.pow(nominalKE / 1000, 0.65) * 26;

  const obliquityDeg = THREE.MathUtils.clamp(params.obliquityDeg, 0, 86);
  const grazingAngleDeg = 90 - obliquityDeg;
  const cosOb = Math.max(0.08, Math.cos(THREE.MathUtils.degToRad(obliquityDeg)));
  const effectiveThicknessM = Math.max(0.004, params.thicknessM / cosOb);
  const criticalRicochetDeg = computeCriticalRicochetDeg(mat, ammo.coreType, impactSpeedMs);

  // 0. Glass shatter pass-through
  if (material === 'glass') {
    const exitSpeedMs = impactSpeedMs * 0.88;
    const exitEnergyJ = 0.5 * massKg * exitSpeedMs * exitSpeedMs;
    return {
      outcome: 'penetrate',
      material,
      impactSpeedMs,
      impactEnergyJ,
      exitSpeedMs,
      exitEnergyJ,
      exitDamageRatio: exitEnergyJ / Math.max(1, impactEnergyJ),
      grazingAngleDeg,
      criticalRicochetDeg,
      penetrationDepthCm: effectiveThicknessM * 100,
      effectiveThicknessCm: effectiveThicknessM * 100,
      spallShards: 6,
    };
  }

  // 1. Grazing ricochet
  if (grazingAngleDeg <= criticalRicochetDeg && impactSpeedMs > 120) {
    const grazingBonus = (1 - grazingAngleDeg / Math.max(1, criticalRicochetDeg)) * 0.30;
    const retention = THREE.MathUtils.clamp(
      0.30 + mat.elasticityRetention * 0.25 + grazingBonus,
      0.30,
      0.65,
    );
    const exitSpeedMs = impactSpeedMs * retention;
    const exitEnergyJ = 0.5 * massKg * exitSpeedMs * exitSpeedMs;
    return {
      outcome: 'ricochet',
      material,
      impactSpeedMs,
      impactEnergyJ,
      exitSpeedMs,
      exitEnergyJ,
      exitDamageRatio: exitEnergyJ / Math.max(1, impactEnergyJ),
      grazingAngleDeg,
      criticalRicochetDeg,
      penetrationDepthCm: Math.min(effectiveThicknessM * 100, 0.6),
      effectiveThicknessCm: effectiveThicknessM * 100,
      spallShards: material === 'steel' ? 4 : 2,
    };
  }

  // 2. Penetration check (identical formula to live resolveImpact)
  const corePenMult = computeCorePenMult(ammo.coreType, material);
  const dynPen =
    initialPenPower *
    corePenMult *
    THREE.MathUtils.clamp(impactSpeedMs / Math.max(180, ammo.baseVelocityMs), 0.25, 1.35);
  const requiredPen = mat.penetrationResistance * (0.22 + effectiveThicknessM * 9.0);

  if (dynPen > requiredPen && effectiveThicknessM < 0.52) {
    const exitRatio = THREE.MathUtils.clamp(Math.sqrt(1 - requiredPen / dynPen), 0.28, 0.85);
    const exitSpeedMs = impactSpeedMs * exitRatio;
    const exitEnergyJ = 0.5 * massKg * exitSpeedMs * exitSpeedMs;
    return {
      outcome: 'penetrate',
      material,
      impactSpeedMs,
      impactEnergyJ,
      exitSpeedMs,
      exitEnergyJ,
      exitDamageRatio: exitEnergyJ / Math.max(1, impactEnergyJ),
      grazingAngleDeg,
      criticalRicochetDeg,
      penetrationDepthCm: effectiveThicknessM * 100,
      effectiveThicknessCm: effectiveThicknessM * 100,
      spallShards: material === 'steel' || material === 'concrete' ? 5 : 2,
    };
  }

  // 3. Fragment / spall check
  const fragileBullet =
    ammo.coreType === 'lead_jhp' ||
    ammo.coreType === 'soft_lead' ||
    (ammo.coreType === 'steel_core_ap' && ammo.bulletMassGrams <= 4.5 && impactSpeedMs > 780) ||
    (ammo.coreType === 'lead_fmj' && ammo.bulletMassGrams <= 4.5 && impactSpeedMs > 780);

  const penFrac = THREE.MathUtils.clamp(dynPen / Math.max(1, requiredPen), 0.05, 0.96);
  const partialDepthCm = effectiveThicknessM * 100 * penFrac;

  if (mat.spallTendency > 0.45 && fragileBullet && impactSpeedMs >= ammo.fragmentThresholdMs) {
    return {
      outcome: 'fragment',
      material,
      impactSpeedMs,
      impactEnergyJ,
      exitSpeedMs: 0,
      exitEnergyJ: 0,
      exitDamageRatio: 0,
      grazingAngleDeg,
      criticalRicochetDeg,
      penetrationDepthCm: partialDepthCm,
      effectiveThicknessCm: effectiveThicknessM * 100,
      spallShards: 4,
    };
  }

  // 4. Stop / embed
  return {
    outcome: 'stop',
    material,
    impactSpeedMs,
    impactEnergyJ,
    exitSpeedMs: 0,
    exitEnergyJ: 0,
    exitDamageRatio: 0,
    grazingAngleDeg,
    criticalRicochetDeg,
    penetrationDepthCm: partialDepthCm,
    effectiveThicknessCm: effectiveThicknessM * 100,
    spallShards: 0,
  };
}

export class BallisticsSolver {
  public readonly group = new THREE.Group();
  private readonly projectiles: PooledProjectile[] = [];
  private readonly sparks: PooledSpark[] = [];
  private readonly decals: PooledDecal[] = [];
  private readonly tracers: PooledTracer[] = [];

  private decalCursor = 0;
  private tracerCursor = 0;
  private sparkCursor = 0;

  private readonly decalGeo: THREE.PlaneGeometry;
  private readonly decalMatDark: THREE.MeshBasicMaterial;
  private readonly decalMatSteel: THREE.MeshBasicMaterial;
  private readonly decalMatWood: THREE.MeshBasicMaterial;
  private readonly tracerGeo: THREE.CylinderGeometry;
  private readonly tracerMat: THREE.MeshBasicMaterial;
  private readonly fragTracerMat: THREE.MeshBasicMaterial;
  private readonly sparkInstanced: THREE.InstancedMesh;
  private readonly sparkGeo: THREE.BoxGeometry;
  private readonly sparkMat: THREE.MeshBasicMaterial;

  // Pre-allocated zero-GC scratch variables
  private readonly _rayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _backHit: BodycamRaycastResult = createRaycastResult();
  private readonly _stepDelta = new THREE.Vector3();
  private readonly _stepDir = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();
  private readonly _refl = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _altUp = new THREE.Vector3(1, 0, 0);
  private readonly _accel1 = new THREE.Vector3();
  private readonly _velMid = new THREE.Vector3();
  private readonly _accel2 = new THREE.Vector3();
  private readonly _backOrigin = new THREE.Vector3();
  private readonly _backDir = new THREE.Vector3();
  private readonly _decalPos = new THREE.Vector3();
  private readonly _decalLook = new THREE.Vector3();
  private readonly _sparkMatrix = new THREE.Matrix4();
  private readonly _sparkQuat = new THREE.Quaternion();
  private readonly _sparkScale = new THREE.Vector3();
  private readonly _zeroScale = new THREE.Vector3(0, 0, 0);
  private readonly _tracerMid = new THREE.Vector3();

  private readonly _impactEvent: BallisticImpactEvent = {
    outcome: 'stop',
    ammo: null as unknown as AmmoVariantDef,
    weaponId: '',
    material: 'concrete',
    surface: 'concrete',
    object: null,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    incomingDir: new THREE.Vector3(),
    outgoingDir: new THREE.Vector3(),
    impactSpeedMs: 0,
    impactEnergyJ: 0,
    grazingAngleDeg: 0,
    distanceM: 0,
    isFragment: false,
    bounceIndex: 0,
    exitPoint: new THREE.Vector3(),
    penetrationThicknessM: 0,
  };

  constructor(scene?: THREE.Scene) {
    this.decalGeo = new THREE.PlaneGeometry(0.048, 0.048);
    this.decalMatDark = new THREE.MeshBasicMaterial({
      color: 0x161618,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.decalMatSteel = new THREE.MeshBasicMaterial({
      color: 0x9aa3ad,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.decalMatWood = new THREE.MeshBasicMaterial({
      color: 0x3b2818,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });

    this.tracerGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 5, 1, true);
    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffcf7a,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.fragTracerMat = new THREE.MeshBasicMaterial({
      color: 0xff8b42,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push({
        active: false,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        muzzleOrigin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        massKg: 0.008,
        bc: 0.25,
        penetrationPower: 20,
        ammo: null,
        weaponId: '',
        distanceTraveled: 0,
        maxDistanceM: 1200,
        age: 0,
        bouncesLeft: 2,
        bounceCount: 0,
        isFragment: false,
        isLocalPlayer: true,
        hasTriggeredFlyby: false,
        wasApproachingHead: false,
        caliberMm: 5.56,
        audio: undefined,
      });
    }

    this.sparkGeo = new THREE.BoxGeometry(0.004, 0.004, 0.065);
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffc668,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparkInstanced = new THREE.InstancedMesh(this.sparkGeo, this.sparkMat, MAX_SPARKS);
    this.sparkInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkInstanced.frustumCulled = false;

    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.2,
      });
      this._sparkMatrix.makeScale(0, 0, 0);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    this.sparkInstanced.instanceMatrix.needsUpdate = true;
    this.group.add(this.sparkInstanced);

    for (let i = 0; i < MAX_DECALS; i++) {
      const mesh = new THREE.Mesh(this.decalGeo, this.decalMatDark);
      mesh.visible = false;
      this.group.add(mesh);
      this.decals.push({ active: false, age: 0, mesh });
    }

    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ active: false, life: 0, mesh });
    }

    if (scene) {
      scene.add(this.group);
    }
  }

  /**
   * Computes true coupled muzzle velocity from cartridge base velocity, barrel length mult, and attachment mult.
   */
  public static computeMuzzleVelocityMs(
    ammo: AmmoVariantDef,
    barrelVelocityMult = 1.0,
    attachmentVelocityMult = 1.0,
  ): number {
    return ammo.baseVelocityMs * barrelVelocityMult * attachmentVelocityMult;
  }

  public spawnShot(params: BallisticShotParams): number {
    const { ammo } = params;
    const muzzleVel = BallisticsSolver.computeMuzzleVelocityMs(
      ammo,
      params.barrelVelocityMult ?? 1.0,
      params.attachmentVelocityMult ?? 1.0,
    );

    const totalMOA = Math.hypot(params.weaponSpreadMOA ?? 2.0, ammo.spreadMOA);
    const spreadRad = THREE.MathUtils.degToRad(totalMOA / 60);

    const refUp = Math.abs(params.direction.y) < 0.94 ? this._worldUp : this._altUp;
    this._right.crossVectors(params.direction, refUp).normalize();
    this._up.crossVectors(this._right, params.direction).normalize();

    const pelletCount = Math.max(1, ammo.pellets);
    const pelletMassGrams = ammo.bulletMassGrams;
    const massKg = pelletMassGrams * 0.001;
    const nominalKE = 0.5 * massKg * muzzleVel * muzzleVel;
    const initialPenPower = ammo.penetrationRating * 68 + Math.pow(nominalKE / 1000, 0.65) * 26;
    let spawned = 0;

    for (let i = 0; i < pelletCount; i++) {
      const slot = this.allocProjectile();
      if (!slot) break;

      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * spreadRad;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;

      this._stepDir
        .copy(params.direction)
        .addScaledVector(this._right, dx)
        .addScaledVector(this._up, dy)
        .normalize();

      slot.active = true;
      slot.pos.copy(params.origin);
      slot.prevPos.copy(params.origin);
      slot.muzzleOrigin.copy(params.origin);
      slot.vel.copy(this._stepDir).multiplyScalar(muzzleVel);
      slot.massKg = massKg;
      slot.bc = ammo.ballisticCoefficient;
      slot.penetrationPower = initialPenPower;
      slot.ammo = ammo;
      slot.weaponId = params.weaponId;
      slot.distanceTraveled = 0;
      slot.maxDistanceM = pelletCount > 1 ? 160 : 1200;
      slot.age = 0;
      slot.bouncesLeft = pelletCount > 1 ? 1 : 2;
      slot.bounceCount = 0;
      slot.isFragment = false;
      slot.isLocalPlayer = params.isLocalPlayer ?? true;
      slot.hasTriggeredFlyby = false;
      slot.wasApproachingHead = false;
      slot.caliberMm = params.caliberMm ?? inferCaliberMmFromAmmo(ammo);
      slot.audio = params.audio;
      spawned++;
    }

    return spawned;
  }

  /**
   * Direct segment PCA flyby evaluation for instant/tracer AI & remote player fire
   * so every incoming enemy shot passing within the supersonic/caliber-scaled radius (<= 4.5m)
   * triggers authentic supersonic crack/snap or subsonic whizz aligned to bullet time-of-flight
   * (producing the authentic crack-then-thump double report before the 343 m/s muzzle blast arrives).
   */
  public static triggerSegmentFlyby(
    origin: Readonly<THREE.Vector3>,
    endPos: Readonly<THREE.Vector3>,
    speedMs: number,
    caliberMm: number,
    energyJ: number,
    flybyCtx: BallisticFlybyContext,
  ): boolean {
    const baseMaxR = flybyCtx.maxRadiusM ?? BALLISTIC_FLYBY_MAX_RADIUS_M;
    const effectiveMaxR = computeBallisticFlybyRadiusM(speedMs, caliberMm, energyJ, baseMaxR);
    const pca = evaluateBallisticFlybyPCA(
      origin,
      endPos,
      flybyCtx.listenerHeadPos,
      effectiveMaxR,
      false,
      _pcaClosest,
    );
    if (!pca.triggered) return false;

    // Schedule flyby at bullet time-of-flight to closestPos for shots >= 18m away
    // so supersonic rounds (v > 343 m/s) strictly precede the 343 m/s distant muzzle report.
    const travelDistM = origin.distanceTo(_pcaClosest);
    const tofDelaySec = travelDistM >= 18 ? Math.min(2.0, travelDistM / Math.max(80, speedMs)) : 0;

    flybyCtx.audio?.playBallisticFlyby?.({
      closestPos: _pcaClosest,
      speedMs,
      missDistM: pca.missDistM,
      caliberMm,
      energyJ,
      muzzleOrigin: origin,
      delaySec: tofDelaySec,
    });

    const cls = classifyBallisticFlyby(speedMs, pca.missDistM, caliberMm, energyJ);
    if (cls.triggerMicroFlinch && flybyCtx.onSupersonicNearMiss) {
      let sideSign = 1;
      if (flybyCtx.listenerRightDir) {
        _pcaOffset.subVectors(_pcaClosest, flybyCtx.listenerHeadPos);
        sideSign = _pcaOffset.dot(flybyCtx.listenerRightDir) >= 0 ? 1 : -1;
      }
      flybyCtx.onSupersonicNearMiss(cls.flinchDeg, sideSign, speedMs, pca.missDistM);
    }
    return true;
  }

  public update(
    dt: number,
    world: IBodycamWorldAdapter,
    onImpact?: (event: Readonly<BallisticImpactEvent>) => void,
    flybyCtx?: BallisticFlybyContext,
  ): void {
    if (dt <= 0) return;

    // 1. Step live projectiles with RK2 G1 aerodynamic drag + swept raycast + PCA flyby detection
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = this.projectiles[i];
      if (!p.active || !p.ammo) continue;

      p.age += dt;
      if (p.age > 3.5 || p.distanceTraveled > p.maxDistanceM) {
        p.active = false;
        continue;
      }

      p.prevPos.copy(p.pos);

      // RK2 integration step
      this.computeAccel(p.vel, p.bc, this._accel1);
      this._velMid.copy(p.vel).addScaledVector(this._accel1, dt * 0.5);
      this.computeAccel(this._velMid, p.bc, this._accel2);

      this._stepDelta.copy(this._velMid).multiplyScalar(dt);
      const stepDist = this._stepDelta.length();
      if (stepDist < 1e-5) {
        p.active = false;
        continue;
      }

      this._stepDir.copy(this._stepDelta).divideScalar(stepDist);

      const hit = world.raycast(p.prevPos, this._stepDir, 0.002, stepDist + 0.015, this._rayHit);
      if (hit && this._rayHit.distance <= stepDist + 0.015) {
        p.pos.set(this._rayHit.pointX, this._rayHit.pointY, this._rayHit.pointZ);
        p.vel.addScaledVector(this._accel2, dt * (this._rayHit.distance / stepDist));
        p.distanceTraveled += this._rayHit.distance;
        this.checkProjectileFlyby(p, flybyCtx);
        this.spawnTracer(p.prevPos, p.pos, p.isFragment);
        this.resolveImpact(p, this._rayHit, world, onImpact);
      } else {
        p.pos.add(this._stepDelta);
        p.vel.addScaledVector(this._accel2, dt);
        p.distanceTraveled += stepDist;
        this.checkProjectileFlyby(p, flybyCtx);
        if (p.vel.lengthSq() < 2500) {
          // < 50 m/s spent round
          p.active = false;
          continue;
        }
        this.spawnTracer(p.prevPos, p.pos, p.isFragment);
      }
    }

    // 2. Step pooled sparks (InstancedMesh, zero allocations)
    let sparksDirty = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const s = this.sparks[i];
      if (!s.active) continue;
      sparksDirty = true;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        this._sparkMatrix.makeScale(0, 0, 0);
        this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
        continue;
      }
      s.vel.y -= GRAVITY_MPS2 * dt;
      s.vel.multiplyScalar(Math.max(0, 1 - dt * 2.8));
      s.pos.addScaledVector(s.vel, dt);

      const spd = s.vel.length();
      if (spd > 0.01) {
        this._stepDir.copy(s.vel).divideScalar(spd);
        this._sparkQuat.setFromUnitVectors(this._worldUp, this._stepDir);
      }
      const stretch = THREE.MathUtils.clamp(spd * 0.04, 0.4, 2.2) * (s.life / s.maxLife);
      this._sparkScale.set(1, 1, stretch);
      this._sparkMatrix.compose(s.pos, this._sparkQuat, this._sparkScale);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    if (sparksDirty) {
      this.sparkInstanced.instanceMatrix.needsUpdate = true;
    }

    // 3. Fade tracer streaks
    for (let i = 0; i < MAX_TRACERS; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tr.life -= dt;
      if (tr.life <= 0) {
        tr.active = false;
        tr.mesh.visible = false;
      }
    }
  }

  public clearEffects(): void {
    for (let i = 0; i < MAX_PROJECTILES; i++) this.projectiles[i].active = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers[i].active = false;
      this.tracers[i].mesh.visible = false;
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals[i].active = false;
      this.decals[i].mesh.visible = false;
    }
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks[i].active = false;
      this._sparkMatrix.makeScale(0, 0, 0);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    this.sparkInstanced.instanceMatrix.needsUpdate = true;
  }

  private checkProjectileFlyby(p: PooledProjectile, flybyCtx?: BallisticFlybyContext): void {
    // Exclude local player's direct outbound rounds, but allow ricocheted rounds whistling back past the shooter
    if (!flybyCtx || (p.isLocalPlayer && p.bounceCount === 0) || p.hasTriggeredFlyby) return;
    const speedMs = p.vel.length();
    const energyJ = 0.5 * p.massKg * speedMs * speedMs;
    const baseMaxR = flybyCtx.maxRadiusM ?? BALLISTIC_FLYBY_MAX_RADIUS_M;
    const effectiveMaxR = computeBallisticFlybyRadiusM(speedMs, p.caliberMm, energyJ, baseMaxR);
    const pca = evaluateBallisticFlybyPCA(
      p.prevPos,
      p.pos,
      flybyCtx.listenerHeadPos,
      effectiveMaxR,
      p.wasApproachingHead,
      _pcaClosest,
    );
    p.wasApproachingHead = pca.approachingAfter;
    if (!pca.triggered) return;

    p.hasTriggeredFlyby = true;
    const audio = flybyCtx.audio ?? p.audio;
    audio?.playBallisticFlyby?.({
      closestPos: _pcaClosest,
      speedMs,
      missDistM: pca.missDistM,
      caliberMm: p.caliberMm,
      energyJ,
      muzzleOrigin: p.muzzleOrigin,
      delaySec: 0,
    });

    const cls = classifyBallisticFlyby(speedMs, pca.missDistM, p.caliberMm, energyJ);
    if (cls.triggerMicroFlinch && flybyCtx.onSupersonicNearMiss) {
      let sideSign = 1;
      if (flybyCtx.listenerRightDir) {
        _pcaOffset.subVectors(_pcaClosest, flybyCtx.listenerHeadPos);
        sideSign = _pcaOffset.dot(flybyCtx.listenerRightDir) >= 0 ? 1 : -1;
      }
      flybyCtx.onSupersonicNearMiss(cls.flinchDeg, sideSign, speedMs, pca.missDistM);
    }
  }

  private computeAccel(vel: Readonly<THREE.Vector3>, bc: number, out: THREE.Vector3): void {
    const v = vel.length();
    if (v < 1e-3) {
      out.set(0, -GRAVITY_MPS2, 0);
      return;
    }
    const mach = v / SPEED_OF_SOUND_MPS;
    // Standard G1 drag curve approximation: subsonic base -> transonic wave drag hump -> supersonic taper
    let cd = 0.24;
    if (mach >= 0.85 && mach < 1.2) {
      const t = (mach - 0.85) / 0.35;
      cd = 0.24 + t * 0.34;
    } else if (mach >= 1.2) {
      cd = 0.58 / Math.pow(mach, 0.32);
    }

    // Calibrated G1 retardation factor (SI units)
    const dragFactor = (0.5 * AIR_DENSITY_SEA * v * cd * 0.00046) / Math.max(0.05, bc);
    out.set(-vel.x * dragFactor, -GRAVITY_MPS2 - vel.y * dragFactor, -vel.z * dragFactor);
  }

  private resolveImpact(
    p: PooledProjectile,
    hit: BodycamRaycastResult,
    world: IBodycamWorldAdapter,
    onImpact?: (event: Readonly<BallisticImpactEvent>) => void,
  ): void {
    const ammo = p.ammo!;
    const speedMs = p.vel.length();
    const energyJ = 0.5 * p.massKg * speedMs * speedMs;
    const matId = mapSurfaceToBallisticMaterial(hit.surface, hit.object?.userData);
    const mat = BALLISTIC_MATERIALS[matId];

    this._normal.set(hit.normalX, hit.normalY, hit.normalZ);
    if (this._normal.lengthSq() < 0.01) {
      this._normal.set(0, 1, 0);
    } else {
      this._normal.normalize();
    }

    this._stepDir.copy(p.vel).divideScalar(Math.max(1e-3, speedMs));
    const cosInc = THREE.MathUtils.clamp(Math.abs(this._stepDir.dot(this._normal)), 0, 1);
    const grazingAngleDeg = THREE.MathUtils.radToDeg(Math.asin(cosInc));

    const ev = this._impactEvent;
    ev.ammo = ammo;
    ev.weaponId = p.weaponId;
    ev.material = matId;
    ev.surface = hit.surface;
    ev.object = hit.object;
    ev.point.set(hit.pointX, hit.pointY, hit.pointZ);
    ev.normal.copy(this._normal);
    ev.incomingDir.copy(this._stepDir);
    ev.outgoingDir.copy(this._stepDir);
    ev.impactSpeedMs = speedMs;
    ev.impactEnergyJ = energyJ;
    ev.grazingAngleDeg = grazingAngleDeg;
    ev.distanceM = p.distanceTraveled;
    ev.isFragment = p.isFragment;
    ev.bounceIndex = p.bounceCount;
    ev.exitPoint.copy(ev.point);
    ev.penetrationThicknessM = 0;

    // 0. Breakable Glass: shatter + immediate pass-through
    if (matId === 'glass') {
      if (hit.object && !hit.object.userData?.shattered) {
        world.shatterBreakable?.(hit.object, ev.point, this._stepDir);
      }
      p.vel.multiplyScalar(0.88);
      p.pos.addScaledVector(this._stepDir, 0.10);
      ev.outcome = 'penetrate';
      onImpact?.(ev);
      return;
    }

    // 1. GRAZING RICOCHET
    const critRicochetDeg = computeCriticalRicochetDeg(mat, ammo.coreType, speedMs);
    if (!p.isFragment && p.bouncesLeft > 0 && grazingAngleDeg <= critRicochetDeg && speedMs > 120) {
      const dotDN = this._stepDir.dot(this._normal);
      this._refl.copy(this._stepDir).addScaledVector(this._normal, -2 * dotDN).normalize();

      // Add realistic deflection scatter
      const scatter = 0.04 + (1 - mat.elasticityRetention) * 0.06;
      this._refl.x += (Math.random() - 0.5) * scatter;
      this._refl.y += (Math.random() - 0.25) * scatter * 0.6;
      this._refl.z += (Math.random() - 0.5) * scatter;
      this._refl.normalize();

      const grazingBonus = (1 - grazingAngleDeg / Math.max(1, critRicochetDeg)) * 0.30;
      const retention = THREE.MathUtils.clamp(
        0.30 + mat.elasticityRetention * 0.25 + grazingBonus,
        0.30,
        0.65,
      );
      const nextSpeed = speedMs * retention;

      p.pos.copy(ev.point).addScaledVector(this._normal, 0.015);
      p.vel.copy(this._refl).multiplyScalar(nextSpeed);
      p.bouncesLeft -= 1;
      p.bounceCount += 1;
      p.wasApproachingHead = false;
      p.penetrationPower *= retention * 0.85;

      this.addDecal(ev.point, this._normal, matId);
      this.spawnSparks(ev.point, this._refl, matId === 'steel' ? 8 : 4, 9.5);
      p.audio?.playRicochet?.(ev.point, nextSpeed, hit.surface);

      ev.outcome = 'ricochet';
      ev.outgoingDir.copy(this._refl);
      onImpact?.(ev);
      return;
    }

    // 2. PENETRATION CHECK (with dynamic backface thickness probe)
    const hitUserThickness =
      typeof hit.object?.userData?.thicknessM === 'number' ? hit.object.userData.thicknessM : null;
    const isSolidImpenetrable = Boolean(hit.object?.userData?.impenetrable);

    let measuredThicknessM = hitUserThickness ?? 0.14;
    if (!isSolidImpenetrable && hitUserThickness === null && !p.isFragment) {
      const maxProbeM = 0.55;
      this._backOrigin.copy(ev.point).addScaledVector(this._stepDir, maxProbeM);
      this._backDir.copy(this._stepDir).negate();
      const backFound = world.raycast(this._backOrigin, this._backDir, 0.005, maxProbeM, this._backHit);
      if (backFound && (!hit.object || this._backHit.object === hit.object)) {
        measuredThicknessM = THREE.MathUtils.clamp(maxProbeM - this._backHit.distance, 0.015, maxProbeM);
      }
    }

    let corePenMult = 1.0;
    if (matId === 'steel' || matId === 'concrete') {
      switch (ammo.coreType) {
        case 'tungsten_ap':
          corePenMult = 1.22;
          break;
        case 'solid_steel':
          corePenMult = 1.18;
          break;
        case 'steel_core_ap':
          corePenMult = 1.05;
          break;
        case 'lead_fmj':
          corePenMult = 0.86;
          break;
        case 'lead_jhp':
          corePenMult = 0.52;
          break;
        case 'soft_lead':
          corePenMult = 0.48;
          break;
        case 'frangible_pellet':
          corePenMult = 0.30;
          break;
      }
    }

    const dynPen =
      p.penetrationPower *
      corePenMult *
      THREE.MathUtils.clamp(speedMs / Math.max(180, ammo.baseVelocityMs), 0.25, 1.35);
    const requiredPen = mat.penetrationResistance * (0.22 + measuredThicknessM * 9.0);

    if (!isSolidImpenetrable && !p.isFragment && dynPen > requiredPen && measuredThicknessM < 0.52) {
      const exitRatio = THREE.MathUtils.clamp(Math.sqrt(1 - requiredPen / dynPen), 0.28, 0.85);
      const tumble = (1 - exitRatio) * 0.065;

      this._refl
        .copy(this._stepDir)
        .add(
          this._right.set(
            (Math.random() - 0.5) * tumble,
            (Math.random() - 0.5) * tumble,
            (Math.random() - 0.5) * tumble,
          ),
        )
        .normalize();

      this.addDecal(ev.point, this._normal, matId);
      ev.exitPoint.copy(ev.point).addScaledVector(this._stepDir, measuredThicknessM + 0.02);
      // Exit decal on far face
      this.addDecal(ev.exitPoint, this._stepDir, matId);
      this.spawnSparks(ev.exitPoint, this._refl, matId === 'steel' ? 6 : 3, 6.5);

      p.pos.copy(ev.exitPoint).addScaledVector(this._refl, 0.012);
      p.vel.copy(this._refl).multiplyScalar(speedMs * exitRatio);
      p.penetrationPower = Math.max(4, p.penetrationPower - requiredPen * 0.85);

      ev.outcome = 'penetrate';
      ev.outgoingDir.copy(this._refl);
      ev.penetrationThicknessM = measuredThicknessM;
      onImpact?.(ev);
      return;
    }

    // 3. BULLET BREAKING / FRAGMENTATION
    const fragileBullet =
      ammo.coreType === 'lead_jhp' ||
      ammo.coreType === 'soft_lead' ||
      (ammo.coreType === 'steel_core_ap' && ammo.bulletMassGrams <= 4.5 && speedMs > 780) ||
      (ammo.coreType === 'lead_fmj' && ammo.bulletMassGrams <= 4.5 && speedMs > 780);

    if (
      !p.isFragment &&
      mat.spallTendency > 0.45 &&
      fragileBullet &&
      speedMs >= ammo.fragmentThresholdMs
    ) {
      const fragCount = 2 + Math.floor(Math.random() * 3); // 2..4 micro-spall shards
      const dotDN = this._stepDir.dot(this._normal);
      this._refl.copy(this._stepDir).addScaledVector(this._normal, -2 * dotDN).normalize();

      for (let f = 0; f < fragCount; f++) {
        const frag = this.allocProjectile();
        if (!frag) break;
        frag.active = true;
        frag.pos.copy(ev.point).addScaledVector(this._normal, 0.016);
        frag.prevPos.copy(frag.pos);

        const sDirX = this._refl.x + (Math.random() - 0.5) * 0.72 + this._normal.x * 0.22;
        const sDirY = this._refl.y + (Math.random() - 0.5) * 0.55 + this._normal.y * 0.22;
        const sDirZ = this._refl.z + (Math.random() - 0.5) * 0.72 + this._normal.z * 0.22;
        this._up.set(sDirX, sDirY, sDirZ).normalize();

        frag.vel.copy(this._up).multiplyScalar(speedMs * (0.35 + Math.random() * 0.25));
        frag.massKg = p.massKg * 0.28;
        frag.bc = 0.06;
        frag.penetrationPower = 4;
        frag.ammo = ammo;
        frag.weaponId = p.weaponId;
        frag.distanceTraveled = 0;
        frag.maxDistanceM = 2.0; // short-lived spall cone < 2m
        frag.age = 0;
        frag.bouncesLeft = 0;
        frag.bounceCount = 0;
        frag.isFragment = true;
        frag.audio = undefined;
      }

      this.addDecal(ev.point, this._normal, matId);
      this.spawnSparks(ev.point, this._normal, 12, 10.5);
      p.active = false;
      ev.outcome = 'fragment';
      ev.outgoingDir.copy(this._refl);
      onImpact?.(ev);
      return;
    }

    // 4. EMBED / STOP
    this.addDecal(ev.point, this._normal, matId);
    this.spawnSparks(ev.point, this._normal, matId === 'steel' ? 6 : 2, 5.0);
    p.active = false;
    ev.outcome = 'stop';
    onImpact?.(ev);
  }

  private allocProjectile(): PooledProjectile | null {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (!this.projectiles[i].active) {
        return this.projectiles[i];
      }
    }
    return null;
  }

  private spawnTracer(start: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>, isFragment: boolean): void {
    const len = start.distanceTo(end);
    if (len < 0.04) return;
    const slot = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % MAX_TRACERS;

    this._tracerMid.addVectors(start, end).multiplyScalar(0.5);
    this._stepDir.subVectors(end, start).divideScalar(len);

    slot.active = true;
    slot.life = isFragment ? 0.055 : 0.038;
    slot.mesh.material = isFragment ? this.fragTracerMat : this.tracerMat;
    slot.mesh.position.copy(this._tracerMid);
    slot.mesh.quaternion.setFromUnitVectors(this._worldUp, this._stepDir);
    slot.mesh.scale.set(isFragment ? 0.7 : 1.0, Math.min(len, 18), isFragment ? 0.7 : 1.0);
    slot.mesh.visible = true;
  }

  private spawnSparks(
    origin: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    count: number,
    speed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;

      s.active = true;
      s.pos.copy(origin).addScaledVector(dir, 0.015);
      s.vel.set(
        dir.x * speed + (Math.random() - 0.5) * speed * 1.35,
        dir.y * speed + Math.random() * speed * 0.9,
        dir.z * speed + (Math.random() - 0.5) * speed * 1.35,
      );
      s.maxLife = 0.14 + Math.random() * 0.16;
      s.life = s.maxLife;
    }
  }

  private addDecal(
    pos: Readonly<THREE.Vector3>,
    normal: Readonly<THREE.Vector3>,
    mat: BallisticMaterialId,
  ): void {
    const slot = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;

    this._decalPos.copy(pos).addScaledVector(normal, 0.004);
    this._decalLook.copy(this._decalPos).add(normal);
    slot.mesh.material =
      mat === 'steel' ? this.decalMatSteel : mat === 'wood' ? this.decalMatWood : this.decalMatDark;
    slot.mesh.position.copy(this._decalPos);
    slot.mesh.lookAt(this._decalLook);
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);
    const scale = 0.65 + Math.random() * 0.6;
    slot.mesh.scale.set(scale, scale, 1);
    slot.mesh.visible = true;
    slot.active = true;
    slot.age = 0;
  }

  public dispose(): void {
    this.decalGeo.dispose();
    this.decalMatDark.dispose();
    this.decalMatSteel.dispose();
    this.decalMatWood.dispose();
    this.tracerGeo.dispose();
    this.tracerMat.dispose();
    this.fragTracerMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.sparkInstanced.dispose();
  }
}

const _hingePivotPos = new THREE.Vector3();
const _hingePivotQuat = new THREE.Quaternion();
const _hingeAxisWorld = new THREE.Vector3();
const _hingeArm = new THREE.Vector3();
const _hingeImpulse = new THREE.Vector3();
const _hingeCross = new THREE.Vector3();

/**
 * Pure 3D torque projection τ = ((hit - pivot) × impulse) · hingeAxis.
 */
export function computeHingeTorqueScalar(
  armX: number,
  armY: number,
  armZ: number,
  impX: number,
  impY: number,
  impZ: number,
  axisX = 1,
  axisY = 0,
  axisZ = 0,
): number {
  const cx = armY * impZ - armZ * impY;
  const cy = armZ * impX - armX * impZ;
  const cz = armX * impY - armY * impX;
  return cx * axisX + cy * axisY + cz * axisZ;
}

export interface TargetHingeImpulseParams {
  pivot: THREE.Object3D;
  hitPointWorld: Readonly<THREE.Vector3>;
  incomingDir: Readonly<THREE.Vector3>;
  impactSpeedMs: number;
  bulletMassGrams: number;
  pellets?: number;
  outcome?: TerminalOutcome;
  outgoingDir?: Readonly<THREE.Vector3>;
  effectiveInertia?: number;
  impulseScale?: number;
  minDeltaRadSec?: number;
  maxDeltaRadSec?: number;
  localHingeAxis?: 'x' | 'y' | 'z';
}

/**
 * Computes rigid-body angular velocity impulse Δω (rad/s) around a target's hinge
 * from true 3D cross-product torque τ = (r × Δp) · axisWorld.
 * - Bottom-hinged targets (+Y above pivot): downrange impulse (+Z) -> +Δω (tips away).
 * - Top-hinged gongs (-Y below pivot): downrange impulse (+Z) -> -Δω (bottom kicks away).
 * - Ricochets: Δp = m(v_in - e·v_out), reacting physically off slanted armor plates.
 */
export function computeTargetHingeAngularImpulse(params: TargetHingeImpulseParams): number {
  params.pivot.updateMatrixWorld(true);
  params.pivot.getWorldPosition(_hingePivotPos);
  params.pivot.getWorldQuaternion(_hingePivotQuat);

  const axisMode = params.localHingeAxis ?? 'x';
  if (axisMode === 'y') {
    _hingeAxisWorld.set(0, 1, 0);
  } else if (axisMode === 'z') {
    _hingeAxisWorld.set(0, 0, 1);
  } else {
    _hingeAxisWorld.set(1, 0, 0);
  }
  _hingeAxisWorld.applyQuaternion(_hingePivotQuat).normalize();

  _hingeArm.copy(params.hitPointWorld).sub(_hingePivotPos);

  const pellets = Math.max(1, params.pellets ?? 1);
  const massKg = (Math.max(0.5, params.bulletMassGrams) / pellets) * 0.001;
  const speedMs = Math.max(1, params.impactSpeedMs);

  _hingeImpulse.copy(params.incomingDir);
  if (_hingeImpulse.lengthSq() > 1e-6) {
    _hingeImpulse.normalize();
  } else {
    _hingeImpulse.set(0, 0, 1);
  }

  if (params.outcome === 'ricochet' && params.outgoingDir) {
    _hingeCross.copy(params.outgoingDir);
    if (_hingeCross.lengthSq() > 1e-6) {
      _hingeCross.normalize();
      // Elastic restitution reflection delta: J = m * v_in * (d_in - 0.68 * d_out)
      _hingeImpulse.addScaledVector(_hingeCross, -0.68);
    }
    _hingeImpulse.multiplyScalar(massKg * speedMs);
  } else if (params.outcome === 'penetrate') {
    // Pass-through imparts partial shear momentum
    _hingeImpulse.multiplyScalar(massKg * speedMs * 0.42);
  } else {
    _hingeImpulse.multiplyScalar(massKg * speedMs * 1.15);
  }

  _hingeCross.crossVectors(_hingeArm, _hingeImpulse);
  const torqueScalar = _hingeCross.dot(_hingeAxisWorld);
  const inertia = Math.max(0.04, params.effectiveInertia ?? 0.24);
  const scale = params.impulseScale ?? 1.0;
  let deltaOmega = (torqueScalar * scale) / inertia;

  const minMag = params.minDeltaRadSec ?? 0;
  const maxMag = params.maxDeltaRadSec ?? 16;
  if (Math.abs(deltaOmega) > 1e-4) {
    const sign = deltaOmega >= 0 ? 1 : -1;
    deltaOmega = sign * THREE.MathUtils.clamp(Math.abs(deltaOmega), minMag, maxMag);
  } else {
    deltaOmega = 0;
  }
  return deltaOmega;
}


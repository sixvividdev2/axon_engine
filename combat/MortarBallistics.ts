import * as THREE from 'three';

export type MortarChargeLevel = 1 | 2 | 3 | 4;

export interface MortarChargeSpec {
  charge: MortarChargeLevel;
  label: string;
  muzzleSpeedMps: number;
  minRangeM: number;
  maxRangeM: number;
  recoilImpulse: number;
}

export const MORTAR_GRAVITY_MPS2 = 9.81;
export const MORTAR_MIN_ELEVATION_DEG = 45;
export const MORTAR_MAX_ELEVATION_DEG = 80;
export const MORTAR_MIN_ELEVATION_RAD = THREE.MathUtils.degToRad(MORTAR_MIN_ELEVATION_DEG);
export const MORTAR_MAX_ELEVATION_RAD = THREE.MathUtils.degToRad(MORTAR_MAX_ELEVATION_DEG);
export const NATO_MILS_PER_CIRCLE = 6400;
export const RAD_TO_MILS = NATO_MILS_PER_CIRCLE / (Math.PI * 2);
export const MILS_TO_RAD = (Math.PI * 2) / NATO_MILS_PER_CIRCLE;

/**
 * 81mm M252-inspired high-angle propellant charge rings (Charges 1–4).
 * Tuned for AXON Conquest theater scales (35m–700m) with authentic overlapping range bands.
 */
export const MORTAR_CHARGE_SPECS: Record<MortarChargeLevel, MortarChargeSpec> = {
  1: {
    charge: 1,
    label: 'CHG 1 (CLOSE)',
    muzzleSpeedMps: 36.0,
    minRangeM: 32,
    maxRangeM: 132,
    recoilImpulse: 0.55,
  },
  2: {
    charge: 2,
    label: 'CHG 2 (MID)',
    muzzleSpeedMps: 52.0,
    minRangeM: 72,
    maxRangeM: 275,
    recoilImpulse: 0.78,
  },
  3: {
    charge: 3,
    label: 'CHG 3 (LONG)',
    muzzleSpeedMps: 68.0,
    minRangeM: 120,
    maxRangeM: 470,
    recoilImpulse: 1.0,
  },
  4: {
    charge: 4,
    label: 'CHG 4 (MAX)',
    muzzleSpeedMps: 84.0,
    minRangeM: 185,
    maxRangeM: 715,
    recoilImpulse: 1.28,
  },
};

export interface MortarTrajectoryResult {
  impactPos: THREE.Vector3;
  flightTimeSec: number;
  apexHeightM: number;
  horizontalRangeM: number;
  initialVelocity: THREE.Vector3;
}

export interface MortarChargeSolution {
  charge: MortarChargeLevel;
  inRange: boolean;
  azimuthRad: number;
  deflectionMils: number;
  elevationRad: number;
  elevationDeg: number;
  elevationMils: number;
  flightTimeSec: number;
  windLeadMils: number;
}

export interface MortarFiringTableSolution {
  origin: THREE.Vector3;
  target: THREE.Vector3;
  horizontalRangeM: number;
  altDeltaM: number;
  rawBearingRad: number;
  rawBearingDeg: number;
  rawBearingMils: number;
  recommended: MortarChargeSolution | null;
  options: MortarChargeSolution[];
  windSpeedMps: number;
  windCrossMps: number;
  windHeadMps: number;
}

/** Converts radians (0 = -Z North, clockwise positive) to NATO mils [0, 6400). */
export function radiansToNatoMils(rad: number): number {
  const twoPi = Math.PI * 2;
  const wrapped = ((rad % twoPi) + twoPi) % twoPi;
  return Math.round(wrapped * RAD_TO_MILS) % NATO_MILS_PER_CIRCLE;
}

/** Signed shortest angular difference in radians (-PI..+PI). */
export function shortestAngleDeltaRad(fromRad: number, toRad: number): number {
  let d = (toRad - fromRad) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Bearing from origin to target in world space (0 = -Z North, +PI/2 = +X East). */
export function computeBearingRad(originX: number, originZ: number, targetX: number, targetZ: number): number {
  const dx = targetX - originX;
  const dz = targetZ - originZ;
  const raw = Math.atan2(dx, -dz);
  const twoPi = Math.PI * 2;
  return ((raw % twoPi) + twoPi) % twoPi;
}

/**
 * Evaluates a ballistic mortar shell's exact position along a deterministic parabolic + wind drift arc.
 * Zero allocations when `out` is supplied.
 */
export function sampleMortarArcPosition(
  originX: number,
  originY: number,
  originZ: number,
  vx: number,
  vy: number,
  vz: number,
  windX: number,
  windZ: number,
  tSec: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  // Subtle aerodynamic wind acceleration (0.045 * wind * t^2) for authentic ballistic drift
  const windAccelScale = 0.045;
  const t2 = tSec * tSec;
  out.set(
    originX + vx * tSec + 0.5 * windX * windAccelScale * t2,
    originY + vy * tSec - 0.5 * MORTAR_GRAVITY_MPS2 * t2,
    originZ + vz * tSec + 0.5 * windZ * windAccelScale * t2,
  );
  return out;
}

/**
 * Forward ballistic simulation: computes exact ground impact point and flight time
 * for a given pit muzzle origin, azimuth, high-angle elevation (45°-80°), charge 1-4, and wind.
 */
export function simulateMortarImpact(
  origin: Readonly<THREE.Vector3>,
  azimuthRad: number,
  elevationRad: number,
  chargeLevel: MortarChargeLevel,
  windX = 0,
  windZ = 0,
  getGroundHeight?: (x: number, z: number) => number,
): MortarTrajectoryResult {
  const spec = MORTAR_CHARGE_SPECS[chargeLevel] ?? MORTAR_CHARGE_SPECS[2];
  const clampedEl = THREE.MathUtils.clamp(elevationRad, MORTAR_MIN_ELEVATION_RAD, MORTAR_MAX_ELEVATION_RAD);
  const v0 = spec.muzzleSpeedMps;
  const horizV = v0 * Math.cos(clampedEl);
  const vy = v0 * Math.sin(clampedEl);
  const vx = Math.sin(azimuthRad) * horizV;
  const vz = -Math.cos(azimuthRad) * horizV;

  const apexTime = vy / MORTAR_GRAVITY_MPS2;
  const apexHeightM = origin.y + (vy * vy) / (2 * MORTAR_GRAVITY_MPS2);

  // Analytical flat-plane flight time estimate, refined with ground height intersection steps
  const flatT = (2 * vy) / MORTAR_GRAVITY_MPS2;
  const pos = new THREE.Vector3();

  if (!getGroundHeight) {
    sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, flatT, pos);
    return {
      impactPos: pos,
      flightTimeSec: flatT,
      apexHeightM,
      horizontalRangeM: Math.hypot(pos.x - origin.x, pos.z - origin.z),
      initialVelocity: new THREE.Vector3(vx, vy, vz),
    };
  }

  // Step forward past apex to find exact terrain intersection with binary refinement
  const dtStep = 0.08;
  let prevT = Math.max(0.25, apexTime);
  sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, prevT, pos);
  let prevDiff = pos.y - getGroundHeight(pos.x, pos.z);
  let t = prevT;
  const maxT = flatT + 14.0;

  while (t < maxT) {
    t += dtStep;
    sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, t, pos);
    const groundY = getGroundHeight(pos.x, pos.z);
    const diff = pos.y - groundY;
    if (diff <= 0 && prevDiff >= 0) {
      // Binary search refinement to < 1ms precision
      let lo = prevT;
      let hi = t;
      for (let iter = 0; iter < 8; iter++) {
        const mid = 0.5 * (lo + hi);
        sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, mid, pos);
        const midDiff = pos.y - getGroundHeight(pos.x, pos.z);
        if (midDiff > 0) lo = mid;
        else hi = mid;
      }
      const impactT = 0.5 * (lo + hi);
      sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, impactT, pos);
      pos.y = getGroundHeight(pos.x, pos.z);
      return {
        impactPos: pos,
        flightTimeSec: impactT,
        apexHeightM,
        horizontalRangeM: Math.hypot(pos.x - origin.x, pos.z - origin.z),
        initialVelocity: new THREE.Vector3(vx, vy, vz),
      };
    }
    prevT = t;
    prevDiff = diff;
  }

  sampleMortarArcPosition(origin.x, origin.y, origin.z, vx, vy, vz, windX, windZ, flatT, pos);
  pos.y = getGroundHeight(pos.x, pos.z);
  return {
    impactPos: pos,
    flightTimeSec: flatT,
    apexHeightM,
    horizontalRangeM: Math.hypot(pos.x - origin.x, pos.z - origin.z),
    initialVelocity: new THREE.Vector3(vx, vy, vz),
  };
}

/**
 * Solves the high-angle (45°-80°) firing angle for a specific charge level, target range,
 * altitude delta, and wind vector (2-pass wind lead compensation).
 */
function solveSingleCharge(
  origin: Readonly<THREE.Vector3>,
  target: Readonly<THREE.Vector3>,
  chargeLevel: MortarChargeLevel,
  windX: number,
  windZ: number,
): MortarChargeSolution {
  const spec = MORTAR_CHARGE_SPECS[chargeLevel];
  const v = spec.muzzleSpeedMps;
  const g = MORTAR_GRAVITY_MPS2;
  const rawBearing = computeBearingRad(origin.x, origin.z, target.x, target.z);
  const altDelta = target.y - origin.y;

  let aimTargetX = target.x;
  let aimTargetZ = target.z;
  let solvedEl = THREE.MathUtils.degToRad(65);
  let solvedAz = rawBearing;
  let solvedFlightT = 0;
  let inRange = false;

  // 2-pass iterative wind-drift compensation
  for (let pass = 0; pass < 3; pass++) {
    const dx = aimTargetX - origin.x;
    const dz = aimTargetZ - origin.z;
    const range = Math.hypot(dx, dz);
    solvedAz = computeBearingRad(origin.x, origin.z, aimTargetX, aimTargetZ);

    if (range < 5) {
      inRange = false;
      break;
    }

    const v2 = v * v;
    const v4 = v2 * v2;
    const disc = v4 - g * (g * range * range + 2 * altDelta * v2);
    if (disc < 0) {
      inRange = false;
      break;
    }

    // High-angle (+) root for indirect mortar fire (steeper arc clears cover/buildings)
    const tanTheta = (v2 + Math.sqrt(disc)) / (g * range);
    const theta = Math.atan(tanTheta);

    if (theta < MORTAR_MIN_ELEVATION_RAD - 0.002 || theta > MORTAR_MAX_ELEVATION_RAD + 0.002) {
      inRange = false;
      solvedEl = THREE.MathUtils.clamp(theta, MORTAR_MIN_ELEVATION_RAD, MORTAR_MAX_ELEVATION_RAD);
      break;
    }

    inRange = true;
    solvedEl = THREE.MathUtils.clamp(theta, MORTAR_MIN_ELEVATION_RAD, MORTAR_MAX_ELEVATION_RAD);
    const horizV = Math.max(0.1, v * Math.cos(solvedEl));
    solvedFlightT = range / horizV;

    // Subtract expected wind drift to aim upwind of the target
    const driftScale = 0.5 * 0.045 * solvedFlightT * solvedFlightT;
    aimTargetX = target.x - windX * driftScale;
    aimTargetZ = target.z - windZ * driftScale;
  }

  const windLeadRad = shortestAngleDeltaRad(rawBearing, solvedAz);
  const windLeadMils = Math.round(windLeadRad * RAD_TO_MILS);

  return {
    charge: chargeLevel,
    inRange,
    azimuthRad: solvedAz,
    deflectionMils: radiansToNatoMils(solvedAz),
    elevationRad: solvedEl,
    elevationDeg: Number(THREE.MathUtils.radToDeg(solvedEl).toFixed(1)),
    elevationMils: Math.round(solvedEl * RAD_TO_MILS),
    flightTimeSec: Number(solvedFlightT.toFixed(1)),
    windLeadMils,
  };
}

/**
 * Computes the complete 3D PDA Ballistic Firing Table across Charges 1–4,
 * selecting the optimal charge (preferring crisp mid-band ~55°-70° high-angle arc
 * with lowest flight time that remains cleanly in range).
 */
export function solveMortarFiringTable(
  origin: Readonly<THREE.Vector3>,
  target: Readonly<THREE.Vector3>,
  windX = 0,
  windZ = 0,
): MortarFiringTableSolution {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const horizontalRangeM = Math.hypot(dx, dz);
  const altDeltaM = target.y - origin.y;
  const rawBearingRad = computeBearingRad(origin.x, origin.z, target.x, target.z);

  const forwardX = Math.sin(rawBearingRad);
  const forwardZ = -Math.cos(rawBearingRad);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  const windHeadMps = windX * forwardX + windZ * forwardZ;
  const windCrossMps = windX * rightX + windZ * rightZ;
  const windSpeedMps = Math.hypot(windX, windZ);

  const levels: MortarChargeLevel[] = [1, 2, 3, 4];
  const options = levels.map((ch) => solveSingleCharge(origin, target, ch, windX, windZ));

  // Pick the in-range charge whose elevation sits closest to the ideal 62° sweet spot
  let recommended: MortarChargeSolution | null = null;
  let bestScore = Infinity;
  for (const opt of options) {
    if (!opt.inRange) continue;
    const score = Math.abs(opt.elevationDeg - 62) + opt.flightTimeSec * 0.25;
    if (score < bestScore) {
      bestScore = score;
      recommended = opt;
    }
  }

  return {
    origin: origin.clone(),
    target: target.clone(),
    horizontalRangeM,
    altDeltaM,
    rawBearingRad,
    rawBearingDeg: Number(THREE.MathUtils.radToDeg(rawBearingRad).toFixed(1)),
    rawBearingMils: radiansToNatoMils(rawBearingRad),
    recommended,
    options,
    windSpeedMps: Number(windSpeedMps.toFixed(1)),
    windCrossMps: Number(windCrossMps.toFixed(1)),
    windHeadMps: Number(windHeadMps.toFixed(1)),
  };
}

/**
 * Forward Observer (FO) Spotting Correction:
 * Shifts a current target coordinate by Add/Drop meters along the Gun-Target line
 * and Left/Right meters perpendicular to the Gun-Target line.
 */
export function applyForwardObserverCorrection(
  origin: Readonly<THREE.Vector3>,
  currentTarget: Readonly<THREE.Vector3>,
  addDropMeters: number,
  leftRightMeters: number,
): THREE.Vector3 {
  const bearing = computeBearingRad(origin.x, origin.z, currentTarget.x, currentTarget.z);
  const forwardX = Math.sin(bearing);
  const forwardZ = -Math.cos(bearing);
  const rightX = -forwardZ;
  const rightZ = forwardX;
  return new THREE.Vector3(
    currentTarget.x + forwardX * addDropMeters + rightX * leftRightMeters,
    currentTarget.y,
    currentTarget.z + forwardZ * addDropMeters + rightZ * leftRightMeters,
  );
}

import * as THREE from 'three';
import { BodycamPhysicsWorld, PhysicsRampCollider } from '../bodycam-sdk/BodycamPhysics';

/**
 * Anatomical bone dimensions (unscaled human 1.76m rig) used to compute the
 * crawler's root lift offset and floor-oriented prone torso/pelvis capsule.
 */
export const CRAWLER_PELVIS_HALF_DEPTH_M = 0.108; // Pelvis/belt half-depth perpendicular to floor
export const CRAWLER_CHEST_HALF_DEPTH_M = 0.133; // Thorax + front vest plate half-depth
export const CRAWLER_BONE_CLEARANCE_MARGIN_M = 0.048; // Root lift offset along floor normal (scaled by heightScale)
export const CRAWLER_PELVIS_LOCAL_BASE_Y_M = 0.134; // Pelvis center above lifted root (total = 0.182m * heightScale)
export const CRAWLER_CAPSULE_RADIUS_M = 0.185;
export const CRAWLER_CAPSULE_HALF_LENGTH_M = 0.34;

const MAX_WALKABLE_SLOPE_COS = Math.cos(THREE.MathUtils.degToRad(50));
const EPS = 1e-5;

export interface CrawlerBoneMetrics {
  /** Combined anatomical half-depth of the prone torso/pelvis bones (m, scaled) */
  boneHalfHeightM: number;
  /** Lift offset applied to the crawler's root transform along the floor normal (m, scaled) */
  rootLiftOffsetM: number;
  /** Pelvis local Y offset inside bodyPivot above the lifted root (unscaled local units) */
  pelvisLocalBaseYM: number;
  /** Exact floor plane Y coordinate inside unscaled bodyPivot local space */
  floorYInBodyPivotM: number;
  /** Prone torso/pelvis collision capsule radius (m, scaled) */
  capsuleRadiusM: number;
  /** Prone torso/pelvis collision capsule half-length along floor forward axis (m, scaled) */
  capsuleHalfLengthM: number;
}

export function computeCrawlerBoneMetrics(heightScale: number): CrawlerBoneMetrics {
  const s = Math.max(0.75, Math.min(1.35, heightScale));
  const boneHalfHeightM = CRAWLER_CHEST_HALF_DEPTH_M * s;
  const rootLiftOffsetM = CRAWLER_BONE_CLEARANCE_MARGIN_M * s;
  return {
    boneHalfHeightM,
    rootLiftOffsetM,
    pelvisLocalBaseYM: CRAWLER_PELVIS_LOCAL_BASE_Y_M,
    floorYInBodyPivotM: -CRAWLER_BONE_CLEARANCE_MARGIN_M,
    capsuleRadiusM: CRAWLER_CAPSULE_RADIUS_M * s,
    capsuleHalfLengthM: CRAWLER_CAPSULE_HALF_LENGTH_M * s,
  };
}

export interface CrawlerArmStrokeSample {
  /** Normalized cycle phase [0, 1): [0, 0.56) grounded claw-pull stance, [0.56, 1) low recovery swing */
  cycleU: number;
  /** 1 while clawed palm is anchored on floor plane pulling backward, 0 during recovery swing */
  contact01: number;
  /** 0..1 forward reach factor (1 = fully extended forward, 0 = pulled back beside shoulder) */
  reach01: number;
  /** 0..1 recovery swing lift factor (0 during grounded pull, peaks mid-recovery) */
  lift01: number;
  /** Instantaneous backward claw-pull drive [0..1+] synced to forward crawl propulsion */
  pullDrive01: number;
  /** Hand pivot target Z in unscaled bodyPivot space (negative = forward along -Z) */
  targetZ: number;
  /** Hand pivot clearance height above the floor plane in unscaled bodyPivot space (m) */
  targetFloorClearanceY: number;
  /** Hand pivot lateral X offset in unscaled bodyPivot space (m, signed by side) */
  targetLateralX: number;
}

export interface CrawlerClawCycleSample {
  left: CrawlerArmStrokeSample;
  right: CrawlerArmStrokeSample;
  /** Combined active claw-pull drive from both arms [0..1.25] */
  combinedPullDrive01: number;
  /** Forward velocity multiplier synced to active pull stroke (cycle mean ≈ 1.0) */
  forwardVelocityScale: number;
  /** Synced pelvis/spine yaw torque in radians (twists torso into the pulling shoulder) */
  torsoTwistRad: number;
  /** Synced torso roll in radians (subtle weight shift onto planted elbow/ribs) */
  torsoRollRad: number;
  /** Synced local Z surge of pelvis/torso (m, negative = surges forward during pull) */
  torsoSurgeZ: number;
  /** Synced vertical chest heave (m, slight lift during peak pull) */
  torsoHeaveY: number;
}

export function createCrawlerClawCycleSample(): CrawlerClawCycleSample {
  const makeArm = (): CrawlerArmStrokeSample => ({
    cycleU: 0,
    contact01: 0,
    reach01: 0.5,
    lift01: 0,
    pullDrive01: 0,
    targetZ: -0.52,
    targetFloorClearanceY: 0.052,
    targetLateralX: 0.24,
  });
  return {
    left: makeArm(),
    right: makeArm(),
    combinedPullDrive01: 0,
    forwardVelocityScale: 1,
    torsoTwistRad: 0,
    torsoRollRad: 0,
    torsoSurgeZ: 0,
    torsoHeaveY: 0,
  };
}

// Stance takes 48% of the full cycle per arm so alternating left/right claw pulls
// deliver crisp pull-lurch surges separated by brief hand-swap transitions.
const STANCE_FRAC = 0.48;
const SWING_FRAC = 1 - STANCE_FRAC;
const REACH_FAR_Z = -0.68; // Full outstretched forward claw plant ahead of head (-Z)
const REACH_NEAR_Z = -0.34; // Pulled back beside jaw/upper chest (-Z), 34cm grounded drag stroke
const HAND_GROUND_CLEARANCE_Y = 0.050; // Palm pivot ~5cm above floor -> fingertips scrape at ~+2cm
const HAND_SWING_LIFT_Y = 0.072; // Peak recovery clearance ~12.2cm above floor (never waving overhead!)

function evaluateSingleArmStroke(
  phaseRad: number,
  side: -1 | 1,
  moveBlend: number,
  out: CrawlerArmStrokeSample,
): void {
  const rawU = (phaseRad / (Math.PI * 2)) % 1;
  const u = rawU < 0 ? rawU + 1 : rawU;
  out.cycleU = u;

  if (u < STANCE_FRAC) {
    // Grounded claw-pull power stroke: palm planted flush on floor plane, dragging backward
    const s = u / STANCE_FRAC; // 0 -> 1 across pull
    const smoothS = s * s * (3 - 2 * s);
    // Derivative of smoothstep: 6*s*(1-s), peaks at 1.5 at mid-pull (s = 0.5)
    const pullVelNorm = 4 * s * (1 - s); // 0 -> 1 -> 0 smooth bell curve peaking at s = 0.5

    // Soft plant-in [0..0.08] and peel-off [0.90..1.0]
    const plantIn = THREE.MathUtils.clamp(s / 0.08, 0, 1);
    const peelOut = THREE.MathUtils.clamp((1 - s) / 0.10, 0, 1);
    const contact = Math.min(plantIn, peelOut);

    const reach01 = 1 - smoothS; // 1 (far forward) -> 0 (pulled back)
    const blendedReach = THREE.MathUtils.lerp(0.55, reach01, moveBlend);

    out.contact01 = THREE.MathUtils.lerp(1, contact, moveBlend);
    out.reach01 = blendedReach;
    out.lift01 = 0;
    out.pullDrive01 = pullVelNorm * contact * moveBlend;
    out.targetZ = THREE.MathUtils.lerp(REACH_NEAR_Z, REACH_FAR_Z, blendedReach);
    // Tiny 3mm press-down during peak claw grip, strictly above floor
    out.targetFloorClearanceY = HAND_GROUND_CLEARANCE_Y - 0.003 * out.pullDrive01;
    // Pull arcs slightly outward around shoulder/ribcage as elbow flares laterally
    out.targetLateralX = side * THREE.MathUtils.lerp(0.285, 0.215, blendedReach);
  } else {
    // Low forward recovery swing: lifts only ~7cm to skim over debris and re-plant ahead
    const r = (u - STANCE_FRAC) / SWING_FRAC; // 0 -> 1 across recovery
    const smoothR = r * r * (3 - 2 * r);
    const liftArc = Math.sin(r * Math.PI);

    const blendedReach = THREE.MathUtils.lerp(0.55, smoothR, moveBlend);
    const blendedLift = liftArc * moveBlend;

    out.contact01 = 0;
    out.reach01 = blendedReach;
    out.lift01 = blendedLift;
    out.pullDrive01 = 0;
    out.targetZ = THREE.MathUtils.lerp(REACH_NEAR_Z, REACH_FAR_Z, blendedReach);
    out.targetFloorClearanceY = HAND_GROUND_CLEARANCE_Y + HAND_SWING_LIFT_Y * blendedLift;
    // Swing arcs slightly wider laterally to clear ribs cleanly
    out.targetLateralX = side * (THREE.MathUtils.lerp(0.285, 0.215, blendedReach) + 0.042 * blendedLift);
  }
}

/**
 * Evaluates the synchronized alternating claw-pull stroke for an Infected crawler.
 * Shared by both InfectedZombieRig (bone kinematics) and InfectionZombieAI (forward propulsion)
 * so forward velocity surges in exact lockstep with the grounded pulling arm and torso twist.
 */
export function evaluateCrawlerClawCycle(
  walkCycle: number,
  moveBlend: number,
  out: CrawlerClawCycleSample,
): CrawlerClawCycleSample {
  const mb = THREE.MathUtils.clamp(moveBlend, 0, 1);
  evaluateSingleArmStroke(walkCycle, -1, mb, out.left);
  evaluateSingleArmStroke(walkCycle + Math.PI, 1, mb, out.right);

  const combinedPull = Math.min(1.25, out.left.pullDrive01 + out.right.pullDrive01);
  out.combinedPullDrive01 = combinedPull;

  // Cycle integral of combinedPull over [0, 2*PI) is ~0.614 when moveBlend = 1.
  // Calibrated so average forwardVelocityScale across one full cycle ≈ 1.0,
  // dipping to ~0.28 during hand-swap transitions and surging to ~1.46 at peak grounded pull.
  out.forwardVelocityScale = 0.28 + 1.18 * combinedPull;

  // Torso twists toward the active pulling side:
  // When left arm pulls back (pullDriveL > 0, reachL decreasing) & right reaches forward,
  // upper torso yaws slightly left (+Y yaw turns -Z toward -X) while pelvis counter-twists.
  const reachDiff = out.right.reach01 - out.left.reach01; // +1 when R far & L near
  const pullDiff = out.left.pullDrive01 - out.right.pullDrive01; // +1 when L actively pulling
  out.torsoTwistRad = (reachDiff * 0.14 + pullDiff * 0.12) * mb;
  out.torsoRollRad = (pullDiff * 0.095 + reachDiff * 0.045) * mb;
  // Torso lurches slightly forward (-Z) during peak pull and settles back during recovery
  out.torsoSurgeZ = -(combinedPull - 0.52) * 0.042 * mb;
  out.torsoHeaveY = combinedPull * 0.018 * mb;

  return out;
}

export interface CrawlerOrientedCapsule {
  /** Rear hemisphere center (pelvis / severed stumps) in world space */
  pelvisCenter: THREE.Vector3;
  /** Front hemisphere center (upper thorax / shoulders) in world space */
  thoraxCenter: THREE.Vector3;
  /** Midpoint of the prone torso/pelvis capsule in world space */
  center: THREE.Vector3;
  /** Unit axis pointing from pelvisCenter toward thoraxCenter (strictly perpendicular to floorNormal) */
  axis: THREE.Vector3;
  /** Unit floor surface normal to which the capsule is strictly oriented */
  normal: THREE.Vector3;
  /** Capsule radius (m) */
  radius: number;
  /** Half-length between pelvisCenter and thoraxCenter (m) */
  halfLength: number;
  /** World-space bottom Y of the oriented capsule */
  minY: number;
  /** World-space top Y of the oriented capsule */
  maxY: number;
}

export interface CrawlerGroundPlaneState {
  initialized: boolean;
  /** Raw floor surface height directly under the crawler center (m) */
  groundY: number;
  /** Smoothed unit floor surface normal (+Y on flat floors, perpendicular to ramps/slopes) */
  floorNormal: THREE.Vector3;
  /** Floor-projected unit forward direction (-Z in crawler local space) */
  floorForward: THREE.Vector3;
  /** Floor-projected unit right direction (+X in crawler local space) */
  floorRight: THREE.Vector3;
  /** Root transform lift offset along floorNormal derived from crawler bone height (m) */
  rootLiftOffsetM: number;
  /** Final solved world position for rig.root (ground point + floorNormal * rootLiftOffsetM) */
  rootPosition: THREE.Vector3;
  /** Final solved world orientation for rig.root (local +Y === floorNormal, local -Z === floorForward) */
  rootQuaternion: THREE.Quaternion;
  /** Floor-normal-oriented prone torso/pelvis collision capsule */
  capsule: CrawlerOrientedCapsule;
}

export function createCrawlerGroundPlaneState(heightScale = 1): CrawlerGroundPlaneState {
  const metrics = computeCrawlerBoneMetrics(heightScale);
  return {
    initialized: false,
    groundY: 0,
    floorNormal: new THREE.Vector3(0, 1, 0),
    floorForward: new THREE.Vector3(0, 0, -1),
    floorRight: new THREE.Vector3(1, 0, 0),
    rootLiftOffsetM: metrics.rootLiftOffsetM,
    rootPosition: new THREE.Vector3(0, metrics.rootLiftOffsetM, 0),
    rootQuaternion: new THREE.Quaternion(),
    capsule: {
      pelvisCenter: new THREE.Vector3(0, metrics.capsuleRadiusM, metrics.capsuleHalfLengthM),
      thoraxCenter: new THREE.Vector3(0, metrics.capsuleRadiusM, -metrics.capsuleHalfLengthM),
      center: new THREE.Vector3(0, metrics.capsuleRadiusM, 0),
      axis: new THREE.Vector3(0, 0, -1),
      normal: new THREE.Vector3(0, 1, 0),
      radius: metrics.capsuleRadiusM,
      halfLength: metrics.capsuleHalfLengthM,
      minY: 0,
      maxY: metrics.capsuleRadiusM * 2,
    },
  };
}

export interface CrawlerGroundSolveOptions {
  /** Optional outdoor terrain sampler (for rolling hills) */
  terrainHeightAt?: (x: number, z: number) => number;
  /** If true, snaps normal & height immediately without damping (e.g. spawn / leg-sever conversion) */
  snap?: boolean;
  /** Max climbable step height for ground probing (default 0.85m) */
  maxStepUpM?: number;
}

// Module-scope zero-GC scratch objects
const _targetNormal = new THREE.Vector3();
const _rampNormal = new THREE.Vector3();
const _probeNormal = new THREE.Vector3();
const _tanFwd = new THREE.Vector3();
const _tanRight = new THREE.Vector3();
const _headingFwd = new THREE.Vector3();
const _backAxis = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();

function sampleRampYAndNormal(
  r: PhysicsRampCollider,
  x: number,
  z: number,
  outNormal: THREE.Vector3,
): number {
  const rise = r.topY - r.baseY;
  let t = 0;
  if (r.riseAxis === '+x') {
    const run = Math.max(EPS, r.maxX - r.minX);
    t = (x - r.minX) / run;
    outNormal.set(-rise / run, 1, 0).normalize();
  } else if (r.riseAxis === '-x') {
    const run = Math.max(EPS, r.maxX - r.minX);
    t = (r.maxX - x) / run;
    outNormal.set(rise / run, 1, 0).normalize();
  } else if (r.riseAxis === '+z') {
    const run = Math.max(EPS, r.maxZ - r.minZ);
    t = (z - r.minZ) / run;
    outNormal.set(0, 1, -rise / run).normalize();
  } else {
    const run = Math.max(EPS, r.maxZ - r.minZ);
    t = (r.maxZ - z) / run;
    outNormal.set(0, 1, rise / run).normalize();
  }
  return r.baseY + rise * THREE.MathUtils.clamp(t, 0, 1);
}

function sampleCombinedHeight(
  physics: BodycamPhysicsWorld,
  x: number,
  z: number,
  refY: number,
  maxStepUp: number,
  footRadius: number,
  terrainHeightAt?: (x: number, z: number) => number,
): number {
  let h = physics.getGroundHeight(x, z, refY, maxStepUp, footRadius);
  if (terrainHeightAt) {
    const th = terrainHeightAt(x, z);
    if (Number.isFinite(th) && th <= refY + maxStepUp + 0.2 && th > h) {
      h = th;
    }
  }
  return h;
}

/**
 * Checks whether a point (x, z, groundY) rests on a sloped PhysicsRampCollider and,
 * if so, writes its exact analytical upward normal into `outNormal`.
 */
function findSupportingRampNormal(
  physics: BodycamPhysicsWorld,
  x: number,
  z: number,
  groundY: number,
  margin: number,
  outNormal: THREE.Vector3,
): boolean {
  const ramps = physics.ramps;
  if (!ramps || ramps.length === 0) return false;
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    if (
      x + margin < r.minX ||
      x - margin > r.maxX ||
      z + margin < r.minZ ||
      z - margin > r.maxZ
    ) {
      continue;
    }
    const ry = sampleRampYAndNormal(r, x, z, outNormal);
    if (Math.abs(ry - groundY) < 0.09) {
      return true;
    }
  }
  return false;
}

/**
 * Dedicated Zero-GC Ground-Plane Solver for Infected Crawlers.
 *
 * 1. Samples the supporting ground plane beneath the crawler's prone footprint (analytical
 *    ramp normal + 5-point prone plane fit with step-discontinuity protection).
 * 2. Smoothly aligns the crawler's root quaternion so local +Y strictly matches `floorNormal`
 *    and local -Z tracks the floor-projected heading vector.
 * 3. Applies a bone-height-derived root lift offset along `floorNormal` to prevent floor clipping.
 * 4. Builds the prone torso/pelvis collision capsule strictly oriented to `floorNormal`.
 */
export function solveCrawlerGroundPlane(
  physics: BodycamPhysicsWorld,
  x: number,
  refY: number,
  z: number,
  yaw: number,
  heightScale: number,
  dt: number,
  state: CrawlerGroundPlaneState,
  options?: CrawlerGroundSolveOptions,
): CrawlerGroundPlaneState {
  const metrics = computeCrawlerBoneMetrics(heightScale);
  const maxStepUp = options?.maxStepUpM ?? 0.85;
  const terrainHeightAt = options?.terrainHeightAt;
  const snap = Boolean(options?.snap) || !state.initialized;

  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);

  // 1. Sample 5-point prone footprint: center, front chest, rear pelvis, left flank, right flank
  const probeFwd = 0.36 * heightScale;
  const probeBack = 0.30 * heightScale;
  const probeSide = 0.22 * heightScale;

  const hCenter = sampleCombinedHeight(physics, x, z, refY, maxStepUp, 0.12, terrainHeightAt);
  const hFrontRaw = sampleCombinedHeight(
    physics,
    x + fwdX * probeFwd,
    z + fwdZ * probeFwd,
    hCenter,
    0.55,
    0.06,
    terrainHeightAt,
  );
  const hBackRaw = sampleCombinedHeight(
    physics,
    x - fwdX * probeBack,
    z - fwdZ * probeBack,
    hCenter,
    0.55,
    0.06,
    terrainHeightAt,
  );
  const hRightRaw = sampleCombinedHeight(
    physics,
    x + rightX * probeSide,
    z + rightZ * probeSide,
    hCenter,
    0.45,
    0.05,
    terrainHeightAt,
  );
  const hLeftRaw = sampleCombinedHeight(
    physics,
    x - rightX * probeSide,
    z - rightZ * probeSide,
    hCenter,
    0.45,
    0.05,
    terrainHeightAt,
  );

  // Clamp abrupt cliff/curb discontinuities so vertical drops or tall walls don't tilt the crawler sideways
  const maxLongDelta = (probeFwd + probeBack) * 0.72;
  const maxLatDelta = probeSide * 2 * 0.65;
  const hFront = THREE.MathUtils.clamp(hFrontRaw, hCenter - maxLongDelta * 0.55, hCenter + maxLongDelta * 0.55);
  const hBack = THREE.MathUtils.clamp(hBackRaw, hCenter - maxLongDelta * 0.55, hCenter + maxLongDelta * 0.55);
  const hRight = THREE.MathUtils.clamp(hRightRaw, hCenter - maxLatDelta * 0.55, hCenter + maxLatDelta * 0.55);
  const hLeft = THREE.MathUtils.clamp(hLeftRaw, hCenter - maxLatDelta * 0.55, hCenter + maxLatDelta * 0.55);

  // Footprint plane normal from tangent cross product: cross(rightVec, fwdVec) -> points +Y!
  // Check: right=(1,0,0), fwd=(0,0,-1) => (1,0,0) x (0,0,-1) = (0, +1, 0).
  _tanFwd.set(
    fwdX * (probeFwd + probeBack),
    hFront - hBack,
    fwdZ * (probeFwd + probeBack),
  );
  _tanRight.set(
    rightX * (probeSide * 2),
    hRight - hLeft,
    rightZ * (probeSide * 2),
  );
  _probeNormal.crossVectors(_tanRight, _tanFwd);
  if (_probeNormal.lengthSq() > 1e-8) {
    _probeNormal.normalize();
    if (_probeNormal.y < 0) _probeNormal.negate();
  } else {
    _probeNormal.set(0, 1, 0);
  }

  // Analytical ramp normal check (exact noise-free normal when resting on a sloped PhysicsRampCollider)
  const onRamp = findSupportingRampNormal(physics, x, z, hCenter, 0.08, _rampNormal);
  if (onRamp) {
    // Blend 85% exact analytical ramp normal + 15% footprint plane so ramp entry/exit transitions smoothly
    // while staying strictly aligned to the ramp plane across the full ramp span
    const frontOnRamp = findSupportingRampNormal(
      physics,
      x + fwdX * probeFwd,
      z + fwdZ * probeFwd,
      hFrontRaw,
      0.08,
      _targetNormal,
    );
    const backOnRamp = findSupportingRampNormal(
      physics,
      x - fwdX * probeBack,
      z - fwdZ * probeBack,
      hBackRaw,
      0.08,
      _targetNormal,
    );
    if (frontOnRamp && backOnRamp) {
      _targetNormal.copy(_rampNormal);
    } else {
      _targetNormal.copy(_rampNormal).lerp(_probeNormal, 0.35).normalize();
    }
  } else {
    _targetNormal.copy(_probeNormal);
  }

  // Clamp slope tilt to physically walkable maximum (50 degrees)
  if (_targetNormal.y < MAX_WALKABLE_SLOPE_COS) {
    const horizLen = Math.hypot(_targetNormal.x, _targetNormal.z);
    const maxHoriz = Math.sqrt(Math.max(0, 1 - MAX_WALKABLE_SLOPE_COS * MAX_WALKABLE_SLOPE_COS));
    if (horizLen > EPS) {
      const k = maxHoriz / horizLen;
      _targetNormal.set(_targetNormal.x * k, MAX_WALKABLE_SLOPE_COS, _targetNormal.z * k).normalize();
    } else {
      _targetNormal.set(0, 1, 0);
    }
  }

  // Exact distance-weighted chord height at center (0 error on linear ramps, lifts cleanly on crests)
  const chordAtCenterY = (hFront * probeBack + hBack * probeFwd) / Math.max(EPS, probeFwd + probeBack);
  const supportGroundY = Math.max(hCenter, chordAtCenterY);

  // 2. Smoothly damp floorNormal & groundY (or snap on spawn / dismemberment)
  if (snap) {
    state.groundY = supportGroundY;
    state.floorNormal.copy(_targetNormal);
    state.initialized = true;
  } else {
    const safeDt = Math.max(0, Math.min(0.1, dt));
    const yAlpha = 1 - Math.exp(-18 * safeDt);
    const nAlpha = 1 - Math.exp(-14 * safeDt);
    state.groundY = THREE.MathUtils.lerp(state.groundY, supportGroundY, yAlpha);
    state.floorNormal.lerp(_targetNormal, nAlpha).normalize();
  }

  // 3. Construct exact orthonormal surface-aligned basis [floorRight, floorNormal, -floorForward]
  _headingFwd.set(fwdX, 0, fwdZ);
  const dotUp = _headingFwd.dot(state.floorNormal);
  state.floorForward.copy(_headingFwd).addScaledVector(state.floorNormal, -dotUp);
  if (state.floorForward.lengthSq() < 1e-6) {
    state.floorForward.set(0, 0, -1);
  } else {
    state.floorForward.normalize();
  }
  // Right = cross(floorForward, floorNormal) -> +X when fwd=(0,0,-1), up=(0,1,0)
  state.floorRight.crossVectors(state.floorForward, state.floorNormal).normalize();
  // Back (+Z) = cross(floorRight, floorNormal) -> guarantees strict orthogonality & det = +1
  _backAxis.crossVectors(state.floorRight, state.floorNormal).normalize();
  state.floorForward.copy(_backAxis).negate();

  _basisMat.makeBasis(state.floorRight, state.floorNormal, _backAxis);
  state.rootQuaternion.setFromRotationMatrix(_basisMat);

  // 4. Bone-height-derived root lift offset strictly along floorNormal (eliminates floor clipping)
  state.rootLiftOffsetM = metrics.rootLiftOffsetM;
  state.rootPosition
    .set(x, state.groundY, z)
    .addScaledVector(state.floorNormal, state.rootLiftOffsetM);

  // 5. Floor-normal-oriented prone torso/pelvis collision capsule
  const cap = state.capsule;
  cap.radius = metrics.capsuleRadiusM;
  cap.halfLength = metrics.capsuleHalfLengthM;
  cap.normal.copy(state.floorNormal);
  cap.axis.copy(state.floorForward); // Strictly orthogonal to cap.normal!

  // Center the capsule cleanly above the floor along floorNormal so bottom rests flush on ground plane
  const capsuleCenterLift = cap.radius + state.rootLiftOffsetM * 0.25;
  cap.center
    .set(x, state.groundY, z)
    .addScaledVector(state.floorNormal, capsuleCenterLift);

  // Pelvis trails slightly aft (-axis), thorax extends forward (+axis)
  cap.pelvisCenter.copy(cap.center).addScaledVector(cap.axis, -cap.halfLength);
  cap.thoraxCenter.copy(cap.center).addScaledVector(cap.axis, cap.halfLength);

  const lowEndY = Math.min(cap.pelvisCenter.y, cap.thoraxCenter.y);
  const highEndY = Math.max(cap.pelvisCenter.y, cap.thoraxCenter.y);
  cap.minY = lowEndY - cap.radius;
  cap.maxY = highEndY + cap.radius;

  return state;
}

/**
 * Low-profile obstacle clearance test for crawler pathfinding & obstacle-avoidance whiskers.
 * Uses the crawler's prone torso/pelvis height envelope rather than upright human height.
 */
export function isCrawlerFootprintBlocked(
  physics: BodycamPhysicsWorld,
  x: number,
  baseY: number,
  z: number,
  radius: number,
  heightScale = 1,
): boolean {
  if (
    x < physics.boundsMinX + radius ||
    x > physics.boundsMaxX - radius ||
    z < physics.boundsMinZ + radius ||
    z > physics.boundsMaxZ - radius
  ) {
    return true;
  }
  const metrics = computeCrawlerBoneMetrics(heightScale);
  const rSq = radius * radius;
  // Prone vertical envelope: clears floor curb lips (~0.12m) up to prone head/shoulder crown (~0.56m)
  const pyMin = baseY + Math.max(0.10, metrics.rootLiftOffsetM * 2.1);
  const pyMax = baseY + 0.56 * Math.max(0.85, heightScale);
  const boxes = physics.boxes;
  if (!boxes) return false;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.blocksMovement === false) continue;
    if (pyMax <= b.minY + 0.02 || pyMin >= b.maxY - 0.02) continue;
    const qx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
    const qz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
    const dx = x - qx;
    const dz = z - qz;
    if (dx * dx + dz * dz < rSq) return true;
  }
  return false;
}

/**
 * Resolves the crawler's floor-normal-oriented prone torso/pelvis capsule against solid world
 * boxes, dynamic hinged doors, and map bounds. Tests both the pelvis hemisphere and the thorax
 * hemisphere along the floor-projected spine axis so neither the chest nor trailing stumps clip walls.
 */
export function resolveCrawlerCapsuleWorldCollision(
  physics: BodycamPhysicsWorld,
  proposedX: number,
  baseY: number,
  proposedZ: number,
  state: Readonly<CrawlerGroundPlaneState>,
  out: { x: number; z: number },
): { x: number; z: number } {
  const cap = state.capsule;
  const r = Math.max(0.16, cap.radius);
  const rSq = r * r;

  // Horizontal projection of the floor-oriented torso/pelvis capsule half-extent
  const halfAxisX = cap.axis.x * cap.halfLength * 0.72;
  const halfAxisZ = cap.axis.z * cap.halfLength * 0.72;
  const boundPad = r + Math.hypot(halfAxisX, halfAxisZ) * 0.5;

  let cx = THREE.MathUtils.clamp(proposedX, physics.boundsMinX + boundPad, physics.boundsMaxX - boundPad);
  let cz = THREE.MathUtils.clamp(proposedZ, physics.boundsMinZ + boundPad, physics.boundsMaxZ - boundPad);

  // Use the oriented capsule's true vertical bounds (shifted slightly above floor tolerance to ignore floor slabs)
  const pyMin = Math.max(baseY + 0.14, cap.minY + 0.10);
  const pyMax = Math.max(pyMin + 0.28, cap.maxY + 0.06);

  const boxes = physics.boxes ?? [];
  const slabs = physics.slabs ?? [];

  // Test pelvis hemisphere (-1), center (0), and thorax hemisphere (+1) along the oriented capsule axis
  for (let pass = 0; pass < 3; pass++) {
    let pushed = false;
    for (let sIdx = -1; sIdx <= 1; sIdx++) {
      const offX = halfAxisX * sIdx;
      const offZ = halfAxisZ * sIdx;
      let sx = cx + offX;
      let sz = cz + offZ;

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.blocksMovement === false) continue;
        if (pyMax <= b.minY + 0.02 || pyMin >= b.maxY - 0.02) continue;

        const qx = THREE.MathUtils.clamp(sx, b.minX, b.maxX);
        const qz = THREE.MathUtils.clamp(sz, b.minZ, b.maxZ);
        const dx = sx - qx;
        const dz = sz - qz;
        const dSq = dx * dx + dz * dz;
        if (dSq < rSq) {
          pushed = true;
          if (dSq > 1e-6) {
            const d = Math.sqrt(dSq);
            const pen = r - d;
            const px = (dx / d) * pen;
            const pz = (dz / d) * pen;
            sx += px;
            sz += pz;
            cx += px;
            cz += pz;
          } else {
            const dl = Math.abs(sx - b.minX);
            const dr = Math.abs(b.maxX - sx);
            const df = Math.abs(sz - b.minZ);
            const db = Math.abs(b.maxZ - sz);
            const m = Math.min(dl, dr, df, db);
            let px = 0;
            let pz = 0;
            if (m === dl) px = b.minX - r - sx;
            else if (m === dr) px = b.maxX + r - sx;
            else if (m === df) pz = b.minZ - r - sz;
            else pz = b.maxZ + r - sz;
            sx += px;
            sz += pz;
            cx += px;
            cz += pz;
          }
        }
      }

      // Dynamic oriented slabs (hinged doors)
      for (let i = 0; i < slabs.length; i++) {
        const sl = slabs[i];
        if (!sl.active) continue;
        if (pyMax <= sl.minY + 0.02 || pyMin >= sl.maxY - 0.02) continue;
        const relX = sx - sl.originX;
        const relZ = sz - sl.originZ;
        const proj = THREE.MathUtils.clamp(relX * sl.dirX + relZ * sl.dirZ, 0, sl.length);
        const qx = sl.originX + sl.dirX * proj;
        const qz = sl.originZ + sl.dirZ * proj;
        const dx = sx - qx;
        const dz = sz - qz;
        const dSq = dx * dx + dz * dz;
        const combR = r + sl.halfThickness;
        if (dSq < combR * combR) {
          pushed = true;
          if (dSq > 1e-6) {
            const d = Math.sqrt(dSq);
            const pen = (combR - d) * (sl.rigidBlocked === false ? 0.65 : 1.0);
            const px = (dx / d) * pen;
            const pz = (dz / d) * pen;
            sx += px;
            sz += pz;
            cx += px;
            cz += pz;
          }
        }
      }
    }
    if (!pushed) break;
  }

  out.x = THREE.MathUtils.clamp(cx, physics.boundsMinX + boundPad, physics.boundsMaxX - boundPad);
  out.z = THREE.MathUtils.clamp(cz, physics.boundsMinZ + boundPad, physics.boundsMaxZ - boundPad);
  return out;
}

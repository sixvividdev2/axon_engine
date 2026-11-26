import * as THREE from 'three';
import type { CharacterSkeleton } from '../CharacterSkeleton';
import {
  createTwoBoneIKResult,
  orientLimbAlongYInRootSpace,
  setTransformInRootSpace,
  solveTwoBoneIK,
  TwoBoneIKResult,
} from '../IKSolver';

export type StandingNpcGesture =
  | 'tinker'
  | 'briefing'
  | 'clipboard'
  | 'radio_check'
  | 'rifle_ready'
  | 'at_ease';

export type SeatedOperatorStyle = 'heli_pilot' | 'heli_crew' | 'heli_door_gunner' | 'apc_driver';

// Pre-allocated zero-GC scratch objects shared across all NPC & cinematic pose evaluations
const _invRootMat = new THREE.Matrix4();
const _shoulderRoot = new THREE.Vector3();
const _hipRoot = new THREE.Vector3();
const _targetRoot = new THREE.Vector3();
const _poleRoot = new THREE.Vector3();
const _targetRootR = new THREE.Vector3();
const _targetRootL = new THREE.Vector3();
const _poleRootR = new THREE.Vector3();
const _poleRootL = new THREE.Vector3();
const _ankleRootL = new THREE.Vector3();
const _ankleRootR = new THREE.Vector3();
const _kneePoleL = new THREE.Vector3();
const _kneePoleR = new THREE.Vector3();
const _handEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _handQuat = new THREE.Quaternion();
const _bootEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _bootQuat = new THREE.Quaternion();
const _ikArmL: TwoBoneIKResult = createTwoBoneIKResult();
const _ikArmR: TwoBoneIKResult = createTwoBoneIKResult();
const _ikLegL: TwoBoneIKResult = createTwoBoneIKResult();
const _ikLegR: TwoBoneIKResult = createTwoBoneIKResult();
const _savedRootPos = new THREE.Vector3();
const _savedRootRot = new THREE.Euler();
const _savedRootScale = new THREE.Vector3();

function saveRootTransform(root: THREE.Object3D): void {
  _savedRootPos.copy(root.position);
  _savedRootRot.copy(root.rotation);
  _savedRootScale.copy(root.scale);
}

function restoreRootTransform(root: THREE.Object3D): void {
  root.position.copy(_savedRootPos);
  root.rotation.copy(_savedRootRot);
  root.scale.copy(_savedRootScale);
}

/**
 * Solves a single arm (left = -1, right = +1) in skeleton root local space using
 * analytic two-bone IK (`solveTwoBoneIK` + `orientLimbAlongYInRootSpace`).
 * Guarantees anatomically valid forward elbow bends and zero upward bone-axis inversion.
 */
export function solveArmTwoBoneIK(
  skeleton: CharacterSkeleton,
  side: -1 | 1,
  handTargetRoot: THREE.Vector3,
  elbowPoleRoot: THREE.Vector3,
  handYawRad = 0,
  handPitchRad = 0,
  handRollRad = 0,
): void {
  const arm = side < 0 ? skeleton.leftArm : skeleton.rightArm;
  const ikOut = side < 0 ? _ikArmL : _ikArmR;

  skeleton.root.updateMatrixWorld(true);
  _invRootMat.copy(skeleton.root.matrixWorld).invert();
  arm.shoulderPivot.getWorldPosition(_shoulderRoot).applyMatrix4(_invRootMat);

  solveTwoBoneIK(
    _shoulderRoot,
    handTargetRoot,
    elbowPoleRoot,
    arm.upperLen,
    arm.lowerLen,
    ikOut,
  );

  orientLimbAlongYInRootSpace(
    arm.upperArm,
    skeleton.root,
    _shoulderRoot,
    ikOut.midPos,
    elbowPoleRoot,
  );
  orientLimbAlongYInRootSpace(
    arm.forearm,
    skeleton.root,
    ikOut.midPos,
    ikOut.endPos,
    elbowPoleRoot,
  );

  _handEuler.set(handPitchRad, handYawRad, handRollRad, 'YXZ');
  _handQuat.setFromEuler(_handEuler);
  setTransformInRootSpace(arm.hand.root, skeleton.root, ikOut.endPos, _handQuat);
}

/**
 * Solves a single leg (left = -1, right = +1) in skeleton root local space using
 * analytic two-bone IK with flat horizontal boot orientation.
 */
export function solveLegTwoBoneIK(
  skeleton: CharacterSkeleton,
  side: -1 | 1,
  ankleTargetRoot: THREE.Vector3,
  kneePoleRoot: THREE.Vector3,
  toeOutRad = 0.12,
  footPitchRad = 0,
): void {
  const leg = side < 0 ? skeleton.leftLeg : skeleton.rightLeg;
  const ikOut = side < 0 ? _ikLegL : _ikLegR;

  skeleton.root.updateMatrixWorld(true);
  _invRootMat.copy(skeleton.root.matrixWorld).invert();
  leg.hipPivot.getWorldPosition(_hipRoot).applyMatrix4(_invRootMat);

  solveTwoBoneIK(_hipRoot, ankleTargetRoot, kneePoleRoot, leg.upperLen, leg.lowerLen, ikOut);

  orientLimbAlongYInRootSpace(leg.thigh, skeleton.root, _hipRoot, ikOut.midPos, kneePoleRoot);
  orientLimbAlongYInRootSpace(leg.shin, skeleton.root, ikOut.midPos, ikOut.endPos, kneePoleRoot);

  _bootEuler.set(footPitchRad, side < 0 ? toeOutRad : -toeOutRad, 0, 'YXZ');
  _bootQuat.setFromEuler(_bootEuler);
  setTransformInRootSpace(leg.boot, skeleton.root, ikOut.endPos, _bootQuat);
}

/**
 * Computes root-space rifle mount transform and two-handed IK grip targets for an operator
 * cradling a firearm in chest-level low-ready (or raised combat aim).
 * Exported for deterministic unit testing.
 */
export function computeLowReadyRifleTargets(
  aimBlend01: number,
  swayRad = 0,
): {
  weaponChestLocalPos: [number, number, number];
  weaponChestLocalEuler: [number, number, number];
  rightHandRoot: [number, number, number];
  leftHandRoot: [number, number, number];
  rightElbowPoleRoot: [number, number, number];
  leftElbowPoleRoot: [number, number, number];
} {
  const a = THREE.MathUtils.clamp(aimBlend01, 0, 1);
  // Weapon mounted on skeleton.chest (chest sits at ~y=1.34m in root space, forward = -Z)
  // At low-ready (a=0): rifle sits diagonally across lower chest, barrel safely angled down-left (-X, -Y, -Z)
  // At combat aim (a=1): rifle is shouldered to right cheek pointing straight downrange (-Z)
  const wx = THREE.MathUtils.lerp(0.06, 0.13, a);
  const wy = THREE.MathUtils.lerp(-0.10, 0.04, a);
  const wz = THREE.MathUtils.lerp(-0.24, -0.26, a);

  const pitch = THREE.MathUtils.lerp(-0.32, -0.02, a) + swayRad * 0.2;
  const yaw = THREE.MathUtils.lerp(0.56, 0.04, a) + swayRad * 0.15;
  const roll = THREE.MathUtils.lerp(-0.14, -0.04, a);

  // Hand targets in skeleton root space (shoulder height ≈ 1.44m, waist ≈ 0.96m, chest ≈ 1.24m)
  const rHand: [number, number, number] = [
    THREE.MathUtils.lerp(0.14, 0.15, a),
    THREE.MathUtils.lerp(1.13, 1.32, a) + swayRad * 0.04,
    THREE.MathUtils.lerp(-0.22, -0.25, a),
  ];
  const lHand: [number, number, number] = [
    THREE.MathUtils.lerp(-0.12, 0.02, a),
    THREE.MathUtils.lerp(1.06, 1.33, a) + swayRad * 0.04,
    THREE.MathUtils.lerp(-0.34, -0.49, a),
  ];

  // Downward-outward-rearward elbow poles ensure elbows NEVER invert upward!
  const rPole: [number, number, number] = [0.36, 1.02, 0.14];
  const lPole: [number, number, number] = [-0.34, 0.98, -0.02];

  return {
    weaponChestLocalPos: [wx, wy, wz],
    weaponChestLocalEuler: [pitch, yaw, roll],
    rightHandRoot: rHand,
    leftHandRoot: lHand,
    rightElbowPoleRoot: rPole,
    leftElbowPoleRoot: lPole,
  };
}

/**
 * Applies an anatomically grounded standing pose & role-specific arm gesture to any
 * Hideout or Infection Outpost NPC (`CharacterSkeleton`).
 * Always starts from `applyPreviewReadyPose` so boots sit flat on y=0 and arms hang naturally.
 */
export function poseStandingNpcGesture(
  skeleton: CharacterSkeleton,
  gesture: StandingNpcGesture,
  timeSec: number,
  options?: {
    headYawRad?: number;
    headPitchRad?: number;
    torsoYawRad?: number;
    playerNear?: boolean;
    weaponMount?: THREE.Object3D | null;
  },
): void {
  saveRootTransform(skeleton.root);
  skeleton.applyPreviewReadyPose(timeSec);
  restoreRootTransform(skeleton.root);

  const headYaw = options?.headYawRad ?? 0;
  const headPitch = options?.headPitchRad ?? 0;
  const torsoYaw = options?.torsoYawRad ?? 0;
  const playerNear = options?.playerNear ?? false;

  // Apply damped gaze tracking cleanly on top of preview stance
  skeleton.spineUpper.rotation.y += torsoYaw;
  skeleton.neck.rotation.y += headYaw * 0.45;
  skeleton.headGroup.rotation.y += headYaw * 0.55;
  skeleton.headGroup.rotation.x += headPitch;

  const breath = Math.sin(timeSec * 1.65);

  switch (gesture) {
    case 'tinker': {
      // Armorer working calmly at waist/workbench height (hands ~1.02–1.08m, well below shoulders!)
      const workR = Math.sin(timeSec * 2.2) * 0.035;
      const workL = Math.cos(timeSec * 1.7) * 0.025;
      _targetRootR.set(0.16 + workR, 1.04 + Math.cos(timeSec * 2.6) * 0.015, -0.34);
      _poleRootR.set(0.36, 1.06, 0.14);
      _targetRootL.set(-0.15 + workL, 1.02, -0.32);
      _poleRootL.set(-0.36, 1.06, 0.14);
      solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.12, 0.35, -0.2);
      solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.12, 0.35, 0.2);
      skeleton.applyHandPose('left', 'unarmed', false, 0.55);
      skeleton.applyHandPose('right', 'unarmed', false, 0.65);
      break;
    }
    case 'briefing': {
      // Ops Commander standing grounded over war table; subtle low open-hand gesture when player is near
      const gest = playerNear ? Math.sin(timeSec * 2.0) * 0.045 : Math.sin(timeSec * 0.9) * 0.015;
      _targetRootR.set(0.18 + gest * 0.6, 1.08 + gest * 0.8, -0.30);
      _poleRootR.set(0.36, 1.06, 0.16);
      _targetRootL.set(-0.20, 1.00 + breath * 0.01, -0.22);
      _poleRootL.set(-0.34, 1.06, 0.18);
      solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.1, 0.2, -0.35);
      solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.1, 0.25, 0.3);
      skeleton.applyHandPose('left', 'unarmed', false, 0.35);
      skeleton.applyHandPose('right', 'unarmed', false, 0.25);
      break;
    }
    case 'clipboard': {
      // Quartermaster holding manifest tablet at lower-chest height with left arm, tapping notes with right
      const tap = Math.sin(timeSec * 2.6) * 0.025;
      _targetRootL.set(-0.12, 1.14 + breath * 0.008, -0.28);
      _poleRootL.set(-0.34, 1.02, 0.14);
      _targetRootR.set(0.06 + tap * 0.5, 1.15 + Math.abs(tap), -0.31);
      _poleRootR.set(0.34, 1.02, 0.14);
      solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.2, 0.4, 0.4);
      solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.25, 0.35, -0.3);
      skeleton.applyHandPose('left', 'unarmed', false, 0.65);
      skeleton.applyHandPose('right', 'unarmed', false, 0.5);
      break;
    }
    case 'radio_check': {
      // Contract Officer / Outpost Commander: relaxed tactical stance with periodic left-hand shoulder PTT press
      const ptt = THREE.MathUtils.smoothstep(Math.sin(timeSec * 0.55 - 0.8), 0.35, 0.92);
      _targetRootL.set(
        THREE.MathUtils.lerp(-0.24, -0.13, ptt),
        THREE.MathUtils.lerp(0.92, 1.32, ptt),
        THREE.MathUtils.lerp(-0.08, -0.17, ptt),
      );
      _poleRootL.set(-0.36, 1.02, 0.14);
      _targetRootR.set(0.24, 0.92 + breath * 0.008, -0.06);
      _poleRootR.set(0.36, 1.06, 0.18);
      solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.1, 0.2, 0.4);
      solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.05, 0.1, -0.4);
      skeleton.applyHandPose('left', 'unarmed', false, 0.4 + ptt * 0.35);
      skeleton.applyHandPose('right', 'unarmed', false, 0.35);
      break;
    }
    case 'rifle_ready': {
      // Two-handed chest-level low-ready rifle cradle solved cleanly via 2-bone IK
      const sway = Math.sin(timeSec * 1.3) * 0.035;
      const targets = computeLowReadyRifleTargets(0, sway);
      if (options?.weaponMount) {
        options.weaponMount.position.set(...targets.weaponChestLocalPos);
        options.weaponMount.rotation.set(...targets.weaponChestLocalEuler);
      }
      _targetRootR.set(...targets.rightHandRoot);
      _poleRootR.set(...targets.rightElbowPoleRoot);
      _targetRootL.set(...targets.leftHandRoot);
      _poleRootL.set(...targets.leftElbowPoleRoot);
      solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.15, 0.1, -0.2);
      solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.15, 0.2, 0.35);
      skeleton.applyHandPose('right', 'rifle', false, 0.88);
      skeleton.applyHandPose('left', 'rifle', false, 0.82);
      break;
    }
    case 'at_ease':
    default: {
      if (options?.weaponMount) {
        // Relaxed low-carry rifle slung diagonally across front torso
        const sway = Math.sin(timeSec * 1.0) * 0.02;
        const targets = computeLowReadyRifleTargets(0, sway);
        options.weaponMount.position.set(
          targets.weaponChestLocalPos[0],
          targets.weaponChestLocalPos[1] - 0.05,
          targets.weaponChestLocalPos[2] + 0.02,
        );
        options.weaponMount.rotation.set(
          targets.weaponChestLocalEuler[0] - 0.14,
          targets.weaponChestLocalEuler[1] + 0.08,
          targets.weaponChestLocalEuler[2],
        );
        _targetRootR.set(targets.rightHandRoot[0], targets.rightHandRoot[1] - 0.06, targets.rightHandRoot[2] + 0.02);
        _poleRootR.set(...targets.rightElbowPoleRoot);
        _targetRootL.set(targets.leftHandRoot[0], targets.leftHandRoot[1] - 0.07, targets.leftHandRoot[2] + 0.03);
        _poleRootL.set(...targets.leftElbowPoleRoot);
        solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.15, 0.1, -0.2);
        solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.15, 0.2, 0.35);
        skeleton.applyHandPose('right', 'rifle', false, 0.82);
        skeleton.applyHandPose('left', 'rifle', false, 0.78);
      }
      // If unarmed at_ease, keep `applyPreviewReadyPose`'s clean natural hanging arms!
      break;
    }
  }

  skeleton.root.updateMatrixWorld(true);
}

/**
 * Seats an operator cleanly on a helicopter pilot seat, helicopter troop bench, or APC driver seat
 * using root-space two-bone IK for both legs (knees bent forward, boots flat on floor deck)
 * and both arms (gripping cyclic/collective, cradling carbine, or holding steering wheel).
 * `skeleton.root.position.y` should be placed directly on the vehicle's floor deck!
 */
export function poseSeatedOperator(
  skeleton: CharacterSkeleton,
  style: SeatedOperatorStyle,
  timeSec: number,
  options?: {
    seatHeightAboveFloor?: number;
    headYawRad?: number;
    headPitchRad?: number;
    recoilKick01?: number;
    /** Smooth 0..1 idle-to-firing combat engagement blend synced with warzone events */
    combatEngage01?: number;
    weaponMount?: THREE.Object3D | null;
  },
): void {
  saveRootTransform(skeleton.root);
  skeleton.applyCanonicalRestPose();
  restoreRootTransform(skeleton.root);

  const p = skeleton.profile;
  const seatH = options?.seatHeightAboveFloor ?? (style === 'apc_driver' ? 0.42 : 0.44);
  const breath = Math.sin(timeSec * 1.9);
  const vib = Math.sin(timeSec * 16.0) * 0.004;
  const recoil = THREE.MathUtils.clamp(options?.recoilKick01 ?? 0, 0, 1);
  const engage = THREE.MathUtils.clamp(
    options?.combatEngage01 ?? (style === 'heli_door_gunner' ? 0.5 : 0),
    0,
    1,
  );

  // Lower pelvis directly onto seat cushion (keeps helmet ~13cm below helicopter/APC roof!)
  const leanForward =
    style === 'heli_door_gunner'
      ? THREE.MathUtils.lerp(0.05, 0.22, engage)
      : style === 'heli_crew'
        ? THREE.MathUtils.lerp(0.04, 0.14, engage)
        : 0.05;
  // Jump-seat squadmate twists torso smoothly toward the open port doorway when engaging warzone targets
  const torsoCombatYaw = style === 'heli_crew' ? THREE.MathUtils.lerp(0, -0.46, engage) : 0;

  skeleton.pelvis.position.set(0, seatH + vib, 0);
  skeleton.pelvis.rotation.set(-0.06, 0, 0);
  skeleton.spineLower.rotation.set(0.06 + leanForward * 0.45 + breath * 0.008, torsoCombatYaw * 0.35, 0);
  skeleton.spineUpper.rotation.set(
    leanForward + breath * 0.01 - recoil * 0.045,
    torsoCombatYaw * 0.65,
    0,
  );
  skeleton.chest.rotation.set(0.03 + breath * 0.01 - recoil * 0.035, 0, 0);

  const headYaw = options?.headYawRad ?? Math.sin(timeSec * 0.65) * 0.14;
  const headPitch =
    options?.headPitchRad ??
    (style === 'heli_door_gunner' ? THREE.MathUtils.lerp(-0.05, -0.2, engage) : -0.04);
  skeleton.neck.rotation.set(headPitch * 0.4, headYaw * 0.4, 0);
  skeleton.headGroup.rotation.set(headPitch * 0.6, headYaw * 0.6, 0);

  // Solve both seated legs: thighs forward (-Z), shins vertical, boots planted on deck (y = ankleHeight)
  const ankleY = p.ankleHeight;
  const footForwardZ =
    style === 'heli_pilot'
      ? -0.46
      : style === 'heli_door_gunner'
        ? THREE.MathUtils.lerp(-0.38, -0.46, engage)
        : -0.38;
  const stanceX =
    style === 'heli_door_gunner'
      ? THREE.MathUtils.lerp(0.15, 0.21, engage)
      : style === 'heli_crew'
        ? THREE.MathUtils.lerp(0.14, 0.17, engage)
        : 0.125;

  _ankleRootL.set(-stanceX, ankleY, footForwardZ);
  _ankleRootR.set(stanceX, ankleY, footForwardZ);
  // Strong forward knee poles (-Z) guarantee knees bend naturally forward over seat edge
  _kneePoleL.set(-stanceX - 0.04, seatH + 0.06, -0.78);
  _kneePoleR.set(stanceX + 0.04, seatH + 0.06, -0.78);

  solveLegTwoBoneIK(skeleton, -1, _ankleRootL, _kneePoleL, 0.14, 0);
  solveLegTwoBoneIK(skeleton, 1, _ankleRootR, _kneePoleR, 0.14, 0);

  // Solve seated arms cleanly via 2-bone IK
  if (style === 'heli_pilot') {
    const stickX = Math.sin(timeSec * 1.4) * 0.022;
    const stickZ = Math.cos(timeSec * 1.1) * 0.018;
    // Right hand on center cyclic control stick; left hand on side collective lever
    _targetRootR.set(0.05 + stickX, seatH + 0.24, -0.34 + stickZ);
    _poleRootR.set(0.32, seatH + 0.18, 0.12);
    _targetRootL.set(-0.22, seatH + 0.18 + breath * 0.012, -0.22);
    _poleRootL.set(-0.34, seatH + 0.18, 0.16);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.1, 0.2, -0.2);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.1, 0.25, 0.25);
    skeleton.applyHandPose('right', 'rifle', false, 0.85);
    skeleton.applyHandPose('left', 'rifle', false, 0.85);
  } else if (style === 'heli_door_gunner') {
    // Smooth Idle (relaxed scan grip) -> Active Firing (braced forward behind pintle sights + recoil)
    const sweep = Math.sin(timeSec * 0.95) * THREE.MathUtils.lerp(0.025, 0.055, engage);
    const reachZ = THREE.MathUtils.lerp(-0.35, -0.47, engage) + recoil * 0.03;
    const gripY = seatH + THREE.MathUtils.lerp(0.27, 0.36, engage) + recoil * 0.016;
    const spreadX = THREE.MathUtils.lerp(0.14, 0.11, engage);
    _targetRootL.set(-spreadX + sweep, gripY, reachZ);
    _poleRootL.set(-0.38, seatH + THREE.MathUtils.lerp(0.16, 0.22, engage), 0.04);
    _targetRootR.set(spreadX + sweep, gripY, reachZ);
    _poleRootR.set(0.38, seatH + THREE.MathUtils.lerp(0.16, 0.22, engage), 0.04);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.12, 0.18, 0.25);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.12, 0.18, -0.25);
    skeleton.applyHandPose('left', 'rifle', false, THREE.MathUtils.lerp(0.75, 0.95, engage));
    skeleton.applyHandPose('right', 'rifle', false, THREE.MathUtils.lerp(0.75, 0.95, engage));
  } else if (style === 'apc_driver') {
    const steer = Math.sin(timeSec * 1.2) * 0.03;
    // Both hands gripping armored transport steering wheel at 10-and-2
    _targetRootL.set(-0.16, seatH + 0.36 + steer, -0.36);
    _poleRootL.set(-0.34, seatH + 0.18, 0.08);
    _targetRootR.set(0.16, seatH + 0.36 - steer, -0.36);
    _poleRootR.set(0.34, seatH + 0.18, 0.08);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.15, 0.2, 0.3);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.15, 0.2, -0.3);
    skeleton.applyHandPose('left', 'rifle', false, 0.88);
    skeleton.applyHandPose('right', 'rifle', false, 0.88);
  } else {
    // Helicopter Jump-Seat Squadmate:
    // Idle (engage=0): cradling M4A1 diagonally across chest/lap
    // Combat (engage=1): raising & shouldering M4A1 cleanly toward open doorway with live recoil!
    if (options?.weaponMount) {
      options.weaponMount.position.set(
        THREE.MathUtils.lerp(0.04, 0.13, engage),
        THREE.MathUtils.lerp(-0.20, 0.01, engage),
        THREE.MathUtils.lerp(-0.26, -0.28, engage) + recoil * 0.032,
      );
      options.weaponMount.rotation.set(
        THREE.MathUtils.lerp(-0.24, -0.06, engage) + recoil * 0.12,
        THREE.MathUtils.lerp(0.62, 0.06, engage),
        THREE.MathUtils.lerp(-0.12, -0.03, engage),
      );
    }
    _targetRootR.set(
      THREE.MathUtils.lerp(0.14, 0.16, engage),
      seatH + THREE.MathUtils.lerp(0.24, 0.40, engage) + breath * 0.008 + recoil * 0.016,
      THREE.MathUtils.lerp(-0.24, -0.27, engage) + recoil * 0.025,
    );
    _poleRootR.set(0.34, seatH + THREE.MathUtils.lerp(0.18, 0.24, engage), 0.12);
    _targetRootL.set(
      THREE.MathUtils.lerp(-0.12, 0.01, engage),
      seatH + THREE.MathUtils.lerp(0.21, 0.41, engage) + breath * 0.008 + recoil * 0.018,
      THREE.MathUtils.lerp(-0.34, -0.48, engage) + recoil * 0.025,
    );
    _poleRootL.set(-0.34, seatH + THREE.MathUtils.lerp(0.16, 0.22, engage), 0.04);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.12, 0.15, -0.2);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.12, 0.2, 0.3);
    skeleton.applyHandPose('right', 'rifle', false, THREE.MathUtils.lerp(0.82, 0.94, engage));
    skeleton.applyHandPose('left', 'rifle', false, THREE.MathUtils.lerp(0.78, 0.9, engage));
  }

  skeleton.root.updateMatrixWorld(true);
}

/**
 * Drives an operator walking naturally via two-bone IK leg strides + counter-swinging arms
 * (or shouldered combat rifle aim when `aimBlend01 > 0`, used for the Gun-Cam Breach Squadmate!).
 */
export function poseWalkingOperator(
  skeleton: CharacterSkeleton,
  stridePhaseRad: number,
  speed01: number,
  options?: {
    aimBlend01?: number;
    recoilKick01?: number;
    headYawRad?: number;
    weaponMount?: THREE.Object3D | null;
  },
): void {
  saveRootTransform(skeleton.root);
  skeleton.applyCanonicalRestPose();
  restoreRootTransform(skeleton.root);
  const p = skeleton.profile;
  const spd = THREE.MathUtils.clamp(speed01, 0, 1);
  const aim = THREE.MathUtils.clamp(options?.aimBlend01 ?? 0, 0, 1);
  const recoil = THREE.MathUtils.clamp(options?.recoilKick01 ?? 0, 0, 1);

  const sinL = Math.sin(stridePhaseRad);
  const sinR = -sinL;
  const liftL = Math.max(0, Math.cos(stridePhaseRad)) * 0.085 * spd;
  const liftR = Math.max(0, -Math.cos(stridePhaseRad)) * 0.085 * spd;
  const strideLen = 0.28 * spd;
  const bob = Math.abs(Math.sin(stridePhaseRad)) * 0.028 * spd;

  const baseHipY = p.thighLen + p.shinLen + p.ankleHeight - 0.035;
  skeleton.pelvis.position.set(0, baseHipY - 0.04 * aim + bob, 0);
  skeleton.pelvis.rotation.set(0.05 + 0.06 * aim, sinL * 0.06 * spd, 0);
  skeleton.spineUpper.rotation.set(0.04 * aim, -sinL * 0.05 * spd, 0);
  skeleton.headGroup.rotation.set(-0.03 * aim, options?.headYawRad ?? 0, 0);

  // Two-bone IK walking stride legs
  const ankleY = p.ankleHeight;
  _ankleRootL.set(-0.12, ankleY + liftL, -sinL * strideLen);
  _ankleRootR.set(0.12, ankleY + liftR, -sinR * strideLen);
  _kneePoleL.set(-0.14, ankleY + 0.40, -0.72);
  _kneePoleR.set(0.14, ankleY + 0.40, -0.72);

  solveLegTwoBoneIK(skeleton, -1, _ankleRootL, _kneePoleL, 0.08, liftL * 1.4);
  solveLegTwoBoneIK(skeleton, 1, _ankleRootR, _kneePoleR, 0.08, liftR * 1.4);

  if (aim > 0.05 || options?.weaponMount) {
    const targets = computeLowReadyRifleTargets(aim, sinL * 0.04 * spd);
    if (options?.weaponMount) {
      options.weaponMount.position.set(
        targets.weaponChestLocalPos[0],
        targets.weaponChestLocalPos[1],
        targets.weaponChestLocalPos[2] + recoil * 0.035,
      );
      options.weaponMount.rotation.set(
        targets.weaponChestLocalEuler[0] + recoil * 0.14,
        targets.weaponChestLocalEuler[1],
        targets.weaponChestLocalEuler[2],
      );
    }
    _targetRootR.set(
      targets.rightHandRoot[0],
      targets.rightHandRoot[1] + recoil * 0.02,
      targets.rightHandRoot[2] + recoil * 0.03,
    );
    _poleRootR.set(...targets.rightElbowPoleRoot);
    _targetRootL.set(
      targets.leftHandRoot[0],
      targets.leftHandRoot[1] + recoil * 0.025,
      targets.leftHandRoot[2] + recoil * 0.03,
    );
    _poleRootL.set(...targets.leftElbowPoleRoot);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.1, 0.1, -0.2);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.1, 0.15, 0.3);
    skeleton.applyHandPose('right', 'rifle', false, 0.9);
    skeleton.applyHandPose('left', 'rifle', false, 0.85);
  } else {
    // Natural opposite arm swing hanging downward along waist
    _targetRootL.set(-0.24, 0.90 + Math.max(0, sinR) * 0.05 * spd, -sinR * 0.18 * spd);
    _poleRootL.set(-0.34, 1.06, 0.22);
    _targetRootR.set(0.24, 0.90 + Math.max(0, sinL) * 0.05 * spd, -sinL * 0.18 * spd);
    _poleRootR.set(0.34, 1.06, 0.22);
    solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, 0, 0.1, 0.4);
    solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0, 0.1, -0.4);
    skeleton.applyHandPose('left', 'unarmed', false, 0.38);
    skeleton.applyHandPose('right', 'unarmed', false, 0.38);
  }

  skeleton.root.updateMatrixWorld(true);
}

/**
 * Poses a hostile corridor combatant aiming downrange and smoothly collapsing backward
 * when neutralized (`downBlend01: 0 -> 1`).
 */
export function poseHostileCombatant(
  skeleton: CharacterSkeleton,
  timeSec: number,
  downBlend01: number,
  weaponMount?: THREE.Object3D | null,
): void {
  const down = THREE.MathUtils.clamp(downBlend01, 0, 1);
  if (down < 0.01) {
    poseWalkingOperator(skeleton, timeSec * 4.2, 0.22, {
      aimBlend01: 0.92,
      weaponMount,
    });
    skeleton.root.rotation.x = 0;
    return;
  }

  // Smooth collapse backward while keeping arms naturally folded across torso (never inverted upward!)
  saveRootTransform(skeleton.root);
  skeleton.applyPreviewReadyPose(timeSec);
  restoreRootTransform(skeleton.root);
  const targets = computeLowReadyRifleTargets(1 - down, 0);
  if (weaponMount) {
    weaponMount.position.set(...targets.weaponChestLocalPos);
    weaponMount.rotation.set(
      targets.weaponChestLocalEuler[0] - down * 0.45,
      targets.weaponChestLocalEuler[1],
      targets.weaponChestLocalEuler[2] + down * 0.3,
    );
  }
  _targetRootR.set(
    THREE.MathUtils.lerp(0.15, 0.28, down),
    THREE.MathUtils.lerp(1.28, 0.95, down),
    THREE.MathUtils.lerp(-0.24, -0.10, down),
  );
  _poleRootR.set(0.36, 1.02, 0.16);
  _targetRootL.set(
    THREE.MathUtils.lerp(-0.04, -0.26, down),
    THREE.MathUtils.lerp(1.28, 0.92, down),
    THREE.MathUtils.lerp(-0.42, -0.12, down),
  );
  _poleRootL.set(-0.36, 1.02, 0.16);
  solveArmTwoBoneIK(skeleton, 1, _targetRootR, _poleRootR, 0.1, 0.15, -0.2);
  solveArmTwoBoneIK(skeleton, -1, _targetRootL, _poleRootL, -0.1, 0.15, 0.2);
  skeleton.root.rotation.x = -down * (Math.PI * 0.47);
  skeleton.root.updateMatrixWorld(true);
}

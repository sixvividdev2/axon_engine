import * as THREE from 'three';

export interface TwoBoneIKResult {
  midPos: THREE.Vector3;
  endPos: THREE.Vector3;
  dir1: THREE.Vector3;
  dir2: THREE.Vector3;
  reachedMax: boolean;
}

export function createTwoBoneIKResult(): TwoBoneIKResult {
  return {
    midPos: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    dir1: new THREE.Vector3(0, -1, 0),
    dir2: new THREE.Vector3(0, -1, 0),
    reachedMax: false,
  };
}

// Pre-allocated module-level scratch math objects (zero GC per frame)
const _toTarget = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _poleVec = new THREE.Vector3();
const _orthoPole = new THREE.Vector3();
const _fallbackAxis = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _rotMat = new THREE.Matrix4();
const _rollQuat = new THREE.Quaternion();

const _sharedResult: TwoBoneIKResult = createTwoBoneIKResult();

/**
 * Zero-allocation 2-bone analytic IK solver in any common coordinate frame.
 * Computes mid-joint (elbow/knee) and clamped end-effector (wrist/ankle)
 * using the law of cosines and a pole position so joints never gimbal-flip.
 */
export function solveTwoBoneIK(
  rootPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  polePos: THREE.Vector3,
  len1: number,
  len2: number,
  out: TwoBoneIKResult = _sharedResult,
): TwoBoneIKResult {
  _toTarget.subVectors(targetPos, rootPos);
  const rawDist = _toTarget.length();

  const minReach = Math.max(0.02, Math.abs(len1 - len2) + 0.008);
  const maxReach = (len1 + len2) * 0.994;
  const dist = THREE.MathUtils.clamp(rawDist, minReach, maxReach);
  out.reachedMax = rawDist >= maxReach;

  if (rawDist > 1e-5) {
    _axis.copy(_toTarget).divideScalar(rawDist);
  } else {
    _axis.set(0, -1, 0);
  }

  // Law of cosines for triangle (len1, len2, dist)
  const cosAlpha = THREE.MathUtils.clamp(
    (len1 * len1 + dist * dist - len2 * len2) / (2 * len1 * dist),
    -1,
    1,
  );
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));

  // Orthogonalize pole direction relative to root->target axis
  _poleVec.subVectors(polePos, rootPos);
  _orthoPole.copy(_poleVec).addScaledVector(_axis, -_poleVec.dot(_axis));

  if (_orthoPole.lengthSq() < 1e-6) {
    // Deterministic perpendicular fallback when pole aligns with target ray
    _fallbackAxis.set(Math.abs(_axis.y) < 0.9 ? 0 : 1, Math.abs(_axis.y) < 0.9 ? 1 : 0, 0);
    _orthoPole.crossVectors(_axis, _fallbackAxis);
  }
  _orthoPole.normalize();

  out.midPos
    .copy(rootPos)
    .addScaledVector(_axis, len1 * cosAlpha)
    .addScaledVector(_orthoPole, len1 * sinAlpha);

  out.endPos.copy(rootPos).addScaledVector(_axis, dist);

  out.dir1.subVectors(out.midPos, rootPos);
  const l1 = out.dir1.length();
  if (l1 > 1e-5) out.dir1.divideScalar(l1);
  else out.dir1.set(0, -1, 0);

  out.dir2.subVectors(out.endPos, out.midPos);
  const l2 = out.dir2.length();
  if (l2 > 1e-5) out.dir2.divideScalar(l2);
  else out.dir2.copy(out.dir1);

  return out;
}

/**
 * Orients a limb Object3D whose geometry extends along local +Y (0 -> length)
 * from `startPos` toward `endPos` using `polePos` as the bend-plane hint,
 * avoiding Euler/lookAt gimbal singularities.
 */
export function orientLimbAlongY(
  obj: THREE.Object3D,
  startPos: THREE.Vector3,
  endPos: THREE.Vector3,
  polePos: THREE.Vector3,
  twistRollRad = 0,
): void {
  obj.position.copy(startPos);

  _yAxis.subVectors(endPos, startPos);
  const len = _yAxis.length();
  if (len < 1e-5) return;
  _yAxis.divideScalar(len);

  // Use pole vector to construct stable orthogonal forward/lateral basis
  _segDir.subVectors(polePos, startPos);
  _zAxis.copy(_segDir).addScaledVector(_yAxis, -_segDir.dot(_yAxis));
  if (_zAxis.lengthSq() < 1e-6) {
    _fallbackAxis.set(0, 0, Math.abs(_yAxis.z) < 0.9 ? 1 : 0);
    if (_fallbackAxis.lengthSq() < 0.5) _fallbackAxis.set(1, 0, 0);
    _zAxis.crossVectors(_yAxis, _fallbackAxis);
  }
  _zAxis.normalize();

  _xAxis.crossVectors(_yAxis, _zAxis).normalize();
  _zAxis.crossVectors(_xAxis, _yAxis).normalize();

  _rotMat.makeBasis(_xAxis, _yAxis, _zAxis);
  obj.quaternion.setFromRotationMatrix(_rotMat);

  if (Math.abs(twistRollRad) > 1e-4) {
    _rollQuat.setFromAxisAngle(_yAxis, twistRollRad);
    obj.quaternion.premultiply(_rollQuat);
  }
}

const _dorsalProj = new THREE.Vector3();

/**
 * Computes signed twist roll (radians) around the limb's longitudinal +Y bone axis
 * from the base `orientLimbAlongY` +Z axis toward `targetDorsalDir` (e.g., hand +Y).
 */
export function computeTwistRollAroundY(
  startPos: THREE.Vector3,
  endPos: THREE.Vector3,
  polePos: THREE.Vector3,
  targetDorsalDir: THREE.Vector3,
): number {
  _yAxis.subVectors(endPos, startPos);
  const len = _yAxis.length();
  if (len < 1e-5) return 0;
  _yAxis.divideScalar(len);

  _segDir.subVectors(polePos, startPos);
  _zAxis.copy(_segDir).addScaledVector(_yAxis, -_segDir.dot(_yAxis));
  if (_zAxis.lengthSq() < 1e-6) {
    _fallbackAxis.set(0, 0, Math.abs(_yAxis.z) < 0.9 ? 1 : 0);
    if (_fallbackAxis.lengthSq() < 0.5) _fallbackAxis.set(1, 0, 0);
    _zAxis.crossVectors(_yAxis, _fallbackAxis);
  }
  _zAxis.normalize();
  _xAxis.crossVectors(_yAxis, _zAxis).normalize();
  _zAxis.crossVectors(_xAxis, _yAxis).normalize();

  _dorsalProj.copy(targetDorsalDir).addScaledVector(_yAxis, -targetDorsalDir.dot(_yAxis));
  if (_dorsalProj.lengthSq() < 1e-6) return 0;
  _dorsalProj.normalize();

  const cosA = THREE.MathUtils.clamp(_zAxis.dot(_dorsalProj), -1, 1);
  const sinA = _xAxis.dot(_dorsalProj);
  return Math.atan2(sinA, cosA);
}

/**
 * Smooth exponential IK target blender for weapon, stance, and action transitions.
 */
export class IKTargetBlender {
  public readonly position = new THREE.Vector3();
  public readonly quaternion = new THREE.Quaternion();
  public gripCurl = 0.85;
  public weight = 1;
  private initialized = false;

  public snap(pos: THREE.Vector3, quat: THREE.Quaternion, gripCurl = 0.85, weight = 1): void {
    this.position.copy(pos);
    this.quaternion.copy(quat);
    this.gripCurl = gripCurl;
    this.weight = weight;
    this.initialized = true;
  }

  public blendTo(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    targetGripCurl: number,
    targetWeight: number,
    lambda: number,
    dt: number,
  ): void {
    if (!this.initialized) {
      this.snap(targetPos, targetQuat, targetGripCurl, targetWeight);
      return;
    }
    const alpha = 1 - Math.exp(-lambda * Math.max(0, dt));
    this.position.lerp(targetPos, alpha);
    this.quaternion.slerp(targetQuat, alpha);
    this.gripCurl = THREE.MathUtils.lerp(this.gripCurl, targetGripCurl, alpha);
    this.weight = THREE.MathUtils.lerp(this.weight, targetWeight, alpha);
  }
}

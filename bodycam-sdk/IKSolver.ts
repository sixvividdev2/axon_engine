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
 * from `startPos` toward `endPos` using `polePos` as the bend-plane hint.
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

const _rootPosWorld = new THREE.Vector3();
const _rootQuatWorld = new THREE.Quaternion();
const _parentInvMat = new THREE.Matrix4();
const _parentQuatWorld = new THREE.Quaternion();
const _parentQuatInv = new THREE.Quaternion();
const _desiredQuatWorld = new THREE.Quaternion();
const _limbQuatRoot = new THREE.Quaternion();

/**
 * Sets `obj`'s local position and quaternion so that its transform relative to `root`
 * matches `(posRoot, quatRoot)`, whether `obj` is a direct child of `root` or deeply nested
 * inside a canonical bone hierarchy. Zero heap allocations per call.
 */
export function setTransformInRootSpace(
  obj: THREE.Object3D,
  root: THREE.Object3D,
  posRoot: THREE.Vector3,
  quatRoot: THREE.Quaternion,
): void {
  const parent = obj.parent;
  if (!parent || parent === root) {
    obj.position.copy(posRoot);
    obj.quaternion.copy(quatRoot);
    return;
  }

  _rootPosWorld.copy(posRoot).applyMatrix4(root.matrixWorld);
  root.getWorldQuaternion(_rootQuatWorld);
  _desiredQuatWorld.copy(_rootQuatWorld).multiply(quatRoot);

  _parentInvMat.copy(parent.matrixWorld).invert();
  obj.position.copy(_rootPosWorld).applyMatrix4(_parentInvMat);

  parent.getWorldQuaternion(_parentQuatWorld);
  _parentQuatInv.copy(_parentQuatWorld).invert();
  obj.quaternion.copy(_parentQuatInv).multiply(_desiredQuatWorld);
}

/**
 * Orients a nested or root-level limb bone whose geometry extends along local +Y (0 -> length)
 * from `startRoot` toward `endRoot` in `root` local space, then updates `obj.matrixWorld`
 * so downstream child bones in the skeletal chain immediately see the updated parent matrix.
 */
export function orientLimbAlongYInRootSpace(
  obj: THREE.Object3D,
  root: THREE.Object3D,
  startRoot: THREE.Vector3,
  endRoot: THREE.Vector3,
  poleRoot: THREE.Vector3,
  twistRollRad = 0,
): void {
  _yAxis.subVectors(endRoot, startRoot);
  const len = _yAxis.length();
  if (len < 1e-5) {
    _limbQuatRoot.identity();
  } else {
    _yAxis.divideScalar(len);
    _segDir.subVectors(poleRoot, startRoot);
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
    _limbQuatRoot.setFromRotationMatrix(_rotMat);

    if (Math.abs(twistRollRad) > 1e-4) {
      _rollQuat.setFromAxisAngle(_yAxis, twistRollRad);
      _limbQuatRoot.premultiply(_rollQuat);
    }
  }

  setTransformInRootSpace(obj, root, startRoot, _limbQuatRoot);
  obj.updateMatrixWorld(false);
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

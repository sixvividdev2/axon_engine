import * as THREE from 'three';
import { ExternalHandIkOverride } from '../bodycam-sdk/CharacterAnimator';
import { SyncedHandlingAction } from '../data/multiplayer';

export type PlayerInteractAnimKind =
  | 'NONE'
  | 'DOOR_OPEN'
  | 'DOOR_PEEK'
  | 'DOOR_CLOSE_PUSH'
  | 'DOOR_CLOSE_SOFT'
  | 'PROP_INTERACT';

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * First-person Left-Hand Interaction Animator (Zero-GC):
 * Drives the operator's left arm cleanly off the weapon forend to:
 *  - Grasp & turn world-space doorknobs (Open, Peek, Close Soft)
 *  - Extend open-palm left hand to push doors shut briskly (Close)
 *  - Reach & actuate Hideout / map props (Lockers, Ammo Crates, Prep Table, Switches)
 * Also exports synchronized 3P SyncedHandlingAction + progress for multiplayer/AI parity.
 */
export class PlayerInteractAnimator {
  private kind: PlayerInteractAnimKind = 'NONE';
  private elapsed = 0;
  private duration = 0.5;
  private targetPosProvider: ((out: THREE.Vector3) => boolean) | null = null;
  private readonly staticTargetPos = new THREE.Vector3();
  private readonly liveTargetPos = new THREE.Vector3();

  private readonly _camPos = new THREE.Vector3();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _toTarget = new THREE.Vector3();
  private readonly _clampedTarget = new THREE.Vector3();
  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _twistQuat = new THREE.Quaternion();

  public readonly ikOverride: ExternalHandIkOverride = {
    active: false,
    rightWeight: 0,
    rightWorldPos: new THREE.Vector3(),
    rightWorldQuat: new THREE.Quaternion(),
    rightGripCurl: 0.92,
    leftWeight: 0,
    leftWorldPos: new THREE.Vector3(),
    leftWorldQuat: new THREE.Quaternion(),
    leftGripCurl: 0.85,
    suppressWeaponHardLock: false,
  };

  public isActive(): boolean {
    return this.kind !== 'NONE';
  }

  public getSyncedHandlingAction(): { action: SyncedHandlingAction; progress: number } {
    if (this.kind === 'NONE') {
      return { action: 'NONE', progress: 0 };
    }
    return {
      action: this.kind,
      progress: THREE.MathUtils.clamp(this.elapsed / Math.max(0.05, this.duration), 0, 1),
    };
  }

  public trigger(
    kind: Exclude<PlayerInteractAnimKind, 'NONE'>,
    initialTargetPos: Readonly<THREE.Vector3>,
    dynamicPosProvider?: (out: THREE.Vector3) => boolean,
  ): void {
    this.kind = kind;
    this.elapsed = 0;
    this.duration =
      kind === 'DOOR_CLOSE_SOFT'
        ? 0.78
        : kind === 'DOOR_PEEK'
          ? 0.56
          : kind === 'DOOR_OPEN'
            ? 0.52
            : kind === 'DOOR_CLOSE_PUSH'
              ? 0.38
              : 0.42;
    this.staticTargetPos.copy(initialTargetPos);
    this.liveTargetPos.copy(initialTargetPos);
    this.targetPosProvider = dynamicPosProvider ?? null;
    this.ikOverride.active = true;
    this.ikOverride.rightWeight = 0; // Right hand retains solid weapon control
    this.ikOverride.suppressWeaponHardLock = false;
  }

  public cancel(): void {
    this.kind = 'NONE';
    this.targetPosProvider = null;
    this.ikOverride.active = false;
    this.ikOverride.leftWeight = 0;
  }

  public update(dt: number, camera: THREE.Camera): boolean {
    if (this.kind === 'NONE') {
      this.ikOverride.active = false;
      this.ikOverride.leftWeight = 0;
      return false;
    }

    this.elapsed += Math.min(dt, 0.05);
    if (this.elapsed >= this.duration) {
      this.cancel();
      return false;
    }

    const p = this.elapsed / this.duration;

    // Sample live doorknob/door-face world coordinate if still attached
    if (this.targetPosProvider && this.targetPosProvider(this._clampedTarget)) {
      this.liveTargetPos.copy(this._clampedTarget);
    } else {
      this.liveTargetPos.copy(this.staticTargetPos);
    }

    camera.getWorldPosition(this._camPos);
    camera.getWorldDirection(this._camFwd).normalize();
    this._camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    this._camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    // Clamp reach distance to natural operator arm span (<= 0.78m from left shoulder/camera)
    this._toTarget.copy(this.liveTargetPos).sub(this._camPos);
    const dist = this._toTarget.length();
    if (dist > 0.78) {
      this._toTarget.multiplyScalar(0.78 / dist);
    } else if (dist < 0.24 && dist > 1e-4) {
      this._toTarget.multiplyScalar(0.24 / dist);
    }
    this._clampedTarget.copy(this._camPos).add(this._toTarget);

    // Smooth reach-in -> hold/twist/push -> return-to-forend envelope
    const reachIn = smoothstep(0.0, 0.28, p);
    const returnOut = 1 - smoothstep(0.72, 1.0, p);
    const w = reachIn * returnOut;

    let wristTwistRoll = 0;
    let gripCurl = 0.88;

    if (this.kind === 'DOOR_OPEN' || this.kind === 'DOOR_PEEK' || this.kind === 'DOOR_CLOSE_SOFT') {
      // Doorknob grasp + wrist turn torque while unlatching/guiding
      const twistPhase = smoothstep(0.24, 0.46, p) * (1 - smoothstep(0.55, 0.76, p));
      wristTwistRoll = twistPhase * (this.kind === 'DOOR_CLOSE_SOFT' ? 0.58 : 0.72);
      gripCurl = THREE.MathUtils.lerp(0.35, 0.94, smoothstep(0.18, 0.34, p)) * (1 - smoothstep(0.72, 0.9, p) * 0.55);
    } else if (this.kind === 'DOOR_CLOSE_PUSH') {
      // Crisp open-palm push forward
      const pushThrust = Math.sin(smoothstep(0.15, 0.75, p) * Math.PI);
      this._clampedTarget.addScaledVector(this._camFwd, pushThrust * 0.14);
      gripCurl = 0.16; // Open pushing palm
      wristTwistRoll = -0.25;
    } else {
      // Prop reach (Locker handle, Ammo Crate lid, Prep Table)
      gripCurl = THREE.MathUtils.lerp(0.32, 0.85, smoothstep(0.15, 0.45, p));
    }

    this.ikOverride.active = w > 0.005;
    this.ikOverride.rightWeight = 0;
    this.ikOverride.leftWeight = w;
    this.ikOverride.leftWorldPos.copy(this._clampedTarget);

    // Orient palm naturally toward target + apply doorknob wrist rotation
    this._euler.set(-0.22, 0.18, 0.35 + wristTwistRoll, 'YXZ');
    this._twistQuat.setFromEuler(this._euler);
    this.ikOverride.leftWorldQuat.copy(camera.quaternion).multiply(this._twistQuat);
    this.ikOverride.leftGripCurl = gripCurl;
    return true;
  }
}

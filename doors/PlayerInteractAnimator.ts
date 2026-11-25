import * as THREE from 'three';
import { ExternalHandIkOverride } from '../bodycam-sdk/CharacterAnimator';
import { SyncedHandlingAction } from '../data/multiplayer';
export type { ExternalHandIkOverride };

export type PlayerInteractAnimKind =
  | 'NONE'
  | 'DOOR_OPEN'
  | 'DOOR_PEEK'
  | 'DOOR_CLOSE_PUSH'
  | 'DOOR_CLOSE_SOFT'
  | 'PROP_INTERACT'
  | 'ELECTRONICS_REPAIR'
  | 'DOOR_REPAIR';

export type HoldRepairAnimKind = 'ELECTRONICS_REPAIR' | 'DOOR_REPAIR';

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * First-person Hand Interaction & Two-Handed Repair Animator (Zero-GC):
 * Drives the operator's hands cleanly off the weapon to:
 *  - Grasp & turn world-space doorknobs (Open, Peek, Close Soft)
 *  - Extend open-palm left hand to push doors shut briskly (Close)
 *  - Reach & actuate Hideout / map props (Lockers, Ammo Crates, Prep Table, Switches)
 *  - Perform realistic two-handed Hold [F] repairs on broken electronics (panel bracing + wiring/connector seating + switch flick)
 *  - Perform realistic two-handed Hold [F] repairs on damaged/breached doors (slab/jamb bracing + 3 rhythmic hinge seating strikes + latch alignment)
 * Also exports synchronized 3P SyncedHandlingAction + progress for multiplayer/AI parity.
 */
export class PlayerInteractAnimator {
  private kind: PlayerInteractAnimKind = 'NONE';
  private elapsed = 0;
  private duration = 0.5;
  private holdMode = false;
  private holdProgress = 0;
  private holdBlend = 0;
  private targetPosProvider: ((out: THREE.Vector3) => boolean) | null = null;
  private readonly staticTargetPos = new THREE.Vector3();
  private readonly liveTargetPos = new THREE.Vector3();

  private readonly _camPos = new THREE.Vector3();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _toTarget = new THREE.Vector3();
  private readonly _clampedTarget = new THREE.Vector3();
  private readonly _leftPos = new THREE.Vector3();
  private readonly _rightPos = new THREE.Vector3();
  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _eulerR = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _twistQuat = new THREE.Quaternion();
  private readonly _twistQuatR = new THREE.Quaternion();

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

  public isHoldRepairActive(): boolean {
    return this.holdMode && (this.kind === 'ELECTRONICS_REPAIR' || this.kind === 'DOOR_REPAIR');
  }

  public getActiveKind(): PlayerInteractAnimKind {
    return this.kind;
  }

  public getSyncedHandlingAction(): { action: SyncedHandlingAction; progress: number } {
    if (this.kind === 'NONE') {
      return { action: 'NONE', progress: 0 };
    }
    return {
      action: this.kind,
      progress: this.holdMode
        ? THREE.MathUtils.clamp(this.holdProgress, 0, 1)
        : THREE.MathUtils.clamp(this.elapsed / Math.max(0.05, this.duration), 0, 1),
    };
  }

  public trigger(
    kind: Exclude<PlayerInteractAnimKind, 'NONE' | 'ELECTRONICS_REPAIR' | 'DOOR_REPAIR'>,
    initialTargetPos: Readonly<THREE.Vector3>,
    dynamicPosProvider?: (out: THREE.Vector3) => boolean,
  ): void {
    this.holdMode = false;
    this.holdProgress = 0;
    this.holdBlend = 0;
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

  /**
   * Begins a continuous two-handed Hold [F] repair animation (`ELECTRONICS_REPAIR` or `DOOR_REPAIR`).
   */
  public startHoldRepair(
    kind: HoldRepairAnimKind,
    anchorPos: Readonly<THREE.Vector3>,
    durationSec: number,
    dynamicPosProvider?: (out: THREE.Vector3) => boolean,
  ): void {
    this.holdMode = true;
    this.kind = kind;
    this.elapsed = 0;
    this.holdProgress = 0;
    this.holdBlend = 0;
    this.duration = Math.max(1.2, durationSec);
    this.staticTargetPos.copy(anchorPos);
    this.liveTargetPos.copy(anchorPos);
    this.targetPosProvider = dynamicPosProvider ?? null;
    this.ikOverride.active = true;
    this.ikOverride.suppressWeaponHardLock = true;
  }

  /**
   * Steps an active Hold [F] two-handed repair animation synchronized to `[0..1]` repair progress.
   */
  public updateHoldRepair(dt: number, progress01: number, camera: THREE.Camera): boolean {
    if (!this.holdMode || (this.kind !== 'ELECTRONICS_REPAIR' && this.kind !== 'DOOR_REPAIR')) {
      return false;
    }
    const clampedDt = Math.min(dt, 0.05);
    this.elapsed += clampedDt;
    this.holdProgress = THREE.MathUtils.clamp(progress01, 0, 1);
    this.holdBlend = Math.min(1, this.holdBlend + clampedDt * 6.5);

    if (this.targetPosProvider && this.targetPosProvider(this._clampedTarget)) {
      this.liveTargetPos.copy(this._clampedTarget);
    } else {
      this.liveTargetPos.copy(this.staticTargetPos);
    }

    camera.getWorldPosition(this._camPos);
    camera.getWorldDirection(this._camFwd).normalize();
    this._camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    this._camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    // Anchor work point naturally in front of the operator's chest/eyes toward the target
    this._toTarget.copy(this.liveTargetPos).sub(this._camPos);
    const dist = this._toTarget.length();
    if (dist > 0.56) {
      this._toTarget.multiplyScalar(0.56 / dist);
    } else if (dist < 0.34 && dist > 1e-4) {
      this._toTarget.multiplyScalar(0.34 / dist);
    }
    // Keep the work plane comfortably visible in upper-center / mid-lower bodycam framing
    this._clampedTarget
      .copy(this._camPos)
      .addScaledVector(this._camFwd, 0.44)
      .addScaledVector(this._camUp, -0.14);
    this._clampedTarget.lerp(this._toTarget.add(this._camPos), 0.38);

    const p = this.holdProgress;
    const easeOutEnd = 1 - smoothstep(0.94, 1.0, p) * 0.25;
    const w = this.holdBlend * easeOutEnd;

    if (this.kind === 'ELECTRONICS_REPAIR') {
      // REALISTIC TWO-HANDED ELECTRONICS REPAIR:
      // Left hand: braces cracked housing / bezel steady with natural micro-adjustments
      // Right hand: (0.00-0.28) opens/clears conduit -> (0.28-0.78) seats & twists two wire connectors -> (0.78-1.0) crisp power breaker reset flick
      const braceMicro = Math.sin(this.elapsed * 3.1) * 0.006;
      const braceVert = Math.cos(this.elapsed * 2.2) * 0.005;
      this._leftPos
        .copy(this._clampedTarget)
        .addScaledVector(this._camRight, -0.145 + braceMicro)
        .addScaledVector(this._camUp, -0.025 + braceVert)
        .addScaledVector(this._camFwd, 0.02);

      let rxOff = 0.11;
      let ryOff = -0.03;
      let rzOff = 0.0;
      let rRoll = -0.25;
      let rPitch = -0.18;
      let rCurl = 0.78;

      if (p < 0.28) {
        // Phase 1: Reach into cracked housing & clear loose lead
        const t = smoothstep(0.0, 0.28, p);
        rxOff = THREE.MathUtils.lerp(0.18, 0.055, t);
        ryOff = THREE.MathUtils.lerp(-0.12, -0.015, t) + Math.sin(t * Math.PI) * 0.03;
        rzOff = THREE.MathUtils.lerp(-0.04, 0.035, t);
        rRoll = THREE.MathUtils.lerp(-0.15, -0.58, t);
        rCurl = THREE.MathUtils.lerp(0.35, 0.88, t);
      } else if (p < 0.78) {
        // Phase 2: Two deliberate wire-twist & connector re-seating strokes
        const sub = (p - 0.28) / 0.50;
        const cycle = (sub * 2.0) % 1.0;
        const twistWave = Math.sin(cycle * Math.PI * 2.0);
        const pressPulse = Math.sin(cycle * Math.PI);
        const shiftX = sub < 0.5 ? 0.045 : 0.085;
        rxOff = shiftX + Math.sin(cycle * Math.PI) * 0.022;
        ryOff = -0.018 + (sub < 0.5 ? 0.022 : -0.024) + twistWave * 0.014;
        rzOff = 0.028 + pressPulse * 0.032;
        rRoll = -0.32 + twistWave * 0.55;
        rPitch = -0.22 - pressPulse * 0.16;
        rCurl = 0.82 + pressPulse * 0.12;
      } else {
        // Phase 3: Final power relay / breaker switch reset push & crisp release
        const t = smoothstep(0.78, 1.0, p);
        const flick = Math.sin(t * Math.PI);
        rxOff = THREE.MathUtils.lerp(0.085, 0.035, smoothstep(0, 0.55, t));
        ryOff = THREE.MathUtils.lerp(-0.03, 0.045, t);
        rzOff = 0.015 + flick * 0.052;
        rRoll = THREE.MathUtils.lerp(-0.22, 0.12, t);
        rPitch = -0.14 + flick * 0.24;
        rCurl = THREE.MathUtils.lerp(0.76, 0.34, t);
      }

      this._rightPos
        .copy(this._clampedTarget)
        .addScaledVector(this._camRight, rxOff)
        .addScaledVector(this._camUp, ryOff)
        .addScaledVector(this._camFwd, rzOff);

      this.ikOverride.active = w > 0.005;
      this.ikOverride.leftWeight = w;
      this.ikOverride.rightWeight = w;
      this.ikOverride.suppressWeaponHardLock = true;
      this.ikOverride.leftWorldPos.copy(this._leftPos);
      this.ikOverride.rightWorldPos.copy(this._rightPos);

      this._euler.set(-0.24, 0.24, 0.42 + braceMicro * 3.0, 'YXZ');
      this._twistQuat.setFromEuler(this._euler);
      this.ikOverride.leftWorldQuat.copy(camera.quaternion).multiply(this._twistQuat);
      this.ikOverride.leftGripCurl = 0.72;

      this._eulerR.set(rPitch, -0.22, rRoll, 'YXZ');
      this._twistQuatR.setFromEuler(this._eulerR);
      this.ikOverride.rightWorldQuat.copy(camera.quaternion).multiply(this._twistQuatR);
      this.ikOverride.rightGripCurl = rCurl;
      return true;
    }

    // REALISTIC TWO-HANDED DOOR REPAIR:
    // Left hand: hoists & braces the door slab/jamb upright with subtle impact recoil on each strike
    // Right hand: 3 weighted hinge-seating / bracing strikes (wind-up -> sharp strike -> settle) + final latch alignment push
    let strikeImpact = 0;
    let rxOff = 0.14;
    let ryOff = -0.02;
    let rzOff = 0.0;
    let rPitch = -0.15;
    let rRoll = -0.2;
    let rCurl = 0.94;
    let lLift = 0;

    if (p < 0.78) {
      // Three weighted bracing / hinge-hammering strokes
      const strokeFloat = (p / 0.78) * 3.0;
      const strokeIdx = Math.min(2, Math.floor(strokeFloat));
      const st = strokeFloat - strokeIdx;
      const heightBand = strokeIdx === 0 ? 0.07 : strokeIdx === 1 ? -0.01 : -0.08;

      if (st < 0.46) {
        // Deliberate wind-up pull back
        const wu = smoothstep(0.0, 0.46, st);
        rxOff = THREE.MathUtils.lerp(0.09, 0.21, wu);
        ryOff = heightBand + wu * 0.09;
        rzOff = THREE.MathUtils.lerp(0.02, -0.11, wu);
        rPitch = THREE.MathUtils.lerp(-0.18, 0.42, wu);
        rRoll = THREE.MathUtils.lerp(-0.18, -0.52, wu);
      } else if (st < 0.66) {
        // Fast driving strike forward onto hinge pin / brace
        const sw = smoothstep(0.46, 0.66, st);
        rxOff = THREE.MathUtils.lerp(0.21, 0.06, sw);
        ryOff = heightBand + THREE.MathUtils.lerp(0.09, -0.015, sw);
        rzOff = THREE.MathUtils.lerp(-0.11, 0.085, sw);
        rPitch = THREE.MathUtils.lerp(0.42, -0.45, sw);
        rRoll = THREE.MathUtils.lerp(-0.52, -0.12, sw);
        strikeImpact = smoothstep(0.56, 0.66, st);
      } else {
        // Impact settle & rebound
        const rb = smoothstep(0.66, 1.0, st);
        rxOff = THREE.MathUtils.lerp(0.06, 0.11, rb);
        ryOff = heightBand + THREE.MathUtils.lerp(-0.015, 0.015, rb);
        rzOff = THREE.MathUtils.lerp(0.085, 0.015, rb);
        rPitch = THREE.MathUtils.lerp(-0.45, -0.16, rb);
        rRoll = -0.16;
        strikeImpact = 1.0 - rb;
      }
      lLift = heightBand * 0.35;
    } else {
      // Phase 2: Two-handed firm square-up & latch check push
      const t = smoothstep(0.78, 1.0, p);
      const push = Math.sin(t * Math.PI);
      rxOff = THREE.MathUtils.lerp(0.11, 0.14, t);
      ryOff = THREE.MathUtils.lerp(-0.04, 0.01, t);
      rzOff = 0.01 + push * 0.075;
      rPitch = -0.22 - push * 0.15;
      rRoll = -0.35;
      rCurl = 0.24; // Open palm bracing press
      lLift = push * 0.04;
    }

    this._leftPos
      .copy(this._clampedTarget)
      .addScaledVector(this._camRight, -0.175)
      .addScaledVector(this._camUp, -0.01 + lLift - strikeImpact * 0.016)
      .addScaledVector(this._camFwd, 0.03 + strikeImpact * 0.022);

    this._rightPos
      .copy(this._clampedTarget)
      .addScaledVector(this._camRight, rxOff)
      .addScaledVector(this._camUp, ryOff)
      .addScaledVector(this._camFwd, rzOff);

    this.ikOverride.active = w > 0.005;
    this.ikOverride.leftWeight = w;
    this.ikOverride.rightWeight = w;
    this.ikOverride.suppressWeaponHardLock = true;
    this.ikOverride.leftWorldPos.copy(this._leftPos);
    this.ikOverride.rightWorldPos.copy(this._rightPos);

    this._euler.set(-0.28, 0.32, 0.55, 'YXZ');
    this._twistQuat.setFromEuler(this._euler);
    this.ikOverride.leftWorldQuat.copy(camera.quaternion).multiply(this._twistQuat);
    this.ikOverride.leftGripCurl = p < 0.78 ? 0.86 : 0.28;

    this._eulerR.set(rPitch, -0.25, rRoll, 'YXZ');
    this._twistQuatR.setFromEuler(this._eulerR);
    this.ikOverride.rightWorldQuat.copy(camera.quaternion).multiply(this._twistQuatR);
    this.ikOverride.rightGripCurl = rCurl;
    return true;
  }

  public stopHoldRepair(): void {
    if (!this.holdMode) return;
    this.cancel();
  }

  public cancel(): void {
    this.holdMode = false;
    this.holdProgress = 0;
    this.holdBlend = 0;
    this.kind = 'NONE';
    this.targetPosProvider = null;
    this.ikOverride.active = false;
    this.ikOverride.leftWeight = 0;
    this.ikOverride.rightWeight = 0;
    this.ikOverride.suppressWeaponHardLock = false;
  }

  public update(dt: number, camera: THREE.Camera): boolean {
    if (this.holdMode) {
      return this.updateHoldRepair(dt, this.holdProgress, camera);
    }
    if (this.kind === 'NONE') {
      this.ikOverride.active = false;
      this.ikOverride.leftWeight = 0;
      this.ikOverride.rightWeight = 0;
      this.ikOverride.suppressWeaponHardLock = false;
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
    this.ikOverride.suppressWeaponHardLock = false;
    this.ikOverride.leftWorldPos.copy(this._clampedTarget);

    // Orient palm naturally toward target + apply doorknob wrist rotation
    this._euler.set(-0.22, 0.18, 0.35 + wristTwistRoll, 'YXZ');
    this._twistQuat.setFromEuler(this._euler);
    this.ikOverride.leftWorldQuat.copy(camera.quaternion).multiply(this._twistQuat);
    this.ikOverride.leftGripCurl = gripCurl;
    return true;
  }
}

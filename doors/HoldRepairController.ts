import * as THREE from 'three';
import { HoldRepairAnimKind, PlayerInteractAnimator } from './PlayerInteractAnimator';

export interface ActiveHoldRepairState {
  kind: HoldRepairAnimKind;
  targetId: string;
  label: string;
  durationSec: number;
  elapsedSec: number;
  progress01: number;
  anchorPos: THREE.Vector3;
}

export interface StartHoldRepairSpec {
  kind: HoldRepairAnimKind;
  targetId: string;
  label: string;
  durationSec: number;
  anchorPos: Readonly<THREE.Vector3>;
  dynamicAnchorProvider?: (out: THREE.Vector3) => boolean;
  onWorkTick?: (phaseIndex: number, anchorPos: Readonly<THREE.Vector3>) => void;
  onComplete: () => void;
}

/**
 * Reusable Hold [F] repair state machine (1.8–2.5s) shared across Combat, Open World,
 * Hideout, Zombies Outpost, Gym, and Survival. Synchronizes hold progress with
 * two-handed 1P IK animations (`ELECTRONICS_REPAIR` / `DOOR_REPAIR`) and rhythmic audio ticks.
 */
export class HoldRepairController {
  private active: ActiveHoldRepairState | null = null;
  private onWorkTick: ((phaseIndex: number, anchorPos: Readonly<THREE.Vector3>) => void) | null =
    null;
  private onComplete: (() => void) | null = null;
  private lastTickIndex = -1;
  private readonly _anchorScratch = new THREE.Vector3();

  public isActive(): boolean {
    return this.active !== null;
  }

  public getState(): Readonly<ActiveHoldRepairState> | null {
    return this.active;
  }

  public start(
    spec: StartHoldRepairSpec,
    animator?: PlayerInteractAnimator | null,
  ): void {
    const duration = THREE.MathUtils.clamp(spec.durationSec, 1.8, 2.5);
    this._anchorScratch.copy(spec.anchorPos);
    this.active = {
      kind: spec.kind,
      targetId: spec.targetId,
      label: spec.label,
      durationSec: duration,
      elapsedSec: 0,
      progress01: 0,
      anchorPos: this._anchorScratch.clone(),
    };
    this.onWorkTick = spec.onWorkTick ?? null;
    this.onComplete = spec.onComplete;
    this.lastTickIndex = -1;

    if (animator) {
      animator.startHoldRepair(spec.kind, spec.anchorPos, duration, spec.dynamicAnchorProvider);
    }
  }

  public cancel(animator?: PlayerInteractAnimator | null): void {
    if (!this.active) return;
    this.active = null;
    this.onWorkTick = null;
    this.onComplete = null;
    this.lastTickIndex = -1;
    if (animator && animator.isHoldRepairActive()) {
      animator.stopHoldRepair();
    }
  }

  /**
   * Advances an active Hold [F] repair while the key stays held and the player remains in range.
   * Returns `true` if a repair just completed on this frame.
   */
  public step(
    dt: number,
    isKeyHeld: boolean,
    playerPos: Readonly<THREE.Vector3>,
    camera: THREE.Camera,
    animator?: PlayerInteractAnimator | null,
    maxBreakDistM = 3.45,
  ): boolean {
    if (!this.active) return false;

    const dist = playerPos.distanceTo(this.active.anchorPos);
    if (!isKeyHeld || dist > maxBreakDistM) {
      this.cancel(animator);
      return false;
    }

    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    this.active.elapsedSec += clampedDt;
    this.active.progress01 = THREE.MathUtils.clamp(
      this.active.elapsedSec / Math.max(0.1, this.active.durationSec),
      0,
      1,
    );

    if (animator) {
      animator.updateHoldRepair(clampedDt, this.active.progress01, camera);
    }

    // Fire 3 rhythmic audio/spark ticks synced to hand strokes (at ~24%, ~52%, ~78%)
    const tickThresholds =
      this.active.kind === 'DOOR_REPAIR' ? [0.20, 0.46, 0.72] : [0.22, 0.50, 0.78];
    let currentTick = -1;
    for (let i = 0; i < tickThresholds.length; i++) {
      if (this.active.progress01 >= tickThresholds[i]) {
        currentTick = i;
      }
    }
    if (currentTick > this.lastTickIndex) {
      this.lastTickIndex = currentTick;
      if (this.onWorkTick) {
        this.onWorkTick(currentTick, this.active.anchorPos);
      }
    }

    if (this.active.progress01 >= 1) {
      const doneCb = this.onComplete;
      this.cancel(animator);
      if (doneCb) doneCb();
      return true;
    }

    return false;
  }
}

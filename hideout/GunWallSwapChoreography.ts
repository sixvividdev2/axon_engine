import * as THREE from 'three';
import {
  BodycamAudio,
  ExternalHandIkOverride,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import { loadoutStore } from '../data/loadoutStore';

export type GunWallSwapMode = 'NONE' | 'SWAP_ARMED' | 'GRAB_UNARMED' | 'HANG_ONLY';

export interface GunWallSwapStartParams {
  slotIndex: number;
  slotWorldPos: Readonly<THREE.Vector3>;
  slotWorldQuat: Readonly<THREE.Quaternion>;
  outgoingWeaponId: string; // 'unarmed' if unarmed
  incomingWeaponId: string | null; // null if hanging onto empty slot
  startWeaponWorldPos: Readonly<THREE.Vector3>;
  startWeaponWorldQuat: Readonly<THREE.Quaternion>;
  onMountOutgoingToRack: (slotIndex: number, outgoingWeaponId: string) => void;
  onDetachIncomingFromRack: (slotIndex: number) => void;
  onComplete: (slotIndex: number, nextEquippedId: string) => void;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Realistic Two-Handed Gun Wall Grab & Swap Choreographer:
 *
 * Case A — Armed Swap (0.90s):
 *   • Phase 1 (0.00s–0.35s): Right hand carries held firearm to rack brackets and seats it on hooks.
 *   • Phase 2 (0.30s–0.65s): Left hand reaches to target firearm on rack, lifts it off brackets, and draws it across into center workspace.
 *   • Phase 3 (0.65s–0.90s): Two-handed hand-off — right hand acquires primary grip, left hand seats onto handguard/forend into ready stance.
 *
 * Case B — Unarmed Grab (0.58s):
 *   • Reaches out, lifts target firearm off brackets, and transitions cleanly into two-handed ready stance.
 *
 * Case C — Hang Only (0.50s):
 *   • Right hand hangs held firearm onto open rack brackets and transitions cleanly to unarmed.
 */
export class GunWallSwapChoreography {
  private readonly scene: THREE.Scene;
  private readonly audio: BodycamAudio;
  private readonly propRoot = new THREE.Group();

  private mode: GunWallSwapMode = 'NONE';
  private elapsed = 0;
  private duration = 0.9;
  private slotIndex = -1;
  private outgoingWeaponId = 'unarmed';
  private incomingWeaponId: string | null = null;
  private hungOutgoing = false;
  private liftedIncoming = false;
  private playedHandoffCue = false;

  private outgoingAssembly: WeaponModelAssembly | null = null;
  private incomingAssembly: WeaponModelAssembly | null = null;

  private onMountOutgoingCb: ((slotIndex: number, weaponId: string) => void) | null = null;
  private onDetachIncomingCb: ((slotIndex: number) => void) | null = null;
  private onCompleteCb: ((slotIndex: number, nextEquippedId: string) => void) | null = null;

  // World-space anchor keyframes
  private readonly startPos = new THREE.Vector3();
  private readonly startQuat = new THREE.Quaternion();
  private readonly rackPos = new THREE.Vector3();
  private readonly rackQuat = new THREE.Quaternion();
  private readonly rackPullPos = new THREE.Vector3();
  private readonly rackClearOffset = new THREE.Vector3();

  // Pre-allocated zero-GC scratch math
  private readonly _readyPos = new THREE.Vector3();
  private readonly _readyQuat = new THREE.Quaternion();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _workspacePos = new THREE.Vector3();
  private readonly _workspaceQuat = new THREE.Quaternion();
  private readonly _tmpPos = new THREE.Vector3();
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _hangMidPos = new THREE.Vector3();
  private readonly _liftMidPos = new THREE.Vector3();
  private readonly _rackNormal = new THREE.Vector3();
  private readonly _wsTiltEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _wsTiltQuat = new THREE.Quaternion();
  private readonly _sockRPos = new THREE.Vector3();
  private readonly _sockRQuat = new THREE.Quaternion();
  private readonly _sockLPos = new THREE.Vector3();
  private readonly _sockLQuat = new THREE.Quaternion();
  private readonly _prevLeftPos = new THREE.Vector3();
  private readonly _prevLeftQuat = new THREE.Quaternion();
  private readonly _prevRightPos = new THREE.Vector3();
  private readonly _prevRightQuat = new THREE.Quaternion();

  public readonly ikOverride: ExternalHandIkOverride = {
    active: false,
    rightWeight: 0,
    rightWorldPos: new THREE.Vector3(),
    rightWorldQuat: new THREE.Quaternion(),
    rightGripCurl: 0.9,
    leftWeight: 0,
    leftWorldPos: new THREE.Vector3(),
    leftWorldQuat: new THREE.Quaternion(),
    leftGripCurl: 0.9,
    suppressWeaponHardLock: true,
  };

  constructor(scene: THREE.Scene, audio: BodycamAudio) {
    this.scene = scene;
    this.audio = audio;
    this.propRoot.name = 'GunWallSwapProps';
    this.scene.add(this.propRoot);
  }

  public isActive(): boolean {
    return this.mode !== 'NONE';
  }

  public start(params: GunWallSwapStartParams): boolean {
    if (this.mode !== 'NONE') return false;

    const hasOut = params.outgoingWeaponId !== 'unarmed';
    const hasIn = Boolean(params.incomingWeaponId && params.incomingWeaponId !== 'unarmed');
    if (!hasOut && !hasIn) return false;

    this.clearProps();

    this.slotIndex = params.slotIndex;
    this.outgoingWeaponId = params.outgoingWeaponId;
    this.incomingWeaponId = params.incomingWeaponId;
    this.startPos.copy(params.startWeaponWorldPos);
    this.startQuat.copy(params.startWeaponWorldQuat);
    this.rackPos.copy(params.slotWorldPos);
    this.rackQuat.copy(params.slotWorldQuat);
    // Outward normal from the Gun Wall (wall faces +Z into the Arsenal Room)
    this._rackNormal.set(0, 0, 1);
    this.rackClearOffset.copy(this._rackNormal).multiplyScalar(0.16);
    this.rackPullPos.copy(this.rackPos).add(this.rackClearOffset);

    this.onMountOutgoingCb = params.onMountOutgoingToRack;
    this.onDetachIncomingCb = params.onDetachIncomingFromRack;
    this.onCompleteCb = params.onComplete;

    this.elapsed = 0;
    this.hungOutgoing = false;
    this.liftedIncoming = false;
    this.playedHandoffCue = false;

    if (hasOut && hasIn) {
      this.mode = 'SWAP_ARMED';
      this.duration = 0.9;
      this.outgoingAssembly = this.buildTransientWeapon(this.outgoingWeaponId);
      this.incomingAssembly = this.buildTransientWeapon(this.incomingWeaponId!);
      this.outgoingAssembly.group.position.copy(this.startPos);
      this.outgoingAssembly.group.quaternion.copy(this.startQuat);
      this.outgoingAssembly.group.visible = true;
      // Incoming starts hidden until detached from wall at 0.30s so wall rack shows it natively
      this.incomingAssembly.group.position.copy(this.rackPos);
      this.incomingAssembly.group.quaternion.copy(this.rackQuat);
      this.incomingAssembly.group.visible = false;
    } else if (!hasOut && hasIn) {
      this.mode = 'GRAB_UNARMED';
      this.duration = 0.58;
      this.incomingAssembly = this.buildTransientWeapon(this.incomingWeaponId!);
      this.incomingAssembly.group.position.copy(this.rackPos);
      this.incomingAssembly.group.quaternion.copy(this.rackQuat);
      this.incomingAssembly.group.visible = false;
    } else {
      this.mode = 'HANG_ONLY';
      this.duration = 0.5;
      this.outgoingAssembly = this.buildTransientWeapon(this.outgoingWeaponId);
      this.outgoingAssembly.group.position.copy(this.startPos);
      this.outgoingAssembly.group.quaternion.copy(this.startQuat);
      this.outgoingAssembly.group.visible = true;
    }

    this.audio.playGearRattle('weapon_swap', 0.52);
    this.ikOverride.active = true;
    return true;
  }

  private buildTransientWeapon(weaponId: string): WeaponModelAssembly {
    const profile = resolveWeaponProfile(weaponId);
    const build = loadoutStore.getActiveWeaponBuild(weaponId);
    const asm = WeaponModelFactory.build({
      id: profile.id,
      holdClass: profile.holdClass,
      barrelLengthM: profile.barrelLengthM,
      visualStyle: profile.visualStyle,
      finish: profile.finish,
      railType: profile.railType,
      isRevolver: profile.isRevolver,
      boreAxisHeightM: profile.boreAxisHeightM,
      rightHandSocket: profile.rightHandSocket,
      leftHandSocket: profile.leftHandSocket,
      muzzleOffset: profile.muzzleOffset,
      laserOffset: profile.laserOffset,
      supportsSuppressor: profile.supportsSuppressor,
      renderLayer: 0, // World layer so depth against Gun Wall & brackets is physically exact
    });
    WeaponAssembler.applyAttachments(
      asm,
      profile.massKg,
      profile.barrelLengthM,
      profile.magCapacity,
      build.attachments,
      { thirdPersonMode: true },
    );
    this.propRoot.add(asm.group);
    return asm;
  }

  private sampleTargetReadyPose(camera: THREE.Camera): void {
    camera.getWorldDirection(this._camFwd).normalize();
    this._camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    this._camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    const targetId = this.incomingWeaponId ?? this.outgoingWeaponId;
    const prof = resolveWeaponProfile(targetId);
    const hipX = prof.holdClass === 'pistol' ? 0.08 : 0.10;
    const hipY = prof.holdClass === 'pistol' ? -0.17 : -0.20;
    const hipZ = prof.holdClass === 'pistol' ? 0.39 : 0.36;

    camera.getWorldPosition(this._readyPos);
    this._readyPos
      .addScaledVector(this._camRight, hipX)
      .addScaledVector(this._camUp, hipY)
      .addScaledVector(this._camFwd, hipZ);
    this._readyQuat.copy(camera.quaternion);

    // Center workspace position for the Phase 2 -> Phase 3 left-to-right hand-off
    camera.getWorldPosition(this._workspacePos);
    this._workspacePos
      .addScaledVector(this._camRight, -0.02)
      .addScaledVector(this._camUp, -0.22)
      .addScaledVector(this._camFwd, 0.38);

    this._wsTiltEuler.set(0.14, 0.32, 0.18, 'YXZ');
    this._wsTiltQuat.setFromEuler(this._wsTiltEuler);
    this._workspaceQuat.copy(camera.quaternion).multiply(this._wsTiltQuat);
  }

  private sampleSockets(asm: WeaponModelAssembly): void {
    asm.group.updateMatrixWorld(true);
    asm.rightHandSocket.getWorldPosition(this._sockRPos);
    asm.rightHandSocket.getWorldQuaternion(this._sockRQuat);
    if (asm.hasLeftHandSocket) {
      asm.leftHandSocket.getWorldPosition(this._sockLPos);
      asm.leftHandSocket.getWorldQuaternion(this._sockLQuat);
    } else {
      this._sockLPos.copy(this._sockRPos).addScaledVector(this._camRight, -0.05);
      this._sockLQuat.copy(this._sockRQuat);
    }
  }

  public update(dt: number, camera: THREE.Camera): void {
    if (this.mode === 'NONE') {
      this.ikOverride.active = false;
      return;
    }

    this.elapsed += Math.min(dt, 0.05);
    this.sampleTargetReadyPose(camera);

    if (this.mode === 'SWAP_ARMED') {
      this.updateSwapArmed();
    } else if (this.mode === 'GRAB_UNARMED') {
      this.updateGrabUnarmed();
    } else if (this.mode === 'HANG_ONLY') {
      this.updateHangOnly();
    }

    if (this.elapsed >= this.duration) {
      const finishedSlot = this.slotIndex;
      const nextEquipped =
        this.mode === 'HANG_ONLY' ? 'unarmed' : (this.incomingWeaponId ?? 'unarmed');
      const completeCb = this.onCompleteCb;

      this.mode = 'NONE';
      this.ikOverride.active = false;
      this.clearProps();
      completeCb?.(finishedSlot, nextEquipped);
    }
  }

  private updateSwapArmed(): void {
    const t = this.elapsed;

    // Slight horizontal offset between hanging spot and lift spot so both guns never clip during overlap
    this._hangMidPos.copy(this.rackPullPos).addScaledVector(this._camRight, 0.08);
    this._liftMidPos.copy(this.rackPullPos).addScaledVector(this._camRight, -0.08);

    // === PHASE 1 (0.00s - 0.35s): Right hand seats outgoing weapon onto Gun Wall brackets ===
    if (this.outgoingAssembly && !this.hungOutgoing) {
      if (t < 0.24) {
        const u = smoothstep(0.0, 0.24, t);
        this.outgoingAssembly.group.position.copy(this.startPos).lerp(this._hangMidPos, u);
        this.outgoingAssembly.group.quaternion.copy(this.startQuat).slerp(this.rackQuat, u);
      } else {
        const u = smoothstep(0.24, 0.35, t);
        this.outgoingAssembly.group.position.copy(this._hangMidPos).lerp(this.rackPos, u);
        this.outgoingAssembly.group.quaternion.copy(this.rackQuat);
      }

      this.sampleSockets(this.outgoingAssembly);
      this._prevRightPos.copy(this._sockRPos);
      this._prevRightQuat.copy(this._sockRQuat);
      this._prevLeftPos.copy(this._sockLPos);
      this._prevLeftQuat.copy(this._sockLQuat);

      if (t >= 0.35) {
        this.hungOutgoing = true;
        this.outgoingAssembly.group.visible = false;
        this.onMountOutgoingCb?.(this.slotIndex, this.outgoingWeaponId);
        this.audio.playWeaponCue('bolt_lock', { intensity: 0.72 });
      }
    }

    // === PHASE 2 (0.30s - 0.65s): Left hand lifts incoming weapon off rack & brings into workspace ===
    if (this.incomingAssembly) {
      if (t >= 0.30 && !this.liftedIncoming) {
        this.liftedIncoming = true;
        this.onDetachIncomingCb?.(this.slotIndex);
        this.incomingAssembly.group.visible = true;
        this.audio.playWeaponCue('mag_out', { intensity: 0.65 });
      }

      if (t < 0.30) {
        this.incomingAssembly.group.position.copy(this.rackPos);
        this.incomingAssembly.group.quaternion.copy(this.rackQuat);
      } else if (t < 0.44) {
        const u = smoothstep(0.30, 0.44, t);
        this.incomingAssembly.group.position.copy(this.rackPos).lerp(this._liftMidPos, u);
        this.incomingAssembly.group.quaternion.copy(this.rackQuat);
      } else if (t < 0.65) {
        const u = smoothstep(0.44, 0.65, t);
        this.incomingAssembly.group.position.copy(this._liftMidPos).lerp(this._workspacePos, u);
        this.incomingAssembly.group.quaternion.copy(this.rackQuat).slerp(this._workspaceQuat, u);
      } else {
        // === PHASE 3 (0.65s - 0.90s): Hand-off into two-handed ready stance ===
        if (!this.playedHandoffCue) {
          this.playedHandoffCue = true;
          this.audio.playGearRattle('weapon_swap', 0.48);
        }
        const u = smoothstep(0.65, 0.9, t);
        this.incomingAssembly.group.position.copy(this._workspacePos).lerp(this._readyPos, u);
        this.incomingAssembly.group.quaternion.copy(this._workspaceQuat).slerp(this._readyQuat, u);
      }

      this.sampleSockets(this.incomingAssembly);
    }

    // Drive Right & Left Hand IK Targets across all 3 phases cleanly
    this.ikOverride.active = true;
    this.ikOverride.suppressWeaponHardLock = true;

    // RIGHT HAND: holds outgoing gun until 0.35s, releases & travels to incoming primary grip 0.35–0.72s, locks 0.72–0.90s
    if (t < 0.35) {
      this.ikOverride.rightWeight = 1;
      this.ikOverride.rightWorldPos.copy(this._prevRightPos);
      this.ikOverride.rightWorldQuat.copy(this._prevRightQuat);
      this.ikOverride.rightGripCurl = t > 0.31 ? THREE.MathUtils.lerp(0.95, 0.45, (t - 0.31) / 0.04) : 0.95;
    } else if (t < 0.72) {
      const u = smoothstep(0.35, 0.72, t);
      this.ikOverride.rightWeight = 1;
      this.ikOverride.rightWorldPos.copy(this._prevRightPos).lerp(this._sockRPos, u);
      this.ikOverride.rightWorldQuat.copy(this._prevRightQuat).slerp(this._sockRQuat, u);
      this.ikOverride.rightGripCurl = THREE.MathUtils.lerp(0.42, 0.96, u);
    } else {
      const fadeOut = 1 - smoothstep(0.84, 0.9, t) * 0.25;
      this.ikOverride.rightWeight = fadeOut;
      this.ikOverride.rightWorldPos.copy(this._sockRPos);
      this.ikOverride.rightWorldQuat.copy(this._sockRQuat);
      this.ikOverride.rightGripCurl = 0.96;
    }

    // LEFT HAND: releases outgoing forend at 0.05–0.30s to reach incoming gun on rack, lifts 0.30–0.65s, seats 0.65–0.90s
    if (t < 0.30) {
      const u = smoothstep(0.05, 0.30, t);
      this.ikOverride.leftWeight = 1;
      this.ikOverride.leftWorldPos.copy(this._prevLeftPos).lerp(this._sockLPos, u);
      this.ikOverride.leftWorldQuat.copy(this._prevLeftQuat).slerp(this._sockLQuat, u);
      this.ikOverride.leftGripCurl = u < 0.75 ? 0.55 : THREE.MathUtils.lerp(0.55, 0.94, (u - 0.75) / 0.25);
    } else {
      const fadeOut = 1 - smoothstep(0.84, 0.9, t) * 0.25;
      this.ikOverride.leftWeight = fadeOut;
      this.ikOverride.leftWorldPos.copy(this._sockLPos);
      this.ikOverride.leftWorldQuat.copy(this._sockLQuat);
      this.ikOverride.leftGripCurl = 0.94;
    }
  }

  private updateGrabUnarmed(): void {
    const t = this.elapsed;
    if (!this.incomingAssembly) return;

    if (t >= 0.16 && !this.liftedIncoming) {
      this.liftedIncoming = true;
      this.onDetachIncomingCb?.(this.slotIndex);
      this.incomingAssembly.group.visible = true;
      this.audio.playWeaponCue('mag_out', { intensity: 0.62 });
    }

    if (t < 0.16) {
      this.incomingAssembly.group.position.copy(this.rackPos);
      this.incomingAssembly.group.quaternion.copy(this.rackQuat);
    } else if (t < 0.32) {
      const u = smoothstep(0.16, 0.32, t);
      this.incomingAssembly.group.position.copy(this.rackPos).lerp(this.rackPullPos, u);
      this.incomingAssembly.group.quaternion.copy(this.rackQuat);
    } else {
      const u = smoothstep(0.32, 0.58, t);
      this.incomingAssembly.group.position.copy(this.rackPullPos).lerp(this._readyPos, u);
      this.incomingAssembly.group.quaternion.copy(this.rackQuat).slerp(this._readyQuat, u);
    }

    this.sampleSockets(this.incomingAssembly);

    const reachW = smoothstep(0.0, 0.16, t);
    const handoffW = smoothstep(0.22, 0.44, t);
    this.ikOverride.active = true;
    this.ikOverride.suppressWeaponHardLock = true;
    this.ikOverride.leftWeight = reachW;
    this.ikOverride.leftWorldPos.copy(this._sockLPos);
    this.ikOverride.leftWorldQuat.copy(this._sockLQuat);
    this.ikOverride.leftGripCurl = THREE.MathUtils.lerp(0.45, 0.94, reachW);

    this.ikOverride.rightWeight = Math.max(reachW * 0.4, handoffW);
    this.ikOverride.rightWorldPos.copy(this._sockRPos);
    this.ikOverride.rightWorldQuat.copy(this._sockRQuat);
    this.ikOverride.rightGripCurl = THREE.MathUtils.lerp(0.42, 0.96, handoffW);
  }

  private updateHangOnly(): void {
    const t = this.elapsed;
    if (!this.outgoingAssembly) return;

    if (!this.hungOutgoing) {
      if (t < 0.28) {
        const u = smoothstep(0.0, 0.28, t);
        this.outgoingAssembly.group.position.copy(this.startPos).lerp(this.rackPullPos, u);
        this.outgoingAssembly.group.quaternion.copy(this.startQuat).slerp(this.rackQuat, u);
      } else {
        const u = smoothstep(0.28, 0.40, t);
        this.outgoingAssembly.group.position.copy(this.rackPullPos).lerp(this.rackPos, u);
        this.outgoingAssembly.group.quaternion.copy(this.rackQuat);
      }
      this.sampleSockets(this.outgoingAssembly);
      this._prevRightPos.copy(this._sockRPos);
      this._prevRightQuat.copy(this._sockRQuat);

      if (t >= 0.40) {
        this.hungOutgoing = true;
        this.outgoingAssembly.group.visible = false;
        this.onMountOutgoingCb?.(this.slotIndex, this.outgoingWeaponId);
        this.audio.playWeaponCue('bolt_lock', { intensity: 0.7 });
      }
    }

    const releaseFade = t < 0.40 ? 1 : 1 - smoothstep(0.40, 0.50, t);
    this.ikOverride.active = true;
    this.ikOverride.suppressWeaponHardLock = true;
    this.ikOverride.rightWeight = releaseFade;
    this.ikOverride.rightWorldPos.copy(this._prevRightPos);
    this.ikOverride.rightWorldQuat.copy(this._prevRightQuat);
    this.ikOverride.rightGripCurl = t < 0.36 ? 0.94 : 0.4;

    // Left hand smoothly withdraws off the forend
    this.ikOverride.leftWeight = 1 - smoothstep(0.05, 0.24, t);
    this.ikOverride.leftWorldPos.copy(this._sockLPos);
    this.ikOverride.leftWorldQuat.copy(this._sockLQuat);
    this.ikOverride.leftGripCurl = 0.65;
  }

  private clearProps(): void {
    if (this.outgoingAssembly) {
      this.propRoot.remove(this.outgoingAssembly.group);
      this.outgoingAssembly.dispose();
      this.outgoingAssembly = null;
    }
    if (this.incomingAssembly) {
      this.propRoot.remove(this.incomingAssembly.group);
      this.incomingAssembly.dispose();
      this.incomingAssembly = null;
    }
  }

  public dispose(): void {
    this.clearProps();
    this.scene.remove(this.propRoot);
  }
}

import * as THREE from 'three';
import { IBodycamAudioSource } from '../IBodycamAudioSource';
import {
  BodycamSurfaceMaterial,
  BodycamSurvivalModifiers,
  BodycamTraumaModifiers,
  BodycamVaultMode,
  IBodycamWorldAdapter,
} from '../types';
import { VaultCandidate, VaultKind } from './VaultDetector';

export type VaultWeaponRetentionMode = 'NONE' | 'ONE_HAND_TUCK' | 'TWO_HAND_SLING';

export interface VaultCompletionResult {
  completed: boolean;
  mustCrouch: boolean;
  exertionGain: number;
  landingShockAmp: number;
  heelPitchImpulse: number;
  surface: BodycamSurfaceMaterial;
  kind: VaultKind;
}

export interface VaultStateSnapshot {
  active: boolean;
  kind: VaultKind;
  mode: BodycamVaultMode;
  progress: number;
  handPinWeightL: number;
  handPinWeightR: number;
  handLWorld: THREE.Vector3;
  handRWorld: THREE.Vector3;
  wallNormal: THREE.Vector3;
  vaultForward: THREE.Vector3;
  weaponRetentionMode: VaultWeaponRetentionMode;
  weaponRetentionBlend: number;
  cameraPitchOffset: number;
  cameraRollOffset: number;
  cameraDipOffset: number;
  crouchTransitionWeight: number;
  legTuckWeight: number;
  headDuckWeight: number;
  /** World-space ceiling cap keeping camera & head strictly below window headers/lintels */
  maxCameraWorldY: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Grounded physical vault & mantle traversal controller.
 * Drives asymmetric weighted chest-cam arcs, world-locked IK hand brace coordinates,
 * weapon retention modes, trauma/encumbrance pacing, and surface-matched audio/stealth events.
 * Zero per-frame allocations.
 */
export class VaultController {
  private active = false;
  private kind: VaultKind = 'VAULT_OVER';
  private elapsed = 0;
  private duration = 0.6;
  private surface: BodycamSurfaceMaterial = 'concrete';
  private mustCrouchOnFinish = false;
  private isWindowBreach = false;
  private wasCrouchedOnEntry = false;
  private overheadCeilingY = Infinity;
  private ledgeHeight = 0.9;
  private vaultHeadingYaw = 0;

  private handSlapPlayed = false;
  private secondHandSlapPlayed = false;
  private bootScuffPlayed = false;
  private glassShattered = false;
  private breakableGlassObj: THREE.Object3D | null = null;

  private readonly entryPos = new THREE.Vector3();
  private readonly apexPos = new THREE.Vector3();
  private readonly landPos = new THREE.Vector3();
  private readonly glassImpactPoint = new THREE.Vector3();

  private readonly state: VaultStateSnapshot = {
    active: false,
    kind: 'VAULT_OVER',
    mode: 'NONE',
    progress: 0,
    handPinWeightL: 0,
    handPinWeightR: 0,
    handLWorld: new THREE.Vector3(),
    handRWorld: new THREE.Vector3(),
    wallNormal: new THREE.Vector3(0, 0, 1),
    vaultForward: new THREE.Vector3(0, 0, -1),
    weaponRetentionMode: 'NONE',
    weaponRetentionBlend: 0,
    cameraPitchOffset: 0,
    cameraRollOffset: 0,
    cameraDipOffset: 0,
    crouchTransitionWeight: 0,
    legTuckWeight: 0,
    headDuckWeight: 0,
    maxCameraWorldY: Infinity,
  };

  private readonly completionOut: VaultCompletionResult = {
    completed: false,
    mustCrouch: false,
    exertionGain: 0,
    landingShockAmp: 0,
    heelPitchImpulse: 0,
    surface: 'concrete',
    kind: 'VAULT_OVER',
  };

  public isActive(): boolean {
    return this.active;
  }

  public getVaultHeadingYaw(): number {
    return this.vaultHeadingYaw;
  }

  public getReadOnlyState(): Readonly<VaultStateSnapshot> {
    return this.state;
  }

  public shiftOrigin(dx: number, dz: number): void {
    if (!this.active) return;
    this.entryPos.x += dx;
    this.entryPos.z += dz;
    this.apexPos.x += dx;
    this.apexPos.z += dz;
    this.landPos.x += dx;
    this.landPos.z += dz;
    this.glassImpactPoint.x += dx;
    this.glassImpactPoint.z += dz;
    this.state.handLWorld.x += dx;
    this.state.handLWorld.z += dz;
    this.state.handRWorld.x += dx;
    this.state.handRWorld.z += dz;
  }

  public abort(): void {
    this.active = false;
    this.elapsed = 0;
    this.breakableGlassObj = null;
    this.state.active = false;
    this.state.mode = 'NONE';
    this.state.progress = 0;
    this.state.handPinWeightL = 0;
    this.state.handPinWeightR = 0;
    this.state.weaponRetentionMode = 'NONE';
    this.state.weaponRetentionBlend = 0;
    this.state.cameraPitchOffset = 0;
    this.state.cameraRollOffset = 0;
    this.state.cameraDipOffset = 0;
    this.state.crouchTransitionWeight = 0;
    this.state.legTuckWeight = 0;
    this.state.headDuckWeight = 0;
    this.state.maxCameraWorldY = Infinity;
  }

  public start(
    candidate: Readonly<VaultCandidate>,
    trauma?: Readonly<BodycamTraumaModifiers>,
    survivalMods?: Readonly<BodycamSurvivalModifiers>,
    wasCrouchedOnEntry = false,
  ): void {
    this.active = true;
    this.kind = candidate.kind;
    this.elapsed = 0;
    this.surface = candidate.surface;
    this.mustCrouchOnFinish = candidate.mustCrouchOnFinish;
    this.isWindowBreach = candidate.isWindowBreach;
    this.wasCrouchedOnEntry = wasCrouchedOnEntry;
    this.overheadCeilingY = candidate.overheadCeilingY;
    this.ledgeHeight = candidate.ledgeHeight;

    this.entryPos.copy(candidate.entryPos);
    this.apexPos.copy(candidate.apexPos);
    this.landPos.copy(candidate.landPos);
    this.breakableGlassObj = candidate.breakableGlassObj;
    this.glassImpactPoint.copy(candidate.glassImpactPoint);

    this.handSlapPlayed = false;
    this.secondHandSlapPlayed = false;
    this.bootScuffPlayed = false;
    this.glassShattered = false;

    // Heading yaw facing directly into the obstacle (-Z is yaw=0)
    this.vaultHeadingYaw = Math.atan2(-candidate.vaultForward.x, -candidate.vaultForward.z);

    // Base athletic tactical durations scaled by height, leg trauma, and encumbrance.
    // When vaulting through a window from standing, include a crisp seamless pre-crouch beat (0.14s)
    // so the player drops into crouch BEFORE crossing under the window header.
    const needsStandingPreCrouch = candidate.isWindowBreach && !wasCrouchedOnEntry;
    let baseDur =
      candidate.kind === 'VAULT_OVER'
        ? needsStandingPreCrouch
          ? 0.70
          : 0.56
        : candidate.kind === 'CLIMB_ONTO'
          ? needsStandingPreCrouch
            ? 0.82
            : 0.68
          : 0.96 + Math.max(0, candidate.ledgeHeight - 1.25) * 0.24;

    const avgLegImpair = trauma
      ? (trauma.leftLegImpairment + trauma.rightLegImpairment) * 0.5
      : 0;
    const encumbrance = survivalMods ? THREE.MathUtils.clamp(survivalMods.encumbranceRatio, 0, 1) : 0;
    const speedMult = THREE.MathUtils.clamp(
      (1 - avgLegImpair * 0.42) * (1 - encumbrance * 0.28),
      0.46,
      1.0,
    );
    this.duration = baseDur / speedMult;

    this.state.active = true;
    this.state.kind = candidate.kind;
    this.state.mode = candidate.kind;
    this.state.progress = 0;
    this.state.handLWorld.copy(candidate.handLWorld);
    this.state.handRWorld.copy(candidate.handRWorld);
    this.state.wallNormal.copy(candidate.wallNormal);
    this.state.vaultForward.copy(candidate.vaultForward);
    this.state.weaponRetentionMode =
      candidate.kind === 'HIGH_MANTLE' ? 'TWO_HAND_SLING' : 'ONE_HAND_TUCK';
    this.state.weaponRetentionBlend = 0;
    this.state.handPinWeightL = 0;
    this.state.handPinWeightR = 0;
    this.state.cameraPitchOffset = 0;
    this.state.cameraRollOffset = 0;
    this.state.cameraDipOffset = 0;
    // Immediately engage full crouch height on frame 0 for window breaches so camera never pokes into the header
    this.state.crouchTransitionWeight = candidate.isWindowBreach ? 1.0 : 0;
    this.state.legTuckWeight = 0;
    this.state.headDuckWeight = candidate.isWindowBreach ? 0.25 : 0;
    this.state.maxCameraWorldY = Number.isFinite(candidate.overheadCeilingY)
      ? candidate.overheadCeilingY - 0.30
      : Infinity;
  }

  /**
   * Advances the physical vault/mantle arc and writes the player's root position to `outPosition`.
   * Returns a pre-allocated completion struct (`completed === true` on the final frame).
   */
  public update(
    dt: number,
    outPosition: THREE.Vector3,
    adapter: IBodycamWorldAdapter,
    audio: IBodycamAudioSource,
  ): Readonly<VaultCompletionResult> {
    this.completionOut.completed = false;
    if (!this.active) {
      return this.completionOut;
    }

    this.elapsed += dt;
    const p = THREE.MathUtils.clamp(this.elapsed / Math.max(0.15, this.duration), 0, 1);
    this.state.progress = p;

    const isHigh = this.kind === 'HIGH_MANTLE';
    const isVaultOver = this.kind === 'VAULT_OVER';

    // 1. Timed tactile foley, breakable glass entry shatter & stealth acoustic events
    if (!this.handSlapPlayed && p >= 0.08) {
      this.handSlapPlayed = true;
      audio.playHandSlap(this.surface, isHigh ? 1.15 : 0.85);
      audio.playGearRattle('vault', isHigh ? 1.05 : 0.72);
    }
    if (isHigh && !this.secondHandSlapPlayed && p >= 0.16) {
      this.secondHandSlapPlayed = true;
      audio.playHandSlap(this.surface, 1.0);
    }
    if (this.breakableGlassObj && !this.glassShattered && p >= 0.14) {
      this.glassShattered = true;
      const shattered = adapter.shatterBreakable?.(
        this.breakableGlassObj,
        this.glassImpactPoint,
        this.state.vaultForward,
      );
      if (shattered !== false) {
        audio.playGlassShatter(this.glassImpactPoint, 1.0);
        adapter.emitAcousticEvent?.(this.glassImpactPoint, 26, 'glass_shatter');
      }
      this.breakableGlassObj = null;
    }
    if (!this.bootScuffPlayed && p >= (isHigh ? 0.44 : 0.48)) {
      this.bootScuffPlayed = true;
      audio.playBootScuff(this.surface, isHigh ? 1.15 : 0.78);
      audio.playGearRattle('vault', isHigh ? 1.15 : 0.65);
    }

    // Seamless pre-crouch phase for standing window breaches:
    // Drop into full crouch BEFORE lifting/crossing through the window frame (0..0.22),
    // so standing window vaults traverse at identical crouched clearance as crouched vaults.
    const needsPreCrouch = this.isWindowBreach && !this.wasCrouchedOnEntry;
    const crossP = needsPreCrouch ? THREE.MathUtils.clamp((p - 0.20) / 0.80, 0, 1) : p;

    // 2. Asymmetric Physical Position Trajectory
    // Weighty vertical heave first, then crest forward over the lip, then grounded drop/settle.
    if (isHigh) {
      // HIGH_MANTLE: Reach & grab (0..0.22) -> Heavy pull-up (0.22..0.64) -> Crest onto deck (0.64..1.0)
      const horizT = smoothstep(0.36, 0.94, crossP);
      const riseT = Math.pow(smoothstep(0.14, 0.78, crossP), 0.85);
      const settleDip = crossP > 0.78 ? Math.sin(((crossP - 0.78) / 0.22) * Math.PI) * 0.045 : 0;

      outPosition.x = THREE.MathUtils.lerp(this.entryPos.x, this.landPos.x, horizT);
      outPosition.z = THREE.MathUtils.lerp(this.entryPos.z, this.landPos.z, horizT);
      outPosition.y = THREE.MathUtils.lerp(this.entryPos.y, this.landPos.y, riseT) + settleDip;
    } else if (isVaultOver) {
      // VAULT_OVER: (Pre-crouch if standing window breach) -> Plant left hand & lift -> Swing legs over -> Touchdown
      const horizT = smoothstep(0.04, 0.96, crossP);
      if (crossP < 0.50) {
        const upT = Math.pow(smoothstep(0.0, 0.50, crossP), 0.78);
        outPosition.y = THREE.MathUtils.lerp(this.entryPos.y, this.apexPos.y, upT);
      } else {
        const downT = Math.pow(smoothstep(0.50, 1.0, crossP), 1.35);
        outPosition.y = THREE.MathUtils.lerp(this.apexPos.y, this.landPos.y, downT);
      }
      outPosition.x = THREE.MathUtils.lerp(this.entryPos.x, this.landPos.x, horizT);
      outPosition.z = THREE.MathUtils.lerp(this.entryPos.z, this.landPos.z, horizT);
    } else {
      // CLIMB_ONTO: Brace & step up cleanly onto deep obstacle
      const horizT = smoothstep(0.14, 0.94, crossP);
      const riseT = Math.pow(smoothstep(0.06, 0.74, crossP), 0.82);
      const crestBoost = Math.sin(smoothstep(0.45, 0.92, crossP) * Math.PI) * 0.05;
      outPosition.x = THREE.MathUtils.lerp(this.entryPos.x, this.landPos.x, horizT);
      outPosition.z = THREE.MathUtils.lerp(this.entryPos.z, this.landPos.z, horizT);
      outPosition.y = THREE.MathUtils.lerp(this.entryPos.y, this.landPos.y, riseT) + crestBoost;
    }

    // 3. World-Locked IK Hand Pinning Weights
    // Smoothly snap to exact concrete ledge lip during pull/brace, release cleanly before touchdown
    if (isHigh) {
      const pinIn = smoothstep(0.03, 0.16, crossP);
      const pinOut = 1 - smoothstep(0.68, 0.84, crossP);
      const w = pinIn * pinOut;
      this.state.handPinWeightL = w;
      this.state.handPinWeightR = w;
      // Weapon slings down immediately and smoothly re-readies over 0.74 -> 1.0
      this.state.weaponRetentionBlend = smoothstep(0.0, 0.14, p) * (1 - smoothstep(0.74, 1.0, crossP));
    } else {
      const pinIn = smoothstep(0.02, 0.16, p);
      const pinOut = 1 - smoothstep(0.58, 0.78, crossP);
      this.state.handPinWeightL = pinIn * pinOut;
      this.state.handPinWeightR = 0;
      this.state.weaponRetentionBlend = smoothstep(0.0, 0.16, p) * (1 - smoothstep(0.70, 0.98, crossP));
    }

    // 4. Bodycam Chest-Camera Kinematics (weighty heave pitch, roll toward bracing hand, full crouch-duck through windows)
    const needsWindowDuck = this.isWindowBreach || this.mustCrouchOnFinish;
    const stayCrouchedAfter = this.mustCrouchOnFinish || this.wasCrouchedOnEntry;
    const windowDuckEnv = needsWindowDuck
      ? smoothstep(0.0, 0.14, p) * (stayCrouchedAfter ? 1.0 : 1 - smoothstep(0.84, 1.0, crossP))
      : 0;
    this.state.headDuckWeight = windowDuckEnv;

    if (isHigh) {
      const pullHeave = Math.sin(smoothstep(0.10, 0.65, crossP) * Math.PI);
      const crestNod = Math.sin(smoothstep(0.55, 0.95, crossP) * Math.PI);
      this.state.cameraPitchOffset = -0.14 * pullHeave - 0.08 * crestNod - 0.08 * windowDuckEnv;
      this.state.cameraRollOffset =
        Math.sin(crossP * Math.PI * 2.0) * THREE.MathUtils.degToRad(5.2) * (1 - smoothstep(0.72, 1.0, crossP));
      this.state.cameraDipOffset =
        -0.09 * Math.sin(smoothstep(0.0, 0.28, crossP) * Math.PI) - 0.22 * windowDuckEnv;
      this.state.legTuckWeight = Math.sin(smoothstep(0.20, 0.92, crossP) * Math.PI);
    } else if (isVaultOver) {
      const braceEnv = Math.sin(smoothstep(0.04, 0.88, crossP) * Math.PI);
      this.state.cameraRollOffset = THREE.MathUtils.degToRad(needsWindowDuck ? 8.2 : 7.2) * braceEnv;
      this.state.cameraPitchOffset =
        -0.09 * Math.sin(smoothstep(0.12, 0.75, crossP) * Math.PI) - 0.12 * windowDuckEnv;
      this.state.cameraDipOffset = needsWindowDuck
        ? -0.22 * windowDuckEnv - 0.05 * Math.sin(smoothstep(0.18, 0.72, crossP) * Math.PI)
        : -0.04 * Math.sin(smoothstep(0.0, 0.25, crossP) * Math.PI);
      this.state.legTuckWeight = Math.sin(smoothstep(0.12, 0.86, crossP) * Math.PI);
    } else {
      const braceEnv = Math.sin(smoothstep(0.05, 0.84, crossP) * Math.PI);
      this.state.cameraRollOffset = THREE.MathUtils.degToRad(5.4) * braceEnv;
      this.state.cameraPitchOffset =
        -0.10 * Math.sin(smoothstep(0.10, 0.70, crossP) * Math.PI) - 0.11 * windowDuckEnv;
      this.state.cameraDipOffset = needsWindowDuck
        ? -0.20 * windowDuckEnv
        : -0.05 * Math.sin(smoothstep(0.0, 0.25, crossP) * Math.PI);
      this.state.legTuckWeight = Math.sin(smoothstep(0.15, 0.86, crossP) * Math.PI);
    }

    // Hold full crouch posture from frame 0 through window exit; smoothly begin rising right at touchdown
    // ONLY if the player started standing AND the destination has standing headroom.
    this.state.crouchTransitionWeight = needsWindowDuck
      ? stayCrouchedAfter
        ? 1.0
        : 1 - smoothstep(0.86, 1.0, crossP)
      : this.wasCrouchedOnEntry
        ? 1.0
        : 0;
    this.state.maxCameraWorldY = Number.isFinite(this.overheadCeilingY)
      ? this.overheadCeilingY - 0.30
      : Infinity;

    // 5. Completion & Touchdown Handoff
    if (p >= 1.0) {
      outPosition.copy(this.landPos);
      const landSurface = adapter.getSurfaceMaterial(this.landPos.x, this.landPos.y, this.landPos.z);

      // Emit surface-matched landing foley & stealth acoustic event
      const landIntensity = isHigh ? 1.25 : isVaultOver ? 0.95 : 0.85;
      audio.playFootstep(landSurface, landIntensity);
      audio.playGearRattle('landing', landIntensity * 0.9);
      adapter.emitAcousticEvent?.(
        this.landPos,
        isHigh ? 17 : isVaultOver ? 10 : 12,
        isHigh ? 'mantle_heavy' : 'vault_low',
      );

      this.completionOut.completed = true;
      // Stay crouched if destination requires crouch OR if the player was already crouched before vaulting;
      // automatically uncrouch back to standing if the player was standing and destination has headroom!
      this.completionOut.mustCrouch = this.mustCrouchOnFinish || this.wasCrouchedOnEntry;
      this.completionOut.exertionGain = isHigh
        ? 0.28 + Math.max(0, this.ledgeHeight - 1.4) * 0.10
        : isVaultOver
          ? 0.14
          : 0.18;
      this.completionOut.landingShockAmp = isHigh ? 0.085 : isVaultOver ? 0.072 : 0.055;
      this.completionOut.heelPitchImpulse = isHigh ? -0.26 : -0.18;
      this.completionOut.surface = landSurface;
      this.completionOut.kind = this.kind;

      this.abort();
    }

    return this.completionOut;
  }
}

import * as THREE from 'three';
import {
  BodycamWeaponCueOptions,
  BodycamWeaponAudioCue,
  IBodycamAudioSource,
} from '../IBodycamAudioSource';
import { VIEWMODEL_LAYER } from '../BodycamPostProcess';
import { WeaponModelAssembly } from './WeaponModelFactory';

export interface WeaponFireAnimOptions {
  cyclePump?: boolean;
  cycleBolt?: boolean;
  boltDurationSec?: number;
  isRevolver?: boolean;
}

export type WeaponPoseStateId =
  | 'Idle'
  | 'ADS'
  | 'Cant'
  | 'PointAim'
  | 'LowReadySprint'
  | 'WallPullback'
  | 'VaultRetention'
  | 'Equip'
  | 'Reload'
  | 'MagCheck'
  | 'Inspect'
  | 'SuppressorToggle';

export type WeaponMechanicalAction =
  | 'NONE'
  | 'RELOAD'
  | 'MAG_CHECK'
  | 'INSPECT'
  | 'SUPPRESSOR_ATTACH'
  | 'SUPPRESSOR_DETACH';

export type WeaponReloadSubPhase =
  | 'NONE'
  | 'REACH_MAG'
  | 'PULL_MAG'
  | 'SWAP_POUCH'
  | 'INSERT_MAG'
  | 'RACK_BOLT'
  | 'RETURN';

export type WeaponSuppressorSubPhase =
  | 'NONE'
  | 'TILT_WEAPON'
  | 'REACH_MUZZLE'
  | 'REACH_POUCH'
  | 'TWIST_THREAD'
  | 'STOW_OR_CLEAR'
  | 'RETURN_GRIP';

export interface WeaponPoseUpdateInput {
  dt: number;
  elapsed: number;
  isFirearm: boolean;
  isUnarmed: boolean;
  massHandlingFactor: number;
  weightClass: 'pistol' | 'carbine' | 'heavy_rifle';
  aimYaw: number;
  aimPitch: number;
  isAds: boolean;
  isCanted: boolean;
  isPointAim?: boolean;
  isSprinting: boolean;
  isMoving: boolean;
  bobPhase: number;
  verticalMotionOffset: number;
  pullbackRatio: number;
  barrelLengthM: number;
  vaultRetentionMode: 'NONE' | 'ONE_HAND_TUCK' | 'TWO_HAND_SLING';
  vaultRetentionBlend: number;
  adsSpeedMult: number;
  cantAngleRad: number;
  pointAimOffset?: readonly [number, number, number];
  pointAimRollRad?: number;
  pointAimConvPitchRad?: number;
  pointAimConvYawRad?: number;
  hipOffset: readonly [number, number, number];
  cantOffset: readonly [number, number, number];
  lowReadyOffset: readonly [number, number, number];
  lowReadyRotation: readonly [number, number, number];
  breathX: number;
  breathY: number;
  recoilX?: number;
  recoilZ: number;
  recoilPitch: number;
  recoilYaw?: number;
  recoilRoll: number;
  muzzleDriftPitch?: number;
  muzzleDriftYaw?: number;
  sightMisalignPitch: number;
  sightMisalignYaw: number;
  sightMisalignRoll: number;
  lagYaw: number;
  lagPitch: number;
  camWorldPos: Readonly<THREE.Vector3>;
  camWorldQuat: Readonly<THREE.Quaternion>;
  shoulderAnchor: THREE.Object3D;
  weaponPivot: THREE.Object3D;
  reloadSpeedMult?: number;
  weaponRootPitchRad?: number;
  minWeaponPitchRad?: number;
  maxWeaponPitchRad?: number;
  lateralMotion?: number;
  opticParallaxStrength?: number;
}

interface PooledBrassCasing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  active: boolean;
}

interface PooledSmokePuff {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vel: THREE.Vector3;
  age: number;
  maxAge: number;
  active: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate-independent exponential vector damping (zero allocations) */
export function dampVec3(
  current: THREE.Vector3,
  target: Readonly<THREE.Vector3>,
  lambda: number,
  dt: number,
): THREE.Vector3 {
  const alpha = 1 - Math.exp(-Math.max(0.01, lambda) * Math.max(0, dt));
  return current.lerp(target as THREE.Vector3, alpha);
}

/** Frame-rate-independent exponential quaternion slerp (zero allocations) */
export function dampSlerp(
  current: THREE.Quaternion,
  target: Readonly<THREE.Quaternion>,
  lambda: number,
  dt: number,
): THREE.Quaternion {
  const alpha = 1 - Math.exp(-Math.max(0.01, lambda) * Math.max(0, dt));
  return current.slerp(target as THREE.Quaternion, alpha);
}

const INSPECT_DURATION_SEC = 3.2;
const SUPPRESSOR_TOGGLE_DURATION_SEC = 2.15;
const SUPPRESSOR_THREAD_TRAVEL_M = 0.032;
const BLOWBACK_BACK_SEC = 0.025; // ~25ms rearward blowback
const BLOWBACK_FWD_SEC = 0.045; // ~45ms forward return to battery
const BLOWBACK_TOTAL_SEC = BLOWBACK_BACK_SEC + BLOWBACK_FWD_SEC;

/**
 * Portable Mechanical Gun Animator & Pose-Graph Interpolator for the Bodycam SDK:
 *  - Articulated blowback (25ms rearward / 45ms forward), hammer/trigger drop, pump forend cycle,
 *    and visible empty slide/bolt lockback until fresh magazine is seated & racked
 *  - Pooled zero-GC brass casing ejection + ejection-port micro-smoke wisps
 *  - Physical detachable magazine lifecycle for Reloads & partial ~3.2cm pull for Mag-Check
 *  - Mathematically exact ADS alignment solved directly from `sightAnchor`
 *  - Frame-rate-independent damped pose-graph blending across all 10 weapon states
 *  - 3.2s 3-phase `I` Weapon Inspect sequence with ~0.12s instant combat interrupt
 *  - All mechanical audio cues routed through `IBodycamAudioSource.playWeaponCue()`
 */
export class WeaponAnimator {
  private readonly scene: THREE.Scene;
  private assembly: WeaponModelAssembly | null = null;
  private audio?: IBodycamAudioSource;
  private weightClass: 'pistol' | 'carbine' | 'heavy_rifle' = 'carbine';
  private eyeBoxLagX = 0;
  private eyeBoxLagY = 0;

  // Pose-graph damped state (in shoulderAnchor local space)
  private readonly dampedBasePos = new THREE.Vector3();
  private readonly dampedBaseQuat = new THREE.Quaternion();
  private poseInitialized = false;
  private activePoseState: WeaponPoseStateId = 'Idle';

  // Blends exposed for telemetry & CharacterAnimator coordination
  public adsBlend = 0;
  public cantBlend = 0;
  public pointAimBlend = 0;
  public sprintBlend = 0;
  public inspectBlend = 0;
  private reloadSpeedMult = 1.0;
  private equipTimer = 0;
  private equipDuration = 0.24;
  private interruptFastBlendTimer = 0;

  // ADS rustle sound state
  private wasAdsWanted = false;
  private adsRustleCooldown = 0;

  // Mechanical firing / blowback / empty lockback / pump / bolt-action / revolver state
  private blowbackTimer = -1;
  private hammerTimer = 0;
  private triggerTimer = 0;
  private pumpCycleTimer = -1;
  private isBoltLockedOpen = false;
  private manualBoltPull01 = 0;
  private magSeatImpulseY = 0;
  private magSeatImpulseVel = 0;

  private boltCycleTimer = -1;
  private boltCycleDuration = 0.85;
  private boltOpenCueFired = false;
  private boltPullCueFired = false;
  private boltPushCueFired = false;
  private boltLockCueFired = false;
  private boltEjectFired = false;
  private boltCycleSuppressed = false;
  private boltRightHandBlend = 0;
  private boltCycleOffsetZ = 0;

  private cylinderAngle = 0;
  private cylinderTargetAngle = 0;

  // Mechanical action state machine (RELOAD / MAG_CHECK / INSPECT / SUPPRESSOR_ATTACH / SUPPRESSOR_DETACH)
  private action: WeaponMechanicalAction = 'NONE';
  private actionTime = 0;
  private actionDuration = 1.0;
  private reloadCueOutFired = false;
  private reloadCueInFired = false;
  private reloadCueRackFired = false;
  private magCheckOutFired = false;
  private magCheckInFired = false;
  private magazineDetachedInHand = false;
  private magCheckPullM = 0;
  private inspectLeftHandSlideZ = 0;

  // Suppressor field twist-and-stow state
  private suppressorInHand = false;
  private suppressorPreActionVisible = true;
  private suppressorTwistPhase01 = 0;
  private suppressorCueMask = 0;
  private suppressorOnComplete: ((attached: boolean) => void) | null = null;

  // Pooled brass casings & ejection-port micro-smoke puffs (zero per-frame allocations)
  private readonly casingPool: PooledBrassCasing[] = [];
  private readonly smokePool: PooledSmokePuff[] = [];
  private readonly casingGeo: THREE.CylinderGeometry;
  private readonly casingMat: THREE.MeshStandardMaterial;
  private readonly smokeGeo: THREE.SphereGeometry;
  private casingPoolCursor = 0;
  private smokePoolCursor = 0;

  // Pre-allocated scratch buffers (100% zero-GC per frame)
  private readonly _targetPos = new THREE.Vector3();
  private readonly _targetQuat = new THREE.Quaternion();
  private readonly _hipPos = new THREE.Vector3();
  private readonly _hipQuat = new THREE.Quaternion();
  private readonly _adsPos = new THREE.Vector3();
  private readonly _adsQuat = new THREE.Quaternion();
  private readonly _cantPos = new THREE.Vector3();
  private readonly _cantQuat = new THREE.Quaternion();
  private readonly _pointAimPos = new THREE.Vector3();
  private readonly _pointAimQuat = new THREE.Quaternion();
  private readonly _sprintPos = new THREE.Vector3();
  private readonly _sprintQuat = new THREE.Quaternion();
  private readonly _vaultPos = new THREE.Vector3();
  private readonly _vaultQuat = new THREE.Quaternion();
  private readonly _actionPos = new THREE.Vector3();
  private readonly _actionQuat = new THREE.Quaternion();
  private readonly _equipPos = new THREE.Vector3();
  private readonly _equipQuat = new THREE.Quaternion();
  private readonly _addQuat = new THREE.Quaternion();
  private readonly _aimLeadQuat = new THREE.Quaternion();
  private readonly _ledCamQuat = new THREE.Quaternion();
  private readonly _shoulderWorldQuat = new THREE.Quaternion();
  private readonly _shoulderWorldQuatInv = new THREE.Quaternion();
  private readonly _tmpVecA = new THREE.Vector3();
  private readonly _tmpVecB = new THREE.Vector3();
  private readonly _recoilPivotLocal = new THREE.Vector3();
  private readonly _recoilRotQuat = new THREE.Quaternion();
  private readonly _tmpQuatA = new THREE.Quaternion();
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _cueOpts: BodycamWeaponCueOptions = {};

  constructor(scene: THREE.Scene, audio?: IBodycamAudioSource) {
    this.scene = scene;
    this.audio = audio;

    this.casingGeo = new THREE.CylinderGeometry(0.0046, 0.0048, 0.021, 6);
    this.casingMat = new THREE.MeshStandardMaterial({
      color: 0xd4ae4e,
      metalness: 0.88,
      roughness: 0.24,
    });
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.casingPool.push({
        mesh,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        age: 0,
        active: false,
      });
    }

    this.smokeGeo = new THREE.SphereGeometry(0.014, 7, 6);
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xc8ccd0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.smokeGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.layers.set(VIEWMODEL_LAYER);
      this.scene.add(mesh);
      this.smokePool.push({
        mesh,
        mat,
        vel: new THREE.Vector3(),
        age: 0,
        maxAge: 0.45,
        active: false,
      });
    }
  }

  public setAudio(audio: IBodycamAudioSource): void {
    this.audio = audio;
  }

  public setReloadSpeedMult(mult: number): void {
    this.reloadSpeedMult = THREE.MathUtils.clamp(mult, 0.35, 2.0);
  }

  public attachModel(
    assembly: WeaponModelAssembly | null,
    weightClass: 'pistol' | 'carbine' | 'heavy_rifle',
    triggerEquipBlend = true,
  ): void {
    this.restoreMagazineHome();
    if (this.isSuppressorActionActive()) {
      this.restoreSuppressorHome(this.suppressorPreActionVisible);
    }
    this.suppressorOnComplete = null;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.assembly = assembly;
    this.weightClass = weightClass;
    this.blowbackTimer = -1;
    this.hammerTimer = 0;
    this.triggerTimer = 0;
    this.pumpCycleTimer = -1;
    this.boltCycleTimer = -1;
    this.boltRightHandBlend = 0;
    this.boltCycleOffsetZ = 0;
    this.cylinderAngle = 0;
    this.cylinderTargetAngle = 0;
    this.manualBoltPull01 = 0;
    this.magCheckPullM = 0;
    this.inspectLeftHandSlideZ = 0;
    this.action = 'NONE';
    this.actionTime = 0;
    this.magazineDetachedInHand = false;
    if (triggerEquipBlend) {
      this.equipDuration = weightClass === 'pistol' ? 0.20 : weightClass === 'heavy_rifle' ? 0.32 : 0.26;
      this.equipTimer = this.equipDuration;
    } else {
      this.equipTimer = 0;
    }
  }

  /** Sync empty lockback visual when switching weapons or spawning with 0 rounds */
  public setAmmoState(ammoInMag: number, isFirearm: boolean): void {
    if (!isFirearm) {
      this.isBoltLockedOpen = false;
      return;
    }
    this.isBoltLockedOpen = ammoInMag <= 0;
  }

  public isBoltLocked(): boolean {
    return this.isBoltLockedOpen;
  }

  public getActiveAction(): WeaponMechanicalAction {
    return this.action;
  }

  public getActionProgress(): number {
    if (this.action === 'NONE') return 0;
    return THREE.MathUtils.clamp(this.actionTime / Math.max(0.01, this.actionDuration), 0, 1);
  }

  public getActivePoseState(): WeaponPoseStateId {
    return this.activePoseState;
  }

  public isInspecting(): boolean {
    return this.action === 'INSPECT';
  }

  public isReloading(): boolean {
    return this.action === 'RELOAD';
  }

  public isMagChecking(): boolean {
    return this.action === 'MAG_CHECK';
  }

  public isMagazineDetachedInHand(): boolean {
    return this.magazineDetachedInHand;
  }

  public getInspectLeftHandSlideZ(): number {
    return this.inspectLeftHandSlideZ;
  }

  public isBoltCycling(): boolean {
    return this.boltCycleTimer >= 0;
  }

  public getBoltRightHandBlend(): number {
    return this.boltRightHandBlend;
  }

  public getBoltCycleOffsetZ(): number {
    return this.boltCycleOffsetZ;
  }

  public isSuppressorActionActive(): boolean {
    return this.action === 'SUPPRESSOR_ATTACH' || this.action === 'SUPPRESSOR_DETACH';
  }

  public isSuppressorHeldInHand(): boolean {
    return this.suppressorInHand;
  }

  public getSuppressorTwistPhase01(): number {
    return this.suppressorTwistPhase01;
  }

  public getSuppressorSubPhase(): WeaponSuppressorSubPhase {
    if (this.action === 'SUPPRESSOR_DETACH') {
      const p = this.getActionProgress();
      if (p < 0.12) return 'TILT_WEAPON';
      if (p < 0.24) return 'REACH_MUZZLE';
      if (p < 0.64) return 'TWIST_THREAD';
      if (p < 0.84) return 'STOW_OR_CLEAR';
      return 'RETURN_GRIP';
    }
    if (this.action === 'SUPPRESSOR_ATTACH') {
      const p = this.getActionProgress();
      if (p < 0.12) return 'TILT_WEAPON';
      if (p < 0.32) return 'REACH_POUCH';
      if (p < 0.44) return 'REACH_MUZZLE';
      if (p < 0.84) return 'TWIST_THREAD';
      return 'RETURN_GRIP';
    }
    return 'NONE';
  }

  public getReloadSubPhase(): WeaponReloadSubPhase {
    if (this.action !== 'RELOAD') return 'NONE';
    const p = this.getActionProgress();
    if (p < 0.16) return 'REACH_MAG';
    if (p < 0.36) return 'PULL_MAG';
    if (p < 0.48) return 'SWAP_POUCH';
    if (p < 0.65) return 'INSERT_MAG';
    if (p < 0.86) return 'RACK_BOLT';
    return 'RETURN';
  }

  public emitWeaponCue(
    cue: BodycamWeaponAudioCue,
    intensity = 1.0,
    pos?: Readonly<THREE.Vector3>,
    suppressed?: boolean,
  ): void {
    this.emitCue(cue, intensity, pos, suppressed);
  }

  private emitCue(
    cue: BodycamWeaponAudioCue,
    intensity = 1.0,
    pos?: Readonly<THREE.Vector3>,
    suppressed?: boolean,
  ): void {
    if (!this.audio?.playWeaponCue) return;
    this._cueOpts.weightClass = this.weightClass;
    this._cueOpts.intensity = intensity;
    this._cueOpts.position = pos;
    this._cueOpts.suppressed = suppressed;
    this.audio.playWeaponCue(cue, this._cueOpts);
  }

  public triggerFire(
    suppressed: boolean,
    remainingAmmoAfterShot?: number,
    opts?: WeaponFireAnimOptions,
  ): void {
    if (this.action === 'INSPECT' || this.action === 'MAG_CHECK') {
      this.interruptInspect();
    }
    this.hammerTimer = 0.085;
    this.triggerTimer = 0.09;

    const isBolt = Boolean(opts?.cycleBolt && this.assembly?.boltHandlePivot);
    const isRevolver = Boolean(opts?.isRevolver || this.assembly?.cylinderPivot);

    if (isBolt) {
      this.blowbackTimer = -1;
      this.boltCycleTimer = 0;
      this.boltCycleDuration = Math.max(0.55, opts?.boltDurationSec ?? 0.85);
      this.boltOpenCueFired = false;
      this.boltPullCueFired = false;
      this.boltPushCueFired = false;
      this.boltLockCueFired = false;
      this.boltEjectFired = false;
      this.boltCycleSuppressed = suppressed;
      this.isBoltLockedOpen = false;
      return;
    }

    if (isRevolver) {
      this.blowbackTimer = -1;
      const chambers = Math.max(1, this.assembly?.revolverChambers ?? 6);
      this.cylinderTargetAngle += (Math.PI * 2) / chambers;
      this.isBoltLockedOpen = false;
      return;
    }

    this.blowbackTimer = 0;
    if (this.assembly?.pumpForend && opts?.cyclePump !== false) {
      this.pumpCycleTimer = 0;
    }
    if (remainingAmmoAfterShot !== undefined) {
      this.isBoltLockedOpen = remainingAmmoAfterShot <= 0;
    }
    this.spawnCasingAndSmoke(suppressed);
  }

  public triggerDryFire(): void {
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.hammerTimer = 0.075;
    this.triggerTimer = 0.08;
    this.emitCue('dryfire', 1.0);
  }

  public triggerReload(durationSec: number): void {
    if (this.isSuppressorActionActive()) return;
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.restoreMagazineHome();
    this.action = 'RELOAD';
    this.actionTime = 0;
    this.actionDuration = Math.max(0.85, durationSec);
    this.reloadCueOutFired = false;
    this.reloadCueInFired = false;
    this.reloadCueRackFired = false;
    this.magazineDetachedInHand = false;
  }

  public triggerMagCheck(durationSec: number): void {
    if (this.action === 'RELOAD' || this.isSuppressorActionActive()) return;
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.restoreMagazineHome();
    this.action = 'MAG_CHECK';
    this.actionTime = 0;
    this.actionDuration = Math.max(0.85, durationSec);
    this.magCheckOutFired = false;
    this.magCheckInFired = false;
    this.magCheckPullM = 0;
  }

  /** Trigger blocking ~2.15s realistic field suppressor twist-and-stow sequence (`G` key) */
  public triggerSuppressorToggle(
    attach: boolean,
    onComplete?: (attached: boolean) => void,
    durationSec = SUPPRESSOR_TOGGLE_DURATION_SEC,
  ): boolean {
    if (!this.assembly?.suppressor) return false;
    if (
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.isSuppressorActionActive() ||
      this.boltCycleTimer >= 0
    ) {
      return false;
    }
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.restoreMagazineHome();
    this.suppressorPreActionVisible = this.assembly.suppressor.visible;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.suppressorOnComplete = onComplete ?? null;
    this.action = attach ? 'SUPPRESSOR_ATTACH' : 'SUPPRESSOR_DETACH';
    this.actionTime = 0;
    this.actionDuration = Math.max(1.4, durationSec);
    this.emitCue('ads_rustle', 0.78);
    return true;
  }

  /** Trigger fluid ~3.2s 3-phase Weapon Inspect (`I` key) */
  public triggerInspect(): boolean {
    if (
      !this.assembly ||
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.isSuppressorActionActive()
    ) {
      return false;
    }
    if (this.action === 'INSPECT') {
      this.interruptInspect();
      return false;
    }
    this.action = 'INSPECT';
    this.actionTime = 0;
    this.actionDuration = INSPECT_DURATION_SEC;
    this.inspectLeftHandSlideZ = 0;
    this.emitCue('ads_rustle', 0.72);
    return true;
  }

  /** Instant combat interrupt (~0.12s crisp damped blend back to combat readiness) */
  public interruptInspect(): void {
    if (this.action === 'INSPECT' || this.action === 'MAG_CHECK') {
      this.restoreMagazineHome();
      this.action = 'NONE';
      this.actionTime = 0;
      this.magCheckPullM = 0;
      this.inspectLeftHandSlideZ = 0;
      this.interruptFastBlendTimer = 0.14;
    }
  }

  public cancelAction(): void {
    this.restoreMagazineHome();
    if (this.isSuppressorActionActive()) {
      this.restoreSuppressorHome(this.suppressorPreActionVisible);
    }
    this.suppressorOnComplete = null;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.action = 'NONE';
    this.actionTime = 0;
    this.manualBoltPull01 = 0;
    this.magCheckPullM = 0;
    this.inspectLeftHandSlideZ = 0;
    this.magazineDetachedInHand = false;
    this.interruptFastBlendTimer = 0.14;
  }

  /** Safely returns the physical suppressor mesh back to muzzleMountSocket with clean thread home transform */
  public restoreSuppressorHome(visibleOverride?: boolean): void {
    this.suppressorInHand = false;
    const supp = this.assembly?.suppressor;
    if (!supp || !this.assembly) return;
    if (supp.parent !== this.assembly.muzzleMountSocket) {
      this.assembly.muzzleMountSocket.add(supp);
    }
    const homeZ = typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;
    supp.position.set(0, 0, homeZ);
    supp.rotation.set(0, 0, 0);
    supp.scale.set(1, 1, 1);
    if (visibleOverride !== undefined) {
      supp.visible = visibleOverride;
    }
  }

  /**
   * Called by CharacterAnimator to physically parent `assembly.suppressor` into `handL`
   * while stowing to / retrieving from the chest pouch, and re-parent to `muzzleMountSocket` for threading.
   */
  public syncPhysicalSuppressorParent(leftHandRoot: THREE.Object3D): void {
    const supp = this.assembly?.suppressor;
    if (!supp || !this.assembly) return;

    if (this.isSuppressorActionActive() && this.suppressorInHand) {
      if (supp.parent !== leftHandRoot) {
        leftHandRoot.add(supp);
        // Grip suppressor cylinder lengthwise in the left palm
        supp.position.set(0.008, -0.024, -0.048);
        supp.rotation.set(Math.PI * 0.46, 0.08, -Math.PI * 0.35);
      }
      const p = this.getActionProgress();
      if (this.action === 'SUPPRESSOR_DETACH') {
        supp.visible = p < 0.80;
      } else {
        supp.visible = p >= 0.21;
      }
    } else if (supp.parent !== this.assembly.muzzleMountSocket) {
      this.assembly.muzzleMountSocket.add(supp);
      const homeZ = typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;
      supp.position.set(0, 0, homeZ);
      supp.rotation.set(0, 0, 0);
      supp.scale.set(1, 1, 1);
    }
  }

  /** Safely returns the physical magazine mesh back to its seated home transform on the weapon */
  public restoreMagazineHome(): void {
    this.magazineDetachedInHand = false;
    const mag = this.assembly?.magazine;
    if (!mag || !this.assembly) return;
    if (mag.parent !== this.assembly.group) {
      this.assembly.group.add(mag);
    }
    mag.visible = true;
    mag.position.copy(this.assembly.magazineHomePos);
    mag.quaternion.copy(this.assembly.magazineHomeQuat);
    mag.scale.set(1, 1, 1);
  }

  /**
   * Called by CharacterAnimator to physically parent `assembly.magazine` into `handL`
   * during the pull/swap/insert portion of a Reload, and cleanly re-seat it back on `mag_in`.
   */
  public syncPhysicalMagazineParent(leftHandRoot: THREE.Object3D): void {
    const mag = this.assembly?.magazine;
    if (!mag || !this.assembly) return;

    if (this.action === 'RELOAD' && this.magazineDetachedInHand) {
      if (mag.parent !== leftHandRoot) {
        leftHandRoot.add(mag);
        // Seat magazine cleanly inside the left gloved palm (-Z is finger forward, -Y is palm face)
        mag.position.set(0.008, -0.028, -0.044);
        mag.rotation.set(Math.PI * 0.45, 0.15, -Math.PI * 0.42);
      }
      // Briefly hide spent mag right inside the chest rig pouch during the split-second mag swap
      const p = this.getActionProgress();
      mag.visible = !(p >= 0.37 && p <= 0.46);
    } else {
      if (mag.parent !== this.assembly.group) {
        this.assembly.group.add(mag);
        mag.quaternion.copy(this.assembly.magazineHomeQuat);
        mag.scale.set(1, 1, 1);
      }
      mag.visible = true;
      // Apply partial ~3.2cm extraction offset along mag ejection axis during MAG_CHECK
      mag.position
        .copy(this.assembly.magazineHomePos)
        .addScaledVector(this.assembly.magazineEjectAxis, this.magCheckPullM);
    }
  }

  private spawnCasingAndSmoke(suppressed: boolean): void {
    if (!this.assembly) return;
    this.assembly.ejectionPortSocket.updateWorldMatrix(true, false);
    this.assembly.ejectionPortSocket.getWorldPosition(this._tmpVecA);
    this.assembly.ejectionPortSocket.getWorldQuaternion(this._tmpQuatA);

    // 1. Pooled spinning brass casing
    const casing = this.casingPool[this.casingPoolCursor];
    this.casingPoolCursor = (this.casingPoolCursor + 1) % this.casingPool.length;
    casing.mesh.position.copy(this._tmpVecA);
    casing.mesh.quaternion.copy(this._tmpQuatA);
    casing.mesh.visible = true;
    casing.vel
      .set(1.55 + Math.random() * 0.85, 1.25 + Math.random() * 0.65, 0.35 + Math.random() * 0.45)
      .applyQuaternion(this._tmpQuatA);
    casing.angVel.set(18 + Math.random() * 14, 24 + Math.random() * 16, 14 + Math.random() * 12);
    casing.age = 0;
    casing.active = true;

    // 2. Pooled ejection-port micro-smoke wisps (2 subtle wisps per shot)
    const puffCount = suppressed ? 2 : 1;
    for (let i = 0; i < puffCount; i++) {
      const puff = this.smokePool[this.smokePoolCursor];
      this.smokePoolCursor = (this.smokePoolCursor + 1) % this.smokePool.length;
      puff.mesh.position.copy(this._tmpVecA);
      puff.mesh.scale.setScalar(0.55 + Math.random() * 0.35);
      puff.vel
        .set(
          (0.18 + Math.random() * 0.16) * (i === 0 ? 1 : 0.6),
          0.26 + Math.random() * 0.18,
          (Math.random() - 0.5) * 0.12,
        )
        .applyQuaternion(this._tmpQuatA);
      puff.age = 0;
      puff.maxAge = 0.34 + Math.random() * 0.22;
      puff.mat.opacity = suppressed ? 0.34 : 0.24;
      puff.mesh.visible = true;
      puff.active = true;
    }
  }

  private stepMechanicalParts(dt: number, reloadSpeedMult: number): void {
    this.manualBoltPull01 = 0;
    this.magCheckPullM = 0;
    this.inspectLeftHandSlideZ = 0;

    // 1. Advance active weapon action (RELOAD / MAG_CHECK / INSPECT) + synced audio beats
    if (this.action !== 'NONE') {
      const speed = this.action === 'RELOAD' ? Math.max(0.5, reloadSpeedMult) : 1.0;
      this.actionTime += dt * speed;
      const p = this.getActionProgress();

      if (this.action === 'RELOAD') {
        if (!this.reloadCueOutFired && p >= 0.16) {
          this.reloadCueOutFired = true;
          this.magazineDetachedInHand = true;
          this.emitCue('mag_out', 1.0);
        }
        if (!this.reloadCueInFired && p >= 0.63) {
          this.reloadCueInFired = true;
          this.magazineDetachedInHand = false;
          this.restoreMagazineHome();
          this.magSeatImpulseVel += 0.24;
          this.emitCue('mag_in', 1.05);
        }
        if (!this.reloadCueRackFired && p >= 0.72) {
          this.reloadCueRackFired = true;
          this.emitCue('rack', 1.0);
        }
        // Physical charging-handle / slide rack movement (p: 0.70 -> 0.86)
        if (p >= 0.70 && p <= 0.86) {
          const r = (p - 0.70) / 0.16;
          if (r < 0.55) {
            this.manualBoltPull01 = smoothstep(0.0, 0.55, r);
          } else {
            // Release empty slide/bolt lockback cleanly as carrier slams forward into battery!
            this.isBoltLockedOpen = false;
            this.manualBoltPull01 = 1 - smoothstep(0.55, 1.0, r);
          }
        }
        if (p >= 1.0) {
          this.isBoltLockedOpen = false;
          this.restoreMagazineHome();
          this.action = 'NONE';
          this.actionTime = 0;
        }
      } else if (this.action === 'MAG_CHECK') {
        // Partially extract magazine ~3.2cm (p: 0.16 -> 0.76) then seat cleanly back
        if (!this.magCheckOutFired && p >= 0.16) {
          this.magCheckOutFired = true;
          this.emitCue('mag_out', 0.55);
        }
        if (!this.magCheckInFired && p >= 0.74) {
          this.magCheckInFired = true;
          this.magSeatImpulseVel += 0.14;
          this.emitCue('mag_in', 0.65);
        }
        const pullIn = smoothstep(0.15, 0.34, p);
        const pushBack = 1 - smoothstep(0.64, 0.79, p);
        this.magCheckPullM = pullIn * pushBack * 0.032;
        if (p >= 1.0) {
          this.magCheckPullM = 0;
          this.action = 'NONE';
          this.actionTime = 0;
        }
      } else if (this.action === 'INSPECT') {
        // Phase 2 subtle handL slide along handguard while examining left receiver
        const phase2Env = smoothstep(0.36, 0.48, p) * (1 - smoothstep(0.72, 0.84, p));
        this.inspectLeftHandSlideZ = -0.024 * phase2Env;
        if (p >= 1.0) {
          this.inspectLeftHandSlideZ = 0;
          this.action = 'NONE';
          this.actionTime = 0;
        }
      } else if (this.action === 'SUPPRESSOR_DETACH' || this.action === 'SUPPRESSOR_ATTACH') {
        const isAttach = this.action === 'SUPPRESSOR_ATTACH';
        const supp = this.assembly?.suppressor;
        const homeZ = supp && typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;

        if (!isAttach) {
          // DETACH: 0.00-0.12 TILT -> 0.12-0.24 REACH_MUZZLE -> 0.24-0.64 TWIST_THREAD -> 0.64-0.84 STOW -> 0.84-1.00 RETURN
          if (p >= 0.25 && (this.suppressorCueMask & 1) === 0) {
            this.suppressorCueMask |= 1;
            this.emitCue('suppressor_lock', 0.85);
          }
          if (p >= 0.31 && (this.suppressorCueMask & 2) === 0) {
            this.suppressorCueMask |= 2;
            this.emitCue('suppressor_twist', 0.95);
          }
          if (p >= 0.43 && (this.suppressorCueMask & 4) === 0) {
            this.suppressorCueMask |= 4;
            this.emitCue('suppressor_twist', 0.9);
          }
          if (p >= 0.55 && (this.suppressorCueMask & 8) === 0) {
            this.suppressorCueMask |= 8;
            this.emitCue('suppressor_twist', 0.82);
          }
          if (p >= 0.78 && (this.suppressorCueMask & 16) === 0) {
            this.suppressorCueMask |= 16;
            this.emitCue('ads_rustle', 0.75);
          }

          if (p < 0.64) {
            this.suppressorInHand = false;
            const twistT = THREE.MathUtils.clamp((p - 0.24) / 0.40, 0, 1);
            this.suppressorTwistPhase01 = twistT;
            if (supp && supp.parent === this.assembly?.muzzleMountSocket) {
              supp.visible = true;
              supp.position.set(0, 0, homeZ - twistT * SUPPRESSOR_THREAD_TRAVEL_M);
              supp.rotation.set(0, 0, -twistT * Math.PI * 2 * 3.5);
            }
          } else {
            this.suppressorInHand = p < 0.84;
            this.suppressorTwistPhase01 = 1;
            if (supp && !this.suppressorInHand) {
              this.restoreSuppressorHome(false);
            }
          }
        } else {
          // ATTACH: 0.00-0.12 TILT -> 0.12-0.32 REACH_POUCH -> 0.32-0.44 REACH_MUZZLE -> 0.44-0.84 TWIST_THREAD -> 0.84-1.00 RETURN
          if (p >= 0.22 && (this.suppressorCueMask & 1) === 0) {
            this.suppressorCueMask |= 1;
            this.emitCue('ads_rustle', 0.78);
          }
          if (p >= 0.48 && (this.suppressorCueMask & 2) === 0) {
            this.suppressorCueMask |= 2;
            this.emitCue('suppressor_twist', 0.88);
          }
          if (p >= 0.60 && (this.suppressorCueMask & 4) === 0) {
            this.suppressorCueMask |= 4;
            this.emitCue('suppressor_twist', 0.94);
          }
          if (p >= 0.72 && (this.suppressorCueMask & 8) === 0) {
            this.suppressorCueMask |= 8;
            this.emitCue('suppressor_twist', 1.0);
          }
          if (p >= 0.82 && (this.suppressorCueMask & 16) === 0) {
            this.suppressorCueMask |= 16;
            this.emitCue('suppressor_lock', 1.05);
          }

          if (p < 0.44) {
            this.suppressorInHand = p >= 0.21;
            this.suppressorTwistPhase01 = 0;
          } else {
            this.suppressorInHand = false;
            const twistT = THREE.MathUtils.clamp((p - 0.44) / 0.40, 0, 1);
            this.suppressorTwistPhase01 = twistT;
            if (supp) {
              if (supp.parent !== this.assembly?.muzzleMountSocket) {
                this.assembly?.muzzleMountSocket.add(supp);
              }
              supp.visible = true;
              supp.position.set(0, 0, homeZ - (1 - twistT) * SUPPRESSOR_THREAD_TRAVEL_M);
              supp.rotation.set(0, 0, twistT * Math.PI * 2 * 3.5);
            }
          }
        }

        if (p >= 1.0) {
          const cb = this.suppressorOnComplete;
          this.suppressorOnComplete = null;
          this.suppressorInHand = false;
          this.suppressorTwistPhase01 = 0;
          this.suppressorCueMask = 0;
          this.restoreSuppressorHome(isAttach);
          this.action = 'NONE';
          this.actionTime = 0;
          cb?.(isAttach);
        }
      }
    }

    // 2. Mag-seat tactile spring impulse
    const kSeat = 320;
    const dSeat = 26;
    const aSeat = -kSeat * this.magSeatImpulseY - dSeat * this.magSeatImpulseVel;
    this.magSeatImpulseVel += aSeat * dt;
    this.magSeatImpulseY += this.magSeatImpulseVel * dt;

    // 3. Articulated blowback cycle (25ms rearward / 45ms forward) + empty slide/bolt lockback
    let blowback01 = 0;
    if (this.blowbackTimer >= 0) {
      this.blowbackTimer += dt;
      if (this.blowbackTimer < BLOWBACK_BACK_SEC) {
        blowback01 = this.blowbackTimer / BLOWBACK_BACK_SEC;
      } else if (this.blowbackTimer < BLOWBACK_TOTAL_SEC) {
        const ret = (this.blowbackTimer - BLOWBACK_BACK_SEC) / BLOWBACK_FWD_SEC;
        blowback01 = this.isBoltLockedOpen ? THREE.MathUtils.lerp(1.0, 0.92, ret) : 1.0 - ret;
      } else {
        this.blowbackTimer = -1;
      }
    }
    const locked01 = this.isBoltLockedOpen ? 0.92 : 0;

    // 4. Shotgun pump-action forend + bolt cycle (after shot)
    let pump01 = 0;
    if (this.pumpCycleTimer >= 0) {
      this.pumpCycleTimer += dt;
      const delay = 0.08;
      const dur = 0.28;
      if (this.pumpCycleTimer > delay) {
        const tp = (this.pumpCycleTimer - delay) / dur;
        if (tp >= 1) {
          this.pumpCycleTimer = -1;
        } else {
          pump01 = Math.sin(tp * Math.PI);
          if (tp > 0.12 && tp < 0.18 && this.pumpCycleTimer - dt <= delay + dur * 0.12) {
            this.emitCue('rack', 0.85);
          }
        }
      }
    }

    // 5. Bolt-Action Manual Cycling Sequence (Recoil settle -> Bolt Open -> Pull & Eject -> Push -> Lock)
    let boltCycle01 = 0;
    let boltHandleRotZ = 0;
    this.boltRightHandBlend = 0;
    this.boltCycleOffsetZ = 0;
    if (this.boltCycleTimer >= 0) {
      this.boltCycleTimer += dt;
      const delay = 0.08;
      const activeDur = Math.max(0.45, this.boltCycleDuration - delay);
      if (this.boltCycleTimer > delay) {
        const tp = (this.boltCycleTimer - delay) / activeDur;
        if (tp >= 1.0) {
          this.boltCycleTimer = -1;
        } else {
          this.boltRightHandBlend = smoothstep(0.0, 0.14, tp) * (1 - smoothstep(0.84, 1.0, tp));
          if (tp < 0.16) {
            boltHandleRotZ = smoothstep(0.0, 0.16, tp) * -1.05;
            if (!this.boltOpenCueFired && tp >= 0.04) {
              this.boltOpenCueFired = true;
              this.emitCue('bolt_open', 0.95);
            }
          } else if (tp < 0.48) {
            boltHandleRotZ = -1.05;
            boltCycle01 = smoothstep(0.16, 0.48, tp);
            if (!this.boltPullCueFired && tp >= 0.18) {
              this.boltPullCueFired = true;
              this.emitCue('bolt_pull', 1.0);
            }
            if (!this.boltEjectFired && tp >= 0.42) {
              this.boltEjectFired = true;
              this.spawnCasingAndSmoke(this.boltCycleSuppressed);
            }
          } else if (tp < 0.80) {
            boltHandleRotZ = -1.05;
            boltCycle01 = 1 - smoothstep(0.48, 0.80, tp);
            if (!this.boltPushCueFired && tp >= 0.52) {
              this.boltPushCueFired = true;
              this.emitCue('bolt_push', 0.95);
            }
          } else {
            boltHandleRotZ = (1 - smoothstep(0.80, 1.0, tp)) * -1.05;
            if (!this.boltLockCueFired && tp >= 0.84) {
              this.boltLockCueFired = true;
              this.emitCue('bolt_lock', 1.0);
            }
          }
        }
      }
    }

    // 6. Revolver 6-Shot Cylinder Indexing
    this.cylinderAngle = THREE.MathUtils.damp(this.cylinderAngle, this.cylinderTargetAngle, 28, dt);

    const asm = this.assembly;
    if (asm) {
      this.boltCycleOffsetZ = boltCycle01 * asm.slideTravelZ;
      const finalBolt01 = Math.max(blowback01, locked01, this.manualBoltPull01, pump01 * 0.95, boltCycle01);
      if (asm.slideOrBolt) {
        asm.slideOrBolt.position.z = asm.slideBaseZ + finalBolt01 * asm.slideTravelZ;
      }
      if (asm.chargingHandle) {
        // Non-reciprocating charging handles (AR-15 / AR-10 / HK416 / MCX) stay locked forward
        // during blowback and bolt lockback, pulling rearward only on manual reload rack.
        asm.chargingHandle.position.z =
          asm.chargingHandleBaseZ + this.manualBoltPull01 * asm.slideTravelZ;
      }
      if (asm.boltHandlePivot) {
        asm.boltHandlePivot.rotation.z = boltHandleRotZ;
      }
      if (asm.barrelBreakGroup) {
        // Top-break revolver hinge (Webley Mk VI): tilts barrel, rib, sights & cylinder downward as one unit during RELOAD
        let break01 = 0;
        if (this.action === 'RELOAD') {
          const p = this.getActionProgress();
          const openEnv = smoothstep(0.10, 0.24, p);
          const closeEnv = 1 - smoothstep(0.68, 0.82, p);
          break01 = openEnv * closeEnv;
        }
        asm.barrelBreakGroup.rotation.x = -break01 * 0.82;
      }
      if (asm.cylinderPivot) {
        asm.cylinderPivot.rotation.z = this.cylinderAngle;
      }
      if (asm.pumpForend) {
        asm.pumpForend.position.z = asm.pumpBaseZ + pump01 * 0.078;
      }
      if (asm.hammer) {
        if (this.hammerTimer > 0) this.hammerTimer = Math.max(0, this.hammerTimer - dt);
        const hSnap = Math.sin((this.hammerTimer / 0.085) * Math.PI);
        asm.hammer.rotation.x = asm.hammerBaseRotX - hSnap * 0.72 + (this.isBoltLockedOpen ? 0.35 : 0);
      }
      if (asm.trigger) {
        if (this.triggerTimer > 0) this.triggerTimer = Math.max(0, this.triggerTimer - dt);
        const tPull = this.triggerTimer > 0 ? Math.sin((this.triggerTimer / 0.09) * Math.PI) : 0;
        asm.trigger.rotation.x = asm.triggerBaseRotX + tPull * 0.42;
      }
      // Keep magazine synced during MAG_CHECK even if CharacterAnimator isn't overriding parent
      if (asm.magazine && !this.magazineDetachedInHand && asm.magazine.parent === asm.group) {
        asm.magazine.position
          .copy(asm.magazineHomePos)
          .addScaledVector(asm.magazineEjectAxis, this.magCheckPullM);
      }
    }

    // 5. Step pooled brass casings & ejection-port micro-smoke
    for (let i = 0; i < this.casingPool.length; i++) {
      const c = this.casingPool[i];
      if (!c.active) continue;
      c.age += dt;
      c.vel.y -= 9.81 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.angVel.x * dt;
      c.mesh.rotation.y += c.angVel.y * dt;
      c.mesh.rotation.z += c.angVel.z * dt;
      if (c.age > 2.6) {
        c.active = false;
        c.mesh.visible = false;
      }
    }

    for (let i = 0; i < this.smokePool.length; i++) {
      const s = this.smokePool[i];
      if (!s.active) continue;
      s.age += dt;
      const t = s.age / s.maxAge;
      if (t >= 1) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(1 - Math.min(0.9, dt * 3.5));
      s.mesh.scale.setScalar(0.55 + t * 2.2);
      s.mat.opacity = (1 - t) * (1 - t) * 0.28;
    }
  }

  /**
   * Evaluates the full 10-state Weapon Pose Graph with mathematically exact `sightAnchor` ADS solving
   * and frame-rate-independent `dampVec3` / `dampSlerp` smoothing.
   */
  public updatePoseGraph(input: WeaponPoseUpdateInput): void {
    const dt = Math.min(Math.max(input.dt, 0.0001), 0.05);

    // Instant combat interrupts during Inspect (ADS, Canted ADS, Point Aim, Sprint, Vault)
    if (
      this.action === 'INSPECT' &&
      (input.isAds || input.isCanted || input.isPointAim || input.isSprinting || input.vaultRetentionBlend > 0.05)
    ) {
      this.interruptInspect();
    }

    if (this.equipTimer > 0) {
      this.equipTimer = Math.max(0, this.equipTimer - dt);
    }
    if (this.interruptFastBlendTimer > 0) {
      this.interruptFastBlendTimer = Math.max(0, this.interruptFastBlendTimer - dt);
    }
    if (this.adsRustleCooldown > 0) {
      this.adsRustleCooldown = Math.max(0, this.adsRustleCooldown - dt);
    }

    this.stepMechanicalParts(dt, input.reloadSpeedMult ?? this.reloadSpeedMult);

    // 1. State blend weights (Primary ADS, Canted Optic ADS, Tactical Point Aim, Sprint, Inspect)
    const blockAim =
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.action === 'INSPECT' ||
      this.action === 'SUPPRESSOR_ATTACH' ||
      this.action === 'SUPPRESSOR_DETACH' ||
      input.vaultRetentionBlend > 0.12;
    const hasCantedOptic = Boolean(this.assembly?.hasCantedOptic);
    const allowCant =
      !blockAim &&
      input.isCanted &&
      hasCantedOptic &&
      input.isFirearm &&
      !input.isSprinting &&
      input.pullbackRatio < 0.45;
    const allowPointAim =
      !blockAim &&
      Boolean(input.isPointAim) &&
      input.isFirearm &&
      !input.isSprinting &&
      input.pullbackRatio < 0.45 &&
      !allowCant;
    const allowAds = !blockAim && input.isAds && input.isFirearm && !allowCant && !allowPointAim;
    const wantsAnyAim = allowAds || allowCant || allowPointAim;

    // Trigger subtle ADS cheek-weld/sleeve rustle cue on state edge
    if (wantsAnyAim !== this.wasAdsWanted && input.isFirearm) {
      if (this.adsRustleCooldown <= 0) {
        this.emitCue('ads_rustle', wantsAnyAim ? 0.9 : 0.65);
        this.adsRustleCooldown = 0.22;
      }
      this.wasAdsWanted = wantsAnyAim;
    } else if (!input.isFirearm) {
      this.wasAdsWanted = false;
    }

    const massRate = THREE.MathUtils.clamp(15.5 / Math.sqrt(Math.max(0.5, input.massHandlingFactor)), 9.5, 17.5);
    const speedScale = Math.max(0.3, input.adsSpeedMult);
    this.adsBlend = THREE.MathUtils.damp(
      this.adsBlend,
      allowAds ? 1 : 0,
      massRate * speedScale,
      dt,
    );
    this.cantBlend = THREE.MathUtils.damp(
      this.cantBlend,
      allowCant ? 1 : 0,
      massRate * 1.08 * speedScale,
      dt,
    );
    this.pointAimBlend = THREE.MathUtils.damp(
      this.pointAimBlend,
      allowPointAim ? 1 : 0,
      massRate * 1.15 * speedScale,
      dt,
    );
    this.sprintBlend = THREE.MathUtils.damp(
      this.sprintBlend,
      input.isSprinting && this.action !== 'RELOAD' ? 1 : 0,
      11.5,
      dt,
    );
    this.inspectBlend = THREE.MathUtils.damp(
      this.inspectBlend,
      this.action === 'INSPECT' ? 1 : 0,
      this.interruptFastBlendTimer > 0 ? 26 : 11,
      dt,
    );

    // 2. Compute `shoulderAnchor` world-to-local rotation so ADS & Cant solve in exact camera space
    input.shoulderAnchor.updateWorldMatrix(true, false);
    input.shoulderAnchor.getWorldQuaternion(this._shoulderWorldQuat);
    this._shoulderWorldQuatInv.copy(this._shoulderWorldQuat).invert();

    const rootPitchRad = input.weaponRootPitchRad ?? 0;
    const minWepRad = input.minWeaponPitchRad ?? THREE.MathUtils.degToRad(-50);
    const maxWepRad = input.maxWeaponPitchRad ?? THREE.MathUtils.degToRad(68);
    const baseTotalPitch = rootPitchRad + input.aimPitch;

    // --- IDLE (Hip/Ready) ---
    this._hipPos.set(input.hipOffset[0], input.hipOffset[1], input.hipOffset[2]);
    const clampedHipPitch = THREE.MathUtils.clamp(
      rootPitchRad + input.aimPitch + input.lagPitch * 0.36,
      minWepRad,
      maxWepRad,
    ) - rootPitchRad;
    this._tmpEuler.set(
      clampedHipPitch,
      input.aimYaw + input.lagYaw * 0.36,
      input.lagYaw * 0.46,
      'YXZ',
    );
    this._hipQuat.setFromEuler(this._tmpEuler);

    // Compute true 1:1 led aim orientation in world space (`camWorldQuat` rotated by instant free-aim lead).
    // Applied across Primary ADS, Canted Optic ADS, and Point Aim so all aim stances share authentic
    // bodycam weapon-lead feel while the chest camera lags smoothly behind and recenters onto the aim point.
    const clampedAimLeadPitch =
      THREE.MathUtils.clamp(rootPitchRad + input.aimPitch, minWepRad, maxWepRad) - rootPitchRad;
    this._tmpEuler.set(clampedAimLeadPitch, input.aimYaw, 0, 'YXZ');
    this._aimLeadQuat.setFromEuler(this._tmpEuler);
    this._ledCamQuat.copy(input.camWorldQuat as THREE.Quaternion).multiply(this._aimLeadQuat);

    // --- MATHEMATICALLY EXACT ADS ALIGNMENT (`sightAnchor` SOLVER + BODYCAM FREE-AIM LEAD) ---
    // Goal: place `sightAnchor` along the led sightline at `-eyeRelief` with subtle rear cheek-pivot
    // parallax (`0.025m` magnified scope / `0.06m` iron & reflex) that settles cleanly to dead-center.
    const eyeRelief = this.assembly ? this.assembly.adsEyeReliefM : 0.23;
    const sightLocal = this.assembly ? this.assembly.sightAnchor.position : this._tmpVecB.set(0, 0.055, -0.05);
    const adsRearPivot = this.assembly?.scopeLensMaterial ? 0.025 : 0.06;
    this._tmpVecA
      .set(-sightLocal.x, -sightLocal.y, -eyeRelief - sightLocal.z - adsRearPivot)
      .applyQuaternion(this._ledCamQuat);
    this._tmpVecB.set(0, 0, adsRearPivot).applyQuaternion(input.camWorldQuat as THREE.Quaternion);
    this._tmpVecA.add(this._tmpVecB).add(input.camWorldPos as THREE.Vector3);
    input.shoulderAnchor.worldToLocal(this._tmpVecA);
    this._adsPos.copy(this._tmpVecA);
    this._adsQuat.copy(this._shoulderWorldQuatInv).multiply(this._ledCamQuat);

    // --- CANTED OPTIC ADS (EXACT MOUNTED CANTED SIGHT ALIGNMENT + BODYCAM FREE-AIM LEAD) ---
    if (hasCantedOptic && this.assembly) {
      const cantRelief = this.assembly.cantEyeReliefM || 0.21;
      const cantRearPivot = 0.08;
      this._addQuat.copy(this.assembly.cantSightAnchor.quaternion).invert();
      this._tmpQuatA.copy(this._ledCamQuat).multiply(this._addQuat);
      this._cantQuat.copy(this._shoulderWorldQuatInv).multiply(this._tmpQuatA);

      this._tmpVecA
        .set(0, 0, -cantRelief - cantRearPivot)
        .applyQuaternion(this._ledCamQuat);
      this._tmpVecB.set(0, 0, cantRearPivot).applyQuaternion(input.camWorldQuat as THREE.Quaternion);
      this._tmpVecA.add(this._tmpVecB).add(input.camWorldPos as THREE.Vector3);
      this._tmpVecB.copy(this.assembly.cantSightAnchor.position).applyQuaternion(this._tmpQuatA);
      this._tmpVecA.sub(this._tmpVecB);
      input.shoulderAnchor.worldToLocal(this._tmpVecA);
      this._cantPos.copy(this._tmpVecA);
    } else {
      this._cantPos.copy(this._adsPos);
      this._cantQuat.copy(this._adsQuat);
    }

    // --- TACTICAL POINT AIM / TAC-STANCE (BORE-CENTERED + BODYCAM FREE-AIM LEAD) ---
    // Anchored to the firearm's bore axis just beneath center so the top rail & optic lean left out
    // of the sightline while pivoting agilely from the shoulder during mouse flicks.
    const ptOff = input.pointAimOffset;
    const ptX = ptOff ? ptOff[0] : this.weightClass === 'pistol' ? 0.022 : 0.027;
    const ptY = ptOff ? ptOff[1] : this.weightClass === 'pistol' ? -0.074 : -0.084;
    const ptZ = ptOff ? ptOff[2] : this.weightClass === 'pistol' ? -0.22 : -0.245;
    const ptRearPivot = 0.14;
    this._tmpVecA
      .set(ptX, ptY, ptZ - ptRearPivot)
      .applyQuaternion(this._ledCamQuat);
    this._tmpVecB.set(0, 0, ptRearPivot).applyQuaternion(input.camWorldQuat as THREE.Quaternion);
    this._tmpVecA.add(this._tmpVecB).add(input.camWorldPos as THREE.Vector3);
    input.shoulderAnchor.worldToLocal(this._tmpVecA);
    this._pointAimPos.copy(this._tmpVecA);

    const ptRoll =
      input.pointAimRollRad ??
      (this.weightClass === 'pistol' ? THREE.MathUtils.degToRad(32) : input.cantAngleRad);
    const ptConvPitch = input.pointAimConvPitchRad ?? 0;
    const ptConvYaw = input.pointAimConvYawRad ?? 0;
    // Euler order 'YXZ': Y (yaw convergence), then X (pitch convergence), then Z (clean roll around bore + subtle lead twist)
    this._tmpEuler.set(ptConvPitch, ptConvYaw, ptRoll + input.aimYaw * 0.22, 'YXZ');
    this._tmpQuatA.setFromEuler(this._tmpEuler);
    this._pointAimQuat.copy(this._adsQuat).multiply(this._tmpQuatA);

    // --- LOW-READY SPRINT ---
    // Hold barrel at a safe physical resting floor (-6° past minWepRad) so sprinting while looking straight down
    // keeps arms and muzzle cleanly forward of the player's thighs/groin.
    this._sprintPos.set(input.lowReadyOffset[0], input.lowReadyOffset[1], input.lowReadyOffset[2]);
    const minLowReadyTotalPitch = minWepRad - THREE.MathUtils.degToRad(6);
    const lowReadyLocalPitch = Math.max(
      minLowReadyTotalPitch - rootPitchRad,
      input.aimPitch * 0.55 + input.lowReadyRotation[0],
    );
    this._tmpEuler.set(
      lowReadyLocalPitch,
      input.aimYaw * 0.55 + input.lowReadyRotation[1],
      input.lowReadyRotation[2],
      'YXZ',
    );
    this._sprintQuat.setFromEuler(this._tmpEuler);

    // Compose primary combat locomotion pose: Idle -> Convex(Primary ADS, Canted Optic ADS, Point Aim) -> Sprint
    this._targetPos.copy(this._hipPos);
    this._targetQuat.copy(this._hipQuat);

    const totalAimW = this.adsBlend + this.cantBlend + this.pointAimBlend;
    if (totalAimW > 0.0005) {
      const clampedAim = Math.min(1, totalAimW);
      const invSum = 1 / totalAimW;
      const wAds = this.adsBlend * invSum;
      const wCant = this.cantBlend * invSum;
      const wPt = this.pointAimBlend * invSum;

      this._tmpVecA.set(0, 0, 0);
      if (wAds > 0.0001) this._tmpVecA.addScaledVector(this._adsPos, wAds);
      if (wCant > 0.0001) this._tmpVecA.addScaledVector(this._cantPos, wCant);
      if (wPt > 0.0001) this._tmpVecA.addScaledVector(this._pointAimPos, wPt);
      this._targetPos.lerp(this._tmpVecA, clampedAim);

      if (wAds >= wCant && wAds >= wPt) {
        this._tmpQuatA.copy(this._adsQuat);
        if (wCant > 0.0001) this._tmpQuatA.slerp(this._cantQuat, wCant / (wAds + wCant));
        if (wPt > 0.0001) this._tmpQuatA.slerp(this._pointAimQuat, wPt);
      } else if (wCant >= wAds && wCant >= wPt) {
        this._tmpQuatA.copy(this._cantQuat);
        if (wAds > 0.0001) this._tmpQuatA.slerp(this._adsQuat, wAds / (wCant + wAds));
        if (wPt > 0.0001) this._tmpQuatA.slerp(this._pointAimQuat, wPt);
      } else {
        this._tmpQuatA.copy(this._pointAimQuat);
        if (wAds > 0.0001) this._tmpQuatA.slerp(this._adsQuat, wAds / (wPt + wAds));
        if (wCant > 0.0001) this._tmpQuatA.slerp(this._cantQuat, wCant);
      }
      this._targetQuat.slerp(this._tmpQuatA, clampedAim);
    }
    if (this.sprintBlend > 0.0005) {
      this._targetPos.lerp(this._sprintPos, this.sprintBlend);
      this._targetQuat.slerp(this._sprintQuat, this.sprintBlend);
    }

    // --- WALL PULLBACK ---
    if (input.pullbackRatio > 0.001) {
      const downPullScale = 1 - smoothstep(-0.42, -0.82, baseTotalPitch) * 0.45;
      const pullbackDepth = (0.20 + input.barrelLengthM * 0.08) * downPullScale;
      const sideClearanceX = (1 - downPullScale) * 0.08;
      this._targetPos.x += input.pullbackRatio * sideClearanceX;
      this._targetPos.y += input.pullbackRatio * (0.065 + (1 - downPullScale) * 0.05);
      this._targetPos.z += input.pullbackRatio * pullbackDepth;
      this._tmpEuler.set(
        input.pullbackRatio * 0.72,
        input.pullbackRatio * 0.42,
        input.pullbackRatio * 0.24,
        'YXZ',
      );
      this._addQuat.setFromEuler(this._tmpEuler);
      this._targetQuat.multiply(this._addQuat);
    }

    // --- EQUIP DRAW BLEND ---
    if (this.equipTimer > 0 && !input.isUnarmed) {
      const eqT = smoothstep(0, 1, this.equipTimer / Math.max(0.05, this.equipDuration));
      const drawClearance = THREE.MathUtils.clamp((baseTotalPitch - minWepRad) / 0.55 + 0.2, 0.2, 1);
      const drawDownPitch = THREE.MathUtils.lerp(-0.14, -0.68, drawClearance);
      this._equipPos.copy(this._hipPos).add(this._tmpVecB.set(-0.04, -0.22, 0.08));
      this._tmpEuler.set(drawDownPitch, 0.34, 0.24, 'YXZ');
      this._equipQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._equipPos, eqT);
      this._targetQuat.slerp(this._equipQuat, eqT);
    }

    // --- RELOAD / MAG_CHECK / INSPECT POSE-GRAPH STATES ---
    if (this.action === 'RELOAD' && input.isFirearm) {
      const p = this.getActionProgress();
      const env = smoothstep(0.0, 0.14, p) * (1 - smoothstep(0.86, 1.0, p));
      const rackTilt = smoothstep(0.66, 0.75, p) * (1 - smoothstep(0.82, 0.90, p));
      this._actionPos.set(
        this._hipPos.x - 0.045 * env,
        this._hipPos.y - 0.025 * env + rackTilt * 0.02,
        this._hipPos.z + 0.045 * env,
      );
      this._tmpEuler.set(
        0.24 * env - 0.08 * rackTilt,
        0.28 * env + 0.12 * rackTilt,
        0.46 * env + 0.14 * rackTilt,
        'YXZ',
      );
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    } else if (this.action === 'MAG_CHECK' && input.isFirearm) {
      const p = this.getActionProgress();
      const env = smoothstep(0.0, 0.18, p) * (1 - smoothstep(0.82, 1.0, p));
      this._actionPos.set(
        this._hipPos.x - 0.065 * env,
        this._hipPos.y + 0.042 * env,
        this._hipPos.z + 0.055 * env,
      );
      this._tmpEuler.set(0.16 * env, 0.36 * env, 0.78 * env, 'YXZ');
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    } else if (this.action === 'INSPECT' && !input.isUnarmed) {
      // 3-Phase Fluid Weapon Inspect (~3.2s):
      //  Phase 1 (0.00 -> 0.36): Right receiver, ejection port & wear (+38° roll, +22° yaw)
      //  Phase 2 (0.36 -> 0.77): Left receiver, fire selector & optic mount (-42° roll, -15° yaw)
      //  Phase 3 (0.77 -> 1.00): Smooth return to Idle
      const p = this.getActionProgress();
      const raiseEnv = smoothstep(0.0, 0.18, p) * (1 - smoothstep(0.78, 1.0, p));
      const flip12 = smoothstep(0.34, 0.54, p);

      const rollDeg = THREE.MathUtils.lerp(38, -42, flip12);
      const yawDeg = THREE.MathUtils.lerp(22, -15, flip12);
      const pitchDeg = THREE.MathUtils.lerp(9, 11, flip12);
      const microDrift = Math.sin(p * Math.PI * 4) * 0.004;

      // Center cleanly in chest-cam frame during inspection
      this._tmpVecA
        .set(
          THREE.MathUtils.lerp(-0.025, 0.015, flip12),
          -0.065 + microDrift,
          -0.295 - (this.weightClass === 'pistol' ? 0.01 : 0.04),
        )
        .applyQuaternion(input.camWorldQuat as THREE.Quaternion)
        .add(input.camWorldPos as THREE.Vector3);
      input.shoulderAnchor.worldToLocal(this._tmpVecA);

      this._tmpEuler.set(
        THREE.MathUtils.degToRad(pitchDeg),
        THREE.MathUtils.degToRad(yawDeg),
        THREE.MathUtils.degToRad(rollDeg),
        'YXZ',
      );
      this._actionQuat.copy(this._adsQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._tmpVecA, raiseEnv);
      this._targetQuat.slerp(this._actionQuat, raiseEnv);
    } else if (
      (this.action === 'SUPPRESSOR_ATTACH' || this.action === 'SUPPRESSOR_DETACH') &&
      input.isFirearm
    ) {
      // Field suppressor twist-and-stow workspace: tilt firearm ~35° inward and pull slightly closer
      // so the muzzle threads stay framed cleanly in front of the chest bodycam while the left hand works.
      const p = this.getActionProgress();
      const env = smoothstep(0.0, 0.12, p) * (1 - smoothstep(0.84, 1.0, p));
      const twistVib =
        this.getSuppressorSubPhase() === 'TWIST_THREAD'
          ? Math.sin(this.suppressorTwistPhase01 * Math.PI * 7) * 0.014
          : 0;
      const pullInZ = this.weightClass === 'pistol' ? 0.045 : 0.085;
      this._actionPos.set(
        this._hipPos.x - 0.075 * env,
        this._hipPos.y + 0.028 * env,
        this._hipPos.z + pullInZ * env,
      );
      this._tmpEuler.set(
        0.16 * env,
        0.44 * env,
        THREE.MathUtils.degToRad(35) * env + twistVib,
        'YXZ',
      );
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    }

    // --- VAULT RETENTION ---
    const vBlend = input.vaultRetentionBlend;
    if (vBlend > 0.001) {
      if (input.vaultRetentionMode === 'TWO_HAND_SLING') {
        this._vaultPos.set(-0.04, -0.44, 0.06);
        this._tmpEuler.set(-0.92, 0.72, -0.48, 'YXZ');
      } else {
        this._vaultPos.set(0.09, -0.14, 0.04);
        this._tmpEuler.set(-0.34, 0.42, -0.32, 'YXZ');
      }
      this._vaultQuat.setFromEuler(this._tmpEuler);
      this._targetPos.lerp(this._vaultPos, vBlend);
      this._targetQuat.slerp(this._vaultQuat, vBlend);
    }

    // Determine active pose state label & frame-rate-independent damping lambda
    let poseLambda = THREE.MathUtils.clamp(16 / Math.sqrt(Math.max(0.5, input.massHandlingFactor)), 11, 20);
    if (vBlend > 0.15) {
      this.activePoseState = 'VaultRetention';
      poseLambda = 18;
    } else if (this.action === 'RELOAD') {
      this.activePoseState = 'Reload';
      poseLambda = 15;
    } else if (this.action === 'MAG_CHECK') {
      this.activePoseState = 'MagCheck';
      poseLambda = 14;
    } else if (this.action === 'SUPPRESSOR_ATTACH' || this.action === 'SUPPRESSOR_DETACH') {
      this.activePoseState = 'SuppressorToggle';
      poseLambda = 13.5;
    } else if (this.action === 'INSPECT') {
      this.activePoseState = 'Inspect';
      poseLambda = 9.5;
    } else if (this.equipTimer > 0.01) {
      this.activePoseState = 'Equip';
      poseLambda = 15;
    } else if (input.pullbackRatio > 0.15) {
      this.activePoseState = 'WallPullback';
      poseLambda = 18;
    } else if (this.sprintBlend > 0.45) {
      this.activePoseState = 'LowReadySprint';
      poseLambda = 13;
    } else if (this.cantBlend > 0.35) {
      this.activePoseState = 'Cant';
      poseLambda =
        this.cantBlend > 0.85 ? 28 : 18 * Math.max(0.45, input.adsSpeedMult);
    } else if (this.pointAimBlend > 0.35) {
      this.activePoseState = 'PointAim';
      poseLambda =
        this.pointAimBlend > 0.85 ? 28 : 18 * Math.max(0.45, input.adsSpeedMult);
    } else if (this.adsBlend > 0.35) {
      this.activePoseState = 'ADS';
      poseLambda =
        this.adsBlend > 0.85 ? 30 : 20 * Math.max(0.45, input.adsSpeedMult);
    } else {
      this.activePoseState = 'Idle';
    }

    // Crisp ~0.12s combat interrupt blend (lambda=26 reaches ~96% in 0.12s)
    if (this.interruptFastBlendTimer > 0) {
      poseLambda = Math.max(poseLambda, 26);
    }

    if (!this.poseInitialized) {
      this.dampedBasePos.copy(this._targetPos);
      this.dampedBaseQuat.copy(this._targetQuat);
      this.poseInitialized = true;
    } else {
      dampVec3(this.dampedBasePos, this._targetPos, poseLambda, dt);
      dampSlerp(this.dampedBaseQuat, this._targetQuat, poseLambda, dt);
    }

    // 3. Layer crisp additive kinematics on top of damped pose (locomotion bob, breathing micro-sway,
    //    2nd-order recoil springs, rapid-fire sight misalignment, and mag-seat impulse)
    const sightBobScale = Math.max(
      0.12,
      1 - this.adsBlend * 0.80 - this.cantBlend * 0.78 - this.pointAimBlend * 0.45,
    );
    const walkSwingX = input.isMoving
      ? Math.sin(input.bobPhase) * (input.isSprinting ? 0.030 : 0.012) * sightBobScale
      : 0;
    const walkSwingY = input.isMoving
      ? (-Math.cos(input.bobPhase * 2) * 0.5 - 0.5) * (input.isSprinting ? 0.025 : 0.011) * sightBobScale
      : 0;
    const settleY = THREE.MathUtils.clamp(input.verticalMotionOffset * 0.22, -0.05, 0.032) * sightBobScale;

    const breathScale = Math.max(
      0.35,
      1 - this.adsBlend * 0.52 - this.cantBlend * 0.48 - this.pointAimBlend * 0.35,
    );
    const misPosX = input.sightMisalignYaw * 0.038;
    const misPosY = -input.sightMisalignPitch * 0.024;

    const aimBlend = Math.min(1, this.adsBlend + this.cantBlend + this.pointAimBlend);
    const aimStab = Math.min(1, this.adsBlend + this.cantBlend * 0.88 + this.pointAimBlend * 0.55);
    const isMagnifiedPrimary = Boolean(
      this.assembly?.scopeLensMaterial &&
        this.adsBlend > 0.05 &&
        this.adsBlend >= this.cantBlend &&
        this.adsBlend >= this.pointAimBlend,
    );
    const opticRotScale = isMagnifiedPrimary ? 0.45 : 1.0;
    const massRotScale = THREE.MathUtils.clamp(
      Math.sqrt(Math.max(0.5, input.massHandlingFactor)),
      0.78,
      1.25,
    );

    const parallaxStrength = THREE.MathUtils.clamp(input.opticParallaxStrength ?? 1.0, 0.0, 2.0);
    const latMotion = input.lateralMotion ?? 0;

    // Physical cheek-weld / eye-box lateral lag driven by strafing, Q/E leaning & mouse sweeps:
    // shifts the optic housing across the eye-box while the 50m collimated reticle stays locked on target
    const targetEyeLagX =
      THREE.MathUtils.clamp((-latMotion * 0.0022 - input.lagYaw * 0.078) * massRotScale, -0.0075, 0.0075) *
      parallaxStrength *
      aimBlend;
    const targetEyeLagY =
      THREE.MathUtils.clamp(
        (input.lagPitch * 0.058 - input.verticalMotionOffset * 0.055) * massRotScale,
        -0.0055,
        0.0055,
      ) *
      parallaxStrength *
      aimBlend;
    this.eyeBoxLagX = THREE.MathUtils.damp(this.eyeBoxLagX, targetEyeLagX, 11.5, dt);
    this.eyeBoxLagY = THREE.MathUtils.damp(this.eyeBoxLagY, targetEyeLagY, 11.5, dt);
    const eyeLagScale = isMagnifiedPrimary ? 0.55 : 1.0;

    // Compute muzzle-driven rotational sway & recoil drift so force originates at the muzzle
    // while the rear firing hand / shoulder stock stays anchored (zero lateral hand-sliding)
    const muzzleRecPitch = input.recoilPitch + (input.muzzleDriftPitch ?? 0);
    const muzzleRecYaw = (input.recoilYaw ?? 0) + (input.muzzleDriftYaw ?? 0);
    const muzzleRecRoll = input.recoilRoll;

    // Breathing sway also pivots the muzzle rather than sliding the hands sideways
    const breathRotScale = THREE.MathUtils.lerp(1.45, 0.95, aimStab) * opticRotScale;
    const breathYaw = -input.breathX * 1.35 * breathRotScale;
    const breathPitch = input.breathY * 1.45 * breathRotScale;

    // Rear anchor pivot point in weapon-local space (firing wrist for pistols; grip-to-stock pocket for long guns)
    const rightHandPos = this.assembly?.rightHandSocket.position;
    if (input.weightClass === 'pistol') {
      this._recoilPivotLocal.set(
        0,
        rightHandPos ? rightHandPos.y : -0.045,
        (rightHandPos ? rightHandPos.z : 0.02) + 0.035,
      );
    } else {
      const rearPivotZ =
        (rightHandPos ? rightHandPos.z : 0.026) + THREE.MathUtils.lerp(0.125, 0.065, aimStab);
      const rearPivotY = THREE.MathUtils.lerp(rightHandPos ? rightHandPos.y : -0.042, -0.015, aimStab);
      this._recoilPivotLocal.set(0, rearPivotY, rearPivotZ);
    }

    // Exact rigid-body rear-pivot compensation: Δp = Q_base * (P_rear - Q_muzzle * P_rear)
    // Leaves P_rear (hands/shoulder) stationary while the full barrel lever arm swings & drifts the muzzle
    this._tmpEuler.set(muzzleRecPitch + breathPitch, muzzleRecYaw + breathYaw, muzzleRecRoll, 'YXZ');
    this._recoilRotQuat.setFromEuler(this._tmpEuler);
    this._tmpVecA
      .copy(this._recoilPivotLocal)
      .applyQuaternion(this._recoilRotQuat)
      .negate()
      .add(this._recoilPivotLocal)
      .applyQuaternion(this.dampedBaseQuat);

    // Axial rearward recoil kickback straight along the bore from muzzle into hands/shoulder
    this._tmpVecB.set(0, 0, input.recoilZ).applyQuaternion(this.dampedBaseQuat);

    input.weaponPivot.position.set(
      this.dampedBasePos.x +
        walkSwingX +
        input.breathX * 0.28 * breathScale +
        misPosX +
        this.eyeBoxLagX * eyeLagScale +
        this._tmpVecA.x +
        this._tmpVecB.x,
      this.dampedBasePos.y +
        walkSwingY +
        settleY +
        input.breathY * 0.28 * breathScale +
        misPosY +
        this.eyeBoxLagY * eyeLagScale +
        this.magSeatImpulseY +
        this._tmpVecA.y +
        this._tmpVecB.y,
      this.dampedBasePos.z + this._tmpVecA.z + this._tmpVecB.z,
    );

    // ADS & Canted rotational kinematics (keeps projected 3D reticle + physical bore coupled under motion)
    const adsLagYaw =
      THREE.MathUtils.clamp(input.lagYaw * 0.24 * massRotScale, -0.026, 0.026) *
      aimBlend *
      opticRotScale;
    const adsLagPitch =
      THREE.MathUtils.clamp(input.lagPitch * 0.22 * massRotScale, -0.022, 0.022) *
      aimBlend *
      opticRotScale;
    const adsLagRoll =
      THREE.MathUtils.clamp(input.lagYaw * 0.32 * massRotScale, -0.036, 0.036) *
      aimBlend *
      opticRotScale;

    const strideRotAmp = (input.isMoving ? 1 : 0) * aimBlend * (input.isSprinting ? 1.35 : 1.0) * opticRotScale;
    const adsStrideYaw = Math.sin(input.bobPhase) * 0.0068 * strideRotAmp;
    const adsStridePitch =
      Math.cos(input.bobPhase * 2) * 0.0032 * strideRotAmp +
      THREE.MathUtils.clamp(input.verticalMotionOffset * 0.26, -0.014, 0.014) * aimBlend * opticRotScale;
    const adsStrideRoll = Math.sin(input.bobPhase) * 0.014 * strideRotAmp;

    const idleMicroPitch = Math.sin(input.elapsed * 1.4) * 0.0025 * (1 - aimStab * 0.55);

    this._tmpEuler.set(
      muzzleRecPitch +
        input.sightMisalignPitch +
        idleMicroPitch +
        adsLagPitch +
        adsStridePitch +
        breathPitch,
      muzzleRecYaw + input.sightMisalignYaw + adsLagYaw + adsStrideYaw + breathYaw,
      muzzleRecRoll + input.sightMisalignRoll + adsLagRoll + adsStrideRoll,
      'YXZ',
    );
    this._addQuat.setFromEuler(this._tmpEuler);
    input.weaponPivot.quaternion.copy(this.dampedBaseQuat).multiply(this._addQuat);
  }

  public dispose(): void {
    this.restoreMagazineHome();
    for (const c of this.casingPool) {
      this.scene.remove(c.mesh);
    }
    this.casingPool.length = 0;
    this.casingGeo.dispose();
    this.casingMat.dispose();

    for (const s of this.smokePool) {
      this.scene.remove(s.mesh);
      s.mat.dispose();
    }
    this.smokePool.length = 0;
    this.smokeGeo.dispose();
  }
}

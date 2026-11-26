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
  | 'ChamberCycle'
  | 'SuppressorToggle';

export type WeaponMechanicalAction =
  | 'NONE'
  | 'RELOAD'
  | 'MAG_CHECK'
  | 'INSPECT'
  | 'CHAMBER_CYCLE'
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
  | 'CLEAR_PULL'
  | 'STOW_OR_CLEAR'
  | 'RETURN_GRIP';

export type WeaponHandlingMicroAction =
  | 'NONE'
  | 'ZOOM_TWIST'
  | 'TURRET'
  | 'ILLUM'
  | 'SELECTOR'
  | 'LIGHT_PAD';

export type WeaponSyncedHandlingAction =
  | 'NONE'
  | 'RELOAD'
  | 'PUMP'
  | 'BOLT'
  | 'SUPPRESSOR_DETACH'
  | 'SUPPRESSOR_ATTACH'
  | 'ZOOM_TWIST'
  | 'TURRET'
  | 'ILLUM'
  | 'SELECTOR'
  | 'LIGHT_PAD'
  | 'MAG_CHECK'
  | 'INSPECT'
  | 'CHAMBER_CYCLE';

export type ChamberCyclePlatformStyle =
  | 'pistol_slide'
  | 'ar_charging_handle'
  | 'ak_side_bolt'
  | 'mp5_cocking_tube'
  | 'pump_shotgun'
  | 'bolt_action'
  | 'revolver_cylinder';

export interface WeaponChamberCycleOptions {
  /** True when a live round is chambered and should extract at the apex of the stroke */
  hasLiveRound: boolean;
  /** Fired once at the physical extraction apex with live world transform of the ejection port */
  onExtractApex?: (ejectionPos: THREE.Vector3, ejectionQuat: THREE.Quaternion) => void;
  /** Optional callback fired when the chamber cycle returns to battery */
  onComplete?: () => void;
  /** Optional explicit duration override in seconds */
  durationSec?: number;
}

export type TubularReloadPhase =
  | 'NONE'
  | 'ENTER'
  | 'OPEN_BREECH'
  | 'BREECH_LOAD'
  | 'CLOSE_BREECH'
  | 'FEED_SHELL'
  | 'EXIT';

export interface RatchetedSuppressorTwistSample {
  /** 0..1 cumulative rotational progress across 3 discrete strokes (frozen during regrips) */
  cumulativeAngle01: number;
  /** 0..1 cumulative axial thread travel across 3 discrete strokes (frozen during regrips) */
  axial01: number;
  /** Signed left-wrist pronation/supination roll in radians synchronized with torque & regrip */
  wristRollRad: number;
  /** 0..1 finger grip release opening during regrip roll-back (0 = firm grip, 1 = open fingers) */
  gripRelease01: number;
  /** Subtle counter-torque roll imparted onto the weapon body during active turning */
  weaponCounterRollRad: number;
  /** Active stroke index 0, 1, or 2 */
  strokeIndex: number;
}

export interface WeaponSyncedHandlingSnapshot {
  action: WeaponSyncedHandlingAction;
  progress: number;
}

export type ReloadPlatformStyle =
  | 'mp5_hk_slap'
  | 'ar_bolt_catch'
  | 'ak_rock_lock'
  | 'pistol_cant'
  | 'tubular_shotgun'
  | 'standard';

export function resolveReloadPlatformStyle(
  visualStyle: string | undefined,
  weightClass: 'pistol' | 'carbine' | 'heavy_rifle',
  startedFromEmpty: boolean,
): ReloadPlatformStyle {
  if (visualStyle === 'MP5RollerSMG') {
    return startedFromEmpty ? 'mp5_hk_slap' : 'standard';
  }
  if (
    startedFromEmpty &&
    (visualStyle === 'carbine_ar' ||
      visualStyle === 'ARCarbine' ||
      visualStyle === 'PistonCarbine' ||
      visualStyle === 'AR10_HeavyDMR')
  ) {
    return 'ar_bolt_catch';
  }
  if (
    visualStyle === 'carbine_ak' ||
    visualStyle === 'rifle_ak' ||
    visualStyle === 'AKStamped' ||
    visualStyle === 'SovietDMR'
  ) {
    return 'ak_rock_lock';
  }
  if (weightClass === 'pistol') {
    return 'pistol_cant';
  }
  if (visualStyle === 'ShotgunTactical' || visualStyle === 'shotgun') {
    return 'tubular_shotgun';
  }
  return 'standard';
}

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
  lagRoll?: number;
  motionPosX?: number;
  motionPosY?: number;
  motionPosZ?: number;
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
export const SUPPRESSOR_TOGGLE_DURATION_SEC = 2.45;
const SUPPRESSOR_THREAD_TRAVEL_M = 0.032;
const SUPPRESSOR_CLEAR_PULL_M = 0.025;
const SUPPRESSOR_STROKE_COUNT = 3;
const SUPPRESSOR_TORQUE_FRAC = 0.68;
const SUPPRESSOR_TOTAL_RAD = Math.PI * 2; // 3 x ~120° ratcheted strokes = 360° total visual turn
const BLOWBACK_BACK_SEC = 0.025; // ~25ms rearward blowback
const BLOWBACK_FWD_SEC = 0.045; // ~45ms forward return to battery
const BLOWBACK_TOTAL_SEC = BLOWBACK_BACK_SEC + BLOWBACK_FWD_SEC;

/**
 * Pure deterministic 3-stroke ratcheted suppressor twist evaluator shared by 1P, 3P AI/remote rigs, and unit tests.
 * During each stroke's torque window [0..0.68], wrist & suppressor rotate synchronously and thread axially.
 * During each stroke's regrip window [0.68..1.0], fingers release (`gripRelease01` peaks), wrist rolls back,
 * and the suppressor's rotation & axial thread position remain strictly stationary (zero telekinetic spinning).
 */
export function evalRatchetedSuppressorTwist(
  twistT: number,
  attach: boolean,
  out: RatchetedSuppressorTwistSample = {
    cumulativeAngle01: 0,
    axial01: 0,
    wristRollRad: 0,
    gripRelease01: 0,
    weaponCounterRollRad: 0,
    strokeIndex: 0,
  },
): RatchetedSuppressorTwistSample {
  const clamped = THREE.MathUtils.clamp(twistT, 0, 1);
  const scaled = clamped * SUPPRESSOR_STROKE_COUNT;
  const strokeIndex = Math.min(SUPPRESSOR_STROKE_COUNT - 1, Math.floor(scaled));
  const localU =
    strokeIndex === SUPPRESSOR_STROKE_COUNT - 1 && scaled >= SUPPRESSOR_STROKE_COUNT
      ? 1
      : scaled - strokeIndex;
  const sign = attach ? 1 : -1;
  const strokeSpan = 1 / SUPPRESSOR_STROKE_COUNT;
  const maxWristRoll = 0.58;

  if (localU <= SUPPRESSOR_TORQUE_FRAC) {
    const tau = smoothstep(0, SUPPRESSOR_TORQUE_FRAC, localU);
    const prog = strokeIndex * strokeSpan + tau * strokeSpan;
    out.cumulativeAngle01 = prog;
    out.axial01 = prog;
    out.wristRollRad = THREE.MathUtils.lerp(-sign * maxWristRoll, sign * maxWristRoll, tau);
    // Quick finger clamp on start of stroke
    out.gripRelease01 = (1 - smoothstep(0, 0.14, tau)) * 0.25;
    out.weaponCounterRollRad = -sign * Math.sin(tau * Math.PI) * 0.026;
  } else {
    const r = (localU - SUPPRESSOR_TORQUE_FRAC) / (1 - SUPPRESSOR_TORQUE_FRAC);
    const frozenProg = (strokeIndex + 1) * strokeSpan;
    out.cumulativeAngle01 = frozenProg;
    out.axial01 = frozenProg;
    out.weaponCounterRollRad = 0;
    if (strokeIndex < SUPPRESSOR_STROKE_COUNT - 1) {
      // Open fingers cleanly off tube, roll wrist back to start of next stroke, re-clamp
      out.gripRelease01 = Math.sin(r * Math.PI) * 0.88;
      const rollBack = smoothstep(0.12, 0.88, r);
      out.wristRollRad = THREE.MathUtils.lerp(sign * maxWristRoll, -sign * maxWristRoll, rollBack);
    } else {
      // Final stroke settle: relax wrist cleanly to neutral for clear-pull / return
      const settle = smoothstep(0, 1, r);
      out.wristRollRad = THREE.MathUtils.lerp(sign * maxWristRoll, 0, settle);
      out.gripRelease01 = attach ? settle * 0.45 : 0;
    }
  }
  out.strokeIndex = strokeIndex;
  return out;
}

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
  private pumpEjectPending = false;
  private pumpCycleSuppressed = false;
  private pumpRackBackCueFired = false;
  private pumpRackFwdCueFired = false;
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
  private reloadCueHkLockFired = false;
  private reloadStartedFromEmpty = false;
  private magCheckOutFired = false;
  private magCheckInFired = false;
  private magazineDetachedInHand = false;
  private magCheckPullM = 0;
  private inspectLeftHandSlideZ = 0;
  private readonly _mechPosImpulse = new THREE.Vector3();
  private readonly _mechRotImpulse = new THREE.Vector3();

  // Shell-by-shell tubular shotgun reload state machine
  private tubularPhase: TubularReloadPhase = 'NONE';
  private tubularPhaseTime = 0;
  private tubularPhaseDuration = 0.24;
  private tubularShellsRemaining = 0;
  private tubularShellsTotal = 0;
  private tubularShellsLoaded = 0;
  private tubularInterruptRequested = false;
  private tubularShellInHand = false;
  private tubularShellInsertedThisCycle = false;
  private tubularPumpOpen01 = 0;
  private tubularOnShellInserted: (() => void) | null = null;
  private tubularOnComplete: (() => void) | null = null;

  // Non-blocking combat-interruptible firearm handling micro-actions
  private microAction: WeaponHandlingMicroAction = 'NONE';
  private microActionTime = 0;
  private microActionDuration = 0.24;
  private selectorAngleTarget = 0;
  private selectorAngleCurrent = 0;
  private illumDialAngleTarget = 0;
  private illumDialAngleCurrent = 0;

  // Suppressor field ratcheted twist-and-stow state
  private suppressorInHand = false;
  private suppressorPreActionVisible = true;
  private suppressorTwistPhase01 = 0;
  private suppressorCueMask = 0;
  private suppressorOnComplete: ((attached: boolean) => void) | null = null;
  private suppressorHandoffBlend = 0;
  private readonly _suppTwistSample: RatchetedSuppressorTwistSample = {
    cumulativeAngle01: 0,
    axial01: 0,
    wristRollRad: 0,
    gripRelease01: 0,
    weaponCounterRollRad: 0,
    strokeIndex: 0,
  };
  private readonly _suppPalmTargetPos = new THREE.Vector3(0.006, -0.024, -0.044);
  private readonly _suppPalmTargetQuat = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.PI * 0.46, 0.08, -Math.PI * 0.35),
  );
  private readonly _syncedHandlingSnapshot: WeaponSyncedHandlingSnapshot = {
    action: 'NONE',
    progress: 0,
  };

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

  // Manual Chamber Cycling (`Y`) state
  private chamberCycleStyle: ChamberCyclePlatformStyle = 'ar_charging_handle';
  private chamberCycleHasLiveRound = false;
  private chamberCycleOpenCueFired = false;
  private chamberCycleExtractFired = false;
  private chamberCycleCloseCueFired = false;
  private chamberCyclePump01 = 0;
  private chamberCycleBoltRotZ = 0;
  private chamberCycleOnExtractApex:
    | ((ejectionPos: THREE.Vector3, ejectionQuat: THREE.Quaternion) => void)
    | null = null;
  private chamberCycleOnComplete: (() => void) | null = null;
  private readonly _chamberEjectPos = new THREE.Vector3();
  private readonly _chamberEjectQuat = new THREE.Quaternion();

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
    this.restoreReloadShellHome();
    if (this.isSuppressorActionActive()) {
      this.restoreSuppressorHome(this.suppressorPreActionVisible);
    }
    this.suppressorOnComplete = null;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.suppressorHandoffBlend = 0;
    this.tubularPhase = 'NONE';
    this.tubularShellsRemaining = 0;
    this.tubularShellInHand = false;
    this.tubularPumpOpen01 = 0;
    this.tubularOnShellInserted = null;
    this.tubularOnComplete = null;
    this.microAction = 'NONE';
    this.microActionTime = 0;
    this.selectorAngleTarget = 0;
    this.selectorAngleCurrent = 0;
    this.illumDialAngleTarget = 0;
    this.illumDialAngleCurrent = 0;
    this.assembly = assembly;
    this.weightClass = weightClass;
    this.blowbackTimer = -1;
    this.hammerTimer = 0;
    this.triggerTimer = 0;
    this.pumpCycleTimer = -1;
    this.pumpEjectPending = false;
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

  public isChamberCycling(): boolean {
    return this.action === 'CHAMBER_CYCLE';
  }

  public getChamberCycleStyle(): ChamberCyclePlatformStyle {
    return this.chamberCycleStyle;
  }

  public getChamberCycleProgress(): number {
    return this.action === 'CHAMBER_CYCLE' ? this.getActionProgress() : 0;
  }

  public getManualBoltPull01(): number {
    return this.manualBoltPull01;
  }

  public getBoltRightHandBlend(): number {
    if (this.action === 'CHAMBER_CYCLE' && this.chamberCycleStyle === 'bolt_action') {
      const p = this.getActionProgress();
      return smoothstep(0.08, 0.22, p) * (1 - smoothstep(0.80, 0.94, p));
    }
    return this.boltRightHandBlend;
  }

  public getBoltCycleOffsetZ(): number {
    return this.boltCycleOffsetZ;
  }

  public getTriggerPull01(): number {
    if (this.triggerTimer <= 0) return 0;
    const total = 0.115;
    const elapsed = THREE.MathUtils.clamp(total - this.triggerTimer, 0, total);
    // Asymmetric squeeze curve: brisk 32ms rearward break followed by smooth 83ms damped reset
    if (elapsed < 0.032) {
      return smoothstep(0, 0.032, elapsed);
    }
    return 1 - smoothstep(0.032, total, elapsed);
  }

  public isPumpCycling(): boolean {
    return this.pumpCycleTimer >= 0;
  }

  public getPumpCycleProgress(): number {
    if (this.pumpCycleTimer < 0) return 0;
    return THREE.MathUtils.clamp(this.pumpCycleTimer / 0.33, 0, 1);
  }

  public isTubularReloading(): boolean {
    return this.tubularPhase !== 'NONE';
  }

  public getTubularReloadPhase(): TubularReloadPhase {
    return this.tubularPhase;
  }

  public getTubularPhaseProgress(): number {
    if (this.tubularPhase === 'NONE') return 0;
    return THREE.MathUtils.clamp(
      this.tubularPhaseTime / Math.max(0.05, this.tubularPhaseDuration),
      0,
      1,
    );
  }

  public isTubularShellInHand(): boolean {
    return this.tubularShellInHand;
  }

  public getReloadPlatformStyle(): ReloadPlatformStyle {
    if (this.tubularPhase !== 'NONE') return 'tubular_shotgun';
    return resolveReloadPlatformStyle(
      this.assembly?.visualStyle,
      this.weightClass,
      this.reloadStartedFromEmpty,
    );
  }

  public isArBoltCatchSlap(): boolean {
    return this.action === 'RELOAD' && this.getReloadPlatformStyle() === 'ar_bolt_catch';
  }

  public isMp5HkSlap(): boolean {
    return this.action === 'RELOAD' && this.getReloadPlatformStyle() === 'mp5_hk_slap';
  }

  /**
   * Drains accumulated mechanical action impulses (H&K slap jolt, mag baseplate palm-tap,
   * AR bolt-catch slap, shotgun pump extraction/lockup) into the coupled WeaponRig spring solver.
   */
  public consumeMechanicalSpringImpulse(outPos: THREE.Vector3, outRot: THREE.Vector3): boolean {
    const has =
      this._mechPosImpulse.lengthSq() > 1e-8 || this._mechRotImpulse.lengthSq() > 1e-8;
    outPos.copy(this._mechPosImpulse);
    outRot.copy(this._mechRotImpulse);
    this._mechPosImpulse.set(0, 0, 0);
    this._mechRotImpulse.set(0, 0, 0);
    return has;
  }

  private pushMechanicalImpulse(
    px: number,
    py: number,
    pz: number,
    pitchVel: number,
    yawVel: number,
    rollVel: number,
  ): void {
    this._mechPosImpulse.x += px;
    this._mechPosImpulse.y += py;
    this._mechPosImpulse.z += pz;
    this._mechRotImpulse.x += pitchVel;
    this._mechRotImpulse.y += yawVel;
    this._mechRotImpulse.z += rollVel;
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

  public getSuppressorWristRollRad(): number {
    if (!this.isSuppressorActionActive()) return 0;
    return this._suppTwistSample.wristRollRad;
  }

  public getSuppressorGripRelease01(): number {
    if (!this.isSuppressorActionActive()) return 0;
    return this._suppTwistSample.gripRelease01;
  }

  public getSuppressorSubPhase(): WeaponSuppressorSubPhase {
    if (this.action === 'SUPPRESSOR_DETACH') {
      const p = this.getActionProgress();
      if (p < 0.10) return 'TILT_WEAPON';
      if (p < 0.21) return 'REACH_MUZZLE';
      if (p < 0.61) return 'TWIST_THREAD';
      if (p < 0.67) return 'CLEAR_PULL';
      if (p < 0.86) return 'STOW_OR_CLEAR';
      return 'RETURN_GRIP';
    }
    if (this.action === 'SUPPRESSOR_ATTACH') {
      const p = this.getActionProgress();
      if (p < 0.10) return 'TILT_WEAPON';
      if (p < 0.28) return 'REACH_POUCH';
      if (p < 0.40) return 'REACH_MUZZLE';
      if (p < 0.44) return 'CLEAR_PULL';
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

  public getActiveMicroAction(): WeaponHandlingMicroAction {
    return this.microAction;
  }

  public getMicroActionProgress(): number {
    if (this.microAction === 'NONE') return 0;
    return THREE.MathUtils.clamp(
      this.microActionTime / Math.max(0.05, this.microActionDuration),
      0,
      1,
    );
  }

  public getMicroActionWeight(): number {
    if (this.microAction === 'NONE') return 0;
    const p = this.getMicroActionProgress();
    if (p < 0.28) return smoothstep(0, 0.28, p);
    if (p < 0.72) return 1;
    return 1 - smoothstep(0.72, 1, p);
  }

  public getRightThumbFlick01(): number {
    if (this.microAction !== 'SELECTOR') return 0;
    if (this.assembly?.selectorSide !== 'right_thumb') return 0;
    return this.getMicroActionWeight();
  }

  public isBlockingFiringAction(): boolean {
    return (
      this.action === 'RELOAD' ||
      this.action === 'CHAMBER_CYCLE' ||
      this.action === 'SUPPRESSOR_ATTACH' ||
      this.action === 'SUPPRESSOR_DETACH' ||
      this.boltCycleTimer >= 0 ||
      this.pumpCycleTimer >= 0
    );
  }

  /** Compact network-ready handling snapshot for multiplayer & 3P AI replication */
  public getSyncedHandlingSnapshot(): Readonly<WeaponSyncedHandlingSnapshot> {
    const snap = this._syncedHandlingSnapshot;
    if (this.action === 'SUPPRESSOR_DETACH') {
      snap.action = 'SUPPRESSOR_DETACH';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.action === 'SUPPRESSOR_ATTACH') {
      snap.action = 'SUPPRESSOR_ATTACH';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.action === 'RELOAD') {
      snap.action = 'RELOAD';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.tubularPhase !== 'NONE') {
      snap.action = 'RELOAD';
      const frac =
        this.tubularShellsTotal > 0
          ? (this.tubularShellsLoaded + this.getTubularPhaseProgress()) / (this.tubularShellsTotal + 1)
          : this.getTubularPhaseProgress();
      snap.progress = THREE.MathUtils.clamp(frac, 0, 1);
      return snap;
    }
    if (this.boltCycleTimer >= 0) {
      snap.action = 'BOLT';
      snap.progress = THREE.MathUtils.clamp(
        this.boltCycleTimer / Math.max(0.4, this.boltCycleDuration),
        0,
        1,
      );
      return snap;
    }
    if (this.pumpCycleTimer >= 0) {
      snap.action = 'PUMP';
      snap.progress = this.getPumpCycleProgress();
      return snap;
    }
    if (this.action === 'CHAMBER_CYCLE') {
      snap.action = 'CHAMBER_CYCLE';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.action === 'MAG_CHECK') {
      snap.action = 'MAG_CHECK';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.action === 'INSPECT') {
      snap.action = 'INSPECT';
      snap.progress = this.getActionProgress();
      return snap;
    }
    if (this.microAction !== 'NONE') {
      snap.action = this.microAction;
      snap.progress = this.getMicroActionProgress();
      return snap;
    }
    snap.action = 'NONE';
    snap.progress = 0;
    return snap;
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
    // Strictly block firing while suppressor is being detached or mounted
    if (this.isSuppressorActionActive()) return;
    this.cancelMicroAction();
    if (this.tubularPhase !== 'NONE') {
      this.abortTubularReloadImmediate();
    }
    if (this.action === 'INSPECT' || this.action === 'MAG_CHECK') {
      this.interruptInspect();
    }
    this.hammerTimer = 0.085;
    this.triggerTimer = 0.115;

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

    const willPumpCycle = Boolean(this.assembly?.pumpForend && opts?.cyclePump !== false);
    this.blowbackTimer = willPumpCycle ? -1 : 0;
    if (willPumpCycle) {
      this.pumpCycleTimer = 0;
      this.pumpEjectPending = true;
      this.pumpCycleSuppressed = suppressed;
      this.pumpRackBackCueFired = false;
      this.pumpRackFwdCueFired = false;
    }
    if (remainingAmmoAfterShot !== undefined) {
      this.isBoltLockedOpen = !willPumpCycle && remainingAmmoAfterShot <= 0;
    }
    // Pump shotguns eject spent hull at the apex of rearward pump extraction rather than on ignition
    if (!willPumpCycle) {
      this.spawnCasingAndSmoke(suppressed);
    }
  }

  public triggerDryFire(): void {
    if (this.isSuppressorActionActive()) return;
    this.cancelMicroAction();
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.hammerTimer = 0.075;
    this.triggerTimer = 0.105;
    this.emitCue('dryfire', 1.0);
  }

  public triggerReload(durationSec: number): void {
    if (this.isSuppressorActionActive()) return;
    this.cancelMicroAction();
    if (this.tubularPhase !== 'NONE') {
      this.abortTubularReloadImmediate();
    }
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
    this.reloadCueHkLockFired = false;
    this.reloadStartedFromEmpty = this.isBoltLockedOpen;
    this.magazineDetachedInHand = false;
  }

  /**
   * Shell-by-shell tubular shotgun reload:
   *  - If empty chamber, racks pump open, drops first shell into side ejection port/breech, closes pump,
   *    then feeds remaining shells one-by-one into underside loading port.
   *  - Supports instant click-to-fire interruption (`interruptTubularReload()`).
   */
  public triggerTubularReload(
    shellsToLoad: number,
    isEmptyChamber: boolean,
    onShellInserted?: () => void,
    onComplete?: () => void,
  ): boolean {
    if (shellsToLoad <= 0) return false;
    if (
      this.isSuppressorActionActive() ||
      this.action === 'RELOAD' ||
      this.tubularPhase !== 'NONE' ||
      this.pumpCycleTimer >= 0
    ) {
      return false;
    }
    this.cancelMicroAction();
    if (this.action === 'INSPECT' || this.action === 'MAG_CHECK') {
      this.interruptInspect();
    }
    this.tubularShellsRemaining = shellsToLoad;
    this.tubularShellsTotal = shellsToLoad;
    this.tubularShellsLoaded = 0;
    this.tubularInterruptRequested = false;
    this.tubularShellInHand = false;
    this.tubularShellInsertedThisCycle = false;
    this.tubularPumpOpen01 = 0;
    this.tubularOnShellInserted = onShellInserted ?? null;
    this.tubularOnComplete = onComplete ?? null;
    this.tubularPhase = isEmptyChamber ? 'OPEN_BREECH' : 'ENTER';
    this.tubularPhaseTime = 0;
    this.tubularPhaseDuration = isEmptyChamber ? 0.24 : 0.18;
    this.emitCue('ads_rustle', 0.72);
    return true;
  }

  /** Request graceful immediate exit from tubular reload (e.g., player clicks LMB to fire loaded shell) */
  public interruptTubularReload(): void {
    if (this.tubularPhase === 'NONE') return;
    this.tubularInterruptRequested = true;
    if (this.tubularPhase === 'FEED_SHELL' && this.tubularPhaseTime < this.tubularPhaseDuration * 0.45) {
      this.tubularShellInHand = false;
      this.restoreReloadShellHome();
      this.tubularPhase = 'EXIT';
      this.tubularPhaseTime = 0;
      this.tubularPhaseDuration = 0.12;
      this.interruptFastBlendTimer = 0.14;
    }
  }

  private abortTubularReloadImmediate(): void {
    this.tubularPhase = 'NONE';
    this.tubularPhaseTime = 0;
    this.tubularShellsRemaining = 0;
    this.tubularShellInHand = false;
    this.tubularPumpOpen01 = 0;
    this.tubularOnShellInserted = null;
    this.tubularOnComplete = null;
    this.restoreReloadShellHome();
    this.interruptFastBlendTimer = 0.14;
  }

  public triggerMicroAction(
    kind: WeaponHandlingMicroAction,
    durationSec?: number,
    param?: number,
  ): boolean {
    if (kind === 'NONE') return false;
    if (
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.isSuppressorActionActive() ||
      this.tubularPhase !== 'NONE' ||
      this.boltCycleTimer >= 0 ||
      this.pumpCycleTimer >= 0
    ) {
      return false;
    }
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.microAction = kind;
    this.microActionTime = 0;
    this.microActionDuration =
      durationSec ??
      (kind === 'ZOOM_TWIST'
        ? 0.28
        : kind === 'TURRET'
          ? 0.24
          : kind === 'ILLUM'
            ? 0.22
            : kind === 'SELECTOR'
              ? 0.18
              : 0.16);

    if (kind === 'SELECTOR') {
      // Rotate physical selector lever between detents (~28° per click)
      const step = param !== undefined ? param : 1;
      this.selectorAngleTarget =
        param !== undefined ? step * 0.48 : this.selectorAngleTarget > 0.2 ? 0 : 0.52;
      this.emitCue('mode_toggle', 0.92);
    } else if (kind === 'ILLUM') {
      this.illumDialAngleTarget += 0.62;
      this.emitCue('mode_toggle', 0.68);
    } else if (kind === 'TURRET') {
      this.emitCue('mode_toggle', 0.62);
    } else if (kind === 'LIGHT_PAD') {
      this.emitCue('mode_toggle', 0.55);
    }
    return true;
  }

  public cancelMicroAction(): void {
    this.microAction = 'NONE';
    this.microActionTime = 0;
  }

  public triggerMagCheck(durationSec: number): void {
    if (this.action === 'RELOAD' || this.isSuppressorActionActive() || this.tubularPhase !== 'NONE') return;
    this.cancelMicroAction();
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

  /** Trigger blocking ~2.45s realistic 3-stroke ratcheted suppressor detach/reattach sequence (`G` key) */
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
      this.tubularPhase !== 'NONE' ||
      this.boltCycleTimer >= 0 ||
      this.pumpCycleTimer >= 0
    ) {
      return false;
    }
    this.cancelMicroAction();
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }
    this.restoreMagazineHome();
    this.suppressorPreActionVisible = this.assembly.suppressor.visible;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.suppressorHandoffBlend = 0;
    this._suppTwistSample.cumulativeAngle01 = 0;
    this._suppTwistSample.axial01 = 0;
    this._suppTwistSample.wristRollRad = 0;
    this._suppTwistSample.gripRelease01 = 0;
    this._suppTwistSample.weaponCounterRollRad = 0;
    this.suppressorOnComplete = onComplete ?? null;
    this.action = attach ? 'SUPPRESSOR_ATTACH' : 'SUPPRESSOR_DETACH';
    this.actionTime = 0;
    this.actionDuration = Math.max(1.8, durationSec);
    this.emitCue('ads_rustle', 0.78);
    return true;
  }

  /** Trigger fluid ~3.2s 3-phase Weapon Inspect (`I` key) */
  public triggerInspect(): boolean {
    if (
      !this.assembly ||
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.isSuppressorActionActive() ||
      this.tubularPhase !== 'NONE'
    ) {
      return false;
    }
    this.cancelMicroAction();
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

  private resolveChamberCycleStyle(): ChamberCyclePlatformStyle {
    const asm = this.assembly;
    if (!asm) return 'ar_charging_handle';
    if (asm.cylinderPivot) return 'revolver_cylinder';
    if (asm.boltHandlePivot) return 'bolt_action';
    if (asm.pumpForend) return 'pump_shotgun';
    const vs = asm.visualStyle ?? '';
    if (vs === 'MP5RollerSMG') return 'mp5_cocking_tube';
    if (
      vs === 'carbine_ak' ||
      vs === 'rifle_ak' ||
      vs === 'AKStamped' ||
      vs === 'SovietDMR'
    ) {
      return 'ak_side_bolt';
    }
    if (this.weightClass === 'pistol' || asm.holdClass === 'pistol') {
      return 'pistol_slide';
    }
    return 'ar_charging_handle';
  }

  /**
   * Triggers a detailed, platform-authentic manual chamber cycle (`Y` key):
   * tilts the firearm cleanly toward the chest-cam, racks the slide/charging handle/bolt/pump
   * to full rearward travel, fires `onExtractApex` at extraction peak, and snaps smoothly back to battery.
   */
  public triggerChamberCycle(opts: WeaponChamberCycleOptions): boolean {
    if (
      !this.assembly ||
      this.assembly.holdClass === 'unarmed' ||
      this.assembly.holdClass === 'melee_1h' ||
      this.assembly.holdClass === 'melee_2h' ||
      this.assembly.holdClass === 'throwable'
    ) {
      return false;
    }
    if (
      this.action === 'RELOAD' ||
      this.action === 'MAG_CHECK' ||
      this.action === 'CHAMBER_CYCLE' ||
      this.isSuppressorActionActive() ||
      this.tubularPhase !== 'NONE' ||
      this.boltCycleTimer >= 0 ||
      this.pumpCycleTimer >= 0
    ) {
      return false;
    }
    this.cancelMicroAction();
    if (this.action === 'INSPECT') {
      this.interruptInspect();
    }

    const style = this.resolveChamberCycleStyle();
    this.chamberCycleStyle = style;
    this.chamberCycleHasLiveRound = opts.hasLiveRound;
    this.chamberCycleOpenCueFired = false;
    this.chamberCycleExtractFired = false;
    this.chamberCycleCloseCueFired = false;
    this.chamberCyclePump01 = 0;
    this.chamberCycleBoltRotZ = 0;
    this.chamberCycleOnExtractApex = opts.onExtractApex ?? null;
    this.chamberCycleOnComplete = opts.onComplete ?? null;

    const defaultDur =
      style === 'bolt_action'
        ? 0.96
        : style === 'pistol_slide'
          ? 0.78
          : style === 'pump_shotgun'
            ? 0.76
            : style === 'revolver_cylinder'
              ? 0.88
              : 0.86;

    this.action = 'CHAMBER_CYCLE';
    this.actionTime = 0;
    this.actionDuration = Math.max(0.55, opts.durationSec ?? defaultDur);
    this.emitCue('ads_rustle', 0.68);
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
    if (this.tubularPhase !== 'NONE') {
      this.abortTubularReloadImmediate();
    }
    this.cancelMicroAction();
    if (this.isSuppressorActionActive()) {
      this.restoreSuppressorHome(this.suppressorPreActionVisible);
    }
    this.suppressorOnComplete = null;
    this.suppressorInHand = false;
    this.suppressorTwistPhase01 = 0;
    this.suppressorCueMask = 0;
    this.suppressorHandoffBlend = 0;
    this._suppTwistSample.wristRollRad = 0;
    this._suppTwistSample.gripRelease01 = 0;
    this._suppTwistSample.weaponCounterRollRad = 0;
    this.chamberCycleOnExtractApex = null;
    this.chamberCycleOnComplete = null;
    this.chamberCyclePump01 = 0;
    this.chamberCycleBoltRotZ = 0;
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
    this.suppressorHandoffBlend = 0;
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

  /** Safely returns the physical shotgun reload shell back hidden inside the weapon group */
  public restoreReloadShellHome(): void {
    const shell = this.assembly?.reloadShellMesh;
    if (!shell || !this.assembly) return;
    if (shell.parent !== this.assembly.group) {
      this.assembly.group.add(shell);
    }
    shell.visible = false;
    shell.position.set(0, 0, 0);
    shell.rotation.set(0, 0, 0);
  }

  /**
   * Called by CharacterAnimator to physically hold `assembly.reloadShellMesh` in `handL`
   * during shell-by-shell tubular shotgun reloads.
   */
  public syncPhysicalShellParent(leftHandRoot: THREE.Object3D): void {
    const shell = this.assembly?.reloadShellMesh;
    if (!shell || !this.assembly) return;

    if (this.tubularPhase !== 'NONE' && this.tubularShellInHand) {
      if (shell.parent !== leftHandRoot) {
        leftHandRoot.add(shell);
        shell.position.set(0.008, -0.020, -0.044);
        shell.rotation.set(0, 0, 0);
      }
      shell.visible = true;
    } else if (shell.visible || shell.parent !== this.assembly.group) {
      this.restoreReloadShellHome();
    }
  }

  /**
   * Called by CharacterAnimator to physically parent `assembly.suppressor` into `handL`
   * while stowing to / retrieving from the chest pouch, preserving world-space continuity on handoff
   * (zero visual pop!) and re-parenting cleanly to `muzzleMountSocket` for coaxial threading.
   */
  public syncPhysicalSuppressorParent(leftHandRoot: THREE.Object3D, dt = 0.016): void {
    const supp = this.assembly?.suppressor;
    if (!supp || !this.assembly) return;

    if (this.isSuppressorActionActive() && this.suppressorInHand) {
      if (supp.parent !== leftHandRoot) {
        if (this.action === 'SUPPRESSOR_DETACH') {
          // Seamless world-space handoff off muzzle threads into left palm (zero pop!)
          supp.updateWorldMatrix(true, false);
          leftHandRoot.updateWorldMatrix(true, false);
          leftHandRoot.attach(supp);
          this.suppressorHandoffBlend = 0;
        } else {
          // Emerging from chest pouch into left palm
          leftHandRoot.add(supp);
          supp.position.copy(this._suppPalmTargetPos);
          supp.quaternion.copy(this._suppPalmTargetQuat);
          supp.scale.set(1, 1, 1);
          this.suppressorHandoffBlend = 1;
        }
      } else if (this.action === 'SUPPRESSOR_DETACH' && this.suppressorHandoffBlend < 1) {
        // Smoothly settle suppressor into natural palm carry during travel to chest pouch
        this.suppressorHandoffBlend = Math.min(1, this.suppressorHandoffBlend + dt * 7.5);
        const alpha = 1 - Math.exp(-14 * dt);
        supp.position.lerp(this._suppPalmTargetPos, alpha);
        supp.quaternion.slerp(this._suppPalmTargetQuat, alpha);
      }
      const p = this.getActionProgress();
      if (this.action === 'SUPPRESSOR_DETACH') {
        supp.visible = p < 0.83;
      } else {
        supp.visible = p >= 0.20;
      }
    } else if (supp.parent !== this.assembly.muzzleMountSocket) {
      const homeZ = typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;
      this.assembly.muzzleMountSocket.add(supp);
      if (this.action === 'SUPPRESSOR_ATTACH') {
        // Coaxial alignment right ahead of barrel threads before engaging 3-stroke thread-on
        supp.position.set(0, 0, homeZ - SUPPRESSOR_THREAD_TRAVEL_M - SUPPRESSOR_CLEAR_PULL_M);
        supp.rotation.set(0, 0, 0);
      } else {
        supp.position.set(0, 0, homeZ);
        supp.rotation.set(0, 0, 0);
      }
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
      const p = this.getActionProgress();
      if (mag.parent !== leftHandRoot) {
        leftHandRoot.add(mag);
        // Seat magazine cleanly inside the left gloved palm (-Z is finger forward, -Y is palm face)
        mag.position.set(0.008, -0.028, -0.044);
        mag.rotation.set(Math.PI * 0.45, 0.15, -Math.PI * 0.42);
      }
      // Subtle rock-and-lock pitch cant for AK magazines entering receiver
      const style = this.assembly.visualStyle;
      if ((style === 'carbine_ak' || style === 'rifle_ak' || style === 'AKStamped' || style === 'SovietDMR') && p > 0.50) {
        const rock = Math.sin(smoothstep(0.50, 0.63, p) * Math.PI) * 0.28;
        mag.rotation.set(Math.PI * 0.45 - rock, 0.15, -Math.PI * 0.42);
      }
      // Briefly hide spent mag right inside the chest rig pouch during the split-second mag swap
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
    this.chamberCyclePump01 = 0;
    this.chamberCycleBoltRotZ = 0;

    // 1. Advance active weapon action (RELOAD / MAG_CHECK / INSPECT) + synced audio beats
    if (this.action !== 'NONE') {
      const speed = this.action === 'RELOAD' ? Math.max(0.5, reloadSpeedMult) : 1.0;
      this.actionTime += dt * speed;
      const p = this.getActionProgress();

      if (this.action === 'RELOAD') {
        const platformStyle = this.getReloadPlatformStyle();
        const isHkSlap = platformStyle === 'mp5_hk_slap';
        const arBoltCatch = platformStyle === 'ar_bolt_catch';
        const isPistol = platformStyle === 'pistol_cant';
        const isAk = platformStyle === 'ak_rock_lock';

        // MP5 empty reload Phase 0 (0.00..0.14): lock cocking handle back and up into H&K detent notch
        if (isHkSlap) {
          if (p < 0.14) {
            this.manualBoltPull01 = smoothstep(0.02, 0.12, p);
          } else if (p < 0.75) {
            this.manualBoltPull01 = 1.0;
          }
          if (!this.reloadCueHkLockFired && p >= 0.10) {
            this.reloadCueHkLockFired = true;
            this.isBoltLockedOpen = true;
            this.emitCue('rack', 0.85);
            this.pushMechanicalImpulse(0, 0.015, 0.045, 0.08, 0.04, 0.10);
          }
        }

        const outBeat = isHkSlap ? 0.21 : 0.16;
        if (!this.reloadCueOutFired && p >= outBeat) {
          this.reloadCueOutFired = true;
          this.magazineDetachedInHand = true;
          this.emitCue('mag_out', 1.0);
          this.pushMechanicalImpulse(0, -0.022, 0.01, -0.05, 0, -0.04);
        }
        if (!this.reloadCueInFired && p >= 0.63) {
          this.reloadCueInFired = true;
          this.magazineDetachedInHand = false;
          this.restoreMagazineHome();
          // Crisp upward baseplate palm-tap impulse on pistols & firm magwell seat jolt on rifles
          const tapBoost = isPistol ? 0.34 : isAk ? 0.28 : 0.24;
          this.magSeatImpulseVel += tapBoost;
          this.pushMechanicalImpulse(
            0,
            isPistol ? 0.095 : 0.068,
            -0.018,
            isPistol ? 0.18 : 0.12,
            0,
            isAk ? 0.14 : 0.06,
          );
          this.emitCue('mag_in', isPistol ? 1.12 : 1.05);
        }
        if (!this.reloadCueRackFired && p >= (isHkSlap ? 0.75 : 0.72)) {
          this.reloadCueRackFired = true;
          if (isHkSlap) {
            // Authentic H&K Slap: violent downward palm strike pops cocking handle out of detent notch!
            this.isBoltLockedOpen = false;
            this.manualBoltPull01 = 0;
            this.magSeatImpulseVel -= 0.24;
            this.pushMechanicalImpulse(0.032, -0.145, -0.055, -0.26, 0.08, -0.28);
            this.emitCue('bolt_lock', 1.18);
          } else if (arBoltCatch) {
            // AR-15/AR-10/HK416 empty bolt-catch paddle slap releases carrier instantaneously
            this.isBoltLockedOpen = false;
            this.magSeatImpulseVel += 0.12;
            this.pushMechanicalImpulse(0.055, -0.02, -0.035, -0.09, -0.14, -0.16);
            this.emitCue('bolt_lock', 1.04);
          } else {
            this.pushMechanicalImpulse(0, -0.025, 0.055, 0.07, 0.05, 0.08);
            this.emitCue('rack', 1.0);
          }
        }
        // Asymmetric physical charging-handle / slide rack movement (p: 0.70 -> 0.86)
        if (!arBoltCatch && !isHkSlap && p >= 0.70 && p <= 0.86) {
          const r = (p - 0.70) / 0.16;
          if (r < 0.50) {
            // Anticipation -> crisp rearward pull to mechanical stop
            const pull = Math.pow(smoothstep(0.0, 0.50, r), 0.85);
            this.manualBoltPull01 = pull;
          } else if (r < 0.62) {
            // Brief tactile dwell at mechanical rear stop
            this.manualBoltPull01 = 1.0;
          } else {
            // Violent spring-driven snap forward into battery
            this.isBoltLockedOpen = false;
            this.manualBoltPull01 = 1 - Math.pow(smoothstep(0.62, 1.0, r), 1.35);
          }
        } else if (isHkSlap && p >= 0.75 && p <= 0.81) {
          // Ultra-fast roller-delayed bolt slam home after the H&K palm slap
          const slam = smoothstep(0.75, 0.81, p);
          this.manualBoltPull01 = 1 - slam;
        }
        if (p >= 1.0) {
          this.isBoltLockedOpen = false;
          this.reloadCueHkLockFired = false;
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
      } else if (this.action === 'CHAMBER_CYCLE') {
        // Detailed 4-beat manual chamber cycle choreography:
        //  0.00 -> 0.22: Present ejection port & action cleanly toward chest-cam
        //  0.22 -> 0.54: Firm rearward draw to mechanical stop (with brief chamber-check dwell)
        //  ~0.50: Extraction apex -> eject intact live round (if chambered) + mechanical recoil jolt
        //  0.54 -> 0.78: Crisp spring-driven return to battery + bolt lock-up impulse
        //  0.78 -> 1.00: Smooth recovery to ready posture
        const style = this.chamberCycleStyle;

        if (style === 'bolt_action') {
          if (p < 0.24) {
            this.chamberCycleBoltRotZ = -smoothstep(0.10, 0.24, p) * 1.05;
            if (!this.chamberCycleOpenCueFired && p >= 0.14) {
              this.chamberCycleOpenCueFired = true;
              this.emitCue('bolt_open', 0.95);
              this.pushMechanicalImpulse(0.014, 0.016, 0.012, 0.04, -0.04, 0.08);
            }
          } else if (p < 0.54) {
            this.chamberCycleBoltRotZ = -1.05;
            this.manualBoltPull01 = Math.pow(smoothstep(0.24, 0.50, p), 0.88);
            if (!this.chamberCycleExtractFired && p >= 0.47) {
              this.chamberCycleExtractFired = true;
              this.emitCue('bolt_pull', 0.96);
              this.pushMechanicalImpulse(0.018, 0.012, 0.055, 0.06, 0.04, 0.07);
              if (this.chamberCycleHasLiveRound && this.assembly) {
                this.assembly.group.updateMatrixWorld(true);
                this.assembly.ejectionPortSocket.getWorldPosition(this._chamberEjectPos);
                this.assembly.ejectionPortSocket.getWorldQuaternion(this._chamberEjectQuat);
                this.chamberCycleOnExtractApex?.(this._chamberEjectPos, this._chamberEjectQuat);
              }
            }
          } else if (p < 0.76) {
            this.chamberCycleBoltRotZ = -1.05;
            this.manualBoltPull01 = 1 - smoothstep(0.54, 0.74, p);
            this.isBoltLockedOpen = false;
            if (!this.chamberCycleCloseCueFired && p >= 0.58) {
              this.chamberCycleCloseCueFired = true;
              this.emitCue('bolt_push', 0.92);
            }
          } else {
            this.chamberCycleBoltRotZ = (1 - smoothstep(0.76, 0.88, p)) * -1.05;
            if (p >= 0.82 && p - (dt / Math.max(0.1, this.actionDuration)) < 0.82) {
              this.emitCue('bolt_lock', 0.98);
              this.pushMechanicalImpulse(-0.012, -0.018, -0.042, -0.06, 0.03, -0.07);
            }
          }
        } else if (style === 'revolver_cylinder') {
          if (!this.chamberCycleOpenCueFired && p >= 0.22) {
            this.chamberCycleOpenCueFired = true;
            this.emitCue('bolt_open', 0.85);
            const chambers = Math.max(1, this.assembly?.revolverChambers ?? 6);
            this.cylinderTargetAngle += (Math.PI * 2) / chambers;
            this.pushMechanicalImpulse(0.010, 0.014, 0.015, 0.05, 0.03, 0.09);
          }
          if (!this.chamberCycleExtractFired && p >= 0.50) {
            this.chamberCycleExtractFired = true;
            if (this.chamberCycleHasLiveRound && this.assembly) {
              this.assembly.group.updateMatrixWorld(true);
              this.assembly.ejectionPortSocket.getWorldPosition(this._chamberEjectPos);
              this.assembly.ejectionPortSocket.getWorldQuaternion(this._chamberEjectQuat);
              this.chamberCycleOnExtractApex?.(this._chamberEjectPos, this._chamberEjectQuat);
            }
          }
          if (!this.chamberCycleCloseCueFired && p >= 0.74) {
            this.chamberCycleCloseCueFired = true;
            this.isBoltLockedOpen = false;
            this.emitCue('bolt_lock', 0.92);
            this.pushMechanicalImpulse(-0.008, -0.014, -0.025, -0.05, -0.03, -0.06);
          }
        } else {
          // Slide / AR Charging Handle / AK Side-Bolt / MP5 Cocking Tube / Pump Forend
          let travel = 0;
          if (p >= 0.20 && p < 0.50) {
            travel = Math.pow(smoothstep(0.20, 0.48, p), 0.85);
          } else if (p >= 0.50 && p < 0.58) {
            // Brief tactile dwell at full rear lock so operator visually confirms chamber extraction
            travel = 1.0;
          } else if (p >= 0.58 && p < 0.76) {
            this.isBoltLockedOpen = false;
            travel = 1 - Math.pow(smoothstep(0.58, 0.76, p), 1.35);
          }

          if (style === 'pump_shotgun') {
            this.chamberCyclePump01 = travel;
            this.manualBoltPull01 = travel * 0.92;
          } else {
            this.manualBoltPull01 = travel;
          }

          if (!this.chamberCycleOpenCueFired && p >= 0.24) {
            this.chamberCycleOpenCueFired = true;
            this.emitCue('rack', style === 'pistol_slide' ? 0.88 : 0.98);
            this.pushMechanicalImpulse(0, -0.012, 0.048, 0.06, 0.04, 0.08);
          }
          if (!this.chamberCycleExtractFired && p >= 0.49) {
            this.chamberCycleExtractFired = true;
            this.pushMechanicalImpulse(0.015, 0.010, 0.032, 0.05, 0.03, 0.06);
            if (this.chamberCycleHasLiveRound && this.assembly) {
              this.assembly.group.updateMatrixWorld(true);
              this.assembly.ejectionPortSocket.getWorldPosition(this._chamberEjectPos);
              this.assembly.ejectionPortSocket.getWorldQuaternion(this._chamberEjectQuat);
              this.chamberCycleOnExtractApex?.(this._chamberEjectPos, this._chamberEjectQuat);
            }
          }
          if (!this.chamberCycleCloseCueFired && p >= 0.70) {
            this.chamberCycleCloseCueFired = true;
            this.isBoltLockedOpen = false;
            this.emitCue('bolt_lock', style === 'pistol_slide' ? 0.92 : 1.04);
            this.pushMechanicalImpulse(-0.012, -0.022, -0.052, -0.08, -0.03, -0.09);
          }
        }

        if (p >= 1.0) {
          const cb = this.chamberCycleOnComplete;
          this.chamberCycleOnExtractApex = null;
          this.chamberCycleOnComplete = null;
          this.chamberCyclePump01 = 0;
          this.chamberCycleBoltRotZ = 0;
          this.isBoltLockedOpen = false;
          this.action = 'NONE';
          this.actionTime = 0;
          cb?.();
        }
      } else if (this.action === 'SUPPRESSOR_DETACH' || this.action === 'SUPPRESSOR_ATTACH') {
        const isAttach = this.action === 'SUPPRESSOR_ATTACH';
        const supp = this.assembly?.suppressor;
        const homeZ = supp && typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;

        if (!isAttach) {
          // DETACH (2.45s): 0.00-0.10 TILT -> 0.10-0.21 REACH -> 0.21-0.61 3x RATCHET TWIST -> 0.61-0.67 CLEAR_PULL -> 0.67-0.86 STOW -> 0.86-1.00 RETURN
          if (p >= 0.215 && (this.suppressorCueMask & 1) === 0) {
            this.suppressorCueMask |= 1;
            this.emitCue('suppressor_lock', 0.86);
          }
          if (p >= 0.225 && (this.suppressorCueMask & 2) === 0) {
            this.suppressorCueMask |= 2;
            this.emitCue('suppressor_twist', 0.96);
          }
          if (p >= 0.358 && (this.suppressorCueMask & 4) === 0) {
            this.suppressorCueMask |= 4;
            this.emitCue('suppressor_twist', 0.92);
          }
          if (p >= 0.492 && (this.suppressorCueMask & 8) === 0) {
            this.suppressorCueMask |= 8;
            this.emitCue('suppressor_twist', 0.86);
          }
          if (p >= 0.80 && (this.suppressorCueMask & 16) === 0) {
            this.suppressorCueMask |= 16;
            this.emitCue('ads_rustle', 0.78);
          }

          if (p < 0.61) {
            this.suppressorInHand = false;
            const twistT = THREE.MathUtils.clamp((p - 0.21) / 0.40, 0, 1);
            this.suppressorTwistPhase01 = twistT;
            if (p >= 0.21) {
              evalRatchetedSuppressorTwist(twistT, false, this._suppTwistSample);
            } else {
              this._suppTwistSample.cumulativeAngle01 = 0;
              this._suppTwistSample.axial01 = 0;
              this._suppTwistSample.wristRollRad = 0;
              this._suppTwistSample.gripRelease01 = 0;
              this._suppTwistSample.weaponCounterRollRad = 0;
            }
            if (supp && supp.parent === this.assembly?.muzzleMountSocket) {
              supp.visible = true;
              supp.position.set(
                0,
                0,
                homeZ - this._suppTwistSample.axial01 * SUPPRESSOR_THREAD_TRAVEL_M,
              );
              supp.rotation.set(0, 0, -this._suppTwistSample.cumulativeAngle01 * SUPPRESSOR_TOTAL_RAD);
            }
          } else if (p < 0.67) {
            // Clear-pull: slide suppressor straight forward off the muzzle crown before detaching to left hand
            this.suppressorInHand = false;
            this.suppressorTwistPhase01 = 1;
            const clearT = smoothstep(0.61, 0.67, p);
            this._suppTwistSample.wristRollRad = 0;
            this._suppTwistSample.gripRelease01 = 0;
            this._suppTwistSample.weaponCounterRollRad = 0;
            if (supp && supp.parent === this.assembly?.muzzleMountSocket) {
              supp.visible = true;
              supp.position.set(
                0,
                0,
                homeZ - SUPPRESSOR_THREAD_TRAVEL_M - clearT * SUPPRESSOR_CLEAR_PULL_M,
              );
              supp.rotation.set(0, 0, -SUPPRESSOR_TOTAL_RAD);
            }
          } else {
            this.suppressorInHand = p < 0.86;
            this.suppressorTwistPhase01 = 1;
            this._suppTwistSample.wristRollRad = 0;
            this._suppTwistSample.gripRelease01 = p >= 0.83 ? 0.6 : 0;
            this._suppTwistSample.weaponCounterRollRad = 0;
            if (supp && !this.suppressorInHand) {
              this.restoreSuppressorHome(false);
            }
          }
        } else {
          // ATTACH (2.45s): 0.00-0.10 TILT -> 0.10-0.28 POUCH -> 0.28-0.40 REACH_MUZZLE -> 0.40-0.44 SEAT_THREADS -> 0.44-0.84 3x RATCHET TWIST -> 0.84-1.00 RETURN
          if (p >= 0.20 && (this.suppressorCueMask & 1) === 0) {
            this.suppressorCueMask |= 1;
            this.emitCue('ads_rustle', 0.78);
          }
          if (p >= 0.455 && (this.suppressorCueMask & 2) === 0) {
            this.suppressorCueMask |= 2;
            this.emitCue('suppressor_twist', 0.88);
          }
          if (p >= 0.588 && (this.suppressorCueMask & 4) === 0) {
            this.suppressorCueMask |= 4;
            this.emitCue('suppressor_twist', 0.94);
          }
          if (p >= 0.722 && (this.suppressorCueMask & 8) === 0) {
            this.suppressorCueMask |= 8;
            this.emitCue('suppressor_twist', 1.0);
          }
          if (p >= 0.825 && (this.suppressorCueMask & 16) === 0) {
            this.suppressorCueMask |= 16;
            this.emitCue('suppressor_lock', 1.05);
          }

          if (p < 0.40) {
            this.suppressorInHand = p >= 0.20;
            this.suppressorTwistPhase01 = 0;
            this._suppTwistSample.wristRollRad = 0;
            this._suppTwistSample.gripRelease01 = p < 0.20 ? 0.55 : 0;
            this._suppTwistSample.weaponCounterRollRad = 0;
          } else if (p < 0.44) {
            // Coaxial alignment slide onto barrel crown threads
            this.suppressorInHand = false;
            this.suppressorTwistPhase01 = 0;
            const seatT = smoothstep(0.40, 0.44, p);
            this._suppTwistSample.wristRollRad = THREE.MathUtils.lerp(0, -0.58, seatT);
            this._suppTwistSample.gripRelease01 = 0;
            this._suppTwistSample.weaponCounterRollRad = 0;
            if (supp) {
              if (supp.parent !== this.assembly?.muzzleMountSocket) {
                this.assembly?.muzzleMountSocket.add(supp);
              }
              supp.visible = true;
              supp.position.set(
                0,
                0,
                homeZ - SUPPRESSOR_THREAD_TRAVEL_M - (1 - seatT) * SUPPRESSOR_CLEAR_PULL_M,
              );
              supp.rotation.set(0, 0, 0);
            }
          } else {
            this.suppressorInHand = false;
            const twistT = THREE.MathUtils.clamp((p - 0.44) / 0.40, 0, 1);
            this.suppressorTwistPhase01 = twistT;
            evalRatchetedSuppressorTwist(twistT, true, this._suppTwistSample);
            if (supp) {
              if (supp.parent !== this.assembly?.muzzleMountSocket) {
                this.assembly?.muzzleMountSocket.add(supp);
              }
              supp.visible = true;
              supp.position.set(
                0,
                0,
                homeZ - (1 - this._suppTwistSample.axial01) * SUPPRESSOR_THREAD_TRAVEL_M,
              );
              supp.rotation.set(0, 0, this._suppTwistSample.cumulativeAngle01 * SUPPRESSOR_TOTAL_RAD);
            }
          }
        }

        if (p >= 1.0) {
          const cb = this.suppressorOnComplete;
          this.suppressorOnComplete = null;
          this.suppressorInHand = false;
          this.suppressorTwistPhase01 = 0;
          this.suppressorCueMask = 0;
          this._suppTwistSample.wristRollRad = 0;
          this._suppTwistSample.gripRelease01 = 0;
          this._suppTwistSample.weaponCounterRollRad = 0;
          this.restoreSuppressorHome(isAttach);
          this.action = 'NONE';
          this.actionTime = 0;
          cb?.(isAttach);
        }
      }
    }

    // 1b. Advance shell-by-shell tubular shotgun reload state machine
    this.tubularPumpOpen01 = 0;
    if (this.tubularPhase !== 'NONE') {
      const speed = Math.max(0.5, reloadSpeedMult);
      this.tubularPhaseTime += dt * speed;
      const tp = this.getTubularPhaseProgress();

      if (this.tubularPhase === 'OPEN_BREECH') {
        this.tubularPumpOpen01 = smoothstep(0.15, 0.85, tp);
        if (tp >= 0.25 && this.tubularPhaseTime - dt * speed < this.tubularPhaseDuration * 0.25) {
          this.emitCue('rack', 0.88);
        }
        if (tp >= 1) {
          this.tubularPhase = 'BREECH_LOAD';
          this.tubularPhaseTime = 0;
          this.tubularPhaseDuration = 0.44;
          this.tubularShellInsertedThisCycle = false;
        }
      } else if (this.tubularPhase === 'BREECH_LOAD') {
        this.tubularPumpOpen01 = 1;
        this.tubularShellInHand = tp >= 0.22 && tp < 0.78;
        if (!this.tubularShellInsertedThisCycle && tp >= 0.78) {
          this.tubularShellInsertedThisCycle = true;
          this.tubularShellsRemaining = Math.max(0, this.tubularShellsRemaining - 1);
          this.tubularShellsLoaded++;
          this.magSeatImpulseVel += 0.14;
          this.emitCue('mag_in', 0.82);
          this.tubularOnShellInserted?.();
        }
        if (tp >= 1) {
          this.tubularShellInHand = false;
          this.tubularPhase = 'CLOSE_BREECH';
          this.tubularPhaseTime = 0;
          this.tubularPhaseDuration = 0.22;
        }
      } else if (this.tubularPhase === 'CLOSE_BREECH') {
        this.tubularPumpOpen01 = 1 - smoothstep(0.1, 0.85, tp);
        if (tp >= 0.35 && this.tubularPhaseTime - dt * speed < this.tubularPhaseDuration * 0.35) {
          this.emitCue('bolt_lock', 0.96);
        }
        if (tp >= 1) {
          this.tubularPumpOpen01 = 0;
          if (this.tubularInterruptRequested || this.tubularShellsRemaining <= 0) {
            this.tubularPhase = 'EXIT';
            this.tubularPhaseTime = 0;
            this.tubularPhaseDuration = 0.16;
          } else {
            this.tubularPhase = 'FEED_SHELL';
            this.tubularPhaseTime = 0;
            this.tubularPhaseDuration = 0.42;
            this.tubularShellInsertedThisCycle = false;
          }
        }
      } else if (this.tubularPhase === 'ENTER') {
        if (tp >= 1) {
          this.tubularPhase = 'FEED_SHELL';
          this.tubularPhaseTime = 0;
          this.tubularPhaseDuration = 0.42;
          this.tubularShellInsertedThisCycle = false;
        }
      } else if (this.tubularPhase === 'FEED_SHELL') {
        this.tubularShellInHand = tp >= 0.18 && tp < 0.74;
        if (!this.tubularShellInsertedThisCycle && tp >= 0.74) {
          this.tubularShellInsertedThisCycle = true;
          this.tubularShellsRemaining = Math.max(0, this.tubularShellsRemaining - 1);
          this.tubularShellsLoaded++;
          this.magSeatImpulseVel += 0.12;
          this.emitCue('mag_in', 0.76);
          this.tubularOnShellInserted?.();
        }
        if (tp >= 1) {
          this.tubularShellInHand = false;
          if (this.tubularInterruptRequested || this.tubularShellsRemaining <= 0) {
            this.tubularPhase = 'EXIT';
            this.tubularPhaseTime = 0;
            this.tubularPhaseDuration = 0.16;
          } else {
            this.tubularPhaseTime = 0;
            this.tubularShellInsertedThisCycle = false;
          }
        }
      } else if (this.tubularPhase === 'EXIT') {
        this.tubularShellInHand = false;
        if (tp >= 1) {
          const cb = this.tubularOnComplete;
          this.tubularPhase = 'NONE';
          this.tubularPhaseTime = 0;
          this.tubularOnShellInserted = null;
          this.tubularOnComplete = null;
          this.restoreReloadShellHome();
          cb?.();
        }
      }
    }

    // 1c. Advance non-blocking firearm handling micro-actions + physical selector/dial rotation
    if (this.microAction !== 'NONE') {
      this.microActionTime += dt;
      if (this.microActionTime >= this.microActionDuration) {
        this.microAction = 'NONE';
        this.microActionTime = 0;
      }
    }
    this.selectorAngleCurrent = THREE.MathUtils.damp(
      this.selectorAngleCurrent,
      this.selectorAngleTarget,
      28,
      dt,
    );
    this.illumDialAngleCurrent = THREE.MathUtils.damp(
      this.illumDialAngleCurrent,
      this.illumDialAngleTarget,
      22,
      dt,
    );

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

    // 4. Shotgun two-stage asymmetric ADS-persistent pump-action forend + bolt cycle (after shot)
    //    0.04s recoil unlock -> 0.12s crisp rearward extraction + apex hull ejection -> 0.04s dwell -> 0.13s forward lockup
    let pump01 = this.tubularPumpOpen01;
    if (this.pumpCycleTimer >= 0) {
      this.pumpCycleTimer += dt;
      const t = this.pumpCycleTimer;
      if (t >= 0.33) {
        this.pumpCycleTimer = -1;
        this.pumpEjectPending = false;
      } else if (t > 0.035) {
        if (t < 0.15) {
          // Stage 1: sharp asymmetric rearward extraction + receiver counter-pull impulse
          pump01 = Math.max(pump01, Math.pow(smoothstep(0.035, 0.15, t), 0.82));
          if (!this.pumpRackBackCueFired && t >= 0.055) {
            this.pumpRackBackCueFired = true;
            this.pushMechanicalImpulse(0, 0.018, 0.085, 0.11, 0, -0.09);
            this.emitCue('rack', 0.92);
          }
        } else if (t < 0.195) {
          // Apex mechanical stop dwell + spent hull ejection
          pump01 = 1;
          if (this.pumpEjectPending) {
            this.pumpEjectPending = false;
            this.spawnCasingAndSmoke(this.pumpCycleSuppressed);
          }
        } else {
          // Stage 2: decisive forward chamber lockup + forward-downward spring jolt
          pump01 = Math.max(pump01, 1 - Math.pow(smoothstep(0.195, 0.325, t), 1.25));
          if (!this.pumpRackFwdCueFired && t >= 0.235) {
            this.pumpRackFwdCueFired = true;
            this.magSeatImpulseVel += 0.11;
            this.pushMechanicalImpulse(0, -0.028, -0.095, -0.13, 0, 0.08);
            this.emitCue('bolt_lock', 0.96);
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
      this.boltCycleOffsetZ = Math.max(boltCycle01, this.action === 'CHAMBER_CYCLE' ? this.manualBoltPull01 : 0) * asm.slideTravelZ;
      const effectivePump01 = Math.max(pump01, this.chamberCyclePump01);
      const finalBolt01 = Math.max(blowback01, locked01, this.manualBoltPull01, effectivePump01 * 0.95, boltCycle01);
      if (asm.slideOrBolt) {
        asm.slideOrBolt.position.z = asm.slideBaseZ + finalBolt01 * asm.slideTravelZ;
      }
      if (asm.chargingHandle) {
        // Non-reciprocating charging handles (AR-15 / AR-10 / HK416 / MCX) stay locked forward
        // during blowback and bolt lockback, pulling rearward only on manual reload/chamber rack.
        asm.chargingHandle.position.z =
          asm.chargingHandleBaseZ + this.manualBoltPull01 * asm.slideTravelZ;
      }
      if (asm.boltHandlePivot) {
        asm.boltHandlePivot.rotation.z =
          this.action === 'CHAMBER_CYCLE' ? this.chamberCycleBoltRotZ : boltHandleRotZ;
      }
      if (asm.barrelBreakGroup) {
        // Top-break revolver hinge (Webley Mk VI): tilts barrel, rib, sights & cylinder downward as one unit during RELOAD or CHAMBER_CYCLE
        let break01 = 0;
        if (this.action === 'RELOAD') {
          const p = this.getActionProgress();
          const openEnv = smoothstep(0.10, 0.24, p);
          const closeEnv = 1 - smoothstep(0.68, 0.82, p);
          break01 = openEnv * closeEnv;
        } else if (this.action === 'CHAMBER_CYCLE' && this.chamberCycleStyle === 'revolver_cylinder') {
          const p = this.getActionProgress();
          const openEnv = smoothstep(0.18, 0.36, p);
          const closeEnv = 1 - smoothstep(0.64, 0.80, p);
          break01 = openEnv * closeEnv * 0.72;
        }
        asm.barrelBreakGroup.rotation.x = -break01 * 0.82;
      }
      if (asm.cylinderPivot) {
        asm.cylinderPivot.rotation.z = this.cylinderAngle;
      }
      if (asm.pumpForend) {
        asm.pumpForend.position.z = asm.pumpBaseZ + effectivePump01 * 0.082;
      }
      if (asm.selectorLever) {
        asm.selectorLever.rotation.x = this.selectorAngleCurrent;
      }
      if (asm.illumDialMesh) {
        asm.illumDialMesh.rotation.z = this.illumDialAngleCurrent;
      }
      if (asm.hammer) {
        if (this.hammerTimer > 0) this.hammerTimer = Math.max(0, this.hammerTimer - dt);
        const hSnap = Math.sin((this.hammerTimer / 0.085) * Math.PI);
        asm.hammer.rotation.x = asm.hammerBaseRotX - hSnap * 0.72 + (this.isBoltLockedOpen ? 0.35 : 0);
      }
      if (asm.trigger) {
        if (this.triggerTimer > 0) this.triggerTimer = Math.max(0, this.triggerTimer - dt);
        const tPull = this.getTriggerPull01();
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

    // Emergency sprint / vault cancel during suppressor detach/reattach: cleanly restores pre-action mounted/stowed state
    if (this.isSuppressorActionActive() && (input.isSprinting || input.vaultRetentionBlend > 0.12)) {
      this.cancelAction();
    }

    // Sprint / vault cancels non-blocking handling micro-actions immediately
    if (this.microAction !== 'NONE' && (input.isSprinting || input.vaultRetentionBlend > 0.1)) {
      this.cancelMicroAction();
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
      this.action === 'CHAMBER_CYCLE' ||
      this.action === 'SUPPRESSOR_ATTACH' ||
      this.action === 'SUPPRESSOR_DETACH' ||
      this.tubularPhase !== 'NONE' ||
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
    const eyeRelief = Math.max(0.175, this.assembly ? this.assembly.adsEyeReliefM : 0.23);
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
      const platformStyle = this.getReloadPlatformStyle();
      const env = smoothstep(0.0, 0.14, p) * (1 - smoothstep(0.86, 1.0, p));
      const rackTilt = smoothstep(0.66, 0.75, p) * (1 - smoothstep(0.82, 0.90, p));
      // Platform-specific reload presentation angles:
      //  - Pistols: ~30° inward cant exposing grip magwell cleanly along grip-rake axis
      //  - MP5 H&K Slap: opens left cocking tube clearly at start (detent lock) & slap window (p ~ 0.75)
      //  - AR-15: ~28° cant exposing magwell & left bolt-catch paddle
      //  - AK: ~32° cant emphasizing front-lug rock-and-lock mag swap
      const baseCantRad =
        platformStyle === 'pistol_cant'
          ? THREE.MathUtils.degToRad(30)
          : platformStyle === 'mp5_hk_slap'
            ? THREE.MathUtils.degToRad(24) - rackTilt * 0.22
            : platformStyle === 'ar_bolt_catch'
              ? THREE.MathUtils.degToRad(28)
              : platformStyle === 'ak_rock_lock'
                ? THREE.MathUtils.degToRad(32)
                : 0.46;
      this._actionPos.set(
        this._hipPos.x - (platformStyle === 'pistol_cant' ? 0.035 : 0.045) * env,
        this._hipPos.y - 0.022 * env + rackTilt * 0.022,
        this._hipPos.z + (platformStyle === 'pistol_cant' ? 0.032 : 0.045) * env,
      );
      this._tmpEuler.set(
        (platformStyle === 'pistol_cant' ? 0.28 : 0.24) * env - 0.08 * rackTilt,
        (platformStyle === 'mp5_hk_slap' ? 0.34 : 0.28) * env + 0.12 * rackTilt,
        baseCantRad * env + 0.12 * rackTilt,
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
      const p = this.getActionProgress();
      const isMeleeKnife = this.assembly?.holdClass === 'melee_1h';
      if (isMeleeKnife) {
        // Combat Knife Slow Wrist-Roll Inspect (~3.2s):
        // Raise blade cleanly into chest-cam center, slowly roll wrist right-to-left to inspect both bevels & fuller, settle back
        const raiseEnv = smoothstep(0.0, 0.18, p) * (1 - smoothstep(0.80, 1.0, p));
        const wristRollSweep = smoothstep(0.22, 0.68, p);
        const rollDeg = THREE.MathUtils.lerp(48, -72, wristRollSweep);
        const yawDeg = THREE.MathUtils.lerp(42, 62, Math.sin(p * Math.PI));
        const pitchDeg = THREE.MathUtils.lerp(18, -10, wristRollSweep);
        const microDrift = Math.sin(p * Math.PI * 3) * 0.003;

        this._tmpVecA
          .set(
            THREE.MathUtils.lerp(0.045, 0.018, wristRollSweep),
            -0.068 + microDrift,
            -0.275,
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
      } else {
        // 3-Phase Fluid Weapon Inspect (~3.2s):
        //  Phase 1 (0.00 -> 0.36): Right receiver, ejection port & wear (+38° roll, +22° yaw)
        //  Phase 2 (0.36 -> 0.77): Left receiver, fire selector & optic mount (-42° roll, -15° yaw)
        //  Phase 3 (0.77 -> 1.00): Smooth return to Idle
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
      }
    } else if (this.action === 'CHAMBER_CYCLE' && input.isFirearm) {
      // Detailed Chest-Cam Manual Chamber Cycling Presentation:
      // Frames the ejection port, bolt/slide/charging handle, and extracting live cartridge crisply in view.
      const p = this.getActionProgress();
      const style = this.chamberCycleStyle;
      const env = smoothstep(0.0, 0.20, p) * (1 - smoothstep(0.80, 1.0, p));
      const rackAccent = smoothstep(0.22, 0.48, p) * (1 - smoothstep(0.58, 0.78, p));

      const rollDeg =
        style === 'pistol_slide'
          ? 34
          : style === 'ak_side_bolt'
            ? 38
            : style === 'mp5_cocking_tube'
              ? 24
              : style === 'bolt_action'
                ? 18
                : style === 'pump_shotgun'
                  ? 26
                  : style === 'revolver_cylinder'
                    ? 40
                    : 32;
      const yawDeg =
        style === 'pistol_slide'
          ? 24
          : style === 'bolt_action'
            ? 14
            : style === 'pump_shotgun'
              ? 18
              : 28;
      const pitchDeg = style === 'pistol_slide' ? 14 : style === 'bolt_action' ? 8 : 11;

      this._actionPos.set(
        this._hipPos.x - (style === 'pistol_slide' ? 0.042 : 0.056) * env,
        this._hipPos.y + (style === 'pistol_slide' ? 0.036 : 0.024) * env + rackAccent * 0.010,
        this._hipPos.z + (style === 'pistol_slide' ? 0.038 : 0.052) * env + rackAccent * 0.014,
      );
      this._tmpEuler.set(
        THREE.MathUtils.degToRad(pitchDeg) * env - rackAccent * 0.045,
        THREE.MathUtils.degToRad(yawDeg) * env + rackAccent * 0.06,
        THREE.MathUtils.degToRad(rollDeg) * env + rackAccent * 0.08,
        'YXZ',
      );
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    } else if (this.tubularPhase !== 'NONE' && input.isFirearm) {
      // Shell-by-shell tubular shotgun reload cant (38°-42° inboard so underside loading port faces left hand cleanly)
      let env = 1;
      const tp = this.getTubularPhaseProgress();
      if (this.tubularPhase === 'ENTER' || this.tubularPhase === 'OPEN_BREECH') {
        env = smoothstep(0, 0.85, tp);
      } else if (this.tubularPhase === 'EXIT') {
        env = 1 - smoothstep(0, 1, tp);
      }
      const isBreechPhase =
        this.tubularPhase === 'OPEN_BREECH' ||
        this.tubularPhase === 'BREECH_LOAD' ||
        this.tubularPhase === 'CLOSE_BREECH';
      const cantDeg = isBreechPhase ? -34 : 42;
      this._actionPos.set(
        this._hipPos.x - 0.055 * env,
        this._hipPos.y + (isBreechPhase ? 0.012 : 0.028) * env,
        this._hipPos.z + 0.045 * env,
      );
      this._tmpEuler.set(
        0.18 * env,
        0.26 * env,
        THREE.MathUtils.degToRad(cantDeg) * env,
        'YXZ',
      );
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    } else if (
      (this.action === 'SUPPRESSOR_ATTACH' || this.action === 'SUPPRESSOR_DETACH') &&
      input.isFirearm
    ) {
      // Field suppressor twist-and-stow workspace: tilt firearm ~35° inward and pull slightly closer
      // so the muzzle threads stay framed cleanly in front of the chest bodycam while the left hand works.
      const p = this.getActionProgress();
      const env = smoothstep(0.0, 0.10, p) * (1 - smoothstep(0.84, 1.0, p));
      const counterTorque =
        this.getSuppressorSubPhase() === 'TWIST_THREAD'
          ? this._suppTwistSample.weaponCounterRollRad
          : 0;
      const pullInZ = this.weightClass === 'pistol' ? 0.045 : 0.088;
      this._actionPos.set(
        this._hipPos.x - 0.075 * env,
        this._hipPos.y + 0.028 * env,
        this._hipPos.z + pullInZ * env,
      );
      this._tmpEuler.set(
        0.16 * env,
        0.44 * env,
        THREE.MathUtils.degToRad(35) * env + counterTorque,
        'YXZ',
      );
      this._actionQuat.copy(this._hipQuat).multiply(this._addQuat.setFromEuler(this._tmpEuler));
      this._targetPos.lerp(this._actionPos, env);
      this._targetQuat.slerp(this._actionQuat, env);
    }

    // Subtle ADS-persistent physical recoil-dip/cant during shotgun pump cycle (never breaks ADS cheek-weld!)
    if (this.pumpCycleTimer >= 0 && input.isFirearm) {
      const pp = this.getPumpCycleProgress();
      const pumpBump = Math.sin(pp * Math.PI);
      const adsScale = THREE.MathUtils.lerp(1.0, 0.42, this.adsBlend);
      this._tmpEuler.set(0.032 * pumpBump * adsScale, 0, -0.055 * pumpBump * adsScale, 'YXZ');
      this._targetQuat.multiply(this._addQuat.setFromEuler(this._tmpEuler));
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
    } else if (this.action === 'RELOAD' || this.tubularPhase !== 'NONE') {
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
    } else if (this.action === 'CHAMBER_CYCLE') {
      this.activePoseState = 'ChamberCycle';
      poseLambda = 13.5;
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

    // Coupled 6-DOF mass-tuned spring-damper motion offsets (camera turn drag, footstep cadence, landing compression, mechanical jolts)
    const springPosScale = THREE.MathUtils.lerp(1.0, 0.34, aimStab);
    const springPosX = (input.motionPosX ?? 0) * springPosScale;
    const springPosY = (input.motionPosY ?? 0) * springPosScale;
    const springPosZ = (input.motionPosZ ?? 0) * THREE.MathUtils.lerp(1.0, 0.42, aimStab);

    // Subtle organic figure-eight breath cadence (coupled smoothly with weapon weight & cheek-weld)
    const fig8Amp = 0.0024 * breathScale * opticRotScale;
    const fig8X = Math.sin(input.elapsed * 0.85) * fig8Amp;
    const fig8Y = Math.sin(input.elapsed * 1.70) * fig8Amp * 0.55;

    input.weaponPivot.position.set(
      this.dampedBasePos.x +
        walkSwingX +
        springPosX +
        fig8X +
        input.breathX * 0.28 * breathScale +
        misPosX +
        this.eyeBoxLagX * eyeLagScale +
        this._tmpVecA.x +
        this._tmpVecB.x,
      this.dampedBasePos.y +
        walkSwingY +
        settleY +
        springPosY +
        fig8Y +
        input.breathY * 0.28 * breathScale +
        misPosY +
        this.eyeBoxLagY * eyeLagScale +
        this.magSeatImpulseY +
        this._tmpVecA.y +
        this._tmpVecB.y,
      this.dampedBasePos.z + springPosZ + this._tmpVecA.z + this._tmpVecB.z,
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
    const coupledLagRoll =
      (input.lagRoll ?? 0) * THREE.MathUtils.lerp(0.85, 0.30, aimStab) * opticRotScale;
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
      muzzleRecRoll + input.sightMisalignRoll + adsLagRoll + coupledLagRoll + adsStrideRoll,
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

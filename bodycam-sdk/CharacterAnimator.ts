import * as THREE from 'three';
import { BodycamController } from './BodycamController';
import { CharacterSkeleton, HandPoseDynamicOptions } from './CharacterSkeleton';
import { IBodycamAudioSource } from './IBodycamAudioSource';
import {
  createTwoBoneIKResult,
  IKTargetBlender,
  orientLimbAlongYInRootSpace,
  setTransformInRootSpace,
  solveTwoBoneIK,
  TwoBoneIKResult,
} from './IKSolver';
import { SecondaryPhysicsRigApplier } from './physics/SecondaryPhysicsRigApplier';
import { TacticalGrenadeSystem } from './equipment/TacticalGrenadeSystem';
import { TacticalPdaDevice } from './TacticalPdaDevice';
import {
  BodycamMeleeAttackType,
  BodycamMeleeHitEvent,
  BodycamMeleeHitZone,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  BodycamTraumaModifiers,
  BodycamWeaponHoldClass,
  BodycamWeaponProfile,
  createMeleeHitEvent,
  createRaycastResult,
  IBodycamWorldAdapter,
} from './types';
import { WeaponRig } from './WeaponRig';
import { WeaponChamberCycleOptions } from './weapons/WeaponAnimator';

export type BodycamCombatMove =
  | 'NONE'
  | 'LEFT_JAB'
  | 'RIGHT_CROSS'
  | 'ARMED_BASH'
  | 'PUSH_KICK'
  | 'KNIFE_SLASH'
  | 'KNIFE_STAB';
export type BodycamKickTriggerResult = 'ok' | 'busy' | 'airborne' | 'dual_leg_trauma';

/**
 * Optional world-space IK hand override for diegetic interactions such as
 * two-handed Gun Wall weapon hang/grab swaps in the 3D Hideout.
 */
export interface ExternalHandIkOverride {
  active: boolean;
  rightWeight: number;
  rightWorldPos: THREE.Vector3;
  rightWorldQuat: THREE.Quaternion;
  rightGripCurl: number;
  leftWeight: number;
  leftWorldPos: THREE.Vector3;
  leftWorldQuat: THREE.Quaternion;
  leftGripCurl: number;
  suppressWeaponHardLock: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function easeOutQuart(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  const inv = 1 - x;
  return 1 - inv * inv * inv * inv;
}

const VALID_ACTOR_HIT_ZONES: ReadonlySet<string> = new Set([
  'head',
  'thorax',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
]);

function resolveHitZone(
  obj: THREE.Object3D | null,
  surface: BodycamSurfaceMaterial,
): BodycamMeleeHitZone {
  const ud = obj?.userData;
  const z = ud?.hitZone as string | undefined;
  if (z && VALID_ACTOR_HIT_ZONES.has(z)) {
    return z as BodycamMeleeHitZone;
  }
  if (ud?.doorId) return 'door';
  if (ud?.windowId || ud?.breakableGlass || ud?.isGlass || surface === 'glass') return 'glass';
  return 'world';
}

function isActorHitZone(zone: BodycamMeleeHitZone): boolean {
  return (
    zone === 'head' ||
    zone === 'thorax' ||
    zone === 'leftArm' ||
    zone === 'rightArm' ||
    zone === 'leftLeg' ||
    zone === 'rightLeg'
  );
}

/**
 * Self-contained AAA Procedural Full-Body Character Animator:
 *  - Per-foot stair/curb/ramp ground-height boot IK (boots plant individually on risers/slopes)
 *  - Grounded tactical Push-Kick (X) via right-leg 2-bone IK (usable unarmed or armed)
 *  - Orthodox chin/rib boxing guard, alternating Jab -> Cross kinetic chain, and armed V quick-bash
 *  - Visceral 28–32ms limb hitstop, chest-cam twist/lean-back overlay, and zero-GC spherecast dispatch
 *  - World-locked vault/mantle IK hand pinning & post-IK rigid firearm hard-lock
 *  - 100% decoupled from game-specific entities (reports contacts via IBodycamWorldAdapter.onMeleeHit)
 */
export class CharacterAnimator {
  private skeleton: CharacterSkeleton;
  private readonly weaponRig: WeaponRig;
  private audio?: IBodycamAudioSource;

  private readonly leftArmIK: TwoBoneIKResult = createTwoBoneIKResult();
  private readonly rightArmIK: TwoBoneIKResult = createTwoBoneIKResult();
  private readonly leftLegIK: TwoBoneIKResult = createTwoBoneIKResult();
  private readonly rightLegIK: TwoBoneIKResult = createTwoBoneIKResult();

  private readonly rightHandBlender = new IKTargetBlender();
  private readonly leftHandBlender = new IKTargetBlender();

  private lastWeaponId = '';
  private equipBlendTimer = 0;
  private leftActionReturnTimer = 0;
  private rightPdaReturnTimer = 0;
  private rightGrenadeReturnTimer = 0;
  private wasLeftOverridden = false;
  private wasPdaActive = false;
  private wasGrenadeActive = false;

  private moveWeight = 0;
  private sprintBlend = 0;
  private crouchBlend = 0;

  // Per-foot smoothed world ground elevation & slope pitch for stairs/curbs/ramps
  private footWorldYL = 0;
  private footWorldYR = 0;
  private footWorldInit = false;
  private lastControllerY = 0;
  private footPitchL = 0;
  private footPitchR = 0;

  // Unarmed Jab -> Cross, Armed V Quick-Bash, and Tactical Push-Kick (X) state (zero-GC)
  private combatMove: BodycamCombatMove = 'NONE';
  private combatTime = 0;
  private combatDuration = 0.38;
  private armedBashKind: 'pistol' | 'rifle' = 'rifle';
  private lastHoldClass: BodycamWeaponHoldClass = 'unarmed';
  private combatHitEvaluated = false;
  private kickPlantSoundFired = false;
  private kickRightLegImpairment = 0;
  private comboWindowTimer = 0;
  private hitstopTimer = 0;
  private unarmedGuardHeld = false;
  private unarmedGuardBlend = 0;
  private unarmedSprintBlend = 0;
  private punchFromGuard = false;
  private knifeSlashAlt = false;
  private triggerEngageBlend = 0;
  private triggerHoldoverTimer = 0;

  // Smooth additive camera twist / lean-back overlay (applied post-controller with zero drift)
  private camAddPitch = 0;
  private camAddYaw = 0;
  private camAddRoll = 0;
  private readonly _camOverlayEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _camOverlayQuat = new THREE.Quaternion();

  // Pre-allocated combat spherecast & event buffers (zero GC per frame)
  private readonly _meleeRayOut: BodycamRaycastResult = createRaycastResult();
  private readonly _meleeBestOut: BodycamRaycastResult = createRaycastResult();
  private readonly _meleeEvent: BodycamMeleeHitEvent = createMeleeHitEvent();
  private readonly _meleeOrigin = new THREE.Vector3();
  private readonly _meleeDir = new THREE.Vector3();
  private readonly _meleeRight = new THREE.Vector3();
  private readonly _meleeUp = new THREE.Vector3();
  private readonly _meleeRayOrigin = new THREE.Vector3();
  private readonly _meleeHitVec = new THREE.Vector3();
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _worldRightFallback = new THREE.Vector3(1, 0, 0);
  private readonly _punchAimDirLocal = new THREE.Vector3();
  private readonly _punchTargetLocal = new THREE.Vector3();
  private readonly _punchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _kickAnkleTarget = new THREE.Vector3();
  private readonly _kickPoleTarget = new THREE.Vector3();

  // Zero-GC kick full-swing sweep, angled-surface slide & close-wall leg clearance buffers
  private kickPrevBootValid = false;
  private kickContactActive = false;
  private kickSlideAccum = 0;
  private kickLastImpactFrac = 1;
  private leftWallPullback = 0;
  private rightWallPullback = 0;
  private beltWallTuck = 0;
  private readonly _kickPrevBootWorld = new THREE.Vector3();
  private readonly _kickCurrBootWorld = new THREE.Vector3();
  private readonly _kickHipWorld = new THREE.Vector3();
  private readonly _kickSweepDir = new THREE.Vector3();
  private readonly _kickContactNormal = new THREE.Vector3();
  private readonly _kickTangent = new THREE.Vector3();
  private readonly _kickSlideOffsetWorld = new THREE.Vector3();
  private readonly _kickClampedAnkleWorld = new THREE.Vector3();
  private readonly _legRayOrigin = new THREE.Vector3();
  private readonly _legRayDir = new THREE.Vector3();
  private readonly _legWorldTarget = new THREE.Vector3();
  private readonly _legRootForward = new THREE.Vector3();
  private readonly _legRootRight = new THREE.Vector3();
  private readonly _legRayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _kickHitA: BodycamRaycastResult = createRaycastResult();
  private readonly _kickHitB: BodycamRaycastResult = createRaycastResult();
  private readonly _meleeHorizDir = new THREE.Vector3();

  // Pre-allocated scratch math objects (zero GC per frame)
  private readonly _shoulderR = new THREE.Vector3();
  private readonly _shoulderL = new THREE.Vector3();
  private readonly _shoulderRWorld = new THREE.Vector3();
  private readonly _shoulderLWorld = new THREE.Vector3();
  private readonly _weaponShoulderWorld = new THREE.Vector3();
  private readonly _rightSocketWorld = new THREE.Vector3();
  private readonly _leftSocketWorld = new THREE.Vector3();
  private readonly _solvedHandRWorldPos = new THREE.Vector3();
  private readonly _solvedHandRWorldQuat = new THREE.Quaternion();
  private readonly _currSocketRWorldPos = new THREE.Vector3();
  private readonly _currSocketRWorldQuat = new THREE.Quaternion();
  private readonly _lockDeltaQuat = new THREE.Quaternion();
  private readonly _lockBlendQuat = new THREE.Quaternion();
  private readonly _identityQuat = new THREE.Quaternion();
  private readonly _lockDeltaPos = new THREE.Vector3();

  private readonly _rTargetRoot = new THREE.Vector3();
  private readonly _lTargetRoot = new THREE.Vector3();
  private readonly _rDesiredRoot = new THREE.Vector3();
  private readonly _lDesiredRoot = new THREE.Vector3();
  private readonly _rQuatRoot = new THREE.Quaternion();
  private readonly _lQuatRoot = new THREE.Quaternion();
  private readonly _rDesiredQuatRoot = new THREE.Quaternion();
  private readonly _lDesiredQuatRoot = new THREE.Quaternion();
  private readonly _rootWorldQuatInv = new THREE.Quaternion();
  private readonly _poleR = new THREE.Vector3();
  private readonly _poleL = new THREE.Vector3();
  private readonly _scapulaDeltaRoot = new THREE.Vector3();
  private readonly _scapulaTargetWorld = new THREE.Vector3();
  private readonly _scapulaStartWorld = new THREE.Vector3();
  private readonly _hipL = new THREE.Vector3();
  private readonly _hipR = new THREE.Vector3();
  private readonly _ankleL = new THREE.Vector3();
  private readonly _ankleR = new THREE.Vector3();
  private readonly _kneePoleL = new THREE.Vector3();
  private readonly _kneePoleR = new THREE.Vector3();
  private readonly _footWorld = new THREE.Vector3();
  private readonly _footToeWorld = new THREE.Vector3();
  private readonly _magPouchRoot = new THREE.Vector3();
  private readonly _magWellRoot = new THREE.Vector3();
  private readonly _boltRackRoot = new THREE.Vector3();
  private readonly _tmpWorldA = new THREE.Vector3();
  private readonly _tmpWorldB = new THREE.Vector3();
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _aimPoleEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _pivotAimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _actionPosOffset = new THREE.Vector3();
  private readonly _actionRotOffset = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _forearmAxis = new THREE.Vector3();
  private readonly _forearmDorsalProj = new THREE.Vector3();
  private readonly _forearmPoleTmp = new THREE.Vector3();
  private readonly _dorsalL = new THREE.Vector3(0, 1, 0);
  private readonly _dorsalR = new THREE.Vector3(0, 1, 0);
  private readonly _vaultHandLRoot = new THREE.Vector3();
  private readonly _vaultHandRRoot = new THREE.Vector3();
  private readonly _vaultBasisX = new THREE.Vector3();
  private readonly _vaultBasisY = new THREE.Vector3(0, 1, 0);
  private readonly _vaultBasisZ = new THREE.Vector3();
  private readonly _vaultBasisMat = new THREE.Matrix4();
  private readonly _vaultHandQuatWorld = new THREE.Quaternion();
  private readonly _vaultHandQuatRoot = new THREE.Quaternion();
  private readonly _vaultWristPitchQuat = new THREE.Quaternion();
  private readonly _vaultUpAxis = new THREE.Vector3(0, 1, 0);
  private readonly _vaultXAxis = new THREE.Vector3(1, 0, 0);

  // Zero-GC scratch buffers for unarmed ready/guard framing & forearm-aligned wrist orientation
  private readonly _camLocalOrigin = new THREE.Vector3();
  private readonly _readyPosL = new THREE.Vector3();
  private readonly _readyPosR = new THREE.Vector3();
  private readonly _sprintPosL = new THREE.Vector3();
  private readonly _sprintPosR = new THREE.Vector3();
  private readonly _guardPosL = new THREE.Vector3();
  private readonly _guardPosR = new THREE.Vector3();
  private readonly _readyPoleL = new THREE.Vector3();
  private readonly _readyPoleR = new THREE.Vector3();
  private readonly _sprintPoleL = new THREE.Vector3();
  private readonly _sprintPoleR = new THREE.Vector3();
  private readonly _guardPoleL = new THREE.Vector3();
  private readonly _guardPoleR = new THREE.Vector3();
  private readonly _unarmedPitchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _handAlignX = new THREE.Vector3();
  private readonly _handAlignY = new THREE.Vector3();
  private readonly _handAlignZ = new THREE.Vector3();
  private readonly _handAlignOut = new THREE.Vector3();
  private readonly _handAlignUp = new THREE.Vector3();
  private readonly _handAlignMat = new THREE.Matrix4();
  private readonly _handAlignedQuat = new THREE.Quaternion();
  private readonly _inspectSlideWorld = new THREE.Vector3();
  private readonly _inspectWeaponQuat = new THREE.Quaternion();
  private readonly _bootQuatL = new THREE.Quaternion();
  private readonly _bootQuatR = new THREE.Quaternion();
  private readonly _suppressorMountRoot = new THREE.Vector3();
  private readonly _suppressorTwistQuat = new THREE.Quaternion();
  private readonly _suppressorTwistEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _zoomRingPosWorld = new THREE.Vector3();
  private readonly _zoomRingQuatWorld = new THREE.Quaternion();
  private readonly _zoomRingPosRoot = new THREE.Vector3();
  private readonly _zoomRingQuatRoot = new THREE.Quaternion();
  private readonly _pdaLPosRoot = new THREE.Vector3();
  private readonly _pdaRPosRoot = new THREE.Vector3();
  private readonly _pdaLQuatRoot = new THREE.Quaternion();
  private readonly _pdaRQuatRoot = new THREE.Quaternion();
  private readonly _microPosWorld = new THREE.Vector3();
  private readonly _microQuatWorld = new THREE.Quaternion();
  private readonly _microPosRoot = new THREE.Vector3();
  private readonly _microQuatRoot = new THREE.Quaternion();
  private readonly _breechRoot = new THREE.Vector3();
  private readonly _rightHandPoseOpts: HandPoseDynamicOptions = {};
  private readonly _leftHandPoseOpts: HandPoseDynamicOptions = {};
  private readonly _pdaPoleL = new THREE.Vector3();
  private readonly _pdaPoleR = new THREE.Vector3();
  private readonly _pdaSolvedRWorld = new THREE.Vector3();
  private readonly _pdaSolvedLWorld = new THREE.Vector3();
  private readonly _pdaTargetRWorld = new THREE.Vector3();
  private readonly _pdaTargetLWorld = new THREE.Vector3();
  private readonly _pdaReachDeltaWorld = new THREE.Vector3();
  private readonly _pdaTmpQuat = new THREE.Quaternion();

  private pdaDevice: TacticalPdaDevice | null = null;
  private grenadeSystem: TacticalGrenadeSystem | null = null;
  private readonly _grenadeRPos = new THREE.Vector3();
  private readonly _grenadeLPos = new THREE.Vector3();
  private readonly _grenadePinPos = new THREE.Vector3();
  private readonly _grenadePocketPos = new THREE.Vector3();
  private readonly _grenadePullAxisWorld = new THREE.Vector3();
  private readonly _grenadeBodyWorldQuat = new THREE.Quaternion();
  private readonly _grenadeHandEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _grenadeHandQuat = new THREE.Quaternion();
  private readonly _grenadeLQuat = new THREE.Quaternion();
  private readonly _grenadePoleR = new THREE.Vector3();
  private readonly _grenadePoleL = new THREE.Vector3();
  private readonly _grenadeReleaseOrigin = new THREE.Vector3();
  private readonly _grenadeReleaseForward = new THREE.Vector3();

  // Post-animation soft-tissue & gear secondary physics
  private secondaryApplier: SecondaryPhysicsRigApplier;
  private prevRecoilZ = 0;
  private readonly _ctrlVel = new THREE.Vector3();
  private readonly _secInput = {
    dt: 0,
    rootWorldPos: new THREE.Vector3(),
    rootWorldQuat: new THREE.Quaternion(),
    speedMps: 0,
    stridePhase: 0,
    grounded: true,
    recoilImpulse: 0,
  };

  // External world-space hand IK override (e.g., Gun Wall two-handed swap choreography)
  private externalHandOverride: Readonly<ExternalHandIkOverride> | null = null;
  private readonly _extRPosRoot = new THREE.Vector3();
  private readonly _extRQuatRoot = new THREE.Quaternion();
  private readonly _extLPosRoot = new THREE.Vector3();
  private readonly _extLQuatRoot = new THREE.Quaternion();

  constructor(skeleton: CharacterSkeleton, weaponRig: WeaponRig, audio?: IBodycamAudioSource) {
    this.skeleton = skeleton;
    this.weaponRig = weaponRig;
    this.audio = audio;
    this.secondaryApplier = new SecondaryPhysicsRigApplier(skeleton);
  }

  public setSkeleton(skeleton: CharacterSkeleton): void {
    if (this.skeleton === skeleton) return;
    this.skeleton = skeleton;
    this.secondaryApplier = new SecondaryPhysicsRigApplier(skeleton);
    this.footWorldInit = false;
  }

  public setExternalHandOverride(override: Readonly<ExternalHandIkOverride> | null): void {
    this.externalHandOverride = override;
  }

  public clearExternalHandOverride(): void {
    this.externalHandOverride = null;
  }

  public setPdaDevice(pda: TacticalPdaDevice | null): void {
    this.pdaDevice = pda;
  }

  public setGrenadeSystem(grenadeSystem: TacticalGrenadeSystem | null): void {
    this.grenadeSystem = grenadeSystem;
  }

  public setSecondaryRagdollDecay(active: boolean): void {
    this.secondaryApplier.setRagdollDecay(active);
  }

  public resetSecondaryPhysics(): void {
    this.secondaryApplier.reset();
  }

  private safeZoneDiscipline = false;

  public setAudio(audio: IBodycamAudioSource): void {
    this.audio = audio;
  }

  /**
   * Enforces strict safe-zone / FOB / Hideout trigger discipline so the primary index finger
   * stays extended straight along the receiver outside the trigger guard.
   */
  public setSafeZoneDiscipline(active: boolean): void {
    this.safeZoneDiscipline = active;
  }

  public getTriggerEngageBlend(): number {
    return this.triggerEngageBlend;
  }

  public isCombatBusy(): boolean {
    return this.combatMove !== 'NONE';
  }

  public isKicking(): boolean {
    return this.combatMove === 'PUSH_KICK';
  }

  public getActiveCombatMove(): BodycamCombatMove {
    return this.combatMove;
  }

  public triggerReload(durationSec: number): void {
    this.weaponRig.triggerReload(durationSec);
  }

  public triggerMagCheck(durationSec: number): void {
    this.weaponRig.triggerMagCheck(durationSec);
  }

  public triggerInspect(): boolean {
    if (this.combatMove !== 'NONE') return false;
    return this.weaponRig.triggerInspect();
  }

  public triggerChamberCycle(opts: WeaponChamberCycleOptions): boolean {
    if (this.combatMove !== 'NONE') return false;
    return this.weaponRig.triggerChamberCycle(opts);
  }

  public isChamberCycling(): boolean {
    return this.weaponRig.isChamberCycling();
  }

  public interruptInspect(): void {
    this.weaponRig.interruptInspect();
  }

  public cancelAction(): void {
    this.weaponRig.cancelAction();
  }

  public cancelCombat(): void {
    this.combatMove = 'NONE';
    this.combatTime = 0;
    this.hitstopTimer = 0;
    this.combatHitEvaluated = false;
    this.kickPrevBootValid = false;
    this.kickContactActive = false;
    this.kickSlideAccum = 0;
    this.kickLastImpactFrac = 1;
    this._kickSlideOffsetWorld.set(0, 0, 0);
  }

  public setUnarmedGuardHeld(held: boolean): void {
    this.unarmedGuardHeld = held;
  }

  public getUnarmedGuardBlend(): number {
    return this.unarmedGuardBlend;
  }

  /**
   * Trigger an unarmed orthodox Jab -> Cross alternating chain.
   * Clicking within 0.45s of Left Jab recovery (or during late jab retraction) chains into Right Cross.
   * Punching from ADS Fighting Guard skips the initial raise/coil (~30% faster: 0.25s Jab / 0.34s Cross)
   * versus Non-ADS Ready (0.38s Jab / 0.50s Cross).
   */
  public triggerUnarmedPunch(
    controller?: BodycamController,
    adsHeld?: boolean,
  ): 'jab' | 'cross' | null {
    if (controller?.isVaulting()) return null;
    if (this.combatMove === 'PUSH_KICK' || this.combatMove === 'ARMED_BASH') return null;

    const fromGuard =
      (adsHeld ?? this.unarmedGuardHeld) ||
      this.unarmedGuardBlend >= 0.45;
    const jabDuration = fromGuard ? 0.25 : 0.38;
    const crossDuration = fromGuard ? 0.34 : 0.50;

    if (this.combatMove === 'LEFT_JAB') {
      const p = this.combatTime / Math.max(0.01, this.combatDuration);
      if (p < 0.68) return null;
      // Seamless late-retraction chain directly into Right Cross
      return this.startCombatMove('RIGHT_CROSS', crossDuration, controller, fromGuard);
    }
    if (this.combatMove === 'RIGHT_CROSS') {
      return null;
    }

    if (this.comboWindowTimer > 0) {
      this.comboWindowTimer = 0;
      return this.startCombatMove('RIGHT_CROSS', crossDuration, controller, fromGuard);
    }
    return this.startCombatMove('LEFT_JAB', jabDuration, controller, fromGuard);
  }

  /**
   * Trigger an armed quick-bash (V):
   *  - Pistol: brisk left-chest to right-outward pistol whip (left support hand briefly clears to chest guard)
   *  - Rifle / Shotgun: rapid ~150 deg pivot + forward buttstock thrust keeping both IK hands on the firearm
   */
  public triggerArmedBash(
    controller?: BodycamController,
    holdClass?: BodycamWeaponHoldClass,
  ): boolean {
    if (controller?.isVaulting()) return false;
    if (this.combatMove !== 'NONE') return false;
    this.weaponRig.cancelAction();
    const resolvedHold = holdClass ?? this.lastHoldClass;
    this.armedBashKind = resolvedHold === 'pistol' ? 'pistol' : 'rifle';
    this.combatMove = 'ARMED_BASH';
    this.combatTime = 0;
    this.combatDuration = this.armedBashKind === 'pistol' ? 0.36 : 0.40;
    this.combatHitEvaluated = false;
    this.hitstopTimer = 0;
    this.audio?.playMeleeWhoosh?.('bash');
    this.audio?.playGearRattle('melee', 0.72);
    controller?.addExertionImpulse(0.14);
    return true;
  }

  /**
   * Trigger a rapid Combat Knife forward-saber diagonal slash (LMB when holding melee_1h).
   */
  public triggerKnifeSlash(controller?: BodycamController): boolean {
    if (controller?.isVaulting()) return false;
    if (this.combatMove !== 'NONE') return false;
    this.weaponRig.cancelAction();
    this.knifeSlashAlt = !this.knifeSlashAlt;
    this.combatMove = 'KNIFE_SLASH';
    this.combatTime = 0;
    this.combatDuration = 0.34;
    this.combatHitEvaluated = false;
    this.hitstopTimer = 0;
    this.audio?.playMeleeWhoosh?.('cross');
    this.audio?.playGearRattle('melee', 0.42);
    controller?.addExertionImpulse(0.10);
    return true;
  }

  /**
   * Trigger a heavy Combat Knife forward saber thrust/stab (RMB when holding melee_1h).
   */
  public triggerKnifeStab(controller?: BodycamController): boolean {
    if (controller?.isVaulting()) return false;
    if (this.combatMove !== 'NONE') return false;
    this.weaponRig.cancelAction();
    this.combatMove = 'KNIFE_STAB';
    this.combatTime = 0;
    this.combatDuration = 0.46;
    this.combatHitEvaluated = false;
    this.hitstopTimer = 0;
    this.audio?.playMeleeWhoosh?.('bash');
    this.audio?.playGearRattle('melee', 0.58);
    controller?.addExertionImpulse(0.16);
    return true;
  }

  /**
   * Trigger a grounded Tactical Push-Kick (X) using right-leg 2-bone IK.
   * Usable both unarmed and while holding any firearm.
   * Disabled if airborne, vaulting, or if BOTH legs are fractured/blacked out.
   */
  public triggerPushKick(
    controller: BodycamController,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): BodycamKickTriggerResult {
    if (this.combatMove !== 'NONE' || controller.isVaulting()) return 'busy';
    if (!controller.grounded) return 'airborne';

    const impairL = trauma ? trauma.leftLegImpairment : 0;
    const impairR = trauma ? trauma.rightLegImpairment : 0;
    if (impairL >= 0.72 && impairR >= 0.72) {
      return 'dual_leg_trauma';
    }

    this.weaponRig.cancelAction();

    const speedMult = 1 - impairR * 0.36;
    this.kickRightLegImpairment = impairR;
    this.combatMove = 'PUSH_KICK';
    this.combatTime = 0;
    this.combatDuration = 0.58 / Math.max(0.55, speedMult);
    this.combatHitEvaluated = false;
    this.kickPlantSoundFired = false;
    this.kickPrevBootValid = false;
    this.kickContactActive = false;
    this.kickSlideAccum = 0;
    this.kickLastImpactFrac = 1;
    this._kickSlideOffsetWorld.set(0, 0, 0);
    this.hitstopTimer = 0;
    this.comboWindowTimer = 0;

    this.audio?.playMeleeWhoosh?.('kick');
    this.audio?.playGearRattle('melee', 0.95);
    controller.addExertionImpulse(0.24 + impairR * 0.08);
    return 'ok';
  }

  private startCombatMove(
    move: 'LEFT_JAB' | 'RIGHT_CROSS',
    durationSec: number,
    controller?: BodycamController,
    fromGuard = false,
  ): 'jab' | 'cross' {
    this.combatMove = move;
    this.combatTime = 0;
    this.combatDuration = durationSec;
    this.punchFromGuard = fromGuard;
    this.combatHitEvaluated = false;
    this.hitstopTimer = 0;
    const attackType: 'jab' | 'cross' = move === 'LEFT_JAB' ? 'jab' : 'cross';
    this.audio?.playMeleeWhoosh?.(attackType);
    this.audio?.playGearRattle('melee', move === 'RIGHT_CROSS' ? 0.72 : 0.48);
    controller?.addExertionImpulse(move === 'RIGHT_CROSS' ? 0.15 : 0.10);
    return attackType;
  }

  /**
   * Apply zero-GC additive camera twist & lean-back overlay (punches ~4°/10°, kick -4° roll / +7° pitch)
   * strictly AFTER BodycamController.update without touching BodycamController core math.
   */
  public applyCameraAdditiveOverlay(camera: THREE.PerspectiveCamera): void {
    if (
      Math.abs(this.camAddPitch) < 1e-4 &&
      Math.abs(this.camAddYaw) < 1e-4 &&
      Math.abs(this.camAddRoll) < 1e-4
    ) {
      return;
    }
    this._camOverlayEuler.set(this.camAddPitch, this.camAddYaw, this.camAddRoll, 'YXZ');
    this._camOverlayQuat.setFromEuler(this._camOverlayEuler);
    camera.quaternion.multiply(this._camOverlayQuat);
  }

  private isLeftHandOverriddenByAction(spec: BodycamWeaponProfile): boolean {
    const isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';
    if (this.combatMove === 'ARMED_BASH' && spec.holdClass === 'pistol') return true;
    const anim = this.weaponRig.weaponAnimator;
    if (isFirearm && anim.isTubularReloading()) {
      const ph = anim.getTubularReloadPhase();
      return ph !== 'OPEN_BREECH' && ph !== 'CLOSE_BREECH';
    }
    const act = anim.getActiveAction();
    if (act === 'CHAMBER_CYCLE' && isFirearm) {
      const style = anim.getChamberCycleStyle();
      return style !== 'pump_shotgun' && style !== 'bolt_action';
    }
    return (
      isFirearm &&
      (act === 'RELOAD' ||
        act === 'MAG_CHECK' ||
        act === 'SUPPRESSOR_ATTACH' ||
        act === 'SUPPRESSOR_DETACH')
    );
  }

  public update(
    dt: number,
    elapsed: number,
    controller: BodycamController,
    adapter: IBodycamWorldAdapter,
    spec: BodycamWeaponProfile,
    adsHeld?: boolean,
  ): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    this.lastHoldClass = spec.holdClass;
    const rigState = this.weaponRig.getReadOnlyRigState();
    const trauma = adapter.getTraumaModifiers?.();
    this.weaponRig.weaponAnimator.setReloadSpeedMult(trauma ? trauma.reloadSpeedMult : 1.0);

    if (adsHeld !== undefined) {
      this.unarmedGuardHeld = adsHeld;
    }
    const wantsUnarmedGuard =
      spec.holdClass === 'unarmed' &&
      (this.unarmedGuardHeld || controller.isAds) &&
      !controller.isVaulting();
    // Smooth ~0.14s blend (lambda=21 reaches ~95% in 0.14s) between Side-Rest and ADS Fighting Guard
    this.unarmedGuardBlend = THREE.MathUtils.damp(
      this.unarmedGuardBlend,
      wantsUnarmedGuard ? 1 : 0,
      21,
      clampedDt,
    );
    const wantsUnarmedSprint =
      spec.holdClass === 'unarmed' &&
      controller.isSprinting &&
      rigState.isMoving &&
      !wantsUnarmedGuard &&
      !controller.isVaulting();
    this.unarmedSprintBlend = THREE.MathUtils.damp(
      this.unarmedSprintBlend,
      wantsUnarmedSprint ? 1 : 0,
      wantsUnarmedSprint ? 10 : 6.5,
      clampedDt,
    );

    if (this.lastWeaponId !== spec.id) {
      this.lastWeaponId = spec.id;
      this.equipBlendTimer = 0.08;
      if (this.weaponRig.weaponAnimator.getActiveAction() !== 'NONE') {
        this.cancelAction();
      }
      if (this.combatMove !== 'NONE' && this.combatMove !== 'PUSH_KICK') {
        this.cancelCombat();
      }
    }
    if (this.equipBlendTimer > 0) {
      this.equipBlendTimer = Math.max(0, this.equipBlendTimer - clampedDt);
    }

    if (controller.isVaulting() && this.combatMove !== 'NONE') {
      this.cancelCombat();
    }

    // Advance combat state machine, hitstop freeze, spherecast impact windows, and additive camera twist/lean-back
    this.stepCombatState(clampedDt, controller, adapter, trauma);

    // Step (a): Skeleton root & spine hierarchy aligned to torsoYaw and C1-smoothed elevation
    const smoothRootY = controller.position.y + controller.getStepSmoothOffsetY();
    if (!this.footWorldInit || Math.abs(controller.position.y - this.lastControllerY) > 0.75) {
      this.footWorldYL = controller.position.y;
      this.footWorldYR = controller.position.y;
      this.footWorldInit = true;
    }
    this.lastControllerY = controller.position.y;

    const vaultStateTop = controller.getVaultState();
    this.skeleton.root.position.set(controller.position.x, smoothRootY, controller.position.z);
    this.skeleton.root.rotation.set(0, controller.torsoYaw + vaultStateTop.spinYawOffset, 0);

    const ctrlVel = controller.getVelocity(this._tmpWorldA);
    const horizSpeed = Math.hypot(ctrlVel.x, ctrlVel.z);
    const targetMoveWeight = THREE.MathUtils.clamp(horizSpeed / 1.6, 0, 1);
    this.moveWeight = THREE.MathUtils.damp(
      this.moveWeight,
      targetMoveWeight,
      targetMoveWeight > this.moveWeight ? 11 : 9,
      clampedDt,
    );
    this.sprintBlend = THREE.MathUtils.damp(
      this.sprintBlend,
      controller.isSprinting && rigState.isMoving ? 1 : 0,
      9.5,
      clampedDt,
    );
    this.crouchBlend = THREE.MathUtils.damp(this.crouchBlend, controller.crouched ? 1 : 0, 11, clampedDt);

    const cyclePhase = rigState.bobPhase;
    const pelvisBobAmp = THREE.MathUtils.lerp(0.018, 0.038, this.sprintBlend);
    const pelvisBob = this.moveWeight * (Math.abs(Math.sin(cyclePhase)) * pelvisBobAmp);
    const pelvisSwayX = this.moveWeight * Math.cos(cyclePhase) * 0.016;

    // Kick weight shift onto left planting leg + chest lean-back
    const kickP =
      this.combatMove === 'PUSH_KICK'
        ? THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1)
        : 0;
    const kickShiftWeight =
      this.combatMove === 'PUSH_KICK'
        ? smoothstep(0.0, 0.16, kickP) * (1 - smoothstep(0.50, 0.92, kickP))
        : 0;

    const eyeHeight = controller.getEyeHeight();
    const headDuck = vaultStateTop.active ? vaultStateTop.headDuckWeight : 0;
    const landingBend = controller.getLandingKneeBend();
    const landingDrop = THREE.MathUtils.clamp(controller.getLandingCompression(), -0.36, 0.04);
    const pelvisHeight = THREE.MathUtils.clamp(
      eyeHeight - 0.56 + pelvisBob + landingDrop - headDuck * 0.22 - kickShiftWeight * 0.035,
      0.28,
      0.92,
    );
    const leanSign = controller.getCurrentLean();
    this.skeleton.pelvis.position.set(
      pelvisSwayX + leanSign * 0.24 - kickShiftWeight * 0.055,
      pelvisHeight,
      0.21 + this.crouchBlend * 0.06 + landingBend * 0.13 + headDuck * 0.10 + kickShiftWeight * 0.04,
    );

    const spineForwardPitch =
      -this.crouchBlend * 0.20 -
      landingBend * 0.28 -
      headDuck * 0.44 -
      this.sprintBlend * 0.07 +
      kickShiftWeight * 0.16;
    const leanAngle = -leanSign * 1.22 + kickShiftWeight * 0.10;

    // Torso twist & crisp shoulder protraction during unarmed Jab / Cross or grenade overhand windup
    let punchTorsoYaw = 0;
    let leftClavProtract = 0;
    let rightClavProtract = 0;
    if (this.combatMove === 'LEFT_JAB' || this.combatMove === 'RIGHT_CROSS') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
      const protractBoost = this.punchFromGuard ? 1.2 : 1.0;
      if (this.combatMove === 'LEFT_JAB') {
        punchTorsoYaw = -0.10 * drive;
        leftClavProtract = 0.27 * protractBoost * drive;
        rightClavProtract = -0.06 * drive;
      } else {
        punchTorsoYaw = 0.22 * drive;
        rightClavProtract = 0.36 * protractBoost * drive;
        leftClavProtract = -0.12 * drive;
      }
    } else if (this.combatMove === 'KNIFE_SLASH' || this.combatMove === 'KNIFE_STAB') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const strikeEnv = smoothstep(0.08, 0.36, p) * (1 - smoothstep(0.55, 1.0, p));
      if (this.combatMove === 'KNIFE_SLASH') {
        const dirSign = this.knifeSlashAlt ? 1 : -1;
        punchTorsoYaw = dirSign * 0.14 * strikeEnv;
        rightClavProtract = 0.24 * strikeEnv;
        leftClavProtract = -0.06 * strikeEnv;
      } else {
        punchTorsoYaw = 0.20 * strikeEnv;
        rightClavProtract = 0.34 * strikeEnv;
        leftClavProtract = -0.10 * strikeEnv;
      }
    } else if (this.grenadeSystem && this.grenadeSystem.getWeaponStowBlend() > 0.25) {
      const style = this.grenadeSystem.getThrowStyle();
      const charge = this.grenadeSystem.getCharge01();
      const whip = this.grenadeSystem.getThrowWhipProgress();
      if (style === 'overhand') {
        if (this.grenadeSystem.isThrowInputHeld()) {
          punchTorsoYaw = -0.34 * charge;
          rightClavProtract = -0.26 * charge;
          leftClavProtract = 0.14 * charge;
        } else if (whip > 0.001) {
          const swing = THREE.MathUtils.lerp(-0.34 * Math.max(0.35, charge), 0.18, smoothstep(0, 0.72, whip));
          const retract = 1 - smoothstep(0.72, 1.0, whip);
          punchTorsoYaw = swing * retract;
          rightClavProtract = swing * 0.65 * retract;
        }
      } else if (whip > 0.001) {
        const arc = Math.sin(whip * Math.PI);
        punchTorsoYaw = 0.10 * arc;
        rightClavProtract = 0.14 * arc;
      }
    }

    const spinePitch = controller.getSpinePitch();
    const isUnarmedSpec = spec.holdClass === 'unarmed';
    const aimSightBlendEarly = isUnarmedSpec
      ? 0
      : Math.max(rigState.adsBlend, rigState.cantBlend, rigState.pointAimBlend);
    const totalPitchRad = THREE.MathUtils.clamp(controller.torsoPitch + rigState.aimPitch, -0.95, 1.25);
    const upwardPitchRad = Math.max(0, totalPitchRad);

    // When aiming steeply upward in ADS/Canted/Point-Aim, avoid tilting the chest backward (+Z)
    // away from the raised handguard so the support shoulder stays naturally under the rifle.
    const rawChestPitch = THREE.MathUtils.clamp(spinePitch * 0.08, -0.10, 0.12);
    const clampedChestPitch =
      rawChestPitch > 0 ? rawChestPitch * (1 - aimSightBlendEarly * 0.85) : rawChestPitch;
    this.skeleton.spineLower.rotation.set(spineForwardPitch * 0.5, punchTorsoYaw * 0.45, leanAngle * 0.45);
    this.skeleton.spineUpper.rotation.set(
      spineForwardPitch * 0.5 + clampedChestPitch * 0.45,
      punchTorsoYaw * 0.55,
      leanAngle * 0.55,
    );
    this.skeleton.chest.rotation.set(clampedChestPitch, Math.sin(elapsed * 1.5) * 0.008, 0);

    // Keep shoulders squared on the top-outer torso plane (zero involuntary chest-collapse protraction
    // when looking down or standing unarmed; active protraction only for ADS, Guard, Leans & Punches).
    const guardProtract = isUnarmedSpec ? this.unarmedGuardBlend * 0.08 : 0;
    const baseProtract = isUnarmedSpec
      ? 0
      : controller.isAds
        ? 0.065
        : controller.isCanted
          ? 0.055
          : controller.isPointAim
            ? 0.045
            : 0.022;
    const protract = baseProtract + guardProtract;
    const clavAimWeight = isUnarmedSpec ? this.unarmedGuardBlend : 1.0;
    const clavElevPitch = isUnarmedSpec
      ? rigState.aimPitch
      : THREE.MathUtils.lerp(rigState.aimPitch, totalPitchRad, 0.35 + aimSightBlendEarly * 0.65);
    const upwardSupportFollow = isUnarmedSpec ? 0 : upwardPitchRad * (0.25 + aimSightBlendEarly * 0.75);
    // Symmetric cross-body shoulder follow when leaning Q/E so off-side arm stays ergonomic
    const leanFollowL = Math.max(0, leanSign) * 0.14;
    const leanFollowR = Math.max(0, -leanSign) * 0.14;

    // Reset clavicles to canonical rest offsets each frame, plus subtle scapular elevation/protraction
    // when pitching a primary weapon upward so the deltoid cap stays anatomically seated.
    const restClavX = this.skeleton.profile.clavicleOffsetX;
    this.skeleton.leftArm.clavicle.position.set(
      -restClavX + upwardSupportFollow * 0.016,
      0.092 + upwardSupportFollow * 0.032,
      0.014 - upwardSupportFollow * 0.028,
    );
    this.skeleton.rightArm.clavicle.position.set(
      restClavX,
      0.092 + upwardSupportFollow * 0.016,
      0.014 - upwardSupportFollow * 0.012,
    );

    this.skeleton.leftArm.clavicle.rotation.order = 'YXZ';
    this.skeleton.rightArm.clavicle.rotation.order = 'YXZ';
    this.skeleton.leftArm.clavicle.rotation.set(
      clavElevPitch * 0.14 * clavAimWeight,
      -protract - leftClavProtract - leanFollowL - upwardSupportFollow * 0.16 + rigState.aimYaw * 0.20 * clavAimWeight,
      -clavElevPitch * 0.14 * clavAimWeight,
    );
    this.skeleton.rightArm.clavicle.rotation.set(
      clavElevPitch * 0.14 * clavAimWeight,
      protract + rightClavProtract + leanFollowR + rigState.aimYaw * 0.20 * clavAimWeight,
      clavElevPitch * 0.12 * clavAimWeight,
    );

    // 1P Neck & Head Free-Zoom forward shift parity (matches 3P operator forward crane & shadow silhouette)
    const focus1P = THREE.MathUtils.clamp(controller.focusBlend, 0, 1);
    this.skeleton.neck.position.set(0, 0.13 - focus1P * 0.003, 0.015 - focus1P * 0.010);
    this.skeleton.neck.rotation.set(-focus1P * 0.22, 0, 0);
    this.skeleton.headGroup.position.set(0, 0.09 - focus1P * 0.004, -focus1P * 0.018);
    this.skeleton.headGroup.rotation.set(focus1P * 0.16, 0, 0);

    this.skeleton.root.updateMatrixWorld(true);
    this._rootWorldQuatInv.copy(this.skeleton.root.quaternion).invert();

    // Lower-body 2-bone leg IK with per-boot stair/curb/ramp ground adaptation + Tactical Push-Kick (X)
    this.updateLowerBodyIK(clampedDt, controller, rigState.isSprinting, cyclePhase, adapter, trauma);

    // Step (b): Anchor weaponRig inside Shoulder/Chest Aim Space
    this.skeleton.rightArm.shoulderPivot.getWorldPosition(this._shoulderRWorld);
    this.skeleton.leftArm.shoulderPivot.getWorldPosition(this._shoulderLWorld);
    this.weaponRig.root.updateMatrixWorld(true);
    this.weaponRig.shoulderAnchor.getWorldPosition(this._weaponShoulderWorld);

    const sightBlend = Math.max(
      rigState.adsBlend,
      rigState.cantBlend,
      rigState.pointAimBlend,
      this.weaponRig.weaponAnimator.inspectBlend,
    );
    this._tmpWorldA.subVectors(this._shoulderRWorld, this._weaponShoulderWorld);
    this.weaponRig.root.position.addScaledVector(this._tmpWorldA, 1 - sightBlend);

    const nonAdsAimWeight = 0.85 * (1 - sightBlend);
    if (nonAdsAimWeight > 0.001) {
      this._pivotAimEuler.set(
        rigState.aimPitch * nonAdsAimWeight,
        rigState.aimYaw * nonAdsAimWeight,
        0,
        'YXZ',
      );
      this.weaponRig.weaponPivot.position.applyEuler(this._pivotAimEuler);
    }

    // Advance action curve (reload / mag-check / armed V bash / kick weapon brace) + unified arm-trauma tremor
    this.updateActionCurve(clampedDt, elapsed, spec, trauma);

    // Step (c): Pre-IK Dual-Arm Physical Reach Clamp
    const vaultState = controller.getVaultState();
    const armR = this.skeleton.rightArm;
    const armL = this.skeleton.leftArm;
    const maxRightReach = (armR.upperLen + armR.lowerLen) * 0.96;
    const minRightReach = Math.abs(armR.upperLen - armR.lowerLen) + 0.03;
    const maxLeftReach = (armL.upperLen + armL.lowerLen) * 0.96;
    const minLeftReach = Math.abs(armL.upperLen - armL.lowerLen) + 0.03;
    const clampLeftSocket =
      spec.holdClass !== 'unarmed' &&
      this.weaponRig.hasLeftHandSocket &&
      !this.isLeftHandOverriddenByAction(spec) &&
      vaultState.handPinWeightL < 0.05;
    const clampRightSocket = spec.holdClass !== 'unarmed' && vaultState.handPinWeightR < 0.05;

    const activeWepAct = this.weaponRig.weaponAnimator.getActiveAction();
    const aimLockWeight =
      spec.holdClass !== 'unarmed' &&
      activeWepAct === 'NONE' &&
      this.combatMove === 'NONE' &&
      vaultState.handPinWeightR < 0.05 &&
      vaultState.handPinWeightL < 0.05
        ? Math.max(rigState.adsBlend, rigState.cantBlend, rigState.pointAimBlend)
        : 0;
    const pdaStowW = this.pdaDevice ? this.pdaDevice.getWeaponStowBlend() : 0;
    const grenadeStowW = this.grenadeSystem ? this.grenadeSystem.getWeaponStowBlend() : 0;
    const reachClampWeight = (1 - aimLockWeight) * (1 - Math.max(pdaStowW, grenadeStowW));

    if (reachClampWeight > 0.001) {
      for (let iter = 0; iter < 2; iter++) {
        this.weaponRig.root.updateMatrixWorld(true);
        if (clampLeftSocket) {
          this.weaponRig.leftHandSocketAnchor.getWorldPosition(this._leftSocketWorld);
          this._tmpWorldA.subVectors(this._leftSocketWorld, this._shoulderLWorld);
          const leftDist = this._tmpWorldA.length();
          if (leftDist > maxLeftReach && leftDist > 1e-5) {
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (-(leftDist - maxLeftReach) / leftDist) * reachClampWeight,
            );
            this.weaponRig.root.updateMatrixWorld(true);
          } else if (leftDist < minLeftReach && leftDist > 1e-5) {
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              ((minLeftReach - leftDist) / leftDist) * reachClampWeight,
            );
            this.weaponRig.root.updateMatrixWorld(true);
          }
        }

        if (clampRightSocket) {
          this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._rightSocketWorld);
          this._tmpWorldA.subVectors(this._rightSocketWorld, this._shoulderRWorld);
          const rightDist = this._tmpWorldA.length();
          if (rightDist > maxRightReach && rightDist > 1e-5) {
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (-(rightDist - maxRightReach) / rightDist) * reachClampWeight,
            );
          } else if (rightDist < minRightReach && rightDist > 1e-5) {
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              ((minRightReach - rightDist) / rightDist) * reachClampWeight,
            );
          }
        }
      }
    }

    // Step (d): Upper-Body 2-Bone IK + Post-IK Rigid Hard-Lock + Laser Beam Sync
    this.updateUpperBodyIK(clampedDt, elapsed, controller, spec, cyclePhase);
    this.weaponRig.updateLaserBeam(adapter);

    // Step (e): Post-animation fixed-step 120 Hz secondary soft-tissue & gear dynamics
    const recoilDelta = Math.max(0, rigState.recoilZ - this.prevRecoilZ);
    this.prevRecoilZ = rigState.recoilZ;
    controller.getVelocity(this._ctrlVel);
    this._secInput.dt = clampedDt;
    this._secInput.rootWorldPos.copy(this.skeleton.root.position);
    this._secInput.rootWorldQuat.copy(this.skeleton.root.quaternion);
    this._secInput.speedMps = Math.hypot(this._ctrlVel.x, this._ctrlVel.z);
    this._secInput.stridePhase = cyclePhase;
    this._secInput.grounded = controller.grounded;
    this._secInput.recoilImpulse = recoilDelta > 0.004 ? Math.min(1.5, recoilDelta * 45) : 0;
    this.secondaryApplier.update(this._secInput);
  }

  /**
   * Ballistic punch drive envelope:
   *  - From ADS Fighting Guard (fromGuard=true): coil phase cut to 0.06, snapping straight from guard
   *    (0.00–0.06 micro-coil -> 0.06–0.22 explosive easeOutQuart -> 0.22–0.28 peak -> 0.28–1.00 snap retract)
   *  - From Non-ADS Ready (fromGuard=false): chamber/raise coil (0.00–0.14) -> 0.14–0.30 extension -> 0.30–0.36 peak -> 0.36–1.00 retract
   */
  private evalPunchDriveCurve(p: number, fromGuard = false): number {
    if (fromGuard) {
      if (p < 0.06) {
        return -0.08 * smoothstep(0.0, 0.06, p);
      }
      if (p < 0.22) {
        return THREE.MathUtils.lerp(-0.08, 1.0, easeOutQuart((p - 0.06) / 0.16));
      }
      if (p < 0.28) {
        return 1.0;
      }
      return 1 - smoothstep(0.28, 1.0, p);
    }

    if (p < 0.14) {
      return -0.22 * smoothstep(0.0, 0.14, p);
    }
    if (p < 0.30) {
      return THREE.MathUtils.lerp(-0.22, 1.0, easeOutQuart((p - 0.14) / 0.16));
    }
    if (p < 0.36) {
      return 1.0;
    }
    return 1 - smoothstep(0.36, 1.0, p);
  }

  private stepCombatState(
    dt: number,
    controller: BodycamController,
    adapter: IBodycamWorldAdapter,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): void {
    if (this.comboWindowTimer > 0) {
      this.comboWindowTimer = Math.max(0, this.comboWindowTimer - dt);
    }

    let targetCamPitch = 0;
    let targetCamYaw = 0;
    let targetCamRoll = 0;

    if (this.combatMove !== 'NONE') {
      // 28–32ms visceral limb hitstop freezes striking limb clock cleanly on impact
      if (this.hitstopTimer > 0) {
        this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      } else {
        this.combatTime += dt;
      }

      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);

      if (this.combatMove === 'LEFT_JAB') {
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        // ~4° chest-cam twist right as left shoulder drives forward
        targetCamYaw = -0.070 * drive;
        targetCamPitch = 0.018 * Math.max(0, drive);
        targetCamRoll = 0.032 * drive;

        const jabHitP = this.punchFromGuard ? 0.18 : 0.26;
        if (!this.combatHitEvaluated && p >= jabHitP) {
          this.combatHitEvaluated = true;
          this.performCombatSpherecast('jab', controller, adapter, trauma);
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
          this.comboWindowTimer = 0.45;
        }
      } else if (this.combatMove === 'RIGHT_CROSS') {
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        // ~10° chest-cam twist left as right shoulder drives power cross
        targetCamYaw = 0.175 * drive;
        targetCamPitch = -0.022 * Math.max(0, drive);
        targetCamRoll = -0.068 * drive;

        const crossHitP = this.punchFromGuard ? 0.19 : 0.27;
        if (!this.combatHitEvaluated && p >= crossHitP) {
          this.combatHitEvaluated = true;
          this.performCombatSpherecast('cross', controller, adapter, trauma);
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
          this.comboWindowTimer = 0;
        }
      } else if (this.combatMove === 'ARMED_BASH') {
        if (this.armedBashKind === 'pistol') {
          // Windup across to left chest -> explosive whip across center out to the right -> recover
          if (p < 0.22) {
            const w = smoothstep(0.0, 0.22, p);
            targetCamYaw = 0.065 * w;
            targetCamPitch = 0.014 * w;
            targetCamRoll = 0.038 * w;
          } else if (p < 0.52) {
            const s = easeOutQuart((p - 0.22) / 0.30);
            targetCamYaw = THREE.MathUtils.lerp(0.065, -0.115, s);
            targetCamPitch = THREE.MathUtils.lerp(0.014, -0.028, s);
            targetCamRoll = THREE.MathUtils.lerp(0.038, -0.055, s);
          } else {
            const r = smoothstep(0.52, 1.0, p);
            targetCamYaw = -0.115 * (1 - r);
            targetCamPitch = -0.028 * (1 - r);
            targetCamRoll = -0.055 * (1 - r);
          }

          if (!this.combatHitEvaluated && p >= 0.36) {
            this.combatHitEvaluated = true;
            this.performCombatSpherecast('bash', controller, adapter, trauma);
          }
        } else {
          // Rifle / Shotgun: rapid pivot + shoulder-driven forward buttstock thrust
          if (p < 0.22) {
            const w = smoothstep(0.0, 0.22, p);
            targetCamYaw = 0.045 * w;
            targetCamPitch = 0.015 * w;
            targetCamRoll = 0.028 * w;
          } else if (p < 0.46) {
            const s = easeOutQuart((p - 0.22) / 0.24);
            targetCamYaw = THREE.MathUtils.lerp(0.045, 0.095, s);
            targetCamPitch = THREE.MathUtils.lerp(0.015, -0.045, s);
            targetCamRoll = THREE.MathUtils.lerp(0.028, -0.048, s);
          } else {
            const r = smoothstep(0.46, 1.0, p);
            targetCamYaw = 0.095 * (1 - r);
            targetCamPitch = -0.045 * (1 - r);
            targetCamRoll = -0.048 * (1 - r);
          }

          if (!this.combatHitEvaluated && p >= 0.34) {
            this.combatHitEvaluated = true;
            this.performCombatSpherecast('bash', controller, adapter, trauma);
          }
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
        }
      } else if (this.combatMove === 'KNIFE_SLASH') {
        const dirSign = this.knifeSlashAlt ? 1 : -1;
        if (p < 0.20) {
          const w = smoothstep(0.0, 0.20, p);
          targetCamYaw = -dirSign * 0.042 * w;
          targetCamPitch = 0.012 * w;
          targetCamRoll = -dirSign * 0.028 * w;
        } else if (p < 0.50) {
          const s = easeOutQuart((p - 0.20) / 0.30);
          targetCamYaw = THREE.MathUtils.lerp(-dirSign * 0.042, dirSign * 0.088, s);
          targetCamPitch = THREE.MathUtils.lerp(0.012, -0.024, s);
          targetCamRoll = THREE.MathUtils.lerp(-dirSign * 0.028, dirSign * 0.048, s);
        } else {
          const r = smoothstep(0.50, 1.0, p);
          targetCamYaw = dirSign * 0.088 * (1 - r);
          targetCamPitch = -0.024 * (1 - r);
          targetCamRoll = dirSign * 0.048 * (1 - r);
        }
        if (!this.combatHitEvaluated && p >= 0.30) {
          this.combatHitEvaluated = true;
          this.performCombatSpherecast('knife_slash', controller, adapter, trauma);
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
        }
      } else if (this.combatMove === 'KNIFE_STAB') {
        if (p < 0.24) {
          const w = smoothstep(0.0, 0.24, p);
          targetCamYaw = -0.065 * w;
          targetCamPitch = 0.018 * w;
          targetCamRoll = -0.032 * w;
        } else if (p < 0.48) {
          const s = easeOutQuart((p - 0.24) / 0.24);
          targetCamYaw = THREE.MathUtils.lerp(-0.065, 0.115, s);
          targetCamPitch = THREE.MathUtils.lerp(0.018, -0.032, s);
          targetCamRoll = THREE.MathUtils.lerp(-0.032, 0.056, s);
        } else {
          const r = smoothstep(0.48, 1.0, p);
          targetCamYaw = 0.115 * (1 - r);
          targetCamPitch = -0.032 * (1 - r);
          targetCamRoll = 0.056 * (1 - r);
        }
        if (!this.combatHitEvaluated && p >= 0.33) {
          this.combatHitEvaluated = true;
          this.performCombatSpherecast('knife_stab', controller, adapter, trauma);
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
        }
      } else if (this.combatMove === 'PUSH_KICK') {
        // Chamber (0.00–0.16): -4° cam roll, +7° chest lean-back -> Snap Thrust (0.16–0.34) -> Plant Recovery (0.40–1.00)
        const chamberEnv = smoothstep(0.0, 0.16, p);
        const recoverEnv = 1 - smoothstep(0.40, 0.96, p);
        const kickCamEnv = chamberEnv * recoverEnv;
        const thrustExtra =
          p >= 0.16 && p <= 0.42
            ? easeOutQuart((Math.min(p, 0.34) - 0.16) / 0.18) * (1 - smoothstep(0.34, 0.44, p))
            : 0;

        // +7° lean-back pitch (+0.122 rad) and -4° roll (-0.070 rad) onto left stance leg
        targetCamPitch = 0.122 * kickCamEnv + 0.018 * thrustExtra;
        targetCamRoll = -0.070 * kickCamEnv - 0.012 * thrustExtra;
        targetCamYaw = 0.035 * thrustExtra;

        // Full-swing kick hit window (0.12–0.44): evaluate aimed bundle continuously through thrust arc until contact
        if (!this.combatHitEvaluated && p >= 0.12 && p <= 0.44) {
          const hit = this.performCombatSpherecast('kick', controller, adapter, trauma);
          if (hit) {
            this.combatHitEvaluated = true;
          }
        }

        // Crisp heavy boot-plant audio cue during plant recovery
        if (!this.kickPlantSoundFired && p >= 0.84) {
          this.kickPlantSoundFired = true;
          const surface = adapter.getSurfaceMaterial(
            controller.position.x,
            controller.position.y,
            controller.position.z,
          );
          this.audio?.playFootstep(surface, 1.25);
          this.audio?.playGearRattle('step', 0.82);
        }

        if (p >= 1) {
          this.combatMove = 'NONE';
          this.kickPrevBootValid = false;
          this.kickContactActive = false;
          this.kickSlideAccum = 0;
          this.kickLastImpactFrac = 1;
          this._kickSlideOffsetWorld.set(0, 0, 0);
        }
      }
    }

    const camLambda = this.combatMove !== 'NONE' ? 26 : 16;
    this.camAddPitch = THREE.MathUtils.damp(this.camAddPitch, targetCamPitch, camLambda, dt);
    this.camAddYaw = THREE.MathUtils.damp(this.camAddYaw, targetCamYaw, camLambda, dt);
    this.camAddRoll = THREE.MathUtils.damp(this.camAddRoll, targetCamRoll, camLambda, dt);
  }

  private performCombatSpherecast(
    attackType: BodycamMeleeAttackType,
    controller: BodycamController,
    adapter: IBodycamWorldAdapter,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): boolean {
    controller.getWorldLookDirection(this._meleeDir).normalize();
    const eyeY = controller.position.y + controller.getStepSmoothOffsetY() + controller.getEyeHeight();

    if (attackType === 'kick') {
      // Kick drives along crosshair aim within natural biomechanical leg arc (-47° low .. +27.5° high)
      this._meleeDir.y = THREE.MathUtils.clamp(this._meleeDir.y, -0.73, 0.46);
      this._meleeDir.normalize();
      const originDrop = THREE.MathUtils.lerp(
        0.34,
        0.16,
        Math.min(1, Math.abs(this._meleeDir.y) * 1.4),
      );
      // Back-stepped origin (-0.12m) ensures flush chest-to-door kicks NEVER start past the door slab
      this._meleeOrigin.set(
        controller.position.x - this._meleeDir.x * 0.12,
        eyeY - originDrop,
        controller.position.z - this._meleeDir.z * 0.12,
      );
    } else {
      this._meleeOrigin.set(
        controller.position.x + this._meleeDir.x * 0.08,
        eyeY - 0.04,
        controller.position.z + this._meleeDir.z * 0.08,
      );
    }

    const radius =
      attackType === 'kick'
        ? 0.24
        : attackType === 'bash'
          ? 0.16
          : attackType === 'knife_slash' || attackType === 'knife_stab'
            ? 0.15
            : 0.14;
    // Reach measured from origin (kick starts 0.12m behind center -> +0.42m compensates so full boot reach ~1.16m ahead)
    const reachM =
      attackType === 'kick'
        ? 1.16 + 0.36
        : attackType === 'knife_stab'
          ? 1.24 + 0.28
          : attackType === 'knife_slash'
            ? 1.08 + 0.28
            : attackType === 'bash'
              ? 0.85 + 0.28
              : attackType === 'cross'
                ? 0.68 + 0.36
                : 0.58 + 0.36;

    let hit = this.queryMeleeSpherecast(adapter, this._meleeOrigin, this._meleeDir, radius, reachM);

    // Secondary horizontal waist-height door/torso thrust fallback when kicking while pitched steeply up/down
    if (!hit && attackType === 'kick' && Math.abs(this._meleeDir.y) > 0.22) {
      this._meleeHorizDir.set(this._meleeDir.x, -0.04, this._meleeDir.z);
      if (this._meleeHorizDir.lengthSq() > 1e-4) {
        this._meleeHorizDir.normalize();
        this._meleeOrigin.set(
          controller.position.x - this._meleeHorizDir.x * 0.12,
          controller.position.y + controller.getStepSmoothOffsetY() + 0.96 - this.crouchBlend * 0.28,
          controller.position.z - this._meleeHorizDir.z * 0.12,
        );
        hit = this.queryMeleeSpherecast(adapter, this._meleeOrigin, this._meleeHorizDir, 0.24, 1.38);
        if (hit) {
          this._meleeDir.copy(this._meleeHorizDir);
        }
      }
    }

    if (!hit) return false;
    return this.dispatchMeleeHit(attackType, controller, adapter, trauma, this._meleeOrigin, this._meleeDir);
  }

  private dispatchMeleeHit(
    attackType: BodycamMeleeAttackType,
    controller: BodycamController,
    adapter: IBodycamWorldAdapter,
    trauma: Readonly<BodycamTraumaModifiers> | undefined,
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
  ): boolean {
    const out = this._meleeBestOut;
    const hitZone = resolveHitZone(out.object, out.surface);
    const isActor = isActorHitZone(hitZone);

    // Well-placed center alignment check (~30° cone -> cos(30°) = 0.866)
    this._meleeHitVec.set(
      out.pointX - origin.x,
      0,
      out.pointZ - origin.z,
    );
    let wellPlaced = true;
    if (this._meleeHitVec.lengthSq() > 1e-4) {
      this._meleeHitVec.normalize();
      const horizDirLen = Math.hypot(direction.x, direction.z);
      if (horizDirLen > 1e-4) {
        const dot =
          (direction.x * this._meleeHitVec.x + direction.z * this._meleeHitVec.z) /
          horizDirLen;
        wellPlaced = dot >= 0.866;
      }
    }

    // Shatter intact breakable window glass immediately on punch/bash/kick impact
    if (hitZone === 'glass' && out.object) {
      this._meleeEvent.point.set(out.pointX, out.pointY, out.pointZ);
      this._meleeEvent.direction.copy(direction);
      const shattered = adapter.shatterBreakable?.(
        out.object,
        this._meleeEvent.point,
        this._meleeEvent.direction,
      );
      if (shattered) {
        this.audio?.playGlassShatter(this._meleeEvent.point, attackType === 'kick' ? 1.25 : 0.95);
        adapter.emitAcousticEvent?.(this._meleeEvent.point, 18, 'glass_shatter');
      }
    }

    // Populate zero-GC BodycamMeleeHitEvent payload
    const impairR = trauma ? trauma.rightLegImpairment : this.kickRightLegImpairment;
    const kickKbScale = 1 - impairR * 0.48;
    const ev = this._meleeEvent;
    ev.attackType = attackType;
    ev.hitZone = hitZone;
    ev.object = out.object;
    ev.point.set(out.pointX, out.pointY, out.pointZ);
    ev.direction.copy(direction);
    // Preserve strong horizontal thrust for door kicks even when player aims steeply up/down
    if (attackType === 'kick' && hitZone === 'door') {
      const hx = ev.direction.x;
      const hz = ev.direction.z;
      const hLen = Math.hypot(hx, hz);
      if (hLen > 1e-4) {
        ev.direction.set(hx / hLen, THREE.MathUtils.clamp(ev.direction.y * 0.35, -0.25, 0.25), hz / hLen).normalize();
      }
    }
    ev.normal.set(out.normalX, out.normalY, out.normalZ);
    ev.surface = out.surface;
    ev.wellPlaced = wellPlaced;

    if (attackType === 'jab') {
      ev.damageEnergyJ = 240;
      ev.knockbackForce = 0;
      // Strict head-only stun rule for unarmed punches
      ev.stunDurationSec = hitZone === 'head' ? 0.65 : 0;
    } else if (attackType === 'cross') {
      ev.damageEnergyJ = 345;
      ev.knockbackForce = 0;
      ev.stunDurationSec = hitZone === 'head' ? 0.72 : 0;
    } else if (attackType === 'knife_slash') {
      ev.damageEnergyJ = hitZone === 'head' ? 780 : 540;
      ev.knockbackForce = 1.2;
      ev.stunDurationSec = hitZone === 'head' ? 0.45 : 0.18;
    } else if (attackType === 'knife_stab') {
      ev.damageEnergyJ = hitZone === 'head' ? 1200 : 880;
      ev.knockbackForce = 2.4;
      ev.stunDurationSec = hitZone === 'head' ? 0.75 : 0.36;
    } else if (attackType === 'bash') {
      ev.damageEnergyJ = 285;
      ev.knockbackForce = 2.8;
      ev.stunDurationSec = 0.42;
    } else {
      // Tactical Push-Kick: well-placed deals moderate trauma + ~1.1–1.5m knockback + ~0.95s stun
      ev.damageEnergyJ = wellPlaced ? 330 : 190;
      ev.knockbackForce = (wellPlaced ? 7.2 : 3.4) * kickKbScale;
      ev.stunDurationSec = wellPlaced ? 0.95 : 0.38;
    }

    // Visceral 28–32ms limb hitstop on solid impact
    this.hitstopTimer =
      attackType === 'kick' || attackType === 'knife_stab'
        ? 0.032
        : attackType === 'cross' || attackType === 'knife_slash'
          ? 0.028
          : 0.026;

    // Sharp chest-cam shock impulse via existing additive recoil hook
    const shockPitch =
      attackType === 'kick'
        ? 0.034
        : attackType === 'knife_stab'
          ? 0.026
          : attackType === 'cross' || attackType === 'knife_slash'
            ? 0.020
            : attackType === 'bash'
              ? 0.022
              : 0.016;
    const shockYaw = attackType === 'kick' ? 0.020 : 0.015;
    controller.applyRecoil(shockPitch, shockYaw, attackType === 'bash' ? 0.025 : 0.012, 0.45, {
      stanceCoupled: false,
    });

    // Impact audio + gear rattle + stealth acoustic radius (6m punch, 8m bash, 12m kick)
    const impactMat: BodycamSurfaceMaterial | 'flesh' = isActor ? 'flesh' : out.surface;
    this.audio?.playMeleeImpact?.(
      ev.point,
      attackType,
      impactMat,
      attackType === 'kick' ? 1.25 : attackType === 'cross' ? 1.08 : 0.92,
    );
    this.audio?.playGearRattle('melee', attackType === 'kick' ? 1.15 : 0.82);

    const acousticRadius = attackType === 'kick' ? 12 : attackType === 'bash' ? 8 : 6;
    adapter.emitAcousticEvent?.(ev.point, acousticRadius, 'impact');

    // Notify host world adapter (100% zombie-free SDK boundary)
    adapter.onMeleeHit?.(ev);
    return true;
  }

  private queryMeleeSpherecast(
    adapter: IBodycamWorldAdapter,
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    radius: number,
    maxDistance: number,
  ): boolean {
    if (adapter.meleeSpherecast) {
      return adapter.meleeSpherecast(origin, direction, radius, maxDistance, this._meleeBestOut);
    }

    // Portable zero-GC 7-ray bundle fallback using only IBodycamWorldAdapter.raycast()
    this._meleeRight.crossVectors(direction as THREE.Vector3, this._worldUp);
    if (this._meleeRight.lengthSq() < 1e-4) {
      this._meleeRight.crossVectors(direction as THREE.Vector3, this._worldRightFallback);
    }
    this._meleeRight.normalize();
    this._meleeUp.crossVectors(this._meleeRight, direction as THREE.Vector3).normalize();

    const ringR = Math.max(0.02, radius * 0.72);
    let bestDist = Infinity;
    let found = false;

    for (let i = 0; i < 7; i++) {
      this._meleeRayOrigin.copy(origin);
      if (i > 0) {
        const ang = ((i - 1) / 6) * Math.PI * 2;
        this._meleeRayOrigin.addScaledVector(this._meleeRight, Math.cos(ang) * ringR);
        this._meleeRayOrigin.addScaledVector(this._meleeUp, Math.sin(ang) * ringR);
      }

      if (adapter.raycast(this._meleeRayOrigin, direction, 0.01, maxDistance, this._meleeRayOut)) {
        const effDist = i === 0 ? this._meleeRayOut.distance - 0.035 : this._meleeRayOut.distance;
        if (effDist < bestDist) {
          bestDist = effDist;
          found = true;
          this._meleeBestOut.hit = true;
          this._meleeBestOut.distance = this._meleeRayOut.distance;
          this._meleeBestOut.pointX = this._meleeRayOut.pointX;
          this._meleeBestOut.pointY = this._meleeRayOut.pointY;
          this._meleeBestOut.pointZ = this._meleeRayOut.pointZ;
          this._meleeBestOut.normalX = this._meleeRayOut.normalX;
          this._meleeBestOut.normalY = this._meleeRayOut.normalY;
          this._meleeBestOut.normalZ = this._meleeRayOut.normalZ;
          this._meleeBestOut.surface = this._meleeRayOut.surface;
          this._meleeBestOut.object = this._meleeRayOut.object;
        }
      }
    }

    if (!found) {
      this._meleeBestOut.hit = false;
      this._meleeBestOut.distance = Infinity;
      this._meleeBestOut.object = null;
    }
    return found;
  }

  private updateLowerBodyIK(
    dt: number,
    controller: BodycamController,
    _isSprinting: boolean,
    cyclePhase: number,
    adapter: IBodycamWorldAdapter,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): void {
    this.skeleton.leftLeg.hipPivot.getWorldPosition(this._hipL);
    this.skeleton.rightLeg.hipPivot.getWorldPosition(this._hipR);
    this.skeleton.root.worldToLocal(this._hipL);
    this.skeleton.root.worldToLocal(this._hipR);

    const baseStrideLen = THREE.MathUtils.lerp(0.30, 0.22, this.crouchBlend);
    const baseStepLift = THREE.MathUtils.lerp(0.095, 0.065, this.crouchBlend);
    const strideLen = THREE.MathUtils.lerp(baseStrideLen, 0.42, this.sprintBlend) * this.moveWeight;
    const stepLift = THREE.MathUtils.lerp(baseStepLift, 0.14, this.sprintBlend) * this.moveWeight;

    const smoothRootY = this.skeleton.root.position.y;
    const groundRefY = Math.max(controller.position.y, smoothRootY);

    const computeFoot = (
      side: -1 | 1,
      hipPos: THREE.Vector3,
      phase: number,
      outAnkle: THREE.Vector3,
      outPole: THREE.Vector3,
      bootObj: THREE.Object3D,
      ankleHeight: number,
      legImpairment: number,
      prevWorldY: number,
      prevSlopePitch: number,
    ): [number, number] => {
      const impairScale = 1 - legImpairment * 0.45;
      const forwardOffset = -Math.sin(phase) * strideLen * impairScale;
      const lift = Math.max(0, Math.cos(phase)) * stepLift * (1 - legImpairment * 0.55);

      const landingBend = controller.getLandingKneeBend();
      const stanceX =
        side * (0.125 + this.crouchBlend * 0.03 + landingBend * 0.042 + legImpairment * 0.035);
      const stanceZ =
        0.04 + forwardOffset + (side > 0 ? 0.03 : -0.02) * (1 - this.moveWeight) - landingBend * 0.035;

      this._footWorld.set(stanceX, 0, stanceZ).applyMatrix4(this.skeleton.root.matrixWorld);
      const rawGroundY = adapter.getGroundHeight(
        this._footWorld.x,
        this._footWorld.z,
        groundRefY,
      );
      const clampedTargetWorldY = THREE.MathUtils.clamp(rawGroundY, smoothRootY - 0.42, smoothRootY + 0.42);
      const smoothedWorldY = THREE.MathUtils.damp(prevWorldY, clampedTargetWorldY, 18, dt);
      const localGroundY = THREE.MathUtils.clamp(smoothedWorldY - smoothRootY, -0.45, 0.45);

      this._footToeWorld.set(stanceX, 0, stanceZ - 0.16).applyMatrix4(this.skeleton.root.matrixWorld);
      const toeGroundY = adapter.getGroundHeight(
        this._footToeWorld.x,
        this._footToeWorld.z,
        groundRefY,
      );
      const rawSlopePitch = Math.abs(toeGroundY - rawGroundY) < 0.14
        ? THREE.MathUtils.clamp(Math.atan2(toeGroundY - rawGroundY, 0.16), -0.45, 0.45)
        : 0;
      const smoothedSlopePitch = THREE.MathUtils.damp(prevSlopePitch, rawSlopePitch, 16, dt);

      const vaultState = controller.getVaultState();
      const airTuck =
        !controller.grounded && !vaultState.active
          ? THREE.MathUtils.clamp(
              0.35 + Math.max(0, controller.getVerticalVelocity() / 5.5) * 0.45,
              0.2,
              0.8,
            )
          : 0;
      const legTuck = vaultState.active ? vaultState.legTuckWeight : airTuck;
      const tuckLift = legTuck * (side < 0 ? 0.34 : 0.28);
      const tuckBack = legTuck * (side < 0 ? 0.14 : 0.22);

      const effectiveGroundY = vaultState.active || !controller.grounded ? 0 : localGroundY;
      outAnkle.set(stanceX, effectiveGroundY + ankleHeight + lift + tuckLift, stanceZ + tuckBack);

      outPole.set(
        hipPos.x +
          side *
            (0.06 +
              this.crouchBlend * 0.05 +
              landingBend * 0.095 +
              legImpairment * 0.03 +
              legTuck * 0.06),
        hipPos.y - 0.12 - landingBend * 0.08 + legTuck * 0.14,
        hipPos.z - 0.55 - landingBend * 0.22 - legTuck * 0.12,
      );

      const landPlant = 1 - Math.min(0.85, landingBend * 0.85);
      const swingPitch =
        Math.sin(phase) * 0.34 * this.moveWeight * impairScale * landPlant - legTuck * 0.45;
      bootObj.rotation.set(
        swingPitch + smoothedSlopePitch * (1 - Math.min(1, lift * 8)) * (1 - legTuck),
        side * (0.08 + landingBend * 0.07 + legImpairment * 0.16),
        0,
      );
      return [smoothedWorldY, smoothedSlopePitch];
    };

    const impairL = trauma ? trauma.leftLegImpairment : 0;
    const impairR = trauma ? trauma.rightLegImpairment : 0;

    [this.footWorldYL, this.footPitchL] = computeFoot(
      -1,
      this._hipL,
      cyclePhase,
      this._ankleL,
      this._kneePoleL,
      this.skeleton.leftLeg.boot,
      this.skeleton.leftLeg.ankleHeight,
      impairL,
      this.footWorldYL,
      this.footPitchL,
    );
    [this.footWorldYR, this.footPitchR] = computeFoot(
      1,
      this._hipR,
      cyclePhase + Math.PI,
      this._ankleR,
      this._kneePoleR,
      this.skeleton.rightLeg.boot,
      this.skeleton.rightLeg.ankleHeight,
      impairR,
      this.footWorldYR,
      this.footPitchR,
    );

    // Tactical Push-Kick (X): Aim-tracked right-leg 2-bone IK (Chamber -> Snap Thrust -> Plant Recovery)
    if (this.combatMove === 'PUSH_KICK') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const eyeH = controller.getEyeHeight();

      // Convert live world aim ray into skeleton-root local space so kick tracks crosshair yaw & pitch
      controller.getWorldLookDirection(this._tmpWorldA).normalize();
      this._tmpWorldA.applyQuaternion(this._rootWorldQuatInv).normalize();
      const kickPitch = THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp(this._tmpWorldA.y, -0.98, 0.98)),
        -0.82,
        0.48,
      );
      const kickYaw = THREE.MathUtils.clamp(
        Math.atan2(-this._tmpWorldA.x, Math.max(0.15, -this._tmpWorldA.z)),
        -0.44,
        0.44,
      );

      const baseApexY = Math.max(this._hipR.y + 0.24, eyeH - 0.33);
      const horizReach = 0.71 * Math.cos(kickPitch);
      const apexX = THREE.MathUtils.clamp(0.03 - Math.sin(kickYaw) * horizReach, -0.34, 0.40);
      const apexY = THREE.MathUtils.clamp(
        baseApexY + Math.sin(kickPitch) * 0.62,
        0.14,
        eyeH - 0.06,
      );
      const apexZ = THREE.MathUtils.clamp(
        this._hipR.z - 0.16 - Math.cos(kickYaw) * horizReach,
        -0.86,
        -0.24,
      );
      const apexPoleX = apexX + 0.05;
      const apexPoleY = Math.max(apexY + 0.15, this._hipR.y + 0.06);
      const apexPoleZ = apexZ - 0.24;
      const bootPitchApex = THREE.MathUtils.clamp(
        1.42 + (kickPitch >= 0 ? kickPitch * 0.65 : kickPitch * 0.85),
        0.65,
        1.78,
      );
      const bootYawApex = 0.04 + kickYaw * 0.72;

      // Plant left stance foot firmly during weight shift
      this._ankleL.x = THREE.MathUtils.lerp(this._ankleL.x, -0.14, smoothstep(0.0, 0.16, p));
      this._ankleL.z = THREE.MathUtils.lerp(this._ankleL.z, 0.10, smoothstep(0.0, 0.16, p));

      let blend = 0;
      let bootPitchX = 0;
      let bootYawY = 0.04;

      if (p < 0.16) {
        // CHAMBER (0.00–0.16): rightKnee lifts toward aim plane
        const t = smoothstep(0.0, 0.16, p);
        blend = t;
        this._kickAnkleTarget.set(
          0.11 - Math.sin(kickYaw) * 0.10,
          THREE.MathUtils.clamp(this._hipR.y - 0.12 + kickPitch * 0.12, 0.18, eyeH - 0.25),
          this._hipR.z - 0.34,
        );
        this._kickPoleTarget.set(
          0.14 - Math.sin(kickYaw) * 0.16,
          this._hipR.y + 0.30 + kickPitch * 0.14,
          this._hipR.z - 0.68,
        );
        bootPitchX = 0.72 * t;
        bootYawY = THREE.MathUtils.lerp(0.04, bootYawApex * 0.5, t);
      } else if (p < 0.34) {
        // SNAP THRUST (0.16–0.34): explosive easeOutQuart extension driving sole along aim ray
        const t = easeOutQuart((p - 0.16) / 0.18);
        blend = 1;
        this._kickAnkleTarget.set(
          THREE.MathUtils.lerp(0.11 - Math.sin(kickYaw) * 0.10, apexX, t),
          THREE.MathUtils.lerp(
            THREE.MathUtils.clamp(this._hipR.y - 0.12 + kickPitch * 0.12, 0.18, eyeH - 0.25),
            apexY,
            t,
          ),
          THREE.MathUtils.lerp(this._hipR.z - 0.34, apexZ, t),
        );
        this._kickPoleTarget.set(
          THREE.MathUtils.lerp(0.14 - Math.sin(kickYaw) * 0.16, apexPoleX, t),
          THREE.MathUtils.lerp(this._hipR.y + 0.30 + kickPitch * 0.14, apexPoleY, t),
          THREE.MathUtils.lerp(this._hipR.z - 0.68, apexPoleZ, t),
        );
        bootPitchX = THREE.MathUtils.lerp(0.72, bootPitchApex, t);
        bootYawY = THREE.MathUtils.lerp(bootYawApex * 0.5, bootYawApex, t);
      } else if (p < 0.42) {
        // Brief apex hold / impact bite right at aimed target
        blend = 1;
        this._kickAnkleTarget.set(apexX, apexY, apexZ);
        this._kickPoleTarget.set(apexPoleX, apexPoleY, apexPoleZ);
        bootPitchX = bootPitchApex;
        bootYawY = bootYawApex;
      } else {
        // PLANT RECOVERY (0.42–1.00): re-chamber briefly then snap down to solid stance plant
        const rec = smoothstep(0.42, 1.0, p);
        const rechamber = Math.sin(rec * Math.PI);
        blend = 1 - rec;
        this._kickAnkleTarget.set(
          THREE.MathUtils.lerp(apexX, 0.13, rec),
          THREE.MathUtils.lerp(apexY, this._hipR.y - 0.24, rec) + rechamber * 0.12,
          THREE.MathUtils.lerp(apexZ, -0.18, rec),
        );
        this._kickPoleTarget.set(
          THREE.MathUtils.lerp(apexPoleX, 0.12, rec),
          THREE.MathUtils.lerp(apexPoleY, this._hipR.y + 0.05, rec),
          THREE.MathUtils.lerp(apexPoleZ, -0.68, rec),
        );
        bootPitchX = THREE.MathUtils.lerp(bootPitchApex, 0.0, rec);
        bootYawY = THREE.MathUtils.lerp(bootYawApex, 0.04, rec);
      }

      this._ankleR.lerp(this._kickAnkleTarget, blend);
      this._kneePoleR.lerp(this._kickPoleTarget, blend);
      this.skeleton.rightLeg.boot.rotation.set(
        THREE.MathUtils.lerp(this.skeleton.rightLeg.boot.rotation.x, bootPitchX, blend),
        THREE.MathUtils.lerp(this.skeleton.rightLeg.boot.rotation.y, bootYawY, blend),
        0,
      );

      // === FULL-SWING BOOT TRAJECTORY SWEEP + PHYSICAL KICK COLLISION ARREST & ANGLED-SURFACE SLIDE ===
      this._kickHipWorld.copy(this._hipR).applyMatrix4(this.skeleton.root.matrixWorld);
      this._kickCurrBootWorld.copy(this._ankleR).applyMatrix4(this.skeleton.root.matrixWorld);

      // 1) Physical boot trajectory sweep for full-swing kick detection (catches targets crossed mid-swing)
      if (!this.combatHitEvaluated && p >= 0.12 && p <= 0.44) {
        let sweptHit = false;
        if (this.kickPrevBootValid) {
          this._kickSweepDir.subVectors(this._kickCurrBootWorld, this._kickPrevBootWorld);
          const segLen = this._kickSweepDir.length();
          if (segLen > 0.015) {
            this._kickSweepDir.divideScalar(segLen);
            // Back up slightly behind previous boot sample and extend past toe-tip
            this._legRayOrigin.copy(this._kickPrevBootWorld).addScaledVector(this._kickSweepDir, -0.06);
            sweptHit = this.queryMeleeSpherecast(
              adapter,
              this._legRayOrigin,
              this._kickSweepDir,
              0.16,
              segLen + 0.24,
            );
          }
        }
        if (!sweptHit) {
          this._kickSweepDir.subVectors(this._kickCurrBootWorld, this._kickHipWorld);
          const legReach = this._kickSweepDir.length();
          if (legReach > 0.05) {
            this._kickSweepDir.divideScalar(legReach);
            this._legRayOrigin.copy(this._kickHipWorld).addScaledVector(this._kickSweepDir, -0.08);
            sweptHit = this.queryMeleeSpherecast(
              adapter,
              this._legRayOrigin,
              this._kickSweepDir,
              0.18,
              legReach + 0.26,
            );
          }
        }
        if (sweptHit) {
          this.combatHitEvaluated = true;
          this.dispatchMeleeHit('kick', controller, adapter, trauma, this._legRayOrigin, this._kickSweepDir);
        }
      }

      // 2) Physical leg / boot / knee world anti-clipping during kick with angled-surface tangent slide
      this._kickSweepDir.subVectors(this._kickCurrBootWorld, this._kickHipWorld);
      const desiredLegDist = this._kickSweepDir.length();
      const soleClearanceM = 0.155;
      const hipBackstepM = 0.08;
      let collided = false;
      let bestHitDist = Infinity;
      let activeHit: BodycamRaycastResult | null = null;

      if (desiredLegDist > 0.04) {
        this._kickSweepDir.divideScalar(desiredLegDist);
        const maxProbeDist = hipBackstepM + desiredLegDist + soleClearanceM;

        // Primary hip-to-ankle probe
        this._legRayOrigin.copy(this._kickHipWorld).addScaledVector(this._kickSweepDir, -hipBackstepM);
        if (adapter.raycast(this._legRayOrigin, this._kickSweepDir, 0.01, maxProbeDist, this._kickHitA)) {
          bestHitDist = this._kickHitA.distance;
          activeHit = this._kickHitA;
          collided = true;
        }
        // Secondary slightly lower sole-edge probe so low curbs/door bottoms never clip boot toes
        this._legRayOrigin.y -= 0.055;
        if (
          adapter.raycast(this._legRayOrigin, this._kickSweepDir, 0.01, maxProbeDist, this._kickHitB) &&
          this._kickHitB.distance < bestHitDist
        ) {
          bestHitDist = this._kickHitB.distance;
          activeHit = this._kickHitB;
          collided = true;
        }
      }

      if (collided && activeHit) {
        this._kickContactNormal.set(activeHit.normalX, activeHit.normalY, activeHit.normalZ);
        if (this._kickContactNormal.lengthSq() > 1e-4) {
          this._kickContactNormal.normalize();
        } else {
          this._kickContactNormal.copy(this._kickSweepDir).negate();
        }

        // Stop boot flush outside surface with sole clearance
        const clampedRayDist = Math.max(0.08, bestHitDist - hipBackstepM - soleClearanceM);
        const penetrationRatio = THREE.MathUtils.clamp(
          (desiredLegDist - clampedRayDist) / Math.max(0.12, desiredLegDist),
          0,
          1,
        );
        this._kickClampedAnkleWorld
          .copy(this._kickHipWorld)
          .addScaledVector(this._kickSweepDir, clampedRayDist)
          .addScaledVector(this._kickContactNormal, 0.025);

        // Angled surface glance/slide: when impact is oblique (|dot| < 0.85), slide slightly along surface tangent
        const ndot = this._kickSweepDir.dot(this._kickContactNormal);
        const absNdot = Math.abs(ndot);
        if (absNdot < 0.85 && p < 0.50) {
          this._kickTangent
            .copy(this._kickSweepDir)
            .addScaledVector(this._kickContactNormal, -ndot);
          const tLen = this._kickTangent.length();
          if (tLen > 1e-4) {
            this._kickTangent.divideScalar(tLen);
            const thrustMomentum = p < 0.36 ? 1.0 : 1 - smoothstep(0.36, 0.50, p);
            const targetSlide = Math.min(0.15, (0.85 - absNdot) * 0.24 * (0.45 + penetrationRatio * 0.55) * thrustMomentum);
            this.kickSlideAccum = THREE.MathUtils.damp(this.kickSlideAccum, targetSlide, 18, dt);
            this._kickSlideOffsetWorld.copy(this._kickTangent).multiplyScalar(this.kickSlideAccum);
            this._kickClampedAnkleWorld.add(this._kickSlideOffsetWorld);
          }
        } else {
          this.kickSlideAccum = THREE.MathUtils.damp(this.kickSlideAccum, 0, 14, dt);
          this._kickSlideOffsetWorld.multiplyScalar(Math.exp(-14 * dt));
        }

        // Convert clamped world ankle back to root local space
        this.skeleton.root.worldToLocal(this._kickClampedAnkleWorld);
        this._ankleR.copy(this._kickClampedAnkleWorld);

        // Pull knee pole back proportionally so knee never punches through wall during arrest
        const kneePull = penetrationRatio * 0.22;
        this._kneePoleR.z += kneePull;
        this._kneePoleR.y += penetrationRatio * 0.08;

        // Subtle boot sole deflection against angled surface
        const glanceTilt = (1 - absNdot) * 0.28 * Math.sign(this._kickContactNormal.x || 1);
        this.skeleton.rightLeg.boot.rotation.z = THREE.MathUtils.damp(
          this.skeleton.rightLeg.boot.rotation.z,
          glanceTilt,
          20,
          dt,
        );
        this.kickContactActive = true;
        this.kickLastImpactFrac = Math.min(this.kickLastImpactFrac, clampedRayDist / Math.max(0.1, desiredLegDist));
      } else {
        this.kickContactActive = false;
        this.kickSlideAccum = THREE.MathUtils.damp(this.kickSlideAccum, 0, 14, dt);
        this._kickSlideOffsetWorld.set(0, 0, 0);
      }

      // Record current resolved boot world position for next frame's trajectory sweep
      this._kickPrevBootWorld.copy(this._ankleR).applyMatrix4(this.skeleton.root.matrixWorld);
      this.kickPrevBootValid = true;
    } else {
      this.kickPrevBootValid = false;
      this.kickContactActive = false;
      this.kickSlideAccum = 0;
    }

    // === CLOSE-WALL LEG / TOE / KNEE CLEARANCE + PELVIS BELT WALL-TUCK ===
    // Extract root horizontal forward (-Z) and right (+X) world basis vectors (zero-GC)
    const rootYaw = this.skeleton.root.rotation.y;
    const sinY = Math.sin(rootYaw);
    const cosY = Math.cos(rootYaw);
    this._legRootForward.set(-sinY, 0, -cosY);
    this._legRootRight.set(cosY, 0, -sinY);

    const clampStandingLeg = (
      hipLocal: THREE.Vector3,
      ankleLocal: THREE.Vector3,
      poleLocal: THREE.Vector3,
      prevPullback: number,
    ): number => {
      // Probe forward from hip centerline at both boot-toe height and knee height
      this._legWorldTarget.copy(ankleLocal).applyMatrix4(this.skeleton.root.matrixWorld);
      const toeExtentForward = 0.21;
      const forwardFromHip = Math.max(0, hipLocal.z - ankleLocal.z); // local -Z is forward
      const requiredClearance = forwardFromHip + toeExtentForward + 0.06;

      this._legRayOrigin.set(
        this._legWorldTarget.x - this._legRootForward.x * (forwardFromHip + 0.10),
        this._legWorldTarget.y + 0.08,
        this._legWorldTarget.z - this._legRootForward.z * (forwardFromHip + 0.10),
      );
      let minPush = 0;
      const probeDist = requiredClearance + 0.10;
      if (adapter.raycast(this._legRayOrigin, this._legRootForward, 0.01, probeDist, this._legRayHit)) {
        const available = this._legRayHit.distance - 0.10;
        const overlap = requiredClearance - available;
        if (overlap > minPush) minPush = overlap;
      }

      // Knee-height probe prevents crouching/walking knees from penetrating flush walls
      this._legRayOrigin.y = this.skeleton.root.position.y + 0.44 - this.crouchBlend * 0.12;
      const kneeClearance = Math.max(0.24, forwardFromHip * 0.85 + 0.18);
      if (adapter.raycast(this._legRayOrigin, this._legRootForward, 0.01, kneeClearance + 0.10, this._legRayHit)) {
        const available = this._legRayHit.distance - 0.10;
        const overlap = kneeClearance - available;
        if (overlap > minPush) minPush = overlap;
      }

      const targetPull = THREE.MathUtils.clamp(minPush, 0, 0.34);
      const smoothPull = THREE.MathUtils.damp(
        prevPullback,
        targetPull,
        targetPull > prevPullback ? 28 : 14,
        dt,
      );
      if (smoothPull > 0.002) {
        // Pull ankle backward (+Z in local root space) and tuck knee pole back/slightly outward
        ankleLocal.z += smoothPull;
        poleLocal.z += smoothPull * 0.95;
      }
      return smoothPull;
    };

    // Always clamp left stance leg; clamp right leg whenever not actively mid-kick
    this.leftWallPullback = clampStandingLeg(
      this._hipL,
      this._ankleL,
      this._kneePoleL,
      this.leftWallPullback,
    );
    if (this.combatMove !== 'PUSH_KICK') {
      this.rightWallPullback = clampStandingLeg(
        this._hipR,
        this._ankleR,
        this._kneePoleR,
        this.rightWallPullback,
      );
    } else {
      this.rightWallPullback = THREE.MathUtils.damp(this.rightWallPullback, 0, 16, dt);
    }

    // 4-way short waist-height probe for 1P belt, holster & belt-grenade wall-tuck
    const beltY = this.skeleton.root.position.y + 0.90 - this.crouchBlend * 0.36;
    let minBeltClear = 0.36;
    for (let d = 0; d < 4; d++) {
      this._legRayOrigin.set(this.skeleton.root.position.x, beltY, this.skeleton.root.position.z);
      if (d === 0) this._legRayDir.copy(this._legRootForward);
      else if (d === 1) this._legRayDir.copy(this._legRootForward).negate();
      else if (d === 2) this._legRayDir.copy(this._legRootRight);
      else this._legRayDir.copy(this._legRootRight).negate();

      if (adapter.raycast(this._legRayOrigin, this._legRayDir, 0.02, 0.36, this._legRayHit)) {
        if (this._legRayHit.distance < minBeltClear) {
          minBeltClear = this._legRayHit.distance;
        }
      }
    }
    const targetBeltTuck = THREE.MathUtils.clamp((0.33 - minBeltClear) / 0.16, 0, 1);
    this.beltWallTuck = THREE.MathUtils.damp(this.beltWallTuck, targetBeltTuck, 20, dt);
    this.skeleton.setBeltWallTuck(this.beltWallTuck);

    const legL = this.skeleton.leftLeg;
    const legR = this.skeleton.rightLeg;

    // Capture desired root-space boot orientations before nested parent-chain solves
    this._bootQuatL.setFromEuler(legL.boot.rotation);
    this._bootQuatR.setFromEuler(legR.boot.rotation);
    this.skeleton.root.updateMatrixWorld(true);

    solveTwoBoneIK(this._hipL, this._ankleL, this._kneePoleL, legL.upperLen, legL.lowerLen, this.leftLegIK);
    orientLimbAlongYInRootSpace(legL.thigh, this.skeleton.root, this._hipL, this.leftLegIK.midPos, this._kneePoleL);
    orientLimbAlongYInRootSpace(legL.shin, this.skeleton.root, this.leftLegIK.midPos, this.leftLegIK.endPos, this._kneePoleL);
    setTransformInRootSpace(legL.boot, this.skeleton.root, this.leftLegIK.endPos, this._bootQuatL);

    solveTwoBoneIK(this._hipR, this._ankleR, this._kneePoleR, legR.upperLen, legR.lowerLen, this.rightLegIK);
    orientLimbAlongYInRootSpace(legR.thigh, this.skeleton.root, this._hipR, this.rightLegIK.midPos, this._kneePoleR);
    orientLimbAlongYInRootSpace(legR.shin, this.skeleton.root, this.rightLegIK.midPos, this.rightLegIK.endPos, this._kneePoleR);
    setTransformInRootSpace(legR.boot, this.skeleton.root, this.rightLegIK.endPos, this._bootQuatR);
  }

  private updateActionCurve(
    _dt: number,
    elapsed: number,
    spec: BodycamWeaponProfile,
    trauma?: Readonly<BodycamTraumaModifiers>,
  ): void {
    this._actionPosOffset.set(0, 0, 0);
    this._actionRotOffset.set(0, 0, 0);

    // Armed V quick-bash: distinct Pistol Whip (left chest -> right outward) vs Rifle Buttstock Bash
    if (this.combatMove === 'ARMED_BASH' && spec.holdClass !== 'unarmed') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const adsComp = this.weaponRig.getReadOnlyRigState().adsBlend;

      if (spec.holdClass === 'pistol') {
        const startX = -0.26 + 0.12 * adsComp;
        const startY = 0.05 + 0.04 * adsComp;
        const startZ = 0.13;
        const endX = 0.20 + 0.08 * adsComp;
        const endY = -0.01 + 0.04 * adsComp;
        const endZ = -0.04;

        if (p < 0.22) {
          const w = smoothstep(0.0, 0.22, p);
          this._actionPosOffset.x += startX * w;
          this._actionPosOffset.y += startY * w;
          this._actionPosOffset.z += startZ * w;
          this._actionRotOffset.x += 0.18 * w;
          this._actionRotOffset.y += 0.85 * w;
          this._actionRotOffset.z += 0.95 * w;
        } else if (p < 0.52) {
          const s = easeOutQuart((p - 0.22) / 0.30);
          const arcZ = -Math.sin(s * Math.PI) * 0.15;
          const arcY = Math.sin(s * Math.PI) * 0.025;
          this._actionPosOffset.x += THREE.MathUtils.lerp(startX, endX, s);
          this._actionPosOffset.y += THREE.MathUtils.lerp(startY, endY, s) + arcY;
          this._actionPosOffset.z += THREE.MathUtils.lerp(startZ, endZ, s) + arcZ;
          this._actionRotOffset.x += THREE.MathUtils.lerp(0.18, -0.16, s);
          this._actionRotOffset.y += THREE.MathUtils.lerp(0.85, -1.15, s);
          this._actionRotOffset.z += THREE.MathUtils.lerp(0.95, 0.48, s);
        } else {
          const r = smoothstep(0.52, 1.0, p);
          this._actionPosOffset.x += endX * (1 - r);
          this._actionPosOffset.y += endY * (1 - r);
          this._actionPosOffset.z += endZ * (1 - r);
          this._actionRotOffset.x += -0.16 * (1 - r);
          this._actionRotOffset.y += -1.15 * (1 - r);
          this._actionRotOffset.z += 0.48 * (1 - r);
        }
      } else {
        // Rifle / Shotgun: pivot muzzle back-left (+Y yaw) & thrust buttstock far out forward (-Z)
        const windX = -0.06 + 0.08 * adsComp;
        const windY = 0.02 - 0.02 * adsComp;
        const windZ = 0.05;
        const hitX = -0.12 + 0.08 * adsComp;
        const hitY = 0.06 - 0.03 * adsComp;
        const hitZ = -0.14 + 0.03 * adsComp;

        if (p < 0.22) {
          const w = smoothstep(0.0, 0.22, p);
          this._actionPosOffset.x += windX * w;
          this._actionPosOffset.y += windY * w;
          this._actionPosOffset.z += windZ * w;
          this._actionRotOffset.x += -0.12 * w;
          this._actionRotOffset.y += 1.85 * w;
          this._actionRotOffset.z += -0.34 * w;
        } else if (p < 0.46) {
          const s = easeOutQuart((p - 0.22) / 0.24);
          this._actionPosOffset.x += THREE.MathUtils.lerp(windX, hitX, s);
          this._actionPosOffset.y += THREE.MathUtils.lerp(windY, hitY, s);
          this._actionPosOffset.z += THREE.MathUtils.lerp(windZ, hitZ, s);
          this._actionRotOffset.x += THREE.MathUtils.lerp(-0.12, -0.22, s);
          this._actionRotOffset.y += THREE.MathUtils.lerp(1.85, 2.62, s);
          this._actionRotOffset.z += THREE.MathUtils.lerp(-0.34, -0.48, s);
        } else {
          const r = smoothstep(0.46, 1.0, p);
          const liftY = Math.sin(r * Math.PI) * 0.03;
          this._actionPosOffset.x += hitX * (1 - r);
          this._actionPosOffset.y += hitY * (1 - r) + liftY;
          this._actionPosOffset.z += hitZ * (1 - r);
          this._actionRotOffset.x += -0.22 * (1 - r);
          this._actionRotOffset.y += 2.62 * (1 - r);
          this._actionRotOffset.z += -0.48 * (1 - r);
        }
      }
    } else if (this.combatMove === 'KNIFE_SLASH' && spec.holdClass === 'melee_1h') {
      // Alternating diagonal saber slash across chest-cam center
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const dir = this.knifeSlashAlt ? 1 : -1;
      const windX = dir > 0 ? 0.13 : -0.15;
      const windY = dir > 0 ? 0.09 : -0.04;
      const windZ = 0.05;
      const endX = dir > 0 ? -0.22 : 0.18;
      const endY = dir > 0 ? -0.09 : 0.07;
      const endZ = -0.18;
      if (p < 0.20) {
        const w = smoothstep(0.0, 0.20, p);
        this._actionPosOffset.x += windX * w;
        this._actionPosOffset.y += windY * w;
        this._actionPosOffset.z += windZ * w;
        this._actionRotOffset.x += 0.28 * w;
        this._actionRotOffset.y += -dir * 0.58 * w;
        this._actionRotOffset.z += -dir * 0.65 * w;
      } else if (p < 0.50) {
        const s = easeOutQuart((p - 0.20) / 0.30);
        this._actionPosOffset.x += THREE.MathUtils.lerp(windX, endX, s);
        this._actionPosOffset.y += THREE.MathUtils.lerp(windY, endY, s);
        this._actionPosOffset.z += THREE.MathUtils.lerp(windZ, endZ, s);
        this._actionRotOffset.x += THREE.MathUtils.lerp(0.28, -0.42, s);
        this._actionRotOffset.y += THREE.MathUtils.lerp(-dir * 0.58, dir * 1.15, s);
        this._actionRotOffset.z += THREE.MathUtils.lerp(-dir * 0.65, dir * 0.92, s);
      } else {
        const r = smoothstep(0.50, 1.0, p);
        this._actionPosOffset.x += endX * (1 - r);
        this._actionPosOffset.y += endY * (1 - r);
        this._actionPosOffset.z += endZ * (1 - r);
        this._actionRotOffset.x += -0.42 * (1 - r);
        this._actionRotOffset.y += dir * 1.15 * (1 - r);
        this._actionRotOffset.z += dir * 0.92 * (1 - r);
      }
    } else if (this.combatMove === 'KNIFE_STAB' && spec.holdClass === 'melee_1h') {
      // Heavy forward saber-grip thrust straight through center sightline
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      if (p < 0.24) {
        const w = smoothstep(0.0, 0.24, p);
        this._actionPosOffset.x += 0.08 * w;
        this._actionPosOffset.y += -0.05 * w;
        this._actionPosOffset.z += 0.11 * w;
        this._actionRotOffset.x += -0.10 * w;
        this._actionRotOffset.y += -0.18 * w;
        this._actionRotOffset.z += -0.25 * w;
      } else if (p < 0.48) {
        const s = easeOutQuart((p - 0.24) / 0.24);
        this._actionPosOffset.x += THREE.MathUtils.lerp(0.08, -0.08, s);
        this._actionPosOffset.y += THREE.MathUtils.lerp(-0.05, 0.03, s);
        this._actionPosOffset.z += THREE.MathUtils.lerp(0.11, -0.27, s);
        this._actionRotOffset.x += THREE.MathUtils.lerp(-0.10, -0.16, s);
        this._actionRotOffset.y += THREE.MathUtils.lerp(-0.18, 0.24, s);
        this._actionRotOffset.z += THREE.MathUtils.lerp(-0.25, 0.42, s);
      } else {
        const r = smoothstep(0.48, 1.0, p);
        this._actionPosOffset.x += -0.08 * (1 - r);
        this._actionPosOffset.y += 0.03 * (1 - r);
        this._actionPosOffset.z += -0.27 * (1 - r);
        this._actionRotOffset.x += -0.16 * (1 - r);
        this._actionRotOffset.y += 0.24 * (1 - r);
        this._actionRotOffset.z += 0.42 * (1 - r);
      }
    } else if (this.combatMove === 'PUSH_KICK' && spec.holdClass !== 'unarmed') {
      // Brace firearm tightly across chest during Tactical Push-Kick
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const brace = smoothstep(0.0, 0.16, p) * (1 - smoothstep(0.48, 0.96, p));
      this._actionPosOffset.x += -0.07 * brace;
      this._actionPosOffset.y += -0.05 * brace;
      this._actionPosOffset.z += 0.09 * brace;
      this._actionRotOffset.x += -0.12 * brace;
      this._actionRotOffset.y += 0.44 * brace;
      this._actionRotOffset.z += 0.34 * brace;
    }

    // Unified Arm-Trauma Tremor: shakes firearm & both hands together as one rigid unit
    const tremorAmp = trauma ? trauma.tremorAmp : 0;
    if (tremorAmp > 0.0001) {
      const posScale = tremorAmp * 0.45;
      const rotScale = tremorAmp * 1.15;
      this._actionPosOffset.x +=
        (Math.sin(elapsed * 19.3) * 0.65 + Math.cos(elapsed * 28.7) * 0.35) * posScale;
      this._actionPosOffset.y +=
        (Math.cos(elapsed * 21.7 + 0.6) * 0.65 + Math.sin(elapsed * 31.1) * 0.35) * posScale;
      this._actionRotOffset.x +=
        (Math.sin(elapsed * 17.9 + 0.4) * 0.65 + Math.cos(elapsed * 26.3) * 0.35) * rotScale;
      this._actionRotOffset.y +=
        (Math.cos(elapsed * 18.7 + 1.1) * 0.65 + Math.sin(elapsed * 29.3) * 0.35) * rotScale * 0.9;
      this._actionRotOffset.z += Math.sin(elapsed * 23.1) * rotScale * 0.8;
    }

    const pdaStowW = this.pdaDevice ? this.pdaDevice.getWeaponStowBlend() : 0;
    const grenadeStowW = this.grenadeSystem ? this.grenadeSystem.getWeaponStowBlend() : 0;
    const totalStowW = Math.max(pdaStowW, grenadeStowW);
    if (totalStowW > 0.001) {
      this._actionPosOffset.y -= 0.29 * totalStowW;
      this._actionPosOffset.z += 0.14 * totalStowW;
      this._actionRotOffset.x -= 0.46 * totalStowW;
    }

    const weaponHidden =
      (this.pdaDevice?.isWeaponHidden() ?? false) || (this.grenadeSystem?.isWeaponHidden() ?? false);
    this.weaponRig.applyCharacterActionPose(
      this._actionPosOffset,
      this._actionRotOffset,
      0,
      0,
      weaponHidden,
    );
  }

  private updateUpperBodyIK(
    dt: number,
    elapsed: number,
    controller: BodycamController,
    spec: BodycamWeaponProfile,
    cyclePhase: number,
  ): void {
    const rigState = this.weaponRig.getReadOnlyRigState();
    const vault = controller.getVaultState();
    const vaultPinL = vault.active ? vault.handPinWeightL : 0;
    const vaultPinR = vault.active ? vault.handPinWeightR : 0;
    const isUnarmed = spec.holdClass === 'unarmed';
    const isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';

    // Build palm-down world brace orientation on the concrete ledge lip (-Z = fingers forward, +Y = dorsal up)
    if (vaultPinL > 0.001 || vaultPinR > 0.001) {
      this._vaultBasisZ.copy(vault.wallNormal).normalize();
      this._vaultBasisX.crossVectors(this._vaultUpAxis, this._vaultBasisZ);
      if (this._vaultBasisX.lengthSq() < 1e-4) {
        this._vaultBasisX.set(1, 0, 0);
      } else {
        this._vaultBasisX.normalize();
      }
      this._vaultBasisY.crossVectors(this._vaultBasisZ, this._vaultBasisX).normalize();
      this._vaultBasisMat.makeBasis(this._vaultBasisX, this._vaultBasisY, this._vaultBasisZ);
      this._vaultHandQuatWorld.setFromRotationMatrix(this._vaultBasisMat);
      this._vaultWristPitchQuat.setFromAxisAngle(this._vaultXAxis, -0.18);
      this._vaultHandQuatWorld.multiply(this._vaultWristPitchQuat);
      this._vaultHandQuatRoot.copy(this._vaultHandQuatWorld).premultiply(this._rootWorldQuatInv);
    }

    this.skeleton.rightArm.shoulderPivot.getWorldPosition(this._shoulderR);
    this.skeleton.leftArm.shoulderPivot.getWorldPosition(this._shoulderL);
    this.skeleton.root.worldToLocal(this._shoulderR);
    this.skeleton.root.worldToLocal(this._shoulderL);

    let rightGripCurl = spec.rightHandSocket.gripCurl ?? 0.94;
    let leftGripCurl = spec.leftHandSocket?.gripCurl ?? 0.85;
    let leftOverridden = false;
    let leftPronation = 0.62;
    let rightPronation = 0.62;
    let activePunchPoleWeight = 0;
    let activePunchExtL = 0;
    let activePunchExtR = 0;

    const eyeH = controller.getEyeHeight();
    const breathBob = Math.sin(elapsed * 2.2) * 0.0045;
    const guardStrideBob =
      this.moveWeight *
      Math.sin(cyclePhase * 2) *
      THREE.MathUtils.lerp(0.007, 0.014, this.sprintBlend);
    const kickBrace =
      this.combatMove === 'PUSH_KICK'
        ? smoothstep(0.0, 0.16, this.combatTime / Math.max(0.01, this.combatDuration)) *
          (1 - smoothstep(0.46, 0.94, this.combatTime / Math.max(0.01, this.combatDuration)))
        : 0;

    // Chest camera origin in skeleton.root local space (COLLAR_OFFSET_X=0.03, COLLAR_OFFSET_Z=0.06)
    const camLean = controller.getCurrentLean();
    this._camLocalOrigin.set(0.03 + camLean, eyeH, 0.06);
    const guardPitch = THREE.MathUtils.clamp(controller.torsoPitch * 0.72, -0.58, 0.58);
    const boltHandW = !isUnarmed ? this.weaponRig.weaponAnimator.getBoltRightHandBlend() : 0;

    if (isUnarmed) {
      const g = this.unarmedGuardBlend;
      const sprintBlend = this.unarmedSprintBlend * (1 - g);
      const aimPitchOff = rigState.aimPitch * 0.18;
      const aimYawOff = rigState.aimYaw * 0.16;

      // 1A. NON-GUARD UNARMED = NATURAL RELAXED SIDE-REST (anchored in torso/shoulder space so looking
      //     downward keeps hands resting cleanly beside hips/thighs instead of floating out in front)
      // Opposite-arm stride pendulum synced to cyclePhase (left leg steps forward when sin(cyclePhase) > 0)
      const armSwing = Math.sin(cyclePhase) * this.moveWeight * (1 - g);
      const walkFwdL = Math.max(0, -armSwing);
      const walkFwdR = Math.max(0, armSwing);

      this._readyPosL.set(
        this._shoulderL.x - 0.046 + walkFwdL * 0.014 + kickBrace * 0.05,
        this._shoulderL.y - 0.542 + Math.abs(armSwing) * 0.024 + walkFwdL * 0.024 - breathBob * 0.5 + kickBrace * 0.18,
        this._shoulderL.z - 0.036 + armSwing * 0.115 - kickBrace * 0.06,
      );
      this._readyPosR.set(
        this._shoulderR.x + 0.046 - walkFwdR * 0.014 - kickBrace * 0.05,
        this._shoulderR.y - 0.542 + Math.abs(armSwing) * 0.024 + walkFwdR * 0.024 + breathBob * 0.5 + kickBrace * 0.18,
        this._shoulderR.z - 0.036 - armSwing * 0.115 - kickBrace * 0.06,
      );

      // 1B. UNARMED ATHLETIC SPRINT (when sprinting without Guard): bent-elbow rhythmic arm pump at sides
      const runDriveL = -armSwing; // > 0 when left arm drives forward
      const runDriveR = armSwing;  // > 0 when right arm drives forward
      this._sprintPosL.set(
        this._shoulderL.x - 0.032 + Math.max(0, runDriveL) * 0.058,
        this._shoulderL.y - 0.345 + runDriveL * 0.105 + Math.max(0, -runDriveL) * 0.030,
        this._shoulderL.z - 0.225 - runDriveL * 0.155,
      );
      this._sprintPosR.set(
        this._shoulderR.x + 0.032 - Math.max(0, runDriveR) * 0.058,
        this._shoulderR.y - 0.345 + runDriveR * 0.105 + Math.max(0, -runDriveR) * 0.030,
        this._shoulderR.z - 0.225 - runDriveR * 0.155,
      );
      this._readyPosL.lerp(this._sprintPosL, sprintBlend);
      this._readyPosR.lerp(this._sprintPosR, sprintBlend);

      // 2. ADS UNARMED (Right-Click HELD) = COMPACT CHEST-CAM-FRAMED FIGHTING GUARD (also preserved during Guard-Sprint)
      // Lead handL: (-0.13, -0.05, -0.34) relative to chest cam (low enough to see clearly over knuckles)
      // Rear handR: (+0.15, -0.07, -0.24) relative to chest cam (tighter by right collarbone/jaw)
      this._guardPosL.set(
        -0.13 + aimYawOff * 0.42 + kickBrace * 0.025,
        -0.05 - breathBob * 0.7 - guardStrideBob * 0.65 + aimPitchOff * 0.45 + kickBrace * 0.03,
        -0.34 + kickBrace * 0.08,
      );
      this._guardPosR.set(
        0.15 + aimYawOff * 0.30 - kickBrace * 0.025,
        -0.07 + breathBob * 0.8 + guardStrideBob * 0.55 + aimPitchOff * 0.35 + kickBrace * 0.03,
        -0.24 + kickBrace * 0.05,
      );
      this._unarmedPitchEuler.set(guardPitch, 0, 0, 'YXZ');
      this._guardPosL.applyEuler(this._unarmedPitchEuler).add(this._camLocalOrigin);
      this._guardPosR.applyEuler(this._unarmedPitchEuler).add(this._camLocalOrigin);

      this._lDesiredRoot.copy(this._readyPosL).lerp(this._guardPosL, g);
      this._rDesiredRoot.copy(this._readyPosR).lerp(this._guardPosR, g);

      // Relaxed open-curved hands at sides -> curled athletic sprint fists -> tight clenched boxing fists in Guard
      const baseCurl = THREE.MathUtils.lerp(0.30, 0.78, sprintBlend);
      const basePron = THREE.MathUtils.lerp(0.08, 0.28, sprintBlend);
      leftGripCurl = THREE.MathUtils.lerp(baseCurl, 0.98, g);
      rightGripCurl = THREE.MathUtils.lerp(baseCurl, 0.98, g);
      // Natural inward-facing palms at sides -> ~36° inward boxing angle in guard
      leftPronation = THREE.MathUtils.lerp(basePron, 0.62, g);
      rightPronation = THREE.MathUtils.lerp(basePron, 0.62, g);

      // 3. Alternating LEFT_JAB / RIGHT_CROSS ballistic drive + forearm pronation + guard speed scaling
      if (this.combatMove === 'LEFT_JAB' || this.combatMove === 'RIGHT_CROSS') {
        const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        const ext = Math.max(0, drive);
        const coil = Math.min(0, drive);
        const punchEnv = smoothstep(0.0, this.punchFromGuard ? 0.06 : 0.14, p) * (1 - smoothstep(0.66, 1.0, p));
        activePunchPoleWeight = Math.max(g, punchEnv);

        // Clench both fists crisply throughout punch execution
        leftGripCurl = Math.max(leftGripCurl, THREE.MathUtils.lerp(0.42, 0.98, Math.max(punchEnv, ext)));
        rightGripCurl = Math.max(rightGripCurl, THREE.MathUtils.lerp(0.42, 0.98, Math.max(punchEnv, ext)));

        this._punchEuler.set(
          THREE.MathUtils.clamp(rigState.aimPitch + controller.torsoPitch * 0.72, -0.85, 0.85),
          rigState.aimYaw,
          0,
          'YXZ',
        );
        this._punchAimDirLocal.set(0, 0, -1).applyEuler(this._punchEuler).normalize();

        if (this.combatMove === 'LEFT_JAB') {
          activePunchExtL = ext;
          // Non-ADS Ready punch chambers/raises up from the ribs into guard strike plane before extending
          if (!this.punchFromGuard) {
            this._lDesiredRoot.lerp(this._guardPosL, punchEnv);
            this._rDesiredRoot.lerp(this._guardPosR, punchEnv * 0.72);
            leftPronation = THREE.MathUtils.lerp(leftPronation, 0.62, punchEnv);
            rightPronation = THREE.MathUtils.lerp(rightPronation, 0.62, punchEnv * 0.72);
          }

          this._punchTargetLocal
            .copy(this._shoulderL)
            .addScaledVector(this._punchAimDirLocal, 0.57);
          this._punchTargetLocal.x += 0.135;
          this._punchTargetLocal.y += 0.125;

          if (drive >= 0) {
            this._lDesiredRoot.lerp(this._punchTargetLocal, ext);
          } else {
            const coilScale = this.punchFromGuard ? 0.05 : 0.11;
            this._lDesiredRoot.z += -coil * coilScale;
            this._lDesiredRoot.y += coil * (this.punchFromGuard ? 0.015 : 0.04);
          }
          // Crisp forearm pronation into horizontal impact knuckles (0.62 -> 1.54 rad)
          leftPronation = THREE.MathUtils.lerp(leftPronation, 1.54, smoothstep(0.06, 0.76, ext));

          // Pull rear right hand tight to right collarbone/jaw guard
          this._rDesiredRoot.x -= 0.028 * ext;
          this._rDesiredRoot.y += 0.025 * ext;
          this._rDesiredRoot.z += 0.040 * ext;
        } else {
          activePunchExtR = ext;
          if (!this.punchFromGuard) {
            this._rDesiredRoot.lerp(this._guardPosR, punchEnv);
            this._lDesiredRoot.lerp(this._guardPosL, punchEnv * 0.78);
            rightPronation = THREE.MathUtils.lerp(rightPronation, 0.62, punchEnv);
            leftPronation = THREE.MathUtils.lerp(leftPronation, 0.62, punchEnv * 0.78);
          }

          this._punchTargetLocal
            .copy(this._shoulderR)
            .addScaledVector(this._punchAimDirLocal, 0.61);
          this._punchTargetLocal.x -= 0.155;
          this._punchTargetLocal.y += 0.135;

          if (drive >= 0) {
            this._rDesiredRoot.lerp(this._punchTargetLocal, ext);
          } else {
            const coilScale = this.punchFromGuard ? 0.06 : 0.14;
            this._rDesiredRoot.z += -coil * coilScale;
            this._rDesiredRoot.x += -coil * (this.punchFromGuard ? 0.03 : 0.06);
            this._rDesiredRoot.y += coil * (this.punchFromGuard ? 0.015 : 0.04);
          }
          // Crisp forearm pronation into horizontal power-cross impact knuckles
          rightPronation = THREE.MathUtils.lerp(rightPronation, 1.54, smoothstep(0.06, 0.76, ext));

          // Pull lead left hand tight back to protect left jaw/chin
          this._lDesiredRoot.x += 0.032 * ext;
          this._lDesiredRoot.y += 0.040 * ext;
          this._lDesiredRoot.z += 0.105 * ext;
        }
      }
    } else {
      // Exact right-hand socket transform in skeleton.root local space for equipped weapons
      this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._rDesiredRoot);
      this.skeleton.root.worldToLocal(this._rDesiredRoot);
      this.weaponRig.rightHandSocketAnchor.getWorldQuaternion(this._rDesiredQuatRoot);
      this._rDesiredQuatRoot.premultiply(this._rootWorldQuatInv);

      if (boltHandW > 0.001) {
        // Track physical bolt knob socket directly (rotates upward & pulls rearward with boltHandlePivot)
        if (!this.weaponRig.getBoltHandleWorldPosition(this._boltRackRoot)) {
          this.weaponRig.boltRackAnchor.getWorldPosition(this._boltRackRoot);
          const boltOffsetZ = this.weaponRig.weaponAnimator.getBoltCycleOffsetZ();
          if (Math.abs(boltOffsetZ) > 1e-5) {
            this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
            this._inspectSlideWorld.set(0, 0, boltOffsetZ).applyQuaternion(this._inspectWeaponQuat);
            this._boltRackRoot.add(this._inspectSlideWorld);
          }
        }
        this.skeleton.root.worldToLocal(this._boltRackRoot);
        this._rDesiredRoot.lerp(this._boltRackRoot, boltHandW);
        rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, 0.90, boltHandW);
      }
    }

    // World-locked right-hand IK pinning during two-handed HIGH_MANTLE
    if (vaultPinR > 0.001) {
      this._vaultHandRRoot.copy(vault.handRWorld);
      this.skeleton.root.worldToLocal(this._vaultHandRRoot);
      this._rDesiredRoot.lerp(this._vaultHandRRoot, vaultPinR);
      if (!isUnarmed) {
        this._rDesiredQuatRoot.slerp(this._vaultHandQuatRoot, vaultPinR);
      }
      rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, 0.16, vaultPinR);
    }

    const pdaStowW = this.pdaDevice ? this.pdaDevice.getWeaponStowBlend() : 0;
    const pdaIkW = smoothstep(0.08, 0.85, pdaStowW);
    const pdaActiveHold =
      this.pdaDevice !== null && pdaIkW > 0.02 && vaultPinR < 0.15 && vaultPinL < 0.15;

    const grenadeStowW = this.grenadeSystem ? this.grenadeSystem.getWeaponStowBlend() : 0;
    const grenadeIkW = smoothstep(0.18, 0.72, grenadeStowW);
    const grenadeActiveHold =
      this.grenadeSystem !== null &&
      grenadeIkW > 0.02 &&
      !pdaActiveHold &&
      vaultPinR < 0.15 &&
      vaultPinL < 0.15;

    if (pdaActiveHold) {
      this.pdaDevice!.getRightGripWorldTransform(this._pdaRPosRoot, this._pdaRQuatRoot);
      this.skeleton.root.worldToLocal(this._pdaRPosRoot);
      this._pdaRQuatRoot.premultiply(this._rootWorldQuatInv);

      if (isUnarmed) {
        this._rDesiredQuatRoot.copy(this._pdaRQuatRoot);
      } else {
        this._rDesiredQuatRoot.slerp(this._pdaRQuatRoot, pdaIkW);
      }
      this._rDesiredRoot.lerp(this._pdaRPosRoot, pdaIkW);
      rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, 0.45, pdaIkW);
    } else if (grenadeActiveHold && this.grenadeSystem) {
      const gs = this.grenadeSystem;
      const gStage = gs.getHoldStage();
      const gPhase = gs.getPinPullPhase();
      const gCharge = gs.getCharge01();
      const gStyle = gs.getThrowStyle();
      const gWhip = gs.getThrowWhipProgress();
      const gHeld = gs.isThrowInputHeld();

      // Base chest-ready right palm target (relative to chest camera origin)
      const idleBobY = Math.sin(elapsed * 2.2) * 0.003;
      const drawReach = 1 - smoothstep(0.20, 0.56, grenadeStowW);
      const readyX = 0.185;
      const readyY = -0.105 + idleBobY;
      const readyZ = -0.335;

      // Interpolate from belt/hip grab up to chest ready
      this._grenadeRPos.set(
        THREE.MathUtils.lerp(readyX, 0.22, drawReach),
        THREE.MathUtils.lerp(readyY, -0.34, drawReach),
        THREE.MathUtils.lerp(readyZ, -0.08, drawReach),
      );

      let pitchTilt = guardPitch * 0.65;
      let yawTwist = 0.24;
      let rollTwist = -Math.PI * 0.5;

      if (gStage === 'PIN_PULLED' || gStage === 'LEVER_RELEASED') {
        if (gPhase === 'REACH_PIN' || gPhase === 'PULL_PIN') {
          // Bring grenade gently closer to center-chest so left hand pinches ring cleanly
          this._grenadeRPos.set(0.145, -0.095 + idleBobY, -0.315);
          yawTwist = 0.34;
        }
        if (gHeld) {
          if (gStyle === 'underhand') {
            // Quick LMB click (<0.18s) preparation: drop smoothly to hip scoop
            const prepT = smoothstep(0.0, 0.16, gs.getCharge01() + 0.45);
            this._grenadeRPos.x = THREE.MathUtils.lerp(this._grenadeRPos.x, 0.205, prepT);
            this._grenadeRPos.y = THREE.MathUtils.lerp(this._grenadeRPos.y, -0.255, prepT);
            this._grenadeRPos.z = THREE.MathUtils.lerp(this._grenadeRPos.z, -0.14, prepT);
            pitchTilt = -0.45;
            yawTwist = 0.12;
          } else {
            // Hold LMB (>=0.18s): Overhand Power Charge draws arm UP & BACK behind right shoulder/ear
            const wind = smoothstep(0.0, 1.0, gCharge);
            const peakTremor =
              gCharge > 0.85
                ? Math.sin(elapsed * 44) * 0.0032 * ((gCharge - 0.85) / 0.15)
                : 0;
            this._grenadeRPos.set(
              THREE.MathUtils.lerp(0.18, 0.295, wind) + peakTremor,
              THREE.MathUtils.lerp(-0.09, 0.065, wind) + peakTremor * 0.6,
              THREE.MathUtils.lerp(-0.31, 0.075, wind),
            );
            pitchTilt = THREE.MathUtils.lerp(guardPitch * 0.65, 0.68, wind);
            yawTwist = THREE.MathUtils.lerp(0.24, -0.28, wind);
            rollTwist = THREE.MathUtils.lerp(-Math.PI * 0.5, -Math.PI * 0.42, wind);
          }
        } else if (gWhip > 0.001) {
          if (gStyle === 'overhand') {
            // Explosive forward whip over shoulder -> release forward -> follow-through down
            if (gWhip < 0.38) {
              const t = smoothstep(0, 0.38, gWhip);
              this._grenadeRPos.set(
                THREE.MathUtils.lerp(0.28, 0.115, t),
                THREE.MathUtils.lerp(0.06, 0.025, t),
                THREE.MathUtils.lerp(0.06, -0.44, t),
              );
              pitchTilt = THREE.MathUtils.lerp(0.65, -0.24, t);
              yawTwist = THREE.MathUtils.lerp(-0.22, 0.18, t);
            } else {
              const t = smoothstep(0.38, 1.0, gWhip);
              this._grenadeRPos.set(
                THREE.MathUtils.lerp(0.115, -0.02, t),
                THREE.MathUtils.lerp(0.025, -0.22, t),
                THREE.MathUtils.lerp(-0.44, -0.26, t),
              );
              pitchTilt = THREE.MathUtils.lerp(-0.24, -0.58, t);
              yawTwist = 0.24;
            }
          } else {
            // Smooth Underhand Lob scoop upward-forward
            if (gWhip < 0.42) {
              const t = smoothstep(0, 0.42, gWhip);
              this._grenadeRPos.set(
                THREE.MathUtils.lerp(0.20, 0.105, t),
                THREE.MathUtils.lerp(-0.25, -0.045, t),
                THREE.MathUtils.lerp(-0.12, -0.42, t),
              );
              pitchTilt = THREE.MathUtils.lerp(-0.45, 0.32, t);
              yawTwist = 0.14;
            } else {
              const t = smoothstep(0.42, 1.0, gWhip);
              this._grenadeRPos.set(
                THREE.MathUtils.lerp(0.105, 0.06, t),
                THREE.MathUtils.lerp(-0.045, -0.14, t),
                THREE.MathUtils.lerp(-0.42, -0.30, t),
              );
              pitchTilt = THREE.MathUtils.lerp(0.32, 0.05, t);
            }
          }
        }
      }

      if (gStage === 'LEVER_RELEASED') {
        const cookRatio = gs.getCookRatio();
        const burnTremor = Math.sin(elapsed * 36) * 0.0018 * (0.4 + cookRatio);
        this._grenadeRPos.x += burnTremor;
        this._grenadeRPos.y += Math.cos(elapsed * 43) * 0.0012 * (0.4 + cookRatio);
      }

      this._unarmedPitchEuler.set(guardPitch * 0.72, 0, 0, 'YXZ');
      this._grenadeRPos.applyEuler(this._unarmedPitchEuler).add(this._camLocalOrigin);

      this._grenadeHandEuler.set(pitchTilt, yawTwist, rollTwist, 'YXZ');
      this._grenadeHandQuat.setFromEuler(this._grenadeHandEuler);

      if (isUnarmed) {
        this._rDesiredQuatRoot.copy(this._grenadeHandQuat);
      } else {
        this._rDesiredQuatRoot.slerp(this._grenadeHandQuat, grenadeIkW);
      }
      this._rDesiredRoot.lerp(this._grenadeRPos, grenadeIkW);
      rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, gWhip > 0.32 ? 0.35 : 0.92, grenadeIkW);
    }

    if (this.wasPdaActive && !pdaActiveHold) {
      this.rightPdaReturnTimer = 0.14;
    }
    this.wasPdaActive = pdaActiveHold;
    if (this.rightPdaReturnTimer > 0) {
      this.rightPdaReturnTimer = Math.max(0, this.rightPdaReturnTimer - dt);
    }

    if (this.wasGrenadeActive && !grenadeActiveHold) {
      this.rightGrenadeReturnTimer = 0.16;
    }
    this.wasGrenadeActive = grenadeActiveHold;
    if (this.rightGrenadeReturnTimer > 0) {
      this.rightGrenadeReturnTimer = Math.max(0, this.rightGrenadeReturnTimer - dt);
    }

    const extIk = this.externalHandOverride && this.externalHandOverride.active ? this.externalHandOverride : null;
    const extRightW = extIk ? THREE.MathUtils.clamp(extIk.rightWeight, 0, 1) : 0;
    if (extIk && extRightW > 0.001) {
      this._extRPosRoot.copy(extIk.rightWorldPos);
      this.skeleton.root.worldToLocal(this._extRPosRoot);
      this._extRQuatRoot.copy(extIk.rightWorldQuat).premultiply(this._rootWorldQuatInv);
      this._rDesiredRoot.lerp(this._extRPosRoot, extRightW);
      if (isUnarmed) {
        this._rDesiredQuatRoot.copy(this._extRQuatRoot);
      } else {
        this._rDesiredQuatRoot.slerp(this._extRQuatRoot, extRightW);
      }
      rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, extIk.rightGripCurl, extRightW);
    }

    const usePdaRightQuat = pdaActiveHold && pdaIkW > 0.35;
    const useGrenadeRightQuat = grenadeActiveHold && grenadeIkW > 0.25;
    const useExtRightQuat = extRightW > 0.05;
    const pdaLockedRight =
      pdaActiveHold &&
      pdaIkW >= 0.98 &&
      this.equipBlendTimer <= 0 &&
      vaultPinR < 0.001 &&
      !useExtRightQuat &&
      this.rightPdaReturnTimer <= 0;
    if (
      !pdaLockedRight &&
      (this.equipBlendTimer > 0 ||
        vaultPinR > 0.001 ||
        boltHandW > 0.001 ||
        pdaActiveHold ||
        grenadeActiveHold ||
        useExtRightQuat ||
        this.rightPdaReturnTimer > 0 ||
        this.rightGrenadeReturnTimer > 0)
    ) {
      this.rightHandBlender.blendTo(
        this._rDesiredRoot,
        isUnarmed && !usePdaRightQuat && !useGrenadeRightQuat && !useExtRightQuat
          ? this.rightHandBlender.quaternion
          : this._rDesiredQuatRoot,
        rightGripCurl,
        1,
        vaultPinR > 0.001
          ? 36
          : useExtRightQuat
            ? 42
            : grenadeActiveHold || pdaActiveHold || this.rightPdaReturnTimer > 0 || this.rightGrenadeReturnTimer > 0
              ? 36
              : boltHandW > 0.001
                ? 34
                : 32,
        dt,
      );
    } else {
      this.rightHandBlender.snap(
        this._rDesiredRoot,
        isUnarmed && !usePdaRightQuat ? this.rightHandBlender.quaternion : this._rDesiredQuatRoot,
        rightGripCurl,
        1,
      );
    }

    this._rTargetRoot.copy(this.rightHandBlender.position);
    this._rQuatRoot.copy(this.rightHandBlender.quaternion);

    // Elbow poles:
    //  - Unarmed Non-ADS Ready: natural downward-back hang by sides
    //  - Unarmed ADS Guard: pulled downward & inward tight against ribs (x: ±0.20, y: -0.45, z: +0.10 relative to chest cam)
    //  - Armed / Vault / Grenade: ergonomic flare
    const effectiveAimPitch = THREE.MathUtils.clamp(controller.torsoPitch + rigState.aimPitch, -0.95, 1.25);
    const upwardPoleLift = Math.max(0, effectiveAimPitch);
    this._aimPoleEuler.set(
      effectiveAimPitch * 0.62,
      rigState.aimYaw * 0.70,
      -controller.getCurrentLean() * 0.85,
      'YXZ',
    );
    if (isUnarmed) {
      const poleGuardW = Math.max(this.unarmedGuardBlend, activePunchPoleWeight);
      const sprintPoleW = this.unarmedSprintBlend * (1 - poleGuardW);

      this._readyPoleR.set(this._shoulderR.x + 0.14, this._shoulderR.y - 0.30, this._shoulderR.z + 0.28);
      this._readyPoleL.set(this._shoulderL.x - 0.14, this._shoulderL.y - 0.30, this._shoulderL.z + 0.28);
      this._sprintPoleR.set(this._shoulderR.x + 0.16, this._shoulderR.y - 0.34, this._shoulderR.z + 0.38);
      this._sprintPoleL.set(this._shoulderL.x - 0.16, this._shoulderL.y - 0.34, this._shoulderL.z + 0.38);
      this._readyPoleR.lerp(this._sprintPoleR, sprintPoleW);
      this._readyPoleL.lerp(this._sprintPoleL, sprintPoleW);

      this._unarmedPitchEuler.set(guardPitch * 0.45, 0, 0, 'YXZ');
      this._guardPoleR
        .set(0.20 + activePunchExtR * 0.16, -0.45, 0.10)
        .applyEuler(this._unarmedPitchEuler)
        .add(this._camLocalOrigin);
      this._guardPoleL
        .set(-0.20 - activePunchExtL * 0.16, -0.45, 0.10)
        .applyEuler(this._unarmedPitchEuler)
        .add(this._camLocalOrigin);

      this._poleR.copy(this._readyPoleR).lerp(this._guardPoleR, poleGuardW);
      this._poleL.copy(this._readyPoleL).lerp(this._guardPoleL, poleGuardW);
    } else {
      const ptW = rigState.pointAimBlend;
      this._poleR
        .set(0.35 + ptW * 0.09, -0.55 + ptW * 0.14, 0.28 - ptW * 0.03)
        .applyEuler(this._aimPoleEuler)
        .add(this._shoulderR);
      // Tuck support elbow cleanly underneath the elevated handguard when pitching upward in ADS
      this._poleL
        .set(-0.35 + upwardPoleLift * 0.10, -0.55 + upwardPoleLift * 0.12, 0.28 - upwardPoleLift * 0.06)
        .applyEuler(this._aimPoleEuler)
        .add(this._shoulderL);
    }
    if (pdaActiveHold) {
      this._pdaPoleR.set(this._shoulderR.x + 0.30, this._shoulderR.y - 0.50, this._shoulderR.z + 0.16);
      this._pdaPoleL.set(this._shoulderL.x - 0.30, this._shoulderL.y - 0.50, this._shoulderL.z + 0.16);
      this._poleR.lerp(this._pdaPoleR, pdaIkW);
      this._poleL.lerp(this._pdaPoleL, pdaIkW);
    } else if (grenadeActiveHold && this.grenadeSystem) {
      const charge = this.grenadeSystem.getCharge01();
      const overhand = this.grenadeSystem.getThrowStyle() === 'overhand' && (this.grenadeSystem.isThrowInputHeld() || this.grenadeSystem.getThrowWhipProgress() > 0);
      this._grenadePoleR.set(
        this._shoulderR.x + (overhand ? 0.46 : 0.32),
        this._shoulderR.y + (overhand ? -0.18 + charge * 0.08 : -0.48),
        this._shoulderR.z + (overhand ? 0.26 : 0.22),
      );
      this._grenadePoleL.set(
        this._shoulderL.x - 0.34,
        this._shoulderL.y - 0.46,
        this._shoulderL.z + 0.20,
      );
      this._poleR.lerp(this._grenadePoleR, grenadeIkW);
      this._poleL.lerp(this._grenadePoleL, grenadeIkW);
    }
    if (vaultPinR > 0.05) {
      this._poleR.set(this._shoulderR.x + 0.42, this._shoulderR.y - 0.36, this._shoulderR.z + 0.22);
    }
    if (vaultPinL > 0.05) {
      this._poleL.set(this._shoulderL.x - 0.42, this._shoulderL.y - 0.36, this._shoulderL.z + 0.22);
    }

    const armR = this.skeleton.rightArm;
    const armL = this.skeleton.leftArm;

    // 1. Solve Right Arm 2-Bone IK + Forearm-Aligned Zero-Hyperextension Wrist Orientation
    this.skeleton.root.updateMatrixWorld(true);
    solveTwoBoneIK(this._shoulderR, this._rTargetRoot, this._poleR, armR.upperLen, armR.lowerLen, this.rightArmIK);
    orientLimbAlongYInRootSpace(armR.upperArm, this.skeleton.root, this._shoulderR, this.rightArmIK.midPos, this._poleR);
    if (isUnarmed && !usePdaRightQuat && !useGrenadeRightQuat && !useExtRightQuat) {
      this.computeUnarmedForearmAlignedHandQuat(1, this.rightArmIK.dir2, rightPronation, this._handAlignedQuat);
      if (vaultPinR > 0.001) {
        this._handAlignedQuat.slerp(this._vaultHandQuatRoot, vaultPinR);
      }
      if (this.equipBlendTimer > 0) {
        const alpha = 1 - Math.exp(-32 * dt);
        this.rightHandBlender.quaternion.slerp(this._handAlignedQuat, alpha);
      } else {
        this.rightHandBlender.quaternion.copy(this._handAlignedQuat);
      }
      this._rQuatRoot.copy(this.rightHandBlender.quaternion);
    }
    this.orientForearmToHand(
      armR.forearm,
      this.rightArmIK.midPos,
      this.rightArmIK.endPos,
      this._rQuatRoot,
      this._dorsalR,
    );
    setTransformInRootSpace(armR.hand.root, this.skeleton.root, this.rightArmIK.endPos, this._rQuatRoot);
    this.skeleton.root.updateMatrixWorld(true);
    armR.hand.root.updateWorldMatrix(true, false);

    // Synchronize physical bone-mounted ordnance & evaluate bone-locked throw release post-IK!
    if (this.grenadeSystem) {
      this.grenadeSystem.syncHeldBoneAttachment(
        this.skeleton.throwHandSocket,
        this.skeleton.leftPinPinchSocket,
        this.skeleton.leftPocketAnchor,
      );
      if (this.grenadeSystem.isThrowing()) {
        this.skeleton.throwHandSocket.updateWorldMatrix(true, false);
        this.skeleton.throwHandSocket.getWorldPosition(this._grenadeReleaseOrigin);
        controller.getCamera().getWorldDirection(this._grenadeReleaseForward);
        controller.getVelocity(this._ctrlVel);
        this.grenadeSystem.consumePendingThrowRelease(
          this._grenadeReleaseOrigin,
          this._grenadeReleaseForward,
          this._ctrlVel,
        );
      }
    }

    const anim = this.weaponRig.weaponAnimator;
    const weaponAsm = this.weaponRig.getModelAssembly();
    const weaponAction = anim.getActiveAction();
    const triggerPull01 = anim.getTriggerPull01();
    const activelyFiring = triggerPull01 > 0.015 || rigState.recoilZ > 0.004;
    if (activelyFiring && isFirearm) {
      // Hold finger naturally on trigger shoe for 0.45s after each shot so hip-fire bursts never flicker
      this.triggerHoldoverTimer = 0.45;
    } else if (this.triggerHoldoverTimer > 0) {
      this.triggerHoldoverTimer = Math.max(0, this.triggerHoldoverTimer - dt);
    }

    // Strict trigger discipline: right index finger straight off trigger during Sprint, Low-Ready/Wall-Pullback,
    // Safe-Zone (FOB/Hideout), Inspect, Reload, Tubular Reload, Mag-Check, Suppressor Toggle, and Bolt Cycling
    const canEngageTrigger =
      isFirearm &&
      !this.safeZoneDiscipline &&
      rigState.pullbackRatio < 0.35 &&
      !pdaActiveHold &&
      !grenadeActiveHold &&
      vaultPinR < 0.05 &&
      boltHandW < 0.05 &&
      !controller.isSprinting &&
      weaponAction === 'NONE' &&
      !anim.isTubularReloading();
    const wantsTriggerOn =
      canEngageTrigger &&
      (controller.isAds ||
        controller.isCanted ||
        controller.isPointAim ||
        this.triggerHoldoverTimer > 0 ||
        activelyFiring);
    if (!canEngageTrigger) {
      this.triggerHoldoverTimer = 0;
    }
    this.triggerEngageBlend = THREE.MathUtils.damp(
      this.triggerEngageBlend,
      wantsTriggerOn ? 1 : 0,
      wantsTriggerOn ? 18 : 14,
      dt,
    );
    const triggerEngaged = this.triggerEngageBlend > 0.5;
    if (pdaActiveHold && pdaIkW > 0.55) {
      // Deferred until after both Right & Left 2-bone arm IK + post-IK PDA reach guard complete
    } else if (grenadeActiveHold && grenadeIkW > 0.45 && this.grenadeSystem) {
      this._rightHandPoseOpts.profile = null;
      this._rightHandPoseOpts.triggerEngageBlend = 0;
      this._rightHandPoseOpts.triggerPull01 = 0;
      this._rightHandPoseOpts.thumbFlick01 = 0;
      this._rightHandPoseOpts.pinchPose01 = 0;
      this._rightHandPoseOpts.gripRelease01 = 0;
      this._rightHandPoseOpts.suppressorGrip = false;
      this._rightHandPoseOpts.padTap01 = 0;
      this._rightHandPoseOpts.leverReleased = this.grenadeSystem.isLeverReleased();
      this.skeleton.applyHandPose(
        'right',
        'throwable',
        false,
        this.rightHandBlender.gripCurl,
        'none',
        this._rightHandPoseOpts,
      );
    } else {
      this._rightHandPoseOpts.profile = weaponAsm?.handPoseProfile ?? null;
      this._rightHandPoseOpts.triggerEngageBlend = this.triggerEngageBlend;
      this._rightHandPoseOpts.triggerPull01 = triggerPull01;
      this._rightHandPoseOpts.thumbFlick01 = anim.getRightThumbFlick01();
      this._rightHandPoseOpts.pinchPose01 = 0;
      this._rightHandPoseOpts.gripRelease01 = 0;
      this._rightHandPoseOpts.suppressorGrip = false;
      this._rightHandPoseOpts.padTap01 = 0;
      this._rightHandPoseOpts.leverReleased = false;
      this.skeleton.applyHandPose(
        'right',
        vaultPinR > 0.2 || isUnarmed ? 'unarmed' : spec.holdClass,
        triggerEngaged,
        this.rightHandBlender.gripCurl,
        'none',
        this._rightHandPoseOpts,
      );
    }

    // 2. Post-IK Rigid Hard-Lock: align weaponRig.root to solved right hand in hip-fire/action,
    //    while preserving rigid camera-to-sightAnchor alignment during ADS / Canted / Point Aim on both Q and E leans.
    const aimLockWeightPost =
      !isUnarmed &&
      weaponAction === 'NONE' &&
      this.combatMove === 'NONE' &&
      vaultPinR < 0.05 &&
      vaultPinL < 0.05
        ? Math.max(rigState.adsBlend, rigState.cantBlend, rigState.pointAimBlend)
        : 0;
    const hardLockW =
      extIk?.suppressWeaponHardLock
        ? 0
        : (1 - aimLockWeightPost) * (1 - smoothstep(0.02, 0.25, Math.max(pdaIkW, grenadeIkW)));

    if (!isUnarmed && extIk?.suppressWeaponHardLock && extRightW > 0.05) {
      // Sling weapon down cleanly against the chest so two-handed repair animations are unobstructed
      this.weaponRig.root.position.y -= 0.42 * extRightW;
    }

    if (!isUnarmed && vaultPinR < 0.12 && boltHandW < 0.02 && hardLockW > 0.001) {
      armR.hand.root.getWorldPosition(this._solvedHandRWorldPos);
      armR.hand.root.getWorldQuaternion(this._solvedHandRWorldQuat);
      this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._currSocketRWorldPos);
      this.weaponRig.rightHandSocketAnchor.getWorldQuaternion(this._currSocketRWorldQuat);

      this._lockDeltaQuat
        .copy(this._currSocketRWorldQuat)
        .invert()
        .premultiply(this._solvedHandRWorldQuat);

      if (hardLockW < 0.999) {
        this._lockBlendQuat.copy(this._identityQuat).slerp(this._lockDeltaQuat, hardLockW);
        this.weaponRig.root.quaternion.premultiply(this._lockBlendQuat);
        this._lockDeltaPos
          .copy(this.weaponRig.root.position)
          .sub(this._currSocketRWorldPos)
          .applyQuaternion(this._lockBlendQuat)
          .add(this._solvedHandRWorldPos)
          .sub(this.weaponRig.root.position);
        this.weaponRig.root.position.addScaledVector(this._lockDeltaPos, hardLockW);
      } else {
        this.weaponRig.root.quaternion.premultiply(this._lockDeltaQuat);
        this.weaponRig.root.position
          .sub(this._currSocketRWorldPos)
          .applyQuaternion(this._lockDeltaQuat)
          .add(this._solvedHandRWorldPos);
      }
      this.weaponRig.root.updateMatrixWorld(true);
    }

    // 3. Sample Left Hand target AFTER right-hand hard-lock (for armed weapons)
    //    Uses live `assembly.leftHandSocket` transform so pump-action shotguns weld support hand 1:1 to `pumpForend`!
    let leftPinchPose01 = 0;
    let leftPadTap01 = 0;
    let leftSuppressorGrip = false;
    let leftGripRelease01 = 0;

    if (!isUnarmed) {
      if (this.weaponRig.hasLeftHandSocket) {
        if (!this.weaponRig.getLiveLeftHandSocketWorldTransform(this._lDesiredRoot, this._lDesiredQuatRoot)) {
          this.weaponRig.leftHandSocketAnchor.getWorldPosition(this._lDesiredRoot);
          this.weaponRig.leftHandSocketAnchor.getWorldQuaternion(this._lDesiredQuatRoot);
        }
        // Subtle natural handL shift along handguard during Inspect Phase 2
        const inspectSlideZ = anim.getInspectLeftHandSlideZ();
        if (Math.abs(inspectSlideZ) > 1e-5) {
          this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.set(0, 0, inspectSlideZ).applyQuaternion(this._inspectWeaponQuat);
          this._lDesiredRoot.add(this._inspectSlideWorld);
        }
        this.skeleton.root.worldToLocal(this._lDesiredRoot);
        this._lDesiredQuatRoot.premultiply(this._rootWorldQuatInv);
        if (weaponAsm) {
          leftGripCurl = weaponAsm.leftGripCurl;
        }
      } else {
        const guardBob = Math.sin(elapsed * 2.0) * 0.006;
        this._lDesiredRoot.set(-0.20, eyeH - 0.22 + guardBob, -0.05);
        this._tmpEuler.set(0.25, -0.35, 0.45, 'YXZ');
        this._lDesiredQuatRoot.setFromEuler(this._tmpEuler);
        leftGripCurl = 0.72;
      }
    }

    if (vaultPinL > 0.001) {
      // World-locked left-hand brace on concrete/metal ledge lip (zero sliding)
      leftOverridden = true;
      this._vaultHandLRoot.copy(vault.handLWorld);
      this.skeleton.root.worldToLocal(this._vaultHandLRoot);
      this._lDesiredRoot.lerp(this._vaultHandLRoot, vaultPinL);
      if (!isUnarmed) {
        this._lDesiredQuatRoot.slerp(this._vaultHandQuatRoot, vaultPinL);
      }
      leftGripCurl = THREE.MathUtils.lerp(leftGripCurl, 0.16, vaultPinL);
    } else if (weaponAction === 'RELOAD' && isFirearm) {
      // Platform-specific physical detachable magazine reload IK:
      //  - MP5 H&K Slap (empty): Lock cocking handle into notch -> Strip curved mag -> Swap -> Seat -> Open-palm downward H&K Slap!
      //  - AR-15: Strip -> Swap -> Seat & subtle tug verification -> Left-receiver bolt-catch paddle palm slap
      //  - Pistols: 30° inward cant -> Strip along grip-rake -> Seat + upward baseplate palm-tap -> Rack/Release
      //  - AK / Standard: Front-lug rock-and-lock mag seat -> Asymmetric charging-handle rack
      leftOverridden = true;
      const p = anim.getActionProgress();
      const platformStyle = anim.getReloadPlatformStyle();
      const arSlap = platformStyle === 'ar_bolt_catch';
      const hkSlap = platformStyle === 'mp5_hk_slap';
      const isPistolReload = platformStyle === 'pistol_cant';

      this.skeleton.magPouchAnchor.getWorldPosition(this._magPouchRoot);
      this.skeleton.root.worldToLocal(this._magPouchRoot);
      this.weaponRig.magWellAnchor.getWorldPosition(this._magWellRoot);
      this.skeleton.root.worldToLocal(this._magWellRoot);
      this.weaponRig.boltRackAnchor.getWorldPosition(this._boltRackRoot);
      this.skeleton.root.worldToLocal(this._boltRackRoot);

      if (hkSlap) {
        if (p < 0.14) {
          // Lock MP5 cocking handle rearward & upward into detent notch
          const t = smoothstep(0.0, 0.08, p);
          const pullBack = smoothstep(0.04, 0.13, p) * 0.052;
          this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.set(0, 0.014 * smoothstep(0.09, 0.14, p), pullBack).applyQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.applyQuaternion(this._rootWorldQuatInv);
          this._tmpWorldB.copy(this._boltRackRoot).add(this._inspectSlideWorld);
          this._lDesiredRoot.lerp(this._tmpWorldB, t);
          leftGripCurl = 0.90;
        } else if (p < 0.21) {
          // Sweep from cocking tube down to curved 9mm magazine
          const t = smoothstep(0.14, 0.21, p);
          this._lDesiredRoot.copy(this._boltRackRoot).lerp(this._magWellRoot, t);
          leftGripCurl = THREE.MathUtils.lerp(0.84, 0.95, t);
        } else if (p < 0.37) {
          // Strip curved mag cleanly down to chest pouch
          const t = smoothstep(0.21, 0.37, p);
          this._lDesiredRoot.copy(this._magWellRoot).lerp(this._magPouchRoot, t);
          leftGripCurl = 0.95;
        } else if (p < 0.48) {
          const t = smoothstep(0.37, 0.48, p);
          this._lDesiredRoot.copy(this._magPouchRoot);
          this._lDesiredRoot.y -= Math.sin(t * Math.PI) * 0.032;
          leftGripCurl = THREE.MathUtils.lerp(0.76, 0.95, t);
        } else if (p < 0.65) {
          // Insert fresh curved 9mm mag firmly into flared magwell
          const t = smoothstep(0.48, 0.63, p);
          this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._magWellRoot, t);
          leftGripCurl = 0.95;
        } else if (p < 0.86) {
          // Open-palm windup above cocking tube -> violent downward H&K Slap at p ~ 0.75!
          const reachT = smoothstep(0.65, 0.72, p);
          const slapStrike = p >= 0.72 && p <= 0.81 ? smoothstep(0.72, 0.76, p) : 0;
          const slapRecover = p > 0.76 ? 1 - smoothstep(0.76, 0.84, p) : slapStrike;
          this._tmpWorldB.copy(this._boltRackRoot);
          // Raised windup (+5.5cm) plunging swiftly downward (-3.8cm) across detent notch
          this._tmpWorldB.y += THREE.MathUtils.lerp(0.055, -0.038, slapStrike);
          this._tmpWorldB.x -= 0.018 * (1 - slapStrike);
          this._lDesiredRoot.copy(this._magWellRoot).lerp(this._tmpWorldB, reachT);
          leftGripCurl = THREE.MathUtils.lerp(0.82, 0.22, Math.max(reachT * 0.75, slapRecover));
          leftPadTap01 = slapRecover;
        } else {
          const t = smoothstep(0.86, 1.0, p);
          this._tmpWorldB.copy(this._lDesiredRoot);
          this._lDesiredRoot.copy(this._boltRackRoot).lerp(this._tmpWorldB, t);
          leftGripCurl = THREE.MathUtils.lerp(0.55, spec.leftHandSocket?.gripCurl ?? 0.85, t);
        }
      } else if (p < 0.16) {
        // REACH_MAG: handL reaches cleanly from handguard/grip to magazine well
        const t = smoothstep(0.0, 0.16, p);
        this._lDesiredRoot.lerp(this._magWellRoot, t);
        leftGripCurl = THREE.MathUtils.lerp(0.85, 0.94, t);
      } else if (p < 0.36) {
        // PULL_MAG: physically detaches magazine & lowers it toward chest rig pouch
        const t = smoothstep(0.16, 0.36, p);
        this._lDesiredRoot.copy(this._magWellRoot).lerp(this._magPouchRoot, t);
        leftGripCurl = 0.95;
      } else if (p < 0.48) {
        // SWAP_POUCH: brief swap at chest rig magazine pouch
        const t = smoothstep(0.36, 0.48, p);
        this._lDesiredRoot.copy(this._magPouchRoot);
        this._lDesiredRoot.y -= Math.sin(t * Math.PI) * 0.035;
        leftGripCurl = THREE.MathUtils.lerp(0.76, 0.95, t);
      } else if (p < 0.65) {
        // INSERT_MAG: raises fresh magazine up and seats it crisply into magwell
        // Pistols add an upward baseplate palm-tap impulse; AR adds subtle seat-and-tug verification
        const t = smoothstep(0.48, 0.61, p);
        this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._magWellRoot, t);
        if (isPistolReload && p >= 0.61) {
          const tap = Math.sin(((p - 0.61) / 0.04) * Math.PI);
          this._lDesiredRoot.y += tap * 0.016;
          leftGripCurl = THREE.MathUtils.lerp(0.95, 0.38, tap);
          leftPadTap01 = tap;
        } else if (arSlap && p >= 0.615) {
          const tug = Math.sin(((p - 0.615) / 0.035) * Math.PI);
          this._lDesiredRoot.y -= tug * 0.008;
          leftGripCurl = 0.95;
        } else {
          leftGripCurl = 0.95;
        }
      } else if (p < 0.86) {
        if (arSlap) {
          // AR-15/HK416 crisp open-palm slap on left-receiver bolt catch paddle
          const t = smoothstep(0.65, 0.72, p);
          const slapTap = p >= 0.70 && p <= 0.80 ? Math.sin(((p - 0.70) / 0.10) * Math.PI) : 0;
          this._tmpWorldB.copy(this._magWellRoot);
          this._tmpWorldB.y += 0.055;
          this._tmpWorldB.x -= 0.028 - slapTap * 0.020;
          this._lDesiredRoot.copy(this._magWellRoot).lerp(this._tmpWorldB, t);
          leftGripCurl = THREE.MathUtils.lerp(0.85, 0.28, slapTap);
          leftPadTap01 = slapTap;
        } else {
          // RACK_BOLT: visual support-hand contact on slide/charging handle before asymmetric rearward actuation
          const t = smoothstep(0.65, 0.71, p);
          let pullBack = 0;
          if (p >= 0.70 && p <= 0.86) {
            const r = (p - 0.70) / 0.16;
            pullBack =
              r < 0.50
                ? Math.pow(smoothstep(0.0, 0.50, r), 0.85) * 0.056
                : r < 0.62
                  ? 0.056
                  : (1 - Math.pow(smoothstep(0.62, 1.0, r), 1.35)) * 0.056;
          }
          this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.set(0, 0, pullBack).applyQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.applyQuaternion(this._rootWorldQuatInv);
          this._tmpWorldB.copy(this._boltRackRoot).add(this._inspectSlideWorld);
          this._lDesiredRoot.copy(this._magWellRoot).lerp(this._tmpWorldB, t);
          leftGripCurl = 0.90;
        }
      } else {
        // RETURN: crisp handL return back to forend/support grip
        const t = smoothstep(0.86, 1.0, p);
        this._tmpWorldB.copy(this._lDesiredRoot);
        const fromPt = arSlap ? this._magWellRoot : this._boltRackRoot;
        this._lDesiredRoot.copy(fromPt).lerp(this._tmpWorldB, t);
        leftGripCurl = THREE.MathUtils.lerp(0.85, spec.leftHandSocket?.gripCurl ?? 0.85, t);
      }
    } else if (weaponAction === 'CHAMBER_CYCLE' && isFirearm) {
      // Manual Chamber Cycling (`Y`) Left-Hand IK:
      //  - pump_shotgun: left hand remains welded 1:1 to moving pumpForend (no override needed)
      //  - bolt_action: right hand tracks boltHandleSocket via boltHandW while left hand supports forend
      //  - pistol_slide / ar_charging_handle / ak_side_bolt / mp5_cocking_tube / revolver_cylinder:
      //    left hand reaches physical slide/charging handle, pinches & pulls rearward with live travel, then returns cleanly.
      const style = anim.getChamberCycleStyle();
      if (style !== 'pump_shotgun' && style !== 'bolt_action') {
        leftOverridden = true;
        const p = anim.getActionProgress();
        this.weaponRig.boltRackAnchor.getWorldPosition(this._boltRackRoot);
        this.skeleton.root.worldToLocal(this._boltRackRoot);

        const travelZ = anim.getManualBoltPull01() * (weaponAsm?.slideTravelZ ?? 0.062);
        this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
        this._inspectSlideWorld
          .set(0, style === 'pistol_slide' ? 0.008 : 0, travelZ)
          .applyQuaternion(this._inspectWeaponQuat);
        this._inspectSlideWorld.applyQuaternion(this._rootWorldQuatInv);
        this._tmpWorldB.copy(this._boltRackRoot).add(this._inspectSlideWorld);

        if (p < 0.22) {
          const reachT = smoothstep(0.0, 0.22, p);
          this._lDesiredRoot.lerp(this._tmpWorldB, reachT);
          leftGripCurl = THREE.MathUtils.lerp(spec.leftHandSocket?.gripCurl ?? 0.85, 0.72, reachT);
          leftPinchPose01 = reachT * 0.65;
        } else if (p < 0.76) {
          this._lDesiredRoot.copy(this._tmpWorldB);
          const gripW = p < 0.60 ? 1.0 : 1 - smoothstep(0.60, 0.74, p);
          leftGripCurl = THREE.MathUtils.lerp(0.62, 0.90, gripW);
          leftPinchPose01 = style === 'ar_charging_handle' || style === 'pistol_slide' ? 0.85 * gripW : 0.45 * gripW;
        } else {
          const retT = smoothstep(0.76, 1.0, p);
          this._tmpWorldA.copy(this._lDesiredRoot);
          this._lDesiredRoot.copy(this._boltRackRoot).lerp(this._tmpWorldA, retT);
          leftGripCurl = THREE.MathUtils.lerp(0.68, spec.leftHandSocket?.gripCurl ?? 0.85, retT);
        }
      }
    } else if (anim.isTubularReloading() && isFirearm) {
      // Shell-by-shell tubular shotgun reload IK:
      //  - OPEN_BREECH / CLOSE_BREECH keep left hand welded 1:1 to pumpForend (no override!)
      //  - BREECH_LOAD reaches chest shell loop -> drops 1st shell directly into side ejection port
      //  - FEED_SHELL cycles chest shell loop -> underside loading port for each shell
      const ph = anim.getTubularReloadPhase();
      const tp = anim.getTubularPhaseProgress();
      if (ph !== 'OPEN_BREECH' && ph !== 'CLOSE_BREECH') {
        leftOverridden = true;
        this.skeleton.magPouchAnchor.getWorldPosition(this._magPouchRoot);
        this.skeleton.root.worldToLocal(this._magPouchRoot);
        this.weaponRig.magWellAnchor.getWorldPosition(this._magWellRoot);
        this.skeleton.root.worldToLocal(this._magWellRoot);
        this._tmpWorldA.copy(this._lDesiredRoot);

        if (ph === 'ENTER') {
          this._lDesiredRoot.copy(this._tmpWorldA).lerp(this._magPouchRoot, smoothstep(0, 1, tp));
          leftGripCurl = 0.80;
        } else if (ph === 'BREECH_LOAD') {
          if (this.weaponRig.getEjectionPortWorldPosition(this._breechRoot)) {
            this.skeleton.root.worldToLocal(this._breechRoot);
          } else {
            this._breechRoot.copy(this._magWellRoot);
          }
          if (tp < 0.24) {
            this._lDesiredRoot.copy(this._tmpWorldA).lerp(this._magPouchRoot, smoothstep(0, 0.24, tp));
            leftGripCurl = 0.85;
          } else if (tp < 0.78) {
            this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._breechRoot, smoothstep(0.24, 0.74, tp));
            leftPinchPose01 = 0.85;
          } else {
            this._lDesiredRoot.copy(this._breechRoot).lerp(this._tmpWorldA, smoothstep(0.78, 1, tp));
            leftGripCurl = 0.85;
          }
        } else if (ph === 'FEED_SHELL') {
          if (tp < 0.22) {
            this._lDesiredRoot.copy(this._magWellRoot).lerp(this._magPouchRoot, smoothstep(0, 0.22, tp));
            leftGripCurl = 0.82;
          } else if (tp < 0.76) {
            this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._magWellRoot, smoothstep(0.22, 0.72, tp));
            leftPinchPose01 = 0.72;
          } else {
            // Thumb push up into magazine tube gate
            const push = Math.sin(smoothstep(0.76, 1, tp) * Math.PI);
            this._lDesiredRoot.copy(this._magWellRoot);
            this._lDesiredRoot.y += push * 0.018;
            leftPinchPose01 = 0.55;
          }
        } else {
          // EXIT
          this._lDesiredRoot.copy(this._magWellRoot).lerp(this._tmpWorldA, smoothstep(0, 1, tp));
          leftGripCurl = THREE.MathUtils.lerp(0.84, spec.leftHandSocket?.gripCurl ?? 0.85, tp);
        }
      }
    } else if (weaponAction === 'MAG_CHECK' && isFirearm) {
      // Physical magazine check: reach magwell, extract ~3.2cm, inspect witness holes, push back & return
      leftOverridden = true;
      const p = anim.getActionProgress();
      this.weaponRig.magWellAnchor.getWorldPosition(this._magWellRoot);
      this.skeleton.root.worldToLocal(this._magWellRoot);

      const pullAmt = smoothstep(0.15, 0.34, p) * (1 - smoothstep(0.64, 0.79, p)) * 0.036;
      this._tmpWorldB.copy(this._magWellRoot);
      this._tmpWorldB.y -= pullAmt;

      if (p < 0.16) {
        const t = smoothstep(0.0, 0.16, p);
        this._lDesiredRoot.lerp(this._tmpWorldB, t);
      } else if (p < 0.84) {
        this._lDesiredRoot.copy(this._tmpWorldB);
      } else {
        const t = smoothstep(0.84, 1.0, p);
        this._tmpWorldA.copy(this._lDesiredRoot);
        this._lDesiredRoot.copy(this._tmpWorldB).lerp(this._tmpWorldA, t);
      }
      leftGripCurl = 0.92;
    } else if (
      (weaponAction === 'SUPPRESSOR_DETACH' || weaponAction === 'SUPPRESSOR_ATTACH') &&
      isFirearm
    ) {
      // Realistic 2.45s 3-stroke ratcheted suppressor detach/reattach IK sequence
      leftOverridden = true;
      const isAttach = weaponAction === 'SUPPRESSOR_ATTACH';
      const p = anim.getActionProgress();
      const wristRoll = anim.getSuppressorWristRollRad();
      const gripRelease = anim.getSuppressorGripRelease01();

      this.skeleton.magPouchAnchor.getWorldPosition(this._magPouchRoot);
      this.skeleton.root.worldToLocal(this._magPouchRoot);

      if (this.weaponRig.getSuppressorMountWorldPosition(this._suppressorMountRoot)) {
        this.skeleton.root.worldToLocal(this._suppressorMountRoot);
      } else {
        this._suppressorMountRoot.copy(this._lDesiredRoot);
      }

      // Clamp suppressor target cleanly within left arm physical reach
      this._tmpWorldA.subVectors(this._suppressorMountRoot, this._shoulderL);
      const maxReachL = (armL.upperLen + armL.lowerLen) * 0.94;
      const suppDist = this._tmpWorldA.length();
      if (suppDist > maxReachL && suppDist > 1e-5) {
        this._suppressorMountRoot
          .copy(this._shoulderL)
          .addScaledVector(this._tmpWorldA, maxReachL / suppDist);
      }

      // Forend return target saved before mutating _lDesiredRoot
      this._tmpWorldA.copy(this._lDesiredRoot);

      if (!isAttach) {
        // DETACH: 0.00-0.10 TILT -> 0.10-0.21 REACH -> 0.21-0.61 3x RATCHET TWIST -> 0.61-0.67 CLEAR_PULL -> 0.67-0.86 STOW -> 0.86-1.00 RETURN
        if (p < 0.10) {
          this._lDesiredRoot.copy(this._tmpWorldA);
          leftGripCurl = 0.85;
        } else if (p < 0.21) {
          const t = smoothstep(0.10, 0.21, p);
          this._lDesiredRoot.copy(this._tmpWorldA).lerp(this._suppressorMountRoot, t);
          leftSuppressorGrip = t > 0.6;
          leftGripRelease01 = (1 - t) * 0.45;
          leftGripCurl = THREE.MathUtils.lerp(0.85, 0.94, t);
        } else if (p < 0.67) {
          this._lDesiredRoot.copy(this._suppressorMountRoot);
          this._suppressorTwistEuler.set(0.08, -0.14, wristRoll, 'YXZ');
          this._suppressorTwistQuat.setFromEuler(this._suppressorTwistEuler);
          this._lDesiredQuatRoot.multiply(this._suppressorTwistQuat);
          leftSuppressorGrip = true;
          leftGripRelease01 = gripRelease;
          leftGripCurl = 0.95;
        } else if (p < 0.86) {
          const t = smoothstep(0.67, 0.83, p);
          this._lDesiredRoot.copy(this._suppressorMountRoot).lerp(this._magPouchRoot, t);
          leftSuppressorGrip = p < 0.83;
          leftGripRelease01 = p >= 0.83 ? 0.55 : 0;
          leftGripCurl = p < 0.83 ? 0.94 : 0.72;
        } else {
          const t = smoothstep(0.86, 1.0, p);
          this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._tmpWorldA, t);
          leftGripCurl = THREE.MathUtils.lerp(0.72, spec.leftHandSocket?.gripCurl ?? 0.85, t);
        }
      } else {
        // ATTACH: 0.00-0.10 TILT -> 0.10-0.28 POUCH -> 0.28-0.40 REACH_MUZZLE -> 0.40-0.44 SEAT -> 0.44-0.84 3x RATCHET TWIST -> 0.84-1.00 RETURN
        if (p < 0.10) {
          this._lDesiredRoot.copy(this._tmpWorldA);
          leftGripCurl = 0.85;
        } else if (p < 0.28) {
          const t = smoothstep(0.10, 0.22, p);
          this._lDesiredRoot.copy(this._tmpWorldA).lerp(this._magPouchRoot, t);
          leftSuppressorGrip = p >= 0.20;
          leftGripRelease01 = p < 0.20 ? 0.5 : 0;
          leftGripCurl = p < 0.20 ? 0.72 : 0.95;
        } else if (p < 0.40) {
          const t = smoothstep(0.28, 0.40, p);
          this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._suppressorMountRoot, t);
          leftSuppressorGrip = true;
          leftGripCurl = 0.95;
        } else if (p < 0.84) {
          this._lDesiredRoot.copy(this._suppressorMountRoot);
          this._suppressorTwistEuler.set(0.08, -0.14, wristRoll, 'YXZ');
          this._suppressorTwistQuat.setFromEuler(this._suppressorTwistEuler);
          this._lDesiredQuatRoot.multiply(this._suppressorTwistQuat);
          leftSuppressorGrip = true;
          leftGripRelease01 = gripRelease;
          leftGripCurl = 0.95;
        } else {
          const t = smoothstep(0.84, 1.0, p);
          this._lDesiredRoot.copy(this._suppressorMountRoot).lerp(this._tmpWorldA, t);
          leftGripCurl = THREE.MathUtils.lerp(0.90, spec.leftHandSocket?.gripCurl ?? 0.85, t);
        }
      }
    } else if (this.combatMove === 'ARMED_BASH' && spec.holdClass === 'pistol') {
      // Support left hand clears to protective chest guard during right-hand pistol whip
      leftOverridden = true;
      this._lDesiredRoot.set(-0.16, eyeH - 0.16, -0.18);
      this._tmpEuler.set(0.18, -0.28, 0.36, 'YXZ');
      this._lDesiredQuatRoot.setFromEuler(this._tmpEuler);
      leftGripCurl = 0.88;
    } else if (isFirearm && this.weaponRig.isZoomTwistActive()) {
      // 0.28s interruptible LPVO/scope magnification throw-lever pinch & sweep (works in ADS + ready stance!)
      const zoomW = this.weaponRig.getZoomRingIkOverride(
        this._zoomRingPosWorld,
        this._zoomRingQuatWorld,
      );
      if (zoomW > 0.001) {
        leftOverridden = true;
        this._zoomRingPosRoot.copy(this._zoomRingPosWorld);
        this.skeleton.root.worldToLocal(this._zoomRingPosRoot);
        this._zoomRingQuatRoot.copy(this._zoomRingQuatWorld).premultiply(this._rootWorldQuatInv);
        this._lDesiredRoot.lerp(this._zoomRingPosRoot, zoomW);
        this._lDesiredQuatRoot.slerp(this._zoomRingQuatRoot, zoomW * 0.72);
        leftPinchPose01 = zoomW;
        leftGripCurl = THREE.MathUtils.lerp(leftGripCurl, 0.78, zoomW);
      }
    } else if (isFirearm && anim.getActiveMicroAction() !== 'NONE') {
      // Non-blocking combat-interruptible firearm handling micro-actions (turret, illum, support-hand selector, light/laser pad)
      const mAct = anim.getActiveMicroAction();
      const mw = anim.getMicroActionWeight();
      if (mw > 0.001) {
        let gotTarget = false;
        if (mAct === 'TURRET') {
          gotTarget = this.weaponRig.getElevationTurretWorldTransform(
            this._microPosWorld,
            this._microQuatWorld,
          );
          if (gotTarget) leftPinchPose01 = mw;
        } else if (mAct === 'ILLUM') {
          gotTarget = this.weaponRig.getIllumDialWorldTransform(
            this._microPosWorld,
            this._microQuatWorld,
          );
          if (gotTarget) leftPinchPose01 = mw;
        } else if (mAct === 'SELECTOR' && weaponAsm?.selectorSide === 'support_hand') {
          gotTarget = this.weaponRig.getSelectorWorldTransform(
            this._microPosWorld,
            this._microQuatWorld,
          );
          if (gotTarget) leftPinchPose01 = mw * 0.72;
        } else if (mAct === 'LIGHT_PAD') {
          gotTarget = this.weaponRig.getPressurePadWorldTransform(
            this._microPosWorld,
            this._microQuatWorld,
          );
          if (gotTarget) leftPadTap01 = mw;
        }

        if (gotTarget) {
          leftOverridden = true;
          this._microPosRoot.copy(this._microPosWorld);
          this.skeleton.root.worldToLocal(this._microPosRoot);
          this._microQuatRoot.copy(this._microQuatWorld).premultiply(this._rootWorldQuatInv);
          const posBlend = mAct === 'LIGHT_PAD' ? mw * 0.55 : mw;
          this._lDesiredRoot.lerp(this._microPosRoot, posBlend);
          if (mAct !== 'LIGHT_PAD') {
            this._lDesiredQuatRoot.slerp(this._microQuatRoot, mw * 0.62);
          }
        }
      }
    }

    if (pdaActiveHold) {
      leftOverridden = true;
      this.pdaDevice!.getLeftGripWorldTransform(this._pdaLPosRoot, this._pdaLQuatRoot);
      this.skeleton.root.worldToLocal(this._pdaLPosRoot);
      this._pdaLQuatRoot.premultiply(this._rootWorldQuatInv);
      this._lDesiredRoot.lerp(this._pdaLPosRoot, pdaIkW);
      if (isUnarmed) {
        this._lDesiredQuatRoot.copy(this._pdaLQuatRoot);
      } else {
        this._lDesiredQuatRoot.slerp(this._pdaLQuatRoot, pdaIkW);
      }
      leftGripCurl = THREE.MathUtils.lerp(leftGripCurl, 0.45, pdaIkW);
    } else if (grenadeActiveHold && this.grenadeSystem) {
      leftOverridden = true;
      const gs = this.grenadeSystem;
      const gStage = gs.getHoldStage();
      const gPhase = gs.getPinPullPhase();
      const gElapsed = gs.getPinPullElapsed();
      const gStyle = gs.getThrowStyle();
      const isLobbing = gStyle === 'underhand' && (gs.isThrowInputHeld() || gs.getThrowWhipProgress() > 0);
      const heldMesh = gs.getHeldGrenadeMesh();

      // Pre-compute live chest-balance & eye-level aim anchors in skeleton.root local space
      this.skeleton.leftChestBalanceAnchor.getWorldPosition(this._grenadeLPos);
      this.skeleton.root.worldToLocal(this._grenadeLPos);
      this.skeleton.leftEyeAimAnchor.getWorldPosition(this._grenadePocketPos);
      this.skeleton.root.worldToLocal(this._grenadePocketPos);

      // Pitch left eye-aim anchor smoothly with view pitch while staying below eye line, left-of-center
      this._grenadeHandEuler.set(guardPitch * 0.55, 0, 0, 'YXZ');
      this._grenadePocketPos.sub(this._camLocalOrigin).applyEuler(this._grenadeHandEuler).add(this._camLocalOrigin);

      if (gStage === 'DRAWN') {
        // Ready support blade by chest balance anchor
        leftPinchPose01 = 0;
        leftGripCurl = 0.28;
      } else if (gPhase === 'REACH_PIN' && heldMesh) {
        const t = smoothstep(0.0, 0.16, gElapsed);
        heldMesh.pinAnchor.getWorldPosition(this._grenadePinPos);
        this.skeleton.root.worldToLocal(this._grenadePinPos);
        this._grenadeLPos.lerp(this._grenadePinPos, t);
        leftPinchPose01 = smoothstep(0.06, 0.16, gElapsed);
        leftGripCurl = 0.80;
      } else if (gPhase === 'PULL_PIN' && heldMesh) {
        const t = smoothstep(0.16, 0.34, gElapsed);
        heldMesh.pinAnchor.getWorldPosition(this._grenadePinPos);
        this.skeleton.root.worldToLocal(this._grenadePinPos);
        heldMesh.bodyGroup.getWorldQuaternion(this._grenadeBodyWorldQuat);
        this._grenadePullAxisWorld
          .copy(heldMesh.pinPullAxis)
          .applyQuaternion(this._grenadeBodyWorldQuat)
          .applyQuaternion(this._rootWorldQuatInv)
          .normalize();
        this._grenadeLPos.copy(this._grenadePinPos).addScaledVector(this._grenadePullAxisWorld, 0.135 * t);
        leftPinchPose01 = 1.0;
        leftGripCurl = 0.88;
      } else if (gPhase === 'TUCK_POCKET' && heldMesh) {
        const t = smoothstep(0.34, 0.56, gElapsed);
        heldMesh.pinAnchor.getWorldPosition(this._grenadePinPos);
        this.skeleton.root.worldToLocal(this._grenadePinPos);
        heldMesh.bodyGroup.getWorldQuaternion(this._grenadeBodyWorldQuat);
        this._grenadePullAxisWorld
          .copy(heldMesh.pinPullAxis)
          .applyQuaternion(this._grenadeBodyWorldQuat)
          .applyQuaternion(this._rootWorldQuatInv)
          .normalize();
        this._grenadePinPos.addScaledVector(this._grenadePullAxisWorld, 0.135);
        this.skeleton.leftPocketAnchor.getWorldPosition(this._grenadeLPos);
        this.skeleton.root.worldToLocal(this._grenadeLPos);
        this._grenadeLPos.lerpVectors(this._grenadePinPos, this._grenadeLPos, t);
        leftPinchPose01 = 1.0 - smoothstep(0.46, 0.56, gElapsed);
        leftGripCurl = THREE.MathUtils.lerp(0.88, 0.32, t);
      } else if (!isLobbing) {
        // EYE_AIM / Overhand charge: extend left hand just below eye level, slightly left-of-center
        this._grenadeLPos.copy(this._grenadePocketPos);
        leftPinchPose01 = 0;
        leftGripCurl = 0.18;
      } else {
        // Underhand click-lob: drop left hand smoothly to lower-chest balance
        leftPinchPose01 = 0;
        leftGripCurl = 0.24;
      }

      // Clean open tactical blade wrist orientation for left hand
      this._grenadeHandEuler.set(guardPitch * 0.4, -0.35, 0.42, 'YXZ');
      this._grenadeLQuat.setFromEuler(this._grenadeHandEuler);

      this._lDesiredRoot.lerp(this._grenadeLPos, grenadeIkW);
      if (isUnarmed) {
        this._lDesiredQuatRoot.copy(this._grenadeLQuat);
      } else {
        this._lDesiredQuatRoot.slerp(this._grenadeLQuat, grenadeIkW);
      }
    }

    const extLeftW = extIk ? THREE.MathUtils.clamp(extIk.leftWeight, 0, 1) : 0;
    if (extIk && extLeftW > 0.001) {
      leftOverridden = true;
      this._extLPosRoot.copy(extIk.leftWorldPos);
      this.skeleton.root.worldToLocal(this._extLPosRoot);
      this._extLQuatRoot.copy(extIk.leftWorldQuat).premultiply(this._rootWorldQuatInv);
      this._lDesiredRoot.lerp(this._extLPosRoot, extLeftW);
      if (isUnarmed) {
        this._lDesiredQuatRoot.copy(this._extLQuatRoot);
      } else {
        this._lDesiredQuatRoot.slerp(this._extLQuatRoot, extLeftW);
      }
      leftGripCurl = THREE.MathUtils.lerp(leftGripCurl, extIk.leftGripCurl, extLeftW);
    }

    if (this.wasLeftOverridden && !leftOverridden) {
      this.leftActionReturnTimer = 0.14;
    }
    this.wasLeftOverridden = leftOverridden;
    if (this.leftActionReturnTimer > 0) {
      this.leftActionReturnTimer = Math.max(0, this.leftActionReturnTimer - dt);
    }

    const usePdaLeftQuat = pdaActiveHold && pdaIkW > 0.35;
    const useGrenadeLeftQuat = grenadeActiveHold && grenadeIkW > 0.25;
    const useExtLeftQuat = extLeftW > 0.05;
    const pdaLockedLeft =
      pdaActiveHold &&
      pdaIkW >= 0.98 &&
      this.equipBlendTimer <= 0 &&
      vaultPinL < 0.001 &&
      !useExtLeftQuat &&
      this.leftActionReturnTimer <= 0;
    if (
      !pdaLockedLeft &&
      (leftOverridden || this.equipBlendTimer > 0 || this.leftActionReturnTimer > 0)
    ) {
      this.leftHandBlender.blendTo(
        this._lDesiredRoot,
        isUnarmed && !usePdaLeftQuat && !useGrenadeLeftQuat && !useExtLeftQuat
          ? this.leftHandBlender.quaternion
          : this._lDesiredQuatRoot,
        leftGripCurl,
        1,
        vaultPinL > 0.001
          ? 38
          : useExtLeftQuat
            ? 42
            : grenadeActiveHold || pdaActiveHold
              ? 36
              : leftOverridden
                ? 30
                : 34,
        dt,
      );
    } else {
      this.leftHandBlender.snap(
        this._lDesiredRoot,
        isUnarmed && !usePdaLeftQuat ? this.leftHandBlender.quaternion : this._lDesiredQuatRoot,
        leftGripCurl,
        1,
      );
    }

    this._lTargetRoot.copy(this.leftHandBlender.position);
    this._lQuatRoot.copy(this.leftHandBlender.quaternion);

    // 3b. Pre-IK Scapular Reach Assist (Zero Sight-Line Shift):
    //     During ADS/Canted/Point-Aim on long primary rifles pitched upward, the sight-locked
    //     handguard socket rises above the static torso pivot. Glide the support clavicle smoothly
    //     along the shoulder->socket vector (bounded to anatomical scapular travel) so the left palm
    //     stays 0.0 mm locked to the handguard with a natural elbow micro-bend and zero sight drift.
    if (
      !isUnarmed &&
      !leftOverridden &&
      this.weaponRig.hasLeftHandSocket &&
      vaultPinL < 0.05 &&
      !pdaActiveHold &&
      !grenadeActiveHold
    ) {
      this._scapulaDeltaRoot.subVectors(this._lTargetRoot, this._shoulderL);
      const leftDist = this._scapulaDeltaRoot.length();
      const comfortableReachL = (armL.upperLen + armL.lowerLen) * 0.965;
      if (leftDist > comfortableReachL && leftDist > 1e-5) {
        const glideDist = Math.min(leftDist - comfortableReachL, 0.15);
        this._scapulaDeltaRoot.multiplyScalar(glideDist / leftDist);
        // Shift left clavicle in chest local space so deltoid/bicep/shoulderPivot move as one unit
        this._scapulaStartWorld.copy(this._shoulderL);
        this._scapulaTargetWorld.copy(this._shoulderL).add(this._scapulaDeltaRoot);
        this.skeleton.root.localToWorld(this._scapulaStartWorld);
        this.skeleton.root.localToWorld(this._scapulaTargetWorld);
        this.skeleton.chest.worldToLocal(this._scapulaStartWorld);
        this.skeleton.chest.worldToLocal(this._scapulaTargetWorld);
        armL.clavicle.position.add(this._scapulaTargetWorld.sub(this._scapulaStartWorld));
        armL.clavicle.updateMatrixWorld(true);
        armL.shoulderPivot.getWorldPosition(this._shoulderL);
        this.skeleton.root.worldToLocal(this._shoulderL);
        // Keep left elbow pole co-moving with the glided shoulder
        this._poleL.add(this._scapulaDeltaRoot);
      }
    }

    // 4. Solve Left Arm 2-Bone IK + Forearm-Aligned Zero-Hyperextension Wrist Orientation
    solveTwoBoneIK(this._shoulderL, this._lTargetRoot, this._poleL, armL.upperLen, armL.lowerLen, this.leftArmIK);
    orientLimbAlongYInRootSpace(armL.upperArm, this.skeleton.root, this._shoulderL, this.leftArmIK.midPos, this._poleL);
    if (isUnarmed && !usePdaLeftQuat && !useGrenadeLeftQuat && !useExtLeftQuat) {
      this.computeUnarmedForearmAlignedHandQuat(-1, this.leftArmIK.dir2, leftPronation, this._handAlignedQuat);
      if (vaultPinL > 0.001) {
        this._handAlignedQuat.slerp(this._vaultHandQuatRoot, vaultPinL);
      }
      if (this.equipBlendTimer > 0 || this.leftActionReturnTimer > 0) {
        const alpha = 1 - Math.exp(-34 * dt);
        this.leftHandBlender.quaternion.slerp(this._handAlignedQuat, alpha);
      } else {
        this.leftHandBlender.quaternion.copy(this._handAlignedQuat);
      }
      this._lQuatRoot.copy(this.leftHandBlender.quaternion);
    }
    this.orientForearmToHand(
      armL.forearm,
      this.leftArmIK.midPos,
      this.leftArmIK.endPos,
      this._lQuatRoot,
      this._dorsalL,
    );
    setTransformInRootSpace(armL.hand.root, this.skeleton.root, this.leftArmIK.endPos, this._lQuatRoot);
    this.skeleton.root.updateMatrixWorld(true);
    armL.hand.root.updateWorldMatrix(true, false);

    // Sync physical detachable magazine, field suppressor (world-space continuity!), and shotgun reload shell into/out of left hand
    anim.syncPhysicalMagazineParent(armL.hand.root);
    anim.syncPhysicalSuppressorParent(armL.hand.root, dt);
    anim.syncPhysicalShellParent(armL.hand.root);

    const leftHoldClass =
      grenadeActiveHold && grenadeIkW > 0.45
        ? 'throwable'
        : vaultPinL > 0.2 || isUnarmed
          ? 'unarmed'
          : leftOverridden && !leftSuppressorGrip && leftPinchPose01 < 0.05 && leftPadTap01 < 0.05
            ? 'melee_1h'
            : spec.holdClass;
    const foregripPose =
      (leftOverridden && leftPadTap01 < 0.05) || vaultPinL > 0.2 || isUnarmed
        ? 'none'
        : (weaponAsm?.foregripPose ?? 'none');
    if (pdaActiveHold && pdaIkW > 0.55) {
      // Post-IK reach guard: if extreme torso pitch/lean clamps either arm's max reach, pull the
      // PDA chassis by the averaged solved-hand residual so palms stay welded onto both bolsters.
      if (pdaIkW >= 0.95) {
        armR.hand.root.getWorldPosition(this._pdaSolvedRWorld);
        armL.hand.root.getWorldPosition(this._pdaSolvedLWorld);
        this.pdaDevice!.getRightGripWorldTransform(this._pdaTargetRWorld, this._pdaTmpQuat);
        this.pdaDevice!.getLeftGripWorldTransform(this._pdaTargetLWorld, this._pdaTmpQuat);
        this._pdaReachDeltaWorld
          .subVectors(this._pdaSolvedRWorld, this._pdaTargetRWorld)
          .add(this._pdaSolvedLWorld)
          .sub(this._pdaTargetLWorld)
          .multiplyScalar(0.5);
        if (this._pdaReachDeltaWorld.lengthSq() > 2.5e-7) {
          this.pdaDevice!.applyPostIkWorldOffset(this._pdaReachDeltaWorld);
        }
      }

      // Pose both left and right hands & drive the 3D joystick gimbal from the final locked PDA matrix
      this.skeleton.applyPdaHandPose('left', 0, 0, 0);
      const intent = this.pdaDevice!.getThumbIntent();
      this.pdaDevice!.getRightThumbWorldTarget(this._tmpWorldB);
      this.skeleton.applyPdaHandPose(
        'right',
        this.pdaDevice!.getPowerPressWeight(),
        intent.x,
        intent.y,
        this._tmpWorldB,
      );
      this.skeleton.root.updateMatrixWorld(true);
      this.skeleton.getRightThumbTipWorldPosition(this._tmpWorldA);
      this.pdaDevice!.driveJoystickFromThumbWorldPos(this._tmpWorldA, dt, pdaIkW);
    } else {
      this._leftHandPoseOpts.profile = weaponAsm?.handPoseProfile ?? null;
      this._leftHandPoseOpts.triggerPull01 = 0;
      this._leftHandPoseOpts.thumbFlick01 = 0;
      this._leftHandPoseOpts.pinchPose01 = leftPinchPose01;
      this._leftHandPoseOpts.gripRelease01 = leftGripRelease01;
      this._leftHandPoseOpts.suppressorGrip = leftSuppressorGrip;
      this._leftHandPoseOpts.padTap01 = leftPadTap01;
      this._leftHandPoseOpts.leverReleased = false;
      this.skeleton.applyHandPose(
        'left',
        leftHoldClass,
        false,
        this.leftHandBlender.gripCurl,
        foregripPose,
        this._leftHandPoseOpts,
      );
    }
  }

  /**
   * Aligns an unarmed hand strictly straight along its solved forearm direction (zero backward wrist hyperextension):
   *  - hand local -Z (front knuckles) === forearmDir
   *  - pronationRad = 0 -> vertical fist (palm inward toward chest, thumb up-inward)
   *  - pronationRad ~ 0.62 -> natural ~35° inward boxing guard (palms/thumbs inward toward chest, knuckles forward)
   *  - pronationRad ~ 1.54 -> full palm-down pronation at punch impact
   */
  private computeUnarmedForearmAlignedHandQuat(
    side: -1 | 1,
    forearmDir: Readonly<THREE.Vector3>,
    pronationRad: number,
    outQuat: THREE.Quaternion,
  ): void {
    this._handAlignZ.copy(forearmDir).negate();
    if (this._handAlignZ.lengthSq() < 1e-6) {
      this._handAlignZ.set(0, 0, 1);
    } else {
      this._handAlignZ.normalize();
    }

    // Outward lateral reference orthogonalized against forearm axis
    this._handAlignOut.set(side, 0, 0);
    this._handAlignOut.addScaledVector(
      forearmDir as THREE.Vector3,
      -this._handAlignOut.dot(forearmDir as THREE.Vector3),
    );
    if (this._handAlignOut.lengthSq() < 1e-4) {
      this._handAlignOut.set(0, 0, 1);
      this._handAlignOut.addScaledVector(
        forearmDir as THREE.Vector3,
        -this._handAlignOut.dot(forearmDir as THREE.Vector3),
      );
    }
    this._handAlignOut.normalize();

    // Up-back orthogonal axis perpendicular to both forearmDir and outward axis
    this._handAlignUp
      .crossVectors(forearmDir as THREE.Vector3, this._handAlignOut)
      .multiplyScalar(-side)
      .normalize();

    // Dorsal (+Y) rotates smoothly from outward (0 rad, vertical fist) to up-back (PI/2 rad, palm-down pronated)
    const c = Math.cos(pronationRad);
    const s = Math.sin(pronationRad);
    this._handAlignY
      .copy(this._handAlignOut)
      .multiplyScalar(c)
      .addScaledVector(this._handAlignUp, s)
      .normalize();

    this._handAlignX.crossVectors(this._handAlignY, this._handAlignZ).normalize();
    this._handAlignY.crossVectors(this._handAlignZ, this._handAlignX).normalize();

    this._handAlignMat.makeBasis(this._handAlignX, this._handAlignY, this._handAlignZ);
    outQuat.setFromRotationMatrix(this._handAlignMat);
  }

  private orientForearmToHand(
    forearm: THREE.Object3D,
    elbowPos: THREE.Vector3,
    wristPos: THREE.Vector3,
    handQuat: THREE.Quaternion,
    prevDorsal: THREE.Vector3,
  ): void {
    this._forearmAxis.subVectors(wristPos, elbowPos);
    const len = this._forearmAxis.length();
    if (len < 1e-5) return;
    this._forearmAxis.divideScalar(len);

    this._forearmDorsalProj.set(0, 1, 0).applyQuaternion(handQuat);
    this._forearmDorsalProj.addScaledVector(
      this._forearmAxis,
      -this._forearmDorsalProj.dot(this._forearmAxis),
    );

    if (this._forearmDorsalProj.lengthSq() < 1e-3) {
      this._forearmDorsalProj
        .copy(prevDorsal)
        .addScaledVector(this._forearmAxis, -prevDorsal.dot(this._forearmAxis));
      if (this._forearmDorsalProj.lengthSq() < 1e-5) {
        this._forearmDorsalProj.set(
          Math.abs(this._forearmAxis.y) < 0.9 ? 0 : 1,
          Math.abs(this._forearmAxis.y) < 0.9 ? 1 : 0,
          0,
        );
        this._forearmDorsalProj.addScaledVector(
          this._forearmAxis,
          -this._forearmDorsalProj.dot(this._forearmAxis),
        );
      }
    }

    this._forearmDorsalProj.normalize();
    prevDorsal.copy(this._forearmDorsalProj);
    this._forearmPoleTmp.copy(elbowPos).add(this._forearmDorsalProj);
    orientLimbAlongYInRootSpace(forearm, this.skeleton.root, elbowPos, wristPos, this._forearmPoleTmp, 0);
  }
}

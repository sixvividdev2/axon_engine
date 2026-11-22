import * as THREE from 'three';
import { IBodycamAudioSource } from '../../bodycam-sdk/IBodycamAudioSource';
import {
  BodycamMeleeAttackType,
  BodycamMeleeHitEvent,
  BodycamMeleeHitZone,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  createMeleeHitEvent,
  createRaycastResult,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { TraumaModifiers } from '../../data/traumaConfig';
import { HoldClass, WeaponId, WeaponSpec } from '../../data/weapons';
import { WeaponRig } from '../weapons/WeaponRig';
import { CharacterSkeleton } from './CharacterSkeleton';
import { CharacterDriverState } from './ControllerStateReader';
import {
  createTwoBoneIKResult,
  IKTargetBlender,
  orientLimbAlongY,
  solveTwoBoneIK,
} from './IKSolver';

export type CharacterActionType =
  | 'NONE'
  | 'RELOAD'
  | 'MAG_CHECK'
  | 'MELEE_SWING'
  | 'THROW_PREP'
  | 'THROW_RELEASE';

export type SurvivalCombatMove = 'NONE' | 'LEFT_JAB' | 'RIGHT_CROSS' | 'ARMED_BASH' | 'PUSH_KICK';
export type SurvivalKickTriggerResult = 'ok' | 'busy' | 'airborne' | 'dual_leg_trauma';

export interface CharacterActionCallbacks {
  onMeleeImpact?: (spec: WeaponSpec) => void;
  onPinPulled?: (spec: WeaponSpec) => void;
  onThrowRelease?: (spec: WeaponSpec, handWorldPos: THREE.Vector3, remainingFuseSec: number) => void;
  onOvercookedDetonate?: (spec: WeaponSpec, handWorldPos: THREE.Vector3) => void;
  onCombatShock?: (pitchRad: number, yawRad: number, kickBackM: number) => void;
  onCombatExertion?: (amount: number) => void;
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
 * Pure TypeScript layered procedural animation controller driving Survival Mode with
 * 1:1 biomechanical parity to the portable Bodycam SDK:
 *  - Per-foot stair elevation smoothing, airborne jump tuck & real-life landing knee bend
 *  - Orthodox chin/rib boxing guard, alternating Jab -> Cross kinetic chain, and 0.32s armed V quick-bash
 *  - Grounded Tactical Push-Kick (X) via right-leg 2-bone IK (usable unarmed or armed)
 *  - Visceral 28–32ms limb hitstop, additive chest-cam twist/lean-back overlay & zero-GC spherecast dispatch
 *  - World-locked vault hand pinning, post-IK rigid weapon lock, knife/crowbar swings & throwables
 */
export class CharacterAnimator {
  private readonly skeleton: CharacterSkeleton;
  private readonly weaponRig: WeaponRig;
  private audio?: IBodycamAudioSource;

  // Smooth IK target blenders for brief weapon switches, vault hand release & left-hand action curves
  private readonly rightHandBlender = new IKTargetBlender();
  private readonly leftHandBlender = new IKTargetBlender();
  private prevWeaponId: WeaponId | null = null;
  private equipBlendTimer = 0;
  private leftActionReturnTimer = 0;
  private wasLeftOverridden = false;

  // Gait tracking derived purely from read-only controller state
  private prevPos = new THREE.Vector3();
  private hasPrevPos = false;
  private smoothedLocalVelX = 0;
  private smoothedLocalVelZ = 0;
  private prevStridePhase = 0;
  private stepSign = 1;
  private moveWeight = 0;
  private crouchBlend = 0;

  // Per-foot smoothed world elevation & slope pitch for smooth stairs/curbs/ramps
  private footWorldYL = 0;
  private footWorldYR = 0;
  private footWorldInit = false;
  private lastControllerY = 0;
  private footPitchL = 0;
  private footPitchR = 0;

  // Active additive action state (reload / mag check / knife-crowbar swing / throwable)
  private actionType: CharacterActionType = 'NONE';
  private actionTime = 0;
  private actionDuration = 0;
  private actionSpec: WeaponSpec | null = null;
  private meleeImpactFired = false;
  private pinPullFired = false;
  private throwReleaseFired = false;
  private cookElapsed = 0;
  private callbacks: CharacterActionCallbacks = {};

  // Unarmed Jab -> Cross, Armed V Quick-Bash, and Tactical Push-Kick (X) state (zero-GC)
  private combatMove: SurvivalCombatMove = 'NONE';
  private combatTime = 0;
  private combatDuration = 0.38;
  private armedBashKind: 'pistol' | 'rifle' = 'rifle';
  private lastHoldClass: HoldClass = 'unarmed';
  private combatHitEvaluated = false;
  private kickPlantSoundFired = false;
  private kickRightLegImpairment = 0;
  private comboWindowTimer = 0;
  private hitstopTimer = 0;
  private unarmedGuardHeld = false;
  private unarmedGuardBlend = 0;
  private punchFromGuard = false;

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

  // Reusable zero-GC math temporaries
  private readonly leftArmIK = createTwoBoneIKResult();
  private readonly rightArmIK = createTwoBoneIKResult();
  private readonly leftLegIK = createTwoBoneIKResult();
  private readonly rightLegIK = createTwoBoneIKResult();

  private readonly _actionPosOffset = new THREE.Vector3();
  private readonly _actionRotOffset = new THREE.Euler(0, 0, 0, 'YXZ');

  private readonly _rTargetRoot = new THREE.Vector3();
  private readonly _lTargetRoot = new THREE.Vector3();
  private readonly _rDesiredRoot = new THREE.Vector3();
  private readonly _lDesiredRoot = new THREE.Vector3();
  private readonly _rQuatRoot = new THREE.Quaternion();
  private readonly _lQuatRoot = new THREE.Quaternion();
  private readonly _rDesiredQuatRoot = new THREE.Quaternion();
  private readonly _lDesiredQuatRoot = new THREE.Quaternion();
  private readonly _rootWorldQuatInv = new THREE.Quaternion();
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _aimPoleEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _pivotAimEuler = new THREE.Euler(0, 0, 0, 'YXZ');

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
  private readonly _poleR = new THREE.Vector3();
  private readonly _poleL = new THREE.Vector3();
  private readonly _dorsalR = new THREE.Vector3(0, 1, 0);
  private readonly _dorsalL = new THREE.Vector3(0, 1, 0);
  private readonly _forearmAxis = new THREE.Vector3();
  private readonly _forearmDorsalProj = new THREE.Vector3();
  private readonly _forearmPoleTmp = new THREE.Vector3();
  private readonly _hipR = new THREE.Vector3();
  private readonly _hipL = new THREE.Vector3();
  private readonly _ankleR = new THREE.Vector3();
  private readonly _ankleL = new THREE.Vector3();
  private readonly _kneePoleR = new THREE.Vector3();
  private readonly _kneePoleL = new THREE.Vector3();
  private readonly _footToeWorld = new THREE.Vector3();
  private readonly _magPouchRoot = new THREE.Vector3();
  private readonly _magWellRoot = new THREE.Vector3();
  private readonly _boltRackRoot = new THREE.Vector3();
  private readonly _tmpWorldA = new THREE.Vector3();
  private readonly _tmpWorldB = new THREE.Vector3();

  // Vault hand-pinning orientation scratch buffers
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
  private readonly _guardPosL = new THREE.Vector3();
  private readonly _guardPosR = new THREE.Vector3();
  private readonly _readyPoleL = new THREE.Vector3();
  private readonly _readyPoleR = new THREE.Vector3();
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

  constructor(skeleton: CharacterSkeleton, weaponRig: WeaponRig, audio?: IBodycamAudioSource) {
    this.skeleton = skeleton;
    this.weaponRig = weaponRig;
    this.audio = audio;
  }

  public setAudio(audio: IBodycamAudioSource): void {
    this.audio = audio;
  }

  public setCallbacks(callbacks: CharacterActionCallbacks): void {
    this.callbacks = callbacks;
  }

  public getActiveAction(): CharacterActionType {
    const wa = this.weaponRig.weaponAnimator.getActiveAction();
    if (wa === 'RELOAD') return 'RELOAD';
    if (wa === 'MAG_CHECK') return 'MAG_CHECK';
    return this.actionType;
  }

  public getActiveCombatMove(): SurvivalCombatMove {
    return this.combatMove;
  }

  public isCombatBusy(): boolean {
    return this.combatMove !== 'NONE';
  }

  public isKicking(): boolean {
    return this.combatMove === 'PUSH_KICK';
  }

  public isBusy(): boolean {
    const wa = this.weaponRig.weaponAnimator.getActiveAction();
    return (
      this.actionType !== 'NONE' ||
      this.combatMove !== 'NONE' ||
      wa === 'RELOAD' ||
      wa === 'MAG_CHECK'
    );
  }

  public triggerInspect(): boolean {
    if (this.combatMove !== 'NONE' || this.actionType !== 'NONE') return false;
    return this.weaponRig.triggerInspect();
  }

  public interruptInspect(): void {
    this.weaponRig.interruptInspect();
  }

  public cancelAction(): void {
    this.weaponRig.cancelAction();
    this.actionType = 'NONE';
    this.actionTime = 0;
    this.actionDuration = 0;
    this.cookElapsed = 0;
    this.meleeImpactFired = false;
    this.pinPullFired = false;
    this.throwReleaseFired = false;
  }

  public cancelCombat(): void {
    this.combatMove = 'NONE';
    this.combatTime = 0;
    this.hitstopTimer = 0;
    this.combatHitEvaluated = false;
  }

  public triggerReload(spec: WeaponSpec): void {
    if (this.combatMove !== 'NONE') return;
    this.actionSpec = spec;
    this.weaponRig.triggerReload(Math.max(0.6, spec.reloadDurationSec));
  }

  public triggerMagCheck(spec: WeaponSpec): void {
    if (
      this.weaponRig.weaponAnimator.isReloading() ||
      this.actionType === 'MELEE_SWING' ||
      this.combatMove !== 'NONE'
    ) {
      return;
    }
    this.actionSpec = spec;
    this.weaponRig.triggerMagCheck(Math.max(0.5, spec.magCheckDurationSec));
  }

  public triggerMeleeSwing(spec: WeaponSpec): boolean {
    if (this.actionType === 'MELEE_SWING' || this.combatMove !== 'NONE') return false;
    this.weaponRig.interruptInspect();
    this.actionType = 'MELEE_SWING';
    this.actionTime = 0;
    this.actionDuration = spec.meleeSwingDurationSec ?? 0.48;
    this.actionSpec = spec;
    this.meleeImpactFired = false;
    return true;
  }

  public setUnarmedGuardHeld(held: boolean): void {
    this.unarmedGuardHeld = held;
  }

  public getUnarmedGuardBlend(): number {
    return this.unarmedGuardBlend;
  }

  /**
   * Unarmed alternating Jab -> Cross chain with 0.45s recovery combo window.
   * Punching from ADS Fighting Guard skips the initial raise/coil (~30% faster: 0.25s Jab / 0.34s Cross)
   * versus Non-ADS Ready (0.38s Jab / 0.50s Cross).
   */
  public triggerUnarmedPunch(isVaulting = false, adsHeld?: boolean): 'jab' | 'cross' | null {
    if (isVaulting) return null;
    if (this.combatMove === 'PUSH_KICK' || this.combatMove === 'ARMED_BASH') return null;

    const fromGuard = (adsHeld ?? this.unarmedGuardHeld) || this.unarmedGuardBlend >= 0.45;
    const jabDuration = fromGuard ? 0.25 : 0.38;
    const crossDuration = fromGuard ? 0.34 : 0.50;

    if (this.combatMove === 'LEFT_JAB') {
      const p = this.combatTime / Math.max(0.01, this.combatDuration);
      if (p < 0.68) return null;
      return this.startPunchMove('RIGHT_CROSS', crossDuration, fromGuard);
    }
    if (this.combatMove === 'RIGHT_CROSS') {
      return null;
    }

    if (this.comboWindowTimer > 0) {
      this.comboWindowTimer = 0;
      return this.startPunchMove('RIGHT_CROSS', crossDuration, fromGuard);
    }
    return this.startPunchMove('LEFT_JAB', jabDuration, fromGuard);
  }

  /**
   * Armed V quick-bash:
   *  - Pistol: brisk left-chest to right-outward pistol whip (left support hand briefly clears to chest guard)
   *  - Rifle / Shotgun: rapid ~150 deg pivot + forward buttstock thrust keeping both IK hands on the firearm
   */
  public triggerArmedBash(isVaulting = false, holdClass?: HoldClass): boolean {
    if (isVaulting) return false;
    if (this.combatMove !== 'NONE' || this.actionType === 'THROW_PREP' || this.actionType === 'THROW_RELEASE') {
      return false;
    }
    if (this.actionType === 'RELOAD' || this.actionType === 'MAG_CHECK') {
      this.cancelAction();
    } else {
      this.weaponRig.cancelAction();
    }
    const resolvedHold = holdClass ?? this.lastHoldClass;
    this.armedBashKind = resolvedHold === 'pistol' ? 'pistol' : 'rifle';
    this.combatMove = 'ARMED_BASH';
    this.combatTime = 0;
    this.combatDuration = this.armedBashKind === 'pistol' ? 0.36 : 0.40;
    this.combatHitEvaluated = false;
    this.hitstopTimer = 0;
    this.audio?.playMeleeWhoosh?.('bash');
    this.audio?.playGearRattle('melee', 0.72);
    this.callbacks.onCombatExertion?.(0.14);
    return true;
  }

  /**
   * Grounded Tactical Push-Kick (X) using right-leg 2-bone IK (usable unarmed or armed).
   * Disabled when airborne, vaulting, or when BOTH legs are fractured/blacked out.
   */
  public triggerPushKick(
    grounded: boolean,
    isVaulting: boolean,
    trauma?: Readonly<TraumaModifiers>,
  ): SurvivalKickTriggerResult {
    if (this.combatMove !== 'NONE' || isVaulting || this.actionType === 'THROW_PREP' || this.actionType === 'THROW_RELEASE') {
      return 'busy';
    }
    if (!grounded) return 'airborne';

    const impairL = trauma ? trauma.leftLegImpairment : 0;
    const impairR = trauma ? trauma.rightLegImpairment : 0;
    if (impairL >= 0.72 && impairR >= 0.72) {
      return 'dual_leg_trauma';
    }

    if (this.actionType === 'RELOAD' || this.actionType === 'MAG_CHECK' || this.actionType === 'MELEE_SWING') {
      this.cancelAction();
    } else {
      this.weaponRig.cancelAction();
    }

    const speedMult = 1 - impairR * 0.36;
    this.kickRightLegImpairment = impairR;
    this.combatMove = 'PUSH_KICK';
    this.combatTime = 0;
    this.combatDuration = 0.58 / Math.max(0.55, speedMult);
    this.combatHitEvaluated = false;
    this.kickPlantSoundFired = false;
    this.hitstopTimer = 0;
    this.comboWindowTimer = 0;

    this.audio?.playMeleeWhoosh?.('kick');
    this.audio?.playGearRattle('melee', 0.95);
    this.callbacks.onCombatExertion?.(0.24 + impairR * 0.08);
    return 'ok';
  }

  private startPunchMove(
    move: 'LEFT_JAB' | 'RIGHT_CROSS',
    durationSec: number,
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
    this.callbacks.onCombatExertion?.(move === 'RIGHT_CROSS' ? 0.15 : 0.10);
    return attackType;
  }

  public triggerThrowPrep(spec: WeaponSpec): boolean {
    if (this.actionType === 'THROW_PREP' || this.actionType === 'THROW_RELEASE' || this.combatMove !== 'NONE') {
      return false;
    }
    this.weaponRig.interruptInspect();
    this.actionType = 'THROW_PREP';
    this.actionTime = 0;
    this.actionDuration = spec.fuseDurationSec ?? 3.5;
    this.actionSpec = spec;
    this.pinPullFired = false;
    this.cookElapsed = 0;
    return true;
  }

  public triggerThrowRelease(spec: WeaponSpec): boolean {
    if (this.actionType !== 'THROW_PREP') return false;
    this.actionType = 'THROW_RELEASE';
    this.actionTime = 0;
    this.actionDuration = 0.40;
    this.actionSpec = spec;
    this.throwReleaseFired = false;
    return true;
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

  public update(
    delta: number,
    elapsed: number,
    state: Readonly<CharacterDriverState>,
    spec: WeaponSpec,
    groundHeightAt: (x: number, z: number) => number,
    trauma?: Readonly<TraumaModifiers>,
    adapter?: IBodycamWorldAdapter,
    worldLookDir?: Readonly<THREE.Vector3>,
    adsHeld?: boolean,
  ): void {
    const dt = Math.min(Math.max(delta, 0.0001), 0.05);
    this.lastHoldClass = spec.holdClass;
    this.weaponRig.weaponAnimator.setReloadSpeedMult(trauma ? trauma.reloadSpeedMult : 1.0);

    if (adsHeld !== undefined) {
      this.unarmedGuardHeld = adsHeld;
    }
    const wantsUnarmedGuard =
      spec.holdClass === 'unarmed' &&
      (this.unarmedGuardHeld || state.isAds) &&
      !state.sprint &&
      !state.vaultState.active;
    this.unarmedGuardBlend = THREE.MathUtils.damp(
      this.unarmedGuardBlend,
      wantsUnarmedGuard ? 1 : 0,
      21,
      dt,
    );

    if (this.prevWeaponId !== null && this.prevWeaponId !== spec.id) {
      this.equipBlendTimer = 0.11;
      if (this.combatMove !== 'NONE' && this.combatMove !== 'PUSH_KICK') {
        this.cancelCombat();
      }
    }
    this.prevWeaponId = spec.id;
    if (this.equipBlendTimer > 0) {
      this.equipBlendTimer = Math.max(0, this.equipBlendTimer - dt);
    }

    if (state.vaultState.active && this.combatMove !== 'NONE') {
      this.cancelCombat();
    }

    // Advance unarmed Jab -> Cross, armed V bash, and X Push-Kick state machine + spherecasts
    this.stepCombatState(dt, state, adapter, trauma, worldLookDir);

    // =========================================================================
    // STRICT EVALUATION ORDER STEP (a):
    // Sync pelvis/spine/chest/clavicles to BodycamController state & updateWorld
    // =========================================================================
    const smoothRootY = state.position.y + state.stepSmoothOffsetY;
    if (!this.footWorldInit || Math.abs(state.position.y - this.lastControllerY) > 0.75) {
      this.footWorldYL = state.position.y;
      this.footWorldYR = state.position.y;
      this.footWorldInit = true;
    }
    this.lastControllerY = state.position.y;

    this.skeleton.root.position.set(state.position.x, smoothRootY, state.position.z);
    this.skeleton.root.rotation.set(0, state.torsoYaw, 0);

    // Estimate torso-local velocity for directional gait (walk/backpedal/strafe)
    if (!this.hasPrevPos) {
      this.prevPos.copy(state.position);
      this.hasPrevPos = true;
    }
    const worldVx = (state.position.x - this.prevPos.x) / dt;
    const worldVz = (state.position.z - this.prevPos.z) / dt;
    this.prevPos.copy(state.position);

    const sinY = Math.sin(state.torsoYaw);
    const cosY = Math.cos(state.torsoYaw);
    const rawLocalVx = worldVx * cosY - worldVz * sinY;
    const rawLocalVz = worldVx * sinY + worldVz * cosY;
    this.smoothedLocalVelX = THREE.MathUtils.damp(this.smoothedLocalVelX, rawLocalVx, 14, dt);
    this.smoothedLocalVelZ = THREE.MathUtils.damp(this.smoothedLocalVelZ, rawLocalVz, 14, dt);

    if (state.isMoving && state.stridePhase < this.prevStridePhase - 0.5) {
      this.stepSign *= -1;
    }
    this.prevStridePhase = state.stridePhase;

    this.moveWeight = THREE.MathUtils.damp(this.moveWeight, state.isMoving ? 1 : 0, 11, dt);
    this.crouchBlend = THREE.MathUtils.damp(this.crouchBlend, state.crouch ? 1 : 0, 11, dt);

    const cyclePhase = (this.stepSign > 0 ? state.stridePhase : state.stridePhase + 1.0) * Math.PI;
    const pelvisBob = this.moveWeight * (Math.abs(Math.sin(cyclePhase)) * (state.sprint ? 0.038 : 0.018));
    const pelvisSwayX = this.moveWeight * Math.cos(cyclePhase) * 0.016;

    const kickP =
      this.combatMove === 'PUSH_KICK'
        ? THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1)
        : 0;
    const kickShiftWeight =
      this.combatMove === 'PUSH_KICK'
        ? smoothstep(0.0, 0.16, kickP) * (1 - smoothstep(0.50, 0.92, kickP))
        : 0;

    const headDuck = state.vaultState.active ? state.vaultState.headDuckWeight : 0;
    const landingBend = state.landingKneeBend;
    const landingDrop = THREE.MathUtils.clamp(state.landingCompression, -0.36, 0.04);
    const pelvisHeight = THREE.MathUtils.clamp(
      state.chestHeight - 0.56 + pelvisBob + landingDrop - headDuck * 0.22 - kickShiftWeight * 0.035,
      0.28,
      0.92,
    );
    const leanSign = state.lean;
    this.skeleton.pelvis.position.set(
      pelvisSwayX + leanSign * 0.24 - kickShiftWeight * 0.055,
      pelvisHeight,
      0.21 + this.crouchBlend * 0.06 + landingBend * 0.13 + headDuck * 0.10 + kickShiftWeight * 0.04,
    );

    const spineForwardPitch =
      -this.crouchBlend * 0.20 -
      landingBend * 0.28 -
      headDuck * 0.44 -
      (state.sprint ? 0.07 : 0) +
      kickShiftWeight * 0.16;
    const leanAngle = -leanSign * 1.22 + kickShiftWeight * 0.10;

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
    }

    const spinePitch = state.spinePitch;
    this.skeleton.spineLower.rotation.set(spineForwardPitch * 0.5, punchTorsoYaw * 0.45, leanAngle * 0.45);
    this.skeleton.spineUpper.rotation.set(spineForwardPitch * 0.5 + spinePitch * 0.08, punchTorsoYaw * 0.55, leanAngle * 0.55);
    this.skeleton.chest.rotation.set(spinePitch * 0.14, Math.sin(elapsed * 1.5) * 0.008, 0);

    // Subtle clavicle aim tracking (~25% of aimYaw/aimPitch) + boxing guard & punch protraction
    const guardProtract = spec.holdClass === 'unarmed' ? this.unarmedGuardBlend * 0.09 : 0;
    const protract =
      (state.isAds ? 0.10 : state.isCanted ? 0.09 : state.isPointAim ? 0.08 : 0.05) + guardProtract;
    const leanFollowL = Math.max(0, leanSign) * 0.16;
    const leanFollowR = Math.max(0, -leanSign) * 0.16;
    this.skeleton.leftArm.clavicle.rotation.order = 'YXZ';
    this.skeleton.rightArm.clavicle.rotation.order = 'YXZ';
    this.skeleton.leftArm.clavicle.rotation.set(
      state.aimPitch * 0.22,
      -protract - leftClavProtract - leanFollowL + state.aimYaw * 0.25,
      -state.aimPitch * 0.16,
    );
    this.skeleton.rightArm.clavicle.rotation.set(
      state.aimPitch * 0.22,
      protract + rightClavProtract + leanFollowR + state.aimYaw * 0.25,
      state.aimPitch * 0.16,
    );

    this.skeleton.root.updateMatrixWorld(true);
    this._rootWorldQuatInv.copy(this.skeleton.root.quaternion).invert();

    // Lower body procedural gait & 2-bone leg IK (stair smoothing, jump tuck, landing knee bend & Push-Kick)
    this.updateLowerBodyIK(dt, state, cyclePhase, groundHeightAt, trauma, adapter);

    // =========================================================================
    // STRICT EVALUATION ORDER STEP (b):
    // Anchor weaponRoot directly inside Shoulder/Chest Aim Space around shoulderR
    // =========================================================================
    this.skeleton.rightArm.shoulderPivot.getWorldPosition(this._shoulderRWorld);
    this.skeleton.leftArm.shoulderPivot.getWorldPosition(this._shoulderLWorld);
    this.weaponRig.root.updateMatrixWorld(true);
    this.weaponRig.shoulderAnchor.getWorldPosition(this._weaponShoulderWorld);

    const rigState = this.weaponRig.getReadOnlyRigState();
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
        state.aimPitch * nonAdsAimWeight,
        state.aimYaw * nonAdsAimWeight,
        0,
        'YXZ',
      );
      this.weaponRig.weaponPivot.position.applyEuler(this._pivotAimEuler);
    }

    // Advance additive action curve + armed bash / kick brace + unified arm-trauma tremor
    this.updateActionCurve(dt, elapsed, state, spec, trauma);

    // =========================================================================
    // STRICT EVALUATION ORDER STEP (c):
    // Pre-IK Dual-Arm Physical Reach Clamp
    // =========================================================================
    const vaultState = state.vaultState;
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
      this.actionType === 'NONE' &&
      activeWepAct === 'NONE' &&
      this.combatMove === 'NONE' &&
      vaultState.handPinWeightR < 0.05 &&
      vaultState.handPinWeightL < 0.05
        ? Math.max(rigState.adsBlend, rigState.cantBlend, rigState.pointAimBlend)
        : 0;
    const reachClampWeight = 1 - aimLockWeight;

    if (reachClampWeight > 0.001) {
      for (let iter = 0; iter < 2; iter++) {
        this.weaponRig.root.updateMatrixWorld(true);

        if (clampLeftSocket) {
          this.weaponRig.leftHandSocketAnchor.getWorldPosition(this._leftSocketWorld);
          this._tmpWorldA.subVectors(this._leftSocketWorld, this._shoulderLWorld);
          const leftDist = this._tmpWorldA.length();
          if (leftDist > maxLeftReach && leftDist > 1e-5) {
            const excess = leftDist - maxLeftReach;
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (-excess / leftDist) * reachClampWeight,
            );
            this.weaponRig.root.updateMatrixWorld(true);
          } else if (leftDist < minLeftReach && leftDist > 1e-5) {
            const deficit = minLeftReach - leftDist;
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (deficit / leftDist) * reachClampWeight,
            );
            this.weaponRig.root.updateMatrixWorld(true);
          }
        }

        if (clampRightSocket) {
          this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._rightSocketWorld);
          this._tmpWorldA.subVectors(this._rightSocketWorld, this._shoulderRWorld);
          const rightDist = this._tmpWorldA.length();
          if (rightDist > maxRightReach && rightDist > 1e-5) {
            const excess = rightDist - maxRightReach;
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (-excess / rightDist) * reachClampWeight,
            );
          } else if (rightDist < minRightReach && rightDist > 1e-5) {
            const deficit = minRightReach - rightDist;
            this.weaponRig.root.position.addScaledVector(
              this._tmpWorldA,
              (deficit / rightDist) * reachClampWeight,
            );
          }
        }
      }
    }

    // =========================================================================
    // STRICT EVALUATION ORDER STEP (d):
    // Update weaponRoot world matrices BEFORE solving arm IK, then update rail laser
    // =========================================================================
    this.weaponRig.root.updateMatrixWorld(true);
    this.updateUpperBodyIK(dt, elapsed, state, spec, cyclePhase);
    if (adapter) {
      this.weaponRig.updateLaserBeam(adapter);
    }
  }

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
    state: Readonly<CharacterDriverState>,
    adapter?: IBodycamWorldAdapter,
    trauma?: Readonly<TraumaModifiers>,
    worldLookDir?: Readonly<THREE.Vector3>,
  ): void {
    if (this.comboWindowTimer > 0) {
      this.comboWindowTimer = Math.max(0, this.comboWindowTimer - dt);
    }

    let targetCamPitch = 0;
    let targetCamYaw = 0;
    let targetCamRoll = 0;

    if (this.combatMove !== 'NONE') {
      if (this.hitstopTimer > 0) {
        this.hitstopTimer = Math.max(0, this.hitstopTimer - dt);
      } else {
        this.combatTime += dt;
      }

      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);

      if (this.combatMove === 'LEFT_JAB') {
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        targetCamYaw = -0.070 * drive;
        targetCamPitch = 0.018 * Math.max(0, drive);
        targetCamRoll = 0.032 * drive;

        const jabHitP = this.punchFromGuard ? 0.18 : 0.26;
        if (!this.combatHitEvaluated && p >= jabHitP) {
          this.combatHitEvaluated = true;
          if (adapter) {
            this.performCombatSpherecast('jab', state, adapter, trauma, worldLookDir);
          }
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
          this.comboWindowTimer = 0.45;
        }
      } else if (this.combatMove === 'RIGHT_CROSS') {
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        targetCamYaw = 0.175 * drive;
        targetCamPitch = -0.022 * Math.max(0, drive);
        targetCamRoll = -0.068 * drive;

        const crossHitP = this.punchFromGuard ? 0.19 : 0.27;
        if (!this.combatHitEvaluated && p >= crossHitP) {
          this.combatHitEvaluated = true;
          if (adapter) {
            this.performCombatSpherecast('cross', state, adapter, trauma, worldLookDir);
          }
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
            if (adapter) {
              this.performCombatSpherecast('bash', state, adapter, trauma, worldLookDir);
            }
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
            if (adapter) {
              this.performCombatSpherecast('bash', state, adapter, trauma, worldLookDir);
            }
          }
        }
        if (p >= 1) {
          this.combatMove = 'NONE';
        }
      } else if (this.combatMove === 'PUSH_KICK') {
        const chamberEnv = smoothstep(0.0, 0.16, p);
        const recoverEnv = 1 - smoothstep(0.40, 0.96, p);
        const kickCamEnv = chamberEnv * recoverEnv;
        const thrustExtra =
          p >= 0.16 && p <= 0.42
            ? easeOutQuart((Math.min(p, 0.34) - 0.16) / 0.18) * (1 - smoothstep(0.34, 0.44, p))
            : 0;

        targetCamPitch = 0.122 * kickCamEnv + 0.018 * thrustExtra;
        targetCamRoll = -0.070 * kickCamEnv - 0.012 * thrustExtra;
        targetCamYaw = 0.035 * thrustExtra;

        if (!this.combatHitEvaluated && p >= 0.28 && p <= 0.38 && adapter) {
          const hit = this.performCombatSpherecast('kick', state, adapter, trauma, worldLookDir);
          if (hit) {
            this.combatHitEvaluated = true;
          }
        }

        if (!this.kickPlantSoundFired && p >= 0.84) {
          this.kickPlantSoundFired = true;
          const surface: BodycamSurfaceMaterial = adapter
            ? adapter.getSurfaceMaterial(state.position.x, state.position.y, state.position.z)
            : 'concrete';
          this.audio?.playFootstep(surface, 1.25);
          this.audio?.playGearRattle('step', 0.82);
        }

        if (p >= 1) {
          this.combatMove = 'NONE';
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
    state: Readonly<CharacterDriverState>,
    adapter: IBodycamWorldAdapter,
    trauma?: Readonly<TraumaModifiers>,
    worldLookDir?: Readonly<THREE.Vector3>,
  ): boolean {
    if (worldLookDir && worldLookDir.lengthSq() > 1e-4) {
      this._meleeDir.copy(worldLookDir).normalize();
    } else {
      this._punchEuler.set(state.torsoPitch + state.aimPitch, state.torsoYaw + state.aimYaw, 0, 'YXZ');
      this._meleeDir.set(0, 0, -1).applyEuler(this._punchEuler).normalize();
    }

    const eyeY = state.position.y + state.stepSmoothOffsetY + state.chestHeight;

    if (attackType === 'kick') {
      this._meleeDir.y = THREE.MathUtils.clamp(this._meleeDir.y * 0.45, -0.25, 0.22);
      this._meleeDir.normalize();
      this._meleeOrigin.set(
        state.position.x + this._meleeDir.x * 0.14,
        eyeY - 0.30,
        state.position.z + this._meleeDir.z * 0.14,
      );
    } else {
      this._meleeOrigin.set(
        state.position.x + this._meleeDir.x * 0.12,
        eyeY - 0.04,
        state.position.z + this._meleeDir.z * 0.12,
      );
    }

    const radius = attackType === 'kick' ? 0.22 : attackType === 'bash' ? 0.16 : 0.14;
    const reachM =
      attackType === 'kick'
        ? 1.12 + 0.28
        : attackType === 'bash'
          ? 0.85 + 0.24
          : attackType === 'cross'
            ? 0.68 + 0.32
            : 0.58 + 0.32;

    const hit = this.queryMeleeSpherecast(adapter, this._meleeOrigin, this._meleeDir, radius, reachM);
    if (!hit) return false;

    const out = this._meleeBestOut;
    const hitZone = resolveHitZone(out.object, out.surface);
    const isActor = isActorHitZone(hitZone);

    this._meleeHitVec.set(out.pointX - this._meleeOrigin.x, 0, out.pointZ - this._meleeOrigin.z);
    let wellPlaced = true;
    if (this._meleeHitVec.lengthSq() > 1e-4) {
      this._meleeHitVec.normalize();
      const horizDirLen = Math.hypot(this._meleeDir.x, this._meleeDir.z);
      if (horizDirLen > 1e-4) {
        const dot =
          (this._meleeDir.x * this._meleeHitVec.x + this._meleeDir.z * this._meleeHitVec.z) /
          horizDirLen;
        wellPlaced = dot >= 0.866;
      }
    }

    if (hitZone === 'glass' && out.object) {
      this._meleeEvent.point.set(out.pointX, out.pointY, out.pointZ);
      this._meleeEvent.direction.copy(this._meleeDir);
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

    const impairR = trauma ? trauma.rightLegImpairment : this.kickRightLegImpairment;
    const kickKbScale = 1 - impairR * 0.48;
    const ev = this._meleeEvent;
    ev.attackType = attackType;
    ev.hitZone = hitZone;
    ev.object = out.object;
    ev.point.set(out.pointX, out.pointY, out.pointZ);
    ev.direction.copy(this._meleeDir);
    ev.normal.set(out.normalX, out.normalY, out.normalZ);
    ev.surface = out.surface;
    ev.wellPlaced = wellPlaced;

    if (attackType === 'jab') {
      ev.damageEnergyJ = 240;
      ev.knockbackForce = 0;
      ev.stunDurationSec = hitZone === 'head' ? 0.65 : 0;
    } else if (attackType === 'cross') {
      ev.damageEnergyJ = 345;
      ev.knockbackForce = 0;
      ev.stunDurationSec = hitZone === 'head' ? 0.72 : 0;
    } else if (attackType === 'bash') {
      ev.damageEnergyJ = 285;
      ev.knockbackForce = 2.8;
      ev.stunDurationSec = 0.42;
    } else {
      ev.damageEnergyJ = wellPlaced ? 330 : 190;
      ev.knockbackForce = (wellPlaced ? 7.2 : 3.4) * kickKbScale;
      ev.stunDurationSec = wellPlaced ? 0.95 : 0.38;
    }

    this.hitstopTimer = attackType === 'kick' ? 0.032 : attackType === 'cross' ? 0.030 : 0.028;

    const shockPitch =
      attackType === 'kick' ? 0.034 : attackType === 'cross' ? 0.024 : attackType === 'bash' ? 0.022 : 0.016;
    const shockYaw = attackType === 'kick' ? 0.020 : 0.015;
    this.callbacks.onCombatShock?.(shockPitch, shockYaw, attackType === 'bash' ? 0.025 : 0.012);

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

      if (adapter.raycast(this._meleeRayOrigin, direction, 0.02, maxDistance, this._meleeRayOut)) {
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

  private isLeftHandOverriddenByAction(spec: WeaponSpec): boolean {
    const isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';
    if (this.combatMove === 'ARMED_BASH' && spec.holdClass === 'pistol') return true;
    const wa = this.weaponRig.weaponAnimator.getActiveAction();
    if (isFirearm && (wa === 'RELOAD' || wa === 'MAG_CHECK')) return true;
    if (this.actionType === 'THROW_PREP') return true;
    if (this.actionType === 'MELEE_SWING' && !isFirearm) return true;
    return false;
  }

  private updateLowerBodyIK(
    dt: number,
    state: Readonly<CharacterDriverState>,
    cyclePhase: number,
    groundHeightAt: (x: number, z: number) => number,
    trauma?: Readonly<TraumaModifiers>,
    adapter?: IBodycamWorldAdapter,
  ): void {
    this.skeleton.leftLeg.hipPivot.getWorldPosition(this._hipL);
    this.skeleton.rightLeg.hipPivot.getWorldPosition(this._hipR);
    this.skeleton.root.worldToLocal(this._hipL);
    this.skeleton.root.worldToLocal(this._hipR);

    const speed = Math.hypot(this.smoothedLocalVelX, this.smoothedLocalVelZ);
    const moveDirX = speed > 0.12 ? this.smoothedLocalVelX / speed : 0;
    const moveDirZ = speed > 0.12 ? this.smoothedLocalVelZ / speed : -1;

    const strideLen = state.sprint ? 0.42 : state.crouch ? 0.22 : 0.28;
    const stepLiftH = state.sprint ? 0.15 : state.crouch ? 0.08 : 0.10;
    const landingBend = state.landingKneeBend;
    const stanceSpreadX = 0.115 + this.crouchBlend * 0.032 + landingBend * 0.042;
    const smoothRootY = this.skeleton.root.position.y;
    const groundRefY = Math.max(state.position.y, smoothRootY);
    const vaultState = state.vaultState;

    const computeFoot = (
      side: -1 | 1,
      hipPos: THREE.Vector3,
      phase: number,
      outAnkle: THREE.Vector3,
      outPole: THREE.Vector3,
      bootObj: THREE.Object3D,
      ankleH: number,
      legImpairment: number,
      prevWorldY: number,
      prevSlopePitch: number,
    ): [number, number] => {
      const idleZ = side === -1 ? -0.04 - this.crouchBlend * 0.08 : 0.05 + this.crouchBlend * 0.08;
      const impairScale = 1 - legImpairment * 0.62;
      const swing = -Math.cos(phase) * strideLen * this.moveWeight * impairScale;
      const lift = Math.max(0, Math.sin(phase)) * stepLiftH * this.moveWeight * (1 - legImpairment * 0.72);

      const footLocalX = side * (stanceSpreadX + legImpairment * 0.025) + moveDirX * swing;
      const footLocalZ =
        0.17 + idleZ * (1 - this.moveWeight) + moveDirZ * swing + legImpairment * 0.04 - landingBend * 0.035;

      this._tmpWorldA.set(footLocalX, 0, footLocalZ).applyMatrix4(this.skeleton.root.matrixWorld);
      const rawGroundY = adapter
        ? adapter.getGroundHeight(this._tmpWorldA.x, this._tmpWorldA.z, groundRefY)
        : groundHeightAt(this._tmpWorldA.x, this._tmpWorldA.z);
      const clampedTargetWorldY = THREE.MathUtils.clamp(rawGroundY, smoothRootY - 0.42, smoothRootY + 0.42);
      const smoothedWorldY = THREE.MathUtils.damp(prevWorldY, clampedTargetWorldY, 18, dt);
      const localGroundY = THREE.MathUtils.clamp(smoothedWorldY - smoothRootY, -0.45, 0.45);

      this._footToeWorld.set(footLocalX, 0, footLocalZ - 0.16).applyMatrix4(this.skeleton.root.matrixWorld);
      const toeGroundY = adapter
        ? adapter.getGroundHeight(this._footToeWorld.x, this._footToeWorld.z, groundRefY)
        : groundHeightAt(this._footToeWorld.x, this._footToeWorld.z);
      const rawSlopePitch =
        Math.abs(toeGroundY - rawGroundY) < 0.14
          ? THREE.MathUtils.clamp(Math.atan2(toeGroundY - rawGroundY, 0.16), -0.45, 0.45)
          : 0;
      const smoothedSlopePitch = THREE.MathUtils.damp(prevSlopePitch, rawSlopePitch, 16, dt);

      const airTuck =
        !state.grounded && !vaultState.active
          ? THREE.MathUtils.clamp(0.35 + Math.max(0, state.velY / 5.5) * 0.45, 0.2, 0.8)
          : 0;
      const legTuck = vaultState.active ? vaultState.legTuckWeight : airTuck;
      const tuckLift = legTuck * (side < 0 ? 0.34 : 0.28);
      const tuckBack = legTuck * (side < 0 ? 0.14 : 0.22);

      const effectiveGroundY = vaultState.active || !state.grounded ? 0 : localGroundY;
      outAnkle.set(footLocalX, effectiveGroundY + ankleH + lift + tuckLift, footLocalZ + tuckBack);

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

    // Tactical Push-Kick (X): Right-leg 2-bone IK override (Chamber -> Snap Thrust -> Plant Recovery)
    if (this.combatMove === 'PUSH_KICK') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const eyeH = state.chestHeight;

      this._ankleL.x = THREE.MathUtils.lerp(this._ankleL.x, -0.14, smoothstep(0.0, 0.16, p));
      this._ankleL.z = THREE.MathUtils.lerp(this._ankleL.z, 0.10, smoothstep(0.0, 0.16, p));

      let blend = 0;
      let bootPitchX = 0;

      if (p < 0.16) {
        const t = smoothstep(0.0, 0.16, p);
        blend = t;
        this._kickAnkleTarget.set(0.11, this._hipR.y - 0.12, this._hipR.z - 0.34);
        this._kickPoleTarget.set(0.14, this._hipR.y + 0.30, this._hipR.z - 0.68);
        bootPitchX = 0.72 * t;
      } else if (p < 0.34) {
        const t = easeOutQuart((p - 0.16) / 0.18);
        blend = 1;
        this._kickAnkleTarget.set(
          THREE.MathUtils.lerp(0.11, 0.03, t),
          THREE.MathUtils.lerp(this._hipR.y - 0.12, eyeH - 0.33, t),
          THREE.MathUtils.lerp(this._hipR.z - 0.34, -0.66, t),
        );
        this._kickPoleTarget.set(
          0.08,
          THREE.MathUtils.lerp(this._hipR.y + 0.30, eyeH - 0.18, t),
          -0.90,
        );
        bootPitchX = THREE.MathUtils.lerp(0.72, 1.42, t);
      } else if (p < 0.42) {
        blend = 1;
        this._kickAnkleTarget.set(0.03, eyeH - 0.33, -0.66);
        this._kickPoleTarget.set(0.08, eyeH - 0.18, -0.90);
        bootPitchX = 1.42;
      } else {
        const rec = smoothstep(0.42, 1.0, p);
        const rechamber = Math.sin(rec * Math.PI);
        blend = 1 - rec;
        this._kickAnkleTarget.set(
          THREE.MathUtils.lerp(0.03, 0.13, rec),
          THREE.MathUtils.lerp(eyeH - 0.33, this._hipR.y - 0.24, rec) + rechamber * 0.12,
          THREE.MathUtils.lerp(-0.66, -0.18, rec),
        );
        this._kickPoleTarget.set(0.12, this._hipR.y + 0.05, -0.68);
        bootPitchX = THREE.MathUtils.lerp(1.42, 0.0, rec);
      }

      this._ankleR.lerp(this._kickAnkleTarget, blend);
      this._kneePoleR.lerp(this._kickPoleTarget, blend);
      this.skeleton.rightLeg.boot.rotation.set(
        THREE.MathUtils.lerp(this.skeleton.rightLeg.boot.rotation.x, bootPitchX, blend),
        THREE.MathUtils.lerp(this.skeleton.rightLeg.boot.rotation.y, 0.04, blend),
        0,
      );
    }

    const legL = this.skeleton.leftLeg;
    const legR = this.skeleton.rightLeg;

    solveTwoBoneIK(this._hipL, this._ankleL, this._kneePoleL, legL.upperLen, legL.lowerLen, this.leftLegIK);
    orientLimbAlongY(legL.thigh, this._hipL, this.leftLegIK.midPos, this._kneePoleL);
    orientLimbAlongY(legL.shin, this.leftLegIK.midPos, this.leftLegIK.endPos, this._kneePoleL);
    legL.boot.position.copy(this.leftLegIK.endPos);

    solveTwoBoneIK(this._hipR, this._ankleR, this._kneePoleR, legR.upperLen, legR.lowerLen, this.rightLegIK);
    orientLimbAlongY(legR.thigh, this._hipR, this.rightLegIK.midPos, this._kneePoleR);
    orientLimbAlongY(legR.shin, this.rightLegIK.midPos, this.rightLegIK.endPos, this._kneePoleR);
    legR.boot.position.copy(this.rightLegIK.endPos);
  }

  private updateActionCurve(
    dt: number,
    elapsed: number,
    _state: Readonly<CharacterDriverState>,
    currentSpec: WeaponSpec,
    trauma?: Readonly<TraumaModifiers>,
  ): void {
    this._actionPosOffset.set(0, 0, 0);
    this._actionRotOffset.set(0, 0, 0);

    let magDropY = 0;
    let boltBackZ = 0;
    let hideModel = false;
    let hidePin = false;

    if (this.actionType !== 'NONE') {
      if (this.actionSpec && this.actionSpec.id !== currentSpec.id && this.actionType !== 'MELEE_SWING') {
        this.cancelAction();
      } else {
        const reloadSpeedMult = this.actionType === 'RELOAD' && trauma ? trauma.reloadSpeedMult : 1.0;
        this.actionTime += dt * reloadSpeedMult;
        const p = THREE.MathUtils.clamp(this.actionTime / Math.max(0.01, this.actionDuration), 0, 1);

        if (this.actionType === 'MELEE_SWING') {
          // Knife / Crowbar swing arc
          if (p < 0.26) {
            const w = smoothstep(0, 0.26, p);
            this._actionPosOffset.set(0.16 * w, 0.12 * w, 0.16 * w);
            this._actionRotOffset.set(0.68 * w, -0.52 * w, -0.48 * w);
          } else if (p < 0.54) {
            const s = smoothstep(0.26, 0.50, p);
            this._actionPosOffset.set(
              THREE.MathUtils.lerp(0.16, -0.24, s),
              THREE.MathUtils.lerp(0.12, -0.10, s),
              THREE.MathUtils.lerp(0.16, -0.22, s),
            );
            this._actionRotOffset.set(
              THREE.MathUtils.lerp(0.68, -1.18, s),
              THREE.MathUtils.lerp(-0.52, 0.72, s),
              THREE.MathUtils.lerp(-0.48, 0.68, s),
            );
            if (!this.meleeImpactFired && p >= 0.36) {
              this.meleeImpactFired = true;
              this.callbacks.onMeleeImpact?.(currentSpec);
            }
          } else {
            const r = smoothstep(0.54, 1.0, p);
            this._actionPosOffset.set(-0.24 * (1 - r), -0.10 * (1 - r), -0.22 * (1 - r));
            this._actionRotOffset.set(-1.18 * (1 - r), 0.72 * (1 - r), 0.68 * (1 - r));
          }

          if (p >= 1) {
            this.actionType = 'NONE';
          }
        } else if (this.actionType === 'THROW_PREP') {
          this.cookElapsed += dt;
          const wind = smoothstep(0, 0.30, this.cookElapsed);
          this._actionPosOffset.set(0.14 * wind, 0.12 * wind, 0.18 * wind);
          this._actionRotOffset.set(0.52 * wind, -0.32 * wind, -0.22 * wind);

          if (currentSpec.id === 'rgd5_frag') {
            if (!this.pinPullFired && this.cookElapsed >= 0.24) {
              this.pinPullFired = true;
              this.callbacks.onPinPulled?.(currentSpec);
            }
            hidePin = this.pinPullFired;
            const fuse = currentSpec.fuseDurationSec ?? 3.5;
            if (this.cookElapsed >= fuse) {
              this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._tmpWorldA);
              this.actionType = 'NONE';
              this.callbacks.onOvercookedDetonate?.(currentSpec, this._tmpWorldA);
            }
          }
        } else if (this.actionType === 'THROW_RELEASE') {
          const fuseTotal = currentSpec.fuseDurationSec ?? 3.5;
          if (p < 0.24) {
            const whip = smoothstep(0, 0.22, p);
            this._actionPosOffset.set(
              THREE.MathUtils.lerp(0.14, -0.04, whip),
              THREE.MathUtils.lerp(0.12, 0.02, whip),
              THREE.MathUtils.lerp(0.18, -0.20, whip),
            );
            this._actionRotOffset.set(
              THREE.MathUtils.lerp(0.52, -0.95, whip),
              THREE.MathUtils.lerp(-0.32, 0.15, whip),
              THREE.MathUtils.lerp(-0.22, 0.10, whip),
            );
          } else {
            const rec = smoothstep(0.24, 1.0, p);
            this._actionPosOffset.set(
              -0.04 * (1 - rec),
              0.02 * (1 - rec) - Math.sin(rec * Math.PI) * 0.08,
              -0.20 * (1 - rec),
            );
            this._actionRotOffset.set(-0.95 * (1 - rec), 0.15 * (1 - rec), 0.10 * (1 - rec));
          }

          if (!this.throwReleaseFired && p >= 0.16) {
            this.throwReleaseFired = true;
            this.weaponRig.applyCharacterActionPose(this._actionPosOffset, this._actionRotOffset, 0, 0, false, true);
            this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._tmpWorldA);
            const remainingFuse = Math.max(0.2, fuseTotal - this.cookElapsed);
            this.callbacks.onThrowRelease?.(currentSpec, this._tmpWorldA, remainingFuse);
          }
          hideModel = this.throwReleaseFired;
          hidePin = true;

          if (p >= 1) {
            this.actionType = 'NONE';
          }
        }
      }
    }

    // Armed V quick-bash: distinct Pistol Whip (left chest -> right outward) vs Rifle Buttstock Bash
    if (this.combatMove === 'ARMED_BASH' && currentSpec.holdClass !== 'unarmed') {
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const adsComp = this.weaponRig.getReadOnlyRigState().adsBlend;

      if (currentSpec.holdClass === 'pistol') {
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
    } else if (this.combatMove === 'PUSH_KICK' && currentSpec.holdClass !== 'unarmed') {
      // Brace weapon tightly across chest during Tactical Push-Kick
      const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
      const brace = smoothstep(0.0, 0.16, p) * (1 - smoothstep(0.48, 0.96, p));
      this._actionPosOffset.x += -0.07 * brace;
      this._actionPosOffset.y += -0.05 * brace;
      this._actionPosOffset.z += 0.09 * brace;
      this._actionRotOffset.x += -0.12 * brace;
      this._actionRotOffset.y += 0.44 * brace;
      this._actionRotOffset.z += 0.34 * brace;
    }

    // Unified Arm-Trauma Tremor
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

    this.weaponRig.applyCharacterActionPose(
      this._actionPosOffset,
      this._actionRotOffset,
      magDropY,
      boltBackZ,
      hideModel,
      hidePin,
    );
  }

  private updateUpperBodyIK(
    dt: number,
    elapsed: number,
    state: Readonly<CharacterDriverState>,
    spec: WeaponSpec,
    cyclePhase: number,
  ): void {
    const vault = state.vaultState;
    const vaultPinL = vault.active ? vault.handPinWeightL : 0;
    const vaultPinR = vault.active ? vault.handPinWeightR : 0;
    const isUnarmed = spec.holdClass === 'unarmed';
    const isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';

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

    const eyeH = state.chestHeight;
    const breathBob = Math.sin(elapsed * 2.2) * 0.0045;
    const guardStrideBob =
      this.moveWeight * Math.sin(state.stridePhase * Math.PI * 2) * (state.sprint ? 0.014 : 0.007);
    const kickBrace =
      this.combatMove === 'PUSH_KICK'
        ? smoothstep(0.0, 0.16, this.combatTime / Math.max(0.01, this.combatDuration)) *
          (1 - smoothstep(0.46, 0.94, this.combatTime / Math.max(0.01, this.combatDuration)))
        : 0;

    this._camLocalOrigin.set(0.03 + state.lean, eyeH, 0.06);
    const guardPitch = THREE.MathUtils.clamp(state.torsoPitch * 0.72, -0.58, 0.58);

    if (isUnarmed) {
      const g = this.unarmedGuardBlend;
      const aimPitchOff = state.aimPitch * 0.18;
      const aimYawOff = state.aimYaw * 0.16;

      // 1. NON-ADS UNARMED = RELAXED READY STANCE (lower-rib / waist level, clear viewport)
      // Opposite-arm stride swing synced to cyclePhase (in survival leg IK left leg steps forward when cos(cyclePhase) > 0)
      const armSwing = Math.cos(cyclePhase) * this.moveWeight * (1 - g);
      const swingAmpZ = state.sprint ? 0.13 : 0.062;
      const swingAmpY = state.sprint ? 0.052 : 0.020;
      const swingAmpX = state.sprint ? 0.030 : 0.014;
      const swingL = Math.max(0, -armSwing);
      const swingR = Math.max(0, armSwing);

      this._readyPosL.set(
        -0.22 + swingL * swingAmpX + kickBrace * 0.05,
        -0.30 + swingL * swingAmpY - breathBob * 0.6 + kickBrace * 0.10,
        -0.22 + armSwing * swingAmpZ + kickBrace * 0.04,
      );
      this._readyPosR.set(
        0.22 - swingR * swingAmpX - kickBrace * 0.05,
        -0.30 + swingR * swingAmpY + breathBob * 0.6 + kickBrace * 0.10,
        -0.22 - armSwing * swingAmpZ + kickBrace * 0.04,
      );
      const readyPitch = THREE.MathUtils.clamp(state.torsoPitch * 0.18, -0.20, 0.20);
      this._unarmedPitchEuler.set(readyPitch, 0, 0, 'YXZ');
      this._readyPosL.applyEuler(this._unarmedPitchEuler).add(this._camLocalOrigin);
      this._readyPosR.applyEuler(this._unarmedPitchEuler).add(this._camLocalOrigin);

      // 2. ADS UNARMED (Right-Click HELD) = COMPACT CHEST-CAM-FRAMED FIGHTING GUARD
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

      leftGripCurl = THREE.MathUtils.lerp(0.42, 0.98, g);
      rightGripCurl = THREE.MathUtils.lerp(0.42, 0.98, g);
      leftPronation = THREE.MathUtils.lerp(0.24, 0.62, g);
      rightPronation = THREE.MathUtils.lerp(0.24, 0.62, g);

      // 3. Alternating LEFT_JAB / RIGHT_CROSS ballistic drive + forearm pronation + guard speed scaling
      if (this.combatMove === 'LEFT_JAB' || this.combatMove === 'RIGHT_CROSS') {
        const p = THREE.MathUtils.clamp(this.combatTime / Math.max(0.01, this.combatDuration), 0, 1);
        const drive = this.evalPunchDriveCurve(p, this.punchFromGuard);
        const ext = Math.max(0, drive);
        const coil = Math.min(0, drive);
        const punchEnv = smoothstep(0.0, this.punchFromGuard ? 0.06 : 0.14, p) * (1 - smoothstep(0.66, 1.0, p));
        activePunchPoleWeight = Math.max(g, punchEnv);

        leftGripCurl = Math.max(leftGripCurl, THREE.MathUtils.lerp(0.42, 0.98, Math.max(punchEnv, ext)));
        rightGripCurl = Math.max(rightGripCurl, THREE.MathUtils.lerp(0.42, 0.98, Math.max(punchEnv, ext)));

        this._punchEuler.set(
          THREE.MathUtils.clamp(state.aimPitch + state.torsoPitch * 0.72, -0.85, 0.85),
          state.aimYaw,
          0,
          'YXZ',
        );
        this._punchAimDirLocal.set(0, 0, -1).applyEuler(this._punchEuler).normalize();

        if (this.combatMove === 'LEFT_JAB') {
          activePunchExtL = ext;
          if (!this.punchFromGuard) {
            this._lDesiredRoot.lerp(this._guardPosL, punchEnv);
            this._rDesiredRoot.lerp(this._guardPosR, punchEnv * 0.72);
            leftPronation = THREE.MathUtils.lerp(leftPronation, 0.62, punchEnv);
            rightPronation = THREE.MathUtils.lerp(rightPronation, 0.62, punchEnv * 0.72);
          }

          this._punchTargetLocal.copy(this._shoulderL).addScaledVector(this._punchAimDirLocal, 0.57);
          this._punchTargetLocal.x += 0.135;
          this._punchTargetLocal.y += 0.125;

          if (drive >= 0) {
            this._lDesiredRoot.lerp(this._punchTargetLocal, ext);
          } else {
            const coilScale = this.punchFromGuard ? 0.05 : 0.11;
            this._lDesiredRoot.z += -coil * coilScale;
            this._lDesiredRoot.y += coil * (this.punchFromGuard ? 0.015 : 0.04);
          }
          leftPronation = THREE.MathUtils.lerp(leftPronation, 1.54, smoothstep(0.06, 0.76, ext));

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

          this._punchTargetLocal.copy(this._shoulderR).addScaledVector(this._punchAimDirLocal, 0.61);
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
          rightPronation = THREE.MathUtils.lerp(rightPronation, 1.54, smoothstep(0.06, 0.76, ext));

          this._lDesiredRoot.x += 0.032 * ext;
          this._lDesiredRoot.y += 0.040 * ext;
          this._lDesiredRoot.z += 0.105 * ext;
        }
      }
    } else {
      this.weaponRig.rightHandSocketAnchor.getWorldPosition(this._rDesiredRoot);
      this.skeleton.root.worldToLocal(this._rDesiredRoot);
      this.weaponRig.rightHandSocketAnchor.getWorldQuaternion(this._rDesiredQuatRoot);
      this._rDesiredQuatRoot.premultiply(this._rootWorldQuatInv);
    }

    if (vaultPinR > 0.001) {
      this._vaultHandRRoot.copy(vault.handRWorld);
      this.skeleton.root.worldToLocal(this._vaultHandRRoot);
      this._rDesiredRoot.lerp(this._vaultHandRRoot, vaultPinR);
      if (!isUnarmed) {
        this._rDesiredQuatRoot.slerp(this._vaultHandQuatRoot, vaultPinR);
      }
      rightGripCurl = THREE.MathUtils.lerp(rightGripCurl, 0.16, vaultPinR);
    }

    if (this.equipBlendTimer > 0 || vaultPinR > 0.001) {
      this.rightHandBlender.blendTo(
        this._rDesiredRoot,
        isUnarmed ? this.rightHandBlender.quaternion : this._rDesiredQuatRoot,
        rightGripCurl,
        1,
        vaultPinR > 0.001 ? 36 : 32,
        dt,
      );
    } else {
      this.rightHandBlender.snap(
        this._rDesiredRoot,
        isUnarmed ? this.rightHandBlender.quaternion : this._rDesiredQuatRoot,
        rightGripCurl,
        1,
      );
    }

    this._rTargetRoot.copy(this.rightHandBlender.position);
    this._rQuatRoot.copy(this.rightHandBlender.quaternion);

    this._aimPoleEuler.set(state.aimPitch * 0.55, state.aimYaw * 0.70, -state.lean * 0.85, 'YXZ');
    if (isUnarmed) {
      const poleGuardW = Math.max(this.unarmedGuardBlend, activePunchPoleWeight);

      this._readyPoleR.set(this._shoulderR.x + 0.12, this._shoulderR.y - 0.58, this._shoulderR.z + 0.34);
      this._readyPoleL.set(this._shoulderL.x - 0.12, this._shoulderL.y - 0.58, this._shoulderL.z + 0.34);

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
      const ptW = this.weaponRig.getReadOnlyRigState().pointAimBlend;
      this._poleR
        .set(0.35 + ptW * 0.09, -0.55 + ptW * 0.14, 0.28 - ptW * 0.03)
        .applyEuler(this._aimPoleEuler)
        .add(this._shoulderR);
      this._poleL.set(-0.35, -0.55, 0.28).applyEuler(this._aimPoleEuler).add(this._shoulderL);
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
    solveTwoBoneIK(this._shoulderR, this._rTargetRoot, this._poleR, armR.upperLen, armR.lowerLen, this.rightArmIK);
    orientLimbAlongY(armR.upperArm, this._shoulderR, this.rightArmIK.midPos, this._poleR);
    if (isUnarmed) {
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
    armR.hand.root.position.copy(this.rightArmIK.endPos);
    armR.hand.root.quaternion.copy(this._rQuatRoot);
    armR.hand.root.updateMatrixWorld(true);

    const weaponAction = this.weaponRig.weaponAnimator.getActiveAction();
    // Strict trigger discipline: right index finger straight off the trigger during Inspect, Reload, and Mag-Check
    const triggerEngaged =
      !isUnarmed &&
      vaultPinR < 0.05 &&
      weaponAction === 'NONE' &&
      (state.isAds ||
        state.isCanted ||
        state.isPointAim ||
        state.recoilSpring.z > 0.004 ||
        this.actionType === 'MELEE_SWING');
    this.skeleton.applyHandPose(
      'right',
      vaultPinR > 0.2 || isUnarmed ? 'unarmed' : spec.holdClass,
      triggerEngaged,
      this.rightHandBlender.gripCurl,
    );

    // 2. Post-IK Rigid Hard-Lock: align weaponRig.root to solved right hand in hip-fire/action,
    //    while keeping sightAnchor dead-center on camera axis during ADS / Canted / Point Aim on both leans.
    const rigStatePost = this.weaponRig.getReadOnlyRigState();
    const aimLockWeightPost =
      !isUnarmed &&
      this.actionType === 'NONE' &&
      weaponAction === 'NONE' &&
      this.combatMove === 'NONE' &&
      vaultPinR < 0.05 &&
      vaultPinL < 0.05
        ? Math.max(rigStatePost.adsBlend, rigStatePost.cantBlend, rigStatePost.pointAimBlend)
        : 0;
    const hardLockW = 1 - aimLockWeightPost;

    if (!isUnarmed && vaultPinR < 0.12 && hardLockW > 0.001) {
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
    if (!isUnarmed) {
      if (this.weaponRig.hasLeftHandSocket) {
        this.weaponRig.leftHandSocketAnchor.getWorldPosition(this._lDesiredRoot);
        const inspectSlideZ = this.weaponRig.weaponAnimator.getInspectLeftHandSlideZ();
        if (Math.abs(inspectSlideZ) > 1e-5) {
          this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
          this._inspectSlideWorld.set(0, 0, inspectSlideZ).applyQuaternion(this._inspectWeaponQuat);
          this._lDesiredRoot.add(this._inspectSlideWorld);
        }
        this.skeleton.root.worldToLocal(this._lDesiredRoot);
        this.weaponRig.leftHandSocketAnchor.getWorldQuaternion(this._lDesiredQuatRoot);
        this._lDesiredQuatRoot.premultiply(this._rootWorldQuatInv);
        const asm = this.weaponRig.getModelAssembly();
        if (asm) {
          leftGripCurl = asm.leftGripCurl;
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
      leftOverridden = true;
      this._vaultHandLRoot.copy(vault.handLWorld);
      this.skeleton.root.worldToLocal(this._vaultHandLRoot);
      this._lDesiredRoot.lerp(this._vaultHandLRoot, vaultPinL);
      if (!isUnarmed) {
        this._lDesiredQuatRoot.slerp(this._vaultHandQuatRoot, vaultPinL);
      }
      leftGripCurl = THREE.MathUtils.lerp(leftGripCurl, 0.16, vaultPinL);
    } else if (weaponAction === 'RELOAD' && isFirearm) {
      leftOverridden = true;
      const p = this.weaponRig.weaponAnimator.getActionProgress();

      this.skeleton.magPouchAnchor.getWorldPosition(this._magPouchRoot);
      this.skeleton.root.worldToLocal(this._magPouchRoot);
      this.weaponRig.magWellAnchor.getWorldPosition(this._magWellRoot);
      this.skeleton.root.worldToLocal(this._magWellRoot);
      this.weaponRig.boltRackAnchor.getWorldPosition(this._boltRackRoot);
      this.skeleton.root.worldToLocal(this._boltRackRoot);

      if (p < 0.16) {
        const t = smoothstep(0.0, 0.16, p);
        this._lDesiredRoot.lerp(this._magWellRoot, t);
        leftGripCurl = THREE.MathUtils.lerp(0.85, 0.94, t);
      } else if (p < 0.36) {
        const t = smoothstep(0.16, 0.36, p);
        this._lDesiredRoot.copy(this._magWellRoot).lerp(this._magPouchRoot, t);
        leftGripCurl = 0.95;
      } else if (p < 0.48) {
        const t = smoothstep(0.36, 0.48, p);
        this._lDesiredRoot.copy(this._magPouchRoot);
        this._lDesiredRoot.y -= Math.sin(t * Math.PI) * 0.035;
        leftGripCurl = THREE.MathUtils.lerp(0.76, 0.95, t);
      } else if (p < 0.65) {
        const t = smoothstep(0.48, 0.63, p);
        this._lDesiredRoot.copy(this._magPouchRoot).lerp(this._magWellRoot, t);
        leftGripCurl = 0.95;
      } else if (p < 0.86) {
        const t = smoothstep(0.65, 0.72, p);
        const pullBack =
          p >= 0.70 && p <= 0.86 ? Math.sin(((p - 0.70) / 0.16) * Math.PI) * 0.055 : 0;
        this.weaponRig.weaponPivot.getWorldQuaternion(this._inspectWeaponQuat);
        this._inspectSlideWorld.set(0, 0, pullBack).applyQuaternion(this._inspectWeaponQuat);
        this._inspectSlideWorld.applyQuaternion(this._rootWorldQuatInv);
        this._tmpWorldB.copy(this._boltRackRoot).add(this._inspectSlideWorld);
        this._lDesiredRoot.copy(this._magWellRoot).lerp(this._tmpWorldB, t);
        leftGripCurl = 0.90;
      } else {
        const t = smoothstep(0.86, 1.0, p);
        this._tmpWorldB.copy(this._lDesiredRoot);
        this._lDesiredRoot.copy(this._boltRackRoot).lerp(this._tmpWorldB, t);
        leftGripCurl = THREE.MathUtils.lerp(0.90, spec.leftHandSocket?.gripCurl ?? 0.85, t);
      }
    } else if (weaponAction === 'MAG_CHECK' && isFirearm) {
      leftOverridden = true;
      const p = this.weaponRig.weaponAnimator.getActionProgress();
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
    } else if (this.actionType === 'THROW_PREP') {
      leftOverridden = true;
      if (spec.id === 'rgd5_frag' && this.cookElapsed < 0.34) {
        const t = Math.sin(smoothstep(0, 0.34, this.cookElapsed) * Math.PI);
        this._tmpWorldB.copy(this._rTargetRoot);
        this._tmpWorldB.x -= 0.04;
        this._tmpWorldB.y += 0.03;
        this._tmpWorldB.z -= 0.02;
        this._lDesiredRoot.lerp(this._tmpWorldB, t);
        leftGripCurl = 0.95;
      } else {
        this._lDesiredRoot.set(-0.15, eyeH - 0.14, -0.18);
        this._tmpEuler.set(0.12, -0.25, 0.25, 'YXZ');
        this._lDesiredQuatRoot.setFromEuler(this._tmpEuler);
        leftGripCurl = 0.45;
      }
    } else if (this.actionType === 'MELEE_SWING' && !isFirearm) {
      leftOverridden = true;
      this._lDesiredRoot.set(-0.22, eyeH - 0.24, -0.02);
      leftGripCurl = 0.85;
    } else if (this.combatMove === 'ARMED_BASH' && spec.holdClass === 'pistol') {
      // Support left hand clears to protective chest guard during right-hand pistol whip
      leftOverridden = true;
      this._lDesiredRoot.set(-0.16, eyeH - 0.16, -0.18);
      this._tmpEuler.set(0.18, -0.28, 0.36, 'YXZ');
      this._lDesiredQuatRoot.setFromEuler(this._tmpEuler);
      leftGripCurl = 0.88;
    }

    if (this.wasLeftOverridden && !leftOverridden) {
      this.leftActionReturnTimer = 0.14;
    }
    this.wasLeftOverridden = leftOverridden;
    if (this.leftActionReturnTimer > 0) {
      this.leftActionReturnTimer = Math.max(0, this.leftActionReturnTimer - dt);
    }

    if (leftOverridden || this.equipBlendTimer > 0 || this.leftActionReturnTimer > 0) {
      const leftLambda = vaultPinL > 0.001 ? 38 : leftOverridden ? 28 : 34;
      this.leftHandBlender.blendTo(
        this._lDesiredRoot,
        isUnarmed ? this.leftHandBlender.quaternion : this._lDesiredQuatRoot,
        leftGripCurl,
        1,
        leftLambda,
        dt,
      );
    } else {
      this.leftHandBlender.snap(
        this._lDesiredRoot,
        isUnarmed ? this.leftHandBlender.quaternion : this._lDesiredQuatRoot,
        leftGripCurl,
        1,
      );
    }

    this._lTargetRoot.copy(this.leftHandBlender.position);
    this._lQuatRoot.copy(this.leftHandBlender.quaternion);

    // 4. Solve Left Arm 2-Bone IK + Forearm-Aligned Zero-Hyperextension Wrist Orientation
    solveTwoBoneIK(this._shoulderL, this._lTargetRoot, this._poleL, armL.upperLen, armL.lowerLen, this.leftArmIK);
    orientLimbAlongY(armL.upperArm, this._shoulderL, this.leftArmIK.midPos, this._poleL);
    if (isUnarmed) {
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
    armL.hand.root.position.copy(this.leftArmIK.endPos);
    armL.hand.root.quaternion.copy(this._lQuatRoot);
    armL.hand.root.updateMatrixWorld(true);

    // Sync physical detachable magazine mesh into/out of left hand during Reload & Mag-Check
    this.weaponRig.weaponAnimator.syncPhysicalMagazineParent(armL.hand.root);

    const leftHoldClass =
      vaultPinL > 0.2 || isUnarmed ? 'unarmed' : leftOverridden ? 'melee_1h' : spec.holdClass;
    const foregripPose =
      leftOverridden || vaultPinL > 0.2 || isUnarmed
        ? 'none'
        : (this.weaponRig.getModelAssembly()?.foregripPose ?? 'none');
    this.skeleton.applyHandPose(
      'left',
      leftHoldClass,
      false,
      this.leftHandBlender.gripCurl,
      foregripPose,
    );
  }

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

    this._handAlignUp
      .crossVectors(forearmDir as THREE.Vector3, this._handAlignOut)
      .multiplyScalar(-side)
      .normalize();

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
    orientLimbAlongY(forearm, elbowPos, wristPos, this._forearmPoleTmp, 0);
  }
}

import * as THREE from 'three';
import {
  checkOverheadClearanceViaRaycast,
  computeSphereSweptLeanClearance,
} from '../../bodycam-sdk/BodycamPhysics';
import { VaultController, VaultStateSnapshot } from '../../bodycam-sdk/movement/VaultController';
import {
  createVaultCandidate,
  VaultBlockReason,
  VaultCandidate,
  VaultDetector,
} from '../../bodycam-sdk/movement/VaultDetector';
import {
  AdsMode,
  AimStance,
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamRecoilOptions,
  BodycamSurfaceMaterial,
  createCapsuleSweepResult,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { TRAUMA_LIMITS, TraumaModifiers } from '../../data/traumaConfig';
import { WEAPONS, WeaponId } from '../../data/weapons';
import { resolveWeaponProfile } from '../../bodycam-sdk/weaponProfiles';
import { AudioEngine } from '../audio/AudioEngine';
import { AcousticSystem } from '../stealth/AcousticSystem';
import { TunerSettings } from '../types';
import { WeaponRig } from '../weapons/WeaponRig';
import { BuiltWorld } from '../world/WorldBuilder';

export interface PlayerInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  leanLeft: boolean;
  leanRight: boolean;
  ads: boolean;
  adsMode: AdsMode;
  cant: boolean;
  holdBreath: boolean;
  vault: boolean;
}

export interface BodycamSurvivalModifiers {
  encumbranceRatio: number;
  swayAmpMult: number;
  staminaDrainMult: number;
  exertionRateMult: number;
  moveSpeedMult: number;
  canSprint: boolean;
}

const STAND_EYE_HEIGHT = 1.42;
const CROUCH_EYE_HEIGHT = 0.92;
const STAND_CAPSULE_HEIGHT = 1.62;
const CROUCH_CAPSULE_HEIGHT = 1.06;
const CAMERA_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-82);
const CAMERA_MAX_PITCH_RAD = THREE.MathUtils.degToRad(80);
const SPINE_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-40);
const SPINE_MAX_PITCH_RAD = THREE.MathUtils.degToRad(55);
const WEAPON_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-50);
const WEAPON_MAX_PITCH_RAD = THREE.MathUtils.degToRad(68);
const COLLAR_OFFSET_X = 0.03;
const COLLAR_OFFSET_Z = 0.06;
const PITCH_BIAS_RAD = THREE.MathUtils.degToRad(2.0);
const PLAYER_RADIUS = 0.34;
const GRAVITY_MPS2 = 16.5;
const JUMP_VELOCITY_MPS = 4.65;
const JUMP_COYOTE_SEC = 0.095;
const JUMP_COOLDOWN_SEC = 0.32;
const AIR_ACCEL_LAMBDA = 2.6;
const BASE_HORIZONTAL_FOV_DEG = 98;
const ADS_HORIZONTAL_FOV_DEG = 82;
const SPRINT_HORIZONTAL_FOV_DEG = 102;
const LEAN_MAX_OFFSET_M = 0.26;
const LEAN_MAX_ROLL_DEG = 11.0;
const LEAN_CLEARANCE_RADIUS_M = 0.19;
const MAX_STEP_UP_M = 0.32;
const STEP_SMOOTH_SPEED = 11.5;
const GROUND_ACCEL = 14.0;
const GROUND_DECEL = 11.5;
const TWO_PI = Math.PI * 2;

const BREATH_SWAY_CONFIG = {
  // Exertion accumulation & decay (0..exertionMax)
  exertionMax: 1.0,
  exertionSprintRate: 0.42,
  exertionLandingGain: 0.18,
  exertionRecoilGain: 0.045,
  exertionWalkDecayRate: 0.085,
  exertionIdleDecayRate: 0.24,

  // Saturating falloff curve shape: (1 - e^-k*x) / (1 - e^-k)
  falloffShapeK: 2.8,

  // Breath rate coupling (Hz)
  baseFreqHz: 0.24,
  maxFreqHz: 0.92,
  freqSmoothingLambda: 2.2,

  // Combined sway amplitude coupling
  exertionAmpWeight: 1.35,
  staminaWeight: 0.85,
  healthWeight: 0.95,
  maxCombinedAmpMult: 2.65,
  ampSmoothingLambda: 2.6,
  recoveryEnvelopeLambda: 4.2,

  // Camera micro-oscillation baseline & hard bounds (sub-degree / sub-millimeter)
  camBaseRotPitchRad: 0.00185,
  camBaseRotYawRad: 0.00145,
  camBaseRotRollRad: 0.0012,
  camBasePosXMeters: 0.00030,
  camBasePosYMeters: 0.00052,
  camMaxRotRad: 0.0078,
  camMaxPosMeters: 0.00098,
  adsCamSwayScale: 0.55,

  // Weapon drift separation (lower frequency, offset phase, sub-millimeter)
  weaponDriftFreqRatio: 0.67,
  weaponBaseDriftXMeters: 0.00048,
  weaponBaseDriftYMeters: 0.00068,
  weaponMaxDriftMeters: 0.00098,
  adsWeaponDriftScale: 0.48,
} as const;

const SPRINT_EXHAUST_THRESHOLD = 0.05;
const SPRINT_RECOVERY_THRESHOLD = 0.20;
const HOLD_BREATH_MIN_STAMINA = 0.20;

function saturatingCurve(x: number, k: number): number {
  const clamped = THREE.MathUtils.clamp(x, 0, 1);
  if (k <= 0.001) return clamped;
  return (1 - Math.exp(-k * clamped)) / (1 - Math.exp(-k));
}

function horizontalToVerticalFov(hFovDeg: number, aspect: number): number {
  const hRad = THREE.MathUtils.degToRad(hFovDeg);
  const vRad = 2 * Math.atan(Math.tan(hRad * 0.5) / Math.max(0.5, aspect));
  return THREE.MathUtils.radToDeg(vRad);
}

/**
 * Survival BodycamController — 1:1 mechanical parity with the Calibration Gym SDK:
 *  - Capsule sliding + 0.32m stair/curb step-up with C1-continuous camera glide
 *  - Overhead crouch ceiling lock & sphere-swept lean clearance
 *  - Grounded tactical vaulting & mantling (1H vault/climb, 2H high mantle, window breach pre-crouch)
 *  - Realistic jumping, airborne jump headbob, smooth physics-to-camera landing knee-bend suspension
 *  - Exaggerated smooth walk/run headbob, tactical cant, hold-breath stabilization
 *  - Survival wake-up animation, trauma flinch, limb trauma, fall impact damage, and floating-origin sync
 */
export class BodycamController {
  public readonly position = new THREE.Vector3(-4.2, 0, 16.5);
  public torsoYaw = Math.PI * 0.08;
  public torsoPitch = 0;

  private targetTorsoYaw = Math.PI * 0.08;
  private targetTorsoPitch = 0;
  private torsoYawVel = 0;
  private torsoPitchVel = 0;

  // Zero-lag 1:1 free-aim angles
  private aimYaw = 0;
  private aimPitch = 0;

  // Subtle sympathetic chest camera recoil (~20% of weapon kick)
  private sympPitch = 0;
  private sympPitchVel = 0;
  private sympYaw = 0;
  private sympYawVel = 0;

  // High-frequency cheek-weld camera shake springs (amplified in ADS/Canted, calm in Hip-Fire)
  private camShakePitch = 0;
  private camShakePitchVel = 0;
  private camShakeYaw = 0;
  private camShakeYawVel = 0;
  private camShakeRoll = 0;
  private camShakeRollVel = 0;
  private camShakePosX = 0;
  private camShakePosXVel = 0;
  private camShakePosY = 0;
  private camShakePosYVel = 0;

  // Posture, momentum, step-up smoothing, gait & landing shock
  public crouched = false;
  public wantCrouch = false;
  public standBlockedByCeiling = false;
  public isSprinting = false;
  /** Latches true when stamina drops below 5% and clears only once stamina recovers to >= 20% */
  public sprintExhausted = false;
  /** Dedicated upper-body / arm aiming stamina (0..1); drains in any aim stance & slightly per shot */
  public armStamina = 1.0;
  public isAds = false;
  public isCanted = false;
  public isPointAim = false;
  public aimStance: AimStance = 'HIP';
  public armedAdsMode: AdsMode = 'PRIMARY';
  public grounded = true;

  private velX = 0;
  private velY = 0;
  private velZ = 0;
  private prevLocalStrafeVel = 0;
  private strafeDip = 0;
  private strafeDipVel = 0;

  private currentHeight = STAND_EYE_HEIGHT;
  private stepSmoothOffsetY = 0;
  private stepSmoothVelY = 0;
  private lastStepUpElapsed = -10;
  private currentLean = 0;
  private strafeRoll = 0;
  private currentSurface: BodycamSurfaceMaterial = 'concrete';
  private wasCrouched = false;
  private currentMoveSpeed = 0;

  private strideProgress = 0;
  private footSign = 1;
  private heelDrop = 0;
  private heelDropVel = 0;
  private heelRoll = 0;
  private heelRollVel = 0;
  private heelPitch = 0;
  private heelPitchVel = 0;

  // Exaggerated, silky-smooth continuous stride headbob (phase-locked to footsteps)
  private bobPhase = 0;
  private bobWeight = 0;
  private sprintBobBlend = 0;
  private crouchBobBlend = 0;
  private strideBobX = 0;
  private strideBobY = 0;
  private strideBobPitch = 0;
  private strideBobRoll = 0;

  // Realistic jumping, airborne jump headbob & smooth camera-interpolated landing suspension
  private prevVaultPressed = false;
  private coyoteTimer = 0;
  private jumpCooldownSec = 0;
  private airTimeSec = 0;
  private jumpInitiated = false;
  private peakFallSpeed = 0;
  private airBobBlend = 0;
  private jumpBobX = 0;
  private jumpBobY = 0;
  private jumpBobPitch = 0;
  private jumpBobRoll = 0;
  private takeoffHeave = 0;
  private takeoffHeaveVel = 0;
  private landingDipY = 0;
  private landingDipVel = 0;
  private landingPitch = 0;
  private landingPitchVel = 0;
  private landingRoll = 0;
  private landingRollVel = 0;
  private lastJumpBlockReason: 'none' | 'dual_leg_trauma' | 'overhead_blocked' = 'none';

  private kneeShock = 0;
  private kneeShockVel = 0;

  // Breathing sway & exertion state (zero per-frame allocations)
  private exertion = 0;
  private smoothedFreqHz: number = BREATH_SWAY_CONFIG.baseFreqHz;
  private smoothedAmpMult = 1.0;
  private swayEnvelope = 0;
  private breathPhase = 0;
  private weaponDriftPhase = 0;
  private holdBreathBlend = 0;
  private exhaustedBreathTimer = 0;
  private heartRateBpm = 74;
  private cardiacPhase = 0;
  private lastWeaponMassKg = 3.1;
  private lastBodyStamina = 1.0;
  private lastUpdateElapsed = -1;

  // Coupled upper-body / torso biomechanical recoil absorption springs
  private torsoAbsorbPitch = 0;
  private torsoAbsorbPitchVel = 0;
  private torsoAbsorbYaw = 0;
  private torsoAbsorbYawVel = 0;

  // Wake up groggy camera stand-up animation
  private wakeUpTimer = 0;
  private wakeUpDuration = 2.2;

  // Grounded tactical vault & mantle traversal override (zero-GC, shared SDK logic)
  private readonly vaultDetector = new VaultDetector();
  private readonly vaultController = new VaultController();
  private readonly _vaultCandidate: VaultCandidate = createVaultCandidate();
  private vaultCooldownSec = 0;
  private lastVaultBlockReason: VaultBlockReason = 'none';

  // Reusable zero-GC math temporaries
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpOrigin = new THREE.Vector3();
  private readonly _chestPos = new THREE.Vector3();
  private readonly _leanDir = new THREE.Vector3();
  private readonly _camQuat = new THREE.Quaternion();
  private readonly _aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _rigEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _weaponCamQuat = new THREE.Quaternion();
  private readonly _weaponCamEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _weaponCamPos = new THREE.Vector3();
  private readonly _sweepOut: BodycamCapsuleSweepResult = createCapsuleSweepResult();
  private readonly _interiorSample: BodycamInteriorSample = { isIndoor: false, material: 'outdoor' };
  private lastMinWeaponPitchRad = WEAPON_MIN_PITCH_RAD;
  private lastMaxWeaponPitchRad = WEAPON_MAX_PITCH_RAD;

  // Diegetic grenade wind-up tension & FOV focus
  private grenadeCharge01 = 0;
  private grenadeLiveCook = false;
  private grenadeThrowStyle: 'overhand' | 'underhand' = 'underhand';
  private grenadeStrainRoll = 0;

  private camera: THREE.PerspectiveCamera;
  private weaponRig: WeaponRig;
  private audio: AudioEngine;
  private acoustic: AcousticSystem;

  constructor(
    camera: THREE.PerspectiveCamera,
    weaponRig: WeaponRig,
    audio: AudioEngine,
    acoustic: AcousticSystem,
  ) {
    this.camera = camera;
    this.weaponRig = weaponRig;
    this.audio = audio;
    this.acoustic = acoustic;
  }

  public isVaulting(): boolean {
    return this.vaultController.isActive();
  }

  public getVaultState(): Readonly<VaultStateSnapshot> {
    return this.vaultController.getReadOnlyState();
  }

  public consumeVaultBlockReason(): VaultBlockReason {
    const r = this.lastVaultBlockReason;
    this.lastVaultBlockReason = 'none';
    return r;
  }

  public consumeJumpBlockReason(): 'none' | 'dual_leg_trauma' | 'overhead_blocked' {
    const r = this.lastJumpBlockReason;
    this.lastJumpBlockReason = 'none';
    return r;
  }

  public toggleCrouch(): void {
    this.wantCrouch = !this.wantCrouch;
  }

  public getStepSmoothOffsetY(): number {
    return this.stepSmoothOffsetY;
  }

  public getVerticalVelocity(): number {
    return this.velY;
  }

  public getLandingCompression(): number {
    return this.landingDipY + this.kneeShock;
  }

  public getLandingKneeBend(): number {
    return THREE.MathUtils.clamp(-(this.landingDipY + this.kneeShock) / 0.24, 0, 1.35);
  }

  public setGrenadeTension(
    charge01: number,
    liveCook = false,
    throwStyle: 'overhand' | 'underhand' = 'overhand',
  ): void {
    this.grenadeCharge01 = THREE.MathUtils.clamp(charge01, 0, 1);
    this.grenadeLiveCook = liveCook;
    this.grenadeThrowStyle = throwStyle;
  }

  public getVelocity(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.velX, this.velY, this.velZ);
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /** Shifts only active vault waypoints during Survival floating-origin rebasing (position is shifted by WorldBuilder) */
  public shiftVaultOrigin(dx: number, dz: number): void {
    this.vaultController.shiftOrigin(dx, dz);
  }

  public startWakeUpAnimation(): void {
    this.vaultController.abort();
    this.wakeUpTimer = this.wakeUpDuration;
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.torsoYawVel = 0;
    this.torsoPitchVel = 0;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.grounded = true;
    this.stepSmoothOffsetY = 0;
    this.stepSmoothVelY = 0;
    this.resetMotionSprings();
    this.resetBreathingToRest();
  }

  public snapStanding(): void {
    this.vaultController.abort();
    this.wakeUpTimer = 0;
    this.wantCrouch = this.crouched;
    this.wasCrouched = this.crouched;
    this.standBlockedByCeiling = false;
    this.currentHeight = this.crouched ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT;
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.grounded = true;
    this.currentMoveSpeed = 0;
    this.stepSmoothOffsetY = 0;
    this.stepSmoothVelY = 0;
    this.resetMotionSprings();
    this.resetBreathingToRest();
  }

  private resetMotionSprings(): void {
    this.isSprinting = false;
    this.sprintExhausted = false;
    this.armStamina = 1.0;
    this.exhaustedBreathTimer = 0;
    this.vaultCooldownSec = 0;
    this.lastVaultBlockReason = 'none';
    this.lastJumpBlockReason = 'none';
    this.kneeShock = 0;
    this.kneeShockVel = 0;
    this.landingDipY = 0;
    this.landingDipVel = 0;
    this.landingPitch = 0;
    this.landingPitchVel = 0;
    this.landingRoll = 0;
    this.landingRollVel = 0;
    this.takeoffHeave = 0;
    this.takeoffHeaveVel = 0;
    this.bobPhase = 0;
    this.strideProgress = 0;
    this.bobWeight = 0;
    this.sprintBobBlend = 0;
    this.crouchBobBlend = 0;
    this.strideBobX = 0;
    this.strideBobY = 0;
    this.strideBobPitch = 0;
    this.strideBobRoll = 0;
    this.airBobBlend = 0;
    this.jumpBobX = 0;
    this.jumpBobY = 0;
    this.jumpBobPitch = 0;
    this.jumpBobRoll = 0;
    this.airTimeSec = 0;
    this.coyoteTimer = 0;
    this.jumpCooldownSec = 0;
    this.jumpInitiated = false;
    this.peakFallSpeed = 0;
    this.prevVaultPressed = false;
    this.strafeDip = 0;
    this.strafeDipVel = 0;
    this.torsoAbsorbPitch = 0;
    this.torsoAbsorbPitchVel = 0;
    this.torsoAbsorbYaw = 0;
    this.torsoAbsorbYawVel = 0;
    this.sympPitch = 0;
    this.sympPitchVel = 0;
    this.sympYaw = 0;
    this.sympYawVel = 0;
    this.camShakePitch = 0;
    this.camShakePitchVel = 0;
    this.camShakeYaw = 0;
    this.camShakeYawVel = 0;
    this.camShakeRoll = 0;
    this.camShakeRollVel = 0;
    this.camShakePosX = 0;
    this.camShakePosXVel = 0;
    this.camShakePosY = 0;
    this.camShakePosYVel = 0;
  }

  public applyTraumaFlinch(pitchRad: number, yawRad: number): void {
    this.sympPitchVel += pitchRad * 26;
    this.sympYawVel += yawRad * 22;
    const weaponRootPitch = this.getWeaponRootPitch();
    const minAim = Math.max(-0.22, this.lastMinWeaponPitchRad - weaponRootPitch);
    const maxAim = Math.min(0.24, this.lastMaxWeaponPitchRad - weaponRootPitch);
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch + pitchRad * 0.35, minAim, maxAim);
    this.aimYaw = THREE.MathUtils.clamp(this.aimYaw + yawRad * 0.35, -0.22, 0.22);
    this.weaponRig.applyWeaponRecoil(pitchRad * 1.15, yawRad * 0.9, 0.012, {
      stanceCoupled: false,
    });
  }

  public addExertionImpulse(amount: number): void {
    if (amount <= 0) return;
    this.exertion = Math.min(BREATH_SWAY_CONFIG.exertionMax, this.exertion + amount);
  }

  private resetBreathingToRest(): void {
    this.exertion = 0;
    this.smoothedFreqHz = BREATH_SWAY_CONFIG.baseFreqHz;
    this.smoothedAmpMult = 1.0;
    this.swayEnvelope = 0;
    this.breathPhase = 0;
    this.weaponDriftPhase = 0;
    this.holdBreathBlend = 0;
    this.lastUpdateElapsed = -1;
  }

  public setHeartRateBpm(bpm: number): void {
    this.heartRateBpm = THREE.MathUtils.clamp(bpm, 55, 195);
  }

  public getHeartRateBpm(): number {
    return this.heartRateBpm;
  }

  public getArmStamina(): number {
    return this.armStamina;
  }

  public isSprintExhausted(): boolean {
    return this.sprintExhausted;
  }

  public setAngles(yaw: number, pitch: number): void {
    const clampedPitch = THREE.MathUtils.clamp(pitch, CAMERA_MIN_PITCH_RAD, CAMERA_MAX_PITCH_RAD);
    this.torsoYaw = yaw;
    this.targetTorsoYaw = yaw;
    this.torsoPitch = clampedPitch;
    this.targetTorsoPitch = clampedPitch;
    this.torsoYawVel = 0;
    this.torsoPitchVel = 0;
    this.aimYaw = 0;
    this.aimPitch = 0;
  }

  /** Upper-torso thoracic spine bend pitch clamped to human anatomical limits [-40°, +55°]. */
  public getSpinePitch(): number {
    return THREE.MathUtils.clamp(this.torsoPitch, SPINE_MIN_PITCH_RAD, SPINE_MAX_PITCH_RAD);
  }

  /** Weapon-root pitch clamped to biomechanical resting limits (e.g. [-50°, +68°]). */
  public getWeaponRootPitch(): number {
    return THREE.MathUtils.clamp(
      this.torsoPitch,
      this.lastMinWeaponPitchRad,
      this.lastMaxWeaponPitchRad,
    );
  }

  /** Effective free-aim pitch clamped so total weapon & arm pitch never exceeds physical resting stops. */
  public getClampedAimPitch(): number {
    const weaponRootPitch = this.getWeaponRootPitch();
    const minAim = this.lastMinWeaponPitchRad - weaponRootPitch;
    const maxAim = this.lastMaxWeaponPitchRad - weaponRootPitch;
    return THREE.MathUtils.clamp(this.aimPitch, minAim, maxAim);
  }

  public handleMouseMove(dx: number, dy: number, settings: TunerSettings): void {
    const sens = this.isAds
      ? 0.00095
      : this.isCanted
        ? 0.00108
        : this.isPointAim
          ? 0.00120
          : 0.00145;

    // Tighter stance elliptical deadzones for unified Bodycam free-aim lead across all aim modes:
    // Primary ADS ±2.4°/±2.0° (±1.8°/±1.5° magnified PiP scope), Canted ADS ±3.4°/±2.8°, Point Aim ±5.2°/±4.2°
    const magScope = this.isAds && this.weaponRig.isMagnifiedOpticActive();
    const yawDeg = this.isAds
      ? magScope
        ? 1.8
        : 2.4
      : this.isCanted
        ? 3.4
        : this.isPointAim
          ? 5.2
          : settings.deadzoneYawDeg;
    const pitchDeg = this.isAds
      ? magScope
        ? 1.5
        : 2.0
      : this.isCanted
        ? 2.8
        : this.isPointAim
          ? 4.2
          : settings.deadzonePitchDeg;
    const maxYaw = Math.max(0.01, THREE.MathUtils.degToRad(yawDeg));
    const maxPitch = Math.max(0.01, THREE.MathUtils.degToRad(pitchDeg));

    const minWepRad = THREE.MathUtils.degToRad(settings.minWeaponPitchDeg ?? -50);
    const maxWepRad = THREE.MathUtils.degToRad(settings.maxWeaponPitchDeg ?? 68);
    this.lastMinWeaponPitchRad = minWepRad;
    this.lastMaxWeaponPitchRad = maxWepRad;

    const prevTorsoPitch = this.targetTorsoPitch;
    const prevClampedTorso = THREE.MathUtils.clamp(prevTorsoPitch, minWepRad, maxWepRad);
    const prevWeaponPitch = prevClampedTorso + this.aimPitch;
    const deltaPitch = -dy * sens;

    // Zero-lag 1:1 linear mouse delta applied directly to free-aim angles
    const rawYaw = this.aimYaw - dx * sens;
    const rawPitch = this.aimPitch + deltaPitch;

    // Elliptical deadzone boundary clamp + excess transfer to torso
    const nx = rawYaw / maxYaw;
    const ny = rawPitch / maxPitch;
    const ellipseNorm = Math.hypot(nx, ny);

    if (ellipseNorm > 1.0) {
      const clampedYaw = (nx / ellipseNorm) * maxYaw;
      const clampedPitch = (ny / ellipseNorm) * maxPitch;
      this.targetTorsoYaw += rawYaw - clampedYaw;
      this.targetTorsoPitch += rawPitch - clampedPitch;
      this.aimYaw = clampedYaw;
      this.aimPitch = clampedPitch;
    } else {
      this.aimYaw = rawYaw;
      this.aimPitch = rawPitch;
    }

    // Decoupled biomechanical clamp: keep weapon+arm pitch within [minWepRad, maxWepRad]
    // and route any blocked vertical aim delta 1:1 to chest-cam look pitch [-82°, +80°].
    let clampedTorsoForWeapon = THREE.MathUtils.clamp(this.targetTorsoPitch, minWepRad, maxWepRad);
    let minAimForStop = minWepRad - clampedTorsoForWeapon;
    let maxAimForStop = maxWepRad - clampedTorsoForWeapon;
    if (this.aimPitch < minAimForStop) {
      if (dy > 0) {
        const postStopOverflow = Math.max(deltaPitch, prevWeaponPitch + deltaPitch - minWepRad);
        if (postStopOverflow < 0) {
          this.targetTorsoPitch = Math.min(
            this.targetTorsoPitch,
            prevTorsoPitch + postStopOverflow,
          );
          clampedTorsoForWeapon = THREE.MathUtils.clamp(
            this.targetTorsoPitch,
            minWepRad,
            maxWepRad,
          );
          minAimForStop = minWepRad - clampedTorsoForWeapon;
        }
      }
      this.aimPitch = minAimForStop;
    } else if (this.aimPitch > maxAimForStop) {
      if (dy < 0) {
        const postStopOverflow = Math.min(deltaPitch, prevWeaponPitch + deltaPitch - maxWepRad);
        if (postStopOverflow > 0) {
          this.targetTorsoPitch = Math.max(
            this.targetTorsoPitch,
            prevTorsoPitch + postStopOverflow,
          );
          clampedTorsoForWeapon = THREE.MathUtils.clamp(
            this.targetTorsoPitch,
            minWepRad,
            maxWepRad,
          );
          maxAimForStop = maxWepRad - clampedTorsoForWeapon;
        }
      }
      this.aimPitch = maxAimForStop;
    }

    this.targetTorsoPitch = THREE.MathUtils.clamp(
      this.targetTorsoPitch,
      CAMERA_MIN_PITCH_RAD,
      CAMERA_MAX_PITCH_RAD,
    );

    const nextClampedTorso = THREE.MathUtils.clamp(this.targetTorsoPitch, minWepRad, maxWepRad);
    const nextWeaponPitch = nextClampedTorso + this.aimPitch;
    const weaponPitchFraction =
      Math.abs(deltaPitch) > 1e-6
        ? THREE.MathUtils.clamp((nextWeaponPitch - prevWeaponPitch) / deltaPitch, 0, 1)
        : 1;

    // Subtle trailing roll/weight inertia (suppressed vertically when weapon is resting at pitch stop)
    this.weaponRig.addInertia(dx * 0.00018, dy * 0.00014 * weaponPitchFraction);
  }

  /** Biomechanical cheek-weld coupling factor: ADS=1.0, Canted=0.92, Point Aim=0.50, Hip=0.0 */
  public getCheekWeldFactor(): number {
    if (this.isAds) return 1.0;
    if (this.isCanted) return 0.92;
    if (this.isPointAim) return 0.5;
    return 0.0;
  }

  public applyRecoil(
    pitchRad: number,
    yawRad: number,
    kickBackM: number,
    options?: BodycamRecoilOptions,
  ): void {
    const yawJitter = (Math.random() - 0.5) * 2 * yawRad;
    const stanceCoupled = options?.stanceCoupled !== false;
    const cheekWeld = stanceCoupled ? this.getCheekWeldFactor() : 0.5;
    const adsCamScale = THREE.MathUtils.clamp(options?.adsCameraShakeScale ?? 1.0, 0, 2.0);
    const hipSwayScale = THREE.MathUtils.clamp(options?.hipRecoilSwayScale ?? 1.0, 0, 2.0);
    const magScopeAtten =
      stanceCoupled && this.isAds && this.weaponRig.isMagnifiedOpticActive() ? 0.68 : 1.0;

    // 1. Weapon & IK-locked arm recoil channel (tighter in ADS, biomechanically absorbed in Hip-Fire,
    //    and stabilized by hold-breath mitigation while reserve lasts)
    this.weaponRig.applyWeaponRecoil(pitchRad * 1.45, yawJitter * 1.1, kickBackM, {
      cheekWeld,
      hipRecoilSwayScale: hipSwayScale,
      stanceCoupled,
      rawYawRad: yawRad,
      holdBreathBlend: this.holdBreathBlend,
    });

    if (stanceCoupled) {
      // 2. Camera / cheek-weld channel:
      //    Hip-Fire: calm, steady horizon (~0.25x mild sympathetic jolt, negligible roll)
      //    Point Aim: 50% balanced punch
      //    Canted ADS (0.92) & Primary ADS (1.00): crisp cheek-weld pitch/yaw/roll snap + micro-translation
      const climbBreathScale = THREE.MathUtils.lerp(1.0, 0.70, this.holdBreathBlend);
      const driftBreathScale = THREE.MathUtils.lerp(1.0, 0.25, this.holdBreathBlend);
      const camShakeGain = cheekWeld * magScopeAtten * adsCamScale;
      const sympGain =
        THREE.MathUtils.lerp(0.25, 0.68, cheekWeld) *
        magScopeAtten *
        THREE.MathUtils.lerp(1.0, adsCamScale, cheekWeld * 0.75);

      this.sympPitchVel += pitchRad * 0.22 * 24 * sympGain * climbBreathScale;
      this.sympYawVel += yawJitter * 0.2 * 20 * sympGain * driftBreathScale;

      // Coupled upper-body / torso biomechanical absorption of recoil torque & axial kick
      const absorbGain = THREE.MathUtils.lerp(1.0, 0.42, cheekWeld);
      this.torsoAbsorbPitchVel += (pitchRad * 2.2 + kickBackM * 1.6) * absorbGain * climbBreathScale;
      this.torsoAbsorbYawVel += yawJitter * 1.85 * absorbGain * driftBreathScale;

      if (camShakeGain > 0.001) {
        this.camShakePitchVel += pitchRad * 26.0 * camShakeGain * THREE.MathUtils.lerp(1.0, 0.82, this.holdBreathBlend);
        this.camShakeYawVel +=
          (yawJitter * 22.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 10.5) *
          camShakeGain *
          THREE.MathUtils.lerp(1.0, 0.65, this.holdBreathBlend);
        this.camShakeRollVel +=
          (yawJitter * 16.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 14.0) * camShakeGain;
        this.camShakePosXVel +=
          ((Math.random() - 0.5) * 0.16 + yawJitter * 2.4) * camShakeGain;
        this.camShakePosYVel +=
          (kickBackM * 4.8 + Math.abs(pitchRad) * 2.2) * camShakeGain;
      }

      // Free-aim climb: looser upward climb in Hip-Fire, tighter shoulder-braced climb in ADS (~30% mitigated while holding breath)
      const freeAimClimbScale = THREE.MathUtils.lerp(1.12, 0.68, cheekWeld) * climbBreathScale;
      const maxAimForStop = this.lastMaxWeaponPitchRad - this.getWeaponRootPitch();
      this.aimPitch = Math.min(
        0.24,
        maxAimForStop,
        this.aimPitch + pitchRad * 0.22 * freeAimClimbScale,
      );
    } else {
      // Non-firearm physical shock (melee strikes, blast waves, fall impact, zombie hits):
      // always deliver authentic full camera shock regardless of aim stance
      this.sympPitchVel += pitchRad * 0.22 * 24;
      this.sympYawVel += yawJitter * 0.2 * 20;
      this.camShakePitchVel += pitchRad * 16.0;
      this.camShakeYawVel += yawJitter * 14.0;
      this.camShakeRollVel +=
        yawJitter * 12.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 10.0;

      const maxAimForStop = this.lastMaxWeaponPitchRad - this.getWeaponRootPitch();
      this.aimPitch = Math.min(0.24, maxAimForStop, this.aimPitch + pitchRad * 0.22);
    }

    // Heavy action exertion bump & per-shot arm stamina fatigue
    this.exertion = Math.min(
      BREATH_SWAY_CONFIG.exertionMax,
      this.exertion + BREATH_SWAY_CONFIG.exertionRecoilGain,
    );
    if (stanceCoupled) {
      const massScale = THREE.MathUtils.clamp(this.lastWeaponMassKg / 3.2, 0.45, 2.25);
      const shotEnergy = THREE.MathUtils.clamp(
        (Math.abs(pitchRad) / 0.032 + kickBackM / 0.022) * 0.5,
        0.45,
        2.3,
      );
      const bodyFatigue = 1.0 + (1 - this.lastBodyStamina) * 0.72 + (this.sprintExhausted ? 0.25 : 0);
      const aimFactor = this.isAds || this.isCanted || this.isPointAim ? 1.0 : 0.42;
      this.armStamina = Math.max(
        0,
        this.armStamina - 0.015 * shotEnergy * massScale * bodyFatigue * aimFactor,
      );
    }
  }

  private stepCriticallyDamped(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dt: number,
  ): [number, number] {
    const stiffness = omega * omega;
    const damping = 2.0 * omega;
    const accel = stiffness * (target - val) - damping * vel;
    const nextVel = vel + accel * dt;
    const nextVal = val + nextVel * dt;
    return [nextVal, nextVel];
  }

  private stepDampedSpring(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dampingRatio: number,
    dt: number,
  ): [number, number] {
    const stiffness = omega * omega;
    const damping = 2.0 * dampingRatio * omega;
    const accel = stiffness * (target - val) - damping * vel;
    const nextVel = vel + accel * dt;
    const nextVal = val + nextVel * dt;
    return [nextVal, nextVel];
  }

  private stepExactCriticallyDamped(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dt: number,
  ): [number, number] {
    const x0 = val - target;
    const exp = Math.exp(-omega * dt);
    const c2 = vel + omega * x0;
    const nextVal = target + (x0 + c2 * dt) * exp;
    const nextVel = (vel - c2 * omega * dt) * exp;
    return [nextVal, nextVel];
  }

  public update(
    delta: number,
    elapsed: number,
    input: PlayerInputState,
    world: BuiltWorld,
    adapter: IBodycamWorldAdapter,
    equippedWeapon: WeaponId,
    settings: TunerSettings,
    stamina: number,
    health: number,
    onStaminaDrain: (amount: number) => void,
    trauma?: Readonly<TraumaModifiers>,
    onFallImpact?: (dropMeters: number) => void,
    survivalMods?: Readonly<BodycamSurvivalModifiers>,
  ): void {
    const dt = Math.min(delta, 0.05);
    const wSpec = WEAPONS[equippedWeapon];
    const isFirearm =
      wSpec.holdClass === 'pistol' || wSpec.holdClass === 'rifle' || wSpec.holdClass === 'shotgun';

    // Wake-up animation decay
    let wakeLift = 1;
    let wakeRoll = 0;
    let wakePitchOffset = 0;
    if (this.wakeUpTimer > 0) {
      this.wakeUpTimer = Math.max(0, this.wakeUpTimer - dt);
      const p = 1 - this.wakeUpTimer / this.wakeUpDuration;
      const smooth = p * p * (3 - 2 * p);
      wakeLift = smooth;
      wakeRoll = (1 - smooth) * 0.44;
      wakePitchOffset = (1 - smooth) * -0.38;
    }

    if (this.vaultCooldownSec > 0) {
      this.vaultCooldownSec = Math.max(0, this.vaultCooldownSec - dt);
    }
    if (this.jumpCooldownSec > 0) {
      this.jumpCooldownSec = Math.max(0, this.jumpCooldownSec - dt);
    }
    if (this.grounded) {
      this.coyoteTimer = JUMP_COYOTE_SEC;
    } else if (this.coyoteTimer > 0) {
      this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    }

    const spaceEdge = input.vault && !this.prevVaultPressed;
    this.prevVaultPressed = input.vault;

    // 0. Grounded Tactical Vault / Mantle Trigger (Space while moving forward or airborne near a ledge)
    let triggeredVaultThisFrame = false;
    if (
      this.wakeUpTimer <= 0.1 &&
      !this.vaultController.isActive() &&
      this.vaultCooldownSec <= 0 &&
      input.vault &&
      (input.forward || !this.grounded)
    ) {
      const found = this.vaultDetector.detect(
        adapter,
        this.position,
        this.torsoYaw,
        this.grounded,
        this._vaultCandidate,
        trauma,
      );
      if (found) {
        this.vaultController.start(this._vaultCandidate, trauma, survivalMods, this.crouched);
        if (this._vaultCandidate.isWindowBreach && !this.crouched) {
          this.audio.playGearRattle('crouch', 0.65);
        }
        this.velX = 0;
        this.velY = 0;
        this.velZ = 0;
        this.stepSmoothOffsetY = 0;
        this.stepSmoothVelY = 0;
        this.airTimeSec = 0;
        this.jumpInitiated = false;
        this.peakFallSpeed = 0;
        this.isSprinting = false;
        this.isAds = false;
        this.isCanted = false;
        this.isPointAim = false;
        this.aimStance = 'HIP';
        this.lastVaultBlockReason = 'none';
        triggeredVaultThisFrame = true;
      } else if (this._vaultCandidate.blockReason === 'dual_leg_trauma') {
        this.lastVaultBlockReason = 'dual_leg_trauma';
      }
    }

    const vaulting = this.vaultController.isActive();

    // 1. Overhead clearance lock (prevents standing up inside low crawlspaces/overhangs)
    const desiredCrouch = this.wantCrouch || input.crouch;
    if (vaulting) {
      this.standBlockedByCeiling = false;
    } else if (!desiredCrouch && this.crouched) {
      const hasHeadroom = adapter.hasOverheadClearance
        ? adapter.hasOverheadClearance(
            this.position.x,
            this.position.y,
            this.position.z,
            PLAYER_RADIUS,
            CROUCH_CAPSULE_HEIGHT,
            STAND_CAPSULE_HEIGHT,
          )
        : checkOverheadClearanceViaRaycast(
            adapter,
            this.position.x,
            this.position.y,
            this.position.z,
            PLAYER_RADIUS,
            CROUCH_CAPSULE_HEIGHT,
            STAND_CAPSULE_HEIGHT,
          );
      this.standBlockedByCeiling = !hasHeadroom;
      this.crouched = !hasHeadroom;
    } else {
      this.standBlockedByCeiling = false;
      this.crouched = desiredCrouch;
    }

    if (this.crouched !== this.wasCrouched) {
      this.audio.playGearRattle('crouch', 0.85);
      this.wasCrouched = this.crouched;
    }

    // 2. Decoupled Aim Action (RMB) + Armed Aim Mode (PRIMARY | CANTED | POINT_AIM)
    // Toggling MMB or B never lifts the firearm on its own; RMB released ALWAYS returns to HIP.
    const canAimWeapon = isFirearm && !vaulting && this.wakeUpTimer <= 0;
    const hasCantedOptic = this.weaponRig.hasCantedOptic();
    const requestedMode: AdsMode = input.adsMode ?? 'PRIMARY';
    this.armedAdsMode = requestedMode === 'CANTED' && !hasCantedOptic ? 'PRIMARY' : requestedMode;

    // Aiming always takes precedence over sprinting so holding Shift while aiming engages Hold Breath instead of breaking ADS
    const isAiming = input.ads && canAimWeapon;
    if (!isAiming) {
      this.aimStance = 'HIP';
    } else if (this.armedAdsMode === 'POINT_AIM') {
      this.aimStance = 'POINT_AIM';
    } else if (this.armedAdsMode === 'CANTED' && hasCantedOptic) {
      this.aimStance = 'CANTED_ADS';
    } else {
      this.aimStance = 'ADS';
    }

    this.isAds = this.aimStance === 'ADS';
    this.isCanted = this.aimStance === 'CANTED_ADS';
    this.isPointAim = this.aimStance === 'POINT_AIM';

    // Preserve subtle glance freedom (±42° around vault heading) while climbing
    if (vaulting) {
      const heading = this.vaultController.getVaultHeadingYaw();
      let relYaw = this.targetTorsoYaw - heading;
      while (relYaw > Math.PI) relYaw -= TWO_PI;
      while (relYaw < -Math.PI) relYaw += TWO_PI;
      const maxGlanceRad = THREE.MathUtils.degToRad(42);
      const clampedRel = THREE.MathUtils.clamp(relYaw, -maxGlanceRad, maxGlanceRad);
      this.targetTorsoYaw = heading + clampedRel;
      this.targetTorsoPitch = THREE.MathUtils.clamp(this.targetTorsoPitch, -0.78, 0.72);
    }

    // 3. Critically damped chest torso spring + World-Aim-Preserving Lagged Bodycam Recenter
    // In Hipfire, the chest camera only follows boundary overflow (unchanged).
    // In Primary ADS, Canted Optic ADS, and Point Aim, the weapon leads 1:1 on mouse movement while
    // the chest-mounted camera smoothly lags behind and recenters onto `goal = targetTorso + aimLead`,
    // subtracting the exact torso step from `aimLead` so the world sightline NEVER drifts off target.
    const aimingNow = this.isAds || this.isCanted || this.isPointAim;
    const magScope = this.isAds && this.weaponRig.isMagnifiedOpticActive();
    const omega =
      settings.torsoFollowStiffness *
      (this.isAds ? (magScope ? 1.48 : 1.35) : this.isCanted ? 1.15 : this.isPointAim ? 0.92 : 1.0);

    if (aimingNow) {
      const goalYaw = this.targetTorsoYaw + this.aimYaw;
      const goalPitch = THREE.MathUtils.clamp(
        this.targetTorsoPitch + this.aimPitch,
        CAMERA_MIN_PITCH_RAD,
        CAMERA_MAX_PITCH_RAD,
      );

      [this.torsoYaw, this.torsoYawVel] = this.stepCriticallyDamped(
        this.torsoYaw,
        this.torsoYawVel,
        goalYaw,
        omega,
        dt,
      );
      [this.torsoPitch, this.torsoPitchVel] = this.stepCriticallyDamped(
        this.torsoPitch,
        this.torsoPitchVel,
        goalPitch,
        omega,
        dt,
      );

      const stanceMaxYaw = THREE.MathUtils.degToRad(
        this.isAds ? (magScope ? 1.8 : 2.4) : this.isCanted ? 3.4 : 5.2,
      );
      const stanceMaxPitch = THREE.MathUtils.degToRad(
        this.isAds ? (magScope ? 1.5 : 2.0) : this.isCanted ? 2.8 : 4.2,
      );
      // Avoid a 1-frame snap when entering ADS from a wide off-center hipfire angle
      const envYaw = Math.max(stanceMaxYaw, Math.abs(this.aimYaw));
      const envPitch = Math.max(stanceMaxPitch, Math.abs(this.aimPitch));

      let remYaw = goalYaw - this.torsoYaw;
      let remPitch = goalPitch - this.torsoPitch;
      const nx = remYaw / envYaw;
      const ny = remPitch / envPitch;
      const eNorm = Math.hypot(nx, ny);
      if (eNorm > 1.0) {
        remYaw = (nx / eNorm) * envYaw;
        remPitch = (ny / eNorm) * envPitch;
      }

      this.aimYaw = remYaw;
      this.aimPitch = remPitch;
      this.targetTorsoYaw = goalYaw - remYaw;
      this.targetTorsoPitch = THREE.MathUtils.clamp(
        goalPitch - remPitch,
        CAMERA_MIN_PITCH_RAD,
        CAMERA_MAX_PITCH_RAD,
      );
    } else {
      [this.torsoYaw, this.torsoYawVel] = this.stepCriticallyDamped(
        this.torsoYaw,
        this.torsoYawVel,
        this.targetTorsoYaw,
        omega,
        dt,
      );
      [this.torsoPitch, this.torsoPitchVel] = this.stepCriticallyDamped(
        this.torsoPitch,
        this.torsoPitchVel,
        this.targetTorsoPitch,
        omega,
        dt,
      );
    }

    // Sympathetic chest camera recoil spring
    [this.sympPitch, this.sympPitchVel] = this.stepCriticallyDamped(this.sympPitch, this.sympPitchVel, 0, 14, dt);
    [this.sympYaw, this.sympYawVel] = this.stepCriticallyDamped(this.sympYaw, this.sympYawVel, 0, 14, dt);

    // Fast, crisp cheek-weld camera shake springs (slightly underdamped for tactile settle)
    [this.camShakePitch, this.camShakePitchVel] = this.stepDampedSpring(
      this.camShakePitch,
      this.camShakePitchVel,
      0,
      28,
      0.72,
      dt,
    );
    this.camShakePitch = THREE.MathUtils.clamp(this.camShakePitch, -0.08, 0.08);
    [this.camShakeYaw, this.camShakeYawVel] = this.stepDampedSpring(
      this.camShakeYaw,
      this.camShakeYawVel,
      0,
      30,
      0.68,
      dt,
    );
    this.camShakeYaw = THREE.MathUtils.clamp(this.camShakeYaw, -0.06, 0.06);
    [this.camShakeRoll, this.camShakeRollVel] = this.stepDampedSpring(
      this.camShakeRoll,
      this.camShakeRollVel,
      0,
      26,
      0.70,
      dt,
    );
    this.camShakeRoll = THREE.MathUtils.clamp(this.camShakeRoll, -0.05, 0.05);
    [this.camShakePosX, this.camShakePosXVel] = this.stepDampedSpring(
      this.camShakePosX,
      this.camShakePosXVel,
      0,
      32,
      0.72,
      dt,
    );
    this.camShakePosX = THREE.MathUtils.clamp(this.camShakePosX, -0.012, 0.012);
    [this.camShakePosY, this.camShakePosYVel] = this.stepDampedSpring(
      this.camShakePosY,
      this.camShakePosYVel,
      0,
      32,
      0.72,
      dt,
    );
    this.camShakePosY = THREE.MathUtils.clamp(this.camShakePosY, -0.012, 0.012);

    const sinY = Math.sin(this.torsoYaw);
    const cosY = Math.cos(this.torsoYaw);

    let wantsSprint = false;
    let rawTargetSpeed = 3.05;
    let horizSpeed = 0;
    let isMoving = false;
    let localStrafeVel = 0;

    if (vaulting) {
      this.isSprinting = false;
      this.velX = 0;
      this.velY = 0;
      this.velZ = 0;
      this.currentMoveSpeed = 0;
      this.grounded = false;

      const vaultDone = this.vaultController.update(dt, this.position, adapter, this.audio);
      if (vaultDone.completed) {
        this.vaultCooldownSec = 0.28;
        if (vaultDone.mustCrouch) {
          this.wantCrouch = true;
          this.crouched = true;
          this.wasCrouched = true;
        } else {
          this.wantCrouch = false;
          this.crouched = false;
          this.wasCrouched = false;
        }
        const landCapsuleH = this.crouched ? CROUCH_CAPSULE_HEIGHT : STAND_CAPSULE_HEIGHT;
        adapter.sweepCapsule(
          this.position,
          0,
          -0.08,
          0,
          PLAYER_RADIUS,
          landCapsuleH,
          0.08,
          this._sweepOut,
        );
        this.position.set(this._sweepOut.posX, this._sweepOut.posY, this._sweepOut.posZ);
        this.grounded = true;
        this.velY = 0;

        // Touchdown knee-compression suspension & exertion bump
        const shockAmp = vaultDone.landingShockAmp;
        this.kneeShockVel -= shockAmp * 14;
        this.landingDipVel -= shockAmp * 11.5;
        this.landingPitchVel += vaultDone.heelPitchImpulse * 2.2;
        this.landingRollVel += this.footSign * shockAmp * 2.4;
        if (health > 0) {
          const exMult = survivalMods ? survivalMods.exertionRateMult : 1.0;
          this.exertion = Math.min(
            BREATH_SWAY_CONFIG.exertionMax,
            this.exertion + vaultDone.exertionGain * exMult,
          );
        }
      }

      [this.strafeDip, this.strafeDipVel] = this.stepCriticallyDamped(this.strafeDip, this.strafeDipVel, 0, 14, dt);
      [this.kneeShock, this.kneeShockVel] = this.stepCriticallyDamped(this.kneeShock, this.kneeShockVel, 0, 12, dt);
      [this.landingDipY, this.landingDipVel] = this.stepDampedSpring(this.landingDipY, this.landingDipVel, 0, 7.4, 0.88, dt);
      this.landingDipY = THREE.MathUtils.clamp(this.landingDipY, -0.42, 0.08);
      [this.landingPitch, this.landingPitchVel] = this.stepDampedSpring(this.landingPitch, this.landingPitchVel, 0, 8.8, 0.88, dt);
      [this.landingRoll, this.landingRollVel] = this.stepDampedSpring(this.landingRoll, this.landingRollVel, 0, 8.6, 0.88, dt);
      [this.takeoffHeave, this.takeoffHeaveVel] = this.stepCriticallyDamped(this.takeoffHeave, this.takeoffHeaveVel, 0, 13, dt);
    } else {
      // 4. Realistic Ground Momentum + Strafe Reversal Weight-Transfer Dip
      let moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let moveZ = (input.backward ? 1 : 0) - (input.forward ? 1 : 0);
      const hasMoveInput = (moveX !== 0 || moveZ !== 0) && this.wakeUpTimer <= 0.4;
      if (hasMoveInput) {
        const len = Math.hypot(moveX, moveZ);
        moveX /= len;
        moveZ /= len;
      }

      // Sprint exhaustion hysteresis: reaching below 5% stamina locks sprint until stamina >= 20%
      this.lastBodyStamina = stamina;
      const resolvedProf = resolveWeaponProfile(equippedWeapon);
      this.lastWeaponMassKg = Math.max(0.45, resolvedProf?.massKg ?? 3.1);
      if (stamina < SPRINT_EXHAUST_THRESHOLD) {
        if (!this.sprintExhausted) {
          this.sprintExhausted = true;
          this.exhaustedBreathTimer = 0.06;
          this.audio.playBreathCue('exhale_depleted', 0.92);
        }
      } else if (this.sprintExhausted && stamina >= SPRINT_RECOVERY_THRESHOLD) {
        this.sprintExhausted = false;
      }

      const canSprintTrauma =
        (trauma ? trauma.canSprint : true) && (survivalMods ? survivalMods.canSprint : true);
      wantsSprint =
        canSprintTrauma &&
        !this.sprintExhausted &&
        input.sprint &&
        hasMoveInput &&
        !this.crouched &&
        !input.ads &&
        stamina >= SPRINT_EXHAUST_THRESHOLD &&
        moveZ < 0.2;
      this.isSprinting = wantsSprint;
      if (wantsSprint) {
        onStaminaDrain(0.22 * (survivalMods ? survivalMods.staminaDrainMult : 1.0) * dt);
      }

      const moveSpeedMult =
        (trauma ? trauma.moveSpeedMult : 1.0) * (survivalMods ? survivalMods.moveSpeedMult : 1.0);
      const moveAccelMult = trauma ? trauma.moveAccelMult : 1.0;
      rawTargetSpeed =
        (this.crouched
          ? 1.85
          : wantsSprint
            ? 4.85
            : this.isAds
              ? 2.15
              : this.isCanted
                ? 2.35
                : this.isPointAim
                  ? 2.70
                  : 3.05) * moveSpeedMult;

      const desiredVelX = hasMoveInput ? (moveX * cosY + moveZ * sinY) * rawTargetSpeed : 0;
      const desiredVelZ = hasMoveInput ? (-moveX * sinY + moveZ * cosY) * rawTargetSpeed : 0;

      const accelLambda = this.grounded
        ? (hasMoveInput ? GROUND_ACCEL : GROUND_DECEL) * moveAccelMult
        : hasMoveInput
          ? AIR_ACCEL_LAMBDA
          : 0.45;
      this.velX = THREE.MathUtils.damp(this.velX, desiredVelX, accelLambda, dt);
      this.velZ = THREE.MathUtils.damp(this.velZ, desiredVelZ, accelLambda, dt);
      horizSpeed = Math.hypot(this.velX, this.velZ);
      this.currentMoveSpeed = horizSpeed;
      isMoving = horizSpeed > 0.14;

      // Strafe reversal weight-transfer dip
      localStrafeVel = this.velX * cosY - this.velZ * sinY;
      if (
        this.grounded &&
        hasMoveInput &&
        Math.abs(moveX) > 0.35 &&
        Math.abs(this.prevLocalStrafeVel) > 0.9 &&
        Math.sign(moveX) !== Math.sign(this.prevLocalStrafeVel)
      ) {
        const reversalEnergy = THREE.MathUtils.clamp(Math.abs(this.prevLocalStrafeVel) / 3.2, 0.35, 1.2);
        this.strafeDipVel -= 0.24 * reversalEnergy;
        this.heelRollVel += Math.sign(moveX) * 0.16 * reversalEnergy;
      }
      this.prevLocalStrafeVel = localStrafeVel;
      [this.strafeDip, this.strafeDipVel] = this.stepCriticallyDamped(this.strafeDip, this.strafeDipVel, 0, 14, dt);

      // 4b. Grounded Realistic Tactical Jump (Space edge when no vault candidate was triggered)
      if (
        this.wakeUpTimer <= 0.1 &&
        spaceEdge &&
        !triggeredVaultThisFrame &&
        this.jumpCooldownSec <= 0 &&
        (this.grounded || this.coyoteTimer > 0)
      ) {
        const dualLegBroken =
          trauma && trauma.leftLegImpairment >= 0.72 && trauma.rightLegImpairment >= 0.72;
        if (dualLegBroken) {
          this.lastJumpBlockReason = 'dual_leg_trauma';
        } else {
          const curCapH = this.crouched ? CROUCH_CAPSULE_HEIGHT : STAND_CAPSULE_HEIGHT;
          const hasJumpHeadroom = adapter.hasOverheadClearance
            ? adapter.hasOverheadClearance(
                this.position.x,
                this.position.y,
                this.position.z,
                PLAYER_RADIUS,
                curCapH,
                curCapH + 0.42,
              )
            : checkOverheadClearanceViaRaycast(
                adapter,
                this.position.x,
                this.position.y,
                this.position.z,
                PLAYER_RADIUS,
                curCapH,
                curCapH + 0.42,
              );

          if (!hasJumpHeadroom) {
            this.lastJumpBlockReason = 'overhead_blocked';
          } else {
            const avgLegImpair = trauma
              ? (trauma.leftLegImpairment + trauma.rightLegImpairment) * 0.5
              : 0;
            const encumbrance = survivalMods
              ? THREE.MathUtils.clamp(survivalMods.encumbranceRatio, 0, 1)
              : 0;
            const jumpScale =
              (1 - avgLegImpair * 0.30) *
              (1 - encumbrance * 0.18) *
              (this.crouched ? 0.84 : 1.0);
            this.velY = JUMP_VELOCITY_MPS * Math.max(0.55, jumpScale);
            this.grounded = false;
            this.coyoteTimer = 0;
            this.jumpCooldownSec = JUMP_COOLDOWN_SEC;
            this.airTimeSec = 0;
            this.jumpInitiated = true;
            this.peakFallSpeed = 0;
            this.lastJumpBlockReason = 'none';

            if (hasMoveInput) {
              this.velX *= 1.04;
              this.velZ *= 1.04;
            }

            this.takeoffHeaveVel += 0.52;
            this.landingDipVel -= 0.22;

            onStaminaDrain(0.11 * (survivalMods ? survivalMods.staminaDrainMult : 1.0));
            if (health > 0) {
              const exMult = survivalMods ? survivalMods.exertionRateMult : 1.0;
              this.exertion = Math.min(
                BREATH_SWAY_CONFIG.exertionMax,
                this.exertion + 0.085 * exMult,
              );
            }
            this.audio.playBootScuff(this.currentSurface, 0.92);
            this.audio.playGearRattle('vault', 0.72);
            this.acoustic.emitNoise(this.position, 11, 'vault_low');
          }
        }
      }

      // 5. Capsule Sweep Collision with Automatic Stair/Curb Step-Up & Gravity
      const wasGrounded = this.grounded;
      const preVelY = this.velY;
      if (!this.grounded) {
        this.velY = Math.max(-22, this.velY - GRAVITY_MPS2 * dt);
        this.airTimeSec += dt;
        if (this.velY < 0) {
          this.peakFallSpeed = Math.max(this.peakFallSpeed, -this.velY);
        }
      } else {
        this.velY = -1.6;
      }

      const capsuleHeight = this.crouched ? CROUCH_CAPSULE_HEIGHT : STAND_CAPSULE_HEIGHT;
      adapter.sweepCapsule(
        this.position,
        this.velX * dt,
        this.velY * dt,
        this.velZ * dt,
        PLAYER_RADIUS,
        capsuleHeight,
        this.grounded ? MAX_STEP_UP_M : 0.06,
        this._sweepOut,
      );

      this.position.set(this._sweepOut.posX, this._sweepOut.posY, this._sweepOut.posZ);
      this.grounded = this._sweepOut.grounded;

      // Clean diagonal wall sliding
      if (this._sweepOut.hitWall) {
        const vn = this.velX * this._sweepOut.wallNormalX + this.velZ * this._sweepOut.wallNormalZ;
        if (vn < 0) {
          this.velX -= vn * this._sweepOut.wallNormalX;
          this.velZ -= vn * this._sweepOut.wallNormalZ;
        }
      }

      // C1-continuous critically damped vertical chest-cam glide on stair/curb step-up & step-down
      if (Math.abs(this._sweepOut.stepDeltaY) > 0.005) {
        const nextOffset = this.stepSmoothOffsetY - this._sweepOut.stepDeltaY;
        this.stepSmoothOffsetY = THREE.MathUtils.clamp(nextOffset, -0.55, 0.55);
        if (this._sweepOut.steppedUp && this._sweepOut.stepDeltaY > 0.005) {
          if (elapsed - this.lastStepUpElapsed > 0.38) {
            this.heelPitchVel -= Math.min(0.08, this._sweepOut.stepDeltaY * 0.25);
          }
          this.lastStepUpElapsed = elapsed;
        }
      }
      [this.stepSmoothOffsetY, this.stepSmoothVelY] = this.stepExactCriticallyDamped(
        this.stepSmoothOffsetY,
        this.stepSmoothVelY,
        0,
        STEP_SMOOTH_SPEED,
        dt,
      );
      if (Math.abs(this.stepSmoothOffsetY) < 1e-4 && Math.abs(this.stepSmoothVelY) < 1e-4) {
        this.stepSmoothOffsetY = 0;
        this.stepSmoothVelY = 0;
      }

      // Smooth physics-to-camera interpolated landing suspension + Survival fall trauma trigger
      if (this.grounded) {
        const impactSpeed = Math.max(Math.abs(preVelY), this.peakFallSpeed);
        if (!wasGrounded && (impactSpeed > 1.5 || this.airTimeSec > 0.14)) {
          const effImpact = Math.max(impactSpeed, 2.2);
          const impactNorm = THREE.MathUtils.clamp((effImpact - 1.1) / 5.8, 0.24, 1.45);

          // Weighty real-life knee-bend squat absorption + forward chest pitch + asymmetric boot roll
          this.landingDipVel -= impactNorm * 2.55;
          this.landingPitchVel -= impactNorm * 1.25;
          this.landingRollVel += this.footSign * impactNorm * 0.44;
          this.kneeShockVel -= impactNorm * 0.65;
          this.footSign *= -1;

          const surface = adapter.getSurfaceMaterial(this.position.x, this.position.y, this.position.z);
          this.currentSurface = surface;
          const landIntensity = THREE.MathUtils.clamp(effImpact / 4.2, 0.55, 1.85);
          this.audio.playFootstep(surface, landIntensity);
          this.audio.playGearRattle('landing', landIntensity);
          this.acoustic.emitNoise(this.position, 12 + effImpact * 2.5, 'landing');

          if (health > 0 && this.wakeUpTimer <= 0) {
            this.exertion = Math.min(
              BREATH_SWAY_CONFIG.exertionMax,
              this.exertion +
                BREATH_SWAY_CONFIG.exertionLandingGain *
                  THREE.MathUtils.clamp(effImpact * 0.28, 0.3, 1.5),
            );
          }

          // Compute equivalent free-fall drop height from vertical impact speed for Survival leg trauma
          const dropMeters = (effImpact * effImpact) / (2 * GRAVITY_MPS2);
          if (dropMeters > 1.15 && this.wakeUpTimer <= 0 && onFallImpact) {
            onFallImpact(dropMeters);
          }
        }
        this.velY = 0;
        this.airTimeSec = 0;
        this.jumpInitiated = false;
        this.peakFallSpeed = 0;
      } else if (this._sweepOut.hitCeiling && this.velY > 0) {
        this.velY = 0;
      }

      [this.kneeShock, this.kneeShockVel] = this.stepCriticallyDamped(this.kneeShock, this.kneeShockVel, 0, 12, dt);
      [this.landingDipY, this.landingDipVel] = this.stepDampedSpring(this.landingDipY, this.landingDipVel, 0, 7.4, 0.88, dt);
      this.landingDipY = THREE.MathUtils.clamp(this.landingDipY, -0.42, 0.08);
      [this.landingPitch, this.landingPitchVel] = this.stepDampedSpring(this.landingPitch, this.landingPitchVel, 0, 8.8, 0.88, dt);
      [this.landingRoll, this.landingRollVel] = this.stepDampedSpring(this.landingRoll, this.landingRollVel, 0, 8.6, 0.88, dt);
      [this.takeoffHeave, this.takeoffHeaveVel] = this.stepCriticallyDamped(this.takeoffHeave, this.takeoffHeaveVel, 0, 13, dt);
    }

    // Sample current ground material & interior/exterior acoustics
    this.currentSurface = adapter.getSurfaceMaterial(this.position.x, this.position.y, this.position.z);
    if (adapter.sampleInterior) {
      adapter.sampleInterior(
        this.position.x,
        this.position.y + this.currentHeight,
        this.position.z,
        this._interiorSample,
      );
      this.audio.setInteriorAcoustics(this._interiorSample.isIndoor, this._interiorSample.material);
    }

    // 6. Posture Height & Sphere-Swept Lean Clearance (Q/E halts smoothly against doorframes)
    const activeVaultState = this.vaultController.getReadOnlyState();
    const targetH = activeVaultState.active
      ? THREE.MathUtils.lerp(
          this.crouched ? CROUCH_EYE_HEIGHT : STAND_EYE_HEIGHT,
          CROUCH_EYE_HEIGHT,
          activeVaultState.crouchTransitionWeight,
        )
      : this.crouched
        ? CROUCH_EYE_HEIGHT
        : STAND_EYE_HEIGHT;
    const heightDampLambda =
      activeVaultState.active && (activeVaultState.headDuckWeight > 0.05 || activeVaultState.crouchTransitionWeight > 0.5)
        ? 28
        : 10;
    this.currentHeight = THREE.MathUtils.damp(this.currentHeight, targetH, heightDampLambda, dt);

    const leanInput = activeVaultState.active
      ? 0
      : (input.leanRight ? 1 : 0) - (input.leanLeft ? 1 : 0);
    let maxAllowedLean = LEAN_MAX_OFFSET_M;
    if (leanInput !== 0) {
      this._chestPos.set(
        this.position.x,
        this.position.y + this.currentHeight + this.stepSmoothOffsetY,
        this.position.z,
      );
      this._leanDir.set(cosY * leanInput, 0, -sinY * leanInput).normalize();
      maxAllowedLean = computeSphereSweptLeanClearance(
        adapter,
        this._chestPos,
        this._leanDir,
        this.torsoYaw,
        LEAN_MAX_OFFSET_M,
        LEAN_CLEARANCE_RADIUS_M,
      );
    }
    const prevLean = this.currentLean;
    const targetLean = leanInput * Math.min(LEAN_MAX_OFFSET_M, maxAllowedLean);
    this.currentLean = THREE.MathUtils.damp(this.currentLean, targetLean, 12, dt);
    const leanVel = THREE.MathUtils.clamp((this.currentLean - prevLean) / Math.max(dt, 0.001), -2.5, 2.5);
    const lateralParallaxMotion = THREE.MathUtils.clamp(localStrafeVel + leanVel * 1.45, -4.0, 4.0);
    const leanRoll = -(this.currentLean / LEAN_MAX_OFFSET_M) * THREE.MathUtils.degToRad(LEAN_MAX_ROLL_DEG);

    // Velocity-proportional strafe roll (±1.8°)
    const targetStrafeRoll = isMoving
      ? -THREE.MathUtils.clamp(localStrafeVel / Math.max(1.5, rawTargetSpeed), -1, 1) *
        THREE.MathUtils.degToRad(1.8) *
        (wantsSprint ? 1.15 : 1.0)
      : 0;
    this.strafeRoll = THREE.MathUtils.damp(this.strafeRoll, targetStrafeRoll, 10, dt);

    // 7. Exaggerated Smooth Phase-Locked Walk/Run Headbob + Airborne Jump Headbob + Surface Footsteps
    const speedRatio = isMoving
      ? THREE.MathUtils.clamp(horizSpeed / Math.max(0.8, rawTargetSpeed), 0.32, 1.18)
      : 0;

    this.bobWeight = THREE.MathUtils.damp(
      this.bobWeight,
      isMoving && this.grounded && !activeVaultState.active ? speedRatio : 0,
      8.5,
      dt,
    );
    this.sprintBobBlend = THREE.MathUtils.damp(
      this.sprintBobBlend,
      wantsSprint && this.grounded ? 1 : 0,
      6.5,
      dt,
    );
    this.crouchBobBlend = THREE.MathUtils.damp(this.crouchBobBlend, this.crouched ? 1 : 0, 7.5, dt);

    if (isMoving && this.grounded && !activeVaultState.active) {
      const baseCadence = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(2.18, 1.52, this.crouchBobBlend),
        3.45,
        this.sprintBobBlend,
      );
      const limpCadence = trauma ? trauma.limpCadenceScale : 1.0;
      const activeLegImpair =
        trauma ? (this.footSign < 0 ? trauma.leftLegImpairment : trauma.rightLegImpairment) : 0;
      const stepsPerSec = baseCadence * speedRatio * limpCadence * (1 - activeLegImpair * 0.22);

      const prevHalfCycle = Math.floor(this.bobPhase / Math.PI);
      this.bobPhase += dt * stepsPerSec * Math.PI;
      const nextHalfCycle = Math.floor(this.bobPhase / Math.PI);
      if (this.bobPhase > TWO_PI * 1000) {
        this.bobPhase %= TWO_PI * 1000;
      }
      this.strideProgress = (this.bobPhase % Math.PI) / Math.PI;

      if (nextHalfCycle > prevHalfCycle) {
        this.footSign *= -1;

        const landedImpair =
          trauma ? (this.footSign < 0 ? trauma.leftLegImpairment : trauma.rightLegImpairment) : 0;
        const amp = (wantsSprint ? 0.65 : this.crouched ? 0.24 : 0.44) * (1 + landedImpair * 0.85);
        this.heelDropVel = -0.30 * amp;
        this.heelPitchVel = -0.13 * amp;
        this.heelRollVel = this.footSign * (0.16 + landedImpair * 0.26) * amp;

        const vol = wantsSprint ? 1.25 : this.crouched ? 0.38 : 0.85;
        this.audio.playFootstep(this.currentSurface, vol);
        this.audio.playGearRattle('step', wantsSprint ? 1.25 : this.crouched ? 0.32 : 0.68);

        const acousticRadius = wantsSprint ? 22 : this.crouched ? 3 : 10;
        const acousticKind = wantsSprint
          ? 'footstep_sprint'
          : this.crouched
            ? 'footstep_crouch'
            : 'footstep_walk';
        this.acoustic.emitNoise(this.position, acousticRadius, acousticKind);
      }
    }
    // Keep bobPhase & strideProgress strictly continuous on stop so legs, pelvis,
    // arms, and weapon settle smoothly into idle without a single-frame phase snap.
    this.strideProgress = (this.bobPhase % Math.PI) / Math.PI;

    // Continuous exaggerated smooth walk/run headbob (sprint intensity dialed back ~10%)
    const aimBobAtten = this.isAds ? 0.32 : this.isCanted ? 0.38 : this.isPointAim ? 0.55 : 1.0;
    const crouchScale = THREE.MathUtils.lerp(1.0, 0.52, this.crouchBobBlend);
    const ampY = THREE.MathUtils.lerp(0.032 * crouchScale, 0.061, this.sprintBobBlend) * this.bobWeight * aimBobAtten;
    const ampX = THREE.MathUtils.lerp(0.017 * crouchScale, 0.032, this.sprintBobBlend) * this.bobWeight * aimBobAtten;
    const ampRoll = THREE.MathUtils.lerp(0.032 * crouchScale, 0.059, this.sprintBobBlend) * this.bobWeight * aimBobAtten;
    const ampPitch = THREE.MathUtils.lerp(0.020 * crouchScale, 0.041, this.sprintBobBlend) * this.bobWeight * aimBobAtten;

    const rawBobY = (-Math.cos(this.bobPhase * 2) - 0.14 * Math.sin(this.bobPhase * 2)) * ampY;
    const rawBobX = Math.sin(this.bobPhase) * ampX;
    const rawBobRoll = Math.sin(this.bobPhase - 0.22) * ampRoll;
    const rawBobPitch = (-Math.cos(this.bobPhase * 2 - 0.35)) * ampPitch;

    this.strideBobY = THREE.MathUtils.damp(this.strideBobY, rawBobY, 18, dt);
    this.strideBobX = THREE.MathUtils.damp(this.strideBobX, rawBobX, 18, dt);
    this.strideBobRoll = THREE.MathUtils.damp(this.strideBobRoll, rawBobRoll, 16, dt);
    this.strideBobPitch = THREE.MathUtils.damp(this.strideBobPitch, rawBobPitch, 16, dt);

    // Airborne jump headbob (active during jumps & falls, smoothly blends into landing suspension)
    const isAirborne = !this.grounded && !activeVaultState.active;
    this.airBobBlend = THREE.MathUtils.damp(this.airBobBlend, isAirborne ? 1 : 0, isAirborne ? 13 : 11, dt);
    const velYNorm = THREE.MathUtils.clamp(this.velY / JUMP_VELOCITY_MPS, -1.5, 1.0);
    const jumpBoost = this.jumpInitiated ? 1.0 : 0.65;
    const airOscY =
      (Math.sin(this.airTimeSec * 8.4) * 0.024 + velYNorm * 0.032) * jumpBoost * this.airBobBlend;
    const airOscX =
      Math.sin(this.airTimeSec * 4.8 + 0.45) * 0.018 * jumpBoost * this.airBobBlend;
    const airOscPitch =
      (velYNorm * 0.038 + Math.sin(this.airTimeSec * 7.6 - 0.3) * 0.020) * jumpBoost * this.airBobBlend;
    const airOscRoll =
      Math.sin(this.airTimeSec * 4.8 + 0.25) * 0.036 * jumpBoost * this.airBobBlend;

    this.jumpBobY = THREE.MathUtils.damp(this.jumpBobY, airOscY, 15, dt);
    this.jumpBobX = THREE.MathUtils.damp(this.jumpBobX, airOscX, 15, dt);
    this.jumpBobPitch = THREE.MathUtils.damp(this.jumpBobPitch, airOscPitch, 14, dt);
    this.jumpBobRoll = THREE.MathUtils.damp(this.jumpBobRoll, airOscRoll, 14, dt);

    [this.heelDrop, this.heelDropVel] = this.stepCriticallyDamped(this.heelDrop, this.heelDropVel, 0, 13, dt);
    [this.heelPitch, this.heelPitchVel] = this.stepCriticallyDamped(this.heelPitch, this.heelPitchVel, 0, 14, dt);
    [this.heelRoll, this.heelRollVel] = this.stepCriticallyDamped(this.heelRoll, this.heelRollVel, 0, 11, dt);

    // 8. Lifecycle-safe Procedural Breathing Sway & Exertion Coupling
    const gapDetected = this.lastUpdateElapsed < 0 || Math.abs(elapsed - this.lastUpdateElapsed) > 0.25;
    this.lastUpdateElapsed = elapsed;
    if (gapDetected) {
      this.breathPhase = 0;
      this.weaponDriftPhase = 0;
      this.swayEnvelope = 0;
    }

    this.lastBodyStamina = stamina;
    const activeWepProf = resolveWeaponProfile(equippedWeapon);
    this.lastWeaponMassKg = Math.max(0.45, activeWepProf?.massKg ?? 3.1);
    if (stamina < SPRINT_EXHAUST_THRESHOLD) {
      if (!this.sprintExhausted) {
        this.sprintExhausted = true;
        this.exhaustedBreathTimer = 0.06;
        this.audio.playBreathCue('exhale_depleted', 0.92);
      }
    } else if (this.sprintExhausted && stamina >= SPRINT_RECOVERY_THRESHOLD) {
      this.sprintExhausted = false;
    }

    const inAimStance = this.isAds || this.isCanted || this.isPointAim;
    const isFirearmAim = inAimStance && isFirearm;
    const hrStress01 = THREE.MathUtils.clamp((this.heartRateBpm - 74) / 108, 0, 1);

    if (health > 0 && this.wakeUpTimer <= 0) {
      if (isFirearmAim) {
        const massFactor = THREE.MathUtils.clamp(0.42 + (this.lastWeaponMassKg / 3.2) * 0.68, 0.45, 2.45);
        const bodyFatigueMult =
          1.0 +
          (1 - stamina) * 0.92 +
          (this.sprintExhausted ? 0.35 : 0) +
          hrStress01 * 0.28;
        const stanceFactor =
          (this.crouched ? 0.72 : 1.0) *
          (isMoving ? 1.18 : 1.0) *
          (this.isPointAim ? 0.85 : this.isCanted ? 0.95 : 1.0);
        const drainRate = 0.064 * massFactor * bodyFatigueMult * stanceFactor;
        this.armStamina = Math.max(0, this.armStamina - drainRate * dt);
      } else {
        const regenRate =
          (0.19 + stamina * 0.15) *
          (this.sprintExhausted ? 0.65 : 1.0) *
          (1.0 - hrStress01 * 0.22);
        this.armStamina = Math.min(1.0, this.armStamina + regenRate * dt);
      }
    }

    // Hold Breath requires at least 20% regular stamina
    const holdBreathTarget =
      input.holdBreath && inAimStance && stamina >= HOLD_BREATH_MIN_STAMINA ? 1 : 0;
    this.holdBreathBlend = THREE.MathUtils.damp(this.holdBreathBlend, holdBreathTarget, 7.5, dt);

    const swayActive = health > 0 && this.wakeUpTimer <= 0;
    if (!swayActive) {
      this.swayEnvelope = THREE.MathUtils.damp(this.swayEnvelope, 0, BREATH_SWAY_CONFIG.recoveryEnvelopeLambda * 2, dt);
      if (health <= 0) {
        this.exertion = 0;
        this.breathPhase = 0;
        this.weaponDriftPhase = 0;
      }
    } else {
      const exertionMult = survivalMods ? survivalMods.exertionRateMult : 1.0;
      if (wantsSprint) {
        this.exertion = Math.min(
          BREATH_SWAY_CONFIG.exertionMax,
          this.exertion + BREATH_SWAY_CONFIG.exertionSprintRate * exertionMult * dt,
        );
      } else if (isMoving) {
        const heavyWalkGain =
          survivalMods && survivalMods.encumbranceRatio > 0.55
            ? (survivalMods.encumbranceRatio - 0.55) * 0.08 * dt
            : 0;
        this.exertion = THREE.MathUtils.clamp(
          this.exertion - BREATH_SWAY_CONFIG.exertionWalkDecayRate * dt + heavyWalkGain,
          0,
          BREATH_SWAY_CONFIG.exertionMax,
        );
      } else {
        this.exertion = Math.max(0, this.exertion - BREATH_SWAY_CONFIG.exertionIdleDecayRate * dt);
      }

      if (this.sprintExhausted && holdBreathTarget === 0) {
        this.exhaustedBreathTimer -= dt;
        if (this.exhaustedBreathTimer <= 0) {
          const exhaustionUrgency = THREE.MathUtils.clamp(
            (SPRINT_RECOVERY_THRESHOLD - stamina) / SPRINT_RECOVERY_THRESHOLD,
            0.25,
            1.0,
          );
          this.audio.playBreathCue(
            exhaustionUrgency > 0.6 ? 'exhale_depleted' : 'exhale',
            0.52 + exhaustionUrgency * 0.42,
          );
          this.exhaustedBreathTimer = THREE.MathUtils.lerp(1.38, 0.88, exhaustionUrgency);
        }
      } else {
        this.exhaustedBreathTimer = Math.max(0, this.exhaustedBreathTimer - dt);
      }

      const satExertion = saturatingCurve(
        this.exertion / BREATH_SWAY_CONFIG.exertionMax,
        BREATH_SWAY_CONFIG.falloffShapeK,
      );

      const exhaustedFreqBoost = this.sprintExhausted ? 0.24 : 0;
      const targetFreqHz = Math.min(
        BREATH_SWAY_CONFIG.maxFreqHz * 1.12,
        BREATH_SWAY_CONFIG.baseFreqHz +
          satExertion * (BREATH_SWAY_CONFIG.maxFreqHz - BREATH_SWAY_CONFIG.baseFreqHz) +
          exhaustedFreqBoost,
      );
      this.smoothedFreqHz = THREE.MathUtils.clamp(
        THREE.MathUtils.damp(this.smoothedFreqHz, targetFreqHz, BREATH_SWAY_CONFIG.freqSmoothingLambda, dt),
        BREATH_SWAY_CONFIG.baseFreqHz,
        BREATH_SWAY_CONFIG.maxFreqHz * 1.12,
      );

      const staminaDepletion = THREE.MathUtils.clamp(1 - stamina, 0, 1);
      const lowHealthRatio = THREE.MathUtils.clamp((100 - health) / 100, 0, 1);
      const rawStress =
        satExertion * BREATH_SWAY_CONFIG.exertionAmpWeight +
        staminaDepletion * BREATH_SWAY_CONFIG.staminaWeight +
        lowHealthRatio * BREATH_SWAY_CONFIG.healthWeight;
      const maxPossibleStress =
        BREATH_SWAY_CONFIG.exertionAmpWeight +
        BREATH_SWAY_CONFIG.staminaWeight +
        BREATH_SWAY_CONFIG.healthWeight;
      const satStress = saturatingCurve(rawStress / maxPossibleStress, BREATH_SWAY_CONFIG.falloffShapeK);
      const exhaustedAmpBoost = this.sprintExhausted ? 1.42 : 1.0;
      const targetAmpMult = Math.min(
        BREATH_SWAY_CONFIG.maxCombinedAmpMult * 1.35,
        (1.0 + satStress * (BREATH_SWAY_CONFIG.maxCombinedAmpMult - 1.0)) * exhaustedAmpBoost,
      );

      this.smoothedAmpMult = THREE.MathUtils.clamp(
        THREE.MathUtils.damp(this.smoothedAmpMult, targetAmpMult, BREATH_SWAY_CONFIG.ampSmoothingLambda, dt),
        1.0,
        BREATH_SWAY_CONFIG.maxCombinedAmpMult * 1.35,
      );

      this.swayEnvelope = THREE.MathUtils.damp(this.swayEnvelope, 1.0, BREATH_SWAY_CONFIG.recoveryEnvelopeLambda, dt);

      this.breathPhase += dt * TWO_PI * this.smoothedFreqHz;
      if (this.breathPhase > TWO_PI * 1000) this.breathPhase %= TWO_PI * 1000;
      this.weaponDriftPhase += dt * TWO_PI * (this.smoothedFreqHz * BREATH_SWAY_CONFIG.weaponDriftFreqRatio);
      if (this.weaponDriftPhase > TWO_PI * 1000) this.weaponDriftPhase %= TWO_PI * 1000;
      this.cardiacPhase += dt * TWO_PI * (this.heartRateBpm / 60);
      if (this.cardiacPhase > TWO_PI * 1000) this.cardiacPhase %= TWO_PI * 1000;
    }

    const bp = this.breathPhase;
    const camOscY =
      Math.sin(bp) * 0.68 +
      Math.sin(bp * 2.07 + 0.91) * 0.22 +
      Math.sin(bp * 3.41 + 2.13) * 0.10;
    const camOscX =
      Math.cos(bp * 0.53 + 0.44) * 0.64 +
      Math.sin(bp * 1.37 + 1.85) * 0.26 +
      Math.cos(bp * 2.79 + 0.62) * 0.10;
    const camOscRoll =
      Math.sin(bp * 0.79 + 1.18) * 0.72 +
      Math.cos(bp * 1.93 + 2.41) * 0.28;

    // Step upper-body / torso biomechanical recoil absorption springs
    [this.torsoAbsorbPitch, this.torsoAbsorbPitchVel] = this.stepDampedSpring(
      this.torsoAbsorbPitch,
      this.torsoAbsorbPitchVel,
      0,
      10.5,
      0.88,
      dt,
    );
    [this.torsoAbsorbYaw, this.torsoAbsorbYawVel] = this.stepDampedSpring(
      this.torsoAbsorbYaw,
      this.torsoAbsorbYawVel,
      0,
      10.5,
      0.88,
      dt,
    );
    this.torsoAbsorbPitch = THREE.MathUtils.clamp(this.torsoAbsorbPitch, -0.025, 0.036);
    this.torsoAbsorbYaw = THREE.MathUtils.clamp(this.torsoAbsorbYaw, -0.030, 0.030);

    // Heart Rate -> Weapon Stability & Arm Stamina fatigue
    const hrCalmOrStressMult =
      this.heartRateBpm <= 82
        ? THREE.MathUtils.lerp(0.76, 1.0, THREE.MathUtils.clamp((this.heartRateBpm - 62) / 20, 0, 1))
        : THREE.MathUtils.lerp(1.0, 1.82, THREE.MathUtils.clamp((this.heartRateBpm - 82) / 102, 0, 1));
    const systolicWave = Math.pow(Math.max(0, Math.sin(this.cardiacPhase)), 6);
    const dicroticWave = Math.pow(Math.max(0, Math.sin(this.cardiacPhase - 0.85)), 8) * 0.35;
    const cardiacPulse = (systolicWave + dicroticWave) * (0.14 + hrStress01 * 0.86);

    const armFatigue = isFirearmAim
      ? THREE.MathUtils.clamp((0.45 - this.armStamina) / 0.45, 0, 1)
      : 0;
    const armDepleted = isFirearmAim
      ? THREE.MathUtils.clamp((0.15 - this.armStamina) / 0.15, 0, 1)
      : 0;
    const armSwayAmplifier = 1.0 + armFatigue * 1.25 + armDepleted * 1.35;

    // Breath sway reaches exact 0% when breath is held; locomotion headbob & arm fatigue remain physical.
    const holdBreathFactor = Math.max(0, 1 - this.holdBreathBlend);
    const swayMult =
      (trauma ? trauma.swayAmpMult : 1.0) *
      (survivalMods ? survivalMods.swayAmpMult : 1.0) *
      hrCalmOrStressMult *
      holdBreathFactor;
    const camSwayScale =
      this.swayEnvelope *
      this.smoothedAmpMult *
      swayMult *
      (this.isAds
        ? BREATH_SWAY_CONFIG.adsCamSwayScale
        : this.isCanted
          ? 0.62
          : this.isPointAim
            ? 0.72
            : 1.0);

    const armTremorRad = (armFatigue * 0.0024 + armDepleted * 0.0052) * hrCalmOrStressMult;
    const traumaTremorRad = trauma ? Math.min(TRAUMA_LIMITS.maxTremorRad, trauma.tremorAmp) : 0;
    const totalTremorAmp = traumaTremorRad + armTremorRad;
    const cardiacPitchKick =
      inAimStance ? cardiacPulse * (0.00055 + hrStress01 * 0.00145) : 0;
    const cardiacYawKick =
      inAimStance ? cardiacPulse * Math.cos(this.cardiacPhase * 0.5) * (0.00028 + hrStress01 * 0.00085) : 0;

    const armWanderPitch =
      armFatigue > 0.02
        ? (Math.sin(elapsed * 1.65) * 0.62 + Math.cos(elapsed * 2.83) * 0.38) *
          (armFatigue * 0.0042 + armDepleted * 0.0075)
        : 0;
    const armWanderYaw =
      armFatigue > 0.02
        ? (Math.cos(elapsed * 1.29 + 0.7) * 0.65 + Math.sin(elapsed * 2.41) * 0.35) *
          (armFatigue * 0.0048 + armDepleted * 0.0082)
        : 0;

    const tremorPitch =
      totalTremorAmp > 0
        ? Math.sin(elapsed * 23.3) * totalTremorAmp * 0.62 + Math.cos(elapsed * 37.7) * totalTremorAmp * 0.38
        : 0;
    const tremorYaw =
      totalTremorAmp > 0
        ? Math.cos(elapsed * 25.1 + 0.8) * totalTremorAmp * 0.62 + Math.sin(elapsed * 41.4) * totalTremorAmp * 0.38
        : 0;

    const swayPosX = THREE.MathUtils.clamp(
      camOscX * BREATH_SWAY_CONFIG.camBasePosXMeters * camSwayScale,
      -BREATH_SWAY_CONFIG.camMaxPosMeters * 1.35,
      BREATH_SWAY_CONFIG.camMaxPosMeters * 1.35,
    );
    const swayPosY = THREE.MathUtils.clamp(
      camOscY * BREATH_SWAY_CONFIG.camBasePosYMeters * camSwayScale,
      -BREATH_SWAY_CONFIG.camMaxPosMeters * 1.35,
      BREATH_SWAY_CONFIG.camMaxPosMeters * 1.35,
    );
    const maxRotLimit = BREATH_SWAY_CONFIG.camMaxRotRad * 1.85 + TRAUMA_LIMITS.maxTremorRad;
    const swayPitch = THREE.MathUtils.clamp(
      camOscY * BREATH_SWAY_CONFIG.camBaseRotPitchRad * camSwayScale +
        tremorPitch +
        armWanderPitch +
        cardiacPitchKick,
      -maxRotLimit,
      maxRotLimit,
    );
    const swayYaw = THREE.MathUtils.clamp(
      camOscX * BREATH_SWAY_CONFIG.camBaseRotYawRad * camSwayScale +
        tremorYaw +
        armWanderYaw +
        cardiacYawKick,
      -maxRotLimit,
      maxRotLimit,
    );
    const swayRoll = THREE.MathUtils.clamp(
      camOscRoll * BREATH_SWAY_CONFIG.camBaseRotRollRad * camSwayScale + armWanderYaw * 0.45,
      -BREATH_SWAY_CONFIG.camMaxRotRad * 1.4,
      BREATH_SWAY_CONFIG.camMaxRotRad * 1.4,
    );

    const wp = this.weaponDriftPhase;
    const wepScale =
      this.swayEnvelope *
      this.smoothedAmpMult *
      swayMult *
      armSwayAmplifier *
      (this.isAds
        ? BREATH_SWAY_CONFIG.adsWeaponDriftScale
        : this.isCanted
          ? 0.54
          : this.isPointAim
            ? 0.68
            : 1.0);
    const armDriftX =
      armFatigue > 0.02
        ? (Math.cos(elapsed * 1.45) * 0.0038 + Math.sin(elapsed * 29.4) * 0.0014) *
          (armFatigue + armDepleted * 1.4)
        : 0;
    const armDriftY =
      armFatigue > 0.02
        ? (Math.sin(elapsed * 1.92) * 0.0036 + Math.cos(elapsed * 33.1) * 0.0013 - armDepleted * 0.0022) *
          (armFatigue + armDepleted * 1.4)
        : 0;
    const cardiacDriftY = inAimStance ? cardiacPulse * (0.0005 + hrStress01 * 0.0016) : 0;

    const breathX = THREE.MathUtils.clamp(
      (Math.sin(wp + 1.73) * 0.65 + Math.cos(wp * 1.61 + 0.52) * 0.35) *
        BREATH_SWAY_CONFIG.weaponBaseDriftXMeters *
        wepScale +
        armDriftX,
      -BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 2.4,
      BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 2.4,
    );
    const breathY = THREE.MathUtils.clamp(
      (Math.sin(wp * 0.89 + 2.89) * 0.70 + Math.sin(wp * 2.19 + 1.11) * 0.30) *
        BREATH_SWAY_CONFIG.weaponBaseDriftYMeters *
        wepScale +
        armDriftY +
        cardiacDriftY,
      -BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 2.4,
      BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 2.4,
    );

    // 9. Position Chest-Mounted Camera with collar offset + step-up glide + smooth stride/jump headbob + landing suspension
    const rightX = cosY;
    const rightZ = -sinY;
    const backX = sinY;
    const backZ = cosY;
    const baseLateralOffset =
      COLLAR_OFFSET_X + this.currentLean + this.strideBobX + this.jumpBobX + swayPosX;
    const lateralOffset = baseLateralOffset + this.camShakePosX;

    let baseCamY =
      this.position.y +
      THREE.MathUtils.lerp(0.32, this.currentHeight, wakeLift) +
      this.stepSmoothOffsetY +
      this.strideBobY +
      this.jumpBobY +
      this.takeoffHeave * 0.045 +
      this.landingDipY +
      this.heelDrop +
      this.kneeShock +
      this.strafeDip +
      activeVaultState.cameraDipOffset +
      swayPosY;

    // Hard overhead lintel cap during window breach/vaults so head/camera NEVER clip into the upper wall
    let lintelClampDelta = 0;
    if (activeVaultState.active && Number.isFinite(activeVaultState.maxCameraWorldY)) {
      if (baseCamY > activeVaultState.maxCameraWorldY) {
        lintelClampDelta = activeVaultState.maxCameraWorldY - baseCamY;
        baseCamY = activeVaultState.maxCameraWorldY;
      }
    }

    const camY = baseCamY + this.camShakePosY;

    this.camera.position.set(
      this.position.x + rightX * lateralOffset + backX * COLLAR_OFFSET_Z,
      camY,
      this.position.z + rightZ * lateralOffset + backZ * COLLAR_OFFSET_Z,
    );

    const baseChestPitch =
      this.torsoPitch +
      PITCH_BIAS_RAD +
      this.sympPitch +
      this.torsoAbsorbPitch * 0.35 +
      this.strideBobPitch +
      this.jumpBobPitch +
      this.takeoffHeave * 0.05 +
      this.landingPitch +
      this.heelPitch +
      activeVaultState.cameraPitchOffset +
      swayPitch +
      wakePitchOffset;
    const baseChestYaw = this.torsoYaw + this.sympYaw + this.torsoAbsorbYaw * 0.35 + swayYaw;
    const baseChestRoll =
      leanRoll +
      this.strafeRoll +
      this.strideBobRoll +
      this.jumpBobRoll +
      this.landingRoll +
      this.heelRoll +
      activeVaultState.cameraRollOffset +
      swayRoll +
      wakeRoll;

    const targetStrainRoll =
      this.grenadeThrowStyle === 'overhand' && this.grenadeCharge01 > 0.02
        ? -0.028 * this.grenadeCharge01
        : 0;
    this.grenadeStrainRoll = THREE.MathUtils.damp(this.grenadeStrainRoll, targetStrainRoll, 12, dt);

    const gripStrainAmp =
      (this.grenadeCharge01 > 0.85 ? ((this.grenadeCharge01 - 0.85) / 0.15) * 0.0022 : 0) +
      (this.grenadeLiveCook ? 0.0012 : 0);
    const gripStrainPitch = gripStrainAmp > 0 ? Math.sin(elapsed * 41.3) * gripStrainAmp : 0;
    const gripStrainYaw = gripStrainAmp > 0 ? Math.cos(elapsed * 37.9) * gripStrainAmp : 0;

    const chestPitch = baseChestPitch + this.camShakePitch + gripStrainPitch;
    const chestYaw = baseChestYaw + this.camShakeYaw + gripStrainYaw;
    const chestRoll = baseChestRoll + this.camShakeRoll + this.grenadeStrainRoll;

    this._aimEuler.set(chestPitch, chestYaw, chestRoll, 'YXZ');
    this.camera.quaternion.setFromEuler(this._aimEuler);

    // Wide ~98° Horizontal FOV -> dynamic Vertical FOV
    // Primary ADS: 82°; Canted Optic ADS: ~86° CQB focus; Point Aim: ~88° (0.90x tactical focus)
    const grenadeFovCompress =
      this.grenadeThrowStyle === 'overhand' ? this.grenadeCharge01 * 3.8 : 0;
    const targetHFov = (this.isAds
      ? ADS_HORIZONTAL_FOV_DEG
      : this.isCanted
        ? THREE.MathUtils.lerp(BASE_HORIZONTAL_FOV_DEG, ADS_HORIZONTAL_FOV_DEG, 0.72)
        : this.isPointAim
          ? BASE_HORIZONTAL_FOV_DEG * 0.90
          : wantsSprint
            ? SPRINT_HORIZONTAL_FOV_DEG
            : BASE_HORIZONTAL_FOV_DEG) - grenadeFovCompress;
    const targetVFov = horizontalToVerticalFov(targetHFov, this.camera.aspect);
    if (Math.abs(this.camera.fov - targetVFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetVFov, 12, dt);
      this.camera.updateProjectionMatrix();
    }

    // Update AudioListener to match chest camera orientation
    this._tmpDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this._tmpOrigin.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.updateListener(this.camera.position, this._tmpDir, this._tmpOrigin);

    // 10. Anchor WeaponRig to chest/sternum space with decoupled 1:1 free-aim orientation (zero GC)
    const chestCenter = this._chestPos.set(
      this.position.x + rightX * (this.currentLean + this.strideBobX * 0.55 + this.jumpBobX * 0.5),
      this.position.y +
        THREE.MathUtils.lerp(0.32, this.currentHeight, wakeLift) +
        this.stepSmoothOffsetY +
        this.strideBobY * 0.72 +
        this.jumpBobY * 0.65 +
        this.takeoffHeave * 0.025 +
        this.landingDipY * 0.82 +
        this.heelDrop * 0.6 +
        this.kneeShock * 0.7 +
        this.strafeDip * 0.8 +
        activeVaultState.cameraDipOffset * 0.85 +
        lintelClampDelta,
      this.position.z + rightZ * (this.currentLean + this.strideBobX * 0.55 + this.jumpBobX * 0.5),
    );

    const minWepRad = THREE.MathUtils.degToRad(settings.minWeaponPitchDeg ?? -50);
    const maxWepRad = THREE.MathUtils.degToRad(settings.maxWeaponPitchDeg ?? 68);
    this.lastMinWeaponPitchRad = minWepRad;
    this.lastMaxWeaponPitchRad = maxWepRad;

    const weaponRootPitch = THREE.MathUtils.clamp(this.torsoPitch, minWepRad, maxWepRad);
    const minAimForStop = minWepRad - weaponRootPitch;
    const maxAimForStop = maxWepRad - weaponRootPitch;
    const clampedAimPitch = THREE.MathUtils.clamp(this.aimPitch, minAimForStop, maxAimForStop);
    if (this.aimPitch < minAimForStop) {
      this.aimPitch = minAimForStop;
    } else if (this.aimPitch > maxAimForStop) {
      this.aimPitch = maxAimForStop;
    }

    this.weaponRig.root.position.copy(chestCenter);
    this._rigEuler.set(
      weaponRootPitch +
        this.sympPitch * 0.4 +
        this.torsoAbsorbPitch +
        this.strideBobPitch * 0.45 +
        this.jumpBobPitch * 0.55 +
        this.landingPitch * 0.55 +
        activeVaultState.cameraPitchOffset * 0.5,
      this.torsoYaw + this.sympYaw * 0.4 + this.torsoAbsorbYaw,
      leanRoll * 0.65 +
        this.strafeRoll * 0.5 +
        this.strideBobRoll * 0.45 +
        this.jumpBobRoll * 0.5 +
        this.landingRoll * 0.5 +
        activeVaultState.cameraRollOffset * 0.55,
      'YXZ',
    );
    this._camQuat.setFromEuler(this._rigEuler);
    this.weaponRig.root.quaternion.copy(this._camQuat);

    // Build steadier shoulder/head reference for ADS/cant sight alignment (decoupled from 100% of
    // high-frequency cheek-weld camera shake so vision visibly jolts while the braced firearm stays composed)
    // and biomechanically clamped to [minWepRad, maxWepRad].
    const wepShakeFollow = 0.28;
    const wepCamPitch = THREE.MathUtils.clamp(
      baseChestPitch + this.camShakePitch * wepShakeFollow,
      minWepRad,
      maxWepRad,
    );
    const wepCamYaw = baseChestYaw + this.camShakeYaw * wepShakeFollow;
    const wepCamRoll = baseChestRoll + this.camShakeRoll * wepShakeFollow;
    this._weaponCamEuler.set(wepCamPitch, wepCamYaw, wepCamRoll, 'YXZ');
    this._weaponCamQuat.setFromEuler(this._weaponCamEuler);

    const wepLateralOffset = baseLateralOffset + this.camShakePosX * wepShakeFollow;
    this._weaponCamPos.set(
      this.position.x + rightX * wepLateralOffset + backX * COLLAR_OFFSET_Z,
      baseCamY + this.camShakePosY * wepShakeFollow,
      this.position.z + rightZ * wepLateralOffset + backZ * COLLAR_OFFSET_Z,
    );

    this.weaponRig.updateRig(
      dt,
      elapsed,
      wSpec,
      this.aimYaw,
      clampedAimPitch,
      this.isAds,
      wantsSprint,
      isMoving,
      this.strideProgress,
      breathX,
      breathY,
      this._weaponCamPos,
      this._weaponCamQuat,
      world.raycastMeshes,
      settings.flashlightAngleDeg,
      trauma ? trauma.adsSpeedMult : 1.0,
      this.isCanted,
      activeVaultState.weaponRetentionMode,
      activeVaultState.weaponRetentionBlend,
      this.bobPhase,
      this.landingDipY + this.jumpBobY * 0.6,
      adapter,
      weaponRootPitch,
      minWepRad,
      maxWepRad,
      lateralParallaxMotion,
      settings.opticParallaxStrength ?? 1.0,
      this.isPointAim,
      this.holdBreathBlend,
    );
  }

  public getExertion(): number {
    return this.exertion;
  }

  public getCurrentMoveSpeed(): number {
    return this.currentMoveSpeed;
  }

  public getWorldLookDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
  }
}

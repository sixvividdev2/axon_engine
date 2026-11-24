import * as THREE from 'three';
import {
  checkOverheadClearanceViaRaycast,
  computeSphereSweptLeanClearance,
} from './BodycamPhysics';
import { IBodycamAudioSource } from './IBodycamAudioSource';
import { clampSpringState, stepAnalyticalDampedSpring } from './math/SpringMath';
import { VaultController, VaultStateSnapshot } from './movement/VaultController';
import {
  createVaultCandidate,
  VaultBlockReason,
  VaultCandidate,
  VaultDetector,
} from './movement/VaultDetector';
import {
  AdsMode,
  AimStance,
  BodycamCapsuleSweepResult,
  BodycamInputState,
  BodycamInteriorSample,
  BodycamRecoilOptions,
  BodycamSDKConfig,
  BodycamSurfaceMaterial,
  BodycamSurvivalModifiers,
  BodycamTelemetry,
  BodycamTraumaModifiers,
  BodycamWeaponProfile,
  createCapsuleSweepResult,
  IBodycamWorldAdapter,
} from './types';
import { WeaponRig } from './WeaponRig';
import type { PdaMotionState } from './TacticalPdaDevice';

// === PRESERVED TUNED CONSTANTS (DO NOT FLATTEN) ===
const STAND_EYE_HEIGHT = 1.42;
const CROUCH_EYE_HEIGHT = 0.92;
const STAND_CAPSULE_HEIGHT = 1.62;
const CROUCH_CAPSULE_HEIGHT = 1.06;
const COLLAR_OFFSET_X = 0.03;
const COLLAR_OFFSET_Z = 0.06;
const PITCH_BIAS_RAD = THREE.MathUtils.degToRad(2.0);
const CAMERA_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-82);
const CAMERA_MAX_PITCH_RAD = THREE.MathUtils.degToRad(80);
const SPINE_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-40);
const SPINE_MAX_PITCH_RAD = THREE.MathUtils.degToRad(55);
const PLAYER_RADIUS = 0.34;
const GRAVITY_MPS2 = 16.5;
const JUMP_VELOCITY_MPS = 4.65;
const JUMP_COYOTE_SEC = 0.095;
const JUMP_COOLDOWN_SEC = 0.32;
const AIR_ACCEL_LAMBDA = 2.6;
const TWO_PI = Math.PI * 2;
const MAX_TRAUMA_TREMOR_RAD = 0.0042;

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
 * Self-contained AAA BodycamController:
 *  - Preserves 1:1 elliptical free-aim deadzone, critically damped torso follow spring,
 *    phase-continuous exertion breathing-sway oscillator, weapon drift separation, and reduced mouse accel.
 *  - Decoupled from host worlds via `IBodycamWorldAdapter`.
 *  - Adds capsule sliding + 0.32m stair/curb step-up with smooth vertical camera gliding,
 *    overhead crouch-tunnel clearance lock, sphere-swept lean clearance, ground momentum,
 *    strafe-reversal weight-transfer dip, and impact-velocity landing knee-compression shock.
 */
export class BodycamController {
  public readonly position = new THREE.Vector3(0, 0, 12);
  public torsoYaw = 0;
  public torsoPitch = 0;

  private targetTorsoYaw = 0;
  private targetTorsoPitch = 0;
  private torsoYawVel = 0;
  private torsoPitchVel = 0;

  // Zero-lag 1:1 free-aim angles
  public aimYaw = 0;
  public aimPitch = 0;

  // Subtle sympathetic chest camera recoil (~20% of weapon kick)
  private sympPitch = 0;
  private sympPitchVel = 0;
  private sympYaw = 0;
  private sympYawVel = 0;

  // High-frequency cheek-weld camera shake springs (stronger in ADS, minimal in Hip-Fire)
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
  public isAds = false;
  public isCanted = false;
  public isPointAim = false;
  public aimStance: AimStance = 'HIP';
  public armedAdsMode: AdsMode = 'PRIMARY';
  public grounded = true;

  private velX = 0;
  private velY = 0;
  private velZ = 0;

  public getVelocity(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.velX, this.velY, this.velZ);
  }
  private prevLocalStrafeVel = 0;
  private strafeDip = 0;
  private strafeDipVel = 0;

  private currentHeight = STAND_EYE_HEIGHT;
  private stepSmoothOffsetY = 0;
  private stepSmoothVelY = 0;
  private lastStepUpElapsed = -10;
  private steppedUpLastFrame = false;
  private slopeAngleRad = 0;

  private currentLean = 0;
  private leanClamped = false;
  private strafeRoll = 0;
  private currentSurface: BodycamSurfaceMaterial = 'concrete';
  private wasCrouched = false;

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

  // Angular camera whip velocity (for CMOS shutter ghosting / micro motion-blur)
  private prevChestYaw = 0;
  private prevChestPitch = 0;
  private whipVelX = 0;
  private whipVelY = 0;
  private angularWhipRadPerSec = 0;

  // Breathing sway, hold-breath reserve/cooldown & exertion state (zero-GC)
  private exertion = 0;
  private smoothedFreqHz: number = BREATH_SWAY_CONFIG.baseFreqHz;
  private smoothedAmpMult = 1.0;
  private swayEnvelope = 0;
  private breathPhase = 0;
  private weaponDriftPhase = 0;
  private holdBreathActive = false;
  private holdBreathRemainingSec = 7.0;
  private holdBreathHeldSec = 0;
  private holdBreathCooldownSec = 0;
  private holdBreathReboundSec = 0;
  private lowBreathPulseTimer = 0;
  private breathVignette = 0;
  private holdBreathBlend = 0;
  private lastBreathX = 0;
  private lastBreathY = 0;
  private lastUpdateElapsed = -1;

  // Coupled upper-body / torso biomechanical recoil absorption springs
  private torsoAbsorbPitch = 0;
  private torsoAbsorbPitchVel = 0;
  private torsoAbsorbYaw = 0;
  private torsoAbsorbYawVel = 0;

  // Diegetic grenade charge tension (FOV compression + counter-lean + peak-force tremor)
  private grenadeCharge01 = 0;
  private grenadeLiveCook = false;
  private grenadeThrowStyle: 'overhand' | 'underhand' = 'underhand';
  private grenadeStrainRoll = 0;

  // Grounded tactical vault & mantle traversal override (zero-GC)
  private readonly vaultDetector = new VaultDetector();
  private readonly vaultController = new VaultController();
  private readonly _vaultCandidate: VaultCandidate = createVaultCandidate();
  private vaultCooldownSec = 0;
  private doubleSpaceTimerSec = 0;
  private spinDirToggle: -1 | 1 = 1;
  private lastVaultBlockReason: VaultBlockReason = 'none';

  // Pre-allocated scratch math objects (zero GC per frame)
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpUp = new THREE.Vector3();
  private readonly _chestPos = new THREE.Vector3();
  private readonly _leanDir = new THREE.Vector3();
  private readonly _camQuat = new THREE.Quaternion();
  private readonly _aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _rigEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _weaponCamPos = new THREE.Vector3();
  private readonly _weaponCamQuat = new THREE.Quaternion();
  private readonly _weaponCamEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _sweepOut: BodycamCapsuleSweepResult = createCapsuleSweepResult();
  private readonly _interiorSample: BodycamInteriorSample = { isIndoor: false, material: 'outdoor' };
  private lastMinWeaponPitchRad = THREE.MathUtils.degToRad(-50);
  private lastMaxWeaponPitchRad = THREE.MathUtils.degToRad(68);

  private camera: THREE.PerspectiveCamera;
  private weaponRig: WeaponRig;
  private audio: IBodycamAudioSource;

  constructor(
    camera: THREE.PerspectiveCamera,
    weaponRig: WeaponRig,
    audio: IBodycamAudioSource,
  ) {
    this.camera = camera;
    this.weaponRig = weaponRig;
    this.audio = audio;
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

  public setGrenadeTension(
    charge01: number,
    liveCook: boolean,
    throwStyle: 'overhand' | 'underhand' = 'overhand',
  ): void {
    this.grenadeCharge01 = THREE.MathUtils.clamp(charge01, 0, 1);
    this.grenadeLiveCook = liveCook;
    this.grenadeThrowStyle = throwStyle;
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public isAirborne(): boolean {
    return !this.grounded && !this.vaultController.isActive();
  }

  public getAirTime(): number {
    return this.airTimeSec;
  }

  public getVerticalVelocity(): number {
    return this.velY;
  }

  public getLandingCompression(): number {
    return this.landingDipY + this.kneeShock;
  }

  /** Normalized 0..1.35 real-life knee flexion bend driven by landing suspension */
  public getLandingKneeBend(): number {
    return THREE.MathUtils.clamp(-(this.landingDipY + this.kneeShock) / 0.24, 0, 1.35);
  }

  public consumeJumpBlockReason(): 'none' | 'dual_leg_trauma' | 'overhead_blocked' {
    const r = this.lastJumpBlockReason;
    this.lastJumpBlockReason = 'none';
    return r;
  }

  public shiftOrigin(dx: number, dz: number): void {
    this.position.x += dx;
    this.position.z += dz;
    this.vaultController.shiftOrigin(dx, dz);
  }

  public snapTo(x: number, y: number, z: number, yaw = 0, pitch = 0): void {
    this.vaultController.abort();
    this.vaultCooldownSec = 0;
    this.lastVaultBlockReason = 'none';
    this.lastJumpBlockReason = 'none';
    this.position.set(x, y, z);
    this.velX = 0;
    this.velY = 0;
    this.velZ = 0;
    this.stepSmoothOffsetY = 0;
    this.stepSmoothVelY = 0;
    this.lastStepUpElapsed = -10;
    this.kneeShock = 0;
    this.kneeShockVel = 0;
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
    this.landingDipY = 0;
    this.landingDipVel = 0;
    this.landingPitch = 0;
    this.landingPitchVel = 0;
    this.landingRoll = 0;
    this.landingRollVel = 0;
    this.takeoffHeave = 0;
    this.takeoffHeaveVel = 0;
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
    this.doubleSpaceTimerSec = 0;
    this.vaultCooldownSec = 0;
    this.strafeDip = 0;
    this.strafeDipVel = 0;
    this.torsoAbsorbPitch = 0;
    this.torsoAbsorbPitchVel = 0;
    this.torsoAbsorbYaw = 0;
    this.torsoAbsorbYawVel = 0;
    this.grounded = true;
    this.crouched = false;
    this.wantCrouch = false;
    this.wasCrouched = false;
    this.currentHeight = STAND_EYE_HEIGHT;
    this.setAngles(yaw, pitch);
    this.resetBreathingToRest();
  }

  public toggleCrouch(): void {
    this.wantCrouch = !this.wantCrouch;
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
    this.prevChestYaw = yaw;
    this.prevChestPitch = clampedPitch;
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

  public addExertionImpulse(amount: number): void {
    if (amount <= 0) return;
    this.exertion = Math.min(BREATH_SWAY_CONFIG.exertionMax, this.exertion + amount);
  }

  public isHoldBreathActive(): boolean {
    return this.holdBreathActive;
  }

  public getHoldBreathVignette(): number {
    return this.breathVignette;
  }

  public getHoldBreathBlend(): number {
    return this.holdBreathBlend;
  }

  private resetBreathingToRest(): void {
    this.exertion = 0;
    this.smoothedFreqHz = BREATH_SWAY_CONFIG.baseFreqHz;
    this.smoothedAmpMult = 1.0;
    this.swayEnvelope = 0;
    this.breathPhase = 0;
    this.weaponDriftPhase = 0;
    this.holdBreathActive = false;
    this.holdBreathRemainingSec = 7.0;
    this.holdBreathHeldSec = 0;
    this.holdBreathCooldownSec = 0;
    this.holdBreathReboundSec = 0;
    this.lowBreathPulseTimer = 0;
    this.breathVignette = 0;
    this.holdBreathBlend = 0;
    this.lastBreathX = 0;
    this.lastBreathY = 0;
    this.lastUpdateElapsed = -1;
  }

  /**
   * Preserved 1:1 linear free-aim deadzone + elliptical boundary transfer + trailing weapon inertia,
   * with downward biomechanical weapon pitch clamp so looking down at boots lets camera continue to -82°
   * without driving stock/hands backward into the plate carrier.
   */
  public handleMouseMove(dx: number, dy: number, config: Readonly<BodycamSDKConfig>): void {
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
          : config.deadzoneYawDeg;
    const pitchDeg = this.isAds
      ? magScope
        ? 1.5
        : 2.0
      : this.isCanted
        ? 2.8
        : this.isPointAim
          ? 4.2
          : config.deadzonePitchDeg;
    const maxYaw = Math.max(0.01, THREE.MathUtils.degToRad(yawDeg));
    const maxPitch = Math.max(0.01, THREE.MathUtils.degToRad(pitchDeg));

    const minWepRad = THREE.MathUtils.degToRad(config.minWeaponPitchDeg ?? -50);
    const maxWepRad = THREE.MathUtils.degToRad(config.maxWeaponPitchDeg ?? 68);
    this.lastMinWeaponPitchRad = minWepRad;
    this.lastMaxWeaponPitchRad = maxWepRad;

    const prevTorsoPitch = this.targetTorsoPitch;
    const prevClampedTorso = THREE.MathUtils.clamp(prevTorsoPitch, minWepRad, maxWepRad);
    const prevWeaponPitch = prevClampedTorso + this.aimPitch;
    const deltaPitch = -dy * sens;

    const rawYaw = this.aimYaw - dx * sens;
    const rawPitch = this.aimPitch + deltaPitch;

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

    // Trailing weapon weight inertia (scaled by physical mass, config & active weapon pitch motion)
    this.weaponRig.addInertia(
      dx * 0.00018,
      dy * 0.00014 * weaponPitchFraction,
      config.weaponInertiaScale,
    );
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
    sightMisalignConfigScale = 1.0,
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
    this.weaponRig.applyWeaponRecoil(
      pitchRad * 1.45,
      yawJitter * 1.1,
      kickBackM,
      sightMisalignConfigScale,
      {
        cheekWeld,
        hipRecoilSwayScale: hipSwayScale,
        stanceCoupled,
        rawYawRad: yawRad,
        holdBreathBlend: this.holdBreathBlend,
      },
    );

    if (stanceCoupled) {
      // 2. Camera / cheek-weld channel scaled progressively by caliber recoil energy:
      //    Light 9mm/5.56: crisp, controlled punch. Heavy 7.62/12ga/.50 AE/.338/23mm: visceral shoulder/cheek shock.
      const recoilEnergy = THREE.MathUtils.clamp((Math.abs(pitchRad) / 0.036 + kickBackM / 0.026) * 0.5, 0.55, 2.8);
      const caliberPunchBoost = 1.0 + Math.max(0, recoilEnergy - 1.0) * 0.34;
      const climbBreathScale = THREE.MathUtils.lerp(1.0, 0.70, this.holdBreathBlend);
      const driftBreathScale = THREE.MathUtils.lerp(1.0, 0.25, this.holdBreathBlend);
      const camShakeGain = cheekWeld * magScopeAtten * adsCamScale * caliberPunchBoost;
      const sympGain =
        THREE.MathUtils.lerp(0.28, 0.74, cheekWeld) *
        magScopeAtten *
        caliberPunchBoost *
        THREE.MathUtils.lerp(1.0, adsCamScale, cheekWeld * 0.75);

      this.sympPitchVel += pitchRad * 0.24 * 24 * sympGain * climbBreathScale;
      this.sympYawVel += yawJitter * 0.22 * 20 * sympGain * driftBreathScale;

      // Coupled upper-body / torso biomechanical absorption of recoil torque & axial kick
      const absorbGain = THREE.MathUtils.lerp(1.05, 0.46, cheekWeld) * caliberPunchBoost;
      this.torsoAbsorbPitchVel += (pitchRad * 2.35 + kickBackM * 1.8) * absorbGain * climbBreathScale;
      this.torsoAbsorbYawVel += yawJitter * 1.95 * absorbGain * driftBreathScale;

      if (camShakeGain > 0.001) {
        this.camShakePitchVel +=
          pitchRad * 28.5 * camShakeGain * THREE.MathUtils.lerp(1.0, 0.82, this.holdBreathBlend);
        this.camShakeYawVel +=
          (yawJitter * 23.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 11.5) *
          camShakeGain *
          THREE.MathUtils.lerp(1.0, 0.65, this.holdBreathBlend);
        this.camShakeRollVel +=
          (yawJitter * 18.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 16.5) * camShakeGain;
        this.camShakePosXVel +=
          ((Math.random() - 0.5) * 0.18 + yawJitter * 2.6) * camShakeGain;
        this.camShakePosYVel +=
          (kickBackM * 5.4 + Math.abs(pitchRad) * 2.5) * camShakeGain;
      }

      // Free-aim climb: looser upward climb in Hip-Fire, tighter shoulder-braced climb in ADS (~30% mitigated while holding breath)
      const freeAimClimbScale = THREE.MathUtils.lerp(1.14, 0.70, cheekWeld) * climbBreathScale;
      const maxAimForStop = this.lastMaxWeaponPitchRad - this.getWeaponRootPitch();
      this.aimPitch = Math.min(
        0.24,
        maxAimForStop,
        this.aimPitch + pitchRad * 0.23 * freeAimClimbScale,
      );
    } else {
      // Non-firearm physical shock (melee strikes, blast waves, damage flinch):
      // always deliver authentic full camera shock regardless of aim stance
      this.sympPitchVel += pitchRad * 0.22 * 24;
      this.sympYawVel += yawJitter * 0.2 * 20;
      this.camShakePitchVel += pitchRad * 16.0;
      this.camShakeYawVel += yawJitter * 14.0;
      this.camShakeRollVel += (yawJitter * 12.0 + (Math.random() - 0.5) * Math.abs(pitchRad) * 10.0);

      const maxAimForStop = this.lastMaxWeaponPitchRad - this.getWeaponRootPitch();
      this.aimPitch = Math.min(0.24, maxAimForStop, this.aimPitch + pitchRad * 0.22);
    }

    // Exertion bump
    this.exertion = Math.min(
      BREATH_SWAY_CONFIG.exertionMax,
      this.exertion + BREATH_SWAY_CONFIG.exertionRecoilGain,
    );
  }

  /**
   * Involuntary 0.3°–0.6° adrenaline micro-flinch when a supersonic round passes razor-close (< 1.2m).
   * Feeds strictly into the fast-settling camera roll/pitch spring (omega=26/28, zeta=0.70/0.72)
   * without shifting aimYaw or aimPitch.
   */
  public applyBallisticMicroFlinch(flinchDeg: number, sideSign = 1): void {
    const clampedDeg = THREE.MathUtils.clamp(flinchDeg, 0.3, 0.6);
    const flinchRad = THREE.MathUtils.degToRad(clampedDeg);
    // Flinch slightly away from the side of the supersonic shockwave cone
    const awayDir = sideSign >= 0 ? -1 : 1;
    // Calibrated against spring peak factor (exp(-zeta/sqrt(1-zeta^2)*acos(zeta))/omega ~= 0.0176)
    // so peak camera roll lands cleanly at ~0.92 * flinchDeg (0.3°–0.6°) and pitch dips ~0.42 * flinchDeg
    this.camShakeRollVel += awayDir * flinchRad * 52.0;
    this.camShakePitchVel -= flinchRad * 26.0;
    this.exertion = Math.min(BREATH_SWAY_CONFIG.exertionMax, this.exertion + 0.035);
  }

  private stepCriticallyDamped(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dt: number,
  ): [number, number] {
    return stepAnalyticalDampedSpring(val, vel, target, omega, 1.0, dt);
  }

  private stepDampedSpring(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dampingRatio: number,
    dt: number,
  ): [number, number] {
    return stepAnalyticalDampedSpring(val, vel, target, omega, dampingRatio, dt);
  }

  private stepExactCriticallyDamped(
    val: number,
    vel: number,
    target: number,
    omega: number,
    dt: number,
  ): [number, number] {
    return stepAnalyticalDampedSpring(val, vel, target, omega, 1.0, dt);
  }

  public getWhipVelocity(out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.whipVelX, this.whipVelY);
  }

  public getCurrentLean(): number {
    return this.currentLean;
  }

  public getEyeHeight(): number {
    return this.currentHeight;
  }

  public getStepSmoothOffsetY(): number {
    return this.stepSmoothOffsetY;
  }

  public getChestHeight(): number {
    return this.currentHeight + this.stepSmoothOffsetY;
  }

  public getWorldLookDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
  }

  public update(
    delta: number,
    elapsed: number,
    input: Readonly<BodycamInputState>,
    adapter: IBodycamWorldAdapter,
    weaponProfile: BodycamWeaponProfile,
    config: Readonly<BodycamSDKConfig>,
    stamina = 1.0,
    health = 100,
    onStaminaDrain?: (amount: number) => void,
    survivalMods?: Readonly<BodycamSurvivalModifiers>,
  ): void {
    const dt = Math.min(delta, 0.05);
    const trauma: Readonly<BodycamTraumaModifiers> | undefined = adapter.getTraumaModifiers?.();

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

    if (this.doubleSpaceTimerSec > 0) {
      this.doubleSpaceTimerSec = Math.max(0, this.doubleSpaceTimerSec - dt);
    }

    const spacePressed = Boolean(input.vault);
    const spaceEdge = spacePressed && !this.prevVaultPressed;
    this.prevVaultPressed = spacePressed;

    let isDoubleSpace = Boolean(input.vaultSpin);
    if (spaceEdge) {
      if (this.doubleSpaceTimerSec > 0) {
        isDoubleSpace = true;
        this.doubleSpaceTimerSec = 0;
      } else {
        this.doubleSpaceTimerSec = 0.28;
      }
    }

    const pickSpinDir = (): -1 | 1 => {
      if (input.left && !input.right) return 1;
      if (input.right && !input.left) return -1;
      const d = this.spinDirToggle;
      this.spinDirToggle = (this.spinDirToggle === 1 ? -1 : 1);
      return d;
    };

    if (this.vaultController.isActive() && isDoubleSpace) {
      this.vaultController.upgradeToSpinVault(pickSpinDir());
    }

    // 0. Grounded Tactical Vault / Mantle Trigger (Space while moving forward or airborne near a ledge;
    //    double-tap Space triggers a full 360-degree spinning tactical vault over the obstacle)
    let triggeredVaultThisFrame = false;
    if (
      !this.vaultController.isActive() &&
      this.vaultCooldownSec <= 0 &&
      (spacePressed || isDoubleSpace) &&
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
        this.vaultController.start(
          this._vaultCandidate,
          trauma,
          survivalMods,
          this.crouched,
          isDoubleSpace,
          isDoubleSpace ? pickSpinDir() : 1,
        );
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

    // 1. Overhead clearance lock (prevents standing up inside low crouch tunnels)
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

    // Trigger subtle tactical vest/gear rattle on crouch <-> stand transitions
    if (this.crouched !== this.wasCrouched) {
      this.audio.playGearRattle('crouch', 0.85);
      this.wasCrouched = this.crouched;
    }

    // 2. Decoupled Aim Action (RMB) + Armed Aim Mode (PRIMARY | CANTED | POINT_AIM)
    // Toggling MMB or B never lifts the firearm on its own; RMB released ALWAYS returns to HIP.
    const isFirearm =
      weaponProfile.holdClass === 'pistol' ||
      weaponProfile.holdClass === 'rifle' ||
      weaponProfile.holdClass === 'shotgun';
    const canAimWeapon = isFirearm && !vaulting;
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

    // Preserve subtle glance freedom (±42° around vault heading) while climbing without full 180° torso twist
    if (vaulting) {
      const heading = this.vaultController.getVaultHeadingYaw();
      let relYaw = this.targetTorsoYaw - heading;
      while (relYaw > Math.PI) relYaw -= TWO_PI;
      while (relYaw < -Math.PI) relYaw += TWO_PI;
      const nearestHeading = this.targetTorsoYaw - relYaw;
      const maxGlanceRad = THREE.MathUtils.degToRad(42);
      const clampedRel = THREE.MathUtils.clamp(relYaw, -maxGlanceRad, maxGlanceRad);
      this.targetTorsoYaw = nearestHeading + clampedRel;
      this.targetTorsoPitch = THREE.MathUtils.clamp(this.targetTorsoPitch, -0.78, 0.72);
    }

    // 3. 2nd-order critically damped chest torso spring + World-Aim-Preserving Lagged Bodycam Recenter
    // In Hipfire, the chest camera only follows boundary overflow (unchanged).
    // In Primary ADS, Canted Optic ADS, and Point Aim, the weapon leads 1:1 on mouse movement while
    // the chest-mounted camera smoothly lags behind and recenters onto `goal = targetTorso + aimLead`,
    // subtracting the exact torso step from `aimLead` so the world sightline NEVER drifts off target.
    const aimingNow = this.isAds || this.isCanted || this.isPointAim;
    const magScope = this.isAds && this.weaponRig.isMagnifiedOpticActive();
    const omega =
      config.torsoFollowStiffness *
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
    [this.sympPitch, this.sympPitchVel] = this.stepCriticallyDamped(
      this.sympPitch,
      this.sympPitchVel,
      0,
      14,
      dt,
    );
    [this.sympYaw, this.sympYawVel] = this.stepCriticallyDamped(
      this.sympYaw,
      this.sympYawVel,
      0,
      14,
      dt,
    );

    // Fast, crisp cheek-weld camera shake springs (slightly underdamped for tactile settle)
    [this.camShakePitch, this.camShakePitchVel] = this.stepDampedSpring(
      this.camShakePitch,
      this.camShakePitchVel,
      0,
      28,
      0.72,
      dt,
    );
    [this.camShakePitch, this.camShakePitchVel] = clampSpringState(
      this.camShakePitch,
      this.camShakePitchVel,
      -0.08,
      0.08,
    );
    [this.camShakeYaw, this.camShakeYawVel] = this.stepDampedSpring(
      this.camShakeYaw,
      this.camShakeYawVel,
      0,
      30,
      0.68,
      dt,
    );
    [this.camShakeYaw, this.camShakeYawVel] = clampSpringState(
      this.camShakeYaw,
      this.camShakeYawVel,
      -0.06,
      0.06,
    );
    [this.camShakeRoll, this.camShakeRollVel] = this.stepDampedSpring(
      this.camShakeRoll,
      this.camShakeRollVel,
      0,
      26,
      0.70,
      dt,
    );
    [this.camShakeRoll, this.camShakeRollVel] = clampSpringState(
      this.camShakeRoll,
      this.camShakeRollVel,
      -0.05,
      0.05,
    );
    [this.camShakePosX, this.camShakePosXVel] = this.stepDampedSpring(
      this.camShakePosX,
      this.camShakePosXVel,
      0,
      32,
      0.72,
      dt,
    );
    [this.camShakePosX, this.camShakePosXVel] = clampSpringState(
      this.camShakePosX,
      this.camShakePosXVel,
      -0.012,
      0.012,
    );
    [this.camShakePosY, this.camShakePosYVel] = this.stepDampedSpring(
      this.camShakePosY,
      this.camShakePosYVel,
      0,
      32,
      0.72,
      dt,
    );
    [this.camShakePosY, this.camShakePosYVel] = clampSpringState(
      this.camShakePosY,
      this.camShakePosYVel,
      -0.012,
      0.012,
    );

    const sinY = Math.sin(this.torsoYaw);
    const cosY = Math.cos(this.torsoYaw);

    let wantsSprint = false;
    let rawTargetSpeed = 3.05;
    let horizSpeed = 0;
    let isMoving = false;
    let localStrafeVel = 0;

    if (vaulting) {
      // Temporary Grounded Vault / Mantle Traversal Override
      this.isSprinting = false;
      this.velX = 0;
      this.velY = 0;
      this.velZ = 0;
      this.steppedUpLastFrame = false;
      this.slopeAngleRad = 0;
      this.grounded = false;

      const vaultDone = this.vaultController.update(dt, this.position, adapter, this.audio);
      if (vaultDone.completed) {
        this.vaultCooldownSec = 0.28;
        this.doubleSpaceTimerSec = 0;
        if (vaultDone.mustCrouch) {
          this.wantCrouch = true;
          this.crouched = true;
          this.wasCrouched = true;
        } else {
          // Restore standing cleanly after window breach if player was standing before vaulting
          // (overhead clearance check on the next frame will still keep crouched if ceiling is low)
          this.wantCrouch = false;
          this.crouched = false;
          this.wasCrouched = false;
        }
        // Final zero-stuck grounding snap onto validated destination capsule
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

        // Realistic touchdown knee-compression suspension & exertion spike
        const shockAmp = vaultDone.landingShockAmp * config.landingShockScale;
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
      [this.strafeDip, this.strafeDipVel] = this.stepCriticallyDamped(
        this.strafeDip,
        this.strafeDipVel,
        0,
        14,
        dt,
      );
      [this.kneeShock, this.kneeShockVel] = this.stepCriticallyDamped(
        this.kneeShock,
        this.kneeShockVel,
        0,
        12,
        dt,
      );
      [this.landingDipY, this.landingDipVel] = this.stepDampedSpring(
        this.landingDipY,
        this.landingDipVel,
        0,
        7.4,
        0.88,
        dt,
      );
      this.landingDipY = THREE.MathUtils.clamp(this.landingDipY, -0.42, 0.08);
      [this.landingPitch, this.landingPitchVel] = this.stepDampedSpring(
        this.landingPitch,
        this.landingPitchVel,
        0,
        8.8,
        0.88,
        dt,
      );
      [this.landingRoll, this.landingRollVel] = this.stepDampedSpring(
        this.landingRoll,
        this.landingRollVel,
        0,
        8.6,
        0.88,
        dt,
      );
      [this.takeoffHeave, this.takeoffHeaveVel] = this.stepCriticallyDamped(
        this.takeoffHeave,
        this.takeoffHeaveVel,
        0,
        13,
        dt,
      );
    } else {
      // 4. Realistic Ground Momentum + Strafe Reversal Weight-Transfer Dip
      let moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let moveZ = (input.backward ? 1 : 0) - (input.forward ? 1 : 0);
      const hasMoveInput = moveX !== 0 || moveZ !== 0;
      if (hasMoveInput) {
        const len = Math.hypot(moveX, moveZ);
        moveX /= len;
        moveZ /= len;
      }

      const canSprintTrauma =
        (trauma ? trauma.canSprint : true) && (survivalMods ? survivalMods.canSprint : true);
      wantsSprint =
        canSprintTrauma &&
        input.sprint &&
        hasMoveInput &&
        !this.crouched &&
        !isAiming &&
        stamina > 0.08 &&
        moveZ < 0.2;
      this.isSprinting = wantsSprint;
      if (wantsSprint && onStaminaDrain) {
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

      // Ground momentum damping (snappier on ground, realistic constrained air steering mid-jump)
      const accelLambda = this.grounded
        ? (hasMoveInput ? config.groundAccel : config.groundDecel) * moveAccelMult
        : hasMoveInput
          ? AIR_ACCEL_LAMBDA
          : 0.45;
      this.velX = THREE.MathUtils.damp(this.velX, desiredVelX, accelLambda, dt);
      this.velZ = THREE.MathUtils.damp(this.velZ, desiredVelZ, accelLambda, dt);
      horizSpeed = Math.hypot(this.velX, this.velZ);
      isMoving = horizSpeed > 0.14;

      // Detect lateral strafe reversal -> subtle weight-transfer dip & roll pulse
      localStrafeVel = this.velX * cosY - this.velZ * sinY;
      if (
        this.grounded &&
        hasMoveInput &&
        Math.abs(moveX) > 0.35 &&
        Math.abs(this.prevLocalStrafeVel) > 0.9 &&
        Math.sign(moveX) !== Math.sign(this.prevLocalStrafeVel)
      ) {
        const reversalEnergy = THREE.MathUtils.clamp(Math.abs(this.prevLocalStrafeVel) / 3.2, 0.35, 1.2);
        this.strafeDipVel -= 0.24 * reversalEnergy * config.strafeWeightDipStrength;
        this.heelRollVel += Math.sign(moveX) * 0.16 * reversalEnergy * config.strafeWeightDipStrength;
      }
      this.prevLocalStrafeVel = localStrafeVel;
      [this.strafeDip, this.strafeDipVel] = this.stepCriticallyDamped(
        this.strafeDip,
        this.strafeDipVel,
        0,
        14,
        dt,
      );

      // 4b. Grounded Realistic Tactical Jump (Space edge when no vault candidate was triggered)
      if (
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

            // Small athletic horizontal carry-through on push-off
            if (hasMoveInput) {
              this.velX *= 1.04;
              this.velZ *= 1.04;
            }

            // Takeoff camera heave impulse (smooth upward body surge)
            this.takeoffHeaveVel += 0.52;
            this.landingDipVel -= 0.22; // quick pre-launch crouch spring feel

            // Stamina, exertion, foley & stealth acoustics
            if (onStaminaDrain) {
              onStaminaDrain(0.11 * (survivalMods ? survivalMods.staminaDrainMult : 1.0));
            }
            if (health > 0) {
              const exMult = survivalMods ? survivalMods.exertionRateMult : 1.0;
              this.exertion = Math.min(
                BREATH_SWAY_CONFIG.exertionMax,
                this.exertion + 0.085 * exMult,
              );
            }
            this.audio.playBootScuff(this.currentSurface, 0.92);
            this.audio.playGearRattle('vault', 0.72);
            adapter.emitAcousticEvent?.(this.position, 11, 'vault_low');
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
        // Gentle downward stick force so walking down slopes stays cleanly grounded
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
        this.grounded ? config.maxStepUpM : 0.06,
        this._sweepOut,
      );

      this.position.set(this._sweepOut.posX, this._sweepOut.posY, this._sweepOut.posZ);
      this.grounded = this._sweepOut.grounded;
      this.slopeAngleRad = this._sweepOut.slopeAngleRad;
      this.steppedUpLastFrame = this._sweepOut.steppedUp;

      // Remove velocity component into a solid wall so diagonal sliding feels crisp
      if (this._sweepOut.hitWall) {
        const vn = this.velX * this._sweepOut.wallNormalX + this.velZ * this._sweepOut.wallNormalZ;
        if (vn < 0) {
          this.velX -= vn * this._sweepOut.wallNormalX;
          this.velZ -= vn * this._sweepOut.wallNormalZ;
        }
      }

      // C1-continuous critically damped vertical chest-cam glide on stair/curb step-up & step-down
      // (preserves vertical velocity across risers so climbing stairs never exhibits velocity kinks)
      if (Math.abs(this._sweepOut.stepDeltaY) > 0.005) {
        const nextOffset = this.stepSmoothOffsetY - this._sweepOut.stepDeltaY;
        this.stepSmoothOffsetY = THREE.MathUtils.clamp(nextOffset, -0.55, 0.55);
        if (this._sweepOut.steppedUp && this._sweepOut.stepDeltaY > 0.005) {
          // Subtle weight cue on isolated curbs only; avoid high-frequency pitch chatter on consecutive stairs
          if (elapsed - this.lastStepUpElapsed > 0.38) {
            this.heelPitchVel -= Math.min(0.08, this._sweepOut.stepDeltaY * 0.25);
          }
          this.lastStepUpElapsed = elapsed;
        }
      }
      const stepOmega = Math.max(6.0, config.stepSmoothSpeed);
      [this.stepSmoothOffsetY, this.stepSmoothVelY] = this.stepExactCriticallyDamped(
        this.stepSmoothOffsetY,
        this.stepSmoothVelY,
        0,
        stepOmega,
        dt,
      );
      if (Math.abs(this.stepSmoothOffsetY) < 1e-4 && Math.abs(this.stepSmoothVelY) < 1e-4) {
        this.stepSmoothOffsetY = 0;
        this.stepSmoothVelY = 0;
      }

      // Smooth physics-to-camera interpolated landing suspension proportional to vertical impact velocity
      if (this.grounded) {
        if (!wasGrounded) {
          this.doubleSpaceTimerSec = 0;
        }
        const impactSpeed = Math.max(Math.abs(preVelY), this.peakFallSpeed);
        if (!wasGrounded && (impactSpeed > 1.5 || this.airTimeSec > 0.14)) {
          const effImpact = Math.max(impactSpeed, 2.2);
          const impactNorm =
            THREE.MathUtils.clamp((effImpact - 1.1) / 5.8, 0.24, 1.45) * config.landingShockScale;

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
          adapter.emitAcousticEvent?.(this.position, 12 + effImpact * 2.5, 'landing');

          if (health > 0) {
            this.exertion = Math.min(
              BREATH_SWAY_CONFIG.exertionMax,
              this.exertion +
                BREATH_SWAY_CONFIG.exertionLandingGain *
                  THREE.MathUtils.clamp(effImpact * 0.28, 0.3, 1.5),
            );
          }
        }
        this.velY = 0;
        this.airTimeSec = 0;
        this.jumpInitiated = false;
        this.peakFallSpeed = 0;
      } else if (this._sweepOut.hitCeiling && this.velY > 0) {
        this.velY = 0;
      }

      [this.kneeShock, this.kneeShockVel] = this.stepCriticallyDamped(
        this.kneeShock,
        this.kneeShockVel,
        0,
        12,
        dt,
      );
      [this.landingDipY, this.landingDipVel] = this.stepDampedSpring(
        this.landingDipY,
        this.landingDipVel,
        0,
        7.4,
        0.88,
        dt,
      );
      this.landingDipY = THREE.MathUtils.clamp(this.landingDipY, -0.42, 0.08);
      [this.landingPitch, this.landingPitchVel] = this.stepDampedSpring(
        this.landingPitch,
        this.landingPitchVel,
        0,
        8.8,
        0.88,
        dt,
      );
      [this.landingRoll, this.landingRollVel] = this.stepDampedSpring(
        this.landingRoll,
        this.landingRollVel,
        0,
        8.6,
        0.88,
        dt,
      );
      [this.takeoffHeave, this.takeoffHeaveVel] = this.stepCriticallyDamped(
        this.takeoffHeave,
        this.takeoffHeaveVel,
        0,
        13,
        dt,
      );
    }

    // Sample current ground material & interior/exterior acoustics
    this.currentSurface = adapter.getSurfaceMaterial(
      this.position.x,
      this.position.y,
      this.position.z,
    );
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
    let maxAllowedLean = config.leanMaxOffsetM;
    this.leanClamped = false;
    if (leanInput !== 0) {
      this._chestPos.set(
        this.position.x,
        this.position.y + this.currentHeight + this.stepSmoothOffsetY,
        this.position.z,
      );
      this._leanDir
        .set(cosY * leanInput, 0, -sinY * leanInput)
        .normalize();
      maxAllowedLean = computeSphereSweptLeanClearance(
        adapter,
        this._chestPos,
        this._leanDir,
        this.torsoYaw,
        config.leanMaxOffsetM,
        config.leanClearanceRadiusM,
      );
      this.leanClamped = maxAllowedLean < config.leanMaxOffsetM - 0.01;
    }
    const prevLean = this.currentLean;
    const targetLean = leanInput * Math.min(config.leanMaxOffsetM, maxAllowedLean);
    this.currentLean = THREE.MathUtils.damp(this.currentLean, targetLean, 12, dt);
    const leanVel = THREE.MathUtils.clamp((this.currentLean - prevLean) / Math.max(dt, 0.001), -2.5, 2.5);
    const lateralParallaxMotion = THREE.MathUtils.clamp(localStrafeVel + leanVel * 1.45, -4.0, 4.0);
    const leanRoll =
      -(this.currentLean / Math.max(0.05, config.leanMaxOffsetM)) *
      THREE.MathUtils.degToRad(config.leanMaxRollDeg);

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
      // Running speeds up cadence sharply (~3.45 steps/s vs ~2.18 steps/s walking)
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
        // Soft micro-accent layered subtly beneath the continuous smooth headbob
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
        adapter.emitAcousticEvent?.(this.position, acousticRadius, acousticKind);
      }
    } else if (this.grounded) {
      this.strideProgress = 0.72;
    }

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

    [this.heelDrop, this.heelDropVel] = this.stepCriticallyDamped(
      this.heelDrop,
      this.heelDropVel,
      0,
      13,
      dt,
    );
    [this.heelPitch, this.heelPitchVel] = this.stepCriticallyDamped(
      this.heelPitch,
      this.heelPitchVel,
      0,
      14,
      dt,
    );
    [this.heelRoll, this.heelRollVel] = this.stepCriticallyDamped(
      this.heelRoll,
      this.heelRollVel,
      0,
      11,
      dt,
    );

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
    [this.torsoAbsorbPitch, this.torsoAbsorbPitchVel] = clampSpringState(
      this.torsoAbsorbPitch,
      this.torsoAbsorbPitchVel,
      -0.025,
      0.036,
    );
    [this.torsoAbsorbYaw, this.torsoAbsorbYawVel] = clampSpringState(
      this.torsoAbsorbYaw,
      this.torsoAbsorbYawVel,
      -0.030,
      0.030,
    );

    // 8. PRESERVED Lifecycle-Safe Procedural Breathing Sway & 7.0s Hold-Breath Reserve/Cooldown
    const gapDetected = this.lastUpdateElapsed < 0 || Math.abs(elapsed - this.lastUpdateElapsed) > 0.25;
    this.lastUpdateElapsed = elapsed;
    if (gapDetected) {
      this.breathPhase = 0;
      this.weaponDriftPhase = 0;
      this.swayEnvelope = 0;
    }

    const HOLD_BREATH_MAX_SEC = 7.0;
    const HOLD_BREATH_COOLDOWN_SEC = 3.0;
    const HOLD_BREATH_REBOUND_SEC = 2.4;

    if (this.holdBreathCooldownSec > 0) {
      this.holdBreathCooldownSec = Math.max(0, this.holdBreathCooldownSec - dt);
    }
    if (this.holdBreathReboundSec > 0) {
      this.holdBreathReboundSec = Math.max(0, this.holdBreathReboundSec - dt);
    }

    const inAimStance = this.isAds || this.isCanted || this.isPointAim;
    const hasBreathReserve = this.holdBreathActive
      ? this.holdBreathRemainingSec > 0.001
      : this.holdBreathRemainingSec > 0.15;
    const canHoldBreath =
      health > 0 &&
      inAimStance &&
      input.holdBreath &&
      !wantsSprint &&
      this.holdBreathCooldownSec <= 0 &&
      hasBreathReserve &&
      stamina > 0.12;

    if (canHoldBreath) {
      if (!this.holdBreathActive) {
        this.holdBreathActive = true;
        this.lowBreathPulseTimer = 0.25;
        this.audio.playBreathCue?.('inhale', 0.92);
      }
      this.holdBreathHeldSec += dt;
      this.holdBreathRemainingSec = Math.max(0, this.holdBreathRemainingSec - dt);

      const reserveFrac = this.holdBreathRemainingSec / HOLD_BREATH_MAX_SEC;
      if (reserveFrac < 0.35 && this.holdBreathRemainingSec > 0.001) {
        this.lowBreathPulseTimer -= dt;
        if (this.lowBreathPulseTimer <= 0) {
          const urgency = THREE.MathUtils.clamp((0.35 - reserveFrac) / 0.35, 0, 1);
          this.audio.playBreathCue?.('low_o2_pulse', 0.45 + urgency * 0.55);
          this.lowBreathPulseTimer = THREE.MathUtils.lerp(0.92, 0.58, urgency);
        }
      }

      if (this.holdBreathRemainingSec <= 0.001) {
        this.holdBreathActive = false;
        this.holdBreathCooldownSec = HOLD_BREATH_COOLDOWN_SEC;
        this.holdBreathReboundSec = HOLD_BREATH_REBOUND_SEC;
        this.holdBreathHeldSec = 0;
        this.exertion = Math.min(BREATH_SWAY_CONFIG.exertionMax, this.exertion + 0.32);
        this.audio.playBreathCue?.('exhale_depleted', 1.0);
      }
    } else {
      if (this.holdBreathActive) {
        this.holdBreathActive = false;
        if (this.holdBreathHeldSec >= 0.35) {
          const frac = THREE.MathUtils.clamp(this.holdBreathHeldSec / HOLD_BREATH_MAX_SEC, 0.15, 1.0);
          this.holdBreathReboundSec = HOLD_BREATH_REBOUND_SEC * (0.35 + 0.65 * frac);
          this.exertion = Math.min(BREATH_SWAY_CONFIG.exertionMax, this.exertion + 0.10 + 0.16 * frac);
          this.audio.playBreathCue?.('exhale', 0.72 + frac * 0.28);
        }
        this.holdBreathHeldSec = 0;
      }

      const recoveryRate = (this.holdBreathCooldownSec > 0 ? 0.52 : 0.92) + 0.38 * stamina;
      this.holdBreathRemainingSec = Math.min(
        HOLD_BREATH_MAX_SEC,
        this.holdBreathRemainingSec + recoveryRate * dt,
      );
    }

    this.holdBreathBlend = THREE.MathUtils.damp(
      this.holdBreathBlend,
      this.holdBreathActive ? 1 : 0,
      this.holdBreathActive ? 8.5 : 6.5,
      dt,
    );

    // Subtle diegetic edge vignette (focus darkening -> low-O2 gentle edge pulse -> cooldown taper)
    let targetBreathVignette = 0;
    if (this.holdBreathActive) {
      const reserveFrac = this.holdBreathRemainingSec / HOLD_BREATH_MAX_SEC;
      const lowUrgency = reserveFrac < 0.35 ? THREE.MathUtils.clamp((0.35 - reserveFrac) / 0.35, 0, 1) : 0;
      const lowPulse = lowUrgency * (0.28 + 0.24 * (0.5 + 0.5 * Math.sin(elapsed * 7.2)));
      targetBreathVignette = THREE.MathUtils.clamp(0.38 * this.holdBreathBlend + lowPulse, 0, 0.92);
    } else if (this.holdBreathCooldownSec > 0) {
      const cdFrac = this.holdBreathCooldownSec / HOLD_BREATH_COOLDOWN_SEC;
      targetBreathVignette = cdFrac * (0.22 + 0.16 * (0.5 + 0.5 * Math.sin(elapsed * 5.6)));
    }
    this.breathVignette = THREE.MathUtils.damp(this.breathVignette, targetBreathVignette, 7.0, dt);

    const swayActive = health > 0;
    if (!swayActive) {
      this.swayEnvelope = THREE.MathUtils.damp(
        this.swayEnvelope,
        0,
        BREATH_SWAY_CONFIG.recoveryEnvelopeLambda * 2,
        dt,
      );
      this.exertion = 0;
      this.breathPhase = 0;
      this.weaponDriftPhase = 0;
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

      const satExertion = saturatingCurve(
        this.exertion / BREATH_SWAY_CONFIG.exertionMax,
        BREATH_SWAY_CONFIG.falloffShapeK,
      );

      const targetFreqHz = Math.min(
        BREATH_SWAY_CONFIG.maxFreqHz,
        BREATH_SWAY_CONFIG.baseFreqHz +
          satExertion * (BREATH_SWAY_CONFIG.maxFreqHz - BREATH_SWAY_CONFIG.baseFreqHz),
      );
      this.smoothedFreqHz = THREE.MathUtils.clamp(
        THREE.MathUtils.damp(this.smoothedFreqHz, targetFreqHz, BREATH_SWAY_CONFIG.freqSmoothingLambda, dt),
        BREATH_SWAY_CONFIG.baseFreqHz,
        BREATH_SWAY_CONFIG.maxFreqHz,
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
      const targetAmpMult = Math.min(
        BREATH_SWAY_CONFIG.maxCombinedAmpMult,
        1.0 + satStress * (BREATH_SWAY_CONFIG.maxCombinedAmpMult - 1.0),
      );

      this.smoothedAmpMult = THREE.MathUtils.clamp(
        THREE.MathUtils.damp(this.smoothedAmpMult, targetAmpMult, BREATH_SWAY_CONFIG.ampSmoothingLambda, dt),
        1.0,
        BREATH_SWAY_CONFIG.maxCombinedAmpMult,
      );

      this.swayEnvelope = THREE.MathUtils.damp(
        this.swayEnvelope,
        1.0,
        BREATH_SWAY_CONFIG.recoveryEnvelopeLambda,
        dt,
      );

      // Phase-continuous integration
      this.breathPhase += dt * TWO_PI * this.smoothedFreqHz;
      if (this.breathPhase > TWO_PI * 1000) this.breathPhase %= TWO_PI * 1000;
      this.weaponDriftPhase += dt * TWO_PI * (this.smoothedFreqHz * BREATH_SWAY_CONFIG.weaponDriftFreqRatio);
      if (this.weaponDriftPhase > TWO_PI * 1000) this.weaponDriftPhase %= TWO_PI * 1000;
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

    // Breath sway reaches exact 0% when breath is held; locomotion headbob remains 100% intact.
    // Releasing/depleting injects temporary post-hold rebound sway.
    const holdBreathFactor = Math.max(0, 1 - this.holdBreathBlend);
    const reboundMult =
      !this.holdBreathActive && this.holdBreathReboundSec > 0
        ? 1 + (this.holdBreathReboundSec / 2.4) * 0.45
        : 1.0;
    const swayMult =
      (trauma ? trauma.swayAmpMult : 1.0) *
      (survivalMods ? survivalMods.swayAmpMult : 1.0) *
      reboundMult *
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

    const tremorAmp = trauma ? Math.min(MAX_TRAUMA_TREMOR_RAD, trauma.tremorAmp) : 0;
    const tremorPitch =
      tremorAmp > 0
        ? Math.sin(elapsed * 19.3) * tremorAmp * 0.65 + Math.cos(elapsed * 29.7) * tremorAmp * 0.35
        : 0;
    const tremorYaw =
      tremorAmp > 0
        ? Math.cos(elapsed * 21.1 + 0.8) * tremorAmp * 0.65 + Math.sin(elapsed * 33.4) * tremorAmp * 0.35
        : 0;

    const swayPosX = THREE.MathUtils.clamp(
      camOscX * BREATH_SWAY_CONFIG.camBasePosXMeters * camSwayScale,
      -BREATH_SWAY_CONFIG.camMaxPosMeters,
      BREATH_SWAY_CONFIG.camMaxPosMeters,
    );
    const swayPosY = THREE.MathUtils.clamp(
      camOscY * BREATH_SWAY_CONFIG.camBasePosYMeters * camSwayScale,
      -BREATH_SWAY_CONFIG.camMaxPosMeters,
      BREATH_SWAY_CONFIG.camMaxPosMeters,
    );
    const swayPitch = THREE.MathUtils.clamp(
      camOscY * BREATH_SWAY_CONFIG.camBaseRotPitchRad * camSwayScale + tremorPitch,
      -BREATH_SWAY_CONFIG.camMaxRotRad - MAX_TRAUMA_TREMOR_RAD,
      BREATH_SWAY_CONFIG.camMaxRotRad + MAX_TRAUMA_TREMOR_RAD,
    );
    const swayYaw = THREE.MathUtils.clamp(
      camOscX * BREATH_SWAY_CONFIG.camBaseRotYawRad * camSwayScale + tremorYaw,
      -BREATH_SWAY_CONFIG.camMaxRotRad - MAX_TRAUMA_TREMOR_RAD,
      BREATH_SWAY_CONFIG.camMaxRotRad + MAX_TRAUMA_TREMOR_RAD,
    );
    const swayRoll = THREE.MathUtils.clamp(
      camOscRoll * BREATH_SWAY_CONFIG.camBaseRotRollRad * camSwayScale,
      -BREATH_SWAY_CONFIG.camMaxRotRad,
      BREATH_SWAY_CONFIG.camMaxRotRad,
    );

    // Separate lower-frequency, phase-offset weapon drift
    const wp = this.weaponDriftPhase;
    const wepScale =
      this.swayEnvelope *
      this.smoothedAmpMult *
      swayMult *
      (this.isAds
        ? BREATH_SWAY_CONFIG.adsWeaponDriftScale
        : this.isCanted
          ? 0.54
          : this.isPointAim
            ? 0.68
            : 1.0);
    const breathX = THREE.MathUtils.clamp(
      (Math.sin(wp + 1.73) * 0.65 + Math.cos(wp * 1.61 + 0.52) * 0.35) *
        BREATH_SWAY_CONFIG.weaponBaseDriftXMeters *
        wepScale,
      -BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 1.6,
      BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 1.6,
    );
    const breathY = THREE.MathUtils.clamp(
      (Math.sin(wp * 0.89 + 2.89) * 0.70 + Math.sin(wp * 2.19 + 1.11) * 0.30) *
        BREATH_SWAY_CONFIG.weaponBaseDriftYMeters *
        wepScale,
      -BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 1.6,
      BREATH_SWAY_CONFIG.weaponMaxDriftMeters * 1.6,
    );
    this.lastBreathX = breathX;
    this.lastBreathY = breathY;

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
      this.currentHeight +
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

    // Hard overhead lintel cap during window breach/vaults so head/camera NEVER clip into the wall above the window
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
      swayPitch;
    const baseChestYaw =
      this.torsoYaw +
      activeVaultState.spinYawOffset +
      this.sympYaw +
      this.torsoAbsorbYaw * 0.35 +
      swayYaw;
    const baseChestRoll =
      leanRoll +
      this.strafeRoll +
      this.strideBobRoll +
      this.jumpBobRoll +
      this.landingRoll +
      this.heelRoll +
      activeVaultState.cameraRollOffset +
      activeVaultState.spinRollOffset +
      swayRoll;

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

    // Measure angular whip velocity for shutter motion-blur
    const safeDt = Math.max(0.004, dt);
    const rawWhipX = (chestYaw - this.prevChestYaw) / safeDt;
    const rawWhipY = (chestPitch - this.prevChestPitch) / safeDt;
    this.prevChestYaw = chestYaw;
    this.prevChestPitch = chestPitch;
    this.whipVelX = THREE.MathUtils.damp(this.whipVelX, rawWhipX, 22, dt);
    this.whipVelY = THREE.MathUtils.damp(this.whipVelY, rawWhipY, 22, dt);
    this.angularWhipRadPerSec = Math.hypot(this.whipVelX, this.whipVelY);

    this._aimEuler.set(chestPitch, chestYaw, chestRoll, 'YXZ');
    this.camera.quaternion.setFromEuler(this._aimEuler);

    // Wide Horizontal FOV -> dynamic Vertical FOV
    // Primary ADS: full adsHFovDeg; Canted Optic ADS: ~0.85x CQB focus; Point Aim: ~0.90x tactical focus
    const grenadeFovCompress =
      this.grenadeThrowStyle === 'overhand' ? this.grenadeCharge01 * 3.8 : 0;
    const targetHFov = (this.isAds
      ? config.adsHFovDeg
      : this.isCanted
        ? THREE.MathUtils.lerp(config.baseHFovDeg, config.adsHFovDeg, 0.72)
        : this.isPointAim
          ? config.baseHFovDeg * 0.90
          : wantsSprint
            ? config.sprintHFovDeg
            : config.baseHFovDeg) - grenadeFovCompress;
    const targetVFov = horizontalToVerticalFov(targetHFov, this.camera.aspect);
    if (Math.abs(this.camera.fov - targetVFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetVFov, 12, dt);
      this.camera.updateProjectionMatrix();
    }

    // Update HRTF AudioListener
    this._tmpDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this._tmpUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.audio.updateListener(this.camera.position, this._tmpDir, this._tmpUp);

    // 10. Anchor WeaponRig to chest/sternum space with decoupled 1:1 free-aim orientation (zero GC)
    const chestCenter = this._chestPos.set(
      this.position.x + rightX * (this.currentLean + this.strideBobX * 0.55 + this.jumpBobX * 0.5),
      this.position.y +
        this.currentHeight +
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

    const minWepRad = THREE.MathUtils.degToRad(config.minWeaponPitchDeg ?? -50);
    const maxWepRad = THREE.MathUtils.degToRad(config.maxWeaponPitchDeg ?? 68);
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
      this.torsoYaw + activeVaultState.spinYawOffset + this.sympYaw * 0.4 + this.torsoAbsorbYaw,
      leanRoll * 0.65 +
        this.strafeRoll * 0.5 +
        this.strideBobRoll * 0.45 +
        this.jumpBobRoll * 0.5 +
        this.landingRoll * 0.5 +
        activeVaultState.cameraRollOffset * 0.55 +
        activeVaultState.spinRollOffset * 0.72,
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
      weaponProfile,
      this.aimYaw,
      clampedAimPitch,
      this.isAds,
      this.isCanted,
      wantsSprint,
      isMoving,
      this.strideProgress,
      breathX,
      breathY,
      this._weaponCamPos,
      this._weaponCamQuat,
      adapter,
      config,
      trauma ? trauma.adsSpeedMult : 1.0,
      activeVaultState.weaponRetentionMode,
      activeVaultState.weaponRetentionBlend,
      this.bobPhase,
      this.landingDipY + this.jumpBobY * 0.6,
      weaponRootPitch,
      minWepRad,
      maxWepRad,
      lateralParallaxMotion,
      this.isPointAim,
      this.holdBreathBlend,
    );
  }

  /** Populates pre-allocated POD telemetry struct without allocating */
  public writeTelemetry(
    out: BodycamTelemetry,
    avgLuminance: number,
    exposure: number,
    flashlightOn: boolean,
  ): void {
    const rig = this.weaponRig.getReadOnlyRigState();
    const profile = this.weaponRig.getWeaponProfile();
    const spinePitch = this.getSpinePitch();
    const weaponRootPitch = this.getWeaponRootPitch();
    const clampedAimPitch = this.getClampedAimPitch();

    out.posX = this.position.x;
    out.posY = this.position.y;
    out.posZ = this.position.z;
    out.velX = this.velX;
    out.velY = this.velY;
    out.velZ = this.velZ;
    out.speedMps = Math.hypot(this.velX, this.velZ);
    out.grounded = this.grounded;
    out.crouched = this.crouched;
    out.standBlockedByCeiling = this.standBlockedByCeiling;
    out.steppedUp = this.steppedUpLastFrame;
    out.stepSmoothOffsetY = this.stepSmoothOffsetY;
    out.slopeAngleDeg = THREE.MathUtils.radToDeg(this.slopeAngleRad);
    out.leanMeters = this.currentLean;
    out.leanClamped = this.leanClamped;
    out.currentSurface = this.currentSurface;
    out.isIndoor = this._interiorSample.isIndoor;
    out.isAds = this.isAds;
    out.isCanted = this.isCanted;
    out.isPointAim = this.isPointAim;
    out.aimStance = this.aimStance;
    out.armedAdsMode = this.armedAdsMode;
    out.laserOn = rig.laserOn;
    out.flashlightOn = flashlightOn;
    out.wallPullback = rig.pullbackRatio;
    out.sightMisalignDeg = rig.sightMisalignDeg;
    out.avgLuminance = avgLuminance;
    out.exposure = exposure;
    out.angularWhipRadPerSec = this.angularWhipRadPerSec;
    out.exertion = this.exertion;
    out.breathFreqHz = this.smoothedFreqHz;
    out.aimYawDeg = THREE.MathUtils.radToDeg(this.aimYaw);
    out.aimPitchDeg = THREE.MathUtils.radToDeg(clampedAimPitch);
    out.torsoYawDeg = THREE.MathUtils.radToDeg(this.torsoYaw);
    out.torsoPitchDeg = THREE.MathUtils.radToDeg(this.torsoPitch);
    out.spinePitchDeg = THREE.MathUtils.radToDeg(spinePitch);
    out.weaponPitchDeg = THREE.MathUtils.radToDeg(weaponRootPitch + clampedAimPitch);
    const vState = this.vaultController.getReadOnlyState();
    out.weaponMassKg = profile.massKg;
    out.weaponWeightClass = profile.weightClass;
    out.vaultActive = vState.active;
    out.vaultMode = vState.mode;
  }

  /** Populates pre-allocated zero-GC PdaMotionState snapshot from live locomotion, breathing, suspension & turn physics. */
  public writePdaMotionState(out: PdaMotionState): PdaMotionState {
    const horizSpeed = Math.hypot(this.velX, this.velZ);
    out.bobPhase = this.bobPhase;
    out.bobWeight = this.bobWeight;
    out.moveRatio = THREE.MathUtils.clamp(horizSpeed / 4.8, 0, 1.35);
    out.isMoving = horizSpeed > 0.14;
    out.isSprinting = this.isSprinting;
    out.isCrouched = this.crouched;
    out.breathX = this.lastBreathX;
    out.breathY = this.lastBreathY;
    out.verticalOffset =
      this.landingDipY +
      this.jumpBobY * 0.65 +
      this.heelDrop * 0.55 +
      this.kneeShock * 0.55 +
      this.takeoffHeave * 0.03;
    out.localStrafeVel = this.prevLocalStrafeVel;
    out.leanMeters = this.currentLean;
    out.turnVelYaw = this.whipVelX;
    out.turnVelPitch = this.whipVelY;
    return out;
  }
}

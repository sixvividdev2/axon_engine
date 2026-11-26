import * as THREE from 'three';
import type { GraphicsQualityId } from '../data/graphicsQuality';

export type BodycamSurfaceMaterial =
  | 'concrete'
  | 'wood'
  | 'metal'
  | 'gravel'
  | 'puddle'
  | 'grass'
  | 'asphalt'
  | 'glass';

export type BodycamAcousticKind =
  | 'footstep_crouch'
  | 'footstep_walk'
  | 'footstep_sprint'
  | 'landing'
  | 'gear_rattle'
  | 'vault_low'
  | 'mantle_heavy'
  | 'glass_shatter'
  | 'gunshot'
  | 'suppressed_gunshot'
  | 'door'
  | 'impact';

export type BodycamVaultMode = 'NONE' | 'VAULT_OVER' | 'CLIMB_ONTO' | 'HIGH_MANTLE' | 'SPIN_VAULT';

export type BodycamMeleeAttackType =
  | 'jab'
  | 'cross'
  | 'bash'
  | 'kick'
  | 'knife_slash'
  | 'knife_stab';

export type BodycamMeleeHitZone =
  | 'head'
  | 'thorax'
  | 'leftArm'
  | 'rightArm'
  | 'leftLeg'
  | 'rightLeg'
  | 'door'
  | 'glass'
  | 'world';

/** Zero-GC reusable melee/kick impact payload reported to host world adapters */
export interface BodycamMeleeHitEvent {
  attackType: BodycamMeleeAttackType;
  hitZone: BodycamMeleeHitZone;
  object: THREE.Object3D | null;
  point: THREE.Vector3;
  direction: THREE.Vector3;
  normal: THREE.Vector3;
  surface: BodycamSurfaceMaterial;
  knockbackForce: number;
  stunDurationSec: number;
  damageEnergyJ: number;
  wellPlaced: boolean;
}

export function createMeleeHitEvent(): BodycamMeleeHitEvent {
  return {
    attackType: 'jab',
    hitZone: 'world',
    object: null,
    point: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    surface: 'concrete',
    knockbackForce: 0,
    stunDurationSec: 0,
    damageEnergyJ: 0,
    wellPlaced: true,
  };
}

export type BodycamLensPresetId = 'axon_body_4' | 'gopro_chest' | 'clean_raw';

export type BodycamWeaponWeightClass = 'unarmed' | 'melee' | 'pistol' | 'carbine' | 'heavy_rifle';

export type BodycamWeaponHoldClass =
  | 'unarmed'
  | 'pistol'
  | 'rifle'
  | 'shotgun'
  | 'melee_1h'
  | 'melee_2h'
  | 'throwable';

export type BodycamFireMode = 'none' | 'semi' | 'auto' | 'pump' | 'bolt' | 'melee' | 'throwable';

export type WeaponCategory =
  | 'carbines'
  | 'pdws'
  | 'dmrs'
  | 'bolt_action'
  | 'pistols'
  | 'shotguns'
  | 'revolvers';

export type WeaponRailType =
  | 'picatinny_top'
  | 'dovetail_ak'
  | 'mp5_claw'
  | 'p90_rail'
  | 'pistol_milled'
  | 'nagant_threaded'
  | 'none_revolver';

export type WeaponFinishPreset =
  | 'black_anodized'
  | 'parkerized'
  | 'fde_tan'
  | 'ral8000_bronze'
  | 'arctic_red_laminate'
  | 'walnut'
  | 'od_green'
  | 'stainless'
  | 'chrome'
  | 'blued_steel'
  | 'olive_polymer';

export type PlatformBuilderStyle =
  | 'unarmed'
  | 'pistol'
  | 'carbine_ak'
  | 'carbine_ar'
  | 'rifle_ak'
  | 'shotgun'
  | 'knife'
  | 'crowbar'
  | 'frag_grenade'
  | 'metal_bolt'
  | 'ARCarbine'
  | 'PistonCarbine'
  | 'AKStamped'
  | 'MP5RollerSMG'
  | 'P90Bullpup'
  | 'ClassicWoodBolt'
  | 'PrecisionChassisBolt'
  | 'SovietDMR'
  | 'BattleChassisDMR'
  | 'AR10_HeavyDMR'
  | 'ServicePistol'
  | 'HeavyMagnumPistol'
  | 'TubeShotgun'
  | 'HeavyBoreShotgun'
  | 'ClassicRevolver'
  | 'TopBreakRevolver'
  | 'LowBoreRevolver';

export interface BodycamHandSocket {
  position: [number, number, number];
  /** Euler rotation in radians (XYZ) for hand alignment on the weapon */
  rotation: [number, number, number];
  /** Finger curl factor (0 = open palm, 1 = tight grip) */
  gripCurl?: number;
}

export interface BodycamWeaponProfile {
  id: string;
  name: string;
  category?: WeaponCategory;
  country?: string;
  description?: string;
  holdClass: BodycamWeaponHoldClass;
  weightClass: BodycamWeaponWeightClass;
  fireMode: BodycamFireMode;
  caliberLabel: string;
  /** Default BaseCaliberId (e.g. '556x45', '338_lm') */
  defaultCaliberId?: string;
  /** Optional modular caliber conversion IDs supported by this platform */
  modularCalibers?: readonly string[];
  /** Physical mass in kilograms (drives rotational inertia, recoil recovery, and sway damping) */
  massKg: number;
  /** Physical barrel + receiver reach length in meters (drives wall pullback trigger) */
  barrelLengthM: number;
  /** Velocity multiplier induced by actual barrel length (e.g. 0.88 SBR, 1.06 27-inch sniper) */
  barrelVelocityMult?: number;
  /** Bore axis height above grip tang in meters (lower = flatter muzzle climb, e.g. Chiappa Rhino 0.012m) */
  boreAxisHeightM?: number;
  rpm: number;
  magCapacity: number;
  /** Ballistic specs (optional for melee/unarmed) */
  muzzleVelocityMps: number;
  ballisticCoefficient: number;
  bulletMassGrams: number;
  spreadMOA: number;
  /** Local hip/ready position relative to right shoulder anchor */
  hipOffset: [number, number, number];
  /** Local ADS position relative to camera sight line */
  adsOffset: [number, number, number];
  /** Local tactical cant / point-aim position relative to camera sight line */
  cantOffset: [number, number, number];
  /** Tactical cant roll angle in degrees (inward roll, typically ~35° for rifles) */
  cantAngleDeg: number;
  /** Local sprint low-ready position relative to right shoulder anchor */
  lowReadyOffset: [number, number, number];
  lowReadyRotation: [number, number, number];
  /** Local right-hand IK socket on the weapon model */
  rightHandSocket: BodycamHandSocket;
  /** Optional local left-hand IK socket for two-handed support/forend */
  leftHandSocket?: BodycamHandSocket;
  /** Muzzle tip offset in weapon local space (+Z is backward, -Z is forward) */
  muzzleOffset: [number, number, number];
  /** Mounted laser emitter offset in weapon local space */
  laserOffset: [number, number, number];
  /** Vertical recoil pitch kick (radians) */
  recoilPitchRad: number;
  /** Horizontal recoil yaw jitter (radians) */
  recoilYawRad: number;
  /** Weapon backward kick (meters) */
  kickBackM: number;
  /** Sight misalignment scale under rapid fire (1.0 = baseline) */
  sightMisalignScale: number;
  /** Visual blueprint style for parametric platform builders */
  visualStyle: PlatformBuilderStyle;
  /** Cosmetic finish preset */
  finish?: WeaponFinishPreset;
  /** Optic/muzzle rail mounting interface */
  railType?: WeaponRailType;
  reloadDurationSec: number;
  magCheckDurationSec: number;
  /** Bolt-action cycle duration in seconds */
  boltCycleDurationSec?: number;
  /** Toggleable semi/pump selector (SPAS-12) */
  toggleablePumpSemi?: boolean;
  /** Revolver cylinder flag */
  isRevolver?: boolean;
  supportsCant: boolean;
  supportsLaser: boolean;
  supportsSuppressor: boolean;
}

export type AimStance = 'HIP' | 'ADS' | 'CANTED_ADS' | 'POINT_AIM';
export type AdsMode = 'PRIMARY' | 'CANTED' | 'POINT_AIM';

export interface BodycamInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  leanLeft: boolean;
  leanRight: boolean;
  ads: boolean;
  /** Armed RMB aim mode selected via MMB (POINT_AIM) or B (CANTED); defaults to PRIMARY */
  adsMode?: AdsMode;
  /** Legacy field retained for compatibility; ignored when adsMode is set */
  cant: boolean;
  holdBreath: boolean;
  /** Hold to engage subtle tactical Free Zoom (Focus) FOV narrowing anytime, stacking onto ADS and sprint */
  freeZoom?: boolean;
  /** Press/hold Space while moving forward toward a ledge to vault or mantle */
  vault?: boolean;
  /** Optional explicit spin-vault trigger (otherwise double-tap Space triggers/upgrades to SPIN_VAULT) */
  vaultSpin?: boolean;
}

export interface BodycamRecoilOptions {
  /** Live multiplier for ADS cheek-weld camera shake (0.0 – 2.0, default 1.0) */
  adsCameraShakeScale?: number;
  /** Live multiplier for Hip-Fire horizontal arm & weapon sway (0.0 – 2.0, default 1.0) */
  hipRecoilSwayScale?: number;
  /**
   * When true (default), routes recoil biomechanically by active aim stance
   * (ADS cheek-weld camera shake vs. hip-fire horizontal arm sway).
   * Pass false for non-firearm shocks (melee, explosions, damage impacts).
   */
  stanceCoupled?: boolean;
}

export interface BodycamTraumaModifiers {
  moveSpeedMult: number;
  moveAccelMult: number;
  canSprint: boolean;
  limpCadenceScale: number;
  leftLegImpairment: number;
  rightLegImpairment: number;
  swayAmpMult: number;
  tremorAmp: number;
  adsSpeedMult: number;
  reloadSpeedMult: number;
  arterialVignette: number;
  desaturation: number;
  concussionBlur: number;
  chromaticSpike: number;
  anyLightBleed: boolean;
  anyHeavyBleed: boolean;
}

export const DEFAULT_TRAUMA_MODIFIERS: Readonly<BodycamTraumaModifiers> = {
  moveSpeedMult: 1.0,
  moveAccelMult: 1.0,
  canSprint: true,
  limpCadenceScale: 1.0,
  leftLegImpairment: 0,
  rightLegImpairment: 0,
  swayAmpMult: 1.0,
  tremorAmp: 0,
  adsSpeedMult: 1.0,
  reloadSpeedMult: 1.0,
  arterialVignette: 0,
  desaturation: 0,
  concussionBlur: 0,
  chromaticSpike: 0,
  anyLightBleed: false,
  anyHeavyBleed: false,
};

export interface BodycamSurvivalModifiers {
  encumbranceRatio: number;
  swayAmpMult: number;
  staminaDrainMult: number;
  exertionRateMult: number;
  moveSpeedMult: number;
  canSprint: boolean;
}

/** Pre-allocated POD struct for zero-GC capsule sweep physics output */
export interface BodycamCapsuleSweepResult {
  posX: number;
  posY: number;
  posZ: number;
  grounded: boolean;
  steppedUp: boolean;
  stepDeltaY: number;
  hitWall: boolean;
  hitCeiling: boolean;
  wallNormalX: number;
  wallNormalZ: number;
  groundNormalY: number;
  slopeAngleRad: number;
}

export function createCapsuleSweepResult(): BodycamCapsuleSweepResult {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    grounded: true,
    steppedUp: false,
    stepDeltaY: 0,
    hitWall: false,
    hitCeiling: false,
    wallNormalX: 0,
    wallNormalZ: 0,
    groundNormalY: 1,
    slopeAngleRad: 0,
  };
}

/** Pre-allocated POD struct for zero-GC world raycast queries */
export interface BodycamRaycastResult {
  hit: boolean;
  distance: number;
  pointX: number;
  pointY: number;
  pointZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  surface: BodycamSurfaceMaterial;
  object: THREE.Object3D | null;
}

export function createRaycastResult(): BodycamRaycastResult {
  return {
    hit: false,
    distance: Infinity,
    pointX: 0,
    pointY: 0,
    pointZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    surface: 'concrete',
    object: null,
  };
}

export interface BodycamInteriorSample {
  isIndoor: boolean;
  material: 'concrete' | 'wood' | 'metal' | 'outdoor';
}

/**
 * Clean portable host-world boundary.
 * Zero game-specific coupling (no zombies, inventory, saves, or anomalies).
 */
export interface IBodycamWorldAdapter {
  /**
   * Sweep player capsule by (deltaX, deltaY, deltaZ) with sliding walls,
   * slopes, and automatic stair/curb step-up up to maxStepUpM.
   */
  sweepCapsule(
    startPos: Readonly<THREE.Vector3>,
    deltaX: number,
    deltaY: number,
    deltaZ: number,
    radius: number,
    height: number,
    maxStepUpM: number,
    outResult: BodycamCapsuleSweepResult,
  ): void;

  /**
   * Cast a ray against world collision/visual geometry (excluding player self/viewmodel).
   * Writes into pre-allocated `outResult` and returns `outResult.hit`.
   */
  raycast(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    near: number,
    far: number,
    outResult: BodycamRaycastResult,
  ): boolean;

  /**
   * Returns surface acoustic material at world position (x, y, z).
   */
  getSurfaceMaterial(x: number, y: number, z: number): BodycamSurfaceMaterial;

  /**
   * Returns exact ground surface height under (x, z) near referenceY for boot IK grounding.
   */
  getGroundHeight(x: number, z: number, referenceY: number): number;

  /**
   * Optional overhead clearance test for uncrouching under low ceilings.
   */
  hasOverheadClearance?(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    crouchHeight: number,
    standHeight: number,
  ): boolean;

  /**
   * Optional interior/exterior acoustics query for convolution reverb switching.
   */
  sampleInterior?(x: number, y: number, z: number, outSample: BodycamInteriorSample): void;

  /**
   * Optional trauma/injury modifier provider.
   */
  getTraumaModifiers?(): Readonly<BodycamTraumaModifiers> | undefined;

  /**
   * Optional acoustic event emitter (for host AI stealth/hearing systems).
   */
  emitAcousticEvent?(
    origin: Readonly<THREE.Vector3>,
    radiusMeters: number,
    kind: BodycamAcousticKind,
  ): void;

  /**
   * Optional breakable glass/obstacle shatter hook triggered on window vault entry or ballistic/melee impact.
   */
  shatterBreakable?(
    object: THREE.Object3D,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ): boolean;

  /**
   * Optional spherecast query against world geometry + dynamic combat targets (actors, doors, breakables).
   * Writes into pre-allocated `outResult` and returns `outResult.hit`.
   * Falls back to a multi-ray `raycast()` bundle if omitted.
   */
  meleeSpherecast?(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    radius: number,
    maxDistance: number,
    outResult: BodycamRaycastResult,
  ): boolean;

  /**
   * Optional host callback invoked when an unarmed punch, weapon bash, or tactical push-kick connects.
   * Keeps `src/bodycam-sdk/` 100% decoupled from game-specific entities (e.g. zombies or doors).
   */
  onMeleeHit?(event: Readonly<BodycamMeleeHitEvent>): void;
}

export interface BodycamLensPresetConfig {
  id: BodycamLensPresetId;
  label: string;
  fisheyeStrength: number;
  chromaticAberration: number;
  isoGrain: number;
  lensDirtStrength: number;
  motionBlurStrength: number;
  vignetteStrength: number;
  contrastBoost: number;
  coolShadowTint: number;
}

export const LENS_PRESETS: Record<BodycamLensPresetId, BodycamLensPresetConfig> = {
  axon_body_4: {
    id: 'axon_body_4',
    label: 'Axon Body 4',
    fisheyeStrength: 0.14,
    chromaticAberration: 0.0028,
    isoGrain: 0.055,
    lensDirtStrength: 0.42,
    motionBlurStrength: 0.38,
    vignetteStrength: 0.44,
    contrastBoost: 1.04,
    coolShadowTint: 0.06,
  },
  gopro_chest: {
    id: 'gopro_chest',
    label: 'GoPro Chest',
    fisheyeStrength: 0.23,
    chromaticAberration: 0.0042,
    isoGrain: 0.032,
    lensDirtStrength: 0.52,
    motionBlurStrength: 0.56,
    vignetteStrength: 0.36,
    contrastBoost: 1.12,
    coolShadowTint: 0.02,
  },
  clean_raw: {
    id: 'clean_raw',
    label: 'Clean Raw',
    fisheyeStrength: 0.0,
    chromaticAberration: 0.0,
    isoGrain: 0.0,
    lensDirtStrength: 0.0,
    motionBlurStrength: 0.0,
    vignetteStrength: 0.08,
    contrastBoost: 1.0,
    coolShadowTint: 0.0,
  },
};

export interface BodycamSDKConfig {
  // Free-Aim & Torso Controller (exact preserved defaults)
  deadzoneYawDeg: number;
  deadzonePitchDeg: number;
  torsoFollowStiffness: number;
  baseHFovDeg: number;
  adsHFovDeg: number;
  sprintHFovDeg: number;

  // Physics, Step-Up & Clearance
  maxStepUpM: number;
  stepSmoothSpeed: number;
  groundAccel: number;
  groundDecel: number;
  strafeWeightDipStrength: number;
  landingShockScale: number;
  leanMaxOffsetM: number;
  leanMaxRollDeg: number;
  leanClearanceRadiusM: number;

  // Weapon Weight, Sight Misalignment, Recoil Split, Cant & Biomechanical Pitch Limits
  weaponInertiaScale: number;
  sightMisalignStrength: number;
  adsCameraShakeScale: number;
  hipRecoilSwayScale: number;
  cantAngleDeg: number;
  wallPullbackScale: number;
  minWeaponPitchDeg: number;
  maxWeaponPitchDeg: number;

  // Optics & Post-Processing
  lensPreset: BodycamLensPresetId;
  fisheyeStrength: number;
  chromaticAberration: number;
  isoGrain: number;
  autoExposureSpeed: number;
  lensDirtStrength: number;
  motionBlurStrength: number;
  opticParallaxStrength: number;
  showRecOverlay: boolean;
  showKillfeed: boolean;
  graphicsQuality: GraphicsQualityId;
  flashlightAngleDeg: number;

  // Mic Chain & Tactile Gear Audio
  micClippingDrive: number;
  gearRattleGain: number;
  masterVolume: number;
}

export const DEFAULT_BODYCAM_SDK_CONFIG: BodycamSDKConfig = {
  deadzoneYawDeg: 10,
  deadzonePitchDeg: 8,
  torsoFollowStiffness: 11.5,
  baseHFovDeg: 98,
  adsHFovDeg: 82,
  sprintHFovDeg: 102,

  maxStepUpM: 0.32,
  stepSmoothSpeed: 15.0,
  groundAccel: 14.0,
  groundDecel: 12.5,
  strafeWeightDipStrength: 1.0,
  landingShockScale: 1.0,
  leanMaxOffsetM: 0.26,
  leanMaxRollDeg: 11.0,
  leanClearanceRadiusM: 0.14,

  weaponInertiaScale: 1.0,
  sightMisalignStrength: 1.0,
  adsCameraShakeScale: 1.0,
  hipRecoilSwayScale: 1.0,
  cantAngleDeg: 40,
  wallPullbackScale: 1.0,
  minWeaponPitchDeg: -50,
  maxWeaponPitchDeg: 68,

  lensPreset: 'axon_body_4',
  fisheyeStrength: 0.14,
  chromaticAberration: 0.0028,
  isoGrain: 0.055,
  autoExposureSpeed: 2.4,
  lensDirtStrength: 0.42,
  motionBlurStrength: 0.38,
  opticParallaxStrength: 1.0,
  showRecOverlay: true,
  showKillfeed: true,
  graphicsQuality: 'balanced',
  flashlightAngleDeg: 26,

  micClippingDrive: 4.5,
  gearRattleGain: 0.75,
  masterVolume: 0.85,
};

/** Zero-GC POD telemetry snapshot filled each tick */
export interface BodycamTelemetry {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  speedMps: number;
  grounded: boolean;
  crouched: boolean;
  standBlockedByCeiling: boolean;
  steppedUp: boolean;
  stepSmoothOffsetY: number;
  slopeAngleDeg: number;
  leanMeters: number;
  leanClamped: boolean;
  currentSurface: BodycamSurfaceMaterial;
  isIndoor: boolean;
  isAds: boolean;
  isCanted: boolean;
  isPointAim: boolean;
  focusBlend: number;
  aimStance: AimStance;
  armedAdsMode: AdsMode;
  laserOn: boolean;
  flashlightOn: boolean;
  wallPullback: number;
  sightMisalignDeg: number;
  avgLuminance: number;
  exposure: number;
  angularWhipRadPerSec: number;
  exertion: number;
  breathFreqHz: number;
  aimYawDeg: number;
  aimPitchDeg: number;
  torsoYawDeg: number;
  torsoPitchDeg: number;
  spinePitchDeg: number;
  weaponPitchDeg: number;
  weaponMassKg: number;
  weaponWeightClass: BodycamWeaponWeightClass;
  vaultActive: boolean;
  vaultMode: BodycamVaultMode;
}

export function createBodycamTelemetry(): BodycamTelemetry {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    velX: 0,
    velY: 0,
    velZ: 0,
    speedMps: 0,
    grounded: true,
    crouched: false,
    standBlockedByCeiling: false,
    steppedUp: false,
    stepSmoothOffsetY: 0,
    slopeAngleDeg: 0,
    leanMeters: 0,
    leanClamped: false,
    currentSurface: 'concrete',
    isIndoor: false,
    isAds: false,
    isCanted: false,
    isPointAim: false,
    focusBlend: 0,
    aimStance: 'HIP',
    armedAdsMode: 'PRIMARY',
    laserOn: false,
    flashlightOn: false,
    wallPullback: 0,
    sightMisalignDeg: 0,
    avgLuminance: 0.22,
    exposure: 0.95,
    angularWhipRadPerSec: 0,
    exertion: 0,
    breathFreqHz: 0.24,
    aimYawDeg: 0,
    aimPitchDeg: 0,
    torsoYawDeg: 0,
    torsoPitchDeg: 0,
    spinePitchDeg: 0,
    weaponPitchDeg: 0,
    weaponMassKg: 0,
    weaponWeightClass: 'unarmed',
    vaultActive: false,
    vaultMode: 'NONE',
  };
}

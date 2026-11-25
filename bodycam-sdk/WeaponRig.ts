import * as THREE from 'three';
import {
  computeDerivedWeaponStats,
  DerivedWeaponStats,
  getOwnedSuppressorDef,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import { IR_LAYER, VIEWMODEL_LAYER } from './BodycamPostProcess';
import { IBodycamAudioSource } from './IBodycamAudioSource';
import { clampSpringState, stepAnalyticalDampedSpring } from './math/SpringMath';
import {
  BodycamRaycastResult,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  createRaycastResult,
  IBodycamWorldAdapter,
} from './types';
import { SDK_WEAPON_PROFILES } from './weaponProfiles';
import {
  WeaponAnimator,
  WeaponPoseUpdateInput,
  WeaponSyncedHandlingSnapshot,
} from './weapons/WeaponAnimator';
import { WeaponAssembler } from './weapons/WeaponAssembler';
import { WeaponModelAssembly, WeaponModelFactory } from './weapons/WeaponModelFactory';

export interface ReadOnlyWeaponRigState {
  aimYaw: number;
  aimPitch: number;
  isAds: boolean;
  isCanted: boolean;
  isPointAim: boolean;
  isSprinting: boolean;
  isMoving: boolean;
  strideProgress: number;
  pullbackRatio: number;
  recoilX: number;
  recoilZ: number;
  recoilPitch: number;
  recoilYaw: number;
  recoilRoll: number;
  muzzleDriftPitch: number;
  muzzleDriftYaw: number;
  sightMisalignPitch: number;
  sightMisalignYaw: number;
  sightMisalignDeg: number;
  adsBlend: number;
  cantBlend: number;
  pointAimBlend: number;
  sprintBlend: number;
  laserOn: boolean;
}

export interface WeaponSpringTuning {
  posOmega: number;
  posZeta: number;
  rotOmega: number;
  rotZeta: number;
  counterTiltGain: number;
}

/**
 * Pure mass-tuned coupled 6-DOF spring-damper parameters:
 *  - Pistols / light SMGs (massFactor ~0.62..0.85): crisp high-omega snap & quick settle
 *  - Carbines / ARs / AKs (massFactor ~0.95..1.15): balanced tactical momentum & subtle overshoot
 *  - Shotguns / heavy DMRs / Desert Eagle (massFactor ~1.18..1.55): heavier inertia & deliberate settle
 */
export function computeWeaponSpringTuning(massFactor: number): WeaponSpringTuning {
  const m = THREE.MathUtils.clamp(massFactor, 0.55, 1.65);
  const weightNorm = THREE.MathUtils.clamp((m - 0.62) / 0.90, 0, 1);
  return {
    posOmega: THREE.MathUtils.lerp(20.5, 13.0, weightNorm),
    posZeta: THREE.MathUtils.lerp(0.76, 0.64, weightNorm),
    rotOmega: THREE.MathUtils.lerp(21.0, 12.6, weightNorm),
    rotZeta: THREE.MathUtils.lerp(0.74, 0.60, weightNorm),
    counterTiltGain: THREE.MathUtils.lerp(0.46, 0.72, weightNorm),
  };
}

const RIGHT_SHOULDER_LOCAL = new THREE.Vector3(0.18, -0.22, -0.08);

/**
 * Self-contained AAA WeaponRig:
 *  - Multi-part articulated procedural PBR gun models via WeaponModelFactory
 *  - Mechanical blowback, empty lockback, physical detachable magazines, pooled casings/smoke,
 *    exact `sightAnchor` ADS alignment, 10-state damped pose-graph, and `I` Weapon Inspect via WeaponAnimator
 *  - Physical mass/length weight-class parameterization (pistol / carbine / heavy_rifle)
 *  - Independent Sight Misalignment rotational springs under rapid fire
 *  - Tactical Cant / Point-Aim (~35° inward roll) with raycasted Visible/IR Laser
 *  - Dedicated VIEWMODEL_LAYER = 1 rendering (never clips into nearby walls)
 *  - Zero-allocation per-frame math using pre-allocated scratch buffers
 */
export class WeaponRig {
  public readonly root = new THREE.Group();
  public readonly shoulderAnchor = new THREE.Group();
  public readonly weaponPivot = new THREE.Group();
  public readonly modelGroup = new THREE.Group();
  public readonly muzzleAnchor = new THREE.Object3D();
  public readonly laserAnchor = new THREE.Object3D();
  public readonly flashlight: THREE.SpotLight;
  public readonly flashlightTarget = new THREE.Object3D();

  // Data-driven weapon socket anchors for CharacterAnimator 2-bone IK
  public readonly rightHandSocketAnchor = new THREE.Object3D();
  public readonly leftHandSocketAnchor = new THREE.Object3D();
  public readonly magWellAnchor = new THREE.Object3D();
  public readonly boltRackAnchor = new THREE.Object3D();
  public hasLeftHandSocket = false;

  public readonly weaponAnimator: WeaponAnimator;
  public laserOn = false;
  public laserMode: 'visible_red' | 'ir_green' = 'visible_red';
  private nvgOpticalActive = false;
  private irLaserActive = false;

  private currentProfile: BodycamWeaponProfile = SDK_WEAPON_PROFILES.unarmed;
  private currentAttachments: WeaponAttachments = {};
  private derivedStats: DerivedWeaponStats = computeDerivedWeaponStats(0, 0.25, 0, {});
  private assembly: WeaponModelAssembly | null = null;
  private opticZoomIndex = 1;
  private scopeZoomCurrent = 1.0;
  private scopeZoomTarget = 1.0;
  private zoomTwistTimer = 0;
  private zoomTwistActive = false;
  private zoomTwistDuration = 0.28;
  private lastOpticId: string | null = null;
  public reticleIlluminated = true;
  private audio?: IBodycamAudioSource;

  // True height-over-bore zeroing pitch compensation
  private zeroDistanceM = 100;
  private zeroElevationMrad = 0;
  private zeroPitchRad = 0;
  private readonly _zeroAxisX = new THREE.Vector3(1, 0, 0);
  private readonly _zeroPitchQuat = new THREE.Quaternion();

  // Muzzle flash (45ms HDR spike)
  private muzzleFlashLight: THREE.PointLight;
  private muzzleFlashMesh: THREE.Mesh;
  private flashTimer = 0;

  // Visible / IR Tactical Laser Beam (world space, raycast-clamped)
  private laserBeamMesh: THREE.Mesh;
  private laserBeamMat: THREE.MeshBasicMaterial;
  private laserDotMesh: THREE.Mesh;
  private laserDotMat: THREE.MeshBasicMaterial;

  // Independent 2nd-order recoil springs (axial bore kickback, muzzle whip + persistent muzzle drift)
  private recoilZ = 0;
  private recoilZVel = 0;
  private recoilPitch = 0;
  private recoilPitchVel = 0;
  private recoilYaw = 0;
  private recoilYawVel = 0;
  private recoilRoll = 0;
  private recoilRollVel = 0;
  private muzzleDriftPitch = 0;
  private muzzleDriftPitchVel = 0;
  private muzzleDriftYaw = 0;
  private muzzleDriftYawVel = 0;
  private muzzleDriftPolarity = 1;
  private lastCheekWeld = 0;
  private lastHoldBreathBlend = 0;

  // Sight Misalignment under rapid fire (independent rotational springs recovering to true zero)
  private sightMisalignPitch = 0;
  private sightMisalignPitchVel = 0;
  private sightMisalignYaw = 0;
  private sightMisalignYawVel = 0;
  private sightMisalignRoll = 0;
  private sightMisalignRollVel = 0;
  private rapidFireHeat = 0;

  // Coupled 6-DOF mass-tuned spring-damper weapon & hand physics (positionSpring + rotationSpring)
  private lagYaw = 0;
  private lagYawVel = 0;
  private lagPitch = 0;
  private lagPitchVel = 0;
  private lagRoll = 0;
  private lagRollVel = 0;
  private motionPosX = 0;
  private motionPosY = 0;
  private motionPosZ = 0;
  private motionPosVelX = 0;
  private motionPosVelY = 0;
  private motionPosVelZ = 0;
  private prevStrideStepIdx = 0;
  private prevVerticalMotionOffset = 0;
  private readonly _mechImpulsePos = new THREE.Vector3();
  private readonly _mechImpulseRot = new THREE.Vector3();

  // Wall pullback, ADS, Tactical Cant, & Sprint blends
  private pullbackRatio = 0;
  private adsBlend = 0;
  private cantBlend = 0;
  private pointAimBlend = 0;
  private sprintBlend = 0;
  private vaultRetentionBlend = 0;
  private vaultRetentionMode: 'NONE' | 'ONE_HAND_TUCK' | 'TWO_HAND_SLING' = 'NONE';
  private smoothedPointAimConvDist = 25;

  private lastAimYaw = 0;
  private lastAimPitch = 0;
  private lastIsAds = false;
  private lastIsCanted = false;
  private lastIsPointAim = false;
  private lastIsSprinting = false;
  private lastIsMoving = false;
  private lastStrideProgress = 0;

  private scene: THREE.Scene;

  // Pre-allocated scratch math buffers (zero GC per frame)
  private readonly _shoulderWorld = new THREE.Vector3();
  private readonly _barrelDir = new THREE.Vector3();
  private readonly _camCenterDir = new THREE.Vector3();
  private readonly _laserOrigin = new THREE.Vector3();
  private readonly _laserDir = new THREE.Vector3();
  private readonly _laserMid = new THREE.Vector3();
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _upAxis = new THREE.Vector3(0, 1, 0);
  private readonly _pointAimOffsetBuf: [number, number, number] = [0.068, -0.078, -0.26];
  private readonly _rayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _poseInput: WeaponPoseUpdateInput;
  private readonly _rigStateSnapshot: ReadOnlyWeaponRigState = {
    aimYaw: 0,
    aimPitch: 0,
    isAds: false,
    isCanted: false,
    isPointAim: false,
    isSprinting: false,
    isMoving: false,
    strideProgress: 0,
    pullbackRatio: 0,
    recoilX: 0,
    recoilZ: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    recoilRoll: 0,
    muzzleDriftPitch: 0,
    muzzleDriftYaw: 0,
    sightMisalignPitch: 0,
    sightMisalignYaw: 0,
    sightMisalignDeg: 0,
    adsBlend: 0,
    cantBlend: 0,
    pointAimBlend: 0,
    sprintBlend: 0,
    laserOn: false,
  };

  constructor(scene: THREE.Scene, isSoftwareGl: boolean, audio?: IBodycamAudioSource) {
    this.scene = scene;
    this.audio = audio;
    this.weaponAnimator = new WeaponAnimator(scene, audio);

    this.shoulderAnchor.position.copy(RIGHT_SHOULDER_LOCAL);
    this.root.add(this.shoulderAnchor);
    this.shoulderAnchor.add(this.weaponPivot);
    this.weaponPivot.add(this.modelGroup);
    this.modelGroup.add(
      this.muzzleAnchor,
      this.laserAnchor,
      this.rightHandSocketAnchor,
      this.leftHandSocketAnchor,
      this.magWellAnchor,
      this.boltRackAnchor,
    );

    // Shadow-casting WML Flashlight attached to weapon pivot
    this.flashlight = new THREE.SpotLight(0xeef6ff, 6.8, 48, THREE.MathUtils.degToRad(26), 0.44, 1.35);
    this.flashlight.position.set(0.025, -0.015, -0.14);
    this.flashlight.castShadow = !isSoftwareGl;
    this.flashlight.shadow.mapSize.width = 1024;
    this.flashlight.shadow.mapSize.height = 1024;
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 48;
    this.flashlight.shadow.bias = -0.0005;
    this.flashlight.visible = false;
    this.flashlight.layers.enable(VIEWMODEL_LAYER);

    this.flashlightTarget.position.set(0.02, -0.02, -10);
    this.weaponPivot.add(this.flashlight);
    this.weaponPivot.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    // 45ms HDR Muzzle Flash Spike
    this.muzzleFlashLight = new THREE.PointLight(0xffb85c, 0, 12, 1.8);
    this.muzzleFlashLight.layers.enable(VIEWMODEL_LAYER);
    this.muzzleAnchor.add(this.muzzleFlashLight);

    const flashGeo = new THREE.OctahedronGeometry(0.06, 0);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd78c,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
    this.muzzleFlashMesh.visible = false;
    this.muzzleFlashMesh.layers.set(VIEWMODEL_LAYER);
    this.muzzleAnchor.add(this.muzzleFlashMesh);

    // Visible / IR Tactical Laser Beam + Impact Dot (Layer 0 world space so it terminates accurately on surfaces)
    const beamGeo = new THREE.CylinderGeometry(0.0014, 0.0014, 1.0, 6, 1, true);
    this.laserBeamMat = new THREE.MeshBasicMaterial({
      color: 0xff2222,
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laserBeamMesh = new THREE.Mesh(beamGeo, this.laserBeamMat);
    this.laserBeamMesh.visible = false;
    this.laserBeamMesh.frustumCulled = false;
    this.scene.add(this.laserBeamMesh);

    const dotGeo = new THREE.SphereGeometry(0.013, 8, 8);
    this.laserDotMat = new THREE.MeshBasicMaterial({
      color: 0xff3b3b,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laserDotMesh = new THREE.Mesh(dotGeo, this.laserDotMat);
    this.laserDotMesh.visible = false;
    this.laserDotMesh.frustumCulled = false;
    this.scene.add(this.laserDotMesh);

    this._poseInput = {
      dt: 0.016,
      elapsed: 0,
      isFirearm: false,
      isUnarmed: true,
      massHandlingFactor: 0.6,
      weightClass: 'pistol',
      aimYaw: 0,
      aimPitch: 0,
      isAds: false,
      isCanted: false,
      isSprinting: false,
      isMoving: false,
      bobPhase: 0,
      verticalMotionOffset: 0,
      pullbackRatio: 0,
      barrelLengthM: 0,
      vaultRetentionMode: 'NONE',
      vaultRetentionBlend: 0,
      adsSpeedMult: 1,
      cantAngleRad: THREE.MathUtils.degToRad(35),
      hipOffset: SDK_WEAPON_PROFILES.unarmed.hipOffset,
      cantOffset: SDK_WEAPON_PROFILES.unarmed.cantOffset,
      lowReadyOffset: SDK_WEAPON_PROFILES.unarmed.lowReadyOffset,
      lowReadyRotation: SDK_WEAPON_PROFILES.unarmed.lowReadyRotation,
      breathX: 0,
      breathY: 0,
      recoilX: 0,
      recoilZ: 0,
      recoilPitch: 0,
      recoilYaw: 0,
      recoilRoll: 0,
      muzzleDriftPitch: 0,
      muzzleDriftYaw: 0,
      sightMisalignPitch: 0,
      sightMisalignYaw: 0,
      sightMisalignRoll: 0,
      lagYaw: 0,
      lagPitch: 0,
      camWorldPos: new THREE.Vector3(),
      camWorldQuat: new THREE.Quaternion(),
      shoulderAnchor: this.shoulderAnchor,
      weaponPivot: this.weaponPivot,
      weaponRootPitchRad: 0,
      minWeaponPitchRad: THREE.MathUtils.degToRad(-50),
      maxWeaponPitchRad: THREE.MathUtils.degToRad(68),
    };

    this.setWeaponProfile(SDK_WEAPON_PROFILES.unarmed, false);
  }

  public setAudio(audio: IBodycamAudioSource): void {
    this.audio = audio;
    this.weaponAnimator.setAudio(audio);
  }

  public setAmmoState(ammoInMag: number, isFirearm?: boolean): void {
    const firearm =
      isFirearm ??
      (this.currentProfile.holdClass === 'pistol' ||
        this.currentProfile.holdClass === 'rifle' ||
        this.currentProfile.holdClass === 'shotgun');
    this.weaponAnimator.setAmmoState(ammoInMag, firearm);
  }

  public triggerInspect(): boolean {
    if (this.currentProfile.holdClass === 'unarmed') return false;
    return this.weaponAnimator.triggerInspect();
  }

  public interruptInspect(): void {
    this.weaponAnimator.interruptInspect();
  }

  public triggerReload(durationSec: number): void {
    this.weaponAnimator.triggerReload(durationSec);
  }

  public triggerTubularReload(
    shellsToLoad: number,
    isEmptyChamber: boolean,
    onShellInserted?: () => void,
    onComplete?: () => void,
  ): boolean {
    return this.weaponAnimator.triggerTubularReload(
      shellsToLoad,
      isEmptyChamber,
      onShellInserted,
      onComplete,
    );
  }

  public interruptTubularReload(): void {
    this.weaponAnimator.interruptTubularReload();
  }

  public isTubularReloading(): boolean {
    return this.weaponAnimator.isTubularReloading();
  }

  public triggerMagCheck(durationSec: number): void {
    this.weaponAnimator.triggerMagCheck(durationSec);
  }

  public triggerDryFire(): void {
    this.weaponAnimator.triggerDryFire();
  }

  public cancelAction(): void {
    this.cancelZoomTwist();
    this.weaponAnimator.cancelAction();
  }

  public isBoltCycling(): boolean {
    return this.weaponAnimator.isBoltCycling();
  }

  public isBlockingFiringAction(): boolean {
    return this.weaponAnimator.isBlockingFiringAction();
  }

  public triggerTurretClick(): void {
    if (!this.lastIsSprinting) {
      this.weaponAnimator.triggerMicroAction('TURRET', 0.24);
    }
  }

  public triggerIllumToggle(): void {
    if (!this.lastIsSprinting) {
      this.weaponAnimator.triggerMicroAction('ILLUM', 0.22);
    }
  }

  public triggerSelectorFlick(fireModeIdx?: number): void {
    if (!this.lastIsSprinting) {
      this.weaponAnimator.triggerMicroAction('SELECTOR', 0.18, fireModeIdx);
    } else {
      this.weaponAnimator.emitWeaponCue('mode_toggle', 0.9);
    }
  }

  public triggerTacticalSwitch(): void {
    if (!this.lastIsSprinting) {
      this.weaponAnimator.triggerMicroAction('LIGHT_PAD', 0.16);
    }
  }

  public emitModeToggleCue(): void {
    this.triggerSelectorFlick();
  }

  public getSyncedHandlingSnapshot(): Readonly<WeaponSyncedHandlingSnapshot> {
    return this.weaponAnimator.getSyncedHandlingSnapshot();
  }

  public getModelAssembly(): WeaponModelAssembly | null {
    return this.assembly;
  }

  public getDerivedStats(): Readonly<DerivedWeaponStats> {
    return this.derivedStats;
  }

  public getAttachments(): Readonly<WeaponAttachments> {
    return this.currentAttachments;
  }

  public getOwnedSuppressorId(): string | null {
    return getOwnedSuppressorDef(this.currentAttachments)?.id ?? null;
  }

  public isSuppressorOwned(): boolean {
    return getOwnedSuppressorDef(this.currentAttachments) !== null;
  }

  public isSuppressorStowed(): boolean {
    return this.isSuppressorOwned() && Boolean(this.currentAttachments.suppressorStowed);
  }

  public isSuppressorActionActive(): boolean {
    return this.weaponAnimator.isSuppressorActionActive();
  }

  /**
   * Ownership-gated realistic field suppressor twist-and-stow toggle (`G` key).
   * Never fabricates or attaches a suppressor if the weapon does not already own one in its `muzzle` slot.
   */
  public triggerFieldSuppressorToggle(
    onComplete?: (attached: boolean) => void,
  ): 'started_attach' | 'started_detach' | 'no_suppressor' | 'busy' {
    const ownedDef = getOwnedSuppressorDef(this.currentAttachments);
    if (!ownedDef || !this.assembly?.suppressor) {
      return 'no_suppressor';
    }
    const shouldAttach = Boolean(this.currentAttachments.suppressorStowed);
    const started = this.weaponAnimator.triggerSuppressorToggle(shouldAttach, (nowAttached) => {
      const next: WeaponAttachments = {
        ...this.currentAttachments,
        suppressorStowed: nowAttached ? undefined : true,
      };
      this.setAttachments(next);
      onComplete?.(nowAttached);
    });
    if (!started) {
      return 'busy';
    }
    return shouldAttach ? 'started_attach' : 'started_detach';
  }

  /**
   * Returns the live world position of the suppressor body grip midpoint for left-hand 2-bone IK targeting
   * (tracks axial thread travel & clear-pull dynamically when mounted on muzzleMountSocket).
   */
  public getSuppressorMountWorldPosition(out: THREE.Vector3): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    const supp = this.assembly.suppressor;
    if (supp && supp.parent === this.assembly.muzzleMountSocket) {
      // Midpoint of suppressor body tracks live axial travel during 3-stroke twist & clear-pull
      const suppLen = this.assembly.handPoseProfile.suppressorLengthM || 0.16;
      const homeZ = typeof supp.userData.homeZ === 'number' ? supp.userData.homeZ : 0;
      const axialDeltaZ = supp.position.z - homeZ;
      this.assembly.suppressorGripSocket.getWorldPosition(out);
      if (Math.abs(axialDeltaZ) > 1e-5) {
        this.assembly.muzzleMountSocket.getWorldQuaternion(this._tmpQuat);
        this._barrelDir.set(0, 0, axialDeltaZ).applyQuaternion(this._tmpQuat);
        out.add(this._barrelDir);
      } else if (suppLen <= 0.01) {
        this.assembly.muzzleMountSocket.getWorldPosition(out);
      }
      return true;
    }
    this.assembly.suppressorGripSocket.getWorldPosition(out);
    return true;
  }

  /** Reads live world transform of `assembly.leftHandSocket` (follows pumpForend 1:1 on pump shotguns!). */
  public getLiveLeftHandSocketWorldTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    if (!this.assembly || !this.hasLeftHandSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.leftHandSocket.getWorldPosition(outPos);
    this.assembly.leftHandSocket.getWorldQuaternion(outQuat);
    return true;
  }

  /** Reads live world position of `assembly.boltHandleSocket` (follows boltHandlePivot rotation & travel). */
  public getBoltHandleWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.boltHandleSocket.getWorldPosition(outPos);
    return true;
  }

  public getEjectionPortWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.ejectionPortSocket.getWorldPosition(outPos);
    return true;
  }

  public getElevationTurretWorldTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    if (!this.assembly?.elevationTurretSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.elevationTurretSocket.getWorldPosition(outPos);
    this.assembly.elevationTurretSocket.getWorldQuaternion(outQuat);
    return true;
  }

  public getIllumDialWorldTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    if (!this.assembly?.illumDialSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.illumDialSocket.getWorldPosition(outPos);
    this.assembly.illumDialSocket.getWorldQuaternion(outQuat);
    return true;
  }

  public getSelectorWorldTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.selectorSocket.getWorldPosition(outPos);
    this.assembly.selectorSocket.getWorldQuaternion(outQuat);
    return true;
  }

  public getPressurePadWorldTransform(
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.pressurePadSocket.getWorldPosition(outPos);
    this.assembly.pressurePadSocket.getWorldQuaternion(outQuat);
    return true;
  }

  public isMagnifiedOpticActive(): boolean {
    return Boolean(this.assembly?.scopeLensMaterial) && this.derivedStats.isMagnifiedOptic;
  }

  public hasVariableZoom(): boolean {
    return this.derivedStats.opticZoomLevels.length > 1;
  }

  public getActiveOpticZoomMult(): number {
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length > 0) {
      return this.scopeZoomCurrent;
    }
    return this.derivedStats.adsZoomFactor;
  }

  public getTargetOpticZoomMult(): number {
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length > 0) {
      const idx = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex));
      return levels[idx];
    }
    return this.derivedStats.adsZoomFactor;
  }

  public cycleOpticZoom(dir: 1 | -1, withIkTwist = true): number {
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length <= 1) return this.getTargetOpticZoomMult();
    const prevIdx = this.opticZoomIndex;
    this.opticZoomIndex = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex + dir));
    const target = levels[this.opticZoomIndex];
    this.scopeZoomTarget = target;

    if (this.opticZoomIndex !== prevIdx) {
      this.audio?.playZoomRatchetClick?.(target);
      // Realistic throw-lever pinch & sweep in BOTH ADS and hip/ready stance (interruptible on fire/sprint)
      if (
        withIkTwist &&
        this.assembly?.zoomRingSocket &&
        !this.lastIsSprinting &&
        !this.weaponAnimator.isBlockingFiringAction()
      ) {
        this.zoomTwistActive = true;
        this.zoomTwistTimer = 0;
        this.weaponAnimator.triggerMicroAction('ZOOM_TWIST', this.zoomTwistDuration);
      }
    }
    return target;
  }

  public cancelZoomTwist(): void {
    this.zoomTwistActive = false;
    this.zoomTwistTimer = 0;
    if (this.weaponAnimator.getActiveMicroAction() === 'ZOOM_TWIST') {
      this.weaponAnimator.cancelMicroAction();
    }
  }

  public isZoomTwistActive(): boolean {
    return this.zoomTwistActive;
  }

  /**
   * Returns 0..1 left-hand IK blend weight during the 0.28s LPVO zoom-ring reach -> twist -> return arc,
   * writing the live world-space transform of `assembly.zoomRingSocket` into `outPos` / `outQuat`.
   */
  public getZoomRingIkOverride(outPos: THREE.Vector3, outQuat: THREE.Quaternion): number {
    if (!this.zoomTwistActive || !this.assembly?.zoomRingSocket) return 0;
    const p = THREE.MathUtils.clamp(this.zoomTwistTimer / Math.max(0.05, this.zoomTwistDuration), 0, 1);
    let w = 0;
    if (p < 0.28) {
      const t = p / 0.28;
      w = t * t * (3 - 2 * t);
    } else if (p < 0.72) {
      w = 1.0;
    } else {
      const t = (p - 0.72) / 0.28;
      w = 1.0 - t * t * (3 - 2 * t);
    }
    if (w <= 0.001) return 0;
    this.root.updateMatrixWorld(true);
    this.assembly.zoomRingSocket.getWorldPosition(outPos);
    this.assembly.zoomRingSocket.getWorldQuaternion(outQuat);
    return w;
  }

  public setZeroConfig(
    zeroDistanceM: number,
    zeroElevationMrad: number,
    zeroPitchRad: number,
    triggerHandIk = false,
  ): void {
    const changed = Math.abs(zeroDistanceM - this.zeroDistanceM) > 1e-3 ||
      Math.abs(zeroElevationMrad - this.zeroElevationMrad) > 1e-4;
    this.zeroDistanceM = zeroDistanceM;
    this.zeroElevationMrad = zeroElevationMrad;
    this.zeroPitchRad = zeroPitchRad;
    if (this.assembly?.elevationTurretMesh) {
      // 1 full turret revolution = 10 MRAD
      this.assembly.elevationTurretMesh.rotation.y = -(zeroElevationMrad / 10) * Math.PI * 2;
    }
    if (triggerHandIk && changed) {
      this.triggerTurretClick();
    }
  }

  public getZeroDistanceM(): number {
    return this.zeroDistanceM;
  }

  public getZeroElevationMrad(): number {
    return this.zeroElevationMrad;
  }

  public getZeroPitchRad(): number {
    return this.zeroPitchRad;
  }

  /** True physical Height-Over-Bore (meters) from bore/muzzle centerline to active sight optical axis. */
  public getHeightOverBoreM(): number {
    if (!this.assembly) return 0.055;
    const hob = this.assembly.sightAnchor.position.y - this.assembly.muzzleSocket.position.y;
    return THREE.MathUtils.clamp(Math.abs(hob) > 0.008 ? hob : 0.055, 0.018, 0.14);
  }

  public toggleReticleIllumination(): boolean {
    this.reticleIlluminated = !this.reticleIlluminated;
    this.triggerIllumToggle();
    return this.reticleIlluminated;
  }

  private syncOpticZoomIndex(): void {
    const opticId = this.currentAttachments.optic ?? null;
    const levels = this.derivedStats.opticZoomLevels;
    if (opticId !== this.lastOpticId) {
      this.lastOpticId = opticId;
      this.cancelZoomTwist();
      if (levels.length > 0) {
        // Default to 1x on 1-6x LPVO (6 steps) or 4x on legacy/PSO scopes
        this.opticZoomIndex = levels.length === 6 ? 0 : levels.length >= 4 ? 2 : levels.length - 1;
        this.scopeZoomTarget = levels[this.opticZoomIndex];
        this.scopeZoomCurrent = this.scopeZoomTarget;
      } else {
        this.opticZoomIndex = 0;
        this.scopeZoomTarget = this.derivedStats.adsZoomFactor;
        this.scopeZoomCurrent = this.scopeZoomTarget;
      }
    } else if (levels.length > 0) {
      this.opticZoomIndex = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex));
      this.scopeZoomTarget = levels[this.opticZoomIndex];
      this.scopeZoomCurrent = THREE.MathUtils.clamp(
        this.scopeZoomCurrent,
        levels[0],
        levels[levels.length - 1],
      );
    } else {
      this.scopeZoomTarget = this.derivedStats.adsZoomFactor;
      this.scopeZoomCurrent = this.scopeZoomTarget;
    }
    this.applyZoomRingPivotAngle();
  }

  private applyZoomRingPivotAngle(): void {
    const pivot = this.assembly?.zoomRingPivot;
    if (!pivot) return;
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length <= 1) {
      pivot.rotation.z = 0;
      return;
    }
    const minZ = levels[0];
    const maxZ = levels[levels.length - 1];
    const norm = THREE.MathUtils.clamp((this.scopeZoomCurrent - minZ) / Math.max(0.01, maxZ - minZ), 0, 1);
    // Counter-clockwise throw-lever rotation (~88 deg sweep from 1x to 6x)
    pivot.rotation.z = -norm * 1.54;
  }

  /** Mass-normalized handling factor (pistol ~0.68, carbine ~1.0, heavy_rifle ~1.38) */
  private getMassHandlingFactor(): number {
    const m = this.derivedStats.totalMassKg > 0.05
      ? this.derivedStats.totalMassKg
      : this.currentProfile.massKg;
    if (m <= 0.1) return 0.6;
    if (this.currentProfile.weightClass === 'pistol') {
      return THREE.MathUtils.clamp(0.55 + m * 0.14, 0.62, 0.92);
    }
    if (this.currentProfile.weightClass === 'heavy_rifle') {
      return THREE.MathUtils.clamp(1.05 + (m - 3.2) * 0.18, 1.15, 1.55);
    }
    return THREE.MathUtils.clamp(0.55 + m * 0.18, 0.72, 1.48);
  }

  public getMassHandlingFactorPublic(): number {
    return this.getMassHandlingFactor();
  }

  public getCoupledSpringSnapshot(): {
    lagYaw: number;
    lagPitch: number;
    lagRoll: number;
    motionPosX: number;
    motionPosY: number;
    motionPosZ: number;
  } {
    return {
      lagYaw: this.lagYaw,
      lagPitch: this.lagPitch,
      lagRoll: this.lagRoll,
      motionPosX: this.motionPosX,
      motionPosY: this.motionPosY,
      motionPosZ: this.motionPosZ,
    };
  }

  public addInertia(dyaw: number, dpitch: number, configInertiaScale = 1.0): void {
    const massScale = this.getMassHandlingFactor() * configInertiaScale;
    const tuning = computeWeaponSpringTuning(this.getMassHandlingFactor());
    const maxLag = 0.088 * Math.min(1.45, massScale);
    const maxVel = 1.65 * Math.min(1.5, massScale);

    // Direct micro-deflection + spring velocity impulse so fast camera flicks exhibit
    // natural barrel lag, counter-tilt roll, and weight-proportional micro-overshoot on stop
    this.lagYaw = THREE.MathUtils.clamp(this.lagYaw + dyaw * massScale * 0.62, -maxLag, maxLag);
    this.lagPitch = THREE.MathUtils.clamp(this.lagPitch + dpitch * massScale * 0.62, -maxLag, maxLag);
    this.lagYawVel = THREE.MathUtils.clamp(
      this.lagYawVel + dyaw * massScale * tuning.rotOmega * 0.42,
      -maxVel,
      maxVel,
    );
    this.lagPitchVel = THREE.MathUtils.clamp(
      this.lagPitchVel + dpitch * massScale * tuning.rotOmega * 0.42,
      -maxVel,
      maxVel,
    );
    this.lagRollVel = THREE.MathUtils.clamp(
      this.lagRollVel + dyaw * massScale * tuning.rotOmega * tuning.counterTiltGain,
      -maxVel * 1.15,
      maxVel * 1.15,
    );
    // Subtle lateral translational drag coupled to angular sweep
    this.motionPosVelX = THREE.MathUtils.clamp(
      this.motionPosVelX - dyaw * massScale * 0.19,
      -0.38,
      0.38,
    );
    this.motionPosVelY = THREE.MathUtils.clamp(
      this.motionPosVelY - dpitch * massScale * 0.14,
      -0.32,
      0.32,
    );
  }

  public applyWeaponRecoil(
    pitchRad: number,
    yawRad: number,
    kickBackM: number,
    misalignConfigScale = 1.0,
    stanceOpts?: {
      cheekWeld?: number;
      hipRecoilSwayScale?: number;
      stanceCoupled?: boolean;
      rawYawRad?: number;
      holdBreathBlend?: number;
    },
  ): void {
    const massFactor = this.getMassHandlingFactor();
    const stanceCoupled = stanceOpts?.stanceCoupled !== false;
    const cheekWeld = stanceCoupled ? THREE.MathUtils.clamp(stanceOpts?.cheekWeld ?? 0, 0, 1) : 0.5;
    const hipSwayScale = THREE.MathUtils.clamp(stanceOpts?.hipRecoilSwayScale ?? 1.0, 0, 2.0);
    const rawYawMag = Math.abs(stanceOpts?.rawYawRad ?? yawRad);
    const hb = THREE.MathUtils.clamp(stanceOpts?.holdBreathBlend ?? this.lastHoldBreathBlend, 0, 1);

    // Hold-breath stabilization: strong muzzle drift mitigation (~75%), moderate climb mitigation (~30%)
    const driftBreathScale = THREE.MathUtils.lerp(1.0, 0.25, hb);
    const climbBreathScale = THREE.MathUtils.lerp(1.0, 0.70, hb);
    const misalignBreathScale = THREE.MathUtils.lerp(1.0, 0.75, hb);

    // Tightly braced in ADS (cheekWeld=1.0), compliant in Hip-Fire (cheekWeld=0.0) with muscular absorption
    const armLooseness = stanceCoupled ? THREE.MathUtils.lerp(1.0, 0.22, cheekWeld) : 0.45;
    const kickBackGain = stanceCoupled ? THREE.MathUtils.lerp(1.08, 0.72, cheekWeld) : 1.0;
    const pitchFlopGain = stanceCoupled ? THREE.MathUtils.lerp(1.06, 0.62, cheekWeld) : 1.0;
    const cantCompliance = stanceCoupled && this.lastIsCanted ? 0.14 : 0;
    const rollFlopGain = stanceCoupled
      ? THREE.MathUtils.lerp(1.05, 0.42, cheekWeld) + cantCompliance
      : 1.0;
    const misalignStanceGain = stanceCoupled ? THREE.MathUtils.lerp(1.05, 0.58, cheekWeld) : 1.0;

    this.rapidFireHeat = Math.min(1.0, this.rapidFireHeat + 0.30);
    const burstAmp = 0.65 + this.rapidFireHeat * 0.85;

    // Biomechanical muzzle-force drift: shoulder/forearm counter-torque resists outward travel
    // and naturally biases back toward the operator's centerline once deflected past ~2.8°
    const flipChance = Math.abs(this.muzzleDriftYaw) > 0.048 ? 0.76 : 0.42;
    if (Math.random() < flipChance) {
      this.muzzleDriftPolarity *= -1;
    }
    const dirBias = this.muzzleDriftPolarity * (0.72 + Math.random() * 0.50);
    const driftGain = stanceCoupled ? armLooseness * hipSwayScale : 0;
    const vertDriftGain = stanceCoupled ? armLooseness * (0.45 + hipSwayScale * 0.55) : 0;

    // 1. Axial rearward bore kickback + snappy muzzle whip (pivoted around rear grip/shoulder in WeaponAnimator)
    this.recoilZVel += kickBackM * (40 + massFactor * 6) * kickBackGain;
    this.recoilPitchVel += pitchRad * 27 * pitchFlopGain * climbBreathScale;
    this.recoilYawVel +=
      (dirBias * (Math.abs(pitchRad) * 5.2 + rawYawMag * 7.5) + yawRad * 5.0) *
      burstAmp *
      driftBreathScale *
      (stanceCoupled ? armLooseness * hipSwayScale : 0.15);
    this.recoilRollVel +=
      (yawRad * 13 + (Math.random() - 0.5) * 1.45) * rollFlopGain * driftBreathScale +
      dirBias * (pitchRad * 4.2) * burstAmp * driftGain * driftBreathScale * (1 - cheekWeld * 0.72);

    // 2. Persistent angular muzzle drift absorbed progressively by arms, shoulders & torso
    if (driftGain > 0.001) {
      this.muzzleDriftYawVel +=
        (dirBias * (0.025 + Math.abs(pitchRad) * 3.0 + rawYawMag * 5.2) + yawRad * 2.4) *
        burstAmp *
        driftGain *
        driftBreathScale;
      this.muzzleDriftPitchVel +=
        Math.abs(pitchRad) * (4.6 + Math.random() * 1.8) * burstAmp * vertDriftGain * climbBreathScale * THREE.MathUtils.lerp(1.0, 0.35, hb);
    }

    const heatMult = 0.55 + this.rapidFireHeat * 1.0;
    const mScale =
      this.currentProfile.sightMisalignScale *
      this.derivedStats.sightMisalignMult *
      misalignConfigScale *
      misalignStanceGain *
      misalignBreathScale *
      heatMult;

    this.sightMisalignPitchVel += pitchRad * (9.0 + Math.random() * 4.0) * mScale * climbBreathScale;
    this.sightMisalignYawVel += (yawRad * 11.0 + (Math.random() - 0.5) * 0.30) * mScale * driftBreathScale;
    this.sightMisalignRollVel += ((Math.random() - 0.5) * 1.25 + yawRad * 7.2) * mScale;
  }

  public setLaserMode(mode: 'visible_red' | 'ir_green'): void {
    this.laserMode = mode;
    this.syncLaserAppearance();
  }

  public setNvgOpticalActive(active: boolean): void {
    if (this.nvgOpticalActive === active) return;
    this.nvgOpticalActive = active;
    this.syncLaserAppearance();
  }

  public setIrLaserActive(active: boolean): void {
    if (this.irLaserActive === active) return;
    this.irLaserActive = active;
    this.syncLaserAppearance();
  }

  /**
   * Under active NVGs, magnified scopes and occluded iron sights cannot be cheek-welded
   * behind helmet tubes, so ADS realistically transitions to canted IR point-aim unless
   * an unmagnified NVG-compatible reflex optic is mounted.
   */
  public shouldForceNodsCantedAim(nvgActive: boolean): boolean {
    if (!nvgActive) return false;
    const isFirearm =
      this.currentProfile.holdClass === 'pistol' ||
      this.currentProfile.holdClass === 'rifle' ||
      this.currentProfile.holdClass === 'shotgun';
    if (!isFirearm) return false;
    if (this.derivedStats.isMagnifiedOptic) return true;
    const hasUnmagnifiedOptic = Boolean(this.currentAttachments.optic) && !this.derivedStats.isMagnifiedOptic;
    return !hasUnmagnifiedOptic;
  }

  private syncLaserAppearance(): void {
    const useIrSpectrum = this.nvgOpticalActive && (this.irLaserActive || this.laserOn);
    if (useIrSpectrum) {
      // Invisible to naked eye (IR_LAYER = 2), crisp bright emitter through NVG intensifier tubes
      this.laserBeamMesh.layers.set(IR_LAYER);
      this.laserDotMesh.layers.set(IR_LAYER);
      this.laserBeamMat.color.setHex(0xd8ffe6);
      this.laserBeamMat.opacity = 0.62;
      this.laserDotMat.color.setHex(0xffffff);
      this.laserDotMat.opacity = 1.0;
      return;
    }
    this.laserBeamMesh.layers.set(0);
    this.laserDotMesh.layers.set(0);
    if (this.laserMode === 'ir_green') {
      this.laserBeamMat.color.setHex(0x45ff6b);
      this.laserBeamMat.opacity = 0.42;
      this.laserDotMat.color.setHex(0x78ff96);
      this.laserDotMat.opacity = 0.95;
    } else {
      this.laserBeamMat.color.setHex(0xff2222);
      this.laserBeamMat.opacity = 0.42;
      this.laserDotMat.color.setHex(0xff4444);
      this.laserDotMat.opacity = 0.95;
    }
  }

  public getWeaponProfile(): Readonly<BodycamWeaponProfile> {
    return this.currentProfile;
  }

  private resolveSuppressorAttachmentId(profile: BodycamWeaponProfile): string {
    if (profile.id === 'nagant_m1895') return 'muzzle_nagant_bramit';
    if (profile.category === 'shotguns') return 'muzzle_salvo_12ga';
    if (profile.category === 'pistols' || profile.id === 'pm_9x19' || profile.id === 'hk_mp5') {
      return 'muzzle_9mm_suppressor';
    }
    if (profile.category === 'bolt_action' || profile.category === 'dmrs') {
      return 'muzzle_338_suppressor';
    }
    return 'muzzle_pbs4_545';
  }

  public setWeaponProfile(
    profile: BodycamWeaponProfile,
    suppressorOrAttachments: boolean | WeaponAttachments = false,
  ): void {
    const nextAttachments: WeaponAttachments =
      typeof suppressorOrAttachments === 'boolean'
        ? suppressorOrAttachments && profile.supportsSuppressor
          ? {
              muzzle: this.resolveSuppressorAttachmentId(profile),
            }
          : {}
        : normalizeWeaponAttachments(profile.id, suppressorOrAttachments);

    if (this.currentProfile.id === profile.id && this.assembly) {
      this.setAttachments(nextAttachments);
      return;
    }
    this.currentProfile = profile;
    this.currentAttachments = nextAttachments;
    this.rapidFireHeat = 0;
    this.recoilYaw = 0;
    this.recoilYawVel = 0;
    this.muzzleDriftPitch = 0;
    this.muzzleDriftPitchVel = 0;
    this.muzzleDriftYaw = 0;
    this.muzzleDriftYawVel = 0;
    this.muzzleDriftPolarity = 1;
    this.sightMisalignPitch = 0;
    this.sightMisalignYaw = 0;
    this.sightMisalignRoll = 0;
    this.sightMisalignPitchVel = 0;
    this.sightMisalignYawVel = 0;
    this.sightMisalignRollVel = 0;
    this.buildWeaponModel(profile, nextAttachments);
  }

  public setAttachments(attachments?: WeaponAttachments | null): DerivedWeaponStats {
    this.currentAttachments = normalizeWeaponAttachments(this.currentProfile.id, attachments);
    if (!this.assembly) {
      this.derivedStats = computeDerivedWeaponStats(
        this.currentProfile.massKg,
        this.currentProfile.barrelLengthM,
        this.currentProfile.magCapacity,
        this.currentAttachments,
      );
      return this.derivedStats;
    }

    this.derivedStats = WeaponAssembler.applyAttachments(
      this.assembly,
      this.currentProfile.massKg,
      this.currentProfile.barrelLengthM,
      this.currentProfile.magCapacity,
      this.currentAttachments,
    );
    this.syncOpticZoomIndex();
    this.syncSocketsFromAssembly(this.assembly);

    if (!this.derivedStats.hasFlashlight) {
      this.flashlight.visible = false;
    }
    if (!this.derivedStats.hasLaser) {
      this.laserOn = false;
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
    }
    return this.derivedStats;
  }

  public setSuppressorVisible(visible: boolean): void {
    const next: WeaponAttachments = { ...this.currentAttachments };
    if (visible && this.currentProfile.supportsSuppressor) {
      next.muzzle = this.resolveSuppressorAttachmentId(this.currentProfile);
    } else if (!visible) {
      next.muzzle = null;
    }
    this.setAttachments(next);
  }

  private syncMuzzleFromAssembly(): void {
    if (!this.assembly) return;
    this.muzzleAnchor.position.copy(this.assembly.muzzleSocket.position);
    this.muzzleAnchor.rotation.copy(this.assembly.muzzleSocket.rotation);
  }

  private syncSocketsFromAssembly(asm: WeaponModelAssembly): void {
    this.rightHandSocketAnchor.position.copy(asm.rightHandSocket.position);
    this.rightHandSocketAnchor.rotation.copy(asm.rightHandSocket.rotation);
    if (asm.leftHandSocket.parent && asm.leftHandSocket.parent !== asm.group) {
      asm.group.updateMatrixWorld(true);
      asm.leftHandSocket.getWorldPosition(this.leftHandSocketAnchor.position);
      asm.group.worldToLocal(this.leftHandSocketAnchor.position);
      this.leftHandSocketAnchor.rotation.copy(asm.leftHandSocket.rotation);
    } else {
      this.leftHandSocketAnchor.position.copy(asm.leftHandSocket.position);
      this.leftHandSocketAnchor.rotation.copy(asm.leftHandSocket.rotation);
    }
    this.hasLeftHandSocket = asm.hasLeftHandSocket;

    this.syncMuzzleFromAssembly();
    this.laserAnchor.position.copy(asm.laserSocket.position);
    this.laserAnchor.rotation.copy(asm.laserSocket.rotation);
    this.magWellAnchor.position.copy(asm.magWellSocket.position);
    this.boltRackAnchor.position.copy(asm.boltRackSocket.position);
    this.flashlight.position.copy(asm.flashlightSocket.position);
  }

  private clearModel(): void {
    this.weaponAnimator.attachModel(null, 'pistol', false);
    if (this.assembly) {
      this.modelGroup.remove(this.assembly.group);
      this.assembly.dispose();
      this.assembly = null;
    }
    this.modelGroup.visible = true;
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.rotation.set(0, 0, 0);
  }

  private buildWeaponModel(spec: BodycamWeaponProfile, attachments: WeaponAttachments): void {
    this.clearModel();

    const asm = WeaponModelFactory.build(
      {
        id: spec.id,
        holdClass: spec.holdClass,
        barrelLengthM: spec.barrelLengthM,
        visualStyle: spec.visualStyle,
        finish: spec.finish,
        railType: spec.railType,
        isRevolver: spec.isRevolver,
        boreAxisHeightM: spec.boreAxisHeightM,
        modularCaliberId: spec.defaultCaliberId,
        rightHandSocket: spec.rightHandSocket,
        leftHandSocket: spec.leftHandSocket,
        muzzleOffset: spec.muzzleOffset,
        laserOffset: spec.laserOffset,
        supportsSuppressor: spec.supportsSuppressor,
      },
      false,
    );

    this.assembly = asm;
    this.modelGroup.add(asm.group);

    this.derivedStats = WeaponAssembler.applyAttachments(
      asm,
      spec.massKg,
      spec.barrelLengthM,
      spec.magCapacity,
      attachments,
    );
    this.syncOpticZoomIndex();
    this.syncSocketsFromAssembly(asm);

    if (!this.derivedStats.hasFlashlight) {
      this.flashlight.visible = false;
    }
    if (!this.derivedStats.hasLaser) {
      this.laserOn = false;
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
    }

    const isUnarmed = spec.visualStyle === 'unarmed' || spec.holdClass === 'unarmed';
    const animWeightClass: 'pistol' | 'carbine' | 'heavy_rifle' =
      spec.weightClass === 'carbine' || spec.weightClass === 'heavy_rifle'
        ? spec.weightClass
        : 'pistol';
    this.weaponAnimator.attachModel(isUnarmed ? null : asm, animWeightClass, !isUnarmed);
  }

  public triggerFire(
    suppressed: boolean,
    remainingAmmoAfterShot?: number,
    cyclePump?: boolean,
  ): void {
    if (this.isSuppressorActionActive()) return;
    this.cancelZoomTwist();
    const flashScale = suppressed ? 0.12 : this.derivedStats.muzzleFlashScale;
    this.flashTimer = suppressed ? 0.025 : 0.045;
    this.muzzleFlashLight.intensity = suppressed ? 1.8 : 14.5 * flashScale;
    this.muzzleFlashMesh.visible = !suppressed && flashScale > 0.2;
    this.muzzleFlashMesh.rotation.z = Math.random() * Math.PI;
    this.muzzleFlashMesh.scale.setScalar((0.85 + Math.random() * 0.55) * Math.max(0.65, flashScale));

    if (this.currentProfile.muzzleVelocityMps > 0) {
      this.weaponAnimator.triggerFire(suppressed, remainingAmmoAfterShot, {
        cyclePump: cyclePump ?? this.currentProfile.fireMode === 'pump',
        cycleBolt: this.currentProfile.fireMode === 'bolt',
        boltDurationSec: this.currentProfile.boltCycleDurationSec,
        isRevolver: Boolean(this.currentProfile.isRevolver),
      });
    }
  }

  public applyCharacterActionPose(
    posOffset: THREE.Vector3,
    rotOffset: THREE.Euler,
    _magDropOffsetY = 0,
    _boltBackOffsetZ = 0,
    hideModel = false,
  ): void {
    this.modelGroup.visible = !hideModel;
    this.modelGroup.position.copy(posOffset);
    this.modelGroup.rotation.copy(rotOffset);
    this.modelGroup.updateMatrixWorld(true);
  }

  public getMuzzleWorldTransform(outPos: THREE.Vector3, outDir: THREE.Vector3, applyZeroPitch = false): void {
    this.root.updateMatrixWorld(true);
    this.muzzleAnchor.getWorldPosition(outPos);
    this.muzzleAnchor.getWorldQuaternion(this._tmpQuat);
    if (applyZeroPitch && Math.abs(this.zeroPitchRad) > 1e-6) {
      this._zeroPitchQuat.setFromAxisAngle(this._zeroAxisX, this.zeroPitchRad);
      this._tmpQuat.multiply(this._zeroPitchQuat);
    }
    outDir.set(0, 0, -1).applyQuaternion(this._tmpQuat).normalize();
  }

  /**
   * Updates the visible/IR tactical laser after post-IK hard-lock so the beam
   * originates cleanly from the final locked PEQ emitter and terminates on world surfaces.
   */
  public updateLaserBeam(adapter: IBodycamWorldAdapter): void {
    const isFirearm =
      this.currentProfile.holdClass === 'pistol' ||
      this.currentProfile.holdClass === 'rifle' ||
      this.currentProfile.holdClass === 'shotgun';
    const visibleLaserAllowed =
      this.laserOn && this.currentProfile.supportsLaser && this.derivedStats.hasLaser;
    const irLaserAllowed =
      this.nvgOpticalActive && this.irLaserActive && isFirearm;
    const active =
      (visibleLaserAllowed || irLaserAllowed) &&
      this.modelGroup.visible &&
      !this.lastIsSprinting &&
      this.vaultRetentionBlend < 0.25 &&
      !this.weaponAnimator.isReloading() &&
      !this.weaponAnimator.isSuppressorActionActive();

    if (!active) {
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
      return;
    }

    this.root.updateMatrixWorld(true);
    this.laserAnchor.getWorldPosition(this._laserOrigin);
    this.laserAnchor.getWorldQuaternion(this._tmpQuat);
    this._laserDir.set(0, 0, -1).applyQuaternion(this._tmpQuat).normalize();

    const maxRange = 65;
    const hit = adapter.raycast(this._laserOrigin, this._laserDir, 0.08, maxRange, this._rayHit);
    const beamLen = hit ? Math.max(0.05, this._rayHit.distance - 0.01) : maxRange;

    this._laserMid.copy(this._laserOrigin).addScaledVector(this._laserDir, beamLen * 0.5);
    this.laserBeamMesh.position.copy(this._laserMid);
    this.laserBeamMesh.quaternion.setFromUnitVectors(this._upAxis, this._laserDir);
    this.laserBeamMesh.scale.set(1, beamLen, 1);
    this.laserBeamMesh.visible = true;

    if (hit) {
      this.laserDotMesh.position.set(
        this._rayHit.pointX - this._laserDir.x * 0.012,
        this._rayHit.pointY - this._laserDir.y * 0.012,
        this._rayHit.pointZ - this._laserDir.z * 0.012,
      );
      const distScale = THREE.MathUtils.clamp(0.7 + this._rayHit.distance * 0.045, 0.7, 2.8);
      this.laserDotMesh.scale.setScalar(distScale);
      this.laserDotMesh.visible = true;
    } else {
      this.laserDotMesh.visible = false;
    }
  }

  public hasCantedOptic(): boolean {
    return Boolean(this.assembly?.hasCantedOptic || this.derivedStats.hasCantedOptic);
  }

  public getReadOnlyRigState(): Readonly<ReadOnlyWeaponRigState> {
    const s = this._rigStateSnapshot;
    s.aimYaw = this.lastAimYaw;
    s.aimPitch = this.lastAimPitch;
    s.isAds = this.lastIsAds;
    s.isCanted = this.lastIsCanted;
    s.isPointAim = this.lastIsPointAim;
    s.isSprinting = this.lastIsSprinting;
    s.isMoving = this.lastIsMoving;
    s.strideProgress = this.lastStrideProgress;
    s.pullbackRatio = this.pullbackRatio;
    s.recoilX = 0;
    s.recoilZ = this.recoilZ;
    s.recoilPitch = this.recoilPitch;
    s.recoilYaw = this.recoilYaw;
    s.recoilRoll = this.recoilRoll;
    s.muzzleDriftPitch = this.muzzleDriftPitch;
    s.muzzleDriftYaw = this.muzzleDriftYaw;
    s.sightMisalignPitch = this.sightMisalignPitch;
    s.sightMisalignYaw = this.sightMisalignYaw;
    s.sightMisalignDeg = THREE.MathUtils.radToDeg(
      Math.hypot(this.sightMisalignPitch, this.sightMisalignYaw),
    );
    s.adsBlend = this.adsBlend;
    s.cantBlend = this.cantBlend;
    s.pointAimBlend = this.pointAimBlend;
    s.sprintBlend = this.sprintBlend;
    s.laserOn = this.laserOn;
    return s;
  }

  private stepSpringScalar(
    val: number,
    vel: number,
    omega: number,
    dt: number,
    dampingRatio = 1.0,
  ): [number, number] {
    return stepAnalyticalDampedSpring(val, vel, 0, omega, dampingRatio, dt);
  }

  public updateRig(
    dt: number,
    elapsed: number,
    spec: BodycamWeaponProfile,
    aimYaw: number,
    aimPitch: number,
    isAds: boolean,
    isCanted: boolean,
    isSprinting: boolean,
    isMoving: boolean,
    strideProgress: number,
    breathX: number,
    breathY: number,
    camWorldPos: Readonly<THREE.Vector3>,
    camWorldQuat: Readonly<THREE.Quaternion>,
    adapter: IBodycamWorldAdapter,
    config: Readonly<BodycamSDKConfig>,
    adsSpeedMult = 1.0,
    vaultRetentionMode: 'NONE' | 'ONE_HAND_TUCK' | 'TWO_HAND_SLING' = 'NONE',
    vaultRetentionBlend = 0,
    bobPhase?: number,
    verticalMotionOffset = 0,
    weaponRootPitchRad = 0,
    minWeaponPitchRad = THREE.MathUtils.degToRad(config.minWeaponPitchDeg ?? -50),
    maxWeaponPitchRad = THREE.MathUtils.degToRad(config.maxWeaponPitchDeg ?? 68),
    lateralMotion = 0,
    isPointAim = false,
    holdBreathBlend = 0,
  ): void {
    const isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';
    const hasCanted = this.hasCantedOptic();
    this.lastAimYaw = aimYaw;
    this.lastAimPitch = aimPitch;
    this.lastIsAds = isAds;
    this.lastIsCanted = isCanted && hasCanted && isFirearm && !isSprinting;
    this.lastIsPointAim = isPointAim && isFirearm && !isSprinting;
    this.lastIsSprinting = isSprinting;
    this.lastIsMoving = isMoving;
    this.lastStrideProgress = strideProgress;
    this.lastHoldBreathBlend = THREE.MathUtils.damp(
      this.lastHoldBreathBlend,
      THREE.MathUtils.clamp(holdBreathBlend, 0, 1),
      16,
      dt,
    );
    this.vaultRetentionMode = vaultRetentionMode;
    this.vaultRetentionBlend = THREE.MathUtils.damp(
      this.vaultRetentionBlend,
      vaultRetentionMode === 'NONE' ? 0 : THREE.MathUtils.clamp(vaultRetentionBlend, 0, 1),
      18,
      dt,
    );

    this.flashlight.angle = THREE.MathUtils.degToRad(config.flashlightAngleDeg);

    // 1. Mass-parameterized 2nd-order recoil whip + biomechanically damped persistent muzzle drift springs
    const massFactor = this.getMassHandlingFactor();
    const recOmegaZ = THREE.MathUtils.clamp(25 / Math.sqrt(massFactor), 16, 28);
    const recOmegaPitch = THREE.MathUtils.clamp(20 / Math.sqrt(massFactor), 13.5, 24);
    const recOmegaRoll = THREE.MathUtils.clamp(17.5 / Math.sqrt(massFactor), 12, 21);
    const recOmegaYaw = THREE.MathUtils.clamp(15.5 / Math.sqrt(massFactor), 11.8, 19.0);
    const baseDriftOmegaYaw = THREE.MathUtils.clamp(7.4 / Math.sqrt(massFactor), 5.8, 9.2);
    const baseDriftOmegaPitch = THREE.MathUtils.clamp(8.0 / Math.sqrt(massFactor), 6.2, 9.8);

    const targetCheekWeld = this.lastIsAds
      ? 1.0
      : this.lastIsCanted
        ? 0.92
        : this.lastIsPointAim
          ? 0.5
          : 0.0;
    this.lastCheekWeld = THREE.MathUtils.damp(this.lastCheekWeld, targetCheekWeld, 14, dt);

    // Progressive muscular/centrifugal resistance: restoring stiffness stiffens rapidly with deflection
    // so recoil momentum is visibly arrested into the forearms, shoulders, and torso instead of swinging freely
    const braceFactor = Math.max(this.lastCheekWeld, this.lastHoldBreathBlend);
    const effDriftOmegaYaw =
      baseDriftOmegaYaw *
      (1 + Math.abs(this.muzzleDriftYaw) * 7.5) *
      THREE.MathUtils.lerp(1.0, 1.35, this.lastHoldBreathBlend);
    const effDriftOmegaPitch =
      baseDriftOmegaPitch *
      (1 + Math.abs(this.muzzleDriftPitch) * 7.0) *
      THREE.MathUtils.lerp(1.0, 1.25, this.lastHoldBreathBlend);

    const horizDampYaw = THREE.MathUtils.lerp(0.80, 0.94, braceFactor);
    const driftDampYaw = THREE.MathUtils.lerp(0.84, 0.96, braceFactor);
    const driftDampPitch = THREE.MathUtils.lerp(0.86, 0.96, braceFactor);

    [this.recoilZ, this.recoilZVel] = this.stepSpringScalar(this.recoilZ, this.recoilZVel, recOmegaZ, dt);
    [this.recoilZ, this.recoilZVel] = clampSpringState(this.recoilZ, this.recoilZVel, -0.02, 0.14);
    [this.recoilPitch, this.recoilPitchVel] = this.stepSpringScalar(
      this.recoilPitch,
      this.recoilPitchVel,
      recOmegaPitch,
      dt,
    );
    [this.recoilPitch, this.recoilPitchVel] = clampSpringState(
      this.recoilPitch,
      this.recoilPitchVel,
      -0.18,
      0.34,
    );
    [this.recoilYaw, this.recoilYawVel] = this.stepSpringScalar(
      this.recoilYaw,
      this.recoilYawVel,
      recOmegaYaw,
      dt,
      horizDampYaw,
    );
    [this.recoilYaw, this.recoilYawVel] = clampSpringState(
      this.recoilYaw,
      this.recoilYawVel,
      -0.065,
      0.065,
    );
    [this.recoilRoll, this.recoilRollVel] = this.stepSpringScalar(
      this.recoilRoll,
      this.recoilRollVel,
      recOmegaRoll,
      dt,
    );
    [this.recoilRoll, this.recoilRollVel] = clampSpringState(
      this.recoilRoll,
      this.recoilRollVel,
      -0.24,
      0.24,
    );

    [this.muzzleDriftYaw, this.muzzleDriftYawVel] = this.stepSpringScalar(
      this.muzzleDriftYaw,
      this.muzzleDriftYawVel,
      effDriftOmegaYaw,
      dt,
      driftDampYaw,
    );
    if (this.muzzleDriftYaw > 0.085) {
      this.muzzleDriftYaw = 0.085;
      if (this.muzzleDriftYawVel > 0) this.muzzleDriftYawVel = 0;
    } else if (this.muzzleDriftYaw < -0.085) {
      this.muzzleDriftYaw = -0.085;
      if (this.muzzleDriftYawVel < 0) this.muzzleDriftYawVel = 0;
    }

    [this.muzzleDriftPitch, this.muzzleDriftPitchVel] = this.stepSpringScalar(
      this.muzzleDriftPitch,
      this.muzzleDriftPitchVel,
      effDriftOmegaPitch,
      dt,
      driftDampPitch,
    );
    if (this.muzzleDriftPitch > 0.095) {
      this.muzzleDriftPitch = 0.095;
      if (this.muzzleDriftPitchVel > 0) this.muzzleDriftPitchVel = 0;
    } else if (this.muzzleDriftPitch < -0.03) {
      this.muzzleDriftPitch = -0.03;
      if (this.muzzleDriftPitchVel < 0) this.muzzleDriftPitchVel = 0;
    }

    // 2. Independent Sight Misalignment rotational springs
    this.rapidFireHeat = Math.max(0, this.rapidFireHeat - dt * 1.45);
    const misOmega = THREE.MathUtils.clamp(14.5 / Math.sqrt(massFactor), 10.5, 18.0);
    [this.sightMisalignPitch, this.sightMisalignPitchVel] = this.stepSpringScalar(
      this.sightMisalignPitch,
      this.sightMisalignPitchVel,
      misOmega,
      dt,
      0.78,
    );
    [this.sightMisalignYaw, this.sightMisalignYawVel] = this.stepSpringScalar(
      this.sightMisalignYaw,
      this.sightMisalignYawVel,
      misOmega * 0.92,
      dt,
      0.75,
    );
    [this.sightMisalignRoll, this.sightMisalignRollVel] = this.stepSpringScalar(
      this.sightMisalignRoll,
      this.sightMisalignRollVel,
      misOmega * 0.85,
      dt,
      0.80,
    );

    // 2b. Coupled 6-DOF mass-tuned weapon & hand spring-damper solver
    //     Integrates camera-turn inertia/counter-tilt, footstep cadence impulses, hard-landing
    //     compression, and mechanical action counter-jolts (H&K slap, mag tap, pump cycle).
    const springTuning = computeWeaponSpringTuning(massFactor);
    const adsTighten = THREE.MathUtils.lerp(1.0, 1.24, this.lastCheekWeld);
    const rotOmega = springTuning.rotOmega * adsTighten;
    const rotZeta = THREE.MathUtils.lerp(springTuning.rotZeta, Math.min(0.92, springTuning.rotZeta + 0.16), this.lastCheekWeld);
    const posOmega = springTuning.posOmega * adsTighten;
    const posZeta = THREE.MathUtils.lerp(springTuning.posZeta, Math.min(0.94, springTuning.posZeta + 0.15), this.lastCheekWeld);

    // Footstep cadence impulse on stride half-cycle edge
    const phaseNow = bobPhase !== undefined ? bobPhase : strideProgress * Math.PI;
    const stepIdx = Math.floor(phaseNow / Math.PI);
    if (isMoving && stepIdx !== this.prevStrideStepIdx) {
      const footSign = (stepIdx & 1) === 0 ? 1 : -1;
      const cadenceGain = (isSprinting ? 1.55 : 0.72) * THREE.MathUtils.lerp(1.0, 0.28, this.lastCheekWeld);
      this.motionPosVelY -= 0.095 * cadenceGain * Math.sqrt(massFactor);
      this.motionPosVelX += footSign * 0.042 * cadenceGain;
      this.lagRollVel += footSign * 0.18 * cadenceGain;
      this.lagPitchVel -= 0.08 * cadenceGain;
    }
    this.prevStrideStepIdx = stepIdx;

    // Hard-landing vertical compression impulse coupled into weapon spring
    const vertDelta = verticalMotionOffset - this.prevVerticalMotionOffset;
    if (vertDelta < -0.014) {
      const impactMag = Math.min(1.8, (-vertDelta - 0.014) * 28) * Math.sqrt(massFactor);
      this.motionPosVelY -= 0.28 * impactMag;
      this.lagPitchVel -= 0.34 * impactMag;
      this.lagRollVel += 0.12 * impactMag;
    }
    this.prevVerticalMotionOffset = verticalMotionOffset;

    // Drain physical mechanical counter-impulses from WeaponAnimator (H&K slap, mag baseplate tap, AR slap, pump stroke)
    if (this.weaponAnimator.consumeMechanicalSpringImpulse(this._mechImpulsePos, this._mechImpulseRot)) {
      const invMass = 1 / Math.sqrt(Math.max(0.55, massFactor));
      this.motionPosVelX += this._mechImpulsePos.x * invMass;
      this.motionPosVelY += this._mechImpulsePos.y * invMass;
      this.motionPosVelZ += this._mechImpulsePos.z * invMass;
      this.lagPitchVel += this._mechImpulseRot.x * invMass;
      this.lagYawVel += this._mechImpulseRot.y * invMass;
      this.lagRollVel += this._mechImpulseRot.z * invMass;
    }

    [this.lagYaw, this.lagYawVel] = this.stepSpringScalar(this.lagYaw, this.lagYawVel, rotOmega, dt, rotZeta);
    [this.lagPitch, this.lagPitchVel] = this.stepSpringScalar(this.lagPitch, this.lagPitchVel, rotOmega * 1.04, dt, rotZeta);
    [this.lagRoll, this.lagRollVel] = this.stepSpringScalar(this.lagRoll, this.lagRollVel, rotOmega * 0.92, dt, rotZeta);
    [this.motionPosX, this.motionPosVelX] = this.stepSpringScalar(this.motionPosX, this.motionPosVelX, posOmega, dt, posZeta);
    [this.motionPosY, this.motionPosVelY] = this.stepSpringScalar(this.motionPosY, this.motionPosVelY, posOmega * 1.06, dt, posZeta);
    [this.motionPosZ, this.motionPosVelZ] = this.stepSpringScalar(this.motionPosZ, this.motionPosVelZ, posOmega * 1.12, dt, posZeta);

    [this.lagYaw, this.lagYawVel] = clampSpringState(this.lagYaw, this.lagYawVel, -0.11, 0.11);
    [this.lagPitch, this.lagPitchVel] = clampSpringState(this.lagPitch, this.lagPitchVel, -0.10, 0.10);
    [this.lagRoll, this.lagRollVel] = clampSpringState(this.lagRoll, this.lagRollVel, -0.14, 0.14);
    [this.motionPosX, this.motionPosVelX] = clampSpringState(this.motionPosX, this.motionPosVelX, -0.026, 0.026);
    [this.motionPosY, this.motionPosVelY] = clampSpringState(this.motionPosY, this.motionPosVelY, -0.032, 0.024);
    [this.motionPosZ, this.motionPosVelZ] = clampSpringState(this.motionPosZ, this.motionPosVelZ, -0.026, 0.028);

    // 3. Muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.muzzleFlashLight.intensity = 0;
        this.muzzleFlashMesh.visible = false;
      }
    }

    // 4. Physical Wall Pullback Multi-Ray Envelope (prevents barrel, suppressor & handguard clipping)
    this.root.updateMatrixWorld(true);
    this.shoulderAnchor.getWorldPosition(this._shoulderWorld);
    this._barrelDir
      .set(0, 0, -1)
      .applyEuler(this._tmpEuler.set(aimPitch, aimYaw, 0, 'YXZ'))
      .applyQuaternion(this.root.quaternion)
      .normalize();

    const effectiveBarrelLenM =
      this.derivedStats.barrelLengthM > 0 ? this.derivedStats.barrelLengthM : spec.barrelLengthM;
    const backStepM = 0.14;
    const triggerDist = Math.min(1.32, (effectiveBarrelLenM + 0.30) * config.wallPullbackScale);
    const probeMax = triggerDist + backStepM + 0.05;

    // Build orthonormal lateral/vertical offsets around barrel axis (zero GC via _camCenterDir & _tmpEuler)
    const bx = this._barrelDir.x;
    const by = this._barrelDir.y;
    const bz = this._barrelDir.z;
    let rx = -bz;
    let rz = bx;
    const rLen = Math.hypot(rx, rz);
    if (rLen > 1e-4) {
      rx /= rLen;
      rz /= rLen;
    } else {
      rx = 1;
      rz = 0;
    }

    let hit = false;
    let wallDist = 999;
    let bestHitY = this._shoulderWorld.y;
    let bestHitNormalY = 0;
    const offsets: ReadonlyArray<[number, number]> = [
      [0, 0],
      [0.065, 0],
      [-0.065, 0],
      [0, -0.055],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const ox = offsets[i][0];
      const oy = offsets[i][1];
      this._camCenterDir.set(
        this._shoulderWorld.x - bx * backStepM + rx * ox,
        this._shoulderWorld.y - by * backStepM + oy,
        this._shoulderWorld.z - bz * backStepM + rz * ox,
      );
      if (adapter.raycast(this._camCenterDir, this._barrelDir, 0.02, probeMax, this._rayHit)) {
        const effDist = Math.max(0, this._rayHit.distance - backStepM);
        if (effDist < wallDist) {
          wallDist = effDist;
          hit = true;
          bestHitY = this._rayHit.pointY;
          bestHitNormalY = this._rayHit.normalY;
        }
      }
    }

    const pullbackSpan = 0.32 + effectiveBarrelLenM * 0.14;
    let targetPullback =
      wallDist < triggerDist
        ? THREE.MathUtils.clamp((triggerDist - wallDist) / pullbackSpan, 0, 1)
        : 0;

    if (hit && targetPullback > 0) {
      const hitBelowShoulder = this._shoulderWorld.y - bestHitY;
      if (bestHitNormalY > 0.65 && this._barrelDir.y < -0.20) {
        const floorFade = THREE.MathUtils.clamp((0.82 - bestHitNormalY) / 0.17, 0, 1);
        targetPullback *= floorFade;
      } else if (this._barrelDir.y < -0.25 && hitBelowShoulder > 0.28) {
        const downFade = THREE.MathUtils.clamp((-0.25 - this._barrelDir.y) / 0.23, 0, 1);
        targetPullback *= 1 - downFade;
      }
    }
    if (this.vaultRetentionBlend > 0.05) {
      targetPullback *= 1 - this.vaultRetentionBlend;
    }
    this.pullbackRatio = THREE.MathUtils.damp(this.pullbackRatio, targetPullback, 20, dt);

    // 5. Evaluate Pose Graph + exact sightAnchor ADS + Bore-Anchored Point Aim convergence + mechanical gun animation
    const isPistol = spec.weightClass === 'pistol';
    const pointAimRollDeg = isPistol
      ? Math.min(32, config.cantAngleDeg * 0.8)
      : config.cantAngleDeg;
    const pointAimRollRad = THREE.MathUtils.degToRad(pointAimRollDeg);
    const boreY = this.muzzleAnchor.position.y;
    const muzzleLocalZ = this.muzzleAnchor.position.z;
    const eyeRelief = this.assembly ? this.assembly.adsEyeReliefM : 0.23;

    // Anchor Point Aim directly to the firearm's bore axis so the barrel sits dead-center below the aim point,
    // top rail & primary optic lean cleanly left, and rifles keep full handguard + laser visible (Image 1)
    // while pistols adopt a tight centered Center Axis Relock (CAR) stance.
    const boreTargetX = 0.004;
    const boreTargetY = isPistol ? -0.048 : -0.056;
    const boreTargetZ = isPistol ? -0.22 : -Math.max(0.23, eyeRelief + 0.025);
    const cosR = Math.cos(pointAimRollRad);
    const sinR = Math.sin(pointAimRollRad);
    const ptX = boreTargetX + boreY * sinR;
    const ptY = boreTargetY - boreY * cosR;
    const ptZ = boreTargetZ;
    this._pointAimOffsetBuf[0] = ptX;
    this._pointAimOffsetBuf[1] = ptY;
    this._pointAimOffsetBuf[2] = ptZ;

    // Led-aim-ray convergence raycast (clamped 8m–40m, defaulting to 25m on open sky)
    // so both muzzle trajectory and PEQ laser converge dead-on to the led aim ray during Point Aim.
    let convPitchRad = 0;
    let convYawRad = 0;
    if (isFirearm && (this.lastIsPointAim || this.pointAimBlend > 0.01)) {
      this._camCenterDir
        .set(0, 0, -1)
        .applyEuler(this._tmpEuler.set(aimPitch, aimYaw, 0, 'YXZ'))
        .applyQuaternion(camWorldQuat as THREE.Quaternion)
        .normalize();
      const centerHit = adapter.raycast(camWorldPos, this._camCenterDir, 0.5, 42, this._rayHit);
      const rawDist = centerHit ? THREE.MathUtils.clamp(this._rayHit.distance, 8, 40) : 25;
      this.smoothedPointAimConvDist = THREE.MathUtils.damp(this.smoothedPointAimConvDist, rawDist, 10, dt);

      const forwardSpan = Math.max(4.0, this.smoothedPointAimConvDist + ptZ + muzzleLocalZ);
      convYawRad = THREE.MathUtils.clamp(Math.atan2(boreTargetX, forwardSpan), -0.06, 0.06);
      convPitchRad = THREE.MathUtils.clamp(Math.atan2(-boreTargetY, forwardSpan), -0.06, 0.06);
    }

    const phase = bobPhase !== undefined ? bobPhase : strideProgress * Math.PI;

    const pIn = this._poseInput;
    pIn.dt = dt;
    pIn.elapsed = elapsed;
    pIn.isFirearm = isFirearm;
    pIn.isUnarmed = spec.holdClass === 'unarmed';
    pIn.massHandlingFactor = massFactor;
    pIn.weightClass =
      spec.weightClass === 'carbine' || spec.weightClass === 'heavy_rifle'
        ? spec.weightClass
        : 'pistol';
    pIn.aimYaw = aimYaw;
    pIn.aimPitch = aimPitch;
    pIn.isAds = isAds;
    pIn.isCanted = this.lastIsCanted;
    pIn.isPointAim = this.lastIsPointAim;
    pIn.isSprinting = isSprinting;
    pIn.isMoving = isMoving;
    pIn.bobPhase = phase;
    pIn.verticalMotionOffset = verticalMotionOffset;
    pIn.pullbackRatio = this.pullbackRatio;
    pIn.barrelLengthM = effectiveBarrelLenM;
    pIn.vaultRetentionMode = this.vaultRetentionMode;
    pIn.vaultRetentionBlend = this.vaultRetentionBlend;
    pIn.adsSpeedMult = adsSpeedMult * this.derivedStats.adsSpeedMult;
    pIn.cantAngleRad = pointAimRollRad;
    pIn.pointAimOffset = this._pointAimOffsetBuf;
    pIn.pointAimRollRad = pointAimRollRad;
    pIn.pointAimConvPitchRad = convPitchRad;
    pIn.pointAimConvYawRad = convYawRad;
    pIn.hipOffset = spec.hipOffset;
    pIn.cantOffset = spec.cantOffset;
    pIn.lowReadyOffset = spec.lowReadyOffset;
    pIn.lowReadyRotation = spec.lowReadyRotation;
    pIn.breathX = breathX;
    pIn.breathY = breathY;
    pIn.recoilX = 0;
    pIn.recoilZ = this.recoilZ;
    pIn.recoilPitch = this.recoilPitch;
    pIn.recoilYaw = this.recoilYaw;
    pIn.recoilRoll = this.recoilRoll;
    pIn.muzzleDriftPitch = this.muzzleDriftPitch;
    pIn.muzzleDriftYaw = this.muzzleDriftYaw;
    pIn.sightMisalignPitch = this.sightMisalignPitch;
    pIn.sightMisalignYaw = this.sightMisalignYaw;
    pIn.sightMisalignRoll = this.sightMisalignRoll;
    pIn.lagYaw = this.lagYaw;
    pIn.lagPitch = this.lagPitch;
    pIn.lagRoll = this.lagRoll;
    pIn.motionPosX = this.motionPosX;
    pIn.motionPosY = this.motionPosY;
    pIn.motionPosZ = this.motionPosZ;
    pIn.camWorldPos = camWorldPos;
    pIn.camWorldQuat = camWorldQuat;
    pIn.weaponRootPitchRad = weaponRootPitchRad;
    pIn.minWeaponPitchRad = minWeaponPitchRad;
    pIn.maxWeaponPitchRad = maxWeaponPitchRad;
    pIn.lateralMotion = lateralMotion;
    pIn.opticParallaxStrength = config.opticParallaxStrength ?? 1.0;

    this.weaponAnimator.updatePoseGraph(pIn);
    this.adsBlend = this.weaponAnimator.adsBlend;
    this.cantBlend = this.weaponAnimator.cantBlend;
    this.pointAimBlend = this.weaponAnimator.pointAimBlend;
    this.sprintBlend = this.weaponAnimator.sprintBlend;

    // 6. Smooth variable-zoom magnification interpolation & 0.28s interruptible zoom-ring IK timer (ADS + ready stance!)
    if (
      this.zoomTwistActive &&
      (isSprinting ||
        this.weaponAnimator.getActiveAction() !== 'NONE' ||
        this.weaponAnimator.isTubularReloading() ||
        vaultRetentionBlend > 0.1)
    ) {
      this.cancelZoomTwist();
    }
    if (this.zoomTwistActive) {
      this.zoomTwistTimer += dt;
      if (this.zoomTwistTimer >= this.zoomTwistDuration) {
        this.cancelZoomTwist();
      }
    }
    if (this.derivedStats.opticZoomLevels.length > 0) {
      this.scopeZoomCurrent = THREE.MathUtils.damp(this.scopeZoomCurrent, this.scopeZoomTarget, 18, dt);
      this.applyZoomRingPivotAngle();
    }

    this.root.updateMatrixWorld(true);
  }

  public dispose(): void {
    this.clearModel();
    this.weaponAnimator.dispose();
    this.muzzleFlashMesh.geometry.dispose();
    (this.muzzleFlashMesh.material as THREE.Material).dispose();
    this.laserBeamMesh.geometry.dispose();
    this.laserBeamMat.dispose();
    this.laserDotMesh.geometry.dispose();
    this.laserDotMat.dispose();
    this.scene.remove(this.laserBeamMesh, this.laserDotMesh);
  }
}

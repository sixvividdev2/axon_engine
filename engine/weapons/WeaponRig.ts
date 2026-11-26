import * as THREE from 'three';
import { IBodycamAudioSource } from '../../bodycam-sdk/IBodycamAudioSource';
import {
  BodycamRaycastResult,
  createRaycastResult,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { WeaponAnimator, WeaponPoseUpdateInput } from '../../bodycam-sdk/weapons/WeaponAnimator';
import { WeaponAssembler } from '../../bodycam-sdk/weapons/WeaponAssembler';
import { WeaponModelAssembly, WeaponModelFactory } from '../../bodycam-sdk/weapons/WeaponModelFactory';
import {
  computeDerivedWeaponStats,
  DerivedWeaponStats,
  getOwnedSuppressorDef,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../../data/attachments';
import { WEAPONS, WeaponId, WeaponSpec } from '../../data/weapons';
import { VIEWMODEL_LAYER } from '../render/BodycamPostProcess';

export type TacticalLaserMode = 'red' | 'ir_green';
export type VaultWeaponRetentionMode = 'NONE' | 'ONE_HAND_TUCK' | 'TWO_HAND_SLING';

export interface ReadOnlyWeaponRigState {
  aimYaw: number;
  aimPitch: number;
  isAds: boolean;
  isCanted: boolean;
  isPointAim: boolean;
  isSprinting: boolean;
  isMoving: boolean;
  strideProgress: number;
  bobPhase: number;
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
  adsBlend: number;
  cantBlend: number;
  pointAimBlend: number;
  sprintBlend: number;
  laserOn: boolean;
}

// Right shoulder anchor relative to chest root (aligned with BodycamController chestCenter)
const RIGHT_SHOULDER_LOCAL = new THREE.Vector3(0.18, -0.22, -0.08);

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

  // Rail-mounted PEQ-15 tactical laser (red visible / IR green)
  public laserOn = false;
  public laserMode: TacticalLaserMode = 'red';
  private readonly laserBeamMesh: THREE.Mesh;
  private readonly laserBeamMat: THREE.MeshBasicMaterial;
  private readonly laserDotMesh: THREE.Mesh;
  private readonly laserDotMat: THREE.MeshBasicMaterial;

  private currentWeaponId: WeaponId = 'unarmed';
  private currentAttachments: WeaponAttachments = {};
  private derivedStats: DerivedWeaponStats = computeDerivedWeaponStats(0, 0.25, 0, {});
  private assembly: WeaponModelAssembly | null = null;
  private opticZoomIndex = 1;
  private lastOpticId: string | null = null;
  public reticleIlluminated = true;

  // Muzzle flash (45ms HDR spike)
  private muzzleFlashLight: THREE.PointLight;
  private muzzleFlashMesh: THREE.Mesh;
  private flashTimer = 0;

  // Independent 2nd-order spring recoil (axial bore kickback, muzzle whip + persistent muzzle drift)
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

  // Rapid-fire sight misalignment springs (1:1 parity with SDK WeaponRig)
  private sightMisalignPitch = 0;
  private sightMisalignPitchVel = 0;
  private sightMisalignYaw = 0;
  private sightMisalignYawVel = 0;
  private sightMisalignRoll = 0;
  private sightMisalignRollVel = 0;
  private rapidFireHeat = 0;

  // Weapon lag inertia, wall pullback, cant & vault retention
  private lagYaw = 0;
  private lagPitch = 0;
  private pullbackRatio = 0;
  private adsBlend = 0;
  private cantBlend = 0;
  private pointAimBlend = 0;
  private sprintBlend = 0;
  private vaultRetentionMode: VaultWeaponRetentionMode = 'NONE';
  private vaultRetentionBlend = 0;
  private smoothedPointAimConvDist = 25;

  private lastAimYaw = 0;
  private lastAimPitch = 0;
  private lastIsAds = false;
  private lastIsCanted = false;
  private lastIsPointAim = false;
  private lastIsSprinting = false;
  private lastIsMoving = false;
  private lastStrideProgress = 0;
  private lastBobPhase = 0;

  private scene: THREE.Scene;
  private raycaster = new THREE.Raycaster();
  private readonly _rayHit: BodycamRaycastResult = createRaycastResult();

  // Reusable zero-GC math temporaries
  private readonly _shoulderWorld = new THREE.Vector3();
  private readonly _barrelDir = new THREE.Vector3();
  private readonly _camCenterDir = new THREE.Vector3();
  private readonly _laserOrigin = new THREE.Vector3();
  private readonly _laserDir = new THREE.Vector3();
  private readonly _laserMid = new THREE.Vector3();
  private readonly _upAxis = new THREE.Vector3(0, 1, 0);
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _cantOffsetBuf: [number, number, number] = [0, 0, 0];
  private readonly _pointAimOffsetBuf: [number, number, number] = [0.068, -0.078, -0.26];
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
    bobPhase: 0,
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
    adsBlend: 0,
    cantBlend: 0,
    pointAimBlend: 0,
    sprintBlend: 0,
    laserOn: false,
  };

  constructor(scene: THREE.Scene, isSoftwareGl: boolean, audio?: IBodycamAudioSource) {
    this.scene = scene;
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

    // Shadow-casting Flashlight attached to weapon/hand pivot
    this.flashlight = new THREE.SpotLight(0xeef6ff, 6.2, 44, THREE.MathUtils.degToRad(26), 0.44, 1.4);
    this.flashlight.position.set(0.025, -0.015, -0.14);
    this.flashlight.castShadow = !isSoftwareGl;
    this.flashlight.shadow.mapSize.width = 1024;
    this.flashlight.shadow.mapSize.height = 1024;
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 44;
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

    // Tactical PEQ-15 Rail Laser Beam & World Impact Dot
    const beamGeo = new THREE.CylinderGeometry(0.0014, 0.0014, 1, 6, 1, true);
    this.laserBeamMat = new THREE.MeshBasicMaterial({
      color: 0xff2222,
      transparent: true,
      opacity: 0.44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laserBeamMesh = new THREE.Mesh(beamGeo, this.laserBeamMat);
    this.laserBeamMesh.visible = false;
    this.laserBeamMesh.frustumCulled = false;
    this.scene.add(this.laserBeamMesh);

    const dotGeo = new THREE.SphereGeometry(0.011, 8, 8);
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
      hipOffset: WEAPONS.unarmed.hipOffset,
      cantOffset: this._cantOffsetBuf,
      lowReadyOffset: WEAPONS.unarmed.lowReadyOffset,
      lowReadyRotation: WEAPONS.unarmed.lowReadyRotation,
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

    this.buildWeaponModel('unarmed', false);
  }

  public setAudio(audio: IBodycamAudioSource): void {
    this.weaponAnimator.setAudio(audio);
  }

  public setAmmoState(ammoInMag: number, isFirearm?: boolean): void {
    const spec = WEAPONS[this.currentWeaponId];
    const firearm = isFirearm ?? this.supportsFirearmLaser(spec);
    this.weaponAnimator.setAmmoState(ammoInMag, firearm);
  }

  public triggerInspect(): boolean {
    const spec = WEAPONS[this.currentWeaponId];
    if (spec.holdClass === 'unarmed') return false;
    return this.weaponAnimator.triggerInspect();
  }

  public interruptInspect(): void {
    this.weaponAnimator.interruptInspect();
  }

  public triggerDryFire(): void {
    this.weaponAnimator.triggerDryFire();
  }

  public cancelAction(): void {
    this.weaponAnimator.cancelAction();
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

  public isMagnifiedOpticActive(): boolean {
    return Boolean(this.assembly?.scopeLensMaterial) && this.derivedStats.isMagnifiedOptic;
  }

  public hasVariableZoom(): boolean {
    return this.derivedStats.opticZoomLevels.length > 1;
  }

  public getActiveOpticZoomMult(): number {
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length > 0) {
      const idx = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex));
      return levels[idx];
    }
    return this.derivedStats.adsZoomFactor;
  }

  public cycleOpticZoom(dir: 1 | -1): number {
    const levels = this.derivedStats.opticZoomLevels;
    if (levels.length <= 1) return this.getActiveOpticZoomMult();
    const nextIdx = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex + dir));
    if (nextIdx !== this.opticZoomIndex) {
      this.opticZoomIndex = nextIdx;
      this.weaponAnimator.triggerMicroAction('ZOOM_TWIST', 0.28);
    }
    return levels[this.opticZoomIndex];
  }

  public toggleReticleIllumination(): boolean {
    this.reticleIlluminated = !this.reticleIlluminated;
    this.weaponAnimator.triggerMicroAction('ILLUM', 0.24);
    return this.reticleIlluminated;
  }

  public triggerTacticalSwitch(): void {
    this.weaponAnimator.triggerMicroAction('LIGHT_PAD', 0.19);
  }

  public isSuppressorActionActive(): boolean {
    return this.weaponAnimator.isSuppressorActionActive();
  }

  public isBlockingFiringAction(): boolean {
    return this.weaponAnimator.isBlockingFiringAction();
  }

  public triggerFieldSuppressorToggle(
    onCommit: (nowAttached: boolean) => void,
  ): 'started_detach' | 'started_attach' | 'no_suppressor' | 'busy' {
    if (!this.assembly?.suppressor || !getOwnedSuppressorDef(this.currentAttachments)) {
      return 'no_suppressor';
    }
    if (this.weaponAnimator.isSuppressorActionActive() || this.weaponAnimator.isReloading()) {
      return 'busy';
    }
    const attach = Boolean(this.currentAttachments.suppressorStowed);
    const started = this.weaponAnimator.triggerSuppressorToggle(attach, (nowAttached) => {
      this.currentAttachments = normalizeWeaponAttachments(this.currentWeaponId, {
        ...this.currentAttachments,
        suppressorStowed: nowAttached ? undefined : true,
      });
      const spec = WEAPONS[this.currentWeaponId];
      if (this.assembly) {
        this.derivedStats = WeaponAssembler.applyAttachments(
          this.assembly,
          this.getBaseMassKg(spec),
          spec.barrelLengthM,
          30,
          this.currentAttachments,
        );
        this.syncSocketsFromAssembly(this.assembly);
      }
      onCommit(nowAttached);
    });
    if (!started) return 'busy';
    return attach ? 'started_attach' : 'started_detach';
  }

  public getSuppressorMountWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly) return false;
    this.root.updateMatrixWorld(true);
    if (this.assembly.suppressorGripSocket) {
      this.assembly.suppressorGripSocket.getWorldPosition(outPos);
      return true;
    }
    if (this.assembly.suppressor) {
      this.assembly.suppressor.getWorldPosition(outPos);
      return true;
    }
    return false;
  }

  public getZoomRingWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly?.zoomRingSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.zoomRingSocket.getWorldPosition(outPos);
    return true;
  }

  public getIllumDialWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly?.illumDialSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.illumDialSocket.getWorldPosition(outPos);
    return true;
  }

  public getPressurePadWorldPosition(outPos: THREE.Vector3): boolean {
    if (!this.assembly?.pressurePadSocket) return false;
    this.root.updateMatrixWorld(true);
    this.assembly.pressurePadSocket.getWorldPosition(outPos);
    return true;
  }

  private syncOpticZoomIndex(): void {
    const opticId = this.currentAttachments.optic ?? null;
    const levels = this.derivedStats.opticZoomLevels;
    if (opticId !== this.lastOpticId) {
      this.lastOpticId = opticId;
      if (levels.length > 0) {
        this.opticZoomIndex = levels.length >= 4 ? 2 : levels.length - 1;
      } else {
        this.opticZoomIndex = 0;
      }
    } else if (levels.length > 0) {
      this.opticZoomIndex = Math.max(0, Math.min(levels.length - 1, this.opticZoomIndex));
    }
  }

  public supportsFirearmLaser(spec: WeaponSpec): boolean {
    return (
      (spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun') &&
      this.derivedStats.hasLaser
    );
  }

  public toggleLaser(): boolean {
    const spec = WEAPONS[this.currentWeaponId];
    if (!this.supportsFirearmLaser(spec)) {
      this.laserOn = false;
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
      return false;
    }
    this.laserOn = !this.laserOn;
    if (!this.laserOn) {
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
    }
    return this.laserOn;
  }

  public cycleLaserMode(): TacticalLaserMode {
    this.laserMode = this.laserMode === 'red' ? 'ir_green' : 'red';
    const isRed = this.laserMode === 'red';
    this.laserBeamMat.color.setHex(isRed ? 0xff2222 : 0x39ff75);
    this.laserBeamMat.opacity = isRed ? 0.44 : 0.36;
    this.laserDotMat.color.setHex(isRed ? 0xff3b3b : 0x6bff96);
    return this.laserMode;
  }

  private getWeightClass(spec: WeaponSpec): 'pistol' | 'carbine' | 'heavy_rifle' {
    if (
      spec.holdClass === 'pistol' ||
      spec.holdClass === 'melee_1h' ||
      spec.holdClass === 'throwable' ||
      spec.holdClass === 'unarmed'
    ) {
      return 'pistol';
    }
    if (spec.holdClass === 'shotgun' || spec.barrelLengthM >= 0.41) {
      return 'heavy_rifle';
    }
    return 'carbine';
  }

  private getBaseMassKg(spec: WeaponSpec): number {
    if (spec.holdClass === 'unarmed') return 0;
    if (spec.holdClass === 'pistol') return 0.95;
    if (spec.holdClass === 'melee_1h' || spec.holdClass === 'throwable') return 0.45;
    if (spec.holdClass === 'shotgun' || spec.id === 'akm_762') return 3.8;
    return 2.95;
  }

  private getMassHandlingFactor(spec: WeaponSpec): number {
    if (spec.holdClass === 'unarmed' || spec.holdClass === 'melee_1h' || spec.holdClass === 'throwable') {
      return 0.6;
    }
    const wc = this.getWeightClass(spec);
    if (wc === 'pistol') return 0.68;
    if (wc === 'heavy_rifle') return 1.32;
    return THREE.MathUtils.clamp(0.84 + this.derivedStats.barrelLengthM * 0.7, 0.92, 1.35);
  }

  public addInertia(dyaw: number, dpitch: number): void {
    this.lagYaw = THREE.MathUtils.clamp(this.lagYaw + dyaw, -0.09, 0.09);
    this.lagPitch = THREE.MathUtils.clamp(this.lagPitch + dpitch, -0.09, 0.09);
  }

  public applyWeaponRecoil(
    pitchRad: number,
    yawRad: number,
    kickBackM: number,
    stanceOpts?: {
      cheekWeld?: number;
      hipRecoilSwayScale?: number;
      stanceCoupled?: boolean;
      rawYawRad?: number;
      holdBreathBlend?: number;
    },
  ): void {
    const spec = WEAPONS[this.currentWeaponId];
    const massFactor = this.getMassHandlingFactor(spec);
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

    const heatMult =
      (0.50 + this.rapidFireHeat * 0.95) *
      this.derivedStats.sightMisalignMult *
      misalignStanceGain *
      misalignBreathScale;
    this.sightMisalignPitchVel += pitchRad * (8.5 + Math.random() * 3.8) * heatMult * climbBreathScale;
    this.sightMisalignYawVel += (yawRad * 10.0 + (Math.random() - 0.5) * 0.26) * heatMult * driftBreathScale;
    this.sightMisalignRollVel += ((Math.random() - 0.5) * 1.1 + yawRad * 6.5) * heatMult;
  }

  public setWeapon(weaponId: WeaponId, suppressorOrAttachments: boolean | WeaponAttachments = false): void {
    const spec = WEAPONS[weaponId];
    const nextAttachments: WeaponAttachments =
      typeof suppressorOrAttachments === 'boolean'
        ? suppressorOrAttachments && Boolean(spec.compatibleSuppressorId)
          ? { muzzle: weaponId === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545' }
          : {}
        : normalizeWeaponAttachments(weaponId, suppressorOrAttachments);

    if (this.currentWeaponId === weaponId && this.assembly) {
      this.setAttachments(nextAttachments);
      return;
    }
    this.currentWeaponId = weaponId;
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
    this.buildWeaponModel(weaponId, nextAttachments);
  }

  public setAttachments(attachments?: WeaponAttachments | null): DerivedWeaponStats {
    this.currentAttachments = normalizeWeaponAttachments(this.currentWeaponId, attachments);
    const spec = WEAPONS[this.currentWeaponId];
    const baseMass = this.getBaseMassKg(spec);
    if (!this.assembly) {
      this.derivedStats = computeDerivedWeaponStats(baseMass, spec.barrelLengthM, 30, this.currentAttachments);
      return this.derivedStats;
    }
    this.derivedStats = WeaponAssembler.applyAttachments(
      this.assembly,
      baseMass,
      spec.barrelLengthM,
      30,
      this.currentAttachments,
    );
    this.syncOpticZoomIndex();
    this.syncSocketsFromAssembly(this.assembly);
    if (!this.derivedStats.hasLaser) {
      this.laserOn = false;
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
    }
    return this.derivedStats;
  }

  public setSuppressorVisible(visible: boolean): void {
    const next: WeaponAttachments = { ...this.currentAttachments };
    const spec = WEAPONS[this.currentWeaponId];
    if (visible && spec.compatibleSuppressorId) {
      next.muzzle = this.currentWeaponId === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545';
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
    this.leftHandSocketAnchor.position.copy(asm.leftHandSocket.position);
    this.leftHandSocketAnchor.rotation.copy(asm.leftHandSocket.rotation);
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
      if (this.assembly.throwableParts?.pullRingMesh.parent) {
        this.assembly.throwableParts.pullRingMesh.parent.remove(this.assembly.throwableParts.pullRingMesh);
      }
      this.modelGroup.remove(this.assembly.group);
      this.assembly.dispose();
      this.assembly = null;
    }
    this.modelGroup.visible = true;
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.rotation.set(0, 0, 0);
  }

  public getThrowableParts() {
    return this.assembly?.throwableParts ?? null;
  }

  private buildWeaponModel(weaponId: WeaponId, attachmentsOrSuppressor: boolean | WeaponAttachments): void {
    this.clearModel();
    const spec = WEAPONS[weaponId];
    const attachments: WeaponAttachments =
      typeof attachmentsOrSuppressor === 'boolean'
        ? attachmentsOrSuppressor && Boolean(spec.compatibleSuppressorId)
          ? { muzzle: weaponId === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545' }
          : {}
        : normalizeWeaponAttachments(weaponId, attachmentsOrSuppressor);

    const asm = WeaponModelFactory.build(
      {
        id: spec.id,
        holdClass: spec.holdClass,
        barrelLengthM: spec.barrelLengthM,
        visualStyle: spec.visualStyle,
        rightHandSocket: spec.rightHandSocket,
        leftHandSocket: spec.leftHandSocket,
        muzzleOffset: spec.muzzleOffset,
        supportsSuppressor: Boolean(spec.compatibleSuppressorId),
      },
      false,
    );

    this.assembly = asm;
    this.modelGroup.add(asm.group);

    this.derivedStats = WeaponAssembler.applyAttachments(
      asm,
      this.getBaseMassKg(spec),
      spec.barrelLengthM,
      30,
      attachments,
    );
    this.syncOpticZoomIndex();
    this.syncSocketsFromAssembly(asm);
    if (!this.derivedStats.hasLaser) {
      this.laserOn = false;
      this.laserBeamMesh.visible = false;
      this.laserDotMesh.visible = false;
    }

    const isUnarmed = spec.visualStyle === 'unarmed' || spec.holdClass === 'unarmed';
    this.weaponAnimator.attachModel(isUnarmed ? null : asm, this.getWeightClass(spec), !isUnarmed);
  }

  public triggerFire(suppressed: boolean, remainingAmmoAfterShot?: number): void {
    const flashScale = suppressed ? 0.12 : this.derivedStats.muzzleFlashScale;
    this.flashTimer = suppressed ? 0.025 : 0.045;
    this.muzzleFlashLight.intensity = suppressed ? 1.8 : 14.5 * flashScale;
    this.muzzleFlashMesh.visible = !suppressed && flashScale > 0.2;
    this.muzzleFlashMesh.rotation.z = Math.random() * Math.PI;
    this.muzzleFlashMesh.scale.setScalar((0.85 + Math.random() * 0.55) * Math.max(0.65, flashScale));

    const spec = WEAPONS[this.currentWeaponId];
    if (spec.caliberId) {
      this.weaponAnimator.triggerFire(suppressed, remainingAmmoAfterShot);
    }
  }

  public triggerReload(durationSec: number): void {
    this.weaponAnimator.triggerReload(durationSec);
  }

  public triggerMagCheck(durationSec: number): void {
    this.weaponAnimator.triggerMagCheck(durationSec);
  }

  public applyCharacterActionPose(
    posOffset: THREE.Vector3,
    rotOffset: THREE.Euler,
    _magDropOffsetY = 0,
    _boltBackOffsetZ = 0,
    hideModel = false,
    hidePin = false,
    hideSpoon = false,
  ): void {
    this.modelGroup.visible = !hideModel;
    this.modelGroup.position.copy(posOffset);
    this.modelGroup.rotation.copy(rotOffset);
    if (this.assembly?.pinMesh && !this.assembly.throwableParts) {
      this.assembly.pinMesh.visible = !hidePin;
    }
    if (this.assembly?.throwableParts) {
      this.assembly.throwableParts.spoonGroup.visible = !hideSpoon;
    }
    this.modelGroup.updateMatrixWorld(true);
  }

  public getMuzzleWorldTransform(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.root.updateMatrixWorld(true);
    this.muzzleAnchor.getWorldPosition(outPos);
    this.muzzleAnchor.getWorldQuaternion(this._tmpQuat);
    outDir.set(0, 0, -1).applyQuaternion(this._tmpQuat).normalize();
  }

  public updateLaserBeam(adapter: IBodycamWorldAdapter): void {
    const spec = WEAPONS[this.currentWeaponId];
    const active =
      this.laserOn &&
      this.supportsFirearmLaser(spec) &&
      this.modelGroup.visible &&
      !this.lastIsSprinting &&
      this.vaultRetentionBlend < 0.25 &&
      !this.weaponAnimator.isReloading();

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
    s.bobPhase = this.lastBobPhase;
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
    s.adsBlend = this.adsBlend;
    s.cantBlend = this.cantBlend;
    s.pointAimBlend = this.pointAimBlend;
    s.sprintBlend = this.sprintBlend;
    s.laserOn = this.laserOn;
    return s;
  }

  private stepSpring(
    val: number,
    vel: number,
    omega: number,
    dt: number,
    dampingRatio = 1.0,
  ): [number, number] {
    const k = omega * omega;
    const d = 2.0 * dampingRatio * omega;
    const a = -k * val - d * vel;
    const nv = vel + a * dt;
    return [val + nv * dt, nv];
  }

  public updateRig(
    dt: number,
    elapsed: number,
    spec: WeaponSpec,
    aimYaw: number,
    aimPitch: number,
    isAds: boolean,
    isSprinting: boolean,
    isMoving: boolean,
    strideProgress: number,
    breathX: number,
    breathY: number,
    camWorldPos: THREE.Vector3,
    camWorldQuat: THREE.Quaternion,
    raycastMeshes: THREE.Object3D[],
    flashlightAngleDeg: number,
    adsSpeedMult = 1.0,
    isCanted = false,
    vaultRetentionMode: VaultWeaponRetentionMode = 'NONE',
    vaultRetentionBlend = 0,
    bobPhase?: number,
    verticalMotionOffset = 0,
    adapter?: IBodycamWorldAdapter,
    weaponRootPitchRad = 0,
    minWeaponPitchRad = THREE.MathUtils.degToRad(-50),
    maxWeaponPitchRad = THREE.MathUtils.degToRad(68),
    lateralMotion = 0,
    opticParallaxStrength = 1.0,
    isPointAim = false,
    holdBreathBlend = 0,
  ): void {
    const isFirearm = this.supportsFirearmLaser(spec);
    const hasCanted = this.hasCantedOptic();
    this.lastAimYaw = aimYaw;
    this.lastAimPitch = aimPitch;
    this.lastIsAds = isAds;
    this.lastIsCanted = isCanted && hasCanted && isFirearm && !isSprinting;
    this.lastIsPointAim = isPointAim && isFirearm && !isSprinting;
    this.lastIsSprinting = isSprinting;
    this.lastIsMoving = isMoving;
    this.lastStrideProgress = strideProgress;
    this.lastBobPhase = bobPhase !== undefined ? bobPhase : strideProgress * Math.PI;
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

    this.flashlight.angle = THREE.MathUtils.degToRad(flashlightAngleDeg);

    // 1. Decay independent 2nd-order recoil whip + biomechanically damped persistent muzzle drift springs
    const massFactor = this.getMassHandlingFactor(spec);
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

    [this.recoilZ, this.recoilZVel] = this.stepSpring(this.recoilZ, this.recoilZVel, recOmegaZ, dt);
    [this.recoilPitch, this.recoilPitchVel] = this.stepSpring(
      this.recoilPitch,
      this.recoilPitchVel,
      recOmegaPitch,
      dt,
    );
    [this.recoilYaw, this.recoilYawVel] = this.stepSpring(
      this.recoilYaw,
      this.recoilYawVel,
      recOmegaYaw,
      dt,
      horizDampYaw,
    );
    if (this.recoilYaw > 0.065) {
      this.recoilYaw = 0.065;
      if (this.recoilYawVel > 0) this.recoilYawVel = 0;
    } else if (this.recoilYaw < -0.065) {
      this.recoilYaw = -0.065;
      if (this.recoilYawVel < 0) this.recoilYawVel = 0;
    }
    [this.recoilRoll, this.recoilRollVel] = this.stepSpring(
      this.recoilRoll,
      this.recoilRollVel,
      recOmegaRoll,
      dt,
    );

    [this.muzzleDriftYaw, this.muzzleDriftYawVel] = this.stepSpring(
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

    [this.muzzleDriftPitch, this.muzzleDriftPitchVel] = this.stepSpring(
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

    this.rapidFireHeat = Math.max(0, this.rapidFireHeat - dt * 1.45);
    const misOmega = THREE.MathUtils.clamp(14.5 / Math.sqrt(massFactor), 10.5, 18.0);
    [this.sightMisalignPitch, this.sightMisalignPitchVel] = this.stepSpring(
      this.sightMisalignPitch,
      this.sightMisalignPitchVel,
      misOmega,
      dt,
      0.78,
    );
    [this.sightMisalignYaw, this.sightMisalignYawVel] = this.stepSpring(
      this.sightMisalignYaw,
      this.sightMisalignYawVel,
      misOmega * 0.92,
      dt,
      0.75,
    );
    [this.sightMisalignRoll, this.sightMisalignRollVel] = this.stepSpring(
      this.sightMisalignRoll,
      this.sightMisalignRollVel,
      misOmega * 0.85,
      dt,
      0.80,
    );

    this.lagYaw = THREE.MathUtils.damp(this.lagYaw, 0, 12, dt);
    this.lagPitch = THREE.MathUtils.damp(this.lagPitch, 0, 12, dt);

    // 2. Muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.muzzleFlashLight.intensity = 0;
        this.muzzleFlashMesh.visible = false;
      }
    }

    // 3. Physical Wall Pullback Raycast from Right Shoulder along barrel vector
    this.root.updateMatrixWorld(true);
    this.shoulderAnchor.getWorldPosition(this._shoulderWorld);
    this._barrelDir
      .set(0, 0, -1)
      .applyEuler(this._tmpEuler.set(aimPitch, aimYaw, 0, 'YXZ'))
      .applyQuaternion(this.root.quaternion)
      .normalize();

    const effectiveBarrelLenM =
      this.derivedStats.barrelLengthM > 0 ? this.derivedStats.barrelLengthM : spec.barrelLengthM;
    const triggerDist = Math.min(1.16, effectiveBarrelLenM + 0.24);
    let wallDist = 999;
    let hitPointY = 0;
    let hitNormalY = 0;
    let hitFound = false;

    if (adapter) {
      hitFound = adapter.raycast(this._shoulderWorld, this._barrelDir, 0.08, triggerDist + 0.05, this._rayHit);
      if (hitFound) {
        wallDist = this._rayHit.distance;
        hitPointY = this._rayHit.pointY;
        hitNormalY = this._rayHit.normalY;
      }
    } else {
      this.raycaster.set(this._shoulderWorld, this._barrelDir);
      this.raycaster.near = 0.08;
      this.raycaster.far = triggerDist + 0.05;
      const hits = this.raycaster.intersectObjects(raycastMeshes, false);
      if (hits.length > 0) {
        hitFound = true;
        wallDist = hits[0].distance;
        hitPointY = hits[0].point.y;
        hitNormalY = hits[0].face ? hits[0].face.normal.y : 0;
      }
    }

    let targetPullback =
      wallDist < triggerDist
        ? THREE.MathUtils.clamp((triggerDist - wallDist) / 0.36, 0, 1)
        : 0;

    if (hitFound && targetPullback > 0) {
      const hitBelowShoulder = this._shoulderWorld.y - hitPointY;
      if (hitNormalY > 0.65 && this._barrelDir.y < -0.20) {
        const floorFade = THREE.MathUtils.clamp((0.82 - hitNormalY) / 0.17, 0, 1);
        targetPullback *= floorFade;
      } else if (this._barrelDir.y < -0.25 && hitBelowShoulder > 0.28) {
        const downFade = THREE.MathUtils.clamp((-0.25 - this._barrelDir.y) / 0.23, 0, 1);
        targetPullback *= 1 - downFade;
      }
    }
    if (this.vaultRetentionBlend > 0.05) {
      targetPullback *= 1 - this.vaultRetentionBlend;
    }
    this.pullbackRatio = THREE.MathUtils.damp(this.pullbackRatio, targetPullback, 16, dt);

    // 4. Evaluate Pose Graph + exact sightAnchor ADS + Bore-Anchored Point Aim convergence + mechanical gun animation
    const [adsX, adsY, adsZ] = spec.adsOffset;
    this._cantOffsetBuf[0] = adsX + 0.042;
    this._cantOffsetBuf[1] = adsY - 0.022;
    this._cantOffsetBuf[2] = adsZ - 0.025;
    const isPistol = spec.holdClass === 'pistol';
    const pointAimRollRad = THREE.MathUtils.degToRad(isPistol ? 32 : 40);
    const boreY = this.muzzleAnchor.position.y;
    const muzzleLocalZ = this.muzzleAnchor.position.z;
    const eyeRelief = this.assembly ? this.assembly.adsEyeReliefM : 0.23;

    // Anchor Point Aim directly to the firearm's bore axis so rifles frame dead-center with full handguard
    // & laser visible (Image 1) and pistols adopt a tight centered Center Axis Relock (CAR) stance.
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

    // Smoothed led-aim-ray convergence raycast (clamped 8m–40m, defaulting to 25m on open sky)
    let convPitchRad = 0;
    let convYawRad = 0;
    if (isFirearm && (this.lastIsPointAim || this.pointAimBlend > 0.01)) {
      this._camCenterDir
        .set(0, 0, -1)
        .applyEuler(this._tmpEuler.set(aimPitch, aimYaw, 0, 'YXZ'))
        .applyQuaternion(camWorldQuat)
        .normalize();
      let rawDist = 25;
      if (adapter) {
        if (adapter.raycast(camWorldPos, this._camCenterDir, 0.5, 42, this._rayHit)) {
          rawDist = THREE.MathUtils.clamp(this._rayHit.distance, 8, 40);
        }
      } else {
        this.raycaster.set(camWorldPos, this._camCenterDir);
        this.raycaster.near = 0.5;
        this.raycaster.far = 42;
        const cHits = this.raycaster.intersectObjects(raycastMeshes, false);
        if (cHits.length > 0) {
          rawDist = THREE.MathUtils.clamp(cHits[0].distance, 8, 40);
        }
      }
      this.smoothedPointAimConvDist = THREE.MathUtils.damp(this.smoothedPointAimConvDist, rawDist, 10, dt);

      const forwardSpan = Math.max(4.0, this.smoothedPointAimConvDist + ptZ + muzzleLocalZ);
      convYawRad = THREE.MathUtils.clamp(Math.atan2(boreTargetX, forwardSpan), -0.06, 0.06);
      convPitchRad = THREE.MathUtils.clamp(Math.atan2(-boreTargetY, forwardSpan), -0.06, 0.06);
    }

    const phase = bobPhase !== undefined ? bobPhase : strideProgress * Math.PI;

    const pIn = this._poseInput;
    pIn.dt = dt;
    pIn.elapsed = elapsed;
    pIn.isFirearm = spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun';
    pIn.isUnarmed = spec.holdClass === 'unarmed';
    pIn.massHandlingFactor = massFactor;
    pIn.weightClass = this.getWeightClass(spec);
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
    pIn.cantOffset = this._cantOffsetBuf;
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
    pIn.camWorldPos = camWorldPos;
    pIn.camWorldQuat = camWorldQuat;
    pIn.weaponRootPitchRad = weaponRootPitchRad;
    pIn.minWeaponPitchRad = minWeaponPitchRad;
    pIn.maxWeaponPitchRad = maxWeaponPitchRad;
    pIn.lateralMotion = lateralMotion;
    pIn.opticParallaxStrength = opticParallaxStrength;

    this.weaponAnimator.updatePoseGraph(pIn);
    this.adsBlend = this.weaponAnimator.adsBlend;
    this.cantBlend = this.weaponAnimator.cantBlend;
    this.pointAimBlend = this.weaponAnimator.pointAimBlend;
    this.sprintBlend = this.weaponAnimator.sprintBlend;

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

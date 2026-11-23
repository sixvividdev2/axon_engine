import * as THREE from 'three';
import { createEmptyPinProjections, GunsmithPinProjection } from '../arena/GunsmithBench';
import {
  AdsMode,
  BodycamAudio,
  BodycamController,
  BodycamFireMode,
  BodycamInputState,
  BodycamLensPresetId,
  BodycamMeleeHitEvent,
  BodycamPostProcess,
  BodycamSDKConfig,
  BodycamTelemetry,
  BodycamTraumaModifiers,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  computeTargetHingeAngularImpulse,
  createBodycamTelemetry,
  createPdaMotionState,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  GrenadeDetonationEvent,
  GrenadeHoldStage,
  GrenadeThrowStyle,
  IBodycamWorldAdapter,
  IR_LAYER,
  LENS_PRESETS,
  NvgMountId,
  operatorAssetLoader,
  OperatorGearConfig,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  SDK_WEAPON_LIST,
  SDK_WEAPON_PROFILES,
  solveZeroPitchRad,
  TacticalGrenadeSystem,
  tacticalEquipmentStore,
  TacticalPdaDevice,
  WeaponRig,
} from '../bodycam-sdk';
import {
  getTacticalEquipmentDef,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import {
  AttachmentSlot,
  computeDerivedWeaponStats,
  createBareAttachments,
  DerivedWeaponStats,
  getCompatibleAttachments,
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
  ReticleColorId,
  WeaponAttachments,
} from '../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  BaseCaliberId,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../data/calibers';
import { SaveManager } from '../engine/persistence/SaveManager';
import { GymBallisticHitInfo, GymBallistics } from './GymBallistics';
import { buildGymWorld, GYM_ZONE_PRESETS, GymWorldHandle, GymZoneId } from './GymWorld';

export interface GymSnapshot {
  config: BodycamSDKConfig;
  telemetry: BodycamTelemetry;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  activeCaliberId: BaseCaliberId;
  activeAmmoVariantId: AmmoVariantId;
  ammoVariantLabel: string;
  isSubsonic: boolean;
  isBoltCycling: boolean;
  fireMode: BodycamFireMode;
  toggleablePumpSemi: boolean;
  spas12Mode: 'semi' | 'pump';
  ammoInMag: number;
  magCapacity: number;
  isReloading: boolean;
  laserOn: boolean;
  laserMode: 'visible_red' | 'ir_green';
  flashlightOn: boolean;
  suppressorAttached: boolean;
  simulatedArmTrauma: boolean;
  pointerLocked: boolean;
  tunerOpen: boolean;
  gunsmithOpen: boolean;
  lookingAtBench: boolean;
  attachments: WeaponAttachments;
  derivedStats: DerivedWeaponStats;
  gunsmithPins: GunsmithPinProjection[];
  fps: number;
  lastHit: GymBallisticHitInfo | null;
  toastMessage: string | null;
  recordingElapsedSec: number;
  heartRateBpm: number;
  heartStress: number;
  holdBreathActive: boolean;
  isMagnifiedOptic: boolean;
  hasVariableZoom: boolean;
  activeOpticZoom: number;
  reticleIlluminated: boolean;
  armedAdsMode: AdsMode;
  hasCantedOptic: boolean;
  tacticalEquipmentId: TacticalEquipmentId;
  tacticalEquipmentName: string;
  tacticalEquipmentShortName: string;
  tacticalBeltSlot: TacticalBeltSlot;
  tacticalMountOnBelt: boolean;
  grenadeCount: number;
  grenadeMax: number;
  grenadeHoldStage: GrenadeHoldStage;
  grenadeCooking: boolean;
  grenadeStatusLabel: string;
  grenadeThrowStyle: GrenadeThrowStyle;
  grenadeThrowHeld: boolean;
  flashBlindAlpha: number;
  zeroDistanceM: number;
  zeroElevationMrad: number;
  heightOverBoreM: number;
  isPdaOpen: boolean;
  nvgMount: NvgMountId;
  nvgActive: boolean;
  irIlluminatorOn: boolean;
}

type Listener = (snap: GymSnapshot) => void;

const WEAPON_HOTKEYS: Record<string, string> = {
  Digit1: 'pm_9x19',
  Digit2: 'aks74u_545',
  Digit3: 'm4_556',
  Digit4: 'akm_762',
  Digit0: 'unarmed',
};

/**
 * Self-contained Bodycam Calibration Gym runner.
 * Consumes ONLY the portable `src/bodycam-sdk/` package through `IBodycamWorldAdapter`.
 */
export class GymEngine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly world: GymWorldHandle;
  private readonly adapter: IBodycamWorldAdapter;
  private readonly audio: BodycamAudio;
  private readonly weaponRig: WeaponRig;
  private readonly skeleton: CharacterSkeleton;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly postProcess: BodycamPostProcess;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly ballistics: GymBallistics;
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private readonly pdaDevice: TacticalPdaDevice;
  private readonly _pdaMotionScratch = createPdaMotionState();
  private readonly irIlluminatorLight: THREE.SpotLight;
  private readonly irIlluminatorTarget = new THREE.Object3D();
  private readonly unsubTacticalEquipment: () => void;
  private readonly unsubOperatorGear: () => void;
  private localGear: OperatorGearConfig;
  private nvgFlipped = false;
  private irIlluminatorOn = false;

  private config: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly telemetry: BodycamTelemetry = createBodycamTelemetry();
  private readonly input: BodycamInputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    leanLeft: false,
    leanRight: false,
    ads: false,
    cant: false,
    adsMode: 'PRIMARY',
    holdBreath: false,
    vault: false,
  };

  private readonly saveManager = new SaveManager();
  private equippedWeaponId = 'm4_556';
  private lastFirearmId = 'm4_556';
  private magAmmoByWeapon: Record<string, number> = {};
  private attachmentsByWeapon: Record<string, WeaponAttachments> = {};
  private selectedAmmoVariantByWeapon: Record<string, AmmoVariantId> = {};
  private adsModeByWeapon: Record<string, AdsMode> = {};
  private spas12Mode: 'semi' | 'pump' = 'semi';
  private flashlightOn = false;
  private simulatedArmTrauma = false;
  private lookingAtBench = false;
  private tacticalEquipmentId: TacticalEquipmentId = tacticalEquipmentStore.getSelection().equipmentId;
  private tacticalBeltSlot: TacticalBeltSlot = tacticalEquipmentStore.getSelection().beltSlot;
  private tacticalMountOnBelt: boolean = tacticalEquipmentStore.getSelection().mountOnBelt;
  private grenadeCount = 4;
  private readonly grenadeMax = 4;
  private flashBlindAlpha = 0;
  private readonly _throwDir = new THREE.Vector3();
  private readonly _throwOrigin = new THREE.Vector3();
  private readonly _playerVelScratch = new THREE.Vector3();

  private isFiring = false;
  private shiftHeld = false;
  private altHeld = false;
  private fireCooldown = 0;
  private semiTriggerConsumed = false;
  private reloadTimer = 0;
  private stamina = 1.0;
  private heartRateBpm = 84;
  private heartStress = 0;
  private adrenalineStress = 0;
  private rsaPhase = 0;
  private stillDurationSec = 0;
  private wasVaulting = false;

  private pointerLocked = false;
  private tunerOpen = false;
  private disposed = false;
  private contextLost = false;
  private rafId = 0;
  private swTimerId: number | null = null;

  private lastTimeMs = performance.now();
  private elapsedSec = 0;
  private recordingElapsedSec = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fps = 60;
  private uiEmitTimer = 0;

  private lastHit: GymBallisticHitInfo | null = null;
  private toastMessage: string | null = null;
  private toastTimer = 0;

  private listeners = new Set<Listener>();

  // Pre-allocated scratch buffers (zero GC per frame)
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _whipVel = new THREE.Vector2();
  private readonly _traumaMods: BodycamTraumaModifiers = { ...DEFAULT_TRAUMA_MODIFIERS };
  private readonly _benchRaycaster = new THREE.Raycaster();
  private readonly _lookDir = new THREE.Vector3();
  private readonly _fpsCamPos = new THREE.Vector3();
  private readonly _fpsCamQuat = new THREE.Quaternion();
  private readonly _pinBuffer: GunsmithPinProjection[] = createEmptyPinProjections();
  private readonly _runtimeConfig: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly _runtimeProfile: BodycamWeaponProfile = {
    ...SDK_WEAPON_PROFILES.m4_556,
    hipOffset: [...SDK_WEAPON_PROFILES.m4_556.hipOffset],
    adsOffset: [...SDK_WEAPON_PROFILES.m4_556.adsOffset],
    cantOffset: [...SDK_WEAPON_PROFILES.m4_556.cantOffset],
    lowReadyOffset: [...SDK_WEAPON_PROFILES.m4_556.lowReadyOffset],
    lowReadyRotation: [...SDK_WEAPON_PROFILES.m4_556.lowReadyRotation],
    rightHandSocket: {
      position: [...SDK_WEAPON_PROFILES.m4_556.rightHandSocket.position],
      rotation: [...SDK_WEAPON_PROFILES.m4_556.rightHandSocket.rotation],
      gripCurl: SDK_WEAPON_PROFILES.m4_556.rightHandSocket.gripCurl,
    },
    leftHandSocket: SDK_WEAPON_PROFILES.m4_556.leftHandSocket
      ? {
          position: [...SDK_WEAPON_PROFILES.m4_556.leftHandSocket.position],
          rotation: [...SDK_WEAPON_PROFILES.m4_556.leftHandSocket.rotation],
          gripCurl: SDK_WEAPON_PROFILES.m4_556.leftHandSocket.gripCurl,
        }
      : undefined,
    muzzleOffset: [...SDK_WEAPON_PROFILES.m4_556.muzzleOffset],
    laserOffset: SDK_WEAPON_PROFILES.m4_556.laserOffset
      ? [...SDK_WEAPON_PROFILES.m4_556.laserOffset]
      : undefined,
  };
  private readonly _scopePassParams: ScopePassParams;

  constructor(container: HTMLElement) {
    this.container = container;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });

    // Software WebGL detection (SwiftShader / llvmpipe)
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.isSoftwareGl = /swiftshader|llvmpipe|software/i.test(glRenderer);

    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // Handled in BodycamPostProcess
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.05, 160);
    this.scene.add(this.camera);

    // Build calibration gym world & portable adapter
    this.world = buildGymWorld(this.scene, this.renderer, this.isSoftwareGl);
    this.adapter = this.world.physics.createAdapter({
      getTraumaModifiers: () => this.getActiveTraumaModifiers(),
      shatterBreakable: (obj, pt, dir) => this.world.shatterBreakable(obj, pt, dir),
      onMeleeHit: (ev) => this.handleMeleeHit(ev),
    });

    // Instantiate portable Bodycam SDK modules
    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );

    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.localGear = operatorSelectionStore.getGearConfig();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      operatorSelectionStore.getSelectedOperator(),
      {
        maxAnisotropy,
        uniformId: this.localGear.uniformId,
        gear: this.localGear,
        previewMode: false,
        validationMode: 'SAFE_FALLBACK',
      },
    );
    this.skeleton = loadedOp.skeleton;
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.scene.add(this.skeleton.root);

    // Helmet-mounted IR illuminator floodlight strictly on IR_LAYER = 2 (invisible to naked eye)
    this.irIlluminatorLight = new THREE.SpotLight(
      0xdceeff,
      7.5,
      44,
      THREE.MathUtils.degToRad(36),
      0.56,
      1.35,
    );
    this.irIlluminatorLight.position.set(0.03, 0.06, -0.08);
    this.irIlluminatorLight.visible = false;
    this.irIlluminatorLight.layers.set(IR_LAYER);
    this.irIlluminatorTarget.position.set(0, 0.0, -12);
    this.camera.add(this.irIlluminatorLight);
    this.camera.add(this.irIlluminatorTarget);
    this.irIlluminatorLight.target = this.irIlluminatorTarget;

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);
    this.pdaDevice = new TacticalPdaDevice(this.audio);
    this.camera.add(this.pdaDevice.root);
    this.animator.setPdaDevice(this.pdaDevice);
    this.postProcess = new BodycamPostProcess(
      this.renderer,
      this.scene,
      this.camera,
      this.isSoftwareGl,
    );
    this.scopeRenderer = new ScopeRenderer(this.isSoftwareGl, 640);
    this._scopePassParams = {
      renderer: this.renderer,
      scene: this.scene,
      mainCamera: this.camera,
      assembly: null,
      isMagnifiedOptic: false,
      zoomMult: 1,
      adsBlend: 0,
      cantBlend: 0,
      reticleIlluminated: true,
      flashlightOn: false,
      sightMisalignYaw: 0,
      sightMisalignPitch: 0,
      dt: 0.016,
      elapsed: 0,
      mainAvgLuminance: 0.22,
    };
    this.postProcess.setBeforeMainRenderCallback(() => {
      if (
        this.contextLost ||
        !this.weaponRig.root.visible ||
        this.world.gunsmithBench.isActiveOrTransitioning()
      ) {
        return;
      }
      const rigState = this.weaponRig.getReadOnlyRigState();
      const sp = this._scopePassParams;
      sp.assembly = this.weaponRig.getModelAssembly();
      sp.isMagnifiedOptic = this.weaponRig.isMagnifiedOpticActive();
      sp.zoomMult = this.weaponRig.getActiveOpticZoomMult();
      sp.adsBlend = rigState.adsBlend;
      sp.cantBlend = rigState.cantBlend;
      sp.opticParallaxStrength = this.config.opticParallaxStrength ?? 1.0;
      sp.reticleIlluminated = this.weaponRig.reticleIlluminated;
      sp.flashlightOn = this.flashlightOn && this.weaponRig.getDerivedStats().hasFlashlight;
      sp.sightMisalignYaw = rigState.sightMisalignYaw;
      sp.sightMisalignPitch = rigState.sightMisalignPitch;
      sp.elapsed = this.elapsedSec;
      sp.mainAvgLuminance = this.postProcess.getAverageLuminance();
      this.scopeRenderer.renderScopePass(sp);
    });
    this.ballistics = new GymBallistics(
      this.scene,
      this.audio,
      this.world.steelTargets,
      this.world.paperTargets,
    );

    this.grenadeSystem = new TacticalGrenadeSystem({
      scene: this.scene,
      physics: this.adapter,
      worldRaycastMeshes: this.world.raycastMeshes,
      worldBounds: {
        minX: this.world.physics.boundsMinX,
        maxX: this.world.physics.boundsMaxX,
        minZ: this.world.physics.boundsMinZ,
        maxZ: this.world.physics.boundsMaxZ,
      },
      audio: this.audio,
      onShatterGlass: (obj, pt, dir) => {
        if (this.world.shatterBreakable(obj, pt, dir)) {
          this.audio.playGlassShatter(pt, 0.9);
        }
      },
      onDetonate: (ev) => {
        this.handleGrenadeDetonation(ev);
      },
      onInHandDetonate: (ev) => {
        this.handleGrenadeDetonation(ev, true);
      },
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);

    this.syncBeltEquipmentMesh();
    this.unsubTacticalEquipment = tacticalEquipmentStore.subscribe((sel) => {
      this.tacticalEquipmentId = sel.equipmentId;
      this.tacticalBeltSlot = sel.beltSlot;
      this.tacticalMountOnBelt = sel.mountOnBelt;
      this.syncBeltEquipmentMesh();
      this.emitSnapshot();
    });
    this.unsubOperatorGear = operatorSelectionStore.subscribeGear((nextGear) => {
      this.localGear = nextGear;
      this.skeleton.applyUniform(nextGear.uniformId);
      this.skeleton.applyGearConfig(nextGear);
      this.skeleton.setFirstPersonHeadShadowOnly(true);
      this.skeleton.enableArmViewmodelLayer();
      if (nextGear.nvgMount === 'none' && this.nvgFlipped) {
        this.nvgFlipped = false;
        this.irIlluminatorOn = false;
      }
      this.syncNvgRuntime();
      this.emitSnapshot();
    });

    // Initialize bare weapon attachments (or restore saved Gunsmith loadout) & magazine counts
    const savedLoadout = this.saveManager.loadGymLoadout();
    for (const w of SDK_WEAPON_LIST) {
      const att = savedLoadout?.[w.id]
        ? normalizeWeaponAttachments(w.id, savedLoadout[w.id])
        : createBareAttachments();
      this.attachmentsByWeapon[w.id] = att;
      if (att.selectedAmmoId && AMMO_VARIANTS[att.selectedAmmoId as AmmoVariantId]) {
        this.selectedAmmoVariantByWeapon[w.id] = att.selectedAmmoId as AmmoVariantId;
      }
      const derived = computeDerivedWeaponStats(w.massKg, w.barrelLengthM, w.magCapacity, att);
      this.magAmmoByWeapon[w.id] = derived.magCapacity;
    }

    // Spawn at central courtyard with bare M4A1 (iron sights only until Gunsmith mounted)
    this.switchWeapon('m4_556', true);
    this.weaponRig.laserOn = false;
    this.weaponRig.setLaserMode('visible_red');
    this.teleportToZone('spawn', true);
    this.pdaDevice.captureOrthographicMap({
      renderer: this.renderer,
      scene: this.scene,
      bounds: {
        minX: this.world.physics.boundsMinX,
        maxX: this.world.physics.boundsMaxX,
        minZ: this.world.physics.boundsMinZ,
        maxZ: this.world.physics.boundsMaxZ,
      },
      excludeObjects: [this.skeleton.root, this.weaponRig.root, this.pdaDevice.root],
    });

    // Pre-compile scene shaders once at boot (hardware GL) to avoid mid-session GLSL compile hitches
    if (!this.isSoftwareGl) {
      try {
        this.renderer.compile(this.scene, this.camera);
      } catch {
        // Non-fatal fallback
      }
    }

    this.bindEvents();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  private getActiveTraumaModifiers(): Readonly<BodycamTraumaModifiers> {
    if (!this.simulatedArmTrauma) {
      return DEFAULT_TRAUMA_MODIFIERS;
    }
    this._traumaMods.moveSpeedMult = 1.0;
    this._traumaMods.moveAccelMult = 1.0;
    this._traumaMods.canSprint = true;
    this._traumaMods.limpCadenceScale = 1.0;
    this._traumaMods.leftLegImpairment = 0;
    this._traumaMods.rightLegImpairment = 0;
    this._traumaMods.swayAmpMult = 1.35;
    this._traumaMods.tremorAmp = 0.0034;
    this._traumaMods.adsSpeedMult = 0.85;
    this._traumaMods.reloadSpeedMult = 0.9;
    this._traumaMods.arterialVignette = 0.14;
    this._traumaMods.desaturation = 0.1;
    this._traumaMods.concussionBlur = 0;
    this._traumaMods.chromaticSpike = 0;
    this._traumaMods.anyLightBleed = false;
    this._traumaMods.anyHeavyBleed = false;
    return this._traumaMods;
  }

  public getActiveBaseCaliberId(weaponId = this.equippedWeaponId): BaseCaliberId {
    const base = SDK_WEAPON_PROFILES[weaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    const att = this.getAttachmentsFor(base.id);
    const derived =
      weaponId === this.equippedWeaponId
        ? this.weaponRig.getDerivedStats()
        : computeDerivedWeaponStats(base.massKg, base.barrelLengthM, base.magCapacity, att);
    if (derived.caliberOverride) {
      return resolveBaseCaliberId(derived.caliberOverride);
    }
    return resolveBaseCaliberId(base.defaultCaliberId);
  }

  public getActiveAmmoVariant(weaponId = this.equippedWeaponId): AmmoVariantDef {
    const calId = this.getActiveBaseCaliberId(weaponId);
    const chosenId = this.selectedAmmoVariantByWeapon[weaponId];
    if (chosenId && AMMO_VARIANTS[chosenId]?.caliberId === calId) {
      return AMMO_VARIANTS[chosenId];
    }
    return getDefaultAmmoVariant(calId);
  }

  public selectAmmoVariant(variantId: AmmoVariantId): void {
    const prof = SDK_WEAPON_PROFILES[this.equippedWeaponId];
    if (!prof || prof.holdClass === 'unarmed') return;
    const calId = this.getActiveBaseCaliberId(prof.id);
    const variant = AMMO_VARIANTS[variantId];
    if (!variant || variant.caliberId !== calId) return;
    this.selectedAmmoVariantByWeapon[prof.id] = variantId;
    const curAtt = this.getAttachmentsFor(prof.id);
    this.attachmentsByWeapon[prof.id] = normalizeWeaponAttachments(prof.id, {
      ...curAtt,
      selectedAmmoId: variantId,
    });
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);
    this.syncRuntimeProfile();
    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position, intensity: 0.75 });
    this.showToast(
      `Ammo Loaded: ${variant.label} (${Math.round(this._runtimeProfile.muzzleVelocityMps)} m/s)`,
    );
    this.emitSnapshot();
  }

  public selectZeroDistance(distanceM: number): void {
    const prof = SDK_WEAPON_PROFILES[this.equippedWeaponId];
    if (!prof || prof.holdClass === 'unarmed') return;
    const clampedDist = Math.max(25, Math.min(800, Math.round(distanceM)));
    const curAtt = this.getAttachmentsFor(prof.id);
    this.attachmentsByWeapon[prof.id] = normalizeWeaponAttachments(prof.id, {
      ...curAtt,
      zeroDistanceM: clampedDist,
    });
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);
    this.syncRuntimeProfile();
    this.emitSnapshot();
  }

  public adjustZeroElevationMrad(elevationMrad: number): void {
    const prof = SDK_WEAPON_PROFILES[this.equippedWeaponId];
    if (!prof || prof.holdClass === 'unarmed') return;
    const clampedMrad = Math.round(THREE.MathUtils.clamp(elevationMrad, -10, 20) * 10) / 10;
    const curAtt = this.getAttachmentsFor(prof.id);
    this.attachmentsByWeapon[prof.id] = normalizeWeaponAttachments(prof.id, {
      ...curAtt,
      zeroElevationMrad: clampedMrad,
    });
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);
    this.syncRuntimeProfile();
    if (!this.world.gunsmithBench.isOpen()) {
      this.weaponRig.triggerTurretClick();
    }
    this.emitSnapshot();
  }

  public playGunsmithTurretClick(up: boolean): void {
    this.audio.ensureInitialized();
    this.audio.playTurretClick(up);
  }

  public playGunsmithTestFireSound(): void {
    this.audio.ensureInitialized();
    const prof = this.getWeaponProfile();
    if (prof.holdClass === 'unarmed') return;
    const derived = this.weaponRig.getDerivedStats();
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
    const audioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this.audio.playWeaponCue('fire', {
      position: this.camera.position,
      weightClass: audioWeight,
      caliberId: activeAmmo.caliberId,
      suppressed: derived.isSuppressed,
      isSubsonic: activeAmmo.isSubsonic,
      muzzleComp: derived.hasCompensator,
    });
  }

  public toggleFireMode(): void {
    const prof = SDK_WEAPON_PROFILES[this.equippedWeaponId];
    if (!prof || !prof.toggleablePumpSemi) return;
    this.spas12Mode = this.spas12Mode === 'semi' ? 'pump' : 'semi';
    this.syncRuntimeProfile();
    this.weaponRig.emitModeToggleCue();
    this.showToast(
      `SPAS-12 Mode: ${this.spas12Mode === 'semi' ? 'SEMI-AUTO (Gas)' : 'PUMP ACTION'}`,
    );
    this.emitSnapshot();
  }

  private syncRuntimeProfile(): void {
    const base = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    const derived = this.weaponRig.getDerivedStats();
    const ammo = this.getActiveAmmoVariant(base.id);
    const calId = this.getActiveBaseCaliberId(base.id);

    Object.assign(this._runtimeProfile, base);
    this._runtimeProfile.magCapacity = derived.magCapacity;
    this._runtimeProfile.reloadDurationSec = base.reloadDurationSec * derived.reloadDurationMult;
    this._runtimeProfile.recoilPitchRad = base.recoilPitchRad * derived.recoilPitchMult;
    this._runtimeProfile.recoilYawRad = base.recoilYawRad * derived.recoilYawMult;

    if (base.toggleablePumpSemi) {
      this._runtimeProfile.fireMode = this.spas12Mode;
      this._runtimeProfile.rpm = this.spas12Mode === 'semi' ? 240 : 85;
    }

    if (base.holdClass !== 'unarmed') {
      this._runtimeProfile.caliberLabel = `${ammo.shortName} · ${calId.toUpperCase()}`;
      this._runtimeProfile.muzzleVelocityMps =
        ammo.baseVelocityMs * (base.barrelVelocityMult ?? 1.0) * derived.velocityMult;
      this._runtimeProfile.ballisticCoefficient = ammo.ballisticCoefficient;
      this._runtimeProfile.bulletMassGrams = ammo.bulletMassGrams;
      this._runtimeProfile.spreadMOA = Math.hypot(base.spreadMOA, ammo.spreadMOA);

      const att = this.getAttachmentsFor(base.id);
      const zeroDistanceM = att.zeroDistanceM ?? getDefaultZeroDistanceM(base.category);
      const zeroElevationMrad = att.zeroElevationMrad ?? 0;
      const hob = this.weaponRig.getHeightOverBoreM();
      const zeroPitchRad = solveZeroPitchRad({
        muzzleVelocityMs: this._runtimeProfile.muzzleVelocityMps,
        bc: this._runtimeProfile.ballisticCoefficient,
        heightOverBoreM: hob,
        zeroDistanceM,
        extraElevationMrad: zeroElevationMrad,
      });
      this.weaponRig.setZeroConfig(zeroDistanceM, zeroElevationMrad, zeroPitchRad);
      if (this.world.gunsmithBench.isOpen()) {
        this.world.gunsmithBench.setShowcaseTurretElevation(zeroElevationMrad);
      }
    } else {
      this.weaponRig.setZeroConfig(100, 0, 0);
    }
  }

  public getWeaponProfile(): BodycamWeaponProfile {
    return this._runtimeProfile;
  }

  private getAttachmentsFor(weaponId: string): WeaponAttachments {
    return this.attachmentsByWeapon[weaponId] ?? createBareAttachments();
  }

  private getArmedAdsMode(weaponId = this.equippedWeaponId): AdsMode {
    const prof = SDK_WEAPON_PROFILES[weaponId];
    if (!prof || prof.holdClass === 'unarmed') {
      return 'PRIMARY';
    }
    const stored = this.adsModeByWeapon[weaponId] ?? 'PRIMARY';
    if (stored === 'CANTED' && weaponId === this.equippedWeaponId && !this.weaponRig.hasCantedOptic()) {
      this.adsModeByWeapon[weaponId] = 'PRIMARY';
      return 'PRIMARY';
    }
    return stored;
  }

  private setArmedAdsMode(weaponId: string, mode: AdsMode): void {
    this.adsModeByWeapon[weaponId] = mode;
    if (weaponId === this.equippedWeaponId) {
      this.input.adsMode = mode;
    }
  }

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.buildSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  public requestLock(): void {
    this.audio.ensureInitialized();
    this.tunerOpen = false;
    if (this.world.gunsmithBench.isOpen()) return;
    const el = this.renderer.domElement;
    if (document.pointerLockElement !== el && typeof el.requestPointerLock === 'function') {
      try {
        const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {
            // Ignore Chromium post-ESC pointer-lock cooldown or gesture rejections
          });
        }
      } catch {
        // Ignore browser pointer lock rejection
      }
    }
    this.emitSnapshot();
  }

  public toggleTuner(): void {
    if (this.world.gunsmithBench.isOpen()) return;
    this.tunerOpen = !this.tunerOpen;
    if (this.tunerOpen && document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitSnapshot();
  }

  public setTunerOpen(open: boolean): void {
    if (this.world.gunsmithBench.isOpen()) return;
    this.tunerOpen = open;
    if (open && document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitSnapshot();
  }

  public updateConfig(patch: Partial<BodycamSDKConfig>): void {
    this.config = { ...this.config, ...patch };
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.emitSnapshot();
  }

  public applyLensPreset(presetId: BodycamLensPresetId): void {
    const p = LENS_PRESETS[presetId];
    if (!p) return;
    this.config = {
      ...this.config,
      lensPreset: presetId,
      fisheyeStrength: p.fisheyeStrength,
      chromaticAberration: p.chromaticAberration,
      isoGrain: p.isoGrain,
      lensDirtStrength: p.lensDirtStrength,
      motionBlurStrength: p.motionBlurStrength,
    };
    this.showToast(`Optics Preset: ${p.label}`);
    this.emitSnapshot();
  }

  public resetConfig(): void {
    this.config = { ...DEFAULT_BODYCAM_SDK_CONFIG };
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.showToast('SDK Config Reset to Defaults');
    this.emitSnapshot();
  }

  public toggleSimulatedArmTrauma(): void {
    this.simulatedArmTrauma = !this.simulatedArmTrauma;
    this.showToast(
      this.simulatedArmTrauma
        ? 'Arm Trauma Tremor Test: ON (Unified Hand+Gun Lock)'
        : 'Arm Trauma Tremor Test: OFF',
    );
    this.emitSnapshot();
  }

  private syncBeltEquipmentMesh(): void {
    this.skeleton.setBeltEquipment(
      this.tacticalEquipmentId,
      this.tacticalBeltSlot,
      this.grenadeCount,
      this.tacticalMountOnBelt,
    );
  }

  public setTacticalEquipment(id: TacticalEquipmentId): void {
    tacticalEquipmentStore.setEquipment(id);
    const def = getTacticalEquipmentDef(id);
    this.grenadeCount = this.grenadeMax;
    this.syncBeltEquipmentMesh();
    this.audio.playGearRattle('weapon_swap', 0.65);
    this.showToast(`Belt Ordnance Assigned: ${def.name}`);
    this.emitSnapshot();
  }

  public setTacticalBeltSlot(slot: TacticalBeltSlot): void {
    tacticalEquipmentStore.setBeltSlot(slot);
    this.audio.playGearRattle('weapon_swap', 0.55);
    this.showToast(`Belt Mount Updated: ${slot.replace('_', ' ').toUpperCase()}`);
    this.emitSnapshot();
  }

  public setTacticalMountOnBelt(visible: boolean): void {
    tacticalEquipmentStore.setMountOnBelt(visible);
    this.showToast(visible ? 'Belt Mesh Mounted' : 'Belt Mesh Stowed');
    this.emitSnapshot();
  }

  public restockTacticalEquipment(): void {
    this.grenadeCount = this.grenadeMax;
    this.syncBeltEquipmentMesh();
    this.audio.playGearRattle('weapon_swap', 0.7);
    this.showToast(`Ordnance Pouch Restocked (${this.grenadeCount}/${this.grenadeMax})`);
    this.emitSnapshot();
  }

  public triggerQuickThrow(): void {
    if (this.world.gunsmithBench.isActiveOrTransitioning()) return;
    if (this.grenadeCount <= 0) {
      this.restockTacticalEquipment();
    }
    this.camera.getWorldDirection(this._throwDir);
    this._throwOrigin.copy(this.camera.position);
    this.controller.getVelocity(this._playerVelScratch);
    this.audio.playGrenadePinPull();
    this.grenadeSystem.releaseThrow(
      this._throwOrigin,
      this._throwDir,
      this._playerVelScratch,
      this.tacticalEquipmentId,
    );
    this.grenadeCount = Math.max(0, this.grenadeCount - 1);
    this.syncBeltEquipmentMesh();
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    this.showToast(`Thrown: ${def.shortName} (${this.grenadeCount}/${this.grenadeMax})`);
    this.emitSnapshot();
  }

  private handleGrenadeDetonation(ev: GrenadeDetonationEvent, isInHand = false): void {
    const camPos = this.camera.position;
    const dist = camPos.distanceTo(ev.position);

    if (isInHand) {
      this.adrenalineStress = 1.0;
      this.controller.applyRecoil(0.14, (Math.random() - 0.5) * 0.12, 0.045, 0.85, {
        stanceCoupled: false,
      });
      this.postProcess.triggerNvgFlashSpike(1.0);
      this.showToast(`Over-cooked ${ev.def.shortName} detonated in hand!`, 3.2);
    }

    // Kick reactive AR500 steel targets & shatter nearby glass in Gym!
    if (!ev.isTick && (ev.kind === 'frag' || ev.kind === 'flash')) {
      for (let i = 0; i < this.world.steelTargets.length; i++) {
        const st = this.world.steelTargets[i];
        const stPos = new THREE.Vector3();
        st.plateMesh.getWorldPosition(stPos);
        const blastDir = stPos.clone().sub(ev.position);
        if (blastDir.lengthSq() < 1e-5) {
          blastDir.set(0, 0, -1);
        } else {
          blastDir.normalize();
        }
        if (ev.kind === 'frag') {
          const fragRes = this.grenadeSystem.evaluateFragDamageAt(ev.position, stPos, ev.def);
          if (fragRes.damage > 2) {
            const kickScale = THREE.MathUtils.clamp(fragRes.damage / 110, 0.25, 1.4);
            st.hitAngVel += computeTargetHingeAngularImpulse({
              pivot: st.pivot,
              hitPointWorld: stPos,
              incomingDir: blastDir,
              impactSpeedMs: 26 * kickScale,
              bulletMassGrams: 120,
              effectiveInertia: 0.22,
              impulseScale: 1.0,
              minDeltaRadSec: 2.8,
              maxDeltaRadSec: 15.0,
            });
            st.hitFlashTimer = 0.14;
          }
        } else {
          const d = stPos.distanceTo(ev.position);
          if (d <= ev.radiusM * 1.15) {
            const falloff = Math.max(0.2, 1 - d / (ev.radiusM * 1.15));
            st.hitAngVel += computeTargetHingeAngularImpulse({
              pivot: st.pivot,
              hitPointWorld: stPos,
              incomingDir: blastDir,
              impactSpeedMs: 12 * falloff,
              bulletMassGrams: 90,
              effectiveInertia: 0.22,
              impulseScale: 1.0,
              minDeltaRadSec: 1.2,
              maxDeltaRadSec: 6.5,
            });
            st.hitFlashTimer = 0.14;
          }
        }
      }
      if (ev.kind === 'frag') {
        const glassList = this.world.raycastMeshes.filter(
          (m) => m.userData?.breakableGlass && !m.userData.shattered,
        );
        for (let i = 0; i < glassList.length; i++) {
          const gm = glassList[i];
          const gPos = new THREE.Vector3();
          gm.getWorldPosition(gPos);
          if (gPos.distanceTo(ev.position) <= ev.radiusM * 0.9) {
            const dir = gPos.clone().sub(ev.position).normalize();
            if (this.world.shatterBreakable(gm, gPos, dir)) {
              this.audio.playGlassShatter(gPos, 0.95);
            }
          }
        }
      }
    }

    // Concussion adrenaline & full bodycam CMOS flashbang overload + tinnitus
    if (!ev.isTick && dist <= ev.radiusM * 1.35) {
      const closeness = Math.max(0, 1 - dist / (ev.radiusM * 1.35));
      if (ev.kind === 'frag') {
        const fragRes = this.grenadeSystem.evaluateFragDamageAt(ev.position, camPos, ev.def);
        if (fragRes.damage > 0 || closeness > 0.2) {
          this.adrenalineStress = THREE.MathUtils.clamp(
            this.adrenalineStress + 0.55 * closeness,
            0,
            1,
          );
        }
      } else if (ev.kind === 'flash') {
        this.camera.getWorldDirection(this._throwDir);
        const exposure = this.grenadeSystem.computeFlashbangExposure(
          ev.position,
          camPos,
          this._throwDir,
          ev.radiusM * 1.25,
        );
        if (exposure.intensity > 0.05) {
          this.postProcess.triggerFlashbangOverload(exposure.intensity);
          this.audio.playFlashbangTinnitus(exposure.intensity);
          this.flashBlindAlpha = Math.max(
            this.flashBlindAlpha,
            THREE.MathUtils.clamp(exposure.intensity * 0.34, 0, 0.36),
          );
        }
      }
    }
  }

  public toggleSuppressor(): void {
    if (
      this.world.gunsmithBench.isActiveOrTransitioning() ||
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.reloadTimer > 0 ||
      this.weaponRig.isTubularReloading()
    ) {
      return;
    }
    const prof = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    if (prof.holdClass === 'unarmed') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    const weaponId = prof.id;
    const res = this.weaponRig.triggerFieldSuppressorToggle((nowAttached) => {
      if (this.equippedWeaponId !== weaponId) return;
      const cur = this.getAttachmentsFor(weaponId);
      this.attachmentsByWeapon[weaponId] = normalizeWeaponAttachments(weaponId, {
        ...cur,
        suppressorStowed: nowAttached ? undefined : true,
      });
      this.saveManager.saveGymLoadout(this.attachmentsByWeapon);
      this.syncRuntimeProfile();
      this.showToast(nowAttached ? 'Suppressor Attached' : 'Suppressor Stowed');
      this.emitSnapshot();
    });

    if (res === 'no_suppressor') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    if (res === 'busy') {
      return;
    }

    this.isFiring = false;
    this.input.ads = false;
    this.showToast(res === 'started_attach' ? 'Attaching Suppressor...' : 'Stowing Suppressor...');
    this.emitSnapshot();
  }

  public openGunsmith(): void {
    if (this.world.gunsmithBench.isOpen()) return;
    if (this.pdaDevice.isOpen()) {
      this.pdaDevice.setOpen(false);
    }
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
    }
    this.audio.ensureInitialized();
    this.weaponRig.cancelAction();
    this.tunerOpen = false;
    this.isFiring = false;
    this.input.ads = false;
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.vault = false;

    if (this.equippedWeaponId === 'unarmed') {
      this.switchWeapon(this.lastFirearmId || 'm4_556', true);
    }

    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }

    const baseProf = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    const att = this.getAttachmentsFor(baseProf.id);
    this.world.gunsmithBench.enter(this.camera, baseProf, att);
    this.world.gunsmithBench.setShowcaseTurretElevation(att.zeroElevationMrad ?? 0);
    this.world.gunsmithBench.projectPins(
      this.camera,
      this.container.clientWidth || 1,
      this.container.clientHeight || 1,
      this._pinBuffer,
    );
    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position });
    this.emitSnapshot();
  }

  public closeGunsmith(): void {
    if (!this.world.gunsmithBench.isOpen()) return;
    this.world.gunsmithBench.exit(this.camera);
    const baseProf = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    this.weaponRig.setWeaponProfile(baseProf, this.getAttachmentsFor(baseProf.id));
    this.syncRuntimeProfile();
    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position });
    this.requestLock();
    this.emitSnapshot();
  }

  public selectGunsmithWeapon(weaponId: string): void {
    const resolved = resolveWeaponProfile(weaponId);
    this.switchWeapon(resolved.id, true);
    const baseProf = resolveWeaponProfile(this.equippedWeaponId);
    if (this.world.gunsmithBench.isOpen()) {
      const att = this.getAttachmentsFor(baseProf.id);
      this.world.gunsmithBench.setShowcaseWeapon(baseProf, att);
      this.world.gunsmithBench.setShowcaseTurretElevation(att.zeroElevationMrad ?? 0);
      this.world.gunsmithBench.projectPins(
        this.camera,
        this.container.clientWidth || 1,
        this.container.clientHeight || 1,
        this._pinBuffer,
      );
    }
    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position });
    this.emitSnapshot();
  }

  public selectGunsmithAttachment(slot: AttachmentSlot, attachmentId: string | null): void {
    const baseProf = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    if (baseProf.holdClass === 'unarmed') return;

    const prevDerived = this.weaponRig.getDerivedStats();
    const prevCap = prevDerived.magCapacity;

    const next = normalizeWeaponAttachments(baseProf.id, {
      ...this.getAttachmentsFor(baseProf.id),
      [slot]: attachmentId,
    });
    this.attachmentsByWeapon[baseProf.id] = next;
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);

    this.weaponRig.setWeaponProfile(baseProf, next);
    if (this.world.gunsmithBench.isOpen()) {
      this.world.gunsmithBench.setShowcaseWeapon(baseProf, next);
    }
    this.syncRuntimeProfile();

    const newDerived = this.weaponRig.getDerivedStats();
    if (slot === 'magazine') {
      const activeCal = this.getActiveBaseCaliberId(baseProf.id);
      const currentAmmoId = this.selectedAmmoVariantByWeapon[baseProf.id];
      if (currentAmmoId && AMMO_VARIANTS[currentAmmoId]?.caliberId !== activeCal) {
        this.selectedAmmoVariantByWeapon[baseProf.id] = getDefaultAmmoVariant(activeCal).id;
        this.syncRuntimeProfile();
      }
      const curAmmo = this.magAmmoByWeapon[baseProf.id] ?? prevCap;
      this.magAmmoByWeapon[baseProf.id] =
        curAmmo >= prevCap ? newDerived.magCapacity : Math.min(curAmmo, newDerived.magCapacity);
      this.weaponRig.setAmmoState(this.magAmmoByWeapon[baseProf.id]);
    }

    if (!this.weaponRig.hasCantedOptic() && this.adsModeByWeapon[baseProf.id] === 'CANTED') {
      this.setArmedAdsMode(baseProf.id, 'PRIMARY');
    }

    if (!newDerived.hasFlashlight && this.flashlightOn) {
      this.flashlightOn = false;
      this.weaponRig.flashlight.visible = false;
      this.weaponRig.flashlight.intensity = 0;
    }

    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position });
    this.emitSnapshot();
  }

  public selectGunsmithReticleColor(slot: 'optic' | 'canted', colorId: ReticleColorId): void {
    const baseProf = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    if (baseProf.holdClass === 'unarmed') return;

    const current = this.getAttachmentsFor(baseProf.id);
    const key = slot === 'canted' ? 'cantedReticleColor' : 'reticleColor';
    if (current[key] === colorId) return;

    const next = normalizeWeaponAttachments(baseProf.id, {
      ...current,
      [key]: colorId,
    });
    this.attachmentsByWeapon[baseProf.id] = next;
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);

    this.weaponRig.setWeaponProfile(baseProf, next);
    if (this.world.gunsmithBench.isOpen()) {
      this.world.gunsmithBench.setShowcaseWeapon(baseProf, next);
    }
    this.syncRuntimeProfile();
    this.audio.playTacticalSwitchClick(true);
    this.emitSnapshot();
  }

  public stripGunsmithWeapon(): void {
    const baseProf = SDK_WEAPON_PROFILES[this.equippedWeaponId] ?? SDK_WEAPON_PROFILES.m4_556;
    if (baseProf.holdClass === 'unarmed') return;
    const bare = createBareAttachments();
    this.attachmentsByWeapon[baseProf.id] = bare;
    this.saveManager.saveGymLoadout(this.attachmentsByWeapon);

    this.weaponRig.setWeaponProfile(baseProf, bare);
    if (this.world.gunsmithBench.isOpen()) {
      this.world.gunsmithBench.setShowcaseWeapon(baseProf, bare);
    }
    this.syncRuntimeProfile();
    this.magAmmoByWeapon[baseProf.id] = Math.min(
      this.magAmmoByWeapon[baseProf.id] ?? baseProf.magCapacity,
      baseProf.magCapacity,
    );
    this.weaponRig.setAmmoState(this.magAmmoByWeapon[baseProf.id]);
    if (this.adsModeByWeapon[baseProf.id] === 'CANTED') {
      this.setArmedAdsMode(baseProf.id, 'PRIMARY');
    }
    if (this.flashlightOn) {
      this.flashlightOn = false;
      this.weaponRig.flashlight.visible = false;
      this.weaponRig.flashlight.intensity = 0;
    }
    this.audio.playWeaponCue('gunsmith_snap', { position: this.camera.position });
    this.emitSnapshot();
  }

  public orbitGunsmith(dx: number, dy: number): void {
    this.world.gunsmithBench.orbitDrag(dx, dy);
  }

  public zoomGunsmith(deltaY: number): void {
    this.world.gunsmithBench.zoomWheel(deltaY);
  }

  public teleportToZone(zoneId: GymZoneId, silent = false): void {
    const z = GYM_ZONE_PRESETS.find((p) => p.id === zoneId) ?? GYM_ZONE_PRESETS[0];
    this.controller.snapTo(z.position[0], z.position[1], z.position[2], z.yaw, z.pitch);
    if (!silent) {
      this.showToast(`Bay: ${z.label}`);
      this.emitSnapshot();
    }
  }

  private handleGrenadeHolsterOrToss(): 'holstered' | 'tossed' | 'none' {
    this.camera.getWorldDirection(this._throwDir);
    this._throwOrigin.copy(this.camera.position);
    this.controller.getVelocity(this._playerVelScratch);
    const res = this.grenadeSystem.holsterOrTossOnSwitch(
      this._throwOrigin,
      this._throwDir,
      this._playerVelScratch,
    );
    if (res === 'tossed') {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.showToast('Live Grenade Tossed Clear!');
    } else if (res === 'holstered') {
      this.showToast('Grenade Re-Pinned & Holstered');
    }
    return res;
  }

  public switchWeapon(weaponId: string, silent = false): void {
    const prof = SDK_WEAPON_PROFILES[weaponId] ?? resolveWeaponProfile(weaponId);
    if (!prof) return;
    if (this.pdaDevice.isOpen()) {
      this.pdaDevice.setOpen(false);
    }
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
    }
    this.equippedWeaponId = prof.id;
    if (prof.holdClass !== 'unarmed') {
      this.lastFirearmId = prof.id;
    }
    this.reloadTimer = 0;
    this.animator.cancelAction();
    const att = this.getAttachmentsFor(prof.id);
    this.weaponRig.setWeaponProfile(prof, att);
    if (this.world.gunsmithBench.isOpen() && prof.holdClass !== 'unarmed') {
      this.world.gunsmithBench.setShowcaseWeapon(prof, att);
    }
    this.input.adsMode = this.getArmedAdsMode(prof.id);
    this.syncRuntimeProfile();
    const derived = this.weaponRig.getDerivedStats();
    if (!derived.hasFlashlight && this.flashlightOn) {
      this.flashlightOn = false;
      this.weaponRig.flashlight.visible = false;
      this.weaponRig.flashlight.intensity = 0;
    }
    this.weaponRig.setAmmoState(this.magAmmoByWeapon[prof.id] ?? 0);
    if (!silent) {
      this.audio.playGearRattle('weapon_swap', 0.9);
      this.showToast(
        prof.holdClass === 'unarmed'
          ? 'Unarmed'
          : `${prof.name} · ${derived.totalMassKg.toFixed(2)}kg (Ergo ${derived.ergonomics})`,
      );
      this.emitSnapshot();
    }
  }

  private showToast(msg: string, durationSec = 2.2): void {
    this.toastMessage = msg;
    this.toastTimer = durationSec;
  }

  private toggleLaser(): void {
    const prof = this.getWeaponProfile();
    const derived = this.weaponRig.getDerivedStats();
    if (!prof.supportsLaser || !derived.hasLaser) {
      this.weaponRig.laserOn = false;
      this.showToast('Mount Perst-4 Laser or PEQ Combo on Gunsmith Bench [E]');
      this.emitSnapshot();
      return;
    }
    this.weaponRig.laserOn = !this.weaponRig.laserOn;
    this.weaponRig.triggerTacticalSwitch();
    this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
    this.showToast(
      this.weaponRig.laserOn
        ? `Laser: ON (${this.weaponRig.laserMode === 'ir_green' ? 'IR Green' : 'Visible Red'})`
        : 'Laser: OFF',
    );
    this.emitSnapshot();
  }

  private cycleLaserMode(): void {
    const prof = this.getWeaponProfile();
    const derived = this.weaponRig.getDerivedStats();
    if (!prof.supportsLaser || !derived.hasLaser) {
      this.showToast('Mount Perst-4 Laser or PEQ Combo on Gunsmith Bench [E]');
      return;
    }
    const next = this.weaponRig.laserMode === 'visible_red' ? 'ir_green' : 'visible_red';
    this.weaponRig.setLaserMode(next);
    this.weaponRig.laserOn = true;
    this.weaponRig.triggerTacticalSwitch();
    this.audio.playTacticalSwitchClick(true);
    this.showToast(`Laser Mode: ${next === 'ir_green' ? 'IR Green' : 'Visible Red'}`);
    this.emitSnapshot();
  }

  private toggleFlashlight(): void {
    const derived = this.weaponRig.getDerivedStats();
    if (!derived.hasFlashlight) {
      this.flashlightOn = false;
      this.weaponRig.flashlight.visible = false;
      this.weaponRig.flashlight.intensity = 0;
      this.showToast('Mount WML Light or PEQ Combo on Gunsmith Bench [E]');
      this.emitSnapshot();
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.weaponRig.flashlight.visible = this.flashlightOn;
    this.weaponRig.flashlight.intensity = this.flashlightOn ? 32 : 0;
    this.weaponRig.triggerTacticalSwitch();
    this.audio.playTacticalSwitchClick(this.flashlightOn);
    this.showToast(this.flashlightOn ? 'Weapon Light: ON' : 'Weapon Light: OFF');
    this.emitSnapshot();
  }

  public toggleReticleIllumination(): void {
    const illum = this.weaponRig.toggleReticleIllumination();
    this.audio.playTacticalSwitchClick(illum);
    this.showToast(illum ? 'Reticle Illumination: ON' : 'Reticle Illumination: ETCHED OFF');
    this.emitSnapshot();
  }

  private cycleOpticZoom(dir: 1 | -1): void {
    if (!this.weaponRig.hasVariableZoom()) return;
    const prev = this.weaponRig.getTargetOpticZoomMult();
    const next = this.weaponRig.cycleOpticZoom(dir, true);
    if (Math.abs(next - prev) < 0.01) return;
    this.showToast(`Optic Magnification: ${next.toFixed(1)}x`);
    this.emitSnapshot();
  }

  private startReload(): void {
    const prof = this.getWeaponProfile();
    if (
      prof.magCapacity <= 0 ||
      this.reloadTimer > 0 ||
      this.weaponRig.isTubularReloading() ||
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive()
    ) {
      return;
    }
    const curAmmo = this.magAmmoByWeapon[prof.id] ?? 0;
    if (curAmmo >= prof.magCapacity) {
      this.showToast(`Mag Full (${prof.magCapacity}/${prof.magCapacity})`);
      return;
    }
    const isTubularShotgun = prof.holdClass === 'shotgun' && prof.fireMode === 'pump';
    if (isTubularShotgun) {
      const shellsNeeded = prof.magCapacity - curAmmo;
      const weaponId = prof.id;
      const started = this.weaponRig.triggerTubularReload(
        shellsNeeded,
        curAmmo === 0,
        () => {
          if (this.equippedWeaponId !== weaponId) return;
          const nextAmmo = Math.min(prof.magCapacity, (this.magAmmoByWeapon[weaponId] ?? 0) + 1);
          this.magAmmoByWeapon[weaponId] = nextAmmo;
          this.weaponRig.setAmmoState(nextAmmo);
          this.emitSnapshot();
        },
        () => {
          if (this.equippedWeaponId !== weaponId) return;
          const finalAmmo = this.magAmmoByWeapon[weaponId] ?? 0;
          this.showToast(`Loaded: ${finalAmmo}/${prof.magCapacity}`);
          this.emitSnapshot();
        },
      );
      if (started) {
        this.showToast(`Loading ${prof.name} shells...`);
        this.emitSnapshot();
      }
      return;
    }
    this.reloadTimer = prof.reloadDurationSec;
    this.animator.triggerReload(prof.reloadDurationSec);
    this.showToast(`Reloading ${prof.name}...`);
    this.emitSnapshot();
  }

  private startMagCheck(): void {
    const prof = this.getWeaponProfile();
    if (
      prof.magCapacity <= 0 ||
      this.reloadTimer > 0 ||
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive()
    ) {
      return;
    }
    this.animator.triggerMagCheck(prof.magCheckDurationSec);
    const rounds = this.magAmmoByWeapon[prof.id] ?? 0;
    const att = this.getAttachmentsFor(prof.id);
    const zeroDist = att.zeroDistanceM ?? getDefaultZeroDistanceM(prof.category);
    const zeroMrad = att.zeroElevationMrad ?? 0;
    const mradTag = zeroMrad !== 0 ? ` ${zeroMrad > 0 ? '+' : ''}${zeroMrad.toFixed(1)} MRAD` : '';
    this.showToast(
      `Mag Check: ${rounds}/${prof.magCapacity} · ${prof.caliberLabel} · ZERO ${zeroDist}m${mradTag}`,
    );
    this.emitSnapshot();
  }

  private triggerWeaponInspect(): void {
    const prof = this.getWeaponProfile();
    if (
      prof.holdClass === 'unarmed' ||
      this.reloadTimer > 0 ||
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive()
    ) {
      return;
    }
    if (this.animator.triggerInspect()) {
      const att = this.getAttachmentsFor(prof.id);
      const zeroDist = att.zeroDistanceM ?? getDefaultZeroDistanceM(prof.category);
      const zeroMrad = att.zeroElevationMrad ?? 0;
      const mradTag = zeroMrad !== 0 ? ` (${zeroMrad > 0 ? '+' : ''}${zeroMrad.toFixed(1)} MRAD)` : '';
      this.showToast(`Inspecting ${prof.name} · ZERO ${zeroDist}m${mradTag}`);
      this.emitSnapshot();
    }
  }

  private triggerQuickBash(): void {
    const prof = this.getWeaponProfile();
    if (
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive()
    ) {
      return;
    }
    if (prof.holdClass === 'unarmed') {
      const punch = this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
      if (punch) {
        this.stamina = Math.max(0, this.stamina - (punch === 'cross' ? 0.065 : 0.04));
        this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + 0.07, 0, 1);
        this.stillDurationSec = 0;
      }
      return;
    }
    if (this.animator.triggerArmedBash(this.controller, prof.holdClass)) {
      if (this.reloadTimer > 0) this.reloadTimer = 0;
      this.stamina = Math.max(0, this.stamina - 0.06);
      this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + 0.08, 0, 1);
      this.stillDurationSec = 0;
    }
  }

  private triggerPushKick(): void {
    if (this.pdaDevice.isBlockingWeaponActions() || this.weaponRig.isSuppressorActionActive()) {
      return;
    }
    const res = this.animator.triggerPushKick(this.controller, this.getActiveTraumaModifiers());
    if (res === 'dual_leg_trauma') {
      this.showToast('Both legs fractured — cannot push-kick');
      return;
    }
    if (res !== 'ok') return;
    if (this.reloadTimer > 0) this.reloadTimer = 0;
    this.stamina = Math.max(0, this.stamina - 0.11);
    this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + 0.12, 0, 1);
    this.stillDurationSec = 0;
  }

  private handleMeleeHit(ev: Readonly<BodycamMeleeHitEvent>): void {
    const ud = ev.object?.userData;
    const penSurfaceId = ud?.penetrableSurfaceId as string | undefined;
    if (penSurfaceId) {
      this.world.penetrableSurfaces.applyMeleeImpact(
        penSurfaceId,
        ev.point,
        ev.direction,
        ev.attackType,
      );
      return;
    }
    const targetKind = ud?.gymTargetKind as string | undefined;
    const targetId = ud?.gymTargetId as string | undefined;
    if (targetKind === 'steel_plate' && targetId) {
      const st = this.world.steelTargets.find((s) => s.id === targetId);
      if (st) {
        const meleeMassG =
          ev.attackType === 'kick' ? (ev.wellPlaced ? 950 : 650) : ev.attackType === 'bash' ? 680 : ev.attackType === 'cross' ? 560 : 400;
        const meleeSpeedMs =
          ev.attackType === 'kick' ? 11.5 : ev.attackType === 'cross' ? 9.5 : 7.5;
        st.hitAngVel += computeTargetHingeAngularImpulse({
          pivot: st.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.direction,
          impactSpeedMs: meleeSpeedMs,
          bulletMassGrams: meleeMassG,
          effectiveInertia: 0.24,
          impulseScale: 0.18,
          minDeltaRadSec: 1.2,
          maxDeltaRadSec: 4.5,
        });
        st.hitFlashTimer = 0.06;
        this.audio.playImpact(ev.point, 'steel_plate');
        this.lastHit = {
          targetLabel: `${st.label} (${ev.attackType.toUpperCase()})`,
          caliberLabel: ev.attackType === 'kick' ? 'PUSH-KICK' : ev.attackType.toUpperCase(),
          ammoLabel: ev.attackType.toUpperCase(),
          outcome: 'stop',
          material: 'steel',
          grazingAngleDeg: 90,
          penetrationThicknessM: 0,
          distanceM: this.controller.position.distanceTo(ev.point),
          impactSpeedMps: ev.attackType === 'kick' ? 9.5 : ev.attackType === 'cross' ? 7.8 : 6.4,
          energyJoules: ev.damageEnergyJ,
          isSteel: true,
          timestampMs: performance.now(),
        };
        this.emitSnapshot();
      }
    } else if (ev.hitZone === 'glass') {
      this.showToast(ev.attackType === 'kick' ? 'Window Breached (Push-Kick)' : 'Glass Shattered');
    }
  }

  private attemptFire(): void {
    if (this.pdaDevice.isBlockingWeaponActions() || this.grenadeSystem.isDrawn()) return;
    const prof = this.getWeaponProfile();
    if (prof.holdClass === 'unarmed') {
      if (this.semiTriggerConsumed || this.controller.isVaulting()) return;
      const punch = this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
      if (punch) {
        this.semiTriggerConsumed = true;
        this.stamina = Math.max(0, this.stamina - (punch === 'cross' ? 0.065 : 0.04));
        this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + 0.07, 0, 1);
        this.stillDurationSec = 0;
      }
      return;
    }
    if (prof.fireMode === 'none' || prof.magCapacity <= 0) return;
    const currentAmmo = this.magAmmoByWeapon[prof.id] ?? 0;
    if (this.weaponRig.isTubularReloading()) {
      if (currentAmmo > 0 && !this.controller.isSprinting && !this.controller.isVaulting()) {
        this.weaponRig.interruptTubularReload();
        this.reloadTimer = 0;
      } else {
        return;
      }
    }
    if (
      this.reloadTimer > 0 ||
      this.fireCooldown > 0 ||
      this.weaponRig.isBlockingFiringAction() ||
      this.controller.isSprinting ||
      this.controller.isVaulting() ||
      this.animator.isCombatBusy()
    ) {
      return;
    }
    if (this.weaponRig.getReadOnlyRigState().pullbackRatio > 0.72) return;
    const isSingleShotMode =
      prof.fireMode === 'semi' || prof.fireMode === 'bolt' || prof.fireMode === 'pump';
    if (isSingleShotMode && this.semiTriggerConsumed) return;

    if (currentAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.showToast('Click — Empty Mag (Press R to Reload)');
      return;
    }

    const remainingAmmo = currentAmmo - 1;
    this.magAmmoByWeapon[prof.id] = remainingAmmo;
    this.fireCooldown = 60 / Math.max(25, prof.rpm);
    if (isSingleShotMode) {
      this.semiTriggerConsumed = true;
    }

    if (this.grenadeSystem.isDrawn()) return;
    const derived = this.weaponRig.getDerivedStats();
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
    const suppressed = derived.isSuppressed;
    this.animator.interruptInspect();
    this.weaponRig.cancelZoomTwist();

    // Sample world muzzle transform BEFORE recoil kick, applying true HOB ballistic zeroing pitch
    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    this.ballistics.fireRound(
      this._muzzlePos,
      this._muzzleDir,
      prof,
      activeAmmo,
      derived.velocityMult,
    );

    // Visual muzzle flash + articulated blowback / bolt-action cycle / revolver cylinder indexing + brass
    const cyclePump = prof.toggleablePumpSemi ? this.spas12Mode === 'pump' : undefined;
    this.weaponRig.triggerFire(suppressed, remainingAmmo, cyclePump);
    if (!suppressed) {
      this.postProcess.triggerNvgFlashSpike(0.55);
    }
    this.controller.applyRecoil(
      prof.recoilPitchRad,
      prof.recoilYawRad,
      prof.kickBackM,
      this.config.sightMisalignStrength,
      {
        adsCameraShakeScale: this.config.adsCameraShakeScale,
        hipRecoilSwayScale: this.config.hipRecoilSwayScale,
        stanceCoupled: true,
      },
    );
    const audioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this.audio.playWeaponCue('fire', {
      position: this._muzzlePos,
      weightClass: audioWeight,
      caliberId: activeAmmo.caliberId,
      suppressed,
      isSubsonic: activeAmmo.isSubsonic,
      muzzleComp: derived.hasCompensator,
    });
    this.adrenalineStress = THREE.MathUtils.clamp(
      this.adrenalineStress + (suppressed ? 0.06 : 0.11),
      0,
      1,
    );
    this.stillDurationSec = 0;
  }

  private readonly onResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postProcess.setSize(w, h);
  };

  private clearHeldControlInputs(): void {
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.shiftHeld = false;
    this.altHeld = false;
    this.input.ads = false;
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.holdBreath = false;
    this.input.vault = false;
    this.grenadeSystem.resetHeldInputOnFocusLoss();
    this.pdaDevice.setDragging(false);
  }

  private readonly onWindowBlur = (): void => {
    this.clearHeldControlInputs();
    this.emitSnapshot();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.clearHeldControlInputs();
    }
    this.emitSnapshot();
  };

  private togglePda(): void {
    if (this.world.gunsmithBench.isOpen() || this.tunerOpen) return;
    const next = !this.pdaDevice.isOpen();
    if (next) {
      if (this.grenadeSystem.isDrawn() && !this.grenadeSystem.isPinPulled()) {
        this.handleGrenadeHolsterOrToss();
      }
      this.isFiring = false;
      this.input.ads = false;
      this.reloadTimer = 0;
    }
    this.pdaDevice.setOpen(next);
    this.emitSnapshot();
  }

  private syncNvgRuntime(): void {
    const mount = this.localGear.nvgMount;
    const active = mount !== 'none' && this.nvgFlipped;
    const irActive = active && this.irIlluminatorOn;
    this.skeleton.setNvgFlipped(active);
    this.postProcess.setNvgState(mount, active, irActive);
    this.irIlluminatorLight.visible = irActive;
    this.weaponRig.setNvgOpticalActive(active);
    this.weaponRig.setIrLaserActive(irActive);
    this.audio.setNvgTubeHum(active);
  }

  private toggleNvg(): void {
    if (this.world.gunsmithBench.isOpen() || this.tunerOpen) return;
    if (this.localGear.nvgMount === 'none') {
      this.showToast('No NVG Mounted — Equip Mil-Tec + NVG in Operator Screen');
      return;
    }
    this.nvgFlipped = !this.nvgFlipped;
    if (!this.nvgFlipped) {
      this.irIlluminatorOn = false;
    }
    this.audio.playNvgFlipSound(this.nvgFlipped);
    this.syncNvgRuntime();
    const label = this.localGear.nvgMount === 'arnvg' ? 'RNVG-A (P45)' : 'PVS-7 NL2 (P43)';
    this.showToast(this.nvgFlipped ? `${label} Deployed · [N] IR Flood` : `${label} Stowed`);
    this.emitSnapshot();
  }

  private toggleIrIlluminator(): void {
    if (!this.nvgFlipped || this.localGear.nvgMount === 'none') {
      this.showToast('Deploy NVG [J] to use IR Illuminator');
      return;
    }
    this.irIlluminatorOn = !this.irIlluminatorOn;
    this.audio.playIrIlluminatorClick(this.irIlluminatorOn);
    this.syncNvgRuntime();
    this.showToast(this.irIlluminatorOn ? 'IR Illuminator + IR Laser: ON' : 'IR Illuminator: OFF');
    this.emitSnapshot();
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    // Clamp abnormal single-frame pointer jump spikes
    const dx = THREE.MathUtils.clamp(e.movementX, -140, 140);
    const dy = THREE.MathUtils.clamp(e.movementY, -140, 140);
    if (this.pdaDevice.isOpen() && this.pdaDevice.isDragging()) {
      this.pdaDevice.applyDragDelta(dx, dy);
      return;
    }
    this.controller.handleMouseMove(dx, dy, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
    if (!this.pointerLocked) return;
    this.audio.ensureInitialized();

    if (this.pdaDevice.isBlockingWeaponActions()) {
      if (e.button === 0 && this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
      } else if (e.button === 2 && this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      }
      return;
    }

    // Authentic 4-stage tactical grenade Manual of Arms when grenade is drawn
    if (this.grenadeSystem.isDrawn()) {
      this.input.ads = false;
      const stage = this.grenadeSystem.getHoldStage();
      if (e.button === 2) {
        if (stage === 'DRAWN') {
          this.grenadeSystem.pullPin();
          this.emitSnapshot();
        } else if (stage === 'PIN_PULLED') {
          this.grenadeSystem.releaseLever();
          this.emitSnapshot();
        }
      } else if (e.button === 0 && (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED')) {
        this.grenadeSystem.beginThrowInput();
        this.emitSnapshot();
      }
      return;
    }

    if (e.button === 0) {
      this.animator.interruptInspect();
      this.isFiring = true;
      this.semiTriggerConsumed = false;
      this.attemptFire();
    } else if (e.button === 2) {
      this.animator.interruptInspect();
      this.input.ads = true;
    } else if (e.button === 1) {
      // Middle-click toggles Point Aim mode for RMB on every firearm (never initiates ADS on its own)
      const prof = this.getWeaponProfile();
      if (prof.holdClass === 'unarmed') return;
      const cur = this.getArmedAdsMode(prof.id);
      const next: AdsMode = cur === 'POINT_AIM' ? 'PRIMARY' : 'POINT_AIM';
      this.setArmedAdsMode(prof.id, next);
      this.audio.playGearRattle('weapon_swap', 0.45);
      this.showToast(
        next === 'POINT_AIM' ? 'Point Aim Mode: ARMED (RMB)' : 'Primary Optic ADS (RMB)',
      );
      this.emitSnapshot();
    }
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (this.pdaDevice.isDragging()) {
        this.pdaDevice.setDragging(false);
      }
      if (this.grenadeSystem.isThrowInputHeld()) {
        this.grenadeSystem.releaseThrowInput();
        this.emitSnapshot();
      }
      this.isFiring = false;
      this.semiTriggerConsumed = false;
      if (this.grenadeSystem.isDrawn()) {
        return;
      }
    } else if (e.button === 2) {
      this.input.ads = false;
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.pointerLocked && !this.world.gunsmithBench.isOpen() && this.pdaDevice.isOpen()) {
      e.preventDefault();
      this.pdaDevice.applyWheel(e.deltaY);
      return;
    }
    if (
      this.pointerLocked &&
      !this.world.gunsmithBench.isOpen() &&
      !this.controller.isSprinting &&
      this.weaponRig.hasVariableZoom()
    ) {
      e.preventDefault();
      this.cycleOpticZoom(e.deltaY < 0 ? 1 : -1);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.world.gunsmithBench.isOpen()) {
      if (e.code === 'Escape' || (e.code === 'KeyE' && !e.repeat)) {
        e.preventDefault();
        this.closeGunsmith();
      }
      return;
    }

    if (e.code === 'F1') {
      e.preventDefault();
      this.toggleTuner();
      return;
    }

    if (!this.pointerLocked) return;
    this.audio.ensureInitialized();

    const weaponKey = WEAPON_HOTKEYS[e.code];
    if (weaponKey) {
      this.switchWeapon(weaponKey);
      return;
    }

    switch (e.code) {
      case 'KeyW':
        this.input.forward = true;
        break;
      case 'KeyS':
        this.input.backward = true;
        break;
      case 'KeyA':
        this.input.left = true;
        break;
      case 'KeyD':
        this.input.right = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.shiftHeld = true;
        break;
      case 'AltLeft':
      case 'AltRight':
        this.altHeld = true;
        break;
      case 'KeyC':
        if (!e.repeat) this.controller.toggleCrouch();
        break;
      case 'KeyQ':
        this.input.leanLeft = true;
        break;
      case 'KeyE':
        if (!e.repeat && this.lookingAtBench) {
          this.openGunsmith();
        } else {
          this.input.leanRight = true;
        }
        break;
      case 'KeyF':
        if (!e.repeat) {
          this.toggleFlashlight();
        }
        break;
      case 'KeyM':
        if (!e.repeat) this.togglePda();
        break;
      case 'KeyB':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          if (!this.weaponRig.hasCantedOptic()) break;
          const prof = this.getWeaponProfile();
          const cur = this.getArmedAdsMode(prof.id);
          const next: AdsMode = cur === 'CANTED' ? 'PRIMARY' : 'CANTED';
          this.setArmedAdsMode(prof.id, next);
          this.audio.playGearRattle('weapon_swap', 0.45);
          this.showToast(
            next === 'CANTED' ? 'Canted Sight Mode: ARMED (RMB)' : 'Primary Optic ADS (RMB)',
          );
          this.emitSnapshot();
        }
        break;
      case 'KeyL':
        if (!e.repeat) {
          if (e.altKey) this.cycleLaserMode();
          else this.toggleLaser();
        }
        break;
      case 'KeyT':
        if (!e.repeat) {
          if (e.altKey) this.startMagCheck();
          else this.toggleFlashlight();
        }
        break;
      case 'KeyR':
        if (!e.repeat) {
          if (this.pdaDevice.isOpen()) {
            this.pdaDevice.recenterOnPlayer();
          } else {
            this.startReload();
          }
        }
        break;
      case 'KeyI':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.triggerWeaponInspect();
        break;
      case 'KeyG':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.toggleSuppressor();
        break;
      case 'KeyV':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.triggerQuickBash();
        break;
      case 'KeyX':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.triggerPushKick();
        break;
      case 'KeyZ':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.toggleFireMode();
        break;
      case 'KeyJ':
        if (!e.repeat) this.toggleNvg();
        break;
      case 'KeyN':
        if (!e.repeat) {
          if (this.nvgFlipped && !e.altKey) {
            this.toggleIrIlluminator();
          } else {
            this.toggleReticleIllumination();
          }
        }
        break;
      case 'BracketRight':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          this.cycleOpticZoom(1);
        }
        break;
      case 'BracketLeft':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          this.cycleOpticZoom(-1);
        }
        break;
      case 'KeyH':
      case 'Digit5':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          if (this.grenadeSystem.isDrawn()) {
            this.handleGrenadeHolsterOrToss();
            this.emitSnapshot();
          } else if (this.grenadeCount <= 0) {
            this.showToast('Ordnance Pouch Empty — Restock in [F1] Tactical Gear');
          } else {
            this.isFiring = false;
            this.input.ads = false;
            this.reloadTimer = 0;
            this.weaponRig.cancelZoomTwist();
            this.grenadeSystem.drawGrenade(this.tacticalEquipmentId);
            const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
            this.showToast(`${def.shortName} Drawn — [RMB] Pin · [RMB] Spoon · [LMB] Click Lob / Hold Throw`);
            this.emitSnapshot();
          }
        }
        break;
      case 'Space':
        e.preventDefault();
        if (!e.repeat) {
          this.input.vault = true;
        }
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW':
        this.input.forward = false;
        break;
      case 'KeyS':
        this.input.backward = false;
        break;
      case 'KeyA':
        this.input.left = false;
        break;
      case 'KeyD':
        this.input.right = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.shiftHeld = false;
        break;
      case 'AltLeft':
      case 'AltRight':
        this.altHeld = false;
        break;
      case 'KeyQ':
        this.input.leanLeft = false;
        break;
      case 'KeyE':
        this.input.leanRight = false;
        break;
      case 'Space':
        this.input.vault = false;
        break;
    }
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
  };

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private unbindEvents(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const sync = typeof gl.fenceSync === 'function' ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (this.disposed) return;
        if (!sync || gl.clientWaitSync(sync, 0, 0) !== gl.TIMEOUT_EXPIRED) {
          if (sync) gl.deleteSync(sync);
          this.swTimerId = window.setTimeout(() => this.tick(), 80);
        } else {
          this.swTimerId = window.setTimeout(poll, 4);
        }
      };
      this.swTimerId = window.setTimeout(poll, 4);
    } else {
      this.rafId = requestAnimationFrame(() => this.tick());
    }
  }

  private tick(): void {
    if (this.disposed) return;

    const now = performance.now();
    const rawDt = Math.max(0.001, (now - this.lastTimeMs) * 0.001);
    this.lastTimeMs = now;
    const dt = Math.min(rawDt, 0.05);
    this.elapsedSec += dt;
    this.recordingElapsedSec += dt;

    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.35) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) {
        this.toastMessage = null;
      }
    }

    const prof = this.getWeaponProfile();
    const derived = this.weaponRig.getDerivedStats();

    // Sync zero-GC mutable runtime config (applies PSO-4 magnified zoom & clean Gunsmith lens)
    Object.assign(this._runtimeConfig, this.config);
    const benchBusy = this.world.gunsmithBench.isActiveOrTransitioning();
    if (benchBusy) {
      this._runtimeConfig.fisheyeStrength = 0;
      this._runtimeConfig.chromaticAberration = 0;
      this._runtimeConfig.isoGrain = 0;
      this._runtimeConfig.motionBlurStrength = 0;
      this._runtimeConfig.baseHFovDeg = 52;
      this._runtimeConfig.adsHFovDeg = 52;
    } else {
      // Keep peripheral FOV natural when dual-render PiP scope handles magnification inside the lens
      this._runtimeConfig.adsHFovDeg = derived.isMagnifiedOptic
        ? this.config.adsHFovDeg * 0.94
        : this.config.adsHFovDeg / Math.max(1.0, derived.adsZoomFactor);
    }

    // Update reload sequence (audio beats & physical magazine swap driven by WeaponAnimator)
    if (this.reloadTimer > 0 && !benchBusy) {
      const traumaMult = this.getActiveTraumaModifiers().reloadSpeedMult;
      this.reloadTimer -= dt * Math.max(0.5, traumaMult);
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.magAmmoByWeapon[prof.id] = prof.magCapacity;
        this.weaponRig.setAmmoState(prof.magCapacity);
        this.showToast(`Reloaded: ${prof.magCapacity}/${prof.magCapacity}`);
      }
    }

    // Automatic fire loop
    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    }
    if (this.isFiring && this.pointerLocked && !benchBusy) {
      this.attemptFire();
    }

    // Regenerate stamina smoothly when not sprinting
    if (!this.controller.isSprinting) {
      this.stamina = Math.min(1.0, this.stamina + dt * 0.22);
    }

    const baseAdsMode = this.getArmedAdsMode(prof.id);
    const nodsForceCant =
      this.nvgFlipped &&
      this.input.ads &&
      baseAdsMode === 'PRIMARY' &&
      this.weaponRig.shouldForceNodsCantedAim(true);
    this.input.adsMode = nodsForceCant ? 'POINT_AIM' : baseAdsMode;
    this.input.cant = false;
    const suppBusy = this.weaponRig.isSuppressorActionActive();
    const pdaBusy = this.pdaDevice.isBlockingWeaponActions();
    const grenadeDrawn = this.grenadeSystem.isDrawn();
    if (suppBusy || pdaBusy || grenadeDrawn) {
      this.input.ads = false;
    }
    const firearmAdsBlocking =
      this.input.ads && prof.holdClass !== 'unarmed' && !grenadeDrawn;
    // Shift sprints freely with fists guard up or grenade held; aiming a firearm engages Hold Breath instead
    this.input.sprint = !suppBusy && !pdaBusy && this.shiftHeld && !firearmAdsBlocking;
    this.input.holdBreath =
      !suppBusy &&
      !pdaBusy &&
      this.input.ads &&
      prof.holdClass !== 'unarmed' &&
      (this.shiftHeld || this.altHeld);

    let isVaultingNow = false;
    if (!benchBusy) {
      this.controller.setGrenadeTension(
        this.grenadeSystem.getCharge01(),
        this.grenadeSystem.isLeverReleased(),
        this.grenadeSystem.getThrowStyle(),
      );
      // 1. Step BodycamController (physics step-up, vault/mantle, lean clearance, breathing sway, WeaponRig)
      this.controller.update(
        dt,
        this.elapsedSec,
        this.input,
        this.adapter,
        prof,
        this._runtimeConfig,
        this.stamina,
        100,
        (drain) => {
          this.stamina = Math.max(0, this.stamina - drain);
        },
      );

      const vaultBlocked = this.controller.consumeVaultBlockReason();
      if (vaultBlocked === 'dual_leg_trauma') {
        this.showToast('Both legs fractured — cannot high-mantle');
      }

      isVaultingNow = this.controller.isVaulting();
      if (isVaultingNow && !this.wasVaulting) {
        this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + 0.09, 0, 1);
        this.stillDurationSec = 0;
      }
      this.wasVaulting = isVaultingNow;

      // Update 3D Physical PDA Device before IK animator consumes wrist sockets
      this.pdaDevice.setTelemetry({
        playerX: this.controller.position.x,
        playerZ: this.controller.position.z,
        playerYawRad: this.controller.aimYaw,
        gameClockText: '12:00',
        weatherLabel: 'FACILITY',
        windSpeedMps: 0.4,
        windAngleRad: 0.6,
        modeLabel: 'PLAYGROUND',
        zoneLabel: 'TESTING PLAYGROUND',
      });
      this.controller.writePdaMotionState(this._pdaMotionScratch);
      this.pdaDevice.update(
        dt,
        this.elapsedSec,
        this._pdaMotionScratch.moveRatio,
        this._pdaMotionScratch.isCrouched,
        this._pdaMotionScratch,
      );

      // 2. Step Full-Body Procedural IK Character Animator
      this.animator.update(dt, this.elapsedSec, this.controller, this.adapter, prof, this.input.ads);
      this.animator.applyCameraAdditiveOverlay(this.camera);

      this._fpsCamPos.copy(this.camera.position);
      this._fpsCamQuat.copy(this.camera.quaternion);
      this.weaponRig.root.visible =
        !this.grenadeSystem.isWeaponHidden() && !this.pdaDevice.isWeaponHidden();
      this.skeleton.root.visible = true;

      // Bench interaction look-at raycast
      if (this.pointerLocked) {
        this.camera.getWorldDirection(this._lookDir);
        this._benchRaycaster.set(this.camera.position, this._lookDir);
        this._benchRaycaster.near = 0.05;
        this._benchRaycaster.far = 2.85;
        const hits = this._benchRaycaster.intersectObjects(this.world.raycastMeshes, false);
        this.lookingAtBench = Boolean(hits.length > 0 && hits[0].object?.userData?.isGunsmithBench);
      } else {
        this.lookingAtBench = false;
      }
    } else {
      this.controller.setGrenadeTension(0, false, 'underhand');
      if (this.pdaDevice.isOpen()) {
        this.pdaDevice.setOpen(false);
      }
      this.pdaDevice.update(dt, this.elapsedSec, 0, false);
      this.lookingAtBench = false;
      this.weaponRig.root.visible = false;
      this.skeleton.root.visible = false;
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, 50, 12, dt);
      this.camera.updateProjectionMatrix();
      this.world.gunsmithBench.updateCamera(
        dt,
        this.camera,
        this._fpsCamPos,
        this._fpsCamQuat,
      );
      this.world.gunsmithBench.projectPins(
        this.camera,
        Math.max(1, this.container.clientWidth),
        Math.max(1, this.container.clientHeight),
        this._pinBuffer,
      );
    }

    // 3. Step Real-World Ballistics, Tactical Grenades & Reactive AR500 Steel Targets
    this.ballistics.update(dt, this.adapter, (hitInfo) => {
      this.lastHit = hitInfo;
      this.emitSnapshot();
    });
    const wasLiveBefore = this.grenadeSystem.isLeverReleased();
    this.grenadeSystem.update(dt, this.camera.position);
    const launched = this.grenadeSystem.consumeLastLaunchedThrow();
    if (launched) {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      const def = getTacticalEquipmentDef(launched.equipmentId);
      const styleTag = launched.style === 'underhand' ? 'Underhand Lob' : 'Overhand Throw';
      this.showToast(`${styleTag}: ${def.shortName} (${this.grenadeCount}/${this.grenadeMax})`);
      this.emitSnapshot();
    } else if (wasLiveBefore && !this.grenadeSystem.isLeverReleased()) {
      // Over-cooked live fuse in hand!
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.emitSnapshot();
    }
    if (this.flashBlindAlpha > 0) {
      this.flashBlindAlpha = Math.max(0, this.flashBlindAlpha - dt * 0.42);
    }
    this.world.updateDynamicTargets(dt);

    // 4. Step AAA Bodycam Post-Process
    this.controller.getWhipVelocity(this._whipVel);
    this.postProcess.update(
      dt,
      this.elapsedSec,
      this._runtimeConfig,
      benchBusy ? 0 : this._whipVel.x,
      benchBusy ? 0 : this._whipVel.y,
      100,
      false,
      this.getActiveTraumaModifiers(),
      benchBusy ? 0 : this.controller.getHoldBreathVignette(),
    );

    if (!this.contextLost) {
      this._scopePassParams.dt = dt;
      this.postProcess.render();
    }

    // 5. Write zero-GC POD telemetry & throttle React UI updates (~16 Hz normal, ~60 Hz during Gunsmith orbit)
    this.controller.writeTelemetry(
      this.telemetry,
      this.postProcess.getAverageLuminance(),
      this.postProcess.getCurrentExposure(),
      this.flashlightOn,
    );

    // 6. Physiological heart rate model
    this.adrenalineStress = Math.max(0, this.adrenalineStress - 0.14 * dt);
    const moveRatio = THREE.MathUtils.clamp(this.telemetry.speedMps / 4.8, 0, 1.25);
    const isMoving = !benchBusy && (moveRatio > 0.06 || isVaultingNow);
    const holdBreathActive = !benchBusy && this.controller.isHoldBreathActive();

    const isCalmAndStill =
      !isMoving &&
      !this.controller.isSprinting &&
      moveRatio < 0.05 &&
      this.adrenalineStress < 0.08 &&
      !this.simulatedArmTrauma;
    if (isCalmAndStill) {
      this.stillDurationSec = Math.min(24, this.stillDurationSec + dt);
    } else if (this.controller.isSprinting || this.adrenalineStress > 0.15) {
      this.stillDurationSec = 0;
    } else {
      this.stillDurationSec = Math.max(0, this.stillDurationSec - dt * 2.5);
    }

    const restT = THREE.MathUtils.clamp((this.stillDurationSec - 4.0) / 14.0, 0, 1);
    const restEase = restT * restT * (3 - 2 * restT);
    const deepRestFloor = this.controller.crouched ? 69 : 71;
    const baseBpm = THREE.MathUtils.lerp(85, deepRestFloor, restEase);

    const movementLoad =
      (this.controller.isSprinting ? 30 : isMoving ? 8 : 0) + moveRatio * 12;
    const exertionLoad = this.telemetry.exertion * 32 + (1 - this.stamina) * 22;
    const stressLoad =
      this.adrenalineStress * 34 + (this.simulatedArmTrauma ? 20 : 0) + (holdBreathActive ? -5 : 0);

    const respRateHz = 0.20 + this.telemetry.exertion * 0.42 + this.adrenalineStress * 0.22;
    this.rsaPhase = (this.rsaPhase + dt * respRateHz * Math.PI * 2) % (Math.PI * 2);
    const rsaOffset = holdBreathActive ? 0 : Math.sin(this.rsaPhase) * 1.3;

    const targetBpm = THREE.MathUtils.clamp(
      baseBpm + movementLoad + exertionLoad + stressLoad + rsaOffset,
      62,
      186,
    );
    const rising = targetBpm > this.heartRateBpm;
    const hrLambda = rising ? (this.adrenalineStress > 0.35 ? 0.45 : 0.28) : 0.11;
    this.heartRateBpm = THREE.MathUtils.damp(this.heartRateBpm, targetBpm, hrLambda, dt);
    const targetStress = THREE.MathUtils.clamp(
      Math.max(
        (this.heartRateBpm - 84) / 92,
        this.adrenalineStress * 0.8,
        this.simulatedArmTrauma ? 0.48 : 0,
      ),
      0,
      1,
    );
    this.heartStress = THREE.MathUtils.damp(this.heartStress, targetStress, 1.4, dt);

    this.uiEmitTimer += dt;
    if (this.world.gunsmithBench.isOpen() || this.uiEmitTimer >= 0.062) {
      this.uiEmitTimer = 0;
      this.emitSnapshot();
    }

    this.scheduleNextFrame();
  }

  private buildSnapshot(): GymSnapshot {
    const prof = this.getWeaponProfile();
    const derived = this.weaponRig.getDerivedStats();
    const att = this.getAttachmentsFor(prof.id);
    const activeCalId = this.getActiveBaseCaliberId(prof.id);
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
    return {
      config: { ...this.config },
      telemetry: { ...this.telemetry },
      equippedWeaponId: prof.id,
      equippedWeaponName: prof.name,
      equippedCaliber: prof.caliberLabel,
      activeCaliberId: activeCalId,
      activeAmmoVariantId: activeAmmo.id,
      ammoVariantLabel: activeAmmo.shortName,
      isSubsonic: activeAmmo.isSubsonic,
      isBoltCycling: this.weaponRig.isBoltCycling(),
      fireMode: prof.fireMode,
      toggleablePumpSemi: Boolean(prof.toggleablePumpSemi),
      spas12Mode: this.spas12Mode,
      ammoInMag: this.magAmmoByWeapon[prof.id] ?? 0,
      magCapacity: prof.magCapacity,
      isReloading: this.reloadTimer > 0 || this.weaponRig.isTubularReloading(),
      laserOn: this.weaponRig.laserOn && prof.supportsLaser && derived.hasLaser,
      laserMode: this.weaponRig.laserMode,
      flashlightOn: this.flashlightOn && derived.hasFlashlight,
      suppressorAttached: derived.isSuppressed,
      simulatedArmTrauma: this.simulatedArmTrauma,
      pointerLocked: this.pointerLocked,
      tunerOpen: this.tunerOpen,
      gunsmithOpen: this.world.gunsmithBench.isOpen(),
      lookingAtBench: this.lookingAtBench,
      attachments: { ...att },
      derivedStats: { ...derived },
      gunsmithPins: this._pinBuffer.map((p) => ({ ...p })),
      fps: this.fps,
      lastHit: this.lastHit,
      toastMessage: this.toastMessage,
      recordingElapsedSec: this.recordingElapsedSec,
      heartRateBpm: Math.round(this.heartRateBpm),
      heartStress: this.heartStress,
      holdBreathActive: !this.world.gunsmithBench.isOpen() && this.controller.isHoldBreathActive(),
      isMagnifiedOptic: this.weaponRig.isMagnifiedOpticActive(),
      hasVariableZoom: this.weaponRig.hasVariableZoom(),
      activeOpticZoom: this.weaponRig.getActiveOpticZoomMult(),
      reticleIlluminated: this.weaponRig.reticleIlluminated,
      armedAdsMode: this.getArmedAdsMode(prof.id),
      hasCantedOptic: this.weaponRig.hasCantedOptic(),
      tacticalEquipmentId: this.tacticalEquipmentId,
      tacticalEquipmentName: getTacticalEquipmentDef(this.tacticalEquipmentId).name,
      tacticalEquipmentShortName: getTacticalEquipmentDef(this.tacticalEquipmentId).shortName,
      tacticalBeltSlot: this.tacticalBeltSlot,
      tacticalMountOnBelt: this.tacticalMountOnBelt,
      grenadeCount: this.grenadeCount,
      grenadeMax: this.grenadeMax,
      grenadeHoldStage: this.grenadeSystem.getHoldStage(),
      grenadeCooking: this.grenadeSystem.isCooking(),
      grenadeStatusLabel: this.grenadeSystem.getActionStatusLabel(),
      grenadeThrowStyle: this.grenadeSystem.getThrowStyle(),
      grenadeThrowHeld: this.grenadeSystem.isThrowInputHeld(),
      flashBlindAlpha: this.flashBlindAlpha,
      zeroDistanceM: att.zeroDistanceM ?? getDefaultZeroDistanceM(prof.category),
      zeroElevationMrad: att.zeroElevationMrad ?? 0,
      heightOverBoreM: this.weaponRig.getHeightOverBoreM(),
      isPdaOpen: this.pdaDevice.isOpen(),
      nvgMount: this.localGear.nvgMount,
      nvgActive: this.nvgFlipped && this.localGear.nvgMount !== 'none',
      irIlluminatorOn: this.irIlluminatorOn && this.nvgFlipped,
    };
  }

  private emitSnapshot(): void {
    const snap = this.buildSnapshot();
    this.listeners.forEach((fn) => fn(snap));
  }

  public dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.swTimerId !== null) clearTimeout(this.swTimerId);
    this.unbindEvents();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.unsubTacticalEquipment();
    this.unsubOperatorGear();
    this.camera.remove(this.irIlluminatorLight, this.irIlluminatorTarget);
    this.pdaDevice.dispose();
    this.grenadeSystem.dispose();
    this.ballistics.dispose();
    this.scopeRenderer.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
    this.postProcess.dispose();
    this.world.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }
}

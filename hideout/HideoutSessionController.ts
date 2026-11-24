import * as THREE from 'three';
import {
  AdsMode,
  BallisticImpactEvent,
  BallisticsSolver,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamPostProcess,
  BodycamRaycastResult,
  BodycamSDKConfig,
  BodycamTelemetry,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  createBodycamTelemetry,
  createPdaMotionState,
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  GrenadeDetonationEvent,
  GrenadeHoldStage,
  IBodycamWorldAdapter,
  operatorAssetLoader,
  OperatorGearConfig,
  OperatorId,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  SDK_WEAPON_PROFILES,
  solveZeroPitchRad,
  TacticalGrenadeSystem,
  tacticalEquipmentStore,
  TacticalPdaDevice,
  type PdaHudTelemetry,
  type PdaPingMarker,
  VIEWMODEL_LAYER,
  WeaponRig,
} from '../bodycam-sdk';
import {
  computeDerivedWeaponStats,
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  getAmmoVariantsForCaliber,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../data/calibers';
import { AdaptivePerformanceController, graphicsQualityStore } from '../data/graphicsQuality';
import { loadoutStore } from '../data/loadoutStore';
import {
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  getTacticalEquipmentDef,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { DoorInteractOptionId } from '../doors/DestructibleDoorSystem';
import { PlayerInteractAnimator } from '../doors/PlayerInteractAnimator';
import { GunWallSwapChoreography } from './GunWallSwapChoreography';
import {
  buildHideoutBunkerWorld,
  HideoutBunkerWorldHandle,
  HideoutInteractableMeta,
  HideoutRoomId,
  resolveHideoutRoom,
} from './HideoutBunkerWorld';
import { GunRangeSnapshot } from './HideoutGunRange';
import { LongRangeSnapshot } from './HideoutLongRangeGallery';
import { OpsLaptopTabId } from './HideoutOpsLaptopModal';
import { ReadyRoomBriefingState } from './HideoutReadyRoom';
import { hideoutStateStore } from './HideoutStateStore';
import { hideoutShardAdapter } from '../src/modes/openworld/HideoutShardAdapter';

export type InteractReticleState = 'hidden' | 'near' | 'ready';

export interface HideoutPromptOption {
  id: string;
  label: string;
  hint?: string;
}

export interface HideoutPromptState {
  key: 'F' | 'E';
  targetLabel?: string;
  options: HideoutPromptOption[];
  selectedIndex: number;
}

type ActiveInteractTarget =
  | { source: 'prop'; meta: HideoutInteractableMeta; keyId: string }
  | { source: 'door'; doorId: string; keyId: string };

export interface HideoutSnapshot {
  pointerLocked: boolean;
  pauseOpen: boolean;
  currentRoomId: HideoutRoomId;
  currentRoomLabel: string;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  activeAmmoLabel: string;
  zeroDistanceM: number;
  hasVariableZoom: boolean;
  activeOpticZoom: number;
  armedAdsMode: AdsMode;
  fireModeLabel: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  grenadeDrawn: boolean;
  grenadeHoldStage: GrenadeHoldStage;
  grenadeName: string;
  grenadeCount: number;
  nvgActive: boolean;
  irActive: boolean;
  isPdaOpen: boolean;
  isSwappingGunWall: boolean;
  interactReticleState: InteractReticleState;
  prompt: HideoutPromptState | null;
  toastMessage: string | null;
  fps: number;
  masterVolume: number;
  gunRange: GunRangeSnapshot;
  longRange: LongRangeSnapshot;
}

const HIDEOUT_PDA_MARKERS: readonly PdaPingMarker[] = [
  { x: 0, z: 0, label: 'ARSENAL', kind: 'poi' },
  { x: -11.5, z: 0, label: 'READY ROOM', kind: 'poi' },
  { x: 0, z: 9.5, label: 'SECTOR 4', kind: 'danger' },
  { x: 10.7, z: 14, label: 'BAY 1 · BALLISTICS', kind: 'poi' },
  { x: 19.2, z: 16, label: 'BAY 2 · CQB', kind: 'poi' },
  { x: 29.0, z: 28.2, label: '25M', kind: 'order' },
  { x: 29.0, z: 53.2, label: '50M', kind: 'order' },
  { x: 29.0, z: 78.2, label: '75M', kind: 'order' },
  { x: 29.0, z: 103.2, label: '100M', kind: 'order' },
];

export interface HideoutControllerCallbacks {
  isWeaponUnlocked: (weaponId: string) => boolean;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onOpenOpsLaptop: (initialTab?: OpsLaptopTabId) => void;
  onQuickDeployBattle: () => void;
  onCycleStagedMap: () => string;
  onEnterZombiesOutpost?: () => void;
  initialSpawnZone?: 'arsenal' | 'airlock_return';
}

type HideoutListener = (snap: HideoutSnapshot) => void;

/**
 * Decoupled 60+ FPS First-Person 3D Hideout Session Controller (Phase 1).
 * Isolated cleanly from CombatSessionEngine & GymEngine—never ticks combat AI,
 * outdoor weather, or distant match loops.
 */
export class HideoutSessionController {
  private readonly container: HTMLElement;
  private readonly callbacks: HideoutControllerCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly world: HideoutBunkerWorldHandle;
  private readonly adapter: IBodycamWorldAdapter;
  private readonly ballistics: BallisticsSolver;
  private readonly audio: BodycamAudio;
  private readonly weaponRig: WeaponRig;
  private skeleton: CharacterSkeleton;
  private currentOperatorId: OperatorId;
  private readonly maxAniso: number;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly postProcess: BodycamPostProcess;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly swapChoreography: GunWallSwapChoreography;
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private readonly pdaDevice: TacticalPdaDevice;
  private readonly _pdaMotionScratch = createPdaMotionState();
  private readonly _pdaTelemetryScratch: PdaHudTelemetry = {
    playerX: 0,
    playerZ: 0,
    playerYawRad: 0,
    gameClockText: '12:00',
    weatherLabel: 'BUNKER',
    windSpeedMps: 0.0,
    windAngleRad: 0.0,
    modeLabel: 'HIDEOUT',
    zoneLabel: 'ARSENAL ROOM',
    pings: HIDEOUT_PDA_MARKERS,
  };
  private readonly irIlluminatorLight: THREE.SpotLight;
  private readonly irIlluminatorTarget: THREE.Object3D;
  private readonly interactAnimator = new PlayerInteractAnimator();
  private readonly unsubOperatorId: () => void;
  private readonly unsubOperatorGear: () => void;
  private readonly unsubLoadout: () => void;
  private readonly unsubOpenWorld: () => void;

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

  private localGear: OperatorGearConfig;
  private equippedWeaponId = 'm4a1';
  private magAmmoByWeapon: Record<string, number> = {};
  private fireModeOverrideByWeapon: Record<string, 'auto' | 'semi'> = {};
  private adsModeByWeapon: Record<string, AdsMode> = {};
  private tacticalEquipmentId: TacticalEquipmentId = DEFAULT_TACTICAL_EQUIPMENT_ID;
  private grenadeCount = 2;
  private nvgFlipped = false;
  private irIlluminatorOn = false;
  private isFiring = false;
  private semiTriggerConsumed = false;
  private fireCooldown = 0;
  private reloadTimer = 0;
  private pendingReloadWeaponId: string | null = null;
  private pointerLocked = false;
  private pauseOpen = false;
  private modalActive = false;
  private contextLost = false;
  private disposed = false;

  private shiftHeld = false;
  private currentRoomId: HideoutRoomId = 'arsenal';
  private currentRoomLabel = 'Arsenal Room';
  private activeTarget: ActiveInteractTarget | null = null;
  private activePrompt: HideoutPromptState | null = null;
  private selectedOptionIndex = 0;
  private lastTargetKeyId = '';
  private interactReticleState: InteractReticleState = 'hidden';
  private toastMessage: string | null = null;
  private toastTimeout: number | null = null;

  private rafId = 0;
  private softwareTimerId = 0;
  private lastFrameMs = 0;
  private elapsedSec = 0;
  private fpsAccumSec = 0;
  private fpsFrames = 0;
  private currentFps = 60;
  private lastEmitMs = 0;
  private airlockTransitionActive = false;
  private airlockPressurizationSec = 0;
  private airlockReturnCooldownSec = 0;
  private airlockDeconTimeout: number | null = null;
  private readonly baseCameraFov = 72;

  private readonly listeners = new Set<HideoutListener>();

  // Zero-GC scratch buffers
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _occlRayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _lookDir = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _whipVel = new THREE.Vector2();
  private readonly _slotPos = new THREE.Vector3();
  private readonly _slotQuat = new THREE.Quaternion();
  private readonly _startWeaponPos = new THREE.Vector3();
  private readonly _startWeaponQuat = new THREE.Quaternion();
  private readonly _ikTargetPos = new THREE.Vector3();
  private readonly _velScratch = new THREE.Vector3();
  private readonly _scanObjects: THREE.Object3D[] = [];
  private readonly _runtimeProfile: BodycamWeaponProfile;
  private readonly _scopePassParams: ScopePassParams;
  private readonly adaptivePerf: AdaptivePerformanceController;
  private unsubAdaptiveScaling: (() => void) | null = null;

  constructor(container: HTMLElement, callbacks: HideoutControllerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.isSoftwareGl = (() => {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return true;
      const ext = probe.getExtension('WEBGL_debug_renderer_info');
      const gpu = String(probe.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER));
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    const gfx = graphicsQualityStore.getProfile();
    this.adaptivePerf = new AdaptivePerformanceController(gfx);
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, gfx.maxDpr),
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && gfx.castShadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // Handled in BodycamPostProcess
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.08, 185);
    this.scene.add(this.camera);

    // Build 4-room Cold-War bunker shell, Arsenal Room, Gun Range Phase 2, 100m Gallery Phase 3 & doors
    this.world = buildHideoutBunkerWorld(
      this.scene,
      this.renderer,
      this.isSoftwareGl,
      {
        onCourseComplete: (res) => {
          const storedNewBest = hideoutStateStore.recordGunRangeRun(
            res.score,
            res.hits,
            res.accuracyPct,
          );
          this.world.gunRange.setBestScore(hideoutStateStore.getState().gunRangeBestScore);
          const headline =
            storedNewBest || res.isNewBest ? 'New Record' : 'Course Complete';
          this.showToast(
            `${headline}: ${res.score} pts · ${res.hits} hits (${res.accuracyPct}%)`,
          );
          this.emitSnapshot(true);
        },
      },
      {
        on100mRecord: (info) => {
          const isNewBest = hideoutStateStore.recordLongRangeHit(info.groupMoa);
          if (isNewBest && info.groupMoa !== null) {
            this.showToast(`New 100m Group Record: ${info.groupMoa.toFixed(2)} MOA`);
          }
          this.emitSnapshot(true);
        },
      },
    );
    this.world.doorSystem.setAudioVolume(this.config.masterVolume);
    this.world.gunRange.setAudioVolume(this.config.masterVolume);
    this.world.longRangeGallery.setAudioVolume(this.config.masterVolume);
    this.world.electronics.setAudioVolume(this.config.masterVolume);
    this.ballistics = new BallisticsSolver(this.scene);

    this.adapter = this.world.physics.createAdapter({
      onMeleeHit: (ev) => {
        const doorId = ev.object?.userData?.destructibleDoorId as string | undefined;
        if (doorId) {
          if (ev.attackType === 'kick') {
            this.controller.getVelocity(this._velScratch);
            const horizSpeed = Math.hypot(this._velScratch.x, this._velScratch.z);
            this.world.doorSystem.executeKick(
              doorId,
              ev.direction,
              horizSpeed,
              this.controller.isSprinting,
              undefined,
              false,
              undefined,
              ev.point,
              ev.object,
            );
          } else {
            this.world.doorSystem.applyMeleeBash(
              doorId,
              ev.point,
              ev.direction,
              undefined,
              false,
              ev.object,
              ev.attackType,
            );
          }
          return;
        }
        const penSurfaceId = ev.object?.userData?.penetrableSurfaceId as string | undefined;
        if (penSurfaceId) {
          this.world.penetrableSystem.applyMeleeImpact(
            penSurfaceId,
            ev.point,
            ev.direction,
            ev.attackType,
          );
          return;
        }
        // Check destructible bunker electronics (consoles, monitors, chronograph, lights, strobes)
        const elecHit = this.world.electronics.handleImpact(
          ev.object,
          ev.point,
          ev.normal,
          this._camPos,
        );
        if (elecHit) {
          if (!elecHit.alreadyBroken) {
            this.showToast(`${elecHit.label} Damaged`);
          }
          this.emitSnapshot(true);
          return;
        }
        // Allow kicking/bashing/punching reactive range targets or the start paddle up close
        const meleeMassG =
          ev.attackType === 'kick' ? 950 : ev.attackType === 'bash' ? 680 : ev.attackType === 'cross' ? 520 : 380;
        const meleeSpeedMs =
          ev.attackType === 'kick' ? 14 : ev.attackType === 'cross' ? 11 : 9;
        const meleeAmmo = {
          ...getDefaultAmmoVariant('9x19'),
          bulletMassGrams: meleeMassG,
        };
        if (ev.object?.userData?.hideoutRangeTarget) {
          const rangeHit = this.world.gunRange.handleBallisticImpact(
            {
              outcome: 'stop',
              ammo: meleeAmmo,
              weaponId: this.equippedWeaponId,
              material: 'steel',
              surface: 'metal',
              object: ev.object,
              point: ev.point,
              normal: ev.normal,
              incomingDir: ev.direction,
              outgoingDir: ev.direction,
              impactSpeedMs: meleeSpeedMs,
              impactEnergyJ: ev.damageEnergyJ,
              grazingAngleDeg: 90,
              distanceM: 1,
              isFragment: false,
              bounceIndex: 0,
              exitPoint: ev.point,
              penetrationThicknessM: 0,
            },
            this._camPos,
          );
          if (rangeHit) {
            this.audio.playImpact(ev.point, rangeHit.isSteel ? 'steel_plate' : 'paper');
            this.emitSnapshot(true);
          }
          return;
        }
        if (ev.object?.userData?.hideoutLongRangeTarget) {
          const lrHit = this.world.longRangeGallery.handleBallisticImpact(
            {
              outcome: 'stop',
              ammo: meleeAmmo,
              weaponId: this.equippedWeaponId,
              material: 'steel',
              surface: 'metal',
              object: ev.object,
              point: ev.point,
              normal: ev.normal,
              incomingDir: ev.direction,
              outgoingDir: ev.direction,
              impactSpeedMs: meleeSpeedMs,
              impactEnergyJ: ev.damageEnergyJ,
              grazingAngleDeg: 90,
              distanceM: 1,
              isFragment: false,
              bounceIndex: 0,
              exitPoint: ev.point,
              penetrationThicknessM: 0,
            },
            this._camPos,
          );
          if (lrHit) {
            this.audio.playImpact(ev.point, lrHit.isSteel ? 'steel_plate' : 'paper');
            this.emitSnapshot(true);
          }
        }
      },
    });

    // Audio, WeaponRig, 1P Operator Skeleton, Animator, BodycamController
    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.audio.setInteriorAcoustics(true, 'concrete');

    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    hideoutShardAdapter.syncOperatorRigFromActiveCharacter(true);
    this.localGear = operatorSelectionStore.getGearConfig();
    this.currentOperatorId = operatorSelectionStore.getSelectedOperator();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      this.currentOperatorId,
      {
        maxAnisotropy: this.maxAniso,
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

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);
    this.pdaDevice = new TacticalPdaDevice(this.audio);
    this.camera.add(this.pdaDevice.root);
    this.animator.setPdaDevice(this.pdaDevice);

    // IR illuminator spotlight attached to helmet/camera when NVG + IR Flood active
    this.irIlluminatorTarget = new THREE.Object3D();
    this.irIlluminatorTarget.position.set(0, 0, -10);
    this.camera.add(this.irIlluminatorTarget);
    this.irIlluminatorLight = new THREE.SpotLight(0xd8ffd8, 7.5, 42, Math.PI * 0.28, 0.55, 1.25);
    this.irIlluminatorLight.position.set(0.06, 0.04, 0);
    this.irIlluminatorLight.target = this.irIlluminatorTarget;
    this.irIlluminatorLight.visible = false;
    this.camera.add(this.irIlluminatorLight);

    // Tactical Equipment / Grenade System (slot [4] / [H])
    const activeLoadout = loadoutStore.getActiveSlot();
    const initialEquip = tacticalEquipmentStore.getSelection();
    this.tacticalEquipmentId = activeLoadout.tacticalEquipmentId ?? initialEquip.equipmentId;
    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
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
      onDetonate: (ev) => this.handleGrenadeDetonation(ev),
      onInHandDetonate: (ev) => this.handleGrenadeDetonation(ev, true),
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);
    this.syncBeltEquipmentMesh();

    // Spawn player either in Arsenal Room facing Gun Wall (-Z) or returning from Bio-Containment Airlock
    if (callbacks.initialSpawnZone === 'airlock_return') {
      this.controller.position.set(0, 0, 7.25);
      this.controller.torsoYaw = 0;
      this.controller.aimYaw = 0;
      this.controller.torsoPitch = 0;
      this.controller.aimPitch = 0;
      this.airlockReturnCooldownSec = 2.6;
      this.currentRoomId = 'zombies_portal';
      this.currentRoomLabel = 'Sector 4 · Bio-Containment Airlock';
    } else {
      this.controller.position.set(0, 0, 1.95);
      this.controller.torsoYaw = 0;
      this.controller.aimYaw = 0;
      this.controller.torsoPitch = 0;
      this.controller.aimPitch = 0;
    }

    this.postProcess = new BodycamPostProcess(
      this.renderer,
      this.scene,
      this.camera,
      this.isSoftwareGl,
    );
    this.scopeRenderer = new ScopeRenderer(this.isSoftwareGl, 512);
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
      if (this.contextLost || !this.weaponRig.root.visible) return;
      const rigState = this.weaponRig.getReadOnlyRigState();
      const sp = this._scopePassParams;
      sp.assembly = this.weaponRig.getModelAssembly();
      sp.isMagnifiedOptic = this.weaponRig.isMagnifiedOpticActive();
      sp.zoomMult = this.weaponRig.getActiveOpticZoomMult();
      sp.adsBlend = rigState.adsBlend;
      sp.cantBlend = rigState.cantBlend;
      sp.opticParallaxStrength = this.config.opticParallaxStrength ?? 1.0;
      sp.reticleIlluminated = this.weaponRig.reticleIlluminated;
      sp.flashlightOn = this.weaponRig.flashlight.intensity > 0.1;
      sp.sightMisalignYaw = rigState.sightMisalignYaw;
      sp.sightMisalignPitch = rigState.sightMisalignPitch;
      sp.elapsed = this.elapsedSec;
      sp.mainAvgLuminance = this.postProcess.getAverageLuminance();
      this.scopeRenderer.renderScopePass(sp);
    });

    this.swapChoreography = new GunWallSwapChoreography(this.scene, this.audio);

    this._runtimeProfile = {
      ...SDK_WEAPON_PROFILES.m4a1,
      hipOffset: [...SDK_WEAPON_PROFILES.m4a1.hipOffset],
      adsOffset: [...SDK_WEAPON_PROFILES.m4a1.adsOffset],
      cantOffset: [...SDK_WEAPON_PROFILES.m4a1.cantOffset],
      lowReadyOffset: [...SDK_WEAPON_PROFILES.m4a1.lowReadyOffset],
      lowReadyRotation: [...SDK_WEAPON_PROFILES.m4a1.lowReadyRotation],
      rightHandSocket: {
        position: [...SDK_WEAPON_PROFILES.m4a1.rightHandSocket.position],
        rotation: [...SDK_WEAPON_PROFILES.m4a1.rightHandSocket.rotation],
        gripCurl: SDK_WEAPON_PROFILES.m4a1.rightHandSocket.gripCurl,
      },
      leftHandSocket: SDK_WEAPON_PROFILES.m4a1.leftHandSocket
        ? {
            position: [...SDK_WEAPON_PROFILES.m4a1.leftHandSocket.position],
            rotation: [...SDK_WEAPON_PROFILES.m4a1.leftHandSocket.rotation],
            gripCurl: SDK_WEAPON_PROFILES.m4a1.leftHandSocket.gripCurl,
          }
        : undefined,
      muzzleOffset: [...SDK_WEAPON_PROFILES.m4a1.muzzleOffset],
      laserOffset: [...SDK_WEAPON_PROFILES.m4a1.laserOffset],
    };

    // Sync Gun Wall strictly with active character (or classic career) owned weapons
    this.syncOwnedWeapons();
    this.refreshPdaOpenWorldOverlay();

    // Live M/F skeleton hot-swap when operator body type changes (e.g., switching roster slots)
    this.unsubOperatorId = operatorSelectionStore.subscribe((nextOpId) => {
      if (nextOpId === this.currentOperatorId || this.disposed) return;
      this.rebuildOperatorSkeleton(nextOpId);
    });

    // Live updates when operator gear or Gunsmith attachments change
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
    });

    this.unsubLoadout = loadoutStore.subscribe(() => {
      const slot = loadoutStore.getActiveSlot();
      if (slot.tacticalEquipmentId !== this.tacticalEquipmentId) {
        this.tacticalEquipmentId = slot.tacticalEquipmentId;
        this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
        this.syncBeltEquipmentMesh();
      }
      // Refresh currently held weapon attachments & Gun Wall mounted builds live
      if (!this.swapChoreography.isActive()) {
        this.applyEquippedWeaponRig(this.equippedWeaponId, false);
        this.world.syncGunWallSlots(hideoutShardAdapter.getWallRackSlots());
        this.emitSnapshot(true);
      }
    });

    // Live updates when Perimeter Ops character roster, Arsenal Wall, or Bankruptcy status changes
    this.unsubOpenWorld = hideoutShardAdapter.subscribe(() => {
      if (this.disposed) return;
      this.refreshPdaOpenWorldOverlay();
      if (!this.swapChoreography.isActive()) {
        this.syncOwnedWeapons();
      }
    });

    this.bindEvents();

    this.pdaDevice.captureOrthographicMap({
      renderer: this.renderer,
      scene: this.scene,
      bounds: { minX: -20, maxX: 36, minZ: -14, maxZ: 110 },
      excludeObjects: [this.skeleton.root, this.weaponRig.root, this.pdaDevice.root],
    });

    if (!this.isSoftwareGl) {
      this.grenadeSystem.prewarm(
        this.renderer,
        this.scene,
        this.camera,
        this.skeleton.throwHandSocket,
        VIEWMODEL_LAYER,
      );
      this.renderer.compile(this.scene, this.camera);
    }

    this.unsubAdaptiveScaling = graphicsQualityStore.subscribeAdaptiveScaling((enabled) => {
      if (!enabled && !this.isSoftwareGl) {
        this.adaptivePerf.reset(graphicsQualityStore.getProfile());
        this.applyGraphicsQuality();
      }
    });

    this.lastFrameMs = performance.now();
    this.emitSnapshot(true);
    this.scheduleNextFrame();
  }

  private rebuildOperatorSkeleton(nextOpId: OperatorId): void {
    const oldSkeleton = this.skeleton;
    this.scene.remove(oldSkeleton.root);
    oldSkeleton.dispose();

    this.currentOperatorId = nextOpId;
    this.localGear = operatorSelectionStore.getGearConfig();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(nextOpId, {
      maxAnisotropy: this.maxAniso,
      uniformId: this.localGear.uniformId,
      gear: this.localGear,
      previewMode: false,
      validationMode: 'SAFE_FALLBACK',
    });
    this.skeleton = loadedOp.skeleton;
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.scene.add(this.skeleton.root);
    this.animator.setSkeleton(this.skeleton);
    this.syncBeltEquipmentMesh();
    this.syncNvgRuntime();
  }

  private refreshPdaOpenWorldOverlay(): void {
    const ov = hideoutShardAdapter.getPdaTelemetryOverlay();
    const t = this._pdaTelemetryScratch;
    if (ov.active) {
      t.modeLabel = `PERIMETER · ${ov.shardLabel ?? 'OW'}`;
      t.characterCallsign = ov.characterCallsign;
      t.shardLabel = ov.shardLabel;
      t.factionLabel = ov.factionLabel;
      t.cashUsd = ov.cashUsd;
      t.respawnFeeUsd = ov.respawnFeeUsd;
      t.bankruptcyWarning = ov.bankruptcyWarning;
      t.bankruptcyText = ov.bankruptcyText;
    } else {
      t.modeLabel = 'HIDEOUT';
      t.characterCallsign = undefined;
      t.shardLabel = undefined;
      t.factionLabel = undefined;
      t.cashUsd = undefined;
      t.respawnFeeUsd = undefined;
      t.bankruptcyWarning = false;
      t.bankruptcyText = undefined;
    }
  }

  public syncOwnedWeapons(): void {
    const nextState = hideoutShardAdapter.syncOwnedWeapons(this.callbacks.isWeaponUnlocked);
    this.world.syncGunWallSlots(nextState.wallRackSlots);
    this.applyEquippedWeaponRig(nextState.equippedWeaponId, false);
    this.emitSnapshot(true);
  }

  public syncOpsBriefing(state: ReadyRoomBriefingState): void {
    this.world.readyRoom.setBriefingState(state);
  }

  public setModalActive(open: boolean): void {
    this.modalActive = open;
    if (open) {
      this.clearMovementInputs();
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
    }
    this.emitSnapshot(true);
  }

  public setPauseOpen(open: boolean): void {
    this.pauseOpen = open;
    if (open) {
      this.clearMovementInputs();
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
    }
    this.emitSnapshot(true);
  }

  public requestPointerLock(): void {
    if (this.modalActive) return;
    this.pauseOpen = false;
    this.audio.ensureInitialized();
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
        // Ignore synchronous browser gesture rejections
      }
    }
    this.emitSnapshot(true);
  }

  public setMasterVolume(volume: number): void {
    const clamped = THREE.MathUtils.clamp(volume, 0, 1);
    this.config = { ...this.config, masterVolume: clamped };
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.world.doorSystem.setAudioVolume(clamped);
    this.world.gunRange.setAudioVolume(clamped);
    this.world.longRangeGallery.setAudioVolume(clamped);
    this.world.electronics.setAudioVolume(clamped);
    this.emitSnapshot(true);
  }

  public applyGraphicsQuality(): void {
    const gfx = graphicsQualityStore.getProfile();
    this.adaptivePerf.syncProfile(gfx);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, gfx.maxDpr),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && gfx.castShadows;
    this.onResize();
  }

  public subscribe(fn: HideoutListener): () => void {
    this.listeners.add(fn);
    fn(this.buildSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private getWeaponProfile(weaponId = this.equippedWeaponId): BodycamWeaponProfile {
    const base = resolveWeaponProfile(weaponId);
    const build = loadoutStore.getActiveWeaponBuild(base.id);
    const derived = computeDerivedWeaponStats(
      base.massKg,
      base.barrelLengthM,
      base.spreadMOA,
      build.attachments,
    );
    const rp = this._runtimeProfile;
    Object.assign(rp, base);
    rp.massKg = derived.totalMassKg;
    rp.barrelLengthM = derived.barrelLengthM;
    return rp;
  }

  private applyEquippedWeaponRig(weaponId: string, playCue = true): void {
    this.equippedWeaponId = weaponId;
    this.reloadTimer = 0;
    this.pendingReloadWeaponId = null;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    const profile = resolveWeaponProfile(weaponId);
    const attachments: WeaponAttachments =
      weaponId === 'unarmed'
        ? {}
        : normalizeWeaponAttachments(profile.id, loadoutStore.getActiveWeaponBuild(profile.id).attachments);
    this.weaponRig.setWeaponProfile(profile, attachments);
    this.weaponRig.root.visible = !this.swapChoreography.isActive();

    if (weaponId === 'unarmed') {
      this.input.adsMode = 'PRIMARY';
    } else {
      // Validate armed aim mode if canted optic was removed at Gunsmith
      if (this.adsModeByWeapon[profile.id] === 'CANTED' && !this.weaponRig.hasCantedOptic()) {
        this.adsModeByWeapon[profile.id] = 'PRIMARY';
      }
      this.input.adsMode = this.getArmedAdsMode(profile.id);
    }

    if (weaponId !== 'unarmed' && this.magAmmoByWeapon[profile.id] === undefined) {
      this.magAmmoByWeapon[profile.id] = profile.magCapacity;
    }
    const curMag = weaponId === 'unarmed' ? 0 : (this.magAmmoByWeapon[profile.id] ?? profile.magCapacity);
    this.weaponRig.setAmmoState(curMag, weaponId !== 'unarmed');
    this.syncWeaponBallistics();
    if (playCue) {
      this.audio.playGearRattle('weapon_swap', 0.5);
    }
  }

  private getArmedAdsMode(weaponId = this.equippedWeaponId): AdsMode {
    if (weaponId === 'unarmed') return 'PRIMARY';
    const stored = this.adsModeByWeapon[weaponId] ?? 'PRIMARY';
    if (stored === 'CANTED' && !this.weaponRig.hasCantedOptic()) {
      this.adsModeByWeapon[weaponId] = 'PRIMARY';
      return 'PRIMARY';
    }
    return stored;
  }

  private cycleAimMode(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      this.grenadeSystem.isDrawn() ||
      this.weaponRig.isSuppressorActionActive()
    ) {
      return;
    }
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const hasCanted = this.weaponRig.hasCantedOptic();
    const order: AdsMode[] = hasCanted ? ['PRIMARY', 'CANTED', 'POINT_AIM'] : ['PRIMARY', 'POINT_AIM'];
    const cur = this.getArmedAdsMode(prof.id);
    const curIdx = order.indexOf(cur);
    const next = order[(curIdx + 1) % order.length];
    this.adsModeByWeapon[prof.id] = next;
    this.input.adsMode = next;
    this.audio.playTacticalSwitchClick(next !== 'PRIMARY');
    const label =
      next === 'POINT_AIM'
        ? 'Point Aim Armed (RMB)'
        : next === 'CANTED'
          ? 'Canted Optic Armed (RMB)'
          : 'Primary Optic ADS (RMB)';
    this.showToast(label);
    this.emitSnapshot(true);
  }

  private equipHideoutSlot(slot: 1 | 2 | 3): void {
    if (this.swapChoreography.isActive() || this.weaponRig.isSuppressorActionActive()) return;
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
    }
    let nextId = 'unarmed';
    if (slot === 1) {
      const loadout = loadoutStore.getActiveSlot();
      const classicId = this.callbacks.isWeaponUnlocked(loadout.primaryWeaponId)
        ? loadout.primaryWeaponId
        : 'm4a1';
      nextId = hideoutShardAdapter.resolveQuickSlotWeaponId(1, classicId);
    } else if (slot === 2) {
      const loadout = loadoutStore.getActiveSlot();
      const classicId = this.callbacks.isWeaponUnlocked(loadout.secondaryWeaponId)
        ? loadout.secondaryWeaponId
        : 'glock_17';
      nextId = hideoutShardAdapter.resolveQuickSlotWeaponId(2, classicId);
    }
    if (nextId === this.equippedWeaponId) return;
    this.input.ads = false;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    const nextRack = hideoutShardAdapter.setEquippedWeaponDirect(nextId);
    this.world.syncGunWallSlots(nextRack);
    this.applyEquippedWeaponRig(nextId, true);
    const prof = resolveWeaponProfile(nextId);
    this.showToast(nextId === 'unarmed' ? 'Unarmed (Fists)' : `Equipped ${prof.name}`);
    this.emitSnapshot(true);
  }

  private syncBeltEquipmentMesh(): void {
    const sel = tacticalEquipmentStore.getSelection();
    this.skeleton.setBeltEquipment(
      this.tacticalEquipmentId,
      sel.beltSlot,
      this.grenadeCount,
      sel.mountOnBelt,
    );
  }

  private handleGrenadeHolsterOrToss(): void {
    if (!this.grenadeSystem.isDrawn()) return;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._lookDir).normalize();
    const outcome = this.grenadeSystem.holsterOrTossOnSwitch(this._camPos, this._lookDir);
    if (outcome === 'tossed') {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.showToast('Live Grenade Tossed Clear');
    } else if (outcome === 'holstered') {
      this.showToast('Ordnance Holstered');
    }
  }

  private drawOrHolsterGrenade(): void {
    if (this.swapChoreography.isActive() || this.weaponRig.isSuppressorActionActive()) return;
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
      this.emitSnapshot(true);
      return;
    }
    if (this.grenadeCount <= 0) {
      this.showToast('No Ordnance Remaining — Resupply at Ammo Box');
      return;
    }
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = 0;
    this.pendingReloadWeaponId = null;
    if (this.weaponRig.isTubularReloading()) {
      this.weaponRig.interruptTubularReload();
    }
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    this.grenadeSystem.drawGrenade(def.id);
    this.audio.playGearRattle('weapon_swap', 0.55);
    this.showToast(`${def.shortName} Ready · [RMB] Pin/Spoon · [LMB] Throw`);
    this.emitSnapshot(true);
  }

  private handleGrenadeDetonation(ev: GrenadeDetonationEvent, _inHand = false): void {
    this.camera.getWorldPosition(this._camPos);
    const dist = this._camPos.distanceTo(ev.position);
    if (dist < 14) {
      const shake = THREE.MathUtils.clamp(1 - dist / 14, 0.15, 1.0);
      this.controller.applyRecoil(0.055 * shake, (Math.random() - 0.5) * 0.05 * shake, 0.02, 0.5);
    }
    if (ev.kind === 'flash' && dist < 16) {
      this.postProcess.triggerNvgFlashSpike(1.2);
    } else if (dist < 12) {
      this.postProcess.triggerNvgFlashSpike(0.65);
    }
    // Blast shatters all Hideout electronic props & overhead lights within 6.5m
    const broken = this.world.electronics.handleExplosion(ev.position, 6.5, this._camPos);
    if (broken.length > 0) {
      this.showToast(
        broken.length === 1
          ? `${broken[0].label} Destroyed`
          : `${broken.length} Electronic Fixtures Destroyed`,
      );
    }
    this.emitSnapshot(true);
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
    if (this.localGear.nvgMount === 'none') {
      this.showToast('No NVG Mounted — Equip NVG in Operator Gear Locker');
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
    this.emitSnapshot(true);
  }

  private toggleIrOrReticle(): void {
    if (this.nvgFlipped && this.localGear.nvgMount !== 'none') {
      this.irIlluminatorOn = !this.irIlluminatorOn;
      this.audio.playIrIlluminatorClick(this.irIlluminatorOn);
      this.syncNvgRuntime();
      this.showToast(this.irIlluminatorOn ? 'IR Illuminator + IR Laser: ON' : 'IR Illuminator: OFF');
      this.emitSnapshot(true);
      return;
    }
    if (this.equippedWeaponId !== 'unarmed') {
      this.weaponRig.toggleReticleIllumination();
      this.audio.playTacticalSwitchClick(this.weaponRig.reticleIlluminated);
      this.showToast(
        this.weaponRig.reticleIlluminated ? 'Optic Reticle Illumination: ON' : 'Optic Reticle Illumination: OFF',
      );
      this.emitSnapshot(true);
    }
  }

  private toggleSuppressor(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      this.grenadeSystem.isDrawn() ||
      this.reloadTimer > 0 ||
      this.weaponRig.isTubularReloading()
    ) {
      return;
    }
    const weaponId = this.equippedWeaponId;
    const res = this.weaponRig.triggerFieldSuppressorToggle((nowAttached) => {
      if (this.equippedWeaponId !== weaponId) return;
      this.syncWeaponBallistics();
      this.showToast(nowAttached ? 'Suppressor Attached' : 'Suppressor Stowed');
      this.emitSnapshot(true);
    });
    if (res === 'no_suppressor') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    if (res === 'busy') return;
    this.isFiring = false;
    this.input.ads = false;
    this.showToast(res === 'started_attach' ? 'Attaching Suppressor...' : 'Stowing Suppressor...');
    this.emitSnapshot(true);
  }

  private getActiveBaseCaliberId(weaponId = this.equippedWeaponId): string {
    const base = resolveWeaponProfile(weaponId);
    const derived = this.weaponRig.getDerivedStats();
    if (weaponId === this.equippedWeaponId && derived.caliberOverride) {
      return resolveBaseCaliberId(derived.caliberOverride);
    }
    return resolveBaseCaliberId(base.defaultCaliberId);
  }

  private getActiveAmmoVariant(weaponId = this.equippedWeaponId): AmmoVariantDef {
    const calId = this.getActiveBaseCaliberId(weaponId);
    const stored = hideoutShardAdapter.getAmmoVariantId(weaponId) as AmmoVariantId | undefined;
    if (stored && AMMO_VARIANTS[stored]?.caliberId === calId) {
      return AMMO_VARIANTS[stored];
    }
    return getDefaultAmmoVariant(calId);
  }

  private getZeroDistanceForWeapon(weaponId = this.equippedWeaponId): number {
    if (weaponId === 'unarmed') return 100;
    const base = resolveWeaponProfile(weaponId);
    const stored = hideoutShardAdapter.getZeroDistance(base.id);
    if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
    const att = loadoutStore.getActiveWeaponBuild(base.id).attachments;
    return att.zeroDistanceM ?? getDefaultZeroDistanceM(base.category);
  }

  private syncWeaponBallistics(): void {
    if (this.equippedWeaponId === 'unarmed') {
      this.weaponRig.setZeroConfig(100, 0, 0);
      this.world.longRangeGallery.setWeaponBallisticsContext('Unarmed', '--', 100, 0, 0);
      return;
    }
    const base = resolveWeaponProfile(this.equippedWeaponId);
    const derived = this.weaponRig.getDerivedStats();
    const ammo = this.getActiveAmmoVariant(base.id);
    const zeroDist = this.getZeroDistanceForWeapon(base.id);
    const muzzleVelMs =
      ammo.baseVelocityMs * (base.barrelVelocityMult ?? 1.0) * derived.velocityMult;
    const hob = this.weaponRig.getHeightOverBoreM();
    const zeroPitchRad = solveZeroPitchRad({
      muzzleVelocityMs: muzzleVelMs,
      bc: ammo.ballisticCoefficient,
      heightOverBoreM: hob,
      zeroDistanceM: zeroDist,
      extraElevationMrad: 0,
    });
    this.weaponRig.setZeroConfig(zeroDist, 0, zeroPitchRad);
    this.world.longRangeGallery.setWeaponBallisticsContext(
      base.name,
      ammo.shortName,
      zeroDist,
      muzzleVelMs,
      ammo.ballisticCoefficient,
    );
  }

  private cycleZeroDistance(dir: 1 | -1): void {
    if (this.equippedWeaponId === 'unarmed' || this.swapChoreography.isActive()) return;
    const presets = [25, 50, 100, 200];
    const cur = this.getZeroDistanceForWeapon(this.equippedWeaponId);
    let idx = presets.indexOf(cur);
    if (idx < 0) {
      idx = presets.findIndex((p) => p >= cur);
      if (idx < 0) idx = presets.length - 1;
    }
    const nextIdx = (idx + dir + presets.length) % presets.length;
    const nextDist = presets[nextIdx];
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    hideoutShardAdapter.setWeaponZeroDistance(prof.id, nextDist);
    this.syncWeaponBallistics();
    this.weaponRig.triggerTurretClick();
    this.audio.playTurretClick(dir > 0);
    this.showToast(`Optic Zeroed: ${nextDist}m`);
    this.emitSnapshot(true);
  }

  private cycleAmmoVariant(): void {
    if (this.equippedWeaponId === 'unarmed' || this.swapChoreography.isActive()) return;
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const calId = this.getActiveBaseCaliberId(prof.id);
    const variants = getAmmoVariantsForCaliber(calId);
    if (variants.length <= 1) {
      this.showToast(`Only 1 Load Available for ${prof.caliberLabel}`);
      return;
    }
    const cur = this.getActiveAmmoVariant(prof.id);
    const curIdx = variants.findIndex((v) => v.id === cur.id);
    const next = variants[(curIdx + 1) % variants.length];
    hideoutShardAdapter.setWeaponAmmoVariant(prof.id, next.id);
    this.syncWeaponBallistics();
    this.audio.playWeaponCue('mag_in', { intensity: 0.7 });
    this.showToast(`Ammo Loaded: ${next.label} (${Math.round(next.baseVelocityMs)} m/s)`);
    this.emitSnapshot(true);
  }

  private cycleOpticZoom(dir: 1 | -1): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      !this.weaponRig.hasVariableZoom()
    ) {
      return;
    }
    const prev = this.weaponRig.getTargetOpticZoomMult();
    const next = this.weaponRig.cycleOpticZoom(dir, true);
    if (Math.abs(next - prev) > 0.01) {
      this.audio.playTurretClick(dir > 0);
      this.emitSnapshot(true);
    }
  }

  private getEffectiveFireMode(prof: BodycamWeaponProfile): BodycamWeaponProfile['fireMode'] {
    if (prof.fireMode === 'auto') {
      return this.fireModeOverrideByWeapon[prof.id] ?? prof.fireMode;
    }
    return prof.fireMode;
  }

  private getFireModeLabel(prof: BodycamWeaponProfile): string {
    if (this.equippedWeaponId === 'unarmed') return '';
    const mode = this.getEffectiveFireMode(prof);
    if (mode === 'auto') return 'AUTO';
    if (mode === 'bolt') return 'BOLT';
    if (mode === 'pump') return 'PUMP';
    return 'SEMI';
  }

  private resupplyAllWeapons(playLidPop = false): void {
    if (playLidPop) {
      this.world.triggerAmmoCratePop();
    }
    hideoutShardAdapter.resupplyAllAmmo();
    this.reloadTimer = 0;
    this.pendingReloadWeaponId = null;
    if (this.weaponRig.isTubularReloading()) {
      this.weaponRig.interruptTubularReload();
    }
    if (this.equippedWeaponId !== 'unarmed') {
      const prof = resolveWeaponProfile(this.equippedWeaponId);
      this.magAmmoByWeapon[prof.id] = prof.magCapacity;
      this.weaponRig.setAmmoState(prof.magCapacity, true);
    }
    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
    this.syncBeltEquipmentMesh();
    this.audio.playWeaponCue('mag_in', { intensity: 0.85 });
    this.showToast('Ammunition & Ordnance Resupplied');
    this.emitSnapshot(true);
  }

  private tryFireShot(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      this.pauseOpen ||
      this.modalActive ||
      this.currentRoomId !== 'gun_range'
    ) {
      return;
    }

    const prof = this.getWeaponProfile(this.equippedWeaponId);
    const currentAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;

    // Allow interrupting tubular shotgun shell insertion immediately if a round is chambered
    if (this.weaponRig.isTubularReloading() && currentAmmo > 0) {
      this.weaponRig.interruptTubularReload();
    }

    if (
      this.fireCooldown > 0 ||
      this.reloadTimer > 0 ||
      this.weaponRig.isBlockingFiringAction() ||
      this.controller.isSprinting ||
      this.controller.isVaulting() ||
      this.animator.isCombatBusy()
    ) {
      return;
    }
    if (this.weaponRig.getReadOnlyRigState().pullbackRatio > 0.72) return;

    const effMode = this.getEffectiveFireMode(prof);
    const isSingleShot = effMode === 'semi' || effMode === 'bolt' || effMode === 'pump';
    if (isSingleShot && this.semiTriggerConsumed) return;

    if (currentAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.audio.playWeaponCue('dryfire', { intensity: 0.65 });
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.showToast('Empty Magazine — Press R to Reload');
      return;
    }

    const remainingAmmo = currentAmmo - 1;
    this.magAmmoByWeapon[prof.id] = remainingAmmo;
    this.fireCooldown = 60 / Math.max(25, prof.rpm);
    if (isSingleShot) {
      this.semiTriggerConsumed = true;
    }

    this.world.gunRange.registerShotFired();

    const derived = this.weaponRig.getDerivedStats();
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
    const suppressed = derived.isSuppressed;

    this.animator.interruptInspect();
    this.weaponRig.cancelZoomTwist();

    // Sample world muzzle transform BEFORE recoil kick, applying true HOB zeroing pitch
    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    const muzzleVelocityMs =
      activeAmmo.baseVelocityMs * (prof.barrelVelocityMult ?? 1.0) * derived.velocityMult;
    const effectiveSpreadMOA = Math.hypot(prof.spreadMOA, activeAmmo.spreadMOA);

    this.ballistics.spawnShot({
      origin: this._muzzlePos,
      direction: this._muzzleDir,
      ammo: activeAmmo,
      weaponId: prof.id,
      barrelVelocityMult: prof.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: derived.velocityMult,
      weaponSpreadMOA: effectiveSpreadMOA,
      audio: this.audio,
    });

    // Capture live velocity & ballistic energy on Bay 3's Optical Chronograph
    if (
      this.world.longRangeGallery.isPointInGalleryBay(
        this.controller.position.x,
        this.controller.position.z,
      )
    ) {
      this.world.longRangeGallery.recordMuzzleShot({
        weaponName: prof.name,
        ammoLabel: activeAmmo.shortName,
        muzzleVelocityMs,
        bulletMassGrams: activeAmmo.bulletMassGrams,
        bc: activeAmmo.ballisticCoefficient,
        zeroDistanceM: this.getZeroDistanceForWeapon(prof.id),
      });
    }

    this.weaponRig.triggerFire(suppressed, remainingAmmo);
    this.weaponRig.setAmmoState(remainingAmmo, true);
    if (!suppressed) {
      this.postProcess.triggerNvgFlashSpike(0.5);
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

    this.emitSnapshot(false);
  }

  private handleBallisticImpact(ev: Readonly<BallisticImpactEvent>): void {
    const doorId = ev.object?.userData?.destructibleDoorId as string | undefined;
    if (doorId) {
      this.world.doorSystem.applyBulletImpact(
        doorId,
        ev.point,
        ev.incomingDir,
        Math.max(16, ev.impactEnergyJ * 0.02),
      );
      this.audio.playImpact(ev.point, 'wood');
      return;
    }

    const elecHit = this.world.electronics.handleImpact(
      ev.object,
      ev.point,
      ev.normal,
      this._camPos,
    );
    if (elecHit) {
      if (!elecHit.alreadyBroken) {
        this.showToast(`${elecHit.label} Damaged`);
      }
      this.emitSnapshot(true);
      return;
    }

    const rangeHit = this.world.gunRange.handleBallisticImpact(ev, this._camPos);
    if (rangeHit) {
      this.audio.playImpact(ev.point, rangeHit.isSteel ? 'steel_plate' : 'paper');
      this.emitSnapshot(true);
      return;
    }

    const longRangeHit = this.world.longRangeGallery.handleBallisticImpact(ev, this._camPos);
    if (longRangeHit) {
      if (!longRangeHit.isSteel) {
        this.audio.playImpact(ev.point, 'paper');
      } else if (longRangeHit.distanceM < 20) {
        this.audio.playImpact(ev.point, 'steel_plate');
      }
      this.emitSnapshot(true);
      return;
    }

    const matType =
      ev.surface === 'metal' ? 'metal' : ev.surface === 'wood' ? 'wood' : 'concrete';
    this.audio.playImpact(ev.point, matType);
  }

  private triggerGunWallInteraction(slotIndex: number): void {
    if (this.swapChoreography.isActive()) return;
    const slot = this.world.gunWallSlots[slotIndex];
    if (!slot) return;

    const outgoingId = this.equippedWeaponId;
    const incomingId = slot.weaponId;
    if (outgoingId === 'unarmed' && !incomingId) return;

    if (!this.world.getSlotTransform(slotIndex, this._slotPos, this._slotQuat)) return;

    // Capture current world transform of held weapon so Phase 1 starts with zero snapping
    const asm = this.weaponRig.getModelAssembly();
    if (asm && outgoingId !== 'unarmed') {
      asm.group.updateMatrixWorld(true);
      asm.group.getWorldPosition(this._startWeaponPos);
      asm.group.getWorldQuaternion(this._startWeaponQuat);
    } else {
      this.camera.getWorldPosition(this._startWeaponPos);
      this.camera.getWorldQuaternion(this._startWeaponQuat);
    }

    this.input.ads = false;
    this.input.sprint = false;

    const started = this.swapChoreography.start({
      slotIndex,
      slotWorldPos: this._slotPos,
      slotWorldQuat: this._slotQuat,
      outgoingWeaponId: outgoingId,
      incomingWeaponId: incomingId,
      startWeaponWorldPos: this._startWeaponPos,
      startWeaponWorldQuat: this._startWeaponQuat,
      onMountOutgoingToRack: (idx, outId) => {
        this.world.setSlotWeaponVisual(idx, outId);
      },
      onDetachIncomingFromRack: (idx) => {
        // Keep outgoing visible if already mounted on same slot; otherwise clear slot
        if (outgoingId === 'unarmed') {
          this.world.setSlotWeaponVisual(idx, null);
        }
      },
      onComplete: (idx, nextEquipped) => {
        const swapRes = hideoutShardAdapter.commitRackSwap(idx);
        this.world.syncGunWallSlots(swapRes.wallRackSlots);
        this.animator.clearExternalHandOverride();
        this.applyEquippedWeaponRig(nextEquipped, false);
        this.weaponRig.root.visible = true;
        const prof = resolveWeaponProfile(nextEquipped);
        this.showToast(
          nextEquipped === 'unarmed'
            ? 'Weapon Mounted on Gun Wall'
            : `Equipped ${prof.name}`,
        );
        this.emitSnapshot(true);
      },
    });

    if (started) {
      this.weaponRig.root.visible = false;
      this.animator.setExternalHandOverride(this.swapChoreography.ikOverride);
      this.emitSnapshot(true);
    }
  }

  private executeSelectedInteract(): void {
    const target = this.activeTarget;
    const prompt = this.activePrompt;
    if (!target || !prompt || prompt.options.length === 0) return;

    const safeIdx = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, prompt.options.length - 1);
    const chosen = prompt.options[safeIdx];
    if (!chosen) return;

    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._lookDir).normalize();

    if (target.source === 'door') {
      const optId = chosen.id as DoorInteractOptionId;
      this.controller.getVelocity(this._velScratch);
      const horizSpeed = Math.hypot(this._velScratch.x, this._velScratch.z);
      if (optId === 'kick') {
        this.animator.interruptInspect();
        this.input.ads = false;
        this.animator.triggerPushKick(this.controller, DEFAULT_TRAUMA_MODIFIERS);
        this.world.doorSystem.executeKick(
          target.doorId,
          this._lookDir,
          horizSpeed,
          this.controller.isSprinting,
        );
        this.emitSnapshot(true);
        return;
      }

      const ok = this.world.doorSystem.executeOption(target.doorId, optId, {
        actorPos: this._camPos,
        actorForward: this._lookDir,
        horizontalSpeedMps: horizSpeed,
        isSprinting: this.controller.isSprinting,
      });
      if (!ok) return;

      // Trigger corresponding 1P left-hand IK animation (doorknob turn or crisp open-palm push)
      if (optId === 'open' || optId === 'peek' || optId === 'close_soft') {
        if (this.world.doorSystem.getDoorknobWorldPos(target.doorId, this._camPos, this._ikTargetPos)) {
          const animKind =
            optId === 'open'
              ? 'DOOR_OPEN'
              : optId === 'peek'
                ? 'DOOR_PEEK'
                : 'DOOR_CLOSE_SOFT';
          this.interactAnimator.trigger(animKind, this._ikTargetPos, (out) =>
            this.world.doorSystem.getDoorknobWorldPos(target.doorId, this._camPos, out),
          );
        }
      } else if (optId === 'close') {
        if (this.world.doorSystem.getPushFaceWorldPos(target.doorId, this._camPos, this._ikTargetPos)) {
          this.interactAnimator.trigger('DOOR_CLOSE_PUSH', this._ikTargetPos, (out) =>
            this.world.doorSystem.getPushFaceWorldPos(target.doorId, this._camPos, out),
          );
        }
      } else if (optId === 'repair') {
        if (this.world.doorSystem.getDoorCenterWorldPos(target.doorId, this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.showToast('Door Repaired');
      }
      this.emitSnapshot(true);
      return;
    }

    const meta = target.meta;
    switch (meta.kind) {
      case 'gun_wall_slot': {
        if (typeof meta.slotIndex === 'number') {
          this.triggerGunWallInteraction(meta.slotIndex);
        }
        break;
      }
      case 'prep_table_gunsmith': {
        if (this.world.getPropInteractPos('prep_table_gunsmith', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.setModalActive(true);
        this.callbacks.onOpenGunsmith();
        break;
      }
      case 'locker_door': {
        if (chosen.id === 'operator_gear') {
          this.audio.playGearRattle('weapon_swap', 0.45);
          this.setModalActive(true);
          this.callbacks.onOpenOperatorGear();
        } else if (chosen.id === 'open_stash_roster') {
          this.audio.playGearRattle('weapon_swap', 0.45);
          this.setModalActive(true);
          this.callbacks.onOpenOpsLaptop('perimeter');
        } else {
          if (this.world.getPropInteractPos('locker_door', this._ikTargetPos)) {
            this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos, (out) =>
              this.world.getPropInteractPos('locker_door', out),
            );
          }
          const opened = this.world.toggleLockerDoor();
          this.audio.playWeaponCue(opened ? 'bolt_pull' : 'bolt_lock', { intensity: 0.72 });
          this.showToast(opened ? 'Tactical Locker Opened' : 'Tactical Locker Closed');
        }
        break;
      }
      case 'ammo_crate': {
        if (this.world.getPropInteractPos('ammo_crate', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.resupplyAllWeapons(true);
        break;
      }
      case 'range_ammo_box': {
        if (this.world.getPropInteractPos('range_ammo_box', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.resupplyAllWeapons(false);
        break;
      }
      case 'range_console': {
        if (this.world.gunRange.isConsoleBroken()) {
          this.audio.playWeaponCue('dryfire', { intensity: 0.45 });
          this.showToast('Range Console Damaged — Reload Hideout to Repair');
          break;
        }
        if (this.world.getPropInteractPos('range_console', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        if (chosen.id === 'start_course') {
          this.world.gunRange.startCourse();
          this.audio.playWeaponCue('mode_toggle', { intensity: 0.6 });
          this.showToast('30s CQB Pop-Up Course — Standby');
        } else if (chosen.id === 'abort_course') {
          this.world.gunRange.abortCourse();
          this.audio.playWeaponCue('mode_toggle', { intensity: 0.5 });
          this.showToast('CQB Course Aborted');
        } else if (chosen.id === 'reset_targets') {
          this.world.gunRange.resetFreeTargets();
          this.showToast('Range Targets Reset');
        } else if (chosen.id === 'range_resupply') {
          this.resupplyAllWeapons(false);
          break;
        }
        this.emitSnapshot(true);
        break;
      }
      case 'ballistics_console': {
        if (this.world.longRangeGallery.isConsoleBroken()) {
          this.audio.playWeaponCue('dryfire', { intensity: 0.45 });
          this.showToast('Ballistics Console Damaged — Reload Hideout to Repair');
          break;
        }
        if (this.world.getPropInteractPos('ballistics_console', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        if (chosen.id === 'trolley_move') {
          const nextDist = this.world.longRangeGallery.cycleTrolleyDistance();
          this.showToast(`Target Trolley Moving to ${nextDist}m`);
        } else if (chosen.id === 'clear_paper') {
          this.world.longRangeGallery.clearPaperTarget();
          this.audio.playWeaponCue('mode_toggle', { intensity: 0.45 });
          this.showToast('Target Paper & Group Cleared');
        } else if (chosen.id === 'cycle_zero') {
          this.cycleZeroDistance(1);
          break;
        } else if (chosen.id === 'cycle_ammo') {
          this.cycleAmmoVariant();
          break;
        } else if (chosen.id === 'reset_pen_rig') {
          this.world.longRangeGallery.resetPenetrationRig();
          this.showToast('Armor Penetration Rig Reset');
        }
        this.emitSnapshot(true);
        break;
      }
      case 'ops_laptop': {
        if (this.world.readyRoom.isLaptopBroken()) {
          this.audio.playWeaponCue('dryfire', { intensity: 0.45 });
          this.showToast('Ops Command Laptop Damaged — Reload Hideout to Repair');
          break;
        }
        if (this.world.getPropInteractPos('ops_laptop', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playWeaponCue('mode_toggle', { intensity: 0.5 });
        if (chosen.id === 'open_perimeter') {
          this.setModalActive(true);
          this.callbacks.onOpenOpsLaptop('perimeter');
        } else if (chosen.id === 'quick_deploy') {
          this.setModalActive(true);
          this.callbacks.onQuickDeployBattle();
        } else if (chosen.id === 'open_squads') {
          this.setModalActive(true);
          this.callbacks.onOpenOpsLaptop('multiplayer');
        } else {
          this.setModalActive(true);
          this.callbacks.onOpenOpsLaptop('battle');
        }
        break;
      }
      case 'ops_briefing_board': {
        if (this.world.getPropInteractPos('ops_briefing_board', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playWeaponCue('mode_toggle', { intensity: 0.45 });
        if (chosen.id === 'cycle_sector') {
          const nextMapName = this.callbacks.onCycleStagedMap();
          this.showToast(`Staged Sector: ${nextMapName}`);
        } else if (chosen.id === 'open_ops_from_board') {
          if (this.world.readyRoom.isLaptopBroken()) {
            this.showToast('Ops Command Laptop Damaged — Reload Hideout to Repair');
            break;
          }
          this.setModalActive(true);
          this.callbacks.onOpenOpsLaptop('battle');
        }
        break;
      }
      case 'airlock_override': {
        if (this.world.getPropInteractPos('airlock_override', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.triggerAirlockDeployment();
        break;
      }
    }
  }

  public triggerAirlockDeployment(): void {
    if (this.airlockTransitionActive || this.disposed) return;
    this.airlockTransitionActive = true;
    this.airlockPressurizationSec = 0;
    this.clearMovementInputs();
    this.world.airlockBay.triggerPressurizationCycle();
    this.audio.playAirlockSequence('seal');
    this.airlockDeconTimeout = window.setTimeout(() => {
      if (!this.disposed) {
        this.audio.playAirlockSequence('decon');
      }
    }, 300);
    // Subtle pressurization recoil thump on bodycam rig
    this.controller.applyRecoil(0.018, (Math.random() - 0.5) * 0.016, 0.008, 0.25);
    this.callbacks.onEnterZombiesOutpost?.();
    this.emitSnapshot(true);
  }

  private showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimeout !== null) {
      window.clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = window.setTimeout(() => {
      this.toastMessage = null;
      this.toastTimeout = null;
      this.emitSnapshot(true);
    }, 2600);
    this.emitSnapshot(true);
  }

  private isInteractableActionable(meta: HideoutInteractableMeta): boolean {
    if (meta.kind === 'gun_wall_slot' && typeof meta.slotIndex === 'number') {
      const slot = this.world.gunWallSlots[meta.slotIndex];
      const slotWeaponId = slot?.weaponId ?? null;
      return Boolean(slotWeaponId || this.equippedWeaponId !== 'unarmed');
    }
    return true;
  }

  private updateInteractableScan(): void {
    if (this.swapChoreography.isActive() || this.pauseOpen || this.modalActive) {
      this.activeTarget = null;
      this.activePrompt = null;
      this.interactReticleState = 'hidden';
      return;
    }

    const NEAR_AWARENESS_EXTRA_M = 2.2;
    const DOOR_INTERACT_MAX_M = 2.65;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._lookDir).normalize();
    this._raycaster.set(this._camPos, this._lookDir);
    this._raycaster.near = 0.08;
    this._raycaster.far = 5.4;

    // Combine Hideout prop proxies + DestructibleDoorSystem proxies with zero allocation
    this._scanObjects.length = 0;
    for (let i = 0; i < this.world.interactableMeshes.length; i++) {
      this._scanObjects.push(this.world.interactableMeshes[i]);
    }
    const doorProxies = this.world.doorSystem.getInteractableMeshes();
    for (let i = 0; i < doorProxies.length; i++) {
      this._scanObjects.push(doorProxies[i]);
    }

    const hits = this._raycaster.intersectObjects(this._scanObjects, false);
    let matched: ActiveInteractTarget | null = null;
    let nearDetected = false;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible) continue;

      const doorId = h.object.userData.destructibleDoorId as string | undefined;
      if (doorId) {
        this.controller.getVelocity(this._velScratch);
        const horizSpeed = Math.hypot(this._velScratch.x, this._velScratch.z);
        const doorOpts = this.world.doorSystem.getInteractOptions(
          doorId,
          this.controller.isSprinting,
          horizSpeed,
          this._camPos,
        );
        if (doorOpts.length === 0) continue;

        const maxNear = DOOR_INTERACT_MAX_M + NEAR_AWARENESS_EXTRA_M;
        if (h.distance > maxNear) continue;

        if (h.distance > 0.5) {
          const blocked = this.adapter.raycast(
            this._camPos,
            this._lookDir,
            0.08,
            h.distance - 0.35,
            this._occlRayHit,
          );
          if (blocked && this._occlRayHit.object?.userData?.destructibleDoorId !== doorId) {
            continue;
          }
        }

        if (h.distance <= DOOR_INTERACT_MAX_M) {
          matched = { source: 'door', doorId, keyId: `door:${doorId}` };
        } else {
          nearDetected = true;
        }
        break;
      }

      const meta = h.object.userData.hideoutInteractable as HideoutInteractableMeta | undefined;
      if (!meta || !this.isInteractableActionable(meta)) continue;

      const maxNearDist = meta.maxDistanceM + NEAR_AWARENESS_EXTRA_M;
      if (h.distance > maxNearDist) continue;

      if (h.distance > 0.5) {
        const blocked = this.adapter.raycast(
          this._camPos,
          this._lookDir,
          0.08,
          h.distance - 0.35,
          this._occlRayHit,
        );
        if (blocked) continue;
      }

      if (h.distance <= meta.maxDistanceM) {
        matched = {
          source: 'prop',
          meta,
          keyId: `prop:${meta.kind}:${meta.slotIndex ?? ''}`,
        };
      } else {
        nearDetected = true;
      }
      break;
    }

    this.activeTarget = matched;
    if (!matched) {
      this.activePrompt = null;
      this.lastTargetKeyId = '';
      this.selectedOptionIndex = 0;
      this.interactReticleState = nearDetected ? 'near' : 'hidden';
      return;
    }

    if (matched.keyId !== this.lastTargetKeyId) {
      this.lastTargetKeyId = matched.keyId;
      this.selectedOptionIndex = 0;
    }

    this.interactReticleState = 'ready';

    if (matched.source === 'door') {
      this.controller.getVelocity(this._velScratch);
      const horizSpeed = Math.hypot(this._velScratch.x, this._velScratch.z);
      const door = this.world.doorSystem.getDoor(matched.doorId);
      const opts = this.world.doorSystem.getInteractOptions(
        matched.doorId,
        this.controller.isSprinting,
        horizSpeed,
        this._camPos,
      );
      if (opts.length === 0) {
        this.activeTarget = null;
        this.activePrompt = null;
        this.interactReticleState = 'hidden';
        return;
      }
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: door?.label ?? 'Door',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    const meta = matched.meta;
    if (meta.kind === 'gun_wall_slot' && typeof meta.slotIndex === 'number') {
      const slot = this.world.gunWallSlots[meta.slotIndex];
      const slotWeaponId = slot?.weaponId ?? null;
      if (slotWeaponId) {
        const targetProf = resolveWeaponProfile(slotWeaponId);
        const verb = this.equippedWeaponId === 'unarmed' ? 'Equip' : 'Swap with';
        this.selectedOptionIndex = 0;
        this.activePrompt = {
          key: 'F',
          options: [{ id: 'gun_wall', label: `${verb} ${targetProf.name}` }],
          selectedIndex: 0,
        };
      } else if (this.equippedWeaponId !== 'unarmed') {
        const heldProf = resolveWeaponProfile(this.equippedWeaponId);
        this.selectedOptionIndex = 0;
        this.activePrompt = {
          key: 'F',
          options: [{ id: 'gun_wall', label: `Hang ${heldProf.name} on Rack` }],
          selectedIndex: 0,
        };
      } else {
        this.activeTarget = null;
        this.activePrompt = null;
        this.interactReticleState = 'hidden';
      }
      return;
    }

    if (meta.kind === 'prep_table_gunsmith') {
      this.selectedOptionIndex = 0;
      this.activePrompt = {
        key: 'F',
        options: [{ id: 'gunsmith', label: 'Gunsmith Workbench' }],
        selectedIndex: 0,
      };
      return;
    }

    if (meta.kind === 'locker_door') {
      const opts: HideoutPromptOption[] = [
        { id: 'open_stash_roster', label: 'Personal Stash & Roster', hint: 'Perimeter Ops' },
        { id: 'operator_gear', label: 'Operator Gear' },
        { id: 'toggle_locker', label: this.world.lockerOpen ? 'Close Locker' : 'Open Locker' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Tactical Locker',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (meta.kind === 'ammo_crate') {
      this.selectedOptionIndex = 0;
      this.activePrompt = {
        key: 'F',
        options: [{ id: 'ammo_crate', label: 'Resupply Ammunition' }],
        selectedIndex: 0,
      };
      return;
    }

    if (meta.kind === 'range_ammo_box') {
      this.selectedOptionIndex = 0;
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Firing Line Ammo',
        options: [{ id: 'range_resupply', label: 'Resupply Ammunition' }],
        selectedIndex: 0,
      };
      return;
    }

    if (meta.kind === 'range_console') {
      if (this.world.gunRange.isConsoleBroken()) {
        this.selectedOptionIndex = 0;
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Range Control Console',
          options: [{ id: 'broken_console', label: 'Console Damaged', hint: 'Reload to Repair' }],
          selectedIndex: 0,
        };
        return;
      }
      const running = this.world.gunRange.isCourseRunning();
      const opts: HideoutPromptOption[] = [
        running
          ? { id: 'abort_course', label: 'Abort CQB Course', hint: 'Stop' }
          : { id: 'start_course', label: 'Start 30s CQB Course', hint: '30s' },
        { id: 'reset_targets', label: 'Reset All Targets' },
        { id: 'range_resupply', label: 'Resupply Ammunition' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Range Control Console',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (meta.kind === 'ballistics_console') {
      if (this.world.longRangeGallery.isConsoleBroken()) {
        this.selectedOptionIndex = 0;
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Ballistics Control Console',
          options: [{ id: 'broken_console', label: 'Console Damaged', hint: 'Reload to Repair' }],
          selectedIndex: 0,
        };
        return;
      }
      const curDist = this.world.longRangeGallery.getTrolleyDistanceM();
      const nextDist = this.world.longRangeGallery.getNextTrolleyDistanceM();
      const zeroM = this.getZeroDistanceForWeapon(this.equippedWeaponId);
      const ammoName =
        this.equippedWeaponId === 'unarmed'
          ? 'None'
          : this.getActiveAmmoVariant(this.equippedWeaponId).shortName;
      const opts: HideoutPromptOption[] = [
        { id: 'trolley_move', label: 'Move Trolley Target', hint: `${curDist}m → ${nextDist}m` },
        { id: 'clear_paper', label: 'Clear Target Paper & Group' },
        { id: 'cycle_zero', label: 'Cycle Optic Zero', hint: `${zeroM}m` },
        { id: 'cycle_ammo', label: 'Cycle Ammo Load', hint: ammoName },
        { id: 'reset_pen_rig', label: 'Reset Armor Test Rig' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Ballistics Control Console',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (meta.kind === 'ops_laptop') {
      if (this.world.readyRoom.isLaptopBroken()) {
        this.selectedOptionIndex = 0;
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Ops Command Laptop',
          options: [{ id: 'broken_laptop', label: 'Terminal Damaged', hint: 'Reload to Repair' }],
          selectedIndex: 0,
        };
        return;
      }
      const opts: HideoutPromptOption[] = [
        { id: 'open_perimeter', label: 'Perimeter Ops Roster & Shards', hint: '3 Slots · Stash' },
        { id: 'open_ops', label: 'Open Ops Command Terminal', hint: 'Battle · Squads · Ops' },
        { id: 'quick_deploy', label: 'Quick Deploy Staged Match' },
        { id: 'open_squads', label: 'Squads & Multiplayer Lobbies' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Ops Command Laptop',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (meta.kind === 'ops_briefing_board') {
      const opts: HideoutPromptOption[] = [
        { id: 'cycle_sector', label: 'Cycle Staged Combat Sector' },
        { id: 'open_ops_from_board', label: 'Open Ops Command Terminal' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Tactical Sector Briefing Board',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (meta.kind === 'airlock_override') {
      this.selectedOptionIndex = 0;
      this.activePrompt = {
        key: 'E',
        targetLabel: 'Bio-Containment Airlock Override',
        options: [
          {
            id: 'enter_zombies_outpost',
            label: 'Cycle Airlock → Quarantine Outpost',
            hint: 'E / F',
          },
        ],
        selectedIndex: 0,
      };
    }
  }

  private togglePda(): void {
    if (this.swapChoreography.isActive() || this.pauseOpen || this.modalActive) return;
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
    this.emitSnapshot(true);
  }

  private clearMovementInputs(): void {
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.ads = false;
    this.input.vault = false;
    this.shiftHeld = false;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.pdaDevice.setDragging(false);
  }

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    this.pointerLocked = locked;
    if (!locked) {
      this.clearMovementInputs();
      if (!this.modalActive && !this.disposed) {
        this.pauseOpen = true;
      }
    } else {
      this.pauseOpen = false;
    }
    this.emitSnapshot(true);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked || this.pauseOpen || this.modalActive) return;
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
    if (this.modalActive || this.pauseOpen) return;
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    this.audio.ensureInitialized();
    this.audio.setInteriorAcoustics(true, 'concrete');

    if (this.pdaDevice.isBlockingWeaponActions()) {
      if (e.button === 0 && this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
      } else if (e.button === 2 && this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      }
      return;
    }

    // Authentic 4-stage grenade Manual of Arms when ordnance is drawn
    if (this.grenadeSystem.isDrawn()) {
      this.input.ads = false;
      const stage = this.grenadeSystem.getHoldStage();
      if (e.button === 2) {
        if (stage === 'DRAWN') {
          if (this.grenadeSystem.pullPin()) {
            this.emitSnapshot(true);
          }
        } else if (stage === 'PIN_PULLED') {
          if (this.grenadeSystem.releaseLever()) {
            this.emitSnapshot(true);
          }
        }
      } else if (e.button === 0 && (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED')) {
        this.grenadeSystem.beginThrowInput();
        this.emitSnapshot(true);
      }
      return;
    }

    if (e.button === 1) {
      this.cycleAimMode();
      return;
    }

    if (e.button === 2 && !this.swapChoreography.isActive()) {
      this.animator.interruptInspect();
      this.input.ads = true;
    } else if (e.button === 0 && !this.swapChoreography.isActive()) {
      if (this.equippedWeaponId === 'unarmed') {
        // Unarmed jab (hip) or heavy power hook (holding RMB ready fists) works anywhere in Hideout
        this.animator.interruptInspect();
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
        return;
      }
      const room = resolveHideoutRoom(this.controller.position.x, this.controller.position.z);
      if (room.id === 'gun_range') {
        this.currentRoomId = room.id;
        this.currentRoomLabel = room.label;
        this.isFiring = true;
        this.tryFireShot();
      } else {
        this.weaponRig.triggerDryFire();
        this.audio.playWeaponCue('dryfire', { intensity: 0.35 });
      }
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
        this.emitSnapshot(true);
      }
      this.isFiring = false;
      this.semiTriggerConsumed = false;
    } else if (e.button === 2) {
      this.input.ads = false;
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.pointerLocked || this.pauseOpen || this.modalActive) return;
    if (this.pdaDevice.isOpen()) {
      e.preventDefault();
      this.pdaDevice.applyWheel(e.deltaY);
      return;
    }
    if (this.activePrompt && this.activePrompt.options.length > 1) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const len = this.activePrompt.options.length;
      this.selectedOptionIndex = (this.selectedOptionIndex + dir + len) % len;
      this.activePrompt = {
        ...this.activePrompt,
        selectedIndex: this.selectedOptionIndex,
      };
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.2 });
      this.emitSnapshot(true);
      return;
    }
    if (this.input.ads && this.weaponRig.hasVariableZoom()) {
      e.preventDefault();
      this.cycleOpticZoom(e.deltaY < 0 ? 1 : -1);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.modalActive) return;

    if (e.code === 'Escape' && !e.repeat) {
      if (this.pauseOpen) {
        this.requestPointerLock();
      } else if (!this.pointerLocked) {
        this.pauseOpen = true;
        this.emitSnapshot(true);
      }
      return;
    }

    if (!this.pointerLocked || this.pauseOpen) return;
    this.audio.ensureInitialized();

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
      case 'KeyC':
        if (!e.repeat) this.controller.toggleCrouch();
        break;
      case 'KeyQ':
        this.input.leanLeft = true;
        break;
      case 'KeyE':
        if (
          !e.repeat &&
          !this.pdaDevice.isBlockingWeaponActions() &&
          this.activeTarget?.source === 'prop' &&
          this.activeTarget.meta.kind === 'airlock_override'
        ) {
          this.executeSelectedInteract();
          break;
        }
        // Pure lean right everywhere else — zero interference with [F] interactions!
        this.input.leanRight = true;
        break;
      case 'KeyF':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions() && this.activeTarget) {
          this.executeSelectedInteract();
        }
        break;
      case 'KeyM':
        if (!e.repeat) {
          this.togglePda();
        }
        break;
      case 'KeyV':
        if (!e.repeat && !this.swapChoreography.isActive() && !this.pdaDevice.isBlockingWeaponActions()) {
          this.animator.interruptInspect();
          this.input.ads = false;
          if (this.equippedWeaponId === 'unarmed') {
            this.animator.triggerUnarmedPunch(this.controller, false);
          } else {
            const prof = resolveWeaponProfile(this.equippedWeaponId);
            this.animator.triggerArmedBash(this.controller, prof.holdClass);
          }
        }
        break;
      case 'KeyX':
        if (!e.repeat && !this.swapChoreography.isActive() && !this.pdaDevice.isBlockingWeaponActions()) {
          this.animator.interruptInspect();
          this.input.ads = false;
          this.animator.triggerPushKick(this.controller, DEFAULT_TRAUMA_MODIFIERS);
        }
        break;
      case 'KeyI':
        if (
          !e.repeat &&
          this.equippedWeaponId !== 'unarmed' &&
          !this.swapChoreography.isActive() &&
          !this.pdaDevice.isBlockingWeaponActions()
        ) {
          this.weaponRig.weaponAnimator.triggerInspect();
        }
        break;
      case 'KeyR':
        if (this.pdaDevice.isOpen()) {
          if (!e.repeat) this.pdaDevice.recenterOnPlayer();
          break;
        }
        if (
          !e.repeat &&
          this.equippedWeaponId !== 'unarmed' &&
          !this.swapChoreography.isActive() &&
          !this.pdaDevice.isBlockingWeaponActions() &&
          this.reloadTimer <= 0 &&
          !this.weaponRig.isTubularReloading()
        ) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const curMag = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
          const reserve = hideoutShardAdapter.getReserveForWeapon(prof.id);
          if (curMag < prof.magCapacity && reserve > 0) {
            const needed = Math.min(prof.magCapacity - curMag, reserve);
            if (prof.holdClass === 'shotgun' && prof.fireMode === 'pump') {
              const started = this.weaponRig.triggerTubularReload(
                needed,
                curMag === 0,
                () => {
                  if (this.equippedWeaponId !== prof.id) return;
                  const took = hideoutShardAdapter.consumeReserve(prof.id, 1);
                  if (took > 0) {
                    const nextAmmo = Math.min(
                      prof.magCapacity,
                      (this.magAmmoByWeapon[prof.id] ?? 0) + took,
                    );
                    this.magAmmoByWeapon[prof.id] = nextAmmo;
                    this.weaponRig.setAmmoState(nextAmmo, true);
                    this.emitSnapshot(true);
                  }
                },
                () => {
                  this.emitSnapshot(true);
                },
              );
              if (started) this.emitSnapshot(true);
            } else {
              this.reloadTimer = prof.reloadDurationSec;
              this.pendingReloadWeaponId = prof.id;
              this.animator.triggerReload(prof.reloadDurationSec);
              this.emitSnapshot(true);
            }
          } else if (reserve <= 0 && curMag < prof.magCapacity) {
            this.showToast('No Reserve Ammo — Resupply at Ammo Box');
          }
        }
        break;
      case 'KeyB':
        if (
          !e.repeat &&
          this.equippedWeaponId !== 'unarmed' &&
          !this.swapChoreography.isActive() &&
          !this.pdaDevice.isBlockingWeaponActions()
        ) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          if (prof.fireMode === 'auto') {
            const cur = this.getEffectiveFireMode(prof);
            const next: 'auto' | 'semi' = cur === 'semi' ? 'auto' : 'semi';
            this.fireModeOverrideByWeapon[prof.id] = next;
            this.audio.playWeaponCue('mode_toggle', { intensity: 0.55 });
            this.showToast(next === 'auto' ? 'Fire Mode: Full Auto' : 'Fire Mode: Semi Auto');
            this.emitSnapshot(true);
          }
        }
        break;
      case 'KeyL':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          this.weaponRig.laserOn = !this.weaponRig.laserOn;
          this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
          this.showToast(this.weaponRig.laserOn ? 'Laser Sight: ON' : 'Laser Sight: OFF');
        }
        break;
      case 'KeyT':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          const on = this.weaponRig.flashlight.intensity <= 0.1;
          this.weaponRig.flashlight.intensity = on ? 6.5 : 0;
          this.audio.playTacticalSwitchClick(on);
          this.showToast(on ? 'Weapon Light: ON' : 'Weapon Light: OFF');
        }
        break;
      case 'KeyJ':
        if (!e.repeat) {
          this.toggleNvg();
        }
        break;
      case 'KeyN':
        if (!e.repeat) {
          this.toggleIrOrReticle();
        }
        break;
      case 'KeyG':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.toggleSuppressor();
        }
        break;
      case 'BracketRight':
        if (!e.repeat && !this.controller.isSprinting) {
          this.cycleOpticZoom(1);
        }
        break;
      case 'BracketLeft':
        if (!e.repeat && !this.controller.isSprinting) {
          this.cycleOpticZoom(-1);
        }
        break;
      case 'PageUp':
        if (!e.repeat) {
          this.cycleZeroDistance(1);
        }
        break;
      case 'PageDown':
        if (!e.repeat) {
          this.cycleZeroDistance(-1);
        }
        break;
      case 'Digit1':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.equipHideoutSlot(1);
        }
        break;
      case 'Digit2':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.equipHideoutSlot(2);
        }
        break;
      case 'Digit3':
      case 'Digit0':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.equipHideoutSlot(3);
        }
        break;
      case 'Digit4':
      case 'KeyH':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.drawOrHolsterGrenade();
        }
        break;
      case 'Space':
        e.preventDefault();
        if (!e.repeat && !this.pdaDevice.isOpen()) {
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

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.postProcess.setSize(width, height);
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.onResize();
  };

  private readonly onWindowBlur = (): void => {
    this.clearMovementInputs();
  };

  private bindEvents(): void {
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => {
        if (!this.disposed) this.tick();
      });
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (gl && typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const status = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (status === gl.UNSIGNALED) {
          this.softwareTimerId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.softwareTimerId = window.setTimeout(cb, 80);
        }
      };
      this.softwareTimerId = window.setTimeout(poll, 5);
    } else {
      this.softwareTimerId = window.setTimeout(cb, 80);
    }
  }

  private readonly tick = (): void => {
    if (this.disposed) return;

    const now = performance.now();
    const rawDt = (now - this.lastFrameMs) * 0.001;
    this.lastFrameMs = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.elapsedSec += dt;

    // FPS meter
    this.fpsAccumSec += rawDt;
    this.fpsFrames++;
    if (this.fpsAccumSec >= 0.5) {
      this.currentFps = Math.round(this.fpsFrames / Math.max(0.001, this.fpsAccumSec));
      this.fpsAccumSec = 0;
      this.fpsFrames = 0;
    }

    if (!this.isSoftwareGl) {
      const adapt = this.adaptivePerf.update(
        rawDt * 1000,
        graphicsQualityStore.isAdaptiveScalingEnabled(),
        this.elapsedSec,
      );
      if (adapt.changed) {
        this.renderer.setPixelRatio(adapt.effectiveDpr);
        this.onResize();
      }
    }

    if (!this.contextLost) {
      const swapping = this.swapChoreography.isActive();
      const suppBusy = this.weaponRig.isSuppressorActionActive();
      const pdaBusy = this.pdaDevice.isBlockingWeaponActions();
      const grenadeDrawn = this.grenadeSystem.isDrawn();
      if (suppBusy || pdaBusy || grenadeDrawn) {
        this.input.ads = false;
      }

      const profile = this.getWeaponProfile(this.equippedWeaponId);
      const baseAdsMode = this.getArmedAdsMode(profile.id);
      const nodsForceCant =
        this.nvgFlipped &&
        this.localGear.nvgMount !== 'none' &&
        this.input.ads &&
        baseAdsMode === 'PRIMARY' &&
        this.weaponRig.shouldForceNodsCantedAim(true);
      this.input.adsMode = nodsForceCant ? 'POINT_AIM' : baseAdsMode;
      const firearmAdsBlocking =
        this.input.ads && this.equippedWeaponId !== 'unarmed' && !grenadeDrawn;
      this.input.sprint =
        !suppBusy && !pdaBusy && this.shiftHeld && this.input.forward && !firearmAdsBlocking && !swapping;
      this.input.holdBreath =
        !suppBusy &&
        !pdaBusy &&
        this.shiftHeld &&
        this.input.ads &&
        this.equippedWeaponId !== 'unarmed' &&
        !swapping;

      // Step fire cooldown & box-magazine reload timer
      if (this.fireCooldown > 0) {
        this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      }
      if (this.reloadTimer > 0) {
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        if (this.reloadTimer <= 0 && this.pendingReloadWeaponId) {
          const reloadId = this.pendingReloadWeaponId;
          this.pendingReloadWeaponId = null;
          if (reloadId === this.equippedWeaponId) {
            const rProf = resolveWeaponProfile(reloadId);
            const curMag = this.magAmmoByWeapon[rProf.id] ?? 0;
            const needed = Math.max(0, rProf.magCapacity - curMag);
            const taken = hideoutShardAdapter.consumeReserve(rProf.id, needed);
            if (taken > 0) {
              const nextAmmo = curMag + taken;
              this.magAmmoByWeapon[rProf.id] = nextAmmo;
              this.weaponRig.setAmmoState(nextAmmo, true);
              this.emitSnapshot(true);
            }
          }
        }
      }

      // Update player first-person movement, breathing sway & weapon rig
      this.controller.update(
        dt,
        this.elapsedSec,
        this.input,
        this.adapter,
        profile,
        this.config,
        1.0,
        100,
      );

      // Update interactive Arsenal props, Gun Range targets/course, destructible electronics & doors
      this.camera.getWorldPosition(this._camPos);
      this.world.updateProps(dt, this._camPos);
      this.world.doorSystem.update(dt, this._camPos);

      // Update Gun Wall two-handed swap choreography or 1P left-hand interact IK BEFORE CharacterAnimator
      if (swapping) {
        this.interactAnimator.cancel();
        this.swapChoreography.update(dt, this.camera);
        this.animator.setExternalHandOverride(
          this.swapChoreography.isActive() ? this.swapChoreography.ikOverride : null,
        );
      } else if (this.interactAnimator.isActive()) {
        const stillActive = this.interactAnimator.update(dt, this.camera);
        this.animator.setExternalHandOverride(
          stillActive ? this.interactAnimator.ikOverride : null,
        );
      } else {
        this.animator.setExternalHandOverride(null);
      }

      // Update 3D Tactical PDA before IK animator consumes wrist sockets (zero-GC scratch reuse)
      const pdaTel = this._pdaTelemetryScratch;
      pdaTel.playerX = this.controller.position.x;
      pdaTel.playerZ = this.controller.position.z;
      pdaTel.playerYawRad = this.controller.aimYaw;
      pdaTel.zoneLabel = this.currentRoomLabel.toUpperCase();
      this.pdaDevice.setTelemetry(pdaTel);
      this.controller.writePdaMotionState(this._pdaMotionScratch);
      this.pdaDevice.update(
        dt,
        this.elapsedSec,
        this._pdaMotionScratch.moveRatio,
        this._pdaMotionScratch.isCrouched,
        this._pdaMotionScratch,
      );

      // Update full-body procedural skeleton & hand/finger IK
      this.animator.update(
        dt,
        this.elapsedSec,
        this.controller,
        this.adapter,
        profile,
        this.input.ads,
      );
      this.animator.applyCameraAdditiveOverlay(this.camera);

      // Apply subtle bodycam airlock pressurization camera shake & FOV shift during blast door seal
      if (this.airlockTransitionActive) {
        this.airlockPressurizationSec += dt;
        const p = Math.min(1, this.airlockPressurizationSec / 0.72);
        const shakeAmp = Math.sin(p * Math.PI) * 0.0085;
        this.camera.position.x += Math.sin(this.elapsedSec * 52) * shakeAmp;
        this.camera.position.y += Math.cos(this.elapsedSec * 61) * shakeAmp * 0.8;
        const targetFov = this.baseCameraFov - p * 5.2;
        if (Math.abs(this.camera.fov - targetFov) > 0.02) {
          this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 7.5, dt);
          this.camera.updateProjectionMatrix();
        }
      }

      this.weaponRig.root.visible =
        !swapping && !this.grenadeSystem.isWeaponHidden() && !this.pdaDevice.isWeaponHidden();

      // Update spatial audio listener & indoor concrete bunker acoustic state
      this.camera.getWorldPosition(this._camPos);
      this.camera.getWorldDirection(this._lookDir).normalize();
      this._camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
      this.audio.updateListener(this._camPos, this._lookDir, this._camUp);

      // Track current bunker wing BEFORE stepping live fire & ballistics
      const room = resolveHideoutRoom(this.controller.position.x, this.controller.position.z);
      const roomChanged = room.id !== this.currentRoomId;
      if (roomChanged) {
        this.currentRoomId = room.id;
        this.currentRoomLabel = room.label;
        if (room.id !== 'gun_range') {
          this.isFiring = false;
        }
      }

      // Stepping inside the sealed airlock chamber auto-triggers decontamination & transport transition
      if (this.airlockReturnCooldownSec > 0) {
        this.airlockReturnCooldownSec = Math.max(0, this.airlockReturnCooldownSec - dt);
      } else if (
        !this.airlockTransitionActive &&
        !this.modalActive &&
        !this.pauseOpen &&
        this.world.airlockBay.isInsideAirlockChamber(
          this.controller.position.x,
          this.controller.position.z,
        )
      ) {
        this.triggerAirlockDeployment();
      }

      // Automatic fire hold while inside Gun Range
      if (
        this.isFiring &&
        this.pointerLocked &&
        !this.pauseOpen &&
        !this.modalActive &&
        this.currentRoomId === 'gun_range'
      ) {
        this.tryFireShot();
      }

      // Step live ballistic projectiles, tracers, sparks, grenades & target/door/electronic impacts
      this.ballistics.update(dt, this.adapter, (ev) => this.handleBallisticImpact(ev));

      const wasLiveGrenade = this.grenadeSystem.isLeverReleased();
      this.grenadeSystem.update(dt, this._camPos);
      const launched = this.grenadeSystem.consumeLastLaunchedThrow();
      if (launched) {
        this.grenadeCount = Math.max(0, this.grenadeCount - 1);
        this.syncBeltEquipmentMesh();
        this.audio.playGearRattle('weapon_swap', 0.65);
        this.emitSnapshot(true);
      } else if (wasLiveGrenade && !this.grenadeSystem.isLeverReleased()) {
        this.grenadeCount = Math.max(0, this.grenadeCount - 1);
        this.syncBeltEquipmentMesh();
        this.emitSnapshot(true);
      }

      const prevSig = this.activePrompt
        ? `${this.activePrompt.targetLabel ?? ''}|${this.activePrompt.selectedIndex}|${this.activePrompt.options.map((o) => `${o.id}:${o.label}:${o.hint ?? ''}`).join(',')}`
        : '';
      const prevReticleState = this.interactReticleState;
      this.updateInteractableScan();
      const nextSig = this.activePrompt
        ? `${this.activePrompt.targetLabel ?? ''}|${this.activePrompt.selectedIndex}|${this.activePrompt.options.map((o) => `${o.id}:${o.label}:${o.hint ?? ''}`).join(',')}`
        : '';
      const promptChanged = nextSig !== prevSig || this.interactReticleState !== prevReticleState;

      this._scopePassParams.dt = dt;
      this.controller.getWhipVelocity(this._whipVel);
      this.postProcess.update(
        dt,
        this.elapsedSec,
        this.config,
        swapping ? 0 : this._whipVel.x,
        swapping ? 0 : this._whipVel.y,
        100,
        false,
        DEFAULT_TRAUMA_MODIFIERS,
        this.controller.getHoldBreathVignette(),
      );
      this.postProcess.render();

      const emitIntervalMs = this.world.gunRange.isCourseRunning() ? 90 : 160;
      if (roomChanged || promptChanged || now - this.lastEmitMs >= emitIntervalMs) {
        this.lastEmitMs = now;
        this.emitSnapshot(false);
      }
    }

    this.scheduleNextFrame();
  };

  private buildSnapshot(): HideoutSnapshot {
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const ammoInMag =
      this.equippedWeaponId === 'unarmed'
        ? 0
        : (this.magAmmoByWeapon[prof.id] ?? prof.magCapacity);
    const activeAmmo =
      this.equippedWeaponId === 'unarmed' ? null : this.getActiveAmmoVariant(prof.id);
    const grenadeDef = getTacticalEquipmentDef(this.tacticalEquipmentId);
    return {
      pointerLocked: this.pointerLocked,
      pauseOpen: this.pauseOpen,
      currentRoomId: this.currentRoomId,
      currentRoomLabel: this.currentRoomLabel,
      equippedWeaponId: this.equippedWeaponId,
      equippedWeaponName: this.equippedWeaponId === 'unarmed' ? 'Unarmed' : prof.name,
      equippedCaliber: this.equippedWeaponId === 'unarmed' ? '' : prof.caliberLabel,
      activeAmmoLabel: activeAmmo ? activeAmmo.shortName : '',
      zeroDistanceM: this.getZeroDistanceForWeapon(this.equippedWeaponId),
      hasVariableZoom: this.weaponRig.hasVariableZoom(),
      activeOpticZoom: this.weaponRig.getActiveOpticZoomMult(),
      armedAdsMode: this.getArmedAdsMode(this.equippedWeaponId),
      fireModeLabel: this.getFireModeLabel(prof),
      ammoInMag,
      magCapacity: this.equippedWeaponId === 'unarmed' ? 0 : prof.magCapacity,
      ammoReserve: hideoutShardAdapter.getReserveForWeapon(this.equippedWeaponId),
      grenadeDrawn: this.grenadeSystem.isDrawn(),
      grenadeHoldStage: this.grenadeSystem.getHoldStage(),
      grenadeName: grenadeDef.shortName,
      grenadeCount: this.grenadeCount,
      nvgActive: this.nvgFlipped && this.localGear.nvgMount !== 'none',
      irActive: this.nvgFlipped && this.localGear.nvgMount !== 'none' && this.irIlluminatorOn,
      isPdaOpen: this.pdaDevice.isOpen(),
      isSwappingGunWall: this.swapChoreography.isActive(),
      interactReticleState: this.interactReticleState,
      prompt: this.activePrompt
        ? {
            ...this.activePrompt,
            options: this.activePrompt.options.map((o) => ({ ...o })),
          }
        : null,
      toastMessage: this.toastMessage,
      fps: this.currentFps,
      masterVolume: this.config.masterVolume,
      gunRange: this.world.gunRange.getState(),
      longRange: this.world.longRangeGallery.getState(
        this.controller.position.x,
        this.controller.position.z,
      ),
    };
  }

  private emitSnapshot(immediate: boolean): void {
    if (immediate) this.lastEmitMs = performance.now();
    const snap = this.buildSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.softwareTimerId);
    if (this.toastTimeout !== null) window.clearTimeout(this.toastTimeout);
    if (this.airlockDeconTimeout !== null) window.clearTimeout(this.airlockDeconTimeout);

    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.unsubOperatorId();
    this.unsubOperatorGear();
    this.unsubLoadout();
    this.unsubOpenWorld();
    this.unsubAdaptiveScaling?.();
    this.unsubAdaptiveScaling = null;
    this.camera.remove(this.pdaDevice.root);
    this.pdaDevice.dispose();
    this.grenadeSystem.dispose();
    this.ballistics.dispose();
    this.scene.remove(this.ballistics.group);
    this.swapChoreography.dispose();
    this.scopeRenderer.dispose();
    this.postProcess.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
    this.audio.dispose();
    this.world.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }
}

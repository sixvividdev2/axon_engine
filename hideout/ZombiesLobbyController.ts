import * as THREE from 'three';
import {
  BallisticImpactEvent,
  BallisticsSolver,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamPostProcess,
  BodycamRaycastResult,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  createBodycamPhysicsPropAdapter,
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  DynamicPhysicsPropSystem,
  EjectedLiveRoundPool,
  IBodycamWorldAdapter,
  operatorAssetLoader,
  OperatorGearConfig,
  OperatorId,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  SDK_WEAPON_PROFILES,
  WeaponRig,
  WorldBackpackSystem,
} from '../bodycam-sdk';
import {
  addLooseRoundToInventory,
  autoPlaceItemInGrid,
  buildModeLoadoutTacticalInventory,
  cloneTacticalInventory,
  computeOperatorEncumbrance,
  countCompatibleReserveRounds,
  createAmmoStackItem,
  createLoadedMagazineForWeapon,
  createPopulatedWorldBackpack,
  cycleChamberInWeaponSlot,
  extractItemByLocator,
  findBestReloadMagazine,
  fireRoundFromWeaponSlot,
  getLoadedAmmoCount,
  getWeaponSlotByWeaponId,
  isBackpackTemplateId,
  peekItemByLocator,
  swapMagazineIntoWeapon,
} from '../src/modes/openworld/inventory/TetrisInventoryCore';
import type {
  CorpseTacticalLootSnapshot,
  ItemSourceLocator,
  MedicalItem,
  OperatorEncumbranceState,
  OperatorTacticalInventory,
} from '../src/modes/openworld/inventory/TetrisInventoryTypes';
import type { ExternalLootContext } from '../src/modes/openworld/ui/TacticalInventoryModal';
import {
  computeDerivedWeaponStats,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import { BASE_CALIBERS, getDefaultAmmoVariant, resolveBaseCaliberId } from '../data/calibers';
import {
  fireModeStore,
  getEffectiveFireRpm,
  isSingleShotFireMode,
  shouldCyclePumpOnShot,
} from '../data/fireModeControl';
import { AdaptivePerformanceController, graphicsQualityStore } from '../data/graphicsQuality';
import { keybindStore } from '../data/keybindStore';
import { loadoutStore } from '../data/loadoutStore';
import { HoldRepairController } from '../doors/HoldRepairController';
import { PlayerInteractAnimator } from '../doors/PlayerInteractAnimator';
import type { BrokenElectronicRepairTarget } from './HideoutElectronicsSystem';
import { GunWallSwapChoreography } from './GunWallSwapChoreography';
import type { HideoutPromptOption, HideoutPromptState, InteractReticleState } from './HideoutSessionController';
import type { BunkerNpcInteractMeta } from './BunkerNpcSystem';
import {
  buildZombiesOutpostWorld,
  ZombiesOutpostBriefingState,
  ZombiesOutpostInteractMeta,
  ZombiesOutpostWorldHandle,
} from './ZombiesOutpostWorld';
import { hideoutShardAdapter } from '../src/modes/openworld/HideoutShardAdapter';

export interface ZombiesLobbySnapshot {
  pointerLocked: boolean;
  pauseOpen: boolean;
  locationLabel: string;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  isSwappingRack: boolean;
  interactReticleState: InteractReticleState;
  prompt: HideoutPromptState | null;
  npcCaption: { speaker: string; text: string } | null;
  toastMessage: string | null;
  fps: number;
  masterVolume: number;
  inventoryOpen: boolean;
  tacticalInventory: OperatorTacticalInventory;
  externalLoot: ExternalLootContext | null;
  encumbrance: OperatorEncumbranceState;
}

export interface ZombiesLobbyControllerCallbacks {
  isWeaponUnlocked: (weaponId: string) => boolean;
  onOpenZombiesOps: () => void;
  onQuickDeployInfection?: () => void;
  onCycleInfectionMap?: () => string;
  onCycleInfectionDifficulty?: () => string;
  onCycleInfectionBots?: () => number;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onReturnToHideout: () => void;
}

type ZombiesLobbyListener = (snap: ZombiesLobbySnapshot) => void;

/**
 * Standalone 60+ FPS First-Person Bodycam Controller for the 3D Zombies Quarantine Outpost Lobby.
 * Mounted exclusively while the main Hideout controller is disposed so only one 3D scene runs at a time.
 */
export class ZombiesLobbyController {
  private readonly container: HTMLElement;
  private readonly callbacks: ZombiesLobbyControllerCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly world: ZombiesOutpostWorldHandle;
  private readonly adapter: IBodycamWorldAdapter;
  private readonly ballistics: BallisticsSolver;
  private readonly ejectedLiveRounds: EjectedLiveRoundPool;
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
  private readonly physicsProps: DynamicPhysicsPropSystem;
  private readonly interactAnimator = new PlayerInteractAnimator();
  private readonly holdRepair = new HoldRepairController();
  private readonly unsubOperatorId: () => void;
  private readonly unsubOperatorGear: () => void;
  private readonly unsubLoadout: () => void;
  private readonly adaptivePerf: AdaptivePerformanceController;
  private unsubAdaptiveScaling: (() => void) | null = null;

  private localGear: OperatorGearConfig;
  private config: BodycamSDKConfig = {
    ...DEFAULT_BODYCAM_SDK_CONFIG,
    masterVolume: 0.75,
  };

  private readonly input: BodycamInputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    holdBreath: false,
    leanLeft: false,
    leanRight: false,
    ads: false,
    adsMode: 'PRIMARY',
    cant: false,
    freeZoom: false,
    vault: false,
  };

  private shiftHeld = false;
  private holdBreathHeld = false;
  private freeZoomHeld = false;
  private keyFHeld = false;
  private stamina = 1.0;
  private heartRateBpm = 72;
  private pointerLocked = false;
  private pauseOpen = false;
  private modalActive = false;
  private contextLost = false;
  private disposed = false;

  private equippedWeaponId = 'm4a1';
  private isFiring = false;
  private semiTriggerConsumed = false;
  private fireCooldown = 0;
  private reloadTimer = 0;
  private pendingReloadWeaponId: string | null = null;
  private pendingReloadMagLocator: ItemSourceLocator | null = null;
  private tacticalInventory: OperatorTacticalInventory;
  private encumbrance: OperatorEncumbranceState;
  private inventoryOpen = false;
  private activeExternalLoot: ExternalLootContext | null = null;
  private readonly worldBackpacks: WorldBackpackSystem;
  private readonly magAmmoByWeapon: Record<string, number> = {};

  private activeMeta: ZombiesOutpostInteractMeta | null = null;
  private activeNpcMeta: BunkerNpcInteractMeta | null = null;
  private lastNpcCaptionKey = '';
  private activeElectronicRepair: BrokenElectronicRepairTarget | null = null;
  private activeLiveRound: { id: number; caliberId: string; caliberLabel: string; weaponId: string } | null = null;
  private activeGroundBackpack: { id: string; label: string; itemCount: number } | null = null;
  private activePrompt: HideoutPromptState | null = null;
  private interactReticleState: InteractReticleState = 'hidden';
  private lastTargetKeyId = '';
  private selectedOptionIndex = 0;

  private toastMessage: string | null = null;
  private toastTimeout: number | null = null;
  private returnDeconTimeout: number | null = null;
  private returnTransitionActive = false;
  private returnPressurizationSec = 0;
  private returnSpawnCooldownSec = 2.4;
  private readonly baseCameraFov = 72;

  private rafId = 0;
  private softwareTimerId = 0;
  private lastFrameMs = performance.now();
  private elapsedSec = 0;
  private fpsAccumSec = 0;
  private fpsFrames = 0;
  private currentFps = 60;
  private lastEmitMs = 0;

  private readonly listeners = new Set<ZombiesLobbyListener>();

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
  private readonly _runtimeProfile: BodycamWeaponProfile;
  private readonly _scopePassParams: ScopePassParams;

  constructor(container: HTMLElement, callbacks: ZombiesLobbyControllerCallbacks) {
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
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.baseCameraFov, width / height, 0.08, 160);
    this.scene.add(this.camera);

    this.world = buildZombiesOutpostWorld(this.scene, this.renderer, this.isSoftwareGl);
    this.ballistics = new BallisticsSolver(this.scene);
    this.ejectedLiveRounds = new EjectedLiveRoundPool(this.scene);
    this.adapter = this.world.physics.createAdapter();

    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.audio.setInteriorAcoustics(false, 'concrete');

    this.physicsProps = new DynamicPhysicsPropSystem({
      scene: this.scene,
      adapter: createBodycamPhysicsPropAdapter(this.world.physics),
      isSoftwareGl: this.isSoftwareGl,
      graphicsQuality: gfx.id,
      maxAniso: Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      onImpactAudio: (kind, pos, intensity) => {
        this.audio.playPhysicsPropImpact(kind, pos, intensity);
      },
    });
    this.seedOutpostDynamicProps();

    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.localGear = operatorSelectionStore.getGearConfig();
    this.currentOperatorId = operatorSelectionStore.getSelectedOperator();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(this.currentOperatorId, {
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

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);

    const activeSlot = loadoutStore.getActiveSlot();
    this.tacticalInventory = buildModeLoadoutTacticalInventory({
      primaryWeaponId: activeSlot.primaryWeaponId,
      secondaryWeaponId: activeSlot.secondaryWeaponId,
      backpackId: activeSlot.backpackId ?? undefined,
      mode: 'hideout',
    });
    this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
    const bootBpId = this.tacticalInventory.backpack?.templateId ?? null;
    this.skeleton.setBackpack(bootBpId && isBackpackTemplateId(bootBpId) ? bootBpId : null);

    this.worldBackpacks = new WorldBackpackSystem(this.scene);
    this.seedOutpostPracticeBackpacks();

    // Spawn player stepping off the Armored Transport ramp facing north into the Fortified Outpost
    this.controller.position.set(0, 0, 5.4);
    this.controller.torsoYaw = 0;
    this.controller.aimYaw = 0;
    this.controller.torsoPitch = 0;
    this.controller.aimPitch = 0;

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
      mainAvgLuminance: 0.18,
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

    this.syncOwnedWeapons();

    this.unsubOperatorId = operatorSelectionStore.subscribe((nextOpId) => {
      if (nextOpId === this.currentOperatorId || this.disposed) return;
      this.rebuildOperatorSkeleton(nextOpId);
    });

    this.unsubOperatorGear = operatorSelectionStore.subscribeGear((nextGear) => {
      this.localGear = nextGear;
      this.skeleton.applyUniform(nextGear.uniformId);
      this.skeleton.applyGearConfig(nextGear);
      this.skeleton.setFirstPersonHeadShadowOnly(true);
      this.skeleton.enableArmViewmodelLayer();
    });

    this.unsubLoadout = loadoutStore.subscribe(() => {
      const slot = loadoutStore.getActiveSlot();
      const desiredBp = slot.backpackId ?? null;
      const curBp = this.tacticalInventory.backpack?.templateId ?? null;
      if (desiredBp !== curBp) {
        this.tacticalInventory.backpack = desiredBp
          ? createPopulatedWorldBackpack(desiredBp, slot.primaryWeaponId)
          : null;
        this.refreshEncumbranceAndBackpackVisual();
      }
      if (!this.swapChoreography.isActive()) {
        this.applyEquippedWeaponRig(this.equippedWeaponId, false);
        this.world.syncGunWallSlots(hideoutShardAdapter.getWallRackSlots());
        this.emitSnapshot(true);
      }
    });

    this.bindEvents();

    if (!this.isSoftwareGl) {
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
    const bpId = this.tacticalInventory.backpack?.templateId ?? null;
    this.skeleton.setBackpack(bpId && isBackpackTemplateId(bpId) ? bpId : null);
  }

  private seedOutpostPracticeBackpacks(): void {
    const spots: Array<{
      id: string;
      templateId: 'pack_assault_20l' | 'pack_rucksack_35l' | 'pack_logistics_55l';
      x: number;
      z: number;
      yaw: number;
      label: string;
    }> = [
      {
        id: 'outpost-rack-20l',
        templateId: 'pack_assault_20l',
        x: 6.45,
        z: 0.15,
        yaw: -1.45,
        label: '20L Assault Pack (Outpost)',
      },
      {
        id: 'outpost-rack-35l',
        templateId: 'pack_rucksack_35l',
        x: 6.45,
        z: 1.05,
        yaw: -1.6,
        label: '35L Field Rucksack (Outpost)',
      },
      {
        id: 'outpost-rack-55l',
        templateId: 'pack_logistics_55l',
        x: 6.45,
        z: 1.95,
        yaw: -1.7,
        label: '55L Logistics Frame (Outpost)',
      },
    ];
    for (const s of spots) {
      const pack = createPopulatedWorldBackpack(
        s.templateId,
        this.equippedWeaponId !== 'unarmed' ? this.equippedWeaponId : 'm4a1',
      );
      this.worldBackpacks.spawnBackpack({
        id: s.id,
        backpack: pack,
        position: new THREE.Vector3(s.x, 0, s.z),
        yaw: s.yaw,
        ownerLabel: s.label,
        isPracticeGear: true,
      });
    }
  }

  private refreshEncumbranceAndBackpackVisual(): void {
    this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
    const bpId = this.tacticalInventory.backpack?.templateId ?? null;
    this.skeleton.setBackpack(bpId && isBackpackTemplateId(bpId) ? bpId : null);
  }

  private ensureWeaponInTacticalInventory(weaponId: string): 'primary' | 'secondary' | null {
    if (weaponId === 'unarmed') return null;
    const existing = getWeaponSlotByWeaponId(this.tacticalInventory, weaponId);
    if (existing) return existing;
    const prof = resolveWeaponProfile(weaponId);
    const targetSlot: 'primary' | 'secondary' =
      prof.holdClass === 'pistol' ? 'secondary' : 'primary';
    this.tacticalInventory[targetSlot] = {
      weaponId: prof.id,
      chamberedRound: null,
      loadedMag: createLoadedMagazineForWeapon(prof.id),
    };
    for (let i = 0; i < 2; i++) {
      const spare = createLoadedMagazineForWeapon(prof.id);
      const placedRig = this.tacticalInventory.chestRig
        ? autoPlaceItemInGrid(this.tacticalInventory.chestRig.generalGrid, spare)
        : false;
      if (!placedRig && this.tacticalInventory.backpack) {
        autoPlaceItemInGrid(this.tacticalInventory.backpack.grid, spare);
      }
    }
    this.refreshEncumbranceAndBackpackVisual();
    return targetSlot;
  }

  private syncMagAmmoFromInventory(): void {
    const primary = this.tacticalInventory.primary;
    if (primary.weaponId) {
      this.magAmmoByWeapon[primary.weaponId] = getLoadedAmmoCount(primary);
    }
    const secondary = this.tacticalInventory.secondary;
    if (secondary.weaponId) {
      this.magAmmoByWeapon[secondary.weaponId] = getLoadedAmmoCount(secondary);
    }
    if (this.equippedWeaponId !== 'unarmed') {
      const prof = resolveWeaponProfile(this.equippedWeaponId);
      const curMag = this.magAmmoByWeapon[prof.id] ?? 0;
      this.weaponRig.setAmmoState(curMag, true);
    }
  }

  public openInventory(externalLoot: ExternalLootContext | null = null): void {
    if (this.modalActive || this.pauseOpen || this.returnTransitionActive || this.disposed) return;
    this.inventoryOpen = true;
    this.activeExternalLoot = externalLoot;
    this.clearMovementInputs();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitSnapshot(true);
  }

  public closeInventory(reacquireLock = true): void {
    if (!this.inventoryOpen) return;
    this.inventoryOpen = false;
    this.activeExternalLoot = null;
    this.emitSnapshot(true);
    if (reacquireLock && !this.modalActive && !this.pauseOpen && !this.disposed) {
      this.requestPointerLock();
    }
  }

  public applyInventoryMutation(
    nextInv: OperatorTacticalInventory,
    nextExternal?: CorpseTacticalLootSnapshot | null,
    statusNote?: string,
  ): void {
    this.tacticalInventory = cloneTacticalInventory(nextInv);
    this.refreshEncumbranceAndBackpackVisual();
    this.syncMagAmmoFromInventory();
    if (
      nextExternal !== undefined &&
      this.activeExternalLoot &&
      this.activeExternalLoot.kind === 'ground_backpack' &&
      nextExternal &&
      nextExternal.backpack
    ) {
      this.worldBackpacks.updateContainerContents(
        this.activeExternalLoot.id,
        nextExternal.backpack,
      );
      this.activeExternalLoot = {
        ...this.activeExternalLoot,
        lootKit: nextExternal,
      };
    }
    if (statusNote) this.showToast(statusNote);
    this.emitSnapshot(true);
  }

  public triggerInventoryDragReload(
    weaponSlotKey: 'primary' | 'secondary',
    sourceLocator: ItemSourceLocator,
  ): void {
    const slot = this.tacticalInventory[weaponSlotKey];
    if (!slot.weaponId) return;
    const swap = swapMagazineIntoWeapon(this.tacticalInventory, weaponSlotKey, sourceLocator);
    if (!swap.ok) {
      this.showToast('Incompatible or inaccessible magazine');
      return;
    }
    this.refreshEncumbranceAndBackpackVisual();
    this.syncMagAmmoFromInventory();
    this.audio.playWeaponCue('mag_in', { intensity: 0.78 });
    this.emitSnapshot(true);
  }

  public useMedicalItemFromInventory(locator: ItemSourceLocator, med: MedicalItem): void {
    const extracted = extractItemByLocator(this.tacticalInventory, locator);
    if (!extracted) return;
    this.refreshEncumbranceAndBackpackVisual();
    this.audio.playGearRattle('crouch', 0.45);
    this.showToast(`Applied ${med.name}`);
    this.emitSnapshot(true);
  }

  public dropEquippedBackpack(): boolean {
    if (!this.tacticalInventory.backpack) {
      this.showToast('No backpack equipped');
      return false;
    }
    const dropped = this.tacticalInventory.backpack;
    this.tacticalInventory.backpack = null;
    this.refreshEncumbranceAndBackpackVisual();

    const forward = new THREE.Vector3(
      -Math.sin(this.controller.aimYaw),
      0,
      -Math.cos(this.controller.aimYaw),
    ).normalize();
    const dropPos = this.controller.position.clone().addScaledVector(forward, 1.1);
    const container = this.worldBackpacks.spawnBackpack({
      backpack: dropped,
      position: dropPos,
      yaw: this.controller.aimYaw + Math.PI,
      isPracticeGear: true,
    });
    this.audio.playGearRattle('weapon_swap', 0.72);
    this.showToast(`Dropped ${dropped.name} (${dropped.grid.items.length} items)`);
    if (this.inventoryOpen && !this.activeExternalLoot) {
      this.activeExternalLoot = this.worldBackpacks.buildExternalLootContext(container.id);
    }
    this.emitSnapshot(true);
    return true;
  }

  public equipGroundBackpack(
    containerId: string,
  ): { ok: boolean; error?: string; requiresUnequipFirst?: boolean } {
    const res = this.worldBackpacks.equipFromWorld(containerId, this.tacticalInventory);
    if (!res.ok) {
      if (res.error) this.showToast(res.error);
      return res;
    }
    this.refreshEncumbranceAndBackpackVisual();
    if (this.activeExternalLoot && this.activeExternalLoot.id === containerId) {
      this.activeExternalLoot = null;
    }
    this.audio.playGearRattle('weapon_swap', 0.78);
    if (res.equippedPack) {
      this.showToast(
        `Equipped ${res.equippedPack.name} (${res.equippedPack.grid.items.length} items inside)`,
      );
    }
    this.emitSnapshot(true);
    return res;
  }

  public restockBenchAmmo(): void {
    hideoutShardAdapter.resupplyAllAmmo();
    if (this.equippedWeaponId !== 'unarmed') {
      const prof = resolveWeaponProfile(this.equippedWeaponId);
      const slotKey = this.ensureWeaponInTacticalInventory(prof.id);
      if (slotKey) {
        this.tacticalInventory[slotKey] = {
          weaponId: prof.id,
          chamberedRound: null,
          loadedMag: createLoadedMagazineForWeapon(prof.id),
        };
        const baseCal = resolveBaseCaliberId(prof.caliberLabel);
        const loose = createAmmoStackItem(getDefaultAmmoVariant(baseCal).id, 60);
        const placedLoose = this.tacticalInventory.chestRig
          ? autoPlaceItemInGrid(this.tacticalInventory.chestRig.generalGrid, loose)
          : false;
        if (!placedLoose && this.tacticalInventory.backpack) {
          autoPlaceItemInGrid(this.tacticalInventory.backpack.grid, loose);
        }
        const spare = createLoadedMagazineForWeapon(prof.id);
        const placedSpare = this.tacticalInventory.chestRig
          ? autoPlaceItemInGrid(this.tacticalInventory.chestRig.generalGrid, spare)
          : false;
        if (!placedSpare && this.tacticalInventory.backpack) {
          autoPlaceItemInGrid(this.tacticalInventory.backpack.grid, spare);
        }
        this.refreshEncumbranceAndBackpackVisual();
      }
      this.magAmmoByWeapon[prof.id] = prof.magCapacity;
      this.weaponRig.setAmmoState(prof.magCapacity, true);
    }
    this.audio.playWeaponCue('mag_in', { intensity: 0.85 });
    this.showToast('Outpost Ordnance & Ammunition Resupplied');
    this.emitSnapshot(true);
  }

  public playMagPackTickAudio(): void {
    this.audio.playWeaponCue('mode_toggle', { intensity: 0.32 });
  }

  public syncOwnedWeapons(): void {
    const nextState = hideoutShardAdapter.syncOwnedWeapons(this.callbacks.isWeaponUnlocked);
    this.world.syncGunWallSlots(nextState.wallRackSlots);
    this.applyEquippedWeaponRig(nextState.equippedWeaponId, false);
    this.emitSnapshot(true);
  }

  public syncBriefing(state: ZombiesOutpostBriefingState): void {
    this.world.setBriefingState(state);
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
    if (this.modalActive || this.returnTransitionActive) return;
    this.pauseOpen = false;
    this.audio.ensureInitialized();
    const el = this.renderer.domElement;
    if (document.pointerLockElement !== el && typeof el.requestPointerLock === 'function') {
      try {
        const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      } catch {
        // Ignore gesture rejections
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

  public subscribe(fn: ZombiesLobbyListener): () => void {
    this.listeners.add(fn);
    fn(this.buildSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  public triggerReturnToHideout(): void {
    if (this.returnTransitionActive || this.disposed) return;
    this.returnTransitionActive = true;
    this.returnPressurizationSec = 0;
    this.clearMovementInputs();
    this.world.triggerReturnSeal();
    this.audio.playAirlockSequence('seal');
    this.returnDeconTimeout = window.setTimeout(() => {
      if (!this.disposed) {
        this.audio.playAirlockSequence('decon');
      }
    }, 300);
    this.controller.applyRecoil(0.016, (Math.random() - 0.5) * 0.014, 0.008, 0.2);
    this.callbacks.onReturnToHideout();
    this.emitSnapshot(true);
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

    if (weaponId !== 'unarmed') {
      const slotKey = this.ensureWeaponInTacticalInventory(profile.id);
      if (slotKey) {
        this.magAmmoByWeapon[profile.id] = getLoadedAmmoCount(this.tacticalInventory[slotKey]);
      } else if (this.magAmmoByWeapon[profile.id] === undefined) {
        this.magAmmoByWeapon[profile.id] = profile.magCapacity;
      }
    }
    const curMag = weaponId === 'unarmed' ? 0 : (this.magAmmoByWeapon[profile.id] ?? profile.magCapacity);
    this.weaponRig.setAmmoState(curMag, weaponId !== 'unarmed');
    if (playCue) {
      this.audio.playGearRattle('weapon_swap', 0.5);
    }
  }

  private triggerFieldRackInteraction(slotIndex: number): void {
    if (this.swapChoreography.isActive()) return;
    const slot = this.world.gunWallSlots[slotIndex];
    if (!slot) return;

    const outgoingId = this.equippedWeaponId;
    const incomingId = slot.weaponId;
    if (outgoingId === 'unarmed' && !incomingId) return;

    if (!this.world.getSlotTransform(slotIndex, this._slotPos, this._slotQuat)) return;

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
            ? 'Weapon Mounted on Field Rack'
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

  private tryFireShot(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      this.pauseOpen ||
      this.modalActive ||
      this.returnTransitionActive
    ) {
      return;
    }
    const prof = this.getWeaponProfile(this.equippedWeaponId);
    const currentAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
    if (
      this.fireCooldown > 0 ||
      this.reloadTimer > 0 ||
      this.weaponRig.isBlockingFiringAction() ||
      this.controller.isSprinting
    ) {
      return;
    }
    const effectiveMode = fireModeStore.getEffectiveMode(prof);
    const isSingle = isSingleShotFireMode(effectiveMode);
    if (isSingle && this.semiTriggerConsumed) return;

    if (currentAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.showToast('Empty Magazine — Press R to Reload');
      return;
    }

    const slotKey = this.ensureWeaponInTacticalInventory(prof.id);
    if (slotKey) {
      fireRoundFromWeaponSlot(this.tacticalInventory[slotKey]);
      this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
    }
    const remaining = slotKey
      ? getLoadedAmmoCount(this.tacticalInventory[slotKey])
      : currentAmmo - 1;
    this.magAmmoByWeapon[prof.id] = remaining;
    const effectiveRpm = getEffectiveFireRpm(prof, effectiveMode);
    this.fireCooldown = 60 / Math.max(25, effectiveRpm);
    if (isSingle) this.semiTriggerConsumed = true;

    const derived = this.weaponRig.getDerivedStats();
    const calId = resolveBaseCaliberId(derived.caliberOverride ?? prof.defaultCaliberId);
    const ammo = getDefaultAmmoVariant(calId);
    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    this.ballistics.spawnShot({
      origin: this._muzzlePos,
      direction: this._muzzleDir,
      ammo,
      weaponId: prof.id,
      barrelVelocityMult: prof.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: derived.velocityMult,
      weaponSpreadMOA: Math.hypot(prof.spreadMOA, ammo.spreadMOA),
      audio: this.audio,
    });
    const muzzleVel = ammo.baseVelocityMs * (prof.barrelVelocityMult ?? 1.0) * derived.velocityMult;
    const shotImpulse = THREE.MathUtils.clamp((ammo.bulletMassGrams * muzzleVel) / 4500, 0.75, 1.65);
    this.physicsProps.handleBulletRay(this._muzzlePos, this._muzzleDir, 85, shotImpulse);
    this.weaponRig.triggerFire(
      derived.isSuppressed,
      remaining,
      shouldCyclePumpOnShot(prof, effectiveMode),
    );
    this.weaponRig.setAmmoState(remaining, true);
    this.controller.applyRecoil(
      prof.recoilPitchRad,
      prof.recoilYawRad,
      prof.kickBackM,
      this.config.sightMisalignStrength,
    );
    const audioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this.audio.playWeaponCue('fire', {
      position: this._muzzlePos,
      weightClass: audioWeight,
      caliberId: ammo.caliberId,
      suppressed: derived.isSuppressed,
      isSubsonic: ammo.isSubsonic,
      muzzleComp: derived.hasCompensator,
    });
    this.emitSnapshot(false);
  }

  private handleBallisticImpact(ev: Readonly<BallisticImpactEvent>): void {
    this.camera.getWorldPosition(this._camPos);
    const elecHit = this.world.electronics.handleImpact(
      ev.object,
      ev.point,
      ev.normal,
      this._camPos,
    );
    if (elecHit) {
      if (!elecHit.alreadyBroken) {
        this.showToast(`${elecHit.label} Damaged — Hold [F] to Repair`);
      }
      return;
    }
    const matType =
      ev.surface === 'metal' ? 'metal' : ev.surface === 'wood' ? 'wood' : 'concrete';
    this.audio.playImpact(ev.point, matType);
  }

  private seedOutpostDynamicProps(): void {
    // Wind-blown quarantine evacuation notices & tactical dossiers across the night tarmac yard
    this.physicsProps.seedCluster('wind_street_papers', 0.0, 0.0, -0.8, 201);
    this.physicsProps.seedCluster('wind_street_papers', -4.5, 0.0, 3.2, 202);
    this.physicsProps.seedCluster('wind_street_papers', 4.8, 0.0, 2.8, 203);

    // Shootable glass bottles & cans lined along the Field Weapon Rack bench lip & Field Med Bench
    this.physicsProps.spawnBatch([
      { kind: 'glass_bottle_green', x: -6.35, y: 0.69, z: -6.82, yaw: 0.3 },
      { kind: 'glass_bottle_amber', x: -6.08, y: 0.69, z: -6.86, yaw: 1.2 },
      { kind: 'soda_can', x: -1.92, y: 0.69, z: -6.84, yaw: -0.5 },
      { kind: 'ration_tin', x: -1.68, y: 0.69, z: -6.88, yaw: 0.4 },
      // East Field Med Bench (7.6, 0.88, 0.8)
      { kind: 'glass_bottle_amber', x: 7.45, y: 0.89, z: -0.15, yaw: 0.8 },
      { kind: 'soda_can', x: 7.72, y: 0.89, z: 0.08, yaw: -0.2 },
      { kind: 'paper_sheet', x: 7.55, y: 0.89, z: 1.48, yaw: 0.4 },
      // Field Radio Command Table (5.65, 0.84, -5.45)
      { kind: 'soda_can', x: 5.18, y: 0.85, z: -5.22, yaw: 1.1 },
      { kind: 'paper_sheet', x: 6.08, y: 0.85, z: -5.65, yaw: -0.35 },
      // NW timber staging pallet (-8.8, 0.14, -5.6)
      { kind: 'cardboard_box', x: -9.05, y: 0.14, z: -5.75, yaw: 0.08 },
      { kind: 'plastic_crate', x: -8.52, y: 0.14, z: -5.42, yaw: -0.1 },
      { kind: 'glass_bottle_green', x: -8.85, y: 0.14, z: -5.22, yaw: 0.5 },
    ]);

    // Sandbag revetment & perimeter drum litter
    this.physicsProps.seedCluster('floor_trash', -9.2, 0.0, 3.4, 204);
    this.physicsProps.seedCluster('loading_dock', 8.8, 0.0, -4.4, 205);
    this.physicsProps.seedCluster('range_ledge', -4.1, 0.69, -6.84, 206);
  }

  private startElectronicHoldRepair(target: BrokenElectronicRepairTarget): void {
    this.isFiring = false;
    this.input.ads = false;
    this.holdRepair.start(
      {
        kind: 'ELECTRONICS_REPAIR',
        targetId: target.id,
        label: `Repairing ${target.label}`,
        durationSec: target.durationSec,
        anchorPos: target.anchorPos,
        dynamicAnchorProvider: (out) =>
          this.world.electronics.getRepairAnchorWorldPos(target.id, out),
        onWorkTick: (phaseIndex, pos) => {
          this.world.electronics.playRepairWorkTick(pos, phaseIndex);
        },
        onComplete: () => {
          this.camera.getWorldPosition(this._camPos);
          if (this.world.electronics.repairNode(target.id, this._camPos)) {
            this.showToast(`${target.label} Repaired`);
            this.emitSnapshot(true);
          }
        },
      },
      this.interactAnimator,
    );
    this.emitSnapshot(true);
  }

  private executeSelectedInteract(): void {
    if (this.activeGroundBackpack && !this.activeMeta && !this.activeElectronicRepair) {
      const ctx = this.worldBackpacks.buildExternalLootContext(this.activeGroundBackpack.id);
      if (ctx) {
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.openInventory(ctx);
      }
      return;
    }
    if (this.activeLiveRound && !this.activeMeta && !this.activeElectronicRepair) {
      const collected = this.ejectedLiveRounds.collectRound(this.activeLiveRound.id);
      this.activeLiveRound = null;
      if (collected) {
        hideoutShardAdapter.addReserve(collected.weaponId, 1);
        const baseCal = resolveBaseCaliberId(collected.caliberId);
        addLooseRoundToInventory(this.tacticalInventory, getDefaultAmmoVariant(baseCal).id);
        this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
        this.audio.playGearRattle('crouch', 0.42);
        this.showToast(`+1 ${collected.caliberLabel} Round Recovered`);
        this.emitSnapshot(true);
      }
      return;
    }
    if (this.activeElectronicRepair && !this.activeMeta && !this.activeNpcMeta) {
      this.startElectronicHoldRepair(this.activeElectronicRepair);
      return;
    }

    const prompt = this.activePrompt;
    if (!prompt || prompt.options.length === 0) return;

    const safeIdx = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, prompt.options.length - 1);
    const chosen = prompt.options[safeIdx];
    if (!chosen) return;

    if (this.activeNpcMeta) {
      const npc = this.activeNpcMeta;
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.45 });
      if (chosen.id === 'npc_talk') {
        this.world.npcSystem.triggerNpcLine(npc.npcId);
        this.emitSnapshot(true);
        return;
      }
      if (npc.role === 'outpost_commander') {
        if (chosen.id === 'quick_deploy_infection' && this.callbacks.onQuickDeployInfection) {
          this.setModalActive(true);
          this.callbacks.onQuickDeployInfection();
        } else if (chosen.id === 'cycle_inf_map' && this.callbacks.onCycleInfectionMap) {
          const nextMap = this.callbacks.onCycleInfectionMap();
          this.showToast(`Infection Sector: ${nextMap}`);
        } else {
          this.setModalActive(true);
          this.callbacks.onOpenZombiesOps();
        }
        return;
      }
      if (npc.role === 'outpost_squadmate') {
        if (chosen.id === 'cycle_inf_bots' && this.callbacks.onCycleInfectionBots) {
          const nextBots = this.callbacks.onCycleInfectionBots();
          this.showToast(nextBots === 0 ? 'Allied AI Fireteam: Solo' : `Allied AI Squadmates: +${nextBots}`);
        }
        return;
      }
      return;
    }

    const meta = this.activeMeta;
    if (!meta) return;

    switch (meta.kind) {
      case 'gun_wall_slot': {
        if (typeof meta.slotIndex === 'number') {
          this.triggerFieldRackInteraction(meta.slotIndex);
        }
        break;
      }
      case 'outpost_ops_board':
      case 'outpost_field_radio': {
        if (this.world.electronics.isInteractiveLinkBroken(meta.kind)) {
          const linked = this.world.electronics.getNodeByLinkId(meta.kind);
          if (linked && linked.broken) {
            this.startElectronicHoldRepair({
              id: linked.id,
              label: linked.label,
              anchorPos: linked.anchorPos,
              durationSec: linked.durationSec,
              distanceM: 1.5,
              interactiveLinkId: meta.kind,
            });
          }
          break;
        }
        if (this.world.getPropInteractPos(meta.kind, this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playWeaponCue('mode_toggle', { intensity: 0.5 });
        if (chosen.id === 'quick_deploy_infection' && this.callbacks.onQuickDeployInfection) {
          this.setModalActive(true);
          this.callbacks.onQuickDeployInfection();
        } else if (chosen.id === 'cycle_inf_map' && this.callbacks.onCycleInfectionMap) {
          const nextMap = this.callbacks.onCycleInfectionMap();
          this.showToast(`Infection Sector: ${nextMap}`);
        } else if (chosen.id === 'cycle_inf_diff' && this.callbacks.onCycleInfectionDifficulty) {
          const nextDiff = this.callbacks.onCycleInfectionDifficulty();
          this.showToast(`Threat Difficulty: ${nextDiff}`);
        } else if (chosen.id === 'cycle_inf_bots' && this.callbacks.onCycleInfectionBots) {
          const nextBots = this.callbacks.onCycleInfectionBots();
          this.showToast(nextBots === 0 ? 'Allied AI: Solo' : `Allied AI Squadmates: +${nextBots}`);
        } else {
          this.setModalActive(true);
          this.callbacks.onOpenZombiesOps();
        }
        break;
      }
      case 'outpost_ammo_crate': {
        if (this.world.getPropInteractPos('outpost_ammo_crate', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.world.triggerAmmoCratePop();
        this.restockBenchAmmo();
        break;
      }
      case 'outpost_equip_bench': {
        if (this.world.getPropInteractPos('outpost_equip_bench', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.setModalActive(true);
        if (chosen.id === 'operator_gear') {
          this.callbacks.onOpenOperatorGear();
        } else {
          this.callbacks.onOpenGunsmith();
        }
        break;
      }
      case 'outpost_return_airlock': {
        if (this.world.getPropInteractPos('outpost_return_airlock', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.triggerReturnToHideout();
        break;
      }
    }
  }

  private updateInteractableScan(): void {
    if (
      this.swapChoreography.isActive() ||
      this.pauseOpen ||
      this.modalActive ||
      this.inventoryOpen ||
      this.returnTransitionActive
    ) {
      this.activeMeta = null;
      this.activeNpcMeta = null;
      this.activeGroundBackpack = null;
      this.activePrompt = null;
      this.interactReticleState = 'hidden';
      return;
    }

    const NEAR_EXTRA = 2.2;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._lookDir).normalize();
    this._raycaster.set(this._camPos, this._lookDir);
    this._raycaster.near = 0.08;
    this._raycaster.far = 5.6;

    const hits = this._raycaster.intersectObjects(this.world.interactableMeshes, false);
    let matched: ZombiesOutpostInteractMeta | null = null;
    let matchedNpc: BunkerNpcInteractMeta | null = null;
    let nearDetected = false;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible) continue;
      const npcMeta = h.object.userData.bunkerNpc as BunkerNpcInteractMeta | undefined;
      if (npcMeta) {
        if (h.distance > npcMeta.maxDistanceM + NEAR_EXTRA) continue;
        if (h.distance > 0.55) {
          const blocked = this.adapter.raycast(
            this._camPos,
            this._lookDir,
            0.08,
            h.distance - 0.35,
            this._occlRayHit,
          );
          if (blocked) continue;
        }
        if (h.distance <= npcMeta.maxDistanceM) {
          matchedNpc = npcMeta;
        } else {
          nearDetected = true;
        }
        break;
      }
      const meta = h.object.userData.outpostInteractable as ZombiesOutpostInteractMeta | undefined;
      if (!meta) continue;
      if (meta.kind === 'gun_wall_slot' && typeof meta.slotIndex === 'number') {
        const slot = this.world.gunWallSlots[meta.slotIndex];
        if (!slot?.weaponId && this.equippedWeaponId === 'unarmed') continue;
      }
      if (h.distance > meta.maxDistanceM + NEAR_EXTRA) continue;
      if (h.distance > 0.55) {
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
        matched = meta;
      } else {
        nearDetected = true;
      }
      break;
    }

    const activeRep = this.holdRepair.getState();
    if (activeRep) {
      this.activeMeta = null;
      this.activeNpcMeta = null;
      this.activeElectronicRepair = null;
      this.interactReticleState = 'ready';
      this.activePrompt = {
        key: 'F',
        targetLabel: activeRep.label,
        options: [
          {
            id: 'repair_active',
            label: `${activeRep.label} (${Math.round(activeRep.progress01 * 100)}%)`,
            hint: 'Hold [F]',
          },
        ],
        selectedIndex: 0,
        holdProgress: activeRep.progress01,
        holdLabel: activeRep.label,
      };
      return;
    }

    this.activeMeta = matched;
    this.activeNpcMeta = matchedNpc;
    this.activeElectronicRepair = null;
    this.activeLiveRound = null;
    this.activeGroundBackpack = null;

    if (matchedNpc) {
      const keyId = `npc:${matchedNpc.npcId}`;
      if (keyId !== this.lastTargetKeyId) {
        this.lastTargetKeyId = keyId;
        this.selectedOptionIndex = 0;
      }
      this.interactReticleState = 'ready';
      const opts: HideoutPromptOption[] =
        matchedNpc.role === 'outpost_commander'
          ? [
              { id: 'quick_deploy_infection', label: 'Deploy to Infection Zone' },
              { id: 'open_ops', label: 'Open Infection Briefing Board' },
              { id: 'cycle_inf_map', label: 'Cycle Infection Sector' },
              { id: 'npc_talk', label: 'Talk to Outpost Commander' },
            ]
          : [
              { id: 'cycle_inf_bots', label: 'Cycle Allied AI Squad Count' },
              { id: 'npc_talk', label: 'Check In with Squadmate' },
            ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: matchedNpc.callsign,
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (!matched) {
      const brokenElec = this.world.electronics.findBrokenRepairTarget(
        this._camPos,
        this._lookDir,
        3.2,
      );
      if (brokenElec) {
        this.activeElectronicRepair = brokenElec;
        this.interactReticleState = 'ready';
        this.activePrompt = {
          key: 'F',
          targetLabel: brokenElec.label,
          options: [
            {
              id: 'repair_electronic',
              label: `Repair ${brokenElec.label}`,
              hint: 'Hold [F]',
            },
          ],
          selectedIndex: 0,
          holdProgress: 0,
        };
        return;
      }
      const bpCand = this.worldBackpacks.findInteractable(this._camPos, this._lookDir, 3.05);
      if (bpCand) {
        this.activeGroundBackpack = {
          id: bpCand.id,
          label: bpCand.name,
          itemCount: bpCand.itemCount,
        };
        this.interactReticleState = 'ready';
        this.activePrompt = {
          key: 'F',
          targetLabel: bpCand.name,
          options: [
            {
              id: 'open_ground_backpack',
              label: `Open Backpack (${bpCand.itemCount} items)`,
              hint: this.tacticalInventory.backpack ? 'Transfer / Swap' : 'Loot / Equip',
            },
          ],
          selectedIndex: 0,
        };
        return;
      }
      const liveCand = this.ejectedLiveRounds.findLookedAtPickup(this._camPos, this._lookDir, 2.65);
      if (liveCand) {
        this.activeLiveRound = {
          id: liveCand.id,
          caliberId: liveCand.caliberId,
          caliberLabel: liveCand.caliberLabel,
          weaponId: liveCand.weaponId,
        };
        this.interactReticleState = 'ready';
        this.activePrompt = {
          key: 'F',
          targetLabel: `${liveCand.caliberLabel} Live Round`,
          options: [
            {
              id: 'pickup_live_round',
              label: `Pick up 1x ${liveCand.caliberLabel} Round`,
            },
          ],
          selectedIndex: 0,
        };
        return;
      }
      this.activePrompt = null;
      this.lastTargetKeyId = '';
      this.selectedOptionIndex = 0;
      this.interactReticleState = nearDetected ? 'near' : 'hidden';
      return;
    }

    const keyId = `${matched.kind}:${matched.slotIndex ?? ''}`;
    if (keyId !== this.lastTargetKeyId) {
      this.lastTargetKeyId = keyId;
      this.selectedOptionIndex = 0;
    }
    this.interactReticleState = 'ready';

    if (matched.kind === 'gun_wall_slot' && typeof matched.slotIndex === 'number') {
      const slot = this.world.gunWallSlots[matched.slotIndex];
      const slotWeaponId = slot?.weaponId ?? null;
      if (slotWeaponId) {
        const targetProf = resolveWeaponProfile(slotWeaponId);
        const verb = this.equippedWeaponId === 'unarmed' ? 'Equip' : 'Swap with';
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Field Weapon Rack',
          options: [{ id: 'gun_rack', label: `${verb} ${targetProf.name}` }],
          selectedIndex: 0,
        };
      } else {
        const heldProf = resolveWeaponProfile(this.equippedWeaponId);
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Field Weapon Rack',
          options: [{ id: 'gun_rack', label: `Mount ${heldProf.name} on Rack` }],
          selectedIndex: 0,
        };
      }
      return;
    }

    if (matched.kind === 'outpost_ops_board') {
      if (this.world.electronics.isInteractiveLinkBroken('outpost_ops_board')) {
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Infection Operations Map Board',
          options: [{ id: 'repair_ops_board', label: 'Repair Operations Map Board', hint: 'Hold [F]' }],
          selectedIndex: 0,
          holdProgress: 0,
        };
        return;
      }
      const opts: HideoutPromptOption[] = [
        { id: 'quick_deploy_infection', label: 'Deploy to Infection Zone', hint: 'Breach' },
        { id: 'open_ops', label: 'Open Full Infection Briefing' },
        { id: 'cycle_inf_map', label: 'Cycle Infection Sector' },
        { id: 'cycle_inf_diff', label: 'Cycle Threat Difficulty' },
        { id: 'cycle_inf_bots', label: 'Cycle Allied AI Squadmates (0–3)' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Infection Operations Map Board',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (matched.kind === 'outpost_field_radio') {
      if (this.world.electronics.isInteractiveLinkBroken('outpost_field_radio')) {
        this.activePrompt = {
          key: 'F',
          targetLabel: 'Tactical Field Radio',
          options: [{ id: 'repair_radio', label: 'Repair Tactical Field Radio', hint: 'Hold [F]' }],
          selectedIndex: 0,
          holdProgress: 0,
        };
        return;
      }
      const opts: HideoutPromptOption[] = [
        { id: 'open_ops', label: 'Infection Briefing & Squad Dispatch' },
        { id: 'cycle_inf_bots', label: 'Cycle Allied AI Squadmates (0–3)' },
        { id: 'quick_deploy_infection', label: 'Deploy to Infection Zone' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Tactical Field Radio',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (matched.kind === 'outpost_ammo_crate') {
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Military Ordnance Crate',
        options: [{ id: 'resupply', label: 'Resupply Ammunition & Gear' }],
        selectedIndex: 0,
      };
      return;
    }

    if (matched.kind === 'outpost_equip_bench') {
      const opts: HideoutPromptOption[] = [
        { id: 'gunsmith', label: 'Field Gunsmith & Loadout' },
        { id: 'operator_gear', label: 'Operator Gear & Rig' },
      ];
      this.selectedOptionIndex = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, opts.length - 1);
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Field Medical & Equipment Bench',
        options: opts,
        selectedIndex: this.selectedOptionIndex,
      };
      return;
    }

    if (matched.kind === 'outpost_return_airlock') {
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Armored APC · Return Transport',
        options: [{ id: 'return_hideout', label: 'Board APC Escort → Return to Hideout' }],
        selectedIndex: 0,
      };
    }
  }

  private showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimeout !== null) window.clearTimeout(this.toastTimeout);
    this.toastTimeout = window.setTimeout(() => {
      this.toastMessage = null;
      this.toastTimeout = null;
      this.emitSnapshot(true);
    }, 2400);
    this.emitSnapshot(true);
  }

  private triggerChamberCycle(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.swapChoreography.isActive() ||
      this.weaponRig.isSuppressorActionActive() ||
      this.weaponRig.isChamberCycling() ||
      this.reloadTimer > 0 ||
      this.controller.isVaulting()
    ) {
      return;
    }
    const prof = this.getWeaponProfile(this.equippedWeaponId);
    if (prof.holdClass === 'unarmed' || prof.holdClass === 'melee_1h' || prof.magCapacity <= 0) {
      return;
    }
    const weaponId = prof.id;
    const curMag = this.magAmmoByWeapon[weaponId] ?? prof.magCapacity;
    const hasLiveRound = curMag > 0;
    const baseCal = resolveBaseCaliberId(prof.caliberLabel);
    const caliberLabel = BASE_CALIBERS[baseCal]?.shortLabel ?? baseCal;

    const started = this.animator.triggerChamberCycle({
      hasLiveRound,
      onExtractApex: (pos, quat) => {
        if (this.equippedWeaponId !== weaponId) return;
        const magNow = this.magAmmoByWeapon[weaponId] ?? 0;
        if (magNow <= 0) return;
        const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, weaponId);
        if (slotKey) {
          cycleChamberInWeaponSlot(this.tacticalInventory[slotKey]);
          this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
        }
        const nextMag = slotKey ? getLoadedAmmoCount(this.tacticalInventory[slotKey]) : magNow - 1;
        this.magAmmoByWeapon[weaponId] = nextMag;
        this.weaponRig.setAmmoState(nextMag, true);
        this.controller.getVelocity(this._velScratch);
        this.ejectedLiveRounds.spawnRound({
          position: pos,
          quaternion: quat,
          caliberId: baseCal,
          caliberLabel,
          weaponId,
          holdClass: prof.holdClass,
          carrierVelocity: this._velScratch,
        });
        this.emitSnapshot(true);
      },
      onComplete: () => {
        this.emitSnapshot(true);
      },
    });
    if (started) {
      this.isFiring = false;
      this.emitSnapshot(true);
    }
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
    this.input.freeZoom = false;
    this.input.vault = false;
    this.shiftHeld = false;
    this.holdBreathHeld = false;
    this.freeZoomHeld = false;
    this.keyFHeld = false;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.holdRepair.cancel(this.interactAnimator);
  }

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    this.pointerLocked = locked;
    if (!locked) {
      this.clearMovementInputs();
      if (!this.modalActive && !this.inventoryOpen && !this.disposed && !this.returnTransitionActive) {
        this.pauseOpen = true;
      }
    } else {
      this.pauseOpen = false;
      this.inventoryOpen = false;
      this.activeExternalLoot = null;
    }
    this.emitSnapshot(true);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked || this.pauseOpen || this.modalActive || this.returnTransitionActive) return;
    const dx = THREE.MathUtils.clamp(e.movementX, -140, 140);
    const dy = THREE.MathUtils.clamp(e.movementY, -140, 140);
    this.controller.handleMouseMove(dx, dy, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
    if (this.modalActive || this.pauseOpen || this.returnTransitionActive || keybindStore.isCapturing()) {
      return;
    }
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    this.audio.ensureInitialized();
    const isFireBtn = keybindStore.matchesMouseButton(e.button, 'fire');
    const isAdsBtn = keybindStore.matchesMouseButton(e.button, 'ads');
    const isFreeZoomBtn = keybindStore.matchesMouseButton(e.button, 'free_zoom');
    const isCycleChamberBtn = keybindStore.matchesMouseButton(e.button, 'cycle_chamber');

    if (isFreeZoomBtn) {
      this.freeZoomHeld = true;
      return;
    }
    if (isCycleChamberBtn) {
      this.triggerChamberCycle();
      return;
    }
    if (isAdsBtn && !this.swapChoreography.isActive()) {
      this.animator.interruptInspect();
      this.input.ads = true;
    } else if (isFireBtn && !this.swapChoreography.isActive()) {
      if (this.equippedWeaponId === 'unarmed') {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
      } else {
        this.isFiring = true;
        this.tryFireShot();
      }
    }
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (keybindStore.matchesMouseButton(e.button, 'free_zoom')) {
      this.freeZoomHeld = false;
    }
    if (keybindStore.matchesMouseButton(e.button, 'fire')) {
      this.isFiring = false;
      this.semiTriggerConsumed = false;
    }
    if (keybindStore.matchesMouseButton(e.button, 'ads')) {
      this.input.ads = false;
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.pointerLocked || this.pauseOpen || this.modalActive) return;
    if (this.activePrompt && this.activePrompt.options.length > 1) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const len = this.activePrompt.options.length;
      this.selectedOptionIndex = (this.selectedOptionIndex + dir + len) % len;
      this.activePrompt = { ...this.activePrompt, selectedIndex: this.selectedOptionIndex };
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.2 });
      this.emitSnapshot(true);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.modalActive || this.returnTransitionActive || keybindStore.isCapturing()) return;
    if (e.code === 'Tab' && !e.repeat && !this.pauseOpen) {
      e.preventDefault();
      if (this.inventoryOpen) {
        this.closeInventory(true);
      } else if (this.pointerLocked) {
        this.openInventory(null);
      }
      return;
    }
    if (e.code === 'Escape' && !e.repeat) {
      if (this.inventoryOpen) {
        this.closeInventory(true);
        return;
      }
      if (this.pauseOpen) {
        this.requestPointerLock();
      } else if (!this.pointerLocked) {
        this.pauseOpen = true;
        this.emitSnapshot(true);
      }
      return;
    }
    if (!this.pointerLocked || this.pauseOpen || this.inventoryOpen) return;
    this.audio.ensureInitialized();

    if (keybindStore.matchesKeyCode(e.code, 'hold_breath')) {
      this.holdBreathHeld = true;
    }
    if (keybindStore.matchesKeyCode(e.code, 'free_zoom')) {
      this.freeZoomHeld = true;
    }

    const code = keybindStore.resolveManagedInputCode(e.code);
    if (!code) return;

    switch (code) {
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
        this.input.leanRight = true;
        break;
      case 'KeyF':
        this.keyFHeld = true;
        if (
          !e.repeat &&
          !this.holdRepair.isActive() &&
          (this.activeMeta ||
            this.activeNpcMeta ||
            this.activeElectronicRepair ||
            this.activeLiveRound ||
            this.activeGroundBackpack)
        ) {
          this.executeSelectedInteract();
        }
        break;
      case 'KeyI':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
          this.weaponRig.weaponAnimator.triggerInspect();
        }
        break;
      case 'KeyY':
        if (!e.repeat) {
          this.triggerChamberCycle();
        }
        break;
      case 'KeyK':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const res = fireModeStore.toggle(prof);
          if (res.toggled) {
            this.weaponRig.emitModeToggleCue();
            this.audio.playWeaponCue('mode_toggle', { intensity: 0.55 });
            this.showToast(`Fire Mode: ${res.label}`);
            this.emitSnapshot(true);
          }
        }
        break;
      case 'KeyR':
        if (
          !e.repeat &&
          this.equippedWeaponId !== 'unarmed' &&
          !this.swapChoreography.isActive() &&
          !this.weaponRig.isChamberCycling() &&
          this.reloadTimer <= 0
        ) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const curMag = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
          const slotKey = this.ensureWeaponInTacticalInventory(prof.id);
          const bestMag = slotKey
            ? findBestReloadMagazine(this.tacticalInventory, prof.id)
            : null;
          if (bestMag && curMag < prof.magCapacity) {
            const dur = prof.reloadDurationSec * (bestMag.reloadTimeMult ?? 1);
            this.reloadTimer = dur;
            this.pendingReloadWeaponId = prof.id;
            this.pendingReloadMagLocator = bestMag.locator;
            this.animator.triggerReload(dur);
            if (bestMag.fromBackpack) {
              this.showToast('Drawing spare magazine from Backpack (slower)...');
            }
            this.emitSnapshot(true);
          } else if (curMag < prof.magCapacity) {
            this.showToast('No Loaded Magazine — Press [TAB] to Pack Mags or Resupply');
          }
        }
        break;
      case 'KeyT':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          const on = this.weaponRig.flashlight.intensity <= 0.1;
          this.weaponRig.flashlight.intensity = on ? 6.5 : 0;
          this.audio.playTacticalSwitchClick(on);
        }
        break;
      case 'KeyL':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          this.weaponRig.laserOn = !this.weaponRig.laserOn;
          this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
        }
        break;
      case 'Space':
        e.preventDefault();
        if (!e.repeat) this.input.vault = true;
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (keybindStore.matchesKeyCode(e.code, 'hold_breath')) {
      this.holdBreathHeld = false;
    }
    if (keybindStore.matchesKeyCode(e.code, 'free_zoom')) {
      this.freeZoomHeld = false;
    }
    const code = keybindStore.resolveManagedInputCode(e.code);
    if (!code) return;
    switch (code) {
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
      case 'KeyF':
        this.keyFHeld = false;
        if (this.holdRepair.isActive()) {
          this.holdRepair.cancel(this.interactAnimator);
          this.emitSnapshot(true);
        }
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
      this.softwareTimerId = window.setTimeout(() => {
        if (!this.disposed) this.tick();
      }, 80);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const rawDt = (now - this.lastFrameMs) * 0.001;
    this.lastFrameMs = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    this.elapsedSec += dt;

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
      const profile = this.getWeaponProfile(this.equippedWeaponId);
      const firearmAdsBlocking = this.input.ads && this.equippedWeaponId !== 'unarmed';
      this.input.sprint =
        this.encumbrance.canSprint &&
        this.shiftHeld &&
        this.input.forward &&
        !firearmAdsBlocking &&
        !swapping;
      this.input.holdBreath = this.holdBreathHeld && this.input.ads && this.equippedWeaponId !== 'unarmed' && !swapping;
      this.input.freeZoom =
        this.freeZoomHeld &&
        this.pointerLocked &&
        !this.pauseOpen &&
        !this.modalActive &&
        !this.inventoryOpen &&
        !this.returnTransitionActive;

      if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      if (this.reloadTimer > 0) {
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        if (this.reloadTimer <= 0 && this.pendingReloadWeaponId) {
          const reloadId = this.pendingReloadWeaponId;
          const magLoc = this.pendingReloadMagLocator;
          this.pendingReloadWeaponId = null;
          this.pendingReloadMagLocator = null;
          if (reloadId === this.equippedWeaponId) {
            const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, reloadId);
            if (slotKey && magLoc && peekItemByLocator(this.tacticalInventory, magLoc)) {
              const swap = swapMagazineIntoWeapon(this.tacticalInventory, slotKey, magLoc);
              if (swap.ok) {
                this.refreshEncumbranceAndBackpackVisual();
                this.syncMagAmmoFromInventory();
                this.emitSnapshot(true);
              }
            } else {
              const rProf = resolveWeaponProfile(reloadId);
              const curMag = this.magAmmoByWeapon[rProf.id] ?? 0;
              const taken = hideoutShardAdapter.consumeReserve(rProf.id, Math.max(0, rProf.magCapacity - curMag));
              if (taken > 0) {
                this.magAmmoByWeapon[rProf.id] = curMag + taken;
                this.weaponRig.setAmmoState(curMag + taken, true);
                this.emitSnapshot(true);
              }
            }
          }
        }
      }

      const repairing = this.holdRepair.isActive();
      if (repairing) {
        this.input.ads = false;
        this.input.sprint = false;
        this.isFiring = false;
      }

      const isMoving =
        this.input.forward || this.input.backward || this.input.left || this.input.right;
      if (this.controller.isSprinting && isMoving) {
        this.stamina = Math.max(0, this.stamina - dt * 0.145 * this.encumbrance.staminaDrainMult);
      } else if (this.controller.isHoldBreathActive()) {
        this.stamina = Math.max(0, this.stamina - dt * 0.14);
      } else {
        const regenRate = !isMoving ? (this.input.crouch ? 0.16 : 0.13) : 0.08;
        this.stamina = Math.min(1.0, this.stamina + dt * regenRate);
      }
      const targetHr = THREE.MathUtils.clamp(
        68 + (this.controller.isSprinting ? 34 : isMoving ? 12 : 0) + (1 - this.stamina) * 30,
        64,
        155,
      );
      const hrLerp = targetHr > this.heartRateBpm ? dt * 2.0 : dt * 0.6;
      this.heartRateBpm += (targetHr - this.heartRateBpm) * Math.min(1, hrLerp);
      this.controller.setHeartRateBpm(this.heartRateBpm);

      this.controller.update(
        dt,
        this.elapsedSec,
        this.input,
        this.adapter,
        profile,
        this.config,
        this.stamina,
        100,
        (drainAmt) => {
          this.stamina = Math.max(0, this.stamina - drainAmt * this.encumbrance.staminaDrainMult);
        },
        {
          encumbranceRatio: this.encumbrance.ratio01,
          swayAmpMult: 1 + this.encumbrance.ratio01 * 0.25,
          moveSpeedMult: this.encumbrance.moveSpeedMult,
          staminaDrainMult: this.encumbrance.staminaDrainMult,
          exertionRateMult: this.encumbrance.exertionRateMult,
          canSprint: this.encumbrance.canSprint,
        },
      );
      this.camera.getWorldPosition(this._camPos);
      this.world.update(dt, this._camPos);
      // Nighttime quarantine wind gusts sweeping flyers & cans across the rain-damp tarmac
      const gustStrength = 0.85 + 0.45 * Math.sin(this.elapsedSec * 0.42) + 0.22 * Math.sin(this.elapsedSec * 1.15);
      const windAngle = 0.55 + 0.25 * Math.sin(this.elapsedSec * 0.19);
      this.physicsProps.setWind(Math.cos(windAngle), Math.sin(windAngle), gustStrength);
      this.controller.getVelocity(this._velScratch);
      this.physicsProps.applyActorFootstepWake(
        this.controller.position,
        this._velScratch,
        this.controller.isSprinting ? 0.65 : 0.52,
      );
      this.physicsProps.update(dt, this._camPos);

      if (swapping) {
        this.holdRepair.cancel(this.interactAnimator);
        this.interactAnimator.cancel();
        this.swapChoreography.update(dt, this.camera);
        this.animator.setExternalHandOverride(
          this.swapChoreography.isActive() ? this.swapChoreography.ikOverride : null,
        );
      } else if (this.holdRepair.isActive()) {
        this.holdRepair.step(
          dt,
          this.keyFHeld,
          this.controller.position,
          this.camera,
          this.interactAnimator,
          3.45,
        );
        this.animator.setExternalHandOverride(
          this.interactAnimator.isActive() ? this.interactAnimator.ikOverride : null,
        );
      } else if (this.interactAnimator.isActive()) {
        const still = this.interactAnimator.update(dt, this.camera);
        this.animator.setExternalHandOverride(still ? this.interactAnimator.ikOverride : null);
      } else {
        this.animator.setExternalHandOverride(null);
      }

      this.animator.update(dt, this.elapsedSec, this.controller, this.adapter, profile, this.input.ads);
      this.animator.applyCameraAdditiveOverlay(this.camera);

      // Pressurization camera reaction when boarding return transport back to Hideout
      if (this.returnTransitionActive) {
        this.returnPressurizationSec += dt;
        const p = Math.min(1, this.returnPressurizationSec / 0.72);
        const shake = Math.sin(p * Math.PI) * 0.008;
        this.camera.position.x += Math.sin(this.elapsedSec * 50) * shake;
        this.camera.position.y += Math.cos(this.elapsedSec * 58) * shake * 0.8;
        const targetFov = this.baseCameraFov - p * 4.8;
        if (Math.abs(this.camera.fov - targetFov) > 0.02) {
          this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 7.5, dt);
          this.camera.updateProjectionMatrix();
        }
      }

      this.weaponRig.root.visible = !swapping;

      this.camera.getWorldPosition(this._camPos);
      this.camera.getWorldDirection(this._lookDir).normalize();
      this._camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
      this.audio.updateListener(this._camPos, this._lookDir, this._camUp);

      if (this.returnSpawnCooldownSec > 0) {
        this.returnSpawnCooldownSec = Math.max(0, this.returnSpawnCooldownSec - dt);
      } else if (
        !this.returnTransitionActive &&
        !this.modalActive &&
        !this.pauseOpen &&
        this.world.isInsideReturnRamp(this.controller.position.x, this.controller.position.z)
      ) {
        this.triggerReturnToHideout();
      }

      if (this.isFiring && this.pointerLocked && !this.pauseOpen && !this.modalActive) {
        this.tryFireShot();
      }
      this.ballistics.update(dt, this.adapter, (ev) => this.handleBallisticImpact(ev));
      this.ejectedLiveRounds.update(dt, this.adapter, undefined, this.audio);

      const prevSig = this.activePrompt
        ? `${this.activePrompt.targetLabel ?? ''}|${this.activePrompt.selectedIndex}|${this.activePrompt.options.map((o) => o.label).join(',')}`
        : '';
      const prevReticle = this.interactReticleState;
      this.updateInteractableScan();
      const nextSig = this.activePrompt
        ? `${this.activePrompt.targetLabel ?? ''}|${this.activePrompt.selectedIndex}|${this.activePrompt.options.map((o) => o.label).join(',')}`
        : '';

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

      const liveCap = this.world.npcSystem.getActiveCaption();
      const capKey = liveCap ? `${liveCap.npcId}:${liveCap.text}` : '';
      const capChanged = capKey !== this.lastNpcCaptionKey;
      this.lastNpcCaptionKey = capKey;

      if (nextSig !== prevSig || this.interactReticleState !== prevReticle || capChanged || now - this.lastEmitMs >= 180) {
        this.lastEmitMs = now;
        this.emitSnapshot(false);
      }
    }

    this.scheduleNextFrame();
  };

  private buildSnapshot(): ZombiesLobbySnapshot {
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const ammoInMag =
      this.equippedWeaponId === 'unarmed'
        ? 0
        : (this.magAmmoByWeapon[prof.id] ?? prof.magCapacity);
    return {
      pointerLocked: this.pointerLocked,
      pauseOpen: this.pauseOpen,
      locationLabel: 'Fortified Infection Outpost',
      equippedWeaponId: this.equippedWeaponId,
      equippedWeaponName: this.equippedWeaponId === 'unarmed' ? 'Unarmed' : prof.name,
      equippedCaliber: this.equippedWeaponId === 'unarmed' ? '' : prof.caliberLabel,
      ammoInMag,
      magCapacity: this.equippedWeaponId === 'unarmed' ? 0 : prof.magCapacity,
      ammoReserve:
        this.equippedWeaponId === 'unarmed'
          ? 0
          : (() => {
              const res = countCompatibleReserveRounds(this.tacticalInventory, prof.id);
              return res.rigAndBeltRounds + res.backpackRounds;
            })(),
      isSwappingRack: this.swapChoreography.isActive(),
      interactReticleState: this.interactReticleState,
      prompt: this.activePrompt
        ? {
            ...this.activePrompt,
            options: this.activePrompt.options.map((o) => ({ ...o })),
          }
        : null,
      npcCaption: (() => {
        const cap = this.world.npcSystem.getActiveCaption();
        return cap ? { speaker: cap.speaker, text: cap.text } : null;
      })(),
      toastMessage: this.toastMessage,
      fps: this.currentFps,
      masterVolume: this.config.masterVolume,
      inventoryOpen: this.inventoryOpen,
      tacticalInventory: this.tacticalInventory,
      externalLoot: this.activeExternalLoot,
      encumbrance: this.encumbrance,
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
    if (this.returnDeconTimeout !== null) window.clearTimeout(this.returnDeconTimeout);

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
    this.unsubAdaptiveScaling?.();
    this.unsubAdaptiveScaling = null;

    this.physicsProps.dispose();
    this.ballistics.dispose();
    this.ejectedLiveRounds.dispose();
    this.worldBackpacks.dispose();
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

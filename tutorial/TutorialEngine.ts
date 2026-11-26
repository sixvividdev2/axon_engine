import * as THREE from 'three';
import {
  AdsMode,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamMeleeHitEvent,
  BodycamPostProcess,
  BodycamRaycastResult,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  computeTargetHingeAngularImpulse,
  createBodycamPhysicsPropAdapter,
  createPdaMotionState,
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  DynamicPhysicsPropSystem,
  EjectedLiveRoundPool,
  GrenadeHoldStage,
  IBodycamWorldAdapter,
  IR_LAYER,
  operatorAssetLoader,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  TacticalGrenadeSystem,
  TacticalPdaDevice,
  type PdaTabMode,
  VIEWMODEL_LAYER,
  WeaponRig,
  WorldBackpackSystem,
} from '../bodycam-sdk';
import {
  computeDerivedWeaponStats,
  createBareAttachments,
  getCompatibleAttachments,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  BASE_CALIBERS,
  BaseCaliberId,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../data/calibers';
import {
  fireModeStore,
  formatFireModeLabel,
  getEffectiveFireRpm,
  isSingleShotFireMode,
  shouldCyclePumpOnShot,
} from '../data/fireModeControl';
import { graphicsQualityStore } from '../data/graphicsQuality';
import { keybindStore } from '../data/keybindStore';
import { loadoutStore } from '../data/loadoutStore';
import { getTacticalEquipmentDef, TacticalEquipmentId } from '../data/tacticalEquipment';
import {
  DoorInteractOption,
  DoorInteractOptionId,
} from '../doors/DestructibleDoorSystem';
import { HoldRepairController } from '../doors/HoldRepairController';
import { PlayerInteractAnimator } from '../doors/PlayerInteractAnimator';
import { GymBallistics } from '../gym/GymBallistics';
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
  TUTORIAL_STEPS,
  TutorialCourseSnapshot,
  TutorialCourseStateMachine,
} from './TutorialCourseLogic';
import { buildTutorialWorld, TutorialWorldHandle } from './TutorialWorld';

export interface TutorialDoorPromptState {
  title: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  selectedIndex: number;
}

export interface TutorialRepairState {
  label: string;
  progress01: number;
}

export interface TutorialSnapshot {
  course: TutorialCourseSnapshot;
  pointerLocked: boolean;
  pauseOpen: boolean;
  equippedWeaponId: string;
  equippedWeaponName: string;
  fireModeLabel: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  isReloading: boolean;
  armedAdsMode: AdsMode;
  laserOn: boolean;
  flashlightOn: boolean;
  suppressorAttached: boolean;
  nvgActive: boolean;
  grenadeCount: number;
  grenadeStage: GrenadeHoldStage;
  isPdaOpen: boolean;
  inventoryOpen: boolean;
  tacticalInventory: OperatorTacticalInventory;
  externalLoot: ExternalLootContext | null;
  encumbrance: OperatorEncumbranceState;
  doorPrompt: string | null;
  doorPromptState: TutorialDoorPromptState | null;
  repairState: TutorialRepairState | null;
  toastMessage: string | null;
  masterVolume: number;
}

type Listener = (snap: TutorialSnapshot) => void;

function detectSoftwareWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function buildTutorialM4Attachments(): WeaponAttachments {
  const base = createBareAttachments();
  const optics = getCompatibleAttachments('m4_556', 'optic');
  const canteds = getCompatibleAttachments('m4_556', 'canted');
  const muzzles = getCompatibleAttachments('m4_556', 'muzzle');
  const tacticals = getCompatibleAttachments('m4_556', 'tactical');

  const optic = optics.find((a) => !a.adsZoomFactor || a.adsZoomFactor <= 1.1) ?? optics[0];
  const canted = canteds[0];
  const suppressor = muzzles.find((a) => a.isSuppressor) ?? muzzles[0];
  const tac =
    tacticals.find((a) => a.enablesLaser && a.enablesFlashlight) ??
    tacticals.find((a) => a.enablesFlashlight) ??
    tacticals[0];

  return normalizeWeaponAttachments('m4_556', {
    ...base,
    optic: optic?.id ?? null,
    canted: canted?.id ?? null,
    muzzle: suppressor?.id ?? null,
    tactical: tac?.id ?? null,
  });
}

/**
 * Self-contained, lightweight 3D Mechanics Walkthrough Tutorial engine.
 * Reuses the real Bodycam SDK (controller, weapon rig, IK skeleton, grenades, NVG, 3D TAC-PDA)
 * inside a compact 8-bay killhouse training course.
 */
export class TutorialEngine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly world: TutorialWorldHandle;
  private readonly adapter: IBodycamWorldAdapter;
  private readonly audio: BodycamAudio;
  private readonly weaponRig: WeaponRig;
  private readonly skeleton: CharacterSkeleton;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly pdaDevice: TacticalPdaDevice;
  private readonly postProcess: BodycamPostProcess;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly ballistics: GymBallistics;
  private readonly ejectedLiveRounds: EjectedLiveRoundPool;
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private readonly physicsProps: DynamicPhysicsPropSystem;
  private readonly worldBackpacks: WorldBackpackSystem;
  private readonly course: TutorialCourseStateMachine;
  private readonly interactAnimator = new PlayerInteractAnimator();
  private readonly holdRepair = new HoldRepairController();

  private readonly config: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly _pdaMotionScratch = createPdaMotionState();
  private readonly _scopePassParams: ScopePassParams;
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camForward = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _playerVelScratch = new THREE.Vector3();
  private readonly _whipVel = new THREE.Vector2();
  private readonly _doorCenter = new THREE.Vector3();
  private readonly _ikTargetPos = new THREE.Vector3();
  private readonly _repairAnchorScratch = new THREE.Vector3();
  private readonly _blastDirScratch = new THREE.Vector3();
  private readonly _doorRaycaster = new THREE.Raycaster();
  private readonly _doorOcclHit: BodycamRaycastResult = createRaycastResult();
  private readonly irIlluminatorLight: THREE.SpotLight;
  private readonly irIlluminatorTarget = new THREE.Object3D();

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
    freeZoom: false,
    vault: false,
  };

  private readonly attachmentsByWeapon: Record<string, WeaponAttachments> = {};
  private readonly magAmmoByWeapon: Record<string, number> = {};
  private readonly adsModeByWeapon: Record<string, AdsMode> = {};
  private equippedWeaponId = 'm4_556';
  private readonly tacticalEquipmentId: TacticalEquipmentId = 'm67_frag';
  private tacticalInventory!: OperatorTacticalInventory;
  private encumbrance!: OperatorEncumbranceState;
  private inventoryOpen = false;
  private activeExternalLoot: ExternalLootContext | null = null;
  private pendingReloadMagLocator: ItemSourceLocator | null = null;
  private nearbyGroundBackpack: { id: string; name: string; itemCount: number } | null = null;

  private pointerLocked = false;
  private pauseOpen = false;
  private hasEnteredOnce = false;
  private isFiring = false;
  private semiTriggerConsumed = false;
  private sprintHeld = false;
  private holdBreathHeld = false;
  private freeZoomHeld = false;
  private keyFHeld = false;
  private nearbyLiveRound: {
    id: number;
    caliberId: string;
    caliberLabel: string;
    weaponId: string;
  } | null = null;
  private flashlightOn = false;
  private nvgFlipped = false;
  private grenadeCount = 6;
  private fireCooldown = 0;
  private reloadTimer = 0;
  private stamina = 1.0;
  private elapsedSec = 0;
  private lastTickMs = performance.now();
  private uiEmitTimer = 0;
  private moveDistAccum = 0;
  private sprintTimeAccum = 0;
  private prevPosX = 0;
  private prevPosZ = 22;
  private wasVaulting = false;
  private doorPrompt: string | null = null;
  private activeDoorId: string | null = null;
  private activeDoorTitle = '';
  private activeDoorOptions: DoorInteractOption[] = [];
  private selectedDoorOptionIndex = 0;
  private toastMessage: string | null = null;
  private toastTimer = 0;
  private contextLost = false;
  private disposed = false;
  private frameId = 0;
  private listeners = new Set<Listener>();

  constructor(container: HTMLElement) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGL();

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const qProfile = graphicsQualityStore.getProfile();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, qProfile.maxDpr, 2),
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && qProfile.castShadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // Managed by BodycamPostProcess
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.08, 160);
    this.scene.add(this.camera);

    this.world = buildTutorialWorld(this.scene, this.renderer, this.isSoftwareGl);
    this.adapter = this.world.physics.createAdapter({
      getTraumaModifiers: () => DEFAULT_TRAUMA_MODIFIERS,
      onMeleeHit: (ev) => this.handleMeleeHit(ev),
    });

    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.world.doorSystem.setAudioVolume(this.config.masterVolume);

    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const baseGear = operatorSelectionStore.getGearConfig();
    // Ensure NVG mount is equipped during the tutorial so Bay 06 Night Vision always works
    const tutorialGear = {
      ...baseGear,
      helmetType: 'mil_tec' as const,
      nvgMount: baseGear.nvgMount === 'none' ? ('arnvg' as const) : baseGear.nvgMount,
    };
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      operatorSelectionStore.getSelectedOperator(),
      {
        maxAnisotropy: maxAniso,
        uniformId: tutorialGear.uniformId,
        gear: tutorialGear,
        previewMode: false,
        validationMode: 'SAFE_FALLBACK',
      },
    );
    this.skeleton = loadedOp.skeleton;
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.scene.add(this.skeleton.root);

    // Helmet IR floodlight strictly on IR_LAYER for Bay 06 NVG alcove
    this.irIlluminatorLight = new THREE.SpotLight(
      0xdceeff,
      7.5,
      36,
      THREE.MathUtils.degToRad(38),
      0.55,
      1.3,
    );
    this.irIlluminatorLight.position.set(0.03, 0.06, -0.08);
    this.irIlluminatorLight.visible = false;
    this.irIlluminatorLight.layers.set(IR_LAYER);
    this.irIlluminatorTarget.position.set(0, 0, -12);
    this.camera.add(this.irIlluminatorLight, this.irIlluminatorTarget);
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
    this.ejectedLiveRounds = new EjectedLiveRoundPool(this.scene);

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
      onDetonate: (ev) => {
        // Blast shatters bottles, sends cans/boxes/papers flying, and can blast-breach Bay 05 door!
        if (ev.kind !== 'smoke') {
          this.physicsProps.handleBlast(ev.position, 8.5, 18.0);
          if (this.world.doorSystem.getDoorCenterWorldPos(this.world.doorId, this._doorCenter)) {
            if (ev.position.distanceTo(this._doorCenter) < 4.8) {
              this._blastDirScratch.subVectors(this._doorCenter, ev.position);
              this._blastDirScratch.y = 0;
              if (this._blastDirScratch.lengthSq() < 1e-4) {
                this._blastDirScratch.set(0, 0, -1);
              } else {
                this._blastDirScratch.normalize();
              }
              this.world.doorSystem.executeKick(
                this.world.doorId,
                this._blastDirScratch,
                6.2,
                true,
                undefined,
                false,
                undefined,
                ev.position,
              );
              this.course.recordEvent('door_interact');
            }
          }
        }
        // Safe training detonation — no self-damage, restock if empty
        if (this.grenadeCount <= 1) this.grenadeCount = 6;
        this.emitSnapshot();
      },
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);

    this.physicsProps = new DynamicPhysicsPropSystem({
      scene: this.scene,
      adapter: createBodycamPhysicsPropAdapter(this.world.physics),
      isSoftwareGl: this.isSoftwareGl,
      graphicsQuality: qProfile.id,
      maxAniso,
      onImpactAudio: (kind, pos, intensity) => {
        this.audio.playPhysicsPropImpact(kind, pos, intensity);
      },
    });
    this.seedTutorialDynamicProps();

    this.worldBackpacks = new WorldBackpackSystem(this.scene);
    this.seedTutorialWorldBackpacks();

    this.course = new TutorialCourseStateMachine({
      onTaskComplete: (label) => {
        this.audio.playTacticalSwitchClick(true);
        this.showToast(`Completed: ${label}`);
      },
      onStepComplete: (step, allDone) => {
        this.audio.playGearRattle('weapon_swap', 0.65);
        this.showToast(
          allDone
            ? 'Field Training Complete — All Mechanics Cleared!'
            : `${step.bayLabel} Cleared — Advance to Next Station`,
        );
      },
    });

    // Configure fully equipped tutorial training weapons
    this.attachmentsByWeapon['m4_556'] = buildTutorialM4Attachments();
    this.attachmentsByWeapon['pm_9x19'] = createBareAttachments();
    this.attachmentsByWeapon['combat_knife'] = createBareAttachments();
    this.attachmentsByWeapon['unarmed'] = createBareAttachments();

    for (const id of ['m4_556', 'pm_9x19', 'combat_knife', 'unarmed']) {
      const prof = resolveWeaponProfile(id);
      const att = this.attachmentsByWeapon[id];
      const derived = computeDerivedWeaponStats(prof.massKg, prof.barrelLengthM, prof.magCapacity, att);
      this.magAmmoByWeapon[id] = derived.magCapacity;
    }

    this.tacticalInventory = this.buildTutorialInventory();
    this.refreshEncumbranceAndBackpackVisual();
    this.syncMagAmmoFromInventory();

    this.switchWeapon('m4_556', true);
    this.weaponRig.laserOn = false;
    this.weaponRig.setLaserMode('visible_red');

    // Spawn at Bay 01 start
    const first = TUTORIAL_STEPS[0];
    this.teleportTo(first.spawnPos[0], first.spawnPos[1], first.spawnPos[2], first.spawnYaw);
    this.syncWaypoint();

    // Capture crisp aerial map of our 8-bay Killhouse for the 3D TAC-PDA
    this.pdaDevice.captureOrthographicMap({
      renderer: this.renderer,
      scene: this.scene,
      bounds: {
        minX: this.world.physics.boundsMinX - 4,
        maxX: this.world.physics.boundsMaxX + 4,
        minZ: this.world.physics.boundsMinZ - 4,
        maxZ: this.world.physics.boundsMaxZ + 4,
      },
      excludeObjects: [this.skeleton.root, this.weaponRig.root, this.pdaDevice.root],
    });

    if (!this.isSoftwareGl) {
      try {
        this.grenadeSystem.prewarm(
          this.renderer,
          this.scene,
          this.camera,
          this.skeleton.throwHandSocket,
          VIEWMODEL_LAYER,
        );
        this.renderer.compile(this.scene, this.camera);
      } catch {
        // Non-fatal fallback
      }
    }

    this.bindEvents();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.buildSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public requestLock(): void {
    this.audio.ensureInitialized();
    this.pauseOpen = false;
    try {
      const res = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    } catch {
      // Ignore pointer lock rejection
    }
    this.emitSnapshot();
  }

  public setMasterVolume(vol: number): void {
    this.config.masterVolume = THREE.MathUtils.clamp(vol, 0, 1);
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.world.doorSystem.setAudioVolume(this.config.masterVolume);
    this.emitSnapshot();
  }

  public skipCurrentStep(): void {
    this.holdRepair.cancel(this.interactAnimator);
    this.interactAnimator.cancel();
    const next = this.course.skipStep();
    if (!this.course.isCourseComplete()) {
      this.teleportTo(next.spawnPos[0], next.spawnPos[1], next.spawnPos[2], next.spawnYaw);
      if (next.index > 4) {
        this.world.openDoorForSkip();
      }
    }
    this.syncWaypoint();
    this.showToast(`Jumped to ${next.bayLabel}: ${next.title}`);
    this.emitSnapshot();
  }

  public jumpToStep(index: number): void {
    this.holdRepair.cancel(this.interactAnimator);
    this.interactAnimator.cancel();
    const step = this.course.jumpToStep(index);
    this.teleportTo(step.spawnPos[0], step.spawnPos[1], step.spawnPos[2], step.spawnYaw);
    if (step.index > 4) {
      this.world.openDoorForSkip();
    } else {
      this.world.resetDoor();
    }
    this.syncWaypoint();
    this.showToast(`${step.bayLabel}: ${step.title}`);
    this.emitSnapshot();
  }

  public restartCourse(): void {
    this.holdRepair.cancel(this.interactAnimator);
    this.interactAnimator.cancel();
    this.inventoryOpen = false;
    this.activeExternalLoot = null;
    this.pendingReloadMagLocator = null;
    const first = this.course.restart();
    this.world.resetDoor();
    this.ejectedLiveRounds.clear();
    this.nearbyLiveRound = null;
    this.nearbyGroundBackpack = null;
    this.worldBackpacks.clear();
    this.seedTutorialWorldBackpacks();
    this.tacticalInventory = this.buildTutorialInventory();
    this.refreshEncumbranceAndBackpackVisual();
    this.syncMagAmmoFromInventory();
    this.grenadeCount = 6;
    if (this.nvgFlipped) this.toggleNvg(false);
    if (this.pdaDevice.isOpen()) this.pdaDevice.setOpen(false);
    this.switchWeapon('m4_556', true);
    this.teleportTo(first.spawnPos[0], first.spawnPos[1], first.spawnPos[2], first.spawnYaw);
    this.syncWaypoint();
    this.showToast('Field Training Restarted');
    this.emitSnapshot();
  }

  public openInventory(externalLoot: ExternalLootContext | null = null): void {
    if (this.pauseOpen || this.course.isCourseComplete() || this.disposed) return;
    if (this.pdaDevice.isOpen()) {
      this.pdaDevice.setOpen(false);
    }
    this.inventoryOpen = true;
    this.activeExternalLoot = externalLoot;
    this.clearHeldInputs();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitSnapshot();
  }

  public closeInventory(reacquireLock = true): void {
    if (!this.inventoryOpen) return;
    this.inventoryOpen = false;
    this.activeExternalLoot = null;
    this.emitSnapshot();
    if (reacquireLock && !this.pauseOpen && !this.course.isCourseComplete() && !this.disposed) {
      this.requestLock();
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
    this.emitSnapshot();
  }

  public triggerInventoryDragReload(
    weaponSlotKey: 'primary' | 'secondary',
    sourceLocator: ItemSourceLocator,
  ): void {
    const slot = this.tacticalInventory[weaponSlotKey];
    if (!slot) return;
    const swap = swapMagazineIntoWeapon(this.tacticalInventory, weaponSlotKey, sourceLocator);
    if (!swap.ok) {
      this.showToast('Incompatible or inaccessible magazine');
      return;
    }
    this.refreshEncumbranceAndBackpackVisual();
    this.syncMagAmmoFromInventory();
    this.audio.playWeaponCue('mag_in', { intensity: 0.78 });
    this.course.recordEvent('reload');
    this.emitSnapshot();
  }

  public useMedicalItemFromInventory(locator: ItemSourceLocator, med: MedicalItem): void {
    const extracted = extractItemByLocator(this.tacticalInventory, locator);
    if (!extracted) return;
    this.refreshEncumbranceAndBackpackVisual();
    this.audio.playGearRattle('crouch', 0.45);
    this.showToast(`Applied ${med.name}`);
    this.emitSnapshot();
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
    const dropPos = this.controller.position.clone().addScaledVector(forward, 1.15);
    dropPos.y = this.adapter.getGroundHeight(dropPos.x, dropPos.z, this.controller.position.y);
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
    this.emitSnapshot();
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
    this.emitSnapshot();
    return res;
  }

  public restockBenchAmmo(): void {
    const prof = this.getWeaponProfile();
    const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, prof.id);
    if (prof.magCapacity > 0 && slotKey) {
      const freshMag = createLoadedMagazineForWeapon(prof.id);
      const chambered = freshMag.rounds.pop() ?? null;
      this.tacticalInventory[slotKey] = {
        weaponId: prof.id,
        chamberedRound: chambered,
        loadedMag: freshMag,
      };
      const baseCal = resolveBaseCaliberId(prof.caliberLabel);
      const loose = createAmmoStackItem(getDefaultAmmoVariant(baseCal).id, 60);
      if (
        !this.tacticalInventory.chestRig ||
        !autoPlaceItemInGrid(this.tacticalInventory.chestRig.generalGrid, loose, true)
      ) {
        if (this.tacticalInventory.backpack) {
          autoPlaceItemInGrid(this.tacticalInventory.backpack.grid, loose, true);
        }
      }
      const spare = createLoadedMagazineForWeapon(prof.id);
      if (
        !this.tacticalInventory.chestRig ||
        !autoPlaceItemInGrid(this.tacticalInventory.chestRig.generalGrid, spare)
      ) {
        if (this.tacticalInventory.backpack) {
          autoPlaceItemInGrid(this.tacticalInventory.backpack.grid, spare);
        }
      }
      this.refreshEncumbranceAndBackpackVisual();
      this.syncMagAmmoFromInventory();
    }
    this.audio.playWeaponCue('mag_in', { intensity: 0.85 });
    this.showToast('Training Rack Ammo & Magazines Restocked');
    this.emitSnapshot();
  }

  public playMagPackTickAudio(): void {
    this.audio.playTacticalSwitchClick(true);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.holdRepair.cancel(this.interactAnimator);
    this.interactAnimator.cancel();
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    this.unbindEvents();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.worldBackpacks.dispose();
    this.ejectedLiveRounds.dispose();
    this.ballistics.dispose();
    this.physicsProps.dispose();
    this.grenadeSystem.dispose();
    this.pdaDevice.dispose();
    this.scopeRenderer.dispose();
    this.postProcess.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
    this.world.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildTutorialInventory(): OperatorTacticalInventory {
    const activeSlot = loadoutStore.getActiveSlot();
    return buildModeLoadoutTacticalInventory({
      primaryWeaponId: 'm4_556',
      secondaryWeaponId: 'pm_9x19',
      backpackId: activeSlot.backpackId ?? null,
      mode: 'tutorial',
    });
  }

  private seedTutorialWorldBackpacks(): void {
    const spawns: Array<{
      tier: 'pack_assault_20l' | 'pack_rucksack_35l' | 'pack_logistics_55l';
      x: number;
      z: number;
      yaw: number;
    }> = [
      { tier: 'pack_assault_20l', x: -3.2, z: 22.3, yaw: 0.35 },
      { tier: 'pack_rucksack_35l', x: -2.2, z: 22.3, yaw: 0.15 },
      { tier: 'pack_logistics_55l', x: -1.1, z: 22.3, yaw: -0.25 },
    ];
    for (const s of spawns) {
      const y = this.adapter.getGroundHeight(s.x, s.z, 1.0);
      const pack = createPopulatedWorldBackpack(s.tier, 'm4_556');
      this.worldBackpacks.spawnBackpack({
        backpack: pack,
        position: new THREE.Vector3(s.x, y, s.z),
        yaw: s.yaw,
        isPracticeGear: true,
      });
    }
  }

  private refreshEncumbranceAndBackpackVisual(): void {
    this.encumbrance = computeOperatorEncumbrance(this.tacticalInventory);
    const bpId = this.tacticalInventory.backpack?.templateId ?? null;
    this.skeleton.setBackpack(isBackpackTemplateId(bpId) ? bpId : null);
  }

  private syncMagAmmoFromInventory(): void {
    const primary = this.tacticalInventory.primary;
    if (primary) {
      this.magAmmoByWeapon[primary.weaponId] = getLoadedAmmoCount(primary);
    }
    const secondary = this.tacticalInventory.secondary;
    if (secondary) {
      this.magAmmoByWeapon[secondary.weaponId] = getLoadedAmmoCount(secondary);
    }
    const curProf = this.getWeaponProfile();
    if (curProf.magCapacity > 0) {
      this.weaponRig.setAmmoState(this.magAmmoByWeapon[curProf.id] ?? 0);
    }
  }

  private getWeaponProfile(): BodycamWeaponProfile {
    return resolveWeaponProfile(this.equippedWeaponId);
  }

  private getActiveAmmoVariant(weaponId: string): AmmoVariantDef {
    const prof = resolveWeaponProfile(weaponId);
    const cal = resolveBaseCaliberId(prof.caliberLabel);
    return getDefaultAmmoVariant(cal) ?? AMMO_VARIANTS['556_m855'];
  }

  private teleportTo(x: number, y: number, z: number, yaw: number): void {
    this.controller.position.set(x, y, z);
    this.controller.aimYaw = yaw;
    this.controller.aimPitch = 0;
    this.prevPosX = x;
    this.prevPosZ = z;
  }

  private syncWaypoint(): void {
    const snap = this.course.getSnapshot();
    const wp = snap.activeStep.waypointPos;
    this.world.setWaypointPosition(wp[0], wp[1], wp[2], !snap.courseComplete);
  }

  private showToast(msg: string): void {
    this.toastMessage = msg;
    this.toastTimer = 2.6;
  }

  private switchWeapon(weaponId: string, silent = false): void {
    this.holdRepair.cancel(this.interactAnimator);
    const prof = resolveWeaponProfile(weaponId);
    const changed = weaponId !== this.equippedWeaponId;
    this.equippedWeaponId = prof.id;
    this.reloadTimer = 0;
    this.fireCooldown = 0.14;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    const att = this.attachmentsByWeapon[prof.id] ?? createBareAttachments();
    this.weaponRig.setWeaponProfile(prof, att);
    const armed = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
    this.input.adsMode = armed;
    this.input.cant = armed === 'CANTED';
    const derived = this.weaponRig.getDerivedStats();
    if (!derived.hasFlashlight && this.flashlightOn) {
      this.flashlightOn = false;
      this.weaponRig.flashlight.visible = false;
      this.weaponRig.flashlight.intensity = 0;
    }
    if (!silent && changed) {
      this.audio.playGearRattle('weapon_swap', 0.55);
      this.course.recordEvent('weapon_swap');
      this.emitSnapshot();
    }
  }

  private toggleNvg(recordTutorial = true): void {
    this.nvgFlipped = !this.nvgFlipped;
    this.skeleton.setNvgFlipped(this.nvgFlipped);
    this.postProcess.setNvgState('arnvg', this.nvgFlipped, this.nvgFlipped);
    this.weaponRig.setNvgOpticalActive(this.nvgFlipped);
    this.irIlluminatorLight.visible = this.nvgFlipped;
    if (this.nvgFlipped) {
      this.camera.layers.enable(IR_LAYER);
    } else {
      this.camera.layers.disable(IR_LAYER);
    }
    this.audio.playTacticalSwitchClick(this.nvgFlipped);
    this.showToast(this.nvgFlipped ? 'Night Vision: ON (White Phosphor)' : 'Night Vision: OFF');
    if (recordTutorial) {
      this.course.recordEvent('nvg_toggle');
    }
    this.emitSnapshot();
  }

  private toggleFlashlight(): void {
    if (!this.weaponRig.getDerivedStats().hasFlashlight) return;
    this.flashlightOn = !this.flashlightOn;
    this.weaponRig.flashlight.visible = this.flashlightOn;
    this.weaponRig.flashlight.intensity = this.flashlightOn ? 32 : 0;
    this.audio.playTacticalSwitchClick(this.flashlightOn);
    this.course.recordEvent('light_or_laser');
    this.showToast(this.flashlightOn ? 'Weapon Light: ON' : 'Weapon Light: OFF');
    this.emitSnapshot();
  }

  private toggleLaser(): void {
    if (!this.weaponRig.getDerivedStats().hasLaser) return;
    this.weaponRig.laserOn = !this.weaponRig.laserOn;
    this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
    this.course.recordEvent('light_or_laser');
    this.showToast(this.weaponRig.laserOn ? 'Tactical Laser: ON' : 'Tactical Laser: OFF');
    this.emitSnapshot();
  }

  private toggleSuppressor(): void {
    const prof = this.getWeaponProfile();
    const att = this.attachmentsByWeapon[prof.id];
    if (!att || !att.muzzle) return;
    const weaponId = prof.id;
    const res = this.weaponRig.triggerFieldSuppressorToggle((nowAttached) => {
      if (this.equippedWeaponId !== weaponId) return;
      const cur = this.attachmentsByWeapon[weaponId] ?? createBareAttachments();
      this.attachmentsByWeapon[weaponId] = normalizeWeaponAttachments(weaponId, {
        ...cur,
        suppressorStowed: nowAttached ? undefined : true,
      });
      this.weaponRig.setWeaponProfile(prof, this.attachmentsByWeapon[weaponId]);
      this.showToast(nowAttached ? 'Suppressor Attached' : 'Suppressor Stowed');
      this.emitSnapshot();
    });
    if (res !== 'no_suppressor' && res !== 'busy') {
      this.course.recordEvent('accessory');
      this.showToast(res === 'started_attach' ? 'Attaching Suppressor' : 'Detaching Suppressor');
      this.emitSnapshot();
    }
  }

  private startReload(): void {
    const prof = this.getWeaponProfile();
    if (prof.magCapacity <= 0 || this.reloadTimer > 0 || this.weaponRig.isChamberCycling()) return;
    const best = findBestReloadMagazine(this.tacticalInventory, prof.id);
    if (!best) {
      this.showToast(
        `No Loaded Mags — Press [${keybindStore.getLabel('scoreboard_inventory')}] to Pack or Restock`,
      );
      this.emitSnapshot();
      return;
    }
    // Allow tactical reload even on full mag during Bay 04 so the player never gets stuck!
    this.pendingReloadMagLocator = best.locator;
    const reloadSec = Math.max(
      0.8,
      (prof.reloadDurationSec ?? 1.8) * 0.85 * best.reloadTimeMult,
    );
    this.weaponRig.triggerReload(reloadSec);
    this.animator.triggerReload(reloadSec);
    this.reloadTimer = reloadSec;
    this.course.recordEvent('reload');
    this.showToast(best.fromBackpack ? 'Reloading from Backpack...' : 'Reloading...');
    this.emitSnapshot();
  }

  private triggerChamberCycle(): void {
    const prof = this.getWeaponProfile();
    if (
      prof.holdClass === 'unarmed' ||
      prof.holdClass === 'melee_1h' ||
      prof.magCapacity <= 0 ||
      this.reloadTimer > 0 ||
      this.weaponRig.isChamberCycling() ||
      this.controller.isVaulting() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.grenadeSystem.isDrawn() ||
      this.holdRepair.isActive() ||
      this.weaponRig.isSuppressorActionActive() ||
      this.animator.isCombatBusy()
    ) {
      return;
    }

    const weaponId = prof.id;
    const curAmmo = this.magAmmoByWeapon[weaponId] ?? 0;
    const hasLiveRound = curAmmo > 0;
    const calId = resolveBaseCaliberId(prof.caliberLabel);
    const calDef = BASE_CALIBERS[calId];
    const caliberLabel = calDef?.shortLabel ?? prof.caliberLabel;

    this.isFiring = false;
    this.animator.interruptInspect();

    const started = this.animator.triggerChamberCycle({
      hasLiveRound,
      onExtractApex: (portPos, portQuat) => {
        if (this.equippedWeaponId !== weaponId) return;
        const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, weaponId);
        let ejected = false;
        let nextAmmo = this.magAmmoByWeapon[weaponId] ?? 0;
        if (slotKey) {
          const slot = this.tacticalInventory[slotKey];
          const cycled = cycleChamberInWeaponSlot(slot);
          if (cycled.ejectedRound) {
            ejected = true;
            nextAmmo = getLoadedAmmoCount(slot);
            this.refreshEncumbranceAndBackpackVisual();
          }
        } else if (nextAmmo > 0) {
          ejected = true;
          nextAmmo = nextAmmo - 1;
        }
        if (!ejected) return;
        this.magAmmoByWeapon[weaponId] = nextAmmo;
        this.weaponRig.setAmmoState(nextAmmo);
        this.controller.getVelocity(this._playerVelScratch);
        this.ejectedLiveRounds.spawnRound({
          position: portPos,
          quaternion: portQuat,
          caliberId: calId,
          caliberLabel,
          weaponId,
          holdClass: prof.holdClass,
          carrierVelocity: this._playerVelScratch,
        });
        this.emitSnapshot();
      },
      onComplete: () => {
        this.emitSnapshot();
      },
    });

    if (started) {
      this.course.recordEvent('accessory');
      this.showToast(
        hasLiveRound
          ? `Cycling Chamber — Ejecting Live ${caliberLabel}`
          : `Racking ${prof.name} (Chamber Empty)`,
      );
      this.emitSnapshot();
    }
  }

  private tryPickupNearbyLiveRound(): boolean {
    if (!this.nearbyLiveRound) return false;
    const collected = this.ejectedLiveRounds.collectRound(this.nearbyLiveRound.id);
    this.nearbyLiveRound = null;
    if (!collected) return false;
    const variant = getDefaultAmmoVariant(collected.caliberId as BaseCaliberId);
    addLooseRoundToInventory(this.tacticalInventory, variant.id);
    this.refreshEncumbranceAndBackpackVisual();
    this.audio.playGearRattle('crouch', 0.45);
    this.showToast(`+1 ${collected.caliberLabel} Round Recovered`);
    this.emitSnapshot();
    return true;
  }

  private handleMeleeHit(ev: BodycamMeleeHitEvent): void {
    this.course.recordEvent('melee');
    const doorId = ev.object?.userData?.destructibleDoorId as string | undefined;
    if (doorId) {
      if (ev.attackType === 'kick') {
        this.controller.getVelocity(this._playerVelScratch);
        const horizSpeed = Math.hypot(this._playerVelScratch.x, this._playerVelScratch.z);
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
      this.course.recordEvent('door_interact');
      this.emitSnapshot();
      return;
    }

    const steelId = ev.object?.userData?.steelTargetId as string | undefined;
    if (steelId) {
      const st = this.world.steelTargets.find((t) => t.id === steelId);
      if (st) {
        this.camera.getWorldDirection(this._camForward);
        st.hitAngVel += computeTargetHingeAngularImpulse({
          pivot: st.pivot,
          hitPointWorld: ev.point,
          incomingDir: this._camForward,
          impactSpeedMs: 7.5,
          bulletMassGrams: 1800,
          effectiveInertia: 0.24,
          impulseScale: 0.18,
          minDeltaRadSec: 1.5,
          maxDeltaRadSec: 4.5,
        });
        st.hitFlashTimer = 0.08;
        this.audio.playImpact(ev.point, 'steel_plate');
      }
    }
  }

  private attemptFire(): void {
    if (
      this.pdaDevice.isBlockingWeaponActions() ||
      this.grenadeSystem.isDrawn() ||
      this.holdRepair.isActive()
    ) {
      return;
    }
    const prof = this.getWeaponProfile();
    if (prof.holdClass === 'melee_1h') {
      if (!this.semiTriggerConsumed) {
        this.animator.triggerKnifeSlash(this.controller);
        this.course.recordEvent('melee');
        this.semiTriggerConsumed = true;
      }
      return;
    }
    if (prof.holdClass === 'unarmed') {
      if (!this.semiTriggerConsumed) {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
        this.course.recordEvent('melee');
        this.semiTriggerConsumed = true;
      }
      return;
    }
    if (prof.magCapacity <= 0) return;

    const effectiveFireMode = fireModeStore.getEffectiveMode(prof);
    const isSingleShot = isSingleShotFireMode(effectiveFireMode);
    if (isSingleShot && this.semiTriggerConsumed) return;

    if (
      this.reloadTimer > 0 ||
      this.fireCooldown > 0 ||
      this.weaponRig.isBlockingFiringAction() ||
      this.controller.isSprinting ||
      this.controller.isVaulting()
    ) {
      return;
    }
    const current = this.magAmmoByWeapon[prof.id] ?? 0;
    if (current <= 0) {
      this.weaponRig.triggerDryFire();
      this.fireCooldown = 0.25;
      this.semiTriggerConsumed = true;
      this.showToast(`Empty Magazine — Press [${keybindStore.getLabel('reload')}] to Reload`);
      return;
    }

    const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, prof.id);
    let ammo = this.getActiveAmmoVariant(prof.id);
    let remainingAfterShot = current - 1;
    if (slotKey) {
      const slot = this.tacticalInventory[slotKey];
      const firedVariant = fireRoundFromWeaponSlot(slot);
      if (firedVariant) {
        ammo = firedVariant;
      }
      remainingAfterShot = getLoadedAmmoCount(slot);
      this.refreshEncumbranceAndBackpackVisual();
    }
    this.magAmmoByWeapon[prof.id] = remainingAfterShot;
    this.fireCooldown = 60 / Math.max(40, getEffectiveFireRpm(prof, effectiveFireMode));
    if (isSingleShot) {
      this.semiTriggerConsumed = true;
    }

    const derived = this.weaponRig.getDerivedStats();
    const suppressed = derived.isSuppressed;

    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    this.ballistics.fireRound(this._muzzlePos, this._muzzleDir, prof, ammo, derived.velocityMult);
    const muzzleVel = ammo.baseVelocityMs * (prof.barrelVelocityMult ?? 1.0) * derived.velocityMult;
    const shotImpulse = THREE.MathUtils.clamp((ammo.bulletMassGrams * muzzleVel) / 4500, 0.75, 1.65);
    this.physicsProps.handleBulletRay(this._muzzlePos, this._muzzleDir, 70, shotImpulse);
    this.weaponRig.triggerFire(
      suppressed,
      current - 1,
      shouldCyclePumpOnShot(prof, effectiveFireMode),
    );
    if (!suppressed) this.postProcess.triggerNvgFlashSpike(0.45);

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
    const weightClass: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this.audio.playWeaponCue('fire', {
      position: this._muzzlePos,
      weightClass,
      caliberId: ammo.caliberId,
      suppressed,
      isSubsonic: ammo.isSubsonic,
      muzzleComp: derived.hasCompensator,
    });
  }

  private toggleFireMode(): void {
    const prof = this.getWeaponProfile();
    const res = fireModeStore.toggle(prof);
    if (!res.toggled) {
      this.showToast(`${prof.name}: ${res.label} only`);
      this.emitSnapshot();
      return;
    }
    this.weaponRig.emitModeToggleCue();
    this.audio.playWeaponCue('mode_toggle', { intensity: 0.55 });
    this.showToast(`Fire Mode: ${res.label}`);
    this.emitSnapshot();
  }

  private updateDoorScan(): void {
    if (
      this.pauseOpen ||
      this.inventoryOpen ||
      this.pdaDevice.isOpen() ||
      this.holdRepair.isActive()
    ) {
      this.nearbyLiveRound = null;
      this.nearbyGroundBackpack = null;
      if (!this.holdRepair.isActive()) {
        this.activeDoorId = null;
        this.activeDoorOptions = [];
        this.doorPrompt = null;
      }
      return;
    }

    const DOOR_INTERACT_MAX_M = 2.65;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._camForward).normalize();
    this._doorRaycaster.set(this._camPos, this._camForward);
    this._doorRaycaster.near = 0.08;
    this._doorRaycaster.far = DOOR_INTERACT_MAX_M + 0.25;

    const proxies = this.world.doorSystem.getInteractableMeshes();
    const hits = this._doorRaycaster.intersectObjects(proxies, false);

    let matchedId: string | null = null;
    let matchedOptions: DoorInteractOption[] = [];

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible || h.distance > DOOR_INTERACT_MAX_M) continue;
      const doorId = h.object.userData.destructibleDoorId as string | undefined;
      if (!doorId) continue;

      this.controller.getVelocity(this._playerVelScratch);
      const horizSpeed = Math.hypot(this._playerVelScratch.x, this._playerVelScratch.z);
      const opts = this.world.doorSystem.getInteractOptions(
        doorId,
        this.controller.isSprinting,
        horizSpeed,
        this._camPos,
      );
      if (opts.length === 0) continue;

      if (h.distance > 0.5) {
        const blocked = this.adapter.raycast(
          this._camPos,
          this._camForward,
          0.08,
          h.distance - 0.35,
          this._doorOcclHit,
        );
        if (blocked && this._doorOcclHit.object?.userData?.destructibleDoorId !== doorId) {
          continue;
        }
      }

      matchedId = doorId;
      matchedOptions = opts;
      break;
    }

    if (!matchedId) {
      this.activeDoorId = null;
      this.activeDoorTitle = '';
      this.activeDoorOptions = [];
      this.selectedDoorOptionIndex = 0;
      const interactLbl = keybindStore.getLabel('interact');
      const groundPack = this.pointerLocked
        ? this.worldBackpacks.findInteractable(this._camPos, this._camForward)
        : null;
      if (groundPack) {
        this.nearbyGroundBackpack = {
          id: groundPack.id,
          name: groundPack.name,
          itemCount: groundPack.itemCount,
        };
        this.nearbyLiveRound = null;
        this.doorPrompt = `[${interactLbl}] Open ${groundPack.name} (${groundPack.itemCount} items)`;
        return;
      }
      this.nearbyGroundBackpack = null;
      const pickup = this.pointerLocked
        ? this.ejectedLiveRounds.findLookedAtPickup(this._camPos, this._camForward)
        : null;
      this.nearbyLiveRound = pickup;
      this.doorPrompt = pickup
        ? `[${interactLbl}] Pick up 1x ${pickup.caliberLabel} Round`
        : null;
      return;
    }
    this.nearbyLiveRound = null;
    this.nearbyGroundBackpack = null;

    const prevSelectedId = this.activeDoorOptions[this.selectedDoorOptionIndex]?.id;
    const sameDoor = this.activeDoorId === matchedId;
    this.activeDoorId = matchedId;
    this.activeDoorTitle = this.world.doorSystem.getDoor(matchedId)?.label ?? 'Door';
    this.activeDoorOptions = matchedOptions;

    if (sameDoor && prevSelectedId) {
      const keptIdx = matchedOptions.findIndex((o) => o.id === prevSelectedId);
      this.selectedDoorOptionIndex =
        keptIdx >= 0 ? keptIdx : Math.min(this.selectedDoorOptionIndex, matchedOptions.length - 1);
    } else {
      this.selectedDoorOptionIndex = 0;
    }

    const chosen = matchedOptions[this.selectedDoorOptionIndex] ?? matchedOptions[0];
    const interactLbl = keybindStore.getLabel('interact');
    this.doorPrompt = chosen ? `[${interactLbl}] ${chosen.label}` : null;
  }

  private executeActiveDoorOption(): void {
    if (!this.activeDoorId || this.activeDoorOptions.length === 0) return;
    const safeIdx = THREE.MathUtils.clamp(
      this.selectedDoorOptionIndex,
      0,
      this.activeDoorOptions.length - 1,
    );
    const chosen = this.activeDoorOptions[safeIdx];
    if (!chosen) return;

    const doorId = this.activeDoorId;
    const optId = chosen.id as DoorInteractOptionId;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._camForward).normalize();
    this.controller.getVelocity(this._playerVelScratch);
    const horizSpeed = Math.hypot(this._playerVelScratch.x, this._playerVelScratch.z);

    if (optId === 'kick') {
      this.animator.interruptInspect();
      this.input.ads = false;
      this.animator.triggerPushKick(this.controller, DEFAULT_TRAUMA_MODIFIERS);
      this.world.doorSystem.executeKick(
        doorId,
        this._camForward,
        horizSpeed,
        this.controller.isSprinting,
      );
      this.course.recordEvent('door_interact');
      this.course.recordEvent('melee');
      this.emitSnapshot();
      return;
    }

    if (optId === 'repair') {
      if (!this.world.doorSystem.getRepairAnchorWorldPos(doorId, this._repairAnchorScratch)) {
        this.world.doorSystem.getDoorCenterWorldPos(doorId, this._repairAnchorScratch);
      }
      const doorLabel = this.world.doorSystem.getDoor(doorId)?.label ?? 'Door';
      this.isFiring = false;
      this.input.ads = false;
      this.holdRepair.start(
        {
          kind: 'DOOR_REPAIR',
          targetId: doorId,
          label: `Repairing ${doorLabel}`,
          durationSec: 2.3,
          anchorPos: this._repairAnchorScratch,
          dynamicAnchorProvider: (out) =>
            this.world.doorSystem.getRepairAnchorWorldPos(doorId, out),
          onWorkTick: () => {
            this.world.doorSystem.playRepairWorkTick(doorId);
          },
          onComplete: () => {
            this.camera.getWorldPosition(this._camPos);
            this.camera.getWorldDirection(this._camForward).normalize();
            const repaired = this.world.doorSystem.executeOption(doorId, 'repair', {
              actorPos: this._camPos,
              actorForward: this._camForward,
              horizontalSpeedMps: 0,
              isSprinting: false,
            });
            if (repaired) {
              this.course.recordEvent('door_interact');
              this.showToast(`${doorLabel} Repaired`);
              this.emitSnapshot();
            }
          },
        },
        this.interactAnimator,
      );
      this.emitSnapshot();
      return;
    }

    const ok = this.world.doorSystem.executeOption(doorId, optId, {
      actorPos: this._camPos,
      actorForward: this._camForward,
      horizontalSpeedMps: horizSpeed,
      isSprinting: this.controller.isSprinting,
    });
    if (!ok) return;

    this.course.recordEvent('door_interact');

    if (optId === 'open' || optId === 'peek' || optId === 'close_soft') {
      if (this.world.doorSystem.getDoorknobWorldPos(doorId, this._camPos, this._ikTargetPos)) {
        const animKind =
          optId === 'open'
            ? 'DOOR_OPEN'
            : optId === 'peek'
              ? 'DOOR_PEEK'
              : 'DOOR_CLOSE_SOFT';
        this.interactAnimator.trigger(animKind, this._ikTargetPos, (out) =>
          this.world.doorSystem.getDoorknobWorldPos(doorId, this._camPos, out),
        );
      }
    } else if (optId === 'close') {
      if (this.world.doorSystem.getPushFaceWorldPos(doorId, this._camPos, this._ikTargetPos)) {
        this.interactAnimator.trigger('DOOR_CLOSE_PUSH', this._ikTargetPos, (out) =>
          this.world.doorSystem.getPushFaceWorldPos(doorId, this._camPos, out),
        );
      }
    }
    this.emitSnapshot();
  }

  private triggerPdaOrPingAction(source: 'strike' | 'ping'): void {
    const pit = this.world.fireSupportPitCenter;
    if (source === 'strike') {
      this.world.triggerTrainingStrikeBlast(pit.x, pit.z);
      this.physicsProps.handleBlast(pit, 11.5, 22.0);
      this.audio.playMortarExplosion(pit);
      this.showToast('Training Fire Support Impact Confirmed!');
    } else {
      this.audio.playTacticalSwitchClick(true);
      this.showToast('Tactical Ping Placed on Target Zone');
    }
    this.course.recordEvent('pda_action');
    this.emitSnapshot();
  }

  private seedTutorialDynamicProps(): void {
    // Bay 01 staging pallet (-4.8, 0.14, 22.8) & wind-blown range notices
    this.physicsProps.spawnBatch([
      { kind: 'cardboard_box', x: -5.0, y: 0.14, z: 22.9, yaw: 0.08 },
      { kind: 'plastic_crate', x: -4.5, y: 0.14, z: 22.65, yaw: -0.06 },
      { kind: 'soda_can', x: -4.45, y: 0.14, z: 23.08, yaw: 0.4 },
    ]);
    this.physicsProps.seedCluster('wind_street_papers', 1.2, 0.0, 20.5, 401);

    // Bay 03 Marksmanship firing bench (0.9, 1.04, 1.8) & east bottle/can plinking rail (5.1, 0.92, -1.65)
    this.physicsProps.spawnBatch([
      { kind: 'soda_can', x: 0.9, y: 1.05, z: 0.35, yaw: 0.5 },
      { kind: 'paper_sheet', x: 0.9, y: 1.05, z: 3.15, yaw: -0.2 },
      { kind: 'glass_bottle_green', x: 5.1, y: 0.93, z: -2.15, yaw: 0.2 },
      { kind: 'glass_bottle_amber', x: 5.1, y: 0.93, z: -1.85, yaw: 1.1 },
      { kind: 'soda_can', x: 5.1, y: 0.93, z: -1.55, yaw: -0.4 },
      { kind: 'glass_bottle_green', x: 5.1, y: 0.93, z: -1.25, yaw: 0.7 },
      { kind: 'ration_tin', x: 5.1, y: 0.93, z: -1.0, yaw: 0.3 },
    ]);

    // Bay 04 Weapon Handling bench (3.4, 0.90, -7.8) & rack (5.65, -7.8)
    this.physicsProps.spawnBatch([
      { kind: 'soda_can', x: 3.42, y: 0.91, z: -7.72, yaw: 0.6 },
      { kind: 'glass_bottle_amber', x: 3.32, y: 0.91, z: -8.68, yaw: 1.4 },
      { kind: 'cardboard_box', x: 5.65, y: 0.74, z: -8.1, yaw: 0.04 },
      { kind: 'plastic_crate', x: 5.65, y: 1.30, z: -7.5, yaw: -0.04 },
    ]);

    // Bay 05 CQB Breach room floor litter
    this.physicsProps.seedCluster('floor_trash', -3.6, 0.0, -14.2, 402);

    // Bay 07 Grenade Throwing Pit (3.6, 0.0, -32.2) — frag blast shatters glass & launches cans/papers!
    this.physicsProps.seedCluster('bar_bottles', 3.6, 0.0, -32.2, 403);
    this.physicsProps.seedCluster('floor_trash', 3.4, 0.0, -31.8, 404);
    this.physicsProps.spawnBatch([
      { kind: 'cardboard_box', x: 4.2, y: 0.0, z: -32.6, yaw: 0.3 },
      { kind: 'plastic_crate', x: 2.8, y: 0.0, z: -32.8, yaw: -0.2 },
    ]);

    // Bay 08 Observation Desk (-3.2, 1.05, -39.2) & Fire Support Impact Pit (0, 0.0, -43.8)
    this.physicsProps.spawnBatch([
      { kind: 'paper_sheet', x: -3.2, y: 1.06, z: -39.5, yaw: 0.25 },
      { kind: 'soda_can', x: -3.1, y: 1.06, z: -38.6, yaw: -0.4 },
      { kind: 'cardboard_box', x: -0.6, y: 0.0, z: -43.5, yaw: 0.22 },
      { kind: 'plastic_crate', x: 0.75, y: 0.0, z: -44.1, yaw: -0.18 },
    ]);
    this.physicsProps.seedCluster('bar_bottles', 0.0, 0.0, -43.8, 405);
    this.physicsProps.seedCluster('wind_street_papers', 0.0, 0.0, -43.4, 406);
  }

  // ---------------------------------------------------------------------------
  // Event Binding
  // ---------------------------------------------------------------------------

  private readonly onResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postProcess.setSize(w, h);
  };

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    this.pointerLocked = locked;
    if (locked) {
      this.hasEnteredOnce = true;
      this.pauseOpen = false;
      this.inventoryOpen = false;
      this.activeExternalLoot = null;
    } else {
      this.clearHeldInputs();
      if (this.hasEnteredOnce && !this.course.isCourseComplete() && !this.inventoryOpen) {
        this.pauseOpen = true;
      }
    }
    this.emitSnapshot();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    if (this.pdaDevice.isOpen() && this.pdaDevice.isDragging()) {
      this.pdaDevice.applyMouseDelta(e.movementX, e.movementY);
      return;
    }
    this.controller.handleMouseMove(e.movementX, e.movementY, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
    if (!this.pointerLocked) return;
    this.audio.ensureInitialized();

    const isFireBtn = keybindStore.matchesMouseButton(e.button, 'fire');
    const isAdsBtn = keybindStore.matchesMouseButton(e.button, 'ads');
    const isPointAimBtn = keybindStore.matchesMouseButton(e.button, 'point_aim');
    const isFreeZoomBtn = keybindStore.matchesMouseButton(e.button, 'free_zoom');
    const isCycleChamberBtn = keybindStore.matchesMouseButton(e.button, 'cycle_chamber');

    if (isFreeZoomBtn) {
      this.freeZoomHeld = true;
      return;
    }

    if (isFireBtn) {
      if (this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
        return;
      }
      if (this.grenadeSystem.isDrawn()) {
        const stage = this.grenadeSystem.getHoldStage();
        if (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED') {
          this.grenadeSystem.beginThrowInput();
          this.emitSnapshot();
        }
        return;
      }
      this.isFiring = true;
      this.semiTriggerConsumed = false;
      this.attemptFire();
      return;
    }

    if (isAdsBtn) {
      if (this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
        return;
      }
      if (this.grenadeSystem.isDrawn()) {
        const stage = this.grenadeSystem.getHoldStage();
        if (stage === 'DRAWN') {
          if (this.grenadeSystem.pullPin()) {
            this.course.recordEvent('grenade_pin');
            this.showToast(`Pin Pulled — [${keybindStore.getLabel('fire')}] to Throw into Blast Pit`);
            this.emitSnapshot();
          }
        } else if (stage === 'PIN_PULLED') {
          if (this.grenadeSystem.releaseLever()) {
            this.showToast(`Fuse Cooking — Throw Now [${keybindStore.getLabel('fire')}]!`);
            this.emitSnapshot();
          }
        }
        return;
      }
      this.input.ads = true;
      this.course.recordEvent('ads');
      return;
    }

    if (isPointAimBtn) {
      e.preventDefault();
      this.togglePointAim();
      return;
    }

    if (isCycleChamberBtn) {
      this.triggerChamberCycle();
      return;
    }

    // Support side mouse buttons rebound to gameplay actions
    const mouseCode = `Mouse${e.button}`;
    this.handleActionInputDown(mouseCode, false, e);
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
      if (this.pdaDevice.isDragging()) {
        this.pdaDevice.setDragging(false);
      }
      this.isFiring = false;
      this.semiTriggerConsumed = false;
      if (this.grenadeSystem.isThrowInputHeld()) {
        this.grenadeSystem.releaseThrowInput();
        this.emitSnapshot();
      }
    }
    if (keybindStore.matchesMouseButton(e.button, 'ads')) {
      this.input.ads = false;
    }
    const mouseCode = `Mouse${e.button}`;
    this.handleActionInputUp(mouseCode);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.pointerLocked) return;
    if (this.pdaDevice.isOpen()) {
      this.pdaDevice.applyWheel(e.deltaY);
      return;
    }
    if (this.activeDoorOptions.length > 1 && !this.holdRepair.isActive()) {
      const step = e.deltaY > 0 ? 1 : -1;
      const len = this.activeDoorOptions.length;
      this.selectedDoorOptionIndex = (this.selectedDoorOptionIndex + step + len) % len;
      this.audio.playTacticalSwitchClick(true);
      this.emitSnapshot();
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private togglePointAim(): void {
    if (this.pdaDevice.isBlockingWeaponActions() || this.grenadeSystem.isDrawn()) return;
    const prof = this.getWeaponProfile();
    const cur = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
    const next: AdsMode = cur === 'POINT_AIM' ? 'PRIMARY' : 'POINT_AIM';
    this.adsModeByWeapon[prof.id] = next;
    this.input.adsMode = next;
    this.input.cant = false;
    this.audio.playGearRattle('weapon_swap', 0.4);
    this.course.recordEvent('alt_aim');
    this.showToast(next === 'POINT_AIM' ? 'Point Aim Mode: ARMED' : 'Primary Optic ADS');
    this.emitSnapshot();
  }

  private handleActionInputDown(code: string, repeat: boolean, e: Event): void {
    if (!this.pdaDevice.isOpen()) {
      if (keybindStore.matchesKeyCode(code, 'slot_primary')) {
        this.switchWeapon('m4_556');
        return;
      }
      if (keybindStore.matchesKeyCode(code, 'slot_secondary')) {
        this.switchWeapon('pm_9x19');
        return;
      }
      if (keybindStore.matchesKeyCode(code, 'slot_knife')) {
        this.switchWeapon('combat_knife');
        return;
      }
      if (keybindStore.matchesKeyCode(code, 'slot_unarmed')) {
        this.switchWeapon('unarmed');
        return;
      }
    }

    if (keybindStore.matchesKeyCode(code, 'move_forward')) this.input.forward = true;
    if (keybindStore.matchesKeyCode(code, 'move_backward')) this.input.backward = true;
    if (keybindStore.matchesKeyCode(code, 'move_left')) this.input.left = true;
    if (keybindStore.matchesKeyCode(code, 'move_right')) this.input.right = true;
    if (keybindStore.matchesKeyCode(code, 'sprint')) this.sprintHeld = true;
    if (keybindStore.matchesKeyCode(code, 'hold_breath')) this.holdBreathHeld = true;

    if (keybindStore.matchesKeyCode(code, 'crouch') && !repeat) {
      this.controller.toggleCrouch();
      this.course.recordEvent('crouch');
    }
    if (keybindStore.matchesKeyCode(code, 'lean_left') && !this.pdaDevice.isOpen()) {
      this.input.leanLeft = true;
      if (!repeat) this.course.recordEvent('lean');
    }
    if (keybindStore.matchesKeyCode(code, 'lean_right') && !this.pdaDevice.isOpen()) {
      this.input.leanRight = true;
      if (!repeat) this.course.recordEvent('lean');
    }
    if (keybindStore.matchesKeyCode(code, 'vault')) {
      e.preventDefault();
      if (!repeat) {
        if (this.pdaDevice.isOpen()) {
          this.triggerPdaOrPingAction('strike');
        } else {
          this.input.vault = true;
        }
      }
    }
    if (keybindStore.matchesKeyCode(code, 'free_zoom')) {
      this.freeZoomHeld = true;
    }
    if (keybindStore.matchesKeyCode(code, 'point_aim')) {
      e.preventDefault();
      if (!repeat) {
        this.togglePointAim();
      }
    }
    if (
      keybindStore.matchesKeyCode(code, 'cycle_chamber') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      this.triggerChamberCycle();
    }
    if (
      keybindStore.matchesKeyCode(code, 'canted_optic') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      const prof = this.getWeaponProfile();
      if (this.weaponRig.hasCantedOptic()) {
        const cur = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
        const next: AdsMode = cur === 'CANTED' ? 'PRIMARY' : 'CANTED';
        this.adsModeByWeapon[prof.id] = next;
        this.input.adsMode = next;
        this.input.cant = next === 'CANTED';
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.course.recordEvent('alt_aim');
        this.showToast(
          next === 'CANTED'
            ? `Canted Optic: ARMED (${keybindStore.getLabel('ads')})`
            : 'Primary Optic ADS',
        );
        this.emitSnapshot();
      }
    }
    if (
      keybindStore.matchesKeyCode(code, 'switch_fire_mode') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      this.toggleFireMode();
    }
    if (keybindStore.matchesKeyCode(code, 'reload') && !repeat) {
      if (this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      } else {
        this.startReload();
      }
    }
    if (
      keybindStore.matchesKeyCode(code, 'suppressor') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      this.toggleSuppressor();
    }
    if (
      keybindStore.matchesKeyCode(code, 'inspect') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      this.animator.triggerInspect();
      this.course.recordEvent('accessory');
      this.showToast('Inspecting Firearm');
    }
    if (keybindStore.matchesKeyCode(code, 'interact')) {
      this.keyFHeld = true;
      if (!repeat && !this.pdaDevice.isOpen()) {
        if (this.activeDoorId && this.activeDoorOptions.length > 0) {
          this.executeActiveDoorOption();
        } else if (this.nearbyGroundBackpack) {
          const ctx = this.worldBackpacks.buildExternalLootContext(this.nearbyGroundBackpack.id);
          if (ctx) {
            this.openInventory(ctx);
          }
        } else {
          this.tryPickupNearbyLiveRound();
        }
      }
    }
    if (
      keybindStore.matchesKeyCode(code, 'melee_bash') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      const prof = this.getWeaponProfile();
      if (prof.holdClass === 'unarmed') {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
      } else {
        this.animator.triggerArmedBash(this.controller, prof.holdClass);
      }
      this.course.recordEvent('melee');
    }
    if (
      keybindStore.matchesKeyCode(code, 'push_kick') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      this.animator.triggerPushKick(this.controller, DEFAULT_TRAUMA_MODIFIERS);
      this.course.recordEvent('melee');
    }
    if (keybindStore.matchesKeyCode(code, 'flashlight') && !repeat) {
      this.toggleFlashlight();
    }
    if (keybindStore.matchesKeyCode(code, 'laser') && !repeat) {
      this.toggleLaser();
    }
    if (keybindStore.matchesKeyCode(code, 'nvg') && !repeat) {
      this.toggleNvg(true);
    }
    if (
      (keybindStore.matchesKeyCode(code, 'grenade_draw') ||
        keybindStore.matchesKeyCode(code, 'grenade_belt') ||
        code === 'Digit5') &&
      !repeat &&
      !this.pdaDevice.isBlockingWeaponActions()
    ) {
      if (this.grenadeSystem.isDrawn()) {
        this.camera.getWorldDirection(this._camForward);
        this.controller.getVelocity(this._playerVelScratch);
        this.grenadeSystem.holsterOrTossOnSwitch(
          this.camera.position,
          this._camForward,
          this._playerVelScratch,
        );
      } else {
        this.isFiring = false;
        this.input.ads = false;
        this.grenadeSystem.drawGrenade(this.tacticalEquipmentId);
        const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
        this.course.recordEvent('grenade_draw');
        this.showToast(
          `${def.shortName} Drawn — [${keybindStore.getLabel('ads')}] Pull Pin · [${keybindStore.getLabel('fire')}] Throw`,
        );
      }
      this.emitSnapshot();
    }
    if (
      (keybindStore.matchesKeyCode(code, 'pda') ||
        keybindStore.matchesKeyCode(code, 'tactical_map')) &&
      !repeat
    ) {
      const targetTab: PdaTabMode | undefined = keybindStore.matchesKeyCode(code, 'tactical_map')
        ? 'tac_map'
        : undefined;
      const opening = !this.pdaDevice.isOpen();
      if (opening) {
        if (this.grenadeSystem.isDrawn()) {
          this.camera.getWorldDirection(this._camForward);
          this.controller.getVelocity(this._playerVelScratch);
          this.grenadeSystem.holsterOrTossOnSwitch(
            this.camera.position,
            this._camForward,
            this._playerVelScratch,
          );
        }
        this.isFiring = false;
        this.input.ads = false;
        if (targetTab) this.pdaDevice.setActiveTab(targetTab);
        this.pdaDevice.setOpen(true);
        this.course.recordEvent('pda_open');
        this.showToast(
          `TAC-PDA Active — [${keybindStore.getLabel('scoreboard_inventory')}] Fire Support · [${keybindStore.getLabel('vault')}] Call Strike`,
        );
      } else {
        this.pdaDevice.setOpen(false);
      }
      this.emitSnapshot();
    }
    if (keybindStore.matchesKeyCode(code, 'scoreboard_inventory')) {
      e.preventDefault();
      if (!repeat) {
        if (this.pdaDevice.isOpen()) {
          const nextTab: PdaTabMode =
            this.pdaDevice.getActiveTab() === 'fire_support' ? 'tac_map' : 'fire_support';
          this.pdaDevice.setActiveTab(nextTab);
          this.audio.playTacticalSwitchClick(true);
          this.showToast(
            nextTab === 'fire_support'
              ? `PDA: Fire Support Tab — Press [${keybindStore.getLabel('vault')}] to Call Strike`
              : 'PDA: Tactical Map Tab',
          );
          this.emitSnapshot();
        } else {
          this.openInventory(null);
        }
      }
    }
    if (keybindStore.matchesKeyCode(code, 'ping') && !repeat) {
      this.triggerPdaOrPingAction('ping');
    }
  }

  private handleActionInputUp(code: string): void {
    if (keybindStore.matchesKeyCode(code, 'move_forward')) this.input.forward = false;
    if (keybindStore.matchesKeyCode(code, 'move_backward')) this.input.backward = false;
    if (keybindStore.matchesKeyCode(code, 'move_left')) this.input.left = false;
    if (keybindStore.matchesKeyCode(code, 'move_right')) this.input.right = false;
    if (keybindStore.matchesKeyCode(code, 'sprint')) this.sprintHeld = false;
    if (keybindStore.matchesKeyCode(code, 'hold_breath')) this.holdBreathHeld = false;
    if (keybindStore.matchesKeyCode(code, 'free_zoom')) this.freeZoomHeld = false;
    if (keybindStore.matchesKeyCode(code, 'lean_left')) this.input.leanLeft = false;
    if (keybindStore.matchesKeyCode(code, 'lean_right')) this.input.leanRight = false;
    if (keybindStore.matchesKeyCode(code, 'interact')) {
      this.keyFHeld = false;
      if (this.holdRepair.isActive()) {
        this.holdRepair.cancel(this.interactAnimator);
        this.emitSnapshot();
      }
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (keybindStore.isCapturing()) return;
    if (this.inventoryOpen) {
      if (e.code === 'Escape' || keybindStore.matchesKeyCode(e.code, 'scoreboard_inventory')) {
        e.preventDefault();
        if (!e.repeat) {
          this.closeInventory(true);
        }
      }
      return;
    }
    if (!this.pointerLocked) return;
    this.audio.ensureInitialized();
    this.handleActionInputDown(e.code, e.repeat, e);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.handleActionInputUp(e.code);
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
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private unbindEvents(): void {
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('wheel', this.onWheel);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
  }

  private clearHeldInputs(): void {
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.sprintHeld = false;
    this.holdBreathHeld = false;
    this.freeZoomHeld = false;
    this.keyFHeld = false;
    this.holdRepair.cancel(this.interactAnimator);
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.ads = false;
    this.input.holdBreath = false;
    this.input.freeZoom = false;
    this.input.vault = false;
  }

  // ---------------------------------------------------------------------------
  // Frame Loop (with software-WebGL afterDraw pacing per threejs skill)
  // ---------------------------------------------------------------------------

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      if (typeof gl.fenceSync === 'function') {
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = (): void => {
          if (this.disposed) {
            if (sync) gl.deleteSync(sync);
            return;
          }
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            this.frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            this.frameId = window.setTimeout(this.tick, 80);
          }
        };
        this.frameId = window.setTimeout(poll, 5);
      } else {
        this.frameId = window.setTimeout(this.tick, 80);
      }
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const rawDt = Math.max(0.001, (now - this.lastTickMs) / 1000);
    this.lastTickMs = now;
    const dt = Math.min(0.05, rawDt);
    this.elapsedSec += dt;

    if (this.toastTimer > 0) {
      this.toastTimer = Math.max(0, this.toastTimer - dt);
      if (this.toastTimer <= 0) this.toastMessage = null;
    }

    const prof = this.getWeaponProfile();
    const movingForward = this.input.forward && !this.input.backward;
    const canSprint =
      movingForward &&
      !this.input.ads &&
      !this.controller.crouched &&
      !this.pdaDevice.isOpen() &&
      !this.grenadeSystem.isDrawn() &&
      this.encumbrance.canSprint;

    this.input.sprint = this.sprintHeld && canSprint && this.stamina > 0.08;
    this.input.holdBreath = this.holdBreathHeld && this.input.ads && !this.input.sprint;
    this.input.freeZoom =
      this.freeZoomHeld &&
      this.pointerLocked &&
      !this.pauseOpen &&
      !this.inventoryOpen &&
      !this.pdaDevice.isOpen();

    if (this.input.sprint) {
      this.stamina = Math.max(0, this.stamina - 0.16 * this.encumbrance.staminaDrainMult * dt);
    } else {
      this.stamina = Math.min(1, this.stamina + 0.28 * dt);
    }

    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer <= 0) {
        const slotKey = getWeaponSlotByWeaponId(this.tacticalInventory, prof.id);
        if (slotKey && this.pendingReloadMagLocator) {
          swapMagazineIntoWeapon(this.tacticalInventory, slotKey, this.pendingReloadMagLocator);
          this.pendingReloadMagLocator = null;
          this.refreshEncumbranceAndBackpackVisual();
          this.syncMagAmmoFromInventory();
        } else {
          this.pendingReloadMagLocator = null;
          const derived = this.weaponRig.getDerivedStats();
          this.magAmmoByWeapon[prof.id] = derived.magCapacity;
          this.weaponRig.setAmmoState(derived.magCapacity);
        }
        this.emitSnapshot();
      }
    }

    if (this.isFiring && !this.pdaDevice.isOpen() && !this.grenadeSystem.isDrawn()) {
      this.attemptFire();
    }

    // Step Bodycam Controller
    this.controller.update(
      dt,
      this.elapsedSec,
      this.input,
      this.adapter,
      prof,
      this.config,
      this.stamina,
      100,
      undefined,
      {
        encumbranceRatio: this.encumbrance.ratio01,
        swayAmpMult: 1 + this.encumbrance.ratio01 * 0.25,
        moveSpeedMult: this.encumbrance.moveSpeedMult,
        staminaDrainMult: this.encumbrance.staminaDrainMult,
        exertionRateMult: this.encumbrance.exertionRateMult,
        canSprint: this.encumbrance.canSprint,
      },
    );
    this.input.vault = false;

    // Detect Tutorial Events from live controller state
    const pos = this.controller.position;
    const stepMoveDist = Math.hypot(pos.x - this.prevPosX, pos.z - this.prevPosZ);
    this.prevPosX = pos.x;
    this.prevPosZ = pos.z;

    if (this.pointerLocked) {
      this.moveDistAccum += stepMoveDist;
      if (this.moveDistAccum > 1.4) {
        this.course.recordEvent('move');
      }
      if (this.controller.isSprinting && stepMoveDist > 0.02) {
        this.sprintTimeAccum += dt;
        if (this.sprintTimeAccum > 0.35) {
          this.course.recordEvent('sprint');
        }
      }
      const isVaultingNow = this.controller.isVaulting();
      if (isVaultingNow && !this.wasVaulting) {
        this.course.recordEvent('vault');
      }
      this.wasVaulting = isVaultingNow;

      if (this.controller.isHoldBreathActive()) {
        this.course.recordEvent('hold_breath');
      }
    }

    // Raycast scan for Bay 05 Destructible Door & step Hold-to-Repair / 1P interact IK
    this.updateDoorScan();

    if (this.holdRepair.isActive()) {
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
      const stillActive = this.interactAnimator.update(dt, this.camera);
      this.animator.setExternalHandOverride(
        stillActive ? this.interactAnimator.ikOverride : null,
      );
    } else {
      this.animator.setExternalHandOverride(null);
    }

    // Update 3D TAC-PDA
    const activeStep = this.course.getActiveStep();
    this.pdaDevice.setTelemetry({
      playerX: pos.x,
      playerZ: pos.z,
      playerYawRad: this.controller.aimYaw,
      gameClockText: '10:00',
      weatherLabel: 'CLEAR',
      windSpeedMps: 0.3,
      windAngleRad: 0.4,
      modeLabel: 'TRAINING',
      zoneLabel: activeStep.bayLabel.toUpperCase(),
    });
    this.controller.writePdaMotionState(this._pdaMotionScratch);
    this.pdaDevice.update(
      dt,
      this.elapsedSec,
      this._pdaMotionScratch.moveRatio,
      this._pdaMotionScratch.isCrouched,
      this._pdaMotionScratch,
    );

    // Step Full-Body IK Animator
    this.animator.update(dt, this.elapsedSec, this.controller, this.adapter, prof, this.input.ads);
    this.animator.applyCameraAdditiveOverlay(this.camera);

    this.weaponRig.root.visible =
      !this.grenadeSystem.isWeaponHidden() && !this.pdaDevice.isWeaponHidden();
    this.skeleton.root.visible = true;

    // Step Ballistics & detect Bay 03 Steel Target hits + Bay 05 Door bullet chipping/penetration
    this.camera.getWorldPosition(this._camPos);
    this._camRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.ballistics.update(
      dt,
      this.adapter,
      (hitInfo) => {
        if (hitInfo.isSteel) {
          this.course.recordEvent('steel_hit', hitInfo.targetLabel);
          this.emitSnapshot();
        }
      },
      {
        listenerHeadPos: this._camPos,
        listenerRightDir: this._camRight,
        audio: this.audio,
      },
      (ev) => {
        const doorId = ev.object?.userData?.destructibleDoorId as string | undefined;
        if (doorId) {
          this.world.doorSystem.applyBulletImpact(
            doorId,
            ev.point,
            ev.incomingDir,
            Math.max(16, ev.impactEnergyJ * 0.02),
          );
          this.course.recordEvent('door_interact');
        }
      },
    );
    this.ejectedLiveRounds.update(dt, this.adapter, undefined, this.audio);

    // Step Grenade System
    this.grenadeSystem.update(dt, this.camera.position);
    const launched = this.grenadeSystem.consumeLastLaunchedThrow();
    if (launched) {
      this.grenadeCount = Math.max(1, this.grenadeCount - 1);
      this.course.recordEvent('grenade_throw');
      this.emitSnapshot();
    }

    // Step Tutorial World, Dynamic Physics Props & Course Auto-Advance
    this.world.update(dt, this.elapsedSec, this._camPos);
    const tutWindStrength = 0.65 + 0.32 * Math.sin(this.elapsedSec * 0.38);
    this.physicsProps.setWind(0.7, 0.7, tutWindStrength);
    this.controller.getVelocity(this._playerVelScratch);
    this.physicsProps.applyActorFootstepWake(
      this.controller.position,
      this._playerVelScratch,
      this.controller.isSprinting ? 0.65 : 0.52,
    );
    this.physicsProps.update(dt, this.camera.position);
    if (this.course.tick(dt, this.pointerLocked)) {
      this.syncWaypoint();
      if (this.course.isCourseComplete() && document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
      this.emitSnapshot();
    }

    // Render with Bodycam Post-Process
    this.controller.getWhipVelocity(this._whipVel);
    this.postProcess.update(
      dt,
      this.elapsedSec,
      this.config,
      this._whipVel.x,
      this._whipVel.y,
      100,
      false,
      DEFAULT_TRAUMA_MODIFIERS,
      this.controller.getHoldBreathVignette(),
    );

    if (!this.contextLost) {
      this._scopePassParams.dt = dt;
      this.postProcess.render();
    }

    this.uiEmitTimer += dt;
    if (this.uiEmitTimer >= 0.08) {
      this.uiEmitTimer = 0;
      this.emitSnapshot();
    }

    this.scheduleNextFrame();
  };

  private buildSnapshot(): TutorialSnapshot {
    const prof = this.getWeaponProfile();
    const derived = this.weaponRig.getDerivedStats();
    const effectiveMode = fireModeStore.getEffectiveMode(prof);
    const activeRepair = this.holdRepair.getState();
    const reserveCounts =
      prof.magCapacity > 0 ? countCompatibleReserveRounds(this.tacticalInventory, prof.id) : null;
    const ammoReserve = reserveCounts
      ? reserveCounts.rigAndBeltRounds + reserveCounts.backpackRounds
      : 0;
    return {
      course: this.course.getSnapshot(),
      pointerLocked: this.pointerLocked,
      pauseOpen: this.pauseOpen,
      equippedWeaponId: prof.id,
      equippedWeaponName: prof.name,
      fireModeLabel: formatFireModeLabel(effectiveMode),
      ammoInMag: this.magAmmoByWeapon[prof.id] ?? 0,
      magCapacity: derived.magCapacity,
      ammoReserve,
      isReloading: this.reloadTimer > 0,
      armedAdsMode: this.adsModeByWeapon[prof.id] ?? 'PRIMARY',
      laserOn: this.weaponRig.laserOn && derived.hasLaser,
      flashlightOn: this.flashlightOn && derived.hasFlashlight,
      suppressorAttached: derived.isSuppressed,
      nvgActive: this.nvgFlipped,
      grenadeCount: this.grenadeCount,
      grenadeStage: this.grenadeSystem.getHoldStage(),
      isPdaOpen: this.pdaDevice.isOpen(),
      inventoryOpen: this.inventoryOpen,
      tacticalInventory: this.tacticalInventory,
      externalLoot: this.activeExternalLoot,
      encumbrance: this.encumbrance,
      doorPrompt: this.doorPrompt,
      doorPromptState:
        this.activeDoorId && this.activeDoorOptions.length > 0 && !activeRepair
          ? {
              title: this.activeDoorTitle,
              options: this.activeDoorOptions.map((o) => ({
                id: o.id,
                label: o.label,
                hint: o.hint,
              })),
              selectedIndex: THREE.MathUtils.clamp(
                this.selectedDoorOptionIndex,
                0,
                Math.max(0, this.activeDoorOptions.length - 1),
              ),
            }
          : null,
      repairState: activeRepair
        ? {
            label: activeRepair.label,
            progress01: activeRepair.progress01,
          }
        : null,
      toastMessage: this.toastMessage,
      masterVolume: this.config.masterVolume,
    };
  }

  private emitSnapshot(): void {
    const snap = this.buildSnapshot();
    for (const fn of this.listeners) {
      fn(snap);
    }
  }
}

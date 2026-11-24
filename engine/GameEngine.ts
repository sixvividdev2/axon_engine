import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AdsMode, BodycamMeleeHitEvent } from '../bodycam-sdk/types';
import { ScopePassParams, ScopeRenderer } from '../bodycam-sdk/weapons/ScopeRenderer';
import { createBareAttachments, normalizeWeaponAttachments } from '../data/attachments';
import { CALIBERS, CaliberId } from '../data/calibers';
import { ITEMS } from '../data/items';
import { LIMB_CONFIGS, LimbId } from '../data/traumaConfig';
import { EquipSlotKind, WEAPONS, WeaponId, WeaponSpec } from '../data/weapons';
import { ZombieManager } from './ai/ZombieManager';
import { AudioEngine } from './audio/AudioEngine';
import { BallisticsSystem } from './ballistics/BallisticsSystem';
import { CharacterAnimator, SurvivalThrowStyle } from './character/CharacterAnimator';
import { CharacterSkeleton } from './character/CharacterSkeleton';
import { ControllerStateReader } from './character/ControllerStateReader';
import {
  BodycamController,
  BodycamSurvivalModifiers,
  PlayerInputState,
} from './controller/BodycamController';
import {
  cloneItemInstance,
  getItemGridDims,
  getLooseAmmoItemIdForCaliber,
  getMagRoundCount,
  InventoryManager,
  makeInvUid,
  normalizeMagazineItem,
  popRoundFromMag,
  pushRoundToMag,
} from './inventory/InventoryManager';
import { SaveManager } from './persistence/SaveManager';
import { BodycamPostProcess, VIEWMODEL_LAYER } from './render/BodycamPostProcess';
import { AcousticSystem } from './stealth/AcousticSystem';
import { VitalsSystem } from './survival/VitalsSystem';
import { ProceduralTextureLibrary } from './textures/ProceduralTextures';
import { LimbTraumaSystem } from './trauma/LimbTraumaSystem';
import {
  ActiveMagPackState,
  ChunkDelta,
  ContainerLootState,
  DEFAULT_TUNER_SETTINGS,
  DoorSaveState,
  EquippedWeaponState,
  GameMode,
  GameSnapshot,
  InventoryItemInstance,
  MagCheckReadout,
  NearbyLootSource,
  SaveSlotData,
  SaveSlotMeta,
  StorageZoneId,
  TunerSettings,
  WeaponSlotsState,
  ZombieSaveState,
} from './types';
import { ThrowableSystem } from './weapons/ThrowableSystem';
import { WeaponRig } from './weapons/WeaponRig';
import { SurvivalWorldAdapter } from './world/SurvivalWorldAdapter';
import { buildWorld, BuiltWorld, ContainerEntity, DoorEntity, SurfaceType } from './world/WorldBuilder';

export type SnapshotListener = (snapshot: GameSnapshot) => void;

const MAG_PACK_STEP_SEC = 0.35;
const MAG_UNLOAD_STEP_SEC = 0.22;

export class GameEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;

  private textures: ProceduralTextureLibrary;
  private audio: AudioEngine;
  private acoustic: AcousticSystem;
  private weaponRig: WeaponRig;
  private characterSkeleton: CharacterSkeleton;
  private stateReader: ControllerStateReader;
  private characterAnimator: CharacterAnimator;
  private controller: BodycamController;
  private zombies: ZombieManager;
  private ballistics: BallisticsSystem;
  private throwables: ThrowableSystem;
  private composer: BodycamPostProcess;
  private scopeRenderer: ScopeRenderer;
  private saveManager: SaveManager;
  private trauma: LimbTraumaSystem;
  private inventoryManager: InventoryManager;
  private vitals: VitalsSystem;
  private world: BuiltWorld;
  private worldAdapter: SurvivalWorldAdapter;

  private listeners = new Set<SnapshotListener>();
  private frameId = 0;
  private lastTimeMs = performance.now();
  private elapsedSec = 0;
  private lastSnapshotEmitMs = 0;
  private disposed = false;

  // Game State
  private mode: GameMode = 'menu';
  private tunerOpen = false;
  private tuner: TunerSettings = { ...DEFAULT_TUNER_SETTINGS };
  private worldSeed = 40477;
  private playtimeSec = 0;
  private recordingStartMs = Date.now();

  private stamina = 1.0;
  private battery = 0.88;
  private hasFlashlight = false;
  private flashlightOn = false;

  private equippedWeaponId: WeaponId = 'unarmed';
  private ownedWeapons: WeaponId[] = ['unarmed'];
  private weaponStates: Partial<Record<WeaponId, EquippedWeaponState>> = {};
  private adsModeByWeapon: Partial<Record<WeaponId, AdsMode>> = {};
  private activeMagPack: ActiveMagPackState | null = null;

  private activeContainer: ContainerEntity | null = null;
  private hoveredDoor: DoorEntity | null = null;
  private hoveredContainer: ContainerEntity | null = null;
  private magCheckReadout: MagCheckReadout | null = null;
  private toastMessage: string | null = null;
  private toastExpiresAtMs = 0;
  private saveSlots: SaveSlotMeta[] = [];

  // Input State
  private pointerLocked = false;
  private shiftHeld = false;
  private altHeld = false;
  private input: PlayerInputState = {
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
  private firingHeld = false;
  private fireCooldownSec = 0;
  private meleeCooldownSec = 0;
  private reloadTimerSec = 0;
  private pendingReloadWeapon: WeaponId | null = null;
  private pendingReloadMagUid: string | null = null;
  private pendingDepletedThrowable: WeaponId | null = null;

  private raycaster = new THREE.Raycaster();
  private _tmpLook = new THREE.Vector3();
  private _tmpRight = new THREE.Vector3();
  private _tmpUp = new THREE.Vector3();
  private _tmpOrigin = new THREE.Vector3();
  private _throwVel = new THREE.Vector3();
  private _tmpPlayerVel = new THREE.Vector3();
  private _muzzlePos = new THREE.Vector3();
  private _muzzleDir = new THREE.Vector3();
  private _tmpFlinch = { pitch: 0, yaw: 0 };
  private _survivalMods: BodycamSurvivalModifiers = {
    encumbranceRatio: 0,
    swayAmpMult: 1,
    staminaDrainMult: 1,
    exertionRateMult: 1,
    moveSpeedMult: 1,
    canSprint: true,
  };
  private readonly _scopePassParams: ScopePassParams;

  constructor(container: HTMLElement) {
    this.container = container;

    // Detect Software WebGL (SwiftShader / llvmpipe / WARP)
    this.isSoftwareGl = (() => {
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) return true;
      const ext = probe.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
      const gpu = String(probe.getParameter(param));
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(72, w / Math.max(1, h), 0.08, 180);

    this.textures = new ProceduralTextureLibrary(this.renderer, this.worldSeed);
    this.audio = new AudioEngine();
    this.acoustic = new AcousticSystem(this.scene);
    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.scene.add(this.weaponRig.root);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.characterSkeleton = new CharacterSkeleton(aniso);
    this.characterSkeleton.setHeadVisible(false);
    // Assign first-person arms & hands to VIEWMODEL_LAYER so hands wrap around weapon grips
    // with accurate self-depth-testing while never clipping into nearby walls.
    const assignViewmodelLayer = (node: THREE.Object3D) => {
      node.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.layers.set(VIEWMODEL_LAYER);
        }
      });
    };
    for (const arm of [this.characterSkeleton.leftArm, this.characterSkeleton.rightArm]) {
      assignViewmodelLayer(arm.clavicle);
      assignViewmodelLayer(arm.upperArm);
      assignViewmodelLayer(arm.forearm);
      assignViewmodelLayer(arm.hand.root);
    }
    this.scene.add(this.characterSkeleton.root);
    this.stateReader = new ControllerStateReader();
    this.characterAnimator = new CharacterAnimator(this.characterSkeleton, this.weaponRig, this.audio);
    this.characterAnimator.setCallbacks({
      onMeleeImpact: (spec) => this.resolveMeleeImpact(spec),
      onLeverReleased: (_spec, spoonOrigin, spoonRight, spoonUp, spoonFwd) => {
        this.throwables.spawnFlyingSpoon(spoonOrigin, spoonRight, spoonUp, spoonFwd, true);
      },
      onThrowRelease: (spec, handWorldPos, remainingFuseSec, speedMps, style) => {
        this.spawnThrownProjectile(spec, handWorldPos, remainingFuseSec, speedMps, style);
      },
      onOvercookedDetonate: (spec, handWorldPos) => {
        this.handleOvercookedThrowable(spec, handWorldPos);
      },
      onCombatShock: (pitchRad, yawRad, kickBackM) => {
        this.controller.applyRecoil(pitchRad, yawRad, kickBackM, { stanceCoupled: false });
      },
      onCombatExertion: (amount) => {
        this.controller.addExertionImpulse(amount);
        this.vitals.addAdrenalineImpulse(amount * 0.45);
      },
    });

    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio, this.acoustic);
    this.zombies = new ZombieManager(this.scene, this.audio, this.acoustic);
    this.ballistics = new BallisticsSystem(this.scene, this.audio, this.acoustic, this.zombies);
    this.throwables = new ThrowableSystem(this.scene, this.audio, this.acoustic, this.zombies);
    this.composer = new BodycamPostProcess(this.renderer, this.scene, this.camera, this.isSoftwareGl);
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
    this.composer.setBeforeMainRenderCallback(() => {
      if (this.mode !== 'playing' || !this.weaponRig.root.visible) {
        return;
      }
      const rigState = this.weaponRig.getReadOnlyRigState();
      const sp = this._scopePassParams;
      sp.assembly = this.weaponRig.getModelAssembly();
      sp.isMagnifiedOptic = this.weaponRig.isMagnifiedOpticActive();
      sp.zoomMult = this.weaponRig.getActiveOpticZoomMult();
      sp.adsBlend = rigState.adsBlend;
      sp.cantBlend = rigState.cantBlend;
      sp.opticParallaxStrength = this.tuner.opticParallaxStrength ?? 1.0;
      sp.reticleIlluminated = this.weaponRig.reticleIlluminated;
      sp.flashlightOn = this.flashlightOn;
      sp.sightMisalignYaw = rigState.sightMisalignYaw;
      sp.sightMisalignPitch = rigState.sightMisalignPitch;
      sp.elapsed = this.elapsedSec;
      sp.mainAvgLuminance = this.composer.getAverageLuminance();
      this.scopeRenderer.renderScopePass(sp);
    });
    this.saveManager = new SaveManager();
    this.trauma = new LimbTraumaSystem(this.scene);
    this.inventoryManager = new InventoryManager();
    this.vitals = new VitalsSystem();

    this.world = this.mountWorld(this.worldSeed, -4.2, 16.5);
    this.worldAdapter = new SurvivalWorldAdapter(this.world, this.acoustic, this.trauma);
    this.worldAdapter.setMeleeHooks(
      () => this.zombies.getHitMeshes(),
      (ev) => this.handleCombatMeleeHit(ev),
    );

    if (!this.isSoftwareGl) {
      this.camera.layers.enable(VIEWMODEL_LAYER);
      this.renderer.compile(this.scene, this.camera);
      this.camera.layers.set(0);
    }

    this.bindEvents();
    void this.refreshSaveSlots();
    this.emitSnapshot(true);
    this.scheduleNextTick();
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.buildSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitSnapshot(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastSnapshotEmitMs < 80) return;
    this.lastSnapshotEmitMs = now;
    const snap = this.buildSnapshot();
    for (const l of this.listeners) {
      l(snap);
    }
  }

  private getCurrentWeaponState(): EquippedWeaponState {
    return this.getOrCreateWeaponState(this.equippedWeaponId);
  }

  private getArmedAdsMode(weaponId: WeaponId = this.equippedWeaponId): AdsMode {
    const wSpec = WEAPONS[weaponId];
    if (
      !wSpec ||
      (wSpec.holdClass !== 'pistol' && wSpec.holdClass !== 'rifle' && wSpec.holdClass !== 'shotgun')
    ) {
      return 'PRIMARY';
    }
    const stored = this.adsModeByWeapon[weaponId] ?? 'PRIMARY';
    if (
      stored === 'CANTED' &&
      weaponId === this.equippedWeaponId &&
      !this.weaponRig.hasCantedOptic()
    ) {
      this.adsModeByWeapon[weaponId] = 'PRIMARY';
      return 'PRIMARY';
    }
    return stored;
  }

  private setArmedAdsMode(weaponId: WeaponId, mode: AdsMode): void {
    this.adsModeByWeapon[weaponId] = mode;
    if (weaponId === this.equippedWeaponId) {
      this.input.adsMode = mode;
    }
  }

  private getOrCreateWeaponState(weaponId: WeaponId): EquippedWeaponState {
    if (!this.weaponStates[weaponId]) {
      this.weaponStates[weaponId] = {
        weaponId,
        loadedMag: null,
        chambered: false,
        chamberedCaliber: null,
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      };
    }
    const ws = this.weaponStates[weaponId]!;
    if (ws.loadedMag) {
      normalizeMagazineItem(ws.loadedMag);
    }
    ws.attachments = normalizeWeaponAttachments(weaponId, ws.attachments);
    if (ws.suppressorAttachedId && !ws.attachments.muzzle) {
      ws.attachments.muzzle = weaponId === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545';
    }
    return ws;
  }

  private collectNearbyLootSources(): NearbyLootSource[] {
    if (this.mode !== 'inventory') return [];
    const results: NearbyLootSource[] = [];
    const px = this.controller.position.x;
    const pz = this.controller.position.z;

    if (this.activeContainer) {
      results.push({
        containerId: this.activeContainer.id,
        label: this.activeContainer.state.label,
        isDropped: this.activeContainer.id.startsWith('drop_'),
        items: this.activeContainer.state.items.map((it) => cloneItemInstance(it)),
      });
    }

    const candidates: Array<{ distSq: number; c: ContainerEntity }> = [];
    for (const c of this.world.containers) {
      if (this.activeContainer && c.id === this.activeContainer.id) continue;
      if (c.state.items.length === 0) continue;
      const dx = c.position.x - px;
      const dz = c.position.z - pz;
      const distSq = dx * dx + dz * dz;
      const maxRange = c.id.startsWith('drop_') ? 2.8 : 2.15;
      if (distSq <= maxRange * maxRange) {
        candidates.push({ distSq, c });
      }
    }
    candidates.sort((a, b) => a.distSq - b.distSq);

    for (const entry of candidates.slice(0, 6)) {
      results.push({
        containerId: entry.c.id,
        label: entry.c.state.label,
        isDropped: entry.c.id.startsWith('drop_'),
        items: entry.c.state.items.map((it) => cloneItemInstance(it)),
      });
    }
    return results;
  }

  private cloneWeaponStates(): Partial<Record<WeaponId, EquippedWeaponState>> {
    const out: Partial<Record<WeaponId, EquippedWeaponState>> = {};
    for (const key of Object.keys(this.weaponStates) as WeaponId[]) {
      const ws = this.weaponStates[key];
      if (!ws) continue;
      out[key] = {
        ...ws,
        loadedMag: ws.loadedMag ? cloneItemInstance(ws.loadedMag) : null,
      };
    }
    return out;
  }

  private buildSnapshot(): GameSnapshot {
    const now = performance.now();
    if (this.magCheckReadout && now > this.magCheckReadout.expiresAtMs) {
      this.magCheckReadout = null;
    }
    if (this.toastMessage && now > this.toastExpiresAtMs) {
      this.toastMessage = null;
    }

    const ws = this.getCurrentWeaponState();
    const limbs = this.trauma.getLimbStatesReadOnly();
    const mod = this.trauma.getModifiersReadOnly();
    const gridSnapshot = this.inventoryManager.buildSnapshot(
      this.ownedWeapons,
      this.weaponStates,
      this.hasFlashlight,
    );

    return {
      mode: this.mode,
      pointerLocked: this.pointerLocked,
      tunerOpen: this.tunerOpen,
      tuner: { ...this.tuner },
      battery: this.battery,
      hasFlashlight: this.hasFlashlight,
      flashlightOn: this.flashlightOn,
      health: Math.round(mod.normalizedHealth),
      stamina: this.stamina,
      bleeding: mod.anyLightBleed || mod.anyHeavyBleed,
      trauma: {
        limbs: {
          head: { ...limbs.head },
          thorax: { ...limbs.thorax },
          leftArm: { ...limbs.leftArm },
          rightArm: { ...limbs.rightArm },
          leftLeg: { ...limbs.leftLeg },
          rightLeg: { ...limbs.rightLeg },
        },
        modifiers: { ...mod },
      },
      vitals: this.vitals.buildSnapshot(),
      equippedWeaponId: this.equippedWeaponId,
      ownedWeapons: [...this.ownedWeapons],
      weaponState: {
        ...ws,
        loadedMag: ws.loadedMag ? cloneItemInstance(ws.loadedMag) : null,
      },
      weaponStates: this.cloneWeaponStates(),
      inventory: this.inventoryManager.getAllFlatItems().map((i) => cloneItemInstance(i)),
      gridInventory: gridSnapshot,
      activeMagPack: this.activeMagPack ? { ...this.activeMagPack } : null,
      activeContainer: this.activeContainer
        ? {
            ...this.activeContainer.state,
            items: this.activeContainer.state.items.map((i) => cloneItemInstance(i)),
          }
        : null,
      nearbyLootSources: this.collectNearbyLootSources(),
      interactionDotVisible: Boolean(this.hoveredDoor || this.hoveredContainer),
      standBlockedByCeiling: this.controller.standBlockedByCeiling,
      aimStance: this.controller.aimStance,
      armedAdsMode: this.getArmedAdsMode(this.equippedWeaponId),
      isCanted: this.controller.isCanted,
      isPointAim: this.controller.isPointAim,
      hasCantedOptic: this.weaponRig.hasCantedOptic(),
      laserOn: this.weaponRig.getReadOnlyRigState().laserOn,
      throwableStatusLabel:
        this.characterAnimator.getThrowableStatusLabel(WEAPONS[this.equippedWeaponId]) || undefined,
      throwableLiveFuse: this.characterAnimator.isThrowableLiveFuse() || undefined,
      magCheckReadout: this.magCheckReadout ? { ...this.magCheckReadout } : null,
      toastMessage: this.toastMessage,
      recordingStartMs: this.recordingStartMs,
      playtimeSec: this.playtimeSec,
      worldSeed: this.worldSeed,
      saveSlots: [...this.saveSlots],
      zombieDebugStats: this.tuner.debugStealthAI ? this.zombies.getDebugStats() : undefined,
      exposureDebug: this.tunerOpen
        ? {
            avgLuminance: this.composer.getAverageLuminance(),
            exposure: this.composer.getCurrentExposure(),
          }
        : undefined,
    };
  }

  // --- Lifecycle & Game Flow Actions (called by React UI) ---

  public startNewGame(): void {
    this.audio.ensureInitialized();
    this.audio.resetTraumaAudio();
    this.worldSeed = Math.floor(10000 + Math.random() * 89999);
    this.rebuildWorld(this.worldSeed, -4.2, 16.5);

    this.trauma.reset();
    this.vitals.reset();
    this.inventoryManager.resetEmpty();
    this.activeMagPack = null;

    this.stamina = 1.0;
    this.battery = 0.88;
    this.hasFlashlight = true;
    this.flashlightOn = false;
    this.weaponRig.flashlight.visible = false;

    this.equippedWeaponId = 'unarmed';
    this.ownedWeapons = ['unarmed', 'ak74u_545', 'pm_9x19', 'tactical_knife', 'rgd5_frag', 'throw_bolt'];
    this.inventoryManager.setWeaponSlot('primary', 'ak74u_545');
    this.inventoryManager.setWeaponSlot('sidearm', 'pm_9x19');
    this.inventoryManager.setWeaponSlot('melee', 'tactical_knife');
    this.inventoryManager.setWeaponSlot('throwable', 'rgd5_frag');

    this.weaponStates = {
      unarmed: {
        weaponId: 'unarmed',
        loadedMag: null,
        chambered: false,
        chamberedCaliber: null,
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
      ak74u_545: {
        weaponId: 'ak74u_545',
        loadedMag: normalizeMagazineItem({
          uid: makeInvUid('mag'),
          itemId: 'mag_545_30',
          quantity: 1,
          rounds: 30,
        }),
        chambered: true,
        chamberedCaliber: '545x39_7n6',
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
      pm_9x19: {
        weaponId: 'pm_9x19',
        loadedMag: normalizeMagazineItem({
          uid: makeInvUid('mag'),
          itemId: 'mag_9x19_15',
          quantity: 1,
          rounds: 15,
        }),
        chambered: true,
        chamberedCaliber: '9x19_fmj',
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
      tactical_knife: {
        weaponId: 'tactical_knife',
        loadedMag: null,
        chambered: false,
        chamberedCaliber: null,
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
      rgd5_frag: {
        weaponId: 'rgd5_frag',
        loadedMag: null,
        chambered: false,
        chamberedCaliber: null,
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
      throw_bolt: {
        weaponId: 'throw_bolt',
        loadedMag: null,
        chambered: false,
        chamberedCaliber: null,
        suppressorAttachedId: null,
        attachments: createBareAttachments(),
      },
    };

    // Tactical Rig (4x3): partial spare mags + loose ammo stacks for manual packing + trauma & battery kit
    this.inventoryManager.addItemAt(
      normalizeMagazineItem({ uid: makeInvUid('mag'), itemId: 'mag_545_30', quantity: 1, rounds: 14 }),
      'rig',
      0,
      0,
      false,
    );
    this.inventoryManager.addItemAt(
      normalizeMagazineItem({ uid: makeInvUid('mag'), itemId: 'mag_9x19_15', quantity: 1, rounds: 8 }),
      'rig',
      1,
      0,
      false,
    );
    this.inventoryManager.addItemAt({ uid: makeInvUid('med'), itemId: 'medkit', quantity: 1 }, 'rig', 2, 0, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('med'), itemId: 'splint', quantity: 1 }, 'rig', 2, 1, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('ammo'), itemId: 'ammo_545x39', quantity: 20 }, 'rig', 0, 2, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('ammo'), itemId: 'ammo_9x19', quantity: 18 }, 'rig', 1, 2, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('frag'), itemId: 'weapon_rgd5_frag', quantity: 2 }, 'rig', 2, 2, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('bat'), itemId: 'aa_battery', quantity: 1 }, 'rig', 3, 2, false);

    // Pockets (4x1): fast bleed/painkillers & dry field ration (Backpack starts empty until scavenged!)
    this.inventoryManager.addItemAt({ uid: makeInvUid('med'), itemId: 'bandage', quantity: 2 }, 'pockets', 0, 0, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('med'), itemId: 'tourniquet', quantity: 1 }, 'pockets', 1, 0, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('med'), itemId: 'painkillers', quantity: 1 }, 'pockets', 2, 0, false);
    this.inventoryManager.addItemAt({ uid: makeInvUid('food'), itemId: 'crackers_ration', quantity: 1 }, 'pockets', 3, 0, false);

    this.playtimeSec = 0;
    this.recordingStartMs = Date.now();
    this.activeContainer = null;
    this.reloadTimerSec = 0;
    this.pendingReloadWeapon = null;
    this.pendingReloadMagUid = null;
    this.pendingDepletedThrowable = null;
    this.characterAnimator.cancelAction();

    const sp = this.world.getStarterSpawnWorld();
    const ox = this.world.chunkManager.originX;
    const oz = this.world.chunkManager.originZ;
    this.controller.position.set(sp.x - ox, sp.y, sp.z - oz);
    this.controller.crouched = false;
    this.controller.setAngles(sp.yaw, -0.04);
    this.controller.startWakeUpAnimation();
    this.weaponRig.setWeapon('unarmed', false);

    this.mode = 'playing';
    this.requestLock();
    this.emitSnapshot(true);
  }

  public resumeGame(): void {
    if (this.mode === 'dead') return;
    this.audio.ensureInitialized();
    this.activeContainer = null;
    this.mode = 'playing';
    this.requestLock();
    this.emitSnapshot(true);
  }

  public openPauseMenu(): void {
    if (this.mode === 'menu') return;
    this.mode = 'pause';
    this.activeContainer = null;
    this.cancelMagPack(false);
    this.clearMovementInputs();
    this.exitLock();
    void this.refreshSaveSlots();
    this.emitSnapshot(true);
  }

  public returnToMainMenu(): void {
    this.mode = 'menu';
    this.activeContainer = null;
    this.tunerOpen = false;
    this.cancelMagPack(false);
    this.clearMovementInputs();
    this.audio.resetTraumaAudio();
    this.exitLock();
    void this.refreshSaveSlots();
    this.emitSnapshot(true);
  }

  public toggleTuner(): void {
    this.tunerOpen = !this.tunerOpen;
    if (this.tunerOpen && this.mode === 'playing') {
      this.exitLock();
    } else if (!this.tunerOpen && this.mode === 'playing') {
      this.requestLock();
    }
    this.emitSnapshot(true);
  }

  public updateTuner(patch: Partial<TunerSettings>): void {
    this.tuner = { ...this.tuner, ...patch };
    this.audio.setSettings(this.tuner.micClippingDrive, this.tuner.masterVolume);
    this.acoustic.setDebugEnabled(this.tuner.debugStealthAI);
    this.zombies.setDebugEnabled(this.tuner.debugStealthAI);
    this.emitSnapshot(true);
  }

  public requestLock(): void {
    const canvas = this.renderer.domElement;
    if (document.pointerLockElement !== canvas && typeof canvas.requestPointerLock === 'function') {
      const requestFallback = (): void => {
        try {
          const fallbackRes = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          if (fallbackRes && typeof fallbackRes.catch === 'function') {
            fallbackRes.catch(() => {
              // Ignore Chromium post-ESC pointer-lock cooldown or gesture rejections
            });
          }
        } catch {
          // Ignore synchronous browser gesture rejections
        }
      };

      try {
        const res = (
          canvas.requestPointerLock as unknown as (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void
        )({ unadjustedMovement: true });
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch((err: unknown) => {
            const name = err instanceof DOMException ? err.name : '';
            if (name === 'NotSupportedError' || name === 'TypeError') {
              requestFallback();
            }
          });
        }
      } catch {
        requestFallback();
      }
    }
  }

  private exitLock(): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
  }

  private mountWorld(
    seed: number,
    spawnWorldX: number,
    spawnWorldZ: number,
    savedChunkDeltas?: Record<string, ChunkDelta>,
    savedContainers?: Record<string, ContainerLootState>,
    savedDoors?: Record<string, DoorSaveState>,
    savedZombies?: ZombieSaveState[],
  ): BuiltWorld {
    const built = buildWorld(
      this.scene,
      this.textures,
      seed,
      this.audio,
      this.acoustic,
      spawnWorldX,
      spawnWorldZ,
      savedChunkDeltas,
      savedContainers,
      savedDoors,
    );
    this.zombies.resetForWorld(built, savedZombies);
    built.chunkManager.onChunkZombiesReady = (chunkKey, spawns, killedIds) => {
      this.zombies.onChunkReady(built, chunkKey, spawns, killedIds);
    };
    built.chunkManager.onChunkUnloaded = (chunkKey) => {
      this.zombies.onChunkUnloaded(chunkKey, built.chunkManager.originX, built.chunkManager.originZ);
    };
    built.chunkManager.emitLoadedChunkZombies();
    return built;
  }

  private rebuildWorld(
    seed: number,
    spawnWorldX: number,
    spawnWorldZ: number,
    savedChunkDeltas?: Record<string, ChunkDelta>,
    savedContainers?: Record<string, ContainerLootState>,
    savedDoors?: Record<string, DoorSaveState>,
    savedZombies?: ZombieSaveState[],
  ): void {
    this.world.dispose();
    this.world = this.mountWorld(
      seed,
      spawnWorldX,
      spawnWorldZ,
      savedChunkDeltas,
      savedContainers,
      savedDoors,
      savedZombies,
    );
    this.worldAdapter.setWorld(this.world);
  }

  // --- Save / Load IndexedDB ---

  public async refreshSaveSlots(): Promise<void> {
    try {
      this.saveSlots = await this.saveManager.listSlots();
      this.emitSnapshot(true);
    } catch {
      // Ignore IDB errors in restricted contexts
    }
  }

  public async createSave(name: string, isQuicksave = false, overwriteId?: string): Promise<void> {
    const id = isQuicksave ? 'quicksave' : overwriteId || `save_${Date.now()}`;
    const ox = this.world.chunkManager.originX;
    const oz = this.world.chunkManager.originZ;
    const traumaMod = this.trauma.getModifiersReadOnly();

    const data: SaveSlotData = {
      id,
      name: isQuicksave ? 'Quicksave' : name.trim() || `Expedition ${new Date().toLocaleTimeString()}`,
      isQuicksave,
      savedAt: Date.now(),
      worldSeed: this.worldSeed,
      playtimeSec: this.playtimeSec,
      player: {
        position: [
          ox + this.controller.position.x,
          this.controller.position.y,
          oz + this.controller.position.z,
        ],
        torsoYaw: this.controller.torsoYaw,
        torsoPitch: this.controller.torsoPitch,
        crouched: this.controller.crouched,
        health: Math.round(traumaMod.normalizedHealth),
        stamina: this.stamina,
        bleeding: traumaMod.anyLightBleed || traumaMod.anyHeavyBleed,
        trauma: this.trauma.exportSaveState(),
        battery: this.battery,
        flashlightOn: this.flashlightOn,
        hasFlashlight: this.hasFlashlight,
        equippedWeaponId: this.equippedWeaponId,
        ownedWeapons: [...this.ownedWeapons],
        weaponStates: this.cloneWeaponStates(),
        inventory: this.inventoryManager.getAllFlatItems().map((i) => cloneItemInstance(i)),
        gridInventory: this.inventoryManager.exportSaveState(),
        vitals: this.vitals.exportSaveState(),
      },
      containers: {},
      doors: {},
      chunkDeltas: this.world.exportChunkDeltas(),
      zombies: this.zombies.exportStates(ox, oz),
    };

    await this.saveManager.saveSlot(data);
    this.showToast(isQuicksave ? 'Quicksaved' : `Saved: ${data.name}`);
    await this.refreshSaveSlots();
  }

  public async loadSave(id: string): Promise<boolean> {
    const data = await this.saveManager.loadSlot(id);
    if (!data) {
      this.showToast('No save found');
      return false;
    }

    this.audio.ensureInitialized();
    this.audio.resetTraumaAudio();
    this.worldSeed = data.worldSeed;
    this.playtimeSec = data.playtimeSec;
    const p = data.player;

    this.rebuildWorld(
      data.worldSeed,
      p.position[0],
      p.position[2],
      data.chunkDeltas,
      data.containers,
      data.doors,
      data.zombies,
    );

    const ox = this.world.chunkManager.originX;
    const oz = this.world.chunkManager.originZ;
    this.controller.position.set(p.position[0] - ox, p.position[1], p.position[2] - oz);
    this.controller.crouched = p.crouched;
    this.controller.setAngles(p.torsoYaw, p.torsoPitch);
    this.controller.snapStanding();

    this.trauma.loadSaveState(p.trauma, p.health, p.bleeding);
    this.vitals.loadSaveState(p.vitals);
    this.stamina = Math.min(this.trauma.getModifiersReadOnly().staminaCap, p.stamina);
    this.battery = p.battery;
    this.hasFlashlight = p.hasFlashlight;
    this.flashlightOn = p.flashlightOn && this.hasFlashlight && this.battery > 0.01;
    this.weaponRig.flashlight.visible = this.flashlightOn;

    this.equippedWeaponId = p.equippedWeaponId;
    this.ownedWeapons = [...p.ownedWeapons];
    this.weaponStates = JSON.parse(JSON.stringify(p.weaponStates));
    for (const wKey of Object.keys(this.weaponStates) as WeaponId[]) {
      const ws = this.weaponStates[wKey];
      if (!ws) continue;
      if (ws.loadedMag) {
        normalizeMagazineItem(ws.loadedMag);
      }
      if (ws.chambered && !ws.chamberedCaliber) {
        ws.chamberedCaliber = WEAPONS[wKey]?.caliberId ?? null;
      }
      ws.attachments = normalizeWeaponAttachments(wKey, ws.attachments);
      if (ws.suppressorAttachedId && !ws.attachments.muzzle) {
        ws.attachments.muzzle = wKey === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545';
      }
    }

    this.inventoryManager.loadSaveState(p.gridInventory, p.inventory ?? [], this.ownedWeapons);
    this.activeMagPack = null;

    const ws = this.getCurrentWeaponState();
    this.weaponRig.setWeapon(this.equippedWeaponId, ws.attachments ?? Boolean(ws.suppressorAttachedId));
    this.syncWeaponRigAmmoState();

    this.activeContainer = null;
    this.reloadTimerSec = 0;
    this.pendingReloadWeapon = null;
    this.pendingReloadMagUid = null;
    this.pendingDepletedThrowable = null;
    this.characterAnimator.cancelAction();
    this.mode = 'playing';
    this.requestLock();
    this.showToast(`Loaded: ${data.name}`);
    this.emitSnapshot(true);
    return true;
  }

  public async deleteSave(id: string): Promise<void> {
    await this.saveManager.deleteSlot(id);
    await this.refreshSaveSlots();
  }

  private showToast(msg: string, durationMs = 1750): void {
    this.toastMessage = msg;
    this.toastExpiresAtMs = performance.now() + durationMs;
    this.emitSnapshot(true);
  }

  // --- Inventory, Grid, Magazine Packing & Equipment Actions ---

  public equipWeapon(weaponId: WeaponId): void {
    if (!this.ownedWeapons.includes(weaponId)) return;
    if (this.equippedWeaponId === weaponId) return;
    this.cancelMagPack(false);
    this.reloadTimerSec = 0;
    this.pendingReloadWeapon = null;
    this.pendingReloadMagUid = null;
    this.pendingDepletedThrowable = null;
    this.firingHeld = false;
    this.characterAnimator.holsterOrTossThrowable(WEAPONS[this.equippedWeaponId]);
    this.characterAnimator.cancelAction();
    this.equippedWeaponId = weaponId;
    const ws = this.getCurrentWeaponState();
    this.weaponRig.setWeapon(weaponId, ws.attachments ?? Boolean(ws.suppressorAttachedId));
    this.input.adsMode = this.getArmedAdsMode(weaponId);
    this.syncWeaponRigAmmoState();
    this.audio.playReloadFoley('check');
    this.emitSnapshot(true);
  }

  private syncWeaponRigAmmoState(): void {
    const ws = this.getCurrentWeaponState();
    const total = (ws.chambered ? 1 : 0) + (ws.loadedMag ? getMagRoundCount(ws.loadedMag) : 0);
    this.weaponRig.setAmmoState(total);
  }

  private equipSlotKind(slotKind: EquipSlotKind): void {
    if (slotKind === 'unarmed') {
      this.equipWeapon('unarmed');
      return;
    }
    const candidates = this.ownedWeapons.filter((id) => WEAPONS[id]?.slotKind === slotKind);
    if (candidates.length === 0) return;

    if (slotKind === 'throwable') {
      const valid = candidates.filter(
        (id) => id !== 'rgd5_frag' || this.inventoryManager.getItemQuantity('weapon_rgd5_frag') > 0,
      );
      if (valid.length === 0) return;
      const curIdx = valid.indexOf(this.equippedWeaponId);
      const next = curIdx >= 0 ? valid[(curIdx + 1) % valid.length] : valid[0];
      this.equipWeapon(next);
      return;
    }

    // Prioritize weapon currently assigned to that slot, cycling if multiple owned
    const slots = this.inventoryManager.getWeaponSlots();
    const slotted = slots[slotKind as keyof WeaponSlotsState];
    if (slotted && this.equippedWeaponId !== slotted && candidates.includes(slotted)) {
      this.equipWeapon(slotted);
      return;
    }

    const curIdx = candidates.indexOf(this.equippedWeaponId);
    const next = curIdx >= 0 ? candidates[(curIdx + 1) % candidates.length] : candidates[0];
    this.equipWeapon(next);
  }

  private getContainerEntityById(containerId: string): ContainerEntity | null {
    if (this.activeContainer && this.activeContainer.id === containerId) {
      return this.activeContainer;
    }
    return this.world.containers.find((c) => c.id === containerId) ?? null;
  }

  public takeItemFromContainer(uid: string): void {
    if (!this.activeContainer) return;
    this.takeItemFromSource(this.activeContainer.id, uid);
  }

  public takeAllFromContainer(): void {
    if (!this.activeContainer) return;
    this.takeAllFromSource(this.activeContainer.id);
  }

  public takeItemFromSource(
    containerId: string,
    uid: string,
    targetZone?: StorageZoneId,
    targetX?: number,
    targetY?: number,
    rotated = false,
  ): void {
    const src = this.getContainerEntityById(containerId);
    if (!src) return;
    const idx = src.state.items.findIndex((i) => i.uid === uid);
    if (idx === -1) return;

    const item = cloneItemInstance(src.state.items[idx]);
    const spec = ITEMS[item.itemId];
    if (!spec) return;

    // Direct grid drop onto specific cell
    if (targetZone !== undefined && targetX !== undefined && targetY !== undefined) {
      const ok = this.inventoryManager.addItemAt(item, targetZone, targetX, targetY, rotated);
      if (!ok) {
        // Attempt stack merge into cell if stackable
        const atCell = this.inventoryManager.getItemAtCell(targetZone, targetX, targetY);
        if (
          spec.stackable &&
          atCell &&
          atCell.item.itemId === item.itemId &&
          atCell.item.quantity < spec.maxStack
        ) {
          const space = spec.maxStack - atCell.item.quantity;
          const add = Math.min(space, item.quantity);
          atCell.item.quantity += add;
          const rem = item.quantity - add;
          if (rem <= 0) {
            src.state.items.splice(idx, 1);
          } else {
            src.state.items[idx].quantity = rem;
          }
          this.audio.playPickup();
          this.emitSnapshot(true);
          return;
        }
        this.showToast('Item does not fit there');
        return;
      }
      src.state.items.splice(idx, 1);
      this.syncThrowableOwnership(item.itemId);
      this.audio.playPickup();
      this.emitSnapshot(true);
      return;
    }

    const res = this.addItemToPlayer(item);
    if (!res.accepted) {
      this.showToast(res.reason || 'Not enough grid space');
      return;
    }
    if (res.remainder) {
      src.state.items[idx] = res.remainder;
    } else {
      src.state.items.splice(idx, 1);
    }
    this.audio.playPickup();
    this.emitSnapshot(true);
  }

  public takeAllFromSource(containerId: string): void {
    const src = this.getContainerEntityById(containerId);
    if (!src || src.state.items.length === 0) return;

    const remaining: InventoryItemInstance[] = [];
    let tookAny = false;
    for (const raw of src.state.items) {
      const item = cloneItemInstance(raw);
      const res = this.addItemToPlayer(item);
      if (res.accepted) {
        tookAny = true;
        if (res.remainder) remaining.push(res.remainder);
      } else {
        remaining.push(item);
      }
    }
    src.state.items = remaining;
    if (tookAny) {
      this.audio.playPickup();
    }
    if (remaining.length > 0) {
      this.showToast(tookAny ? 'Pack full — some items left behind' : 'No grid space — scavenge a backpack');
    }
    this.emitSnapshot(true);
  }

  private syncThrowableOwnership(itemId: string): void {
    if (itemId === 'weapon_rgd5_frag' && !this.ownedWeapons.includes('rgd5_frag')) {
      this.ownedWeapons.push('rgd5_frag');
      this.getOrCreateWeaponState('rgd5_frag');
      if (!this.inventoryManager.getWeaponSlots().throwable) {
        this.inventoryManager.setWeaponSlot('throwable', 'rgd5_frag');
      }
    }
  }

  private addItemToPlayer(
    rawItem: InventoryItemInstance,
  ): { accepted: boolean; remainder: InventoryItemInstance | null; reason?: string } {
    const item = cloneItemInstance(rawItem);
    const spec = ITEMS[item.itemId];
    if (!spec) return { accepted: false, remainder: item };

    // 1. Flashlight auto-equip if player lacks one
    if (item.itemId === 'flashlight' && !this.hasFlashlight) {
      this.hasFlashlight = true;
      this.showToast('Equipped WML Flashlight [T]');
      return { accepted: true, remainder: null };
    }

    // 2. Backpack auto-equip if Backpack slot is currently empty!
    if (spec.category === 'backpack' && !this.inventoryManager.getEquippedBackpack()) {
      const bpRes = this.inventoryManager.equipBackpack(item);
      if (bpRes.equipped) {
        this.showToast(`Equipped ${spec.shortName} (${spec.backpackCols}x${spec.backpackRows})`);
        return { accepted: true, remainder: null };
      }
    }

    // 3. Weapon: auto-equip into matching weapon slot if slot is open; otherwise store in grid!
    if (spec.category === 'weapon' && spec.weaponId) {
      const wId = spec.weaponId as WeaponId;
      const wSpec = WEAPONS[wId];
      if (wSpec?.consumableOnThrow) {
        const placedRes = this.inventoryManager.addItem(item);
        if (placedRes.added) {
          this.syncThrowableOwnership(item.itemId);
          return { accepted: true, remainder: placedRes.remainder };
        }
        return { accepted: false, remainder: item, reason: 'No grid space for grenade' };
      }

      const slotKey = wSpec?.slotKind;
      const slots = this.inventoryManager.getWeaponSlots();
      if (
        slotKey &&
        slotKey !== 'unarmed' &&
        (!slots[slotKey as keyof WeaponSlotsState] || !this.ownedWeapons.includes(wId))
      ) {
        if (!slots[slotKey as keyof WeaponSlotsState]) {
          this.inventoryManager.setWeaponSlot(slotKey as keyof WeaponSlotsState, wId);
          if (!this.ownedWeapons.includes(wId)) {
            this.ownedWeapons.push(wId);
            this.getOrCreateWeaponState(wId);
          }
          if (this.equippedWeaponId === 'unarmed') {
            this.equipWeapon(wId);
          }
          this.showToast(`Slung ${spec.shortName}`);
          return { accepted: true, remainder: null };
        }
      }

      // Slot already occupied -> store spare weapon inside backpack/rig grid
      const placedRes = this.inventoryManager.addItem(item);
      if (placedRes.added) {
        this.showToast(`Stowed ${spec.shortName} in ${placedRes.placedZone ?? 'pack'}`);
        return { accepted: true, remainder: placedRes.remainder };
      }
      return { accepted: false, remainder: item, reason: `${spec.shortName} requires ${spec.gridW}x${spec.gridH} pack space` };
    }

    // 4. All other items (magazines, loose ammo, food, drinks, batteries, medical, suppressors) -> Grid
    const placedRes = this.inventoryManager.addItem(item);
    if (!placedRes.added) {
      return {
        accepted: false,
        remainder: item,
        reason: this.inventoryManager.getEquippedBackpack()
          ? 'No free grid cells'
          : 'Rig & Pockets full — scavenge a backpack',
      };
    }

    return { accepted: true, remainder: placedRes.remainder };
  }

  public moveGridItem(
    uid: string,
    targetZone: StorageZoneId,
    targetX: number,
    targetY: number,
    rotated?: boolean,
  ): void {
    const ok = this.inventoryManager.moveItem(uid, targetZone, targetX, targetY, rotated);
    if (!ok) {
      this.showToast('Cannot place item there');
      return;
    }
    this.audio.playPickup();
    this.emitSnapshot(true);
  }

  public rotateGridItem(uid: string): void {
    const ok = this.inventoryManager.rotateItem(uid);
    if (!ok) {
      this.showToast('No room to rotate item');
      return;
    }
    this.audio.playReloadFoley('check');
    this.emitSnapshot(true);
  }

  public ctrlClickGridItem(uid: string): void {
    const placed = this.inventoryManager.findPlacedByUid(uid);
    if (!placed) return;

    // If an active container is open, Ctrl+Click transfers straight into container
    if (this.activeContainer) {
      this.depositGridItemToContainer(uid, this.activeContainer.id);
      return;
    }

    // Otherwise quick-transfer between Rig <-> Backpack <-> Pockets
    const dest = this.inventoryManager.quickTransferWithinPlayer(uid);
    if (!dest) {
      this.showToast('No space in other wearable');
      return;
    }
    this.audio.playPickup();
    this.emitSnapshot(true);
  }

  public depositGridItemToContainer(uid: string, containerId: string): void {
    const dest = this.getContainerEntityById(containerId);
    if (!dest) return;
    if (this.activeMagPack?.magUid === uid || this.activeMagPack?.ammoUid === uid) {
      this.cancelMagPack(false);
    }
    const removed = this.inventoryManager.removeItemByUid(uid);
    if (!removed) return;
    dest.state.items.push(cloneItemInstance(removed));
    this.checkDepletedFragCleanup(removed.itemId);
    this.audio.playPickup();
    this.emitSnapshot(true);
  }

  public equipBackpackFromSource(containerId: string, uid: string): void {
    const src = this.getContainerEntityById(containerId);
    if (!src) return;
    const idx = src.state.items.findIndex((i) => i.uid === uid);
    if (idx === -1) return;
    const packItem = cloneItemInstance(src.state.items[idx]);
    const res = this.inventoryManager.equipBackpack(packItem);
    if (!res.equipped) {
      this.showToast(res.error || 'Cannot equip backpack');
      return;
    }
    src.state.items.splice(idx, 1);
    if (res.replaced) {
      src.state.items.push(res.replaced);
    }
    this.audio.playPickup();
    this.showToast(`Equipped ${ITEMS[packItem.itemId]?.shortName ?? 'Backpack'}`);
    this.emitSnapshot(true);
  }

  public equipBackpackFromGrid(uid: string): void {
    const placed = this.inventoryManager.findPlacedByUid(uid);
    if (!placed) return;
    const spec = ITEMS[placed.item.itemId];
    if (!spec || spec.category !== 'backpack') return;

    // Temporarily remove from grid before equipping
    const removed = this.inventoryManager.removeItemByUid(uid);
    if (!removed) return;
    const res = this.inventoryManager.equipBackpack(removed);
    if (!res.equipped) {
      this.inventoryManager.addItemAt(removed, placed.zone, placed.x, placed.y, placed.rotated);
      this.showToast(res.error || 'Cannot equip backpack');
      return;
    }
    if (res.replaced) {
      const stow = this.inventoryManager.addItem(res.replaced);
      if (!stow.added) {
        this.dropItemAtFeet(res.replaced);
      }
    }
    this.audio.playPickup();
    this.showToast(`Equipped ${spec.shortName}`);
    this.emitSnapshot(true);
  }

  public unequipBackpack(): void {
    const res = this.inventoryManager.unequipBackpack();
    if (!res.removed) {
      if (res.error) this.showToast(res.error);
      return;
    }
    if (this.activeContainer) {
      this.activeContainer.state.items.push(res.removed);
      this.showToast('Placed backpack in container');
    } else {
      this.dropItemAtFeet(res.removed);
      this.showToast('Dropped backpack on ground');
    }
    this.audio.playPickup();
    this.emitSnapshot(true);
  }

  public installBatteryFromGrid(uid: string): void {
    const placed = this.inventoryManager.findPlacedByUid(uid);
    if (!placed) return;
    const spec = ITEMS[placed.item.itemId];
    if (!spec?.batteryRestore) return;
    if (!this.hasFlashlight) {
      this.showToast('No WML flashlight equipped');
      return;
    }
    if (this.battery >= 0.99) {
      this.showToast('Flashlight battery already full');
      return;
    }
    this.battery = Math.min(1.0, this.battery + spec.batteryRestore);
    this.inventoryManager.consumeQuantityByUid(uid, 1);
    this.audio.playFlashlightClick();
    this.showToast(`Installed ${spec.shortName} (${Math.round(this.battery * 100)}%)`);
    this.emitSnapshot(true);
  }

  public swapBestBattery(): void {
    const best =
      this.inventoryManager.findItemByItemIdPriority('battery_cell', ['pockets', 'rig', 'backpack']) ??
      this.inventoryManager.findItemByItemIdPriority('aa_battery', ['pockets', 'rig', 'backpack']);
    if (!best) {
      this.showToast('No spare AA or CR123A batteries in gear');
      return;
    }
    this.installBatteryFromGrid(best.item.uid);
  }

  public equipWeaponFromGrid(uid: string): void {
    const placed = this.inventoryManager.findPlacedByUid(uid);
    if (!placed) return;
    const spec = ITEMS[placed.item.itemId];
    if (!spec || spec.category !== 'weapon' || !spec.weaponId) return;

    const wId = spec.weaponId as WeaponId;
    const wSpec = WEAPONS[wId];
    if (!wSpec || wSpec.slotKind === 'unarmed') return;

    const slotKey = wSpec.slotKind as keyof WeaponSlotsState;
    const prevWeaponId = this.inventoryManager.getWeaponSlots()[slotKey];
    const removed = this.inventoryManager.removeItemByUid(uid);
    if (!removed) return;

    if (prevWeaponId && prevWeaponId !== wId) {
      const prevSpec = WEAPONS[prevWeaponId];
      if (prevSpec?.itemId) {
        const prevItem: InventoryItemInstance = {
          uid: makeInvUid('wpn'),
          itemId: prevSpec.itemId,
          quantity: 1,
        };
        const stow = this.inventoryManager.addItem(prevItem);
        if (!stow.added) {
          this.dropItemAtFeet(prevItem);
        }
      }
      this.ownedWeapons = this.ownedWeapons.filter((id) => id !== prevWeaponId);
    }

    this.inventoryManager.setWeaponSlot(slotKey, wId);
    if (!this.ownedWeapons.includes(wId)) {
      this.ownedWeapons.push(wId);
      this.getOrCreateWeaponState(wId);
    }
    this.equipWeapon(wId);
    this.showToast(`Equipped ${wSpec.name}`);
    this.emitSnapshot(true);
  }

  public dropWeaponSlot(slot: keyof WeaponSlotsState): void {
    const wId = this.inventoryManager.getWeaponSlots()[slot];
    if (!wId) return;
    const wSpec = WEAPONS[wId];
    this.cancelMagPack(false);

    // Eject loaded magazine into player grid or ground before dropping firearm
    const ws = this.weaponStates[wId];
    if (ws?.loadedMag) {
      const stowMag = this.inventoryManager.addItem(ws.loadedMag);
      if (!stowMag.added) this.dropItemAtFeet(ws.loadedMag);
      ws.loadedMag = null;
    }
    if (ws?.suppressorAttachedId) {
      const suppItem: InventoryItemInstance = {
        uid: makeInvUid('supp'),
        itemId: ws.suppressorAttachedId,
        quantity: 1,
      };
      const stowSupp = this.inventoryManager.addItem(suppItem);
      if (!stowSupp.added) this.dropItemAtFeet(suppItem);
      ws.suppressorAttachedId = null;
    }

    this.inventoryManager.setWeaponSlot(slot, null);
    this.ownedWeapons = this.ownedWeapons.filter((id) => id !== wId);

    if (wSpec?.itemId && !wSpec.consumableOnThrow) {
      this.dropItemAtFeet({ uid: makeInvUid('wpn'), itemId: wSpec.itemId, quantity: 1 });
    }

    if (this.equippedWeaponId === wId) {
      this.equippedWeaponId = 'unarmed';
      this.weaponRig.setWeapon('unarmed', false);
    }
    this.audio.playPickup();
    this.showToast(`Dropped ${wSpec?.name ?? 'weapon'}`);
    this.emitSnapshot(true);
  }

  // --- Tarkov-Style Manual Magazine Packing & Unloading ---

  private resolveMagRef(
    magUid: string,
    magLocation: 'grid' | 'loaded',
    magWeaponId?: WeaponId,
  ): InventoryItemInstance | null {
    if (magLocation === 'loaded' && magWeaponId) {
      const ws = this.weaponStates[magWeaponId];
      if (ws?.loadedMag && ws.loadedMag.uid === magUid) {
        return normalizeMagazineItem(ws.loadedMag);
      }
      return null;
    }
    const placed = this.inventoryManager.findPlacedByUid(magUid);
    if (!placed) return null;
    return normalizeMagazineItem(placed.item);
  }

  public startPackMag(
    magUid: string,
    magLocation: 'grid' | 'loaded' = 'grid',
    magWeaponId?: WeaponId,
    preferredAmmoUid?: string,
  ): void {
    const mag = this.resolveMagRef(magUid, magLocation, magWeaponId);
    if (!mag) return;
    const magSpec = ITEMS[mag.itemId];
    if (!magSpec || magSpec.category !== 'magazine' || !magSpec.caliberId || !magSpec.magCapacity) return;

    const currentRounds = getMagRoundCount(mag);
    if (currentRounds >= magSpec.magCapacity) {
      this.showToast(`${magSpec.shortName} is already full`);
      return;
    }

    const ammoItemId = getLooseAmmoItemIdForCaliber(magSpec.caliberId);
    if (!ammoItemId) return;

    let ammoPlaced = preferredAmmoUid ? this.inventoryManager.findPlacedByUid(preferredAmmoUid) : null;
    if (ammoPlaced && ITEMS[ammoPlaced.item.itemId]?.caliberId !== magSpec.caliberId) {
      this.showToast(`Incompatible ammo for ${magSpec.shortName}`);
      return;
    }
    if (!ammoPlaced) {
      ammoPlaced = this.inventoryManager.findItemByItemIdPriority(ammoItemId, ['rig', 'pockets', 'backpack']);
    }
    if (!ammoPlaced) {
      this.showToast(`No loose ${CALIBERS[magSpec.caliberId].label} rounds`);
      return;
    }

    this.activeMagPack = {
      mode: 'pack',
      magUid,
      magLocation,
      magWeaponId,
      ammoUid: ammoPlaced.item.uid,
      progressSec: 0,
      stepSec: MAG_PACK_STEP_SEC,
      currentRounds,
      capacity: magSpec.magCapacity,
      label: magSpec.shortName,
    };
    this.audio.playReloadFoley('check');
    this.emitSnapshot(true);
  }

  public startUnloadMag(
    magUid: string,
    magLocation: 'grid' | 'loaded' = 'grid',
    magWeaponId?: WeaponId,
  ): void {
    const mag = this.resolveMagRef(magUid, magLocation, magWeaponId);
    if (!mag) return;
    const magSpec = ITEMS[mag.itemId];
    if (!magSpec || magSpec.category !== 'magazine' || !magSpec.magCapacity) return;

    const currentRounds = getMagRoundCount(mag);
    if (currentRounds <= 0) {
      this.showToast(`${magSpec.shortName} is already empty`);
      return;
    }

    this.activeMagPack = {
      mode: 'unload',
      magUid,
      magLocation,
      magWeaponId,
      progressSec: 0,
      stepSec: MAG_UNLOAD_STEP_SEC,
      currentRounds,
      capacity: magSpec.magCapacity,
      label: magSpec.shortName,
    };
    this.audio.playReloadFoley('check');
    this.emitSnapshot(true);
  }

  public cancelMagPack(notify = true): void {
    if (!this.activeMagPack) return;
    this.activeMagPack = null;
    if (notify) {
      this.showToast('Stopped magazine handling');
    }
    this.emitSnapshot(true);
  }

  private tickMagPack(delta: number): void {
    const task = this.activeMagPack;
    if (!task) return;

    const mag = this.resolveMagRef(task.magUid, task.magLocation, task.magWeaponId);
    if (!mag) {
      this.activeMagPack = null;
      this.emitSnapshot(true);
      return;
    }

    const magSpec = ITEMS[mag.itemId];
    if (!magSpec?.magCapacity || !magSpec.caliberId) {
      this.activeMagPack = null;
      return;
    }

    task.progressSec += delta;
    if (task.progressSec < task.stepSec) return;
    task.progressSec -= task.stepSec;

    if (task.mode === 'pack') {
      const ammoItemId = getLooseAmmoItemIdForCaliber(magSpec.caliberId);
      if (!ammoItemId) {
        this.activeMagPack = null;
        return;
      }

      let ammoPlaced = task.ammoUid ? this.inventoryManager.findPlacedByUid(task.ammoUid) : null;
      if (!ammoPlaced || ammoPlaced.item.quantity <= 0) {
        ammoPlaced = this.inventoryManager.findItemByItemIdPriority(ammoItemId, ['rig', 'pockets', 'backpack']);
        task.ammoUid = ammoPlaced?.item.uid;
      }

      if (!ammoPlaced || getMagRoundCount(mag) >= magSpec.magCapacity) {
        this.activeMagPack = null;
        this.showToast(`Packed ${magSpec.shortName} (${getMagRoundCount(mag)}/${magSpec.magCapacity})`);
        this.emitSnapshot(true);
        return;
      }

      const cal = ITEMS[ammoPlaced.item.itemId]?.caliberId ?? magSpec.caliberId;
      if (pushRoundToMag(mag, cal)) {
        this.inventoryManager.consumeQuantityByUid(ammoPlaced.item.uid, 1);
        const nowRounds = getMagRoundCount(mag);
        task.currentRounds = nowRounds;
        this.audio.playMagPackClick(nowRounds / magSpec.magCapacity);

        if (nowRounds >= magSpec.magCapacity) {
          this.activeMagPack = null;
          this.showToast(`${magSpec.shortName} full (${nowRounds}/${magSpec.magCapacity})`);
        } else {
          // Check if any ammo remains for next tick
          const stillHas =
            (task.ammoUid && this.inventoryManager.findPlacedByUid(task.ammoUid)) ||
            this.inventoryManager.findItemByItemIdPriority(ammoItemId, ['rig', 'pockets', 'backpack']);
          if (!stillHas) {
            this.activeMagPack = null;
            this.showToast(`Packed ${magSpec.shortName} (${nowRounds}/${magSpec.magCapacity})`);
          }
        }
        this.emitSnapshot(true);
      } else {
        this.activeMagPack = null;
        this.emitSnapshot(true);
      }
      return;
    }

    // Unload mode
    const poppedCal = popRoundFromMag(mag);
    if (!poppedCal) {
      this.activeMagPack = null;
      this.showToast(`${magSpec.shortName} unloaded`);
      this.emitSnapshot(true);
      return;
    }

    const looseId = getLooseAmmoItemIdForCaliber(poppedCal);
    if (!looseId) {
      this.activeMagPack = null;
      return;
    }

    const addRes = this.inventoryManager.addItem(
      { uid: makeInvUid('ammo'), itemId: looseId, quantity: 1 },
      ['pockets', 'rig', 'backpack'],
    );
    if (!addRes.added) {
      // Revert round back into magazine if completely out of grid space
      pushRoundToMag(mag, poppedCal);
      this.activeMagPack = null;
      this.showToast('No grid space for unloaded rounds');
      this.emitSnapshot(true);
      return;
    }

    const remRounds = getMagRoundCount(mag);
    task.currentRounds = remRounds;
    this.audio.playMagUnloadClick();
    if (remRounds <= 0) {
      this.activeMagPack = null;
      this.showToast(`${magSpec.shortName} empty (0/${magSpec.magCapacity})`);
    }
    this.emitSnapshot(true);
  }

  public useInventoryItem(uid: string, targetLimbId?: LimbId): void {
    const placed = this.inventoryManager.findPlacedByUid(uid);
    if (!placed) return;
    const item = placed.item;
    const spec = ITEMS[item.itemId];
    if (!spec) return;

    if (spec.category === 'medical') {
      const res = this.trauma.applyMedicalItem(item.itemId, targetLimbId);
      if (!res.applied) {
        this.showToast(res.curedCondition || 'No matching injury');
        return;
      }
      this.inventoryManager.consumeQuantityByUid(uid, 1);
      this.audio.playPickup();
      this.showToast(res.curedCondition || 'Treated');
      this.emitSnapshot(true);
      return;
    }

    if (spec.category === 'food' || spec.category === 'drink') {
      const res = this.vitals.consumeItem(item.itemId);
      if (!res.consumed) return;
      this.inventoryManager.consumeQuantityByUid(uid, 1);
      if (res.staminaBonus > 0) {
        this.stamina = Math.min(this.trauma.getModifiersReadOnly().staminaCap, this.stamina + res.staminaBonus);
      }
      this.audio.playConsume(res.kind);
      this.showToast(res.summary);
      this.emitSnapshot(true);
      return;
    }

    if (spec.batteryRestore) {
      this.installBatteryFromGrid(uid);
      return;
    }

    if (spec.category === 'backpack') {
      this.equipBackpackFromGrid(uid);
      return;
    }

    if (spec.category === 'weapon' && spec.weaponId) {
      this.equipWeaponFromGrid(uid);
      return;
    }

    if (spec.category === 'attachment' && spec.suppressorType) {
      if (this.equippedWeaponId === 'unarmed') {
        this.showToast('Equip a compatible firearm first');
        return;
      }
      const wSpec = WEAPONS[this.equippedWeaponId];
      if (wSpec.compatibleSuppressorId !== item.itemId) {
        this.showToast(`Incompatible with ${wSpec.name}`);
        return;
      }
      const ws = this.getCurrentWeaponState();
      const prevId = ws.suppressorAttachedId;
      this.inventoryManager.removeItemByUid(uid);
      ws.suppressorAttachedId = item.itemId;
      ws.attachments = {
        ...normalizeWeaponAttachments(this.equippedWeaponId, ws.attachments),
        muzzle: this.equippedWeaponId === 'pm_9x19' ? 'muzzle_9mm_suppressor' : 'muzzle_pbs4_545',
      };
      if (prevId) {
        const stow = this.inventoryManager.addItem({ uid: makeInvUid('supp'), itemId: prevId, quantity: 1 });
        if (!stow.added) this.dropItemAtFeet({ uid: makeInvUid('supp'), itemId: prevId, quantity: 1 });
      }
      this.weaponRig.setAttachments(ws.attachments);
      this.audio.playReloadFoley('rack');
      this.showToast('Suppressor attached');
      this.emitSnapshot(true);
      return;
    }

    if (spec.category === 'magazine') {
      this.startPackMag(uid, 'grid');
      return;
    }

    if (spec.category === 'ammo' && spec.caliberId) {
      // Find first non-full matching magazine in grid (Rig -> Pockets -> Backpack) or loaded weapon
      const allPlaced = this.inventoryManager.getPlacedItems();
      const zoneRank: Record<StorageZoneId, number> = { rig: 0, pockets: 1, backpack: 2 };
      const magCandidates = allPlaced
        .filter((p) => {
          const mSpec = ITEMS[p.item.itemId];
          return (
            mSpec?.category === 'magazine' &&
            mSpec.caliberId === spec.caliberId &&
            getMagRoundCount(p.item) < (mSpec.magCapacity ?? 0)
          );
        })
        .sort((a, b) => zoneRank[a.zone] - zoneRank[b.zone]);

      if (magCandidates.length > 0) {
        this.startPackMag(magCandidates[0].item.uid, 'grid', undefined, uid);
        return;
      }

      // Check loaded mag on active weapon
      const ws = this.getCurrentWeaponState();
      if (ws.loadedMag) {
        const mSpec = ITEMS[ws.loadedMag.itemId];
        if (mSpec?.caliberId === spec.caliberId && getMagRoundCount(ws.loadedMag) < (mSpec.magCapacity ?? 0)) {
          this.startPackMag(ws.loadedMag.uid, 'loaded', this.equippedWeaponId, uid);
          return;
        }
      }

      this.showToast('All matching magazines full');
    }
  }

  public treatLimb(limbId: LimbId): void {
    const l = this.trauma.getLimbStatesReadOnly()[limbId];
    if (!l) return;

    const findInv = (itemId: string) =>
      this.inventoryManager.findItemByItemIdPriority(itemId, ['pockets', 'rig', 'backpack']);
    let chosen = undefined as ReturnType<typeof findInv>;

    if (l.heavyBleed) {
      chosen = findInv('tourniquet') ?? findInv('bandage');
    } else if (l.lightBleed) {
      chosen = findInv('bandage');
    } else if (l.fracture) {
      chosen = findInv('splint');
    } else if (!l.blackedOut && l.hp < l.maxHp) {
      chosen = findInv('medkit');
    } else if (l.blackedOut) {
      chosen = findInv('painkillers');
    }

    if (!chosen) {
      const cfg = LIMB_CONFIGS[limbId];
      if (!l.heavyBleed && !l.lightBleed && !l.fracture && l.hp >= l.maxHp) {
        this.showToast(`${cfg.label} nominal`);
      } else {
        this.showToast(`No matching medical item for ${cfg.label}`);
      }
      return;
    }

    this.useInventoryItem(chosen.item.uid, limbId);
  }

  private quickHealSlot(slot: 1 | 2): void {
    const mod = this.trauma.getModifiersReadOnly();
    const findPriority = (itemId: string) =>
      this.inventoryManager.findItemByItemIdPriority(itemId, ['pockets', 'rig', 'backpack']);

    let chosen = null;
    if (slot === 1) {
      // [5] Bandage / Tourniquet priority for active bleed
      if (mod.anyHeavyBleed) {
        chosen = findPriority('tourniquet') ?? findPriority('bandage');
      } else if (mod.anyLightBleed) {
        chosen = findPriority('bandage') ?? findPriority('tourniquet');
      } else if (mod.normalizedHealth < 98) {
        chosen = findPriority('medkit');
      }
      if (!chosen) {
        this.showToast(mod.anyHeavyBleed || mod.anyLightBleed ? 'No bandage/tourniquet' : 'No active bleed');
        return;
      }
    } else {
      // [6] Painkillers / Splint priority for fractures & combat stabilization
      if (mod.anyFracture) {
        chosen = findPriority('splint') ?? findPriority('painkillers');
      } else if (
        mod.leftLegImpairment > 0.18 ||
        mod.rightLegImpairment > 0.18 ||
        mod.tremorAmp > 0.0003 ||
        mod.normalizedHealth < 82
      ) {
        chosen = findPriority('painkillers') ?? findPriority('medkit');
      } else if (mod.normalizedHealth < 98) {
        chosen = findPriority('medkit') ?? findPriority('painkillers');
      } else {
        chosen = findPriority('painkillers');
      }
      if (!chosen) {
        this.showToast('No splint, painkillers, or IFAK');
        return;
      }
    }

    this.useInventoryItem(chosen.item.uid);
  }

  public detachSuppressor(): void {
    const ws = this.getCurrentWeaponState();
    if (!ws.suppressorAttachedId) return;
    const suppItem: InventoryItemInstance = {
      uid: makeInvUid('supp'),
      itemId: ws.suppressorAttachedId,
      quantity: 1,
    };
    const stow = this.inventoryManager.addItem(suppItem);
    if (!stow.added) {
      this.dropItemAtFeet(suppItem);
    }
    ws.suppressorAttachedId = null;
    if (ws.attachments) {
      ws.attachments.muzzle = null;
    }
    this.weaponRig.setAttachments(ws.attachments);
    this.audio.playReloadFoley('out');
    this.showToast(stow.added ? 'Suppressor detached' : 'Pack full — dropped suppressor');
    this.emitSnapshot(true);
  }

  public toggleFieldSuppressor(): void {
    if (
      this.mode !== 'playing' ||
      this.controller.isVaulting() ||
      this.reloadTimerSec > 0 ||
      this.equippedWeaponId === 'unarmed'
    ) {
      return;
    }
    const ws = this.getCurrentWeaponState();
    const weaponId = this.equippedWeaponId;
    const res = this.weaponRig.triggerFieldSuppressorToggle((nowAttached) => {
      if (this.equippedWeaponId !== weaponId) return;
      if (!ws.attachments) ws.attachments = {};
      ws.attachments.suppressorStowed = nowAttached ? undefined : true;
      this.showToast(nowAttached ? 'Suppressor Attached' : 'Suppressor Stowed');
      this.emitSnapshot(true);
    });
    if (res === 'no_suppressor') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    if (res === 'busy') return;
    this.firingHeld = false;
    this.input.ads = false;
    this.showToast(res === 'started_attach' ? 'Attaching Suppressor...' : 'Stowing Suppressor...');
    this.emitSnapshot(true);
  }

  private dropItemAtFeet(item: InventoryItemInstance): void {
    this.controller.getWorldLookDirection(this._tmpLook);
    this.world.dropItemAt(
      this.controller.position.x + this._tmpLook.x * 0.65,
      this.controller.position.z + this._tmpLook.z * 0.65,
      cloneItemInstance(item),
    );
  }

  private checkDepletedFragCleanup(itemId: string): void {
    if (itemId === 'weapon_rgd5_frag' && this.inventoryManager.getItemQuantity('weapon_rgd5_frag') <= 0) {
      this.ownedWeapons = this.ownedWeapons.filter((w) => w !== 'rgd5_frag');
      if (this.inventoryManager.getWeaponSlots().throwable === 'rgd5_frag') {
        this.inventoryManager.setWeaponSlot(
          'throwable',
          this.ownedWeapons.includes('throw_bolt') ? 'throw_bolt' : null,
        );
      }
      if (this.equippedWeaponId === 'rgd5_frag') {
        this.equipWeapon(this.ownedWeapons.includes('throw_bolt') ? 'throw_bolt' : 'unarmed');
      }
    }
  }

  public dropInventoryItem(uid: string): void {
    if (this.activeMagPack?.magUid === uid || this.activeMagPack?.ammoUid === uid) {
      this.cancelMagPack(false);
    }
    const dropped = this.inventoryManager.removeItemByUid(uid);
    if (!dropped) return;
    this.dropItemAtFeet(dropped);
    this.checkDepletedFragCleanup(dropped.itemId);
    this.audio.playPickup();
    this.showToast(`Dropped ${ITEMS[dropped.itemId]?.shortName ?? 'item'}`);
    this.emitSnapshot(true);
  }

  // --- Combat, Reload (Rig vs Backpack Priority), Mag Check, Interaction ---

  private startReload(): void {
    if (this.controller.isVaulting()) return;
    if (this.equippedWeaponId === 'unarmed') return;
    if (this.reloadTimerSec > 0) return;

    const wSpec = WEAPONS[this.equippedWeaponId];
    if (!wSpec.compatibleMagId) return;

    const candidate = this.inventoryManager.findBestMagazineForReload(wSpec.compatibleMagId);
    if (!candidate) {
      this.audio.playReloadFoley('check');
      this.showToast('No compatible magazine in gear');
      return;
    }

    this.cancelMagPack(false);
    const reloadScale = Math.max(0.55, this.trauma.getModifiersReadOnly().reloadSpeedMult);
    this.reloadTimerSec = (wSpec.reloadDurationSec * candidate.reloadTimeMult) / reloadScale;
    this.pendingReloadWeapon = this.equippedWeaponId;
    this.pendingReloadMagUid = candidate.placed.item.uid;

    if (candidate.zone === 'backpack') {
      this.showToast('Drawing magazine from Backpack...');
    }

    this.weaponRig.triggerReload(this.reloadTimerSec);
  }

  private finishReload(): void {
    if (!this.pendingReloadWeapon || this.pendingReloadWeapon !== this.equippedWeaponId) {
      this.pendingReloadWeapon = null;
      this.pendingReloadMagUid = null;
      return;
    }
    this.pendingReloadWeapon = null;
    const preferredUid = this.pendingReloadMagUid;
    this.pendingReloadMagUid = null;

    const wSpec = WEAPONS[this.equippedWeaponId];
    if (!wSpec.compatibleMagId) return;
    const ws = this.getCurrentWeaponState();

    let newMag: InventoryItemInstance | null = null;
    if (preferredUid) {
      const placed = this.inventoryManager.findPlacedByUid(preferredUid);
      if (placed && placed.item.itemId === wSpec.compatibleMagId) {
        newMag = this.inventoryManager.removeItemByUid(preferredUid);
      }
    }
    if (!newMag) {
      const fallback = this.inventoryManager.findBestMagazineForReload(wSpec.compatibleMagId);
      if (fallback) {
        newMag = this.inventoryManager.removeItemByUid(fallback.placed.item.uid);
      }
    }
    if (!newMag) return;
    normalizeMagazineItem(newMag);

    const oldMag = ws.loadedMag;
    ws.loadedMag = newMag;

    if (oldMag) {
      const stow = this.inventoryManager.addItem(oldMag, ['rig', 'pockets', 'backpack']);
      if (!stow.added) {
        this.dropItemAtFeet(oldMag);
        this.showToast('Rig full — dropped old magazine');
      }
    }

    if (!ws.chambered && getMagRoundCount(newMag) > 0) {
      const cal = popRoundFromMag(newMag);
      ws.chambered = Boolean(cal);
      ws.chamberedCaliber = cal;
    }
    this.syncWeaponRigAmmoState();
    this.emitSnapshot(true);
  }

  private performMagCheck(): void {
    if (this.controller.isVaulting()) return;
    if (this.equippedWeaponId === 'unarmed') return;
    const wSpec = WEAPONS[this.equippedWeaponId];
    if (!wSpec.compatibleMagId) return;
    const ws = this.getCurrentWeaponState();
    this.characterAnimator.triggerMagCheck(wSpec);

    let readout = 'No Mag';
    if (ws.loadedMag) {
      const cap = ITEMS[ws.loadedMag.itemId]?.magCapacity ?? 15;
      const r = getMagRoundCount(ws.loadedMag) + (ws.chambered ? 1 : 0);
      if (r === 0) {
        readout = `Empty · 0/${cap}`;
      } else if (r >= cap) {
        readout = `Full · ${cap}/${cap}`;
      } else {
        readout = `~${r}/${cap}`;
      }
    } else if (ws.chambered) {
      readout = '1 in chamber';
    }

    this.magCheckReadout = {
      text: readout,
      expiresAtMs: performance.now() + 1250,
    };
    this.emitSnapshot(true);
  }

  private performWeaponInspect(): void {
    if (this.controller.isVaulting() || this.reloadTimerSec > 0) return;
    if (this.equippedWeaponId === 'unarmed') return;
    const wSpec = WEAPONS[this.equippedWeaponId];
    if (this.characterAnimator.triggerInspect()) {
      this.showToast(`Inspecting ${wSpec.name}`, 2400);
    }
  }

  private tryFireWeapon(): void {
    if (this.mode !== 'playing' || !this.pointerLocked) return;
    if (this.controller.isVaulting()) return;
    if (this.equippedWeaponId === 'unarmed') return;
    if (
      this.reloadTimerSec > 0 ||
      this.fireCooldownSec > 0 ||
      this.weaponRig.isBlockingFiringAction()
    ) {
      return;
    }
    if (this.characterAnimator.getActiveAction() === 'MELEE_SWING' || this.characterAnimator.isCombatBusy()) return;

    const wSpec = WEAPONS[this.equippedWeaponId];
    if (!wSpec.caliberId) return;
    this.cancelMagPack(false);
    const ws = this.getCurrentWeaponState();

    // Check chamber / mag feed using exact roundArray
    if (!ws.chambered) {
      if (ws.loadedMag && getMagRoundCount(ws.loadedMag) > 0) {
        const cal = popRoundFromMag(ws.loadedMag);
        ws.chambered = Boolean(cal);
        ws.chamberedCaliber = cal;
      } else {
        this.weaponRig.triggerDryFire();
        this.acoustic.emitNoise(this.controller.position, 6, 'dry_fire');
        this.fireCooldownSec = 0.22;
        return;
      }
    }

    const firedCaliber: CaliberId = ws.chamberedCaliber ?? wSpec.caliberId;

    // Consume chambered round and strip next round from magazine roundArray if available
    ws.chambered = false;
    ws.chamberedCaliber = null;
    if (ws.loadedMag && getMagRoundCount(ws.loadedMag) > 0) {
      const nextCal = popRoundFromMag(ws.loadedMag);
      if (nextCal) {
        ws.chambered = true;
        ws.chamberedCaliber = nextCal;
      }
    }

    const remainingRounds = (ws.chambered ? 1 : 0) + (ws.loadedMag ? getMagRoundCount(ws.loadedMag) : 0);
    const derived = this.weaponRig.getDerivedStats();
    const suppressed =
      derived.isSuppressed ||
      (Boolean(ws.suppressorAttachedId) && !ws.attachments?.suppressorStowed);
    const caliber = CALIBERS[firedCaliber];
    this.fireCooldownSec = 60 / Math.max(60, wSpec.rpm);
    this.characterAnimator.interruptInspect();

    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir);
    this.ballistics.spawnShot(this._muzzlePos, this._muzzleDir, firedCaliber);

    const recoilMult = this.trauma.getModifiersReadOnly().recoilMult;
    this.weaponRig.triggerFire(suppressed, remainingRounds);
    this.controller.applyRecoil(
      wSpec.recoilPitchRad * derived.recoilPitchMult * (suppressed ? 0.92 : 1.0) * recoilMult,
      wSpec.recoilYawRad * derived.recoilYawMult * recoilMult,
      wSpec.kickBackM,
      {
        adsCameraShakeScale: this.tuner.adsCameraShakeScale ?? 1.0,
        hipRecoilSwayScale: this.tuner.hipRecoilSwayScale ?? 1.0,
        stanceCoupled: true,
      },
    );

    this.audio.playWeaponCue('fire', {
      position: this._muzzlePos,
      caliberId: firedCaliber,
      suppressed,
    });
    this.vitals.addAdrenalineImpulse(suppressed ? 0.1 : 0.18);
    const acousticRadius = suppressed
      ? caliber.suppressedAcousticRadiusMeters
      : caliber.acousticRadiusMeters * derived.acousticRadiusMult;
    this.acoustic.emitNoise(this.controller.position, acousticRadius, suppressed ? 'gunshot_suppressed' : 'gunshot_loud');

    if (wSpec.fireMode === 'semi' || wSpec.fireMode === 'pump') {
      this.firingHeld = false;
    }
  }

  private updateLookHover(): void {
    if (this.mode !== 'playing') {
      this.hoveredDoor = null;
      this.hoveredContainer = null;
      return;
    }

    this.controller.getWorldLookDirection(this._tmpLook);
    this.raycaster.set(this.camera.position, this._tmpLook);
    this.raycaster.near = 0.05;
    this.raycaster.far = 1.85;

    const hits = this.raycaster.intersectObjects(this.world.raycastMeshes, false);
    this.hoveredDoor = null;
    this.hoveredContainer = null;

    if (hits.length > 0) {
      const hitObj = hits[0].object;
      const doorId = hitObj.userData.doorId as string | undefined;
      const containerId = hitObj.userData.containerId as string | undefined;

      if (doorId) {
        this.hoveredDoor = this.world.doors.find((d) => d.id === doorId) ?? null;
      } else if (containerId) {
        this.hoveredContainer = this.world.containers.find((c) => c.id === containerId) ?? null;
      }
    }

    if (!this.hoveredDoor && !this.hoveredContainer) {
      for (const c of this.world.containers) {
        const dist = this.camera.position.distanceTo(c.position);
        if (dist < 1.65) {
          const toC = c.position.clone().sub(this.camera.position).normalize();
          if (toC.dot(this._tmpLook) > 0.78) {
            this.hoveredContainer = c;
            break;
          }
        }
      }
    }
  }

  private performMeleeStrike(): void {
    if (this.mode !== 'playing' || !this.pointerLocked) return;
    if (this.controller.isVaulting()) return;
    if (this.reloadTimerSec > 0) return;
    this.cancelMagPack(false);

    const wSpec = WEAPONS[this.equippedWeaponId];
    if (wSpec.holdClass === 'unarmed') {
      const punch = this.characterAnimator.triggerUnarmedPunch(
        this.controller.isVaulting(),
        this.input.ads && !this.controller.isSprinting,
      );
      if (!punch) return;
      this.stamina = Math.max(0, this.stamina - (punch === 'cross' ? 0.065 : 0.04));
      return;
    }

    const isFirearm =
      wSpec.holdClass === 'pistol' ||
      wSpec.holdClass === 'rifle' ||
      wSpec.holdClass === 'shotgun';
    if (isFirearm) {
      if (!this.characterAnimator.triggerArmedBash(this.controller.isVaulting(), wSpec.holdClass)) return;
      this.stamina = Math.max(0, this.stamina - 0.06);
      return;
    }

    if (this.meleeCooldownSec > 0) return;
    if (!this.characterAnimator.triggerMeleeSwing(wSpec)) return;

    this.meleeCooldownSec = Math.max(0.42, (wSpec.meleeSwingDurationSec ?? 0.48) + 0.06);
    this.audio.playWhoosh(wSpec.id === 'crowbar');
  }

  private performPushKick(): void {
    if (this.mode !== 'playing' || !this.pointerLocked) return;
    this.cancelMagPack(false);
    const res = this.characterAnimator.triggerPushKick(
      this.controller.grounded,
      this.controller.isVaulting(),
      this.trauma.getModifiersReadOnly(),
    );
    if (res === 'dual_leg_trauma') {
      this.showToast('Both legs fractured — cannot push-kick');
      return;
    }
    if (res !== 'ok') return;

    if (this.reloadTimerSec > 0) {
      this.reloadTimerSec = 0;
    }
    this.stamina = Math.max(0, this.stamina - 0.11);
    this.vitals.addAdrenalineImpulse(0.14);
  }

  private handleCombatMeleeHit(ev: Readonly<BodycamMeleeHitEvent>): void {
    if (this.mode !== 'playing') return;
    const obj = ev.object;
    const ud = obj?.userData;

    const zombieId = ud?.zombieId as string | undefined;
    if (zombieId) {
      const limbZone = (ud?.hitZone ?? 'thorax') as LimbId;
      this.zombies.applyMeleeHit(zombieId, limbZone, ev);
      this.ballistics.spawnImpactParticles(ev.point as THREE.Vector3, ev.normal as THREE.Vector3, 'flesh');
      this.vitals.addAdrenalineImpulse(ev.attackType === 'kick' ? 0.15 : 0.09);
      return;
    }

    const doorId = ud?.doorId as string | undefined;
    if (doorId && (ev.attackType === 'kick' || ev.attackType === 'bash')) {
      const door = this.world.doors.find((d) => d.id === doorId);
      const particleKind: 'metal' | 'wood' =
        door?.collider.surface === 'metal' || ev.surface === 'metal' ? 'metal' : 'wood';
      if (door && !door.isOpen) {
        // Pivot local +X leaf points along (cos(angle), 0, -sin(angle)) in world XZ.
        const openDirX = Math.cos(door.openAngle);
        const openDirZ = -Math.sin(door.openAngle);
        const pushDot = ev.direction.x * openDirX + ev.direction.z * openDirZ;
        const playerSideDot =
          (this.controller.position.x - door.hingePos.x) * openDirX +
          (this.controller.position.z - door.hingePos.z) * openDirZ;

        if (pushDot > 0.15 && playerSideDot < 0.08) {
          this.world.setDoorOpen(door, true);
          this.audio.playDoorCreak(door.hingePos, true);
          this.acoustic.emitNoise(door.hingePos, 22, 'door');
          if (ev.attackType === 'kick') {
            this.showToast('Door kicked open');
          }
        } else {
          // Struck against hinge/doorstop from pull side: rattle frame without opening
          let angleDiff = door.openAngle - door.closedAngle;
          while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          door.currentAngle = door.closedAngle + Math.sign(angleDiff || 1) * 0.016;
          this.acoustic.emitNoise(door.hingePos, 16, 'door');
          this.showToast('Door swings the other way');
        }
      }
      this.ballistics.spawnImpactParticles(ev.point as THREE.Vector3, ev.normal as THREE.Vector3, particleKind);
      return;
    }

    if (ev.hitZone !== 'glass') {
      const particleKind: 'metal' | 'wood' | 'concrete' =
        ev.surface === 'metal' ? 'metal' : ev.surface === 'wood' ? 'wood' : 'concrete';
      this.ballistics.spawnImpactParticles(ev.point as THREE.Vector3, ev.normal as THREE.Vector3, particleKind);
    }
  }

  private resolveMeleeImpact(wSpec: WeaponSpec): void {
    if (this.mode !== 'playing') return;

    const isKnifeOrCrowbar = wSpec.holdClass === 'melee_1h' || wSpec.holdClass === 'melee_2h';
    this.controller.applyRecoil(isKnifeOrCrowbar ? 0.025 : 0.04, -0.035, 0.014, {
      stanceCoupled: false,
    });
    this.vitals.addAdrenalineImpulse(0.12);
    this.controller.getWorldLookDirection(this._tmpLook);

    this._tmpRight.crossVectors(this._tmpLook, THREE.Object3D.DEFAULT_UP);
    if (this._tmpRight.lengthSq() < 0.0001) {
      this._tmpRight.set(1, 0, 0);
    } else {
      this._tmpRight.normalize();
    }
    this._tmpUp.crossVectors(this._tmpRight, this._tmpLook).normalize();

    const range = wSpec.meleeRangeM ?? 1.75;
    const energyJ = wSpec.meleeEnergyJ ?? 145;
    const selfMeshes = this._tmpLook.y < -0.58 ? this.characterSkeleton.getSelfHitMeshes() : [];
    const targets = selfMeshes.length > 0
      ? [...this.world.raycastMeshes, ...this.zombies.getHitMeshes(), ...selfMeshes]
      : [...this.world.raycastMeshes, ...this.zombies.getHitMeshes()];

    const offsets: [number, number][] = [
      [0, 0],
      [0.09, 0],
      [-0.09, 0],
      [0, 0.08],
      [0, -0.08],
    ];

    let bestHit: THREE.Intersection | null = null;
    for (const [ox, oy] of offsets) {
      this._tmpOrigin
        .copy(this.camera.position)
        .addScaledVector(this._tmpRight, ox)
        .addScaledVector(this._tmpUp, oy);
      this.raycaster.set(this._tmpOrigin, this._tmpLook);
      this.raycaster.near = 0.05;
      this.raycaster.far = range;
      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length > 0 && (!bestHit || hits[0].distance < bestHit.distance)) {
        bestHit = hits[0];
        if (ox === 0 && oy === 0) break;
      }
    }

    if (!bestHit && selfMeshes.length > 0 && this._tmpLook.y < -0.66) {
      this._tmpOrigin.copy(this.camera.position).addScaledVector(this._tmpLook, 0.16);
      this._tmpOrigin.y -= 0.08;
      this.raycaster.set(this._tmpOrigin, this._tmpLook);
      this.raycaster.near = 0.02;
      this.raycaster.far = Math.min(range, 1.45);
      const selfHits = this.raycaster.intersectObjects(selfMeshes, false);
      if (selfHits.length > 0) {
        bestHit = selfHits[0];
      }
    }

    if (!bestHit) return;

    const obj = bestHit.object;
    const windowId = obj.userData.windowId as string | undefined;
    const zombieId = obj.userData.zombieId as string | undefined;
    const playerLimb = obj.userData.playerLimb as LimbId | undefined;
    const normal = bestHit.face?.normal
      ? bestHit.face.normal.clone().transformDirection(obj.matrixWorld).normalize()
      : this._tmpLook.clone().negate();

    if (windowId) {
      this.world.shatterWindow(windowId, bestHit.point, this._tmpLook);
      return;
    }

    const meleeKind = wSpec.id === 'tactical_knife' ? 'slash' : 'blunt';

    if (playerLimb) {
      const groundY = this.world.groundHeightAt(this.controller.position.x, this.controller.position.z);
      const res = this.trauma.applySelfHit(playerLimb, meleeKind, energyJ, bestHit.point, groundY);
      this.vitals.addAdrenalineImpulse(0.45);
      this.audio.playImpact(bestHit.point, 'flesh');
      this.ballistics.spawnImpactParticles(bestHit.point, normal, 'flesh');
      if (playerLimb === 'head') {
        this.audio.triggerConcussion(0.65);
      }
      if (res.fatal) {
        this.handlePlayerDeath();
      }
      return;
    }

    if (zombieId) {
      const hitZone = (obj.userData.hitZone as LimbId) ?? 'thorax';
      this.zombies.applyDamage(zombieId, hitZone, energyJ, this._tmpLook, bestHit.point, meleeKind);
      this.audio.playImpact(bestHit.point, 'flesh');
      this.ballistics.spawnImpactParticles(bestHit.point, normal, 'flesh');
      if (!isKnifeOrCrowbar) {
        this.acoustic.emitNoise(bestHit.point, 4.5, 'impact');
      }
      return;
    }

    const surf = (obj.userData.surface as SurfaceType) ?? 'concrete';
    const audioMat = surf === 'metal' ? 'metal' : surf === 'wood' ? 'wood' : 'concrete';
    this.audio.playImpact(bestHit.point, audioMat);
    if (surf === 'concrete' || surf === 'metal') {
      this.ballistics.spawnImpactParticles(bestHit.point, normal, 'metal');
      if (surf === 'concrete') {
        this.ballistics.spawnImpactParticles(bestHit.point, normal, 'concrete');
      }
    } else {
      this.ballistics.spawnImpactParticles(bestHit.point, normal, surf);
    }
    this.acoustic.emitNoise(bestHit.point, isKnifeOrCrowbar ? 5.5 : 8.0, 'impact');
  }

  private spawnThrownProjectile(
    spec: WeaponSpec,
    handWorldPos: THREE.Vector3,
    remainingFuseSec: number,
    speedMps?: number,
    style: SurvivalThrowStyle = 'overhand',
  ): void {
    const kind = spec.id === 'rgd5_frag' ? 'rgd5_frag' : 'throw_bolt';
    this.controller.getWorldLookDirection(this._tmpLook);

    const speed = speedMps ?? spec.throwVelocityMps ?? 18.5;
    this._throwVel.copy(this._tmpLook).multiplyScalar(speed);
    this._throwVel.y += style === 'underhand' ? 2.1 : 2.35;
    this.controller.getVelocity(this._tmpPlayerVel);
    this._throwVel.x += this._tmpPlayerVel.x * 0.48;
    this._throwVel.y += this._tmpPlayerVel.y * 0.30;
    this._throwVel.z += this._tmpPlayerVel.z * 0.48;

    this._tmpOrigin.copy(handWorldPos).addScaledVector(this._tmpLook, 0.14);
    this.throwables.spawnThrowable(kind, this._tmpOrigin, this._throwVel, remainingFuseSec);
    this.audio.playWhoosh(kind === 'rgd5_frag');

    if (spec.consumableOnThrow && spec.itemId) {
      const placed = this.inventoryManager.findItemByItemIdPriority(spec.itemId, ['rig', 'pockets', 'backpack']);
      if (placed) {
        this.inventoryManager.consumeQuantityByUid(placed.item.uid, 1);
      }
      if (this.inventoryManager.getItemQuantity(spec.itemId) <= 0) {
        this.pendingDepletedThrowable = spec.id;
      }
      this.emitSnapshot(true);
    }
  }

  private handleOvercookedThrowable(spec: WeaponSpec, handWorldPos: THREE.Vector3): void {
    if (spec.consumableOnThrow && spec.itemId) {
      const placed = this.inventoryManager.findItemByItemIdPriority(spec.itemId, ['rig', 'pockets', 'backpack']);
      if (placed) {
        this.inventoryManager.consumeQuantityByUid(placed.item.uid, 1);
      }
      if (this.inventoryManager.getItemQuantity(spec.itemId) <= 0) {
        this.pendingDepletedThrowable = spec.id;
      }
    }
    this.controller.setGrenadeTension(0, false, 'underhand');
    this.throwables.detonateAt(handWorldPos, this.world, this.controller.position, (dmg, bleed, orig) => {
      this.applyPlayerBlastDamage(dmg, bleed, orig);
    });
    this.controller.applyRecoil(0.28, (Math.random() - 0.5) * 0.32, 0.055, {
      stanceCoupled: false,
    });
    this.emitSnapshot(true);
  }

  private handlePlayerDeath(): void {
    if (this.mode === 'dead') return;
    this.mode = 'dead';
    this.vitals.setFlatline();
    this.cancelMagPack(false);
    this.clearMovementInputs();
    this.audio.resetTraumaAudio();
    this.exitLock();
    this.emitSnapshot(true);
  }

  private applyPlayerBlastDamage(damage: number, bleedChance: number, origin: THREE.Vector3): void {
    if (this.mode !== 'playing') return;
    const groundY = this.world.groundHeightAt(this.controller.position.x, this.controller.position.z);
    const fatal = this.trauma.applyBlastDamage(damage, bleedChance, this.controller.position, groundY);
    this.vitals.addAdrenalineImpulse(0.68);
    this.audio.triggerConcussion(THREE.MathUtils.clamp(damage / 45, 0.4, 1.0));
    this.audio.playImpact(origin, 'flesh');
    this.controller.applyRecoil(0.18, (Math.random() - 0.5) * 0.22, 0.04, {
      stanceCoupled: false,
    });
    if (fatal) {
      this.handlePlayerDeath();
    }
  }

  private interact(): void {
    if (this.hoveredDoor) {
      const d = this.hoveredDoor;
      this.world.setDoorOpen(d, !d.isOpen);
      this.audio.playDoorCreak(d.hingePos, d.isOpen);
      this.acoustic.emitNoise(d.hingePos, 14, 'door');
      return;
    }

    if (this.hoveredContainer) {
      this.activeContainer = this.hoveredContainer;
      this.activeContainer.state.searched = true;
      this.mode = 'inventory';
      this.clearMovementInputs();
      this.exitLock();
      this.audio.playPickup();
      this.emitSnapshot(true);
    }
  }

  // --- Main Loop ---

  private scheduleNextTick(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(() => {
        if (!this.disposed) this.tick();
      });
    } else {
      this.frameId = requestAnimationFrame(() => this.tick());
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick(): void {
    if (this.disposed) return;

    const nowMs = performance.now();
    const delta = Math.min((nowMs - this.lastTimeMs) / 1000, 0.1);
    this.lastTimeMs = nowMs;
    this.elapsedSec += delta;

    if (this.mode === 'menu') {
      const angle = this.elapsedSec * 0.055;
      const ox = this.world.chunkManager.originX;
      const oz = this.world.chunkManager.originZ;
      this.camera.position.set(-10 - ox + Math.cos(angle) * 6, 2.2, 13 - oz + Math.sin(angle) * 5);
      this.camera.lookAt(3.5 - ox, 1.4, -2.0 - oz);
      this.weaponRig.root.visible = false;
      this.characterSkeleton.root.visible = false;
      this.composer.update(delta, this.elapsedSec, this.tuner, 100, false);
      this.composer.render();
      this.scheduleNextTick();
      return;
    }

    this.weaponRig.root.visible = true;
    this.characterSkeleton.root.visible = true;

    // Manual round-by-round magazine packing/unloading ticks seamlessly in both Inventory & Playing modes
    if (this.mode === 'inventory' || this.mode === 'playing') {
      this.tickMagPack(delta);
    }

    const traumaMod = this.trauma.getModifiersReadOnly();
    let breathVignette = 0;

    if (this.mode === 'playing') {
      this.playtimeSec += delta;

      // Cooldowns & Reload
      if (this.fireCooldownSec > 0) this.fireCooldownSec = Math.max(0, this.fireCooldownSec - delta);
      if (this.meleeCooldownSec > 0) this.meleeCooldownSec = Math.max(0, this.meleeCooldownSec - delta);
      if (this.firingHeld) this.tryFireWeapon();

      if (this.reloadTimerSec > 0) {
        this.reloadTimerSec -= delta;
        if (this.reloadTimerSec <= 0) {
          this.reloadTimerSec = 0;
          this.finishReload();
        }
      }

      const groundY = this.world.groundHeightAt(this.controller.position.x, this.controller.position.z);
      this.trauma.update(delta, this.controller.position, groundY);
      if (!traumaMod.alive) {
        this.handlePlayerDeath();
      } else {
        if (this.trauma.consumeFlinch(this._tmpFlinch)) {
          this.controller.applyTraumaFlinch(this._tmpFlinch.pitch, this._tmpFlinch.yaw);
        }

        // Compute encumbrance & survival vitals modifiers (non-invasive input into BodycamController)
        const enc = this.inventoryManager.computeEncumbrance(
          this.ownedWeapons,
          this.weaponStates,
          this.hasFlashlight,
        );

        this.input.adsMode = this.getArmedAdsMode(this.equippedWeaponId);
        this.input.cant = false;

        // Holding Shift while aiming (RMB held) engages Hold-Breath instead of cancelling aim for sprint
        this.input.sprint = this.shiftHeld && !this.input.ads;
        const isMovingInput =
          this.input.forward || this.input.backward || this.input.left || this.input.right;
        const wantsHoldBreath =
          this.input.ads &&
          (this.shiftHeld || this.altHeld) &&
          this.equippedWeaponId !== 'unarmed';

        const zombieStats = this.zombies.getDebugStats();
        const threatLevel = THREE.MathUtils.clamp(
          zombieStats.chasing * 0.65 + zombieStats.investigating * 0.22,
          0,
          1,
        );

        const vitalsRes = this.vitals.update(delta, {
          isSprinting: this.controller.isSprinting,
          isMoving: isMovingInput,
          isAds: this.controller.isAds || this.controller.isCanted || this.controller.isPointAim,
          wantsHoldBreath,
          isHealingOrBleeding:
            traumaMod.anyLightBleed || traumaMod.anyHeavyBleed || traumaMod.painkillerRemainingSec > 0,
          encumbranceRatio: enc.encumbranceRatio,
          stamina: this.stamina,
          moveSpeedRatio: THREE.MathUtils.clamp(this.controller.getCurrentMoveSpeed() / 4.8, 0, 1.25),
          crouched: this.controller.crouched,
          exertion: this.controller.getExertion(),
          health: traumaMod.normalizedHealth,
          lightBleeding: traumaMod.anyLightBleed,
          heavyBleeding: traumaMod.anyHeavyBleed,
          heartbeatSeverity: traumaMod.heartbeatSeverity,
          threatLevel,
        });

        this.input.holdBreath = this.vitals.holdBreathActive;
        breathVignette = vitalsRes.breathVignette;

        if (vitalsRes.exertionReboundImpulse > 0) {
          this.controller.addExertionImpulse(vitalsRes.exertionReboundImpulse);
        }
        if (vitalsRes.triggerInhale) {
          this.audio.playBreathCue('inhale', 0.92);
        }
        if (vitalsRes.triggerLowBreathPulse) {
          this.audio.playBreathCue('low_o2_pulse', vitalsRes.lowBreathPulseIntensity);
        }
        if (vitalsRes.triggerExhaleGasp) {
          this.audio.playExhaleGasp(vitalsRes.exhaleGaspDepleted);
        }
        if (vitalsRes.triggerStomachGrowl) {
          this.audio.playStomachGrowl();
        }
        if (vitalsRes.triggerFatigueSigh) {
          this.audio.playFatigueSigh();
        }

        // Stamina capped by thorax vital condition & hydration/hunger energy
        const effectiveStaminaCap = traumaMod.staminaCap * vitalsRes.staminaCapMult;
        if (!this.controller.isSprinting) {
          this.stamina = Math.min(effectiveStaminaCap, this.stamina + 0.14 * vitalsRes.staminaRegenMult * delta);
        } else {
          this.stamina = Math.min(effectiveStaminaCap, this.stamina);
          if (this.activeMagPack) {
            this.cancelMagPack(false);
          }
        }

        // Flashlight battery economy: dims & flickers organically below 15%, clicks dead at 0%
        const flEval = this.vitals.evaluateFlashlight(delta, this.battery, this.flashlightOn);
        this.battery = flEval.nextBattery;
        if (flEval.render.diedThisFrame) {
          this.flashlightOn = false;
          this.weaponRig.flashlight.visible = false;
          this.audio.playFlashlightClick();
          this.showToast('Flashlight battery dead');
        } else if (this.flashlightOn) {
          this.weaponRig.flashlight.intensity = flEval.render.intensity;
        }

        this._survivalMods.encumbranceRatio = enc.encumbranceRatio;
        this._survivalMods.swayAmpMult = vitalsRes.swayAmpMult;
        this._survivalMods.staminaDrainMult = enc.staminaDrainMult * vitalsRes.staminaDrainMult;
        this._survivalMods.exertionRateMult = enc.exertionRateMult * vitalsRes.exertionRateMult;
        this._survivalMods.moveSpeedMult = enc.moveSpeedMult * vitalsRes.moveSpeedMult;
        this._survivalMods.canSprint = enc.canSprint && vitalsRes.canSprintVitals;

        const tTension = this.characterAnimator.getThrowableTension();
        this.controller.setGrenadeTension(
          tTension.charge01,
          tTension.liveCook,
          tTension.throwStyle,
        );

        this.controller.update(
          delta,
          this.elapsedSec,
          this.input,
          this.world,
          this.worldAdapter,
          this.equippedWeaponId,
          this.tuner,
          this.stamina,
          traumaMod.normalizedHealth,
          (drain) => {
            this.stamina = Math.max(0, this.stamina - drain);
          },
          traumaMod,
          (dropMeters) => {
            const injured = this.trauma.applyFallImpact(dropMeters, this.controller.position, groundY);
            if (injured) {
              this.vitals.addAdrenalineImpulse(0.42);
              this.audio.playImpact(this.controller.position, 'flesh');
              this.controller.applyRecoil(0.11, (Math.random() - 0.5) * 0.08, 0.025, {
                stanceCoupled: false,
              });
              if (!this.trauma.getModifiersReadOnly().alive) {
                this.handlePlayerDeath();
              }
            }
          },
          this._survivalMods,
        );

        // Surface subtle dual-leg trauma feedback if high mantle or jump was blocked
        const vaultBlock = this.controller.consumeVaultBlockReason();
        if (vaultBlock === 'dual_leg_trauma') {
          this.showToast('Both legs impaired — high mantle blocked');
        }
        const jumpBlock = this.controller.consumeJumpBlockReason();
        if (jumpBlock === 'dual_leg_trauma') {
          this.showToast('Both legs impaired — cannot jump');
        }

        // Floating-Origin Rebasing & Time-Sliced Chunk Streaming
        this.world.rebaseIfNeeded(this.controller.position, (sx, sz) => {
          this.camera.position.x -= sx;
          this.camera.position.z -= sz;
          this.weaponRig.root.position.x -= sx;
          this.weaponRig.root.position.z -= sz;
          this.weaponRig.root.updateMatrixWorld(true);
          this.controller.shiftVaultOrigin(-sx, -sz);
          this.zombies.shiftOrigin(sx, sz);
          this.ballistics.shiftOrigin(sx, sz);
          this.throwables.shiftOrigin(sx, sz);
          this.acoustic.shiftOrigin(sx, sz);
          this.trauma.shiftOrigin(sx, sz);
        });
        this.world.updateStreaming(this.controller.position.x, this.controller.position.z, delta);

        // Read-only controller kinematics -> Layered Full-Body Skeleton + 2-Bone Analytic IK Animator
        const driverState = this.stateReader.read(this.controller, this.weaponRig, this.camera);
        this.controller.getWorldLookDirection(this._tmpLook);
        this.characterAnimator.update(
          delta,
          this.elapsedSec,
          driverState,
          WEAPONS[this.equippedWeaponId],
          this.world.groundHeightAt,
          traumaMod,
          this.worldAdapter,
          this._tmpLook,
          this.input.ads,
        );
        this.characterAnimator.applyCameraAdditiveOverlay(this.camera);

        if (this.pendingDepletedThrowable && !this.characterAnimator.isBusy()) {
          const depleted = this.pendingDepletedThrowable;
          this.pendingDepletedThrowable = null;
          this.ownedWeapons = this.ownedWeapons.filter((w) => w !== depleted);
          if (this.inventoryManager.getWeaponSlots().throwable === depleted) {
            this.inventoryManager.setWeaponSlot(
              'throwable',
              this.ownedWeapons.includes('throw_bolt') ? 'throw_bolt' : null,
            );
          }
          if (this.equippedWeaponId === depleted) {
            this.equipWeapon(this.ownedWeapons.includes('throw_bolt') ? 'throw_bolt' : 'unarmed');
          }
        }

        const acType = this.world.getIndoorAcoustics(this.controller.position.x, this.controller.position.z);
        this.audio.setInteriorAcoustics(acType !== 'outdoor', acType);
        this.audio.setTraumaAcoustics(traumaMod.muffleLevel);

        this.ballistics.update(
          delta,
          this.world,
          this.characterSkeleton.getSelfHitMeshes(),
          (limbId, energyJ, _dir, pos) => {
            const res = this.trauma.applySelfHit(limbId, 'bullet', energyJ, pos, groundY);
            this.vitals.addAdrenalineImpulse(0.5);
            if (limbId === 'head') {
              this.audio.triggerConcussion(0.85);
            }
            if (res.fatal) {
              this.handlePlayerDeath();
            }
          },
        );
        this.throwables.update(delta, this.world, this.controller.position, (dmg, bleed, orig) => {
          this.applyPlayerBlastDamage(dmg, bleed, orig);
        });
        this.acoustic.update(delta);

        for (const d of this.world.doors) {
          const target = d.isOpen ? d.openAngle : d.closedAngle;
          d.currentAngle = THREE.MathUtils.damp(d.currentAngle, target, 8.5, delta);
          d.pivot.rotation.y = d.currentAngle;
        }

        this.controller.getWorldLookDirection(this._tmpLook);
        this.zombies.update(
          delta,
          nowMs,
          this.world,
          this.controller.position,
          this.controller.crouched,
          this.flashlightOn,
          this._tmpLook,
          (damage, bleedChance) => {
            const hitRes = this.trauma.applyZombieAttack(
              damage,
              bleedChance,
              this.controller.position,
              groundY,
            );
            this.vitals.addAdrenalineImpulse(0.55);
            if (hitRes.limbId === 'head') {
              this.audio.triggerConcussion(0.7);
            }
            this.audio.playImpact(this.controller.position, 'flesh');
            this.controller.applyRecoil(0.09, 0.08, 0.02, { stanceCoupled: false });
            if (hitRes.fatal) {
              this.handlePlayerDeath();
            }
          },
        );

        this.audio.tickBiometrics(
          traumaMod.normalizedHealth,
          this.stamina,
          traumaMod.anyLightBleed || traumaMod.anyHeavyBleed,
          nowMs,
          traumaMod.heartbeatSeverity,
          Math.max(traumaMod.raggedBreathSeverity, vitalsRes.fatigueBreathSeverity),
        );
        this.updateLookHover();
      }
    }

    this.composer.update(
      delta,
      this.elapsedSec,
      this.tuner,
      traumaMod.normalizedHealth,
      traumaMod.anyLightBleed || traumaMod.anyHeavyBleed,
      traumaMod,
      breathVignette,
    );
    this._scopePassParams.dt = delta;
    this.composer.render();

    this.emitSnapshot(false);
    this.scheduleNextTick();
  }

  // --- Event Listeners ---

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    const code = e.code;

    if (code === 'F1') {
      e.preventDefault();
      if (this.mode !== 'menu') {
        this.toggleTuner();
      }
      return;
    }

    if (code === 'F5') {
      e.preventDefault();
      if (this.mode === 'playing' || this.mode === 'pause' || this.mode === 'inventory') {
        void this.createSave('Quicksave', true);
      }
      return;
    }

    if (code === 'F9') {
      e.preventDefault();
      if (this.mode !== 'menu') {
        void this.loadSave('quicksave');
      }
      return;
    }

    if (code === 'Tab') {
      e.preventDefault();
      if (this.mode === 'playing') {
        this.activeContainer = null;
        this.mode = 'inventory';
        this.clearMovementInputs();
        this.exitLock();
        this.emitSnapshot(true);
      } else if (this.mode === 'inventory') {
        this.resumeGame();
      }
      return;
    }

    if (code === 'Escape') {
      if (this.mode === 'inventory') {
        this.resumeGame();
      } else if (this.mode === 'pause') {
        this.resumeGame();
      } else if (this.mode === 'playing') {
        this.openPauseMenu();
      }
      return;
    }

    if (this.mode !== 'playing') return;

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
        this.input.sprint = !this.input.ads;
        break;
      case 'AltLeft':
      case 'AltRight':
        e.preventDefault();
        this.altHeld = true;
        break;
      case 'Space':
        e.preventDefault();
        this.input.vault = true;
        break;
      case 'KeyC':
        if (!e.repeat) {
          this.controller.toggleCrouch();
        }
        break;
      case 'KeyB':
        if (!e.repeat) {
          if (!this.weaponRig.hasCantedOptic()) break;
          const cur = this.getArmedAdsMode(this.equippedWeaponId);
          const next: AdsMode = cur === 'CANTED' ? 'PRIMARY' : 'CANTED';
          this.setArmedAdsMode(this.equippedWeaponId, next);
          this.audio.playTacticalSwitchClick(next === 'CANTED');
          this.showToast(
            next === 'CANTED' ? 'Canted Sight Mode: ARMED (RMB)' : 'Primary Optic ADS (RMB)',
          );
          this.emitSnapshot(true);
        }
        break;
      case 'KeyL':
        if (!e.repeat) {
          if (!this.weaponRig.getDerivedStats().hasLaser) {
            this.showToast('No tactical laser attachment mounted');
          } else if (e.altKey || this.altHeld) {
            e.preventDefault();
            const mode = this.weaponRig.cycleLaserMode();
            this.weaponRig.triggerTacticalSwitch();
            this.audio.playTacticalSwitchClick(true);
            this.showToast(mode === 'red' ? 'Rail Laser: Visible Red' : 'Rail Laser: IR Green');
          } else {
            const on = this.weaponRig.toggleLaser();
            this.weaponRig.triggerTacticalSwitch();
            this.audio.playTacticalSwitchClick(on);
            this.showToast(on ? 'Rail Laser ON' : 'Rail Laser OFF');
          }
        }
        break;
      case 'KeyQ':
        this.input.leanLeft = true;
        break;
      case 'KeyE':
        this.input.leanRight = true;
        break;
      case 'KeyF':
        if (!e.repeat) {
          this.interact();
        }
        break;
      case 'KeyR':
        if (!e.repeat) this.startReload();
        break;
      case 'KeyG':
        if (!e.repeat) this.toggleFieldSuppressor();
        break;
      case 'KeyI':
        if (!e.repeat) this.performWeaponInspect();
        break;
      case 'KeyT':
        if (!e.repeat) {
          if (e.altKey || this.altHeld) {
            e.preventDefault();
            this.performMagCheck();
          } else if (!this.hasFlashlight) {
            this.showToast('No flashlight equipped');
          } else if (this.battery <= 0.001) {
            this.flashlightOn = false;
            this.weaponRig.flashlight.visible = false;
            this.weaponRig.triggerTacticalSwitch();
            this.audio.playFlashlightClick();
            this.showToast('Battery dead — swap AA/CR123A in Tab');
          } else {
            this.flashlightOn = !this.flashlightOn;
            this.weaponRig.flashlight.visible = this.flashlightOn;
            this.weaponRig.triggerTacticalSwitch();
            this.audio.playFlashlightClick();
            this.emitSnapshot(true);
          }
        }
        break;
      case 'KeyV':
        if (!e.repeat) this.performMeleeStrike();
        break;
      case 'KeyX':
        if (!e.repeat) this.performPushKick();
        break;
      case 'KeyN':
        if (!e.repeat) {
          const illum = this.weaponRig.toggleReticleIllumination();
          this.audio.playTacticalSwitchClick(illum);
          this.showToast(illum ? 'Reticle Illumination: ON' : 'Reticle Illumination: ETCHED OFF');
        }
        break;
      case 'BracketRight':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          const prev = this.weaponRig.getActiveOpticZoomMult();
          const next = this.weaponRig.cycleOpticZoom(1);
          if (Math.abs(next - prev) >= 0.01) {
            this.audio.playTacticalSwitchClick(true);
            this.showToast(`Optic Magnification: ${next.toFixed(1)}x`);
          }
        }
        break;
      case 'BracketLeft':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          const prev = this.weaponRig.getActiveOpticZoomMult();
          const next = this.weaponRig.cycleOpticZoom(-1);
          if (Math.abs(next - prev) >= 0.01) {
            this.audio.playTacticalSwitchClick(false);
            this.showToast(`Optic Magnification: ${next.toFixed(1)}x`);
          }
        }
        break;
      case 'Digit0':
      case 'Backquote':
        this.equipSlotKind('unarmed');
        break;
      case 'Digit1':
        this.equipSlotKind('primary');
        break;
      case 'Digit2':
        this.equipSlotKind('sidearm');
        break;
      case 'Digit3':
        this.equipSlotKind('melee');
        break;
      case 'Digit4':
        this.equipSlotKind('throwable');
        break;
      case 'Digit5':
        if (!e.repeat) this.quickHealSlot(1);
        break;
      case 'Digit6':
        if (!e.repeat) this.quickHealSlot(2);
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
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
        this.input.sprint = false;
        break;
      case 'AltLeft':
      case 'AltRight':
        this.altHeld = false;
        break;
      case 'Space':
        this.input.vault = false;
        break;
      case 'KeyQ':
        this.input.leanLeft = false;
        break;
      case 'KeyE':
        this.input.leanRight = false;
        break;
    }
  };

  private clearMovementInputs(): void {
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.ads = false;
    this.input.cant = false;
    this.input.holdBreath = false;
    this.input.vault = false;
    this.shiftHeld = false;
    this.altHeld = false;
    this.firingHeld = false;
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.mode !== 'playing' || !this.pointerLocked || this.tunerOpen) return;
    if (Math.abs(e.movementX) > 220 || Math.abs(e.movementY) > 220) return;
    this.controller.handleMouseMove(e.movementX, e.movementY, this.tuner);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
    if (this.mode !== 'playing' || this.tunerOpen) return;
    this.audio.ensureInitialized();

    if (!this.pointerLocked) {
      this.requestLock();
      return;
    }

    if (e.button === 0) {
      this.characterAnimator.interruptInspect();
      if (this.controller.isVaulting()) return;
      const wSpec = WEAPONS[this.equippedWeaponId];
      if (
        wSpec.holdClass === 'unarmed' ||
        wSpec.holdClass === 'melee_1h' ||
        wSpec.holdClass === 'melee_2h'
      ) {
        this.performMeleeStrike();
      } else if (wSpec.holdClass === 'throwable') {
        if (wSpec.consumableOnThrow && wSpec.itemId && this.inventoryManager.getItemQuantity(wSpec.itemId) <= 0) {
          this.showToast('No grenades remaining');
          return;
        }
        if (!this.characterAnimator.beginThrowInput(wSpec)) {
          if (wSpec.id === 'rgd5_frag') {
            this.showToast('Pull pin with [RMB] first');
          }
        }
      } else {
        this.firingHeld = true;
        this.tryFireWeapon();
      }
    } else if (e.button === 1) {
      e.preventDefault();
      const wSpec = WEAPONS[this.equippedWeaponId];
      if (
        !wSpec ||
        (wSpec.holdClass !== 'pistol' &&
          wSpec.holdClass !== 'rifle' &&
          wSpec.holdClass !== 'shotgun')
      ) {
        return;
      }
      const cur = this.getArmedAdsMode(this.equippedWeaponId);
      const next: AdsMode = cur === 'POINT_AIM' ? 'PRIMARY' : 'POINT_AIM';
      this.setArmedAdsMode(this.equippedWeaponId, next);
      this.audio.playTacticalSwitchClick(next === 'POINT_AIM');
      this.showToast(
        next === 'POINT_AIM' ? 'Point Aim Mode: ARMED (RMB)' : 'Primary Optic ADS (RMB)',
      );
      this.emitSnapshot(true);
    } else if (e.button === 2) {
      this.characterAnimator.interruptInspect();
      const wSpec = WEAPONS[this.equippedWeaponId];
      if (wSpec?.holdClass === 'throwable') {
        this.input.ads = false;
        this.input.sprint = false;
        if (wSpec.id === 'rgd5_frag') {
          if (!this.characterAnimator.pullThrowablePin(wSpec)) {
            this.characterAnimator.releaseThrowableLever(wSpec);
          }
        }
        return;
      }
      this.input.ads = true;
      this.input.sprint = false;
    }
  };

  private onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) {
      e.preventDefault();
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.firingHeld = false;
      const wSpec = WEAPONS[this.equippedWeaponId];
      if (wSpec.holdClass === 'throwable') {
        this.characterAnimator.releaseThrowInput(wSpec);
      }
    } else if (e.button === 2) {
      this.input.ads = false;
      this.input.sprint = this.shiftHeld;
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (this.mode === 'playing') {
      e.preventDefault();
    }
  };

  private onWheel = (e: WheelEvent): void => {
    if (
      this.mode === 'playing' &&
      this.pointerLocked &&
      !this.tunerOpen &&
      !this.controller.isSprinting &&
      this.weaponRig.hasVariableZoom()
    ) {
      e.preventDefault();
      const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1;
      const prev = this.weaponRig.getActiveOpticZoomMult();
      const next = this.weaponRig.cycleOpticZoom(dir);
      if (Math.abs(next - prev) >= 0.01) {
        this.audio.playTacticalSwitchClick(dir > 0);
        this.showToast(`Optic Magnification: ${next.toFixed(1)}x`);
      }
    }
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.clearMovementInputs();
      this.characterAnimator.resetThrowableInputOnFocusLoss();
    }
    this.emitSnapshot(true);
  };

  private onWindowBlur = (): void => {
    this.clearMovementInputs();
    this.characterAnimator.resetThrowableInputOnFocusLoss();
  };

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private bindEvents(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('mousedown', this.onMouseDown);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('webglcontextlost', this.onContextLost);

    this.exitLock();
    this.trauma.dispose();
    this.world.dispose();
    this.textures.dispose();
    this.characterSkeleton.dispose();
    this.scopeRenderer.dispose();
    this.weaponRig.dispose();
    this.zombies.dispose();
    this.ballistics.dispose();
    this.throwables.dispose();
    this.acoustic.dispose();
    this.composer.dispose();
    this.audio.dispose();
    this.renderer.dispose();

    if (canvas.parentElement === this.container) {
      this.container.removeChild(canvas);
    }
    this.listeners.clear();
  }
}

export { getItemGridDims };

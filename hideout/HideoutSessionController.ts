import * as THREE from 'three';
import {
  AdsMode,
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
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  IBodycamWorldAdapter,
  operatorAssetLoader,
  OperatorGearConfig,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  SDK_WEAPON_PROFILES,
  WeaponRig,
} from '../bodycam-sdk';
import {
  computeDerivedWeaponStats,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import { graphicsQualityStore } from '../data/graphicsQuality';
import { loadoutStore } from '../data/loadoutStore';
import { GunWallSwapChoreography } from './GunWallSwapChoreography';
import {
  buildHideoutBunkerWorld,
  HideoutBunkerWorldHandle,
  HideoutInteractableMeta,
  HideoutRoomId,
  resolveHideoutRoom,
} from './HideoutBunkerWorld';
import { hideoutStateStore } from './HideoutStateStore';

export type InteractReticleState = 'hidden' | 'near' | 'ready';

export interface HideoutPromptState {
  key: string;
  label: string;
  secondaryKey?: string;
  secondaryLabel?: string;
  kind: HideoutInteractableMeta['kind'];
}

export interface HideoutSnapshot {
  pointerLocked: boolean;
  pauseOpen: boolean;
  currentRoomId: HideoutRoomId;
  currentRoomLabel: string;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  isSwappingGunWall: boolean;
  interactReticleState: InteractReticleState;
  prompt: HideoutPromptState | null;
  toastMessage: string | null;
  fps: number;
  masterVolume: number;
}

export interface HideoutControllerCallbacks {
  isWeaponUnlocked: (weaponId: string) => boolean;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
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
  private readonly audio: BodycamAudio;
  private readonly weaponRig: WeaponRig;
  private readonly skeleton: CharacterSkeleton;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly postProcess: BodycamPostProcess;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly swapChoreography: GunWallSwapChoreography;
  private readonly unsubOperatorGear: () => void;
  private readonly unsubLoadout: () => void;

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
  private pointerLocked = false;
  private pauseOpen = false;
  private modalActive = false;
  private contextLost = false;
  private disposed = false;

  private shiftHeld = false;
  private currentRoomId: HideoutRoomId = 'arsenal';
  private currentRoomLabel = 'Arsenal Room';
  private activeInteractable: HideoutInteractableMeta | null = null;
  private activePrompt: HideoutPromptState | null = null;
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

  private readonly listeners = new Set<HideoutListener>();

  // Zero-GC scratch buffers
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _occlRayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _lookDir = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _whipVel = new THREE.Vector2();
  private readonly _slotPos = new THREE.Vector3();
  private readonly _slotQuat = new THREE.Quaternion();
  private readonly _startWeaponPos = new THREE.Vector3();
  private readonly _startWeaponQuat = new THREE.Quaternion();
  private readonly _runtimeProfile: BodycamWeaponProfile;
  private readonly _scopePassParams: ScopePassParams;

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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // Handled in BodycamPostProcess
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.05, 140);
    this.scene.add(this.camera);

    // Build 4-room Cold-War bunker shell & Arsenal Room props
    this.world = buildHideoutBunkerWorld(this.scene, this.renderer, this.isSoftwareGl);
    this.adapter = this.world.physics.createAdapter({});

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

    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.localGear = operatorSelectionStore.getGearConfig();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      operatorSelectionStore.getSelectedOperator(),
      {
        maxAnisotropy: maxAniso,
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

    // Spawn player inside the Arsenal Room facing the lit 3D Gun Wall (-Z)
    this.controller.position.set(0, 0, 1.95);
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
      sp.flashlightOn = false;
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

    // Sync Gun Wall strictly with unlocked/owned weapons & equip persisted weapon
    this.syncOwnedWeapons();

    // Live updates when operator gear or Gunsmith attachments change
    this.unsubOperatorGear = operatorSelectionStore.subscribeGear((nextGear) => {
      this.localGear = nextGear;
      this.skeleton.applyUniform(nextGear.uniformId);
      this.skeleton.applyGearConfig(nextGear);
      this.skeleton.setFirstPersonHeadShadowOnly(true);
      this.skeleton.enableArmViewmodelLayer();
    });

    this.unsubLoadout = loadoutStore.subscribe(() => {
      // Refresh currently held weapon attachments & Gun Wall mounted builds live
      if (!this.swapChoreography.isActive()) {
        this.applyEquippedWeaponRig(this.equippedWeaponId, false);
        this.world.syncGunWallSlots(hideoutStateStore.getState().wallRackSlots);
        this.emitSnapshot(true);
      }
    });

    this.bindEvents();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.lastFrameMs = performance.now();
    this.emitSnapshot(true);
    this.scheduleNextFrame();
  }

  public syncOwnedWeapons(): void {
    const nextState = hideoutStateStore.syncWithUnlockedCheck(this.callbacks.isWeaponUnlocked);
    this.world.syncGunWallSlots(nextState.wallRackSlots);
    this.applyEquippedWeaponRig(nextState.equippedWeaponId, false);
    this.emitSnapshot(true);
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
    try {
      this.renderer.domElement.requestPointerLock();
    } catch {
      // Ignore browser gesture rejections
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
    const profile = resolveWeaponProfile(weaponId);
    const attachments: WeaponAttachments =
      weaponId === 'unarmed'
        ? {}
        : normalizeWeaponAttachments(profile.id, loadoutStore.getActiveWeaponBuild(profile.id).attachments);
    this.weaponRig.setWeaponProfile(profile, attachments);
    this.weaponRig.root.visible = !this.swapChoreography.isActive();

    if (weaponId !== 'unarmed' && this.magAmmoByWeapon[profile.id] === undefined) {
      this.magAmmoByWeapon[profile.id] = profile.magCapacity;
    }
    if (playCue) {
      this.audio.playGearRattle('weapon_swap', 0.5);
    }
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
        hideoutStateStore.commitRackSwap(idx);
        const synced = hideoutStateStore.getState();
        this.world.syncGunWallSlots(synced.wallRackSlots);
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

  private handlePrimaryInteract(): void {
    const target = this.activeInteractable;
    if (!target) return;

    switch (target.kind) {
      case 'gun_wall_slot': {
        if (typeof target.slotIndex === 'number') {
          this.triggerGunWallInteraction(target.slotIndex);
        }
        break;
      }
      case 'prep_table_gunsmith': {
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.setModalActive(true);
        this.callbacks.onOpenGunsmith();
        break;
      }
      case 'locker_door': {
        const opened = this.world.toggleLockerDoor();
        this.audio.playWeaponCue(opened ? 'bolt_pull' : 'bolt_lock', { intensity: 0.72 });
        this.showToast('Personal Stash — Coming Soon');
        break;
      }
      case 'ammo_crate': {
        this.world.triggerAmmoCratePop();
        hideoutStateStore.resupplyAllAmmo();
        if (this.equippedWeaponId !== 'unarmed') {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          this.magAmmoByWeapon[prof.id] = prof.magCapacity;
        }
        this.audio.playWeaponCue('mag_in', { intensity: 0.85 });
        this.showToast('Ammunition Resupplied');
        this.emitSnapshot(true);
        break;
      }
    }
  }

  private handleSecondaryInteract(): void {
    if (this.activeInteractable?.kind === 'locker_door') {
      this.audio.playGearRattle('weapon_swap', 0.45);
      this.setModalActive(true);
      this.callbacks.onOpenOperatorGear();
    }
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
      this.activeInteractable = null;
      this.activePrompt = null;
      this.interactReticleState = 'hidden';
      return;
    }

    const NEAR_AWARENESS_EXTRA_M = 2.2;
    this.camera.getWorldPosition(this._camPos);
    this.camera.getWorldDirection(this._lookDir).normalize();
    this._raycaster.set(this._camPos, this._lookDir);
    this._raycaster.near = 0.08;
    this._raycaster.far = 5.4;

    const hits = this._raycaster.intersectObjects(this.world.interactableMeshes, false);
    let matched: HideoutInteractableMeta | null = null;
    let nearDetected = false;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible) continue;
      const meta = h.object.userData.hideoutInteractable as HideoutInteractableMeta | undefined;
      if (!meta || !this.isInteractableActionable(meta)) continue;

      const maxNearDist = meta.maxDistanceM + NEAR_AWARENESS_EXTRA_M;
      if (h.distance > maxNearDist) continue;

      // Prevent showing interact dot through solid bunker walls
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
        matched = meta;
      } else {
        nearDetected = true;
      }
      break;
    }

    this.activeInteractable = matched;
    if (!matched) {
      this.activePrompt = null;
      this.interactReticleState = nearDetected ? 'near' : 'hidden';
      return;
    }

    this.interactReticleState = 'ready';

    if (matched.kind === 'gun_wall_slot' && typeof matched.slotIndex === 'number') {
      const slot = this.world.gunWallSlots[matched.slotIndex];
      const slotWeaponId = slot?.weaponId ?? null;
      if (slotWeaponId) {
        const targetProf = resolveWeaponProfile(slotWeaponId);
        const verb = this.equippedWeaponId === 'unarmed' ? 'Equip' : 'Swap with';
        this.activePrompt = {
          key: 'E',
          label: `${verb} ${targetProf.name}`,
          kind: matched.kind,
        };
      } else if (this.equippedWeaponId !== 'unarmed') {
        const heldProf = resolveWeaponProfile(this.equippedWeaponId);
        this.activePrompt = {
          key: 'E',
          label: `Hang ${heldProf.name} on Rack`,
          kind: matched.kind,
        };
      } else {
        this.activeInteractable = null;
        this.activePrompt = null;
        this.interactReticleState = 'hidden';
      }
      return;
    }

    if (matched.kind === 'prep_table_gunsmith') {
      this.activePrompt = {
        key: 'E',
        label: 'Gunsmith Workbench',
        kind: matched.kind,
      };
      return;
    }

    if (matched.kind === 'locker_door') {
      this.activePrompt = {
        key: 'E',
        label: this.world.lockerOpen ? 'Close Locker' : 'Open Locker',
        secondaryKey: 'F',
        secondaryLabel: 'Operator Gear',
        kind: matched.kind,
      };
      return;
    }

    if (matched.kind === 'ammo_crate') {
      this.activePrompt = {
        key: 'E',
        label: 'Resupply Ammunition',
        kind: matched.kind,
      };
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
    this.shiftHeld = false;
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
    this.controller.handleMouseMove(e.movementX, e.movementY, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.modalActive || this.pauseOpen) return;
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    this.audio.ensureInitialized();
    this.audio.setInteriorAcoustics(true, 'concrete');
    if (e.button === 2 && !this.swapChoreography.isActive()) {
      this.animator.interruptInspect();
      this.input.ads = true;
    } else if (e.button === 0 && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
      // Safe-zone handling in Phase 1 (live fire unlocks in Phase 2 inside Gun Range!)
      const room = resolveHideoutRoom(this.controller.position.x, this.controller.position.z);
      if (room.id === 'gun_range') {
        this.showToast('Gun Range Live Fire Activates in Phase 2');
      } else {
        this.audio.playWeaponCue('dryfire', { intensity: 0.35 });
      }
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) {
      this.input.ads = false;
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
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
        if (!e.repeat && this.activeInteractable) {
          this.handlePrimaryInteract();
        } else if (!this.activeInteractable) {
          this.input.leanRight = true;
        }
        break;
      case 'KeyF':
        if (!e.repeat && this.activeInteractable?.kind === 'locker_door') {
          this.handleSecondaryInteract();
        }
        break;
      case 'KeyI':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
          this.weaponRig.weaponAnimator.triggerInspect();
        }
        break;
      case 'KeyR':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const curMag = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
          if (curMag < prof.magCapacity) {
            const needed = prof.magCapacity - curMag;
            const taken = hideoutStateStore.consumeReserve(prof.id, needed);
            if (taken > 0) {
              this.magAmmoByWeapon[prof.id] = curMag + taken;
              this.animator.triggerReload(prof.reloadDurationSec);
              this.emitSnapshot(true);
            }
          }
        }
        break;
      case 'KeyL':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          this.weaponRig.laserOn = !this.weaponRig.laserOn;
          this.audio.playWeaponCue('mode_toggle', { intensity: 0.45 });
        }
        break;
      case 'KeyT':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed') {
          const on = this.weaponRig.flashlight.intensity <= 0.1;
          this.weaponRig.flashlight.intensity = on ? 6.5 : 0;
          this.audio.playWeaponCue('mode_toggle', { intensity: 0.45 });
        }
        break;
      case 'Digit0':
        if (!e.repeat && !this.swapChoreography.isActive() && this.equippedWeaponId !== 'unarmed') {
          hideoutStateStore.setEquippedWeaponDirect('unarmed');
          this.world.syncGunWallSlots(hideoutStateStore.getState().wallRackSlots);
          this.applyEquippedWeaponRig('unarmed', true);
          this.emitSnapshot(true);
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

  private bindEvents(): void {
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
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

    if (!this.contextLost) {
      const swapping = this.swapChoreography.isActive();
      this.input.sprint = this.shiftHeld && this.input.forward && !this.input.ads && !swapping;
      this.input.adsMode = 'PRIMARY' as AdsMode;

      const profile = this.getWeaponProfile(this.equippedWeaponId);

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

      // Update interactive Arsenal props (locker hinge damping, ammo crate pop)
      this.world.updateProps(dt);

      // Update Gun Wall two-handed swap choreography BEFORE CharacterAnimator solves arm IK
      if (swapping) {
        this.swapChoreography.update(dt, this.camera);
        this.animator.setExternalHandOverride(
          this.swapChoreography.isActive() ? this.swapChoreography.ikOverride : null,
        );
      }

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

      // Update spatial audio listener & indoor concrete bunker acoustic state
      this.camera.getWorldPosition(this._camPos);
      this.camera.getWorldDirection(this._lookDir).normalize();
      this._camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
      this.audio.updateListener(this._camPos, this._lookDir, this._camUp);

      // Track current bunker wing & crosshair interactable prompt
      const room = resolveHideoutRoom(this.controller.position.x, this.controller.position.z);
      const roomChanged = room.id !== this.currentRoomId;
      if (roomChanged) {
        this.currentRoomId = room.id;
        this.currentRoomLabel = room.label;
      }

      const prevPromptLabel = this.activePrompt?.label ?? '';
      const prevReticleState = this.interactReticleState;
      this.updateInteractableScan();
      const promptChanged =
        (this.activePrompt?.label ?? '') !== prevPromptLabel ||
        this.interactReticleState !== prevReticleState;

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

      if (roomChanged || promptChanged || now - this.lastEmitMs >= 160) {
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
    return {
      pointerLocked: this.pointerLocked,
      pauseOpen: this.pauseOpen,
      currentRoomId: this.currentRoomId,
      currentRoomLabel: this.currentRoomLabel,
      equippedWeaponId: this.equippedWeaponId,
      equippedWeaponName: this.equippedWeaponId === 'unarmed' ? 'Unarmed' : prof.name,
      equippedCaliber: this.equippedWeaponId === 'unarmed' ? '' : prof.caliberLabel,
      ammoInMag,
      magCapacity: this.equippedWeaponId === 'unarmed' ? 0 : prof.magCapacity,
      ammoReserve: hideoutStateStore.getReserveForWeapon(this.equippedWeaponId),
      isSwappingGunWall: this.swapChoreography.isActive(),
      interactReticleState: this.interactReticleState,
      prompt: this.activePrompt ? { ...this.activePrompt } : null,
      toastMessage: this.toastMessage,
      fps: this.currentFps,
      masterVolume: this.config.masterVolume,
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

    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);

    this.unsubOperatorGear();
    this.unsubLoadout();
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

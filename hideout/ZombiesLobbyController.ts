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
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
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
} from '../bodycam-sdk';
import {
  computeDerivedWeaponStats,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import { getDefaultAmmoVariant, resolveBaseCaliberId } from '../data/calibers';
import { AdaptivePerformanceController, graphicsQualityStore } from '../data/graphicsQuality';
import { loadoutStore } from '../data/loadoutStore';
import { PlayerInteractAnimator } from '../doors/PlayerInteractAnimator';
import { GunWallSwapChoreography } from './GunWallSwapChoreography';
import type { HideoutPromptOption, HideoutPromptState, InteractReticleState } from './HideoutSessionController';
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
  toastMessage: string | null;
  fps: number;
  masterVolume: number;
}

export interface ZombiesLobbyControllerCallbacks {
  isWeaponUnlocked: (weaponId: string) => boolean;
  onOpenZombiesOps: () => void;
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
  private readonly interactAnimator = new PlayerInteractAnimator();
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
    vault: false,
  };

  private shiftHeld = false;
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
  private readonly magAmmoByWeapon: Record<string, number> = {};

  private activeMeta: ZombiesOutpostInteractMeta | null = null;
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
    this.adapter = this.world.physics.createAdapter();

    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.audio.setInteriorAcoustics(false, 'concrete');

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

    if (weaponId !== 'unarmed' && this.magAmmoByWeapon[profile.id] === undefined) {
      this.magAmmoByWeapon[profile.id] = profile.magCapacity;
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
    const isSingle = prof.fireMode === 'semi' || prof.fireMode === 'bolt' || prof.fireMode === 'pump';
    if (isSingle && this.semiTriggerConsumed) return;

    if (currentAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.showToast('Empty Magazine — Press R to Reload');
      return;
    }

    const remaining = currentAmmo - 1;
    this.magAmmoByWeapon[prof.id] = remaining;
    this.fireCooldown = 60 / Math.max(25, prof.rpm);
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
    this.weaponRig.triggerFire(derived.isSuppressed, remaining);
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
    const matType =
      ev.surface === 'metal' ? 'metal' : ev.surface === 'wood' ? 'wood' : 'concrete';
    this.audio.playImpact(ev.point, matType);
  }

  private executeSelectedInteract(): void {
    const meta = this.activeMeta;
    const prompt = this.activePrompt;
    if (!meta || !prompt || prompt.options.length === 0) return;

    const safeIdx = THREE.MathUtils.clamp(this.selectedOptionIndex, 0, prompt.options.length - 1);
    const chosen = prompt.options[safeIdx];
    if (!chosen) return;

    switch (meta.kind) {
      case 'gun_wall_slot': {
        if (typeof meta.slotIndex === 'number') {
          this.triggerFieldRackInteraction(meta.slotIndex);
        }
        break;
      }
      case 'outpost_ops_board':
      case 'outpost_field_radio': {
        if (this.world.getPropInteractPos(meta.kind, this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.audio.playWeaponCue('mode_toggle', { intensity: 0.5 });
        this.setModalActive(true);
        this.callbacks.onOpenZombiesOps();
        break;
      }
      case 'outpost_ammo_crate': {
        if (this.world.getPropInteractPos('outpost_ammo_crate', this._ikTargetPos)) {
          this.interactAnimator.trigger('PROP_INTERACT', this._ikTargetPos);
        }
        this.world.triggerAmmoCratePop();
        hideoutShardAdapter.resupplyAllAmmo();
        if (this.equippedWeaponId !== 'unarmed') {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          this.magAmmoByWeapon[prof.id] = prof.magCapacity;
          this.weaponRig.setAmmoState(prof.magCapacity, true);
        }
        this.audio.playWeaponCue('mag_in', { intensity: 0.85 });
        this.showToast('Outpost Ordnance & Ammunition Resupplied');
        this.emitSnapshot(true);
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
      this.returnTransitionActive
    ) {
      this.activeMeta = null;
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
    let nearDetected = false;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible) continue;
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

    this.activeMeta = matched;
    if (!matched) {
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
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Zombies Operations Map Board',
        options: [{ id: 'open_ops', label: 'Select Map, Difficulty & Deploy' }],
        selectedIndex: 0,
      };
      return;
    }

    if (matched.kind === 'outpost_field_radio') {
      this.activePrompt = {
        key: 'F',
        targetLabel: 'Tactical Field Radio',
        options: [{ id: 'open_ops', label: 'Quarantine Briefing & Squad Dispatch' }],
        selectedIndex: 0,
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
        targetLabel: 'Armored Transport · Return Airlock',
        options: [{ id: 'return_hideout', label: 'Board Transport → Return to Hideout' }],
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
  }

  private readonly onPointerLockChange = (): void => {
    const locked = document.pointerLockElement === this.renderer.domElement;
    this.pointerLocked = locked;
    if (!locked) {
      this.clearMovementInputs();
      if (!this.modalActive && !this.disposed && !this.returnTransitionActive) {
        this.pauseOpen = true;
      }
    } else {
      this.pauseOpen = false;
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
    if (this.modalActive || this.pauseOpen || this.returnTransitionActive) return;
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    this.audio.ensureInitialized();
    if (e.button === 2 && !this.swapChoreography.isActive()) {
      this.animator.interruptInspect();
      this.input.ads = true;
    } else if (e.button === 0 && !this.swapChoreography.isActive()) {
      if (this.equippedWeaponId === 'unarmed') {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
      } else {
        this.isFiring = true;
        this.tryFireShot();
      }
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
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
    if (this.modalActive || this.returnTransitionActive) return;
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
        this.input.leanRight = true;
        break;
      case 'KeyF':
        if (!e.repeat && this.activeMeta) {
          this.executeSelectedInteract();
        }
        break;
      case 'KeyI':
        if (!e.repeat && this.equippedWeaponId !== 'unarmed' && !this.swapChoreography.isActive()) {
          this.weaponRig.weaponAnimator.triggerInspect();
        }
        break;
      case 'KeyR':
        if (
          !e.repeat &&
          this.equippedWeaponId !== 'unarmed' &&
          !this.swapChoreography.isActive() &&
          this.reloadTimer <= 0
        ) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const curMag = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
          const reserve = hideoutShardAdapter.getReserveForWeapon(prof.id);
          if (curMag < prof.magCapacity && reserve > 0) {
            this.reloadTimer = prof.reloadDurationSec;
            this.pendingReloadWeaponId = prof.id;
            this.animator.triggerReload(prof.reloadDurationSec);
            this.emitSnapshot(true);
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
      this.input.sprint = this.shiftHeld && this.input.forward && !firearmAdsBlocking && !swapping;
      this.input.holdBreath = this.shiftHeld && this.input.ads && this.equippedWeaponId !== 'unarmed' && !swapping;

      if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
      if (this.reloadTimer > 0) {
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        if (this.reloadTimer <= 0 && this.pendingReloadWeaponId) {
          const reloadId = this.pendingReloadWeaponId;
          this.pendingReloadWeaponId = null;
          if (reloadId === this.equippedWeaponId) {
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
      this.world.update(dt);

      if (swapping) {
        this.interactAnimator.cancel();
        this.swapChoreography.update(dt, this.camera);
        this.animator.setExternalHandOverride(
          this.swapChoreography.isActive() ? this.swapChoreography.ikOverride : null,
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

      if (nextSig !== prevSig || this.interactReticleState !== prevReticle || now - this.lastEmitMs >= 180) {
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
      locationLabel: 'Fortified Quarantine Outpost · Zombies Lobby',
      equippedWeaponId: this.equippedWeaponId,
      equippedWeaponName: this.equippedWeaponId === 'unarmed' ? 'Unarmed' : prof.name,
      equippedCaliber: this.equippedWeaponId === 'unarmed' ? '' : prof.caliberLabel,
      ammoInMag,
      magCapacity: this.equippedWeaponId === 'unarmed' ? 0 : prof.magCapacity,
      ammoReserve: hideoutShardAdapter.getReserveForWeapon(this.equippedWeaponId),
      isSwappingRack: this.swapChoreography.isActive(),
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

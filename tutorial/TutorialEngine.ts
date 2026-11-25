import * as THREE from 'three';
import {
  AdsMode,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamMeleeHitEvent,
  BodycamPostProcess,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  computeTargetHingeAngularImpulse,
  createPdaMotionState,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
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
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../data/calibers';
import {
  formatFireModeLabel,
  getEffectiveFireMode,
  SelectableFireMode,
  toggleWeaponFireMode,
} from '../data/fireModeControl';
import { graphicsQualityStore } from '../data/graphicsQuality';
import { keybindStore } from '../data/keybindStore';
import { getTacticalEquipmentDef, TacticalEquipmentId } from '../data/tacticalEquipment';
import { GymBallistics } from '../gym/GymBallistics';
import {
  TUTORIAL_STEPS,
  TutorialCourseSnapshot,
  TutorialCourseStateMachine,
} from './TutorialCourseLogic';
import { buildTutorialWorld, TutorialWorldHandle } from './TutorialWorld';

export interface TutorialSnapshot {
  course: TutorialCourseSnapshot;
  pointerLocked: boolean;
  pauseOpen: boolean;
  equippedWeaponId: string;
  equippedWeaponName: string;
  fireModeLabel: string;
  ammoInMag: number;
  magCapacity: number;
  isReloading: boolean;
  armedAdsMode: AdsMode;
  laserOn: boolean;
  flashlightOn: boolean;
  suppressorAttached: boolean;
  nvgActive: boolean;
  grenadeCount: number;
  grenadeStage: GrenadeHoldStage;
  isPdaOpen: boolean;
  doorPrompt: string | null;
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
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private readonly course: TutorialCourseStateMachine;

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
    vault: false,
  };

  private readonly attachmentsByWeapon: Record<string, WeaponAttachments> = {};
  private readonly magAmmoByWeapon: Record<string, number> = {};
  private readonly adsModeByWeapon: Record<string, AdsMode> = {};
  private readonly fireModeOverrideByWeapon: Record<string, SelectableFireMode> = {};
  private equippedWeaponId = 'm4_556';
  private readonly tacticalEquipmentId: TacticalEquipmentId = 'm67_frag';

  private pointerLocked = false;
  private pauseOpen = false;
  private hasEnteredOnce = false;
  private isFiring = false;
  private semiTriggerConsumed = false;
  private sprintHeld = false;
  private holdBreathHeld = false;
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
      onDetonate: () => {
        // Safe training detonation — no self-damage, restock if empty
        if (this.grenadeCount <= 1) this.grenadeCount = 6;
        this.emitSnapshot();
      },
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);

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
    this.emitSnapshot();
  }

  public skipCurrentStep(): void {
    const next = this.course.skipStep();
    if (!this.course.isCourseComplete()) {
      this.teleportTo(next.spawnPos[0], next.spawnPos[1], next.spawnPos[2], next.spawnYaw);
      if (next.index > 4 && !this.world.door.isOpen) {
        this.world.toggleDoor(true);
      }
    }
    this.syncWaypoint();
    this.showToast(`Jumped to ${next.bayLabel}: ${next.title}`);
    this.emitSnapshot();
  }

  public jumpToStep(index: number): void {
    const step = this.course.jumpToStep(index);
    this.teleportTo(step.spawnPos[0], step.spawnPos[1], step.spawnPos[2], step.spawnYaw);
    if (step.index > 4 && !this.world.door.isOpen) {
      this.world.toggleDoor(true);
    } else if (step.index <= 4) {
      this.world.resetDoor();
    }
    this.syncWaypoint();
    this.showToast(`${step.bayLabel}: ${step.title}`);
    this.emitSnapshot();
  }

  public restartCourse(): void {
    const first = this.course.restart();
    this.world.resetDoor();
    this.grenadeCount = 6;
    if (this.nvgFlipped) this.toggleNvg(false);
    if (this.pdaDevice.isOpen()) this.pdaDevice.setOpen(false);
    this.switchWeapon('m4_556', true);
    this.teleportTo(first.spawnPos[0], first.spawnPos[1], first.spawnPos[2], first.spawnYaw);
    this.syncWaypoint();
    this.showToast('Field Training Restarted');
    this.emitSnapshot();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    this.unbindEvents();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.ballistics.dispose();
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
    const prof = resolveWeaponProfile(weaponId);
    const changed = weaponId !== this.equippedWeaponId;
    this.equippedWeaponId = prof.id;
    this.reloadTimer = 0;
    this.fireCooldown = 0.14;
    this.isFiring = false;
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
    if (prof.magCapacity <= 0 || this.reloadTimer > 0) return;
    // Allow tactical reload even on full mag during Bay 04 so the player never gets stuck!
    const reloadSec = Math.max(0.8, (prof.reloadDurationSec ?? 1.8) * 0.85);
    this.weaponRig.triggerReload(reloadSec);
    this.animator.triggerReload(reloadSec);
    this.reloadTimer = reloadSec;
    this.course.recordEvent('reload');
    this.showToast('Reloading...');
    this.emitSnapshot();
  }

  private handleMeleeHit(ev: BodycamMeleeHitEvent): void {
    this.course.recordEvent('melee');
    // Check if near Bay 05 training door — breach it open on kick/bash!
    const distToDoor = Math.hypot(
      this.controller.position.x - 0,
      this.controller.position.z - this.world.door.hingeZ,
    );
    if (distToDoor < 2.6 && !this.world.door.isOpen) {
      this.world.toggleDoor(true);
      this.audio.playImpact(ev.point, 'wood');
      this.course.recordEvent('door_interact');
      this.showToast('Door Breached!');
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
    if (this.pdaDevice.isBlockingWeaponActions() || this.grenadeSystem.isDrawn()) return;
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

    const effectiveFireMode = getEffectiveFireMode(prof, this.fireModeOverrideByWeapon);
    this.magAmmoByWeapon[prof.id] = current - 1;
    this.fireCooldown = 60 / Math.max(40, prof.rpm);
    if (
      effectiveFireMode === 'semi' ||
      effectiveFireMode === 'bolt' ||
      effectiveFireMode === 'pump'
    ) {
      this.semiTriggerConsumed = true;
    }

    const derived = this.weaponRig.getDerivedStats();
    const ammo = this.getActiveAmmoVariant(prof.id);
    const suppressed = derived.isSuppressed;

    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    this.ballistics.fireRound(this._muzzlePos, this._muzzleDir, prof, ammo, derived.velocityMult);
    this.weaponRig.triggerFire(suppressed, current - 1);
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
    const res = toggleWeaponFireMode(prof, this.fireModeOverrideByWeapon);
    if (!res.toggled) {
      this.showToast(`${prof.name}: ${res.label} only`);
      this.emitSnapshot();
      return;
    }
    this.audio.playTacticalSwitchClick(res.nextMode === 'auto' || res.nextMode === 'semi');
    this.showToast(`Fire Mode: ${res.label}`);
    this.emitSnapshot();
  }

  private triggerPdaOrPingAction(source: 'strike' | 'ping'): void {
    const pit = this.world.fireSupportPitCenter;
    if (source === 'strike') {
      this.world.triggerTrainingStrikeBlast(pit.x, pit.z);
      this.audio.playMortarExplosion(pit);
      this.showToast('Training Fire Support Impact Confirmed!');
    } else {
      this.audio.playTacticalSwitchClick(true);
      this.showToast('Tactical Ping Placed on Target Zone');
    }
    this.course.recordEvent('pda_action');
    this.emitSnapshot();
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
    } else {
      this.clearHeldInputs();
      if (this.hasEnteredOnce && !this.course.isCourseComplete()) {
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
    if (!this.pointerLocked) return;
    this.audio.ensureInitialized();

    const isFireBtn = keybindStore.matchesMouseButton(e.button, 'fire');
    const isAdsBtn = keybindStore.matchesMouseButton(e.button, 'ads');
    const isPointAimBtn = keybindStore.matchesMouseButton(e.button, 'point_aim');

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

    // Support side mouse buttons rebound to gameplay actions
    const mouseCode = `Mouse${e.button}`;
    this.handleActionInputDown(mouseCode, false, e);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
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
    if (keybindStore.matchesKeyCode(code, 'point_aim') && !repeat) {
      this.togglePointAim();
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
    if (keybindStore.matchesKeyCode(code, 'interact') && !repeat) {
      const distToDoor = Math.hypot(
        this.controller.position.x - 0,
        this.controller.position.z - this.world.door.hingeZ,
      );
      if (distToDoor < 2.8) {
        const opened = this.world.toggleDoor(false);
        this.audio.playImpact(this._doorCenter.set(0, 1.1, this.world.door.hingeZ), 'wood');
        this.course.recordEvent('door_interact');
        this.showToast(opened ? 'Door Opened' : 'Door Closed');
        this.emitSnapshot();
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
      if (!repeat && this.pdaDevice.isOpen()) {
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
    if (keybindStore.matchesKeyCode(code, 'lean_left')) this.input.leanLeft = false;
    if (keybindStore.matchesKeyCode(code, 'lean_right')) this.input.leanRight = false;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.pointerLocked || keybindStore.isCapturing()) return;
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
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.ads = false;
    this.input.holdBreath = false;
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
      !this.grenadeSystem.isDrawn();

    this.input.sprint = this.sprintHeld && canSprint && this.stamina > 0.08;
    this.input.holdBreath = this.holdBreathHeld && this.input.ads && !this.input.sprint;

    if (this.input.sprint) {
      this.stamina = Math.max(0, this.stamina - 0.16 * dt);
    } else {
      this.stamina = Math.min(1, this.stamina + 0.28 * dt);
    }

    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer <= 0) {
        const derived = this.weaponRig.getDerivedStats();
        this.magAmmoByWeapon[prof.id] = derived.magCapacity;
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

    // Proximity prompt for Bay 05 wooden training door
    const distToDoor = Math.hypot(pos.x, pos.z - this.world.door.hingeZ);
    const interactLbl = keybindStore.getLabel('interact');
    const kickLbl = keybindStore.getLabel('push_kick');
    this.doorPrompt =
      distToDoor < 2.6
        ? this.world.door.isOpen
          ? `[${interactLbl}] Close Training Door`
          : `[${interactLbl}] Open Door · [${kickLbl}] Push-Kick Breach`
        : null;

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

    // Step Ballistics & detect Bay 03 Steel Target hits
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
    );

    // Step Grenade System
    this.grenadeSystem.update(dt, this.camera.position);
    const launched = this.grenadeSystem.consumeLastLaunchedThrow();
    if (launched) {
      this.grenadeCount = Math.max(1, this.grenadeCount - 1);
      this.course.recordEvent('grenade_throw');
      this.emitSnapshot();
    }

    // Step Tutorial World & Course Auto-Advance
    this.world.update(dt, this.elapsedSec);
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
    const effectiveMode = getEffectiveFireMode(prof, this.fireModeOverrideByWeapon);
    return {
      course: this.course.getSnapshot(),
      pointerLocked: this.pointerLocked,
      pauseOpen: this.pauseOpen,
      equippedWeaponId: prof.id,
      equippedWeaponName: prof.name,
      fireModeLabel: formatFireModeLabel(effectiveMode),
      ammoInMag: this.magAmmoByWeapon[prof.id] ?? 0,
      magCapacity: derived.magCapacity,
      isReloading: this.reloadTimer > 0,
      armedAdsMode: this.adsModeByWeapon[prof.id] ?? 'PRIMARY',
      laserOn: this.weaponRig.laserOn && derived.hasLaser,
      flashlightOn: this.flashlightOn && derived.hasFlashlight,
      suppressorAttached: derived.isSuppressed,
      nvgActive: this.nvgFlipped,
      grenadeCount: this.grenadeCount,
      grenadeStage: this.grenadeSystem.getHoldStage(),
      isPdaOpen: this.pdaDevice.isOpen(),
      doorPrompt: this.doorPrompt,
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

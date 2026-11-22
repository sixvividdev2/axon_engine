import * as THREE from 'three';
import {
  AdsMode,
  ArticulatedRagdoll,
  BallisticImpactEvent,
  BallisticsSolver,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamLensPresetId,
  BodycamMeleeHitEvent,
  BodycamPostProcess,
  BodycamRaycastResult,
  BodycamSDKConfig,
  BodycamTelemetry,
  BodycamTraumaModifiers,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  createBodycamTelemetry,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  GrenadeDetonationEvent,
  GrenadeHoldStage,
  GYM_ARMORY_WEAPONS,
  IBodycamWorldAdapter,
  LENS_PRESETS,
  operatorAssetLoader,
  OperatorId,
  operatorSelectionStore,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  solveZeroPitchRad,
  tacticalEquipmentStore,
  TacticalGrenadeSystem,
  WeaponRig,
} from '../bodycam-sdk';
import {
  computeDerivedWeaponStats,
  createBareAttachments,
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../data/calibers';
import {
  getTacticalEquipmentDef,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { SaveManager } from '../engine/persistence/SaveManager';
import { getMapDefinitionById } from '../maps/MapRegistry';
import {
  BattleMatchConfig,
  BuiltMapInstance,
  InfectionMatchConfig,
  InfectionPerkId,
  MapInteractable,
} from '../maps/types';
import {
  GameBotDamagePacket,
  GameBotFirePacket,
  GameBotHitPlayerPacket,
  GameBotsSyncPacket,
  GameMapInteractPacket,
  GameMapInteractRejectedPacket,
  GameMapInteractRequestPacket,
  GameMatchSyncPacket,
  GamePlayerFirePacket,
  GamePlayerHitPacket,
  GamePlayerKillPacket,
  GamePlayerRespawnPacket,
  GamePlayerStatePacket,
  GameRoundCompletePacket,
  GameZombieDamagePacket,
  GameZombieHitPlayerPacket,
  GameZombieKilledPacket,
  GameZombieSpawnPacket,
  GameZombiesSyncPacket,
  LobbyMember,
  OperatorUniformId,
  resolveOperatorUniformId,
  SpecialEventConfig,
  SyncedAimStance,
} from '../data/multiplayer';
import {
  BattleBotAI,
  BattleHumanTarget,
  BattleKillfeedEntry,
  BattleScoreEntry,
  BattleTeamId,
} from './BattleBotAI';
import { InfectionHumanTarget, InfectionZombieAI, ZombieRoundState } from './InfectionZombieAI';
import { RemotePlayerManager } from './RemotePlayerManager';

export type CombatSessionMode = 'battle' | 'infection';

export interface MultiplayerSessionBridge {
  lobbyCode: string;
  localUserId: string;
  localUsername: string;
  localTeam: 'A' | 'B';
  isHost: boolean;
  members: LobbyMember[];
  specialEventConfig: SpecialEventConfig | null;
  sendMessage: (payload: Record<string, unknown>) => void;
  subscribeMessages: (listener: (msg: Record<string, unknown>) => void) => () => void;
}

export interface PointsPopup {
  id: number;
  amount: number;
  label: string;
  timestampMs: number;
}

export interface NearbyInteractPrompt {
  id: string;
  kind: MapInteractable['kind'];
  label: string;
  actionText: string;
  cost: number;
  canAfford: boolean;
  blockedReason: string | null;
}

export interface CombatSessionSnapshot {
  mode: CombatSessionMode;
  mapId: string;
  mapName: string;
  config: BodycamSDKConfig;
  telemetry: BodycamTelemetry;
  pointerLocked: boolean;
  tunerOpen: boolean;
  scoreboardOpen: boolean;

  // Player health & vitals
  hp: number;
  maxHp: number;
  playerAlive: boolean;
  isRegenerating: boolean;
  damageFlash: number;
  heartRateBpm: number;
  heartStress: number;
  holdBreathActive: boolean;

  // Hitmarker
  hitmarkerActive: boolean;
  hitmarkerHeadshot: boolean;
  hitmarkerKill: boolean;

  // Active Weapon
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  activeSlotIndex: number; // 0, 1, or -1 (unarmed)
  weaponSlots: Array<{ id: string; name: string }>;
  ammoInMag: number;
  magCapacity: number;
  reserveAmmo: number; // -1 means infinite (Battle)
  isReloading: boolean;
  armedAdsMode: AdsMode;
  hasCantedOptic: boolean;
  isMagnifiedOptic: boolean;
  hasVariableZoom: boolean;
  activeOpticZoom: number;
  reticleIlluminated: boolean;
  laserOn: boolean;
  flashlightOn: boolean;

  // Battle-specific state
  battleRule: 'tdm' | 'ffa';
  killLimit: number;
  scoreA: number;
  scoreB: number;
  playerKills: number;
  playerDeaths: number;
  playerHeadshots: number;
  weaponKills: Record<string, number>;
  ffaLeaderName: string;
  ffaLeaderKills: number;
  respawnTimerSec: number;
  matchOutcome: 'active' | 'victory' | 'defeat';
  killfeed: BattleKillfeedEntry[];
  scoreboard: BattleScoreEntry[];

  // Infection-specific state
  roundState: ZombieRoundState;
  points: number;
  pointsPopups: PointsPopup[];
  powerOn: boolean;
  perks: InfectionPerkId[];
  nearbyPrompt: NearbyInteractPrompt | null;
  gameOver: boolean;

  // Tactical Equipment & Grenades
  tacticalEquipmentId: TacticalEquipmentId;
  tacticalEquipmentName: string;
  tacticalEquipmentShortName: string;
  tacticalBeltSlot: TacticalBeltSlot;
  tacticalMountOnBelt: boolean;
  grenadeCount: number;
  grenadeMax: number;
  grenadeHoldStage: GrenadeHoldStage;
  grenadeCooking: boolean;
  grenadeCookRatio: number;
  flashBlindAlpha: number;
  zeroDistanceM: number;
  zeroElevationMrad: number;

  // General
  toastMessage: string | null;
  recordingElapsedSec: number;
  fps: number;
  isMultiplayer: boolean;
  spectating: boolean;
  spectatingTargetName: string | null;
  livesRemaining: number;
}

type SnapshotListener = (snap: CombatSessionSnapshot) => void;

export type CombatSessionParams =
  | { mode: 'battle'; battleConfig: BattleMatchConfig; multiplayer?: MultiplayerSessionBridge }
  | {
      mode: 'infection';
      infectionConfig: InfectionMatchConfig;
      multiplayer?: MultiplayerSessionBridge;
    };

/**
 * Unified Bodycam SDK Combat Runtime powering both BATTLE (TDM/FFA) and INFECTION (Zombies).
 * Consumes IMapDefinition maps, saved Gunsmith weapon attachments, BallisticsSolver,
 * and strictly separated BattleBotAI vs InfectionZombieAI systems.
 */
export class CombatSessionEngine {
  private readonly container: HTMLElement;
  private readonly params: CombatSessionParams;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly map: BuiltMapInstance;
  private readonly adapter: IBodycamWorldAdapter;
  private readonly audio: BodycamAudio;
  private readonly weaponRig: WeaponRig;
  private readonly skeleton: CharacterSkeleton;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly postProcess: BodycamPostProcess;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly ballistics: BallisticsSolver;
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private unsubTacticalEquipment: (() => void) | null = null;
  private tacticalEquipmentId: TacticalEquipmentId;
  private tacticalBeltSlot: TacticalBeltSlot;
  private tacticalMountOnBelt: boolean;
  private grenadeCount: number;
  private flashBlindAlpha = 0;

  private readonly botAI: BattleBotAI | null = null;
  private readonly zombieAI: InfectionZombieAI | null = null;
  private readonly mp: MultiplayerSessionBridge | null = null;
  private readonly remotePlayers: RemotePlayerManager | null = null;
  private unsubMpMessages: (() => void) | null = null;
  private localBattleTeam: BattleTeamId = 'A';
  private isMpHost = false;
  private netSendAccum = 0;
  private aiSyncAccum = 0;
  private localUniformId: OperatorUniformId = 'infection';
  private readonly localOperatorId: OperatorId;
  private localFireSeq = 0;
  private lastSentStance: SyncedAimStance = 'HIP';
  private lastSentFiring = false;
  private lastSentReloading = false;
  private lastImmediateStateFlushMs = 0;
  private nextMapInteractReqSeq = 1;
  private readonly pendingMapInteractRequests = new Map<
    string,
    { requestId: string; interactableId: string; cost: number; createdAtMs: number }
  >();
  private mpScoreA = 0;
  private mpScoreB = 0;
  private readonly mpKillfeed: BattleKillfeedEntry[] = [];
  private nextMpKillfeedId = 10000;
  private readonly combinedHitMeshes: THREE.Object3D[] = [];
  private spectating = false;
  private spectateTargetIdx = 0;
  private spectatingTargetName: string | null = null;
  private livesRemaining = 1;
  private readonly playerRespawnEnabled: boolean = true;
  private readonly playerMoveSpeedMult: number = 1.0;
  private readonly _tmpImpactPoint = new THREE.Vector3();
  private readonly _tmpImpactDir = new THREE.Vector3();

  private config: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly _runtimeConfig: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
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
  private readonly attachmentsByWeapon: Record<string, WeaponAttachments> = {};
  private readonly magAmmoByWeapon: Record<string, number> = {};
  private readonly reserveAmmoByWeapon: Record<string, number> = {};
  private readonly adsModeByWeapon: Record<string, AdsMode> = {};

  private weaponSlots: string[] = [];
  private activeSlotIndex = 0;
  private equippedWeaponId = 'm4a1';
  private flashlightOn = false;

  // Player health & combat state
  private hp = 100;
  private maxHp = 100;
  private playerAlive = true;
  private timeSinceDamageSec = 10;
  private damageFlash = 0;
  private respawnTimerSec = 0;
  private playerKills = 0;
  private playerDeaths = 0;
  private playerHeadshots = 0;
  private weaponKills: Record<string, number> = {};
  private matchOutcome: 'active' | 'victory' | 'defeat' = 'active';
  private gameOver = false;
  private infectionRecordSaved = false;

  // Infection economy & stations
  private points = 500;
  private powerOn = false;
  private readonly perks = new Set<InfectionPerkId>();
  private readonly pointsPopups: PointsPopup[] = [];
  private nextPopupId = 1;
  private nearbyInteractable: MapInteractable | null = null;

  // Weapon firing & animation timers
  private isFiring = false;
  private shiftHeld = false;
  private altHeld = false;
  private fireCooldown = 0;
  private semiTriggerConsumed = false;
  private reloadTimer = 0;
  private stamina = 1.0;

  // Hitmarker & physiology
  private hitmarkerTimer = 0;
  private hitmarkerHeadshot = false;
  private hitmarkerKill = false;
  private heartRateBpm = 86;
  private heartStress = 0;
  private adrenalineStress = 0;
  private rsaPhase = 0;

  // UI & lifecycle
  private pointerLocked = false;
  private tunerOpen = false;
  private scoreboardOpen = false;
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
  private toastMessage: string | null = null;
  private toastTimer = 0;

  private readonly listeners = new Set<SnapshotListener>();

  // Articulated player death ragdoll & pre-allocated zero-GC scratch buffers
  private readonly playerRagdoll = new ArticulatedRagdoll();
  private readonly _deathImpulseDir = new THREE.Vector3();
  private readonly _ragdollHeadWorld = new THREE.Vector3();
  private readonly _ragdollPelvisWorld = new THREE.Vector3();
  private readonly _muzzlePos = new THREE.Vector3();
  private readonly _muzzleDir = new THREE.Vector3();
  private readonly _grenadeThrowOrigin = new THREE.Vector3();
  private readonly _grenadeThrowDir = new THREE.Vector3();
  private readonly _grenadePlayerVel = new THREE.Vector3();
  private readonly _whipVel = new THREE.Vector2();
  private readonly _actorRaycaster = new THREE.Raycaster();
  private readonly _actorHits: THREE.Intersection[] = [];
  private readonly _traumaMods: BodycamTraumaModifiers = { ...DEFAULT_TRAUMA_MODIFIERS };
  private readonly _runtimeProfile: BodycamWeaponProfile;
  private readonly _scopePassParams: ScopePassParams;

  constructor(container: HTMLElement, params: CombatSessionParams) {
    this.container = container;
    this.params = params;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });

    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.isSoftwareGl = /swiftshader|llvmpipe|software/i.test(glRenderer);

    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.05, 190);
    this.scene.add(this.camera);

    // Resolve and build selected map
    const mapId =
      params.mode === 'battle' ? params.battleConfig.mapId : params.infectionConfig.mapId;
    const mapDef = getMapDefinitionById(mapId) ?? getMapDefinitionById('pripyat_block')!;
    this.map = mapDef.build(this.scene, this.renderer, this.isSoftwareGl);

    // Audio
    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );

    // Multiplayer & Special Event setup (Phase 4–5) — resolve Host role before AI instantiation
    this.mp = params.multiplayer ?? null;
    this.isMpHost = Boolean(this.mp?.isHost);
    const evCfg = this.mp?.specialEventConfig ?? null;
    const isClientReplica = Boolean(this.mp && !this.isMpHost);
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy() || 4);

    if (this.mp) {
      const rule = params.mode === 'battle' ? params.battleConfig.rule : 'tdm';
      this.localBattleTeam =
        params.mode === 'infection' ? 'A' : rule === 'ffa' ? 'FFA' : this.mp.localTeam;
      this.localUniformId = resolveOperatorUniformId(params.mode, this.localBattleTeam);

      if (evCfg) {
        this.maxHp = evCfg.playerHealth;
        this.hp = evCfg.playerHealth;
        this.playerMoveSpeedMult = evCfg.playerMoveSpeedMult;
        this.playerRespawnEnabled = evCfg.playerRespawnEnabled;
        this.livesRemaining = evCfg.livesPerRound;
      }

      this.remotePlayers = new RemotePlayerManager(
        this.scene,
        this.audio,
        this.mp.localUserId,
        this.localBattleTeam,
        params.mode,
        rule,
        this.mp.members,
        maxAnisotropy,
      );

      this.unsubMpMessages = this.mp.subscribeMessages((msg) => {
        this.handleRemoteGameMessage(msg);
      });
    } else {
      this.localBattleTeam =
        params.mode === 'battle' && params.battleConfig.rule === 'ffa' ? 'FFA' : 'A';
      this.localUniformId = resolveOperatorUniformId(params.mode, this.localBattleTeam);
    }

    // Strictly separate AI instantiation based on mode, applying Special Event AI/Zombie tuning & Client Replica flag
    if (params.mode === 'battle') {
      this.botAI = new BattleBotAI(
        this.scene,
        this.map,
        this.audio,
        params.battleConfig.rule,
        params.battleConfig.botCount,
        params.battleConfig.difficulty,
        {
          aiHealth: evCfg?.aiHealth,
          aiAccuracyMult: evCfg?.aiAccuracyMult,
          aiMoveSpeedMult: evCfg?.aiMoveSpeedMult,
          aiRespawnEnabled: evCfg?.aiRespawnEnabled,
          isClientReplica,
          maxAnisotropy,
        },
      );
    } else {
      this.zombieAI = new InfectionZombieAI(this.scene, this.map, this.audio, {
        zombieHealthMult: evCfg?.zombieHealthMult,
        zombieMoveSpeedMult: evCfg?.zombieMoveSpeedMult,
        zombieAttackSpeedMult: evCfg?.zombieAttackSpeedMult,
        zombieSpawnAmountMult: evCfg?.zombieSpawnAmountMult,
        waveBreakIntervalSec: evCfg?.waveBreakIntervalSec,
        isClientReplica,
      });
    }

    // Build unified world adapter combining static map geometry, optional rolling terrain, and dynamic actors
    this.adapter = this.createCombatWorldAdapter();

    // SDK Viewmodel, Skeleton, Animator, Controller, PostProcess, Scope & Ballistics
    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    this.localOperatorId = operatorSelectionStore.getSelectedOperator();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      this.localOperatorId,
      {
        maxAnisotropy,
        uniformId: this.localUniformId,
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
      sp.flashlightOn = this.flashlightOn && this.weaponRig.getDerivedStats().hasFlashlight;
      sp.sightMisalignYaw = rigState.sightMisalignYaw;
      sp.sightMisalignPitch = rigState.sightMisalignPitch;
      sp.elapsed = this.elapsedSec;
      sp.mainAvgLuminance = this.postProcess.getAverageLuminance();
      this.scopeRenderer.renderScopePass(sp);
    });

    this.ballistics = new BallisticsSolver(this.scene);

    // Tactical Equipment & Grenade System (shared loadout store + 3D belt mesh assignment)
    const initialEquipSel = tacticalEquipmentStore.getSelection();
    const requestedEquipId =
      params.mode === 'battle'
        ? params.battleConfig.tacticalEquipmentId
        : params.infectionConfig.tacticalEquipmentId;
    this.tacticalEquipmentId = requestedEquipId ?? initialEquipSel.equipmentId;
    this.tacticalBeltSlot = initialEquipSel.beltSlot;
    this.tacticalMountOnBelt = initialEquipSel.mountOnBelt;
    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;

    if (requestedEquipId && requestedEquipId !== initialEquipSel.equipmentId) {
      tacticalEquipmentStore.setEquipment(requestedEquipId);
    }

    this.grenadeSystem = new TacticalGrenadeSystem({
      scene: this.scene,
      physics: this.adapter,
      worldRaycastMeshes: this.map.raycastMeshes,
      worldBounds: {
        minX: this.map.physics.boundsMinX,
        maxX: this.map.physics.boundsMaxX,
        minZ: this.map.physics.boundsMinZ,
        maxZ: this.map.physics.boundsMaxZ,
      },
      audio: this.audio,
      onDetonate: (ev) => this.handleGrenadeDetonation(ev),
    });
    this.grenadeSystem.attachViewmodelCamera(this.camera);

    this.syncBeltEquipmentMesh();
    this.unsubTacticalEquipment = tacticalEquipmentStore.subscribe((sel) => {
      const changedType = sel.equipmentId !== this.tacticalEquipmentId;
      this.tacticalEquipmentId = sel.equipmentId;
      this.tacticalBeltSlot = sel.beltSlot;
      this.tacticalMountOnBelt = sel.mountOnBelt;
      if (changedType) {
        const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
        this.grenadeCount = Math.min(this.grenadeCount, def.maxCarry);
      }
      this.syncBeltEquipmentMesh();
      this.emitSnapshot();
    });

    // Clone baseline runtime profile
    const defaultProf = resolveWeaponProfile('m4a1');
    this._runtimeProfile = {
      ...defaultProf,
      hipOffset: [...defaultProf.hipOffset],
      adsOffset: [...defaultProf.adsOffset],
      cantOffset: [...defaultProf.cantOffset],
      lowReadyOffset: [...defaultProf.lowReadyOffset],
      lowReadyRotation: [...defaultProf.lowReadyRotation],
      rightHandSocket: {
        position: [...defaultProf.rightHandSocket.position],
        rotation: [...defaultProf.rightHandSocket.rotation],
        gripCurl: defaultProf.rightHandSocket.gripCurl,
      },
      leftHandSocket: defaultProf.leftHandSocket
        ? {
            position: [...defaultProf.leftHandSocket.position],
            rotation: [...defaultProf.leftHandSocket.rotation],
            gripCurl: defaultProf.leftHandSocket.gripCurl,
          }
        : undefined,
      muzzleOffset: [...defaultProf.muzzleOffset],
      laserOffset: [...defaultProf.laserOffset],
    };

    // Restore saved Gunsmith attachments from PLAYGROUND
    const savedLoadout = this.saveManager.loadGymLoadout();
    if (savedLoadout) {
      for (const [wId, att] of Object.entries(savedLoadout)) {
        this.attachmentsByWeapon[wId] = normalizeWeaponAttachments(wId, att);
      }
    }

    // Configure starting loadout per mode
    if (params.mode === 'battle') {
      const pId = params.battleConfig.primaryWeaponId || 'm4a1';
      const sId = params.battleConfig.secondaryWeaponId || 'glock_17';
      this.weaponSlots = [pId, sId];
      this.initWeaponAmmo(pId, -1);
      this.initWeaponAmmo(sId, -1);
      this.equipSlot(0, true);
    } else {
      // Infection starts with Glock 17 sidearm + 500 PTS (classic wave-1 progression)
      const startPistol = 'glock_17';
      this.weaponSlots = [startPistol];
      this.initWeaponAmmo(startPistol, 102);
      this.points = 500;
      this.equipSlot(0, true);
    }

    // Place player at map starting spawn
    this.spawnPlayerAtStart();

    this.bindEvents();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  private getAttachmentsFor(weaponId: string): WeaponAttachments {
    if (!this.attachmentsByWeapon[weaponId]) {
      this.attachmentsByWeapon[weaponId] = createBareAttachments();
    }
    return this.attachmentsByWeapon[weaponId];
  }

  private initWeaponAmmo(weaponId: string, reserve: number): void {
    const base = resolveWeaponProfile(weaponId);
    const att = this.getAttachmentsFor(base.id);
    const derived = computeDerivedWeaponStats(base.massKg, base.barrelLengthM, base.magCapacity, att);
    this.magAmmoByWeapon[base.id] = derived.magCapacity;
    this.reserveAmmoByWeapon[base.id] = reserve;
  }

  private getActiveAmmoVariant(weaponId: string): AmmoVariantDef {
    const base = resolveWeaponProfile(weaponId);
    const att = this.getAttachmentsFor(base.id);
    const derived = computeDerivedWeaponStats(base.massKg, base.barrelLengthM, base.magCapacity, att);
    const calId = resolveBaseCaliberId(derived.caliberOverride ?? base.defaultCaliberId);
    if (att.selectedAmmoId) {
      const saved = AMMO_VARIANTS[att.selectedAmmoId as AmmoVariantId];
      if (saved && saved.caliberId === calId) {
        return saved;
      }
    }
    return getDefaultAmmoVariant(calId);
  }

  private createCombatWorldAdapter(): IBodycamWorldAdapter {
    const base = this.map.physics.createAdapter({
      getTraumaModifiers: () => this.getActiveTraumaModifiers(),
      onMeleeHit: (ev) => this.handleMeleeHit(ev),
    });

    const getDynamicHitMeshes = (): THREE.Object3D[] => {
      this.combinedHitMeshes.length = 0;
      if (this.botAI) {
        const bm = this.botAI.getHitMeshes();
        for (let i = 0; i < bm.length; i++) this.combinedHitMeshes.push(bm[i]);
      }
      if (this.zombieAI) {
        const zm = this.zombieAI.getHitMeshes();
        for (let i = 0; i < zm.length; i++) this.combinedHitMeshes.push(zm[i]);
      }
      if (this.remotePlayers) {
        const rm = this.remotePlayers.getHitMeshes();
        for (let i = 0; i < rm.length; i++) this.combinedHitMeshes.push(rm[i]);
      }
      return this.combinedHitMeshes;
    };

    const raycastWithActors = (
      origin: Readonly<THREE.Vector3>,
      direction: Readonly<THREE.Vector3>,
      near: number,
      far: number,
      outResult: BodycamRaycastResult,
    ): boolean => {
      const hitWorld = base.raycast(origin, direction, near, far, outResult);
      const bestDist = hitWorld ? outResult.distance : far;

      const actorMeshes = getDynamicHitMeshes();
      if (actorMeshes.length === 0) return hitWorld;

      this._actorRaycaster.set(origin, direction);
      this._actorRaycaster.near = near;
      this._actorRaycaster.far = bestDist;
      this._actorHits.length = 0;
      this._actorRaycaster.intersectObjects(actorMeshes, false, this._actorHits);

      if (this._actorHits.length > 0) {
        const hit = this._actorHits[0];
        if (hit.distance < bestDist) {
          outResult.hit = true;
          outResult.distance = hit.distance;
          outResult.pointX = hit.point.x;
          outResult.pointY = hit.point.y;
          outResult.pointZ = hit.point.z;
          outResult.normalX = -direction.x;
          outResult.normalY = 0.25;
          outResult.normalZ = -direction.z;
          outResult.surface = 'wood';
          outResult.object = hit.object;
          return true;
        }
      }
      return hitWorld;
    };

    return {
      sweepCapsule: (startPos, dx, dy, dz, radius, height, maxStepUpM, outResult) => {
        base.sweepCapsule(startPos, dx, dy, dz, radius, height, maxStepUpM, outResult);
        if (this.map.terrainHeightAt) {
          const terrY = this.map.terrainHeightAt(outResult.posX, outResult.posZ);
          if (outResult.posY < terrY) {
            outResult.posY = terrY;
            outResult.grounded = true;
          }
        }
      },
      raycast: raycastWithActors,
      getSurfaceMaterial: (x, y, z) => base.getSurfaceMaterial(x, y, z),
      getGroundHeight: (x, z, referenceY) => {
        const py = base.getGroundHeight(x, z, referenceY);
        if (this.map.terrainHeightAt) {
          return Math.max(py, this.map.terrainHeightAt(x, z));
        }
        return py;
      },
      hasOverheadClearance: base.hasOverheadClearance
        ? (x, baseY, z, r, ch, sh) => base.hasOverheadClearance!(x, baseY, z, r, ch, sh)
        : undefined,
      sampleInterior: base.sampleInterior
        ? (x, y, z, out) => base.sampleInterior!(x, y, z, out)
        : undefined,
      getTraumaModifiers: () => this.getActiveTraumaModifiers(),
      meleeSpherecast: (origin, direction, _radius, maxDistance, outResult) =>
        raycastWithActors(origin, direction, 0.05, maxDistance, outResult),
      onMeleeHit: (ev) => this.handleMeleeHit(ev),
    };
  }

  private getActiveTraumaModifiers(): Readonly<BodycamTraumaModifiers> {
    const lowHpRatio = THREE.MathUtils.clamp((55 - this.hp) / 55, 0, 1);
    const reloadMult = this.perks.has('rapid_handling') ? 1.6 : 1.0;

    this._traumaMods.moveSpeedMult = this.playerMoveSpeedMult;
    this._traumaMods.moveAccelMult = Math.max(0.8, this.playerMoveSpeedMult);
    this._traumaMods.canSprint = true;
    this._traumaMods.limpCadenceScale = 1.0;
    this._traumaMods.leftLegImpairment = 0;
    this._traumaMods.rightLegImpairment = 0;
    this._traumaMods.swayAmpMult = 1.0 + lowHpRatio * 0.25;
    this._traumaMods.tremorAmp = lowHpRatio * 0.0018;
    this._traumaMods.adsSpeedMult = this.perks.has('rapid_handling') ? 1.18 : 1.0;
    this._traumaMods.reloadSpeedMult = reloadMult;
    this._traumaMods.arterialVignette = Math.max(lowHpRatio * 0.45, this.damageFlash * 0.65);
    this._traumaMods.desaturation = lowHpRatio * 0.35;
    this._traumaMods.concussionBlur = this.damageFlash * 0.16;
    this._traumaMods.chromaticSpike = this.damageFlash * 0.004;
    this._traumaMods.anyLightBleed = false;
    this._traumaMods.anyHeavyBleed = false;
    return this._traumaMods;
  }

  private syncRuntimeProfile(): void {
    const base = resolveWeaponProfile(this.equippedWeaponId);
    const derived = this.weaponRig.getDerivedStats();
    const ammo = this.getActiveAmmoVariant(base.id);
    const calId = resolveBaseCaliberId(base.defaultCaliberId);

    Object.assign(this._runtimeProfile, base);
    this._runtimeProfile.magCapacity = derived.magCapacity;
    const perkReloadDiv = this.perks.has('rapid_handling') ? 1.6 : 1.0;
    this._runtimeProfile.reloadDurationSec =
      (base.reloadDurationSec * derived.reloadDurationMult) / perkReloadDiv;
    this._runtimeProfile.recoilPitchRad = base.recoilPitchRad * derived.recoilPitchMult;
    this._runtimeProfile.recoilYawRad = base.recoilYawRad * derived.recoilYawMult;

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
    } else {
      this.weaponRig.setZeroConfig(100, 0, 0);
    }
  }

  private equipWeaponById(weaponId: string, silent = false): void {
    const prof = resolveWeaponProfile(weaponId);
    this.equippedWeaponId = prof.id;
    this.reloadTimer = 0;
    this.semiTriggerConsumed = false;
    this.fireCooldown = 0.14;

    const att = this.getAttachmentsFor(prof.id);
    const derived = computeDerivedWeaponStats(prof.massKg, prof.barrelLengthM, prof.magCapacity, att);
    if (this.magAmmoByWeapon[prof.id] === undefined) {
      this.magAmmoByWeapon[prof.id] = derived.magCapacity;
    }

    this.weaponRig.setWeaponProfile(prof, att);
    this.weaponRig.setAmmoState(this.magAmmoByWeapon[prof.id]);
    this.syncRuntimeProfile();
    this.input.adsMode = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';

    // Sync flashlight visibility with mounted attachment
    const hasLight = this.weaponRig.getDerivedStats().hasFlashlight;
    this.weaponRig.flashlight.visible = this.flashlightOn && hasLight;
    this.weaponRig.flashlight.intensity = this.flashlightOn && hasLight ? 32 : 0;

    if (!silent) {
      this.audio.playGearRattle('weapon_swap', 0.65);
      this.showToast(`Equipped: ${prof.name}`);
    }
    this.emitSnapshot();
  }

  private equipSlot(slotIdx: number, silent = false): void {
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
    }
    if (slotIdx === -1) {
      this.activeSlotIndex = -1;
      this.equipWeaponById('unarmed', silent);
      return;
    }
    const wId = this.weaponSlots[slotIdx];
    if (!wId) return;
    this.activeSlotIndex = slotIdx;
    this.equipWeaponById(wId, silent);
  }

  private spawnPlayerAtStart(): void {
    let sp = this.map.spawnPoints.playerStart;
    if (this.params.mode === 'battle') {
      const pool =
        this.params.battleConfig.rule === 'tdm'
          ? this.localBattleTeam === 'B'
            ? this.map.spawnPoints.teamB
            : this.map.spawnPoints.teamA
          : this.map.spawnPoints.ffa;
      if (pool.length > 0) {
        sp = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    const groundY = this.adapter.getGroundHeight(sp.position[0], sp.position[2], sp.position[1]);
    this.playerRagdoll.deactivate();
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.skeleton.applyCanonicalRestPose();
    this.animator.setSecondaryRagdollDecay(false);
    this.animator.resetSecondaryPhysics();
    this.controller.snapTo(sp.position[0], groundY, sp.position[2], sp.yaw, 0);
  }

  public syncMultiplayerMembers(members: LobbyMember[], isHostNow?: boolean): void {
    this.remotePlayers?.syncRosterMembers(members);
    if (this.mp) {
      const me = members.find((m) => m.userId === this.mp!.localUserId);
      if (me && this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm') {
        const nextTeam: BattleTeamId = me.team === 'B' ? 'B' : 'A';
        if (nextTeam !== this.localBattleTeam) {
          this.localBattleTeam = nextTeam;
          this.localUniformId = resolveOperatorUniformId(this.params.mode, nextTeam);
          this.skeleton.applyUniform(this.localUniformId);
        }
      }
    }
    if (this.mp && typeof isHostNow === 'boolean' && isHostNow && !this.isMpHost) {
      // Seamless live Host Migration mid-match: take over authoritative AI & Zombie simulation
      this.isMpHost = true;
      this.botAI?.setClientReplica(false);
      this.zombieAI?.setClientReplica(false);
      // Refund any in-flight map interact requests that never got answered by the dropped Host
      if (this.pendingMapInteractRequests.size > 0) {
        for (const req of this.pendingMapInteractRequests.values()) {
          if (req.cost > 0) {
            this.points += req.cost;
          }
        }
        this.pendingMapInteractRequests.clear();
        this.emitSnapshot();
      }
      this.showToast('You are now the Match Host — AI Sync Active', 3.4);
    }
  }

  private pushMpKillfeed(entry: Omit<BattleKillfeedEntry, 'id' | 'timestampMs'>): void {
    this.mpKillfeed.unshift({
      ...entry,
      id: this.nextMpKillfeedId++,
      timestampMs: performance.now(),
    });
    if (this.mpKillfeed.length > 6) {
      this.mpKillfeed.length = 6;
    }
  }

  private isLocallyActivelyFiring(): boolean {
    return (
      this.isFiring &&
      this.pointerLocked &&
      this.playerAlive &&
      this.reloadTimer <= 0 &&
      this._runtimeProfile.holdClass !== 'unarmed' &&
      (this.magAmmoByWeapon[this._runtimeProfile.id] ?? 0) > 0
    );
  }

  private broadcastLocalState20Hz(): void {
    if (!this.mp) return;
    const lean = (this.input.leanRight ? 1 : 0) - (this.input.leanLeft ? 1 : 0);
    const derived = this.weaponRig.getDerivedStats();
    const rigState = this.weaponRig.getReadOnlyRigState();
    const aimStance: SyncedAimStance = this.controller.aimStance;
    const isPointAim = this.controller.isPointAim;
    const isCanted = this.controller.isCanted;
    const isFiringNow = this.isLocallyActivelyFiring();
    const isReloadingNow = this.reloadTimer > 0;

    this.lastSentStance = aimStance;
    this.lastSentFiring = isFiringNow;
    this.lastSentReloading = isReloadingNow;

    const pkt: GamePlayerStatePacket = {
      type: 'game:state',
      x: Number(this.controller.position.x.toFixed(3)),
      y: Number(this.controller.position.y.toFixed(3)),
      z: Number(this.controller.position.z.toFixed(3)),
      yaw: Number(this.controller.aimYaw.toFixed(4)),
      pitch: Number(this.controller.aimPitch.toFixed(4)),
      crouch: this.controller.crouched,
      sprint: this.controller.isSprinting,
      ads: this.controller.isAds || isPointAim || isCanted,
      adsMode: this.adsModeByWeapon[this._runtimeProfile.id] ?? 'PRIMARY',
      aimStance,
      isPointAim,
      isCanted,
      adsBlend: Number(rigState.adsBlend.toFixed(3)),
      pointAimBlend: Number(rigState.pointAimBlend.toFixed(3)),
      isFiring: isFiringNow,
      isReloading: isReloadingNow,
      fireSeq: this.localFireSeq,
      uniformId: this.localUniformId,
      operatorId: this.localOperatorId,
      lean,
      weaponId: this.equippedWeaponId,
      hp: Math.round(this.hp),
      maxHp: this.maxHp,
      alive: this.playerAlive,
      kills: this.playerKills,
      deaths: this.playerDeaths,
      flashlightOn: this.flashlightOn && derived.hasFlashlight,
      laserOn: this.weaponRig.laserOn && derived.hasLaser,
      ts: Date.now(),
    };
    this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
  }

  private handleRemoteGameMessage(raw: Record<string, unknown>): void {
    if (!this.mp || !this.remotePlayers) return;
    const type = raw.type;

    if (type === 'game:state') {
      this.remotePlayers.applyStatePacket(raw as unknown as GamePlayerStatePacket);
      return;
    }

    if (type === 'game:fire') {
      this.remotePlayers.applyFirePacket(raw as unknown as GamePlayerFirePacket);
      return;
    }

    if (type === 'game:respawn') {
      this.remotePlayers.applyRespawnPacket(raw as unknown as GamePlayerRespawnPacket);
      return;
    }

    if (type === 'game:hit') {
      const pkt = raw as unknown as GamePlayerHitPacket;
      if (pkt.targetUserId !== this.mp.localUserId) {
        this.remotePlayers.triggerHitFlinch(pkt.targetUserId);
        return;
      }
      if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
      const attackerTeam: BattleTeamId =
        this.params.mode === 'infection'
          ? 'A'
          : this.params.battleConfig.rule === 'ffa'
            ? 'FFA'
            : pkt.senderTeam === 'B'
              ? 'B'
              : 'A';
      // Enforce no friendly fire in TDM & co-op Infection
      if (
        this.params.mode === 'infection' ||
        (this.params.mode === 'battle' &&
          this.params.battleConfig.rule === 'tdm' &&
          attackerTeam === this.localBattleTeam)
      ) {
        return;
      }

      const prevAlive = this.playerAlive;
      this.applyPlayerDamage(
        pkt.damage,
        pkt.senderUsername ?? 'OPERATOR',
        attackerTeam,
        pkt.senderUserId,
      );

      // If this remote hit eliminated us, broadcast authoritative kill event so killer & scoreboard update
      if (prevAlive && !this.playerAlive) {
        const killPkt: GamePlayerKillPacket = {
          type: 'game:kill',
          killerUserId: pkt.senderUserId ?? 'unknown',
          killerName: pkt.senderUsername ?? 'OPERATOR',
          killerTeam: attackerTeam,
          victimUserId: this.mp.localUserId,
          victimName: this.mp.localUsername,
          victimTeam: this.localBattleTeam,
          weaponId: pkt.weaponId,
          weaponName: pkt.weaponName,
          headshot: Boolean(pkt.headshot),
          ts: Date.now(),
        };
        this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
        this.applyKillEvent(killPkt);
      }
      return;
    }

    if (type === 'game:kill') {
      const pkt = raw as unknown as GamePlayerKillPacket;
      this.applyKillEvent(pkt);
      return;
    }

    // === PHASE 5: HOST-AUTHORITATIVE AI BOT & INFECTION ZOMBIE REPLICATION ===
    if (type === 'game:bots_sync' && this.botAI && !this.isMpHost) {
      this.botAI.applySyncSnapshot(raw as unknown as GameBotsSyncPacket);
      this.checkBattleVictory();
      return;
    }

    if (type === 'game:bot_fire' && this.botAI && !this.isMpHost) {
      const pkt = raw as unknown as GameBotFirePacket;
      this.botAI.playRemoteBotFire(pkt.botId, pkt.ox, pkt.oy, pkt.oz, pkt.ex, pkt.ey, pkt.ez);
      return;
    }

    if (type === 'game:bot_damage' && this.botAI && this.isMpHost) {
      const pkt = raw as unknown as GameBotDamagePacket;
      const attackerTeam: BattleTeamId =
        this.params.mode === 'battle' && this.params.battleConfig.rule === 'ffa'
          ? 'FFA'
          : pkt.senderTeam === 'B'
            ? 'B'
            : 'A';
      const botInfo = this.botAI.getBotInfo(pkt.botId);
      const res = this.botAI.applyDamageFromPlayer(
        pkt.botId,
        pkt.damage,
        pkt.hitZone,
        pkt.weaponName,
        pkt.senderUsername ?? 'OPERATOR',
        attackerTeam,
        `human:${pkt.senderUserId ?? ''}`,
      );
      if (res.killed && botInfo) {
        const killPkt: GamePlayerKillPacket = {
          type: 'game:kill',
          killerUserId: pkt.senderUserId ?? 'unknown',
          killerName: pkt.senderUsername ?? 'OPERATOR',
          killerTeam: attackerTeam,
          victimUserId: botInfo.id,
          victimName: botInfo.name,
          victimTeam: botInfo.team,
          weaponId: pkt.weaponId,
          weaponName: pkt.weaponName,
          headshot: res.headshot,
          ts: Date.now(),
        };
        this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
        this.checkBattleVictory();
        this.emitSnapshot();
      }
      return;
    }

    if (type === 'game:bot_hit_player') {
      const pkt = raw as unknown as GameBotHitPlayerPacket;
      if (pkt.targetUserId !== this.mp.localUserId) return;
      if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
      const prevAlive = this.playerAlive;
      this.applyPlayerDamage(pkt.damage, pkt.botName, pkt.botTeam, pkt.botId);
      if (prevAlive && !this.playerAlive) {
        const killPkt: GamePlayerKillPacket = {
          type: 'game:kill',
          killerUserId: pkt.botId,
          killerName: pkt.botName,
          killerTeam: pkt.botTeam,
          victimUserId: this.mp.localUserId,
          victimName: this.mp.localUsername,
          victimTeam: this.localBattleTeam,
          weaponId: 'bot_carbine',
          weaponName: 'CARBINE',
          headshot: false,
          ts: Date.now(),
        };
        this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
      }
      return;
    }

    if (type === 'game:zombies_sync' && this.zombieAI && !this.isMpHost) {
      const pkt = raw as unknown as GameZombiesSyncPacket;
      const prevRound = this.zombieAI.round;
      this.zombieAI.applySyncSnapshot(pkt);
      if (pkt.powerOn && !this.powerOn) {
        this.applyMapInteractableEffect('power_switch', undefined, true);
      }
      if (Array.isArray(pkt.openedDoorIds)) {
        for (const doorId of pkt.openedDoorIds) {
          this.applyMapInteractableEffect(doorId, undefined, true);
        }
      }
      if (Array.isArray(pkt.unlockedZoneIds)) {
        for (const zoneId of pkt.unlockedZoneIds) {
          this.zombieAI.unlockZone(zoneId);
        }
      }
      if (pkt.round > prevRound && this.spectating && !this.playerAlive && !this.gameOver) {
        this.reviveCoopInfectionPlayer(pkt.round);
      }
      return;
    }

    if (type === 'game:zombie_spawn' && this.zombieAI && !this.isMpHost) {
      const pkt = raw as unknown as GameZombieSpawnPacket;
      this.zombieAI.applyRemoteSpawn(pkt);
      return;
    }

    if (type === 'game:match_sync' && this.params.mode === 'infection' && !this.isMpHost) {
      const pkt = raw as unknown as GameMatchSyncPacket;
      if (pkt.powerOn && !this.powerOn) {
        this.applyMapInteractableEffect('power_switch', undefined, true);
      }
      if (Array.isArray(pkt.openedDoorIds)) {
        for (const doorId of pkt.openedDoorIds) {
          this.applyMapInteractableEffect(doorId, undefined, true);
        }
      }
      if (Array.isArray(pkt.unlockedZoneIds) && this.zombieAI) {
        for (const zoneId of pkt.unlockedZoneIds) {
          this.zombieAI.unlockZone(zoneId);
        }
      }
      return;
    }

    if (type === 'game:zombie_damage' && this.zombieAI && this.isMpHost) {
      const pkt = raw as unknown as GameZombieDamagePacket;
      this._tmpImpactPoint.set(pkt.px, pkt.py, pkt.pz);
      this._tmpImpactDir.set(pkt.dx, pkt.dy, pkt.dz);
      const res = pkt.melee
        ? this.zombieAI.applyMeleeHit(
            pkt.zombieId,
            pkt.damage,
            pkt.knockbackSpeed || 5.0,
            this._tmpImpactDir,
            this._tmpImpactPoint,
          )
        : this.zombieAI.applyBulletDamage(
            pkt.zombieId,
            pkt.damage,
            pkt.hitZone,
            this._tmpImpactPoint,
            this._tmpImpactDir,
          );

      if (res.killed) {
        const killedPkt: GameZombieKilledPacket = {
          type: 'game:zombie_killed',
          zombieId: pkt.zombieId,
          killerUserId: pkt.senderUserId ?? 'unknown',
          headshot: res.headshot,
          melee: Boolean(pkt.melee),
          pointsAwarded: res.pointsAwarded,
          weaponId: pkt.weaponId,
          px: pkt.px,
          py: pkt.py,
          pz: pkt.pz,
          ts: Date.now(),
        };
        this.mp.sendMessage(killedPkt as unknown as Record<string, unknown>);
      }
      return;
    }

    if (type === 'game:zombie_killed' && this.zombieAI) {
      const pkt = raw as unknown as GameZombieKilledPacket;
      this._tmpImpactPoint.set(pkt.px, pkt.py, pkt.pz);
      this.zombieAI.playVisualDeath(pkt.zombieId, this._tmpImpactPoint);
      if (pkt.killerUserId === this.mp.localUserId) {
        this.hitmarkerTimer = 0.28;
        this.hitmarkerHeadshot = pkt.headshot;
        this.hitmarkerKill = true;
        this.playerKills += 1;
        if (pkt.headshot) this.playerHeadshots += 1;
        if (pkt.weaponId && pkt.weaponId !== 'melee') this.recordWeaponKill(pkt.weaponId);
        // Client already received 10/20 hit points locally — award kill remainder cleanly
        const baseHitPts = pkt.melee ? 20 : 10;
        const bonusKillPts = Math.max(0, pkt.pointsAwarded - baseHitPts);
        if (bonusKillPts > 0) {
          this.addPoints(
            bonusKillPts,
            pkt.melee ? 'MELEE KILL' : pkt.headshot ? 'HEADSHOT' : 'ELIMINATION',
          );
        }
        this.emitSnapshot();
      }
      return;
    }

    if (type === 'game:zombie_hit_player') {
      const pkt = raw as unknown as GameZombieHitPlayerPacket;
      if (pkt.targetUserId !== this.mp.localUserId) return;
      this.applyPlayerDamage(pkt.damage, 'INFECTED');
      return;
    }

    if (type === 'game:round_complete' && this.params.mode === 'infection') {
      const pkt = raw as unknown as GameRoundCompletePacket;
      this.addPoints(pkt.bonusPoints, `ROUND ${pkt.completedRound} BONUS`);
      this.replenishInfectionRoundGrenade();
      this.showToast(`Round ${pkt.completedRound} Cleared · +${pkt.bonusPoints} PTS · +1 Grenade`, 3.4);
      if (this.spectating && !this.playerAlive && !this.gameOver) {
        this.reviveCoopInfectionPlayer(pkt.completedRound + 1);
      }
      this.emitSnapshot();
      return;
    }

    // Automatic silent Host validation of any teammate's door/power interaction
    if (type === 'game:map_interact_request' && this.params.mode === 'infection' && this.isMpHost) {
      const pkt = raw as unknown as GameMapInteractRequestPacket;
      const requesterId = pkt.senderUserId ?? '';
      const requesterName = pkt.senderUsername ?? 'TEAMMATE';
      const it = this.map.interactables.find(
        (item) =>
          item.id === pkt.interactableId ||
          (pkt.kind === 'power_switch' && item.kind === 'power_switch'),
      );

      let rejectReason: string | null = null;
      if (!it || it.kind !== pkt.kind) {
        rejectReason = 'Interaction unavailable';
      } else if (it.activated) {
        rejectReason = 'Already unlocked by teammate';
      } else if (requesterId) {
        const senderActor = this.remotePlayers
          .getAliveHumanTargets()
          .find((h) => h.id === requesterId);
        if (senderActor) {
          const dist = Math.hypot(
            it.position[0] - senderActor.pos.x,
            it.position[2] - senderActor.pos.z,
          );
          if (dist > it.radiusM + 4.5) {
            rejectReason = 'Too far from interactable';
          }
        }
      }

      if (rejectReason) {
        const rejPkt: GameMapInteractRejectedPacket = {
          type: 'game:map_interact_rejected',
          targetUserId: requesterId,
          interactableId: pkt.interactableId,
          requestId: pkt.requestId,
          refundPoints: Math.max(0, Math.round(pkt.cost ?? it?.cost ?? 0)),
          reason: rejectReason,
          ts: Date.now(),
        };
        this.mp.sendMessage(rejPkt as unknown as Record<string, unknown>);
        return;
      }

      if (it && this.applyMapInteractableEffect(it.id, requesterName, false)) {
        const confirmPkt: GameMapInteractPacket = {
          type: 'game:map_interact',
          kind: it.kind === 'power_switch' ? 'power_switch' : 'buyable_door',
          interactableId: it.id,
          unlockedZoneId: it.unlocksZoneId,
          activatedByUserId: requesterId,
          activatedByUsername: requesterName,
          requestId: pkt.requestId,
          ts: Date.now(),
        };
        this.mp.sendMessage(confirmPkt as unknown as Record<string, unknown>);
        if (this.zombieAI) {
          this.mp.sendMessage(
            this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
          );
        }
      }
      return;
    }

    if (type === 'game:map_interact' && this.params.mode === 'infection') {
      const pkt = raw as unknown as GameMapInteractPacket;
      // Enforce Host authority: ignore forged peer packets
      if (!pkt.senderIsHost) return;

      // Clear matching optimistic pending request if this client initiated it
      if (this.pendingMapInteractRequests.has(pkt.interactableId)) {
        this.pendingMapInteractRequests.delete(pkt.interactableId);
      } else if (pkt.requestId) {
        for (const [key, req] of this.pendingMapInteractRequests.entries()) {
          if (req.requestId === pkt.requestId) {
            this.pendingMapInteractRequests.delete(key);
            break;
          }
        }
      }

      const actorLabel =
        pkt.activatedByUserId === this.mp.localUserId
          ? undefined
          : (pkt.activatedByUsername ?? pkt.senderUsername);
      this.applyMapInteractableEffect(pkt.interactableId, actorLabel, false);
      if (pkt.unlockedZoneId && this.zombieAI) {
        this.zombieAI.unlockZone(pkt.unlockedZoneId);
      }
      return;
    }

    if (type === 'game:map_interact_rejected' && this.params.mode === 'infection') {
      const pkt = raw as unknown as GameMapInteractRejectedPacket;
      if (!pkt.senderIsHost) return;
      if (pkt.targetUserId !== this.mp.localUserId) return;

      let refunded = 0;
      const byId = this.pendingMapInteractRequests.get(pkt.interactableId);
      if (byId) {
        refunded = byId.cost;
        this.pendingMapInteractRequests.delete(pkt.interactableId);
      } else if (pkt.requestId) {
        for (const [key, req] of this.pendingMapInteractRequests.entries()) {
          if (req.requestId === pkt.requestId) {
            refunded = req.cost;
            this.pendingMapInteractRequests.delete(key);
            break;
          }
        }
      }

      if (refunded > 0) {
        this.points += refunded;
      }
      this.showToast(
        refunded > 0 ? `${pkt.reason} · +${refunded} PTS refunded` : pkt.reason,
        3.0,
      );
      this.emitSnapshot();
    }
  }

  private reviveCoopInfectionPlayer(nextRound: number): void {
    this.playerAlive = true;
    this.spectating = false;
    this.spectatingTargetName = null;
    this.hp = this.maxHp;
    this.livesRemaining = Math.max(1, this.mp?.specialEventConfig?.livesPerRound ?? 1);
    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
    this.syncBeltEquipmentMesh();
    this.spawnPlayerAtStart();
    this.showToast(`Reinforced for Round ${nextRound}`, 3.2);
    if (this.mp) {
      const rspPkt: GamePlayerRespawnPacket = {
        type: 'game:respawn',
        x: Number(this.controller.position.x.toFixed(3)),
        y: Number(this.controller.position.y.toFixed(3)),
        z: Number(this.controller.position.z.toFixed(3)),
        yaw: Number(this.controller.aimYaw.toFixed(4)),
        hp: this.maxHp,
        maxHp: this.maxHp,
        uniformId: this.localUniformId,
        operatorId: this.localOperatorId,
        ts: Date.now(),
      };
      this.mp.sendMessage(rspPkt as unknown as Record<string, unknown>);
    }
  }

  private applyKillEvent(pkt: GamePlayerKillPacket): void {
    this.remotePlayers?.markPlayerDead(pkt.victimUserId);

    this.pushMpKillfeed({
      killerName: pkt.killerName,
      killerTeam: pkt.killerTeam,
      victimName: pkt.victimName,
      victimTeam: pkt.victimTeam,
      headshot: pkt.headshot,
      weaponLabel: pkt.weaponName,
    });

    if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm') {
      // Only add player-vs-player kills to mpScoreA/B (bot kills are already tracked in botAI.scoreA/B)
      if (!pkt.victimUserId.startsWith('bot_') && !pkt.killerUserId.startsWith('bot_')) {
        if (pkt.killerTeam === 'A') this.mpScoreA += 1;
        else if (pkt.killerTeam === 'B') this.mpScoreB += 1;
      }
    }

    if (this.mp && pkt.killerUserId === this.mp.localUserId) {
      this.playerKills += 1;
      if (pkt.headshot) this.playerHeadshots += 1;
      if (pkt.weaponId && pkt.weaponId !== 'melee') this.recordWeaponKill(pkt.weaponId);
      this.hitmarkerTimer = 0.32;
      this.hitmarkerHeadshot = pkt.headshot;
      this.hitmarkerKill = true;
      this.showToast(
        pkt.headshot ? `HEADSHOT ELIMINATION · ${pkt.victimName}` : `ELIMINATED ${pkt.victimName}`,
        2.2,
      );
    }

    this.checkBattleVictory();
    this.emitSnapshot();
  }

  public subscribe(fn: SnapshotListener): () => void {
    this.listeners.add(fn);
    fn(this.buildSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  public requestLock(): void {
    this.audio.ensureInitialized();
    this.tunerOpen = false;
    if (this.gameOver || this.matchOutcome !== 'active') return;
    if (document.pointerLockElement !== this.renderer.domElement) {
      try {
        void this.renderer.domElement.requestPointerLock();
      } catch {
        // Ignore browser pointer lock rejection
      }
    }
    this.emitSnapshot();
  }

  public setTunerOpen(open: boolean): void {
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
    this.updateConfig({
      lensPreset: presetId,
      fisheyeStrength: p.fisheyeStrength,
      chromaticAberration: p.chromaticAberration,
      isoGrain: p.isoGrain,
      lensDirtStrength: p.lensDirtStrength,
      motionBlurStrength: p.motionBlurStrength,
    });
  }

  public rematchBattle(): void {
    if (this.params.mode !== 'battle' || !this.botAI) return;
    this.playerKills = 0;
    this.playerDeaths = 0;
    this.playerHeadshots = 0;
    this.weaponKills = {};
    this.matchOutcome = 'active';
    this.playerAlive = true;
    this.respawnTimerSec = 0;
    this.hp = this.maxHp;
    this.damageFlash = 0;
    this.flashBlindAlpha = 0;
    this.grenadeSystem.cancelCook();
    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
    this.syncBeltEquipmentMesh();
    for (const wId of this.weaponSlots) {
      this.initWeaponAmmo(wId, -1);
    }
    this.equipSlot(0, true);
    this.spawnPlayerAtStart();
    this.botAI.resetMatch(this.controller.position);
    this.ballistics.clearEffects();
    this.showToast('Match Restarted');
    this.requestLock();
  }

  public setTacticalEquipment(id: TacticalEquipmentId): void {
    tacticalEquipmentStore.setEquipment(id);
    const def = getTacticalEquipmentDef(id);
    this.tacticalEquipmentId = def.id;
    this.grenadeCount = Math.min(Math.max(1, this.grenadeCount), def.maxCarry);
    this.syncBeltEquipmentMesh();
    this.audio.playGearRattle('weapon_swap', 0.5);
    this.showToast(`Belt Ordnance: ${def.name}`);
    this.emitSnapshot();
  }

  public setTacticalBeltSlot(slot: TacticalBeltSlot): void {
    tacticalEquipmentStore.setBeltSlot(slot);
    this.tacticalBeltSlot = slot;
    this.syncBeltEquipmentMesh();
    this.audio.playTacticalSwitchClick(true);
    this.emitSnapshot();
  }

  public setTacticalMountOnBelt(mountOnBelt: boolean): void {
    tacticalEquipmentStore.setMountOnBelt(mountOnBelt);
    this.tacticalMountOnBelt = mountOnBelt;
    this.syncBeltEquipmentMesh();
    this.audio.playTacticalSwitchClick(mountOnBelt);
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

  private replenishInfectionRoundGrenade(): void {
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    if (this.grenadeCount < def.maxCarry) {
      this.grenadeCount = Math.min(def.maxCarry, this.grenadeCount + 1);
      this.syncBeltEquipmentMesh();
    }
  }

  private handleGrenadeHolsterOrToss(): 'holstered' | 'tossed' | 'none' {
    this.camera.getWorldPosition(this._grenadeThrowOrigin);
    this.camera.getWorldDirection(this._grenadeThrowDir);
    this._grenadeThrowOrigin.y -= 0.08;
    this.controller.getVelocity(this._grenadePlayerVel);
    const res = this.grenadeSystem.holsterOrTossOnSwitch(
      this._grenadeThrowOrigin,
      this._grenadeThrowDir,
      this._grenadePlayerVel,
    );
    if (res === 'tossed') {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.audio.playGearRattle('weapon_swap', 0.65);
      this.showToast('Live Grenade Tossed Clear!');
    } else if (res === 'holstered') {
      this.showToast('Grenade Re-Pinned & Holstered');
    }
    return res;
  }

  private drawOrHolsterGrenade(): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss();
      this.emitSnapshot();
      return;
    }
    if (this.controller.isVaulting()) return;
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    if (this.grenadeCount <= 0) {
      this.showToast(`No ${def.shortName} Remaining`);
      return;
    }
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = 0;
    this.weaponRig.cancelZoomTwist();
    this.grenadeSystem.drawGrenade(def.id);
    this.showToast(`${def.shortName} Drawn — LMB Pin · RMB Lever · Rel LMB Throw`);
    this.emitSnapshot();
  }

  private throwHeldGrenadeNow(): void {
    if (!this.grenadeSystem.isPinPulled()) return;
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') {
      this.grenadeSystem.cancelCook();
      this.emitSnapshot();
      return;
    }
    this.camera.getWorldPosition(this._grenadeThrowOrigin);
    this.camera.getWorldDirection(this._grenadeThrowDir);
    this._grenadeThrowOrigin.y -= 0.08;
    this.controller.getVelocity(this._grenadePlayerVel);
    if (
      this.grenadeSystem.throwHeldGrenade(
        this._grenadeThrowOrigin,
        this._grenadeThrowDir,
        this._grenadePlayerVel,
      )
    ) {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.audio.playGearRattle('weapon_swap', 0.65);
    }
    this.emitSnapshot();
  }

  private handleGrenadeDetonation(ev: GrenadeDetonationEvent): void {
    // 1. Battle AI Bots AoE blast (with 44-ray cover-occluded M67 fragmentation evaluator)
    if (this.params.mode === 'battle' && this.botAI) {
      const attackerName = this.mp?.localUsername ?? 'YOU';
      const fragEvaluator =
        ev.kind === 'frag'
          ? (targetPos: Readonly<THREE.Vector3>) =>
              this.grenadeSystem.evaluateFragDamageAt(ev.position, targetPos, ev.def).damage
          : undefined;
      const res = this.botAI.applyAreaBlast(
        ev.position,
        ev.radiusM,
        ev.maxDamage,
        ev.kind,
        attackerName,
        this.localBattleTeam,
        ev.def.killfeedLabel,
        fragEvaluator,
      );
      if (res.hits > 0) {
        this.hitmarkerTimer = res.kills > 0 ? 0.34 : 0.2;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.kills > 0;
        if (res.kills > 0) {
          this.playerKills += res.kills;
          if (this.mp) {
            for (const botId of res.killedBotIds) {
              const info = this.botAI.getBotInfo(botId);
              if (!info) continue;
              const killPkt: GamePlayerKillPacket = {
                type: 'game:kill',
                killerUserId: this.mp.localUserId,
                killerName: this.mp.localUsername,
                killerTeam: this.localBattleTeam,
                victimUserId: info.id,
                victimName: info.name,
                victimTeam: info.team,
                weaponId: ev.equipmentId,
                weaponName: ev.def.killfeedLabel,
                headshot: false,
                ts: Date.now(),
              };
              this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
            }
          }
          this.checkBattleVictory();
        }
        this.emitSnapshot();
      }
    }

    // 2. Multiplayer Remote Human Opponents PvP blast
    if (this.params.mode === 'battle' && this.mp && this.remotePlayers && ev.kind !== 'smoke') {
      const searchR = ev.kind === 'frag' ? Math.max(ev.radiusM, 24.0) : ev.radiusM;
      const hostiles = this.remotePlayers.getAliveHostilesInRadius(ev.position, searchR);
      for (const target of hostiles) {
        const chest = target.pos.clone();
        chest.y += 1.1;
        let dmg = 0;
        if (ev.kind === 'frag') {
          dmg = Math.round(
            this.grenadeSystem.evaluateFragDamageAt(ev.position, chest, ev.def).damage,
          );
          if (dmg <= 0) continue;
        } else {
          if (ev.kind !== 'thermite' && !this.grenadeSystem.hasClearBlastLine(ev.position, chest)) {
            continue;
          }
          const falloff = Math.max(0.16, 1 - target.dist / Math.max(0.5, ev.radiusM));
          dmg =
            ev.kind === 'flash'
              ? Math.max(4, Math.round(ev.maxDamage * falloff))
              : Math.max(8, Math.round(ev.maxDamage * Math.pow(falloff, 1.1)));
        }
        this.hitmarkerTimer = 0.22;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = false;
        this.remotePlayers.triggerHitFlinch(target.userId);
        const hitPkt: GamePlayerHitPacket = {
          type: 'game:hit',
          targetUserId: target.userId,
          damage: dmg,
          hitZone: 'thorax',
          headshot: false,
          weaponId: ev.equipmentId,
          weaponName: ev.def.killfeedLabel,
          ts: Date.now(),
        };
        this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
      }
    }

    // 3. Infection Zombies AoE blast
    if (this.params.mode === 'infection' && this.zombieAI) {
      const res = this.zombieAI.applyAreaBlast(ev.position, ev.radiusM, ev.maxDamage, ev.kind);
      if (res.hits > 0) {
        this.hitmarkerTimer = res.kills > 0 ? 0.34 : 0.2;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.kills > 0;
        if (res.kills > 0) {
          this.playerKills += res.kills;
        }
        if (res.pointsAwarded > 0) {
          this.addPoints(
            res.pointsAwarded,
            res.kills > 0 ? `${ev.def.shortName} x${res.kills}` : ev.def.shortName,
          );
        }
        this.emitSnapshot();
      }
    }

    // 4. Local player concussion, full bodycam CMOS flashbang overload + tinnitus, & cover-occluded frag damage
    if (this.playerAlive && !this.gameOver && this.matchOutcome === 'active') {
      const playerChest = this._grenadeThrowOrigin.set(
        this.controller.position.x,
        this.controller.position.y + 1.15,
        this.controller.position.z,
      );
      const dist = playerChest.distanceTo(ev.position);
      const maxEffectDist = ev.kind === 'frag' ? Math.max(ev.radiusM * 1.4, 24.0) : ev.radiusM * 1.25;
      if (dist <= maxEffectDist) {
        const proximity = Math.max(0, 1 - dist / Math.max(0.6, maxEffectDist));
        if (!ev.isTick) {
          this.controller.applyRecoil(
            0.028 * proximity,
            (Math.random() - 0.5) * 0.045 * proximity,
            0.014 * proximity,
            0.6,
            { stanceCoupled: false },
          );
          this.adrenalineStress = Math.min(1, this.adrenalineStress + 0.35 * proximity);
        }

        if (ev.kind === 'flash') {
          this.camera.getWorldDirection(this._grenadeThrowDir);
          const exposure = this.grenadeSystem.computeFlashbangExposure(
            ev.position,
            this.camera.position,
            this._grenadeThrowDir,
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
        } else if (ev.kind === 'frag') {
          const fragEval = this.grenadeSystem.evaluateFragDamageAt(ev.position, playerChest, ev.def);
          const selfDmg = Math.round(fragEval.damage * 0.62);
          if (selfDmg > 0) {
            this.applyPlayerDamage(selfDmg, ev.def.killfeedLabel, this.localBattleTeam);
          }
        } else if (ev.kind === 'thermite' && dist <= ev.radiusM) {
          const falloff = Math.max(0.15, 1 - dist / Math.max(0.5, ev.radiusM));
          const selfDmg = Math.round(ev.maxDamage * 0.48 * falloff);
          if (selfDmg > 0) {
            this.applyPlayerDamage(selfDmg, ev.def.killfeedLabel, this.localBattleTeam);
          }
        }
      }
    }
  }

  private showToast(msg: string, duration = 2.6): void {
    this.toastMessage = msg;
    this.toastTimer = duration;
  }

  private addPoints(amount: number, label: string): void {
    this.points += amount;
    this.pointsPopups.push({
      id: this.nextPopupId++,
      amount,
      label,
      timestampMs: performance.now(),
    });
    if (this.pointsPopups.length > 6) {
      this.pointsPopups.shift();
    }
  }

  private computeWeaponBaseDamage(ev: Readonly<BallisticImpactEvent>): number {
    // Grounded energy-based combat damage tuned for satisfying tactical TTK
    const energy = Math.max(200, ev.impactEnergyJ);
    if (ev.ammo.pellets > 1) {
      // Buckshot pellets: ~26 dmg per pellet -> devastating at CQB
      return THREE.MathUtils.clamp(energy * 0.048, 18, 34);
    }
    return THREE.MathUtils.clamp(16 + Math.sqrt(energy) * 0.68, 24, 98);
  }

  private handleBallisticImpact(ev: Readonly<BallisticImpactEvent>): void {
    const obj = ev.object;
    const ud = obj?.userData;

    if (ud?.combatActorType === 'remote_player' && this.mp && this.remotePlayers) {
      const targetUserId = String(ud.actorId);
      if (this.remotePlayers.isFriendly(targetUserId)) {
        return;
      }
      const hitZone = String(ud.hitZone ?? 'thorax');
      const headshot = hitZone === 'head';
      const zoneMult = headshot ? 2.1 : hitZone === 'limb' ? 0.72 : 1.0;
      const damage = Math.max(1, Math.min(250, Math.round(this.computeWeaponBaseDamage(ev) * zoneMult)));

      this.hitmarkerTimer = headshot ? 0.22 : 0.16;
      this.hitmarkerHeadshot = headshot;
      this.hitmarkerKill = false;
      this.audio.playImpact(ev.point, headshot ? 'steel_plate' : 'wood');
      this.remotePlayers.triggerHitFlinch(targetUserId);

      const hitPkt: GamePlayerHitPacket = {
        type: 'game:hit',
        targetUserId,
        damage,
        hitZone,
        headshot,
        weaponId: this._runtimeProfile.id,
        weaponName: this._runtimeProfile.name,
        ts: Date.now(),
      };
      this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
      this.emitSnapshot();
      return;
    }

    if (ud?.combatActorType === 'bot' && this.botAI) {
      const botId = String(ud.actorId);
      const hitZone = String(ud.hitZone ?? 'thorax');
      const baseDmg = this.computeWeaponBaseDamage(ev);

      if (this.mp && !this.isMpHost) {
        const info = this.botAI.getBotInfo(botId);
        if (!info || !info.alive) return;
        if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm' && info.team === this.localBattleTeam) {
          return;
        }
        const headshot = hitZone === 'head';
        this.hitmarkerTimer = headshot ? 0.22 : 0.16;
        this.hitmarkerHeadshot = headshot;
        this.hitmarkerKill = false;
        this.audio.playImpact(ev.point, headshot ? 'steel_plate' : 'wood');
        this.botAI.triggerVisualFlinch(botId);

        const dmgPkt: GameBotDamagePacket = {
          type: 'game:bot_damage',
          botId,
          damage: Math.max(1, Math.min(350, Math.round(baseDmg))),
          hitZone,
          weaponId: this._runtimeProfile.id,
          weaponName: this._runtimeProfile.name,
          ts: Date.now(),
        };
        this.mp.sendMessage(dmgPkt as unknown as Record<string, unknown>);
        this.emitSnapshot();
        return;
      }

      const botInfo = this.botAI.getBotInfo(botId);
      const res = this.botAI.applyDamageFromPlayer(
        botId,
        baseDmg,
        hitZone,
        this._runtimeProfile.name,
        this.mp?.localUsername ?? 'YOU',
        this.localBattleTeam,
        this.mp ? `human:${this.mp.localUserId}` : 'player',
      );
      if (res.hit) {
        this.hitmarkerTimer = res.killed ? 0.28 : 0.16;
        this.hitmarkerHeadshot = res.headshot;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, res.headshot ? 'steel_plate' : 'wood');

        if (res.killed) {
          this.playerKills += 1;
          this.recordWeaponKill(this._runtimeProfile.id);
          if (res.headshot) this.playerHeadshots += 1;
          if (this.mp && botInfo) {
            const killPkt: GamePlayerKillPacket = {
              type: 'game:kill',
              killerUserId: this.mp.localUserId,
              killerName: this.mp.localUsername,
              killerTeam: this.localBattleTeam,
              victimUserId: botInfo.id,
              victimName: botInfo.name,
              victimTeam: botInfo.team,
              weaponId: this._runtimeProfile.id,
              weaponName: this._runtimeProfile.name,
              headshot: res.headshot,
              ts: Date.now(),
            };
            this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
          }
          this.checkBattleVictory();
        }
        this.emitSnapshot();
      }
      return;
    }

    if (ud?.combatActorType === 'zombie' && this.zombieAI) {
      const zombieId = String(ud.actorId);
      const hitZone = String(ud.hitZone ?? 'thorax');
      const baseDmg = this.computeWeaponBaseDamage(ev);

      if (this.mp && !this.isMpHost) {
        const headshot = hitZone === 'head';
        this.hitmarkerTimer = headshot ? 0.22 : 0.16;
        this.hitmarkerHeadshot = headshot;
        this.hitmarkerKill = false;
        this.audio.playImpact(ev.point, headshot ? 'steel_plate' : 'wood');
        this.zombieAI.playVisualHitFeedback(zombieId, ev.point, headshot);
        this.addPoints(10, 'HIT');

        const zDmgPkt: GameZombieDamagePacket = {
          type: 'game:zombie_damage',
          zombieId,
          damage: Math.max(1, Math.min(350, Math.round(baseDmg))),
          hitZone,
          melee: false,
          knockbackSpeed: 0,
          px: Number(ev.point.x.toFixed(3)),
          py: Number(ev.point.y.toFixed(3)),
          pz: Number(ev.point.z.toFixed(3)),
          dx: Number(ev.incomingDir.x.toFixed(3)),
          dy: Number(ev.incomingDir.y.toFixed(3)),
          dz: Number(ev.incomingDir.z.toFixed(3)),
          weaponId: this._runtimeProfile.id,
          ts: Date.now(),
        };
        this.mp.sendMessage(zDmgPkt as unknown as Record<string, unknown>);
        this.emitSnapshot();
        return;
      }

      const res = this.zombieAI.applyBulletDamage(
        zombieId,
        baseDmg,
        hitZone,
        ev.point,
        ev.incomingDir,
      );
      if (res.hit) {
        this.hitmarkerTimer = res.killed ? 0.28 : 0.16;
        this.hitmarkerHeadshot = res.headshot;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, res.headshot ? 'steel_plate' : 'wood');

        if (res.pointsAwarded > 0) {
          this.addPoints(
            res.pointsAwarded,
            res.killed ? (res.headshot ? 'HEADSHOT' : 'ELIMINATION') : 'HIT',
          );
        }
        if (res.killed) {
          this.playerKills += 1;
          this.recordWeaponKill(this._runtimeProfile.id);
          if (res.headshot) this.playerHeadshots += 1;
          if (this.mp) {
            const killedPkt: GameZombieKilledPacket = {
              type: 'game:zombie_killed',
              zombieId,
              killerUserId: this.mp.localUserId,
              headshot: res.headshot,
              melee: false,
              pointsAwarded: res.pointsAwarded,
              weaponId: this._runtimeProfile.id,
              px: Number(ev.point.x.toFixed(3)),
              py: Number(ev.point.y.toFixed(3)),
              pz: Number(ev.point.z.toFixed(3)),
              ts: Date.now(),
            };
            this.mp.sendMessage(killedPkt as unknown as Record<string, unknown>);
          }
        }
        this.emitSnapshot();
      }
      return;
    }

    // Static environment surface audio
    if (ev.material === 'steel') this.audio.playImpact(ev.point, 'metal');
    else if (ev.material === 'wood') this.audio.playImpact(ev.point, 'wood');
    else this.audio.playImpact(ev.point, 'concrete');
  }

  private recordWeaponKill(weaponId: string): void {
    if (!weaponId) return;
    this.weaponKills[weaponId] = (this.weaponKills[weaponId] ?? 0) + 1;
  }

  private handleMeleeHit(ev: Readonly<BodycamMeleeHitEvent>): void {
    const ud = ev.object?.userData;
    const isKick = ev.attackType === 'kick';
    const meleeDmg = isKick ? 42 : ev.attackType === 'bash' ? 68 : 52;
    const kbSpeed = isKick ? 7.8 : 4.6;

    if (ud?.combatActorType === 'remote_player' && this.mp && this.remotePlayers) {
      const targetUserId = String(ud.actorId);
      if (this.remotePlayers.isFriendly(targetUserId)) return;
      this.hitmarkerTimer = 0.22;
      this.hitmarkerHeadshot = false;
      this.hitmarkerKill = false;
      this.audio.playImpact(ev.point, 'wood');
      this.remotePlayers.triggerHitFlinch(targetUserId);

      const hitPkt: GamePlayerHitPacket = {
        type: 'game:hit',
        targetUserId,
        damage: meleeDmg,
        hitZone: 'thorax',
        headshot: false,
        weaponId: 'melee',
        weaponName: isKick ? 'PUSH-KICK' : 'MELEE',
        ts: Date.now(),
      };
      this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
      this.emitSnapshot();
      return;
    }

    if (ud?.combatActorType === 'zombie' && this.zombieAI) {
      const zombieId = String(ud.actorId);
      if (this.mp && !this.isMpHost) {
        this.hitmarkerTimer = 0.2;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = false;
        this.audio.playImpact(ev.point, 'wood');
        this.zombieAI.playVisualHitFeedback(zombieId, ev.point, false);
        this.addPoints(20, 'BASH');

        const zDmgPkt: GameZombieDamagePacket = {
          type: 'game:zombie_damage',
          zombieId,
          damage: meleeDmg,
          hitZone: 'thorax',
          melee: true,
          knockbackSpeed: kbSpeed,
          px: Number(ev.point.x.toFixed(3)),
          py: Number(ev.point.y.toFixed(3)),
          pz: Number(ev.point.z.toFixed(3)),
          dx: Number(ev.direction.x.toFixed(3)),
          dy: Number(ev.direction.y.toFixed(3)),
          dz: Number(ev.direction.z.toFixed(3)),
          weaponId: 'melee',
          ts: Date.now(),
        };
        this.mp.sendMessage(zDmgPkt as unknown as Record<string, unknown>);
        this.emitSnapshot();
        return;
      }

      const res = this.zombieAI.applyMeleeHit(
        zombieId,
        meleeDmg,
        kbSpeed,
        ev.direction,
        ev.point,
      );
      if (res.hit) {
        this.hitmarkerTimer = res.killed ? 0.28 : 0.18;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, 'wood');
        if (res.pointsAwarded > 0) {
          this.addPoints(res.pointsAwarded, res.killed ? 'MELEE KILL' : 'BASH');
        }
        if (res.killed) {
          this.playerKills += 1;
          if (this.mp) {
            const killedPkt: GameZombieKilledPacket = {
              type: 'game:zombie_killed',
              zombieId,
              killerUserId: this.mp.localUserId,
              headshot: false,
              melee: true,
              pointsAwarded: res.pointsAwarded,
              weaponId: 'melee',
              px: Number(ev.point.x.toFixed(3)),
              py: Number(ev.point.y.toFixed(3)),
              pz: Number(ev.point.z.toFixed(3)),
              ts: Date.now(),
            };
            this.mp.sendMessage(killedPkt as unknown as Record<string, unknown>);
          }
        }
        this.emitSnapshot();
      }
      return;
    }

    if (ud?.combatActorType === 'bot' && this.botAI) {
      const botId = String(ud.actorId);
      if (this.mp && !this.isMpHost) {
        const info = this.botAI.getBotInfo(botId);
        if (!info || !info.alive) return;
        if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm' && info.team === this.localBattleTeam) {
          return;
        }
        this.hitmarkerTimer = 0.22;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = false;
        this.audio.playImpact(ev.point, 'wood');
        this.botAI.triggerVisualFlinch(botId);
        const dmgPkt: GameBotDamagePacket = {
          type: 'game:bot_damage',
          botId,
          damage: meleeDmg,
          hitZone: 'thorax',
          weaponId: 'melee',
          weaponName: isKick ? 'PUSH-KICK' : 'MELEE',
          melee: true,
          ts: Date.now(),
        };
        this.mp.sendMessage(dmgPkt as unknown as Record<string, unknown>);
        this.emitSnapshot();
        return;
      }

      const botInfo = this.botAI.getBotInfo(botId);
      const res = this.botAI.applyDamageFromPlayer(
        botId,
        meleeDmg,
        'thorax',
        isKick ? 'PUSH-KICK' : 'MELEE',
        this.mp?.localUsername ?? 'YOU',
        this.localBattleTeam,
        this.mp ? `human:${this.mp.localUserId}` : 'player',
      );
      if (res.hit) {
        this.hitmarkerTimer = 0.22;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, 'wood');
        if (res.killed) {
          this.playerKills += 1;
          if (this.mp && botInfo) {
            const killPkt: GamePlayerKillPacket = {
              type: 'game:kill',
              killerUserId: this.mp.localUserId,
              killerName: this.mp.localUsername,
              killerTeam: this.localBattleTeam,
              victimUserId: botInfo.id,
              victimName: botInfo.name,
              victimTeam: botInfo.team,
              weaponId: 'melee',
              weaponName: isKick ? 'PUSH-KICK' : 'MELEE',
              headshot: false,
              ts: Date.now(),
            };
            this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
          }
          this.checkBattleVictory();
        }
        this.emitSnapshot();
      }
    }
  }

  private applyPlayerDamage(
    damage: number,
    attackerLabel: string,
    attackerTeam: 'A' | 'B' | 'FFA' = 'B',
    attackerId?: string,
  ): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
    this.hp = Math.max(0, this.hp - damage);
    this.timeSinceDamageSec = 0;
    this.damageFlash = Math.min(1.0, this.damageFlash + 0.65);
    this.adrenalineStress = Math.min(1.0, this.adrenalineStress + 0.35);

    // Subtle bodycam camera shock on hit
    this.controller.applyRecoil(
      0.018,
      (Math.random() - 0.5) * 0.032,
      0.01,
      0.5,
      { stanceCoupled: false },
    );

    if (this.hp <= 0) {
      this.playerAlive = false;
      this.playerDeaths += 1;
      this.isFiring = false;
      this.input.ads = false;
      this.grenadeSystem.cancelCook();
      this.weaponRig.cancelAction();
      this.skeleton.setFirstPersonHeadShadowOnly(false);
      this.skeleton.setAllMeshesWorldLayer();
      this.animator.setSecondaryRagdollDecay(true);
      this.controller.getVelocity(this._deathImpulseDir);
      this.playerRagdoll.initializeFromSkeleton(this.skeleton, this._deathImpulseDir);
      this._deathImpulseDir
        .set(Math.sin(this.controller.aimYaw), 0.14, Math.cos(this.controller.aimYaw))
        .normalize();
      this.playerRagdoll.applyHitZoneImpulse('thorax', this._deathImpulseDir, 3.6);

      if (this.params.mode === 'battle' && this.botAI) {
        if (!this.mp) {
          this.botAI.recordPlayerDeath(attackerLabel, attackerTeam, attackerId);
        } else if (!attackerId || attackerId.startsWith('bot_')) {
          this.botAI.recordPlayerDeath(attackerLabel, attackerTeam, attackerId);
        }

        if (!this.playerRespawnEnabled) {
          this.livesRemaining = Math.max(0, this.livesRemaining - 1);
          if (this.livesRemaining <= 0) {
            this.spectating = true;
            this.respawnTimerSec = 0;
            this.showToast(`Eliminated by ${attackerLabel} · Spectating`, 4.0);
          } else {
            this.respawnTimerSec = 3.5;
            this.showToast(
              `Eliminated by ${attackerLabel} · ${this.livesRemaining} ${this.livesRemaining === 1 ? 'life' : 'lives'} left`,
              3.4,
            );
          }
        } else {
          this.respawnTimerSec = 3.5;
          this.showToast(`Eliminated by ${attackerLabel} — Respawning...`, 3.4);
        }
        this.checkBattleVictory();
      } else if (this.params.mode === 'infection') {
        const aliveTeammates = this.remotePlayers?.getAliveHumanTargets() ?? [];
        if (this.mp && aliveTeammates.length > 0) {
          this.spectating = true;
          this.showToast('Downed · Spectating squad — Reviving next round', 4.5);
          this.emitSnapshot();
          return;
        }
        this.triggerInfectionGameOver();
      }
    }
    this.emitSnapshot();
  }

  private triggerInfectionGameOver(): void {
    if (this.gameOver) return;
    this.gameOver = true;
    this.spectating = false;
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    if (!this.infectionRecordSaved && this.zombieAI) {
      this.infectionRecordSaved = true;
      this.saveManager.recordInfectionRun(
        this.map.id,
        this.zombieAI.round,
        this.playerKills,
        this.playerHeadshots,
      );
    }
    this.emitSnapshot();
  }

  private checkBattleVictory(): void {
    if (this.params.mode !== 'battle' || !this.botAI || this.matchOutcome !== 'active') return;
    const limit = this.params.battleConfig.killLimit;
    const totalA = this.botAI.scoreA + this.mpScoreA;
    const totalB = this.botAI.scoreB + this.mpScoreB;

    if (this.params.battleConfig.rule === 'tdm') {
      const myScore = this.localBattleTeam === 'B' ? totalB : totalA;
      const enemyScore = this.localBattleTeam === 'B' ? totalA : totalB;
      if (myScore >= limit) {
        this.matchOutcome = 'victory';
      } else if (enemyScore >= limit) {
        this.matchOutcome = 'defeat';
      }
    } else {
      const topBot = this.botAI.getTopFfaBotKills();
      const remoteTop = (this.remotePlayers?.getScoreEntries() ?? []).reduce(
        (acc, r) => (r.kills > acc.kills ? { name: r.name, kills: r.kills } : acc),
        { name: '—', kills: 0 },
      );
      const topOtherKills = Math.max(topBot.kills, remoteTop.kills);
      if (this.playerKills >= limit) {
        this.matchOutcome = 'victory';
      } else if (topOtherKills >= limit) {
        this.matchOutcome = 'defeat';
      }
    }

    if (this.matchOutcome !== 'active') {
      this.isFiring = false;
      if (document.pointerLockElement === this.renderer.domElement) {
        document.exitPointerLock();
      }
    }
  }

  private updateNearbyInteractable(): void {
    if (this.params.mode !== 'infection' || !this.playerAlive) {
      this.nearbyInteractable = null;
      return;
    }

    const p = this.controller.position;
    let best: MapInteractable | null = null;
    let bestDistSq = Infinity;

    for (let i = 0; i < this.map.interactables.length; i++) {
      const it = this.map.interactables[i];
      // Skip already opened doors, flipped power switch, or purchased perks
      if (it.activated && (it.kind === 'buyable_door' || it.kind === 'power_switch' || it.kind === 'perk_machine')) {
        continue;
      }
      const dx = it.position[0] - p.x;
      const dy = it.position[1] - (p.y + 1.1);
      const dz = it.position[2] - p.z;
      const dSq = dx * dx + dy * dy + dz * dz;
      const rSq = it.radiusM * it.radiusM;
      if (dSq <= rSq && dSq < bestDistSq) {
        bestDistSq = dSq;
        best = it;
      }
    }
    this.nearbyInteractable = best;
  }

  private buildNearbyPrompt(): NearbyInteractPrompt | null {
    const it = this.nearbyInteractable;
    if (!it) return null;

    if (it.kind === 'buyable_door') {
      return {
        id: it.id,
        kind: it.kind,
        label: it.label,
        actionText: `Clear Barricade · ${it.label}`,
        cost: it.cost,
        canAfford: this.points >= it.cost,
        blockedReason: this.points < it.cost ? 'Insufficient Points' : null,
      };
    }

    if (it.kind === 'power_switch') {
      return {
        id: it.id,
        kind: it.kind,
        label: it.label,
        actionText: 'Restore Main Theater Power',
        cost: 0,
        canAfford: true,
        blockedReason: null,
      };
    }

    if (it.kind === 'wall_buy' && it.weaponId) {
      const alreadyOwned = this.weaponSlots.includes(it.weaponId);
      const cost = alreadyOwned ? Math.round(it.cost * 0.5) : it.cost;
      return {
        id: it.id,
        kind: it.kind,
        label: it.label,
        actionText: alreadyOwned ? `Refill Ammo · ${it.label}` : `Buy ${it.label}`,
        cost,
        canAfford: this.points >= cost,
        blockedReason: this.points < cost ? 'Insufficient Points' : null,
      };
    }

    if (it.kind === 'mystery_crate') {
      return {
        id: it.id,
        kind: it.kind,
        label: it.label,
        actionText: 'Roll Mystery Weapon Crate',
        cost: it.cost,
        canAfford: this.points >= it.cost,
        blockedReason: this.points < it.cost ? 'Insufficient Points' : null,
      };
    }

    if (it.kind === 'perk_machine' && it.perkId) {
      if (it.requiresPower && !this.powerOn) {
        return {
          id: it.id,
          kind: it.kind,
          label: it.label,
          actionText: it.label,
          cost: it.cost,
          canAfford: false,
          blockedReason: 'Requires Main Theater Power',
        };
      }
      return {
        id: it.id,
        kind: it.kind,
        label: it.label,
        actionText: `Purchase ${it.label}`,
        cost: it.cost,
        canAfford: this.points >= it.cost,
        blockedReason: this.points < it.cost ? 'Insufficient Points' : null,
      };
    }

    return null;
  }

  private applyMapInteractableEffect(
    interactableId: string,
    triggeredBy?: string,
    silent = false,
  ): boolean {
    const it = this.map.interactables.find(
      (item) => item.id === interactableId || (interactableId === 'power_switch' && item.kind === 'power_switch'),
    );
    if (!it || it.activated) return false;

    if (it.kind === 'buyable_door') {
      it.activated = true;
      if (it.colliderIds) {
        for (const colId of it.colliderIds) {
          this.map.physics.disableBoxById(colId);
        }
      }
      if (it.visualGroup) {
        it.visualGroup.visible = false;
        // Remove door barrier meshes from raycast list so bullets shoot through opened doorway
        const groupSet = new Set<THREE.Object3D>();
        it.visualGroup.traverse((child) => groupSet.add(child));
        for (let i = this.map.raycastMeshes.length - 1; i >= 0; i--) {
          if (groupSet.has(this.map.raycastMeshes[i])) {
            this.map.raycastMeshes.splice(i, 1);
          }
        }
      }
      this.zombieAI?.unlockZoneAndDoor(it.id, it.unlocksZoneId);
      if (!silent) {
        this.audio.playGearRattle('weapon_swap', 0.9);
        this.showToast(
          triggeredBy ? `${triggeredBy} unlocked: ${it.label}` : `Unlocked: ${it.label}`,
          3.0,
        );
      }
      this.emitSnapshot();
      return true;
    }

    if (it.kind === 'power_switch') {
      it.activated = true;
      this.powerOn = true;
      this.map.setPowerState?.(true);
      if (!silent) {
        this.audio.playTacticalSwitchClick(true);
        this.showToast(
          triggeredBy
            ? `${triggeredBy} restored MAIN THEATER POWER — Perk Machines Online`
            : 'MAIN THEATER POWER RESTORED — Perk Machines Online',
          3.8,
        );
      }
      this.emitSnapshot();
      return true;
    }

    return false;
  }

  private triggerInteract(): void {
    const it = this.nearbyInteractable;
    if (!it || this.params.mode !== 'infection') return;

    if (it.kind === 'buyable_door') {
      if (this.points < it.cost) {
        this.showToast(`Need ${it.cost} PTS to clear ${it.label}`);
        return;
      }
      if (this.mp && !this.isMpHost) {
        // Any player can freely buy doors; Host silently validates to prevent double-spend races
        if (this.pendingMapInteractRequests.has(it.id)) return;
        this.points -= it.cost;
        const requestId = `${this.mp.localUserId}_${Date.now()}_${this.nextMapInteractReqSeq++}`;
        this.pendingMapInteractRequests.set(it.id, {
          requestId,
          interactableId: it.id,
          cost: it.cost,
          createdAtMs: performance.now(),
        });
        const reqPkt: GameMapInteractRequestPacket = {
          type: 'game:map_interact_request',
          kind: 'buyable_door',
          interactableId: it.id,
          cost: it.cost,
          requestId,
          ts: Date.now(),
        };
        this.mp.sendMessage(reqPkt as unknown as Record<string, unknown>);
        this.emitSnapshot();
        return;
      }

      this.points -= it.cost;
      if (this.applyMapInteractableEffect(it.id) && this.mp) {
        const pkt: GameMapInteractPacket = {
          type: 'game:map_interact',
          kind: 'buyable_door',
          interactableId: it.id,
          unlockedZoneId: it.unlocksZoneId,
          activatedByUserId: this.mp.localUserId,
          activatedByUsername: this.mp.localUsername,
          ts: Date.now(),
        };
        this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
        if (this.zombieAI) {
          this.mp.sendMessage(
            this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
          );
        }
      }
      return;
    }

    if (it.kind === 'power_switch') {
      if (this.mp && !this.isMpHost) {
        if (this.pendingMapInteractRequests.has(it.id)) return;
        const requestId = `${this.mp.localUserId}_${Date.now()}_${this.nextMapInteractReqSeq++}`;
        this.pendingMapInteractRequests.set(it.id, {
          requestId,
          interactableId: it.id,
          cost: 0,
          createdAtMs: performance.now(),
        });
        const reqPkt: GameMapInteractRequestPacket = {
          type: 'game:map_interact_request',
          kind: 'power_switch',
          interactableId: it.id,
          cost: 0,
          requestId,
          ts: Date.now(),
        };
        this.mp.sendMessage(reqPkt as unknown as Record<string, unknown>);
        return;
      }

      if (this.applyMapInteractableEffect(it.id) && this.mp) {
        const pkt: GameMapInteractPacket = {
          type: 'game:map_interact',
          kind: 'power_switch',
          interactableId: it.id,
          activatedByUserId: this.mp.localUserId,
          activatedByUsername: this.mp.localUsername,
          ts: Date.now(),
        };
        this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
        if (this.zombieAI) {
          this.mp.sendMessage(
            this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
          );
        }
      }
      return;
    }

    if (it.kind === 'wall_buy' && it.weaponId) {
      const alreadyOwned = this.weaponSlots.includes(it.weaponId);
      const cost = alreadyOwned ? Math.round(it.cost * 0.5) : it.cost;
      if (this.points < cost) {
        this.showToast(`Need ${cost} PTS`);
        return;
      }
      this.points -= cost;
      const prof = resolveWeaponProfile(it.weaponId);
      const derived = computeDerivedWeaponStats(
        prof.massKg,
        prof.barrelLengthM,
        prof.magCapacity,
        this.getAttachmentsFor(prof.id),
      );
      const fullReserve = derived.magCapacity * 5;

      if (alreadyOwned) {
        this.magAmmoByWeapon[prof.id] = derived.magCapacity;
        this.reserveAmmoByWeapon[prof.id] = fullReserve;
        if (this.equippedWeaponId === prof.id) {
          this.weaponRig.setAmmoState(derived.magCapacity);
        }
        this.audio.playGearRattle('weapon_swap', 0.65);
        this.showToast(`Ammo Refilled: ${prof.name}`);
      } else {
        this.grantInfectionWeapon(prof.id, fullReserve);
      }
      this.emitSnapshot();
      return;
    }

    if (it.kind === 'mystery_crate') {
      if (this.points < it.cost) {
        this.showToast(`Need ${it.cost} PTS for Mystery Crate`);
        return;
      }
      this.points -= it.cost;
      const candidates = GYM_ARMORY_WEAPONS.filter(
        (w) => !this.weaponSlots.includes(w.id) && w.magCapacity > 0,
      );
      const pool = candidates.length > 0 ? candidates : GYM_ARMORY_WEAPONS;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      const derived = computeDerivedWeaponStats(
        picked.massKg,
        picked.barrelLengthM,
        picked.magCapacity,
        this.getAttachmentsFor(picked.id),
      );
      this.grantInfectionWeapon(picked.id, derived.magCapacity * 5);
      this.showToast(`Mystery Crate: ${picked.name}`, 3.4);
      this.emitSnapshot();
      return;
    }

    if (it.kind === 'perk_machine' && it.perkId) {
      if (it.requiresPower && !this.powerOn) {
        this.showToast('Restore Theater Power First (Backstage)');
        return;
      }
      if (this.points < it.cost) {
        this.showToast(`Need ${it.cost} PTS for ${it.label}`);
        return;
      }
      this.points -= it.cost;
      it.activated = true;
      this.perks.add(it.perkId);
      if (it.perkId === 'vitality') {
        this.maxHp = 160;
        this.hp = 160;
        this.showToast('VITALITY RESERVE ACTIVE · Max Health 160', 3.4);
      } else if (it.perkId === 'rapid_handling') {
        this.syncRuntimeProfile();
        this.showToast('RAPID HANDLING ACTIVE · 1.6x Reload Speed', 3.4);
      }
      this.audio.playTacticalSwitchClick(true);
      this.emitSnapshot();
    }
  }

  private grantInfectionWeapon(weaponId: string, reserveAmmo: number): void {
    this.initWeaponAmmo(weaponId, reserveAmmo);
    if (this.weaponSlots.length < 2) {
      this.weaponSlots.push(weaponId);
      this.equipSlot(this.weaponSlots.length - 1, false);
    } else {
      const replaceIdx = this.activeSlotIndex >= 0 ? this.activeSlotIndex : 0;
      this.weaponSlots[replaceIdx] = weaponId;
      this.equipSlot(replaceIdx, false);
    }
  }

  private startReload(): void {
    if (!this.playerAlive || this.weaponRig.isSuppressorActionActive()) return;
    const prof = this._runtimeProfile;
    if (prof.magCapacity <= 0 || this.reloadTimer > 0 || this.controller.isVaulting()) return;
    const curMag = this.magAmmoByWeapon[prof.id] ?? 0;
    if (curMag >= prof.magCapacity) return;

    const reserve = this.reserveAmmoByWeapon[prof.id] ?? -1;
    if (reserve === 0) {
      this.showToast('No Reserve Ammo — Buy Ammo at Wall-Buy');
      return;
    }

    this.reloadTimer = prof.reloadDurationSec;
    this.animator.triggerReload(prof.reloadDurationSec);
    this.emitSnapshot();
  }

  private attemptFire(): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
    if (this.weaponRig.isSuppressorActionActive()) return;
    const prof = this._runtimeProfile;

    if (prof.holdClass === 'unarmed') {
      if (this.semiTriggerConsumed || this.controller.isVaulting()) return;
      const punch = this.animator.triggerUnarmedPunch(
        this.controller,
        this.input.ads && !this.controller.isSprinting,
      );
      if (punch) {
        this.semiTriggerConsumed = true;
        this.stamina = Math.max(0, this.stamina - 0.05);
      }
      return;
    }

    if (prof.fireMode === 'none' || prof.magCapacity <= 0) return;
    if (
      this.reloadTimer > 0 ||
      this.fireCooldown > 0 ||
      this.weaponRig.isBoltCycling() ||
      this.controller.isSprinting ||
      this.controller.isVaulting() ||
      this.animator.isCombatBusy()
    ) {
      return;
    }
    if (this.weaponRig.getReadOnlyRigState().pullbackRatio > 0.72) return;

    const isSingle = prof.fireMode === 'semi' || prof.fireMode === 'bolt' || prof.fireMode === 'pump';
    if (isSingle && this.semiTriggerConsumed) return;

    const curAmmo = this.magAmmoByWeapon[prof.id] ?? 0;
    if (curAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.startReload();
      return;
    }

    const remaining = curAmmo - 1;
    this.magAmmoByWeapon[prof.id] = remaining;
    this.fireCooldown = 60 / Math.max(25, prof.rpm);
    if (isSingle) this.semiTriggerConsumed = true;

    if (this.grenadeSystem.isDrawn()) return;
    const derived = this.weaponRig.getDerivedStats();
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
    const suppressed = derived.isSuppressed;
    this.weaponRig.cancelZoomTwist();

    this.weaponRig.getMuzzleWorldTransform(this._muzzlePos, this._muzzleDir, true);
    this.ballistics.spawnShot({
      origin: this._muzzlePos,
      direction: this._muzzleDir,
      ammo: activeAmmo,
      weaponId: prof.id,
      barrelVelocityMult: prof.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: derived.velocityMult,
      weaponSpreadMOA: prof.spreadMOA,
      audio: this.audio,
    });

    this.weaponRig.triggerFire(suppressed, remaining);
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
    this.adrenalineStress = Math.min(1, this.adrenalineStress + (suppressed ? 0.05 : 0.1));

    if (this.mp) {
      this.localFireSeq += 1;
      const firePkt: GamePlayerFirePacket = {
        type: 'game:fire',
        weaponId: prof.id,
        weaponName: prof.name,
        caliberId: activeAmmo.caliberId,
        suppressed,
        ox: Number(this._muzzlePos.x.toFixed(3)),
        oy: Number(this._muzzlePos.y.toFixed(3)),
        oz: Number(this._muzzlePos.z.toFixed(3)),
        dx: Number(this._muzzleDir.x.toFixed(4)),
        dy: Number(this._muzzleDir.y.toFixed(4)),
        dz: Number(this._muzzleDir.z.toFixed(4)),
        aimStance: this.controller.aimStance,
        adsMode: this.adsModeByWeapon[prof.id] ?? 'PRIMARY',
        shotSeq: this.localFireSeq,
        ts: Date.now(),
      };
      this.mp.sendMessage(firePkt as unknown as Record<string, unknown>);
    }
  }

  private toggleFlashlight(): void {
    if (!this.weaponRig.getDerivedStats().hasFlashlight) {
      this.showToast('Equip a Tactical Flashlight in Playground Gunsmith');
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.weaponRig.flashlight.visible = this.flashlightOn;
    this.weaponRig.flashlight.intensity = this.flashlightOn ? 32 : 0;
    this.audio.playTacticalSwitchClick(this.flashlightOn);
    this.emitSnapshot();
  }

  private toggleLaser(): void {
    if (!this.weaponRig.getDerivedStats().hasLaser) return;
    this.weaponRig.laserOn = !this.weaponRig.laserOn;
    this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
    this.emitSnapshot();
  }

  public toggleSuppressor(): void {
    if (
      !this.playerAlive ||
      this.gameOver ||
      this.matchOutcome !== 'active' ||
      this.controller.isVaulting() ||
      this.reloadTimer > 0
    ) {
      return;
    }
    const prof = this._runtimeProfile;
    if (prof.holdClass === 'unarmed') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    const weaponId = prof.id;
    const res = this.weaponRig.triggerFieldSuppressorToggle((nowAttached) => {
      if (this._runtimeProfile.id !== weaponId) return;
      const cur = this.getAttachmentsFor(weaponId);
      this.attachmentsByWeapon[weaponId] = normalizeWeaponAttachments(weaponId, {
        ...cur,
        suppressorStowed: nowAttached ? undefined : true,
      });
      this.syncRuntimeProfile();
      this.showToast(nowAttached ? 'Suppressor Attached' : 'Suppressor Stowed');
      this.emitSnapshot();
    });

    if (res === 'no_suppressor') {
      this.showToast('No Suppressor Equipped');
      return;
    }
    if (res === 'busy') return;

    this.isFiring = false;
    this.input.ads = false;
    this.showToast(res === 'started_attach' ? 'Attaching Suppressor...' : 'Stowing Suppressor...');
    this.emitSnapshot();
  }

  // --- Event Listeners ---

  private readonly onResize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postProcess.setSize(w, h);
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.isFiring = false;
      this.shiftHeld = false;
      this.altHeld = false;
      this.scoreboardOpen = false;
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
      if (this.grenadeSystem.isDrawn() && !this.grenadeSystem.isLeverReleased()) {
        this.grenadeSystem.cancelCook();
      }
    }
    this.emitSnapshot();
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked || !this.playerAlive) return;
    const dx = THREE.MathUtils.clamp(e.movementX, -140, 140);
    const dy = THREE.MathUtils.clamp(e.movementY, -140, 140);
    this.controller.handleMouseMove(dx, dy, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
    if (this.spectating && this.pointerLocked) {
      if (e.button === 0) {
        this.spectateTargetIdx += 1;
        this.emitSnapshot();
      }
      return;
    }
    if (!this.pointerLocked || !this.playerAlive) return;
    this.audio.ensureInitialized();

    // Authentic 4-stage grenade Manual of Arms when grenade is drawn
    if (this.grenadeSystem.isDrawn()) {
      if (e.button === 0 && this.grenadeSystem.getHoldStage() === 'DRAWN') {
        this.grenadeSystem.pullPin();
        this.emitSnapshot();
      } else if (e.button === 2 && this.grenadeSystem.getHoldStage() === 'PIN_PULLED') {
        this.grenadeSystem.releaseLever();
        this.emitSnapshot();
      }
      return;
    }

    if (e.button === 0) {
      this.isFiring = true;
      this.semiTriggerConsumed = false;
      this.attemptFire();
    } else if (e.button === 2) {
      this.input.ads = true;
    } else if (e.button === 1) {
      const prof = this._runtimeProfile;
      if (prof.holdClass === 'unarmed') return;
      const cur = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
      const next: AdsMode = cur === 'POINT_AIM' ? 'PRIMARY' : 'POINT_AIM';
      this.adsModeByWeapon[prof.id] = next;
      this.input.adsMode = next;
      this.audio.playGearRattle('weapon_swap', 0.4);
      this.showToast(next === 'POINT_AIM' ? 'Point Aim Armed (RMB)' : 'Primary Optic ADS (RMB)');
      this.emitSnapshot();
    }
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (this.grenadeSystem.isPinPulled()) {
        this.throwHeldGrenadeNow();
        return;
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
    if (this.pointerLocked && this.controller.isAds && this.weaponRig.hasVariableZoom()) {
      e.preventDefault();
      this.weaponRig.cycleOpticZoom(e.deltaY < 0 ? 1 : -1, true);
      this.emitSnapshot();
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'F1') {
      e.preventDefault();
      this.setTunerOpen(!this.tunerOpen);
      return;
    }

    if (e.code === 'Tab' && this.params.mode === 'battle' && this.pointerLocked) {
      e.preventDefault();
      if (!this.scoreboardOpen) {
        this.scoreboardOpen = true;
        this.emitSnapshot();
      }
      return;
    }

    if (this.spectating && e.code === 'Space' && this.pointerLocked) {
      e.preventDefault();
      this.spectateTargetIdx += 1;
      this.emitSnapshot();
      return;
    }

    if (!this.pointerLocked || !this.playerAlive) return;
    this.audio.ensureInitialized();

    switch (e.code) {
      case 'Digit1':
        this.equipSlot(0);
        break;
      case 'Digit2':
        this.equipSlot(1);
        break;
      case 'Digit4':
      case 'Digit5':
      case 'KeyH':
        if (!e.repeat) this.drawOrHolsterGrenade();
        break;
      case 'Digit0':
        this.equipSlot(-1);
        break;
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
        this.input.leanRight = true;
        break;
      case 'KeyF':
        if (!e.repeat) {
          if (this.params.mode === 'infection' && this.nearbyInteractable) {
            this.triggerInteract();
          } else {
            this.toggleFlashlight();
          }
        }
        break;
      case 'KeyT':
        if (!e.repeat) this.toggleFlashlight();
        break;
      case 'KeyL':
        if (!e.repeat) this.toggleLaser();
        break;
      case 'KeyR':
        if (!e.repeat) this.startReload();
        break;
      case 'KeyG':
        if (!e.repeat) this.toggleSuppressor();
        break;
      case 'KeyB':
        if (!e.repeat && this.weaponRig.hasCantedOptic()) {
          const id = this._runtimeProfile.id;
          const next: AdsMode = (this.adsModeByWeapon[id] ?? 'PRIMARY') === 'CANTED' ? 'PRIMARY' : 'CANTED';
          this.adsModeByWeapon[id] = next;
          this.input.adsMode = next;
          this.audio.playGearRattle('weapon_swap', 0.4);
          this.emitSnapshot();
        }
        break;
      case 'KeyN':
        if (!e.repeat) {
          this.weaponRig.toggleReticleIllumination();
          this.audio.playTacticalSwitchClick(true);
          this.emitSnapshot();
        }
        break;
      case 'KeyV':
        if (!e.repeat && !this.controller.isVaulting() && !this.weaponRig.isSuppressorActionActive()) {
          if (this._runtimeProfile.holdClass === 'unarmed') {
            this.animator.triggerUnarmedPunch(this.controller, false);
          } else if (this.animator.triggerArmedBash(this.controller, this._runtimeProfile.holdClass)) {
            this.reloadTimer = 0;
          }
        }
        break;
      case 'KeyX':
        if (!e.repeat && !this.weaponRig.isSuppressorActionActive()) {
          if (this.animator.triggerPushKick(this.controller, this.getActiveTraumaModifiers()) === 'ok') {
            this.reloadTimer = 0;
          }
        }
        break;
      case 'BracketRight':
        if (!e.repeat && this.controller.isAds && this.weaponRig.hasVariableZoom()) {
          this.weaponRig.cycleOpticZoom(1, true);
          this.emitSnapshot();
        }
        break;
      case 'BracketLeft':
        if (!e.repeat && this.controller.isAds && this.weaponRig.hasVariableZoom()) {
          this.weaponRig.cycleOpticZoom(-1, true);
          this.emitSnapshot();
        }
        break;
      case 'Space':
        e.preventDefault();
        this.input.vault = true;
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Tab' && this.scoreboardOpen) {
      this.scoreboardOpen = false;
      this.emitSnapshot();
      return;
    }
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
      const sync =
        typeof gl.fenceSync === 'function' ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
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
    if (this.fpsAccum >= 0.4) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastMessage = null;
    }
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer = Math.max(0, this.hitmarkerTimer - dt);
    }
    if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    }
    if (this.flashBlindAlpha > 0) {
      this.flashBlindAlpha = Math.max(0, this.flashBlindAlpha - dt * 0.42);
    }

    // Battle respawn countdown (only if not eliminated/spectating)
    if (
      this.params.mode === 'battle' &&
      !this.playerAlive &&
      !this.spectating &&
      this.matchOutcome === 'active'
    ) {
      this.respawnTimerSec -= dt;
      if (this.respawnTimerSec <= 0) {
        this.playerAlive = true;
        this.hp = this.maxHp;
        this.respawnTimerSec = 0;
        this.flashBlindAlpha = 0;
        this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
        this.syncBeltEquipmentMesh();
        for (const wId of this.weaponSlots) {
          this.initWeaponAmmo(wId, -1);
        }
        this.equipSlot(Math.max(0, this.activeSlotIndex), true);
        this.spawnPlayerAtStart();
        this.showToast('Respawned');
        if (this.mp) {
          const rspPkt: GamePlayerRespawnPacket = {
            type: 'game:respawn',
            x: Number(this.controller.position.x.toFixed(3)),
            y: Number(this.controller.position.y.toFixed(3)),
            z: Number(this.controller.position.z.toFixed(3)),
            yaw: Number(this.controller.aimYaw.toFixed(4)),
            hp: this.maxHp,
            maxHp: this.maxHp,
            uniformId: this.localUniformId,
            operatorId: this.localOperatorId,
            ts: Date.now(),
          };
          this.mp.sendMessage(rspPkt as unknown as Record<string, unknown>);
        }
      }
    }

    // Tactical health regeneration after 4.2s out of combat
    this.timeSinceDamageSec += dt;
    if (this.playerAlive && this.hp < this.maxHp && this.timeSinceDamageSec >= 4.2) {
      this.hp = Math.min(this.maxHp, this.hp + dt * 24);
    }

    const prof = this._runtimeProfile;
    const derived = this.weaponRig.getDerivedStats();
    Object.assign(this._runtimeConfig, this.config);
    this._runtimeConfig.adsHFovDeg = derived.isMagnifiedOptic
      ? this.config.adsHFovDeg * 0.94
      : this.config.adsHFovDeg / Math.max(1.0, derived.adsZoomFactor);

    // Reload timer completion
    if (this.reloadTimer > 0 && this.playerAlive) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        const curMag = this.magAmmoByWeapon[prof.id] ?? 0;
        const needed = Math.max(0, prof.magCapacity - curMag);
        const reserve = this.reserveAmmoByWeapon[prof.id] ?? -1;
        if (reserve < 0) {
          this.magAmmoByWeapon[prof.id] = prof.magCapacity;
        } else {
          const take = Math.min(needed, reserve);
          this.magAmmoByWeapon[prof.id] = curMag + take;
          this.reserveAmmoByWeapon[prof.id] = reserve - take;
        }
        this.weaponRig.setAmmoState(this.magAmmoByWeapon[prof.id]);
      }
    }

    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    }
    if (this.isFiring && this.pointerLocked && this.playerAlive) {
      this.attemptFire();
    }

    if (!this.controller.isSprinting) {
      this.stamina = Math.min(1.0, this.stamina + dt * 0.24);
    }

    const suppBusy = this.weaponRig.isSuppressorActionActive();
    if (suppBusy) {
      this.input.ads = false;
    }
    this.input.adsMode = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
    this.input.sprint = !suppBusy && this.shiftHeld && !this.input.ads;
    this.input.holdBreath = !suppBusy && this.input.ads && (this.shiftHeld || this.altHeld);

    // In multiplayer, world stays live continuously even when Esc pause overlay is open
    const simActive =
      (this.mp ? true : this.pointerLocked && !this.tunerOpen) &&
      !this.gameOver &&
      this.matchOutcome === 'active';

    // Step player controller & IK animator
    if (this.playerAlive) {
      this.controller.update(
        dt,
        this.elapsedSec,
        this.input,
        this.adapter,
        prof,
        this._runtimeConfig,
        this.stamina,
        this.hp,
        (drain) => {
          this.stamina = Math.max(0, this.stamina - drain);
        },
      );
      this.animator.update(dt, this.elapsedSec, this.controller, this.adapter, prof, this.input.ads);
      this.animator.applyCameraAdditiveOverlay(this.camera);
    } else {
      if (this.playerRagdoll.isActive()) {
        this.playerRagdoll.step(dt, this.map.physics, this.map.terrainHeightAt);
        this.playerRagdoll.syncToSkeleton(this.skeleton);
      }
      if (this.spectating && this.remotePlayers) {
        const targets = this.remotePlayers.getAliveSpectateTargets();
        if (targets.length > 0) {
          const t = targets[this.spectateTargetIdx % targets.length];
          this.spectatingTargetName = t.username;
          const backX = Math.sin(t.yaw) * 2.6;
          const backZ = Math.cos(t.yaw) * 2.6;
          this.camera.position.set(t.pos.x + backX, t.pos.y + 2.15, t.pos.z + backZ);
          this.camera.lookAt(t.pos.x, t.pos.y + 1.45, t.pos.z);
        } else {
          this.spectatingTargetName = null;
        }
      } else if (this.playerRagdoll.isActive()) {
        this.playerRagdoll.getNodePosition(0, this._ragdollPelvisWorld);
        this.playerRagdoll.getNodePosition(2, this._ragdollHeadWorld);
        this.camera.position.lerp(
          this._ragdollHeadWorld.set(
            this._ragdollHeadWorld.x + Math.sin(this.controller.aimYaw) * 0.9,
            this._ragdollHeadWorld.y + 0.62,
            this._ragdollHeadWorld.z + Math.cos(this.controller.aimYaw) * 0.9,
          ),
          1 - Math.exp(-5.0 * dt),
        );
        this.camera.lookAt(this._ragdollPelvisWorld);
      }
    }

    this.weaponRig.root.visible = this.playerAlive && !this.grenadeSystem.isDrawn();
    this.skeleton.root.visible = this.playerAlive || this.playerRagdoll.isActive();

    // Step drift-free 20 Hz multiplayer broadcast (+ immediate flush on stance/fire/reload transitions)
    if (this.mp && this.remotePlayers) {
      this.netSendAccum += dt;
      const nowPerf = performance.now();
      const stanceChanged = this.controller.aimStance !== this.lastSentStance;
      const firingChanged = this.isLocallyActivelyFiring() !== this.lastSentFiring;
      const reloadChanged = (this.reloadTimer > 0) !== this.lastSentReloading;
      const urgentTransition =
        (stanceChanged || firingChanged || reloadChanged) &&
        nowPerf - this.lastImmediateStateFlushMs >= 16;

      if (this.netSendAccum >= 0.05 || urgentTransition) {
        if (this.netSendAccum >= 0.05) {
          this.netSendAccum = Math.min(this.netSendAccum - 0.05, 0.05);
        } else {
          this.netSendAccum = 0;
          this.lastImmediateStateFlushMs = nowPerf;
        }
        this.broadcastLocalState20Hz();
      }

      // Refund any stale non-host door/power request if Host dropped before confirming
      if (this.pendingMapInteractRequests.size > 0) {
        let refundedAny = false;
        for (const [key, req] of this.pendingMapInteractRequests.entries()) {
          if (nowPerf - req.createdAtMs > 3500) {
            this.pendingMapInteractRequests.delete(key);
            if (req.cost > 0) {
              this.points += req.cost;
              refundedAny = true;
            }
          }
        }
        if (refundedAny) {
          this.showToast('Interaction timed out · Points refunded', 2.8);
          this.emitSnapshot();
        }
      }

      this.remotePlayers.update(dt, this.camera.position);
    }

    // Step map animated fixtures (flickering Pripyat fluorescents, theater beams)
    this.map.update?.(dt, this.elapsedSec);

    // Step BallisticsSolver & Tactical Grenade Physics
    this.ballistics.update(dt, this.adapter, (ev) => this.handleBallisticImpact(ev));
    this._grenadeThrowOrigin.set(
      this.controller.position.x,
      this.controller.position.y + 1.28,
      this.controller.position.z,
    );
    const wasLiveBefore = this.grenadeSystem.isLeverReleased();
    this.grenadeSystem.update(dt, this._grenadeThrowOrigin);
    if (wasLiveBefore && !this.grenadeSystem.isLeverReleased()) {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
    }

    // Step active AI system (strictly separated, Host-authoritative in multiplayer!)
    if (simActive) {
      const localId = this.mp?.localUserId ?? 'player';
      const remoteHumans = this.remotePlayers?.getAliveHumanTargets() ?? [];

      if (this.botAI) {
        const battleHumans: BattleHumanTarget[] = [
          {
            id: localId,
            name: this.mp?.localUsername ?? 'YOU',
            team: this.localBattleTeam,
            pos: this.controller.position,
            alive: this.playerAlive,
          },
          ...remoteHumans,
        ];

        this.botAI.update(
          dt,
          this.controller.position,
          this.playerAlive,
          true,
          (dmgEv) => {
            if (dmgEv.targetUserId === localId || dmgEv.targetUserId === 'player') {
              this.applyPlayerDamage(
                dmgEv.damage,
                dmgEv.attackerName,
                dmgEv.attackerTeam,
                dmgEv.attackerId,
              );
            } else if (this.mp && this.isMpHost) {
              const hitPkt: GameBotHitPlayerPacket = {
                type: 'game:bot_hit_player',
                targetUserId: dmgEv.targetUserId,
                damage: Math.round(dmgEv.damage),
                botId: dmgEv.attackerId,
                botName: dmgEv.attackerName,
                botTeam: dmgEv.attackerTeam,
                ts: Date.now(),
              };
              this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
            }
          },
          battleHumans,
          this.mp && this.isMpHost
            ? (botId, origin, end) => {
                const firePkt: GameBotFirePacket = {
                  type: 'game:bot_fire',
                  botId,
                  ox: Number(origin.x.toFixed(3)),
                  oy: Number(origin.y.toFixed(3)),
                  oz: Number(origin.z.toFixed(3)),
                  ex: Number(end.x.toFixed(3)),
                  ey: Number(end.y.toFixed(3)),
                  ez: Number(end.z.toFixed(3)),
                  ts: Date.now(),
                };
                this.mp!.sendMessage(firePkt as unknown as Record<string, unknown>);
              }
            : undefined,
          (a, b) => this.grenadeSystem.isLineBlockedBySmoke(a, b),
          () => this.grenadeSystem.getActiveSmokeClouds(),
        );
        this.checkBattleVictory();
      } else if (this.zombieAI) {
        const infectionHumans: InfectionHumanTarget[] = [
          { id: localId, pos: this.controller.position, alive: this.playerAlive },
          ...remoteHumans.map((r) => ({ id: r.id, pos: r.pos, alive: r.alive })),
        ];

        // Check full squad wipe when local player is spectating in Co-op Infection
        if (this.mp && this.spectating && !this.playerAlive && remoteHumans.length === 0) {
          this.triggerInfectionGameOver();
        }

        this.zombieAI.update(
          dt,
          this.controller.position,
          this.playerAlive,
          (dmg, _attackerPos, targetUserId) => {
            if (!targetUserId || targetUserId === localId || targetUserId === 'player') {
              this.applyPlayerDamage(dmg, 'INFECTED');
            } else if (this.mp && this.isMpHost) {
              const hitPkt: GameZombieHitPlayerPacket = {
                type: 'game:zombie_hit_player',
                targetUserId,
                damage: Math.round(dmg),
                ts: Date.now(),
              };
              this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
            }
          },
          (completedRound, bonus) => {
            this.addPoints(bonus, `ROUND ${completedRound} BONUS`);
            this.replenishInfectionRoundGrenade();
            this.showToast(`Round ${completedRound} Cleared · +${bonus} PTS · +1 Grenade`, 3.4);
            if (this.spectating && !this.playerAlive && !this.gameOver) {
              this.reviveCoopInfectionPlayer(completedRound + 1);
            }
            if (this.mp && this.isMpHost) {
              const roundPkt: GameRoundCompletePacket = {
                type: 'game:round_complete',
                completedRound,
                bonusPoints: bonus,
                ts: Date.now(),
              };
              this.mp.sendMessage(roundPkt as unknown as Record<string, unknown>);
            }
          },
          infectionHumans,
          this.mp && this.isMpHost
            ? (spawnPkt) => {
                this.mp!.sendMessage(spawnPkt as unknown as Record<string, unknown>);
              }
            : undefined,
        );
      }

      // Host drift-free 20 Hz authoritative AI Bot / Zombie + Kino door/zone state broadcast
      if (this.mp && this.isMpHost) {
        this.aiSyncAccum += dt;
        if (this.aiSyncAccum >= 0.05) {
          this.aiSyncAccum = Math.min(this.aiSyncAccum - 0.05, 0.05);
          if (this.botAI) {
            this.mp.sendMessage(
              this.botAI.exportSyncSnapshot() as unknown as Record<string, unknown>,
            );
          } else if (this.zombieAI) {
            this.mp.sendMessage(
              this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
            );
          }
        }
      }
    }

    // Update nearby interactable in Infection
    this.updateNearbyInteractable();

    // Post-process & render
    this.controller.getWhipVelocity(this._whipVel);
    this.postProcess.update(
      dt,
      this.elapsedSec,
      this._runtimeConfig,
      this._whipVel.x,
      this._whipVel.y,
      (this.hp / this.maxHp) * 100,
      false,
      this.getActiveTraumaModifiers(),
      this.controller.getHoldBreathVignette(),
    );

    if (!this.contextLost) {
      this._scopePassParams.dt = dt;
      this.postProcess.render();
    }

    // Telemetry & physiological ECG heart rate
    this.controller.writeTelemetry(
      this.telemetry,
      this.postProcess.getAverageLuminance(),
      this.postProcess.getCurrentExposure(),
      this.flashlightOn,
    );

    this.adrenalineStress = Math.max(0, this.adrenalineStress - 0.14 * dt);
    const lowHpStress = THREE.MathUtils.clamp((1 - this.hp / this.maxHp) * 0.8, 0, 0.8);
    const respHz = 0.22 + this.telemetry.exertion * 0.4 + this.adrenalineStress * 0.25;
    this.rsaPhase = (this.rsaPhase + dt * respHz * Math.PI * 2) % (Math.PI * 2);
    const targetBpm = THREE.MathUtils.clamp(
      82 +
        (this.controller.isSprinting ? 28 : this.telemetry.speedMps > 0.3 ? 10 : 0) +
        this.adrenalineStress * 36 +
        lowHpStress * 42 +
        Math.sin(this.rsaPhase) * 1.4,
      68,
      188,
    );
    this.heartRateBpm = THREE.MathUtils.damp(this.heartRateBpm, targetBpm, 0.45, dt);
    this.heartStress = THREE.MathUtils.damp(
      this.heartStress,
      THREE.MathUtils.clamp((this.heartRateBpm - 84) / 90, 0, 1),
      1.6,
      dt,
    );

    this.uiEmitTimer += dt;
    if (this.uiEmitTimer >= 0.065) {
      this.uiEmitTimer = 0;
      this.emitSnapshot();
    }

    this.scheduleNextFrame();
  }

  private buildSnapshot(): CombatSessionSnapshot {
    const prof = this._runtimeProfile;
    const derived = this.weaponRig.getDerivedStats();
    const now = performance.now();
    const topFfa = this.botAI?.getTopFfaBotKills() ?? { name: '—', kills: 0 };
    const remoteScores = this.remotePlayers?.getScoreEntries() ?? [];

    // Merge local player + remote human operators + AI bots cleanly on scoreboard
    const botBoard =
      this.botAI?.getScoreboard(this.playerKills, this.playerDeaths, this.playerAlive) ?? [];
    const mergedScoreboard: BattleScoreEntry[] = this.mp
      ? [
          ...botBoard.map((row) =>
            row.isPlayer
              ? {
                  ...row,
                  name: this.mp!.localUsername,
                  team: this.localBattleTeam,
                }
              : row,
          ),
          ...remoteScores,
        ].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      : botBoard;

    const mergedKillfeed = [...this.mpKillfeed, ...(this.botAI?.getKillfeed() ?? [])]
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, 6);

    let ffaLeaderName = this.playerKills >= topFfa.kills ? 'YOU' : topFfa.name;
    let ffaLeaderKills = Math.max(this.playerKills, topFfa.kills);
    for (const r of remoteScores) {
      if (r.kills > ffaLeaderKills) {
        ffaLeaderKills = r.kills;
        ffaLeaderName = r.name;
      }
    }

    return {
      mode: this.params.mode,
      mapId: this.map.id,
      mapName: this.map.name,
      config: { ...this.config },
      telemetry: { ...this.telemetry },
      pointerLocked: this.pointerLocked,
      tunerOpen: this.tunerOpen,
      scoreboardOpen: this.scoreboardOpen,

      hp: Math.round(this.hp),
      maxHp: this.maxHp,
      playerAlive: this.playerAlive,
      isRegenerating: this.playerAlive && this.hp < this.maxHp && this.timeSinceDamageSec >= 4.2,
      damageFlash: this.damageFlash,
      heartRateBpm: Math.round(this.heartRateBpm),
      heartStress: this.heartStress,
      holdBreathActive: this.controller.isHoldBreathActive(),

      hitmarkerActive: this.hitmarkerTimer > 0,
      hitmarkerHeadshot: this.hitmarkerHeadshot,
      hitmarkerKill: this.hitmarkerKill,

      equippedWeaponId: prof.id,
      equippedWeaponName: prof.name,
      equippedCaliber: prof.caliberLabel,
      activeSlotIndex: this.activeSlotIndex,
      weaponSlots: this.weaponSlots.map((id) => ({ id, name: resolveWeaponProfile(id).name })),
      ammoInMag: this.magAmmoByWeapon[prof.id] ?? 0,
      magCapacity: prof.magCapacity,
      reserveAmmo: this.reserveAmmoByWeapon[prof.id] ?? -1,
      isReloading: this.reloadTimer > 0,
      armedAdsMode: this.adsModeByWeapon[prof.id] ?? 'PRIMARY',
      hasCantedOptic: this.weaponRig.hasCantedOptic(),
      isMagnifiedOptic: this.weaponRig.isMagnifiedOpticActive(),
      hasVariableZoom: this.weaponRig.hasVariableZoom(),
      activeOpticZoom: this.weaponRig.getActiveOpticZoomMult(),
      reticleIlluminated: this.weaponRig.reticleIlluminated,
      laserOn: this.weaponRig.laserOn && derived.hasLaser,
      flashlightOn: this.flashlightOn && derived.hasFlashlight,

      battleRule: this.params.mode === 'battle' ? this.params.battleConfig.rule : 'tdm',
      killLimit: this.params.mode === 'battle' ? this.params.battleConfig.killLimit : 0,
      scoreA: (this.botAI?.scoreA ?? 0) + this.mpScoreA,
      scoreB: (this.botAI?.scoreB ?? 0) + this.mpScoreB,
      playerKills: this.playerKills,
      playerDeaths: this.playerDeaths,
      playerHeadshots: this.playerHeadshots,
      weaponKills: { ...this.weaponKills },
      ffaLeaderName,
      ffaLeaderKills,
      respawnTimerSec: Math.max(0, this.respawnTimerSec),
      matchOutcome: this.matchOutcome,
      killfeed: mergedKillfeed,
      scoreboard: mergedScoreboard,

      roundState: this.zombieAI?.getRoundState() ?? {
        round: 1,
        zombiesRemaining: 0,
        activeCount: 0,
        intermissionSec: 0,
        roundBannerSec: 0,
      },
      points: this.points,
      pointsPopups: this.pointsPopups.filter((p) => now - p.timestampMs < 1400),
      powerOn: this.powerOn,
      perks: Array.from(this.perks),
      nearbyPrompt: this.buildNearbyPrompt(),
      gameOver: this.gameOver,

      tacticalEquipmentId: this.tacticalEquipmentId,
      tacticalEquipmentName: getTacticalEquipmentDef(this.tacticalEquipmentId).name,
      tacticalEquipmentShortName: getTacticalEquipmentDef(this.tacticalEquipmentId).shortName,
      tacticalBeltSlot: this.tacticalBeltSlot,
      tacticalMountOnBelt: this.tacticalMountOnBelt,
      grenadeCount: this.grenadeCount,
      grenadeMax: getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry,
      grenadeHoldStage: this.grenadeSystem.getHoldStage(),
      grenadeCooking: this.grenadeSystem.isCooking(),
      grenadeCookRatio: this.grenadeSystem.getCookRatio(),
      flashBlindAlpha: this.flashBlindAlpha,
      zeroDistanceM: this.weaponRig.getZeroDistanceM(),
      zeroElevationMrad: this.weaponRig.getZeroElevationMrad(),

      toastMessage: this.toastMessage,
      recordingElapsedSec: this.recordingElapsedSec,
      fps: this.fps,
      isMultiplayer: Boolean(this.mp),
      spectating: this.spectating,
      spectatingTargetName: this.spectatingTargetName,
      livesRemaining: this.livesRemaining,
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
    this.unsubMpMessages?.();
    this.unsubMpMessages = null;
    this.unsubTacticalEquipment?.();
    this.unsubTacticalEquipment = null;
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.remotePlayers?.dispose();
    this.botAI?.dispose();
    this.zombieAI?.dispose();
    this.grenadeSystem.dispose();
    this.ballistics.dispose();
    this.scopeRenderer.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
    this.postProcess.dispose();
    this.map.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }
}

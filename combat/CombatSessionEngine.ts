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
  createPdaMotionState,
  createRaycastResult,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  GrenadeDetonationEvent,
  GrenadeHoldStage,
  GrenadeThrowStyle,
  GYM_ARMORY_WEAPONS,
  IBodycamWorldAdapter,
  IR_LAYER,
  LENS_PRESETS,
  NvgMountId,
  operatorAssetLoader,
  OperatorGearConfig,
  OperatorId,
  operatorSelectionStore,
  PdaAllyMarker,
  PdaPingMarker,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  solveZeroPitchRad,
  tacticalEquipmentStore,
  TacticalGrenadeSystem,
  TacticalPdaDevice,
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
  computeBeltGrenadeDetonationChance,
  getTacticalEquipmentDef,
  isTacticalEquipmentId,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { getGraphicsQualityProfile, graphicsQualityStore } from '../data/graphicsQuality';
import { killfeedPreferenceStore } from '../data/killfeedSettings';
import { loadoutStore } from '../data/loadoutStore';
import { CombatantMatchStats } from '../data/progression';
import { SaveManager } from '../engine/persistence/SaveManager';
import { WeatherTimeSystem } from '../engine/world/WeatherTimeSystem';
import { getMapDefinitionById } from '../maps/MapRegistry';
import {
  BattleMatchConfig,
  BuiltMapInstance,
  InfectionMatchConfig,
  InfectionPerkId,
  MapInteractable,
} from '../maps/types';
import {
  DoorInteractOption,
  DoorInteractOptionId,
} from '../doors/DestructibleDoorSystem';
import { PlayerInteractAnimator } from '../doors/PlayerInteractAnimator';
import {
  GameBarrierRepairRequestPacket,
  GameBarrierUpdatePacket,
  GameBotCommsPacket,
  GameBotDamagePacket,
  GameBotFirePacket,
  GameBotHitPlayerPacket,
  GameBotsSyncPacket,
  GameDoorActionPacket,
  GameEnvSyncPacket,
  GameGlassShatterPacket,
  GameGrenadeEventKind,
  GameGrenadeEventPacket,
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
  GameTacticalPingPacket,
  GameZombieDamagePacket,
  GameZombieHitPlayerPacket,
  GameZombieKilledPacket,
  GameZombieSpawnPacket,
  GameZombiesSyncPacket,
  LobbyMember,
  OperatorUniformId,
  packSyncedWeaponAttachments,
  resolveOperatorUniformId,
  SpecialEventConfig,
  SquadCommsCategory,
  SyncedAimStance,
  SyncedHandlingAction,
  TacticalPingKind,
  TacticalPingTargetType,
} from '../data/multiplayer';
import {
  BattleBotAI,
  BattleHumanTarget,
  BattleKillfeedEntry,
  BattleScoreEntry,
  BattleTeamId,
  BotCommsEvent,
  BotGrenadeEvent,
  InfectionBotStatusSummary,
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

export interface SquadCommsMessage {
  id: number;
  callsign: string;
  category: SquadCommsCategory;
  text: string;
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
  isHoldAction?: boolean;
  holdProgress?: number;
  planksRemaining?: number;
  maxPlanks?: number;
}

export interface CombatDoorPromptState {
  key: 'F';
  targetLabel: string;
  options: DoorInteractOption[];
  selectedIndex: number;
}

export interface ProjectedTacticalPing {
  id: string;
  kind: TacticalPingKind;
  label: string;
  senderName: string;
  isLocal: boolean;
  screenX: number; // 0..100 viewport %
  screenY: number; // 0..100 viewport %
  offscreen: boolean;
  distanceM: number;
  opacity: number; // 0..1 distance-faded + expiry-faded
  scale: number; // 0.72..1.05
  ageRatio: number; // 0..1
}

interface ActiveTacticalPing {
  id: string;
  senderId: string;
  senderName: string;
  isLocal: boolean;
  kind: TacticalPingKind;
  label: string;
  worldPos: THREE.Vector3;
  targetEntityType: TacticalPingTargetType | null;
  targetEntityId: string | null;
  ageSec: number;
  durationSec: number;
  lostTargetTimer: number;
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
  playerAssists: number;
  playerGrenadeKills: number;
  playerMeleeKills: number;
  playerDamageDealt: number;
  playerAfkSeconds: number;
  matchDurationSec: number;
  weaponKills: Record<string, number>;
  ffaLeaderName: string;
  ffaLeaderKills: number;
  respawnTimerSec: number;
  matchOutcome: 'active' | 'victory' | 'defeat';
  killfeed: BattleKillfeedEntry[];
  scoreboard: BattleScoreEntry[];
  combatants: CombatantMatchStats[];

  // Infection-specific state
  roundState: ZombieRoundState;
  points: number;
  pointsPopups: PointsPopup[];
  powerOn: boolean;
  perks: InfectionPerkId[];
  nearbyPrompt: NearbyInteractPrompt | null;
  friendlyBotsAlive: number;
  friendlyBotsTotal: number;
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
  grenadeStatusLabel: string;
  grenadeThrowStyle: GrenadeThrowStyle;
  grenadeThrowHeld: boolean;
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
  tacticalPings: ProjectedTacticalPing[];

  // Weather, 5x Time-of-Day & 3D PDA
  supportsDynamicWeatherTime: boolean;
  gameClockText: string;
  weatherLabel: string;
  windSpeedMps: number;
  isPdaOpen: boolean;

  // Squad Radio Comms & Infection Bot Economy Telemetry
  squadComms: SquadCommsMessage[];
  infectionSquadBots: InfectionBotStatusSummary[];

  // Helmet-Mounted Night Vision & IR Illuminator
  nvgMount: NvgMountId;
  nvgActive: boolean;
  irIlluminatorOn: boolean;

  // Unified [F] + Mouse Scroll Physical Door Interaction Prompt
  doorInteractReticle: 'hidden' | 'near' | 'ready';
  doorPrompt: CombatDoorPromptState | null;
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
  private readonly pdaDevice: TacticalPdaDevice;
  private readonly interactAnimator = new PlayerInteractAnimator();
  private activeDoorId: string | null = null;
  private activeDoorPrompt: CombatDoorPromptState | null = null;
  private doorSelectedOptionIndex = 0;
  private doorReticleState: 'hidden' | 'near' | 'ready' = 'hidden';
  private lastKickHandlingTimer = 0;
  private readonly _doorRaycaster = new THREE.Raycaster();
  private readonly _doorCamPos = new THREE.Vector3();
  private readonly _doorCamDir = new THREE.Vector3();
  private readonly _doorIkPos = new THREE.Vector3();
  private readonly _doorVelScratch = new THREE.Vector3();
  private readonly _doorOcclHit: BodycamRaycastResult = createRaycastResult();
  private readonly weatherTime: WeatherTimeSystem | null = null;
  private envSyncAccum = 0;
  private readonly _pdaAllyBuf: PdaAllyMarker[] = [];
  private readonly _pdaPingBuf: PdaPingMarker[] = [];
  private unsubTacticalEquipment: (() => void) | null = null;
  private tacticalEquipmentId: TacticalEquipmentId;
  private tacticalBeltSlot: TacticalBeltSlot;
  private tacticalMountOnBelt: boolean;
  private grenadeCount: number;
  private flashBlindAlpha = 0;

  private readonly botAI: BattleBotAI | null = null;
  private readonly zombieAI: InfectionZombieAI | null = null;
  private squadComms: SquadCommsMessage[] = [];
  private nextSquadCommsId = 1;
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
  private lastSentHandlingAction: SyncedHandlingAction = 'NONE';
  private lastSentGrenadeStage: GrenadeHoldStage = 'HOLSTERED';
  private lastSentGrenadeThrowHeld = false;
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
  private readonly _meleeSphereRight = new THREE.Vector3();
  private readonly _meleeSphereUp = new THREE.Vector3();
  private readonly _meleeSphereOrigin = new THREE.Vector3();
  private readonly _meleeSphereWorldUp = new THREE.Vector3(0, 1, 0);
  private readonly _meleeSphereFallbackRight = new THREE.Vector3(1, 0, 0);
  private readonly _meleeSphereScratch: BodycamRaycastResult = createRaycastResult();
  private readonly _remoteWallRayScratch: BodycamRaycastResult = createRaycastResult();
  private readonly _localBeltGrenadePos = new THREE.Vector3();
  private worldOnlyRaycastFn:
    | ((
        origin: Readonly<THREE.Vector3>,
        dir: Readonly<THREE.Vector3>,
        near: number,
        far: number,
      ) => number)
    | null = null;

  private config: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly _runtimeConfig: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly telemetry: BodycamTelemetry = createBodycamTelemetry();
  private readonly _pdaMotionScratch = createPdaMotionState();
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
  private localGear: OperatorGearConfig;
  private readonly irIlluminatorLight: THREE.SpotLight;
  private readonly irIlluminatorTarget = new THREE.Object3D();
  private nvgFlipped = false;
  private irIlluminatorOn = false;
  private unsubOperatorGear: (() => void) | null = null;

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
  private playerAssists = 0;
  private playerGrenadeKills = 0;
  private playerMeleeKills = 0;
  private playerDamageDealt = 0;
  private playerAfkSeconds = 0;
  private matchDurationSec = 0;
  private idleSinceInputSec = 0;
  private readonly localRecentAttackers = new Map<string, number>();
  private readonly zombieRecentAttackers = new Map<string, Map<string, number>>();
  private readonly remoteRecentAttackers = new Map<string, Map<string, number>>();
  private weaponKills: Record<string, number> = {};
  private matchOutcome: 'active' | 'victory' | 'defeat' = 'active';
  private gameOver = false;
  private infectionRecordSaved = false;

  // Infection economy, stations & hold-F window barrier repair
  private points = 500;
  private powerOn = false;
  private readonly perks = new Set<InfectionPerkId>();
  private readonly pointsPopups: PointsPopup[] = [];
  private nextPopupId = 1;
  private nearbyInteractable: MapInteractable | null = null;
  private interactKeyHeld = false;
  private repairingBarrierId: string | null = null;
  private barrierRepairProgress = 0;
  private barrierRepairPendingRequest = false;
  private barrierRepairReqSentAtMs = 0;
  private readonly _tmpBarrierPos = new THREE.Vector3();

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
  private readonly _pingRaycaster = new THREE.Raycaster();
  private readonly _pingCenterNdc = new THREE.Vector2(0, 0);
  private readonly _pingHits: THREE.Intersection[] = [];
  private readonly _pingProjVec = new THREE.Vector3();
  private readonly _pingCamFwd = new THREE.Vector3();
  private readonly _pingToTarget = new THREE.Vector3();
  private readonly _pingRayOrigin = new THREE.Vector3();
  private readonly _pingRayDir = new THREE.Vector3();
  private readonly _pingTrackPos = new THREE.Vector3();
  private readonly activePings: ActiveTacticalPing[] = [];
  private projectedPings: ProjectedTacticalPing[] = [];
  private pingCooldownSec = 0;
  private nextLocalPingSeq = 1;
  private readonly _traumaMods: BodycamTraumaModifiers = { ...DEFAULT_TRAUMA_MODIFIERS };
  private readonly _runtimeProfile: BodycamWeaponProfile;
  private readonly _scopePassParams: ScopePassParams;

  constructor(container: HTMLElement, params: CombatSessionParams) {
    this.container = container;
    this.params = params;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    const activeQuality = graphicsQualityStore.getQuality();
    const qProfile = getGraphicsQualityProfile(activeQuality);
    this.config.graphicsQuality = activeQuality;
    this.config.showKillfeed = killfeedPreferenceStore.getEnabled();

    this.renderer = new THREE.WebGLRenderer({
      antialias: qProfile.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });

    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.isSoftwareGl = /swiftshader|llvmpipe|software/i.test(glRenderer);

    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, qProfile.maxDpr),
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && qProfile.castShadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Near plane >= 0.08m improves depth-buffer precision & prevents z-fighting across large open valleys
    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.08, 360);
    this.scene.add(this.camera);

    // Resolve and build selected map with selected Graphics Quality tier
    const mapId =
      params.mode === 'battle' ? params.battleConfig.mapId : params.infectionConfig.mapId;
    const mapDef = getMapDefinitionById(mapId) ?? getMapDefinitionById('pripyat_block')!;
    this.map = mapDef.build(this.scene, this.renderer, this.isSoftwareGl, activeQuality);

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

    // Build unified world adapter combining static map geometry, optional rolling terrain, and dynamic actors
    // (created before AI so BattleBotAI receives the live adapter for real vaulting/climbing geometry probes)
    this.adapter = this.createCombatWorldAdapter();

    // Instantiate mode AI systems, applying Special Event AI/Zombie tuning, vaulting adapter & Client Replica flag
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
          worldAdapter: this.adapter,
          localAllyTeam: this.localBattleTeam,
        },
      );
      this.botAI.setBotCommsListener((ev) => this.handleLocalBotComms(ev));
      this.botAI.setBotGrenadeListener((ev) => this.handleHostBotGrenadeEvent(ev));
      this.botAI.setAssistListener((assisterId) => {
        const localTargetId = this.mp ? `human:${this.mp.localUserId}` : 'player';
        if (assisterId === 'player' || assisterId === localTargetId) {
          this.playerAssists += 1;
        }
      });
    } else {
      this.zombieAI = new InfectionZombieAI(this.scene, this.map, this.audio, {
        zombieHealthMult: evCfg?.zombieHealthMult,
        zombieMoveSpeedMult: evCfg?.zombieMoveSpeedMult,
        zombieAttackSpeedMult: evCfg?.zombieAttackSpeedMult,
        zombieSpawnAmountMult: evCfg?.zombieSpawnAmountMult,
        waveBreakIntervalSec: evCfg?.waveBreakIntervalSec,
        isClientReplica,
      });

      // Friendly AI squadmates in Infection mode (0 up to open squad slots, always allied)
      const requestedInfectionBots = Math.max(0, Math.min(3, Math.round(params.infectionConfig.botCount ?? 0)));
      if (requestedInfectionBots > 0) {
        this.botAI = new BattleBotAI(
          this.scene,
          this.map,
          this.audio,
          'tdm',
          requestedInfectionBots,
          params.infectionConfig.botDifficulty ?? 'tactical',
          {
            aiHealth: evCfg?.aiHealth ?? 120,
            aiAccuracyMult: evCfg?.aiAccuracyMult,
            aiMoveSpeedMult: evCfg?.aiMoveSpeedMult,
            aiRespawnEnabled: false,
            isClientReplica,
            maxAnisotropy,
            coopInfectionMode: true,
            worldAdapter: this.adapter,
            localAllyTeam: 'A',
          },
        );
        this.botAI.setBotCommsListener((ev) => this.handleLocalBotComms(ev));
        this.botAI.setBotGrenadeListener((ev) => this.handleHostBotGrenadeEvent(ev));
        this.botAI.setInfectionZones(
          this.zombieAI.getUnlockedZoneIds(),
          this.zombieAI.getOpenedDoorIds(),
        );
      }
    }

    // SDK Viewmodel, Skeleton, Animator, Controller, PostProcess, Scope & Ballistics
    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    this.localOperatorId = operatorSelectionStore.getSelectedOperator();
    this.localGear = operatorSelectionStore.getGearConfig();
    const loadedOp = operatorAssetLoader.loadProceduralOperator(
      this.localOperatorId,
      {
        maxAnisotropy,
        uniformId: this.localUniformId,
        gear: this.localGear,
        previewMode: false,
        validationMode: 'SAFE_FALLBACK',
      },
    );
    this.skeleton = loadedOp.skeleton;
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.scene.add(this.skeleton.root);

    // Helmet-mounted IR illuminator (strictly on IR_LAYER — invisible to naked eye, illuminates under NVGs)
    this.irIlluminatorLight = new THREE.SpotLight(
      0xdceeff,
      7.5,
      44,
      THREE.MathUtils.degToRad(36),
      0.56,
      1.35,
    );
    this.irIlluminatorLight.position.set(0.05, 0.08, -0.05);
    this.irIlluminatorTarget.position.set(0, -0.04, -12);
    this.irIlluminatorLight.target = this.irIlluminatorTarget;
    this.irIlluminatorLight.visible = false;
    this.irIlluminatorLight.layers.set(IR_LAYER);
    this.camera.add(this.irIlluminatorLight);
    this.camera.add(this.irIlluminatorTarget);

    this.unsubOperatorGear = operatorSelectionStore.subscribeGear((nextGear) => {
      this.localGear = nextGear;
      this.skeleton.applyGearConfig(nextGear);
      if (nextGear.nvgMount === 'none') {
        this.nvgFlipped = false;
        this.irIlluminatorOn = false;
      }
      this.syncNvgRuntime();
      this.emitSnapshot();
    });

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);
    this.pdaDevice = new TacticalPdaDevice(this.audio);
    this.camera.add(this.pdaDevice.root);
    this.animator.setPdaDevice(this.pdaDevice);

    let hemiLight: THREE.HemisphereLight | null = null;
    let keyLight: THREE.DirectionalLight | null = null;
    this.map.sceneGroup.traverse((obj) => {
      if (!hemiLight && obj instanceof THREE.HemisphereLight) hemiLight = obj;
      else if (!keyLight && obj instanceof THREE.DirectionalLight) keyLight = obj;
    });
    if (this.map.supportsDynamicWeatherTime && hemiLight && keyLight) {
      const reqWeather =
        evCfg?.weatherPreset ??
        (params.mode === 'battle'
          ? params.battleConfig.weatherPreset
          : params.infectionConfig.weatherPreset);
      const reqTime =
        evCfg?.timeOfDayStart ??
        (params.mode === 'battle'
          ? params.battleConfig.timeOfDayStart
          : params.infectionConfig.timeOfDayStart);
      this.weatherTime = new WeatherTimeSystem({
        scene: this.scene,
        renderer: this.renderer,
        hemiLight,
        keyLight,
        baseFogDensity: this.map.lightingPreset.fogDensity,
        baseEnvIntensity: this.map.lightingPreset.envIntensity,
        supportsDynamicWeatherTime: true,
        weatherPreset: reqWeather,
        timeOfDayStart: reqTime,
        graphicsQuality: activeQuality,
        isSoftwareGl: this.isSoftwareGl,
        interiorZones: this.map.physics.getInteriorZones(),
        windUniforms: this.map.envBindings?.windUniforms ?? null,
        waterUniforms: this.map.envBindings?.waterUniforms ?? null,
        wettableSurfaces: this.map.envBindings?.wettableSurfaces,
        nightLights: this.map.envBindings?.nightLights,
        audio: this.audio,
      });
      this.weatherTime.update(0.016, this.camera.position, this.isMpHost || !this.mp);
    }
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
      onInHandDetonate: (ev) => this.handleGrenadeDetonation(ev, true),
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);

    // Wire physical destructible door acoustics & multiplayer sync if present on this map
    if (this.map.doorSystem) {
      this.map.doorSystem.setAudioVolume(this.config.masterVolume);
      this.map.doorSystem.setAcousticListener((ev) => {
        this.botAI?.notifyDoorAcousticEvent(ev.position, ev.radiusM, ev.loudness, ev.actorTeam);
      });
      this.map.doorSystem.setActionBroadcastListener((payload) => {
        if (!this.mp) return;
        const pkt: GameDoorActionPacket = {
          type: 'game:door_action',
          ...payload,
          ts: Date.now(),
        };
        this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
      });
    }

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

    // Restore saved Gunsmith attachments from PLAYGROUND and active Unified Loadout slot
    const savedLoadout = this.saveManager.loadGymLoadout();
    if (savedLoadout) {
      for (const [wId, att] of Object.entries(savedLoadout)) {
        this.attachmentsByWeapon[wId] = normalizeWeaponAttachments(wId, att);
      }
    }
    const activeUnifiedSlot = loadoutStore.getActiveSlot();
    for (const [wId, build] of Object.entries(activeUnifiedSlot.weaponBuilds)) {
      this.attachmentsByWeapon[wId] = normalizeWeaponAttachments(wId, {
        ...build.attachments,
        selectedAmmoId: build.ammoVariantId,
        zeroDistanceM: build.zeroDistanceM,
        zeroElevationMrad: build.zeroElevationMrad,
      });
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

    // Place player at map starting spawn & capture clean orthographic Tac-Map for 3D PDA
    this.spawnPlayerAtStart();
    this.pdaDevice.captureOrthographicMap({
      renderer: this.renderer,
      scene: this.scene,
      bounds: {
        minX: this.map.physics.boundsMinX,
        maxX: this.map.physics.boundsMaxX,
        minZ: this.map.physics.boundsMinZ,
        maxZ: this.map.physics.boundsMaxZ,
      },
      excludeObjects: [this.skeleton.root, this.weaponRig.root, this.pdaDevice.root],
    });

    // Pre-warm WebGL shaders once at boot on hardware GPUs to eliminate mid-combat GLSL compile hitches
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

    this.worldOnlyRaycastFn = (origin, dir, near, far) => {
      if (base.raycast(origin, dir, near, far, this._remoteWallRayScratch)) {
        return this._remoteWallRayScratch.distance;
      }
      return Infinity;
    };

    const volumetricMeleeSpherecast = (
      origin: Readonly<THREE.Vector3>,
      direction: Readonly<THREE.Vector3>,
      radius: number,
      maxDistance: number,
      outResult: BodycamRaycastResult,
    ): boolean => {
      this._meleeSphereRight.crossVectors(direction as THREE.Vector3, this._meleeSphereWorldUp);
      if (this._meleeSphereRight.lengthSq() < 1e-4) {
        this._meleeSphereRight.crossVectors(direction as THREE.Vector3, this._meleeSphereFallbackRight);
      }
      this._meleeSphereRight.normalize();
      this._meleeSphereUp.crossVectors(this._meleeSphereRight, direction as THREE.Vector3).normalize();

      const ringR = Math.max(0.02, radius * 0.72);
      let bestDist = Infinity;
      let found = false;

      for (let i = 0; i < 7; i++) {
        this._meleeSphereOrigin.copy(origin);
        if (i > 0) {
          const ang = ((i - 1) / 6) * Math.PI * 2;
          this._meleeSphereOrigin.addScaledVector(this._meleeSphereRight, Math.cos(ang) * ringR);
          this._meleeSphereOrigin.addScaledVector(this._meleeSphereUp, Math.sin(ang) * ringR);
        }
        if (raycastWithActors(this._meleeSphereOrigin, direction, 0.01, maxDistance, this._meleeSphereScratch)) {
          const effDist = i === 0 ? this._meleeSphereScratch.distance - 0.035 : this._meleeSphereScratch.distance;
          if (effDist < bestDist) {
            bestDist = effDist;
            found = true;
            outResult.hit = true;
            outResult.distance = this._meleeSphereScratch.distance;
            outResult.pointX = this._meleeSphereScratch.pointX;
            outResult.pointY = this._meleeSphereScratch.pointY;
            outResult.pointZ = this._meleeSphereScratch.pointZ;
            outResult.normalX = this._meleeSphereScratch.normalX;
            outResult.normalY = this._meleeSphereScratch.normalY;
            outResult.normalZ = this._meleeSphereScratch.normalZ;
            outResult.surface = this._meleeSphereScratch.surface;
            outResult.object = this._meleeSphereScratch.object;
          }
        }
      }

      if (!found) {
        outResult.hit = false;
        outResult.distance = Infinity;
        outResult.object = null;
      }
      return found;
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
      meleeSpherecast: volumetricMeleeSpherecast,
      onMeleeHit: (ev) => this.handleMeleeHit(ev),
      shatterBreakable: (obj, pt, dir) => this.handleWorldGlassShatter(obj, pt, dir),
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
    if (this.pdaDevice.isOpen()) {
      this.pdaDevice.setOpen(false);
    }
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
      !this.weaponRig.isTubularReloading() &&
      !this.weaponRig.isBlockingFiringAction() &&
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
    const isReloadingNow = this.reloadTimer > 0 || this.weaponRig.isTubularReloading();
    const handlingSnap = this.weaponRig.getSyncedHandlingSnapshot();
    const grenadeStage = this.grenadeSystem.getHoldStage();
    const grenadeThrowHeld = this.grenadeSystem.isThrowInputHeld();
    const grenadeWhipProg = this.grenadeSystem.getThrowWhipProgress();
    const grenadeThrowStyle = this.grenadeSystem.getThrowStyle();
    const grenadeCharge01 = this.grenadeSystem.getCharge01();
    const grenadeEquipId = this.grenadeSystem.getCookingEquipmentId();

    let syncedAction: SyncedHandlingAction = handlingSnap.action;
    let syncedProg = handlingSnap.progress;
    if (this.lastKickHandlingTimer > 0) {
      syncedAction = 'DOOR_KICK';
      syncedProg = THREE.MathUtils.clamp(1 - this.lastKickHandlingTimer / 0.48, 0, 1);
    } else if (this.interactAnimator.isActive()) {
      const ia = this.interactAnimator.getSyncedHandlingAction();
      syncedAction = ia.action;
      syncedProg = ia.progress;
    } else if (grenadeStage !== 'HOLSTERED' || this.grenadeSystem.isThrowing()) {
      if (grenadeWhipProg > 0) {
        syncedAction =
          grenadeThrowStyle === 'underhand'
            ? 'GRENADE_THROW_UNDERHAND'
            : 'GRENADE_THROW_OVERHAND';
        syncedProg = grenadeWhipProg;
      } else if (grenadeThrowHeld) {
        syncedAction = 'GRENADE_CHARGE';
        syncedProg = grenadeCharge01;
      } else if (grenadeStage === 'PIN_PULLED') {
        const pinPhase = this.grenadeSystem.getPinPullPhase();
        if (pinPhase !== 'NONE' && pinPhase !== 'EYE_AIM') {
          syncedAction = 'GRENADE_PIN_PULL';
          syncedProg = THREE.MathUtils.clamp(this.grenadeSystem.getPinPullElapsed() / 0.56, 0, 1);
        } else {
          syncedAction = 'GRENADE_COOK';
          syncedProg = 0.0;
        }
      } else if (grenadeStage === 'LEVER_RELEASED') {
        syncedAction = 'GRENADE_COOK';
        syncedProg = 1.0;
      } else {
        syncedAction = 'GRENADE_DRAW';
        syncedProg = this.grenadeSystem.getWeaponStowBlend();
      }
    }

    this.lastSentStance = aimStance;
    this.lastSentFiring = isFiringNow;
    this.lastSentReloading = isReloadingNow;
    this.lastSentHandlingAction = syncedAction;
    this.lastSentGrenadeStage = grenadeStage;
    this.lastSentGrenadeThrowHeld = grenadeThrowHeld;

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
      glovesEnabled: this.localGear.glovesEnabled,
      gloveColor: this.localGear.gloveColor,
      helmetType: this.localGear.helmetType,
      helmetColor: this.localGear.helmetColor,
      nvgMount: this.localGear.nvgMount,
      nvgFlipped: this.nvgFlipped && this.localGear.nvgMount !== 'none',
      lean,
      weaponId: this.equippedWeaponId,
      att: packSyncedWeaponAttachments(this.weaponRig.getAttachments()),
      ha: syncedAction,
      hprog: Number(syncedProg.toFixed(3)),
      geq: grenadeEquipId ?? undefined,
      gc: Number(grenadeCharge01.toFixed(3)),
      gts: grenadeThrowStyle,
      sup: derived.isSuppressed,
      hp: Math.round(this.hp),
      maxHp: this.maxHp,
      alive: this.playerAlive,
      kills: this.playerKills,
      deaths: this.playerDeaths,
      assists: this.playerAssists,
      headshots: this.playerHeadshots,
      grenadeKills: this.playerGrenadeKills,
      meleeKills: this.playerMeleeKills,
      damageDealt: this.playerDamageDealt,
      afkSeconds: Number(this.playerAfkSeconds.toFixed(1)),
      flashlightOn: this.flashlightOn && derived.hasFlashlight,
      laserOn: this.weaponRig.laserOn && derived.hasLaser,
      ts: Date.now(),
    };
    this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
  }

  private sendLocalGrenadeEvent(
    kind: GameGrenadeEventKind,
    equipmentId: TacticalEquipmentId,
    origin: Readonly<THREE.Vector3>,
    velocity?: Readonly<THREE.Vector3>,
    fuseRemainingSec?: number,
  ): void {
    if (!this.mp) return;
    const pkt: GameGrenadeEventPacket = {
      type: 'game:grenade_event',
      actorId: this.mp.localUserId,
      isBot: false,
      team: this.localBattleTeam,
      kind,
      equipmentId,
      px: Number(origin.x.toFixed(3)),
      py: Number(origin.y.toFixed(3)),
      pz: Number(origin.z.toFixed(3)),
      vx: velocity ? Number(velocity.x.toFixed(3)) : undefined,
      vy: velocity ? Number(velocity.y.toFixed(3)) : undefined,
      vz: velocity ? Number(velocity.z.toFixed(3)) : undefined,
      fuseRemainingSec:
        typeof fuseRemainingSec === 'number' ? Number(fuseRemainingSec.toFixed(3)) : undefined,
      ts: Date.now(),
    };
    this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
  }

  private handleHostBotGrenadeEvent(ev: BotGrenadeEvent): void {
    const meta = {
      isRemote: true,
      sourceId: ev.botId,
      sourceName: ev.botName,
      sourceTeam: ev.team,
      sourceIsBot: true,
    } as const;

    if (ev.kind === 'pin_pull') {
      this.audio.playGearRattle('weapon_swap', 0.4);
    } else if (ev.kind === 'spoon_pop') {
      this.audio.playGrenadeLeverSnap?.();
      this.grenadeSystem.spawnRemoteFlyingSpoon(ev.origin, ev.velocity);
    } else if (ev.kind === 'throw' || ev.kind === 'live_drop') {
      this.grenadeSystem.spawnRemoteGrenade(
        ev.equipmentId,
        ev.origin,
        ev.velocity,
        ev.fuseRemainingSec,
        meta,
      );
    } else if (ev.kind === 'in_hand_detonate') {
      this.grenadeSystem.triggerRemoteDetonation(ev.equipmentId, ev.origin, meta);
    }

    if (this.mp && this.isMpHost) {
      const pkt: GameGrenadeEventPacket = {
        type: 'game:grenade_event',
        actorId: ev.botId,
        isBot: true,
        team: ev.team,
        kind: ev.kind,
        equipmentId: ev.equipmentId,
        px: Number(ev.origin.x.toFixed(3)),
        py: Number(ev.origin.y.toFixed(3)),
        pz: Number(ev.origin.z.toFixed(3)),
        vx: Number(ev.velocity.x.toFixed(3)),
        vy: Number(ev.velocity.y.toFixed(3)),
        vz: Number(ev.velocity.z.toFixed(3)),
        fuseRemainingSec: Number(ev.fuseRemainingSec.toFixed(3)),
        ts: Date.now(),
      };
      this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
    }
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

    if (type === 'game:ping') {
      this.handleRemoteTacticalPing(raw as unknown as GameTacticalPingPacket);
      return;
    }

    if (type === 'game:grenade_event') {
      const pkt = raw as unknown as GameGrenadeEventPacket;
      if (pkt.senderUserId && pkt.senderUserId === this.mp.localUserId) return;
      if (pkt.isBot && this.isMpHost && pkt.kind !== 'belt_cookoff' && pkt.kind !== 'belt_dud') return;
      this._tmpImpactPoint.set(pkt.px, pkt.py, pkt.pz);
      this._tmpImpactDir.set(pkt.vx ?? 0, pkt.vy ?? 0, pkt.vz ?? 0);
      const meta = {
        isRemote: true,
        sourceId: pkt.actorId,
        sourceName: pkt.isBot ? pkt.actorId : (pkt.senderUsername ?? 'OPERATOR'),
        sourceTeam: (pkt.team ?? (pkt.senderTeam === 'B' ? 'B' : 'A')) as BattleTeamId,
        sourceIsBot: Boolean(pkt.isBot),
      };
      if (pkt.kind === 'pin_pull') {
        this.audio.playGearRattle('weapon_swap', 0.4);
      } else if (pkt.kind === 'spoon_pop') {
        this.audio.playGrenadeLeverSnap?.();
        this.grenadeSystem.spawnRemoteFlyingSpoon(this._tmpImpactPoint, this._tmpImpactDir);
      } else if (pkt.kind === 'throw' || pkt.kind === 'live_drop') {
        this.grenadeSystem.spawnRemoteGrenade(
          pkt.equipmentId,
          this._tmpImpactPoint,
          this._tmpImpactDir,
          pkt.fuseRemainingSec ?? 3.8,
          meta,
        );
      } else if (pkt.kind === 'in_hand_detonate') {
        this.grenadeSystem.triggerRemoteDetonation(pkt.equipmentId, this._tmpImpactPoint, meta);
      } else if (pkt.kind === 'belt_cookoff' || pkt.kind === 'belt_dud') {
        if (pkt.isBot) {
          this.botAI?.consumeBotBeltGrenade(pkt.actorId, pkt.equipmentId);
        } else if (pkt.actorId === this.mp.localUserId) {
          if (this.grenadeCount > 0) {
            this.grenadeCount = Math.max(0, this.grenadeCount - 1);
            this.syncBeltEquipmentMesh();
            this.showToast(
              pkt.kind === 'belt_cookoff'
                ? `BELT ${getTacticalEquipmentDef(pkt.equipmentId).shortName} SHOT — DETONATION!`
                : 'Belt Grenade Struck · Disabled',
              2.4,
            );
            this.emitSnapshot();
          }
        } else {
          this.remotePlayers?.consumeRemoteBeltGrenade(pkt.actorId);
        }
        if (pkt.kind === 'belt_cookoff') {
          this.grenadeSystem.triggerRemoteDetonation(pkt.equipmentId, this._tmpImpactPoint, {
            isRemote: true,
            sourceId: pkt.senderUserId ? `human:${pkt.senderUserId}` : pkt.actorId,
            sourceName: pkt.senderUsername ?? 'OPERATOR',
            sourceTeam: (pkt.senderTeam === 'B' ? 'B' : 'A') as BattleTeamId,
            sourceIsBot: false,
          });
        } else {
          this.grenadeSystem.spawnBeltDudSpark(this._tmpImpactPoint);
          this.audio.playImpact(this._tmpImpactPoint, 'steel_plate');
        }
      }
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
      if (this.playerAlive && pkt.hitZone !== 'belt_grenade') {
        const estEnergyJ = this.estimateEnergyFromWeaponOrDamage(pkt.weaponId, undefined, pkt.damage);
        this.tryRollLocalBeltGrenadeImpact(
          pkt.senderUsername ?? 'OPERATOR',
          attackerTeam,
          pkt.senderUserId,
          false,
          estEnergyJ,
          false,
        );
      }

      // If this remote hit eliminated us, broadcast authoritative kill event so killer & scoreboard update
      if (prevAlive && !this.playerAlive) {
        const killMethod: 'bullet' | 'grenade' | 'melee' =
          pkt.weaponId === 'melee'
            ? 'melee'
            : pkt.weaponId === 'm67_frag' ||
                pkt.weaponId === 'm84_flash' ||
                pkt.weaponId === 'an_m14_thermite'
              ? 'grenade'
              : 'bullet';
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
          killMethod,
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
      if (this.params.mode === 'battle') {
        this.checkBattleVictory();
      }
      return;
    }

    if (type === 'game:bot_fire' && this.botAI && !this.isMpHost) {
      const pkt = raw as unknown as GameBotFirePacket;
      this.botAI.playRemoteBotFire(
        pkt.botId,
        pkt.ox,
        pkt.oy,
        pkt.oz,
        pkt.ex,
        pkt.ey,
        pkt.ez,
        Boolean(pkt.sup),
      );
      return;
    }

    if (type === 'game:bot_comms' && !this.isMpHost) {
      const pkt = raw as unknown as GameBotCommsPacket;
      if (!pkt.senderIsHost) return;
      if (this.params.mode === 'battle') {
        if (this.params.battleConfig.rule === 'ffa') return;
        if (pkt.team !== this.localBattleTeam) return;
      }
      this.pushSquadComms(pkt.callsign, pkt.category, pkt.text);
      this.audio.playSquadRadioChirp(pkt.category);
      if (
        pkt.pingKind &&
        typeof pkt.px === 'number' &&
        typeof pkt.py === 'number' &&
        typeof pkt.pz === 'number'
      ) {
        this.upsertTacticalPing({
          id: `bot:${pkt.botId}:${this.nextSquadCommsId}`,
          senderId: `bot:${pkt.botId}`,
          senderName: pkt.callsign,
          isLocal: false,
          kind: pkt.pingKind,
          label: (pkt.pingLabel || 'CONTACT').toUpperCase().slice(0, 26),
          worldPos: new THREE.Vector3(pkt.px, pkt.py, pkt.pz),
          targetEntityType: null,
          targetEntityId: null,
          ageSec: 0,
          durationSec: 8.5,
          lostTargetTimer: 0,
        });
      }
      this.emitSnapshot();
      return;
    }

    if (type === 'game:bot_damage' && this.botAI && this.isMpHost) {
      if (this.params.mode === 'infection') return;
      const pkt = raw as unknown as GameBotDamagePacket;
      const attackerTeam: BattleTeamId =
        this.params.mode === 'battle' && this.params.battleConfig.rule === 'ffa'
          ? 'FFA'
          : pkt.senderTeam === 'B'
            ? 'B'
            : 'A';
      const botInfo = this.botAI.getBotInfo(pkt.botId);
      const killMethod: 'bullet' | 'grenade' | 'melee' =
        pkt.killMethod ?? (pkt.melee ? 'melee' : 'bullet');
      const res = this.botAI.applyDamageFromPlayer(
        pkt.botId,
        pkt.damage,
        pkt.hitZone,
        pkt.weaponName,
        pkt.senderUsername ?? 'OPERATOR',
        attackerTeam,
        `human:${pkt.senderUserId ?? ''}`,
        killMethod,
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
          killMethod,
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
      if (this.playerAlive) {
        const estEnergyJ = this.estimateEnergyFromWeaponOrDamage(undefined, undefined, pkt.damage);
        this.tryRollLocalBeltGrenadeImpact(pkt.botName, pkt.botTeam, pkt.botId, true, estEnergyJ, false);
      }
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
      this.syncBotInfectionZones();
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

    if (type === 'game:match_sync') {
      const pkt = raw as unknown as GameMatchSyncPacket;
      if (Array.isArray(pkt.doors) && this.map.doorSystem) {
        this.map.doorSystem.applySnapshotList(pkt.doors);
      }
      if (this.params.mode === 'infection' && !this.isMpHost) {
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
        this.syncBotInfectionZones();
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
      const killerMember = this.mp.members.find((m) => m.userId === pkt.killerUserId);
      const killerBotInfo = pkt.killerUserId.startsWith('bot_')
        ? this.botAI?.getBotInfo(pkt.killerUserId)
        : null;
      const killerName =
        pkt.killerUserId === this.mp.localUserId
          ? this.mp.localUsername
          : (killerBotInfo?.name ?? killerMember?.username ?? 'SURVIVOR');
      const weaponLabel = pkt.melee
        ? 'MELEE'
        : pkt.weaponId
          ? resolveWeaponProfile(pkt.weaponId).name
          : 'WEAPON';
      this.pushMpKillfeed({
        killerName,
        killerTeam: 'A',
        victimName: 'INFECTED',
        victimTeam: 'B',
        headshot: Boolean(pkt.headshot),
        weaponLabel,
      });
      if (pkt.killerUserId === this.mp.localUserId) {
        this.hitmarkerTimer = 0.28;
        this.hitmarkerHeadshot = pkt.headshot;
        this.hitmarkerKill = true;
        this.playerKills += 1;
        if (pkt.headshot) this.playerHeadshots += 1;
        if (pkt.melee) this.playerMeleeKills += 1;
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
      this.syncBotInfectionZones();
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
      return;
    }

    // Host-authoritative window barrier plank repair validation
    if (
      type === 'game:barrier_repair_request' &&
      this.params.mode === 'infection' &&
      this.isMpHost &&
      this.zombieAI
    ) {
      const pkt = raw as unknown as GameBarrierRepairRequestPacket;
      const barrier = this.zombieAI.getBarrierById(pkt.barrierId);
      if (!barrier || barrier.getPlanksRemaining() >= barrier.maxPlanks) return;
      const requesterId = pkt.senderUserId ?? '';
      if (requesterId) {
        const senderActor = this.remotePlayers
          .getAliveHumanTargets()
          .find((h) => h.id === requesterId);
        if (senderActor) {
          const dist = Math.hypot(
            barrier.interactPos[0] - senderActor.pos.x,
            barrier.interactPos[2] - senderActor.pos.z,
          );
          if (dist > 5.2) return;
        }
      }
      if (barrier.repairPlank()) {
        this._tmpBarrierPos.set(barrier.sillPos[0], barrier.sillPos[1], barrier.sillPos[2]);
        this.audio.playImpact(this._tmpBarrierPos, 'wood');
        const updPkt: GameBarrierUpdatePacket = {
          type: 'game:barrier_update',
          barrierId: barrier.id,
          planksRemaining: barrier.getPlanksRemaining(),
          repairedByUserId: requesterId || undefined,
          pointsAwarded: 5,
          ts: Date.now(),
        };
        this.mp.sendMessage(updPkt as unknown as Record<string, unknown>);
      }
      return;
    }

    if (type === 'game:barrier_update' && this.params.mode === 'infection' && this.zombieAI) {
      const pkt = raw as unknown as GameBarrierUpdatePacket;
      if (!pkt.senderIsHost) return;
      const barrier = this.zombieAI.getBarrierById(pkt.barrierId);
      if (barrier) {
        const prev = barrier.getPlanksRemaining();
        barrier.setPlankCount(pkt.planksRemaining);
        if (pkt.planksRemaining !== prev) {
          this._tmpBarrierPos.set(barrier.sillPos[0], barrier.sillPos[1], barrier.sillPos[2]);
          this.audio.playImpact(this._tmpBarrierPos, 'wood');
        }
      }
      if (pkt.repairedByUserId === this.mp.localUserId) {
        this.barrierRepairPendingRequest = false;
        const pts = Math.max(0, Math.round(pkt.pointsAwarded ?? 0));
        if (pts > 0) {
          this.addPoints(pts, 'BARRIER REPAIR');
        }
      }
      this.emitSnapshot();
      return;
    }

    if (type === 'game:env_sync' && this.weatherTime) {
      const pkt = raw as unknown as GameEnvSyncPacket;
      if (!pkt.senderIsHost) return;
      this.weatherTime.applyHostSyncState({
        activeWeather: pkt.currentWeather,
        targetWeather: pkt.targetWeather,
        transitionAlpha: pkt.transitionProgress,
        gameTimeHours: pkt.timeOfDayHours,
        windAngleRad: pkt.windDirRad,
        windSpeedMps: pkt.windSpeedMps,
        wetness: pkt.wetness,
      });
      return;
    }

    if (type === 'game:glass_shatter') {
      const pkt = raw as unknown as GameGlassShatterPacket;
      if (pkt.senderUserId === this.mp.localUserId) return;
      this._tmpImpactPoint.set(pkt.px, pkt.py, pkt.pz);
      this.handleWorldGlassShatter(pkt.breakableId, this._tmpImpactPoint, undefined, true);
      return;
    }

    if (type === 'game:door_action' && this.map.doorSystem) {
      const pkt = raw as unknown as GameDoorActionPacket;
      if (pkt.senderUserId === this.mp.localUserId) return;
      this.map.doorSystem.applyRemoteAction(pkt);
    }
  }

  private syncBotInfectionZones(): void {
    if (this.botAI && this.zombieAI) {
      this.botAI.setInfectionZones(
        this.zombieAI.getUnlockedZoneIds(),
        this.zombieAI.getOpenedDoorIds(),
      );
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
      if (pkt.killMethod === 'grenade') this.playerGrenadeKills += 1;
      if (pkt.killMethod === 'melee' || pkt.weaponId === 'melee') this.playerMeleeKills += 1;
      if (pkt.weaponId && pkt.weaponId !== 'melee' && pkt.killMethod !== 'grenade') {
        this.recordWeaponKill(pkt.weaponId);
      }
      this.hitmarkerTimer = 0.32;
      this.hitmarkerHeadshot = pkt.headshot;
      this.hitmarkerKill = true;
      this.showToast(
        pkt.headshot ? `HEADSHOT ELIMINATION · ${pkt.victimName}` : `ELIMINATED ${pkt.victimName}`,
        2.2,
      );
    } else if (this.mp && pkt.victimUserId) {
      const attackers = this.remoteRecentAttackers.get(pkt.victimUserId);
      if (attackers) {
        const hitAt = attackers.get(this.mp.localUserId);
        if (
          typeof hitAt === 'number' &&
          performance.now() - hitAt <= 10000 &&
          pkt.killerUserId !== this.mp.localUserId
        ) {
          this.playerAssists += 1;
        }
      }
    }
    this.remoteRecentAttackers.delete(pkt.victimUserId);

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
    if (typeof patch.showKillfeed === 'boolean') {
      killfeedPreferenceStore.setEnabled(patch.showKillfeed);
    }
    if (patch.graphicsQuality) {
      graphicsQualityStore.setQuality(patch.graphicsQuality);
      const qProfile = getGraphicsQualityProfile(patch.graphicsQuality);
      this.renderer.setPixelRatio(
        this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, qProfile.maxDpr),
      );
      this.renderer.shadowMap.enabled = !this.isSoftwareGl && qProfile.castShadows;
      this.renderer.shadowMap.needsUpdate = true;
    }
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
    this.playerAssists = 0;
    this.playerGrenadeKills = 0;
    this.playerMeleeKills = 0;
    this.playerDamageDealt = 0;
    this.playerAfkSeconds = 0;
    this.matchDurationSec = 0;
    this.idleSinceInputSec = 0;
    this.localRecentAttackers.clear();
    this.zombieRecentAttackers.clear();
    this.remoteRecentAttackers.clear();
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
    this.activePings.length = 0;
    this.projectedPings = [];
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

  private estimateEnergyFromWeaponOrDamage(
    weaponId?: string,
    caliberId?: string,
    damage = 16,
  ): number {
    const cal = (caliberId ?? (weaponId ? resolveWeaponProfile(weaponId).defaultCaliberId : '') ?? '').toLowerCase();
    if (cal.includes('50') || cal.includes('338')) return 4800;
    if (cal.includes('762x51') || cal.includes('308') || cal.includes('12ga')) return 3200;
    if (cal.includes('762x39') || cal.includes('556') || cal.includes('545')) return 1800;
    if (cal.includes('45') || cal.includes('10mm') || cal.includes('357')) return 720;
    if (cal.includes('9x19') || cal.includes('9mm')) return 520;
    return THREE.MathUtils.clamp(damage * 95, 320, 3400);
  }

  private tryRollLocalBeltGrenadeImpact(
    attackerName: string,
    attackerTeam: BattleTeamId | undefined,
    attackerId: string | undefined,
    isBot: boolean,
    estimatedEnergyJ: number,
    directBeltHit: boolean,
  ): void {
    if (!this.playerAlive || !this.tacticalMountOnBelt || this.grenadeCount <= 0) return;
    // Direct belt-grenade hit always checks detonation; incoming body shots have a waist-belt strike chance
    if (!directBeltHit && Math.random() > 0.13) return;

    const eqId = this.tacticalEquipmentId;
    const detChance = computeBeltGrenadeDetonationChance(estimatedEnergyJ);
    const detonated = Math.random() < detChance;

    this.grenadeCount = Math.max(0, this.grenadeCount - 1);
    this.syncBeltEquipmentMesh();

    if (!this.skeleton.getBeltGrenadeWorldPosition(this._localBeltGrenadePos)) {
      this._localBeltGrenadePos.set(
        this.controller.position.x,
        this.controller.position.y + 0.92,
        this.controller.position.z,
      );
    }

    if (detonated) {
      this.grenadeSystem.detonateImmediately(eqId, this._localBeltGrenadePos, {
        isRemote: true,
        sourceIsBot: isBot,
        sourceId: attackerId,
        sourceName: attackerName,
        sourceTeam: attackerTeam,
      });
      this.showToast(`BELT ${getTacticalEquipmentDef(eqId).shortName} SHOT — DETONATION!`, 2.8);
    } else {
      this.grenadeSystem.spawnBeltDudSpark(this._localBeltGrenadePos);
      this.audio.playImpact(this._localBeltGrenadePos, 'steel_plate');
      this.showToast('Belt Grenade Struck · Disabled', 2.2);
    }
    this.emitSnapshot();
  }

  private replenishInfectionRoundGrenade(): void {
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    if (this.grenadeCount < def.maxCarry) {
      this.grenadeCount = Math.min(def.maxCarry, this.grenadeCount + 1);
      this.syncBeltEquipmentMesh();
    }
  }

  private handleGrenadeHolsterOrToss(reason: 'switch' | 'death' = 'switch'): 'holstered' | 'tossed' | 'none' {
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
      const launched = this.grenadeSystem.consumeLastLaunchedThrow();
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.audio.playGearRattle('weapon_swap', 0.65);
      if (launched) {
        this.sendLocalGrenadeEvent(
          reason === 'death' ? 'live_drop' : 'throw',
          launched.equipmentId,
          launched.origin,
          launched.velocity,
          launched.fuseRemainingSec,
        );
      }
      if (reason === 'switch') {
        this.showToast('Live Grenade Tossed Clear!');
      }
    } else if (res === 'holstered' && reason === 'switch') {
      this.showToast('Grenade Re-Pinned & Holstered');
    }
    return res;
  }

  private drawOrHolsterGrenade(): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
    if (this.grenadeSystem.isDrawn()) {
      this.handleGrenadeHolsterOrToss('switch');
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
    this.showToast(`${def.shortName} Drawn — [RMB] Pin · [RMB] Spoon · [LMB] Click Lob / Hold Throw`);
    this.emitSnapshot();
  }

  private handleWorldGlassShatter(
    objOrId: THREE.Object3D | string,
    point?: Readonly<THREE.Vector3>,
    _dir?: Readonly<THREE.Vector3>,
    fromRemote = false,
  ): boolean {
    if (!this.map.shatterBreakable) return false;
    const res = this.map.shatterBreakable(objOrId, point);
    if (!res) return false;
    this.audio.playGlassShatter(res.impactPoint, 0.95);
    if (!fromRemote && this.mp) {
      const pkt: GameGlassShatterPacket = {
        type: 'game:glass_shatter',
        breakableId: res.breakableId,
        px: Number(res.impactPoint.x.toFixed(3)),
        py: Number(res.impactPoint.y.toFixed(3)),
        pz: Number(res.impactPoint.z.toFixed(3)),
        ts: Date.now(),
      };
      this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
    }
    return true;
  }

  private handleGrenadeDetonation(ev: GrenadeDetonationEvent, isInHand = false): void {
    const canApplyAuthorityDamage = !ev.isRemote || (Boolean(ev.sourceIsBot) && (this.isMpHost || !this.mp));
    const canAttributeLocalKills = !ev.isRemote;

    // 0. Shatter breakable glass panes inside frag/thermite/flash blast radius
    if (
      this.map.shatterBreakable &&
      !ev.isTick &&
      (ev.kind === 'frag' || ev.kind === 'thermite' || ev.kind === 'flash')
    ) {
      const blastGlassR = Math.max(ev.radiusM, 6.5);
      const meshesCopy = this.map.raycastMeshes.slice();
      for (let i = 0; i < meshesCopy.length; i++) {
        const m = meshesCopy[i];
        if (!m.userData?.breakableGlass || m.userData.shattered) continue;
        m.getWorldPosition(this._tmpImpactPoint);
        if (this._tmpImpactPoint.distanceTo(ev.position) <= blastGlassR) {
          this.handleWorldGlassShatter(m, this._tmpImpactPoint, undefined, Boolean(ev.isRemote));
        }
      }
    }

    // 1. Battle AI Bots AoE blast (with 44-ray cover-occluded M67 fragmentation evaluator)
    if (this.params.mode === 'battle' && this.botAI && canApplyAuthorityDamage) {
      const attackerName = ev.sourceIsBot ? (ev.sourceName ?? 'BOT') : (this.mp?.localUsername ?? 'YOU');
      const attackerTeam: BattleTeamId = ev.sourceIsBot
        ? (ev.sourceTeam ?? 'B')
        : this.localBattleTeam;
      const fragEvaluator =
        ev.kind === 'frag'
          ? (targetPos: Readonly<THREE.Vector3>) =>
              this.grenadeSystem.evaluateFragDamageAt(ev.position, targetPos, ev.def).damage
          : undefined;
      const attackerId = ev.sourceIsBot
        ? (ev.sourceId ?? undefined)
        : this.mp
          ? `human:${this.mp.localUserId}`
          : 'player';
      const res = this.botAI.applyAreaBlast(
        ev.position,
        ev.radiusM,
        ev.maxDamage,
        ev.kind,
        attackerName,
        attackerTeam,
        ev.def.killfeedLabel,
        fragEvaluator,
        attackerId,
      );
      if (res.hits > 0 && canAttributeLocalKills) {
        this.playerDamageDealt += res.totalDamage;
        this.hitmarkerTimer = res.kills > 0 ? 0.34 : 0.2;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.kills > 0;
        if (res.kills > 0) {
          this.playerKills += res.kills;
          this.playerGrenadeKills += res.kills;
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
                killMethod: 'grenade',
                ts: Date.now(),
              };
              this.mp.sendMessage(killPkt as unknown as Record<string, unknown>);
            }
          }
          this.checkBattleVictory();
        }
        this.emitSnapshot();
      } else if (res.kills > 0) {
        this.checkBattleVictory();
        this.emitSnapshot();
      }
    }

    // 2. Multiplayer Remote Human Opponents PvP blast (sent once by authoritative thrower or Host for bot throws)
    if (
      this.params.mode === 'battle' &&
      this.mp &&
      this.remotePlayers &&
      ev.kind !== 'smoke' &&
      canApplyAuthorityDamage
    ) {
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
        if (ev.sourceIsBot) {
          if (this.isMpHost) {
            const hitPkt: GameBotHitPlayerPacket = {
              type: 'game:bot_hit_player',
              targetUserId: target.userId,
              damage: dmg,
              botId: ev.sourceId ?? 'bot_0',
              botName: ev.sourceName ?? 'BOT',
              botTeam: ev.sourceTeam ?? 'B',
              ts: Date.now(),
            };
            this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
          }
        } else {
          this.hitmarkerTimer = 0.22;
          this.hitmarkerHeadshot = false;
          this.hitmarkerKill = false;
          this.playerDamageDealt += dmg;
          this.recordRemoteDamageAttribution(target.userId, this.mp.localUserId);
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
    }

    // 3. Infection Zombies AoE blast
    if (this.params.mode === 'infection' && this.zombieAI && canApplyAuthorityDamage) {
      const res = this.zombieAI.applyAreaBlast(ev.position, ev.radiusM, ev.maxDamage, ev.kind);
      if (res.hits > 0 && canAttributeLocalKills) {
        this.playerDamageDealt += res.hits * Math.round(ev.maxDamage * 0.55);
        this.hitmarkerTimer = res.kills > 0 ? 0.34 : 0.2;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.kills > 0;
        if (res.kills > 0) {
          this.playerKills += res.kills;
          this.playerGrenadeKills += res.kills;
          this.pushMpKillfeed({
            killerName: this.mp?.localUsername ?? 'YOU',
            killerTeam: 'A',
            victimName: res.kills > 1 ? `INFECTED ×${res.kills}` : 'INFECTED',
            victimTeam: 'B',
            headshot: false,
            weaponLabel: ev.def.killfeedLabel,
          });
        }
        if (res.pointsAwarded > 0) {
          this.addPoints(
            res.pointsAwarded,
            res.kills > 0 ? `${ev.def.shortName} x${res.kills}` : ev.def.shortName,
          );
        }
        this.emitSnapshot();
      } else if (res.kills > 0 && ev.sourceIsBot) {
        for (let k = 0; k < res.kills; k++) {
          this.botAI?.awardInfectionKillPoints(
            ev.sourceId ?? '',
            false,
            false,
            true,
            Math.round(ev.maxDamage * 0.5),
          );
        }
        this.pushMpKillfeed({
          killerName: ev.sourceName ?? 'SQUAD BOT',
          killerTeam: 'A',
          victimName: res.kills > 1 ? `INFECTED ×${res.kills}` : 'INFECTED',
          victimTeam: 'B',
          headshot: false,
          weaponLabel: ev.def.killfeedLabel,
        });
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
      if (dist <= maxEffectDist || isInHand) {
        const proximity = isInHand ? 1.0 : Math.max(0, 1 - dist / Math.max(0.6, maxEffectDist));
        if (!ev.isTick) {
          this.controller.applyRecoil(
            (isInHand ? 0.14 : 0.028) * proximity,
            (Math.random() - 0.5) * (isInHand ? 0.12 : 0.045) * proximity,
            (isInHand ? 0.045 : 0.014) * proximity,
            0.6,
            { stanceCoupled: false },
          );
          this.adrenalineStress = Math.min(1, this.adrenalineStress + (isInHand ? 1.0 : 0.35 * proximity));
        }

        const attackerLabel = ev.sourceIsBot ? (ev.sourceName ?? ev.def.killfeedLabel) : ev.def.killfeedLabel;
        const attackerTeam: BattleTeamId = ev.sourceIsBot ? (ev.sourceTeam ?? 'B') : this.localBattleTeam;
        const attackerId = ev.sourceIsBot ? ev.sourceId : undefined;

        if (ev.kind === 'flash') {
          this.camera.getWorldDirection(this._grenadeThrowDir);
          const exposure = isInHand
            ? { intensity: 1.0 }
            : this.grenadeSystem.computeFlashbangExposure(
                ev.position,
                this.camera.position,
                this._grenadeThrowDir,
                ev.radiusM * 1.25,
              );
          if (exposure.intensity > 0.05) {
            this.postProcess.triggerFlashbangOverload(exposure.intensity);
            this.postProcess.triggerNvgFlashSpike(1.0);
            this.audio.playFlashbangTinnitus(exposure.intensity);
            this.flashBlindAlpha = Math.max(
              this.flashBlindAlpha,
              THREE.MathUtils.clamp(exposure.intensity * 0.34, 0, 0.36),
            );
          }
          if (isInHand) {
            this.applyPlayerDamage(Math.max(45, ev.maxDamage), attackerLabel, attackerTeam, attackerId);
          }
        } else if (ev.kind === 'frag') {
          if (isInHand) {
            this.applyPlayerDamage(Math.max(this.maxHp + 50, ev.maxDamage), attackerLabel, attackerTeam, attackerId);
          } else {
            const fragEval = this.grenadeSystem.evaluateFragDamageAt(ev.position, playerChest, ev.def);
            const selfDmg = Math.round(fragEval.damage * (ev.isRemote ? 1.0 : 0.62));
            if (selfDmg > 0) {
              this.applyPlayerDamage(selfDmg, attackerLabel, attackerTeam, attackerId);
            }
          }
        } else if (ev.kind === 'thermite' && (dist <= ev.radiusM || isInHand)) {
          const falloff = isInHand ? 1.0 : Math.max(0.15, 1 - dist / Math.max(0.5, ev.radiusM));
          const selfDmg = Math.round(ev.maxDamage * (ev.isRemote ? 0.85 : 0.48) * falloff);
          if (selfDmg > 0) {
            this.applyPlayerDamage(selfDmg, attackerLabel, attackerTeam, attackerId);
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
      if (hitZone === 'belt_grenade') {
        const poppedEq =
          this.remotePlayers.consumeRemoteBeltGrenade(targetUserId) ??
          (isTacticalEquipmentId(ud.beltGrenadeEquipmentId) ? ud.beltGrenadeEquipmentId : 'm67_frag');
        const detChance = computeBeltGrenadeDetonationChance(
          ev.impactEnergyJ,
          ev.ammo?.coreType,
          ev.ammo?.bulletMassGrams,
        );
        const detonated = Math.random() < detChance;

        this.hitmarkerTimer = detonated ? 0.28 : 0.18;
        this.hitmarkerHeadshot = detonated;
        this.hitmarkerKill = false;
        this.remotePlayers.triggerHitFlinch(targetUserId);

        const beltEvtPkt: GameGrenadeEventPacket = {
          type: 'game:grenade_event',
          actorId: targetUserId,
          isBot: false,
          team: this.localBattleTeam,
          kind: detonated ? 'belt_cookoff' : 'belt_dud',
          equipmentId: poppedEq,
          px: Number(ev.point.x.toFixed(3)),
          py: Number(ev.point.y.toFixed(3)),
          pz: Number(ev.point.z.toFixed(3)),
          ts: Date.now(),
        };
        this.mp.sendMessage(beltEvtPkt as unknown as Record<string, unknown>);

        if (detonated) {
          this.grenadeSystem.detonateImmediately(poppedEq, ev.point, {
            sourceId: `human:${this.mp.localUserId}`,
            sourceName: this.mp.localUsername,
            sourceTeam: this.localBattleTeam,
            sourceIsBot: false,
          });
          this.showToast(`BELT ${getTacticalEquipmentDef(poppedEq).shortName} DETONATED!`, 2.4);
          const hitPkt: GamePlayerHitPacket = {
            type: 'game:hit',
            targetUserId,
            damage: poppedEq === 'm67_frag' ? 120 : poppedEq === 'an_m14_thermite' ? 45 : 18,
            hitZone: 'belt_grenade',
            headshot: false,
            weaponId: poppedEq,
            weaponName: `${getTacticalEquipmentDef(poppedEq).shortName} BELT COOK-OFF`,
            ts: Date.now(),
          };
          this.mp.sendMessage(hitPkt as unknown as Record<string, unknown>);
        } else {
          this.grenadeSystem.spawnBeltDudSpark(ev.point);
          this.audio.playImpact(ev.point, 'steel_plate');
          this.showToast('Belt Grenade Shot · Disabled', 1.8);
        }
        this.emitSnapshot();
        return;
      }

      const headshot = hitZone === 'head';
      const zoneMult = headshot ? 2.1 : hitZone === 'limb' ? 0.72 : 1.0;
      const damage = Math.max(1, Math.min(250, Math.round(this.computeWeaponBaseDamage(ev) * zoneMult)));

      this.hitmarkerTimer = headshot ? 0.22 : 0.16;
      this.hitmarkerHeadshot = headshot;
      this.hitmarkerKill = false;
      this.playerDamageDealt += damage;
      this.recordRemoteDamageAttribution(targetUserId, this.mp.localUserId);
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
      // Friendly Infection AI bots never take friendly fire from human operators
      if (this.params.mode === 'infection') return;
      const botId = String(ud.actorId);
      const hitZone = String(ud.hitZone ?? 'thorax');
      const baseDmg = this.computeWeaponBaseDamage(ev);

      // Shootable physical belt grenade: caliber/energy-scaled live cook-off OR metallic spark dud
      if (hitZone === 'belt_grenade') {
        const botInfo = this.botAI.getBotInfo(botId);
        if (!botInfo || !botInfo.alive) return;
        if (
          this.params.mode === 'battle' &&
          this.params.battleConfig.rule === 'tdm' &&
          botInfo.team === this.localBattleTeam
        ) {
          return;
        }
        const preferredEq = isTacticalEquipmentId(ud.beltGrenadeEquipmentId)
          ? ud.beltGrenadeEquipmentId
          : undefined;
        const poppedEq =
          this.botAI.consumeBotBeltGrenade(botId, preferredEq) ?? preferredEq ?? 'm67_frag';
        const detChance = computeBeltGrenadeDetonationChance(
          ev.impactEnergyJ,
          ev.ammo?.coreType,
          ev.ammo?.bulletMassGrams,
        );
        const detonated = Math.random() < detChance;

        this.hitmarkerTimer = detonated ? 0.28 : 0.18;
        this.hitmarkerHeadshot = detonated;
        this.hitmarkerKill = false;
        this.botAI.triggerVisualFlinch(botId);

        if (this.mp) {
          const beltEvtPkt: GameGrenadeEventPacket = {
            type: 'game:grenade_event',
            actorId: botId,
            isBot: true,
            team: botInfo.team,
            kind: detonated ? 'belt_cookoff' : 'belt_dud',
            equipmentId: poppedEq,
            px: Number(ev.point.x.toFixed(3)),
            py: Number(ev.point.y.toFixed(3)),
            pz: Number(ev.point.z.toFixed(3)),
            ts: Date.now(),
          };
          this.mp.sendMessage(beltEvtPkt as unknown as Record<string, unknown>);
        }

        if (detonated) {
          this.grenadeSystem.detonateImmediately(poppedEq, ev.point, {
            sourceId: this.mp ? `human:${this.mp.localUserId}` : 'player',
            sourceName: this.mp?.localUsername ?? 'YOU',
            sourceTeam: this.localBattleTeam,
            sourceIsBot: false,
          });
          this.showToast(`BELT ${getTacticalEquipmentDef(poppedEq).shortName} DETONATED!`, 2.4);
        } else {
          this.grenadeSystem.spawnBeltDudSpark(ev.point);
          this.audio.playImpact(ev.point, 'steel_plate');
          this.showToast('Belt Grenade Shot · Disabled', 1.8);
        }
        this.emitSnapshot();
        return;
      }

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
        const mult = headshot ? 2.4 : hitZone === 'limb' ? 0.72 : 1.0;
        this.playerDamageDealt += Math.round(Math.max(8, baseDmg * mult));
        this.recordRemoteDamageAttribution(botId, this.mp.localUserId);
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
        'bullet',
      );
      if (res.hit) {
        this.playerDamageDealt += res.appliedDamage;
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
              killMethod: 'bullet',
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
        const localAttackerId = this.mp ? `human:${this.mp.localUserId}` : 'player';
        this.playerDamageDealt += Math.round(baseDmg);
        this.recordZombieDamageAttribution(zombieId, localAttackerId);
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
          this.resolveZombieKillAssists(zombieId, localAttackerId);
          this.pushMpKillfeed({
            killerName: this.mp?.localUsername ?? 'YOU',
            killerTeam: 'A',
            victimName: 'INFECTED',
            victimTeam: 'B',
            headshot: res.headshot,
            weaponLabel: this._runtimeProfile.name,
          });
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

    // Static environment breakable glass + destructible doors + surface audio
    if (ev.material === 'glass' || ud?.breakableGlass || ud?.breakableId) {
      if (obj && !ud?.shattered) {
        this.handleWorldGlassShatter(obj, ev.point, ev.incomingDir);
      }
      return;
    }
    if (ud?.destructibleDoorId && this.map.doorSystem) {
      this.map.doorSystem.applyBulletImpact(
        String(ud.destructibleDoorId),
        ev.point,
        ev.incomingDir,
        34,
        this.localBattleTeam,
      );
      this.audio.playImpact(ev.point, 'wood');
      return;
    }
    if (ev.material === 'steel') this.audio.playImpact(ev.point, 'metal');
    else if (ev.material === 'wood') this.audio.playImpact(ev.point, 'wood');
    else this.audio.playImpact(ev.point, 'concrete');
  }

  private recordWeaponKill(weaponId: string): void {
    if (!weaponId) return;
    this.weaponKills[weaponId] = (this.weaponKills[weaponId] ?? 0) + 1;
  }

  private recordRemoteDamageAttribution(targetId: string, attackerId: string): void {
    let map = this.remoteRecentAttackers.get(targetId);
    if (!map) {
      map = new Map<string, number>();
      this.remoteRecentAttackers.set(targetId, map);
    }
    map.set(attackerId, performance.now());
  }

  private recordZombieDamageAttribution(zombieId: string, attackerId: string): void {
    let map = this.zombieRecentAttackers.get(zombieId);
    if (!map) {
      map = new Map<string, number>();
      this.zombieRecentAttackers.set(zombieId, map);
    }
    map.set(attackerId, performance.now());
  }

  private resolveZombieKillAssists(zombieId: string, killerId: string): void {
    const map = this.zombieRecentAttackers.get(zombieId);
    if (!map) return;
    const nowMs = performance.now();
    const localId = this.mp ? `human:${this.mp.localUserId}` : 'player';
    for (const [assisterId, hitAt] of map.entries()) {
      if (nowMs - hitAt > 10000) continue;
      if (assisterId === killerId) continue;
      if (assisterId === localId || assisterId === 'player') {
        this.playerAssists += 1;
      }
    }
    this.zombieRecentAttackers.delete(zombieId);
  }

  private handleMeleeHit(ev: Readonly<BodycamMeleeHitEvent>): void {
    const ud = ev.object?.userData;
    const isKick = ev.attackType === 'kick';
    const meleeDmg = isKick ? 42 : ev.attackType === 'bash' ? 68 : 52;
    const kbSpeed = isKick ? 7.8 : 4.6;

    // Physical Destructible Doors: melee bash/punch/kick -> exact geometric punch-through holes + hinge velocity
    if (ud?.destructibleDoorId && this.map.doorSystem) {
      const doorId = String(ud.destructibleDoorId);
      if (isKick) {
        this.controller.getVelocity(this._doorVelScratch);
        const horizSpeed = Math.hypot(this._doorVelScratch.x, this._doorVelScratch.z);
        this.map.doorSystem.executeKick(
          doorId,
          ev.direction,
          horizSpeed,
          this.controller.isSprinting,
          this.localBattleTeam,
          false,
          undefined,
          ev.point,
          ev.object,
        );
        this.lastKickHandlingTimer = 0.48;
      } else {
        this.map.doorSystem.applyMeleeBash(
          doorId,
          ev.point,
          ev.direction,
          this.localBattleTeam,
          false,
          ev.object,
          ev.attackType,
        );
      }
      this.emitSnapshot();
      return;
    }

    // Drywall partitions, plywood barriers, and range panels: real see-through / shoot-through holes
    if (ud?.penetrableSurfaceId && this.map.penetrableSystem) {
      const pen = this.map.penetrableSystem.applyMeleeImpact(
        String(ud.penetrableSurfaceId),
        ev.point,
        ev.direction,
        ev.attackType,
      );
      if (pen.pierced) {
        this.audio.playImpact(ev.point, 'wood');
      }
      return;
    }

    if (ud?.combatActorType === 'remote_player' && this.mp && this.remotePlayers) {
      const targetUserId = String(ud.actorId);
      if (this.remotePlayers.isFriendly(targetUserId)) return;
      if (ud?.hitZone === 'belt_grenade') {
        const poppedEq =
          this.remotePlayers.consumeRemoteBeltGrenade(targetUserId) ??
          (isTacticalEquipmentId(ud.beltGrenadeEquipmentId) ? ud.beltGrenadeEquipmentId : 'm67_frag');
        const detChance = computeBeltGrenadeDetonationChance(
          isKick ? 540 : ev.attackType === 'bash' ? 440 : 280,
          'ap',
        );
        const detonated = Math.random() < detChance;
        this.hitmarkerTimer = detonated ? 0.28 : 0.18;
        this.hitmarkerHeadshot = detonated;
        this.remotePlayers.triggerHitFlinch(targetUserId);
        const beltEvtPkt: GameGrenadeEventPacket = {
          type: 'game:grenade_event',
          actorId: targetUserId,
          isBot: false,
          team: this.localBattleTeam,
          kind: detonated ? 'belt_cookoff' : 'belt_dud',
          equipmentId: poppedEq,
          px: Number(ev.point.x.toFixed(3)),
          py: Number(ev.point.y.toFixed(3)),
          pz: Number(ev.point.z.toFixed(3)),
          ts: Date.now(),
        };
        this.mp.sendMessage(beltEvtPkt as unknown as Record<string, unknown>);
        if (detonated) {
          this.grenadeSystem.detonateImmediately(poppedEq, ev.point, {
            sourceId: `human:${this.mp.localUserId}`,
            sourceName: this.mp.localUsername,
            sourceTeam: this.localBattleTeam,
            sourceIsBot: false,
          });
          this.showToast(`BELT ${getTacticalEquipmentDef(poppedEq).shortName} DETONATED!`, 2.4);
        } else {
          this.grenadeSystem.spawnBeltDudSpark(ev.point);
          this.audio.playImpact(ev.point, 'steel_plate');
        }
        this.emitSnapshot();
        return;
      }
      this.hitmarkerTimer = 0.22;
      this.hitmarkerHeadshot = false;
      this.hitmarkerKill = false;
      this.playerDamageDealt += meleeDmg;
      this.recordRemoteDamageAttribution(targetUserId, this.mp.localUserId);
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
        this.playerDamageDealt += meleeDmg;
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
        const localAttackerId = this.mp ? `human:${this.mp.localUserId}` : 'player';
        this.playerDamageDealt += meleeDmg;
        this.recordZombieDamageAttribution(zombieId, localAttackerId);
        this.hitmarkerTimer = res.killed ? 0.28 : 0.18;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, 'wood');
        if (res.pointsAwarded > 0) {
          this.addPoints(res.pointsAwarded, res.killed ? 'MELEE KILL' : 'BASH');
        }
        if (res.killed) {
          this.playerKills += 1;
          this.playerMeleeKills += 1;
          this.resolveZombieKillAssists(zombieId, localAttackerId);
          this.pushMpKillfeed({
            killerName: this.mp?.localUsername ?? 'YOU',
            killerTeam: 'A',
            victimName: 'INFECTED',
            victimTeam: 'B',
            headshot: false,
            weaponLabel: isKick ? 'PUSH-KICK' : 'MELEE',
          });
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
      if (this.params.mode === 'infection') return;
      const botId = String(ud.actorId);
      if (ud?.hitZone === 'belt_grenade') {
        const botInfo = this.botAI.getBotInfo(botId);
        if (!botInfo || !botInfo.alive) return;
        if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm' && botInfo.team === this.localBattleTeam) {
          return;
        }
        const preferredEq = isTacticalEquipmentId(ud.beltGrenadeEquipmentId)
          ? ud.beltGrenadeEquipmentId
          : undefined;
        const poppedEq =
          this.botAI.consumeBotBeltGrenade(botId, preferredEq) ?? preferredEq ?? 'm67_frag';
        const detChance = computeBeltGrenadeDetonationChance(
          isKick ? 540 : ev.attackType === 'bash' ? 440 : 280,
          'ap',
        );
        const detonated = Math.random() < detChance;
        this.hitmarkerTimer = detonated ? 0.28 : 0.18;
        this.hitmarkerHeadshot = detonated;
        this.botAI.triggerVisualFlinch(botId);
        if (this.mp) {
          const beltEvtPkt: GameGrenadeEventPacket = {
            type: 'game:grenade_event',
            actorId: botId,
            isBot: true,
            team: botInfo.team,
            kind: detonated ? 'belt_cookoff' : 'belt_dud',
            equipmentId: poppedEq,
            px: Number(ev.point.x.toFixed(3)),
            py: Number(ev.point.y.toFixed(3)),
            pz: Number(ev.point.z.toFixed(3)),
            ts: Date.now(),
          };
          this.mp.sendMessage(beltEvtPkt as unknown as Record<string, unknown>);
        }
        if (detonated) {
          this.grenadeSystem.detonateImmediately(poppedEq, ev.point, {
            sourceId: this.mp ? `human:${this.mp.localUserId}` : 'player',
            sourceName: this.mp?.localUsername ?? 'YOU',
            sourceTeam: this.localBattleTeam,
            sourceIsBot: false,
          });
          this.showToast(`BELT ${getTacticalEquipmentDef(poppedEq).shortName} DETONATED!`, 2.4);
        } else {
          this.grenadeSystem.spawnBeltDudSpark(ev.point);
          this.audio.playImpact(ev.point, 'steel_plate');
        }
        this.emitSnapshot();
        return;
      }
      if (this.mp && !this.isMpHost) {
        const info = this.botAI.getBotInfo(botId);
        if (!info || !info.alive) return;
        if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm' && info.team === this.localBattleTeam) {
          return;
        }
        this.hitmarkerTimer = 0.22;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = false;
        this.playerDamageDealt += meleeDmg;
        this.recordRemoteDamageAttribution(botId, this.mp.localUserId);
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
          killMethod: 'melee',
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
        'melee',
      );
      if (res.hit) {
        this.playerDamageDealt += res.appliedDamage;
        this.hitmarkerTimer = 0.22;
        this.hitmarkerHeadshot = false;
        this.hitmarkerKill = res.killed;
        this.audio.playImpact(ev.point, 'wood');
        if (res.killed) {
          this.playerKills += 1;
          this.playerMeleeKills += 1;
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
              killMethod: 'melee',
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

    if (attackerId) {
      this.localRecentAttackers.set(attackerId, performance.now());
    }

    if (this.hp <= 0) {
      this.playerAlive = false;
      this.playerDeaths += 1;
      const nowMs = performance.now();
      const recentIds: string[] = [];
      for (const [id, atMs] of this.localRecentAttackers.entries()) {
        if (nowMs - atMs <= 10000) recentIds.push(id);
      }
      this.localRecentAttackers.clear();

      this.isFiring = false;
      this.input.ads = false;
      if (this.grenadeSystem.isLeverReleased()) {
        this.handleGrenadeHolsterOrToss('death');
      } else {
        this.grenadeSystem.cancelCook();
      }
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
          this.botAI.recordPlayerDeath(attackerLabel, attackerTeam, attackerId, 'bullet', recentIds);
        } else if (!attackerId || attackerId.startsWith('bot_')) {
          this.botAI.recordPlayerDeath(attackerLabel, attackerTeam, attackerId, 'bullet', recentIds);
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
        this.pushMpKillfeed({
          killerName: attackerLabel,
          killerTeam: 'B',
          victimName: this.mp?.localUsername ?? 'YOU',
          victimTeam: 'A',
          headshot: false,
          weaponLabel: attackerLabel === 'INFECTED' ? 'CLAW' : attackerLabel,
        });
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
      // Skip window barriers that are already fully intact (all planks in place)
      if (it.kind === 'window_barrier') {
        const barrier = this.zombieAI?.getBarrierById(it.barrierId ?? it.id);
        if (!barrier || barrier.getPlanksRemaining() >= barrier.maxPlanks) {
          continue;
        }
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

  private updateBarrierRepair(dt: number, simActive: boolean): void {
    const it = this.nearbyInteractable;
    if (
      !simActive ||
      this.params.mode !== 'infection' ||
      !this.playerAlive ||
      !this.pointerLocked ||
      !this.interactKeyHeld ||
      !it ||
      it.kind !== 'window_barrier' ||
      !this.zombieAI
    ) {
      this.repairingBarrierId = null;
      this.barrierRepairProgress = 0;
      this.barrierRepairPendingRequest = false;
      return;
    }

    const barrierId = it.barrierId ?? it.id;
    const barrier = this.zombieAI.getBarrierById(barrierId);
    if (!barrier || barrier.getPlanksRemaining() >= barrier.maxPlanks) {
      this.repairingBarrierId = null;
      this.barrierRepairProgress = 0;
      this.barrierRepairPendingRequest = false;
      return;
    }

    if (this.repairingBarrierId !== barrier.id) {
      this.repairingBarrierId = barrier.id;
      this.barrierRepairProgress = 0;
      this.barrierRepairPendingRequest = false;
    }

    if (this.barrierRepairPendingRequest) {
      if (performance.now() - this.barrierRepairReqSentAtMs > 1200) {
        this.barrierRepairPendingRequest = false;
      }
      return;
    }

    // Hold [F] for 0.78s per plank replaced -> +5 PTS per plank
    this.barrierRepairProgress += dt / 0.78;
    if (this.barrierRepairProgress >= 1.0) {
      this.barrierRepairProgress = 0;
      if (this.mp && !this.isMpHost) {
        this.barrierRepairPendingRequest = true;
        this.barrierRepairReqSentAtMs = performance.now();
        const reqPkt: GameBarrierRepairRequestPacket = {
          type: 'game:barrier_repair_request',
          barrierId: barrier.id,
          ts: Date.now(),
        };
        this.mp.sendMessage(reqPkt as unknown as Record<string, unknown>);
      } else if (barrier.repairPlank()) {
        this.addPoints(5, 'BARRIER REPAIR');
        this._tmpBarrierPos.set(barrier.sillPos[0], barrier.sillPos[1], barrier.sillPos[2]);
        this.audio.playImpact(this._tmpBarrierPos, 'wood');
        this.audio.playGearRattle('weapon_swap', 0.35);
        if (this.mp && this.isMpHost) {
          const updPkt: GameBarrierUpdatePacket = {
            type: 'game:barrier_update',
            barrierId: barrier.id,
            planksRemaining: barrier.getPlanksRemaining(),
            repairedByUserId: this.mp.localUserId,
            pointsAwarded: 5,
            ts: Date.now(),
          };
          this.mp.sendMessage(updPkt as unknown as Record<string, unknown>);
        }
        this.emitSnapshot();
      }
    }
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

    if (it.kind === 'window_barrier') {
      const barrier = this.zombieAI?.getBarrierById(it.barrierId ?? it.id);
      if (!barrier || barrier.getPlanksRemaining() >= barrier.maxPlanks) return null;
      const planks = barrier.getPlanksRemaining();
      return {
        id: it.id,
        kind: it.kind,
        label: barrier.label,
        actionText: `Repair ${barrier.label} (+5 PTS / Plank)`,
        cost: 0,
        canAfford: true,
        blockedReason: null,
        isHoldAction: true,
        holdProgress: this.repairingBarrierId === barrier.id ? this.barrierRepairProgress : 0,
        planksRemaining: planks,
        maxPlanks: barrier.maxPlanks,
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
      this.syncBotInfectionZones();
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
    if (!this.playerAlive || this.pdaDevice.isBlockingWeaponActions() || this.weaponRig.isSuppressorActionActive()) return;
    const prof = this._runtimeProfile;
    if (prof.magCapacity <= 0 || this.reloadTimer > 0 || this.weaponRig.isTubularReloading() || this.controller.isVaulting()) return;
    const curMag = this.magAmmoByWeapon[prof.id] ?? 0;
    if (curMag >= prof.magCapacity) return;

    const reserve = this.reserveAmmoByWeapon[prof.id] ?? -1;
    if (reserve === 0) {
      this.showToast('No Reserve Ammo — Buy Ammo at Wall-Buy');
      return;
    }

    const isTubularShotgun = prof.holdClass === 'shotgun' && prof.fireMode === 'pump';
    if (isTubularShotgun) {
      const missing = prof.magCapacity - curMag;
      const shellsToLoad = reserve < 0 ? missing : Math.min(missing, reserve);
      if (shellsToLoad <= 0) return;
      const weaponId = prof.id;
      const started = this.weaponRig.triggerTubularReload(
        shellsToLoad,
        curMag === 0,
        () => {
          if (this._runtimeProfile.id !== weaponId || !this.playerAlive) return;
          const resNow = this.reserveAmmoByWeapon[weaponId] ?? -1;
          if (resNow === 0) {
            this.weaponRig.interruptTubularReload();
            return;
          }
          const magNow = this.magAmmoByWeapon[weaponId] ?? 0;
          if (magNow >= prof.magCapacity) return;
          this.magAmmoByWeapon[weaponId] = magNow + 1;
          if (resNow > 0) {
            this.reserveAmmoByWeapon[weaponId] = resNow - 1;
          }
          this.weaponRig.setAmmoState(magNow + 1);
          this.emitSnapshot();
        },
        () => {
          this.emitSnapshot();
        },
      );
      if (started) {
        this.emitSnapshot();
      }
      return;
    }

    this.reloadTimer = prof.reloadDurationSec;
    this.animator.triggerReload(prof.reloadDurationSec);
    this.emitSnapshot();
  }

  private attemptFire(): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
    if (
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive() ||
      this.grenadeSystem.isDrawn()
    ) {
      return;
    }
    const prof = this._runtimeProfile;

    if (prof.holdClass === 'unarmed') {
      if (this.semiTriggerConsumed || this.controller.isVaulting()) return;
      const punch = this.animator.triggerUnarmedPunch(
        this.controller,
        this.input.ads,
      );
      if (punch) {
        this.semiTriggerConsumed = true;
        this.stamina = Math.max(0, this.stamina - 0.05);
      }
      return;
    }

    if (prof.fireMode === 'none' || prof.magCapacity <= 0) return;
    const curAmmo = this.magAmmoByWeapon[prof.id] ?? 0;
    if (this.weaponRig.isTubularReloading()) {
      if (curAmmo > 0 && !this.controller.isSprinting && !this.controller.isVaulting()) {
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

    const isSingle = prof.fireMode === 'semi' || prof.fireMode === 'bolt' || prof.fireMode === 'pump';
    if (isSingle && this.semiTriggerConsumed) return;

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
    this.weaponRig.triggerTacticalSwitch();
    this.audio.playTacticalSwitchClick(this.flashlightOn);
    this.emitSnapshot();
  }

  private toggleLaser(): void {
    if (!this.weaponRig.getDerivedStats().hasLaser) return;
    this.weaponRig.laserOn = !this.weaponRig.laserOn;
    this.weaponRig.triggerTacticalSwitch();
    this.audio.playTacticalSwitchClick(this.weaponRig.laserOn);
    this.emitSnapshot();
  }

  public toggleSuppressor(): void {
    if (
      !this.playerAlive ||
      this.gameOver ||
      this.matchOutcome !== 'active' ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.controller.isVaulting() ||
      this.reloadTimer > 0 ||
      this.weaponRig.isTubularReloading()
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

  private clearHeldControlInputs(): void {
    this.isFiring = false;
    this.semiTriggerConsumed = false;
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
    this.interactKeyHeld = false;
    this.repairingBarrierId = null;
    this.barrierRepairProgress = 0;
    this.barrierRepairPendingRequest = false;
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
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active') return;
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
    const active = this.playerAlive && mount !== 'none' && this.nvgFlipped;
    const irActive = active && this.irIlluminatorOn;
    this.skeleton.setNvgFlipped(active);
    this.postProcess.setNvgState(mount, active, irActive);
    this.irIlluminatorLight.visible = irActive;
    this.weaponRig.setNvgOpticalActive(active);
    this.weaponRig.setIrLaserActive(irActive);
    this.audio.setNvgTubeHum(active);
  }

  private toggleNvg(): void {
    if (!this.playerAlive || this.gameOver || this.matchOutcome !== 'active' || this.tunerOpen) {
      return;
    }
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
    if (this.mp) {
      this.broadcastLocalState20Hz();
    }
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
    if (!this.pointerLocked || !this.playerAlive) return;
    if (Math.abs(e.movementX) > 0.5 || Math.abs(e.movementY) > 0.5) {
      this.idleSinceInputSec = 0;
    }
    const dx = THREE.MathUtils.clamp(e.movementX, -140, 140);
    const dy = THREE.MathUtils.clamp(e.movementY, -140, 140);
    if (this.pdaDevice.isOpen() && this.pdaDevice.isDragging()) {
      this.pdaDevice.applyDragDelta(dx, dy);
      return;
    }
    this.controller.handleMouseMove(dx, dy, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    this.idleSinceInputSec = 0;
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

    if (this.pdaDevice.isBlockingWeaponActions()) {
      if (e.button === 0 && this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
      } else if (e.button === 2 && this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      }
      return;
    }

    // Authentic 4-stage grenade Manual of Arms when grenade is drawn
    if (this.grenadeSystem.isDrawn()) {
      this.input.ads = false;
      const stage = this.grenadeSystem.getHoldStage();
      const equipId = this.grenadeSystem.getCookingEquipmentId() ?? this.tacticalEquipmentId;
      if (e.button === 2) {
        if (stage === 'DRAWN') {
          if (this.grenadeSystem.pullPin()) {
            this.camera.getWorldPosition(this._grenadeThrowOrigin);
            this.sendLocalGrenadeEvent('pin_pull', equipId, this._grenadeThrowOrigin);
            this.emitSnapshot();
          }
        } else if (stage === 'PIN_PULLED') {
          if (this.grenadeSystem.releaseLever()) {
            this.camera.getWorldPosition(this._grenadeThrowOrigin);
            this.camera.getWorldDirection(this._grenadeThrowDir);
            this.sendLocalGrenadeEvent(
              'spoon_pop',
              equipId,
              this._grenadeThrowOrigin,
              this._grenadeThrowDir,
            );
            this.emitSnapshot();
          }
        }
      } else if (e.button === 0 && (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED')) {
        this.grenadeSystem.beginThrowInput();
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
    if (this.pointerLocked && this.pdaDevice.isOpen()) {
      e.preventDefault();
      this.pdaDevice.applyWheel(e.deltaY);
      return;
    }
    if (this.pointerLocked && this.activeDoorPrompt && this.activeDoorPrompt.options.length > 1) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const len = this.activeDoorPrompt.options.length;
      this.doorSelectedOptionIndex = (this.doorSelectedOptionIndex + dir + len) % len;
      this.activeDoorPrompt = {
        ...this.activeDoorPrompt,
        selectedIndex: this.doorSelectedOptionIndex,
      };
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.2 });
      this.emitSnapshot();
      return;
    }
    if (this.pointerLocked && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
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
    this.idleSinceInputSec = 0;
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
        this.interactKeyHeld = true;
        if (!e.repeat) {
          if (this.activeDoorId && this.activeDoorPrompt) {
            this.executeSelectedDoorOption();
          } else if (this.params.mode === 'infection' && this.nearbyInteractable) {
            // Window barriers use continuous Hold [F] repair; all other interactables trigger on press
            if (this.nearbyInteractable.kind !== 'window_barrier') {
              this.triggerInteract();
            }
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
        if (!e.repeat) {
          if (this.pdaDevice.isOpen()) {
            this.pdaDevice.recenterOnPlayer();
          } else {
            this.startReload();
          }
        }
        break;
      case 'KeyM':
        if (!e.repeat) this.togglePda();
        break;
      case 'KeyG':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) this.toggleSuppressor();
        break;
      case 'KeyB':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions() && this.weaponRig.hasCantedOptic()) {
          const id = this._runtimeProfile.id;
          const next: AdsMode = (this.adsModeByWeapon[id] ?? 'PRIMARY') === 'CANTED' ? 'PRIMARY' : 'CANTED';
          this.adsModeByWeapon[id] = next;
          this.input.adsMode = next;
          this.audio.playGearRattle('weapon_swap', 0.4);
          this.emitSnapshot();
        }
        break;
      case 'KeyJ':
        if (!e.repeat) this.toggleNvg();
        break;
      case 'KeyN':
        if (!e.repeat) {
          if (this.nvgFlipped && !e.altKey) {
            this.toggleIrIlluminator();
          } else if (!this.pdaDevice.isBlockingWeaponActions()) {
            this.weaponRig.toggleReticleIllumination();
            this.audio.playTacticalSwitchClick(true);
            this.emitSnapshot();
          }
        }
        break;
      case 'KeyV':
        if (
          !e.repeat &&
          !this.pdaDevice.isBlockingWeaponActions() &&
          !this.controller.isVaulting() &&
          !this.weaponRig.isSuppressorActionActive()
        ) {
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
            this.lastKickHandlingTimer = 0.48;
          }
        }
        break;
      case 'BracketRight':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          this.weaponRig.cycleOpticZoom(1, true);
          this.emitSnapshot();
        }
        break;
      case 'BracketLeft':
        if (!e.repeat && !this.controller.isSprinting && this.weaponRig.hasVariableZoom()) {
          this.weaponRig.cycleOpticZoom(-1, true);
          this.emitSnapshot();
        }
        break;
      case 'KeyZ':
        if (!e.repeat) {
          this.triggerTacticalPing();
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

  /**
   * Tactical Ping System (Z Key): auto-detects enemies (bots, zombies, hostile remote players),
   * interactive stations/items (wall-buys, mystery crate, perks, power, doors, barriers),
   * or static world locations up to 120m.
   */
  private triggerTacticalPing(): void {
    if (this.pingCooldownSec > 0 || !this.playerAlive || this.gameOver || this.matchOutcome !== 'active') {
      return;
    }
    this.pingCooldownSec = 0.25;

    this.camera.updateMatrixWorld();
    this._pingRaycaster.setFromCamera(this._pingCenterNdc, this.camera);
    this._pingRaycaster.near = 0.2;
    this._pingRaycaster.far = 120;
    this._pingRayOrigin.copy(this._pingRaycaster.ray.origin);
    this._pingRayDir.copy(this._pingRaycaster.ray.direction);

    // 1. Find closest static world surface hit to use as occlusion limit & fallback location mark
    this._pingHits.length = 0;
    this._pingRaycaster.intersectObjects(this.map.raycastMeshes, false, this._pingHits);
    const worldHit = this._pingHits.length > 0 ? this._pingHits[0] : null;
    const maxUnoccludedDist = worldHit ? worldHit.distance + 0.35 : 120;

    let kind: TacticalPingKind = 'location';
    let label = 'MARK';
    let targetEntityType: TacticalPingTargetType | null = null;
    let targetEntityId: string | null = null;
    let chosenDist = Infinity;
    const pingPos = this._pingTrackPos.set(0, 0, 0);
    let foundHit = false;

    // 2. Priority 1: Hostile combatants (AI bots, zombies, hostile remote players)
    const testEnemyMeshes = (meshes: THREE.Object3D[]): void => {
      if (meshes.length === 0) return;
      this._pingHits.length = 0;
      this._pingRaycaster.intersectObjects(meshes, false, this._pingHits);
      for (let i = 0; i < this._pingHits.length; i++) {
        const hit = this._pingHits[i];
        if (hit.distance > maxUnoccludedDist || hit.distance >= chosenDist) break;
        const ud = hit.object.userData;
        const actorType = ud?.combatActorType as string | undefined;
        const actorId = ud?.combatActorId as string | undefined;
        if (!actorType || !actorId) continue;

        if (actorType === 'bot' && this.botAI) {
          const info = this.botAI.getBotInfo(actorId);
          if (!info || !info.alive) continue;
          // Do not mark allied bots as enemies in TDM or co-op Infection
          if (
            this.params.mode === 'infection' ||
            (this.params.mode === 'battle' &&
              this.params.battleConfig.rule === 'tdm' &&
              info.team === this.localBattleTeam)
          ) {
            continue;
          }
          chosenDist = hit.distance;
          kind = 'enemy';
          label = info.name.toUpperCase().slice(0, 18) || 'HOSTILE';
          targetEntityType = 'bot';
          targetEntityId = info.id;
          if (!this.botAI.getBotHeadPosition(info.id, pingPos)) {
            pingPos.copy(hit.point);
            pingPos.y += 0.45;
          }
          foundHit = true;
          break;
        }

        if (actorType === 'zombie' && this.zombieAI) {
          chosenDist = hit.distance;
          kind = 'enemy';
          label = 'INFECTED';
          targetEntityType = 'zombie';
          targetEntityId = actorId;
          if (!this.zombieAI.getZombieHeadPosition(actorId, pingPos)) {
            pingPos.copy(hit.point);
            pingPos.y += 0.45;
          }
          foundHit = true;
          break;
        }

        if (actorType === 'remote_player' && this.remotePlayers) {
          if (this.remotePlayers.isFriendly(actorId)) continue;
          const info = this.remotePlayers.getPlayerInfo(actorId);
          if (!info || !info.alive) continue;
          chosenDist = hit.distance;
          kind = 'enemy';
          label = info.username.toUpperCase().slice(0, 18) || 'HOSTILE';
          targetEntityType = 'remote_player';
          targetEntityId = info.userId;
          if (!this.remotePlayers.getPlayerHeadPosition(info.userId, pingPos)) {
            pingPos.copy(hit.point);
            pingPos.y += 0.45;
          }
          foundHit = true;
          break;
        }
      }
    };

    if (this.botAI) testEnemyMeshes(this.botAI.getHitMeshes());
    if (this.zombieAI) testEnemyMeshes(this.zombieAI.getHitMeshes());
    if (this.remotePlayers) testEnemyMeshes(this.remotePlayers.getHitMeshes());

    // 3. Priority 2: Items, Weapon Wall-Buys, Mystery Crate, Perks, Power, Doors & Barriers
    if (!foundHit && this.map.interactables.length > 0) {
      let bestItem: MapInteractable | null = null;
      let bestItemDist = Math.min(40, maxUnoccludedDist + 1.25);

      for (let i = 0; i < this.map.interactables.length; i++) {
        const it = this.map.interactables[i];
        if (
          it.activated &&
          (it.kind === 'buyable_door' || it.kind === 'power_switch' || it.kind === 'perk_machine')
        ) {
          continue;
        }
        const tx = it.position[0] - this._pingRayOrigin.x;
        const ty = it.position[1] + 0.35 - this._pingRayOrigin.y;
        const tz = it.position[2] - this._pingRayOrigin.z;
        const along = tx * this._pingRayDir.x + ty * this._pingRayDir.y + tz * this._pingRayDir.z;
        if (along < 0.6 || along > bestItemDist) continue;

        const perpX = tx - this._pingRayDir.x * along;
        const perpY = ty - this._pingRayDir.y * along;
        const perpZ = tz - this._pingRayDir.z * along;
        const perpDistSq = perpX * perpX + perpY * perpY + perpZ * perpZ;
        const hitRadius = Math.min(1.15, Math.max(0.55, along * 0.045));
        if (perpDistSq <= hitRadius * hitRadius) {
          bestItem = it;
          bestItemDist = along;
        }
      }

      if (bestItem) {
        kind = 'item';
        label = bestItem.label.toUpperCase().slice(0, 26);
        pingPos.set(bestItem.position[0], bestItem.position[1] + 0.55, bestItem.position[2]);
        foundHit = true;
      }
    }

    // 4. Priority 3: Static world surface location
    if (!foundHit) {
      if (!worldHit) return;
      kind = 'location';
      label = 'MARK';
      pingPos.copy(worldHit.point);
      pingPos.y += 0.14;
      foundHit = true;
    }

    const senderId = this.mp?.localUserId ?? 'local';
    const senderName = this.mp?.localUsername ?? 'YOU';
    const pingId = `${senderId}:${this.nextLocalPingSeq++}`;

    this.upsertTacticalPing({
      id: pingId,
      senderId,
      senderName,
      isLocal: true,
      kind,
      label,
      worldPos: pingPos.clone(),
      targetEntityType,
      targetEntityId,
      ageSec: 0,
      durationSec: 10.0,
      lostTargetTimer: 0,
    });

    this.audio.playTacticalPing(kind);
    // Allied AI bots acknowledge and respond to the player's tactical ping
    if (this.params.mode === 'infection' || (this.params.mode === 'battle' && this.params.battleConfig.rule === 'tdm')) {
      this.botAI?.notifyPlayerPing(kind, pingPos, label);
    }

    if (this.mp) {
      const pkt: GameTacticalPingPacket = {
        type: 'game:ping',
        pingId,
        kind,
        label,
        x: pingPos.x,
        y: pingPos.y,
        z: pingPos.z,
        targetEntityType,
        targetEntityId,
        ts: Date.now(),
      };
      this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
    }

    this.updateAndProjectPings(0);
    this.emitSnapshot();
  }

  private pushSquadComms(callsign: string, category: SquadCommsCategory, text: string): void {
    const now = performance.now();
    this.squadComms = this.squadComms.filter((m) => now - m.timestampMs < 7500);
    this.squadComms.push({
      id: this.nextSquadCommsId++,
      callsign: callsign.toUpperCase().slice(0, 16),
      category,
      text: text.slice(0, 84),
      timestampMs: now,
    });
    if (this.squadComms.length > 4) {
      this.squadComms.shift();
    }
  }

  private handleLocalBotComms(ev: BotCommsEvent): void {
    if (this.params.mode === 'battle' && this.params.battleConfig.rule === 'ffa') return;

    // Broadcast to multiplayer clients first if host (clients filter by their own team)
    if (this.mp && this.isMpHost) {
      const pkt: GameBotCommsPacket = {
        type: 'game:bot_comms',
        botId: ev.botId,
        callsign: ev.callsign,
        team: ev.team,
        category: ev.category,
        text: ev.text,
        pingKind: ev.pingKind ?? null,
        pingLabel: ev.pingLabel ?? null,
        px: ev.pingPos ? Number(ev.pingPos.x.toFixed(2)) : undefined,
        py: ev.pingPos ? Number(ev.pingPos.y.toFixed(2)) : undefined,
        pz: ev.pingPos ? Number(ev.pingPos.z.toFixed(2)) : undefined,
        ts: Date.now(),
      };
      this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
    }

    // Filter local HUD/audio/ping display to allied team only
    if (this.params.mode === 'battle' && ev.team !== this.localBattleTeam) return;

    this.pushSquadComms(ev.callsign, ev.category, ev.text);
    this.audio.playSquadRadioChirp(ev.category);

    if (ev.pingKind && ev.pingPos) {
      this.upsertTacticalPing({
        id: `bot:${ev.botId}:${this.nextSquadCommsId}`,
        senderId: `bot:${ev.botId}`,
        senderName: ev.callsign,
        isLocal: false,
        kind: ev.pingKind,
        label: (ev.pingLabel || 'CONTACT').toUpperCase().slice(0, 26),
        worldPos: ev.pingPos.clone(),
        targetEntityType: null,
        targetEntityId: null,
        ageSec: 0,
        durationSec: 8.5,
        lostTargetTimer: 0,
      });
    }
    this.emitSnapshot();
  }

  private handleRemoteTacticalPing(pkt: GameTacticalPingPacket): void {
    if (!this.mp) return;
    if (!pkt.senderUserId || pkt.senderUserId === this.mp.localUserId) return;

    // Visibility rules: FFA hides opponent pings; Battle TDM only shows teammates; Infection shows all squadmates
    if (this.params.mode === 'battle') {
      if (this.params.battleConfig.rule === 'ffa') return;
      if (pkt.senderTeam && pkt.senderTeam !== this.localBattleTeam) return;
    }

    this.upsertTacticalPing({
      id: pkt.pingId,
      senderId: pkt.senderUserId,
      senderName: (pkt.senderUsername ?? 'ALLY').slice(0, 16),
      isLocal: false,
      kind: pkt.kind,
      label: (pkt.label || 'MARK').toUpperCase().slice(0, 26),
      worldPos: new THREE.Vector3(pkt.x, pkt.y, pkt.z),
      targetEntityType: pkt.targetEntityType ?? null,
      targetEntityId: pkt.targetEntityId ?? null,
      ageSec: 0,
      durationSec: 10.0,
      lostTargetTimer: 0,
    });

    this.audio.playTacticalPing(pkt.kind);
  }

  private upsertTacticalPing(nextPing: ActiveTacticalPing): void {
    // Each operator maintains 1 active ping at a time (re-pinging cleanly moves their marker)
    for (let i = this.activePings.length - 1; i >= 0; i--) {
      if (this.activePings[i].senderId === nextPing.senderId) {
        this.activePings.splice(i, 1);
      }
    }
    this.activePings.push(nextPing);
    if (this.activePings.length > 4) {
      this.activePings.shift();
    }
  }

  private updateAndProjectPings(dt: number): void {
    if (this.pingCooldownSec > 0) {
      this.pingCooldownSec = Math.max(0, this.pingCooldownSec - dt);
    }

    if (this.activePings.length === 0) {
      if (this.projectedPings.length > 0) {
        this.projectedPings = [];
      }
      return;
    }

    this.camera.getWorldDirection(this._pingCamFwd);
    const camPos = this.camera.position;
    const out: ProjectedTacticalPing[] = [];

    for (let i = this.activePings.length - 1; i >= 0; i--) {
      const p = this.activePings[i];
      p.ageSec += dt;

      // Live tracking for moving enemies
      if (p.kind === 'enemy' && p.targetEntityType && p.targetEntityId) {
        let aliveTracked = false;
        if (p.targetEntityType === 'bot' && this.botAI) {
          aliveTracked = this.botAI.getBotHeadPosition(p.targetEntityId, this._pingTrackPos);
        } else if (p.targetEntityType === 'zombie' && this.zombieAI) {
          aliveTracked = this.zombieAI.getZombieHeadPosition(p.targetEntityId, this._pingTrackPos);
        } else if (p.targetEntityType === 'remote_player' && this.remotePlayers) {
          aliveTracked = this.remotePlayers.getPlayerHeadPosition(
            p.targetEntityId,
            this._pingTrackPos,
          );
        }

        if (aliveTracked) {
          p.worldPos.copy(this._pingTrackPos);
          p.lostTargetTimer = 0;
        } else {
          p.lostTargetTimer += dt;
          // Clear enemy ping swiftly once target is eliminated
          if (p.lostTargetTimer >= 0.4) {
            this.activePings.splice(i, 1);
            continue;
          }
        }
      }

      if (p.ageSec >= p.durationSec) {
        this.activePings.splice(i, 1);
        continue;
      }

      this._pingToTarget.subVectors(p.worldPos, camPos);
      const distM = this._pingToTarget.length();
      const inFront = this._pingToTarget.dot(this._pingCamFwd) > 0.05;

      this._pingProjVec.copy(p.worldPos).project(this.camera);
      let sx = (this._pingProjVec.x * 0.5 + 0.5) * 100;
      let sy = (-this._pingProjVec.y * 0.5 + 0.5) * 100;
      let offscreen = false;

      if (!inFront || sx < 4 || sx > 96 || sy < 5 || sy > 95) {
        offscreen = true;
        if (!inFront) {
          sx = 100 - sx;
          sy = 100 - sy;
          // Push to edge cleanly when behind camera
          const dx = sx - 50;
          const dy = sy - 50;
          const len = Math.max(0.001, Math.hypot(dx, dy));
          sx = 50 + (dx / len) * 46;
          sy = 50 + (dy / len) * 44;
        }
        sx = THREE.MathUtils.clamp(sx, 4.5, 95.5);
        sy = THREE.MathUtils.clamp(sy, 6.0, 93.0);
      }

      // Smooth distance fade (100% crisp up to 14m, fading smoothly to 24% at 95m+)
      const distFade =
        distM <= 14 ? 1.0 : Math.max(0.24, 1.0 - ((distM - 14) / 81) * 0.76);
      // Graceful fade-out over the last 1.5s of lifetime
      const timeLeft = p.durationSec - p.ageSec;
      const expiryFade = timeLeft < 1.5 ? Math.max(0, timeLeft / 1.5) : 1.0;
      const opacity = Number((distFade * expiryFade * (offscreen ? 0.62 : 1.0)).toFixed(3));
      const scale = Number(THREE.MathUtils.clamp(1.04 - (distM / 110) * 0.30, 0.72, 1.04).toFixed(3));

      out.push({
        id: p.id,
        kind: p.kind,
        label: p.label,
        senderName: p.senderName,
        isLocal: p.isLocal,
        screenX: Number(sx.toFixed(2)),
        screenY: Number(sy.toFixed(2)),
        offscreen,
        distanceM: Math.round(distM),
        opacity,
        scale,
        ageRatio: Number(Math.min(1, p.ageSec / p.durationSec).toFixed(3)),
      });
    }

    this.projectedPings = out;
  }

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
      case 'KeyF':
        this.interactKeyHeld = false;
        this.repairingBarrierId = null;
        this.barrierRepairProgress = 0;
        this.barrierRepairPendingRequest = false;
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
        this.syncNvgRuntime();
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
            glovesEnabled: this.localGear.glovesEnabled,
            gloveColor: this.localGear.gloveColor,
            helmetType: this.localGear.helmetType,
            helmetColor: this.localGear.helmetColor,
            nvgMount: this.localGear.nvgMount,
            nvgFlipped: this.nvgFlipped && this.localGear.nvgMount !== 'none',
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
    const pdaBusy = this.pdaDevice.isBlockingWeaponActions();
    const grenadeDrawn = this.grenadeSystem.isDrawn();
    if (suppBusy || pdaBusy || grenadeDrawn) {
      this.input.ads = false;
    }
    const baseAdsMode = this.adsModeByWeapon[prof.id] ?? 'PRIMARY';
    const nodsForceCant =
      this.nvgFlipped &&
      this.localGear.nvgMount !== 'none' &&
      this.input.ads &&
      baseAdsMode === 'PRIMARY' &&
      this.weaponRig.shouldForceNodsCantedAim(true);
    this.input.adsMode = nodsForceCant ? 'POINT_AIM' : baseAdsMode;
    const firearmAdsBlocking = this.input.ads && prof.holdClass !== 'unarmed' && !grenadeDrawn;
    this.input.sprint = !suppBusy && !pdaBusy && this.shiftHeld && !firearmAdsBlocking;
    this.input.holdBreath = !suppBusy && !pdaBusy && this.input.ads && (this.shiftHeld || this.altHeld);

    // In multiplayer, world stays live continuously even when Esc pause overlay is open
    const simActive =
      (this.mp ? true : this.pointerLocked && !this.tunerOpen) &&
      !this.gameOver &&
      this.matchOutcome === 'active';

    if (simActive) {
      this.matchDurationSec += dt;
      const anyHeldInput =
        this.input.forward ||
        this.input.backward ||
        this.input.left ||
        this.input.right ||
        this.input.ads ||
        this.isFiring ||
        this.input.vault ||
        this.interactKeyHeld;
      if (anyHeldInput && this.pointerLocked) {
        this.idleSinceInputSec = 0;
      } else {
        this.idleSinceInputSec += dt;
        if (this.idleSinceInputSec >= 8.0) {
          this.playerAfkSeconds += dt;
        }
      }
    }

    // Step player controller, 3D PDA telemetry + choreography, & IK animator
    if (this.playerAlive) {
      this.controller.setGrenadeTension(
        this.grenadeSystem.getCharge01(),
        this.grenadeSystem.isLeverReleased(),
        this.grenadeSystem.getThrowStyle(),
      );
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

      this.updatePdaTelemetry(dt);
      if (this.lastKickHandlingTimer > 0) {
        this.lastKickHandlingTimer = Math.max(0, this.lastKickHandlingTimer - dt);
      }
      if (this.interactAnimator.isActive()) {
        const active = this.interactAnimator.update(dt, this.camera);
        this.animator.setExternalHandOverride(active ? this.interactAnimator.ikOverride : null);
      } else {
        this.animator.setExternalHandOverride(null);
      }
      this.animator.update(dt, this.elapsedSec, this.controller, this.adapter, prof, this.input.ads);
      this.animator.applyCameraAdditiveOverlay(this.camera);
    } else {
      if (this.pdaDevice.isOpen()) {
        this.pdaDevice.setOpen(false);
      }
      if (this.postProcess.isNvgActive() || this.irIlluminatorLight.visible) {
        this.syncNvgRuntime();
      }
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

    this.weaponRig.root.visible =
      this.playerAlive &&
      !this.grenadeSystem.isWeaponHidden() &&
      !this.pdaDevice.isWeaponHidden();
    this.skeleton.root.visible = this.playerAlive || this.playerRagdoll.isActive();

    // Step drift-free 20 Hz multiplayer broadcast (+ immediate flush on stance/fire/reload/grenade transitions)
    if (this.mp && this.remotePlayers) {
      this.netSendAccum += dt;
      const nowPerf = performance.now();
      const stanceChanged = this.controller.aimStance !== this.lastSentStance;
      const firingChanged = this.isLocallyActivelyFiring() !== this.lastSentFiring;
      const reloadChanged =
        (this.reloadTimer > 0 || this.weaponRig.isTubularReloading()) !== this.lastSentReloading;
      const localHandlingNow: SyncedHandlingAction =
        this.lastKickHandlingTimer > 0
          ? 'DOOR_KICK'
          : this.interactAnimator.isActive()
            ? this.interactAnimator.getSyncedHandlingAction().action
            : this.weaponRig.getSyncedHandlingSnapshot().action;
      const handlingActionChanged = localHandlingNow !== this.lastSentHandlingAction;
      const grenadeStageChanged =
        this.grenadeSystem.getHoldStage() !== this.lastSentGrenadeStage ||
        this.grenadeSystem.isThrowInputHeld() !== this.lastSentGrenadeThrowHeld;
      const urgentTransition =
        (stanceChanged ||
          firingChanged ||
          reloadChanged ||
          handlingActionChanged ||
          grenadeStageChanged) &&
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

      this.remotePlayers.update(dt, this.camera.position, this.worldOnlyRaycastFn ?? undefined);
    }

    // Step map animated fixtures, physical destructible doors & dynamic 5x weather/day-night system
    this.map.update?.(dt, this.elapsedSec);
    this.map.penetrableSystem?.update(dt, this.camera.position);
    if (this.map.doorSystem) {
      this.map.doorSystem.update(dt, this.camera.position);
      this.updateDoorInteractScan();
    }
    if (this.weatherTime) {
      this.weatherTime.update(dt, this.camera.position, this.isMpHost || !this.mp);
      if (this.mp && this.isMpHost) {
        this.envSyncAccum += dt;
        if (this.envSyncAccum >= 1.0) {
          this.envSyncAccum = 0;
          const st = this.weatherTime.getSyncState();
          const envPkt: GameEnvSyncPacket = {
            type: 'game:env_sync',
            timeOfDayHours: st.gameTimeHours,
            currentWeather: st.activeWeather,
            targetWeather: st.targetWeather,
            transitionProgress: st.transitionAlpha,
            weatherHoldRemainingSec: 0,
            windDirRad: st.windAngleRad,
            windSpeedMps: st.windSpeedMps,
            rainIntensity:
              st.activeWeather === 'stormy' ? 1 : st.activeWeather === 'rainy' ? 0.65 : 0,
            wetness: st.wetness,
            lightningFlash: 0,
            ts: Date.now(),
          };
          this.mp.sendMessage(envPkt as unknown as Record<string, unknown>);
        }
      }
    }

    // Step BallisticsSolver & Tactical Grenade Physics
    this.ballistics.update(dt, this.adapter, (ev) => this.handleBallisticImpact(ev));
    this._grenadeThrowOrigin.set(
      this.controller.position.x,
      this.controller.position.y + 1.28,
      this.controller.position.z,
    );
    const wasLiveBefore = this.grenadeSystem.isLeverReleased();
    const liveEquipBefore = this.grenadeSystem.getCookingEquipmentId() ?? this.tacticalEquipmentId;
    this.grenadeSystem.update(dt, this._grenadeThrowOrigin);
    const launched = this.grenadeSystem.consumeLastLaunchedThrow();
    if (launched) {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.audio.playGearRattle('weapon_swap', 0.65);
      this.sendLocalGrenadeEvent(
        'throw',
        launched.equipmentId,
        launched.origin,
        launched.velocity,
        launched.fuseRemainingSec,
      );
      this.emitSnapshot();
    } else if (wasLiveBefore && !this.grenadeSystem.isLeverReleased()) {
      this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      this.syncBeltEquipmentMesh();
      this.sendLocalGrenadeEvent('in_hand_detonate', liveEquipBefore, this._grenadeThrowOrigin);
      this.emitSnapshot();
    }

    // Step active AI system (Host-authoritative in multiplayer; Infection supports friendly AI squadmates)
    if (simActive) {
      const localId = this.mp?.localUserId ?? 'player';
      const remoteHumans = this.remotePlayers?.getAliveHumanTargets() ?? [];
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
      const onHostBotFire =
        this.mp && this.isMpHost
          ? (
              botId: string,
              origin: Readonly<THREE.Vector3>,
              end: Readonly<THREE.Vector3>,
              meta?: { weaponId: string; caliberId: string; suppressed: boolean },
            ) => {
              const firePkt: GameBotFirePacket = {
                type: 'game:bot_fire',
                botId,
                ox: Number(origin.x.toFixed(3)),
                oy: Number(origin.y.toFixed(3)),
                oz: Number(origin.z.toFixed(3)),
                ex: Number(end.x.toFixed(3)),
                ey: Number(end.y.toFixed(3)),
                ez: Number(end.z.toFixed(3)),
                weaponId: meta?.weaponId,
                caliberId: meta?.caliberId,
                sup: meta?.suppressed,
                ts: Date.now(),
              };
              this.mp!.sendMessage(firePkt as unknown as Record<string, unknown>);
            }
          : undefined;

      if (this.params.mode === 'battle' && this.botAI) {
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
              if (this.playerAlive) {
                const estEnergyJ = this.estimateEnergyFromWeaponOrDamage(
                  dmgEv.weaponId,
                  dmgEv.caliberId,
                  dmgEv.damage,
                );
                this.tryRollLocalBeltGrenadeImpact(
                  dmgEv.attackerName,
                  dmgEv.attackerTeam,
                  dmgEv.attackerId,
                  true,
                  estEnergyJ,
                  false,
                );
              }
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
          onHostBotFire,
          (a, b) => this.grenadeSystem.isLineBlockedBySmoke(a, b),
          () => this.grenadeSystem.getActiveSmokeClouds(),
        );
        this.checkBattleVictory();
      } else if (this.params.mode === 'infection' && this.zombieAI) {
        const allyBotTargets = this.botAI ? this.botAI.getAliveAllyTargets() : [];
        const infectionTargets: InfectionHumanTarget[] = [
          { id: localId, pos: this.controller.position, alive: this.playerAlive },
          ...remoteHumans.map((r) => ({ id: r.id, pos: r.pos, alive: r.alive })),
          ...allyBotTargets,
        ];

        // Check full human squad wipe when local player is spectating in Co-op Infection
        if (this.mp && this.spectating && !this.playerAlive && remoteHumans.length === 0) {
          this.triggerInfectionGameOver();
        }

        this.zombieAI.update(
          dt,
          this.controller.position,
          this.playerAlive,
          (dmg, _attackerPos, targetUserId) => {
            if (targetUserId && targetUserId.startsWith('bot_')) {
              this.botAI?.applyZombieDamageToBot(targetUserId, dmg);
            } else if (!targetUserId || targetUserId === localId || targetUserId === 'player') {
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
            this.botAI?.reviveAllDownedBots(this.controller.position);
            this.botAI?.replenishBotGrenades();
            this.botAI?.awardInfectionRoundBonus(bonus, completedRound);
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
          infectionTargets,
          this.mp && this.isMpHost
            ? (spawnPkt) => {
                this.mp!.sendMessage(spawnPkt as unknown as Record<string, unknown>);
              }
            : undefined,
          this.mp && this.isMpHost
            ? (barrierId, planksRemaining) => {
                const updPkt: GameBarrierUpdatePacket = {
                  type: 'game:barrier_update',
                  barrierId,
                  planksRemaining,
                  ts: Date.now(),
                };
                this.mp!.sendMessage(updPkt as unknown as Record<string, unknown>);
              }
            : undefined,
        );

        // Step friendly co-op AI squadmates fighting alongside humans against the zombie horde
        if (this.botAI) {
          const zombieTargets = this.zombieAI.getAliveZombieTargets();
          const roundState = this.zombieAI.getRoundState();
          this.botAI.update(
            dt,
            this.controller.position,
            this.playerAlive,
            true,
            () => {
              // Friendly Infection bots never deal damage to human squadmates
            },
            battleHumans,
            onHostBotFire,
            (a, b) => this.grenadeSystem.isLineBlockedBySmoke(a, b),
            () => this.grenadeSystem.getActiveSmokeClouds(),
            zombieTargets,
            (hitEv) => {
              if (!this.zombieAI) return;
              const res = this.zombieAI.applyBulletDamage(
                hitEv.zombieId,
                hitEv.damage,
                hitEv.hitZone,
                hitEv.impactPoint,
                hitEv.impactDir,
              );
              if (res.hit) {
                this.recordZombieDamageAttribution(hitEv.zombieId, hitEv.shooterId);
              }
              if (res.killed) {
                this.resolveZombieKillAssists(hitEv.zombieId, hitEv.shooterId);
                this.botAI?.awardInfectionKillPoints(
                  hitEv.shooterId,
                  res.headshot,
                  Boolean(hitEv.melee),
                  false,
                  hitEv.damage,
                );
                this.pushMpKillfeed({
                  killerName: hitEv.shooterName,
                  killerTeam: 'A',
                  victimName: 'INFECTED',
                  victimTeam: 'B',
                  headshot: res.headshot,
                  weaponLabel: hitEv.weaponLabel,
                });
                if (this.mp && this.isMpHost) {
                  const killedPkt: GameZombieKilledPacket = {
                    type: 'game:zombie_killed',
                    zombieId: hitEv.zombieId,
                    killerUserId: hitEv.shooterId,
                    headshot: res.headshot,
                    melee: Boolean(hitEv.melee),
                    pointsAwarded: 0,
                    weaponId: hitEv.weaponId,
                    px: Number(hitEv.impactPoint.x.toFixed(3)),
                    py: Number(hitEv.impactPoint.y.toFixed(3)),
                    pz: Number(hitEv.impactPoint.z.toFixed(3)),
                    ts: Date.now(),
                  };
                  this.mp.sendMessage(killedPkt as unknown as Record<string, unknown>);
                }
              } else if (res.hit) {
                this.botAI?.awardInfectionHitPoints(hitEv.shooterId, 10, hitEv.damage);
              }
            },
            {
              round: roundState.round,
              intermissionActive: roundState.intermissionSec > 0,
              powerOn: this.powerOn,
              getBarrierPlanks: (barrierId) => {
                const b = this.zombieAI?.getBarrierById(barrierId);
                if (!b) return null;
                return { remaining: b.getPlanksRemaining(), max: b.maxPlanks };
              },
              onBotEconomyAction: (ev) => {
                if (ev.kind === 'buyable_door' || ev.kind === 'power_switch') {
                  const ok = this.applyMapInteractableEffect(ev.interactableId, ev.botName, false);
                  if (ok && this.mp && this.isMpHost) {
                    const it = this.map.interactables.find(
                      (item) =>
                        item.id === ev.interactableId ||
                        (ev.interactableId === 'power_switch' && item.kind === 'power_switch'),
                    );
                    const pkt: GameMapInteractPacket = {
                      type: 'game:map_interact',
                      interactableId: it?.id ?? ev.interactableId,
                      kind: ev.kind,
                      activatedByUserId: ev.botId,
                      activatedByUsername: ev.botName,
                      unlockedZoneId: it?.unlocksZoneId,
                      ts: Date.now(),
                    };
                    this.mp.sendMessage(pkt as unknown as Record<string, unknown>);
                    if (this.zombieAI) {
                      this.mp.sendMessage(
                        this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
                      );
                    }
                  }
                  return ok;
                }
                if (ev.kind === 'window_barrier' && ev.barrierId && this.zombieAI) {
                  const barrier = this.zombieAI.getBarrierById(ev.barrierId);
                  if (!barrier || !barrier.repairPlank()) return false;
                  this._tmpBarrierPos.set(barrier.sillPos[0], barrier.sillPos[1], barrier.sillPos[2]);
                  this.audio.playImpact(this._tmpBarrierPos, 'wood');
                  if (this.mp && this.isMpHost) {
                    const updPkt: GameBarrierUpdatePacket = {
                      type: 'game:barrier_update',
                      barrierId: barrier.id,
                      planksRemaining: barrier.getPlanksRemaining(),
                      repairedByUserId: ev.botId,
                      pointsAwarded: 0,
                      ts: Date.now(),
                    };
                    this.mp.sendMessage(updPkt as unknown as Record<string, unknown>);
                  }
                  return true;
                }
                if (ev.kind === 'wall_buy' || ev.kind === 'mystery_crate' || ev.kind === 'perk_machine') {
                  this.audio.playGearRattle('weapon_swap', 0.45);
                  return true;
                }
                return false;
              },
            },
          );
        }
      }

      // Host drift-free 20 Hz authoritative AI Bot / Zombie + Kino door/zone/barrier state broadcast
      if (this.mp && this.isMpHost) {
        this.aiSyncAccum += dt;
        if (this.aiSyncAccum >= 0.05) {
          this.aiSyncAccum = Math.min(this.aiSyncAccum - 0.05, 0.05);
          if (this.botAI) {
            this.mp.sendMessage(
              this.botAI.exportSyncSnapshot() as unknown as Record<string, unknown>,
            );
          }
          if (this.zombieAI) {
            this.mp.sendMessage(
              this.zombieAI.exportSyncSnapshot(this.powerOn) as unknown as Record<string, unknown>,
            );
          }
        }
      }
    }

    // Update nearby interactable & continuous Hold [F] barrier repair in Infection
    this.updateNearbyInteractable();
    this.updateBarrierRepair(dt, simActive);

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

    // Update & project active tactical pings (distance-faded screen markers)
    this.updateAndProjectPings(dt);

    // Emit HUD snapshots slightly faster (30Hz) while pings are on-screen for silky marker tracking
    this.uiEmitTimer += dt;
    const emitInterval = this.activePings.length > 0 ? 0.033 : 0.065;
    if (this.uiEmitTimer >= emitInterval) {
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
    const localStats = {
      headshots: this.playerHeadshots,
      assists: this.playerAssists,
      grenadeKills: this.playerGrenadeKills,
      meleeKills: this.playerMeleeKills,
      damageDealt: this.playerDamageDealt,
      afkSeconds: Number(this.playerAfkSeconds.toFixed(1)),
    };
    const botBoard =
      this.botAI?.getScoreboard(
        this.playerKills,
        this.playerDeaths,
        this.playerAlive,
        localStats,
      ) ?? [
        {
          id: 'player',
          name: 'YOU',
          team: this.localBattleTeam,
          isPlayer: true,
          isBot: false,
          kills: this.playerKills,
          deaths: this.playerDeaths,
          headshots: this.playerHeadshots,
          assists: this.playerAssists,
          grenadeKills: this.playerGrenadeKills,
          meleeKills: this.playerMeleeKills,
          damageDealt: this.playerDamageDealt,
          afkSeconds: Number(this.playerAfkSeconds.toFixed(1)),
          alive: this.playerAlive,
        },
      ];
    const mergedScoreboard: BattleScoreEntry[] = this.mp
      ? [
          ...botBoard.map((row) =>
            row.isPlayer
              ? {
                  ...row,
                  id: this.mp!.localUserId,
                  name: this.mp!.localUsername,
                  team: this.localBattleTeam,
                }
              : row,
          ),
          ...remoteScores,
        ].sort((a, b) => b.kills - a.kills || b.assists - a.assists || a.deaths - b.deaths)
      : botBoard;

    const combatants: CombatantMatchStats[] = mergedScoreboard.map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team,
      isLocalPlayer: row.isPlayer,
      isBot: row.isBot,
      kills: row.kills,
      deaths: row.deaths,
      headshots: row.headshots,
      assists: row.assists,
      grenadeKills: row.grenadeKills,
      meleeKills: row.meleeKills,
      damageDealt: row.damageDealt,
      afkSeconds: row.afkSeconds,
    }));

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
      isReloading: this.reloadTimer > 0 || this.weaponRig.isTubularReloading(),
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
      playerAssists: this.playerAssists,
      playerGrenadeKills: this.playerGrenadeKills,
      playerMeleeKills: this.playerMeleeKills,
      playerDamageDealt: this.playerDamageDealt,
      playerAfkSeconds: Number(this.playerAfkSeconds.toFixed(1)),
      matchDurationSec: Number(this.matchDurationSec.toFixed(1)),
      weaponKills: { ...this.weaponKills },
      ffaLeaderName,
      ffaLeaderKills,
      respawnTimerSec: Math.max(0, this.respawnTimerSec),
      matchOutcome: this.matchOutcome,
      killfeed: mergedKillfeed,
      scoreboard: mergedScoreboard,
      combatants,

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
      friendlyBotsAlive: this.params.mode === 'infection' ? (this.botAI?.getAliveBotCount() ?? 0) : 0,
      friendlyBotsTotal: this.params.mode === 'infection' ? (this.botAI?.getTotalBotCount() ?? 0) : 0,
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
      grenadeStatusLabel: this.grenadeSystem.getActionStatusLabel(),
      grenadeThrowStyle: this.grenadeSystem.getThrowStyle(),
      grenadeThrowHeld: this.grenadeSystem.isThrowInputHeld(),
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
      tacticalPings: this.projectedPings,

      supportsDynamicWeatherTime: Boolean(this.map.supportsDynamicWeatherTime),
      gameClockText: this.weatherTime ? this.weatherTime.getFormattedClock() : '23:15',
      weatherLabel: this.weatherTime ? this.weatherTime.getActiveWeather().toUpperCase() : 'NIGHT',
      windSpeedMps: this.weatherTime ? Number(this.weatherTime.getWindSpeedMps().toFixed(1)) : 0,
      isPdaOpen: this.pdaDevice.isOpen(),

      squadComms: this.squadComms.filter((m) => now - m.timestampMs < 7500),
      infectionSquadBots:
        this.params.mode === 'infection' ? (this.botAI?.getInfectionSquadSummary() ?? []) : [],

      nvgMount: this.localGear.nvgMount,
      nvgActive: this.playerAlive && this.nvgFlipped && this.localGear.nvgMount !== 'none',
      irIlluminatorOn:
        this.playerAlive &&
        this.nvgFlipped &&
        this.localGear.nvgMount !== 'none' &&
        this.irIlluminatorOn,
      doorInteractReticle: this.doorReticleState,
      doorPrompt: this.activeDoorPrompt
        ? {
            ...this.activeDoorPrompt,
            options: this.activeDoorPrompt.options.map((o) => ({ ...o })),
          }
        : null,
    };
  }

  private updateDoorInteractScan(): void {
    const prevRet = this.doorReticleState;
    const prevSig = this.activeDoorPrompt
      ? `${this.activeDoorPrompt.targetLabel}|${this.activeDoorPrompt.selectedIndex}|${this.activeDoorPrompt.options.map((o) => `${o.id}:${o.hint ?? ''}`).join(',')}`
      : '';

    if (
      !this.map.doorSystem ||
      !this.pointerLocked ||
      !this.playerAlive ||
      this.pdaDevice.isOpen()
    ) {
      this.activeDoorId = null;
      this.activeDoorPrompt = null;
      this.doorReticleState = 'hidden';
      if (prevRet !== 'hidden' || prevSig !== '') this.emitSnapshot();
      return;
    }

    const DOOR_MAX_M = 2.65;
    const DOOR_NEAR_M = DOOR_MAX_M + 2.2;
    this.camera.getWorldPosition(this._doorCamPos);
    this.camera.getWorldDirection(this._doorCamDir).normalize();
    this._doorRaycaster.set(this._doorCamPos, this._doorCamDir);
    this._doorRaycaster.near = 0.08;
    this._doorRaycaster.far = DOOR_NEAR_M;

    const proxies = this.map.doorSystem.getInteractableMeshes();
    const hits = this._doorRaycaster.intersectObjects(proxies, false);
    this.controller.getVelocity(this._doorVelScratch);
    const horizSpeed = Math.hypot(this._doorVelScratch.x, this._doorVelScratch.z);

    let matchedId: string | null = null;
    let nearDetected = false;

    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.object.visible) continue;
      const doorId = h.object.userData.destructibleDoorId as string | undefined;
      if (!doorId) continue;
      const opts = this.map.doorSystem.getInteractOptions(
        doorId,
        this.controller.isSprinting,
        horizSpeed,
        this._doorCamPos,
      );
      if (opts.length === 0) continue;

      if (h.distance > 0.5) {
        const blocked = this.adapter.raycast(
          this._doorCamPos,
          this._doorCamDir,
          0.08,
          h.distance - 0.35,
          this._doorOcclHit,
        );
        if (blocked && this._doorOcclHit.object?.userData?.destructibleDoorId !== doorId) {
          continue;
        }
      }

      if (h.distance <= DOOR_MAX_M) {
        matchedId = doorId;
      } else {
        nearDetected = true;
      }
      break;
    }

    if (!matchedId) {
      this.activeDoorId = null;
      this.activeDoorPrompt = null;
      this.doorSelectedOptionIndex = 0;
      this.doorReticleState = nearDetected ? 'near' : 'hidden';
    } else {
      if (matchedId !== this.activeDoorId) {
        this.activeDoorId = matchedId;
        this.doorSelectedOptionIndex = 0;
      }
      const door = this.map.doorSystem.getDoor(matchedId);
      const opts = this.map.doorSystem.getInteractOptions(
        matchedId,
        this.controller.isSprinting,
        horizSpeed,
        this._doorCamPos,
      );
      this.doorSelectedOptionIndex = THREE.MathUtils.clamp(
        this.doorSelectedOptionIndex,
        0,
        Math.max(0, opts.length - 1),
      );
      this.doorReticleState = 'ready';
      this.activeDoorPrompt = {
        key: 'F',
        targetLabel: door?.label ?? 'Door',
        options: opts,
        selectedIndex: this.doorSelectedOptionIndex,
      };
    }

    const nextSig = this.activeDoorPrompt
      ? `${this.activeDoorPrompt.targetLabel}|${this.activeDoorPrompt.selectedIndex}|${this.activeDoorPrompt.options.map((o) => `${o.id}:${o.hint ?? ''}`).join(',')}`
      : '';
    if (this.doorReticleState !== prevRet || nextSig !== prevSig) {
      this.emitSnapshot();
    }
  }

  private executeSelectedDoorOption(): void {
    if (!this.map.doorSystem || !this.activeDoorId || !this.activeDoorPrompt) return;
    const opts = this.activeDoorPrompt.options;
    if (opts.length === 0) return;
    const idx = THREE.MathUtils.clamp(this.doorSelectedOptionIndex, 0, opts.length - 1);
    const optId = opts[idx].id as DoorInteractOptionId;
    const doorId = this.activeDoorId;

    this.camera.getWorldPosition(this._doorCamPos);
    this.camera.getWorldDirection(this._doorCamDir).normalize();
    this.controller.getVelocity(this._doorVelScratch);
    const horizSpeed = Math.hypot(this._doorVelScratch.x, this._doorVelScratch.z);

    if (optId === 'kick') {
      this.animator.interruptInspect();
      this.input.ads = false;
      this.animator.triggerPushKick(this.controller, this.getActiveTraumaModifiers());
      this.reloadTimer = 0;
      this.lastKickHandlingTimer = 0.48;
      const hasPushPt = this.map.doorSystem.getPushFaceWorldPos(
        doorId,
        this._doorCamPos,
        this._doorIkPos,
      );
      this.map.doorSystem.executeKick(
        doorId,
        this._doorCamDir,
        horizSpeed,
        this.controller.isSprinting,
        this.localBattleTeam,
        false,
        undefined,
        hasPushPt ? this._doorIkPos : undefined,
      );
      this.emitSnapshot();
      return;
    }

    const ok = this.map.doorSystem.executeOption(doorId, optId, {
      actorPos: this._doorCamPos,
      actorForward: this._doorCamDir,
      horizontalSpeedMps: horizSpeed,
      isSprinting: this.controller.isSprinting,
      actorTeam: this.localBattleTeam,
    });
    if (!ok) return;

    if (optId === 'open' || optId === 'peek' || optId === 'close_soft') {
      if (this.map.doorSystem.getDoorknobWorldPos(doorId, this._doorCamPos, this._doorIkPos)) {
        const animKind =
          optId === 'open'
            ? 'DOOR_OPEN'
            : optId === 'peek'
              ? 'DOOR_PEEK'
              : 'DOOR_CLOSE_SOFT';
        this.interactAnimator.trigger(animKind, this._doorIkPos, (out) =>
          Boolean(this.map.doorSystem?.getDoorknobWorldPos(doorId, this._doorCamPos, out)),
        );
      }
    } else if (optId === 'close') {
      if (this.map.doorSystem.getPushFaceWorldPos(doorId, this._doorCamPos, this._doorIkPos)) {
        this.interactAnimator.trigger('DOOR_CLOSE_PUSH', this._doorIkPos, (out) =>
          Boolean(this.map.doorSystem?.getPushFaceWorldPos(doorId, this._doorCamPos, out)),
        );
      }
    }
    this.emitSnapshot();
  }

  private updatePdaTelemetry(dt: number): void {
    this._pdaAllyBuf.length = 0;
    if (this.botAI) {
      const allyBots = this.botAI.getAliveAllyTargets();
      for (let i = 0; i < allyBots.length; i++) {
        const b = allyBots[i];
        const info = this.botAI.getBotInfo(b.id);
        this._pdaAllyBuf.push({
          id: b.id,
          name: info?.name ?? b.id,
          x: b.pos.x,
          z: b.pos.z,
          alive: b.alive,
        });
      }
    }
    if (this.remotePlayers) {
      const humans = this.remotePlayers.getAliveHumanTargets();
      for (let i = 0; i < humans.length; i++) {
        const h = humans[i];
        if (this.remotePlayers.isFriendly(h.id)) {
          this._pdaAllyBuf.push({
            id: h.id,
            name: h.name,
            x: h.pos.x,
            z: h.pos.z,
            alive: h.alive,
          });
        }
      }
    }

    this._pdaPingBuf.length = 0;
    for (let i = 0; i < this.activePings.length; i++) {
      const p = this.activePings[i];
      this._pdaPingBuf.push({
        x: p.worldPos.x,
        z: p.worldPos.z,
        label: p.label,
        kind: p.kind === 'enemy' ? 'contact' : p.kind === 'item' ? 'poi' : 'order',
      });
    }

    this.controller.writePdaMotionState(this._pdaMotionScratch);
    this.pdaDevice.setTelemetry({
      playerX: this.controller.position.x,
      playerZ: this.controller.position.z,
      playerYawRad: this.controller.aimYaw,
      gameClockText: this.weatherTime ? this.weatherTime.getFormattedClock() : '23:15',
      weatherLabel: this.weatherTime ? this.weatherTime.getActiveWeather().toUpperCase() : 'INDOOR',
      windSpeedMps: this.weatherTime ? this.weatherTime.getWindSpeedMps() : 0,
      windAngleRad: this.weatherTime ? this.weatherTime.getWindAngleRad() : 0,
      zoneLabel: this.map.name.toUpperCase(),
      allies: this._pdaAllyBuf,
      pings: this._pdaPingBuf,
    });
    this.pdaDevice.update(
      dt,
      this.elapsedSec,
      this._pdaMotionScratch.moveRatio,
      this._pdaMotionScratch.isCrouched,
      this._pdaMotionScratch,
    );
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
    this.unsubOperatorGear?.();
    this.unsubOperatorGear = null;
    this.camera.remove(this.irIlluminatorLight);
    this.camera.remove(this.irIlluminatorTarget);
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.remotePlayers?.dispose();
    this.botAI?.dispose();
    this.zombieAI?.dispose();
    this.grenadeSystem.dispose();
    this.pdaDevice.dispose();
    this.weatherTime?.dispose();
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

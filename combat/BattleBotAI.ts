import * as THREE from 'three';
import {
  ActiveSmokeCloudInfo,
  ArticulatedRagdoll,
  BodycamAudio,
  BodycamRaycastResult,
  BodycamWeaponWeightClass,
  createRaycastResult,
  GYM_ARMORY_WEAPONS,
  IBodycamWorldAdapter,
  resolveWeaponProfile,
} from '../bodycam-sdk';
import {
  createVaultCandidate,
  VaultCandidate,
  VaultDetector,
  VaultKind,
} from '../bodycam-sdk/movement/VaultDetector';
import {
  normalizeOperatorId,
  OperatorId,
} from '../bodycam-sdk/operator/OperatorTypes';
import { graphicsQualityStore } from '../data/graphicsQuality';
import {
  BotDifficultyId,
  BattleRuleId,
  BuiltMapInstance,
  findNavPath,
  findNearestNavNode,
  InfectionPerkId,
  isFreeForAllBattleRule,
  isTeamBattleRule,
  NavNode,
  SpawnPoint,
} from '../maps/types';
import type { BattleModeController, ModeActorSample } from './BattleModeController';
import {
  BotWeaponVisualClass,
  GameBotsSyncPacket,
  GameGrenadeEventKind,
  OperatorUniformId,
  packSyncedWeaponAttachments,
  resolveOperatorUniformId,
  SquadCommsCategory,
  SyncedBotState,
  SyncedHandlingAction,
  TacticalPingKind,
  unpackSyncedWeaponAttachments,
} from '../data/multiplayer';
import {
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  getTacticalEquipmentDef,
  isTacticalEquipmentId,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import {
  getCompatibleAttachments,
  getOwnedSuppressorDef,
  normalizeWeaponAttachments,
  WeaponAttachments,
} from '../data/attachments';
import { SUPPRESSOR_TOGGLE_DURATION_SEC } from '../bodycam-sdk/weapons/WeaponAnimator';
import {
  BuiltTacticalOperatorRig,
  TacticalCombatPose,
  TacticalOperatorRigFactory,
} from './TacticalOperatorRig';

export type BattleTeamId = 'A' | 'B' | 'FFA';

export interface BattleScoreEntry {
  id: string;
  name: string;
  team: BattleTeamId;
  isPlayer: boolean;
  isBot: boolean;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  grenadeKills: number;
  meleeKills: number;
  damageDealt: number;
  afkSeconds: number;
  alive: boolean;
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  poiCaptures?: number;
  territoryPoints?: number;
  flagCaptures?: number;
  flagReturns?: number;
  hillControlSec?: number;
  conquestLivesRemaining?: number;
  conquestEliminated?: boolean;
}

export interface BattleKillfeedEntry {
  id: number;
  killerName: string;
  killerTeam: BattleTeamId;
  victimName: string;
  victimTeam: BattleTeamId;
  headshot: boolean;
  weaponLabel: string;
  timestampMs: number;
}

export interface BotDamageResult {
  hit: boolean;
  botId: string;
  botName: string;
  killed: boolean;
  headshot: boolean;
  friendlyIgnored: boolean;
  appliedDamage: number;
}

export interface BotPlayerDamageEvent {
  targetUserId: string;
  damage: number;
  attackerPos: THREE.Vector3;
  attackerName: string;
  attackerId: string;
  attackerTeam: BattleTeamId;
  weaponId?: string;
  caliberId?: string;
}

export interface BattleHumanTarget {
  id: string;
  name: string;
  team: BattleTeamId;
  pos: THREE.Vector3;
  alive: boolean;
}

export interface BattleZombieTarget {
  id: string;
  pos: THREE.Vector3;
  enteringWindow?: boolean;
}

export interface BotZombieHitEvent {
  zombieId: string;
  damage: number;
  hitZone: string;
  impactPoint: THREE.Vector3;
  impactDir: THREE.Vector3;
  shooterId: string;
  shooterName: string;
  weaponId: string;
  weaponLabel: string;
  melee?: boolean;
}

export interface BotCommsEvent {
  botId: string;
  callsign: string;
  team: BattleTeamId;
  category: SquadCommsCategory;
  text: string;
  pingKind?: TacticalPingKind | null;
  pingLabel?: string | null;
  pingPos?: THREE.Vector3 | null;
}

export interface BotGrenadeEvent {
  botId: string;
  botName: string;
  team: BattleTeamId;
  kind: GameGrenadeEventKind;
  equipmentId: TacticalEquipmentId;
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  fuseRemainingSec: number;
}

export interface BotEconomyActionEvent {
  botId: string;
  botName: string;
  kind: 'buyable_door' | 'power_switch' | 'wall_buy' | 'mystery_crate' | 'perk_machine' | 'window_barrier';
  interactableId: string;
  barrierId?: string;
  cost: number;
  weaponId?: string;
  perkId?: InfectionPerkId;
}

export interface InfectionBotEconomyContext {
  round: number;
  intermissionActive: boolean;
  powerOn: boolean;
  getBarrierPlanks: (barrierId: string) => { remaining: number; max: number } | null;
  onBotEconomyAction: (ev: BotEconomyActionEvent) => boolean;
}

export interface InfectionBotStatusSummary {
  id: string;
  name: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  points: number;
  weaponLabel: string;
  kills: number;
}

export interface BattleBotTuningOptions {
  aiHealth?: number;
  aiAccuracyMult?: number;
  aiMoveSpeedMult?: number;
  aiRespawnEnabled?: boolean;
  isClientReplica?: boolean;
  maxAnisotropy?: number;
  /** When true, all bots are permanently friendly squadmates fighting zombies in Infection mode */
  coopInfectionMode?: boolean;
  /** World physics adapter enabling AI operators to vault, climb, and mantle real geometry */
  worldAdapter?: IBodycamWorldAdapter;
  /** Allied team ID for Battle TDM comms filtering (defaults to 'A') */
  localAllyTeam?: BattleTeamId;
  /** Optional BattleModeController attached immediately so Conquest bots open at Team HQ */
  modeController?: BattleModeController | null;
}

interface DifficultyParams {
  reactionSec: number;
  spreadRad: number;
  burstMin: number;
  burstMax: number;
  fireIntervalSec: number;
  burstPauseSec: number;
  damagePerShot: number;
  moveSpeed: number;
  visionRangeM: number;
}

const DIFFICULTY_TABLE: Record<BotDifficultyId, DifficultyParams> = {
  recruit: {
    reactionSec: 0.62,
    spreadRad: 0.088,
    burstMin: 2,
    burstMax: 4,
    fireIntervalSec: 0.16,
    burstPauseSec: 0.92,
    damagePerShot: 11,
    moveSpeed: 3.1,
    visionRangeM: 34,
  },
  tactical: {
    reactionSec: 0.38,
    spreadRad: 0.052,
    burstMin: 3,
    burstMax: 5,
    fireIntervalSec: 0.125,
    burstPauseSec: 0.62,
    damagePerShot: 14,
    moveSpeed: 3.55,
    visionRangeM: 44,
  },
  veteran: {
    reactionSec: 0.22,
    spreadRad: 0.032,
    burstMin: 4,
    burstMax: 6,
    fireIntervalSec: 0.105,
    burstPauseSec: 0.42,
    damagePerShot: 17,
    moveSpeed: 3.95,
    visionRangeM: 54,
  },
};

const MALE_CALLSIGNS_A = ['ALPHA-1', 'KESTREL', 'NOMAD', 'BISHOP', 'FALCON'];
const FEMALE_CALLSIGNS_A = ['VALKYRIE', 'SIERRA', 'ATHENA', 'VESPERS', 'LYRA'];
const MALE_CALLSIGNS_B = ['VOLK-2', 'GRANIT', 'BERKUT', 'SOKOL', 'VIKTOR'];
const FEMALE_CALLSIGNS_B = ['LYNX', 'NOVA', 'IRIS', 'ZARYA', 'KATYA'];
const MALE_CALLSIGNS_FFA = ['SPECTRE', 'VOLK', 'NOMAD', 'BISHOP', 'FALCON', 'GRANIT'];
const FEMALE_CALLSIGNS_FFA = ['VALKYRIE', 'SIERRA', 'LYNX', 'ATHENA', 'NOVA', 'IRIS'];

// Door-gated edges matching KinoTheaterMap so friendly Infection bots never path through locked doors
const INFECTION_DOOR_GATED_EDGES: ReadonlyArray<[string, string, string]> = [
  ['ww_door_aud', 'aud_pit_w', 'door_west_auditorium'],
  ['ew_door_aud', 'aud_pit_e', 'door_east_auditorium'],
  ['aud_back_w', 'proj_ramp', 'door_projector'],
];

interface BotWeaponCombatSpec {
  id: string;
  label: string;
  visualClass: BotWeaponVisualClass;
  weightClass: 'pistol' | 'carbine' | 'heavy_rifle';
  caliberId: string;
  magCapacity: number;
  reserveMax: number;
  damagePerShot: number;
  fireIntervalSec: number;
  burstMin: number;
  burstMax: number;
  burstPauseSec: number;
  reloadSec: number;
  spreadMult: number;
  tier: number; // 0 = starter pistol, 1 = shotgun/smg, 2 = compact rifle, 3 = carbine/mystery
}

function buildBotWeaponSpec(weaponId: string): BotWeaponCombatSpec {
  const prof = resolveWeaponProfile(weaponId);
  const cat = prof.category;
  const isPistol = cat === 'pistols' || cat === 'revolvers';
  const isShotgun = cat === 'shotguns';
  const isSmg = cat === 'pdws';
  const visualClass: BotWeaponVisualClass = isPistol
    ? 'pistol'
    : isShotgun
      ? 'shotgun'
      : isSmg
        ? 'smg'
        : 'rifle';

  const magCapacity = Math.max(4, prof.magCapacity || 17);
  const reserveMax = isPistol ? magCapacity * 6 : magCapacity * 5;
  const rpm = Math.max(70, prof.rpm || 380);
  const baseInterval = 60 / rpm;

  if (isPistol) {
    return {
      id: prof.id,
      label: prof.name.length > 18 ? 'Glock 17' : prof.name,
      visualClass: 'pistol',
      weightClass: 'pistol',
      caliberId: prof.defaultCaliberId || '9x19',
      magCapacity,
      reserveMax,
      damagePerShot: 24,
      fireIntervalSec: Math.max(0.24, baseInterval),
      burstMin: 2,
      burstMax: 3,
      burstPauseSec: 0.42,
      reloadSec: prof.reloadDurationSec || 1.85,
      spreadMult: 0.92,
      tier: 0,
    };
  }
  if (isShotgun) {
    return {
      id: prof.id,
      label: prof.name.length > 20 ? 'Remington 870' : prof.name,
      visualClass: 'shotgun',
      weightClass: 'heavy_rifle',
      caliberId: prof.defaultCaliberId || '12ga',
      magCapacity,
      reserveMax,
      damagePerShot: 82,
      fireIntervalSec: Math.max(0.68, baseInterval),
      burstMin: 1,
      burstMax: 2,
      burstPauseSec: 0.55,
      reloadSec: prof.reloadDurationSec || 2.6,
      spreadMult: 1.35,
      tier: 1,
    };
  }
  if (isSmg) {
    return {
      id: prof.id,
      label: prof.name.length > 20 ? 'HK MP5 9mm' : prof.name,
      visualClass: 'smg',
      weightClass: 'pistol',
      caliberId: prof.defaultCaliberId || '9x19',
      magCapacity,
      reserveMax,
      damagePerShot: 28,
      fireIntervalSec: Math.max(0.095, baseInterval),
      burstMin: 4,
      burstMax: 7,
      burstPauseSec: 0.44,
      reloadSec: prof.reloadDurationSec || 2.1,
      spreadMult: 1.05,
      tier: 2,
    };
  }
  const rifleAudioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
    prof.weightClass === 'heavy_rifle'
      ? 'heavy_rifle'
      : prof.weightClass === 'pistol'
        ? 'pistol'
        : 'carbine';
  return {
    id: prof.id,
    label: prof.name.length > 20 ? prof.name.slice(0, 18) : prof.name,
    visualClass: 'rifle',
    weightClass: rifleAudioWeight,
    caliberId: prof.defaultCaliberId || '556x45',
    magCapacity,
    reserveMax,
    damagePerShot: 38,
    fireIntervalSec: Math.max(0.105, baseInterval),
    burstMin: 3,
    burstMax: 6,
    burstPauseSec: 0.48,
    reloadSec: prof.reloadDurationSec || 2.35,
    spreadMult: 0.88,
    tier: 3,
  };
}

/**
 * Builds an authentic, rule-normalized armory attachment kit for AI bots so bots carry
 * real procedural optics, grips, and suppressors matching human operator loadouts.
 */
function buildBotAttachmentsForWeapon(
  weaponId: string,
  seedIdx: number,
  coopInfection: boolean,
): WeaponAttachments {
  // True pistol-start in Infection starts clean until bots purchase upgraded weapons
  if (coopInfection && weaponId === 'glock_17') {
    return normalizeWeaponAttachments(weaponId, {});
  }

  const raw: WeaponAttachments = {};
  const rails = getCompatibleAttachments(weaponId, 'railAdapter', raw);
  if (rails.length > 0 && seedIdx % 2 === 0) {
    raw.railAdapter = rails[0].id;
  }

  const optics = getCompatibleAttachments(weaponId, 'optic', raw);
  if (optics.length > 0) {
    const pickedOptic = optics[seedIdx % optics.length];
    raw.optic = pickedOptic.id;
  }

  const grips = getCompatibleAttachments(weaponId, 'foregrip', raw);
  if (grips.length > 0 && seedIdx % 3 !== 2) {
    raw.foregrip = grips[seedIdx % grips.length].id;
  }

  const muzzles = getCompatibleAttachments(weaponId, 'muzzle', raw);
  const suppressors = muzzles.filter((m) => m.isSuppressor);
  if (suppressors.length > 0 && seedIdx % 2 === 0) {
    raw.muzzle = suppressors[0].id;
    raw.suppressorStowed = false;
  } else if (muzzles.length > 0) {
    const nonSupp = muzzles.find((m) => !m.isSuppressor);
    if (nonSupp) raw.muzzle = nonSupp.id;
  }

  return normalizeWeaponAttachments(weaponId, raw);
}

interface BotEconomyGoal {
  kind: BotEconomyActionEvent['kind'];
  interactableId: string;
  barrierId?: string;
  label: string;
  pos: THREE.Vector3;
  cost: number;
  weaponId?: string;
  perkId?: InfectionPerkId;
}

interface PendingSquadAck {
  dueTimer: number;
  sourceBotId: string;
  team: BattleTeamId;
  text: string;
}

type BotGrenadeStage =
  | 'HOLSTERED'
  | 'DRAWN'
  | 'PIN_PULLED'
  | 'LEVER_RELEASED'
  | 'CHARGING'
  | 'THROWING';

interface BotActor {
  id: string;
  name: string;
  team: BattleTeamId;
  uniformId: OperatorUniformId;
  operatorId: OperatorId;
  weaponId: string;
  weaponLabel: string;
  weaponClass: BotWeaponVisualClass;
  botSeedIndex: number;
  attachments: WeaponAttachments;
  ownsSuppressor: boolean;
  suppressed: boolean;
  handlingAction: SyncedHandlingAction;
  handlingTimer: number;
  handlingDuration: number;
  suppToggleCooldown: number;
  pendingSuppressorAttach: boolean;
  netHandlingAction: SyncedHandlingAction;
  netHandlingProgress: number;
  netSuppressed: boolean;

  // Finite role-based tactical grenade pouch & 4-stage manual of arms FSM
  grenadePouch: Partial<Record<TacticalEquipmentId, number>>;
  primaryGrenadeId: TacticalEquipmentId;
  grenadeCooldown: number;
  grenadeStage: BotGrenadeStage;
  grenadeStageTimer: number;
  grenadeEquipId: TacticalEquipmentId;
  grenadeFuseSec: number;
  grenadeFuseRemaining: number;
  grenadeCookTargetSec: number;
  grenadeThrowStyle: 'overhand' | 'underhand';
  grenadeCharge01: number;
  grenadeChargeTarget: number;
  grenadeSpoonPopped: boolean;
  grenadeThrowDispatched: boolean;
  grenadeTargetPos: THREE.Vector3;
  grenadeOvercookRisk: boolean;
  netGrenadeEquipId: TacticalEquipmentId;
  netGrenadeCharge01: number;
  netGrenadeThrowStyle: 'overhand' | 'underhand';

  alive: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  grenadeKills: number;
  meleeKills: number;
  damageDealt: number;
  afkSeconds: number;
  recentAttackers: Map<string, number>;
  respawnTimer: number;
  deathTimer: number;
  conquestEliminated: boolean;
  conquestLoadoutIndex: number;
  conquestLoadoutRoster: string[];

  // Shared Infection Economy, Weapon Slots, Finite Ammo & Perks
  points: number;
  weaponSlots: string[];
  activeSlotIndex: number;
  magAmmoByWeapon: Record<string, number>;
  reserveAmmoByWeapon: Record<string, number>;
  perks: Set<InfectionPerkId>;
  reloadTimer: number;
  reloadDuration: number;
  netReloading: boolean;
  meleeCooldown: number;
  economyGoal: BotEconomyGoal | null;
  economyEvalTimer: number;
  barrierRepairAccum: number;

  // Per-bot comms cooldowns
  commsCooldown: number;
  lowHpCalledOut: boolean;
  lastContactCalloutSec: number;
  prevHasLos: boolean;

  pos: THREE.Vector3;
  netPos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  netYaw: number;
  targetYaw: number;
  walkCycle: number;
  flinchTimer: number;
  stunTimer: number;
  hasNetState: boolean;
  firingVisualTimer: number;
  recoilKick: number;

  // Tactical posture (crouch, corner lean) & vaulting/climbing state
  crouchBlend: number;
  targetCrouch: number;
  netCrouch: number;
  leanBlend: number;
  targetLean: number;
  netLean: number;
  postureEvalTimer: number;
  wallObstruction01: number;
  beltWallTuck01: number;

  vaultActive: boolean;
  vaultKind: VaultKind;
  vaultStartPos: THREE.Vector3;
  vaultApexPos: THREE.Vector3;
  vaultEndPos: THREE.Vector3;
  vaultT: number;
  vaultDuration: number;
  vaultCooldown: number;
  vaultProbeTimer: number;
  vaultCrouchFinish: boolean;
  netVaulting: boolean;
  netVaultProgress: number;

  // Navigation & stuck recovery
  path: NavNode[];
  pathIndex: number;
  repathTimer: number;
  goalNodeId: string | null;
  stuckTimer: number;
  lastProgressX: number;
  lastProgressZ: number;
  avoidDir: number;
  unstuckBoostTimer: number;

  // Combat AI
  targetId: string | null; // 'human:...' | 'zombie:...' | bot.id
  hasLos: boolean;
  losTimer: number;
  reactionTimer: number;
  strafeDir: number;
  strafeTimer: number;
  burstShotsLeft: number;
  fireTimer: number;
  burstCooldown: number;
  muzzleFlashTimer: number;
  smokeAlertTimer: number;
  smokeFlankDir: number;
  smokeCloudPos: THREE.Vector3;
  doorInteractCooldown: number;
  doorAlertTimer: number;
  doorAlertPos: THREE.Vector3;

  // 3D Hierarchy (Unified TacticalOperatorRig) & Articulated Ragdoll
  rig: BuiltTacticalOperatorRig;
  ragdoll: ArticulatedRagdoll;
  root: THREE.Group;
  bodyPivot: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponPivot: THREE.Group;
  muzzleFlash: THREE.Mesh;
  hitMeshes: THREE.Mesh[];
}

interface PooledBotTracer {
  active: boolean;
  life: number;
  maxLife: number;
  mesh: THREE.Mesh;
}

const MAX_TRACERS = 28;
const BOT_EYE_Y = 1.56;
const BOT_RADIUS = 0.36;

/**
 * Dedicated tactical gun-combat AI for BATTLE mode (TDM & FFA).
 * Strictly separated from InfectionZombieAI: features team awareness, cover-node
 * A* navigation, line-of-sight gating, strafing/peeking, burst accuracy curves,
 * pooled tracers, and respawn management.
 */
export class BattleBotAI {
  public readonly group = new THREE.Group();
  private readonly bots: BotActor[] = [];
  private readonly tracers: PooledBotTracer[] = [];
  private tracerCursor = 0;

  private readonly map: BuiltMapInstance;
  private readonly audio: BodycamAudio;
  private readonly rule: BattleRuleId;
  private readonly diff: DifficultyParams;
  private readonly aiMaxHp: number;
  private readonly aiRespawnEnabled: boolean;
  private readonly coopInfectionMode: boolean;
  private readonly localAllyTeam: BattleTeamId;
  private readonly worldAdapter: IBodycamWorldAdapter | null;
  private readonly worldOnlyAdapter: IBodycamWorldAdapter;
  private readonly vaultDetector = new VaultDetector();
  private readonly _vaultCandidate: VaultCandidate = createVaultCandidate();
  private isClientReplica: boolean;

  // Zone/door gating for friendly Infection bots
  private readonly unlockedZones = new Set<string>(['lobby', 'default']);
  private readonly openedDoors = new Set<string>();

  // Universal Allied Bot Comms throttling & call-and-response queue
  private readonly weaponSpecCache = new Map<string, BotWeaponCombatSpec>();
  private globalCommsCooldown = 0;
  private elapsedClockSec = 0;
  private readonly pendingAcks: PendingSquadAck[] = [];
  private onBotCommsCb: ((ev: BotCommsEvent) => void) | null = null;
  private onBotGrenadeCb: ((ev: BotGrenadeEvent) => void) | null = null;
  private onAssistAwardedCb: ((assisterId: string) => void) | null = null;
  private modeController: BattleModeController | null = null;

  public scoreA = 0;
  public scoreB = 0;
  private nextKillfeedId = 1;
  private readonly killfeed: BattleKillfeedEntry[] = [];

  // Shared operator rig factory & disposables for clean teardown
  private readonly rigFactory: TacticalOperatorRigFactory;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly activeHitMeshes: THREE.Object3D[] = [];

  // Pre-allocated zero-GC scratch objects
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpOrigin = new THREE.Vector3();
  private readonly _tmpTarget = new THREE.Vector3();
  private readonly _tmpMuzzle = new THREE.Vector3();
  private readonly _tmpMid = new THREE.Vector3();
  private readonly _tmpToTarget = new THREE.Vector3();
  private readonly _tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly _wallProbeOrigin = new THREE.Vector3();
  private readonly _wallProbeDir = new THREE.Vector3();
  private readonly _wallProbeRight = new THREE.Vector3();
  private readonly _wallRayOut: BodycamRaycastResult = createRaycastResult();
  private readonly _poseScratch: TacticalCombatPose = {
    crouchBlend: 0,
    leanBlend: 0,
    aimPitch: 0,
    adsBlend: 0,
    pointAimBlend: 0,
    cantBlend: 0,
    reloadBlend: 0,
    speedMps: 0,
    walkCycle: 0,
    sprint: false,
    recoilKick: 0,
    firingVibration: 0,
    flinchPitch: 0,
    vaultBlend: 0,
    vaultProgress: 0,
    vaultKind: 'VAULT_OVER',
    wallObstruction01: 0,
    beltWallTuck01: 0,
  };

  constructor(
    scene: THREE.Scene,
    map: BuiltMapInstance,
    audio: BodycamAudio,
    rule: BattleRuleId,
    botCount: number,
    difficulty: BotDifficultyId,
    tuning?: BattleBotTuningOptions,
  ) {
    this.map = map;
    this.audio = audio;
    this.rule = rule;
    this.coopInfectionMode = Boolean(tuning?.coopInfectionMode);
    this.localAllyTeam = tuning?.localAllyTeam ?? 'A';
    this.worldOnlyAdapter = map.physics.createAdapter();
    this.worldAdapter = tuning?.worldAdapter ?? this.worldOnlyAdapter;
    const baseDiff = DIFFICULTY_TABLE[difficulty];
    const accMult = Math.max(0.25, Math.min(2.5, tuning?.aiAccuracyMult ?? 1.0));
    const spdMult = Math.max(0.5, Math.min(2.0, tuning?.aiMoveSpeedMult ?? 1.0));
    this.diff = {
      ...baseDiff,
      spreadRad: baseDiff.spreadRad / accMult,
      reactionSec: baseDiff.reactionSec / Math.sqrt(accMult),
      moveSpeed: baseDiff.moveSpeed * spdMult,
    };
    this.aiMaxHp = Math.max(
      25,
      Math.min(400, Math.round(tuning?.aiHealth ?? (this.coopInfectionMode ? 150 : 100))),
    );
    this.aiRespawnEnabled = tuning?.aiRespawnEnabled ?? true;
    this.isClientReplica = Boolean(tuning?.isClientReplica);
    this.modeController = tuning?.modeController ?? null;

    scene.add(this.group);

    this.rigFactory = new TacticalOperatorRigFactory(tuning?.maxAnisotropy ?? 4);

    // Pooled visible tracers
    const geoTracer = this.track(new THREE.CylinderGeometry(0.011, 0.011, 1.0, 5));
    const matTracer = this.track(
      new THREE.MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.85 }),
    );
    for (let i = 0; i < MAX_TRACERS; i++) {
      const m = new THREE.Mesh(geoTracer, matTracer);
      m.visible = false;
      this.group.add(m);
      this.tracers.push({ active: false, life: 0, maxLife: 0.085, mesh: m });
    }

    // Spawn bots with guaranteed balanced mix of FEMALE and MALE operators
    const clampedCount = Math.max(0, Math.min(10, botCount));
    let countA = 0;
    let countB = 0;
    let maleCountA = 0;
    let femaleCountA = 0;
    let maleCountB = 0;
    let femaleCountB = 0;
    let maleCountFfa = 0;
    let femaleCountFfa = 0;
    const startFemalePolarity = clampedCount === 1 ? Math.random() < 0.5 : false;

    for (let i = 0; i < clampedCount; i++) {
      let team: BattleTeamId = 'FFA';
      let name = '';
      let weaponId = i % 2 === 0 ? 'akm_762' : 'm4a1';
      let operatorId: OperatorId;

      if (this.coopInfectionMode) {
        // Always friendly Team A squadmates in Infection mode; alternating Female/Male mix
        // TRUE PISTOL START: every Infection bot starts with Glock 17 + 500 PTS matching player!
        team = 'A';
        const isFemale = startFemalePolarity ? i % 2 === 0 : i % 2 === 1;
        operatorId = isFemale ? 'FEMALE' : 'MALE';
        name = isFemale
          ? FEMALE_CALLSIGNS_A[femaleCountA++ % FEMALE_CALLSIGNS_A.length]
          : MALE_CALLSIGNS_A[maleCountA++ % MALE_CALLSIGNS_A.length];
        weaponId = 'glock_17';
        countA++;
      } else if (isTeamBattleRule(rule)) {
        // Player occupies 1 slot on Team A -> put slightly more bots on Team B so totals stay even
        const teamATotalWithPlayer = countA + 1;
        if (teamATotalWithPlayer <= countB) {
          team = 'A';
          const isFemale = countA % 2 === 0;
          operatorId = isFemale ? 'FEMALE' : 'MALE';
          name = isFemale
            ? FEMALE_CALLSIGNS_A[femaleCountA++ % FEMALE_CALLSIGNS_A.length]
            : MALE_CALLSIGNS_A[maleCountA++ % MALE_CALLSIGNS_A.length];
          weaponId = countA % 2 === 0 ? 'm4a1' : 'hk416';
          countA++;
        } else {
          team = 'B';
          const isFemale = countB % 2 === 1;
          operatorId = isFemale ? 'FEMALE' : 'MALE';
          name = isFemale
            ? FEMALE_CALLSIGNS_B[femaleCountB++ % FEMALE_CALLSIGNS_B.length]
            : MALE_CALLSIGNS_B[maleCountB++ % MALE_CALLSIGNS_B.length];
          weaponId = countB % 2 === 0 ? 'akm_762' : 'aks74u';
          countB++;
        }
      } else {
        // FFA: guaranteed balanced mix of Female & Male operators
        const isFemale = startFemalePolarity ? i % 2 === 0 : i % 2 === 1;
        operatorId = isFemale ? 'FEMALE' : 'MALE';
        name = isFemale
          ? FEMALE_CALLSIGNS_FFA[femaleCountFfa++ % FEMALE_CALLSIGNS_FFA.length]
          : MALE_CALLSIGNS_FFA[maleCountFfa++ % MALE_CALLSIGNS_FFA.length];
      }

      const id = `bot_${i}`;
      const uniformId: OperatorUniformId = this.coopInfectionMode
        ? 'infection'
        : resolveOperatorUniformId('battle', team);
      const rig = this.rigFactory.buildOperator('bot', id, uniformId, operatorId);
      const botFacePresets = ['face_01', 'face_02', 'face_03'] as const;
      rig.setGearAppearance({
        facePreset: botFacePresets[i % botFacePresets.length],
        faceGear: i % 5 === 0 ? 'balaclava' : i % 2 === 0 ? 'open_face' : 'neck_gaiter',
        eyewear: i % 6 === 0 ? 'tinted_visor' : i % 3 === 1 ? 'clear_glasses' : 'none',
      });
      const initSpec = this.getWeaponSpec(weaponId);
      const initAtt = buildBotAttachmentsForWeapon(initSpec.id, i, this.coopInfectionMode);
      const ownsSuppressor = Boolean(getOwnedSuppressorDef(initAtt));
      const suppressed = ownsSuppressor && !initAtt.suppressorStowed;
      rig.setWeaponClass(initSpec.visualClass);
      rig.setWeaponLoadout(initSpec.id, initAtt);
      rig.setSuppressedVisual(suppressed);
      this.group.add(rig.root);

      const initialPouch = this.buildBotGrenadePouch(i);
      const initialPrimaryGrenade: TacticalEquipmentId = this.coopInfectionMode
        ? 'm67_frag'
        : (['m67_frag', 'm84_flash', 'an_m14_thermite', 'm18_smoke'] as const)[i % 4];

      const bot: BotActor = {
        id,
        name,
        team,
        uniformId,
        operatorId,
        weaponId: initSpec.id,
        weaponLabel: initSpec.label,
        weaponClass: initSpec.visualClass,
        botSeedIndex: i,
        attachments: initAtt,
        ownsSuppressor,
        suppressed,
        handlingAction: 'NONE',
        handlingTimer: 0,
        handlingDuration: 0,
        suppToggleCooldown: 12 + i * 3.5 + Math.random() * 8,
        pendingSuppressorAttach: suppressed,
        netHandlingAction: 'NONE',
        netHandlingProgress: 0,
        netSuppressed: suppressed,
        grenadePouch: initialPouch,
        primaryGrenadeId: initialPrimaryGrenade,
        grenadeCooldown: 6 + i * 2.2 + Math.random() * 6,
        grenadeStage: 'HOLSTERED',
        grenadeStageTimer: 0,
        grenadeEquipId: initialPrimaryGrenade,
        grenadeFuseSec: 4.5,
        grenadeFuseRemaining: 4.5,
        grenadeCookTargetSec: 0,
        grenadeThrowStyle: 'overhand',
        grenadeCharge01: 0,
        grenadeChargeTarget: 0.65,
        grenadeSpoonPopped: false,
        grenadeThrowDispatched: false,
        grenadeTargetPos: new THREE.Vector3(),
        grenadeOvercookRisk: false,
        netGrenadeEquipId: initialPrimaryGrenade,
        netGrenadeCharge01: 0,
        netGrenadeThrowStyle: 'overhand',
        alive: true,
        hp: this.aiMaxHp,
        maxHp: this.aiMaxHp,
        kills: 0,
        deaths: 0,
        headshots: 0,
        assists: 0,
        grenadeKills: 0,
        meleeKills: 0,
        damageDealt: 0,
        afkSeconds: 0,
        recentAttackers: new Map<string, number>(),
        respawnTimer: 0,
        deathTimer: 0,
        conquestEliminated: false,
        conquestLoadoutIndex: 0,
        conquestLoadoutRoster: (() => {
          const basePool =
            team === 'B'
              ? ['akm_762', 'aks74u', 'hk_mp5', 'remington_870', 'm4a1']
              : ['m4a1', 'hk416', 'hk_mp5', 'remington_870', 'akm_762'];
          const roster: string[] = [initSpec.id];
          for (let r = 0; r < basePool.length; r++) {
            const candidate = basePool[(i + r) % basePool.length];
            if (!roster.includes(candidate)) roster.push(candidate);
          }
          return roster;
        })(),
        points: this.coopInfectionMode ? 500 : 0,
        weaponSlots: [initSpec.id],
        activeSlotIndex: 0,
        magAmmoByWeapon: { [initSpec.id]: initSpec.magCapacity },
        reserveAmmoByWeapon: { [initSpec.id]: this.coopInfectionMode ? initSpec.reserveMax : -1 },
        perks: new Set<InfectionPerkId>(),
        reloadTimer: 0,
        reloadDuration: initSpec.reloadSec,
        netReloading: false,
        meleeCooldown: 0,
        economyGoal: null,
        economyEvalTimer: 1.5 + i * 0.65,
        barrierRepairAccum: 0,
        commsCooldown: 2.0 + i * 1.1,
        lowHpCalledOut: false,
        lastContactCalloutSec: -20,
        prevHasLos: false,
        pos: new THREE.Vector3(),
        netPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        netYaw: 0,
        targetYaw: 0,
        walkCycle: Math.random() * Math.PI * 2,
        flinchTimer: 0,
        stunTimer: 0,
        hasNetState: false,
        firingVisualTimer: 0,
        recoilKick: 0,
        crouchBlend: 0,
        targetCrouch: 0,
        netCrouch: 0,
        leanBlend: 0,
        targetLean: 0,
        netLean: 0,
        postureEvalTimer: Math.random() * 0.25,
        wallObstruction01: 0,
        beltWallTuck01: 0,
        vaultActive: false,
        vaultKind: 'VAULT_OVER',
        vaultStartPos: new THREE.Vector3(),
        vaultApexPos: new THREE.Vector3(),
        vaultEndPos: new THREE.Vector3(),
        vaultT: 0,
        vaultDuration: 0.65,
        vaultCooldown: 0.5,
        vaultProbeTimer: Math.random() * 0.25,
        vaultCrouchFinish: false,
        netVaulting: false,
        netVaultProgress: 0,
        path: [],
        pathIndex: 0,
        repathTimer: Math.random() * 0.6,
        goalNodeId: null,
        stuckTimer: 0,
        lastProgressX: 0,
        lastProgressZ: 0,
        avoidDir: Math.random() < 0.5 ? -1 : 1,
        unstuckBoostTimer: 0,
        targetId: null,
        hasLos: false,
        losTimer: Math.random() * 0.16,
        reactionTimer: this.diff.reactionSec,
        strafeDir: Math.random() < 0.5 ? -1 : 1,
        strafeTimer: 1.0 + Math.random() * 1.4,
        burstShotsLeft: 0,
        fireTimer: 0,
        burstCooldown: 0.4 + Math.random() * 0.5,
        muzzleFlashTimer: 0,
        smokeAlertTimer: 0,
        smokeFlankDir: Math.random() < 0.5 ? -1 : 1,
        smokeCloudPos: new THREE.Vector3(),
        doorInteractCooldown: 0,
        doorAlertTimer: 0,
        doorAlertPos: new THREE.Vector3(),
        rig,
        ragdoll: new ArticulatedRagdoll(),
        root: rig.root,
        bodyPivot: rig.bodyPivot,
        leftLeg: rig.leftLeg,
        rightLeg: rig.rightLeg,
        weaponPivot: rig.weaponPivot,
        muzzleFlash: rig.muzzleFlash,
        hitMeshes: rig.hitMeshes,
      };

      this.bots.push(bot);
      if (this.modeController && this.rule === 'conquest') {
        this.modeController.initBotConquestLives(
          bot.id,
          this.modeController.getConquestTotalLoadouts(),
          bot.team,
        );
      }
      this.spawnBot(bot, new THREE.Vector3(0, 0, 0), i);
      bot.lastProgressX = bot.pos.x;
      bot.lastProgressZ = bot.pos.z;
      bot.netPos.copy(bot.pos);
      bot.netYaw = bot.yaw;
    }

    this.rebuildActiveHitMeshes();
  }

  private track<T extends { dispose: () => void }>(res: T): T {
    this.disposables.push(res);
    return res;
  }

  public getHitMeshes(): THREE.Object3D[] {
    return this.activeHitMeshes;
  }

  private rebuildActiveHitMeshes(): void {
    this.activeHitMeshes.length = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) continue;
      for (let j = 0; j < b.rig.beltHitMeshes.length; j++) {
        this.activeHitMeshes.push(b.rig.beltHitMeshes[j]);
      }
      for (let j = 0; j < b.hitMeshes.length; j++) {
        this.activeHitMeshes.push(b.hitMeshes[j]);
      }
    }
  }

  private sampleGroundY(x: number, z: number, refY: number): number {
    const physY = this.map.physics.getGroundHeight(x, z, refY, 0.75, 0.14);
    if (this.map.terrainHeightAt) {
      const terrY = this.map.terrainHeightAt(x, z);
      return Math.max(physY, terrY);
    }
    return physY;
  }

  public setModeController(ctrl: BattleModeController | null): void {
    this.modeController = ctrl;
    if (ctrl && this.rule === 'conquest') {
      const totalLives = ctrl.getConquestTotalLoadouts();
      for (const b of this.bots) {
        b.conquestEliminated = false;
        b.conquestLoadoutIndex = 0;
        ctrl.initBotConquestLives(b.id, totalLives, b.team);
      }
    }
  }

  public getModeActorSamples(): ModeActorSample[] {
    const out: ModeActorSample[] = [];
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      out.push({
        id: b.id,
        name: b.name,
        team: b.team,
        alive: b.alive,
        x: b.pos.x,
        y: b.pos.y,
        z: b.pos.z,
      });
    }
    return out;
  }

  public getAliveTeammateSpectateTargets(team: BattleTeamId): Array<{
    id: string;
    name: string;
    pos: THREE.Vector3;
    yaw: number;
  }> {
    const out: Array<{ id: string; name: string; pos: THREE.Vector3; yaw: number }> = [];
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) continue;
      if (isTeamBattleRule(this.rule) && b.team !== team) continue;
      out.push({ id: b.id, name: b.name, pos: b.pos, yaw: b.yaw });
    }
    return out;
  }

  private pickSpawnPoint(team: BattleTeamId, avoidPos: Readonly<THREE.Vector3>, seedIdx?: number): SpawnPoint {
    let pool: SpawnPoint[];
    if (this.rule === 'conquest' && this.modeController && (team === 'A' || team === 'B')) {
      pool =
        seedIdx !== undefined
          ? this.modeController.getOpeningHqSpawns(team)
          : this.modeController.getBotConquestSpawnCandidates(team);
    } else if (isTeamBattleRule(this.rule)) {
      pool = team === 'A' ? this.map.spawnPoints.teamA : this.map.spawnPoints.teamB;
    } else {
      pool = this.map.spawnPoints.ffa;
    }

    const list = pool.length > 0 ? pool : this.map.spawnPoints.ffa;
    if (seedIdx !== undefined && seedIdx < list.length) {
      return list[seedIdx];
    }

    // Use universal Battle Spawn Protection safe-spawn scorer when modeController is attached
    if (this.modeController && !this.coopInfectionMode) {
      const enemies: Array<{ x: number; y: number; z: number }> = [];
      if (isFreeForAllBattleRule(this.rule) || team !== this.localAllyTeam) {
        enemies.push({ x: avoidPos.x, y: avoidPos.y, z: avoidPos.z });
      }
      for (let j = 0; j < this.bots.length; j++) {
        const other = this.bots[j];
        if (!other.alive) continue;
        if (this.isHostilePair(team, other.team)) {
          enemies.push({ x: other.pos.x, y: other.pos.y, z: other.pos.z });
        }
      }
      return this.modeController.selectSafeSpawnPoint(list, enemies, this.map.raycastMeshes);
    }

    // Fallback: Choose spawn farthest from hostile actors & player
    let best = list[0];
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      let minHostileDistSq = Infinity;

      if (isFreeForAllBattleRule(this.rule) || team === 'B') {
        const dx = sp.position[0] - avoidPos.x;
        const dz = sp.position[2] - avoidPos.z;
        minHostileDistSq = Math.min(minHostileDistSq, dx * dx + dz * dz);
      }

      for (let j = 0; j < this.bots.length; j++) {
        const other = this.bots[j];
        if (!other.alive) continue;
        const dx = sp.position[0] - other.pos.x;
        const dz = sp.position[2] - other.pos.z;
        const dSq = dx * dx + dz * dz;
        const isHostile = isFreeForAllBattleRule(this.rule) || other.team !== team;
        if (isHostile) {
          minHostileDistSq = Math.min(minHostileDistSq, dSq);
        } else if (dSq < 2.25) {
          minHostileDistSq -= 25;
        }
      }

      const score = minHostileDistSq + Math.random() * 14;
      if (score > bestScore) {
        bestScore = score;
        best = sp;
      }
    }
    return best;
  }

  private spawnBot(bot: BotActor, playerPos: Readonly<THREE.Vector3>, seedIdx?: number): void {
    if (this.rule === 'conquest' && bot.conquestEliminated) {
      bot.alive = false;
      bot.respawnTimer = Number.POSITIVE_INFINITY;
      return;
    }
    if (this.rule === 'conquest' && seedIdx === undefined && this.modeController) {
      if (!this.modeController.onConquestParticipantRespawn(bot.id)) {
        bot.conquestEliminated = true;
        bot.alive = false;
        bot.respawnTimer = Number.POSITIVE_INFINITY;
        return;
      }
      if (bot.conquestLoadoutRoster.length > 0) {
        const nextWeaponId =
          bot.conquestLoadoutRoster[bot.conquestLoadoutIndex % bot.conquestLoadoutRoster.length];
        if (nextWeaponId && nextWeaponId !== bot.weaponId) {
          this.applyBotActiveWeapon(bot, nextWeaponId);
        }
      }
    }

    const sp = this.pickSpawnPoint(bot.team, playerPos, seedIdx);
    const jitterX = (Math.random() - 0.5) * 0.8;
    const jitterZ = (Math.random() - 0.5) * 0.8;
    const sx = sp.position[0] + jitterX;
    const sz = sp.position[2] + jitterZ;
    const sy = this.sampleGroundY(sx, sz, sp.position[1]);

    bot.alive = true;
    bot.hp = bot.maxHp;
    bot.respawnTimer = 0;
    bot.deathTimer = 0;
    bot.pos.set(sx, sy, sz);
    bot.vel.set(0, 0, 0);
    bot.yaw = sp.yaw;
    bot.targetYaw = sp.yaw;
    bot.path = [];
    bot.pathIndex = 0;
    bot.goalNodeId = null;
    bot.targetId = null;
    bot.hasLos = false;
    bot.burstShotsLeft = 0;
    bot.reactionTimer = this.diff.reactionSec;
    bot.flinchTimer = 0;
    bot.reloadTimer = 0;
    bot.handlingAction = 'NONE';
    bot.handlingTimer = 0;
    bot.handlingDuration = 0;
    bot.grenadeStage = 'HOLSTERED';
    bot.grenadeStageTimer = 0;
    bot.grenadeCharge01 = 0;
    bot.grenadeSpoonPopped = false;
    bot.grenadeThrowDispatched = false;
    if (!this.coopInfectionMode) {
      bot.grenadePouch = this.buildBotGrenadePouch(bot.botSeedIndex);
    }
    this.syncBotBeltGrenade(bot);
    bot.lowHpCalledOut = false;
    bot.economyGoal = null;
    bot.prevHasLos = false;

    if (!this.coopInfectionMode) {
      const spec = this.getWeaponSpec(bot.weaponId);
      bot.magAmmoByWeapon[bot.weaponId] = spec.magCapacity;
      this.modeController?.grantSpawnProtection(bot.id);
    }

    bot.ragdoll.deactivate();
    bot.rig.resetRagdollPose();
    bot.rig.setWeaponClass(bot.weaponClass);
    bot.rig.setWeaponLoadout(bot.weaponId, bot.attachments);
    bot.rig.setSuppressedVisual(bot.suppressed);
    bot.root.visible = true;
    bot.root.position.copy(bot.pos);
    bot.root.quaternion.identity();
    bot.root.rotation.set(0, bot.yaw, 0);
    bot.muzzleFlash.visible = false;
    this.rebuildActiveHitMeshes();
  }

  private buildBotGrenadePouch(seedIndex: number): Partial<Record<TacticalEquipmentId, number>> {
    if (this.coopInfectionMode) {
      return { m67_frag: 2, an_m14_thermite: 1 };
    }
    const mod = seedIndex % 4;
    if (mod === 1) {
      return { m84_flash: 2, m67_frag: 1 };
    }
    if (mod === 2) {
      return { an_m14_thermite: 2, m67_frag: 1 };
    }
    if (mod === 3) {
      return { m18_smoke: 2, m67_frag: 1 };
    }
    return { m67_frag: 2, m84_flash: 1 };
  }

  private getBotTotalGrenades(bot: BotActor): number {
    let total = 0;
    for (const v of Object.values(bot.grenadePouch)) {
      if (typeof v === 'number' && v > 0) total += v;
    }
    return total;
  }

  private syncBotBeltGrenade(bot: BotActor): void {
    const total = this.getBotTotalGrenades(bot);
    const activeCount = bot.grenadePouch[bot.primaryGrenadeId] ?? 0;
    let displayId = bot.primaryGrenadeId;
    if (activeCount <= 0) {
      for (const id of ['m67_frag', 'm84_flash', 'm18_smoke', 'an_m14_thermite'] as TacticalEquipmentId[]) {
        if ((bot.grenadePouch[id] ?? 0) > 0) {
          displayId = id;
          break;
        }
      }
    }
    bot.rig.setBeltEquipment(
      displayId,
      'front_left',
      total,
      bot.alive && total > 0 && bot.grenadeStage === 'HOLSTERED',
    );
    this.rebuildActiveHitMeshes();
  }

  public consumeBotBeltGrenade(
    botId: string,
    preferredId?: TacticalEquipmentId,
  ): TacticalEquipmentId | null {
    const bot = this.bots.find((b) => b.id === botId);
    if (!bot || !bot.alive) return null;

    let chosen: TacticalEquipmentId | null = null;
    if (preferredId && (bot.grenadePouch[preferredId] ?? 0) > 0) {
      chosen = preferredId;
    } else if ((bot.grenadePouch[bot.primaryGrenadeId] ?? 0) > 0) {
      chosen = bot.primaryGrenadeId;
    } else {
      for (const id of ['m67_frag', 'm84_flash', 'm18_smoke', 'an_m14_thermite'] as TacticalEquipmentId[]) {
        if ((bot.grenadePouch[id] ?? 0) > 0) {
          chosen = id;
          break;
        }
      }
    }
    if (!chosen) return null;

    bot.grenadePouch[chosen] = Math.max(0, (bot.grenadePouch[chosen] ?? 0) - 1);
    this.syncBotBeltGrenade(bot);
    return chosen;
  }

  private updateBotWallClearance(bot: BotActor, dt: number, aimPitch: number): void {
    const fx = -Math.sin(bot.yaw);
    const fz = -Math.cos(bot.yaw);
    const rx = Math.cos(bot.yaw);
    const rz = -Math.sin(bot.yaw);

    // 1) Forward weapon barrel obstruction probe -> CQB weapon pullback so AI rifles never poke through walls
    const barrelReach =
      bot.weaponClass === 'pistol'
        ? 0.60
        : 0.96 + (bot.suppressed ? 0.14 : 0);
    const chestY = bot.pos.y + 1.32 - bot.crouchBlend * 0.38;
    let targetWallObs = 0;

    this._wallProbeDir.set(fx, Math.sin(aimPitch) * 0.45, fz).normalize();
    this._wallProbeOrigin.set(bot.pos.x - fx * 0.08, chestY, bot.pos.z - fz * 0.08);
    if (
      this.worldOnlyAdapter.raycast(
        this._wallProbeOrigin,
        this._wallProbeDir,
        0.02,
        barrelReach + 0.12,
        this._wallRayOut,
      )
    ) {
      targetWallObs = THREE.MathUtils.clamp((barrelReach + 0.08 - this._wallRayOut.distance) / 0.42, 0, 1);
    }

    // 2) Short 4-way waist probe -> pulls belt & belt grenades inward when pressed flush against walls
    const beltY = bot.pos.y + 0.90 - bot.crouchBlend * 0.34;
    let minBeltDist = 0.36;
    this._wallProbeRight.set(rx, 0, rz);
    for (let d = 0; d < 4; d++) {
      this._wallProbeOrigin.set(bot.pos.x, beltY, bot.pos.z);
      if (d === 0) this._wallProbeDir.set(fx, 0, fz);
      else if (d === 1) this._wallProbeDir.set(-fx, 0, -fz);
      else if (d === 2) this._wallProbeDir.copy(this._wallProbeRight);
      else this._wallProbeDir.copy(this._wallProbeRight).negate();
      if (this.worldOnlyAdapter.raycast(this._wallProbeOrigin, this._wallProbeDir, 0.02, 0.36, this._wallRayOut)) {
        if (this._wallRayOut.distance < minBeltDist) minBeltDist = this._wallRayOut.distance;
      }
    }
    const targetBeltTuck = THREE.MathUtils.clamp((0.33 - minBeltDist) / 0.16, 0, 1);

    bot.wallObstruction01 = THREE.MathUtils.damp(bot.wallObstruction01, targetWallObs, 18, dt);
    bot.beltWallTuck01 = THREE.MathUtils.damp(bot.beltWallTuck01, targetBeltTuck, 18, dt);
  }

  public setBotGrenadeListener(listener: ((ev: BotGrenadeEvent) => void) | null): void {
    this.onBotGrenadeCb = listener;
  }

  public setAssistListener(listener: ((assisterId: string) => void) | null): void {
    this.onAssistAwardedCb = listener;
  }

  public replenishBotGrenades(): void {
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      b.grenadePouch = this.buildBotGrenadePouch(b.botSeedIndex);
      this.syncBotBeltGrenade(b);
    }
  }

  public resetMatch(playerPos: Readonly<THREE.Vector3>): void {
    this.scoreA = 0;
    this.scoreB = 0;
    this.killfeed.length = 0;
    this.pendingAcks.length = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      b.kills = 0;
      b.deaths = 0;
      b.headshots = 0;
      b.assists = 0;
      b.grenadeKills = 0;
      b.meleeKills = 0;
      b.damageDealt = 0;
      b.afkSeconds = 0;
      b.recentAttackers.clear();
      b.conquestEliminated = false;
      b.conquestLoadoutIndex = 0;
      if (this.rule === 'conquest' && this.modeController) {
        this.modeController.initBotConquestLives(
          b.id,
          this.modeController.getConquestTotalLoadouts(),
          b.team,
        );
        if (b.conquestLoadoutRoster[0] && b.conquestLoadoutRoster[0] !== b.weaponId) {
          this.applyBotActiveWeapon(b, b.conquestLoadoutRoster[0]);
        }
      }
      if (this.coopInfectionMode) {
        const pistolSpec = this.getWeaponSpec('glock_17');
        b.points = 500;
        b.maxHp = this.aiMaxHp;
        b.hp = this.aiMaxHp;
        b.perks.clear();
        b.weaponSlots = ['glock_17'];
        b.activeSlotIndex = 0;
        b.magAmmoByWeapon = { glock_17: pistolSpec.magCapacity };
        b.reserveAmmoByWeapon = { glock_17: pistolSpec.reserveMax };
        this.applyBotActiveWeapon(b, 'glock_17');
      }
      this.spawnBot(b, playerPos, i);
    }
  }

  private getWeaponSpec(weaponId: string): BotWeaponCombatSpec {
    let spec = this.weaponSpecCache.get(weaponId);
    if (!spec) {
      spec = buildBotWeaponSpec(weaponId);
      this.weaponSpecCache.set(weaponId, spec);
    }
    return spec;
  }

  private applyBotActiveWeapon(bot: BotActor, weaponId: string): void {
    const spec = this.getWeaponSpec(weaponId);
    bot.weaponId = spec.id;
    bot.weaponLabel = spec.label;
    bot.weaponClass = spec.visualClass;
    bot.attachments = buildBotAttachmentsForWeapon(spec.id, bot.botSeedIndex, this.coopInfectionMode);
    bot.ownsSuppressor = Boolean(getOwnedSuppressorDef(bot.attachments));
    bot.suppressed = bot.ownsSuppressor && !bot.attachments.suppressorStowed;
    bot.handlingAction = 'NONE';
    bot.handlingTimer = 0;
    bot.handlingDuration = 0;
    bot.reloadDuration = spec.reloadSec / (bot.perks.has('rapid_handling') ? 1.6 : 1.0);
    bot.rig.setWeaponClass(spec.visualClass);
    bot.rig.setWeaponLoadout(spec.id, bot.attachments);
    bot.rig.setSuppressedVisual(bot.suppressed);
  }

  private grantBotInfectionWeapon(bot: BotActor, weaponId: string): BotWeaponCombatSpec {
    const spec = this.getWeaponSpec(weaponId);
    bot.magAmmoByWeapon[spec.id] = spec.magCapacity;
    bot.reserveAmmoByWeapon[spec.id] = spec.reserveMax;

    const existingIdx = bot.weaponSlots.indexOf(spec.id);
    if (existingIdx >= 0) {
      bot.activeSlotIndex = existingIdx;
      this.applyBotActiveWeapon(bot, spec.id);
      return spec;
    }

    if (bot.weaponSlots.length < 2) {
      bot.weaponSlots.push(spec.id);
      bot.activeSlotIndex = bot.weaponSlots.length - 1;
    } else {
      // Replace the lower-tier slot (typically Glock 17 once bot upgrades)
      const tier0 = this.getWeaponSpec(bot.weaponSlots[0]).tier;
      const tier1 = this.getWeaponSpec(bot.weaponSlots[1]).tier;
      const replaceIdx = tier0 <= tier1 ? 0 : 1;
      bot.weaponSlots[replaceIdx] = spec.id;
      bot.activeSlotIndex = replaceIdx;
    }
    this.applyBotActiveWeapon(bot, spec.id);
    return spec;
  }

  public setBotCommsListener(listener: ((ev: BotCommsEvent) => void) | null): void {
    this.onBotCommsCb = listener;
  }

  private isAlliedBot(bot: BotActor): boolean {
    if (this.coopInfectionMode) return true;
    if (isTeamBattleRule(this.rule)) return bot.team === this.localAllyTeam;
    return false;
  }

  private emitAlliedComms(
    bot: BotActor,
    category: SquadCommsCategory,
    text: string,
    opts?: {
      force?: boolean;
      pingKind?: TacticalPingKind;
      pingLabel?: string;
      pingPos?: THREE.Vector3;
      triggerAck?: boolean;
      ackPool?: readonly string[];
    },
  ): boolean {
    if (this.isClientReplica || !this.onBotCommsCb || !this.isAlliedBot(bot)) return false;
    if (!opts?.force && (this.globalCommsCooldown > 0 || bot.commsCooldown > 0)) return false;

    this.globalCommsCooldown = opts?.force ? 1.15 : 2.35;
    bot.commsCooldown = opts?.force ? 2.5 : 5.8 + Math.random() * 2.5;

    this.onBotCommsCb({
      botId: bot.id,
      callsign: bot.name,
      team: bot.team,
      category,
      text,
      pingKind: opts?.pingKind ?? null,
      pingLabel: opts?.pingLabel ?? null,
      pingPos: opts?.pingPos ? opts.pingPos.clone() : null,
    });

    if (opts?.triggerAck && this.pendingAcks.length < 2) {
      const pool = opts.ackPool ?? [
        'Copy that, moving to support.',
        'Roger, watching your six.',
        'Solid copy — pushing up.',
        'Acknowledged, staying with you.',
      ];
      this.pendingAcks.push({
        dueTimer: 0.85 + Math.random() * 0.7,
        sourceBotId: bot.id,
        team: bot.team,
        text: pool[Math.floor(Math.random() * pool.length)],
      });
    }
    return true;
  }

  /**
   * Notifies allied bots when the human player places a [Z] tactical ping so a nearby
   * squadmate responds on VHF radio and adjusts awareness toward the mark.
   */
  public notifyPlayerPing(kind: TacticalPingKind, pos: Readonly<THREE.Vector3>, label: string): void {
    if (this.isClientReplica || !this.onBotCommsCb) return;
    if (!this.coopInfectionMode && !isTeamBattleRule(this.rule)) return;

    const candidates = this.bots.filter((b) => b.alive && this.isAlliedBot(b));
    if (candidates.length === 0) return;

    // Pick closest alive allied bot
    let best = candidates[0];
    let bestDistSq = best.pos.distanceToSquared(pos);
    for (let i = 1; i < candidates.length; i++) {
      const dSq = candidates[i].pos.distanceToSquared(pos);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = candidates[i];
      }
    }

    const cleanLabel = label.trim().slice(0, 22) || 'MARK';
    const ackLine =
      kind === 'enemy'
        ? `Copy contact on ${cleanLabel} — eyes on sector.`
        : kind === 'item'
          ? `Roger, noted ${cleanLabel} on tac-net.`
          : `Solid copy — shifting toward your mark.`;

    this.pendingAcks.push({
      dueTimer: 0.75 + Math.random() * 0.55,
      sourceBotId: 'player',
      team: best.team,
      text: ackLine,
    });
  }

  /**
   * Acoustic Door Hearing for AI Bots:
   *  - Quiet peeks / soft doorknob closes (loudness < 0.35) do NOT alert bots.
   *  - Loud slams, melee bashes, breach kicks, and destructive door smashes alert nearby
   *    hostile bots within radiusM to orient toward the breach and investigate.
   */
  public notifyDoorAcousticEvent(
    pos: Readonly<THREE.Vector3>,
    radiusM: number,
    loudness: number,
    actorTeam?: BattleTeamId,
  ): void {
    if (this.isClientReplica || loudness < 0.35 || radiusM <= 0.5) return;
    const rSq = radiusM * radiusM;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) continue;
      if (actorTeam && !this.isHostilePair(b.team, actorTeam)) continue;
      if (b.pos.distanceToSquared(pos) > rSq) continue;

      b.doorAlertPos.copy(pos);
      b.doorAlertTimer = Math.max(b.doorAlertTimer, loudness >= 0.8 ? 5.5 : 3.2);
      // Immediately snap attention yaw toward loud breach if not actively locked in a firefight
      if (!b.hasLos) {
        b.targetYaw = Math.atan2(pos.x - b.pos.x, pos.z - b.pos.z);
        b.losTimer = Math.min(b.losTimer, 0.06);
        if (loudness >= 0.75) {
          const nearNode = findNearestNavNode(this.map.navGraph, pos);
          if (nearNode) {
            b.goalNodeId = nearNode.id;
            b.repathTimer = 0.05;
          }
        }
      }
    }
  }

  public awardInfectionHitPoints(botId: string, amount = 10, damageDealt = 0): void {
    if (!this.coopInfectionMode) return;
    const b = this.bots.find((item) => item.id === botId);
    if (!b) return;
    b.points += amount;
    if (damageDealt > 0) b.damageDealt += Math.round(damageDealt);
  }

  public awardInfectionKillPoints(
    botId: string,
    headshot: boolean,
    melee = false,
    grenade = false,
    damageDealt = 0,
  ): void {
    if (!this.coopInfectionMode) return;
    const b = this.bots.find((item) => item.id === botId);
    if (!b) return;
    b.kills += 1;
    if (headshot) b.headshots += 1;
    if (melee) b.meleeKills += 1;
    if (grenade) b.grenadeKills += 1;
    if (damageDealt > 0) b.damageDealt += Math.round(damageDealt);
    b.points += melee ? 130 : headshot ? 100 : 60;
  }

  public awardInfectionRoundBonus(bonus: number, completedRound: number): void {
    if (!this.coopInfectionMode) return;
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].points += bonus;
    }
    const speaker = this.bots.find((b) => b.alive);
    if (speaker) {
      this.emitAlliedComms(
        speaker,
        'status',
        `Wave ${completedRound} clear — check mags, doors, and perks before next push.`,
        {
          force: true,
          triggerAck: true,
          ackPool: [
            'Copy — topping off ammo now.',
            'Roger, checking points for the next door.',
            'Solid copy, holding lobby sector.',
          ],
        },
      );
    }
  }

  public getInfectionSquadSummary(): InfectionBotStatusSummary[] {
    return this.bots.map((b) => ({
      id: b.id,
      name: b.name,
      alive: b.alive,
      hp: Math.round(b.hp),
      maxHp: b.maxHp,
      points: b.points,
      weaponLabel: b.weaponLabel,
      kills: b.kills,
    }));
  }

  public setClientReplica(replica: boolean): void {
    this.isClientReplica = replica;
    if (!replica) {
      for (const b of this.bots) {
        b.path = [];
        b.pathIndex = 0;
        b.repathTimer = 0.1;
        b.losTimer = 0.05;
      }
    }
  }

  public getBotInfo(botId: string): { id: string; name: string; team: BattleTeamId; alive: boolean } | null {
    const b = this.bots.find((item) => item.id === botId);
    if (!b) return null;
    return { id: b.id, name: b.name, team: b.team, alive: b.alive };
  }

  public getBotHeadPosition(botId: string, out: THREE.Vector3): boolean {
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (b.id === botId) {
        if (!b.alive) return false;
        out.set(b.pos.x, b.pos.y + 1.98, b.pos.z);
        return true;
      }
    }
    return false;
  }

  public triggerVisualFlinch(botId: string): void {
    const b = this.bots.find((item) => item.id === botId);
    if (b && b.alive) {
      b.flinchTimer = 0.16;
    }
  }

  private swapBotOperatorRig(bot: BotActor, nextOperatorId: OperatorId): void {
    const wasVisible = bot.root.visible;
    bot.rig.disposeWeapon();
    this.group.remove(bot.root);
    const rig = this.rigFactory.buildOperator('bot', bot.id, bot.uniformId, nextOperatorId);
    rig.root.position.copy(bot.pos);
    rig.root.rotation.set(0, bot.yaw, 0);
    rig.root.visible = wasVisible;
    this.group.add(rig.root);

    bot.operatorId = nextOperatorId;
    bot.rig = rig;
    bot.rig.setWeaponClass(bot.weaponClass);
    bot.rig.setWeaponLoadout(bot.weaponId, bot.attachments);
    bot.rig.setSuppressedVisual(bot.suppressed);
    bot.root = rig.root;
    bot.bodyPivot = rig.bodyPivot;
    bot.leftLeg = rig.leftLeg;
    bot.rightLeg = rig.rightLeg;
    bot.weaponPivot = rig.weaponPivot;
    bot.muzzleFlash = rig.muzzleFlash;
    bot.hitMeshes = rig.hitMeshes;
  }

  public setInfectionZones(unlockedZones: Iterable<string>, openedDoors: Iterable<string>): void {
    this.unlockedZones.clear();
    for (const z of unlockedZones) this.unlockedZones.add(z);
    this.openedDoors.clear();
    for (const d of openedDoors) this.openedDoors.add(d);
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].repathTimer = 0;
    }
  }

  public getAliveAllyTargets(): Array<{ id: string; pos: THREE.Vector3; alive: boolean }> {
    const out: Array<{ id: string; pos: THREE.Vector3; alive: boolean }> = [];
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) continue;
      out.push({ id: b.id, pos: b.pos, alive: true });
    }
    return out;
  }

  public getAliveBotCount(): number {
    let c = 0;
    for (let i = 0; i < this.bots.length; i++) {
      if (this.bots[i].alive) c++;
    }
    return c;
  }

  public getTotalBotCount(): number {
    return this.bots.length;
  }

  public applyZombieDamageToBot(botId: string, damage: number): boolean {
    const bot = this.bots.find((b) => b.id === botId);
    if (!bot || !bot.alive) return false;
    bot.hp -= damage;
    bot.flinchTimer = 0.22;
    if (bot.hp > 0 && bot.hp <= bot.maxHp * 0.36 && !bot.lowHpCalledOut) {
      bot.lowHpCalledOut = true;
      this.emitAlliedComms(bot, 'status', 'Taking heavy hits — need cover!', {
        pingKind: 'location',
        pingLabel: `${bot.name} LOW HP`,
        pingPos: new THREE.Vector3(bot.pos.x, bot.pos.y + 1.5, bot.pos.z),
      });
    }
    if (bot.hp <= 0) {
      this.emitAlliedComms(bot, 'status', 'Going down! Hold the line!', { force: true });
      this.killBot(bot, 'INFECTED', 'B', false, 'CLAWS');
      bot.respawnTimer = this.coopInfectionMode ? 14.0 : 4.0;
      return true;
    }
    return false;
  }

  public reviveAllDownedBots(anchorPos: Readonly<THREE.Vector3>): void {
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) {
        this.spawnBot(b, anchorPos, i);
      } else {
        b.hp = b.maxHp;
      }
    }
  }

  public exportSyncSnapshot(): GameBotsSyncPacket {
    const bots: SyncedBotState[] = this.bots.map((b) => {
      let ha: SyncedHandlingAction = b.handlingAction;
      let hprog = 0;
      if (ha !== 'NONE' && b.handlingDuration > 0) {
        hprog = THREE.MathUtils.clamp(b.handlingTimer / b.handlingDuration, 0, 1);
      } else if (b.reloadTimer > 0) {
        ha = 'RELOAD';
        hprog = THREE.MathUtils.clamp(1 - b.reloadTimer / Math.max(0.2, b.reloadDuration), 0, 1);
      }
      return {
        id: b.id,
        name: b.name,
        team: b.team,
        uniformId: b.uniformId,
        operatorId: b.operatorId,
        weaponId: b.weaponId,
        weaponLabel: b.weaponLabel,
        weaponClass: b.weaponClass,
        att: packSyncedWeaponAttachments(b.attachments),
        ha,
        hprog: Number(hprog.toFixed(3)),
        geq: b.grenadeStage !== 'HOLSTERED' ? b.grenadeEquipId : undefined,
        gc: b.grenadeStage !== 'HOLSTERED' ? Number(b.grenadeCharge01.toFixed(3)) : undefined,
        gts: b.grenadeStage !== 'HOLSTERED' ? b.grenadeThrowStyle : undefined,
        sup: b.suppressed,
        points: this.coopInfectionMode ? b.points : undefined,
        reloading: b.reloadTimer > 0,
        x: Number(b.pos.x.toFixed(3)),
        y: Number(b.pos.y.toFixed(3)),
        z: Number(b.pos.z.toFixed(3)),
        yaw: Number(b.yaw.toFixed(4)),
        alive: b.alive,
        hp: Math.round(b.hp),
        maxHp: b.maxHp,
        kills: b.kills,
        deaths: b.deaths,
        headshots: b.headshots,
        assists: b.assists,
        grenadeKills: b.grenadeKills,
        meleeKills: b.meleeKills,
        damageDealt: b.damageDealt,
        firing: b.muzzleFlashTimer > 0 || b.burstShotsLeft > 0,
        crouch: Number(b.crouchBlend.toFixed(2)),
        lean: Number(b.leanBlend.toFixed(2)),
        vaulting: b.vaultActive,
        vaultProgress: b.vaultActive ? Number(b.vaultT.toFixed(2)) : 0,
      };
    });
    return {
      type: 'game:bots_sync',
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      bots,
      ts: Date.now(),
    };
  }

  public applySyncSnapshot(pkt: GameBotsSyncPacket): void {
    if (!this.isClientReplica) return;
    this.scoreA = pkt.scoreA ?? this.scoreA;
    this.scoreB = pkt.scoreB ?? this.scoreB;

    let hitMeshesDirty = false;
    for (const sb of pkt.bots) {
      const bot = this.bots.find((b) => b.id === sb.id);
      if (!bot) continue;

      const resolvedUniform: OperatorUniformId =
        sb.uniformId ?? (this.coopInfectionMode ? 'infection' : resolveOperatorUniformId('battle', sb.team));
      if (bot.uniformId !== resolvedUniform) {
        bot.uniformId = resolvedUniform;
        bot.rig.applyUniform(resolvedUniform);
      }

      if (sb.operatorId) {
        const resolvedOp = normalizeOperatorId(sb.operatorId);
        if (bot.operatorId !== resolvedOp) {
          this.swapBotOperatorRig(bot, resolvedOp);
          hitMeshesDirty = true;
        }
      }

      if (sb.weaponClass && bot.weaponClass !== sb.weaponClass) {
        bot.weaponClass = sb.weaponClass;
        bot.rig.setWeaponClass(sb.weaponClass);
      }
      if (sb.weaponId) bot.weaponId = sb.weaponId;
      if (sb.weaponLabel) bot.weaponLabel = sb.weaponLabel;
      if (sb.att !== undefined) {
        bot.attachments = unpackSyncedWeaponAttachments(sb.att);
      }
      if (typeof sb.sup === 'boolean') {
        bot.netSuppressed = sb.sup;
        bot.suppressed = sb.sup;
      }
      bot.rig.setWeaponLoadout(bot.weaponId, bot.attachments);
      if (typeof sb.points === 'number') bot.points = sb.points;
      bot.netReloading = Boolean(sb.reloading);
      const nextHa: SyncedHandlingAction = sb.ha ?? (bot.netReloading ? 'RELOAD' : 'NONE');
      const nextHprog =
        typeof sb.hprog === 'number' && Number.isFinite(sb.hprog)
          ? THREE.MathUtils.clamp(sb.hprog, 0, 1)
          : 0;
      bot.netHandlingAction = nextHa;
      bot.netHandlingProgress = nextHprog;
      bot.netGrenadeEquipId = isTacticalEquipmentId(sb.geq)
        ? sb.geq
        : DEFAULT_TACTICAL_EQUIPMENT_ID;
      bot.netGrenadeCharge01 =
        typeof sb.gc === 'number' && Number.isFinite(sb.gc)
          ? THREE.MathUtils.clamp(sb.gc, 0, 1)
          : 0;
      bot.netGrenadeThrowStyle = sb.gts === 'underhand' ? 'underhand' : 'overhand';
      if (nextHa !== 'SUPPRESSOR_DETACH' && nextHa !== 'SUPPRESSOR_ATTACH') {
        bot.rig.setSuppressedVisual(bot.netSuppressed);
      }

      const wasAlive = bot.alive;
      bot.alive = sb.alive;
      bot.hp = sb.hp;
      bot.maxHp = sb.maxHp || bot.maxHp;
      bot.kills = sb.kills;
      bot.deaths = sb.deaths;
      if (typeof sb.headshots === 'number') bot.headshots = sb.headshots;
      if (typeof sb.assists === 'number') bot.assists = sb.assists;
      if (typeof sb.grenadeKills === 'number') bot.grenadeKills = sb.grenadeKills;
      if (typeof sb.meleeKills === 'number') bot.meleeKills = sb.meleeKills;
      if (typeof sb.damageDealt === 'number') bot.damageDealt = sb.damageDealt;
      bot.netPos.set(sb.x, sb.y, sb.z);
      bot.netYaw = sb.yaw;
      bot.netCrouch = typeof sb.crouch === 'number' ? sb.crouch : 0;
      bot.netLean = typeof sb.lean === 'number' ? sb.lean : 0;
      bot.netVaulting = Boolean(sb.vaulting);
      bot.netVaultProgress = typeof sb.vaultProgress === 'number' ? sb.vaultProgress : 0.5;
      if (sb.firing) {
        bot.firingVisualTimer = Math.max(bot.firingVisualTimer, 0.14);
      }

      const jumpSq = bot.pos.distanceToSquared(bot.netPos);
      if (!bot.hasNetState || (!wasAlive && bot.alive) || jumpSq > 36) {
        bot.pos.copy(bot.netPos);
        bot.yaw = bot.netYaw;
        bot.hasNetState = true;
      }

      if (wasAlive && !bot.alive) {
        bot.deathTimer = 0;
        bot.muzzleFlash.visible = false;
        bot.firingVisualTimer = 0;
        bot.recoilKick = 0;
        bot.vaultActive = false;
        bot.rig.resetRagdollPose();
        bot.ragdoll.initializeFromStandingPose(bot.pos, bot.yaw, bot.vel);
        this._tmpDir.set(Math.sin(bot.yaw), 0.14, Math.cos(bot.yaw)).normalize();
        bot.ragdoll.applyHitZoneImpulse('thorax', this._tmpDir, 3.8);
        hitMeshesDirty = true;
      } else if (!wasAlive && bot.alive) {
        bot.deathTimer = 0;
        bot.ragdoll.deactivate();
        bot.rig.resetRagdollPose();
        bot.root.quaternion.identity();
        bot.root.rotation.set(0, bot.yaw, 0);
        bot.root.visible = true;
        hitMeshesDirty = true;
      }
    }

    if (hitMeshesDirty) {
      this.rebuildActiveHitMeshes();
    }
  }

  public playRemoteBotFire(
    botId: string,
    ox: number,
    oy: number,
    oz: number,
    ex: number,
    ey: number,
    ez: number,
    suppressed = false,
  ): void {
    const bot = this.bots.find((b) => b.id === botId);
    const spec = bot ? this.getWeaponSpec(bot.weaponId) : null;
    const isSup = suppressed || Boolean(bot?.suppressed);
    if (bot && bot.alive) {
      bot.muzzleFlash.visible = !isSup;
      bot.muzzleFlashTimer = isSup ? 0.025 : 0.055;
      bot.firingVisualTimer = 0.16;
      bot.recoilKick = Math.min(1, bot.recoilKick + 0.85);
    }
    this._tmpMuzzle.set(ox, oy, oz);
    this._tmpOrigin.set(ex, ey, ez);
    this.spawnTracer(this._tmpMuzzle, this._tmpOrigin);
    this.audio.playWeaponCue('fire', {
      position: this._tmpMuzzle,
      weightClass: spec?.weightClass ?? 'carbine',
      caliberId: spec?.caliberId ?? '556x45',
      suppressed: isSup,
      intensity: spec?.visualClass === 'pistol' ? 0.56 : 0.72,
    });
  }

  public applyDamageFromPlayer(
    botId: string,
    baseDamage: number,
    hitZone: string,
    weaponLabel: string,
    attackerName = 'YOU',
    attackerTeam?: BattleTeamId,
    attackerTargetId = 'player',
    killMethod: 'bullet' | 'grenade' | 'melee' = 'bullet',
  ): BotDamageResult {
    const bot = this.bots.find((b) => b.id === botId);
    if (!bot || !bot.alive) {
      return {
        hit: false,
        botId,
        botName: '',
        killed: false,
        headshot: false,
        friendlyIgnored: false,
        appliedDamage: 0,
      };
    }
    const resolvedTeam: BattleTeamId =
      attackerTeam ?? (isTeamBattleRule(this.rule) ? 'A' : 'FFA');
    if (this.coopInfectionMode || (isTeamBattleRule(this.rule) && bot.team === resolvedTeam)) {
      return {
        hit: false,
        botId: bot.id,
        botName: bot.name,
        killed: false,
        headshot: false,
        friendlyIgnored: true,
        appliedDamage: 0,
      };
    }

    // Universal Battle Spawn Protection absorbs incoming damage during brief post-spawn grace window
    if (this.modeController?.isSpawnProtected(bot.id)) {
      return {
        hit: false,
        botId: bot.id,
        botName: bot.name,
        killed: false,
        headshot: false,
        friendlyIgnored: false,
        appliedDamage: 0,
      };
    }

    const headshot = hitZone === 'head';
    const mult = headshot ? 2.4 : hitZone === 'limb' ? 0.72 : 1.0;
    const rawDmg = Math.max(8, baseDamage * mult);
    const appliedDamage = Math.min(bot.hp, rawDmg);
    bot.hp -= rawDmg;
    bot.flinchTimer = 0.16;
    bot.recentAttackers.set(attackerTargetId, performance.now());

    // Alert bot immediately toward attacker if alive
    if (bot.hp > 0) {
      bot.targetId = attackerTargetId;
      bot.reactionTimer = Math.min(bot.reactionTimer, this.diff.reactionSec * 0.45);
      return {
        hit: true,
        botId: bot.id,
        botName: bot.name,
        killed: false,
        headshot,
        friendlyIgnored: false,
        appliedDamage: Math.round(appliedDamage),
      };
    }

    this.killBot(
      bot,
      attackerName,
      resolvedTeam,
      headshot,
      weaponLabel,
      undefined,
      killMethod,
      attackerTargetId,
    );
    return {
      hit: true,
      botId: bot.id,
      botName: bot.name,
      killed: true,
      headshot,
      friendlyIgnored: false,
      appliedDamage: Math.round(appliedDamage),
    };
  }

  private killBot(
    victim: BotActor,
    killerName: string,
    killerTeam: BattleTeamId,
    headshot: boolean,
    weaponLabel: string,
    killerBot?: BotActor,
    killMethod: 'bullet' | 'grenade' | 'melee' = 'bullet',
    killerId?: string,
  ): void {
    // Live drop: if the bot had already popped its safety lever, drop the active armed grenade at palm
    if (victim.grenadeSpoonPopped && victim.grenadeStage !== 'HOLSTERED') {
      const palm = this.getBotPalmWorldPos(victim, new THREE.Vector3());
      const dropVel = new THREE.Vector3(
        (Math.random() - 0.5) * 1.4,
        1.1,
        (Math.random() - 0.5) * 1.4,
      );
      const prevCount = victim.grenadePouch[victim.grenadeEquipId] ?? 0;
      victim.grenadePouch[victim.grenadeEquipId] = Math.max(0, prevCount - 1);
      this.onBotGrenadeCb?.({
        botId: victim.id,
        botName: victim.name,
        team: victim.team,
        kind: 'live_drop',
        equipmentId: victim.grenadeEquipId,
        origin: palm,
        velocity: dropVel,
        fuseRemainingSec: Math.max(0.15, victim.grenadeFuseRemaining),
      });
    }
    victim.grenadeStage = 'HOLSTERED';
    victim.grenadeSpoonPopped = false;
    victim.grenadeCharge01 = 0;
    victim.handlingAction = 'NONE';
    victim.handlingTimer = 0;
    victim.handlingDuration = 0;

    victim.alive = false;
    victim.hp = 0;
    victim.deaths += 1;
    victim.respawnTimer = 4.0;
    victim.deathTimer = 0;
    victim.muzzleFlash.visible = false;
    victim.rig.resetRagdollPose();
    victim.ragdoll.initializeFromStandingPose(victim.pos, victim.yaw, victim.vel);
    if (killerBot) {
      this._tmpDir.subVectors(victim.pos, killerBot.pos);
      this._tmpDir.y = 0.22;
      if (this._tmpDir.lengthSq() < 1e-4) {
        this._tmpDir.set(Math.sin(victim.yaw), 0.16, Math.cos(victim.yaw));
      }
      this._tmpDir.normalize();
    } else {
      this._tmpDir.set(Math.sin(victim.yaw), 0.16, Math.cos(victim.yaw)).normalize();
    }
    victim.ragdoll.applyHitZoneImpulse(
      headshot ? 'head' : 'thorax',
      this._tmpDir,
      headshot ? 4.4 : 3.9,
    );

    const effectiveKillerId = killerBot?.id ?? killerId;
    if (killerBot) {
      killerBot.kills += 1;
      if (headshot) killerBot.headshots += 1;
      if (killMethod === 'grenade') killerBot.grenadeKills += 1;
      if (killMethod === 'melee') killerBot.meleeKills += 1;
    }

    // Award assists to any hostile attacker who damaged this bot within the last 10 seconds
    const nowMs = performance.now();
    for (const [assisterId, hitAtMs] of victim.recentAttackers.entries()) {
      if (nowMs - hitAtMs > 10000) continue;
      if (effectiveKillerId && assisterId === effectiveKillerId) continue;
      const assistBot = this.bots.find((b) => b.id === assisterId);
      if (assistBot) {
        if (!this.isHostilePair(assistBot.team, victim.team)) continue;
        assistBot.assists += 1;
      } else {
        this.onAssistAwardedCb?.(assisterId);
      }
    }
    victim.recentAttackers.clear();

    if (this.rule === 'tdm') {
      if (killerTeam === 'A') this.scoreA += 1;
      else if (killerTeam === 'B') this.scoreB += 1;
    }

    if (this.modeController && !this.coopInfectionMode) {
      this.modeController.onActorKilled({
        victimId: victim.id,
        victimTeam: victim.team,
        x: victim.pos.x,
        y: victim.pos.y,
        z: victim.pos.z,
      });
      if (this.rule === 'conquest') {
        const remaining = this.modeController.consumeBotConquestLife(victim.id, victim.team);
        if (remaining <= 0) {
          victim.conquestEliminated = true;
          victim.respawnTimer = Number.POSITIVE_INFINITY; // Expended all loadout lives -> spectating
        } else {
          victim.conquestLoadoutIndex += 1;
        }
      }
    }

    this.pushKillfeed({
      id: this.nextKillfeedId++,
      killerName,
      killerTeam,
      victimName: victim.name,
      victimTeam: victim.team,
      headshot,
      weaponLabel,
      timestampMs: nowMs,
    });

    this.rebuildActiveHitMeshes();
  }

  /**
   * Applies tactical grenade AoE damage or flashbang stun to hostile bots with line-of-sight occlusion.
   */
  public applyAreaBlast(
    origin: Readonly<THREE.Vector3>,
    radiusM: number,
    maxDamage: number,
    kind: 'frag' | 'flash' | 'smoke' | 'thermite',
    attackerName: string,
    attackerTeam: BattleTeamId,
    weaponLabel: string,
    customFragEvaluator?: (targetPos: Readonly<THREE.Vector3>) => number,
    attackerId?: string,
  ): { hits: number; kills: number; killedBotIds: string[]; totalDamage: number } {
    if (this.isClientReplica || kind === 'smoke') {
      return { hits: 0, kills: 0, killedBotIds: [], totalDamage: 0 };
    }
    let hits = 0;
    let kills = 0;
    let totalDamage = 0;
    const killedBotIds: string[] = [];
    const attackerBot = attackerId ? this.bots.find((b) => b.id === attackerId) : undefined;
    const nowMs = performance.now();

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (!bot.alive) continue;
      if (!this.isHostilePair(attackerTeam, bot.team)) continue;

      const targetCenter = this._tmpTarget.set(bot.pos.x, bot.pos.y + 1.12, bot.pos.z);
      const dist = targetCenter.distanceTo(origin);
      const evalRadius = kind === 'frag' ? Math.max(radiusM, 26.0) : radiusM;
      if (dist > evalRadius) continue;

      if (kind === 'frag' && customFragEvaluator) {
        const fragDmg = customFragEvaluator(targetCenter);
        if (fragDmg <= 0.5) continue;
        hits += 1;
        const applied = Math.min(bot.hp, fragDmg);
        totalDamage += applied;
        if (attackerBot) attackerBot.damageDealt += Math.round(applied);
        if (attackerId) bot.recentAttackers.set(attackerId, nowMs);
        bot.hp -= fragDmg;
        bot.flinchTimer = Math.max(bot.flinchTimer, 0.34);
        if (bot.hp <= 0) {
          this.killBot(
            bot,
            attackerName,
            attackerTeam,
            false,
            weaponLabel,
            attackerBot,
            'grenade',
            attackerId,
          );
          this._tmpDir.subVectors(targetCenter, origin);
          this._tmpDir.y = Math.max(0.35, this._tmpDir.y + 0.55);
          if (this._tmpDir.lengthSq() > 1e-4) {
            this._tmpDir.normalize();
            const falloff = Math.max(0.18, 1 - dist / Math.max(1, radiusM));
            bot.ragdoll.applyHitZoneImpulse('thorax', this._tmpDir, 6.8 * falloff + 2.2);
          }
          kills += 1;
          killedBotIds.push(bot.id);
        }
        continue;
      }

      const hasLos = this.hasLineOfSight(origin, targetCenter);
      if (!hasLos && kind !== 'thermite') continue;

      const falloff = Math.max(0.14, 1 - dist / Math.max(0.5, radiusM));
      hits += 1;

      if (kind === 'flash') {
        bot.stunTimer = Math.max(bot.stunTimer, 1.8 + 2.8 * falloff);
        bot.flinchTimer = Math.max(bot.flinchTimer, 0.55);
        bot.burstShotsLeft = 0;
        if (maxDamage > 0) {
          const flashDmg = Math.round(maxDamage * falloff);
          const applied = Math.min(bot.hp, flashDmg);
          totalDamage += applied;
          if (attackerBot) attackerBot.damageDealt += Math.round(applied);
          if (attackerId) bot.recentAttackers.set(attackerId, nowMs);
          bot.hp -= flashDmg;
          if (bot.hp <= 0) {
            this.killBot(
              bot,
              attackerName,
              attackerTeam,
              false,
              weaponLabel,
              attackerBot,
              'grenade',
              attackerId,
            );
            kills += 1;
            killedBotIds.push(bot.id);
          }
        }
        continue;
      }

      const dmg = Math.max(6, maxDamage * Math.pow(falloff, kind === 'frag' ? 1.15 : 0.85));
      const applied = Math.min(bot.hp, dmg);
      totalDamage += applied;
      if (attackerBot) attackerBot.damageDealt += Math.round(applied);
      if (attackerId) bot.recentAttackers.set(attackerId, nowMs);
      bot.hp -= dmg;
      bot.flinchTimer = Math.max(bot.flinchTimer, kind === 'frag' ? 0.32 : 0.16);

      if (bot.hp <= 0) {
        this.killBot(
          bot,
          attackerName,
          attackerTeam,
          false,
          weaponLabel,
          attackerBot,
          'grenade',
          attackerId,
        );
        // Apply radial blast impulse to ragdoll away from detonation point
        this._tmpDir.subVectors(targetCenter, origin);
        this._tmpDir.y = Math.max(0.35, this._tmpDir.y + 0.55);
        if (this._tmpDir.lengthSq() > 1e-4) {
          this._tmpDir.normalize();
          bot.ragdoll.applyHitZoneImpulse('thorax', this._tmpDir, kind === 'frag' ? 6.8 * falloff + 2.2 : 2.6);
        }
        kills += 1;
        killedBotIds.push(bot.id);
      }
    }

    return { hits, kills, killedBotIds, totalDamage: Math.round(totalDamage) };
  }

  public recordPlayerDeath(
    attackerName: string,
    attackerTeam: BattleTeamId,
    attackerId?: string,
    killMethod: 'bullet' | 'grenade' | 'melee' = 'bullet',
    recentPlayerAttackers?: Iterable<string>,
  ): void {
    const killerBot = attackerId ? this.bots.find((b) => b.id === attackerId) : undefined;
    if (killerBot) {
      killerBot.kills += 1;
      if (killMethod === 'grenade') killerBot.grenadeKills += 1;
      if (killMethod === 'melee') killerBot.meleeKills += 1;
    }
    if (recentPlayerAttackers) {
      for (const assisterId of recentPlayerAttackers) {
        if (attackerId && assisterId === attackerId) continue;
        const assistBot = this.bots.find((b) => b.id === assisterId);
        if (assistBot) {
          assistBot.assists += 1;
        }
      }
    }
    if (this.rule === 'tdm' && attackerTeam === 'B') {
      this.scoreB += 1;
    }
    this.pushKillfeed({
      id: this.nextKillfeedId++,
      killerName: attackerName,
      killerTeam: attackerTeam,
      victimName: 'YOU',
      victimTeam: isTeamBattleRule(this.rule) ? this.localAllyTeam : 'FFA',
      headshot: false,
      weaponLabel: killerBot?.weaponLabel ?? 'CARBINE',
      timestampMs: performance.now(),
    });
  }

  private pushKillfeed(entry: BattleKillfeedEntry): void {
    this.killfeed.unshift(entry);
    if (this.killfeed.length > 6) {
      this.killfeed.length = 6;
    }
  }

  public getKillfeed(): BattleKillfeedEntry[] {
    const now = performance.now();
    return this.killfeed.filter((k) => now - k.timestampMs < 6500);
  }

  public getScoreboard(
    playerKills: number,
    playerDeaths: number,
    playerAlive: boolean,
    localStats?: {
      headshots: number;
      assists: number;
      grenadeKills: number;
      meleeKills: number;
      damageDealt: number;
      afkSeconds: number;
    },
  ): BattleScoreEntry[] {
    const localObj = this.modeController?.getActorStats('player');
    const localAttr = this.modeController?.getConquestParticipantAttrition('player');
    const rows: BattleScoreEntry[] = [
      {
        id: 'player',
        name: 'YOU',
        team: isTeamBattleRule(this.rule) ? this.localAllyTeam : 'FFA',
        isPlayer: true,
        isBot: false,
        kills: playerKills,
        deaths: playerDeaths,
        headshots: localStats?.headshots ?? 0,
        assists: localStats?.assists ?? 0,
        grenadeKills: localStats?.grenadeKills ?? 0,
        meleeKills: localStats?.meleeKills ?? 0,
        damageDealt: localStats?.damageDealt ?? 0,
        afkSeconds: localStats?.afkSeconds ?? 0,
        alive: playerAlive,
        enemyDogtags: localObj?.enemyDogtags ?? 0,
        friendlyDogtags: localObj?.friendlyDogtags ?? 0,
        selfDogtagsRecovered: localObj?.selfDogtagsRecovered ?? 0,
        poiCaptures: localObj?.poiCaptures ?? 0,
        territoryPoints: Math.round(localObj?.territoryPoints ?? 0),
        flagCaptures: localObj?.flagCaptures ?? 0,
        flagReturns: localObj?.flagReturns ?? 0,
        hillControlSec: Math.round(localObj?.hillControlSec ?? 0),
        conquestLivesRemaining: localAttr?.remainingLives,
        conquestEliminated: localAttr?.eliminated,
      },
      ...this.bots.map((b) => {
        const bObj = this.modeController?.getActorStats(b.id);
        const bAttr = this.modeController?.getConquestParticipantAttrition(b.id);
        return {
          id: b.id,
          name: b.name,
          team: b.team,
          isPlayer: false,
          isBot: true,
          kills: b.kills,
          deaths: b.deaths,
          headshots: b.headshots,
          assists: b.assists,
          grenadeKills: b.grenadeKills,
          meleeKills: b.meleeKills,
          damageDealt: b.damageDealt,
          afkSeconds: b.afkSeconds,
          alive: b.alive,
          enemyDogtags: bObj?.enemyDogtags ?? 0,
          friendlyDogtags: bObj?.friendlyDogtags ?? 0,
          selfDogtagsRecovered: bObj?.selfDogtagsRecovered ?? 0,
          poiCaptures: bObj?.poiCaptures ?? 0,
          territoryPoints: Math.round(bObj?.territoryPoints ?? 0),
          flagCaptures: bObj?.flagCaptures ?? 0,
          flagReturns: bObj?.flagReturns ?? 0,
          hillControlSec: Math.round(bObj?.hillControlSec ?? 0),
          conquestLivesRemaining: bAttr?.remainingLives,
          conquestEliminated: b.conquestEliminated || Boolean(bAttr?.eliminated),
        };
      }),
    ];

    rows.sort((a, b) => {
      if (this.rule === 'kc_tdm' || this.rule === 'kc_ffa') {
        const td = (b.enemyDogtags ?? 0) - (a.enemyDogtags ?? 0);
        if (td !== 0) return td;
      } else if (this.rule === 'conquest') {
        const cd =
          (b.poiCaptures ?? 0) * 100 +
          (b.territoryPoints ?? 0) -
          ((a.poiCaptures ?? 0) * 100 + (a.territoryPoints ?? 0));
        if (cd !== 0) return cd;
      } else if (this.rule === 'ctf') {
        const fd =
          (b.flagCaptures ?? 0) * 120 +
          (b.flagReturns ?? 0) * 35 -
          ((a.flagCaptures ?? 0) * 120 + (a.flagReturns ?? 0) * 35);
        if (fd !== 0) return fd;
      } else if (this.rule === 'koth') {
        const hd = (b.hillControlSec ?? 0) - (a.hillControlSec ?? 0);
        if (hd !== 0) return hd;
      }
      return b.kills - a.kills || b.assists - a.assists || a.deaths - b.deaths;
    });
    return rows;
  }

  public getTopFfaBotKills(): { name: string; kills: number } {
    let bestName = '—';
    let bestKills = 0;
    for (let i = 0; i < this.bots.length; i++) {
      if (this.bots[i].kills > bestKills) {
        bestKills = this.bots[i].kills;
        bestName = this.bots[i].name;
      }
    }
    return { name: bestName, kills: bestKills };
  }

  private hasLineOfSight(
    from: Readonly<THREE.Vector3>,
    to: Readonly<THREE.Vector3>,
    isLineBlockedBySmoke?: (a: Readonly<THREE.Vector3>, b: Readonly<THREE.Vector3>) => boolean,
  ): boolean {
    if (isLineBlockedBySmoke && isLineBlockedBySmoke(from, to)) {
      return false;
    }
    return !this.map.physics.isSegmentOccluded(from, to, 0.15, 0.25);
  }

  private spawnTracer(start: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>): void {
    const t = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;

    this._tmpDir.subVectors(end, start);
    const len = this._tmpDir.length();
    if (len < 0.2) return;
    this._tmpMid.addVectors(start, end).multiplyScalar(0.5);

    t.active = true;
    t.life = t.maxLife;
    t.mesh.visible = true;
    t.mesh.position.copy(this._tmpMid);
    t.mesh.scale.set(1, len, 1);
    t.mesh.quaternion.setFromUnitVectors(this._tmpUp, this._tmpDir.divideScalar(len));
  }

  private isHostilePair(aTeam: BattleTeamId, bTeam: BattleTeamId): boolean {
    if (this.coopInfectionMode) return false;
    if (isFreeForAllBattleRule(this.rule)) return true;
    return aTeam !== bTeam;
  }

  private isInfectionEdgeBlocked(aId: string, bId: string): boolean {
    if (!this.coopInfectionMode) return false;
    for (let i = 0; i < INFECTION_DOOR_GATED_EDGES.length; i++) {
      const [u, v, doorId] = INFECTION_DOOR_GATED_EDGES[i];
      if ((aId === u && bId === v) || (aId === v && bId === u)) {
        if (!this.openedDoors.has(doorId)) return true;
      }
    }
    return false;
  }

  private findBotPath(startId: string, goalId: string): NavNode[] {
    const zones = this.coopInfectionMode ? this.unlockedZones : undefined;
    const doors = this.coopInfectionMode ? this.openedDoors : undefined;
    const raw = findNavPath(this.map.navGraph, startId, goalId, zones, doors);
    if (!this.coopInfectionMode) return raw;
    for (let i = 0; i < raw.length - 1; i++) {
      if (this.isInfectionEdgeBlocked(raw[i].id, raw[i + 1].id)) {
        return this.bfsDoorSafe(startId, goalId);
      }
    }
    return raw;
  }

  private bfsDoorSafe(startId: string, goalId: string): NavNode[] {
    const queue: string[] = [startId];
    const visited = new Set<string>([startId]);
    const parent = new Map<string, string>();
    const byId = this.map.navGraph.byId;
    while (queue.length > 0) {
      const curId = queue.shift()!;
      if (curId === goalId) {
        const out: NavNode[] = [];
        let p: string | undefined = curId;
        while (p) {
          const n = byId.get(p);
          if (n) out.push(n);
          p = parent.get(p);
        }
        out.reverse();
        return out;
      }
      const cur = byId.get(curId);
      if (!cur) continue;
      for (const nbId of cur.neighbors) {
        if (visited.has(nbId)) continue;
        const nb = byId.get(nbId);
        if (!nb) continue;
        if (!this.unlockedZones.has(nb.zoneId)) continue;
        if (nb.requiredDoorId && !this.openedDoors.has(nb.requiredDoorId)) continue;
        if (this.isInfectionEdgeBlocked(curId, nbId)) continue;
        visited.add(nbId);
        parent.set(nbId, curId);
        queue.push(nbId);
      }
    }
    return [];
  }

  private isPointBlockedXZ(x: number, z: number, baseY: number, radius: number, minH = 0.36, maxH = 1.7): boolean {
    if (
      x < this.map.physics.boundsMinX + radius ||
      x > this.map.physics.boundsMaxX - radius ||
      z < this.map.physics.boundsMinZ + radius ||
      z > this.map.physics.boundsMaxZ - radius
    ) {
      return true;
    }
    const rSq = radius * radius;
    const pyMin = baseY + minH;
    const pyMax = baseY + maxH;
    const boxes = this.map.physics.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.blocksMovement === false) continue;
      if (pyMax <= b.minY + 0.02 || pyMin >= b.maxY - 0.02) continue;
      const qx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
      const qz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
      const dx = x - qx;
      const dz = z - qz;
      if (dx * dx + dz * dz < rSq) return true;
    }
    return false;
  }

  private isWalkSegmentClear(x0: number, z0: number, x1: number, z1: number, baseY: number, radius: number): boolean {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist < 0.25) return true;
    const steps = Math.min(12, Math.max(2, Math.ceil(dist / 0.65)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (this.isPointBlockedXZ(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, baseY, radius)) {
        return false;
      }
    }
    return true;
  }

  private hasLowCoverNearby(x: number, baseY: number, z: number): boolean {
    const boxes = this.map.physics.boxes;
    const searchR = 1.45;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.blocksMovement === false) continue;
      const h = b.maxY - baseY;
      if (h < 0.55 || h > 1.38) continue;
      const qx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
      const qz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
      const dx = x - qx;
      const dz = z - qz;
      if (dx * dx + dz * dz < searchR * searchR) return true;
    }
    return false;
  }

  private tryTriggerBotVault(bot: BotActor, moveDirX: number, moveDirZ: number): boolean {
    if (!this.worldAdapter || bot.vaultActive || bot.vaultCooldown > 0) return false;
    const moveYaw = Math.atan2(-moveDirX, -moveDirZ);
    const ok = this.vaultDetector.detect(this.worldAdapter, bot.pos, moveYaw, true, this._vaultCandidate);
    if (!ok || !this._vaultCandidate.valid) return false;

    const cand = this._vaultCandidate;
    // Keep bots strictly inside playable map bounds (never vault out through zombie perimeter windows)
    if (
      cand.landPos.x < this.map.physics.boundsMinX + 0.75 ||
      cand.landPos.x > this.map.physics.boundsMaxX - 0.75 ||
      cand.landPos.z < this.map.physics.boundsMinZ + 0.75 ||
      cand.landPos.z > this.map.physics.boundsMaxZ - 0.75
    ) {
      return false;
    }
    if (this.coopInfectionMode) {
      // Avoid vaulting across into locked zones
      const destNode = findNearestNavNode(this.map.navGraph, cand.landPos, this.unlockedZones, this.openedDoors);
      if (!destNode || Math.hypot(destNode.position[0] - cand.landPos.x, destNode.position[2] - cand.landPos.z) > 8.5) {
        return false;
      }
    }

    bot.vaultActive = true;
    bot.vaultKind = cand.kind;
    bot.vaultStartPos.copy(bot.pos);
    bot.vaultApexPos.copy(cand.apexPos);
    bot.vaultEndPos.copy(cand.landPos);
    bot.vaultT = 0;
    bot.vaultDuration =
      cand.kind === 'HIGH_MANTLE' ? 0.92 : cand.kind === 'CLIMB_ONTO' ? 0.68 : 0.60;
    bot.vaultCrouchFinish = cand.mustCrouchOnFinish;
    bot.targetYaw = moveYaw;
    bot.yaw = moveYaw;
    bot.burstShotsLeft = 0;
    this.audio.playImpact(bot.pos, cand.surface === 'metal' ? 'metal' : 'wood');
    return true;
  }

  private evaluateTacticalPosture(bot: BotActor, targetPos: Readonly<THREE.Vector3> | null): void {
    if (!bot.hasLos || !targetPos) {
      bot.targetCrouch = bot.vaultCrouchFinish ? 0.85 : 0;
      bot.targetLean = 0;
      return;
    }

    const dx = targetPos.x - bot.pos.x;
    const dz = targetPos.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);

    // Right vector in XZ relative to bot facing (-sin(yaw), -cos(yaw))
    const rightX = Math.cos(bot.yaw);
    const rightZ = -Math.sin(bot.yaw);

    // Probe left & right shoulders at chest height for nearby cover corners to lean around
    const sideDist = 0.78;
    const leftWall = this.isPointBlockedXZ(
      bot.pos.x - rightX * sideDist,
      bot.pos.z - rightZ * sideDist,
      bot.pos.y,
      0.26,
      0.7,
      1.65,
    );
    const rightWall = this.isPointBlockedXZ(
      bot.pos.x + rightX * sideDist,
      bot.pos.z + rightZ * sideDist,
      bot.pos.y,
      0.26,
      0.7,
      1.65,
    );

    if (leftWall && !rightWall) {
      bot.targetLean = 0.88; // Wall on left -> lean right to peek around corner
    } else if (rightWall && !leftWall) {
      bot.targetLean = -0.88; // Wall on right -> lean left to peek around corner
    } else if (dist > 6.5 && !this.coopInfectionMode) {
      // Subtle tactical combat lean synced with strafe direction in gunfights
      bot.targetLean = bot.strafeDir * 0.42;
    } else {
      bot.targetLean = 0;
    }

    // Crouch behind low cover or when engaging at mid/long range (never crouch when backpedaling from close zombies)
    const nearLowCover = this.hasLowCoverNearby(bot.pos.x, bot.pos.y, bot.pos.z);
    if (this.coopInfectionMode && dist < 7.0) {
      bot.targetCrouch = 0;
    } else if (nearLowCover && dist > 5.0) {
      bot.targetCrouch = 0.82;
    } else if (dist > 14.5 && !this.coopInfectionMode) {
      bot.targetCrouch = 0.55;
    } else {
      bot.targetCrouch = 0;
    }
  }

  private isPointReachableInInfection(pos: Readonly<THREE.Vector3>): boolean {
    if (!this.coopInfectionMode) return true;
    const node = findNearestNavNode(this.map.navGraph, pos, this.unlockedZones, this.openedDoors);
    if (!node) return false;
    const d = Math.hypot(node.position[0] - pos.x, node.position[2] - pos.z);
    return d <= 7.8;
  }

  private pickInfectionEconomyGoal(
    bot: BotActor,
    econ: InfectionBotEconomyContext,
  ): BotEconomyGoal | null {
    const interactables = this.map.interactables;
    if (!interactables || interactables.length === 0) return null;

    const activeSpec = this.getWeaponSpec(bot.weaponId);
    const activeReserve = bot.reserveAmmoByWeapon[bot.weaponId] ?? 0;
    const activeMag = bot.magAmmoByWeapon[bot.weaponId] ?? 0;
    const lowAmmo = activeMag + activeReserve <= activeSpec.magCapacity * 1.4;
    const currentBestTier = bot.weaponSlots.reduce(
      (best, wid) => Math.max(best, this.getWeaponSpec(wid).tier),
      0,
    );

    // Priority 1: Refill ammo at owned wall-buy if running critically low
    if (lowAmmo) {
      let bestRefill: BotEconomyGoal | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'wall_buy' || !it.weaponId || !bot.weaponSlots.includes(it.weaponId)) continue;
        const refillCost = Math.round(it.cost * 0.5);
        if (bot.points < refillCost) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        const d = bot.pos.distanceTo(p);
        if (d < bestDist) {
          bestDist = d;
          bestRefill = {
            kind: 'wall_buy',
            interactableId: it.id,
            label: it.label,
            pos: p,
            cost: refillCost,
            weaponId: it.weaponId,
          };
        }
      }
      if (bestRefill) return bestRefill;
    }

    // Priority 2: Flip Main Power Switch if reachable and power is still OFF (free!)
    if (!econ.powerOn) {
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'power_switch' || it.activated) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        return {
          kind: 'power_switch',
          interactableId: it.id,
          label: it.label,
          pos: p,
          cost: 0,
        };
      }
    }

    // Priority 3: Upgrade off starting Glock 17 to an affordable wall weapon!
    if (currentBestTier === 0 && bot.points >= 750) {
      let bestWall: BotEconomyGoal | null = null;
      let bestScore = -Infinity;
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'wall_buy' || !it.weaponId || bot.weaponSlots.includes(it.weaponId)) continue;
        if (bot.points < it.cost) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        const spec = this.getWeaponSpec(it.weaponId);
        const dist = bot.pos.distanceTo(p);
        const score = spec.tier * 25 + it.cost * 0.01 - dist * 0.8;
        if (score > bestScore) {
          bestScore = score;
          bestWall = {
            kind: 'wall_buy',
            interactableId: it.id,
            label: it.label,
            pos: p,
            cost: it.cost,
            weaponId: it.weaponId,
          };
        }
      }
      if (bestWall) return bestWall;
    }

    // Priority 4: Buy perks once power is ON
    if (econ.powerOn) {
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'perk_machine' || !it.perkId) continue;
        if (bot.perks.has(it.perkId)) continue;
        if (bot.points < it.cost) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        return {
          kind: 'perk_machine',
          interactableId: it.id,
          label: it.label,
          pos: p,
          cost: it.cost,
          perkId: it.perkId,
        };
      }
    }

    // Priority 5: Open buyable doors to expand map (once bot has upgraded OR round >= 2 & has points)
    if (currentBestTier >= 1 || econ.round >= 2) {
      let bestDoor: BotEconomyGoal | null = null;
      let bestCost = Infinity;
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'buyable_door' || it.activated || this.openedDoors.has(it.id)) continue;
        if (bot.points < it.cost) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        if (it.cost < bestCost) {
          bestCost = it.cost;
          bestDoor = {
            kind: 'buyable_door',
            interactableId: it.id,
            label: it.label,
            pos: p,
            cost: it.cost,
          };
        }
      }
      if (bestDoor) return bestDoor;
    }

    // Priority 6: Roll Mystery Weapon Crate if reachable and affordable
    if (bot.points >= 950 && (currentBestTier < 3 || lowAmmo)) {
      for (let i = 0; i < interactables.length; i++) {
        const it = interactables[i];
        if (it.kind !== 'mystery_crate') continue;
        if (bot.points < it.cost) continue;
        const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
        if (!this.isPointReachableInInfection(p)) continue;
        return {
          kind: 'mystery_crate',
          interactableId: it.id,
          label: it.label,
          pos: p,
          cost: it.cost,
        };
      }
    }

    // Priority 7: Repair nearby breached window barriers for +5 PTS/plank (especially during intermission or early rounds)
    let bestBarrier: BotEconomyGoal | null = null;
    let bestBarrierDist = econ.intermissionActive ? 22 : 12;
    for (let i = 0; i < interactables.length; i++) {
      const it = interactables[i];
      if (it.kind !== 'window_barrier') continue;
      const bid = it.barrierId ?? it.id;
      const bState = econ.getBarrierPlanks(bid);
      if (!bState || bState.remaining >= bState.max) continue;
      const p = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
      if (!this.isPointReachableInInfection(p)) continue;
      const d = bot.pos.distanceTo(p);
      if (d < bestBarrierDist) {
        bestBarrierDist = d;
        bestBarrier = {
          kind: 'window_barrier',
          interactableId: it.id,
          barrierId: bid,
          label: it.label,
          pos: p,
          cost: 0,
        };
      }
    }
    return bestBarrier;
  }

  private executeInfectionEconomyGoal(
    bot: BotActor,
    goal: BotEconomyGoal,
    econ: InfectionBotEconomyContext,
    dt: number,
  ): boolean {
    if (goal.kind === 'window_barrier' && goal.barrierId) {
      const st = econ.getBarrierPlanks(goal.barrierId);
      if (!st || st.remaining >= st.max) {
        bot.barrierRepairAccum = 0;
        return true; // finished
      }
      bot.barrierRepairAccum += dt;
      if (bot.barrierRepairAccum >= 0.72) {
        bot.barrierRepairAccum = 0;
        const ok = econ.onBotEconomyAction({
          botId: bot.id,
          botName: bot.name,
          kind: 'window_barrier',
          interactableId: goal.interactableId,
          barrierId: goal.barrierId,
          cost: 0,
        });
        if (ok) {
          bot.points += 5;
          if (st.remaining + 1 >= st.max) {
            this.emitAlliedComms(bot, 'economy', `Boarded up ${goal.label} — holding tight.`);
            return true;
          }
        } else {
          return true;
        }
      }
      return false;
    }

    if (goal.kind === 'buyable_door') {
      if (bot.points < goal.cost || this.openedDoors.has(goal.interactableId)) return true;
      const ok = econ.onBotEconomyAction({
        botId: bot.id,
        botName: bot.name,
        kind: 'buyable_door',
        interactableId: goal.interactableId,
        cost: goal.cost,
      });
      if (ok) {
        bot.points -= goal.cost;
        this.emitAlliedComms(
          bot,
          'economy',
          `Cleared ${goal.label} (-${goal.cost} PTS) — path is open!`,
          {
            force: true,
            pingKind: 'location',
            pingLabel: `${goal.label.toUpperCase()} OPEN`,
            pingPos: goal.pos,
            triggerAck: true,
            ackPool: [
              'Copy that, pushing through!',
              'Good call — covering the new sector.',
              'Roger, moving up with you.',
            ],
          },
        );
      }
      return true;
    }

    if (goal.kind === 'power_switch') {
      if (econ.powerOn) return true;
      const ok = econ.onBotEconomyAction({
        botId: bot.id,
        botName: bot.name,
        kind: 'power_switch',
        interactableId: goal.interactableId,
        cost: 0,
      });
      if (ok) {
        this.emitAlliedComms(
          bot,
          'economy',
          'Main Theater Power is ONLINE! Perk machines are live!',
          {
            force: true,
            pingKind: 'item',
            pingLabel: 'POWER ONLINE',
            pingPos: goal.pos,
            triggerAck: true,
            ackPool: [
              'Solid copy — heading for perks when clear!',
              'Lights are back! Nice work!',
            ],
          },
        );
      }
      return true;
    }

    if (goal.kind === 'wall_buy' && goal.weaponId) {
      const owned = bot.weaponSlots.includes(goal.weaponId);
      const actualCost = owned ? Math.round(goal.cost) : goal.cost;
      if (bot.points < actualCost) return true;
      bot.points -= actualCost;
      const spec = this.grantBotInfectionWeapon(bot, goal.weaponId);
      econ.onBotEconomyAction({
        botId: bot.id,
        botName: bot.name,
        kind: 'wall_buy',
        interactableId: goal.interactableId,
        cost: actualCost,
        weaponId: spec.id,
      });
      this.emitAlliedComms(
        bot,
        'economy',
        owned
          ? `Refilled ${spec.label} ammo off the wall.`
          : `Picked up ${spec.label} (-${actualCost} PTS) — ready to engage.`,
        {
          pingKind: 'item',
          pingLabel: spec.label.toUpperCase(),
          pingPos: goal.pos,
        },
      );
      return true;
    }

    if (goal.kind === 'mystery_crate') {
      if (bot.points < goal.cost) return true;
      bot.points -= goal.cost;
      const candidates = GYM_ARMORY_WEAPONS.filter(
        (w) => !bot.weaponSlots.includes(w.id) && w.magCapacity > 0 && w.category !== 'pistols',
      );
      const pool = candidates.length > 0 ? candidates : GYM_ARMORY_WEAPONS;
      const picked = pool[Math.floor(Math.random() * pool.length)];
      const spec = this.grantBotInfectionWeapon(bot, picked.id);
      econ.onBotEconomyAction({
        botId: bot.id,
        botName: bot.name,
        kind: 'mystery_crate',
        interactableId: goal.interactableId,
        cost: goal.cost,
        weaponId: spec.id,
      });
      this.emitAlliedComms(
        bot,
        'economy',
        `Rolled Mystery Crate — pulled ${spec.label}!`,
        {
          force: true,
          pingKind: 'item',
          pingLabel: 'MYSTERY CRATE',
          pingPos: goal.pos,
        },
      );
      return true;
    }

    if (goal.kind === 'perk_machine' && goal.perkId) {
      if (!econ.powerOn || bot.perks.has(goal.perkId) || bot.points < goal.cost) return true;
      bot.points -= goal.cost;
      bot.perks.add(goal.perkId);
      if (goal.perkId === 'vitality') {
        bot.maxHp += 60;
        bot.hp = bot.maxHp;
      } else if (goal.perkId === 'rapid_handling') {
        const spec = this.getWeaponSpec(bot.weaponId);
        bot.reloadDuration = spec.reloadSec / 1.6;
      }
      econ.onBotEconomyAction({
        botId: bot.id,
        botName: bot.name,
        kind: 'perk_machine',
        interactableId: goal.interactableId,
        cost: goal.cost,
        perkId: goal.perkId,
      });
      this.emitAlliedComms(
        bot,
        'economy',
        goal.perkId === 'vitality'
          ? 'Grabbed Vitality Reserve — armor & health boosted.'
          : 'Grabbed Rapid Handling — faster reloads online.',
        { force: true },
      );
      return true;
    }

    return true;
  }

  private animFrameTick = 0;

  public update(
    dt: number,
    playerPos: Readonly<THREE.Vector3>,
    playerAlive: boolean,
    matchActive: boolean,
    onDamagePlayer: (ev: BotPlayerDamageEvent) => void,
    humanTargets?: BattleHumanTarget[],
    onBotFire?: (
      botId: string,
      origin: Readonly<THREE.Vector3>,
      end: Readonly<THREE.Vector3>,
      meta?: { weaponId: string; caliberId: string; suppressed: boolean },
    ) => void,
    isLineBlockedBySmoke?: (a: Readonly<THREE.Vector3>, b: Readonly<THREE.Vector3>) => boolean,
    getActiveSmokeClouds?: () => readonly ActiveSmokeCloudInfo[],
    zombieTargets?: ReadonlyArray<BattleZombieTarget>,
    onHitZombie?: (ev: BotZombieHitEvent) => void,
    infectionEconomy?: InfectionBotEconomyContext,
  ): void {
    this.elapsedClockSec += dt;
    this.animFrameTick = (this.animFrameTick + 1) & 0x7fffffff;
    const reduceAnimDistM = graphicsQualityStore.getReduceAnimationDistanceM();
    if (this.globalCommsCooldown > 0) {
      this.globalCommsCooldown = Math.max(0, this.globalCommsCooldown - dt);
    }

    // Process delayed call-and-response squad radio acknowledgments
    if (!this.isClientReplica && this.pendingAcks.length > 0 && this.onBotCommsCb) {
      for (let a = this.pendingAcks.length - 1; a >= 0; a--) {
        const ack = this.pendingAcks[a];
        ack.dueTimer -= dt;
        if (ack.dueTimer <= 0) {
          this.pendingAcks.splice(a, 1);
          const responder = this.bots.find(
            (b) => b.alive && b.id !== ack.sourceBotId && b.team === ack.team && this.isAlliedBot(b),
          );
          if (responder) {
            this.emitAlliedComms(responder, 'ack', ack.text, { force: true });
          }
        }
      }
    }

    // Update pooled tracers
    for (let i = 0; i < this.tracers.length; i++) {
      const t = this.tracers[i];
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        t.mesh.visible = false;
      }
    }

    if (!matchActive) return;

    // Client Replica mode: smoothly interpolate bots from Host 20 Hz snapshots without local AI drift
    if (this.isClientReplica) {
      const posAlpha = 1 - Math.exp(-16 * dt);
      const rotAlpha = 1 - Math.exp(-18 * dt);
      for (let i = 0; i < this.bots.length; i++) {
        const bot = this.bots[i];
        if (!bot.alive) {
          bot.deathTimer += dt;
          if (!bot.ragdoll.isActive()) {
            bot.ragdoll.initializeFromStandingPose(bot.pos, bot.yaw, bot.vel);
          }
          bot.ragdoll.step(dt, this.map.physics, this.map.terrainHeightAt);
          bot.ragdoll.syncToBotRig(
            bot.root,
            bot.bodyPivot,
            bot.leftLeg,
            bot.rightLeg,
            bot.rig.leftArm,
            bot.rig.rightArm,
          );
          continue;
        }
        if (bot.muzzleFlashTimer > 0) {
          bot.muzzleFlashTimer -= dt;
          if (bot.muzzleFlashTimer <= 0) bot.muzzleFlash.visible = false;
        }
        if (bot.flinchTimer > 0) bot.flinchTimer = Math.max(0, bot.flinchTimer - dt);
        if (bot.firingVisualTimer > 0) bot.firingVisualTimer = Math.max(0, bot.firingVisualTimer - dt);
        bot.recoilKick = Math.max(0, bot.recoilKick - dt * 7.2);

        const prevX = bot.pos.x;
        const prevZ = bot.pos.z;
        bot.pos.lerp(bot.netPos, posAlpha);
        const speedHoriz = Math.hypot(bot.pos.x - prevX, bot.pos.z - prevZ) / Math.max(0.001, dt);

        let yawDelta = bot.netYaw - bot.yaw;
        while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        bot.yaw += yawDelta * rotAlpha;

        bot.crouchBlend = THREE.MathUtils.damp(bot.crouchBlend, bot.netCrouch, 10, dt);
        bot.leanBlend = THREE.MathUtils.damp(bot.leanBlend, bot.netLean, 10, dt);

        if (speedHoriz > 0.2) {
          bot.walkCycle += dt * speedHoriz * 2.55;
        }

        const isAimingFire = bot.firingVisualTimer > 0;
        const flinchPitch = bot.flinchTimer > 0 ? Math.sin(bot.flinchTimer * 35) * 0.16 : 0;
        const pose = this._poseScratch;
        pose.crouchBlend = bot.crouchBlend;
        pose.leanBlend = bot.leanBlend;
        pose.aimPitch = 0;
        pose.adsBlend = isAimingFire ? 0.72 : 0.12;
        pose.pointAimBlend = 0;
        pose.cantBlend = 0;
        pose.reloadBlend = bot.netReloading ? 0.85 : 0;
        pose.speedMps = speedHoriz;
        pose.walkCycle = bot.walkCycle;
        pose.sprint = speedHoriz > 3.5;
        pose.recoilKick = bot.recoilKick;
        pose.firingVibration = isAimingFire ? Math.sin(performance.now() * 0.055) * 0.014 : 0;
        pose.flinchPitch = flinchPitch;
        pose.vaultBlend = bot.netVaulting ? 1 : 0;
        pose.vaultProgress = bot.netVaultProgress;
        pose.vaultKind = 'VAULT_OVER';
        if (bot.netHandlingAction !== 'NONE') {
          const estRate =
            bot.netHandlingAction === 'SUPPRESSOR_DETACH' ||
            bot.netHandlingAction === 'SUPPRESSOR_ATTACH'
              ? 1 / SUPPRESSOR_TOGGLE_DURATION_SEC
              : bot.netHandlingAction === 'RELOAD'
                ? 1 / 2.25
                : bot.netHandlingAction === 'BOLT'
                  ? 1 / 0.72
                  : bot.netHandlingAction === 'GRENADE_PIN_PULL'
                    ? 1 / 0.56
                    : bot.netHandlingAction === 'GRENADE_DRAW' ||
                        bot.netHandlingAction === 'GRENADE_THROW_OVERHAND'
                      ? 1 / 0.34
                      : bot.netHandlingAction === 'GRENADE_THROW_UNDERHAND'
                        ? 1 / 0.30
                        : bot.netHandlingAction === 'GRENADE_COOK' ||
                            bot.netHandlingAction === 'GRENADE_CHARGE'
                          ? 0
                          : 1 / 0.36;
          bot.netHandlingProgress =
            estRate > 0
              ? Math.min(1, bot.netHandlingProgress + dt * estRate * 0.75)
              : bot.netHandlingProgress;
        }
        pose.handlingAction = bot.netHandlingAction;
        pose.handlingProgress = bot.netHandlingProgress;
        this.updateBotWallClearance(bot, dt, 0);
        pose.grenadeEquipmentId = bot.netGrenadeEquipId;
        pose.grenadeCharge01 = bot.netGrenadeCharge01;
        pose.grenadeThrowStyle = bot.netGrenadeThrowStyle;
        pose.wallObstruction01 = bot.wallObstruction01;
        pose.beltWallTuck01 = bot.beltWallTuck01;
        pose.dt = dt;
        pose.distanceToCameraM = bot.pos.distanceTo(playerPos);
        pose.gazeTargetWorld = playerPos;
        pose.isVisible = bot.root.visible;
        pose.injury01 = THREE.MathUtils.clamp(1 - bot.hp / Math.max(1, bot.maxHp), 0, 1);
        pose.flinchImpulse01 = bot.flinchTimer > 0 ? Math.min(1, bot.flinchTimer / 0.25) : 0;
        pose.stress01 = isAimingFire ? 0.8 : 0.25;
        pose.facialIntent =
          bot.hp < bot.maxHp * 0.38
            ? 'injured'
            : isAimingFire
              ? 'aiming'
              : 'calm';

        bot.bodyPivot.rotation.set(0, 0, 0);
        bot.bodyPivot.position.set(0, 0, 0);
        bot.root.position.copy(bot.pos);
        bot.root.rotation.set(0, bot.yaw, 0);
        bot.rig.applyCombatPose(pose);
      }
      return;
    }

    const humans: BattleHumanTarget[] =
      humanTargets && humanTargets.length > 0
        ? humanTargets
        : [
            {
              id: 'player',
              name: 'YOU',
              team: this.coopInfectionMode || isTeamBattleRule(this.rule) ? this.localAllyTeam : 'FFA',
              pos: playerPos as THREE.Vector3,
              alive: playerAlive,
            },
          ];

    const zombies = zombieTargets ?? [];

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];

      if (!bot.alive) {
        bot.deathTimer += dt;
        if (!bot.ragdoll.isActive()) {
          bot.ragdoll.initializeFromStandingPose(bot.pos, bot.yaw, bot.vel);
        }
        bot.ragdoll.step(dt, this.map.physics, this.map.terrainHeightAt);
        bot.ragdoll.syncToBotRig(
          bot.root,
          bot.bodyPivot,
          bot.leftLeg,
          bot.rightLeg,
          bot.rig.leftArm,
          bot.rig.rightArm,
        );

        if (this.aiRespawnEnabled && !(this.rule === 'conquest' && bot.conquestEliminated)) {
          bot.respawnTimer -= dt;
          if (bot.respawnTimer <= 0) {
            this.spawnBot(bot, playerPos);
          }
        }
        continue;
      }

      if (bot.muzzleFlashTimer > 0) {
        bot.muzzleFlashTimer -= dt;
        if (bot.muzzleFlashTimer <= 0) bot.muzzleFlash.visible = false;
      }
      if (bot.flinchTimer > 0) bot.flinchTimer = Math.max(0, bot.flinchTimer - dt);
      if (bot.firingVisualTimer > 0) bot.firingVisualTimer = Math.max(0, bot.firingVisualTimer - dt);
      if (bot.vaultCooldown > 0) bot.vaultCooldown = Math.max(0, bot.vaultCooldown - dt);
      if (bot.vaultProbeTimer > 0) bot.vaultProbeTimer = Math.max(0, bot.vaultProbeTimer - dt);
      if (bot.unstuckBoostTimer > 0) bot.unstuckBoostTimer = Math.max(0, bot.unstuckBoostTimer - dt);
      if (bot.commsCooldown > 0) bot.commsCooldown = Math.max(0, bot.commsCooldown - dt);
      if (bot.meleeCooldown > 0) bot.meleeCooldown = Math.max(0, bot.meleeCooldown - dt);
      if (bot.suppToggleCooldown > 0) bot.suppToggleCooldown = Math.max(0, bot.suppToggleCooldown - dt);
      if (bot.grenadeCooldown > 0) bot.grenadeCooldown = Math.max(0, bot.grenadeCooldown - dt);
      if (bot.doorInteractCooldown > 0) bot.doorInteractCooldown = Math.max(0, bot.doorInteractCooldown - dt);
      if (bot.doorAlertTimer > 0) bot.doorAlertTimer = Math.max(0, bot.doorAlertTimer - dt);
      if (bot.hp > bot.maxHp * 0.65) bot.lowHpCalledOut = false;
      bot.recoilKick = Math.max(0, bot.recoilKick - dt * 7.2);

      // Step active weapon handling action (suppressor detach/attach, pump cycle, bolt cycle)
      if (bot.handlingAction !== 'NONE') {
        bot.handlingTimer += dt;
        const isGrenadeSyncAction = bot.handlingAction.startsWith('GRENADE_');
        if (!isGrenadeSyncAction) {
          const isSuppAction =
            bot.handlingAction === 'SUPPRESSOR_DETACH' ||
            bot.handlingAction === 'SUPPRESSOR_ATTACH';
          if (isSuppAction && (bot.vaultActive || bot.stunTimer > 0)) {
            // Emergency cancel on vault or stun -> restore pre-action mounted/stowed state cleanly
            bot.handlingAction = 'NONE';
            bot.handlingTimer = 0;
            bot.handlingDuration = 0;
            bot.rig.setSuppressedVisual(bot.suppressed);
            bot.suppToggleCooldown = 6.0;
          } else if (bot.handlingTimer >= Math.max(0.05, bot.handlingDuration)) {
            if (isSuppAction) {
              bot.suppressed = bot.pendingSuppressorAttach;
              bot.attachments = { ...bot.attachments, suppressorStowed: !bot.suppressed };
              bot.rig.setWeaponLoadout(bot.weaponId, bot.attachments);
              bot.rig.setSuppressedVisual(bot.suppressed);
            }
            bot.handlingAction = 'NONE';
            bot.handlingTimer = 0;
            bot.handlingDuration = 0;
          }
        }
      }

      // Timed tactical reload step
      if (bot.reloadTimer > 0) {
        bot.reloadTimer -= dt;
        if (bot.reloadTimer <= 0) {
          bot.reloadTimer = 0;
          const spec = this.getWeaponSpec(bot.weaponId);
          const curMag = bot.magAmmoByWeapon[bot.weaponId] ?? 0;
          const res = bot.reserveAmmoByWeapon[bot.weaponId] ?? -1;
          const needed = Math.max(0, spec.magCapacity - curMag);
          if (res < 0) {
            bot.magAmmoByWeapon[bot.weaponId] = spec.magCapacity;
          } else {
            const loaded = Math.min(needed, res);
            bot.magAmmoByWeapon[bot.weaponId] = curMag + loaded;
            bot.reserveAmmoByWeapon[bot.weaponId] = res - loaded;
          }
        }
      }

      // === ACTIVE VAULT / CLIMB / HIGH-MANTLE EXECUTION ===
      if (bot.vaultActive) {
        bot.vaultT = Math.min(1, bot.vaultT + dt / Math.max(0.2, bot.vaultDuration));
        const t = bot.vaultT;
        if (t < 0.5) {
          const u = t * 2;
          const ease = u * u * (3 - 2 * u);
          bot.pos.lerpVectors(bot.vaultStartPos, bot.vaultApexPos, ease);
        } else {
          const u = (t - 0.5) * 2;
          const ease = u * u * (3 - 2 * u);
          bot.pos.lerpVectors(bot.vaultApexPos, bot.vaultEndPos, ease);
        }

        const pose = this._poseScratch;
        pose.crouchBlend = bot.vaultCrouchFinish ? t * 0.85 : 0;
        pose.leanBlend = 0;
        pose.aimPitch = 0;
        pose.adsBlend = 0;
        pose.pointAimBlend = 0;
        pose.cantBlend = 0;
        pose.reloadBlend = 0;
        pose.speedMps = 2.6;
        pose.walkCycle = bot.walkCycle;
        pose.sprint = false;
        pose.recoilKick = 0;
        pose.firingVibration = 0;
        pose.flinchPitch = 0;
        pose.vaultBlend = Math.sin(t * Math.PI);
        pose.vaultProgress = t;
        pose.vaultKind = bot.vaultKind;
        pose.handlingAction = 'NONE';
        pose.handlingProgress = 0;
        pose.wallObstruction01 = 0;
        pose.beltWallTuck01 = 0;
        pose.dt = dt;
        pose.distanceToCameraM = bot.pos.distanceTo(playerPos);
        pose.gazeTargetWorld = null;
        pose.isVisible = bot.root.visible;
        pose.injury01 = THREE.MathUtils.clamp(1 - bot.hp / Math.max(1, bot.maxHp), 0, 1);
        pose.flinchImpulse01 = 0;
        pose.stress01 = 0.72;
        pose.facialIntent = 'alert';

        bot.bodyPivot.rotation.set(0, 0, 0);
        bot.bodyPivot.position.set(0, 0, 0);
        bot.root.position.copy(bot.pos);
        bot.root.rotation.set(0, bot.yaw, 0);
        bot.rig.applyCombatPose(pose);

        if (bot.vaultT >= 1) {
          bot.pos.copy(bot.vaultEndPos);
          bot.vaultActive = false;
          bot.vaultCooldown = 1.65;
          bot.lastProgressX = bot.pos.x;
          bot.lastProgressZ = bot.pos.z;
          bot.stuckTimer = 0;
          bot.repathTimer = 0.05;
        }
        continue;
      }

      // 1. Target Acquisition & Throttled LoS check
      bot.losTimer -= dt;
      let targetPos: THREE.Vector3 | null = null;
      let targetBot: BotActor | null = null;
      let targetHuman: BattleHumanTarget | null = null;
      let targetZombie: BattleZombieTarget | null = null;

      if (bot.losTimer <= 0) {
        const distFromCamSq = bot.pos.distanceToSquared(playerPos);
        const distantBot = distFromCamSq > reduceAnimDistM * reduceAnimDistM;
        bot.losTimer = distantBot ? 0.24 + Math.random() * 0.08 : 0.14 + Math.random() * 0.06;
        this._tmpOrigin.set(bot.pos.x, bot.pos.y + BOT_EYE_Y - bot.crouchBlend * 0.42, bot.pos.z);

        let bestId: string | null = null;
        let bestDist = this.diff.visionRangeM;
        let bestLos = false;

        const activeSmokeClouds = getActiveSmokeClouds ? getActiveSmokeClouds() : [];
        let blockedBySmoke = false;

        if (this.coopInfectionMode) {
          // Friendly Infection squadmates strictly target zombies (never humans or teammates!)
          for (let zIdx = 0; zIdx < zombies.length; zIdx++) {
            const zt = zombies[zIdx];
            this._tmpTarget.set(zt.pos.x, zt.pos.y + 1.24, zt.pos.z);
            const d = this._tmpOrigin.distanceTo(this._tmpTarget);
            // Slightly prioritize closer & interior zombies over hallway zombies
            const effDist = d + (zt.enteringWindow ? 3.5 : 0);
            if (effDist < bestDist) {
              if (isLineBlockedBySmoke && isLineBlockedBySmoke(this._tmpOrigin, this._tmpTarget)) {
                blockedBySmoke = true;
                continue;
              }
              if (this.hasLineOfSight(this._tmpOrigin, this._tmpTarget)) {
                bestDist = effDist;
                bestId = `zombie:${zt.id}`;
                bestLos = true;
              }
            }
          }
        } else {
          // Battle Mode: Consider hostile humans & hostile bots
          for (let h = 0; h < humans.length; h++) {
            const hm = humans[h];
            if (!hm.alive || !this.isHostilePair(bot.team, hm.team)) continue;
            this._tmpTarget.set(hm.pos.x, hm.pos.y + 1.42, hm.pos.z);
            const d = this._tmpOrigin.distanceTo(this._tmpTarget);
            if (d < bestDist) {
              if (isLineBlockedBySmoke && isLineBlockedBySmoke(this._tmpOrigin, this._tmpTarget)) {
                blockedBySmoke = true;
                continue;
              }
              if (this.hasLineOfSight(this._tmpOrigin, this._tmpTarget)) {
                bestDist = d;
                bestId = `human:${hm.id}`;
                bestLos = true;
              }
            }
          }

          for (let j = 0; j < this.bots.length; j++) {
            if (i === j) continue;
            const other = this.bots[j];
            if (!other.alive || !this.isHostilePair(bot.team, other.team)) continue;
            this._tmpTarget.set(other.pos.x, other.pos.y + 1.32, other.pos.z);
            const d = this._tmpOrigin.distanceTo(this._tmpTarget);
            if (d < bestDist) {
              if (isLineBlockedBySmoke && isLineBlockedBySmoke(this._tmpOrigin, this._tmpTarget)) {
                blockedBySmoke = true;
                continue;
              }
              if (this.hasLineOfSight(this._tmpOrigin, this._tmpTarget)) {
                bestDist = d;
                bestId = other.id;
                bestLos = true;
              }
            }
          }
        }

        if (activeSmokeClouds.length > 0) {
          let nearestCloud: ActiveSmokeCloudInfo | null = null;
          let nearestSq = 24 * 24;
          for (let c = 0; c < activeSmokeClouds.length; c++) {
            const cl = activeSmokeClouds[c];
            const dSq = cl.position.distanceToSquared(bot.pos);
            if (dSq < nearestSq) {
              nearestSq = dSq;
              nearestCloud = cl;
            }
          }
          if (nearestCloud && (blockedBySmoke || nearestSq < 16 * 16)) {
            bot.smokeAlertTimer = Math.max(bot.smokeAlertTimer, 3.2);
            bot.smokeCloudPos.copy(nearestCloud.position);
          }
        }

        if (bestLos && bestId) {
          if (bot.targetId !== bestId) {
            bot.reactionTimer = this.diff.reactionSec * (this.coopInfectionMode ? 0.72 : 1.0);
          }
          bot.targetId = bestId;
          bot.hasLos = true;

          // Universal Allied Bot Comms: Contact / Horde Sighting + World Ping
          if (!bot.prevHasLos && this.elapsedClockSec - bot.lastContactCalloutSec > 10.5 && this.isAlliedBot(bot)) {
            bot.lastContactCalloutSec = this.elapsedClockSec;
            if (this.coopInfectionMode) {
              const closeZombies = zombies.filter((z) => z.pos.distanceToSquared(bot.pos) < 12 * 12).length;
              const callText =
                closeZombies >= 4
                  ? 'Heavy infected swarm pushing our sector — light them up!'
                  : 'Infected spotted ahead — engaging!';
              this.emitAlliedComms(bot, 'threat', callText, {
                pingKind: 'enemy',
                pingLabel: closeZombies >= 4 ? 'INFECTED SWARM' : 'INFECTED',
                pingPos: this._tmpTarget.clone(),
                triggerAck: closeZombies >= 4,
                ackPool: ['Copy that, laying down fire!', 'Roger, covering your flank!'],
              });
            } else {
              this.emitAlliedComms(bot, 'threat', 'Contact! Hostile operator in sight — engaging!', {
                pingKind: 'enemy',
                pingLabel: 'HOSTILE',
                pingPos: this._tmpTarget.clone(),
                triggerAck: Math.random() < 0.55,
                ackPool: ['Copy contact — flanking!', 'Roger, moving to assist!'],
              });
            }
          }
        } else {
          bot.hasLos = false;
          if (blockedBySmoke || this.coopInfectionMode || Math.random() < 0.25) {
            bot.targetId = null;
            bot.burstShotsLeft = 0;
          }
        }
        bot.prevHasLos = bot.hasLos;
      }

      // Resolve live target position
      if (bot.targetId && bot.targetId.startsWith('zombie:')) {
        const zid = bot.targetId.slice(7);
        const zt = zombies.find((item) => item.id === zid);
        if (zt) {
          targetZombie = zt;
          targetPos = this._tmpTarget.set(zt.pos.x, zt.pos.y + 1.24, zt.pos.z);
        } else {
          bot.targetId = null;
          bot.hasLos = false;
        }
      } else if (bot.targetId === 'player') {
        const hm = humans[0];
        if (hm && hm.alive && this.isHostilePair(bot.team, hm.team)) {
          targetHuman = hm;
          targetPos = this._tmpTarget.set(hm.pos.x, hm.pos.y + 1.38, hm.pos.z);
        } else {
          bot.targetId = null;
          bot.hasLos = false;
        }
      } else if (bot.targetId && bot.targetId.startsWith('human:')) {
        const hid = bot.targetId.slice(6);
        const hm = humans.find((h) => h.id === hid && h.alive && this.isHostilePair(bot.team, h.team));
        if (hm) {
          targetHuman = hm;
          targetPos = this._tmpTarget.set(hm.pos.x, hm.pos.y + 1.38, hm.pos.z);
        } else {
          bot.targetId = null;
          bot.hasLos = false;
        }
      } else if (bot.targetId) {
        const other = this.bots.find((b) => b.id === bot.targetId && b.alive);
        if (other && this.isHostilePair(bot.team, other.team)) {
          targetBot = other;
          targetPos = this._tmpTarget.set(other.pos.x, other.pos.y + 1.32, other.pos.z);
        } else {
          bot.targetId = null;
          bot.hasLos = false;
        }
      }

      // Evaluate tactical crouching & corner leaning periodically
      bot.postureEvalTimer -= dt;
      if (bot.postureEvalTimer <= 0) {
        bot.postureEvalTimer = 0.24 + Math.random() * 0.1;
        this.evaluateTacticalPosture(bot, targetPos);
      }

      // 2. Navigation / Cover Movement / Squad Follow
      let moveX = 0;
      let moveZ = 0;
      const moveSpeed = this.diff.moveSpeed * (1 - bot.crouchBlend * 0.28);

      if (bot.hasLos && targetPos) {
        const dx = targetPos.x - bot.pos.x;
        const dz = targetPos.z - bot.pos.z;
        const horizDist = Math.hypot(dx, dz);
        bot.targetYaw = Math.atan2(-dx, -dz);

        bot.strafeTimer -= dt;
        if (bot.strafeTimer <= 0) {
          bot.strafeDir = -bot.strafeDir;
          bot.strafeTimer = 0.85 + Math.random() * 1.15;
        }

        const nx = horizDist > 0.01 ? dx / horizDist : 0;
        const nz = horizDist > 0.01 ? dz / horizDist : -1;
        const strafeX = -nz * bot.strafeDir;
        const strafeZ = nx * bot.strafeDir;
        let radial = 0;
        if (this.coopInfectionMode) {
          // Keep safe distance from melee zombies (backpedal urgently when < 5.5m!)
          if (horizDist < 5.5) radial = -0.95;
          else if (horizDist > 16) radial = 0.35;
        } else {
          if (horizDist > 18) radial = 0.55;
          else if (horizDist < 6.5) radial = -0.6;
        }

        moveX = (strafeX * 0.72 + nx * radial) * moveSpeed * 0.68;
        moveZ = (strafeZ * 0.72 + nz * radial) * moveSpeed * 0.68;

        // 3. Burst-Fire Engagement (Weapon-spec accurate, finite ammo + reloads + handling locks + melee fallback)
        const activeSpec = this.getWeaponSpec(bot.weaponId);
        const isSuppBusy =
          bot.handlingAction === 'SUPPRESSOR_DETACH' ||
          bot.handlingAction === 'SUPPRESSOR_ATTACH';
        // Emergency close-quarters cancel if enemy rushes inside 9.5m while threading suppressor
        if (isSuppBusy && horizDist < 9.5) {
          bot.handlingAction = 'NONE';
          bot.handlingTimer = 0;
          bot.handlingDuration = 0;
          bot.rig.setSuppressedVisual(bot.suppressed);
          bot.suppToggleCooldown = 6.5;
        }
        const isHandlingLocked =
          bot.handlingAction === 'SUPPRESSOR_DETACH' ||
          bot.handlingAction === 'SUPPRESSOR_ATTACH' ||
          bot.handlingAction === 'PUMP' ||
          bot.handlingAction === 'BOLT' ||
          bot.grenadeStage !== 'HOLSTERED';

        // Consider initiating a 4-stage grenade throw from medium/close combat range
        if (
          bot.grenadeStage === 'HOLSTERED' &&
          bot.grenadeCooldown <= 0 &&
          bot.stunTimer <= 0 &&
          bot.reloadTimer <= 0 &&
          !isHandlingLocked &&
          bot.burstShotsLeft <= 0 &&
          !bot.vaultActive &&
          horizDist >= 3.5 &&
          horizDist <= 24.0
        ) {
          this.tryStartBotGrenade(bot, targetPos, horizDist, humans, zombies);
        }

        if (bot.stunTimer > 0) {
          bot.stunTimer = Math.max(0, bot.stunTimer - dt);
          bot.burstShotsLeft = 0;
          moveX *= 0.25;
          moveZ *= 0.25;
        } else if (bot.reloadTimer > 0 || isHandlingLocked) {
          bot.burstShotsLeft = 0;
        } else if (bot.reactionTimer > 0) {
          bot.reactionTimer -= dt;
        } else {
          const curMag = bot.magAmmoByWeapon[bot.weaponId] ?? activeSpec.magCapacity;
          const curRes = bot.reserveAmmoByWeapon[bot.weaponId] ?? -1;

          if (curMag <= 0) {
            if (curRes !== 0) {
              // Start timed tactical reload
              bot.reloadDuration = activeSpec.reloadSec / (bot.perks.has('rapid_handling') ? 1.6 : 1.0);
              bot.reloadTimer = bot.reloadDuration;
              bot.burstShotsLeft = 0;
              if (this.isAlliedBot(bot) && Math.random() < 0.45) {
                this.emitAlliedComms(bot, 'status', `Reloading ${activeSpec.label} — cover me!`);
              }
            } else {
              // Active weapon completely dry -> try switching to other slot with ammo
              const altIdx = bot.weaponSlots.findIndex((wid, idx) => {
                if (idx === bot.activeSlotIndex) return false;
                return (bot.magAmmoByWeapon[wid] ?? 0) + Math.max(0, bot.reserveAmmoByWeapon[wid] ?? 0) > 0;
              });
              if (altIdx >= 0) {
                bot.activeSlotIndex = altIdx;
                this.applyBotActiveWeapon(bot, bot.weaponSlots[altIdx]);
                if (this.isAlliedBot(bot)) {
                  this.emitAlliedComms(bot, 'status', `Primary dry — switching to ${bot.weaponLabel}!`);
                }
              } else if (this.coopInfectionMode && targetZombie && onHitZombie && horizDist < 2.25 && bot.meleeCooldown <= 0) {
                // Defensive knife/bash melee when completely out of ammo!
                bot.meleeCooldown = 0.88;
                bot.recoilKick = 0.9;
                onHitZombie({
                  zombieId: targetZombie.id,
                  damage: 58,
                  hitZone: 'thorax',
                  impactPoint: targetPos.clone(),
                  impactDir: this._tmpDir.set(nx, 0.1, nz).clone(),
                  shooterId: bot.id,
                  shooterName: bot.name,
                  weaponId: 'melee',
                  weaponLabel: 'MELEE',
                  melee: true,
                });
              }
            }
          } else {
            if (bot.burstShotsLeft <= 0) {
              bot.burstCooldown -= dt;
              if (bot.burstCooldown <= 0) {
                const bMin = this.coopInfectionMode ? activeSpec.burstMin : this.diff.burstMin;
                const bMax = this.coopInfectionMode ? activeSpec.burstMax : this.diff.burstMax;
                bot.burstShotsLeft = bMin + Math.floor(Math.random() * (bMax - bMin + 1));
                bot.fireTimer = 0;
              }
            }

            if (bot.burstShotsLeft > 0) {
              bot.fireTimer -= dt;
              if (bot.fireTimer <= 0) {
                bot.fireTimer = this.coopInfectionMode ? activeSpec.fireIntervalSec : this.diff.fireIntervalSec;
                bot.burstShotsLeft -= 1;
                bot.magAmmoByWeapon[bot.weaponId] = Math.max(0, curMag - 1);
                if (bot.burstShotsLeft <= 0) {
                  const basePause = this.coopInfectionMode ? activeSpec.burstPauseSec : this.diff.burstPauseSec;
                  bot.burstCooldown = basePause * (0.75 + Math.random() * 0.45);
                }
                this.modeController?.cancelSpawnProtection(bot.id);
                this.fireBotRound(
                  bot,
                  targetPos,
                  targetBot,
                  targetHuman,
                  targetZombie,
                  onDamagePlayer,
                  onBotFire,
                  onHitZombie,
                );
                // Trigger realistic post-shot pump or bolt cycle for manual-action firearms
                const firedProf = resolveWeaponProfile(bot.weaponId);
                if (firedProf.category === 'shotguns' && firedProf.fireMode === 'pump') {
                  bot.handlingAction = 'PUMP';
                  bot.handlingTimer = 0;
                  bot.handlingDuration = 0.34;
                } else if (firedProf.fireMode === 'bolt') {
                  bot.handlingAction = 'BOLT';
                  bot.handlingTimer = 0;
                  bot.handlingDuration = 0.72;
                }
              }
            }
          }
        }
      } else {
        if (bot.stunTimer > 0) {
          bot.stunTimer = Math.max(0, bot.stunTimer - dt);
        }
        // Tactical suppressor field toggle when out of direct line-of-sight
        if (
          bot.ownsSuppressor &&
          bot.suppToggleCooldown <= 0 &&
          bot.reloadTimer <= 0 &&
          bot.handlingAction === 'NONE' &&
          !bot.vaultActive &&
          bot.stunTimer <= 0
        ) {
          bot.suppToggleCooldown = 22 + Math.random() * 18;
          const shouldAttach = !bot.suppressed;
          bot.pendingSuppressorAttach = shouldAttach;
          bot.handlingAction = shouldAttach ? 'SUPPRESSOR_ATTACH' : 'SUPPRESSOR_DETACH';
          bot.handlingTimer = 0;
          bot.handlingDuration = SUPPRESSOR_TOGGLE_DURATION_SEC;
        }
        if (bot.smokeAlertTimer > 0) {
          bot.smokeAlertTimer = Math.max(0, bot.smokeAlertTimer - dt);
          const dx = bot.smokeCloudPos.x - bot.pos.x;
          const dz = bot.smokeCloudPos.z - bot.pos.z;
          const dist = Math.max(0.5, Math.hypot(dx, dz));
          const nx = dx / dist;
          const nz = dz / dist;
          const flankX = -nz * bot.smokeFlankDir;
          const flankZ = nx * bot.smokeFlankDir;
          const radial = dist < 5.2 ? -0.85 : dist > 13.5 ? 0.35 : 0.0;
          moveX = (flankX * 0.82 + nx * radial) * moveSpeed * 0.78;
          moveZ = (flankZ * 0.82 + nz * radial) * moveSpeed * 0.78;
          bot.targetYaw = Math.atan2(-dx, -dz);
        } else {
          // Patrol / Advance across NavGraph with door-safe A* and string-pulling
          const zones = this.coopInfectionMode ? this.unlockedZones : undefined;
          const doors = this.coopInfectionMode ? this.openedDoors : undefined;

          bot.repathTimer -= dt;
          if (bot.repathTimer <= 0 || bot.pathIndex >= bot.path.length) {
            bot.repathTimer = 1.2 + Math.random() * 0.9;
            const startNode = findNearestNavNode(this.map.navGraph, bot.pos, zones, doors);
            if (startNode) {
              let goalNode: NavNode | null = null;

              if (this.coopInfectionMode) {
                // Autonomous Infection Economy Brain: evaluate buying guns, doors, power, perks, ammo & repairs
                if (infectionEconomy) {
                  bot.economyEvalTimer -= dt;
                  if (bot.economyEvalTimer <= 0 && !bot.economyGoal) {
                    bot.economyEvalTimer = infectionEconomy.intermissionActive ? 0.65 : 2.2 + Math.random() * 1.4;
                    const nearestZDistSq = zombies.reduce(
                      (minSq, z) => Math.min(minSq, z.pos.distanceToSquared(bot.pos)),
                      Infinity,
                    );
                    if (infectionEconomy.intermissionActive || nearestZDistSq > 7.5 * 7.5) {
                      bot.economyGoal = this.pickInfectionEconomyGoal(bot, infectionEconomy);
                    }
                  }
                }

                if (bot.economyGoal && infectionEconomy) {
                  const distToGoal = Math.hypot(
                    bot.economyGoal.pos.x - bot.pos.x,
                    bot.economyGoal.pos.z - bot.pos.z,
                  );
                  if (distToGoal <= 2.65) {
                    const done = this.executeInfectionEconomyGoal(bot, bot.economyGoal, infectionEconomy, dt);
                    if (done) {
                      bot.economyGoal = null;
                      bot.economyEvalTimer = 1.6;
                    }
                  } else {
                    goalNode = findNearestNavNode(this.map.navGraph, bot.economyGoal.pos, zones, doors);
                  }
                }

                if (!goalNode) {
                  // Friendly Infection bots support living human players & patrol unlocked sectors
                  const aliveHumans = humans.filter((hm) => hm.alive);
                  const anchor = aliveHumans.length > 0 ? aliveHumans[i % aliveHumans.length] : null;
                  const distToAnchor = anchor
                    ? Math.hypot(anchor.pos.x - bot.pos.x, anchor.pos.z - bot.pos.z)
                    : 0;

                  if (anchor && distToAnchor > 7.5) {
                    // Follow human squadmate through unlocked rooms
                    goalNode = findNearestNavNode(this.map.navGraph, anchor.pos, zones, doors);
                  } else if (zombies.length > 0 && Math.random() < 0.6) {
                    // Move toward nearest active interior zombie's sector
                    const nearestZ = zombies.find((z) => !z.enteringWindow) ?? zombies[0];
                    if (nearestZ) {
                      goalNode = findNearestNavNode(this.map.navGraph, nearestZ.pos, zones, doors);
                    }
                  }
                  if (!goalNode || goalNode.id === startNode.id) {
                    const unlockedNodes = this.map.navGraph.nodes.filter(
                      (n) =>
                        this.unlockedZones.has(n.zoneId) &&
                        (!n.requiredDoorId || this.openedDoors.has(n.requiredDoorId)) &&
                        n.id !== startNode.id,
                    );
                    if (unlockedNodes.length > 0) {
                      goalNode = unlockedNodes[Math.floor(Math.random() * unlockedNodes.length)];
                    }
                  }
                }
              } else {
                const nodes = this.map.navGraph.nodes;
                // Objective Brain: Conquest POIs, CTF Flags, KOTH Hills, Kill Confirmed Dogtags
                const objTarget = this.modeController?.getBotObjectiveTarget(
                  bot.id,
                  bot.team,
                  bot.pos,
                );
                if (objTarget && Math.random() < Math.min(0.92, 0.58 + objTarget.priority * 0.28)) {
                  this._tmpTarget.set(
                    objTarget.position[0],
                    objTarget.position[1],
                    objTarget.position[2],
                  );
                  goalNode = findNearestNavNode(this.map.navGraph, this._tmpTarget);
                }

                if (!goalNode && Math.random() < 0.58) {
                  const hostileHumans = humans.filter(
                    (hm) => hm.alive && this.isHostilePair(bot.team, hm.team),
                  );
                  if (hostileHumans.length > 0 && Math.random() < 0.65) {
                    const chosenH = hostileHumans[Math.floor(Math.random() * hostileHumans.length)];
                    goalNode = findNearestNavNode(this.map.navGraph, chosenH.pos);
                  } else {
                    const hostiles = this.bots.filter(
                      (o) => o.alive && o.id !== bot.id && this.isHostilePair(bot.team, o.team),
                    );
                    if (hostiles.length > 0) {
                      const chosen = hostiles[Math.floor(Math.random() * hostiles.length)];
                      goalNode = findNearestNavNode(this.map.navGraph, chosen.pos);
                    }
                  }
                }
                if (!goalNode || goalNode.id === startNode.id) {
                  const coverNodes = nodes.filter((n) => n.isCover && n.id !== startNode.id);
                  const pool = coverNodes.length > 0 && Math.random() < 0.7 ? coverNodes : nodes;
                  goalNode = pool[Math.floor(Math.random() * pool.length)];
                }
              }

              if (goalNode && goalNode.id !== startNode.id) {
                bot.path = this.findBotPath(startNode.id, goalNode.id);
                bot.pathIndex = bot.path.length > 1 ? 1 : 0;
                bot.goalNodeId = goalNode.id;
              }
            }
          }

          // String-pulling: skip redundant waypoint when clear walkable corridor exists on same level
          while (bot.pathIndex + 1 < bot.path.length) {
            const curWp = bot.path[bot.pathIndex];
            const nextWp = bot.path[bot.pathIndex + 1];
            const dyCur = Math.abs(curWp.position[1] - bot.pos.y);
            const dyNext = Math.abs(nextWp.position[1] - bot.pos.y);
            if (
              dyCur < 0.85 &&
              dyNext < 0.85 &&
              this.isWalkSegmentClear(
                bot.pos.x,
                bot.pos.z,
                nextWp.position[0],
                nextWp.position[2],
                bot.pos.y,
                BOT_RADIUS * 0.95,
              )
            ) {
              bot.pathIndex++;
            } else {
              break;
            }
          }

          if (bot.pathIndex < bot.path.length) {
            const wp = bot.path[bot.pathIndex];
            const dx = wp.position[0] - bot.pos.x;
            const dz = wp.position[2] - bot.pos.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.92) {
              bot.pathIndex++;
            } else {
              let dirX = dx / dist;
              let dirZ = dz / dist;

              // Check obstacle ahead -> try tactical vault/climb first, otherwise whisker-steer around!
              const probeDist = 0.92;
              const fwdBlocked = this.isPointBlockedXZ(
                bot.pos.x + dirX * probeDist,
                bot.pos.z + dirZ * probeDist,
                bot.pos.y,
                BOT_RADIUS * 0.9,
              );

              if (fwdBlocked && bot.vaultProbeTimer <= 0) {
                bot.vaultProbeTimer = 0.24;
                if (this.tryTriggerBotVault(bot, dirX, dirZ)) {
                  continue;
                }
              }

              if (fwdBlocked || bot.unstuckBoostTimer > 0) {
                const cosA = 0.78;
                const sinA = 0.62;
                const leftX = dirX * cosA - dirZ * sinA;
                const leftZ = dirX * sinA + dirZ * cosA;
                const rightX = dirX * cosA + dirZ * sinA;
                const rightZ = -dirX * sinA + dirZ * cosA;

                const leftClear = !this.isPointBlockedXZ(
                  bot.pos.x + leftX * probeDist,
                  bot.pos.z + leftZ * probeDist,
                  bot.pos.y,
                  BOT_RADIUS * 0.88,
                );
                const rightClear = !this.isPointBlockedXZ(
                  bot.pos.x + rightX * probeDist,
                  bot.pos.z + rightZ * probeDist,
                  bot.pos.y,
                  BOT_RADIUS * 0.88,
                );

                if (leftClear && !rightClear) {
                  dirX = leftX;
                  dirZ = leftZ;
                  bot.avoidDir = 1;
                } else if (rightClear && !leftClear) {
                  dirX = rightX;
                  dirZ = rightZ;
                  bot.avoidDir = -1;
                } else {
                  const perpX = -dirZ * bot.avoidDir;
                  const perpZ = dirX * bot.avoidDir;
                  dirX = dirX * 0.35 + perpX * 0.65;
                  dirZ = dirZ * 0.35 + perpZ * 0.65;
                  const nl = Math.hypot(dirX, dirZ) || 1;
                  dirX /= nl;
                  dirZ /= nl;
                }
              }

              moveX = dirX * moveSpeed;
              moveZ = dirZ * moveSpeed;
              bot.targetYaw = Math.atan2(-dirX, -dirZ);
            }
          } else if (this.coopInfectionMode && bot.economyGoal && infectionEconomy) {
            // Final short-range walk directly up to the interactable (door / wall-buy / barrier / power)
            const dx = bot.economyGoal.pos.x - bot.pos.x;
            const dz = bot.economyGoal.pos.z - bot.pos.z;
            const d = Math.hypot(dx, dz);
            if (d <= 2.65) {
              const done = this.executeInfectionEconomyGoal(bot, bot.economyGoal, infectionEconomy, dt);
              if (done) {
                bot.economyGoal = null;
                bot.economyEvalTimer = 1.6;
              }
            } else if (d < 9.0) {
              const dirX = dx / d;
              const dirZ = dz / d;
              moveX = dirX * moveSpeed * 0.85;
              moveZ = dirZ * moveSpeed * 0.85;
              bot.targetYaw = Math.atan2(-dirX, -dirZ);
            } else {
              bot.economyGoal = null;
            }
          }
        }
      }

      // Soft bot-to-bot separation so teammates don't overlap
      for (let j = 0; j < this.bots.length; j++) {
        if (i === j) continue;
        const other = this.bots[j];
        if (!other.alive) continue;
        const sx = bot.pos.x - other.pos.x;
        const sz = bot.pos.z - other.pos.z;
        const dSq = sx * sx + sz * sz;
        if (dSq > 1e-4 && dSq < 1.15) {
          const d = Math.sqrt(dSq);
          const push = (1.08 - d) * 3.0;
          moveX += (sx / d) * push;
          moveZ += (sz / d) * push;
        }
      }

      // Also keep friendly Infection bots from standing directly inside a human player
      if (this.coopInfectionMode) {
        for (let h = 0; h < humans.length; h++) {
          const hm = humans[h];
          if (!hm.alive) continue;
          const sx = bot.pos.x - hm.pos.x;
          const sz = bot.pos.z - hm.pos.z;
          const dSq = sx * sx + sz * sz;
          if (dSq > 1e-4 && dSq < 1.44) {
            const d = Math.sqrt(dSq);
            const push = (1.2 - d) * 3.2;
            moveX += (sx / d) * push;
            moveZ += (sz / d) * push;
          }
        }
      }

      // Integrate horizontal motion with AABB collision push-out + ground snapping
      const nextX = THREE.MathUtils.clamp(
        bot.pos.x + moveX * dt,
        this.map.physics.boundsMinX + 0.6,
        this.map.physics.boundsMaxX - 0.6,
      );
      const nextZ = THREE.MathUtils.clamp(
        bot.pos.z + moveZ * dt,
        this.map.physics.boundsMinZ + 0.6,
        this.map.physics.boundsMaxZ - 0.6,
      );

      // Bot Physical Door Traversal: automatically open closed/barely-open doors ahead of path with 3P animation
      if (this.map.doorSystem && bot.doorInteractCooldown <= 0 && Math.hypot(moveX, moveZ) > 0.35) {
        const doors = this.map.doorSystem.getDoors();
        for (let di = 0; di < doors.length; di++) {
          const door = doors[di];
          if (door.hingeMode !== 'attached') continue;
          const openRatio = Math.abs(door.angleRad) / Math.max(0.1, door.spec.maxOpenRad);
          if (!door.latched && openRatio >= 0.48) continue;
          if (Math.abs(bot.pos.y - door.spec.hingePos[1]) > 1.35) continue;

          this.map.doorSystem.getDoorCenterWorldPos(door.id, this._tmpMid);
          const ddx = this._tmpMid.x - bot.pos.x;
          const ddz = this._tmpMid.z - bot.pos.z;
          const distSq = ddx * ddx + ddz * ddz;
          if (distSq < 1.75 * 1.75) {
            const forwardDot = ddx * moveX + ddz * moveZ;
            if (forwardDot > 0.05) {
              const speed = Math.hypot(moveX, moveZ);
              const withSwing = this.map.doorSystem.isActorOnSwingWithSide(door.id, bot.pos);
              const useKick = withSwing && (bot.hasLos || speed > 4.2);
              if (useKick) {
                this._tmpDir.set(moveX, 0, moveZ).normalize();
                this.map.doorSystem.executeKick(door.id, this._tmpDir, speed, false, bot.team);
                if (bot.handlingAction === 'NONE') {
                  bot.handlingAction = 'DOOR_KICK';
                  bot.handlingTimer = 0;
                  bot.handlingDuration = 0.48;
                }
              } else {
                this.map.doorSystem.executeOption(door.id, 'open', {
                  actorPos: bot.pos,
                  actorTeam: bot.team,
                });
                if (bot.handlingAction === 'NONE') {
                  bot.handlingAction = 'DOOR_OPEN';
                  bot.handlingTimer = 0;
                  bot.handlingDuration = 0.54;
                }
              }
              bot.doorInteractCooldown = 1.4;
              break;
            }
          }
        }
      }

      // If alerted to a loud nearby door breach and no active LOS target, orient toward breach origin
      if (!bot.hasLos && bot.doorAlertTimer > 0) {
        bot.targetYaw = Math.atan2(bot.doorAlertPos.x - bot.pos.x, bot.doorAlertPos.z - bot.pos.z);
      }

      const resolved = this.resolveBotXZ(nextX, bot.pos.y, nextZ);
      bot.pos.x = resolved.x;
      bot.pos.z = resolved.z;
      const targetGroundY = this.sampleGroundY(bot.pos.x, bot.pos.z, bot.pos.y);
      bot.pos.y = THREE.MathUtils.damp(bot.pos.y, targetGroundY, 14, dt);

      // Stuck detection -> attempt vault/climb or recover via lateral sidestep & repath
      const desiredSpeed = Math.hypot(moveX, moveZ);
      if (desiredSpeed > 0.6) {
        bot.stuckTimer += dt;
        if (bot.stuckTimer >= 0.52) {
          const moved = Math.hypot(bot.pos.x - bot.lastProgressX, bot.pos.z - bot.lastProgressZ);
          bot.lastProgressX = bot.pos.x;
          bot.lastProgressZ = bot.pos.z;
          bot.stuckTimer = 0;
          if (moved < 0.16) {
            const vaulted = this.tryTriggerBotVault(bot, moveX / desiredSpeed, moveZ / desiredSpeed);
            if (!vaulted) {
              bot.avoidDir = -bot.avoidDir;
              bot.unstuckBoostTimer = 0.55;
              bot.repathTimer = 0;
            }
          }
        }
      } else {
        bot.stuckTimer = 0;
        bot.lastProgressX = bot.pos.x;
        bot.lastProgressZ = bot.pos.z;
      }

      // Advance 4-stage bot grenade manual of arms FSM (handles draw, pin pull, optional spoon pop/cook, windup, and release)
      this.stepBotGrenadeFSM(bot, dt, targetPos, humans);

      // Smooth yaw turn & tactical posture damping
      let yawDelta = bot.targetYaw - bot.yaw;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      bot.yaw += yawDelta * Math.min(1, dt * 10);

      bot.crouchBlend = THREE.MathUtils.damp(bot.crouchBlend, bot.targetCrouch, 9, dt);
      bot.leanBlend = THREE.MathUtils.damp(bot.leanBlend, bot.targetLean, 10, dt);

      const speedHoriz = Math.hypot(moveX, moveZ);
      if (speedHoriz > 0.2) {
        bot.walkCycle += dt * speedHoriz * 2.55;
      }

      const isAimingFire =
        bot.grenadeStage === 'HOLSTERED' &&
        (bot.hasLos || bot.firingVisualTimer > 0) &&
        bot.stunTimer <= 0;
      const flinchPitch =
        bot.stunTimer > 0
          ? -0.22 + Math.sin(performance.now() * 0.018) * 0.1
          : bot.flinchTimer > 0
            ? Math.sin(bot.flinchTimer * 35) * 0.16
            : 0;
      let aimPitch = 0;
      if ((bot.hasLos || bot.grenadeStage !== 'HOLSTERED') && targetPos) {
        const horizDist = Math.max(0.5, Math.hypot(targetPos.x - bot.pos.x, targetPos.z - bot.pos.z));
        aimPitch = THREE.MathUtils.clamp(
          Math.atan2(targetPos.y - (bot.pos.y + 1.36 - bot.crouchBlend * 0.42), horizDist),
          -0.75,
          0.75,
        );
      }

      const pose = this._poseScratch;
      pose.crouchBlend = bot.crouchBlend;
      pose.leanBlend = bot.leanBlend;
      pose.aimPitch = aimPitch;
      pose.adsBlend = isAimingFire ? 0.76 : 0.12;
      pose.pointAimBlend = 0;
      pose.cantBlend = 0;
      pose.reloadBlend =
        bot.reloadTimer > 0 ? Math.sin(Math.min(1, bot.reloadTimer / Math.max(0.2, bot.reloadDuration)) * Math.PI) : 0;
      pose.speedMps = speedHoriz;
      pose.walkCycle = bot.walkCycle;
      pose.sprint = !bot.hasLos && bot.grenadeStage === 'HOLSTERED' && bot.crouchBlend < 0.25 && speedHoriz > 3.1;
      pose.recoilKick = bot.recoilKick;
      pose.firingVibration = bot.firingVisualTimer > 0 ? Math.sin(performance.now() * 0.055) * 0.014 : 0;
      pose.flinchPitch = flinchPitch;
      pose.vaultBlend = 0;
      pose.vaultProgress = 0;
      pose.vaultKind = 'VAULT_OVER';
      if (bot.handlingAction !== 'NONE' && bot.handlingDuration > 0) {
        pose.handlingAction = bot.handlingAction;
        pose.handlingProgress = THREE.MathUtils.clamp(bot.handlingTimer / bot.handlingDuration, 0, 1);
      } else if (bot.reloadTimer > 0) {
        pose.handlingAction = 'RELOAD';
        pose.handlingProgress = THREE.MathUtils.clamp(
          1 - bot.reloadTimer / Math.max(0.2, bot.reloadDuration),
          0,
          1,
        );
      } else {
        pose.handlingAction = 'NONE';
        pose.handlingProgress = 0;
      }
      this.updateBotWallClearance(bot, dt, aimPitch);
      pose.grenadeEquipmentId = bot.grenadeEquipId;
      pose.grenadeCharge01 = bot.grenadeCharge01;
      pose.grenadeThrowStyle = bot.grenadeThrowStyle;
      pose.wallObstruction01 = bot.wallObstruction01;
      pose.beltWallTuck01 = bot.beltWallTuck01;
      pose.dt = dt;
      pose.distanceToCameraM = bot.pos.distanceTo(playerPos);
      pose.gazeTargetWorld = targetPos ?? playerPos;
      pose.isVisible = bot.root.visible;
      pose.injury01 = THREE.MathUtils.clamp(1 - bot.hp / Math.max(1, bot.maxHp), 0, 1);
      pose.flinchImpulse01 =
        bot.stunTimer > 0
          ? 0.9
          : bot.flinchTimer > 0
            ? Math.min(1, bot.flinchTimer / 0.25)
            : 0;
      pose.stress01 = isAimingFire ? 0.85 : bot.hasLos ? 0.65 : 0.2;
      pose.facialIntent =
        bot.stunTimer > 0 || bot.flinchTimer > 0
          ? 'suppressed'
          : bot.hp < bot.maxHp * 0.38
            ? 'injured'
            : isAimingFire
              ? 'aiming'
              : bot.hasLos
                ? 'alert'
                : 'calm';

      const distToCam = bot.pos.distanceTo(playerPos);
      const beyondReduceAnim = distToCam > reduceAnimDistM;
      bot.bodyPivot.rotation.set(0, 0, 0);
      bot.bodyPivot.position.set(0, 0, 0);
      bot.root.position.copy(bot.pos);
      bot.root.rotation.set(0, bot.yaw, 0);
      // Half-rate skeletal pose updates past the user's Reduce Animation Distance setting
      if (!beyondReduceAnim || ((i + this.animFrameTick) & 1) === 0) {
        pose.dt = beyondReduceAnim ? dt * 2.0 : dt;
        pose.distanceToCameraM = distToCam;
        bot.rig.applyCombatPose(pose);
      }
    }
  }

  private getBotPalmWorldPos(bot: BotActor, out: THREE.Vector3): THREE.Vector3 {
    const fx = -Math.sin(bot.yaw);
    const fz = -Math.cos(bot.yaw);
    const rx = Math.cos(bot.yaw);
    const rz = -Math.sin(bot.yaw);
    return out.set(
      bot.pos.x + rx * 0.22 + fx * 0.34,
      bot.pos.y + 1.38 - bot.crouchBlend * 0.38,
      bot.pos.z + rz * 0.22 + fz * 0.34,
    );
  }

  private hasFriendlyInBlastRadius(
    bot: BotActor,
    impactPos: Readonly<THREE.Vector3>,
    radiusM: number,
    humans: readonly BattleHumanTarget[],
  ): boolean {
    const rSq = radiusM * radiusM;
    for (let i = 0; i < this.bots.length; i++) {
      const other = this.bots[i];
      if (!other.alive) continue;
      if (other.id !== bot.id && this.isHostilePair(bot.team, other.team)) continue;
      if (other.pos.distanceToSquared(impactPos) <= rSq) return true;
    }
    for (let h = 0; h < humans.length; h++) {
      const hm = humans[h];
      if (!hm.alive || this.isHostilePair(bot.team, hm.team)) continue;
      if (hm.pos.distanceToSquared(impactPos) <= rSq) return true;
    }
    return false;
  }

  private solveBotThrowVelocity(
    origin: Readonly<THREE.Vector3>,
    target: Readonly<THREE.Vector3>,
    style: 'overhand' | 'underhand',
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const horizDist = Math.max(0.5, Math.hypot(dx, dz));
    const speed =
      style === 'underhand'
        ? 10.0
        : THREE.MathUtils.clamp(12.2 + horizDist * 0.45, 13.5, 22.5);
    const flightSec = horizDist / speed;
    const arcLiftY = 0.5 * 9.81 * flightSec * flightSec * (style === 'underhand' ? 0.65 : 0.86);
    out.set(dx, dy + arcLiftY, dz);
    if (out.lengthSq() < 1e-4) {
      out.set(0, 0.3, -1);
    }
    return out.normalize().multiplyScalar(speed);
  }

  private tryStartBotGrenade(
    bot: BotActor,
    targetPos: Readonly<THREE.Vector3>,
    horizDist: number,
    humans: readonly BattleHumanTarget[],
    zombies: ReadonlyArray<BattleZombieTarget>,
  ): void {
    // Pick best available ordnance from finite pouch
    let chosenId: TacticalEquipmentId | null = null;
    if (this.coopInfectionMode) {
      let nearbyZ = 0;
      for (let z = 0; z < zombies.length; z++) {
        if (zombies[z].pos.distanceToSquared(targetPos) <= 25) nearbyZ++;
      }
      if (nearbyZ < 3) return;
      if ((bot.grenadePouch.an_m14_thermite ?? 0) > 0 && nearbyZ >= 4) {
        chosenId = 'an_m14_thermite';
      } else if ((bot.grenadePouch.m67_frag ?? 0) > 0) {
        chosenId = 'm67_frag';
      }
    } else {
      const order: TacticalEquipmentId[] =
        horizDist < 10.5
          ? ['m84_flash', 'm67_frag', 'm18_smoke', 'an_m14_thermite']
          : ['m67_frag', 'm84_flash', 'an_m14_thermite', 'm18_smoke'];
      for (const candidate of order) {
        if ((bot.grenadePouch[candidate] ?? 0) <= 0) continue;
        if (candidate === 'm67_frag' || candidate === 'an_m14_thermite') {
          const safeR = candidate === 'm67_frag' ? 6.5 : 4.2;
          if (this.hasFriendlyInBlastRadius(bot, targetPos, safeR, humans)) continue;
        }
        chosenId = candidate;
        break;
      }
    }

    if (!chosenId) return;
    if (Math.random() > 0.24) {
      bot.grenadeCooldown = 2.5 + Math.random() * 2.0;
      return;
    }

    const def = getTacticalEquipmentDef(chosenId);
    bot.grenadeEquipId = chosenId;
    bot.grenadeFuseSec = Math.max(
      0.8,
      def.fuseSec + (Math.random() * 2 - 1) * def.fuseVarianceSec,
    );
    bot.grenadeFuseRemaining = bot.grenadeFuseSec;
    bot.grenadeTargetPos.copy(targetPos);
    bot.grenadeThrowStyle = horizDist < 9.0 ? 'underhand' : 'overhand';
    bot.grenadeCharge01 = 0;
    bot.grenadeChargeTarget =
      bot.grenadeThrowStyle === 'underhand'
        ? 0.15
        : THREE.MathUtils.clamp((horizDist - 7) / 17, 0.25, 0.96);
    bot.grenadeSpoonPopped = false;
    bot.grenadeThrowDispatched = false;
    bot.grenadeCookTargetSec =
      chosenId === 'm67_frag' && horizDist >= 7.5 && Math.random() < 0.42
        ? 0.45 + Math.random() * 0.75
        : 0;
    bot.grenadeOvercookRisk =
      chosenId === 'm67_frag' && Math.random() < 0.04;
    if (bot.grenadeOvercookRisk) {
      bot.grenadeCookTargetSec = bot.grenadeFuseSec + 1.0;
    }

    bot.grenadeStage = 'DRAWN';
    bot.grenadeStageTimer = 0;
    bot.grenadeCooldown = 11.0 + Math.random() * 8.0;
    bot.handlingAction = 'GRENADE_DRAW';
    bot.handlingTimer = 0;
    bot.handlingDuration = 0.34;
    this.syncBotBeltGrenade(bot);
    if (this.isAlliedBot(bot)) {
      this.emitAlliedComms(
        bot,
        'status',
        chosenId === 'm84_flash'
          ? 'Flash out — shield your optics!'
          : chosenId === 'm18_smoke'
            ? 'Deploying smoke screen!'
            : 'Frag out — watch your spacing!',
      );
    }
  }

  private stepBotGrenadeFSM(
    bot: BotActor,
    dt: number,
    targetPos: THREE.Vector3 | null,
    humans: readonly BattleHumanTarget[],
  ): void {
    if (bot.grenadeStage === 'HOLSTERED') return;

    if (targetPos) {
      bot.grenadeTargetPos.copy(targetPos);
    }

    // Live drop if stunned after releasing safety lever
    if (bot.stunTimer > 0.25) {
      if (bot.grenadeSpoonPopped) {
        const palm = this.getBotPalmWorldPos(bot, new THREE.Vector3());
        const prev = bot.grenadePouch[bot.grenadeEquipId] ?? 0;
        bot.grenadePouch[bot.grenadeEquipId] = Math.max(0, prev - 1);
        this.onBotGrenadeCb?.({
          botId: bot.id,
          botName: bot.name,
          team: bot.team,
          kind: 'live_drop',
          equipmentId: bot.grenadeEquipId,
          origin: palm,
          velocity: new THREE.Vector3((Math.random() - 0.5) * 1.2, 1.0, (Math.random() - 0.5) * 1.2),
          fuseRemainingSec: Math.max(0.15, bot.grenadeFuseRemaining),
        });
      }
      bot.grenadeStage = 'HOLSTERED';
      bot.grenadeSpoonPopped = false;
      bot.grenadeCharge01 = 0;
      bot.handlingAction = 'NONE';
      bot.handlingTimer = 0;
      bot.handlingDuration = 0;
      this.syncBotBeltGrenade(bot);
      return;
    }

    // Burn active pyrotechnic fuse if safety lever has been popped
    if (bot.grenadeSpoonPopped) {
      bot.grenadeFuseRemaining -= dt;
      if (bot.grenadeFuseRemaining <= 0) {
        const palm = this.getBotPalmWorldPos(bot, new THREE.Vector3());
        const prev = bot.grenadePouch[bot.grenadeEquipId] ?? 0;
        bot.grenadePouch[bot.grenadeEquipId] = Math.max(0, prev - 1);
        const def = getTacticalEquipmentDef(bot.grenadeEquipId);
        this.onBotGrenadeCb?.({
          botId: bot.id,
          botName: bot.name,
          team: bot.team,
          kind: 'in_hand_detonate',
          equipmentId: bot.grenadeEquipId,
          origin: palm,
          velocity: new THREE.Vector3(),
          fuseRemainingSec: 0,
        });
        bot.grenadeStage = 'HOLSTERED';
        bot.grenadeSpoonPopped = false;
        bot.grenadeCharge01 = 0;
        bot.handlingAction = 'NONE';
        bot.handlingTimer = 0;
        bot.handlingDuration = 0;
        this.syncBotBeltGrenade(bot);
        if (def.category === 'lethal') {
          this.killBot(bot, bot.name, bot.team, false, def.killfeedLabel);
        }
        return;
      }
    }

    bot.grenadeStageTimer += dt;

    if (bot.grenadeStage === 'DRAWN') {
      bot.handlingAction = 'GRENADE_DRAW';
      bot.handlingDuration = 0.34;
      bot.handlingTimer = Math.min(0.34, bot.grenadeStageTimer);
      if (bot.grenadeStageTimer >= 0.34) {
        bot.grenadeStage = 'PIN_PULLED';
        bot.grenadeStageTimer = 0;
        bot.handlingAction = 'GRENADE_PIN_PULL';
        bot.handlingDuration = 0.56;
        bot.handlingTimer = 0;
        const palm = this.getBotPalmWorldPos(bot, new THREE.Vector3());
        this.onBotGrenadeCb?.({
          botId: bot.id,
          botName: bot.name,
          team: bot.team,
          kind: 'pin_pull',
          equipmentId: bot.grenadeEquipId,
          origin: palm,
          velocity: new THREE.Vector3(),
          fuseRemainingSec: bot.grenadeFuseRemaining,
        });
      }
    } else if (bot.grenadeStage === 'PIN_PULLED') {
      bot.handlingAction = 'GRENADE_PIN_PULL';
      bot.handlingDuration = 0.56;
      bot.handlingTimer = Math.min(0.56, bot.grenadeStageTimer);
      if (bot.grenadeStageTimer >= 0.56) {
        if (bot.grenadeCookTargetSec > 0) {
          bot.grenadeStage = 'LEVER_RELEASED';
          bot.grenadeStageTimer = 0;
          bot.grenadeSpoonPopped = true;
          bot.handlingAction = 'GRENADE_COOK';
          bot.handlingDuration = Math.max(0.25, bot.grenadeCookTargetSec);
          bot.handlingTimer = 0;
          const palm = this.getBotPalmWorldPos(bot, new THREE.Vector3());
          this.onBotGrenadeCb?.({
            botId: bot.id,
            botName: bot.name,
            team: bot.team,
            kind: 'spoon_pop',
            equipmentId: bot.grenadeEquipId,
            origin: palm,
            velocity: new THREE.Vector3(Math.cos(bot.yaw) * 1.5, 1.2, -Math.sin(bot.yaw) * 1.5),
            fuseRemainingSec: bot.grenadeFuseRemaining,
          });
        } else {
          bot.grenadeStage = 'CHARGING';
          bot.grenadeStageTimer = 0;
          bot.handlingAction = 'GRENADE_CHARGE';
          bot.handlingDuration = bot.grenadeThrowStyle === 'underhand' ? 0.14 : 0.45;
          bot.handlingTimer = 0;
        }
      }
    } else if (bot.grenadeStage === 'LEVER_RELEASED') {
      bot.handlingAction = 'GRENADE_COOK';
      bot.handlingDuration = Math.max(0.25, bot.grenadeCookTargetSec);
      bot.handlingTimer = Math.min(bot.handlingDuration, bot.grenadeStageTimer);
      if (bot.grenadeStageTimer >= bot.grenadeCookTargetSec) {
        bot.grenadeStage = 'CHARGING';
        bot.grenadeStageTimer = 0;
        bot.handlingAction = 'GRENADE_CHARGE';
        bot.handlingDuration = bot.grenadeThrowStyle === 'underhand' ? 0.14 : 0.42;
        bot.handlingTimer = 0;
      }
    } else if (bot.grenadeStage === 'CHARGING') {
      const chargeDur = bot.grenadeThrowStyle === 'underhand' ? 0.14 : 0.42;
      bot.grenadeCharge01 = THREE.MathUtils.lerp(
        0,
        bot.grenadeChargeTarget,
        THREE.MathUtils.clamp(bot.grenadeStageTimer / chargeDur, 0, 1),
      );
      bot.handlingAction = 'GRENADE_CHARGE';
      bot.handlingDuration = chargeDur;
      bot.handlingTimer = Math.min(chargeDur, bot.grenadeStageTimer);
      if (bot.grenadeStageTimer >= chargeDur) {
        // Last-moment friendly check on lethal ordnance: if teammate rushed in, abort only if unpopped
        if (
          !bot.grenadeSpoonPopped &&
          (bot.grenadeEquipId === 'm67_frag' || bot.grenadeEquipId === 'an_m14_thermite') &&
          this.hasFriendlyInBlastRadius(bot, bot.grenadeTargetPos, 5.5, humans)
        ) {
          bot.grenadeStage = 'HOLSTERED';
          bot.grenadeCharge01 = 0;
          bot.handlingAction = 'NONE';
          bot.handlingTimer = 0;
          bot.handlingDuration = 0;
          this.syncBotBeltGrenade(bot);
          return;
        }
        bot.grenadeStage = 'THROWING';
        bot.grenadeStageTimer = 0;
        bot.grenadeThrowDispatched = false;
        bot.handlingAction =
          bot.grenadeThrowStyle === 'underhand'
            ? 'GRENADE_THROW_UNDERHAND'
            : 'GRENADE_THROW_OVERHAND';
        bot.handlingDuration = bot.grenadeThrowStyle === 'underhand' ? 0.30 : 0.34;
        bot.handlingTimer = 0;
      }
    } else if (bot.grenadeStage === 'THROWING') {
      const whipDur = bot.grenadeThrowStyle === 'underhand' ? 0.30 : 0.34;
      bot.handlingAction =
        bot.grenadeThrowStyle === 'underhand'
          ? 'GRENADE_THROW_UNDERHAND'
          : 'GRENADE_THROW_OVERHAND';
      bot.handlingDuration = whipDur;
      bot.handlingTimer = Math.min(whipDur, bot.grenadeStageTimer);
      if (!bot.grenadeThrowDispatched && bot.grenadeStageTimer >= whipDur * 0.30) {
        bot.grenadeThrowDispatched = true;
        const palm = this.getBotPalmWorldPos(bot, new THREE.Vector3());
        if (!bot.grenadeSpoonPopped) {
          bot.grenadeSpoonPopped = true;
          this.onBotGrenadeCb?.({
            botId: bot.id,
            botName: bot.name,
            team: bot.team,
            kind: 'spoon_pop',
            equipmentId: bot.grenadeEquipId,
            origin: palm.clone(),
            velocity: new THREE.Vector3(Math.cos(bot.yaw) * 1.4, 1.1, -Math.sin(bot.yaw) * 1.4),
            fuseRemainingSec: bot.grenadeFuseRemaining,
          });
        }
        const vel = this.solveBotThrowVelocity(
          palm,
          bot.grenadeTargetPos,
          bot.grenadeThrowStyle,
          new THREE.Vector3(),
        );
        const prev = bot.grenadePouch[bot.grenadeEquipId] ?? 0;
        bot.grenadePouch[bot.grenadeEquipId] = Math.max(0, prev - 1);
        this.onBotGrenadeCb?.({
          botId: bot.id,
          botName: bot.name,
          team: bot.team,
          kind: 'throw',
          equipmentId: bot.grenadeEquipId,
          origin: palm,
          velocity: vel,
          fuseRemainingSec: Math.max(0.2, bot.grenadeFuseRemaining),
        });
        this.syncBotBeltGrenade(bot);
      }
      if (bot.grenadeStageTimer >= whipDur) {
        bot.grenadeStage = 'HOLSTERED';
        bot.grenadeSpoonPopped = false;
        bot.grenadeCharge01 = 0;
        bot.handlingAction = 'NONE';
        bot.handlingTimer = 0;
        bot.handlingDuration = 0;
        this.syncBotBeltGrenade(bot);
      }
    }
  }

  private resolveBotXZ(x: number, baseY: number, z: number): { x: number; z: number } {
    let cx = x;
    let cz = z;
    const r = BOT_RADIUS;
    const rSq = r * r;
    const pyMin = baseY + 0.36;
    const pyMax = baseY + 1.72;

    const boxes = this.map.physics.boxes;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.blocksMovement === false) continue;
        if (pyMax <= b.minY + 0.02 || pyMin >= b.maxY - 0.02) continue;

        const qx = THREE.MathUtils.clamp(cx, b.minX, b.maxX);
        const qz = THREE.MathUtils.clamp(cz, b.minZ, b.maxZ);
        const dx = cx - qx;
        const dz = cz - qz;
        const dSq = dx * dx + dz * dz;
        if (dSq < rSq) {
          if (dSq > 1e-6) {
            const d = Math.sqrt(dSq);
            const pen = r - d;
            cx += (dx / d) * pen;
            cz += (dz / d) * pen;
          } else {
            const dl = Math.abs(cx - b.minX);
            const dr = Math.abs(b.maxX - cx);
            const df = Math.abs(cz - b.minZ);
            const db = Math.abs(b.maxZ - cz);
            const m = Math.min(dl, dr, df, db);
            if (m === dl) cx = b.minX - r;
            else if (m === dr) cx = b.maxX + r;
            else if (m === df) cz = b.minZ - r;
            else cz = b.maxZ + r;
          }
        }
      }
    }
    return { x: cx, z: cz };
  }

  private fireBotRound(
    shooter: BotActor,
    targetPos: Readonly<THREE.Vector3>,
    targetBot: BotActor | null,
    targetHuman: BattleHumanTarget | null,
    targetZombie: BattleZombieTarget | null,
    onDamagePlayer: (ev: BotPlayerDamageEvent) => void,
    onBotFire?: (
      botId: string,
      origin: Readonly<THREE.Vector3>,
      end: Readonly<THREE.Vector3>,
      meta?: { weaponId: string; caliberId: string; suppressed: boolean },
    ) => void,
    onHitZombie?: (ev: BotZombieHitEvent) => void,
  ): void {
    shooter.muzzleFlash.visible = !shooter.suppressed;
    shooter.muzzleFlashTimer = shooter.suppressed ? 0.025 : 0.055;
    shooter.firingVisualTimer = 0.16;
    shooter.recoilKick = Math.min(1, shooter.recoilKick + 0.85);
    shooter.muzzleFlash.getWorldPosition(this._tmpMuzzle);

    this._tmpDir.subVectors(targetPos, this._tmpMuzzle);
    const dist = Math.max(0.5, this._tmpDir.length());
    this._tmpDir.divideScalar(dist);

    const spec = this.getWeaponSpec(shooter.weaponId);
    const spread = this.diff.spreadRad * spec.spreadMult * (1 - shooter.crouchBlend * 0.18);
    this._tmpDir.x += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.y += (Math.random() - 0.5) * spread * 1.5;
    this._tmpDir.z += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.normalize();

    const endPos = this._tmpOrigin.copy(this._tmpMuzzle).addScaledVector(this._tmpDir, Math.min(dist + 4, 48));
    this.spawnTracer(this._tmpMuzzle, endPos);
    onBotFire?.(shooter.id, this._tmpMuzzle, endPos, {
      weaponId: shooter.weaponId,
      caliberId: spec.caliberId,
      suppressed: shooter.suppressed,
    });

    this.audio.playWeaponCue('fire', {
      position: this._tmpMuzzle,
      weightClass: spec.weightClass,
      caliberId: spec.caliberId,
      suppressed: shooter.suppressed,
      intensity: spec.visualClass === 'pistol' ? 0.56 : 0.72,
    });

    this._tmpToTarget.subVectors(targetPos, this._tmpMuzzle).normalize();
    const cosErr = THREE.MathUtils.clamp(this._tmpToTarget.dot(this._tmpDir), -1, 1);
    const angErr = Math.acos(cosErr);
    const hitAngleLimit = Math.atan2(
      targetZombie ? (spec.visualClass === 'shotgun' ? 0.74 : 0.56) : 0.46,
      Math.max(2.5, dist),
    );

    if (angErr <= hitAngleLimit) {
      if (targetZombie && onHitZombie) {
        const hs = Math.random() < (spec.visualClass === 'pistol' ? 0.28 : 0.24);
        onHitZombie({
          zombieId: targetZombie.id,
          damage: spec.damagePerShot,
          hitZone: hs ? 'head' : 'thorax',
          impactPoint: targetPos.clone(),
          impactDir: this._tmpDir.clone(),
          shooterId: shooter.id,
          shooterName: shooter.name,
          weaponId: shooter.weaponId,
          weaponLabel: shooter.weaponLabel,
        });
      } else if (targetBot) {
        const hs = Math.random() < 0.16;
        const rawDmg = this.diff.damagePerShot * (hs ? 2.0 : 1.0);
        const applied = Math.min(targetBot.hp, rawDmg);
        shooter.damageDealt += Math.round(applied);
        targetBot.recentAttackers.set(shooter.id, performance.now());
        targetBot.hp -= rawDmg;
        targetBot.flinchTimer = 0.14;
        if (targetBot.hp <= 0) {
          this.killBot(targetBot, shooter.name, shooter.team, hs, shooter.weaponLabel, shooter, 'bullet', shooter.id);
          if (this.isAlliedBot(shooter) && Math.random() < 0.42) {
            this.emitAlliedComms(shooter, 'status', `Tango down! ${targetBot.name} neutralized.`);
          }
        }
      } else if (targetHuman && !this.coopInfectionMode) {
        shooter.damageDealt += Math.round(this.diff.damagePerShot);
        onDamagePlayer({
          targetUserId: targetHuman.id,
          damage: this.diff.damagePerShot,
          attackerPos: shooter.pos.clone(),
          attackerName: shooter.name,
          attackerId: shooter.id,
          attackerTeam: shooter.team,
          weaponId: shooter.weaponId,
          caliberId: spec.caliberId,
        });
      }
    }
  }

  public dispose(): void {
    for (let i = 0; i < this.bots.length; i++) {
      this.bots[i].rig.disposeWeapon();
    }
    this.group.parent?.remove(this.group);
    this.rigFactory.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

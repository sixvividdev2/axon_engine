import { OperatorId } from '../bodycam-sdk/operator/OperatorTypes';
import {
  isValidLobbyKillfeedPolicy,
  LobbyKillfeedPolicy,
} from './killfeedSettings';
import { BattleRuleId, BotDifficultyId } from '../maps/types';

export type { LobbyKillfeedPolicy };
export type LobbyVisibility = 'public' | 'friends_only' | 'private';
export type LobbyModeId = 'battle' | 'infection';
export type EventCycleModeId = 'battle_tdm' | 'battle_ffa' | 'infection';
export type LobbyTeamId = 'A' | 'B';
export type ActiveWeatherConditionId = 'clear' | 'sunny' | 'overcast' | 'rainy' | 'stormy';
export type WeatherPresetId = 'auto' | ActiveWeatherConditionId;
export type TimeOfDayStartSetting = 'auto' | number;

export interface SpecialEventConfig {
  mode: LobbyModeId;
  battleRule: BattleRuleId;
  mapId: string;
  cycleModesBetweenGames: boolean;
  cyclePool: EventCycleModeId[];

  maxPlayers: number; // 2..8
  botsEnabled: boolean;
  botCount: number; // 0..10
  botDifficulty: BotDifficultyId;

  // Player & elimination rules
  playerHealth: number; // 25..500
  playerMoveSpeedMult: number; // 0.5..2.0
  playerRespawnEnabled: boolean; // false = die & spectate until round/match ends
  aiRespawnEnabled: boolean;
  livesPerRound: number; // 1 = one life per round (kills before full death)
  roundsPerMatch: number; // 1..15
  killLimit: number; // 10..100

  // AI Bot tuning
  aiHealth: number; // 25..400
  aiAccuracyMult: number; // 0.25..2.5
  aiMoveSpeedMult: number; // 0.5..2.0

  // Zombie / Infection tuning
  zombieHealthMult: number; // 0.25..4.0
  zombieMoveSpeedMult: number; // 0.5..2.5
  zombieAttackSpeedMult: number; // 0.5..2.5
  zombieSpawnAmountMult: number; // 0.25..3.0
  waveBreakIntervalSec: number; // 2..30
  killfeedPolicy?: LobbyKillfeedPolicy;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
}

export interface SpecialEventRecord {
  id: string;
  hashCode: string;
  creatorUserId: string;
  creatorUsername: string;
  name: string;
  description: string;
  config: SpecialEventConfig;
  createdAt: number;
  updatedAt: number;
}

export interface LobbyMember {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  team: LobbyTeamId;
  ready: boolean;
  isHost: boolean;
  connected: boolean;
  joinedAt: number;
}

export interface LobbyChatMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  system?: boolean;
  createdAt: number;
}

export interface LobbySettingsPatch {
  visibility?: LobbyVisibility;
  mode?: LobbyModeId;
  battleRule?: BattleRuleId;
  mapId?: string;
  maxPlayers?: number;
  botsEnabled?: boolean;
  botCount?: number;
  killLimit?: number;
  botDifficulty?: BotDifficultyId;
  killfeedPolicy?: LobbyKillfeedPolicy;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
}

export interface LobbyRoomState {
  code: string;
  hostUserId: string;
  hostUsername: string;
  visibility: LobbyVisibility;
  mode: LobbyModeId;
  battleRule: BattleRuleId;
  mapId: string;
  maxPlayers: number;
  botsEnabled: boolean;
  botCount: number;
  killLimit: number;
  botDifficulty: BotDifficultyId;
  killfeedPolicy?: LobbyKillfeedPolicy;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
  status: 'lobby' | 'in_match';
  matchSequence: number;
  specialEvent: SpecialEventRecord | null;
  members: LobbyMember[];
  chat: LobbyChatMessage[];
  updatedAt: number;
}

export interface LobbyBrowserEntry {
  code: string;
  hostUserId: string;
  hostUsername: string;
  visibility: LobbyVisibility;
  mode: LobbyModeId;
  battleRule: BattleRuleId;
  mapId: string;
  playerCount: number;
  maxPlayers: number;
  botsEnabled: boolean;
  botCount: number;
  status: 'lobby' | 'in_match';
  eventHashCode: string | null;
  eventName: string | null;
  creatorUsername: string | null;
  updatedAt: number;
}

export const DEFAULT_SPECIAL_EVENT_CONFIG: SpecialEventConfig = {
  mode: 'battle',
  battleRule: 'tdm',
  mapId: 'pripyat_block',
  cycleModesBetweenGames: false,
  cyclePool: ['battle_tdm', 'battle_ffa', 'infection'],

  maxPlayers: 8,
  botsEnabled: true,
  botCount: 6,
  botDifficulty: 'tactical',

  playerHealth: 100,
  playerMoveSpeedMult: 1.0,
  playerRespawnEnabled: true,
  aiRespawnEnabled: true,
  livesPerRound: 1,
  roundsPerMatch: 1,
  killLimit: 30,

  aiHealth: 100,
  aiAccuracyMult: 1.0,
  aiMoveSpeedMult: 1.0,

  zombieHealthMult: 1.0,
  zombieMoveSpeedMult: 1.0,
  zombieAttackSpeedMult: 1.0,
  zombieSpawnAmountMult: 1.0,
  waveBreakIntervalSec: 6,
  killfeedPolicy: 'player_choice',
  weatherPreset: 'auto',
  timeOfDayStart: 'auto',
};

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNum(val, min, max, fallback));
}

export function sanitizeSpecialEventConfig(raw: unknown): SpecialEventConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpecialEventConfig>;
  const mode: LobbyModeId = obj.mode === 'infection' ? 'infection' : 'battle';
  const battleRule: BattleRuleId = obj.battleRule === 'ffa' ? 'ffa' : 'tdm';
  const validMaps = new Set([
    'pripyat_block',
    'timberline_compound',
    'korsakov_substation',
    'kino_theater',
  ]);
  const defaultMap = mode === 'infection' ? 'kino_theater' : 'pripyat_block';
  const mapId = typeof obj.mapId === 'string' && validMaps.has(obj.mapId) ? obj.mapId : defaultMap;

  const validCycle = new Set<EventCycleModeId>(['battle_tdm', 'battle_ffa', 'infection']);
  const cyclePool = Array.isArray(obj.cyclePool)
    ? Array.from(
        new Set(obj.cyclePool.filter((c): c is EventCycleModeId => validCycle.has(c))),
      )
    : DEFAULT_SPECIAL_EVENT_CONFIG.cyclePool;

  const botDifficulty: BotDifficultyId =
    obj.botDifficulty === 'recruit' || obj.botDifficulty === 'veteran'
      ? obj.botDifficulty
      : 'tactical';

  const botsEnabled = typeof obj.botsEnabled === 'boolean' ? obj.botsEnabled : true;
  const botCount = botsEnabled ? clampInt(obj.botCount, 0, 10, 6) : 0;

  return {
    mode,
    battleRule,
    mapId,
    cycleModesBetweenGames: Boolean(obj.cycleModesBetweenGames),
    cyclePool: cyclePool.length > 0 ? cyclePool : ['battle_tdm'],

    maxPlayers: clampInt(obj.maxPlayers, 2, 8, 8),
    botsEnabled,
    botCount,
    botDifficulty,

    playerHealth: clampInt(obj.playerHealth, 25, 500, 100),
    playerMoveSpeedMult: Number(clampNum(obj.playerMoveSpeedMult, 0.5, 2.0, 1.0).toFixed(2)),
    playerRespawnEnabled:
      typeof obj.playerRespawnEnabled === 'boolean' ? obj.playerRespawnEnabled : true,
    aiRespawnEnabled: typeof obj.aiRespawnEnabled === 'boolean' ? obj.aiRespawnEnabled : true,
    livesPerRound: clampInt(obj.livesPerRound, 1, 10, 1),
    roundsPerMatch: clampInt(obj.roundsPerMatch, 1, 15, 1),
    killLimit: clampInt(obj.killLimit, 10, 100, 30),

    aiHealth: clampInt(obj.aiHealth, 25, 400, 100),
    aiAccuracyMult: Number(clampNum(obj.aiAccuracyMult, 0.25, 2.5, 1.0).toFixed(2)),
    aiMoveSpeedMult: Number(clampNum(obj.aiMoveSpeedMult, 0.5, 2.0, 1.0).toFixed(2)),

    zombieHealthMult: Number(clampNum(obj.zombieHealthMult, 0.25, 4.0, 1.0).toFixed(2)),
    zombieMoveSpeedMult: Number(clampNum(obj.zombieMoveSpeedMult, 0.5, 2.5, 1.0).toFixed(2)),
    zombieAttackSpeedMult: Number(clampNum(obj.zombieAttackSpeedMult, 0.5, 2.5, 1.0).toFixed(2)),
    zombieSpawnAmountMult: Number(clampNum(obj.zombieSpawnAmountMult, 0.25, 3.0, 1.0).toFixed(2)),
    waveBreakIntervalSec: clampInt(obj.waveBreakIntervalSec, 2, 30, 6),
    killfeedPolicy: isValidLobbyKillfeedPolicy(obj.killfeedPolicy)
      ? obj.killfeedPolicy
      : 'player_choice',
    weatherPreset: sanitizeWeatherPreset(obj.weatherPreset),
    timeOfDayStart: sanitizeTimeOfDayStart(obj.timeOfDayStart),
  };
}

const VALID_WEATHER_PRESETS = new Set<WeatherPresetId>([
  'auto',
  'clear',
  'sunny',
  'overcast',
  'rainy',
  'stormy',
]);

export function sanitizeWeatherPreset(val: unknown): WeatherPresetId {
  return typeof val === 'string' && VALID_WEATHER_PRESETS.has(val as WeatherPresetId)
    ? (val as WeatherPresetId)
    : 'auto';
}

export function sanitizeTimeOfDayStart(val: unknown): TimeOfDayStartSetting {
  if (val === 'auto' || val === undefined || val === null || val === '') return 'auto';
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) return 'auto';
  const wrapped = ((n % 24) + 24) % 24;
  return Number(wrapped.toFixed(2));
}

export function generateLobbyCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[buf[i] % chars.length];
  }
  return `AXON-${suffix}`;
}

export function generateEventHashCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  let partA = '';
  let partB = '';
  for (let i = 0; i < 4; i++) {
    partA += chars[buf[i] % chars.length];
    partB += chars[buf[i + 4] % chars.length];
  }
  return `EVT-${partA}-${partB}`;
}

export function formatMapDisplayName(mapId: string): string {
  switch (mapId) {
    case 'pripyat_block':
      return 'Pripyat Block';
    case 'timberline_compound':
      return 'Timberline Valley';
    case 'korsakov_substation':
      return 'Korsakov Substation';
    case 'kino_theater':
      return 'Kino Theater';
    default:
      return mapId;
  }
}

export function formatLobbyModeLabel(mode: LobbyModeId, battleRule: BattleRuleId): string {
  if (mode === 'infection') return 'INFECTION';
  return battleRule === 'ffa' ? 'BATTLE · FFA' : 'BATTLE · TDM';
}

// === PHASE 4: 20 HZ MULTIPLAYER COMBAT SYNC PACKETS ===

export type OperatorUniformId = 'team_a' | 'team_b' | 'ffa' | 'infection';
export type SyncedAimStance = 'HIP' | 'ADS' | 'POINT_AIM' | 'CANTED_ADS';

export function resolveOperatorUniformId(
  mode: 'battle' | 'infection',
  team: 'A' | 'B' | 'FFA',
): OperatorUniformId {
  if (mode === 'infection') return 'infection';
  if (team === 'B') return 'team_b';
  if (team === 'FFA') return 'ffa';
  return 'team_a';
}

export interface GamePlayerStatePacket {
  type: 'game:state';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  sprint: boolean;
  ads: boolean;
  adsMode: 'PRIMARY' | 'POINT_AIM' | 'CANTED';
  aimStance: SyncedAimStance;
  isPointAim: boolean;
  isCanted: boolean;
  adsBlend: number; // 0..1
  pointAimBlend: number; // 0..1
  isFiring: boolean;
  isReloading: boolean;
  fireSeq: number;
  uniformId: OperatorUniformId;
  operatorId?: OperatorId;
  glovesEnabled?: boolean;
  gloveColor?: string;
  helmetType?: 'mich' | 'mil_tec';
  helmetColor?: string;
  nvgMount?: 'none' | 'pvs7' | 'arnvg';
  nvgFlipped?: boolean;
  lean: number; // -1..1
  weaponId: string;
  hp: number;
  maxHp: number;
  alive: boolean;
  kills: number;
  deaths: number;
  flashlightOn: boolean;
  laserOn: boolean;
  ts: number;
}

export interface GamePlayerFirePacket {
  type: 'game:fire';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  weaponId: string;
  weaponName: string;
  caliberId: string;
  suppressed: boolean;
  aimStance?: SyncedAimStance;
  adsMode?: 'PRIMARY' | 'POINT_AIM' | 'CANTED';
  shotSeq?: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  ts: number;
}

export interface GamePlayerHitPacket {
  type: 'game:hit';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  targetUserId: string;
  damage: number;
  hitZone: string;
  headshot: boolean;
  weaponId: string;
  weaponName: string;
  ts: number;
}

export interface GamePlayerKillPacket {
  type: 'game:kill';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  senderIsHost?: boolean;
  killerUserId: string;
  killerName: string;
  killerTeam: 'A' | 'B' | 'FFA';
  victimUserId: string;
  victimName: string;
  victimTeam: 'A' | 'B' | 'FFA';
  weaponId: string;
  weaponName: string;
  headshot: boolean;
  ts: number;
}

export interface GamePlayerRespawnPacket {
  type: 'game:respawn';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  uniformId?: OperatorUniformId;
  operatorId?: OperatorId;
  glovesEnabled?: boolean;
  gloveColor?: string;
  helmetType?: 'mich' | 'mil_tec';
  helmetColor?: string;
  nvgMount?: 'none' | 'pvs7' | 'arnvg';
  nvgFlipped?: boolean;
  ts: number;
}

// === PHASE 5: HOST-AUTHORITATIVE AI BOT, ZOMBIE & KINO MAP SYNC PACKETS (20 HZ) ===

export type BotWeaponVisualClass = 'pistol' | 'smg' | 'shotgun' | 'rifle';
export type SquadCommsCategory = 'threat' | 'economy' | 'status' | 'ack';

export interface SyncedBotState {
  id: string;
  name: string;
  team: 'A' | 'B' | 'FFA';
  uniformId: OperatorUniformId;
  operatorId?: OperatorId;
  weaponId?: string;
  weaponLabel?: string;
  weaponClass?: BotWeaponVisualClass;
  points?: number;
  reloading?: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  firing: boolean;
  crouch?: number;
  lean?: number;
  vaulting?: boolean;
  vaultProgress?: number;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
}

export interface GameBotsSyncPacket {
  type: 'game:bots_sync';
  senderUserId?: string;
  senderIsHost?: boolean;
  scoreA: number;
  scoreB: number;
  bots: SyncedBotState[];
  ts: number;
}

export interface GameBotFirePacket {
  type: 'game:bot_fire';
  senderUserId?: string;
  senderIsHost?: boolean;
  botId: string;
  ox: number;
  oy: number;
  oz: number;
  ex: number;
  ey: number;
  ez: number;
  ts: number;
}

export interface GameBotDamagePacket {
  type: 'game:bot_damage';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  botId: string;
  damage: number;
  hitZone: string;
  weaponId: string;
  weaponName: string;
  melee?: boolean;
  ts: number;
}

export interface GameBotHitPlayerPacket {
  type: 'game:bot_hit_player';
  senderUserId?: string;
  senderIsHost?: boolean;
  targetUserId: string;
  damage: number;
  botId: string;
  botName: string;
  botTeam: 'A' | 'B' | 'FFA';
  ts: number;
}

export interface SyncedZombieState {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  windup: boolean;
  stagger: boolean;
  enteringWindow: boolean;
  entryStage?: 'approach' | 'tear' | 'vault' | 'pursue';
  spawnerId: string | null;
  entryPos: [number, number, number] | null;
}

export interface GameZombieSpawnPacket {
  type: 'game:zombie_spawn';
  senderUserId?: string;
  senderIsHost?: boolean;
  zombieId: string;
  spawnerId: string;
  zoneId: string;
  maxHp: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  entryPos: [number, number, number];
  round: number;
  zombiesRemaining: number;
  ts: number;
}

export interface GameZombiesSyncPacket {
  type: 'game:zombies_sync';
  senderUserId?: string;
  senderIsHost?: boolean;
  round: number;
  zombiesRemaining: number;
  toSpawnThisRound: number;
  killedThisRound: number;
  totalThisRound: number;
  intermissionSec: number;
  roundBannerSec: number;
  powerOn: boolean;
  openedDoorIds: string[];
  unlockedZoneIds: string[];
  barriers?: Record<string, number>;
  zombies: SyncedZombieState[];
  ts: number;
}

export interface GameBarrierRepairRequestPacket {
  type: 'game:barrier_repair_request';
  senderUserId?: string;
  senderUsername?: string;
  barrierId: string;
  ts: number;
}

export interface GameBarrierUpdatePacket {
  type: 'game:barrier_update';
  senderUserId?: string;
  senderIsHost?: boolean;
  barrierId: string;
  planksRemaining: number;
  repairedByUserId?: string | null;
  pointsAwarded?: number;
  ts: number;
}

export interface GameZombieDamagePacket {
  type: 'game:zombie_damage';
  senderUserId?: string;
  senderUsername?: string;
  zombieId: string;
  damage: number;
  hitZone: string;
  melee: boolean;
  knockbackSpeed: number;
  px: number;
  py: number;
  pz: number;
  dx: number;
  dy: number;
  dz: number;
  weaponId: string;
  ts: number;
}

export interface GameZombieKilledPacket {
  type: 'game:zombie_killed';
  senderUserId?: string;
  senderIsHost?: boolean;
  zombieId: string;
  killerUserId: string;
  headshot: boolean;
  melee: boolean;
  pointsAwarded: number;
  weaponId: string;
  px: number;
  py: number;
  pz: number;
  ts: number;
}

export interface GameZombieHitPlayerPacket {
  type: 'game:zombie_hit_player';
  senderUserId?: string;
  senderIsHost?: boolean;
  targetUserId: string;
  damage: number;
  ts: number;
}

export interface GameRoundCompletePacket {
  type: 'game:round_complete';
  senderUserId?: string;
  senderIsHost?: boolean;
  completedRound: number;
  bonusPoints: number;
  ts: number;
}

export interface GameMapInteractRequestPacket {
  type: 'game:map_interact_request';
  senderUserId?: string;
  senderUsername?: string;
  requestId: string;
  kind: 'buyable_door' | 'power_switch';
  interactableId: string;
  cost: number;
  ts: number;
}

export interface GameMapInteractPacket {
  type: 'game:map_interact';
  senderUserId?: string;
  senderUsername?: string;
  senderIsHost?: boolean;
  kind: 'buyable_door' | 'power_switch';
  interactableId: string;
  unlockedZoneId?: string | null;
  activatedByUserId?: string;
  activatedByUsername?: string;
  requestId?: string | null;
  ts: number;
}

export interface GameMapInteractRejectedPacket {
  type: 'game:map_interact_rejected';
  senderUserId?: string;
  senderIsHost?: boolean;
  targetUserId: string;
  requestId: string;
  interactableId: string;
  refundPoints: number;
  reason: string;
  ts: number;
}

export interface GameMatchSyncPacket {
  type: 'game:match_sync';
  powerOn: boolean;
  openedDoorIds: string[];
  unlockedZoneIds: string[];
  round: number;
  zombiesRemaining: number;
  ts: number;
}

export type TacticalPingKind = 'location' | 'enemy' | 'item';
export type TacticalPingTargetType = 'bot' | 'zombie' | 'remote_player';

export interface GameTacticalPingPacket {
  type: 'game:ping';
  senderUserId?: string;
  senderUsername?: string;
  senderTeam?: LobbyTeamId;
  pingId: string;
  kind: TacticalPingKind;
  label: string;
  x: number;
  y: number;
  z: number;
  targetEntityType?: TacticalPingTargetType | null;
  targetEntityId?: string | null;
  ts: number;
}

export interface GameEnvSyncPacket {
  type: 'game:env_sync';
  senderUserId?: string;
  senderIsHost?: boolean;
  timeOfDayHours: number;
  currentWeather: ActiveWeatherConditionId;
  targetWeather: ActiveWeatherConditionId;
  transitionProgress: number; // 0..1
  weatherHoldRemainingSec: number;
  windDirRad: number;
  windSpeedMps: number;
  rainIntensity: number;
  wetness: number;
  lightningFlash: number;
  ts: number;
}

export interface GameGlassShatterPacket {
  type: 'game:glass_shatter';
  senderUserId?: string;
  breakableId: string;
  px: number;
  py: number;
  pz: number;
  ts: number;
}

export interface GameBotCommsPacket {
  type: 'game:bot_comms';
  senderUserId?: string;
  senderIsHost?: boolean;
  botId: string;
  callsign: string;
  team: 'A' | 'B' | 'FFA';
  category: SquadCommsCategory;
  text: string;
  pingKind?: TacticalPingKind | null;
  pingLabel?: string | null;
  px?: number;
  py?: number;
  pz?: number;
  ts: number;
}

export type GameSyncPacket =
  | GamePlayerStatePacket
  | GamePlayerFirePacket
  | GamePlayerHitPacket
  | GamePlayerKillPacket
  | GamePlayerRespawnPacket
  | GameBotsSyncPacket
  | GameBotFirePacket
  | GameBotDamagePacket
  | GameBotHitPlayerPacket
  | GameBotCommsPacket
  | GameZombieSpawnPacket
  | GameZombiesSyncPacket
  | GameBarrierRepairRequestPacket
  | GameBarrierUpdatePacket
  | GameZombieDamagePacket
  | GameZombieKilledPacket
  | GameZombieHitPlayerPacket
  | GameRoundCompletePacket
  | GameMapInteractRequestPacket
  | GameMapInteractPacket
  | GameMapInteractRejectedPacket
  | GameMatchSyncPacket
  | GameTacticalPingPacket
  | GameEnvSyncPacket
  | GameGlassShatterPacket;



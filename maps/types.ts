import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import { GraphicsQualityId } from '../data/graphicsQuality';
import { TacticalEquipmentId } from '../data/tacticalEquipment';

import type { TimeOfDayStartSetting, WeatherPresetId } from '../data/multiplayer';
import type { DestructibleDoorSystem } from '../doors/DestructibleDoorSystem';
import type { PenetrableSurfaceSystem } from '../doors/PenetrableSurfaceSystem';
import type { WaterShaderUniforms } from '../engine/world/WaterShader';
import type { NightLightEntry, WettableSurfaceEntry } from '../engine/world/WeatherTimeSystem';
import type { WindShaderUniforms } from '../engine/world/WindFoliageShader';

export type TopLevelModeId = 'playground' | 'battle' | 'infection';
export type BattleRuleId =
  | 'tdm'
  | 'ffa'
  | 'conquest'
  | 'ctf'
  | 'koth'
  | 'kc_tdm'
  | 'kc_ffa';
export type BotDifficultyId = 'recruit' | 'tactical' | 'veteran';

export const ALL_BATTLE_RULES: readonly BattleRuleId[] = [
  'tdm',
  'ffa',
  'conquest',
  'ctf',
  'koth',
  'kc_tdm',
  'kc_ffa',
];

export function isValidBattleRule(val: unknown): val is BattleRuleId {
  return (
    val === 'tdm' ||
    val === 'ffa' ||
    val === 'conquest' ||
    val === 'ctf' ||
    val === 'koth' ||
    val === 'kc_tdm' ||
    val === 'kc_ffa'
  );
}

/** True for all team-based Battle rules (Team A vs Team B); false for FFA / Kill Confirmed FFA */
export function isTeamBattleRule(rule: BattleRuleId): boolean {
  return rule !== 'ffa' && rule !== 'kc_ffa';
}

export function isFreeForAllBattleRule(rule: BattleRuleId): boolean {
  return rule === 'ffa' || rule === 'kc_ffa';
}

export function isKillConfirmedRule(rule: BattleRuleId): boolean {
  return rule === 'kc_tdm' || rule === 'kc_ffa';
}

export function formatBattleRuleName(rule: BattleRuleId): string {
  switch (rule) {
    case 'tdm':
      return 'Team Deathmatch';
    case 'ffa':
      return 'Free-For-All';
    case 'conquest':
      return 'Conquest';
    case 'ctf':
      return 'Capture the Flag';
    case 'koth':
      return 'King of the Hill';
    case 'kc_tdm':
      return 'Kill Confirmed (TDM)';
    case 'kc_ffa':
      return 'Kill Confirmed (FFA)';
  }
}

export function formatBattleRuleShort(rule: BattleRuleId): string {
  switch (rule) {
    case 'tdm':
      return 'TDM';
    case 'ffa':
      return 'FFA';
    case 'conquest':
      return 'CONQUEST';
    case 'ctf':
      return 'CTF';
    case 'koth':
      return 'KOTH';
    case 'kc_tdm':
      return 'KC · TDM';
    case 'kc_ffa':
      return 'KC · FFA';
  }
}

export function getDefaultScoreLimitForRule(rule: BattleRuleId): number {
  switch (rule) {
    case 'tdm':
      return 30;
    case 'ffa':
      return 20;
    case 'conquest':
      return 500;
    case 'ctf':
      return 3;
    case 'koth':
      return 150;
    case 'kc_tdm':
      return 30;
    case 'kc_ffa':
      return 20;
  }
}

export function getDefaultMatchDurationSecForRule(rule: BattleRuleId): number {
  switch (rule) {
    case 'conquest':
      return 480;
    case 'koth':
      return 420;
    case 'ctf':
      return 420;
    case 'kc_tdm':
    case 'kc_ffa':
    case 'tdm':
    case 'ffa':
      return 480;
  }
}

export interface BattleMatchConfig {
  mapId: string;
  rule: BattleRuleId;
  botCount: number;
  killLimit: number;
  /** Optional mode-specific score target (territory pts, flags, hill pts, or dogtags) */
  scoreLimit?: number;
  /** Optional match clock duration in seconds (used by Conquest & objective modes) */
  matchDurationSec?: number;
  difficulty: BotDifficultyId;
  primaryWeaponId: string;
  secondaryWeaponId: string;
  tacticalEquipmentId?: TacticalEquipmentId;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
  hitmarkersEnabled?: boolean;
  hudEnabled?: boolean;
}

export type ZombieDifficultyPresetId = 'standard' | 'hardcore' | 'nightmare' | 'custom';

export interface InfectionMatchConfig {
  mapId: string;
  botCount?: number;
  botDifficulty?: BotDifficultyId;
  tacticalEquipmentId?: TacticalEquipmentId;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
  difficultyPreset?: ZombieDifficultyPresetId;
  zombieHealthMult?: number;
  zombieMoveSpeedMult?: number;
  zombieAttackSpeedMult?: number;
  zombieSpawnAmountMult?: number;
  waveBreakIntervalSec?: number;
}

export interface NavNode {
  id: string;
  position: [number, number, number];
  /** Zone key; always 'default' in Battle maps, zone-gated in Infection maps */
  zoneId: string;
  neighbors: string[];
  /** Tactical cover node marker for BattleBotAI */
  isCover?: boolean;
  /** Outward cover normal (XZ) for peeking direction */
  coverNormal?: [number, number];
  /** Optional buyable door ID that gates traversing into this node */
  requiredDoorId?: string;
}

export interface NavGraph {
  nodes: NavNode[];
  byId: Map<string, NavNode>;
}

export interface SpawnPoint {
  position: [number, number, number];
  yaw: number;
  zoneId?: string;
}

export interface ZombieSpawnerDef {
  id: string;
  /** Active only when this zone is unlocked */
  zoneId: string;
  /** Deep hallway spawn position behind the barricaded window */
  spawnPos: [number, number, number];
  /** Stand position just outside the window jamb where zombie reaches to tear off planks */
  windowOuterPos?: [number, number, number];
  /** Window sill center (x, sillTopY, z) vaulted over once all barrier planks are removed */
  sillPos?: [number, number, number];
  /** First interior landing spot just inside the barricaded window */
  entryPos: [number, number, number];
  /** Unit normal pointing from spawn hallway into the interior room */
  windowNormal?: [number, number, number];
  /** Total planks guarding this window barrier (default 5) */
  maxPlanks?: number;
  entryNodeId: string;
  yaw: number;
}

export interface MapWindowBarrier {
  id: string;
  spawnerId: string;
  zoneId: string;
  label: string;
  interactPos: [number, number, number];
  sillPos: [number, number, number];
  windowOuterPos: [number, number, number];
  entryPos: [number, number, number];
  windowNormal: [number, number, number];
  maxPlanks: number;
  getPlanksRemaining: () => number;
  /** Tears off one plank (returns true if a plank was removed) */
  tearPlank: () => boolean;
  /** Replaces one plank (returns true if a plank was repaired) */
  repairPlank: () => boolean;
  /** Sets exact plank count (used for multiplayer sync or round reset) */
  setPlankCount: (count: number) => void;
}

export type MapInteractableKind =
  | 'buyable_door'
  | 'power_switch'
  | 'wall_buy'
  | 'mystery_crate'
  | 'perk_machine'
  | 'window_barrier';

export type InfectionPerkId = 'vitality' | 'rapid_handling';

export interface MapInteractable {
  id: string;
  kind: MapInteractableKind;
  label: string;
  cost: number;
  position: [number, number, number];
  radiusM: number;
  requiresPower?: boolean;
  /** Buyable door fields */
  colliderIds?: string[];
  unlocksZoneId?: string;
  visualGroup?: THREE.Object3D;
  /** Wall-buy / Perk fields */
  weaponId?: string;
  perkId?: InfectionPerkId;
  /** Window barrier link */
  barrierId?: string;
  activated: boolean;
}

export interface MapLightingPreset {
  backgroundHex: number;
  fogHex: number;
  fogDensity: number;
  envIntensity: number;
  hemiSkyHex: number;
  hemiGroundHex: number;
  hemiIntensity: number;
  keyLightHex: number;
  keyLightIntensity: number;
  keyLightPos: [number, number, number];
}

export interface MapEnvBindings {
  windUniforms?: WindShaderUniforms;
  waterUniforms?: WaterShaderUniforms;
  wettableSurfaces?: WettableSurfaceEntry[];
  nightLights?: NightLightEntry[];
}

export type ConquestPoiKind = 'fob' | 'outpost' | 'checkpoint';

export interface ConquestHqDef {
  id: string;
  team: 'A' | 'B';
  label: string;
  position: [number, number, number];
  safeRadiusM: number;
  spawnPoints: SpawnPoint[];
}

export interface ConquestPoiDef {
  id: string;
  code: string;
  label: string;
  kind: ConquestPoiKind;
  position: [number, number, number];
  captureRadiusM: number;
  /** Territory control weight earned per second while owned */
  territoryWeight: number;
  initialOwner?: 'A' | 'B' | null;
  /** Forward respawn pads (used by FOBs when friendly and uncontested) */
  spawnPoints?: SpawnPoint[];
  /** Road heading in radians for optional checkpoint barricade orientation */
  roadYaw?: number;
  /** True if map already built custom checkpoint barricades so mode prop factory only adds banner/ring */
  hasBuiltInProps?: boolean;
}

export interface CtfFlagAnchorDef {
  team: 'A' | 'B';
  label: string;
  position: [number, number, number];
}

export interface KothHillDef {
  id: string;
  label: string;
  position: [number, number, number];
  radiusM: number;
}

export interface MapBattleObjectives {
  hqA: ConquestHqDef;
  hqB: ConquestHqDef;
  conquestPois: ConquestPoiDef[];
  ctfFlags: [CtfFlagAnchorDef, CtfFlagAnchorDef];
  kothHills: KothHillDef[];
}

export interface BuiltMapInstance {
  id: string;
  name: string;
  sceneGroup: THREE.Group;
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  navGraph: NavGraph;
  spawnPoints: {
    ffa: SpawnPoint[];
    teamA: SpawnPoint[];
    teamB: SpawnPoint[];
    playerStart: SpawnPoint;
    zombieSpawners: ZombieSpawnerDef[];
  };
  /** Battle objective layouts for Conquest, CTF, and King of the Hill */
  battleObjectives?: MapBattleObjectives;
  /** Optional terrain height sampler for rolling outdoor maps */
  terrainHeightAt?: (x: number, z: number) => number;
  /** Interactive barricaded zombie windows */
  windowBarriers?: MapWindowBarrier[];
  interactables: MapInteractable[];
  lightingPreset: MapLightingPreset;
  /** True for outdoor daytime/twilight maps that receive dynamic 24h sun/moon & weather */
  supportsDynamicWeatherTime?: boolean;
  /** Optional shared wind/water/wetness/night-light hooks bound by WeatherTimeSystem */
  envBindings?: MapEnvBindings;
  /** Optional physical destructible hinged door system for combat maps */
  doorSystem?: DestructibleDoorSystem;
  /** Optional melee-penetrable interior drywall / plywood / panel system */
  penetrableSystem?: PenetrableSurfaceSystem;
  /** Shatters a breakable glass pane/window and disables its paired physics collider */
  shatterBreakable?: (
    objOrId: THREE.Object3D | string,
    impactPoint?: Readonly<THREE.Vector3>,
  ) => { breakableId: string; impactPoint: THREE.Vector3 } | null;
  setPowerState?: (powered: boolean) => void;
  update?: (dt: number, elapsedSec: number) => void;
  dispose: () => void;
}

export interface IMapDefinition {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  mode: TopLevelModeId;
  status: 'playable' | 'coming_soon';
  environmentTags: string[];
  accentHex: string;
  previewStyle:
    | 'cqb_pripyat'
    | 'forest_compound'
    | 'korsakov_substation'
    | 'volga_corridor'
    | 'kino_theater'
    | 'stalingrad_depot'
    | 'objekt_47'
    | 'locked_depot'
    | 'locked_bunker';
  build: (
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    isSoftwareGl: boolean,
    graphicsQuality?: GraphicsQualityId,
  ) => BuiltMapInstance;
}

export function buildNavGraph(nodes: NavNode[]): NavGraph {
  const byId = new Map<string, NavNode>();
  for (const n of nodes) {
    byId.set(n.id, n);
  }
  // Enforce bidirectional neighbor consistency so AI never gets trapped on one-way edges
  for (const n of nodes) {
    for (const nbId of n.neighbors) {
      const nb = byId.get(nbId);
      if (nb && !nb.neighbors.includes(n.id)) {
        nb.neighbors.push(n.id);
      }
    }
  }
  return { nodes, byId };
}

export function findNearestNavNode(
  graph: NavGraph,
  pos: Readonly<THREE.Vector3>,
  allowedZones?: ReadonlySet<string>,
  openedDoors?: ReadonlySet<string>,
): NavNode | null {
  let best: NavNode | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    if (allowedZones && !allowedZones.has(n.zoneId)) continue;
    if (n.requiredDoorId && openedDoors && !openedDoors.has(n.requiredDoorId)) continue;
    const dx = n.position[0] - pos.x;
    const dy = (n.position[1] - pos.y) * 1.8;
    const dz = n.position[2] - pos.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = n;
    }
  }
  return best;
}

/**
 * Lightweight A* pathfinder over NavGraph supporting optional zone & buyable-door gating.
 * Returns ordered list of NavNodes from start to goal (inclusive).
 */
export function findNavPath(
  graph: NavGraph,
  startId: string,
  goalId: string,
  allowedZones?: ReadonlySet<string>,
  openedDoors?: ReadonlySet<string>,
): NavNode[] {
  const start = graph.byId.get(startId);
  const goal = graph.byId.get(goalId);
  if (!start || !goal) return [];
  if (startId === goalId) return [goal];

  const open: string[] = [startId];
  const openSet = new Set<string>([startId]);
  const closed = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startId, 0]]);
  const fScore = new Map<string, number>([[startId, distBetweenNodes(start, goal)]]);

  while (open.length > 0) {
    let bestIdx = 0;
    let bestF = fScore.get(open[0]) ?? Infinity;
    for (let i = 1; i < open.length; i++) {
      const f = fScore.get(open[i]) ?? Infinity;
      if (f < bestF) {
        bestF = f;
        bestIdx = i;
      }
    }

    const currentId = open[bestIdx];
    if (currentId === goalId) {
      const path: NavNode[] = [];
      let cur: string | undefined = currentId;
      while (cur) {
        const node = graph.byId.get(cur);
        if (node) path.push(node);
        cur = cameFrom.get(cur);
      }
      path.reverse();
      return path;
    }

    open.splice(bestIdx, 1);
    openSet.delete(currentId);
    closed.add(currentId);

    const current = graph.byId.get(currentId);
    if (!current) continue;
    const curG = gScore.get(currentId) ?? Infinity;

    for (let i = 0; i < current.neighbors.length; i++) {
      const nbId = current.neighbors[i];
      if (closed.has(nbId)) continue;
      const nb = graph.byId.get(nbId);
      if (!nb) continue;
      if (allowedZones && !allowedZones.has(nb.zoneId)) continue;
      if (nb.requiredDoorId && openedDoors && !openedDoors.has(nb.requiredDoorId)) continue;

      const tentativeG = curG + distBetweenNodes(current, nb);
      if (tentativeG < (gScore.get(nbId) ?? Infinity)) {
        cameFrom.set(nbId, currentId);
        gScore.set(nbId, tentativeG);
        fScore.set(nbId, tentativeG + distBetweenNodes(nb, goal));
        if (!openSet.has(nbId)) {
          open.push(nbId);
          openSet.add(nbId);
        }
      }
    }
  }

  return [];
}

function distBetweenNodes(a: NavNode, b: NavNode): number {
  const dx = a.position[0] - b.position[0];
  const dy = a.position[1] - b.position[1];
  const dz = a.position[2] - b.position[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

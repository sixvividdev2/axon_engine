import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import { TacticalEquipmentId } from '../data/tacticalEquipment';

export type TopLevelModeId = 'playground' | 'battle' | 'infection';
export type BattleRuleId = 'tdm' | 'ffa';
export type BotDifficultyId = 'recruit' | 'tactical' | 'veteran';

export interface BattleMatchConfig {
  mapId: string;
  rule: BattleRuleId;
  botCount: number;
  killLimit: number;
  difficulty: BotDifficultyId;
  primaryWeaponId: string;
  secondaryWeaponId: string;
  tacticalEquipmentId?: TacticalEquipmentId;
}

export interface InfectionMatchConfig {
  mapId: string;
  tacticalEquipmentId?: TacticalEquipmentId;
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
  spawnPos: [number, number, number];
  /** First interior nav node just inside the barricaded window */
  entryPos: [number, number, number];
  entryNodeId: string;
  yaw: number;
}

export type MapInteractableKind =
  | 'buyable_door'
  | 'power_switch'
  | 'wall_buy'
  | 'mystery_crate'
  | 'perk_machine';

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
  /** Optional terrain height sampler for rolling outdoor maps */
  terrainHeightAt?: (x: number, z: number) => number;
  interactables: MapInteractable[];
  lightingPreset: MapLightingPreset;
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
  previewStyle: 'cqb_pripyat' | 'forest_compound' | 'kino_theater' | 'locked_depot' | 'locked_bunker';
  build: (
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    isSoftwareGl: boolean,
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

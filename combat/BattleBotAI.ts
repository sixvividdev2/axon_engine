import * as THREE from 'three';
import {
  ActiveSmokeCloudInfo,
  ArticulatedRagdoll,
  BodycamAudio,
  IBodycamWorldAdapter,
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
import {
  BotDifficultyId,
  BattleRuleId,
  BuiltMapInstance,
  findNavPath,
  findNearestNavNode,
  NavNode,
  SpawnPoint,
} from '../maps/types';
import {
  GameBotsSyncPacket,
  OperatorUniformId,
  resolveOperatorUniformId,
  SyncedBotState,
} from '../data/multiplayer';
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
  kills: number;
  deaths: number;
  alive: boolean;
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
}

export interface BotPlayerDamageEvent {
  targetUserId: string;
  damage: number;
  attackerPos: THREE.Vector3;
  attackerName: string;
  attackerId: string;
  attackerTeam: BattleTeamId;
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

interface BotActor {
  id: string;
  name: string;
  team: BattleTeamId;
  uniformId: OperatorUniformId;
  operatorId: OperatorId;
  weaponLabel: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
  respawnTimer: number;
  deathTimer: number;

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
  private readonly worldAdapter: IBodycamWorldAdapter | null;
  private readonly vaultDetector = new VaultDetector();
  private readonly _vaultCandidate: VaultCandidate = createVaultCandidate();
  private isClientReplica: boolean;

  // Zone/door gating for friendly Infection bots
  private readonly unlockedZones = new Set<string>(['lobby', 'default']);
  private readonly openedDoors = new Set<string>();

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
    this.worldAdapter = tuning?.worldAdapter ?? map.physics.createAdapter();
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
      let weaponLabel = i % 2 === 0 ? 'AKM 7.62' : 'M4A1 5.56';
      let operatorId: OperatorId;

      if (this.coopInfectionMode) {
        // Always friendly Team A squadmates in Infection mode; alternating Female/Male mix
        team = 'A';
        const isFemale = startFemalePolarity ? i % 2 === 0 : i % 2 === 1;
        operatorId = isFemale ? 'FEMALE' : 'MALE';
        name = isFemale
          ? FEMALE_CALLSIGNS_A[femaleCountA++ % FEMALE_CALLSIGNS_A.length]
          : MALE_CALLSIGNS_A[maleCountA++ % MALE_CALLSIGNS_A.length];
        weaponLabel = i % 2 === 0 ? 'M4A1 5.56' : 'HK416 5.56';
        countA++;
      } else if (rule === 'tdm') {
        // Player occupies 1 slot on Team A -> put slightly more bots on Team B so totals stay even
        const teamATotalWithPlayer = countA + 1;
        if (teamATotalWithPlayer <= countB) {
          team = 'A';
          const isFemale = countA % 2 === 0;
          operatorId = isFemale ? 'FEMALE' : 'MALE';
          name = isFemale
            ? FEMALE_CALLSIGNS_A[femaleCountA++ % FEMALE_CALLSIGNS_A.length]
            : MALE_CALLSIGNS_A[maleCountA++ % MALE_CALLSIGNS_A.length];
          weaponLabel = countA % 2 === 0 ? 'M4A1 5.56' : 'HK416 5.56';
          countA++;
        } else {
          team = 'B';
          const isFemale = countB % 2 === 1;
          operatorId = isFemale ? 'FEMALE' : 'MALE';
          name = isFemale
            ? FEMALE_CALLSIGNS_B[femaleCountB++ % FEMALE_CALLSIGNS_B.length]
            : MALE_CALLSIGNS_B[maleCountB++ % MALE_CALLSIGNS_B.length];
          weaponLabel = countB % 2 === 0 ? 'AKM 7.62' : 'AKS-74U';
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
      this.group.add(rig.root);

      const bot: BotActor = {
        id,
        name,
        team,
        uniformId,
        operatorId,
        weaponLabel,
        alive: true,
        hp: this.aiMaxHp,
        maxHp: this.aiMaxHp,
        kills: 0,
        deaths: 0,
        respawnTimer: 0,
        deathTimer: 0,
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

  private pickSpawnPoint(team: BattleTeamId, avoidPos: Readonly<THREE.Vector3>, seedIdx?: number): SpawnPoint {
    const pool =
      this.rule === 'tdm'
        ? team === 'A'
          ? this.map.spawnPoints.teamA
          : this.map.spawnPoints.teamB
        : this.map.spawnPoints.ffa;

    const list = pool.length > 0 ? pool : this.map.spawnPoints.ffa;
    if (seedIdx !== undefined && seedIdx < list.length) {
      return list[seedIdx];
    }

    // Choose spawn farthest from hostile actors & player
    let best = list[0];
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      let minHostileDistSq = Infinity;

      // Distance from player (hostile in FFA or if bot is Team B)
      if (this.rule === 'ffa' || team === 'B') {
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
        const isHostile = this.rule === 'ffa' || other.team !== team;
        if (isHostile) {
          minHostileDistSq = Math.min(minHostileDistSq, dSq);
        } else if (dSq < 2.25) {
          // Avoid spawning stacked directly on a teammate
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

    bot.ragdoll.deactivate();
    bot.rig.resetRagdollPose();
    bot.root.visible = true;
    bot.root.position.copy(bot.pos);
    bot.root.quaternion.identity();
    bot.root.rotation.set(0, bot.yaw, 0);
    bot.muzzleFlash.visible = false;
    this.rebuildActiveHitMeshes();
  }

  public resetMatch(playerPos: Readonly<THREE.Vector3>): void {
    this.scoreA = 0;
    this.scoreB = 0;
    this.killfeed.length = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      b.kills = 0;
      b.deaths = 0;
      this.spawnBot(b, playerPos, i);
    }
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
    this.group.remove(bot.root);
    const rig = this.rigFactory.buildOperator('bot', bot.id, bot.uniformId, nextOperatorId);
    rig.root.position.copy(bot.pos);
    rig.root.rotation.set(0, bot.yaw, 0);
    rig.root.visible = wasVisible;
    this.group.add(rig.root);

    bot.operatorId = nextOperatorId;
    bot.rig = rig;
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
    if (bot.hp <= 0) {
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
    const bots: SyncedBotState[] = this.bots.map((b) => ({
      id: b.id,
      name: b.name,
      team: b.team,
      uniformId: b.uniformId,
      operatorId: b.operatorId,
      x: Number(b.pos.x.toFixed(3)),
      y: Number(b.pos.y.toFixed(3)),
      z: Number(b.pos.z.toFixed(3)),
      yaw: Number(b.yaw.toFixed(4)),
      alive: b.alive,
      hp: Math.round(b.hp),
      maxHp: b.maxHp,
      kills: b.kills,
      deaths: b.deaths,
      firing: b.muzzleFlashTimer > 0 || b.burstShotsLeft > 0,
      crouch: Number(b.crouchBlend.toFixed(2)),
      lean: Number(b.leanBlend.toFixed(2)),
      vaulting: b.vaultActive,
      vaultProgress: b.vaultActive ? Number(b.vaultT.toFixed(2)) : 0,
    }));
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

      const wasAlive = bot.alive;
      bot.alive = sb.alive;
      bot.hp = sb.hp;
      bot.maxHp = sb.maxHp || bot.maxHp;
      bot.kills = sb.kills;
      bot.deaths = sb.deaths;
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

  public playRemoteBotFire(botId: string, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number): void {
    const bot = this.bots.find((b) => b.id === botId);
    if (bot && bot.alive) {
      bot.muzzleFlash.visible = true;
      bot.muzzleFlashTimer = 0.055;
      bot.firingVisualTimer = 0.16;
      bot.recoilKick = Math.min(1, bot.recoilKick + 0.85);
    }
    this._tmpMuzzle.set(ox, oy, oz);
    this._tmpOrigin.set(ex, ey, ez);
    this.spawnTracer(this._tmpMuzzle, this._tmpOrigin);
    this.audio.playWeaponCue('fire', {
      position: this._tmpMuzzle,
      weightClass: 'carbine',
      caliberId: '556x45',
      suppressed: false,
      intensity: 0.72,
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
  ): BotDamageResult {
    const bot = this.bots.find((b) => b.id === botId);
    if (!bot || !bot.alive) {
      return { hit: false, botId, botName: '', killed: false, headshot: false, friendlyIgnored: false };
    }
    const resolvedTeam: BattleTeamId = attackerTeam ?? (this.rule === 'tdm' ? 'A' : 'FFA');
    if (this.coopInfectionMode || (this.rule === 'tdm' && bot.team === resolvedTeam)) {
      return {
        hit: false,
        botId: bot.id,
        botName: bot.name,
        killed: false,
        headshot: false,
        friendlyIgnored: true,
      };
    }

    const headshot = hitZone === 'head';
    const mult = headshot ? 2.4 : hitZone === 'limb' ? 0.72 : 1.0;
    const dmg = Math.max(8, baseDamage * mult);
    bot.hp -= dmg;
    bot.flinchTimer = 0.16;

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
      };
    }

    this.killBot(bot, attackerName, resolvedTeam, headshot, weaponLabel);
    return {
      hit: true,
      botId: bot.id,
      botName: bot.name,
      killed: true,
      headshot,
      friendlyIgnored: false,
    };
  }

  private killBot(
    victim: BotActor,
    killerName: string,
    killerTeam: BattleTeamId,
    headshot: boolean,
    weaponLabel: string,
    killerBot?: BotActor,
  ): void {
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

    if (killerBot) {
      killerBot.kills += 1;
    }
    if (this.rule === 'tdm') {
      if (killerTeam === 'A') this.scoreA += 1;
      else if (killerTeam === 'B') this.scoreB += 1;
    }

    this.pushKillfeed({
      id: this.nextKillfeedId++,
      killerName,
      killerTeam,
      victimName: victim.name,
      victimTeam: victim.team,
      headshot,
      weaponLabel,
      timestampMs: performance.now(),
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
  ): { hits: number; kills: number; killedBotIds: string[] } {
    if (this.isClientReplica || kind === 'smoke') {
      return { hits: 0, kills: 0, killedBotIds: [] };
    }
    let hits = 0;
    let kills = 0;
    const killedBotIds: string[] = [];

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
        bot.hp -= fragDmg;
        bot.flinchTimer = Math.max(bot.flinchTimer, 0.34);
        if (bot.hp <= 0) {
          this.killBot(bot, attackerName, attackerTeam, false, weaponLabel);
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
          bot.hp -= Math.round(maxDamage * falloff);
          if (bot.hp <= 0) {
            this.killBot(bot, attackerName, attackerTeam, false, weaponLabel);
            kills += 1;
            killedBotIds.push(bot.id);
          }
        }
        continue;
      }

      const dmg = Math.max(6, maxDamage * Math.pow(falloff, kind === 'frag' ? 1.15 : 0.85));
      bot.hp -= dmg;
      bot.flinchTimer = Math.max(bot.flinchTimer, kind === 'frag' ? 0.32 : 0.16);

      if (bot.hp <= 0) {
        this.killBot(bot, attackerName, attackerTeam, false, weaponLabel);
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

    return { hits, kills, killedBotIds };
  }

  public recordPlayerDeath(attackerName: string, attackerTeam: BattleTeamId, attackerId?: string): void {
    const killerBot = attackerId ? this.bots.find((b) => b.id === attackerId) : undefined;
    if (killerBot) {
      killerBot.kills += 1;
    }
    if (this.rule === 'tdm' && attackerTeam === 'B') {
      this.scoreB += 1;
    }
    this.pushKillfeed({
      id: this.nextKillfeedId++,
      killerName: attackerName,
      killerTeam: attackerTeam,
      victimName: 'YOU',
      victimTeam: this.rule === 'tdm' ? 'A' : 'FFA',
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

  public getScoreboard(playerKills: number, playerDeaths: number, playerAlive: boolean): BattleScoreEntry[] {
    const rows: BattleScoreEntry[] = [
      {
        id: 'player',
        name: 'YOU',
        team: this.rule === 'tdm' ? 'A' : 'FFA',
        isPlayer: true,
        kills: playerKills,
        deaths: playerDeaths,
        alive: playerAlive,
      },
      ...this.bots.map((b) => ({
        id: b.id,
        name: b.name,
        team: b.team,
        isPlayer: false,
        kills: b.kills,
        deaths: b.deaths,
        alive: b.alive,
      })),
    ];

    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
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
    this._tmpDir.subVectors(to, from);
    const dist = this._tmpDir.length();
    if (dist < 0.2) return true;
    this._tmpDir.divideScalar(dist);

    this._raycaster.set(from, this._tmpDir);
    this._raycaster.near = 0.15;
    this._raycaster.far = dist - 0.25;
    const hits = this._raycaster.intersectObjects(this.map.raycastMeshes, false);
    return hits.length === 0;
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
    if (this.rule === 'ffa') return true;
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

  public update(
    dt: number,
    playerPos: Readonly<THREE.Vector3>,
    playerAlive: boolean,
    matchActive: boolean,
    onDamagePlayer: (ev: BotPlayerDamageEvent) => void,
    humanTargets?: BattleHumanTarget[],
    onBotFire?: (botId: string, origin: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>) => void,
    isLineBlockedBySmoke?: (a: Readonly<THREE.Vector3>, b: Readonly<THREE.Vector3>) => boolean,
    getActiveSmokeClouds?: () => readonly ActiveSmokeCloudInfo[],
    zombieTargets?: ReadonlyArray<BattleZombieTarget>,
    onHitZombie?: (ev: BotZombieHitEvent) => void,
  ): void {
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
        pose.reloadBlend = 0;
        pose.speedMps = speedHoriz;
        pose.walkCycle = bot.walkCycle;
        pose.sprint = speedHoriz > 3.5;
        pose.recoilKick = bot.recoilKick;
        pose.firingVibration = isAimingFire ? Math.sin(performance.now() * 0.055) * 0.014 : 0;
        pose.flinchPitch = flinchPitch;
        pose.vaultBlend = bot.netVaulting ? 1 : 0;
        pose.vaultProgress = bot.netVaultProgress;
        pose.vaultKind = 'VAULT_OVER';

        bot.bodyPivot.rotation.set(0, 0, 0);
        bot.bodyPivot.position.set(0, 0, 0);
        bot.rig.applyCombatPose(pose);
        bot.root.position.copy(bot.pos);
        bot.root.rotation.set(0, bot.yaw, 0);
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
              team: this.coopInfectionMode || this.rule === 'tdm' ? 'A' : 'FFA',
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

        if (this.aiRespawnEnabled) {
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
      bot.recoilKick = Math.max(0, bot.recoilKick - dt * 7.2);

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

        bot.bodyPivot.rotation.set(0, 0, 0);
        bot.bodyPivot.position.set(0, 0, 0);
        bot.rig.applyCombatPose(pose);
        bot.root.position.copy(bot.pos);
        bot.root.rotation.set(0, bot.yaw, 0);

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
        bot.losTimer = 0.14 + Math.random() * 0.06;
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
        } else {
          bot.hasLos = false;
          if (blockedBySmoke || this.coopInfectionMode || Math.random() < 0.25) {
            bot.targetId = null;
            bot.burstShotsLeft = 0;
          }
        }
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

        // 3. Burst-Fire Engagement
        if (bot.stunTimer > 0) {
          bot.stunTimer = Math.max(0, bot.stunTimer - dt);
          bot.burstShotsLeft = 0;
          moveX *= 0.25;
          moveZ *= 0.25;
        } else if (bot.reactionTimer > 0) {
          bot.reactionTimer -= dt;
        } else {
          if (bot.burstShotsLeft <= 0) {
            bot.burstCooldown -= dt;
            if (bot.burstCooldown <= 0) {
              bot.burstShotsLeft =
                this.diff.burstMin +
                Math.floor(Math.random() * (this.diff.burstMax - this.diff.burstMin + 1));
              bot.fireTimer = 0;
            }
          }

          if (bot.burstShotsLeft > 0) {
            bot.fireTimer -= dt;
            if (bot.fireTimer <= 0) {
              bot.fireTimer = this.diff.fireIntervalSec;
              bot.burstShotsLeft -= 1;
              if (bot.burstShotsLeft <= 0) {
                bot.burstCooldown = this.diff.burstPauseSec * (0.75 + Math.random() * 0.45);
              }
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
            }
          }
        }
      } else {
        if (bot.stunTimer > 0) {
          bot.stunTimer = Math.max(0, bot.stunTimer - dt);
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
              } else {
                const nodes = this.map.navGraph.nodes;
                if (Math.random() < 0.58) {
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

      const isAimingFire = (bot.hasLos || bot.firingVisualTimer > 0) && bot.stunTimer <= 0;
      const flinchPitch =
        bot.stunTimer > 0
          ? -0.22 + Math.sin(performance.now() * 0.018) * 0.1
          : bot.flinchTimer > 0
            ? Math.sin(bot.flinchTimer * 35) * 0.16
            : 0;
      let aimPitch = 0;
      if (bot.hasLos && targetPos) {
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
      pose.reloadBlend = 0;
      pose.speedMps = speedHoriz;
      pose.walkCycle = bot.walkCycle;
      pose.sprint = !bot.hasLos && bot.crouchBlend < 0.25 && speedHoriz > 3.1;
      pose.recoilKick = bot.recoilKick;
      pose.firingVibration = bot.firingVisualTimer > 0 ? Math.sin(performance.now() * 0.055) * 0.014 : 0;
      pose.flinchPitch = flinchPitch;
      pose.vaultBlend = 0;
      pose.vaultProgress = 0;
      pose.vaultKind = 'VAULT_OVER';

      bot.bodyPivot.rotation.set(0, 0, 0);
      bot.bodyPivot.position.set(0, 0, 0);
      bot.rig.applyCombatPose(pose);
      bot.root.position.copy(bot.pos);
      bot.root.rotation.set(0, bot.yaw, 0);
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
    onBotFire?: (botId: string, origin: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>) => void,
    onHitZombie?: (ev: BotZombieHitEvent) => void,
  ): void {
    shooter.muzzleFlash.visible = true;
    shooter.muzzleFlashTimer = 0.055;
    shooter.firingVisualTimer = 0.16;
    shooter.recoilKick = Math.min(1, shooter.recoilKick + 0.85);
    shooter.muzzleFlash.getWorldPosition(this._tmpMuzzle);

    this._tmpDir.subVectors(targetPos, this._tmpMuzzle);
    const dist = Math.max(0.5, this._tmpDir.length());
    this._tmpDir.divideScalar(dist);

    const spread = this.diff.spreadRad * (1 - shooter.crouchBlend * 0.18);
    this._tmpDir.x += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.y += (Math.random() - 0.5) * spread * 1.5;
    this._tmpDir.z += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.normalize();

    const endPos = this._tmpOrigin.copy(this._tmpMuzzle).addScaledVector(this._tmpDir, Math.min(dist + 4, 48));
    this.spawnTracer(this._tmpMuzzle, endPos);
    onBotFire?.(shooter.id, this._tmpMuzzle, endPos);

    this.audio.playWeaponCue('fire', {
      position: this._tmpMuzzle,
      weightClass: 'carbine',
      caliberId: '556x45',
      suppressed: false,
      intensity: 0.72,
    });

    this._tmpToTarget.subVectors(targetPos, this._tmpMuzzle).normalize();
    const cosErr = THREE.MathUtils.clamp(this._tmpToTarget.dot(this._tmpDir), -1, 1);
    const angErr = Math.acos(cosErr);
    const hitAngleLimit = Math.atan2(targetZombie ? 0.56 : 0.46, Math.max(2.5, dist));

    if (angErr <= hitAngleLimit) {
      if (targetZombie && onHitZombie) {
        const hs = Math.random() < 0.24;
        onHitZombie({
          zombieId: targetZombie.id,
          damage: this.diff.damagePerShot * 1.9,
          hitZone: hs ? 'head' : 'thorax',
          impactPoint: targetPos.clone(),
          impactDir: this._tmpDir.clone(),
          shooterId: shooter.id,
          shooterName: shooter.name,
        });
      } else if (targetBot) {
        const hs = Math.random() < 0.16;
        targetBot.hp -= this.diff.damagePerShot * (hs ? 2.0 : 1.0);
        targetBot.flinchTimer = 0.14;
        if (targetBot.hp <= 0) {
          this.killBot(targetBot, shooter.name, shooter.team, hs, shooter.weaponLabel, shooter);
        }
      } else if (targetHuman && !this.coopInfectionMode) {
        onDamagePlayer({
          targetUserId: targetHuman.id,
          damage: this.diff.damagePerShot,
          attackerPos: shooter.pos.clone(),
          attackerName: shooter.name,
          attackerId: shooter.id,
          attackerTeam: shooter.team,
        });
      }
    }
  }

  public dispose(): void {
    this.group.parent?.remove(this.group);
    this.rigFactory.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

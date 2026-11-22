import * as THREE from 'three';
import { ArticulatedRagdoll, BodycamAudio } from '../bodycam-sdk';
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

export interface BattleBotTuningOptions {
  aiHealth?: number;
  aiAccuracyMult?: number;
  aiMoveSpeedMult?: number;
  aiRespawnEnabled?: boolean;
  isClientReplica?: boolean;
  maxAnisotropy?: number;
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

const CALLSIGNS_A = ['ALPHA-1', 'VALKYRIE', 'KESTREL', 'SIERRA', 'NOMAD', 'ATHENA'];
const CALLSIGNS_B = ['LYNX', 'VOLK-2', 'NOVA', 'GRANIT', 'IRIS', 'BERKUT'];
const CALLSIGNS_FFA = [
  'SPECTRE',
  'VALKYRIE',
  'VOLK',
  'SIERRA',
  'NOMAD',
  'LYNX',
  'BISHOP',
  'ATHENA',
  'FALCON',
  'NOVA',
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
  hasNetState: boolean;
  firingVisualTimer: number;
  recoilKick: number;

  // Navigation
  path: NavNode[];
  pathIndex: number;
  repathTimer: number;
  goalNodeId: string | null;

  // Combat AI
  targetId: string | null; // 'player' or another bot.id
  hasLos: boolean;
  losTimer: number;
  reactionTimer: number;
  strafeDir: number;
  strafeTimer: number;
  burstShotsLeft: number;
  fireTimer: number;
  burstCooldown: number;
  muzzleFlashTimer: number;

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
  private isClientReplica: boolean;

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
    const baseDiff = DIFFICULTY_TABLE[difficulty];
    const accMult = Math.max(0.25, Math.min(2.5, tuning?.aiAccuracyMult ?? 1.0));
    const spdMult = Math.max(0.5, Math.min(2.0, tuning?.aiMoveSpeedMult ?? 1.0));
    this.diff = {
      ...baseDiff,
      spreadRad: baseDiff.spreadRad / accMult,
      reactionSec: baseDiff.reactionSec / Math.sqrt(accMult),
      moveSpeed: baseDiff.moveSpeed * spdMult,
    };
    this.aiMaxHp = Math.max(25, Math.min(400, Math.round(tuning?.aiHealth ?? 100)));
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

    // Spawn bots balanced across teams (Player is on Team A in TDM; 0 = Players Only)
    const clampedCount = Math.max(0, Math.min(10, botCount));
    let countA = 0;
    let countB = 0;

    for (let i = 0; i < clampedCount; i++) {
      let team: BattleTeamId = 'FFA';
      let name = CALLSIGNS_FFA[i % CALLSIGNS_FFA.length];
      let weaponLabel = i % 2 === 0 ? 'AKM 7.62' : 'M4A1 5.56';
      let operatorId: OperatorId = i % 2 === 0 ? 'MALE' : 'FEMALE';

      if (rule === 'tdm') {
        // Player occupies 1 slot on Team A -> put slightly more bots on Team B so totals stay even
        const teamATotalWithPlayer = countA + 1;
        if (teamATotalWithPlayer <= countB) {
          team = 'A';
          name = CALLSIGNS_A[countA % CALLSIGNS_A.length];
          weaponLabel = countA % 2 === 0 ? 'M4A1 5.56' : 'HK416 5.56';
          operatorId = countA % 2 === 0 ? 'MALE' : 'FEMALE';
          countA++;
        } else {
          team = 'B';
          name = CALLSIGNS_B[countB % CALLSIGNS_B.length];
          weaponLabel = countB % 2 === 0 ? 'AKM 7.62' : 'AKS-74U';
          operatorId = countB % 2 === 0 ? 'FEMALE' : 'MALE';
          countB++;
        }
      }

      const id = `bot_${i}`;
      const uniformId = resolveOperatorUniformId('battle', team);
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
        hasNetState: false,
        firingVisualTimer: 0,
        recoilKick: 0,
        path: [],
        pathIndex: 0,
        repathTimer: Math.random() * 0.6,
        goalNodeId: null,
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
        sb.uniformId ?? resolveOperatorUniformId('battle', sb.team);
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
    if (this.rule === 'tdm' && bot.team === resolvedTeam) {
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

  private hasLineOfSight(from: Readonly<THREE.Vector3>, to: Readonly<THREE.Vector3>): boolean {
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
    if (this.rule === 'ffa') return true;
    return aTeam !== bTeam;
  }

  public update(
    dt: number,
    playerPos: Readonly<THREE.Vector3>,
    playerAlive: boolean,
    matchActive: boolean,
    onDamagePlayer: (ev: BotPlayerDamageEvent) => void,
    humanTargets?: BattleHumanTarget[],
    onBotFire?: (botId: string, origin: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>) => void,
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
        if (bot.flinchTimer > 0) {
          bot.flinchTimer = Math.max(0, bot.flinchTimer - dt);
        }
        if (bot.firingVisualTimer > 0) {
          bot.firingVisualTimer = Math.max(0, bot.firingVisualTimer - dt);
        }
        bot.recoilKick = Math.max(0, bot.recoilKick - dt * 7.2);

        const prevX = bot.pos.x;
        const prevZ = bot.pos.z;
        bot.pos.lerp(bot.netPos, posAlpha);
        const speedHoriz = Math.hypot(bot.pos.x - prevX, bot.pos.z - prevZ) / Math.max(0.001, dt);

        let yawDelta = bot.netYaw - bot.yaw;
        while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        bot.yaw += yawDelta * rotAlpha;

        if (speedHoriz > 0.2) {
          bot.walkCycle += dt * speedHoriz * 2.55;
        }

        const isAimingFire = bot.firingVisualTimer > 0;
        const flinchPitch = bot.flinchTimer > 0 ? Math.sin(bot.flinchTimer * 35) * 0.16 : 0;
        const pose = this._poseScratch;
        pose.crouchBlend = 0;
        pose.leanBlend = 0;
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
              team: this.rule === 'tdm' ? 'A' : 'FFA',
              pos: playerPos as THREE.Vector3,
              alive: playerAlive,
            },
          ];

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

      // Muzzle flash timer
      if (bot.muzzleFlashTimer > 0) {
        bot.muzzleFlashTimer -= dt;
        if (bot.muzzleFlashTimer <= 0) {
          bot.muzzleFlash.visible = false;
        }
      }

      if (bot.flinchTimer > 0) {
        bot.flinchTimer = Math.max(0, bot.flinchTimer - dt);
      }
      if (bot.firingVisualTimer > 0) {
        bot.firingVisualTimer = Math.max(0, bot.firingVisualTimer - dt);
      }
      bot.recoilKick = Math.max(0, bot.recoilKick - dt * 7.2);

      // 1. Target Acquisition & Throttled LoS check across ALL human operators & hostile bots
      bot.losTimer -= dt;
      let targetPos: THREE.Vector3 | null = null;
      let targetBot: BotActor | null = null;
      let targetHuman: BattleHumanTarget | null = null;

      if (bot.losTimer <= 0) {
        bot.losTimer = 0.14 + Math.random() * 0.06;
        this._tmpOrigin.set(bot.pos.x, bot.pos.y + BOT_EYE_Y, bot.pos.z);

        let bestId: string | null = null;
        let bestDist = this.diff.visionRangeM;
        let bestLos = false;

        // Consider ALL living human players (Host + joined teammates/opponents)
        for (let h = 0; h < humans.length; h++) {
          const hm = humans[h];
          if (!hm.alive || !this.isHostilePair(bot.team, hm.team)) continue;
          this._tmpTarget.set(hm.pos.x, hm.pos.y + 1.42, hm.pos.z);
          const d = this._tmpOrigin.distanceTo(this._tmpTarget);
          if (d < bestDist && this.hasLineOfSight(this._tmpOrigin, this._tmpTarget)) {
            bestDist = d;
            bestId = `human:${hm.id}`;
            bestLos = true;
          }
        }

        // Consider other hostile bots
        for (let j = 0; j < this.bots.length; j++) {
          if (i === j) continue;
          const other = this.bots[j];
          if (!other.alive || !this.isHostilePair(bot.team, other.team)) continue;
          this._tmpTarget.set(other.pos.x, other.pos.y + 1.32, other.pos.z);
          const d = this._tmpOrigin.distanceTo(this._tmpTarget);
          if (d < bestDist && this.hasLineOfSight(this._tmpOrigin, this._tmpTarget)) {
            bestDist = d;
            bestId = other.id;
            bestLos = true;
          }
        }

        if (bestLos && bestId) {
          if (bot.targetId !== bestId) {
            bot.reactionTimer = this.diff.reactionSec;
          }
          bot.targetId = bestId;
          bot.hasLos = true;
        } else {
          bot.hasLos = false;
          if (Math.random() < 0.25) {
            bot.targetId = null;
          }
        }
      }

      // Resolve live target position
      if (bot.targetId === 'player') {
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
        if (other) {
          targetBot = other;
          targetPos = this._tmpTarget.set(other.pos.x, other.pos.y + 1.32, other.pos.z);
        } else {
          bot.targetId = null;
          bot.hasLos = false;
        }
      }

      // 2. Navigation / Cover Movement
      let moveX = 0;
      let moveZ = 0;
      const moveSpeed = this.diff.moveSpeed;

      if (bot.hasLos && targetPos) {
        // Face target + strafe/peek tactically
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
        // Strafe perpendicular + maintain ideal engagement distance (8m–18m)
        const strafeX = -nz * bot.strafeDir;
        const strafeZ = nx * bot.strafeDir;
        let radial = 0;
        if (horizDist > 18) radial = 0.55;
        else if (horizDist < 6.5) radial = -0.6;

        moveX = (strafeX * 0.72 + nx * radial) * moveSpeed * 0.65;
        moveZ = (strafeZ * 0.72 + nz * radial) * moveSpeed * 0.65;

        // 3. Burst-Fire Engagement
        if (bot.reactionTimer > 0) {
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
                bot.burstCooldown = this.diff.burstPauseSec * (0.8 + Math.random() * 0.45);
              }

              this.fireBotRound(bot, targetPos, targetBot, targetHuman, onDamagePlayer, onBotFire);
            }
          }
        }
      } else {
        // Patrol / Advance across NavGraph toward cover or hostile sector
        bot.repathTimer -= dt;
        if (bot.repathTimer <= 0 || bot.pathIndex >= bot.path.length) {
          bot.repathTimer = 1.6 + Math.random() * 1.2;
          const startNode = findNearestNavNode(this.map.navGraph, bot.pos);
          if (startNode) {
            const nodes = this.map.navGraph.nodes;
            let goalNode: NavNode | null = null;

            // 55% chance pursue nearest hostile area, 45% pick tactical cover node
            if (Math.random() < 0.55) {
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

            if (goalNode && goalNode.id !== startNode.id) {
              bot.path = findNavPath(this.map.navGraph, startNode.id, goalNode.id);
              bot.pathIndex = bot.path.length > 1 ? 1 : 0;
              bot.goalNodeId = goalNode.id;
            }
          }
        }

        if (bot.pathIndex < bot.path.length) {
          const wp = bot.path[bot.pathIndex];
          const dx = wp.position[0] - bot.pos.x;
          const dz = wp.position[2] - bot.pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.95) {
            bot.pathIndex++;
          } else {
            moveX = (dx / dist) * moveSpeed;
            moveZ = (dz / dist) * moveSpeed;
            bot.targetYaw = Math.atan2(-dx, -dz);
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
        if (dSq > 1e-4 && dSq < 1.1) {
          const d = Math.sqrt(dSq);
          const push = (1.05 - d) * 3.0;
          moveX += (sx / d) * push;
          moveZ += (sz / d) * push;
        }
      }

      // Integrate horizontal motion with simple AABB collision push-out + ground snapping
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

      // Smooth yaw turn
      let yawDelta = bot.targetYaw - bot.yaw;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      bot.yaw += yawDelta * Math.min(1, dt * 10);

      // Articulated stride, local weaponSocket shoulder mount, and 2-bone arm IK
      const speedHoriz = Math.hypot(moveX, moveZ);
      if (speedHoriz > 0.2) {
        bot.walkCycle += dt * speedHoriz * 2.55;
      }

      const isAimingFire = bot.hasLos || bot.firingVisualTimer > 0;
      const flinchPitch = bot.flinchTimer > 0 ? Math.sin(bot.flinchTimer * 35) * 0.16 : 0;
      let aimPitch = 0;
      if (bot.hasLos && targetPos) {
        const horizDist = Math.max(0.5, Math.hypot(targetPos.x - bot.pos.x, targetPos.z - bot.pos.z));
        aimPitch = THREE.MathUtils.clamp(Math.atan2(targetPos.y - (bot.pos.y + 1.36), horizDist), -0.75, 0.75);
      }

      const pose = this._poseScratch;
      pose.crouchBlend = 0;
      pose.leanBlend = 0;
      pose.aimPitch = aimPitch;
      pose.adsBlend = isAimingFire ? 0.76 : 0.12;
      pose.pointAimBlend = 0;
      pose.cantBlend = 0;
      pose.reloadBlend = 0;
      pose.speedMps = speedHoriz;
      pose.walkCycle = bot.walkCycle;
      pose.sprint = !bot.hasLos && speedHoriz > 3.2;
      pose.recoilKick = bot.recoilKick;
      pose.firingVibration = bot.firingVisualTimer > 0 ? Math.sin(performance.now() * 0.055) * 0.014 : 0;
      pose.flinchPitch = flinchPitch;

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
    const pyMin = baseY + 0.36; // allow stepping up stairs & ramps cleanly
    const pyMax = baseY + 1.72;

    const boxes = this.map.physics.boxes;
    for (let pass = 0; pass < 2; pass++) {
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
            cx += r;
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
    onDamagePlayer: (ev: BotPlayerDamageEvent) => void,
    onBotFire?: (botId: string, origin: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>) => void,
  ): void {
    // Muzzle position in world space
    shooter.muzzleFlash.visible = true;
    shooter.muzzleFlashTimer = 0.055;
    shooter.firingVisualTimer = 0.16;
    shooter.recoilKick = Math.min(1, shooter.recoilKick + 0.85);
    shooter.muzzleFlash.getWorldPosition(this._tmpMuzzle);

    // Compute aimed direction with difficulty spread
    this._tmpDir.subVectors(targetPos, this._tmpMuzzle);
    const dist = Math.max(0.5, this._tmpDir.length());
    this._tmpDir.divideScalar(dist);

    const spread = this.diff.spreadRad;
    this._tmpDir.x += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.y += (Math.random() - 0.5) * spread * 1.5;
    this._tmpDir.z += (Math.random() - 0.5) * spread * 2;
    this._tmpDir.normalize();

    const endPos = this._tmpOrigin.copy(this._tmpMuzzle).addScaledVector(this._tmpDir, Math.min(dist + 4, 48));
    this.spawnTracer(this._tmpMuzzle, endPos);
    onBotFire?.(shooter.id, this._tmpMuzzle, endPos);

    // Spatialized gunshot audio
    this.audio.playWeaponCue('fire', {
      position: this._tmpMuzzle,
      weightClass: 'carbine',
      caliberId: '556x45',
      suppressed: false,
      intensity: 0.72,
    });

    // Accuracy hit roll scaled by distance & angular error
    const toTarget = new THREE.Vector3().subVectors(targetPos, this._tmpMuzzle).normalize();
    const cosErr = THREE.MathUtils.clamp(toTarget.dot(this._tmpDir), -1, 1);
    const angErr = Math.acos(cosErr);
    const hitAngleLimit = Math.atan2(0.46, Math.max(2.5, dist));

    if (angErr <= hitAngleLimit) {
      if (targetBot) {
        const hs = Math.random() < 0.16;
        targetBot.hp -= this.diff.damagePerShot * (hs ? 2.0 : 1.0);
        targetBot.flinchTimer = 0.14;
        if (targetBot.hp <= 0) {
          this.killBot(targetBot, shooter.name, shooter.team, hs, shooter.weaponLabel, shooter);
        }
      } else if (targetHuman) {
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

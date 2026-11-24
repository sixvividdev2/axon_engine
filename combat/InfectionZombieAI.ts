import * as THREE from 'three';
import { BodycamAudio } from '../bodycam-sdk';
import {
  BuiltMapInstance,
  findNavPath,
  findNearestNavNode,
  MapWindowBarrier,
  NavNode,
  ZombieSpawnerDef,
} from '../maps/types';
import {
  GameZombieSpawnPacket,
  GameZombiesSyncPacket,
  SyncedZombieState,
} from '../data/multiplayer';
import {
  BuiltInfectedZombieRig,
  InfectedPoseInput,
  InfectedZombieRigLibrary,
} from './InfectedZombieRig';

export interface ZombieDamageResult {
  hit: boolean;
  killed: boolean;
  headshot: boolean;
  pointsAwarded: number;
}

export interface ZombieRoundState {
  round: number;
  zombiesRemaining: number;
  activeCount: number;
  intermissionSec: number;
  roundBannerSec: number;
}

export interface InfectionHumanTarget {
  id: string;
  pos: THREE.Vector3;
  alive: boolean;
}

export interface ZombieTargetDescriptor {
  id: string;
  pos: THREE.Vector3;
  enteringWindow: boolean;
  entryStage: ZombieEntryStage;
}

export type ZombieEntryStage = 'approach' | 'tear' | 'vault' | 'pursue';

export interface InfectionZombieTuningOptions {
  zombieHealthMult?: number;
  zombieMoveSpeedMult?: number;
  zombieAttackSpeedMult?: number;
  zombieSpawnAmountMult?: number;
  waveBreakIntervalSec?: number;
  isClientReplica?: boolean;
}

interface ZombieActor {
  id: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  speed: number;
  pos: THREE.Vector3;
  netPos: THREE.Vector3;
  yaw: number;
  netYaw: number;
  walkCycle: number;
  staggerTimer: number;
  knockbackVelX: number;
  knockbackVelZ: number;
  hasNetState: boolean;
  netWindup: boolean;
  netStagger: boolean;
  netEntryStage: ZombieEntryStage;

  // Spawner hallway -> tear planks -> vault sill state machine
  enteringWindow: boolean;
  entryStage: ZombieEntryStage;
  spawnerId: string | null;
  windowOuterPos: THREE.Vector3;
  sillPos: THREE.Vector3;
  entryPos: THREE.Vector3;
  vaultStartPos: THREE.Vector3;
  vaultT: number;
  tearTimer: number;
  tearAnimPhase: number;
  hallwayLateralOffset: number;

  // Navigation & stuck recovery
  path: NavNode[];
  pathIndex: number;
  repathTimer: number;
  stuckTimer: number;
  lastProgressX: number;
  lastProgressZ: number;
  avoidDir: number;
  unstuckBoostTimer: number;

  // Melee attack
  windupTimer: number;
  attackCooldown: number;
  deathTimer: number;
  dying: boolean;

  // Horror-mix spatial audio state
  voicePitchScale: number;
  vocalCooldownSec: number;
  snarlCooldownSec: number;
  hurtAudioCooldownSec: number;
  prevWalkStepIndex: number;
  wasInWindup: boolean;
  lastSpeedMps: number;

  // Visuals
  root: THREE.Group;
  bodyPivot: THREE.Group;
  rig: BuiltInfectedZombieRig;
  hitMeshes: THREE.Mesh[];
}

interface BloodBurstParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
}

const MAX_ACTIVE_ZOMBIES = 18;
const MAX_BLOOD_PARTICLES = 64;
const ZOMBIE_RADIUS = 0.34;
const ZOMBIE_ATTACK_RANGE = 1.85;
const ZOMBIE_ATTACK_WINDUP = 0.36;
const ZOMBIE_ATTACK_DAMAGE = 28;
const ZOMBIE_ATTACK_COOLDOWN = 0.96;
const ZOMBIE_PLANK_TEAR_SEC = 1.15;
const ZOMBIE_WINDOW_VAULT_SEC = 0.92;

// Explicit doorway edges in Der Lichtspielhaus gated by individual doors (even if auditorium is unlocked from opposite wing)
const DOOR_GATED_EDGES: ReadonlyArray<[string, string, string]> = [
  ['ww_door_aud', 'aud_pit_w', 'door_west_auditorium'],
  ['ew_door_aud', 'aud_pit_e', 'door_east_auditorium'],
  ['aud_back_w', 'proj_ramp', 'door_projector'],
];

/**
 * Dedicated melee horde AI + RoundDirector for INFECTION mode.
 * Strictly separated from BattleBotAI: zero guns, zone/door-gated pursuit,
 * barricaded window entry, melee lunge windup, headshot multiplier, stagger/knockback,
 * and active entity cap (MAX_ACTIVE_ZOMBIES = 18) for smooth FPS on high rounds.
 */
export class InfectionZombieAI {
  public readonly group = new THREE.Group();
  private readonly zombies: ZombieActor[] = [];
  private readonly activeHitMeshes: THREE.Object3D[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private readonly map: BuiltMapInstance;
  private readonly audio: BodycamAudio;
  private readonly zombieHealthMult: number;
  private readonly zombieMoveSpeedMult: number;
  private readonly zombieAttackSpeedMult: number;
  private readonly zombieSpawnAmountMult: number;
  private readonly waveBreakIntervalSec: number;
  private isClientReplica: boolean;
  private syncedRemaining = 9;
  private syncedToSpawn = 0;
  private syncedKilled = 0;
  private syncedTotal = 9;

  // Round Director state
  public round = 1;
  private toSpawnThisRound = 9;
  private killedThisRound = 0;
  private totalThisRound = 9;
  private spawnTimer = 1.6;
  private intermissionSec = 0;
  private roundBannerSec = 3.2;
  private nextZombieUid = 1;

  // Zone & door unlock state
  private readonly unlockedZones = new Set<string>(['lobby', 'default']);
  private readonly openedDoors = new Set<string>();
  private readonly barriersBySpawnerId = new Map<string, MapWindowBarrier>();
  private readonly barriersById = new Map<string, MapWindowBarrier>();
  private readonly targetScratch: ZombieTargetDescriptor[] = [];

  // Pooled blood-burst particles (InstancedMesh = 1 draw call)
  private readonly bloodParticles: BloodBurstParticle[] = [];
  private readonly bloodInstanced: THREE.InstancedMesh;
  private bloodCursor = 0;
  private readonly _mat4 = new THREE.Matrix4();
  private readonly _quat = new THREE.Quaternion();
  private readonly _scale = new THREE.Vector3();
  private readonly _zeroScale = new THREE.Vector3(0, 0, 0);
  private readonly _hidePos = new THREE.Vector3(0, -50, 0);
  private readonly _tmpAudioPos = new THREE.Vector3();
  private readonly _audioIndices: number[] = [];
  private readonly _audioDists: number[] = [];

  // Shared anatomical infected zombie rig library & zero-GC pose input scratch
  private readonly rigLib: InfectedZombieRigLibrary;
  private elapsedSec = 0;
  private readonly _poseInput: InfectedPoseInput = {
    mode: 'locomote',
    walkCycle: 0,
    speedMps: 0,
    tearPhase: 0,
    vaultT: 0,
    windupProgress: 0,
    staggerRatio: 0,
    deathProgress: 0,
    elapsedSec: 0,
    dt: 0.016,
    gazeTargetWorld: null,
    distanceToCameraM: 0,
    isVisible: true,
  };

  constructor(
    scene: THREE.Scene,
    map: BuiltMapInstance,
    audio: BodycamAudio,
    tuning?: InfectionZombieTuningOptions,
  ) {
    this.map = map;
    this.audio = audio;
    this.zombieHealthMult = Math.max(0.25, Math.min(4.0, tuning?.zombieHealthMult ?? 1.0));
    this.zombieMoveSpeedMult = Math.max(0.5, Math.min(2.5, tuning?.zombieMoveSpeedMult ?? 1.0));
    this.zombieAttackSpeedMult = Math.max(0.5, Math.min(2.5, tuning?.zombieAttackSpeedMult ?? 1.0));
    this.zombieSpawnAmountMult = Math.max(0.25, Math.min(3.0, tuning?.zombieSpawnAmountMult ?? 1.0));
    this.waveBreakIntervalSec = Math.max(2, Math.min(30, tuning?.waveBreakIntervalSec ?? 4.5));
    this.isClientReplica = Boolean(tuning?.isClientReplica);

    if (map.windowBarriers) {
      for (const b of map.windowBarriers) {
        this.barriersBySpawnerId.set(b.spawnerId, b);
        this.barriersById.set(b.id, b);
      }
    }

    scene.add(this.group);

    this.rigLib = this.track(new InfectedZombieRigLibrary());

    // Pooled blood burst InstancedMesh
    const bloodGeo = this.track(new THREE.BoxGeometry(0.055, 0.055, 0.055));
    const bloodMat = this.track(new THREE.MeshBasicMaterial({ color: 0x991b1b }));
    this.bloodInstanced = new THREE.InstancedMesh(bloodGeo, bloodMat, MAX_BLOOD_PARTICLES);
    this.bloodInstanced.frustumCulled = false;
    for (let i = 0; i < MAX_BLOOD_PARTICLES; i++) {
      this.bloodParticles.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
      });
      this._mat4.compose(new THREE.Vector3(0, -50, 0), this._quat, this._zeroScale);
      this.bloodInstanced.setMatrixAt(i, this._mat4);
    }
    this.bloodInstanced.instanceMatrix.needsUpdate = true;
    this.group.add(this.bloodInstanced);

    if (!this.isClientReplica) {
      this.startRound(1);
    } else {
      this.round = 1;
      this.totalThisRound = Math.max(3, Math.round(9 * this.zombieSpawnAmountMult));
      this.syncedRemaining = this.totalThisRound;
      this.toSpawnThisRound = 0;
      this.roundBannerSec = 3.2;
    }
  }

  private track<T extends { dispose: () => void }>(res: T): T {
    this.disposables.push(res);
    return res;
  }

  public getHitMeshes(): THREE.Object3D[] {
    return this.activeHitMeshes;
  }

  public getAliveZombieTargets(): ZombieTargetDescriptor[] {
    this.targetScratch.length = 0;
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.alive) continue;
      this.targetScratch.push({
        id: z.id,
        pos: z.pos,
        enteringWindow: z.enteringWindow,
        entryStage: z.entryStage,
      });
    }
    return this.targetScratch;
  }

  public getBarrierById(barrierId: string): MapWindowBarrier | undefined {
    return this.barriersById.get(barrierId);
  }

  public getBarrierCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, b] of this.barriersById) {
      out[id] = b.getPlanksRemaining();
    }
    return out;
  }

  public applyBarrierCounts(counts?: Record<string, number>): void {
    if (!counts) return;
    for (const [id, count] of Object.entries(counts)) {
      const b = this.barriersById.get(id);
      if (b && b.getPlanksRemaining() !== count) {
        b.setPlankCount(count);
      }
    }
  }

  private rebuildActiveHitMeshes(): void {
    this.activeHitMeshes.length = 0;
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.alive) continue;
      for (let j = 0; j < z.hitMeshes.length; j++) {
        this.activeHitMeshes.push(z.hitMeshes[j]);
      }
    }
  }

  public unlockZoneAndDoor(doorId: string, zoneId?: string): void {
    this.openedDoors.add(doorId);
    if (zoneId) {
      this.unlockedZones.add(zoneId);
    } else {
      const matchDoor = this.map.interactables.find((it) => it.id === doorId);
      if (matchDoor?.unlocksZoneId) {
        this.unlockedZones.add(matchDoor.unlocksZoneId);
      }
    }
    // Force live zombies to repath through newly opened passage
    for (let i = 0; i < this.zombies.length; i++) {
      this.zombies[i].repathTimer = 0;
    }
  }

  public unlockZone(zoneId: string): void {
    if (!zoneId) return;
    this.unlockedZones.add(zoneId);
  }

  public getOpenedDoorIds(): string[] {
    return Array.from(this.openedDoors);
  }

  public getUnlockedZoneIds(): string[] {
    return Array.from(this.unlockedZones);
  }

  public setClientReplica(replica: boolean): void {
    if (this.isClientReplica === replica) return;
    this.isClientReplica = replica;
    if (!replica) {
      // Seamless Host Migration mid-match: restore exact synced wave counters & preserve window climb-ins
      const aliveCount = this.zombies.filter((z) => z.alive).length;
      const fallbackTotal = Math.max(
        aliveCount,
        this.syncedRemaining,
        Math.round((6 + this.round * 3) * this.zombieSpawnAmountMult),
      );
      this.totalThisRound = Math.max(aliveCount, this.syncedTotal > 0 ? this.syncedTotal : fallbackTotal);
      this.killedThisRound = Math.max(
        0,
        Math.min(this.totalThisRound, this.syncedTotal > 0 ? this.syncedKilled : this.totalThisRound - Math.max(aliveCount, this.syncedRemaining)),
      );
      this.toSpawnThisRound = Math.max(
        0,
        this.syncedTotal > 0 ? this.syncedToSpawn : Math.max(0, this.totalThisRound - this.killedThisRound - aliveCount),
      );
      this.spawnTimer = 0.85;
      for (const z of this.zombies) {
        if (z.enteringWindow) {
          // Ensure valid interior entryPos so migrated zombies never stall outside window colliders
          if (z.pos.distanceToSquared(z.entryPos) < 0.04 && z.spawnerId) {
            const sp = this.map.spawnPoints.zombieSpawners.find((s) => s.id === z.spawnerId);
            if (sp) {
              z.entryPos.set(sp.entryPos[0], sp.entryPos[1], sp.entryPos[2]);
            } else {
              z.enteringWindow = false;
            }
          }
        }
        z.repathTimer = 0.05;
        z.speed = this.computeZombieSpeedForRound(this.round);
        const match = /^zombie_(\d+)$/.exec(z.id);
        if (match) {
          this.nextZombieUid = Math.max(this.nextZombieUid, Number(match[1]) + 1);
        }
      }
    }
  }

  public getRoundState(): ZombieRoundState {
    const aliveCount = this.zombies.filter((z) => z.alive).length;
    return {
      round: this.round,
      zombiesRemaining: this.isClientReplica
        ? Math.max(0, this.syncedRemaining)
        : Math.max(0, this.totalThisRound - this.killedThisRound),
      activeCount: aliveCount,
      intermissionSec: Math.max(0, this.intermissionSec),
      roundBannerSec: Math.max(0, this.roundBannerSec),
    };
  }

  public exportSyncSnapshot(powerOn: boolean): GameZombiesSyncPacket {
    const zombies: SyncedZombieState[] = [];
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.alive) continue;
      zombies.push({
        id: z.id,
        x: Number(z.pos.x.toFixed(3)),
        y: Number(z.pos.y.toFixed(3)),
        z: Number(z.pos.z.toFixed(3)),
        yaw: Number(z.yaw.toFixed(4)),
        alive: z.alive,
        hp: Math.round(z.hp),
        maxHp: z.maxHp,
        windup: z.windupTimer > 0,
        stagger: z.staggerTimer > 0,
        enteringWindow: z.enteringWindow,
        entryStage: z.entryStage,
        spawnerId: z.spawnerId,
        entryPos: z.enteringWindow
          ? [
              Number(z.entryPos.x.toFixed(3)),
              Number(z.entryPos.y.toFixed(3)),
              Number(z.entryPos.z.toFixed(3)),
            ]
          : null,
      });
    }
    return {
      type: 'game:zombies_sync',
      round: this.round,
      zombiesRemaining: Math.max(0, this.totalThisRound - this.killedThisRound),
      toSpawnThisRound: Math.max(0, this.toSpawnThisRound),
      killedThisRound: Math.max(0, this.killedThisRound),
      totalThisRound: Math.max(0, this.totalThisRound),
      intermissionSec: Number(Math.max(0, this.intermissionSec).toFixed(2)),
      roundBannerSec: Number(Math.max(0, this.roundBannerSec).toFixed(2)),
      powerOn,
      openedDoorIds: Array.from(this.openedDoors),
      unlockedZoneIds: Array.from(this.unlockedZones),
      barriers: this.getBarrierCounts(),
      zombies,
      ts: Date.now(),
    };
  }

  public applyRemoteSpawn(pkt: GameZombieSpawnPacket): void {
    if (!this.isClientReplica) return;
    if (this.zombies.some((z) => z.id === pkt.zombieId)) return;

    if (pkt.zoneId) {
      this.unlockedZones.add(pkt.zoneId);
    }
    if (typeof pkt.zombiesRemaining === 'number' && pkt.zombiesRemaining >= 0) {
      this.syncedRemaining = pkt.zombiesRemaining;
    }

    const z = this.createZombieActor(
      pkt.zombieId,
      pkt.maxHp,
      this.computeZombieSpeedForRound(pkt.round || this.round),
      pkt.x,
      pkt.y,
      pkt.z,
      pkt.yaw,
      true,
      pkt.entryPos,
      pkt.spawnerId,
    );
    z.hasNetState = true;
    z.netPos.set(pkt.x, pkt.y, pkt.z);
    z.netYaw = pkt.yaw;
    this.zombies.push(z);
    this.rebuildActiveHitMeshes();

    // Subtle spatial wood-window breach cue + eerie spawn moan at the entry hallway
    this._tmpAudioPos.set(pkt.entryPos[0], pkt.entryPos[1] + 1.0, pkt.entryPos[2]);
    this.audio.playImpact(this._tmpAudioPos, 'wood');
    this._tmpAudioPos.set(pkt.x, pkt.y + 1.5, pkt.z);
    this.audio.playZombieVocal(this._tmpAudioPos, 'moan', {
      pitchScale: z.voicePitchScale,
      intensity: 0.85,
    });
  }

  public applySyncSnapshot(pkt: GameZombiesSyncPacket): void {
    if (!this.isClientReplica) return;
    if (pkt.round !== this.round) {
      this.round = pkt.round;
      this.roundBannerSec = Math.max(pkt.roundBannerSec, 2.8);
    } else {
      this.roundBannerSec = Math.max(this.roundBannerSec, pkt.roundBannerSec);
    }
    this.syncedRemaining = pkt.zombiesRemaining;
    if (typeof pkt.totalThisRound === 'number' && pkt.totalThisRound >= 0) {
      this.syncedTotal = pkt.totalThisRound;
    }
    if (typeof pkt.killedThisRound === 'number' && pkt.killedThisRound >= 0) {
      this.syncedKilled = pkt.killedThisRound;
    }
    if (typeof pkt.toSpawnThisRound === 'number' && pkt.toSpawnThisRound >= 0) {
      this.syncedToSpawn = pkt.toSpawnThisRound;
    }
    this.intermissionSec = pkt.intermissionSec;

    if (Array.isArray(pkt.openedDoorIds)) {
      for (const did of pkt.openedDoorIds) {
        this.openedDoors.add(did);
      }
    }
    if (Array.isArray(pkt.unlockedZoneIds)) {
      for (const zid of pkt.unlockedZoneIds) {
        this.unlockedZones.add(zid);
      }
    }
    if (pkt.barriers) {
      this.applyBarrierCounts(pkt.barriers);
    }

    const seenIds = new Set<string>();
    let hitMeshesDirty = false;

    for (const sz of pkt.zombies) {
      seenIds.add(sz.id);
      let z = this.zombies.find((item) => item.id === sz.id);
      if (!z) {
        z = this.createZombieActor(
          sz.id,
          sz.maxHp,
          2.4,
          sz.x,
          sz.y,
          sz.z,
          sz.yaw,
          Boolean(sz.enteringWindow),
          sz.entryPos ?? undefined,
          sz.spawnerId ?? null,
        );
        z.hasNetState = true;
        z.netPos.set(sz.x, sz.y, sz.z);
        z.netYaw = sz.yaw;
        this.zombies.push(z);
        hitMeshesDirty = true;
      }
      z.alive = sz.alive;
      z.hp = sz.hp;
      z.maxHp = sz.maxHp || z.maxHp;
      z.netPos.set(sz.x, sz.y, sz.z);
      z.netYaw = sz.yaw;
      z.netWindup = sz.windup;
      z.netStagger = sz.stagger;
      z.enteringWindow = Boolean(sz.enteringWindow);
      z.netEntryStage = sz.entryStage ?? (sz.enteringWindow ? 'approach' : 'pursue');
      z.entryStage = z.netEntryStage;
      if (sz.spawnerId) z.spawnerId = sz.spawnerId;
      if (sz.entryPos) {
        z.entryPos.set(sz.entryPos[0], sz.entryPos[1], sz.entryPos[2]);
      }

      if (!z.hasNetState || z.pos.distanceToSquared(z.netPos) > 25) {
        z.pos.copy(z.netPos);
        z.yaw = z.netYaw;
        z.hasNetState = true;
      }
    }

    // Mark any locally-alive replicated zombies absent from Host snapshot as dead
    for (const z of this.zombies) {
      if (z.alive && !seenIds.has(z.id)) {
        z.alive = false;
        z.dying = true;
        z.deathTimer = 0;
        hitMeshesDirty = true;
      }
    }

    if (hitMeshesDirty) {
      this.rebuildActiveHitMeshes();
    }
  }

  public playVisualHitFeedback(
    zombieId: string,
    impactPoint: Readonly<THREE.Vector3>,
    headshot: boolean,
  ): void {
    const z = this.zombies.find((item) => item.id === zombieId && item.alive);
    if (z) {
      z.staggerTimer = Math.max(z.staggerTimer, headshot ? 0.25 : 0.14);
      if (z.hurtAudioCooldownSec <= 0) {
        z.hurtAudioCooldownSec = 0.28;
        this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
        this.audio.playZombieVocal(this._tmpAudioPos, 'hurt', { pitchScale: z.voicePitchScale });
      }
    }
    this.spawnBloodBurst(impactPoint, headshot ? 9 : 5);
  }

  public playVisualDeath(zombieId: string, point?: Readonly<THREE.Vector3>): void {
    const z = this.zombies.find((item) => item.id === zombieId);
    if (z && z.alive) {
      z.alive = false;
      z.dying = true;
      z.deathTimer = 0;
      this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.45, z.pos.z);
      this.audio.playZombieVocal(this._tmpAudioPos, 'death', { pitchScale: z.voicePitchScale });
      this.rebuildActiveHitMeshes();
    }
    if (point) {
      this.spawnBloodBurst(point, 10);
    }
  }

  private startRound(roundNum: number): void {
    this.round = roundNum;
    const baseTotal = 6 + roundNum * 3;
    this.totalThisRound = Math.max(3, Math.round(baseTotal * this.zombieSpawnAmountMult));
    this.toSpawnThisRound = this.totalThisRound;
    this.killedThisRound = 0;
    this.spawnTimer = 1.4;
    this.intermissionSec = 0;
    this.roundBannerSec = 3.2;
  }

  private computeZombieHpForRound(round: number): number {
    return Math.max(20, Math.round(100 * Math.pow(1.22, round - 1) * this.zombieHealthMult));
  }

  private computeZombieSpeedForRound(round: number): number {
    let base: number;
    if (round <= 2) {
      base = 1.7 + (round - 1) * 0.25;
    } else if (round <= 4) {
      base = 2.55 + (round - 3) * 0.45;
    } else {
      base = Math.min(4.3, 3.35 + (round - 5) * 0.18);
    }
    return base * this.zombieMoveSpeedMult * (0.88 + Math.random() * 0.24);
  }

  private pickActiveSpawner(anchorPositions: ReadonlyArray<Readonly<THREE.Vector3>>): ZombieSpawnerDef | null {
    const spawners = this.map.spawnPoints.zombieSpawners;
    const valid = spawners.filter((s) => this.unlockedZones.has(s.zoneId));
    if (valid.length === 0) return spawners[0] ?? null;

    // Prefer spawners within 26m of any living survivor (but not right on top < 3.5m)
    const nearby = valid.filter((s) => {
      let minD = Infinity;
      for (let i = 0; i < anchorPositions.length; i++) {
        const p = anchorPositions[i];
        const d = Math.hypot(s.entryPos[0] - p.x, s.entryPos[2] - p.z);
        if (d < minD) minD = d;
      }
      return minD >= 3.5 && minD <= 26;
    });
    const pool = nearby.length > 0 ? nearby : valid;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private createZombieActor(
    id: string,
    maxHp: number,
    speed: number,
    sx: number,
    sy: number,
    sz: number,
    yaw: number,
    enteringWindow: boolean,
    entryPos?: [number, number, number],
    spawnerId: string | null = null,
  ): ZombieActor {
    const rig = this.rigLib.buildZombie(id);
    const { root, bodyPivot } = rig;
    this.group.add(root);

    const spawnerDef = spawnerId
      ? this.map.spawnPoints.zombieSpawners.find((s) => s.id === spawnerId)
      : undefined;
    const outerVec = spawnerDef?.windowOuterPos
      ? new THREE.Vector3(spawnerDef.windowOuterPos[0], spawnerDef.windowOuterPos[1], spawnerDef.windowOuterPos[2])
      : new THREE.Vector3(sx, sy, sz);
    const entryVec = entryPos
      ? new THREE.Vector3(entryPos[0], entryPos[1], entryPos[2])
      : new THREE.Vector3(sx, sy, sz);
    const sillVec = spawnerDef?.sillPos
      ? new THREE.Vector3(spawnerDef.sillPos[0], spawnerDef.sillPos[1], spawnerDef.sillPos[2])
      : new THREE.Vector3(
          (outerVec.x + entryVec.x) * 0.5,
          sy + 0.94,
          (outerVec.z + entryVec.z) * 0.5,
        );

    const z: ZombieActor = {
      id,
      alive: true,
      hp: maxHp,
      maxHp,
      speed,
      pos: new THREE.Vector3(sx, sy, sz),
      netPos: new THREE.Vector3(sx, sy, sz),
      yaw,
      netYaw: yaw,
      walkCycle: Math.random() * Math.PI * 2,
      staggerTimer: 0,
      knockbackVelX: 0,
      knockbackVelZ: 0,
      hasNetState: false,
      netWindup: false,
      netStagger: false,
      netEntryStage: enteringWindow ? 'approach' : 'pursue',
      enteringWindow,
      entryStage: enteringWindow ? 'approach' : 'pursue',
      spawnerId,
      windowOuterPos: outerVec,
      sillPos: sillVec,
      entryPos: entryVec,
      vaultStartPos: new THREE.Vector3(sx, sy, sz),
      vaultT: 0,
      tearTimer: 0.55,
      tearAnimPhase: 0,
      hallwayLateralOffset: (Math.random() - 0.5) * 0.45,
      path: [],
      pathIndex: 0,
      repathTimer: 0.1,
      stuckTimer: 0,
      lastProgressX: sx,
      lastProgressZ: sz,
      avoidDir: Math.random() < 0.5 ? -1 : 1,
      unstuckBoostTimer: 0,
      windupTimer: 0,
      attackCooldown: 0.4,
      deathTimer: 0,
      dying: false,
      voicePitchScale: 0.80 + Math.random() * 0.42,
      vocalCooldownSec: 0.8 + Math.random() * 3.8,
      snarlCooldownSec: 0.25 + Math.random() * 0.9,
      hurtAudioCooldownSec: 0,
      prevWalkStepIndex: 0,
      wasInWindup: false,
      lastSpeedMps: 0,
      root,
      bodyPivot,
      rig,
      hitMeshes: rig.hitMeshes,
    };
    z.prevWalkStepIndex = Math.floor(z.walkCycle / Math.PI);

    this._poseInput.mode = 'locomote';
    this._poseInput.walkCycle = z.walkCycle;
    this._poseInput.speedMps = 0;
    this._poseInput.tearPhase = 0;
    this._poseInput.vaultT = 0;
    this._poseInput.windupProgress = 0;
    this._poseInput.staggerRatio = 0;
    this._poseInput.deathProgress = 0;
    this._poseInput.elapsedSec = this.elapsedSec;
    this._poseInput.dt = 0.016;
    this._poseInput.gazeTargetWorld = null;
    this._poseInput.distanceToCameraM = 0;
    this._poseInput.isVisible = true;
    root.position.copy(z.pos);
    root.rotation.set(0, z.yaw, 0);
    this.rigLib.applyPose(rig, this._poseInput);
    return z;
  }

  private spawnOneZombie(
    anchorPositions: ReadonlyArray<Readonly<THREE.Vector3>>,
    onZombieSpawn?: (pkt: GameZombieSpawnPacket) => void,
  ): void {
    const spawner = this.pickActiveSpawner(anchorPositions);
    if (!spawner) return;

    const id = `zombie_${this.nextZombieUid++}`;
    const maxHp = this.computeZombieHpForRound(this.round);
    const speed = this.computeZombieSpeedForRound(this.round);
    // Face directly from deep hallway toward window (mesh front is -Z)
    const targetX = spawner.windowOuterPos ? spawner.windowOuterPos[0] : spawner.entryPos[0];
    const targetZ = spawner.windowOuterPos ? spawner.windowOuterPos[2] : spawner.entryPos[2];
    const initYaw = Math.atan2(-(targetX - spawner.spawnPos[0]), -(targetZ - spawner.spawnPos[2]));
    const z = this.createZombieActor(
      id,
      maxHp,
      speed,
      spawner.spawnPos[0],
      spawner.spawnPos[1],
      spawner.spawnPos[2],
      initYaw,
      true,
      spawner.entryPos,
      spawner.id,
    );

    this.zombies.push(z);
    this.toSpawnThisRound = Math.max(0, this.toSpawnThisRound - 1);
    this.rebuildActiveHitMeshes();

    this._tmpAudioPos.set(spawner.spawnPos[0], spawner.spawnPos[1] + 1.5, spawner.spawnPos[2]);
    this.audio.playZombieVocal(this._tmpAudioPos, 'moan', {
      pitchScale: z.voicePitchScale,
      intensity: 0.82,
    });

    onZombieSpawn?.({
      type: 'game:zombie_spawn',
      zombieId: id,
      spawnerId: spawner.id,
      zoneId: spawner.zoneId,
      maxHp,
      x: Number(spawner.spawnPos[0].toFixed(3)),
      y: Number(spawner.spawnPos[1].toFixed(3)),
      z: Number(spawner.spawnPos[2].toFixed(3)),
      yaw: Number(initYaw.toFixed(4)),
      entryPos: [
        Number(spawner.entryPos[0].toFixed(3)),
        Number(spawner.entryPos[1].toFixed(3)),
        Number(spawner.entryPos[2].toFixed(3)),
      ],
      round: this.round,
      zombiesRemaining: Math.max(0, this.totalThisRound - this.killedThisRound),
      ts: Date.now(),
    });
  }

  private spawnBloodBurst(point: Readonly<THREE.Vector3>, count: number): void {
    for (let i = 0; i < count; i++) {
      const p = this.bloodParticles[this.bloodCursor];
      this.bloodCursor = (this.bloodCursor + 1) % this.bloodParticles.length;
      p.active = true;
      p.pos.copy(point);
      p.vel.set(
        (Math.random() - 0.5) * 3.4,
        0.9 + Math.random() * 2.2,
        (Math.random() - 0.5) * 3.4,
      );
      p.life = 0.28 + Math.random() * 0.2;
    }
  }

  public applyBulletDamage(
    zombieId: string,
    baseDamage: number,
    hitZone: string,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ): ZombieDamageResult {
    const z = this.zombies.find((item) => item.id === zombieId && item.alive);
    if (!z) {
      return { hit: false, killed: false, headshot: false, pointsAwarded: 0 };
    }

    const headshot = hitZone === 'head';
    const mult = headshot ? 2.6 : hitZone === 'limb' ? 0.7 : 1.0;
    const dmg = Math.max(10, baseDamage * mult);
    z.hp -= dmg;
    z.staggerTimer = Math.max(z.staggerTimer, headshot ? 0.28 : 0.14);
    z.knockbackVelX += impactDir.x * (headshot ? 2.2 : 1.2);
    z.knockbackVelZ += impactDir.z * (headshot ? 2.2 : 1.2);

    this.spawnBloodBurst(impactPoint, headshot ? 9 : 5);

    if (z.hp <= 0) {
      this.killZombie(z);
      return {
        hit: true,
        killed: true,
        headshot,
        pointsAwarded: headshot ? 100 : 60,
      };
    }

    if (z.hurtAudioCooldownSec <= 0) {
      z.hurtAudioCooldownSec = 0.28;
      this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
      this.audio.playZombieVocal(this._tmpAudioPos, 'hurt', { pitchScale: z.voicePitchScale });
    }

    return {
      hit: true,
      killed: false,
      headshot,
      pointsAwarded: 10,
    };
  }

  public applyMeleeHit(
    zombieId: string,
    damage: number,
    knockbackSpeed: number,
    pushDir: Readonly<THREE.Vector3>,
    impactPoint: Readonly<THREE.Vector3>,
  ): ZombieDamageResult {
    const z = this.zombies.find((item) => item.id === zombieId && item.alive);
    if (!z) {
      return { hit: false, killed: false, headshot: false, pointsAwarded: 0 };
    }

    z.hp -= damage;
    z.staggerTimer = 0.58;
    z.windupTimer = 0; // Interrupt melee windup on bash/kick!
    z.knockbackVelX += pushDir.x * knockbackSpeed;
    z.knockbackVelZ += pushDir.z * knockbackSpeed;
    this.spawnBloodBurst(impactPoint, 6);

    if (z.hp <= 0) {
      this.killZombie(z);
      return { hit: true, killed: true, headshot: false, pointsAwarded: 130 };
    }

    if (z.hurtAudioCooldownSec <= 0) {
      z.hurtAudioCooldownSec = 0.24;
      this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
      this.audio.playZombieVocal(this._tmpAudioPos, 'hurt', {
        pitchScale: z.voicePitchScale,
        intensity: 1.15,
      });
    }

    return { hit: true, killed: false, headshot: false, pointsAwarded: 20 };
  }

  /**
   * Applies tactical grenade AoE damage, radial knockback, and flashbang stagger to nearby zombies.
   */
  public applyAreaBlast(
    origin: Readonly<THREE.Vector3>,
    radiusM: number,
    maxDamage: number,
    kind: 'frag' | 'flash' | 'smoke' | 'thermite',
  ): { hits: number; kills: number; pointsAwarded: number } {
    if (this.isClientReplica || kind === 'smoke') {
      return { hits: 0, kills: 0, pointsAwarded: 0 };
    }
    let hits = 0;
    let kills = 0;
    let pointsAwarded = 0;

    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.alive) continue;
      const dx = z.pos.x - origin.x;
      const dy = z.pos.y + 1.0 - origin.y;
      const dz = z.pos.z - origin.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > radiusM) continue;

      const falloff = Math.max(0.18, 1 - dist / Math.max(0.5, radiusM));
      hits += 1;

      if (kind === 'flash') {
        z.staggerTimer = Math.max(z.staggerTimer, 1.8 + 2.2 * falloff);
        z.windupTimer = 0;
        if (maxDamage > 0) {
          z.hp -= Math.round(maxDamage * falloff);
        }
        if (z.hp <= 0) {
          this.killZombie(z);
          kills += 1;
          pointsAwarded += 70;
        }
        continue;
      }

      const dmg = Math.max(10, maxDamage * Math.pow(falloff, kind === 'frag' ? 1.05 : 0.8));
      z.hp -= dmg;
      z.staggerTimer = Math.max(z.staggerTimer, kind === 'frag' ? 0.65 : 0.28);
      z.windupTimer = 0;
      const horiz = Math.max(0.15, Math.hypot(dx, dz));
      const kb = kind === 'frag' ? 5.6 * falloff + 1.4 : 1.1;
      z.knockbackVelX += (dx / horiz) * kb;
      z.knockbackVelZ += (dz / horiz) * kb;
      this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.05, z.pos.z);
      this.spawnBloodBurst(this._tmpAudioPos, kind === 'frag' ? 8 : 4);

      if (z.hp <= 0) {
        this.killZombie(z);
        kills += 1;
        pointsAwarded += 75;
      } else {
        pointsAwarded += 10;
      }
    }

    return { hits, kills, pointsAwarded };
  }

  public getZombieHeadPosition(zombieId: string, out: THREE.Vector3): boolean {
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (z.id === zombieId) {
        if (!z.alive) return false;
        out.set(z.pos.x, z.pos.y + 1.88, z.pos.z);
        return true;
      }
    }
    return false;
  }

  private killZombie(z: ZombieActor): void {
    z.alive = false;
    z.dying = true;
    z.deathTimer = 0;
    this.killedThisRound += 1;
    this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.45, z.pos.z);
    this.audio.playZombieVocal(this._tmpAudioPos, 'death', { pitchScale: z.voicePitchScale });
    this.rebuildActiveHitMeshes();
  }

  private isEdgeBlockedByClosedDoor(aId: string, bId: string): boolean {
    for (let i = 0; i < DOOR_GATED_EDGES.length; i++) {
      const [u, v, doorId] = DOOR_GATED_EDGES[i];
      if ((aId === u && bId === v) || (aId === v && bId === u)) {
        if (!this.openedDoors.has(doorId)) return true;
      }
    }
    return false;
  }

  private findDoorSafePath(startId: string, goalId: string): NavNode[] {
    const raw = findNavPath(
      this.map.navGraph,
      startId,
      goalId,
      this.unlockedZones,
      this.openedDoors,
    );
    // Validate that no segment crosses a still-locked dual-entry doorway (e.g. east/west auditorium)
    for (let i = 0; i < raw.length - 1; i++) {
      if (this.isEdgeBlockedByClosedDoor(raw[i].id, raw[i + 1].id)) {
        // Re-run lightweight BFS skipping blocked edges
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
        if (this.isEdgeBlockedByClosedDoor(curId, nbId)) continue;
        visited.add(nbId);
        parent.set(nbId, curId);
        queue.push(nbId);
      }
    }
    return [];
  }

  /**
   * Fast 2D walkable corridor clearance test against solid physics AABBs (used for path smoothing & whiskers).
   */
  private isPointBlockedXZ(x: number, z: number, baseY: number, radius: number): boolean {
    if (
      x < this.map.physics.boundsMinX + radius ||
      x > this.map.physics.boundsMaxX - radius ||
      z < this.map.physics.boundsMinZ + radius ||
      z > this.map.physics.boundsMaxZ - radius
    ) {
      return true;
    }
    const rSq = radius * radius;
    const pyMin = baseY + 0.36;
    const pyMax = baseY + 1.62;
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

  private isWalkSegmentClear(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    baseY: number,
    radius: number,
  ): boolean {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist < 0.25) return true;
    const steps = Math.min(12, Math.max(2, Math.ceil(dist / 0.65)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const px = x0 + (x1 - x0) * t;
      const pz = z0 + (z1 - z0) * t;
      if (this.isPointBlockedXZ(px, pz, baseY, radius)) {
        return false;
      }
    }
    return true;
  }

  public update(
    dt: number,
    playerPos: Readonly<THREE.Vector3>,
    playerAlive: boolean,
    onDamagePlayer: (damage: number, attackerPos: THREE.Vector3, targetUserId?: string) => void,
    onRoundComplete: (completedRound: number, bonusPoints: number) => void,
    humanTargets?: InfectionHumanTarget[],
    onZombieSpawn?: (pkt: GameZombieSpawnPacket) => void,
    onBarrierChanged?: (barrierId: string, planksRemaining: number) => void,
  ): void {
    this.elapsedSec += dt;

    // 1. Update blood burst InstancedMesh
    let anyBloodMoved = false;
    for (let i = 0; i < this.bloodParticles.length; i++) {
      const p = this.bloodParticles[i];
      if (!p.active) continue;
      anyBloodMoved = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this._mat4.compose(this._hidePos, this._quat, this._zeroScale);
        this.bloodInstanced.setMatrixAt(i, this._mat4);
      } else {
        p.vel.y -= 9.5 * dt;
        p.pos.addScaledVector(p.vel, dt);
        const s = Math.max(0.2, p.life * 2.4);
        this._scale.set(s, s, s);
        this._mat4.compose(p.pos, this._quat, this._scale);
        this.bloodInstanced.setMatrixAt(i, this._mat4);
      }
    }
    if (anyBloodMoved) {
      this.bloodInstanced.instanceMatrix.needsUpdate = true;
    }

    if (this.roundBannerSec > 0) {
      this.roundBannerSec = Math.max(0, this.roundBannerSec - dt);
    }

    // Client Replica mode: smoothly interpolate Host-authoritative zombies & wave banners
    if (this.isClientReplica) {
      if (this.intermissionSec > 0) {
        this.intermissionSec = Math.max(0, this.intermissionSec - dt);
      }
      const posAlpha = 1 - Math.exp(-16 * dt);
      const rotAlpha = 1 - Math.exp(-18 * dt);

      for (let i = this.zombies.length - 1; i >= 0; i--) {
        const z = this.zombies[i];
        if (!z.alive) {
          z.deathTimer += dt;
          this._poseInput.mode = 'death';
          this._poseInput.walkCycle = z.walkCycle;
          this._poseInput.speedMps = 0;
          this._poseInput.tearPhase = 0;
          this._poseInput.vaultT = 0;
          this._poseInput.windupProgress = 0;
          this._poseInput.staggerRatio = 0;
          this._poseInput.deathProgress = Math.min(1, z.deathTimer / 0.55);
          this._poseInput.elapsedSec = this.elapsedSec;
          this._poseInput.dt = dt;
          this._poseInput.gazeTargetWorld = null;
          this._poseInput.distanceToCameraM = Math.hypot(
            z.pos.x - playerPos.x,
            z.pos.y - playerPos.y,
            z.pos.z - playerPos.z,
          );
          this._poseInput.isVisible = z.root.visible;
          this.rigLib.applyPose(z.rig, this._poseInput);
          if (z.deathTimer > 3.2) {
            this.group.remove(z.root);
            this.zombies.splice(i, 1);
          }
          continue;
        }

        if (z.staggerTimer > 0) z.staggerTimer = Math.max(0, z.staggerTimer - dt);

        const prevX = z.pos.x;
        const prevZ = z.pos.z;
        z.pos.lerp(z.netPos, posAlpha);
        const spd = Math.hypot(z.pos.x - prevX, z.pos.z - prevZ) / Math.max(0.001, dt);

        let dyaw = z.netYaw - z.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        z.yaw += dyaw * rotAlpha;

        z.lastSpeedMps = spd;
        z.walkCycle += dt * Math.max(1.2, spd * 2.9);

        this._poseInput.walkCycle = z.walkCycle;
        this._poseInput.speedMps = spd;
        this._poseInput.staggerRatio =
          z.staggerTimer > 0 ? Math.min(1, z.staggerTimer / 0.35) : z.netStagger ? 0.72 : 0;
        this._poseInput.deathProgress = 0;
        this._poseInput.elapsedSec = this.elapsedSec;

        if (z.netEntryStage === 'vault') {
          z.vaultT = Math.min(1, z.vaultT + dt / ZOMBIE_WINDOW_VAULT_SEC);
          this._poseInput.mode = 'vault';
          this._poseInput.vaultT = z.vaultT;
          this._poseInput.tearPhase = 0;
          this._poseInput.windupProgress = 0;
        } else if (z.netEntryStage === 'tear') {
          z.vaultT = 0;
          z.tearAnimPhase += dt * 5.2;
          this._poseInput.mode = 'tear';
          this._poseInput.tearPhase = z.tearAnimPhase;
          this._poseInput.vaultT = 0;
          this._poseInput.windupProgress = 0;
        } else {
          z.vaultT = 0;
          this._poseInput.tearPhase = 0;
          this._poseInput.vaultT = 0;
          this._poseInput.mode = z.netWindup
            ? 'windup'
            : this._poseInput.staggerRatio > 0.05
              ? 'stagger'
              : 'locomote';
          this._poseInput.windupProgress = z.netWindup ? 0.65 : 0;
        }
        z.root.position.copy(z.pos);
        z.root.rotation.set(0, z.yaw, 0);
        this._poseInput.dt = dt;
        this._poseInput.gazeTargetWorld = playerPos;
        this._poseInput.distanceToCameraM = Math.hypot(
          z.pos.x - playerPos.x,
          z.pos.y - playerPos.y,
          z.pos.z - playerPos.z,
        );
        this._poseInput.isVisible = z.root.visible;
        this.rigLib.applyPose(z.rig, this._poseInput);
      }
      this.updateSpatialZombieAudio(dt, playerPos);
      return;
    }

    // Build list of living survivors (humans + friendly AI squadmates)
    const aliveSurvivors: InfectionHumanTarget[] =
      humanTargets && humanTargets.length > 0
        ? humanTargets.filter((h) => h.alive)
        : playerAlive
          ? [{ id: 'player', pos: playerPos as THREE.Vector3, alive: true }]
          : [];
    const anySurvivorAlive = aliveSurvivors.length > 0;
    const anchorPositions = aliveSurvivors.map((s) => s.pos);

    // 2. Round Director spawning & intermission
    const activeAlive = this.zombies.filter((z) => z.alive).length;

    if (this.intermissionSec > 0) {
      this.intermissionSec -= dt;
      if (this.intermissionSec <= 0) {
        this.startRound(this.round + 1);
      }
    } else if (this.toSpawnThisRound > 0 && activeAlive < MAX_ACTIVE_ZOMBIES && anySurvivorAlive) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnOneZombie(anchorPositions, onZombieSpawn);
        this.spawnTimer = Math.max(0.45, (2.05 - this.round * 0.14) / Math.sqrt(this.zombieSpawnAmountMult));
      }
    } else if (this.toSpawnThisRound === 0 && activeAlive === 0 && anySurvivorAlive) {
      const bonus = this.round * 100;
      onRoundComplete(this.round, bonus);
      this.intermissionSec = this.waveBreakIntervalSec;
    }

    const scaledWindup = ZOMBIE_ATTACK_WINDUP / this.zombieAttackSpeedMult;
    const scaledCooldown = ZOMBIE_ATTACK_COOLDOWN / this.zombieAttackSpeedMult;
    const scaledTearSec = Math.max(0.55, ZOMBIE_PLANK_TEAR_SEC / Math.sqrt(this.zombieAttackSpeedMult));

    // Track per-window active tearer & active vaulter so zombies queue cleanly at windows
    const windowHasTearer = new Set<string>();
    const windowHasVaulter = new Set<string>();
    for (let i = 0; i < this.zombies.length; i++) {
      const z = this.zombies[i];
      if (!z.alive || !z.spawnerId) continue;
      if (z.entryStage === 'vault') windowHasVaulter.add(z.spawnerId);
    }

    // 3. Step all zombies
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];

      if (!z.alive) {
        z.deathTimer += dt;
        this._poseInput.mode = 'death';
        this._poseInput.walkCycle = z.walkCycle;
        this._poseInput.speedMps = 0;
        this._poseInput.tearPhase = 0;
        this._poseInput.vaultT = 0;
        this._poseInput.windupProgress = 0;
        this._poseInput.staggerRatio = 0;
        this._poseInput.deathProgress = Math.min(1, z.deathTimer / 0.55);
        this._poseInput.elapsedSec = this.elapsedSec;
        this._poseInput.dt = dt;
        this._poseInput.gazeTargetWorld = null;
        this._poseInput.distanceToCameraM = Math.hypot(
          z.pos.x - playerPos.x,
          z.pos.y - playerPos.y,
          z.pos.z - playerPos.z,
        );
        this._poseInput.isVisible = z.root.visible;
        this.rigLib.applyPose(z.rig, this._poseInput);
        if (z.deathTimer > 3.2) {
          this.group.remove(z.root);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      if (z.attackCooldown > 0) z.attackCooldown = Math.max(0, z.attackCooldown - dt);
      if (z.staggerTimer > 0) z.staggerTimer = Math.max(0, z.staggerTimer - dt);
      if (z.unstuckBoostTimer > 0) z.unstuckBoostTimer = Math.max(0, z.unstuckBoostTimer - dt);

      const kbDamp = Math.exp(-7.5 * dt);
      z.knockbackVelX *= kbDamp;
      z.knockbackVelZ *= kbDamp;

      let moveX = z.entryStage === 'pursue' ? z.knockbackVelX : 0;
      let moveZ = z.entryStage === 'pursue' ? z.knockbackVelZ : 0;

      // === WINDOW HALLWAY -> SEQUENTIAL PLANK TEARING -> PHYSICAL VAULT STATE MACHINE ===
      if (z.entryStage !== 'pursue') {
        const barrier = z.spawnerId ? this.barriersBySpawnerId.get(z.spawnerId) : undefined;
        const planksLeft = barrier ? barrier.getPlanksRemaining() : 0;

        if (z.entryStage === 'approach') {
          // Walk from deep dark hallway right up to window outer stand spot
          const dx = z.windowOuterPos.x - z.pos.x;
          const dz = z.windowOuterPos.z - z.pos.z;
          const dist = Math.hypot(dx, dz);

          if (dist < 0.24) {
            z.pos.x = z.windowOuterPos.x;
            z.pos.z = z.windowOuterPos.z;
            z.pos.y = z.windowOuterPos.y;
            if (planksLeft > 0) {
              z.entryStage = 'tear';
              z.tearTimer = scaledTearSec * 0.85;
            } else if (!z.spawnerId || !windowHasVaulter.has(z.spawnerId)) {
              z.entryStage = 'vault';
              z.vaultStartPos.copy(z.pos);
              z.vaultT = 0;
              if (z.spawnerId) windowHasVaulter.add(z.spawnerId);
            } else {
              // Wait at window until previous zombie clears sill
              z.entryStage = 'tear';
              z.tearTimer = 0.25;
            }
          } else {
            const walkSpd = z.staggerTimer > 0 ? z.speed * 0.25 : Math.max(1.35, z.speed * 0.78);
            const vx = (dx / dist) * walkSpd;
            const vz = (dz / dist) * walkSpd;
            z.pos.x += vx * dt;
            z.pos.z += vz * dt;
            z.pos.y = THREE.MathUtils.damp(z.pos.y, z.windowOuterPos.y, 12, dt);
            z.yaw = Math.atan2(-dx, -dz);

            z.lastSpeedMps = walkSpd;
            z.walkCycle += dt * Math.max(1.2, walkSpd * 2.9);
            this._poseInput.mode = z.staggerTimer > 0 ? 'stagger' : 'locomote';
            this._poseInput.walkCycle = z.walkCycle;
            this._poseInput.speedMps = walkSpd;
            this._poseInput.tearPhase = 0;
            this._poseInput.vaultT = 0;
            this._poseInput.windupProgress = 0;
            this._poseInput.staggerRatio = Math.min(1, z.staggerTimer / 0.35);
            this._poseInput.deathProgress = 0;
            this._poseInput.elapsedSec = this.elapsedSec;
            this._poseInput.dt = dt;
            this._poseInput.gazeTargetWorld = z.sillPos;
            this._poseInput.distanceToCameraM = Math.hypot(
              z.pos.x - playerPos.x,
              z.pos.y - playerPos.y,
              z.pos.z - playerPos.z,
            );
            this._poseInput.isVisible = z.root.visible;
            z.root.position.copy(z.pos);
            z.root.rotation.set(0, z.yaw, 0);
            this.rigLib.applyPose(z.rig, this._poseInput);
            continue;
          }

          z.root.position.copy(z.pos);
          z.root.rotation.set(0, z.yaw, 0);
          continue;
        }

        if (z.entryStage === 'tear') {
          // Face cleanly straight through the window
          const faceX = z.entryPos.x - z.windowOuterPos.x;
          const faceZ = z.entryPos.z - z.windowOuterPos.z;
          z.yaw = Math.atan2(-faceX, -faceZ);
          z.pos.x = THREE.MathUtils.damp(z.pos.x, z.windowOuterPos.x, 8, dt);
          z.pos.z = THREE.MathUtils.damp(z.pos.z, z.windowOuterPos.z, 8, dt);
          z.pos.y = THREE.MathUtils.damp(z.pos.y, z.windowOuterPos.y, 12, dt);

          if (planksLeft <= 0) {
            // All planks removed -> vault through if sill is clear!
            if (!z.spawnerId || !windowHasVaulter.has(z.spawnerId)) {
              z.entryStage = 'vault';
              z.vaultStartPos.copy(z.pos);
              z.vaultT = 0;
              if (z.spawnerId) windowHasVaulter.add(z.spawnerId);
            }
          } else {
            // Only one zombie tears the active plank at a time; others reach/wait behind
            const isActiveTearer = !z.spawnerId || !windowHasTearer.has(z.spawnerId);
            if (isActiveTearer && z.spawnerId) {
              windowHasTearer.add(z.spawnerId);
            }

            if (isActiveTearer && z.staggerTimer <= 0) {
              z.tearTimer -= dt;
              z.tearAnimPhase += dt * 5.8;
              this._poseInput.mode = 'tear';
              this._poseInput.walkCycle = z.walkCycle;
              this._poseInput.speedMps = 0;
              this._poseInput.tearPhase = z.tearAnimPhase;
              this._poseInput.vaultT = 0;
              this._poseInput.windupProgress = 0;
              this._poseInput.staggerRatio = 0;
              this._poseInput.deathProgress = 0;
              this._poseInput.elapsedSec = this.elapsedSec;
              this._poseInput.dt = dt;
              this._poseInput.gazeTargetWorld = playerPos;
              this._poseInput.distanceToCameraM = Math.hypot(
                z.pos.x - playerPos.x,
                z.pos.y - playerPos.y,
                z.pos.z - playerPos.z,
              );
              this._poseInput.isVisible = z.root.visible;
              z.root.position.copy(z.pos);
              z.root.rotation.set(0, z.yaw, 0);
              this.rigLib.applyPose(z.rig, this._poseInput);

              if (z.tearTimer <= 0 && barrier) {
                if (barrier.tearPlank()) {
                  this._tmpAudioPos.copy(z.sillPos);
                  this.audio.playImpact(this._tmpAudioPos, 'wood');
                  onBarrierChanged?.(barrier.id, barrier.getPlanksRemaining());
                }
                z.tearTimer = scaledTearSec;
              }
            } else {
              // Waiting or briefly staggered at window
              z.tearAnimPhase += dt * 2.4;
              this._poseInput.mode = z.staggerTimer > 0 ? 'stagger' : 'tear';
              this._poseInput.walkCycle = z.walkCycle;
              this._poseInput.speedMps = 0;
              this._poseInput.tearPhase = z.tearAnimPhase;
              this._poseInput.vaultT = 0;
              this._poseInput.windupProgress = 0;
              this._poseInput.staggerRatio = Math.min(1, z.staggerTimer / 0.35);
              this._poseInput.deathProgress = 0;
              this._poseInput.elapsedSec = this.elapsedSec;
              this._poseInput.dt = dt;
              this._poseInput.gazeTargetWorld = playerPos;
              this._poseInput.distanceToCameraM = Math.hypot(
                z.pos.x - playerPos.x,
                z.pos.y - playerPos.y,
                z.pos.z - playerPos.z,
              );
              this._poseInput.isVisible = z.root.visible;
              z.root.position.copy(z.pos);
              z.root.rotation.set(0, z.yaw, 0);
              this.rigLib.applyPose(z.rig, this._poseInput);
            }
          }

          z.root.position.copy(z.pos);
          z.root.rotation.set(0, z.yaw, 0);
          continue;
        }

        if (z.entryStage === 'vault') {
          // If a player nailed a plank back up right at the start of the vault (<15%), abort back to tearing!
          if (planksLeft > 0 && z.vaultT < 0.16) {
            z.entryStage = 'tear';
            z.tearTimer = scaledTearSec * 0.85;
            z.pos.copy(z.windowOuterPos);
            z.root.position.copy(z.pos);
            continue;
          }

          const vaultDur = Math.max(0.62, ZOMBIE_WINDOW_VAULT_SEC / Math.max(0.85, this.zombieMoveSpeedMult));
          z.vaultT = Math.min(1, z.vaultT + dt / vaultDur);
          const t = z.vaultT;

          // Smooth 3-stage physical climb & vault over the window sill:
          // [0..0.38] Hoist onto window sill, [0.38..0.74] Swing body/legs cleanly over sill, [0.74..1.0] Land inside room
          const sillPeakY = z.sillPos.y + 0.14;
          if (t < 0.38) {
            const u = t / 0.38;
            const ease = u * u * (3 - 2 * u);
            z.pos.x = THREE.MathUtils.lerp(z.vaultStartPos.x, z.sillPos.x, ease * 0.72);
            z.pos.z = THREE.MathUtils.lerp(z.vaultStartPos.z, z.sillPos.z, ease * 0.72);
            z.pos.y = THREE.MathUtils.lerp(z.vaultStartPos.y, sillPeakY, ease);
          } else if (t < 0.74) {
            const u = (t - 0.38) / 0.36;
            const ease = u * u * (3 - 2 * u);
            const midX = THREE.MathUtils.lerp(z.sillPos.x, z.entryPos.x, 0.52);
            const midZ = THREE.MathUtils.lerp(z.sillPos.z, z.entryPos.z, 0.52);
            z.pos.x = THREE.MathUtils.lerp(THREE.MathUtils.lerp(z.vaultStartPos.x, z.sillPos.x, 0.72), midX, ease);
            z.pos.z = THREE.MathUtils.lerp(THREE.MathUtils.lerp(z.vaultStartPos.z, z.sillPos.z, 0.72), midZ, ease);
            // Keep hips cleanly above sill top with slight apex arc
            z.pos.y = sillPeakY + Math.sin(u * Math.PI) * 0.18;
          } else {
            const u = (t - 0.74) / 0.26;
            const ease = u * u * (3 - 2 * u);
            const midX = THREE.MathUtils.lerp(z.sillPos.x, z.entryPos.x, 0.52);
            const midZ = THREE.MathUtils.lerp(z.sillPos.z, z.entryPos.z, 0.52);
            z.pos.x = THREE.MathUtils.lerp(midX, z.entryPos.x, ease);
            z.pos.z = THREE.MathUtils.lerp(midZ, z.entryPos.z, ease);
            z.pos.y = THREE.MathUtils.lerp(sillPeakY, z.entryPos.y, ease);
          }

          const faceX = z.entryPos.x - z.sillPos.x;
          const faceZ = z.entryPos.z - z.sillPos.z;
          z.yaw = Math.atan2(-faceX, -faceZ);
          z.root.position.copy(z.pos);
          z.root.rotation.set(0, z.yaw, 0);

          this._poseInput.mode = 'vault';
          this._poseInput.walkCycle = z.walkCycle;
          this._poseInput.speedMps = 0;
          this._poseInput.tearPhase = 0;
          this._poseInput.vaultT = t;
          this._poseInput.windupProgress = 0;
          this._poseInput.staggerRatio = 0;
          this._poseInput.deathProgress = 0;
          this._poseInput.elapsedSec = this.elapsedSec;
          this._poseInput.dt = dt;
          this._poseInput.gazeTargetWorld = playerPos;
          this._poseInput.distanceToCameraM = Math.hypot(
            z.pos.x - playerPos.x,
            z.pos.y - playerPos.y,
            z.pos.z - playerPos.z,
          );
          this._poseInput.isVisible = z.root.visible;
          this.rigLib.applyPose(z.rig, this._poseInput);

          if (z.vaultT >= 1) {
            z.pos.copy(z.entryPos);
            z.entryStage = 'pursue';
            z.enteringWindow = false;
            z.repathTimer = 0;
            z.lastProgressX = z.pos.x;
            z.lastProgressZ = z.pos.z;
            z.stuckTimer = 0;
            this._tmpAudioPos.copy(z.entryPos);
            this.audio.playImpact(this._tmpAudioPos, 'wood');
          }
          continue;
        }
      }

      // === INTERIOR PURSUIT & REFINED PATHFINDING ===
      let nearestTarget: InfectionHumanTarget | null = null;
      let nearestDistSq = Infinity;
      for (let s = 0; s < aliveSurvivors.length; s++) {
        const sv = aliveSurvivors[s];
        const dx = sv.pos.x - z.pos.x;
        const dy = (sv.pos.y - z.pos.y) * 1.4;
        const dz = sv.pos.z - z.pos.z;
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearestTarget = sv;
        }
      }

      if (nearestTarget) {
        const targetPos = nearestTarget.pos;
        const dxP = targetPos.x - z.pos.x;
        const dyP = Math.abs(targetPos.y - z.pos.y);
        const dzP = targetPos.z - z.pos.z;
        const distToPlayer = Math.hypot(dxP, dzP);

        if (z.windupTimer > 0) {
          z.windupTimer -= dt;
          z.yaw = Math.atan2(-dxP, -dzP);

          if (z.windupTimer <= 0) {
            z.attackCooldown = scaledCooldown;
            if (distToPlayer <= ZOMBIE_ATTACK_RANGE + 0.35 && dyP < 1.65) {
              onDamagePlayer(ZOMBIE_ATTACK_DAMAGE, z.pos.clone(), nearestTarget.id);
              this.audio.playImpact(targetPos, 'wood');
            }
          }
        } else if (distToPlayer <= ZOMBIE_ATTACK_RANGE && dyP < 1.5 && z.attackCooldown <= 0 && z.staggerTimer <= 0) {
          z.windupTimer = scaledWindup;
          this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
          this.audio.playZombieVocal(this._tmpAudioPos, 'lunge', {
            pitchScale: z.voicePitchScale,
            intensity: 1.25,
          });
          z.snarlCooldownSec = Math.max(z.snarlCooldownSec, 1.4);
        } else if (z.staggerTimer <= 0) {
          let steerX = dxP;
          let steerZ = dzP;

          // Direct pursuit only when close, same elevation, AND unobstructed walkable line!
          const canChaseDirect =
            distToPlayer < 6.5 &&
            dyP < 0.75 &&
            this.isWalkSegmentClear(z.pos.x, z.pos.z, targetPos.x, targetPos.z, z.pos.y, ZOMBIE_RADIUS * 0.92);

          if (!canChaseDirect) {
            z.repathTimer -= dt;
            if (z.repathTimer <= 0 || z.pathIndex >= z.path.length) {
              z.repathTimer = 0.48 + Math.random() * 0.28;
              const startNode = findNearestNavNode(
                this.map.navGraph,
                z.pos,
                this.unlockedZones,
                this.openedDoors,
              );
              const goalNode = findNearestNavNode(
                this.map.navGraph,
                targetPos,
                this.unlockedZones,
                this.openedDoors,
              );
              if (startNode && goalNode) {
                z.path = this.findDoorSafePath(startNode.id, goalNode.id);
                z.pathIndex = z.path.length > 1 ? 1 : 0;
              }
            }

            // String-pulling: skip redundant intermediate waypoint if next waypoint has clear walkable corridor & close elevation
            while (z.pathIndex + 1 < z.path.length) {
              const curWp = z.path[z.pathIndex];
              const nextWp = z.path[z.pathIndex + 1];
              const dyNext = Math.abs(nextWp.position[1] - z.pos.y);
              const dyCur = Math.abs(curWp.position[1] - z.pos.y);
              if (
                dyNext < 0.85 &&
                dyCur < 0.85 &&
                this.isWalkSegmentClear(
                  z.pos.x,
                  z.pos.z,
                  nextWp.position[0],
                  nextWp.position[2],
                  z.pos.y,
                  ZOMBIE_RADIUS * 0.95,
                )
              ) {
                z.pathIndex++;
              } else {
                break;
              }
            }

            if (z.pathIndex < z.path.length) {
              const wp = z.path[z.pathIndex];
              const wx = wp.position[0] - z.pos.x;
              const wz = wp.position[2] - z.pos.z;
              const wd = Math.hypot(wx, wz);
              if (wd < 0.85) {
                z.pathIndex++;
              } else {
                steerX = wx;
                steerZ = wz;
              }
            }
          }

          let sLen = Math.hypot(steerX, steerZ);
          if (sLen > 0.05) {
            let dirX = steerX / sLen;
            let dirZ = steerZ / sLen;

            // Local obstacle-avoidance whiskers (prevents getting caught on ticket kiosk, seat rows, pillars)
            const probeDist = 0.85;
            const fwdBlocked = this.isPointBlockedXZ(
              z.pos.x + dirX * probeDist,
              z.pos.z + dirZ * probeDist,
              z.pos.y,
              ZOMBIE_RADIUS * 0.92,
            );
            if (fwdBlocked || z.unstuckBoostTimer > 0) {
              const cosA = 0.78;
              const sinA = 0.62;
              const leftX = dirX * cosA - dirZ * sinA;
              const leftZ = dirX * sinA + dirZ * cosA;
              const rightX = dirX * cosA + dirZ * sinA;
              const rightZ = -dirX * sinA + dirZ * cosA;

              const leftClear = !this.isPointBlockedXZ(
                z.pos.x + leftX * probeDist,
                z.pos.z + leftZ * probeDist,
                z.pos.y,
                ZOMBIE_RADIUS * 0.88,
              );
              const rightClear = !this.isPointBlockedXZ(
                z.pos.x + rightX * probeDist,
                z.pos.z + rightZ * probeDist,
                z.pos.y,
                ZOMBIE_RADIUS * 0.88,
              );

              if (leftClear && !rightClear) {
                dirX = leftX;
                dirZ = leftZ;
                z.avoidDir = 1;
              } else if (rightClear && !leftClear) {
                dirX = rightX;
                dirZ = rightZ;
                z.avoidDir = -1;
              } else {
                // Both or neither clear: steer perpendicular along preferred avoidDir
                const perpX = -dirZ * z.avoidDir;
                const perpZ = dirX * z.avoidDir;
                dirX = dirX * 0.35 + perpX * 0.65;
                dirZ = dirZ * 0.35 + perpZ * 0.65;
                const nl = Math.hypot(dirX, dirZ) || 1;
                dirX /= nl;
                dirZ /= nl;
              }
            }

            moveX += dirX * z.speed;
            moveZ += dirZ * z.speed;
            const desiredYaw = Math.atan2(-dirX, -dirZ);
            let dyaw = desiredYaw - z.yaw;
            while (dyaw > Math.PI) dyaw -= Math.PI * 2;
            while (dyaw < -Math.PI) dyaw += Math.PI * 2;
            z.yaw += dyaw * Math.min(1, dt * 8.5);
          }

          // Stuck detection & automatic recovery
          z.stuckTimer += dt;
          if (z.stuckTimer >= 0.55) {
            const moved = Math.hypot(z.pos.x - z.lastProgressX, z.pos.z - z.lastProgressZ);
            z.lastProgressX = z.pos.x;
            z.lastProgressZ = z.pos.z;
            z.stuckTimer = 0;
            if (moved < 0.16 && distToPlayer > ZOMBIE_ATTACK_RANGE + 0.25) {
              z.avoidDir = -z.avoidDir;
              z.unstuckBoostTimer = 0.55;
              z.repathTimer = 0;
            }
          }
        }
      }

      // Zombie-zombie crowd separation (only among interior pursuing zombies)
      for (let j = 0; j < this.zombies.length; j++) {
        if (i === j) continue;
        const o = this.zombies[j];
        if (!o.alive || o.entryStage !== 'pursue') continue;
        const sx = z.pos.x - o.pos.x;
        const sz = z.pos.z - o.pos.z;
        const dSq = sx * sx + sz * sz;
        if (dSq > 1e-4 && dSq < 0.85) {
          const d = Math.sqrt(dSq);
          const push = (0.92 - d) * 3.4;
          moveX += (sx / d) * push;
          moveZ += (sz / d) * push;
        }
      }

      // Integrate position & collide with solid world boxes
      const nextX = z.pos.x + moveX * dt;
      const nextZ = z.pos.z + moveZ * dt;
      const res = this.resolveZombieXZ(nextX, z.pos.y, nextZ);
      z.pos.x = res.x;
      z.pos.z = res.z;

      const groundY = this.map.physics.getGroundHeight(z.pos.x, z.pos.z, z.pos.y, 0.85, 0.14);
      z.pos.y = THREE.MathUtils.damp(z.pos.y, groundY, 14, dt);

      // Anatomical shamble / sprint / melee windup / hit stagger pose
      const spd = Math.hypot(moveX, moveZ);
      z.lastSpeedMps = spd;
      z.walkCycle += dt * Math.max(1.2, spd * 2.9);

      const windupProgress =
        z.windupTimer > 0 ? THREE.MathUtils.clamp(1 - z.windupTimer / Math.max(0.05, scaledWindup), 0, 1) : 0;
      const staggerRatio = z.staggerTimer > 0 ? Math.min(1, z.staggerTimer / 0.35) : 0;

      z.root.position.copy(z.pos);
      z.root.rotation.set(0, z.yaw, 0);

      this._poseInput.mode =
        windupProgress > 0.01 ? 'windup' : staggerRatio > 0.05 ? 'stagger' : 'locomote';
      this._poseInput.walkCycle = z.walkCycle;
      this._poseInput.speedMps = spd;
      this._poseInput.tearPhase = 0;
      this._poseInput.vaultT = 0;
      this._poseInput.windupProgress = windupProgress;
      this._poseInput.staggerRatio = staggerRatio;
      this._poseInput.deathProgress = 0;
      this._poseInput.elapsedSec = this.elapsedSec;
      this._poseInput.dt = dt;
      this._poseInput.gazeTargetWorld = nearestTarget ? nearestTarget.pos : playerPos;
      this._poseInput.distanceToCameraM = Math.hypot(
        z.pos.x - playerPos.x,
        z.pos.y - playerPos.y,
        z.pos.z - playerPos.z,
      );
      this._poseInput.isVisible = z.root.visible;
      this.rigLib.applyPose(z.rig, this._poseInput);
    }

    // 4. Distance-prioritized horror-mix spatial audio scheduler (6 closest zombies)
    this.updateSpatialZombieAudio(dt, playerPos);
  }

  /**
   * Zero-GC distance-prioritized HRTF horror audio scheduler:
   * Ranks active zombies by distance to the local listener so the 6 closest threats
   * claim crisp proximity-scaled snarls, groans, moans, and stride-synced footsteps
   * without overwhelming Web Audio convolution during high rounds.
   */
  private updateSpatialZombieAudio(dt: number, listenerPos: Readonly<THREE.Vector3>): void {
    const count = this.zombies.length;
    if (count === 0) return;

    this._audioIndices.length = 0;
    this._audioDists.length = 0;

    for (let i = 0; i < count; i++) {
      const z = this.zombies[i];
      if (!z.alive) continue;

      if (z.vocalCooldownSec > 0) z.vocalCooldownSec = Math.max(0, z.vocalCooldownSec - dt);
      if (z.snarlCooldownSec > 0) z.snarlCooldownSec = Math.max(0, z.snarlCooldownSec - dt);
      if (z.hurtAudioCooldownSec > 0) z.hurtAudioCooldownSec = Math.max(0, z.hurtAudioCooldownSec - dt);

      const dx = z.pos.x - listenerPos.x;
      const dy = z.pos.y - listenerPos.y;
      const dz = z.pos.z - listenerPos.z;
      const dist = Math.hypot(dx, dy, dz);

      if (dist <= 35) {
        this._audioIndices.push(i);
        this._audioDists.push(dist);
      } else {
        // Keep step phase synchronized so distant zombies don't burst-step upon entering range
        z.prevWalkStepIndex = Math.floor(z.walkCycle / Math.PI);
        z.wasInWindup = this.isClientReplica ? z.netWindup : z.windupTimer > 0;
      }
    }

    const candCount = this._audioIndices.length;
    if (candCount === 0) return;

    // Partial selection sort for up to 6 closest infected (zero allocations)
    const maxBudget = Math.min(6, candCount);
    for (let k = 0; k < maxBudget; k++) {
      let minPos = k;
      let minDist = this._audioDists[k];
      for (let j = k + 1; j < candCount; j++) {
        if (this._audioDists[j] < minDist) {
          minDist = this._audioDists[j];
          minPos = j;
        }
      }
      if (minPos !== k) {
        const tmpIdx = this._audioIndices[k];
        this._audioIndices[k] = this._audioIndices[minPos];
        this._audioIndices[minPos] = tmpIdx;
        const tmpD = this._audioDists[k];
        this._audioDists[k] = this._audioDists[minPos];
        this._audioDists[minPos] = tmpD;
      }
    }

    // Keep non-budgeted candidates' stride index synced
    for (let k = maxBudget; k < candCount; k++) {
      const z = this.zombies[this._audioIndices[k]];
      z.prevWalkStepIndex = Math.floor(z.walkCycle / Math.PI);
      z.wasInWindup = this.isClientReplica ? z.netWindup : z.windupTimer > 0;
    }

    for (let k = 0; k < maxBudget; k++) {
      const z = this.zombies[this._audioIndices[k]];
      const dist = this._audioDists[k];

      // 1. Client-replica lunge shriek detection on attack windup edge
      const inWindup = this.isClientReplica ? z.netWindup : z.windupTimer > 0;
      if (this.isClientReplica && inWindup && !z.wasInWindup && dist < 18) {
        this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
        this.audio.playZombieVocal(this._tmpAudioPos, 'lunge', {
          distanceM: dist,
          pitchScale: z.voicePitchScale,
          intensity: 1.25,
        });
        z.snarlCooldownSec = Math.max(z.snarlCooldownSec, 1.4);
      }
      z.wasInWindup = inWindup;

      // 2. Stride-synced spatial footsteps (heavier stomps when sprinting, dragging scuff when shambling)
      const stepIdx = Math.floor(z.walkCycle / Math.PI);
      if (stepIdx !== z.prevWalkStepIndex) {
        z.prevWalkStepIndex = stepIdx;
        const isWalking =
          (z.entryStage === 'pursue' || z.entryStage === 'approach') && z.lastSpeedMps > 0.35;
        if (isWalking && dist < 22) {
          this._tmpAudioPos.set(z.pos.x, z.pos.y + 0.08, z.pos.z);
          this.audio.playZombieFootstep(this._tmpAudioPos, {
            distanceM: dist,
            speedMps: z.lastSpeedMps,
            surface: z.entryStage === 'approach' ? 'wood' : 'concrete',
            isDrag: z.lastSpeedMps < 2.25 && (stepIdx & 1) === 1,
          });
        }
      }

      // 3. Close-range aggressive horror snarl override (< 6.8m)
      if (dist < 6.8 && z.snarlCooldownSec <= 0) {
        this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
        this.audio.playZombieVocal(this._tmpAudioPos, 'snarl', {
          distanceM: dist,
          pitchScale: z.voicePitchScale,
          intensity: dist < 3.6 ? 1.28 : 1.08,
        });
        z.snarlCooldownSec = 1.65 + Math.random() * 1.85;
        z.vocalCooldownSec = Math.max(z.vocalCooldownSec, 1.35);
        continue;
      }

      // 4. Proximity-escalating moans & raspy groans (close -> mid -> distant corridor dread)
      if (z.vocalCooldownSec <= 0) {
        this._tmpAudioPos.set(z.pos.x, z.pos.y + 1.5, z.pos.z);
        if (dist < 7.2) {
          this.audio.playZombieVocal(this._tmpAudioPos, 'snarl', {
            distanceM: dist,
            pitchScale: z.voicePitchScale,
            intensity: 1.12,
          });
          z.vocalCooldownSec = 1.9 + Math.random() * 1.7;
          z.snarlCooldownSec = Math.max(z.snarlCooldownSec, 1.5);
        } else if (dist < 16.5 || z.entryStage === 'tear' || z.entryStage === 'vault') {
          this.audio.playZombieVocal(this._tmpAudioPos, 'groan', {
            distanceM: dist,
            pitchScale: z.voicePitchScale,
            intensity: 1.0,
          });
          z.vocalCooldownSec = 2.8 + Math.random() * 2.5;
        } else {
          this.audio.playZombieVocal(this._tmpAudioPos, 'moan', {
            distanceM: dist,
            pitchScale: z.voicePitchScale,
            intensity: 0.92,
          });
          z.vocalCooldownSec = 4.4 + Math.random() * 3.8;
        }
      }
    }
  }

  private resolveZombieXZ(x: number, baseY: number, z: number): { x: number; z: number } {
    let cx = THREE.MathUtils.clamp(x, this.map.physics.boundsMinX + 0.5, this.map.physics.boundsMaxX - 0.5);
    let cz = THREE.MathUtils.clamp(z, this.map.physics.boundsMinZ + 0.5, this.map.physics.boundsMaxZ - 0.5);
    const r = ZOMBIE_RADIUS;
    const rSq = r * r;
    const pyMin = baseY + 0.38;
    const pyMax = baseY + 1.65;

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
            // Inside AABB: push out nearest face cleanly
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

  public dispose(): void {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

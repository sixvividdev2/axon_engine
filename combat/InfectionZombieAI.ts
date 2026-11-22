import * as THREE from 'three';
import { BodycamAudio } from '../bodycam-sdk';
import {
  BuiltMapInstance,
  findNavPath,
  findNearestNavNode,
  NavNode,
  ZombieSpawnerDef,
} from '../maps/types';
import {
  GameZombieSpawnPacket,
  GameZombiesSyncPacket,
  SyncedZombieState,
} from '../data/multiplayer';

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

  // Spawner climb-in phase before entering navGraph
  enteringWindow: boolean;
  spawnerId: string | null;
  entryPos: THREE.Vector3;

  // Navigation
  path: NavNode[];
  pathIndex: number;
  repathTimer: number;

  // Melee attack
  windupTimer: number;
  attackCooldown: number;
  deathTimer: number;
  dying: boolean;

  // Visuals
  root: THREE.Group;
  bodyPivot: THREE.Group;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
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

// Explicit doorway edges in Der Lichtspielhaus gated by individual doors (even if auditorium is unlocked from opposite wing)
const DOOR_GATED_EDGES: ReadonlyArray<[string, string, string]> = [
  ['ww_n', 'aud_pit_w', 'door_west_auditorium'],
  ['ew_n', 'aud_pit_e', 'door_east_auditorium'],
  ['lob_w_up', 'proj_ramp', 'door_projector'],
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

  // Pooled blood-burst particles (InstancedMesh = 1 draw call)
  private readonly bloodParticles: BloodBurstParticle[] = [];
  private readonly bloodInstanced: THREE.InstancedMesh;
  private bloodCursor = 0;
  private readonly _mat4 = new THREE.Matrix4();
  private readonly _quat = new THREE.Quaternion();
  private readonly _scale = new THREE.Vector3();
  private readonly _zeroScale = new THREE.Vector3(0, 0, 0);

  // Shared zombie geometries/materials
  private readonly geoLeg: THREE.BoxGeometry;
  private readonly geoTorso: THREE.BoxGeometry;
  private readonly geoHead: THREE.BoxGeometry;
  private readonly geoArm: THREE.BoxGeometry;
  private readonly geoEye: THREE.BoxGeometry;
  private readonly matSkin: THREE.MeshStandardMaterial;
  private readonly matClothesA: THREE.MeshStandardMaterial;
  private readonly matClothesB: THREE.MeshStandardMaterial;
  private readonly matBlood: THREE.MeshStandardMaterial;
  private readonly matEye: THREE.MeshBasicMaterial;

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

    scene.add(this.group);

    this.geoLeg = this.track(new THREE.BoxGeometry(0.16, 0.74, 0.17));
    this.geoTorso = this.track(new THREE.BoxGeometry(0.42, 0.58, 0.24));
    this.geoHead = this.track(new THREE.BoxGeometry(0.23, 0.26, 0.24));
    this.geoArm = this.track(new THREE.BoxGeometry(0.11, 0.56, 0.12));
    this.geoEye = this.track(new THREE.BoxGeometry(0.042, 0.028, 0.02));

    this.matSkin = this.track(
      new THREE.MeshStandardMaterial({ color: 0x7c8476, roughness: 0.9, metalness: 0.02 }),
    );
    this.matClothesA = this.track(
      new THREE.MeshStandardMaterial({ color: 0x2a2726, roughness: 0.94, metalness: 0.0 }),
    );
    this.matClothesB = this.track(
      new THREE.MeshStandardMaterial({ color: 0x3b2c2a, roughness: 0.94, metalness: 0.0 }),
    );
    this.matBlood = this.track(
      new THREE.MeshStandardMaterial({ color: 0x5c1111, roughness: 0.65, metalness: 0.05 }),
    );
    this.matEye = this.track(new THREE.MeshBasicMaterial({ color: 0xffaa2b }));

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

    // Subtle spatial wood-window breach cue at the entry point
    this.audio.playImpact(
      new THREE.Vector3(pkt.entryPos[0], pkt.entryPos[1] + 1.0, pkt.entryPos[2]),
      'wood',
    );
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
    }
    this.spawnBloodBurst(impactPoint, headshot ? 9 : 5);
  }

  public playVisualDeath(zombieId: string, point?: Readonly<THREE.Vector3>): void {
    const z = this.zombies.find((item) => item.id === zombieId);
    if (z && z.alive) {
      z.alive = false;
      z.dying = true;
      z.deathTimer = 0;
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
    const clothesMat = Math.random() < 0.5 ? this.matClothesA : this.matClothesB;

    const root = new THREE.Group();
    const bodyPivot = new THREE.Group();
    root.add(bodyPivot);

    const leftLeg = new THREE.Mesh(this.geoLeg, clothesMat);
    leftLeg.position.set(-0.11, 0.37, 0);
    leftLeg.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'limb', surfaceMaterial: 'wood' };

    const rightLeg = new THREE.Mesh(this.geoLeg, clothesMat);
    rightLeg.position.set(0.11, 0.37, 0);
    rightLeg.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'limb', surfaceMaterial: 'wood' };

    // Hunched torso
    const torso = new THREE.Mesh(this.geoTorso, clothesMat);
    torso.position.set(0, 1.04, -0.05);
    torso.rotation.x = 0.18;
    torso.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'thorax', surfaceMaterial: 'wood' };

    const stain = new THREE.Mesh(this.geoTorso, this.matBlood);
    stain.scale.set(0.75, 0.55, 1.04);
    stain.position.set(0, 1.02, -0.06);
    stain.rotation.x = 0.18;

    const head = new THREE.Mesh(this.geoHead, this.matSkin);
    head.position.set(0, 1.48, -0.14);
    head.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'head', surfaceMaterial: 'wood' };

    const eyeL = new THREE.Mesh(this.geoEye, this.matEye);
    eyeL.position.set(-0.055, 1.5, -0.265);
    const eyeR = new THREE.Mesh(this.geoEye, this.matEye);
    eyeR.position.set(0.055, 1.5, -0.265);

    // Outstretched grasping arms
    const leftArm = new THREE.Mesh(this.geoArm, this.matSkin);
    leftArm.position.set(-0.26, 1.18, -0.26);
    leftArm.rotation.x = Math.PI * 0.44;
    leftArm.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'limb', surfaceMaterial: 'wood' };

    const rightArm = new THREE.Mesh(this.geoArm, this.matSkin);
    rightArm.position.set(0.26, 1.18, -0.26);
    rightArm.rotation.x = Math.PI * 0.44;
    rightArm.userData = { combatActorType: 'zombie', actorId: id, hitZone: 'limb', surfaceMaterial: 'wood' };

    bodyPivot.add(leftLeg, rightLeg, torso, stain, head, eyeL, eyeR, leftArm, rightArm);
    this.group.add(root);

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
      enteringWindow,
      spawnerId,
      entryPos: entryPos
        ? new THREE.Vector3(entryPos[0], entryPos[1], entryPos[2])
        : new THREE.Vector3(sx, sy, sz),
      path: [],
      pathIndex: 0,
      repathTimer: 0.1,
      windupTimer: 0,
      attackCooldown: 0.4,
      deathTimer: 0,
      dying: false,
      root,
      bodyPivot,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      hitMeshes: [leftLeg, rightLeg, torso, head, leftArm, rightArm],
    };

    root.position.copy(z.pos);
    root.rotation.set(0, z.yaw, 0);
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
    const z = this.createZombieActor(
      id,
      maxHp,
      speed,
      spawner.spawnPos[0],
      spawner.spawnPos[1],
      spawner.spawnPos[2],
      spawner.yaw,
      true,
      spawner.entryPos,
      spawner.id,
    );

    this.zombies.push(z);
    this.toSpawnThisRound = Math.max(0, this.toSpawnThisRound - 1);
    this.rebuildActiveHitMeshes();

    onZombieSpawn?.({
      type: 'game:zombie_spawn',
      zombieId: id,
      spawnerId: spawner.id,
      zoneId: spawner.zoneId,
      maxHp,
      x: Number(spawner.spawnPos[0].toFixed(3)),
      y: Number(spawner.spawnPos[1].toFixed(3)),
      z: Number(spawner.spawnPos[2].toFixed(3)),
      yaw: Number(spawner.yaw.toFixed(4)),
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

    return { hit: true, killed: false, headshot: false, pointsAwarded: 20 };
  }

  private killZombie(z: ZombieActor): void {
    z.alive = false;
    z.dying = true;
    z.deathTimer = 0;
    this.killedThisRound += 1;
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

  public update(
    dt: number,
    playerPos: Readonly<THREE.Vector3>,
    playerAlive: boolean,
    onDamagePlayer: (damage: number, attackerPos: THREE.Vector3, targetUserId?: string) => void,
    onRoundComplete: (completedRound: number, bonusPoints: number) => void,
    humanTargets?: InfectionHumanTarget[],
    onZombieSpawn?: (pkt: GameZombieSpawnPacket) => void,
  ): void {
    // 1. Update blood burst InstancedMesh
    let anyBloodMoved = false;
    for (let i = 0; i < this.bloodParticles.length; i++) {
      const p = this.bloodParticles[i];
      if (!p.active) continue;
      anyBloodMoved = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this._mat4.compose(new THREE.Vector3(0, -50, 0), this._quat, this._zeroScale);
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
          const fallT = Math.min(1, z.deathTimer / 0.42);
          z.bodyPivot.rotation.x = -fallT * (Math.PI * 0.48);
          z.bodyPivot.position.y = -fallT * 0.15;
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

        z.walkCycle += dt * Math.max(1.2, spd * 2.9);
        const stride = Math.min(0.65, spd * 0.18);
        z.leftLeg.rotation.x = Math.sin(z.walkCycle) * stride;
        z.rightLeg.rotation.x = -Math.sin(z.walkCycle) * stride;

        if (z.netWindup) {
          z.leftArm.rotation.x = Math.PI * 0.78;
          z.rightArm.rotation.x = Math.PI * 0.78;
        } else if (z.enteringWindow) {
          // Climbing through barricaded window frame
          z.leftArm.rotation.x = Math.PI * 0.62 + Math.sin(z.walkCycle * 1.4) * 0.22;
          z.rightArm.rotation.x = Math.PI * 0.62 - Math.sin(z.walkCycle * 1.4) * 0.22;
        } else {
          z.leftArm.rotation.x = Math.PI * 0.44 + Math.sin(z.walkCycle) * 0.18;
          z.rightArm.rotation.x = Math.PI * 0.44 - Math.sin(z.walkCycle) * 0.18;
        }

        const staggerLean = z.staggerTimer > 0 || z.netStagger ? -0.22 : z.enteringWindow ? 0.16 : 0;
        const swayRoll = Math.sin(z.walkCycle * 0.5) * 0.08;
        z.bodyPivot.rotation.set(staggerLean, 0, swayRoll);
        z.root.position.copy(z.pos);
        z.root.rotation.set(0, z.yaw, 0);
      }
      return;
    }

    // Build list of living human survivors (Host + co-op squadmates)
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
        // Faster spawn cadence on higher rounds
        this.spawnTimer = Math.max(0.45, (2.05 - this.round * 0.14) / Math.sqrt(this.zombieSpawnAmountMult));
      }
    } else if (this.toSpawnThisRound === 0 && activeAlive === 0 && anySurvivorAlive) {
      // Round cleared!
      const bonus = this.round * 100;
      onRoundComplete(this.round, bonus);
      this.intermissionSec = this.waveBreakIntervalSec;
    }

    const scaledWindup = ZOMBIE_ATTACK_WINDUP / this.zombieAttackSpeedMult;
    const scaledCooldown = ZOMBIE_ATTACK_COOLDOWN / this.zombieAttackSpeedMult;

    // 3. Step all zombies
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];

      if (!z.alive) {
        z.deathTimer += dt;
        const fallT = Math.min(1, z.deathTimer / 0.42);
        z.bodyPivot.rotation.x = -fallT * (Math.PI * 0.48);
        z.bodyPivot.position.y = -fallT * 0.15;
        if (z.deathTimer > 3.2) {
          this.group.remove(z.root);
          this.zombies.splice(i, 1);
        }
        continue;
      }

      if (z.attackCooldown > 0) z.attackCooldown = Math.max(0, z.attackCooldown - dt);
      if (z.staggerTimer > 0) z.staggerTimer = Math.max(0, z.staggerTimer - dt);

      // Exponentially damp horizontal knockback
      const kbDamp = Math.exp(-7.5 * dt);
      z.knockbackVelX *= kbDamp;
      z.knockbackVelZ *= kbDamp;

      let moveX = z.knockbackVelX;
      let moveZ = z.knockbackVelZ;

      // Choose nearest living survivor for pursuit & melee strikes
      let nearestTarget: InfectionHumanTarget | null = null;
      let nearestDistSq = Infinity;
      for (let s = 0; s < aliveSurvivors.length; s++) {
        const sv = aliveSurvivors[s];
        const dx = sv.pos.x - z.pos.x;
        const dz = sv.pos.z - z.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearestTarget = sv;
        }
      }

      if (z.enteringWindow) {
        // Step through barricaded window into interior entryPos
        const dx = z.entryPos.x - z.pos.x;
        const dz = z.entryPos.z - z.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.42) {
          z.enteringWindow = false;
          z.repathTimer = 0;
        } else {
          const climbSpd = Math.max(1.5, z.speed * 0.72);
          moveX += (dx / dist) * climbSpd;
          moveZ += (dz / dist) * climbSpd;
          z.yaw = Math.atan2(-dx, -dz);
        }
      } else if (nearestTarget) {
        const targetPos = nearestTarget.pos;
        const dxP = targetPos.x - z.pos.x;
        const dyP = Math.abs(targetPos.y - z.pos.y);
        const dzP = targetPos.z - z.pos.z;
        const distToPlayer = Math.hypot(dxP, dzP);

        // Melee windup & hit execution
        if (z.windupTimer > 0) {
          z.windupTimer -= dt;
          z.yaw = Math.atan2(-dxP, -dzP);
          // Raise arms during windup lunge
          z.leftArm.rotation.x = Math.PI * 0.78;
          z.rightArm.rotation.x = Math.PI * 0.78;

          if (z.windupTimer <= 0) {
            z.attackCooldown = scaledCooldown;
            if (distToPlayer <= ZOMBIE_ATTACK_RANGE + 0.35 && dyP < 1.65) {
              onDamagePlayer(ZOMBIE_ATTACK_DAMAGE, z.pos.clone(), nearestTarget.id);
              this.audio.playImpact(targetPos, 'wood');
            }
          }
        } else if (distToPlayer <= ZOMBIE_ATTACK_RANGE && dyP < 1.5 && z.attackCooldown <= 0 && z.staggerTimer <= 0) {
          z.windupTimer = scaledWindup;
        } else if (z.staggerTimer <= 0) {
          // Navigate directly if very close on same level, otherwise follow door-safe NavGraph
          let steerX = dxP;
          let steerZ = dzP;

          if (distToPlayer > 4.2 || dyP > 0.9) {
            z.repathTimer -= dt;
            if (z.repathTimer <= 0 || z.pathIndex >= z.path.length) {
              z.repathTimer = 0.55 + Math.random() * 0.35;
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

            if (z.pathIndex < z.path.length) {
              const wp = z.path[z.pathIndex];
              const wx = wp.position[0] - z.pos.x;
              const wz = wp.position[2] - z.pos.z;
              const wd = Math.hypot(wx, wz);
              if (wd < 0.9) {
                z.pathIndex++;
              } else {
                steerX = wx;
                steerZ = wz;
              }
            }
          }

          const sLen = Math.hypot(steerX, steerZ);
          if (sLen > 0.05) {
            moveX += (steerX / sLen) * z.speed;
            moveZ += (steerZ / sLen) * z.speed;
            const desiredYaw = Math.atan2(-steerX, -steerZ);
            let dyaw = desiredYaw - z.yaw;
            while (dyaw > Math.PI) dyaw -= Math.PI * 2;
            while (dyaw < -Math.PI) dyaw += Math.PI * 2;
            z.yaw += dyaw * Math.min(1, dt * 8.5);
          }
        }
      }

      // Zombie-zombie crowd separation (prevents stacking into 1 mesh)
      for (let j = 0; j < this.zombies.length; j++) {
        if (i === j) continue;
        const o = this.zombies[j];
        if (!o.alive) continue;
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

      // Integrate position & collide with solid world boxes (skip while climbing through spawn window)
      const nextX = z.pos.x + moveX * dt;
      const nextZ = z.pos.z + moveZ * dt;
      if (z.enteringWindow) {
        z.pos.x = nextX;
        z.pos.z = nextZ;
      } else {
        const res = this.resolveZombieXZ(nextX, z.pos.y, nextZ);
        z.pos.x = res.x;
        z.pos.z = res.z;
      }

      const groundY = this.map.physics.getGroundHeight(z.pos.x, z.pos.z, z.pos.y, 0.85, 0.14);
      z.pos.y = THREE.MathUtils.damp(z.pos.y, groundY, 14, dt);

      // Shamble / sprint animation
      const spd = Math.hypot(moveX, moveZ);
      z.walkCycle += dt * Math.max(1.2, spd * 2.9);
      const stride = Math.min(0.65, spd * 0.18);
      z.leftLeg.rotation.x = Math.sin(z.walkCycle) * stride;
      z.rightLeg.rotation.x = -Math.sin(z.walkCycle) * stride;

      if (z.windupTimer <= 0) {
        z.leftArm.rotation.x = Math.PI * 0.44 + Math.sin(z.walkCycle) * 0.18;
        z.rightArm.rotation.x = Math.PI * 0.44 - Math.sin(z.walkCycle) * 0.18;
      }

      const staggerLean = z.staggerTimer > 0 ? -0.25 * (z.staggerTimer / 0.35) : 0;
      const swayRoll = Math.sin(z.walkCycle * 0.5) * 0.08;
      z.bodyPivot.rotation.set(staggerLean, 0, swayRoll);

      z.root.position.copy(z.pos);
      z.root.rotation.set(0, z.yaw, 0);
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

  public dispose(): void {
    this.group.parent?.remove(this.group);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

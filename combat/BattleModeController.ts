import * as THREE from 'three';
import {
  GameDogtagEventPacket,
  GameFlagEventPacket,
  GameModeStatePacket,
  SyncedConquestPoiState,
  SyncedCtfFlagState,
  SyncedDogtagState,
} from '../data/multiplayer';
import {
  BattleRuleId,
  BuiltMapInstance,
  ConquestPoiDef,
  ConquestPoiKind,
  getDefaultMatchDurationSecForRule,
  getDefaultScoreLimitForRule,
  isKillConfirmedRule,
  isTeamBattleRule,
  KothHillDef,
  MapBattleObjectives,
  SpawnPoint,
} from '../maps/types';

export interface ModeActorSample {
  id: string;
  name: string;
  team: 'A' | 'B' | 'FFA';
  alive: boolean;
  x: number;
  y: number;
  z: number;
  isLocalPlayer?: boolean;
}

export interface ActorObjectiveStats {
  enemyDogtags: number;
  friendlyDogtags: number;
  selfDogtagsRecovered: number;
  poiCaptures: number;
  territoryPoints: number;
  flagCaptures: number;
  flagReturns: number;
  hillControlSec: number;
}

export interface ConquestPoiHudState {
  id: string;
  code: string;
  label: string;
  kind: ConquestPoiKind;
  owner: 'A' | 'B' | null;
  progress: number; // -1 (Team B) .. +1 (Team A)
  contested: boolean;
  underAttack: boolean;
  position: [number, number, number];
  captureRadiusM: number;
  territoryWeight: number;
  canSpawnA: boolean;
  canSpawnB: boolean;
}

export interface ConquestLoadoutSlotState {
  id: string;
  name: string;
  primaryWeaponId: string;
  secondaryWeaponId: string;
  expended: boolean;
  active: boolean;
}

export interface ConquestSpawnOption {
  id: string;
  code: string;
  label: string;
  kind: 'hq' | 'fob';
  available: boolean;
  reason?: string;
}

export interface CtfFlagHudState {
  team: 'A' | 'B';
  label: string;
  status: 'home' | 'carried' | 'dropped';
  carrierId: string | null;
  carrierName: string | null;
  returnTimerSec: number;
  position: [number, number, number];
}

export interface KothHudState {
  activeHillIndex: number;
  activeHillLabel: string;
  activeHillPos: [number, number, number];
  nextHillLabel: string;
  nextHillPos: [number, number, number];
  hillTimerSec: number;
  previewActive: boolean;
  owner: 'A' | 'B' | null;
  contested: boolean;
}

export interface BattleModeHudSnapshot {
  rule: BattleRuleId;
  scoreA: number;
  scoreB: number;
  scoreLimit: number;
  remainingSec: number;
  friendlyTagsA: number;
  friendlyTagsB: number;
  localEnemyTags: number;
  localFriendlyTags: number;
  localSelfTags: number;
  activeDogtagCount: number;
  conquestPois: ConquestPoiHudState[];
  conquestLoadouts: ConquestLoadoutSlotState[];
  conquestRemainingLives: number;
  conquestTotalLives: number;
  conquestSpawnOptions: ConquestSpawnOption[];
  conquestSelectedSpawnId: string;
  conquestAwaitingRedeploy: boolean;
  conquestSpectating: boolean;
  conquestTerritoryRateA: number;
  conquestTerritoryRateB: number;
  conquestTeamRemainingLivesA: number;
  conquestTeamRemainingLivesB: number;
  conquestTeamActiveCountA: number;
  conquestTeamActiveCountB: number;
  ctfFlags: [CtfFlagHudState, CtfFlagHudState] | null;
  koth: KothHudState | null;
  localStandingInObjective: string | null;
  lastBannerText: string | null;
}

export interface ModeEventCallbacks {
  onScoreChanged?: (scoreA: number, scoreB: number) => void;
  onObjectiveBanner?: (text: string, tone: 'info' | 'alpha' | 'bravo' | 'gold') => void;
  onDogtagCollected?: (ev: {
    tagId: string;
    victimId: string;
    victimTeam: 'A' | 'B' | 'FFA';
    collectorId: string;
    collectorName: string;
    collectorTeam: 'A' | 'B' | 'FFA';
    isFriendly: boolean;
    isSelfRecovery: boolean;
    x: number;
    y: number;
    z: number;
  }) => void;
  onDogtagSpawned?: (ev: {
    tagId: string;
    victimId: string;
    victimTeam: 'A' | 'B' | 'FFA';
    x: number;
    y: number;
    z: number;
  }) => void;
  onFlagEvent?: (ev: {
    flagTeam: 'A' | 'B';
    action: 'pickup' | 'drop' | 'return' | 'capture';
    actorId?: string;
    actorName?: string;
    actorTeam?: 'A' | 'B' | 'FFA';
    x: number;
    y: number;
    z: number;
  }) => void;
  onAudioChime?: (
    kind: 'capture' | 'contested' | 'flag_taken' | 'flag_score' | 'flag_return' | 'hill_rotate',
  ) => void;
  onDogtagAudio?: (isFriendly: boolean, isSelfRecovery: boolean) => void;
  onMatchVictory?: (winner: {
    winnerTeam: 'A' | 'B' | 'FFA' | 'DRAW';
    winnerActorId?: string;
    reason: string;
  }) => void;
}

interface InternalPoiRuntime {
  def: ConquestPoiDef;
  owner: 'A' | 'B' | null;
  progress: number; // -1 (B) .. +1 (A)
  contested: boolean;
  underAttack: boolean;
  underAttackTimerSec: number;
  countA: number;
  countB: number;
  bannerMat?: THREE.MeshStandardMaterial;
  ringMat?: THREE.MeshBasicMaterial;
  flagMesh?: THREE.Mesh;
}

export interface ConquestParticipantAttrition {
  id: string;
  team: 'A' | 'B' | 'FFA';
  remainingLives: number;
  totalLives: number;
  alive: boolean;
  eliminated: boolean;
}

interface InternalFlagRuntime {
  team: 'A' | 'B';
  label: string;
  homePos: THREE.Vector3;
  pos: THREE.Vector3;
  status: 'home' | 'carried' | 'dropped';
  carrierId: string | null;
  carrierName: string | null;
  returnTimerSec: number;
  meshGroup?: THREE.Group;
}

interface InternalDogtagSlot {
  active: boolean;
  id: string;
  victimId: string;
  victimTeam: 'A' | 'B' | 'FFA';
  x: number;
  y: number;
  z: number;
  ageSec: number;
  meshGroup?: THREE.Group;
  plateMat?: THREE.MeshStandardMaterial;
  haloMat?: THREE.MeshBasicMaterial;
}

interface HeatZoneSample {
  x: number;
  y: number;
  z: number;
  expiresAt: number;
}

export interface BattleModeControllerOptions {
  rule: BattleRuleId;
  map: BuiltMapInstance;
  sceneGroup: THREE.Group;
  localPlayerTeam: 'A' | 'B' | 'FFA';
  localPlayerId: string;
  scoreLimit?: number;
  matchDurationSec?: number;
  isAuthority?: boolean;
  conquestLoadouts?: Array<{
    id: string;
    name: string;
    primaryWeaponId: string;
    secondaryWeaponId: string;
  }>;
  activeLoadoutId?: string;
  callbacks?: ModeEventCallbacks;
}

const MAX_DOGTAG_SLOTS = 64;
const DOGTAG_PICKUP_RADIUS = 2.15;
const DOGTAG_LIFETIME_SEC = 42;
const CTF_PICKUP_RADIUS = 2.4;
const CTF_AUTO_RETURN_SEC = 22;
const KOTH_HILL_DURATION_SEC = 45;
const KOTH_PREVIEW_SEC = 10;
const SPAWN_PROTECTION_DEFAULT_SEC = 2.5;
const CONQUEST_CAPTURE_TIME_SEC = 6.5;
const CONQUEST_UNDER_ATTACK_LOCK_SEC = 6.0;

const COLOR_TEAM_A = 0x38bdf8;
const COLOR_TEAM_B = 0xf87171;
const COLOR_NEUTRAL = 0xd4d4d8;
const COLOR_CONTESTED = 0xf59e0b;
const COLOR_TAG_ENEMY = 0xfbbf24;
const COLOR_TAG_FRIENDLY = 0x38bdf8;
const COLOR_TAG_SELF = 0x34d399;

export class BattleModeController {
  public readonly rule: BattleRuleId;
  public readonly scoreLimit: number;
  public readonly matchDurationSec: number;

  private readonly map: BuiltMapInstance;
  private readonly objectives: MapBattleObjectives;
  private readonly localTeam: 'A' | 'B' | 'FFA';
  private readonly localPlayerId: string;
  private readonly isAuthority: boolean;
  private readonly callbacks: ModeEventCallbacks;

  private readonly propGroup = new THREE.Group();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  // Scores & clock
  public scoreA = 0;
  public scoreB = 0;
  public friendlyTagsA = 0;
  public friendlyTagsB = 0;
  public remainingSec: number;
  private matchEnded = false;
  private matchWinnerTeam: 'A' | 'B' | 'FFA' | 'DRAW' | undefined;
  private matchWinnerActorId: string | undefined;
  private matchWinnerReason: string | undefined;

  // Per-actor stats
  private readonly actorStats = new Map<string, ActorObjectiveStats>();

  // Conquest state
  private readonly pois: InternalPoiRuntime[] = [];
  private readonly conquestLoadouts: ConquestLoadoutSlotState[] = [];
  private conquestSelectedSpawnId = 'hq';
  private conquestAwaitingRedeploy = false;
  private conquestSpectating = false;
  private readonly participantLives = new Map<string, ConquestParticipantAttrition>();
  private territoryRateA = 0;
  private territoryRateB = 0;
  private syncedTeamRemainingLivesA: number | null = null;
  private syncedTeamRemainingLivesB: number | null = null;
  private syncedTeamActiveCountA: number | null = null;
  private syncedTeamActiveCountB: number | null = null;

  // CTF state
  private flags: [InternalFlagRuntime, InternalFlagRuntime] | null = null;

  // KOTH state
  private kothHills: KothHillDef[] = [];
  private activeHillIndex = 0;
  private hillTimerSec = KOTH_HILL_DURATION_SEC;
  private hillOwner: 'A' | 'B' | null = null;
  private hillContested = false;
  private activeHillMesh: THREE.Group | null = null;
  private activeHillRingMat: THREE.MeshBasicMaterial | null = null;
  private nextHillMesh: THREE.Group | null = null;

  // Kill Confirmed pooled dogtags (zero per-drop GC)
  private readonly dogtags: InternalDogtagSlot[] = [];
  private dogtagNextSeq = 1;

  // Universal Battle Spawn Protection & crossfire heat avoidance
  private readonly spawnProtectionExpiry = new Map<string, number>();
  private readonly heatZones: HeatZoneSample[] = [];
  private readonly scratchRay = new THREE.Raycaster();
  private readonly scratchOrigin = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchPos = new THREE.Vector3();

  private elapsedSec = 0;
  private lastBannerText: string | null = null;
  private bannerClearAt = 0;
  private localStandingInObjective: string | null = null;

  constructor(opts: BattleModeControllerOptions) {
    this.rule = opts.rule;
    this.map = opts.map;
    this.localTeam = opts.localPlayerTeam;
    this.localPlayerId = opts.localPlayerId;
    this.isAuthority = opts.isAuthority ?? true;
    this.callbacks = opts.callbacks ?? {};

    this.scoreLimit =
      opts.scoreLimit && opts.scoreLimit > 0
        ? Math.round(opts.scoreLimit)
        : getDefaultScoreLimitForRule(opts.rule);
    this.matchDurationSec =
      opts.matchDurationSec && opts.matchDurationSec > 0
        ? Math.round(opts.matchDurationSec)
        : getDefaultMatchDurationSecForRule(opts.rule);
    this.remainingSec = this.matchDurationSec;

    this.objectives = opts.map.battleObjectives ?? buildFallbackObjectives(opts.map);

    opts.sceneGroup.add(this.propGroup);

    // Initialize Conquest loadouts (1 life per loadout slot)
    const incomingLoadouts =
      opts.conquestLoadouts && opts.conquestLoadouts.length > 0
        ? opts.conquestLoadouts
        : [
            { id: 'loadout_1', name: 'Assault', primaryWeaponId: 'm4a1', secondaryWeaponId: 'makarov_pm' },
            { id: 'loadout_2', name: 'CQB Breacher', primaryWeaponId: 'hk_mp5', secondaryWeaponId: 'makarov_pm' },
            { id: 'loadout_3', name: 'Marksman', primaryWeaponId: 'mosin_m91_30', secondaryWeaponId: 'makarov_pm' },
            { id: 'loadout_4', name: 'Heavy Support', primaryWeaponId: 'akm_762', secondaryWeaponId: 'nagant_m1895' },
            { id: 'loadout_5', name: 'Recon Custom', primaryWeaponId: 'remington_870', secondaryWeaponId: 'makarov_pm' },
          ];
    const startId = opts.activeLoadoutId ?? incomingLoadouts[0].id;
    for (const slot of incomingLoadouts) {
      this.conquestLoadouts.push({
        id: slot.id,
        name: slot.name,
        primaryWeaponId: slot.primaryWeaponId,
        secondaryWeaponId: slot.secondaryWeaponId,
        expended: false,
        active: slot.id === startId,
      });
    }
    if (!this.conquestLoadouts.some((l) => l.active) && this.conquestLoadouts.length > 0) {
      this.conquestLoadouts[0].active = true;
    }

    // Register the local player in the unified Conquest participant attrition table
    if (this.rule === 'conquest') {
      this.participantLives.set(this.localPlayerId, {
        id: this.localPlayerId,
        team: this.localTeam,
        remainingLives: this.conquestLoadouts.length,
        totalLives: this.conquestLoadouts.length,
        alive: true,
        eliminated: false,
      });
      this.initConquest();
    } else if (this.rule === 'ctf') {
      this.initCtf();
    } else if (this.rule === 'koth') {
      this.initKoth();
    } else if (isKillConfirmedRule(this.rule)) {
      this.initKillConfirmedPool();
    }
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.ownedGeos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.ownedMats.push(m);
    return m;
  }

  private getOrCreateStats(actorId: string): ActorObjectiveStats {
    let s = this.actorStats.get(actorId);
    if (!s) {
      s = {
        enemyDogtags: 0,
        friendlyDogtags: 0,
        selfDogtagsRecovered: 0,
        poiCaptures: 0,
        territoryPoints: 0,
        flagCaptures: 0,
        flagReturns: 0,
        hillControlSec: 0,
      };
      this.actorStats.set(actorId, s);
    }
    return s;
  }

  public getActorStats(actorId: string): ActorObjectiveStats {
    const s = this.actorStats.get(actorId);
    if (!s) {
      return {
        enemyDogtags: 0,
        friendlyDogtags: 0,
        selfDogtagsRecovered: 0,
        poiCaptures: 0,
        territoryPoints: 0,
        flagCaptures: 0,
        flagReturns: 0,
        hillControlSec: 0,
      };
    }
    return { ...s };
  }

  private emitBanner(text: string, tone: 'info' | 'alpha' | 'bravo' | 'gold' = 'info'): void {
    this.lastBannerText = text;
    this.bannerClearAt = this.elapsedSec + 3.6;
    this.callbacks.onObjectiveBanner?.(text, tone);
  }

  // =========================================================================
  // 1. MODE-SPECIFIC 3D PROP BUILDERS (ZERO BLOAT WHEN MODE INACTIVE)
  // =========================================================================

  private initConquest(): void {
    const poleGeo = this.trackGeo(new THREE.CylinderGeometry(0.06, 0.09, 6.2, 8));
    const flagGeo = this.trackGeo(new THREE.BoxGeometry(1.7, 0.95, 0.06));
    const poleMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x3b444e, roughness: 0.45, metalness: 0.78 }),
    );
    const barrierGeo = this.trackGeo(new THREE.BoxGeometry(2.6, 0.95, 0.55));
    const barrierMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x808589, roughness: 0.9, metalness: 0.04 }),
    );
    const sandbagMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x9b8d6b, roughness: 0.94, metalness: 0.02 }),
    );

    // Subtle HQ ground rings (protected bases)
    for (const hq of [this.objectives.hqA, this.objectives.hqB]) {
      const hqRingGeo = this.trackGeo(
        new THREE.RingGeometry(hq.safeRadiusM * 0.48, hq.safeRadiusM * 0.52, 32),
      );
      hqRingGeo.rotateX(-Math.PI * 0.5);
      const hqRingMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: hq.team === 'A' ? COLOR_TEAM_A : COLOR_TEAM_B,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const hqRing = new THREE.Mesh(hqRingGeo, hqRingMat);
      hqRing.position.set(hq.position[0], hq.position[1] + 0.08, hq.position[2]);
      this.propGroup.add(hqRing);
    }

    for (const def of this.objectives.conquestPois) {
      const initialOwner = def.initialOwner ?? null;
      const initialProgress = initialOwner === 'A' ? 1 : initialOwner === 'B' ? -1 : 0;

      const poiGroup = new THREE.Group();
      poiGroup.position.set(def.position[0], def.position[1], def.position[2]);

      // Flagpole + color-shifting banner
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(0, 3.1, 0);
      poiGroup.add(pole);

      const bannerMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color:
            initialOwner === 'A'
              ? COLOR_TEAM_A
              : initialOwner === 'B'
                ? COLOR_TEAM_B
                : COLOR_NEUTRAL,
          emissive:
            initialOwner === 'A'
              ? COLOR_TEAM_A
              : initialOwner === 'B'
                ? COLOR_TEAM_B
                : 0x22262c,
          emissiveIntensity: 0.45,
          roughness: 0.55,
        }),
      );
      const flagMesh = new THREE.Mesh(flagGeo, bannerMat);
      flagMesh.position.set(0.9, 2.2 + Math.abs(initialProgress) * 3.3, 0);
      poiGroup.add(flagMesh);

      // Ground perimeter capture ring
      const ringGeo = this.trackGeo(
        new THREE.RingGeometry(def.captureRadiusM - 0.25, def.captureRadiusM, 40),
      );
      ringGeo.rotateX(-Math.PI * 0.5);
      const ringMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color:
            initialOwner === 'A'
              ? COLOR_TEAM_A
              : initialOwner === 'B'
                ? COLOR_TEAM_B
                : COLOR_NEUTRAL,
          transparent: true,
          opacity: 0.52,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.set(0, 0.1, 0);
      poiGroup.add(ring);

      // Decorative checkpoint sandbags/barriers for maps without built-in checkpoint architecture
      if (def.kind === 'checkpoint' && !def.hasBuiltInProps) {
        const cpGroup = new THREE.Group();
        cpGroup.rotation.y = def.roadYaw ?? 0;
        const b1 = new THREE.Mesh(barrierGeo, barrierMat);
        b1.position.set(-3.2, 0.48, -2.4);
        const b2 = new THREE.Mesh(barrierGeo, sandbagMat);
        b2.position.set(3.2, 0.48, 2.4);
        cpGroup.add(b1, b2);
        poiGroup.add(cpGroup);
      }

      this.propGroup.add(poiGroup);

      this.pois.push({
        def,
        owner: initialOwner,
        progress: initialProgress,
        contested: false,
        underAttack: false,
        underAttackTimerSec: 0,
        countA: 0,
        countB: 0,
        bannerMat,
        ringMat,
        flagMesh,
      });
    }
  }

  private initCtf(): void {
    const poleGeo = this.trackGeo(new THREE.CylinderGeometry(0.05, 0.06, 3.1, 8));
    const clothGeo = this.trackGeo(new THREE.BoxGeometry(1.35, 0.78, 0.05));
    const standGeo = this.trackGeo(new THREE.RingGeometry(1.4, 1.85, 28));
    standGeo.rotateX(-Math.PI * 0.5);
    const poleMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0xd4d8de, roughness: 0.35, metalness: 0.85 }),
    );

    const built: InternalFlagRuntime[] = [];
    for (const anchor of this.objectives.ctfFlags) {
      const hex = anchor.team === 'A' ? COLOR_TEAM_A : COLOR_TEAM_B;
      const standMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.65,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const stand = new THREE.Mesh(standGeo, standMat);
      stand.position.set(anchor.position[0], anchor.position[1] + 0.08, anchor.position[2]);
      this.propGroup.add(stand);

      const flagGroup = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(0, 1.55, 0);
      const clothMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: hex,
          emissive: hex,
          emissiveIntensity: 0.65,
          roughness: 0.45,
        }),
      );
      const cloth = new THREE.Mesh(clothGeo, clothMat);
      cloth.position.set(0.7, 2.6, 0);
      flagGroup.add(pole, cloth);
      flagGroup.position.set(anchor.position[0], anchor.position[1], anchor.position[2]);
      this.propGroup.add(flagGroup);

      built.push({
        team: anchor.team,
        label: anchor.label,
        homePos: new THREE.Vector3(...anchor.position),
        pos: new THREE.Vector3(...anchor.position),
        status: 'home',
        carrierId: null,
        carrierName: null,
        returnTimerSec: 0,
        meshGroup: flagGroup,
      });
    }
    this.flags = [built[0], built[1]];
  }

  private initKoth(): void {
    this.kothHills = this.objectives.kothHills.length > 0
      ? [...this.objectives.kothHills]
      : [{ id: 'hill_center', label: 'Central Sector', position: [0, 0.05, 0], radiusM: 8 }];
    this.activeHillIndex = 0;
    this.hillTimerSec = KOTH_HILL_DURATION_SEC;

    // Active hill beacon & ground ring
    this.activeHillMesh = new THREE.Group();
    const ringGeo = this.trackGeo(new THREE.RingGeometry(0.92, 1.0, 44));
    ringGeo.rotateX(-Math.PI * 0.5);
    this.activeHillRingMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: COLOR_NEUTRAL,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const ring = new THREE.Mesh(ringGeo, this.activeHillRingMat);
    ring.position.y = 0.1;
    const beamGeo = this.trackGeo(new THREE.CylinderGeometry(0.28, 0.65, 16, 12, 1, true));
    const beam = new THREE.Mesh(beamGeo, this.activeHillRingMat);
    beam.position.y = 8.0;
    this.activeHillMesh.add(ring, beam);
    this.propGroup.add(this.activeHillMesh);

    // Next hill preview beacon (visible during final 10s before rotation)
    this.nextHillMesh = new THREE.Group();
    const nextMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: COLOR_CONTESTED,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const nextRing = new THREE.Mesh(ringGeo, nextMat);
    nextRing.position.y = 0.12;
    this.nextHillMesh.add(nextRing);
    this.nextHillMesh.visible = false;
    this.propGroup.add(this.nextHillMesh);

    this.syncKothHillVisuals();
  }

  private syncKothHillVisuals(): void {
    if (!this.activeHillMesh || this.kothHills.length === 0) return;
    const active = this.kothHills[this.activeHillIndex % this.kothHills.length];
    const next = this.kothHills[(this.activeHillIndex + 1) % this.kothHills.length];
    this.activeHillMesh.position.set(active.position[0], active.position[1], active.position[2]);
    this.activeHillMesh.children[0].scale.set(active.radiusM, 1, active.radiusM);

    if (this.nextHillMesh) {
      this.nextHillMesh.position.set(next.position[0], next.position[1], next.position[2]);
      this.nextHillMesh.children[0].scale.set(next.radiusM, 1, next.radiusM);
    }
  }

  private initKillConfirmedPool(): void {
    const tagPlateGeo = this.trackGeo(new THREE.BoxGeometry(0.22, 0.34, 0.03));
    const haloGeo = this.trackGeo(new THREE.RingGeometry(0.45, 0.62, 18));
    haloGeo.rotateX(-Math.PI * 0.5);

    for (let i = 0; i < MAX_DOGTAG_SLOTS; i++) {
      const grp = new THREE.Group();
      grp.visible = false;

      const plateMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: COLOR_TAG_ENEMY,
          emissive: COLOR_TAG_ENEMY,
          emissiveIntensity: 0.72,
          roughness: 0.25,
          metalness: 0.85,
        }),
      );
      const plate1 = new THREE.Mesh(tagPlateGeo, plateMat);
      plate1.position.set(-0.04, 0.85, 0);
      plate1.rotation.z = 0.12;
      const plate2 = new THREE.Mesh(tagPlateGeo, plateMat);
      plate2.position.set(0.05, 0.82, 0.04);
      plate2.rotation.z = -0.18;

      const haloMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: COLOR_TAG_ENEMY,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const halo = new THREE.Mesh(haloGeo, haloMat);
      halo.position.y = 0.08;

      grp.add(plate1, plate2, halo);
      this.propGroup.add(grp);

      this.dogtags.push({
        active: false,
        id: '',
        victimId: '',
        victimTeam: 'FFA',
        x: 0,
        y: 0,
        z: 0,
        ageSec: 0,
        meshGroup: grp,
        plateMat,
        haloMat,
      });
    }
  }

  // =========================================================================
  // 2. UNIVERSAL BATTLE SPAWN PROTECTION & SAFE-SPAWN SCORING
  // =========================================================================

  public recordCrossfireHeat(x: number, y: number, z: number, ttlSec = 9.0): void {
    this.heatZones.push({ x, y, z, expiresAt: this.elapsedSec + ttlSec });
    if (this.heatZones.length > 36) {
      this.heatZones.shift();
    }
  }

  public grantSpawnProtection(actorId: string, durationSec = SPAWN_PROTECTION_DEFAULT_SEC): void {
    this.spawnProtectionExpiry.set(actorId, this.elapsedSec + Math.max(0.5, durationSec));
  }

  public cancelSpawnProtection(actorId: string): void {
    this.spawnProtectionExpiry.delete(actorId);
  }

  public isSpawnProtected(actorId: string): boolean {
    const exp = this.spawnProtectionExpiry.get(actorId);
    return exp !== undefined && this.elapsedSec < exp;
  }

  public getSpawnProtectionRemaining(actorId: string): number {
    const exp = this.spawnProtectionExpiry.get(actorId);
    if (exp === undefined) return 0;
    return Math.max(0, exp - this.elapsedSec);
  }

  /**
   * Scores candidate spawn points to prevent spawning in crossfire or right next to enemies:
   * - Maximizes distance to nearest living enemy
   * - Heavily penalizes spawn points with direct enemy line-of-sight (< 46m)
   * - Penalizes spawn points inside recent death/crossfire heat zones
   */
  public selectSafeSpawnPoint(
    candidates: readonly SpawnPoint[],
    livingEnemies: ReadonlyArray<{ x: number; y: number; z: number }>,
    raycastMeshes?: readonly THREE.Object3D[],
  ): SpawnPoint {
    if (candidates.length === 0) {
      return this.map.spawnPoints.playerStart;
    }
    if (candidates.length === 1) {
      return candidates[0];
    }

    let bestSpawn = candidates[0];
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const sp = candidates[i];
      const sx = sp.position[0];
      const sy = sp.position[1];
      const sz = sp.position[2];

      let minEnemyDist = 120;
      let losExposedCount = 0;
      let closePenalty = 0;

      for (let e = 0; e < livingEnemies.length; e++) {
        const en = livingEnemies[e];
        const dx = en.x - sx;
        const dy = en.y - sy;
        const dz = en.z - sz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < minEnemyDist) minEnemyDist = dist;

        if (dist < 10) {
          closePenalty += 220;
        } else if (dist < 22) {
          closePenalty += (22 - dist) * 7.5;
        }

        // Line-of-sight check within 46m
        if (raycastMeshes && raycastMeshes.length > 0 && dist > 1.0 && dist < 46) {
          this.scratchOrigin.set(sx, sy + 1.5, sz);
          if (raycastMeshes === this.map.raycastMeshes && this.map.physics) {
            this.scratchDir.set(en.x, en.y + 1.5, en.z);
            if (!this.map.physics.isSegmentOccluded(this.scratchOrigin, this.scratchDir, 0.25, 0.4)) {
              losExposedCount += 1;
            }
          } else {
            this.scratchDir.set(dx, en.y + 1.5 - (sy + 1.5), dz).normalize();
            this.scratchRay.set(this.scratchOrigin, this.scratchDir);
            this.scratchRay.near = 0.25;
            this.scratchRay.far = dist - 0.4;
            const hits = this.scratchRay.intersectObjects(raycastMeshes as THREE.Object3D[], false);
            if (hits.length === 0) {
              losExposedCount += 1;
            }
          }
        }
      }

      // Crossfire / recent death heat penalty
      let heatPenalty = 0;
      for (let h = 0; h < this.heatZones.length; h++) {
        const hz = this.heatZones[h];
        if (hz.expiresAt <= this.elapsedSec) continue;
        const dist = Math.hypot(hz.x - sx, hz.z - sz);
        if (dist < 14) {
          heatPenalty += (14 - dist) * 5.2;
        }
      }

      const score =
        Math.min(minEnemyDist, 75) * 2.2 -
        closePenalty -
        losExposedCount * 95 -
        heatPenalty +
        Math.random() * 2.0;

      if (score > bestScore) {
        bestScore = score;
        bestSpawn = sp;
      }
    }

    return bestSpawn;
  }

  // =========================================================================
  // 3. CONQUEST 1-LIFE-PER-LOADOUT & UNCONTESTED FOB / HQ SPAWNING
  // =========================================================================

  public getOpeningHqSpawns(team: 'A' | 'B'): SpawnPoint[] {
    return team === 'A' ? this.objectives.hqA.spawnPoints : this.objectives.hqB.spawnPoints;
  }

  public getConquestSpawnOptionsForTeam(team: 'A' | 'B'): ConquestSpawnOption[] {
    const hq = team === 'A' ? this.objectives.hqA : this.objectives.hqB;
    const options: ConquestSpawnOption[] = [
      {
        id: 'hq',
        code: team === 'A' ? 'ALPHA HQ' : 'BRAVO HQ',
        label: hq.label,
        kind: 'hq',
        available: true,
      },
    ];

    for (const poi of this.pois) {
      if (poi.def.kind !== 'fob') continue;
      if (poi.owner !== team) {
        options.push({
          id: poi.def.id,
          code: poi.def.code,
          label: poi.def.label,
          kind: 'fob',
          available: false,
          reason: poi.owner === null ? 'Unclaimed' : 'Enemy Controlled',
        });
      } else if (poi.contested || poi.underAttack) {
        options.push({
          id: poi.def.id,
          code: poi.def.code,
          label: poi.def.label,
          kind: 'fob',
          available: false,
          reason: poi.contested ? 'Under Attack (Contested)' : 'Under Enemy Attack (Locked)',
        });
      } else {
        options.push({
          id: poi.def.id,
          code: poi.def.code,
          label: poi.def.label,
          kind: 'fob',
          available: true,
        });
      }
    }
    return options;
  }

  /**
   * Reports hostile fire, explosions, or casualties near a Conquest POI so any friendly FOB
   * actively under enemy attack is immediately locked against respawns.
   */
  public reportConquestAttack(
    x: number,
    z: number,
    attackerTeam?: 'A' | 'B' | 'FFA',
  ): void {
    if (this.rule !== 'conquest') return;
    for (let i = 0; i < this.pois.length; i++) {
      const poi = this.pois[i];
      if (!poi.owner) continue;
      if (attackerTeam && attackerTeam !== 'FFA' && attackerTeam === poi.owner) continue;
      const defenseR = poi.def.captureRadiusM + 8.0;
      const dx = x - poi.def.position[0];
      const dz = z - poi.def.position[2];
      if (dx * dx + dz * dz <= defenseR * defenseR) {
        poi.underAttackTimerSec = CONQUEST_UNDER_ATTACK_LOCK_SEC;
        poi.underAttack = true;
      }
    }
  }

  /**
   * Returns valid spawn pads for a team in Conquest ONLY from Team HQ or a friendly, UNCONTESTED,
   * NOT-UNDER-ATTACK FOB. Rejects any contested, under-attack, or non-friendly FOB.
   */
  public resolveConquestSpawnCandidates(team: 'A' | 'B', requestedSpawnId?: string): SpawnPoint[] {
    const hqSpawns = this.getOpeningHqSpawns(team);
    if (!requestedSpawnId || requestedSpawnId === 'hq') {
      return hqSpawns;
    }
    const poi = this.pois.find((p) => p.def.id === requestedSpawnId);
    if (
      poi &&
      poi.def.kind === 'fob' &&
      poi.owner === team &&
      !poi.contested &&
      !poi.underAttack &&
      poi.def.spawnPoints &&
      poi.def.spawnPoints.length > 0
    ) {
      return poi.def.spawnPoints;
    }
    return hqSpawns;
  }

  public isConquestSpawnAvailable(team: 'A' | 'B', spawnId: string): boolean {
    if (spawnId === 'hq') return true;
    const poi = this.pois.find((p) => p.def.id === spawnId);
    return Boolean(
      poi &&
        poi.def.kind === 'fob' &&
        poi.owner === team &&
        !poi.contested &&
        !poi.underAttack,
    );
  }

  public getConquestTotalLoadouts(): number {
    return Math.max(1, this.conquestLoadouts.length);
  }

  /**
   * Called when the local player dies in Conquest:
   * Expends the currently active loadout. If any unused loadout remains, opens the Tactical Redeploy UI;
   * otherwise transitions the player into Spectator Mode until match end.
   */
  public onLocalPlayerDeathConquest(): {
    remainingLives: number;
    enteringSpectator: boolean;
    nextAvailableLoadoutId: string | null;
  } {
    const active = this.conquestLoadouts.find((l) => l.active && !l.expended);
    if (active) {
      active.expended = true;
      active.active = false;
    }

    const remaining = this.conquestLoadouts.filter((l) => !l.expended);
    const entry = this.participantLives.get(this.localPlayerId);
    if (entry) {
      entry.remainingLives = remaining.length;
      entry.alive = false;
      entry.eliminated = remaining.length === 0;
    }

    if (remaining.length === 0) {
      this.conquestAwaitingRedeploy = false;
      this.conquestSpectating = true;
      this.emitBanner('ALL LOADOUTS EXPENDED · SPECTATING SQUAD', 'info');
      return { remainingLives: 0, enteringSpectator: true, nextAvailableLoadoutId: null };
    }

    remaining[0].active = true;
    this.conquestAwaitingRedeploy = true;
    this.conquestSpectating = false;

    // Ensure selected spawn is still valid (fall back to HQ if chosen FOB is now contested or under attack)
    const team = this.localTeam === 'B' ? 'B' : 'A';
    if (!this.isConquestSpawnAvailable(team, this.conquestSelectedSpawnId)) {
      this.conquestSelectedSpawnId = 'hq';
    }

    return {
      remainingLives: remaining.length,
      enteringSpectator: false,
      nextAvailableLoadoutId: remaining[0].id,
    };
  }

  public selectConquestLoadout(slotId: string): ConquestLoadoutSlotState | null {
    const target = this.conquestLoadouts.find((l) => l.id === slotId && !l.expended);
    if (!target) return null;
    for (const l of this.conquestLoadouts) {
      l.active = l.id === slotId;
    }
    return { ...target };
  }

  public selectConquestSpawn(spawnId: string): boolean {
    const team = this.localTeam === 'B' ? 'B' : 'A';
    if (!this.isConquestSpawnAvailable(team, spawnId)) return false;
    this.conquestSelectedSpawnId = spawnId;
    return true;
  }

  public confirmConquestRedeploy(
    livingEnemies: ReadonlyArray<{ x: number; y: number; z: number }>,
    raycastMeshes?: readonly THREE.Object3D[],
  ): { loadout: ConquestLoadoutSlotState; spawnPoint: SpawnPoint; redirectedToHq?: boolean } | null {
    if (this.conquestSpectating) return null;
    const chosenLoadout =
      this.conquestLoadouts.find((l) => l.active && !l.expended) ??
      this.conquestLoadouts.find((l) => !l.expended);
    if (!chosenLoadout) {
      this.conquestSpectating = true;
      this.conquestAwaitingRedeploy = false;
      return null;
    }
    for (const l of this.conquestLoadouts) {
      l.active = l.id === chosenLoadout.id;
    }

    const team = this.localTeam === 'B' ? 'B' : 'A';
    let redirectedToHq = false;
    if (!this.isConquestSpawnAvailable(team, this.conquestSelectedSpawnId)) {
      this.conquestSelectedSpawnId = 'hq';
      redirectedToHq = true;
    }
    const candidates = this.resolveConquestSpawnCandidates(team, this.conquestSelectedSpawnId);
    const spawnPoint = this.selectSafeSpawnPoint(candidates, livingEnemies, raycastMeshes);
    this.conquestAwaitingRedeploy = false;
    const entry = this.participantLives.get(this.localPlayerId);
    if (entry) {
      entry.alive = true;
    }
    return { loadout: { ...chosenLoadout }, spawnPoint, redirectedToHq };
  }

  public isLocalSpectating(): boolean {
    return this.rule === 'conquest' && this.conquestSpectating;
  }

  public isLocalAwaitingRedeploy(): boolean {
    return this.rule === 'conquest' && this.conquestAwaitingRedeploy;
  }

  /** Unified 1-life-per-loadout registration for all Battle participants (humans & bots) */
  public registerConquestParticipant(
    actorId: string,
    team: 'A' | 'B' | 'FFA',
    lives = this.getConquestTotalLoadouts(),
  ): void {
    const total = Math.max(1, Math.floor(lives));
    this.participantLives.set(actorId, {
      id: actorId,
      team,
      remainingLives: total,
      totalLives: total,
      alive: true,
      eliminated: false,
    });
  }

  /** Consume 1 loadout life when any non-local Battle participant dies in Conquest */
  public consumeConquestParticipantLife(
    actorId: string,
    team: 'A' | 'B' | 'FFA' = 'A',
  ): number {
    if (this.rule !== 'conquest') return 99;
    let entry = this.participantLives.get(actorId);
    if (!entry) {
      const total = this.getConquestTotalLoadouts();
      entry = {
        id: actorId,
        team,
        remainingLives: total,
        totalLives: total,
        alive: true,
        eliminated: false,
      };
      this.participantLives.set(actorId, entry);
    }
    entry.remainingLives = Math.max(0, entry.remainingLives - 1);
    entry.alive = false;
    entry.eliminated = entry.remainingLives <= 0;
    return entry.remainingLives;
  }

  public onConquestParticipantRespawn(actorId: string): boolean {
    if (this.rule !== 'conquest') return true;
    const entry = this.participantLives.get(actorId);
    if (!entry) return true;
    if (entry.eliminated || entry.remainingLives <= 0) {
      entry.alive = false;
      entry.eliminated = true;
      return false;
    }
    entry.alive = true;
    return true;
  }

  public getConquestParticipantAttrition(actorId: string): ConquestParticipantAttrition | null {
    const entry = this.participantLives.get(actorId);
    return entry ? { ...entry } : null;
  }

  public getConquestTeamAttrition(): {
    remainingLivesA: number;
    remainingLivesB: number;
    activeCountA: number;
    activeCountB: number;
  } {
    if (!this.isAuthority && this.syncedTeamRemainingLivesA !== null && this.syncedTeamRemainingLivesB !== null) {
      return {
        remainingLivesA: this.syncedTeamRemainingLivesA,
        remainingLivesB: this.syncedTeamRemainingLivesB,
        activeCountA: this.syncedTeamActiveCountA ?? 0,
        activeCountB: this.syncedTeamActiveCountB ?? 0,
      };
    }
    let remainingLivesA = 0;
    let remainingLivesB = 0;
    let activeCountA = 0;
    let activeCountB = 0;
    for (const p of this.participantLives.values()) {
      if (p.team === 'A') {
        remainingLivesA += p.remainingLives;
        if (!p.eliminated) activeCountA++;
      } else if (p.team === 'B') {
        remainingLivesB += p.remainingLives;
        if (!p.eliminated) activeCountB++;
      }
    }
    return { remainingLivesA, remainingLivesB, activeCountA, activeCountB };
  }

  /** Finite loadout lives for AI bots in Conquest (matches player loadout count by default) */
  public initBotConquestLives(
    botId: string,
    lives = this.getConquestTotalLoadouts(),
    team: 'A' | 'B' | 'FFA' = 'A',
  ): void {
    this.registerConquestParticipant(botId, team, lives);
  }

  public consumeBotConquestLife(botId: string, team: 'A' | 'B' | 'FFA' = 'A'): number {
    return this.consumeConquestParticipantLife(botId, team);
  }

  public getBotConquestSpawnCandidates(team: 'A' | 'B'): SpawnPoint[] {
    // Prefer an uncontested, not-under-attack friendly FOB closer to the frontline, else fall back to Team HQ
    const friendlyFobs = this.pois.filter(
      (p) =>
        p.def.kind === 'fob' &&
        p.owner === team &&
        !p.contested &&
        !p.underAttack &&
        p.def.spawnPoints &&
        p.def.spawnPoints.length > 0,
    );
    if (friendlyFobs.length > 0 && Math.random() < 0.72) {
      const picked = friendlyFobs[Math.floor(Math.random() * friendlyFobs.length)];
      return picked.def.spawnPoints!;
    }
    return this.getOpeningHqSpawns(team);
  }

  // =========================================================================
  // 4. KILL CONFIRMED DOGTAG SPAWNING & COLLECTION
  // =========================================================================

  public onActorKilled(ev: {
    victimId: string;
    victimTeam: 'A' | 'B' | 'FFA';
    x: number;
    y: number;
    z: number;
  }): void {
    this.recordCrossfireHeat(ev.x, ev.y, ev.z, 9.0);
    if (this.rule === 'conquest') {
      // Combat casualties near a friendly FOB immediately lock it as under enemy attack
      const attackerTeam: 'A' | 'B' | 'FFA' =
        ev.victimTeam === 'A' ? 'B' : ev.victimTeam === 'B' ? 'A' : 'FFA';
      this.reportConquestAttack(ev.x, ev.z, attackerTeam);
    }

    // Drop carried CTF flag on death
    if (this.rule === 'ctf' && this.flags) {
      for (const flag of this.flags) {
        if (flag.status === 'carried' && flag.carrierId === ev.victimId) {
          flag.status = 'dropped';
          flag.carrierId = null;
          flag.carrierName = null;
          flag.returnTimerSec = CTF_AUTO_RETURN_SEC;
          flag.pos.set(ev.x, ev.y, ev.z);
          this.emitBanner(
            `${flag.team === 'A' ? 'ALPHA' : 'BRAVO'} FLAG DROPPED`,
            flag.team === 'A' ? 'alpha' : 'bravo',
          );
          this.callbacks.onFlagEvent?.({
            flagTeam: flag.team,
            action: 'drop',
            actorId: ev.victimId,
            x: ev.x,
            y: ev.y,
            z: ev.z,
          });
        }
      }
    }

    // Spawn Kill Confirmed 3D dogtag
    if (isKillConfirmedRule(this.rule) && this.isAuthority) {
      this.spawnDogtag(ev.victimId, ev.victimTeam, ev.x, ev.y, ev.z);
    }
  }

  public spawnDogtag(
    victimId: string,
    victimTeam: 'A' | 'B' | 'FFA',
    x: number,
    y: number,
    z: number,
    explicitTagId?: string,
  ): string | null {
    if (!isKillConfirmedRule(this.rule)) return null;

    // Pick first inactive slot, or recycle oldest active slot
    let slot = this.dogtags.find((d) => !d.active);
    if (!slot) {
      slot = this.dogtags.reduce((oldest, cur) => (cur.ageSec > oldest.ageSec ? cur : oldest), this.dogtags[0]);
    }
    if (!slot) return null;

    const tagId = explicitTagId ?? `tag_${this.dogtagNextSeq++}`;
    slot.active = true;
    slot.id = tagId;
    slot.victimId = victimId;
    slot.victimTeam = victimTeam;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.ageSec = 0;

    this.applyDogtagVisualColor(slot);
    if (slot.meshGroup) {
      slot.meshGroup.position.set(x, y, z);
      slot.meshGroup.visible = true;
    }

    this.callbacks.onDogtagSpawned?.({ tagId, victimId, victimTeam, x, y, z });
    return tagId;
  }

  private applyDogtagVisualColor(slot: InternalDogtagSlot): void {
    if (!slot.plateMat || !slot.haloMat) return;
    const isSelf = slot.victimId === this.localPlayerId;
    const isFriendly =
      isSelf || (this.rule === 'kc_tdm' && slot.victimTeam === this.localTeam);
    const hex = isSelf ? COLOR_TAG_SELF : isFriendly ? COLOR_TAG_FRIENDLY : COLOR_TAG_ENEMY;
    slot.plateMat.color.setHex(hex);
    slot.plateMat.emissive.setHex(hex);
    slot.haloMat.color.setHex(hex);
  }

  private collectDogtag(slot: InternalDogtagSlot, collector: ModeActorSample): void {
    const isSelfRecovery = slot.victimId === collector.id;
    const isFriendly =
      this.rule === 'kc_ffa'
        ? isSelfRecovery
        : slot.victimTeam === collector.team;

    const stats = this.getOrCreateStats(collector.id);
    if (isFriendly) {
      // Friendly / Self Dogtag: tracked SEPARATELY (does NOT add to team collected dogtags or wins!)
      stats.friendlyDogtags += 1;
      if (isSelfRecovery) {
        stats.selfDogtagsRecovered += 1;
      }
      if (this.rule === 'kc_tdm') {
        if (collector.team === 'A') this.friendlyTagsA += 1;
        else if (collector.team === 'B') this.friendlyTagsB += 1;
      }
    } else {
      // Enemy Dogtag: counts toward operator & team win score!
      stats.enemyDogtags += 1;
      if (this.rule === 'kc_tdm') {
        if (collector.team === 'A') this.scoreA += 1;
        else if (collector.team === 'B') this.scoreB += 1;
        this.callbacks.onScoreChanged?.(this.scoreA, this.scoreB);
      } else if (this.rule === 'kc_ffa') {
        if (collector.isLocalPlayer) {
          this.scoreA = stats.enemyDogtags;
        }
        this.scoreB = Math.max(this.scoreB, stats.enemyDogtags);
        this.callbacks.onScoreChanged?.(this.scoreA, this.scoreB);
      }
    }

    const tagId = slot.id;
    const vx = slot.x;
    const vy = slot.y;
    const vz = slot.z;
    const vId = slot.victimId;
    const vTeam = slot.victimTeam;

    slot.active = false;
    if (slot.meshGroup) slot.meshGroup.visible = false;

    if (collector.isLocalPlayer) {
      this.callbacks.onDogtagAudio?.(isFriendly, isSelfRecovery);
      if (isSelfRecovery) {
        this.emitBanner('OWN DOGTAG RECOVERED · +140 XP BONUS', 'gold');
      } else if (isFriendly) {
        this.emitBanner('FRIENDLY DOGTAG SECURED · +65 XP', 'alpha');
      } else {
        this.emitBanner('KILL CONFIRMED · ENEMY DOGTAG SECURED', 'gold');
      }
    }

    this.callbacks.onDogtagCollected?.({
      tagId,
      victimId: vId,
      victimTeam: vTeam,
      collectorId: collector.id,
      collectorName: collector.name,
      collectorTeam: collector.team,
      isFriendly,
      isSelfRecovery,
      x: vx,
      y: vy,
      z: vz,
    });

    // Check Kill Confirmed win condition (only enemy dogtags count!)
    if (this.isAuthority && !this.matchEnded && !isFriendly) {
      if (this.rule === 'kc_tdm') {
        if (this.scoreA >= this.scoreLimit) {
          this.triggerMatchEnd('A', undefined, 'Most Enemy Dogtags Secured');
        } else if (this.scoreB >= this.scoreLimit) {
          this.triggerMatchEnd('B', undefined, 'Most Enemy Dogtags Secured');
        }
      } else if (this.rule === 'kc_ffa') {
        if (stats.enemyDogtags >= this.scoreLimit) {
          this.triggerMatchEnd('FFA', collector.id, 'Most Enemy Dogtags Secured');
        }
      }
    }
  }

  // =========================================================================
  // 5. MAIN TICK UPDATE (ZERO PER-FRAME ALLOCATIONS)
  // =========================================================================

  public update(dt: number, actors: readonly ModeActorSample[]): void {
    const safeDt = Math.min(0.1, Math.max(0, dt));
    this.elapsedSec += safeDt;

    if (this.lastBannerText && this.elapsedSec >= this.bannerClearAt) {
      this.lastBannerText = null;
    }

    // Expire old crossfire heat zones
    for (let i = this.heatZones.length - 1; i >= 0; i--) {
      if (this.heatZones[i].expiresAt <= this.elapsedSec) {
        this.heatZones.splice(i, 1);
      }
    }

    // Prune expired spawn protection entries
    for (const [id, exp] of this.spawnProtectionExpiry.entries()) {
      if (this.elapsedSec >= exp) {
        this.spawnProtectionExpiry.delete(id);
      }
    }

    this.localStandingInObjective = null;

    if (this.matchEnded) return;

    // Match timer countdown for objective/timed modes
    if (
      this.rule === 'conquest' ||
      this.rule === 'ctf' ||
      this.rule === 'koth' ||
      isKillConfirmedRule(this.rule)
    ) {
      this.remainingSec = Math.max(0, this.remainingSec - safeDt);
      if (this.isAuthority && this.remainingSec <= 0) {
        this.resolveTimeLimitWinner(actors);
        return;
      }
    }

    if (this.rule === 'conquest') {
      this.updateConquest(safeDt, actors);
    } else if (this.rule === 'ctf') {
      this.updateCtf(safeDt, actors);
    } else if (this.rule === 'koth') {
      this.updateKoth(safeDt, actors);
    } else if (isKillConfirmedRule(this.rule)) {
      this.updateKillConfirmed(safeDt, actors);
    }
  }

  private updateConquest(dt: number, actors: readonly ModeActorSample[]): void {
    // Keep unified participant attrition table synced with all active battle participants
    for (let a = 0; a < actors.length; a++) {
      const act = actors[a];
      let entry = this.participantLives.get(act.id);
      if (!entry) {
        const total = this.getConquestTotalLoadouts();
        entry = {
          id: act.id,
          team: act.team,
          remainingLives: total,
          totalLives: total,
          alive: act.alive,
          eliminated: false,
        };
        this.participantLives.set(act.id, entry);
      } else {
        entry.team = act.team;
        entry.alive = act.alive;
      }
    }

    let territoryRateA = 0;
    let territoryRateB = 0;

    for (let i = 0; i < this.pois.length; i++) {
      const poi = this.pois[i];
      let countA = 0;
      let countB = 0;
      let localInside = false;
      const rSq = poi.def.captureRadiusM * poi.def.captureRadiusM;
      const px = poi.def.position[0];
      const pz = poi.def.position[2];

      for (let a = 0; a < actors.length; a++) {
        const act = actors[a];
        if (!act.alive) continue;
        const dx = act.x - px;
        const dz = act.z - pz;
        if (dx * dx + dz * dz <= rSq) {
          if (act.team === 'A') countA++;
          else if (act.team === 'B') countB++;
          if (act.isLocalPlayer) localInside = true;
        }
      }

      poi.countA = countA;
      poi.countB = countB;
      const wasContested = poi.contested;
      poi.contested = countA > 0 && countB > 0;
      if (poi.underAttackTimerSec > 0) {
        poi.underAttackTimerSec = Math.max(0, poi.underAttackTimerSec - dt);
      }

      if (localInside) {
        this.localStandingInObjective = `${poi.def.code} · ${poi.def.label}`;
      }

      if (this.isAuthority) {
        if (!poi.contested) {
          const prevOwner = poi.owner;
          if (countA > 0 && poi.progress < 1) {
            const speed = (1 + Math.min(2, countA - 1) * 0.35) / CONQUEST_CAPTURE_TIME_SEC;
            poi.progress = Math.min(1, poi.progress + speed * dt);
            if (poi.progress <= 0 && prevOwner === 'B') {
              // Neutralizing B
            }
            if (poi.progress >= 0.999) {
              poi.progress = 1;
              if (poi.owner !== 'A') {
                poi.owner = 'A';
                poi.underAttackTimerSec = 0;
                this.onPoiCaptured(poi, 'A', actors);
              }
            } else if (poi.progress > 0 && poi.owner === 'B') {
              poi.owner = null;
            }
          } else if (countB > 0 && poi.progress > -1) {
            const speed = (1 + Math.min(2, countB - 1) * 0.35) / CONQUEST_CAPTURE_TIME_SEC;
            poi.progress = Math.max(-1, poi.progress - speed * dt);
            if (poi.progress <= -0.999) {
              poi.progress = -1;
              if (poi.owner !== 'B') {
                poi.owner = 'B';
                poi.underAttackTimerSec = 0;
                this.onPoiCaptured(poi, 'B', actors);
              }
            } else if (poi.progress < 0 && poi.owner === 'A') {
              poi.owner = null;
            }
          }
        } else if (!wasContested && localInside) {
          this.callbacks.onAudioChime?.('contested');
        }

        const enemyInsideOwned =
          (poi.owner === 'A' && countB > 0) || (poi.owner === 'B' && countA > 0);
        poi.underAttack = Boolean(poi.owner && (enemyInsideOwned || poi.underAttackTimerSec > 0));

        // Accumulate Territory Points continuously from owned land
        if (poi.owner === 'A') {
          territoryRateA += poi.def.territoryWeight;
        } else if (poi.owner === 'B') {
          territoryRateB += poi.def.territoryWeight;
        }
      }

      // Visual flagpole & capture ring updates
      const colorHex =
        poi.contested || (poi.def.kind === 'fob' && poi.underAttack)
          ? COLOR_CONTESTED
          : poi.owner === 'A'
            ? COLOR_TEAM_A
            : poi.owner === 'B'
              ? COLOR_TEAM_B
              : COLOR_NEUTRAL;
      if (poi.bannerMat) {
        poi.bannerMat.color.setHex(colorHex);
        poi.bannerMat.emissive.setHex(colorHex);
      }
      if (poi.ringMat) {
        poi.ringMat.color.setHex(colorHex);
      }
      if (poi.flagMesh) {
        poi.flagMesh.position.y = 2.0 + Math.abs(poi.progress) * 3.5;
        poi.flagMesh.rotation.y = Math.sin(this.elapsedSec * 2.4 + i) * 0.14;
      }
    }

    // Ensure local player's selected FOB is invalidated immediately if it becomes contested or under enemy attack
    if (this.conquestAwaitingRedeploy && this.conquestSelectedSpawnId !== 'hq') {
      const team = this.localTeam === 'B' ? 'B' : 'A';
      if (!this.isConquestSpawnAvailable(team, this.conquestSelectedSpawnId)) {
        this.conquestSelectedSpawnId = 'hq';
        this.emitBanner('FOB UNDER ATTACK · SPAWN LOCKED — FALLBACK TO HQ', 'info');
      }
    }

    if (this.isAuthority) {
      this.territoryRateA = territoryRateA;
      this.territoryRateB = territoryRateB;

      const prevA = Math.floor(this.scoreA);
      const prevB = Math.floor(this.scoreB);
      this.scoreA += territoryRateA * dt;
      this.scoreB += territoryRateB * dt;

      // Credit territory points share to active living actors on each owning team
      if (territoryRateA > 0 || territoryRateB > 0) {
        for (let a = 0; a < actors.length; a++) {
          const act = actors[a];
          if (!act.alive) continue;
          if (act.team === 'A' && territoryRateA > 0) {
            this.getOrCreateStats(act.id).territoryPoints += territoryRateA * dt;
          } else if (act.team === 'B' && territoryRateB > 0) {
            this.getOrCreateStats(act.id).territoryPoints += territoryRateB * dt;
          }
        }
      }

      if (Math.floor(this.scoreA) !== prevA || Math.floor(this.scoreB) !== prevB) {
        this.callbacks.onScoreChanged?.(Math.floor(this.scoreA), Math.floor(this.scoreB));
      }

      if (this.scoreA >= this.scoreLimit) {
        this.triggerMatchEnd('A', undefined, 'Most Territory Controlled');
        return;
      } else if (this.scoreB >= this.scoreLimit) {
        this.triggerMatchEnd('B', undefined, 'Most Territory Controlled');
        return;
      }

      // Total-attrition deadlock safeguard: if every participant on both teams has expended
      // all loadouts and neither team holds any territory generating points, decide now by Territory Points.
      if (this.participantLives.size >= 2 && territoryRateA === 0 && territoryRateB === 0) {
        let anyActiveOrLiving = false;
        for (const p of this.participantLives.values()) {
          if (p.alive || (!p.eliminated && p.remainingLives > 0)) {
            anyActiveOrLiving = true;
            break;
          }
        }
        if (!anyActiveOrLiving) {
          this.resolveTimeLimitWinner(actors);
        }
      }
    }
  }

  private onPoiCaptured(poi: InternalPoiRuntime, team: 'A' | 'B', actors: readonly ModeActorSample[]): void {
    const rSq = poi.def.captureRadiusM * poi.def.captureRadiusM;
    const px = poi.def.position[0];
    const pz = poi.def.position[2];
    for (const act of actors) {
      if (!act.alive || act.team !== team) continue;
      const dx = act.x - px;
      const dz = act.z - pz;
      if (dx * dx + dz * dz <= rSq) {
        this.getOrCreateStats(act.id).poiCaptures += 1;
      }
    }
    this.callbacks.onAudioChime?.('capture');
    this.emitBanner(
      `${team === 'A' ? 'ALPHA' : 'BRAVO'} CAPTURED ${poi.def.code} · ${poi.def.label.toUpperCase()}`,
      team === 'A' ? 'alpha' : 'bravo',
    );
  }

  private updateCtf(dt: number, actors: readonly ModeActorSample[]): void {
    if (!this.flags) return;
    const [flagA, flagB] = this.flags;
    const pickupSq = CTF_PICKUP_RADIUS * CTF_PICKUP_RADIUS;

    for (let f = 0; f < 2; f++) {
      const flag = this.flags[f];
      const otherFlag = this.flags[1 - f];

      if (flag.status === 'carried') {
        const carrier = actors.find((a) => a.id === flag.carrierId);
        if (!carrier || !carrier.alive) {
          if (this.isAuthority) {
            flag.status = 'dropped';
            flag.carrierId = null;
            flag.carrierName = null;
            flag.returnTimerSec = CTF_AUTO_RETURN_SEC;
          }
        } else {
          flag.pos.set(carrier.x, carrier.y + 0.55, carrier.z);

          // Classic CTF capture rule: Enemy carrier reaches their OWN home flag stand
          // AND their OWN home flag MUST be at 'home' status!
          if (this.isAuthority && otherFlag.status === 'home') {
            const dx = carrier.x - otherFlag.homePos.x;
            const dz = carrier.z - otherFlag.homePos.z;
            if (dx * dx + dz * dz <= pickupSq * 1.35) {
              const scoringTeam = carrier.team === 'B' ? 'B' : 'A';
              if (scoringTeam === 'A') this.scoreA += 1;
              else this.scoreB += 1;
              this.getOrCreateStats(carrier.id).flagCaptures += 1;

              flag.status = 'home';
              flag.carrierId = null;
              flag.carrierName = null;
              flag.pos.copy(flag.homePos);
              flag.returnTimerSec = 0;

              this.callbacks.onAudioChime?.('flag_score');
              this.emitBanner(
                `${scoringTeam === 'A' ? 'ALPHA' : 'BRAVO'} CAPTURED THE FLAG!`,
                scoringTeam === 'A' ? 'alpha' : 'bravo',
              );
              this.callbacks.onScoreChanged?.(this.scoreA, this.scoreB);
              this.callbacks.onFlagEvent?.({
                flagTeam: flag.team,
                action: 'capture',
                actorId: carrier.id,
                actorName: carrier.name,
                actorTeam: carrier.team,
                x: otherFlag.homePos.x,
                y: otherFlag.homePos.y,
                z: otherFlag.homePos.z,
              });

              if (this.scoreA >= this.scoreLimit) {
                this.triggerMatchEnd('A', undefined, 'Flag Capture Limit Reached');
              } else if (this.scoreB >= this.scoreLimit) {
                this.triggerMatchEnd('B', undefined, 'Flag Capture Limit Reached');
              }
            }
          }
        }
      } else if (flag.status === 'dropped') {
        if (this.isAuthority) {
          flag.returnTimerSec -= dt;
          if (flag.returnTimerSec <= 0) {
            flag.status = 'home';
            flag.pos.copy(flag.homePos);
            flag.returnTimerSec = 0;
            this.callbacks.onAudioChime?.('flag_return');
            this.emitBanner(`${flag.team === 'A' ? 'ALPHA' : 'BRAVO'} FLAG AUTO-RETURNED`, 'info');
            this.callbacks.onFlagEvent?.({
              flagTeam: flag.team,
              action: 'return',
              x: flag.homePos.x,
              y: flag.homePos.y,
              z: flag.homePos.z,
            });
          } else {
            // Check actor pickup (enemy) or instant return (friendly)
            for (let a = 0; a < actors.length; a++) {
              const act = actors[a];
              if (!act.alive) continue;
              const dx = act.x - flag.pos.x;
              const dz = act.z - flag.pos.z;
              if (dx * dx + dz * dz > pickupSq) continue;

              if (act.team === flag.team) {
                // Teammate returns dropped flag!
                flag.status = 'home';
                flag.pos.copy(flag.homePos);
                flag.returnTimerSec = 0;
                this.getOrCreateStats(act.id).flagReturns += 1;
                this.callbacks.onAudioChime?.('flag_return');
                this.emitBanner(
                  `${act.name} RETURNED ${flag.team === 'A' ? 'ALPHA' : 'BRAVO'} FLAG`,
                  flag.team === 'A' ? 'alpha' : 'bravo',
                );
                this.callbacks.onFlagEvent?.({
                  flagTeam: flag.team,
                  action: 'return',
                  actorId: act.id,
                  actorName: act.name,
                  actorTeam: act.team,
                  x: flag.homePos.x,
                  y: flag.homePos.y,
                  z: flag.homePos.z,
                });
                break;
              } else {
                // Enemy picks up dropped flag
                flag.status = 'carried';
                flag.carrierId = act.id;
                flag.carrierName = act.name;
                flag.returnTimerSec = 0;
                this.callbacks.onAudioChime?.('flag_taken');
                this.emitBanner(
                  `${act.name} PICKED UP ${flag.team === 'A' ? 'ALPHA' : 'BRAVO'} FLAG`,
                  act.team === 'A' ? 'alpha' : 'bravo',
                );
                this.callbacks.onFlagEvent?.({
                  flagTeam: flag.team,
                  action: 'pickup',
                  actorId: act.id,
                  actorName: act.name,
                  actorTeam: act.team,
                  x: act.x,
                  y: act.y,
                  z: act.z,
                });
                break;
              }
            }
          }
        }
      } else if (flag.status === 'home' && this.isAuthority) {
        // Enemy steals flag from home stand
        for (let a = 0; a < actors.length; a++) {
          const act = actors[a];
          if (!act.alive || act.team === flag.team) continue;
          const dx = act.x - flag.homePos.x;
          const dz = act.z - flag.homePos.z;
          if (dx * dx + dz * dz <= pickupSq) {
            flag.status = 'carried';
            flag.carrierId = act.id;
            flag.carrierName = act.name;
            this.callbacks.onAudioChime?.('flag_taken');
            this.emitBanner(
              `${act.name} STOLE ${flag.team === 'A' ? 'ALPHA' : 'BRAVO'} FLAG!`,
              act.team === 'A' ? 'alpha' : 'bravo',
            );
            this.callbacks.onFlagEvent?.({
              flagTeam: flag.team,
              action: 'pickup',
              actorId: act.id,
              actorName: act.name,
              actorTeam: act.team,
              x: act.x,
              y: act.y,
              z: act.z,
            });
            break;
          }
        }
      }

      if (flag.meshGroup) {
        flag.meshGroup.position.copy(flag.pos);
        flag.meshGroup.rotation.y = this.elapsedSec * 1.4 + f * Math.PI;
      }
    }

    // Track if local player is carrying enemy flag
    if (flagA.carrierId === this.localPlayerId) {
      this.localStandingInObjective = 'CARRYING ALPHA FLAG · RETURN TO BASE';
    } else if (flagB.carrierId === this.localPlayerId) {
      this.localStandingInObjective = 'CARRYING BRAVO FLAG · RETURN TO BASE';
    }
  }

  private updateKoth(dt: number, actors: readonly ModeActorSample[]): void {
    if (this.kothHills.length === 0) return;

    this.hillTimerSec -= dt;
    if (this.isAuthority && this.hillTimerSec <= 0) {
      this.activeHillIndex = (this.activeHillIndex + 1) % this.kothHills.length;
      this.hillTimerSec = KOTH_HILL_DURATION_SEC;
      this.hillOwner = null;
      this.hillContested = false;
      this.syncKothHillVisuals();
      const nextHill = this.kothHills[this.activeHillIndex];
      this.callbacks.onAudioChime?.('hill_rotate');
      this.emitBanner(`HILL MOVED · ${nextHill.label.toUpperCase()}`, 'gold');
    }

    const active = this.kothHills[this.activeHillIndex % this.kothHills.length];
    const rSq = active.radiusM * active.radiusM;
    let countA = 0;
    let countB = 0;

    for (let a = 0; a < actors.length; a++) {
      const act = actors[a];
      if (!act.alive) continue;
      const dx = act.x - active.position[0];
      const dz = act.z - active.position[2];
      if (dx * dx + dz * dz <= rSq) {
        if (act.team === 'A') countA++;
        else if (act.team === 'B') countB++;
        if (act.isLocalPlayer) {
          this.localStandingInObjective = `HILL · ${active.label}`;
        }
      }
    }

    this.hillContested = countA > 0 && countB > 0;
    if (this.hillContested) {
      // Scoring pauses while contested
    } else if (countA > 0) {
      this.hillOwner = 'A';
      if (this.isAuthority) {
        const prevA = Math.floor(this.scoreA);
        this.scoreA += dt;
        for (const act of actors) {
          if (!act.alive || act.team !== 'A') continue;
          const dx = act.x - active.position[0];
          const dz = act.z - active.position[2];
          if (dx * dx + dz * dz <= rSq) {
            this.getOrCreateStats(act.id).hillControlSec += dt;
          }
        }
        if (Math.floor(this.scoreA) !== prevA) {
          this.callbacks.onScoreChanged?.(Math.floor(this.scoreA), Math.floor(this.scoreB));
        }
        if (this.scoreA >= this.scoreLimit) {
          this.triggerMatchEnd('A', undefined, 'Hill Control Limit Reached');
        }
      }
    } else if (countB > 0) {
      this.hillOwner = 'B';
      if (this.isAuthority) {
        const prevB = Math.floor(this.scoreB);
        this.scoreB += dt;
        for (const act of actors) {
          if (!act.alive || act.team !== 'B') continue;
          const dx = act.x - active.position[0];
          const dz = act.z - active.position[2];
          if (dx * dx + dz * dz <= rSq) {
            this.getOrCreateStats(act.id).hillControlSec += dt;
          }
        }
        if (Math.floor(this.scoreB) !== prevB) {
          this.callbacks.onScoreChanged?.(Math.floor(this.scoreA), Math.floor(this.scoreB));
        }
        if (this.scoreB >= this.scoreLimit) {
          this.triggerMatchEnd('B', undefined, 'Hill Control Limit Reached');
        }
      }
    } else {
      this.hillOwner = null;
    }

    if (this.activeHillRingMat) {
      const hex = this.hillContested
        ? COLOR_CONTESTED
        : this.hillOwner === 'A'
          ? COLOR_TEAM_A
          : this.hillOwner === 'B'
            ? COLOR_TEAM_B
            : COLOR_NEUTRAL;
      this.activeHillRingMat.color.setHex(hex);
    }
    if (this.nextHillMesh) {
      this.nextHillMesh.visible = this.hillTimerSec <= KOTH_PREVIEW_SEC && this.kothHills.length > 1;
    }
  }

  private updateKillConfirmed(dt: number, actors: readonly ModeActorSample[]): void {
    const pickupSq = DOGTAG_PICKUP_RADIUS * DOGTAG_PICKUP_RADIUS;

    for (let i = 0; i < this.dogtags.length; i++) {
      const slot = this.dogtags[i];
      if (!slot.active) continue;

      slot.ageSec += dt;
      if (this.isAuthority && slot.ageSec >= DOGTAG_LIFETIME_SEC) {
        slot.active = false;
        if (slot.meshGroup) slot.meshGroup.visible = false;
        continue;
      }

      // Spin & gentle hover animation
      if (slot.meshGroup) {
        slot.meshGroup.rotation.y = this.elapsedSec * 2.2 + i * 0.7;
        slot.meshGroup.position.y = slot.y + Math.sin(this.elapsedSec * 3.1 + i) * 0.08;
      }

      if (!this.isAuthority) continue;

      for (let a = 0; a < actors.length; a++) {
        const act = actors[a];
        if (!act.alive) continue;
        // Prevent the dying operator from instantly picking up their own tag on frame 0
        if (act.id === slot.victimId && slot.ageSec < 0.75) continue;
        const dx = act.x - slot.x;
        const dy = act.y - slot.y;
        const dz = act.z - slot.z;
        if (dx * dx + dz * dz <= pickupSq && Math.abs(dy) < 2.2) {
          this.collectDogtag(slot, act);
          break;
        }
      }
    }
  }

  private resolveTimeLimitWinner(actors: readonly ModeActorSample[]): void {
    if (this.rule === 'kc_ffa') {
      let bestId: string | undefined;
      let bestTags = -1;
      for (const act of actors) {
        const tags = this.getOrCreateStats(act.id).enemyDogtags;
        if (tags > bestTags) {
          bestTags = tags;
          bestId = act.id;
        }
      }
      this.triggerMatchEnd('FFA', bestId, 'Time Expired · Most Enemy Dogtags');
      return;
    }

    const sA = Math.floor(this.scoreA);
    const sB = Math.floor(this.scoreB);
    const reason =
      this.rule === 'conquest'
        ? 'Time Expired · Most Territory Controlled'
        : this.rule === 'kc_tdm'
          ? 'Time Expired · Most Enemy Dogtags'
          : this.rule === 'ctf'
            ? 'Time Expired · Most Flag Captures'
            : 'Time Expired · Most Hill Control';

    if (sA > sB) this.triggerMatchEnd('A', undefined, reason);
    else if (sB > sA) this.triggerMatchEnd('B', undefined, reason);
    else this.triggerMatchEnd('DRAW', undefined, 'Time Expired · Draw');
  }

  private triggerMatchEnd(
    winnerTeam: 'A' | 'B' | 'FFA' | 'DRAW',
    winnerActorId: string | undefined,
    reason: string,
  ): void {
    if (this.matchEnded) return;
    this.matchEnded = true;
    this.matchWinnerTeam = winnerTeam;
    this.matchWinnerActorId = winnerActorId;
    this.matchWinnerReason = reason;
    this.callbacks.onMatchVictory?.({ winnerTeam, winnerActorId, reason });
  }

  // =========================================================================
  // 6. BOT AI OBJECTIVE DIRECTIVE API
  // =========================================================================

  public getBotObjectiveTarget(
    botId: string,
    botTeam: 'A' | 'B' | 'FFA',
    botPos: Readonly<THREE.Vector3>,
  ): { position: [number, number, number]; label: string; priority: number } | null {
    if (this.rule === 'conquest' && this.pois.length > 0) {
      let bestPoi: InternalPoiRuntime | null = null;
      let bestScore = -Infinity;
      for (const poi of this.pois) {
        const dist = Math.hypot(poi.def.position[0] - botPos.x, poi.def.position[2] - botPos.z);
        let weight = poi.def.territoryWeight * 25;
        if (poi.owner !== botTeam) weight += 45; // prioritize neutral or enemy POIs
        if (poi.contested) weight += 32; // defend contested sectors!
        if (poi.def.kind === 'fob' && poi.owner !== botTeam) weight += 18;
        const score = weight - dist * 0.45;
        if (score > bestScore) {
          bestScore = score;
          bestPoi = poi;
        }
      }
      if (bestPoi) {
        return {
          position: bestPoi.def.position,
          label: bestPoi.def.code,
          priority: bestPoi.owner !== botTeam || bestPoi.contested ? 1.0 : 0.45,
        };
      }
    }

    if (this.rule === 'ctf' && this.flags && (botTeam === 'A' || botTeam === 'B')) {
      const ownFlag = botTeam === 'A' ? this.flags[0] : this.flags[1];
      const enemyFlag = botTeam === 'A' ? this.flags[1] : this.flags[0];

      // If this bot carries the enemy flag, sprint back to own home stand!
      if (enemyFlag.carrierId === botId) {
        return {
          position: [ownFlag.homePos.x, ownFlag.homePos.y, ownFlag.homePos.z],
          label: 'Return Captured Flag',
          priority: 1.5,
        };
      }
      // If own flag is dropped or stolen, prioritize recovering it!
      if (ownFlag.status !== 'home') {
        return {
          position: [ownFlag.pos.x, ownFlag.pos.y, ownFlag.pos.z],
          label: 'Recover Friendly Flag',
          priority: 1.25,
        };
      }
      // Otherwise push enemy flag
      return {
        position: [enemyFlag.pos.x, enemyFlag.pos.y, enemyFlag.pos.z],
        label: 'Capture Enemy Flag',
        priority: 1.0,
      };
    }

    if (this.rule === 'koth' && this.kothHills.length > 0) {
      // Pre-rotate to next hill if < 6s remain and bot is far from active hill
      const active = this.kothHills[this.activeHillIndex % this.kothHills.length];
      const next = this.kothHills[(this.activeHillIndex + 1) % this.kothHills.length];
      const distActive = Math.hypot(active.position[0] - botPos.x, active.position[2] - botPos.z);
      if (this.hillTimerSec < 6.0 && distActive > 22 && this.kothHills.length > 1) {
        return { position: next.position, label: `Rotate: ${next.label}`, priority: 1.1 };
      }
      return { position: active.position, label: active.label, priority: 1.2 };
    }

    if (isKillConfirmedRule(this.rule)) {
      let bestTag: InternalDogtagSlot | null = null;
      let bestScore = -Infinity;
      for (const slot of this.dogtags) {
        if (!slot.active) continue;
        const dist = Math.hypot(slot.x - botPos.x, slot.z - botPos.z);
        if (dist > 34) continue;
        const isFriendly =
          this.rule === 'kc_ffa' ? slot.victimId === botId : slot.victimTeam === botTeam;
        // Prefer enemy tags slightly more for winning, but still rescue nearby friendly tags
        const score = (isFriendly ? 24 : 36) - dist;
        if (score > bestScore) {
          bestScore = score;
          bestTag = slot;
        }
      }
      if (bestTag) {
        return {
          position: [bestTag.x, bestTag.y, bestTag.z],
          label: 'Secure Dogtag',
          priority: 1.15,
        };
      }
    }

    return null;
  }

  // =========================================================================
  // 7. HOST-AUTHORITATIVE MULTIPLAYER SYNC & HUD SNAPSHOT
  // =========================================================================

  public exportSyncPacket(): GameModeStatePacket {
    const pois: SyncedConquestPoiState[] | undefined =
      this.rule === 'conquest'
        ? this.pois.map((p) => ({
            id: p.def.id,
            owner: p.owner,
            progress: Number(p.progress.toFixed(3)),
            contested: p.contested,
            underAttack: p.underAttack,
          }))
        : undefined;

    const attrition = this.rule === 'conquest' ? this.getConquestTeamAttrition() : null;

    const flags: [SyncedCtfFlagState, SyncedCtfFlagState] | undefined =
      this.rule === 'ctf' && this.flags
        ? [
            {
              team: this.flags[0].team,
              status: this.flags[0].status,
              carrierId: this.flags[0].carrierId,
              x: Number(this.flags[0].pos.x.toFixed(2)),
              y: Number(this.flags[0].pos.y.toFixed(2)),
              z: Number(this.flags[0].pos.z.toFixed(2)),
              returnTimerSec: Number(this.flags[0].returnTimerSec.toFixed(1)),
            },
            {
              team: this.flags[1].team,
              status: this.flags[1].status,
              carrierId: this.flags[1].carrierId,
              x: Number(this.flags[1].pos.x.toFixed(2)),
              y: Number(this.flags[1].pos.y.toFixed(2)),
              z: Number(this.flags[1].pos.z.toFixed(2)),
              returnTimerSec: Number(this.flags[1].returnTimerSec.toFixed(1)),
            },
          ]
        : undefined;

    const dogtags: SyncedDogtagState[] | undefined = isKillConfirmedRule(this.rule)
      ? this.dogtags
          .filter((d) => d.active)
          .map((d) => ({
            id: d.id,
            victimId: d.victimId,
            victimTeam: d.victimTeam,
            x: Number(d.x.toFixed(2)),
            y: Number(d.y.toFixed(2)),
            z: Number(d.z.toFixed(2)),
          }))
      : undefined;

    return {
      type: 'game:mode_state',
      rule: this.rule,
      scoreA: Math.floor(this.scoreA),
      scoreB: Math.floor(this.scoreB),
      friendlyTagsA: this.friendlyTagsA,
      friendlyTagsB: this.friendlyTagsB,
      remainingSec: Math.round(this.remainingSec),
      pois,
      territoryRateA: this.rule === 'conquest' ? Number(this.territoryRateA.toFixed(2)) : undefined,
      territoryRateB: this.rule === 'conquest' ? Number(this.territoryRateB.toFixed(2)) : undefined,
      teamRemainingLivesA: attrition?.remainingLivesA,
      teamRemainingLivesB: attrition?.remainingLivesB,
      teamActiveCountA: attrition?.activeCountA,
      teamActiveCountB: attrition?.activeCountB,
      flags,
      activeHillIndex: this.rule === 'koth' ? this.activeHillIndex : undefined,
      nextHillIndex:
        this.rule === 'koth' && this.kothHills.length > 0
          ? (this.activeHillIndex + 1) % this.kothHills.length
          : undefined,
      hillTimerSec: this.rule === 'koth' ? Number(this.hillTimerSec.toFixed(1)) : undefined,
      hillOwner: this.rule === 'koth' ? this.hillOwner : undefined,
      hillContested: this.rule === 'koth' ? this.hillContested : undefined,
      dogtags,
      matchEnded: this.matchEnded || undefined,
      winnerTeam: this.matchWinnerTeam,
      winnerActorId: this.matchWinnerActorId,
      winnerReason: this.matchWinnerReason,
      ts: Date.now(),
    };
  }

  public applySyncPacket(pkt: GameModeStatePacket): void {
    if (this.isAuthority) return;
    this.scoreA = pkt.scoreA;
    this.scoreB = pkt.scoreB;
    if (typeof pkt.friendlyTagsA === 'number') this.friendlyTagsA = pkt.friendlyTagsA;
    if (typeof pkt.friendlyTagsB === 'number') this.friendlyTagsB = pkt.friendlyTagsB;
    this.remainingSec = pkt.remainingSec;

    if (pkt.pois && this.rule === 'conquest') {
      for (const sp of pkt.pois) {
        const local = this.pois.find((p) => p.def.id === sp.id);
        if (local) {
          local.owner = sp.owner;
          local.progress = sp.progress;
          local.contested = sp.contested;
          local.underAttack = Boolean(sp.underAttack ?? sp.contested);
        }
      }
      if (typeof pkt.territoryRateA === 'number') this.territoryRateA = pkt.territoryRateA;
      if (typeof pkt.territoryRateB === 'number') this.territoryRateB = pkt.territoryRateB;
      if (typeof pkt.teamRemainingLivesA === 'number') {
        this.syncedTeamRemainingLivesA = pkt.teamRemainingLivesA;
      }
      if (typeof pkt.teamRemainingLivesB === 'number') {
        this.syncedTeamRemainingLivesB = pkt.teamRemainingLivesB;
      }
      if (typeof pkt.teamActiveCountA === 'number') {
        this.syncedTeamActiveCountA = pkt.teamActiveCountA;
      }
      if (typeof pkt.teamActiveCountB === 'number') {
        this.syncedTeamActiveCountB = pkt.teamActiveCountB;
      }
      // Invalidate local selected FOB immediately on client if host reports it under attack
      if (this.conquestAwaitingRedeploy && this.conquestSelectedSpawnId !== 'hq') {
        const team = this.localTeam === 'B' ? 'B' : 'A';
        if (!this.isConquestSpawnAvailable(team, this.conquestSelectedSpawnId)) {
          this.conquestSelectedSpawnId = 'hq';
          this.emitBanner('FOB UNDER ATTACK · SPAWN LOCKED — FALLBACK TO HQ', 'info');
        }
      }
    }

    if (pkt.flags && this.rule === 'ctf' && this.flags) {
      for (let i = 0; i < 2; i++) {
        const sf = pkt.flags[i];
        const lf = this.flags[i];
        lf.status = sf.status;
        lf.carrierId = sf.carrierId;
        lf.pos.set(sf.x, sf.y, sf.z);
        lf.returnTimerSec = sf.returnTimerSec;
      }
    }

    if (this.rule === 'koth' && typeof pkt.activeHillIndex === 'number') {
      const changed = pkt.activeHillIndex !== this.activeHillIndex;
      this.activeHillIndex = pkt.activeHillIndex;
      if (typeof pkt.hillTimerSec === 'number') this.hillTimerSec = pkt.hillTimerSec;
      this.hillOwner = pkt.hillOwner ?? null;
      this.hillContested = Boolean(pkt.hillContested);
      if (changed) this.syncKothHillVisuals();
    }

    if (pkt.dogtags && isKillConfirmedRule(this.rule)) {
      const incomingIds = new Set(pkt.dogtags.map((d) => d.id));
      for (const slot of this.dogtags) {
        if (slot.active && !incomingIds.has(slot.id)) {
          slot.active = false;
          if (slot.meshGroup) slot.meshGroup.visible = false;
        }
      }
      for (const d of pkt.dogtags) {
        const existing = this.dogtags.find((s) => s.active && s.id === d.id);
        if (!existing) {
          this.spawnDogtag(d.victimId, d.victimTeam, d.x, d.y, d.z, d.id);
        }
      }
    }

    if (pkt.matchEnded && !this.matchEnded && pkt.winnerTeam) {
      this.triggerMatchEnd(
        pkt.winnerTeam,
        pkt.winnerActorId,
        pkt.winnerReason ?? 'Match Completed',
      );
    }
  }

  public applyDogtagEventPacket(pkt: GameDogtagEventPacket): void {
    if (this.isAuthority || !isKillConfirmedRule(this.rule)) return;
    if (pkt.action === 'spawn') {
      if (!this.dogtags.some((s) => s.active && s.id === pkt.tagId)) {
        this.spawnDogtag(pkt.victimId, pkt.victimTeam, pkt.x, pkt.y, pkt.z, pkt.tagId);
      }
    } else if (pkt.action === 'collect') {
      const slot = this.dogtags.find((s) => s.active && s.id === pkt.tagId);
      if (slot) {
        slot.active = false;
        if (slot.meshGroup) slot.meshGroup.visible = false;
      }
      if (pkt.collectorId === this.localPlayerId) {
        this.callbacks.onDogtagAudio?.(Boolean(pkt.isFriendly), Boolean(pkt.isSelfRecovery));
      }
    }
  }

  public applyFlagEventPacket(pkt: GameFlagEventPacket): void {
    if (this.isAuthority || this.rule !== 'ctf') return;
    if (pkt.action === 'capture') this.callbacks.onAudioChime?.('flag_score');
    else if (pkt.action === 'pickup') this.callbacks.onAudioChime?.('flag_taken');
    else if (pkt.action === 'return') this.callbacks.onAudioChime?.('flag_return');
  }

  public getHudSnapshot(): BattleModeHudSnapshot {
    const localStats = this.getActorStats(this.localPlayerId);
    const localTeamAB = this.localTeam === 'B' ? 'B' : 'A';
    const remainingLives = this.conquestLoadouts.filter((l) => !l.expended).length;

    let activeDogtagCount = 0;
    for (let i = 0; i < this.dogtags.length; i++) {
      if (this.dogtags[i].active) activeDogtagCount++;
    }

    const koth: KothHudState | null =
      this.rule === 'koth' && this.kothHills.length > 0
        ? (() => {
            const cur = this.kothHills[this.activeHillIndex % this.kothHills.length];
            const nxt = this.kothHills[(this.activeHillIndex + 1) % this.kothHills.length];
            return {
              activeHillIndex: this.activeHillIndex,
              activeHillLabel: cur.label,
              activeHillPos: cur.position,
              nextHillLabel: nxt.label,
              nextHillPos: nxt.position,
              hillTimerSec: Math.ceil(this.hillTimerSec),
              previewActive: this.hillTimerSec <= KOTH_PREVIEW_SEC && this.kothHills.length > 1,
              owner: this.hillOwner,
              contested: this.hillContested,
            };
          })()
        : null;

    const ctfFlags: [CtfFlagHudState, CtfFlagHudState] | null =
      this.rule === 'ctf' && this.flags
        ? [
            {
              team: this.flags[0].team,
              label: this.flags[0].label,
              status: this.flags[0].status,
              carrierId: this.flags[0].carrierId,
              carrierName: this.flags[0].carrierName,
              returnTimerSec: Math.ceil(this.flags[0].returnTimerSec),
              position: [this.flags[0].pos.x, this.flags[0].pos.y, this.flags[0].pos.z],
            },
            {
              team: this.flags[1].team,
              label: this.flags[1].label,
              status: this.flags[1].status,
              carrierId: this.flags[1].carrierId,
              carrierName: this.flags[1].carrierName,
              returnTimerSec: Math.ceil(this.flags[1].returnTimerSec),
              position: [this.flags[1].pos.x, this.flags[1].pos.y, this.flags[1].pos.z],
            },
          ]
        : null;

    const teamAttrition = this.getConquestTeamAttrition();

    return {
      rule: this.rule,
      scoreA: Math.floor(this.scoreA),
      scoreB: Math.floor(this.scoreB),
      scoreLimit: this.scoreLimit,
      remainingSec: Math.ceil(this.remainingSec),
      friendlyTagsA: this.friendlyTagsA,
      friendlyTagsB: this.friendlyTagsB,
      localEnemyTags: localStats.enemyDogtags,
      localFriendlyTags: localStats.friendlyDogtags,
      localSelfTags: localStats.selfDogtagsRecovered,
      activeDogtagCount,
      conquestPois: this.pois.map((p) => ({
        id: p.def.id,
        code: p.def.code,
        label: p.def.label,
        kind: p.def.kind,
        owner: p.owner,
        progress: p.progress,
        contested: p.contested,
        underAttack: p.underAttack,
        position: p.def.position,
        captureRadiusM: p.def.captureRadiusM,
        territoryWeight: p.def.territoryWeight,
        canSpawnA: p.def.kind === 'fob' && p.owner === 'A' && !p.contested && !p.underAttack,
        canSpawnB: p.def.kind === 'fob' && p.owner === 'B' && !p.contested && !p.underAttack,
      })),
      conquestLoadouts: this.conquestLoadouts.map((l) => ({ ...l })),
      conquestRemainingLives: remainingLives,
      conquestTotalLives: this.conquestLoadouts.length,
      conquestSpawnOptions:
        this.rule === 'conquest' ? this.getConquestSpawnOptionsForTeam(localTeamAB) : [],
      conquestSelectedSpawnId: this.conquestSelectedSpawnId,
      conquestAwaitingRedeploy: this.conquestAwaitingRedeploy,
      conquestSpectating: this.conquestSpectating,
      conquestTerritoryRateA: Number(this.territoryRateA.toFixed(1)),
      conquestTerritoryRateB: Number(this.territoryRateB.toFixed(1)),
      conquestTeamRemainingLivesA: teamAttrition.remainingLivesA,
      conquestTeamRemainingLivesB: teamAttrition.remainingLivesB,
      conquestTeamActiveCountA: teamAttrition.activeCountA,
      conquestTeamActiveCountB: teamAttrition.activeCountB,
      ctfFlags,
      koth,
      localStandingInObjective: this.localStandingInObjective,
      lastBannerText: this.lastBannerText,
    };
  }

  public isTeamMode(): boolean {
    return isTeamBattleRule(this.rule);
  }

  public dispose(): void {
    this.propGroup.parent?.remove(this.propGroup);
    this.ownedGeos.forEach((g) => g.dispose());
    this.ownedMats.forEach((m) => m.dispose());
    this.ownedGeos.length = 0;
    this.ownedMats.length = 0;
  }
}

function buildFallbackObjectives(map: BuiltMapInstance): MapBattleObjectives {
  const spA = map.spawnPoints.teamA[0]?.position ?? [0, 0, -25];
  const spB = map.spawnPoints.teamB[0]?.position ?? [0, 0, 25];
  return {
    hqA: {
      id: 'hq_a',
      team: 'A',
      label: 'Alpha HQ',
      position: [...spA],
      safeRadiusM: 10,
      spawnPoints: map.spawnPoints.teamA,
    },
    hqB: {
      id: 'hq_b',
      team: 'B',
      label: 'Bravo HQ',
      position: [...spB],
      safeRadiusM: 10,
      spawnPoints: map.spawnPoints.teamB,
    },
    conquestPois: [
      {
        id: 'poi_center',
        code: 'OUTPOST',
        label: 'Central Sector',
        kind: 'outpost',
        position: [0, 0, 0],
        captureRadiusM: 8,
        territoryWeight: 1.5,
      },
    ],
    ctfFlags: [
      { team: 'A', label: 'Alpha Flag', position: [...spA] },
      { team: 'B', label: 'Bravo Flag', position: [...spB] },
    ],
    kothHills: [{ id: 'hill_center', label: 'Central Sector', position: [0, 0, 0], radiusM: 8 }],
  };
}

import * as THREE from 'three';
import { BodycamAudio, resolveWeaponProfile } from '../bodycam-sdk';
import {
  DEFAULT_OPERATOR_ID,
  normalizeOperatorId,
  OperatorId,
} from '../bodycam-sdk/operator/OperatorTypes';
import {
  GamePlayerFirePacket,
  GamePlayerRespawnPacket,
  GamePlayerStatePacket,
  LobbyMember,
  OperatorUniformId,
  resolveOperatorUniformId,
  SyncedAimStance,
  SyncedHandlingAction,
  unpackSyncedWeaponAttachments,
} from '../data/multiplayer';
import { WeaponAttachments } from '../data/attachments';
import { BattleScoreEntry, BattleTeamId } from './BattleBotAI';
import {
  BuiltTacticalOperatorRig,
  TacticalCombatPose,
  TacticalOperatorRigFactory,
} from './TacticalOperatorRig';

interface RemoteOperator {
  userId: string;
  username: string;
  team: BattleTeamId;
  uniformId: OperatorUniformId;
  operatorId: OperatorId;
  alive: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
  weaponId: string;
  attachments: WeaponAttachments;
  suppressed: boolean;
  handlingAction: SyncedHandlingAction;
  handlingProgress: number;
  targetHandlingProgress: number;
  lastUpdateMs: number;

  // Interpolated vs target kinematic & stance state
  curPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  curYaw: number;
  targetYaw: number;
  curPitch: number;
  targetPitch: number;
  crouchBlend: number;
  targetCrouch: number;
  leanBlend: number;
  targetLean: number;
  adsBlend: number;
  targetAds: number;
  pointAimBlend: number;
  targetPointAim: number;
  cantBlend: number;
  targetCant: number;
  reloadBlend: number;
  targetReload: number;
  adsMode: 'PRIMARY' | 'POINT_AIM' | 'CANTED';
  aimStance: SyncedAimStance;
  isFiring: boolean;
  isReloading: boolean;
  lastFireSeq: number;
  sprint: boolean;
  walkCycle: number;
  muzzleFlashTimer: number;
  recoilKickTimer: number;
  hitFlinchTimer: number;
  flashlightOn: boolean;
  laserOn: boolean;
  hasInitialState: boolean;
  gearSig: string;

  // Unified Tactical 3D Rig
  rig: BuiltTacticalOperatorRig;
  nameSprite: THREE.Sprite;
  nameTexture: THREE.CanvasTexture;
}

interface PooledRemoteTracer {
  active: boolean;
  life: number;
  maxLife: number;
  mesh: THREE.Mesh;
}

const MAX_REMOTE_TRACERS = 36;

function normalizeAngleDelta(from: number, to: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/**
 * Renders and smoothly interpolates all remote multiplayer human operators at 60–144 FPS
 * from 20 Hz WebSocket snapshots using the unified `TacticalOperatorRigFactory` matching
 * `CharacterSkeleton` and `BattleBotAI`, including accurate Primary ADS, 35° Point-Aim,
 * Canted ADS, continuous firing recoil & reload posture, spatial gunfire, and ballistic hitboxes.
 */
export class RemotePlayerManager {
  public readonly group = new THREE.Group();
  private readonly players = new Map<string, RemoteOperator>();
  private readonly tracers: PooledRemoteTracer[] = [];
  private tracerCursor = 0;

  private readonly audio: BodycamAudio;
  private readonly localUserId: string;
  private readonly localTeam: BattleTeamId;
  private readonly mode: 'battle' | 'infection';
  private readonly battleRule: 'tdm' | 'ffa';
  private readonly rigFactory: TacticalOperatorRigFactory;

  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly activeHitMeshes: THREE.Object3D[] = [];

  // Scratch vectors (zero-GC)
  private readonly _tmpMid = new THREE.Vector3();
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpUp = new THREE.Vector3(0, 1, 0);
  private readonly _tmpStart = new THREE.Vector3();
  private readonly _tmpEnd = new THREE.Vector3();
  private readonly _tmpSoundPos = new THREE.Vector3();
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
    handlingAction: 'NONE',
    handlingProgress: 0,
  };

  constructor(
    scene: THREE.Scene,
    audio: BodycamAudio,
    localUserId: string,
    localTeam: BattleTeamId,
    mode: 'battle' | 'infection',
    battleRule: 'tdm' | 'ffa',
    initialMembers: LobbyMember[],
    maxAnisotropy = 4,
  ) {
    this.audio = audio;
    this.localUserId = localUserId;
    this.localTeam = localTeam;
    this.mode = mode;
    this.battleRule = battleRule;
    this.rigFactory = new TacticalOperatorRigFactory(maxAnisotropy);

    scene.add(this.group);

    // Pooled tracers for remote weapon fire
    const geoTracer = this.track(new THREE.CylinderGeometry(0.011, 0.011, 1.0, 5));
    const matTracer = this.track(
      new THREE.MeshBasicMaterial({ color: 0xffd778, transparent: true, opacity: 0.88 }),
    );
    for (let i = 0; i < MAX_REMOTE_TRACERS; i++) {
      const m = new THREE.Mesh(geoTracer, matTracer);
      m.visible = false;
      this.group.add(m);
      this.tracers.push({ active: false, life: 0, maxLife: 0.09, mesh: m });
    }

    // Pre-create tactical operator rigs for lobby peers (hidden until first state packet arrives)
    for (const m of initialMembers) {
      if (m.userId === localUserId) continue;
      const team: BattleTeamId =
        mode === 'infection' ? 'A' : battleRule === 'ffa' ? 'FFA' : m.team;
      this.ensurePlayer(m.userId, m.username, team);
    }
  }

  private track<T extends { dispose: () => void }>(res: T): T {
    this.disposables.push(res);
    return res;
  }

  private resolveBattleTeam(rawTeam?: 'A' | 'B' | 'FFA'): BattleTeamId {
    if (this.mode === 'infection') return 'A';
    if (this.battleRule === 'ffa') return 'FFA';
    return rawTeam === 'B' ? 'B' : 'A';
  }

  public isFriendly(userId: string): boolean {
    const p = this.players.get(userId);
    if (!p) return false;
    if (this.mode === 'infection') return true;
    if (this.battleRule === 'ffa') return false;
    return p.team === this.localTeam;
  }

  public getPlayerInfo(
    userId: string,
  ): { userId: string; username: string; team: BattleTeamId; alive: boolean } | null {
    const p = this.players.get(userId);
    if (!p) return null;
    return { userId: p.userId, username: p.username, team: p.team, alive: p.alive };
  }

  public getPlayerHeadPosition(userId: string, out: THREE.Vector3): boolean {
    const p = this.players.get(userId);
    if (!p || !p.alive) return false;
    out.set(p.curPos.x, p.curPos.y + 1.98, p.curPos.z);
    return true;
  }

  private createNameplateTexture(username: string, team: BattleTeamId): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 56;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const accent =
        this.mode === 'infection'
          ? '#84cc16'
          : team === 'A'
            ? '#38bdf8'
            : team === 'B'
              ? '#f97316'
              : '#f59e0b';
      ctx.fillStyle = 'rgba(10, 12, 16, 0.78)';
      ctx.fillRect(10, 8, canvas.width - 20, 40);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 8, canvas.width - 20, 40);

      ctx.font = 'bold 21px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(username.slice(0, 16), canvas.width / 2, 29);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  private ensurePlayer(
    userId: string,
    username: string,
    team: BattleTeamId,
    explicitUniformId?: OperatorUniformId,
    explicitOperatorId?: OperatorId,
  ): RemoteOperator {
    const targetUniformId = explicitUniformId ?? resolveOperatorUniformId(this.mode, team);
    const existing = this.players.get(userId);
    if (existing) {
      if (existing.username !== username) {
        existing.username = username;
      }
      if (existing.team !== team) {
        existing.team = team;
      }
      if (existing.uniformId !== targetUniformId) {
        existing.uniformId = targetUniformId;
        existing.rig.applyUniform(targetUniformId);
      }
      if (explicitOperatorId) {
        const targetOperatorId = normalizeOperatorId(explicitOperatorId);
        if (existing.operatorId !== targetOperatorId) {
          const oldRoot = existing.rig.root;
          const wasVisible = oldRoot.visible;
          const newRig = this.rigFactory.buildOperator(
            'remote_player',
            userId,
            existing.uniformId,
            targetOperatorId,
          );
          newRig.root.position.copy(existing.curPos);
          newRig.bodyPivot.rotation.y = existing.curYaw;
          newRig.root.visible = wasVisible;
          oldRoot.remove(existing.nameSprite);
          newRig.root.add(existing.nameSprite);
          existing.rig.disposeWeapon();
          this.group.remove(oldRoot);
          this.group.add(newRig.root);
          existing.rig = newRig;
          existing.rig.setWeaponLoadout(existing.weaponId, existing.attachments);
          existing.rig.setSuppressedVisual(existing.suppressed);
          existing.operatorId = targetOperatorId;
          existing.gearSig = '';
        }
      }
      return existing;
    }

    const operatorId: OperatorId = explicitOperatorId
      ? normalizeOperatorId(explicitOperatorId)
      : DEFAULT_OPERATOR_ID;
    const rig = this.rigFactory.buildOperator('remote_player', userId, targetUniformId, operatorId);
    rig.setWeaponLoadout('m4a1', {});
    rig.root.visible = false; // Hidden until first network position arrives

    // Overhead callsign nameplate
    const nameTexture = this.createNameplateTexture(username, team);
    const nameMat = new THREE.SpriteMaterial({
      map: nameTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const nameSprite = new THREE.Sprite(nameMat);
    nameSprite.position.set(0, 2.08, 0);
    nameSprite.scale.set(0.86, 0.19, 1);
    rig.root.add(nameSprite);

    this.group.add(rig.root);

    const op: RemoteOperator = {
      userId,
      username,
      team,
      uniformId: targetUniformId,
      operatorId,
      alive: true,
      hp: 100,
      maxHp: 100,
      kills: 0,
      deaths: 0,
      weaponId: 'm4a1',
      attachments: {},
      suppressed: false,
      handlingAction: 'NONE',
      handlingProgress: 0,
      targetHandlingProgress: 0,
      lastUpdateMs: performance.now(),

      curPos: new THREE.Vector3(),
      targetPos: new THREE.Vector3(),
      curYaw: 0,
      targetYaw: 0,
      curPitch: 0,
      targetPitch: 0,
      crouchBlend: 0,
      targetCrouch: 0,
      leanBlend: 0,
      targetLean: 0,
      adsBlend: 0,
      targetAds: 0,
      pointAimBlend: 0,
      targetPointAim: 0,
      cantBlend: 0,
      targetCant: 0,
      reloadBlend: 0,
      targetReload: 0,
      adsMode: 'PRIMARY',
      aimStance: 'HIP',
      isFiring: false,
      isReloading: false,
      lastFireSeq: 0,
      sprint: false,
      walkCycle: 0,
      muzzleFlashTimer: 0,
      recoilKickTimer: 0,
      hitFlinchTimer: 0,
      flashlightOn: false,
      laserOn: false,
      hasInitialState: false,
      gearSig: '',

      rig,
      nameSprite,
      nameTexture,
    };

    this.players.set(userId, op);
    return op;
  }

  public applyStatePacket(pkt: GamePlayerStatePacket): void {
    const uid = pkt.senderUserId;
    if (!uid || uid === this.localUserId) return;

    const team = this.resolveBattleTeam(pkt.senderTeam);
    const expectedUniform = resolveOperatorUniformId(this.mode, team);
    const uniformId: OperatorUniformId =
      pkt.uniformId === 'team_a' ||
      pkt.uniformId === 'team_b' ||
      pkt.uniformId === 'ffa' ||
      pkt.uniformId === 'infection'
        ? pkt.uniformId
        : expectedUniform;

    const op = this.ensurePlayer(
      uid,
      pkt.senderUsername ?? 'OPERATOR',
      team,
      uniformId,
      pkt.operatorId,
    );

    const distSq = op.curPos.distanceToSquared(this._tmpStart.set(pkt.x, pkt.y, pkt.z));

    op.targetPos.set(pkt.x, pkt.y, pkt.z);
    op.targetYaw = pkt.yaw;
    op.targetPitch = THREE.MathUtils.clamp(pkt.pitch, -1.35, 1.35);
    op.targetCrouch = pkt.crouch ? 1 : 0;
    op.targetLean = THREE.MathUtils.clamp(pkt.lean, -1, 1);

    // Resolve full tactical aim stance (HIP | ADS | POINT_AIM | CANTED_ADS)
    const stance: SyncedAimStance =
      pkt.aimStance === 'POINT_AIM' ||
      pkt.aimStance === 'CANTED_ADS' ||
      pkt.aimStance === 'ADS' ||
      pkt.aimStance === 'HIP'
        ? pkt.aimStance
        : pkt.isPointAim
          ? 'POINT_AIM'
          : pkt.isCanted
            ? 'CANTED_ADS'
            : pkt.ads
              ? pkt.adsMode === 'POINT_AIM'
                ? 'POINT_AIM'
                : pkt.adsMode === 'CANTED'
                  ? 'CANTED_ADS'
                  : 'ADS'
              : 'HIP';

    op.aimStance = stance;
    op.adsMode = pkt.adsMode ?? (stance === 'POINT_AIM' ? 'POINT_AIM' : stance === 'CANTED_ADS' ? 'CANTED' : 'PRIMARY');

    const aimingAny = stance !== 'HIP' || Boolean(pkt.ads) || Boolean(pkt.isPointAim) || Boolean(pkt.isCanted);
    op.targetAds = Number.isFinite(pkt.adsBlend)
      ? THREE.MathUtils.clamp(Math.max(pkt.adsBlend, aimingAny ? 0.85 : 0), 0, 1)
      : aimingAny
        ? 1
        : 0;
    op.targetPointAim =
      stance === 'POINT_AIM' || Boolean(pkt.isPointAim)
        ? Number.isFinite(pkt.pointAimBlend)
          ? THREE.MathUtils.clamp(Math.max(pkt.pointAimBlend, 0.85), 0, 1)
          : 1
        : 0;
    op.targetCant = stance === 'CANTED_ADS' || Boolean(pkt.isCanted) ? 1 : 0;

    op.isFiring = Boolean(pkt.isFiring);
    op.isReloading = Boolean(pkt.isReloading);
    op.targetReload = op.isReloading ? 1 : 0;

    op.sprint = Boolean(pkt.sprint);
    op.weaponId = pkt.weaponId || op.weaponId;
    if (pkt.att !== undefined) {
      op.attachments = unpackSyncedWeaponAttachments(pkt.att);
    }
    if (typeof pkt.sup === 'boolean') {
      op.suppressed = pkt.sup;
    }
    op.rig.setWeaponLoadout(op.weaponId, op.attachments);

    // Sync active firearm handling action & normalized progress
    const nextAction: SyncedHandlingAction =
      pkt.ha ?? (op.isReloading ? 'RELOAD' : 'NONE');
    const nextProg =
      typeof pkt.hprog === 'number' && Number.isFinite(pkt.hprog)
        ? THREE.MathUtils.clamp(pkt.hprog, 0, 1)
        : nextAction === 'NONE'
          ? 0
          : op.targetHandlingProgress;

    if (nextAction !== op.handlingAction) {
      op.handlingAction = nextAction;
      op.handlingProgress = nextProg;
      op.targetHandlingProgress = nextProg;
    } else {
      if (nextProg + 0.25 < op.handlingProgress) {
        op.handlingProgress = nextProg;
      }
      op.targetHandlingProgress = nextProg;
    }

    if (
      op.handlingAction !== 'SUPPRESSOR_DETACH' &&
      op.handlingAction !== 'SUPPRESSOR_ATTACH'
    ) {
      op.rig.setSuppressedVisual(op.suppressed);
    }

    // Catch missed one-shot fire packets via monotonic fireSeq delta
    if (typeof pkt.fireSeq === 'number' && pkt.fireSeq > op.lastFireSeq) {
      if (op.hasInitialState && op.muzzleFlashTimer <= 0) {
        op.muzzleFlashTimer = op.suppressed ? 0.025 : 0.045;
        op.recoilKickTimer = 0.095;
        op.rig.muzzleFlash.visible = !op.suppressed;
      }
      op.lastFireSeq = pkt.fireSeq;
    }

    op.hp = pkt.hp;
    op.maxHp = Math.max(1, pkt.maxHp || 100);
    op.alive = Boolean(pkt.alive);
    op.kills = pkt.kills ?? op.kills;
    op.deaths = pkt.deaths ?? op.deaths;
    op.flashlightOn = Boolean(pkt.flashlightOn);
    op.laserOn = Boolean(pkt.laserOn);
    op.lastUpdateMs = performance.now();

    // Snap immediately on first packet or teleport/respawn (> 6m jump)
    if (!op.hasInitialState || distSq > 36) {
      op.curPos.copy(op.targetPos);
      op.curYaw = op.targetYaw;
      op.curPitch = op.targetPitch;
      op.adsBlend = op.targetAds;
      op.pointAimBlend = op.targetPointAim;
      op.cantBlend = op.targetCant;
      op.reloadBlend = op.targetReload;
      op.hasInitialState = true;
    }

    if (
      pkt.glovesEnabled !== undefined ||
      pkt.gloveColor !== undefined ||
      pkt.helmetType !== undefined ||
      pkt.helmetColor !== undefined ||
      pkt.nvgMount !== undefined ||
      pkt.nvgFlipped !== undefined
    ) {
      const nextSig = `${pkt.glovesEnabled ?? ''}|${pkt.gloveColor ?? ''}|${pkt.helmetType ?? ''}|${pkt.helmetColor ?? ''}|${pkt.nvgMount ?? ''}|${pkt.nvgFlipped ? 1 : 0}`;
      if (op.gearSig !== nextSig) {
        op.gearSig = nextSig;
        op.rig.setGearAppearance({
          glovesEnabled: pkt.glovesEnabled,
          gloveColor: pkt.gloveColor,
          helmetType: pkt.helmetType,
          helmetColor: pkt.helmetColor,
          nvgMount: pkt.nvgMount,
          nvgFlipped: pkt.nvgFlipped,
        });
      }
    }

    op.rig.root.visible = op.alive;
  }

  public applyFirePacket(pkt: GamePlayerFirePacket): void {
    const uid = pkt.senderUserId;
    if (!uid || uid === this.localUserId) return;

    const team = this.resolveBattleTeam(pkt.senderTeam);
    const op = this.ensurePlayer(uid, pkt.senderUsername ?? 'OPERATOR', team);

    if (typeof pkt.shotSeq === 'number' && pkt.shotSeq > op.lastFireSeq) {
      op.lastFireSeq = pkt.shotSeq;
    }

    // Immediately mirror shooter's stance on fire event (before next 20Hz snapshot)
    if (pkt.aimStance) {
      op.aimStance = pkt.aimStance;
      if (pkt.aimStance === 'POINT_AIM') {
        op.targetAds = 1;
        op.targetPointAim = 1;
        op.targetCant = 0;
      } else if (pkt.aimStance === 'CANTED_ADS') {
        op.targetAds = 1;
        op.targetPointAim = 0;
        op.targetCant = 1;
      } else if (pkt.aimStance === 'ADS') {
        op.targetAds = 1;
        op.targetPointAim = 0;
        op.targetCant = 0;
      }
    }

    if (pkt.weaponId && pkt.weaponId !== op.weaponId) {
      op.weaponId = pkt.weaponId;
      op.rig.setWeaponLoadout(op.weaponId, op.attachments);
    }
    op.suppressed = Boolean(pkt.suppressed);

    op.muzzleFlashTimer = pkt.suppressed ? 0.032 : 0.068;
    op.recoilKickTimer = 0.11;
    op.rig.muzzleFlash.visible = !pkt.suppressed;
    op.rig.muzzleFlash.scale.setScalar(0.85 + Math.random() * 0.45);
    op.rig.muzzleFlash.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);

    // Spatialized 3D gunfire sound
    const prof = resolveWeaponProfile(pkt.weaponId || 'm4a1');
    const audioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this._tmpSoundPos.set(pkt.ox, pkt.oy, pkt.oz);
    this.audio.playWeaponCue('fire', {
      position: this._tmpSoundPos,
      weightClass: audioWeight,
      caliberId: pkt.caliberId || '556x45',
      suppressed: Boolean(pkt.suppressed),
      isSubsonic: false,
      muzzleComp: false,
    });

    // Spawn pooled bullet tracer streak
    this._tmpStart.set(pkt.ox, pkt.oy, pkt.oz);
    this._tmpDir.set(pkt.dx, pkt.dy, pkt.dz);
    if (this._tmpDir.lengthSq() > 0.0001) {
      this._tmpDir.normalize();
      this._tmpEnd.copy(this._tmpStart).addScaledVector(this._tmpDir, 28);
      this.spawnTracer(this._tmpStart, this._tmpEnd);
    }
  }

  public applyRespawnPacket(pkt: GamePlayerRespawnPacket): void {
    const uid = pkt.senderUserId;
    if (!uid || uid === this.localUserId) return;
    const team = this.resolveBattleTeam(pkt.senderTeam);
    const op = this.ensurePlayer(
      uid,
      pkt.senderUsername ?? 'OPERATOR',
      team,
      pkt.uniformId,
      pkt.operatorId,
    );
    op.alive = true;
    op.hp = pkt.hp;
    op.maxHp = pkt.maxHp || op.maxHp;
    op.curPos.set(pkt.x, pkt.y, pkt.z);
    op.targetPos.set(pkt.x, pkt.y, pkt.z);
    op.curYaw = pkt.yaw;
    op.targetYaw = pkt.yaw;
    op.isFiring = false;
    op.isReloading = false;
    op.targetReload = 0;
    op.reloadBlend = 0;
    op.handlingAction = 'NONE';
    op.handlingProgress = 0;
    op.targetHandlingProgress = 0;
    op.hasInitialState = true;
    if (
      pkt.glovesEnabled !== undefined ||
      pkt.gloveColor !== undefined ||
      pkt.helmetType !== undefined ||
      pkt.helmetColor !== undefined ||
      pkt.nvgMount !== undefined ||
      pkt.nvgFlipped !== undefined
    ) {
      const nextSig = `${pkt.glovesEnabled ?? ''}|${pkt.gloveColor ?? ''}|${pkt.helmetType ?? ''}|${pkt.helmetColor ?? ''}|${pkt.nvgMount ?? ''}|${pkt.nvgFlipped ? 1 : 0}`;
      if (op.gearSig !== nextSig) {
        op.gearSig = nextSig;
        op.rig.setGearAppearance({
          glovesEnabled: pkt.glovesEnabled,
          gloveColor: pkt.gloveColor,
          helmetType: pkt.helmetType,
          helmetColor: pkt.helmetColor,
          nvgMount: pkt.nvgMount,
          nvgFlipped: pkt.nvgFlipped,
        });
      }
    }
    op.rig.root.visible = true;
  }

  public triggerHitFlinch(userId: string): void {
    const op = this.players.get(userId);
    if (op) op.hitFlinchTimer = 0.16;
  }

  public markPlayerDead(userId: string): void {
    const op = this.players.get(userId);
    if (op) {
      op.alive = false;
      op.isFiring = false;
      op.rig.root.visible = false;
    }
  }

  public syncRosterMembers(members: LobbyMember[]): void {
    const activeIds = new Set(members.map((m) => m.userId));
    for (const m of members) {
      if (m.userId === this.localUserId) continue;
      const team: BattleTeamId =
        this.mode === 'infection' ? 'A' : this.battleRule === 'ffa' ? 'FFA' : m.team;
      this.ensurePlayer(m.userId, m.username, team);
    }
    for (const [uid, op] of Array.from(this.players.entries())) {
      if (!activeIds.has(uid)) {
        op.rig.disposeWeapon();
        this.group.remove(op.rig.root);
        op.nameTexture.dispose();
        (op.nameSprite.material as THREE.SpriteMaterial).dispose();
        this.players.delete(uid);
      }
    }
  }

  private spawnTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const tr = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % this.tracers.length;

    const len = Math.max(0.4, start.distanceTo(end));
    this._tmpMid.addVectors(start, end).multiplyScalar(0.5);
    this._tmpDir.subVectors(end, start).normalize();

    tr.active = true;
    tr.life = tr.maxLife;
    tr.mesh.position.copy(this._tmpMid);
    tr.mesh.scale.set(1, len, 1);
    tr.mesh.quaternion.setFromUnitVectors(this._tmpUp, this._tmpDir);
    tr.mesh.visible = true;
  }

  public update(dt: number, localCameraPos: Readonly<THREE.Vector3>): void {
    // Update pooled tracers
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tr.life -= dt;
      if (tr.life <= 0) {
        tr.active = false;
        tr.mesh.visible = false;
      }
    }

    const posAlpha = 1 - Math.exp(-18 * dt);
    const rotAlpha = 1 - Math.exp(-20 * dt);
    const poseAlpha = 1 - Math.exp(-15 * dt);

    for (const op of this.players.values()) {
      if (!op.hasInitialState || !op.alive) {
        op.rig.root.visible = false;
        continue;
      }

      const rig = op.rig;
      rig.root.visible = true;

      // Measure horizontal speed for leg stride before moving curPos
      const prevX = op.curPos.x;
      const prevZ = op.curPos.z;
      op.curPos.lerp(op.targetPos, posAlpha);
      const speedMps = Math.hypot(op.curPos.x - prevX, op.curPos.z - prevZ) / Math.max(0.001, dt);

      const yawDelta = normalizeAngleDelta(op.curYaw, op.targetYaw);
      op.curYaw += yawDelta * rotAlpha;
      op.curPitch += (op.targetPitch - op.curPitch) * rotAlpha;
      op.crouchBlend += (op.targetCrouch - op.crouchBlend) * poseAlpha;
      op.leanBlend += (op.targetLean - op.leanBlend) * poseAlpha;
      op.adsBlend += (op.targetAds - op.adsBlend) * poseAlpha;
      op.pointAimBlend += (op.targetPointAim - op.pointAimBlend) * poseAlpha;
      op.cantBlend += (op.targetCant - op.cantBlend) * poseAlpha;
      op.reloadBlend += (op.targetReload - op.reloadBlend) * poseAlpha;

      // Apply root position & yaw (controller yaw 0 faces -Z, matching rig forward -Z)
      rig.root.position.copy(op.curPos);
      rig.bodyPivot.rotation.set(0, op.curYaw, 0);
      rig.bodyPivot.position.set(0, 0, 0);

      // Hit flinch kickback
      let flinchPitch = 0;
      if (op.hitFlinchTimer > 0) {
        op.hitFlinchTimer = Math.max(0, op.hitFlinchTimer - dt);
        flinchPitch = -(op.hitFlinchTimer / 0.16) * 0.2;
      }

      // Walk / sprint stride cycle advance
      if (speedMps > 0.2) {
        const strideFreq = op.sprint ? 11.2 : 7.6;
        op.walkCycle += dt * strideFreq;
      }

      // Recoil kickback from discrete shots + sustained firing vibration
      if (op.recoilKickTimer > 0) {
        op.recoilKickTimer = Math.max(0, op.recoilKickTimer - dt);
      }
      const shotKick = op.recoilKickTimer > 0 ? op.recoilKickTimer / 0.11 : 0;
      const sustainedVibe = op.isFiring ? Math.sin(performance.now() * 0.055) * 0.016 : 0;

      // Smoothly advance & interpolate active handling progress between 20Hz packets
      if (op.handlingAction !== 'NONE') {
        const estRate =
          op.handlingAction === 'SUPPRESSOR_DETACH' || op.handlingAction === 'SUPPRESSOR_ATTACH'
            ? 1 / 2.45
            : op.handlingAction === 'RELOAD'
              ? 1 / 2.25
              : op.handlingAction === 'BOLT'
                ? 1 / 0.72
                : op.handlingAction === 'PUMP'
                  ? 1 / 0.34
                  : op.handlingAction === 'INSPECT'
                    ? 1 / 2.6
                    : 1 / 0.45;
        op.targetHandlingProgress = Math.min(1, op.targetHandlingProgress + dt * estRate * 0.85);
        op.handlingProgress += (op.targetHandlingProgress - op.handlingProgress) * poseAlpha;
      } else {
        op.handlingProgress = 0;
      }

      // Unified grounded crouch knees, local weaponSocket shoulder mount, Point Aim cant, and 2-bone arm IK
      const pose = this._poseScratch;
      pose.crouchBlend = op.crouchBlend;
      pose.leanBlend = op.leanBlend;
      pose.aimPitch = op.curPitch;
      pose.adsBlend = op.adsBlend;
      pose.pointAimBlend = op.pointAimBlend;
      pose.cantBlend = op.cantBlend;
      pose.reloadBlend = op.reloadBlend;
      pose.speedMps = speedMps;
      pose.walkCycle = op.walkCycle;
      pose.sprint = op.sprint;
      pose.recoilKick = shotKick;
      pose.firingVibration = sustainedVibe;
      pose.flinchPitch = flinchPitch;
      pose.handlingAction = op.handlingAction;
      pose.handlingProgress = op.handlingProgress;
      rig.applyCombatPose(pose);

      // Muzzle flash, laser & tactical light
      if (op.muzzleFlashTimer > 0) {
        op.muzzleFlashTimer = Math.max(0, op.muzzleFlashTimer - dt);
        if (op.muzzleFlashTimer <= 0) rig.muzzleFlash.visible = false;
      }
      const suppBusy =
        op.handlingAction === 'SUPPRESSOR_DETACH' || op.handlingAction === 'SUPPRESSOR_ATTACH';
      rig.laserBeam.visible = op.laserOn && !op.isReloading && !suppBusy;
      rig.flashlightGlow.visible = op.flashlightOn;

      // Nameplate height & distance/team visibility
      op.nameSprite.position.y = 2.08 - op.crouchBlend * 0.28;
      const distToCam = op.curPos.distanceTo(localCameraPos);
      const friendly = this.isFriendly(op.userId);
      op.nameSprite.visible = friendly ? distToCam < 65 : distToCam < 22;
    }
  }

  public getHitMeshes(): THREE.Object3D[] {
    this.activeHitMeshes.length = 0;
    for (const op of this.players.values()) {
      if (!op.hasInitialState || !op.alive) continue;
      for (let i = 0; i < op.rig.hitMeshes.length; i++) {
        this.activeHitMeshes.push(op.rig.hitMeshes[i]);
      }
    }
    return this.activeHitMeshes;
  }

  public getScoreEntries(): BattleScoreEntry[] {
    const rows: BattleScoreEntry[] = [];
    for (const op of this.players.values()) {
      rows.push({
        id: op.userId,
        name: op.username,
        team: op.team,
        isPlayer: false,
        kills: op.kills,
        deaths: op.deaths,
        alive: op.alive,
      });
    }
    return rows;
  }

  public getAliveSpectateTargets(): Array<{
    userId: string;
    username: string;
    pos: THREE.Vector3;
    yaw: number;
    pitch: number;
  }> {
    const out: Array<{
      userId: string;
      username: string;
      pos: THREE.Vector3;
      yaw: number;
      pitch: number;
    }> = [];
    for (const op of this.players.values()) {
      if (op.hasInitialState && op.alive) {
        out.push({
          userId: op.userId,
          username: op.username,
          pos: op.curPos,
          yaw: op.curYaw,
          pitch: op.curPitch,
        });
      }
    }
    return out;
  }

  public getAliveHumanTargets(): Array<{
    id: string;
    name: string;
    team: BattleTeamId;
    pos: THREE.Vector3;
    alive: boolean;
  }> {
    const out: Array<{
      id: string;
      name: string;
      team: BattleTeamId;
      pos: THREE.Vector3;
      alive: boolean;
    }> = [];
    for (const op of this.players.values()) {
      if (op.hasInitialState && op.alive) {
        out.push({
          id: op.userId,
          name: op.username,
          team: op.team,
          pos: op.curPos,
          alive: true,
        });
      }
    }
    return out;
  }

  public getAliveHostilesInRadius(
    origin: Readonly<THREE.Vector3>,
    radiusM: number,
  ): Array<{ userId: string; username: string; pos: THREE.Vector3; dist: number }> {
    const out: Array<{ userId: string; username: string; pos: THREE.Vector3; dist: number }> = [];
    for (const op of this.players.values()) {
      if (!op.hasInitialState || !op.alive) continue;
      if (this.isFriendly(op.userId)) continue;
      const dist = Math.hypot(
        op.curPos.x - origin.x,
        op.curPos.y + 1.1 - origin.y,
        op.curPos.z - origin.z,
      );
      if (dist <= radiusM) {
        out.push({
          userId: op.userId,
          username: op.username,
          pos: op.curPos.clone(),
          dist,
        });
      }
    }
    return out;
  }

  public dispose(): void {
    for (const op of this.players.values()) {
      op.rig.disposeWeapon();
      op.nameTexture.dispose();
      (op.nameSprite.material as THREE.SpriteMaterial).dispose();
    }
    this.players.clear();
    this.rigFactory.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.group.parent?.remove(this.group);
  }
}

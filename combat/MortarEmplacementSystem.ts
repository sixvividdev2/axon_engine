import * as THREE from 'three';
import { BodycamAudio } from '../bodycam-sdk/BodycamAudio';
import {
  TacticalUniformMaterialLibrary,
  TacticalUniformMaterialBundle,
} from '../bodycam-sdk/TacticalUniforms';
import {
  ActiveMortarMissionSummary,
  ENABLE_CONQUEST_FIRE_SUPPORT,
  GameFireSupportSyncPacket,
  GameMortarLaunchPacket,
  MortarPitState,
  MortarPitStatus,
  TeamFireSupportState,
} from '../data/multiplayer';
import {
  MORTAR_CHARGE_SPECS,
  MORTAR_MAX_ELEVATION_RAD,
  MORTAR_MIN_ELEVATION_RAD,
  MortarChargeLevel,
  NATO_MILS_PER_CIRCLE,
  RAD_TO_MILS,
  computeBearingRad,
  radiansToNatoMils,
  sampleMortarArcPosition,
  shortestAngleDeltaRad,
  simulateMortarImpact,
  solveMortarFiringTable,
} from './MortarBallistics';

export const MAX_MORTAR_PITS = 6;
export const MAX_MORTAR_SHELL_POOL = 16;
export const MAX_SCORCH_DECAL_POOL = 24;
export const MORTAR_HQ_EXCLUSION_RADIUS_M = 65;
export const MORTAR_FRIENDLY_FLAG_MIN_DIST_M = 80;
export const MORTAR_AI_SALVO_INTERVAL_SEC = 35;
export const MORTAR_AI_SALVO_ROUNDS = 3;
export const MORTAR_AI_CEP_M = 32;
export const MORTAR_CREW_REINFORCE_SEC = 50;
export const MORTAR_RELOAD_AI_LOADER_SEC = 2.4;
export const MORTAR_RELOAD_SOLO_SEC = 4.2;
export const MORTAR_AI_RECLAIM_DELAY_SEC = 1.0;
export const MORTAR_CREW_LOD_DIST_M = 35;
export const MORTAR_INTERACT_RADIUS_M = 3.25;
export const MORTAR_BLAST_RADIUS_M = 13.0;
export const MORTAR_BLAST_MAX_DAMAGE = 138;
export const MORTAR_SWEEP_COOLDOWN_SEC = 75;
export const MORTAR_AIR_STRIKE_MAX_COOLDOWN_SEC = 150;
export const MORTAR_MISSION_ROUNDS = 5;
export const MORTAR_MISSION_CADENCE_SEC = 1.4;
export const MORTAR_MISSION_CEP_M = 18;
export const MORTAR_DANGER_CLOSE_RADIUS_M = 45;
export const MORTAR_KIA_COOLDOWN_REFUND_RATIO = 0.5;

export interface MortarSiteConfig {
  pitId: string;
  ownerTeam: 'A' | 'B';
  sourceType: 'HQ' | 'FOB';
  sourceId: string;
  position: [number, number, number];
  zeroBearingRad: number;
  active: boolean;
}

export interface MortarTargetCandidate {
  id: string;
  team: 'A' | 'B' | 'FFA';
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

export interface MortarExclusionZone {
  x: number;
  z: number;
  radiusM: number;
  team?: 'A' | 'B' | null;
  kind: 'hq' | 'flag';
}

export interface MortarImpactEvent {
  shellId: string;
  pitId: string;
  callerId: string;
  callerTeam: 'A' | 'B';
  isPlayerManned: boolean;
  position: THREE.Vector3;
  blastRadiusM: number;
  maxDamage: number;
}

export interface MortarSeatArbitrationResult {
  ok: boolean;
  pitId: string;
  reason?: string;
}

export interface MortarPlayerHudTelemetry {
  pitId: string;
  ownerTeam: 'A' | 'B';
  sourceType: 'HQ' | 'FOB';
  isCapturedEnemyPit: boolean;
  azimuthRad: number;
  deflectionMils: number;
  elevationRad: number;
  elevationDeg: number;
  elevationMils: number;
  chargeLevel: MortarChargeLevel;
  chargeLabel: string;
  reloadProgress01: number;
  reloadDurationSec: number;
  aiLoaderAlive: boolean;
  bubbleErrorX: number; // -1..+1 cross-level vial
  bubbleErrorY: number; // -1..+1 elevation level vial
  isLevelSettled: boolean;
  stakeDriftMils: number; // offset from twin red/white aiming stakes
  opticalSightActive: boolean;
  estimatedRangeM: number;
  estimatedFlightSec: number;
  windSpeedMps: number;
  windDirDeg: number;
  foAddDropM: number;
  foLeftRightM: number;
  canFire: boolean;
}

export interface MortarCrewHitResult {
  hit: boolean;
  pitId: string;
  role: 'gunner' | 'loader';
  ownerTeam: 'A' | 'B';
  damageApplied: number;
  remainingHp: number;
  killed: boolean;
  bothCrewDead: boolean;
  headshot: boolean;
  abortedMissionRefundSec?: number;
}

export interface MortarFriendlyPosition {
  x: number;
  z: number;
}

export interface MortarMissionRequestResult {
  ok: boolean;
  missionId?: string;
  pitId?: string;
  dangerClose: boolean;
  minFriendlyDistM: number;
  reason?: string;
}

export interface MortarMissionEvent {
  kind: 'started' | 'aborted_takeover' | 'aborted_crew_kia' | 'completed';
  missionId: string;
  pitId: string;
  team: 'A' | 'B';
  callerName: string;
  targetX: number;
  targetZ: number;
  refundedCooldownSec: number;
  dangerClose: boolean;
}

export interface MortarReticleEvaluation {
  availableAiBatteries: number;
  totalFriendlyBatteries: number;
  inHqExclusion: boolean;
  inRange: boolean;
  dangerClose: boolean;
  minFriendlyDistM: number;
  canCall: boolean;
  blockReason: string | null;
}

interface CrewActorVisual {
  role: 'gunner' | 'loader';
  root: THREE.Group;
  torsoGroup: THREE.Group;
  headMesh: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  hitMeshes: THREE.Mesh[];
  yieldBlend: number; // 0 = at gun, 1 = stepped 1.1m laterally aside
  animPhase: number;
  dead: boolean;
}

interface InternalMortarPit {
  state: MortarPitState;
  root: THREE.Group;
  turretYawGroup: THREE.Group;
  barrelPivotGroup: THREE.Group;
  barrelRecoilGroup: THREE.Group;
  traverseWheel: THREE.Mesh;
  elevateWheel: THREE.Mesh;
  sightHousing: THREE.Group;
  stagedShellGroup: THREE.Group;
  chargeRingMeshes: THREE.Mesh[];
  muzzleTipLocal: THREE.Vector3;
  muzzleFlashMesh: THREE.Mesh;
  muzzleFlashTimer: number;
  gunnerVisual: CrewActorVisual;
  loaderVisual: CrewActorVisual;
  colliders: THREE.Box3[];
  // Timers & state
  reloadTimerSec: number;
  reloadDurationSec: number;
  aiSalvoTimerSec: number;
  aiSalvoRemaining: number;
  aiSalvoNextRoundTimerSec: number;
  aiSalvoTargetPos: THREE.Vector3;
  aiReclaimTimerSec: number;
  crewLodAccumSec: number;
  // Mil-sim laying state
  bubbleErrorX: number;
  bubbleErrorY: number;
  stakeDriftMils: number;
  recoilKick01: number;
  foAddDropM: number;
  foLeftRightM: number;
  // Phase 3 PDA Fire Mission state
  missionCallerId: string | null;
  missionCallerName: string;
  missionCallerTeam: 'A' | 'B';
  missionTargetPos: THREE.Vector3;
  missionRoundsRemaining: number;
  missionTotalRounds: number;
  missionNextRoundTimerSec: number;
  missionDangerClose: boolean;
}

interface PooledMortarShell {
  active: boolean;
  shellId: string;
  pitId: string;
  callerId: string;
  callerTeam: 'A' | 'B';
  isPlayerManned: boolean;
  origin: THREE.Vector3;
  vel: THREE.Vector3;
  windX: number;
  windZ: number;
  impactPos: THREE.Vector3;
  elapsedSec: number;
  flightTimeSec: number;
  whistleTriggered: boolean;
  mesh: THREE.Group;
}

interface PooledBlastVfx {
  active: boolean;
  timerSec: number;
  durationSec: number;
  pos: THREE.Vector3;
  plumeMesh: THREE.Mesh;
  flashMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
}

// Reusable zero-GC scratch math objects
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

function createScorchDecalTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cx = size * 0.5;
  const cy = size * 0.5;
  ctx.clearRect(0, 0, size, size);

  // Outer soot dispersion ring
  const outer = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.48);
  outer.addColorStop(0.0, 'rgba(14, 12, 10, 0.94)');
  outer.addColorStop(0.32, 'rgba(26, 22, 18, 0.82)');
  outer.addColorStop(0.62, 'rgba(42, 34, 26, 0.44)');
  outer.addColorStop(0.84, 'rgba(54, 46, 36, 0.16)');
  outer.addColorStop(1.0, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = outer;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Radial shrapnel blast streaks (deterministic pattern)
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 28; i++) {
    const ang = (i / 28) * Math.PI * 2 + (i % 3) * 0.09;
    const len = size * (0.24 + ((i * 37) % 100) / 480);
    ctx.rotate(ang);
    const streak = ctx.createLinearGradient(size * 0.05, 0, len, 0);
    streak.addColorStop(0, 'rgba(18, 15, 12, 0.55)');
    streak.addColorStop(1, 'rgba(18, 15, 12, 0)');
    ctx.fillStyle = streak;
    ctx.fillRect(size * 0.04, -2.5, len, 5);
    ctx.rotate(-ang);
  }
  ctx.restore();

  // Inner crater pit rim & burnt dirt shadow
  const inner = ctx.createRadialGradient(cx, cy, size * 0.02, cx, cy, size * 0.20);
  inner.addColorStop(0, 'rgba(8, 7, 6, 0.96)');
  inner.addColorStop(0.7, 'rgba(32, 24, 17, 0.72)');
  inner.addColorStop(1, 'rgba(60, 48, 36, 0)');
  ctx.fillStyle = inner;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function createBurlapTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#9c8a6a';
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 4) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(72, 60, 42, 0.22)' : 'rgba(185, 168, 134, 0.14)';
    ctx.fillRect(0, y, size, 2);
  }
  for (let x = 0; x < size; x += 4) {
    ctx.fillStyle = x % 8 === 0 ? 'rgba(65, 54, 38, 0.18)' : 'rgba(176, 160, 126, 0.12)';
    ctx.fillRect(x, 0, 2, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Conquest Phase 1 + Phase 2 81mm Sandbagged Mortar Emplacement System.
 *
 * Enforces strict RX 480 hardware caps:
 *  - Hard cap: MAX 6 mortar pits per match (1 per HQ + up to 2 active forward FOBs per team)
 *  - <= 2,200 triangles per pit (InstancedMesh burlap sandbags + composite mortar + ammo crates + aiming stakes)
 *  - Zero CPU tick on INACTIVE / KIA_REINFORCING pits
 *  - 60 Hz crew AI animation within 35m of local player, 10 Hz beyond 35m (fixed kneeling states, zero navmesh pathing)
 *  - 16 pooled falling mortar shell meshes (<= 240 tris each), 24 pooled FIFO ground scorch decals, 1 dynamic blast PointLight
 *  - Full mil-sim manual laying (handwheels, Charges 1-4, bubble level, twin aiming stakes, recoil disturbance)
 */
export class MortarEmplacementSystem {
  public readonly root = new THREE.Group();
  private enabled: boolean = ENABLE_CONQUEST_FIRE_SUPPORT;
  private isHost: boolean;
  private readonly audio?: BodycamAudio;
  private readonly getGroundHeight: (x: number, z: number) => number;
  private readonly onImpact?: (event: MortarImpactEvent) => void;
  private readonly onLaunchBroadcast?: (packet: GameMortarLaunchPacket) => void;
  private readonly onMissionEvent?: (event: MortarMissionEvent) => void;

  private readonly uniformLib = new TacticalUniformMaterialLibrary();
  private readonly disposables: Array<{ dispose: () => void }> = [];

  // Shared materials & geometries (strict triangle & draw-call budget)
  private readonly matSandbag: THREE.MeshStandardMaterial;
  private readonly matSteelDark: THREE.MeshStandardMaterial;
  private readonly matSteelGunmetal: THREE.MeshStandardMaterial;
  private readonly matBrass: THREE.MeshStandardMaterial;
  private readonly matOliveCrate: THREE.MeshStandardMaterial;
  private readonly matStakeRed: THREE.MeshStandardMaterial;
  private readonly matStakeWhite: THREE.MeshStandardMaterial;
  private readonly matShellOlive: THREE.MeshStandardMaterial;
  private readonly matChargeRing: THREE.MeshStandardMaterial;
  private readonly matFlash: THREE.MeshBasicMaterial;
  private readonly matScorchDecal: THREE.MeshBasicMaterial;

  private readonly geoSandbag: THREE.BoxGeometry;
  private readonly geoShellBody: THREE.CylinderGeometry;
  private readonly geoShellNose: THREE.ConeGeometry;
  private readonly geoShellFin: THREE.BoxGeometry;
  private readonly geoScorchPlane: THREE.PlaneGeometry;

  private readonly pits = new Map<string, InternalMortarPit>();
  private readonly teamStates: Record<'A' | 'B', TeamFireSupportState> = {
    A: {
      team: 'A',
      airStrikeCooldownSec: 0,
      airStrikeMaxCooldownSec: MORTAR_AIR_STRIKE_MAX_COOLDOWN_SEC,
      mortarStrikeCooldownSec: 0,
      mortarStrikeMaxCooldownSec: MORTAR_SWEEP_COOLDOWN_SEC,
      activeBomberId: null,
      activeMortarMissionId: null,
    },
    B: {
      team: 'B',
      airStrikeCooldownSec: 0,
      airStrikeMaxCooldownSec: MORTAR_AIR_STRIKE_MAX_COOLDOWN_SEC,
      mortarStrikeCooldownSec: 0,
      mortarStrikeMaxCooldownSec: MORTAR_SWEEP_COOLDOWN_SEC,
      activeBomberId: null,
      activeMortarMissionId: null,
    },
  };
  private remoteActiveMissions: ActiveMortarMissionSummary[] = [];
  private readonly shellPool: PooledMortarShell[] = [];
  private readonly scorchDecals: THREE.Mesh[] = [];
  private scorchFifoIndex = 0;
  private readonly blastVfxPool: PooledBlastVfx[] = [];
  private readonly blastLight: THREE.PointLight;
  private blastLightTimerSec = 0;

  private windX = 1.8;
  private windZ = 0.6;
  private shellSeq = 1;
  private missionSeq = 1;
  private lastTickActivePits = 0;
  private lastCpuMs = 0;

  constructor(opts: {
    scene: THREE.Scene;
    isHost: boolean;
    audio?: BodycamAudio;
    getGroundHeight?: (x: number, z: number) => number;
    onImpact?: (event: MortarImpactEvent) => void;
    onLaunchBroadcast?: (packet: GameMortarLaunchPacket) => void;
    onMissionEvent?: (event: MortarMissionEvent) => void;
    enabled?: boolean;
  }) {
    this.isHost = opts.isHost;
    this.audio = opts.audio;
    this.getGroundHeight = opts.getGroundHeight ?? (() => 0);
    this.onImpact = opts.onImpact;
    this.onLaunchBroadcast = opts.onLaunchBroadcast;
    this.onMissionEvent = opts.onMissionEvent;
    this.enabled = opts.enabled ?? ENABLE_CONQUEST_FIRE_SUPPORT;

    this.root.name = 'ConquestMortarEmplacements';
    this.root.visible = this.enabled;
    opts.scene.add(this.root);

    const track = <T extends { dispose: () => void }>(res: T): T => {
      this.disposables.push(res);
      return res;
    };

    const burlapTex = createBurlapTexture();
    if (burlapTex) track(burlapTex);

    this.matSandbag = track(
      new THREE.MeshStandardMaterial({
        color: 0xb6a27e,
        ...(burlapTex ? { map: burlapTex } : {}),
        roughness: 0.94,
        metalness: 0.02,
      }),
    );
    this.matSteelDark = track(
      new THREE.MeshStandardMaterial({
        color: 0x2a2f33,
        roughness: 0.56,
        metalness: 0.78,
      }),
    );
    this.matSteelGunmetal = track(
      new THREE.MeshStandardMaterial({
        color: 0x41484d,
        roughness: 0.44,
        metalness: 0.84,
      }),
    );
    this.matBrass = track(
      new THREE.MeshStandardMaterial({
        color: 0xc29b48,
        roughness: 0.36,
        metalness: 0.82,
      }),
    );
    this.matOliveCrate = track(
      new THREE.MeshStandardMaterial({
        color: 0x454f34,
        roughness: 0.86,
        metalness: 0.08,
      }),
    );
    this.matStakeRed = track(
      new THREE.MeshStandardMaterial({
        color: 0xd93829,
        roughness: 0.55,
        metalness: 0.1,
      }),
    );
    this.matStakeWhite = track(
      new THREE.MeshStandardMaterial({
        color: 0xf1f3f5,
        roughness: 0.52,
        metalness: 0.05,
      }),
    );
    this.matShellOlive = track(
      new THREE.MeshStandardMaterial({
        color: 0x4b5836,
        roughness: 0.55,
        metalness: 0.38,
      }),
    );
    this.matChargeRing = track(
      new THREE.MeshStandardMaterial({
        color: 0xd9c7a3,
        roughness: 0.82,
        metalness: 0.04,
      }),
    );
    this.matFlash = track(
      new THREE.MeshBasicMaterial({
        color: 0xffc864,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      }),
    );

    const scorchTex = createScorchDecalTexture();
    if (scorchTex) track(scorchTex);
    this.matScorchDecal = track(
      new THREE.MeshBasicMaterial({
        map: scorchTex ?? undefined,
        color: scorchTex ? 0xffffff : 0x1a1714,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );

    // 12 tris per sandbag * 28 instances = 336 tris (well under 1,200 tri budget!)
    this.geoSandbag = track(new THREE.BoxGeometry(0.58, 0.24, 0.30));

    // Shell mesh <= 96 tris each (well under 240 tri cap!)
    this.geoShellBody = track(new THREE.CylinderGeometry(0.041, 0.036, 0.28, 8));
    this.geoShellNose = track(new THREE.ConeGeometry(0.041, 0.11, 8));
    this.geoShellFin = track(new THREE.BoxGeometry(0.095, 0.085, 0.008));
    this.geoScorchPlane = track(new THREE.PlaneGeometry(5.6, 5.6));
    this.geoScorchPlane.rotateX(-Math.PI * 0.5);

    // Initialize 16 pooled falling mortar shell meshes
    for (let i = 0; i < MAX_MORTAR_SHELL_POOL; i++) {
      const mesh = this.createShellMesh();
      mesh.visible = false;
      this.root.add(mesh);
      this.shellPool.push({
        active: false,
        shellId: '',
        pitId: '',
        callerId: '',
        callerTeam: 'A',
        isPlayerManned: false,
        origin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        windX: 0,
        windZ: 0,
        impactPos: new THREE.Vector3(),
        elapsedSec: 0,
        flightTimeSec: 1,
        whistleTriggered: false,
        mesh,
      });
    }

    // Initialize 24 pooled FIFO ground scorch decals
    for (let i = 0; i < MAX_SCORCH_DECAL_POOL; i++) {
      const decal = new THREE.Mesh(this.geoScorchPlane, this.matScorchDecal);
      decal.visible = false;
      decal.renderOrder = 2;
      this.root.add(decal);
      this.scorchDecals.push(decal);
    }

    // Initialize 6 pooled lightweight detonation smoke/flash bursts
    const plumeGeo = track(new THREE.IcosahedronGeometry(1.1, 1));
    const ringGeo = track(new THREE.RingGeometry(0.6, 1.35, 16));
    ringGeo.rotateX(-Math.PI * 0.5);
    for (let i = 0; i < 6; i++) {
      const plumeMat = track(
        new THREE.MeshBasicMaterial({
          color: 0x3b352d,
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
        }),
      );
      const flashMat = track(
        new THREE.MeshBasicMaterial({
          color: 0xffb84d,
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
        }),
      );
      const ringMat = track(
        new THREE.MeshBasicMaterial({
          color: 0xd6bfa2,
          transparent: true,
          opacity: 0.0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const plumeMesh = new THREE.Mesh(plumeGeo, plumeMat);
      const flashMesh = new THREE.Mesh(plumeGeo, flashMat);
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      plumeMesh.visible = false;
      flashMesh.visible = false;
      ringMesh.visible = false;
      this.root.add(plumeMesh, flashMesh, ringMesh);
      this.blastVfxPool.push({
        active: false,
        timerSec: 0,
        durationSec: 1.4,
        pos: new THREE.Vector3(),
        plumeMesh,
        flashMesh,
        ringMesh,
      });
    }

    // Single pooled dynamic explosion PointLight recycled to the latest blast
    this.blastLight = new THREE.PointLight(0xff9c40, 0, 32, 1.8);
    this.blastLight.visible = false;
    this.root.add(this.blastLight);
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /** Runtime feature kill-switch: cleanly hides all pits/shells/decals and zeroes CPU cost. */
  public setEnabled(enabled: boolean): void {
    this.enabled = Boolean(enabled);
    this.root.visible = this.enabled;
    if (!this.enabled) {
      for (const shell of this.shellPool) {
        shell.active = false;
        shell.mesh.visible = false;
      }
      for (const pit of this.pits.values()) {
        pit.state.seatedPlayerId = null;
        pit.state.seatedPlayerName = null;
        pit.state.seatedPlayerTeam = null;
        pit.state.activeMissionId = null;
        pit.missionRoundsRemaining = 0;
        pit.missionCallerId = null;
        pit.state.status = 'INACTIVE';
      }
      this.teamStates.A.activeMortarMissionId = null;
      this.teamStates.B.activeMortarMissionId = null;
      this.remoteActiveMissions = [];
      this.blastLight.visible = false;
      this.blastLight.intensity = 0;
      this.lastTickActivePits = 0;
    }
  }

  public setHostAuthority(isHost: boolean): void {
    this.isHost = isHost;
  }

  public setWind(windSpeedMps: number, windDirRad: number): void {
    this.windX = Math.sin(windDirRad) * windSpeedMps;
    this.windZ = -Math.cos(windDirRad) * windSpeedMps;
  }

  public getWindVector(): { windX: number; windZ: number; speedMps: number; dirDeg: number } {
    const speedMps = Math.hypot(this.windX, this.windZ);
    const dirRad = Math.atan2(this.windX, -this.windZ);
    const dirDeg = ((THREE.MathUtils.radToDeg(dirRad) % 360) + 360) % 360;
    return { windX: this.windX, windZ: this.windZ, speedMps, dirDeg };
  }

  /**
   * Configures up to MAX_MORTAR_PITS (6) physical sandbagged mortar pits across the theater:
   * 1 per Team HQ + up to 2 forward FOBs per team.
   */
  public configureSites(sites: readonly MortarSiteConfig[]): void {
    // Clear existing pits cleanly
    for (const pit of this.pits.values()) {
      this.root.remove(pit.root);
    }
    this.pits.clear();

    const capped = sites.slice(0, MAX_MORTAR_PITS);
    for (const cfg of capped) {
      const pit = this.buildMortarPit(cfg);
      this.pits.set(cfg.pitId, pit);
      this.root.add(pit.root);
    }
  }

  /**
   * Synchronizes FOB pit ownership & active state when Conquest sectors flip.
   * Preserves HQ pits as always active for their owning team.
   */
  public syncFobOwnership(
    fobOwnership: ReadonlyMap<string, 'A' | 'B' | null>,
  ): void {
    if (!this.enabled) return;
    let activeFobsA = 0;
    let activeFobsB = 0;

    for (const pit of this.pits.values()) {
      if (pit.state.sourceType === 'HQ') {
        pit.root.visible = true;
        if (pit.state.status === 'INACTIVE') {
          pit.state.status = 'ACTIVE_AI';
        }
        continue;
      }

      const owner = fobOwnership.get(pit.state.sourceId) ?? null;
      const canActivate =
        owner === 'A'
          ? activeFobsA < 2
          : owner === 'B'
            ? activeFobsB < 2
            : false;

      if (owner && canActivate) {
        if (owner === 'A') activeFobsA++;
        else activeFobsB++;

        const teamChanged = pit.state.ownerTeam !== owner;
        pit.state.ownerTeam = owner;
        pit.root.visible = true;

        if (pit.state.status === 'INACTIVE' || teamChanged) {
          // Only eject seated player if pit was previously inactive
          if (pit.state.status === 'INACTIVE') {
            pit.state.gunnerAiHp = 100;
            pit.state.loaderAiHp = 100;
            pit.state.respawnTimerSec = 0;
            pit.state.status = 'ACTIVE_AI';
            this.applyCrewUniforms(pit, owner);
            this.resetCrewVisualsAlive(pit);
          } else if (teamChanged) {
            // Sector flipped -> abort any active mission on old team and re-uniform AI crew
            if (pit.state.status === 'FIRE_MISSION' && pit.state.activeMissionId) {
              this.abortPitFireMission(pit, 'fob_flip', false);
            }
            this.applyCrewUniforms(pit, owner);
            if (pit.state.gunnerAiHp <= 0 && pit.state.loaderAiHp <= 0) {
              pit.state.respawnTimerSec = Math.min(pit.state.respawnTimerSec || MORTAR_CREW_REINFORCE_SEC, MORTAR_CREW_REINFORCE_SEC);
              if (!pit.state.seatedPlayerId) {
                pit.state.status = 'KIA_REINFORCING';
              }
            }
          }
        }
      } else {
        // Neutral FOB -> abort any active fire mission & mark pit inactive (0ms tick)
        if (pit.state.status === 'FIRE_MISSION' && pit.state.activeMissionId) {
          this.abortPitFireMission(pit, 'fob_flip', false);
        }
        pit.state.status = 'INACTIVE';
        pit.state.seatedPlayerId = null;
        pit.state.seatedPlayerName = null;
        pit.state.seatedPlayerTeam = null;
        pit.root.visible = false;
      }
    }
  }

  public getTeamFireSupportState(team: 'A' | 'B'): TeamFireSupportState {
    return { ...this.teamStates[team] };
  }

  public getTeamFireSupportStates(): [TeamFireSupportState, TeamFireSupportState] {
    return [{ ...this.teamStates.A }, { ...this.teamStates.B }];
  }

  public getActiveMissionSummaries(): ActiveMortarMissionSummary[] {
    if (!this.isHost) {
      return this.remoteActiveMissions.map((m) => ({ ...m }));
    }
    const out: ActiveMortarMissionSummary[] = [];
    for (const pit of this.pits.values()) {
      if (
        pit.state.status === 'FIRE_MISSION' &&
        pit.state.activeMissionId &&
        pit.missionRoundsRemaining > 0
      ) {
        out.push({
          missionId: pit.state.activeMissionId,
          pitId: pit.state.pitId,
          team: pit.missionCallerTeam,
          targetX: pit.missionTargetPos.x,
          targetZ: pit.missionTargetPos.z,
          roundsRemaining: pit.missionRoundsRemaining,
          totalRounds: pit.missionTotalRounds,
          callerName: pit.missionCallerName,
        });
      }
    }
    return out;
  }

  /**
   * Evaluates PDA reticle target coordinates for live Fire Support UI feedback
   * (battery availability, 65m HQ exclusion, 81mm ballistic range, 45m Danger Close, team cooldown).
   */
  public evaluateFireMissionTarget(opts: {
    team: 'A' | 'B';
    targetX: number;
    targetZ: number;
    exclusionZones: readonly MortarExclusionZone[];
    friendlyPositions: readonly MortarFriendlyPosition[];
  }): MortarReticleEvaluation {
    const dc = evaluateMortarDangerClose(opts.targetX, opts.targetZ, opts.friendlyPositions);
    const inHqExclusion = this.isInsideHqExclusion(opts.targetX, opts.targetZ, opts.exclusionZones);
    const teamState = this.teamStates[opts.team];

    let totalFriendlyBatteries = 0;
    let availableAiBatteries = 0;
    let inRange = false;

    const targetGroundY = this.getGroundHeight(opts.targetX, opts.targetZ);
    const targetVec = _vB.set(opts.targetX, targetGroundY, opts.targetZ);

    for (const pit of this.pits.values()) {
      if (pit.state.ownerTeam !== opts.team || pit.state.status === 'INACTIVE') continue;
      totalFriendlyBatteries++;
      const crewAlive = pit.state.gunnerAiHp > 0 || pit.state.loaderAiHp > 0;
      if (pit.state.status === 'ACTIVE_AI' && crewAlive) {
        availableAiBatteries++;
        const origin = _vA.set(pit.state.position[0], pit.state.position[1] + 1.15, pit.state.position[2]);
        const table = solveMortarFiringTable(origin, targetVec, this.windX, this.windZ);
        if (table.recommended?.inRange) {
          inRange = true;
        }
      }
    }

    let blockReason: string | null = null;
    if (!this.enabled) {
      blockReason = 'Fire Support Offline';
    } else if (teamState.activeMortarMissionId) {
      blockReason = 'Mortar Sweep In Progress';
    } else if (teamState.mortarStrikeCooldownSec > 0.05) {
      blockReason = `Battery Cooling Down (${Math.ceil(teamState.mortarStrikeCooldownSec)}s)`;
    } else if (inHqExclusion) {
      blockReason = 'HQ 65m No-Fire Zone';
    } else if (availableAiBatteries === 0) {
      blockReason = 'No Friendly AI Battery Available';
    } else if (!inRange) {
      blockReason = 'Target Out of 81mm Range (35m–700m)';
    }

    return {
      availableAiBatteries,
      totalFriendlyBatteries,
      inHqExclusion,
      inRange,
      dangerClose: dc.dangerClose,
      minFriendlyDistM: dc.minFriendlyDistM,
      canCall: blockReason === null,
      blockReason,
    };
  }

  /**
   * Host-authoritative Phase 3 1-Sweep 5-Round Mortar Fire Mission Override:
   *  - Team-wide 75s cooldown, 5 rounds at 1.4s cadence, 18m CEP
   *  - Rejects targets inside either team's 65m HQ exclusion cylinder
   *  - Computes 45m Danger Close warning when friendly units are nearby
   *  - Transitions best eligible friendly ACTIVE_AI pit -> FIRE_MISSION
   */
  public requestMortarFireMission(opts: {
    callerId: string;
    callerName: string;
    callerTeam: 'A' | 'B';
    targetX: number;
    targetZ: number;
    exclusionZones: readonly MortarExclusionZone[];
    friendlyPositions: readonly MortarFriendlyPosition[];
  }): MortarMissionRequestResult {
    const dc = evaluateMortarDangerClose(opts.targetX, opts.targetZ, opts.friendlyPositions);
    if (!this.enabled) {
      return {
        ok: false,
        dangerClose: dc.dangerClose,
        minFriendlyDistM: dc.minFriendlyDistM,
        reason: 'Fire support disabled',
      };
    }
    const teamState = this.teamStates[opts.callerTeam];
    if (teamState.activeMortarMissionId) {
      return {
        ok: false,
        dangerClose: dc.dangerClose,
        minFriendlyDistM: dc.minFriendlyDistM,
        reason: 'Mortar Sweep Already Active',
      };
    }
    if (teamState.mortarStrikeCooldownSec > 0.05) {
      return {
        ok: false,
        dangerClose: dc.dangerClose,
        minFriendlyDistM: dc.minFriendlyDistM,
        reason: `Mortar Sweep Recharging (${Math.ceil(teamState.mortarStrikeCooldownSec)}s)`,
      };
    }
    if (this.isInsideHqExclusion(opts.targetX, opts.targetZ, opts.exclusionZones)) {
      return {
        ok: false,
        dangerClose: dc.dangerClose,
        minFriendlyDistM: dc.minFriendlyDistM,
        reason: 'Target Inside 65m HQ No-Fire Zone',
      };
    }

    const targetGroundY = this.getGroundHeight(opts.targetX, opts.targetZ);
    const targetVec = new THREE.Vector3(opts.targetX, targetGroundY, opts.targetZ);

    let eligibleAiCount = 0;
    let chosenPit: InternalMortarPit | null = null;
    let chosenSolution: ReturnType<typeof solveMortarFiringTable>['recommended'] = null;
    let bestScore = -Infinity;

    for (const pit of this.pits.values()) {
      if (pit.state.ownerTeam !== opts.callerTeam) continue;
      if (pit.state.status !== 'ACTIVE_AI') continue;
      if (pit.state.gunnerAiHp <= 0 && pit.state.loaderAiHp <= 0) continue;
      eligibleAiCount++;

      const origin = _vA.set(pit.state.position[0], pit.state.position[1] + 1.15, pit.state.position[2]);
      const table = solveMortarFiringTable(origin, targetVec, this.windX, this.windZ);
      if (!table.recommended?.inRange) continue;

      // Prefer pit with both crew alive and shortest flight time / mid-range ballistic arc
      const crewBonus = pit.state.gunnerAiHp > 0 && pit.state.loaderAiHp > 0 ? 50 : 0;
      const score = crewBonus - table.recommended.flightTimeSec * 2 - Math.abs(table.horizontalRangeM - 240) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        chosenPit = pit;
        chosenSolution = table.recommended;
      }
    }

    if (!chosenPit || !chosenSolution) {
      return {
        ok: false,
        dangerClose: dc.dangerClose,
        minFriendlyDistM: dc.minFriendlyDistM,
        reason:
          eligibleAiCount === 0
            ? 'No Friendly AI Mortar Battery Available'
            : 'Target Out of 81mm Mortar Range',
      };
    }

    const missionId = `fm_${opts.callerTeam}_${this.missionSeq++}`;
    chosenPit.state.status = 'FIRE_MISSION';
    chosenPit.state.activeMissionId = missionId;
    chosenPit.aiSalvoRemaining = 0;
    chosenPit.aiReclaimTimerSec = 0;
    chosenPit.missionCallerId = opts.callerId;
    chosenPit.missionCallerName = opts.callerName;
    chosenPit.missionCallerTeam = opts.callerTeam;
    chosenPit.missionTargetPos.copy(targetVec);
    chosenPit.missionRoundsRemaining = MORTAR_MISSION_ROUNDS;
    chosenPit.missionTotalRounds = MORTAR_MISSION_ROUNDS;
    chosenPit.missionNextRoundTimerSec = 0.25;
    chosenPit.missionDangerClose = dc.dangerClose;

    // Immediately slew tube onto mission azimuth/elevation/charge
    chosenPit.state.currentAzimuthRad = chosenSolution.azimuthRad;
    chosenPit.state.currentElevationRad = chosenSolution.elevationRad;
    chosenPit.state.currentChargeLevel = chosenSolution.charge;
    this.syncChargeRingVisuals(chosenPit);
    this.applyTubeTransform(chosenPit);

    teamState.activeMortarMissionId = missionId;
    teamState.mortarStrikeCooldownSec = MORTAR_SWEEP_COOLDOWN_SEC;
    teamState.mortarStrikeMaxCooldownSec = MORTAR_SWEEP_COOLDOWN_SEC;

    this.onMissionEvent?.({
      kind: 'started',
      missionId,
      pitId: chosenPit.state.pitId,
      team: opts.callerTeam,
      callerName: opts.callerName,
      targetX: opts.targetX,
      targetZ: opts.targetZ,
      refundedCooldownSec: 0,
      dangerClose: dc.dangerClose,
    });

    return {
      ok: true,
      missionId,
      pitId: chosenPit.state.pitId,
      dangerClose: dc.dangerClose,
      minFriendlyDistM: dc.minFriendlyDistM,
    };
  }

  public getPitStates(): MortarPitState[] {
    const out: MortarPitState[] = [];
    for (const pit of this.pits.values()) {
      out.push({
        ...pit.state,
        position: [pit.state.position[0], pit.state.position[1], pit.state.position[2]],
      });
    }
    return out;
  }

  public getPitState(pitId: string): MortarPitState | null {
    const pit = this.pits.get(pitId);
    if (!pit) return null;
    return {
      ...pit.state,
      position: [pit.state.position[0], pit.state.position[1], pit.state.position[2]],
    };
  }

  /** Returns raycastable meshes for living AI Mortar Crewmen (gunner + loader) across active pits. */
  public getAliveCrewHitMeshes(): THREE.Object3D[] {
    if (!this.enabled) return [];
    const meshes: THREE.Object3D[] = [];
    for (const pit of this.pits.values()) {
      if (!pit.root.visible || pit.state.status === 'INACTIVE') continue;
      if (pit.state.gunnerAiHp > 0) {
        for (const m of pit.gunnerVisual.hitMeshes) meshes.push(m);
      }
      if (pit.state.loaderAiHp > 0) {
        for (const m of pit.loaderVisual.hitMeshes) meshes.push(m);
      }
    }
    return meshes;
  }

  /** Returns world AABB colliders for active sandbagged mortar parapets. */
  public getColliders(): THREE.Box3[] {
    if (!this.enabled) return [];
    const boxes: THREE.Box3[] = [];
    for (const pit of this.pits.values()) {
      if (!pit.root.visible || pit.state.status === 'INACTIVE') continue;
      for (const b of pit.colliders) boxes.push(b);
    }
    return boxes;
  }

  /** Finds the nearest interactable mortar pit within [F] interact range (3.25m). */
  public findNearestInteractablePit(
    playerPos: Readonly<THREE.Vector3>,
    playerTeam: 'A' | 'B',
  ): {
    pitId: string;
    distanceM: number;
    promptText: string;
    canMount: boolean;
    blockedReason?: string;
  } | null {
    if (!this.enabled) return null;
    let best: {
      pitId: string;
      distanceM: number;
      promptText: string;
      canMount: boolean;
      blockedReason?: string;
    } | null = null;

    for (const pit of this.pits.values()) {
      if (!pit.root.visible || pit.state.status === 'INACTIVE') continue;
      const dx = pit.state.position[0] - playerPos.x;
      const dz = pit.state.position[2] - playerPos.z;
      const dy = Math.abs(pit.state.position[1] - playerPos.y);
      if (dy > 2.6) continue;
      const dist = Math.hypot(dx, dz);
      if (dist > MORTAR_INTERACT_RADIUS_M) continue;
      if (best && dist >= best.distanceM) continue;

      const isFriendly = pit.state.ownerTeam === playerTeam;
      const enemyCrewAlive = !isFriendly && (pit.state.gunnerAiHp > 0 || pit.state.loaderAiHp > 0);
      if (pit.state.seatedPlayerId) {
        best = {
          pitId: pit.state.pitId,
          distanceM: dist,
          promptText: `Station Occupied by ${pit.state.seatedPlayerName ?? 'Operator'}`,
          canMount: false,
          blockedReason: `Station Occupied by ${pit.state.seatedPlayerName ?? 'Operator'}`,
        };
      } else if (enemyCrewAlive) {
        best = {
          pitId: pit.state.pitId,
          distanceM: dist,
          promptText: 'Neutralize Enemy Crew First',
          canMount: false,
          blockedReason: 'Neutralize Enemy Crew First',
        };
      } else {
        const label = isFriendly
          ? `[F] Man 81mm Mortar (${pit.state.sourceType})`
          : `[F] Operate Captured Enemy Mortar`;
        best = {
          pitId: pit.state.pitId,
          distanceM: dist,
          promptText: label,
          canMount: true,
        };
      }
    }

    return best;
  }

  /**
   * Host-authoritative seat arbitration for [F] mounting:
   * - Single-seat lock: seated players can NEVER be stolen.
   * - Living enemy AI crew blocks mounting ("Neutralize Enemy Crew First").
   * - Dead enemy crew allows infiltrating player to operate captured enemy mortar on solo 4.2s cadence.
   * - Friendly AI Gunner yields smoothly (1.1m lateral step) and reclaims 1.0s after player exits/dies.
   */
  public requestSeat(
    pitId: string,
    playerId: string,
    playerName: string,
    playerTeam: 'A' | 'B',
  ): MortarSeatArbitrationResult {
    if (!this.enabled) {
      return { ok: false, pitId, reason: 'Fire support disabled' };
    }
    const pit = this.pits.get(pitId);
    if (!pit || pit.state.status === 'INACTIVE') {
      return { ok: false, pitId, reason: 'Mortar emplacement inactive' };
    }

    // Already seated in this pit
    if (pit.state.seatedPlayerId === playerId) {
      return { ok: true, pitId };
    }

    // Rule 1: Seated players can NEVER be displaced
    if (pit.state.seatedPlayerId && pit.state.seatedPlayerId !== playerId) {
      return {
        ok: false,
        pitId,
        reason: `Station Occupied by ${pit.state.seatedPlayerName ?? 'Operator'}`,
      };
    }

    // Rule 2: Enemy pit requires enemy crew to be neutralized first
    const isFriendly = pit.state.ownerTeam === playerTeam;
    if (!isFriendly && (pit.state.gunnerAiHp > 0 || pit.state.loaderAiHp > 0)) {
      return {
        ok: false,
        pitId,
        reason: 'Neutralize Enemy Crew First',
      };
    }

    // Release any other pit this player might have occupied
    for (const other of this.pits.values()) {
      if (other.state.seatedPlayerId === playerId && other.state.pitId !== pitId) {
        this.releaseSeat(other.state.pitId, playerId);
      }
    }

    // Mid-mission player [F] takeover: abort active AI sweep cleanly (team 75s cooldown stays consumed)
    if (pit.state.status === 'FIRE_MISSION' && pit.state.activeMissionId) {
      this.abortPitFireMission(pit, 'aborted_takeover', false);
    }

    pit.state.seatedPlayerId = playerId;
    pit.state.seatedPlayerName = playerName;
    pit.state.seatedPlayerTeam = playerTeam;
    pit.state.status = 'PLAYER_MANNED';
    pit.aiReclaimTimerSec = 0;
    pit.aiSalvoRemaining = 0;
    pit.reloadDurationSec = this.computeReloadDurationSec(pit);
    pit.reloadTimerSec = 0;
    pit.state.reloadProgress01 = 1;
    pit.bubbleErrorX = 0;
    pit.bubbleErrorY = 0;
    pit.stakeDriftMils = 0;

    return { ok: true, pitId };
  }

  /** Releases player from a mortar pit; friendly AI Gunner reclaims after 1.0s delay. */
  public releaseSeat(pitId: string, playerId: string): boolean {
    const pit = this.pits.get(pitId);
    if (!pit || pit.state.seatedPlayerId !== playerId) return false;

    pit.state.seatedPlayerId = null;
    pit.state.seatedPlayerName = null;
    pit.state.seatedPlayerTeam = null;

    if (pit.state.gunnerAiHp > 0 || pit.state.loaderAiHp > 0) {
      pit.aiReclaimTimerSec = MORTAR_AI_RECLAIM_DELAY_SEC;
      pit.state.status = 'ACTIVE_AI';
    } else {
      pit.state.status = 'KIA_REINFORCING';
      if (pit.state.respawnTimerSec <= 0) {
        pit.state.respawnTimerSec = MORTAR_CREW_REINFORCE_SEC;
      }
    }
    return true;
  }

  /** Finds the pit currently manned by a given playerId, if any. */
  public getPitMannedBy(playerId: string): string | null {
    for (const pit of this.pits.values()) {
      if (pit.state.seatedPlayerId === playerId) return pit.state.pitId;
    }
    return null;
  }

  /**
   * Applies bullet/melee/explosion damage to an AI Mortar Crewman (gunner or loader).
   * If AI Loader dies while player is seated, reload cadence dynamically switches 2.4s -> 4.2s.
   * If both crewmen die and pit is unmanned, transitions to KIA_REINFORCING (50s timer).
   */
  public damageCrewMember(
    pitId: string,
    role: 'gunner' | 'loader',
    damage: number,
    headshot = false,
  ): MortarCrewHitResult | null {
    if (!this.enabled || damage <= 0) return null;
    const pit = this.pits.get(pitId);
    if (!pit || pit.state.status === 'INACTIVE') return null;

    const prevHp = role === 'gunner' ? pit.state.gunnerAiHp : pit.state.loaderAiHp;
    if (prevHp <= 0) return null;

    const applied = Math.min(prevHp, Math.round(damage));
    const nextHp = Math.max(0, prevHp - applied);
    if (role === 'gunner') {
      pit.state.gunnerAiHp = nextHp;
      if (nextHp <= 0) {
        pit.gunnerVisual.dead = true;
        pit.gunnerVisual.root.visible = false;
      }
    } else {
      pit.state.loaderAiHp = nextHp;
      if (nextHp <= 0) {
        pit.loaderVisual.dead = true;
        pit.loaderVisual.root.visible = false;
      }
    }

    const killed = nextHp <= 0;
    const bothCrewDead = pit.state.gunnerAiHp <= 0 && pit.state.loaderAiHp <= 0;

    // Dynamically switch reload cadence immediately if AI Loader is killed while player is seated!
    if (killed && role === 'loader' && pit.state.seatedPlayerId) {
      const oldDur = pit.reloadDurationSec;
      const newDur = this.computeReloadDurationSec(pit);
      if (newDur > oldDur && pit.reloadTimerSec > 0) {
        const progress = 1 - pit.reloadTimerSec / Math.max(0.1, oldDur);
        pit.reloadDurationSec = newDur;
        pit.reloadTimerSec = (1 - progress) * newDur;
      } else {
        pit.reloadDurationSec = newDur;
      }
    }

    let abortedMissionRefundSec = 0;
    if (bothCrewDead) {
      pit.aiSalvoRemaining = 0;
      pit.state.respawnTimerSec = MORTAR_CREW_REINFORCE_SEC;
      // Mid-mission crew KIA -> abort fire mission immediately & refund 50% of 75s cooldown (37.5s)
      if (pit.state.status === 'FIRE_MISSION' && pit.state.activeMissionId && pit.missionRoundsRemaining > 0) {
        abortedMissionRefundSec = this.abortPitFireMission(pit, 'aborted_crew_kia', true);
      }
      if (!pit.state.seatedPlayerId) {
        pit.state.status = 'KIA_REINFORCING';
      }
    }

    return {
      hit: true,
      pitId,
      role,
      ownerTeam: pit.state.ownerTeam,
      damageApplied: applied,
      remainingHp: nextHp,
      killed,
      bothCrewDead,
      headshot,
      ...(abortedMissionRefundSec > 0 ? { abortedMissionRefundSec } : {}),
    };
  }

  /** Adjusts manual deflection & elevation handwheels (also settles spirit bubble & aiming stakes). */
  public adjustHandwheels(
    pitId: string,
    deltaAzimuthRad: number,
    deltaElevationRad: number,
    settleBubbleStrength = 0.0,
  ): void {
    const pit = this.pits.get(pitId);
    if (!pit) return;

    const twoPi = Math.PI * 2;
    pit.state.currentAzimuthRad =
      (((pit.state.currentAzimuthRad + deltaAzimuthRad) % twoPi) + twoPi) % twoPi;
    pit.state.currentElevationRad = THREE.MathUtils.clamp(
      pit.state.currentElevationRad + deltaElevationRad,
      MORTAR_MIN_ELEVATION_RAD,
      MORTAR_MAX_ELEVATION_RAD,
    );

    // Turning handwheels physically rotates the 3D crank wheels and corrects post-shot stake/bubble drift
    pit.traverseWheel.rotation.z += deltaAzimuthRad * 16;
    pit.elevateWheel.rotation.x += deltaElevationRad * 20;

    if (Math.abs(deltaAzimuthRad) > 1e-5) {
      pit.stakeDriftMils = THREE.MathUtils.damp(pit.stakeDriftMils, 0, 12, Math.abs(deltaAzimuthRad) * 18);
      pit.bubbleErrorX = THREE.MathUtils.damp(pit.bubbleErrorX, 0, 10, Math.abs(deltaAzimuthRad) * 18);
    }
    if (Math.abs(deltaElevationRad) > 1e-5) {
      pit.bubbleErrorY = THREE.MathUtils.damp(pit.bubbleErrorY, 0, 10, Math.abs(deltaElevationRad) * 18);
    }
    if (settleBubbleStrength > 0) {
      const k = THREE.MathUtils.clamp(settleBubbleStrength, 0, 1);
      pit.bubbleErrorX *= 1 - k;
      pit.bubbleErrorY *= 1 - k;
      pit.stakeDriftMils *= 1 - k;
      if (Math.abs(pit.bubbleErrorX) < 0.015) pit.bubbleErrorX = 0;
      if (Math.abs(pit.bubbleErrorY) < 0.015) pit.bubbleErrorY = 0;
      if (Math.abs(pit.stakeDriftMils) < 0.5) pit.stakeDriftMils = 0;
    }

    this.applyTubeTransform(pit);
  }

  /** Re-levels the cross-level spirit bubble and re-indexes aiming stakes (pressing [R] while seated). */
  public relevelBubbleAndStakes(pitId: string, dt: number): void {
    const pit = this.pits.get(pitId);
    if (!pit) return;
    pit.bubbleErrorX = THREE.MathUtils.damp(pit.bubbleErrorX, 0, 6.8, dt);
    pit.bubbleErrorY = THREE.MathUtils.damp(pit.bubbleErrorY, 0, 6.8, dt);
    pit.stakeDriftMils = THREE.MathUtils.damp(pit.stakeDriftMils, 0, 6.8, dt);
    if (Math.abs(pit.bubbleErrorX) < 0.02) pit.bubbleErrorX = 0;
    if (Math.abs(pit.bubbleErrorY) < 0.02) pit.bubbleErrorY = 0;
    if (Math.abs(pit.stakeDriftMils) < 0.5) pit.stakeDriftMils = 0;
  }

  /** Sets Propellant Charge Ring level (1–4) and updates visible augmenting rings on the staged shell. */
  public setChargeLevel(pitId: string, charge: MortarChargeLevel): boolean {
    const pit = this.pits.get(pitId);
    if (!pit) return false;
    const clamped = Math.max(1, Math.min(4, Math.round(charge))) as MortarChargeLevel;
    if (pit.state.currentChargeLevel === clamped) return false;
    pit.state.currentChargeLevel = clamped;
    this.syncChargeRingVisuals(pit);
    this.audio?.playMortarChargeClick(clamped);
    return true;
  }

  public cycleChargeLevel(pitId: string, delta: -1 | 1): MortarChargeLevel {
    const pit = this.pits.get(pitId);
    if (!pit) return 2;
    const next = THREE.MathUtils.clamp(pit.state.currentChargeLevel + delta, 1, 4) as MortarChargeLevel;
    this.setChargeLevel(pitId, next);
    return next;
  }

  /** Applies Forward Observer correction offsets stored on the pit's firing table. */
  public setForwardObserverOffsets(pitId: string, addDropM: number, leftRightM: number): void {
    const pit = this.pits.get(pitId);
    if (!pit) return;
    pit.foAddDropM = THREE.MathUtils.clamp(addDropM, -200, 200);
    pit.foLeftRightM = THREE.MathUtils.clamp(leftRightM, -200, 200);
  }

  /**
   * Attempts a player-initiated bore-drop mortar firing sequence.
   * Enforces dynamic reload timer (2.4s AI Loader vs 4.2s Solo) and injects baseplate recoil
   * disturbance into the spirit-level bubble & aiming stakes.
   */
  public tryPlayerFire(
    pitId: string,
    callerId: string,
    callerTeam: 'A' | 'B',
  ): GameMortarLaunchPacket | null {
    if (!this.enabled) return null;
    const pit = this.pits.get(pitId);
    if (!pit || pit.state.status !== 'PLAYER_MANNED') return null;
    if (pit.state.seatedPlayerId !== callerId) return null;
    if (pit.reloadTimerSec > 0.001) return null;

    // Off-level spirit bubble introduces realistic dispersion in mils
    const bubbleSpreadAz = pit.bubbleErrorX * 0.042 + (pit.stakeDriftMils / RAD_TO_MILS) * 0.55;
    const bubbleSpreadEl = pit.bubbleErrorY * 0.024;
    const fireAz = pit.state.currentAzimuthRad + bubbleSpreadAz;
    const fireEl = THREE.MathUtils.clamp(
      pit.state.currentElevationRad + bubbleSpreadEl,
      MORTAR_MIN_ELEVATION_RAD,
      MORTAR_MAX_ELEVATION_RAD,
    );

    const packet = this.launchMortarShell(
      pit,
      callerId,
      callerTeam,
      true,
      fireAz,
      fireEl,
      pit.state.currentChargeLevel,
    );
    if (!packet) return null;

    // Start reload cycle (2.4s with friendly AI loader, 4.2s solo)
    pit.reloadDurationSec = this.computeReloadDurationSec(pit);
    pit.reloadTimerSec = pit.reloadDurationSec;
    pit.state.reloadProgress01 = 0;

    // Baseplate recoil shock knocks the spirit bubble off-level & shifts sight off aiming stakes
    const chargeRecoil = MORTAR_CHARGE_SPECS[pit.state.currentChargeLevel].recoilImpulse;
    const signX = this.shellSeq % 2 === 0 ? 1 : -1;
    pit.bubbleErrorX = THREE.MathUtils.clamp(
      pit.bubbleErrorX + signX * (0.28 + chargeRecoil * 0.24),
      -1,
      1,
    );
    pit.bubbleErrorY = THREE.MathUtils.clamp(
      pit.bubbleErrorY - (0.30 + chargeRecoil * 0.26),
      -1,
      1,
    );
    pit.stakeDriftMils = THREE.MathUtils.clamp(
      pit.stakeDriftMils + signX * (14 + chargeRecoil * 18),
      -85,
      85,
    );
    pit.recoilKick01 = 1.0;

    return packet;
  }

  /** Replays a host-authoritative mortar launch packet on remote clients. */
  public applyRemoteLaunchPacket(packet: GameMortarLaunchPacket): void {
    if (!this.enabled) return;
    const pit = this.pits.get(packet.pitId);
    if (pit) {
      pit.state.currentAzimuthRad = packet.azimuthRad;
      pit.state.currentElevationRad = packet.elevationRad;
      pit.state.currentChargeLevel = packet.chargeLevel;
      this.applyTubeTransform(pit);
      this.triggerMuzzleFlash(pit);
      pit.recoilKick01 = 1.0;
    }

    const origin = _vA.set(packet.ox, packet.oy, packet.oz);
    const impact = _vB.set(packet.ix, packet.iy, packet.iz);
    const spec = MORTAR_CHARGE_SPECS[packet.chargeLevel] ?? MORTAR_CHARGE_SPECS[2];
    const horizV = spec.muzzleSpeedMps * Math.cos(packet.elevationRad);
    const vy = spec.muzzleSpeedMps * Math.sin(packet.elevationRad);
    const vx = Math.sin(packet.azimuthRad) * horizV;
    const vz = -Math.cos(packet.azimuthRad) * horizV;

    this.spawnPooledShell({
      shellId: packet.shellId,
      pitId: packet.pitId,
      callerId: packet.callerId,
      callerTeam: packet.callerTeam,
      isPlayerManned: packet.isPlayerManned,
      origin,
      vel: _vC.set(vx, vy, vz),
      impactPos: impact,
      flightTimeSec: packet.flightTimeSec,
    });
    this.audio?.playMortarLaunch(origin, packet.isPlayerManned);
  }

  /** Applies host-authoritative state snapshot on non-host clients. */
  public applyRemoteSyncPacket(packet: GameFireSupportSyncPacket): void {
    this.setEnabled(packet.enabled);
    if (!packet.enabled) return;

    for (const incoming of packet.pits) {
      const pit = this.pits.get(incoming.pitId);
      if (!pit) continue;
      const teamChanged = pit.state.ownerTeam !== incoming.ownerTeam;
      Object.assign(pit.state, incoming);
      pit.root.visible = incoming.status !== 'INACTIVE';
      if (teamChanged) {
        this.applyCrewUniforms(pit, incoming.ownerTeam);
      }
      pit.gunnerVisual.dead = incoming.gunnerAiHp <= 0;
      pit.gunnerVisual.root.visible = !pit.gunnerVisual.dead;
      pit.loaderVisual.dead = incoming.loaderAiHp <= 0;
      pit.loaderVisual.root.visible = !pit.loaderVisual.dead;
      this.syncChargeRingVisuals(pit);
      this.applyTubeTransform(pit);
    }

    if (packet.teams && packet.teams.length === 2) {
      for (const incomingTeam of packet.teams) {
        if (incomingTeam.team === 'A' || incomingTeam.team === 'B') {
          Object.assign(this.teamStates[incomingTeam.team], incomingTeam);
        }
      }
    }

    if (Array.isArray(packet.activeMissions)) {
      this.remoteActiveMissions = packet.activeMissions.map((m) => ({ ...m }));
    } else {
      this.remoteActiveMissions = [];
    }
  }

  /** Computes gunner camera world position & lookAt target while seated (Over-Tube or Optical Sight). */
  public getPlayerCameraPose(
    pitId: string,
    opticalSightActive: boolean,
    outPos: THREE.Vector3,
    outLookAt: THREE.Vector3,
  ): boolean {
    const pit = this.pits.get(pitId);
    if (!pit) return false;

    const az = pit.state.currentAzimuthRad;
    const fwdX = Math.sin(az);
    const fwdZ = -Math.cos(az);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const px = pit.state.position[0];
    const py = pit.state.position[1];
    const pz = pit.state.position[2];

    if (opticalSightActive) {
      // Eye pressed into elbow collimator eyepiece on left side of bipod, looking straight over twin aiming stakes
      outPos.set(px - rightX * 0.34 - fwdX * 0.22, py + 1.06, pz - rightZ * 0.34 - fwdZ * 0.22);
      const stakeBearing = pit.state.currentAzimuthRad + pit.stakeDriftMils / RAD_TO_MILS;
      const sx = Math.sin(stakeBearing);
      const sz = -Math.cos(stakeBearing);
      outLookAt.set(
        outPos.x + sx * 12.0,
        outPos.y - 0.12 + pit.bubbleErrorY * 0.35,
        outPos.z + sz * 12.0,
      );
    } else {
      // Kneeling tactical bodycam beside the mortar tube (full view of handwheels, tube, staged shell & stakes)
      outPos.set(px - rightX * 0.72 - fwdX * 0.92, py + 1.32, pz - rightZ * 0.72 - fwdZ * 0.92);
      const lookPitchY = Math.tan(THREE.MathUtils.degToRad(14)) * 8;
      outLookAt.set(px + fwdX * 8.0, py + 0.92 + lookPitchY * 0.25, pz + fwdZ * 8.0);
    }
    return true;
  }

  /** Returns live mil-sim HUD telemetry for the player currently manning `pitId`. */
  public getPlayerMortarHudTelemetry(
    pitId: string,
    opticalSightActive: boolean,
  ): MortarPlayerHudTelemetry | null {
    const pit = this.pits.get(pitId);
    if (!pit || pit.state.status !== 'PLAYER_MANNED') return null;

    const origin = _vA.set(pit.state.position[0], pit.state.position[1] + 1.15, pit.state.position[2]);
    const sim = simulateMortarImpact(
      origin,
      pit.state.currentAzimuthRad,
      pit.state.currentElevationRad,
      pit.state.currentChargeLevel,
      this.windX,
      this.windZ,
    );
    const wind = this.getWindVector();
    const isFriendly = pit.state.ownerTeam === pit.state.seatedPlayerTeam;
    const aiLoaderAlive = isFriendly && pit.state.loaderAiHp > 0;

    return {
      pitId: pit.state.pitId,
      ownerTeam: pit.state.ownerTeam,
      sourceType: pit.state.sourceType,
      isCapturedEnemyPit: !isFriendly,
      azimuthRad: pit.state.currentAzimuthRad,
      deflectionMils: radiansToNatoMils(pit.state.currentAzimuthRad),
      elevationRad: pit.state.currentElevationRad,
      elevationDeg: Number(THREE.MathUtils.radToDeg(pit.state.currentElevationRad).toFixed(1)),
      elevationMils: Math.round(pit.state.currentElevationRad * RAD_TO_MILS),
      chargeLevel: pit.state.currentChargeLevel,
      chargeLabel: MORTAR_CHARGE_SPECS[pit.state.currentChargeLevel].label,
      reloadProgress01: pit.state.reloadProgress01,
      reloadDurationSec: pit.reloadDurationSec,
      aiLoaderAlive,
      bubbleErrorX: pit.bubbleErrorX,
      bubbleErrorY: pit.bubbleErrorY,
      isLevelSettled: Math.abs(pit.bubbleErrorX) < 0.12 && Math.abs(pit.bubbleErrorY) < 0.12,
      stakeDriftMils: Math.round(pit.stakeDriftMils),
      opticalSightActive,
      estimatedRangeM: Math.round(sim.horizontalRangeM),
      estimatedFlightSec: Number(sim.flightTimeSec.toFixed(1)),
      windSpeedMps: Number(wind.speedMps.toFixed(1)),
      windDirDeg: Math.round(wind.dirDeg),
      foAddDropM: pit.foAddDropM,
      foLeftRightM: pit.foLeftRightM,
      canFire: pit.reloadTimerSec <= 0.001,
    };
  }

  /**
   * Per-frame update enforcing:
   * - 0ms idle skip for INACTIVE / KIA_REINFORCING crew animations
   * - 60 Hz crew LOD within 35m of local player, 10 Hz beyond 35m
   * - Autonomous ACTIVE_AI 3-round salvos every 35s with 32m CEP, >80m from friendly flags, outside 65m HQ exclusion
   * - Pooled falling shells, blast VFX, and dynamic explosion PointLight decay
   */
  public update(
    dt: number,
    opts: {
      localPlayerPos: Readonly<THREE.Vector3>;
      targets?: readonly MortarTargetCandidate[];
      exclusionZones?: readonly MortarExclusionZone[];
    },
  ): void {
    if (!this.enabled) {
      this.lastTickActivePits = 0;
      this.lastCpuMs = 0;
      return;
    }

    const tStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    let activeTicks = 0;

    // Tick per-team fire support cooldown timers
    for (const teamKey of ['A', 'B'] as const) {
      const ts = this.teamStates[teamKey];
      if (ts.mortarStrikeCooldownSec > 0) {
        ts.mortarStrikeCooldownSec = Math.max(0, ts.mortarStrikeCooldownSec - safeDt);
      }
      if (ts.airStrikeCooldownSec > 0) {
        ts.airStrikeCooldownSec = Math.max(0, ts.airStrikeCooldownSec - safeDt);
      }
    }

    for (const pit of this.pits.values()) {
      const status = pit.state.status;
      if (status === 'INACTIVE') continue;

      // KIA_REINFORCING: 0ms crew AI cost; only count down 50s reinforcement timer on host
      if (status === 'KIA_REINFORCING') {
        if (this.isHost && pit.state.respawnTimerSec > 0) {
          pit.state.respawnTimerSec = Math.max(0, pit.state.respawnTimerSec - safeDt);
          if (pit.state.respawnTimerSec <= 0) {
            pit.state.gunnerAiHp = 100;
            pit.state.loaderAiHp = 100;
            pit.state.status = 'ACTIVE_AI';
            this.resetCrewVisualsAlive(pit);
          }
        }
        continue;
      }

      activeTicks++;

      // Reload timer & staged shell visibility
      if (pit.reloadTimerSec > 0) {
        pit.reloadTimerSec = Math.max(0, pit.reloadTimerSec - safeDt);
        pit.state.reloadProgress01 = THREE.MathUtils.clamp(
          1 - pit.reloadTimerSec / Math.max(0.1, pit.reloadDurationSec),
          0,
          1,
        );
      } else {
        pit.state.reloadProgress01 = 1;
      }
      pit.stagedShellGroup.visible = pit.state.reloadProgress01 > 0.55;

      // Muzzle flash & tube recoil recovery
      if (pit.muzzleFlashTimer > 0) {
        pit.muzzleFlashTimer = Math.max(0, pit.muzzleFlashTimer - safeDt);
        pit.muzzleFlashMesh.visible = pit.muzzleFlashTimer > 0;
        const fScale = 0.65 + (1 - pit.muzzleFlashTimer / 0.11) * 1.45;
        pit.muzzleFlashMesh.scale.setScalar(fScale);
      }
      if (pit.recoilKick01 > 0.001) {
        pit.recoilKick01 = THREE.MathUtils.damp(pit.recoilKick01, 0, 12.5, safeDt);
        pit.barrelRecoilGroup.position.y = -pit.recoilKick01 * 0.11;
      } else {
        pit.barrelRecoilGroup.position.y = 0;
      }

      // Friendly AI Gunner reclaim delay (1.0s after player exits)
      if (pit.aiReclaimTimerSec > 0) {
        pit.aiReclaimTimerSec = Math.max(0, pit.aiReclaimTimerSec - safeDt);
      }

      // If both crewmen died while player is seated, still tick reinforcement countdown in background
      if (
        this.isHost &&
        pit.state.seatedPlayerId &&
        pit.state.gunnerAiHp <= 0 &&
        pit.state.loaderAiHp <= 0 &&
        pit.state.respawnTimerSec > 0
      ) {
        pit.state.respawnTimerSec = Math.max(0, pit.state.respawnTimerSec - safeDt);
      }

      // Crew AI LOD: 60 Hz within 35m of local player, throttled to 10 Hz beyond 35m
      const distToPlayer = Math.hypot(
        pit.state.position[0] - opts.localPlayerPos.x,
        pit.state.position[2] - opts.localPlayerPos.z,
      );
      const isNear = distToPlayer <= MORTAR_CREW_LOD_DIST_M;
      pit.crewLodAccumSec += safeDt;
      if (isNear || pit.crewLodAccumSec >= 0.1) {
        const animDt = isNear ? safeDt : pit.crewLodAccumSec;
        pit.crewLodAccumSec = 0;
        this.updateCrewAnimations(pit, animDt);
      }

      // Host-authoritative Phase 3 PDA Fire Mission (5 rounds @ 1.4s cadence, 18m CEP)
      if (this.isHost && status === 'FIRE_MISSION') {
        this.updateActiveFireMission(pit, safeDt, opts.exclusionZones ?? []);
      } else if (this.isHost && status === 'ACTIVE_AI' && pit.aiReclaimTimerSec <= 0) {
        // Host-authoritative Autonomous ACTIVE_AI Salvos (3 rounds every 35s, 32m CEP)
        this.updateAutonomousAiSalvo(pit, safeDt, opts.targets ?? [], opts.exclusionZones ?? []);
      }
    }

    // Update pooled falling mortar shells
    this.updateActiveShells(safeDt);

    // Update pooled blast VFX & single dynamic PointLight
    this.updateBlastVfx(safeDt);

    this.lastTickActivePits = activeTicks;
    this.lastCpuMs = typeof performance !== 'undefined' ? performance.now() - tStart : 0;
  }

  public getDiagnostics(): {
    enabled: boolean;
    pitCount: number;
    activeTickedPits: number;
    activeShells: number;
    scorchDecalPoolSize: number;
    lastCpuMs: number;
  } {
    let activeShells = 0;
    for (let i = 0; i < this.shellPool.length; i++) {
      if (this.shellPool[i].active) activeShells++;
    }
    return {
      enabled: this.enabled,
      pitCount: this.pits.size,
      activeTickedPits: this.lastTickActivePits,
      activeShells,
      scorchDecalPoolSize: this.scorchDecals.length,
      lastCpuMs: this.lastCpuMs,
    };
  }

  public dispose(): void {
    for (const pit of this.pits.values()) {
      this.root.remove(pit.root);
    }
    this.pits.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.uniformLib.dispose();
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Pit Construction (<= 2,200 tris per pit)
  // ---------------------------------------------------------------------------

  private buildMortarPit(cfg: MortarSiteConfig): InternalMortarPit {
    const pitRoot = new THREE.Group();
    pitRoot.name = `MortarPit_${cfg.pitId}`;
    const groundY = this.getGroundHeight(cfg.position[0], cfg.position[2]);
    const worldPos: [number, number, number] = [cfg.position[0], groundY, cfg.position[2]];
    pitRoot.position.set(worldPos[0], worldPos[1], worldPos[2]);

    // 1. InstancedMesh Burlap Sandbag Crescent Parapet (28 bags * 12 tris = 336 tris)
    const bagCount = 28;
    const sandbagInst = new THREE.InstancedMesh(this.geoSandbag, this.matSandbag, bagCount);
    sandbagInst.castShadow = true;
    sandbagInst.receiveShadow = true;
    const radius = 1.95;
    let idx = 0;
    // Two stacked horseshoe tiers covering 270° (rear open for player [F] entry)
    for (let tier = 0; tier < 2; tier++) {
      const count = 14;
      for (let i = 0; i < count && idx < bagCount; i++) {
        const frac = i / (count - 1);
        const angle = cfg.zeroBearingRad - Math.PI * 0.72 + frac * Math.PI * 1.44 + tier * 0.08;
        const bx = Math.sin(angle) * (radius + (tier === 1 ? 0.04 : 0));
        const bz = -Math.cos(angle) * (radius + (tier === 1 ? 0.04 : 0));
        const by = 0.12 + tier * 0.23;
        _euler.set(0, -angle, 0);
        _quat.setFromEuler(_euler);
        _scale.set(1.0 + (i % 2) * 0.06, 1.0, 1.0);
        _mat4.compose(_vA.set(bx, by, bz), _quat, _scale);
        sandbagInst.setMatrixAt(idx++, _mat4);
      }
    }
    sandbagInst.instanceMatrix.needsUpdate = true;
    sandbagInst.computeBoundingSphere();
    pitRoot.add(sandbagInst);

    // 2. Heavy Steel Baseplate + Rotating Turret Assembly (<= 650 tris)
    const baseplateGeo = new THREE.CylinderGeometry(0.46, 0.52, 0.09, 12);
    this.disposables.push(baseplateGeo);
    const baseplate = new THREE.Mesh(baseplateGeo, this.matSteelDark);
    baseplate.position.set(0, 0.045, 0);
    baseplate.castShadow = true;
    baseplate.receiveShadow = true;
    pitRoot.add(baseplate);

    const turretYawGroup = new THREE.Group();
    pitRoot.add(turretYawGroup);

    // Bipod legs & traversing screw
    const legGeo = new THREE.CylinderGeometry(0.024, 0.028, 1.08, 6);
    const screwGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.44, 6);
    const wheelGeo = new THREE.TorusGeometry(0.062, 0.012, 6, 12);
    const barrelGeo = new THREE.CylinderGeometry(0.056, 0.064, 1.32, 12);
    const collarGeo = new THREE.CylinderGeometry(0.078, 0.078, 0.14, 10);
    const sightBodyGeo = new THREE.BoxGeometry(0.08, 0.16, 0.09);
    const eyepieceGeo = new THREE.CylinderGeometry(0.028, 0.026, 0.09, 8);
    const flashGeo = new THREE.ConeGeometry(0.24, 0.55, 8);
    this.disposables.push(legGeo, screwGeo, wheelGeo, barrelGeo, collarGeo, sightBodyGeo, eyepieceGeo, flashGeo);

    const leftLeg = new THREE.Mesh(legGeo, this.matSteelDark);
    leftLeg.position.set(-0.26, 0.48, -0.52);
    leftLeg.rotation.set(0.22, 0, -0.26);
    const rightLeg = new THREE.Mesh(legGeo, this.matSteelDark);
    rightLeg.position.set(0.26, 0.48, -0.52);
    rightLeg.rotation.set(0.22, 0, 0.26);
    const traverseBar = new THREE.Mesh(screwGeo, this.matSteelGunmetal);
    traverseBar.rotation.z = Math.PI * 0.5;
    traverseBar.position.set(0, 0.88, -0.44);
    turretYawGroup.add(leftLeg, rightLeg, traverseBar);

    const traverseWheel = new THREE.Mesh(wheelGeo, this.matBrass);
    traverseWheel.position.set(-0.26, 0.88, -0.44);
    traverseWheel.rotation.y = Math.PI * 0.5;
    const elevateWheel = new THREE.Mesh(wheelGeo, this.matBrass);
    elevateWheel.position.set(-0.14, 0.68, -0.48);
    turretYawGroup.add(traverseWheel, elevateWheel);

    // Optical elbow collimator sight mounted on left side of bipod
    const sightHousing = new THREE.Group();
    sightHousing.position.set(-0.23, 1.01, -0.36);
    const sightBody = new THREE.Mesh(sightBodyGeo, this.matSteelDark);
    const eyepiece = new THREE.Mesh(eyepieceGeo, this.matBrass);
    eyepiece.rotation.x = Math.PI * 0.5;
    eyepiece.position.set(0, 0.05, 0.06);
    sightHousing.add(sightBody, eyepiece);
    turretYawGroup.add(sightHousing);

    // Barrel pivot anchored in baseplate socket (tilts in high-angle 45°-80° band)
    const barrelPivotGroup = new THREE.Group();
    barrelPivotGroup.position.set(0, 0.11, 0);
    turretYawGroup.add(barrelPivotGroup);

    const barrelRecoilGroup = new THREE.Group();
    barrelPivotGroup.add(barrelRecoilGroup);

    const barrelMesh = new THREE.Mesh(barrelGeo, this.matSteelGunmetal);
    barrelMesh.position.set(0, 0.66, 0);
    barrelMesh.castShadow = true;
    const shockCollar = new THREE.Mesh(collarGeo, this.matSteelDark);
    shockCollar.position.set(0, 0.82, 0);
    barrelRecoilGroup.add(barrelMesh, shockCollar);

    const muzzleFlashMesh = new THREE.Mesh(flashGeo, this.matFlash);
    muzzleFlashMesh.position.set(0, 1.56, 0);
    muzzleFlashMesh.visible = false;
    barrelRecoilGroup.add(muzzleFlashMesh);

    // 3. Wooden Ammo Crates + Staged 81mm Round with 4 Propellant Charge Rings (<= 280 tris)
    const crateGeo = new THREE.BoxGeometry(0.64, 0.28, 0.34);
    const ringGeo = new THREE.TorusGeometry(0.044, 0.008, 5, 10);
    const stakeGeo = new THREE.CylinderGeometry(0.018, 0.018, 1.35, 6);
    const stakeBandGeo = new THREE.CylinderGeometry(0.020, 0.020, 0.22, 6);
    this.disposables.push(crateGeo, ringGeo, stakeGeo, stakeBandGeo);

    const crateA = new THREE.Mesh(crateGeo, this.matOliveCrate);
    crateA.position.set(0.86, 0.14, 0.42);
    crateA.rotation.y = 0.35;
    crateA.castShadow = true;
    crateA.receiveShadow = true;
    const crateB = new THREE.Mesh(crateGeo, this.matOliveCrate);
    crateB.position.set(0.88, 0.42, 0.44);
    crateB.rotation.y = 0.24;
    crateB.castShadow = true;
    pitRoot.add(crateA, crateB);

    const stagedShellGroup = this.createShellMesh();
    stagedShellGroup.position.set(0.56, 0.62, 0.18);
    stagedShellGroup.rotation.z = 0.28;
    const chargeRingMeshes: THREE.Mesh[] = [];
    for (let r = 0; r < 4; r++) {
      const ring = new THREE.Mesh(ringGeo, this.matChargeRing);
      ring.rotation.x = Math.PI * 0.5;
      ring.position.set(0, -0.11 + r * 0.024, 0);
      stagedShellGroup.add(ring);
      chargeRingMeshes.push(ring);
    }
    pitRoot.add(stagedShellGroup);

    // Twin Red-and-White Aiming Stakes planted 4.2m and 7.5m downrange along zeroBearingRad
    const stakeDistances = [4.2, 7.5];
    for (let s = 0; s < stakeDistances.length; s++) {
      const dist = stakeDistances[s];
      const sx = Math.sin(cfg.zeroBearingRad) * dist;
      const sz = -Math.cos(cfg.zeroBearingRad) * dist;
      const sy = this.getGroundHeight(worldPos[0] + sx, worldPos[2] + sz) - worldPos[1];
      const stakeGroup = new THREE.Group();
      stakeGroup.position.set(sx, sy, sz);

      const pole = new THREE.Mesh(stakeGeo, this.matStakeWhite);
      pole.position.y = 0.675;
      const redBandTop = new THREE.Mesh(stakeBandGeo, this.matStakeRed);
      redBandTop.position.y = 1.15;
      const redBandMid = new THREE.Mesh(stakeBandGeo, this.matStakeRed);
      redBandMid.position.y = 0.72;
      stakeGroup.add(pole, redBandTop, redBandMid);
      pitRoot.add(stakeGroup);
    }

    // 4. Killable 2-Man AI Mortar Crew (Gunner on left, Loader on right)
    const uniformBundle = this.getCrewUniformBundle(cfg.ownerTeam);
    const gunnerVisual = this.buildCrewVisual(cfg.pitId, 'gunner', uniformBundle);
    const loaderVisual = this.buildCrewVisual(cfg.pitId, 'loader', uniformBundle);
    turretYawGroup.add(gunnerVisual.root, loaderVisual.root);

    // 5. Sandbag Parapet Colliders (compact AABB quadrants leaving rear entrance clear)
    const colliders: THREE.Box3[] = [];
    const wallAngles = [-0.95, 0, 0.95];
    for (const relAng of wallAngles) {
      const a = cfg.zeroBearingRad + relAng;
      const wx = worldPos[0] + Math.sin(a) * radius;
      const wz = worldPos[2] - Math.cos(a) * radius;
      colliders.push(
        new THREE.Box3(
          new THREE.Vector3(wx - 0.55, worldPos[1], wz - 0.55),
          new THREE.Vector3(wx + 0.55, worldPos[1] + 0.68, wz + 0.55),
        ),
      );
    }

    const defaultElevationRad = THREE.MathUtils.degToRad(65);
    const state: MortarPitState = {
      pitId: cfg.pitId,
      ownerTeam: cfg.ownerTeam,
      sourceType: cfg.sourceType,
      sourceId: cfg.sourceId,
      position: worldPos,
      zeroBearingRad: cfg.zeroBearingRad,
      status: cfg.active ? 'ACTIVE_AI' : 'INACTIVE',
      seatedPlayerId: null,
      seatedPlayerName: null,
      seatedPlayerTeam: null,
      gunnerAiHp: 100,
      loaderAiHp: 100,
      respawnTimerSec: 0,
      reloadProgress01: 1,
      currentAzimuthRad: cfg.zeroBearingRad,
      currentElevationRad: defaultElevationRad,
      currentChargeLevel: 2,
      activeMissionId: null,
    };

    pitRoot.visible = cfg.active;

    const pit: InternalMortarPit = {
      state,
      root: pitRoot,
      turretYawGroup,
      barrelPivotGroup,
      barrelRecoilGroup,
      traverseWheel,
      elevateWheel,
      sightHousing,
      stagedShellGroup,
      chargeRingMeshes,
      muzzleTipLocal: new THREE.Vector3(0, 1.36, 0),
      muzzleFlashMesh,
      muzzleFlashTimer: 0,
      gunnerVisual,
      loaderVisual,
      colliders,
      reloadTimerSec: 0,
      reloadDurationSec: MORTAR_RELOAD_AI_LOADER_SEC,
      aiSalvoTimerSec: 12 + (this.pits.size % 3) * 6, // stagger initial salvos across theater
      aiSalvoRemaining: 0,
      aiSalvoNextRoundTimerSec: 0,
      aiSalvoTargetPos: new THREE.Vector3(),
      aiReclaimTimerSec: 0,
      crewLodAccumSec: 0,
      bubbleErrorX: 0,
      bubbleErrorY: 0,
      stakeDriftMils: 0,
      recoilKick01: 0,
      foAddDropM: 0,
      foLeftRightM: 0,
      missionCallerId: null,
      missionCallerName: '',
      missionCallerTeam: cfg.ownerTeam,
      missionTargetPos: new THREE.Vector3(),
      missionRoundsRemaining: 0,
      missionTotalRounds: MORTAR_MISSION_ROUNDS,
      missionNextRoundTimerSec: 0,
      missionDangerClose: false,
    };

    this.syncChargeRingVisuals(pit);
    this.applyTubeTransform(pit);
    return pit;
  }

  private buildCrewVisual(
    pitId: string,
    role: 'gunner' | 'loader',
    uniform: TacticalUniformMaterialBundle,
  ): CrewActorVisual {
    const root = new THREE.Group();
    const isGunner = role === 'gunner';
    // Fixed kneeling positions beside the bipod (Gunner left, Loader right)
    root.position.set(isGunner ? -0.68 : 0.68, 0, 0.24);
    root.rotation.y = isGunner ? -0.45 : 0.45;

    const legGeo = new THREE.CylinderGeometry(0.085, 0.075, 0.44, 6);
    const torsoGeo = new THREE.BoxGeometry(0.36, 0.48, 0.24);
    const vestGeo = new THREE.BoxGeometry(0.39, 0.36, 0.28);
    const headGeo = new THREE.SphereGeometry(0.12, 8, 6);
    const helmetGeo = new THREE.SphereGeometry(0.135, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
    const armGeo = new THREE.CylinderGeometry(0.055, 0.048, 0.46, 6);
    this.disposables.push(legGeo, torsoGeo, vestGeo, headGeo, helmetGeo, armGeo);

    // Kneeling legs
    const leftLeg = new THREE.Mesh(legGeo, uniform.pantsMat);
    leftLeg.position.set(-0.11, 0.22, 0.08);
    leftLeg.rotation.x = 0.65;
    const rightLeg = new THREE.Mesh(legGeo, uniform.pantsMat);
    rightLeg.position.set(0.11, 0.16, -0.06);
    rightLeg.rotation.x = -0.85;
    root.add(leftLeg, rightLeg);

    const torsoGroup = new THREE.Group();
    torsoGroup.position.set(0, 0.46, 0);
    root.add(torsoGroup);

    const torsoMesh = new THREE.Mesh(torsoGeo, uniform.sleeveMat);
    torsoMesh.position.y = 0.22;
    torsoMesh.castShadow = true;
    const vestMesh = new THREE.Mesh(vestGeo, uniform.vestMat);
    vestMesh.position.y = 0.25;

    const headMesh = new THREE.Mesh(headGeo, uniform.skinMat);
    headMesh.position.set(0, 0.56, 0.02);
    const helmetMesh = new THREE.Mesh(helmetGeo, uniform.helmetMat);
    helmetMesh.position.set(0, 0.58, 0.01);

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.22, 0.38, 0.02);
    const lArmMesh = new THREE.Mesh(armGeo, uniform.sleeveMat);
    lArmMesh.position.set(0, -0.18, -0.14);
    lArmMesh.rotation.x = 0.85;
    leftArm.add(lArmMesh);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.22, 0.38, 0.02);
    const rArmMesh = new THREE.Mesh(armGeo, uniform.sleeveMat);
    rArmMesh.position.set(0, -0.18, -0.14);
    rArmMesh.rotation.x = 0.85;
    rightArm.add(rArmMesh);

    torsoGroup.add(torsoMesh, vestMesh, headMesh, helmetMesh, leftArm, rightArm);

    // Tag raycast hitboxes with role + head/body zone for precise weapon hit registration
    const hitMeshes = [torsoMesh, vestMesh, headMesh, helmetMesh];
    for (const m of hitMeshes) {
      m.userData.mortarCrewPitId = pitId;
      m.userData.mortarCrewRole = role;
      m.userData.mortarHitZone = m === headMesh || m === helmetMesh ? 'head' : 'body';
    }

    return {
      role,
      root,
      torsoGroup,
      headMesh,
      leftArm,
      rightArm,
      hitMeshes,
      yieldBlend: 0,
      animPhase: isGunner ? 0 : 1.7,
      dead: false,
    };
  }

  private getCrewUniformBundle(team: 'A' | 'B'): TacticalUniformMaterialBundle {
    if (typeof document !== 'undefined') {
      return this.uniformLib.getBundle(team === 'A' ? 'team_a' : 'team_b');
    }
    const baseColor = team === 'A' ? 0x4b5c42 : 0x5c4a3e;
    const mat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.88, metalness: 0.05 });
    const basicMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.disposables.push(mat, basicMat);
    return {
      id: team === 'A' ? 'team_a' : 'team_b',
      sleeveMat: mat,
      pantsMat: mat,
      vestMat: this.matOliveCrate,
      pouchMat: this.matOliveCrate,
      gloveMat: this.matSteelDark,
      bootMat: this.matSteelDark,
      soleMat: this.matSteelDark,
      knuckleMat: this.matSteelDark,
      hardwareMat: this.matSteelGunmetal,
      helmetMat: this.matSteelDark,
      hoodMat: this.matSteelDark,
      skinMat: this.matSandbag,
      visorMat: this.matSteelGunmetal,
      iffTrimMat: this.matBrass,
      gunMat: this.matSteelDark,
      gunAccentMat: this.matSteelGunmetal,
      flashMat: basicMat,
      laserMat: basicMat,
      lightGlowMat: basicMat,
      dispose: () => {},
    };
  }

  private applyCrewUniforms(pit: InternalMortarPit, team: 'A' | 'B'): void {
    const bundle = this.getCrewUniformBundle(team);
    const applyTo = (vis: CrewActorVisual) => {
      vis.root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.userData.mortarHitZone === 'head') {
          mesh.material = mesh === vis.headMesh ? bundle.skinMat : bundle.helmetMat;
        } else {
          mesh.material = bundle.vestMat;
        }
      });
    };
    applyTo(pit.gunnerVisual);
    applyTo(pit.loaderVisual);
  }

  private resetCrewVisualsAlive(pit: InternalMortarPit): void {
    pit.gunnerVisual.dead = false;
    pit.gunnerVisual.root.visible = true;
    pit.loaderVisual.dead = false;
    pit.loaderVisual.root.visible = true;
  }

  private createShellMesh(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.geoShellBody, this.matShellOlive);
    const nose = new THREE.Mesh(this.geoShellNose, this.matBrass);
    nose.position.y = 0.195;
    const finA = new THREE.Mesh(this.geoShellFin, this.matSteelDark);
    finA.position.y = -0.145;
    const finB = new THREE.Mesh(this.geoShellFin, this.matSteelDark);
    finB.position.y = -0.145;
    finB.rotation.y = Math.PI * 0.5;
    g.add(body, nose, finA, finB);
    return g;
  }

  private syncChargeRingVisuals(pit: InternalMortarPit): void {
    const lvl = pit.state.currentChargeLevel;
    for (let i = 0; i < pit.chargeRingMeshes.length; i++) {
      pit.chargeRingMeshes[i].visible = i < lvl;
    }
  }

  private applyTubeTransform(pit: InternalMortarPit): void {
    pit.turretYawGroup.rotation.y = -pit.state.currentAzimuthRad;
    // Barrel local +Y is vertical (90° elevation), tilting toward -Z as elevation decreases toward 45°
    const tiltFromVertical = Math.PI * 0.5 - pit.state.currentElevationRad;
    pit.barrelPivotGroup.rotation.x = -tiltFromVertical;
  }

  private computeReloadDurationSec(pit: InternalMortarPit): number {
    if (pit.state.seatedPlayerId) {
      const friendlyLoaderAlive =
        pit.state.ownerTeam === pit.state.seatedPlayerTeam && pit.state.loaderAiHp > 0;
      return friendlyLoaderAlive ? MORTAR_RELOAD_AI_LOADER_SEC : MORTAR_RELOAD_SOLO_SEC;
    }
    return pit.state.loaderAiHp > 0 ? MORTAR_RELOAD_AI_LOADER_SEC : MORTAR_RELOAD_SOLO_SEC;
  }

  private updateCrewAnimations(pit: InternalMortarPit, dt: number): void {
    const gunner = pit.gunnerVisual;
    const loader = pit.loaderVisual;

    // Friendly AI Gunner yields cleanly via 1.1m lateral step when player is seated
    const shouldYield = Boolean(pit.state.seatedPlayerId) || pit.aiReclaimTimerSec > 0;
    gunner.yieldBlend = THREE.MathUtils.damp(gunner.yieldBlend, shouldYield ? 1 : 0, 7.5, dt);

    if (!gunner.dead) {
      gunner.animPhase = (gunner.animPhase + dt * 2.1) % (Math.PI * 2);
      const lateralStep = gunner.yieldBlend * 1.1;
      gunner.root.position.set(-0.68 - lateralStep, 0, 0.24 + gunner.yieldBlend * 0.22);
      gunner.torsoGroup.rotation.x = 0.08 + Math.sin(gunner.animPhase) * 0.03;
      gunner.rightArm.rotation.x = shouldYield ? -0.25 : Math.sin(gunner.animPhase * 1.6) * 0.14;
    }

    if (!loader.dead) {
      loader.animPhase = (loader.animPhase + dt * 2.6) % (Math.PI * 2);
      const reloadLift =
        pit.reloadTimerSec > 0 ? Math.sin(pit.state.reloadProgress01 * Math.PI) * 0.65 : 0;
      loader.torsoGroup.rotation.x = 0.1 + reloadLift * 0.28 + Math.sin(loader.animPhase) * 0.025;
      loader.leftArm.rotation.x = -reloadLift * 0.9;
      loader.rightArm.rotation.x = -reloadLift * 0.9;
    }
  }

  private abortPitFireMission(
    pit: InternalMortarPit,
    reason: 'aborted_takeover' | 'aborted_crew_kia' | 'fob_flip',
    refundCooldown: boolean,
  ): number {
    const missionId = pit.state.activeMissionId;
    const team = pit.missionCallerTeam;
    const teamState = this.teamStates[team];

    let refundedSec = 0;
    if (refundCooldown) {
      refundedSec = MORTAR_SWEEP_COOLDOWN_SEC * MORTAR_KIA_COOLDOWN_REFUND_RATIO;
      teamState.mortarStrikeCooldownSec = Math.max(0, teamState.mortarStrikeCooldownSec - refundedSec);
    }

    if (teamState.activeMortarMissionId === missionId) {
      teamState.activeMortarMissionId = null;
    }
    pit.state.activeMissionId = null;
    pit.missionRoundsRemaining = 0;
    pit.missionNextRoundTimerSec = 0;

    if (missionId && (reason === 'aborted_takeover' || reason === 'aborted_crew_kia')) {
      this.onMissionEvent?.({
        kind: reason,
        missionId,
        pitId: pit.state.pitId,
        team,
        callerName: pit.missionCallerName,
        targetX: pit.missionTargetPos.x,
        targetZ: pit.missionTargetPos.z,
        refundedCooldownSec: refundedSec,
        dangerClose: pit.missionDangerClose,
      });
    }
    pit.missionCallerId = null;
    return refundedSec;
  }

  private updateActiveFireMission(
    pit: InternalMortarPit,
    dt: number,
    exclusionZones: readonly MortarExclusionZone[],
  ): void {
    if (pit.missionRoundsRemaining <= 0 || !pit.state.activeMissionId) {
      const mid = pit.state.activeMissionId;
      const teamState = this.teamStates[pit.missionCallerTeam];
      if (mid && teamState.activeMortarMissionId === mid) {
        teamState.activeMortarMissionId = null;
      }
      pit.state.activeMissionId = null;
      pit.state.status = 'ACTIVE_AI';
      return;
    }

    pit.missionNextRoundTimerSec -= dt;
    if (pit.missionNextRoundTimerSec > 0) return;

    const origin = _vA.set(pit.state.position[0], pit.state.position[1] + 1.15, pit.state.position[2]);
    // Sample tight 18m CEP scatter while staying outside both teams' 65m HQ exclusion cylinders
    let aimX = pit.missionTargetPos.x;
    let aimZ = pit.missionTargetPos.z;
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = Math.sqrt(Math.random()) * MORTAR_MISSION_CEP_M;
      const theta = Math.random() * Math.PI * 2;
      const cx = pit.missionTargetPos.x + Math.cos(theta) * r;
      const cz = pit.missionTargetPos.z + Math.sin(theta) * r;
      if (!this.isInsideHqExclusion(cx, cz, exclusionZones)) {
        aimX = cx;
        aimZ = cz;
        break;
      }
    }
    const scattered = _vB.set(aimX, this.getGroundHeight(aimX, aimZ), aimZ);
    const table = solveMortarFiringTable(origin, scattered, this.windX, this.windZ);
    if (table.recommended?.inRange) {
      pit.state.currentAzimuthRad = table.recommended.azimuthRad;
      pit.state.currentElevationRad = table.recommended.elevationRad;
      pit.state.currentChargeLevel = table.recommended.charge;
      this.syncChargeRingVisuals(pit);
      this.applyTubeTransform(pit);
      this.launchMortarShell(
        pit,
        pit.missionCallerId ?? `ai_mortar_${pit.state.pitId}`,
        pit.missionCallerTeam,
        false,
        table.recommended.azimuthRad,
        table.recommended.elevationRad,
        table.recommended.charge,
      );
      pit.recoilKick01 = 0.85;
      pit.reloadDurationSec = MORTAR_MISSION_CADENCE_SEC;
      pit.reloadTimerSec = MORTAR_MISSION_CADENCE_SEC;
      pit.state.reloadProgress01 = 0;
    }

    pit.missionRoundsRemaining--;
    if (pit.missionRoundsRemaining <= 0) {
      const missionId = pit.state.activeMissionId;
      const teamState = this.teamStates[pit.missionCallerTeam];
      if (teamState.activeMortarMissionId === missionId) {
        teamState.activeMortarMissionId = null;
      }
      pit.state.activeMissionId = null;
      pit.state.status = 'ACTIVE_AI';
      pit.missionCallerId = null;
      this.onMissionEvent?.({
        kind: 'completed',
        missionId,
        pitId: pit.state.pitId,
        team: pit.missionCallerTeam,
        callerName: pit.missionCallerName,
        targetX: pit.missionTargetPos.x,
        targetZ: pit.missionTargetPos.z,
        refundedCooldownSec: 0,
        dangerClose: pit.missionDangerClose,
      });
    } else {
      pit.missionNextRoundTimerSec = MORTAR_MISSION_CADENCE_SEC;
    }
  }

  private updateAutonomousAiSalvo(
    pit: InternalMortarPit,
    dt: number,
    targets: readonly MortarTargetCandidate[],
    exclusionZones: readonly MortarExclusionZone[],
  ): void {
    // Continue in-progress 3-round salvo
    if (pit.aiSalvoRemaining > 0) {
      pit.aiSalvoNextRoundTimerSec -= dt;
      if (pit.aiSalvoNextRoundTimerSec <= 0 && pit.reloadTimerSec <= 0.001) {
        const origin = _vA.set(pit.state.position[0], pit.state.position[1] + 1.15, pit.state.position[2]);
        // Apply 32m CEP circular scatter around chosen enemy cluster
        const r = Math.sqrt(Math.random()) * MORTAR_AI_CEP_M;
        const theta = Math.random() * Math.PI * 2;
        const scattered = _vB.set(
          pit.aiSalvoTargetPos.x + Math.cos(theta) * r,
          this.getGroundHeight(
            pit.aiSalvoTargetPos.x + Math.cos(theta) * r,
            pit.aiSalvoTargetPos.z + Math.sin(theta) * r,
          ),
          pit.aiSalvoTargetPos.z + Math.sin(theta) * r,
        );

        // Enforce 65m HQ no-fire exclusion even after scatter
        if (!this.isInsideHqExclusion(scattered.x, scattered.z, exclusionZones)) {
          const table = solveMortarFiringTable(origin, scattered, this.windX, this.windZ);
          if (table.recommended) {
            pit.state.currentAzimuthRad = table.recommended.azimuthRad;
            pit.state.currentElevationRad = table.recommended.elevationRad;
            pit.state.currentChargeLevel = table.recommended.charge;
            this.syncChargeRingVisuals(pit);
            this.applyTubeTransform(pit);
            this.launchMortarShell(
              pit,
              `ai_mortar_${pit.state.pitId}`,
              pit.state.ownerTeam,
              false,
              table.recommended.azimuthRad,
              table.recommended.elevationRad,
              table.recommended.charge,
            );
            pit.reloadDurationSec = this.computeReloadDurationSec(pit);
            pit.reloadTimerSec = pit.reloadDurationSec;
            pit.state.reloadProgress01 = 0;
          }
        }
        pit.aiSalvoRemaining--;
        pit.aiSalvoNextRoundTimerSec = 2.75;
      }
      return;
    }

    pit.aiSalvoTimerSec -= dt;
    if (pit.aiSalvoTimerSec > 0) return;
    pit.aiSalvoTimerSec = MORTAR_AI_SALVO_INTERVAL_SEC;

    // Pick a valid enemy target cluster > 80m from friendly flags & outside either 65m HQ exclusion cylinder
    const chosen = this.selectAutonomousAiTarget(pit, targets, exclusionZones);
    if (!chosen) return;

    pit.aiSalvoTargetPos.copy(chosen);
    pit.aiSalvoRemaining = MORTAR_AI_SALVO_ROUNDS;
    pit.aiSalvoNextRoundTimerSec = 0.25;
  }

  public isInsideHqExclusion(
    x: number,
    z: number,
    exclusionZones: readonly MortarExclusionZone[],
  ): boolean {
    for (let i = 0; i < exclusionZones.length; i++) {
      const zZone = exclusionZones[i];
      if (zZone.kind !== 'hq') continue;
      const d = Math.hypot(x - zZone.x, z - zZone.z);
      if (d <= Math.max(MORTAR_HQ_EXCLUSION_RADIUS_M, zZone.radiusM)) {
        return true;
      }
    }
    return false;
  }

  public selectAutonomousAiTarget(
    pitOrId: InternalMortarPit | string,
    targets: readonly MortarTargetCandidate[],
    exclusionZones: readonly MortarExclusionZone[],
  ): THREE.Vector3 | null {
    const pit = typeof pitOrId === 'string' ? this.pits.get(pitOrId) : pitOrId;
    if (!pit) return null;
    const enemyTeam = pit.state.ownerTeam === 'A' ? 'B' : 'A';
    const px = pit.state.position[0];
    const pz = pit.state.position[2];

    let bestTarget: THREE.Vector3 | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t.alive || t.team !== enemyTeam) continue;
      const dist = Math.hypot(t.x - px, t.z - pz);
      if (dist < 42 || dist > 680) continue;

      // Never fire inside either team's 65m HQ exclusion cylinder
      if (this.isInsideHqExclusion(t.x, t.z, exclusionZones)) continue;

      // Autonomous AI mortars only fire > 80m from friendly flags
      let tooCloseToFriendlyFlag = false;
      for (let j = 0; j < exclusionZones.length; j++) {
        const zZone = exclusionZones[j];
        if (zZone.kind === 'flag' && zZone.team === pit.state.ownerTeam) {
          if (Math.hypot(t.x - zZone.x, t.z - zZone.z) < MORTAR_FRIENDLY_FLAG_MIN_DIST_M) {
            tooCloseToFriendlyFlag = true;
            break;
          }
        }
      }
      if (tooCloseToFriendlyFlag) continue;

      // Prefer enemy clusters (count nearby enemies within 24m)
      let clusterCount = 1;
      for (let k = 0; k < targets.length; k++) {
        if (k === i) continue;
        const other = targets[k];
        if (other.alive && other.team === enemyTeam && Math.hypot(other.x - t.x, other.z - t.z) <= 24) {
          clusterCount++;
        }
      }

      const score = clusterCount * 100 - Math.abs(dist - 160) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = new THREE.Vector3(t.x, t.y, t.z);
      }
    }

    return bestTarget;
  }

  private launchMortarShell(
    pit: InternalMortarPit,
    callerId: string,
    callerTeam: 'A' | 'B',
    isPlayerManned: boolean,
    azimuthRad: number,
    elevationRad: number,
    chargeLevel: MortarChargeLevel,
  ): GameMortarLaunchPacket | null {
    const origin = new THREE.Vector3(
      pit.state.position[0] + Math.sin(azimuthRad) * 0.25,
      pit.state.position[1] + 1.28,
      pit.state.position[2] - Math.cos(azimuthRad) * 0.25,
    );

    const sim = simulateMortarImpact(
      origin,
      azimuthRad,
      elevationRad,
      chargeLevel,
      this.windX,
      this.windZ,
      this.getGroundHeight,
    );

    const shellId = `ms_${pit.state.pitId}_${this.shellSeq++}`;
    this.spawnPooledShell({
      shellId,
      pitId: pit.state.pitId,
      callerId,
      callerTeam,
      isPlayerManned,
      origin,
      vel: sim.initialVelocity,
      impactPos: sim.impactPos,
      flightTimeSec: sim.flightTimeSec,
    });

    this.triggerMuzzleFlash(pit);
    if (isPlayerManned) {
      this.audio?.playMortarShellDrop(origin);
    }
    this.audio?.playMortarLaunch(origin, isPlayerManned);

    const packet: GameMortarLaunchPacket = {
      type: 'game:mortar_launch',
      shellId,
      pitId: pit.state.pitId,
      callerId,
      callerTeam,
      isPlayerManned,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      azimuthRad,
      elevationRad,
      chargeLevel,
      ix: sim.impactPos.x,
      iy: sim.impactPos.y,
      iz: sim.impactPos.z,
      flightTimeSec: sim.flightTimeSec,
      ts: Date.now(),
    };
    this.onLaunchBroadcast?.(packet);
    return packet;
  }

  private triggerMuzzleFlash(pit: InternalMortarPit): void {
    pit.muzzleFlashTimer = 0.11;
    pit.muzzleFlashMesh.visible = true;
  }

  private spawnPooledShell(opts: {
    shellId: string;
    pitId: string;
    callerId: string;
    callerTeam: 'A' | 'B';
    isPlayerManned: boolean;
    origin: Readonly<THREE.Vector3>;
    vel: Readonly<THREE.Vector3>;
    impactPos: Readonly<THREE.Vector3>;
    flightTimeSec: number;
  }): void {
    // Pick inactive slot or overwrite oldest active shell (hard cap = 16)
    let slot: PooledMortarShell | null = null;
    let oldestElapsed = -1;
    for (let i = 0; i < this.shellPool.length; i++) {
      const s = this.shellPool[i];
      if (!s.active) {
        slot = s;
        break;
      }
      if (s.elapsedSec > oldestElapsed) {
        oldestElapsed = s.elapsedSec;
        slot = s;
      }
    }
    if (!slot) return;

    slot.active = true;
    slot.shellId = opts.shellId;
    slot.pitId = opts.pitId;
    slot.callerId = opts.callerId;
    slot.callerTeam = opts.callerTeam;
    slot.isPlayerManned = opts.isPlayerManned;
    slot.origin.copy(opts.origin);
    slot.vel.copy(opts.vel);
    slot.windX = this.windX;
    slot.windZ = this.windZ;
    slot.impactPos.copy(opts.impactPos);
    slot.elapsedSec = 0;
    slot.flightTimeSec = Math.max(0.5, opts.flightTimeSec);
    slot.whistleTriggered = false;
    slot.mesh.position.copy(opts.origin);
    slot.mesh.visible = true;
  }

  private updateActiveShells(dt: number): void {
    for (let i = 0; i < this.shellPool.length; i++) {
      const shell = this.shellPool[i];
      if (!shell.active) continue;

      shell.elapsedSec += dt;
      const remaining = shell.flightTimeSec - shell.elapsedSec;

      // Trigger incoming descending whistle ~1.5s before detonation
      if (!shell.whistleTriggered && remaining <= 1.55) {
        shell.whistleTriggered = true;
        this.audio?.playMortarWhistle(shell.impactPos, Math.max(0.55, remaining));
      }

      if (shell.elapsedSec >= shell.flightTimeSec) {
        shell.active = false;
        shell.mesh.visible = false;
        this.detonateShell(shell);
        continue;
      }

      // Position & nose-tangent orientation along exact deterministic arc
      sampleMortarArcPosition(
        shell.origin.x,
        shell.origin.y,
        shell.origin.z,
        shell.vel.x,
        shell.vel.y,
        shell.vel.z,
        shell.windX,
        shell.windZ,
        shell.elapsedSec,
        _vA,
      );
      sampleMortarArcPosition(
        shell.origin.x,
        shell.origin.y,
        shell.origin.z,
        shell.vel.x,
        shell.vel.y,
        shell.vel.z,
        shell.windX,
        shell.windZ,
        shell.elapsedSec + 0.04,
        _vB,
      );

      shell.mesh.position.copy(_vA);
      _vC.subVectors(_vB, _vA).normalize();
      if (_vC.lengthSq() > 0.001) {
        shell.mesh.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, _vC);
      }
    }
  }

  private detonateShell(shell: PooledMortarShell): void {
    const pos = shell.impactPos.clone();
    pos.y = this.getGroundHeight(pos.x, pos.z);

    // 1. Place FIFO pooled scorch crater decal (max 24, ring-buffer overwrite)
    const decal = this.scorchDecals[this.scorchFifoIndex];
    this.scorchFifoIndex = (this.scorchFifoIndex + 1) % MAX_SCORCH_DECAL_POOL;
    decal.position.set(pos.x, pos.y + 0.045, pos.z);
    decal.rotation.y = (this.scorchFifoIndex * 2.399) % (Math.PI * 2);
    decal.visible = true;

    // 2. Spawn pooled explosion plume/flash/ring VFX
    let vfx = this.blastVfxPool[0];
    for (let i = 0; i < this.blastVfxPool.length; i++) {
      if (!this.blastVfxPool[i].active) {
        vfx = this.blastVfxPool[i];
        break;
      }
    }
    vfx.active = true;
    vfx.timerSec = 0;
    vfx.durationSec = 1.55;
    vfx.pos.copy(pos);
    vfx.plumeMesh.position.set(pos.x, pos.y + 0.6, pos.z);
    vfx.flashMesh.position.set(pos.x, pos.y + 0.7, pos.z);
    vfx.ringMesh.position.set(pos.x, pos.y + 0.12, pos.z);
    vfx.plumeMesh.visible = true;
    vfx.flashMesh.visible = true;
    vfx.ringMesh.visible = true;

    // 3. Re-center single pooled dynamic explosion PointLight
    this.blastLight.position.set(pos.x, pos.y + 2.6, pos.z);
    this.blastLight.intensity = 18;
    this.blastLight.visible = true;
    this.blastLightTimerSec = 0.34;

    // 4. Priority-pooled 81mm overpressure detonation audio
    this.audio?.playMortarExplosion(pos);

    // 5. Notify combat engine to apply 100% enemy / 100% caller self / 25% teammate splash + breakables
    this.onImpact?.({
      shellId: shell.shellId,
      pitId: shell.pitId,
      callerId: shell.callerId,
      callerTeam: shell.callerTeam,
      isPlayerManned: shell.isPlayerManned,
      position: pos,
      blastRadiusM: MORTAR_BLAST_RADIUS_M,
      maxDamage: MORTAR_BLAST_MAX_DAMAGE,
    });
  }

  private updateBlastVfx(dt: number): void {
    if (this.blastLightTimerSec > 0) {
      this.blastLightTimerSec = Math.max(0, this.blastLightTimerSec - dt);
      const frac = this.blastLightTimerSec / 0.34;
      this.blastLight.intensity = 18 * frac * frac;
      if (this.blastLightTimerSec <= 0) {
        this.blastLight.visible = false;
      }
    }

    for (let i = 0; i < this.blastVfxPool.length; i++) {
      const v = this.blastVfxPool[i];
      if (!v.active) continue;
      v.timerSec += dt;
      const t = v.timerSec / v.durationSec;
      if (t >= 1) {
        v.active = false;
        v.plumeMesh.visible = false;
        v.flashMesh.visible = false;
        v.ringMesh.visible = false;
        continue;
      }

      const plumeScale = 1.2 + t * 5.2;
      v.plumeMesh.scale.set(plumeScale * 0.85, plumeScale * 1.15, plumeScale * 0.85);
      v.plumeMesh.position.y = v.pos.y + 0.6 + t * 4.4;
      (v.plumeMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t) * 0.62);

      const flashT = Math.min(1, t * 4.5);
      v.flashMesh.scale.setScalar(1.1 + flashT * 3.2);
      (v.flashMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - flashT) * 0.92);
      v.flashMesh.visible = flashT < 1;

      const ringT = Math.min(1, t * 2.2);
      v.ringMesh.scale.setScalar(1.0 + ringT * 8.2);
      (v.ringMesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - ringT) * 0.45);
      v.ringMesh.visible = ringT < 1;
    }
  }
}

/**
 * Helper to compute exact blast damage multiplier per spec:
 *  - 100% enemy
 *  - 100% original caller self-damage anywhere in blast radius
 *  - 25% other teammate splash (+ suppression flinch)
 */
export function computeMortarBlastDamageForActor(opts: {
  distanceM: number;
  blastRadiusM: number;
  maxDamage: number;
  actorId: string;
  actorTeam: 'A' | 'B' | 'FFA';
  callerId: string;
  callerTeam: 'A' | 'B';
}): { damage: number; suppression01: number; isFriendlySplash: boolean } {
  if (opts.distanceM >= opts.blastRadiusM) {
    return { damage: 0, suppression01: 0, isFriendlySplash: false };
  }
  const falloff = THREE.MathUtils.clamp(1 - opts.distanceM / opts.blastRadiusM, 0, 1);
  // Steep lethal inner core (0..4.5m -> high damage), smooth shrapnel outer skirt
  const baseDamage = opts.maxDamage * Math.pow(falloff, 1.35);
  const isSelf = opts.actorId === opts.callerId;
  const isTeammate = !isSelf && opts.actorTeam === opts.callerTeam;
  const mult = isSelf ? 1.0 : isTeammate ? 0.25 : 1.0;

  return {
    damage: Math.round(baseDamage * mult),
    suppression01: THREE.MathUtils.clamp(falloff * 1.15, 0, 1),
    isFriendlySplash: isTeammate,
  };
}

/**
 * Evaluates whether a mortar target coordinate falls within Danger Close radius (default 45m)
 * of any friendly operator or allied bot.
 */
export function evaluateMortarDangerClose(
  targetX: number,
  targetZ: number,
  friendlyPositions: readonly MortarFriendlyPosition[],
  radiusM = MORTAR_DANGER_CLOSE_RADIUS_M,
): { dangerClose: boolean; minFriendlyDistM: number; friendliesInZone: number } {
  let minFriendlyDistM = Infinity;
  let friendliesInZone = 0;
  for (let i = 0; i < friendlyPositions.length; i++) {
    const f = friendlyPositions[i];
    const d = Math.hypot(f.x - targetX, f.z - targetZ);
    if (d < minFriendlyDistM) minFriendlyDistM = d;
    if (d <= radiusM) friendliesInZone++;
  }
  return {
    dangerClose: friendliesInZone > 0,
    minFriendlyDistM: Number.isFinite(minFriendlyDistM) ? minFriendlyDistM : Infinity,
    friendliesInZone,
  };
}

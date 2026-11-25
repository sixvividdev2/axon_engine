import * as THREE from 'three';
import { BodycamAudio } from '../bodycam-sdk/BodycamAudio';
import {
  ActiveMortarMissionSummary,
  ENABLE_CONQUEST_FIRE_SUPPORT,
  GameFireSupportSyncPacket,
  GameMortarLaunchPacket,
  MortarPitState,
  TeamFireSupportState,
} from '../data/multiplayer';
import {
  MORTAR_CHARGE_SPECS,
  MORTAR_MAX_ELEVATION_RAD,
  MORTAR_MIN_ELEVATION_RAD,
  MortarChargeLevel,
  RAD_TO_MILS,
  radiansToNatoMils,
  sampleMortarArcPosition,
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
  callerName?: string;
  callerTeam: 'A' | 'B';
  isPlayerManned: boolean;
  weaponKind?: 'mortar_81mm' | 'bomber_air_strike';
  weaponName?: string;
  position: THREE.Vector3;
  blastRadiusM: number;
  maxDamage: number;
}

export interface ExternalOrdnanceSpawnOptions {
  shellId: string;
  sourceId: string;
  callerId: string;
  callerName?: string;
  callerTeam: 'A' | 'B';
  weaponKind: 'mortar_81mm' | 'bomber_air_strike';
  weaponName: string;
  origin: Readonly<THREE.Vector3>;
  vel: Readonly<THREE.Vector3>;
  impactPos: Readonly<THREE.Vector3>;
  flightTimeSec: number;
  blastRadiusM: number;
  maxDamage: number;
  scaleMult?: number;
  windAffected?: boolean;
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
  slotIndex: number;
  state: MortarPitState;
  root: THREE.Group;
  turretYawGroup: THREE.Group;
  barrelPivotGroup: THREE.Group;
  barrelRecoilGroup: THREE.Group;
  traverseWheelAngle: number;
  elevateWheelAngle: number;
  stagedShellVisible: boolean;
  muzzleTipLocal: THREE.Vector3;
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
  slotIndex: number;
  active: boolean;
  shellId: string;
  pitId: string;
  callerId: string;
  callerName: string;
  callerTeam: 'A' | 'B';
  isPlayerManned: boolean;
  weaponKind: 'mortar_81mm' | 'bomber_air_strike';
  weaponName: string;
  blastRadiusM: number;
  maxDamage: number;
  scaleMult: number;
  origin: THREE.Vector3;
  vel: THREE.Vector3;
  windX: number;
  windZ: number;
  impactPos: THREE.Vector3;
  elapsedSec: number;
  flightTimeSec: number;
  whistleTriggered: boolean;
}

interface PooledBlastVfx {
  slotIndex: number;
  active: boolean;
  timerSec: number;
  durationSec: number;
  scaleBoost: number;
  pos: THREE.Vector3;
}

interface ColoredGeometryPart {
  geo: THREE.BufferGeometry;
  color: number;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
}

// Reusable zero-GC scratch math objects
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _mat4B = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Merges multiple BufferGeometry primitives into a single vertex-colored non-indexed BufferGeometry
 * so complex composite military props render in 1 GPU draw call with exact part shading.
 */
function mergeColoredParts(parts: readonly ColoredGeometryPart[]): THREE.BufferGeometry {
  let totalVerts = 0;
  const prepared: Array<{ geo: THREE.BufferGeometry; color: THREE.Color }> = [];
  const tmpMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpEuler = new THREE.Euler();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const cloned = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.pos || p.rot || p.scale) {
      tmpPos.set(p.pos?.[0] ?? 0, p.pos?.[1] ?? 0, p.pos?.[2] ?? 0);
      tmpEuler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
      tmpQuat.setFromEuler(tmpEuler);
      tmpScale.set(p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.scale?.[2] ?? 1);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);
      cloned.applyMatrix4(tmpMat);
    }
    if (!cloned.getAttribute('normal')) {
      cloned.computeVertexNormals();
    }
    const posAttr = cloned.getAttribute('position');
    totalVerts += posAttr.count;
    prepared.push({ geo: cloned, color: new THREE.Color(p.color) });
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);

  let offset = 0;
  for (let i = 0; i < prepared.length; i++) {
    const { geo, color } = prepared[i];
    const posAttr = geo.getAttribute('position');
    const normAttr = geo.getAttribute('normal');
    const count = posAttr.count;
    for (let v = 0; v < count; v++) {
      const idx = (offset + v) * 3;
      positions[idx] = posAttr.getX(v);
      positions[idx + 1] = posAttr.getY(v);
      positions[idx + 2] = posAttr.getZ(v);
      normals[idx] = normAttr.getX(v);
      normals[idx + 1] = normAttr.getY(v);
      normals[idx + 2] = normAttr.getZ(v);
      colors[idx] = color.r;
      colors[idx + 1] = color.g;
      colors[idx + 2] = color.b;
    }
    offset += count;
    geo.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

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

  private readonly disposables: Array<{ dispose: () => void }> = [];

  // Shared materials & instanced GPU batches (strict RX 480 <=28 draw-call & <=18,000 tri budget)
  private readonly matSandbag: THREE.MeshStandardMaterial;
  private readonly matSteelDark: THREE.MeshStandardMaterial;
  private readonly matCompositeMetal: THREE.MeshStandardMaterial;
  private readonly matOliveCrate: THREE.MeshStandardMaterial;
  private readonly matVertexMatte: THREE.MeshStandardMaterial;
  private readonly matFlash: THREE.MeshBasicMaterial;
  private readonly matScorchDecal: THREE.MeshBasicMaterial;
  private readonly matBlastPlume: THREE.MeshBasicMaterial;
  private readonly matBlastFlash: THREE.MeshBasicMaterial;
  private readonly matBlastRing: THREE.MeshBasicMaterial;
  private readonly matCrewBody: THREE.MeshStandardMaterial;
  private readonly matCrewHead: THREE.MeshStandardMaterial;
  private readonly matHitboxInvisible: THREE.MeshBasicMaterial;

  private readonly geoSandbag: THREE.BoxGeometry;
  private readonly geoMergedShell: THREE.BufferGeometry;
  private readonly geoScorchPlane: THREE.PlaneGeometry;
  private readonly geoHitTorso: THREE.BoxGeometry;
  private readonly geoHitHead: THREE.SphereGeometry;

  // Batched InstancedMesh pools for all 6 pits (10 draw calls total across all 6 pits!)
  private readonly sandbagInst: THREE.InstancedMesh;
  private readonly baseplateInst: THREE.InstancedMesh;
  private readonly crateInst: THREE.InstancedMesh;
  private readonly stakeInst: THREE.InstancedMesh;
  private readonly bipodTurretInst: THREE.InstancedMesh;
  private readonly barrelInst: THREE.InstancedMesh;
  private readonly muzzleFlashInst: THREE.InstancedMesh;
  private readonly stagedShellInst: THREE.InstancedMesh;
  private readonly crewBodyInst: THREE.InstancedMesh;
  private readonly crewHeadInst: THREE.InstancedMesh;

  // Batched InstancedMesh pools for shared ordnance, scorch craters & blast VFX (5 draw calls!)
  private readonly shellInst: THREE.InstancedMesh;
  private readonly scorchInst: THREE.InstancedMesh;
  private readonly blastPlumeInst: THREE.InstancedMesh;
  private readonly blastFlashInst: THREE.InstancedMesh;
  private readonly blastRingInst: THREE.InstancedMesh;
  private scorchUsedCount = 0;

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
      activeStrike: false,
      callerPlayerId: null,
      activeStrikeId: null,
    },
    B: {
      team: 'B',
      airStrikeCooldownSec: 0,
      airStrikeMaxCooldownSec: MORTAR_AIR_STRIKE_MAX_COOLDOWN_SEC,
      mortarStrikeCooldownSec: 0,
      mortarStrikeMaxCooldownSec: MORTAR_SWEEP_COOLDOWN_SEC,
      activeBomberId: null,
      activeMortarMissionId: null,
      activeStrike: false,
      callerPlayerId: null,
      activeStrikeId: null,
    },
  };
  private remoteActiveMissions: ActiveMortarMissionSummary[] = [];
  private readonly shellPool: PooledMortarShell[] = [];
  private scorchFifoIndex = 0;
  private readonly blastVfxPool: PooledBlastVfx[] = [];
  private readonly blastLight: THREE.PointLight;
  private blastLightTimerSec = 0;
  private externalAirStrikeStateManaged = false;

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
    this.matCompositeMetal = track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.46,
        metalness: 0.76,
      }),
    );
    this.matOliveCrate = track(
      new THREE.MeshStandardMaterial({
        color: 0x454f34,
        roughness: 0.86,
        metalness: 0.08,
      }),
    );
    this.matVertexMatte = track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.62,
        metalness: 0.24,
      }),
    );
    this.matCrewBody = track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.06,
      }),
    );
    this.matCrewHead = track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.72,
        metalness: 0.14,
      }),
    );
    this.matHitboxInvisible = track(
      new THREE.MeshBasicMaterial({
        visible: false,
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
    this.matBlastPlume = track(
      new THREE.MeshBasicMaterial({
        color: 0x3b352d,
        transparent: true,
        opacity: 0.56,
        depthWrite: false,
      }),
    );
    this.matBlastFlash = track(
      new THREE.MeshBasicMaterial({
        color: 0xffb84d,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      }),
    );
    this.matBlastRing = track(
      new THREE.MeshBasicMaterial({
        color: 0xd6bfa2,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );

    // Core pit & ordnance geometries
    this.geoSandbag = track(new THREE.BoxGeometry(0.58, 0.24, 0.30));
    this.geoScorchPlane = track(new THREE.PlaneGeometry(5.6, 5.6));
    this.geoScorchPlane.rotateX(-Math.PI * 0.5);
    this.geoHitTorso = track(new THREE.BoxGeometry(0.42, 0.52, 0.30));
    this.geoHitHead = track(new THREE.SphereGeometry(0.14, 6, 5));

    // Merged composite falling shell / aerial bomb geometry (<= 88 tris per instance!)
    const rawShellBody = new THREE.CylinderGeometry(0.041, 0.036, 0.28, 8);
    const rawShellNose = new THREE.ConeGeometry(0.041, 0.11, 8);
    const rawShellFin = new THREE.BoxGeometry(0.095, 0.085, 0.008);
    this.geoMergedShell = track(
      mergeColoredParts([
        { geo: rawShellBody, color: 0x4b5836 },
        { geo: rawShellNose, color: 0xc29b48, pos: [0, 0.195, 0] },
        { geo: rawShellFin, color: 0x2a2f33, pos: [0, -0.145, 0] },
        { geo: rawShellFin, color: 0x2a2f33, pos: [0, -0.145, 0], rot: [0, Math.PI * 0.5, 0] },
      ]),
    );
    rawShellBody.dispose();
    rawShellNose.dispose();
    rawShellFin.dispose();

    // Build shared composite geometries for batched 6-pit rendering
    const geoBaseplate = track(new THREE.CylinderGeometry(0.46, 0.52, 0.09, 12));
    const geoCrate = track(new THREE.BoxGeometry(0.64, 0.28, 0.34));

    const rawStakePole = new THREE.CylinderGeometry(0.018, 0.018, 1.35, 6);
    const rawStakeBand = new THREE.CylinderGeometry(0.021, 0.021, 0.22, 6);
    const geoMergedStake = track(
      mergeColoredParts([
        { geo: rawStakePole, color: 0xf1f3f5, pos: [0, 0.675, 0] },
        { geo: rawStakeBand, color: 0xd93829, pos: [0, 1.15, 0] },
        { geo: rawStakeBand, color: 0xd93829, pos: [0, 0.72, 0] },
      ]),
    );
    rawStakePole.dispose();
    rawStakeBand.dispose();

    const rawLeg = new THREE.CylinderGeometry(0.024, 0.028, 1.08, 6);
    const rawScrew = new THREE.CylinderGeometry(0.02, 0.02, 0.44, 6);
    const rawWheel = new THREE.TorusGeometry(0.062, 0.012, 5, 10);
    const rawSightBody = new THREE.BoxGeometry(0.08, 0.16, 0.09);
    const rawEyepiece = new THREE.CylinderGeometry(0.028, 0.026, 0.09, 6);
    const geoMergedBipod = track(
      mergeColoredParts([
        { geo: rawLeg, color: 0x2a2f33, pos: [-0.26, 0.48, -0.52], rot: [0.22, 0, -0.26] },
        { geo: rawLeg, color: 0x2a2f33, pos: [0.26, 0.48, -0.52], rot: [0.22, 0, 0.26] },
        { geo: rawScrew, color: 0x41484d, pos: [0, 0.88, -0.44], rot: [0, 0, Math.PI * 0.5] },
        { geo: rawWheel, color: 0xc29b48, pos: [-0.26, 0.88, -0.44], rot: [0, Math.PI * 0.5, 0] },
        { geo: rawWheel, color: 0xc29b48, pos: [-0.14, 0.68, -0.48] },
        { geo: rawSightBody, color: 0x2a2f33, pos: [-0.23, 1.01, -0.36] },
        { geo: rawEyepiece, color: 0xc29b48, pos: [-0.23, 1.06, -0.30], rot: [Math.PI * 0.5, 0, 0] },
      ]),
    );
    rawLeg.dispose();
    rawScrew.dispose();
    rawWheel.dispose();
    rawSightBody.dispose();
    rawEyepiece.dispose();

    const rawBarrel = new THREE.CylinderGeometry(0.056, 0.064, 1.32, 10);
    const rawCollar = new THREE.CylinderGeometry(0.078, 0.078, 0.14, 8);
    const geoMergedBarrel = track(
      mergeColoredParts([
        { geo: rawBarrel, color: 0x454d52, pos: [0, 0.66, 0] },
        { geo: rawCollar, color: 0x252a2e, pos: [0, 0.82, 0] },
      ]),
    );
    rawBarrel.dispose();
    rawCollar.dispose();

    const geoFlash = track(new THREE.ConeGeometry(0.24, 0.55, 8));

    // Merged kneeling crew body (legs + torso + plate carrier + arms) & head+helmet
    const rawCrewLeg = new THREE.CylinderGeometry(0.085, 0.075, 0.44, 6);
    const rawCrewTorso = new THREE.BoxGeometry(0.36, 0.48, 0.24);
    const rawCrewVest = new THREE.BoxGeometry(0.39, 0.36, 0.28);
    const rawCrewArm = new THREE.CylinderGeometry(0.055, 0.048, 0.46, 6);
    const geoMergedCrewBody = track(
      mergeColoredParts([
        { geo: rawCrewLeg, color: 0x9c9a8d, pos: [-0.11, 0.22, 0.08], rot: [0.65, 0, 0] },
        { geo: rawCrewLeg, color: 0x9c9a8d, pos: [0.11, 0.16, -0.06], rot: [-0.85, 0, 0] },
        { geo: rawCrewTorso, color: 0xadb0a2, pos: [0, 0.68, 0] },
        { geo: rawCrewVest, color: 0x6f745c, pos: [0, 0.71, 0] },
        { geo: rawCrewArm, color: 0xadb0a2, pos: [-0.22, 0.68, -0.12], rot: [0.85, 0, 0] },
        { geo: rawCrewArm, color: 0xadb0a2, pos: [0.22, 0.68, -0.12], rot: [0.85, 0, 0] },
      ]),
    );
    rawCrewLeg.dispose();
    rawCrewTorso.dispose();
    rawCrewVest.dispose();
    rawCrewArm.dispose();

    const rawCrewHead = new THREE.SphereGeometry(0.115, 8, 6);
    const rawCrewHelmet = new THREE.SphereGeometry(0.135, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.58);
    const geoMergedCrewHead = track(
      mergeColoredParts([
        { geo: rawCrewHead, color: 0xd4a682, pos: [0, 0, 0.02] },
        { geo: rawCrewHelmet, color: 0x3b4238, pos: [0, 0.02, 0.01] },
      ]),
    );
    rawCrewHead.dispose();
    rawCrewHelmet.dispose();

    const makePoolInst = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      count: number,
      name: string,
      optsInst?: { receiveShadow?: boolean; renderOrder?: number },
    ): THREE.InstancedMesh => {
      const inst = new THREE.InstancedMesh(geo, mat, count);
      inst.name = name;
      inst.castShadow = false;
      inst.receiveShadow = Boolean(optsInst?.receiveShadow);
      inst.frustumCulled = false;
      if (optsInst?.renderOrder !== undefined) inst.renderOrder = optsInst.renderOrder;
      for (let i = 0; i < count; i++) {
        inst.setMatrixAt(i, _zeroMatrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      this.root.add(inst);
      return inst;
    };

    // 10 batched InstancedMeshes for all 6 mortar pits
    this.sandbagInst = makePoolInst(this.geoSandbag, this.matSandbag, MAX_MORTAR_PITS * 28, 'MortarSandbagsInst', { receiveShadow: true });
    this.baseplateInst = makePoolInst(geoBaseplate, this.matSteelDark, MAX_MORTAR_PITS, 'MortarBaseplatesInst', { receiveShadow: true });
    this.crateInst = makePoolInst(geoCrate, this.matOliveCrate, MAX_MORTAR_PITS * 2, 'MortarCratesInst', { receiveShadow: true });
    this.stakeInst = makePoolInst(geoMergedStake, this.matVertexMatte, MAX_MORTAR_PITS * 2, 'MortarStakesInst');
    this.bipodTurretInst = makePoolInst(geoMergedBipod, this.matCompositeMetal, MAX_MORTAR_PITS, 'MortarBipodsInst');
    this.barrelInst = makePoolInst(geoMergedBarrel, this.matCompositeMetal, MAX_MORTAR_PITS, 'MortarBarrelsInst');
    this.muzzleFlashInst = makePoolInst(geoFlash, this.matFlash, MAX_MORTAR_PITS, 'MortarMuzzleFlashesInst');
    this.stagedShellInst = makePoolInst(this.geoMergedShell, this.matVertexMatte, MAX_MORTAR_PITS, 'MortarStagedShellsInst');
    this.crewBodyInst = makePoolInst(geoMergedCrewBody, this.matCrewBody, MAX_MORTAR_PITS * 2, 'MortarCrewBodiesInst');
    this.crewHeadInst = makePoolInst(geoMergedCrewHead, this.matCrewHead, MAX_MORTAR_PITS * 2, 'MortarCrewHeadsInst');

    // Initialize 16 pooled falling mortar shell / aerial bomb instances (1 draw call!)
    this.shellInst = makePoolInst(this.geoMergedShell, this.matVertexMatte, MAX_MORTAR_SHELL_POOL, 'MortarOrdnancePoolInst');
    for (let i = 0; i < MAX_MORTAR_SHELL_POOL; i++) {
      this.shellPool.push({
        slotIndex: i,
        active: false,
        shellId: '',
        pitId: '',
        callerId: '',
        callerName: '',
        callerTeam: 'A',
        isPlayerManned: false,
        weaponKind: 'mortar_81mm',
        weaponName: '81mm MORTAR',
        blastRadiusM: MORTAR_BLAST_RADIUS_M,
        maxDamage: MORTAR_BLAST_MAX_DAMAGE,
        scaleMult: 1.0,
        origin: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        windX: 0,
        windZ: 0,
        impactPos: new THREE.Vector3(),
        elapsedSec: 0,
        flightTimeSec: 1,
        whistleTriggered: false,
      });
    }

    // Initialize 24 pooled FIFO ground scorch decals (1 draw call!)
    this.scorchInst = makePoolInst(this.geoScorchPlane, this.matScorchDecal, MAX_SCORCH_DECAL_POOL, 'MortarScorchDecalsInst', { renderOrder: 2 });

    // Initialize 6 pooled lightweight detonation smoke/flash/ring bursts (3 draw calls!)
    const plumeGeo = track(new THREE.IcosahedronGeometry(1.1, 1));
    const ringGeo = track(new THREE.RingGeometry(0.6, 1.35, 16));
    ringGeo.rotateX(-Math.PI * 0.5);
    this.blastPlumeInst = makePoolInst(plumeGeo, this.matBlastPlume, 6, 'MortarBlastPlumesInst');
    this.blastFlashInst = makePoolInst(plumeGeo, this.matBlastFlash, 6, 'MortarBlastFlashesInst');
    this.blastRingInst = makePoolInst(ringGeo, this.matBlastRing, 6, 'MortarBlastRingsInst');
    for (let i = 0; i < 6; i++) {
      this.blastVfxPool.push({
        slotIndex: i,
        active: false,
        timerSec: 0,
        durationSec: 1.4,
        scaleBoost: 1.0,
        pos: new THREE.Vector3(),
      });
    }

    // Single pooled dynamic explosion PointLight recycled to the latest blast (never casts shadows!)
    this.blastLight = new THREE.PointLight(0xff9c40, 0, 32, 1.8);
    this.blastLight.castShadow = false;
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
      for (let i = 0; i < this.shellPool.length; i++) {
        this.shellPool[i].active = false;
        this.shellInst.setMatrixAt(i, _zeroMatrix);
      }
      this.shellInst.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < this.blastVfxPool.length; i++) {
        this.blastVfxPool[i].active = false;
        this.blastPlumeInst.setMatrixAt(i, _zeroMatrix);
        this.blastFlashInst.setMatrixAt(i, _zeroMatrix);
        this.blastRingInst.setMatrixAt(i, _zeroMatrix);
      }
      this.blastPlumeInst.instanceMatrix.needsUpdate = true;
      this.blastFlashInst.instanceMatrix.needsUpdate = true;
      this.blastRingInst.instanceMatrix.needsUpdate = true;
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
      this.teamStates.A.activeBomberId = null;
      this.teamStates.B.activeBomberId = null;
      this.teamStates.A.activeStrike = false;
      this.teamStates.B.activeStrike = false;
      this.teamStates.A.callerPlayerId = null;
      this.teamStates.B.callerPlayerId = null;
      this.teamStates.A.activeStrikeId = null;
      this.teamStates.B.activeStrikeId = null;
      this.remoteActiveMissions = [];
      this.blastLight.visible = false;
      this.blastLight.intensity = 0;
      this.lastTickActivePits = 0;
      this.syncAllPitInstances();
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
    for (let i = 0; i < capped.length; i++) {
      const cfg = capped[i];
      const pit = this.buildMortarPit(cfg, i);
      this.pits.set(cfg.pitId, pit);
      this.root.add(pit.root);
    }
    this.syncAllPitInstances();
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
    this.syncAllPitInstances();
  }

  /** Synchronizes Phase 4 Bomber Air Strike team cooldown & airspace lock state into shared team fire-support state. */
  public syncTeamAirStrikeState(
    team: 'A' | 'B',
    patch: {
      airStrikeCooldownSec: number;
      airStrikeMaxCooldownSec: number;
      activeBomberId: string | null;
      activeStrike: boolean;
      callerPlayerId: string | null;
      activeStrikeId: string | null;
    },
  ): void {
    this.externalAirStrikeStateManaged = true;
    const ts = this.teamStates[team];
    ts.airStrikeCooldownSec = Math.max(0, patch.airStrikeCooldownSec);
    ts.airStrikeMaxCooldownSec = Math.max(1, patch.airStrikeMaxCooldownSec);
    ts.activeBomberId = patch.activeBomberId;
    ts.activeStrike = patch.activeStrike;
    ts.callerPlayerId = patch.callerPlayerId;
    ts.activeStrikeId = patch.activeStrikeId;
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

    // Turning handwheels physically rotates the crank angles and corrects post-shot stake/bubble drift
    pit.traverseWheelAngle += deltaAzimuthRad * 16;
    pit.elevateWheelAngle += deltaElevationRad * 20;

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
    this.syncAllPitInstances();
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
      if (!this.externalAirStrikeStateManaged && ts.airStrikeCooldownSec > 0) {
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
      pit.stagedShellVisible = pit.state.reloadProgress01 > 0.55;

      // Muzzle flash & tube recoil recovery
      if (pit.muzzleFlashTimer > 0) {
        pit.muzzleFlashTimer = Math.max(0, pit.muzzleFlashTimer - safeDt);
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

    // Update dynamic instanced transforms for active mortar pits & crew
    this.syncDynamicPitInstances();

    // Update pooled falling mortar shells & bomber bombs
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
    maxShellPool: number;
    scorchDecalPoolSize: number;
    activeScorchDecals: number;
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
      maxShellPool: MAX_MORTAR_SHELL_POOL,
      scorchDecalPoolSize: MAX_SCORCH_DECAL_POOL,
      activeScorchDecals: this.scorchUsedCount,
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
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Pit Construction (<= 2,200 tris per pit)
  // ---------------------------------------------------------------------------

  private buildMortarPit(cfg: MortarSiteConfig, slotIndex: number): InternalMortarPit {
    const pitRoot = new THREE.Group();
    pitRoot.name = `MortarPit_${cfg.pitId}`;
    const groundY = this.getGroundHeight(cfg.position[0], cfg.position[2]);
    const worldPos: [number, number, number] = [cfg.position[0], groundY, cfg.position[2]];
    pitRoot.position.set(worldPos[0], worldPos[1], worldPos[2]);

    const turretYawGroup = new THREE.Group();
    pitRoot.add(turretYawGroup);

    // Barrel pivot anchored in baseplate socket (tilts in high-angle 45°-80° band)
    const barrelPivotGroup = new THREE.Group();
    barrelPivotGroup.position.set(0, 0.11, 0);
    turretYawGroup.add(barrelPivotGroup);

    const barrelRecoilGroup = new THREE.Group();
    barrelPivotGroup.add(barrelRecoilGroup);

    // Killable 2-Man AI Mortar Crew transform rigs + raycastable invisible hitboxes
    const gunnerVisual = this.buildCrewVisual(cfg.pitId, 'gunner');
    const loaderVisual = this.buildCrewVisual(cfg.pitId, 'loader');
    turretYawGroup.add(gunnerVisual.root, loaderVisual.root);

    // Sandbag Parapet Colliders (compact AABB quadrants leaving rear entrance clear)
    const radius = 1.95;
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
      slotIndex,
      state,
      root: pitRoot,
      turretYawGroup,
      barrelPivotGroup,
      barrelRecoilGroup,
      traverseWheelAngle: 0,
      elevateWheelAngle: 0,
      stagedShellVisible: true,
      muzzleTipLocal: new THREE.Vector3(0, 1.36, 0),
      muzzleFlashTimer: 0,
      gunnerVisual,
      loaderVisual,
      colliders,
      reloadTimerSec: 0,
      reloadDurationSec: MORTAR_RELOAD_AI_LOADER_SEC,
      aiSalvoTimerSec: 12 + (slotIndex % 3) * 6,
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

    this.applyCrewUniforms(pit, cfg.ownerTeam);
    this.syncChargeRingVisuals(pit);
    this.applyTubeTransform(pit);
    return pit;
  }

  private buildCrewVisual(pitId: string, role: 'gunner' | 'loader'): CrewActorVisual {
    const root = new THREE.Group();
    const isGunner = role === 'gunner';
    root.position.set(isGunner ? -0.68 : 0.68, 0, 0.24);
    root.rotation.y = isGunner ? -0.45 : 0.45;

    const torsoGroup = new THREE.Group();
    torsoGroup.position.set(0, 0.46, 0);
    root.add(torsoGroup);

    // Lightweight invisible raycast hitboxes (material.visible = false => 0 GPU draw calls, full Raycaster support)
    const torsoMesh = new THREE.Mesh(this.geoHitTorso, this.matHitboxInvisible);
    torsoMesh.position.y = 0.24;
    const headMesh = new THREE.Mesh(this.geoHitHead, this.matHitboxInvisible);
    headMesh.position.set(0, 0.56, 0.02);

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.22, 0.38, 0.02);
    const rightArm = new THREE.Group();
    rightArm.position.set(0.22, 0.38, 0.02);
    torsoGroup.add(torsoMesh, headMesh, leftArm, rightArm);

    const hitMeshes = [torsoMesh, headMesh];
    for (const m of hitMeshes) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.mortarCrewPitId = pitId;
      m.userData.mortarCrewRole = role;
      m.userData.mortarHitZone = m === headMesh ? 'head' : 'body';
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

  private applyCrewUniforms(pit: InternalMortarPit, team: 'A' | 'B'): void {
    // Tint per-team instanced crew uniforms cleanly (NATO Ranger Olive vs Opfor Khaki-Tan)
    _color.setHex(team === 'A' ? 0x8ea17d : 0xb59b7c);
    const baseIdx = pit.slotIndex * 2;
    this.crewBodyInst.setColorAt(baseIdx, _color);
    this.crewBodyInst.setColorAt(baseIdx + 1, _color);
    if (this.crewBodyInst.instanceColor) {
      this.crewBodyInst.instanceColor.needsUpdate = true;
    }
    _color.setHex(team === 'A' ? 0xd0d8c8 : 0xd8cec0);
    this.crewHeadInst.setColorAt(baseIdx, _color);
    this.crewHeadInst.setColorAt(baseIdx + 1, _color);
    if (this.crewHeadInst.instanceColor) {
      this.crewHeadInst.instanceColor.needsUpdate = true;
    }
  }

  private resetCrewVisualsAlive(pit: InternalMortarPit): void {
    pit.gunnerVisual.dead = false;
    pit.gunnerVisual.root.visible = true;
    pit.loaderVisual.dead = false;
    pit.loaderVisual.root.visible = true;
  }

  private syncChargeRingVisuals(_pit: InternalMortarPit): void {
    // Charge level is reflected in firing telemetry and tube elevation/staging state
  }

  /** Rebuilds static + dynamic InstancedMesh transforms across all configured mortar pits. */
  private syncAllPitInstances(): void {
    // Reset all static slots first
    for (let i = 0; i < MAX_MORTAR_PITS * 28; i++) this.sandbagInst.setMatrixAt(i, _zeroMatrix);
    for (let i = 0; i < MAX_MORTAR_PITS; i++) this.baseplateInst.setMatrixAt(i, _zeroMatrix);
    for (let i = 0; i < MAX_MORTAR_PITS * 2; i++) {
      this.crateInst.setMatrixAt(i, _zeroMatrix);
      this.stakeInst.setMatrixAt(i, _zeroMatrix);
    }

    const radius = 1.95;
    const stakeDistances = [4.2, 7.5];

    for (const pit of this.pits.values()) {
      const visible = this.enabled && pit.root.visible && pit.state.status !== 'INACTIVE';
      if (!visible) continue;

      const s = pit.slotIndex;
      const px = pit.state.position[0];
      const py = pit.state.position[1];
      const pz = pit.state.position[2];

      // 28 instanced sandbags in 2 stacked horseshoe tiers
      let bagOffset = s * 28;
      for (let tier = 0; tier < 2; tier++) {
        for (let i = 0; i < 14; i++) {
          const frac = i / 13;
          const angle = pit.state.zeroBearingRad - Math.PI * 0.72 + frac * Math.PI * 1.44 + tier * 0.08;
          const bx = px + Math.sin(angle) * (radius + (tier === 1 ? 0.04 : 0));
          const bz = pz - Math.cos(angle) * (radius + (tier === 1 ? 0.04 : 0));
          const by = py + 0.12 + tier * 0.23;
          _euler.set(0, -angle, 0);
          _quat.setFromEuler(_euler);
          _scale.set(1.0 + (i % 2) * 0.06, 1.0, 1.0);
          _mat4.compose(_vA.set(bx, by, bz), _quat, _scale);
          this.sandbagInst.setMatrixAt(bagOffset++, _mat4);
        }
      }

      // Baseplate
      _quat.identity();
      _scale.set(1, 1, 1);
      _mat4.compose(_vA.set(px, py + 0.045, pz), _quat, _scale);
      this.baseplateInst.setMatrixAt(s, _mat4);

      // 2 stacked ammo crates
      _euler.set(0, 0.35, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(_vA.set(px + 0.86, py + 0.14, pz + 0.42), _quat, _scale);
      this.crateInst.setMatrixAt(s * 2, _mat4);
      _euler.set(0, 0.24, 0);
      _quat.setFromEuler(_euler);
      _mat4.compose(_vA.set(px + 0.88, py + 0.42, pz + 0.44), _quat, _scale);
      this.crateInst.setMatrixAt(s * 2 + 1, _mat4);

      // 2 red-and-white aiming stakes
      _quat.identity();
      for (let k = 0; k < 2; k++) {
        const dist = stakeDistances[k];
        const sx = px + Math.sin(pit.state.zeroBearingRad) * dist;
        const sz = pz - Math.cos(pit.state.zeroBearingRad) * dist;
        const sy = this.getGroundHeight(sx, sz);
        _mat4.compose(_vA.set(sx, sy, sz), _quat, _scale);
        this.stakeInst.setMatrixAt(s * 2 + k, _mat4);
      }
    }

    this.sandbagInst.instanceMatrix.needsUpdate = true;
    this.baseplateInst.instanceMatrix.needsUpdate = true;
    this.crateInst.instanceMatrix.needsUpdate = true;
    this.stakeInst.instanceMatrix.needsUpdate = true;

    this.syncDynamicPitInstances();
  }

  /** Zero-GC per-frame update of rotating mortar tubes, muzzle flashes, staged shells, and crew poses. */
  private syncDynamicPitInstances(): void {
    for (let i = 0; i < MAX_MORTAR_PITS; i++) {
      this.bipodTurretInst.setMatrixAt(i, _zeroMatrix);
      this.barrelInst.setMatrixAt(i, _zeroMatrix);
      this.muzzleFlashInst.setMatrixAt(i, _zeroMatrix);
      this.stagedShellInst.setMatrixAt(i, _zeroMatrix);
      this.crewBodyInst.setMatrixAt(i * 2, _zeroMatrix);
      this.crewBodyInst.setMatrixAt(i * 2 + 1, _zeroMatrix);
      this.crewHeadInst.setMatrixAt(i * 2, _zeroMatrix);
      this.crewHeadInst.setMatrixAt(i * 2 + 1, _zeroMatrix);
    }

    if (this.enabled) {
      for (const pit of this.pits.values()) {
        if (!pit.root.visible || pit.state.status === 'INACTIVE') continue;
        const s = pit.slotIndex;
        pit.root.updateMatrixWorld(true);

        // Bipod turret follows turretYawGroup
        this.bipodTurretInst.setMatrixAt(s, pit.turretYawGroup.matrixWorld);

        // Barrel follows barrelRecoilGroup
        this.barrelInst.setMatrixAt(s, pit.barrelRecoilGroup.matrixWorld);

        // Muzzle flash at barrel tip when firing
        if (pit.muzzleFlashTimer > 0) {
          const fScale = 0.65 + (1 - pit.muzzleFlashTimer / 0.11) * 1.45;
          _quat.identity();
          _scale.setScalar(fScale);
          _mat4B.compose(_vA.set(0, 1.56, 0), _quat, _scale);
          _mat4.multiplyMatrices(pit.barrelRecoilGroup.matrixWorld, _mat4B);
          this.muzzleFlashInst.setMatrixAt(s, _mat4);
        }

        // Staged 81mm round beside ammo crates
        if (pit.stagedShellVisible) {
          _euler.set(0, 0, 0.28);
          _quat.setFromEuler(_euler);
          _scale.set(1, 1, 1);
          _mat4.compose(
            _vA.set(pit.state.position[0] + 0.56, pit.state.position[1] + 0.62, pit.state.position[2] + 0.18),
            _quat,
            _scale,
          );
          this.stagedShellInst.setMatrixAt(s, _mat4);
        }

        // Crew visuals (Gunner = s*2, Loader = s*2+1)
        const crewList: [CrewActorVisual, number][] = [
          [pit.gunnerVisual, s * 2],
          [pit.loaderVisual, s * 2 + 1],
        ];
        for (let c = 0; c < 2; c++) {
          const vis = crewList[c][0];
          const idx = crewList[c][1];
          if (vis.dead || !vis.root.visible) continue;
          this.crewBodyInst.setMatrixAt(idx, vis.root.matrixWorld);
          this.crewHeadInst.setMatrixAt(idx, vis.headMesh.matrixWorld);
        }
      }
    }

    this.bipodTurretInst.instanceMatrix.needsUpdate = true;
    this.barrelInst.instanceMatrix.needsUpdate = true;
    this.muzzleFlashInst.instanceMatrix.needsUpdate = true;
    this.stagedShellInst.instanceMatrix.needsUpdate = true;
    this.crewBodyInst.instanceMatrix.needsUpdate = true;
    this.crewHeadInst.instanceMatrix.needsUpdate = true;
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
  }

  /**
   * Public shared ordnance pool entry point used by BomberAirStrikeSystem so aerial bombs
   * share the exact same 16-slot projectile pool, 24-slot FIFO scorch decals, 6-slot blast VFX,
   * single dynamic blast PointLight, and priority-pooled audio system.
   */
  public spawnExternalOrdnance(opts: ExternalOrdnanceSpawnOptions): void {
    if (!this.enabled) return;
    this.spawnPooledShell({
      shellId: opts.shellId,
      pitId: opts.sourceId,
      callerId: opts.callerId,
      callerName: opts.callerName,
      callerTeam: opts.callerTeam,
      isPlayerManned: false,
      weaponKind: opts.weaponKind,
      weaponName: opts.weaponName,
      blastRadiusM: opts.blastRadiusM,
      maxDamage: opts.maxDamage,
      scaleMult: opts.scaleMult ?? 1.45,
      windAffected: opts.windAffected ?? false,
      origin: opts.origin,
      vel: opts.vel,
      impactPos: opts.impactPos,
      flightTimeSec: opts.flightTimeSec,
    });
  }

  private spawnPooledShell(opts: {
    shellId: string;
    pitId: string;
    callerId: string;
    callerName?: string;
    callerTeam: 'A' | 'B';
    isPlayerManned: boolean;
    weaponKind?: 'mortar_81mm' | 'bomber_air_strike';
    weaponName?: string;
    blastRadiusM?: number;
    maxDamage?: number;
    scaleMult?: number;
    windAffected?: boolean;
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
    slot.callerName = opts.callerName ?? '';
    slot.callerTeam = opts.callerTeam;
    slot.isPlayerManned = opts.isPlayerManned;
    slot.weaponKind = opts.weaponKind ?? 'mortar_81mm';
    slot.weaponName = opts.weaponName ?? '81mm MORTAR';
    slot.blastRadiusM = opts.blastRadiusM ?? MORTAR_BLAST_RADIUS_M;
    slot.maxDamage = opts.maxDamage ?? MORTAR_BLAST_MAX_DAMAGE;
    slot.scaleMult = opts.scaleMult ?? 1.0;
    slot.origin.copy(opts.origin);
    slot.vel.copy(opts.vel);
    const useWind = opts.windAffected !== false;
    slot.windX = useWind ? this.windX : 0;
    slot.windZ = useWind ? this.windZ : 0;
    slot.impactPos.copy(opts.impactPos);
    slot.elapsedSec = 0;
    slot.flightTimeSec = Math.max(0.35, opts.flightTimeSec);
    slot.whistleTriggered = false;

    _quat.identity();
    _scale.setScalar(slot.scaleMult);
    _mat4.compose(opts.origin, _quat, _scale);
    this.shellInst.setMatrixAt(slot.slotIndex, _mat4);
    this.shellInst.instanceMatrix.needsUpdate = true;
  }

  private updateActiveShells(dt: number): void {
    let anyMatrixDirty = false;
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
        this.shellInst.setMatrixAt(shell.slotIndex, _zeroMatrix);
        anyMatrixDirty = true;
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

      _vC.subVectors(_vB, _vA);
      if (_vC.lengthSq() > 1e-5) {
        _vC.normalize();
        _quat.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, _vC);
      } else {
        _quat.identity();
      }
      _scale.setScalar(shell.scaleMult);
      _mat4.compose(_vA, _quat, _scale);
      this.shellInst.setMatrixAt(shell.slotIndex, _mat4);
      anyMatrixDirty = true;
    }

    if (anyMatrixDirty) {
      this.shellInst.instanceMatrix.needsUpdate = true;
    }
  }

  private detonateShell(shell: PooledMortarShell): void {
    const pos = shell.impactPos.clone();
    pos.y = this.getGroundHeight(pos.x, pos.z);
    const isBomb = shell.weaponKind === 'bomber_air_strike';

    // 1. Place FIFO pooled scorch crater decal (max 24, ring-buffer overwrite, 1 InstancedMesh draw call)
    const decalSlot = this.scorchFifoIndex;
    this.scorchFifoIndex = (this.scorchFifoIndex + 1) % MAX_SCORCH_DECAL_POOL;
    this.scorchUsedCount = Math.min(MAX_SCORCH_DECAL_POOL, this.scorchUsedCount + 1);
    _euler.set(0, (this.scorchFifoIndex * 2.399) % (Math.PI * 2), 0);
    _quat.setFromEuler(_euler);
    _scale.setScalar(isBomb ? 1.28 : 1.0);
    _mat4.compose(_vA.set(pos.x, pos.y + 0.045, pos.z), _quat, _scale);
    this.scorchInst.setMatrixAt(decalSlot, _mat4);
    this.scorchInst.instanceMatrix.needsUpdate = true;

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
    vfx.durationSec = isBomb ? 1.75 : 1.55;
    vfx.scaleBoost = isBomb ? 1.32 : 1.0;
    vfx.pos.copy(pos);

    // 3. Re-center single pooled dynamic explosion PointLight (never casts shadows)
    this.blastLight.position.set(pos.x, pos.y + 2.8, pos.z);
    this.blastLight.intensity = isBomb ? 24 : 18;
    this.blastLight.visible = true;
    this.blastLightTimerSec = isBomb ? 0.42 : 0.34;

    // 4. Priority-pooled overpressure detonation audio
    this.audio?.playMortarExplosion(pos);

    // 5. Notify combat engine to apply 100% enemy / 100% caller self / 25% teammate splash + breakables
    this.onImpact?.({
      shellId: shell.shellId,
      pitId: shell.pitId,
      callerId: shell.callerId,
      ...(shell.callerName ? { callerName: shell.callerName } : {}),
      callerTeam: shell.callerTeam,
      isPlayerManned: shell.isPlayerManned,
      weaponKind: shell.weaponKind,
      weaponName: shell.weaponName,
      position: pos,
      blastRadiusM: shell.blastRadiusM,
      maxDamage: shell.maxDamage,
    });
  }

  private updateBlastVfx(dt: number): void {
    if (this.blastLightTimerSec > 0) {
      this.blastLightTimerSec = Math.max(0, this.blastLightTimerSec - dt);
      const frac = Math.min(1, this.blastLightTimerSec / 0.34);
      this.blastLight.intensity = 18 * frac * frac;
      if (this.blastLightTimerSec <= 0) {
        this.blastLight.visible = false;
      }
    }

    let dirty = false;
    _quat.identity();
    for (let i = 0; i < this.blastVfxPool.length; i++) {
      const v = this.blastVfxPool[i];
      if (!v.active) continue;
      dirty = true;
      v.timerSec += dt;
      const t = v.timerSec / v.durationSec;
      if (t >= 1) {
        v.active = false;
        this.blastPlumeInst.setMatrixAt(v.slotIndex, _zeroMatrix);
        this.blastFlashInst.setMatrixAt(v.slotIndex, _zeroMatrix);
        this.blastRingInst.setMatrixAt(v.slotIndex, _zeroMatrix);
        continue;
      }

      const boost = v.scaleBoost;
      const fadeOut = Math.sin(Math.min(1, 1 - t) * Math.PI * 0.5);
      const plumeScale = (1.2 + t * 5.2) * boost * Math.max(0.05, fadeOut);
      _scale.set(plumeScale * 0.85, plumeScale * 1.15, plumeScale * 0.85);
      _mat4.compose(_vA.set(v.pos.x, v.pos.y + 0.6 + t * 4.4 * boost, v.pos.z), _quat, _scale);
      this.blastPlumeInst.setMatrixAt(v.slotIndex, _mat4);

      const flashT = Math.min(1, t * 4.5);
      if (flashT < 1) {
        const flashScale = (1.1 + flashT * 3.2) * boost * (1 - flashT * 0.65);
        _scale.setScalar(flashScale);
        _mat4.compose(_vA.set(v.pos.x, v.pos.y + 0.7, v.pos.z), _quat, _scale);
        this.blastFlashInst.setMatrixAt(v.slotIndex, _mat4);
      } else {
        this.blastFlashInst.setMatrixAt(v.slotIndex, _zeroMatrix);
      }

      const ringT = Math.min(1, t * 2.2);
      if (ringT < 1) {
        const ringScale = (1.0 + ringT * 8.2) * boost;
        _scale.set(ringScale, 1, ringScale);
        _mat4.compose(_vA.set(v.pos.x, v.pos.y + 0.12, v.pos.z), _quat, _scale);
        this.blastRingInst.setMatrixAt(v.slotIndex, _mat4);
      } else {
        this.blastRingInst.setMatrixAt(v.slotIndex, _zeroMatrix);
      }
    }

    if (dirty) {
      this.blastPlumeInst.instanceMatrix.needsUpdate = true;
      this.blastFlashInst.instanceMatrix.needsUpdate = true;
      this.blastRingInst.instanceMatrix.needsUpdate = true;
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

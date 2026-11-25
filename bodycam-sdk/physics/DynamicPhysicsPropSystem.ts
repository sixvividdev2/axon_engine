import * as THREE from 'three';
import {
  GraphicsQualityId,
  PhysicsPropBudgetSpec,
  resolvePhysicsPropBudget,
} from '../../data/graphicsQuality';
import type { BodycamPhysicsWorld } from '../BodycamPhysics';
import type { BodycamSurfaceMaterial } from '../types';
import type { PhysicsPropAudioKind } from '../BodycamAudio';

export type DynamicPropArchetype =
  | 'glass_bottle_green'
  | 'glass_bottle_amber'
  | 'soda_can'
  | 'ration_tin'
  | 'paper_sheet'
  | 'cardboard_box'
  | 'plastic_crate';

export type PropClusterPreset =
  | 'desk_clutter'
  | 'bar_bottles'
  | 'floor_trash'
  | 'range_ledge'
  | 'loading_dock'
  | 'wind_street_papers'
  | 'bunker_mess';

export interface DynamicPropSpawnSpec {
  kind: DynamicPropArchetype;
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
  scale?: number;
  /** Optional owner tag (e.g. Open World chunk key) for O(k) removal on chunk unload */
  ownerTag?: string;
}

export interface DynamicPropSupportSample {
  height: number;
  surface: BodycamSurfaceMaterial;
}

export interface DynamicPropSolidHit {
  hit: boolean;
  pushX: number;
  pushY: number;
  pushZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  surface: BodycamSurfaceMaterial;
}

export interface DynamicPropWorldAdapter {
  /**
   * Returns highest solid support Y at (x, z) that is <= maxSurfaceY (floor, tabletop, shelf, deck, or terrain).
   */
  sampleSupportHeight: (x: number, maxSurfaceY: number, z: number) => number;
  /**
   * Optional richer support surface probe returning both exact Y and physical surface material
   * (enables surface-hardness-aware glass shattering on concrete vs wood vs soft turf).
   */
  sampleSupportSurface?: (
    x: number,
    maxSurfaceY: number,
    z: number,
    out: DynamicPropSupportSample,
  ) => void;
  /**
   * Full 3D exact minimum-translation-vector collision against all solid walls, ceilings,
   * floors, furniture, shelf undersides, ramps, and hinged door slabs.
   */
  resolveSolidCollision?: (
    x: number,
    y: number,
    z: number,
    radius: number,
    halfHeight: number,
    out: DynamicPropSolidHit,
  ) => boolean;
  /**
   * Legacy horizontal wall/obstacle collision probe fallback.
   */
  resolveHorizontalHit?: (
    x: number,
    y: number,
    z: number,
    radius: number,
    outNormal: THREE.Vector3,
  ) => boolean;
  /**
   * Returns true if world position (x, y, z) is sheltered indoors (attenuates outdoor wind to gentle draft).
   */
  isIndoor?: (x: number, y: number, z: number) => boolean;
}

export interface DynamicPhysicsPropOptions {
  scene: THREE.Scene;
  adapter: DynamicPropWorldAdapter;
  isSoftwareGl?: boolean;
  graphicsQuality?: GraphicsQualityId;
  budgetOverride?: Partial<PhysicsPropBudgetSpec>;
  onImpactAudio?: (kind: PhysicsPropAudioKind, pos: Readonly<THREE.Vector3>, intensity: number) => void;
  maxAniso?: number;
  /** Set true for bunkers/indoor-only maps with subtle HVAC ventilation drafts */
  indoorVentilationDraft?: boolean;
}

export interface DynamicPropBulletHitResult {
  hit: boolean;
  propIndex: number;
  kind: DynamicPropArchetype | null;
  shattered: boolean;
  dented: boolean;
  point: THREE.Vector3;
}

type PropCollisionShape = 'cylinder' | 'box' | 'sheet';

interface ArchetypeMetrics {
  shape: PropCollisionShape;
  mass: number;
  /** Exact cylindrical radius (or bounding XZ radius for box/sheet) matching rendered geometry */
  radius: number;
  /** Exact half-width along local X matching rendered geometry */
  hx: number;
  /** Exact half-height along local Y matching rendered geometry */
  halfHeight: number;
  /** Exact half-depth along local Z matching rendered geometry */
  hz: number;
  /** True-to-life material restitution (bounciness) */
  restitution: number;
  groundFriction: number;
  angularDamping: number;
  windDrag: number;
  windLift: number;
  shatterable: boolean;
  dentable: boolean;
  audioBounceKind: PhysicsPropAudioKind;
}

const ARCHETYPES: readonly DynamicPropArchetype[] = [
  'glass_bottle_green',
  'glass_bottle_amber',
  'soda_can',
  'ration_tin',
  'paper_sheet',
  'cardboard_box',
  'plastic_crate',
];

/**
 * Exact geometry-aligned bounds & physically realistic material restitution/friction:
 * paper (0.03) < cardboard (0.11) < glass (0.18) < ration tin (0.26) < plastic crate (0.32) < soda can (0.42)
 */
const ARCHETYPE_METRICS: Record<DynamicPropArchetype, ArchetypeMetrics> = {
  glass_bottle_green: {
    shape: 'cylinder',
    mass: 0.42,
    radius: 0.04,
    hx: 0.04,
    halfHeight: 0.135,
    hz: 0.04,
    restitution: 0.18,
    groundFriction: 0.74,
    angularDamping: 0.94,
    windDrag: 0.02,
    windLift: 0.0,
    shatterable: true,
    dentable: false,
    audioBounceKind: 'glass_clink',
  },
  glass_bottle_amber: {
    shape: 'cylinder',
    mass: 0.45,
    radius: 0.04,
    hx: 0.04,
    halfHeight: 0.135,
    hz: 0.04,
    restitution: 0.18,
    groundFriction: 0.74,
    angularDamping: 0.94,
    windDrag: 0.02,
    windLift: 0.0,
    shatterable: true,
    dentable: false,
    audioBounceKind: 'glass_clink',
  },
  soda_can: {
    shape: 'cylinder',
    mass: 0.11,
    radius: 0.034,
    hx: 0.034,
    halfHeight: 0.0625,
    hz: 0.034,
    restitution: 0.42,
    groundFriction: 0.68,
    angularDamping: 0.95,
    windDrag: 0.35,
    windLift: 0.05,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'can_clatter',
  },
  ration_tin: {
    shape: 'cylinder',
    mass: 0.32,
    radius: 0.052,
    hx: 0.052,
    halfHeight: 0.0475,
    hz: 0.052,
    restitution: 0.26,
    groundFriction: 0.80,
    angularDamping: 0.93,
    windDrag: 0.14,
    windLift: 0.02,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'can_clatter',
  },
  paper_sheet: {
    shape: 'sheet',
    mass: 0.015,
    radius: 0.12,
    hx: 0.12,
    halfHeight: 0.0015,
    hz: 0.155,
    restitution: 0.03,
    groundFriction: 0.78,
    angularDamping: 0.89,
    windDrag: 2.85,
    windLift: 1.95,
    shatterable: false,
    dentable: false,
    audioBounceKind: 'paper_rustle',
  },
  cardboard_box: {
    shape: 'box',
    mass: 0.95,
    radius: 0.17,
    hx: 0.18,
    halfHeight: 0.14,
    hz: 0.14,
    restitution: 0.11,
    groundFriction: 0.86,
    angularDamping: 0.90,
    windDrag: 0.14,
    windLift: 0.01,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'cardboard_thud',
  },
  plastic_crate: {
    shape: 'box',
    mass: 1.35,
    radius: 0.19,
    hx: 0.21,
    halfHeight: 0.13,
    hz: 0.16,
    restitution: 0.32,
    groundFriction: 0.76,
    angularDamping: 0.91,
    windDrag: 0.05,
    windLift: 0.0,
    shatterable: false,
    dentable: false,
    audioBounceKind: 'plastic_clack',
  },
};

/**
 * Computes realistic glass bottle impact speed threshold (m/s) based on struck surface hardness.
 * Under Earth gravity (9.81 m/s²), a 0.75m–0.85m desk/shelf fall reaches ~3.8–4.1 m/s:
 *  - Hard surfaces (concrete, metal, asphalt, stone): shatters reliably from desk/shelf height (>= 3.3 m/s)
 *  - Medium surfaces (wood): requires higher drop or forceful knock (>= 4.3 m/s)
 *  - Soft surfaces (grass, dirt, mud, sand, snow): cushions typical table drops (>= 5.8 m/s)
 */
export function computeGlassShatterThreshold(surface: BodycamSurfaceMaterial): number {
  switch (surface) {
    case 'concrete':
    case 'metal':
    case 'asphalt':
      return 3.3;
    case 'gravel':
      return 3.8;
    case 'wood':
      return 4.3;
    case 'grass':
    case 'puddle':
      return 5.8;
    default:
      return 3.7;
  }
}

/**
 * Exact 3D vertical support half-extent from body center to lowest point under current quaternion.
 * Ensures upright bottles, tipped-on-side cans, tilted crates, and flat sheets all rest flush on surfaces.
 */
function computeOrientedHalfExtentY(
  metrics: ArchetypeMetrics,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
): number {
  // Middle row of 3x3 rotation matrix from unit quaternion (dot product of local axes with world +Y)
  const r10 = 2 * (qx * qy + qw * qz);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qw * qx);

  if (metrics.shape === 'cylinder') {
    const absUp = Math.min(1, Math.abs(r11));
    const sinTilt = Math.sqrt(Math.max(0, 1 - absUp * absUp));
    const radScale = Math.max(scaleX, scaleZ);
    return absUp * metrics.halfHeight * scaleY + sinTilt * metrics.radius * radScale;
  }

  if (metrics.shape === 'sheet') {
    const ext =
      Math.abs(r10) * metrics.hx * scaleX +
      Math.abs(r11) * metrics.halfHeight * scaleY +
      Math.abs(r12) * metrics.hz * scaleZ;
    return Math.max(0.0015, ext);
  }

  // Exact OBB vertical half-extent for boxes & crates
  return (
    Math.abs(r10) * metrics.hx * scaleX +
    Math.abs(r11) * metrics.halfHeight * scaleY +
    Math.abs(r12) * metrics.hz * scaleZ
  );
}

/**
 * Computes conservative horizontal bounding radius under current quaternion for wall/door/prop sweeps.
 */
function computeOrientedHorizRadius(
  metrics: ArchetypeMetrics,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
): number {
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  if (metrics.shape === 'cylinder') {
    const absUp = Math.min(1, Math.abs(r11));
    const sinTilt = Math.sqrt(Math.max(0, 1 - absUp * absUp));
    const r = metrics.radius * Math.max(scaleX, scaleZ);
    const h = metrics.halfHeight * scaleY;
    return Math.max(r, absUp * r + sinTilt * h * 0.82);
  }
  if (metrics.shape === 'sheet') {
    return metrics.radius * Math.max(scaleX, scaleZ) * 0.85;
  }
  return Math.max(metrics.hx * scaleX, metrics.hz * scaleZ);
}

interface PropBody {
  id: number;
  active: boolean;
  kind: DynamicPropArchetype;
  instanceIdx: number;
  ownerTag: string;
  // Transform & spawn anchor (for wind-blown paper soft-leash)
  x: number;
  y: number;
  z: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
  vx: number;
  vy: number;
  vz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  scale: number;
  dentScaleX: number;
  dentScaleY: number;
  dentScaleZ: number;
  sleeping: boolean;
  sleepTimer: number;
  shattered: boolean;
  dented: boolean;
  indoor: boolean;
  windPhase: number;
  audioCooldown: number;
  cellKey: number;
}

interface GlassShardBody {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  vrx: number;
  vry: number;
  vrz: number;
  scale: number;
  age: number;
  sleeping: boolean;
}

interface PaperWindUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
}

// Module-scope zero-GC scratch math
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _deltaQuat = new THREE.Quaternion();
const _normal = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _tmpColor = new THREE.Color();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _supportScratch: DynamicPropSupportSample = { height: 0, surface: 'concrete' };
const _solidHitScratch: DynamicPropSolidHit = {
  hit: false,
  pushX: 0,
  pushY: 0,
  pushZ: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  surface: 'concrete',
};

const CELL_SIZE_M = 2.0;
const INV_CELL_SIZE = 1.0 / CELL_SIZE_M;
/** True Earth gravity (m/s²) for authentic drop arcs, bounces, and desk-height glass breakage */
const GRAVITY = -9.81;
const SLEEP_LIN_SQ = 0.012;
const SLEEP_ANG_SQ = 0.035;
const SLEEP_HOLD_SEC = 0.32;
const MAX_SIM_DIST_M = 72.0;

function packCellKey(cx: number, cz: number): number {
  return ((cx + 32768) & 0xffff) | (((cz + 32768) & 0xffff) << 16);
}

function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function createPaperDossierTexture(maxAniso: number): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = seededRand(8813);

  ctx.fillStyle = '#ddd6c2';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle paper fiber & crease aging
  for (let i = 0; i < 650; i++) {
    const shade = 188 + Math.floor(rand() * 38);
    ctx.fillStyle = `rgba(${shade},${shade - 6},${shade - 16},0.22)`;
    ctx.fillRect(rand() * 256, rand() * 256, 3, 2);
  }
  // Coffee ring / grime smudge
  ctx.strokeStyle = 'rgba(98, 72, 46, 0.24)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(182, 74, 28, 0, Math.PI * 2);
  ctx.stroke();

  // Header bar & classified stamp
  ctx.fillStyle = '#2a2d30';
  ctx.fillRect(18, 18, 220, 14);
  ctx.fillStyle = '#8b2323';
  ctx.strokeStyle = '#8b2323';
  ctx.lineWidth = 2;
  ctx.strokeRect(156, 40, 76, 22);
  ctx.fillRect(162, 48, 64, 5);

  // Columns of simulated newsprint / tactical report lines
  ctx.fillStyle = 'rgba(34, 38, 42, 0.72)';
  for (let y = 46; y < 232; y += 11) {
    const lineW = y < 74 ? 118 : 165 + Math.floor(rand() * 52);
    ctx.fillRect(20, y, lineW, 4);
  }
  // Fold crease shadow
  ctx.fillStyle = 'rgba(30, 26, 20, 0.14)';
  ctx.fillRect(0, 126, 256, 3);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function createCanLabelTexture(variant: 'soda' | 'ration', maxAniso: number): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 128);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = seededRand(variant === 'soda' ? 9121 : 9443);

  if (variant === 'soda') {
    ctx.fillStyle = '#9c2c24';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#d9cfb8';
    ctx.fillRect(0, 20, 256, 14);
    ctx.fillRect(0, 94, 256, 12);
    ctx.fillStyle = '#1e252c';
    ctx.fillRect(0, 44, 256, 34);
    ctx.fillStyle = '#e5b84b';
    ctx.fillRect(22, 54, 96, 12);
    ctx.fillRect(142, 54, 88, 12);
  } else {
    ctx.fillStyle = '#4f5a44';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#c8b68a';
    ctx.fillRect(0, 26, 256, 74);
    ctx.fillStyle = '#2e332c';
    ctx.fillRect(14, 36, 228, 10);
    ctx.fillRect(14, 78, 228, 6);
    ctx.fillStyle = '#8b2e22';
    ctx.fillRect(24, 52, 86, 18);
  }

  // Scuffs & rust speckles
  for (let i = 0; i < 340; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(20,18,16,0.18)' : 'rgba(220,218,210,0.14)';
    ctx.fillRect(rand() * 256, rand() * 128, 4, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function createCardboardTexture(maxAniso: number): THREE.CanvasTexture | null {
  const res = makeCanvas(256, 256);
  if (!res) return null;
  const { canvas, ctx } = res;
  const rand = seededRand(6117);

  ctx.fillStyle = '#8a6c49';
  ctx.fillRect(0, 0, 256, 256);

  // Corrugated horizontal grain
  for (let y = 0; y < 256; y += 4) {
    ctx.fillStyle = y % 8 === 0 ? 'rgba(56,40,24,0.14)' : 'rgba(182,148,104,0.10)';
    ctx.fillRect(0, y, 256, 2);
  }
  // Packing tape strip & stencil markings
  ctx.fillStyle = 'rgba(176, 146, 98, 0.72)';
  ctx.fillRect(0, 114, 256, 28);
  ctx.fillStyle = 'rgba(28, 26, 24, 0.65)';
  ctx.fillRect(22, 30, 88, 10);
  ctx.fillRect(22, 48, 62, 6);
  ctx.strokeStyle = 'rgba(28, 26, 24, 0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(178, 28, 48, 48);

  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = 'rgba(42,30,18,0.12)';
    ctx.fillRect(rand() * 256, rand() * 256, 3, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildBottleGeometry(): THREE.LatheGeometry {
  // Bottom-center origin at y = -0.135 -> centered around y = 0 for clean 6-DOF rotation
  const halfH = 0.135;
  const pts = [
    new THREE.Vector2(0.002, -halfH),
    new THREE.Vector2(0.036, -halfH),
    new THREE.Vector2(0.04, -halfH + 0.012),
    new THREE.Vector2(0.04, -halfH + 0.145),
    new THREE.Vector2(0.035, -halfH + 0.178),
    new THREE.Vector2(0.017, -halfH + 0.215),
    new THREE.Vector2(0.015, -halfH + 0.256),
    new THREE.Vector2(0.0185, -halfH + 0.264),
    new THREE.Vector2(0.014, -halfH + 0.27),
  ];
  return new THREE.LatheGeometry(pts, 10);
}

function buildCanGeometry(radius: number, height: number): THREE.LatheGeometry {
  const hh = height * 0.5;
  const pts = [
    new THREE.Vector2(0.002, -hh),
    new THREE.Vector2(radius * 0.86, -hh),
    new THREE.Vector2(radius, -hh + 0.01),
    new THREE.Vector2(radius, hh - 0.012),
    new THREE.Vector2(radius * 0.88, hh),
    new THREE.Vector2(radius * 0.82, hh - 0.005),
    new THREE.Vector2(0.002, hh - 0.005),
  ];
  return new THREE.LatheGeometry(pts, 10);
}

function buildPaperSheetGeometry(): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(0.24, 0.31, 3, 3);
  geo.rotateX(-Math.PI * 0.5);
  // Subtle corner curl starting cleanly from y = 0 at center so resting sheets sit razor-flush
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const edgeDist = Math.hypot(x * 3.8, z * 3.0);
    pos.setY(i, Math.min(0.0024, edgeDist * edgeDist * 0.0018));
  }
  geo.computeVertexNormals();
  return geo;
}

function buildGlassShardGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -0.024, 0, -0.014,
     0.031, 0, -0.008,
     0.004, 0.005, 0.028,
    -0.024, 0, -0.014,
     0.004, 0.005, 0.028,
    -0.012, -0.004, 0.018,
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  return geo;
}

function applyPaperWindFlutterShader(
  material: THREE.MeshStandardMaterial,
  uniforms: PaperWindUniforms,
): void {
  material.customProgramCacheKey = () => 'axon_dynamic_paper_flutter_v2';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        `,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float edgeMask = clamp(length(position.xz) * 5.2, 0.0, 1.0);
        #ifdef USE_INSTANCING
          float phase = instanceMatrix[3].x * 2.13 + instanceMatrix[3].z * 1.79 + instanceMatrix[3].y * 3.4;
        #else
          float phase = 0.0;
        #endif
        float windLift = clamp(uWindStrength, 0.0, 2.2);
        float flutter = 0.5 + 0.5 * sin(uTime * (4.2 + windLift * 5.2) + phase + position.x * 16.0 + position.z * 12.0);
        float curl = 0.5 + 0.5 * cos(uTime * 2.3 + phase * 0.7 + position.z * 9.0);
        // Upward-only corner flutter proportional to wind so resting sheets stay flush on surfaces
        transformed.y += (flutter * 0.009 + curl * 0.004) * edgeMask * windLift;
        `,
      );
  };
  material.needsUpdate = true;
}

/**
 * Unified GPU-instanced 6-DOF rigid-body + aerodynamic wind-paper physics prop engine.
 * Runs across every mode (Hideout, Zombies Outpost, Open World, Combat, Infection, Gym, Tutorial)
 * with zero per-frame allocations, O(1) spatial-hash gunfire/footstep queries, glass shatter pools,
 * can denting, wind-reactive papers, distance sleep culling, and quality-preset budgets.
 */
export class DynamicPhysicsPropSystem {
  private readonly scene: THREE.Scene;
  private readonly adapter: DynamicPropWorldAdapter;
  private readonly isSoftwareGl: boolean;
  private readonly onImpactAudio?: (
    kind: PhysicsPropAudioKind,
    pos: Readonly<THREE.Vector3>,
    intensity: number,
  ) => void;
  private readonly indoorVentilationDraft: boolean;

  private budget: PhysicsPropBudgetSpec;
  private readonly rootGroup = new THREE.Group();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTex: THREE.Texture[] = [];

  private readonly meshes = new Map<DynamicPropArchetype, THREE.InstancedMesh>();
  private readonly capacities = new Map<DynamicPropArchetype, number>();
  private readonly freeSlots = new Map<DynamicPropArchetype, number[]>();
  private readonly dirtyArchetypes = new Set<DynamicPropArchetype>();

  private readonly bodies: PropBody[] = [];
  private readonly freeBodyIds: number[] = [];
  private readonly cellBuckets = new Map<number, number[]>();

  private shardMesh!: THREE.InstancedMesh;
  private readonly shards: GlassShardBody[] = [];
  private shardCursor = 0;
  private shardsDirty = false;

  private readonly paperWindUniforms: PaperWindUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.84, 0.54).normalize() },
    uWindStrength: { value: 0.25 },
  };
  private windDirX = 0.84;
  private windDirZ = 0.54;
  private windStrength = 0.25;
  private elapsedSec = 0;
  private windWakeCursor = 0;
  private activeCount = 0;
  private paperCount = 0;

  constructor(opts: DynamicPhysicsPropOptions) {
    this.scene = opts.scene;
    this.adapter = opts.adapter;
    this.isSoftwareGl = Boolean(opts.isSoftwareGl);
    this.onImpactAudio = opts.onImpactAudio;
    this.indoorVentilationDraft = Boolean(opts.indoorVentilationDraft);

    const baseBudget = resolvePhysicsPropBudget(opts.graphicsQuality);
    this.budget = {
      ...baseBudget,
      ...(opts.budgetOverride ?? {}),
    };

    this.rootGroup.name = 'dynamic_physics_props_root';
    this.scene.add(this.rootGroup);

    const aniso = opts.maxAniso ?? 4;
    this.initInstancedMeshes(aniso);
  }

  private initInstancedMeshes(maxAniso: number): void {
    const totalCap = Math.max(32, this.budget.maxTotalProps);
    const paperCap = Math.max(12, Math.min(totalCap, this.budget.maxWindPapers));
    const bottleCap = Math.max(12, Math.ceil(totalCap * 0.22));
    const canCap = Math.max(12, Math.ceil(totalCap * 0.22));
    const boxCap = Math.max(8, Math.ceil(totalCap * 0.14));

    const capByKind: Record<DynamicPropArchetype, number> = {
      glass_bottle_green: bottleCap,
      glass_bottle_amber: bottleCap,
      soda_can: canCap,
      ration_tin: Math.max(10, Math.ceil(canCap * 0.75)),
      paper_sheet: paperCap,
      cardboard_box: boxCap,
      plastic_crate: Math.max(8, Math.ceil(boxCap * 0.7)),
    };

    const paperTex = createPaperDossierTexture(maxAniso);
    const sodaTex = createCanLabelTexture('soda', maxAniso);
    const rationTex = createCanLabelTexture('ration', maxAniso);
    const boxTex = createCardboardTexture(maxAniso);
    for (const t of [paperTex, sodaTex, rationTex, boxTex]) {
      if (t) this.ownedTex.push(t);
    }

    const bottleGeo = buildBottleGeometry();
    const sodaGeo = buildCanGeometry(0.034, 0.125);
    const rationGeo = buildCanGeometry(0.052, 0.095);
    const paperGeo = buildPaperSheetGeometry();
    const boxGeo = new THREE.BoxGeometry(0.36, 0.28, 0.28);
    const crateGeo = new THREE.BoxGeometry(0.42, 0.26, 0.32);
    this.ownedGeos.push(bottleGeo, sodaGeo, rationGeo, paperGeo, boxGeo, crateGeo);

    const makeGlassMat = (hex: number): THREE.MeshPhysicalMaterial =>
      new THREE.MeshPhysicalMaterial({
        color: hex,
        roughness: 0.12,
        metalness: 0.05,
        clearcoat: this.isSoftwareGl ? 0.0 : 0.9,
        clearcoatRoughness: 0.08,
        transparent: true,
        opacity: 0.78,
        envMapIntensity: 1.35,
      });

    const paperMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: paperTex ?? undefined,
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    applyPaperWindFlutterShader(paperMat, this.paperWindUniforms);

    const matByKind: Record<DynamicPropArchetype, THREE.Material> = {
      glass_bottle_green: makeGlassMat(0x2e6b3e),
      glass_bottle_amber: makeGlassMat(0x8c4c1b),
      soda_can: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: sodaTex ?? undefined,
        roughness: 0.28,
        metalness: 0.74,
      }),
      ration_tin: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: rationTex ?? undefined,
        roughness: 0.38,
        metalness: 0.62,
      }),
      paper_sheet: paperMat,
      cardboard_box: new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: boxTex ?? undefined,
        roughness: 0.9,
        metalness: 0.02,
      }),
      plastic_crate: new THREE.MeshStandardMaterial({
        color: 0x3b4844,
        roughness: 0.52,
        metalness: 0.14,
      }),
    };

    const geoByKind: Record<DynamicPropArchetype, THREE.BufferGeometry> = {
      glass_bottle_green: bottleGeo,
      glass_bottle_amber: bottleGeo,
      soda_can: sodaGeo,
      ration_tin: rationGeo,
      paper_sheet: paperGeo,
      cardboard_box: boxGeo,
      plastic_crate: crateGeo,
    };

    const castShadows = !this.isSoftwareGl && this.budget.enablePropShadows;

    for (const kind of ARCHETYPES) {
      const cap = capByKind[kind];
      const mat = matByKind[kind];
      this.ownedMats.push(mat);

      const im = new THREE.InstancedMesh(geoByKind[kind], mat, cap);
      im.name = `physics_prop_${kind}`;
      im.frustumCulled = false;
      im.castShadow = castShadows && kind !== 'paper_sheet';
      im.receiveShadow = !this.isSoftwareGl;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const slots: number[] = [];
      for (let i = cap - 1; i >= 0; i--) {
        im.setMatrixAt(i, _zeroMatrix);
        slots.push(i);
      }
      im.instanceMatrix.needsUpdate = true;

      this.rootGroup.add(im);
      this.meshes.set(kind, im);
      this.capacities.set(kind, cap);
      this.freeSlots.set(kind, slots);
    }

    // Pooled instanced glass shards (white base mat so per-instance color matches green/amber bottle)
    const shardCap = Math.max(32, this.budget.maxGlassShards);
    const shardGeo = buildGlassShardGeometry();
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.15,
      transparent: true,
      opacity: 0.84,
      side: THREE.DoubleSide,
    });
    this.ownedGeos.push(shardGeo);
    this.ownedMats.push(shardMat);

    this.shardMesh = new THREE.InstancedMesh(shardGeo, shardMat, shardCap);
    this.shardMesh.name = 'physics_prop_glass_shards';
    this.shardMesh.frustumCulled = false;
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < shardCap; i++) {
      this.shardMesh.setMatrixAt(i, _zeroMatrix);
      this.shards.push({
        active: false,
        x: 0,
        y: -100,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        vrx: 0,
        vry: 0,
        vrz: 0,
        scale: 1,
        age: 0,
        sleeping: true,
      });
    }
    this.shardMesh.instanceMatrix.needsUpdate = true;
    this.rootGroup.add(this.shardMesh);
  }

  public getBudget(): Readonly<PhysicsPropBudgetSpec> {
    return this.budget;
  }

  public getActivePropCount(): number {
    return this.activeCount;
  }

  public getAwakeBodyCount(): number {
    let n = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.active && !b.shattered && !b.sleeping) n++;
    }
    return n;
  }

  public getActiveShardCount(): number {
    let n = 0;
    for (let i = 0; i < this.shards.length; i++) {
      if (this.shards[i].active) n++;
    }
    return n;
  }

  public getPropSnapshot(index: number): Readonly<PropBody> | null {
    const b = this.bodies[index];
    return b && b.active ? b : null;
  }

  public setWind(dirX: number, dirZ: number, strength: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-4) {
      this.windDirX = dirX / len;
      this.windDirZ = dirZ / len;
    }
    this.windStrength = THREE.MathUtils.clamp(strength, 0, 2.5);
    this.paperWindUniforms.uWindDir.value.set(this.windDirX, this.windDirZ);
    this.paperWindUniforms.uWindStrength.value = this.windStrength;
  }

  private sampleSupport(x: number, maxSurfaceY: number, z: number, out: DynamicPropSupportSample): void {
    if (this.adapter.sampleSupportSurface) {
      this.adapter.sampleSupportSurface(x, maxSurfaceY, z, out);
      return;
    }
    out.height = this.adapter.sampleSupportHeight(x, maxSurfaceY, z);
    out.surface = 'concrete';
  }

  public spawnProp(spec: DynamicPropSpawnSpec): number {
    if (this.activeCount >= this.budget.maxTotalProps) return -1;
    if (spec.kind === 'paper_sheet' && this.paperCount >= this.budget.maxWindPapers) return -1;

    const slots = this.freeSlots.get(spec.kind);
    if (!slots || slots.length === 0) return -1;
    const instanceIdx = slots.pop()!;

    const metrics = ARCHETYPE_METRICS[spec.kind];
    const scale = THREE.MathUtils.clamp(spec.scale ?? 1.0, 0.72, 1.38);

    _euler.set(spec.pitch ?? 0, spec.yaw ?? 0, spec.roll ?? 0, 'YXZ');
    _quat.setFromEuler(_euler);

    // Exact 3D orientation-aware vertical half-extent (fixes hovering tipped cans, boxes & papers)
    const orientedHalfH = computeOrientedHalfExtentY(
      metrics,
      _quat.x,
      _quat.y,
      _quat.z,
      _quat.w,
      scale,
      scale,
      scale,
    );
    const orientedRad = computeOrientedHorizRadius(
      metrics,
      _quat.x,
      _quat.y,
      _quat.z,
      _quat.w,
      scale,
      scale,
      scale,
    );

    // True downward support probe — never holds props artificially floating above the surface!
    let px = spec.x;
    let pz = spec.z;
    this.sampleSupport(px, spec.y + 0.24, pz, _supportScratch);
    let groundedY = _supportScratch.height + orientedHalfH;

    // Micro-depenetration on spawn so props placed near wall/shelf edges never start clipped inside geometry
    if (this.adapter.resolveSolidCollision) {
      for (let iter = 0; iter < 3; iter++) {
        if (
          !this.adapter.resolveSolidCollision(
            px,
            groundedY,
            pz,
            orientedRad,
            orientedHalfH,
            _solidHitScratch,
          )
        ) {
          break;
        }
        px += _solidHitScratch.pushX;
        groundedY += _solidHitScratch.pushY;
        pz += _solidHitScratch.pushZ;
      }
      // Re-snap flush onto the true solid support below after any horizontal edge push-out
      this.sampleSupport(px, groundedY - orientedHalfH + 0.14, pz, _supportScratch);
      groundedY = _supportScratch.height + orientedHalfH;
    }

    const indoor = this.adapter.isIndoor
      ? this.adapter.isIndoor(px, groundedY + 0.25, pz)
      : false;

    const cellKey = packCellKey(
      Math.floor(px * INV_CELL_SIZE),
      Math.floor(pz * INV_CELL_SIZE),
    );

    let bodyId: number;
    let body: PropBody;
    if (this.freeBodyIds.length > 0) {
      bodyId = this.freeBodyIds.pop()!;
      body = this.bodies[bodyId];
      body.active = true;
      body.kind = spec.kind;
      body.instanceIdx = instanceIdx;
      body.ownerTag = spec.ownerTag ?? '';
      body.x = px;
      body.y = groundedY;
      body.z = pz;
      body.spawnX = px;
      body.spawnY = groundedY;
      body.spawnZ = pz;
      body.vx = 0;
      body.vy = 0;
      body.vz = 0;
      body.qx = _quat.x;
      body.qy = _quat.y;
      body.qz = _quat.z;
      body.qw = _quat.w;
      body.wx = 0;
      body.wy = 0;
      body.wz = 0;
      body.scale = scale;
      body.dentScaleX = 1;
      body.dentScaleY = 1;
      body.dentScaleZ = 1;
      body.sleeping = true;
      body.sleepTimer = 0;
      body.shattered = false;
      body.dented = false;
      body.indoor = indoor;
      body.windPhase = (px * 1.73 + pz * 2.19) % 6.283;
      body.audioCooldown = 0;
      body.cellKey = cellKey;
    } else {
      bodyId = this.bodies.length;
      body = {
        id: bodyId,
        active: true,
        kind: spec.kind,
        instanceIdx,
        ownerTag: spec.ownerTag ?? '',
        x: px,
        y: groundedY,
        z: pz,
        spawnX: px,
        spawnY: groundedY,
        spawnZ: pz,
        vx: 0,
        vy: 0,
        vz: 0,
        qx: _quat.x,
        qy: _quat.y,
        qz: _quat.z,
        qw: _quat.w,
        wx: 0,
        wy: 0,
        wz: 0,
        scale,
        dentScaleX: 1,
        dentScaleY: 1,
        dentScaleZ: 1,
        sleeping: true,
        sleepTimer: 0,
        shattered: false,
        dented: false,
        indoor,
        windPhase: (px * 1.73 + pz * 2.19) % 6.283,
        audioCooldown: 0,
        cellKey,
      };
      this.bodies.push(body);
    }

    this.addToCell(cellKey, bodyId);
    this.activeCount++;
    if (spec.kind === 'paper_sheet') this.paperCount++;

    // Subtle per-instance color tint variation for organic realism
    const im = this.meshes.get(spec.kind)!;
    const tint = 0.88 + (Math.abs(Math.sin(px * 12.989 + pz * 78.233)) % 0.2);
    if (spec.kind === 'soda_can') {
      const palette = [0xd84339, 0x3b72a6, 0x3a8c58, 0xd49b2f];
      const pick = palette[Math.abs(Math.floor(px * 3 + pz * 5)) % palette.length];
      _tmpColor.setHex(pick).multiplyScalar(0.95);
    } else if (spec.kind === 'paper_sheet') {
      _tmpColor.setRGB(tint, tint * 0.98, tint * 0.93);
    } else {
      _tmpColor.setRGB(tint, tint, tint);
    }
    im.setColorAt(instanceIdx, _tmpColor);
    if (im.instanceColor) im.instanceColor.needsUpdate = true;

    this.writeBodyMatrix(body);
    return bodyId;
  }

  /**
   * Silent spawn-time overlap separation & flush grounding settle pass.
   * Ensures clustered props never start intersecting each other or hovering above their support surface.
   */
  public settleSpawnedProps(bodyIds?: readonly number[]): void {
    const count = bodyIds ? bodyIds.length : this.bodies.length;
    for (let i = 0; i < count; i++) {
      const b = this.bodies[bodyIds ? bodyIds[i] : i];
      if (!b || !b.active || b.shattered || b.kind === 'paper_sheet') continue;

      const mA = ARCHETYPE_METRICS[b.kind];
      const rA = computeOrientedHorizRadius(
        mA,
        b.qx,
        b.qy,
        b.qz,
        b.qw,
        b.scale * b.dentScaleX,
        b.scale * b.dentScaleY,
        b.scale * b.dentScaleZ,
      );
      const hhA = computeOrientedHalfExtentY(
        mA,
        b.qx,
        b.qy,
        b.qz,
        b.qw,
        b.scale * b.dentScaleX,
        b.scale * b.dentScaleY,
        b.scale * b.dentScaleZ,
      );

      const cx = Math.floor(b.x * INV_CELL_SIZE);
      const cz = Math.floor(b.z * INV_CELL_SIZE);
      let moved = false;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = this.cellBuckets.get(packCellKey(cx + ox, cz + oz));
          if (!bucket) continue;
          for (let j = 0; j < bucket.length; j++) {
            const other = this.bodies[bucket[j]];
            if (other.id <= b.id || !other.active || other.shattered || other.kind === 'paper_sheet') {
              continue;
            }
            const mB = ARCHETYPE_METRICS[other.kind];
            const hhB = computeOrientedHalfExtentY(
              mB,
              other.qx,
              other.qy,
              other.qz,
              other.qw,
              other.scale * other.dentScaleX,
              other.scale * other.dentScaleY,
              other.scale * other.dentScaleZ,
            );
            if (Math.abs(b.y - other.y) >= hhA + hhB - 0.005) continue;

            const rB = computeOrientedHorizRadius(
              mB,
              other.qx,
              other.qy,
              other.qz,
              other.qw,
              other.scale * other.dentScaleX,
              other.scale * other.dentScaleY,
              other.scale * other.dentScaleZ,
            );
            const dx = other.x - b.x;
            const dz = other.z - b.z;
            const minDist = rA + rB + 0.004;
            const dSq = dx * dx + dz * dz;
            if (dSq >= minDist * minDist) continue;

            const dist = Math.sqrt(dSq);
            const nx = dist > 1e-4 ? dx / dist : 1;
            const nz = dist > 1e-4 ? dz / dist : 0;
            const push = (minDist - dist) * 0.5;
            b.x -= nx * push;
            b.z -= nz * push;
            other.x += nx * push;
            other.z += nz * push;
            moved = true;

            this.sampleSupport(other.x, other.y - hhB + 0.12, other.z, _supportScratch);
            other.y = _supportScratch.height + hhB;
            this.updateBodyCell(other);
            this.writeBodyMatrix(other);
          }
        }
      }
      if (moved) {
        this.sampleSupport(b.x, b.y - hhA + 0.12, b.z, _supportScratch);
        b.y = _supportScratch.height + hhA;
        this.updateBodyCell(b);
        this.writeBodyMatrix(b);
      }
    }
    this.flushDirtyMatrices();
  }

  public spawnBatch(specs: readonly DynamicPropSpawnSpec[]): number {
    const spawnedIds: number[] = [];
    for (let i = 0; i < specs.length; i++) {
      const id = this.spawnProp(specs[i]);
      if (id >= 0) spawnedIds.push(id);
    }
    if (spawnedIds.length > 1) {
      this.settleSpawnedProps(spawnedIds);
    } else {
      this.flushDirtyMatrices();
    }
    return spawnedIds.length;
  }

  /**
   * Deterministic natural prop cluster seeder for tabletops, shelves, bars, range ledges,
   * corridors, loading docks, and windy streets.
   */
  public seedCluster(
    preset: PropClusterPreset,
    cx: number,
    surfaceY: number,
    cz: number,
    seed: number,
    ownerTag?: string,
  ): number {
    const rand = seededRand(seed);
    const specs: DynamicPropSpawnSpec[] = [];

    if (preset === 'desk_clutter') {
      specs.push(
        { kind: 'paper_sheet', x: cx - 0.24, y: surfaceY, z: cz + 0.06, yaw: (rand() - 0.5) * 0.6, ownerTag },
        { kind: 'paper_sheet', x: cx - 0.14, y: surfaceY + 0.004, z: cz - 0.08, yaw: (rand() - 0.5) * 0.9, ownerTag },
        { kind: 'soda_can', x: cx + 0.3, y: surfaceY, z: cz - 0.12, yaw: rand() * Math.PI * 2, ownerTag },
        {
          kind: rand() > 0.45 ? 'glass_bottle_amber' : 'glass_bottle_green',
          x: cx + 0.44,
          y: surfaceY,
          z: cz + 0.14,
          yaw: rand() * Math.PI * 2,
          ownerTag,
        },
      );
    } else if (preset === 'bar_bottles' || preset === 'range_ledge') {
      const count = preset === 'range_ledge' ? 5 : 4;
      for (let i = 0; i < count; i++) {
        const ox = (i - (count - 1) * 0.5) * 0.26 + (rand() - 0.5) * 0.04;
        const oz = (rand() - 0.5) * 0.12;
        const kind: DynamicPropArchetype =
          i % 3 === 0
            ? 'glass_bottle_green'
            : i % 3 === 1
              ? 'glass_bottle_amber'
              : 'soda_can';
        specs.push({ kind, x: cx + ox, y: surfaceY, z: cz + oz, yaw: rand() * 6.28, ownerTag });
      }
    } else if (preset === 'bunker_mess') {
      specs.push(
        { kind: 'ration_tin', x: cx - 0.22, y: surfaceY, z: cz + 0.12, yaw: rand() * 6.28, ownerTag },
        { kind: 'soda_can', x: cx + 0.18, y: surfaceY, z: cz - 0.1, yaw: rand() * 6.28, ownerTag },
        { kind: 'glass_bottle_green', x: cx + 0.34, y: surfaceY, z: cz + 0.18, yaw: rand() * 6.28, ownerTag },
        { kind: 'paper_sheet', x: cx - 0.04, y: surfaceY, z: cz - 0.16, yaw: rand() * 6.28, ownerTag },
      );
    } else if (preset === 'floor_trash') {
      specs.push(
        { kind: 'paper_sheet', x: cx + (rand() - 0.5) * 1.4, y: surfaceY, z: cz + (rand() - 0.5) * 1.4, yaw: rand() * 6.28, ownerTag },
        { kind: 'soda_can', x: cx + (rand() - 0.5) * 1.1, y: surfaceY, z: cz + (rand() - 0.5) * 1.1, yaw: rand() * 6.28, roll: Math.PI * 0.5, ownerTag },
        { kind: rand() > 0.5 ? 'glass_bottle_green' : 'glass_bottle_amber', x: cx + (rand() - 0.5) * 1.2, y: surfaceY, z: cz + (rand() - 0.5) * 1.2, yaw: rand() * 6.28, ownerTag },
      );
    } else if (preset === 'loading_dock') {
      specs.push(
        { kind: 'cardboard_box', x: cx - 0.35, y: surfaceY, z: cz + 0.15, yaw: rand() * 0.6, ownerTag },
        { kind: 'plastic_crate', x: cx + 0.38, y: surfaceY, z: cz - 0.22, yaw: rand() * 0.5, ownerTag },
        { kind: 'ration_tin', x: cx + 0.02, y: surfaceY, z: cz + 0.44, yaw: rand() * 6.28, ownerTag },
        { kind: 'paper_sheet', x: cx - 0.55, y: surfaceY, z: cz - 0.42, yaw: rand() * 6.28, ownerTag },
      );
    } else {
      // wind_street_papers
      for (let i = 0; i < 4; i++) {
        specs.push({
          kind: i < 3 ? 'paper_sheet' : 'soda_can',
          x: cx + (rand() - 0.5) * 4.5,
          y: surfaceY,
          z: cz + (rand() - 0.5) * 4.5,
          yaw: rand() * Math.PI * 2,
          roll: i === 3 ? Math.PI * 0.5 : 0,
          ownerTag,
        });
      }
    }

    return this.spawnBatch(specs);
  }

  public removePropsByOwner(ownerTag: string): number {
    if (!ownerTag) return 0;
    let removed = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.active || b.ownerTag !== ownerTag) continue;
      this.releaseBody(b);
      removed++;
    }
    if (removed > 0) this.flushDirtyMatrices();
    return removed;
  }

  private releaseBody(b: PropBody): void {
    this.removeFromCell(b.cellKey, b.id);
    const im = this.meshes.get(b.kind);
    if (im) {
      im.setMatrixAt(b.instanceIdx, _zeroMatrix);
      this.dirtyArchetypes.add(b.kind);
    }
    this.freeSlots.get(b.kind)?.push(b.instanceIdx);
    if (b.kind === 'paper_sheet') this.paperCount = Math.max(0, this.paperCount - 1);
    this.activeCount = Math.max(0, this.activeCount - 1);
    b.active = false;
    b.sleeping = true;
    b.ownerTag = '';
    this.freeBodyIds.push(b.id);
  }

  private addToCell(key: number, id: number): void {
    let arr = this.cellBuckets.get(key);
    if (!arr) {
      arr = [];
      this.cellBuckets.set(key, arr);
    }
    arr.push(id);
  }

  private removeFromCell(key: number, id: number): void {
    const arr = this.cellBuckets.get(key);
    if (!arr) return;
    const idx = arr.indexOf(id);
    if (idx >= 0) {
      arr[idx] = arr[arr.length - 1];
      arr.pop();
      if (arr.length === 0) this.cellBuckets.delete(key);
    }
  }

  private updateBodyCell(b: PropBody): void {
    const nextKey = packCellKey(
      Math.floor(b.x * INV_CELL_SIZE),
      Math.floor(b.z * INV_CELL_SIZE),
    );
    if (nextKey !== b.cellKey) {
      this.removeFromCell(b.cellKey, b.id);
      b.cellKey = nextKey;
      this.addToCell(nextKey, b.id);
    }
  }

  /**
   * Analytical spatial-hash bullet ray hit query.
   * Shatters bottles, dents/launches cans, scatters papers, and rocks crates without blocking lethal bullets.
   */
  public handleBulletRay(
    origin: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    maxDist: number,
    impulseScale = 1.0,
  ): DynamicPropBulletHitResult {
    const clampedDist = Math.min(maxDist, 85);
    const stepM = 1.4;
    const steps = Math.max(1, Math.ceil(clampedDist / stepM));

    let bestIdx = -1;
    let bestT = clampedDist;
    let lastCellKey = -1;

    for (let s = 0; s <= steps; s++) {
      const dist = Math.min(clampedDist, s * stepM);
      const px = origin.x + dir.x * dist;
      const pz = origin.z + dir.z * dist;
      const cx = Math.floor(px * INV_CELL_SIZE);
      const cz = Math.floor(pz * INV_CELL_SIZE);
      const centerKey = packCellKey(cx, cz);
      if (centerKey === lastCellKey) continue;
      lastCellKey = centerKey;

      // Test center and immediate adjacent cells for ray grazing safety
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = this.cellBuckets.get(packCellKey(cx + ox, cz + oz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const b = this.bodies[bucket[i]];
            if (!b.active || b.shattered) continue;
            const metrics = ARCHETYPE_METRICS[b.kind];
            const hitR = Math.max(metrics.radius, metrics.halfHeight) * b.scale * 1.42;

            const ocx = b.x - origin.x;
            const ocy = b.y - origin.y;
            const ocz = b.z - origin.z;
            const tProj = ocx * dir.x + ocy * dir.y + ocz * dir.z;
            if (tProj < 0.08 || tProj >= bestT) continue;

            const dx = ocx - dir.x * tProj;
            const dy = ocy - dir.y * tProj;
            const dz = ocz - dir.z * tProj;
            if (dx * dx + dy * dy + dz * dz <= hitR * hitR) {
              bestT = tProj;
              bestIdx = b.id;
            }
          }
        }
      }
      if (bestIdx >= 0 && bestT < dist + stepM) break;
    }

    if (bestIdx < 0) {
      return { hit: false, propIndex: -1, kind: null, shattered: false, dented: false, point: _hitPoint.set(0, 0, 0) };
    }

    const b = this.bodies[bestIdx];
    const metrics = ARCHETYPE_METRICS[b.kind];
    _hitPoint.set(origin.x + dir.x * bestT, origin.y + dir.y * bestT, origin.z + dir.z * bestT);

    if (metrics.shatterable) {
      this.shatterBottle(b, dir.x, dir.y, dir.z, 4.6 * impulseScale);
      return { hit: true, propIndex: b.id, kind: b.kind, shattered: true, dented: false, point: _hitPoint };
    }

    let newlyDented = false;
    if (metrics.dentable && !b.dented) {
      b.dented = true;
      newlyDented = true;
      b.dentScaleX = 0.72;
      b.dentScaleY = 0.92;
      b.dentScaleZ = 1.18;
    }

    const speed = THREE.MathUtils.clamp((4.8 * impulseScale) / Math.max(0.08, Math.sqrt(metrics.mass)), 2.2, 11.5);
    b.vx += dir.x * speed + (Math.random() - 0.5) * 1.2;
    b.vy += Math.max(1.8, dir.y * speed + 2.4);
    b.vz += dir.z * speed + (Math.random() - 0.5) * 1.2;
    b.wx += (Math.random() - 0.5) * 16;
    b.wy += (Math.random() - 0.5) * 18;
    b.wz += (Math.random() - 0.5) * 16;
    b.sleeping = false;
    b.sleepTimer = 0;

    this.triggerPropAudio(b, metrics.audioBounceKind, 0.95);
    this.writeBodyMatrix(b);
    this.flushDirtyMatrices();

    return { hit: true, propIndex: b.id, kind: b.kind, shattered: false, dented: newlyDented, point: _hitPoint };
  }

  /**
   * Radial shockwave impulse from grenades, mortar shells, or bomber strikes.
   */
  public handleBlast(origin: Readonly<THREE.Vector3>, radius: number, peakForce = 12.0): number {
    const r = Math.max(1.5, radius);
    const rSq = r * r;
    const minCx = Math.floor((origin.x - r) * INV_CELL_SIZE);
    const maxCx = Math.floor((origin.x + r) * INV_CELL_SIZE);
    const minCz = Math.floor((origin.z - r) * INV_CELL_SIZE);
    const maxCz = Math.floor((origin.z + r) * INV_CELL_SIZE);

    let affected = 0;
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.cellBuckets.get(packCellKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const b = this.bodies[bucket[i]];
          if (!b.active || b.shattered) continue;

          const dx = b.x - origin.x;
          const dy = b.y - origin.y;
          const dz = b.z - origin.z;
          const dSq = dx * dx + dy * dy + dz * dz;
          if (dSq > rSq) continue;

          const dist = Math.max(0.25, Math.sqrt(dSq));
          const falloff = 1 - dist / r;
          const nx = dx / dist;
          const nz = dz / dist;
          const metrics = ARCHETYPE_METRICS[b.kind];

          if (metrics.shatterable && dist < r * 0.66) {
            this.shatterBottle(b, nx, 0.45, nz, peakForce * falloff * 0.65);
            affected++;
            continue;
          }

          if (metrics.dentable && dist < r * 0.78 && !b.dented) {
            b.dented = true;
            b.dentScaleX = 0.74;
            b.dentScaleY = 0.88;
            b.dentScaleZ = 1.16;
          }

          const massFactor = 1.0 / Math.max(0.18, Math.sqrt(metrics.mass));
          const impulse = THREE.MathUtils.clamp(peakForce * falloff * falloff * massFactor, 1.2, 15.0);
          b.vx += nx * impulse + (Math.random() - 0.5) * 1.4;
          b.vy += impulse * (b.kind === 'paper_sheet' ? 0.92 : 0.58) + 1.5;
          b.vz += nz * impulse + (Math.random() - 0.5) * 1.4;
          b.wx += (Math.random() - 0.5) * 18 * falloff;
          b.wy += (Math.random() - 0.5) * 18 * falloff;
          b.wz += (Math.random() - 0.5) * 18 * falloff;
          b.sleeping = false;
          b.sleepTimer = 0;

          if (affected < 4) {
            this.triggerPropAudio(b, metrics.audioBounceKind, falloff);
          }
          affected++;
        }
      }
    }
    return affected;
  }

  /**
   * Player footstep / sprint kick and aerodynamic wake on floor-level clutter.
   */
  public applyActorFootstepWake(
    actorFeetPos: Readonly<THREE.Vector3>,
    actorVel: Readonly<THREE.Vector3>,
    actorRadius = 0.52,
  ): void {
    const horizSpeed = Math.hypot(actorVel.x, actorVel.z);
    if (horizSpeed < 0.35) return;

    const cx = Math.floor(actorFeetPos.x * INV_CELL_SIZE);
    const cz = Math.floor(actorFeetPos.z * INV_CELL_SIZE);
    const kickR = actorRadius + 0.34;
    const kickRSq = kickR * kickR;
    const wakeR = actorRadius + 0.95;
    const wakeRSq = wakeR * wakeR;

    const dirX = actorVel.x / horizSpeed;
    const dirZ = actorVel.z / horizSpeed;

    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bucket = this.cellBuckets.get(packCellKey(cx + ox, cz + oz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const b = this.bodies[bucket[i]];
          if (!b.active || b.shattered) continue;

          const dy = b.y - actorFeetPos.y;
          if (dy < -0.25 || dy > 1.15) continue;

          const dx = b.x - actorFeetPos.x;
          const dz = b.z - actorFeetPos.z;
          const dSq = dx * dx + dz * dz;

          if (b.kind === 'paper_sheet' && dSq < wakeRSq) {
            // Aerodynamic boot slipstream lifts & flutters loose floor papers
            const strength = (1 - Math.sqrt(dSq) / wakeR) * Math.min(1.6, horizSpeed * 0.32);
            b.vx += dirX * strength * 1.45 + (Math.random() - 0.5) * 0.45;
            b.vy += 0.45 + strength * 0.72;
            b.vz += dirZ * strength * 1.45 + (Math.random() - 0.5) * 0.45;
            b.wx += (Math.random() - 0.5) * 5.0;
            b.wy += (Math.random() - 0.5) * 6.5;
            b.sleeping = false;
            b.sleepTimer = 0;
            this.triggerPropAudio(b, 'paper_rustle', Math.min(0.6, strength));
            continue;
          }

          if (dSq < kickRSq && dy < 0.75) {
            const dist = Math.max(0.06, Math.sqrt(dSq));
            const pushX = dx / dist;
            const pushZ = dz / dist;
            const metrics = ARCHETYPE_METRICS[b.kind];
            const kickImpulse = THREE.MathUtils.clamp(
              (horizSpeed * 0.78) / Math.max(0.32, Math.sqrt(metrics.mass)),
              0.75,
              5.4,
            );
            b.vx = dirX * kickImpulse * 0.65 + pushX * kickImpulse * 0.55;
            b.vy = Math.max(b.vy, 0.55 + Math.min(1.4, horizSpeed * 0.2));
            b.vz = dirZ * kickImpulse * 0.65 + pushZ * kickImpulse * 0.55;
            b.wx += (Math.random() - 0.5) * 9.0;
            b.wy += (Math.random() - 0.5) * 10.0;
            b.wz += (Math.random() - 0.5) * 9.0;
            b.sleeping = false;
            b.sleepTimer = 0;
            this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.85, horizSpeed * 0.16));
          }
        }
      }
    }
  }

  private shatterBottle(
    b: PropBody,
    dirX: number,
    dirY: number,
    dirZ: number,
    scatterSpeed: number,
  ): void {
    if (b.shattered) return;
    b.shattered = true;
    b.sleeping = true;

    const im = this.meshes.get(b.kind);
    if (im) {
      im.setMatrixAt(b.instanceIdx, _zeroMatrix);
      this.dirtyArchetypes.add(b.kind);
    }

    this.triggerPropAudio(b, 'glass_shatter', 1.0);

    const shardCount = this.isSoftwareGl ? 5 : 9;
    const shardCap = this.shards.length;
    const shardHex = b.kind === 'glass_bottle_amber' ? 0xc97b2c : 0x5db874;
    for (let i = 0; i < shardCount; i++) {
      const idx = this.shardCursor % shardCap;
      this.shardCursor++;
      const sh = this.shards[idx];
      sh.active = true;
      sh.sleeping = false;
      sh.age = 0;
      sh.x = b.x + (Math.random() - 0.5) * 0.05;
      sh.y = b.y + (Math.random() - 0.5) * 0.08;
      sh.z = b.z + (Math.random() - 0.5) * 0.05;
      const spread = 1.1 + Math.random() * 2.1;
      sh.vx = dirX * scatterSpeed * 0.42 + (Math.random() - 0.5) * spread;
      sh.vy = Math.max(0.45, dirY * scatterSpeed * 0.3 + 0.8 + Math.random() * 1.6);
      sh.vz = dirZ * scatterSpeed * 0.42 + (Math.random() - 0.5) * spread;
      sh.rx = Math.random() * Math.PI * 2;
      sh.ry = Math.random() * Math.PI * 2;
      sh.rz = Math.random() * Math.PI * 2;
      sh.vrx = (Math.random() - 0.5) * 18;
      sh.vry = (Math.random() - 0.5) * 18;
      sh.vrz = (Math.random() - 0.5) * 18;
      sh.scale = 0.72 + Math.random() * 0.85;

      const shade = 0.85 + Math.random() * 0.3;
      _tmpColor.setHex(shardHex).multiplyScalar(shade);
      this.shardMesh.setColorAt(idx, _tmpColor);
    }
    if (this.shardMesh.instanceColor) {
      this.shardMesh.instanceColor.needsUpdate = true;
    }
    this.shardsDirty = true;
  }

  private triggerPropAudio(b: PropBody, kind: PhysicsPropAudioKind, intensity: number): void {
    if (!this.onImpactAudio) return;
    if (kind !== 'glass_shatter' && b.audioCooldown > 0) return;
    b.audioCooldown = kind === 'paper_rustle' ? 0.24 : 0.095;
    _pos.set(b.x, b.y, b.z);
    this.onImpactAudio(kind, _pos, intensity);
  }

  /**
   * Resolves prop-vs-prop overlaps and mass-weighted collision impulses using the 2m XZ spatial hash.
   * Wakes sleeping hit neighbors for realistic domino cascades and prevents prop interpenetration.
   */
  private resolvePropToPropCollisions(b: PropBody, metrics: ArchetypeMetrics, radA: number, hhA: number): boolean {
    if (b.kind === 'paper_sheet') return false;
    const cx = Math.floor(b.x * INV_CELL_SIZE);
    const cz = Math.floor(b.z * INV_CELL_SIZE);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const bucket = this.cellBuckets.get(packCellKey(cx + ox, cz + oz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const other = this.bodies[bucket[i]];
          if (other.id === b.id || !other.active || other.shattered || other.kind === 'paper_sheet') {
            continue;
          }

          const mB = ARCHETYPE_METRICS[other.kind];
          const hhB = computeOrientedHalfExtentY(
            mB,
            other.qx,
            other.qy,
            other.qz,
            other.qw,
            other.scale * other.dentScaleX,
            other.scale * other.dentScaleY,
            other.scale * other.dentScaleZ,
          );
          const dy = other.y - b.y;
          const sumH = hhA + hhB;
          if (Math.abs(dy) >= sumH) continue;

          const radB = computeOrientedHorizRadius(
            mB,
            other.qx,
            other.qy,
            other.qz,
            other.qw,
            other.scale * other.dentScaleX,
            other.scale * other.dentScaleY,
            other.scale * other.dentScaleZ,
          );
          const dx = other.x - b.x;
          const dz = other.z - b.z;
          const minDist = radA + radB;
          const dSq = dx * dx + dz * dz;
          if (dSq >= minDist * minDist) continue;

          const dist = Math.sqrt(dSq);
          const nx = dist > 1e-4 ? dx / dist : 1;
          const nz = dist > 1e-4 ? dz / dist : 0;
          const pen = minDist - dist;

          const invMassA = 1 / metrics.mass;
          const invMassB = 1 / mB.mass;
          const invMassSum = invMassA + invMassB;

          // Position separation weighted by inverse mass
          const sepA = pen * (invMassA / invMassSum);
          const sepB = pen * (invMassB / invMassSum);
          b.x -= nx * sepA;
          b.z -= nz * sepA;
          other.x += nx * sepB;
          other.z += nz * sepB;

          // Relative velocity along collision normal
          const rvx = other.vx - b.vx;
          const rvz = other.vz - b.vz;
          const velAlongNormal = rvx * nx + rvz * nz;

          if (velAlongNormal < 0) {
            const impactSpeed = -velAlongNormal;
            const e = Math.min(metrics.restitution, mB.restitution);
            const j = (-(1 + e) * velAlongNormal) / invMassSum;

            b.vx -= j * invMassA * nx;
            b.vz -= j * invMassA * nz;
            other.vx += j * invMassB * nx;
            other.vz += j * invMassB * nz;

            // Slight vertical hop & spin on brisk impact
            if (impactSpeed > 0.6) {
              other.vy = Math.max(other.vy, Math.min(1.4, impactSpeed * 0.22 * (invMassB / invMassSum)));
              b.wy += (Math.random() - 0.5) * impactSpeed * 2.5;
              other.wx += (Math.random() - 0.5) * impactSpeed * 3.0;
              other.wz += (Math.random() - 0.5) * impactSpeed * 3.0;
              this.triggerPropAudio(other, mB.audioBounceKind, Math.min(0.85, impactSpeed * 0.22));
            }

            if (other.sleeping && impactSpeed > 0.18) {
              other.sleeping = false;
              other.sleepTimer = 0;
            }

            // Heavy high-speed impact can shatter glass bottles on collision
            if (metrics.shatterable && impactSpeed > 4.2 && mB.mass >= 0.35) {
              this.shatterBottle(b, -nx, 0.25, -nz, impactSpeed * 0.55);
              return true;
            }
            if (mB.shatterable && impactSpeed > 4.2 && metrics.mass >= 0.35) {
              this.shatterBottle(other, nx, 0.25, nz, impactSpeed * 0.55);
            }
          } else if (other.sleeping && pen > 0.015) {
            other.sleeping = false;
            other.sleepTimer = 0;
          }

          this.updateBodyCell(other);
          this.writeBodyMatrix(other);
        }
      }
    }
    return false;
  }

  /**
   * Main per-frame swept substepped 6-DOF physics, prop-to-prop collision & aerodynamic wind update.
   * Strictly bounded by `budget.maxActiveBodies`, distance-culled beyond 72m, zero GC.
   */
  public update(dt: number, listenerPos?: Readonly<THREE.Vector3>): void {
    const stepDt = Math.min(Math.max(dt, 0.001), 0.045);
    this.elapsedSec += stepDt;
    this.paperWindUniforms.uTime.value = this.elapsedSec;

    const gustWave =
      0.65 +
      0.35 * Math.sin(this.elapsedSec * 0.85) +
      0.22 * Math.sin(this.elapsedSec * 2.17 + 1.1);
    const effectiveWind = this.windStrength * gustWave;

    // Periodically wake a small round-robin slice of outdoor papers so wind gusts visibly sweep them
    const bodyLen = this.bodies.length;
    if (bodyLen > 0 && (effectiveWind > 0.24 || this.indoorVentilationDraft)) {
      const scanCount = Math.min(bodyLen, 10);
      for (let s = 0; s < scanCount; s++) {
        const idx = this.windWakeCursor % bodyLen;
        this.windWakeCursor++;
        const b = this.bodies[idx];
        if (!b.active || b.shattered || !b.sleeping || b.kind !== 'paper_sheet') continue;

        if (listenerPos) {
          const dx = b.x - listenerPos.x;
          const dz = b.z - listenerPos.z;
          if (dx * dx + dz * dz > MAX_SIM_DIST_M * MAX_SIM_DIST_M) continue;
        }

        const localWind = b.indoor
          ? this.indoorVentilationDraft
            ? 0.26
            : effectiveWind * 0.06
          : effectiveWind;
        if (localWind > 0.22) {
          const gustCheck = Math.sin(this.elapsedSec * 1.6 + b.windPhase);
          if (gustCheck > 0.45) {
            b.sleeping = false;
            b.sleepTimer = 0;
            b.vy += 0.22 + localWind * 0.45;
            b.vx += this.windDirX * localWind * 0.72;
            b.vz += this.windDirZ * localWind * 0.72;
          }
        }
      }
    }

    let simulatedBodies = 0;
    const maxActive = this.budget.maxActiveBodies;

    for (let i = 0; i < bodyLen; i++) {
      const b = this.bodies[i];
      if (!b.active || b.shattered) continue;

      if (b.audioCooldown > 0) {
        b.audioCooldown = Math.max(0, b.audioCooldown - stepDt);
      }

      if (b.sleeping) continue;

      if (listenerPos) {
        const dx = b.x - listenerPos.x;
        const dz = b.z - listenerPos.z;
        if (dx * dx + dz * dz > MAX_SIM_DIST_M * MAX_SIM_DIST_M) {
          b.sleeping = true;
          b.vx = b.vy = b.vz = 0;
          b.wx = b.wy = b.wz = 0;
          continue;
        }
      }

      if (simulatedBodies >= maxActive) break;
      simulatedBodies++;

      const metrics = ARCHETYPE_METRICS[b.kind];
      const sx = b.scale * b.dentScaleX;
      const sy = b.scale * b.dentScaleY;
      const sz = b.scale * b.dentScaleZ;

      // Refresh indoor shelter flag periodically when moving
      if (this.adapter.isIndoor) {
        b.indoor = this.adapter.isIndoor(b.x, b.y + 0.18, b.z);
      }

      const localWind = b.indoor
        ? this.indoorVentilationDraft
          ? 0.16
          : effectiveWind * 0.05
        : effectiveWind;

      // Velocity-adaptive swept substep count so fast props never tunnel through thin walls, doors, or shelves
      const curHalfH = computeOrientedHalfExtentY(metrics, b.qx, b.qy, b.qz, b.qw, sx, sy, sz);
      const curRad = computeOrientedHorizRadius(metrics, b.qx, b.qy, b.qz, b.qw, sx, sy, sz);
      const speedEst = Math.hypot(b.vx, b.vy, b.vz);
      const maxStepDisp = Math.max(0.032, Math.min(curRad, Math.max(curHalfH, 0.04)) * 0.85);
      const substeps = Math.min(4, Math.max(1, Math.ceil((speedEst * stepDt) / maxStepDisp)));
      const subDt = stepDt / substeps;

      let onGround = false;
      let destroyed = false;

      for (let sub = 0; sub < substeps; sub++) {
        // 1. Earth gravity + aerodynamic drag/lift
        if (b.kind === 'paper_sheet') {
          const airGravity = GRAVITY * 0.22;
          b.vy += airGravity * subDt;

          const swirl = Math.sin(this.elapsedSec * 3.1 + b.windPhase + b.x * 0.55);
          const lateralX = -this.windDirZ;
          const lateralZ = this.windDirX;

          if (localWind > 0.08) {
            const targetVx =
              this.windDirX * localWind * metrics.windDrag + lateralX * swirl * localWind * 0.85;
            const targetVz =
              this.windDirZ * localWind * metrics.windDrag + lateralZ * swirl * localWind * 0.85;
            b.vx += (targetVx - b.vx) * Math.min(1, subDt * 3.2);
            b.vz += (targetVz - b.vz) * Math.min(1, subDt * 3.2);

            const liftImpulse = Math.max(0, swirl + 0.35) * localWind * metrics.windLift;
            b.vy += liftImpulse * subDt * 1.9;
            b.wx += swirl * localWind * 4.5 * subDt;
            b.wy += Math.cos(this.elapsedSec * 2.4 + b.windPhase) * 3.2 * localWind * subDt;
            b.wz += Math.cos(this.elapsedSec * 2.8 + b.windPhase) * 4.0 * localWind * subDt;
          }

          if (b.vy < -1.45) b.vy = -1.45;
          const drag = Math.pow(0.72, subDt);
          b.vx *= drag;
          b.vz *= drag;

          // Soft spawn-zone leash so outdoor wind-blown papers swirl cleanly without leaving map bounds
          const leashDx = b.x - b.spawnX;
          const leashDz = b.z - b.spawnZ;
          if (leashDx * leashDx + leashDz * leashDz > 18 * 18) {
            b.x = b.spawnX + (Math.random() - 0.5) * 1.4;
            b.z = b.spawnZ + (Math.random() - 0.5) * 1.4;
            b.y = b.spawnY + 0.18;
            b.vx *= 0.25;
            b.vy = 0.12;
            b.vz *= 0.25;
          }
        } else {
          b.vy += GRAVITY * subDt;
          if (localWind > 0.55 && metrics.windDrag > 0.1) {
            b.vx += this.windDirX * localWind * metrics.windDrag * subDt * 1.5;
            b.vz += this.windDirZ * localWind * metrics.windDrag * subDt * 1.5;
          }
        }

        // 2. Integrate linear & angular motion
        b.x += b.vx * subDt;
        b.y += b.vy * subDt;
        b.z += b.vz * subDt;

        const angSpeed = Math.hypot(b.wx, b.wy, b.wz);
        if (angSpeed > 1e-4) {
          const halfAngle = angSpeed * subDt * 0.5;
          const s = Math.sin(halfAngle) / angSpeed;
          _deltaQuat.set(b.wx * s, b.wy * s, b.wz * s, Math.cos(halfAngle));
          _quat.set(b.qx, b.qy, b.qz, b.qw).premultiply(_deltaQuat).normalize();
          b.qx = _quat.x;
          b.qy = _quat.y;
          b.qz = _quat.z;
          b.qw = _quat.w;
        }

        const halfH = computeOrientedHalfExtentY(metrics, b.qx, b.qy, b.qz, b.qw, sx, sy, sz);
        const rad = computeOrientedHorizRadius(metrics, b.qx, b.qy, b.qz, b.qw, sx, sy, sz);

        // 3. Full 3D solid world sweep (walls, ceilings, floors, furniture sides, shelf undersides, doors)
        if (this.adapter.resolveSolidCollision) {
          for (let pass = 0; pass < 3; pass++) {
            if (!this.adapter.resolveSolidCollision(b.x, b.y, b.z, rad, halfH, _solidHitScratch)) {
              break;
            }
            b.x += _solidHitScratch.pushX;
            b.y += _solidHitScratch.pushY;
            b.z += _solidHitScratch.pushZ;

            const nx = _solidHitScratch.normalX;
            const ny = _solidHitScratch.normalY;
            const nz = _solidHitScratch.normalZ;
            const vn = b.vx * nx + b.vy * ny + b.vz * nz;

            if (ny > 0.6) {
              onGround = true;
            }

            if (vn < 0) {
              const impactSpeed = -vn;
              if (metrics.shatterable) {
                const threshold = computeGlassShatterThreshold(_solidHitScratch.surface);
                // Horizontal wall impacts break slightly above vertical drop threshold due to glancing angles
                const effectiveThreshold = Math.abs(ny) > 0.55 ? threshold : threshold * 1.08;
                if (impactSpeed >= effectiveThreshold) {
                  this.shatterBottle(b, nx, Math.max(0.15, ny * 0.5), nz, impactSpeed * 0.55);
                  destroyed = true;
                  break;
                }
              }

              const rest = impactSpeed > 0.38 ? metrics.restitution : 0;
              const bounce = 1 + rest;
              b.vx -= bounce * vn * nx;
              b.vy -= bounce * vn * ny;
              b.vz -= bounce * vn * nz;

              // Tangential friction on solid wall/ceiling/top contact
              const tx = b.vx - (b.vx * nx + b.vy * ny + b.vz * nz) * nx;
              const ty = b.vy - (b.vx * nx + b.vy * ny + b.vz * nz) * ny;
              const tz = b.vz - (b.vx * nx + b.vy * ny + b.vz * nz) * nz;
              const tangDrag = Math.min(0.45, metrics.groundFriction * 0.35);
              b.vx -= tx * tangDrag;
              b.vy -= ty * tangDrag;
              b.vz -= tz * tangDrag;

              if (impactSpeed > 0.55) {
                b.wx += (Math.random() - 0.5) * impactSpeed * 1.6;
                b.wy += (Math.random() - 0.5) * impactSpeed * 1.8;
                b.wz += (Math.random() - 0.5) * impactSpeed * 1.6;
                this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.95, impactSpeed * 0.2));
              }
            }
          }
          if (destroyed) break;
        } else if (this.adapter.resolveHorizontalHit) {
          if (this.adapter.resolveHorizontalHit(b.x, b.y, b.z, rad, _normal)) {
            const vn = b.vx * _normal.x + b.vz * _normal.z;
            if (vn < 0) {
              const impactSpeed = -vn;
              if (metrics.shatterable && impactSpeed >= computeGlassShatterThreshold('concrete') * 1.08) {
                this.shatterBottle(b, _normal.x, 0.2, _normal.z, impactSpeed * 0.55);
                destroyed = true;
                break;
              }
              const bounce = 1 + metrics.restitution;
              b.vx -= bounce * vn * _normal.x;
              b.vz -= bounce * vn * _normal.z;
              b.x += _normal.x * (rad * 0.35);
              b.z += _normal.z * (rad * 0.35);
              b.wy += (Math.random() - 0.5) * impactSpeed * 2.0;
              if (impactSpeed > 0.7) {
                this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.95, impactSpeed * 0.2));
              }
            }
          }
        }

        // 4. Support terrain / ramp / floor / tabletop / shelf landing check (with surface material!)
        this.sampleSupport(b.x, b.y - halfH + 0.16, b.z, _supportScratch);
        const minCenterY = _supportScratch.height + halfH;

        if (b.y <= minCenterY + 0.001) {
          onGround = true;
          const impactVy = -b.vy;
          b.y = minCenterY;

          if (metrics.shatterable && impactVy >= computeGlassShatterThreshold(_supportScratch.surface)) {
            this.shatterBottle(b, b.vx * 0.18, 0.35, b.vz * 0.18, impactVy * 0.52);
            destroyed = true;
            break;
          }

          if (impactVy > 0.42 && metrics.restitution > 0.04) {
            b.vy = impactVy * metrics.restitution;
            const tumble = Math.min(6.0, impactVy * (1.25 - metrics.groundFriction * 0.4));
            b.wx += (Math.random() - 0.5) * tumble;
            b.wz += (Math.random() - 0.5) * tumble;
            this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.92, impactVy * 0.21));
          } else {
            b.vy = 0;
          }

          // Ground friction & resting angular damping
          const fric = Math.pow(1 - metrics.groundFriction * 0.78, subDt * 6.5);
          b.vx *= fric;
          b.vz *= fric;
          const angFric = Math.pow(metrics.angularDamping, subDt * 60);
          b.wx *= angFric;
          b.wy *= angFric;
          b.wz *= angFric;

          // Natural resting orientation settle when almost stationary on floor/table
          const horizSpdSq = b.vx * b.vx + b.vz * b.vz;
          if (b.kind === 'paper_sheet') {
            _euler.setFromQuaternion(_quat.set(b.qx, b.qy, b.qz, b.qw), 'YXZ');
            const flatten = Math.min(1, subDt * 10.0);
            _euler.x = THREE.MathUtils.lerp(_euler.x, 0, flatten);
            _euler.z = THREE.MathUtils.lerp(_euler.z, 0, flatten);
            _quat.setFromEuler(_euler);
            b.qx = _quat.x;
            b.qy = _quat.y;
            b.qz = _quat.z;
            b.qw = _quat.w;
          } else if (horizSpdSq < 0.35 && b.vy === 0) {
            // Gently relax tilted bottles/cans onto upright or clean side rest, and boxes onto flat faces
            const r11 = 1 - 2 * (b.qx * b.qx + b.qz * b.qz);
            if (metrics.shape === 'cylinder') {
              _euler.setFromQuaternion(_quat.set(b.qx, b.qy, b.qz, b.qw), 'YXZ');
              const settleRate = Math.min(1, subDt * 6.0);
              if (Math.abs(r11) > 0.72) {
                _euler.x = THREE.MathUtils.lerp(_euler.x, 0, settleRate);
                _euler.z = THREE.MathUtils.lerp(_euler.z, 0, settleRate);
              } else {
                // Tipped cylinder settles cleanly flat on its curved side (roll = +-PI/2)
                const targetRoll = _euler.z >= 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
                _euler.x = THREE.MathUtils.lerp(_euler.x, 0, settleRate);
                _euler.z = THREE.MathUtils.lerp(_euler.z, targetRoll, settleRate);
              }
              _quat.setFromEuler(_euler);
              b.qx = _quat.x;
              b.qy = _quat.y;
              b.qz = _quat.z;
              b.qw = _quat.w;
              // Re-flush Y immediately for updated resting angle
              const nextHalfH = computeOrientedHalfExtentY(metrics, b.qx, b.qy, b.qz, b.qw, sx, sy, sz);
              b.y = _supportScratch.height + nextHalfH;
            }
          }
        } else {
          const airAng = Math.pow(metrics.angularDamping, subDt * 3);
          b.wx *= airAng;
          b.wy *= airAng;
          b.wz *= airAng;
        }

        // 5. Spatial-hash prop-to-prop collision solver
        if (this.resolvePropToPropCollisions(b, metrics, rad, halfH)) {
          destroyed = true;
          break;
        }
      }

      if (destroyed) continue;

      // Sleep state check
      const linSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      const angSq = b.wx * b.wx + b.wy * b.wy + b.wz * b.wz;
      if (onGround && linSq < SLEEP_LIN_SQ && angSq < SLEEP_ANG_SQ) {
        b.sleepTimer += stepDt;
        if (b.sleepTimer >= SLEEP_HOLD_SEC) {
          b.sleeping = true;
          b.vx = b.vy = b.vz = 0;
          b.wx = b.wy = b.wz = 0;
        }
      } else {
        b.sleepTimer = 0;
      }

      this.updateBodyCell(b);
      this.writeBodyMatrix(b);
    }

    // Update active glass shards
    this.updateShards(stepDt);
    this.flushDirtyMatrices();
  }

  private updateShards(dt: number): void {
    let anyMoved = false;
    for (let i = 0; i < this.shards.length; i++) {
      const sh = this.shards[i];
      if (!sh.active) continue;
      sh.age += dt;
      if (sh.age > 24) {
        sh.active = false;
        this.shardMesh.setMatrixAt(i, _zeroMatrix);
        anyMoved = true;
        continue;
      }
      if (sh.sleeping) continue;

      sh.vy += GRAVITY * dt;
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      sh.z += sh.vz * dt;
      sh.rx += sh.vrx * dt;
      sh.ry += sh.vry * dt;
      sh.rz += sh.vrz * dt;

      // Keep shattered glass shards bouncing cleanly inside rooms (no wall/ceiling clipping)
      if (this.adapter.resolveSolidCollision) {
        if (this.adapter.resolveSolidCollision(sh.x, sh.y, sh.z, 0.025, 0.012, _solidHitScratch)) {
          sh.x += _solidHitScratch.pushX;
          sh.y += _solidHitScratch.pushY;
          sh.z += _solidHitScratch.pushZ;
          const vn =
            sh.vx * _solidHitScratch.normalX +
            sh.vy * _solidHitScratch.normalY +
            sh.vz * _solidHitScratch.normalZ;
          if (vn < 0) {
            sh.vx -= 1.25 * vn * _solidHitScratch.normalX;
            sh.vy -= 1.25 * vn * _solidHitScratch.normalY;
            sh.vz -= 1.25 * vn * _solidHitScratch.normalZ;
          }
        }
      }

      const supportY = this.adapter.sampleSupportHeight(sh.x, sh.y + 0.12, sh.z);
      if (sh.y <= supportY + 0.005) {
        sh.y = supportY + 0.005;
        if (-sh.vy > 0.48) {
          sh.vy = -sh.vy * 0.22;
          sh.vx *= 0.64;
          sh.vz *= 0.64;
          sh.vrx *= 0.6;
          sh.vry *= 0.6;
          sh.vrz *= 0.6;
        } else {
          sh.vy = 0;
          sh.vx *= 0.5;
          sh.vz *= 0.5;
          sh.rx = 0;
          sh.rz = 0;
          if (sh.vx * sh.vx + sh.vz * sh.vz < 0.012) {
            sh.sleeping = true;
          }
        }
      }

      _pos.set(sh.x, sh.y, sh.z);
      _euler.set(sh.rx, sh.ry, sh.rz, 'YXZ');
      _quat.setFromEuler(_euler);
      _scale.setScalar(sh.scale);
      _mat4.compose(_pos, _quat, _scale);
      this.shardMesh.setMatrixAt(i, _mat4);
      anyMoved = true;
    }

    if (anyMoved || this.shardsDirty) {
      this.shardMesh.instanceMatrix.needsUpdate = true;
      this.shardsDirty = false;
    }
  }

  private writeBodyMatrix(b: PropBody): void {
    const im = this.meshes.get(b.kind);
    if (!im) return;
    _pos.set(b.x, b.y, b.z);
    _quat.set(b.qx, b.qy, b.qz, b.qw);
    _scale.set(
      b.scale * b.dentScaleX,
      b.scale * b.dentScaleY,
      b.scale * b.dentScaleZ,
    );
    _mat4.compose(_pos, _quat, _scale);
    im.setMatrixAt(b.instanceIdx, _mat4);
    this.dirtyArchetypes.add(b.kind);
  }

  private flushDirtyMatrices(): void {
    if (this.dirtyArchetypes.size === 0) return;
    for (const kind of this.dirtyArchetypes) {
      const im = this.meshes.get(kind);
      if (im) im.instanceMatrix.needsUpdate = true;
    }
    this.dirtyArchetypes.clear();
  }

  public dispose(): void {
    this.scene.remove(this.rootGroup);
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTex) t.dispose();
    this.ownedGeos.length = 0;
    this.ownedMats.length = 0;
    this.ownedTex.length = 0;
    this.meshes.clear();
    this.freeSlots.clear();
    this.bodies.length = 0;
    this.cellBuckets.clear();
  }
}

/**
 * Lightweight zero-GC analytical adapter binding any BodycamPhysicsWorld (Hideout, Zombies Outpost,
 * Combat/Infection maps, Calibration Gym, Killhouse Tutorial) to DynamicPhysicsPropSystem.
 * Directly resolves all AABB boxes, sloped ramps, dynamic hinged door slabs, ceilings, and map bounds
 * with exact minimum-translation-vector depenetration (zero dependency on stale scene raycast matrices).
 */
export function createBodycamPhysicsPropAdapter(
  physics: BodycamPhysicsWorld,
  terrainHeightAt?: (x: number, z: number) => number,
  terrainSurface: BodycamSurfaceMaterial = 'grass',
): DynamicPropWorldAdapter {
  const interiorSample = {
    isIndoor: false,
    material: 'outdoor' as 'concrete' | 'wood' | 'metal' | 'outdoor',
  };
  const supportTmp: DynamicPropSupportSample = { height: 0, surface: 'concrete' };

  const sampleSupportSurface = (
    x: number,
    maxSurfaceY: number,
    z: number,
    out: DynamicPropSupportSample,
  ): void => {
    let bestY = physics.baseFloorY;
    let bestSurface: BodycamSurfaceMaterial = 'concrete';

    if (terrainHeightAt) {
      const ty = terrainHeightAt(x, z);
      if (Number.isFinite(ty) && ty > bestY) {
        bestY = ty;
        bestSurface = terrainSurface;
      }
    }

    // 1. Check all solid AABB box tops (floors, tables, benches, plinking ledges, shelf tiers, crates)
    const boxes = physics.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.blocksMovement === false) continue;
      if (x < bx.minX || x > bx.maxX || z < bx.minZ || z > bx.maxZ) continue;
      if (bx.maxY <= maxSurfaceY + 0.04 && bx.maxY > bestY) {
        bestY = bx.maxY;
        bestSurface = bx.surface ?? 'concrete';
      }
    }

    // 2. Check all sloped ramps
    const ramps = physics.ramps;
    for (let i = 0; i < ramps.length; i++) {
      const rp = ramps[i];
      if (x < rp.minX || x > rp.maxX || z < rp.minZ || z > rp.maxZ) continue;
      let t = 0;
      if (rp.riseAxis === '+x') t = (x - rp.minX) / Math.max(1e-4, rp.maxX - rp.minX);
      else if (rp.riseAxis === '-x') t = (rp.maxX - x) / Math.max(1e-4, rp.maxX - rp.minX);
      else if (rp.riseAxis === '+z') t = (z - rp.minZ) / Math.max(1e-4, rp.maxZ - rp.minZ);
      else t = (rp.maxZ - z) / Math.max(1e-4, rp.maxZ - rp.minZ);
      const ry = rp.baseY + (rp.topY - rp.baseY) * Math.max(0, Math.min(1, t));
      if (ry <= maxSurfaceY + 0.06 && ry > bestY) {
        bestY = ry;
        bestSurface = rp.surface ?? 'concrete';
      }
    }

    // 3. Apply authored surface zone material overrides on ground floor (e.g. grass/wood/metal pads)
    const zones = physics.surfaceZones;
    for (let i = 0; i < zones.length; i++) {
      const sz = zones[i];
      if (x < sz.minX || x > sz.maxX || z < sz.minZ || z > sz.maxZ) continue;
      if (sz.minY !== undefined && bestY < sz.minY - 0.1) continue;
      if (sz.maxY !== undefined && bestY > sz.maxY + 0.1) continue;
      bestSurface = sz.surface;
    }

    out.height = bestY;
    out.surface = bestSurface;
  };

  const resolveSolidCollision = (
    x: number,
    y: number,
    z: number,
    radius: number,
    halfHeight: number,
    out: DynamicPropSolidHit,
  ): boolean => {
    out.hit = false;
    out.pushX = 0;
    out.pushY = 0;
    out.pushZ = 0;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.surface = 'concrete';

    // 1. World perimeter walls
    const margin = radius + 0.02;
    if (x < physics.boundsMinX + margin) {
      out.hit = true;
      out.pushX = physics.boundsMinX + margin - x;
      out.normalX = 1;
      out.normalY = 0;
      out.normalZ = 0;
      return true;
    }
    if (x > physics.boundsMaxX - margin) {
      out.hit = true;
      out.pushX = physics.boundsMaxX - margin - x;
      out.normalX = -1;
      out.normalY = 0;
      out.normalZ = 0;
      return true;
    }
    if (z < physics.boundsMinZ + margin) {
      out.hit = true;
      out.pushZ = physics.boundsMinZ + margin - z;
      out.normalX = 0;
      out.normalY = 0;
      out.normalZ = 1;
      return true;
    }
    if (z > physics.boundsMaxZ - margin) {
      out.hit = true;
      out.pushZ = physics.boundsMaxZ - margin - z;
      out.normalX = 0;
      out.normalY = 0;
      out.normalZ = -1;
      return true;
    }

    // 2. Exact 3D AABB-vs-AABB minimum-translation-vector resolution against ALL solid boxes
    //    (covers walls, ceilings, shelf tiers, shelf undersides, desks, crates, pillars, barricades)
    const pMinX = x - radius;
    const pMaxX = x + radius;
    const pMinY = y - halfHeight;
    const pMaxY = y + halfHeight;
    const pMinZ = z - radius;
    const pMaxZ = z + radius;

    let bestPen = Infinity;
    let bestPx = 0;
    let bestPy = 0;
    let bestPz = 0;
    let bestNx = 0;
    let bestNy = 0;
    let bestNz = 0;
    let bestSurface: BodycamSurfaceMaterial = 'concrete';

    const boxes = physics.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.blocksMovement === false) continue;

      const ox = Math.min(pMaxX, bx.maxX) - Math.max(pMinX, bx.minX);
      if (ox <= 1e-4) continue;
      const oy = Math.min(pMaxY, bx.maxY) - Math.max(pMinY, bx.minY);
      if (oy <= 1e-4) continue;
      const oz = Math.min(pMaxZ, bx.maxZ) - Math.max(pMinZ, bx.minZ);
      if (oz <= 1e-4) continue;

      // Determine minimum penetration axis
      let pen: number;
      let px = 0;
      let py = 0;
      let pz = 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;

      if (oy <= ox && oy <= oz) {
        pen = oy;
        const boxCenterY = (bx.minY + bx.maxY) * 0.5;
        if (y >= boxCenterY) {
          py = oy;
          ny = 1;
        } else {
          py = -oy;
          ny = -1;
        }
      } else if (ox <= oz) {
        pen = ox;
        const boxCenterX = (bx.minX + bx.maxX) * 0.5;
        if (x >= boxCenterX) {
          px = ox;
          nx = 1;
        } else {
          px = -ox;
          nx = -1;
        }
      } else {
        pen = oz;
        const boxCenterZ = (bx.minZ + bx.maxZ) * 0.5;
        if (z >= boxCenterZ) {
          pz = oz;
          nz = 1;
        } else {
          pz = -oz;
          nz = -1;
        }
      }

      if (pen < bestPen) {
        bestPen = pen;
        bestPx = px;
        bestPy = py;
        bestPz = pz;
        bestNx = nx;
        bestNy = ny;
        bestNz = nz;
        bestSurface = bx.surface ?? 'concrete';
      }
    }

    // 3. Dynamic hinged doors (oriented 2D slabs)
    const slabs = physics.slabs;
    for (let i = 0; i < slabs.length; i++) {
      const slab = slabs[i];
      if (!slab.active) continue;
      if (pMaxY <= slab.minY || pMinY >= slab.maxY) continue;

      const relX = x - slab.originX;
      const relZ = z - slab.originZ;
      const proj = Math.max(0, Math.min(slab.length, relX * slab.dirX + relZ * slab.dirZ));
      const closestX = slab.originX + slab.dirX * proj;
      const closestZ = slab.originZ + slab.dirZ * proj;
      const dx = x - closestX;
      const dz = z - closestZ;
      const minClear = slab.halfThickness + radius;
      const dSq = dx * dx + dz * dz;
      if (dSq >= minClear * minClear) continue;

      const dist = Math.sqrt(dSq);
      let nx: number;
      let nz: number;
      if (dist > 1e-4) {
        nx = dx / dist;
        nz = dz / dist;
      } else {
        nx = -slab.dirZ;
        nz = slab.dirX;
      }
      const pen = minClear - dist;
      if (pen < bestPen) {
        bestPen = pen;
        bestPx = nx * pen;
        bestPy = 0;
        bestPz = nz * pen;
        bestNx = nx;
        bestNy = 0;
        bestNz = nz;
        bestSurface = 'wood';
      }
    }

    if (bestPen < Infinity) {
      out.hit = true;
      out.pushX = bestPx;
      out.pushY = bestPy;
      out.pushZ = bestPz;
      out.normalX = bestNx;
      out.normalY = bestNy;
      out.normalZ = bestNz;
      out.surface = bestSurface;
      return true;
    }

    return false;
  };

  return {
    sampleSupportHeight(x: number, maxSurfaceY: number, z: number): number {
      sampleSupportSurface(x, maxSurfaceY, z, supportTmp);
      return supportTmp.height;
    },

    sampleSupportSurface,
    resolveSolidCollision,

    isIndoor(x: number, y: number, z: number): boolean {
      physics.sampleInterior(x, y, z, interiorSample);
      return interiorSample.isIndoor;
    },
  };
}

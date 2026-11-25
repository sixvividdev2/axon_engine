import * as THREE from 'three';
import {
  GraphicsQualityId,
  PhysicsPropBudgetSpec,
  resolvePhysicsPropBudget,
} from '../../data/graphicsQuality';
import type { BodycamPhysicsWorld } from '../BodycamPhysics';
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

export interface DynamicPropWorldAdapter {
  /**
   * Returns highest solid support Y at (x, z) that is <= maxSurfaceY (floor, tabletop, shelf, deck, or terrain).
   */
  sampleSupportHeight: (x: number, maxSurfaceY: number, z: number) => number;
  /**
   * Optional horizontal wall/obstacle collision probe. Returns true and writes bounce normal if blocked.
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

interface ArchetypeMetrics {
  mass: number;
  radius: number;
  halfHeight: number;
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

const ARCHETYPE_METRICS: Record<DynamicPropArchetype, ArchetypeMetrics> = {
  glass_bottle_green: {
    mass: 0.42,
    radius: 0.055,
    halfHeight: 0.135,
    restitution: 0.24,
    groundFriction: 0.82,
    angularDamping: 0.94,
    windDrag: 0.02,
    windLift: 0.0,
    shatterable: true,
    dentable: false,
    audioBounceKind: 'glass_clink',
  },
  glass_bottle_amber: {
    mass: 0.45,
    radius: 0.058,
    halfHeight: 0.14,
    restitution: 0.24,
    groundFriction: 0.82,
    angularDamping: 0.94,
    windDrag: 0.02,
    windLift: 0.0,
    shatterable: true,
    dentable: false,
    audioBounceKind: 'glass_clink',
  },
  soda_can: {
    mass: 0.12,
    radius: 0.045,
    halfHeight: 0.068,
    restitution: 0.44,
    groundFriction: 0.78,
    angularDamping: 0.95,
    windDrag: 0.35,
    windLift: 0.05,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'can_clatter',
  },
  ration_tin: {
    mass: 0.28,
    radius: 0.058,
    halfHeight: 0.055,
    restitution: 0.34,
    groundFriction: 0.84,
    angularDamping: 0.93,
    windDrag: 0.14,
    windLift: 0.02,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'can_clatter',
  },
  paper_sheet: {
    mass: 0.015,
    radius: 0.16,
    halfHeight: 0.008,
    restitution: 0.08,
    groundFriction: 0.62,
    angularDamping: 0.89,
    windDrag: 2.85,
    windLift: 1.95,
    shatterable: false,
    dentable: false,
    audioBounceKind: 'paper_rustle',
  },
  cardboard_box: {
    mass: 0.95,
    radius: 0.22,
    halfHeight: 0.16,
    restitution: 0.18,
    groundFriction: 0.88,
    angularDamping: 0.9,
    windDrag: 0.16,
    windLift: 0.02,
    shatterable: false,
    dentable: true,
    audioBounceKind: 'cardboard_thud',
  },
  plastic_crate: {
    mass: 1.45,
    radius: 0.24,
    halfHeight: 0.15,
    restitution: 0.24,
    groundFriction: 0.86,
    angularDamping: 0.91,
    windDrag: 0.06,
    windLift: 0.0,
    shatterable: false,
    dentable: false,
    audioBounceKind: 'plastic_clack',
  },
};

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

const CELL_SIZE_M = 2.0;
const INV_CELL_SIZE = 1.0 / CELL_SIZE_M;
const GRAVITY = -16.8;
const SLEEP_LIN_SQ = 0.018;
const SLEEP_ANG_SQ = 0.04;
const SLEEP_HOLD_SEC = 0.34;
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
  // Subtle organic paper curl so resting sheets never look dead-flat or Z-fight
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const edgeDist = Math.hypot(x * 3.8, z * 3.0);
    pos.setY(i, 0.004 + edgeDist * edgeDist * 0.006);
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
  material.customProgramCacheKey = () => 'axon_dynamic_paper_flutter_v1';
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
        float flutter = sin(uTime * (4.6 + uWindStrength * 5.5) + phase + position.x * 16.0 + position.z * 12.0);
        float curl = cos(uTime * 2.4 + phase * 0.7 + position.z * 9.0);
        transformed.y += (flutter * 0.014 + curl * 0.008) * edgeMask * (0.28 + uWindStrength * 1.25);
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

    // Pooled instanced glass shards
    const shardCap = Math.max(32, this.budget.maxGlassShards);
    const shardGeo = buildGlassShardGeometry();
    const shardMat = new THREE.MeshStandardMaterial({
      color: 0xa6d8b5,
      roughness: 0.1,
      metalness: 0.15,
      transparent: true,
      opacity: 0.82,
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

  public spawnProp(spec: DynamicPropSpawnSpec): number {
    if (this.activeCount >= this.budget.maxTotalProps) return -1;
    if (spec.kind === 'paper_sheet' && this.paperCount >= this.budget.maxWindPapers) return -1;

    const slots = this.freeSlots.get(spec.kind);
    if (!slots || slots.length === 0) return -1;
    const instanceIdx = slots.pop()!;

    const metrics = ARCHETYPE_METRICS[spec.kind];
    const scale = THREE.MathUtils.clamp(spec.scale ?? 1.0, 0.72, 1.38);
    const supportY = this.adapter.sampleSupportHeight(spec.x, spec.y + 0.35, spec.z);
    const groundedY = Math.max(supportY, spec.y - 0.12) + metrics.halfHeight * scale;
    const indoor = this.adapter.isIndoor
      ? this.adapter.isIndoor(spec.x, groundedY + 0.25, spec.z)
      : false;

    _euler.set(spec.pitch ?? 0, spec.yaw ?? 0, spec.roll ?? 0, 'YXZ');
    _quat.setFromEuler(_euler);

    const cellKey = packCellKey(
      Math.floor(spec.x * INV_CELL_SIZE),
      Math.floor(spec.z * INV_CELL_SIZE),
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
      body.x = spec.x;
      body.y = groundedY;
      body.z = spec.z;
      body.spawnX = spec.x;
      body.spawnY = groundedY;
      body.spawnZ = spec.z;
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
      body.windPhase = (spec.x * 1.73 + spec.z * 2.19) % 6.283;
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
        x: spec.x,
        y: groundedY,
        z: spec.z,
        spawnX: spec.x,
        spawnY: groundedY,
        spawnZ: spec.z,
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
        windPhase: (spec.x * 1.73 + spec.z * 2.19) % 6.283,
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
    const tint = 0.88 + (Math.abs(Math.sin(spec.x * 12.989 + spec.z * 78.233)) % 0.2);
    if (spec.kind === 'soda_can') {
      const palette = [0xd84339, 0x3b72a6, 0x3a8c58, 0xd49b2f];
      const pick = palette[Math.abs(Math.floor(spec.x * 3 + spec.z * 5)) % palette.length];
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

  public spawnBatch(specs: readonly DynamicPropSpawnSpec[]): number {
    let spawned = 0;
    for (let i = 0; i < specs.length; i++) {
      if (this.spawnProp(specs[i]) >= 0) spawned++;
    }
    this.flushDirtyMatrices();
    return spawned;
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

    const shardCount = this.isSoftwareGl ? 5 : 8;
    const shardCap = this.shards.length;
    for (let i = 0; i < shardCount; i++) {
      const idx = this.shardCursor % shardCap;
      this.shardCursor++;
      const sh = this.shards[idx];
      sh.active = true;
      sh.sleeping = false;
      sh.age = 0;
      sh.x = b.x + (Math.random() - 0.5) * 0.06;
      sh.y = b.y + (Math.random() - 0.5) * 0.12;
      sh.z = b.z + (Math.random() - 0.5) * 0.06;
      const spread = 1.4 + Math.random() * 2.4;
      sh.vx = dirX * scatterSpeed * 0.48 + (Math.random() - 0.5) * spread;
      sh.vy = Math.max(0.8, dirY * scatterSpeed * 0.35 + 1.2 + Math.random() * 2.1);
      sh.vz = dirZ * scatterSpeed * 0.48 + (Math.random() - 0.5) * spread;
      sh.rx = Math.random() * Math.PI * 2;
      sh.ry = Math.random() * Math.PI * 2;
      sh.rz = Math.random() * Math.PI * 2;
      sh.vrx = (Math.random() - 0.5) * 20;
      sh.vry = (Math.random() - 0.5) * 20;
      sh.vrz = (Math.random() - 0.5) * 20;
      sh.scale = 0.72 + Math.random() * 0.85;
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
   * Main per-frame physics & aerodynamic wind update.
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
            b.vy += 0.24 + localWind * 0.55;
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
      const halfH = metrics.halfHeight * b.scale;
      const rad = metrics.radius * b.scale;

      // Refresh indoor shelter flag periodically when moving
      if (this.adapter.isIndoor) {
        b.indoor = this.adapter.isIndoor(b.x, b.y + 0.18, b.z);
      }

      const localWind = b.indoor
        ? this.indoorVentilationDraft
          ? 0.16
          : effectiveWind * 0.05
        : effectiveWind;

      // Gravity + aerodynamic drag/lift (papers flutter, glide, and curl in wind!)
      if (b.kind === 'paper_sheet') {
        const airGravity = GRAVITY * 0.24;
        b.vy += airGravity * stepDt;

        const swirl = Math.sin(this.elapsedSec * 3.1 + b.windPhase + b.x * 0.55);
        const lateralX = -this.windDirZ;
        const lateralZ = this.windDirX;

        if (localWind > 0.08) {
          const targetVx = this.windDirX * localWind * metrics.windDrag + lateralX * swirl * localWind * 0.85;
          const targetVz = this.windDirZ * localWind * metrics.windDrag + lateralZ * swirl * localWind * 0.85;
          b.vx += (targetVx - b.vx) * Math.min(1, stepDt * 3.2);
          b.vz += (targetVz - b.vz) * Math.min(1, stepDt * 3.2);

          // Aerodynamic lift during gusts
          const liftImpulse = Math.max(0, swirl + 0.35) * localWind * metrics.windLift;
          b.vy += liftImpulse * stepDt * 2.4;
          b.wx += swirl * localWind * 4.5 * stepDt;
          b.wy += (Math.cos(this.elapsedSec * 2.4 + b.windPhase) * 3.2) * localWind * stepDt;
          b.wz += Math.cos(this.elapsedSec * 2.8 + b.windPhase) * localWind * 4.0 * stepDt;
        }

        // Terminal gentle flutter descent speed
        if (b.vy < -1.85) b.vy = -1.85;
        b.vx *= Math.pow(0.72, stepDt);
        b.vz *= Math.pow(0.72, stepDt);

        // Soft spawn-zone leash so outdoor wind-blown papers swirl across courtyards without vanishing off-map
        const leashDx = b.x - b.spawnX;
        const leashDz = b.z - b.spawnZ;
        if (leashDx * leashDx + leashDz * leashDz > 18 * 18) {
          b.x = b.spawnX + (Math.random() - 0.5) * 1.4;
          b.z = b.spawnZ + (Math.random() - 0.5) * 1.4;
          b.y = b.spawnY + 0.25;
          b.vx *= 0.25;
          b.vy = 0.2;
          b.vz *= 0.25;
        }
      } else {
        b.vy += GRAVITY * stepDt;
        if (localWind > 0.55 && metrics.windDrag > 0.1) {
          b.vx += this.windDirX * localWind * metrics.windDrag * stepDt * 1.8;
          b.vz += this.windDirZ * localWind * metrics.windDrag * stepDt * 1.8;
        }
      }

      // Integrate position
      b.x += b.vx * stepDt;
      b.y += b.vy * stepDt;
      b.z += b.vz * stepDt;

      // Integrate orientation quaternion from angular velocity
      const angSpeed = Math.hypot(b.wx, b.wy, b.wz);
      if (angSpeed > 1e-4) {
        const halfAngle = angSpeed * stepDt * 0.5;
        const s = Math.sin(halfAngle) / angSpeed;
        _deltaQuat.set(b.wx * s, b.wy * s, b.wz * s, Math.cos(halfAngle));
        _quat.set(b.qx, b.qy, b.qz, b.qw).premultiply(_deltaQuat).normalize();
        b.qx = _quat.x;
        b.qy = _quat.y;
        b.qz = _quat.z;
        b.qw = _quat.w;
      }

      // Horizontal wall/obstacle bounce
      if (this.adapter.resolveHorizontalHit) {
        if (this.adapter.resolveHorizontalHit(b.x, b.y, b.z, rad, _normal)) {
          const vn = b.vx * _normal.x + b.vz * _normal.z;
          if (vn < 0) {
            const impactSpeed = -vn;
            if (metrics.shatterable && impactSpeed > 6.8) {
              this.shatterBottle(b, _normal.x, 0.2, _normal.z, impactSpeed * 0.55);
              continue;
            }
            const bounce = 1 + metrics.restitution;
            b.vx -= bounce * vn * _normal.x;
            b.vz -= bounce * vn * _normal.z;
            b.x += _normal.x * 0.03;
            b.z += _normal.z * 0.03;
            b.wy += (Math.random() - 0.5) * impactSpeed * 2.0;
            if (impactSpeed > 0.9) {
              this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.95, impactSpeed * 0.18));
            }
          }
        }
      }

      // Support floor / tabletop / shelf collision
      const supportY = this.adapter.sampleSupportHeight(b.x, b.y + 0.14, b.z);
      const minCenterY = supportY + halfH;
      let onGround = false;

      if (b.y <= minCenterY) {
        onGround = true;
        const impactVy = -b.vy;
        b.y = minCenterY;

        if (metrics.shatterable && impactVy > 6.2) {
          this.shatterBottle(b, b.vx * 0.15, 0.35, b.vz * 0.15, impactVy * 0.5);
          continue;
        }

        if (impactVy > 0.72) {
          b.vy = impactVy * metrics.restitution;
          b.wx += (Math.random() - 0.5) * impactVy * 1.4;
          b.wz += (Math.random() - 0.5) * impactVy * 1.4;
          this.triggerPropAudio(b, metrics.audioBounceKind, Math.min(0.9, impactVy * 0.17));
        } else {
          b.vy = 0;
        }

        // Ground friction & resting alignment
        const fric = Math.pow(1 - metrics.groundFriction * 0.75, stepDt * 6);
        b.vx *= fric;
        b.vz *= fric;
        b.wx *= metrics.angularDamping;
        b.wy *= metrics.angularDamping;
        b.wz *= metrics.angularDamping;

        // Papers gently flatten flush onto the floor when settling
        if (b.kind === 'paper_sheet') {
          _euler.setFromQuaternion(_quat.set(b.qx, b.qy, b.qz, b.qw), 'YXZ');
          const flatten = Math.min(1, stepDt * 8.5);
          _euler.x = THREE.MathUtils.lerp(_euler.x, 0, flatten);
          _euler.z = THREE.MathUtils.lerp(_euler.z, 0, flatten);
          _quat.setFromEuler(_euler);
          b.qx = _quat.x;
          b.qy = _quat.y;
          b.qz = _quat.z;
          b.qw = _quat.w;
        }
      } else {
        const airAng = Math.pow(metrics.angularDamping, stepDt * 3);
        b.wx *= airAng;
        b.wy *= airAng;
        b.wz *= airAng;
      }

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

      const supportY = this.adapter.sampleSupportHeight(sh.x, sh.y + 0.12, sh.z);
      if (sh.y <= supportY + 0.008) {
        sh.y = supportY + 0.008;
        if (-sh.vy > 0.55) {
          sh.vy = -sh.vy * 0.28;
          sh.vx *= 0.65;
          sh.vz *= 0.65;
          sh.vrx *= 0.6;
          sh.vry *= 0.6;
          sh.vrz *= 0.6;
        } else {
          sh.vy = 0;
          sh.vx *= 0.5;
          sh.vz *= 0.5;
          sh.rx = 0;
          sh.rz = 0;
          if (sh.vx * sh.vx + sh.vz * sh.vz < 0.015) {
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
 * Lightweight zero-GC adapter binding any BodycamPhysicsWorld (Hideout, Zombies Outpost,
 * Combat/Infection maps, Calibration Gym, Killhouse Tutorial) to DynamicPhysicsPropSystem.
 */
export function createBodycamPhysicsPropAdapter(
  physics: BodycamPhysicsWorld,
  terrainHeightAt?: (x: number, z: number) => number,
): DynamicPropWorldAdapter {
  const interiorSample = { isIndoor: false, material: 'outdoor' as 'concrete' | 'wood' | 'metal' | 'outdoor' };
  const rayOrigin = new THREE.Vector3();
  const rayDown = new THREE.Vector3(0, -1, 0);
  const rayHit = {
    hit: false,
    distance: Infinity,
    pointX: 0,
    pointY: 0,
    pointZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    surface: 'concrete' as const,
    object: null as THREE.Object3D | null,
  };

  return {
    sampleSupportHeight(x: number, maxSurfaceY: number, z: number): number {
      let bestY = terrainHeightAt ? terrainHeightAt(x, z) : physics.baseFloorY;

      // Fast vertical probe downward against physics AABBs/ramps for tabletops, shelves, crates & upper floors
      rayOrigin.set(x, maxSurfaceY + 0.08, z);
      if (physics.raycast(rayOrigin, rayDown, 0.01, 4.2, rayHit)) {
        if (rayHit.normalY > 0.55 && rayHit.pointY <= maxSurfaceY + 0.06 && rayHit.pointY > bestY) {
          bestY = rayHit.pointY;
        }
      }
      return bestY;
    },

    resolveHorizontalHit(
      x: number,
      y: number,
      z: number,
      radius: number,
      outNormal: THREE.Vector3,
    ): boolean {
      const margin = radius + 0.04;
      if (x < physics.boundsMinX + margin) {
        outNormal.set(1, 0, 0);
        return true;
      }
      if (x > physics.boundsMaxX - margin) {
        outNormal.set(-1, 0, 0);
        return true;
      }
      if (z < physics.boundsMinZ + margin) {
        outNormal.set(0, 0, 1);
        return true;
      }
      if (z > physics.boundsMaxZ - margin) {
        outNormal.set(0, 0, -1);
        return true;
      }
      // Check horizontal box collisions via fast point-vs-box probe
      const boxes = (physics as unknown as { boxes?: ReadonlyArray<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; blocksMovement?: boolean }> }).boxes;
      if (boxes) {
        for (let i = 0; i < boxes.length; i++) {
          const bx = boxes[i];
          if (bx.blocksMovement === false) continue;
          if (y < bx.minY + 0.02 || y > bx.maxY - 0.04) continue;
          if (
            x + radius > bx.minX &&
            x - radius < bx.maxX &&
            z + radius > bx.minZ &&
            z - radius < bx.maxZ
          ) {
            const penLeft = Math.abs(x + radius - bx.minX);
            const penRight = Math.abs(bx.maxX - (x - radius));
            const penBack = Math.abs(z + radius - bx.minZ);
            const penFront = Math.abs(bx.maxZ - (z - radius));
            const minPen = Math.min(penLeft, penRight, penBack, penFront);
            if (minPen === penLeft) outNormal.set(-1, 0, 0);
            else if (minPen === penRight) outNormal.set(1, 0, 0);
            else if (minPen === penBack) outNormal.set(0, 0, -1);
            else outNormal.set(0, 0, 1);
            return true;
          }
        }
      }
      return false;
    },

    isIndoor(x: number, y: number, z: number): boolean {
      physics.sampleInterior(x, y, z, interiorSample);
      return interiorSample.isIndoor;
    },
  };
}

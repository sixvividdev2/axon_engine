import * as THREE from 'three';
import {
  BallisticImpactEvent,
  BodycamPhysicsWorld,
  BodycamSurfaceMaterial,
  computeTargetHingeAngularImpulse,
} from '../bodycam-sdk';
import { PenetrableSurfaceSystem } from '../doors/PenetrableSurfaceSystem';
import { HideoutInteractableMeta } from './HideoutBunkerWorld';
import { HideoutElectronicsSystem } from './HideoutElectronicsSystem';
import { HideoutMaterialLibrary } from './HideoutMaterials';

export type LongRangeTargetKind =
  | 'trolley_paper'
  | 'lr_steel_gong'
  | 'lr_steel_silhouette'
  | 'pen_wood_panel'
  | 'pen_steel_panel'
  | 'pen_witness_plate'
  | 'pen_ricochet_plate';

export interface LongRangeHitRecord {
  targetLabel: string;
  zoneLabel: string;
  distanceM: number;
  impactSpeedMs: number;
  impactEnergyJ: number;
  dropCm: number;
  outcome: 'hit' | 'penetrate' | 'ricochet' | 'stop';
  groupMoa: number | null;
  groupCm: number | null;
  isSteel: boolean;
  timestampMs: number;
}

export interface ChronographShotRecord {
  weaponName: string;
  ammoLabel: string;
  muzzleVelocityMs: number;
  muzzleVelocityFps: number;
  muzzleEnergyJ: number;
  bulletMassGrains: number;
  bc: number;
  zeroDistanceM: number;
  timestampMs: number;
}

export interface LongRangeSnapshot {
  inGalleryBay: boolean;
  trolleyDistanceM: number;
  trolleyTargetDistanceM: number;
  trolleyMoving: boolean;
  paperHitCount: number;
  groupSizeCm: number | null;
  groupSizeMoa: number | null;
  bestMoa100m: number | null;
  hits100m: number;
  lastChrono: ChronographShotRecord | null;
  lastHit: LongRangeHitRecord | null;
}

export interface HideoutLongRangeCallbacks {
  on100mRecord?: (info: {
    distanceM: number;
    groupMoa: number | null;
    is100mHit: boolean;
  }) => void;
}

interface LongRangeTargetTag {
  id: string;
  kind: LongRangeTargetKind;
  zone: 'head' | 'a_zone' | 'gong' | 'paper' | 'panel' | 'witness' | 'ricochet';
}

interface LongRangeSteelTarget {
  id: string;
  label: string;
  kind: 'lr_steel_gong' | 'lr_steel_silhouette';
  distanceM: number;
  pivot: THREE.Group;
  plateMat: THREE.MeshStandardMaterial;
  beaconMat: THREE.MeshStandardMaterial | null;
  baseEmissiveHex: number;
  angleRad: number;
  angVel: number;
  flashTimerSec: number;
  beaconTimerSec: number;
  beaconBroken?: boolean;
}

interface PenetrationPanel {
  id: string;
  label: string;
  kind: 'pen_wood_panel' | 'pen_steel_panel' | 'pen_witness_plate' | 'pen_ricochet_plate';
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  pivot: THREE.Group;
  angleRad: number;
  angVel: number;
  flashTimerSec: number;
  hitCount: number;
}

interface PaperImpactDot {
  /** Normalized -0.5..+0.5 across 1.0m × 1.0m bullseye sheet */
  nx: number;
  ny: number;
  /** Physical offset from bullseye center in centimeters */
  cmX: number;
  cmY: number;
  shotIndex: number;
  ringScore: number;
  distanceM: number;
}

const TROLLEY_PRESETS_M = [25, 50, 75, 100] as const;
const FIRING_LINE_Z = 3.2;
const TUNNEL_MIN_X = 24.5;
const TUNNEL_MAX_X = 33.5;
const TUNNEL_CENTER_X = (TUNNEL_MIN_X + TUNNEL_MAX_X) * 0.5; // 29.0
const TUNNEL_WIDTH = TUNNEL_MAX_X - TUNNEL_MIN_X; // 9.0
const TUNNEL_HEIGHT = 4.6;
const TUNNEL_MIN_Z = -6.0;
const TUNNEL_MAX_Z = 108.0;
const TROLLEY_X = 27.55;
const PAPER_SIZE_M = 1.0;

/**
 * Procedural Web Audio synthesizer for the 100m Long-Range Gallery:
 * - Trolley electric rail drive hum/stop click
 * - Distance-delayed resonant AR500 steel gong pings
 * - Precision turret click feedback
 */
class LongRangeAudio {
  private ctx: AudioContext | null = null;
  private volume = 0.72;
  private pendingTimers: number[] = [];

  public setVolume(v: number): void {
    this.volume = THREE.MathUtils.clamp(v, 0, 1);
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public playTrolleyMotorPulse(durationSec = 0.42): void {
    const ctx = this.ensureContext();
    if (!ctx || this.volume <= 0.001) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc2.type = 'triangle';
    osc.frequency.setValueAtTime(118, t);
    osc.frequency.linearRampToValueAtTime(165, t + 0.14);
    osc.frequency.linearRampToValueAtTime(132, t + durationSec);
    osc2.frequency.setValueAtTime(236, t);
    osc2.frequency.linearRampToValueAtTime(310, t + 0.14);
    osc2.frequency.linearRampToValueAtTime(248, t + durationSec);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(620, t);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.065 * this.volume, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durationSec);

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + durationSec + 0.02);
    osc2.stop(t + durationSec + 0.02);
  }

  public playDistantSteelRing(distanceM: number, isHeadOrCenter = false): void {
    // True speed-of-sound acoustic travel delay (~340 m/s -> ~294ms at 100m)
    const delayMs = Math.round(THREE.MathUtils.clamp((distanceM / 340.3) * 1000, 0, 340));
    const trigger = () => {
      const ctx = this.ensureContext();
      if (!ctx || this.volume <= 0.001) return;
      const t = ctx.currentTime;
      const atten = THREE.MathUtils.clamp(1.0 - distanceM * 0.0042, 0.42, 1.0);
      const base = (isHeadOrCenter ? 1680 : 1240) + Math.random() * 140;
      const freqs = [base, base * 1.48, base * 2.17];
      const dur = 0.72;
      for (let i = 0; i < freqs.length; i++) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freqs[i], t);
        osc.frequency.exponentialRampToValueAtTime(freqs[i] * 0.985, t + dur);
        const amp = (i === 0 ? 0.2 : i === 1 ? 0.11 : 0.05) * atten * this.volume;
        g.gain.setValueAtTime(Math.max(0.0001, amp), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (1 - i * 0.16));
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
    };
    if (delayMs <= 12) {
      trigger();
    } else {
      const id = window.setTimeout(() => {
        const idx = this.pendingTimers.indexOf(id);
        if (idx >= 0) this.pendingTimers.splice(idx, 1);
        trigger();
      }, delayMs);
      this.pendingTimers.push(id);
    }
  }

  public playRicochetWhine(): void {
    const ctx = this.ensureContext();
    if (!ctx || this.volume <= 0.001) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2450 + Math.random() * 550, t);
    osc.frequency.exponentialRampToValueAtTime(680, t + 0.28);
    g.gain.setValueAtTime(0.11 * this.volume, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.29);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.31);
  }

  public dispose(): void {
    for (const id of this.pendingTimers) {
      window.clearTimeout(id);
    }
    this.pendingTimers.length = 0;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function buildRangeWallMarkerTex(label: string, sub: string, maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 256);
  ctx.fillStyle = '#181a1d';
  ctx.fillRect(0, 0, 512, 256);
  ctx.fillStyle = '#d97706';
  ctx.fillRect(0, 0, 18, 256);
  ctx.strokeStyle = '#383d44';
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, 504, 248);

  ctx.fillStyle = '#f3f4f6';
  ctx.font = 'bold 116px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 265, 108);

  ctx.fillStyle = '#f59e0b';
  ctx.font = 'bold 34px "IBM Plex Mono", monospace';
  ctx.fillText(sub, 265, 206);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildLongRangeFloorDecal(label: string, maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 256);
  ctx.clearRect(0, 0, 512, 256);
  ctx.fillStyle = 'rgba(217, 119, 6, 0.9)';
  ctx.fillRect(16, 18, 480, 12);
  ctx.fillRect(16, 226, 480, 12);

  ctx.fillStyle = 'rgba(236, 234, 226, 0.92)';
  ctx.font = 'bold 124px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 128);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildPrecisionBullseyeCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const [c, ctx] = makeCanvas(768, 768);
  redrawPrecisionBullseyeBase(ctx, 768, 768);
  return [c, ctx];
}

function redrawPrecisionBullseyeBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  // Warm off-white precision sighting-in target cardstock
  ctx.fillStyle = '#ebe5d8';
  ctx.fillRect(0, 0, w, h);

  // Subtle 5cm calibration grid (1.0m = 20 cells of 5cm)
  const step = w / 20;
  ctx.strokeStyle = 'rgba(55, 65, 81, 0.22)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i < 20; i++) {
    const p = i * step;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(w, p);
    ctx.stroke();
  }

  // Heavy 10cm crosshair axes
  const cx = w * 0.5;
  const cy = h * 0.5;
  ctx.strokeStyle = 'rgba(30, 41, 59, 0.45)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, 24);
  ctx.lineTo(cx, h - 24);
  ctx.moveTo(24, cy);
  ctx.lineTo(w - 24, cy);
  ctx.stroke();

  // Concentric scoring rings (6, 7, 8, 9, 10, X)
  const rings: Array<{ r: number; fill: string | null; stroke: string; label: string }> = [
    { r: w * 0.42, fill: null, stroke: '#27272a', label: '6' },
    { r: w * 0.34, fill: null, stroke: '#27272a', label: '7' },
    { r: w * 0.26, fill: '#18181b', stroke: '#18181b', label: '8' },
    { r: w * 0.18, fill: '#18181b', stroke: '#d4d4d8', label: '9' },
    { r: w * 0.10, fill: '#18181b', stroke: '#f59e0b', label: '10' },
    { r: w * 0.042, fill: '#d97706', stroke: '#fef3c7', label: 'X' },
  ];
  for (const ring of rings) {
    ctx.beginPath();
    ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
    if (ring.fill) {
      ctx.fillStyle = ring.fill;
      ctx.fill();
    }
    ctx.strokeStyle = ring.stroke;
    ctx.lineWidth = ring.label === '10' ? 4 : 3;
    ctx.stroke();
  }

  // Ring numbers
  ctx.font = 'bold 20px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#27272a';
  ctx.fillText('6', cx, cy - w * 0.38);
  ctx.fillText('7', cx, cy - w * 0.30);
  ctx.fillStyle = '#e5e7eb';
  ctx.fillText('8', cx, cy - w * 0.22);
  ctx.fillText('9', cx, cy - w * 0.14);

  // Corner 1-MOA diamond sighter squares
  const diamondOffsets = [
    [112, 112],
    [w - 112, 112],
    [112, h - 112],
    [w - 112, h - 112],
  ];
  for (const [dx, dy] of diamondOffsets) {
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(Math.PI * 0.25);
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(-18, -18, 36, 36);
    ctx.restore();
  }

  // Outer perimeter border & grid label
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.fillStyle = '#374151';
  ctx.font = 'bold 22px "IBM Plex Mono", monospace';
  ctx.fillText('100M PRECISION SIGHTING GRID · 5CM / DIV', cx, h - 28);
}

function buildSilhouette100mTex(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 768);
  ctx.fillStyle = '#1b1f24';
  ctx.fillRect(0, 0, 512, 768);
  ctx.strokeStyle = '#525b66';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, 484, 740);

  // High-contrast orange/amber target zones for 50m–100m magnified scope clarity
  ctx.fillStyle = '#262b32';
  ctx.fillRect(172, 40, 168, 152);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 7;
  ctx.strokeRect(186, 54, 140, 124);

  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 8;
  ctx.strokeRect(136, 260, 240, 290);

  ctx.beginPath();
  ctx.arc(256, 402, 78, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.16)';
  ctx.fill();
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(256, 402, 22, 0, Math.PI * 2);
  ctx.fillStyle = '#fbbf24';
  ctx.fill();

  ctx.fillStyle = '#e5e7eb';
  ctx.font = 'bold 30px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('AR500 · LONG RANGE', 256, 682);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

/**
 * Hideout Phase 3: Bay 3 — 100m Long-Range Gallery & Ballistics Bench.
 *
 * Spatial envelope: X ∈ [24.5, 33.5], Z ∈ [-6.0, 108.0], H = 4.6m
 * Connected seamlessly to the Gun Range foyer via a 7.6m wide east archway at Z ∈ [-5.4, 2.2].
 *
 * Includes:
 *  - 105m subterranean Cold-War ribbed concrete tunnel with 25M/50M/75M/100M lit stations
 *  - Precision Ballistics Bench + Sandbag Rest + Optical Chronograph Gate (Z = 4.35)
 *  - Diegetic 3D Spotting / Ballistics Telemetry Monitor (live target-cam plot + MOA/cm + velocity/energy/drop)
 *  - Motorized Overhead Target Trolley Carrier (smooth rail travel: 25m / 50m / 75m / 100m)
 *  - Staggered AR500 Steel Gongs & Silhouettes (25m / 50m / 75m / 100m) with 100m hit strobe beacons
 *  - Terminal Ballistics Penetration & Ricochet Test Rig (Wood + Steel + Witness Plates + 60° Deflector)
 */
export class HideoutLongRangeGallery {
  private readonly root = new THREE.Group();
  private readonly physics: BodycamPhysicsWorld;
  private readonly materials: HideoutMaterialLibrary;
  private readonly isSoftwareGl: boolean;
  private readonly maxAniso: number;
  private readonly callbacks: HideoutLongRangeCallbacks;
  private readonly lrAudio = new LongRangeAudio();

  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTex: THREE.Texture[] = [];

  // Trolley state
  private trolleyGroup!: THREE.Group;
  private trolleyPivot!: THREE.Group;
  private trolleyPresetIdx = 1; // Defaults to 50m so it's immediately visible & exciting downrange
  private trolleyDistM = 50;
  private trolleyTargetDistM = 50;
  private trolleyVelMps = 0;
  private trolleySwingRad = 0;
  private trolleySwingVel = 0;
  private paperCanvas!: HTMLCanvasElement;
  private paperCtx!: CanvasRenderingContext2D;
  private paperTex!: THREE.CanvasTexture;
  private paperHits: PaperImpactDot[] = [];

  // Diegetic 3D Ballistics & Spotting Monitor
  private monitorCanvas!: HTMLCanvasElement;
  private monitorCtx!: CanvasRenderingContext2D;
  private monitorTex!: THREE.CanvasTexture;
  private chronoCanvas!: HTMLCanvasElement;
  private chronoCtx!: CanvasRenderingContext2D;
  private chronoTex!: THREE.CanvasTexture;

  // Targets & Penetration Rig
  private readonly steelTargets: LongRangeSteelTarget[] = [];
  private readonly steelById = new Map<string, LongRangeSteelTarget>();
  private readonly penPanels: PenetrationPanel[] = [];
  private readonly penById = new Map<string, PenetrationPanel>();

  // Console anchor
  private readonly consoleWorldPos = new THREE.Vector3(26.72, 1.12, 3.05);

  // Telemetry state
  private weaponName = 'M4A1';
  private ammoLabel = 'M855A1';
  private zeroDistanceM = 100;
  private nominalVelocityMs = 880;
  private nominalBc = 0.304;
  private lastChrono: ChronographShotRecord | null = null;
  private lastHit: LongRangeHitRecord | null = null;
  private bestMoa100m: number | null = null;
  private hits100m = 0;

  // Zero-GC scratch
  private readonly _tmpLocalHit = new THREE.Vector3();
  private readonly electronics: HideoutElectronicsSystem;
  private readonly penetrableSystem?: PenetrableSurfaceSystem;
  private consoleBroken = false;
  private monitorBroken = false;
  private chronoBroken = false;

  constructor(
    parent: THREE.Object3D,
    physics: BodycamPhysicsWorld,
    materials: HideoutMaterialLibrary,
    electronics: HideoutElectronicsSystem,
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
    isSoftwareGl: boolean,
    maxAniso: number,
    initialBestMoa100m: number | null,
    initialHits100m: number,
    callbacks: HideoutLongRangeCallbacks = {},
    penetrableSystem?: PenetrableSurfaceSystem,
  ) {
    this.physics = physics;
    this.materials = materials;
    this.electronics = electronics;
    this.penetrableSystem = penetrableSystem;
    this.isSoftwareGl = isSoftwareGl;
    this.maxAniso = maxAniso;
    this.bestMoa100m = initialBestMoa100m;
    this.hits100m = Math.max(0, Math.round(initialHits100m));
    this.callbacks = callbacks;

    this.root.name = 'HideoutLongRangeGalleryPhase3';
    parent.add(this.root);

    this.buildTunnelArchitecture(raycastMeshes);
    this.buildBallisticsBenchAndChrono(raycastMeshes, interactableMeshes);
    this.buildMotorizedTrolley(raycastMeshes);
    this.buildLongRangeSteelArray(raycastMeshes);
    this.buildPenetrationTestRig(raycastMeshes);
    this.redrawMonitor();
    this.redrawChronoScreen();
  }

  public isConsoleBroken(): boolean {
    return this.consoleBroken;
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.ownedGeos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.ownedMats.push(m);
    return m;
  }

  private trackTex<T extends THREE.Texture>(t: T): T {
    this.ownedTex.push(t);
    return t;
  }

  private addStructureBox(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial,
    raycastMeshes: THREE.Object3D[],
    collides = true,
    ballisticMat?: string,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(cx, cy, cz);
    mesh.receiveShadow = true;
    mesh.castShadow = !this.isSoftwareGl && h < 3.5;
    mesh.userData.surfaceMaterial = surface;
    mesh.userData.ballisticMaterial =
      ballisticMat ?? (surface === 'metal' ? 'steel' : surface === 'wood' ? 'wood' : 'concrete');
    this.root.add(mesh);
    raycastMeshes.push(mesh);
    if (collides) {
      this.physics.addBox({
        minX: cx - w * 0.5,
        maxX: cx + w * 0.5,
        minY: cy - h * 0.5,
        maxY: cy + h * 0.5,
        minZ: cz - d * 0.5,
        maxZ: cz + d * 0.5,
        surface,
      });
    }
    return mesh;
  }

  private buildTunnelArchitecture(raycastMeshes: THREE.Object3D[]): void {
    const tunnelLen = TUNNEL_MAX_Z - TUNNEL_MIN_Z; // 114m
    const tunnelMidZ = (TUNNEL_MIN_Z + TUNNEL_MAX_Z) * 0.5; // 51.0

    // Floor & ceiling slabs
    this.addStructureBox(
      TUNNEL_CENTER_X,
      -0.1,
      tunnelMidZ,
      TUNNEL_WIDTH + 0.6,
      0.2,
      tunnelLen + 1.0,
      this.materials.concreteFloor,
      'concrete',
      raycastMeshes,
      false,
    );
    const ceiling = this.addStructureBox(
      TUNNEL_CENTER_X,
      TUNNEL_HEIGHT + 0.1,
      tunnelMidZ,
      TUNNEL_WIDTH + 0.6,
      0.2,
      tunnelLen + 1.0,
      this.materials.concreteCeiling,
      'concrete',
      raycastMeshes,
      true,
    );
    ceiling.userData.isRoof = true;

    // East outer concrete wall (X = 33.75, full length)
    this.addStructureBox(
      TUNNEL_MAX_X + 0.25,
      TUNNEL_HEIGHT * 0.5,
      tunnelMidZ,
      0.5,
      TUNNEL_HEIGHT,
      tunnelLen + 1.0,
      this.materials.concreteWall,
      'concrete',
      raycastMeshes,
      true,
    );

    // West concrete wall continuation beyond Bay 2's back wall (Z = 36.25..108.5)
    const westExtLen = TUNNEL_MAX_Z + 0.5 - 36.25;
    this.addStructureBox(
      TUNNEL_MIN_X + 0.25,
      TUNNEL_HEIGHT * 0.5,
      36.25 + westExtLen * 0.5,
      0.5,
      TUNNEL_HEIGHT,
      westExtLen,
      this.materials.concreteWall,
      'concrete',
      raycastMeshes,
      true,
    );

    // North foyer wall (Z = -6.25) & South armored backstop wall (Z = 108.25)
    this.addStructureBox(
      TUNNEL_CENTER_X,
      TUNNEL_HEIGHT * 0.5,
      TUNNEL_MIN_Z - 0.25,
      TUNNEL_WIDTH + 0.6,
      TUNNEL_HEIGHT,
      0.5,
      this.materials.concreteWall,
      'concrete',
      raycastMeshes,
      true,
    );
    this.addStructureBox(
      TUNNEL_CENTER_X,
      TUNNEL_HEIGHT * 0.5,
      TUNNEL_MAX_Z + 0.25,
      TUNNEL_WIDTH + 0.6,
      TUNNEL_HEIGHT,
      0.5,
      this.materials.concreteWall,
      'concrete',
      raycastMeshes,
      true,
    );

    // Armored angled 100m ballistic bullet trap at Z = 107.1
    const trapMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.84, metalness: 0.42 }),
    );
    const angledTrap = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(TUNNEL_WIDTH - 0.4, 3.6, 0.24)),
      trapMat,
    );
    angledTrap.position.set(TUNNEL_CENTER_X, 2.35, 107.1);
    angledTrap.rotation.x = 0.42;
    angledTrap.userData.surfaceMaterial = 'metal';
    angledTrap.userData.ballisticMaterial = 'steel';
    this.root.add(angledTrap);
    raycastMeshes.push(angledTrap);

    this.addStructureBox(
      TUNNEL_CENTER_X,
      0.52,
      107.15,
      TUNNEL_WIDTH - 0.4,
      1.04,
      1.4,
      this.materials.rubberMat,
      'concrete',
      raycastMeshes,
      true,
    );

    // Instanced Cold-War reinforced concrete structural rib arches every 12.5m (zero extra draw calls)
    const ribZs = [10, 22.5, 35, 47.5, 60, 72.5, 85, 97.5];
    const pilasterGeo = this.trackGeo(new THREE.BoxGeometry(0.42, TUNNEL_HEIGHT, 0.48));
    const pilasterInst = new THREE.InstancedMesh(
      pilasterGeo,
      this.materials.darkSteel,
      ribZs.length * 2,
    );
    const beamGeo = this.trackGeo(new THREE.BoxGeometry(TUNNEL_WIDTH - 0.3, 0.34, 0.44));
    const beamInst = new THREE.InstancedMesh(beamGeo, this.materials.darkSteel, ribZs.length);
    const dummy = new THREE.Object3D();

    let pIdx = 0;
    for (let i = 0; i < ribZs.length; i++) {
      const rz = ribZs[i];
      dummy.position.set(TUNNEL_MIN_X + 0.62, TUNNEL_HEIGHT * 0.5, rz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      pilasterInst.setMatrixAt(pIdx++, dummy.matrix);

      dummy.position.set(TUNNEL_MAX_X - 0.22, TUNNEL_HEIGHT * 0.5, rz);
      dummy.updateMatrix();
      pilasterInst.setMatrixAt(pIdx++, dummy.matrix);

      dummy.position.set(TUNNEL_CENTER_X, TUNNEL_HEIGHT - 0.17, rz);
      dummy.updateMatrix();
      beamInst.setMatrixAt(i, dummy.matrix);
    }
    pilasterInst.instanceMatrix.needsUpdate = true;
    pilasterInst.computeBoundingSphere();
    beamInst.instanceMatrix.needsUpdate = true;
    beamInst.computeBoundingSphere();
    beamInst.userData.isRoof = true;
    this.root.add(pilasterInst);
    this.root.add(beamInst);

    // Strategic gallery point lights at firing line + 25m / 50m / 75m / 100m target bays
    const pointLightSpecs: Array<[number, number, number, number, number, number]> = [
      [28.8, 4.1, 2.0, 0xffe4be, 9.5, 18],
      [29.2, 4.1, 28.2, 0xdde8f4, 8.8, 28],
      [29.2, 4.1, 53.2, 0xdde8f4, 8.8, 30],
      [29.2, 4.1, 78.2, 0xdde8f4, 8.8, 30],
      [29.8, 4.0, 102.2, 0xffdfb2, 13.5, 24],
    ];
    const bayLights: THREE.PointLight[] = [];
    for (const [lx, ly, lz, color, intensity, dist] of pointLightSpecs) {
      const pl = new THREE.PointLight(color, intensity, dist, 1.3);
      pl.position.set(lx, ly, lz);
      this.root.add(pl);
      bayLights.push(pl);
    }

    // Overhead fluorescent tube strips (individually breakable and linked to nearest bay light)
    const lightZs = [4.0, 16.0, 28.2, 41.0, 53.2, 66.0, 78.2, 91.0, 102.5];
    const housingGeo = this.trackGeo(new THREE.BoxGeometry(1.5, 0.08, 0.26));
    const tubeGeo = this.trackGeo(new THREE.BoxGeometry(1.36, 0.04, 0.14));
    for (let i = 0; i < lightZs.length; i++) {
      const lz = lightZs[i];
      const housing = new THREE.Mesh(housingGeo, this.materials.darkSteel);
      housing.position.set(TUNNEL_CENTER_X, TUNNEL_HEIGHT - 0.14, lz);
      housing.userData.isRoof = true;
      this.root.add(housing);
      const tube = new THREE.Mesh(tubeGeo, this.materials.warmLampEmissive);
      tube.position.set(TUNNEL_CENTER_X, TUNNEL_HEIGHT - 0.19, lz);
      tube.userData.isRoof = true;
      this.root.add(tube);

      const bayIdx = Math.min(bayLights.length - 1, Math.floor(i / 2));
      this.electronics.registerNode(
        {
          id: `lr_lamp_${i}`,
          label: '100m Gallery Fluorescent Light',
          hitMeshes: [housing, tube],
          emissiveMeshes: [tube],
          linkedLights: [{ light: bayLights[bayIdx], dropFraction: i === lightZs.length - 1 ? 1.0 : 0.5 }],
          sparkOrigin: new THREE.Vector3(TUNNEL_CENTER_X, TUNNEL_HEIGHT - 0.24, lz),
          isLightFixture: true,
        },
        raycastMeshes,
      );
    }

    // Firing-line safety stripe across Bay 3 (Z = 3.85)
    const safetyStripe = new THREE.Mesh(
      this.trackGeo(new THREE.PlaneGeometry(TUNNEL_WIDTH - 0.6, 0.28)),
      this.materials.hazardStripe,
    );
    safetyStripe.rotation.x = -Math.PI * 0.5;
    safetyStripe.position.set(TUNNEL_CENTER_X, 0.014, 3.85);
    this.root.add(safetyStripe);

    // Overhead Bay 3 Plaque facing the firing foyer
    const bay3Plaque = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(2.65, 0.54, 0.06)),
      this.materials.createSignMaterial('BAY 3 · 100M GALLERY', 'PRECISION ZEROING & BALLISTICS BENCH', '#38bdf8'),
    );
    bay3Plaque.position.set(29.0, 3.65, 3.8);
    bay3Plaque.rotation.y = Math.PI;
    this.root.add(bay3Plaque);

    // Painted floor + East-wall distance signs at 25M, 50M, 75M, 100M
    for (const distM of TROLLEY_PRESETS_M) {
      const zPos = FIRING_LINE_Z + distM;
      const floorTex = this.trackTex(buildLongRangeFloorDecal(`${distM}M`, this.maxAniso));
      const floorMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          map: floorTex,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      );
      const floorPlane = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(2.2, 0.9)), floorMat);
      floorPlane.rotation.x = -Math.PI * 0.5;
      floorPlane.position.set(29.0, 0.017, zPos - 1.2);
      this.root.add(floorPlane);

      const wallTex = this.trackTex(
        buildRangeWallMarkerTex(`${distM}M`, distM === 100 ? 'PRECISION END BAY' : 'BALLISTIC GATE', this.maxAniso),
      );
      const wallMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          map: wallTex,
          roughness: 0.5,
          metalness: 0.15,
          emissiveMap: wallTex,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.28,
        }),
      );
      const wallSign = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.45, 0.72, 0.05)), wallMat);
      wallSign.position.set(TUNNEL_MAX_X - 0.06, 2.7, zPos);
      wallSign.rotation.y = -Math.PI * 0.5;
      this.root.add(wallSign);
    }
  }

  private buildBallisticsBenchAndChrono(
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
  ): void {
    const proxyMat = this.trackMat(new THREE.MeshBasicMaterial({ visible: false }));

    // Acoustic stall flank walls on far edges of Bay 3 firing line
    this.addStructureBox(
      25.15,
      1.32,
      2.75,
      0.16,
      2.64,
      1.8,
      this.materials.darkSteel,
      'metal',
      raycastMeshes,
      true,
    );
    this.addStructureBox(
      33.15,
      1.32,
      2.75,
      0.16,
      2.64,
      1.8,
      this.materials.darkSteel,
      'metal',
      raycastMeshes,
      true,
    );

    // === HEAVY PRECISION BALLISTICS BENCH (X = 28.65, Z = 3.22, W = 5.4m, leaves East walk lane at X = 31.4..33.0) ===
    const benchX = 28.55;
    const benchW = 5.2;
    const benchH = 0.88;
    const benchZ = 3.22;

    this.addStructureBox(
      benchX,
      benchH - 0.035,
      benchZ,
      benchW,
      0.07,
      0.86,
      this.materials.tableWood,
      'wood',
      raycastMeshes,
      true,
    );
    // Lower collider under bench
    this.physics.addBox({
      minX: benchX - benchW * 0.5,
      maxX: benchX + benchW * 0.5,
      minY: 0,
      maxY: benchH,
      minZ: benchZ - 0.43,
      maxZ: benchZ + 0.43,
      surface: 'wood',
    });

    // Welded steel frame legs & cross-bracing
    for (const lx of [benchX - 2.35, benchX, benchX + 2.35]) {
      const leg = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.08, benchH - 0.07, 0.72)),
        this.materials.darkSteel,
      );
      leg.position.set(lx, (benchH - 0.07) * 0.5, benchZ);
      this.root.add(leg);
    }

    // Precision rubber shooting mat
    const matMesh = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(2.1, 0.012, 0.64)),
      this.materials.rubberMat,
    );
    matMesh.position.set(28.55, benchH + 0.006, benchZ);
    this.root.add(matMesh);

    // Composite Front Sandbag Rifle Rest (4-part tactical shooting bag)
    const bagGroup = new THREE.Group();
    bagGroup.position.set(28.55, benchH, benchZ + 0.22);
    this.root.add(bagGroup);
    const bagMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x4f4a3c, roughness: 0.92, metalness: 0.02 }),
    );
    const bagBase = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.28, 0.1, 0.18)), bagMat);
    bagBase.position.set(0, 0.05, 0);
    bagGroup.add(bagBase);
    for (const sx of [-0.085, 0.085]) {
      const ear = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.042, 0.05, 0.12, 10)),
        bagMat,
      );
      ear.position.set(sx, 0.11, 0);
      bagGroup.add(ear);
    }
    const saddle = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.11, 0.035, 0.16)),
      this.materials.rubberMat,
    );
    saddle.position.set(0, 0.095, 0);
    bagGroup.add(saddle);

    // === OPTICAL BALLISTIC CHRONOGRAPH GATE (Z = 4.35, mounted on tripod right in front of benchrest) ===
    const chronoGroup = new THREE.Group();
    chronoGroup.position.set(28.55, 0, 4.38);
    this.root.add(chronoGroup);

    // Tripod center column + 3 splayed steel legs
    const tripodPost = new THREE.Mesh(
      this.trackGeo(new THREE.CylinderGeometry(0.02, 0.024, 1.02, 10)),
      this.materials.darkSteel,
    );
    tripodPost.position.set(0, 0.56, 0);
    chronoGroup.add(tripodPost);
    for (let i = 0; i < 3; i++) {
      const ang = (i * Math.PI * 2) / 3 + 0.4;
      const leg = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 0.62, 8)),
        this.materials.brushedSteel,
      );
      leg.position.set(Math.cos(ang) * 0.16, 0.28, Math.sin(ang) * 0.16);
      leg.rotation.z = Math.cos(ang) * 0.48;
      leg.rotation.x = -Math.sin(ang) * 0.48;
      chronoGroup.add(leg);
    }

    // Chronograph sensor deck chassis
    const chronoBody = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.46, 0.08, 0.42)),
      this.materials.darkSteel,
    );
    chronoBody.position.set(0, 1.06, 0);
    chronoGroup.add(chronoBody);

    // Twin optical skyscreen diffuser arches (fore & aft sensor gates)
    const diffuserMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.22,
        roughness: 0.4,
      }),
    );
    const chronoCanopies: THREE.Mesh[] = [];
    for (const sz of [-0.17, 0.17]) {
      for (const sx of [-0.21, 0.21]) {
        const rod = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.005, 0.005, 0.48, 6)),
          this.materials.brushedSteel,
        );
        rod.position.set(sx, 1.32, sz);
        rod.rotation.z = sx < 0 ? -0.14 : 0.14;
        chronoGroup.add(rod);
      }
      const canopy = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.56, 0.02, 0.09)),
        diffuserMat,
      );
      canopy.position.set(0, 1.56, sz);
      chronoGroup.add(canopy);
      chronoCanopies.push(canopy);
    }

    // Live chronograph LED readout face facing shooter (-Z)
    const [cc, cctx] = makeCanvas(256, 96);
    this.chronoCanvas = cc;
    this.chronoCtx = cctx;
    this.chronoTex = this.trackTex(new THREE.CanvasTexture(cc));
    this.chronoTex.colorSpace = THREE.SRGBColorSpace;
    this.chronoTex.anisotropy = this.maxAniso;
    const chronoScreenMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: this.chronoTex,
        emissiveMap: this.chronoTex,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.72,
        roughness: 0.3,
      }),
    );
    const chronoScreen = new THREE.Mesh(
      this.trackGeo(new THREE.PlaneGeometry(0.36, 0.07)),
      chronoScreenMat,
    );
    chronoScreen.position.set(0, 1.06, -0.215);
    chronoScreen.rotation.y = Math.PI;
    chronoGroup.add(chronoScreen);

    this.electronics.registerNode(
      {
        id: 'lr_chronograph',
        label: 'Optical Chronograph',
        hitMeshes: [chronoBody, chronoScreen, ...chronoCanopies],
        emissiveMaterials: [diffuserMat, chronoScreenMat],
        sparkOrigin: new THREE.Vector3(28.55, 1.12, 4.25),
        repairable: true,
        repairDurationSec: 1.95,
        onBreak: () => {
          this.chronoBroken = true;
          this.drawBrokenChronoScreen();
        },
        onRepair: () => {
          this.chronoBroken = false;
          this.redrawChronoScreen();
        },
      },
      raycastMeshes,
    );

    // === DIEGETIC 3D SPOTTING & BALLISTICS TELEMETRY MONITOR (Right side of bench, X = 30.35, Z = 3.22) ===
    const monGroup = new THREE.Group();
    monGroup.position.set(30.38, benchH, 3.18);
    monGroup.rotation.y = 0.28; // Angled naturally toward shooter standing at X = 28.55
    this.root.add(monGroup);

    const monStand = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.28, 0.04, 0.22)),
      this.materials.darkSteel,
    );
    monStand.position.set(0, 0.02, 0);
    monGroup.add(monStand);
    const monNeck = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.06, 0.28, 0.06)),
      this.materials.darkSteel,
    );
    monNeck.position.set(0, 0.16, 0.04);
    monGroup.add(monNeck);

    const monHousing = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(1.12, 0.62, 0.06)),
      this.materials.darkSteel,
    );
    monHousing.position.set(0, 0.44, 0);
    monGroup.add(monHousing);

    const [mc, mctx] = makeCanvas(1024, 560);
    this.monitorCanvas = mc;
    this.monitorCtx = mctx;
    this.monitorTex = this.trackTex(new THREE.CanvasTexture(mc));
    this.monitorTex.colorSpace = THREE.SRGBColorSpace;
    this.monitorTex.anisotropy = this.maxAniso;
    const monMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: this.monitorTex,
        emissiveMap: this.monitorTex,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.72,
        roughness: 0.26,
      }),
    );
    const monFace = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(1.04, 0.54)), monMat);
    monFace.position.set(0, 0.44, -0.035);
    monFace.rotation.y = Math.PI;
    monGroup.add(monFace);

    this.electronics.registerNode(
      {
        id: 'lr_spotting_monitor',
        label: 'Ballistics Spotting Monitor',
        hitMeshes: [monHousing, monFace],
        emissiveMaterials: [monMat],
        sparkOrigin: new THREE.Vector3(30.38, benchH + 0.44, 3.12),
        isLightFixture: true,
        repairable: true,
        repairDurationSec: 2.0,
        onBreak: () => {
          this.monitorBroken = true;
          this.drawBrokenMonitor();
        },
        onRepair: () => {
          this.monitorBroken = false;
          this.redrawMonitor();
        },
      },
      raycastMeshes,
    );

    // === BALLISTICS BENCH CONTROL CONSOLE (Left side of bench, X = 26.72, Z = 3.05) ===
    const conGroup = new THREE.Group();
    conGroup.position.set(26.72, benchH, 3.06);
    this.root.add(conGroup);

    const conBox = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.76, 0.3, 0.4)),
      this.materials.darkSteel,
    );
    conBox.position.set(0, 0.15, 0);
    conGroup.add(conBox);

    const conFace = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.68, 0.22, 0.04)),
      this.materials.brushedSteel,
    );
    conFace.position.set(0, 0.21, -0.17);
    conFace.rotation.x = -0.45;
    conGroup.add(conFace);

    // 3 tactile color-coded illuminated buttons (Trolley Drive, Optic Zero, Ammo Load)
    const btnColors = [0x38bdf8, 0xf59e0b, 0x22c55e];
    const conBtns: THREE.Mesh[] = [];
    const conBtnMats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 3; i++) {
      const bMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: btnColors[i],
          emissive: btnColors[i],
          emissiveIntensity: 1.35,
          roughness: 0.3,
        }),
      );
      const btn = new THREE.Mesh(this.trackGeo(new THREE.CylinderGeometry(0.028, 0.032, 0.028, 12)), bMat);
      btn.rotation.x = Math.PI * 0.5 - 0.45;
      btn.position.set(-0.18 + i * 0.18, 0.19, -0.19);
      conGroup.add(btn);
      conBtns.push(btn);
      conBtnMats.push(bMat);
    }

    const consoleProxy = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.05, 0.7, 0.78)), proxyMat);
    consoleProxy.position.set(26.72, benchH + 0.22, 3.06);
    consoleProxy.userData.hideoutInteractable = {
      kind: 'ballistics_console',
      maxDistanceM: 3.0,
    } satisfies HideoutInteractableMeta;
    this.root.add(consoleProxy);
    interactableMeshes.push(consoleProxy);
    this.consoleWorldPos.set(26.72, benchH + 0.22, 2.95);

    this.electronics.registerNode(
      {
        id: 'lr_ballistics_console',
        label: 'Ballistics Control Console',
        hitMeshes: [conBox, conFace, ...conBtns],
        emissiveMaterials: conBtnMats,
        sparkOrigin: new THREE.Vector3(26.72, benchH + 0.2, 2.92),
        interactiveLinkId: 'ballistics_console',
        repairable: true,
        repairDurationSec: 2.0,
        onBreak: () => {
          this.consoleBroken = true;
        },
        onRepair: () => {
          this.consoleBroken = false;
        },
      },
      raycastMeshes,
    );
  }

  private buildMotorizedTrolley(raycastMeshes: THREE.Object3D[]): void {
    // Overhead steel I-beam carrier rail running Z = 4.6..104.8 at X = TROLLEY_X
    const railLen = 100.2;
    const railMidZ = 4.6 + railLen * 0.5;
    const railBeam = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.11, 0.14, railLen)),
      this.materials.darkSteel,
    );
    railBeam.position.set(TROLLEY_X, 4.3, railMidZ);
    railBeam.userData.isRoof = true;
    this.root.add(railBeam);

    const railFlange = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.22, 0.035, railLen)),
      this.materials.brushedSteel,
    );
    railFlange.position.set(TROLLEY_X, 4.23, railMidZ);
    railFlange.userData.isRoof = true;
    this.root.add(railFlange);

    // Moving Trolley Carriage + Hanger Pivot + 1.0m × 1.0m Precision Bullseye Target
    this.trolleyGroup = new THREE.Group();
    this.trolleyGroup.position.set(TROLLEY_X, 0, FIRING_LINE_Z + this.trolleyDistM);
    this.root.add(this.trolleyGroup);

    // Overhead drive motor carriage
    const carriage = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.42, 0.26, 0.62)),
      this.materials.darkSteel,
    );
    carriage.position.set(0, 4.12, 0);
    this.trolleyGroup.add(carriage);

    const motorBeaconMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 1.4,
        roughness: 0.25,
      }),
    );
    const motorBeacon = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.32, 0.06, 0.06)),
      motorBeaconMat,
    );
    motorBeacon.position.set(0, 4.02, -0.32);
    this.trolleyGroup.add(motorBeacon);

    // Top-hinged hanger pivot under carriage so paper swings realistically on rail impacts & trolley starts
    this.trolleyPivot = new THREE.Group();
    this.trolleyPivot.position.set(0, 4.10, 0);
    this.trolleyGroup.add(this.trolleyPivot);

    // Twin vertical hanger rods down to target clamp bar
    for (const sx of [-0.42, 0.42]) {
      const rod = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 2.08, 8)),
        this.materials.brushedSteel,
      );
      rod.position.set(sx, 3.04 - 4.10, 0);
      this.trolleyPivot.add(rod);
    }

    const clampBar = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(1.12, 0.08, 0.08)),
      this.materials.darkSteel,
    );
    clampBar.position.set(0, 2.0 - 4.10, 0);
    this.trolleyPivot.add(clampBar);

    // Precision Bullseye Paper Board (centered at Y = 1.46m — natural eye/benchrest line)
    const [pc, pctx] = buildPrecisionBullseyeCanvas();
    this.paperCanvas = pc;
    this.paperCtx = pctx;
    this.paperTex = this.trackTex(new THREE.CanvasTexture(pc));
    this.paperTex.colorSpace = THREE.SRGBColorSpace;
    this.paperTex.anisotropy = this.maxAniso;

    const paperMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: this.paperTex,
        roughness: 0.9,
        metalness: 0.0,
      }),
    );
    const paperBoard = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(PAPER_SIZE_M, PAPER_SIZE_M, 0.025)),
      paperMat,
    );
    paperBoard.position.set(0, 1.46 - 4.10, 0);
    paperBoard.userData.surfaceMaterial = 'wood';
    paperBoard.userData.ballisticMaterial = 'wood';
    paperBoard.userData.hideoutLongRangeTarget = {
      id: 'trolley_paper',
      kind: 'trolley_paper',
      zone: 'paper',
    } satisfies LongRangeTargetTag;
    this.trolleyPivot.add(paperBoard);
    raycastMeshes.push(paperBoard);
  }

  private buildLongRangeSteelArray(raycastMeshes: THREE.Object3D[]): void {
    const silTex = this.trackTex(buildSilhouette100mTex(this.maxAniso));

    const addHangingGong = (
      id: string,
      label: string,
      x: number,
      distM: number,
      radius: number,
      withHitBeacon: boolean,
    ): void => {
      const z = FIRING_LINE_Z + distM;
      const frame = new THREE.Group();
      frame.position.set(x, 0, z);
      this.root.add(frame);

      const span = radius * 2 + 0.44;
      const postH = 1.98;
      for (const sx of [-span * 0.5, span * 0.5]) {
        const post = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.065, postH, 0.065)),
          this.materials.darkSteel,
        );
        post.position.set(sx, postH * 0.5, 0);
        frame.add(post);
      }
      const crossbar = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(span + 0.12, 0.075, 0.075)),
        this.materials.darkSteel,
      );
      crossbar.position.set(0, postH, 0);
      frame.add(crossbar);

      let beaconMat: THREE.MeshStandardMaterial | null = null;
      let beaconMesh: THREE.Mesh | null = null;
      if (withHitBeacon) {
        beaconMat = this.trackMat(
          new THREE.MeshStandardMaterial({
            color: 0x374151,
            emissive: 0x111827,
            emissiveIntensity: 0.4,
            roughness: 0.25,
          }),
        );
        beaconMesh = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.085, 0.085, 0.14, 12)),
          beaconMat,
        );
        beaconMesh.position.set(0, postH + 0.11, 0);
        frame.add(beaconMesh);
      }

      const pivot = new THREE.Group();
      pivot.position.set(0, postH - 0.04, 0);
      frame.add(pivot);

      for (const cx of [-radius * 0.48, radius * 0.48]) {
        const chain = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.01, 0.01, 0.48, 6)),
          this.materials.brushedSteel,
        );
        chain.position.set(cx, -0.24, 0);
        pivot.add(chain);
      }

      const plateMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xd97706,
          roughness: 0.36,
          metalness: 0.74,
          emissive: 0x000000,
          emissiveIntensity: 0,
        }),
      );
      const disc = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(radius, radius, 0.032, 22)),
        plateMat,
      );
      disc.rotation.x = Math.PI * 0.5;
      disc.position.set(0, -(0.46 + radius), 0);
      disc.userData.surfaceMaterial = 'metal';
      disc.userData.ballisticMaterial = 'steel';
      disc.userData.hideoutLongRangeTarget = {
        id,
        kind: 'lr_steel_gong',
        zone: 'gong',
      } satisfies LongRangeTargetTag;
      pivot.add(disc);
      raycastMeshes.push(disc);

      // Center aim dot painted on front face (-Z)
      const dot = new THREE.Mesh(
        this.trackGeo(new THREE.CircleGeometry(radius * 0.24, 14)),
        this.trackMat(new THREE.MeshBasicMaterial({ color: 0x111317 })),
      );
      dot.position.set(0, -(0.46 + radius), -0.018);
      dot.rotation.y = Math.PI;
      pivot.add(dot);

      const entry: LongRangeSteelTarget = {
        id,
        label,
        kind: 'lr_steel_gong',
        distanceM: distM,
        pivot,
        plateMat,
        beaconMat,
        baseEmissiveHex: 0x000000,
        angleRad: 0,
        angVel: 0,
        flashTimerSec: 0,
        beaconTimerSec: 0,
        beaconBroken: false,
      };
      if (beaconMesh && beaconMat) {
        this.electronics.registerNode(
          {
            id: `lr_beacon_${id}`,
            label: `${distM}m Hit Strobe Beacon`,
            hitMeshes: [beaconMesh],
            emissiveMaterials: [beaconMat],
            sparkOrigin: new THREE.Vector3(x, postH + 0.11, z),
            isLightFixture: true,
            repairable: true,
            repairDurationSec: 1.85,
            onBreak: () => {
              entry.beaconBroken = true;
              entry.beaconTimerSec = 0;
            },
            onRepair: () => {
              entry.beaconBroken = false;
            },
          },
          raycastMeshes,
        );
      }
      this.steelTargets.push(entry);
      this.steelById.set(id, entry);
    };

    const addSteelSilhouette = (
      id: string,
      label: string,
      x: number,
      distM: number,
      withHitBeacon: boolean,
    ): void => {
      const z = FIRING_LINE_Z + distM;
      const stand = new THREE.Group();
      stand.position.set(x, 0, z);
      this.root.add(stand);

      const base = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.68, 0.1, 0.56)),
        this.materials.darkSteel,
      );
      base.position.set(0, 0.05, 0);
      stand.add(base);

      const post = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.08, 0.65, 0.08)),
        this.materials.darkSteel,
      );
      post.position.set(0, 0.36, 0);
      stand.add(post);

      let beaconMat: THREE.MeshStandardMaterial | null = null;
      let beaconMesh: THREE.Mesh | null = null;
      if (withHitBeacon) {
        beaconMat = this.trackMat(
          new THREE.MeshStandardMaterial({
            color: 0x374151,
            emissive: 0x111827,
            emissiveIntensity: 0.4,
            roughness: 0.25,
          }),
        );
        const beaconPole = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 1.85, 8)),
          this.materials.darkSteel,
        );
        beaconPole.position.set(0.42, 0.95, 0.08);
        stand.add(beaconPole);
        beaconMesh = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.085, 0.085, 0.14, 12)),
          beaconMat,
        );
        beaconMesh.position.set(0.42, 1.92, 0.08);
        stand.add(beaconMesh);
      }

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.68, 0);
      stand.add(pivot);

      const plateMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          map: silTex,
          roughness: 0.45,
          metalness: 0.62,
          emissive: 0x000000,
          emissiveIntensity: 0,
        }),
      );

      const torso = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.5, 0.72, 0.032)),
        plateMat,
      );
      torso.position.set(0, 0.38, 0);
      torso.userData.surfaceMaterial = 'metal';
      torso.userData.ballisticMaterial = 'steel';
      torso.userData.hideoutLongRangeTarget = {
        id,
        kind: 'lr_steel_silhouette',
        zone: 'a_zone',
      } satisfies LongRangeTargetTag;
      pivot.add(torso);
      raycastMeshes.push(torso);

      const head = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.22, 0.24, 0.034)),
        plateMat,
      );
      head.position.set(0, 0.87, 0);
      head.userData.surfaceMaterial = 'metal';
      head.userData.ballisticMaterial = 'steel';
      head.userData.hideoutLongRangeTarget = {
        id,
        kind: 'lr_steel_silhouette',
        zone: 'head',
      } satisfies LongRangeTargetTag;
      pivot.add(head);
      raycastMeshes.push(head);

      const entry: LongRangeSteelTarget = {
        id,
        label,
        kind: 'lr_steel_silhouette',
        distanceM: distM,
        pivot,
        plateMat,
        beaconMat,
        baseEmissiveHex: 0x000000,
        angleRad: 0,
        angVel: 0,
        flashTimerSec: 0,
        beaconTimerSec: 0,
        beaconBroken: false,
      };
      if (beaconMesh && beaconMat) {
        this.electronics.registerNode(
          {
            id: `lr_beacon_${id}`,
            label: `${distM}m Hit Strobe Beacon`,
            hitMeshes: [beaconMesh],
            emissiveMaterials: [beaconMat],
            sparkOrigin: new THREE.Vector3(x + 0.42, 1.92, z + 0.08),
            isLightFixture: true,
            repairable: true,
            repairDurationSec: 1.85,
            onBreak: () => {
              entry.beaconBroken = true;
              entry.beaconTimerSec = 0;
            },
            onRepair: () => {
              entry.beaconBroken = false;
            },
          },
          raycastMeshes,
        );
      }
      this.steelTargets.push(entry);
      this.steelById.set(id, entry);
    };

    // Staggered long-range steel gallery: 25m gong, 50m silhouette, 75m gong, 100m championship gong + 100m silhouette
    addHangingGong('lr_gong_25', '25m AR500 Gong', 30.85, 25, 0.16, false);
    addSteelSilhouette('lr_sil_50', '50m AR500 Silhouette', 30.95, 50, true);
    addHangingGong('lr_gong_75', '75m AR500 Gong', 31.05, 75, 0.22, true);
    addHangingGong('lr_gong_100', '100m Championship Gong', 29.45, 100, 0.27, true);
    addSteelSilhouette('lr_sil_100', '100m AR500 Silhouette', 31.45, 100, true);
  }

  private buildPenetrationTestRig(raycastMeshes: THREE.Object3D[]): void {
    // Terminal ballistics penetration & ricochet showcase along right lane (X = 31.95, Z = 14.5..19.5)
    const addTestStand = (
      id: string,
      label: string,
      kind: PenetrationPanel['kind'],
      x: number,
      z: number,
      w: number,
      h: number,
      thickness: number,
      colorHex: number,
      roughness: number,
      metalness: number,
      surface: BodycamSurfaceMaterial,
      ballisticMat: string,
      tiltX = 0,
    ): void => {
      const stand = new THREE.Group();
      stand.position.set(x, 0, z);
      this.root.add(stand);

      const base = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(w + 0.18, 0.08, 0.44)),
        this.materials.darkSteel,
      );
      base.position.set(0, 0.04, 0);
      stand.add(base);

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.72, 0);
      stand.add(pivot);

      const mat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: colorHex,
          roughness,
          metalness,
          emissive: 0x000000,
          emissiveIntensity: 0,
        }),
      );
      const mesh = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(w, h, thickness)), mat);
      mesh.position.set(0, h * 0.5, 0);
      mesh.rotation.x = tiltX;
      mesh.userData.surfaceMaterial = surface;
      mesh.userData.ballisticMaterial = ballisticMat;
      mesh.userData.ballisticThicknessM = thickness;
      mesh.userData.hideoutLongRangeTarget = {
        id,
        kind,
        zone:
          kind === 'pen_witness_plate'
            ? 'witness'
            : kind === 'pen_ricochet_plate'
              ? 'ricochet'
              : 'panel',
      } satisfies LongRangeTargetTag;
      pivot.add(mesh);
      raycastMeshes.push(mesh);

      if (kind === 'pen_wood_panel' && this.penetrableSystem) {
        this.penetrableSystem.registerSurface({
          id: `lr_${id}`,
          mesh,
          kind: 'plywood',
          width: w,
          height: h,
          thickness,
          faceAxis: 'z',
          floorY: 0,
          maxHoles: 6,
          hitsToBreach: 1,
        });
      }

      const entry: PenetrationPanel = {
        id,
        label,
        kind,
        mesh,
        mat,
        pivot,
        angleRad: 0,
        angVel: 0,
        flashTimerSec: 0,
        hitCount: 0,
      };
      this.penPanels.push(entry);
      this.penById.set(id, entry);
    };

    // 1. Timber Penetration Wall (11.5m) + Witness Steel Plate behind (12.1m)
    addTestStand(
      'pen_wood',
      '45mm Timber Barrier',
      'pen_wood_panel',
      31.55,
      14.7,
      0.72,
      0.92,
      0.045,
      0x8a6540,
      0.86,
      0.04,
      'wood',
      'wood',
    );
    addTestStand(
      'pen_wood_witness',
      'Timber Witness Steel',
      'pen_witness_plate',
      31.55,
      15.35,
      0.62,
      0.82,
      0.02,
      0x3b82f6,
      0.4,
      0.7,
      'metal',
      'steel',
    );

    // 2. Mild Steel Armor Plate (15.5m) + Witness Plate behind (16.1m)
    addTestStand(
      'pen_steel',
      '8mm Steel Plate',
      'pen_steel_panel',
      32.45,
      18.5,
      0.66,
      0.86,
      0.008,
      0x525b66,
      0.38,
      0.82,
      'metal',
      'steel',
    );
    addTestStand(
      'pen_steel_witness',
      'Armor Witness Steel',
      'pen_witness_plate',
      32.45,
      19.15,
      0.58,
      0.78,
      0.02,
      0x22c55e,
      0.4,
      0.7,
      'metal',
      'steel',
    );

    // 3. 60° Angled AR500 Ricochet Deflector (13.2m)
    addTestStand(
      'pen_ricochet',
      '60° Ricochet Deflector',
      'pen_ricochet_plate',
      32.5,
      16.4,
      0.64,
      0.74,
      0.025,
      0xd97706,
      0.34,
      0.78,
      'metal',
      'steel',
      0.92,
    );

    // Overhead header sign above Terminal Ballistics Rig
    const penSign = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(1.75, 0.42, 0.05)),
      this.materials.createSignMaterial('PENETRATION RIG', 'TIMBER · 8MM STEEL · 60° RICOCHET', '#22c55e'),
    );
    penSign.position.set(32.0, 2.35, 14.55);
    penSign.rotation.y = Math.PI;
    this.root.add(penSign);
  }

  public isPointInGalleryBay(x: number, z: number): boolean {
    return x >= TUNNEL_MIN_X - 0.3 && x <= TUNNEL_MAX_X + 0.3 && z >= TUNNEL_MIN_Z && z <= TUNNEL_MAX_Z;
  }

  public setAudioVolume(v: number): void {
    this.lrAudio.setVolume(v);
  }

  public getConsoleWorldPos(out: THREE.Vector3): boolean {
    out.copy(this.consoleWorldPos);
    return true;
  }

  public getTrolleyDistanceM(): number {
    return this.trolleyTargetDistM;
  }

  public getNextTrolleyDistanceM(): number {
    return TROLLEY_PRESETS_M[(this.trolleyPresetIdx + 1) % TROLLEY_PRESETS_M.length];
  }

  public setWeaponBallisticsContext(
    weaponName: string,
    ammoLabel: string,
    zeroDistanceM: number,
    nominalVelocityMs: number,
    nominalBc: number,
  ): void {
    this.weaponName = weaponName;
    this.ammoLabel = ammoLabel;
    this.zeroDistanceM = zeroDistanceM;
    this.nominalVelocityMs = nominalVelocityMs;
    this.nominalBc = nominalBc;
    this.redrawMonitor();
    this.redrawChronoScreen();
  }

  public cycleTrolleyDistance(): number {
    this.trolleyPresetIdx = (this.trolleyPresetIdx + 1) % TROLLEY_PRESETS_M.length;
    this.trolleyTargetDistM = TROLLEY_PRESETS_M[this.trolleyPresetIdx];
    this.lrAudio.playTrolleyMotorPulse(0.55);
    this.redrawMonitor();
    return this.trolleyTargetDistM;
  }

  public clearPaperTarget(): void {
    this.paperHits.length = 0;
    redrawPrecisionBullseyeBase(this.paperCtx, this.paperCanvas.width, this.paperCanvas.height);
    this.paperTex.needsUpdate = true;
    this.redrawMonitor();
  }

  public resetPenetrationRig(): void {
    for (const p of this.penPanels) {
      p.hitCount = 0;
      p.angleRad = 0;
      p.angVel = 0;
      p.flashTimerSec = 0;
      p.mat.emissive.setHex(0x000000);
      p.mat.emissiveIntensity = 0;
      this.penetrableSystem?.resetSurface(`lr_${p.id}`);
    }
    this.lrAudio.playTrolleyMotorPulse(0.28);
  }

  public recordMuzzleShot(params: {
    weaponName: string;
    ammoLabel: string;
    muzzleVelocityMs: number;
    bulletMassGrams: number;
    bc: number;
    zeroDistanceM: number;
  }): void {
    if (this.chronoBroken) return;
    const massKg = Math.max(0.001, params.bulletMassGrams * 0.001);
    const vMs = Math.max(1, params.muzzleVelocityMs);
    const energyJ = 0.5 * massKg * vMs * vMs;
    this.lastChrono = {
      weaponName: params.weaponName,
      ammoLabel: params.ammoLabel,
      muzzleVelocityMs: Math.round(vMs),
      muzzleVelocityFps: Math.round(vMs * 3.28084),
      muzzleEnergyJ: Math.round(energyJ),
      bulletMassGrains: Math.round(params.bulletMassGrams * 15.4324),
      bc: params.bc,
      zeroDistanceM: params.zeroDistanceM,
      timestampMs: performance.now(),
    };
    this.redrawChronoScreen();
    this.redrawMonitor();
  }

  private computeGroupMetrics(): { cm: number | null; moa: number | null } {
    if (this.paperHits.length < 2) return { cm: null, moa: null };
    let maxDistCm = 0;
    for (let i = 0; i < this.paperHits.length; i++) {
      for (let j = i + 1; j < this.paperHits.length; j++) {
        const dx = this.paperHits[i].cmX - this.paperHits[j].cmX;
        const dy = this.paperHits[i].cmY - this.paperHits[j].cmY;
        const d = Math.hypot(dx, dy);
        if (d > maxDistCm) maxDistCm = d;
      }
    }
    // 1 MOA ≈ 2.9089 cm at 100m -> scaled by current trolley distance
    const distM = Math.max(10, this.paperHits[this.paperHits.length - 1].distanceM);
    const cmPerMoa = 2.9089 * (distM / 100);
    const moa = maxDistCm / Math.max(0.1, cmPerMoa);
    return {
      cm: Math.round(maxDistCm * 10) / 10,
      moa: Math.round(moa * 100) / 100,
    };
  }

  public handleBallisticImpact(
    ev: Readonly<BallisticImpactEvent>,
    shooterPos?: Readonly<THREE.Vector3>,
  ): LongRangeHitRecord | null {
    const obj = ev.object as THREE.Mesh | null;
    if (!obj) return null;
    const tag = obj.userData.hideoutLongRangeTarget as LongRangeTargetTag | undefined;
    if (!tag) return null;

    const distM = shooterPos
      ? Math.max(1, Math.round(shooterPos.distanceTo(ev.point)))
      : Math.max(1, Math.round(ev.distanceM));
    const speedMs = Math.round(ev.impactSpeedMs);
    const energyJ = Math.round(ev.impactEnergyJ);
    // Relative vertical offset vs 1.46m nominal benchrest height (approx cm drop readout)
    const dropCm = Math.round((ev.point.y - 1.46) * 100 * 10) / 10;

    // 1. Motorized Overhead Precision Bullseye Paper Target
    if (tag.kind === 'trolley_paper') {
      this._tmpLocalHit.copy(ev.point);
      obj.worldToLocal(this._tmpLocalHit);
      const nx = THREE.MathUtils.clamp(this._tmpLocalHit.x / PAPER_SIZE_M, -0.49, 0.49);
      const ny = THREE.MathUtils.clamp(this._tmpLocalHit.y / PAPER_SIZE_M, -0.49, 0.49);
      const cmX = Math.round(nx * 100 * 10) / 10;
      const cmY = Math.round(ny * 100 * 10) / 10;
      const rNorm = Math.hypot(nx, ny);
      const ringLabel =
        rNorm <= 0.045
          ? 'X-RING'
          : rNorm <= 0.105
            ? '10-RING'
            : rNorm <= 0.185
              ? '9-RING'
              : rNorm <= 0.265
                ? '8-RING'
                : rNorm <= 0.345
                  ? '7-RING'
                  : 'OUTER';
      const ringScore =
        ringLabel === 'X-RING' || ringLabel === '10-RING'
          ? 10
          : ringLabel === '9-RING'
            ? 9
            : ringLabel === '8-RING'
              ? 8
              : ringLabel === '7-RING'
                ? 7
                : 6;

      // Clear previous group if distance changed since last plotted hit
      if (
        this.paperHits.length > 0 &&
        Math.abs(this.paperHits[0].distanceM - this.trolleyTargetDistM) > 1
      ) {
        this.clearPaperTarget();
      }

      const shotIdx = this.paperHits.length + 1;
      if (this.paperHits.length < 30) {
        this.paperHits.push({
          nx,
          ny,
          cmX,
          cmY,
          shotIndex: shotIdx,
          ringScore,
          distanceM: this.trolleyTargetDistM,
        });
      }

      // Draw crisp bullet hole onto the 3D paper canvas texture!
      const px = (0.5 - nx) * this.paperCanvas.width; // Front face is -Z so +localX maps right-to-left from shooter view
      const py = (0.5 - ny) * this.paperCanvas.height;
      this.paperCtx.beginPath();
      this.paperCtx.arc(px, py, 8.5, 0, Math.PI * 2);
      this.paperCtx.fillStyle = '#090a0d';
      this.paperCtx.fill();
      this.paperCtx.strokeStyle = '#f59e0b';
      this.paperCtx.lineWidth = 2.5;
      this.paperCtx.stroke();
      this.paperTex.needsUpdate = true;

      this.trolleySwingVel += computeTargetHingeAngularImpulse({
        pivot: this.trolleyPivot,
        hitPointWorld: ev.point,
        incomingDir: ev.incomingDir,
        impactSpeedMs: ev.impactSpeedMs,
        bulletMassGrams: ev.ammo.bulletMassGrams,
        pellets: ev.ammo.pellets,
        outcome: 'penetrate',
        effectiveInertia: 0.72,
        minDeltaRadSec: 0.8,
        maxDeltaRadSec: 5.5,
      });

      const grp = this.computeGroupMetrics();
      const is100m = this.trolleyTargetDistM >= 95;
      if (is100m) {
        this.hits100m++;
        if (this.paperHits.length >= 3 && grp.moa !== null) {
          if (this.bestMoa100m === null || grp.moa < this.bestMoa100m) {
            this.bestMoa100m = grp.moa;
          }
        }
        this.callbacks.on100mRecord?.({
          distanceM: this.trolleyTargetDistM,
          groupMoa: this.paperHits.length >= 3 ? grp.moa : null,
          is100mHit: true,
        });
      }

      const rec: LongRangeHitRecord = {
        targetLabel: `${this.trolleyTargetDistM}m Sighting Target`,
        zoneLabel: ringLabel,
        distanceM: distM,
        impactSpeedMs: speedMs,
        impactEnergyJ: energyJ,
        dropCm: cmY,
        outcome: 'hit',
        groupMoa: grp.moa,
        groupCm: grp.cm,
        isSteel: false,
        timestampMs: performance.now(),
      };
      this.lastHit = rec;
      this.redrawMonitor();
      return rec;
    }

    // 2. Long-Range AR500 Steel Gongs & Silhouettes (25m / 50m / 75m / 100m)
    const steel = this.steelById.get(tag.id);
    if (steel) {
      const isHead = tag.zone === 'head';
      steel.angVel += computeTargetHingeAngularImpulse({
        pivot: steel.pivot,
        hitPointWorld: ev.point,
        incomingDir: ev.incomingDir,
        impactSpeedMs: ev.impactSpeedMs,
        bulletMassGrams: ev.ammo.bulletMassGrams,
        pellets: ev.ammo.pellets,
        outcome: ev.outcome,
        outgoingDir: ev.outgoingDir,
        effectiveInertia: steel.kind === 'lr_steel_gong' ? 0.24 : 0.42,
        minDeltaRadSec: steel.kind === 'lr_steel_gong' ? 3.2 : 2.2,
        maxDeltaRadSec: 13.5,
      });
      steel.flashTimerSec = 0.22;
      steel.plateMat.emissive.setHex(isHead ? 0xfef08a : 0xf59e0b);
      steel.plateMat.emissiveIntensity = 1.4;
      if (steel.beaconMat) {
        steel.beaconTimerSec = 1.4;
        steel.beaconMat.color.setHex(0xfbbf24);
        steel.beaconMat.emissive.setHex(0xf59e0b);
        steel.beaconMat.emissiveIntensity = 3.2;
      }

      this.lrAudio.playDistantSteelRing(steel.distanceM, isHead || steel.kind === 'lr_steel_gong');

      if (steel.distanceM >= 95) {
        this.hits100m++;
        this.callbacks.on100mRecord?.({
          distanceM: steel.distanceM,
          groupMoa: null,
          is100mHit: true,
        });
      }

      const rec: LongRangeHitRecord = {
        targetLabel: steel.label,
        zoneLabel: isHead ? 'HEADSHOT' : steel.kind === 'lr_steel_gong' ? 'STEEL GONG' : 'A-ZONE',
        distanceM: steel.distanceM,
        impactSpeedMs: speedMs,
        impactEnergyJ: energyJ,
        dropCm,
        outcome: 'hit',
        groupMoa: null,
        groupCm: null,
        isSteel: true,
        timestampMs: performance.now(),
      };
      this.lastHit = rec;
      this.redrawMonitor();
      return rec;
    }

    // 3. Terminal Ballistics Penetration & Ricochet Test Rig
    const panel = this.penById.get(tag.id);
    if (panel) {
      panel.hitCount++;
      const outcome: LongRangeHitRecord['outcome'] =
        ev.outcome === 'penetrate'
          ? 'penetrate'
          : ev.outcome === 'ricochet'
            ? 'ricochet'
            : panel.kind === 'pen_witness_plate'
              ? 'penetrate'
              : 'stop';
      panel.angVel += computeTargetHingeAngularImpulse({
        pivot: panel.pivot,
        hitPointWorld: ev.point,
        incomingDir: ev.incomingDir,
        impactSpeedMs: ev.impactSpeedMs,
        bulletMassGrams: ev.ammo.bulletMassGrams,
        pellets: ev.ammo.pellets,
        outcome: outcome === 'penetrate' ? 'penetrate' : outcome === 'ricochet' ? 'ricochet' : 'stop',
        outgoingDir: ev.outgoingDir,
        effectiveInertia: panel.kind === 'pen_wood_panel' ? 0.34 : 0.44,
        minDeltaRadSec: 1.8,
        maxDeltaRadSec: 11.5,
      });
      panel.flashTimerSec = 0.2;

      const flashHex =
        outcome === 'penetrate'
          ? 0x22c55e
          : outcome === 'ricochet'
            ? 0xf59e0b
            : 0xef4444;
      panel.mat.emissive.setHex(flashHex);
      panel.mat.emissiveIntensity = 1.15;

      if (outcome === 'ricochet') {
        this.lrAudio.playRicochetWhine();
      } else if (panel.kind !== 'pen_wood_panel') {
        this.lrAudio.playDistantSteelRing(distM, outcome === 'penetrate');
      }

      const zoneLabel =
        panel.kind === 'pen_witness_plate'
          ? 'THROUGH-PENETRATION'
          : outcome === 'penetrate'
            ? 'PENETRATED'
            : outcome === 'ricochet'
              ? `RICOCHET ${Math.round(ev.grazingAngleDeg)}°`
              : 'STOPPED';

      const rec: LongRangeHitRecord = {
        targetLabel: panel.label,
        zoneLabel,
        distanceM: distM,
        impactSpeedMs: speedMs,
        impactEnergyJ: energyJ,
        dropCm: 0,
        outcome,
        groupMoa: null,
        groupCm: null,
        isSteel: panel.kind !== 'pen_wood_panel',
        timestampMs: performance.now(),
      };
      this.lastHit = rec;
      this.redrawMonitor();
      return rec;
    }

    return null;
  }

  private drawBrokenChronoScreen(): void {
    const ctx = this.chronoCtx;
    const w = this.chronoCanvas.width;
    const h = this.chronoCanvas.height;
    ctx.fillStyle = '#060709';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(180, 195, 210, 0.38)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w * 0.4, h * 0.5);
    ctx.lineTo(w * 0.9, h * 0.1);
    ctx.moveTo(w * 0.4, h * 0.5);
    ctx.lineTo(w * 0.08, h * 0.85);
    ctx.stroke();
    this.chronoTex.needsUpdate = true;
  }

  private drawBrokenMonitor(): void {
    const ctx = this.monitorCtx;
    const w = this.monitorCanvas.width;
    const h = this.monitorCanvas.height;
    ctx.fillStyle = '#060709';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(180, 195, 210, 0.34)';
    ctx.lineWidth = 2.5;
    const cx = w * 0.46;
    const cy = h * 0.52;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2 + 0.18;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * 440, cy + Math.sin(ang) * 320);
      ctx.stroke();
    }
    ctx.fillStyle = '#252a33';
    ctx.font = 'bold 26px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DISPLAY DAMAGED · NO SIGNAL', w * 0.5, h * 0.5);
    this.monitorTex.needsUpdate = true;
  }

  private redrawChronoScreen(): void {
    if (this.chronoBroken) return;
    const ctx = this.chronoCtx;
    const w = this.chronoCanvas.width;
    const h = this.chronoCanvas.height;
    ctx.fillStyle = '#070b10';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.lastChrono) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 42px "IBM Plex Mono", monospace';
      ctx.fillText(`${this.lastChrono.muzzleVelocityMs} M/S`, w * 0.5, 38);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'bold 18px "IBM Plex Mono", monospace';
      ctx.fillText(`${this.lastChrono.muzzleVelocityFps} FPS · ${this.lastChrono.muzzleEnergyJ} J`, w * 0.5, 76);
    } else {
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 28px "IBM Plex Mono", monospace';
      ctx.fillText('CHRONO READY', w * 0.5, 38);
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 18px "IBM Plex Mono", monospace';
      ctx.fillText(`NOM ${Math.round(this.nominalVelocityMs)} M/S`, w * 0.5, 74);
    }
    this.chronoTex.needsUpdate = true;
  }

  private redrawMonitor(): void {
    if (this.monitorBroken) return;
    const ctx = this.monitorCtx;
    const w = this.monitorCanvas.width;
    const h = this.monitorCanvas.height;

    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#252c36';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    // Header bar
    ctx.fillStyle = '#131922';
    ctx.fillRect(4, 4, w - 8, 52);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 22px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('BALLISTICS BENCH · TARGET CAM', 24, 30);

    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'right';
    ctx.fillText(`TROLLEY ${this.trolleyTargetDistM}M · ZERO ${this.zeroDistanceM}M`, w - 24, 30);

    // === LEFT PANE: LIVE TARGET-CAM IMPACT PLOT (460 × 460) ===
    const boxX = 28;
    const boxY = 74;
    const boxS = 456;
    ctx.fillStyle = '#14181f';
    ctx.fillRect(boxX, boxY, boxS, boxS);
    ctx.strokeStyle = '#2e3744';
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxS, boxS);

    const cx = boxX + boxS * 0.5;
    const cy = boxY + boxS * 0.5;

    // Crosshair & rings
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, boxY + 8);
    ctx.lineTo(cx, boxY + boxS - 8);
    ctx.moveTo(boxX + 8, cy);
    ctx.lineTo(boxX + boxS - 8, cy);
    ctx.stroke();

    for (const frac of [0.42, 0.30, 0.18, 0.08]) {
      ctx.beginPath();
      ctx.arc(cx, cy, boxS * frac, 0, Math.PI * 2);
      ctx.strokeStyle = frac <= 0.18 ? 'rgba(245, 158, 11, 0.55)' : 'rgba(148, 163, 184, 0.3)';
      ctx.lineWidth = frac <= 0.08 ? 2.5 : 1.5;
      ctx.stroke();
    }

    // Plot all recorded trolley paper hits
    for (let i = 0; i < this.paperHits.length; i++) {
      const hit = this.paperHits[i];
      // Shooter-perspective plot: -nx is right, +ny is up
      const hx = cx - hit.nx * boxS;
      const hy = cy - hit.ny * boxS;
      const isLatest = i === this.paperHits.length - 1;
      ctx.beginPath();
      ctx.arc(hx, hy, isLatest ? 7.5 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = isLatest ? '#f59e0b' : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = '#0b0e13';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Group spread footer inside target cam
    const grp = this.computeGroupMetrics();
    ctx.fillStyle = '#e5e7eb';
    ctx.font = 'bold 18px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`SHOTS: ${this.paperHits.length}`, boxX + 12, boxY + boxS - 18);
    ctx.textAlign = 'right';
    ctx.fillStyle = grp.moa !== null ? '#38bdf8' : '#64748b';
    ctx.fillText(
      grp.moa !== null && grp.cm !== null ? `GROUP: ${grp.moa.toFixed(2)} MOA (${grp.cm}cm)` : 'GROUP: --',
      boxX + boxS - 12,
      boxY + boxS - 18,
    );

    // === RIGHT PANE: CHRONOGRAPH & TERMINAL BALLISTICS TELEMETRY ===
    const rx = 516;
    ctx.textAlign = 'left';

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 17px "IBM Plex Mono", monospace';
    ctx.fillText('WEAPON & LOAD', rx, 94);
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px "IBM Plex Mono", monospace';
    ctx.fillText(`${this.weaponName}`, rx, 128);
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 20px "IBM Plex Mono", monospace';
    ctx.fillText(`${this.ammoLabel} · G1 BC ${this.nominalBc.toFixed(3)}`, rx, 160);

    // Divider
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(rx, 184, 480, 2);

    // Chronograph block
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 17px "IBM Plex Mono", monospace';
    ctx.fillText('OPTICAL CHRONOGRAPH', rx, 212);
    const vMs = this.lastChrono ? this.lastChrono.muzzleVelocityMs : Math.round(this.nominalVelocityMs);
    const vFps = Math.round(vMs * 3.28084);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 38px "IBM Plex Mono", monospace';
    ctx.fillText(`${vMs} m/s`, rx, 256);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 20px "IBM Plex Mono", monospace';
    ctx.fillText(
      this.lastChrono
        ? `${vFps} fps · ${this.lastChrono.muzzleEnergyJ} J · ${this.lastChrono.bulletMassGrains} gr`
        : `${vFps} fps (Nominal)`,
      rx,
      292,
    );

    ctx.fillStyle = '#1f2937';
    ctx.fillRect(rx, 316, 480, 2);

    // Terminal impact block
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 17px "IBM Plex Mono", monospace';
    ctx.fillText('LAST IMPACT TELEMETRY', rx, 344);

    if (this.lastHit) {
      const outcomeColor =
        this.lastHit.outcome === 'penetrate'
          ? '#22c55e'
          : this.lastHit.outcome === 'ricochet'
            ? '#f59e0b'
            : this.lastHit.outcome === 'stop'
              ? '#ef4444'
              : '#fbbf24';
      ctx.fillStyle = outcomeColor;
      ctx.font = 'bold 26px "IBM Plex Mono", monospace';
      ctx.fillText(`${this.lastHit.zoneLabel} · ${this.lastHit.distanceM}M`, rx, 382);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 20px "IBM Plex Mono", monospace';
      ctx.fillText(
        `IMPACT ${this.lastHit.impactSpeedMs} m/s · ${this.lastHit.impactEnergyJ} J`,
        rx,
        418,
      );
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${this.lastHit.targetLabel}`, rx, 450);
    } else {
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 22px "IBM Plex Mono", monospace';
      ctx.fillText('AWAITING LIVE FIRE IN BAY 3', rx, 386);
    }

    // Bottom 100m Career Record line
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(rx, 480, 480, 2);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 18px "IBM Plex Mono", monospace';
    const bestStr = this.bestMoa100m !== null ? `${this.bestMoa100m.toFixed(2)} MOA` : '--';
    ctx.fillText(`100M HITS: ${this.hits100m}   ·   BEST 100M GROUP: ${bestStr}`, rx, 514);

    this.monitorTex.needsUpdate = true;
  }

  public update(dt: number): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);

    // 1. Smoothly drive motorized overhead target trolley along rail
    const distErr = this.trolleyTargetDistM - this.trolleyDistM;
    if (Math.abs(distErr) > 0.02) {
      const maxSpeedMps = 16.0;
      const desiredVel = THREE.MathUtils.clamp(distErr * 3.8, -maxSpeedMps, maxSpeedMps);
      this.trolleyVelMps = THREE.MathUtils.damp(this.trolleyVelMps, desiredVel, 6.5, clampedDt);
      this.trolleyDistM += this.trolleyVelMps * clampedDt;
      // Subtle inertial pendulum tilt while accelerating/braking
      this.trolleySwingVel += (desiredVel - this.trolleyVelMps) * 0.05;
    } else {
      this.trolleyDistM = this.trolleyTargetDistM;
      this.trolleyVelMps = 0;
    }

    const swingAcc = -this.trolleySwingRad * 38 - this.trolleySwingVel * 6.5;
    this.trolleySwingVel += swingAcc * clampedDt;
    this.trolleySwingRad = THREE.MathUtils.clamp(
      this.trolleySwingRad + this.trolleySwingVel * clampedDt,
      -0.35,
      0.35,
    );
    this.trolleyGroup.position.z = FIRING_LINE_Z + this.trolleyDistM;
    this.trolleyPivot.rotation.x = this.trolleySwingRad;

    // 2. Update 25m / 50m / 75m / 100m steel pendulum recoil, plate flashes & hit strobe beacons
    for (let i = 0; i < this.steelTargets.length; i++) {
      const s = this.steelTargets[i];
      if (s.flashTimerSec > 0) {
        s.flashTimerSec = Math.max(0, s.flashTimerSec - clampedDt);
        s.plateMat.emissiveIntensity = (s.flashTimerSec / 0.22) * 1.4;
        if (s.flashTimerSec <= 0) {
          s.plateMat.emissive.setHex(s.baseEmissiveHex);
        }
      }
      if (s.beaconMat && !s.beaconBroken && s.beaconTimerSec > 0) {
        s.beaconTimerSec = Math.max(0, s.beaconTimerSec - clampedDt);
        if (s.beaconTimerSec > 0) {
          // Crisp 8 Hz strobe visible from 100m away through magnified optics
          const pulse = Math.sin(s.beaconTimerSec * 50) > 0 ? 3.4 : 0.7;
          s.beaconMat.emissiveIntensity = pulse;
        } else {
          s.beaconMat.color.setHex(0x374151);
          s.beaconMat.emissive.setHex(0x111827);
          s.beaconMat.emissiveIntensity = 0.4;
        }
      }
      const stiffness = s.kind === 'lr_steel_gong' ? 30 : 54;
      const damping = s.kind === 'lr_steel_gong' ? 2.8 : 7.5;
      const acc = -s.angleRad * stiffness - s.angVel * damping;
      s.angVel += acc * clampedDt;
      s.angleRad = THREE.MathUtils.clamp(s.angleRad + s.angVel * clampedDt, -1.05, 1.05);
      s.pivot.rotation.x = s.angleRad;
    }

    // 3. Update Penetration Test Rig recoil & hit flashes
    for (let i = 0; i < this.penPanels.length; i++) {
      const p = this.penPanels[i];
      if (p.flashTimerSec > 0) {
        p.flashTimerSec = Math.max(0, p.flashTimerSec - clampedDt);
        p.mat.emissiveIntensity = (p.flashTimerSec / 0.2) * 1.15;
        if (p.flashTimerSec <= 0) {
          p.mat.emissive.setHex(0x000000);
        }
      }
      const acc = -p.angleRad * 58 - p.angVel * 8.5;
      p.angVel += acc * clampedDt;
      p.angleRad = THREE.MathUtils.clamp(p.angleRad + p.angVel * clampedDt, -0.55, 0.78);
      p.pivot.rotation.x = p.angleRad;
    }
  }

  public getState(playerX: number, playerZ: number): LongRangeSnapshot {
    const now = performance.now();
    const grp = this.computeGroupMetrics();
    const recentHit =
      this.lastHit && now - this.lastHit.timestampMs < 3200 ? { ...this.lastHit } : null;
    return {
      inGalleryBay: this.isPointInGalleryBay(playerX, playerZ),
      trolleyDistanceM: Math.round(this.trolleyDistM),
      trolleyTargetDistanceM: this.trolleyTargetDistM,
      trolleyMoving: Math.abs(this.trolleyTargetDistM - this.trolleyDistM) > 0.15,
      paperHitCount: this.paperHits.length,
      groupSizeCm: grp.cm,
      groupSizeMoa: grp.moa,
      bestMoa100m: this.bestMoa100m,
      hits100m: this.hits100m,
      lastChrono: this.lastChrono ? { ...this.lastChrono } : null,
      lastHit: recentHit,
    };
  }

  public dispose(): void {
    this.lrAudio.dispose();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTex) t.dispose();
    this.ownedGeos.length = 0;
    this.ownedMats.length = 0;
    this.ownedTex.length = 0;
    this.root.parent?.remove(this.root);
  }
}

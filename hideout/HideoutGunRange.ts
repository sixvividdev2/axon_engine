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

export type RangeCoursePhase = 'idle' | 'countdown' | 'active' | 'finished';

export type RangeTargetKind =
  | 'steel_popper'
  | 'steel_gong'
  | 'paper_silhouette'
  | 'cqb_popup'
  | 'course_start_paddle';

export type RangeHitZone = 'head' | 'a_zone' | 'torso' | 'gong' | 'no_shoot' | 'paddle';

export interface RangeHitFeedback {
  targetId: string;
  label: string;
  zone: RangeHitZone;
  scoreDelta: number;
  distanceM: number;
  isSteel: boolean;
  isNoShoot: boolean;
  timestampMs: number;
}

export interface GunRangeSnapshot {
  phase: RangeCoursePhase;
  countdownSec: number;
  timeRemainingSec: number;
  courseDurationSec: number;
  score: number;
  hits: number;
  headshots: number;
  noShootPenalties: number;
  shotsFiredInCourse: number;
  accuracyPct: number;
  streak: number;
  bestStreak: number;
  bestScore: number;
  isNewBest: boolean;
  lastHit: RangeHitFeedback | null;
}

export interface GunRangeBestRecord {
  bestScore: number;
  bestHits: number;
  bestAccuracy: number;
}

export interface HideoutGunRangeCallbacks {
  onCourseComplete?: (result: {
    score: number;
    hits: number;
    headshots: number;
    accuracyPct: number;
    isNewBest: boolean;
  }) => void;
}

interface RangeTargetMeshTag {
  id: string;
  kind: RangeTargetKind;
  zone: 'head' | 'a_zone' | 'torso' | 'gong' | 'paddle';
}

interface FreeReactiveTarget {
  id: string;
  label: string;
  kind: 'steel_popper' | 'steel_gong' | 'paper_silhouette';
  distanceM: number;
  pivot: THREE.Group;
  plateMat: THREE.MeshStandardMaterial;
  baseEmissiveHex: number;
  angleRad: number;
  angVel: number;
  knockedDown: boolean;
  resetTimerSec: number;
  flashTimerSec: number;
  hitMeshes: THREE.Mesh[];
  worldPos: THREE.Vector3;
}

interface CqbPopupStation {
  id: string;
  label: string;
  distanceM: number;
  pivot: THREE.Group;
  hostileFaceGroup: THREE.Group;
  noShootFaceGroup: THREE.Group;
  statusLedMat: THREE.MeshStandardMaterial;
  worldPos: THREE.Vector3;
  isNoShoot: boolean;
  raised: boolean;
  angleRad: number; // 0 = upright (active), -Math.PI*0.48 = folded flat down
  angVel: number;
  stayTimerSec: number;
  cooldownSec: number;
  flashTimerSec: number;
  hitMeshes: THREE.Mesh[];
}

const COURSE_DURATION_SEC = 30.0;
const COUNTDOWN_DURATION_SEC = 3.0;
const POPUP_FOLDED_RAD = Math.PI * 0.48;
const POPPER_KNOCKED_RAD = Math.PI * 0.44;

/**
 * Procedural Web Audio range timer & steel-clang cue synthesizer.
 * Zero external audio assets; respects master volume cleanly.
 */
class RangeTimerAudio {
  private ctx: AudioContext | null = null;
  private volume = 0.72;

  public setVolume(vol: number): void {
    this.volume = THREE.MathUtils.clamp(vol, 0, 1);
  }

  private ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public playTone(freqHz: number, durSec: number, type: OscillatorType = 'square', gainScale = 0.22): void {
    const ctx = this.ensureCtx();
    if (!ctx || this.volume <= 0.005) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqHz, t0);
    const peak = this.volume * gainScale;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durSec);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durSec + 0.02);
  }

  public playCountdownPip(): void {
    this.playTone(980, 0.11, 'triangle', 0.24);
  }

  public playStartBeep(): void {
    // Authentic shot-timer high piezo start signal
    this.playTone(2350, 0.34, 'square', 0.2);
  }

  public playEndBuzzer(): void {
    this.playTone(1850, 0.22, 'sawtooth', 0.2);
    window.setTimeout(() => this.playTone(1420, 0.32, 'sawtooth', 0.18), 160);
  }

  public playNoShootBuzzer(): void {
    this.playTone(195, 0.28, 'sawtooth', 0.28);
  }

  public playPopupPneumatic(): void {
    this.playTone(340, 0.065, 'triangle', 0.12);
  }

  public playSteelRing(isHeadshot: boolean): void {
    const base = isHeadshot ? 1740 : 1240;
    this.playTone(base, isHeadshot ? 0.38 : 0.28, 'sine', 0.24);
    this.playTone(base * 1.49, 0.18, 'triangle', 0.12);
  }

  public dispose(): void {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function buildIpscTargetTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 768);
  // Warm kraft cardboard backing
  ctx.fillStyle = '#c4a678';
  ctx.fillRect(0, 0, 512, 768);

  // Subtle cardboard grain lines
  ctx.strokeStyle = 'rgba(72, 54, 34, 0.12)';
  ctx.lineWidth = 2;
  for (let y = 0; y < 768; y += 8) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }

  // Outer silhouette border
  ctx.strokeStyle = '#2c241b';
  ctx.lineWidth = 8;
  ctx.strokeRect(24, 24, 464, 720);

  // Head A-Zone box (upper)
  ctx.fillStyle = 'rgba(34, 30, 26, 0.14)';
  ctx.fillRect(184, 52, 144, 148);
  ctx.strokeStyle = '#1f1a15';
  ctx.lineWidth = 5;
  ctx.strokeRect(184, 52, 144, 148);
  ctx.strokeStyle = '#b91c1c';
  ctx.lineWidth = 3;
  ctx.strokeRect(208, 76, 96, 98);

  // Outer D-zone torso outline
  ctx.strokeStyle = '#33291f';
  ctx.lineWidth = 4;
  ctx.strokeRect(64, 232, 384, 480);

  // C-Zone inner polygon
  ctx.strokeStyle = '#231d17';
  ctx.lineWidth = 4;
  ctx.strokeRect(114, 266, 284, 392);

  // Center-mass A-Zone high-contrast box
  ctx.fillStyle = 'rgba(185, 28, 28, 0.12)';
  ctx.fillRect(172, 310, 168, 248);
  ctx.strokeStyle = '#b91c1c';
  ctx.lineWidth = 5;
  ctx.strokeRect(172, 310, 168, 248);

  // Crisp scoring labels
  ctx.fillStyle = '#1d1814';
  ctx.font = 'bold 40px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('A', 256, 448);
  ctx.font = 'bold 28px "IBM Plex Mono", monospace';
  ctx.fillText('A', 256, 136);
  ctx.fillText('C', 142, 316);
  ctx.fillText('D', 88, 276);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildHostilePopupTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 768);
  ctx.fillStyle = '#1a1e23';
  ctx.fillRect(0, 0, 512, 768);

  // Tactical plate frame & chamfer highlights
  ctx.strokeStyle = '#404852';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, 484, 740);

  // Head critical zone (amber-red crosshair box)
  ctx.fillStyle = '#252a30';
  ctx.fillRect(178, 42, 156, 152);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 6;
  ctx.strokeRect(194, 58, 124, 120);

  // Chest A-Zone ring (high visibility orange-amber on charcoal AR500 steel)
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 7;
  ctx.strokeRect(148, 274, 216, 260);

  ctx.beginPath();
  ctx.arc(256, 398, 74, 0, Math.PI * 2);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(256, 398, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#f59e0b';
  ctx.fill();

  ctx.fillStyle = '#d1d5db';
  ctx.font = 'bold 26px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('HOSTILE · AR500', 256, 672);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildNoShootTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 768);
  ctx.fillStyle = '#dbe4ee';
  ctx.fillRect(0, 0, 512, 768);

  // Bold blue border + diagonal friendly identification band
  ctx.strokeStyle = '#1d4ed8';
  ctx.lineWidth = 22;
  ctx.strokeRect(18, 18, 476, 732);

  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(42, 286, 428, 168);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 58px "Oswald", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NO-SHOOT', 256, 366);
  ctx.font = 'bold 28px "IBM Plex Mono", monospace';
  ctx.fillText('NON-COMBATANT', 256, 418);

  // Open palm / friendly marker circle at head
  ctx.strokeStyle = '#1d4ed8';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(256, 126, 56, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildDistanceFloorDecal(label: string, maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 96);
  ctx.clearRect(0, 0, 256, 96);
  ctx.fillStyle = 'rgba(217, 119, 6, 0.82)';
  ctx.fillRect(10, 74, 236, 8);
  ctx.font = '700 46px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, 128, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

/**
 * Hideout Phase 2: Full-featured Tactical Gun Range & 30-Second CQB Pop-Up Course.
 * Fits cleanly inside the East Wing Gun Range shell (X ∈ [6.5, 24.5], Z ∈ [-10.0, 36.0], H = 4.6m).
 *
 * Layout:
 *  - Firing Line & 3 Shooting Booths at Z = 3.2 (facing +Z downrange)
 *  - Range Master Control Console (left firing booth, [F] + Scroll interactable)
 *  - Range Bench Ammo Box ([F] quick resupply right on the firing line)
 *  - Physical "SHOOT TO START" Steel Activation Paddle next to Bay 2
 *  - Overhead Live-Updating Segmented LED Scoreboard at Z = 8.5
 *  - Bay 1 (X ∈ [7.2, 14.2]): Free-Fire Reactive AR500 Steel Poppers, Swinging Gongs, & Scored IPSC Paper Silhouettes (10m–30m)
 *  - Bay 2 (X ∈ [14.8, 23.6]): Shoot-House CQB Cover Barricades + 10 Motorized Pneumatic Pop-Up Targets (Hostile & No-Shoot)
 */
export class HideoutGunRange {
  private readonly root = new THREE.Group();
  private readonly physics: BodycamPhysicsWorld;
  private readonly materials: HideoutMaterialLibrary;
  private readonly isSoftwareGl: boolean;
  private readonly maxAniso: number;
  private readonly callbacks: HideoutGunRangeCallbacks;
  private readonly rangeAudio = new RangeTimerAudio();

  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTex: THREE.Texture[] = [];

  private readonly freeTargets: FreeReactiveTarget[] = [];
  private readonly freeById = new Map<string, FreeReactiveTarget>();
  private readonly cqbStations: CqbPopupStation[] = [];
  private readonly cqbById = new Map<string, CqbPopupStation>();

  private startPaddlePivot!: THREE.Group;
  private startPaddleAngle = 0;
  private startPaddleAngVel = 0;
  private startPaddleMat!: THREE.MeshStandardMaterial;

  // Live 3D Overhead LED Scoreboard + Console Mini-Screen CanvasTexture
  private scoreboardCanvas!: HTMLCanvasElement;
  private scoreboardCtx!: CanvasRenderingContext2D;
  private scoreboardTex!: THREE.CanvasTexture;
  private lastBoardRenderKey = '';

  private consoleWorldPos = new THREE.Vector3(8.5, 1.15, 2.85);
  private rangeAmmoWorldPos = new THREE.Vector3(7.35, 0.96, 2.65);

  // Course state
  private phase: RangeCoursePhase = 'idle';
  private countdownSec = 0;
  private lastCountdownBeepInt = 4;
  private timeRemainingSec = COURSE_DURATION_SEC;
  private score = 0;
  private hits = 0;
  private headshots = 0;
  private noShootPenalties = 0;
  private shotsFiredInCourse = 0;
  private streak = 0;
  private bestStreak = 0;
  private bestScore = 0;
  private isNewBest = false;
  private lastHit: RangeHitFeedback | null = null;
  private lastSpawnedStationIdx = -1;
  private noShootSpawnCounter = 0;

  // Zero-GC scratch
  private readonly _tmpLocalHit = new THREE.Vector3();
  private readonly electronics: HideoutElectronicsSystem;
  private readonly penetrableSystem?: PenetrableSurfaceSystem;
  private consoleBroken = false;
  private scoreboardBroken = false;

  constructor(
    parent: THREE.Object3D,
    physics: BodycamPhysicsWorld,
    materials: HideoutMaterialLibrary,
    electronics: HideoutElectronicsSystem,
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
    isSoftwareGl: boolean,
    maxAniso: number,
    initialBestScore = 0,
    callbacks: HideoutGunRangeCallbacks = {},
    penetrableSystem?: PenetrableSurfaceSystem,
  ) {
    this.physics = physics;
    this.materials = materials;
    this.electronics = electronics;
    this.penetrableSystem = penetrableSystem;
    this.isSoftwareGl = isSoftwareGl;
    this.maxAniso = maxAniso;
    this.bestScore = Math.max(0, Math.round(initialBestScore));
    this.callbacks = callbacks;

    this.root.name = 'HideoutGunRangePhase2';
    parent.add(this.root);

    this.buildRangeArchitectureAndBooths(raycastMeshes, interactableMeshes);
    this.buildOverheadScoreboard(raycastMeshes);
    this.buildBay1ReactiveTargets(raycastMeshes);
    this.buildBay2CqbCourse(raycastMeshes);
    this.redrawScoreboard(true);
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

  public setAudioVolume(vol: number): void {
    this.rangeAudio.setVolume(vol);
  }

  public setBestScore(bestScore: number): void {
    if (bestScore > this.bestScore) {
      this.bestScore = bestScore;
      this.redrawScoreboard(true);
    }
  }

  public getConsoleWorldPos(out: THREE.Vector3): boolean {
    out.copy(this.consoleWorldPos);
    return true;
  }

  public getRangeAmmoWorldPos(out: THREE.Vector3): boolean {
    out.copy(this.rangeAmmoWorldPos);
    return true;
  }

  public isCourseRunning(): boolean {
    return this.phase === 'countdown' || this.phase === 'active';
  }

  public registerShotFired(): void {
    if (this.phase === 'active') {
      this.shotsFiredInCourse++;
    }
  }

  private addSolidProp(
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
    rotY = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(cx, cy, cz);
    mesh.rotation.y = rotY;
    mesh.receiveShadow = true;
    mesh.castShadow = !this.isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    mesh.userData.ballisticMaterial =
      surface === 'metal' ? 'steel' : surface === 'wood' ? 'wood' : 'concrete';
    this.root.add(mesh);
    raycastMeshes.push(mesh);
    if (collides && Math.abs(rotY) < 0.01) {
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

  private buildRangeArchitectureAndBooths(
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
  ): void {
    const proxyMat = this.trackMat(new THREE.MeshBasicMaterial({ visible: false }));

    // Additional gallery lighting downrange so 10m-33m targets read sharply
    const cqbMidLight = new THREE.PointLight(0xdce7f2, 8.5, 24, 1.35);
    cqbMidLight.position.set(19.2, 4.15, 14.5);
    this.root.add(cqbMidLight);

    const backstopLight = new THREE.PointLight(0xffe1b8, 7.5, 22, 1.4);
    backstopLight.position.set(14.5, 4.1, 30.5);
    this.root.add(backstopLight);

    // Overhead fluorescent strips across Bay 1 & Bay 2 (individually shootable/breakable)
    const rangeLamps: Array<[number, number, THREE.PointLight]> = [
      [10.8, 12.0, cqbMidLight],
      [10.8, 25.0, backstopLight],
      [19.2, 12.0, cqbMidLight],
      [19.2, 24.0, backstopLight],
    ];
    for (let i = 0; i < rangeLamps.length; i++) {
      const [lx, lz, linkedLight] = rangeLamps[i];
      const housing = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(1.4, 0.08, 0.24)),
        this.materials.darkSteel,
      );
      housing.position.set(lx, 4.44, lz);
      housing.userData.isRoof = true;
      this.root.add(housing);
      const tube = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(1.25, 0.04, 0.14)),
        this.materials.warmLampEmissive,
      );
      tube.position.set(lx, 4.395, lz);
      tube.userData.isRoof = true;
      this.root.add(tube);

      this.electronics.registerNode(
        {
          id: `range_lamp_${i}`,
          label: 'Overhead Fluorescent Light',
          hitMeshes: [housing, tube],
          emissiveMeshes: [tube],
          linkedLights: [{ light: linkedLight, dropFraction: 0.5 }],
          sparkOrigin: new THREE.Vector3(lx, 4.36, lz),
          isLightFixture: true,
        },
        raycastMeshes,
      );
    }

    // Painted firing-line safety stripe across full range width at Z = 3.85
    const firingLineStripe = new THREE.Mesh(
      this.trackGeo(new THREE.PlaneGeometry(17.4, 0.26)),
      this.materials.hazardStripe,
    );
    firingLineStripe.rotation.x = -Math.PI * 0.5;
    firingLineStripe.position.set(15.5, 0.014, 3.85);
    this.root.add(firingLineStripe);

    // Painted floor distance markers along Bay 1 (measured from Z = 3.2 firing line)
    for (const distM of [10, 15, 20, 25, 30]) {
      const tex = this.trackTex(buildDistanceFloorDecal(`${distM}M`, this.maxAniso));
      const mat = this.trackMat(
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      );
      const plane = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(1.6, 0.6)), mat);
      plane.rotation.x = -Math.PI * 0.5;
      plane.position.set(10.8, 0.016, 3.2 + distM);
      this.root.add(plane);
    }

    // === 3 ARMORED FIRING STALLS / SHOOTING BENCHES AT Z = 3.2 ===
    // Stall dividers at X = 7.0, 10.6, 14.2 (Bay 1 stalls) and X = 18.8 (Bay 2 firing box), leaving clear 4.2m walk-through lane into Bay 2 CQB
    const dividerXs = [7.0, 10.7, 14.4, 23.8];
    for (const dx of dividerXs) {
      // Heavy steel-framed acoustic ballistic stall wall
      this.addSolidProp(dx, 1.28, 2.75, 0.14, 2.56, 1.68, this.materials.darkSteel, 'metal', raycastMeshes, true);
      // Rubberized sound-deadening panel inset
      const pad = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.16, 1.48, 1.38)),
        this.materials.rubberMat,
      );
      pad.position.set(dx, 1.45, 2.75);
      this.root.add(pad);
    }

    // Shooting benches in Bay 1 Stalls 1 & 2 (X ∈ [7.15, 10.55] and [10.85, 14.25]) — Bay 2 left open at Z=3.2 with side bench so player can shoot from line OR advance into CQB shoot-house!
    for (const [bx, bw] of [
      [8.85, 3.3],
      [12.55, 3.3],
      [21.3, 4.4],
    ]) {
      // Bench tabletop at Y = 0.88m (low enough to rest rifle or shoot cleanly over)
      this.addSolidProp(bx, 0.86, 3.22, bw, 0.07, 0.72, this.materials.tableWood, 'wood', raycastMeshes, true);
      // Rubber shooting mat on bench
      const mat = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(bw - 0.35, 0.012, 0.52)),
        this.materials.rubberMat,
      );
      mat.position.set(bx, 0.902, 3.22);
      this.root.add(mat);
      // Welded steel support legs
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.06, 0.83, 0.56)),
          this.materials.darkSteel,
        );
        leg.position.set(bx + sx * (bw * 0.44), 0.415, 3.22);
        this.root.add(leg);
      }
      // Solid lower collider under bench
      this.physics.addBox({
        minX: bx - bw * 0.5,
        maxX: bx + bw * 0.5,
        minY: 0,
        maxY: 0.9,
        minZ: 2.86,
        maxZ: 3.58,
        surface: 'wood',
      });
    }

    // Bay separator armored baffle wall between Bay 1 & Bay 2 (X = 14.5, Z = 6.5..31.0, height 2.35m)
    this.addSolidProp(14.5, 1.18, 18.8, 0.24, 2.36, 24.4, this.materials.concreteWall, 'concrete', raycastMeshes, true);
    // Steel top cap trim on lane separator
    const sepCap = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.28, 0.08, 24.44)),
      this.materials.darkSteel,
    );
    sepCap.position.set(14.5, 2.38, 18.8);
    this.root.add(sepCap);

    // Bay plaques overhead above firing line
    const bay1Plaque = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(2.1, 0.5, 0.06)),
      this.materials.createSignMaterial('BAY 1 · BALLISTICS', 'REACTIVE STEEL & IPSC · 10–30M', '#d97706'),
    );
    bay1Plaque.position.set(10.7, 3.55, 3.8);
    bay1Plaque.rotation.y = Math.PI;
    this.root.add(bay1Plaque);

    const bay2Plaque = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(2.3, 0.5, 0.06)),
      this.materials.createSignMaterial('BAY 2 · CQB COURSE', '30S POP-UP DRILL · SHOOT-HOUSE', '#ef4444'),
    );
    bay2Plaque.position.set(19.2, 3.55, 3.8);
    bay2Plaque.rotation.y = Math.PI;
    this.root.add(bay2Plaque);

    // === BALLISTIC STEEL & RUBBER BACKSTOP BULLET TRAP (Z = 35.4) ===
    const trapMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.85, metalness: 0.35 }),
    );
    // Angled AR500 deflection baffle sloping down into rubber mulch berm
    const angledTrap = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(17.6, 3.4, 0.2)),
      trapMat,
    );
    angledTrap.position.set(15.5, 2.3, 35.1);
    angledTrap.rotation.x = 0.42;
    angledTrap.userData.surfaceMaterial = 'metal';
    angledTrap.userData.ballisticMaterial = 'steel';
    this.root.add(angledTrap);
    raycastMeshes.push(angledTrap);

    // Lower rubber mulch trough
    this.addSolidProp(15.5, 0.52, 35.2, 17.6, 1.04, 1.35, this.materials.rubberMat, 'concrete', raycastMeshes, true);

    // === RANGE MASTER CONTROL CONSOLE (X = 8.45, Z = 2.85, mounted on Stall 1 bench/pedestal) ===
    const consoleGroup = new THREE.Group();
    consoleGroup.position.set(8.45, 0.9, 2.98);
    this.root.add(consoleGroup);

    const consoleChassis = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.68, 0.32, 0.38)),
      this.materials.darkSteel,
    );
    consoleChassis.position.set(0, 0.16, 0);
    consoleChassis.castShadow = !this.isSoftwareGl;
    consoleGroup.add(consoleChassis);

    const consoleBezel = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.62, 0.24, 0.04)),
      this.materials.brushedSteel,
    );
    consoleBezel.position.set(0, 0.22, -0.16);
    consoleBezel.rotation.x = -0.45;
    consoleGroup.add(consoleBezel);

    // Physical glowing amber Start button + red Reset button on console face
    const startBtnMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 1.5,
        roughness: 0.3,
      }),
    );
    const startBtn = new THREE.Mesh(
      this.trackGeo(new THREE.CylinderGeometry(0.036, 0.04, 0.032, 12)),
      startBtnMat,
    );
    startBtn.rotation.x = Math.PI * 0.5 - 0.45;
    startBtn.position.set(-0.14, 0.2, -0.18);
    consoleGroup.add(startBtn);

    const resetBtnMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xdc2626,
        emissive: 0x991b1b,
        emissiveIntensity: 1.1,
        roughness: 0.35,
      }),
    );
    const resetBtn = new THREE.Mesh(
      this.trackGeo(new THREE.CylinderGeometry(0.028, 0.032, 0.028, 12)),
      resetBtnMat,
    );
    resetBtn.rotation.x = Math.PI * 0.5 - 0.45;
    resetBtn.position.set(0.14, 0.2, -0.18);
    consoleGroup.add(resetBtn);

    const consoleProxy = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.95, 0.65, 0.72)), proxyMat);
    consoleProxy.position.set(8.45, 1.12, 2.98);
    consoleProxy.userData.hideoutInteractable = {
      kind: 'range_console',
      maxDistanceM: 2.9,
    } satisfies HideoutInteractableMeta;
    this.root.add(consoleProxy);
    interactableMeshes.push(consoleProxy);
    this.consoleWorldPos.set(8.45, 1.12, 2.85);

    this.electronics.registerNode(
      {
        id: 'range_console',
        label: 'Range Control Console',
        hitMeshes: [consoleChassis, consoleBezel, startBtn, resetBtn],
        emissiveMaterials: [startBtnMat, resetBtnMat],
        sparkOrigin: new THREE.Vector3(8.45, 1.14, 2.86),
        onBreak: () => {
          this.consoleBroken = true;
          if (this.isCourseRunning()) {
            this.abortCourse();
          }
        },
      },
      raycastMeshes,
    );

    // === FIRING-LINE AMMO RESUPPLY BOX (X = 7.42, Z = 2.95 on Stall 1 bench) ===
    const ammoBox = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.42, 0.24, 0.24)),
      this.materials.ammoCrateBody,
    );
    ammoBox.position.set(7.48, 1.02, 3.05);
    ammoBox.rotation.y = 0.22;
    ammoBox.castShadow = !this.isSoftwareGl;
    this.root.add(ammoBox);

    const ammoProxy = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.58, 0.42, 0.46)), proxyMat);
    ammoProxy.position.set(7.48, 1.06, 3.05);
    ammoProxy.userData.hideoutInteractable = {
      kind: 'range_ammo_box',
      maxDistanceM: 2.8,
    } satisfies HideoutInteractableMeta;
    this.root.add(ammoProxy);
    interactableMeshes.push(ammoProxy);
    this.rangeAmmoWorldPos.set(7.48, 1.04, 3.05);

    // === PHYSICAL "SHOOT TO START" STEEL PADDLE (X = 15.65, Z = 6.8, facing -Z) ===
    const paddleStand = new THREE.Group();
    paddleStand.position.set(15.65, 0, 6.85);
    this.root.add(paddleStand);

    const standPost = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.08, 1.18, 0.08)),
      this.materials.darkSteel,
    );
    standPost.position.set(0, 0.59, 0);
    paddleStand.add(standPost);

    const standFoot = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.46, 0.06, 0.46)),
      this.materials.darkSteel,
    );
    standFoot.position.set(0, 0.03, 0);
    paddleStand.add(standFoot);

    this.startPaddlePivot = new THREE.Group();
    this.startPaddlePivot.position.set(0, 1.18, 0);
    paddleStand.add(this.startPaddlePivot);

    const [pC, pCtx] = makeCanvas(256, 256);
    pCtx.fillStyle = '#d97706';
    pCtx.fillRect(0, 0, 256, 256);
    pCtx.strokeStyle = '#14171a';
    pCtx.lineWidth = 14;
    pCtx.strokeRect(10, 10, 236, 236);
    pCtx.fillStyle = '#0e1012';
    pCtx.font = '700 44px "Oswald", sans-serif';
    pCtx.textAlign = 'center';
    pCtx.fillText('SHOOT', 128, 102);
    pCtx.fillText('TO START', 128, 154);
    pCtx.font = '700 24px "IBM Plex Mono", monospace';
    pCtx.fillText('30S CQB', 128, 206);
    const paddleTex = this.trackTex(new THREE.CanvasTexture(pC));
    paddleTex.colorSpace = THREE.SRGBColorSpace;
    paddleTex.anisotropy = this.maxAniso;

    this.startPaddleMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: paddleTex,
        roughness: 0.42,
        metalness: 0.65,
        emissive: 0x3a1c02,
        emissiveIntensity: 0.45,
      }),
    );

    const paddleMesh = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(0.38, 0.38, 0.035)),
      this.startPaddleMat,
    );
    paddleMesh.position.set(0, 0.2, 0);
    paddleMesh.castShadow = !this.isSoftwareGl;
    paddleMesh.userData.surfaceMaterial = 'metal';
    paddleMesh.userData.ballisticMaterial = 'steel';
    paddleMesh.userData.hideoutRangeTarget = {
      id: 'course_start_paddle',
      kind: 'course_start_paddle',
      zone: 'paddle',
    } satisfies RangeTargetMeshTag;
    this.startPaddlePivot.add(paddleMesh);
    raycastMeshes.push(paddleMesh);
  }

  private buildOverheadScoreboard(raycastMeshes: THREE.Object3D[]): void {
    const [c, ctx] = makeCanvas(1024, 256);
    this.scoreboardCanvas = c;
    this.scoreboardCtx = ctx;
    this.scoreboardTex = this.trackTex(new THREE.CanvasTexture(c));
    this.scoreboardTex.colorSpace = THREE.SRGBColorSpace;
    this.scoreboardTex.anisotropy = this.maxAniso;

    const boardGroup = new THREE.Group();
    boardGroup.position.set(19.2, 3.68, 8.4);
    boardGroup.userData.isRoof = true;
    this.root.add(boardGroup);

    // Suspended industrial steel casing + twin ceiling hanger rods
    const casing = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(4.2, 1.08, 0.18)),
      this.materials.darkSteel,
    );
    boardGroup.add(casing);

    for (const sx of [-1.7, 1.7]) {
      const rod = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.88, 8)),
        this.materials.brushedSteel,
      );
      rod.position.set(sx, 0.86, 0);
      boardGroup.add(rod);
    }

    const screenMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        map: this.scoreboardTex,
      }),
    );
    const screen = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(3.96, 0.9)), screenMat);
    screen.position.set(0, 0, -0.095);
    screen.rotation.y = Math.PI; // Faces -Z toward firing line
    boardGroup.add(screen);

    this.electronics.registerNode(
      {
        id: 'range_scoreboard',
        label: 'Overhead Range Scoreboard',
        hitMeshes: [casing, screen],
        sparkOrigin: new THREE.Vector3(19.2, 3.64, 8.28),
        isLightFixture: true,
        onBreak: () => {
          this.scoreboardBroken = true;
          this.drawBrokenScoreboard();
        },
      },
      raycastMeshes,
    );
  }

  private drawBrokenScoreboard(): void {
    const ctx = this.scoreboardCtx;
    const W = this.scoreboardCanvas.width;
    const H = this.scoreboardCanvas.height;
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, W, H);
    // Fractured glass spiderweb cracks
    ctx.strokeStyle = 'rgba(180, 195, 210, 0.34)';
    ctx.lineWidth = 2;
    const cx = W * 0.52;
    const cy = H * 0.48;
    for (let i = 0; i < 11; i++) {
      const ang = (i / 11) * Math.PI * 2 + 0.23;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * 420, cy + Math.sin(ang) * 160);
      ctx.stroke();
    }
    ctx.fillStyle = '#262b33';
    ctx.font = 'bold 28px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO SIGNAL · DISPLAY DAMAGED', W * 0.5, H * 0.5);
    this.scoreboardTex.needsUpdate = true;
  }

  private redrawScoreboard(force = false): void {
    if (this.scoreboardBroken) return;
    const acc = this.computeAccuracyPct();
    const key = `${this.phase}|${Math.ceil(this.countdownSec)}|${this.timeRemainingSec.toFixed(1)}|${this.score}|${this.hits}|${this.headshots}|${acc}|${this.bestScore}`;
    if (!force && key === this.lastBoardRenderKey) return;
    this.lastBoardRenderKey = key;

    const ctx = this.scoreboardCtx;
    const W = this.scoreboardCanvas.width;
    const H = this.scoreboardCanvas.height;

    ctx.fillStyle = '#0a0c0f';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#272c33';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, W - 8, H - 8);

    // Subtle LED scanline grid
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    for (let y = 12; y < H; y += 8) {
      ctx.fillRect(8, y, W - 16, 2);
    }

    // Header bar
    const modeLabel =
      this.phase === 'countdown'
        ? `STANDBY · STARTING IN ${Math.max(1, Math.ceil(this.countdownSec))}`
        : this.phase === 'active'
          ? 'CQB POP-UP COURSE · LIVE'
          : this.phase === 'finished'
            ? this.isNewBest
              ? 'COURSE COMPLETE · NEW RECORD'
              : 'COURSE COMPLETE'
            : 'BAY 2 CQB COURSE · READY';

    ctx.fillStyle = this.phase === 'active' ? '#ef4444' : '#f59e0b';
    ctx.font = '700 28px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(modeLabel, 28, 46);

    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'right';
    ctx.fillText(`BEST ${String(this.bestScore).padStart(4, '0')}`, W - 28, 46);

    // Divider hairline
    ctx.fillStyle = '#1f242b';
    ctx.fillRect(24, 64, W - 48, 3);

    // Large segmented LED metrics
    const timeText =
      this.phase === 'countdown'
        ? `0${Math.max(1, Math.ceil(this.countdownSec))}.0`
        : this.timeRemainingSec.toFixed(1).padStart(4, '0');

    const drawCol = (x: number, title: string, value: string, color: string) => {
      ctx.fillStyle = '#6b7280';
      ctx.font = '600 22px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(title, x, 108);
      ctx.fillStyle = color;
      ctx.font = '700 76px "IBM Plex Mono", monospace';
      ctx.fillText(value, x, 196);
    };

    drawCol(28, 'TIME', `${timeText}s`, this.phase === 'active' && this.timeRemainingSec <= 5 ? '#ef4444' : '#f8fafc');
    drawCol(328, 'SCORE', String(this.score).padStart(4, '0'), '#f59e0b');
    drawCol(604, 'HITS / HS', `${this.hits}/${this.headshots}`, '#e5e7eb');
    drawCol(842, 'ACC', `${acc}%`, '#93c5fd');

    this.scoreboardTex.needsUpdate = true;
  }

  private buildBay1ReactiveTargets(raycastMeshes: THREE.Object3D[]): void {
    const ipscTex = this.trackTex(buildIpscTargetTexture(this.maxAniso));
    const ipscMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: ipscTex,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );

    // 1) Scored IPSC Paper Silhouette Targets on wood-and-steel stanchions (10m, 16m, 24m)
    const paperSpecs: Array<{ id: string; label: string; x: number; z: number; distM: number }> = [
      { id: 'bay1_ipsc_10m', label: 'IPSC Silhouette', x: 8.6, z: 13.2, distM: 10 },
      { id: 'bay1_ipsc_16m', label: 'IPSC Silhouette', x: 10.6, z: 19.2, distM: 16 },
      { id: 'bay1_ipsc_24m', label: 'IPSC Silhouette', x: 12.6, z: 27.2, distM: 24 },
    ];

    for (const s of paperSpecs) {
      const stand = new THREE.Group();
      stand.position.set(s.x, 0, s.z);
      this.root.add(stand);

      // Steel base H-frame + twin vertical timber furring strips
      const baseBar = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.62, 0.05, 0.56)),
        this.materials.darkSteel,
      );
      baseBar.position.set(0, 0.025, 0);
      stand.add(baseBar);

      for (const sx of [-0.22, 0.22]) {
        const post = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.04, 1.62, 0.04)),
          this.materials.tableWood,
        );
        post.position.set(sx, 0.82, 0);
        post.castShadow = !this.isSoftwareGl;
        stand.add(post);
      }

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.86, 0);
      stand.add(pivot);

      // Torso board (D/C/A zones resolved by local hit coordinates!)
      const board = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.56, 0.88, 0.024)),
        ipscMat,
      );
      board.position.set(0, 0.44, 0);
      board.castShadow = !this.isSoftwareGl;
      board.receiveShadow = true;
      board.userData.surfaceMaterial = 'wood';
      board.userData.ballisticMaterial = 'wood';
      board.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'paper_silhouette',
        zone: 'torso',
      } satisfies RangeTargetMeshTag;
      pivot.add(board);
      raycastMeshes.push(board);

      const rt: FreeReactiveTarget = {
        id: s.id,
        label: s.label,
        kind: 'paper_silhouette',
        distanceM: s.distM,
        pivot,
        plateMat: ipscMat,
        baseEmissiveHex: 0x000000,
        angleRad: 0,
        angVel: 0,
        knockedDown: false,
        resetTimerSec: 0,
        flashTimerSec: 0,
        hitMeshes: [board],
        worldPos: new THREE.Vector3(s.x, 1.32, s.z),
      };
      this.freeTargets.push(rt);
      this.freeById.set(rt.id, rt);
    }

    // 2) Auto-Resetting AR500 Steel Knockdown Poppers (12m, 20m, 28m)
    const popperSpecs: Array<{ id: string; label: string; x: number; z: number; distM: number }> = [
      { id: 'bay1_popper_12m', label: 'AR500 Popper', x: 12.2, z: 15.2, distM: 12 },
      { id: 'bay1_popper_20m', label: 'AR500 Popper', x: 8.8, z: 23.2, distM: 20 },
      { id: 'bay1_popper_28m', label: 'AR500 Popper', x: 10.8, z: 31.2, distM: 28 },
    ];

    for (const s of popperSpecs) {
      const stand = new THREE.Group();
      stand.position.set(s.x, 0, s.z);
      this.root.add(stand);

      const base = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.56, 0.07, 0.62)),
        this.materials.darkSteel,
      );
      base.position.set(0, 0.035, 0);
      stand.add(base);

      // Spring-loaded hinge bracket
      const hingeBar = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.025, 0.025, 0.36, 8)),
        this.materials.brushedSteel,
      );
      hingeBar.rotation.z = Math.PI * 0.5;
      hingeBar.position.set(0, 0.09, 0);
      stand.add(hingeBar);

      const pivot = new THREE.Group();
      pivot.position.set(0, 0.09, 0);
      stand.add(pivot);

      const plateMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xcbd5e1,
          roughness: 0.34,
          metalness: 0.86,
          emissive: 0x000000,
          emissiveIntensity: 0,
        }),
      );

      // Tapered steel torso + distinct circular head plate
      const stem = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.24, 0.96, 0.028)),
        plateMat,
      );
      stem.position.set(0, 0.54, 0);
      stem.castShadow = !this.isSoftwareGl;
      stem.userData.surfaceMaterial = 'metal';
      stem.userData.ballisticMaterial = 'steel';
      stem.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'steel_popper',
        zone: 'a_zone',
      } satisfies RangeTargetMeshTag;
      pivot.add(stem);
      raycastMeshes.push(stem);

      const headDisk = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 18)),
        plateMat,
      );
      headDisk.rotation.x = Math.PI * 0.5;
      headDisk.position.set(0, 1.15, 0);
      headDisk.castShadow = !this.isSoftwareGl;
      headDisk.userData.surfaceMaterial = 'metal';
      headDisk.userData.ballisticMaterial = 'steel';
      headDisk.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'steel_popper',
        zone: 'head',
      } satisfies RangeTargetMeshTag;
      pivot.add(headDisk);
      raycastMeshes.push(headDisk);

      // High-contrast orange bullseye paint dot on head
      const bullDot = new THREE.Mesh(
        this.trackGeo(new THREE.CircleGeometry(0.065, 16)),
        this.materials.warmLampEmissive,
      );
      bullDot.position.set(0, 1.15, -0.017);
      bullDot.rotation.y = Math.PI;
      pivot.add(bullDot);

      const rt: FreeReactiveTarget = {
        id: s.id,
        label: s.label,
        kind: 'steel_popper',
        distanceM: s.distM,
        pivot,
        plateMat,
        baseEmissiveHex: 0x000000,
        angleRad: 0,
        angVel: 0,
        knockedDown: false,
        resetTimerSec: 0,
        flashTimerSec: 0,
        hitMeshes: [stem, headDisk],
        worldPos: new THREE.Vector3(s.x, 0.88, s.z),
      };
      this.freeTargets.push(rt);
      this.freeById.set(rt.id, rt);
    }

    // 3) Suspended Swinging AR500 Steel Gongs (14m, 22m, 30m)
    const gongSpecs: Array<{ id: string; label: string; x: number; z: number; distM: number; radius: number }> = [
      { id: 'bay1_gong_14m', label: 'Steel Gong 8"', x: 10.5, z: 17.2, distM: 14, radius: 0.16 },
      { id: 'bay1_gong_22m', label: 'Steel Gong 10"', x: 12.4, z: 25.2, distM: 22, radius: 0.2 },
      { id: 'bay1_gong_30m', label: 'Steel Gong 12"', x: 8.9, z: 33.0, distM: 30, radius: 0.24 },
    ];

    for (const g of gongSpecs) {
      const frame = new THREE.Group();
      frame.position.set(g.x, 0, g.z);
      this.root.add(frame);

      // Steel A-frame rack (two angled legs + crossbar)
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(
          this.trackGeo(new THREE.CylinderGeometry(0.022, 0.022, 1.72, 8)),
          this.materials.darkSteel,
        );
        leg.position.set(sx * 0.48, 0.84, 0);
        leg.rotation.z = sx * 0.14;
        frame.add(leg);
      }
      const crossbar = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.88, 8)),
        this.materials.darkSteel,
      );
      crossbar.rotation.z = Math.PI * 0.5;
      crossbar.position.set(0, 1.66, 0);
      frame.add(crossbar);

      const pivot = new THREE.Group();
      pivot.position.set(0, 1.66, 0);
      frame.add(pivot);

      // Twin hanging straps
      for (const sx of [-0.08, 0.08]) {
        const strap = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.02, 0.44, 0.014)),
          this.materials.brushedSteel,
        );
        strap.position.set(sx, -0.22, 0);
        pivot.add(strap);
      }

      const gongMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xf59e0b,
          roughness: 0.38,
          metalness: 0.78,
          emissive: 0x000000,
          emissiveIntensity: 0,
        }),
      );
      const disk = new THREE.Mesh(
        this.trackGeo(new THREE.CylinderGeometry(g.radius, g.radius, 0.028, 22)),
        gongMat,
      );
      disk.rotation.x = Math.PI * 0.5;
      disk.position.set(0, -0.46 - g.radius * 0.35, 0);
      disk.castShadow = !this.isSoftwareGl;
      disk.userData.surfaceMaterial = 'metal';
      disk.userData.ballisticMaterial = 'steel';
      disk.userData.hideoutRangeTarget = {
        id: g.id,
        kind: 'steel_gong',
        zone: 'gong',
      } satisfies RangeTargetMeshTag;
      pivot.add(disk);
      raycastMeshes.push(disk);

      const rt: FreeReactiveTarget = {
        id: g.id,
        label: g.label,
        kind: 'steel_gong',
        distanceM: g.distM,
        pivot,
        plateMat: gongMat,
        baseEmissiveHex: 0x000000,
        angleRad: 0,
        angVel: 0,
        knockedDown: false,
        resetTimerSec: 0,
        flashTimerSec: 0,
        hitMeshes: [disk],
        worldPos: new THREE.Vector3(g.x, 1.15, g.z),
      };
      this.freeTargets.push(rt);
      this.freeById.set(rt.id, rt);
    }
  }

  private buildBay2CqbCourse(raycastMeshes: THREE.Object3D[]): void {
    // === TACTICAL SHOOT-HOUSE COVER BARRICADES (X ∈ [15.0, 23.8], Z ∈ [9.0, 29.0]) ===
    // Low plywood/steel half-walls & flanking cover panels giving clear sightlines from firing line AND peek angles
    const barricades: Array<[number, number, number, number, number, number, BodycamSurfaceMaterial]> = [
      // [cx, cy, cz, w, h, d, surface]
      [16.8, 0.52, 10.6, 2.2, 1.04, 0.18, 'wood'], // Front-left low cover
      [21.6, 0.52, 12.2, 2.4, 1.04, 0.18, 'wood'], // Front-right low cover
      [18.8, 0.96, 15.8, 1.75, 1.92, 0.22, 'concrete'], // Center tall pillar barrier (lean-peek flanks!)
      [16.3, 0.54, 19.6, 2.1, 1.08, 0.18, 'wood'], // Mid-left cover
      [22.0, 0.88, 20.8, 2.1, 1.76, 0.18, 'wood'], // Mid-right barricade
      [19.2, 0.52, 24.4, 2.8, 1.04, 0.2, 'concrete'], // Rear center chest-high wall
    ];
    for (let idx = 0; idx < barricades.length; idx++) {
      const [cx, cy, cz, w, h, d, surf] = barricades[idx];
      const mat = surf === 'wood' ? this.materials.tableWood : this.materials.concreteWall;
      const barricadeMesh = this.addSolidProp(cx, cy, cz, w, h, d, mat, surf, raycastMeshes, true);
      if (surf === 'wood' && this.penetrableSystem) {
        this.penetrableSystem.registerSurface({
          id: `hideout_range_barricade_${idx}`,
          mesh: barricadeMesh,
          kind: 'range_panel',
          width: w,
          height: h,
          thickness: d,
          faceAxis: 'z',
          floorY: 0,
          maxHoles: 5,
          hitsToBreach: 1,
        });
      }
      // Steel edge trim
      const cap = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(w + 0.04, 0.05, d + 0.04)),
        this.materials.darkSteel,
      );
      cap.position.set(cx, cy + h * 0.5 + 0.025, cz);
      this.root.add(cap);
    }

    // === 10 MOTORIZED PNEUMATIC POP-UP TARGET STATIONS ===
    const hostileTex = this.trackTex(buildHostilePopupTexture(this.maxAniso));
    const noShootTex = this.trackTex(buildNoShootTexture(this.maxAniso));
    const hostileMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: hostileTex,
        roughness: 0.46,
        metalness: 0.58,
      }),
    );
    const noShootMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        map: noShootTex,
        roughness: 0.52,
        metalness: 0.22,
      }),
    );

    const stationLayout: Array<{ id: string; label: string; x: number; z: number; baseY: number }> = [
      { id: 'cqb_pop_01', label: 'CQB Close Left', x: 16.5, z: 11.4, baseY: 0 },
      { id: 'cqb_pop_02', label: 'CQB Close Center', x: 19.3, z: 9.8, baseY: 0 },
      { id: 'cqb_pop_03', label: 'CQB Close Right', x: 21.8, z: 13.0, baseY: 0 },
      { id: 'cqb_pop_04', label: 'CQB Pillar Left', x: 17.2, z: 16.2, baseY: 0 },
      { id: 'cqb_pop_05', label: 'CQB Pillar Right', x: 20.5, z: 16.4, baseY: 0 },
      { id: 'cqb_pop_06', label: 'CQB Mid Left', x: 16.2, z: 20.4, baseY: 0 },
      { id: 'cqb_pop_07', label: 'CQB Mid Center', x: 19.2, z: 20.0, baseY: 0 },
      { id: 'cqb_pop_08', label: 'CQB Mid Right', x: 22.8, z: 18.6, baseY: 0 },
      { id: 'cqb_pop_09', label: 'CQB Rear Left', x: 17.5, z: 25.4, baseY: 0 },
      { id: 'cqb_pop_10', label: 'CQB Rear Right', x: 21.2, z: 26.2, baseY: 0 },
    ];

    for (const s of stationLayout) {
      const distM = Math.round(Math.max(5, s.z - 3.2));
      const baseGroup = new THREE.Group();
      baseGroup.position.set(s.x, s.baseY, s.z);
      this.root.add(baseGroup);

      // Pneumatic steel actuator housing on floor
      const housing = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.58, 0.14, 0.44)),
        this.materials.darkSteel,
      );
      housing.position.set(0, 0.07, 0);
      housing.castShadow = !this.isSoftwareGl;
      baseGroup.add(housing);

      // Status LED on front of actuator housing
      const statusLedMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x374151,
          emissive: 0x111827,
          emissiveIntensity: 0.4,
          roughness: 0.3,
        }),
      );
      const led = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.18, 0.036, 0.025)),
        statusLedMat,
      );
      led.position.set(0, 0.09, -0.225);
      baseGroup.add(led);

      // Motorized hinge pivot (rotates around X: 0 = upright facing -Z, -PI*0.48 = folded flat backward)
      const pivot = new THREE.Group();
      pivot.position.set(0, 0.14, 0);
      pivot.rotation.x = POPUP_FOLDED_RAD;
      baseGroup.add(pivot);

      // Rising steel riser neck
      const riser = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.08, 0.68, 0.04)),
        this.materials.brushedSteel,
      );
      riser.position.set(0, 0.34, 0);
      pivot.add(riser);

      // --- HOSTILE TARGET PLATE (Torso + Distinct Head Box for crisp headshot detection) ---
      const hostileFaceGroup = new THREE.Group();
      pivot.add(hostileFaceGroup);

      const torsoMesh = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.54, 0.72, 0.032)),
        hostileMat,
      );
      torsoMesh.position.set(0, 1.02, 0);
      torsoMesh.castShadow = !this.isSoftwareGl;
      torsoMesh.userData.surfaceMaterial = 'metal';
      torsoMesh.userData.ballisticMaterial = 'steel';
      torsoMesh.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'cqb_popup',
        zone: 'a_zone',
      } satisfies RangeTargetMeshTag;
      hostileFaceGroup.add(torsoMesh);
      raycastMeshes.push(torsoMesh);

      const headMesh = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.22, 0.25, 0.034)),
        hostileMat,
      );
      headMesh.position.set(0, 1.505, 0);
      headMesh.castShadow = !this.isSoftwareGl;
      headMesh.userData.surfaceMaterial = 'metal';
      headMesh.userData.ballisticMaterial = 'steel';
      headMesh.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'cqb_popup',
        zone: 'head',
      } satisfies RangeTargetMeshTag;
      hostileFaceGroup.add(headMesh);
      raycastMeshes.push(headMesh);

      // --- NO-SHOOT / NON-COMBATANT TARGET PLATE (toggled cleanly when station spawns as No-Shoot) ---
      const noShootFaceGroup = new THREE.Group();
      noShootFaceGroup.visible = false;
      pivot.add(noShootFaceGroup);

      const nsMesh = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.54, 0.94, 0.032)),
        noShootMat,
      );
      nsMesh.position.set(0, 1.13, 0);
      nsMesh.castShadow = !this.isSoftwareGl;
      nsMesh.userData.surfaceMaterial = 'wood';
      nsMesh.userData.ballisticMaterial = 'wood';
      nsMesh.userData.hideoutRangeTarget = {
        id: s.id,
        kind: 'cqb_popup',
        zone: 'torso',
      } satisfies RangeTargetMeshTag;
      noShootFaceGroup.add(nsMesh);
      raycastMeshes.push(nsMesh);

      const station: CqbPopupStation = {
        id: s.id,
        label: s.label,
        distanceM: distM,
        pivot,
        hostileFaceGroup,
        noShootFaceGroup,
        statusLedMat,
        worldPos: new THREE.Vector3(s.x, s.baseY + 1.15, s.z),
        isNoShoot: false,
        raised: false,
        angleRad: POPUP_FOLDED_RAD,
        angVel: 0,
        stayTimerSec: 0,
        cooldownSec: 0,
        flashTimerSec: 0,
        hitMeshes: [torsoMesh, headMesh, nsMesh],
      };
      this.cqbStations.push(station);
      this.cqbById.set(station.id, station);
    }

    // Leave 3 idle hostile targets raised in Free Fire mode so Bay 2 looks alive even before starting the 30s drill
    this.raiseIdlePreviewPopups();
  }

  private raiseIdlePreviewPopups(): void {
    for (let i = 0; i < this.cqbStations.length; i++) {
      const st = this.cqbStations[i];
      const previewUp = i === 1 || i === 4 || i === 8;
      st.isNoShoot = false;
      st.hostileFaceGroup.visible = true;
      st.noShootFaceGroup.visible = false;
      st.raised = previewUp;
      st.stayTimerSec = 0;
      st.cooldownSec = 0;
      st.statusLedMat.color.setHex(previewUp ? 0xf59e0b : 0x374151);
      st.statusLedMat.emissive.setHex(previewUp ? 0xb45309 : 0x111827);
    }
  }

  public startCourse(): void {
    this.phase = 'countdown';
    this.countdownSec = COUNTDOWN_DURATION_SEC;
    this.lastCountdownBeepInt = 4;
    this.timeRemainingSec = COURSE_DURATION_SEC;
    this.score = 0;
    this.hits = 0;
    this.headshots = 0;
    this.noShootPenalties = 0;
    this.shotsFiredInCourse = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.isNewBest = false;
    this.lastHit = null;
    this.lastSpawnedStationIdx = -1;
    this.noShootSpawnCounter = 0;

    // Fold all CQB pop-up stations flat before the start beep
    for (const st of this.cqbStations) {
      st.raised = false;
      st.isNoShoot = false;
      st.hostileFaceGroup.visible = true;
      st.noShootFaceGroup.visible = false;
      st.stayTimerSec = 0;
      st.cooldownSec = 0;
      st.statusLedMat.color.setHex(0x374151);
      st.statusLedMat.emissive.setHex(0x111827);
    }
    this.redrawScoreboard(true);
  }

  public abortCourse(): void {
    if (this.phase === 'idle') return;
    this.phase = 'idle';
    this.countdownSec = 0;
    this.timeRemainingSec = COURSE_DURATION_SEC;
    this.raiseIdlePreviewPopups();
    this.redrawScoreboard(true);
  }

  public resetFreeTargets(): void {
    for (const t of this.freeTargets) {
      t.knockedDown = false;
      t.resetTimerSec = 0;
      t.angVel = 0;
      t.flashTimerSec = 0;
      t.plateMat.emissive.setHex(t.baseEmissiveHex);
      t.plateMat.emissiveIntensity = 0;
    }
    if (this.phase === 'idle' || this.phase === 'finished') {
      this.raiseIdlePreviewPopups();
    }
    this.rangeAudio.playPopupPneumatic();
  }

  private spawnNextPopup(asNoShoot = false): void {
    const candidates: number[] = [];
    for (let i = 0; i < this.cqbStations.length; i++) {
      const st = this.cqbStations[i];
      if (!st.raised && st.cooldownSec <= 0 && i !== this.lastSpawnedStationIdx) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) return;

    const pickIdx = candidates[Math.floor(Math.random() * candidates.length)];
    const st = this.cqbStations[pickIdx];
    this.lastSpawnedStationIdx = pickIdx;

    st.isNoShoot = asNoShoot;
    st.hostileFaceGroup.visible = !asNoShoot;
    st.noShootFaceGroup.visible = asNoShoot;
    st.raised = true;
    st.angVel = 0;
    st.stayTimerSec = asNoShoot ? 3.2 : 4.25;
    st.statusLedMat.color.setHex(asNoShoot ? 0x3b82f6 : 0xef4444);
    st.statusLedMat.emissive.setHex(asNoShoot ? 0x1d4ed8 : 0xb91c1c);
    this.rangeAudio.playPopupPneumatic();
  }

  private countActivePopups(): { hostiles: number; noShoots: number } {
    let hostiles = 0;
    let noShoots = 0;
    for (const st of this.cqbStations) {
      if (!st.raised) continue;
      if (st.isNoShoot) noShoots++;
      else hostiles++;
    }
    return { hostiles, noShoots };
  }

  private finishCourse(): void {
    this.phase = 'finished';
    this.timeRemainingSec = 0;
    this.rangeAudio.playEndBuzzer();

    const accuracyPct = this.computeAccuracyPct();
    this.isNewBest = this.score > this.bestScore && this.score > 0;
    if (this.isNewBest) {
      this.bestScore = this.score;
    }

    this.raiseIdlePreviewPopups();
    this.redrawScoreboard(true);

    this.callbacks.onCourseComplete?.({
      score: this.score,
      hits: this.hits,
      headshots: this.headshots,
      accuracyPct,
      isNewBest: this.isNewBest,
    });
  }

  private computeAccuracyPct(): number {
    if (this.shotsFiredInCourse <= 0) return 0;
    return Math.min(100, Math.round((this.hits / this.shotsFiredInCourse) * 100));
  }

  /**
   * Processes a live bullet or melee impact against any Gun Range target mesh.
   * Returns rich scoring/zone feedback if a range target was struck, or null otherwise.
   */
  public handleBallisticImpact(
    ev: Readonly<BallisticImpactEvent>,
    shooterPos?: Readonly<THREE.Vector3>,
  ): RangeHitFeedback | null {
    const obj = ev.object as THREE.Mesh | null;
    if (!obj) return null;
    const tag = obj.userData.hideoutRangeTarget as RangeTargetMeshTag | undefined;
    if (!tag) return null;

    const distM = shooterPos
      ? Math.max(1, Math.round(shooterPos.distanceTo(ev.point)))
      : Math.max(1, Math.round(ev.distanceM));

    // === 1. SHOOT-TO-START PADDLE ===
    if (tag.kind === 'course_start_paddle') {
      const paddleImp = computeTargetHingeAngularImpulse({
        pivot: this.startPaddlePivot,
        hitPointWorld: ev.point,
        incomingDir: ev.incomingDir,
        impactSpeedMs: ev.impactSpeedMs,
        bulletMassGrams: ev.ammo.bulletMassGrams,
        pellets: ev.ammo.pellets,
        outcome: ev.outcome,
        outgoingDir: ev.outgoingDir,
        effectiveInertia: 0.075,
        minDeltaRadSec: 6.0,
        maxDeltaRadSec: 15.0,
      });
      this.startPaddleAngVel += paddleImp;
      this.rangeAudio.playSteelRing(true);
      if (this.isCourseRunning()) {
        this.abortCourse();
      } else {
        this.startCourse();
      }
      const fb: RangeHitFeedback = {
        targetId: tag.id,
        label: this.isCourseRunning() ? 'CQB Course Started' : 'CQB Course Aborted',
        zone: 'paddle',
        scoreDelta: 0,
        distanceM: distM,
        isSteel: true,
        isNoShoot: false,
        timestampMs: performance.now(),
      };
      this.lastHit = fb;
      return fb;
    }

    // === 2. BAY 1 FREE-FIRE REACTIVE TARGETS (STEEL POPPERS, GONGS, SCORED IPSC PAPER) ===
    const free = this.freeById.get(tag.id);
    if (free) {
      let zone: RangeHitZone = tag.zone === 'head' ? 'head' : tag.zone === 'gong' ? 'gong' : 'a_zone';
      let pts = 100;

      if (free.kind === 'paper_silhouette') {
        // Resolve exact IPSC scoring zone in local board space (board 0.56m wide × 0.88m tall, centered at y=0.44)
        this._tmpLocalHit.copy(ev.point);
        obj.worldToLocal(this._tmpLocalHit);
        const lx = Math.abs(this._tmpLocalHit.x);
        const ly = this._tmpLocalHit.y; // -0.44 (bottom) .. +0.44 (top)
        if (ly >= 0.21 && lx <= 0.11) {
          zone = 'head';
          pts = 150;
        } else if (ly >= -0.14 && ly <= 0.16 && lx <= 0.1) {
          zone = 'a_zone';
          pts = 100;
        } else {
          zone = 'torso';
          pts = 60;
        }
        // True lever-arm flutter kickback away from bullet impulse
        free.angVel += computeTargetHingeAngularImpulse({
          pivot: free.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.incomingDir,
          impactSpeedMs: ev.impactSpeedMs,
          bulletMassGrams: ev.ammo.bulletMassGrams,
          pellets: ev.ammo.pellets,
          outcome: ev.outcome,
          outgoingDir: ev.outgoingDir,
          effectiveInertia: 0.38,
          impulseScale: 0.52,
          minDeltaRadSec: 1.4,
          maxDeltaRadSec: 6.5,
        });
      } else if (free.kind === 'steel_popper') {
        if (free.knockedDown) return null;
        zone = tag.zone === 'head' ? 'head' : 'a_zone';
        pts = zone === 'head' ? 150 : 100;
        free.knockedDown = true;
        free.resetTimerSec = 2.25;
        free.angVel = computeTargetHingeAngularImpulse({
          pivot: free.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.incomingDir,
          impactSpeedMs: ev.impactSpeedMs,
          bulletMassGrams: ev.ammo.bulletMassGrams,
          pellets: ev.ammo.pellets,
          outcome: ev.outcome,
          outgoingDir: ev.outgoingDir,
          effectiveInertia: 0.34,
          minDeltaRadSec: 6.2,
          maxDeltaRadSec: 14.0,
        });
        free.flashTimerSec = 0.14;
        free.plateMat.emissive.setHex(0xf59e0b);
        free.plateMat.emissiveIntensity = 1.1;
        this.rangeAudio.playSteelRing(zone === 'head');
      } else if (free.kind === 'steel_gong') {
        zone = 'gong';
        pts = 100;
        free.angVel += computeTargetHingeAngularImpulse({
          pivot: free.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.incomingDir,
          impactSpeedMs: ev.impactSpeedMs,
          bulletMassGrams: ev.ammo.bulletMassGrams,
          pellets: ev.ammo.pellets,
          outcome: ev.outcome,
          outgoingDir: ev.outgoingDir,
          effectiveInertia: 0.22,
          minDeltaRadSec: 4.5,
          maxDeltaRadSec: 14.5,
        });
        free.flashTimerSec = 0.14;
        free.plateMat.emissive.setHex(0xfef08a);
        free.plateMat.emissiveIntensity = 1.25;
        this.rangeAudio.playSteelRing(false);
      }

      const fb: RangeHitFeedback = {
        targetId: free.id,
        label: free.label,
        zone,
        scoreDelta: pts,
        distanceM: distM,
        isSteel: free.kind !== 'paper_silhouette',
        isNoShoot: false,
        timestampMs: performance.now(),
      };
      this.lastHit = fb;
      return fb;
    }

    // === 3. BAY 2 MOTORIZED CQB POP-UP STATIONS ===
    const st = this.cqbById.get(tag.id);
    if (st) {
      if (!st.raised || st.angleRad > 0.55) return null;

      if (st.isNoShoot) {
        st.raised = false;
        st.angVel = computeTargetHingeAngularImpulse({
          pivot: st.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.incomingDir,
          impactSpeedMs: ev.impactSpeedMs,
          bulletMassGrams: ev.ammo.bulletMassGrams,
          pellets: ev.ammo.pellets,
          outcome: ev.outcome,
          outgoingDir: ev.outgoingDir,
          effectiveInertia: 0.42,
          minDeltaRadSec: 5.5,
          maxDeltaRadSec: 12.0,
        });
        st.cooldownSec = 1.8;
        st.statusLedMat.color.setHex(0x374151);
        st.statusLedMat.emissive.setHex(0x111827);
        this.rangeAudio.playNoShootBuzzer();

        if (this.phase === 'active') {
          this.score = Math.max(0, this.score - 150);
          this.noShootPenalties++;
          this.streak = 0;
          this.redrawScoreboard(true);
        }

        const fb: RangeHitFeedback = {
          targetId: st.id,
          label: 'NO-SHOOT PENALTY',
          zone: 'no_shoot',
          scoreDelta: -150,
          distanceM: distM,
          isSteel: false,
          isNoShoot: true,
          timestampMs: performance.now(),
        };
        this.lastHit = fb;
        return fb;
      }

      // Hostile CQB Pop-Up hit!
      const isHead = tag.zone === 'head';
      const basePts = isHead ? 150 : 100;
      const streakBonus = this.phase === 'active' ? Math.min(50, this.streak * 10) : 0;
      const totalPts = basePts + streakBonus;

      st.raised = false;
      st.angVel = computeTargetHingeAngularImpulse({
        pivot: st.pivot,
        hitPointWorld: ev.point,
        incomingDir: ev.incomingDir,
        impactSpeedMs: ev.impactSpeedMs,
        bulletMassGrams: ev.ammo.bulletMassGrams,
        pellets: ev.ammo.pellets,
        outcome: ev.outcome,
        outgoingDir: ev.outgoingDir,
        effectiveInertia: 0.36,
        minDeltaRadSec: 6.8,
        maxDeltaRadSec: 14.0,
      });
      st.cooldownSec = this.phase === 'active' ? 1.15 : 2.1;
      st.statusLedMat.color.setHex(0x22c55e);
      st.statusLedMat.emissive.setHex(0x15803d);
      st.flashTimerSec = 0.28;
      this.rangeAudio.playSteelRing(isHead);

      if (this.phase === 'active') {
        this.score += totalPts;
        this.hits++;
        if (isHead) this.headshots++;
        this.streak++;
        if (this.streak > this.bestStreak) this.bestStreak = this.streak;

        // Immediately pop up a replacement hostile target so momentum stays razor-sharp
        this.spawnNextPopup(false);
        this.noShootSpawnCounter++;
        const activeCounts = this.countActivePopups();
        if (this.noShootSpawnCounter % 4 === 0 && activeCounts.noShoots === 0) {
          this.spawnNextPopup(true);
        }
        this.redrawScoreboard(true);
      }

      const fb: RangeHitFeedback = {
        targetId: st.id,
        label: st.label,
        zone: isHead ? 'head' : 'a_zone',
        scoreDelta: totalPts,
        distanceM: distM,
        isSteel: true,
        isNoShoot: false,
        timestampMs: performance.now(),
      };
      this.lastHit = fb;
      return fb;
    }

    return null;
  }

  public update(dt: number): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);

    // 1. Update "Shoot to Start" paddle spring recoil
    const paddleTorque = -this.startPaddleAngle * 68 - this.startPaddleAngVel * 7.5;
    this.startPaddleAngVel += paddleTorque * clampedDt;
    this.startPaddleAngle = THREE.MathUtils.clamp(
      this.startPaddleAngle + this.startPaddleAngVel * clampedDt,
      -0.85,
      0.55,
    );
    this.startPaddlePivot.rotation.x = this.startPaddleAngle;

    // 2. Update Bay 1 reactive steel poppers, swinging gongs & paper flutter
    for (let i = 0; i < this.freeTargets.length; i++) {
      const t = this.freeTargets[i];
      if (t.flashTimerSec > 0) {
        t.flashTimerSec = Math.max(0, t.flashTimerSec - clampedDt);
        const f = t.flashTimerSec / 0.14;
        t.plateMat.emissiveIntensity = f * 1.1;
        if (t.flashTimerSec <= 0) {
          t.plateMat.emissive.setHex(t.baseEmissiveHex);
        }
      }

      if (t.kind === 'steel_popper') {
        if (t.knockedDown) {
          t.resetTimerSec -= clampedDt;
          t.angleRad = THREE.MathUtils.damp(t.angleRad, POPPER_KNOCKED_RAD, 11.5, clampedDt);
          if (t.resetTimerSec <= 0) {
            t.knockedDown = false;
            t.angVel = -5.5;
            this.rangeAudio.playPopupPneumatic();
          }
        } else {
          const springAcc = -t.angleRad * 46 - t.angVel * 6.8;
          t.angVel += springAcc * clampedDt;
          t.angleRad = THREE.MathUtils.clamp(t.angleRad + t.angVel * clampedDt, -0.25, POPPER_KNOCKED_RAD);
        }
        t.pivot.rotation.x = t.angleRad;
      } else {
        // Pendulum spring-damper for gongs & paper boards
        const stiffness = t.kind === 'steel_gong' ? 32 : 55;
        const damping = t.kind === 'steel_gong' ? 3.2 : 9.0;
        const acc = -t.angleRad * stiffness - t.angVel * damping;
        t.angVel += acc * clampedDt;
        t.angleRad = THREE.MathUtils.clamp(t.angleRad + t.angVel * clampedDt, -1.05, 1.05);
        t.pivot.rotation.x = t.angleRad;
      }
    }

    // 3. Update 30-second CQB Pop-Up Course state machine
    if (this.phase === 'countdown') {
      this.countdownSec -= clampedDt;
      const ceilInt = Math.ceil(this.countdownSec);
      if (ceilInt < this.lastCountdownBeepInt && ceilInt > 0) {
        this.lastCountdownBeepInt = ceilInt;
        this.rangeAudio.playCountdownPip();
        this.redrawScoreboard(true);
      }
      if (this.countdownSec <= 0) {
        this.phase = 'active';
        this.countdownSec = 0;
        this.timeRemainingSec = COURSE_DURATION_SEC;
        this.rangeAudio.playStartBeep();
        // Pop up 3 initial staggered targets immediately on the start beep
        this.spawnNextPopup(false);
        this.spawnNextPopup(false);
        this.spawnNextPopup(false);
        this.redrawScoreboard(true);
      }
    } else if (this.phase === 'active') {
      this.timeRemainingSec = Math.max(0, this.timeRemainingSec - clampedDt);
      if (this.timeRemainingSec <= 0) {
        this.finishCourse();
      } else {
        // Keep 3 active hostile targets up during the 30s course
        const counts = this.countActivePopups();
        if (counts.hostiles < 3) {
          this.spawnNextPopup(false);
        }
        this.redrawScoreboard(false);
      }
    }

    // 4. Animate all 10 motorized pneumatic pop-up stations
    for (let i = 0; i < this.cqbStations.length; i++) {
      const st = this.cqbStations[i];
      if (st.cooldownSec > 0) {
        st.cooldownSec = Math.max(0, st.cooldownSec - clampedDt);
        // Auto-pop back up in Free Fire preview mode
        if (this.phase !== 'active' && this.phase !== 'countdown' && st.cooldownSec <= 0 && (i === 1 || i === 4 || i === 8)) {
          st.raised = true;
          st.statusLedMat.color.setHex(0xf59e0b);
          st.statusLedMat.emissive.setHex(0xb45309);
          this.rangeAudio.playPopupPneumatic();
        }
      }

      if (st.flashTimerSec > 0) {
        st.flashTimerSec = Math.max(0, st.flashTimerSec - clampedDt);
        if (st.flashTimerSec <= 0 && !st.raised) {
          st.statusLedMat.color.setHex(0x374151);
          st.statusLedMat.emissive.setHex(0x111827);
        }
      }

      if (this.phase === 'active' && st.raised) {
        st.stayTimerSec -= clampedDt;
        if (st.stayTimerSec <= 0) {
          st.raised = false;
          st.cooldownSec = 1.3;
          st.statusLedMat.color.setHex(0x374151);
          st.statusLedMat.emissive.setHex(0x111827);
          if (!st.isNoShoot) {
            this.streak = 0;
          }
        }
      }

      const targetAngle = st.raised ? 0 : POPUP_FOLDED_RAD;
      st.angleRad = THREE.MathUtils.damp(st.angleRad, targetAngle, st.raised ? 14.5 : 11.5, clampedDt);
      st.pivot.rotation.x = st.angleRad;
    }
  }

  public getState(): GunRangeSnapshot {
    const now = performance.now();
    const recentHit =
      this.lastHit && now - this.lastHit.timestampMs < 2100 ? { ...this.lastHit } : null;
    return {
      phase: this.phase,
      countdownSec: Math.max(0, this.countdownSec),
      timeRemainingSec: Math.max(0, this.timeRemainingSec),
      courseDurationSec: COURSE_DURATION_SEC,
      score: this.score,
      hits: this.hits,
      headshots: this.headshots,
      noShootPenalties: this.noShootPenalties,
      shotsFiredInCourse: this.shotsFiredInCourse,
      accuracyPct: this.computeAccuracyPct(),
      streak: this.streak,
      bestStreak: this.bestStreak,
      bestScore: this.bestScore,
      isNewBest: this.isNewBest,
      lastHit: recentHit,
    };
  }

  public dispose(): void {
    this.rangeAudio.dispose();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTex) t.dispose();
    this.ownedGeos.length = 0;
    this.ownedMats.length = 0;
    this.ownedTex.length = 0;
    this.root.parent?.remove(this.root);
  }
}

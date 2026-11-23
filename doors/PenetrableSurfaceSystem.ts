import * as THREE from 'three';
import type { BodycamMeleeAttackType } from '../bodycam-sdk/types';

export type PenetrableSurfaceKind = 'wood_door' | 'drywall' | 'plywood' | 'range_panel';

export interface PenetrableSurfaceSpec {
  id: string;
  mesh: THREE.Mesh;
  kind: PenetrableSurfaceKind;
  width: number;
  height: number;
  thickness: number;
  /** Axis perpendicular to the panel's primary face in mesh local space (default 'z') */
  faceAxis?: 'z' | 'x';
  /** Optional world floor elevation for physical debris settling */
  floorY?: number;
  /** Maximum distinct carved holes before additional hits reuse/enlarge existing holes (default 6) */
  maxHoles?: number;
  /** Optional base hole radius override in meters */
  baseRadiusM?: number;
  /** Hits required before piercing through (default 1 = immediate punch/kick hole) */
  hitsToBreach?: number;
  /** Optional texture repeat multiplier along U/V if preserving tiled texture look */
  uvRepeat?: [number, number];
}

interface CarvedHole {
  u: number;
  v: number;
  rx: number;
  ry: number;
  jitter: number[];
}

interface DebrisChunk {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  maxAge: number;
  floorY: number;
  active: boolean;
}

interface PenetrableSurfaceRuntime {
  spec: Required<PenetrableSurfaceSpec>;
  originalGeometry: THREE.BufferGeometry;
  carvedGeometry: THREE.BufferGeometry | null;
  rimGroup: THREE.Group;
  rimMeshes: THREE.Mesh[];
  rimGeos: THREE.BufferGeometry[];
  holes: CarvedHole[];
  hitCount: number;
  isBreached: boolean;
}

function createPenetrableAudioCue(kind: PenetrableSurfaceKind, isBreach: boolean, distM: number, vol = 0.85): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = getSharedPenAudioCtx(AudioCtx);
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const atten = Math.min(1, 2.5 / Math.max(2.5, distM)) * vol;
    if (atten < 0.02) return;

    const noiseDur = isBreach ? 0.22 : 0.12;
    const sampleCount = Math.floor(ctx.sampleRate * noiseDur);
    const buf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount;
      const crackSpike = kind === 'drywall' ? Math.exp(-t * 14) : Math.exp(-t * 9) * (0.7 + 0.3 * Math.sin(t * 70));
      ch[i] = (Math.random() * 2 - 1) * crackSpike;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = kind === 'drywall' ? (isBreach ? 980 : 620) : isBreach ? 1320 : 780;
    filter.Q.value = kind === 'drywall' ? 0.85 : 1.3;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.32 * atten, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.001, now + noiseDur);

    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(now);

    if (isBreach) {
      const thud = ctx.createOscillator();
      const thudGain = ctx.createGain();
      thud.type = 'triangle';
      thud.frequency.setValueAtTime(kind === 'drywall' ? 145 : 185, now);
      thud.frequency.exponentialRampToValueAtTime(48, now + 0.14);
      thudGain.gain.setValueAtTime(0.001, now);
      thudGain.gain.exponentialRampToValueAtTime(0.26 * atten, now + 0.005);
      thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      thud.connect(thudGain).connect(ctx.destination);
      thud.start(now);
      thud.stop(now + 0.16);
    }
  } catch {
    // Non-fatal audio guard
  }
}

let sharedPenAudioCtx: AudioContext | null = null;
function getSharedPenAudioCtx(Ctor: typeof AudioContext): AudioContext | null {
  if (!sharedPenAudioCtx) {
    sharedPenAudioCtx = new Ctor();
  }
  return sharedPenAudioCtx;
}

/**
 * Geometric Melee & Ballistic Penetration Hole System.
 * Replaces hit planar panels (wood doors, drywall partitions, plywood barriers, range panels)
 * in-place with an extruded jagged-hole geometry right where the fist, buttstock, or boot struck.
 * Because mesh.geometry itself contains true void geometry, Three.js raycasts, bullets,
 * sightlines, and flashlights physically pass through the carved holes.
 */
export class PenetrableSurfaceSystem {
  private readonly surfaces = new Map<string, PenetrableSurfaceRuntime>();
  private readonly surfaceList: PenetrableSurfaceRuntime[] = [];
  private readonly debrisRoot = new THREE.Group();
  private readonly debrisPool: DebrisChunk[] = [];
  private readonly isSoftwareGl: boolean;
  private listenerPos = new THREE.Vector3();

  private readonly matWoodSplinter = new THREE.MeshStandardMaterial({
    color: 0xa78252,
    roughness: 0.88,
    metalness: 0.02,
  });
  private readonly matGypsumCore = new THREE.MeshStandardMaterial({
    color: 0xd9d6cc,
    roughness: 0.94,
    metalness: 0.0,
  });
  private readonly matPlywoodEdge = new THREE.MeshStandardMaterial({
    color: 0xb89460,
    roughness: 0.86,
    metalness: 0.02,
  });
  private readonly woodChunkGeo = new THREE.BoxGeometry(0.044, 0.016, 0.11);
  private readonly drywallChunkGeo = new THREE.BoxGeometry(0.055, 0.024, 0.068);

  private readonly _localPt = new THREE.Vector3();
  private readonly _exitWorld = new THREE.Vector3();
  private readonly _normDir = new THREE.Vector3();

  constructor(sceneParent: THREE.Object3D, opts?: { isSoftwareGl?: boolean }) {
    this.isSoftwareGl = Boolean(opts?.isSoftwareGl);
    this.debrisRoot.name = 'PenetrableSurfaceDebrisPool';
    sceneParent.add(this.debrisRoot);
    this.initDebrisPool();
  }

  private initDebrisPool(): void {
    const count = this.isSoftwareGl ? 32 : 72;
    for (let i = 0; i < count; i++) {
      const isDrywall = i % 2 === 1;
      const mesh = new THREE.Mesh(
        isDrywall ? this.drywallChunkGeo : this.woodChunkGeo,
        isDrywall ? this.matGypsumCore : this.matWoodSplinter,
      );
      mesh.visible = false;
      this.debrisRoot.add(mesh);
      this.debrisPool.push({
        mesh,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        age: 0,
        maxAge: 1.5,
        floorY: 0,
        active: false,
      });
    }
  }

  public registerSurface(rawSpec: PenetrableSurfaceSpec): void {
    if (this.surfaces.has(rawSpec.id)) return;
    const spec: Required<PenetrableSurfaceSpec> = {
      id: rawSpec.id,
      mesh: rawSpec.mesh,
      kind: rawSpec.kind,
      width: Math.max(0.24, rawSpec.width),
      height: Math.max(0.24, rawSpec.height),
      thickness: Math.max(0.014, rawSpec.thickness),
      faceAxis: rawSpec.faceAxis ?? 'z',
      floorY: rawSpec.floorY ?? 0,
      maxHoles: rawSpec.maxHoles ?? 6,
      baseRadiusM: rawSpec.baseRadiusM ?? 0.118,
      hitsToBreach: rawSpec.hitsToBreach ?? 1,
      uvRepeat: rawSpec.uvRepeat ?? [1, 1],
    };

    spec.mesh.userData.penetrableSurfaceId = spec.id;
    spec.mesh.userData.penetrableSurfaceKind = spec.kind;

    const rimGroup = new THREE.Group();
    rimGroup.name = `pen_rim_${spec.id}`;
    spec.mesh.add(rimGroup);

    const runtime: PenetrableSurfaceRuntime = {
      spec,
      originalGeometry: spec.mesh.geometry,
      carvedGeometry: null,
      rimGroup,
      rimMeshes: [],
      rimGeos: [],
      holes: [],
      hitCount: 0,
      isBreached: false,
    };
    this.surfaces.set(spec.id, runtime);
    this.surfaceList.push(runtime);
  }

  public getSurfaceIds(): string[] {
    return this.surfaceList.map((s) => s.spec.id);
  }

  public getHoleCount(surfaceId: string): number {
    return this.surfaces.get(surfaceId)?.holes.length ?? 0;
  }

  /**
   * Carves a physical see-through, shoot-through hole at the exact world impact point
   * where the fist, rifle buttstock, or boot struck the surface.
   */
  public applyMeleeImpact(
    surfaceId: string,
    impactWorldPoint: Readonly<THREE.Vector3>,
    impactWorldDir: Readonly<THREE.Vector3>,
    attackType: BodycamMeleeAttackType = 'jab',
    seed?: number,
  ): { pierced: boolean; holeCount: number } {
    const rt = this.surfaces.get(surfaceId);
    if (!rt) return { pierced: false, holeCount: 0 };

    const { spec } = rt;
    rt.hitCount += 1;

    this._normDir.copy(impactWorldDir);
    if (this._normDir.lengthSq() < 1e-4) {
      this._normDir.set(0, 0, -1);
    } else {
      this._normDir.normalize();
    }

    const distM = impactWorldPoint.distanceTo(this.listenerPos);

    if (rt.hitCount < spec.hitsToBreach) {
      this.spawnDebrisBurst(impactWorldPoint, this._normDir, 6, spec.floorY, spec.kind, true);
      createPenetrableAudioCue(spec.kind, false, distM);
      return { pierced: false, holeCount: rt.holes.length };
    }

    rt.isBreached = true;

    // Transform exact world impact point into panel-local face coordinates (u, v)
    spec.mesh.updateMatrixWorld(true);
    this._localPt.copy(impactWorldPoint);
    spec.mesh.worldToLocal(this._localPt);

    let u = spec.faceAxis === 'x' ? -this._localPt.z : this._localPt.x;
    let v = this._localPt.y;

    const isKick = attackType === 'kick';
    const isBash = attackType === 'bash';
    const baseR = spec.baseRadiusM;
    let rx = isKick ? baseR * 1.32 : isBash ? baseR * 1.15 : baseR;
    let ry = isKick ? baseR * 1.62 : isBash ? baseR * 1.24 : baseR * 1.08;

    // Ensure hole fits strictly within panel outer walls with crisp structural rim margin
    const maxRx = Math.max(0.055, spec.width * 0.38);
    const maxRy = Math.max(0.055, spec.height * 0.38);
    rx = Math.min(rx, maxRx);
    ry = Math.min(ry, maxRy);

    const marginX = rx * 1.18 + 0.025;
    const marginY = ry * 1.18 + 0.025;
    const clampHalfW = Math.max(0.02, spec.width * 0.5 - marginX);
    const clampHalfH = Math.max(0.02, spec.height * 0.5 - marginY);
    u = THREE.MathUtils.clamp(u, -clampHalfW, clampHalfW);
    v = THREE.MathUtils.clamp(v, -clampHalfH, clampHalfH);

    // Prevent intersecting polygons in ShapeUtils.triangulateShape:
    // If punching into/near an existing hole, cleanly enlarge & re-center that hole instead of intersecting!
    let mergedIndex = -1;
    for (let i = 0; i < rt.holes.length; i++) {
      const h = rt.holes[i];
      const du = u - h.u;
      const dv = v - h.v;
      const dist = Math.hypot(du, dv);
      const minNonOverlap = Math.max(h.rx, h.ry) * 1.22 + Math.max(rx, ry) * 1.22 + 0.024;
      if (dist < minNonOverlap) {
        mergedIndex = i;
        break;
      }
    }

    const activeSeed = seed ?? Math.floor(Math.abs(u * 9173 + v * 4817 + rt.hitCount * 131));
    if (mergedIndex >= 0) {
      const h = rt.holes[mergedIndex];
      const targetRx = Math.min(maxRx, Math.max(h.rx, rx) + 0.036);
      const targetRy = Math.min(maxRy, Math.max(h.ry, ry) + 0.042);
      const newClampW = Math.max(0.02, spec.width * 0.5 - (targetRx * 1.18 + 0.022));
      const newClampH = Math.max(0.02, spec.height * 0.5 - (targetRy * 1.18 + 0.022));
      const candU = THREE.MathUtils.clamp((h.u * 2 + u) / 3, -newClampW, newClampW);
      const candV = THREE.MathUtils.clamp((h.v * 2 + v) / 3, -newClampH, newClampH);

      // Verify enlarged radius doesn't collide with another distinct hole
      let collidesOther = false;
      for (let j = 0; j < rt.holes.length; j++) {
        if (j === mergedIndex) continue;
        const o = rt.holes[j];
        const minSep = Math.max(o.rx, o.ry) * 1.22 + Math.max(targetRx, targetRy) * 1.22 + 0.024;
        if (Math.hypot(candU - o.u, candV - o.v) < minSep) {
          collidesOther = true;
          break;
        }
      }
      if (!collidesOther) {
        h.u = candU;
        h.v = candV;
        h.rx = targetRx;
        h.ry = targetRy;
      }
    } else {
      if (rt.holes.length >= spec.maxHoles) {
        rt.holes.shift();
      }
      const nVerts = 12;
      const jitter: number[] = [];
      for (let k = 0; k < nVerts; k++) {
        const s = Math.sin(activeSeed * 12.9898 + k * 78.233) * 43758.5453;
        const frac = s - Math.floor(s);
        jitter.push(0.84 + frac * 0.32);
      }
      rt.holes.push({ u, v, rx, ry, jitter });
    }

    this.rebuildCarvedMesh(rt);

    // Spawn debris spraying forcefully through the far exit side + light back-spray
    this._exitWorld.copy(impactWorldPoint).addScaledVector(this._normDir, spec.thickness * 0.65);
    this.spawnDebrisBurst(
      this._exitWorld,
      this._normDir,
      isKick ? 18 : 13,
      spec.floorY,
      spec.kind,
      false,
    );
    createPenetrableAudioCue(spec.kind, true, distM);

    return { pierced: true, holeCount: rt.holes.length };
  }

  private rebuildCarvedMesh(rt: PenetrableSurfaceRuntime): void {
    const { spec } = rt;
    const hw = spec.width * 0.5;
    const hh = spec.height * 0.5;

    // Outer slab contour (CCW)
    const shape = new THREE.Shape();
    shape.moveTo(-hw, -hh);
    shape.lineTo(hw, -hh);
    shape.lineTo(hw, hh);
    shape.lineTo(-hw, hh);
    shape.closePath();

    // Jagged cutout paths (CW winding)
    for (let hi = 0; hi < rt.holes.length; hi++) {
      const h = rt.holes[hi];
      const n = h.jitter.length;
      const path = new THREE.Path();
      for (let i = n - 1; i >= 0; i--) {
        const ang = (i / n) * Math.PI * 2;
        const rMult = h.jitter[i];
        const px = THREE.MathUtils.clamp(h.u + Math.cos(ang) * h.rx * rMult, -hw + 0.012, hw - 0.012);
        const py = THREE.MathUtils.clamp(h.v + Math.sin(ang) * h.ry * rMult, -hh + 0.012, hh - 0.012);
        if (i === n - 1) {
          path.moveTo(px, py);
        } else {
          path.lineTo(px, py);
        }
      }
      path.closePath();
      shape.holes.push(path);
    }

    const carved = new THREE.ExtrudeGeometry(shape, {
      depth: spec.thickness,
      bevelEnabled: false,
      steps: 1,
      curveSegments: 1,
    });
    carved.translate(0, 0, -spec.thickness * 0.5);

    // Normalize UVs smoothly to match planar [0..uvRepeat] box face mapping before optional axis rotation
    const posAttr = carved.getAttribute('position');
    const uvAttr = carved.getAttribute('uv');
    if (posAttr && uvAttr) {
      const [repU, repV] = spec.uvRepeat;
      for (let i = 0; i < posAttr.count; i++) {
        const px = posAttr.getX(i);
        const py = posAttr.getY(i);
        const uVal = (px / spec.width + 0.5) * repU;
        const vVal = (py / spec.height + 0.5) * repV;
        uvAttr.setXY(i, uVal, vVal);
      }
      uvAttr.needsUpdate = true;
    }

    if (spec.faceAxis === 'x') {
      carved.rotateY(Math.PI * 0.5);
    }
    carved.computeBoundingBox();
    carved.computeBoundingSphere();

    if (rt.carvedGeometry) {
      rt.carvedGeometry.dispose();
    }
    rt.carvedGeometry = carved;
    spec.mesh.geometry = carved;

    // Rebuild 3D jagged rim splinters framing each carved opening on entry & exit edges
    for (let i = 0; i < rt.rimMeshes.length; i++) {
      rt.rimGroup.remove(rt.rimMeshes[i]);
    }
    for (let i = 0; i < rt.rimGeos.length; i++) {
      rt.rimGeos[i].dispose();
    }
    rt.rimMeshes.length = 0;
    rt.rimGeos.length = 0;

    const rimMat =
      spec.kind === 'drywall'
        ? this.matGypsumCore
        : spec.kind === 'plywood' || spec.kind === 'range_panel'
          ? this.matPlywoodEdge
          : this.matWoodSplinter;

    for (let hi = 0; hi < rt.holes.length; hi++) {
      const h = rt.holes[hi];
      const n = h.jitter.length;
      const teethStep = 2;
      for (let i = 0; i < n; i += teethStep) {
        const ang = (i / n) * Math.PI * 2;
        const edgeR = h.jitter[i];
        const px = h.u + Math.cos(ang) * h.rx * edgeR * 0.92;
        const py = h.v + Math.sin(ang) * h.ry * edgeR * 0.92;

        const toothLen = Math.min(h.rx, h.ry) * (0.28 + (i % 3) * 0.08);
        const toothW = spec.kind === 'drywall' ? 0.036 : 0.024;
        const toothGeo = new THREE.BoxGeometry(toothLen, toothW, spec.thickness * 1.12);
        const tooth = new THREE.Mesh(toothGeo, rimMat);

        if (spec.faceAxis === 'x') {
          tooth.position.set(0, py, -px);
          tooth.rotation.set(ang + 0.18, Math.PI * 0.5, 0);
        } else {
          tooth.position.set(px, py, 0);
          tooth.rotation.set(0, 0, ang + 0.18);
        }
        rt.rimGroup.add(tooth);
        rt.rimMeshes.push(tooth);
        rt.rimGeos.push(toothGeo);
      }
    }
  }

  private spawnDebrisBurst(
    origin: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    count: number,
    floorY: number,
    kind: PenetrableSurfaceKind,
    backSprayOnly: boolean,
  ): void {
    let spawned = 0;
    const preferDrywall = kind === 'drywall';
    for (let i = 0; i < this.debrisPool.length && spawned < count; i++) {
      const d = this.debrisPool[i];
      if (d.active) continue;
      d.active = true;
      d.age = 0;
      d.maxAge = 1.05 + Math.random() * 0.85;
      d.floorY = floorY + 0.015;
      d.mesh.visible = true;
      d.mesh.material = preferDrywall
        ? this.matGypsumCore
        : kind === 'plywood' || kind === 'range_panel'
          ? this.matPlywoodEdge
          : this.matWoodSplinter;

      d.mesh.position.set(
        origin.x + (Math.random() - 0.5) * 0.14,
        origin.y + (Math.random() - 0.5) * 0.16,
        origin.z + (Math.random() - 0.5) * 0.14,
      );
      d.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);

      const speed = backSprayOnly ? -(1.4 + Math.random() * 1.8) : 2.8 + Math.random() * 4.4;
      d.vel.set(
        dir.x * speed + (Math.random() - 0.5) * 2.1,
        0.85 + Math.random() * 2.1,
        dir.z * speed + (Math.random() - 0.5) * 2.1,
      );
      d.angVel.set(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
      );
      spawned += 1;
    }
  }

  public repairSurface(surfaceId: string): void {
    const rt = this.surfaces.get(surfaceId);
    if (!rt) return;
    rt.hitCount = 0;
    rt.isBreached = false;
    rt.holes.length = 0;
    rt.spec.mesh.geometry = rt.originalGeometry;
    if (rt.carvedGeometry) {
      rt.carvedGeometry.dispose();
      rt.carvedGeometry = null;
    }
    for (let i = 0; i < rt.rimMeshes.length; i++) {
      rt.rimGroup.remove(rt.rimMeshes[i]);
    }
    for (let i = 0; i < rt.rimGeos.length; i++) {
      rt.rimGeos[i].dispose();
    }
    rt.rimMeshes.length = 0;
    rt.rimGeos.length = 0;
  }

  public resetSurface(surfaceId: string): void {
    this.repairSurface(surfaceId);
  }

  public resetAll(): void {
    for (let i = 0; i < this.surfaceList.length; i++) {
      this.repairSurface(this.surfaceList[i].spec.id);
    }
  }

  public update(dt: number, listenerPos?: Readonly<THREE.Vector3>): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    if (listenerPos) this.listenerPos.copy(listenerPos);

    for (let i = 0; i < this.debrisPool.length; i++) {
      const p = this.debrisPool[i];
      if (!p.active) continue;
      p.age += clampedDt;
      if (p.age >= p.maxAge) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.vel.y -= 13.8 * clampedDt;
      p.mesh.position.addScaledVector(p.vel, clampedDt);
      p.mesh.rotation.x += p.angVel.x * clampedDt;
      p.mesh.rotation.y += p.angVel.y * clampedDt;
      p.mesh.rotation.z += p.angVel.z * clampedDt;
      if (p.mesh.position.y < p.floorY) {
        p.mesh.position.y = p.floorY;
        p.vel.y = Math.abs(p.vel.y) * 0.28;
        p.vel.x *= 0.60;
        p.vel.z *= 0.60;
        p.angVel.multiplyScalar(0.5);
      }
    }
  }

  public dispose(): void {
    this.resetAll();
    this.surfaces.clear();
    this.surfaceList.length = 0;
    this.woodChunkGeo.dispose();
    this.drywallChunkGeo.dispose();
    this.matWoodSplinter.dispose();
    this.matGypsumCore.dispose();
    this.matPlywoodEdge.dispose();
    this.debrisRoot.parent?.remove(this.debrisRoot);
  }
}

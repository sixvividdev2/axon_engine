import * as THREE from 'three';
import {
  BALLISTIC_MATERIALS,
  BallisticMaterialId,
  computeCriticalRicochetDeg,
  mapSurfaceToBallisticMaterial,
} from '../../data/ballisticMaterials';
import { AmmoVariantDef } from '../../data/calibers';
import { IBodycamAudioSource } from '../IBodycamAudioSource';
import {
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  createRaycastResult,
  IBodycamWorldAdapter,
} from '../types';

export type TerminalOutcome = 'ricochet' | 'fragment' | 'penetrate' | 'stop';

export interface BallisticImpactEvent {
  outcome: TerminalOutcome;
  ammo: AmmoVariantDef;
  weaponId: string;
  material: BallisticMaterialId;
  surface: BodycamSurfaceMaterial;
  object: THREE.Object3D | null;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  incomingDir: THREE.Vector3;
  outgoingDir: THREE.Vector3;
  impactSpeedMs: number;
  impactEnergyJ: number;
  grazingAngleDeg: number;
  distanceM: number;
  isFragment: boolean;
  bounceIndex: number;
  exitPoint: THREE.Vector3;
  penetrationThicknessM: number;
}

export interface BallisticShotParams {
  origin: Readonly<THREE.Vector3>;
  direction: Readonly<THREE.Vector3>;
  ammo: AmmoVariantDef;
  weaponId: string;
  barrelVelocityMult?: number;
  attachmentVelocityMult?: number;
  weaponSpreadMOA?: number;
  audio?: IBodycamAudioSource;
}

interface PooledProjectile {
  active: boolean;
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  vel: THREE.Vector3;
  massKg: number;
  bc: number;
  penetrationPower: number;
  ammo: AmmoVariantDef | null;
  weaponId: string;
  distanceTraveled: number;
  maxDistanceM: number;
  age: number;
  bouncesLeft: number;
  bounceCount: number;
  isFragment: boolean;
  audio: IBodycamAudioSource | undefined;
}

interface PooledSpark {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface PooledDecal {
  active: boolean;
  age: number;
  mesh: THREE.Mesh;
}

interface PooledTracer {
  active: boolean;
  life: number;
  mesh: THREE.Mesh;
}

const MAX_PROJECTILES = 96;
const MAX_SPARKS = 112;
const MAX_DECALS = 96;
const MAX_TRACERS = 64;
const GRAVITY_MPS2 = 9.81;
const AIR_DENSITY_SEA = 1.225;
const SPEED_OF_SOUND_MPS = 340.3;

export class BallisticsSolver {
  public readonly group = new THREE.Group();
  private readonly projectiles: PooledProjectile[] = [];
  private readonly sparks: PooledSpark[] = [];
  private readonly decals: PooledDecal[] = [];
  private readonly tracers: PooledTracer[] = [];

  private decalCursor = 0;
  private tracerCursor = 0;
  private sparkCursor = 0;

  private readonly decalGeo: THREE.PlaneGeometry;
  private readonly decalMatDark: THREE.MeshBasicMaterial;
  private readonly decalMatSteel: THREE.MeshBasicMaterial;
  private readonly decalMatWood: THREE.MeshBasicMaterial;
  private readonly tracerGeo: THREE.CylinderGeometry;
  private readonly tracerMat: THREE.MeshBasicMaterial;
  private readonly fragTracerMat: THREE.MeshBasicMaterial;
  private readonly sparkInstanced: THREE.InstancedMesh;
  private readonly sparkGeo: THREE.BoxGeometry;
  private readonly sparkMat: THREE.MeshBasicMaterial;

  // Pre-allocated zero-GC scratch variables
  private readonly _rayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _backHit: BodycamRaycastResult = createRaycastResult();
  private readonly _stepDelta = new THREE.Vector3();
  private readonly _stepDir = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();
  private readonly _refl = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _altUp = new THREE.Vector3(1, 0, 0);
  private readonly _accel1 = new THREE.Vector3();
  private readonly _velMid = new THREE.Vector3();
  private readonly _accel2 = new THREE.Vector3();
  private readonly _backOrigin = new THREE.Vector3();
  private readonly _backDir = new THREE.Vector3();
  private readonly _decalPos = new THREE.Vector3();
  private readonly _decalLook = new THREE.Vector3();
  private readonly _sparkMatrix = new THREE.Matrix4();
  private readonly _sparkQuat = new THREE.Quaternion();
  private readonly _sparkScale = new THREE.Vector3();
  private readonly _zeroScale = new THREE.Vector3(0, 0, 0);
  private readonly _tracerMid = new THREE.Vector3();

  private readonly _impactEvent: BallisticImpactEvent = {
    outcome: 'stop',
    ammo: null as unknown as AmmoVariantDef,
    weaponId: '',
    material: 'concrete',
    surface: 'concrete',
    object: null,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    incomingDir: new THREE.Vector3(),
    outgoingDir: new THREE.Vector3(),
    impactSpeedMs: 0,
    impactEnergyJ: 0,
    grazingAngleDeg: 0,
    distanceM: 0,
    isFragment: false,
    bounceIndex: 0,
    exitPoint: new THREE.Vector3(),
    penetrationThicknessM: 0,
  };

  constructor(scene?: THREE.Scene) {
    this.decalGeo = new THREE.PlaneGeometry(0.048, 0.048);
    this.decalMatDark = new THREE.MeshBasicMaterial({
      color: 0x161618,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.decalMatSteel = new THREE.MeshBasicMaterial({
      color: 0x9aa3ad,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.decalMatWood = new THREE.MeshBasicMaterial({
      color: 0x3b2818,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });

    this.tracerGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 5, 1, true);
    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffcf7a,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.fragTracerMat = new THREE.MeshBasicMaterial({
      color: 0xff8b42,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push({
        active: false,
        pos: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        massKg: 0.008,
        bc: 0.25,
        penetrationPower: 20,
        ammo: null,
        weaponId: '',
        distanceTraveled: 0,
        maxDistanceM: 1200,
        age: 0,
        bouncesLeft: 2,
        bounceCount: 0,
        isFragment: false,
        audio: undefined,
      });
    }

    this.sparkGeo = new THREE.BoxGeometry(0.004, 0.004, 0.065);
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffc668,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sparkInstanced = new THREE.InstancedMesh(this.sparkGeo, this.sparkMat, MAX_SPARKS);
    this.sparkInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkInstanced.frustumCulled = false;

    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.2,
      });
      this._sparkMatrix.makeScale(0, 0, 0);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    this.sparkInstanced.instanceMatrix.needsUpdate = true;
    this.group.add(this.sparkInstanced);

    for (let i = 0; i < MAX_DECALS; i++) {
      const mesh = new THREE.Mesh(this.decalGeo, this.decalMatDark);
      mesh.visible = false;
      this.group.add(mesh);
      this.decals.push({ active: false, age: 0, mesh });
    }

    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ active: false, life: 0, mesh });
    }

    if (scene) {
      scene.add(this.group);
    }
  }

  /**
   * Computes true coupled muzzle velocity from cartridge base velocity, barrel length mult, and attachment mult.
   */
  public static computeMuzzleVelocityMs(
    ammo: AmmoVariantDef,
    barrelVelocityMult = 1.0,
    attachmentVelocityMult = 1.0,
  ): number {
    return ammo.baseVelocityMs * barrelVelocityMult * attachmentVelocityMult;
  }

  public spawnShot(params: BallisticShotParams): number {
    const { ammo } = params;
    const muzzleVel = BallisticsSolver.computeMuzzleVelocityMs(
      ammo,
      params.barrelVelocityMult ?? 1.0,
      params.attachmentVelocityMult ?? 1.0,
    );

    const totalMOA = Math.hypot(params.weaponSpreadMOA ?? 2.0, ammo.spreadMOA);
    const spreadRad = THREE.MathUtils.degToRad(totalMOA / 60);

    const refUp = Math.abs(params.direction.y) < 0.94 ? this._worldUp : this._altUp;
    this._right.crossVectors(params.direction, refUp).normalize();
    this._up.crossVectors(this._right, params.direction).normalize();

    const pelletCount = Math.max(1, ammo.pellets);
    const pelletMassGrams = ammo.bulletMassGrams;
    const massKg = pelletMassGrams * 0.001;
    const nominalKE = 0.5 * massKg * muzzleVel * muzzleVel;
    const initialPenPower = ammo.penetrationRating * 68 + Math.pow(nominalKE / 1000, 0.65) * 26;
    let spawned = 0;

    for (let i = 0; i < pelletCount; i++) {
      const slot = this.allocProjectile();
      if (!slot) break;

      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * spreadRad;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;

      this._stepDir
        .copy(params.direction)
        .addScaledVector(this._right, dx)
        .addScaledVector(this._up, dy)
        .normalize();

      slot.active = true;
      slot.pos.copy(params.origin);
      slot.prevPos.copy(params.origin);
      slot.vel.copy(this._stepDir).multiplyScalar(muzzleVel);
      slot.massKg = massKg;
      slot.bc = ammo.ballisticCoefficient;
      slot.penetrationPower = initialPenPower;
      slot.ammo = ammo;
      slot.weaponId = params.weaponId;
      slot.distanceTraveled = 0;
      slot.maxDistanceM = pelletCount > 1 ? 160 : 1200;
      slot.age = 0;
      slot.bouncesLeft = pelletCount > 1 ? 1 : 2;
      slot.bounceCount = 0;
      slot.isFragment = false;
      slot.audio = params.audio;
      spawned++;
    }

    return spawned;
  }

  public update(
    dt: number,
    world: IBodycamWorldAdapter,
    onImpact?: (event: Readonly<BallisticImpactEvent>) => void,
  ): void {
    if (dt <= 0) return;

    // 1. Step live projectiles with RK2 G1 aerodynamic drag + swept raycast
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = this.projectiles[i];
      if (!p.active || !p.ammo) continue;

      p.age += dt;
      if (p.age > 3.5 || p.distanceTraveled > p.maxDistanceM) {
        p.active = false;
        continue;
      }

      p.prevPos.copy(p.pos);

      // RK2 integration step
      this.computeAccel(p.vel, p.bc, this._accel1);
      this._velMid.copy(p.vel).addScaledVector(this._accel1, dt * 0.5);
      this.computeAccel(this._velMid, p.bc, this._accel2);

      this._stepDelta.copy(this._velMid).multiplyScalar(dt);
      const stepDist = this._stepDelta.length();
      if (stepDist < 1e-5) {
        p.active = false;
        continue;
      }

      this._stepDir.copy(this._stepDelta).divideScalar(stepDist);

      const hit = world.raycast(p.prevPos, this._stepDir, 0.002, stepDist + 0.015, this._rayHit);
      if (hit && this._rayHit.distance <= stepDist + 0.015) {
        p.pos.set(this._rayHit.pointX, this._rayHit.pointY, this._rayHit.pointZ);
        p.vel.addScaledVector(this._accel2, dt * (this._rayHit.distance / stepDist));
        p.distanceTraveled += this._rayHit.distance;
        this.spawnTracer(p.prevPos, p.pos, p.isFragment);
        this.resolveImpact(p, this._rayHit, world, onImpact);
      } else {
        p.pos.add(this._stepDelta);
        p.vel.addScaledVector(this._accel2, dt);
        p.distanceTraveled += stepDist;
        if (p.vel.lengthSq() < 2500) {
          // < 50 m/s spent round
          p.active = false;
          continue;
        }
        this.spawnTracer(p.prevPos, p.pos, p.isFragment);
      }
    }

    // 2. Step pooled sparks (InstancedMesh, zero allocations)
    let sparksDirty = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const s = this.sparks[i];
      if (!s.active) continue;
      sparksDirty = true;
      s.life -= dt;
      if (s.life <= 0) {
        s.active = false;
        this._sparkMatrix.makeScale(0, 0, 0);
        this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
        continue;
      }
      s.vel.y -= GRAVITY_MPS2 * dt;
      s.vel.multiplyScalar(Math.max(0, 1 - dt * 2.8));
      s.pos.addScaledVector(s.vel, dt);

      const spd = s.vel.length();
      if (spd > 0.01) {
        this._stepDir.copy(s.vel).divideScalar(spd);
        this._sparkQuat.setFromUnitVectors(this._worldUp, this._stepDir);
      }
      const stretch = THREE.MathUtils.clamp(spd * 0.04, 0.4, 2.2) * (s.life / s.maxLife);
      this._sparkScale.set(1, 1, stretch);
      this._sparkMatrix.compose(s.pos, this._sparkQuat, this._sparkScale);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    if (sparksDirty) {
      this.sparkInstanced.instanceMatrix.needsUpdate = true;
    }

    // 3. Fade tracer streaks
    for (let i = 0; i < MAX_TRACERS; i++) {
      const tr = this.tracers[i];
      if (!tr.active) continue;
      tr.life -= dt;
      if (tr.life <= 0) {
        tr.active = false;
        tr.mesh.visible = false;
      }
    }
  }

  public clearEffects(): void {
    for (let i = 0; i < MAX_PROJECTILES; i++) this.projectiles[i].active = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers[i].active = false;
      this.tracers[i].mesh.visible = false;
    }
    for (let i = 0; i < MAX_DECALS; i++) {
      this.decals[i].active = false;
      this.decals[i].mesh.visible = false;
    }
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks[i].active = false;
      this._sparkMatrix.makeScale(0, 0, 0);
      this.sparkInstanced.setMatrixAt(i, this._sparkMatrix);
    }
    this.sparkInstanced.instanceMatrix.needsUpdate = true;
  }

  private computeAccel(vel: Readonly<THREE.Vector3>, bc: number, out: THREE.Vector3): void {
    const v = vel.length();
    if (v < 1e-3) {
      out.set(0, -GRAVITY_MPS2, 0);
      return;
    }
    const mach = v / SPEED_OF_SOUND_MPS;
    // Standard G1 drag curve approximation: subsonic base -> transonic wave drag hump -> supersonic taper
    let cd = 0.24;
    if (mach >= 0.85 && mach < 1.2) {
      const t = (mach - 0.85) / 0.35;
      cd = 0.24 + t * 0.34;
    } else if (mach >= 1.2) {
      cd = 0.58 / Math.pow(mach, 0.32);
    }

    // Calibrated G1 retardation factor (SI units)
    const dragFactor = (0.5 * AIR_DENSITY_SEA * v * cd * 0.00046) / Math.max(0.05, bc);
    out.set(-vel.x * dragFactor, -GRAVITY_MPS2 - vel.y * dragFactor, -vel.z * dragFactor);
  }

  private resolveImpact(
    p: PooledProjectile,
    hit: BodycamRaycastResult,
    world: IBodycamWorldAdapter,
    onImpact?: (event: Readonly<BallisticImpactEvent>) => void,
  ): void {
    const ammo = p.ammo!;
    const speedMs = p.vel.length();
    const energyJ = 0.5 * p.massKg * speedMs * speedMs;
    const matId = mapSurfaceToBallisticMaterial(hit.surface, hit.object?.userData);
    const mat = BALLISTIC_MATERIALS[matId];

    this._normal.set(hit.normalX, hit.normalY, hit.normalZ);
    if (this._normal.lengthSq() < 0.01) {
      this._normal.set(0, 1, 0);
    } else {
      this._normal.normalize();
    }

    this._stepDir.copy(p.vel).divideScalar(Math.max(1e-3, speedMs));
    const cosInc = THREE.MathUtils.clamp(Math.abs(this._stepDir.dot(this._normal)), 0, 1);
    const grazingAngleDeg = THREE.MathUtils.radToDeg(Math.asin(cosInc));

    const ev = this._impactEvent;
    ev.ammo = ammo;
    ev.weaponId = p.weaponId;
    ev.material = matId;
    ev.surface = hit.surface;
    ev.object = hit.object;
    ev.point.set(hit.pointX, hit.pointY, hit.pointZ);
    ev.normal.copy(this._normal);
    ev.incomingDir.copy(this._stepDir);
    ev.outgoingDir.copy(this._stepDir);
    ev.impactSpeedMs = speedMs;
    ev.impactEnergyJ = energyJ;
    ev.grazingAngleDeg = grazingAngleDeg;
    ev.distanceM = p.distanceTraveled;
    ev.isFragment = p.isFragment;
    ev.bounceIndex = p.bounceCount;
    ev.exitPoint.copy(ev.point);
    ev.penetrationThicknessM = 0;

    // 0. Breakable Glass: shatter + immediate pass-through
    if (matId === 'glass') {
      world.shatterBreakable?.(hit.object!, ev.point, this._stepDir);
      p.vel.multiplyScalar(0.88);
      p.pos.addScaledVector(this._stepDir, 0.03);
      ev.outcome = 'penetrate';
      onImpact?.(ev);
      return;
    }

    // 1. GRAZING RICOCHET
    const critRicochetDeg = computeCriticalRicochetDeg(mat, ammo.coreType, speedMs);
    if (!p.isFragment && p.bouncesLeft > 0 && grazingAngleDeg <= critRicochetDeg && speedMs > 120) {
      const dotDN = this._stepDir.dot(this._normal);
      this._refl.copy(this._stepDir).addScaledVector(this._normal, -2 * dotDN).normalize();

      // Add realistic deflection scatter
      const scatter = 0.04 + (1 - mat.elasticityRetention) * 0.06;
      this._refl.x += (Math.random() - 0.5) * scatter;
      this._refl.y += (Math.random() - 0.25) * scatter * 0.6;
      this._refl.z += (Math.random() - 0.5) * scatter;
      this._refl.normalize();

      const grazingBonus = (1 - grazingAngleDeg / Math.max(1, critRicochetDeg)) * 0.30;
      const retention = THREE.MathUtils.clamp(
        0.30 + mat.elasticityRetention * 0.25 + grazingBonus,
        0.30,
        0.65,
      );
      const nextSpeed = speedMs * retention;

      p.pos.copy(ev.point).addScaledVector(this._normal, 0.015);
      p.vel.copy(this._refl).multiplyScalar(nextSpeed);
      p.bouncesLeft -= 1;
      p.bounceCount += 1;
      p.penetrationPower *= retention * 0.85;

      this.addDecal(ev.point, this._normal, matId);
      this.spawnSparks(ev.point, this._refl, matId === 'steel' ? 8 : 4, 9.5);
      p.audio?.playRicochet?.(ev.point, nextSpeed, hit.surface);

      ev.outcome = 'ricochet';
      ev.outgoingDir.copy(this._refl);
      onImpact?.(ev);
      return;
    }

    // 2. PENETRATION CHECK (with dynamic backface thickness probe)
    const hitUserThickness =
      typeof hit.object?.userData?.thicknessM === 'number' ? hit.object.userData.thicknessM : null;
    const isSolidImpenetrable = Boolean(hit.object?.userData?.impenetrable);

    let measuredThicknessM = hitUserThickness ?? 0.14;
    if (!isSolidImpenetrable && hitUserThickness === null && !p.isFragment) {
      const maxProbeM = 0.55;
      this._backOrigin.copy(ev.point).addScaledVector(this._stepDir, maxProbeM);
      this._backDir.copy(this._stepDir).negate();
      const backFound = world.raycast(this._backOrigin, this._backDir, 0.005, maxProbeM, this._backHit);
      if (backFound && (!hit.object || this._backHit.object === hit.object)) {
        measuredThicknessM = THREE.MathUtils.clamp(maxProbeM - this._backHit.distance, 0.015, maxProbeM);
      }
    }

    let corePenMult = 1.0;
    if (matId === 'steel' || matId === 'concrete') {
      switch (ammo.coreType) {
        case 'tungsten_ap':
          corePenMult = 1.22;
          break;
        case 'solid_steel':
          corePenMult = 1.18;
          break;
        case 'steel_core_ap':
          corePenMult = 1.05;
          break;
        case 'lead_fmj':
          corePenMult = 0.86;
          break;
        case 'lead_jhp':
          corePenMult = 0.52;
          break;
        case 'soft_lead':
          corePenMult = 0.48;
          break;
        case 'frangible_pellet':
          corePenMult = 0.30;
          break;
      }
    }

    const dynPen =
      p.penetrationPower *
      corePenMult *
      THREE.MathUtils.clamp(speedMs / Math.max(180, ammo.baseVelocityMs), 0.25, 1.35);
    const requiredPen = mat.penetrationResistance * (0.22 + measuredThicknessM * 9.0);

    if (!isSolidImpenetrable && !p.isFragment && dynPen > requiredPen && measuredThicknessM < 0.52) {
      const exitRatio = THREE.MathUtils.clamp(Math.sqrt(1 - requiredPen / dynPen), 0.28, 0.85);
      const tumble = (1 - exitRatio) * 0.065;

      this._refl
        .copy(this._stepDir)
        .add(
          this._right.set(
            (Math.random() - 0.5) * tumble,
            (Math.random() - 0.5) * tumble,
            (Math.random() - 0.5) * tumble,
          ),
        )
        .normalize();

      this.addDecal(ev.point, this._normal, matId);
      ev.exitPoint.copy(ev.point).addScaledVector(this._stepDir, measuredThicknessM + 0.02);
      // Exit decal on far face
      this.addDecal(ev.exitPoint, this._stepDir, matId);
      this.spawnSparks(ev.exitPoint, this._refl, matId === 'steel' ? 6 : 3, 6.5);

      p.pos.copy(ev.exitPoint).addScaledVector(this._refl, 0.012);
      p.vel.copy(this._refl).multiplyScalar(speedMs * exitRatio);
      p.penetrationPower = Math.max(4, p.penetrationPower - requiredPen * 0.85);

      ev.outcome = 'penetrate';
      ev.outgoingDir.copy(this._refl);
      ev.penetrationThicknessM = measuredThicknessM;
      onImpact?.(ev);
      return;
    }

    // 3. BULLET BREAKING / FRAGMENTATION
    const fragileBullet =
      ammo.coreType === 'lead_jhp' ||
      ammo.coreType === 'soft_lead' ||
      (ammo.coreType === 'steel_core_ap' && ammo.bulletMassGrams <= 4.5 && speedMs > 780) ||
      (ammo.coreType === 'lead_fmj' && ammo.bulletMassGrams <= 4.5 && speedMs > 780);

    if (
      !p.isFragment &&
      mat.spallTendency > 0.45 &&
      fragileBullet &&
      speedMs >= ammo.fragmentThresholdMs
    ) {
      const fragCount = 2 + Math.floor(Math.random() * 3); // 2..4 micro-spall shards
      const dotDN = this._stepDir.dot(this._normal);
      this._refl.copy(this._stepDir).addScaledVector(this._normal, -2 * dotDN).normalize();

      for (let f = 0; f < fragCount; f++) {
        const frag = this.allocProjectile();
        if (!frag) break;
        frag.active = true;
        frag.pos.copy(ev.point).addScaledVector(this._normal, 0.016);
        frag.prevPos.copy(frag.pos);

        const sDirX = this._refl.x + (Math.random() - 0.5) * 0.72 + this._normal.x * 0.22;
        const sDirY = this._refl.y + (Math.random() - 0.5) * 0.55 + this._normal.y * 0.22;
        const sDirZ = this._refl.z + (Math.random() - 0.5) * 0.72 + this._normal.z * 0.22;
        this._up.set(sDirX, sDirY, sDirZ).normalize();

        frag.vel.copy(this._up).multiplyScalar(speedMs * (0.35 + Math.random() * 0.25));
        frag.massKg = p.massKg * 0.28;
        frag.bc = 0.06;
        frag.penetrationPower = 4;
        frag.ammo = ammo;
        frag.weaponId = p.weaponId;
        frag.distanceTraveled = 0;
        frag.maxDistanceM = 2.0; // short-lived spall cone < 2m
        frag.age = 0;
        frag.bouncesLeft = 0;
        frag.bounceCount = 0;
        frag.isFragment = true;
        frag.audio = undefined;
      }

      this.addDecal(ev.point, this._normal, matId);
      this.spawnSparks(ev.point, this._normal, 12, 10.5);
      p.active = false;
      ev.outcome = 'fragment';
      ev.outgoingDir.copy(this._refl);
      onImpact?.(ev);
      return;
    }

    // 4. EMBED / STOP
    this.addDecal(ev.point, this._normal, matId);
    this.spawnSparks(ev.point, this._normal, matId === 'steel' ? 6 : 2, 5.0);
    p.active = false;
    ev.outcome = 'stop';
    onImpact?.(ev);
  }

  private allocProjectile(): PooledProjectile | null {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (!this.projectiles[i].active) {
        return this.projectiles[i];
      }
    }
    return null;
  }

  private spawnTracer(start: Readonly<THREE.Vector3>, end: Readonly<THREE.Vector3>, isFragment: boolean): void {
    const len = start.distanceTo(end);
    if (len < 0.04) return;
    const slot = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % MAX_TRACERS;

    this._tracerMid.addVectors(start, end).multiplyScalar(0.5);
    this._stepDir.subVectors(end, start).divideScalar(len);

    slot.active = true;
    slot.life = isFragment ? 0.055 : 0.038;
    slot.mesh.material = isFragment ? this.fragTracerMat : this.tracerMat;
    slot.mesh.position.copy(this._tracerMid);
    slot.mesh.quaternion.setFromUnitVectors(this._worldUp, this._stepDir);
    slot.mesh.scale.set(isFragment ? 0.7 : 1.0, Math.min(len, 18), isFragment ? 0.7 : 1.0);
    slot.mesh.visible = true;
  }

  private spawnSparks(
    origin: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    count: number,
    speed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARKS;

      s.active = true;
      s.pos.copy(origin).addScaledVector(dir, 0.015);
      s.vel.set(
        dir.x * speed + (Math.random() - 0.5) * speed * 1.35,
        dir.y * speed + Math.random() * speed * 0.9,
        dir.z * speed + (Math.random() - 0.5) * speed * 1.35,
      );
      s.maxLife = 0.14 + Math.random() * 0.16;
      s.life = s.maxLife;
    }
  }

  private addDecal(
    pos: Readonly<THREE.Vector3>,
    normal: Readonly<THREE.Vector3>,
    mat: BallisticMaterialId,
  ): void {
    const slot = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;

    this._decalPos.copy(pos).addScaledVector(normal, 0.004);
    this._decalLook.copy(this._decalPos).add(normal);
    slot.mesh.material =
      mat === 'steel' ? this.decalMatSteel : mat === 'wood' ? this.decalMatWood : this.decalMatDark;
    slot.mesh.position.copy(this._decalPos);
    slot.mesh.lookAt(this._decalLook);
    slot.mesh.rotateZ(Math.random() * Math.PI * 2);
    const scale = 0.65 + Math.random() * 0.6;
    slot.mesh.scale.set(scale, scale, 1);
    slot.mesh.visible = true;
    slot.active = true;
    slot.age = 0;
  }

  public dispose(): void {
    this.decalGeo.dispose();
    this.decalMatDark.dispose();
    this.decalMatSteel.dispose();
    this.decalMatWood.dispose();
    this.tracerGeo.dispose();
    this.tracerMat.dispose();
    this.fragTracerMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.sparkInstanced.dispose();
  }
}

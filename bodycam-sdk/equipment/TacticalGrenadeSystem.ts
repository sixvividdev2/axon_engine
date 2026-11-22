import * as THREE from 'three';
import {
  getTacticalEquipmentDef,
  TacticalEquipmentDef,
  TacticalEquipmentId,
} from '../../data/tacticalEquipment';
import { VIEWMODEL_LAYER } from '../BodycamPostProcess';
import { IBodycamAudioSource } from '../IBodycamAudioSource';
import { IBodycamWorldAdapter } from '../types';
import { buildTacticalEquipmentMesh, BuiltTacticalEquipmentMesh } from './TacticalEquipmentMesh';

export type GrenadeEffectKind = 'frag' | 'flash' | 'smoke' | 'thermite';

/**
 * Authentic 4-stage tactical grenade Manual of Arms:
 *  - HOLSTERED: stowed on tactical waist belt
 *  - DRAWN: held in viewmodel hand, pin intact, spoon locked
 *  - PIN_PULLED: safety pin yanked out (LMB hold), spoon STILL gripped -> fuse NOT running
 *  - LEVER_RELEASED: safety lever released (RMB while holding LMB), physical spoon flew off,
 *                    striker hit primer, chemical delay fuse actively burning with hidden variance
 */
export type GrenadeHoldStage = 'HOLSTERED' | 'DRAWN' | 'PIN_PULLED' | 'LEVER_RELEASED';

export interface ActiveSmokeCloudInfo {
  id: number;
  position: THREE.Vector3;
  radiusM: number;
  age: number;
  duration: number;
  isScreeningSmoke: boolean;
}

export interface FlashbangExposureResult {
  intensity: number;
  lookFactor: number;
  distM: number;
  occluded: boolean;
}

export interface GrenadeDetonationEvent {
  equipmentId: TacticalEquipmentId;
  def: TacticalEquipmentDef;
  kind: GrenadeEffectKind;
  position: THREE.Vector3;
  radiusM: number;
  lethalRadiusM: number;
  maxDamage: number;
  isTick: boolean;
  tickDtSec?: number;
}

export interface TacticalGrenadeSystemOptions {
  scene: THREE.Scene;
  physics: IBodycamWorldAdapter;
  worldRaycastMeshes: THREE.Object3D[];
  worldBounds?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  audio?: IBodycamAudioSource | null;
  onDetonate?: (ev: GrenadeDetonationEvent) => void;
  onShatterGlass?: (
    object: THREE.Object3D,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ) => void;
}

interface ActiveGrenade {
  equipmentId: TacticalEquipmentId;
  def: TacticalEquipmentDef;
  built: BuiltTacticalEquipmentMesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  fuseLeft: number;
  age: number;
  bounces: number;
  resting: boolean;
}

interface FlyingSpoon {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  age: number;
  maxAge: number;
}

interface ExplosionVfx {
  group: THREE.Group;
  light: THREE.PointLight;
  coreMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  sparks: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }>;
  age: number;
  maxAge: number;
  peakIntensity: number;
  maxCoreScale: number;
  maxRingScale: number;
}

interface SmokeCloud {
  id: number;
  origin: THREE.Vector3;
  effectiveRadiusM: number;
  isScreeningSmoke: boolean;
  group: THREE.Group;
  puffs: Array<{
    mesh: THREE.Mesh;
    mat: THREE.MeshStandardMaterial;
    targetPos: THREE.Vector3;
    targetScale: number;
    driftSpeed: number;
    phase: number;
  }>;
  age: number;
  duration: number;
}

interface ThermiteZone {
  equipmentId: TacticalEquipmentId;
  def: TacticalEquipmentDef;
  pos: THREE.Vector3;
  group: THREE.Group;
  light: THREE.PointLight;
  emberMat: THREE.MeshStandardMaterial;
  sparks: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }>;
  age: number;
  duration: number;
  tickAccum: number;
}

const GRAVITY_MPS2 = 14.2;
const GRENADE_RADIUS_M = 0.048;

function resolveEffectKind(id: TacticalEquipmentId): GrenadeEffectKind {
  switch (id) {
    case 'm67_frag':
      return 'frag';
    case 'm84_flash':
      return 'flash';
    case 'm18_smoke':
      return 'smoke';
    case 'an_m14_thermite':
      return 'thermite';
  }
}

function samplePyrotechnicFuseSec(def: TacticalEquipmentDef): number {
  const variance = def.fuseVarianceSec ?? 0.25;
  // Subtle realistic chemical burn variance (e.g., M67: 4.0 to 5.0s around 4.5s nominal)
  return Math.max(0.65, def.fuseSec + (Math.random() * 2 - 1) * variance);
}

/**
 * Portable 3D Tactical Ordnance & Grenade Physics System shared across
 * Playground (Gym), Battle (Solo & MP), and Infection (Solo & MP).
 *
 * Implements:
 *  - Authentic 4-stage Manual of Arms: Draw -> Pull Pin (fuse NOT running) -> Release Lever (spoon flies off,
 *    pyrotechnic delay ignites with hidden variance) -> Throw
 *  - First-person VIEWMODEL_LAYER held grenade preview with removable pin ring & flying safety spoon
 *  - M67 44-ray 3D spherical fragmentation shard ray-matrix (5m lethal core / 15m casualty zone / cover-occluded)
 *  - M18 Screening Smoke volumetric registry blocking BattleBotAI line-of-sight
 *  - M84 Flashbang camera-angle & cover-occluded exposure solver for bodycam CMOS overload + tinnitus
 */
export class TacticalGrenadeSystem {
  public readonly root = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly physics: IBodycamWorldAdapter;
  private worldRaycastMeshes: THREE.Object3D[];
  private readonly worldBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  private readonly audio?: IBodycamAudioSource | null;
  private readonly onDetonate?: (ev: GrenadeDetonationEvent) => void;
  private readonly onShatterGlass?: TacticalGrenadeSystemOptions['onShatterGlass'];

  private readonly activeGrenades: ActiveGrenade[] = [];
  private readonly flyingSpoons: FlyingSpoon[] = [];
  private readonly explosions: ExplosionVfx[] = [];
  private readonly smokeClouds: SmokeCloud[] = [];
  private readonly thermiteZones: ThermiteZone[] = [];
  private nextSmokeCloudId = 1;

  // Shared pooled geometries/materials for VFX
  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];
  private readonly geoCore: THREE.SphereGeometry;
  private readonly geoRing: THREE.RingGeometry;
  private readonly geoSpark: THREE.BoxGeometry;
  private readonly geoSmokePuff: THREE.IcosahedronGeometry;
  private readonly geoEmberPool: THREE.CylinderGeometry;
  private readonly geoSpoonProp: THREE.BoxGeometry;
  private readonly matSpoonProp: THREE.MeshStandardMaterial;

  // 4-stage held grenade Manual of Arms FSM
  private holdStage: GrenadeHoldStage = 'HOLSTERED';
  private heldEquipmentId: TacticalEquipmentId | null = null;
  private fuseElapsed = 0;
  private actualFuseSec = 4.5;
  private nominalFuseSec = 4.5;
  private heldViewmodelGroup: THREE.Group | null = null;
  private heldViewmodelBuilt: BuiltTacticalEquipmentMesh | null = null;
  private heldViewmodelEquipmentId: TacticalEquipmentId | null = null;
  private viewmodelParentCamera: THREE.Camera | null = null;
  private viewmodelBobTime = 0;
  private pinPullAnim = 0;
  private leverSnapAnim = 0;

  // Pre-allocated scratch buffers (zero-GC)
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpStep = new THREE.Vector3();
  private readonly _tmpNormal = new THREE.Vector3();
  private readonly _normalMat = new THREE.Matrix3();
  private readonly _tmpDetPos = new THREE.Vector3();
  private readonly _segVec = new THREE.Vector3();
  private readonly _toCenter = new THREE.Vector3();
  private readonly _closestPt = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camQuat = new THREE.Quaternion();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _smokeInfoBuf: ActiveSmokeCloudInfo[] = [];

  constructor(opts: TacticalGrenadeSystemOptions) {
    this.scene = opts.scene;
    this.physics = opts.physics;
    this.worldRaycastMeshes = opts.worldRaycastMeshes;
    this.worldBounds = opts.worldBounds ?? { minX: -96, maxX: 96, minZ: -96, maxZ: 96 };
    this.audio = opts.audio;
    this.onDetonate = opts.onDetonate;
    this.onShatterGlass = opts.onShatterGlass;

    this.root.name = 'tactical_grenade_system';
    this.scene.add(this.root);

    this.geoCore = this.trackGeo(new THREE.SphereGeometry(0.45, 14, 12));
    this.geoRing = this.trackGeo(new THREE.RingGeometry(0.28, 0.56, 24));
    this.geoSpark = this.trackGeo(new THREE.BoxGeometry(0.025, 0.025, 0.18));
    this.geoSmokePuff = this.trackGeo(new THREE.IcosahedronGeometry(0.95, 1));
    this.geoEmberPool = this.trackGeo(new THREE.CylinderGeometry(1.15, 1.32, 0.04, 16));
    this.geoSpoonProp = this.trackGeo(new THREE.BoxGeometry(0.008, 0.062, 0.015));
    this.matSpoonProp = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x5c646d,
        roughness: 0.42,
        metalness: 0.82,
      }),
    );
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.sharedGeos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.sharedMats.push(m);
    return m;
  }

  /**
   * Attaches a VIEWMODEL_LAYER foreground mount to the active FPS camera so the held grenade,
   * safety pin removal, and flying spoon are clearly visible during the 4-stage sequence.
   */
  public attachViewmodelCamera(camera: THREE.Camera): void {
    if (this.viewmodelParentCamera === camera && this.heldViewmodelGroup) return;
    this.detachViewmodelCamera();
    this.viewmodelParentCamera = camera;
    this.heldViewmodelGroup = new THREE.Group();
    this.heldViewmodelGroup.name = 'held_grenade_viewmodel';
    this.heldViewmodelGroup.visible = false;
    this.heldViewmodelGroup.layers.set(VIEWMODEL_LAYER);
    camera.add(this.heldViewmodelGroup);
    if (this.heldEquipmentId && this.holdStage !== 'HOLSTERED') {
      this.syncHeldViewmodelMesh(this.heldEquipmentId);
    }
  }

  private detachViewmodelCamera(): void {
    if (this.heldViewmodelBuilt && this.heldViewmodelGroup) {
      this.heldViewmodelGroup.remove(this.heldViewmodelBuilt.group);
      this.heldViewmodelBuilt.dispose();
      this.heldViewmodelBuilt = null;
      this.heldViewmodelEquipmentId = null;
    }
    if (this.heldViewmodelGroup && this.viewmodelParentCamera) {
      this.viewmodelParentCamera.remove(this.heldViewmodelGroup);
    }
    this.heldViewmodelGroup = null;
    this.viewmodelParentCamera = null;
  }

  private syncHeldViewmodelMesh(equipmentId: TacticalEquipmentId): void {
    if (!this.heldViewmodelGroup) return;
    if (this.heldViewmodelEquipmentId !== equipmentId || !this.heldViewmodelBuilt) {
      if (this.heldViewmodelBuilt) {
        this.heldViewmodelGroup.remove(this.heldViewmodelBuilt.group);
        this.heldViewmodelBuilt.dispose();
      }
      this.heldViewmodelBuilt = buildTacticalEquipmentMesh(equipmentId, {
        withBeltClip: false,
        scale: 1.45,
        renderLayer: VIEWMODEL_LAYER,
      });
      this.heldViewmodelEquipmentId = equipmentId;
      this.heldViewmodelGroup.add(this.heldViewmodelBuilt.group);
    }
    const built = this.heldViewmodelBuilt;
    built.pullRingMesh.visible = this.holdStage === 'DRAWN';
    built.spoonGroup.visible = this.holdStage !== 'LEVER_RELEASED';
    this.heldViewmodelGroup.visible = this.holdStage !== 'HOLSTERED';
  }

  public setWorldRaycastMeshes(meshes: THREE.Object3D[]): void {
    this.worldRaycastMeshes = meshes;
  }

  public getHoldStage(): GrenadeHoldStage {
    return this.holdStage;
  }

  public isDrawn(): boolean {
    return this.holdStage !== 'HOLSTERED';
  }

  public isPinPulled(): boolean {
    return this.holdStage === 'PIN_PULLED' || this.holdStage === 'LEVER_RELEASED';
  }

  public isLeverReleased(): boolean {
    return this.holdStage === 'LEVER_RELEASED';
  }

  /** Backward-compatible check: true whenever the player has pulled pin or released lever */
  public isCooking(): boolean {
    return this.holdStage === 'PIN_PULLED' || this.holdStage === 'LEVER_RELEASED';
  }

  /**
   * Returns 0..1 progress of the *nominal* fuse only while the safety lever has been released.
   * Because the real delay has hidden chemical variance, the HUD bar intentionally reflects
   * nominal burn time rather than guaranteeing an exact millisecond detonation!
   */
  public getCookRatio(): number {
    if (this.holdStage !== 'LEVER_RELEASED' || this.nominalFuseSec <= 0.01) return 0;
    return THREE.MathUtils.clamp(this.fuseElapsed / this.nominalFuseSec, 0, 1);
  }

  public getCookingEquipmentId(): TacticalEquipmentId | null {
    return this.holdStage !== 'HOLSTERED' ? this.heldEquipmentId : null;
  }

  /** Stage 1: Pull out / draw grenade into hand (pin intact, lever locked, fuse NOT running). */
  public drawGrenade(equipmentId: TacticalEquipmentId): boolean {
    if (this.holdStage === 'LEVER_RELEASED') return false;
    const def = getTacticalEquipmentDef(equipmentId);
    this.holdStage = 'DRAWN';
    this.heldEquipmentId = def.id;
    this.fuseElapsed = 0;
    this.nominalFuseSec = def.fuseSec;
    this.actualFuseSec = samplePyrotechnicFuseSec(def);
    this.pinPullAnim = 0;
    this.leverSnapAnim = 0;
    this.syncHeldViewmodelMesh(def.id);
    this.audio?.playGearRattle('weapon_swap', 0.58);
    return true;
  }

  /**
   * Stage 2: Pull safety pin (LMB hold).
   * Physically yanks the cotter pin ring — DOES NOT ignite the chemical delay fuse while spoon is gripped!
   */
  public pullPin(equipmentId?: TacticalEquipmentId): boolean {
    const targetId = equipmentId ?? this.heldEquipmentId;
    if (!targetId) return false;
    if (this.holdStage === 'PIN_PULLED' || this.holdStage === 'LEVER_RELEASED') return false;
    const def = getTacticalEquipmentDef(targetId);
    this.heldEquipmentId = def.id;
    this.holdStage = 'PIN_PULLED';
    this.fuseElapsed = 0;
    this.nominalFuseSec = def.fuseSec;
    this.actualFuseSec = samplePyrotechnicFuseSec(def);
    this.pinPullAnim = 1.0;
    this.syncHeldViewmodelMesh(def.id);
    this.audio?.playGrenadePinPull?.();
    return true;
  }

  /**
   * Stage 3: Release safety lever / spoon (RMB while holding LMB after pulling pin).
   * Spring-loaded spoon flies off physically, striker snaps the primer, and the hidden
   * 4.0-5.0s chemical delay fuse begins burning!
   */
  public releaseLever(
    spoonOrigin?: Readonly<THREE.Vector3>,
    spoonRight?: Readonly<THREE.Vector3>,
    spoonUp?: Readonly<THREE.Vector3>,
    spoonFwd?: Readonly<THREE.Vector3>,
  ): boolean {
    if (this.holdStage !== 'PIN_PULLED' || !this.heldEquipmentId) return false;
    const def = getTacticalEquipmentDef(this.heldEquipmentId);
    this.holdStage = 'LEVER_RELEASED';
    this.fuseElapsed = 0;
    this.nominalFuseSec = def.fuseSec;
    this.actualFuseSec = samplePyrotechnicFuseSec(def);
    this.leverSnapAnim = 1.0;
    this.syncHeldViewmodelMesh(def.id);
    this.audio?.playGrenadeLeverSnap?.();
    this.spawnFlyingSpoon(spoonOrigin, spoonRight, spoonUp, spoonFwd);
    return true;
  }

  /**
   * Stage 4: Throw held grenade (LMB release).
   * If still in `PIN_PULLED`, throwing automatically releases the safety lever in mid-air
   * with spoon fly-off + primer snap and full pyrotechnic delay.
   */
  public throwHeldGrenade(
    origin: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    inheritedVel?: Readonly<THREE.Vector3>,
    forceEquipmentId?: TacticalEquipmentId,
  ): boolean {
    const id = forceEquipmentId ?? this.heldEquipmentId;
    if (!id) return false;
    const def = getTacticalEquipmentDef(id);

    let remainingFuse: number;
    if (this.holdStage === 'LEVER_RELEASED') {
      remainingFuse = Math.max(0.08, this.actualFuseSec - this.fuseElapsed);
    } else {
      // Safety lever releases automatically upon throw -> spoon pings off & ignites full delay
      remainingFuse = samplePyrotechnicFuseSec(def);
      this.audio?.playGrenadeLeverSnap?.();
      this.spawnFlyingSpoon(origin, undefined, undefined, forward);
    }

    this.holdStage = 'HOLSTERED';
    this.heldEquipmentId = null;
    this.fuseElapsed = 0;
    if (this.heldViewmodelGroup) {
      this.heldViewmodelGroup.visible = false;
    }

    this.spawnProjectile(def, origin, forward, inheritedVel, remainingFuse);
    return true;
  }

  /**
   * Called when player switches weapons or cancels grenade:
   *  - If in `DRAWN` or `PIN_PULLED` (spoon never released): safely re-pins & holsters (0 grenades spent).
   *  - If in `LEVER_RELEASED` (live burning fuse!): immediately tosses the live grenade clear (returns 'tossed').
   */
  public holsterOrTossOnSwitch(
    origin: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    inheritedVel?: Readonly<THREE.Vector3>,
  ): 'holstered' | 'tossed' | 'none' {
    if (this.holdStage === 'HOLSTERED') return 'none';
    if (this.holdStage === 'LEVER_RELEASED') {
      this.throwHeldGrenade(origin, forward, inheritedVel);
      return 'tossed';
    }
    this.cancelCook();
    return 'holstered';
  }

  /** Backward-compatible helper: pulls pin directly (or draws + pulls pin). */
  public beginCook(equipmentId: TacticalEquipmentId): boolean {
    return this.pullPin(equipmentId);
  }

  public cancelCook(): void {
    this.holdStage = 'HOLSTERED';
    this.heldEquipmentId = null;
    this.fuseElapsed = 0;
    if (this.heldViewmodelGroup) {
      this.heldViewmodelGroup.visible = false;
    }
  }

  /** Backward-compatible throw alias. */
  public releaseThrow(
    origin: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    inheritedVel?: Readonly<THREE.Vector3>,
    forceEquipmentId?: TacticalEquipmentId,
  ): boolean {
    return this.throwHeldGrenade(origin, forward, inheritedVel, forceEquipmentId);
  }

  private spawnFlyingSpoon(
    origin?: Readonly<THREE.Vector3>,
    right?: Readonly<THREE.Vector3>,
    up?: Readonly<THREE.Vector3>,
    fwd?: Readonly<THREE.Vector3>,
  ): void {
    if (!origin && this.viewmodelParentCamera) {
      this.viewmodelParentCamera.getWorldPosition(this._camPos);
      this.viewmodelParentCamera.getWorldQuaternion(this._camQuat);
      this._camRight.set(1, 0, 0).applyQuaternion(this._camQuat).normalize();
      this._camUp.set(0, 1, 0).applyQuaternion(this._camQuat).normalize();
      this._camFwd.set(0, 0, -1).applyQuaternion(this._camQuat).normalize();
    } else if (origin) {
      this._camPos.copy(origin);
      this._camFwd.copy(fwd ?? new THREE.Vector3(0, 0, -1)).normalize();
      this._camUp.copy(up ?? new THREE.Vector3(0, 1, 0)).normalize();
      this._camRight.copy(right ?? new THREE.Vector3().crossVectors(this._camFwd, this._camUp).normalize());
    } else {
      return;
    }

    const mesh = new THREE.Mesh(this.geoSpoonProp, this.matSpoonProp);
    mesh.position
      .copy(this._camPos)
      .addScaledVector(this._camFwd, 0.34)
      .addScaledVector(this._camRight, 0.14)
      .addScaledVector(this._camUp, -0.08);
    this.root.add(mesh);

    const vel = new THREE.Vector3()
      .addScaledVector(this._camRight, 2.2 + Math.random() * 1.1)
      .addScaledVector(this._camUp, 2.4 + Math.random() * 0.9)
      .addScaledVector(this._camFwd, 1.3 + Math.random() * 0.8);

    this.flyingSpoons.push({
      mesh,
      vel,
      rotVel: new THREE.Vector3(16 + Math.random() * 10, -14, 22),
      age: 0,
      maxAge: 1.15,
    });
  }

  private spawnProjectile(
    def: TacticalEquipmentDef,
    origin: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    inheritedVel: Readonly<THREE.Vector3> | undefined,
    fuseSec: number,
  ): void {
    const built = buildTacticalEquipmentMesh(def.id, { withBeltClip: false, scale: 1.05 });
    // Thrown grenade has pin & safety lever already detached
    built.pullRingMesh.visible = false;
    built.spoonGroup.visible = false;

    const startPos = origin.clone().addScaledVector(forward, 0.42);
    built.group.position.copy(startPos);
    built.group.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    this.root.add(built.group);

    // Slight upward tactical lob arc
    const vel = forward.clone().normalize().multiplyScalar(def.throwSpeedMps);
    vel.y += 2.65;
    if (inheritedVel) {
      vel.x += inheritedVel.x * 0.42;
      vel.y += Math.max(0, inheritedVel.y) * 0.25;
      vel.z += inheritedVel.z * 0.42;
    }

    this.activeGrenades.push({
      equipmentId: def.id,
      def,
      built,
      pos: startPos,
      vel,
      rotVel: new THREE.Vector3(
        (Math.random() - 0.5) * 14 + 6,
        (Math.random() - 0.5) * 11,
        (Math.random() - 0.5) * 13,
      ),
      fuseLeft: fuseSec,
      age: 0,
      bounces: 0,
      resting: false,
    });
  }

  /**
   * Checks whether solid world geometry blocks line-of-sight between `blastPos` and `targetPos`.
   */
  public hasClearBlastLine(
    blastPos: Readonly<THREE.Vector3>,
    targetPos: Readonly<THREE.Vector3>,
  ): boolean {
    this._tmpDir.subVectors(targetPos, blastPos);
    const dist = this._tmpDir.length();
    if (dist < 0.35) return true;
    this._tmpDir.divideScalar(dist);

    this._raycaster.set(blastPos, this._tmpDir);
    this._raycaster.near = 0.14;
    this._raycaster.far = dist - 0.22;
    const hits = this._raycaster.intersectObjects(this.worldRaycastMeshes, false);
    for (let i = 0; i < hits.length; i++) {
      const obj = hits[i].object;
      if (obj.userData?.breakableGlass) continue;
      if (obj.userData?.surfaceMaterial === 'water') continue;
      return false;
    }
    return true;
  }

  /**
   * Evaluates realistic M67 fragmentation + overpressure damage at `targetPos`:
   *  - 0..5.0m (lethal core): intense blast overpressure + saturated high-velocity shrapnel matrix
   *  - 5.0..15.0m (casualty zone): rapidly dispersing steel fragmentation shards (blocked by hard cover)
   *  - 15.0..26.0m (stray shrapnel): sparse lethal-velocity fragments in open sightlines
   */
  public evaluateFragDamageAt(
    detPos: Readonly<THREE.Vector3>,
    targetPos: Readonly<THREE.Vector3>,
    def: TacticalEquipmentDef,
  ): { damage: number; shardHits: number; occluded: boolean } {
    const dist = detPos.distanceTo(targetPos);
    const outerStrayM = Math.max(def.blastRadiusM + 9.0, 24.0);
    if (dist > outerStrayM) return { damage: 0, shardHits: 0, occluded: false };

    const clear = this.hasClearBlastLine(detPos, targetPos);
    if (!clear) {
      // Hard cover stops steel fragments; only intense close-range overpressure leaks around edges (<3.2m)
      if (dist < 3.2) {
        const leak = (1 - dist / 3.2) * 28;
        return { damage: leak, shardHits: 0, occluded: true };
      }
      return { damage: 0, shardHits: 0, occluded: true };
    }

    const lethalR = Math.max(3.5, def.lethalRadiusM || 5.0);
    const casualtyR = Math.max(lethalR + 4.0, def.blastRadiusM || 15.0);

    if (dist <= lethalR) {
      // High-density fragment core + blast wave
      const t = dist / lethalR;
      const blastDmg = def.maxDamage * THREE.MathUtils.lerp(1.0, 0.62, t * t);
      const shardHits = Math.max(2, Math.round(THREE.MathUtils.lerp(7, 3, t)));
      return { damage: blastDmg, shardHits, occluded: false };
    }

    if (dist <= casualtyR) {
      // Casualty radius: 1/r^2 fragment density decay with realistic multi-shard wound profile
      const t = (dist - lethalR) / Math.max(1.0, casualtyR - lethalR);
      const baseDmg = THREE.MathUtils.lerp(108, 22, Math.pow(t, 0.85));
      const shardHits = Math.max(1, Math.round(THREE.MathUtils.lerp(3, 1, t)));
      return { damage: baseDmg, shardHits, occluded: false };
    }

    // Stray open-terrain shrapnel beyond 15m (occasional single fragment wound)
    const strayT = (dist - casualtyR) / Math.max(1.0, outerStrayM - casualtyR);
    const strayProb = (1 - strayT) * 0.45;
    if (Math.random() < strayProb) {
      return { damage: THREE.MathUtils.lerp(24, 10, strayT), shardHits: 1, occluded: false };
    }
    return { damage: 0, shardHits: 0, occluded: false };
  }

  /**
   * Computes realistic M84 flashbang sensor/retinal overload intensity for the player's bodycam.
   * Accounts for distance, facing dot-product (looking away reduces flash but concussion remains),
   * and solid-wall LOS occlusion.
   */
  public computeFlashbangExposure(
    detPos: Readonly<THREE.Vector3>,
    camPos: Readonly<THREE.Vector3>,
    camFwd: Readonly<THREE.Vector3>,
    maxRadiusM = 16.0,
  ): FlashbangExposureResult {
    const distM = detPos.distanceTo(camPos);
    if (distM > maxRadiusM) {
      return { intensity: 0, lookFactor: 0, distM, occluded: false };
    }
    const clear = this.hasClearBlastLine(detPos, camPos);
    if (!clear) {
      // Behind solid wall: minimal acoustic rattle only if very close
      const wallLeak = distM < 4.5 ? (1 - distM / 4.5) * 0.12 : 0;
      return { intensity: wallLeak, lookFactor: 0, distM, occluded: true };
    }

    this._tmpDir.subVectors(detPos, camPos).normalize();
    const dot = THREE.MathUtils.clamp(camFwd.dot(this._tmpDir), -1, 1);
    // Looking directly at flash -> 1.0; looking completely away -> still ~0.34 room bounce & concussion
    const lookFactor = THREE.MathUtils.lerp(0.34, 1.0, THREE.MathUtils.smoothstep(dot, -0.25, 0.72));
    const distFactor = Math.pow(THREE.MathUtils.clamp(1 - distM / maxRadiusM, 0, 1), 0.72);
    const closeCoreBonus = distM < 4.5 ? 0.28 * (1 - distM / 4.5) : 0;
    const intensity = THREE.MathUtils.clamp(distFactor * lookFactor + closeCoreBonus, 0, 1);

    return { intensity, lookFactor, distM, occluded: false };
  }

  /**
   * Fast ray-sphere segment test for AI vision occlusion through active deployed M18 smoke screens.
   */
  public isLineBlockedBySmoke(
    a: Readonly<THREE.Vector3>,
    b: Readonly<THREE.Vector3>,
  ): boolean {
    if (this.smokeClouds.length === 0) return false;
    this._segVec.subVectors(b, a);
    const segLenSq = this._segVec.lengthSq();
    if (segLenSq < 1e-5) return false;

    for (let i = 0; i < this.smokeClouds.length; i++) {
      const cloud = this.smokeClouds[i];
      if (!cloud.isScreeningSmoke) continue;
      // Cloud becomes opaque enough to block vision after 0.35s bloom and until final 1.6s dissipation
      if (cloud.age < 0.35 || cloud.age > cloud.duration - 1.6) continue;
      const bloomFrac = Math.min(1, cloud.age / 1.45);
      const r = cloud.effectiveRadiusM * (0.45 + 0.55 * bloomFrac);

      // Sphere center slightly elevated above canister resting point (chest/eye height)
      this._toCenter.set(cloud.origin.x - a.x, cloud.origin.y + 1.45 - a.y, cloud.origin.z - a.z);
      const t = THREE.MathUtils.clamp(this._toCenter.dot(this._segVec) / segLenSq, 0, 1);
      this._closestPt.copy(a).addScaledVector(this._segVec, t);
      const dx = this._closestPt.x - cloud.origin.x;
      const dy = this._closestPt.y - (cloud.origin.y + 1.45);
      const dz = this._closestPt.z - cloud.origin.z;
      if (dx * dx + dy * dy + dz * dz <= r * r) {
        return true;
      }
    }
    return false;
  }

  /**
   * Exposes active screening smoke plumes so BattleBotAI can detect smoke deployment
   * and tactically adapt (flank around smoke, hold perimeter, or suppress last-known area).
   */
  public getActiveSmokeClouds(): readonly ActiveSmokeCloudInfo[] {
    this._smokeInfoBuf.length = 0;
    for (let i = 0; i < this.smokeClouds.length; i++) {
      const c = this.smokeClouds[i];
      if (!c.isScreeningSmoke || c.age > c.duration - 1.2) continue;
      const bloomFrac = Math.min(1, c.age / 1.45);
      this._smokeInfoBuf.push({
        id: c.id,
        position: c.origin,
        radiusM: c.effectiveRadiusM * (0.45 + 0.55 * bloomFrac),
        age: c.age,
        duration: c.duration,
        isScreeningSmoke: true,
      });
    }
    return this._smokeInfoBuf;
  }

  /**
   * Advances burning fuse (ONLY in LEVER_RELEASED stage), held viewmodel animation,
   * flying spoons, projectile trajectories, explosions, smoke plumes, and thermite zones.
   */
  public update(dt: number, cookOvercookOrigin?: Readonly<THREE.Vector3>): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    this.viewmodelBobTime += clampedDt;

    // 0. Animate held first-person grenade viewmodel on VIEWMODEL_LAYER
    if (this.heldViewmodelGroup && this.heldViewmodelGroup.visible) {
      this.pinPullAnim = Math.max(0, this.pinPullAnim - clampedDt * 5.2);
      this.leverSnapAnim = Math.max(0, this.leverSnapAnim - clampedDt * 6.4);
      const bobX = Math.sin(this.viewmodelBobTime * 2.1) * 0.004;
      const bobY = Math.cos(this.viewmodelBobTime * 4.2) * 0.003;
      const windupZ = this.holdStage === 'PIN_PULLED' ? 0.045 : this.holdStage === 'LEVER_RELEASED' ? 0.068 : 0;
      const windupY = this.holdStage === 'LEVER_RELEASED' ? 0.025 : this.holdStage === 'PIN_PULLED' ? 0.012 : 0;
      // Subtle tension tremor when live fuse is actively burning in hand!
      const liveTremor =
        this.holdStage === 'LEVER_RELEASED'
          ? (Math.sin(this.viewmodelBobTime * 38) * 0.0018 + Math.cos(this.viewmodelBobTime * 53) * 0.0014) *
            (0.4 + this.getCookRatio() * 0.9)
          : 0;

      this.heldViewmodelGroup.position.set(
        0.165 + bobX + liveTremor - this.pinPullAnim * 0.02,
        -0.145 + bobY + windupY + this.leverSnapAnim * 0.018,
        -0.34 + windupZ,
      );
      this.heldViewmodelGroup.rotation.set(
        0.18 + windupY * 2.4 + this.leverSnapAnim * 0.28,
        -0.38 - this.pinPullAnim * 0.32,
        0.16 + liveTremor * 14,
      );
    }

    // 1. Step live chemical delay fuse ONLY when safety lever/spoon has been released
    if (this.holdStage === 'LEVER_RELEASED' && this.heldEquipmentId) {
      const def = getTacticalEquipmentDef(this.heldEquipmentId);
      this.fuseElapsed += clampedDt;
      if (this.fuseElapsed >= this.actualFuseSec) {
        const detPos = cookOvercookOrigin
          ? this._tmpDetPos.copy(cookOvercookOrigin)
          : this._tmpDetPos.set(0, 1.4, 0);
        this.holdStage = 'HOLSTERED';
        this.heldEquipmentId = null;
        this.fuseElapsed = 0;
        if (this.heldViewmodelGroup) {
          this.heldViewmodelGroup.visible = false;
        }
        this.detonateAt(def, detPos.clone());
      }
    }

    // 1b. Step flying safety spoons
    for (let i = this.flyingSpoons.length - 1; i >= 0; i--) {
      const sp = this.flyingSpoons[i];
      sp.age += clampedDt;
      sp.vel.y -= GRAVITY_MPS2 * clampedDt;
      sp.mesh.position.addScaledVector(sp.vel, clampedDt);
      sp.mesh.rotation.x += sp.rotVel.x * clampedDt;
      sp.mesh.rotation.y += sp.rotVel.y * clampedDt;
      sp.mesh.rotation.z += sp.rotVel.z * clampedDt;
      if (sp.age >= sp.maxAge) {
        this.root.remove(sp.mesh);
        this.flyingSpoons.splice(i, 1);
      }
    }

    // 2. Step flying / bouncing projectiles
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i];
      g.age += clampedDt;
      g.fuseLeft -= clampedDt;

      if (!g.resting) {
        g.vel.y -= GRAVITY_MPS2 * clampedDt;
        const airDamp = Math.exp(-0.22 * clampedDt);
        g.vel.multiplyScalar(airDamp);

        this._tmpStep.copy(g.vel).multiplyScalar(clampedDt);
        const stepDist = this._tmpStep.length();

        if (stepDist > 1e-4) {
          this._tmpDir.copy(this._tmpStep).divideScalar(stepDist);
          this._raycaster.set(g.pos, this._tmpDir);
          this._raycaster.near = 0;
          this._raycaster.far = stepDist + GRENADE_RADIUS_M;

          const hits = this._raycaster.intersectObjects(this.worldRaycastMeshes, false);
          if (hits.length > 0) {
            const hit = hits[0];
            if (hit.object.userData?.breakableGlass && !hit.object.userData.shattered && this.onShatterGlass) {
              this.onShatterGlass(hit.object, hit.point, this._tmpDir);
              g.vel.multiplyScalar(0.72);
              g.pos.add(this._tmpStep);
            } else {
              if (hit.face) {
                this._normalMat.getNormalMatrix(hit.object.matrixWorld);
                this._tmpNormal.copy(hit.face.normal).applyMatrix3(this._normalMat).normalize();
              } else {
                this._tmpNormal.set(0, 1, 0);
              }
              if (this._tmpNormal.dot(this._tmpDir) > 0) {
                this._tmpNormal.negate();
              }

              g.pos.copy(hit.point).addScaledVector(this._tmpNormal, GRENADE_RADIUS_M + 0.006);

              const impactSpeed = g.vel.length();
              if (impactSpeed > 1.35) {
                this.audio?.playGrenadeBounce?.(g.pos, impactSpeed);
              }

              const vn = g.vel.dot(this._tmpNormal);
              const restitution = Math.abs(this._tmpNormal.y) > 0.65 ? 0.34 : 0.44;
              g.vel.addScaledVector(this._tmpNormal, -(1 + restitution) * vn);
              g.vel.multiplyScalar(Math.abs(this._tmpNormal.y) > 0.65 ? 0.72 : 0.84);
              g.rotVel.multiplyScalar(0.68);
              g.bounces += 1;

              if (Math.abs(this._tmpNormal.y) > 0.7 && g.vel.lengthSq() < 0.16) {
                g.vel.set(0, 0, 0);
                g.rotVel.set(0, 0, 0);
                g.resting = true;
              }
            }
          } else {
            g.pos.add(this._tmpStep);
          }
        }

        const floorY = this.physics.getGroundHeight(g.pos.x, g.pos.z, g.pos.y + 0.25);
        if (g.pos.y < floorY + GRENADE_RADIUS_M) {
          g.pos.y = floorY + GRENADE_RADIUS_M;
          if (g.vel.y < -1.1) {
            this.audio?.playGrenadeBounce?.(g.pos, Math.abs(g.vel.y));
          }
          g.vel.y = Math.abs(g.vel.y) * 0.32;
          g.vel.x *= 0.7;
          g.vel.z *= 0.7;
          g.rotVel.multiplyScalar(0.65);
          if (g.vel.lengthSq() < 0.14) {
            g.vel.set(0, 0, 0);
            g.rotVel.set(0, 0, 0);
            g.resting = true;
          }
        }

        g.pos.x = THREE.MathUtils.clamp(
          g.pos.x,
          this.worldBounds.minX + 0.2,
          this.worldBounds.maxX - 0.2,
        );
        g.pos.z = THREE.MathUtils.clamp(
          g.pos.z,
          this.worldBounds.minZ + 0.2,
          this.worldBounds.maxZ - 0.2,
        );

        g.built.group.position.copy(g.pos);
        g.built.group.rotation.x += g.rotVel.x * clampedDt;
        g.built.group.rotation.y += g.rotVel.y * clampedDt;
        g.built.group.rotation.z += g.rotVel.z * clampedDt;
      }

      if (g.fuseLeft <= 0) {
        const detPos = g.pos.clone();
        const def = g.def;
        this.root.remove(g.built.group);
        g.built.dispose();
        this.activeGrenades.splice(i, 1);
        this.detonateAt(def, detPos);
      }
    }

    // 3. Step Explosion VFX
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const fx = this.explosions[i];
      fx.age += clampedDt;
      const t = Math.min(1, fx.age / fx.maxAge);

      fx.light.intensity = fx.peakIntensity * Math.pow(1 - t, 2.4);

      const coreScale = THREE.MathUtils.lerp(0.25, fx.maxCoreScale, Math.pow(t, 0.35));
      fx.coreMesh.scale.setScalar(coreScale);
      const coreMat = fx.coreMesh.material as THREE.MeshBasicMaterial;
      coreMat.opacity = Math.max(0, (1 - t) * (1 - t) * 0.92);

      const ringScale = THREE.MathUtils.lerp(0.3, fx.maxRingScale, Math.pow(t, 0.45));
      fx.ringMesh.scale.setScalar(ringScale);
      const ringMat = fx.ringMesh.material as THREE.MeshBasicMaterial;
      ringMat.opacity = Math.max(0, (1 - t) * 0.72);

      for (let s = 0; s < fx.sparks.length; s++) {
        const sp = fx.sparks[s];
        sp.vel.y -= 13.0 * clampedDt;
        sp.mesh.position.addScaledVector(sp.vel, clampedDt);
        const sm = sp.mesh.material as THREE.MeshBasicMaterial;
        sm.opacity = Math.max(0, 1 - t * 1.15);
      }

      if (fx.age >= fx.maxAge) {
        this.disposeExplosionVfx(fx);
        this.explosions.splice(i, 1);
      }
    }

    // 4. Step Smoke Clouds
    for (let i = this.smokeClouds.length - 1; i >= 0; i--) {
      const cloud = this.smokeClouds[i];
      cloud.age += clampedDt;
      const bloomT = Math.min(1, cloud.age / 1.45);
      const fadeOutT =
        cloud.age > cloud.duration - 2.6
          ? Math.max(0, (cloud.duration - cloud.age) / 2.6)
          : 1.0;

      for (let p = 0; p < cloud.puffs.length; p++) {
        const pf = cloud.puffs[p];
        const easeBloom = 1 - Math.pow(1 - bloomT, 3);
        pf.mesh.position.set(
          pf.targetPos.x * easeBloom + Math.sin(cloud.age * 0.7 + pf.phase) * 0.24,
          pf.targetPos.y * easeBloom + cloud.age * pf.driftSpeed,
          pf.targetPos.z * easeBloom + Math.cos(cloud.age * 0.65 + pf.phase) * 0.24,
        );
        const s = pf.targetScale * (0.28 + 0.72 * easeBloom) * (0.85 + 0.15 * fadeOutT);
        pf.mesh.scale.setScalar(s);
        pf.mesh.rotation.y += clampedDt * 0.18;
        pf.mat.opacity = (cloud.isScreeningSmoke ? 0.76 : 0.5) * Math.min(1, bloomT * 1.4) * fadeOutT;
      }

      if (cloud.age >= cloud.duration) {
        this.root.remove(cloud.group);
        for (const pf of cloud.puffs) pf.mat.dispose();
        this.smokeClouds.splice(i, 1);
      }
    }

    // 5. Step Thermite Incendiary Zones
    for (let i = this.thermiteZones.length - 1; i >= 0; i--) {
      const tz = this.thermiteZones[i];
      tz.age += clampedDt;
      tz.tickAccum += clampedDt;

      const fade =
        tz.age > tz.duration - 1.2
          ? Math.max(0, (tz.duration - tz.age) / 1.2)
          : Math.min(1, tz.age / 0.25);
      const flicker = 0.8 + Math.sin(tz.age * 29) * 0.14 + Math.cos(tz.age * 43) * 0.1;
      tz.light.intensity = 10.5 * fade * flicker;
      tz.emberMat.opacity = 0.82 * fade;
      tz.emberMat.emissiveIntensity = 2.6 * fade * flicker;

      for (let s = 0; s < tz.sparks.length; s++) {
        const sp = tz.sparks[s];
        sp.life += clampedDt;
        if (sp.life >= sp.maxLife) {
          sp.life = 0;
          sp.maxLife = 0.35 + Math.random() * 0.45;
          const ang = Math.random() * Math.PI * 2;
          const rad = Math.random() * 1.1;
          sp.mesh.position.set(Math.cos(ang) * rad, 0.08, Math.sin(ang) * rad);
          sp.vel.set(
            (Math.random() - 0.5) * 2.2,
            2.4 + Math.random() * 3.4,
            (Math.random() - 0.5) * 2.2,
          );
        } else {
          sp.vel.y -= 7.5 * clampedDt;
          sp.mesh.position.addScaledVector(sp.vel, clampedDt);
          sp.mesh.visible = fade > 0.12;
        }
      }

      if (tz.tickAccum >= 0.35) {
        const tickDt = tz.tickAccum;
        tz.tickAccum = 0;
        this.onDetonate?.({
          equipmentId: tz.equipmentId,
          def: tz.def,
          kind: 'thermite',
          position: tz.pos.clone(),
          radiusM: tz.def.blastRadiusM,
          lethalRadiusM: tz.def.lethalRadiusM,
          maxDamage: tz.def.maxDamage * tickDt,
          isTick: true,
          tickDtSec: tickDt,
        });
      }

      if (tz.age >= tz.duration) {
        this.root.remove(tz.group);
        tz.emberMat.dispose();
        for (const sp of tz.sparks) {
          (sp.mesh.material as THREE.Material).dispose();
        }
        this.thermiteZones.splice(i, 1);
      }
    }
  }

  /**
   * Casts 44 spherical high-velocity fragmentation shard rays outward from an M67 detonation,
   * shattering breakable glass panes along fragment paths.
   */
  private castFragShardMatrix(pos: Readonly<THREE.Vector3>, maxRangeM: number): void {
    const rayCount = 44;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const origin = this._tmpDetPos.copy(pos);
    origin.y += 0.16;

    for (let i = 0; i < rayCount; i++) {
      // Bias slightly into the upper hemisphere (-0.25 to +0.85) so fragments sweep standing/crouched cover
      const y = -0.22 + (i / (rayCount - 1)) * 1.04;
      const r = Math.sqrt(Math.max(0.001, 1 - y * y));
      const theta = goldenAngle * i + (Math.random() - 0.5) * 0.18;
      this._tmpDir.set(Math.cos(theta) * r, y, Math.sin(theta) * r).normalize();

      this._raycaster.set(origin, this._tmpDir);
      this._raycaster.near = 0.12;
      this._raycaster.far = maxRangeM;

      const hits = this._raycaster.intersectObjects(this.worldRaycastMeshes, false);
      for (let h = 0; h < hits.length; h++) {
        const hit = hits[h];
        if (hit.object.userData?.breakableGlass && !hit.object.userData.shattered && this.onShatterGlass) {
          this.onShatterGlass(hit.object, hit.point, this._tmpDir);
          continue; // Shrapnel punches straight through glass
        }
        break; // Hard cover stops this shard ray
      }
    }
  }

  private detonateAt(def: TacticalEquipmentDef, pos: THREE.Vector3): void {
    const kind = resolveEffectKind(def.id);
    this.audio?.playExplosion?.(pos, kind);

    if (kind === 'frag') {
      this.spawnExplosionVfx(pos, 0xff9b32, 0xffd27a, 28, 3.6, 8.2, 0.56, 26);
      this.spawnMiniBlastSmoke(pos);
      this.castFragShardMatrix(pos, Math.max(18, def.blastRadiusM));
    } else if (kind === 'flash') {
      this.spawnExplosionVfx(pos, 0xf2f9ff, 0x9ad8ff, 52, 2.8, 7.6, 0.36, 10);
    } else if (kind === 'smoke') {
      this.spawnSmokeCloud(pos, def.effectDurationSec, def.blastRadiusM);
    } else {
      this.spawnExplosionVfx(pos, 0xff6b1a, 0xffb347, 16, 1.9, 3.8, 0.42, 14);
      this.spawnThermiteZone(def, pos);
    }

    this.onDetonate?.({
      equipmentId: def.id,
      def,
      kind,
      position: pos,
      radiusM: def.blastRadiusM,
      lethalRadiusM: def.lethalRadiusM,
      maxDamage: kind === 'thermite' ? def.maxDamage * 0.45 : def.maxDamage,
      isTick: false,
    });
  }

  private spawnExplosionVfx(
    pos: Readonly<THREE.Vector3>,
    coreHex: number,
    sparkHex: number,
    peakIntensity: number,
    maxCoreScale: number,
    maxRingScale: number,
    maxAge: number,
    sparkCount: number,
  ): void {
    const group = new THREE.Group();
    group.position.copy(pos);
    group.position.y += 0.14;

    const light = new THREE.PointLight(coreHex, peakIntensity, 18, 1.6);
    group.add(light);

    const coreMat = new THREE.MeshBasicMaterial({
      color: coreHex,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    const coreMesh = new THREE.Mesh(this.geoCore, coreMat);
    group.add(coreMesh);

    const ringMat = new THREE.MeshBasicMaterial({
      color: sparkHex,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ringMesh = new THREE.Mesh(this.geoRing, ringMat);
    ringMesh.rotation.x = -Math.PI * 0.5;
    ringMesh.position.y = 0.05;
    group.add(ringMesh);

    const sparks: Array<{ mesh: THREE.Mesh; vel: THREE.Vector3 }> = [];
    for (let i = 0; i < sparkCount; i++) {
      const sMat = new THREE.MeshBasicMaterial({
        color: sparkHex,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geoSpark, sMat);
      const ang = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 6.0 + Math.random() * 11.5;
      const vel = new THREE.Vector3(
        Math.cos(ang) * spd,
        2.2 + Math.random() * 7.5,
        Math.sin(ang) * spd,
      );
      mesh.lookAt(vel);
      group.add(mesh);
      sparks.push({ mesh, vel });
    }

    this.root.add(group);
    this.explosions.push({
      group,
      light,
      coreMesh,
      ringMesh,
      sparks,
      age: 0,
      maxAge,
      peakIntensity,
      maxCoreScale,
      maxRingScale,
    });
  }

  private spawnMiniBlastSmoke(pos: Readonly<THREE.Vector3>): void {
    const group = new THREE.Group();
    group.position.copy(pos);
    const puffs: SmokeCloud['puffs'] = [];

    for (let i = 0; i < 5; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2a2d30,
        roughness: 0.96,
        metalness: 0,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geoSmokePuff, mat);
      const ang = (i / 5) * Math.PI * 2;
      group.add(mesh);
      puffs.push({
        mesh,
        mat,
        targetPos: new THREE.Vector3(Math.cos(ang) * 0.9, 0.8 + i * 0.25, Math.sin(ang) * 0.9),
        targetScale: 1.05 + Math.random() * 0.5,
        driftSpeed: 0.35 + Math.random() * 0.2,
        phase: Math.random() * Math.PI * 2,
      });
    }

    this.root.add(group);
    this.smokeClouds.push({
      id: this.nextSmokeCloudId++,
      origin: pos.clone(),
      effectiveRadiusM: 1.8,
      isScreeningSmoke: false,
      group,
      puffs,
      age: 0,
      duration: 3.4,
    });
  }

  private spawnSmokeCloud(pos: Readonly<THREE.Vector3>, duration: number, blastRadiusM = 7.5): void {
    const group = new THREE.Group();
    group.position.copy(pos);
    const puffs: SmokeCloud['puffs'] = [];

    const puffCount = 15;
    for (let i = 0; i < puffCount; i++) {
      const shade = 0x8a929b + (i % 3) * 0x0b0c0d;
      const mat = new THREE.MeshStandardMaterial({
        color: shade,
        roughness: 0.95,
        metalness: 0,
        transparent: true,
        opacity: 0.01,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geoSmokePuff, mat);
      const ring = i < 5 ? 0.95 : i < 11 ? 2.45 : 1.55;
      const ang = (i / puffCount) * Math.PI * 2 * 1.7 + Math.random() * 0.35;
      const yOff = i < 5 ? 1.15 : i < 11 ? 1.55 + Math.random() * 0.65 : 2.65 + Math.random() * 0.55;
      group.add(mesh);
      puffs.push({
        mesh,
        mat,
        targetPos: new THREE.Vector3(Math.cos(ang) * ring, yOff, Math.sin(ang) * ring),
        targetScale: 1.95 + Math.random() * 0.9,
        driftSpeed: 0.045 + Math.random() * 0.03,
        phase: Math.random() * Math.PI * 2,
      });
    }

    this.root.add(group);
    this.smokeClouds.push({
      id: this.nextSmokeCloudId++,
      origin: pos.clone(),
      effectiveRadiusM: Math.max(3.8, blastRadiusM * 0.58),
      isScreeningSmoke: true,
      group,
      puffs,
      age: 0,
      duration,
    });
  }

  private spawnThermiteZone(def: TacticalEquipmentDef, pos: THREE.Vector3): void {
    const floorY = this.physics.getGroundHeight(pos.x, pos.z, pos.y + 0.35);
    const grounded = new THREE.Vector3(pos.x, floorY + 0.03, pos.z);

    const group = new THREE.Group();
    group.position.copy(grounded);

    const emberMat = new THREE.MeshStandardMaterial({
      color: 0xff5a12,
      emissive: new THREE.Color(0xff6b1a),
      emissiveIntensity: 2.5,
      roughness: 0.7,
      metalness: 0.1,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const poolMesh = new THREE.Mesh(this.geoEmberPool, emberMat);
    group.add(poolMesh);

    const light = new THREE.PointLight(0xff7426, 10, 11, 1.7);
    light.position.set(0, 0.45, 0);
    group.add(light);

    const sparks: ThermiteZone['sparks'] = [];
    for (let i = 0; i < 10; i++) {
      const sm = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xfff0b3 : 0xff8533,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geoSpark, sm);
      mesh.scale.set(0.7, 0.7, 0.7);
      group.add(mesh);
      sparks.push({
        mesh,
        vel: new THREE.Vector3(0, 3, 0),
        life: Math.random() * 0.4,
        maxLife: 0.35 + Math.random() * 0.45,
      });
    }

    this.root.add(group);
    this.thermiteZones.push({
      equipmentId: def.id,
      def,
      pos: grounded,
      group,
      light,
      emberMat,
      sparks,
      age: 0,
      duration: def.effectDurationSec,
      tickAccum: 0,
    });
  }

  private disposeExplosionVfx(fx: ExplosionVfx): void {
    this.root.remove(fx.group);
    (fx.coreMesh.material as THREE.Material).dispose();
    (fx.ringMesh.material as THREE.Material).dispose();
    for (const sp of fx.sparks) {
      (sp.mesh.material as THREE.Material).dispose();
    }
  }

  public dispose(): void {
    this.detachViewmodelCamera();

    for (const g of this.activeGrenades) {
      this.root.remove(g.built.group);
      g.built.dispose();
    }
    this.activeGrenades.length = 0;

    for (const sp of this.flyingSpoons) {
      this.root.remove(sp.mesh);
    }
    this.flyingSpoons.length = 0;

    for (const fx of this.explosions) {
      this.disposeExplosionVfx(fx);
    }
    this.explosions.length = 0;

    for (const c of this.smokeClouds) {
      this.root.remove(c.group);
      for (const pf of c.puffs) pf.mat.dispose();
    }
    this.smokeClouds.length = 0;

    for (const tz of this.thermiteZones) {
      this.root.remove(tz.group);
      tz.emberMat.dispose();
      for (const sp of tz.sparks) (sp.mesh.material as THREE.Material).dispose();
    }
    this.thermiteZones.length = 0;

    this.scene.remove(this.root);
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
  }
}

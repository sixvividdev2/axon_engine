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

export interface GrenadeRemoteAttribution {
  isRemote?: boolean;
  sourceId?: string;
  sourceName?: string;
  sourceTeam?: 'A' | 'B' | 'FFA';
  sourceIsBot?: boolean;
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
  isRemote?: boolean;
  sourceId?: string;
  sourceName?: string;
  sourceTeam?: 'A' | 'B' | 'FFA';
  sourceIsBot?: boolean;
}

export type GrenadePinPullPhase =
  | 'NONE'
  | 'REACH_PIN'
  | 'PULL_PIN'
  | 'TUCK_POCKET'
  | 'EYE_AIM';

export type GrenadeThrowStyle = 'overhand' | 'underhand';

export interface PendingGrenadeRelease {
  equipmentId: TacticalEquipmentId;
  style: GrenadeThrowStyle;
  speedMps: number;
  charge01: number;
}

export interface LaunchedGrenadeInfo {
  equipmentId: TacticalEquipmentId;
  style: GrenadeThrowStyle;
  speedMps: number;
  origin: THREE.Vector3;
  velocity: THREE.Vector3;
  fuseRemainingSec: number;
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
  onInHandDetonate?: (ev: GrenadeDetonationEvent) => void;
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
  meta?: GrenadeRemoteAttribution;
}

interface FlyingSpoon {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  age: number;
  maxAge: number;
}

const MAX_EXPLOSION_POOL = 4;
const MAX_EXPLOSION_SPARKS = 26;
const MAX_SMOKE_POOL = 4;
const MAX_SMOKE_PUFFS = 15;
const MAX_THERMITE_POOL = 3;
const MAX_THERMITE_SPARKS = 10;

interface ExplosionVfx {
  active: boolean;
  group: THREE.Group;
  light: THREE.PointLight;
  coreMesh: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  sparkInst: THREE.InstancedMesh;
  sparkMat: THREE.MeshBasicMaterial;
  sparkCount: number;
  sparkPos: THREE.Vector3[];
  sparkVel: THREE.Vector3[];
  age: number;
  maxAge: number;
  peakIntensity: number;
  maxCoreScale: number;
  maxRingScale: number;
}

interface SmokeCloud {
  active: boolean;
  id: number;
  origin: THREE.Vector3;
  effectiveRadiusM: number;
  isScreeningSmoke: boolean;
  group: THREE.Group;
  sharedMat: THREE.MeshStandardMaterial;
  activePuffCount: number;
  puffs: Array<{
    mesh: THREE.Mesh;
    targetPos: THREE.Vector3;
    targetScale: number;
    driftSpeed: number;
    phase: number;
  }>;
  age: number;
  duration: number;
}

interface ThermiteZone {
  active: boolean;
  equipmentId: TacticalEquipmentId;
  def: TacticalEquipmentDef | null;
  pos: THREE.Vector3;
  group: THREE.Group;
  light: THREE.PointLight;
  emberMat: THREE.MeshStandardMaterial;
  sparkInst: THREE.InstancedMesh;
  sparkMat: THREE.MeshBasicMaterial;
  sparks: Array<{ pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number }>;
  age: number;
  duration: number;
  tickAccum: number;
  meta?: GrenadeRemoteAttribution;
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
  private readonly onInHandDetonate?: (ev: GrenadeDetonationEvent) => void;
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

  // 4-stage held grenade Manual of Arms FSM (bone-attached, zero floating camera viewmodel)
  private holdStage: GrenadeHoldStage = 'HOLSTERED';
  private heldEquipmentId: TacticalEquipmentId | null = null;
  private fuseElapsed = 0;
  private actualFuseSec = 4.5;
  private nominalFuseSec = 4.5;
  private heldBoneBuilt: BuiltTacticalEquipmentMesh | null = null;
  private heldBoneEquipmentId: TacticalEquipmentId | null = null;
  private heldBoneLayer = VIEWMODEL_LAYER;
  private heldBoneRingAttachedTo: THREE.Object3D | null = null;
  private lastThrowHandSocket: THREE.Object3D | null = null;
  private weaponStowBlend = 0;
  private pinPullPhase: GrenadePinPullPhase = 'NONE';
  private pinPullElapsed = 0;

  // Seamless LMB click-lob (<0.18s) vs hold-charge (>=0.18s) + release whip state
  private lmbHeld = false;
  private lmbHoldSec = 0;
  private charge01 = 0;
  private throwStyle: GrenadeThrowStyle = 'underhand';
  private pendingThrowRelease: PendingGrenadeRelease | null = null;
  private throwWhipTimer = 0;
  private throwWhipDuration = 0.16;
  private throwWhipStyle: GrenadeThrowStyle = 'overhand';
  private spoonPopAnim = 0;
  private animTime = 0;
  private lastLaunchedThrow: LaunchedGrenadeInfo | null = null;

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
  private readonly _spoonPos = new THREE.Vector3();
  private readonly _spoonQuat = new THREE.Quaternion();
  private readonly _spoonRight = new THREE.Vector3();
  private readonly _spoonUp = new THREE.Vector3();
  private readonly _spoonFwd = new THREE.Vector3();
  private readonly _smokeInfoBuf: ActiveSmokeCloudInfo[] = [];
  private readonly _sparkDummy = new THREE.Object3D();
  private readonly _sparkLookTarget = new THREE.Vector3();
  private readonly _detPosScratch = new THREE.Vector3();

  constructor(opts: TacticalGrenadeSystemOptions) {
    this.scene = opts.scene;
    this.physics = opts.physics;
    this.worldRaycastMeshes = opts.worldRaycastMeshes;
    this.worldBounds = opts.worldBounds ?? { minX: -96, maxX: 96, minZ: -96, maxZ: 96 };
    this.audio = opts.audio;
    this.onDetonate = opts.onDetonate;
    this.onInHandDetonate = opts.onInHandDetonate;
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

    // Pre-allocate permanent VFX & PointLight pools so NUM_POINT_LIGHTS never mutates at runtime
    // (avoids full-scene WebGL shader recompilation hitches on grenade detonation or expiry)
    this.initVfxPools();
  }

  private initVfxPools(): void {
    // 1. Explosion VFX Pool (permanent PointLights at intensity 0 + InstancedMesh sparks)
    for (let i = 0; i < MAX_EXPLOSION_POOL; i++) {
      const group = new THREE.Group();
      group.visible = false;

      // Light stays attached to root permanently (toggled via intensity = 0) so scene light count never changes
      const light = new THREE.PointLight(0xff9b32, 0, 18, 1.6);
      light.position.set(0, -100, 0);
      this.root.add(light);

      const coreMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xff9b32,
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
        }),
      );
      const coreMesh = new THREE.Mesh(this.geoCore, coreMat);
      group.add(coreMesh);

      const ringMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xffd27a,
          transparent: true,
          opacity: 0.72,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const ringMesh = new THREE.Mesh(this.geoRing, ringMat);
      ringMesh.rotation.x = -Math.PI * 0.5;
      ringMesh.position.y = 0.05;
      group.add(ringMesh);

      const sparkMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xffd27a,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        }),
      );
      const sparkInst = new THREE.InstancedMesh(this.geoSpark, sparkMat, MAX_EXPLOSION_SPARKS);
      sparkInst.frustumCulled = false;
      sparkInst.count = 0;
      group.add(sparkInst);

      const sparkPos: THREE.Vector3[] = [];
      const sparkVel: THREE.Vector3[] = [];
      for (let s = 0; s < MAX_EXPLOSION_SPARKS; s++) {
        sparkPos.push(new THREE.Vector3());
        sparkVel.push(new THREE.Vector3());
      }

      this.root.add(group);
      this.explosions.push({
        active: false,
        group,
        light,
        coreMesh,
        coreMat,
        ringMesh,
        ringMat,
        sparkInst,
        sparkMat,
        sparkCount: 0,
        sparkPos,
        sparkVel,
        age: 0,
        maxAge: 0.5,
        peakIntensity: 0,
        maxCoreScale: 1,
        maxRingScale: 1,
      });
    }

    // 2. Smoke Cloud Pool
    for (let i = 0; i < MAX_SMOKE_POOL; i++) {
      const group = new THREE.Group();
      group.visible = false;
      const sharedMat = this.trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x8a929b,
          roughness: 0.95,
          metalness: 0,
          transparent: true,
          opacity: 0.01,
          depthWrite: false,
        }),
      );
      const puffs: SmokeCloud['puffs'] = [];
      for (let p = 0; p < MAX_SMOKE_PUFFS; p++) {
        const mesh = new THREE.Mesh(this.geoSmokePuff, sharedMat);
        mesh.visible = false;
        group.add(mesh);
        puffs.push({
          mesh,
          targetPos: new THREE.Vector3(),
          targetScale: 1,
          driftSpeed: 0.05,
          phase: 0,
        });
      }
      this.root.add(group);
      this.smokeClouds.push({
        active: false,
        id: 0,
        origin: new THREE.Vector3(),
        effectiveRadiusM: 1.8,
        isScreeningSmoke: false,
        group,
        sharedMat,
        activePuffCount: 0,
        puffs,
        age: 0,
        duration: 1,
      });
    }

    // 3. Thermite Zone Pool (permanent PointLights at intensity 0 + InstancedMesh embers)
    for (let i = 0; i < MAX_THERMITE_POOL; i++) {
      const group = new THREE.Group();
      group.visible = false;

      const light = new THREE.PointLight(0xff7426, 0, 11, 1.7);
      light.position.set(0, -100, 0);
      this.root.add(light);

      const emberMat = this.trackMat(
        new THREE.MeshStandardMaterial({
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
        }),
      );
      const poolMesh = new THREE.Mesh(this.geoEmberPool, emberMat);
      group.add(poolMesh);

      const sparkMat = this.trackMat(
        new THREE.MeshBasicMaterial({
          color: 0xffc866,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      );
      const sparkInst = new THREE.InstancedMesh(this.geoSpark, sparkMat, MAX_THERMITE_SPARKS);
      sparkInst.frustumCulled = false;
      sparkInst.count = MAX_THERMITE_SPARKS;
      group.add(sparkInst);

      const sparks: ThermiteZone['sparks'] = [];
      for (let s = 0; s < MAX_THERMITE_SPARKS; s++) {
        sparks.push({
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(0, 3, 0),
          life: Math.random() * 0.4,
          maxLife: 0.35 + Math.random() * 0.45,
        });
      }

      this.root.add(group);
      this.thermiteZones.push({
        active: false,
        equipmentId: 'an_m14_thermite',
        def: null,
        pos: new THREE.Vector3(),
        group,
        light,
        emberMat,
        sparkInst,
        sparkMat,
        sparks,
        age: 0,
        duration: 1,
        tickAccum: 0,
      });
    }
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.sharedGeos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.sharedMats.push(m);
    return m;
  }

  private disposeHeldBoneMesh(): void {
    if (this.heldBoneBuilt) {
      if (this.heldBoneBuilt.pullRingMesh.parent) {
        this.heldBoneBuilt.pullRingMesh.parent.remove(this.heldBoneBuilt.pullRingMesh);
      }
      if (this.heldBoneBuilt.group.parent) {
        this.heldBoneBuilt.group.parent.remove(this.heldBoneBuilt.group);
      }
      this.heldBoneBuilt.dispose();
      this.heldBoneBuilt = null;
      this.heldBoneEquipmentId = null;
      this.heldBoneRingAttachedTo = null;
    }
  }

  private ensureHeldBoneMesh(
    equipmentId: TacticalEquipmentId,
    throwHandSocket: THREE.Object3D,
    renderLayer = VIEWMODEL_LAYER,
  ): BuiltTacticalEquipmentMesh {
    this.lastThrowHandSocket = throwHandSocket;
    if (
      !this.heldBoneBuilt ||
      this.heldBoneEquipmentId !== equipmentId ||
      this.heldBoneLayer !== renderLayer
    ) {
      this.disposeHeldBoneMesh();
      this.heldBoneLayer = renderLayer;
      this.heldBoneBuilt = buildTacticalEquipmentMesh(equipmentId, {
        withBeltClip: false,
        scale: 1.0,
        renderLayer,
      });
      this.heldBoneEquipmentId = equipmentId;
      this.heldBoneBuilt.group.position.copy(this.heldBoneBuilt.gripOffset.position);
      this.heldBoneBuilt.group.rotation.copy(this.heldBoneBuilt.gripOffset.rotation);
      throwHandSocket.add(this.heldBoneBuilt.group);
      this.heldBoneRingAttachedTo = this.heldBoneBuilt.group;
    } else if (this.heldBoneBuilt.group.parent !== throwHandSocket) {
      throwHandSocket.add(this.heldBoneBuilt.group);
    }
    return this.heldBoneBuilt;
  }

  /**
   * Synchronizes the physically attached ordnance inside the right palm socket (`throwHandSocket`),
   * plus dynamic `.attach()` transfer of `pullRingMesh` onto `leftPinPinchSocket` during PULL_PIN
   * and stowing inside `leftPocketAnchor` during TUCK_POCKET.
   */
  public syncHeldBoneAttachment(
    throwHandSocket: THREE.Object3D,
    leftPinPinchSocket: THREE.Object3D,
    leftPocketAnchor: THREE.Object3D,
    renderLayer = VIEWMODEL_LAYER,
  ): void {
    this.lastThrowHandSocket = throwHandSocket;
    if (this.holdStage === 'HOLSTERED' || !this.heldEquipmentId) {
      if (this.heldBoneBuilt) {
        this.heldBoneBuilt.group.visible = false;
        this.heldBoneBuilt.pullRingMesh.visible = false;
      }
      return;
    }

    const built = this.ensureHeldBoneMesh(this.heldEquipmentId, throwHandSocket, renderLayer);
    const grenadeReadyInPalm = this.weaponStowBlend >= 0.45 && !this.pendingThrowRelease;
    built.group.visible = grenadeReadyInPalm;
    built.spoonGroup.visible = this.holdStage !== 'LEVER_RELEASED';

    if (this.holdStage === 'DRAWN' || this.pinPullPhase === 'REACH_PIN') {
      if (this.heldBoneRingAttachedTo !== built.group) {
        built.group.add(built.pullRingMesh);
        // Reset back to grenade collar resting coordinates
        const fuzeY =
          this.heldEquipmentId === 'm67_frag'
            ? 0.052
            : this.heldEquipmentId === 'm84_flash'
              ? 0.068
              : this.heldEquipmentId === 'm18_smoke'
                ? 0.07
                : 0.072;
        built.pullRingMesh.position.set(-0.017, fuzeY - 0.002, 0.008);
        built.pullRingMesh.rotation.set(0, 0.42, 0);
        built.pullRingMesh.scale.setScalar(1);
        this.heldBoneRingAttachedTo = built.group;
      }
      built.pullRingMesh.visible = grenadeReadyInPalm;
    } else if (this.pinPullPhase === 'PULL_PIN') {
      if (this.heldBoneRingAttachedTo !== leftPinPinchSocket) {
        leftPinPinchSocket.attach(built.pullRingMesh);
        this.heldBoneRingAttachedTo = leftPinPinchSocket;
      }
      built.pullRingMesh.visible = grenadeReadyInPalm;
    } else if (this.pinPullPhase === 'TUCK_POCKET') {
      if (this.heldBoneRingAttachedTo !== leftPocketAnchor && this.pinPullElapsed >= 0.48) {
        leftPocketAnchor.attach(built.pullRingMesh);
        this.heldBoneRingAttachedTo = leftPocketAnchor;
      }
      built.pullRingMesh.visible = grenadeReadyInPalm && this.pinPullElapsed < 0.50;
    } else {
      if (this.heldBoneRingAttachedTo && this.heldBoneRingAttachedTo !== leftPocketAnchor) {
        leftPocketAnchor.attach(built.pullRingMesh);
        this.heldBoneRingAttachedTo = leftPocketAnchor;
      }
      built.pullRingMesh.visible = false;
    }
  }

  public consumeLastLaunchedThrow(): LaunchedGrenadeInfo | null {
    const out = this.lastLaunchedThrow;
    this.lastLaunchedThrow = null;
    return out;
  }

  public getHeldGrenadeMesh(): BuiltTacticalEquipmentMesh | null {
    return this.heldBoneBuilt;
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

  public getWeaponStowBlend(): number {
    return this.weaponStowBlend;
  }

  public isWeaponHidden(): boolean {
    return this.weaponStowBlend > 0.92;
  }

  public getPinPullPhase(): GrenadePinPullPhase {
    return this.pinPullPhase;
  }

  public getPinPullElapsed(): number {
    return this.pinPullElapsed;
  }

  public getCharge01(): number {
    return this.charge01;
  }

  public isThrowInputHeld(): boolean {
    return this.lmbHeld;
  }

  public getThrowStyle(): GrenadeThrowStyle {
    return this.pendingThrowRelease?.style ?? (this.throwWhipTimer > 0 ? this.throwWhipStyle : this.throwStyle);
  }

  public getThrowWhipProgress(): number {
    if (this.throwWhipTimer <= 0 || this.throwWhipDuration <= 0) return 0;
    return THREE.MathUtils.clamp(1 - this.throwWhipTimer / this.throwWhipDuration, 0, 1);
  }

  public isThrowing(): boolean {
    return this.lmbHeld || this.throwWhipTimer > 0 || this.pendingThrowRelease !== null;
  }

  public getActionStatusLabel(): string {
    if (this.holdStage === 'HOLSTERED') return '';
    if (this.holdStage === 'DRAWN') return '[RMB] Pull Pin';
    if (this.holdStage === 'PIN_PULLED') {
      return this.lmbHeld && this.throwStyle === 'overhand'
        ? 'Release [LMB] Overhand Throw'
        : '[RMB] Release Spoon · [LMB] Click Lob / Hold Throw';
    }
    return this.lmbHeld && this.throwStyle === 'overhand'
      ? 'LIVE FUSE — Release [LMB] Throw'
      : 'LIVE FUSE — [LMB] Click Lob / Hold Throw';
  }

  /**
   * Returns 0..1 progress of the *nominal* fuse only while the safety lever has been released.
   * Exposed strictly for telemetry/audio/vfx/tests — NOT rendered as any HUD throw power bar.
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
    this.pinPullPhase = 'NONE';
    this.pinPullElapsed = 0;
    this.lmbHeld = false;
    this.lmbHoldSec = 0;
    this.charge01 = 0;
    this.pendingThrowRelease = null;
    this.throwWhipTimer = 0;
    this.spoonPopAnim = 0;
    this.audio?.playGearRattle('weapon_swap', 0.58);
    return true;
  }

  /**
   * Stage 2 (1st RMB): Pull safety pin.
   * Left hand reaches to live pinAnchor, pinches & pulls along pinPullAxis, and tucks into left pocket
   * (pin never drops), while right palm keeps spoon compressed so the fuse remains STOPPED.
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
    this.pinPullPhase = 'REACH_PIN';
    this.pinPullElapsed = 0;
    this.audio?.playGrenadePinPull?.();
    return true;
  }

  /**
   * Stage 3 (2nd RMB): Release safety lever / spoon while keeping hold of body.
   * Spring-loaded spoon flies off physically from live spoonAnchor, striker snaps primer,
   * and hidden-variance chemical delay fuse begins burning live!
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
    this.spoonPopAnim = 1.0;
    if (this.pinPullPhase === 'REACH_PIN' || this.pinPullPhase === 'PULL_PIN') {
      this.pinPullPhase = 'EYE_AIM';
    }
    this.audio?.playGrenadeLeverSnap?.();
    this.spawnSpoonFromAnchorOrPose(spoonOrigin, spoonRight, spoonUp, spoonFwd);
    return true;
  }

  /**
   * Stage 4a (LMB down): Begins unified quick-lob vs hold-charge input when pin has been pulled.
   */
  public beginThrowInput(): boolean {
    if (this.holdStage !== 'PIN_PULLED' && this.holdStage !== 'LEVER_RELEASED') return false;
    if (this.lmbHeld || this.pendingThrowRelease || this.throwWhipTimer > 0) return false;
    this.lmbHeld = true;
    this.lmbHoldSec = 0;
    this.charge01 = 0;
    this.throwStyle = 'underhand';
    return true;
  }

  /**
   * Stage 4b (LMB up): Commits either seamless Underhand Lob (<0.18s) or Overhand Power Charge (>=0.18s).
   * Returns the resolved throw style so callers/UI/sync can mirror immediately, while actual projectile
   * release occurs right after right-arm whip + updateWorldMatrix(true, false).
   */
  public releaseThrowInput(): GrenadeThrowStyle | null {
    if (!this.lmbHeld || !this.heldEquipmentId) {
      this.lmbHeld = false;
      this.lmbHoldSec = 0;
      this.charge01 = 0;
      return null;
    }
    const style: GrenadeThrowStyle = this.lmbHoldSec < 0.18 ? 'underhand' : 'overhand';
    const speedMps =
      style === 'underhand'
        ? 10.0
        : THREE.MathUtils.lerp(13.5, 22.5, THREE.MathUtils.clamp(this.charge01, 0, 1));

    this.pendingThrowRelease = {
      equipmentId: this.heldEquipmentId,
      style,
      speedMps,
      charge01: this.charge01,
    };
    this.throwStyle = style;
    this.throwWhipStyle = style;
    this.throwWhipDuration = style === 'overhand' ? 0.14 : 0.16;
    this.throwWhipTimer = this.throwWhipDuration;
    this.lmbHeld = false;
    this.lmbHoldSec = 0;
    return style;
  }

  /** Resets held LMB charge safely on pointer-unlock or window blur without accidental release. */
  public resetHeldInputOnFocusLoss(): void {
    this.lmbHeld = false;
    this.lmbHoldSec = 0;
    this.charge01 = 0;
    this.throwStyle = 'underhand';
  }

  /**
   * Called by CharacterAnimator immediately after right-arm IK solve + `updateWorldMatrix(true, false)`
   * so projectile spawn position/velocity matches exact live bone world transform!
   */
  public consumePendingThrowRelease(
    boneWorldPos: Readonly<THREE.Vector3>,
    aimForward: Readonly<THREE.Vector3>,
    inheritedVel?: Readonly<THREE.Vector3>,
  ): { thrown: boolean; style: GrenadeThrowStyle; speedMps: number } | null {
    if (!this.pendingThrowRelease) return null;
    if (this.getThrowWhipProgress() < 0.24) return null;

    const pending = this.pendingThrowRelease;
    this.pendingThrowRelease = null;
    const thrown = this.throwHeldGrenadeWithSpeed(
      boneWorldPos,
      aimForward,
      inheritedVel,
      pending.speedMps,
      pending.style,
      pending.equipmentId,
    );
    return { thrown, style: pending.style, speedMps: pending.speedMps };
  }

  public throwHeldGrenadeWithSpeed(
    origin: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    inheritedVel: Readonly<THREE.Vector3> | undefined,
    speedMps: number,
    style: GrenadeThrowStyle = 'overhand',
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
      this.spawnSpoonFromAnchorOrPose(origin, undefined, undefined, forward);
    }

    this.holdStage = 'HOLSTERED';
    this.heldEquipmentId = null;
    this.fuseElapsed = 0;
    this.pinPullPhase = 'NONE';
    this.pinPullElapsed = 0;
    this.lmbHeld = false;
    this.lmbHoldSec = 0;
    this.charge01 = 0;
    this.pendingThrowRelease = null;
    if (this.heldBoneBuilt) {
      this.heldBoneBuilt.group.visible = false;
      this.heldBoneBuilt.pullRingMesh.visible = false;
    }

    this.spawnProjectile(def, origin, forward, inheritedVel, remainingFuse, speedMps, style);
    return true;
  }

  /**
   * Stage 4: Throw held grenade using catalog default throw speed (used by backward-compatible callers/tests).
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
    return this.throwHeldGrenadeWithSpeed(origin, forward, inheritedVel, def.throwSpeedMps, 'overhand', id);
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
      this.throwHeldGrenadeWithSpeed(origin, forward, inheritedVel, 10.5, 'underhand');
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
    this.pinPullPhase = 'NONE';
    this.pinPullElapsed = 0;
    this.lmbHeld = false;
    this.lmbHoldSec = 0;
    this.charge01 = 0;
    this.pendingThrowRelease = null;
    this.throwWhipTimer = 0;
    if (this.heldBoneBuilt) {
      this.heldBoneBuilt.group.visible = false;
      this.heldBoneBuilt.pullRingMesh.visible = false;
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

  /**
   * Spawns a live projectile for a remote MP player or host-authoritative AI bot.
   */
  public spawnRemoteGrenade(
    equipmentId: TacticalEquipmentId,
    position: Readonly<THREE.Vector3>,
    velocity: Readonly<THREE.Vector3>,
    fuseRemainingSec: number,
    meta?: GrenadeRemoteAttribution,
  ): void {
    const def = getTacticalEquipmentDef(equipmentId);
    const built = buildTacticalEquipmentMesh(def.id, { withBeltClip: false, scale: 1.05 });
    built.pullRingMesh.visible = false;
    built.spoonGroup.visible = false;
    built.group.position.copy(position);
    built.group.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    this.root.add(built.group);

    this.activeGrenades.push({
      equipmentId: def.id,
      def,
      built,
      pos: position.clone(),
      vel: velocity.clone(),
      rotVel: new THREE.Vector3(
        (Math.random() - 0.5) * 14 + 6,
        (Math.random() - 0.5) * 11,
        (Math.random() - 0.5) * 13,
      ),
      fuseLeft: Math.max(0.06, fuseRemainingSec),
      age: 0,
      bounces: 0,
      resting: false,
      meta: meta ? { isRemote: true, ...meta } : { isRemote: true },
    });
  }

  public spawnRemoteFlyingSpoon(
    origin: Readonly<THREE.Vector3>,
    forward?: Readonly<THREE.Vector3>,
  ): void {
    this._spoonFwd.copy(forward ?? new THREE.Vector3(0, 0, -1)).normalize();
    this._spoonUp.set(0, 1, 0);
    this._spoonRight.crossVectors(this._spoonFwd, this._spoonUp).normalize();
    this.spawnFlyingSpoon(origin, this._spoonRight, this._spoonUp, this._spoonFwd);
  }

  public triggerRemoteDetonation(
    equipmentId: TacticalEquipmentId,
    position: Readonly<THREE.Vector3>,
    meta?: GrenadeRemoteAttribution,
  ): void {
    const def = getTacticalEquipmentDef(equipmentId);
    this.detonateAt(def, position.clone(), meta ? { isRemote: true, ...meta } : { isRemote: true });
  }

  private spawnSpoonFromAnchorOrPose(
    fallbackOrigin?: Readonly<THREE.Vector3>,
    fallbackRight?: Readonly<THREE.Vector3>,
    fallbackUp?: Readonly<THREE.Vector3>,
    fallbackFwd?: Readonly<THREE.Vector3>,
  ): void {
    if (this.heldBoneBuilt && this.heldBoneBuilt.spoonAnchor) {
      this.heldBoneBuilt.spoonAnchor.updateWorldMatrix(true, false);
      this.heldBoneBuilt.spoonAnchor.getWorldPosition(this._spoonPos);
      this.heldBoneBuilt.spoonAnchor.getWorldQuaternion(this._spoonQuat);
      this._spoonRight.set(1, 0, 0).applyQuaternion(this._spoonQuat).normalize();
      this._spoonUp.set(0, 1, 0).applyQuaternion(this._spoonQuat).normalize();
      this._spoonFwd.set(0, 0, -1).applyQuaternion(this._spoonQuat).normalize();
      this.spawnFlyingSpoon(this._spoonPos, this._spoonRight, this._spoonUp, this._spoonFwd, true);
      return;
    }
    if (fallbackOrigin) {
      this._spoonPos.copy(fallbackOrigin);
      this._spoonFwd.copy(fallbackFwd ?? new THREE.Vector3(0, 0, -1)).normalize();
      this._spoonUp.copy(fallbackUp ?? new THREE.Vector3(0, 1, 0)).normalize();
      this._spoonRight.copy(
        fallbackRight ?? new THREE.Vector3().crossVectors(this._spoonFwd, this._spoonUp).normalize(),
      );
      this.spawnFlyingSpoon(this._spoonPos, this._spoonRight, this._spoonUp, this._spoonFwd, false);
    }
  }

  private spawnFlyingSpoon(
    origin: Readonly<THREE.Vector3>,
    right?: Readonly<THREE.Vector3>,
    up?: Readonly<THREE.Vector3>,
    fwd?: Readonly<THREE.Vector3>,
    exactOrigin = false,
  ): void {
    this._spoonPos.copy(origin);
    this._spoonFwd.copy(fwd ?? new THREE.Vector3(0, 0, -1)).normalize();
    this._spoonUp.copy(up ?? new THREE.Vector3(0, 1, 0)).normalize();
    this._spoonRight.copy(right ?? new THREE.Vector3().crossVectors(this._spoonFwd, this._spoonUp).normalize());

    const mesh = new THREE.Mesh(this.geoSpoonProp, this.matSpoonProp);
    if (exactOrigin) {
      mesh.position.copy(this._spoonPos);
    } else {
      mesh.position
        .copy(this._spoonPos)
        .addScaledVector(this._spoonFwd, 0.24)
        .addScaledVector(this._spoonRight, 0.12)
        .addScaledVector(this._spoonUp, 0.04);
    }
    this.root.add(mesh);

    const vel = new THREE.Vector3()
      .addScaledVector(this._spoonRight, 2.2 + Math.random() * 1.1)
      .addScaledVector(this._spoonUp, 2.5 + Math.random() * 0.9)
      .addScaledVector(this._spoonFwd, 1.2 + Math.random() * 0.8);

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
    speedMps: number = def.throwSpeedMps,
    style: GrenadeThrowStyle = 'overhand',
  ): void {
    const built = buildTacticalEquipmentMesh(def.id, { withBeltClip: false, scale: 1.05 });
    // Thrown grenade has pin & safety lever already detached
    built.pullRingMesh.visible = false;
    built.spoonGroup.visible = false;

    const dir = forward.clone().normalize();
    const startPos = origin.clone().addScaledVector(dir, 0.08);
    built.group.position.copy(startPos);
    built.group.rotation.set(Math.random() * 2, Math.random() * 2, Math.random() * 2);
    this.root.add(built.group);

    const vel = dir.multiplyScalar(speedMps);
    vel.y += style === 'underhand' ? 2.1 : 2.35;
    if (inheritedVel) {
      vel.x += inheritedVel.x * 0.48;
      vel.y += Math.max(0, inheritedVel.y) * 0.30;
      vel.z += inheritedVel.z * 0.48;
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

    this.lastLaunchedThrow = {
      equipmentId: def.id,
      style,
      speedMps,
      origin: startPos.clone(),
      velocity: vel.clone(),
      fuseRemainingSec: fuseSec,
    };
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
      if (!cloud.active || !cloud.isScreeningSmoke) continue;
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
      if (!c.active || !c.isScreeningSmoke || c.age > c.duration - 1.2) continue;
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
   * Advances burning fuse (ONLY in LEVER_RELEASED stage), smooth weapon stow blend (0 <-> 1),
   * pin-pull choreography phase, unified LMB hold charge, flying spoons, projectiles, and VFX pools.
   */
  public update(dt: number, cookOvercookOrigin?: Readonly<THREE.Vector3>): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    this.animTime += clampedDt;

    // 0. Smooth weapon stow & return blend (0 -> 1 -> 0) + whip release progress
    if (this.throwWhipTimer > 0) {
      this.throwWhipTimer = Math.max(0, this.throwWhipTimer - clampedDt);
    }
    this.spoonPopAnim = Math.max(0, this.spoonPopAnim - clampedDt * 5.8);

    const wantsWeaponStowed =
      this.holdStage !== 'HOLSTERED' || this.throwWhipTimer > 0 || this.pendingThrowRelease !== null;
    if (wantsWeaponStowed) {
      this.weaponStowBlend = Math.min(1, this.weaponStowBlend + clampedDt * 16.0);
    } else {
      this.weaponStowBlend = Math.max(0, this.weaponStowBlend - clampedDt * 11.0);
    }

    // 0b. Pin-pull choreography phase progression (REACH_PIN -> PULL_PIN -> TUCK_POCKET -> EYE_AIM)
    if (this.holdStage === 'PIN_PULLED' || this.holdStage === 'LEVER_RELEASED') {
      if (this.pinPullPhase !== 'EYE_AIM' && this.pinPullPhase !== 'NONE') {
        this.pinPullElapsed += clampedDt;
        if (this.pinPullElapsed < 0.16) {
          this.pinPullPhase = 'REACH_PIN';
        } else if (this.pinPullElapsed < 0.34) {
          this.pinPullPhase = 'PULL_PIN';
        } else if (this.pinPullElapsed < 0.56) {
          this.pinPullPhase = 'TUCK_POCKET';
        } else {
          this.pinPullPhase = 'EYE_AIM';
        }
      }
    } else {
      this.pinPullPhase = 'NONE';
      this.pinPullElapsed = 0;
    }

    // 0c. Seamless LMB click-lob (<0.18s) vs hold-charge (>=0.18s) accumulation
    if (this.lmbHeld) {
      this.lmbHoldSec += clampedDt;
      if (this.lmbHoldSec < 0.18) {
        this.throwStyle = 'underhand';
        this.charge01 = 0;
      } else {
        this.throwStyle = 'overhand';
        this.charge01 = THREE.MathUtils.clamp((this.lmbHoldSec - 0.18) / 0.82, 0, 1);
      }
    }

    // 1. Step live chemical delay fuse ONLY when safety lever/spoon has been released
    if (this.holdStage === 'LEVER_RELEASED' && this.heldEquipmentId) {
      const def = getTacticalEquipmentDef(this.heldEquipmentId);
      this.fuseElapsed += clampedDt;
      if (this.fuseElapsed >= this.actualFuseSec) {
        if (this.lastThrowHandSocket) {
          this.lastThrowHandSocket.updateWorldMatrix(true, false);
          this.lastThrowHandSocket.getWorldPosition(this._tmpDetPos);
        } else if (cookOvercookOrigin) {
          this._tmpDetPos.copy(cookOvercookOrigin);
        } else {
          this._tmpDetPos.set(0, 1.4, 0);
        }
        const detPos = this._tmpDetPos.clone();
        this.holdStage = 'HOLSTERED';
        this.heldEquipmentId = null;
        this.fuseElapsed = 0;
        this.pinPullPhase = 'NONE';
        this.pinPullElapsed = 0;
        this.lmbHeld = false;
        this.lmbHoldSec = 0;
        this.charge01 = 0;
        this.pendingThrowRelease = null;
        this.throwWhipTimer = 0;
        if (this.heldBoneBuilt) {
          this.heldBoneBuilt.group.visible = false;
          this.heldBoneBuilt.pullRingMesh.visible = false;
        }
        const ev = this.detonateAt(def, detPos);
        this.onInHandDetonate?.(ev);
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
        this._detPosScratch.copy(g.pos);
        const def = g.def;
        const meta = g.meta;
        this.root.remove(g.built.group);
        g.built.dispose();
        this.activeGrenades.splice(i, 1);
        this.detonateAt(def, this._detPosScratch, meta);
      }
    }

    // 3. Step Pooled Explosion VFX (zero allocation, InstancedMesh sparks)
    for (let i = 0; i < this.explosions.length; i++) {
      const fx = this.explosions[i];
      if (!fx.active) continue;
      fx.age += clampedDt;
      const t = Math.min(1, fx.age / fx.maxAge);

      fx.light.intensity = fx.peakIntensity * Math.pow(1 - t, 2.4);

      const coreScale = THREE.MathUtils.lerp(0.25, fx.maxCoreScale, Math.pow(t, 0.35));
      fx.coreMesh.scale.setScalar(coreScale);
      fx.coreMat.opacity = Math.max(0, (1 - t) * (1 - t) * 0.92);

      const ringScale = THREE.MathUtils.lerp(0.3, fx.maxRingScale, Math.pow(t, 0.45));
      fx.ringMesh.scale.setScalar(ringScale);
      fx.ringMat.opacity = Math.max(0, (1 - t) * 0.72);

      fx.sparkMat.opacity = Math.max(0, 1 - t * 1.15);
      for (let s = 0; s < fx.sparkCount; s++) {
        const spPos = fx.sparkPos[s];
        const spVel = fx.sparkVel[s];
        spVel.y -= 13.0 * clampedDt;
        spPos.addScaledVector(spVel, clampedDt);
        this._sparkDummy.position.copy(spPos);
        this._sparkLookTarget.copy(spPos).add(spVel);
        this._sparkDummy.lookAt(this._sparkLookTarget);
        this._sparkDummy.scale.setScalar(1);
        this._sparkDummy.updateMatrix();
        fx.sparkInst.setMatrixAt(s, this._sparkDummy.matrix);
      }
      fx.sparkInst.instanceMatrix.needsUpdate = true;

      if (fx.age >= fx.maxAge) {
        fx.active = false;
        fx.group.visible = false;
        fx.light.intensity = 0;
        fx.sparkInst.count = 0;
      }
    }

    // 4. Step Pooled Smoke Clouds
    for (let i = 0; i < this.smokeClouds.length; i++) {
      const cloud = this.smokeClouds[i];
      if (!cloud.active) continue;
      cloud.age += clampedDt;
      const bloomT = Math.min(1, cloud.age / 1.45);
      const fadeOutT =
        cloud.age > cloud.duration - 2.6
          ? Math.max(0, (cloud.duration - cloud.age) / 2.6)
          : 1.0;

      const easeBloom = 1 - Math.pow(1 - bloomT, 3);
      cloud.sharedMat.opacity =
        (cloud.isScreeningSmoke ? 0.76 : 0.5) * Math.min(1, bloomT * 1.4) * fadeOutT;

      for (let p = 0; p < cloud.activePuffCount; p++) {
        const pf = cloud.puffs[p];
        pf.mesh.position.set(
          pf.targetPos.x * easeBloom + Math.sin(cloud.age * 0.7 + pf.phase) * 0.24,
          pf.targetPos.y * easeBloom + cloud.age * pf.driftSpeed,
          pf.targetPos.z * easeBloom + Math.cos(cloud.age * 0.65 + pf.phase) * 0.24,
        );
        const s = pf.targetScale * (0.28 + 0.72 * easeBloom) * (0.85 + 0.15 * fadeOutT);
        pf.mesh.scale.setScalar(s);
        pf.mesh.rotation.y += clampedDt * 0.18;
      }

      if (cloud.age >= cloud.duration) {
        cloud.active = false;
        cloud.group.visible = false;
        cloud.isScreeningSmoke = false;
      }
    }

    // 5. Step Pooled Thermite Incendiary Zones
    for (let i = 0; i < this.thermiteZones.length; i++) {
      const tz = this.thermiteZones[i];
      if (!tz.active || !tz.def) continue;
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
      tz.sparkMat.opacity = 0.9 * fade;

      const showSparks = fade > 0.12;
      tz.sparkInst.visible = showSparks;
      if (showSparks) {
        for (let s = 0; s < tz.sparks.length; s++) {
          const sp = tz.sparks[s];
          sp.life += clampedDt;
          if (sp.life >= sp.maxLife) {
            sp.life = 0;
            sp.maxLife = 0.35 + Math.random() * 0.45;
            const ang = Math.random() * Math.PI * 2;
            const rad = Math.random() * 1.1;
            sp.pos.set(Math.cos(ang) * rad, 0.08, Math.sin(ang) * rad);
            sp.vel.set(
              (Math.random() - 0.5) * 2.2,
              2.4 + Math.random() * 3.4,
              (Math.random() - 0.5) * 2.2,
            );
          } else {
            sp.vel.y -= 7.5 * clampedDt;
            sp.pos.addScaledVector(sp.vel, clampedDt);
          }
          this._sparkDummy.position.copy(sp.pos);
          this._sparkDummy.rotation.set(0, 0, 0);
          this._sparkDummy.scale.setScalar(0.7);
          this._sparkDummy.updateMatrix();
          tz.sparkInst.setMatrixAt(s, this._sparkDummy.matrix);
        }
        tz.sparkInst.instanceMatrix.needsUpdate = true;
      }

      if (tz.tickAccum >= 0.35) {
        const tickDt = tz.tickAccum;
        tz.tickAccum = 0;
        this.onDetonate?.({
          equipmentId: tz.equipmentId,
          def: tz.def,
          kind: 'thermite',
          position: tz.pos,
          radiusM: tz.def.blastRadiusM,
          lethalRadiusM: tz.def.lethalRadiusM,
          maxDamage: tz.def.maxDamage * tickDt,
          isTick: true,
          tickDtSec: tickDt,
          isRemote: tz.meta?.isRemote,
          sourceId: tz.meta?.sourceId,
          sourceName: tz.meta?.sourceName,
          sourceTeam: tz.meta?.sourceTeam,
          sourceIsBot: tz.meta?.sourceIsBot,
        });
      }

      if (tz.age >= tz.duration) {
        tz.active = false;
        tz.group.visible = false;
        tz.light.intensity = 0;
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

  private detonateAt(
    def: TacticalEquipmentDef,
    pos: THREE.Vector3,
    meta?: GrenadeRemoteAttribution,
  ): GrenadeDetonationEvent {
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
      this.spawnThermiteZone(def, pos, meta);
    }

    const ev: GrenadeDetonationEvent = {
      equipmentId: def.id,
      def,
      kind,
      position: pos,
      radiusM: def.blastRadiusM,
      lethalRadiusM: def.lethalRadiusM,
      maxDamage: kind === 'thermite' ? def.maxDamage * 0.45 : def.maxDamage,
      isTick: false,
      isRemote: meta?.isRemote,
      sourceId: meta?.sourceId,
      sourceName: meta?.sourceName,
      sourceTeam: meta?.sourceTeam,
      sourceIsBot: meta?.sourceIsBot,
    };
    this.onDetonate?.(ev);
    return ev;
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
    // Acquire inactive slot or recycle oldest active explosion slot (zero allocation)
    let slot = this.explosions[0];
    for (let i = 0; i < this.explosions.length; i++) {
      if (!this.explosions[i].active) {
        slot = this.explosions[i];
        break;
      }
      if (this.explosions[i].age > slot.age) {
        slot = this.explosions[i];
      }
    }

    slot.active = true;
    slot.age = 0;
    slot.maxAge = maxAge;
    slot.peakIntensity = peakIntensity;
    slot.maxCoreScale = maxCoreScale;
    slot.maxRingScale = maxRingScale;

    slot.group.position.set(pos.x, pos.y + 0.14, pos.z);
    slot.group.visible = true;

    slot.light.color.setHex(coreHex);
    slot.light.position.set(pos.x, pos.y + 0.14, pos.z);
    slot.light.intensity = peakIntensity;

    slot.coreMat.color.setHex(coreHex);
    slot.coreMat.opacity = 0.92;
    slot.coreMesh.scale.setScalar(0.25);

    slot.ringMat.color.setHex(sparkHex);
    slot.ringMat.opacity = 0.72;
    slot.ringMesh.scale.setScalar(0.3);

    slot.sparkMat.color.setHex(sparkHex);
    slot.sparkMat.opacity = 1;

    const count = Math.min(MAX_EXPLOSION_SPARKS, sparkCount);
    slot.sparkCount = count;
    slot.sparkInst.count = count;

    for (let i = 0; i < count; i++) {
      const ang = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 6.0 + Math.random() * 11.5;
      slot.sparkPos[i].set(0, 0, 0);
      slot.sparkVel[i].set(Math.cos(ang) * spd, 2.2 + Math.random() * 7.5, Math.sin(ang) * spd);
      this._sparkDummy.position.set(0, 0, 0);
      this._sparkDummy.lookAt(slot.sparkVel[i]);
      this._sparkDummy.scale.setScalar(1);
      this._sparkDummy.updateMatrix();
      slot.sparkInst.setMatrixAt(i, this._sparkDummy.matrix);
    }
    slot.sparkInst.instanceMatrix.needsUpdate = true;
  }

  private acquireSmokeSlot(): SmokeCloud {
    let slot = this.smokeClouds[0];
    for (let i = 0; i < this.smokeClouds.length; i++) {
      if (!this.smokeClouds[i].active) return this.smokeClouds[i];
      if (this.smokeClouds[i].age > slot.age) slot = this.smokeClouds[i];
    }
    return slot;
  }

  private spawnMiniBlastSmoke(pos: Readonly<THREE.Vector3>): void {
    const slot = this.acquireSmokeSlot();
    slot.active = true;
    slot.id = this.nextSmokeCloudId++;
    slot.origin.copy(pos);
    slot.effectiveRadiusM = 1.8;
    slot.isScreeningSmoke = false;
    slot.age = 0;
    slot.duration = 3.4;
    slot.activePuffCount = 5;
    slot.group.position.copy(pos);
    slot.group.visible = true;
    slot.sharedMat.color.setHex(0x2a2d30);
    slot.sharedMat.opacity = 0.5;

    for (let i = 0; i < MAX_SMOKE_PUFFS; i++) {
      const pf = slot.puffs[i];
      if (i < 5) {
        const ang = (i / 5) * Math.PI * 2;
        pf.mesh.visible = true;
        pf.mesh.position.set(0, 0, 0);
        pf.targetPos.set(Math.cos(ang) * 0.9, 0.8 + i * 0.25, Math.sin(ang) * 0.9);
        pf.targetScale = 1.05 + Math.random() * 0.5;
        pf.driftSpeed = 0.35 + Math.random() * 0.2;
        pf.phase = Math.random() * Math.PI * 2;
      } else {
        pf.mesh.visible = false;
      }
    }
  }

  private spawnSmokeCloud(pos: Readonly<THREE.Vector3>, duration: number, blastRadiusM = 7.5): void {
    const slot = this.acquireSmokeSlot();
    slot.active = true;
    slot.id = this.nextSmokeCloudId++;
    slot.origin.copy(pos);
    slot.effectiveRadiusM = Math.max(3.8, blastRadiusM * 0.58);
    slot.isScreeningSmoke = true;
    slot.age = 0;
    slot.duration = duration;
    slot.activePuffCount = MAX_SMOKE_PUFFS;
    slot.group.position.copy(pos);
    slot.group.visible = true;
    slot.sharedMat.color.setHex(0x939ba4);
    slot.sharedMat.opacity = 0.01;

    for (let i = 0; i < MAX_SMOKE_PUFFS; i++) {
      const pf = slot.puffs[i];
      const ring = i < 5 ? 0.95 : i < 11 ? 2.45 : 1.55;
      const ang = (i / MAX_SMOKE_PUFFS) * Math.PI * 2 * 1.7 + Math.random() * 0.35;
      const yOff = i < 5 ? 1.15 : i < 11 ? 1.55 + Math.random() * 0.65 : 2.65 + Math.random() * 0.55;
      pf.mesh.visible = true;
      pf.mesh.position.set(0, 0, 0);
      pf.targetPos.set(Math.cos(ang) * ring, yOff, Math.sin(ang) * ring);
      pf.targetScale = 1.95 + Math.random() * 0.9;
      pf.driftSpeed = 0.045 + Math.random() * 0.03;
      pf.phase = Math.random() * Math.PI * 2;
    }
  }

  private spawnThermiteZone(
    def: TacticalEquipmentDef,
    pos: THREE.Vector3,
    meta?: GrenadeRemoteAttribution,
  ): void {
    let slot = this.thermiteZones[0];
    for (let i = 0; i < this.thermiteZones.length; i++) {
      if (!this.thermiteZones[i].active) {
        slot = this.thermiteZones[i];
        break;
      }
      if (this.thermiteZones[i].age > slot.age) {
        slot = this.thermiteZones[i];
      }
    }

    const floorY = this.physics.getGroundHeight(pos.x, pos.z, pos.y + 0.35);
    slot.active = true;
    slot.equipmentId = def.id;
    slot.def = def;
    slot.meta = meta;
    slot.pos.set(pos.x, floorY + 0.03, pos.z);
    slot.group.position.copy(slot.pos);
    slot.group.visible = true;
    slot.light.position.set(slot.pos.x, slot.pos.y + 0.45, slot.pos.z);
    slot.light.intensity = 10;
    slot.age = 0;
    slot.duration = def.effectDurationSec;
    slot.tickAccum = 0;

    for (let s = 0; s < slot.sparks.length; s++) {
      const sp = slot.sparks[s];
      sp.pos.set(0, 0.08, 0);
      sp.vel.set(0, 3, 0);
      sp.life = Math.random() * 0.4;
      sp.maxLife = 0.35 + Math.random() * 0.45;
    }
  }

  public dispose(): void {
    this.disposeHeldBoneMesh();

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
      this.root.remove(fx.group);
      this.root.remove(fx.light);
    }
    this.explosions.length = 0;

    for (const c of this.smokeClouds) {
      this.root.remove(c.group);
    }
    this.smokeClouds.length = 0;

    for (const tz of this.thermiteZones) {
      this.root.remove(tz.group);
      this.root.remove(tz.light);
    }
    this.thermiteZones.length = 0;

    this.scene.remove(this.root);
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
  }
}

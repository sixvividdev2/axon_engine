import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEMS } from '../../data/items';
import {
  LOOT_TABLES,
  LootTableId,
  POI_TEMPLATES,
  PoiBoxDef,
  PoiMaterialKind,
} from '../../data/poiTemplates';
import { AudioEngine } from '../audio/AudioEngine';
import { AcousticSystem } from '../stealth/AcousticSystem';
import { ProceduralTextureLibrary } from '../textures/ProceduralTextures';
import {
  BiomeId,
  ChunkDelta,
  ContainerLootState,
  DroppedItemState,
  InventoryItemInstance,
} from '../types';
import {
  CHUNK_SIZE,
  MACRO_BLOCK_SIZE,
  PoiPlacement,
  PRIMARY_ROAD_X_OFFSET,
  PRIMARY_ROAD_Z_OFFSET,
  RoadNetwork,
  rotateBoxExtents,
  rotateLocalOffset,
} from './RoadNetwork';
import type { BoxCollider, ContainerEntity, DoorEntity, SurfaceType } from './WorldBuilder';
import { makeChunkKey, WorldColliderIndex, worldToChunkCoord } from './WorldColliderIndex';
import { hashChunk, mulberry32, sampleTerrainBase, WATER_LEVEL } from './WorldNoise';

const VISUAL_RADIUS = 2; // 5x5 chunks
const ACTIVE_RADIUS = 1; // 3x3 chunks

interface WindowEntity {
  id: string;
  chunkKey: string;
  mesh: THREE.Mesh;
  colliderId: string;
  worldPos: THREE.Vector3;
  broken: boolean;
}

interface StealthPatch {
  wx: number;
  wz: number;
  radius: number;
}

interface IndoorZoneWorld {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorSurface: SurfaceType;
  acoustics: 'concrete' | 'wood';
}

interface GlassShard {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  age: number;
  maxAge: number;
}

interface ChunkZombieSpawn {
  id: string;
  archetypeId: 'infected_walker' | 'infected_stalker';
  worldX: number;
  worldY: number;
  worldZ: number;
  yaw: number;
}

interface LoadedChunk {
  cx: number;
  cz: number;
  key: string;
  worldX0: number;
  worldZ0: number;
  group: THREE.Group;
  chunkGeos: THREE.BufferGeometry[];
  instancedMeshes: THREE.InstancedMesh[];
  raycastMeshes: THREE.Object3D[];
  doors: DoorEntity[];
  containers: ContainerEntity[];
  windows: WindowEntity[];
  indoorZones: IndoorZoneWorld[];
  stealthPatches: StealthPatch[];
  zombieSpawns: ChunkZombieSpawn[];
}

function emptyDelta(): ChunkDelta {
  return {
    openedDoors: {},
    brokenWindows: [],
    lootedContainers: {},
    killedZombieIds: [],
    droppedItems: [],
  };
}

function cloneDelta(d: ChunkDelta): ChunkDelta {
  return {
    openedDoors: { ...d.openedDoors },
    brokenWindows: [...d.brokenWindows],
    lootedContainers: Object.fromEntries(
      Object.entries(d.lootedContainers).map(([k, v]) => [
        k,
        { ...v, items: v.items.map((it) => ({ ...it })) },
      ]),
    ),
    killedZombieIds: [...d.killedZombieIds],
    droppedItems: d.droppedItems.map((di) => ({
      id: di.id,
      position: [...di.position] as [number, number, number],
      item: { ...di.item },
    })),
  };
}

function dirToAngle(dir: '+x' | '-x' | '+z' | '-z', turns: 0 | 1 | 2 | 3): number {
  let base = 0;
  if (dir === '+x') base = 0;
  else if (dir === '-z') base = Math.PI / 2;
  else if (dir === '-x') base = Math.PI;
  else base = -Math.PI / 2;
  // Rotating template by rotQuarterTurns around Y (matching rotateLocalOffset)
  return base + turns * (Math.PI / 2);
}

function dirToBox(
  hx: number,
  hz: number,
  width: number,
  dir: '+x' | '-x' | '+z' | '-z',
  turns: 0 | 1 | 2 | 3,
  minY: number,
  maxY: number,
): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  const localVec =
    dir === '+x'
      ? { x: width, z: 0 }
      : dir === '-x'
        ? { x: -width, z: 0 }
        : dir === '+z'
          ? { x: 0, z: width }
          : { x: 0, z: -width };
  const r = rotateLocalOffset(localVec.x, localVec.z, turns);
  const ex = hx + r.x;
  const ez = hz + r.z;
  return {
    minX: Math.min(hx, ex) - 0.11,
    maxX: Math.max(hx, ex) + 0.11,
    minY,
    maxY,
    minZ: Math.min(hz, ez) - 0.11,
    maxZ: Math.max(hz, ez) + 0.11,
  };
}

export class ChunkManager {
  public readonly worldSeed: number;
  public readonly roadNetwork: RoadNetwork;
  public readonly colliderIndex: WorldColliderIndex;
  public readonly worldGroup = new THREE.Group();

  /** Floating origin in True World Coordinates so BodycamController local coords stay near (0,0) */
  public originX = 0;
  public originZ = 0;

  /** Live active-region slices exposed cleanly through BuiltWorld */
  public readonly activeColliders: BoxCollider[] = [];
  public readonly activeRaycastMeshes: THREE.Object3D[] = [];
  public readonly activeDoors: DoorEntity[] = [];
  public readonly activeContainers: ContainerEntity[] = [];
  public readonly activeIndoorZones: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];

  private scene: THREE.Scene;
  private textures: ProceduralTextureLibrary;
  private audio: AudioEngine;
  private acoustic: AcousticSystem;

  private loadedChunks = new Map<string, LoadedChunk>();
  private buildQueue: Array<{ cx: number; cz: number; key: string; distSq: number }> = [];
  private deltas = new Map<string, ChunkDelta>();
  private glassShards: GlassShard[] = [];

  // Callbacks to sync zombies as chunks activate/deactivate
  public onChunkZombiesReady?: (chunkKey: string, spawns: ChunkZombieSpawn[], killedIds: Set<string>) => void;
  public onChunkUnloaded?: (chunkKey: string) => void;

  // Shared immutable materials & prototype geometries (disposed only in ChunkManager.dispose)
  private materials: THREE.Material[] = [];
  private protoGeos: THREE.BufferGeometry[] = [];

  private terrainMat: THREE.MeshStandardMaterial;
  private waterMat: THREE.MeshStandardMaterial;
  private asphaltMat: THREE.MeshStandardMaterial;
  private concreteMat: THREE.MeshStandardMaterial;
  private woodMat: THREE.MeshStandardMaterial;
  private metalMat: THREE.MeshStandardMaterial;
  private darkSteelMat: THREE.MeshStandardMaterial;
  private sandbagMat: THREE.MeshStandardMaterial;
  private glassMat: THREE.MeshPhysicalMaterial;
  private shardMat: THREE.MeshPhysicalMaterial;
  private powerlineMat: THREE.LineBasicMaterial;

  private pineTrunkMat: THREE.MeshStandardMaterial;
  private pineCanopyMat: THREE.MeshStandardMaterial;
  private birchTrunkMat: THREE.MeshStandardMaterial;
  private grassTuftMat: THREE.MeshStandardMaterial;
  private rockMat: THREE.MeshStandardMaterial;
  private palmFrondMat: THREE.MeshStandardMaterial;

  private pineTrunkGeo: THREE.BufferGeometry;
  private pineCanopyGeo: THREE.BufferGeometry;
  private birchTrunkGeo: THREE.BufferGeometry;
  private grassTuftGeo: THREE.BufferGeometry;
  private rockGeo: THREE.BufferGeometry;
  private fencePostGeo: THREE.BufferGeometry;
  private palmFrondGeo: THREE.BufferGeometry;
  private shardGeo: THREE.BufferGeometry;

  private _dummy = new THREE.Object3D();
  private _color = new THREE.Color();
  private lastActiveCenterKey = '';

  constructor(
    scene: THREE.Scene,
    textures: ProceduralTextureLibrary,
    worldSeed: number,
    audio: AudioEngine,
    acoustic: AcousticSystem,
    initialDeltas?: Record<string, ChunkDelta>,
    legacyContainers?: Record<string, ContainerLootState>,
    legacyDoors?: Record<string, { id: string; isOpen: boolean }>,
  ) {
    this.scene = scene;
    this.textures = textures;
    this.worldSeed = worldSeed;
    this.audio = audio;
    this.acoustic = acoustic;
    this.roadNetwork = new RoadNetwork(worldSeed);
    this.colliderIndex = new WorldColliderIndex();
    this.scene.add(this.worldGroup);

    if (initialDeltas) {
      for (const [k, d] of Object.entries(initialDeltas)) {
        this.deltas.set(k, cloneDelta(d));
      }
    }
    // Import legacy saves cleanly into starter chunk deltas if no chunkDeltas existed
    if (!initialDeltas && (legacyContainers || legacyDoors)) {
      const starterDelta = this.getOrCreateDelta('-1,0');
      if (legacyContainers) {
        for (const [k, v] of Object.entries(legacyContainers)) {
          starterDelta.lootedContainers[k] = v;
        }
      }
      if (legacyDoors) {
        for (const [k, v] of Object.entries(legacyDoors)) {
          starterDelta.openedDoors[k] = v.isOpen;
        }
      }
    }

    const trackMat = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };
    const trackProto = <T extends THREE.BufferGeometry>(g: T): T => {
      this.protoGeos.push(g);
      return g;
    };

    this.terrainMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.grass.map,
        normalMap: textures.grass.normalMap,
        roughnessMap: textures.grass.roughnessMap,
        roughness: 0.94,
        metalness: 0.02,
        vertexColors: true,
      }),
    );

    this.waterMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.14,
        metalness: 0.35,
        transparent: true,
        opacity: 0.76,
        vertexColors: true,
      }),
    );

    this.asphaltMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.asphalt.map,
        normalMap: textures.asphalt.normalMap,
        roughnessMap: textures.asphalt.roughnessMap,
        roughness: 0.84,
        metalness: 0.05,
      }),
    );

    this.concreteMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.concrete.map,
        normalMap: textures.concrete.normalMap,
        roughnessMap: textures.concrete.roughnessMap,
        roughness: 0.92,
        metalness: 0.04,
      }),
    );

    this.woodMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.wood.map,
        normalMap: textures.wood.normalMap,
        roughnessMap: textures.wood.roughnessMap,
        roughness: 0.88,
        metalness: 0.05,
      }),
    );

    this.metalMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.rustedMetal.map,
        normalMap: textures.rustedMetal.normalMap,
        roughnessMap: textures.rustedMetal.roughnessMap,
        roughness: 0.65,
        metalness: 0.72,
      }),
    );

    this.darkSteelMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x26292c,
        roughness: 0.45,
        metalness: 0.82,
      }),
    );

    this.sandbagMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x746b57,
        roughness: 0.96,
        metalness: 0.02,
      }),
    );

    this.glassMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0x90a4aa,
        roughness: 0.16,
        metalness: 0.06,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );

    this.shardMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xaec4cc,
        roughness: 0.1,
        metalness: 0.1,
        transparent: true,
        opacity: 0.72,
      }),
    );

    this.powerlineMat = trackMat(
      new THREE.LineBasicMaterial({
        color: 0x1a1c1e,
        transparent: true,
        opacity: 0.78,
      }),
    );

    this.pineTrunkMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.wood.map,
        roughness: 0.94,
        color: 0x5c534a,
      }),
    );
    this.pineCanopyMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0.02,
      }),
    );
    this.birchTrunkMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xb9b4a8,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    this.grassTuftMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.95,
        metalness: 0.0,
        side: THREE.DoubleSide,
      }),
    );
    this.rockMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.concrete.map,
        roughness: 0.93,
        color: 0xffffff,
      }),
    );
    this.palmFrondMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3b5930,
        roughness: 0.85,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
    );

    // Prototype geometries (bottom-center pivoted)
    this.pineTrunkGeo = trackProto(new THREE.CylinderGeometry(0.13, 0.27, 7.2, 6));
    this.pineTrunkGeo.translate(0, 3.6, 0);

    const coneA = new THREE.ConeGeometry(2.1, 3.6, 7);
    coneA.translate(0, 5.2, 0);
    const coneB = new THREE.ConeGeometry(1.55, 3.0, 7);
    coneB.translate(0, 7.1, 0);
    this.pineCanopyGeo = trackProto(mergeGeometries([coneA, coneB], false)!);
    coneA.dispose();
    coneB.dispose();

    const bMain = new THREE.CylinderGeometry(0.11, 0.20, 6.2, 6);
    bMain.translate(0, 3.1, 0);
    const bBranch = new THREE.CylinderGeometry(0.04, 0.08, 2.2, 5);
    bBranch.rotateZ(0.68);
    bBranch.translate(0.75, 4.6, 0.1);
    this.birchTrunkGeo = trackProto(mergeGeometries([bMain, bBranch], false)!);
    bMain.dispose();
    bBranch.dispose();

    // Crossed grass tuft blades for stealth brush
    const blade1 = new THREE.PlaneGeometry(1.15, 0.95);
    blade1.translate(0, 0.44, 0);
    const blade2 = new THREE.PlaneGeometry(1.15, 0.95);
    blade2.rotateY(Math.PI / 3);
    blade2.translate(0, 0.44, 0);
    const blade3 = new THREE.PlaneGeometry(1.15, 0.95);
    blade3.rotateY(-Math.PI / 3);
    blade3.translate(0, 0.44, 0);
    this.grassTuftGeo = trackProto(mergeGeometries([blade1, blade2, blade3], false)!);
    blade1.dispose();
    blade2.dispose();
    blade3.dispose();

    this.rockGeo = trackProto(new THREE.DodecahedronGeometry(0.8, 1));
    this.fencePostGeo = trackProto(new THREE.BoxGeometry(0.14, 1.25, 0.14));
    this.fencePostGeo.translate(0, 0.62, 0);

    const palm1 = new THREE.ConeGeometry(2.0, 1.3, 6);
    palm1.scale(1, -0.45, 1);
    palm1.translate(0, 6.5, 0);
    this.palmFrondGeo = trackProto(palm1);

    this.shardGeo = trackProto(new THREE.BoxGeometry(0.09, 0.11, 0.015));
  }

  public getOrCreateDelta(chunkKey: string): ChunkDelta {
    let d = this.deltas.get(chunkKey);
    if (!d) {
      d = emptyDelta();
      this.deltas.set(chunkKey, d);
    }
    return d;
  }

  public markZombieKilled(worldX: number, worldZ: number, zombieId: string): void {
    const ck = makeChunkKey(worldToChunkCoord(worldX), worldToChunkCoord(worldZ));
    const d = this.getOrCreateDelta(ck);
    if (!d.killedZombieIds.includes(zombieId)) {
      d.killedZombieIds.push(zombieId);
    }
  }

  public setDoorOpenState(door: DoorEntity, isOpen: boolean): void {
    door.isOpen = isOpen;
    door.collider.minX = isOpen ? door.openBox.minX : door.closedBox.minX;
    door.collider.maxX = isOpen ? door.openBox.maxX : door.closedBox.maxX;
    door.collider.minZ = isOpen ? door.openBox.minZ : door.closedBox.minZ;
    door.collider.maxZ = isOpen ? door.openBox.maxZ : door.closedBox.maxZ;

    // Sync into WorldColliderIndex (stored in true world coordinates) & ChunkDelta
    for (const chunk of this.loadedChunks.values()) {
      if (chunk.doors.includes(door)) {
        this.colliderIndex.updateColliderXZ(
          chunk.key,
          door.collider.id,
          door.collider.minX + this.originX,
          door.collider.maxX + this.originX,
          door.collider.minZ + this.originZ,
          door.collider.maxZ + this.originZ,
        );
        const delta = this.getOrCreateDelta(chunk.key);
        delta.openedDoors[door.id] = isOpen;
        break;
      }
    }
  }

  /** Preload synchronous 3x3 active area at startup or save-load so frame 1 is complete */
  public preloadImmediateArea(worldX: number, worldZ: number): void {
    this.rebaseOriginToWorld(worldX, worldZ);
    const pcx = worldToChunkCoord(worldX);
    const pcz = worldToChunkCoord(worldZ);

    for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
      for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
        this.buildAndMountChunk(pcx + dx, pcz + dz);
      }
    }
    this.syncActiveRegion(worldX, worldZ);
  }

  public emitLoadedChunkZombies(): void {
    if (!this.onChunkZombiesReady) return;
    for (const [key, chunk] of this.loadedChunks.entries()) {
      const delta = this.deltas.get(key);
      const killedSet = new Set<string>(delta?.killedZombieIds ?? []);
      this.onChunkZombiesReady(key, chunk.zombieSpawns, killedSet);
    }
  }

  private rebaseOriginToWorld(worldX: number, worldZ: number): void {
    this.originX = Math.round(worldX / 32) * 32;
    this.originZ = Math.round(worldZ / 32) * 32;
    for (const chunk of this.loadedChunks.values()) {
      chunk.group.position.set(chunk.worldX0 - this.originX, 0, chunk.worldZ0 - this.originZ);
    }
  }

  /**
   * Shifts floating origin by multiples of 32m whenever local player coords approach ±36m,
   * ensuring BodycamController's internal [-55, 55] clamp is never hit.
   */
  public rebaseIfNeeded(
    playerLocalPos: THREE.Vector3,
    onShift: (shiftX: number, shiftZ: number) => void,
  ): void {
    let shiftX = 0;
    let shiftZ = 0;
    if (Math.abs(playerLocalPos.x) > 36) {
      shiftX = Math.trunc(playerLocalPos.x / 32) * 32;
    }
    if (Math.abs(playerLocalPos.z) > 36) {
      shiftZ = Math.trunc(playerLocalPos.z / 32) * 32;
    }
    if (shiftX === 0 && shiftZ === 0) return;

    this.originX += shiftX;
    this.originZ += shiftZ;
    playerLocalPos.x -= shiftX;
    playerLocalPos.z -= shiftZ;

    for (const chunk of this.loadedChunks.values()) {
      chunk.group.position.set(chunk.worldX0 - this.originX, 0, chunk.worldZ0 - this.originZ);
      for (const d of chunk.doors) {
        d.hingePos.x -= shiftX;
        d.hingePos.z -= shiftZ;
        d.closedBox.minX -= shiftX;
        d.closedBox.maxX -= shiftX;
        d.closedBox.minZ -= shiftZ;
        d.closedBox.maxZ -= shiftZ;
        d.openBox.minX -= shiftX;
        d.openBox.maxX -= shiftX;
        d.openBox.minZ -= shiftZ;
        d.openBox.maxZ -= shiftZ;
        d.collider.minX -= shiftX;
        d.collider.maxX -= shiftX;
        d.collider.minZ -= shiftZ;
        d.collider.maxZ -= shiftZ;
      }
      for (const c of chunk.containers) {
        c.position.x -= shiftX;
        c.position.z -= shiftZ;
      }
      for (const z of chunk.indoorZones) {
        z.minX -= shiftX;
        z.maxX -= shiftX;
        z.minZ -= shiftZ;
        z.maxZ -= shiftZ;
      }
    }

    for (const shard of this.glassShards) {
      shard.mesh.position.x -= shiftX;
      shard.mesh.position.z -= shiftZ;
    }

    onShift(shiftX, shiftZ);

    const worldX = this.originX + playerLocalPos.x;
    const worldZ = this.originZ + playerLocalPos.z;
    this.syncActiveRegion(worldX, worldZ);
  }

  /**
   * Time-sliced chunk streaming: unloads chunks outside 5x5, queues missing chunks
   * sorted closest-first, and builds AT MOST 1 queued chunk per animation frame.
   */
  public updateStreaming(playerLocalX: number, playerLocalZ: number, delta: number): void {
    const worldX = this.originX + playerLocalX;
    const worldZ = this.originZ + playerLocalZ;
    const pcx = worldToChunkCoord(worldX);
    const pcz = worldToChunkCoord(worldZ);

    // 1. Unload distant chunks (> VISUAL_RADIUS)
    for (const [key, chunk] of this.loadedChunks.entries()) {
      if (Math.abs(chunk.cx - pcx) > VISUAL_RADIUS || Math.abs(chunk.cz - pcz) > VISUAL_RADIUS) {
        this.unloadChunk(key, chunk);
      }
    }

    // 2. Refresh desired 5x5 build queue sorted closest-first
    this.buildQueue.length = 0;
    for (let dx = -VISUAL_RADIUS; dx <= VISUAL_RADIUS; dx++) {
      for (let dz = -VISUAL_RADIUS; dz <= VISUAL_RADIUS; dz++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const key = makeChunkKey(cx, cz);
        if (!this.loadedChunks.has(key)) {
          this.buildQueue.push({ cx, cz, key, distSq: dx * dx + dz * dz });
        }
      }
    }

    if (this.buildQueue.length > 0) {
      this.buildQueue.sort((a, b) => a.distSq - b.distSq);
      const next = this.buildQueue[0];
      this.buildAndMountChunk(next.cx, next.cz);
    }

    // 3. Refresh active 3x3 colliders / raycasts / doors / containers
    const activeKey = makeChunkKey(pcx, pcz);
    if (activeKey !== this.lastActiveCenterKey || this.buildQueue.length > 0) {
      this.lastActiveCenterKey = activeKey;
      this.syncActiveRegion(worldX, worldZ);
    } else {
      // Keep local collider array fresh around current worldX/worldZ
      this.colliderIndex.writeLocalCollidersNear(
        worldX,
        worldZ,
        this.originX,
        this.originZ,
        ACTIVE_RADIUS,
        this.activeColliders,
      );
    }

    // 4. Update falling glass shards
    for (let i = this.glassShards.length - 1; i >= 0; i--) {
      const sh = this.glassShards[i];
      sh.age += delta;
      sh.vel.y -= 9.81 * delta;
      sh.mesh.position.addScaledVector(sh.vel, delta);
      sh.mesh.rotation.x += sh.rotVel.x * delta;
      sh.mesh.rotation.y += sh.rotVel.y * delta;
      sh.mesh.rotation.z += sh.rotVel.z * delta;
      if (sh.age >= sh.maxAge) {
        this.worldGroup.remove(sh.mesh);
        this.glassShards.splice(i, 1);
      }
    }
  }

  private syncActiveRegion(worldX: number, worldZ: number): void {
    const pcx = worldToChunkCoord(worldX);
    const pcz = worldToChunkCoord(worldZ);

    this.colliderIndex.writeLocalCollidersNear(
      worldX,
      worldZ,
      this.originX,
      this.originZ,
      ACTIVE_RADIUS,
      this.activeColliders,
    );

    this.activeRaycastMeshes.length = 0;
    this.activeDoors.length = 0;
    this.activeContainers.length = 0;
    this.activeIndoorZones.length = 0;

    for (let dx = -ACTIVE_RADIUS; dx <= ACTIVE_RADIUS; dx++) {
      for (let dz = -ACTIVE_RADIUS; dz <= ACTIVE_RADIUS; dz++) {
        const chunk = this.loadedChunks.get(makeChunkKey(pcx + dx, pcz + dz));
        if (!chunk) continue;
        for (const m of chunk.raycastMeshes) this.activeRaycastMeshes.push(m);
        for (const d of chunk.doors) this.activeDoors.push(d);
        for (const c of chunk.containers) this.activeContainers.push(c);
        for (const iz of chunk.indoorZones) this.activeIndoorZones.push(iz);
      }
    }
  }

  private unloadChunk(key: string, chunk: LoadedChunk): void {
    // Persist latest container/door states into ChunkDelta
    const delta = this.getOrCreateDelta(key);
    for (const d of chunk.doors) {
      delta.openedDoors[d.id] = d.isOpen;
    }
    for (const c of chunk.containers) {
      delta.lootedContainers[c.id] = {
        ...c.state,
        items: c.state.items.map((it) => ({ ...it })),
      };
    }

    this.worldGroup.remove(chunk.group);
    for (const g of chunk.chunkGeos) {
      g.dispose();
    }
    for (const inst of chunk.instancedMeshes) {
      inst.dispose();
    }
    this.colliderIndex.unregisterChunk(key);
    this.loadedChunks.delete(key);
    this.onChunkUnloaded?.(key);
  }

  private buildAndMountChunk(cx: number, cz: number): void {
    const key = makeChunkKey(cx, cz);
    if (this.loadedChunks.has(key)) return;

    const worldX0 = cx * CHUNK_SIZE;
    const worldZ0 = cz * CHUNK_SIZE;
    const group = new THREE.Group();
    group.position.set(worldX0 - this.originX, 0, worldZ0 - this.originZ);
    this.worldGroup.add(group);

    const chunkGeos: THREE.BufferGeometry[] = [];
    const instancedMeshes: THREE.InstancedMesh[] = [];
    const raycastMeshes: THREE.Object3D[] = [];
    const worldColliders: BoxCollider[] = [];
    const doors: DoorEntity[] = [];
    const containers: ContainerEntity[] = [];
    const windows: WindowEntity[] = [];
    const indoorZones: IndoorZoneWorld[] = [];
    const stealthPatches: StealthPatch[] = [];
    const zombieSpawns: ChunkZombieSpawn[] = [];

    const delta = this.deltas.get(key);
    const rand = mulberry32(hashChunk(this.worldSeed, cx, cz, 11));

    // Geometry merge buckets per material (chunk-local coordinates 0..64)
    const buckets: Record<PoiMaterialKind | 'wood_penetrable' | 'asphalt', THREE.BufferGeometry[]> = {
      concrete: [],
      wood: [],
      wood_penetrable: [],
      rustedMetal: [],
      darkSteel: [],
      sandbag: [],
      asphalt: [],
    };

    const pushBoxToBucket = (
      lx: number,
      ly: number,
      lz: number,
      w: number,
      h: number,
      d: number,
      mat: PoiMaterialKind | 'asphalt',
      penetrableWood = false,
      rotY = 0,
    ) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      if (rotY !== 0) geo.rotateY(rotY);
      geo.translate(lx, ly, lz);
      const bucketKey = mat === 'wood' && penetrableWood ? 'wood_penetrable' : mat;
      buckets[bucketKey].push(geo);
    };

    // 1. Terrain Mesh (24x24 grid per 64m chunk) + Biome Vertex Colors + Water Sheet
    const segs = 24;
    const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
    terrainGeo.rotateX(-Math.PI / 2);
    terrainGeo.translate(CHUNK_SIZE * 0.5, 0, CHUNK_SIZE * 0.5);

    const posAttr = terrainGeo.attributes.position;
    const colors = new Float32Array(posAttr.count * 3);
    let minTerrainY = 999;

    for (let i = 0; i < posAttr.count; i++) {
      const lx = posAttr.getX(i);
      const lz = posAttr.getZ(i);
      const wx = worldX0 + lx;
      const wz = worldZ0 + lz;

      const h = this.roadNetwork.getTerrainHeight(wx, wz);
      posAttr.setY(i, h);
      if (h < minTerrainY) minTerrainY = h;

      const base = sampleTerrainBase(this.worldSeed, wx, wz);
      const road = this.roadNetwork.queryRoad(wx, wz);

      // Biome vertex tinting (subtle, gritty S.T.A.L.K.E.R. overcast palette)
      let r = 0.88;
      let g = 0.90;
      let b = 0.80;

      if (base.biome === 'desert') {
        r = 1.24;
        g = 1.06;
        b = 0.72;
      } else if (base.biome === 'oasis') {
        r = 0.58;
        g = 1.05;
        b = 0.58;
      } else if (base.biome === 'swamp') {
        r = 0.62;
        g = 0.68;
        b = 0.52;
      } else if (base.biome === 'mountains') {
        const rockTint = THREE.MathUtils.clamp((h - 3.0) / 10.0, 0, 1);
        r = THREE.MathUtils.lerp(0.78, 0.72, rockTint);
        g = THREE.MathUtils.lerp(0.82, 0.74, rockTint);
        b = THREE.MathUtils.lerp(0.72, 0.75, rockTint);
      } else if (base.biome === 'ocean' || h < WATER_LEVEL + 0.15) {
        r = 0.72;
        g = 0.70;
        b = 0.58;
      } else if (base.biome === 'forest_valley') {
        r = 0.74;
        g = 0.84;
        b = 0.68;
      }

      // Gravel shoulder blend along roads
      if (road.onShoulder || road.onAsphalt) {
        r = THREE.MathUtils.lerp(r, 0.68, 0.65);
        g = THREE.MathUtils.lerp(g, 0.67, 0.65);
        b = THREE.MathUtils.lerp(b, 0.63, 0.65);
      }

      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
    }

    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
    chunkGeos.push(terrainGeo);

    const terrainMesh = new THREE.Mesh(terrainGeo, this.terrainMat);
    terrainMesh.receiveShadow = true;
    terrainMesh.userData.surface = 'grass';
    group.add(terrainMesh);
    raycastMeshes.push(terrainMesh);

    // Water Surface when rivers/lakes/ponds/swamps/oasis/ocean dip below WATER_LEVEL
    if (minTerrainY < WATER_LEVEL + 0.08) {
      const waterGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, 12, 12);
      waterGeo.rotateX(-Math.PI / 2);
      waterGeo.translate(CHUNK_SIZE * 0.5, WATER_LEVEL, CHUNK_SIZE * 0.5);
      const wPos = waterGeo.attributes.position;
      const wCol = new Float32Array(wPos.count * 3);
      for (let i = 0; i < wPos.count; i++) {
        const wx = worldX0 + wPos.getX(i);
        const wz = worldZ0 + wPos.getZ(i);
        const s = sampleTerrainBase(this.worldSeed, wx, wz);
        if (s.oasisFactor > 0.25) {
          wCol[i * 3] = 0.14;
          wCol[i * 3 + 1] = 0.44;
          wCol[i * 3 + 2] = 0.42;
        } else if (s.biome === 'swamp') {
          wCol[i * 3] = 0.16;
          wCol[i * 3 + 1] = 0.20;
          wCol[i * 3 + 2] = 0.13;
        } else if (s.biome === 'ocean') {
          wCol[i * 3] = 0.12;
          wCol[i * 3 + 1] = 0.22;
          wCol[i * 3 + 2] = 0.28;
        } else {
          wCol[i * 3] = 0.17;
          wCol[i * 3 + 1] = 0.25;
          wCol[i * 3 + 2] = 0.24;
        }
      }
      waterGeo.setAttribute('color', new THREE.BufferAttribute(wCol, 3));
      chunkGeos.push(waterGeo);
      const waterMesh = new THREE.Mesh(waterGeo, this.waterMat);
      waterMesh.receiveShadow = true;
      group.add(waterMesh);
    }

    // 2. Seamless Macro Highways, Town Cluster Streets, Guardrails & Powerlines
    this.buildChunkRoads(
      cx,
      cz,
      worldX0,
      worldZ0,
      group,
      chunkGeos,
      raycastMeshes,
      worldColliders,
      buckets.asphalt,
      pushBoxToBucket,
    );

    // 3. POIs intersecting this chunk (only built by their owning center chunk so POIs never duplicate!)
    const candidatePois = this.roadNetwork.getPOIsIntersectingChunk(cx, cz);
    for (const poi of candidatePois) {
      const ownerCx = worldToChunkCoord(poi.centerX);
      const ownerCz = worldToChunkCoord(poi.centerZ);
      if (ownerCx !== cx || ownerCz !== cz) continue;

      this.buildPoiInChunk(
        poi,
        key,
        worldX0,
        worldZ0,
        group,
        chunkGeos,
        raycastMeshes,
        worldColliders,
        doors,
        containers,
        windows,
        indoorZones,
        zombieSpawns,
        delta,
        pushBoxToBucket,
      );
    }

    // Starter Roadside Pack in chunk (-1, 0) for immediate Wake-Up discovery
    if (cx === -1 && cz === 0) {
      const packX = -5.4;
      const packZ = 9.2;
      const packY = this.roadNetwork.getTerrainHeight(packX, packZ);
      const packId = 'roadside_pack';
      const defaultItems: InventoryItemInstance[] = [
        { uid: `st_fl_${this.worldSeed}`, itemId: 'flashlight', quantity: 1 },
        { uid: `st_pm_${this.worldSeed}`, itemId: 'weapon_pm_9x19', quantity: 1 },
        { uid: `st_mg_${this.worldSeed}`, itemId: 'mag_9x19_15', quantity: 1, rounds: 11 },
        { uid: `st_bd_${this.worldSeed}`, itemId: 'bandage', quantity: 2 },
      ];
      this.spawnContainerEntity(
        packId,
        'Dropped Field Pack',
        packX - worldX0,
        packY,
        packZ - worldZ0,
        packX - this.originX,
        packZ - this.originZ,
        'bag',
        defaultItems,
        delta?.lootedContainers[packId],
        group,
        chunkGeos,
        raycastMeshes,
        containers,
      );
    }

    // Restore player-dropped item pouches in this chunk
    if (delta && delta.droppedItems.length > 0) {
      for (const di of delta.droppedItems) {
        const [wx, wy, wz] = di.position;
        this.spawnContainerEntity(
          di.id,
          `Dropped ${ITEMS[di.item.itemId]?.shortName ?? 'Gear'}`,
          wx - worldX0,
          wy,
          wz - worldZ0,
          wx - this.originX,
          wz - this.originZ,
          'bag',
          [{ ...di.item }],
          delta.lootedContainers[di.id],
          group,
          chunkGeos,
          raycastMeshes,
          containers,
        );
      }
    }

    // 4. Roadside Rusted Car Hulks along highways (1-2 per highway chunk)
    this.buildRoadsideVehicles(
      cx,
      cz,
      worldX0,
      worldZ0,
      rand,
      worldColliders,
      pushBoxToBucket,
    );

    // 5. Merge Static Chunk Geometries per Material (Draw-Call Budgeting!)
    const matMap: Record<keyof typeof buckets, { mat: THREE.Material; surface: SurfaceType; penWood: boolean }> = {
      concrete: { mat: this.concreteMat, surface: 'concrete', penWood: false },
      wood: { mat: this.woodMat, surface: 'wood', penWood: false },
      wood_penetrable: { mat: this.woodMat, surface: 'wood', penWood: true },
      rustedMetal: { mat: this.metalMat, surface: 'metal', penWood: false },
      darkSteel: { mat: this.darkSteelMat, surface: 'metal', penWood: false },
      sandbag: { mat: this.sandbagMat, surface: 'concrete', penWood: false },
      asphalt: { mat: this.asphaltMat, surface: 'asphalt', penWood: false },
    };

    for (const [bKey, geoList] of Object.entries(buckets) as Array<[keyof typeof buckets, THREE.BufferGeometry[]]>) {
      if (geoList.length === 0) continue;
      const merged = geoList.length === 1 ? geoList[0] : mergeGeometries(geoList, false);
      if (geoList.length > 1) {
        for (const g of geoList) g.dispose();
      }
      if (!merged) continue;
      chunkGeos.push(merged);
      const cfg = matMap[bKey];
      const mesh = new THREE.Mesh(merged, cfg.mat);
      mesh.castShadow = bKey !== 'asphalt';
      mesh.receiveShadow = true;
      mesh.userData.surface = cfg.surface;
      mesh.userData.penetrableWood = cfg.penWood;
      group.add(mesh);
      raycastMeshes.push(mesh);
    }

    // 6. InstancedMesh Foliage, Stealth Brush, Fence Posts & Rocks
    this.buildChunkFoliage(
      cx,
      cz,
      worldX0,
      worldZ0,
      rand,
      candidatePois,
      group,
      instancedMeshes,
      worldColliders,
      stealthPatches,
    );

    // 7. Wilderness Zombie Spawns for chunk
    this.buildWildernessZombieSpawns(cx, cz, worldX0, worldZ0, rand, candidatePois, zombieSpawns);

    // Register colliders into spatial index
    this.colliderIndex.registerChunk(key, worldColliders);

    const chunk: LoadedChunk = {
      cx,
      cz,
      key,
      worldX0,
      worldZ0,
      group,
      chunkGeos,
      instancedMeshes,
      raycastMeshes,
      doors,
      containers,
      windows,
      indoorZones,
      stealthPatches,
      zombieSpawns,
    };
    this.loadedChunks.set(key, chunk);

    const killedSet = new Set<string>(delta?.killedZombieIds ?? []);
    this.onChunkZombiesReady?.(key, zombieSpawns, killedSet);
  }

  private buildChunkRoads(
    cx: number,
    cz: number,
    worldX0: number,
    worldZ0: number,
    group: THREE.Group,
    chunkGeos: THREE.BufferGeometry[],
    _raycastMeshes: THREE.Object3D[],
    worldColliders: BoxCollider[],
    asphaltGeos: THREE.BufferGeometry[],
    pushBoxToBucket: (
      lx: number,
      ly: number,
      lz: number,
      w: number,
      h: number,
      d: number,
      mat: PoiMaterialKind | 'asphalt',
      penetrableWood?: boolean,
      rotY?: number,
    ) => void,
  ): void {
    const buildRoadStrip = (isVertical: boolean, roadCoordWorld: number, width: number) => {
      const localCoord = isVertical ? roadCoordWorld - worldX0 : roadCoordWorld - worldZ0;
      if (localCoord < -width || localCoord > CHUNK_SIZE + width) return;

      const stripGeo = new THREE.PlaneGeometry(
        isVertical ? width : CHUNK_SIZE,
        isVertical ? CHUNK_SIZE : width,
        isVertical ? 2 : 16,
        isVertical ? 16 : 2,
      );
      stripGeo.rotateX(-Math.PI / 2);
      stripGeo.translate(
        isVertical ? localCoord : CHUNK_SIZE * 0.5,
        0,
        isVertical ? CHUNK_SIZE * 0.5 : localCoord,
      );

      const pos = stripGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const wx = worldX0 + pos.getX(i);
        const wz = worldZ0 + pos.getZ(i);
        pos.setY(i, this.roadNetwork.getTerrainHeight(wx, wz) + 0.032);
      }
      stripGeo.computeVertexNormals();
      asphaltGeos.push(stripGeo);
    };

    // Primary highways intersecting this chunk
    const nearestXIdx = Math.round((worldX0 + CHUNK_SIZE * 0.5 - PRIMARY_ROAD_X_OFFSET) / MACRO_BLOCK_SIZE);
    const primaryX = nearestXIdx * MACRO_BLOCK_SIZE + PRIMARY_ROAD_X_OFFSET;
    buildRoadStrip(true, primaryX, 7.4);

    const nearestZIdx = Math.round((worldZ0 + CHUNK_SIZE * 0.5 - PRIMARY_ROAD_Z_OFFSET) / MACRO_BLOCK_SIZE);
    const primaryZ = nearestZIdx * MACRO_BLOCK_SIZE + PRIMARY_ROAD_Z_OFFSET;
    buildRoadStrip(false, primaryZ, 7.4);

    // Secondary Town Cluster streets intersecting this chunk
    const bx = Math.floor((worldX0 + CHUNK_SIZE * 0.5 - PRIMARY_ROAD_X_OFFSET) / MACRO_BLOCK_SIZE);
    const bz = Math.floor((worldZ0 + CHUNK_SIZE * 0.5 - PRIMARY_ROAD_Z_OFFSET) / MACRO_BLOCK_SIZE);
    const block = this.roadNetwork.getMacroBlock(bx, bz);
    for (const st of block.secondaryStreets) {
      buildRoadStrip(st.axis === 'z', st.coord, st.halfWidth * 2);
    }

    // Rusted guardrails on bridge causeways & utility poles + sagging powerlines along primary highways
    const buildPolesAlongRoad = (isVertical: boolean, roadCoordWorld: number) => {
      const localCoord = isVertical ? roadCoordWorld - worldX0 : roadCoordWorld - worldZ0;
      if (localCoord < -10 || localCoord > CHUNK_SIZE + 10) return;

      const polePoints: THREE.Vector3[] = [];
      for (let step = 0; step <= CHUNK_SIZE; step += 32) {
        const lx = isVertical ? localCoord + 5.2 : step;
        const lz = isVertical ? step : localCoord + 5.2;
        if (lx < 0 || lx > CHUNK_SIZE || lz < 0 || lz > CHUNK_SIZE) continue;
        const wx = worldX0 + lx;
        const wz = worldZ0 + lz;
        const gy = this.roadNetwork.getTerrainHeight(wx, wz);

        if (step < CHUNK_SIZE) {
          // Pole shaft & crossarm
          pushBoxToBucket(lx, gy + 3.1, lz, 0.22, 6.2, 0.22, 'wood');
          pushBoxToBucket(
            lx,
            gy + 5.85,
            lz,
            isVertical ? 1.5 : 0.14,
            0.14,
            isVertical ? 0.14 : 1.5,
            'rustedMetal',
          );
          worldColliders.push({
            id: `pole_${cx}_${cz}_${step}`,
            minX: wx - 0.18,
            maxX: wx + 0.18,
            minY: gy,
            maxY: gy + 6,
            minZ: wz - 0.18,
            maxZ: wz + 0.18,
            surface: 'wood',
            blocksMovement: true,
            blocksVision: false,
          });
        }
        polePoints.push(new THREE.Vector3(lx, gy + 5.8, lz));
      }

      // Sagging powerline catenary between consecutive poles in chunk
      if (polePoints.length >= 2) {
        for (let i = 0; i < polePoints.length - 1; i++) {
          const p0 = polePoints[i];
          const p1 = polePoints[i + 1];
          for (const wireOffset of [-0.55, 0.55]) {
            const pts: THREE.Vector3[] = [];
            const segments = 8;
            for (let s = 0; s <= segments; s++) {
              const t = s / segments;
              const sag = Math.sin(t * Math.PI) * 0.65;
              const px = THREE.MathUtils.lerp(p0.x, p1.x, t) + (isVertical ? wireOffset : 0);
              const py = THREE.MathUtils.lerp(p0.y, p1.y, t) - sag;
              const pz = THREE.MathUtils.lerp(p0.z, p1.z, t) + (isVertical ? 0 : wireOffset);
              pts.push(new THREE.Vector3(px, py, pz));
            }
            const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
            chunkGeos.push(lineGeo);
            group.add(new THREE.Line(lineGeo, this.powerlineMat));
          }
        }
      }

      // Guardrail posts if crossing water (bridge causeway)
      for (let step = 4; step < CHUNK_SIZE; step += 4) {
        const lx = isVertical ? localCoord : step;
        const lz = isVertical ? step : localCoord;
        const wx = worldX0 + lx;
        const wz = worldZ0 + lz;
        const rInfo = this.roadNetwork.queryRoad(wx, wz);
        if (rInfo.isBridgeCauseway) {
          const gy = this.roadNetwork.getTerrainHeight(wx, wz);
          for (const side of [-3.95, 3.95]) {
            const rx = isVertical ? localCoord + side : step;
            const rz = isVertical ? step : localCoord + side;
            pushBoxToBucket(
              rx,
              gy + 0.45,
              rz,
              isVertical ? 0.14 : 3.9,
              0.72,
              isVertical ? 3.9 : 0.14,
              'rustedMetal',
            );
            worldColliders.push({
              id: `guard_${cx}_${cz}_${step}_${side}`,
              minX: worldX0 + rx - (isVertical ? 0.12 : 1.95),
              maxX: worldX0 + rx + (isVertical ? 0.12 : 1.95),
              minY: gy,
              maxY: gy + 0.9,
              minZ: worldZ0 + rz - (isVertical ? 1.95 : 0.12),
              maxZ: worldZ0 + rz + (isVertical ? 1.95 : 0.12),
              surface: 'metal',
              blocksMovement: true,
              blocksVision: false,
            });
          }
        }
      }
    };

    buildPolesAlongRoad(true, primaryX);
    buildPolesAlongRoad(false, primaryZ);
  }

  private buildPoiInChunk(
    poi: PoiPlacement,
    chunkKey: string,
    worldX0: number,
    worldZ0: number,
    group: THREE.Group,
    chunkGeos: THREE.BufferGeometry[],
    raycastMeshes: THREE.Object3D[],
    worldColliders: BoxCollider[],
    doors: DoorEntity[],
    containers: ContainerEntity[],
    windows: WindowEntity[],
    indoorZones: IndoorZoneWorld[],
    zombieSpawns: ChunkZombieSpawn[],
    delta: ChunkDelta | undefined,
    pushBoxToBucket: (
      lx: number,
      ly: number,
      lz: number,
      w: number,
      h: number,
      d: number,
      mat: PoiMaterialKind | 'asphalt',
      penetrableWood?: boolean,
      rotY?: number,
    ) => void,
  ): void {
    const tpl = POI_TEMPLATES[poi.templateId];
    const turns = poi.rotQuarterTurns;

    const addPoiBox = (b: PoiBoxDef, idxTag: string) => {
      const off = rotateLocalOffset(b.x, b.z, turns);
      const ext = rotateBoxExtents(b.w, b.d, turns);
      const wx = poi.centerX + off.x;
      const wy = poi.baseY + b.y;
      const wz = poi.centerZ + off.z;

      pushBoxToBucket(wx - worldX0, wy, wz - worldZ0, ext.w, b.h, ext.d, b.material, Boolean(b.penetrableWood));

      if (b.blocksMovement !== false) {
        worldColliders.push({
          id: `${poi.id}_${idxTag}`,
          minX: wx - ext.w * 0.5,
          maxX: wx + ext.w * 0.5,
          minY: wy - b.h * 0.5,
          maxY: wy + b.h * 0.5,
          minZ: wz - ext.d * 0.5,
          maxZ: wz + ext.d * 0.5,
          surface: b.surface,
          penetrableWood: Boolean(b.penetrableWood),
          blocksMovement: true,
          blocksVision: b.blocksVision ?? true,
        });
      }
    };

    tpl.structureBoxes.forEach((b, i) => addPoiBox(b, `s${i}`));
    tpl.propBoxes.forEach((b, i) => addPoiBox(b, `p${i}`));

    // Interior zones in scene-local coordinates
    for (const iz of tpl.interiorZones) {
      const p1 = rotateLocalOffset(iz.minX, iz.minZ, turns);
      const p2 = rotateLocalOffset(iz.maxX, iz.maxZ, turns);
      indoorZones.push({
        minX: poi.centerX + Math.min(p1.x, p2.x) - this.originX,
        maxX: poi.centerX + Math.max(p1.x, p2.x) - this.originX,
        minZ: poi.centerZ + Math.min(p1.z, p2.z) - this.originZ,
        maxZ: poi.centerZ + Math.max(p1.z, p2.z) - this.originZ,
        floorSurface: iz.floorSurface,
        acoustics: iz.acoustics,
      });
    }

    // Breakable Glass Windows
    const brokenSet = new Set<string>(delta?.brokenWindows ?? []);
    for (const wDef of tpl.windows) {
      const winId = `${poi.id}_${wDef.idSuffix}`;
      if (brokenSet.has(winId)) continue;

      const off = rotateLocalOffset(wDef.x, wDef.z, turns);
      const ext = rotateBoxExtents(wDef.w, wDef.d, turns);
      const wx = poi.centerX + off.x;
      const wy = poi.baseY + wDef.y;
      const wz = poi.centerZ + off.z;

      const geo = new THREE.BoxGeometry(ext.w, wDef.h, ext.d);
      chunkGeos.push(geo);
      const pane = new THREE.Mesh(geo, this.glassMat);
      pane.position.set(wx - worldX0, wy, wz - worldZ0);
      pane.userData.windowId = winId;
      pane.userData.chunkKey = chunkKey;
      pane.userData.isGlass = true;
      pane.userData.surface = 'concrete';
      group.add(pane);
      raycastMeshes.push(pane);

      const colliderId = `win_${winId}`;
      worldColliders.push({
        id: colliderId,
        minX: wx - Math.max(0.1, ext.w * 0.5),
        maxX: wx + Math.max(0.1, ext.w * 0.5),
        minY: wy - wDef.h * 0.5,
        maxY: wy + wDef.h * 0.5,
        minZ: wz - Math.max(0.1, ext.d * 0.5),
        maxZ: wz + Math.max(0.1, ext.d * 0.5),
        surface: 'concrete',
        blocksMovement: true,
        blocksVision: false, // Zombies see through unbroken glass!
      });

      windows.push({
        id: winId,
        chunkKey,
        mesh: pane,
        colliderId,
        worldPos: new THREE.Vector3(wx, wy, wz),
        broken: false,
      });
    }

    // Interactive Hinged Doors
    for (const dDef of tpl.doors) {
      const doorId = `${poi.id}_${dDef.idSuffix}`;
      const isOpen = delta?.openedDoors[doorId] ?? false;

      const off = rotateLocalOffset(dDef.hingeX, dDef.hingeZ, turns);
      const hxWorld = poi.centerX + off.x;
      const hyWorld = poi.baseY + 0.14;
      const hzWorld = poi.centerZ + off.z;

      const closedAngle = dirToAngle(dDef.closedDir, turns);
      const openAngle = dirToAngle(dDef.openDir, turns);

      const pivot = new THREE.Group();
      pivot.position.set(hxWorld - worldX0, hyWorld, hzWorld - worldZ0);
      pivot.rotation.y = isOpen ? openAngle : closedAngle;
      group.add(pivot);

      const doorGeo = new THREE.BoxGeometry(dDef.width, 2.12, 0.09);
      chunkGeos.push(doorGeo);
      const doorMat = dDef.material === 'metal' ? this.metalMat : this.woodMat;
      const doorMesh = new THREE.Mesh(doorGeo, doorMat);
      doorMesh.position.set(dDef.width * 0.5, 1.06, 0);
      doorMesh.castShadow = true;
      doorMesh.receiveShadow = true;
      doorMesh.userData.surface = dDef.material;
      doorMesh.userData.penetrableWood = dDef.material === 'wood';
      doorMesh.userData.doorId = doorId;
      pivot.add(doorMesh);

      const handleGeo = new THREE.BoxGeometry(0.14, 0.05, 0.15);
      chunkGeos.push(handleGeo);
      const handle = new THREE.Mesh(handleGeo, this.darkSteelMat);
      handle.position.set(dDef.width - 0.14, 1.0, 0);
      pivot.add(handle);

      raycastMeshes.push(doorMesh);

      const closedWorld = dirToBox(hxWorld, hzWorld, dDef.width, dDef.closedDir, turns, hyWorld, hyWorld + 2.16);
      const openWorld = dirToBox(hxWorld, hzWorld, dDef.width, dDef.openDir, turns, hyWorld, hyWorld + 2.16);
      const activeWorld = isOpen ? openWorld : closedWorld;

      const colliderId = `door_${doorId}`;
      worldColliders.push({
        id: colliderId,
        ...activeWorld,
        surface: dDef.material,
        penetrableWood: dDef.material === 'wood',
        blocksMovement: true,
        blocksVision: true,
      });

      const localDoorCollider: BoxCollider = {
        id: colliderId,
        minX: activeWorld.minX - this.originX,
        maxX: activeWorld.maxX - this.originX,
        minY: activeWorld.minY,
        maxY: activeWorld.maxY,
        minZ: activeWorld.minZ - this.originZ,
        maxZ: activeWorld.maxZ - this.originZ,
        surface: dDef.material,
        penetrableWood: dDef.material === 'wood',
        blocksMovement: true,
        blocksVision: true,
      };

      doors.push({
        id: doorId,
        label: dDef.label,
        pivot,
        mesh: doorMesh,
        isOpen,
        currentAngle: isOpen ? openAngle : closedAngle,
        closedAngle,
        openAngle,
        hingePos: new THREE.Vector3(hxWorld - this.originX, hyWorld + 1.0, hzWorld - this.originZ),
        collider: localDoorCollider,
        closedBox: {
          minX: closedWorld.minX - this.originX,
          maxX: closedWorld.maxX - this.originX,
          minY: closedWorld.minY,
          maxY: closedWorld.maxY,
          minZ: closedWorld.minZ - this.originZ,
          maxZ: closedWorld.maxZ - this.originZ,
        },
        openBox: {
          minX: openWorld.minX - this.originX,
          maxX: openWorld.maxX - this.originX,
          minY: openWorld.minY,
          maxY: openWorld.maxY,
          minZ: openWorld.minZ - this.originZ,
          maxZ: openWorld.maxZ - this.originZ,
        },
      });
    }

    // Lootable Containers
    for (const cDef of tpl.containers) {
      const containerId = `${poi.id}_${cDef.idSuffix}`;
      const off = rotateLocalOffset(cDef.x, cDef.z, turns);
      const wx = poi.centerX + off.x;
      const wy = poi.baseY + cDef.y;
      const wz = poi.centerZ + off.z;

      const defaultItems = this.rollContainerLoot(chunkKey, containerId, cDef.lootTable);
      this.spawnContainerEntity(
        containerId,
        cDef.label,
        wx - worldX0,
        wy,
        wz - worldZ0,
        wx - this.originX,
        wz - this.originZ,
        cDef.style,
        defaultItems,
        delta?.lootedContainers[containerId],
        group,
        chunkGeos,
        raycastMeshes,
        containers,
      );
    }

    // Optional subtle interior bounce light for deep dark bunkers/stores
    if (tpl.dimLightOffset) {
      const lo = rotateLocalOffset(tpl.dimLightOffset[0], tpl.dimLightOffset[2], turns);
      const l = new THREE.PointLight(0x6e808a, 0.28, 12, 1.9);
      l.position.set(poi.centerX + lo.x - worldX0, poi.baseY + tpl.dimLightOffset[1], poi.centerZ + lo.z - worldZ0);
      group.add(l);
    }

    // Deterministic POI zombie spawns
    const zRand = mulberry32(hashChunk(this.worldSeed, Math.round(poi.centerX), Math.round(poi.centerZ), 77));
    tpl.zombieSpawns.forEach((zs, idx) => {
      if (zRand() <= zs.chance) {
        const off = rotateLocalOffset(zs.x, zs.z, turns);
        const wx = poi.centerX + off.x;
        const wz = poi.centerZ + off.z;
        zombieSpawns.push({
          id: `${poi.id}_z${idx}`,
          archetypeId: zs.archetype,
          worldX: wx,
          worldY: poi.baseY + 0.14,
          worldZ: wz,
          yaw: zRand() * Math.PI * 2,
        });
      }
    });
  }

  private rollContainerLoot(chunkKey: string, containerId: string, tableId: LootTableId): InventoryItemInstance[] {
    const tbl = LOOT_TABLES[tableId];
    let seed = this.worldSeed;
    for (let i = 0; i < containerId.length; i++) {
      seed = (Math.imul(seed, 31) + containerId.charCodeAt(i)) | 0;
    }
    const rand = mulberry32(seed >>> 0);

    const totalWeight = tbl.entries.reduce((acc, e) => acc + e.weight, 0);
    const rolls =
      tbl.minRolls + Math.floor(rand() * (tbl.maxRolls - tbl.minRolls + 1));

    const items: InventoryItemInstance[] = [];
    for (let r = 0; r < rolls; r++) {
      let pick = rand() * totalWeight;
      let chosen = tbl.entries[0];
      for (const e of tbl.entries) {
        pick -= e.weight;
        if (pick <= 0) {
          chosen = e;
          break;
        }
      }
      const spec = ITEMS[chosen.itemId];
      if (!spec) continue;
      const qty = chosen.minQty + Math.floor(rand() * (chosen.maxQty - chosen.minQty + 1));
      const inst: InventoryItemInstance = {
        uid: `loot_${chunkKey}_${containerId}_${r}`,
        itemId: chosen.itemId,
        quantity: qty,
      };
      if (spec.category === 'magazine' && spec.magCapacity) {
        const fMin = chosen.magFillMin ?? 0.35;
        const fMax = chosen.magFillMax ?? 1.0;
        const frac = fMin + rand() * (fMax - fMin);
        inst.rounds = Math.max(1, Math.min(spec.magCapacity, Math.round(spec.magCapacity * frac)));
      }
      items.push(inst);
    }
    return items;
  }

  private spawnContainerEntity(
    id: string,
    label: string,
    chunkLocalX: number,
    y: number,
    chunkLocalZ: number,
    sceneLocalX: number,
    sceneLocalZ: number,
    style: 'bag' | 'crate' | 'locker',
    defaultItems: InventoryItemInstance[],
    savedState: ContainerLootState | undefined,
    group: THREE.Group,
    chunkGeos: THREE.BufferGeometry[],
    raycastMeshes: THREE.Object3D[],
    containers: ContainerEntity[],
  ): void {
    const cGroup = new THREE.Group();
    cGroup.position.set(chunkLocalX, y, chunkLocalZ);
    group.add(cGroup);

    let lid: THREE.Object3D | undefined;
    if (style === 'bag') {
      const bGeo = new THREE.BoxGeometry(0.65, 0.34, 0.42);
      const sGeo = new THREE.BoxGeometry(0.67, 0.08, 0.16);
      chunkGeos.push(bGeo, sGeo);
      const body = new THREE.Mesh(bGeo, this.woodMat);
      body.position.y = 0.17;
      body.castShadow = true;
      body.userData.containerId = id;
      const strap = new THREE.Mesh(sGeo, this.darkSteelMat);
      strap.position.y = 0.25;
      strap.userData.containerId = id;
      cGroup.add(body, strap);
      raycastMeshes.push(body, strap);
    } else if (style === 'locker') {
      const lGeo = new THREE.BoxGeometry(0.75, 1.45, 0.55);
      chunkGeos.push(lGeo);
      const body = new THREE.Mesh(lGeo, this.metalMat);
      body.position.y = 0.725;
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.containerId = id;
      cGroup.add(body);
      raycastMeshes.push(body);
    } else {
      const cGeo = new THREE.BoxGeometry(0.95, 0.42, 0.52);
      const lidGeo = new THREE.BoxGeometry(0.98, 0.08, 0.55);
      chunkGeos.push(cGeo, lidGeo);
      const body = new THREE.Mesh(cGeo, this.woodMat);
      body.position.y = 0.21;
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.containerId = id;
      const lidMesh = new THREE.Mesh(lidGeo, this.metalMat);
      lidMesh.position.set(0, 0.45, 0);
      lidMesh.userData.containerId = id;
      cGroup.add(body, lidMesh);
      lid = lidMesh;
      raycastMeshes.push(body, lidMesh);
    }

    const state: ContainerLootState = savedState
      ? { ...savedState, items: savedState.items.map((it) => ({ ...it })) }
      : { id, label, searched: false, items: defaultItems };

    containers.push({
      id,
      label,
      mesh: cGroup,
      position: new THREE.Vector3(sceneLocalX, y + 0.35, sceneLocalZ),
      lidMesh: lid,
      state,
    });
  }

  private buildRoadsideVehicles(
    cx: number,
    cz: number,
    worldX0: number,
    worldZ0: number,
    rand: () => number,
    worldColliders: BoxCollider[],
    pushBoxToBucket: (
      lx: number,
      ly: number,
      lz: number,
      w: number,
      h: number,
      d: number,
      mat: PoiMaterialKind | 'asphalt',
      penetrableWood?: boolean,
      rotY?: number,
    ) => void,
  ): void {
    // Starter car hulk matching Milestone 1 clearing sightline at (-15.5, 14.5)
    const cars: Array<{ wx: number; wz: number; rotY: number; id: string }> = [];
    if (cx === -1 && cz === 0) {
      cars.push({ wx: -15.5, wz: 14.5, rotY: 0.28, id: 'car_starter' });
    } else if (rand() < 0.32) {
      const lx = 10 + rand() * 44;
      const lz = 10 + rand() * 44;
      const wx = worldX0 + lx;
      const wz = worldZ0 + lz;
      const rInfo = this.roadNetwork.queryRoad(wx, wz);
      if (rInfo.nearestPrimaryDist < 12) {
        cars.push({ wx, wz, rotY: rand() * Math.PI, id: `car_${cx}_${cz}` });
      }
    }

    for (const car of cars) {
      const lx = car.wx - worldX0;
      const lz = car.wz - worldZ0;
      const gy = this.roadNetwork.getTerrainHeight(car.wx, car.wz);
      // Composite body + cabin + 4 wheels
      pushBoxToBucket(lx, gy + 0.62, lz, 1.85, 0.68, 4.2, 'rustedMetal', false, car.rotY);
      pushBoxToBucket(lx, gy + 1.22, lz, 1.55, 0.56, 2.05, 'rustedMetal', false, car.rotY);
      for (const [wxOff, wzOff] of [[-0.88, 1.3], [0.88, 1.3], [-0.88, -1.35], [0.88, -1.35]]) {
        const c = Math.cos(car.rotY);
        const s = Math.sin(car.rotY);
        const rx = lx + wxOff * c + wzOff * s;
        const rz = lz - wxOff * s + wzOff * c;
        pushBoxToBucket(rx, gy + 0.32, rz, 0.24, 0.64, 0.64, 'darkSteel', false, car.rotY);
      }

      worldColliders.push({
        id: car.id,
        minX: car.wx - 1.45,
        maxX: car.wx + 1.45,
        minY: gy,
        maxY: gy + 1.6,
        minZ: car.wz - 2.1,
        maxZ: car.wz + 2.1,
        surface: 'metal',
        blocksMovement: true,
        blocksVision: true,
      });
    }
  }

  private buildChunkFoliage(
    cx: number,
    cz: number,
    worldX0: number,
    worldZ0: number,
    rand: () => number,
    pois: PoiPlacement[],
    group: THREE.Group,
    instancedMeshes: THREE.InstancedMesh[],
    worldColliders: BoxCollider[],
    stealthPatches: StealthPatch[],
  ): void {
    const dummy = this._dummy;
    const color = this._color;

    const isClearForProp = (wx: number, wz: number): boolean => {
      // Keep starter wake-up sightline clearing open
      if (Math.hypot(wx + 4.2, wz - 16.5) < 11.5) return false;
      const road = this.roadNetwork.queryRoad(wx, wz);
      if (road.onAsphalt || road.onShoulder || road.roadInfluence > 0.45) return false;
      for (const p of pois) {
        if (Math.abs(wx - p.centerX) < p.halfW + 3.0 && Math.abs(wz - p.centerZ) < p.halfD + 3.0) {
          return false;
        }
      }
      return true;
    };

    const maxTrees = 38;
    const pineMatrices: THREE.Matrix4[] = [];
    const pineColors: THREE.Color[] = [];
    const birchMatrices: THREE.Matrix4[] = [];
    const palmCanopyMatrices: THREE.Matrix4[] = [];

    for (let i = 0; i < maxTrees; i++) {
      const lx = 2 + rand() * (CHUNK_SIZE - 4);
      const lz = 2 + rand() * (CHUNK_SIZE - 4);
      const wx = worldX0 + lx;
      const wz = worldZ0 + lz;
      if (!isClearForProp(wx, wz)) continue;

      const s = sampleTerrainBase(this.worldSeed, wx, wz);
      if (s.rawHeight < WATER_LEVEL + 0.05) continue;
      if (s.biome === 'desert' && s.oasisFactor < 0.2) continue;

      const gy = this.roadNetwork.getTerrainHeight(wx, wz);
      const scale = 0.78 + rand() * 0.62;
      dummy.position.set(lx, gy - 0.1, lz);
      dummy.rotation.set((rand() - 0.5) * 0.08, rand() * Math.PI * 2, (rand() - 0.5) * 0.08);
      dummy.scale.set(scale, scale * (0.85 + rand() * 0.35), scale);
      dummy.updateMatrix();

      if (s.biome === 'oasis') {
        birchMatrices.push(dummy.matrix.clone());
        palmCanopyMatrices.push(dummy.matrix.clone());
      } else if (s.biome === 'swamp' || rand() < 0.24) {
        birchMatrices.push(dummy.matrix.clone());
      } else {
        pineMatrices.push(dummy.matrix.clone());
        const shade = s.biome === 'forest_valley' ? 0.8 + rand() * 0.35 : 0.72 + rand() * 0.38;
        pineColors.push(new THREE.Color(0.18 * shade, 0.23 * shade, 0.16 * shade));
      }

      worldColliders.push({
        id: `tree_${cx}_${cz}_${i}`,
        minX: wx - 0.28 * scale,
        maxX: wx + 0.28 * scale,
        minY: gy,
        maxY: gy + 5.0,
        minZ: wz - 0.28 * scale,
        maxZ: wz + 0.28 * scale,
        surface: 'wood',
        blocksMovement: true,
        blocksVision: true,
      });
    }

    if (pineMatrices.length > 0) {
      const trunkInst = new THREE.InstancedMesh(this.pineTrunkGeo, this.pineTrunkMat, pineMatrices.length);
      const canopyInst = new THREE.InstancedMesh(this.pineCanopyGeo, this.pineCanopyMat, pineMatrices.length);
      trunkInst.castShadow = true;
      trunkInst.receiveShadow = true;
      canopyInst.castShadow = true;
      for (let i = 0; i < pineMatrices.length; i++) {
        trunkInst.setMatrixAt(i, pineMatrices[i]);
        canopyInst.setMatrixAt(i, pineMatrices[i]);
        canopyInst.setColorAt(i, pineColors[i]);
      }
      trunkInst.instanceMatrix.needsUpdate = true;
      canopyInst.instanceMatrix.needsUpdate = true;
      if (canopyInst.instanceColor) canopyInst.instanceColor.needsUpdate = true;
      trunkInst.computeBoundingSphere();
      canopyInst.computeBoundingSphere();
      group.add(trunkInst, canopyInst);
      instancedMeshes.push(trunkInst, canopyInst);
    }

    if (birchMatrices.length > 0) {
      const birchInst = new THREE.InstancedMesh(this.birchTrunkGeo, this.birchTrunkMat, birchMatrices.length);
      birchInst.castShadow = true;
      birchInst.receiveShadow = true;
      for (let i = 0; i < birchMatrices.length; i++) {
        birchInst.setMatrixAt(i, birchMatrices[i]);
      }
      birchInst.instanceMatrix.needsUpdate = true;
      birchInst.computeBoundingSphere();
      group.add(birchInst);
      instancedMeshes.push(birchInst);
    }

    if (palmCanopyMatrices.length > 0) {
      const palmInst = new THREE.InstancedMesh(this.palmFrondGeo, this.palmFrondMat, palmCanopyMatrices.length);
      palmInst.castShadow = true;
      for (let i = 0; i < palmCanopyMatrices.length; i++) {
        palmInst.setMatrixAt(i, palmCanopyMatrices[i]);
      }
      palmInst.instanceMatrix.needsUpdate = true;
      palmInst.computeBoundingSphere();
      group.add(palmInst);
      instancedMeshes.push(palmInst);
    }

    // Stealth Grass / Tall Brush Patches (crouching inside halves zombie visual detection!)
    const maxTufts = 90;
    const tuftMats: THREE.Matrix4[] = [];
    const tuftColors: THREE.Color[] = [];

    const patchCount = 7;
    for (let p = 0; p < patchCount; p++) {
      const plx = 6 + rand() * (CHUNK_SIZE - 12);
      const plz = 6 + rand() * (CHUNK_SIZE - 12);
      const pwx = worldX0 + plx;
      const pwz = worldZ0 + plz;
      if (!isClearForProp(pwx, pwz)) continue;
      const s = sampleTerrainBase(this.worldSeed, pwx, pwz);
      if (s.rawHeight < WATER_LEVEL - 0.1 || s.biome === 'ocean') continue;

      const patchRad = 2.6 + rand() * 1.4;
      stealthPatches.push({ wx: pwx, wz: pwz, radius: patchRad });

      const tuftsInPatch = 10 + Math.floor(rand() * 5);
      for (let t = 0; t < tuftsInPatch && tuftMats.length < maxTufts; t++) {
        const ang = rand() * Math.PI * 2;
        const dist = rand() * patchRad;
        const lx = plx + Math.cos(ang) * dist;
        const lz = plz + Math.sin(ang) * dist;
        const wx = worldX0 + lx;
        const wz = worldZ0 + lz;
        const gy = this.roadNetwork.getTerrainHeight(wx, wz);

        const sc = 0.85 + rand() * 0.55;
        dummy.position.set(lx, gy - 0.05, lz);
        dummy.rotation.set(0, rand() * Math.PI, 0);
        dummy.scale.set(sc, sc * (0.9 + rand() * 0.45), sc);
        dummy.updateMatrix();
        tuftMats.push(dummy.matrix.clone());

        if (s.biome === 'desert') {
          color.setRGB(0.42 + rand() * 0.12, 0.36 + rand() * 0.1, 0.22);
        } else if (s.biome === 'swamp') {
          color.setRGB(0.24 + rand() * 0.08, 0.28 + rand() * 0.08, 0.18);
        } else {
          color.setRGB(0.28 + rand() * 0.1, 0.32 + rand() * 0.1, 0.20);
        }
        tuftColors.push(color.clone());
      }
    }

    if (tuftMats.length > 0) {
      const grassInst = new THREE.InstancedMesh(this.grassTuftGeo, this.grassTuftMat, tuftMats.length);
      grassInst.receiveShadow = true;
      for (let i = 0; i < tuftMats.length; i++) {
        grassInst.setMatrixAt(i, tuftMats[i]);
        grassInst.setColorAt(i, tuftColors[i]);
      }
      grassInst.instanceMatrix.needsUpdate = true;
      if (grassInst.instanceColor) grassInst.instanceColor.needsUpdate = true;
      grassInst.computeBoundingSphere();
      group.add(grassInst);
      instancedMeshes.push(grassInst);
    }

    // Scattered Boulders / Concrete Rubble (InstancedMesh)
    const rockCount = 12;
    const rockInst = new THREE.InstancedMesh(this.rockGeo, this.rockMat, rockCount);
    rockInst.castShadow = true;
    rockInst.receiveShadow = true;
    let placedRocks = 0;
    for (let i = 0; i < rockCount; i++) {
      const lx = 3 + rand() * (CHUNK_SIZE - 6);
      const lz = 3 + rand() * (CHUNK_SIZE - 6);
      const wx = worldX0 + lx;
      const wz = worldZ0 + lz;
      if (!isClearForProp(wx, wz)) continue;
      const gy = this.roadNetwork.getTerrainHeight(wx, wz);
      const s = 0.5 + rand() * 1.1;
      dummy.position.set(lx, gy + 0.15 * s, lz);
      dummy.rotation.set(rand() * 2, rand() * 2, rand() * 2);
      dummy.scale.set(s * 1.2, s * 0.72, s);
      dummy.updateMatrix();
      rockInst.setMatrixAt(placedRocks, dummy.matrix);
      color.setScalar(0.38 + rand() * 0.18);
      rockInst.setColorAt(placedRocks, color);
      placedRocks++;
    }
    if (placedRocks > 0) {
      rockInst.count = placedRocks;
      rockInst.instanceMatrix.needsUpdate = true;
      if (rockInst.instanceColor) rockInst.instanceColor.needsUpdate = true;
      rockInst.computeBoundingSphere();
      group.add(rockInst);
      instancedMeshes.push(rockInst);
    } else {
      rockInst.dispose();
    }

    // Rusted Fence Posts near POIs (InstancedMesh)
    if (pois.length > 0) {
      const postMats: THREE.Matrix4[] = [];
      for (const poi of pois) {
        if (worldToChunkCoord(poi.centerX) !== cx || worldToChunkCoord(poi.centerZ) !== cz) continue;
        for (let k = -2; k <= 2; k++) {
          const wx = poi.centerX + (poi.halfW + 1.8) * (k % 2 === 0 ? 1 : -1);
          const wz = poi.centerZ + k * 2.4;
          const lx = wx - worldX0;
          const lz = wz - worldZ0;
          if (lx < 1 || lx > CHUNK_SIZE - 1 || lz < 1 || lz > CHUNK_SIZE - 1) continue;
          const gy = this.roadNetwork.getTerrainHeight(wx, wz);
          dummy.position.set(lx, gy, lz);
          dummy.rotation.set((rand() - 0.5) * 0.12, 0, (rand() - 0.5) * 0.12);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          postMats.push(dummy.matrix.clone());
        }
      }
      if (postMats.length > 0) {
        const postInst = new THREE.InstancedMesh(this.fencePostGeo, this.birchTrunkMat, postMats.length);
        postInst.castShadow = true;
        for (let i = 0; i < postMats.length; i++) postInst.setMatrixAt(i, postMats[i]);
        postInst.instanceMatrix.needsUpdate = true;
        postInst.computeBoundingSphere();
        group.add(postInst);
        instancedMeshes.push(postInst);
      }
    }
  }

  private buildWildernessZombieSpawns(
    cx: number,
    cz: number,
    worldX0: number,
    worldZ0: number,
    rand: () => number,
    pois: PoiPlacement[],
    out: ChunkZombieSpawn[],
  ): void {
    // Keep immediate starter wake-up area safe (only mild perimeter threat like Milestone 1)
    if (cx === -1 && cz === 0) {
      out.push({
        id: 'z_starter_road_n',
        archetypeId: 'infected_walker',
        worldX: -13.5,
        worldY: this.roadNetwork.getTerrainHeight(-13.5, -18),
        worldZ: -18.0,
        yaw: 0.2,
      });
      out.push({
        id: 'z_starter_clearing_w',
        archetypeId: 'infected_walker',
        worldX: -23.5,
        worldY: this.roadNetwork.getTerrainHeight(-23.5, 4.5),
        worldZ: 4.5,
        yaw: 1.4,
      });
      return;
    }

    const count = rand() < 0.65 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const wx = worldX0 + 8 + rand() * (CHUNK_SIZE - 16);
      const wz = worldZ0 + 8 + rand() * (CHUNK_SIZE - 16);
      if (Math.hypot(wx + 4.2, wz - 16.5) < 22) continue;
      const base = sampleTerrainBase(this.worldSeed, wx, wz);
      if (base.rawHeight < WATER_LEVEL + 0.05 || base.biome === 'ocean') continue;
      // Avoid spawning inside POI buildings directly
      if (pois.some((p) => Math.abs(wx - p.centerX) < p.halfW && Math.abs(wz - p.centerZ) < p.halfD)) {
        continue;
      }
      out.push({
        id: `zw_${cx}_${cz}_${i}`,
        archetypeId: rand() < 0.28 ? 'infected_stalker' : 'infected_walker',
        worldX: wx,
        worldY: this.roadNetwork.getTerrainHeight(wx, wz),
        worldZ: wz,
        yaw: rand() * Math.PI * 2,
      });
    }
  }

  public shatterWindow(windowId: string, hitPointLocal: THREE.Vector3, impactDir: THREE.Vector3): boolean {
    for (const chunk of this.loadedChunks.values()) {
      const win = chunk.windows.find((w) => w.id === windowId && !w.broken);
      if (!win) continue;

      win.broken = true;
      chunk.group.remove(win.mesh);
      const rmIdx = chunk.raycastMeshes.indexOf(win.mesh);
      if (rmIdx !== -1) chunk.raycastMeshes.splice(rmIdx, 1);

      const actIdx = this.activeRaycastMeshes.indexOf(win.mesh);
      if (actIdx !== -1) this.activeRaycastMeshes.splice(actIdx, 1);

      this.colliderIndex.removeCollider(chunk.key, win.colliderId);
      const actColIdx = this.activeColliders.findIndex((c) => c.id === win.colliderId);
      if (actColIdx !== -1) this.activeColliders.splice(actColIdx, 1);

      // Persist broken window in ChunkDelta
      const delta = this.getOrCreateDelta(chunk.key);
      if (!delta.brokenWindows.includes(windowId)) {
        delta.brokenWindows.push(windowId);
      }

      // Falling shard particles
      for (let i = 0; i < 14; i++) {
        const mesh = new THREE.Mesh(this.shardGeo, this.shardMat);
        mesh.position.copy(hitPointLocal).add(
          new THREE.Vector3((Math.random() - 0.5) * 0.65, (Math.random() - 0.5) * 0.65, (Math.random() - 0.5) * 0.25),
        );
        this.worldGroup.add(mesh);
        this.glassShards.push({
          mesh,
          vel: impactDir
            .clone()
            .multiplyScalar(1.6 + Math.random() * 2.4)
            .add(new THREE.Vector3((Math.random() - 0.5) * 2.8, Math.random() * 1.8, (Math.random() - 0.5) * 2.8)),
          rotVel: new THREE.Vector3(
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
          ),
          age: 0,
          maxAge: 1.15,
        });
      }

      this.audio.playGlassShatter(hitPointLocal);
      this.acoustic.emitNoise(hitPointLocal, 35, 'glass_shatter');
      return true;
    }
    return false;
  }

  public dropItemAt(localX: number, localZ: number, item: InventoryItemInstance): void {
    const wx = this.originX + localX;
    const wz = this.originZ + localZ;
    const wy = this.groundHeightAtLocal(localX, localZ);
    const ck = makeChunkKey(worldToChunkCoord(wx), worldToChunkCoord(wz));
    const delta = this.getOrCreateDelta(ck);

    const dropId = `drop_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999)}`;
    const dropped: DroppedItemState = {
      id: dropId,
      position: [wx, wy, wz],
      item: { ...item },
    };
    delta.droppedItems.push(dropped);

    const chunk = this.loadedChunks.get(ck);
    if (chunk) {
      this.spawnContainerEntity(
        dropId,
        `Dropped ${ITEMS[item.itemId]?.shortName ?? 'Gear'}`,
        wx - chunk.worldX0,
        wy,
        wz - chunk.worldZ0,
        wx - this.originX,
        wz - this.originZ,
        'bag',
        [{ ...item }],
        undefined,
        chunk.group,
        chunk.chunkGeos,
        chunk.raycastMeshes,
        chunk.containers,
      );
      this.syncActiveRegion(wx, wz);
    }
  }

  public groundHeightAtLocal(localX: number, localZ: number): number {
    return this.roadNetwork.getTerrainHeight(this.originX + localX, this.originZ + localZ);
  }

  public isIndoorLocal(localX: number, localZ: number): boolean {
    for (const z of this.activeIndoorZones) {
      if (localX >= z.minX && localX <= z.maxX && localZ >= z.minZ && localZ <= z.maxZ) {
        return true;
      }
    }
    return false;
  }

  public getIndoorAcousticsLocal(localX: number, localZ: number): 'outdoor' | 'concrete' | 'wood' {
    const wx = this.originX + localX;
    const wz = this.originZ + localZ;
    const chunk = this.loadedChunks.get(makeChunkKey(worldToChunkCoord(wx), worldToChunkCoord(wz)));
    if (!chunk) return 'outdoor';
    for (const z of chunk.indoorZones) {
      if (localX >= z.minX && localX <= z.maxX && localZ >= z.minZ && localZ <= z.maxZ) {
        return z.acoustics;
      }
    }
    return 'outdoor';
  }

  public surfaceAtLocal(localX: number, localZ: number): SurfaceType {
    const wx = this.originX + localX;
    const wz = this.originZ + localZ;
    const chunk = this.loadedChunks.get(makeChunkKey(worldToChunkCoord(wx), worldToChunkCoord(wz)));
    if (chunk) {
      for (const z of chunk.indoorZones) {
        if (localX >= z.minX && localX <= z.maxX && localZ >= z.minZ && localZ <= z.maxZ) {
          return z.floorSurface;
        }
      }
    }
    const road = this.roadNetwork.queryRoad(wx, wz);
    if (road.onAsphalt) return 'asphalt';
    return 'grass';
  }

  public isInStealthBrushLocal(localX: number, localZ: number): boolean {
    const wx = this.originX + localX;
    const wz = this.originZ + localZ;
    const chunk = this.loadedChunks.get(makeChunkKey(worldToChunkCoord(wx), worldToChunkCoord(wz)));
    if (!chunk) return false;
    for (const p of chunk.stealthPatches) {
      const dx = wx - p.wx;
      const dz = wz - p.wz;
      if (dx * dx + dz * dz <= p.radius * p.radius) {
        return true;
      }
    }
    return false;
  }

  public getBiomeAtLocal(localX: number, localZ: number): BiomeId {
    return this.roadNetwork.getBiomeAt(this.originX + localX, this.originZ + localZ);
  }

  public exportChunkDeltas(): Record<string, ChunkDelta> {
    // Sync currently loaded chunks first
    for (const [key, chunk] of this.loadedChunks.entries()) {
      const delta = this.getOrCreateDelta(key);
      for (const d of chunk.doors) {
        delta.openedDoors[d.id] = d.isOpen;
      }
      for (const c of chunk.containers) {
        delta.lootedContainers[c.id] = {
          ...c.state,
          items: c.state.items.map((it) => ({ ...it })),
        };
      }
    }
    const out: Record<string, ChunkDelta> = {};
    for (const [k, d] of this.deltas.entries()) {
      out[k] = cloneDelta(d);
    }
    return out;
  }

  public dispose(): void {
    for (const [key, chunk] of this.loadedChunks.entries()) {
      this.worldGroup.remove(chunk.group);
      for (const g of chunk.chunkGeos) g.dispose();
      for (const inst of chunk.instancedMeshes) inst.dispose();
      this.colliderIndex.unregisterChunk(key);
    }
    this.loadedChunks.clear();
    this.colliderIndex.clear();
    for (const s of this.glassShards) {
      this.worldGroup.remove(s.mesh);
    }
    this.glassShards = [];
    this.protoGeos.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.scene.remove(this.worldGroup);
  }
}

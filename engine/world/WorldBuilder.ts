import * as THREE from 'three';
import { AudioEngine } from '../audio/AudioEngine';
import { VIEWMODEL_LAYER } from '../render/BodycamPostProcess';
import { AcousticSystem } from '../stealth/AcousticSystem';
import { ProceduralTextureLibrary } from '../textures/ProceduralTextures';
import { BiomeId, ChunkDelta, ContainerLootState, DoorSaveState, InventoryItemInstance } from '../types';
import { ChunkManager } from './ChunkManager';

export type SurfaceType = 'concrete' | 'wood' | 'metal' | 'grass' | 'asphalt';

export interface BoxCollider {
  id: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  surface: SurfaceType;
  penetrableWood?: boolean;
  blocksMovement: boolean;
  blocksVision: boolean;
}

export interface DoorEntity {
  id: string;
  label: string;
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  isOpen: boolean;
  currentAngle: number;
  closedAngle: number;
  openAngle: number;
  hingePos: THREE.Vector3;
  collider: BoxCollider;
  closedBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  openBox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

export interface ContainerEntity {
  id: string;
  label: string;
  mesh: THREE.Group;
  position: THREE.Vector3;
  lidMesh?: THREE.Object3D;
  state: ContainerLootState;
}

export interface BuiltWorld {
  worldGroup: THREE.Group;
  colliders: BoxCollider[];
  raycastMeshes: THREE.Object3D[];
  doors: DoorEntity[];
  containers: ContainerEntity[];
  indoorZones: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }>;
  chunkManager: ChunkManager;
  groundHeightAt: (x: number, z: number) => number;
  surfaceAt: (x: number, z: number) => SurfaceType;
  isIndoor: (x: number, z: number) => boolean;
  isInStealthBrush: (x: number, z: number) => boolean;
  getIndoorAcoustics: (x: number, z: number) => 'outdoor' | 'concrete' | 'wood';
  getBiomeAt: (x: number, z: number) => BiomeId;
  shatterWindow: (windowId: string, hitPointLocal: THREE.Vector3, impactDir: THREE.Vector3) => boolean;
  setDoorOpen: (door: DoorEntity, isOpen: boolean) => void;
  updateStreaming: (playerLocalX: number, playerLocalZ: number, delta: number) => void;
  rebaseIfNeeded: (playerLocalPos: THREE.Vector3, onShift: (sx: number, sz: number) => void) => void;
  dropItemAt: (localX: number, localZ: number, item: InventoryItemInstance) => void;
  exportChunkDeltas: () => Record<string, ChunkDelta>;
  getStarterSpawnWorld: () => { x: number; y: number; z: number; yaw: number };
  dispose: () => void;
}

export function buildWorld(
  scene: THREE.Scene,
  textures: ProceduralTextureLibrary,
  worldSeed: number,
  audio: AudioEngine,
  acoustic: AcousticSystem,
  spawnWorldX = -4.2,
  spawnWorldZ = 16.5,
  savedChunkDeltas?: Record<string, ChunkDelta>,
  savedContainers?: Record<string, ContainerLootState>,
  savedDoors?: Record<string, DoorSaveState>,
): BuiltWorld {
  const chunkManager = new ChunkManager(
    scene,
    textures,
    worldSeed,
    audio,
    acoustic,
    savedChunkDeltas,
    savedContainers,
    savedDoors,
  );

  // Overcast Sky, Horizon Fog (~110m visibility blending 5x5 grid edges) & Atmosphere Lighting
  const fogColor = new THREE.Color(0x889396);
  scene.background = fogColor;
  scene.fog = new THREE.FogExp2(0x7c878a, 0.024);

  const lightingGroup = new THREE.Group();
  scene.add(lightingGroup);

  const hemiLight = new THREE.HemisphereLight(0xb8c7cc, 0x3b3d35, 1.05);
  hemiLight.layers.enable(VIEWMODEL_LAYER);
  lightingGroup.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xeef4eb, 2.55);
  sunLight.layers.enable(VIEWMODEL_LAYER);
  sunLight.position.set(-28, 38, 22);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 2;
  sunLight.shadow.camera.far = 120;
  const d = 38;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.025;
  lightingGroup.add(sunLight);
  lightingGroup.add(sunLight.target);

  // Build immediate 3x3 area synchronously so frame 1 wake-up is 100% solid
  chunkManager.preloadImmediateArea(spawnWorldX, spawnWorldZ);

  return {
    worldGroup: chunkManager.worldGroup,
    colliders: chunkManager.activeColliders,
    raycastMeshes: chunkManager.activeRaycastMeshes,
    doors: chunkManager.activeDoors,
    containers: chunkManager.activeContainers,
    indoorZones: chunkManager.activeIndoorZones,
    chunkManager,
    groundHeightAt: (x: number, z: number) => chunkManager.groundHeightAtLocal(x, z),
    surfaceAt: (x: number, z: number) => chunkManager.surfaceAtLocal(x, z),
    isIndoor: (x: number, z: number) => chunkManager.isIndoorLocal(x, z),
    isInStealthBrush: (x: number, z: number) => chunkManager.isInStealthBrushLocal(x, z),
    getIndoorAcoustics: (x: number, z: number) => chunkManager.getIndoorAcousticsLocal(x, z),
    getBiomeAt: (x: number, z: number) => chunkManager.getBiomeAtLocal(x, z),
    shatterWindow: (windowId: string, hitPointLocal: THREE.Vector3, impactDir: THREE.Vector3) =>
      chunkManager.shatterWindow(windowId, hitPointLocal, impactDir),
    setDoorOpen: (door: DoorEntity, isOpen: boolean) => chunkManager.setDoorOpenState(door, isOpen),
    updateStreaming: (playerLocalX: number, playerLocalZ: number, delta: number) => {
      chunkManager.updateStreaming(playerLocalX, playerLocalZ, delta);
      // Keep shadow frustum centered near player
      sunLight.position.set(playerLocalX - 28, 38, playerLocalZ + 22);
      sunLight.target.position.set(playerLocalX, 0, playerLocalZ);
      sunLight.target.updateMatrixWorld();
    },
    rebaseIfNeeded: (playerLocalPos: THREE.Vector3, onShift: (sx: number, sz: number) => void) =>
      chunkManager.rebaseIfNeeded(playerLocalPos, onShift),
    dropItemAt: (localX: number, localZ: number, item: InventoryItemInstance) =>
      chunkManager.dropItemAt(localX, localZ, item),
    exportChunkDeltas: () => chunkManager.exportChunkDeltas(),
    getStarterSpawnWorld: () => chunkManager.roadNetwork.getStarterSpawn(),
    dispose: () => {
      scene.remove(lightingGroup);
      chunkManager.dispose();
    },
  };
}

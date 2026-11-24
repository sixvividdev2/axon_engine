import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BodycamPhysicsWorld,
  BodycamSurfaceMaterial,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import { loadoutStore } from '../data/loadoutStore';
import { DestructibleDoorSystem } from '../doors/DestructibleDoorSystem';
import { PenetrableSurfaceSystem } from '../doors/PenetrableSurfaceSystem';
import { createHideoutMaterials, HideoutMaterialLibrary } from './HideoutMaterials';
import { HideoutElectronicsSystem } from './HideoutElectronicsSystem';
import { HideoutGunRange, HideoutGunRangeCallbacks } from './HideoutGunRange';
import {
  HideoutLongRangeCallbacks,
  HideoutLongRangeGallery,
} from './HideoutLongRangeGallery';
import { HideoutAirlockBay } from './HideoutAirlockBay';
import { HideoutReadyRoom } from './HideoutReadyRoom';
import { hideoutStateStore } from './HideoutStateStore';

export type HideoutRoomId = 'arsenal' | 'gun_range' | 'ready_room' | 'zombies_portal';

export type HideoutInteractableKind =
  | 'gun_wall_slot'
  | 'prep_table_gunsmith'
  | 'locker_door'
  | 'ammo_crate'
  | 'range_console'
  | 'range_ammo_box'
  | 'ballistics_console'
  | 'ops_laptop'
  | 'ops_briefing_board'
  | 'airlock_override';

export interface HideoutInteractableMeta {
  kind: HideoutInteractableKind;
  slotIndex?: number;
  maxDistanceM: number;
}

export interface GunWallSlotAnchor {
  index: number;
  weaponId: string | null;
  worldPos: THREE.Vector3;
  worldQuat: THREE.Quaternion;
  mountGroup: THREE.Group;
  bracketGroup: THREE.Group;
  proxyMesh: THREE.Mesh;
  assembly: WeaponModelAssembly | null;
}

export interface HideoutRoomBounds {
  id: HideoutRoomId;
  label: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const HIDEOUT_ROOMS: readonly HideoutRoomBounds[] = [
  { id: 'arsenal', label: 'Arsenal Room', minX: -5.5, maxX: 5.5, minZ: -4.5, maxZ: 4.5 },
  { id: 'gun_range', label: 'Gun Range', minX: 5.5, maxX: 34.0, minZ: -12.0, maxZ: 112.0 },
  { id: 'ready_room', label: 'Ready Room', minX: -16.5, maxX: -5.5, minZ: -5.0, maxZ: 5.0 },
  { id: 'zombies_portal', label: 'Sector 4 · Bio-Containment Airlock', minX: -4.5, maxX: 4.5, minZ: 4.5, maxZ: 13.5 },
];

export function resolveHideoutRoom(x: number, z: number): HideoutRoomBounds {
  for (const r of HIDEOUT_ROOMS) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) {
      return r;
    }
  }
  return HIDEOUT_ROOMS[0];
}

export interface HideoutBunkerWorldHandle {
  physics: BodycamPhysicsWorld;
  materials: HideoutMaterialLibrary;
  electronics: HideoutElectronicsSystem;
  doorSystem: DestructibleDoorSystem;
  penetrableSystem: PenetrableSurfaceSystem;
  gunRange: HideoutGunRange;
  longRangeGallery: HideoutLongRangeGallery;
  readyRoom: HideoutReadyRoom;
  airlockBay: HideoutAirlockBay;
  root: THREE.Group;
  raycastMeshes: THREE.Object3D[];
  interactableMeshes: THREE.Mesh[];
  gunWallSlots: GunWallSlotAnchor[];
  lockerOpen: boolean;
  toggleLockerDoor: () => boolean;
  triggerAmmoCratePop: () => void;
  getPropInteractPos: (kind: HideoutInteractableKind, outPos: THREE.Vector3) => boolean;
  syncGunWallSlots: (slots: ReadonlyArray<string | null>) => void;
  setSlotWeaponVisual: (slotIndex: number, weaponId: string | null) => void;
  getSlotTransform: (
    slotIndex: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ) => boolean;
  updateProps: (dt: number, listenerPos?: THREE.Vector3) => void;
  dispose: () => void;
}

const MAX_WALL_SLOTS = 12;

/**
 * Builds the connected 4-room Cold-War Soviet Concrete Bunker shell and detailed Arsenal Room:
 *  - Center: Arsenal Room (X ∈ [-5.5, 5.5], Z ∈ [-4.5, 4.5], H = 3.8m)
 *    • Owned-only Gun Wall on North wall (Z = -4.34) — ZERO unowned guns or silhouettes
 *    • Tactical Prep Table (mission papers, instanced brass/steel casings, loaded mags, cleaning tools — NO laptop)
 *    • Standing Metal Tactical Locker (animated door swing + Operator gear hook)
 *    • Stenciled Military Ammo Crate (lid pop + resupply hook)
 *  - East Corridor (X = 5.5..6.5, Z ∈ [-1.4, 1.4]) → Gun Range Architectural Shell (Phase 2 & 3 bays)
 *  - West Corridor (X = -6.5..-5.5, Z ∈ [-1.4, 1.4]) → Ready Room Architectural Shell (Phase 4 hub)
 *  - South Corridor (Z = 4.5..5.5, X ∈ [-1.4, 1.4]) → Zombies Portal Room Shell (Phase 5 breach rift)
 */
export function buildHideoutBunkerWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  gunRangeCallbacks?: HideoutGunRangeCallbacks,
  longRangeCallbacks?: HideoutLongRangeCallbacks,
): HideoutBunkerWorldHandle {
  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -16.2;
  physics.boundsMaxX = 33.3;
  physics.boundsMinZ = -11.6;
  physics.boundsMaxZ = 107.6;

  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const materials = createHideoutMaterials(maxAniso);
  const root = new THREE.Group();
  root.name = 'HideoutBunkerWorld';
  scene.add(root);

  const electronics = new HideoutElectronicsSystem(root);
  const penetrableSystem = new PenetrableSurfaceSystem(root, { isSoftwareGl });
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const interactableMeshes: THREE.Mesh[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };

  // === Atmosphere, PMREM Studio Reflections & Balanced Cold-War Lighting (≤ 2 Shadow Casters) ===
  scene.background = new THREE.Color(0x0b0c0e);
  scene.fog = new THREE.FogExp2(0x0d0f11, 0.0085);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  // Subtle cool concrete fill vs warm tungsten/sodium overhead key pools
  const hemiLight = new THREE.HemisphereLight(0x8899aa, 0x26221e, 0.52);
  root.add(hemiLight);

  // Shadow Caster #1: Main Arsenal Room warm sodium/tungsten overhead key light
  const arsenalKey = new THREE.SpotLight(0xffe0b2, 18.0, 16, Math.PI * 0.44, 0.55, 1.4);
  arsenalKey.position.set(0.2, 3.62, -0.6);
  arsenalKey.target.position.set(0.0, 1.1, -2.5);
  if (!isSoftwareGl) {
    arsenalKey.castShadow = true;
    arsenalKey.shadow.mapSize.set(1024, 1024);
    arsenalKey.shadow.camera.near = 0.5;
    arsenalKey.shadow.camera.far = 14;
    arsenalKey.shadow.bias = -0.0005;
    arsenalKey.shadow.normalBias = 0.02;
  }
  root.add(arsenalKey);
  root.add(arsenalKey.target);

  // Non-shadow task pools for crisp 60+ FPS lighting across the Gun Wall and adjoining bunker wings
  const gunWallWash = new THREE.PointLight(0xffd299, 6.2, 8.5, 1.5);
  gunWallWash.position.set(0, 2.85, -3.25);
  root.add(gunWallWash);

  const prepTableLamp = new THREE.PointLight(0xffe4b8, 3.8, 6.0, 1.6);
  prepTableLamp.position.set(2.35, 2.6, -1.0);
  root.add(prepTableLamp);

  const readyRoomLight = new THREE.PointLight(0xd9e4ec, 7.5, 16, 1.45);
  readyRoomLight.position.set(-11.0, 3.3, 0.0);
  root.add(readyRoomLight);

  const rangeEntryLight = new THREE.PointLight(0xe4edf5, 9.5, 22, 1.35);
  rangeEntryLight.position.set(13.5, 4.1, 0.0);
  root.add(rangeEntryLight);

  const rangeDownLight = new THREE.PointLight(0xd2e1ee, 8.0, 28, 1.3);
  rangeDownLight.position.set(15.5, 4.1, 18.0);
  root.add(rangeDownLight);

  const portalRoomLight = new THREE.PointLight(0xdc3b2c, 5.2, 13, 1.55);
  portalRoomLight.position.set(0.0, 3.1, 9.6);
  root.add(portalRoomLight);

  // Helper to place solid architectural slabs with matching physics collider + raycast registration
  const addBoxStructure = (
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    collides = true,
    receiveShadow = true,
    castShadow = false,
  ): THREE.Mesh => {
    const geo = trackGeo(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.receiveShadow = receiveShadow;
    mesh.castShadow = castShadow && !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    root.add(mesh);
    raycastMeshes.push(mesh);
    if (collides) {
      physics.addBox({
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
  };

  const addDoorwayFrame = (
    cx: number,
    cz: number,
    width: number,
    height: number,
    depth: number,
    alongX: boolean,
  ): void => {
    const t = 0.14;
    if (alongX) {
      // Corridor passes along X; jambs on Z edges
      addBoxStructure(cx, height * 0.5, cz - width * 0.5 + t * 0.5, depth, height, t, materials.darkSteel, 'metal', false);
      addBoxStructure(cx, height * 0.5, cz + width * 0.5 - t * 0.5, depth, height, t, materials.darkSteel, 'metal', false);
      addBoxStructure(cx, height - t * 0.5, cz, depth, t, width, materials.darkSteel, 'metal', false);
    } else {
      // Corridor passes along Z; jambs on X edges
      addBoxStructure(cx - width * 0.5 + t * 0.5, height * 0.5, cz, t, height, depth, materials.darkSteel, 'metal', false);
      addBoxStructure(cx + width * 0.5 - t * 0.5, height * 0.5, cz, t, height, depth, materials.darkSteel, 'metal', false);
      addBoxStructure(cx, height - t * 0.5, cz, width, t, depth, materials.darkSteel, 'metal', false);
    }
  };

  let lampCounter = 0;
  const addOverheadLamp = (
    x: number,
    y: number,
    z: number,
    emissiveMat: THREE.Material,
    linkedLights: Array<{ light: THREE.Light; dropFraction: number }> = [],
  ): void => {
    const housing = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(1.15, 0.08, 0.24)),
      materials.darkSteel,
    );
    housing.position.set(x, y, z);
    housing.userData.isRoof = true;
    root.add(housing);

    const tube = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.02, 0.04, 0.14)), emissiveMat);
    tube.position.set(x, y - 0.045, z);
    tube.userData.isRoof = true;
    root.add(tube);

    electronics.registerNode(
      {
        id: `bunker_lamp_${lampCounter++}`,
        label: 'Overhead Bunker Light',
        hitMeshes: [housing, tube],
        emissiveMeshes: [tube],
        linkedLights,
        sparkOrigin: new THREE.Vector3(x, y - 0.06, z),
        isLightFixture: true,
      },
      raycastMeshes,
    );
  };

  // ============================================================================
  // 1. CONNECTED 4-ROOM COLD-WAR CONCRETE BUNKER ARCHITECTURAL SHELL
  // ============================================================================
  const H_HUB = 3.8;
  const H_RANGE = 4.6;
  const DOOR_W = 2.8;
  const DOOR_H = 2.75;

  // Interior acoustic reverb zones across the bunker (including Bay 3 100m Gallery)
  physics.addInteriorZone({ minX: -16.5, maxX: 34.0, minY: 0, maxY: H_RANGE, minZ: -12.0, maxZ: 112.0, material: 'concrete' });

  // --- ROOM 1: ARSENAL ROOM (X ∈ [-5.5, 5.5], Z ∈ [-4.5, 4.5]) ---
  addBoxStructure(0, -0.1, 0, 12.2, 0.2, 10.2, materials.concreteFloor, 'concrete', false);
  addBoxStructure(0, H_HUB + 0.1, 0, 12.2, 0.2, 10.2, materials.concreteCeiling, 'concrete', true, false).userData.isRoof = true;
  // North Solid Wall (Gun Wall mounts here)
  addBoxStructure(0, H_HUB * 0.5, -4.75, 12.0, H_HUB, 0.5, materials.concreteWall, 'concrete');

  // East Bulkhead (X = 5.5..6.5) with 2.8m doorway at Z ∈ [-1.4, +1.4] → Gun Range
  addBoxStructure(6.0, H_HUB * 0.5, -3.2, 1.0, H_HUB, 3.6, materials.concreteWall, 'concrete');
  addBoxStructure(6.0, H_HUB * 0.5, 3.2, 1.0, H_HUB, 3.6, materials.concreteWall, 'concrete');
  addBoxStructure(6.0, DOOR_H + (H_HUB - DOOR_H) * 0.5, 0, 1.0, H_HUB - DOOR_H, DOOR_W, materials.concreteWall, 'concrete');
  addDoorwayFrame(6.0, 0, DOOR_W, DOOR_H, 1.06, true);

  // West Bulkhead (X = -6.5..-5.5) with 2.8m doorway at Z ∈ [-1.4, +1.4] → Ready Room
  addBoxStructure(-6.0, H_HUB * 0.5, -3.2, 1.0, H_HUB, 3.6, materials.concreteWall, 'concrete');
  addBoxStructure(-6.0, H_HUB * 0.5, 3.2, 1.0, H_HUB, 3.6, materials.concreteWall, 'concrete');
  addBoxStructure(-6.0, DOOR_H + (H_HUB - DOOR_H) * 0.5, 0, 1.0, H_HUB - DOOR_H, DOOR_W, materials.concreteWall, 'concrete');
  addDoorwayFrame(-6.0, 0, DOOR_W, DOOR_H, 1.06, true);

  // South Bulkhead (Z = 4.5..5.5) with 2.8m doorway at X ∈ [-1.4, +1.4] → Zombies Portal Room
  addBoxStructure(-3.6, H_HUB * 0.5, 5.0, 4.4, H_HUB, 1.0, materials.concreteWall, 'concrete');
  addBoxStructure(3.6, H_HUB * 0.5, 5.0, 4.4, H_HUB, 1.0, materials.concreteWall, 'concrete');
  addBoxStructure(0, DOOR_H + (H_HUB - DOOR_H) * 0.5, 5.0, DOOR_W, H_HUB - DOOR_H, 1.0, materials.concreteWall, 'concrete');
  addDoorwayFrame(0, 5.0, DOOR_W, DOOR_H, 1.06, false);

  // Architectural concrete pilasters & steel ceiling beams in Arsenal Room
  for (const px of [-5.32, 5.32]) {
    for (const pz of [-4.2, -1.65, 1.65, 4.2]) {
      addBoxStructure(px, H_HUB * 0.5, pz, 0.36, H_HUB, 0.36, materials.darkSteel, 'metal', false);
    }
  }
  for (const bz of [-2.4, 0.0, 2.4]) {
    addBoxStructure(0, H_HUB - 0.14, bz, 11.0, 0.28, 0.24, materials.darkSteel, 'metal', false).userData.isRoof = true;
  }
  addOverheadLamp(0, H_HUB - 0.29, -2.0, materials.warmLampEmissive, [
    { light: arsenalKey, dropFraction: 0.5 },
    { light: prepTableLamp, dropFraction: 0.5 },
  ]);
  addOverheadLamp(0, H_HUB - 0.29, 1.8, materials.warmLampEmissive, [
    { light: arsenalKey, dropFraction: 0.5 },
    { light: prepTableLamp, dropFraction: 0.5 },
  ]);

  // Directional Room Plaques over each doorway inside the Arsenal Room
  const makePlaque = (
    x: number,
    y: number,
    z: number,
    rotY: number,
    title: string,
    subtitle: string,
    accentHex: string,
  ): void => {
    const mat = materials.createSignMaterial(title, subtitle, accentHex);
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.72, 0.48, 0.05)), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    root.add(mesh);
  };
  makePlaque(5.46, 3.16, 0, -Math.PI * 0.5, 'GUN RANGE', 'BAYS 1–3 · BALLISTICS', '#d97706');
  makePlaque(-5.46, 3.16, 0, Math.PI * 0.5, 'READY ROOM', 'OPS COMMAND · DEPLOY', '#60a5fa');
  makePlaque(0, 3.16, 4.46, Math.PI, 'SECTOR 4 · AIRLOCK', 'QUARANTINE TRANSPORT BAY', '#d97706');

  // --- ROOM 2: READY ROOM SHELL (X ∈ [-16.5, -6.5], Z ∈ [-5.0, 5.0]) ---
  addBoxStructure(-11.5, -0.1, 0, 10.6, 0.2, 10.6, materials.concreteFloor, 'concrete', false);
  addBoxStructure(-11.5, H_HUB + 0.1, 0, 10.6, 0.2, 10.6, materials.concreteCeiling, 'concrete', true, false).userData.isRoof = true;
  addBoxStructure(-16.75, H_HUB * 0.5, 0, 0.5, H_HUB, 10.6, materials.concreteWall, 'concrete');
  addBoxStructure(-11.5, H_HUB * 0.5, -5.25, 10.6, H_HUB, 0.5, materials.concreteWall, 'concrete');
  addBoxStructure(-11.5, H_HUB * 0.5, 5.25, 10.6, H_HUB, 0.5, materials.concreteWall, 'concrete');
  addOverheadLamp(-11.5, H_HUB - 0.12, -1.8, materials.warmLampEmissive, [
    { light: readyRoomLight, dropFraction: 0.5 },
  ]);
  addOverheadLamp(-11.5, H_HUB - 0.12, 1.8, materials.warmLampEmissive, [
    { light: readyRoomLight, dropFraction: 0.5 },
  ]);

  // --- ROOM 3: GUN RANGE SHELL (Bays 1 & 2: X ∈ [6.5, 24.5], Z ∈ [-10.0, 36.0]; opens East into Bay 3 100m Gallery) ---
  addBoxStructure(15.5, -0.1, 13.0, 18.6, 0.2, 47.0, materials.concreteFloor, 'concrete', false);
  addBoxStructure(15.5, H_RANGE + 0.1, 13.0, 18.6, 0.2, 47.0, materials.concreteCeiling, 'concrete', true, false).userData.isRoof = true;
  // East bulkhead at X = 24.75 split to create a wide 7.6m foyer archway (Z ∈ [-5.4, 2.2]) into Bay 3 100m Gallery
  addBoxStructure(24.75, H_RANGE * 0.5, -7.95, 0.5, H_RANGE, 5.1, materials.concreteWall, 'concrete');
  addBoxStructure(24.75, H_RANGE * 0.5, 19.35, 0.5, H_RANGE, 34.3, materials.concreteWall, 'concrete');
  addBoxStructure(24.75, 3.975, -1.6, 0.5, 1.25, 7.6, materials.concreteWall, 'concrete');
  addDoorwayFrame(24.75, -1.6, 7.6, 3.35, 0.58, true);
  makePlaque(24.46, 3.72, -1.6, -Math.PI * 0.5, 'BAY 3 · 100M GALLERY', 'LONG-RANGE & BALLISTICS BENCH', '#38bdf8');
  addBoxStructure(15.5, H_RANGE * 0.5, -10.25, 18.6, H_RANGE, 0.5, materials.concreteWall, 'concrete');
  addBoxStructure(15.5, H_RANGE * 0.5, 36.25, 18.6, H_RANGE, 0.5, materials.concreteWall, 'concrete');
  // West side wall segments of Gun Range flanking the Arsenal bulkhead
  addBoxStructure(6.25, H_RANGE * 0.5, -7.5, 0.5, H_RANGE, 5.4, materials.concreteWall, 'concrete');
  addBoxStructure(6.25, H_RANGE * 0.5, 20.5, 0.5, H_RANGE, 31.8, materials.concreteWall, 'concrete');
  // Hazard stripe floor line marking the Gun Range threshold
  const rangeLine = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(0.32, 2.75)),
    materials.hazardStripe,
  );
  rangeLine.rotation.x = -Math.PI * 0.5;
  rangeLine.position.set(6.55, 0.015, 0);
  root.add(rangeLine);
  addOverheadLamp(12.5, H_RANGE - 0.16, 0.0, materials.warmLampEmissive, [
    { light: rangeEntryLight, dropFraction: 0.6 },
  ]);
  addOverheadLamp(18.5, H_RANGE - 0.16, 8.0, materials.warmLampEmissive, [
    { light: rangeEntryLight, dropFraction: 0.4 },
    { light: rangeDownLight, dropFraction: 0.4 },
  ]);
  addOverheadLamp(15.5, H_RANGE - 0.16, 20.0, materials.warmLampEmissive, [
    { light: rangeDownLight, dropFraction: 0.6 },
  ]);

  // --- ROOM 4: BIO-CONTAINMENT AIRLOCK BAY (X ∈ [-4.5, 4.5], Z ∈ [5.5, 13.5] + Exterior Transport Bay) ---
  addBoxStructure(0, -0.1, 9.5, 9.6, 0.2, 8.6, materials.concreteFloor, 'concrete', false);
  addBoxStructure(0, H_HUB + 0.1, 9.5, 9.6, 0.2, 8.6, materials.concreteCeiling, 'concrete', true, false).userData.isRoof = true;
  addBoxStructure(-4.75, H_HUB * 0.5, 9.5, 0.5, H_HUB, 8.6, materials.concreteWall, 'concrete');
  addBoxStructure(4.75, H_HUB * 0.5, 9.5, 0.5, H_HUB, 8.6, materials.concreteWall, 'concrete');
  const containmentLine = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(2.75, 0.34)),
    materials.hazardStripe,
  );
  containmentLine.rotation.x = -Math.PI * 0.5;
  containmentLine.position.set(0, 0.015, 5.55);
  root.add(containmentLine);
  addOverheadLamp(0, H_HUB - 0.14, 7.6, materials.hazardRedEmissive, [
    { light: portalRoomLight, dropFraction: 1.0 },
  ]);

  const airlockBay = new HideoutAirlockBay({
    root,
    physics,
    materials,
    raycastMeshes,
    interactableMeshes,
    isSoftwareGl,
  });

  // ============================================================================
  // 2. ARSENAL ROOM HERO PROP A: OWNED-ONLY 3D GUN WALL (Z = -4.34)
  // ============================================================================
  const gunWallGroup = new THREE.Group();
  gunWallGroup.name = 'ArsenalGunWall';
  root.add(gunWallGroup);

  const wallWidth = 6.8;
  const wallHeight = 1.92;
  const wallCenterY = 1.66;
  const wallFaceZ = -4.42;

  // Recessed slatted tactical steel backing + heavy dark steel perimeter trim
  const backingMesh = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(wallWidth, wallHeight, 0.08)),
    materials.pegboardWall,
  );
  backingMesh.position.set(0, wallCenterY, wallFaceZ);
  backingMesh.receiveShadow = true;
  gunWallGroup.add(backingMesh);
  raycastMeshes.push(backingMesh);

  // Top, bottom, left, right heavy steel frame rails
  const frameT = 0.09;
  const frameD = 0.14;
  const topFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(wallWidth + frameT * 2, frameT, frameD)), materials.darkSteel);
  topFrame.position.set(0, wallCenterY + wallHeight * 0.5 + frameT * 0.5, wallFaceZ + 0.02);
  gunWallGroup.add(topFrame);
  const botFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(wallWidth + frameT * 2, frameT, frameD)), materials.darkSteel);
  botFrame.position.set(0, wallCenterY - wallHeight * 0.5 - frameT * 0.5, wallFaceZ + 0.02);
  gunWallGroup.add(botFrame);
  for (const sx of [-1, 1]) {
    const sideFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(frameT, wallHeight, frameD)), materials.darkSteel);
    sideFrame.position.set(sx * (wallWidth * 0.5 + frameT * 0.5), wallCenterY, wallFaceZ + 0.02);
    gunWallGroup.add(sideFrame);
  }

  // Overhead showcase linear light valance above Gun Wall (destructible light bar)
  const valance = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(wallWidth - 0.2, 0.06, 0.24)), materials.darkSteel);
  valance.position.set(0, wallCenterY + wallHeight * 0.5 + 0.18, wallFaceZ + 0.14);
  gunWallGroup.add(valance);
  const valanceStrip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(wallWidth - 0.36, 0.025, 0.06)), materials.warmLampEmissive);
  valanceStrip.position.set(0, wallCenterY + wallHeight * 0.5 + 0.145, wallFaceZ + 0.2);
  gunWallGroup.add(valanceStrip);
  electronics.registerNode(
    {
      id: 'gun_wall_valance_light',
      label: 'Gun Wall Valance Light',
      hitMeshes: [valance, valanceStrip],
      emissiveMeshes: [valanceStrip],
      linkedLights: [{ light: gunWallWash, dropFraction: 1.0 }],
      sparkOrigin: new THREE.Vector3(0, wallCenterY + wallHeight * 0.5 + 0.14, wallFaceZ + 0.2),
      isLightFixture: true,
    },
    raycastMeshes,
  );

  // Low steel bench lip along bottom of Gun Wall
  addBoxStructure(0, 0.34, -4.22, wallWidth + 0.2, 0.68, 0.52, materials.darkSteel, 'metal', true);

  // Build 12 clean grid slot anchors (4 cols × 3 rows) — brackets and proxies ONLY shown for active owned slots!
  const gunWallSlots: GunWallSlotAnchor[] = [];
  const COLS = 4;
  const ROWS = 3;
  const colSpacing = 1.58;
  const rowSpacing = 0.56;
  const startX = -((COLS - 1) * colSpacing) * 0.5;
  const startY = 2.24;

  const bracketBarGeo = trackGeo(new THREE.BoxGeometry(0.035, 0.035, 0.16));
  const bracketHookGeo = trackGeo(new THREE.BoxGeometry(0.035, 0.065, 0.028));
  const proxyGeo = trackGeo(new THREE.BoxGeometry(1.18, 0.36, 0.24));
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });

  // Weapon model local forward is -Z, up is +Y. Rotating Y by +PI/2 points muzzle toward +X (right along wall) with right profile facing shooter (+Z).
  const rackWeaponQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0, 'YXZ'));

  for (let i = 0; i < MAX_WALL_SLOTS; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const sx = startX + col * colSpacing;
    const sy = startY - row * rowSpacing;
    const sz = wallFaceZ + 0.15;

    const bracketGroup = new THREE.Group();
    bracketGroup.position.set(sx, sy, wallFaceZ + 0.04);
    bracketGroup.visible = false; // Only revealed when slot is part of the owned rack

    for (const bx of [-0.24, 0.22]) {
      const peg = new THREE.Mesh(bracketBarGeo, materials.brushedSteel);
      peg.position.set(bx, -0.05, 0.08);
      bracketGroup.add(peg);
      const lip = new THREE.Mesh(bracketHookGeo, materials.brushedSteel);
      lip.position.set(bx, -0.03, 0.155);
      bracketGroup.add(lip);
    }
    gunWallGroup.add(bracketGroup);

    const mountGroup = new THREE.Group();
    mountGroup.position.set(sx, sy, sz);
    mountGroup.quaternion.copy(rackWeaponQuat);
    gunWallGroup.add(mountGroup);

    const proxyMesh = new THREE.Mesh(proxyGeo, proxyMat);
    proxyMesh.position.set(sx, sy, sz + 0.04);
    proxyMesh.visible = false;
    const meta: HideoutInteractableMeta = {
      kind: 'gun_wall_slot',
      slotIndex: i,
      maxDistanceM: 3.1,
    };
    proxyMesh.userData.hideoutInteractable = meta;
    gunWallGroup.add(proxyMesh);
    interactableMeshes.push(proxyMesh);

    gunWallSlots.push({
      index: i,
      weaponId: null,
      worldPos: new THREE.Vector3(sx, sy, sz),
      worldQuat: rackWeaponQuat.clone(),
      mountGroup,
      bracketGroup,
      proxyMesh,
      assembly: null,
    });
  }

  const mountWeaponInSlot = (slot: GunWallSlotAnchor, weaponId: string | null): void => {
    if (slot.assembly) {
      slot.mountGroup.remove(slot.assembly.group);
      slot.assembly.dispose();
      slot.assembly = null;
    }
    slot.weaponId = weaponId;
    if (!weaponId || weaponId === 'unarmed') return;

    const profile = resolveWeaponProfile(weaponId);
    const build = loadoutStore.getActiveWeaponBuild(weaponId);
    const asm = WeaponModelFactory.build({
      id: profile.id,
      holdClass: profile.holdClass,
      barrelLengthM: profile.barrelLengthM,
      visualStyle: profile.visualStyle,
      finish: profile.finish,
      railType: profile.railType,
      isRevolver: profile.isRevolver,
      boreAxisHeightM: profile.boreAxisHeightM,
      rightHandSocket: profile.rightHandSocket,
      leftHandSocket: profile.leftHandSocket,
      muzzleOffset: profile.muzzleOffset,
      laserOffset: profile.laserOffset,
      supportsSuppressor: profile.supportsSuppressor,
      renderLayer: 0,
    });
    WeaponAssembler.applyAttachments(
      asm,
      profile.massKg,
      profile.barrelLengthM,
      profile.magCapacity,
      build.attachments,
      { thirdPersonMode: true },
    );
    asm.group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = !isSoftwareGl;
        child.receiveShadow = true;
      }
    });
    // Slight recentering so rifles sit balanced over twin hooks
    const zCenterOffset = profile.holdClass === 'pistol' ? 0.02 : 0.12;
    asm.group.position.set(0, 0, zCenterOffset);
    slot.mountGroup.add(asm.group);
    slot.assembly = asm;
  };

  const syncGunWallSlots = (slots: ReadonlyArray<string | null>): void => {
    for (let i = 0; i < gunWallSlots.length; i++) {
      const slot = gunWallSlots[i];
      const activeSlot = i < slots.length;
      slot.bracketGroup.visible = activeSlot;
      slot.proxyMesh.visible = activeSlot;
      const targetId = activeSlot ? slots[i] : null;
      mountWeaponInSlot(slot, targetId);
    }
  };

  const setSlotWeaponVisual = (slotIndex: number, weaponId: string | null): void => {
    const slot = gunWallSlots[slotIndex];
    if (!slot) return;
    slot.bracketGroup.visible = true;
    slot.proxyMesh.visible = true;
    mountWeaponInSlot(slot, weaponId);
  };

  // ============================================================================
  // 3. ARSENAL ROOM PROP B: TACTICAL PREP TABLE (NO LAPTOP HERE!)
  // ============================================================================
  const tableX = 2.45;
  const tableZ = -1.05;
  const tableW = 1.9;
  const tableD = 0.88;
  const tableH = 0.84;

  const prepTableGroup = new THREE.Group();
  prepTableGroup.position.set(tableX, 0, tableZ);
  root.add(prepTableGroup);

  // Heavy welded steel frame & 4 grounded legs
  const legGeo = trackGeo(new THREE.BoxGeometry(0.065, tableH - 0.06, 0.065));
  for (const lx of [-tableW * 0.46, tableW * 0.46]) {
    for (const lz of [-tableD * 0.42, tableD * 0.42]) {
      const leg = new THREE.Mesh(legGeo, materials.darkSteel);
      leg.position.set(lx, (tableH - 0.06) * 0.5, lz);
      leg.castShadow = !isSoftwareGl;
      prepTableGroup.add(leg);
    }
  }
  // Lower steel shelf stretcher
  const shelf = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(tableW - 0.14, 0.035, tableD - 0.16)), materials.darkSteel);
  shelf.position.set(0, 0.22, 0);
  prepTableGroup.add(shelf);

  // Thick oiled timber workbench slab
  const tabletop = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(tableW, 0.06, tableD)), materials.tableWood);
  tabletop.position.set(0, tableH - 0.03, 0);
  tabletop.receiveShadow = true;
  tabletop.castShadow = !isSoftwareGl;
  prepTableGroup.add(tabletop);
  raycastMeshes.push(tabletop);

  // Tactical rubber gunsmith cleaning mat on center-left
  const matMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.92, 0.008, 0.44)), materials.rubberMat);
  matMesh.position.set(-0.22, tableH + 0.004, 0.04);
  prepTableGroup.add(matMesh);

  // Scattered mission papers / sector contour maps on right half of table
  const paperGeo = trackGeo(new THREE.PlaneGeometry(0.38, 0.29));
  const paperLayouts: Array<[number, number, number, number]> = [
    [0.52, tableH + 0.006, -0.08, 0.18],
    [0.44, tableH + 0.009, 0.09, -0.24],
    [0.64, tableH + 0.012, 0.14, 0.42],
    [-0.74, tableH + 0.006, -0.22, -0.14],
  ];
  for (const [px, py, pz, ry] of paperLayouts) {
    const sheet = new THREE.Mesh(paperGeo, materials.missionPaper);
    sheet.rotation.set(-Math.PI * 0.5, 0, ry);
    sheet.position.set(px, py, pz);
    prepTableGroup.add(sheet);
  }

  // Instanced brass & steel shell casings scattered naturally on the Tactical Prep Table
  const casingGeo = trackGeo(new THREE.CylinderGeometry(0.0052, 0.0056, 0.038, 7));
  const brassInst = new THREE.InstancedMesh(casingGeo, materials.brassCasing, 30);
  const steelInst = new THREE.InstancedMesh(casingGeo, materials.steelCasing, 18);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 30; i++) {
    const a = (i * 2.39996) % (Math.PI * 2);
    const r = 0.06 + ((i * 37) % 100) * 0.0028;
    dummy.position.set(-0.18 + Math.cos(a) * r * 1.4, tableH + 0.014, 0.02 + Math.sin(a) * r);
    dummy.rotation.set(Math.PI * 0.5, (i * 1.13) % Math.PI, 0);
    dummy.updateMatrix();
    brassInst.setMatrixAt(i, dummy.matrix);
  }
  brassInst.instanceMatrix.needsUpdate = true;
  brassInst.computeBoundingSphere();
  prepTableGroup.add(brassInst);

  for (let i = 0; i < 18; i++) {
    const a = (i * 1.91 + 0.7) % (Math.PI * 2);
    const r = 0.05 + ((i * 53) % 100) * 0.0022;
    dummy.position.set(0.28 + Math.cos(a) * r, tableH + 0.014, -0.2 + Math.sin(a) * r * 0.8);
    dummy.rotation.set(Math.PI * 0.5, (i * 0.87) % Math.PI, 0);
    dummy.updateMatrix();
    steelInst.setMatrixAt(i, dummy.matrix);
  }
  steelInst.instanceMatrix.needsUpdate = true;
  steelInst.computeBoundingSphere();
  prepTableGroup.add(steelInst);

  // Loaded rifle magazines lying flat on the prep table
  const rifleMagGeo = trackGeo(new THREE.BoxGeometry(0.064, 0.026, 0.19));
  for (const [mx, mz, mry] of [
    [-0.58, 0.16, 0.28],
    [-0.48, 0.22, 0.15],
    [0.14, 0.24, -0.45],
  ]) {
    const mag = new THREE.Mesh(rifleMagGeo, materials.cavityBlack);
    mag.position.set(mx, tableH + 0.015, mz);
    mag.rotation.y = mry;
    prepTableGroup.add(mag);
    // Brass top round peeking from magazine feed lips
    const tip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.014, 0.055)), materials.brassCasing);
    tip.position.set(0, 0.01, -0.062);
    mag.add(tip);
  }

  // Cleaning kit clutter: brass cleaning rod, gun oil bottle, steel vise block
  const cleaningRod = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.004, 0.004, 0.58, 8)), materials.brassCasing);
  cleaningRod.rotation.z = Math.PI * 0.5;
  cleaningRod.rotation.y = 0.12;
  cleaningRod.position.set(-0.22, tableH + 0.012, -0.14);
  prepTableGroup.add(cleaningRod);

  const oilBottle = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.028, 0.03, 0.12, 10)), materials.darkSteel);
  oilBottle.position.set(-0.68, tableH + 0.06, -0.02);
  prepTableGroup.add(oilBottle);
  const oilCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.012, 0.018, 0.03, 8)), materials.brassCasing);
  oilCap.position.set(0, 0.075, 0);
  oilBottle.add(oilCap);

  const viseBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.08, 0.12)), materials.brushedSteel);
  viseBase.position.set(0.08, tableH + 0.04, -0.26);
  prepTableGroup.add(viseBase);

  // Prep Table collider & interactable proxy (opens Gunsmith Workbench)
  physics.addBox({
    minX: tableX - tableW * 0.5,
    maxX: tableX + tableW * 0.5,
    minY: 0,
    maxY: tableH,
    minZ: tableZ - tableD * 0.5,
    maxZ: tableZ + tableD * 0.5,
    surface: 'wood',
  });
  const prepProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(tableW, 0.55, tableD)), proxyMat);
  prepProxy.position.set(tableX, tableH + 0.1, tableZ);
  prepProxy.userData.hideoutInteractable = {
    kind: 'prep_table_gunsmith',
    maxDistanceM: 2.8,
  } satisfies HideoutInteractableMeta;
  root.add(prepProxy);
  interactableMeshes.push(prepProxy);

  // ============================================================================
  // 4. ARSENAL ROOM PROP C: STANDING METAL TACTICAL LOCKER (ANIMATED DOOR)
  // ============================================================================
  const lockerX = -4.92;
  const lockerZ = -2.25;
  const lockerW = 0.58; // depth along X
  const lockerD = 0.92; // width along Z
  const lockerH = 2.08;

  const lockerGroup = new THREE.Group();
  lockerGroup.position.set(lockerX, 0, lockerZ);
  root.add(lockerGroup);

  // Outer carcass (back, top, bottom, left, right sides)
  const backPanel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.05, lockerH, lockerD)), materials.lockerSteel);
  backPanel.position.set(-lockerW * 0.5 + 0.025, lockerH * 0.5, 0);
  lockerGroup.add(backPanel);
  for (const sz of [-1, 1]) {
    const side = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lockerW, lockerH, 0.045)), materials.lockerSteel);
    side.position.set(0, lockerH * 0.5, sz * (lockerD * 0.5 - 0.022));
    side.castShadow = !isSoftwareGl;
    lockerGroup.add(side);
  }
  const topCap = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lockerW, 0.05, lockerD)), materials.lockerSteel);
  topCap.position.set(0, lockerH - 0.025, 0);
  lockerGroup.add(topCap);
  const botCap = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lockerW, 0.08, lockerD)), materials.darkSteel);
  botCap.position.set(0, 0.04, 0);
  lockerGroup.add(botCap);

  // Interior shelves + tactical vest/helmet stash silhouettes inside the locker
  for (const sy of [0.65, 1.48]) {
    const intShelf = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lockerW - 0.08, 0.03, lockerD - 0.09)), materials.lockerInterior);
    intShelf.position.set(-0.02, sy, 0);
    lockerGroup.add(intShelf);
  }
  const stashHelmet = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.13, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62)), materials.ammoCrateBody);
  stashHelmet.position.set(-0.04, 1.56, -0.18);
  lockerGroup.add(stashHelmet);
  const stashRig = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.26, 0.42, 0.34)), materials.rubberMat);
  stashRig.position.set(-0.06, 0.88, 0.14);
  lockerGroup.add(stashRig);

  // Hinged animated locker door (pivots around front-north corner: x = +lockerW/2, z = -lockerD/2)
  const lockerDoorPivot = new THREE.Group();
  lockerDoorPivot.position.set(lockerW * 0.5 - 0.015, 0, -lockerD * 0.5 + 0.04);
  lockerGroup.add(lockerDoorPivot);

  const doorSlab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.035, lockerH - 0.12, lockerD - 0.08)), materials.lockerSteel);
  doorSlab.position.set(0, lockerH * 0.5 + 0.01, (lockerD - 0.08) * 0.5);
  doorSlab.castShadow = !isSoftwareGl;
  doorSlab.receiveShadow = true;
  lockerDoorPivot.add(doorSlab);
  raycastMeshes.push(doorSlab);

  // Louvered vent slots & recessed handle on the locker door
  for (let v = 0; v < 4; v++) {
    const louver = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.042, 0.022, 0.42)), materials.cavityBlack);
    louver.position.set(0.008, 1.66 + v * 0.055, (lockerD - 0.08) * 0.5);
    lockerDoorPivot.add(louver);
  }
  const doorHandle = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.045, 0.18, 0.035)), materials.brushedSteel);
  doorHandle.position.set(0.03, 1.06, lockerD - 0.18);
  lockerDoorPivot.add(doorHandle);

  physics.addBox({
    minX: lockerX - lockerW * 0.5,
    maxX: lockerX + lockerW * 0.5,
    minY: 0,
    maxY: lockerH,
    minZ: lockerZ - lockerD * 0.5,
    maxZ: lockerZ + lockerD * 0.5,
    surface: 'metal',
  });
  const lockerProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lockerW + 0.25, lockerH, lockerD)), proxyMat);
  lockerProxy.position.set(lockerX + 0.08, lockerH * 0.5, lockerZ);
  lockerProxy.userData.hideoutInteractable = {
    kind: 'locker_door',
    maxDistanceM: 2.8,
  } satisfies HideoutInteractableMeta;
  root.add(lockerProxy);
  interactableMeshes.push(lockerProxy);

  // ============================================================================
  // 5. ARSENAL ROOM PROP D: HEAVY MILITARY AMMO CRATE
  // ============================================================================
  const crateX = 3.88;
  const crateZ = -3.12;
  const crateW = 0.88;
  const crateH = 0.44;
  const crateD = 0.5;

  const crateGroup = new THREE.Group();
  crateGroup.position.set(crateX, 0, crateZ);
  crateGroup.rotation.y = -0.26;
  root.add(crateGroup);

  const crateBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(crateW, crateH - 0.08, crateD)), materials.ammoCrateBody);
  crateBase.position.set(0, (crateH - 0.08) * 0.5, 0);
  crateBase.castShadow = !isSoftwareGl;
  crateBase.receiveShadow = true;
  crateGroup.add(crateBase);
  raycastMeshes.push(crateBase);

  // Hinged lid pivot at rear edge (-Z) for tactile resupply pop animation
  const crateLidPivot = new THREE.Group();
  crateLidPivot.position.set(0, crateH - 0.08, -crateD * 0.5);
  crateGroup.add(crateLidPivot);

  const crateLid = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(crateW + 0.03, 0.08, crateD + 0.03)), materials.ammoCrateTop);
  crateLid.position.set(0, 0.04, crateD * 0.5);
  crateLid.castShadow = !isSoftwareGl;
  crateLidPivot.add(crateLid);

  // Twin steel clasps on front face
  for (const cx of [-0.24, 0.24]) {
    const clasp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.055, 0.11, 0.035)), materials.brushedSteel);
    clasp.position.set(cx, -0.01, crateD + 0.012);
    crateLidPivot.add(clasp);
  }
  // Side carry handles
  for (const sx of [-1, 1]) {
    const handle = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.04, 0.04, 0.2)), materials.darkSteel);
    handle.position.set(sx * (crateW * 0.5 + 0.02), crateH * 0.52, 0);
    crateGroup.add(handle);
  }

  physics.addBox({
    minX: crateX - 0.48,
    maxX: crateX + 0.48,
    minY: 0,
    maxY: crateH,
    minZ: crateZ - 0.36,
    maxZ: crateZ + 0.36,
    surface: 'wood',
  });
  const crateProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.0, 0.65, 0.72)), proxyMat);
  crateProxy.position.set(crateX, 0.32, crateZ);
  crateProxy.userData.hideoutInteractable = {
    kind: 'ammo_crate',
    maxDistanceM: 2.7,
  } satisfies HideoutInteractableMeta;
  root.add(crateProxy);
  interactableMeshes.push(crateProxy);

  // ============================================================================
  // 5B. PHASE 2 GUN RANGE — REACTIVE TARGETS & 30-SECOND CQB POP-UP COURSE
  // ============================================================================
  // Mounted BEFORE physics.setRaycastMeshes so every target plate, gong, paper
  // board, CQB pop-up, and shoot-house barricade is registered for live bullets.
  const persistedState = hideoutStateStore.getState();
  const gunRange = new HideoutGunRange(
    root,
    physics,
    materials,
    electronics,
    raycastMeshes,
    interactableMeshes,
    isSoftwareGl,
    maxAniso,
    persistedState.gunRangeBestScore,
    gunRangeCallbacks,
    penetrableSystem,
  );

  // ============================================================================
  // 5C. PHASE 3 BAY 3 — 100M LONG-RANGE GALLERY & BALLISTICS BENCH
  // ============================================================================
  const longRangeGallery = new HideoutLongRangeGallery(
    root,
    physics,
    materials,
    electronics,
    raycastMeshes,
    interactableMeshes,
    isSoftwareGl,
    maxAniso,
    persistedState.longRangeBestMoa100m,
    persistedState.longRange100mHits,
    longRangeCallbacks,
    penetrableSystem,
  );

  // ============================================================================
  // 5D. PHASE 4 READY ROOM — OPS COMMAND LAPTOP & TACTICAL BRIEFING WALL
  // ============================================================================
  const readyRoom = new HideoutReadyRoom(
    root,
    physics,
    materials,
    electronics,
    raycastMeshes,
    interactableMeshes,
    isSoftwareGl,
    maxAniso,
  );

  // ============================================================================
  // 5E. CQB DRYWALL, PLYWOOD BREACH PARTITIONS & VAULT OBSTACLE (RANGE STAGING)
  // ============================================================================
  const drywallMat = new THREE.MeshStandardMaterial({
    color: 0xd4cfc4,
    roughness: 0.92,
    metalness: 0.02,
  });
  ownedMats.push(drywallMat);

  const buildBreachPartition = (
    id: string,
    cx: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    kind: 'drywall' | 'plywood',
    mat: THREE.Material,
    title: string,
    subtitle: string,
    accentHex: string,
  ): void => {
    const panel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    panel.position.set(cx, h * 0.5, cz);
    panel.castShadow = !isSoftwareGl;
    panel.receiveShadow = true;
    panel.userData.surfaceMaterial = kind === 'drywall' ? 'concrete' : 'wood';
    panel.userData.ballisticMaterial = 'wood';
    panel.userData.thicknessM = d;
    root.add(panel);
    raycastMeshes.push(panel);
    penetrableSystem.registerSurface({
      id,
      mesh: panel,
      kind,
      width: w,
      height: h,
      thickness: d,
      faceAxis: 'z',
      floorY: 0,
      maxHoles: 6,
      hitsToBreach: 1,
    });
    // Steel side uprights & top header (colliders only on uprights so bullets/sightlines fly cleanly through carved holes)
    for (const sx of [-1, 1]) {
      addBoxStructure(cx + sx * (w * 0.5 + 0.045), h * 0.5, cz, 0.09, h, d + 0.05, materials.darkSteel, 'metal', true);
    }
    addBoxStructure(cx, h + 0.045, cz, w + 0.18, 0.09, d + 0.06, materials.darkSteel, 'metal', false);
    makePlaque(cx, h + 0.34, cz + d * 0.5 + 0.03, 0, title, subtitle, accentHex);
  };

  buildBreachPartition(
    'hideout_cqb_drywall',
    10.4,
    -7.8,
    1.36,
    2.16,
    0.08,
    'drywall',
    drywallMat,
    'DRYWALL BREACH',
    'PUNCH / KICK SEE-THROUGH VOID',
    '#e5e7eb',
  );
  buildBreachPartition(
    'hideout_cqb_plywood',
    13.1,
    -7.8,
    1.36,
    2.16,
    0.06,
    'plywood',
    materials.tableWood,
    'PLYWOOD PANEL',
    'SHOOT-THROUGH CARVED HOLE',
    '#d97706',
  );
  // Dedicated 0.90m tactical vault barrier alongside breach panels (Space = Vault / 2x Space = 360 Spin)
  addBoxStructure(16.0, 0.45, -7.8, 1.9, 0.9, 0.42, materials.ammoCrateBody, 'wood', true);
  makePlaque(16.0, 1.28, -7.56, 0, 'VAULT BARRICADE 0.9M', 'SPACE VAULT · 2X SPACE SPIN', '#38bdf8');

  // Register static world, Gun Range & Ready Room raycast meshes BEFORE mounting dynamic doors
  physics.setRaycastMeshes(raycastMeshes);

  // ============================================================================
  // 6. PHYSICAL DESTRUCTIBLE BUNKER DOORS (REPAIRABLE IN HIDEOUT)
  // ============================================================================
  // Frame each 2.8m x 2.75m bulkhead corridor cleanly down to a flush 1.18m x 2.26m tactical doorway
  const addBulkheadDoorInfill = (
    cx: number,
    cz: number,
    alongZ: boolean,
    wallDepth: number,
    openingSpan: number,
    doorSpan: number,
    doorH: number,
    portalH: number,
  ): void => {
    const sideW = (openingSpan - doorSpan) * 0.5;
    const transomH = Math.max(0.1, portalH - doorH);
    if (alongZ) {
      addBoxStructure(cx, portalH * 0.5, cz - (doorSpan * 0.5 + sideW * 0.5), wallDepth, portalH, sideW, materials.concreteWall, 'concrete');
      addBoxStructure(cx, portalH * 0.5, cz + (doorSpan * 0.5 + sideW * 0.5), wallDepth, portalH, sideW, materials.concreteWall, 'concrete');
      addBoxStructure(cx, doorH + transomH * 0.5, cz, wallDepth, transomH, doorSpan, materials.darkSteel, 'metal');
    } else {
      addBoxStructure(cx - (doorSpan * 0.5 + sideW * 0.5), portalH * 0.5, cz, sideW, portalH, wallDepth, materials.concreteWall, 'concrete');
      addBoxStructure(cx + (doorSpan * 0.5 + sideW * 0.5), portalH * 0.5, cz, sideW, portalH, wallDepth, materials.concreteWall, 'concrete');
      addBoxStructure(cx, doorH + transomH * 0.5, cz, doorSpan, transomH, wallDepth, materials.darkSteel, 'metal');
    }
  };

  const TACTICAL_DOOR_W = 1.18;
  const TACTICAL_DOOR_H = 2.26;
  const FRAME_CLEAR_W = TACTICAL_DOOR_W + 0.1;

  // East Bulkhead (Gun Range) infill & repairable door (swings outward into +X Gun Range)
  addBulkheadDoorInfill(6.18, 0, true, 0.34, DOOR_W, FRAME_CLEAR_W, TACTICAL_DOOR_H + 0.05, DOOR_H);
  // West Bulkhead (Ready Room) infill & repairable door (swings outward into -X Ready Room)
  addBulkheadDoorInfill(-6.18, 0, true, 0.34, DOOR_W, FRAME_CLEAR_W, TACTICAL_DOOR_H + 0.05, DOOR_H);
  // South Bulkhead (Sector 4 Containment) infill & repairable door (swings outward into +Z Sector 4)
  addBulkheadDoorInfill(0, 5.18, false, 0.34, DOOR_W, FRAME_CLEAR_W, TACTICAL_DOOR_H + 0.05, DOOR_H);

  const doorSystem = new DestructibleDoorSystem(root, physics, isSoftwareGl);
  doorSystem.addDoor({
    id: 'hideout_gun_range_door',
    label: 'Gun Range Door',
    hingePos: [6.18, 0, -TACTICAL_DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: 1,
    width: TACTICAL_DOOR_W,
    height: TACTICAL_DOOR_H,
    thickness: 0.075,
    repairable: true,
    style: 'bunker_wood',
  });
  doorSystem.addDoor({
    id: 'hideout_ready_room_door',
    label: 'Ready Room Door',
    hingePos: [-6.18, 0, -TACTICAL_DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: -1,
    width: TACTICAL_DOOR_W,
    height: TACTICAL_DOOR_H,
    thickness: 0.075,
    repairable: true,
    style: 'bunker_wood',
  });
  doorSystem.addDoor({
    id: 'hideout_sector4_door',
    label: 'Sector 4 Containment Door',
    hingePos: [-TACTICAL_DOOR_W * 0.5, 0, 5.18],
    closedYawRad: 0,
    swingSign: -1,
    width: TACTICAL_DOOR_W,
    height: TACTICAL_DOOR_H,
    thickness: 0.075,
    repairable: true,
    style: 'tactical_reinforced',
  });

  // === Interactive Prop Animation State ===
  let lockerOpen = false;
  let lockerAngle = 0;
  let cratePopTimer = 0;

  const toggleLockerDoor = (): boolean => {
    lockerOpen = !lockerOpen;
    return lockerOpen;
  };

  const triggerAmmoCratePop = (): void => {
    cratePopTimer = 0.55;
  };

  const updateProps = (dt: number, listenerPos?: THREE.Vector3): void => {
    const clampedDt = Math.min(dt, 0.05);
    // Smooth exponential damping for steel locker door swing (0° closed <-> +108° open outward into +X)
    const targetDoorAngle = lockerOpen ? THREE.MathUtils.degToRad(108) : 0;
    lockerAngle = THREE.MathUtils.damp(lockerAngle, targetDoorAngle, 9.5, clampedDt);
    lockerDoorPivot.rotation.y = lockerAngle;

    // Crisp mechanical lid pop on Ammo Crate resupply
    if (cratePopTimer > 0) {
      cratePopTimer = Math.max(0, cratePopTimer - clampedDt);
      const u = 1 - cratePopTimer / 0.55;
      const lift = Math.sin(u * Math.PI) * THREE.MathUtils.degToRad(26);
      crateLidPivot.rotation.x = -lift;
    } else {
      crateLidPivot.rotation.x = 0;
    }

    // Step Gun Range reactive targets, 30s CQB course, 100m Gallery, Ready Room displays, Airlock Bay, debris & sparks
    gunRange.update(clampedDt);
    longRangeGallery.update(clampedDt);
    readyRoom.update(clampedDt);
    airlockBay.update(clampedDt);
    electronics.update(clampedDt, listenerPos);
    penetrableSystem.update(clampedDt, listenerPos);
  };

  const getSlotTransform = (
    slotIndex: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean => {
    const slot = gunWallSlots[slotIndex];
    if (!slot) return false;
    outPos.copy(slot.worldPos);
    outQuat.copy(slot.worldQuat);
    return true;
  };

  const getPropInteractPos = (kind: HideoutInteractableKind, outPos: THREE.Vector3): boolean => {
    if (kind === 'locker_door') {
      doorHandle.updateMatrixWorld(true);
      doorHandle.getWorldPosition(outPos);
      return true;
    }
    if (kind === 'ammo_crate') {
      crateLidPivot.updateMatrixWorld(true);
      outPos.set(crateX, crateH + 0.04, crateZ);
      return true;
    }
    if (kind === 'prep_table_gunsmith') {
      outPos.set(tableX, tableH + 0.04, tableZ);
      return true;
    }
    if (kind === 'range_console') {
      return gunRange.getConsoleWorldPos(outPos);
    }
    if (kind === 'range_ammo_box') {
      return gunRange.getRangeAmmoWorldPos(outPos);
    }
    if (kind === 'ballistics_console') {
      return longRangeGallery.getConsoleWorldPos(outPos);
    }
    if (kind === 'ops_laptop') {
      return readyRoom.getLaptopWorldPos(outPos);
    }
    if (kind === 'ops_briefing_board') {
      return readyRoom.getBoardWorldPos(outPos);
    }
    if (kind === 'airlock_override') {
      return airlockBay.getOverrideSwitchWorldPos(outPos);
    }
    return false;
  };

  return {
    physics,
    materials,
    electronics,
    doorSystem,
    penetrableSystem,
    gunRange,
    longRangeGallery,
    readyRoom,
    airlockBay,
    root,
    raycastMeshes,
    interactableMeshes,
    gunWallSlots,
    get lockerOpen() {
      return lockerOpen;
    },
    toggleLockerDoor,
    triggerAmmoCratePop,
    getPropInteractPos,
    syncGunWallSlots,
    setSlotWeaponVisual,
    getSlotTransform,
    updateProps,
    dispose: () => {
      airlockBay.dispose();
      readyRoom.dispose();
      longRangeGallery.dispose();
      gunRange.dispose();
      electronics.dispose();
      penetrableSystem.dispose();
      doorSystem.dispose();
      for (const slot of gunWallSlots) {
        if (slot.assembly) {
          slot.mountGroup.remove(slot.assembly.group);
          slot.assembly.dispose();
          slot.assembly = null;
        }
      }
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      proxyMat.dispose();
      materials.dispose();
      envTex.dispose();
      scene.environment = null;
      scene.remove(root);
    },
  };
}

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BodycamPhysicsWorld,
  BodycamSurfaceMaterial,
  IR_LAYER,
} from '../bodycam-sdk';
import { DestructibleDoorSystem } from '../doors/DestructibleDoorSystem';
import { createGymTextures, createStencilSignTexture } from '../gym/GymTextures';
import { PaperShootingTarget, ReactiveSteelTarget } from '../gym/GymWorld';

export const TUTORIAL_BREACH_DOOR_ID = 'tutorial_breach_door';

export interface TutorialWorldHandle {
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  steelTargets: ReactiveSteelTarget[];
  paperTargets: PaperShootingTarget[];
  doorSystem: DestructibleDoorSystem;
  doorId: string;
  grenadePitCenter: THREE.Vector3;
  fireSupportPitCenter: THREE.Vector3;
  setWaypointPosition: (x: number, y: number, z: number, visible: boolean) => void;
  openDoorForSkip: () => void;
  resetDoor: () => void;
  triggerTrainingStrikeBlast: (x: number, z: number) => void;
  update: (dt: number, elapsedSec: number, listenerPos?: Readonly<THREE.Vector3>) => void;
  dispose: () => void;
}

const _wpPos = new THREE.Vector3();
const _skipActorPos = new THREE.Vector3(0, 1.5, -15.5);
const _skipActorDir = new THREE.Vector3(0, 0, -1);

/**
 * Builds a lightweight, architectural 8-Bay Tactical Killhouse Training Course (~13m x 74m).
 * Reuses BodycamPhysicsWorld and procedural GymTextures with zero external assets.
 */
export function buildTutorialWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): TutorialWorldHandle {
  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -6.3;
  physics.boundsMaxX = 6.3;
  physics.boundsMinZ = -46.8;
  physics.boundsMaxZ = 24.8;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const textures = createGymTextures(maxAniso);
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTex: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const steelTargets: ReactiveSteelTarget[] = [];
  const paperTargets: PaperShootingTarget[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMats.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture>(t: T): T => {
    ownedTex.push(t);
    return t;
  };

  // === Atmosphere, IBL & Warm/Cool 2-Light Rig (1 shadow caster ceiling) ===
  scene.background = new THREE.Color(0x95a1aa);
  scene.fog = new THREE.FogExp2(0x909ca5, 0.012);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = trackTex(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
  scene.environment = envTex;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();

  const hemiLight = new THREE.HemisphereLight(0xb8c8d6, 0x3a3d3c, 0.85);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.7);
  sunLight.position.set(14, 28, 12);
  if (!isSoftwareGl) {
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.near = 2;
    sunLight.shadow.camera.far = 96;
    sunLight.shadow.camera.left = -22;
    sunLight.shadow.camera.right = 22;
    sunLight.shadow.camera.top = 48;
    sunLight.shadow.camera.bottom = -48;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.025;
  }
  scene.add(sunLight);

  // Shared PBR Materials
  const floorMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.concreteAlbedo,
      roughnessMap: textures.concreteRoughness,
      roughness: 0.86,
      metalness: 0.05,
    }),
  );
  textures.concreteAlbedo.repeat.set(4, 20);
  textures.concreteRoughness.repeat.set(4, 20);

  const wallMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.concreteDarkAlbedo,
      roughness: 0.9,
      metalness: 0.04,
    }),
  );
  const darkWallMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1d2024,
      roughness: 0.94,
      metalness: 0.05,
    }),
  );
  const hazardMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.hazardAlbedo,
      roughness: 0.62,
      metalness: 0.14,
    }),
  );
  const steelFrameMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x353b42,
      roughness: 0.44,
      metalness: 0.72,
    }),
  );
  const woodMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.woodAlbedo,
      roughnessMap: textures.woodRoughness,
      roughness: 0.82,
      metalness: 0.03,
    }),
  );
  const sandbagMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8b7d62,
      roughness: 0.94,
      metalness: 0.02,
    }),
  );
  const redAccentMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb93829,
      roughness: 0.55,
      metalness: 0.12,
    }),
  );
  const brassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc29a48,
      roughness: 0.35,
      metalness: 0.82,
    }),
  );
  const lanePaintMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd7a83c,
      roughness: 0.75,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );

  const root = new THREE.Group();
  root.name = 'TutorialKillhouseWorld';
  scene.add(root);

  const addBox = (
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    solid = true,
    castShadow = true,
  ): THREE.Mesh => {
    const geo = trackGeo(new THREE.BoxGeometry(sx, sy, sz));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = !isSoftwareGl && castShadow;
    mesh.receiveShadow = true;
    mesh.userData.surface = surface;
    root.add(mesh);
    raycastMeshes.push(mesh);
    if (solid) {
      physics.addBox({
        minX: cx - sx * 0.5,
        maxX: cx + sx * 0.5,
        minY: cy - sy * 0.5,
        maxY: cy + sy * 0.5,
        minZ: cz - sz * 0.5,
        maxZ: cz + sz * 0.5,
        surface,
        blocksMovement: true,
        blocksRaycast: true,
        meshRef: mesh,
      });
    }
    return mesh;
  };

  const addBaySign = (
    title: string,
    subtitle: string,
    x: number,
    y: number,
    z: number,
    rotY = 0,
    accentHex = '#d89b32',
  ): void => {
    const tex = trackTex(createStencilSignTexture(title, subtitle, accentHex, '#232629', maxAniso));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = trackMat(
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.65,
        metalness: 0.1,
      }),
    );
    const backing = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.5, 0.78, 0.06)), steelFrameMat);
    backing.position.set(x, y, z);
    backing.rotation.y = rotY;
    const plate = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(2.38, 0.68)), mat);
    plate.position.set(0, 0, 0.036);
    backing.add(plate);
    root.add(backing);
  };

  // === Main Ground Floor + Extended Outer Concrete Apron (No void dropoff) ===
  const floorGeo = trackGeo(new THREE.PlaneGeometry(14, 78));
  floorGeo.rotateX(-Math.PI * 0.5);
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.position.set(0, 0, -11);
  floorMesh.receiveShadow = true;
  floorMesh.userData.surface = 'concrete';
  root.add(floorMesh);
  raycastMeshes.push(floorMesh);
  physics.addBox({
    minX: -8,
    maxX: 8,
    minY: -0.5,
    maxY: 0,
    minZ: -50,
    maxZ: 28,
    surface: 'concrete',
    blocksMovement: true,
    blocksRaycast: true,
    meshRef: floorMesh,
  });

  const outerGroundGeo = trackGeo(new THREE.PlaneGeometry(180, 180));
  outerGroundGeo.rotateX(-Math.PI * 0.5);
  const outerGroundMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x555c54, roughness: 0.96, metalness: 0.02 }),
  );
  const outerGround = new THREE.Mesh(outerGroundGeo, outerGroundMat);
  outerGround.position.set(0, -0.04, -11);
  root.add(outerGround);

  // Perimeter Killhouse Concrete Walls (East, West, South Start, North Backstop)
  addBox(-6.6, 2.2, -11, 0.6, 4.4, 76, wallMat, 'concrete', true, true);
  addBox(6.6, 2.2, -11, 0.6, 4.4, 76, wallMat, 'concrete', true, true);
  addBox(0, 2.2, 25.4, 13.8, 4.4, 0.6, wallMat, 'concrete', true, true);
  addBox(0, 2.6, -47.4, 13.8, 5.2, 0.6, wallMat, 'concrete', true, true);

  // Center guide stripe running through the killhouse floor (offset Y = 0.015 to avoid Z-fighting)
  const guideGeo = trackGeo(new THREE.PlaneGeometry(0.18, 62));
  guideGeo.rotateX(-Math.PI * 0.5);
  const guideMesh = new THREE.Mesh(guideGeo, lanePaintMat);
  guideMesh.position.set(0, 0.015, -10);
  root.add(guideMesh);

  // Helper to build bay divider portals with an open walkthrough gap
  const addBayPortal = (z: number, gapWidth = 4.6, wallHeight = 3.6): void => {
    const sideW = (12.6 - gapWidth) * 0.5;
    addBox(-6.3 + sideW * 0.5, wallHeight * 0.5, z, sideW, wallHeight, 0.36, wallMat, 'concrete', true, true);
    addBox(6.3 - sideW * 0.5, wallHeight * 0.5, z, sideW, wallHeight, 0.36, wallMat, 'concrete', true, true);
    // Steel header lintel above doorway
    addBox(0, wallHeight - 0.28, z, gapWidth + 0.2, 0.56, 0.42, steelFrameMat, 'metal', true, false);
  };

  // =========================================================================
  // BAY 01 (z = 24 .. 12): Movement, Sprint, Low Crouch Gantry & Lean Cover
  // =========================================================================
  addBaySign('01 · MOVEMENT & STANCE', 'WASD · SHIFT SPRINT · C CROUCH · Q/E LEAN', -6.22, 2.45, 19.2, Math.PI * 0.5);

  // Composite Steel Crouch Gantry (1.36m under-beam clearance -> requires Crouch [C] to pass!)
  addBox(-2.2, 1.35, 16.4, 0.26, 2.7, 0.26, steelFrameMat, 'metal', true, true);
  addBox(2.2, 1.35, 16.4, 0.26, 2.7, 0.26, steelFrameMat, 'metal', true, true);
  addBox(0, 2.02, 16.4, 4.8, 1.32, 0.55, hazardMat, 'metal', true, true);
  // Wing walls force crouching under the center gantry
  addBox(-4.35, 1.4, 16.4, 4.0, 2.8, 0.36, wallMat, 'concrete', true, true);
  addBox(4.35, 1.4, 16.4, 4.0, 2.8, 0.36, wallMat, 'concrete', true, true);

  // Lean Barricade Corner (concrete wall + timber bumper)
  addBox(-1.6, 1.15, 13.6, 2.6, 2.3, 0.32, wallMat, 'concrete', true, true);
  addBox(-0.22, 1.15, 13.6, 0.14, 2.3, 0.38, woodMat, 'wood', true, false);

  // =========================================================================
  // BAY 02 (z = 12 .. 4.5): Concrete Jersey Vault Barrier (0.96m vault collider)
  // =========================================================================
  addBaySign('02 · VAULT & MANTLE', 'APPROACH CONCRETE BARRIER & PRESS VAULT', -6.22, 2.45, 9.2, Math.PI * 0.5);

  // Single clean vertical physics vault collider (0.96m tall x 0.42m deep) matching GymWorld.ts
  // so VaultDetector's forward/downward probes never hit a sub-0.40m base skirt lip.
  addBox(0, 0.48, 7.6, 5.2, 0.96, 0.42, wallMat, 'concrete', true, true);
  // Visual-only flared Jersey barrier base plinth & top hazard band (zero physics interference, zero Z-fighting)
  addBox(0, 0.111, 7.6, 5.18, 0.22, 0.64, wallMat, 'concrete', false, false);
  addBox(0, 0.922, 7.6, 5.18, 0.078, 0.426, hazardMat, 'concrete', false, false);
  // Side flank dividers so the player vaults over the barrier
  addBox(-4.45, 1.6, 7.6, 3.7, 3.2, 0.4, wallMat, 'concrete', true, true);
  addBox(4.45, 1.6, 7.6, 3.7, 3.2, 0.4, wallMat, 'concrete', true, true);

  // =========================================================================
  // BAY 03 (z = 4.5 .. -4.5): Aiming, Hold Breath & 3 Reactive Steel Targets
  // =========================================================================
  addBaySign('03 · MARKSMANSHIP', 'RMB ADS · SHIFT HOLD BREATH · HIT 3 STEEL TARGETS', -6.22, 2.45, 2.0, Math.PI * 0.5);

  // Firing line counter + sandbag rest (east side of lane shoots toward east target alcove)
  addBox(0.9, 0.52, 1.8, 0.65, 1.04, 3.8, woodMat, 'wood', true, true);
  addBox(0.9, 1.12, 1.2, 0.45, 0.18, 0.78, sandbagMat, 'gravel', false, false);
  addBox(0.9, 1.12, 2.3, 0.45, 0.18, 0.78, sandbagMat, 'gravel', false, false);

  // 3 Articulated Hinged AR500 Steel Silhouette Targets (positioned clearly along the east bay wall)
  const targetCoords: Array<{ id: string; label: string; x: number; z: number }> = [
    { id: 'tut_steel_1', label: 'Alpha Steel', x: 5.1, z: 3.1 },
    { id: 'tut_steel_2', label: 'Bravo Steel', x: 5.1, z: 1.6 },
    { id: 'tut_steel_3', label: 'Charlie Steel', x: 5.1, z: 0.1 },
  ];

  for (const spec of targetCoords) {
    const base = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.14, 0.56)), steelFrameMat);
    base.position.set(spec.x, 0.07, spec.z);
    base.receiveShadow = true;
    root.add(base);

    const pivot = new THREE.Group();
    pivot.position.set(spec.x, 0.14, spec.z);
    // Rotate toward player firing line (-X)
    pivot.rotation.y = -Math.PI * 0.5;
    root.add(pivot);

    const post = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.032, 0.04, 1.08, 8)), steelFrameMat);
    post.position.set(0, 0.54, 0);
    pivot.add(post);

    const plateMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xd4d8dc,
        roughness: 0.36,
        metalness: 0.76,
      }),
    );
    const plateMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.72, 0.035)), plateMat);
    plateMesh.position.set(0, 1.24, 0);
    plateMesh.castShadow = !isSoftwareGl;
    plateMesh.receiveShadow = true;
    plateMesh.userData.surface = 'metal';
    plateMesh.userData.steelTargetId = spec.id;
    pivot.add(plateMesh);

    const headPlate = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.2, 0.22, 0.035)), plateMat);
    headPlate.position.set(0, 1.71, 0);
    headPlate.userData.surface = 'metal';
    headPlate.userData.steelTargetId = spec.id;
    pivot.add(headPlate);

    const bullseye = new THREE.Mesh(trackGeo(new THREE.CircleGeometry(0.11, 14)), redAccentMat);
    bullseye.position.set(0, 1.28, 0.02);
    pivot.add(bullseye);

    raycastMeshes.push(plateMesh, headPlate);
    physics.addBox({
      id: spec.id,
      minX: spec.x - 0.12,
      maxX: spec.x + 0.12,
      minY: 0.86,
      maxY: 1.84,
      minZ: spec.z - 0.26,
      maxZ: spec.z + 0.26,
      surface: 'metal',
      blocksMovement: false,
      blocksRaycast: true,
      meshRef: plateMesh,
    });

    steelTargets.push({
      id: spec.id,
      label: spec.label,
      distanceLabel: '6m',
      pivot,
      plateMesh,
      hitAngle: 0,
      hitAngVel: 0,
      hitFlashTimer: 0,
      baseMat: plateMat,
    });
  }

  // =========================================================================
  // BAY 04 (z = -4.5 .. -12): Weapon Handling, Optics & Reload Bench
  // =========================================================================
  addBayPortal(-3.6, 5.2, 3.6);
  addBaySign('04 · WEAPON HANDLING', 'B CANTED · MMB POINT AIM · R RELOAD · G SUPPRESSOR · 1/2/3', -6.22, 2.45, -7.8, Math.PI * 0.5);

  // Composite Ammo & Optics Prep Table
  addBox(3.4, 0.45, -7.8, 1.1, 0.9, 2.6, woodMat, 'wood', true, true);
  addBox(3.3, 1.04, -7.2, 0.44, 0.28, 0.62, steelFrameMat, 'metal', false, false);
  addBox(3.4, 1.02, -8.2, 0.34, 0.24, 0.48, brassMat, 'metal', false, false);

  // =========================================================================
  // BAY 05 (z = -12 .. -19.2): Interactive Wooden Breach Door & CQB Bay
  // =========================================================================
  addBaySign('05 · DOORS & CQB BREACH', 'F OPEN DOOR · V WEAPON BASH · X PUSH-KICK BREACH', -6.22, 2.45, -14.8, Math.PI * 0.5);

  // Partition wall with 1.18m doorframe opening at z = -16.8
  addBox(-3.45, 1.8, -16.8, 5.7, 3.6, 0.36, wallMat, 'concrete', true, true);
  addBox(3.45, 1.8, -16.8, 5.7, 3.6, 0.36, wallMat, 'concrete', true, true);
  addBox(0, 2.95, -16.8, 1.32, 1.3, 0.38, wallMat, 'concrete', true, true);
  // Steel doorframe jambs
  addBox(-0.62, 1.15, -16.8, 0.08, 2.3, 0.42, steelFrameMat, 'metal', false, false);
  addBox(0.62, 1.15, -16.8, 0.08, 2.3, 0.42, steelFrameMat, 'metal', false, false);

  // Full interactive & destructible Bay 05 Breach Door (identical system to Hideout & Combat)
  const doorSystem = new DestructibleDoorSystem(root, physics, isSoftwareGl);
  doorSystem.addDoor({
    id: TUTORIAL_BREACH_DOOR_ID,
    label: 'Bay 05 Breach Door',
    hingePos: [-0.57, 0, -16.8],
    closedYawRad: 0,
    swingSign: 1,
    width: 1.14,
    height: 2.24,
    thickness: 0.075,
    repairable: true,
    style: 'bunker_wood',
    addFrameJamb: false,
  });
  raycastMeshes.push(...doorSystem.getRaycastMeshes());

  // =========================================================================
  // BAY 06 (z = -19.2 .. -27.5): Darkened NVG & IR Stencil Alcove
  // =========================================================================
  // Enclosed concrete roof & dark matte interior walls for realistic low-light NVG contrast
  addBox(0, 3.65, -23.0, 13.0, 0.4, 9.4, darkWallMat, 'concrete', true, true);
  addBox(-6.22, 1.8, -23.0, 0.18, 3.6, 9.0, darkWallMat, 'concrete', false, false);
  addBox(6.22, 1.8, -23.0, 0.18, 3.6, 9.0, darkWallMat, 'concrete', false, false);
  physics.addInteriorZone({
    minX: -6.3,
    maxX: 6.3,
    minY: 0,
    maxY: 3.6,
    minZ: -27.7,
    maxZ: -18.3,
    material: 'concrete',
  });

  addBaySign('06 · NIGHT VISION & OPTICS', 'T FLASHLIGHT · L LASER · J FLIP NVG TO SPOT IR MARKER', -6.08, 2.4, -22.2, Math.PI * 0.5, '#38bdf8');

  // Subtle red safety light inside dark alcove (non-shadow-casting)
  const nvgAccentLight = new THREE.PointLight(0xff4422, 1.2, 7.5, 1.8);
  nvgAccentLight.position.set(0, 3.1, -23.2);
  nvgAccentLight.castShadow = false;
  root.add(nvgAccentLight);

  // IR-ONLY Marker Stencil on east wall (strictly on IR_LAYER — glows brightly through NVG!)
  const irTex = trackTex(
    createStencilSignTexture('IR BEACON · ACTIVE', 'VISIBLE UNDER NIGHT VISION [J]', '#4ade80', '#101914', maxAniso),
  );
  irTex.colorSpace = THREE.SRGBColorSpace;
  const irMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: irTex,
      color: 0xb7ffd0,
    }),
  );
  const irPlate = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(2.4, 0.85)), irMat);
  irPlate.position.set(6.05, 1.75, -23.2);
  irPlate.rotation.y = -Math.PI * 0.5;
  irPlate.layers.set(IR_LAYER);
  root.add(irPlate);

  addBayPortal(-27.6, 4.8, 3.6);

  // =========================================================================
  // BAY 07 (z = -27.6 .. -35.8): Belt Ordnance Grenade Throwing Pit
  // =========================================================================
  addBaySign('07 · BELT ORDNANCE', '4 / H DRAW GRENADE · RMB PULL PIN · LMB THROW IN PIT', -6.22, 2.45, -31.2, Math.PI * 0.5);

  const grenadePitCenter = new THREE.Vector3(3.6, 0.05, -32.2);
  // Protective throwing parapet between lane and east blast pit
  addBox(1.15, 0.55, -32.2, 0.55, 1.1, 4.6, wallMat, 'concrete', true, true);
  addBox(1.15, 1.18, -32.2, 0.52, 0.18, 4.2, sandbagMat, 'gravel', false, false);
  // Recessed blast pit sandbag surround & painted bullseye ring
  addBox(3.6, 0.35, -29.6, 4.4, 0.7, 0.55, sandbagMat, 'gravel', true, true);
  addBox(3.6, 0.35, -34.8, 4.4, 0.7, 0.55, sandbagMat, 'gravel', true, true);
  const pitRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(0.95, 1.25, 24)), redAccentMat);
  pitRing.rotation.x = -Math.PI * 0.5;
  pitRing.position.set(grenadePitCenter.x, 0.02, grenadePitCenter.z);
  root.add(pitRing);

  // =========================================================================
  // BAY 08 (z = -35.8 .. -47.0): 3D TAC-PDA, Map & Fire Support Deck
  // =========================================================================
  addBayPortal(-35.8, 5.2, 3.6);
  addBaySign('08 · TAC-PDA & FIRE SUPPORT', 'P / M OPEN PDA · TAB FIRE SUPPORT · SPACE STRIKE / Z PING', -6.22, 2.45, -39.4, Math.PI * 0.5, '#f59e0b');

  // Tactical observation desk
  addBox(-3.2, 0.5, -39.2, 1.2, 1.0, 2.2, steelFrameMat, 'metal', true, true);
  addBox(-3.2, 1.02, -39.2, 1.12, 0.06, 2.08, woodMat, 'wood', true, true);

  // Final Fire Support Impact Zone with red marker ring & training blast VFX
  const fireSupportPitCenter = new THREE.Vector3(0, 0.05, -43.8);
  const strikeRingOuter = new THREE.Mesh(trackGeo(new THREE.RingGeometry(1.8, 2.15, 28)), redAccentMat);
  strikeRingOuter.rotation.x = -Math.PI * 0.5;
  strikeRingOuter.position.set(fireSupportPitCenter.x, 0.02, fireSupportPitCenter.z);
  root.add(strikeRingOuter);

  const strikeRingInner = new THREE.Mesh(trackGeo(new THREE.RingGeometry(0.55, 0.8, 20)), lanePaintMat);
  strikeRingInner.rotation.x = -Math.PI * 0.5;
  strikeRingInner.position.set(fireSupportPitCenter.x, 0.025, fireSupportPitCenter.z);
  root.add(strikeRingInner);

  // =========================================================================
  // MERGED KILLHOUSE ARCHITECTURAL TRIM, SHELVING & BAY 03 PLINKING RAIL
  // =========================================================================
  const tutSteelGeos: THREE.BufferGeometry[] = [];
  const tutWoodGeos: THREE.BufferGeometry[] = [];
  const pushTutBox = (
    bucket: THREE.BufferGeometry[],
    w: number,
    h: number,
    d: number,
    cx: number,
    cy: number,
    cz: number,
  ): void => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    bucket.push(g);
  };
  const pushTutCyl = (
    bucket: THREE.BufferGeometry[],
    r: number,
    len: number,
    cx: number,
    cy: number,
    cz: number,
    rotX = 0,
  ): void => {
    const g = new THREE.CylinderGeometry(r, r, len, 8);
    if (rotX !== 0) g.rotateX(rotX);
    g.translate(cx, cy, cz);
    bucket.push(g);
  };

  // Overhead steel cross-gantries & dual wall conduit runs along killhouse length
  for (const gz of [21.5, 11.2, -0.8, -11.4, -31.8, -41.5]) {
    pushTutBox(tutSteelGeos, 12.6, 0.22, 0.28, 0, 4.18, gz);
  }
  pushTutCyl(tutSteelGeos, 0.04, 68.0, -6.18, 3.65, -10.5, Math.PI * 0.5);
  pushTutCyl(tutSteelGeos, 0.04, 68.0, 6.18, 3.65, -10.5, Math.PI * 0.5);

  // Bay 01 corner logistics pallet (-4.8, 22.8, top Y = 0.14m)
  for (const pz of [-0.4, 0, 0.4]) {
    pushTutBox(tutWoodGeos, 1.18, 0.09, 0.11, -4.8, 0.045, 22.8 + pz);
  }
  for (let s = 0; s < 5; s++) {
    pushTutBox(tutWoodGeos, 1.22, 0.04, 0.14, -4.8, 0.115, 22.8 - 0.4 + s * 0.2);
  }
  physics.addBox({
    minX: -5.44,
    maxX: -4.16,
    minY: 0,
    maxY: 0.14,
    minZ: 22.28,
    maxZ: 23.32,
    surface: 'wood',
    blocksMovement: true,
    blocksRaycast: true,
  });

  // Bay 04 east-wall 3-tier armory shelving rack (5.65, -7.8)
  for (const rx of [-0.22, 0.22]) {
    for (const rz of [-0.75, 0.75]) {
      pushTutBox(tutSteelGeos, 0.045, 1.84, 0.045, 5.65 + rx, 0.92, -7.8 + rz);
      physics.addBox({
        minX: 5.65 + rx - 0.03,
        maxX: 5.65 + rx + 0.03,
        minY: 0,
        maxY: 1.84,
        minZ: -7.8 + rz - 0.03,
        maxZ: -7.8 + rz + 0.03,
        surface: 'metal',
        blocksMovement: true,
        blocksRaycast: true,
      });
    }
  }
  for (const sy of [0.16, 0.72, 1.28, 1.82]) {
    pushTutBox(tutSteelGeos, 0.48, 0.035, 1.56, 5.65, sy, -7.8);
    physics.addBox({
      minX: 5.65 - 0.24,
      maxX: 5.65 + 0.24,
      minY: sy - 0.0175,
      maxY: sy + 0.0175,
      minZ: -7.8 - 0.78,
      maxZ: -7.8 + 0.78,
      surface: 'metal',
      blocksMovement: true,
      blocksRaycast: true,
    });
  }

  // Bay 03 timber bottle/can plinking rail south of the steel targets (X = 5.1, Z = -1.65, top Y = 0.92m)
  addBox(5.1, 0.89, -1.65, 0.42, 0.06, 1.7, woodMat, 'wood', true, true);
  addBox(5.1, 0.43, -2.35, 0.36, 0.86, 0.08, steelFrameMat, 'metal', true, true);
  addBox(5.1, 0.43, -0.95, 0.36, 0.86, 0.08, steelFrameMat, 'metal', true, true);

  const flushTutBucket = (
    geos: THREE.BufferGeometry[],
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial,
  ): void => {
    if (geos.length === 0) return;
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return;
    trackGeo(merged);
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = !isSoftwareGl;
    m.receiveShadow = true;
    m.userData.surface = surface;
    root.add(m);
    raycastMeshes.push(m);
  };
  flushTutBucket(tutSteelGeos, steelFrameMat, 'metal');
  flushTutBucket(tutWoodGeos, woodMat, 'wood');

  // Reusable training strike blast VFX (zero allocation on detonation)
  const blastPlumeMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  const blastSmokeMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2d2b28, roughness: 0.98, transparent: true, opacity: 0.72, depthWrite: false }),
  );
  const blastPlume = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(1.1, 12, 10)), blastPlumeMat);
  blastPlume.visible = false;
  const blastSmoke = new THREE.Mesh(trackGeo(new THREE.IcosahedronGeometry(1.5, 1)), blastSmokeMat);
  blastSmoke.visible = false;
  const blastLight = new THREE.PointLight(0xff8c2a, 0, 26, 1.5);
  blastLight.castShadow = false;
  blastLight.visible = false;
  root.add(blastPlume, blastSmoke, blastLight);
  let blastTimerSec = 0;

  // === Floating 3D Waypoint Beacon (guides player to active station) ===
  const waypointGroup = new THREE.Group();
  const wpRingMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const wpRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(0.45, 0.62, 24)), wpRingMat);
  wpRing.rotation.x = -Math.PI * 0.5;
  wpRing.position.y = 0.03;
  const wpDiamond = new THREE.Mesh(trackGeo(new THREE.OctahedronGeometry(0.18, 0)), wpRingMat);
  wpDiamond.position.y = 1.65;
  waypointGroup.add(wpRing, wpDiamond);
  waypointGroup.position.set(0, 0, 14.2);
  root.add(waypointGroup);
  _wpPos.set(0, 0, 14.2);

  const openDoorForSkip = (): void => {
    const d = doorSystem.getDoor(TUTORIAL_BREACH_DOOR_ID);
    if (!d) return;
    if (d.hingeMode === 'attached' && Math.abs(d.angleRad) < 0.75) {
      doorSystem.executeOption(TUTORIAL_BREACH_DOOR_ID, 'open', {
        actorPos: _skipActorPos,
        actorForward: _skipActorDir,
        horizontalSpeedMps: 0,
        isSprinting: false,
      });
    }
  };

  const resetDoor = (): void => {
    doorSystem.applyRemoteAction({
      doorId: TUTORIAL_BREACH_DOOR_ID,
      action: 'repair',
      angleRad: 0,
      angularVel: 0,
      latched: true,
      damageState: 0,
      chipDamage: 0,
      hingeMode: 'attached',
      destructionOutcome: 'none',
      seed: 1,
    });
  };

  const triggerTrainingStrikeBlast = (x: number, z: number): void => {
    blastTimerSec = 1.85;
    blastPlume.position.set(x, 0.9, z);
    blastSmoke.position.set(x, 1.1, z);
    blastLight.position.set(x, 3.2, z);
    blastPlume.visible = true;
    blastSmoke.visible = true;
    blastLight.visible = true;
    blastLight.intensity = 22;
  };

  const update = (dt: number, elapsedSec: number, listenerPos?: Readonly<THREE.Vector3>): void => {
    // 1. Smoothly damp 3D waypoint ring & bobbing diamond
    waypointGroup.position.x = THREE.MathUtils.damp(waypointGroup.position.x, _wpPos.x, 9, dt);
    waypointGroup.position.z = THREE.MathUtils.damp(waypointGroup.position.z, _wpPos.z, 9, dt);
    wpDiamond.position.y = 1.62 + Math.sin(elapsedSec * 3.2) * 0.14;
    wpDiamond.rotation.y = elapsedSec * 1.6;

    // 2. Step full DestructibleDoorSystem (hinges, splinters, debris, penetrable holes)
    doorSystem.update(dt, listenerPos);

    // 3. Reactive AR500 steel target spring return & impact flash
    for (let i = 0; i < steelTargets.length; i++) {
      const st = steelTargets[i];
      if (Math.abs(st.hitAngle) > 1e-4 || Math.abs(st.hitAngVel) > 1e-4) {
        const accel = -46 * st.hitAngle - 7.5 * st.hitAngVel;
        st.hitAngVel += accel * dt;
        st.hitAngle = THREE.MathUtils.clamp(st.hitAngle + st.hitAngVel * dt, -0.2, 0.85);
        st.pivot.rotation.x = -st.hitAngle;
      }
      if (st.hitFlashTimer > 0) {
        st.hitFlashTimer = Math.max(0, st.hitFlashTimer - dt);
        st.baseMat.emissive.setHex(st.hitFlashTimer > 0 ? 0xffaa44 : 0x000000);
        st.baseMat.emissiveIntensity = st.hitFlashTimer > 0 ? 0.85 : 0;
      }
    }

    // 4. Training Fire Support Blast VFX animation
    if (blastTimerSec > 0) {
      blastTimerSec = Math.max(0, blastTimerSec - dt);
      const t = 1 - blastTimerSec / 1.85;
      const flashScale = 1.0 + t * 5.2;
      blastPlume.scale.setScalar(flashScale);
      blastPlumeMat.opacity = Math.max(0, (1 - t * 2.2) * 0.9);
      blastPlume.visible = blastPlumeMat.opacity > 0.02;

      const smokeScale = 1.2 + t * 5.8;
      blastSmoke.scale.set(smokeScale * 0.85, smokeScale * 1.15, smokeScale * 0.85);
      blastSmoke.position.y = 1.0 + t * 5.2;
      blastSmokeMat.opacity = Math.max(0, (1 - t) * 0.72);

      blastLight.intensity = Math.max(0, (1 - t * 3.5) * 22);
      if (blastTimerSec <= 0) {
        blastPlume.visible = false;
        blastSmoke.visible = false;
        blastLight.visible = false;
      }
    }
  };

  return {
    physics,
    raycastMeshes,
    steelTargets,
    paperTargets,
    doorSystem,
    doorId: TUTORIAL_BREACH_DOOR_ID,
    grenadePitCenter,
    fireSupportPitCenter,
    setWaypointPosition: (x, y, z, visible) => {
      _wpPos.set(x, y, z);
      waypointGroup.visible = visible;
    },
    openDoorForSkip,
    resetDoor,
    triggerTrainingStrikeBlast,
    update,
    dispose: () => {
      doorSystem.dispose();
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      for (const t of ownedTex) t.dispose();
      textures.dispose();
      if (root.parent) root.parent.remove(root);
    },
  };
}

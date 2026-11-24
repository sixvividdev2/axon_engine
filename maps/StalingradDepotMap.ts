import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCabinWoodTexture,
  createRustedMetalTexture,
  createWallBuyTexture,
} from './MapTextures';
import {
  buildNavGraph,
  BuiltMapInstance,
  IMapDefinition,
  MapInteractable,
  MapLightingPreset,
  MapWindowBarrier,
  NavNode,
  ZombieSpawnerDef,
} from './types';

// Frozen Stalingrad Twilight: Icy slate-blue snow haze balanced by warm amber depot furnace lamps
const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x0b131c,
  fogHex: 0x0e1824,
  fogDensity: 0.019,
  envIntensity: 0.34,
  hemiSkyHex: 0x6f8faf,
  hemiGroundHex: 0x1b232b,
  hemiIntensity: 0.48,
  keyLightHex: 0xb6d4f4,
  keyLightIntensity: 0.78,
  keyLightPos: [26, 36, 18],
};

function createSnowyConcreteTexture(aniso: number, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3c454e';
  g.fillRect(0, 0, 256, 256);
  // Concrete slabs + frost streaks
  g.strokeStyle = 'rgba(20, 25, 32, 0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  for (let i = 0; i < 420; i++) {
    const x = (i * 73) % 256;
    const y = (i * 139) % 256;
    const r = 2 + (i % 7);
    g.fillStyle = i % 3 === 0 ? 'rgba(218, 232, 245, 0.24)' : 'rgba(28, 35, 42, 0.22)';
    g.fillRect(x, y, r, r * 0.6);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = aniso;
  return tex;
}

function createDepotBrickTexture(aniso: number, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#38302c';
  g.fillRect(0, 0, 256, 256);
  const bw = 32;
  const bh = 16;
  for (let row = 0; row < 16; row++) {
    const offset = (row % 2) * (bw * 0.5);
    for (let col = -1; col < 9; col++) {
      const shade = 48 + ((row * 17 + col * 31) & 15);
      g.fillStyle = `rgb(${shade + 18}, ${shade + 2}, ${shade - 4})`;
      g.fillRect(col * bw + offset + 1, row * bh + 1, bw - 2, bh - 2);
    }
  }
  // Frost rime near mortar
  for (let i = 0; i < 240; i++) {
    g.fillStyle = 'rgba(200, 218, 234, 0.12)';
    g.fillRect((i * 59) % 256, (i * 97) % 256, 5, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = aniso;
  return tex;
}

function buildStalingradDepot(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -25.5;
  physics.boundsMaxX = 25.5;
  physics.boundsMinZ = -25.5;
  physics.boundsMaxZ = 24.5;

  const sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const interactables: MapInteractable[] = [];
  const windowBarriers: MapWindowBarrier[] = [];
  const zombieSpawners: ZombieSpawnerDef[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMats.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture>(t: T): T => {
    ownedTextures.push(t);
    return t;
  };

  scene.background = new THREE.Color(LIGHTING_PRESET.backgroundHex);
  scene.fog = new THREE.FogExp2(
    LIGHTING_PRESET.fogHex,
    LIGHTING_PRESET.fogDensity * qProfile.fogDensityScale,
  );

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = LIGHTING_PRESET.envIntensity * qProfile.envIntensityScale;
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(
    LIGHTING_PRESET.hemiSkyHex,
    LIGHTING_PRESET.hemiGroundHex,
    LIGHTING_PRESET.hemiIntensity,
  );
  sceneGroup.add(hemi);

  const moonLight = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  moonLight.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl && qProfile.castShadows) {
    moonLight.castShadow = true;
    const sm = Math.min(2048, qProfile.shadowMapSize);
    moonLight.shadow.mapSize.set(sm, sm);
    moonLight.shadow.camera.near = 2;
    moonLight.shadow.camera.far = 90;
    moonLight.shadow.camera.left = -30;
    moonLight.shadow.camera.right = 30;
    moonLight.shadow.camera.top = 30;
    moonLight.shadow.camera.bottom = -30;
    moonLight.shadow.bias = -0.0005;
    moonLight.shadow.normalBias = 0.025;
  }
  sceneGroup.add(moonLight);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  // Procedural PBR textures & materials
  const snowConcTex = trackTex(createSnowyConcreteTexture(maxAniso, 10, 10));
  const brickTex = trackTex(createDepotBrickTexture(maxAniso, 6, 2));
  const asphaltTex = trackTex(createAsphaltRoadTexture(maxAniso, 6, 6, false, 1942));
  const woodTex = trackTex(createCabinWoodTexture(maxAniso, 2, 1, '#5a4533', 1943));
  const rustTex = trackTex(createRustedMetalTexture(maxAniso, '#4b3b34', 1944));

  const matFloorConc = trackMat(new THREE.MeshStandardMaterial({ map: snowConcTex, roughness: 0.86, metalness: 0.04 }));
  const matYardGround = trackMat(new THREE.MeshStandardMaterial({ map: asphaltTex, color: 0x9ab0c4, roughness: 0.9, metalness: 0.04 }));
  const matSnowDrift = trackMat(new THREE.MeshStandardMaterial({ color: 0xcbd8e6, roughness: 0.94, metalness: 0.02 }));
  const matBrick = trackMat(new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.88, metalness: 0.04 }));
  const matTunnelConc = trackMat(new THREE.MeshStandardMaterial({ color: 0x2b333a, roughness: 0.92, metalness: 0.06 }));
  const matSteelDark = trackMat(new THREE.MeshStandardMaterial({ color: 0x222830, roughness: 0.44, metalness: 0.78 }));
  const matSteelRail = trackMat(new THREE.MeshStandardMaterial({ color: 0x6f7b87, roughness: 0.3, metalness: 0.88 }));
  const matLocoGreen = trackMat(new THREE.MeshStandardMaterial({ color: 0x263830, roughness: 0.56, metalness: 0.48 }));
  const matBoxcarRed = trackMat(new THREE.MeshStandardMaterial({ map: rustTex, color: 0x733a2d, roughness: 0.78, metalness: 0.34 }));
  const matTimber = trackMat(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.88, metalness: 0.03 }));
  const matBrass = trackMat(new THREE.MeshStandardMaterial({ color: 0xc29c52, roughness: 0.35, metalness: 0.82 }));
  const matRoofIron = trackMat(new THREE.MeshStandardMaterial({ color: 0x1e252c, roughness: 0.72, metalness: 0.52 }));
  const matAmberBulb = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffd58a,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.9,
      roughness: 0.2,
    }),
  );
  const matFloodBulb = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe6f4ff,
      emissive: 0x93c5fd,
      emissiveIntensity: 0.25,
      roughness: 0.2,
    }),
  );

  const propCtx: PropFactoryContext = {
    sceneGroup,
    physics,
    raycastMeshes,
    isSoftwareGl,
    trackGeo,
    trackMat,
  };

  const addSolidBox = (
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    colliderId?: string,
    parent: THREE.Object3D = sceneGroup,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    parent.add(mesh);
    raycastMeshes.push(mesh);
    physics.addBox({
      id: colliderId,
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minY: cy - h * 0.5,
      maxY: cy + h * 0.5,
      minZ: cz - d * 0.5,
      maxZ: cz + d * 0.5,
      surface,
      blocksMovement: true,
    });
    return mesh;
  };

  const addVisualBox = (
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    parent: THREE.Object3D = sceneGroup,
    surface: BodycamSurfaceMaterial = 'concrete',
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    parent.add(mesh);
    raycastMeshes.push(mesh);
    return mesh;
  };

  // === 1. GROUND & OUTDOOR PERIMETER SURROUND (NO VOID) ===
  const groundMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(160, 160)), matYardGround);
  groundMesh.rotation.x = -Math.PI * 0.5;
  groundMesh.position.y = 0;
  groundMesh.receiveShadow = !isSoftwareGl;
  groundMesh.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(groundMesh);
  raycastMeshes.push(groundMesh);

  // Ticket Hall raised concrete slab (South center: x in [-10, 10], z in [8, 22])
  addSolidBox(0, 0.02, 15.0, 20.4, 0.04, 14.4, matFloorConc, 'concrete');
  // Locomotive Shed floor slab (West: x in [-24, -10], z in [-20, 16])
  addSolidBox(-17.0, 0.02, -2.0, 14.4, 0.04, 36.4, matFloorConc, 'concrete');

  // Snow drifts softening walls and perimeter corners (Y >= 0.02 offset)
  const driftCoords: Array<[number, number, number, number]> = [
    [-23.5, 19.5, 4.2, 3.2],
    [23.5, 19.0, 4.8, 3.6],
    [23.2, -22.0, 5.4, 4.0],
    [-23.2, -22.5, 5.0, 3.5],
    [9.8, 2.5, 2.4, 2.0],
    [18.5, -14.0, 3.6, 2.6],
  ];
  for (const [dx, dz, rw, rd] of driftCoords) {
    const drift = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(rw * 0.42, rw * 0.62, 0.36, 10)), matSnowDrift);
    drift.position.set(dx, 0.16, dz);
    drift.scale.set(1, 1, rd / rw);
    drift.receiveShadow = !isSoftwareGl;
    sceneGroup.add(drift);
  }

  // Outer fortified masonry depot walls (5.6m tall) enclosing playable bounds cleanly
  const WALL_H = 5.6;
  // North outer wall (z = -25)
  addSolidBox(0, WALL_H * 0.5, -25.0, 51.0, WALL_H, 0.7, matBrick, 'concrete');
  // South outer wall (z = 23.8) with 2 window bay cutouts for Ticket Hall spawners
  addSolidBox(-16.5, WALL_H * 0.5, 23.8, 18.0, WALL_H, 0.7, matBrick, 'concrete');
  addSolidBox(0, WALL_H * 0.5, 23.8, 7.6, WALL_H, 0.7, matBrick, 'concrete');
  addSolidBox(16.5, WALL_H * 0.5, 23.8, 18.0, WALL_H, 0.7, matBrick, 'concrete');
  // Lintels & sills over Ticket Hall South windows at x = -5.6 and x = +5.6
  for (const wx of [-5.6, 5.6]) {
    addSolidBox(wx, 0.48, 23.8, 3.6, 0.96, 0.7, matBrick, 'concrete');
    addSolidBox(wx, 4.1, 23.8, 3.6, 3.0, 0.7, matBrick, 'concrete');
  }
  // West outer wall (x = -25.0) with 2 Locomotive Shed window cutouts at z = -10 and z = 4
  addSolidBox(-25.0, WALL_H * 0.5, -18.5, 0.7, WALL_H, 13.4, matBrick, 'concrete');
  addSolidBox(-25.0, WALL_H * 0.5, -3.0, 0.7, WALL_H, 10.6, matBrick, 'concrete');
  addSolidBox(-25.0, WALL_H * 0.5, 14.8, 0.7, WALL_H, 18.4, matBrick, 'concrete');
  for (const wz of [-10.0, 4.0]) {
    addSolidBox(-25.0, 0.48, wz, 0.7, 0.96, 3.4, matBrick, 'concrete');
    addSolidBox(-25.0, 4.1, wz, 0.7, 3.0, 3.4, matBrick, 'concrete');
  }
  // East outer wall (x = 25.0) with 2 Freight Yard window/breach cutouts at z = 6 and z = -12
  addSolidBox(25.0, WALL_H * 0.5, -19.5, 0.7, WALL_H, 11.4, matBrick, 'concrete');
  addSolidBox(25.0, WALL_H * 0.5, -3.0, 0.7, WALL_H, 14.6, matBrick, 'concrete');
  addSolidBox(25.0, WALL_H * 0.5, 15.8, 0.7, WALL_H, 16.4, matBrick, 'concrete');
  for (const wz of [-12.0, 6.0]) {
    addSolidBox(25.0, 0.48, wz, 0.7, 0.96, 3.4, matBrick, 'concrete');
    addSolidBox(25.0, 4.1, wz, 0.7, 3.0, 3.4, matBrick, 'concrete');
  }

  // === 2. ZONE DIVIDERS & ARCHITECTURAL ROOFS ===
  // Ticket Hall (Zone 1: 'lobby', x in [-10, 10], z in [8, 23.5])
  // North partition separating Ticket Hall from Center Freight Yard (with central reinforced wall + ticket booth)
  addSolidBox(0, WALL_H * 0.5, 8.0, 20.2, WALL_H, 0.6, matBrick, 'concrete');
  // West partition separating Ticket Hall from Locomotive Shed (doorway gap at z in [11.4, 14.6])
  addSolidBox(-10.0, WALL_H * 0.5, 9.7, 0.6, WALL_H, 3.4, matBrick, 'concrete');
  addSolidBox(-10.0, WALL_H * 0.5, 19.2, 0.6, WALL_H, 9.2, matBrick, 'concrete');
  addSolidBox(-10.0, 4.45, 13.0, 0.6, 2.3, 3.2, matBrick, 'concrete');
  // East partition separating Ticket Hall from Freight Yard (doorway gap at z in [11.4, 14.6])
  addSolidBox(10.0, WALL_H * 0.5, 9.7, 0.6, WALL_H, 3.4, matBrick, 'concrete');
  addSolidBox(10.0, WALL_H * 0.5, 19.2, 0.6, WALL_H, 9.2, matBrick, 'concrete');
  addSolidBox(10.0, 4.45, 13.0, 0.6, 2.3, 3.2, matBrick, 'concrete');

  // Ticket Hall bombed roof beams & skylight opening (dramatic moonlight shafts)
  addVisualBox(-6.4, WALL_H + 0.15, 15.8, 7.2, 0.3, 15.8, matRoofIron);
  addVisualBox(6.4, WALL_H + 0.15, 15.8, 7.2, 0.3, 15.8, matRoofIron);
  for (let rz = 9.8; rz <= 21.8; rz += 3.0) {
    addVisualBox(0, WALL_H + 0.05, rz, 6.2, 0.24, 0.26, matSteelDark, sceneGroup, 'metal');
  }

  // Ticket Kiosk Island (central kiting cover inside Ticket Hall)
  addSolidBox(0, 0.62, 16.5, 4.2, 1.24, 2.2, matTimber, 'wood');
  addVisualBox(0, 1.28, 16.5, 4.4, 0.08, 2.4, matBrass, sceneGroup, 'metal');
  for (const px of [-1.9, 1.9]) {
    addVisualBox(px, 2.2, 16.5, 0.14, 1.9, 0.14, matSteelDark, sceneGroup, 'metal');
  }
  addVisualBox(0, 3.15, 16.5, 4.4, 0.18, 2.4, matRoofIron, sceneGroup, 'metal');

  // Locomotive Shed East partition separating Shed (x < -10) from Freight Yard (x > -10)
  // Doorway gap to North Maintenance Tunnel / Yard at z in [-15.6, -12.4]
  addSolidBox(-10.0, WALL_H * 0.5, -2.0, 0.6, WALL_H, 20.6, matBrick, 'concrete');
  addSolidBox(-10.0, WALL_H * 0.5, -20.3, 0.6, WALL_H, 9.4, matBrick, 'concrete');
  addSolidBox(-10.0, 4.45, -14.0, 0.6, 2.3, 3.2, matBrick, 'concrete');

  // Locomotive Shed high corrugated roof trusses (bombed breach in middle)
  for (let tz = -22; tz <= 8; tz += 5.0) {
    addVisualBox(-17.5, WALL_H + 0.15, tz, 15.0, 0.32, 0.32, matSteelDark, sceneGroup, 'metal');
  }
  addVisualBox(-17.5, WALL_H + 0.35, -17.0, 15.2, 0.22, 15.0, matRoofIron, sceneGroup, 'metal');
  addVisualBox(-17.5, WALL_H + 0.35, 3.0, 15.2, 0.22, 11.0, matRoofIron, sceneGroup, 'metal');

  // === 3. PARALLEL RAIL TRACKS & COMPOSITE ARMORED LOCOMOTIVE (ZONE 2) ===
  const buildRailTrack = (cx: number, zMin: number, zMax: number): void => {
    const len = zMax - zMin;
    const zMid = (zMin + zMax) * 0.5;
    for (const rx of [-0.76, 0.76]) {
      const rail = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.11, len)), matSteelRail);
      rail.position.set(cx + rx, 0.09, zMid);
      rail.receiveShadow = !isSoftwareGl;
      sceneGroup.add(rail);
    }
    const tieGeo = trackGeo(new THREE.BoxGeometry(2.35, 0.06, 0.22));
    const tieCount = Math.floor(len / 0.85);
    const ties = new THREE.InstancedMesh(tieGeo, matTimber, tieCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < tieCount; i++) {
      dummy.position.set(cx, 0.045, zMin + i * 0.85 + 0.3);
      dummy.updateMatrix();
      ties.setMatrixAt(i, dummy.matrix);
    }
    ties.instanceMatrix.needsUpdate = true;
    ties.computeBoundingSphere();
    sceneGroup.add(ties);
  };

  buildRailTrack(-17.6, -23.5, 8.5);
  buildRailTrack(3.2, -23.5, 6.8);
  buildRailTrack(16.8, -23.5, 19.5);

  // Composite 10-part Armored Soviet Steam Locomotive inside Locomotive Shed (x=-17.6, z=-4.5)
  const locoGroup = new THREE.Group();
  locoGroup.position.set(-17.6, 0.12, -4.5);
  sceneGroup.add(locoGroup);
  // 1. Heavy steel chassis frame + collider
  addSolidBox(-17.6, 1.55, -4.5, 3.1, 2.9, 10.6, matLocoGreen, 'metal');
  // 2. Cylindrical pressurized boiler barrel
  const boiler = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(1.18, 1.18, 6.8, 18)), matSteelDark);
  boiler.rotation.x = Math.PI * 0.5;
  boiler.position.set(0, 2.35, 1.3);
  boiler.castShadow = !isSoftwareGl;
  locoGroup.add(boiler);
  // 3. Smoke stack & steam dome
  const stack = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.28, 0.34, 1.25, 12)), matSteelDark);
  stack.position.set(0, 3.7, 3.6);
  const dome = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.45, 0.52, 0.72, 12)), matLocoGreen);
  dome.position.set(0, 3.45, 1.1);
  // 4. Armored engineer cab with overhang roof
  const cab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.25, 2.1, 3.2)), matLocoGreen);
  cab.position.set(0, 2.65, -3.5);
  const cabRoof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.55, 0.18, 3.6)), matRoofIron);
  cabRoof.position.set(0, 3.76, -3.5);
  // 5. Angled steel cowcatcher plow & front bumper
  const plow = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(1.5, 1.4, 4)), matSteelDark);
  plow.rotation.set(Math.PI * 0.5, Math.PI * 0.25, 0);
  plow.position.set(0, 0.62, 5.75);
  // 6. Front brass headlamp (illuminates when power restored!)
  const locoLampMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffe4a0,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.25,
      roughness: 0.2,
    }),
  );
  const headlampHousing = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.32, 0.32, 0.36, 12)), matBrass);
  headlampHousing.rotation.x = Math.PI * 0.5;
  headlampHousing.position.set(0, 3.15, 4.82);
  const headlampLens = new THREE.Mesh(trackGeo(new THREE.CircleGeometry(0.26, 12)), locoLampMat);
  headlampLens.position.set(0, 3.15, 5.01);
  locoGroup.add(stack, dome, cab, cabRoof, plow, headlampHousing, headlampLens);
  // 7. 8 Flanged drive wheels + steel side rods
  const wheelGeo = trackGeo(new THREE.CylinderGeometry(0.58, 0.58, 0.18, 14));
  for (const side of [-1.45, 1.45]) {
    for (const wz of [-3.4, -1.2, 1.0, 3.2]) {
      const w = new THREE.Mesh(wheelGeo, matSteelRail);
      w.rotation.z = Math.PI * 0.5;
      w.position.set(side, 0.62, wz);
      locoGroup.add(w);
    }
    const rod = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.12, 6.8)), matSteelRail);
    rod.position.set(side + (side > 0 ? 0.1 : -0.1), 0.62, -0.1);
    locoGroup.add(rod);
  }

  // === 4. FREIGHT YARD BOXCARS & VEHICLE (ZONE 3: 'freight_yard') ===
  const buildFreightBoxcar = (cx: number, cz: number, len = 8.4): void => {
    const car = new THREE.Group();
    car.position.set(cx, 0.12, cz);
    sceneGroup.add(car);
    addSolidBox(cx, 1.65, cz, 2.85, 2.7, len, matBoxcarRed, 'metal');
    addVisualBox(cx, 3.12, cz, 3.05, 0.2, len + 0.2, matRoofIron, sceneGroup, 'metal');
    // Ribbed side braces & bogie wheels
    for (let zOff = -len * 0.4; zOff <= len * 0.41; zOff += len * 0.2) {
      const ribL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 2.55, 0.12)), matSteelDark);
      ribL.position.set(-1.46, 1.65, zOff);
      const ribR = ribL.clone();
      ribR.position.x = 1.46;
      car.add(ribL, ribR);
    }
    for (const side of [-1.15, 1.15]) {
      for (const wz of [-len * 0.34, -len * 0.22, len * 0.22, len * 0.34]) {
        const bw = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.36, 0.36, 0.16, 10)), matSteelRail);
        bw.rotation.z = Math.PI * 0.5;
        bw.position.set(side, 0.38, wz);
        car.add(bw);
      }
    }
  };
  buildFreightBoxcar(3.2, -3.2, 8.6);
  buildFreightBoxcar(16.8, -5.5, 9.0);

  // Rusted ZIL supply truck parked in Freight Yard southeast apron
  const truckMats: VehicleMaterials = {
    body: matLocoGreen,
    rust: trackMat(new THREE.MeshStandardMaterial({ map: rustTex, roughness: 0.86, metalness: 0.36 })),
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x171a1c, roughness: 0.95 })),
    rim: matSteelDark,
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x0f1215, roughness: 0.95 })),
    glass: trackMat(new THREE.MeshStandardMaterial({ color: 0x2c4352, roughness: 0.25, metalness: 0.6, transparent: true, opacity: 0.48 })),
    chrome: matSteelRail,
  };
  buildRustedVehicle(propCtx, 'zil_truck', 16.5, 0.0, 12.0, -0.35, truckMats);

  // Cover crates around yard
  addSolidBox(10.0, 0.55, 2.2, 1.6, 1.1, 1.6, matTimber, 'wood');
  addSolidBox(10.0, 0.48, -10.5, 1.8, 0.96, 1.4, matTimber, 'wood');

  // === 5. UNDERGROUND MAINTENANCE TUNNELS (ZONE 4: 'maintenance_tunnels' — North Vaulted Gallery) ===
  // Covered vaulted concrete bunker-tunnel along north perimeter (z in [-24.5, -16.8], x in [-10, 14])
  addSolidBox(2.0, 3.6, -20.6, 24.4, 0.35, 7.6, matTunnelConc, 'concrete'); // Tunnel ceiling deck
  addSolidBox(2.0, 1.8, -16.8, 17.6, 3.6, 0.55, matTunnelConc, 'concrete'); // South tunnel face (entries at x=-8.4 & x=12.4)
  // Overhead industrial steam pipes & ribbed concrete arches
  const pipeGeo = trackGeo(new THREE.CylinderGeometry(0.16, 0.16, 23.0, 10));
  for (const py of [3.1, 2.72]) {
    const pipe = new THREE.Mesh(pipeGeo, matSteelRail);
    pipe.rotation.z = Math.PI * 0.5;
    pipe.position.set(2.0, py, -23.6);
    sceneGroup.add(pipe);
  }
  for (let ax = -8; ax <= 12; ax += 4) {
    addVisualBox(ax, 1.75, -24.1, 0.45, 3.5, 0.45, matSteelDark, sceneGroup, 'metal');
    addVisualBox(ax, 3.3, -20.6, 0.42, 0.32, 7.2, matSteelDark, sceneGroup, 'metal');
  }

  // === 6. ELEVATED SIGNAL HOUSE (ZONE 5: 'signal_house' — Northeast Overlook) ===
  const SIG_Y = 2.6;
  // Concrete platform & railing (x in [15.5, 24.4], z in [-24.4, -15.5])
  addSolidBox(20.0, SIG_Y - 0.15, -20.0, 8.8, 0.3, 8.8, matTunnelConc, 'concrete');
  addSolidBox(20.0, SIG_Y + 0.55, -15.65, 8.8, 1.1, 0.25, matSteelDark, 'metal');
  addSolidBox(15.65, SIG_Y + 0.55, -21.8, 0.25, 1.1, 5.2, matSteelDark, 'metal');
  // Walkable ramp ascending from Freight Yard (z = -12.0 -> -15.6, x = 14.0 -> 15.6)
  physics.addRamp({
    minX: 13.2,
    maxX: 16.0,
    minZ: -19.2,
    maxZ: -14.2,
    baseY: 0.04,
    topY: SIG_Y,
    riseAxis: '+z',
    surface: 'metal',
  });
  const sigRampMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.6, 0.22, 5.6)), matSteelDark);
  sigRampMesh.position.set(14.6, SIG_Y * 0.5, -16.7);
  sigRampMesh.rotation.x = Math.atan2(SIG_Y, 5.0);
  sigRampMesh.receiveShadow = !isSoftwareGl;
  sceneGroup.add(sigRampMesh);
  raycastMeshes.push(sigRampMesh);

  // Mechanical railway switching lever frame inside Signal House
  const leverRack = new THREE.Group();
  leverRack.position.set(22.2, SIG_Y, -22.2);
  sceneGroup.add(leverRack);
  leverRack.add(new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.6, 0.9, 3.2)), matSteelDark));
  for (let i = 0; i < 6; i++) {
    const lv = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 1.05, 0.06)), i % 2 === 0 ? matBrass : matSteelRail);
    lv.position.set(-0.25, 0.72, -1.2 + i * 0.48);
    lv.rotation.z = i % 3 === 0 ? 0.32 : -0.28;
    leverRack.add(lv);
  }

  // === 7. BARRICADED ZOMBIE WINDOWS (6 REPAIRABLE BARRIERS ACROSS ZONES) ===
  const plankAnimItems: Array<{
    group: THREE.Group;
    restPos: THREE.Vector3;
    restRot: THREE.Euler;
    outwardDir: THREE.Vector3;
    state: 'attached' | 'tearing' | 'removed' | 'repairing';
    animT: number;
  }> = [];

  const addBarricadedWindow = (cfg: {
    id: string;
    zoneId: string;
    label: string;
    axis: 'x' | 'z';
    wallCoord: number;
    alongCoord: number;
    normalSign: 1 | -1;
    entryNodeId: string;
  }): void => {
    const maxPlanks = 5;
    let planksRemaining = maxPlanks;
    const isWallZ = cfg.axis === 'z';
    const nx = isWallZ ? 0 : cfg.normalSign;
    const nz = isWallZ ? cfg.normalSign : 0;
    const wx = isWallZ ? cfg.alongCoord : cfg.wallCoord;
    const wz = isWallZ ? cfg.wallCoord : cfg.alongCoord;

    const spawnPos: [number, number, number] = [wx - nx * 3.4, 0.04, wz - nz * 3.4];
    const windowOuterPos: [number, number, number] = [wx - nx * 1.05, 0.04, wz - nz * 1.05];
    const sillPos: [number, number, number] = [wx, 0.96, wz];
    const entryPos: [number, number, number] = [wx + nx * 1.45, 0.04, wz + nz * 1.45];
    const interactPos: [number, number, number] = [wx + nx * 1.05, 1.35, wz + nz * 1.05];

    // Dark recessed spawn alcove behind window
    const alcoveX = wx - nx * 2.1;
    const alcoveZ = wz - nz * 2.1;
    addVisualBox(alcoveX, 2.2, alcoveZ, isWallZ ? 3.8 : 4.2, 4.4, isWallZ ? 4.2 : 3.8, matTunnelConc);

    // 5 Repairable timber planks across the window opening
    const windowPlanks: typeof plankAnimItems = [];
    for (let p = 0; p < maxPlanks; p++) {
      const pg = new THREE.Group();
      const py = 1.15 + p * 0.34;
      const tilt = (p % 2 === 0 ? 1 : -1) * (0.04 + (p % 3) * 0.025);
      const restPos = new THREE.Vector3(wx + nx * 0.14, py, wz + nz * 0.14);
      const restRot = new THREE.Euler(0, isWallZ ? 0 : Math.PI * 0.5, tilt);
      pg.position.copy(restPos);
      pg.rotation.copy(restRot);
      const plankMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 0.22, 0.09)), matTimber);
      plankMesh.userData.surfaceMaterial = 'wood';
      pg.add(plankMesh);
      sceneGroup.add(pg);
      const item = {
        group: pg,
        restPos,
        restRot,
        outwardDir: new THREE.Vector3(-nx, 0, -nz),
        state: 'attached' as 'attached' | 'tearing' | 'removed' | 'repairing',
        animT: 0,
      };
      plankAnimItems.push(item);
      windowPlanks.push(item);
    }

    const barrier: MapWindowBarrier = {
      id: `barrier_${cfg.id}`,
      spawnerId: cfg.id,
      zoneId: cfg.zoneId,
      label: cfg.label,
      interactPos,
      sillPos,
      windowOuterPos,
      entryPos,
      windowNormal: [nx, 0, nz],
      maxPlanks,
      getPlanksRemaining: () => planksRemaining,
      tearPlank: () => {
        if (planksRemaining <= 0) return false;
        planksRemaining--;
        const item = windowPlanks[planksRemaining];
        if (item) {
          item.state = 'tearing';
          item.animT = 0;
        }
        return true;
      },
      repairPlank: () => {
        if (planksRemaining >= maxPlanks) return false;
        const item = windowPlanks[planksRemaining];
        planksRemaining++;
        if (item) {
          item.group.visible = true;
          item.state = 'repairing';
          item.animT = 0;
        }
        return true;
      },
      setPlankCount: (count: number) => {
        const clamped = Math.max(0, Math.min(maxPlanks, Math.round(count)));
        planksRemaining = clamped;
        for (let i = 0; i < maxPlanks; i++) {
          const item = windowPlanks[i];
          if (i < clamped) {
            item.state = 'attached';
            item.group.visible = true;
            item.group.position.copy(item.restPos);
            item.group.rotation.copy(item.restRot);
          } else {
            item.state = 'removed';
            item.group.visible = false;
          }
        }
      },
    };
    windowBarriers.push(barrier);

    zombieSpawners.push({
      id: cfg.id,
      zoneId: cfg.zoneId,
      spawnPos,
      windowOuterPos,
      sillPos,
      entryPos,
      windowNormal: [nx, 0, nz],
      maxPlanks,
      entryNodeId: cfg.entryNodeId,
      yaw: Math.atan2(nx, nz),
    });

    interactables.push({
      id: barrier.id,
      kind: 'window_barrier',
      label: `Repair ${cfg.label}`,
      cost: 0,
      position: interactPos,
      radiusM: 2.6,
      barrierId: barrier.id,
      activated: false,
    });
  };

  addBarricadedWindow({ id: 'sp_ticket_sw', zoneId: 'lobby', label: 'South-West Ticket Window', axis: 'z', wallCoord: 23.8, alongCoord: -5.6, normalSign: -1, entryNodeId: 'th_sw' });
  addBarricadedWindow({ id: 'sp_ticket_se', zoneId: 'lobby', label: 'South-East Ticket Window', axis: 'z', wallCoord: 23.8, alongCoord: 5.6, normalSign: -1, entryNodeId: 'th_se' });
  addBarricadedWindow({ id: 'sp_shed_s', zoneId: 'locomotive_shed', label: 'Locomotive Shed South Bay', axis: 'x', wallCoord: -25.0, alongCoord: 4.0, normalSign: 1, entryNodeId: 'shed_s' });
  addBarricadedWindow({ id: 'sp_shed_n', zoneId: 'locomotive_shed', label: 'Locomotive Shed North Bay', axis: 'x', wallCoord: -25.0, alongCoord: -10.0, normalSign: 1, entryNodeId: 'shed_n' });
  addBarricadedWindow({ id: 'sp_yard_s', zoneId: 'freight_yard', label: 'Freight Yard East Gate', axis: 'x', wallCoord: 25.0, alongCoord: 6.0, normalSign: -1, entryNodeId: 'yard_e_s' });
  addBarricadedWindow({ id: 'sp_yard_n', zoneId: 'freight_yard', label: 'Freight Yard North Breach', axis: 'x', wallCoord: 25.0, alongCoord: -12.0, normalSign: -1, entryNodeId: 'yard_e_n' });

  // === 8. BUYABLE DOORS / DEBRIS BARRICADES ===
  const addBuyableDoor = (
    id: string,
    label: string,
    cost: number,
    unlocksZoneId: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
  ): void => {
    const visualGroup = new THREE.Group();
    sceneGroup.add(visualGroup);
    const bar = addSolidBox(x, y + h * 0.5, z, w, h, d, matTimber, 'wood', `col_${id}`, visualGroup);
    bar.userData.interactableId = id;
    const alongZ = d > w;
    const signTex = trackTex(createStencilSignTexture(label, `${cost} PTS · [F] CLEAR`, '#f5c06b', '#141e28', maxAniso));
    const plaque = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.75, 0.65)),
      trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    );
    plaque.position.set(x + (alongZ ? 0.36 : 0), y + 1.5, z + (alongZ ? 0 : 0.36));
    if (alongZ) plaque.rotation.y = Math.PI * 0.5;
    visualGroup.add(plaque);

    interactables.push({
      id,
      kind: 'buyable_door',
      label,
      cost,
      position: [x, y + 1.2, z],
      radiusM: 2.9,
      colliderIds: [`col_${id}`],
      unlocksZoneId,
      visualGroup,
      activated: false,
    });
  };

  addBuyableDoor('door_loco_shed', 'Locomotive Shed', 750, 'locomotive_shed', -10.0, 0, 13.0, 0.52, 3.1, 3.2);
  addBuyableDoor('door_freight_yard', 'Frozen Freight Yard', 750, 'freight_yard', 10.0, 0, 13.0, 0.52, 3.1, 3.2);
  addBuyableDoor('door_tunnels_west', 'Maintenance Tunnels', 1000, 'maintenance_tunnels', -10.0, 0, -14.0, 0.52, 3.1, 3.2);
  addBuyableDoor('door_signal_house', 'Signal Tower', 1250, 'signal_house', 14.6, 0.04, -14.0, 2.8, 2.9, 0.52);

  // === 9. POWER SWITCH, WALL-BUYS, MYSTERY CRATE & PERK MACHINES ===
  const powerLampMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 2.2, roughness: 0.25 }));
  const powerLever = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.55, 0.12)), matBrass);
  const powerGroup = new THREE.Group();
  powerGroup.position.set(23.8, SIG_Y + 1.65, -20.0);
  const powerBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.28, 1.15, 0.8)), matSteelDark);
  const powerLamp = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.11, 12, 12)), powerLampMat);
  powerLamp.position.set(-0.16, 0.36, 0);
  powerLever.position.set(-0.2, -0.05, 0);
  powerLever.rotation.z = 0.55;
  powerGroup.add(powerBox, powerLamp, powerLever);
  sceneGroup.add(powerGroup);
  const powerGlow = new THREE.PointLight(0xf59e0b, 3.4, 7.5, 2);
  powerGlow.position.set(23.0, SIG_Y + 2.0, -20.0);
  sceneGroup.add(powerGlow);

  interactables.push({
    id: 'power_switch',
    kind: 'power_switch',
    label: 'Restore Depot Power Grid',
    cost: 0,
    position: [23.0, SIG_Y + 1.2, -20.0],
    radiusM: 2.8,
    visualGroup: powerGroup,
    activated: false,
  });

  // Mystery Weapon Crate in Freight Yard beside boxcar
  const crateGroup = new THREE.Group();
  crateGroup.position.set(11.4, 0.0, -14.2);
  addSolidBox(11.4, 0.42, -14.2, 2.2, 0.84, 0.92, matTimber, 'wood');
  const crateTrimMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xf5c869, emissive: 0xd99b26, emissiveIntensity: 1.5, roughness: 0.32 }));
  const crateTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.26, 0.1, 0.96)), crateTrimMat);
  crateTrim.position.set(0, 0.82, 0);
  crateGroup.add(crateTrim);
  sceneGroup.add(crateGroup);
  const crateLight = new THREE.PointLight(0xf5b942, 4.4, 8.5, 1.8);
  crateLight.position.set(11.4, 1.7, -14.2);
  sceneGroup.add(crateLight);

  interactables.push({
    id: 'mystery_crate',
    kind: 'mystery_crate',
    label: 'Mystery Weapon Crate',
    cost: 950,
    position: [11.4, 0.9, -14.2],
    radiusM: 2.8,
    visualGroup: crateGroup,
    activated: false,
  });

  // Wall-Buy Chalk Stencils
  const addWallBuy = (
    id: string,
    weaponId: string,
    title: string,
    cost: number,
    x: number,
    y: number,
    z: number,
    ry: number,
  ): void => {
    const tex = trackTex(createWallBuyTexture(title, cost, maxAniso));
    const mesh = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.75, 0.85)),
      trackMat(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    sceneGroup.add(mesh);
    interactables.push({
      id,
      kind: 'wall_buy',
      label: title,
      cost,
      weaponId,
      position: [x, y, z],
      radiusM: 2.6,
      activated: false,
    });
  };

  addWallBuy('wb_mp5', 'hk_mp5', 'HK MP5', 750, -5.0, 1.65, 8.35, 0);
  addWallBuy('wb_m870', 'remington_870', 'M870 SHOTGUN', 900, 5.0, 1.65, 8.35, 0);
  addWallBuy('wb_akm', 'akm_762', 'AKM 7.62', 1200, -10.35, 1.65, -2.0, -Math.PI * 0.5);
  addWallBuy('wb_m4a1', 'm4a1', 'M4A1 CARBINE', 1350, -9.65, 1.65, -2.0, Math.PI * 0.5);
  addWallBuy('wb_scar', 'scar_h', 'SCAR-H 7.62', 1750, 20.0, SIG_Y + 1.5, -24.55, 0);

  // Power-Gated Perk Machines
  const perkEmissiveMats: Array<{ mat: THREE.MeshStandardMaterial; light: THREE.PointLight }> = [];
  const addPerkMachine = (
    id: string,
    perkId: 'vitality' | 'rapid_handling',
    label: string,
    cost: number,
    colorHex: number,
    x: number,
    y: number,
    z: number,
    ry: number,
  ): void => {
    const bodyMat = trackMat(new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.44, metalness: 0.45 }));
    const glowMat = trackMat(new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.1, roughness: 0.2 }));
    const pg = new THREE.Group();
    pg.position.set(x, y, z);
    pg.rotation.y = ry;
    const cabinet = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.05, 2.25, 0.85)), bodyMat);
    cabinet.position.y = 1.125;
    const marquee = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.92, 0.42, 0.08)), glowMat);
    marquee.position.set(0, 1.92, 0.44);
    pg.add(cabinet, marquee);
    sceneGroup.add(pg);
    physics.addBox({
      minX: x - 0.55,
      maxX: x + 0.55,
      minY: y,
      maxY: y + 2.25,
      minZ: z - 0.45,
      maxZ: z + 0.45,
      surface: 'metal',
      blocksMovement: true,
    });
    const pl = new THREE.PointLight(colorHex, 0.0, 6.5, 2);
    pl.position.set(x, y + 2.0, z + (Math.cos(ry) * 0.8));
    sceneGroup.add(pl);
    perkEmissiveMats.push({ mat: glowMat, light: pl });
    interactables.push({
      id,
      kind: 'perk_machine',
      label,
      cost,
      perkId,
      requiresPower: true,
      position: [x, y + 1.2, z],
      radiusM: 2.7,
      visualGroup: pg,
      activated: false,
    });
  };

  addPerkMachine('perk_vitality', 'vitality', 'Vitality Tonic (+100 Max HP)', 2000, 0xdc2626, -23.8, 0.04, -18.5, Math.PI * 0.5);
  addPerkMachine('perk_rapid', 'rapid_handling', 'Rapid Handling (Fast Reload)', 1750, 0x10b981, -4.0, 0.04, -23.8, 0);

  // === 10. LIGHTING (AMBIENT EMERGENCY + POWER-RESTORED DEPOT FLOODLIGHTS) ===
  const ticketLamp = new THREE.PointLight(0xffb454, 4.6, 18, 1.6);
  ticketLamp.position.set(0, 4.6, 15.0);
  sceneGroup.add(ticketLamp);
  const ticketBulb = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.2, 10, 10)), matAmberBulb);
  ticketBulb.position.set(0, 4.9, 15.0);
  sceneGroup.add(ticketBulb);

  const tunnelLamp = new THREE.PointLight(0xf59e0b, 3.8, 16, 1.6);
  tunnelLamp.position.set(1.5, 3.0, -20.6);
  sceneGroup.add(tunnelLamp);

  const powerLights: Array<{ light: THREE.PointLight; targetIntensity: number }> = [];
  const floodPositions: Array<[number, number, number, number]> = [
    [-17.5, 5.1, -6.0, 7.5],
    [-17.5, 5.1, 6.0, 6.5],
    [6.5, 5.4, -4.0, 8.2],
    [16.5, 5.4, 4.0, 7.5],
    [19.5, SIG_Y + 2.6, -19.5, 6.0],
  ];
  for (const [lx, ly, lz, inten] of floodPositions) {
    const fl = new THREE.PointLight(0xcbe6ff, 0, 26, 1.45);
    fl.position.set(lx, ly, lz);
    sceneGroup.add(fl);
    powerLights.push({ light: fl, targetIntensity: inten });
    const fixture = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.8, 0.16, 0.32)), matFloodBulb);
    fixture.position.set(lx, ly + 0.18, lz);
    sceneGroup.add(fixture);
  }

  let powerOn = false;
  let powerBlend = 0;

  const setPowerState = (powered: boolean): void => {
    powerOn = powered;
    powerLever.rotation.z = powered ? -0.55 : 0.55;
    powerLampMat.color.setHex(powered ? 0x10b981 : 0xf59e0b);
    powerLampMat.emissive.setHex(powered ? 0x10b981 : 0xf59e0b);
    powerGlow.color.setHex(powered ? 0x10b981 : 0xf59e0b);
    matFloodBulb.emissiveIntensity = powered ? 2.2 : 0.2;
    locoLampMat.emissiveIntensity = powered ? 2.8 : 0.2;
    for (const pm of perkEmissiveMats) {
      pm.mat.emissiveIntensity = powered ? 2.2 : 0.08;
      pm.light.intensity = powered ? 5.2 : 0.0;
    }
  };

  // === 11. ZONE-GATED BIDIRECTIONAL NAVGRAPH ===
  const rawNodes: NavNode[] = [
    // Zone 1: Ticket Hall ('lobby')
    { id: 'th_c', position: [0, 0.04, 12.2], zoneId: 'lobby', neighbors: ['th_w', 'th_e', 'th_sw_mid', 'th_se_mid'] },
    { id: 'th_w', position: [-7.5, 0.04, 13.0], zoneId: 'lobby', neighbors: ['th_c', 'th_sw_mid', 'shed_entry'] },
    { id: 'th_e', position: [7.5, 0.04, 13.0], zoneId: 'lobby', neighbors: ['th_c', 'th_se_mid', 'yard_entry'] },
    { id: 'th_sw_mid', position: [-5.2, 0.04, 16.5], zoneId: 'lobby', neighbors: ['th_c', 'th_w', 'th_sw'], isCover: true, coverNormal: [1, 0] },
    { id: 'th_se_mid', position: [5.2, 0.04, 16.5], zoneId: 'lobby', neighbors: ['th_c', 'th_e', 'th_se'], isCover: true, coverNormal: [-1, 0] },
    { id: 'th_sw', position: [-5.6, 0.04, 21.6], zoneId: 'lobby', neighbors: ['th_sw_mid', 'th_s_mid'] },
    { id: 'th_s_mid', position: [0, 0.04, 21.4], zoneId: 'lobby', neighbors: ['th_sw', 'th_se'] },
    { id: 'th_se', position: [5.6, 0.04, 21.6], zoneId: 'lobby', neighbors: ['th_se_mid', 'th_s_mid'] },

    // Zone 2: Locomotive Shed ('locomotive_shed')
    { id: 'shed_entry', position: [-13.2, 0.04, 13.0], zoneId: 'locomotive_shed', requiredDoorId: 'door_loco_shed', neighbors: ['th_w', 'shed_s', 'shed_e_mid'] },
    { id: 'shed_s', position: [-22.4, 0.04, 4.0], zoneId: 'locomotive_shed', neighbors: ['shed_entry', 'shed_w_mid'] },
    { id: 'shed_w_mid', position: [-22.0, 0.04, -3.5], zoneId: 'locomotive_shed', neighbors: ['shed_s', 'shed_n'] },
    { id: 'shed_n', position: [-22.4, 0.04, -10.5], zoneId: 'locomotive_shed', neighbors: ['shed_w_mid', 'shed_nw'] },
    { id: 'shed_nw', position: [-20.5, 0.04, -17.5], zoneId: 'locomotive_shed', neighbors: ['shed_n', 'shed_ne'] },
    { id: 'shed_e_mid', position: [-13.2, 0.04, -3.5], zoneId: 'locomotive_shed', neighbors: ['shed_entry', 'shed_ne'] },
    { id: 'shed_ne', position: [-13.2, 0.04, -14.0], zoneId: 'locomotive_shed', neighbors: ['shed_e_mid', 'shed_nw', 'tun_w'] },

    // Zone 3: Frozen Freight Yard ('freight_yard')
    { id: 'yard_entry', position: [12.8, 0.04, 13.0], zoneId: 'freight_yard', requiredDoorId: 'door_freight_yard', neighbors: ['th_e', 'yard_e_s', 'yard_mid_s'] },
    { id: 'yard_mid_s', position: [9.5, 0.04, 5.0], zoneId: 'freight_yard', neighbors: ['yard_entry', 'yard_e_s', 'yard_c'] },
    { id: 'yard_e_s', position: [22.2, 0.04, 6.0], zoneId: 'freight_yard', neighbors: ['yard_entry', 'yard_mid_s', 'yard_e_mid'] },
    { id: 'yard_c', position: [9.8, 0.04, -4.5], zoneId: 'freight_yard', neighbors: ['yard_mid_s', 'yard_nw', 'yard_ne', 'yard_e_mid'] },
    { id: 'yard_nw', position: [-3.5, 0.04, -10.5], zoneId: 'freight_yard', neighbors: ['yard_c', 'tun_w'] },
    { id: 'yard_e_mid', position: [21.8, 0.04, -4.5], zoneId: 'freight_yard', neighbors: ['yard_e_s', 'yard_c', 'yard_e_n'] },
    { id: 'yard_e_n', position: [22.2, 0.04, -12.0], zoneId: 'freight_yard', neighbors: ['yard_e_mid', 'yard_ne'] },
    { id: 'yard_ne', position: [12.5, 0.04, -12.5], zoneId: 'freight_yard', neighbors: ['yard_c', 'yard_e_n', 'tun_e', 'sig_ramp'] },

    // Zone 4: Underground Maintenance Tunnels ('maintenance_tunnels')
    { id: 'tun_w', position: [-7.5, 0.04, -14.0], zoneId: 'maintenance_tunnels', requiredDoorId: 'door_tunnels_west', neighbors: ['shed_ne', 'yard_nw', 'tun_nw'] },
    { id: 'tun_nw', position: [-7.2, 0.04, -20.6], zoneId: 'maintenance_tunnels', neighbors: ['tun_w', 'tun_c'] },
    { id: 'tun_c', position: [2.0, 0.04, -20.6], zoneId: 'maintenance_tunnels', neighbors: ['tun_nw', 'tun_e'] },
    { id: 'tun_e', position: [12.2, 0.04, -20.6], zoneId: 'maintenance_tunnels', neighbors: ['tun_c', 'yard_ne'] },

    // Zone 5: Signal Tower ('signal_house')
    { id: 'sig_ramp', position: [14.6, SIG_Y * 0.55, -16.8], zoneId: 'signal_house', requiredDoorId: 'door_signal_house', neighbors: ['yard_ne', 'sig_top'] },
    { id: 'sig_top', position: [19.8, SIG_Y + 0.04, -19.8], zoneId: 'signal_house', neighbors: ['sig_ramp'] },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'stalingrad_depot',
    name: 'Stalingrad Rail Depot',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA: [
        { position: [0, 0.04, 12.2], yaw: Math.PI },
        { position: [-3.2, 0.04, 12.2], yaw: Math.PI },
        { position: [3.2, 0.04, 12.2], yaw: Math.PI },
        { position: [-5.5, 0.04, 19.2], yaw: 0 },
      ],
      teamB: [{ position: [19.8, SIG_Y + 0.04, -19.8], yaw: 0 }],
      ffa: [{ position: [0, 0.04, 12.2], yaw: Math.PI }],
      playerStart: { position: [0, 0.04, 12.2], yaw: Math.PI, zoneId: 'lobby' },
      zombieSpawners,
    },
    windowBarriers,
    interactables,
    lightingPreset: LIGHTING_PRESET,
    setPowerState,
    update: (dt, elapsedSec) => {
      powerBlend = THREE.MathUtils.damp(powerBlend, powerOn ? 1 : 0, 3.0, dt);
      for (const pl of powerLights) {
        pl.light.intensity = pl.targetIntensity * powerBlend;
      }
      ticketLamp.intensity = 4.5 + Math.sin(elapsedSec * 7.8) * 0.35;
      crateLight.intensity = 4.0 + Math.sin(elapsedSec * 3.1) * 0.8;

      for (let i = 0; i < plankAnimItems.length; i++) {
        const it = plankAnimItems[i];
        if (it.state === 'tearing') {
          it.animT = Math.min(1, it.animT + dt / 0.36);
          const ease = it.animT * it.animT;
          it.group.position.copy(it.restPos);
          it.group.position.addScaledVector(it.outwardDir, ease * 0.85);
          it.group.position.y -= ease * 0.9;
          it.group.rotation.set(it.restRot.x + ease * 0.7, it.restRot.y + ease * 0.3, it.restRot.z + ease * 0.45);
          if (it.animT >= 1) {
            it.state = 'removed';
            it.group.visible = false;
          }
        } else if (it.state === 'repairing') {
          it.animT = Math.min(1, it.animT + dt / 0.24);
          const inv = 1 - it.animT;
          const easeInv = inv * inv;
          it.group.position.copy(it.restPos);
          it.group.position.addScaledVector(it.outwardDir, -easeInv * 0.45);
          it.group.position.y -= easeInv * 0.2;
          it.group.rotation.set(it.restRot.x - easeInv * 0.22, it.restRot.y, it.restRot.z + easeInv * 0.14);
          if (it.animT >= 1) {
            it.state = 'attached';
            it.group.position.copy(it.restPos);
            it.group.rotation.copy(it.restRot);
          }
        }
      }
    },
    dispose: () => {
      scene.remove(sceneGroup);
      envTex.dispose();
      ownedGeos.forEach((g) => g.dispose());
      ownedMats.forEach((m) => m.dispose());
      ownedTextures.forEach((t) => t.dispose());
      physics.clear();
    },
  };
}

export const STALINGRAD_DEPOT_MAP: IMapDefinition = {
  id: 'stalingrad_depot',
  name: 'Stalingrad Rail Depot',
  subtitle: 'Frozen Freight Yard & Locomotive Shed',
  description:
    'Frozen Soviet freight yard, bombed-out armored locomotive shed, subterranean maintenance tunnels, and elevated rail signal tower.',
  mode: 'infection',
  status: 'playable',
  environmentTags: ['Frozen Freight Yard', '5 Unlockable Zones', 'Maintenance Tunnels'],
  accentHex: '#38bdf8',
  previewStyle: 'stalingrad_depot',
  build: buildStalingradDepot,
};

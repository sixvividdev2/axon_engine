import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import { createWallBuyTexture } from './MapTextures';
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

// Subterranean Cold War Bio-Containment Complex: Deep industrial slate with emerald coolant & emergency strobes
const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x060b0e,
  fogHex: 0x081014,
  fogDensity: 0.023,
  envIntensity: 0.30,
  hemiSkyHex: 0x4b6e78,
  hemiGroundHex: 0x111a1c,
  hemiIntensity: 0.44,
  keyLightHex: 0x8cc6d4,
  keyLightIntensity: 0.62,
  keyLightPos: [16, 28, 12],
};

function createBunkerConcreteTexture(aniso: number, repeatX: number, repeatY: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2d363a';
  g.fillRect(0, 0, 256, 256);
  // Cast bunker panels + bolt dimples + hazard yellow stripe trim
  g.strokeStyle = 'rgba(15, 20, 23, 0.72)';
  g.lineWidth = 3;
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
  for (let i = 0; i < 320; i++) {
    const x = (i * 89) % 256;
    const y = (i * 151) % 256;
    g.fillStyle = i % 2 === 0 ? 'rgba(18, 25, 28, 0.25)' : 'rgba(98, 118, 122, 0.14)';
    g.fillRect(x, y, 4, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = aniso;
  return tex;
}

function createHazardStripeTexture(aniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c8961e';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#181c20';
  for (let x = -64; x < 320; x += 48) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 24, 0);
    g.lineTo(x + 48, 64);
    g.lineTo(x + 24, 64);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  tex.anisotropy = aniso;
  return tex;
}

function buildBunkerObjekt47(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -24.5;
  physics.boundsMaxX = 24.5;
  physics.boundsMinZ = -24.5;
  physics.boundsMaxZ = 22.5;

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

  const keyLight = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  keyLight.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl && qProfile.castShadows) {
    keyLight.castShadow = true;
    const sm = Math.min(2048, qProfile.shadowMapSize);
    keyLight.shadow.mapSize.set(sm, sm);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 85;
    keyLight.shadow.camera.left = -28;
    keyLight.shadow.camera.right = 28;
    keyLight.shadow.camera.top = 28;
    keyLight.shadow.camera.bottom = -28;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.025;
  }
  sceneGroup.add(keyLight);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  const bunkerConcTex = trackTex(createBunkerConcreteTexture(maxAniso, 8, 8));
  const bunkerWallTex = trackTex(createBunkerConcreteTexture(maxAniso, 5, 2));
  const hazardTex = trackTex(createHazardStripeTexture(maxAniso));

  const matFloor = trackMat(new THREE.MeshStandardMaterial({ map: bunkerConcTex, roughness: 0.72, metalness: 0.14 }));
  const matWall = trackMat(new THREE.MeshStandardMaterial({ map: bunkerWallTex, roughness: 0.82, metalness: 0.10 }));
  const matCeiling = trackMat(new THREE.MeshStandardMaterial({ color: 0x161d21, roughness: 0.9, metalness: 0.16 }));
  const matBlastSteel = trackMat(new THREE.MeshStandardMaterial({ color: 0x2c363e, roughness: 0.42, metalness: 0.82 }));
  const matGrating = trackMat(new THREE.MeshStandardMaterial({ color: 0x3b4750, roughness: 0.48, metalness: 0.78 }));
  const matHazard = trackMat(new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.65, metalness: 0.12 }));
  const matLabSteel = trackMat(new THREE.MeshStandardMaterial({ color: 0x8ea0aa, roughness: 0.28, metalness: 0.88 }));
  const matGlassPod = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6ee7b7,
      roughness: 0.15,
      metalness: 0.2,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    }),
  );
  const matBioFluid = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x059669,
      emissiveIntensity: 1.65,
      roughness: 0.2,
      metalness: 0.1,
    }),
  );
  const matCoolantWater = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0e6b6b,
      emissive: 0x0d9488,
      emissiveIntensity: 0.65,
      roughness: 0.16,
      metalness: 0.35,
      transparent: true,
      opacity: 0.86,
    }),
  );
  const matEmergencyRed = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff6b5a,
      emissive: 0xdc2626,
      emissiveIntensity: 2.1,
      roughness: 0.25,
    }),
  );
  const matClinicalLight = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe6f8ff,
      emissive: 0x67e8f9,
      emissiveIntensity: 0.18,
      roughness: 0.2,
    }),
  );
  const matBarricadeSteel = trackMat(new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.52, metalness: 0.76 }));

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

  // === 1. SUBTERRANEAN FLOOR, CEILING & REINFORCED OUTER SHELL ===
  const WALL_H = 5.4;
  const floorMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(54, 52)), matFloor);
  floorMesh.rotation.x = -Math.PI * 0.5;
  floorMesh.position.y = 0;
  floorMesh.receiveShadow = !isSoftwareGl;
  floorMesh.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(floorMesh);
  raycastMeshes.push(floorMesh);

  // Heavy ribbed bunker ceiling enclosing the underground facility
  const ceilingMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(54, 52)), matCeiling);
  ceilingMesh.rotation.x = Math.PI * 0.5;
  ceilingMesh.position.y = WALL_H;
  sceneGroup.add(ceilingMesh);
  for (let rz = -20; rz <= 18; rz += 6) {
    addVisualBox(0, WALL_H - 0.25, rz, 49.0, 0.45, 0.55, matBlastSteel, sceneGroup, 'metal');
  }

  // Outer perimeter walls with 6 recessed breach-vent window openings
  // South wall (z = 22.0) with 2 breach vents at x = -5.4 and x = 5.4
  addSolidBox(-16.0, WALL_H * 0.5, 22.0, 17.6, WALL_H, 0.7, matWall, 'concrete');
  addSolidBox(0, WALL_H * 0.5, 22.0, 7.2, WALL_H, 0.7, matWall, 'concrete');
  addSolidBox(16.0, WALL_H * 0.5, 22.0, 17.6, WALL_H, 0.7, matWall, 'concrete');
  for (const wx of [-5.4, 5.4]) {
    addSolidBox(wx, 0.48, 22.0, 3.6, 0.96, 0.7, matWall, 'concrete');
    addSolidBox(wx, 4.0, 22.0, 3.6, 2.8, 0.7, matWall, 'concrete');
  }
  // North wall (z = -24.0) with 2 breach vents at x = -11.0 and x = 11.0
  addSolidBox(-18.5, WALL_H * 0.5, -24.0, 12.0, WALL_H, 0.7, matWall, 'concrete');
  addSolidBox(0, WALL_H * 0.5, -24.0, 18.6, WALL_H, 0.7, matWall, 'concrete');
  addSolidBox(18.5, WALL_H * 0.5, -24.0, 12.0, WALL_H, 0.7, matWall, 'concrete');
  for (const wx of [-11.0, 11.0]) {
    addSolidBox(wx, 0.48, -24.0, 3.4, 0.96, 0.7, matWall, 'concrete');
    addSolidBox(wx, 4.0, -24.0, 3.4, 2.8, 0.7, matWall, 'concrete');
  }
  // West wall (x = -24.0) with Bio-Labs breach vent at z = 0
  addSolidBox(-24.0, WALL_H * 0.5, -13.0, 0.7, WALL_H, 22.4, matWall, 'concrete');
  addSolidBox(-24.0, WALL_H * 0.5, 12.0, 0.7, WALL_H, 20.6, matWall, 'concrete');
  addSolidBox(-24.0, 0.48, 0.0, 0.7, 0.96, 3.6, matWall, 'concrete');
  addSolidBox(-24.0, 4.0, 0.0, 0.7, 2.8, 3.6, matWall, 'concrete');
  // East wall (x = 24.0) with Containment Ring breach vent at z = 0
  addSolidBox(24.0, WALL_H * 0.5, -13.0, 0.7, WALL_H, 22.4, matWall, 'concrete');
  addSolidBox(24.0, WALL_H * 0.5, 12.0, 0.7, WALL_H, 20.6, matWall, 'concrete');
  addSolidBox(24.0, 0.48, 0.0, 0.7, 0.96, 3.6, matWall, 'concrete');
  addSolidBox(24.0, 4.0, 0.0, 0.7, 2.8, 3.6, matWall, 'concrete');

  // === 2. ZONE 1: DECONTAMINATION AIRLOCK ('lobby', x in [-10, 10], z in [8, 21.6]) ===
  addSolidBox(0, WALL_H * 0.5, 8.0, 20.0, WALL_H, 0.65, matWall, 'concrete');
  // West & East blast door bulkheads (gaps at z in [11.4, 14.6])
  for (const sx of [-10.0, 10.0]) {
    addSolidBox(sx, WALL_H * 0.5, 9.7, 0.65, WALL_H, 3.4, matWall, 'concrete');
    addSolidBox(sx, WALL_H * 0.5, 18.4, 0.65, WALL_H, 7.6, matWall, 'concrete');
    addSolidBox(sx, 4.3, 13.0, 0.65, 2.2, 3.2, matBlastSteel, 'metal');
    addVisualBox(sx, 3.22, 13.0, 0.72, 0.24, 3.4, matHazard, sceneGroup, 'metal');
  }
  // Decontamination shower arch & reception security island
  addSolidBox(0, 0.58, 15.2, 3.8, 1.16, 1.8, matBlastSteel, 'metal');
  addVisualBox(0, 1.18, 15.2, 3.9, 0.08, 1.9, matHazard, sceneGroup, 'metal');
  for (const ax of [-3.6, 3.6]) {
    addVisualBox(ax, 1.6, 11.4, 0.28, 3.2, 0.28, matLabSteel, sceneGroup, 'metal');
  }
  addVisualBox(0, 3.15, 11.4, 7.5, 0.26, 0.36, matLabSteel, sceneGroup, 'metal');

  // === 3. ZONE 2: BIO-CONTAINMENT LABS (West: x in [-23.6, -10.3], z in [-14, 16]) ===
  // Bulkhead separating Bio-Labs from Reactor Deck at x = -10.0 (doorway at z in [-9.6, -6.4])
  addSolidBox(-10.0, WALL_H * 0.5, 0.8, 0.65, WALL_H, 14.4, matWall, 'concrete');
  addSolidBox(-10.0, WALL_H * 0.5, -16.8, 0.65, WALL_H, 14.4, matWall, 'concrete');
  addSolidBox(-10.0, 4.3, -8.0, 0.65, 2.2, 3.2, matBlastSteel, 'metal');

  // 3 Composite Cylindrical Bio-Specimen Containment Pods (glowing emerald fluid + metal endcaps)
  const podFluids: THREE.Mesh[] = [];
  for (const pz of [-2.8, 1.6, 6.0]) {
    const pod = new THREE.Group();
    pod.position.set(-16.8, 0, pz);
    sceneGroup.add(pod);
    const baseCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.92, 1.02, 0.45, 16)), matBlastSteel);
    baseCap.position.y = 0.225;
    const topCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.95, 0.92, 0.42, 16)), matBlastSteel);
    topCap.position.y = 3.05;
    const fluid = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.68, 0.68, 2.45, 14)), matBioFluid);
    fluid.position.y = 1.65;
    podFluids.push(fluid);
    const glassTube = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.84, 0.84, 2.55, 16)), matGlassPod);
    glassTube.position.y = 1.65;
    glassTube.renderOrder = 2;
    pod.add(baseCap, topCap, fluid, glassTube);
    physics.addBox({
      minX: -17.75,
      maxX: -15.85,
      minY: 0,
      maxY: 3.3,
      minZ: pz - 0.95,
      maxZ: pz + 0.95,
      surface: 'metal',
      blocksMovement: true,
    });
  }
  // Stainless steel lab consoles along west wall
  addSolidBox(-22.2, 0.5, -6.5, 1.6, 1.0, 4.2, matLabSteel, 'metal');
  addSolidBox(-22.2, 0.5, 6.8, 1.6, 1.0, 4.0, matLabSteel, 'metal');

  // === 4. ZONE 3: CONTAINMENT RING GALLERY (East: x in [10.3, 23.6], z in [-14, 16]) ===
  addSolidBox(10.0, WALL_H * 0.5, 0.8, 0.65, WALL_H, 14.4, matWall, 'concrete');
  addSolidBox(10.0, WALL_H * 0.5, -16.8, 0.65, WALL_H, 14.4, matWall, 'concrete');
  addSolidBox(10.0, 4.3, -8.0, 0.65, 2.2, 3.2, matBlastSteel, 'metal');

  // Cryogenic canister racks & hazmat cover islands
  for (const cz of [-2.5, 4.5]) {
    addSolidBox(16.8, 0.78, cz, 2.2, 1.56, 1.4, matBlastSteel, 'metal');
    for (const cxOff of [-0.55, 0.55]) {
      const tank = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.24, 0.24, 1.5, 10)), matLabSteel);
      tank.position.set(16.8 + cxOff, 1.9, cz);
      sceneGroup.add(tank);
    }
  }

  // === 5. ZONE 4: FLOODED REACTOR DECK (Center: x in [-9.6, 9.6], z in [-23.5, 7.6]) ===
  // Shimmering flooded coolant surface at y = 0.05 (shallow ankle-deep pool beneath raised grating walkways)
  const coolantPlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(19.0, 30.8)), matCoolantWater);
  coolantPlane.rotation.x = -Math.PI * 0.5;
  coolantPlane.position.set(0, 0.05, -8.0);
  sceneGroup.add(coolantPlane);

  // Raised steel grating catwalks (y = 0.14) looping cleanly around the central Reactor Core
  addSolidBox(-6.6, 0.07, -8.0, 4.4, 0.14, 28.0, matGrating, 'metal');
  addSolidBox(6.6, 0.07, -8.0, 4.4, 0.14, 28.0, matGrating, 'metal');
  addSolidBox(0, 0.07, 3.8, 12.0, 0.14, 4.4, matGrating, 'metal');
  addSolidBox(0, 0.07, -18.5, 12.0, 0.14, 4.4, matGrating, 'metal');

  // Central Composite RBMK Bio-Reactor Containment Core (x = 0, z = -7.8)
  const coreGroup = new THREE.Group();
  coreGroup.position.set(0, 0, -7.8);
  sceneGroup.add(coreGroup);
  const corePedestal = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(3.4, 3.8, 0.9, 16)), matBlastSteel);
  corePedestal.position.y = 0.45;
  const coreFuelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x10b981,
      emissiveIntensity: 0.55,
      roughness: 0.18,
      metalness: 0.2,
    }),
  );
  const coreGlowColumn = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(1.75, 1.75, 3.8, 18)), coreFuelMat);
  coreGlowColumn.position.y = 2.6;
  const coreCageGlass = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(2.35, 2.35, 3.85, 18)), matGlassPod);
  coreCageGlass.position.y = 2.6;
  coreCageGlass.renderOrder = 3;
  const coreCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(3.5, 3.1, 0.9, 16)), matBlastSteel);
  coreCap.position.y = 4.9;
  coreGroup.add(corePedestal, coreGlowColumn, coreCageGlass, coreCap);
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2;
    const pipe = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.18, 0.18, 4.6, 10)), matLabSteel);
    pipe.position.set(Math.cos(ang) * 2.75, 2.6, Math.sin(ang) * 2.75);
    coreGroup.add(pipe);
  }
  physics.addBox({
    minX: -3.3,
    maxX: 3.3,
    minY: 0,
    maxY: 5.4,
    minZ: -11.1,
    maxZ: -4.5,
    surface: 'metal',
    blocksMovement: true,
  });

  // === 6. ZONE 5: ELEVATED CONTROL BUNKER (North Overlook: x in [-9, 9], z in [-23.6, -19.2]) ===
  const CTRL_Y = 2.35;
  addSolidBox(0, CTRL_Y - 0.15, -21.4, 14.0, 0.3, 4.4, matBlastSteel, 'metal');
  addSolidBox(0, CTRL_Y + 0.55, -19.25, 14.0, 1.1, 0.24, matHazard, 'metal');
  // Walkable ascent ramp on the west side of Control Bunker
  physics.addRamp({
    minX: -9.2,
    maxX: -6.8,
    minZ: -19.2,
    maxZ: -14.0,
    baseY: 0.14,
    topY: CTRL_Y,
    riseAxis: '-z',
    surface: 'metal',
  });
  const ctrlRampMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.4, 0.2, 5.6)), matGrating);
  ctrlRampMesh.position.set(-8.0, (CTRL_Y + 0.14) * 0.5, -16.6);
  ctrlRampMesh.rotation.x = -Math.atan2(CTRL_Y - 0.14, 5.2);
  sceneGroup.add(ctrlRampMesh);
  raycastMeshes.push(ctrlRampMesh);

  // Reactor Console Bank on Control Bunker deck
  addSolidBox(0, CTRL_Y + 0.52, -22.6, 6.2, 1.04, 1.1, matBlastSteel, 'metal');

  // === 7. BARRICADED BREACH VENTS (6 REPAIRABLE ZOMBIE BARRIERS) ===
  const plankAnimItems: Array<{
    group: THREE.Group;
    restPos: THREE.Vector3;
    restRot: THREE.Euler;
    outwardDir: THREE.Vector3;
    state: 'attached' | 'tearing' | 'removed' | 'repairing';
    animT: number;
  }> = [];

  const addBreachVent = (cfg: {
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

    // Dark subterranean breach chute behind vent
    addVisualBox(wx - nx * 2.1, 2.2, wz - nz * 2.1, isWallZ ? 3.8 : 4.2, 4.4, isWallZ ? 4.2 : 3.8, matCeiling);

    const ventBars: typeof plankAnimItems = [];
    for (let p = 0; p < maxPlanks; p++) {
      const pg = new THREE.Group();
      const py = 1.15 + p * 0.34;
      const tilt = (p % 2 === 0 ? 1 : -1) * 0.03;
      const restPos = new THREE.Vector3(wx + nx * 0.14, py, wz + nz * 0.14);
      const restRot = new THREE.Euler(0, isWallZ ? 0 : Math.PI * 0.5, tilt);
      pg.position.copy(restPos);
      pg.rotation.copy(restRot);
      const bar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 0.18, 0.09)), matBarricadeSteel);
      bar.userData.surfaceMaterial = 'metal';
      pg.add(bar);
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
      ventBars.push(item);
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
        const item = ventBars[planksRemaining];
        if (item) {
          item.state = 'tearing';
          item.animT = 0;
        }
        return true;
      },
      repairPlank: () => {
        if (planksRemaining >= maxPlanks) return false;
        const item = ventBars[planksRemaining];
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
          const item = ventBars[i];
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
      label: `Weld ${cfg.label}`,
      cost: 0,
      position: interactPos,
      radiusM: 2.6,
      barrierId: barrier.id,
      activated: false,
    });
  };

  addBreachVent({ id: 'sp_decon_sw', zoneId: 'lobby', label: 'Decon Vent West', axis: 'z', wallCoord: 22.0, alongCoord: -5.4, normalSign: -1, entryNodeId: 'dec_sw' });
  addBreachVent({ id: 'sp_decon_se', zoneId: 'lobby', label: 'Decon Vent East', axis: 'z', wallCoord: 22.0, alongCoord: 5.4, normalSign: -1, entryNodeId: 'dec_se' });
  addBreachVent({ id: 'sp_lab_w', zoneId: 'bio_labs', label: 'Bio-Lab Containment Vent', axis: 'x', wallCoord: -24.0, alongCoord: 0.0, normalSign: 1, entryNodeId: 'lab_mid' });
  addBreachVent({ id: 'sp_ring_e', zoneId: 'containment_ring', label: 'East Gallery Breach', axis: 'x', wallCoord: 24.0, alongCoord: 0.0, normalSign: -1, entryNodeId: 'ring_mid' });
  addBreachVent({ id: 'sp_react_nw', zoneId: 'reactor_deck', label: 'North-West Coolant Shaft', axis: 'z', wallCoord: -24.0, alongCoord: -11.0, normalSign: 1, entryNodeId: 'lab_n' });
  addBreachVent({ id: 'sp_react_ne', zoneId: 'reactor_deck', label: 'North-East Coolant Shaft', axis: 'z', wallCoord: -24.0, alongCoord: 11.0, normalSign: 1, entryNodeId: 'ring_n' });

  // === 8. BUYABLE BLAST DOORS ===
  const addBlastDoor = (
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
    const slab = addSolidBox(x, y + h * 0.5, z, w, h, d, matBlastSteel, 'metal', `col_${id}`, visualGroup);
    slab.userData.interactableId = id;
    const alongZ = d > w;
    const stripe = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(alongZ ? w + 0.06 : w * 0.96, 0.24, alongZ ? d * 0.96 : d + 0.06)), matHazard);
    stripe.position.set(x, y + 0.72, z);
    visualGroup.add(stripe);

    const signTex = trackTex(createStencilSignTexture(label, `${cost} PTS · [F] UNSEAL`, '#67e8f9', '#0e171c', maxAniso));
    const plaque = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.75, 0.65)),
      trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    );
    plaque.position.set(x + (alongZ ? 0.36 : 0), y + 1.55, z + (alongZ ? 0 : 0.36));
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

  addBlastDoor('door_bio_labs', 'Bio-Containment Labs', 750, 'bio_labs', -10.0, 0, 13.0, 0.52, 3.1, 3.2);
  addBlastDoor('door_containment_ring', 'Containment Gallery', 750, 'containment_ring', 10.0, 0, 13.0, 0.52, 3.1, 3.2);
  addBlastDoor('door_reactor_west', 'Reactor Deck West', 1000, 'reactor_deck', -10.0, 0, -8.0, 0.52, 3.1, 3.2);
  addBlastDoor('door_reactor_east', 'Reactor Deck East', 1000, 'reactor_deck', 10.0, 0, -8.0, 0.52, 3.1, 3.2);
  addBlastDoor('door_control_bunker', 'Reactor Control Deck', 1250, 'control_bunker', -8.0, 0.14, -14.0, 2.5, 2.8, 0.52);

  // === 9. REACTOR POWER SWITCH, WALL-BUYS, MYSTERY CRATE & PERKS ===
  const powerLampMat = trackMat(new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 2.3, roughness: 0.25 }));
  const powerLever = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.55, 0.12)), matLabSteel);
  const powerGroup = new THREE.Group();
  powerGroup.position.set(0, CTRL_Y + 1.35, -22.05);
  const pBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.85, 0.9, 0.28)), matBlastSteel);
  const pLamp = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.12, 12, 12)), powerLampMat);
  pLamp.position.set(0, 0.28, 0.16);
  powerLever.position.set(0.2, -0.05, 0.2);
  powerLever.rotation.x = -0.55;
  powerGroup.add(pBox, pLamp, powerLever);
  sceneGroup.add(powerGroup);
  const powerGlow = new THREE.PointLight(0xef4444, 3.6, 7.5, 2);
  powerGlow.position.set(0, CTRL_Y + 1.8, -21.2);
  sceneGroup.add(powerGlow);

  interactables.push({
    id: 'power_switch',
    kind: 'power_switch',
    label: 'Engage Reactor Main Power',
    cost: 0,
    position: [0, CTRL_Y + 1.1, -21.4],
    radiusM: 2.8,
    visualGroup: powerGroup,
    activated: false,
  });

  // Mystery Weapon Crate inside Containment Gallery
  const crateGroup = new THREE.Group();
  crateGroup.position.set(21.4, 0.0, -9.5);
  addSolidBox(21.4, 0.44, -9.5, 0.96, 0.88, 2.2, matBlastSteel, 'metal');
  const crateTrimMat = trackMat(new THREE.MeshStandardMaterial({ color: 0x67e8f9, emissive: 0x06b6d4, emissiveIntensity: 1.6, roughness: 0.25 }));
  const crateTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.0, 0.1, 2.26)), crateTrimMat);
  crateTrim.position.set(0, 0.86, 0);
  crateGroup.add(crateTrim);
  sceneGroup.add(crateGroup);
  const crateLight = new THREE.PointLight(0x22d3ee, 4.4, 8.5, 1.8);
  crateLight.position.set(20.6, 1.65, -9.5);
  sceneGroup.add(crateLight);

  interactables.push({
    id: 'mystery_crate',
    kind: 'mystery_crate',
    label: 'Bio-Vault Mystery Crate',
    cost: 950,
    position: [20.6, 0.9, -9.5],
    radiusM: 2.8,
    visualGroup: crateGroup,
    activated: false,
  });

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
      trackMat(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
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

  addWallBuy('wb_mp5', 'hk_mp5', 'HK MP5', 750, -5.0, 1.65, 8.38, 0);
  addWallBuy('wb_m870', 'remington_870', 'M870 BREACHER', 900, 5.0, 1.65, 8.38, 0);
  addWallBuy('wb_aks74u', 'aks74u', 'AKS-74U', 1100, -10.38, 1.65, 2.0, -Math.PI * 0.5);
  addWallBuy('wb_hk416', 'hk416', 'HK416 CARBINE', 1400, 10.38, 1.65, 2.0, Math.PI * 0.5);
  addWallBuy('wb_m4a1', 'm4a1', 'M4A1 TACTICAL', 1450, 0, CTRL_Y + 1.5, -23.58, 0);

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
    const bodyMat = trackMat(new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.4, metalness: 0.5 }));
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
    pl.position.set(x, y + 2.0, z + Math.cos(ry) * 0.8);
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

  addPerkMachine('perk_vitality', 'vitality', 'Vitality Serum (+100 Max HP)', 2000, 0xdc2626, -22.6, 0.04, -14.5, Math.PI * 0.5);
  addPerkMachine('perk_rapid', 'rapid_handling', 'Rapid Handling (Fast Reload)', 1750, 0x10b981, 0, 0.14, 7.1, Math.PI);

  // === 10. LIGHTING (EMERGENCY RED/EMERALD PRE-POWER -> CLINICAL REACTOR POST-POWER) ===
  const deconBeacon = new THREE.PointLight(0xff5a45, 4.2, 16, 1.7);
  deconBeacon.position.set(0, 4.6, 15.0);
  sceneGroup.add(deconBeacon);
  const beaconMesh = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.22, 0.22, 0.36, 10)), matEmergencyRed);
  beaconMesh.position.set(0, 5.1, 15.0);
  sceneGroup.add(beaconMesh);

  const reactorCoreLight = new THREE.PointLight(0x10b981, 5.5, 20, 1.45);
  reactorCoreLight.position.set(0, 3.0, -7.8);
  sceneGroup.add(reactorCoreLight);

  const powerLights: Array<{ light: THREE.PointLight; targetIntensity: number }> = [];
  const bayCoords: Array<[number, number, number, number]> = [
    [-16.8, 4.8, 2.0, 6.8],
    [16.8, 4.8, 2.0, 6.8],
    [0, 4.9, -2.0, 7.2],
    [0, 4.9, -15.0, 7.2],
    [0, 4.8, 15.0, 5.5],
  ];
  for (const [lx, ly, lz, inten] of bayCoords) {
    const fl = new THREE.PointLight(0xcffafe, 0, 22, 1.5);
    fl.position.set(lx, ly, lz);
    sceneGroup.add(fl);
    powerLights.push({ light: fl, targetIntensity: inten });
    const panel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.4, 0.12, 0.4)), matClinicalLight);
    panel.position.set(lx, WALL_H - 0.1, lz);
    sceneGroup.add(panel);
  }

  let powerOn = false;
  let powerBlend = 0;

  const setPowerState = (powered: boolean): void => {
    powerOn = powered;
    powerLever.rotation.x = powered ? 0.55 : -0.55;
    powerLampMat.color.setHex(powered ? 0x10b981 : 0xef4444);
    powerLampMat.emissive.setHex(powered ? 0x10b981 : 0xef4444);
    powerGlow.color.setHex(powered ? 0x10b981 : 0xef4444);
    matClinicalLight.emissiveIntensity = powered ? 2.4 : 0.18;
    coreFuelMat.emissiveIntensity = powered ? 2.6 : 0.55;
    for (const pm of perkEmissiveMats) {
      pm.mat.emissiveIntensity = powered ? 2.2 : 0.08;
      pm.light.intensity = powered ? 5.2 : 0.0;
    }
  };

  // === 11. ZONE-GATED BIDIRECTIONAL NAVGRAPH ===
  const rawNodes: NavNode[] = [
    // Zone 1: Decontamination Airlock ('lobby')
    { id: 'dec_c', position: [0, 0.04, 11.4], zoneId: 'lobby', neighbors: ['dec_w', 'dec_e', 'dec_sw_mid', 'dec_se_mid'] },
    { id: 'dec_w', position: [-7.5, 0.04, 13.0], zoneId: 'lobby', neighbors: ['dec_c', 'dec_sw_mid', 'lab_entry'] },
    { id: 'dec_e', position: [7.5, 0.04, 13.0], zoneId: 'lobby', neighbors: ['dec_c', 'dec_se_mid', 'ring_entry'] },
    { id: 'dec_sw_mid', position: [-5.0, 0.04, 15.6], zoneId: 'lobby', neighbors: ['dec_c', 'dec_w', 'dec_sw'], isCover: true, coverNormal: [1, 0] },
    { id: 'dec_se_mid', position: [5.0, 0.04, 15.6], zoneId: 'lobby', neighbors: ['dec_c', 'dec_e', 'dec_se'], isCover: true, coverNormal: [-1, 0] },
    { id: 'dec_sw', position: [-5.4, 0.04, 19.8], zoneId: 'lobby', neighbors: ['dec_sw_mid', 'dec_s_mid'] },
    { id: 'dec_s_mid', position: [0, 0.04, 19.8], zoneId: 'lobby', neighbors: ['dec_sw', 'dec_se'] },
    { id: 'dec_se', position: [5.4, 0.04, 19.8], zoneId: 'lobby', neighbors: ['dec_se_mid', 'dec_s_mid'] },

    // Zone 2: Bio-Containment Labs ('bio_labs')
    { id: 'lab_entry', position: [-13.0, 0.04, 13.0], zoneId: 'bio_labs', requiredDoorId: 'door_bio_labs', neighbors: ['dec_w', 'lab_s', 'lab_e_mid'] },
    { id: 'lab_s', position: [-20.2, 0.04, 9.5], zoneId: 'bio_labs', neighbors: ['lab_entry', 'lab_mid'] },
    { id: 'lab_mid', position: [-21.0, 0.04, 0.0], zoneId: 'bio_labs', neighbors: ['lab_s', 'lab_n', 'lab_e_mid'] },
    { id: 'lab_e_mid', position: [-13.0, 0.04, 1.5], zoneId: 'bio_labs', neighbors: ['lab_entry', 'lab_mid', 'lab_door_r'] },
    { id: 'lab_n', position: [-16.5, 0.04, -18.5], zoneId: 'bio_labs', neighbors: ['lab_mid', 'lab_door_r'] },
    { id: 'lab_door_r', position: [-13.0, 0.04, -8.0], zoneId: 'bio_labs', neighbors: ['lab_e_mid', 'lab_n', 'react_w'] },

    // Zone 3: Containment Gallery ('containment_ring')
    { id: 'ring_entry', position: [13.0, 0.04, 13.0], zoneId: 'containment_ring', requiredDoorId: 'door_containment_ring', neighbors: ['dec_e', 'ring_s', 'ring_w_mid'] },
    { id: 'ring_s', position: [20.2, 0.04, 9.5], zoneId: 'containment_ring', neighbors: ['ring_entry', 'ring_mid'] },
    { id: 'ring_mid', position: [21.0, 0.04, 0.0], zoneId: 'containment_ring', neighbors: ['ring_s', 'ring_n', 'ring_w_mid'] },
    { id: 'ring_w_mid', position: [13.0, 0.04, 1.5], zoneId: 'containment_ring', neighbors: ['ring_entry', 'ring_mid', 'ring_door_r'] },
    { id: 'ring_n', position: [16.5, 0.04, -18.5], zoneId: 'containment_ring', neighbors: ['ring_mid', 'ring_door_r'] },
    { id: 'ring_door_r', position: [13.0, 0.04, -8.0], zoneId: 'containment_ring', neighbors: ['ring_w_mid', 'ring_n', 'react_e'] },

    // Zone 4: Flooded Reactor Deck ('reactor_deck')
    { id: 'react_w', position: [-6.6, 0.14, -8.0], zoneId: 'reactor_deck', neighbors: ['lab_door_r', 'react_sw', 'react_nw'] },
    { id: 'react_e', position: [6.6, 0.14, -8.0], zoneId: 'reactor_deck', neighbors: ['ring_door_r', 'react_se', 'react_ne'] },
    { id: 'react_sw', position: [-6.6, 0.14, 3.8], zoneId: 'reactor_deck', neighbors: ['react_w', 'react_s'] },
    { id: 'react_s', position: [0, 0.14, 3.8], zoneId: 'reactor_deck', neighbors: ['react_sw', 'react_se'] },
    { id: 'react_se', position: [6.6, 0.14, 3.8], zoneId: 'reactor_deck', neighbors: ['react_e', 'react_s'] },
    { id: 'react_nw', position: [-6.6, 0.14, -13.2], zoneId: 'reactor_deck', neighbors: ['react_w', 'react_n_mid', 'ctrl_ramp'] },
    { id: 'react_n_mid', position: [0, 0.14, -17.5], zoneId: 'reactor_deck', neighbors: ['react_nw', 'react_ne'] },
    { id: 'react_ne', position: [6.6, 0.14, -16.5], zoneId: 'reactor_deck', neighbors: ['react_e', 'react_n_mid'] },

    // Zone 5: Elevated Control Bunker ('control_bunker')
    { id: 'ctrl_ramp', position: [-8.0, CTRL_Y * 0.55, -16.6], zoneId: 'control_bunker', requiredDoorId: 'door_control_bunker', neighbors: ['react_nw', 'ctrl_top'] },
    { id: 'ctrl_top', position: [0, CTRL_Y + 0.04, -21.0], zoneId: 'control_bunker', neighbors: ['ctrl_ramp'] },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'objekt_47',
    name: 'Bunker Objekt-47',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA: [
        { position: [0, 0.04, 11.8], yaw: Math.PI },
        { position: [-3.2, 0.04, 11.8], yaw: Math.PI },
        { position: [3.2, 0.04, 11.8], yaw: Math.PI },
        { position: [0, 0.04, 18.2], yaw: 0 },
      ],
      teamB: [{ position: [0, CTRL_Y + 0.04, -21.0], yaw: 0 }],
      ffa: [{ position: [0, 0.04, 11.8], yaw: Math.PI }],
      playerStart: { position: [0, 0.04, 11.8], yaw: Math.PI, zoneId: 'lobby' },
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
      const strobe = 0.5 + 0.5 * Math.sin(elapsedSec * 4.5);
      deconBeacon.intensity = (powerOn ? 1.4 : 4.4) * (0.45 + 0.55 * strobe);
      reactorCoreLight.intensity = (powerOn ? 10.5 : 5.2) + Math.sin(elapsedSec * 2.4) * 0.9;
      crateLight.intensity = 4.0 + Math.sin(elapsedSec * 3.4) * 0.85;
      for (let i = 0; i < podFluids.length; i++) {
        podFluids[i].position.y = 1.65 + Math.sin(elapsedSec * 1.4 + i * 1.7) * 0.04;
      }

      for (let i = 0; i < plankAnimItems.length; i++) {
        const it = plankAnimItems[i];
        if (it.state === 'tearing') {
          it.animT = Math.min(1, it.animT + dt / 0.36);
          const ease = it.animT * it.animT;
          it.group.position.copy(it.restPos);
          it.group.position.addScaledVector(it.outwardDir, ease * 0.85);
          it.group.position.y -= ease * 0.9;
          it.group.rotation.set(it.restRot.x + ease * 0.65, it.restRot.y + ease * 0.3, it.restRot.z + ease * 0.45);
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

export const BUNKER_OBJEKT_47_MAP: IMapDefinition = {
  id: 'objekt_47',
  name: 'Bunker Objekt-47',
  subtitle: 'Subterranean Bio-Containment & Flooded Reactor',
  description:
    'Subterranean Cold War bio-containment complex featuring armored blast doors, specimen labs, containment gallery, and flooded coolant reactor decks.',
  mode: 'infection',
  status: 'playable',
  environmentTags: ['Bio-Containment', '5 Unlockable Zones', 'Flooded Reactor'],
  accentHex: '#10b981',
  previewStyle: 'objekt_47',
  build: buildBunkerObjekt47,
};

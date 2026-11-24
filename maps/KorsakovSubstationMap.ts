import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { DestructibleDoorSystem } from '../doors/DestructibleDoorSystem';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import { WettableSurfaceEntry } from '../engine/world/WeatherTimeSystem';
import { createWindShaderUniforms } from '../engine/world/WindFoliageShader';
import {
  buildInstancedGrassTufts,
  buildOfficeDesk,
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCorrugatedMetalTexture,
  createIndustrialSlateConcreteTexture,
  createRustedMetalTexture,
} from './MapTextures';
import {
  buildNavGraph,
  BuiltMapInstance,
  IMapDefinition,
  MapLightingPreset,
  NavNode,
  SpawnPoint,
} from './types';

// Option 3 Palette: Industrial Slate Concrete + Warm Sodium-Vapor Floodlights + Crisp Blue Emergency Exit Lights
const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x161c24,
  fogHex: 0x182028,
  fogDensity: 0.011,
  envIntensity: 0.36,
  hemiSkyHex: 0x627894,
  hemiGroundHex: 0x1d2228,
  hemiIntensity: 0.54,
  keyLightHex: 0x99b3d1, // cool overcast dusk industrial skylight
  keyLightIntensity: 1.05,
  keyLightPos: [-36, 52, 28],
};

function buildKorsakovSubstation(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -49.5;
  physics.boundsMaxX = 49.5;
  physics.boundsMinZ = -41.5;
  physics.boundsMaxZ = 41.5;

  const sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];

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

  const skyKey = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  skyKey.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl && qProfile.castShadows) {
    skyKey.castShadow = true;
    const sm = Math.min(2048, qProfile.shadowMapSize);
    skyKey.shadow.mapSize.set(sm, sm);
    skyKey.shadow.camera.near = 2;
    skyKey.shadow.camera.far = 145;
    skyKey.shadow.camera.left = -56;
    skyKey.shadow.camera.right = 56;
    skyKey.shadow.camera.top = 56;
    skyKey.shadow.camera.bottom = -56;
    skyKey.shadow.bias = -0.0005;
    skyKey.shadow.normalBias = 0.025;
  }
  sceneGroup.add(skyKey);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  // Textures (Industrial Slate Concrete, Wet Slate Tarmac, Corrugated Steel, Rusted Utility Truck)
  const slateWallTex = trackTex(createIndustrialSlateConcreteTexture(maxAniso, 4, 2, '#434b54', 7701));
  const slateFloorTex = trackTex(createIndustrialSlateConcreteTexture(maxAniso, 8, 8, '#343b43', 7702));
  const yardTarmacTex = trackTex(createAsphaltRoadTexture(maxAniso, 16, 14, false, 7703));
  const contSlateTex = trackTex(createCorrugatedMetalTexture(maxAniso, '#36434f', 7704));
  const truckRustTex = trackTex(createRustedMetalTexture(maxAniso, '#4c5761', 7705));

  // Materials
  const matSlateWall = trackMat(
    new THREE.MeshStandardMaterial({ map: slateWallTex, roughness: 0.84, metalness: 0.1 }),
  );
  const matSlateFloor = trackMat(
    new THREE.MeshStandardMaterial({ map: slateFloorTex, roughness: 0.72, metalness: 0.14 }),
  );
  const matYardTarmac = trackMat(
    new THREE.MeshStandardMaterial({ map: yardTarmacTex, roughness: 0.56, metalness: 0.18 }), // slightly wet slate sheen
  );
  const matDarkSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x262d34, roughness: 0.44, metalness: 0.82 }),
  );
  const matTurbineBody = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b4956, roughness: 0.48, metalness: 0.72 }),
  );
  const matCopperCoil = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xa6633c, roughness: 0.36, metalness: 0.84 }),
  );
  const matHazardYellow = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xd99b26, roughness: 0.55, metalness: 0.25 }),
  );
  const matCeramic = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7c8a96, roughness: 0.28, metalness: 0.22 }),
  );
  const matContSlate = trackMat(
    new THREE.MeshStandardMaterial({ map: contSlateTex, roughness: 0.62, metalness: 0.48 }),
  );
  const matSodiumLens = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffd79a,
      emissive: 0xff9f2e,
      emissiveIntensity: 3.0,
      roughness: 0.18,
    }),
  );
  const matBlueExit = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x93e2ff,
      emissive: 0x0ea5e9,
      emissiveIntensity: 3.0,
      roughness: 0.18,
    }),
  );
  const matControlGlass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e3545,
      roughness: 0.15,
      metalness: 0.7,
      transparent: true,
      opacity: 0.34,
    }),
  );

  const windUniforms = createWindShaderUniforms();

  const propCtx: PropFactoryContext = {
    sceneGroup,
    physics,
    raycastMeshes,
    isSoftwareGl,
    trackGeo,
    trackMat,
    windUniforms,
    maxAniso,
  };

  const wettableSurfaces: WettableSurfaceEntry[] = [
    { material: matYardTarmac, baseRoughness: 0.56, baseEnvMapIntensity: 0.65 },
  ];

  const dummy = new THREE.Object3D();

  const addSolidBox = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    castShadow = true,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !isSoftwareGl && qProfile.castShadows && castShadow && h > 0.35;
    mesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    mesh.userData.surfaceMaterial = surface;
    sceneGroup.add(mesh);
    raycastMeshes.push(mesh);
    physics.addBox({
      minX: x - w * 0.5,
      maxX: x + w * 0.5,
      minY: y - h * 0.5,
      maxY: y + h * 0.5,
      minZ: z - d * 0.5,
      maxZ: z + d * 0.5,
      surface,
      blocksMovement: true,
    });
    return mesh;
  };

  // === 1. GROUND LAYER & OUTDOOR WET-SLATE YARD (Zero Z-Fighting) ===
  const yardGround = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(180, 180)), matYardTarmac);
  yardGround.rotation.x = -Math.PI * 0.5;
  yardGround.position.y = 0;
  yardGround.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  yardGround.userData.surfaceMaterial = 'asphalt';
  sceneGroup.add(yardGround);
  raycastMeshes.push(yardGround);

  // Main Turbine Hall & Flanking Switchgear Raised Industrial Floor Slab (y top = 0.08m)
  addSolidBox(0, 0.04, 0, 66.0, 0.08, 44.0, matSlateFloor, 'concrete', false);
  physics.addInteriorZone({ minX: -33, maxX: 33, minY: 0, maxY: 11.5, minZ: -22, maxZ: 22, material: 'concrete' });

  // Outer perimeter concrete security wall framing the Substation site (X = ±50, Z = ±42)
  addSolidBox(0, 2.0, -42.0, 100.4, 4.0, 0.5, matSlateWall);
  addSolidBox(0, 2.0, 42.0, 100.4, 4.0, 0.5, matSlateWall);
  addSolidBox(-50.0, 2.0, 0, 0.5, 4.0, 83.5, matSlateWall);
  addSolidBox(50.0, 2.0, 0, 0.5, 4.0, 83.5, matSlateWall);

  // === 2. MAIN HYDRO-TURBINE HALL SHELL (X in [-33, 33], Z in [-22, 22], Height = 10.6m) ===
  const HALL_H = 10.6;
  const CAT_Y = 4.2;

  // North & South Exterior Hall Walls with 3 wide industrial blast doorways each (X = -24, 0, 24)
  const buildHallFacade = (fz: number): void => {
    // Solid segments strictly between doors (doors: [-26..-22], [-3.2..3.2], [22..26])
    addSolidBox(-29.5, 0.08 + HALL_H * 0.5, fz, 7.0, HALL_H, 0.5, matSlateWall);
    addSolidBox(-12.6, 0.08 + HALL_H * 0.5, fz, 18.8, HALL_H, 0.5, matSlateWall);
    addSolidBox(12.6, 0.08 + HALL_H * 0.5, fz, 18.8, HALL_H, 0.5, matSlateWall);
    addSolidBox(29.5, 0.08 + HALL_H * 0.5, fz, 7.0, HALL_H, 0.5, matSlateWall);
    // Door headers (above 3.4m doorway clearance)
    const hdrH = HALL_H - 3.4;
    addSolidBox(-24.0, 0.08 + 3.4 + hdrH * 0.5, fz, 4.0, hdrH, 0.5, matSlateWall);
    addSolidBox(0, 0.08 + 3.4 + hdrH * 0.5, fz, 6.4, hdrH, 0.5, matSlateWall);
    addSolidBox(24.0, 0.08 + 3.4 + hdrH * 0.5, fz, 4.0, hdrH, 0.5, matSlateWall);
  };
  buildHallFacade(-21.75);
  buildHallFacade(21.75);

  // West & East Exterior Hall Walls with center loading bay doorways (Z in [-3.0, 3.0])
  for (const fx of [-32.75, 32.75]) {
    addSolidBox(fx, 0.08 + HALL_H * 0.5, -12.25, 0.5, HALL_H, 18.5, matSlateWall);
    addSolidBox(fx, 0.08 + HALL_H * 0.5, 12.25, 0.5, HALL_H, 18.5, matSlateWall);
    addSolidBox(fx, 0.08 + 3.4 + (HALL_H - 3.4) * 0.5, 0, 0.5, HALL_H - 3.4, 6.0, matSlateWall);
  }

  // Sloped concrete threshold aprons seating exterior tarmac seamlessly to Turbine Hall floor slab (0.08m) without overlap
  const addDoorApron = (x: number, z: number, w: number, d: number): void => {
    const apron = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, 0.076, d)), matSlateFloor);
    apron.position.set(x, 0.038, z);
    apron.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    apron.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(apron);
    raycastMeshes.push(apron);
  };
  for (const dz of [-22.55, 22.55]) {
    addDoorApron(-24.0, dz, 4.4, 1.1);
    addDoorApron(0, dz, 6.8, 1.1);
    addDoorApron(24.0, dz, 4.4, 1.1);
  }
  addDoorApron(-33.55, 0, 1.1, 6.4);
  addDoorApron(33.55, 0, 1.1, 6.4);

  // Interior Switchgear Corridor Divider Walls (X = -21.0 and X = 21.0) with triple arch openings
  for (const ix of [-21.0, 21.0]) {
    addSolidBox(ix, 0.08 + (CAT_Y - 0.14) * 0.5, -15.5, 0.4, CAT_Y - 0.14, 12.0, matSlateWall);
    addSolidBox(ix, 0.08 + (CAT_Y - 0.14) * 0.5, 0, 0.4, CAT_Y - 0.14, 10.0, matSlateWall);
    addSolidBox(ix, 0.08 + (CAT_Y - 0.14) * 0.5, 15.5, 0.4, CAT_Y - 0.14, 12.0, matSlateWall);
  }

  // Hall Roof with Industrial Skylight Clerestory Gaps & Heavy Overhead Steel Trusses
  addSolidBox(-20.0, HALL_H + 0.24, 0, 26.5, 0.36, 44.2, matDarkSteel, 'metal');
  addSolidBox(20.0, HALL_H + 0.24, 0, 26.5, 0.36, 44.2, matDarkSteel, 'metal');
  for (let tz = -18; tz <= 18; tz += 6) {
    const truss = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(65.0, 0.55, 0.42)), matDarkSteel);
    truss.position.set(0, HALL_H - 0.25, tz);
    sceneGroup.add(truss);
  }

  // Overhead Yellow Industrial Gantry Bridge Crane suspended across Turbine Hall (Z = -4)
  const craneY = 8.4;
  const craneBeamA = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(41.5, 0.85, 0.55)), matHazardYellow);
  craneBeamA.position.set(0, craneY, -4.8);
  const craneBeamB = craneBeamA.clone();
  craneBeamB.position.set(0, craneY, -3.2);
  const hoistTrolley = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.6, 0.9, 2.2)), matDarkSteel);
  hoistTrolley.position.set(4.5, craneY - 0.5, -4.0);
  sceneGroup.add(craneBeamA, craneBeamB, hoistTrolley);

  // === 3. THREE COLOSSAL HYDRO-TURBINE GENERATOR DRUMS DOWN MAIN HALL ===
  for (const tx of [-12.0, 0.0, 12.0]) {
    const tg = new THREE.Group();
    tg.position.set(tx, 0.08, 0);

    // Concrete turbine plinth (y: 0..1.1)
    const plinth = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.2, 1.1, 11.2)), matSlateWall);
    plinth.position.y = 0.55;
    plinth.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    plinth.castShadow = !isSoftwareGl && qProfile.castShadows;
    tg.add(plinth);
    raycastMeshes.push(plinth);

    // Massive horizontal steel generator drum
    const drum = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(2.1, 2.1, 8.6, 18)), matTurbineBody);
    drum.rotation.x = Math.PI * 0.5;
    drum.position.y = 2.6;
    drum.castShadow = !isSoftwareGl && qProfile.castShadows;
    drum.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    tg.add(drum);
    raycastMeshes.push(drum);

    // Copper stator cooling rings & yellow safety collar bands
    for (const rz of [-3.2, 0, 3.2]) {
      const ring = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(2.24, 2.24, 0.36, 18)), matCopperCoil);
      ring.rotation.x = Math.PI * 0.5;
      ring.position.set(0, 2.6, rz);
      tg.add(ring);
    }
    const endCapN = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(1.45, 1.85, 0.9, 14)), matDarkSteel);
    endCapN.rotation.x = Math.PI * 0.5;
    endCapN.position.set(0, 2.6, -4.7);
    const endCapS = endCapN.clone();
    endCapS.position.set(0, 2.6, 4.7);
    const hazardBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.32, 0.16, 11.32)), matHazardYellow);
    hazardBase.position.y = 1.04;
    tg.add(endCapN, endCapS, hazardBase);

    sceneGroup.add(tg);

    // Clean turbine collider for tactical lane cover
    physics.addBox({
      minX: tx - 3.15,
      maxX: tx + 3.15,
      minY: 0.08,
      maxY: 4.5,
      minZ: -5.65,
      maxZ: 5.65,
      surface: 'metal',
      blocksMovement: true,
    });
  }

  // === 4. UPPER STEEL CATWALK BALCONIES, CONTROL ROOM & 4 STAIR FLIGHTS (Y = 4.2m) ===
  // West & East Side Catwalk Decks above Switchgear Corridors (X in [-32.4,-20.8] and [20.8,32.4])
  // Leave stairwell cutouts on North/South ends cleanly
  addSolidBox(-26.6, CAT_Y - 0.12, 0, 11.6, 0.24, 24.0, matDarkSteel, 'metal');
  addSolidBox(26.6, CAT_Y - 0.12, 0, 11.6, 0.24, 24.0, matDarkSteel, 'metal');
  // North Control Room Balcony Overlook (Z in [-21.4, -14.2], X in [-20.8, 20.8])
  addSolidBox(0, CAT_Y - 0.12, -17.8, 41.6, 0.24, 7.2, matSlateFloor, 'concrete');
  // South Catwalk Bridge Overlook (Z in [14.2, 21.4], X in [-20.8, 20.8])
  addSolidBox(0, CAT_Y - 0.12, 17.8, 41.6, 0.24, 7.2, matDarkSteel, 'metal');

  // Waist-high steel catwalk guardrails overlooking the Turbine Hall
  addSolidBox(-20.9, CAT_Y + 0.52, 0, 0.16, 1.02, 28.2, matDarkSteel, 'metal');
  addSolidBox(20.9, CAT_Y + 0.52, 0, 0.16, 1.02, 28.2, matDarkSteel, 'metal');
  addSolidBox(0, CAT_Y + 0.52, 14.3, 41.5, 1.02, 0.16, matDarkSteel, 'metal');

  // North Switchgear Control Room Enclosure (4 segmented non-vaultable bullet-breakable observation windows)
  addSolidBox(-14.5, CAT_Y + 1.5, -14.3, 12.6, 3.0, 0.24, matSlateWall);
  addSolidBox(14.5, CAT_Y + 1.5, -14.3, 12.6, 3.0, 0.24, matSlateWall);
  addSolidBox(0, CAT_Y + 0.54, -14.3, 16.4, 1.08, 0.24, matSlateWall);
  addSolidBox(0, CAT_Y + 2.98, -14.3, 16.4, 0.24, 0.24, matSlateWall);

  const ctrlBreakables = new Map<string, { id: string; mesh: THREE.Mesh; shattered: boolean; center: THREE.Vector3 }>();
  const ctrlPaneW = 3.95;
  for (let p = 0; p < 4; p++) {
    const px = -6.075 + p * 4.05;
    const bid = `korsakov_ctrl_glass_${p + 1}`;
    const pane = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(ctrlPaneW, 1.85, 0.08)), matControlGlass);
    pane.position.set(px, CAT_Y + 2.02, -14.3);
    pane.userData.surfaceMaterial = 'glass';
    pane.userData.ballisticMaterial = 'glass';
    pane.userData.breakableGlass = true;
    pane.userData.noVault = true;
    pane.userData.shattered = false;
    pane.userData.breakableId = bid;
    sceneGroup.add(pane);
    raycastMeshes.push(pane);
    physics.addBox({
      id: bid,
      minX: px - ctrlPaneW * 0.5,
      maxX: px + ctrlPaneW * 0.5,
      minY: CAT_Y + 1.08,
      maxY: CAT_Y + 2.95,
      minZ: -14.38,
      maxZ: -14.22,
      surface: 'glass',
      blocksMovement: true,
    });
    ctrlBreakables.set(bid, { id: bid, mesh: pane, shattered: false, center: pane.position.clone() });
    if (p < 3) {
      addSolidBox(-4.05 + p * 4.05, CAT_Y + 2.02, -14.3, 0.1, 1.85, 0.18, matDarkSteel, 'metal');
    }
  }
  buildOfficeDesk(propCtx, -4.0, CAT_Y, -16.8, 0, matDarkSteel, matTurbineBody);
  buildOfficeDesk(propCtx, 4.0, CAT_Y, -16.8, 0, matDarkSteel, matTurbineBody);

  // 4 Stepped Steel Staircases rising to Catwalk Level (Y = 4.2m)
  const buildSteelStairs = (cx: number, zStart: number, zEnd: number, riseAxis: '+z' | '-z'): void => {
    const minZ = Math.min(zStart, zEnd);
    const maxZ = Math.max(zStart, zEnd);
    const w = 3.2;
    physics.addRamp({
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minZ,
      maxZ,
      baseY: 0.08,
      topY: CAT_Y,
      riseAxis,
      surface: 'metal',
    });
    const steps = 16;
    const stepD = (maxZ - minZ) / steps;
    const stepH = (CAT_Y - 0.08) / steps;
    const sGeo = trackGeo(new THREE.BoxGeometry(w, stepH, stepD - 0.004));
    const sInst = new THREE.InstancedMesh(sGeo, matDarkSteel, steps);
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const sz = riseAxis === '+z' ? minZ + t * (maxZ - minZ) : maxZ - t * (maxZ - minZ);
      dummy.position.set(cx, 0.08 + (i + 0.5) * stepH, sz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      sInst.setMatrixAt(i, dummy.matrix);
    }
    sInst.instanceMatrix.needsUpdate = true;
    sInst.computeBoundingSphere();
    sInst.userData.surfaceMaterial = 'metal';
    sceneGroup.add(sInst);
    raycastMeshes.push(sInst);
  };
  buildSteelStairs(-26.6, -21.0, -12.0, '+z');
  buildSteelStairs(26.6, -21.0, -12.0, '+z');
  buildSteelStairs(-26.6, 21.0, 12.0, '-z');
  buildSteelStairs(26.6, 21.0, 12.0, '-z');

  // === 5. OUTDOOR WET-SLATE ELECTRICAL TRANSFORMER YARDS (NORTH & SOUTH) ===
  const buildTransformerUnit = (tx: number, tz: number): void => {
    const g = new THREE.Group();
    g.position.set(tx, 0, tz);
    // Concrete containment plinth
    const base = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(4.4, 0.35, 3.4)), matSlateWall);
    base.position.y = 0.175;
    // Main oil-cooled radiator tank
    const tank = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.4, 2.6, 2.4)), matTurbineBody);
    tank.position.y = 1.65;
    tank.castShadow = !isSoftwareGl && qProfile.castShadows;
    tank.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    g.add(base, tank);
    // Cooling fin ribs on sides
    for (let f = -1.2; f <= 1.2; f += 0.6) {
      const fin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 2.1, 2.75)), matDarkSteel);
      fin.position.set(f, 1.65, 0);
      g.add(fin);
    }
    // 3 tall ceramic HV insulator bushings on top
    for (const bx of [-1.0, 0, 1.0]) {
      const bush = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.22, 1.7, 10)), matCeramic);
      bush.position.set(bx, 3.8, 0);
      g.add(bush);
    }
    sceneGroup.add(g);
    raycastMeshes.push(tank);

    physics.addBox({
      minX: tx - 2.2,
      maxX: tx + 2.2,
      minY: 0,
      maxY: 3.1,
      minZ: tz - 1.7,
      maxZ: tz + 1.7,
      surface: 'metal',
      blocksMovement: true,
    });
  };

  for (const tx of [-18, 0, 18]) {
    buildTransformerUnit(tx, 31.5);
    buildTransformerUnit(tx, -31.5);
  }

  // Steel high-voltage overhead transmission gantries spanning the outdoor yards
  for (const gz of [-31.5, 31.5]) {
    for (const px of [-28, -9, 9, 28]) {
      addSolidBox(px, 4.2, gz, 0.45, 8.4, 0.45, matDarkSteel, 'metal');
    }
    const cross = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(57.0, 0.45, 0.45)), matDarkSteel);
    cross.position.set(0, 8.2, gz);
    sceneGroup.add(cross);
  }

  // Shipping containers & parked utility ZIL service truck in West/East outdoor bays
  addSolidBox(-41.5, 1.32, -8.5, 2.5, 2.64, 6.4, matContSlate, 'metal');
  addSolidBox(41.5, 1.32, 8.5, 2.5, 2.64, 6.4, matContSlate, 'metal');
  const truckMats: VehicleMaterials = {
    body: trackMat(new THREE.MeshStandardMaterial({ map: truckRustTex, roughness: 0.7, metalness: 0.38 })),
    rust: matDarkSteel,
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.95 })),
    rim: matCeramic,
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x101215, roughness: 0.95 })),
    glass: matControlGlass,
    chrome: matCeramic,
  };
  buildRustedVehicle(propCtx, 'zil_truck', -41.5, 0, 14.0, 0.2, truckMats);
  buildRustedVehicle(propCtx, 'pickup', 41.5, 0, -14.0, -0.25, truckMats);

  // Industrial Steel Blast Baffles & Yard Cable-Spool Cover Clusters breaking direct hall-to-yard sightlines
  const blastBaffles: Array<[number, number, number, number]> = [
    [-5.8, -25.0, 3.0, 0.48],
    [5.8, -25.0, 3.0, 0.48],
    [-5.8, 25.0, 3.0, 0.48],
    [5.8, 25.0, 3.0, 0.48],
    [-36.5, -16.5, 0.5, 3.2],
    [36.5, 16.5, 0.5, 3.2],
    [-11.5, -10.5, 2.6, 0.44],
    [11.5, 10.5, 2.6, 0.44],
  ];
  for (const [bx, bz, bw, bd] of blastBaffles) {
    const baseY = Math.abs(bz) < 21.5 && Math.abs(bx) < 32.5 ? 0.08 : 0;
    addSolidBox(bx, baseY + 0.58, bz, bw, 1.16, bd, matDarkSteel, 'metal');
    const trim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(bw + 0.04, 0.08, bd + 0.04)),
      matHazardYellow,
    );
    trim.position.set(bx, baseY + 1.2, bz);
    sceneGroup.add(trim);
  }

  // === 6. SIGNATURE OPTION 3 LIGHTING: WARM SODIUM-VAPOR FLOODLIGHTS + BLUE EMERGENCY EXIT LIGHTS ===
  type SodiumMountType = 'truss' | 'gantry' | 'wall-west' | 'wall-east';
  const sodiumSpecs: Array<{ x: number; y: number; z: number; intensity: number; mount: SodiumMountType }> = [
    // Indoor high-bay floodlights suspended from the center Z=0 roof truss (Y = 10.35)
    { x: -12.0, y: 8.2, z: 0, intensity: 22.0, mount: 'truss' },
    { x: 0.0, y: 8.2, z: 0, intensity: 24.0, mount: 'truss' },
    { x: 12.0, y: 8.2, z: 0, intensity: 22.0, mount: 'truss' },
    // North & South outdoor transformer yard floodlights bolted under HV gantry crossbeams (Z = ±31.5, Y = 8.2)
    { x: -16.0, y: 7.6, z: 31.5, intensity: 20.0, mount: 'gantry' },
    { x: 16.0, y: 7.6, z: 31.5, intensity: 20.0, mount: 'gantry' },
    { x: -16.0, y: 7.6, z: -31.5, intensity: 20.0, mount: 'gantry' },
    { x: 16.0, y: 7.6, z: -31.5, intensity: 20.0, mount: 'gantry' },
    // West & East outdoor loading-bay floodlights cantilevered off the exterior Turbine Hall walls (X = ±33.0)
    { x: -33.85, y: 7.2, z: 0, intensity: 18.0, mount: 'wall-west' },
    { x: 33.85, y: 7.2, z: 0, intensity: 18.0, mount: 'wall-east' },
  ];
  const blueExitSpecs: Array<{ x: number; y: number; z: number; rotY?: number }> = [
    { x: 0, y: 3.7, z: -21.42 },
    { x: 0, y: 3.7, z: 21.42 },
    { x: -24.0, y: 3.7, z: -21.42 },
    { x: 24.0, y: 3.7, z: 21.42 },
    { x: -32.42, y: 3.7, z: 0, rotY: Math.PI * 0.5 },
    { x: 32.42, y: 3.7, z: 0, rotY: Math.PI * 0.5 },
    { x: 0, y: CAT_Y + 2.98, z: -14.48 },
  ];

  // Shared geometries for light fixtures & structural mounting hardware
  const sodiumHousingGeo = trackGeo(new THREE.BoxGeometry(1.1, 0.22, 0.55));
  const sodiumLensGeo = trackGeo(new THREE.BoxGeometry(0.95, 0.08, 0.42));
  const trussRodGeo = trackGeo(new THREE.CylinderGeometry(0.03, 0.03, 1.95, 6));
  const gantryYokeGeo = trackGeo(new THREE.BoxGeometry(0.08, 0.44, 0.16));
  const wallPlateGeo = trackGeo(new THREE.BoxGeometry(0.12, 0.96, 0.72));
  const wallArmGeo = trackGeo(new THREE.BoxGeometry(1.02, 0.1, 0.12));
  const wallBraceGeo = trackGeo(new THREE.BoxGeometry(0.95, 0.07, 0.08));
  const blueExitGeo = trackGeo(new THREE.BoxGeometry(0.85, 0.26, 0.18));

  // Always place emissive light fixture meshes with physically grounded mounts on all tiers
  for (const spec of sodiumSpecs) {
    const { x: sx, y: sy, z: sz, mount } = spec;
    const isWallMount = mount === 'wall-west' || mount === 'wall-east';

    const housing = new THREE.Mesh(sodiumHousingGeo, matDarkSteel);
    housing.position.set(sx, sy + 0.16, sz);
    const lens = new THREE.Mesh(sodiumLensGeo, matSodiumLens);
    lens.position.set(sx, sy, sz);
    if (isWallMount) {
      housing.rotation.y = Math.PI * 0.5;
      lens.rotation.y = Math.PI * 0.5;
    }
    sceneGroup.add(housing, lens);

    if (mount === 'truss') {
      // Twin vertical conduit suspension rods connecting housing top (Y=8.47) into Z=0 roof truss (Y=10.35)
      for (const ox of [-0.36, 0.36]) {
        const rod = new THREE.Mesh(trussRodGeo, matDarkSteel);
        rod.position.set(sx + ox, sy + 0.27 + 0.975, sz);
        sceneGroup.add(rod);
      }
    } else if (mount === 'gantry') {
      // Twin steel mounting brackets bolting housing directly up into the overhead gantry crossbeam (Y=8.2)
      for (const ox of [-0.36, 0.36]) {
        const yoke = new THREE.Mesh(gantryYokeGeo, matDarkSteel);
        yoke.position.set(sx + ox, sy + 0.38, sz);
        sceneGroup.add(yoke);
      }
    } else {
      // Heavy cantilevered steel wall bracket bolted flush into the West (-33.0) or East (+33.0) hall facade
      const dir = mount === 'wall-west' ? -1 : 1;
      const wallFaceX = dir * 33.0;
      const plate = new THREE.Mesh(wallPlateGeo, matDarkSteel);
      plate.position.set(wallFaceX + dir * 0.04, sy + 0.05, sz);
      sceneGroup.add(plate);

      for (const oz of [-0.32, 0.32]) {
        const arm = new THREE.Mesh(wallArmGeo, matDarkSteel);
        arm.position.set(wallFaceX + dir * 0.48, sy + 0.22, sz + oz);
        const brace = new THREE.Mesh(wallBraceGeo, matDarkSteel);
        brace.position.set(wallFaceX + dir * 0.42, sy - 0.04, sz + oz);
        brace.rotation.z = dir * 0.52;
        sceneGroup.add(arm, brace);
      }
    }
  }
  for (const spec of blueExitSpecs) {
    const box = new THREE.Mesh(blueExitGeo, matBlueExit);
    box.position.set(spec.x, spec.y, spec.z);
    if (spec.rotY) box.rotation.y = spec.rotY;
    sceneGroup.add(box);
  }

  // Real dynamic PointLights budgeted cleanly by GraphicsQualityProfile
  const sodiumBudget = Math.min(sodiumSpecs.length, Math.max(3, Math.floor(qProfile.maxAccentLights * 0.6)));
  for (let i = 0; i < sodiumBudget; i++) {
    const { x: sx, y: sy, z: sz, intensity: inten, mount } = sodiumSpecs[i];
    const pl = new THREE.PointLight(0xffa73b, inten, 34, 1.55);
    const outOffset = mount === 'wall-west' ? -0.6 : mount === 'wall-east' ? 0.6 : 0;
    pl.position.set(sx + outOffset, sy - 0.5, sz);
    sceneGroup.add(pl);
  }
  const blueBudget = Math.min(blueExitSpecs.length, Math.max(2, qProfile.maxAccentLights - sodiumBudget));
  const blueLights: Array<{ light: THREE.PointLight; phase: number }> = [];
  for (let i = 0; i < blueBudget; i++) {
    const { x: bx, y: by, z: bz } = blueExitSpecs[i];
    const bl = new THREE.PointLight(0x38bdf8, 8.5, 16, 1.75);
    bl.position.set(bx, by - 0.4, bz);
    sceneGroup.add(bl);
    blueLights.push({ light: bl, phase: i * 1.4 });
  }

  // Industrial Stencil Signage
  const signTex = trackTex(createStencilSignTexture('KORSAKOV HV-03', 'TURBINE HALL · 330kV', '#fbbf24', '#16202b', maxAniso));
  for (const [sz, ry] of [
    [-22.04, Math.PI],
    [22.04, 0],
  ] as Array<[number, number]>) {
    const plaque = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(4.2, 1.1)),
      trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
    );
    plaque.position.set(0, 5.1, sz);
    plaque.rotation.y = ry;
    sceneGroup.add(plaque);
  }

  // === 7. COMPLETE 2-LEVEL NAVGRAPH (Turbine Lanes, Corridors, Catwalks, Control Room, Outdoor Yards) ===
  const rawNodes: NavNode[] = [
    // Turbine Hall Ground Floor Aisles
    { id: 'h_n_c', position: [0, 0.08, -14.0], zoneId: 'default', neighbors: ['ny_c', 'h_lane_w', 'h_lane_e', 'h_n_w', 'h_n_e'] },
    { id: 'h_s_c', position: [0, 0.08, 14.0], zoneId: 'default', neighbors: ['sy_c', 'h_lane_w', 'h_lane_e', 'h_s_w', 'h_s_e'] },
    { id: 'h_lane_w', position: [-6.0, 0.08, 0], zoneId: 'default', neighbors: ['h_n_c', 'h_s_c', 'h_lane_fw'], isCover: true, coverNormal: [1, 0] },
    { id: 'h_lane_e', position: [6.0, 0.08, 0], zoneId: 'default', neighbors: ['h_n_c', 'h_s_c', 'h_lane_fe'], isCover: true, coverNormal: [-1, 0] },
    { id: 'h_lane_fw', position: [-18.0, 0.08, 0], zoneId: 'default', neighbors: ['h_lane_w', 'h_n_w', 'h_s_w', 'sw_w_c'], isCover: true, coverNormal: [1, 0] },
    { id: 'h_lane_fe', position: [18.0, 0.08, 0], zoneId: 'default', neighbors: ['h_lane_e', 'h_n_e', 'h_s_e', 'sw_e_c'], isCover: true, coverNormal: [-1, 0] },
    { id: 'h_n_w', position: [-18.0, 0.08, -14.0], zoneId: 'default', neighbors: ['h_n_c', 'h_lane_fw', 'sw_w_n'] },
    { id: 'h_n_e', position: [18.0, 0.08, -14.0], zoneId: 'default', neighbors: ['h_n_c', 'h_lane_fe', 'sw_e_n'] },
    { id: 'h_s_w', position: [-18.0, 0.08, 14.0], zoneId: 'default', neighbors: ['h_s_c', 'h_lane_fw', 'sw_w_s'] },
    { id: 'h_s_e', position: [18.0, 0.08, 14.0], zoneId: 'default', neighbors: ['h_s_c', 'h_lane_fe', 'sw_e_s'] },

    // Switchgear Side Corridors & Stair Bases
    { id: 'sw_w_n', position: [-26.6, 0.08, -20.0], zoneId: 'default', neighbors: ['h_n_w', 'ny_w', 'cat_w_mid'] },
    { id: 'sw_w_c', position: [-26.6, 0.08, 0], zoneId: 'default', neighbors: ['h_lane_fw', 'wy_c'] },
    { id: 'sw_w_s', position: [-26.6, 0.08, 20.0], zoneId: 'default', neighbors: ['h_s_w', 'sy_w', 'cat_w_mid'] },

    { id: 'sw_e_n', position: [26.6, 0.08, -20.0], zoneId: 'default', neighbors: ['h_n_e', 'ny_e', 'cat_e_mid'] },
    { id: 'sw_e_c', position: [26.6, 0.08, 0], zoneId: 'default', neighbors: ['h_lane_fe', 'ey_c'] },
    { id: 'sw_e_s', position: [26.6, 0.08, 20.0], zoneId: 'default', neighbors: ['h_s_e', 'sy_e', 'cat_e_mid'] },

    // Upper Catwalks & Switchgear Control Room (Y = 4.2m)
    { id: 'cat_w_mid', position: [-26.6, CAT_Y, 0], zoneId: 'default', neighbors: ['sw_w_n', 'sw_w_s', 'ctrl_n', 'cat_s'], isCover: true, coverNormal: [1, 0] },
    { id: 'cat_e_mid', position: [26.6, CAT_Y, 0], zoneId: 'default', neighbors: ['sw_e_n', 'sw_e_s', 'ctrl_n', 'cat_s'], isCover: true, coverNormal: [-1, 0] },
    { id: 'ctrl_n', position: [0, CAT_Y, -17.8], zoneId: 'default', neighbors: ['cat_w_mid', 'cat_e_mid'], isCover: true, coverNormal: [0, 1] },
    { id: 'cat_s', position: [0, CAT_Y, 17.8], zoneId: 'default', neighbors: ['cat_w_mid', 'cat_e_mid'], isCover: true, coverNormal: [0, -1] },

    // Outdoor Wet-Slate Transformer Yards
    { id: 'ny_c', position: [0, 0, -27.0], zoneId: 'default', neighbors: ['h_n_c', 'ny_w', 'ny_e'], isCover: true, coverNormal: [0, 1] },
    { id: 'ny_w', position: [-26.0, 0, -27.0], zoneId: 'default', neighbors: ['ny_c', 'sw_w_n', 'wy_c'] },
    { id: 'ny_e', position: [26.0, 0, -27.0], zoneId: 'default', neighbors: ['ny_c', 'sw_e_n', 'ey_c'] },

    { id: 'sy_c', position: [0, 0, 27.0], zoneId: 'default', neighbors: ['h_s_c', 'sy_w', 'sy_e'], isCover: true, coverNormal: [0, -1] },
    { id: 'sy_w', position: [-26.0, 0, 27.0], zoneId: 'default', neighbors: ['sy_c', 'sw_w_s', 'wy_c'] },
    { id: 'sy_e', position: [26.0, 0, 27.0], zoneId: 'default', neighbors: ['sy_c', 'sw_e_s', 'ey_c'] },

    { id: 'wy_c', position: [-39.0, 0, 0], zoneId: 'default', neighbors: ['sw_w_c', 'ny_w', 'sy_w'], isCover: true, coverNormal: [1, 0] },
    { id: 'ey_c', position: [39.0, 0, 0], zoneId: 'default', neighbors: ['sw_e_c', 'ny_e', 'sy_e'], isCover: true, coverNormal: [-1, 0] },
  ];

  const teamA: SpawnPoint[] = [
    { position: [0, 0, -37.5], yaw: Math.PI },
    { position: [-24, 0, -37.0], yaw: Math.PI * 0.85 },
    { position: [24, 0, -37.0], yaw: -Math.PI * 0.85 },
    { position: [-38, 0, -26.0], yaw: Math.PI * 0.7 },
    { position: [38, 0, -26.0], yaw: -Math.PI * 0.7 },
    { position: [0, CAT_Y, -18.5], yaw: Math.PI },
  ];
  const teamB: SpawnPoint[] = [
    { position: [0, 0, 37.5], yaw: 0 },
    { position: [-24, 0, 37.0], yaw: Math.PI * 0.15 },
    { position: [24, 0, 37.0], yaw: -Math.PI * 0.15 },
    { position: [-38, 0, 26.0], yaw: Math.PI * 0.3 },
    { position: [38, 0, 26.0], yaw: -Math.PI * 0.3 },
    { position: [0, CAT_Y, 18.5], yaw: 0 },
  ];
  const ffa: SpawnPoint[] = [
    ...teamA,
    ...teamB,
    { position: [-42, 0, 0], yaw: -Math.PI * 0.5 },
    { position: [42, 0, 0], yaw: Math.PI * 0.5 },
  ];

  // Yard crack weeds hugging outer concrete perimeter walls
  const weedSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < 42; i++) {
    const alongN = i % 2 === 0;
    const wx = alongN ? -46 + i * 2.2 : (i % 4 === 1 ? -49.2 : 49.2);
    const wz = alongN ? (i % 4 === 0 ? -41.2 : 41.2) : -38 + i * 1.8;
    weedSpots.push({
      x: wx,
      y: 0.01,
      z: wz,
      scale: 0.65 + (i % 3) * 0.22,
      yaw: i * 1.1,
      tint: new THREE.Color(0x526142),
    });
  }
  buildInstancedGrassTufts(propCtx, weedSpots);

  physics.setRaycastMeshes(raycastMeshes);

  const shatterBreakable = (
    objOrId: THREE.Object3D | string,
    impactPoint?: Readonly<THREE.Vector3>,
  ): { breakableId: string; impactPoint: THREE.Vector3 } | null => {
    const id =
      typeof objOrId === 'string'
        ? objOrId
        : (objOrId.userData?.breakableId as string | undefined);
    if (!id) return null;
    const rec = ctrlBreakables.get(id);
    if (!rec || rec.shattered) return null;
    rec.shattered = true;
    rec.mesh.userData.shattered = true;
    rec.mesh.visible = false;
    physics.disableBoxById(id);
    const idx = raycastMeshes.indexOf(rec.mesh);
    if (idx >= 0) raycastMeshes.splice(idx, 1);
    return {
      breakableId: id,
      impactPoint: impactPoint ? impactPoint.clone() : rec.center.clone(),
    };
  };

  // === PHYSICAL DESTRUCTIBLE SWITCHGEAR CORRIDOR DOORS ===
  const doorSystem = new DestructibleDoorSystem(sceneGroup, physics, isSoftwareGl);
  const K_DOOR_W = 1.18;
  const K_DOOR_H = 2.26;
  const K_CLEAR = K_DOOR_W + 0.1;
  const addSwitchDoorFrame = (ix: number, cz: number, openSpan: number): void => {
    const wallH = CAT_Y - 0.14;
    const sideW = Math.max(0.1, (openSpan - K_CLEAR) * 0.5);
    const transH = Math.max(0.1, wallH - (K_DOOR_H + 0.05));
    addSolidBox(ix, 0.08 + wallH * 0.5, cz - (K_CLEAR * 0.5 + sideW * 0.5), 0.4, wallH, sideW, matSlateWall, 'concrete');
    addSolidBox(ix, 0.08 + wallH * 0.5, cz + (K_CLEAR * 0.5 + sideW * 0.5), 0.4, wallH, sideW, matSlateWall, 'concrete');
    addSolidBox(ix, 0.08 + K_DOOR_H + 0.05 + transH * 0.5, cz, 0.4, transH, K_CLEAR, matDarkSteel, 'metal');
  };

  // West Switchgear North passage (x = -21.0, z = -7.25) & East Switchgear South passage (x = 21.0, z = +7.25)
  addSwitchDoorFrame(-21.0, -7.25, 4.5);
  doorSystem.addDoor({
    id: 'korsakov_west_switch_door',
    label: 'West Switchgear Door',
    hingePos: [-21.0, 0.08, -7.25 - K_DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: 1,
    width: K_DOOR_W,
    height: K_DOOR_H,
    style: 'tactical_reinforced',
  });

  addSwitchDoorFrame(21.0, 7.25, 4.5);
  doorSystem.addDoor({
    id: 'korsakov_east_switch_door',
    label: 'East Switchgear Door',
    hingePos: [21.0, 0.08, 7.25 - K_DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: -1,
    width: K_DOOR_W,
    height: K_DOOR_H,
    style: 'tactical_reinforced',
  });

  return {
    id: 'korsakov_substation',
    name: 'Korsakov Substation',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA,
      teamB,
      ffa,
      playerStart: teamA[0],
      zombieSpawners: [],
    },
    interactables: [],
    lightingPreset: LIGHTING_PRESET,
    supportsDynamicWeatherTime: true,
    envBindings: {
      windUniforms,
      wettableSurfaces,
    },
    doorSystem,
    shatterBreakable,
    update: (_dt, elapsedSec) => {
      for (const bl of blueLights) {
        bl.light.intensity = 7.8 + Math.sin(elapsedSec * 2.8 + bl.phase) * 0.8;
      }
    },
    dispose: () => {
      doorSystem.dispose();
      scene.remove(sceneGroup);
      envTex.dispose();
      ownedGeos.forEach((g) => g.dispose());
      ownedMats.forEach((m) => m.dispose());
      ownedTextures.forEach((t) => t.dispose());
      physics.clear();
    },
  };
}

export const KORSAKOV_SUBSTATION_MAP: IMapDefinition = {
  id: 'korsakov_substation',
  name: 'Korsakov Substation',
  subtitle: 'Industrial Hydro-Turbine & HV Yard',
  description:
    'Brutalist slate-concrete hydro-turbine complex illuminated by warm sodium-vapor floodlights and blue emergency exit fixtures, featuring 3 turbine bays, multi-tier steel catwalks, an elevated control room, and outdoor transformer yards.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Industrial Slate', '2-Tier Catwalks', 'Sodium & Blue'],
  accentHex: '#fb923c',
  previewStyle: 'korsakov_substation',
  build: buildKorsakovSubstation,
};

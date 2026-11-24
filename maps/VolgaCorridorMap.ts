import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { NightLightEntry, WettableSurfaceEntry } from '../engine/world/WeatherTimeSystem';
import {
  applyWindFoliageShader,
  assignHeightSwayAttribute,
  createWindShaderUniforms,
} from '../engine/world/WindFoliageShader';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  buildInstancedGrassTufts,
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCabinWoodTexture,
  createForestFloorTexture,
  createRustedMetalTexture,
} from './MapTextures';
import {
  buildNavGraph,
  BuiltMapInstance,
  IMapDefinition,
  MapBattleObjectives,
  MapLightingPreset,
  NavNode,
  SpawnPoint,
} from './types';

const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x9bb5ca,
  fogHex: 0x9db4c4,
  fogDensity: 0.0046,
  envIntensity: 0.62,
  hemiSkyHex: 0xc2d8ec,
  hemiGroundHex: 0x454f3c,
  hemiIntensity: 0.72,
  keyLightHex: 0xfff0d6,
  keyLightIntensity: 1.55,
  keyLightPos: [62, 84, 38],
};

function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Smooth continuous terrain heightfield for Volga Frontier Corridor (220m x 150m playable).
 * - Level highway corridor along Z in [-7, 7]
 * - Flat HQ compounds at West (X < -76) and East (X > 76)
 * - Raised tactical ridges at South FOB-A (-20, 38), North FOB-B (20, -38), and Central Outpost (0, -4)
 * - Natural rising perimeter hills outside playable bounds (zero floating walls)
 */
export function sampleVolgaTerrainY(x: number, z: number): number {
  // Base gentle steppe undulation
  let h =
    Math.sin(x * 0.026) * Math.cos(z * 0.032) * 1.15 +
    Math.sin(x * 0.055 + 0.8) * Math.sin(z * 0.048 - 0.5) * 0.45;

  // Flatten highway corridor & HQ aprons
  const hwyBlend = 1 - smoothstep(5.5, 16.0, Math.abs(z));
  const hqWestBlend = 1 - smoothstep(14.0, 26.0, Math.hypot(x + 92, z));
  const hqEastBlend = 1 - smoothstep(14.0, 26.0, Math.hypot(x - 92, z));
  const flatFactor = Math.max(hwyBlend, hqWestBlend, hqEastBlend);
  h *= 1 - flatFactor * 0.94;

  // Raised tactical plateau for South Ridge FOB-A (-20, 38)
  const fobADist = Math.hypot(x + 20, z - 38);
  const fobALift = (1 - smoothstep(12.0, 26.0, fobADist)) * 2.1;

  // Raised tactical plateau for North Timber FOB-B (20, -38)
  const fobBDist = Math.hypot(x - 20, z + 38);
  const fobBLift = (1 - smoothstep(12.0, 26.0, fobBDist)) * 2.0;

  // Slight tactical mound for Central Relay Outpost (0, -18) overlooking the highway
  const outDist = Math.hypot(x, z + 18);
  const outLift = (1 - smoothstep(10.0, 22.0, outDist)) * 1.65;

  // Natural perimeter ridge rising cleanly outside the 220m x 150m combat corridor
  const edgeX = smoothstep(106, 148, Math.abs(x));
  const edgeZ = smoothstep(72, 114, Math.abs(z));
  const perimeterRidge =
    Math.max(edgeX, edgeZ) *
    (11.5 + Math.sin(x * 0.09 + z * 0.07) * 3.2 + Math.cos(x * 0.05 - z * 0.11) * 2.4);

  return h + fobALift + fobBLift + outLift + perimeterRidge;
}

function createHescoTexture(aniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#9c8c6e';
  g.fillRect(0, 0, 256, 256);
  // Fabric weave + sand grain
  for (let i = 0; i < 650; i++) {
    const x = (i * 53) % 256;
    const y = (i * 97) % 256;
    g.fillStyle = i % 2 === 0 ? 'rgba(65, 56, 40, 0.16)' : 'rgba(210, 198, 172, 0.14)';
    g.fillRect(x, y, 4, 2);
  }
  // Welded steel mesh grid
  g.strokeStyle = 'rgba(42, 46, 48, 0.62)';
  g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  return tex;
}

function createBoomStripeTexture(aniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e5e7eb';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#b91c1c';
  for (let x = -32; x < 288; x += 48) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 24, 0);
    g.lineTo(x + 42, 64);
    g.lineTo(x + 18, 64);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = aniso;
  return tex;
}

function buildVolgaCorridor(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = -4;
  physics.boundsMinX = -108;
  physics.boundsMaxX = 108;
  physics.boundsMinZ = -73;
  physics.boundsMaxZ = 73;

  const sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const wettableSurfaces: WettableSurfaceEntry[] = [];
  const nightLights: NightLightEntry[] = [];
  const windUniforms = createWindShaderUniforms();

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

  const sunLight = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  sunLight.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl && qProfile.castShadows) {
    sunLight.castShadow = true;
    const sm = Math.min(2048, qProfile.shadowMapSize);
    sunLight.shadow.mapSize.set(sm, sm);
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 260;
    sunLight.shadow.camera.left = -115;
    sunLight.shadow.camera.right = 115;
    sunLight.shadow.camera.top = 90;
    sunLight.shadow.camera.bottom = -90;
    sunLight.shadow.bias = -0.0006;
    sunLight.shadow.normalBias = 0.04;
  }
  sceneGroup.add(sunLight);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  // Procedural PBR Materials
  const grassTex = trackTex(createForestFloorTexture(maxAniso, 28, 22));
  const roadTex = trackTex(createAsphaltRoadTexture(maxAniso, 24, 1, true, 4102));
  const crateTex = trackTex(createCabinWoodTexture(maxAniso, 2, 2));
  const rustTex = trackTex(createRustedMetalTexture(maxAniso, '#524036', 4104));
  const hescoTex = trackTex(createHescoTexture(maxAniso));
  const boomTex = trackTex(createBoomStripeTexture(maxAniso));

  const matTerrain = trackMat(
    new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.92, metalness: 0.02 }),
  );
  const matAsphalt = trackMat(
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.82, metalness: 0.05 }),
  );
  const matConcrete = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7b8084, roughness: 0.88, metalness: 0.05 }),
  );
  const matConcreteDark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x4e545a, roughness: 0.86, metalness: 0.08 }),
  );
  const matHesco = trackMat(
    new THREE.MeshStandardMaterial({ map: hescoTex, roughness: 0.9, metalness: 0.08 }),
  );
  const matSandbag = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x9b8d6b, roughness: 0.94, metalness: 0.02 }),
  );
  const matSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x38414a, roughness: 0.48, metalness: 0.72 }),
  );
  const matOliveSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x475443, roughness: 0.62, metalness: 0.36 }),
  );
  const matDesertTan = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x8a7d62, roughness: 0.75, metalness: 0.12 }),
  );
  const matCrate = trackMat(
    new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.84, metalness: 0.04 }),
  );
  const matRust = trackMat(
    new THREE.MeshStandardMaterial({ map: rustTex, roughness: 0.78, metalness: 0.38 }),
  );
  const matBoom = trackMat(
    new THREE.MeshStandardMaterial({ map: boomTex, roughness: 0.55, metalness: 0.25 }),
  );
  const matRock = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x5c605e, roughness: 0.93, metalness: 0.04 }),
  );
  const matBark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x433325, roughness: 0.92, metalness: 0.02 }),
  );
  const matPine = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2c422c, roughness: 0.85, metalness: 0.02 }),
  );
  const matLampBulb = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffdf9a,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.3,
      roughness: 0.25,
    }),
  );
  const matBeaconRed = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff5a5a,
      emissive: 0xef4444,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );

  applyWindFoliageShader(matPine, windUniforms, { swayScale: 0.24 });
  wettableSurfaces.push(
    { material: matAsphalt, baseRoughness: 0.82, baseEnvMapIntensity: 0.65 },
    { material: matConcrete, baseRoughness: 0.88, baseEnvMapIntensity: 0.55 },
    { material: matTerrain, baseRoughness: 0.92, baseEnvMapIntensity: 0.45 },
  );

  const propCtx: PropFactoryContext = {
    sceneGroup,
    physics,
    raycastMeshes,
    trackGeo,
    trackMat,
    isSoftwareGl,
    windUniforms,
  };

  const vehMats: VehicleMaterials = {
    body: matOliveSteel,
    rust: matRust,
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x1e2124, roughness: 0.92 })),
    rim: matSteel,
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.95 })),
    glass: trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x627c8c,
        roughness: 0.18,
        metalness: 0.25,
        transparent: true,
        opacity: 0.65,
      }),
    ),
    chrome: trackMat(new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.28, metalness: 0.85 })),
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
    castShadow = true,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(cx, cy, cz);
    m.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    m.castShadow = castShadow && !isSoftwareGl && qProfile.castShadows;
    m.userData.surfaceMaterial = surface;
    m.userData.analyticalRaycastCovered = true;
    sceneGroup.add(m);
    raycastMeshes.push(m);
    physics.addBox({
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minY: cy - h * 0.5,
      maxY: cy + h * 0.5,
      minZ: cz - d * 0.5,
      maxZ: cz + d * 0.5,
      surface,
      blocksMovement: true,
      blocksRaycast: true,
      meshRef: m,
    });
    return m;
  };

  // === 1. CONTINUOUS ROLLING TERRAIN MESH (310m x 230m) ===
  const terrainGeo = trackGeo(new THREE.PlaneGeometry(310, 230, 124, 92));
  terrainGeo.rotateX(-Math.PI * 0.5);
  const posAttr = terrainGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    posAttr.setY(i, sampleVolgaTerrainY(vx, vz));
  }
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(terrainGeo, matTerrain);
  terrainMesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  terrainMesh.userData.surfaceMaterial = 'grass';
  terrainMesh.userData.analyticalRaycastCovered = true;
  sceneGroup.add(terrainMesh);
  raycastMeshes.push(terrainMesh);
  physics.setTerrainHeightSampler(sampleVolgaTerrainY, {
    enableRaycast: true,
    surface: 'grass',
    terrainMesh,
  });

  // === 2. CENTRAL MILITARY HIGHWAY (East-West along Z = 0, X from -112 to +112) ===
  const roadGeo = trackGeo(new THREE.PlaneGeometry(224, 10.6, 56, 2));
  roadGeo.rotateX(-Math.PI * 0.5);
  const roadPos = roadGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < roadPos.count; i++) {
    const rx = roadPos.getX(i);
    const rz = roadPos.getZ(i);
    roadPos.setY(i, sampleVolgaTerrainY(rx, rz) + 0.045);
  }
  roadGeo.computeVertexNormals();
  const roadMesh = new THREE.Mesh(roadGeo, matAsphalt);
  roadMesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  roadMesh.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(roadMesh);
  raycastMeshes.push(roadMesh);

  // Helper to stamp a fortified Hesco wall segment on terrain
  const hescoBlocks: Array<{ x: number; y: number; z: number; rotY: number; sx: number; sy: number; sz: number }> = [];
  const addHescoWall = (
    cx: number,
    cz: number,
    len: number,
    height: number,
    thick: number,
    rotY = 0,
  ): void => {
    const ty = sampleVolgaTerrainY(cx, cz);
    hescoBlocks.push({
      x: cx,
      y: ty + height * 0.5 - 0.12,
      z: cz,
      rotY,
      sx: len,
      sy: height,
      sz: thick,
    });
    const hw = Math.abs(Math.cos(rotY)) * (len * 0.5) + Math.abs(Math.sin(rotY)) * (thick * 0.5);
    const hd = Math.abs(Math.sin(rotY)) * (len * 0.5) + Math.abs(Math.cos(rotY)) * (thick * 0.5);
    physics.addBox({
      minX: cx - hw,
      maxX: cx + hw,
      minY: ty - 0.5,
      maxY: ty + height - 0.12,
      minZ: cz - hd,
      maxZ: cz + hd,
      surface: 'concrete',
      blocksMovement: true,
      blocksRaycast: true,
    });
  };

  // === 3. OPPOSITE-SIDE PROTECTED TEAM HQs (Team A West, Team B East) ===
  const buildTeamHq = (team: 'A' | 'B', baseX: number): void => {
    const dir = team === 'A' ? 1 : -1; // faces toward center
    const groundY = sampleVolgaTerrainY(baseX, 0);

    // Concrete staging apron (24m x 32m)
    const apron = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(24, 0.16, 32)),
      matConcrete,
    );
    apron.position.set(baseX, groundY + 0.04, 0);
    apron.receiveShadow = true;
    apron.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(apron);
    raycastMeshes.push(apron);

    // Hesco perimeter walls with wide central highway gate (Z in [-6, 6]) and flank exits
    addHescoWall(baseX - dir * 12.2, 0, 1.8, 2.5, 32.0, 0); // Rear bastion
    addHescoWall(baseX, -16.2, 24.0, 2.4, 1.8, 0); // North bastion
    addHescoWall(baseX, 16.2, 24.0, 2.4, 1.8, 0); // South bastion
    addHescoWall(baseX + dir * 12.2, -11.5, 1.8, 2.4, 9.5, 0); // Front-North flank wall
    addHescoWall(baseX + dir * 12.2, 11.5, 1.8, 2.4, 9.5, 0); // Front-South flank wall

    // Armored Command Shelter + Cargo Container
    const shelterX = baseX - dir * 5.2;
    addSolidBox(shelterX, groundY + 1.65, -9.2, 7.2, 3.1, 5.2, matOliveSteel, 'metal');
    addSolidBox(shelterX, groundY + 1.4, 9.2, 6.2, 2.7, 2.6, matRust, 'metal');

    // Stencil HQ Sign
    const signTex = trackTex(
      createStencilSignTexture(
        team === 'A' ? 'ALPHA HQ · WEST BASE' : 'BRAVO HQ · EAST BASE',
        'PROTECTED DEPLOYMENT ZONE',
        team === 'A' ? '#38bdf8' : '#f87171',
        '#141a20',
        maxAniso,
      ),
    );
    const sign = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(4.8, 1.2)),
      trackMat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6 })),
    );
    sign.position.set(baseX + dir * 13.15, groundY + 1.75, -11.5);
    sign.rotation.y = team === 'A' ? Math.PI * 0.5 : -Math.PI * 0.5;
    sceneGroup.add(sign);

    // Floodlight pole
    const pole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.12, 0.18, 7.6, 8)), matSteel);
    pole.position.set(baseX + dir * 9.5, groundY + 3.8, -13.5);
    sceneGroup.add(pole);
    const bulb = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.7, 0.25, 0.4)), matLampBulb);
    bulb.position.set(baseX + dir * 9.5, groundY + 7.5, -13.5);
    sceneGroup.add(bulb);
    const pl = new THREE.PointLight(0xffdfb0, 0, 28, 1.6);
    pl.visible = false;
    pl.position.set(baseX + dir * 8.8, groundY + 7.2, -13.0);
    sceneGroup.add(pl);
    nightLights.push({ light: pl, baseLightIntensity: 18, emissiveMat: matLampBulb, baseEmissiveIntensity: 2.4 });
  };

  buildTeamHq('A', -92);
  buildTeamHq('B', 92);

  // === 4. TWO MILITARY ROAD CHECKPOINTS (CP-1 at X=-48, CP-2 at X=+48) ===
  const buildRoadCheckpoint = (cx: number, code: string, label: string): void => {
    const ty = sampleVolgaTerrainY(cx, 0);

    // Guardhouse bunker on north shoulder of highway (Z = -7.6)
    const gx = cx;
    const gz = -7.8;
    const gy = sampleVolgaTerrainY(gx, gz);
    addSolidBox(gx, gy + 1.45, gz - 1.5, 4.4, 2.9, 0.35, matConcreteDark, 'concrete');
    addSolidBox(gx - 2.05, gy + 1.45, gz, 0.35, 2.9, 3.2, matConcreteDark, 'concrete');
    addSolidBox(gx + 2.05, gy + 1.45, gz, 0.35, 2.9, 3.2, matConcreteDark, 'concrete');
    addSolidBox(gx, gy + 0.55, gz + 1.45, 4.4, 1.1, 0.32, matConcreteDark, 'concrete'); // viewing counter
    addSolidBox(gx, gy + 3.05, gz, 5.0, 0.32, 3.8, matSteel, 'metal');

    // Checkpoint stencil sign mounted on guardhouse roof fascia
    const cpSignTex = trackTex(
      createStencilSignTexture(`${code} · ${label.toUpperCase()}`, 'MILITARY ROAD CHECKPOINT', '#f59e0b', '#171c22', maxAniso),
    );
    const cpSign = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(3.8, 0.9)),
      trackMat(new THREE.MeshStandardMaterial({ map: cpSignTex, roughness: 0.62 })),
    );
    cpSign.position.set(gx, gy + 3.05, gz + 1.92);
    sceneGroup.add(cpSign);

    // Raised striped military boom gate spanning the highway (open enough for infantry sprinting under)
    const pivotPost = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 1.3, 0.45)), matSteel);
    pivotPost.position.set(cx, ty + 0.65, -5.6);
    sceneGroup.add(pivotPost);
    const boomBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.14, 9.4)), matBoom);
    boomBar.position.set(cx, ty + 2.35, -1.0);
    boomBar.rotation.x = 0.22; // angled up like a half-raised checkpoint arm
    sceneGroup.add(boomBar);

    // Staggered Concrete Jersey Barriers creating a realistic vehicle chicane & infantry fighting cover
    addSolidBox(cx - 5.5, ty + 0.55, -2.6, 1.1, 1.05, 4.4, matConcrete, 'concrete');
    addSolidBox(cx + 5.5, ty + 0.55, 2.6, 1.1, 1.05, 4.4, matConcrete, 'concrete');
    addSolidBox(cx - 2.4, ty + 0.55, 7.2, 4.8, 1.05, 1.0, matSandbag, 'gravel');
    addSolidBox(cx + 3.2, ty + 0.55, 7.2, 4.4, 1.05, 1.0, matSandbag, 'gravel');

    // Parked military vehicle on south shoulder
    buildRustedVehicle(propCtx, 'zil_truck', cx + (cx < 0 ? -7.8 : 7.8), sampleVolgaTerrainY(cx, 10.5), 10.5, cx < 0 ? 0.28 : -2.85, vehMats);

    // Checkpoint floodlight
    const lPole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.09, 0.13, 6.2, 7)), matSteel);
    lPole.position.set(cx, ty + 3.1, 6.2);
    sceneGroup.add(lPole);
    const pl = new THREE.PointLight(0xffd28a, 0, 22, 1.7);
    pl.visible = false;
    pl.position.set(cx, ty + 6.0, 4.0);
    sceneGroup.add(pl);
    nightLights.push({ light: pl, baseLightIntensity: 14 });
  };

  buildRoadCheckpoint(-48, 'CP-1', 'West Checkpoint');
  buildRoadCheckpoint(48, 'CP-2', 'East Checkpoint');

  // === 5. TWO FORTIFIED FORWARD OPERATING BASES (FOB-A South Ridge, FOB-B North Timber) ===
  const buildFob = (cx: number, cz: number, code: string, label: string, accentHex: string): void => {
    const ty = sampleVolgaTerrainY(cx, cz);

    // Concrete FOB pad
    const pad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(18, 0.18, 18)), matConcrete);
    pad.position.set(cx, ty + 0.05, cz);
    pad.receiveShadow = true;
    pad.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(pad);
    raycastMeshes.push(pad);

    // Four-corner Hesco bastions leaving wide tactical entrances on all 4 cardinal sides
    addHescoWall(cx - 6.2, cz - 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx + 6.2, cz - 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx - 6.2, cz + 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx + 6.2, cz + 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx - 9.0, cz - 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx - 9.0, cz + 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx + 9.0, cz - 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx + 9.0, cz + 6.2, 1.3, 2.0, 6.0, 0);

    // Open-ended tactical command shelter + supply crates
    addSolidBox(cx - 4.4, ty + 1.5, cz - 3.6, 5.2, 2.8, 3.6, matDesertTan, 'metal');
    addSolidBox(cx + 4.5, ty + 0.65, cz + 4.2, 2.6, 1.25, 1.8, matCrate, 'wood');
    addSolidBox(cx + 4.8, ty + 0.65, cz - 4.2, 1.8, 1.15, 2.6, matSandbag, 'gravel');

    // Comms antenna mast
    const mast = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.08, 0.14, 8.8, 8)), matSteel);
    mast.position.set(cx - 5.2, ty + 4.4, cz - 4.4);
    sceneGroup.add(mast);

    // FOB Stencil Sign
    const fobTex = trackTex(
      createStencilSignTexture(`${code} · ${label.toUpperCase()}`, 'FORWARD DEPLOYMENT BASE', accentHex, '#141a20', maxAniso),
    );
    const fobSign = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(3.4, 0.85)),
      trackMat(new THREE.MeshStandardMaterial({ map: fobTex, roughness: 0.6 })),
    );
    fobSign.position.set(cx - 4.4, ty + 2.35, cz - 1.78);
    sceneGroup.add(fobSign);

    const pl = new THREE.PointLight(0xffe0b2, 0, 22, 1.6);
    pl.visible = false;
    pl.position.set(cx, ty + 5.5, cz);
    sceneGroup.add(pl);
    nightLights.push({ light: pl, baseLightIntensity: 13 });
  };

  buildFob(-20, 38, 'FOB-A', 'South Ridge FOB', '#38bdf8');
  buildFob(20, -38, 'FOB-B', 'North Timber FOB', '#f97316');

  // === 6. CENTRAL HILLTOP RELAY OUTPOST (X = 0, Z = -18, high-value strategic anchor) ===
  const outX = 0;
  const outZ = -18;
  const outY = sampleVolgaTerrainY(outX, outZ);
  const outPad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20, 0.22, 16)), matConcreteDark);
  outPad.position.set(outX, outY + 0.06, outZ);
  outPad.receiveShadow = true;
  outPad.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(outPad);
  raycastMeshes.push(outPad);

  // Enterable open-breezeway concrete relay bunker with wide E/W/S fighting apertures
  addSolidBox(outX, outY + 1.75, outZ - 5.2, 10.6, 3.4, 0.45, matConcreteDark, 'concrete');
  addSolidBox(outX - 5.2, outY + 1.75, outZ - 2.6, 0.45, 3.4, 5.2, matConcreteDark, 'concrete');
  addSolidBox(outX + 5.2, outY + 1.75, outZ - 2.6, 0.45, 3.4, 5.2, matConcreteDark, 'concrete');
  addSolidBox(outX, outY + 3.55, outZ - 2.6, 11.4, 0.34, 6.2, matSteel, 'metal');
  // Low sandbag firing line facing south toward the highway
  addSolidBox(outX - 4.0, outY + 0.6, outZ + 5.4, 4.4, 1.1, 1.0, matSandbag, 'gravel');
  addSolidBox(outX + 4.0, outY + 0.6, outZ + 5.4, 4.4, 1.1, 1.0, matSandbag, 'gravel');
  // Tall comms relay lattice tower with blinking aviation beacon
  const tower = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.42, 13.5, 6)), matSteel);
  tower.position.set(outX, outY + 10.3, outZ - 3.0);
  sceneGroup.add(tower);
  const relayBeacon = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.24, 10, 8)), matBeaconRed);
  relayBeacon.position.set(outX, outY + 17.2, outZ - 3.0);
  sceneGroup.add(relayBeacon);
  const outSignTex = trackTex(
    createStencilSignTexture('OUTPOST · RELAY HILL', 'HIGH-VALUE SECTOR', '#fbbf24', '#161b22', maxAniso),
  );
  const outSign = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(4.0, 0.95)),
    trackMat(new THREE.MeshStandardMaterial({ map: outSignTex, roughness: 0.6 })),
  );
  outSign.position.set(outX, outY + 3.55, outZ + 0.56);
  sceneGroup.add(outSign);

  // Additional mid-highway tactical cover (sandbags & cargo crates along flanks)
  const fieldCoverSpecs: Array<[number, number, number, number, number, 'concrete' | 'wood' | 'gravel']> = [
    [-22, 6.4, 3.6, 1.1, 1.1, 'gravel'],
    [22, -6.4, 3.6, 1.1, 1.1, 'gravel'],
    [0, 8.2, 4.2, 1.15, 1.2, 'concrete'],
    [-68, -14, 3.2, 1.3, 1.8, 'wood'],
    [68, 14, 3.2, 1.3, 1.8, 'wood'],
    [-36, 22, 3.8, 1.15, 1.1, 'gravel'],
    [36, -22, 3.8, 1.15, 1.1, 'gravel'],
    [-12, -36, 3.6, 1.25, 1.5, 'wood'],
    [12, 36, 3.6, 1.25, 1.5, 'wood'],
  ];
  for (const [fx, fz, fw, fh, fd, surf] of fieldCoverSpecs) {
    const fy = sampleVolgaTerrainY(fx, fz) + fh * 0.5;
    addSolidBox(
      fx,
      fy,
      fz,
      fw,
      fh,
      fd,
      surf === 'wood' ? matCrate : surf === 'gravel' ? matSandbag : matConcrete,
      surf,
    );
  }

  // Batch all Hesco blocks into a single InstancedMesh for maximum draw-call efficiency
  const dummy = new THREE.Object3D();
  const hescoGeo = trackGeo(new THREE.BoxGeometry(1, 1, 1));
  const hescoInst = new THREE.InstancedMesh(hescoGeo, matHesco, hescoBlocks.length);
  hescoInst.castShadow = !isSoftwareGl && qProfile.castShadows;
  hescoInst.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  hescoBlocks.forEach((b, i) => {
    dummy.position.set(b.x, b.y, b.z);
    dummy.rotation.set(0, b.rotY, 0);
    dummy.scale.set(b.sx, b.sy, b.sz);
    dummy.updateMatrix();
    hescoInst.setMatrixAt(i, dummy.matrix);
  });
  hescoInst.instanceMatrix.needsUpdate = true;
  hescoInst.computeBoundingSphere();
  hescoInst.userData.surfaceMaterial = 'concrete';
  hescoInst.userData.analyticalRaycastCovered = true;
  sceneGroup.add(hescoInst);
  raycastMeshes.push(hescoInst);

  // === 7. INSTANCED PINE FOREST, PERIMETER BOULDERS & GRASS TUFTS ===
  const rand = seededRand(88047);
  const isClear = (tx: number, tz: number): boolean => {
    // Keep central highway clear
    if (Math.abs(tz) < 11.5 && Math.abs(tx) < 116) return false;
    // Keep West & East HQs clear
    if (Math.abs(tx + 92) < 18 && Math.abs(tz) < 22) return false;
    if (Math.abs(tx - 92) < 18 && Math.abs(tz) < 22) return false;
    // Keep FOBs, Outpost & Checkpoints clear
    if (Math.hypot(tx + 48, tz) < 15) return false;
    if (Math.hypot(tx - 48, tz) < 15) return false;
    if (Math.hypot(tx + 20, tz - 38) < 16) return false;
    if (Math.hypot(tx - 20, tz + 38) < 16) return false;
    if (Math.hypot(tx, tz + 18) < 15) return false;
    return true;
  };

  const targetTrees = Math.max(110, Math.round(280 * qProfile.foliageDensity));
  const treeSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let attempt = 0; attempt < 2200 && treeSpots.length < targetTrees; attempt++) {
    const tx = (rand() - 0.5) * 280;
    const tz = (rand() - 0.5) * 204;
    if (!isClear(tx, tz)) continue;
    // Slightly denser around natural perimeter ridges
    const nearEdge = Math.abs(tx) > 96 || Math.abs(tz) > 62;
    const minDistSq = nearEdge ? 18 : 34;
    if (treeSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < minDistSq)) continue;
    const ty = sampleVolgaTerrainY(tx, tz);
    const scale = 0.88 + rand() * 0.65;
    const tint = new THREE.Color().setHSL(0.29 + (rand() - 0.5) * 0.05, 0.3 + rand() * 0.14, 0.19 + rand() * 0.09);
    treeSpots.push({ x: tx, y: ty, z: tz, scale, yaw: rand() * Math.PI * 2, tint });
  }

  const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.34, 3.6, 7, 2));
  trunkGeo.translate(0, 1.8, 0);
  assignHeightSwayAttribute(trunkGeo, 0, 3.6, 1.8);
  const t1Geo = trackGeo(new THREE.ConeGeometry(2.45, 4.5, 8, 2));
  t1Geo.translate(0, 4.4, 0);
  assignHeightSwayAttribute(t1Geo, 0.8, 10.4, 1.4);
  const t2Geo = trackGeo(new THREE.ConeGeometry(1.75, 3.7, 8, 2));
  t2Geo.translate(0, 7.1, 0);
  assignHeightSwayAttribute(t2Geo, 0.8, 10.4, 1.4);

  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBark, treeSpots.length);
  const tier1Inst = new THREE.InstancedMesh(t1Geo, matPine, treeSpots.length);
  const tier2Inst = new THREE.InstancedMesh(t2Geo, matPine, treeSpots.length);
  trunkInst.castShadow = !isSoftwareGl && qProfile.castShadows;
  tier1Inst.castShadow = !isSoftwareGl && qProfile.castShadows;

  treeSpots.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.15, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    tier1Inst.setMatrixAt(i, dummy.matrix);
    tier2Inst.setMatrixAt(i, dummy.matrix);
    tier1Inst.setColorAt(i, t.tint);
    tier2Inst.setColorAt(i, t.tint.clone().offsetHSL(0, 0, 0.03));

    if (Math.abs(t.x) <= 106 && Math.abs(t.z) <= 72) {
      const r = 0.34 * t.scale;
      physics.addBox({
        minX: t.x - r,
        maxX: t.x + r,
        minY: t.y,
        maxY: t.y + 4.0,
        minZ: t.z - r,
        maxZ: t.z + r,
        surface: 'wood',
        blocksMovement: true,
        blocksRaycast: true,
        meshRef: trunkInst,
      });
    }
  });
  for (const inst of [trunkInst, tier1Inst, tier2Inst]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(inst);
  }
  trunkInst.userData.analyticalRaycastCovered = true;
  raycastMeshes.push(trunkInst);

  // Instanced Boulders (tactical hillside cover + natural perimeter rock shelves)
  const rockGeo = trackGeo(new THREE.DodecahedronGeometry(1.15, 1));
  const rockSpots: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number }> = [];
  for (let i = 0; i < 68; i++) {
    const rx = (rand() - 0.5) * 236;
    const rz = (rand() - 0.5) * 164;
    if (!isClear(rx, rz)) continue;
    const ry = sampleVolgaTerrainY(rx, rz);
    const s = 0.9 + rand() * 1.45;
    rockSpots.push({ x: rx, y: ry + s * 0.35, z: rz, sx: s * 1.2, sy: s * 0.85, sz: s, yaw: rand() * Math.PI * 2 });
  }
  const rockInst = new THREE.InstancedMesh(rockGeo, matRock, rockSpots.length);
  rockInst.castShadow = !isSoftwareGl && qProfile.castShadows;
  rockInst.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  rockSpots.forEach((r, i) => {
    dummy.position.set(r.x, r.y, r.z);
    dummy.rotation.set(rand() * 0.3, r.yaw, rand() * 0.3);
    dummy.scale.set(r.sx, r.sy, r.sz);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
    if (Math.abs(r.x) <= 106 && Math.abs(r.z) <= 72) {
      physics.addBox({
        minX: r.x - r.sx * 0.85,
        maxX: r.x + r.sx * 0.85,
        minY: r.y - r.sy,
        maxY: r.y + r.sy * 0.78,
        minZ: r.z - r.sz * 0.85,
        maxZ: r.z + r.sz * 0.85,
        surface: 'concrete',
        blocksMovement: true,
        blocksRaycast: true,
        meshRef: rockInst,
      });
    }
  });
  rockInst.instanceMatrix.needsUpdate = true;
  rockInst.computeBoundingSphere();
  rockInst.userData.surfaceMaterial = 'concrete';
  rockInst.userData.analyticalRaycastCovered = true;
  sceneGroup.add(rockInst);
  raycastMeshes.push(rockInst);

  // Wind-swayed grass tufts
  const grassCount = Math.max(140, Math.round(420 * qProfile.foliageDensity));
  const grassSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < grassCount * 2 && grassSpots.length < grassCount; i++) {
    const gx = (rand() - 0.5) * 210;
    const gz = (rand() - 0.5) * 140;
    if (!isClear(gx, gz)) continue;
    grassSpots.push({
      x: gx,
      y: sampleVolgaTerrainY(gx, gz),
      z: gz,
      scale: 0.75 + rand() * 0.7,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.24 + (rand() - 0.5) * 0.06, 0.32, 0.42 + rand() * 0.16),
    });
  }
  buildInstancedGrassTufts(propCtx, grassSpots);

  // === 8. MULTI-LANE TACTICAL NAVGRAPH ===
  const nodeAt = (
    id: string,
    x: number,
    z: number,
    neighbors: string[],
    isCover = false,
  ): NavNode => ({
    id,
    position: [x, sampleVolgaTerrainY(x, z) + 0.08, z],
    zoneId: 'default',
    neighbors,
    isCover,
  });

  const rawNodes: NavNode[] = [
    // West HQ & Approaches
    nodeAt('hqa_c', -90, 0, ['hqa_n', 'hqa_s', 'hwy_w1']),
    nodeAt('hqa_n', -82, -14, ['hqa_c', 'flank_nw']),
    nodeAt('hqa_s', -82, 14, ['hqa_c', 'flank_sw']),
    nodeAt('hwy_w1', -70, 0, ['hqa_c', 'cp1_c', 'flank_nw', 'flank_sw']),

    // CP-1 West Highway Checkpoint
    nodeAt('cp1_c', -48, 0, ['hwy_w1', 'hwy_mid_w', 'flank_nw', 'flank_sw'], true),
    nodeAt('flank_nw', -54, -26, ['hqa_n', 'hwy_w1', 'cp1_c', 'mid_nw', 'out_w']),
    nodeAt('flank_sw', -54, 26, ['hqa_s', 'hwy_w1', 'cp1_c', 'foba_w']),

    // Central Highway & Outpost
    nodeAt('hwy_mid_w', -24, 0, ['cp1_c', 'hwy_c', 'out_s', 'foba_n'], true),
    nodeAt('hwy_c', 0, 0, ['hwy_mid_w', 'hwy_mid_e', 'out_s', 'mid_s'], true),
    nodeAt('hwy_mid_e', 24, 0, ['hwy_c', 'cp2_c', 'out_s', 'fobb_s'], true),

    // Outpost Relay Hill (0, -18)
    nodeAt('out_c', 0, -16, ['out_s', 'out_w', 'out_e', 'mid_nw', 'fobb_w'], true),
    nodeAt('out_s', 0, -8, ['out_c', 'hwy_c', 'hwy_mid_w', 'hwy_mid_e']),
    nodeAt('out_w', -18, -18, ['out_c', 'flank_nw', 'mid_nw']),
    nodeAt('out_e', 18, -18, ['out_c', 'fobb_s', 'fobb_w']),
    nodeAt('mid_nw', -26, -34, ['flank_nw', 'out_w', 'out_c', 'fobb_w']),

    // South Ridge FOB-A (-20, 38)
    nodeAt('foba_c', -20, 38, ['foba_w', 'foba_n', 'foba_e'], true),
    nodeAt('foba_w', -34, 34, ['foba_c', 'flank_sw']),
    nodeAt('foba_n', -20, 22, ['foba_c', 'hwy_mid_w', 'mid_s']),
    nodeAt('foba_e', -2, 34, ['foba_c', 'mid_s', 'flank_se']),
    nodeAt('mid_s', 6, 22, ['hwy_c', 'foba_n', 'foba_e', 'flank_se']),

    // North Timber FOB-B (20, -38)
    nodeAt('fobb_c', 20, -38, ['fobb_w', 'fobb_s', 'fobb_e'], true),
    nodeAt('fobb_w', 2, -34, ['fobb_c', 'mid_nw', 'out_c', 'out_e']),
    nodeAt('fobb_s', 20, -22, ['fobb_c', 'hwy_mid_e', 'out_e']),
    nodeAt('fobb_e', 36, -32, ['fobb_c', 'flank_ne']),

    // CP-2 East Highway Checkpoint & East HQ
    nodeAt('cp2_c', 48, 0, ['hwy_mid_e', 'hwy_e1', 'flank_ne', 'flank_se'], true),
    nodeAt('flank_ne', 54, -26, ['fobb_e', 'cp2_c', 'hwy_e1', 'hqb_n']),
    nodeAt('flank_se', 54, 26, ['foba_e', 'mid_s', 'cp2_c', 'hwy_e1', 'hqb_s']),
    nodeAt('hwy_e1', 70, 0, ['cp2_c', 'flank_ne', 'flank_se', 'hqb_c']),
    nodeAt('hqb_c', 90, 0, ['hwy_e1', 'hqb_n', 'hqb_s']),
    nodeAt('hqb_n', 82, -14, ['hqb_c', 'flank_ne']),
    nodeAt('hqb_s', 82, 14, ['hqb_c', 'flank_se']),
  ];

  // === 9. SPAWNS & BATTLE OBJECTIVE LAYOUT ===
  const sp = (x: number, z: number, yaw: number): SpawnPoint => ({
    position: [x, sampleVolgaTerrainY(x, z) + 0.1, z],
    yaw,
  });

  const hqASpawns: SpawnPoint[] = [
    sp(-90, 0, -Math.PI * 0.5),
    sp(-94, -5.5, -Math.PI * 0.5),
    sp(-94, 5.5, -Math.PI * 0.5),
    sp(-86, -10.5, -Math.PI * 0.45),
    sp(-86, 10.5, -Math.PI * 0.55),
    sp(-98, 0, -Math.PI * 0.5),
  ];
  const hqBSpawns: SpawnPoint[] = [
    sp(90, 0, Math.PI * 0.5),
    sp(94, -5.5, Math.PI * 0.5),
    sp(94, 5.5, Math.PI * 0.5),
    sp(86, -10.5, Math.PI * 0.55),
    sp(86, 10.5, Math.PI * 0.45),
    sp(98, 0, Math.PI * 0.5),
  ];

  const battleObjectives: MapBattleObjectives = {
    hqA: {
      id: 'hq_a',
      team: 'A',
      label: 'Alpha HQ (West)',
      position: [-92, sampleVolgaTerrainY(-92, 0), 0],
      safeRadiusM: 18,
      spawnPoints: hqASpawns,
    },
    hqB: {
      id: 'hq_b',
      team: 'B',
      label: 'Bravo HQ (East)',
      position: [92, sampleVolgaTerrainY(92, 0), 0],
      safeRadiusM: 18,
      spawnPoints: hqBSpawns,
    },
    conquestPois: [
      {
        id: 'poi_cp1',
        code: 'CP-1',
        label: 'West Highway Checkpoint',
        kind: 'checkpoint',
        position: [-48, sampleVolgaTerrainY(-48, 0), 0],
        captureRadiusM: 9.5,
        territoryWeight: 1.0,
        initialOwner: null,
        hasBuiltInProps: true,
        roadYaw: 0,
      },
      {
        id: 'poi_fob_a',
        code: 'FOB-A',
        label: 'South Ridge FOB',
        kind: 'fob',
        position: [-20, sampleVolgaTerrainY(-20, 38), 38],
        captureRadiusM: 10.0,
        territoryWeight: 1.35,
        initialOwner: null,
        hasBuiltInProps: true,
        spawnPoints: [
          sp(-20, 34, Math.PI),
          sp(-15.5, 38, -Math.PI * 0.5),
          sp(-24.5, 41, Math.PI * 0.5),
          sp(-17, 43, Math.PI),
        ],
      },
      {
        id: 'poi_outpost',
        code: 'OUTPOST',
        label: 'Relay Hill Outpost',
        kind: 'outpost',
        position: [0, sampleVolgaTerrainY(0, -18), -18],
        captureRadiusM: 10.5,
        territoryWeight: 1.75,
        initialOwner: null,
        hasBuiltInProps: true,
      },
      {
        id: 'poi_fob_b',
        code: 'FOB-B',
        label: 'North Timber FOB',
        kind: 'fob',
        position: [20, sampleVolgaTerrainY(20, -38), -38],
        captureRadiusM: 10.0,
        territoryWeight: 1.35,
        initialOwner: null,
        hasBuiltInProps: true,
        spawnPoints: [
          sp(20, -34, 0),
          sp(15.5, -38, Math.PI * 0.5),
          sp(24.5, -41, -Math.PI * 0.5),
          sp(17, -43, 0),
        ],
      },
      {
        id: 'poi_cp2',
        code: 'CP-2',
        label: 'East Highway Checkpoint',
        kind: 'checkpoint',
        position: [48, sampleVolgaTerrainY(48, 0), 0],
        captureRadiusM: 9.5,
        territoryWeight: 1.0,
        initialOwner: null,
        hasBuiltInProps: true,
        roadYaw: 0,
      },
    ],
    ctfFlags: [
      {
        team: 'A',
        label: 'Alpha Base Flag',
        position: [-78, sampleVolgaTerrainY(-78, 0), 0],
      },
      {
        team: 'B',
        label: 'Bravo Base Flag',
        position: [78, sampleVolgaTerrainY(78, 0), 0],
      },
    ],
    kothHills: [
      { id: 'hill_outpost', label: 'Relay Hill Outpost', position: [0, sampleVolgaTerrainY(0, -18), -18], radiusM: 9.5 },
      { id: 'hill_cp1', label: 'West Highway Checkpoint', position: [-48, sampleVolgaTerrainY(-48, 0), 0], radiusM: 9.0 },
      { id: 'hill_fob_a', label: 'South Ridge FOB', position: [-20, sampleVolgaTerrainY(-20, 38), 38], radiusM: 9.5 },
      { id: 'hill_cp2', label: 'East Highway Checkpoint', position: [48, sampleVolgaTerrainY(48, 0), 0], radiusM: 9.0 },
      { id: 'hill_fob_b', label: 'North Timber FOB', position: [20, sampleVolgaTerrainY(20, -38), -38], radiusM: 9.5 },
    ],
  };

  const ffaSpawns: SpawnPoint[] = [
    ...hqASpawns.slice(0, 3),
    ...hqBSpawns.slice(0, 3),
    sp(-48, 8, Math.PI),
    sp(48, -8, 0),
    sp(-20, 38, Math.PI),
    sp(20, -38, 0),
    sp(0, -10, 0),
    sp(0, 22, Math.PI),
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'volga_corridor',
    name: 'Volga Frontier Corridor',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA: hqASpawns,
      teamB: hqBSpawns,
      ffa: ffaSpawns,
      playerStart: hqASpawns[0],
      zombieSpawners: [],
    },
    battleObjectives,
    terrainHeightAt: sampleVolgaTerrainY,
    interactables: [],
    lightingPreset: LIGHTING_PRESET,
    supportsDynamicWeatherTime: true,
    envBindings: {
      windUniforms,
      wettableSurfaces,
      nightLights,
    },
    update: (_dt, elapsedSec) => {
      matBeaconRed.emissiveIntensity = Math.sin(elapsedSec * 3.8) > 0.2 ? 3.2 : 0.35;
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

export const VOLGA_CORRIDOR_MAP: IMapDefinition = {
  id: 'volga_corridor',
  name: 'Volga Frontier Corridor',
  subtitle: 'Large-Scale Conquest Battlefield',
  description:
    'Expansive 220m alpine military highway corridor featuring protected opposite-side Team HQs, two fortified FOBs, military road checkpoints, and a central hilltop relay outpost.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Conquest Scale', 'Highway Checkpoints', 'Fortified FOBs'],
  accentHex: '#22c55e',
  previewStyle: 'volga_corridor',
  build: buildVolgaCorridor,
};

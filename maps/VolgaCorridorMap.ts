import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { NightLightEntry, WettableSurfaceEntry } from '../engine/world/WeatherTimeSystem';
import { createWindShaderUniforms } from '../engine/world/WindFoliageShader';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  buildEnterableCoverBuilding,
  CoverBuildingMaterialPack,
  CoverBuildingPreset,
  createCoverBuildingMaterialPack,
} from './CoverBuildingFactory';
import {
  BoulderSpot,
  buildInstancedBirchTrees,
  buildInstancedGrassTufts,
  buildInstancedPineTrees,
  buildInstancedSculptedBoulders,
  buildRustedVehicle,
  PineTreeSpot,
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
  MapBuildOptions,
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
export function sampleVolgaTerrainY(x: number, z: number, expanded = false): number {
  // Base gentle steppe undulation
  let h =
    Math.sin(x * 0.026) * Math.cos(z * 0.032) * 1.15 +
    Math.sin(x * 0.055 + 0.8) * Math.sin(z * 0.048 - 0.5) * 0.45;

  const hqX = expanded ? 148 : 92;

  // Flatten highway corridor & HQ aprons (+ North/South supply roads in expanded Conquest)
  const hwyBlend = 1 - smoothstep(5.5, 16.0, Math.abs(z));
  const hqWestBlend = 1 - smoothstep(15.0, 28.0, Math.hypot(x + hqX, z));
  const hqEastBlend = 1 - smoothstep(15.0, 28.0, Math.hypot(x - hqX, z));
  let flatFactor = Math.max(hwyBlend, hqWestBlend, hqEastBlend);

  if (expanded) {
    const northRoadBlend =
      Math.abs(x) < 126 ? 1 - smoothstep(4.2, 11.5, Math.abs(z + 56)) : 0;
    const southRoadBlend =
      Math.abs(x) < 126 ? 1 - smoothstep(4.2, 11.5, Math.abs(z - 56)) : 0;
    const fobCBlend = 1 - smoothstep(10.0, 20.0, Math.hypot(x + 84, z + 56));
    const fobDBlend = 1 - smoothstep(10.0, 20.0, Math.hypot(x - 84, z - 56));
    flatFactor = Math.max(flatFactor, northRoadBlend * 0.85, southRoadBlend * 0.85, fobCBlend, fobDBlend);
  }
  h *= 1 - flatFactor * 0.94;

  // Raised tactical plateaus for inner FOBs & Relay Outpost
  const fobAX = expanded ? -38 : -20;
  const fobBX = expanded ? 38 : 20;
  const fobADist = Math.hypot(x - fobAX, z - 38);
  const fobALift = (1 - smoothstep(12.0, 26.0, fobADist)) * 2.1;

  const fobBDist = Math.hypot(x - fobBX, z + 38);
  const fobBLift = (1 - smoothstep(12.0, 26.0, fobBDist)) * 2.0;

  const outDist = Math.hypot(x, z + 18);
  const outLift = (1 - smoothstep(10.0, 22.0, outDist)) * 1.65;

  // Natural perimeter ridge rising cleanly outside combat bounds
  const edgeX0 = expanded ? 168 : 106;
  const edgeX1 = expanded ? 214 : 148;
  const edgeZ0 = expanded ? 103 : 72;
  const edgeZ1 = expanded ? 148 : 114;
  const edgeX = smoothstep(edgeX0, edgeX1, Math.abs(x));
  const edgeZ = smoothstep(edgeZ0, edgeZ1, Math.abs(z));
  const perimeterRidge =
    Math.max(edgeX, edgeZ) *
    (12.5 + Math.sin(x * 0.08 + z * 0.065) * 3.4 + Math.cos(x * 0.045 - z * 0.1) * 2.5);

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
  options?: MapBuildOptions,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);
  const isConquest = options?.battleRule === 'conquest';
  const sampleY = (x: number, z: number): number => sampleVolgaTerrainY(x, z, isConquest);

  const boundX = isConquest ? 170 : 108;
  const boundZ = isConquest ? 105 : 73;
  const hqX = isConquest ? 148 : 92;

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = -4;
  physics.boundsMinX = -boundX;
  physics.boundsMaxX = boundX;
  physics.boundsMinZ = -boundZ;
  physics.boundsMaxZ = boundZ;

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
    LIGHTING_PRESET.fogDensity * (isConquest ? 0.74 : 1.0) * qProfile.fogDensityScale,
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
    sunLight.shadow.camera.far = isConquest ? 360 : 260;
    const scX = isConquest ? 172 : 115;
    const scZ = isConquest ? 128 : 90;
    sunLight.shadow.camera.left = -scX;
    sunLight.shadow.camera.right = scX;
    sunLight.shadow.camera.top = scZ;
    sunLight.shadow.camera.bottom = -scZ;
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
    trackTex,
    isSoftwareGl,
    windUniforms,
    maxAniso,
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

  // === 1. CONTINUOUS ROLLING TERRAIN MESH (310x230m classic; 440x310m expanded Conquest) ===
  const terrW = isConquest ? 440 : 310;
  const terrD = isConquest ? 310 : 230;
  const terrSegX = isConquest ? 132 : 124;
  const terrSegZ = isConquest ? 96 : 92;
  const terrainGeo = trackGeo(new THREE.PlaneGeometry(terrW, terrD, terrSegX, terrSegZ));
  terrainGeo.rotateX(-Math.PI * 0.5);
  const posAttr = terrainGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    posAttr.setY(i, sampleY(vx, vz));
  }
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(terrainGeo, matTerrain);
  terrainMesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  terrainMesh.userData.surfaceMaterial = 'grass';
  terrainMesh.userData.analyticalRaycastCovered = true;
  sceneGroup.add(terrainMesh);
  raycastMeshes.push(terrainMesh);
  physics.setTerrainHeightSampler(sampleY, {
    enableRaycast: true,
    surface: 'grass',
    terrainMesh,
  });

  // Helper to drape an asphalt road ribbon smoothly over the heightfield
  const addDrapeRoad = (
    cx: number,
    cz: number,
    length: number,
    width: number,
    axis: 'x' | 'z',
    segs = 48,
    yLift = 0.045,
  ): void => {
    const rw = axis === 'x' ? length : width;
    const rd = axis === 'x' ? width : length;
    const g = trackGeo(new THREE.PlaneGeometry(rw, rd, axis === 'x' ? segs : 2, axis === 'z' ? segs : 2));
    g.rotateX(-Math.PI * 0.5);
    const pa = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      const wx = cx + pa.getX(i);
      const wz = cz + pa.getZ(i);
      pa.setXYZ(i, wx, sampleY(wx, wz) + yLift, wz);
    }
    g.computeVertexNormals();
    const rm = new THREE.Mesh(g, matAsphalt);
    rm.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    rm.userData.surfaceMaterial = 'concrete';
    rm.userData.analyticalRaycastCovered = true;
    sceneGroup.add(rm);
    raycastMeshes.push(rm);
  };

  // === 2. ROAD NETWORK (Main Highway + North Service Loop & South Supply Road in Conquest) ===
  addDrapeRoad(0, 0, isConquest ? 344 : 224, 10.6, 'x', isConquest ? 72 : 56, 0.045);
  if (isConquest) {
    // North Service Loop Road (Z = -56) & South Timber Supply Road (Z = +56)
    addDrapeRoad(0, -56, 246, 7.6, 'x', 54, 0.055);
    addDrapeRoad(0, 56, 246, 7.6, 'x', 54, 0.055);
    // North-South cross-connector spurs joining highway to service loops & flanks
    for (const spurX of [-118, -48, 48, 118]) {
      addDrapeRoad(spurX, -28, 56, 6.4, 'z', 18, 0.05);
      addDrapeRoad(spurX, 28, 56, 6.4, 'z', 18, 0.05);
    }
  }

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
    const ty = sampleY(cx, cz);
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

  // === 3. OPPOSITE-SIDE PROTECTED TEAM HQs (Spread to ±148m in Conquest; ±92m classic) ===
  const buildTeamHq = (team: 'A' | 'B', baseX: number): void => {
    const dir = team === 'A' ? 1 : -1;
    const groundY = sampleY(baseX, 0);

    const apron = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(24, 0.16, 32)),
      matConcrete,
    );
    apron.position.set(baseX, groundY + 0.04, 0);
    apron.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    apron.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(apron);
    raycastMeshes.push(apron);

    addHescoWall(baseX - dir * 12.2, 0, 1.8, 2.5, 32.0, 0);
    addHescoWall(baseX, -16.2, 24.0, 2.4, 1.8, 0);
    addHescoWall(baseX, 16.2, 24.0, 2.4, 1.8, 0);
    addHescoWall(baseX + dir * 12.2, -11.5, 1.8, 2.4, 9.5, 0);
    addHescoWall(baseX + dir * 12.2, 11.5, 1.8, 2.4, 9.5, 0);

    const shelterX = baseX - dir * 5.2;
    addSolidBox(shelterX, groundY + 1.65, -9.2, 7.2, 3.1, 5.2, matOliveSteel, 'metal');
    addSolidBox(shelterX, groundY + 1.4, 9.2, 6.2, 2.7, 2.6, matRust, 'metal');

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

  buildTeamHq('A', -hqX);
  buildTeamHq('B', hqX);

  // === 4. MILITARY ROAD CHECKPOINTS ===
  const buildRoadCheckpoint = (cx: number, cz: number, code: string, label: string): void => {
    const ty = sampleY(cx, cz);

    const gx = cx;
    const gz = cz - 7.8;
    const gy = sampleY(gx, gz);
    addSolidBox(gx, gy + 1.45, gz - 1.5, 4.4, 2.9, 0.35, matConcreteDark, 'concrete');
    addSolidBox(gx - 2.05, gy + 1.45, gz, 0.35, 2.9, 3.2, matConcreteDark, 'concrete');
    addSolidBox(gx + 2.05, gy + 1.45, gz, 0.35, 2.9, 3.2, matConcreteDark, 'concrete');
    addSolidBox(gx, gy + 0.55, gz + 1.45, 4.4, 1.1, 0.32, matConcreteDark, 'concrete');
    addSolidBox(gx, gy + 3.05, gz, 5.0, 0.32, 3.8, matSteel, 'metal');

    const cpSignTex = trackTex(
      createStencilSignTexture(`${code} · ${label.toUpperCase()}`, 'MILITARY ROAD CHECKPOINT', '#f59e0b', '#171c22', maxAniso),
    );
    const cpSign = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(3.8, 0.9)),
      trackMat(new THREE.MeshStandardMaterial({ map: cpSignTex, roughness: 0.62 })),
    );
    cpSign.position.set(gx, gy + 3.05, gz + 1.92);
    sceneGroup.add(cpSign);

    const pivotPost = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 1.3, 0.45)), matSteel);
    pivotPost.position.set(cx, ty + 0.65, cz - 5.2);
    sceneGroup.add(pivotPost);
    const boomBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.14, 8.8)), matBoom);
    boomBar.position.set(cx, ty + 2.35, cz - 0.8);
    boomBar.rotation.x = 0.22;
    sceneGroup.add(boomBar);

    addSolidBox(cx - 5.5, ty + 0.55, cz - 2.5, 1.1, 1.05, 4.2, matConcrete, 'concrete');
    addSolidBox(cx + 5.5, ty + 0.55, cz + 2.5, 1.1, 1.05, 4.2, matConcrete, 'concrete');
    addSolidBox(cx - 2.4, ty + 0.55, cz + 6.8, 4.8, 1.05, 1.0, matSandbag, 'gravel');
    addSolidBox(cx + 3.2, ty + 0.55, cz + 6.8, 4.4, 1.05, 1.0, matSandbag, 'gravel');

    buildRustedVehicle(
      propCtx,
      'zil_truck',
      cx + (cx <= 0 ? -7.8 : 7.8),
      sampleY(cx + (cx <= 0 ? -7.8 : 7.8), cz + 10.2),
      cz + 10.2,
      cx <= 0 ? 0.28 : -2.85,
      vehMats,
    );

    const lPole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.09, 0.13, 6.2, 7)), matSteel);
    lPole.position.set(cx, ty + 3.1, cz + 6.0);
    sceneGroup.add(lPole);
    const pl = new THREE.PointLight(0xffd28a, 0, 22, 1.7);
    pl.visible = false;
    pl.position.set(cx, ty + 6.0, cz + 3.8);
    sceneGroup.add(pl);
    nightLights.push({ light: pl, baseLightIntensity: 14 });
  };

  const cp1X = isConquest ? -78 : -48;
  const cp2X = isConquest ? 78 : 48;
  buildRoadCheckpoint(cp1X, 0, 'CP-1', 'West Highway');
  buildRoadCheckpoint(cp2X, 0, 'CP-2', 'East Highway');
  if (isConquest) {
    buildRoadCheckpoint(0, -56, 'CP-3', 'North Service Road');
  }

  // === 5. FORTIFIED FORWARD OPERATING BASES ===
  const buildFob = (cx: number, cz: number, code: string, label: string, accentHex: string): void => {
    const ty = sampleY(cx, cz);

    const pad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(18, 0.18, 18)), matConcrete);
    pad.position.set(cx, ty + 0.05, cz);
    pad.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    pad.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(pad);
    raycastMeshes.push(pad);

    addHescoWall(cx - 6.2, cz - 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx + 6.2, cz - 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx - 6.2, cz + 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx + 6.2, cz + 9.0, 6.0, 2.0, 1.3, 0);
    addHescoWall(cx - 9.0, cz - 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx - 9.0, cz + 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx + 9.0, cz - 6.2, 1.3, 2.0, 6.0, 0);
    addHescoWall(cx + 9.0, cz + 6.2, 1.3, 2.0, 6.0, 0);

    addSolidBox(cx - 4.4, ty + 1.5, cz - 3.6, 5.2, 2.8, 3.6, matDesertTan, 'metal');
    addSolidBox(cx + 4.5, ty + 0.65, cz + 4.2, 2.6, 1.25, 1.8, matCrate, 'wood');
    addSolidBox(cx + 4.8, ty + 0.65, cz - 4.2, 1.8, 1.15, 2.6, matSandbag, 'gravel');

    const mast = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.08, 0.14, 8.8, 8)), matSteel);
    mast.position.set(cx - 5.2, ty + 4.4, cz - 4.4);
    sceneGroup.add(mast);

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

  const fobAX = isConquest ? -38 : -20;
  const fobBX = isConquest ? 38 : 20;
  buildFob(fobAX, 38, 'FOB-A', 'South Ridge FOB', '#38bdf8');
  buildFob(fobBX, -38, 'FOB-B', 'North Timber FOB', '#f97316');
  if (isConquest) {
    buildFob(-84, -56, 'FOB-C', 'NW Logging FOB', '#34d399');
    buildFob(84, 56, 'FOB-D', 'SE Supply FOB', '#fb7185');
  }

  // === 6. CENTRAL HILLTOP RELAY OUTPOST (X = 0, Z = -18, high-value strategic anchor) ===
  const outX = 0;
  const outZ = -18;
  const outY = sampleY(outX, outZ);
  const outPad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(20, 0.22, 16)), matConcreteDark);
  outPad.position.set(outX, outY + 0.06, outZ);
  outPad.receiveShadow = !isSoftwareGl && qProfile.castShadows;
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

  // === 6B. NEUTRAL ENTERABLE COVER BUILDINGS (Conquest Expanded: 6 non-objective buildings with full interiors) ===
  const coverBuildingSpecs: Array<{
    id: string;
    preset: CoverBuildingPreset;
    x: number;
    z: number;
    rot: 0 | 1 | 2 | 3;
    w: number;
    d: number;
    linkNode: string;
  }> = isConquest
    ? [
        { id: 'volga_garage_w', preset: 'industrial_garage', x: -108, z: 18, rot: 0, w: 12.2, d: 9.0, linkNode: 'hwy_w1' },
        { id: 'volga_farmhouse_s', preset: 'rural_farmhouse', x: -12, z: 72, rot: 2, w: 11.2, d: 8.6, linkNode: 'south_rd_c' },
        { id: 'volga_logging_nw', preset: 'timber_cabin', x: -46, z: -74, rot: 0, w: 11.4, d: 8.6, linkNode: 'north_rd_w' },
        { id: 'volga_station_e', preset: 'industrial_garage', x: 108, z: -18, rot: 2, w: 12.2, d: 9.0, linkNode: 'hwy_e1' },
        { id: 'volga_annex_mid', preset: 'soviet_annex', x: 26, z: 18, rot: 0, w: 10.6, d: 8.4, linkNode: 'hwy_mid_e' },
        { id: 'volga_barn_se', preset: 'timber_cabin', x: 46, z: 74, rot: 2, w: 11.6, d: 8.8, linkNode: 'south_rd_e' },
      ]
    : [];

  const packCache = new Map<CoverBuildingPreset, CoverBuildingMaterialPack>();
  const builtCoverBuildings = coverBuildingSpecs.map((b) => {
    let pack = packCache.get(b.preset);
    if (!pack) {
      pack = createCoverBuildingMaterialPack(propCtx, b.preset, trackTex);
      packCache.set(b.preset, pack);
    }
    return {
      spec: b,
      built: buildEnterableCoverBuilding(
        propCtx,
        {
          id: b.id,
          preset: b.preset,
          x: b.x,
          z: b.z,
          y: sampleY(b.x, b.z) + 0.04,
          rotQuarterTurns: b.rot,
          width: b.w,
          depth: b.d,
          materials: pack,
        },
        trackTex,
      ),
    };
  });

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
    const fy = sampleY(fx, fz) + fh * 0.5;
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

  // === 7. HIGH-DETAIL INSTANCED PINE FOREST, BIRCH GROVES, SCULPTED BOULDERS & GRASS TUFTS ===
  const rand = seededRand(88047);
  const isClear = (tx: number, tz: number): boolean => {
    // Keep central highway clear
    if (Math.abs(tz) < 11.5 && Math.abs(tx) < boundX + 10) return false;
    // Keep Conquest North/South service roads & spurs clear
    if (isConquest) {
      if (Math.abs(tx) < 126 && (Math.abs(tz + 56) < 8.5 || Math.abs(tz - 56) < 8.5)) return false;
      for (const sx of [-118, -48, 48, 118]) {
        if (Math.abs(tx - sx) < 6.8 && Math.abs(tz) < 60) return false;
      }
      if (Math.hypot(tx + 84, tz + 56) < 16) return false;
      if (Math.hypot(tx - 84, tz - 56) < 16) return false;
      if (Math.hypot(tx, tz + 56) < 15) return false;
      for (const cb of coverBuildingSpecs) {
        if (Math.abs(tx - cb.x) < cb.w * 0.5 + 4.5 && Math.abs(tz - cb.z) < cb.d * 0.5 + 4.5) {
          return false;
        }
      }
    }
    // Keep West & East HQs clear
    if (Math.abs(tx + hqX) < 19 && Math.abs(tz) < 22) return false;
    if (Math.abs(tx - hqX) < 19 && Math.abs(tz) < 22) return false;
    // Keep FOBs, Outpost & Checkpoints clear
    if (Math.hypot(tx - cp1X, tz) < 15) return false;
    if (Math.hypot(tx - cp2X, tz) < 15) return false;
    if (Math.hypot(tx - fobAX, tz - 38) < 16) return false;
    if (Math.hypot(tx - fobBX, tz + 38) < 16) return false;
    if (Math.hypot(tx, tz + 18) < 15) return false;
    return true;
  };

  const targetTrees = Math.max(120, Math.round((isConquest ? 360 : 260) * qProfile.foliageDensity));
  const pineSpots: PineTreeSpot[] = [];
  const birchSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  const scatterSpanX = isConquest ? 400 : 280;
  const scatterSpanZ = isConquest ? 275 : 204;

  for (let attempt = 0; attempt < 3200 && pineSpots.length < targetTrees; attempt++) {
    const tx = (rand() - 0.5) * scatterSpanX;
    const tz = (rand() - 0.5) * scatterSpanZ;
    if (!isClear(tx, tz)) continue;
    const nearEdge = Math.abs(tx) > boundX - 12 || Math.abs(tz) > boundZ - 12;
    const minDistSq = nearEdge ? 20 : 38;
    if (pineSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < minDistSq)) continue;
    const ty = sampleY(tx, tz);
    const scale = 0.86 + rand() * 0.62;
    // Neutral-bright alpine spruce tints (multiplied onto needle texture & vertex AO)
    const tint = new THREE.Color().setHSL(0.28 + (rand() - 0.5) * 0.05, 0.24 + rand() * 0.14, 0.62 + rand() * 0.2);
    pineSpots.push({ x: tx, y: ty, z: tz, scale, yaw: rand() * Math.PI * 2, tint });
  }

  // Scattered white-bark birch trees near clearings and roadside meadows (2 draw calls total!)
  const targetBirches = Math.max(24, Math.round((isConquest ? 68 : 40) * qProfile.foliageDensity));
  for (let attempt = 0; attempt < 900 && birchSpots.length < targetBirches; attempt++) {
    const tx = (rand() - 0.5) * (boundX * 1.9);
    const tz = (rand() - 0.5) * (boundZ * 1.85);
    if (!isClear(tx, tz)) continue;
    if (pineSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < 18)) continue;
    if (birchSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < 24)) continue;
    birchSpots.push({
      x: tx,
      y: sampleY(tx, tz),
      z: tz,
      scale: 0.9 + rand() * 0.48,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.22 + (rand() - 0.5) * 0.06, 0.28 + rand() * 0.14, 0.68 + rand() * 0.18),
    });
  }

  buildInstancedPineTrees(propCtx, pineSpots, {
    castShadow: qProfile.castShadows,
    receiveShadow: qProfile.castShadows,
    addTrunkColliders: true,
    colliderBounds: { minX: -boundX + 2, maxX: boundX - 2, minZ: -boundZ + 2, maxZ: boundZ - 2 },
    seed: 5511,
  });
  buildInstancedBirchTrees(propCtx, birchSpots, true);

  // High-detail sculpted fractured boulders & layered multi-stone outcrops (2 draw calls total!)
  const rockTarget = isConquest ? 104 : 68;
  const rockSpots: BoulderSpot[] = [];
  for (let i = 0; i < rockTarget * 2 && rockSpots.length < rockTarget; i++) {
    const rx = (rand() - 0.5) * (boundX * 2.15);
    const rz = (rand() - 0.5) * (boundZ * 2.15);
    if (!isClear(rx, rz)) continue;
    const ry = sampleY(rx, rz);
    const s = 0.95 + rand() * 1.55;
    rockSpots.push({
      x: rx,
      y: ry,
      z: rz,
      sx: s * (1.05 + rand() * 0.35),
      sy: s * (0.72 + rand() * 0.3),
      sz: s * (0.9 + rand() * 0.3),
      yaw: rand() * Math.PI * 2,
      variant: (i % 2) as 0 | 1,
    });
  }
  buildInstancedSculptedBoulders(propCtx, rockSpots, {
    castShadow: qProfile.castShadows,
    receiveShadow: qProfile.castShadows,
    addColliders: true,
    colliderBounds: { minX: -boundX + 2, maxX: boundX - 2, minZ: -boundZ + 2, maxZ: boundZ - 2 },
    seed: 5412,
  });

  // Wind-swayed grass tufts
  const grassCount = Math.max(150, Math.round((isConquest ? 520 : 420) * qProfile.foliageDensity));
  const grassSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < grassCount * 2 && grassSpots.length < grassCount; i++) {
    const gx = (rand() - 0.5) * (boundX * 1.9);
    const gz = (rand() - 0.5) * (boundZ * 1.85);
    if (!isClear(gx, gz)) continue;
    grassSpots.push({
      x: gx,
      y: sampleY(gx, gz),
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
    position: [x, sampleY(x, z) + 0.08, z],
    zoneId: 'default',
    neighbors,
    isCover,
  });

  const rawNodes: NavNode[] = isConquest
    ? [
        // West Alpha HQ (-148, 0) & Western Approaches
        nodeAt('hqa_c', -144, 0, ['hqa_n', 'hqa_s', 'hwy_w1']),
        nodeAt('hqa_n', -132, -16, ['hqa_c', 'spur_nw']),
        nodeAt('hqa_s', -132, 16, ['hqa_c', 'spur_sw']),
        nodeAt('hwy_w1', -118, 0, ['hqa_c', 'cp1_c', 'spur_nw', 'spur_sw']),
        nodeAt('spur_nw', -118, -56, ['hqa_n', 'hwy_w1', 'fobc_c']),
        nodeAt('spur_sw', -118, 56, ['hqa_s', 'hwy_w1', 'south_rd_w']),

        // NW Logging FOB-C (-84, -56) & West Highway CP-1 (-78, 0)
        nodeAt('fobc_c', -84, -56, ['spur_nw', 'north_rd_w', 'cp1_c'], true),
        nodeAt('cp1_c', -78, 0, ['hwy_w1', 'hwy_mid_w', 'fobc_c', 'south_rd_w'], true),
        nodeAt('south_rd_w', -78, 56, ['spur_sw', 'cp1_c', 'foba_c', 'south_rd_c']),

        // North Service Road & CP-3 (0, -56)
        nodeAt('north_rd_w', -48, -56, ['fobc_c', 'cp3_c', 'hwy_mid_w', 'out_w']),
        nodeAt('cp3_c', 0, -56, ['north_rd_w', 'north_rd_e', 'out_c'], true),
        nodeAt('north_rd_e', 48, -56, ['cp3_c', 'fobb_c', 'spur_ne', 'hwy_mid_e']),

        // Central Highway & Outpost Relay Hill
        nodeAt('hwy_mid_w', -48, 0, ['cp1_c', 'hwy_c', 'north_rd_w', 'foba_c'], true),
        nodeAt('hwy_c', 0, 0, ['hwy_mid_w', 'hwy_mid_e', 'out_s', 'south_rd_c'], true),
        nodeAt('hwy_mid_e', 48, 0, ['hwy_c', 'cp2_c', 'north_rd_e', 'fobb_c', 'south_rd_e'], true),
        nodeAt('out_c', 0, -16, ['out_s', 'out_w', 'out_e', 'cp3_c'], true),
        nodeAt('out_s', 0, -8, ['out_c', 'hwy_c', 'hwy_mid_w', 'hwy_mid_e']),
        nodeAt('out_w', -24, -22, ['out_c', 'north_rd_w', 'hwy_mid_w']),
        nodeAt('out_e', 24, -22, ['out_c', 'fobb_c', 'hwy_mid_e']),

        // Inner FOBs (FOB-A South-West Ridge, FOB-B North-East Timber) & South Road
        nodeAt('foba_c', -38, 38, ['hwy_mid_w', 'south_rd_w', 'south_rd_c'], true),
        nodeAt('fobb_c', 38, -38, ['hwy_mid_e', 'north_rd_e', 'out_e', 'cp2_c'], true),
        nodeAt('south_rd_c', 0, 56, ['south_rd_w', 'south_rd_e', 'foba_c', 'hwy_c']),
        nodeAt('south_rd_e', 48, 56, ['south_rd_c', 'fobd_c', 'hwy_mid_e']),

        // SE Supply FOB-D (+84, 56), East Highway CP-2 (+78, 0) & Bravo HQ (+148, 0)
        nodeAt('fobd_c', 84, 56, ['south_rd_e', 'spur_se', 'cp2_c'], true),
        nodeAt('cp2_c', 78, 0, ['hwy_mid_e', 'hwy_e1', 'fobb_c', 'fobd_c'], true),
        nodeAt('spur_ne', 118, -56, ['north_rd_e', 'hwy_e1', 'hqb_n']),
        nodeAt('spur_se', 118, 56, ['fobd_c', 'hwy_e1', 'hqb_s']),
        nodeAt('hwy_e1', 118, 0, ['cp2_c', 'spur_ne', 'spur_se', 'hqb_c']),
        nodeAt('hqb_c', 144, 0, ['hwy_e1', 'hqb_n', 'hqb_s']),
        nodeAt('hqb_n', 132, -16, ['hqb_c', 'spur_ne']),
        nodeAt('hqb_s', 132, 16, ['hqb_c', 'spur_se']),
      ]
    : [
        // Classic compact Volga NavGraph
        nodeAt('hqa_c', -90, 0, ['hqa_n', 'hqa_s', 'hwy_w1']),
        nodeAt('hqa_n', -82, -14, ['hqa_c', 'flank_nw']),
        nodeAt('hqa_s', -82, 14, ['hqa_c', 'flank_sw']),
        nodeAt('hwy_w1', -70, 0, ['hqa_c', 'cp1_c', 'flank_nw', 'flank_sw']),
        nodeAt('cp1_c', -48, 0, ['hwy_w1', 'hwy_mid_w', 'flank_nw', 'flank_sw'], true),
        nodeAt('flank_nw', -54, -26, ['hqa_n', 'hwy_w1', 'cp1_c', 'mid_nw', 'out_w']),
        nodeAt('flank_sw', -54, 26, ['hqa_s', 'hwy_w1', 'cp1_c', 'foba_w']),
        nodeAt('hwy_mid_w', -24, 0, ['cp1_c', 'hwy_c', 'out_s', 'foba_n'], true),
        nodeAt('hwy_c', 0, 0, ['hwy_mid_w', 'hwy_mid_e', 'out_s', 'mid_s'], true),
        nodeAt('hwy_mid_e', 24, 0, ['hwy_c', 'cp2_c', 'out_s', 'fobb_s'], true),
        nodeAt('out_c', 0, -16, ['out_s', 'out_w', 'out_e', 'mid_nw', 'fobb_w'], true),
        nodeAt('out_s', 0, -8, ['out_c', 'hwy_c', 'hwy_mid_w', 'hwy_mid_e']),
        nodeAt('out_w', -18, -18, ['out_c', 'flank_nw', 'mid_nw']),
        nodeAt('out_e', 18, -18, ['out_c', 'fobb_s', 'fobb_w']),
        nodeAt('mid_nw', -26, -34, ['flank_nw', 'out_w', 'out_c', 'fobb_w']),
        nodeAt('foba_c', -20, 38, ['foba_w', 'foba_n', 'foba_e'], true),
        nodeAt('foba_w', -34, 34, ['foba_c', 'flank_sw']),
        nodeAt('foba_n', -20, 22, ['foba_c', 'hwy_mid_w', 'mid_s']),
        nodeAt('foba_e', -2, 34, ['foba_c', 'mid_s', 'flank_se']),
        nodeAt('mid_s', 6, 22, ['hwy_c', 'foba_n', 'foba_e', 'flank_se']),
        nodeAt('fobb_c', 20, -38, ['fobb_w', 'fobb_s', 'fobb_e'], true),
        nodeAt('fobb_w', 2, -34, ['fobb_c', 'mid_nw', 'out_c', 'out_e']),
        nodeAt('fobb_s', 20, -22, ['fobb_c', 'hwy_mid_e', 'out_e']),
        nodeAt('fobb_e', 36, -32, ['fobb_c', 'flank_ne']),
        nodeAt('cp2_c', 48, 0, ['hwy_mid_e', 'hwy_e1', 'flank_ne', 'flank_se'], true),
        nodeAt('flank_ne', 54, -26, ['fobb_e', 'cp2_c', 'hwy_e1', 'hqb_n']),
        nodeAt('flank_se', 54, 26, ['foba_e', 'mid_s', 'cp2_c', 'hwy_e1', 'hqb_s']),
        nodeAt('hwy_e1', 70, 0, ['cp2_c', 'flank_ne', 'flank_se', 'hqb_c']),
        nodeAt('hqb_c', 90, 0, ['hwy_e1', 'hqb_n', 'hqb_s']),
        nodeAt('hqb_n', 82, -14, ['hqb_c', 'flank_ne']),
        nodeAt('hqb_s', 82, 14, ['hqb_c', 'flank_se']),
      ];

  // Wire every neutral enterable cover building's interior + doorway entry nodes into NavGraph
  for (const { spec, built } of builtCoverBuildings) {
    const inId = `cb_${spec.id}_in`;
    const entryIds = built.entryPoints.map((_, idx) => `cb_${spec.id}_door_${idx}`);
    rawNodes.push({
      id: inId,
      position: built.interiorPos,
      zoneId: 'default',
      neighbors: entryIds,
      isCover: true,
    });
    built.entryPoints.forEach((ep, idx) => {
      rawNodes.push({
        id: entryIds[idx],
        position: [ep[0], sampleY(ep[0], ep[2]) + 0.08, ep[2]],
        zoneId: 'default',
        neighbors: [inId, spec.linkNode],
      });
    });
  }

  // === 9. SPAWNS & BATTLE OBJECTIVE LAYOUT ===
  const sp = (x: number, z: number, yaw: number): SpawnPoint => ({
    position: [x, sampleY(x, z) + 0.1, z],
    yaw,
  });

  const hqASpawns: SpawnPoint[] = [
    sp(-hqX + 2, 0, -Math.PI * 0.5),
    sp(-hqX - 2, -5.5, -Math.PI * 0.5),
    sp(-hqX - 2, 5.5, -Math.PI * 0.5),
    sp(-hqX + 6, -10.5, -Math.PI * 0.45),
    sp(-hqX + 6, 10.5, -Math.PI * 0.55),
    sp(-hqX - 6, 0, -Math.PI * 0.5),
  ];
  const hqBSpawns: SpawnPoint[] = [
    sp(hqX - 2, 0, Math.PI * 0.5),
    sp(hqX + 2, -5.5, Math.PI * 0.5),
    sp(hqX + 2, 5.5, Math.PI * 0.5),
    sp(hqX - 6, -10.5, Math.PI * 0.55),
    sp(hqX - 6, 10.5, Math.PI * 0.45),
    sp(hqX + 6, 0, Math.PI * 0.5),
  ];

  const conquestPois: MapBattleObjectives['conquestPois'] = [
    {
      id: 'poi_cp1',
      code: 'CP-1',
      label: 'West Highway Checkpoint',
      kind: 'checkpoint',
      position: [cp1X, sampleY(cp1X, 0), 0],
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
      position: [fobAX, sampleY(fobAX, 38), 38],
      captureRadiusM: 10.0,
      territoryWeight: 1.35,
      initialOwner: null,
      hasBuiltInProps: true,
      spawnPoints: [
        sp(fobAX, 34, Math.PI),
        sp(fobAX + 4.5, 38, -Math.PI * 0.5),
        sp(fobAX - 4.5, 41, Math.PI * 0.5),
        sp(fobAX + 3, 43, Math.PI),
      ],
    },
    {
      id: 'poi_outpost',
      code: 'OUTPOST',
      label: 'Relay Hill Outpost',
      kind: 'outpost',
      position: [0, sampleY(0, -18), -18],
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
      position: [fobBX, sampleY(fobBX, -38), -38],
      captureRadiusM: 10.0,
      territoryWeight: 1.35,
      initialOwner: null,
      hasBuiltInProps: true,
      spawnPoints: [
        sp(fobBX, -34, 0),
        sp(fobBX - 4.5, -38, Math.PI * 0.5),
        sp(fobBX + 4.5, -41, -Math.PI * 0.5),
        sp(fobBX - 3, -43, 0),
      ],
    },
    {
      id: 'poi_cp2',
      code: 'CP-2',
      label: 'East Highway Checkpoint',
      kind: 'checkpoint',
      position: [cp2X, sampleY(cp2X, 0), 0],
      captureRadiusM: 9.5,
      territoryWeight: 1.0,
      initialOwner: null,
      hasBuiltInProps: true,
      roadYaw: 0,
    },
  ];

  if (isConquest) {
    conquestPois.push(
      {
        id: 'poi_cp3_north',
        code: 'CP-3',
        label: 'North Service Checkpoint',
        kind: 'checkpoint',
        position: [0, sampleY(0, -56), -56],
        captureRadiusM: 9.5,
        territoryWeight: 1.05,
        initialOwner: null,
        hasBuiltInProps: true,
        roadYaw: 0,
      },
      {
        id: 'poi_fob_c',
        code: 'FOB-C',
        label: 'NW Logging Yard FOB',
        kind: 'fob',
        position: [-84, sampleY(-84, -56), -56],
        captureRadiusM: 10.0,
        territoryWeight: 1.35,
        initialOwner: null,
        hasBuiltInProps: true,
        spawnPoints: [
          sp(-84, -52, 0),
          sp(-80, -56, -Math.PI * 0.5),
          sp(-88, -60, -Math.PI * 0.4),
        ],
      },
      {
        id: 'poi_fob_d',
        code: 'FOB-D',
        label: 'SE Supply Depot FOB',
        kind: 'fob',
        position: [84, sampleY(84, 56), 56],
        captureRadiusM: 10.0,
        territoryWeight: 1.35,
        initialOwner: null,
        hasBuiltInProps: true,
        spawnPoints: [
          sp(84, 52, Math.PI),
          sp(80, 56, Math.PI * 0.5),
          sp(88, 60, Math.PI * 0.6),
        ],
      },
    );
  }

  const battleObjectives: MapBattleObjectives = {
    hqA: {
      id: 'hq_a',
      team: 'A',
      label: 'Alpha HQ (West)',
      position: [-hqX, sampleY(-hqX, 0), 0],
      safeRadiusM: isConquest ? 22 : 18,
      spawnPoints: hqASpawns,
    },
    hqB: {
      id: 'hq_b',
      team: 'B',
      label: 'Bravo HQ (East)',
      position: [hqX, sampleY(hqX, 0), 0],
      safeRadiusM: isConquest ? 22 : 18,
      spawnPoints: hqBSpawns,
    },
    conquestPois,
    ctfFlags: [
      {
        team: 'A',
        label: 'Alpha Base Flag',
        position: [-78, sampleY(-78, 0), 0],
      },
      {
        team: 'B',
        label: 'Bravo Base Flag',
        position: [78, sampleY(78, 0), 0],
      },
    ],
    kothHills: [
      { id: 'hill_outpost', label: 'Relay Hill Outpost', position: [0, sampleY(0, -18), -18], radiusM: 9.5 },
      { id: 'hill_cp1', label: 'West Highway Checkpoint', position: [cp1X, sampleY(cp1X, 0), 0], radiusM: 9.0 },
      { id: 'hill_fob_a', label: 'South Ridge FOB', position: [fobAX, sampleY(fobAX, 38), 38], radiusM: 9.5 },
      { id: 'hill_cp2', label: 'East Highway Checkpoint', position: [cp2X, sampleY(cp2X, 0), 0], radiusM: 9.0 },
      { id: 'hill_fob_b', label: 'North Timber FOB', position: [fobBX, sampleY(fobBX, -38), -38], radiusM: 9.5 },
    ],
  };

  const ffaSpawns: SpawnPoint[] = [
    ...hqASpawns.slice(0, 3),
    ...hqBSpawns.slice(0, 3),
    sp(cp1X, 8, Math.PI),
    sp(cp2X, -8, 0),
    sp(fobAX, 38, Math.PI),
    sp(fobBX, -38, 0),
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
    terrainHeightAt: sampleY,
    interactables: [],
    lightingPreset: LIGHTING_PRESET,
    supportsDynamicWeatherTime: true,
    isExpandedConquest: isConquest,
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

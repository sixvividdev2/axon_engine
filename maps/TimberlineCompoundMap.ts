import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { DestructibleDoorSystem } from '../doors/DestructibleDoorSystem';
import { PenetrableSurfaceSystem } from '../doors/PenetrableSurfaceSystem';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  createRiverWaterMaterial,
} from '../engine/world/WaterShader';
import {
  NightLightEntry,
  WettableSurfaceEntry,
} from '../engine/world/WeatherTimeSystem';
import {
  applyWindFoliageShader,
  assignHeightSwayAttribute,
  createWindShaderUniforms,
} from '../engine/world/WindFoliageShader';
import {
  buildArmoryWeaponRack,
  buildInstancedFerns,
  buildInstancedGrassTufts,
  buildInstancedUndergrowthShrubs,
  buildOfficeDesk,
  buildRadarTower,
  buildRealisticHelicopterProp,
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCabinWoodTexture,
  createCorrugatedMetalTexture,
  createForestFloorTexture,
  createIndustrialSlateConcreteTexture,
  createRunwayAsphaltTexture,
  createRustedMetalTexture,
  createSovietConcreteTexture,
  createWaterNormalTexture,
} from './MapTextures';
import {
  buildNavGraph,
  BuiltMapInstance,
  IMapDefinition,
  MapLightingPreset,
  NavNode,
  SpawnPoint,
} from './types';

const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x829197,
  fogHex: 0x7b8a90,
  fogDensity: 0.0052, // wider visibility for massive open forest valley & airstrip
  envIntensity: 0.58,
  hemiSkyHex: 0xbed0d6,
  hemiGroundHex: 0x353d2e,
  hemiIntensity: 0.95,
  keyLightHex: 0xf0f4ea,
  keyLightIntensity: 2.0,
  keyLightPos: [-60, 82, 48],
};

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Winding alpine river centerline X as a function of Z */
function getRiverCenterX(z: number): number {
  return -24.0 + Math.sin(z * 0.026) * 9.5 + Math.cos(z * 0.013) * 3.5;
}

/**
 * Visual heightfield for the massive 340m x 340m Timberline Forest Valley:
 * - Perfectly flat (Y = 0) across the Military Base compound (X in [4, 102], Z in [-68, 64])
 *   and across both village clearings and lone cabin pads so every structure sits 100% flush.
 * - Carves a smooth riverbed channel along getRiverCenterX(z) down to Y = -1.65m.
 * - Gently rolls into natural wooded mountain ridges past |x|,|z| > 108m (no artificial box walls!).
 */
function sampleVisualTerrainY(x: number, z: number): number {
  // 1. River channel carve
  const riverX = getRiverCenterX(z);
  const distRiver = Math.abs(x - riverX);
  let riverCarve = 0;
  if (distRiver < 10.5) {
    const t = THREE.MathUtils.clamp((distRiver - 4.2) / 6.3, 0, 1);
    const smooth = t * t * (3 - 2 * t);
    riverCarve = -1.65 * (1 - smooth);
  }

  // 2. Keep Military Base, Highway, Villages & Lone Cabins level (Y = 0)
  const inMilBase = x >= 2 && x <= 104 && z >= -68 && z <= 64;
  const inHighway = Math.abs(x - -2) <= 7.5 && Math.abs(z) <= 115;
  const inVillageNW = x >= -86 && x <= -36 && z >= -82 && z <= -36;
  const inVillageSW = x >= -88 && x <= -38 && z >= 34 && z <= 84;
  const nearLoneCabin =
    (Math.hypot(x - 78, z - -84) < 12) ||
    (Math.hypot(x - -96, z - 4) < 12) ||
    (Math.hypot(x - 84, z - 82) < 12);

  if (inMilBase || inHighway || inVillageNW || inVillageSW || nearLoneCabin) {
    return riverCarve;
  }

  // 3. Gentle forest undulations inside playable valley + dramatic mountain ridges around perimeter
  const edgeX = Math.max(0, Math.abs(x) - 104);
  const edgeZ = Math.max(0, Math.abs(z) - 104);
  const outerDist = Math.hypot(edgeX, edgeZ);
  const outerBlend = THREE.MathUtils.clamp(outerDist / 28.0, 0, 1);
  const outerSmooth = outerBlend * outerBlend * (3 - 2 * outerBlend);

  const valleyRoll =
    (Math.sin(x * 0.045) * Math.cos(z * 0.048) * 1.1 + Math.sin((x - z) * 0.03) * 0.7) *
    THREE.MathUtils.clamp((distRiver - 8.5) / 8.0, 0, 1);

  const ridgeH =
    outerSmooth *
    (6.5 + Math.sin(x * 0.04) * 3.0 + Math.cos(z * 0.042) * 3.0 + Math.min(18, outerDist * 0.32));

  return riverCarve + Math.max(0, valleyRoll * 0.45) + ridgeH;
}

/**
 * Physics ground height query: returns -10.0 over the Underground Bunker footprint
 * so the player & bots can walk DOWN into the bunker at Y = -3.6m without terrain clamping
 * them back to Y = 0, while the solid concrete bunker roof collider supports walking on top at Y = 0!
 */
function samplePhysicsTerrainY(x: number, z: number): number {
  if (x >= 42.6 && x <= 62.4 && z >= -16.4 && z <= 4.4) {
    return -10.0;
  }
  return sampleVisualTerrainY(x, z);
}

function buildTimberlineCompound(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = -4.5; // Allow subterranean bunker floor at Y = -3.6m!
  physics.boundsMinX = -114;
  physics.boundsMaxX = 114;
  physics.boundsMinZ = -114;
  physics.boundsMaxZ = 114;

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

  const sun = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  sun.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl && qProfile.castShadows) {
    sun.castShadow = true;
    const sm = Math.min(2048, qProfile.shadowMapSize);
    sun.shadow.mapSize.set(sm, sm);
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 260;
    sun.shadow.camera.left = -120;
    sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120;
    sun.shadow.camera.bottom = -120;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
  }
  sceneGroup.add(sun);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  const windUniforms = createWindShaderUniforms();

  // Textures
  const forestTex = trackTex(createForestFloorTexture(maxAniso, 36, 36));
  const cabinWoodTex = trackTex(createCabinWoodTexture(maxAniso, 2, 1, '#614833', 707));
  const cabinFloorTex = trackTex(createCabinWoodTexture(maxAniso, 3, 2, '#4a3727', 719));
  const concTex = trackTex(createSovietConcreteTexture(maxAniso, 3, 2, '#7b7f7c', 733));
  const bunkerConcTex = trackTex(createIndustrialSlateConcreteTexture(maxAniso, 3, 2, '#4c5256', 739));
  const roadAsphaltTex = trackTex(createAsphaltRoadTexture(maxAniso, 2, 24, false, 741));
  const runwayTex = trackTex(createRunwayAsphaltTexture(maxAniso, 2, 14));
  const riverNormalA = trackTex(createWaterNormalTexture(maxAniso, 'a'));
  const riverNormalB = trackTex(createWaterNormalTexture(maxAniso, 'b'));
  const garageMetalTex = trackTex(createCorrugatedMetalTexture(maxAniso, '#455148', 751));
  const rustOliveTex = trackTex(createRustedMetalTexture(maxAniso, '#485442', 761));
  const rustBlueTex = trackTex(createRustedMetalTexture(maxAniso, '#3c5261', 762));
  const pureRustTex = trackTex(createRustedMetalTexture(maxAniso, '#6b3e26', 763));

  // Materials
  const matTerrain = trackMat(
    new THREE.MeshStandardMaterial({ map: forestTex, roughness: 0.96, metalness: 0.02 }),
  );
  const matRoad = trackMat(
    new THREE.MeshStandardMaterial({ map: roadAsphaltTex, roughness: 0.9, metalness: 0.03 }),
  );
  const matDirtPath = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x5c4f3d, roughness: 0.97, metalness: 0.01 }),
  );
  const matRunway = trackMat(
    new THREE.MeshStandardMaterial({ map: runwayTex, roughness: 0.86, metalness: 0.04 }),
  );
  const matRunwayPaint = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xd9dad5, roughness: 0.82, metalness: 0.02 }),
  );
  const matYellowPaint = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xdca437, roughness: 0.75, metalness: 0.05 }),
  );
  const matBaseConcrete = trackMat(
    new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.91, metalness: 0.04 }),
  );
  const matBunkerConcrete = trackMat(
    new THREE.MeshStandardMaterial({ map: bunkerConcTex, roughness: 0.88, metalness: 0.08 }),
  );
  const matWood = trackMat(
    new THREE.MeshStandardMaterial({ map: cabinWoodTex, roughness: 0.88, metalness: 0.03 }),
  );
  const matWoodFloor = trackMat(
    new THREE.MeshStandardMaterial({ map: cabinFloorTex, roughness: 0.85, metalness: 0.03 }),
  );
  const matRoof = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x353b3e, roughness: 0.72, metalness: 0.36 }),
  );
  const matGarageMetal = trackMat(
    new THREE.MeshStandardMaterial({ map: garageMetalTex, roughness: 0.68, metalness: 0.44 }),
  );
  const matSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3f464a, roughness: 0.52, metalness: 0.72 }),
  );
  const matGunMetal = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.44, metalness: 0.82 }),
  );
  const matBarrierGlass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8db2bd,
      roughness: 0.12,
      metalness: 0.18,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
    }),
  );
  const matGlassShard = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb7dbe6,
      roughness: 0.15,
      metalness: 0.25,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    }),
  );
  const waterHandle = createRiverWaterMaterial(riverNormalA, riverNormalB);
  const matRiver = trackMat(waterHandle.material);

  const matBark = trackMat(new THREE.MeshStandardMaterial({ color: 0x463426, roughness: 0.95 }));
  const matPineNeedles = trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 }));
  applyWindFoliageShader(matBark, windUniforms, { swayScale: 0.06, isTrunk: true });
  applyWindFoliageShader(matPineNeedles, windUniforms, { swayScale: 0.21 });

  const matRock = trackMat(new THREE.MeshStandardMaterial({ color: 0x5c6160, roughness: 0.94 }));
  const matRunwayBulb = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xffefc2, emissive: 0xf7c96b, emissiveIntensity: 2.8, roughness: 0.15 }),
  );
  const matThresholdGreen = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x4ade80, emissive: 0x22c55e, emissiveIntensity: 2.6, roughness: 0.15 }),
  );
  const matBunkerStrip = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xdff5ff, emissive: 0x93d8f8, emissiveIntensity: 2.0, roughness: 0.2 }),
  );
  const matWindsock = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xe66524, roughness: 0.75, side: THREE.DoubleSide }),
  );

  const wettableSurfaces: WettableSurfaceEntry[] = [
    { material: matRoad, baseRoughness: 0.9, baseEnvMapIntensity: 0.55 },
    { material: matRunway, baseRoughness: 0.86, baseEnvMapIntensity: 0.55 },
    { material: matBaseConcrete, baseRoughness: 0.91, baseEnvMapIntensity: 0.45 },
    { material: matTerrain, baseRoughness: 0.96, baseEnvMapIntensity: 0.35 },
  ];
  const nightLights: NightLightEntry[] = [
    { emissiveMat: matRunwayBulb, baseEmissiveIntensity: 3.4 },
    { emissiveMat: matThresholdGreen, baseEmissiveIntensity: 3.0 },
  ];

  const baseVehMats = {
    rust: trackMat(new THREE.MeshStandardMaterial({ map: pureRustTex, roughness: 0.82, metalness: 0.38 })),
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x1a1c1d, roughness: 0.95 })),
    rim: trackMat(new THREE.MeshStandardMaterial({ color: 0x614b39, roughness: 0.72, metalness: 0.45 })),
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x151718, roughness: 0.95 })),
    glass: trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x283b42,
        roughness: 0.2,
        metalness: 0.6,
        transparent: true,
        opacity: 0.45,
      }),
    ),
    chrome: trackMat(new THREE.MeshStandardMaterial({ color: 0x7f786d, roughness: 0.45, metalness: 0.65 })),
  };
  const vehOlive: VehicleMaterials = {
    ...baseVehMats,
    body: trackMat(new THREE.MeshStandardMaterial({ map: rustOliveTex, roughness: 0.74, metalness: 0.34 })),
  };
  const vehBlue: VehicleMaterials = {
    ...baseVehMats,
    body: trackMat(new THREE.MeshStandardMaterial({ map: rustBlueTex, roughness: 0.74, metalness: 0.34 })),
  };

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

  // === 1. MASSIVE 340m x 340m HIGH-RESOLUTION TERRAIN WITH CLEAN BUNKER ENTRANCE CUTOUT ===
  const terrainSize = 340;
  const segs = graphicsQuality === 'performance' ? 144 : 192;
  const terrainGeo = trackGeo(new THREE.PlaneGeometry(terrainSize, terrainSize, segs, segs));
  terrainGeo.rotateX(-Math.PI * 0.5);
  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    posAttr.setY(i, sampleVisualTerrainY(vx, vz));
  }
  // Remove triangles overlapping the underground bunker stairwell opening so terrain never slices the entry!
  const oldIndex = terrainGeo.getIndex()!;
  const keptIndices: number[] = [];
  for (let i = 0; i < oldIndex.count; i += 3) {
    const a = oldIndex.getX(i);
    const b = oldIndex.getX(i + 1);
    const c = oldIndex.getX(i + 2);
    const cx = (posAttr.getX(a) + posAttr.getX(b) + posAttr.getX(c)) / 3;
    const cz = (posAttr.getZ(a) + posAttr.getZ(b) + posAttr.getZ(c)) / 3;
    if (cx >= 42.5 && cx <= 62.5 && cz >= -16.5 && cz <= 4.5) {
      continue;
    }
    keptIndices.push(a, b, c);
  }
  terrainGeo.setIndex(keptIndices);
  terrainGeo.computeVertexNormals();

  const terrainMesh = new THREE.Mesh(terrainGeo, matTerrain);
  terrainMesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  terrainMesh.userData.surfaceMaterial = 'grass';
  sceneGroup.add(terrainMesh);
  raycastMeshes.push(terrainMesh);

  // === 2. OPTICAL ALPINE RIVER WATER (ZERO SHORELINE GAPS) & ANCHORED BRIDGES ===
  const waterSurfaceY = -0.35;
  const riverSegsZ = 148;
  const riverColsX = 12;
  const riverHalfW = 10.6; // extends cleanly under bank slopes; depth <= 0 feathers smoothly to zero
  const rPositions: number[] = [];
  const rUvs: number[] = [];
  const rDepths: number[] = [];
  const rPierMask: number[] = [];
  const rIndices: number[] = [];

  const pierPositions: Array<[number, number]> = [];
  for (const bz of [-48, 34]) {
    const brx = getRiverCenterX(bz);
    for (const px of [-6.0, 0, 6.0]) {
      for (const side of [-1, 1]) {
        pierPositions.push([brx + px, bz + side * (5.4 * 0.42)]);
      }
    }
  }

  for (let iz = 0; iz <= riverSegsZ; iz++) {
    const tz = iz / riverSegsZ;
    const z = -155 + tz * 310;
    const rx = getRiverCenterX(z);
    for (let ix = 0; ix <= riverColsX; ix++) {
      const tx = ix / riverColsX;
      const wx = rx + (tx * 2 - 1) * riverHalfW;
      const groundY = sampleVisualTerrainY(wx, z);
      const depth = Math.max(0, waterSurfaceY - groundY);

      let pierMask = 0;
      for (let p = 0; p < pierPositions.length; p++) {
        const pd = Math.hypot(wx - pierPositions[p][0], z - pierPositions[p][1]);
        if (pd < 1.9) {
          pierMask = Math.max(pierMask, 1.0 - pd / 1.9);
        }
      }

      rPositions.push(wx, waterSurfaceY, z);
      rUvs.push(tx, tz * 14);
      rDepths.push(depth);
      rPierMask.push(pierMask);
    }
  }

  const rowStride = riverColsX + 1;
  for (let iz = 0; iz < riverSegsZ; iz++) {
    for (let ix = 0; ix < riverColsX; ix++) {
      const a = iz * rowStride + ix;
      const b = a + 1;
      const c = a + rowStride;
      const d = c + 1;
      rIndices.push(a, c, b);
      rIndices.push(b, c, d);
    }
  }

  const riverGeo = trackGeo(new THREE.BufferGeometry());
  riverGeo.setAttribute('position', new THREE.Float32BufferAttribute(rPositions, 3));
  riverGeo.setAttribute('uv', new THREE.Float32BufferAttribute(rUvs, 2));
  riverGeo.setAttribute('aDepth', new THREE.Float32BufferAttribute(rDepths, 1));
  riverGeo.setAttribute('aPierMask', new THREE.Float32BufferAttribute(rPierMask, 1));
  riverGeo.setIndex(rIndices);
  riverGeo.computeVertexNormals();
  const riverMesh = new THREE.Mesh(riverGeo, matRiver);
  sceneGroup.add(riverMesh);

  // Natural shoreline river cobbles tucked cleanly where water meets the bank slopes
  const cobbleGeo = trackGeo(new THREE.DodecahedronGeometry(0.42, 1));
  const cobbleRand = seededRand(8831);
  const cobblePositions: Array<{ x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number }> = [];
  for (let i = 0; i < 160; i++) {
    const z = -112 + cobbleRand() * 224;
    if (Math.abs(z - -48) < 5.2 || Math.abs(z - 34) < 5.2) continue;
    const rx = getRiverCenterX(z);
    const side = cobbleRand() > 0.5 ? 1 : -1;
    const x = rx + side * (5.6 + cobbleRand() * 2.2);
    const groundY = sampleVisualTerrainY(x, z);
    if (groundY > -0.65 && groundY < 0.05) {
      cobblePositions.push({
        x,
        y: groundY - 0.04,
        z,
        sx: 0.7 + cobbleRand() * 1.15,
        sy: 0.35 + cobbleRand() * 0.4,
        sz: 0.65 + cobbleRand() * 0.95,
        ry: cobbleRand() * Math.PI * 2,
      });
    }
  }
  if (cobblePositions.length > 0) {
    const cobbleInst = new THREE.InstancedMesh(cobbleGeo, matRock, cobblePositions.length);
    for (let i = 0; i < cobblePositions.length; i++) {
      const c = cobblePositions[i];
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(0, c.ry, 0);
      dummy.scale.set(c.sx, c.sy, c.sz);
      dummy.updateMatrix();
      cobbleInst.setMatrixAt(i, dummy.matrix);
    }
    cobbleInst.instanceMatrix.needsUpdate = true;
    cobbleInst.computeBoundingSphere();
    cobbleInst.userData.surfaceMaterial = 'gravel';
    sceneGroup.add(cobbleInst);
  }

  // Two anchored timber-and-steel Road Bridges with full concrete abutments, 45° wing-walls & flush approach ramps
  const buildBridge = (bz: number): void => {
    const rx = getRiverCenterX(bz);
    const bridgeLen = 19.5;
    const bridgeW = 5.4;
    const halfSpan = bridgeLen * 0.5;

    // Main bridge deck (top at y = 0.24m)
    addSolidBox(rx, 0.12, bz, bridgeLen, 0.24, bridgeW, matWoodFloor, 'wood');

    // Physics + solid visual approach ramps bridging deck (y = 0.24) down to bank ground (y = 0.04)
    const rampLen = 3.2;
    const slopeAngle = Math.atan2(0.2, rampLen);
    const slopeHyp = Math.hypot(rampLen, 0.2);

    const addVisualRamp = (cx: number, tiltZ: number): void => {
      const rampMesh = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(slopeHyp, 0.2, bridgeW)),
        matBaseConcrete,
      );
      rampMesh.position.set(cx, 0.04, bz);
      rampMesh.rotation.z = tiltZ;
      rampMesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
      rampMesh.castShadow = !isSoftwareGl && qProfile.castShadows;
      rampMesh.userData.surfaceMaterial = 'concrete';
      sceneGroup.add(rampMesh);
      raycastMeshes.push(rampMesh);
    };

    physics.addRamp({
      minX: rx - halfSpan - rampLen,
      maxX: rx - halfSpan,
      minZ: bz - bridgeW * 0.5,
      maxZ: bz + bridgeW * 0.5,
      baseY: 0.04,
      topY: 0.24,
      riseAxis: '+x',
      surface: 'concrete',
    });
    addVisualRamp(rx - halfSpan - rampLen * 0.5, slopeAngle);

    physics.addRamp({
      minX: rx + halfSpan,
      maxX: rx + halfSpan + rampLen,
      minZ: bz - bridgeW * 0.5,
      maxZ: bz + bridgeW * 0.5,
      baseY: 0.04,
      topY: 0.24,
      riseAxis: '-x',
      surface: 'concrete',
    });
    addVisualRamp(rx + halfSpan + rampLen * 0.5, -slopeAngle);

    // Concrete end abutments & flared 45-deg corner wing-walls anchoring bridge ends firmly into riverbanks
    for (const endSide of [-1, 1]) {
      const endX = rx + endSide * (halfSpan - 0.55);
      // Heavy concrete headwall abutment descending cleanly to y = -2.2m (top = 0.24m)
      addSolidBox(endX, -0.98, bz, 2.2, 2.44, bridgeW + 1.3, matBaseConcrete, 'concrete', false);

      // Pair of corner wing-walls flaring out at 45° to connect bridge corners into sloping banks
      for (const zSide of [-1, 1]) {
        const wing = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(3.2, 2.3, 0.58)),
          matBaseConcrete,
        );
        wing.position.set(
          endX + endSide * 1.35,
          -0.88,
          bz + zSide * (bridgeW * 0.5 + 0.95),
        );
        wing.rotation.y = endSide * zSide * -Math.PI * 0.22;
        wing.castShadow = !isSoftwareGl && qProfile.castShadows;
        wing.receiveShadow = !isSoftwareGl && qProfile.castShadows;
        wing.userData.surfaceMaterial = 'concrete';
        sceneGroup.add(wing);
        raycastMeshes.push(wing);
        // Corner pilaster cap rising to deck guardrail height
        addSolidBox(
          endX + endSide * 0.3,
          0.62,
          bz + zSide * (bridgeW * 0.5 + 0.12),
          0.64,
          1.2,
          0.64,
          matBaseConcrete,
          'concrete',
        );
      }
    }

    // Side steel guardrails + deep submerged riverbed support piers (descending to y = -2.25m)
    for (const side of [-1, 1]) {
      addSolidBox(rx, 0.72, bz + side * (bridgeW * 0.5 - 0.14), bridgeLen, 0.96, 0.2, matSteel, 'metal');
      for (const px of [-6.0, 0, 6.0]) {
        addSolidBox(rx + px, -1.0, bz + side * (bridgeW * 0.42), 0.72, 2.5, 0.72, matBaseConcrete, 'concrete', false);
      }
    }
  };
  buildBridge(-48);
  buildBridge(34);

  // === 3. PAVED HIGHWAY ROAD & BRANCHING DIRT PATHS (Solid Raised Thin Pads -> Zero Z-Fighting) ===
  const addFlatRoadStrip = (
    x: number,
    z: number,
    w: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial,
    topY = 0.05,
  ): void => {
    const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, topY, d)), mat);
    m.position.set(x, topY * 0.5, z);
    m.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    m.userData.surfaceMaterial = surface;
    sceneGroup.add(m);
    raycastMeshes.push(m);
    physics.addSurfaceZone({ minX: x - w * 0.5, maxX: x + w * 0.5, minZ: z - d * 0.5, maxZ: z + d * 0.5, surface });
  };

  // Main North-South Paved Highway along X = -2 (Z in [-112, 112])
  addFlatRoadStrip(-2, 0, 7.6, 224, matRoad, 'asphalt', 0.05);
  // Paved Military Base Entry Spur (Z = -48, X in [1.8, 16]) and South Spur (Z = 34, X in [1.8, 16])
  addFlatRoadStrip(8.9, -48, 14.2, 6.4, matRoad, 'asphalt', 0.055);
  addFlatRoadStrip(8.9, 34, 14.2, 6.4, matRoad, 'asphalt', 0.055);
  // Dirt tracks linking bridges to NW Village, SW Village & Lone Cabins
  addFlatRoadStrip(-52, -48, 38, 4.6, matDirtPath, 'gravel', 0.04);
  addFlatRoadStrip(-58, -60, 4.6, 24, matDirtPath, 'gravel', 0.04);
  addFlatRoadStrip(-54, 34, 38, 4.6, matDirtPath, 'gravel', 0.04);
  addFlatRoadStrip(-62, 54, 4.6, 38, matDirtPath, 'gravel', 0.04);
  addFlatRoadStrip(-11.5, -48, 13.0, 4.8, matDirtPath, 'gravel', 0.04);
  addFlatRoadStrip(-10.5, 34, 11.0, 4.8, matDirtPath, 'gravel', 0.04);

  // === 4. ENTERABLE FURNISHED TIMBER CABIN HELPER (Villages & Lone Cabins) ===
  const penetrableSystem = new PenetrableSurfaceSystem(sceneGroup, { isSoftwareGl });
  let nextTimberPenIdx = 0;

  const buildCabin = (
    cx: number,
    cz: number,
    w: number,
    d: number,
    doorSideA: 'north' | 'south' | 'east' | 'west',
    doorSideB?: 'north' | 'south' | 'east' | 'west',
  ): void => {
    const baseY = Math.max(0, sampleVisualTerrainY(cx, cz));
    const h = 3.1;
    const t = 0.28;
    const doorW = 1.95;
    const doorH = 2.35;

    // Raised timber deck + foundation skirt so zero floating on sloped ground
    addSolidBox(cx, baseY + 0.08, cz, w, 0.42, d, matWoodFloor, 'wood', false);
    const floorTop = baseY + 0.29;
    physics.addInteriorZone({
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minY: floorTop,
      maxY: floorTop + h + 0.4,
      minZ: cz - d * 0.5,
      maxZ: cz + d * 0.5,
      material: 'wood',
    });

    const registerCabinWoodWall = (
      wx: number,
      wy: number,
      wz: number,
      ww: number,
      wh: number,
      wd: number,
    ): THREE.Mesh => {
      const m = addSolidBox(wx, wy, wz, ww, wh, wd, matWood, 'wood');
      if (wh >= 0.85 && Math.min(ww, wd) <= 0.34 && Math.max(ww, wd) >= 0.45) {
        const faceAxis = ww < wd ? 'x' : 'z';
        penetrableSystem.registerSurface({
          id: `timber_cabin_wood_${nextTimberPenIdx++}`,
          mesh: m,
          kind: 'plywood',
          width: faceAxis === 'x' ? wd : ww,
          height: wh,
          thickness: faceAxis === 'x' ? ww : wd,
          faceAxis,
          floorY: floorTop,
          maxHoles: 6,
          baseRadiusM: 0.132,
        });
      }
      return m;
    };

    const buildWallSide = (side: 'north' | 'south' | 'east' | 'west', hasDoor: boolean): void => {
      const isNS = side === 'north' || side === 'south';
      const span = isNS ? w : d - t * 2;
      const fixed =
        side === 'north'
          ? cz - (d - t) * 0.5
          : side === 'south'
            ? cz + (d - t) * 0.5
            : side === 'west'
              ? cx - (w - t) * 0.5
              : cx + (w - t) * 0.5;

      if (hasDoor) {
        const seg = (span - doorW) * 0.5;
        const headerH = h - doorH;
        if (isNS) {
          registerCabinWoodWall(cx - (doorW + seg) * 0.5, floorTop + h * 0.5, fixed, seg, h, t);
          registerCabinWoodWall(cx + (doorW + seg) * 0.5, floorTop + h * 0.5, fixed, seg, h, t);
          registerCabinWoodWall(cx, floorTop + doorH + headerH * 0.5, fixed, doorW, headerH, t);
        } else {
          registerCabinWoodWall(fixed, floorTop + h * 0.5, cz - (doorW + seg) * 0.5, t, h, seg);
          registerCabinWoodWall(fixed, floorTop + h * 0.5, cz + (doorW + seg) * 0.5, t, h, seg);
          registerCabinWoodWall(fixed, floorTop + doorH + headerH * 0.5, cz, t, headerH, doorW);
        }
      } else {
        const winW = 1.9;
        const sillH = 1.04;
        const headerH = 0.84;
        const jambH = h - sillH - headerH;
        const sideSeg = Math.max(0.45, (span - winW) * 0.5);
        if (isNS) {
          registerCabinWoodWall(cx, floorTop + sillH * 0.5, fixed, span, sillH, t);
          registerCabinWoodWall(cx, floorTop + h - headerH * 0.5, fixed, span, headerH, t);
          registerCabinWoodWall(cx - (winW + sideSeg) * 0.5, floorTop + sillH + jambH * 0.5, fixed, sideSeg, jambH, t);
          registerCabinWoodWall(cx + (winW + sideSeg) * 0.5, floorTop + sillH + jambH * 0.5, fixed, sideSeg, jambH, t);
        } else {
          registerCabinWoodWall(fixed, floorTop + sillH * 0.5, cz, t, sillH, span);
          registerCabinWoodWall(fixed, floorTop + h - headerH * 0.5, cz, t, headerH, span);
          registerCabinWoodWall(fixed, floorTop + sillH + jambH * 0.5, cz - (winW + sideSeg) * 0.5, t, jambH, sideSeg);
          registerCabinWoodWall(fixed, floorTop + sillH + jambH * 0.5, cz + (winW + sideSeg) * 0.5, t, jambH, sideSeg);
        }
      }
    };

    buildWallSide('north', doorSideA === 'north' || doorSideB === 'north');
    buildWallSide('south', doorSideA === 'south' || doorSideB === 'south');
    buildWallSide('east', doorSideA === 'east' || doorSideB === 'east');
    buildWallSide('west', doorSideA === 'west' || doorSideB === 'west');

    // Roof overhang + pitched gable crown
    addSolidBox(cx, floorTop + h + 0.12, cz, w + 0.9, 0.24, d + 0.9, matRoof, 'metal');
    const ridge = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.12, Math.min(w, d) * 0.62, 1.3, 4)),
      matRoof,
    );
    ridge.position.set(cx, floorTop + h + 0.85, cz);
    ridge.rotation.y = Math.PI * 0.25;
    ridge.scale.set(w / Math.min(w, d), 1, d / Math.min(w, d));
    ridge.castShadow = !isSoftwareGl && qProfile.castShadows;
    sceneGroup.add(ridge);

    // Interior furniture desk
    buildOfficeDesk(propCtx, cx + w * 0.22, floorTop, cz - d * 0.2, 0.1, matWood, matSteel);
  };

  // --- Village Cluster 1: North-West Logging Village ---
  buildCabin(-58, -64, 9.0, 7.2, 'south', 'east');
  buildCabin(-72, -52, 8.6, 6.8, 'east', 'south');
  buildCabin(-48, -56, 8.2, 6.6, 'south', 'west');
  buildRustedVehicle(propCtx, 'pickup', -56, 0, -52, 0.52, vehBlue);
  addSolidBox(-64, 0.55, -56, 2.2, 1.1, 1.4, matWood, 'wood'); // village woodpile

  // --- Village Cluster 2: South-West Riverside Hamlet ---
  buildCabin(-58, 52, 9.2, 7.2, 'north', 'east');
  buildCabin(-74, 62, 8.6, 6.8, 'east', 'north');
  buildCabin(-56, 70, 8.4, 6.6, 'north', 'west');
  buildRustedVehicle(propCtx, 'lada', -64, 0, 46, -0.35, vehOlive);
  addSolidBox(-65, 0.65, 58, 1.6, 1.3, 1.6, matBaseConcrete, 'concrete'); // stone village well

  // --- Three Lone Forest Cabins ---
  buildCabin(78, -84, 8.4, 6.8, 'south', 'west');
  buildCabin(-96, 4, 8.2, 6.6, 'east');
  buildCabin(84, 82, 8.4, 6.8, 'north', 'west');

  // === 5. MILITARY BASE COMPOUND (X in [12, 96], Z in [-62, 58], FLAT Y = 0) ===
  // Concrete base apron pad (cleanly stops outside the bunker stairwell opening!)
  // West apron strip: X in [12, 42.5], Z in [-62, 58]
  addFlatRoadStrip(27.25, -2.0, 30.5, 120.0, matBaseConcrete, 'concrete', 0.04);
  // North-East apron above bunker: X in [42.5, 65], Z in [-62, -16.5]
  addFlatRoadStrip(53.75, -39.25, 22.5, 45.5, matBaseConcrete, 'concrete', 0.04);
  // South-East apron below bunker: X in [42.5, 65], Z in [4.5, 58]
  addFlatRoadStrip(53.75, 31.25, 22.5, 53.5, matBaseConcrete, 'concrete', 0.04);

  // Military Base Perimeter Concrete Curb + Non-Vaultable Bullet-Breakable Security Glass Barriers
  const fencePosts: Array<[number, number]> = [];
  interface BreakableGlassRecord {
    id: string;
    mesh: THREE.Mesh;
    shattered: boolean;
    center: THREE.Vector3;
  }
  interface GlassShard {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    rotVel: THREE.Vector3;
    life: number;
  }
  const breakablesById = new Map<string, BreakableGlassRecord>();
  const activeGlassShards: GlassShard[] = [];
  const shardGeo = trackGeo(new THREE.TetrahedronGeometry(0.11, 0));
  let breakableCounter = 0;

  const addFence = (x1: number, z1: number, x2: number, z2: number): void => {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const cx = (x1 + x2) * 0.5;
    const cz = (z1 + z2) * 0.5;
    const alongX = Math.abs(dx) >= Math.abs(dz);
    // Solid 0.9m reinforced concrete base curb (becomes vaultable once the upper thick glass bay is shot out)
    addSolidBox(cx, 0.45, cz, alongX ? len : 0.36, 0.9, alongX ? 0.36 : len, matBaseConcrete, 'concrete');

    const n = Math.max(2, Math.round(len / 4.2));
    for (let i = 0; i <= n; i++) {
      fencePosts.push([x1 + (dx * i) / n, z1 + (dz * i) / n]);
    }
    for (let i = 0; i < n; i++) {
      const bx = x1 + (dx * (i + 0.5)) / n;
      const bz = z1 + (dz * (i + 0.5)) / n;
      const bayLen = Math.max(0.4, len / n - 0.14);
      const breakableId = `tl_glass_${++breakableCounter}`;
      const panel = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(alongX ? bayLen : 0.08, 2.0, alongX ? 0.08 : bayLen)),
        matBarrierGlass,
      );
      panel.position.set(bx, 1.9, bz);
      panel.userData.surfaceMaterial = 'glass';
      panel.userData.ballisticMaterial = 'glass';
      panel.userData.breakableGlass = true;
      panel.userData.noVault = true;
      panel.userData.shattered = false;
      panel.userData.breakableId = breakableId;
      sceneGroup.add(panel);
      raycastMeshes.push(panel);

      physics.addBox({
        id: breakableId,
        minX: bx - (alongX ? bayLen * 0.5 : 0.12),
        maxX: bx + (alongX ? bayLen * 0.5 : 0.12),
        minY: 0.9,
        maxY: 2.95,
        minZ: bz - (alongX ? 0.12 : bayLen * 0.5),
        maxZ: bz + (alongX ? 0.12 : bayLen * 0.5),
        surface: 'glass',
        blocksMovement: true,
      });

      breakablesById.set(breakableId, {
        id: breakableId,
        mesh: panel,
        shattered: false,
        center: new THREE.Vector3(bx, 1.9, bz),
      });
    }
  };

  // Outer Military Base Fence (gates at West Z=-48, West Z=34, North X=52, South X=52)
  addFence(12, -62, 46, -62);
  addFence(58, -62, 96, -62);
  addFence(12, 58, 46, 58);
  addFence(58, 58, 96, 58);
  addFence(96, -61.8, 96, 57.8);
  addFence(12, -61.8, 12, -52.5);
  addFence(12, -43.5, 12, 29.5);
  addFence(12, 38.5, 12, 57.8);

  // --- 5A. FENCED COMMS STATION COMPOUND + TALL RADAR TOWER (X in [15, 36], Z in [-58, -32]) ---
  addFence(15, -58, 36, -58);
  addFence(15, -32, 23, -32);
  addFence(28.5, -32, 36, -32);
  addFence(15, -57.8, 15, -32.2);
  addFence(36, -57.8, 36, -32.2);

  const radar = buildRadarTower(propCtx, 25.5, 0.04, -48.5, 19.5);
  // Enterable Comms Control Shack beside the Radar Tower
  addSolidBox(22.0, 0.12, -37.5, 7.6, 0.16, 5.2, matBunkerConcrete, 'concrete', false);
  addSolidBox(22.0, 1.7, -40.0, 7.6, 3.0, 0.28, matBunkerConcrete);
  addSolidBox(18.34, 1.7, -37.5, 0.28, 3.0, 4.72, matBunkerConcrete);
  addSolidBox(25.66, 1.7, -37.5, 0.28, 3.0, 4.72, matBunkerConcrete);
  // Front South wall with open doorway
  addSolidBox(19.6, 1.7, -35.0, 2.8, 3.0, 0.28, matBunkerConcrete);
  addSolidBox(24.4, 1.7, -35.0, 2.8, 3.0, 0.28, matBunkerConcrete);
  addSolidBox(22.0, 2.85, -35.0, 2.0, 0.7, 0.28, matBunkerConcrete);
  addSolidBox(22.0, 3.32, -37.5, 8.0, 0.24, 5.6, matRoof, 'metal');
  buildOfficeDesk(propCtx, 22.0, 0.2, -38.8, 0, matSteel, matGunMetal);

  // --- 5B. TWO LARGE GARAGE-STYLE VEHICLE BUILDINGS (X = 25, Z = -14 & Z = 10) ---
  const buildMilitaryGarage = (gx: number, gz: number, vehicleStyle: 'zil_truck' | 'pickup'): void => {
    const gw = 16.0;
    const gd = 12.0;
    const gh = 5.0;
    const t = 0.36;
    // Concrete bay floor slab (y top = 0.12m)
    addSolidBox(gx, 0.06, gz, gw, 0.12, gd, matBunkerConcrete, 'concrete', false);
    physics.addInteriorZone({
      minX: gx - gw * 0.5,
      maxX: gx + gw * 0.5,
      minY: 0,
      maxY: gh + 0.5,
      minZ: gz - gd * 0.5,
      maxZ: gz + gd * 0.5,
      material: 'concrete',
    });
    // North & South solid corrugated/concrete side walls
    addSolidBox(gx, 0.12 + gh * 0.5, gz - gd * 0.5 + t * 0.5, gw, gh, t, matGarageMetal, 'metal');
    addSolidBox(gx, 0.12 + gh * 0.5, gz + gd * 0.5 - t * 0.5, gw, gh, t, matGarageMetal, 'metal');
    // West back wall with personnel door
    addSolidBox(gx - gw * 0.5 + t * 0.5, 0.12 + gh * 0.5, gz - 3.6, t, gh, 4.1, matGarageMetal, 'metal');
    addSolidBox(gx - gw * 0.5 + t * 0.5, 0.12 + gh * 0.5, gz + 3.6, t, gh, 4.1, matGarageMetal, 'metal');
    addSolidBox(gx - gw * 0.5 + t * 0.5, 0.12 + 3.85, gz, t, 2.3, 3.1, matGarageMetal, 'metal');
    // East front facade with TWO wide open garage vehicle bays (center pillar + header beam)
    addSolidBox(gx + gw * 0.5 - t * 0.5, 0.12 + gh * 0.5, gz, t, gh, 1.2, matBaseConcrete, 'concrete');
    addSolidBox(gx + gw * 0.5 - t * 0.5, 0.12 + 4.35, gz, t, 1.3, gd - t * 2, matGarageMetal, 'metal');
    // Roof slab + exposed interior steel trusses
    addSolidBox(gx, 0.12 + gh + 0.16, gz, gw + 0.6, 0.32, gd + 0.6, matRoof, 'metal');
    for (const tx of [-4.5, 0, 4.5]) {
      const truss = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 0.34, gd - 0.8)), matSteel);
      truss.position.set(gx + tx, gh - 0.1, gz);
      sceneGroup.add(truss);
    }
    // Parked vehicle inside bay + mechanic workbench
    buildRustedVehicle(propCtx, vehicleStyle, gx + 0.5, 0.12, gz - 2.8, Math.PI * 0.5, vehOlive);
    buildOfficeDesk(propCtx, gx - 5.2, 0.12, gz + 4.2, 0, matSteel, matGunMetal);
  };
  buildMilitaryGarage(25.0, -14.0, 'zil_truck');
  buildMilitaryGarage(25.0, 10.0, 'pickup');

  // --- 5C. LONG PAVED AIRSTRIP WITH PARALLEL ILLUMINATED EDGE LIGHTS (X = 78, Z in [-58, 54]) ---
  const runwayX = 78.0;
  const runwayW = 18.0;
  const runwayLen = 112.0;
  const runwayCenterZ = -2.0;
  // Runway tarmac slab (y top = 0.08m)
  addFlatRoadStrip(runwayX, runwayCenterZ, runwayW, runwayLen, matRunway, 'asphalt', 0.08);
  // Painted white centerline dashes & threshold piano keys (solid 0.025m elevated above tarmac -> ZERO z-fighting)
  for (let dz = -48; dz <= 44; dz += 10) {
    const dash = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.024, 5.2)), matRunwayPaint);
    dash.position.set(runwayX, 0.092, dz);
    sceneGroup.add(dash);
  }
  for (const endZ of [-54.5, 50.5]) {
    for (let kx = -6.5; kx <= 6.5; kx += 2.6) {
      const key = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 0.024, 4.6)), matRunwayPaint);
      key.position.set(runwayX + kx, 0.092, endZ);
      sceneGroup.add(key);
    }
  }
  // Parallel Runway Edge Lights along BOTH edges (X = 68.4 and X = 87.6) + Green Threshold Lights
  const edgeLightPosts: Array<[number, number, boolean]> = [];
  for (let lz = -56; lz <= 52; lz += 12) {
    edgeLightPosts.push([runwayX - runwayW * 0.5 - 0.6, lz, false]);
    edgeLightPosts.push([runwayX + runwayW * 0.5 + 0.6, lz, false]);
  }
  for (const endZ of [-58.4, 54.4]) {
    for (const tx of [-7.0, -3.5, 0, 3.5, 7.0]) {
      edgeLightPosts.push([runwayX + tx, endZ, true]);
    }
  }
  const pedGeo = trackGeo(new THREE.CylinderGeometry(0.08, 0.12, 0.42, 8));
  const bulbGeo = trackGeo(new THREE.SphereGeometry(0.14, 8, 8));
  const pedInst = new THREE.InstancedMesh(pedGeo, matSteel, edgeLightPosts.length);
  edgeLightPosts.forEach(([lx, lz, isThresh], idx) => {
    dummy.position.set(lx, 0.21, lz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    pedInst.setMatrixAt(idx, dummy.matrix);

    const bulb = new THREE.Mesh(bulbGeo, isThresh ? matThresholdGreen : matRunwayBulb);
    bulb.position.set(lx, 0.48, lz);
    sceneGroup.add(bulb);
  });
  pedInst.instanceMatrix.needsUpdate = true;
  pedInst.computeBoundingSphere();
  sceneGroup.add(pedInst);

  // Subtle glowing PointLights spaced along runway (capped by GraphicsQuality)
  const runwayGlowCount = Math.min(4, Math.max(1, Math.floor(qProfile.maxAccentLights * 0.3)));
  for (let i = 0; i < runwayGlowCount; i++) {
    const rz = -42 + (i / Math.max(1, runwayGlowCount - 1)) * 84;
    const rl = new THREE.PointLight(0xffd27d, 5.5, 22, 1.7);
    rl.position.set(runwayX, 1.4, rz);
    sceneGroup.add(rl);
    nightLights.push({ light: rl, baseLightIntensity: 6.2 });
  }

  // Windsock Mast next to Airstrip (rotates and lifts dynamically to match live wind vector)
  const sockPole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.06, 0.09, 6.2, 8)), matSteel);
  sockPole.position.set(65.5, 3.1, -32.0);
  const windsockPivot = new THREE.Group();
  windsockPivot.position.set(65.5, 6.08, -32.0);
  const windsockArm = new THREE.Group();
  const windsockCone = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.18, 0.42, 2.2, 10, 1, true)), matWindsock);
  windsockCone.rotation.z = Math.PI * 0.5;
  windsockCone.position.set(1.15, 0, 0);
  windsockArm.add(windsockCone);
  windsockPivot.add(windsockArm);
  sceneGroup.add(sockPole, windsockPivot);

  // --- 5D. ELEVATED HELIPAD WITH ACCESS STAIRS & REALISTIC HELICOPTER PROP (X = 48, Z = 36) ---
  const heliX = 48.0;
  const heliZ = 36.0;
  const heliH = 1.6;
  // Elevated concrete pad platform (16m x 16m, top = 1.6m)
  addSolidBox(heliX, heliH * 0.5, heliZ, 16.0, heliH, 16.0, matBaseConcrete, 'concrete');
  // Painted yellow helipad circle & "H" bars elevated +0.025m above pad -> ZERO z-fighting
  const hRing = new THREE.Mesh(trackGeo(new THREE.RingGeometry(4.6, 5.2, 32)), matYellowPaint);
  hRing.rotation.x = -Math.PI * 0.5;
  hRing.position.set(heliX, heliH + 0.028, heliZ);
  sceneGroup.add(hRing);
  const hLeft = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.7, 0.026, 4.8)), matYellowPaint);
  hLeft.position.set(heliX - 1.5, heliH + 0.026, heliZ);
  const hRight = hLeft.clone();
  hRight.position.set(heliX + 1.5, heliH + 0.026, heliZ);
  const hMid = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 0.026, 0.7)), matYellowPaint);
  hMid.position.set(heliX, heliH + 0.026, heliZ);
  sceneGroup.add(hLeft, hRight, hMid);

  // Helipad safety railings (leaving open West stair landing at Z in [34.2, 37.8])
  addSolidBox(heliX, heliH + 0.52, heliZ - 7.85, 16.0, 1.0, 0.14, matSteel, 'metal');
  addSolidBox(heliX, heliH + 0.52, heliZ + 7.85, 16.0, 1.0, 0.14, matSteel, 'metal');
  addSolidBox(heliX + 7.85, heliH + 0.52, heliZ, 0.14, 1.0, 15.5, matSteel, 'metal');
  addSolidBox(heliX - 7.85, heliH + 0.52, heliZ - 4.8, 0.14, 1.0, 6.0, matSteel, 'metal');
  addSolidBox(heliX - 7.85, heliH + 0.52, heliZ + 4.8, 0.14, 1.0, 6.0, matSteel, 'metal');

  // Wide Steel Access Staircase rising along +X from X = 36.2 (y = 0.04) up to X = 40.0 (y = 1.6)
  physics.addRamp({
    minX: 36.2,
    maxX: 40.0,
    minZ: heliZ - 1.8,
    maxZ: heliZ + 1.8,
    baseY: 0.04,
    topY: heliH,
    riseAxis: '+x',
    surface: 'metal',
  });
  const hSteps = 9;
  const hStepW = 3.8 / hSteps;
  const hStepH = (heliH - 0.04) / hSteps;
  const hStepGeo = trackGeo(new THREE.BoxGeometry(hStepW - 0.004, hStepH, 3.6));
  const hStepInst = new THREE.InstancedMesh(hStepGeo, matSteel, hSteps);
  for (let i = 0; i < hSteps; i++) {
    dummy.position.set(36.2 + (i + 0.5) * hStepW, 0.04 + (i + 0.5) * hStepH, heliZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    hStepInst.setMatrixAt(i, dummy.matrix);
  }
  hStepInst.instanceMatrix.needsUpdate = true;
  hStepInst.computeBoundingSphere();
  sceneGroup.add(hStepInst);
  raycastMeshes.push(hStepInst);

  // Realistic 15-Part Tactical Helicopter Prop resting on the Helipad
  buildRealisticHelicopterProp(propCtx, heliX + 0.4, heliH, heliZ, -Math.PI * 0.35);

  // --- 5E. REINFORCED ARMORY BUILDING (X = 50, Z = -40) ---
  const armX = 50.0;
  const armZ = -40.0;
  const armW = 14.0;
  const armD = 10.0;
  const armH = 3.8;
  addSolidBox(armX, 0.08, armZ, armW, 0.16, armD, matBunkerConcrete, 'concrete', false);
  physics.addInteriorZone({
    minX: armX - 7,
    maxX: armX + 7,
    minY: 0,
    maxY: armH + 0.4,
    minZ: armZ - 5,
    maxZ: armZ + 5,
    material: 'concrete',
  });
  // Armory perimeter concrete walls with South & West tactical doorways
  addSolidBox(armX, 0.16 + armH * 0.5, armZ - 4.8, armW, armH, 0.4, matBunkerConcrete);
  addSolidBox(armX + 6.8, 0.16 + armH * 0.5, armZ, 0.4, armH, armD - 0.8, matBunkerConcrete);
  // South doorway
  addSolidBox(armX - 4.2, 0.16 + armH * 0.5, armZ + 4.8, 5.6, armH, 0.4, matBunkerConcrete);
  addSolidBox(armX + 4.2, 0.16 + armH * 0.5, armZ + 4.8, 5.6, armH, 0.4, matBunkerConcrete);
  addSolidBox(armX, 0.16 + 3.2, armZ + 4.8, 2.8, 1.2, 0.4, matBunkerConcrete);
  // West doorway
  addSolidBox(armX - 6.8, 0.16 + armH * 0.5, armZ - 3.0, 0.4, armH, 3.2, matBunkerConcrete);
  addSolidBox(armX - 6.8, 0.16 + armH * 0.5, armZ + 3.0, 0.4, armH, 3.2, matBunkerConcrete);
  addSolidBox(armX - 6.8, 0.16 + 3.2, armZ, 0.4, 1.2, 2.8, matBunkerConcrete);
  addSolidBox(armX, 0.16 + armH + 0.16, armZ, armW + 0.6, 0.32, armD + 0.6, matRoof, 'metal');

  // Armory signage + 4 interior Weapon Racks & Tactical Table
  const armSignTex = trackTex(createStencilSignTexture('SECTOR 04 · ARMORY', 'RESTRICTED MUNITIONS', '#f59e0b', '#1b2226', maxAniso));
  const armSign = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(3.2, 0.85)),
    trackMat(new THREE.MeshStandardMaterial({ map: armSignTex, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  );
  armSign.position.set(armX, 3.25, armZ + 5.04);
  sceneGroup.add(armSign);
  buildArmoryWeaponRack(propCtx, armX - 3.2, 0.16, armZ - 4.1, 0, matSteel, matGunMetal, matWood);
  buildArmoryWeaponRack(propCtx, armX + 0.0, 0.16, armZ - 4.1, 0, matSteel, matGunMetal, matWood);
  buildArmoryWeaponRack(propCtx, armX + 3.2, 0.16, armZ - 4.1, 0, matSteel, matGunMetal, matWood);
  buildArmoryWeaponRack(propCtx, armX + 6.1, 0.16, armZ, -Math.PI * 0.5, matSteel, matGunMetal, matWood);
  buildOfficeDesk(propCtx, armX, 0.16, armZ + 0.2, 0, matSteel, matGunMetal);

  // --- 5F. UNDERGROUND BUNKER WITH ONE SINGLE ENTRY/EXIT DOORWAY (X in [43, 62], Z in [-16, 4]) ---
  const bFloorY = -3.6;
  const bCeilY = -0.18; // Top of roof slab = 0.0m, flush with surrounding military base ground!
  // Subterranean Bunker Floor Slab (y top = -3.6m)
  addSolidBox(53.0, bFloorY - 0.16, -6.0, 18.8, 0.32, 20.4, matBunkerConcrete, 'concrete', false);
  // Subterranean Bunker Outer Walls (y: -3.6..0.0)
  addSolidBox(62.2, -1.8, -6.0, 0.45, 3.6, 20.4, matBunkerConcrete); // East wall
  addSolidBox(53.0, -1.8, -16.0, 18.8, 3.6, 0.45, matBunkerConcrete); // North wall
  addSolidBox(53.0, -1.8, 4.0, 18.8, 3.6, 0.45, matBunkerConcrete); // South wall
  addSolidBox(43.8, -1.8, -12.4, 0.45, 3.6, 7.2, matBunkerConcrete); // West wall North of stairs
  addSolidBox(43.8, -1.8, 0.4, 0.45, 3.6, 7.2, matBunkerConcrete); // West wall South of stairs

  // Bunker Roof Slabs at Grade Level (y top = 0.02m, leaving exact stairwell opening X in [43.8, 52.8], Z in [-8.4, -3.6]!)
  addSolidBox(53.0, bCeilY, -12.3, 18.8, 0.4, 7.8, matBaseConcrete, 'concrete', false); // North roof
  addSolidBox(53.0, bCeilY, 0.3, 18.8, 0.4, 7.8, matBaseConcrete, 'concrete', false); // South roof
  addSolidBox(57.6, bCeilY, -6.0, 9.6, 0.4, 4.8, matBaseConcrete, 'concrete', false); // East roof over main bunker chamber

  // Surface Concrete Entry Hood over the Stairwell with ONE SINGLE BLAST DOORWAY facing West (X = 43.2)
  addSolidBox(48.2, 1.5, -8.6, 9.8, 3.0, 0.4, matBunkerConcrete); // Hood North wall
  addSolidBox(48.2, 1.5, -3.4, 9.8, 3.0, 0.4, matBunkerConcrete); // Hood South wall
  addSolidBox(52.9, 1.5, -6.0, 0.4, 3.0, 5.2, matBunkerConcrete); // Hood East end wall
  addSolidBox(48.2, 3.16, -6.0, 10.2, 0.32, 5.6, matBunkerConcrete); // Hood Roof
  // Single West Entry/Exit Blast Door Frame (2.4m wide opening centered at Z = -6.0)
  addSolidBox(43.4, 1.5, -7.8, 0.45, 3.0, 1.4, matBunkerConcrete);
  addSolidBox(43.4, 1.5, -4.2, 0.45, 3.0, 1.4, matBunkerConcrete);
  addSolidBox(43.4, 2.75, -6.0, 0.45, 0.5, 2.4, matSteel, 'metal');
  const bunkerSignTex = trackTex(createStencilSignTexture('BUNKER 01 · SUB-LEVEL', 'SINGLE ACCESS ONLY', '#38bdf8', '#151c22', maxAniso));
  const bunkerSign = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(2.6, 0.68)),
    trackMat(new THREE.MeshStandardMaterial({ map: bunkerSignTex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  );
  bunkerSign.position.set(43.14, 2.72, -6.0);
  bunkerSign.rotation.y = -Math.PI * 0.5;
  sceneGroup.add(bunkerSign);

  // Concrete Stairwell Descending along +X from X = 43.8 (Y = 0) down to X = 52.6 (Y = -3.6)
  physics.addRamp({
    minX: 43.8,
    maxX: 52.6,
    minZ: -8.35,
    maxZ: -3.65,
    baseY: bFloorY,
    topY: 0.04,
    riseAxis: '-x',
    surface: 'concrete',
  });
  const bSteps = 18;
  const bStepW = 8.8 / bSteps;
  const bStepH = (0.04 - bFloorY) / bSteps;
  const bStepGeo = trackGeo(new THREE.BoxGeometry(bStepW - 0.004, bStepH, 4.7));
  const bStepInst = new THREE.InstancedMesh(bStepGeo, matBunkerConcrete, bSteps);
  for (let i = 0; i < bSteps; i++) {
    // High at X=43.8 (i=0), descending to Y=-3.6 at X=52.6 (i=17)
    const sx = 43.8 + (i + 0.5) * bStepW;
    const sy = 0.04 - (i + 0.5) * bStepH;
    dummy.position.set(sx, sy, -6.0);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bStepInst.setMatrixAt(i, dummy.matrix);
  }
  bStepInst.instanceMatrix.needsUpdate = true;
  bStepInst.computeBoundingSphere();
  bStepInst.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(bStepInst);
  raycastMeshes.push(bStepInst);

  // Subterranean Bunker Interior Furnishings, Acoustic Zone & Cool Fluorescent Lighting
  physics.addInteriorZone({ minX: 43.5, maxX: 62.0, minY: -4.0, maxY: 0.2, minZ: -16.0, maxZ: 4.0, material: 'concrete' });
  buildOfficeDesk(propCtx, 58.0, bFloorY, -12.0, -Math.PI * 0.5, matSteel, matGunMetal);
  buildOfficeDesk(propCtx, 58.0, bFloorY, 0.0, -Math.PI * 0.5, matSteel, matGunMetal);
  buildArmoryWeaponRack(propCtx, 48.0, bFloorY, -15.1, 0, matSteel, matGunMetal, matWood);
  buildArmoryWeaponRack(propCtx, 53.0, bFloorY, 3.1, Math.PI, matSteel, matGunMetal, matWood);
  addSolidBox(55.0, bFloorY + 0.6, -6.0, 2.2, 1.2, 1.4, matSteel, 'metal'); // center command console

  for (const [blx, blz] of [
    [55.5, -11.0],
    [55.5, -1.0],
    [48.5, -6.0],
  ]) {
    const strip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.4, 0.08, 0.2)), matBunkerStrip);
    strip.position.set(blx, -0.45, blz);
    sceneGroup.add(strip);
    const pl = new THREE.PointLight(0xbbe6ff, 7.5, 16, 1.7);
    pl.position.set(blx, -0.75, blz);
    sceneGroup.add(pl);
  }

  // Instanced Fence Posts across Base & Comms Compound
  const postGeo = trackGeo(new THREE.CylinderGeometry(0.06, 0.06, 3.05, 6));
  const postInst = new THREE.InstancedMesh(postGeo, matSteel, fencePosts.length);
  fencePosts.forEach(([px, pz], i) => {
    dummy.position.set(px, 1.52, pz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    postInst.setMatrixAt(i, dummy.matrix);
  });
  postInst.instanceMatrix.needsUpdate = true;
  postInst.computeBoundingSphere();
  sceneGroup.add(postInst);

  // === 6. MASSIVE INSTANCED PINE FOREST & BOULDERS (Scaled by GraphicsQuality) ===
  const rand = seededRand(202705);
  const targetTrees = Math.max(120, Math.round(340 * qProfile.foliageDensity));
  const treeSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];

  const isClearForTree = (tx: number, tz: number): boolean => {
    // Keep Military Base compound + airstrip clear
    if (tx >= 8 && tx <= 102 && tz >= -67 && tz <= 63) return false;
    // Keep paved highway clear
    if (Math.abs(tx - -2) < 8.5 && Math.abs(tz) < 120) return false;
    // Keep river channel & banks clear
    if (Math.abs(tx - getRiverCenterX(tz)) < 11.5) return false;
    // Keep bridge dirt approaches clear
    if (Math.abs(tz - -48) < 6.0 && tx > -78 && tx < 16) return false;
    if (Math.abs(tz - 34) < 6.0 && tx > -78 && tx < 16) return false;
    // Keep Village clusters & lone cabins clear
    if (tx >= -82 && tx <= -40 && tz >= -74 && tz <= -42) return false;
    if (tx >= -84 && tx <= -44 && tz >= 42 && tz <= 78) return false;
    if (Math.hypot(tx - 78, tz - -84) < 11) return false;
    if (Math.hypot(tx - -96, tz - 4) < 11) return false;
    if (Math.hypot(tx - 84, tz - 82) < 11) return false;
    return true;
  };

  for (let attempt = 0; attempt < 2600 && treeSpots.length < targetTrees; attempt++) {
    const tx = (rand() - 0.5) * 285;
    const tz = (rand() - 0.5) * 285;
    if (!isClearForTree(tx, tz)) continue;
    if (treeSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < 24.0)) continue;
    const ty = sampleVisualTerrainY(tx, tz);
    const scale = 0.9 + rand() * 0.55;
    const tint = new THREE.Color().setHSL(0.30 + (rand() - 0.5) * 0.05, 0.30 + rand() * 0.14, 0.18 + rand() * 0.09);
    treeSpots.push({ x: tx, y: ty, z: tz, scale, yaw: rand() * Math.PI * 2, tint });
  }

  const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.32, 3.6, 7, 3));
  trunkGeo.translate(0, 1.8, 0);
  assignHeightSwayAttribute(trunkGeo, 0, 3.6, 2.0);
  const tier1Geo = trackGeo(new THREE.ConeGeometry(2.5, 4.6, 9, 3));
  tier1Geo.translate(0, 4.5, 0);
  assignHeightSwayAttribute(tier1Geo, 0.8, 10.6, 1.5);
  const tier2Geo = trackGeo(new THREE.ConeGeometry(1.9, 3.8, 9, 2));
  tier2Geo.translate(0, 7.0, 0);
  assignHeightSwayAttribute(tier2Geo, 0.8, 10.6, 1.5);
  const tier3Geo = trackGeo(new THREE.ConeGeometry(1.25, 3.0, 8, 2));
  tier3Geo.translate(0, 9.2, 0);
  assignHeightSwayAttribute(tier3Geo, 0.8, 10.6, 1.5);

  const tCount = treeSpots.length;
  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBark, tCount);
  const tier1Inst = new THREE.InstancedMesh(tier1Geo, matPineNeedles, tCount);
  const tier2Inst = new THREE.InstancedMesh(tier2Geo, matPineNeedles, tCount);
  const tier3Inst = new THREE.InstancedMesh(tier3Geo, matPineNeedles, tCount);

  trunkInst.castShadow = !isSoftwareGl && qProfile.castShadows;
  tier1Inst.castShadow = !isSoftwareGl && qProfile.castShadows;

  treeSpots.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.1, t.z);
    dummy.rotation.set(0, t.yaw, 0);
    dummy.scale.setScalar(t.scale);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    tier1Inst.setMatrixAt(i, dummy.matrix);
    tier2Inst.setMatrixAt(i, dummy.matrix);
    tier3Inst.setMatrixAt(i, dummy.matrix);

    tier1Inst.setColorAt(i, t.tint);
    tier2Inst.setColorAt(i, t.tint.clone().offsetHSL(0, 0, 0.02));
    tier3Inst.setColorAt(i, t.tint.clone().offsetHSL(0, 0, 0.04));

    if (Math.abs(t.x) <= 112 && Math.abs(t.z) <= 112) {
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
      });
    }
  });

  for (const inst of [trunkInst, tier1Inst, tier2Inst, tier3Inst]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(inst);
  }
  raycastMeshes.push(trunkInst);

  // Botanical undergrowth: dense wind-reactive grass clumps, forest ferns, and leafy shrubs
  const isClearFoliage = (gx: number, gz: number): boolean => {
    if (gx >= 11 && gx <= 97 && gz >= -63 && gz <= 59) return false;
    if (Math.abs(gx - getRiverCenterX(gz)) < 7.6) return false;
    if (Math.abs(gx - -2) < 5.0) return false;
    if (Math.abs(gz - -48) < 4.5 && gx > -74 && gx < 14) return false;
    if (Math.abs(gz - 34) < 4.5 && gx > -74 && gx < 14) return false;
    if (gx >= -82 && gx <= -40 && gz >= -74 && gz <= -42) return false;
    if (gx >= -84 && gx <= -44 && gz >= 42 && gz <= 78) return false;
    return true;
  };

  const grassCount = Math.max(180, Math.round(620 * qProfile.foliageDensity));
  const grassSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < grassCount * 2 && grassSpots.length < grassCount; i++) {
    const gx = (rand() - 0.5) * 214;
    const gz = (rand() - 0.5) * 214;
    if (!isClearFoliage(gx, gz)) continue;
    const gy = sampleVisualTerrainY(gx, gz);
    if (gy < -0.22) continue;
    grassSpots.push({
      x: gx,
      y: gy,
      z: gz,
      scale: 0.8 + rand() * 0.75,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.24 + (rand() - 0.5) * 0.07, 0.36, 0.42 + rand() * 0.18),
    });
  }
  buildInstancedGrassTufts(propCtx, grassSpots);

  const fernCount = Math.max(70, Math.round(220 * qProfile.foliageDensity));
  const fernSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < fernCount * 2 && fernSpots.length < fernCount; i++) {
    const fx = (rand() - 0.5) * 210;
    const fz = (rand() - 0.5) * 210;
    if (!isClearFoliage(fx, fz)) continue;
    const fy = sampleVisualTerrainY(fx, fz);
    if (fy < -0.15) continue;
    fernSpots.push({
      x: fx,
      y: fy,
      z: fz,
      scale: 0.78 + rand() * 0.65,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.27 + (rand() - 0.5) * 0.05, 0.4, 0.38 + rand() * 0.16),
    });
  }
  buildInstancedFerns(propCtx, fernSpots);

  const shrubCount = Math.max(55, Math.round(170 * qProfile.foliageDensity));
  const shrubSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < shrubCount * 2 && shrubSpots.length < shrubCount; i++) {
    const sx = (rand() - 0.5) * 216;
    const sz = (rand() - 0.5) * 216;
    if (!isClearFoliage(sx, sz)) continue;
    const sy = sampleVisualTerrainY(sx, sz);
    if (sy < -0.12) continue;
    shrubSpots.push({
      x: sx,
      y: sy,
      z: sz,
      scale: 0.85 + rand() * 0.75,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.25 + (rand() - 0.5) * 0.08, 0.34, 0.35 + rand() * 0.16),
    });
  }
  buildInstancedUndergrowthShrubs(propCtx, shrubSpots);

  // Natural mossy valley boulders along riverbanks & forest flanks
  const rockGeo = trackGeo(new THREE.DodecahedronGeometry(1.3, 0));
  const rockSpots: Array<[number, number]> = [
    [-12, -26],
    [-38, -22],
    [-14, 12],
    [-38, 14],
    [-10, 68],
    [-40, -78],
    [40, -82],
    [44, 78],
  ];
  const rockInst = new THREE.InstancedMesh(rockGeo, matRock, rockSpots.length);
  rockSpots.forEach(([rx, rz], i) => {
    const ry = sampleVisualTerrainY(rx, rz);
    dummy.position.set(rx, ry + 0.6, rz);
    dummy.rotation.set(i * 0.5, i * 1.1, 0);
    dummy.scale.set(1.4, 0.88, 1.2);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
    physics.addBox({
      minX: rx - 1.4,
      maxX: rx + 1.4,
      minY: ry,
      maxY: ry + 1.5,
      minZ: rz - 1.2,
      maxZ: rz + 1.2,
      surface: 'concrete',
      blocksMovement: true,
    });
  });
  rockInst.instanceMatrix.needsUpdate = true;
  rockInst.computeBoundingSphere();
  rockInst.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(rockInst);
  raycastMeshes.push(rockInst);

  // Tactical Highway Shoulder Jersey Barriers, Bridge Chokepoint Cover & Airstrip Apron Baffles
  const tacticalCoverSpecs: Array<[number, number, number, number, number, 'concrete' | 'wood']> = [
    // Paved highway shoulder chicanes (X = -2 centerline remains fully open for movement)
    [-5.6, -26, 0.6, 1.12, 3.2, 'concrete'],
    [1.8, -16, 0.6, 1.12, 3.2, 'concrete'],
    [-5.6, 12, 0.6, 1.12, 3.2, 'concrete'],
    [1.8, 22, 0.6, 1.12, 3.2, 'concrete'],
    [-5.6, 52, 0.6, 1.12, 3.2, 'concrete'],
    // Bridge East approach fighting positions
    [6.6, -52.2, 3.2, 1.12, 0.62, 'concrete'],
    [6.6, 29.8, 3.2, 1.12, 0.62, 'concrete'],
    // Airstrip apron flanking cover islands (leaves X = 76 runway nav spine unobstructed)
    [66.0, -24, 3.6, 1.24, 0.72, 'concrete'],
    [86.5, -18, 3.6, 1.24, 0.72, 'concrete'],
    [66.0, 18, 3.6, 1.24, 0.72, 'concrete'],
    [86.5, 22, 3.6, 1.24, 0.72, 'concrete'],
    // Timber log stacks near village approaches
    [-46.0, -45.0, 2.8, 1.05, 1.35, 'wood'],
    [-48.0, 44.0, 2.8, 1.05, 1.35, 'wood'],
  ];
  for (const [cx, cz, cw, ch, cd, surf] of tacticalCoverSpecs) {
    const cy = sampleVisualTerrainY(cx, cz) + ch * 0.5;
    addSolidBox(cx, cy, cz, cw, ch, cd, surf === 'wood' ? matWood : matBunkerConcrete, surf);
  }

  // === 7. VALLEY-WIDE NAVGRAPH (Villages, Bridges, Highway, Military Base, Airstrip, Helipad, Bunker) ===
  const rawNodes: NavNode[] = [
    // Paved Highway spine
    { id: 'hwy_n', position: [-2, 0.05, -72], zoneId: 'default', neighbors: ['hwy_br_n', 'base_gate_n'] },
    { id: 'hwy_br_n', position: [-2, 0.05, -48], zoneId: 'default', neighbors: ['hwy_n', 'hwy_mid', 'br_n_e', 'base_gate_nw'] },
    { id: 'hwy_mid', position: [-2, 0.05, -6], zoneId: 'default', neighbors: ['hwy_br_n', 'hwy_br_s'], isCover: true, coverNormal: [1, 0] },
    { id: 'hwy_br_s', position: [-2, 0.05, 34], zoneId: 'default', neighbors: ['hwy_mid', 'hwy_s', 'br_s_e', 'base_gate_sw'] },
    { id: 'hwy_s', position: [-2, 0.05, 72], zoneId: 'default', neighbors: ['hwy_br_s', 'base_gate_s'] },

    // Bridges & West Villages
    { id: 'br_n_e', position: [getRiverCenterX(-48) + 10, 0.1, -48], zoneId: 'default', neighbors: ['hwy_br_n', 'br_n_w'] },
    { id: 'br_n_w', position: [getRiverCenterX(-48) - 10, 0.1, -48], zoneId: 'default', neighbors: ['br_n_e', 'vil_nw_c'] },
    { id: 'vil_nw_c', position: [-58, 0, -52], zoneId: 'default', neighbors: ['br_n_w', 'vil_nw_n', 'lone_w'], isCover: true, coverNormal: [1, 1] },
    { id: 'vil_nw_n', position: [-58, 0.3, -64], zoneId: 'default', neighbors: ['vil_nw_c'] },

    { id: 'br_s_e', position: [getRiverCenterX(34) + 10, 0.1, 34], zoneId: 'default', neighbors: ['hwy_br_s', 'br_s_w'] },
    { id: 'br_s_w', position: [getRiverCenterX(34) - 10, 0.1, 34], zoneId: 'default', neighbors: ['br_s_e', 'vil_sw_c'] },
    { id: 'vil_sw_c', position: [-62, 0, 52], zoneId: 'default', neighbors: ['br_s_w', 'vil_sw_s', 'lone_w'], isCover: true, coverNormal: [1, -1] },
    { id: 'vil_sw_s', position: [-56, 0.3, 70], zoneId: 'default', neighbors: ['vil_sw_c'] },
    { id: 'lone_w', position: [-88, 0, 4], zoneId: 'default', neighbors: ['vil_nw_c', 'vil_sw_c'] },

    // Military Base Gates & Interior Spine
    { id: 'base_gate_nw', position: [14, 0.04, -48], zoneId: 'default', neighbors: ['hwy_br_n', 'comms_gate', 'gar_1_e'] },
    { id: 'base_gate_sw', position: [14, 0.04, 34], zoneId: 'default', neighbors: ['hwy_br_s', 'gar_2_e', 'heli_foot'] },
    { id: 'base_gate_n', position: [52, 0.04, -62], zoneId: 'default', neighbors: ['hwy_n', 'armory_out', 'airstrip_n', 'lone_ne'] },
    { id: 'base_gate_s', position: [52, 0.04, 58], zoneId: 'default', neighbors: ['hwy_s', 'heli_foot', 'airstrip_s', 'lone_se'] },
    { id: 'lone_ne', position: [74, 0, -76], zoneId: 'default', neighbors: ['base_gate_n'] },
    { id: 'lone_se', position: [78, 0, 74], zoneId: 'default', neighbors: ['base_gate_s'] },

    // Comms Station, Garages, Armory, Helipad, Airstrip & Single-Entry Underground Bunker
    { id: 'comms_gate', position: [25.5, 0.04, -30], zoneId: 'default', neighbors: ['base_gate_nw', 'armory_out', 'gar_1_e'], isCover: true, coverNormal: [0, 1] },
    { id: 'gar_1_e', position: [37, 0.04, -14], zoneId: 'default', neighbors: ['base_gate_nw', 'comms_gate', 'gar_2_e', 'bunker_door'], isCover: true, coverNormal: [-1, 0] },
    { id: 'gar_2_e', position: [37, 0.04, 10], zoneId: 'default', neighbors: ['gar_1_e', 'base_gate_sw', 'heli_foot', 'bunker_door'], isCover: true, coverNormal: [-1, 0] },
    { id: 'armory_out', position: [50, 0.04, -32], zoneId: 'default', neighbors: ['base_gate_n', 'comms_gate', 'armory_in', 'airstrip_n'] },
    { id: 'armory_in', position: [50, 0.16, -40], zoneId: 'default', neighbors: ['armory_out'], isCover: true, coverNormal: [0, 1] },
    { id: 'heli_foot', position: [34, 0.04, 36], zoneId: 'default', neighbors: ['base_gate_sw', 'gar_2_e', 'base_gate_s', 'heli_top'] },
    { id: 'heli_top', position: [44, heliH, 36], zoneId: 'default', neighbors: ['heli_foot'], isCover: true, coverNormal: [1, 0] },
    { id: 'airstrip_n', position: [76, 0.08, -42], zoneId: 'default', neighbors: ['base_gate_n', 'armory_out', 'airstrip_mid'] },
    { id: 'airstrip_mid', position: [76, 0.08, -2], zoneId: 'default', neighbors: ['airstrip_n', 'airstrip_s', 'bunker_door'] },
    { id: 'airstrip_s', position: [76, 0.08, 40], zoneId: 'default', neighbors: ['airstrip_mid', 'base_gate_s'] },

    // Underground Bunker (single entry/exit doorway!)
    { id: 'bunker_door', position: [41.5, 0.04, -6.0], zoneId: 'default', neighbors: ['gar_1_e', 'gar_2_e', 'airstrip_mid', 'bunker_in'] },
    { id: 'bunker_in', position: [55.0, bFloorY, -6.0], zoneId: 'default', neighbors: ['bunker_door'], isCover: true, coverNormal: [-1, 0] },
  ];

  const teamA: SpawnPoint[] = [
    { position: [-54, 0, -48], yaw: Math.PI * 0.5 },
    { position: [-58, 0.3, -64], yaw: Math.PI * 0.65 },
    { position: [-2, 0.05, -62], yaw: Math.PI },
    { position: [-62, 0, 48], yaw: Math.PI * 0.35 },
    { position: [-88, 0, 4], yaw: Math.PI * 0.5 },
    { position: [-2, 0.05, 58], yaw: 0 },
  ];
  const teamB: SpawnPoint[] = [
    { position: [50, 0.04, -54], yaw: Math.PI },
    { position: [76, 0.08, -42], yaw: -Math.PI * 0.65 },
    { position: [76, 0.08, 36], yaw: -Math.PI * 0.35 },
    { position: [37, 0.04, 24], yaw: -Math.PI * 0.5 },
    { position: [37, 0.04, -22], yaw: -Math.PI * 0.5 },
    { position: [54, bFloorY, -6], yaw: -Math.PI * 0.5 },
  ];
  const ffa: SpawnPoint[] = [
    ...teamA,
    ...teamB,
    { position: [44, heliH, 36], yaw: -Math.PI * 0.5 },
    { position: [74, 0, -76], yaw: Math.PI },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  // === PHYSICAL DESTRUCTIBLE DOORS (ARMORY & UNDERGROUND BUNKER) ===
  const doorSystem = new DestructibleDoorSystem(sceneGroup, physics, isSoftwareGl);
  const DOOR_W = 1.18;
  const DOOR_H = 2.26;
  const FRAME_CLEAR = DOOR_W + 0.1;

  const addBunkerDoorInfill = (
    axis: 'x' | 'z',
    fixedCoord: number,
    centerAlong: number,
    openSpan: number,
    openHeight: number,
    floorY: number,
    thick: number,
  ): void => {
    const sideW = Math.max(0.08, (openSpan - FRAME_CLEAR) * 0.5);
    const transH = Math.max(0.08, openHeight - (DOOR_H + 0.05));
    if (axis === 'x') {
      addSolidBox(centerAlong - (FRAME_CLEAR * 0.5 + sideW * 0.5), floorY + openHeight * 0.5, fixedCoord, sideW, openHeight, thick, matBunkerConcrete, 'concrete');
      addSolidBox(centerAlong + (FRAME_CLEAR * 0.5 + sideW * 0.5), floorY + openHeight * 0.5, fixedCoord, sideW, openHeight, thick, matBunkerConcrete, 'concrete');
      addSolidBox(centerAlong, floorY + DOOR_H + 0.05 + transH * 0.5, fixedCoord, FRAME_CLEAR, transH, thick, matSteel, 'metal');
    } else {
      addSolidBox(fixedCoord, floorY + openHeight * 0.5, centerAlong - (FRAME_CLEAR * 0.5 + sideW * 0.5), thick, openHeight, sideW, matBunkerConcrete, 'concrete');
      addSolidBox(fixedCoord, floorY + openHeight * 0.5, centerAlong + (FRAME_CLEAR * 0.5 + sideW * 0.5), thick, openHeight, sideW, matBunkerConcrete, 'concrete');
      addSolidBox(fixedCoord, floorY + DOOR_H + 0.05 + transH * 0.5, centerAlong, thick, transH, FRAME_CLEAR, matSteel, 'metal');
    }
  };

  // Armory South Doorway (armX = 50, armZ = -40 -> z = -35.2, floor = 0.16)
  addBunkerDoorInfill('x', armZ + 4.8, armX, 2.8, 2.6, 0.16, 0.4);
  doorSystem.addDoor({
    id: 'timberline_armory_south_door',
    label: 'Armory South Door',
    hingePos: [armX - DOOR_W * 0.5, 0.16, armZ + 4.8],
    closedYawRad: 0,
    swingSign: 1,
    width: DOOR_W,
    height: DOOR_H,
    style: 'tactical_reinforced',
  });

  // Armory West Doorway (x = 43.2, z = -40, floor = 0.16)
  addBunkerDoorInfill('z', armX - 6.8, armZ, 2.8, 2.6, 0.16, 0.4);
  doorSystem.addDoor({
    id: 'timberline_armory_west_door',
    label: 'Armory West Door',
    hingePos: [armX - 6.8, 0.16, armZ - DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: 1,
    width: DOOR_W,
    height: DOOR_H,
    style: 'tactical_reinforced',
  });

  // Underground Bunker Single Entry Door (x = 43.4, z = -6.0, swings outward west onto apron)
  addBunkerDoorInfill('z', 43.4, -6.0, 2.4, 2.5, 0.02, 0.45);
  doorSystem.addDoor({
    id: 'timberline_bunker_entry_door',
    label: 'Bunker Access Door',
    hingePos: [43.4, 0.02, -6.0 - DOOR_W * 0.5],
    closedYawRad: -Math.PI * 0.5,
    swingSign: -1,
    width: DOOR_W,
    height: DOOR_H,
    style: 'bunker_wood',
  });

  const shatterBreakable = (
    objOrId: THREE.Object3D | string,
    impactPoint?: Readonly<THREE.Vector3>,
  ): { breakableId: string; impactPoint: THREE.Vector3 } | null => {
    const id =
      typeof objOrId === 'string'
        ? objOrId
        : (objOrId.userData?.breakableId as string | undefined);
    if (!id) return null;
    const rec = breakablesById.get(id);
    if (!rec || rec.shattered) return null;
    rec.shattered = true;
    rec.mesh.userData.shattered = true;
    rec.mesh.visible = false;
    physics.disableBoxById(id);

    const rayIdx = raycastMeshes.indexOf(rec.mesh);
    if (rayIdx >= 0) {
      raycastMeshes.splice(rayIdx, 1);
    }

    const origin = impactPoint ? impactPoint.clone() : rec.center.clone();
    if (!isSoftwareGl) {
      const shardCount = 18;
      for (let s = 0; s < shardCount; s++) {
        const sm = new THREE.Mesh(shardGeo, matGlassShard);
        sm.position.set(
          origin.x + (Math.random() - 0.5) * 1.1,
          Math.max(0.95, origin.y + (Math.random() - 0.5) * 1.2),
          origin.z + (Math.random() - 0.5) * 1.1,
        );
        sm.scale.set(0.6 + Math.random() * 1.2, 0.8 + Math.random() * 1.4, 0.35);
        sceneGroup.add(sm);
        activeGlassShards.push({
          mesh: sm,
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 5.2,
            1.0 + Math.random() * 2.8,
            (Math.random() - 0.5) * 5.2,
          ),
          rotVel: new THREE.Vector3(
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 14,
          ),
          life: 4.5,
        });
      }
    }
    return { breakableId: id, impactPoint: origin };
  };

  return {
    id: 'timberline_compound',
    name: 'Timberline Valley & Base',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA,
      teamB,
      ffa,
      playerStart: teamB[3], // drops player facing the base, garages, radar & valley!
      zombieSpawners: [],
    },
    terrainHeightAt: samplePhysicsTerrainY,
    interactables: [],
    lightingPreset: LIGHTING_PRESET,
    supportsDynamicWeatherTime: true,
    envBindings: {
      windUniforms,
      waterUniforms: waterHandle.uniforms,
      wettableSurfaces,
      nightLights,
    },
    doorSystem,
    penetrableSystem,
    shatterBreakable,
    update: (dt, elapsedSec) => {
      penetrableSystem.update(dt);
      // Smooth rotating radar dish + blinking aviation obstruction beacon
      radar.dishPivot.rotation.y += dt * 0.55;
      const blink = Math.sin(elapsedSec * 4.2) > 0.25;
      radar.beaconMat.emissiveIntensity = blink ? 3.2 : 0.35;

      // Animate windsock heading & lift directly from live weather wind uniforms
      const wx = windUniforms.uWindDir.value.x;
      const wz = windUniforms.uWindDir.value.y;
      const wStr = windUniforms.uWindStrength.value;
      const windYaw = Math.atan2(-wz, wx);
      windsockPivot.rotation.y = windYaw + Math.sin(elapsedSec * 4.6) * 0.14 * wStr;
      // Droops when calm, extends nearly horizontal in strong storm gusts
      const lift = THREE.MathUtils.clamp(wStr * 0.85, 0.15, 0.92);
      windsockArm.rotation.z = -(1 - lift) * 0.85 + Math.sin(elapsedSec * 7.2) * 0.08 * wStr;

      // Update tumbling broken glass shards
      for (let i = activeGlassShards.length - 1; i >= 0; i--) {
        const sh = activeGlassShards[i];
        sh.life -= dt;
        sh.vel.y -= 9.81 * dt;
        sh.mesh.position.addScaledVector(sh.vel, dt);
        sh.mesh.rotation.x += sh.rotVel.x * dt;
        sh.mesh.rotation.y += sh.rotVel.y * dt;
        sh.mesh.rotation.z += sh.rotVel.z * dt;
        if (sh.mesh.position.y < 0.06) {
          sh.mesh.position.y = 0.06;
          sh.vel.y = Math.abs(sh.vel.y) * 0.28;
          sh.vel.x *= 0.6;
          sh.vel.z *= 0.6;
          sh.rotVel.multiplyScalar(0.5);
        }
        if (sh.life <= 0) {
          sceneGroup.remove(sh.mesh);
          activeGlassShards.splice(i, 1);
        }
      }
    },
    dispose: () => {
      penetrableSystem.dispose();
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

export const TIMBERLINE_COMPOUND_MAP: IMapDefinition = {
  id: 'timberline_compound',
  name: 'Timberline Valley',
  subtitle: 'Open Forest, Villages & Airbase',
  description:
    'Expansive alpine valley with two timber villages, lone cabins, winding river & bridges, paved roads, and a full military base featuring a radar comms compound, two garages, lit airstrip, elevated helipad with helicopter prop, armory, and single-entry underground bunker.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Open Valley', 'Airbase & Bunker', 'Villages & River'],
  accentHex: '#38bdf8',
  previewStyle: 'forest_compound',
  build: buildTimberlineCompound,
};

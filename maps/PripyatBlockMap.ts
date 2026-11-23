import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  NightLightEntry,
  WettableSurfaceEntry,
} from '../engine/world/WeatherTimeSystem';
import { createWindShaderUniforms } from '../engine/world/WindFoliageShader';
import {
  buildInstancedBirchTrees,
  buildInstancedFerns,
  buildInstancedGrassTufts,
  buildInstancedUndergrowthShrubs,
  buildOfficeDesk,
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCabinWoodTexture,
  createPripyatPanelConcreteTexture,
  createPripyatTealPlasterTexture,
  createRustedMetalTexture,
  createSovietConcreteTexture,
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
  backgroundHex: 0x7b888c,
  fogHex: 0x748184,
  fogDensity: 0.0095,
  envIntensity: 0.54,
  hemiSkyHex: 0xb4c7cc,
  hemiGroundHex: 0x343931,
  hemiIntensity: 0.72,
  keyLightHex: 0xefe3cb, // muted late-afternoon Exclusion Zone overcast sun with warm amber tint
  keyLightIntensity: 1.75,
  keyLightPos: [-34, 46, 24],
};

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildPripyatBlock(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -46.5;
  physics.boundsMaxX = 46.5;
  physics.boundsMinZ = -40.5;
  physics.boundsMaxZ = 40.5;

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

  // Atmosphere & Environment
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
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 140;
    sun.shadow.camera.left = -54;
    sun.shadow.camera.right = 54;
    sun.shadow.camera.top = 54;
    sun.shadow.camera.bottom = -54;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.025;
  }
  sceneGroup.add(sun);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);
  const windUniforms = createWindShaderUniforms();

  // Textures (Option 1: Soviet Teal-Amber Decay)
  const panelConcTex = trackTex(createPripyatPanelConcreteTexture(maxAniso, 4, 2, 1986));
  const tealPlasterTex = trackTex(createPripyatTealPlasterTexture(maxAniso, 2, 1, 1987));
  const interiorFloorTex = trackTex(createSovietConcreteTexture(maxAniso, 6, 4, '#676963', 1988));
  const asphaltTex = trackTex(createAsphaltRoadTexture(maxAniso, 16, 14, true, 1989));
  const woodTex = trackTex(createCabinWoodTexture(maxAniso, 1, 1, '#634d38', 1990));
  const rustCarTealTex = trackTex(createRustedMetalTexture(maxAniso, '#456a68', 301));
  const rustCarOchreTex = trackTex(createRustedMetalTexture(maxAniso, '#8c6d42', 302));
  const rustCarCreamTex = trackTex(createRustedMetalTexture(maxAniso, '#8b8779', 303));
  const rustTruckOliveTex = trackTex(createRustedMetalTexture(maxAniso, '#495443', 304));
  const pureRustTex = trackTex(createRustedMetalTexture(maxAniso, '#6b3e26', 305));

  // Materials
  const matPanelConc = trackMat(
    new THREE.MeshStandardMaterial({ map: panelConcTex, roughness: 0.9, metalness: 0.04 }),
  );
  const matTealPlaster = trackMat(
    new THREE.MeshStandardMaterial({ map: tealPlasterTex, roughness: 0.88, metalness: 0.02 }),
  );
  const matInteriorFloor = trackMat(
    new THREE.MeshStandardMaterial({ map: interiorFloorTex, roughness: 0.92, metalness: 0.03 }),
  );
  const matAsphalt = trackMat(
    new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.94, metalness: 0.02 }),
  );
  const matSidewalk = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x767872, roughness: 0.92, metalness: 0.03 }),
  );
  const matDarkConcrete = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x454947, roughness: 0.94, metalness: 0.05 }),
  );
  const matWood = trackMat(
    new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.86, metalness: 0.03 }),
  );
  const matRust = trackMat(
    new THREE.MeshStandardMaterial({ map: pureRustTex, roughness: 0.82, metalness: 0.38 }),
  );
  const matSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b4244, roughness: 0.56, metalness: 0.68 }),
  );
  const matSandbag = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7d745a, roughness: 0.96, metalness: 0.02 }),
  );
  const matTubeOn = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdff5ee,
      emissive: 0xaee6dc,
      emissiveIntensity: 1.6,
      roughness: 0.25,
    }),
  );
  const matAmberBulb = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffd28a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.0,
      roughness: 0.25,
    }),
  );

  // Vehicle shared material sets
  const baseVehicleMats = {
    rust: matRust,
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x1c1d1e, roughness: 0.95, metalness: 0.04 })),
    rim: trackMat(new THREE.MeshStandardMaterial({ color: 0x6b4d38, roughness: 0.72, metalness: 0.45 })),
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x151717, roughness: 0.95, metalness: 0.05 })),
    glass: trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x2a3c3c,
        roughness: 0.22,
        metalness: 0.55,
        transparent: true,
        opacity: 0.45,
      }),
    ),
    chrome: trackMat(new THREE.MeshStandardMaterial({ color: 0x877d70, roughness: 0.45, metalness: 0.65 })),
  };
  const makeVehMats = (tex: THREE.Texture): VehicleMaterials => ({
    ...baseVehicleMats,
    body: trackMat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.74, metalness: 0.34 })),
  });
  const vehTeal = makeVehMats(rustCarTealTex);
  const vehOchre = makeVehMats(rustCarOchreTex);
  const vehCream = makeVehMats(rustCarCreamTex);
  const vehTruck = makeVehMats(rustTruckOliveTex);

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
    { material: matAsphalt, baseRoughness: 0.94, baseEnvMapIntensity: 0.45 },
    { material: matSidewalk, baseRoughness: 0.92, baseEnvMapIntensity: 0.4 },
    { material: matPanelConc, baseRoughness: 0.9, baseEnvMapIntensity: 0.35 },
  ];
  const nightLights: NightLightEntry[] = [
    { emissiveMat: matAmberBulb, baseEmissiveIntensity: 2.8 },
  ];

  const dummy = new THREE.Object3D();

  // Solid structural helper (zero overlapping boxes when callers obey seam widths)
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

  const addWallWithDoor = (
    axis: 'x' | 'z',
    fixedCoord: number,
    start: number,
    end: number,
    baseY: number,
    wallH: number,
    doorCenter: number,
    doorW: number,
    doorH: number,
    thickness: number,
    mat: THREE.Material,
  ): void => {
    const leftLen = doorCenter - doorW * 0.5 - start;
    const rightLen = end - (doorCenter + doorW * 0.5);
    const headerH = wallH - doorH;

    if (axis === 'x') {
      if (leftLen > 0.12) {
        addSolidBox(start + leftLen * 0.5, baseY + wallH * 0.5, fixedCoord, leftLen, wallH, thickness, mat);
      }
      if (rightLen > 0.12) {
        addSolidBox(end - rightLen * 0.5, baseY + wallH * 0.5, fixedCoord, rightLen, wallH, thickness, mat);
      }
      if (headerH > 0.12) {
        addSolidBox(doorCenter, baseY + doorH + headerH * 0.5, fixedCoord, doorW, headerH, thickness, mat);
      }
    } else {
      if (leftLen > 0.12) {
        addSolidBox(fixedCoord, baseY + wallH * 0.5, start + leftLen * 0.5, thickness, wallH, leftLen, mat);
      }
      if (rightLen > 0.12) {
        addSolidBox(fixedCoord, baseY + wallH * 0.5, end - rightLen * 0.5, thickness, wallH, rightLen, mat);
      }
      if (headerH > 0.12) {
        addSolidBox(fixedCoord, baseY + doorH + headerH * 0.5, doorCenter, thickness, headerH, doorW, mat);
      }
    }
  };

  const addWindowWall = (
    axis: 'x' | 'z',
    fixedCoord: number,
    start: number,
    end: number,
    baseY: number,
    wallH: number,
    windowCenters: number[],
    winW: number,
    sillH: number,
    winH: number,
    thickness: number,
    mat: THREE.Material,
  ): void => {
    const span = end - start;
    const headerH = wallH - sillH - winH;
    // Lower sill & upper header spanning cleanly without overlap
    if (axis === 'x') {
      addSolidBox((start + end) * 0.5, baseY + sillH * 0.5, fixedCoord, span, sillH, thickness, mat);
      if (headerH > 0.1) {
        addSolidBox((start + end) * 0.5, baseY + sillH + winH + headerH * 0.5, fixedCoord, span, headerH, thickness, mat);
      }
    } else {
      addSolidBox(fixedCoord, baseY + sillH * 0.5, (start + end) * 0.5, thickness, sillH, span, mat);
      if (headerH > 0.1) {
        addSolidBox(fixedCoord, baseY + sillH + winH + headerH * 0.5, (start + end) * 0.5, thickness, headerH, span, mat);
      }
    }

    // Vertical piers strictly between sill top and header bottom
    const sorted = [...windowCenters].sort((a, b) => a - b);
    let cursor = start;
    const pierY = baseY + sillH + winH * 0.5;
    for (const wc of sorted) {
      const wStart = wc - winW * 0.5;
      const wEnd = wc + winW * 0.5;
      const pierLen = wStart - cursor;
      if (pierLen > 0.12) {
        if (axis === 'x') {
          addSolidBox(cursor + pierLen * 0.5, pierY, fixedCoord, pierLen, winH, thickness, mat);
        } else {
          addSolidBox(fixedCoord, pierY, cursor + pierLen * 0.5, thickness, winH, pierLen, mat);
        }
      }
      cursor = wEnd;
    }
    const lastLen = end - cursor;
    if (lastLen > 0.12) {
      if (axis === 'x') {
        addSolidBox(cursor + lastLen * 0.5, pierY, fixedCoord, lastLen, winH, thickness, mat);
      } else {
        addSolidBox(fixedCoord, pierY, cursor + lastLen * 0.5, thickness, winH, lastLen, mat);
      }
    }
  };

  // === 1. GROUND LAYER (Strictly separated Y-layers -> ZERO Z-FIGHTING) ===
  // Base cracked mossy Pripyat asphalt courtyard & boulevard (y = 0)
  const mainGround = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(180, 180)), matAsphalt);
  mainGround.rotation.x = -Math.PI * 0.5;
  mainGround.position.y = 0;
  mainGround.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  mainGround.userData.surfaceMaterial = 'asphalt';
  sceneGroup.add(mainGround);
  raycastMeshes.push(mainGround);

  // Raised concrete sidewalks & courtyard plaza strips (solid 0.08m curb height, y top = 0.08m)
  addSolidBox(0, 0.04, -14.8, 44, 0.08, 3.2, matSidewalk, 'concrete', false);
  addSolidBox(-21.6, 0.04, 2.0, 3.2, 0.08, 30.0, matSidewalk, 'concrete', false);
  addSolidBox(21.6, 0.04, 2.0, 3.2, 0.08, 30.0, matSidewalk, 'concrete', false);
  addSolidBox(0, 0.04, 22.8, 72, 0.08, 3.4, matSidewalk, 'concrete', false);

  // Overgrown grassy courtyard lawn islands (elevated 0.06m soil beds inside concrete curbs -> zero z-fighting)
  const matLawn = trackMat(new THREE.MeshStandardMaterial({ color: 0x3b4a30, roughness: 0.96, metalness: 0.01 }));
  for (const [lx, lz, lw, ld] of [
    [-10.5, 4.5, 11.5, 14.0],
    [10.5, 4.5, 11.5, 14.0],
  ] as Array<[number, number, number, number]>) {
    const lawn = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(lw, 0.07, ld)), matLawn);
    lawn.position.set(lx, 0.035, lz);
    lawn.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    lawn.userData.surfaceMaterial = 'grass';
    sceneGroup.add(lawn);
    raycastMeshes.push(lawn);
    physics.addSurfaceZone({
      minX: lx - lw * 0.5,
      maxX: lx + lw * 0.5,
      minZ: lz - ld * 0.5,
      maxZ: lz + ld * 0.5,
      surface: 'grass',
    });
    // Concrete curb frames enclosing each lawn island flush against asphalt
    addSolidBox(lx, 0.045, lz - ld * 0.5 - 0.1, lw + 0.4, 0.09, 0.2, matSidewalk, 'concrete', false);
    addSolidBox(lx, 0.045, lz + ld * 0.5 + 0.1, lw + 0.4, 0.09, 0.2, matSidewalk, 'concrete', false);
    addSolidBox(lx - lw * 0.5 - 0.1, 0.045, lz, 0.2, 0.09, ld, matSidewalk, 'concrete', false);
    addSolidBox(lx + lw * 0.5 + 0.1, 0.045, lz, 0.2, 0.09, ld, matSidewalk, 'concrete', false);
  }

  // === 2. NORTH 2-STORY PRIPYAT BREZHNEVKA APARTMENT BLOCK (X in [-36, 36], Z in [-36, -18]) ===
  const F2_Y = 3.6;
  const WALL_H = 3.32;
  const ROOF_Y = 7.2;

  // Interior floor slab (top at y = 0.08m -> clean step-up, zero overlap with asphalt)
  addSolidBox(0, 0.04, -27.0, 72.0, 0.08, 18.0, matInteriorFloor, 'concrete', false);
  physics.addInteriorZone({ minX: -36, maxX: 36, minY: 0, maxY: ROOF_Y, minZ: -36, maxZ: -18, material: 'concrete' });

  // Ground floor walls of North Block (Breezeway passage through X in [-3.4, 3.4])
  // North exterior back wall (Z = -35.75) with rear breach door & windows
  addWallWithDoor('x', -35.75, -36.0, 36.0, 0.08, WALL_H, 0, 6.2, 2.9, 0.48, matPanelConc);
  // South courtyard facade (Z = -18.25) with central breezeway + side stairwell entrances
  addWallWithDoor('x', -18.25, -36.0, -3.4, 0.08, WALL_H, -19.5, 2.8, 2.6, 0.48, matPanelConc);
  addWallWithDoor('x', -18.25, 3.4, 36.0, 0.08, WALL_H, 19.5, 2.8, 2.6, 0.48, matPanelConc);
  addSolidBox(0, 0.08 + 2.9 + (WALL_H - 2.9) * 0.5, -18.25, 6.8, WALL_H - 2.9, 0.48, matPanelConc);
  // West & East end walls strictly between N/S inner faces (Z in [-35.5, -18.5])
  addWallWithDoor('z', -35.75, -35.5, -18.5, 0.08, WALL_H, -27.0, 2.6, 2.6, 0.48, matPanelConc);
  addWallWithDoor('z', 35.75, -35.5, -18.5, 0.08, WALL_H, -27.0, 2.6, 2.6, 0.48, matPanelConc);

  // North Block ground interior Soviet turquoise-teal hallway & apartment dividers
  addWallWithDoor('z', -3.6, -35.5, -18.5, 0.08, WALL_H, -27.0, 2.6, 2.5, 0.32, matTealPlaster);
  addWallWithDoor('z', 3.6, -35.5, -18.5, 0.08, WALL_H, -27.0, 2.6, 2.5, 0.32, matTealPlaster);
  addWallWithDoor('z', -14.5, -35.5, -18.5, 0.08, WALL_H, -25.0, 2.4, 2.5, 0.32, matTealPlaster);
  addWallWithDoor('z', 14.5, -35.5, -18.5, 0.08, WALL_H, -25.0, 2.4, 2.5, 0.32, matTealPlaster);
  addWallWithDoor('x', -27.5, -35.5, -14.7, 0.08, WALL_H, -25.0, 2.4, 2.5, 0.32, matTealPlaster);
  addWallWithDoor('x', -27.5, 14.7, 35.5, 0.08, WALL_H, 25.0, 2.4, 2.5, 0.32, matTealPlaster);

  // North Block 2nd Floor Slab (leaving clean stairwell openings at X in [-11.5,-7.5] and [7.5,11.5], Z in [-29,-19])
  // West slab: X in [-36, -11.5]
  addSolidBox(-23.75, F2_Y - 0.1, -27.0, 24.5, 0.28, 18.0, matPanelConc);
  // East slab: X in [11.5, 36]
  addSolidBox(23.75, F2_Y - 0.1, -27.0, 24.5, 0.28, 18.0, matPanelConc);
  // Center bridge slab: X in [-7.5, 7.5]
  addSolidBox(0, F2_Y - 0.1, -27.0, 15.0, 0.28, 18.0, matPanelConc);
  // Rear landing behind stairwells: Z in [-36, -29.2]
  addSolidBox(-9.5, F2_Y - 0.1, -32.6, 4.0, 0.28, 6.8, matPanelConc);
  addSolidBox(9.5, F2_Y - 0.1, -32.6, 4.0, 0.28, 6.8, matPanelConc);

  // North Block 2nd Floor exterior windowed walls overlooking courtyard!
  addWindowWall('x', -18.25, -36.0, 36.0, F2_Y + 0.04, 3.56, [-29, -20, -10, 0, 10, 20, 29], 3.8, 1.02, 1.65, 0.46, matPanelConc);
  addWindowWall('x', -35.75, -36.0, 36.0, F2_Y + 0.04, 3.56, [-26, -12, 0, 12, 26], 3.4, 1.05, 1.6, 0.46, matPanelConc);
  addSolidBox(-35.75, F2_Y + 1.82, -27.0, 0.46, 3.56, 17.0, matPanelConc);
  addSolidBox(35.75, F2_Y + 1.82, -27.0, 0.46, 3.56, 17.0, matPanelConc);

  // North Block 2nd Floor interior teal partitions
  addWallWithDoor('z', -14.5, -35.5, -18.5, F2_Y + 0.04, 3.52, -27.0, 2.5, 2.5, 0.3, matTealPlaster);
  addWallWithDoor('z', 14.5, -35.5, -18.5, F2_Y + 0.04, 3.52, -27.0, 2.5, 2.5, 0.3, matTealPlaster);

  // North Block Roof Slab + iconic Soviet concrete rooftop parapet
  addSolidBox(0, ROOF_Y + 0.16, -27.0, 72.4, 0.32, 18.4, matDarkConcrete);
  addSolidBox(0, ROOF_Y + 0.72, -17.95, 72.4, 0.8, 0.32, matPanelConc);

  // Protruding Soviet Balconies along the North Block facade (courtyard side, Z = -17.1)
  for (const bx of [-29, -20, 0, 20, 29]) {
    addSolidBox(bx, F2_Y - 0.08, -17.1, 4.4, 0.22, 1.8, matPanelConc);
    addSolidBox(bx, F2_Y + 0.54, -16.28, 4.4, 1.02, 0.16, matPanelConc);
    addSolidBox(bx - 2.12, F2_Y + 0.54, -17.1, 0.16, 1.02, 1.5, matPanelConc);
    addSolidBox(bx + 2.12, F2_Y + 0.54, -17.1, 0.16, 1.02, 1.5, matPanelConc);
  }

  // Helper for crisp stepped concrete stair flights (zero coplanar overlap)
  const buildStaircase = (
    cx: number,
    width: number,
    zStart: number,
    zEnd: number,
    baseY: number,
    topY: number,
    riseAxis: '+z' | '-z',
  ): void => {
    const minZ = Math.min(zStart, zEnd);
    const maxZ = Math.max(zStart, zEnd);
    physics.addRamp({
      minX: cx - width * 0.5,
      maxX: cx + width * 0.5,
      minZ,
      maxZ,
      baseY,
      topY,
      riseAxis,
      surface: 'concrete',
    });
    const steps = 16;
    const stepD = (maxZ - minZ) / steps;
    const stepH = (topY - baseY) / steps;
    const stepGeo = trackGeo(new THREE.BoxGeometry(width, stepH, Math.max(0.06, stepD - 0.004)));
    const inst = new THREE.InstancedMesh(stepGeo, matDarkConcrete, steps);
    inst.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const sz = riseAxis === '+z' ? minZ + t * (maxZ - minZ) : maxZ - t * (maxZ - minZ);
      const sy = baseY + (i + 0.5) * stepH;
      dummy.position.set(cx, sy, sz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(inst);
    raycastMeshes.push(inst);

    // Rusted steel handrail
    const len = Math.hypot(maxZ - minZ, topY - baseY);
    const ang = Math.atan2(topY - baseY, maxZ - minZ) * (riseAxis === '+z' ? -1 : 1);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.07, 0.07, len)), matRust);
      rail.position.set(cx + side * (width * 0.5 - 0.06), (baseY + topY) * 0.5 + 0.92, (minZ + maxZ) * 0.5);
      rail.rotation.x = ang;
      sceneGroup.add(rail);
    }
  };

  // Twin stairwells inside North Block rising from Z=-19.5 (y=0.08) to Z=-29.0 (y=F2_Y+0.04)
  buildStaircase(-9.5, 3.6, -19.5, -29.0, 0.08, F2_Y + 0.04, '-z');
  buildStaircase(9.5, 3.6, -19.5, -29.0, 0.08, F2_Y + 0.04, '-z');

  // === 3. WEST & EAST 2-STORY COURTYARD ANNEX WINGS ===
  const buildSideWing = (side: -1 | 1): void => {
    const cx = side * 33.0; // spans X in [24, 42] or [-42, -24]
    const innerX = side * 24.25;
    const outerX = side * 41.75;
    const wingMinZ = -14.0;
    const wingMaxZ = 18.0;

    // Ground slab (top = 0.08m)
    addSolidBox(cx, 0.04, 2.0, 18.0, 0.08, 32.0, matInteriorFloor, 'concrete', false);
    physics.addInteriorZone({
      minX: cx - 9,
      maxX: cx + 9,
      minY: 0,
      maxY: ROOF_Y,
      minZ: wingMinZ,
      maxZ: wingMaxZ,
      material: 'concrete',
    });

    // Ground floor courtyard-facing wall with 2 breached entrances & windows
    addWallWithDoor('z', innerX, wingMinZ, 2.0, 0.08, WALL_H, -6.5, 2.8, 2.6, 0.46, matPanelConc);
    addWallWithDoor('z', innerX, 2.0, wingMaxZ, 0.08, WALL_H, 10.5, 2.8, 2.6, 0.46, matPanelConc);
    // Outer street wall (windowed)
    addWindowWall('z', outerX, wingMinZ, wingMaxZ, 0.08, WALL_H, [-8, 2, 12], 3.0, 1.05, 1.55, 0.46, matPanelConc);
    // North & South end walls with doorways
    addWallWithDoor('x', wingMinZ + 0.24, cx - 8.5, cx + 8.5, 0.08, WALL_H, cx, 2.8, 2.6, 0.46, matPanelConc);
    addWallWithDoor('x', wingMaxZ - 0.24, cx - 8.5, cx + 8.5, 0.08, WALL_H, cx, 2.8, 2.6, 0.46, matPanelConc);

    // Ground interior teal partition wall
    addWallWithDoor('x', 2.0, cx - 8.5, cx + 8.5, 0.08, WALL_H, cx - side * 2.5, 2.6, 2.5, 0.3, matTealPlaster);

    // 2nd Floor Slab (leaving stairwell cutout on outer half Z in [-6.5, 3.0])
    const stairX = cx + side * 4.4;
    addSolidBox(cx - side * 2.2, F2_Y - 0.1, 2.0, 13.4, 0.28, 32.0, matPanelConc);
    addSolidBox(stairX, F2_Y - 0.1, -10.25, 4.4, 0.28, 7.5, matPanelConc);
    addSolidBox(stairX, F2_Y - 0.1, 10.75, 4.4, 0.28, 14.5, matPanelConc);

    // Stair flight rising from Z = 3.2 (ground) up to Z = -6.4 (2nd floor)
    buildStaircase(stairX, 3.6, 3.2, -6.4, 0.08, F2_Y + 0.04, '-z');

    // 2nd Floor courtyard-facing windowed overlook wall
    addWindowWall('z', innerX, wingMinZ, wingMaxZ, F2_Y + 0.04, 3.56, [-8, 2, 12], 3.8, 1.02, 1.65, 0.46, matPanelConc);
    addSolidBox(outerX, F2_Y + 1.82, 2.0, 0.46, 3.56, 31.2, matPanelConc);
    addSolidBox(cx, F2_Y + 1.82, wingMinZ + 0.24, 17.0, 3.56, 0.46, matPanelConc);
    addSolidBox(cx, F2_Y + 1.82, wingMaxZ - 0.24, 17.0, 3.56, 0.46, matPanelConc);

    // Wing Roof Slab
    addSolidBox(cx, ROOF_Y + 0.16, 2.0, 18.4, 0.32, 32.4, matDarkConcrete);

    // Protruding Soviet Courtyard Balconies
    for (const bz of [-8, 12]) {
      const balX = innerX - side * 1.1;
      addSolidBox(balX, F2_Y - 0.08, bz, 1.8, 0.22, 4.4, matPanelConc);
      addSolidBox(balX - side * 0.82, F2_Y + 0.54, bz, 0.16, 1.02, 4.4, matPanelConc);
    }

    // Interior furniture micro-details (Soviet wooden desks & radiators)
    buildOfficeDesk(propCtx, cx - side * 4.5, 0.08, -9.5, side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5, matWood, matSteel);
    buildOfficeDesk(propCtx, cx - side * 4.5, 0.08, 12.0, side > 0 ? Math.PI * 0.4 : -Math.PI * 0.4, matWood, matSteel);
    buildOfficeDesk(propCtx, cx - side * 4.0, F2_Y + 0.04, 8.0, 0.15, matWood, matSteel);
  };

  buildSideWing(-1);
  buildSideWing(1);

  // North block interior desks & barricades
  buildOfficeDesk(propCtx, -22, 0.08, -23.5, 0.12, matWood, matSteel);
  buildOfficeDesk(propCtx, 22, 0.08, -23.5, -0.18, matWood, matSteel);
  buildOfficeDesk(propCtx, -24, F2_Y + 0.04, -24.5, 0.3, matWood, matSteel);
  buildOfficeDesk(propCtx, 24, F2_Y + 0.04, -24.5, -0.25, matWood, matSteel);
  buildOfficeDesk(propCtx, 0, F2_Y + 0.04, -24.0, 0.08, matWood, matSteel);

  // === 4. SOUTH BOULEVARD PERIMETER WALL, BUS STOP & CENTRAL COURTYARD LANDMARKS ===
  // Iconic Soviet PO-2 precast concrete perimeter fence framing South & flanking edges
  addSolidBox(0, 1.45, 39.8, 92.0, 2.9, 0.45, matPanelConc);
  addSolidBox(-45.8, 1.45, 29.0, 0.45, 2.9, 21.2, matPanelConc);
  addSolidBox(45.8, 1.45, 29.0, 0.45, 2.9, 21.2, matPanelConc);
  addSolidBox(-45.8, 1.45, -26.5, 0.45, 2.9, 27.0, matPanelConc);
  addSolidBox(45.8, 1.45, -26.5, 0.45, 2.9, 27.0, matPanelConc);
  addSolidBox(0, 1.45, -39.8, 92.0, 2.9, 0.45, matPanelConc);

  // Rusted Soviet Bus Stop Pavilion on South Boulevard (X = 0, Z = 23.6)
  addSolidBox(0, 1.35, 25.2, 6.2, 2.55, 0.24, matTealPlaster);
  addSolidBox(-3.0, 1.35, 23.9, 0.22, 2.55, 2.4, matPanelConc);
  addSolidBox(3.0, 1.35, 23.9, 0.22, 2.55, 2.4, matPanelConc);
  addSolidBox(0, 2.74, 24.0, 6.6, 0.22, 2.9, matDarkConcrete);
  addSolidBox(0, 0.48, 24.6, 4.4, 0.14, 0.55, matWood, 'wood'); // weathered bench

  // Central Courtyard Abandoned Gazebo / Concrete Kiosk (X = 0, Z = 3.0)
  addSolidBox(0, 0.16, 3.0, 6.8, 0.32, 6.8, matSidewalk, 'concrete');
  for (const gx of [-2.8, 2.8]) {
    for (const gz of [-2.8, 2.8]) {
      addSolidBox(gx, 1.66, 3.0 + gz, 0.36, 2.68, 0.36, matRust, 'metal');
    }
  }
  addSolidBox(0, 3.12, 3.0, 7.2, 0.26, 7.2, matDarkConcrete, 'concrete');
  // Rusted playground climbing frame & swingset in West Lawn (X = -11.5, Z = 5.5)
  const swingGroup = new THREE.Group();
  swingGroup.position.set(-11.5, 0.07, 5.5);
  for (const sx of [-2.0, 2.0]) {
    const legA = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.05, 0.05, 2.9, 6)), matRust);
    legA.position.set(sx, 1.35, -0.55);
    legA.rotation.x = 0.24;
    const legB = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.05, 0.05, 2.9, 6)), matRust);
    legB.position.set(sx, 1.35, 0.55);
    legB.rotation.x = -0.24;
    swingGroup.add(legA, legB);
  }
  const topBar = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.06, 0.06, 4.4, 6)), matRust);
  topBar.rotation.z = Math.PI * 0.5;
  topBar.position.y = 2.65;
  swingGroup.add(topBar);
  sceneGroup.add(swingGroup);

  // Concrete Jersey Barriers & Sandbag Emplacements along Courtyard & Boulevard
  const coverPositions: Array<[number, number, number, number, number]> = [
    [-7.5, 0.52, -10.5, 3.4, 0.65],
    [7.5, 0.52, -10.5, 3.4, 0.65],
    [0, 0.52, -6.5, 4.2, 0.65],
    [-16.0, 0.52, 2.0, 0.7, 3.6],
    [16.0, 0.52, 2.0, 0.7, 3.6],
    [-12.0, 0.52, 16.5, 3.8, 0.7],
    [12.0, 0.52, 16.5, 3.8, 0.7],
  ];
  for (const [cx, cy, cz, cw, cd] of coverPositions) {
    addSolidBox(cx, cy, cz, cw, 1.04, cd, matSandbag, 'gravel');
  }

  // === 5. SEVEN DETAILED COMPOSITE RUSTED SOVIET VEHICLES ===
  buildRustedVehicle(propCtx, 'lada', -15.2, 0, -10.5, 0.42, vehTeal);
  buildRustedVehicle(propCtx, 'moskvitch', 14.8, 0, -9.8, -0.35, vehOchre);
  buildRustedVehicle(propCtx, 'zil_truck', 12.2, 0, 29.8, Math.PI * 0.46, vehTruck);
  buildRustedVehicle(propCtx, 'lada', -14.5, 0, 31.2, -Math.PI * 0.42, vehCream);
  buildRustedVehicle(propCtx, 'moskvitch', -6.8, 0, 14.5, 0.18, vehOchre);
  buildRustedVehicle(propCtx, 'lada', 17.5, 0, 15.2, -0.62, vehTeal);
  buildRustedVehicle(propCtx, 'pickup', -28.0, 0, 28.5, 0.85, vehTruck);

  // === 6. OVERGROWN EXCLUSION ZONE FOLIAGE (Birch Trees, Saplings & Grass Tufts) ===
  const rand = seededRand(19860426);
  const birchTarget = Math.max(18, Math.round(48 * qProfile.foliageDensity));
  const birchSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];

  // Hand-placed iconic courtyard birch saplings growing near lawns & cracks
  const courtyardTrees: Array<[number, number, number]> = [
    [-11.8, -0.4, 0.85],
    [-8.5, 8.8, 0.95],
    [9.4, 1.2, 1.02],
    [12.8, 8.2, 0.88],
    [10.2, -2.5, 0.72],
    [-17.5, -13.0, 0.78],
    [18.2, 19.5, 0.82],
    [-21.5, 34.5, 1.1],
    [22.5, 35.0, 1.15],
  ];
  for (const [tx, tz, sc] of courtyardTrees) {
    birchSpots.push({
      x: tx,
      y: 0.04,
      z: tz,
      scale: sc,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.24 + (rand() - 0.5) * 0.06, 0.34, 0.28 + rand() * 0.09),
    });
  }
  // Ring of dense Exclusion Zone birch forest outside the perimeter fences
  for (let i = 0; i < birchTarget; i++) {
    const ang = (i / birchTarget) * Math.PI * 2 + (rand() - 0.5) * 0.15;
    const dist = 48.0 + rand() * 26.0;
    const tx = Math.cos(ang) * dist;
    const tz = Math.sin(ang) * dist * 0.88;
    birchSpots.push({
      x: tx,
      y: 0,
      z: tz,
      scale: 0.9 + rand() * 0.55,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.22 + rand() * 0.08, 0.32 + rand() * 0.12, 0.26 + rand() * 0.1),
    });
  }
  buildInstancedBirchTrees(propCtx, birchSpots, false);

  // Overgrown grass, courtyard ferns & woody shrubs bursting through cracked asphalt & lawns
  const grassCount = Math.max(95, Math.round(290 * qProfile.foliageDensity));
  const grassSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let i = 0; i < grassCount * 2 && grassSpots.length < grassCount; i++) {
    const gx = (rand() - 0.5) * 80;
    const gz = -16 + rand() * 54;
    if (gz < -17.5) continue;
    if (Math.abs(gx) > 23.0 && gz < 18.8) continue;
    if (Math.abs(gx) < 3.8 && Math.abs(gz - 3.0) < 3.8) continue;
    grassSpots.push({
      x: gx,
      y: 0.05,
      z: gz,
      scale: 0.72 + rand() * 0.78,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.22 + (rand() - 0.5) * 0.08, 0.34, 0.42 + rand() * 0.14),
    });
  }
  buildInstancedGrassTufts(propCtx, grassSpots);

  const fernSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (const [cx, cz] of [[-10.5, 4.5], [10.5, 4.5]]) {
    for (let k = 0; k < 22; k++) {
      fernSpots.push({
        x: cx + (rand() - 0.5) * 10.0,
        y: 0.06,
        z: cz + (rand() - 0.5) * 12.2,
        scale: 0.75 + rand() * 0.55,
        yaw: rand() * Math.PI * 2,
        tint: new THREE.Color().setHSL(0.26 + (rand() - 0.5) * 0.05, 0.38, 0.36 + rand() * 0.14),
      });
    }
  }
  buildInstancedFerns(propCtx, fernSpots);

  const shrubSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  for (let k = 0; k < 26; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    shrubSpots.push({
      x: side * (5.5 + rand() * 11.5),
      y: 0.05,
      z: -11 + rand() * 44,
      scale: 0.8 + rand() * 0.65,
      yaw: rand() * Math.PI * 2,
      tint: new THREE.Color().setHSL(0.24 + (rand() - 0.5) * 0.07, 0.32, 0.36 + rand() * 0.14),
    });
  }
  buildInstancedUndergrowthShrubs(propCtx, shrubSpots);

  // Distant Pripyat 9-story Brezhnevka skyline silhouette blocks outside map bounds
  const skylineGeo = trackGeo(new THREE.BoxGeometry(28, 28, 14));
  const skylinePositions: Array<[number, number, number, number]> = [
    [-76, 14, -46, 0.12],
    [-28, 15, -72, 0],
    [28, 16, -72, 0.05],
    [76, 14, -42, -0.15],
    [-78, 13, 18, 0.08],
    [78, 14, 22, -0.08],
    [-46, 15, 74, 0.04],
    [46, 14, 74, -0.06],
  ];
  const skylineInst = new THREE.InstancedMesh(skylineGeo, matDarkConcrete, skylinePositions.length);
  skylinePositions.forEach(([bx, by, bz, ry], idx) => {
    dummy.position.set(bx, by, bz);
    dummy.rotation.set(0, ry, 0);
    dummy.scale.set(1, 0.85 + (idx % 3) * 0.22, 1);
    dummy.updateMatrix();
    skylineInst.setMatrixAt(idx, dummy.matrix);
  });
  skylineInst.instanceMatrix.needsUpdate = true;
  skylineInst.computeBoundingSphere();
  sceneGroup.add(skylineInst);

  // === 7. CYRILLIC SIGNAGE, STREETLAMPS & FLICKERING INTERIOR FLUORESCENTS ===
  const signNorthTex = trackTex(
    createStencilSignTexture('ПРИПЯТЬ · МИКРОРАЙОН 04', 'BLOCK 04 COURTYARD', '#e0a448', '#223635', maxAniso),
  );
  const signBusTex = trackTex(
    createStencilSignTexture('АВТОБУС · ЭНЕРГЕТИК', 'PRIPYAT TRANSIT', '#73c2b8', '#242929', maxAniso),
  );
  const makePlaque = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number): void => {
    const m = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(w, h)),
      trackMat(
        new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.72,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      ),
    );
    m.position.set(x, y, z);
    m.rotation.y = ry;
    sceneGroup.add(m);
  };
  makePlaque(signNorthTex, 3.8, 1.05, 0, 3.35, -17.96, 0);
  makePlaque(signBusTex, 2.8, 0.75, 0, 2.1, 25.04, Math.PI);

  // Flickering interior fluorescent lights & rusted boulevard streetlamps (capped by qProfile.maxAccentLights)
  const flickerLights: Array<{ light: THREE.PointLight; baseIntensity: number; phase: number; broken: boolean }> = [];
  const lightSpecs: Array<[number, number, number, number, number, boolean]> = [
    [0, 3.1, -27.0, 0xbae6db, 7.5, false],
    [-24.0, 3.1, -24.0, 0xbae6db, 6.5, true],
    [24.0, 3.1, -24.0, 0xbae6db, 6.5, false],
    [-32.5, 3.1, 2.0, 0xbae6db, 6.0, true],
    [32.5, 3.1, 2.0, 0xbae6db, 6.0, false],
    [0, 5.2, 23.5, 0xf5b95b, 8.5, true], // flickering amber sodium streetlamp at bus stop
    [-16.0, 6.5, -24.0, 0xbae6db, 5.5, false],
    [16.0, 6.5, -24.0, 0xbae6db, 5.5, false],
  ];
  const lightBudget = Math.min(lightSpecs.length, qProfile.maxAccentLights);
  for (let i = 0; i < lightBudget; i++) {
    const [lx, ly, lz, colorHex, inten, broken] = lightSpecs[i];
    const pl = new THREE.PointLight(colorHex, inten, 22, 1.75);
    pl.position.set(lx, ly, lz);
    sceneGroup.add(pl);
    flickerLights.push({ light: pl, baseIntensity: inten, phase: i * 1.7, broken });

    // Light fixture housing mesh
    const bulb = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(1.1, 0.08, 0.16)),
      colorHex === 0xf5b95b ? matAmberBulb : matTubeOn,
    );
    bulb.position.set(lx, ly + 0.14, lz);
    sceneGroup.add(bulb);
  }

  // === 8. COMPLETE 34-NODE NAVGRAPH (Courtyard + All 3 Buildings + 2nd Floors + Boulevard) ===
  const rawNodes: NavNode[] = [
    // Central Courtyard & Gazebo
    { id: 'c_north', position: [0, 0, -11.0], zoneId: 'default', neighbors: ['n_breeze', 'c_nw', 'c_ne', 'c_mid'] },
    { id: 'c_mid', position: [0, 0, 3.0], zoneId: 'default', neighbors: ['c_north', 'c_south', 'c_w', 'c_e'], isCover: true, coverNormal: [0, 1] },
    { id: 'c_south', position: [0, 0, 16.5], zoneId: 'default', neighbors: ['c_mid', 'c_sw', 'c_se', 'blvd_c'], isCover: true, coverNormal: [0, -1] },
    { id: 'c_nw', position: [-14.5, 0, -10.5], zoneId: 'default', neighbors: ['c_north', 'c_w', 'w_g_n', 'n_g_w'], isCover: true, coverNormal: [1, 1] },
    { id: 'c_ne', position: [14.5, 0, -10.5], zoneId: 'default', neighbors: ['c_north', 'c_e', 'e_g_n', 'n_g_e'], isCover: true, coverNormal: [-1, 1] },
    { id: 'c_w', position: [-17.5, 0, 2.5], zoneId: 'default', neighbors: ['c_nw', 'c_sw', 'c_mid', 'w_g_s'], isCover: true, coverNormal: [1, 0] },
    { id: 'c_e', position: [17.5, 0, 2.5], zoneId: 'default', neighbors: ['c_ne', 'c_se', 'c_mid', 'e_g_s'], isCover: true, coverNormal: [-1, 0] },
    { id: 'c_sw', position: [-15.5, 0, 15.0], zoneId: 'default', neighbors: ['c_w', 'c_south', 'blvd_w', 'w_g_s'] },
    { id: 'c_se', position: [15.5, 0, 15.0], zoneId: 'default', neighbors: ['c_e', 'c_south', 'blvd_e', 'e_g_s'] },

    // South Boulevard & Bus Stop
    { id: 'blvd_w', position: [-24.0, 0, 28.0], zoneId: 'default', neighbors: ['c_sw', 'blvd_c', 'w_g_s'], isCover: true, coverNormal: [0, -1] },
    { id: 'blvd_c', position: [0, 0, 29.0], zoneId: 'default', neighbors: ['c_south', 'blvd_w', 'blvd_e'], isCover: true, coverNormal: [0, -1] },
    { id: 'blvd_e', position: [24.0, 0, 28.0], zoneId: 'default', neighbors: ['c_se', 'blvd_c', 'e_g_s'], isCover: true, coverNormal: [0, -1] },

    // North Brezhnevka Block (Ground + 2nd Floor)
    { id: 'n_breeze', position: [0, 0.08, -26.5], zoneId: 'default', neighbors: ['c_north', 'n_back', 'n_g_w', 'n_g_e'] },
    { id: 'n_back', position: [0, 0, -37.5], zoneId: 'default', neighbors: ['n_breeze'] },
    { id: 'n_g_w', position: [-19.5, 0.08, -22.5], zoneId: 'default', neighbors: ['c_nw', 'n_breeze', 'n_stair_wb', 'n_g_fw'] },
    { id: 'n_g_fw', position: [-29.0, 0.08, -23.0], zoneId: 'default', neighbors: ['n_g_w'], isCover: true, coverNormal: [1, 0] },
    { id: 'n_g_e', position: [19.5, 0.08, -22.5], zoneId: 'default', neighbors: ['c_ne', 'n_breeze', 'n_stair_eb', 'n_g_fe'] },
    { id: 'n_g_fe', position: [29.0, 0.08, -23.0], zoneId: 'default', neighbors: ['n_g_e'], isCover: true, coverNormal: [-1, 0] },

    { id: 'n_stair_wb', position: [-9.5, 0.08, -19.2], zoneId: 'default', neighbors: ['n_g_w', 'n_u_w'] },
    { id: 'n_stair_eb', position: [9.5, 0.08, -19.2], zoneId: 'default', neighbors: ['n_g_e', 'n_u_e'] },
    { id: 'n_u_w', position: [-9.5, F2_Y + 0.04, -31.5], zoneId: 'default', neighbors: ['n_stair_wb', 'n_u_c', 'n_u_fw'], isCover: true, coverNormal: [0, 1] },
    { id: 'n_u_fw', position: [-24.0, F2_Y + 0.04, -22.0], zoneId: 'default', neighbors: ['n_u_w'], isCover: true, coverNormal: [0, 1] },
    { id: 'n_u_c', position: [0, F2_Y + 0.04, -22.0], zoneId: 'default', neighbors: ['n_u_w', 'n_u_e'], isCover: true, coverNormal: [0, 1] },
    { id: 'n_u_e', position: [9.5, F2_Y + 0.04, -31.5], zoneId: 'default', neighbors: ['n_stair_eb', 'n_u_c', 'n_u_fe'], isCover: true, coverNormal: [0, 1] },
    { id: 'n_u_fe', position: [24.0, F2_Y + 0.04, -22.0], zoneId: 'default', neighbors: ['n_u_e'], isCover: true, coverNormal: [0, 1] },

    // West Wing (Ground + 2nd Floor)
    { id: 'w_g_n', position: [-30.0, 0.08, -6.5], zoneId: 'default', neighbors: ['c_nw', 'w_g_s'] },
    { id: 'w_g_s', position: [-30.0, 0.08, 10.5], zoneId: 'default', neighbors: ['w_g_n', 'c_w', 'c_sw', 'blvd_w', 'w_stair_b'] },
    { id: 'w_stair_b', position: [-37.4, 0.08, 4.0], zoneId: 'default', neighbors: ['w_g_s', 'w_u_n'] },
    { id: 'w_u_n', position: [-33.0, F2_Y + 0.04, -8.5], zoneId: 'default', neighbors: ['w_stair_b', 'w_u_s'], isCover: true, coverNormal: [1, 0] },
    { id: 'w_u_s', position: [-30.0, F2_Y + 0.04, 11.0], zoneId: 'default', neighbors: ['w_u_n'], isCover: true, coverNormal: [1, 0] },

    // East Wing (Ground + 2nd Floor)
    { id: 'e_g_n', position: [30.0, 0.08, -6.5], zoneId: 'default', neighbors: ['c_ne', 'e_g_s'] },
    { id: 'e_g_s', position: [30.0, 0.08, 10.5], zoneId: 'default', neighbors: ['e_g_n', 'c_e', 'c_se', 'blvd_e', 'e_stair_b'] },
    { id: 'e_stair_b', position: [37.4, 0.08, 4.0], zoneId: 'default', neighbors: ['e_g_s', 'e_u_n'] },
    { id: 'e_u_n', position: [33.0, F2_Y + 0.04, -8.5], zoneId: 'default', neighbors: ['e_stair_b', 'e_u_s'], isCover: true, coverNormal: [-1, 0] },
    { id: 'e_u_s', position: [30.0, F2_Y + 0.04, 11.0], zoneId: 'default', neighbors: ['e_u_n'], isCover: true, coverNormal: [-1, 0] },
  ];

  const teamA: SpawnPoint[] = [
    { position: [0, 0.08, -32.0], yaw: Math.PI },
    { position: [-22.0, 0.08, -31.5], yaw: Math.PI * 0.85 },
    { position: [22.0, 0.08, -31.5], yaw: -Math.PI * 0.85 },
    { position: [-28.0, 0.08, -22.5], yaw: Math.PI * 0.8 },
    { position: [28.0, 0.08, -22.5], yaw: -Math.PI * 0.8 },
    { position: [0, F2_Y + 0.04, -22.5], yaw: Math.PI },
  ];
  const teamB: SpawnPoint[] = [
    { position: [0, 0, 34.5], yaw: 0 },
    { position: [-22.0, 0, 33.0], yaw: Math.PI * 0.15 },
    { position: [22.0, 0, 33.0], yaw: -Math.PI * 0.15 },
    { position: [-30.0, 0.08, 13.5], yaw: Math.PI * 0.35 },
    { position: [30.0, 0.08, 13.5], yaw: -Math.PI * 0.35 },
    { position: [-10.0, 0, 35.0], yaw: 0 },
  ];
  const ffa: SpawnPoint[] = [
    ...teamA,
    ...teamB,
    { position: [-30.0, F2_Y + 0.04, 10.0], yaw: -Math.PI * 0.5 },
    { position: [30.0, F2_Y + 0.04, 10.0], yaw: Math.PI * 0.5 },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'pripyat_block',
    name: 'Pripyat Block',
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
      nightLights,
    },
    update: (_dt, elapsedSec) => {
      for (const fl of flickerLights) {
        if (fl.broken) {
          const pulse = Math.sin(elapsedSec * 18.0 + fl.phase) * Math.sin(elapsedSec * 5.2 + fl.phase);
          fl.light.intensity = pulse > 0.48 ? fl.baseIntensity * 0.16 : fl.baseIntensity;
        } else {
          fl.light.intensity = fl.baseIntensity * (0.97 + Math.sin(elapsedSec * 6.5 + fl.phase) * 0.03);
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

export const PRIPYAT_BLOCK_MAP: IMapDefinition = {
  id: 'pripyat_block',
  name: 'Pripyat Block',
  subtitle: 'Abandoned Soviet Microdistrict',
  description:
    'Expanded Pripyat courtyard block with three enterable 2-story Brezhnevka apartment wings, peeling turquoise plaster halls, detailed rusted Soviet vehicles, and overgrown birch foliage.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Urban Courtyard', '3 Enterable Wings', 'Soviet Decay'],
  accentHex: '#f59e0b',
  previewStyle: 'cqb_pripyat',
  build: buildPripyatBlock,
};

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { getGraphicsQualityProfile, GraphicsQualityId } from '../data/graphicsQuality';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  buildOfficeDesk,
  buildRustedVehicle,
  PropFactoryContext,
  VehicleMaterials,
} from './MapPropFactory';
import {
  createAsphaltRoadTexture,
  createCabinWoodTexture,
  createChalkBlueprintTexture,
  createCinemaScreenTexture,
  createKinoArtDecoTileTexture,
  createKinoEmeraldWallTexture,
  createKinoPosterTexture,
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

// Art-Deco Noir Atmosphere: Deep slate-midnight sky, cold moonlight, emerald-brass interior (less red!)
const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x090f14,
  fogHex: 0x0b1216,
  fogDensity: 0.022,
  envIntensity: 0.28,
  hemiSkyHex: 0x526b84,
  hemiGroundHex: 0x161f1e,
  hemiIntensity: 0.42,
  keyLightHex: 0x9ec0e6,
  keyLightIntensity: 0.72,
  keyLightPos: [20, 32, 14],
};

function buildKinoTheater(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
  graphicsQuality?: GraphicsQualityId,
): BuiltMapInstance {
  const qProfile = getGraphicsQualityProfile(graphicsQuality);

  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -22.2;
  physics.boundsMaxX = 22.2;
  physics.boundsMinZ = -24.5;
  physics.boundsMaxZ = 22.2;

  const sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const interactables: MapInteractable[] = [];

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
    moonLight.shadow.camera.far = 85;
    moonLight.shadow.camera.left = -28;
    moonLight.shadow.camera.right = 28;
    moonLight.shadow.camera.top = 28;
    moonLight.shadow.camera.bottom = -28;
    moonLight.shadow.bias = -0.0005;
    moonLight.shadow.normalBias = 0.025;
  }
  sceneGroup.add(moonLight);

  const maxAniso = Math.min(qProfile.anisotropyCap, renderer.capabilities.getMaxAnisotropy() || 4);

  // Original Art-Deco Noir Textures (Emerald-Jade, Tarnished Brass, Cream Terrazzo, Dark Walnut)
  const tileTex = trackTex(createKinoArtDecoTileTexture(maxAniso, 6, 4));
  const wallTex = trackTex(createKinoEmeraldWallTexture(maxAniso, 3, 1));
  const stageWoodTex = trackTex(createCabinWoodTexture(maxAniso, 4, 2, '#423225', 1948));
  const crateWoodTex = trackTex(createCabinWoodTexture(maxAniso, 1, 1, '#584430', 1952));
  const alleyTex = trackTex(createAsphaltRoadTexture(maxAniso, 5, 5, false, 1962));
  const screenTex = trackTex(createCinemaScreenTexture(maxAniso));
  const rustTex = trackTex(createRustedMetalTexture(maxAniso, '#364648', 1943));

  const matTile = trackMat(
    new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.38, metalness: 0.1 }),
  );
  const matTheaterWall = trackMat(
    new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.82, metalness: 0.06 }),
  );
  // Deep slate-emerald carpet & emerald velvet drapes/seats (replacing red!)
  const matCarpet = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x162928, roughness: 0.96, metalness: 0.02 }),
  );
  const matVelvet = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x17453e, roughness: 0.88, metalness: 0.05 }),
  );
  const matCastIron = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x202427, roughness: 0.52, metalness: 0.74 }),
  );
  const matBrass = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xbfa054, roughness: 0.32, metalness: 0.84 }),
  );
  const matCopper = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x9e623d, roughness: 0.36, metalness: 0.82 }),
  );
  const matStageWood = trackMat(
    new THREE.MeshStandardMaterial({ map: stageWoodTex, roughness: 0.76, metalness: 0.04 }),
  );
  const matBarricadeWood = trackMat(
    new THREE.MeshStandardMaterial({ map: crateWoodTex, roughness: 0.9, metalness: 0.02 }),
  );
  const matAlley = trackMat(
    new THREE.MeshStandardMaterial({ map: alleyTex, roughness: 0.74, metalness: 0.08 }),
  );
  const matCeiling = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x13191b, roughness: 0.95, metalness: 0.03 }),
  );
  const matScreen = trackMat(
    new THREE.MeshStandardMaterial({
      map: screenTex,
      roughness: 0.92,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );
  // Subtle warm-amber/emerald Art-Deco exit lamps instead of harsh red
  const matExitGlow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x5eead4,
      emissive: 0x14b8a6,
      emissiveIntensity: 1.5,
      roughness: 0.3,
    }),
  );
  const matSconceAmber = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffe4b5,
      emissive: 0xe6a84a,
      emissiveIntensity: 1.8,
      roughness: 0.25,
    }),
  );
  const matMeteorShard = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x10b981,
      emissiveIntensity: 2.2,
      roughness: 0.18,
      metalness: 0.25,
    }),
  );
  const matFilmCanister = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xbec5c8,
      roughness: 0.32,
      metalness: 0.86,
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
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    colliderId?: string,
    parent: THREE.Object3D = sceneGroup,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !isSoftwareGl && qProfile.castShadows && h > 0.35;
    mesh.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    mesh.userData.surfaceMaterial = surface;
    parent.add(mesh);
    raycastMeshes.push(mesh);
    physics.addBox({
      id: colliderId,
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

  // === 1. FLOORING & ZONES (Strict Y separation >= 0.035m -> ZERO Z-FIGHTING) ===
  const baseFloor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(58, 58)), matAlley);
  baseFloor.rotation.x = -Math.PI * 0.5;
  baseFloor.position.y = 0;
  baseFloor.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  baseFloor.userData.surfaceMaterial = 'asphalt';
  sceneGroup.add(baseFloor);
  raycastMeshes.push(baseFloor);

  // Grand Foyer Art-Deco Terrazzo Slab (solid thin slab y top = 0.04m)
  const lobbyFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.5, 0.04, 13.7)), matTile);
  lobbyFloor.position.set(0, 0.02, 15.1);
  lobbyFloor.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  lobbyFloor.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(lobbyFloor);
  raycastMeshes.push(lobbyFloor);
  physics.addSurfaceZone({ minX: -13, maxX: 13, minZ: 8, maxZ: 22, surface: 'concrete' });

  // West Dressing Room Walnut Plank Floor (y top = 0.04m)
  const westFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(8.6, 0.04, 37.6)), matStageWood);
  westFloor.position.set(-17.6, 0.02, -4.8);
  westFloor.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  westFloor.userData.surfaceMaterial = 'wood';
  sceneGroup.add(westFloor);
  raycastMeshes.push(westFloor);

  // Main Auditorium Sloped Emerald Carpet Floor
  const audFloorSlopeLen = Math.hypot(15.75, 1.2);
  const audFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.5, 0.14, audFloorSlopeLen)), matCarpet);
  audFloor.position.set(0, 0.57, -0.125);
  audFloor.rotation.x = Math.atan2(1.2, 15.75);
  audFloor.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  audFloor.userData.surfaceMaterial = 'wood';
  sceneGroup.add(audFloor);
  raycastMeshes.push(audFloor);
  physics.addRamp({
    minX: -13,
    maxX: 13,
    minZ: -8,
    maxZ: 8,
    baseY: 0,
    topY: 1.2,
    riseAxis: '+z',
    surface: 'wood',
  });

  // Flat orchestra pit floor (y top = 0.04m, cleanly clears sloped floor)
  const pitFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.5, 0.04, 6.9)), matCarpet);
  pitFloor.position.set(0, 0.02, -11.55);
  pitFloor.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  pitFloor.userData.surfaceMaterial = 'wood';
  sceneGroup.add(pitFloor);
  raycastMeshes.push(pitFloor);

  // Elevated Walnut Stage (Z in [-24, -15], Y = 0.85m) + Brass Stage Footlight Apron
  addSolidBox(0, 0.425, -19.5, 25.0, 0.85, 9.0, matStageWood, 'wood');
  for (let fx = -6.0; fx <= 6.0; fx += 2.0) {
    const hood = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 0.12, 0.22)), matBrass);
    hood.position.set(fx, 0.91, -15.16);
    sceneGroup.add(hood);
  }
  for (const sx of [-9.2, 9.2]) {
    physics.addRamp({
      minX: sx - 1.8,
      maxX: sx + 1.8,
      minZ: -15.0,
      maxZ: -12.6,
      baseY: 0,
      topY: 0.85,
      riseAxis: '-z',
      surface: 'wood',
    });
    const stRamp = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(3.6, 0.16, Math.hypot(2.4, 0.85))),
      matStageWood,
    );
    stRamp.position.set(sx, 0.36, -13.8);
    stRamp.rotation.x = Math.atan2(0.85, 2.4);
    stRamp.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    stRamp.userData.surfaceMaterial = 'wood';
    sceneGroup.add(stRamp);
    raycastMeshes.push(stRamp);
  }

  physics.addInteriorZone({ minX: -22, maxX: 13, minY: 0, maxY: 9, minZ: -24, maxZ: 22, material: 'wood' });

  // === 2. MAIN ARCHITECTURAL WALLS, FRAMED ZOMBIE WINDOWS & DARK SPAWN HALLWAYS ===
  const H = 7.6;
  const WINDOW_WIDTH = 1.92;
  const WINDOW_SILL_H = 0.94;
  const WINDOW_OPEN_H = 1.46; // sill 0.94 -> header 2.40m
  const MAX_BARRIER_PLANKS = 5;

  const matHallwayWall = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x101417,
      roughness: 0.96,
      metalness: 0.04,
    }),
  );
  const matHallwayFloor = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0d1012,
      roughness: 0.94,
      metalness: 0.05,
    }),
  );
  const matWindowFrame = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2a1d15,
      roughness: 0.78,
      metalness: 0.14,
    }),
  );
  const matNailIron = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3b4046,
      roughness: 0.45,
      metalness: 0.85,
    }),
  );

  interface WindowSpec {
    spawnerId: string;
    zoneId: string;
    label: string;
    centerAlong: number;
    baseY: number;
    entryNodeId: string;
    hallwayDepth?: number;
  }

  interface PlankAnimItem {
    group: THREE.Group;
    restPos: THREE.Vector3;
    restRot: THREE.Euler;
    outwardDir: THREE.Vector3; // points into hallway (-windowNormal)
    state: 'attached' | 'tearing' | 'removed' | 'repairing';
    animT: number;
  }

  const zombieSpawners: ZombieSpawnerDef[] = [];
  const windowBarriers: MapWindowBarrier[] = [];
  const plankAnimItems: PlankAnimItem[] = [];

  const plankBoardGeo = trackGeo(new THREE.BoxGeometry(WINDOW_WIDTH + 0.22, 0.19, 0.06));
  const plankNailGeo = trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 0.075, 6));
  plankNailGeo.rotateX(Math.PI * 0.5);

  const buildWindowAndHallway = (
    axis: 'x' | 'z',
    fixedCoord: number,
    thickness: number,
    wallHeight: number,
    wallMat: THREE.Material,
    normalSign: 1 | -1,
    spec: WindowSpec,
  ): void => {
    const winW = WINDOW_WIDTH;
    const baseY = spec.baseY;
    const sillTopY = baseY + WINDOW_SILL_H;
    const headBotY = sillTopY + WINDOW_OPEN_H;
    const hallDepth = spec.hallwayDepth ?? 3.6;

    // Normal pointing from hallway INTO playable room
    const nx = axis === 'z' ? normalSign : 0;
    const nz = axis === 'x' ? normalSign : 0;
    // Outward direction into hallway
    const ox = -nx;
    const oz = -nz;

    const cx = axis === 'x' ? spec.centerAlong : fixedCoord;
    const cz = axis === 'z' ? spec.centerAlong : fixedCoord;

    // 1. Lower sill wall (0 -> sillTopY) — solid collider blocks player from stepping into hallway
    if (sillTopY > 0.05) {
      if (axis === 'x') {
        addSolidBox(cx, sillTopY * 0.5, cz, winW, sillTopY, thickness, wallMat);
      } else {
        addSolidBox(cx, sillTopY * 0.5, cz, thickness, sillTopY, winW, wallMat);
      }
    }
    // 2. Upper header wall (headBotY -> wallHeight)
    const headH = Math.max(0.1, wallHeight - headBotY);
    if (axis === 'x') {
      addSolidBox(cx, headBotY + headH * 0.5, cz, winW, headH, thickness, wallMat);
    } else {
      addSolidBox(cx, headBotY + headH * 0.5, cz, thickness, headH, winW, wallMat);
    }

    // 3. Recessed architectural window frame (left jamb, right jamb, sill ledge, header trim)
    const frameDepth = thickness + 0.08;
    const frameGroup = new THREE.Group();
    frameGroup.position.set(cx, sillTopY, cz);
    // Align local +Z to point into the playable room (windowNormal)
    const frameYaw = Math.atan2(nx, nz);
    frameGroup.rotation.y = frameYaw;

    const jambGeo = trackGeo(new THREE.BoxGeometry(0.11, WINDOW_OPEN_H + 0.08, frameDepth));
    const leftJamb = new THREE.Mesh(jambGeo, matWindowFrame);
    leftJamb.position.set(-winW * 0.5 + 0.055, WINDOW_OPEN_H * 0.5, 0);
    const rightJamb = new THREE.Mesh(jambGeo, matWindowFrame);
    rightJamb.position.set(winW * 0.5 - 0.055, WINDOW_OPEN_H * 0.5, 0);

    const sillLedge = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(winW + 0.14, 0.09, frameDepth + 0.1)),
      matWindowFrame,
    );
    sillLedge.position.set(0, -0.02, 0);
    const headerTrim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(winW + 0.14, 0.11, frameDepth + 0.06)),
      matWindowFrame,
    );
    headerTrim.position.set(0, WINDOW_OPEN_H + 0.03, 0);
    frameGroup.add(leftJamb, rightJamb, sillLedge, headerTrim);
    sceneGroup.add(frameGroup);

    // 4. Enclosed dark spawn hallway behind the window (aligned flush to exterior face of wall)
    const hallW = winW + 0.72;
    const hallH = 3.05;
    const wallHalfT = thickness * 0.5;
    const hallCenterDist = wallHalfT + hallDepth * 0.5;
    const hallGroup = new THREE.Group();
    hallGroup.position.set(cx + ox * hallCenterDist, baseY, cz + oz * hallCenterDist);
    hallGroup.rotation.y = frameYaw;

    // Hallway floor
    const hFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(hallW, 0.12, hallDepth)), matHallwayFloor);
    hFloor.position.set(0, -0.04, 0);
    // Hallway ceiling
    const hCeil = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(hallW + 0.24, 0.16, hallDepth + 0.2)), matHallwayWall);
    hCeil.position.set(0, hallH, 0);
    // Hallway left & right masonry walls + back wall
    const hSideGeo = trackGeo(new THREE.BoxGeometry(0.24, hallH, hallDepth + 0.12));
    const hLeft = new THREE.Mesh(hSideGeo, matHallwayWall);
    hLeft.position.set(-hallW * 0.5 - 0.04, hallH * 0.5, 0);
    const hRight = new THREE.Mesh(hSideGeo, matHallwayWall);
    hRight.position.set(hallW * 0.5 + 0.04, hallH * 0.5, 0);
    const hBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(hallW + 0.28, hallH, 0.24)), matHallwayWall);
    hBack.position.set(0, hallH * 0.5, -hallDepth * 0.5 - 0.06);

    // Subtle dark architectural ribs inside hallway so zombie silhouette reads clearly
    const ribGeo = trackGeo(new THREE.BoxGeometry(0.14, hallH - 0.1, 0.14));
    for (const rz of [-hallDepth * 0.25, hallDepth * 0.2]) {
      const rl = new THREE.Mesh(ribGeo, matCastIron);
      rl.position.set(-hallW * 0.5 + 0.08, hallH * 0.5, rz);
      const rr = new THREE.Mesh(ribGeo, matCastIron);
      rr.position.set(hallW * 0.5 - 0.08, hallH * 0.5, rz);
      hallGroup.add(rl, rr);
    }

    hallGroup.add(hFloor, hCeil, hLeft, hRight, hBack);
    sceneGroup.add(hallGroup);

    // If hallway protrudes into an interior wing (e.g. auditorium side shafts), add exterior box collider so players walk cleanly around it
    if (hallDepth <= 2.6) {
      const minX = Math.min(cx + ox * wallHalfT, cx + ox * (wallHalfT + hallDepth)) - (axis === 'x' ? hallW * 0.55 : 0.08);
      const maxX = Math.max(cx + ox * wallHalfT, cx + ox * (wallHalfT + hallDepth)) + (axis === 'x' ? hallW * 0.55 : 0.08);
      const minZ = Math.min(cz + oz * wallHalfT, cz + oz * (wallHalfT + hallDepth)) - (axis === 'z' ? hallW * 0.55 : 0.08);
      const maxZ = Math.max(cz + oz * wallHalfT, cz + oz * (wallHalfT + hallDepth)) + (axis === 'z' ? hallW * 0.55 : 0.08);
      physics.addBox({
        minX,
        maxX,
        minY: 0,
        maxY: baseY + hallH + 0.2,
        minZ,
        maxZ,
        surface: 'concrete',
        blocksMovement: true,
      });
    }

    // 5. Mount 5 aligned wooden barrier planks flush across the window jambs (ZERO floating)
    const plankItems: PlankAnimItem[] = [];
    const plankTilts = [-0.032, 0.026, -0.022, 0.034, -0.028];
    const plankDepthOffsets = [0.025, -0.015, 0.03, -0.01, 0.02];

    for (let k = 0; k < MAX_BARRIER_PLANKS; k++) {
      const pGroup = new THREE.Group();
      const board = new THREE.Mesh(plankBoardGeo, matBarricadeWood);
      board.castShadow = !isSoftwareGl && qProfile.castShadows;
      board.receiveShadow = !isSoftwareGl && qProfile.castShadows;
      const nailL = new THREE.Mesh(plankNailGeo, matNailIron);
      nailL.position.set(-(winW * 0.5 - 0.04), 0, 0.01);
      const nailR = new THREE.Mesh(plankNailGeo, matNailIron);
      nailR.position.set(winW * 0.5 - 0.04, 0, 0.01);
      pGroup.add(board, nailL, nailR);

      const yFrac = (k + 0.5) / MAX_BARRIER_PLANKS;
      const py = sillTopY + 0.08 + yFrac * (WINDOW_OPEN_H - 0.16);
      // Mount flush against the room-facing window jamb surface (slight recess inside jamb)
      const faceOffset = wallHalfT * 0.45 + plankDepthOffsets[k];
      const restPos = new THREE.Vector3(cx + nx * faceOffset, py, cz + nz * faceOffset);
      const restRot = new THREE.Euler(0, frameYaw, plankTilts[k]);

      pGroup.position.copy(restPos);
      pGroup.rotation.copy(restRot);
      sceneGroup.add(pGroup);

      const item: PlankAnimItem = {
        group: pGroup,
        restPos,
        restRot,
        outwardDir: new THREE.Vector3(ox, 0, oz),
        state: 'attached',
        animT: 1,
      };
      plankItems.push(item);
      plankAnimItems.push(item);
    }

    let planksRemaining = MAX_BARRIER_PLANKS;

    const applyPlankCountImmediate = (targetCount: number): void => {
      const clamped = Math.max(0, Math.min(MAX_BARRIER_PLANKS, Math.round(targetCount)));
      planksRemaining = clamped;
      for (let i = 0; i < plankItems.length; i++) {
        const it = plankItems[i];
        if (i < clamped) {
          it.state = 'attached';
          it.animT = 1;
          it.group.visible = true;
          it.group.position.copy(it.restPos);
          it.group.rotation.copy(it.restRot);
        } else {
          it.state = 'removed';
          it.animT = 1;
          it.group.visible = false;
        }
      }
    };

    const tearPlank = (): boolean => {
      if (planksRemaining <= 0) return false;
      planksRemaining -= 1;
      const item = plankItems[planksRemaining];
      item.state = 'tearing';
      item.animT = 0;
      item.group.visible = true;
      return true;
    };

    const repairPlank = (): boolean => {
      if (planksRemaining >= MAX_BARRIER_PLANKS) return false;
      const item = plankItems[planksRemaining];
      planksRemaining += 1;
      item.state = 'repairing';
      item.animT = 0;
      item.group.visible = true;
      return true;
    };

    const spawnDist = wallHalfT + Math.max(1.85, hallDepth - 0.65);
    const outerStandDist = wallHalfT + 0.72;
    const entryDist = wallHalfT + 1.18;
    const interactDist = wallHalfT + 1.12;

    const spawnPos: [number, number, number] = [cx + ox * spawnDist, baseY, cz + oz * spawnDist];
    const windowOuterPos: [number, number, number] = [cx + ox * outerStandDist, baseY, cz + oz * outerStandDist];
    const sillPos: [number, number, number] = [cx, sillTopY, cz];
    const entryPos: [number, number, number] = [cx + nx * entryDist, baseY, cz + nz * entryDist];
    const interactPos: [number, number, number] = [cx + nx * interactDist, baseY + 1.15, cz + nz * interactDist];
    const windowNormal: [number, number, number] = [nx, 0, nz];
    const yaw = Math.atan2(nx, nz);

    zombieSpawners.push({
      id: spec.spawnerId,
      zoneId: spec.zoneId,
      spawnPos,
      windowOuterPos,
      sillPos,
      entryPos,
      windowNormal,
      maxPlanks: MAX_BARRIER_PLANKS,
      entryNodeId: spec.entryNodeId,
      yaw,
    });

    const barrierId = `bar_${spec.spawnerId}`;
    windowBarriers.push({
      id: barrierId,
      spawnerId: spec.spawnerId,
      zoneId: spec.zoneId,
      label: spec.label,
      interactPos,
      sillPos,
      windowOuterPos,
      entryPos,
      windowNormal,
      maxPlanks: MAX_BARRIER_PLANKS,
      getPlanksRemaining: () => planksRemaining,
      tearPlank,
      repairPlank,
      setPlankCount: applyPlankCountImmediate,
    });

    interactables.push({
      id: barrierId,
      kind: 'window_barrier',
      label: spec.label,
      cost: 0,
      position: interactPos,
      radiusM: 2.35,
      barrierId,
      activated: false,
    });
  };

  const addSegmentedWallWithWindows = (
    axis: 'x' | 'z',
    fixedCoord: number,
    spanStart: number,
    spanEnd: number,
    thickness: number,
    wallHeight: number,
    wallMat: THREE.Material,
    normalSign: 1 | -1,
    windows: WindowSpec[],
  ): void => {
    const sorted = [...windows].sort((a, b) => a.centerAlong - b.centerAlong);
    let cursor = spanStart;

    for (const w of sorted) {
      const wStart = w.centerAlong - WINDOW_WIDTH * 0.5;
      const wEnd = w.centerAlong + WINDOW_WIDTH * 0.5;
      if (wStart > cursor + 0.04) {
        const segLen = wStart - cursor;
        const segMid = (cursor + wStart) * 0.5;
        if (axis === 'x') {
          addSolidBox(segMid, wallHeight * 0.5, fixedCoord, segLen, wallHeight, thickness, wallMat);
        } else {
          addSolidBox(fixedCoord, wallHeight * 0.5, segMid, thickness, wallHeight, segLen, wallMat);
        }
      }
      buildWindowAndHallway(axis, fixedCoord, thickness, wallHeight, wallMat, normalSign, w);
      cursor = wEnd;
    }

    if (spanEnd > cursor + 0.04) {
      const segLen = spanEnd - cursor;
      const segMid = (cursor + spanEnd) * 0.5;
      if (axis === 'x') {
        addSolidBox(segMid, wallHeight * 0.5, fixedCoord, segLen, wallHeight, thickness, wallMat);
      } else {
        addSolidBox(fixedCoord, wallHeight * 0.5, segMid, thickness, wallHeight, segLen, wallMat);
      }
    }
  };

  // South Lobby Wall (z = 22.2, x in [-13.225, 13.225]) with 2 framed windows + hallways
  addSegmentedWallWithWindows('x', 22.2, -13.225, 13.225, 0.5, H, matTheaterWall, -1, [
    { spawnerId: 'sp_lob_sw', zoneId: 'lobby', label: 'Foyer South-West Window', centerAlong: -5.5, baseY: 0.04, entryNodeId: 'lob_sw' },
    { spawnerId: 'sp_lob_se', zoneId: 'lobby', label: 'Foyer South-East Window', centerAlong: 5.5, baseY: 0.04, entryNodeId: 'lob_se' },
  ]);

  // North Stage Back Wall (z = -24.2, x in [-22.45, 22.45]) with 2 backstage flank windows + hallways
  addSegmentedWallWithWindows('x', -24.2, -22.45, 22.45, 0.5, H, matTheaterWall, 1, [
    { spawnerId: 'sp_stage_w', zoneId: 'auditorium', label: 'Backstage West Window', centerAlong: -11.3, baseY: 0.85, entryNodeId: 'stage_l' },
    { spawnerId: 'sp_stage_e', zoneId: 'auditorium', label: 'Backstage East Window', centerAlong: 11.3, baseY: 0.85, entryNodeId: 'stage_r' },
  ]);

  // West Wing Outer Wall (x = -22.2, z in [-23.95, 14.45]) with 2 windows + hallways
  addSegmentedWallWithWindows('z', -22.2, -23.95, 14.45, 0.5, H, matTheaterWall, 1, [
    { spawnerId: 'sp_ww_2', zoneId: 'west_wing', label: 'Dressing Wing North Window', centerAlong: -7.0, baseY: 0.04, entryNodeId: 'ww_n' },
    { spawnerId: 'sp_ww_1', zoneId: 'west_wing', label: 'Dressing Wing South Window', centerAlong: 2.5, baseY: 0.04, entryNodeId: 'ww_mid' },
  ]);
  addSolidBox(-17.5875, H * 0.5, 14.2, 8.725, H, 0.5, matTheaterWall);

  // East Back Alley Outer Wall (x = 22.2, z in [-23.95, 14.45]) with 2 windows + hallways
  addSegmentedWallWithWindows('z', 22.2, -23.95, 14.45, 0.5, 7.6, matAlley, -1, [
    { spawnerId: 'sp_ew_2', zoneId: 'east_wing', label: 'Alley North Window', centerAlong: -7.0, baseY: 0.0, entryNodeId: 'ew_n' },
    { spawnerId: 'sp_ew_1', zoneId: 'east_wing', label: 'Alley South Window', centerAlong: 2.5, baseY: 0.0, entryNodeId: 'ew_mid' },
  ]);
  addSolidBox(17.5875, 3.8, 14.2, 8.725, 7.6, 0.5, matAlley);

  // Lobby/Auditorium Divider Wall (z = 8.0)
  addSolidBox(0, H * 0.5, 8.0, 25.55, H, 0.5, matTheaterWall);

  // West Interior Divider Wall (x = -13.0): Lobby West Window (z=19.8) + Auditorium West Window (z=0.5)
  addSegmentedWallWithWindows('z', -13.0, 12.2, 21.95, 0.45, H, matTheaterWall, 1, [
    { spawnerId: 'sp_lob_w1', zoneId: 'lobby', label: 'Foyer West Alcove Window', centerAlong: 19.8, baseY: 0.04, entryNodeId: 'lob_w_alcove' },
  ]);
  addSegmentedWallWithWindows('z', -13.0, -9.8, 8.8, 0.45, H, matTheaterWall, 1, [
    { spawnerId: 'sp_aud_w', zoneId: 'auditorium', label: 'Auditorium West Window', centerAlong: 0.5, baseY: 0.64, entryNodeId: 'aud_aisle_w', hallwayDepth: 2.35 },
  ]);
  addSolidBox(-13.0, H * 0.5, -18.575, 0.45, H, 10.75, matTheaterWall);
  addSolidBox(-13.0, 5.4, 10.5, 0.45, 4.4, 3.4, matTheaterWall);
  addSolidBox(-13.0, 5.4, -11.5, 0.45, 4.4, 3.4, matTheaterWall);

  // East Interior Divider Wall (x = 13.0): Lobby East Window (z=19.8) + Auditorium East Window (z=0.5)
  addSegmentedWallWithWindows('z', 13.0, 12.2, 21.95, 0.45, H, matTheaterWall, -1, [
    { spawnerId: 'sp_lob_e1', zoneId: 'lobby', label: 'Foyer East Alcove Window', centerAlong: 19.8, baseY: 0.04, entryNodeId: 'lob_e_alcove' },
  ]);
  addSegmentedWallWithWindows('z', 13.0, -9.8, 8.8, 0.45, H, matTheaterWall, -1, [
    { spawnerId: 'sp_aud_e', zoneId: 'auditorium', label: 'Auditorium East Window', centerAlong: 0.5, baseY: 0.64, entryNodeId: 'aud_aisle_e', hallwayDepth: 2.35 },
  ]);
  addSolidBox(13.0, H * 0.5, -18.575, 0.45, H, 10.75, matTheaterWall);
  addSolidBox(13.0, 5.4, 10.5, 0.45, 4.4, 3.4, matTheaterWall);
  addSolidBox(13.0, 5.4, -11.5, 0.45, 4.4, 3.4, matTheaterWall);

  // Ceilings + Architectural Coffered Beams
  addSolidBox(0, H + 0.15, -1.0, 26.45, 0.3, 46.9, matCeiling);
  addSolidBox(-17.5875, 4.4, -5.0, 8.725, 0.3, 37.9, matCeiling);
  for (const bz of [18, 12, 2, -6, -14, -20]) {
    const beam = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.0, 0.36, 0.42)), matCastIron);
    beam.position.set(0, H - 0.18, bz);
    sceneGroup.add(beam);
  }

  // === 3. GRAND ART-DECO FOYER: Ticket Kiosk, Brass Chandelier, Twin Stairs & Mezzanine ===
  addSolidBox(0, 0.56, 15.2, 3.8, 1.08, 2.8, matStageWood, 'wood');
  addSolidBox(0, 2.85, 15.2, 4.1, 0.3, 3.1, matBrass, 'metal');
  for (const bx of [-1.7, 1.7]) {
    for (const bz of [14.0, 16.4]) {
      addSolidBox(bx, 1.92, bz, 0.16, 1.56, 0.16, matBrass, 'metal');
    }
  }
  // Grand Brass Art-Deco Chandelier hanging above Lobby Center
  const chandGroup = new THREE.Group();
  chandGroup.position.set(0, 5.75, 15.2);
  const cStem = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 8)), matBrass);
  cStem.position.y = 0.9;
  const cRing1 = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(1.45, 0.07, 8, 24)), matBrass);
  cRing1.rotation.x = Math.PI * 0.5;
  const cRing2 = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.85, 0.06, 8, 20)), matBrass);
  cRing2.rotation.x = Math.PI * 0.5;
  cRing2.position.y = -0.45;
  chandGroup.add(cStem, cRing1, cRing2);
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const globe = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.11, 8, 8)), matSconceAmber);
    globe.position.set(Math.cos(ang) * 1.45, 0.14, Math.sin(ang) * 1.45);
    chandGroup.add(globe);
  }
  sceneGroup.add(chandGroup);

  const marqueeTex = trackTex(
    createStencilSignTexture('THÉÂTRE LUMIÈRE', 'ART-DECO CINEMA · 1945', '#e5c07b', '#132826', maxAniso),
  );
  const marquee = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(5.6, 1.4)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: marqueeTex,
        roughness: 0.52,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  marquee.position.set(0, 5.2, 8.28);
  sceneGroup.add(marquee);

  // Twin Angled Lobby Staircases + South Mezzanine Overlook
  addSolidBox(0, 3.0, 20.1, 25.4, 0.24, 3.8, matStageWood, 'wood');
  addSolidBox(0, 3.55, 18.28, 17.0, 0.96, 0.18, matBrass, 'metal');
  const dummy = new THREE.Object3D();
  for (const side of [-1, 1]) {
    const sx = side * 10.6;
    physics.addRamp({
      minX: sx - 1.6,
      maxX: sx + 1.6,
      minZ: 12.6,
      maxZ: 18.2,
      baseY: 0,
      topY: 3.12,
      riseAxis: '+z',
      surface: 'wood',
    });
    // Discrete carved walnut stairs for crisp visual silhouette
    const stepCount = 14;
    const stepD = 5.6 / stepCount;
    const stepH = 3.12 / stepCount;
    const sGeo = trackGeo(new THREE.BoxGeometry(3.2, stepH, stepD - 0.004));
    const sInst = new THREE.InstancedMesh(sGeo, matStageWood, stepCount);
    sInst.receiveShadow = !isSoftwareGl && qProfile.castShadows;
    for (let i = 0; i < stepCount; i++) {
      const t = (i + 0.5) / stepCount;
      dummy.position.set(sx, (i + 0.5) * stepH, 12.6 + t * 5.6);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      sInst.setMatrixAt(i, dummy.matrix);
    }
    sInst.instanceMatrix.needsUpdate = true;
    sInst.computeBoundingSphere();
    sInst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(sInst);
    raycastMeshes.push(sInst);
  }

  // === 4. MAIN AUDITORIUM: Deep Emerald Velvet Seats + Torn Screen + Proscenium Arch ===
  const seatPositions: Array<[number, number, number]> = [];
  for (let row = 0; row < 6; row++) {
    const z = -6.2 + row * 2.25;
    const slopeT = THREE.MathUtils.clamp((z - -8) / 16, 0, 1);
    const y = slopeT * 1.2;
    for (const side of [-1, 1]) {
      for (let col = 0; col < 5; col++) {
        const x = side * (2.6 + col * 1.35);
        seatPositions.push([x, y, z]);
      }
    }
  }

  const cushionGeo = trackGeo(new THREE.BoxGeometry(0.76, 0.62, 0.56));
  const frameGeo = trackGeo(new THREE.BoxGeometry(0.92, 0.44, 0.46));
  const cushionInst = new THREE.InstancedMesh(cushionGeo, matVelvet, seatPositions.length);
  const frameInst = new THREE.InstancedMesh(frameGeo, matCastIron, seatPositions.length);
  cushionInst.castShadow = !isSoftwareGl && qProfile.castShadows;
  cushionInst.receiveShadow = !isSoftwareGl && qProfile.castShadows;
  seatPositions.forEach(([sx, sy, sz], i) => {
    dummy.position.set(sx, sy + 0.6, sz + 0.14);
    dummy.rotation.set(-0.08, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    cushionInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(sx, sy + 0.25, sz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    frameInst.setMatrixAt(i, dummy.matrix);
  });
  cushionInst.instanceMatrix.needsUpdate = true;
  cushionInst.computeBoundingSphere();
  frameInst.instanceMatrix.needsUpdate = true;
  frameInst.computeBoundingSphere();
  cushionInst.userData.surfaceMaterial = 'wood';
  sceneGroup.add(cushionInst, frameInst);
  raycastMeshes.push(cushionInst);

  for (let row = 0; row < 6; row++) {
    const z = -6.2 + row * 2.25;
    const slopeT = THREE.MathUtils.clamp((z - -8) / 16, 0, 1);
    const y = slopeT * 1.2;
    physics.addBox({ minX: -8.6, maxX: -2.0, minY: y, maxY: y + 0.95, minZ: z - 0.35, maxZ: z + 0.4, surface: 'wood', blocksMovement: true });
    physics.addBox({ minX: 2.0, maxX: 8.6, minY: y, maxY: y + 0.95, minZ: z - 0.35, maxZ: z + 0.4, surface: 'wood', blocksMovement: true });
  }

  // Torn Cinema Screen + Deep Emerald Velvet Proscenium Drapes + Brass Molding
  const screenMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(15.5, 5.4)), matScreen);
  screenMesh.position.set(0, 4.1, -23.84);
  sceneGroup.add(screenMesh);
  addSolidBox(-8.6, 3.65, -23.45, 2.0, 5.6, 0.8, matVelvet, 'wood');
  addSolidBox(8.6, 3.65, -23.45, 2.0, 5.6, 0.8, matVelvet, 'wood');
  addSolidBox(0, 6.9, -23.35, 22.8, 0.9, 0.9, matVelvet, 'wood');
  addSolidBox(0, 6.42, -22.88, 22.8, 0.14, 0.12, matBrass, 'metal');

  // === 5. UPPER PROJECTOR BOOTH (Zone 5: 'projector') ===
  const PROJ_Y = 4.2;
  addSolidBox(0, PROJ_Y - 0.14, 5.515, 10.68, 0.28, 4.47, matStageWood, 'wood');
  addSolidBox(0, PROJ_Y + 0.52, 3.4, 10.12, 1.04, 0.24, matTheaterWall);
  addSolidBox(-5.2, PROJ_Y + 1.5, 5.515, 0.28, 3.0, 4.47, matTheaterWall);
  addSolidBox(5.2, PROJ_Y + 1.5, 5.515, 0.28, 3.0, 4.47, matTheaterWall);

  physics.addRamp({
    minX: -11.4,
    maxX: -5.2,
    minZ: 4.6,
    maxZ: 7.4,
    baseY: 1.15,
    topY: PROJ_Y,
    riseAxis: '+x',
    surface: 'wood',
  });
  const projRampLen = Math.hypot(6.2, PROJ_Y - 1.15);
  const projRamp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(projRampLen, 0.2, 2.8)), matStageWood);
  projRamp.position.set(-8.3, (1.15 + PROJ_Y) * 0.5 - 0.08, 6.0);
  projRamp.rotation.z = Math.atan2(PROJ_Y - 1.15, 6.2);
  projRamp.userData.surfaceMaterial = 'wood';
  sceneGroup.add(projRamp);
  raycastMeshes.push(projRamp);

  // Twin Vintage 35mm Film Projectors inside Booth
  const reelMeshes: THREE.Mesh[] = [];
  for (const px of [-2.2, 2.2]) {
    const pGroup = new THREE.Group();
    pGroup.position.set(px, PROJ_Y, 4.6);
    const ped = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.5, 1.1, 0.65)), matCastIron);
    ped.position.y = 0.55;
    const body = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 0.55, 0.9)), matCastIron);
    body.position.set(0, 1.32, -0.1);
    const reel1 = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16)), matBrass);
    reel1.rotation.z = Math.PI * 0.5;
    reel1.position.set(0.26, 1.78, 0.1);
    const reel2 = reel1.clone();
    reel2.position.set(0.26, 1.05, 0.35);
    reelMeshes.push(reel1, reel2);
    pGroup.add(ped, body, reel1, reel2);
    sceneGroup.add(pGroup);
  }

  // === 6. COPYRIGHT-SAFE BO1 KINO VISUAL EASTER EGGS & MICRO-DETAILS ===
  // Easter Egg #1: Stage Center & Projection Booth Brass/Copper Resonance Teleporter Pads
  const teleRingMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.25,
      roughness: 0.22,
    }),
  );
  const buildTeleporterPad = (tx: number, ty: number, tz: number, radius: number): void => {
    const padGroup = new THREE.Group();
    padGroup.position.set(tx, ty + 0.035, tz);
    const basePlate = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(radius, radius * 1.06, 0.06, 24)), matCastIron);
    const outerCoil = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(radius * 0.88, 0.055, 8, 28)), matCopper);
    outerCoil.rotation.x = Math.PI * 0.5;
    outerCoil.position.y = 0.05;
    const innerRing = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(radius * 0.56, 0.035, 8, 24)), teleRingMat);
    innerRing.rotation.x = Math.PI * 0.5;
    innerRing.position.y = 0.055;
    padGroup.add(basePlate, outerCoil, innerRing);
    sceneGroup.add(padGroup);
  };
  buildTeleporterPad(0, 0.85, -18.8, 1.85); // Iconic center stage pad!
  buildTeleporterPad(0, PROJ_Y, 5.8, 1.15); // Linked booth pad!

  // Easter Egg #2: Chalk Teleporter Equations in Projector Booth + Backstage Parabolic Emitter Schematic
  const eqTex = trackTex(createChalkBlueprintTexture('HARMONIC LINK LOG · 1945', 'equations', maxAniso));
  const eqBoard = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(2.8, 1.4)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: eqTex,
        roughness: 0.85,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  eqBoard.position.set(-4.98, PROJ_Y + 1.65, 5.4);
  eqBoard.rotation.y = Math.PI * 0.5;
  sceneGroup.add(eqBoard);

  const emitTex = trackTex(createChalkBlueprintTexture('BACKSTAGE LAB NOTE', 'emitter', maxAniso));
  const emitBoard = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(2.4, 1.2)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: emitTex,
        roughness: 0.85,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  emitBoard.position.set(-12.68, 2.3, -21.2);
  emitBoard.rotation.y = Math.PI * 0.5;
  sceneGroup.add(emitBoard);

  // Easter Egg #3: Glowing Emerald Meteorite Shard in Velvet Display Plinth (West Dressing Room)
  const plinth = new THREE.Group();
  plinth.position.set(-20.8, 0.04, -3.2);
  const plinthBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.95, 1.05, 0.95)), matStageWood);
  plinthBase.position.y = 0.525;
  const plinthTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.02, 0.08, 1.02)), matBrass);
  plinthTrim.position.y = 1.06;
  const meteorShard = new THREE.Mesh(trackGeo(new THREE.OctahedronGeometry(0.26, 0)), matMeteorShard);
  meteorShard.position.y = 1.38;
  plinth.add(plinthBase, plinthTrim, meteorShard);
  sceneGroup.add(plinth);
  const meteorLight = new THREE.PointLight(0x10b981, 2.8, 5.5, 2);
  meteorLight.position.set(-20.4, 1.5, -3.2);
  sceneGroup.add(meteorLight);

  // Easter Egg #4: Three Hidden 35mm Film Canisters (Mezzanine, Dressing Room, Backstage)
  const filmLocations: Array<[number, number, number]> = [
    [6.8, 3.16, 20.6],
    [-19.8, 0.86, 5.8],
    [10.2, 0.92, -22.2],
  ];
  for (const [fx, fy, fz] of filmLocations) {
    const tin = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.22, 0.22, 0.07, 16)), matFilmCanister);
    tin.position.set(fx, fy, fz);
    const labelRing = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.14, 0.078, 12)), matBrass);
    labelRing.position.set(fx, fy, fz);
    sceneGroup.add(tin, labelRing);
  }

  // Easter Egg #5: Vintage Art-Deco Cinema Posters + Mezzanine Reel-to-Reel Tape Deck
  const poster1Tex = trackTex(createKinoPosterTexture('THÉÂTRE LUMIÈRE', 'GALA · OCT 1945', 'rgba(20,184,166,0.45)', maxAniso));
  const poster2Tex = trackTex(createKinoPosterTexture('DER NACHTZUG', 'ACT III · BERLIN', 'rgba(217,155,38,0.45)', maxAniso));
  const addPoster = (tex: THREE.Texture, x: number, y: number, z: number, ry: number): void => {
    const p = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.15, 1.72)),
      trackMat(
        new THREE.MeshStandardMaterial({
          map: tex,
          roughness: 0.6,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      ),
    );
    p.position.set(x, y, z);
    p.rotation.y = ry;
    sceneGroup.add(p);
  };
  addPoster(poster1Tex, -12.72, 2.25, 15.2, Math.PI * 0.5);
  addPoster(poster2Tex, 12.72, 2.25, 15.2, -Math.PI * 0.5);
  addPoster(poster2Tex, -21.88, 2.15, -8.5, Math.PI * 0.5);
  addPoster(poster1Tex, -4.5, 4.6, 21.88, Math.PI);

  // Dressing Room vanity table + Mezzanine operator desk with vintage reel-to-reel tape deck
  buildOfficeDesk(propCtx, -20.0, 0.04, 5.8, Math.PI * 0.5, matStageWood, matCastIron);
  buildOfficeDesk(propCtx, -4.5, 3.12, 20.6, 0, matStageWood, matCastIron);
  const tapeDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.56, 0.24, 0.34)), matCastIron);
  tapeDeck.position.set(-4.5, 4.08, 20.6);
  sceneGroup.add(tapeDeck);

  // East Moonlit Back Alley detailed props: Rusted vintage 1940s sedan + wooden supply crates
  const alleyCarMats: VehicleMaterials = {
    body: trackMat(new THREE.MeshStandardMaterial({ map: rustTex, roughness: 0.72, metalness: 0.35 })),
    rust: trackMat(new THREE.MeshStandardMaterial({ color: 0x5d3924, roughness: 0.85, metalness: 0.38 })),
    tire: trackMat(new THREE.MeshStandardMaterial({ color: 0x181a1b, roughness: 0.95 })),
    rim: matCastIron,
    darkInterior: trackMat(new THREE.MeshStandardMaterial({ color: 0x101314, roughness: 0.95 })),
    glass: trackMat(new THREE.MeshStandardMaterial({ color: 0x263b42, roughness: 0.2, metalness: 0.6, transparent: true, opacity: 0.45 })),
    chrome: matBrass,
  };
  buildRustedVehicle(propCtx, 'moskvitch', 19.8, 0, 7.2, -0.18, alleyCarMats);
  addSolidBox(20.6, 0.55, -8.5, 1.4, 1.1, 1.4, matBarricadeWood, 'wood');
  addSolidBox(20.4, 0.45, -10.2, 1.1, 0.9, 1.1, matBarricadeWood, 'wood');

  // === 7. BUYABLE DOORS / DEBRIS BARRICADES ===
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

    const mainBarrier = addSolidBox(x, y + h * 0.5, z, w, h, d, matBarricadeWood, 'wood', `col_${id}`, visualGroup);
    mainBarrier.userData.interactableId = id;

    const alongZ = d > w;
    const beamA = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(Math.max(w, d) * 0.98, 0.22, 0.08)),
      matBrass,
    );
    beamA.position.set(
      x + (alongZ ? w * 0.5 + 0.05 : 0),
      y + h * 0.45,
      z + (alongZ ? 0 : d * 0.5 + 0.05),
    );
    beamA.rotation.z = 0.24;
    if (alongZ) beamA.rotation.y = Math.PI * 0.5;
    visualGroup.add(beamA);

    const doorSignTex = trackTex(createStencilSignTexture(label, `${cost} PTS · [F] CLEAR`, '#f5c06b', '#132422', maxAniso));
    const plaque = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.7, 0.65)),
      trackMat(
        new THREE.MeshStandardMaterial({
          map: doorSignTex,
          roughness: 0.6,
          side: THREE.DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      ),
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

  addBuyableDoor('door_west_wing', 'West Dressing Wing', 750, 'west_wing', -13.0, 0, 10.5, 0.52, 3.1, 3.3);
  addBuyableDoor('door_east_wing', 'Moonlit Back Alley', 750, 'east_wing', 13.0, 0, 10.5, 0.52, 3.1, 3.3);
  addBuyableDoor('door_west_auditorium', 'Auditorium West', 1000, 'auditorium', -13.0, 0, -11.5, 0.52, 3.1, 3.3);
  addBuyableDoor('door_east_auditorium', 'Auditorium East', 1000, 'auditorium', 13.0, 0, -11.5, 0.52, 3.1, 3.3);
  addBuyableDoor('door_projector', 'Projector Booth', 1250, 'projector', -10.8, 1.15, 6.0, 0.52, 2.8, 2.7);

  // === 8. INTERACTABLES: Power Switch, Wall-Buys, Mystery Crate & 2 Power-Gated Perk Machines ===
  const powerLampMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 2.2, roughness: 0.25 }),
  );
  const powerLever = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.55, 0.12)), matBrass);
  const powerGroup = new THREE.Group();
  powerGroup.position.set(-12.55, 2.1, -18.5);
  const panelBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.28, 1.15, 0.8)), matCastIron);
  const lampMesh = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.11, 12, 12)), powerLampMat);
  lampMesh.position.set(0.16, 0.36, 0);
  powerLever.position.set(0.2, -0.05, 0);
  powerLever.rotation.z = -0.55;
  powerGroup.add(panelBox, lampMesh, powerLever);
  sceneGroup.add(powerGroup);
  const powerGlow = new THREE.PointLight(0xf59e0b, 3.2, 6.5, 2);
  powerGlow.position.set(-11.9, 2.4, -18.5);
  sceneGroup.add(powerGlow);

  interactables.push({
    id: 'power_switch',
    kind: 'power_switch',
    label: 'Restore Main Theater Power',
    cost: 0,
    position: [-11.8, 1.8, -18.5],
    radiusM: 2.8,
    visualGroup: powerGroup,
    activated: false,
  });

  // Mystery Weapon Crate
  const crateGroup = new THREE.Group();
  crateGroup.position.set(8.4, 0.85, -18.5);
  addSolidBox(8.4, 1.25, -18.5, 2.2, 0.8, 0.92, matBarricadeWood, 'wood');
  const crateTrimMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xf5c869, emissive: 0xd99b26, emissiveIntensity: 1.4, roughness: 0.35 }),
  );
  const crateTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.26, 0.1, 0.96)), crateTrimMat);
  crateTrim.position.set(0, 0.78, 0);
  crateGroup.add(crateTrim);
  sceneGroup.add(crateGroup);
  const crateLight = new THREE.PointLight(0xf5b942, 4.5, 8.5, 1.8);
  crateLight.position.set(8.4, 2.1, -18.5);
  sceneGroup.add(crateLight);

  interactables.push({
    id: 'mystery_crate',
    kind: 'mystery_crate',
    label: 'Mystery Weapon Crate',
    cost: 950,
    position: [8.4, 1.35, -18.5],
    radiusM: 2.8,
    visualGroup: crateGroup,
    activated: false,
  });

  // Chalk Wall-Buys
  const addWallBuy = (
    id: string,
    weaponId: string,
    weaponLabel: string,
    cost: number,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ): void => {
    const tex = trackTex(createWallBuyTexture(weaponLabel, cost, maxAniso));
    const plaque = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(1.65, 0.82)),
      trackMat(
        new THREE.MeshStandardMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          roughness: 0.7,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -4,
        }),
      ),
    );
    plaque.position.set(x, y, z);
    plaque.rotation.y = rotY;
    sceneGroup.add(plaque);

    interactables.push({
      id,
      kind: 'wall_buy',
      label: weaponLabel,
      weaponId,
      cost,
      position: [x, y, z],
      radiusM: 2.6,
      activated: false,
    });
  };

  addWallBuy('wb_mp5', 'hk_mp5', 'HK MP5 9mm', 1000, -6.0, 1.6, 8.28, 0);
  addWallBuy('wb_870', 'remington_870', 'Remington 870', 750, 6.0, 1.6, 8.28, 0);
  addWallBuy('wb_aks74u', 'aks74u', 'AKS-74U 5.45', 1200, -21.9, 1.6, 1.5, Math.PI * 0.5);
  addWallBuy('wb_akm', 'akm_762', 'AKM 7.62x39', 1500, -12.7, 1.6, -5.0, Math.PI * 0.5);
  addWallBuy('wb_m4a1', 'm4a1', 'M4A1 5.56 Carbine', 1750, 12.7, 1.6, -5.0, -Math.PI * 0.5);
  addWallBuy('wb_spas', 'spas_12', 'SPAS-12 Tactical', 1400, 0, PROJ_Y + 1.5, 7.72, Math.PI);

  // Two Power-Gated Perk Machines
  const perkEmissiveMats: Array<{ mat: THREE.MeshStandardMaterial; light: THREE.PointLight; color: number }> = [];
  const addPerkMachine = (
    id: string,
    perkId: 'vitality' | 'rapid_handling',
    label: string,
    cost: number,
    colorHex: number,
    x: number,
    y: number,
    z: number,
    rotY: number,
  ): void => {
    const bodyMat = trackMat(new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.45, metalness: 0.35 }));
    const signMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.08,
        roughness: 0.25,
      }),
    );

    const mGroup = new THREE.Group();
    mGroup.position.set(x, y, z);
    mGroup.rotation.y = rotY;
    const cabinet = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.15, 2.35, 0.82)), bodyMat);
    cabinet.position.y = 1.18;
    const marqueePanel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.96, 0.52, 0.08)), signMat);
    marqueePanel.position.set(0, 2.0, 0.42);
    const dispenser = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.62, 0.42, 0.12)), matCastIron);
    dispenser.position.set(0, 0.72, 0.4);
    mGroup.add(cabinet, marqueePanel, dispenser);
    sceneGroup.add(mGroup);

    physics.addBox({
      minX: x - 0.65,
      maxX: x + 0.65,
      minY: y,
      maxY: y + 2.4,
      minZ: z - 0.65,
      maxZ: z + 0.65,
      surface: 'metal',
      blocksMovement: true,
    });

    const pLight = new THREE.PointLight(colorHex, 0.0, 8.0, 2);
    pLight.position.set(x + Math.sin(rotY) * 0.9, y + 2.0, z + Math.cos(rotY) * 0.9);
    sceneGroup.add(pLight);
    perkEmissiveMats.push({ mat: signMat, light: pLight, color: colorHex });

    interactables.push({
      id,
      kind: 'perk_machine',
      perkId,
      label,
      cost,
      requiresPower: true,
      position: [x, y + 1.2, z],
      radiusM: 2.7,
      visualGroup: mGroup,
      activated: false,
    });
  };

  addPerkMachine('perk_vitality', 'vitality', 'Vitality Reserve (+60 Max HP)', 2500, 0xb91c1c, -11.9, 0.1, -1.8, Math.PI * 0.5);
  addPerkMachine('perk_rapid', 'rapid_handling', 'Rapid Handling (Fast Reload)', 3000, 0x15803d, 21.1, 0.0, -3.5, -Math.PI * 0.5);

  // === 9. POWER-LINKED ART-DECO NOIR LIGHTING RIG (Warm Brass + Cool Moonlight + Emerald Accents) ===
  const lobbyBaseLight = new THREE.PointLight(0xe5b772, 9.0, 24, 1.65);
  lobbyBaseLight.position.set(0, 5.2, 15.2);
  sceneGroup.add(lobbyBaseLight);

  const westLamp = new THREE.PointLight(0x47b8a8, 5.2, 16, 1.75);
  westLamp.position.set(-17.5, 3.6, 2.0);
  sceneGroup.add(westLamp);

  const alleyStreetLight = new THREE.PointLight(0x88b4e6, 9.5, 25, 1.55);
  alleyStreetLight.position.set(17.5, 5.8, -2.0);
  sceneGroup.add(alleyStreetLight);

  for (const [ex, ey, ez] of [
    [-12.6, 3.4, 10.5],
    [12.6, 3.4, 10.5],
    [-12.6, 3.4, -11.5],
    [12.6, 3.4, -11.5],
  ]) {
    const sign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.22, 0.62)), matExitGlow);
    sign.position.set(ex, ey, ez);
    sceneGroup.add(sign);
  }

  const powerLights: Array<{ light: THREE.Light; targetIntensity: number }> = [];
  for (const [cx, cy, cz, inten] of [
    [0, 6.4, 2.5, 16.0],
    [0, 6.4, -5.5, 18.0],
    [0, 6.2, -17.5, 22.0],
    [-7.5, 5.8, -17.0, 11.5],
    [7.5, 5.8, -17.0, 11.5],
    [-17.5, 3.8, -6.0, 8.5],
  ]) {
    const pl = new THREE.PointLight(0xffd28c, 0, 28, 1.5);
    pl.position.set(cx, cy, cz);
    sceneGroup.add(pl);
    powerLights.push({ light: pl, targetIntensity: inten });
  }

  // Volumetric-style vintage projector cone from Booth to Torn Screen
  const beamGeo = trackGeo(new THREE.ConeGeometry(5.6, 28.0, 20, 1, true));
  beamGeo.translate(0, -14.0, 0);
  beamGeo.rotateX(Math.PI * 0.5);
  const beamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffe4a8,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  const projectorBeam = new THREE.Mesh(beamGeo, beamMat);
  projectorBeam.position.set(0, PROJ_Y + 1.3, 3.6);
  projectorBeam.lookAt(0, 4.1, -23.8);
  projectorBeam.visible = false;
  sceneGroup.add(projectorBeam);

  let powerOn = false;
  let powerBlend = 0;

  const setPowerState = (powered: boolean): void => {
    powerOn = powered;
    powerLever.rotation.z = powered ? 0.55 : -0.55;
    powerLampMat.color.setHex(powered ? 0x10b981 : 0xf59e0b);
    powerLampMat.emissive.setHex(powered ? 0x10b981 : 0xf59e0b);
    powerGlow.color.setHex(powered ? 0x10b981 : 0xf59e0b);
    teleRingMat.emissiveIntensity = powered ? 2.4 : 0.25;
    projectorBeam.visible = powered;
    for (const pm of perkEmissiveMats) {
      pm.mat.emissiveIntensity = powered ? 2.2 : 0.08;
      pm.light.intensity = powered ? 5.2 : 0.0;
    }
  };

  // === 10. ZONE-GATED NAVGRAPH (With Staircases, Kiosk Bypass, Stage Ramps & Projector Ramp) ===
  const rawNodes: NavNode[] = [
    // Grand Foyer Ground Level (routed cleanly around Ticket Kiosk at x in [-1.9,1.9], z in [13.8,16.6])
    { id: 'lob_c', position: [0, 0.04, 11.2], zoneId: 'lobby', neighbors: ['lob_w', 'lob_e', 'lob_w_mid', 'lob_e_mid'] },
    { id: 'lob_w', position: [-9.2, 0.04, 10.8], zoneId: 'lobby', neighbors: ['lob_c', 'lob_w_mid', 'lob_stair_w_bot', 'ww_s'] },
    { id: 'lob_e', position: [9.2, 0.04, 10.8], zoneId: 'lobby', neighbors: ['lob_c', 'lob_e_mid', 'lob_stair_e_bot', 'ew_s'] },
    { id: 'lob_w_mid', position: [-5.5, 0.04, 14.8], zoneId: 'lobby', neighbors: ['lob_c', 'lob_w', 'lob_sw'], isCover: true, coverNormal: [1, 0] },
    { id: 'lob_e_mid', position: [5.5, 0.04, 14.8], zoneId: 'lobby', neighbors: ['lob_c', 'lob_e', 'lob_se'], isCover: true, coverNormal: [-1, 0] },
    { id: 'lob_sw', position: [-5.5, 0.04, 19.2], zoneId: 'lobby', neighbors: ['lob_w_mid', 'lob_s_mid', 'lob_w_alcove'] },
    { id: 'lob_s_mid', position: [0, 0.04, 19.2], zoneId: 'lobby', neighbors: ['lob_sw', 'lob_se'] },
    { id: 'lob_se', position: [5.5, 0.04, 19.2], zoneId: 'lobby', neighbors: ['lob_e_mid', 'lob_s_mid', 'lob_e_alcove'] },
    { id: 'lob_w_alcove', position: [-10.5, 0.04, 19.8], zoneId: 'lobby', neighbors: ['lob_sw'] },
    { id: 'lob_e_alcove', position: [10.5, 0.04, 19.8], zoneId: 'lobby', neighbors: ['lob_se'] },

    // Twin Lobby Staircases -> Mezzanine Overlook
    { id: 'lob_stair_w_bot', position: [-10.6, 0.04, 12.2], zoneId: 'lobby', neighbors: ['lob_w', 'lob_stair_w_mid'] },
    { id: 'lob_stair_w_mid', position: [-10.6, 1.58, 15.4], zoneId: 'lobby', neighbors: ['lob_stair_w_bot', 'lob_mez_w'] },
    { id: 'lob_mez_w', position: [-9.8, 3.12, 19.6], zoneId: 'lobby', neighbors: ['lob_stair_w_mid', 'lob_mez'] },
    { id: 'lob_mez', position: [0, 3.12, 19.8], zoneId: 'lobby', neighbors: ['lob_mez_w', 'lob_mez_e'], isCover: true, coverNormal: [0, -1] },
    { id: 'lob_mez_e', position: [9.8, 3.12, 19.6], zoneId: 'lobby', neighbors: ['lob_mez', 'lob_stair_e_mid'] },
    { id: 'lob_stair_e_mid', position: [10.6, 1.58, 15.4], zoneId: 'lobby', neighbors: ['lob_mez_e', 'lob_stair_e_bot'] },
    { id: 'lob_stair_e_bot', position: [10.6, 0.04, 12.2], zoneId: 'lobby', neighbors: ['lob_e', 'lob_stair_e_mid'] },

    // West Dressing Wing
    { id: 'ww_s', position: [-16.6, 0.04, 10.5], zoneId: 'west_wing', requiredDoorId: 'door_west_wing', neighbors: ['lob_w', 'ww_mid'] },
    { id: 'ww_mid', position: [-18.2, 0.04, 2.5], zoneId: 'west_wing', neighbors: ['ww_s', 'ww_n'] },
    { id: 'ww_n', position: [-18.0, 0.04, -7.0], zoneId: 'west_wing', neighbors: ['ww_mid', 'ww_door_aud'] },
    { id: 'ww_door_aud', position: [-16.8, 0.04, -11.5], zoneId: 'west_wing', neighbors: ['ww_n', 'aud_pit_w'] },

    // East Moonlit Back Alley
    { id: 'ew_s', position: [16.6, 0.0, 10.5], zoneId: 'east_wing', requiredDoorId: 'door_east_wing', neighbors: ['lob_e', 'ew_mid'] },
    { id: 'ew_mid', position: [18.2, 0.0, 2.5], zoneId: 'east_wing', neighbors: ['ew_s', 'ew_n'] },
    { id: 'ew_n', position: [18.0, 0.0, -7.0], zoneId: 'east_wing', neighbors: ['ew_mid', 'ew_door_aud'] },
    { id: 'ew_door_aud', position: [16.8, 0.0, -11.5], zoneId: 'east_wing', neighbors: ['ew_n', 'aud_pit_e'] },

    // Main Auditorium & Stage
    { id: 'aud_pit_w', position: [-10.4, 0.04, -11.5], zoneId: 'auditorium', neighbors: ['ww_door_aud', 'aud_aisle_w', 'aud_pit_c', 'stage_ramp_l'] },
    { id: 'aud_pit_c', position: [0, 0.04, -11.5], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'aud_pit_e', 'aud_center_mid'] },
    { id: 'aud_pit_e', position: [10.4, 0.04, -11.5], zoneId: 'auditorium', neighbors: ['ew_door_aud', 'aud_aisle_e', 'aud_pit_c', 'stage_ramp_r'] },
    { id: 'aud_aisle_w', position: [-10.6, 0.64, 0.5], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'aud_back_w'] },
    { id: 'aud_center_mid', position: [0, 0.64, 0.5], zoneId: 'auditorium', neighbors: ['aud_pit_c', 'aud_back_c'] },
    { id: 'aud_aisle_e', position: [10.6, 0.64, 0.5], zoneId: 'auditorium', neighbors: ['aud_pit_e', 'aud_back_e'] },
    { id: 'aud_back_w', position: [-10.8, 1.15, 6.0], zoneId: 'auditorium', neighbors: ['aud_aisle_w', 'aud_back_c', 'proj_ramp'] },
    { id: 'aud_back_c', position: [0, 1.15, 6.2], zoneId: 'auditorium', neighbors: ['aud_back_w', 'aud_back_e', 'aud_center_mid'] },
    { id: 'aud_back_e', position: [10.6, 1.15, 6.2], zoneId: 'auditorium', neighbors: ['aud_aisle_e', 'aud_back_c'] },

    { id: 'stage_ramp_l', position: [-9.2, 0.45, -13.8], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'stage_l'] },
    { id: 'stage_ramp_r', position: [9.2, 0.45, -13.8], zoneId: 'auditorium', neighbors: ['aud_pit_e', 'stage_r'] },
    { id: 'stage_l', position: [-9.2, 0.85, -18.8], zoneId: 'auditorium', neighbors: ['stage_ramp_l', 'stage_c'] },
    { id: 'stage_c', position: [0, 0.85, -18.5], zoneId: 'auditorium', neighbors: ['stage_l', 'stage_r'] },
    { id: 'stage_r', position: [9.2, 0.85, -18.8], zoneId: 'auditorium', neighbors: ['stage_ramp_r', 'stage_c'] },

    // Projector Booth Ramp & Platform
    { id: 'proj_ramp', position: [-8.2, 2.65, 6.0], zoneId: 'projector', requiredDoorId: 'door_projector', neighbors: ['aud_back_w', 'proj_booth'] },
    { id: 'proj_booth', position: [0, PROJ_Y, 5.8], zoneId: 'projector', requiredDoorId: 'door_projector', neighbors: ['proj_ramp'] },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'der_lichtspielhaus',
    name: 'Der Lichtspielhaus',
    sceneGroup,
    physics,
    raycastMeshes,
    navGraph: buildNavGraph(rawNodes),
    spawnPoints: {
      teamA: [
        { position: [0, 0.04, 11.4], yaw: 0 },
        { position: [-3.2, 0.04, 11.4], yaw: 0 },
        { position: [3.2, 0.04, 11.4], yaw: 0 },
        { position: [-6.0, 0.04, 11.2], yaw: 0 },
      ],
      teamB: [{ position: [0, 0.85, -18.0], yaw: Math.PI }],
      ffa: [{ position: [0, 0.04, 11.4], yaw: 0 }],
      playerStart: { position: [0, 0.04, 11.4], yaw: 0, zoneId: 'lobby' },
      zombieSpawners,
    },
    windowBarriers,
    interactables,
    lightingPreset: LIGHTING_PRESET,
    setPowerState,
    update: (dt, elapsedSec) => {
      const target = powerOn ? 1 : 0;
      powerBlend = THREE.MathUtils.damp(powerBlend, target, 3.2, dt);
      for (const pl of powerLights) {
        pl.light.intensity = pl.targetIntensity * powerBlend;
      }
      if (powerOn) {
        beamMat.opacity = 0.085 + Math.sin(elapsedSec * 14.0) * 0.012;
        for (const r of reelMeshes) {
          r.rotation.x += dt * 1.4;
        }
      } else {
        beamMat.opacity = 0;
      }
      crateLight.intensity = 3.8 + Math.sin(elapsedSec * 3.4) * 0.85;
      westLamp.intensity = 4.6 + Math.sin(elapsedSec * 9.2) * 0.45;
      meteorShard.rotation.y = elapsedSec * 0.65;
      meteorLight.intensity = 2.4 + Math.sin(elapsedSec * 2.6) * 0.6;

      // Animate plank tear-off & repair snapping
      for (let i = 0; i < plankAnimItems.length; i++) {
        const it = plankAnimItems[i];
        if (it.state === 'tearing') {
          it.animT = Math.min(1, it.animT + dt / 0.36);
          const ease = it.animT * it.animT;
          it.group.position.copy(it.restPos);
          it.group.position.addScaledVector(it.outwardDir, ease * 0.85);
          it.group.position.y -= ease * 0.92;
          it.group.rotation.set(
            it.restRot.x + ease * 0.72,
            it.restRot.y + ease * 0.34,
            it.restRot.z + ease * 0.48,
          );
          if (it.animT >= 1) {
            it.state = 'removed';
            it.group.visible = false;
          }
        } else if (it.state === 'repairing') {
          it.animT = Math.min(1, it.animT + dt / 0.24);
          const inv = 1 - it.animT;
          const easeInv = inv * inv;
          it.group.position.copy(it.restPos);
          // Slide briskly from inside the room onto the window jambs
          it.group.position.addScaledVector(it.outwardDir, -easeInv * 0.48);
          it.group.position.y -= easeInv * 0.22;
          it.group.rotation.set(
            it.restRot.x - easeInv * 0.25,
            it.restRot.y,
            it.restRot.z + easeInv * 0.16,
          );
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

export const KINO_THEATER_MAP: IMapDefinition = {
  id: 'der_lichtspielhaus',
  name: 'Der Lichtspielhaus',
  subtitle: 'Art-Deco Noir 1940s Cinema',
  description:
    'Emerald-velvet and tarnished-brass 1940s grand cinema preserving the iconic foyer-to-stage loop, moonlit alley, power restoration, and hidden lore artifacts.',
  mode: 'infection',
  status: 'playable',
  environmentTags: ['Art-Deco Noir', '5 Unlockable Zones', 'Lore Easter Eggs'],
  accentHex: '#10b981',
  previewStyle: 'kino_theater',
  build: buildKinoTheater,
};

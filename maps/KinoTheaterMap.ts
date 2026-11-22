import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  createCabinWoodTexture,
  createCinemaScreenTexture,
  createSovietConcreteTexture,
  createTheaterTileTexture,
  createTheaterWallTexture,
  createWallBuyTexture,
} from './MapTextures';
import {
  buildNavGraph,
  BuiltMapInstance,
  IMapDefinition,
  MapInteractable,
  MapLightingPreset,
  NavNode,
  ZombieSpawnerDef,
} from './types';

const LIGHTING_PRESET: MapLightingPreset = {
  backgroundHex: 0x0b0d14,
  fogHex: 0x100d11,
  fogDensity: 0.026,
  envIntensity: 0.22,
  hemiSkyHex: 0x45526d,
  hemiGroundHex: 0x1a1214,
  hemiIntensity: 0.34,
  keyLightHex: 0x8ea8d6,
  keyLightIntensity: 0.62,
  keyLightPos: [18, 30, 14],
};

function buildKinoTheater(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): BuiltMapInstance {
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
  scene.fog = new THREE.FogExp2(LIGHTING_PRESET.fogHex, LIGHTING_PRESET.fogDensity);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = LIGHTING_PRESET.envIntensity;
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(
    LIGHTING_PRESET.hemiSkyHex,
    LIGHTING_PRESET.hemiGroundHex,
    LIGHTING_PRESET.hemiIntensity,
  );
  sceneGroup.add(hemi);

  // Cool eerie moonlight directional light (shines down into moonlit East Back Alley & Lobby skylights)
  const moonLight = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  moonLight.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl) {
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.set(1024, 1024);
    moonLight.shadow.camera.near = 2;
    moonLight.shadow.camera.far = 80;
    moonLight.shadow.camera.left = -28;
    moonLight.shadow.camera.right = 28;
    moonLight.shadow.camera.top = 28;
    moonLight.shadow.camera.bottom = -28;
    moonLight.shadow.bias = -0.0005;
    moonLight.shadow.normalBias = 0.02;
  }
  sceneGroup.add(moonLight);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tileTex = trackTex(createTheaterTileTexture(maxAniso, 6, 4));
  const wallTex = trackTex(createTheaterWallTexture(maxAniso, 3, 1));
  const stageWoodTex = trackTex(createCabinWoodTexture(maxAniso, 4, 2, '#513726', 1948));
  const crateWoodTex = trackTex(createCabinWoodTexture(maxAniso, 1, 1, '#5d432c', 1952));
  const alleyConcTex = trackTex(createSovietConcreteTexture(maxAniso, 4, 4, '#363b40', 1962));
  const screenTex = trackTex(createCinemaScreenTexture(maxAniso));

  const matTile = trackMat(
    new THREE.MeshStandardMaterial({
      map: tileTex,
      roughness: 0.42,
      metalness: 0.08,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );
  const matTheaterWall = trackMat(
    new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.84, metalness: 0.05 }),
  );
  const matCarpet = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x45151a,
      roughness: 0.96,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );
  const matVelvet = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7a171e, roughness: 0.9, metalness: 0.04 }),
  );
  const matCastIron = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x202124, roughness: 0.55, metalness: 0.72 }),
  );
  const matBrass = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xb89448, roughness: 0.35, metalness: 0.82 }),
  );
  const matStageWood = trackMat(
    new THREE.MeshStandardMaterial({ map: stageWoodTex, roughness: 0.78, metalness: 0.04 }),
  );
  const matBarricadeWood = trackMat(
    new THREE.MeshStandardMaterial({ map: crateWoodTex, roughness: 0.9, metalness: 0.02 }),
  );
  const matAlley = trackMat(
    new THREE.MeshStandardMaterial({ map: alleyConcTex, roughness: 0.76, metalness: 0.08 }),
  );
  const matCeiling = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x1b1618, roughness: 0.95, metalness: 0.03 }),
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
  const matExitGlow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      emissive: 0xdc2626,
      emissiveIntensity: 1.5,
      roughness: 0.3,
    }),
  );

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
    mesh.castShadow = !isSoftwareGl && h > 0.4;
    mesh.receiveShadow = !isSoftwareGl;
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

  // === 1. FLOORING & ZONES ===
  // Base dark ground plane
  const baseFloor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(54, 54)), matAlley);
  baseFloor.rotation.x = -Math.PI * 0.5;
  baseFloor.receiveShadow = !isSoftwareGl;
  baseFloor.userData.surfaceMaterial = 'asphalt';
  sceneGroup.add(baseFloor);
  raycastMeshes.push(baseFloor);

  // Grand Lobby Checkered Tile (Z in [8.25, 21.95], X in [-12.75, 12.75])
  const lobbyFloor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(25.5, 13.7)), matTile);
  lobbyFloor.rotation.x = -Math.PI * 0.5;
  lobbyFloor.position.set(0, 0.02, 15.1);
  lobbyFloor.receiveShadow = !isSoftwareGl;
  lobbyFloor.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(lobbyFloor);
  raycastMeshes.push(lobbyFloor);
  physics.addSurfaceZone({ minX: -13, maxX: 13, minZ: 8, maxZ: 22, surface: 'concrete' });

  // Main Auditorium Sloped Carpet Floor (Z in [-8, 7.75], seated cleanly above baseFloor without clipping pitFloor)
  const audFloorSlopeLen = Math.hypot(15.75, 1.2);
  const audFloor = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(25.5, 0.14, audFloorSlopeLen)), matCarpet);
  audFloor.position.set(0, 0.56, -0.125);
  audFloor.rotation.x = Math.atan2(1.2, 15.75);
  audFloor.receiveShadow = !isSoftwareGl;
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

  // Flat orchestra pit floor between sloped seats & stage (Z in [-15.0, -8.05], zero overlap with audFloor)
  const pitFloor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(25.5, 6.95)), matCarpet);
  pitFloor.rotation.x = -Math.PI * 0.5;
  pitFloor.position.set(0, 0.02, -11.525);
  pitFloor.receiveShadow = !isSoftwareGl;
  pitFloor.userData.surfaceMaterial = 'wood';
  sceneGroup.add(pitFloor);
  raycastMeshes.push(pitFloor);

  // Elevated Wooden Stage (Z in [-24, -15], X in [-12.5, 12.5], Y = 0.85m)
  addSolidBox(0, 0.425, -19.5, 25.0, 0.85, 9.0, matStageWood, 'wood');
  // Twin side stage access ramps (smooth kiting up/down the stage!)
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
    stRamp.receiveShadow = !isSoftwareGl;
    stRamp.userData.surfaceMaterial = 'wood';
    sceneGroup.add(stRamp);
    raycastMeshes.push(stRamp);
  }

  // Interior Acoustic Zones (Lobby, Auditorium, West Wing are indoor; East Alley is outdoor!)
  physics.addInteriorZone({ minX: -22, maxX: 13, minY: 0, maxY: 9, minZ: -24, maxZ: 22, material: 'wood' });

  // === 2. MAIN ARCHITECTURAL WALLS & CEILINGS (non-overlapping corner joints) ===
  const H = 7.6;
  // South Grand Entrance Wall (behind player spawn, Z = 22.2, X in [-13.225, 13.225])
  addSolidBox(0, H * 0.5, 22.2, 26.45, H, 0.5, matTheaterWall);
  // North Stage Back Wall (Z = -24.2, X in [-22.45, 22.45])
  addSolidBox(0, H * 0.5, -24.2, 44.9, H, 0.5, matTheaterWall);
  // West Outer Wall (X = -22.2, Z in [-23.95, 14.45], butts cleanly against North wall)
  addSolidBox(-22.2, H * 0.5, -4.75, 0.5, H, 38.4, matTheaterWall);
  addSolidBox(-17.5875, H * 0.5, 14.2, 8.725, H, 0.5, matTheaterWall); // X in [-21.95, -13.225]
  // East Outer Alley Fence/Brick Wall (X = 22.2, Z in [-23.95, 14.45])
  addSolidBox(22.2, 3.8, -4.75, 0.5, 7.6, 38.4, matAlley);
  addSolidBox(17.5875, 3.8, 14.2, 8.725, 7.6, 0.5, matAlley); // X in [13.225, 21.95]

  // Wall dividing Lobby (Z > 8) from Auditorium (Z < 8), fitting strictly inside X in [-12.775, 12.775]
  addSolidBox(0, H * 0.5, 8.0, 25.55, H, 0.5, matTheaterWall);

  // West Interior Wall separating Lobby/Auditorium (X = -13, Z strictly in [-23.95, 21.95])
  addSolidBox(-13.0, H * 0.5, 17.075, 0.45, H, 9.75, matTheaterWall); // Z 12.2..21.95
  addSolidBox(-13.0, H * 0.5, -0.5, 0.45, H, 18.6, matTheaterWall); // Z -9.8..8.8
  addSolidBox(-13.0, H * 0.5, -18.575, 0.45, H, 10.75, matTheaterWall); // Z -23.95..-13.2
  // Door headers
  addSolidBox(-13.0, 5.4, 10.5, 0.45, 4.4, 3.4, matTheaterWall);
  addSolidBox(-13.0, 5.4, -11.5, 0.45, 4.4, 3.4, matTheaterWall);

  // East Interior Wall separating Lobby/Auditorium from Moonlit Alley (X = 13, Z strictly in [-23.95, 21.95])
  addSolidBox(13.0, H * 0.5, 17.075, 0.45, H, 9.75, matTheaterWall);
  addSolidBox(13.0, H * 0.5, -0.5, 0.45, H, 18.6, matTheaterWall);
  addSolidBox(13.0, H * 0.5, -18.575, 0.45, H, 10.75, matTheaterWall);
  addSolidBox(13.0, 5.4, 10.5, 0.45, 4.4, 3.4, matTheaterWall);
  addSolidBox(13.0, 5.4, -11.5, 0.45, 4.4, 3.4, matTheaterWall);

  // Ceilings (seated strictly atop/inside walls with zero coplanar penetration)
  addSolidBox(0, H + 0.15, -1.0, 26.45, 0.3, 46.9, matCeiling);
  addSolidBox(-17.5875, 4.4, -5.0, 8.725, 0.3, 37.9, matCeiling);

  // === 3. GRAND SPAWN LOBBY: Ticket Booth, Twin Staircases & Mezzanine Overlook ===
  // Ornate Central Ticket Booth (kiteable centerpiece!)
  addSolidBox(0, 0.55, 15.2, 3.8, 1.1, 2.8, matStageWood, 'wood');
  addSolidBox(0, 2.85, 15.2, 4.1, 0.3, 3.1, matBrass, 'metal');
  for (const bx of [-1.7, 1.7]) {
    for (const bz of [14.0, 16.4]) {
      addSolidBox(bx, 1.9, bz, 0.16, 1.6, 0.16, matBrass, 'metal');
    }
  }
  const marqueeTex = trackTex(
    createStencilSignTexture('DER LICHTSPIELHAUS', 'KINO · EST. 1941', '#e5c07b', '#2b1316', maxAniso),
  );
  const marquee = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(5.6, 1.4)),
    trackMat(
      new THREE.MeshStandardMaterial({
        map: marqueeTex,
        roughness: 0.55,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  marquee.position.set(0, 5.2, 8.28);
  sceneGroup.add(marquee);

  // Twin Angled Lobby Staircases rising up to a South Mezzanine Overlook (Y = 3.1m)
  addSolidBox(0, 3.0, 20.1, 25.4, 0.24, 3.8, matStageWood, 'wood');
  addSolidBox(0, 3.55, 18.28, 17.0, 0.96, 0.18, matBrass, 'metal'); // Overlook railing
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
    const stMesh = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(3.2, 0.22, Math.hypot(5.6, 3.12))),
      matStageWood,
    );
    stMesh.position.set(sx, 1.48, 15.4);
    stMesh.rotation.x = -Math.atan2(3.12, 5.6);
    stMesh.userData.surfaceMaterial = 'wood';
    sceneGroup.add(stMesh);
    raycastMeshes.push(stMesh);
  }

  // === 4. MAIN AUDITORIUM: InstancedMesh Red Velvet Seats + Stage + Torn Cinema Screen ===
  // 6 rows x 10 seats split cleanly by a 3.2m center aisle and 3.4m outer kiting aisles!
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
  cushionInst.castShadow = !isSoftwareGl;
  cushionInst.receiveShadow = !isSoftwareGl;
  const dummy = new THREE.Object3D();
  seatPositions.forEach(([sx, sy, sz], i) => {
    dummy.position.set(sx, sy + 0.58, sz + 0.14);
    dummy.rotation.set(-0.08, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    cushionInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(sx, sy + 0.24, sz);
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

  // Low row collision strips so players/zombies navigate the wide center & outer aisles cleanly
  for (let row = 0; row < 6; row++) {
    const z = -6.2 + row * 2.25;
    const slopeT = THREE.MathUtils.clamp((z - -8) / 16, 0, 1);
    const y = slopeT * 1.2;
    physics.addBox({ minX: -8.6, maxX: -2.0, minY: y, maxY: y + 0.95, minZ: z - 0.35, maxZ: z + 0.4, surface: 'wood', blocksMovement: true });
    physics.addBox({ minX: 2.0, maxX: 8.6, minY: y, maxY: y + 0.95, minZ: z - 0.35, maxZ: z + 0.4, surface: 'wood', blocksMovement: true });
  }

  // Massive Torn Vintage Cinema Screen & Heavy Velvet Proscenium Curtains (non-overlapping valance)
  const screenMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(15.5, 5.4)), matScreen);
  screenMesh.position.set(0, 4.1, -23.85);
  sceneGroup.add(screenMesh);
  addSolidBox(-9.5, 3.65, -23.5, 3.8, 5.6, 0.8, matVelvet, 'wood');
  addSolidBox(9.5, 3.65, -23.5, 3.8, 5.6, 0.8, matVelvet, 'wood');
  addSolidBox(0, 6.9, -23.4, 22.8, 0.9, 0.9, matVelvet, 'wood');

  // === 5. UPPER PROJECTOR BOOTH (Zone 5: 'projector', Y = 4.2m overlooking auditorium!) ===
  const PROJ_Y = 4.2;
  // Booth floor & non-overlapping parapet + side walls (clear of Z = 7.75 divider face)
  addSolidBox(0, PROJ_Y - 0.14, 5.515, 10.68, 0.28, 4.47, matStageWood, 'wood');
  addSolidBox(0, PROJ_Y + 0.52, 3.4, 10.12, 1.04, 0.24, matTheaterWall); // viewing slit parapet between side walls
  addSolidBox(-5.2, PROJ_Y + 1.5, 5.515, 0.28, 3.0, 4.47, matTheaterWall);
  addSolidBox(5.2, PROJ_Y + 1.5, 5.515, 0.28, 3.0, 4.47, matTheaterWall);

  // Stair ramp from Auditorium Rear-West up into Projector Booth (X in [-11.5, -5.2], Z in [4.5, 7.2])
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
  for (const px of [-2.0, 2.0]) {
    const pGroup = new THREE.Group();
    pGroup.position.set(px, PROJ_Y, 4.6);
    const ped = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.5, 1.1, 0.65)), matCastIron);
    ped.position.y = 0.55;
    const body = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 0.55, 0.9)), matCastIron);
    body.position.set(0, 1.32, -0.1);
    const reel1 = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.32, 0.32, 0.08, 16)), matBrass);
    reel1.rotation.z = Math.PI * 0.5;
    reel1.position.set(0.24, 1.78, 0.1);
    const reel2 = reel1.clone();
    reel2.position.set(0.24, 1.05, 0.35);
    pGroup.add(ped, body, reel1, reel2);
    sceneGroup.add(pGroup);
  }

  // === 6. BUYABLE DOORS / DEBRIS BARRICADES ===
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

    // Crossed wooden barricade timbers + painted cost plaque
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

    const doorSignTex = trackTex(createStencilSignTexture(label, `${cost} PTS · [F] CLEAR`, '#ef4444', '#1d0d10', maxAniso));
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

  // === 7. INTERACTABLES: Power Switch, Wall-Buys, Mystery Crate & 2 Power-Gated Perk Machines ===
  // A) Backstage Power Switch (Stage Left: X = -11.2, Y = 0.85, Z = -18.5)
  const powerLampMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 2.2, roughness: 0.25 }),
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
  const powerGlow = new THREE.PointLight(0xef4444, 3.2, 6.5, 2);
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

  // B) Mystery Weapon Crate (Stage Right: X = 8.4, Y = 0.85, Z = -18.5)
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

  // C) Chalk Wall-Buys across Lobby, Wings, Auditorium & Projector Booth
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

  // D) Two Power-Gated Perk Machines (Vitality Reserve + Rapid Handling)
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
        emissiveIntensity: 0.08, // dim until Power is restored!
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

  // === 8. POWER-LINKED THEATER LIGHTING RIG (Emergency Dim -> Illuminated Stage & Auditorium) ===
  // Subtle always-on emergency exit lights & Lobby dim lamp
  const lobbyBaseLight = new THREE.PointLight(0xd99b52, 7.5, 22, 1.7);
  lobbyBaseLight.position.set(0, 5.2, 15.2);
  sceneGroup.add(lobbyBaseLight);

  const westEmergency = new THREE.PointLight(0xc24136, 4.2, 15, 1.8);
  westEmergency.position.set(-17.5, 3.6, 2.0);
  sceneGroup.add(westEmergency);

  const alleyStreetLight = new THREE.PointLight(0x7ca6d8, 8.5, 24, 1.6);
  alleyStreetLight.position.set(17.5, 5.8, -2.0);
  sceneGroup.add(alleyStreetLight);

  // Glowing red EXIT boxes above doorways
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

  // Power-gated auditorium chandeliers, warm golden stage spotlights & volumetric projector beam
  const powerLights: Array<{ light: THREE.Light; targetIntensity: number }> = [];
  for (const [cx, cy, cz, inten] of [
    [0, 6.4, 2.5, 16.0],
    [0, 6.4, -5.5, 18.0],
    [0, 6.2, -17.5, 22.0],
    [-7.5, 5.8, -17.0, 11.0],
    [7.5, 5.8, -17.0, 11.0],
    [-17.5, 3.8, -6.0, 8.5],
  ]) {
    const pl = new THREE.PointLight(0xffcb82, 0, 26, 1.55);
    pl.position.set(cx, cy, cz);
    sceneGroup.add(pl);
    powerLights.push({ light: pl, targetIntensity: inten });
  }

  // Volumetric-style vintage projector cone from Booth to Torn Screen (visible when powered)
  const beamGeo = trackGeo(new THREE.ConeGeometry(5.6, 28.0, 20, 1, true));
  beamGeo.translate(0, -14.0, 0);
  beamGeo.rotateX(Math.PI * 0.5);
  const beamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xffdf9e,
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
    powerLampMat.color.setHex(powered ? 0x22c55e : 0xef4444);
    powerLampMat.emissive.setHex(powered ? 0x22c55e : 0xef4444);
    powerGlow.color.setHex(powered ? 0x22c55e : 0xef4444);
    projectorBeam.visible = powered;
    for (const pm of perkEmissiveMats) {
      pm.mat.emissiveIntensity = powered ? 2.2 : 0.08;
      pm.light.intensity = powered ? 5.2 : 0.0;
    }
  };

  // === 9. BARRICADED ZOMBIE ENTRY WINDOWS & SPAWNERS ===
  const zombieSpawners: ZombieSpawnerDef[] = [
    // Lobby initial windows (4)
    { id: 'sp_lob_w1', zoneId: 'lobby', spawnPos: [-12.2, 0, 18.2], entryPos: [-9.8, 0, 18.2], entryNodeId: 'lob_w', yaw: Math.PI * 0.5 },
    { id: 'sp_lob_e1', zoneId: 'lobby', spawnPos: [12.2, 0, 18.2], entryPos: [9.8, 0, 18.2], entryNodeId: 'lob_e', yaw: -Math.PI * 0.5 },
    { id: 'sp_lob_sw', zoneId: 'lobby', spawnPos: [-5.5, 0, 21.4], entryPos: [-5.5, 0, 18.5], entryNodeId: 'lob_sw', yaw: Math.PI },
    { id: 'sp_lob_se', zoneId: 'lobby', spawnPos: [5.5, 0, 21.4], entryPos: [5.5, 0, 18.5], entryNodeId: 'lob_se', yaw: Math.PI },
    // West Wing spawners (2)
    { id: 'sp_ww_1', zoneId: 'west_wing', spawnPos: [-21.4, 0, 4.5], entryPos: [-18.2, 0, 4.5], entryNodeId: 'ww_mid', yaw: Math.PI * 0.5 },
    { id: 'sp_ww_2', zoneId: 'west_wing', spawnPos: [-21.4, 0, -6.5], entryPos: [-18.2, 0, -6.5], entryNodeId: 'ww_n', yaw: Math.PI * 0.5 },
    // East Alley spawners (2)
    { id: 'sp_ew_1', zoneId: 'east_wing', spawnPos: [21.4, 0, 4.5], entryPos: [18.2, 0, 4.5], entryNodeId: 'ew_mid', yaw: -Math.PI * 0.5 },
    { id: 'sp_ew_2', zoneId: 'east_wing', spawnPos: [21.4, 0, -6.5], entryPos: [18.2, 0, -6.5], entryNodeId: 'ew_n', yaw: -Math.PI * 0.5 },
    // Auditorium & Stage spawners (4)
    { id: 'sp_aud_w', zoneId: 'auditorium', spawnPos: [-11.8, 0.55, 0.5], entryPos: [-10.2, 0.55, 0.5], entryNodeId: 'aud_aisle_w', yaw: Math.PI * 0.5 },
    { id: 'sp_aud_e', zoneId: 'auditorium', spawnPos: [11.8, 0.55, 0.5], entryPos: [10.2, 0.55, 0.5], entryNodeId: 'aud_aisle_e', yaw: -Math.PI * 0.5 },
    { id: 'sp_stage_w', zoneId: 'auditorium', spawnPos: [-11.5, 0.85, -22.2], entryPos: [-8.8, 0.85, -20.5], entryNodeId: 'stage_l', yaw: Math.PI * 0.25 },
    { id: 'sp_stage_e', zoneId: 'auditorium', spawnPos: [11.5, 0.85, -22.2], entryPos: [8.8, 0.85, -20.5], entryNodeId: 'stage_r', yaw: -Math.PI * 0.25 },
  ];

  // Visual barricaded window frames at spawner locations
  const slatGeo = trackGeo(new THREE.BoxGeometry(0.14, 0.2, 1.9));
  const slatInst = new THREE.InstancedMesh(slatGeo, matBarricadeWood, zombieSpawners.length * 3);
  let slatIdx = 0;
  for (const sp of zombieSpawners) {
    for (let k = 0; k < 3; k++) {
      dummy.position.set(sp.spawnPos[0], sp.spawnPos[1] + 0.65 + k * 0.55, sp.spawnPos[2]);
      dummy.rotation.set(0, sp.yaw - Math.PI * 0.5, (k - 1) * 0.08);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      slatInst.setMatrixAt(slatIdx++, dummy.matrix);
    }
  }
  slatInst.instanceMatrix.needsUpdate = true;
  slatInst.computeBoundingSphere();
  sceneGroup.add(slatInst);

  // === 10. ZONE-GATED NAVGRAPH (Continuous Figure-8 Kiting Loop across All 5 Zones!) ===
  const rawNodes: NavNode[] = [
    // Zone 1: Grand Lobby
    { id: 'lob_c', position: [0, 0, 11.2], zoneId: 'lobby', neighbors: ['lob_w', 'lob_e', 'lob_sw', 'lob_se'] },
    { id: 'lob_w', position: [-9.2, 0, 11.0], zoneId: 'lobby', neighbors: ['lob_c', 'lob_sw', 'ww_s'] },
    { id: 'lob_e', position: [9.2, 0, 11.0], zoneId: 'lobby', neighbors: ['lob_c', 'lob_se', 'ew_s'] },
    { id: 'lob_sw', position: [-6.5, 0, 17.6], zoneId: 'lobby', neighbors: ['lob_c', 'lob_w', 'lob_se', 'lob_mez'] },
    { id: 'lob_se', position: [6.5, 0, 17.6], zoneId: 'lobby', neighbors: ['lob_c', 'lob_e', 'lob_sw', 'lob_mez'] },
    { id: 'lob_mez', position: [0, 3.12, 19.6], zoneId: 'lobby', neighbors: ['lob_sw', 'lob_se'] },

    // Zone 2: West Dressing Corridor
    { id: 'ww_s', position: [-16.8, 0, 10.5], zoneId: 'west_wing', requiredDoorId: 'door_west_wing', neighbors: ['lob_w', 'ww_mid'] },
    { id: 'ww_mid', position: [-17.5, 0, 1.0], zoneId: 'west_wing', neighbors: ['ww_s', 'ww_n'] },
    { id: 'ww_n', position: [-17.2, 0, -11.5], zoneId: 'west_wing', neighbors: ['ww_mid', 'aud_pit_w'] },

    // Zone 3: Moonlit East Back Alley
    { id: 'ew_s', position: [16.8, 0, 10.5], zoneId: 'east_wing', requiredDoorId: 'door_east_wing', neighbors: ['lob_e', 'ew_mid'] },
    { id: 'ew_mid', position: [17.5, 0, 1.0], zoneId: 'east_wing', neighbors: ['ew_s', 'ew_n'] },
    { id: 'ew_n', position: [17.2, 0, -11.5], zoneId: 'east_wing', neighbors: ['ew_mid', 'aud_pit_e'] },

    // Zone 4: Sloped Main Auditorium & Elevated Stage
    { id: 'aud_pit_w', position: [-10.6, 0, -11.5], zoneId: 'auditorium', neighbors: ['ww_n', 'aud_aisle_w', 'aud_pit_c', 'stage_l'] },
    { id: 'aud_pit_c', position: [0, 0, -11.5], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'aud_pit_e', 'aud_center_mid'] },
    { id: 'aud_pit_e', position: [10.6, 0, -11.5], zoneId: 'auditorium', neighbors: ['ew_n', 'aud_aisle_e', 'aud_pit_c', 'stage_r'] },
    { id: 'aud_aisle_w', position: [-10.6, 0.6, 0], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'aud_back_w'] },
    { id: 'aud_center_mid', position: [0, 0.6, 0], zoneId: 'auditorium', neighbors: ['aud_pit_c', 'aud_back_c'] },
    { id: 'aud_aisle_e', position: [10.6, 0.6, 0], zoneId: 'auditorium', neighbors: ['aud_pit_e', 'aud_back_e'] },
    { id: 'aud_back_w', position: [-10.6, 1.15, 6.2], zoneId: 'auditorium', neighbors: ['aud_aisle_w', 'aud_back_c', 'proj_booth'] },
    { id: 'aud_back_c', position: [0, 1.15, 6.2], zoneId: 'auditorium', neighbors: ['aud_back_w', 'aud_back_e', 'aud_center_mid'] },
    { id: 'aud_back_e', position: [10.6, 1.15, 6.2], zoneId: 'auditorium', neighbors: ['aud_aisle_e', 'aud_back_c'] },
    { id: 'stage_l', position: [-7.5, 0.85, -18.5], zoneId: 'auditorium', neighbors: ['aud_pit_w', 'stage_c'] },
    { id: 'stage_c', position: [0, 0.85, -18.5], zoneId: 'auditorium', neighbors: ['stage_l', 'stage_r'] },
    { id: 'stage_r', position: [7.5, 0.85, -18.5], zoneId: 'auditorium', neighbors: ['aud_pit_e', 'stage_c'] },

    // Zone 5: Upper Projector Booth
    { id: 'proj_booth', position: [0, PROJ_Y, 5.6], zoneId: 'projector', requiredDoorId: 'door_projector', neighbors: ['aud_back_w'] },
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
      teamA: [{ position: [0, 0, 11.4], yaw: 0 }],
      teamB: [{ position: [0, 0.85, -18.0], yaw: Math.PI }],
      ffa: [{ position: [0, 0, 11.4], yaw: 0 }],
      playerStart: { position: [0, 0, 11.4], yaw: 0, zoneId: 'lobby' },
      zombieSpawners,
    },
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
      } else {
        beamMat.opacity = 0;
      }
      // Subtle mystery crate shimmer
      crateLight.intensity = 3.8 + Math.sin(elapsedSec * 3.4) * 0.85;
      // Subtle eerie red flicker in West Wing emergency bulb
      westEmergency.intensity = 3.6 + Math.sin(elapsedSec * 11.5) * 0.55;
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
  subtitle: 'Abandoned 1940s Cinema',
  description:
    'Hold the Grand Lobby, unlock the Dressing Corridor and Moonlit Back Alley, breach the sloped Auditorium and Stage, restore Main Power, and claim the upper Projector Booth.',
  mode: 'infection',
  status: 'playable',
  environmentTags: ['Round-Based Horde', '5 Unlockable Zones', 'Power & Perks'],
  accentHex: '#dc2626',
  previewStyle: 'kino_theater',
  build: buildKinoTheater,
};

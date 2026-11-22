import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { createStencilSignTexture } from '../gym/GymTextures';
import {
  createCabinWoodTexture,
  createSovietConcreteTexture,
  createSovietPlasterTexture,
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
  backgroundHex: 0x76828b,
  fogHex: 0x6f7b83,
  fogDensity: 0.015,
  envIntensity: 0.48,
  hemiSkyHex: 0xa6b7c4,
  hemiGroundHex: 0x2e312f,
  hemiIntensity: 0.62,
  keyLightHex: 0xdbe6ef,
  keyLightIntensity: 1.55,
  keyLightPos: [-22, 34, 18],
};

function buildPripyatBlock(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): BuiltMapInstance {
  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -19.4;
  physics.boundsMaxX = 19.4;
  physics.boundsMinZ = -16.4;
  physics.boundsMaxZ = 16.4;

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

  const sun = new THREE.DirectionalLight(
    LIGHTING_PRESET.keyLightHex,
    LIGHTING_PRESET.keyLightIntensity,
  );
  sun.position.set(...LIGHTING_PRESET.keyLightPos);
  if (!isSoftwareGl) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 85;
    sun.shadow.camera.left = -26;
    sun.shadow.camera.right = 26;
    sun.shadow.camera.top = 26;
    sun.shadow.camera.bottom = -26;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
  }
  sceneGroup.add(sun);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const concTex = trackTex(createSovietConcreteTexture(maxAniso, 3, 2, '#7c817e', 404));
  const floorTex = trackTex(createSovietConcreteTexture(maxAniso, 8, 7, '#646866', 409));
  const plasterTex = trackTex(createSovietPlasterTexture(maxAniso, 2, 1));
  const woodTex = trackTex(createCabinWoodTexture(maxAniso, 1, 1, '#584433', 422));

  const matConcrete = trackMat(
    new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.9, metalness: 0.04 }),
  );
  const matFloor = trackMat(
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.92, metalness: 0.03 }),
  );
  const matPlaster = trackMat(
    new THREE.MeshStandardMaterial({ map: plasterTex, roughness: 0.88, metalness: 0.02 }),
  );
  const matDarkConcrete = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x454947, roughness: 0.94, metalness: 0.05 }),
  );
  const matWood = trackMat(
    new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.86, metalness: 0.04 }),
  );
  const matSandbag = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x7c745c, roughness: 0.96, metalness: 0.02 }),
  );
  const matSteel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x3b4044, roughness: 0.55, metalness: 0.72 }),
  );
  const matFluorescentHousing = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x363b3e, roughness: 0.6, metalness: 0.5 }),
  );
  const matTubeOn = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xdff6ff,
      emissive: 0xc2ecff,
      emissiveIntensity: 1.8,
      roughness: 0.2,
    }),
  );

  // Helper to place solid structural box + physics collider + raycast tag
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
  ): THREE.Mesh => {
    const geo = trackGeo(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !isSoftwareGl && h > 0.4;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    sceneGroup.add(mesh);
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

  // Helper to build a wall with a clean centered doorway opening
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
      // Wall extends along X at Z = fixedCoord
      if (leftLen > 0.15) {
        addSolidBox(start + leftLen * 0.5, baseY + wallH * 0.5, fixedCoord, leftLen, wallH, thickness, mat);
      }
      if (rightLen > 0.15) {
        addSolidBox(end - rightLen * 0.5, baseY + wallH * 0.5, fixedCoord, rightLen, wallH, thickness, mat);
      }
      if (headerH > 0.15) {
        addSolidBox(doorCenter, baseY + doorH + headerH * 0.5, fixedCoord, doorW, headerH, thickness, mat);
      }
    } else {
      // Wall extends along Z at X = fixedCoord
      if (leftLen > 0.15) {
        addSolidBox(fixedCoord, baseY + wallH * 0.5, start + leftLen * 0.5, thickness, wallH, leftLen, mat);
      }
      if (rightLen > 0.15) {
        addSolidBox(fixedCoord, baseY + wallH * 0.5, end - rightLen * 0.5, thickness, wallH, rightLen, mat);
      }
      if (headerH > 0.15) {
        addSolidBox(fixedCoord, baseY + doorH + headerH * 0.5, doorCenter, thickness, headerH, doorW, mat);
      }
    }
  };

  // === 1. Ground Floor Slab & Exterior Perimeter Concrete Walls ===
  const FLOOR_2_Y = 3.6;
  const WALL_H = 3.6;
  const ROOF_Y = 7.2;

  // Ground floor visual + raycast
  const groundMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(42, 36)), matFloor);
  groundMesh.rotation.x = -Math.PI * 0.5;
  groundMesh.receiveShadow = !isSoftwareGl;
  groundMesh.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(groundMesh);
  raycastMeshes.push(groundMesh);

  // Exterior courtyard skirt so looking through blown-out windows shows overcast Soviet asphalt
  const extApron = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(140, 140)), matDarkConcrete);
  extApron.rotation.x = -Math.PI * 0.5;
  extApron.position.y = -0.06;
  sceneGroup.add(extApron);

  // Distant silhouette Soviet residential blocks outside the windows for grounded atmosphere
  const outerBlockGeo = trackGeo(new THREE.BoxGeometry(18, 22, 12));
  const outerBlockPositions: Array<[number, number, number]> = [
    [-46, 11, -28],
    [46, 11, -30],
    [-44, 11, 28],
    [46, 11, 26],
    [0, 11, -48],
    [0, 11, 48],
  ];
  const outerBlocks = new THREE.InstancedMesh(outerBlockGeo, matDarkConcrete, outerBlockPositions.length);
  const dummy = new THREE.Object3D();
  outerBlockPositions.forEach(([bx, by, bz], idx) => {
    dummy.position.set(bx, by, bz);
    dummy.rotation.set(0, idx * 0.35, 0);
    dummy.scale.set(1, 0.85 + (idx % 3) * 0.2, 1);
    dummy.updateMatrix();
    outerBlocks.setMatrixAt(idx, dummy.matrix);
  });
  outerBlocks.instanceMatrix.needsUpdate = true;
  outerBlocks.computeBoundingSphere();
  sceneGroup.add(outerBlocks);

  // Perimeter Exterior Walls (non-overlapping corner & window pier joints)
  // North & South solid exterior walls (both floors: x in [-20.25, 20.25], z = ±17)
  addSolidBox(0, ROOF_Y * 0.5, -17, 40.5, ROOF_Y, 0.5, matConcrete);
  addSolidBox(0, ROOF_Y * 0.5, 17, 40.5, ROOF_Y, 0.5, matConcrete);

  // West & East perimeter walls strictly between North & South inner faces (z in [-16.75, 16.75])
  for (const sideX of [-20, 20]) {
    for (const floorY of [0, FLOOR_2_Y]) {
      // Lower sill wall (y: floorY .. floorY + 1.04)
      addSolidBox(sideX, floorY + 0.52, 0, 0.5, 1.04, 33.5, matConcrete);
      // Upper header beam (y: floorY + 2.70 .. floorY + 3.60)
      addSolidBox(sideX, floorY + 3.15, 0, 0.5, 0.9, 33.5, matConcrete);
      // Window piers strictly between sill top (1.04) & header bottom (2.70), flush inside N/S walls
      for (const pz of [-15.25, -6.0, 6.0, 15.25]) {
        addSolidBox(sideX, floorY + 1.87, pz, 0.5, 1.66, 3.0, matConcrete);
      }
    }
  }

  // Interior Acoustic Zone covering entire building
  physics.addInteriorZone({
    minX: -19.8,
    maxX: 19.8,
    minY: 0,
    maxY: 7.2,
    minZ: -16.8,
    maxZ: 16.8,
    material: 'concrete',
  });

  // === 2. Ground Floor Interior Rooms & Corridor Partitioning ===
  // Ground floor interior walls stop flush beneath the 2nd-floor slab underside (FLOOR_2_Y - 0.28 = 3.32)
  const GROUND_WALL_H = FLOOR_2_Y - 0.28;
  // West Apartments (X in [-19.75, -3.63]): non-overlapping T-joints at Z = ±5.5
  addWallWithDoor('z', -3.8, -16.75, -5.67, 0, GROUND_WALL_H, -11.2, 2.2, 2.5, 0.34, matPlaster);
  addWallWithDoor('z', -3.8, 5.67, 16.75, 0, GROUND_WALL_H, 11.2, 2.2, 2.5, 0.34, matPlaster);
  addWallWithDoor('x', -5.5, -19.75, -3.63, 0, GROUND_WALL_H, -12.5, 2.4, 2.5, 0.34, matPlaster);
  addWallWithDoor('x', 5.5, -19.75, -3.63, 0, GROUND_WALL_H, -12.5, 2.4, 2.5, 0.34, matPlaster);

  // East Offices (X in [3.63, 19.75]): non-overlapping T-joints at Z = ±5.5
  addWallWithDoor('z', 3.8, -16.75, -5.67, 0, GROUND_WALL_H, -11.2, 2.2, 2.5, 0.34, matPlaster);
  addWallWithDoor('z', 3.8, 5.67, 16.75, 0, GROUND_WALL_H, 11.2, 2.2, 2.5, 0.34, matPlaster);
  addWallWithDoor('x', -5.5, 3.63, 19.75, 0, GROUND_WALL_H, 12.5, 2.4, 2.5, 0.34, matPlaster);
  addWallWithDoor('x', 5.5, 3.63, 19.75, 0, GROUND_WALL_H, 12.5, 2.4, 2.5, 0.34, matPlaster);

  // Apartment interior tactical partition baffles (stop cleanly beneath 2nd-floor slab)
  addSolidBox(-11.5, GROUND_WALL_H * 0.5, -11.5, 0.3, GROUND_WALL_H, 5.2, matPlaster);
  addSolidBox(11.5, GROUND_WALL_H * 0.5, -11.5, 0.3, GROUND_WALL_H, 5.2, matPlaster);
  addSolidBox(-11.5, GROUND_WALL_H * 0.5, 11.5, 0.3, GROUND_WALL_H, 5.2, matPlaster);
  addSolidBox(11.5, GROUND_WALL_H * 0.5, 11.5, 0.3, GROUND_WALL_H, 5.2, matPlaster);

  // Interior timber desks / cover crates inside offices
  const deskPositions: Array<[number, number, number, number, number]> = [
    [-15.5, 0.45, -13.5, 2.2, 0.9],
    [15.5, 0.45, -13.5, 2.2, 0.9],
    [-15.5, 0.45, 13.5, 2.2, 0.9],
    [15.5, 0.45, 13.5, 2.2, 0.9],
    [-7.5, 0.55, -13.8, 1.6, 1.1],
    [7.5, 0.55, 13.8, 1.6, 1.1],
  ];
  for (const [dx, dy, dz, dw, dd] of deskPositions) {
    addSolidBox(dx, dy, dz, dw, dy * 2, dd, matWood, 'wood');
  }

  // === 3. Second Floor Slabs (non-overlapping joints inside exterior walls) ===
  // North second-floor bridge & offices (Z in [-16.75, -5.5], X in [-19.75, 19.75])
  addSolidBox(0, FLOOR_2_Y - 0.14, -11.125, 39.5, 0.28, 11.25, matConcrete);
  // South second-floor bridge & offices (Z in [5.5, 16.75], X in [-19.75, 19.75])
  addSolidBox(0, FLOOR_2_Y - 0.14, 11.125, 39.5, 0.28, 11.25, matConcrete);
  // West outer balcony strip (X in [-19.75, -10.2], Z in [-5.5, 5.5])
  addSolidBox(-14.975, FLOOR_2_Y - 0.14, 0, 9.55, 0.28, 11.0, matConcrete);
  // East outer balcony strip (X in [10.2, 19.75], Z in [-5.5, 5.5])
  addSolidBox(14.975, FLOOR_2_Y - 0.14, 0, 9.55, 0.28, 11.0, matConcrete);

  // Waist-high concrete parapets overlooking central atrium (non-overlapping corners)
  addSolidBox(0, FLOOR_2_Y + 0.52, -5.64, 20.96, 1.04, 0.28, matConcrete);
  addSolidBox(0, FLOOR_2_Y + 0.52, 5.64, 20.96, 1.04, 0.28, matConcrete);
  addSolidBox(-10.34, FLOOR_2_Y + 0.52, 0, 0.28, 1.04, 11.0, matConcrete);
  addSolidBox(10.34, FLOOR_2_Y + 0.52, 0, 0.28, 1.04, 11.0, matConcrete);

  // Second Floor Interior Partitions (butted cleanly between parapets & exterior walls)
  addWallWithDoor('z', -5.5, -16.75, -5.78, FLOOR_2_Y, WALL_H, -11.5, 2.4, 2.5, 0.32, matPlaster);
  addWallWithDoor('z', 5.5, -16.75, -5.78, FLOOR_2_Y, WALL_H, -11.5, 2.4, 2.5, 0.32, matPlaster);
  addWallWithDoor('z', -5.5, 5.78, 16.75, FLOOR_2_Y, WALL_H, 11.5, 2.4, 2.5, 0.32, matPlaster);
  addWallWithDoor('z', 5.5, 5.78, 16.75, FLOOR_2_Y, WALL_H, 11.5, 2.4, 2.5, 0.32, matPlaster);

  // Roof Slab (exact non-overlapping seams around central atrium skylight)
  addSolidBox(0, ROOF_Y + 0.15, -11.525, 40.5, 0.3, 11.45, matDarkConcrete);
  addSolidBox(0, ROOF_Y + 0.15, 11.525, 40.5, 0.3, 11.45, matDarkConcrete);
  addSolidBox(-13.525, ROOF_Y + 0.15, 0, 13.45, 0.3, 11.6, matDarkConcrete);
  addSolidBox(13.525, ROOF_Y + 0.15, 0, 13.45, 0.3, 11.6, matDarkConcrete);

  // === 4. Dual Symmetrical Brutalist Staircases (West & East Mid-Atrium) ===
  // West Stair: X in [-9.6, -6.2], rises along +Z from Z = -4.6 (Y=0) to Z = 5.4 (Y=3.6)
  // East Stair: X in [6.2, 9.6], rises along -Z from Z = 4.6 (Y=0) to Z = -5.4 (Y=3.6)
  const buildStairFlight = (
    centerX: number,
    width: number,
    zStart: number,
    zEnd: number,
    riseAxis: '+z' | '-z',
  ): void => {
    const minZ = Math.min(zStart, zEnd);
    const maxZ = Math.max(zStart, zEnd);
    physics.addRamp({
      minX: centerX - width * 0.5,
      maxX: centerX + width * 0.5,
      minZ,
      maxZ,
      baseY: 0,
      topY: FLOOR_2_Y,
      riseAxis,
      surface: 'concrete',
    });

    const stepCount = 16;
    const stepD = (maxZ - minZ) / stepCount;
    const stepH = FLOOR_2_Y / stepCount;
    // Slight 2mm tread gap eliminates coplanar side-face overlap between adjacent steps
    const stepGeo = trackGeo(new THREE.BoxGeometry(width, stepH, Math.max(0.05, stepD - 0.002)));
    const stepInst = new THREE.InstancedMesh(stepGeo, matDarkConcrete, stepCount);
    stepInst.receiveShadow = !isSoftwareGl;
    stepInst.castShadow = !isSoftwareGl;
    for (let i = 0; i < stepCount; i++) {
      const t = (i + 0.5) / stepCount;
      const sz = riseAxis === '+z' ? minZ + t * (maxZ - minZ) : maxZ - t * (maxZ - minZ);
      const sy = (i + 0.5) * stepH;
      dummy.position.set(centerX, sy, sz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      stepInst.setMatrixAt(i, dummy.matrix);
    }
    stepInst.instanceMatrix.needsUpdate = true;
    stepInst.computeBoundingSphere();
    stepInst.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(stepInst);
    raycastMeshes.push(stepInst);

    // Steel side handrails
    const railLen = Math.hypot(maxZ - minZ, FLOOR_2_Y);
    const railAngle = Math.atan2(FLOOR_2_Y, maxZ - minZ) * (riseAxis === '+z' ? -1 : 1);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.08, railLen)), matSteel);
      rail.position.set(centerX + side * (width * 0.5 - 0.06), FLOOR_2_Y * 0.5 + 0.92, (minZ + maxZ) * 0.5);
      rail.rotation.x = railAngle;
      sceneGroup.add(rail);
    }
  };

  buildStairFlight(-7.8, 2.8, -4.4, 5.5, '+z');
  buildStairFlight(7.8, 2.8, 4.4, -5.5, '-z');

  // === 5. InstancedMesh Structural Columns, Sandbag Cover & Fluorescent Fixtures ===
  // Ground-floor columns stop cleanly under 2nd-floor slab (h=3.32) and clear partition walls
  const groundColumnCoords: Array<[number, number, number]> = [
    [-3.28, GROUND_WALL_H * 0.5, -14.2],
    [3.28, GROUND_WALL_H * 0.5, -14.2],
    [-3.28, GROUND_WALL_H * 0.5, -6.2],
    [3.28, GROUND_WALL_H * 0.5, -6.2],
    [-3.6, GROUND_WALL_H * 0.5, 0.0],
    [3.6, GROUND_WALL_H * 0.5, 0.0],
    [-3.28, GROUND_WALL_H * 0.5, 6.2],
    [3.28, GROUND_WALL_H * 0.5, 6.2],
    [-3.28, GROUND_WALL_H * 0.5, 14.2],
    [3.28, GROUND_WALL_H * 0.5, 14.2],
    [-14.5, GROUND_WALL_H * 0.5, -8.0],
    [14.5, GROUND_WALL_H * 0.5, -8.0],
    [-14.5, GROUND_WALL_H * 0.5, 8.0],
    [14.5, GROUND_WALL_H * 0.5, 8.0],
  ];
  const upperColumnCoords: Array<[number, number, number]> = [
    [-14.5, FLOOR_2_Y + WALL_H * 0.5, -8.0],
    [14.5, FLOOR_2_Y + WALL_H * 0.5, -8.0],
    [-14.5, FLOOR_2_Y + WALL_H * 0.5, 8.0],
    [14.5, FLOOR_2_Y + WALL_H * 0.5, 8.0],
    [-6.0, FLOOR_2_Y + WALL_H * 0.5, -12.0],
    [6.0, FLOOR_2_Y + WALL_H * 0.5, -12.0],
    [-6.0, FLOOR_2_Y + WALL_H * 0.5, 12.0],
    [6.0, FLOOR_2_Y + WALL_H * 0.5, 12.0],
  ];
  const addColumnBatch = (coords: Array<[number, number, number]>, height: number): void => {
    const colGeo = trackGeo(new THREE.BoxGeometry(0.68, height, 0.68));
    const colInst = new THREE.InstancedMesh(colGeo, matConcrete, coords.length);
    colInst.castShadow = !isSoftwareGl;
    colInst.receiveShadow = !isSoftwareGl;
    coords.forEach(([cx, cy, cz], i) => {
      dummy.position.set(cx, cy, cz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      colInst.setMatrixAt(i, dummy.matrix);
      physics.addBox({
        minX: cx - 0.34,
        maxX: cx + 0.34,
        minY: cy - height * 0.5,
        maxY: cy + height * 0.5,
        minZ: cz - 0.34,
        maxZ: cz + 0.34,
        surface: 'concrete',
        blocksMovement: true,
      });
    });
    colInst.instanceMatrix.needsUpdate = true;
    colInst.computeBoundingSphere();
    colInst.userData.surfaceMaterial = 'concrete';
    sceneGroup.add(colInst);
    raycastMeshes.push(colInst);
  };
  addColumnBatch(groundColumnCoords, GROUND_WALL_H);
  addColumnBatch(upperColumnCoords, WALL_H);

  // InstancedMesh Sandbag Cover Positions (crouch-height tactical cover across central corridor & rooms)
  const sandbagBarriers: Array<[number, number, number, number]> = [
    [0.0, 0.0, -9.2, 0],
    [0.0, 0.0, 9.2, 0],
    [-1.4, 0.0, -2.5, Math.PI * 0.06],
    [1.4, 0.0, 2.5, -Math.PI * 0.06],
    [-13.5, 0.0, 0.0, Math.PI * 0.5],
    [13.5, 0.0, 0.0, Math.PI * 0.5],
    [0.0, FLOOR_2_Y, -10.5, 0],
    [0.0, FLOOR_2_Y, 10.5, 0],
  ];
  const bagGeo = trackGeo(new THREE.BoxGeometry(0.65, 0.36, 0.42));
  const totalBags = sandbagBarriers.length * 6;
  const bagInst = new THREE.InstancedMesh(bagGeo, matSandbag, totalBags);
  bagInst.castShadow = !isSoftwareGl;
  bagInst.receiveShadow = !isSoftwareGl;
  let bagIdx = 0;
  for (const [bx, by, bz, rotY] of sandbagBarriers) {
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 2; col++) {
        const localX = (col - 0.5) * 0.72 + (row % 2 === 1 ? 0.12 : 0);
        const wx = bx + localX * cos;
        const wz = bz - localX * sin;
        dummy.position.set(wx, by + 0.181 + row * 0.362, wz);
        dummy.rotation.set(0, rotY, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bagInst.setMatrixAt(bagIdx++, dummy.matrix);
      }
    }
    const halfX = Math.abs(cos) > 0.5 ? 0.95 : 0.32;
    const halfZ = Math.abs(cos) > 0.5 ? 0.32 : 0.95;
    physics.addBox({
      minX: bx - halfX,
      maxX: bx + halfX,
      minY: by,
      maxY: by + 1.08,
      minZ: bz - halfZ,
      maxZ: bz + halfZ,
      surface: 'gravel',
      blocksMovement: true,
    });
  }
  bagInst.instanceMatrix.needsUpdate = true;
  bagInst.computeBoundingSphere();
  bagInst.userData.surfaceMaterial = 'gravel';
  sceneGroup.add(bagInst);
  raycastMeshes.push(bagInst);

  // InstancedMesh Ceiling Fluorescent Housings (flush below 3.32m slab & 7.20m roof, zero overlap)
  const fixtureCoords: Array<[number, number, number]> = [
    [0, 3.268, -12.5],
    [0, 3.268, -7.5],
    [0, 3.268, 7.5],
    [0, 3.268, 12.5],
    [-12.5, 3.268, -11.0],
    [12.5, 3.268, -11.0],
    [-12.5, 3.268, 11.0],
    [12.5, 3.268, 11.0],
    [0, ROOF_Y - 0.052, -11.0],
    [0, ROOF_Y - 0.052, 11.0],
    [-14.0, ROOF_Y - 0.052, 0],
    [14.0, ROOF_Y - 0.052, 0],
  ];
  const housingGeo = trackGeo(new THREE.BoxGeometry(1.4, 0.1, 0.24));
  const tubeGeo = trackGeo(new THREE.BoxGeometry(1.26, 0.048, 0.12));
  const housingInst = new THREE.InstancedMesh(housingGeo, matFluorescentHousing, fixtureCoords.length);
  const tubeInst = new THREE.InstancedMesh(tubeGeo, matTubeOn, fixtureCoords.length);
  fixtureCoords.forEach(([fx, fy, fz], i) => {
    dummy.position.set(fx, fy, fz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    housingInst.setMatrixAt(i, dummy.matrix);
    dummy.position.set(fx, fy - 0.076, fz);
    dummy.updateMatrix();
    tubeInst.setMatrixAt(i, dummy.matrix);
  });
  housingInst.instanceMatrix.needsUpdate = true;
  housingInst.computeBoundingSphere();
  tubeInst.instanceMatrix.needsUpdate = true;
  tubeInst.computeBoundingSphere();
  sceneGroup.add(housingInst, tubeInst);

  // Atmospheric Interior PointLights (non-shadow for fast FPS, subtle fluorescent flicker)
  const flickerLights: Array<{ light: THREE.PointLight; baseIntensity: number; phase: number; broken: boolean }> = [];
  const lightSpecs: Array<[number, number, number, number, boolean]> = [
    [0, 3.1, -11.0, 7.5, false],
    [0, 3.1, 11.0, 7.5, true],
    [-12.5, 3.1, -11.0, 6.0, false],
    [12.5, 3.1, 11.0, 6.0, true],
    [0, 6.6, -11.0, 6.5, false],
    [0, 6.6, 11.0, 6.5, false],
  ];
  for (let i = 0; i < lightSpecs.length; i++) {
    const [lx, ly, lz, inten, broken] = lightSpecs[i];
    const pl = new THREE.PointLight(0xcbe8f7, inten, 19, 1.8);
    pl.position.set(lx, ly, lz);
    sceneGroup.add(pl);
    flickerLights.push({ light: pl, baseIntensity: inten, phase: i * 1.9, broken });
  }

  // Cyrillic/Sector Stencil Plaques on Corridor Walls (polygonOffset prevents grazing Z-fighting)
  const signNorthTex = trackTex(createStencilSignTexture('БЛОК 04 · СЕВЕР', 'PRIPYAT SECTOR NORTH', '#e0a448', '#252927', maxAniso));
  const signSouthTex = trackTex(createStencilSignTexture('БЛОК 04 · ЮГ', 'PRIPYAT SECTOR SOUTH', '#5ca6d8', '#252927', maxAniso));
  const signGeo = trackGeo(new THREE.PlaneGeometry(2.4, 0.9));
  const signN = new THREE.Mesh(
    signGeo,
    trackMat(
      new THREE.MeshStandardMaterial({
        map: signNorthTex,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  signN.position.set(0, 2.35, -16.72);
  const signS = new THREE.Mesh(
    signGeo,
    trackMat(
      new THREE.MeshStandardMaterial({
        map: signSouthTex,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    ),
  );
  signS.position.set(0, 2.35, 16.72);
  signS.rotation.y = Math.PI;
  sceneGroup.add(signN, signS);

  // === 6. Complete 2-Floor NavGraph (24 interconnected waypoints + cover nodes) ===
  const rawNodes: NavNode[] = [
    // Ground floor central corridor
    { id: 'g_cor_n', position: [0, 0, -13.5], zoneId: 'default', neighbors: ['g_cor_nm', 'g_nw_door', 'g_ne_door'] },
    { id: 'g_cor_nm', position: [0, 0, -7.2], zoneId: 'default', neighbors: ['g_cor_n', 'g_cor_mid', 'g_w_stair_bot'], isCover: true, coverNormal: [0, 1] },
    { id: 'g_cor_mid', position: [0, 0, 0], zoneId: 'default', neighbors: ['g_cor_nm', 'g_cor_sm', 'g_w_mid', 'g_e_mid'], isCover: true, coverNormal: [1, 0] },
    { id: 'g_cor_sm', position: [0, 0, 7.2], zoneId: 'default', neighbors: ['g_cor_mid', 'g_cor_s', 'g_e_stair_bot'], isCover: true, coverNormal: [0, -1] },
    { id: 'g_cor_s', position: [0, 0, 13.5], zoneId: 'default', neighbors: ['g_cor_sm', 'g_sw_door', 'g_se_door'] },

    // Ground floor NW / SW / NE / SE breached apartments
    { id: 'g_nw_door', position: [-6.8, 0, -11.2], zoneId: 'default', neighbors: ['g_cor_n', 'g_nw_room'], isCover: true, coverNormal: [1, 0] },
    { id: 'g_nw_room', position: [-14.2, 0, -10.2], zoneId: 'default', neighbors: ['g_nw_door', 'g_w_mid'] },
    { id: 'g_w_mid', position: [-13.0, 0, 0], zoneId: 'default', neighbors: ['g_nw_room', 'g_sw_room', 'g_cor_mid', 'g_w_stair_bot'], isCover: true, coverNormal: [1, 0] },
    { id: 'g_sw_door', position: [-6.8, 0, 11.2], zoneId: 'default', neighbors: ['g_cor_s', 'g_sw_room'], isCover: true, coverNormal: [1, 0] },
    { id: 'g_sw_room', position: [-14.2, 0, 10.2], zoneId: 'default', neighbors: ['g_sw_door', 'g_w_mid'] },

    { id: 'g_ne_door', position: [6.8, 0, -11.2], zoneId: 'default', neighbors: ['g_cor_n', 'g_ne_room'], isCover: true, coverNormal: [-1, 0] },
    { id: 'g_ne_room', position: [14.2, 0, -10.2], zoneId: 'default', neighbors: ['g_ne_door', 'g_e_mid'] },
    { id: 'g_e_mid', position: [13.0, 0, 0], zoneId: 'default', neighbors: ['g_ne_room', 'g_se_room', 'g_cor_mid', 'g_e_stair_bot'], isCover: true, coverNormal: [-1, 0] },
    { id: 'g_se_door', position: [6.8, 0, 11.2], zoneId: 'default', neighbors: ['g_cor_s', 'g_se_room'], isCover: true, coverNormal: [-1, 0] },
    { id: 'g_se_room', position: [14.2, 0, 10.2], zoneId: 'default', neighbors: ['g_se_door', 'g_e_mid'] },

    // Stairwells connecting Ground <-> 2nd Floor
    { id: 'g_w_stair_bot', position: [-7.8, 0, -4.8], zoneId: 'default', neighbors: ['g_cor_nm', 'g_w_mid', 'u_w_stair_top'] },
    { id: 'u_w_stair_top', position: [-7.8, FLOOR_2_Y, 6.8], zoneId: 'default', neighbors: ['g_w_stair_bot', 'u_s_bridge', 'u_sw_office'] },
    { id: 'g_e_stair_bot', position: [7.8, 0, 4.8], zoneId: 'default', neighbors: ['g_cor_sm', 'g_e_mid', 'u_e_stair_top'] },
    { id: 'u_e_stair_top', position: [7.8, FLOOR_2_Y, -6.8], zoneId: 'default', neighbors: ['g_e_stair_bot', 'u_n_bridge', 'u_ne_office'] },

    // Second Floor Bridges, Balcony & Overlook Offices
    { id: 'u_n_bridge', position: [0, FLOOR_2_Y, -8.5], zoneId: 'default', neighbors: ['u_e_stair_top', 'u_nw_office', 'u_ne_office'], isCover: true, coverNormal: [0, 1] },
    { id: 'u_s_bridge', position: [0, FLOOR_2_Y, 8.5], zoneId: 'default', neighbors: ['u_w_stair_top', 'u_sw_office', 'u_se_office'], isCover: true, coverNormal: [0, -1] },
    { id: 'u_nw_office', position: [-14.0, FLOOR_2_Y, -11.5], zoneId: 'default', neighbors: ['u_n_bridge', 'u_w_balcony'] },
    { id: 'u_w_balcony', position: [-14.5, FLOOR_2_Y, 0], zoneId: 'default', neighbors: ['u_nw_office', 'u_sw_office'], isCover: true, coverNormal: [1, 0] },
    { id: 'u_sw_office', position: [-14.0, FLOOR_2_Y, 11.5], zoneId: 'default', neighbors: ['u_w_balcony', 'u_w_stair_top', 'u_s_bridge'] },
    { id: 'u_ne_office', position: [14.0, FLOOR_2_Y, -11.5], zoneId: 'default', neighbors: ['u_n_bridge', 'u_e_stair_top', 'u_e_balcony'] },
    { id: 'u_e_balcony', position: [14.5, FLOOR_2_Y, 0], zoneId: 'default', neighbors: ['u_ne_office', 'u_se_office'], isCover: true, coverNormal: [-1, 0] },
    { id: 'u_se_office', position: [14.0, FLOOR_2_Y, 11.5], zoneId: 'default', neighbors: ['u_e_balcony', 'u_s_bridge'] },
  ];

  const teamA: SpawnPoint[] = [
    { position: [0, 0, -14.8], yaw: Math.PI },
    { position: [-15.5, 0, -10.5], yaw: Math.PI * 0.75 },
    { position: [15.5, 0, -10.5], yaw: -Math.PI * 0.75 },
    { position: [0, FLOOR_2_Y, -13.5], yaw: Math.PI },
    { position: [-14.2, FLOOR_2_Y, -12.8], yaw: Math.PI * 0.8 },
    { position: [14.2, FLOOR_2_Y, -12.8], yaw: -Math.PI * 0.8 },
  ];
  const teamB: SpawnPoint[] = [
    { position: [0, 0, 14.8], yaw: 0 },
    { position: [-15.5, 0, 10.5], yaw: Math.PI * 0.25 },
    { position: [15.5, 0, 10.5], yaw: -Math.PI * 0.25 },
    { position: [0, FLOOR_2_Y, 13.5], yaw: 0 },
    { position: [-14.2, FLOOR_2_Y, 12.8], yaw: Math.PI * 0.2 },
    { position: [14.2, FLOOR_2_Y, 12.8], yaw: -Math.PI * 0.2 },
  ];
  const ffa: SpawnPoint[] = [
    ...teamA,
    ...teamB,
    { position: [-14.5, 0, 0], yaw: -Math.PI * 0.5 },
    { position: [14.5, 0, 0], yaw: Math.PI * 0.5 },
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
    update: (_dt, elapsedSec) => {
      for (const fl of flickerLights) {
        if (fl.broken) {
          const pulse = Math.sin(elapsedSec * 19.0 + fl.phase) * Math.sin(elapsedSec * 5.7 + fl.phase);
          fl.light.intensity = pulse > 0.45 ? fl.baseIntensity * 0.18 : fl.baseIntensity;
        } else {
          fl.light.intensity = fl.baseIntensity * (0.96 + Math.sin(elapsedSec * 7.2 + fl.phase) * 0.04);
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
  subtitle: 'Brutalist Soviet CQB Building',
  description:
    'Two-story abandoned apartment block featuring breached concrete suites, twin flank stairwells, flickering corridor fluorescents, and a double-height central atrium.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Close Quarters', '2 Floors', 'Concrete Interior'],
  accentHex: '#f59e0b',
  previewStyle: 'cqb_pripyat',
  build: buildPripyatBlock,
};

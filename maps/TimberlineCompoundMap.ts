import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import {
  createCabinWoodTexture,
  createCorrugatedMetalTexture,
  createForestFloorTexture,
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
  backgroundHex: 0x7e8d91,
  fogHex: 0x79878b,
  fogDensity: 0.0145,
  envIntensity: 0.56,
  hemiSkyHex: 0xb6c8ce,
  hemiGroundHex: 0x353c2e,
  hemiIntensity: 0.92,
  keyLightHex: 0xe8efe6,
  keyLightIntensity: 1.95,
  keyLightPos: [-32, 42, 26],
};

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Smooth outdoor elevation function:
 * Flat (Y = 0) across the fenced compound footprint (|x| < 26, |z| < 24) so cabins, walls,
 * and containers ground flush with zero floating, rising softly into wooded ridges outside.
 */
function sampleForestTerrainY(x: number, z: number): number {
  const edgeX = Math.max(0, Math.abs(x) - 27.5);
  const edgeZ = Math.max(0, Math.abs(z) - 25.5);
  const blend = THREE.MathUtils.clamp(Math.hypot(edgeX, edgeZ) / 14.0, 0, 1);
  if (blend <= 0.001) return 0;
  const smooth = blend * blend * (3 - 2 * blend);
  const ridge =
    Math.sin(x * 0.085) * Math.cos(z * 0.09) * 1.15 +
    Math.sin((x + z) * 0.05) * 0.75 +
    Math.min(3.5, Math.hypot(edgeX, edgeZ) * 0.085);
  return Math.max(0, ridge * smooth);
}

function buildTimberlineCompound(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): BuiltMapInstance {
  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -42;
  physics.boundsMaxX = 42;
  physics.boundsMinZ = -42;
  physics.boundsMaxZ = 42;

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
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 2;
    sun.shadow.camera.far = 115;
    sun.shadow.camera.left = -46;
    sun.shadow.camera.right = 46;
    sun.shadow.camera.top = 46;
    sun.shadow.camera.bottom = -46;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
  }
  sceneGroup.add(sun);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const forestTex = trackTex(createForestFloorTexture(maxAniso, 22, 22));
  const cabinWoodTex = trackTex(createCabinWoodTexture(maxAniso, 2, 1, '#614833', 707));
  const cabinFloorTex = trackTex(createCabinWoodTexture(maxAniso, 3, 2, '#4a3727', 719));
  const concTex = trackTex(createSovietConcreteTexture(maxAniso, 2, 1, '#7a7e7b', 733));
  const containerBlueTex = trackTex(createCorrugatedMetalTexture(maxAniso, '#3e5361', 745));
  const containerOliveTex = trackTex(createCorrugatedMetalTexture(maxAniso, '#4b5742', 751));
  const containerRustTex = trackTex(createCorrugatedMetalTexture(maxAniso, '#6b4132', 763));

  const matTerrain = trackMat(
    new THREE.MeshStandardMaterial({ map: forestTex, roughness: 0.96, metalness: 0.02 }),
  );
  const matGravel = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x5d5c55, roughness: 0.95, metalness: 0.02 }),
  );
  const matWood = trackMat(
    new THREE.MeshStandardMaterial({ map: cabinWoodTex, roughness: 0.88, metalness: 0.03 }),
  );
  const matWoodFloor = trackMat(
    new THREE.MeshStandardMaterial({ map: cabinFloorTex, roughness: 0.85, metalness: 0.03 }),
  );
  const matRoof = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x35393c, roughness: 0.72, metalness: 0.35 }),
  );
  const matConcrete = trackMat(
    new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.92, metalness: 0.04 }),
  );
  const matFencePost = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x454a4d, roughness: 0.55, metalness: 0.68 }),
  );
  const matFenceMesh = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x596266,
      roughness: 0.6,
      metalness: 0.65,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    }),
  );
  const matBark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x473526, roughness: 0.95, metalness: 0.02 }),
  );
  const matPineNeedles = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88, metalness: 0.02 }),
  );
  const matRock = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x595e5c, roughness: 0.94, metalness: 0.04 }),
  );
  const matContBlue = trackMat(
    new THREE.MeshStandardMaterial({ map: containerBlueTex, roughness: 0.65, metalness: 0.45 }),
  );
  const matContOlive = trackMat(
    new THREE.MeshStandardMaterial({ map: containerOliveTex, roughness: 0.68, metalness: 0.42 }),
  );
  const matContRust = trackMat(
    new THREE.MeshStandardMaterial({ map: containerRustTex, roughness: 0.72, metalness: 0.38 }),
  );

  // === 1. Rolling Outdoor Forest Terrain (180m x 180m fading cleanly into fog) ===
  const terrainGeo = trackGeo(new THREE.PlaneGeometry(180, 180, 64, 64));
  terrainGeo.rotateX(-Math.PI * 0.5);
  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    posAttr.setY(i, sampleForestTerrainY(vx, vz));
  }
  terrainGeo.computeVertexNormals();
  const terrainMesh = new THREE.Mesh(terrainGeo, matTerrain);
  terrainMesh.receiveShadow = !isSoftwareGl;
  terrainMesh.userData.surfaceMaterial = 'grass';
  sceneGroup.add(terrainMesh);
  raycastMeshes.push(terrainMesh);

  // Compound compacted gravel yard pad (offset +0.025m to prevent Z-fighting)
  const yardPad = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(50, 46)), matGravel);
  yardPad.rotation.x = -Math.PI * 0.5;
  yardPad.position.y = 0.025;
  yardPad.receiveShadow = !isSoftwareGl;
  yardPad.userData.surfaceMaterial = 'gravel';
  sceneGroup.add(yardPad);
  raycastMeshes.push(yardPad);
  physics.addSurfaceZone({ minX: -25, maxX: 25, minZ: -23, maxZ: 23, surface: 'gravel' });

  const addSolidBox = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = !isSoftwareGl && h > 0.35;
    mesh.receiveShadow = !isSoftwareGl;
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

  // === 2. Compound Perimeter Concrete Curb & Chain-Link Fence (InstancedMesh posts + 4 breached gates) ===
  const fencePostCoords: Array<[number, number]> = [];
  const addFenceSegment = (x1: number, z1: number, x2: number, z2: number): void => {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const cx = (x1 + x2) * 0.5;
    const cz = (z1 + z2) * 0.5;
    const alongX = Math.abs(dx) >= Math.abs(dz);

    // Concrete jersey barrier base (0.95m high, solid cover)
    addSolidBox(
      cx,
      0.48,
      cz,
      alongX ? len : 0.45,
      0.96,
      alongX ? 0.45 : len,
      matConcrete,
      'concrete',
    );
    // Upper chain-link visual panel (blocks movement to 2.9m, bullets & vision pass through!)
    const panel = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(alongX ? len : 0.06, 1.95, alongX ? 0.06 : len)),
      matFenceMesh,
    );
    panel.position.set(cx, 1.92, cz);
    sceneGroup.add(panel);
    physics.addBox({
      minX: cx - (alongX ? len * 0.5 : 0.14),
      maxX: cx + (alongX ? len * 0.5 : 0.14),
      minY: 0.96,
      maxY: 2.95,
      minZ: cz - (alongX ? 0.14 : len * 0.5),
      maxZ: cz + (alongX ? 0.14 : len * 0.5),
      surface: 'metal',
      blocksMovement: true,
    });

    const posts = Math.max(2, Math.round(len / 3.4));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      fencePostCoords.push([x1 + dx * t, z1 + dz * t]);
    }
  };

  // North & South perimeter with 6m wide central vehicle gates
  addFenceSegment(-26, -24, -3.5, -24);
  addFenceSegment(3.5, -24, 26, -24);
  addFenceSegment(-26, 24, -3.5, 24);
  addFenceSegment(3.5, 24, 26, 24);
  // West & East perimeter with 5m flank breaches
  addFenceSegment(-26, -24, -26, -3.0);
  addFenceSegment(-26, 3.0, -26, 24);
  addFenceSegment(26, -24, 26, -3.0);
  addFenceSegment(26, 3.0, 26, 24);

  const dummy = new THREE.Object3D();
  const postGeo = trackGeo(new THREE.CylinderGeometry(0.06, 0.06, 3.05, 6));
  const postInst = new THREE.InstancedMesh(postGeo, matFencePost, fencePostCoords.length);
  fencePostCoords.forEach(([px, pz], i) => {
    dummy.position.set(px, 1.52, pz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    postInst.setMatrixAt(i, dummy.matrix);
  });
  postInst.instanceMatrix.needsUpdate = true;
  postInst.computeBoundingSphere();
  sceneGroup.add(postInst);

  // === 3. Three Enterable Wooden Cabins / Command Shed ===
  const buildEnterableCabin = (
    cx: number,
    cz: number,
    w: number,
    d: number,
    doorSideA: 'south' | 'north' | 'east' | 'west',
    doorSideB: 'south' | 'north' | 'east' | 'west',
  ): void => {
    const h = 3.1;
    const t = 0.28;
    const doorW = 2.0;
    const doorH = 2.35;

    // Raised timber floorboard deck (0.14m step-up)
    addSolidBox(cx, 0.07, cz, w, 0.14, d, matWoodFloor, 'wood');
    physics.addInteriorZone({
      minX: cx - w * 0.5,
      maxX: cx + w * 0.5,
      minY: 0,
      maxY: h + 0.4,
      minZ: cz - d * 0.5,
      maxZ: cz + d * 0.5,
      material: 'wood',
    });

    const buildWallSide = (side: 'north' | 'south' | 'east' | 'west', hasDoor: boolean): void => {
      const isNS = side === 'north' || side === 'south';
      const span = isNS ? w : d;
      const fixed =
        side === 'north'
          ? cz - d * 0.5
          : side === 'south'
            ? cz + d * 0.5
            : side === 'west'
              ? cx - w * 0.5
              : cx + w * 0.5;

      if (hasDoor) {
        const seg = (span - doorW) * 0.5;
        const headerH = h - doorH;
        if (isNS) {
          addSolidBox(cx - (doorW + seg) * 0.5, 0.14 + h * 0.5, fixed, seg, h, t, matWood, 'wood');
          addSolidBox(cx + (doorW + seg) * 0.5, 0.14 + h * 0.5, fixed, seg, h, t, matWood, 'wood');
          addSolidBox(cx, 0.14 + doorH + headerH * 0.5, fixed, doorW, headerH, t, matWood, 'wood');
        } else {
          addSolidBox(fixed, 0.14 + h * 0.5, cz - (doorW + seg) * 0.5, t, h, seg, matWood, 'wood');
          addSolidBox(fixed, 0.14 + h * 0.5, cz + (doorW + seg) * 0.5, t, h, seg, matWood, 'wood');
          addSolidBox(fixed, 0.14 + doorH + headerH * 0.5, cz, t, headerH, doorW, matWood, 'wood');
        }
      } else {
        // Windowed timber wall (sill 1.05m + header 0.85m + side frames)
        const winW = 2.0;
        const sideSeg = Math.max(0.5, (span - winW) * 0.5);
        if (isNS) {
          addSolidBox(cx, 0.14 + 0.52, fixed, span, 1.04, t, matWood, 'wood');
          addSolidBox(cx, 0.14 + h - 0.42, fixed, span, 0.84, t, matWood, 'wood');
          addSolidBox(cx - (winW + sideSeg) * 0.5, 0.14 + 1.65, fixed, sideSeg, 1.24, t, matWood, 'wood');
          addSolidBox(cx + (winW + sideSeg) * 0.5, 0.14 + 1.65, fixed, sideSeg, 1.24, t, matWood, 'wood');
        } else {
          addSolidBox(fixed, 0.14 + 0.52, cz, t, 1.04, span, matWood, 'wood');
          addSolidBox(fixed, 0.14 + h - 0.42, cz, t, 0.84, span, matWood, 'wood');
          addSolidBox(fixed, 0.14 + 1.65, cz - (winW + sideSeg) * 0.5, t, 1.24, sideSeg, matWood, 'wood');
          addSolidBox(fixed, 0.14 + 1.65, cz + (winW + sideSeg) * 0.5, t, 1.24, sideSeg, matWood, 'wood');
        }
      }
    };

    buildWallSide('north', doorSideA === 'north' || doorSideB === 'north');
    buildWallSide('south', doorSideA === 'south' || doorSideB === 'south');
    buildWallSide('east', doorSideA === 'east' || doorSideB === 'east');
    buildWallSide('west', doorSideA === 'west' || doorSideB === 'west');

    // Roof slab + pitched corrugated metal overhang
    addSolidBox(cx, 0.14 + h + 0.12, cz, w + 0.8, 0.24, d + 0.8, matRoof, 'metal');
    const ridge = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.1, Math.min(w, d) * 0.62, 1.2, 4)),
      matRoof,
    );
    ridge.position.set(cx, 0.14 + h + 0.82, cz);
    ridge.rotation.y = Math.PI * 0.25;
    ridge.scale.set(w / Math.min(w, d), 1, d / Math.min(w, d));
    ridge.castShadow = !isSoftwareGl;
    sceneGroup.add(ridge);

    // Interior tactical worktable / crate cover (off-center so walkways stay clear)
    addSolidBox(cx + w * 0.24, 0.56, cz - d * 0.22, 1.4, 0.84, 0.8, matWood, 'wood');
  };

  // Cabin 1: North-West Timber Cabin
  buildEnterableCabin(-15.5, -14.0, 9.2, 7.2, 'south', 'east');
  // Cabin 2: North-East Command Shed
  buildEnterableCabin(15.5, -13.5, 9.0, 7.0, 'south', 'west');
  // Cabin 3: South-West Bunkhouse
  buildEnterableCabin(-15.0, 13.5, 9.2, 7.2, 'north', 'east');

  // === 4. South-East Timber Watchtower (Elevated Overlook Platform + Walkable Ramp) ===
  const twX = 14.5;
  const twZ = 13.5;
  const twH = 3.1;
  // 4 corner timber legs
  for (const sx of [-2.1, 2.1]) {
    for (const sz of [-2.1, 2.1]) {
      addSolidBox(twX + sx, twH * 0.5, twZ + sz, 0.28, twH, 0.28, matWood, 'wood');
    }
  }
  // Overlook deck slab
  addSolidBox(twX, twH, twZ, 4.8, 0.24, 4.8, matWoodFloor, 'wood');
  // Waist-high parapet railings (open on North entry side for ramp)
  addSolidBox(twX, twH + 0.62, twZ + 2.25, 4.8, 1.0, 0.18, matWood, 'wood');
  addSolidBox(twX - 2.25, twH + 0.62, twZ, 0.18, 1.0, 4.5, matWood, 'wood');
  addSolidBox(twX + 2.25, twH + 0.62, twZ, 0.18, 1.0, 4.5, matWood, 'wood');
  // Roof posts & canopy
  for (const sx of [-2.1, 2.1]) {
    for (const sz of [-2.1, 2.1]) {
      addSolidBox(twX + sx, twH + 1.5, twZ + sz, 0.18, 2.8, 0.18, matWood, 'wood');
    }
  }
  addSolidBox(twX, twH + 2.95, twZ, 5.4, 0.2, 5.4, matRoof, 'metal');

  // Walkable wooden ramp up the North side of the Watchtower
  physics.addRamp({
    minX: twX - 1.1,
    maxX: twX + 1.1,
    minZ: twZ - 8.2,
    maxZ: twZ - 2.2,
    baseY: 0,
    topY: twH + 0.12,
    riseAxis: '+z',
    surface: 'wood',
  });
  const rampLen = Math.hypot(6.0, twH + 0.12);
  const rampMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.2, 0.18, rampLen)), matWoodFloor);
  rampMesh.position.set(twX, (twH + 0.12) * 0.5 - 0.06, twZ - 5.2);
  rampMesh.rotation.x = -Math.atan2(twH + 0.12, 6.0);
  rampMesh.receiveShadow = !isSoftwareGl;
  rampMesh.userData.surfaceMaterial = 'wood';
  sceneGroup.add(rampMesh);
  raycastMeshes.push(rampMesh);

  // === 5. Corrugated Shipping Containers & Tactical Yard Cover ===
  addSolidBox(-5.2, 1.32, -4.5, 6.0, 2.64, 2.5, matContBlue, 'metal');
  addSolidBox(5.8, 1.32, -1.8, 2.5, 2.64, 6.0, matContOlive, 'metal');
  addSolidBox(-2.8, 1.32, 6.2, 6.0, 2.64, 2.5, matContRust, 'metal');
  addSolidBox(1.5, 0.56, -13.2, 3.2, 1.12, 0.85, matConcrete, 'concrete');
  addSolidBox(-1.5, 0.56, 13.8, 3.2, 1.12, 0.85, matConcrete, 'concrete');

  // === 6. InstancedMesh Multi-Part Pine Forest (185 trees = 4 draw calls total!) ===
  const rand = seededRand(2026);
  const treeSpots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }> = [];
  const isClearForTree = (tx: number, tz: number): boolean => {
    // Keep inside compound clear except a few outer corners
    if (Math.abs(tx) < 28.0 && Math.abs(tz) < 26.0) return false;
    // Keep gate approaches clear for flanking lanes
    if (Math.abs(tx) < 5.5 && Math.abs(tz) < 36.0) return false;
    if (Math.abs(tz) < 5.0 && Math.abs(tx) < 36.0) return false;
    return true;
  };

  for (let attempt = 0; attempt < 900 && treeSpots.length < 185; attempt++) {
    const angle = rand() * Math.PI * 2;
    const dist = 28.5 + Math.pow(rand(), 0.72) * 48.0;
    const tx = Math.cos(angle) * dist;
    const tz = Math.sin(angle) * dist;
    if (!isClearForTree(tx, tz)) continue;
    if (treeSpots.some((s) => (s.x - tx) ** 2 + (s.z - tz) ** 2 < 14.5)) continue;

    const ty = sampleForestTerrainY(tx, tz);
    const scale = 0.85 + rand() * 0.38;
    const tint = new THREE.Color().setHSL(
      0.30 + (rand() - 0.5) * 0.05,
      0.30 + rand() * 0.14,
      0.19 + rand() * 0.09,
    );
    treeSpots.push({ x: tx, y: ty, z: tz, scale, yaw: rand() * Math.PI * 2, tint });
  }

  // Composite 4-part pine tree: trunk + 3 layered conical needle tiers (bottom-center grounded)
  const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.30, 3.2, 7));
  trunkGeo.translate(0, 1.6, 0);
  const tier1Geo = trackGeo(new THREE.ConeGeometry(2.35, 4.2, 8));
  tier1Geo.translate(0, 4.1, 0);
  const tier2Geo = trackGeo(new THREE.ConeGeometry(1.85, 3.6, 8));
  tier2Geo.translate(0, 6.4, 0);
  const tier3Geo = trackGeo(new THREE.ConeGeometry(1.2, 2.8, 8));
  tier3Geo.translate(0, 8.4, 0);

  const count = treeSpots.length;
  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBark, count);
  const tier1Inst = new THREE.InstancedMesh(tier1Geo, matPineNeedles, count);
  const tier2Inst = new THREE.InstancedMesh(tier2Geo, matPineNeedles, count);
  const tier3Inst = new THREE.InstancedMesh(tier3Geo, matPineNeedles, count);

  trunkInst.castShadow = !isSoftwareGl;
  tier1Inst.castShadow = !isSoftwareGl;
  tier2Inst.castShadow = !isSoftwareGl;

  treeSpots.forEach((t, i) => {
    dummy.position.set(t.x, t.y - 0.08, t.z);
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

    // Add trunk collision box for trees inside the playable bounds
    if (Math.abs(t.x) <= 42 && Math.abs(t.z) <= 42) {
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

  // InstancedMesh mossy boulders scattered around outer forest lanes for natural cover
  const rockGeo = trackGeo(new THREE.DodecahedronGeometry(1.1, 0));
  const rockSpots: Array<[number, number, number]> = [
    [-32, 0, -14],
    [-33, 0, 12],
    [32, 0, -12],
    [33, 0, 14],
    [-12, 0, -32],
    [14, 0, -31],
    [-14, 0, 32],
    [12, 0, 31],
  ];
  const rockInst = new THREE.InstancedMesh(rockGeo, matRock, rockSpots.length);
  rockSpots.forEach(([rx, , rz], i) => {
    const ry = sampleForestTerrainY(rx, rz);
    dummy.position.set(rx, ry + 0.55, rz);
    dummy.rotation.set(i * 0.4, i * 1.1, 0);
    dummy.scale.set(1.3, 0.85, 1.1);
    dummy.updateMatrix();
    rockInst.setMatrixAt(i, dummy.matrix);
    physics.addBox({
      minX: rx - 1.2,
      maxX: rx + 1.2,
      minY: ry,
      maxY: ry + 1.45,
      minZ: rz - 1.1,
      maxZ: rz + 1.1,
      surface: 'concrete',
      blocksMovement: true,
    });
  });
  rockInst.instanceMatrix.needsUpdate = true;
  rockInst.computeBoundingSphere();
  rockInst.userData.surfaceMaterial = 'concrete';
  sceneGroup.add(rockInst);
  raycastMeshes.push(rockInst);

  // === 7. Outdoor + Indoor NavGraph (26 nodes linking cabins, yard, watchtower, & outer forest) ===
  const rawNodes: NavNode[] = [
    // Central compound yard & container lanes
    { id: 'y_center', position: [0, 0, 0.5], zoneId: 'default', neighbors: ['y_n', 'y_s', 'y_w', 'y_e'], isCover: true, coverNormal: [0, 1] },
    { id: 'y_n', position: [0, 0, -10.0], zoneId: 'default', neighbors: ['y_center', 'gate_n', 'cab_nw_e', 'cab_ne_w'], isCover: true, coverNormal: [0, 1] },
    { id: 'y_s', position: [0, 0, 11.2], zoneId: 'default', neighbors: ['y_center', 'gate_s', 'cab_sw_e', 'tw_base'], isCover: true, coverNormal: [0, -1] },
    { id: 'y_w', position: [-10.5, 0, 0], zoneId: 'default', neighbors: ['y_center', 'gate_w', 'cab_nw_s', 'cab_sw_n'], isCover: true, coverNormal: [1, 0] },
    { id: 'y_e', position: [11.0, 0, 0], zoneId: 'default', neighbors: ['y_center', 'gate_e', 'cab_ne_s', 'tw_base'], isCover: true, coverNormal: [-1, 0] },

    // Enterable Cabins (exterior thresholds + interior nodes)
    { id: 'cab_nw_s', position: [-15.5, 0, -8.8], zoneId: 'default', neighbors: ['y_w', 'cab_nw_in'] },
    { id: 'cab_nw_e', position: [-9.2, 0, -14.0], zoneId: 'default', neighbors: ['y_n', 'cab_nw_in'] },
    { id: 'cab_nw_in', position: [-15.5, 0.14, -14.0], zoneId: 'default', neighbors: ['cab_nw_s', 'cab_nw_e'], isCover: true, coverNormal: [1, 1] },

    { id: 'cab_ne_s', position: [15.5, 0, -8.4], zoneId: 'default', neighbors: ['y_e', 'cab_ne_in'] },
    { id: 'cab_ne_w', position: [9.2, 0, -13.5], zoneId: 'default', neighbors: ['y_n', 'cab_ne_in'] },
    { id: 'cab_ne_in', position: [15.5, 0.14, -13.5], zoneId: 'default', neighbors: ['cab_ne_s', 'cab_ne_w'], isCover: true, coverNormal: [-1, 1] },

    { id: 'cab_sw_n', position: [-15.0, 0, 8.2], zoneId: 'default', neighbors: ['y_w', 'cab_sw_in'] },
    { id: 'cab_sw_e', position: [-8.8, 0, 13.5], zoneId: 'default', neighbors: ['y_s', 'cab_sw_in'] },
    { id: 'cab_sw_in', position: [-15.0, 0.14, 13.5], zoneId: 'default', neighbors: ['cab_sw_n', 'cab_sw_e'], isCover: true, coverNormal: [1, -1] },

    // Watchtower approach & overlook deck
    { id: 'tw_base', position: [14.5, 0, 4.2], zoneId: 'default', neighbors: ['y_e', 'y_s', 'tw_top'] },
    { id: 'tw_top', position: [14.5, twH + 0.12, 13.5], zoneId: 'default', neighbors: ['tw_base'], isCover: true, coverNormal: [-1, -1] },

    // 4 Breached Compound Gates
    { id: 'gate_n', position: [0, 0, -24.0], zoneId: 'default', neighbors: ['y_n', 'for_n'] },
    { id: 'gate_s', position: [0, 0, 24.0], zoneId: 'default', neighbors: ['y_s', 'for_s'] },
    { id: 'gate_w', position: [-26.0, 0, 0], zoneId: 'default', neighbors: ['y_w', 'for_w'] },
    { id: 'gate_e', position: [26.0, 0, 0], zoneId: 'default', neighbors: ['y_e', 'for_e'] },

    // Outer Forest Perimeter Flanking Ring
    { id: 'for_n', position: [0, sampleForestTerrainY(0, -32), -32], zoneId: 'default', neighbors: ['gate_n', 'for_nw', 'for_ne'], isCover: true, coverNormal: [0, 1] },
    { id: 'for_s', position: [0, sampleForestTerrainY(0, 32), 32], zoneId: 'default', neighbors: ['gate_s', 'for_sw', 'for_se'], isCover: true, coverNormal: [0, -1] },
    { id: 'for_w', position: [-33, sampleForestTerrainY(-33, 0), 0], zoneId: 'default', neighbors: ['gate_w', 'for_nw', 'for_sw'], isCover: true, coverNormal: [1, 0] },
    { id: 'for_e', position: [33, sampleForestTerrainY(33, 0), 0], zoneId: 'default', neighbors: ['gate_e', 'for_ne', 'for_se'], isCover: true, coverNormal: [-1, 0] },
    { id: 'for_nw', position: [-31, sampleForestTerrainY(-31, -29), -29], zoneId: 'default', neighbors: ['for_n', 'for_w'] },
    { id: 'for_ne', position: [31, sampleForestTerrainY(31, -29), -29], zoneId: 'default', neighbors: ['for_n', 'for_e'] },
    { id: 'for_sw', position: [-31, sampleForestTerrainY(-31, 29), 29], zoneId: 'default', neighbors: ['for_s', 'for_w'] },
    { id: 'for_se', position: [31, sampleForestTerrainY(31, 29), 29], zoneId: 'default', neighbors: ['for_s', 'for_e'] },
  ];

  const teamA: SpawnPoint[] = [
    { position: [0, 0, -21.2], yaw: Math.PI },
    { position: [-15.5, 0.14, -14.0], yaw: Math.PI * 0.85 },
    { position: [15.5, 0.14, -13.5], yaw: -Math.PI * 0.85 },
    { position: [-7.5, 0, -20.5], yaw: Math.PI },
    { position: [7.5, 0, -20.5], yaw: Math.PI },
    { position: [0, sampleForestTerrainY(0, -31), -31], yaw: Math.PI },
  ];
  const teamB: SpawnPoint[] = [
    { position: [0, 0, 21.2], yaw: 0 },
    { position: [-15.0, 0.14, 13.5], yaw: Math.PI * 0.15 },
    { position: [14.5, twH + 0.12, 13.5], yaw: -Math.PI * 0.25 },
    { position: [-7.5, 0, 20.5], yaw: 0 },
    { position: [7.5, 0, 20.5], yaw: 0 },
    { position: [0, sampleForestTerrainY(0, 31), 31], yaw: 0 },
  ];
  const ffa: SpawnPoint[] = [
    ...teamA,
    ...teamB,
    { position: [-21.5, 0, 0], yaw: -Math.PI * 0.5 },
    { position: [21.5, 0, 0], yaw: Math.PI * 0.5 },
  ];

  physics.setRaycastMeshes(raycastMeshes);

  return {
    id: 'timberline_compound',
    name: 'Timberline Compound',
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
    terrainHeightAt: sampleForestTerrainY,
    interactables: [],
    lightingPreset: LIGHTING_PRESET,
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

export const TIMBERLINE_COMPOUND_MAP: IMapDefinition = {
  id: 'timberline_compound',
  name: 'Timberline Compound',
  subtitle: 'Overcast Forest & Enterable Cabins',
  description:
    'Fenced logging compound ringed by dense instanced pine woods, featuring three enterable timber cabins, a climbable watchtower overlook, and corrugated yard cover.',
  mode: 'battle',
  status: 'playable',
  environmentTags: ['Outdoor & Indoor', 'Mid-Long Range', 'Pine Forest'],
  accentHex: '#38bdf8',
  previewStyle: 'forest_compound',
  build: buildTimberlineCompound,
};

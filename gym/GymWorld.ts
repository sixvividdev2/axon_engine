import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GunsmithBench } from '../arena/GunsmithBench';
import { BodycamPhysicsWorld, BodycamSurfaceMaterial } from '../bodycam-sdk';
import { PenetrableSurfaceSystem } from '../doors/PenetrableSurfaceSystem';
import { createGymTextures, createStencilSignTexture, GymTextureSet } from './GymTextures';

export type GymZoneId =
  | 'spawn'
  | 'gunsmith'
  | 'vault_course'
  | 'stairs'
  | 'cqb_tunnel'
  | 'hdr_darkroom'
  | 'surfaces'
  | 'range';

export interface GymZonePreset {
  id: GymZoneId;
  label: string;
  position: [number, number, number];
  yaw: number;
  pitch: number;
}

export const GYM_ZONE_PRESETS: GymZonePreset[] = [
  { id: 'spawn', label: 'Central Courtyard', position: [0, 0, 16.4], yaw: 0, pitch: 0 },
  { id: 'gunsmith', label: 'Gunsmithing Bench', position: [2.75, 0, 17.05], yaw: -0.42, pitch: -0.22 },
  { id: 'vault_course', label: 'Vault & Mantle Bay', position: [0, 0, 15.6], yaw: 0, pitch: 0 },
  { id: 'stairs', label: 'Stairs & Ramps', position: [-9.2, 0, 11.2], yaw: 0.12, pitch: -0.04 },
  { id: 'cqb_tunnel', label: 'CQB & Crouch Tunnel', position: [10.0, 0, 11.8], yaw: -0.15, pitch: 0 },
  { id: 'hdr_darkroom', label: 'HDR Darkroom Bay', position: [-10.8, 0, -14.8], yaw: Math.PI, pitch: 0.02 },
  { id: 'surfaces', label: 'Acoustic Floor Strips', position: [-8.2, 0, 5.5], yaw: -Math.PI * 0.5, pitch: -0.25 },
  { id: 'range', label: 'Ballistics Range', position: [11.0, 0, -3.5], yaw: 0, pitch: 0 },
];

export interface ReactiveSteelTarget {
  id: string;
  label: string;
  distanceLabel: string;
  pivot: THREE.Group;
  plateMesh: THREE.Mesh;
  hitAngle: number;
  hitAngVel: number;
  hitFlashTimer: number;
  baseMat: THREE.MeshStandardMaterial;
}

export interface PaperShootingTarget {
  id: string;
  label: string;
  distanceLabel: string;
  mesh: THREE.Mesh;
}

export interface GymWorldHandle {
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  steelTargets: ReactiveSteelTarget[];
  paperTargets: PaperShootingTarget[];
  gunsmithBench: GunsmithBench;
  penetrableSurfaces: PenetrableSurfaceSystem;
  shatterBreakable: (
    object: THREE.Object3D,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ) => boolean;
  updateDynamicTargets: (dt: number) => void;
  dispose: () => void;
}

/**
 * Builds the atmospheric overcast brutalist concrete & industrial Bodycam Calibration Gym:
 *  - Zone 1 (West): 8-step 0.20m staircase -> 1.60m mezzanine + drop-off, 0.18/0.25/0.30m curbs, 18° & 24° ramps
 *  - Zone 2 (East): Narrow CQB hallway, tight 0.98m doorframes, 1.22m-clearance low crouch tunnel
 *  - Zone 3 (North-West): Pitch-black concrete darkroom opening straight onto blinding sunlit exterior bay
 *  - Zone 4 (Center): Labeled Concrete, Wood, Metal Grate, Water Puddle, Gravel acoustic floor strips
 *  - Zone 5 (North-East): 10m / 20m / 35m Ballistics Range with hinged AR500 steel & paper bullseye targets
 */
export function buildGymWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): GymWorldHandle {
  const physics = new BodycamPhysicsWorld();
  physics.baseFloorY = 0;
  physics.boundsMinX = -25.2;
  physics.boundsMaxX = 25.2;
  physics.boundsMinZ = -41.0;
  physics.boundsMaxZ = 21.0;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const textures: GymTextureSet = createGymTextures(maxAniso);
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const steelTargets: ReactiveSteelTarget[] = [];
  const paperTargets: PaperShootingTarget[] = [];
  const penetrableSurfaces = new PenetrableSurfaceSystem(scene, { isSoftwareGl });

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMats.push(m);
    return m;
  };

  // === Atmosphere, Overcast Brutalist Sky & IBL ===
  scene.background = new THREE.Color(0x9ca7af);
  scene.fog = new THREE.FogExp2(0x95a0a8, 0.0115);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.62;
  pmrem.dispose();

  // Overcast cool skylight + warm architectural sun shaft (creating strong HDR exposure contrast!)
  const hemiLight = new THREE.HemisphereLight(0xb8c7d4, 0x3b3e3d, 0.85);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff1dc, 3.1);
  sunLight.position.set(16, 28, 12);
  if (!isSoftwareGl) {
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 2;
    sunLight.shadow.camera.far = 95;
    sunLight.shadow.camera.left = -32;
    sunLight.shadow.camera.right = 32;
    sunLight.shadow.camera.top = 34;
    sunLight.shadow.camera.bottom = -44;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.025;
  }
  scene.add(sunLight);

  // Secondary blinding sunlit bay booster (shines directly into the HDR exterior bay outside the darkroom)
  const baySunBounce = new THREE.SpotLight(0xfff5e4, 48, 24, Math.PI * 0.42, 0.35, 1.35);
  baySunBounce.position.set(-10.8, 9.5, -2.5);
  baySunBounce.target.position.set(-10.8, 0.0, -7.2);
  scene.add(baySunBounce);
  scene.add(baySunBounce.target);

  // Subtle dim red emergency exit bulb inside the pitch-black darkroom
  const exitLight = new THREE.PointLight(0xff2c1f, 0.55, 6.2, 2.0);
  exitLight.position.set(-10.8, 2.75, -10.8);
  scene.add(exitLight);

  // Subtle range overhead worklamp
  const rangeLight = new THREE.PointLight(0xd9e8f5, 4.5, 22, 1.6);
  rangeLight.position.set(12.0, 4.4, -7.5);
  scene.add(rangeLight);

  // === Shared PBR Materials ===
  const concreteFloorTex = textures.concreteAlbedo.clone();
  concreteFloorTex.needsUpdate = true;
  concreteFloorTex.repeat.set(18, 22);
  ownedTextures.push(concreteFloorTex);

  const concreteFloorRough = textures.concreteRoughness.clone();
  concreteFloorRough.needsUpdate = true;
  concreteFloorRough.repeat.set(18, 22);
  ownedTextures.push(concreteFloorRough);

  const concreteFloorMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: concreteFloorTex,
      roughnessMap: concreteFloorRough,
      roughness: 0.86,
      metalness: 0.05,
    }),
  );

  const concreteWallMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.concreteAlbedo,
      roughnessMap: textures.concreteRoughness,
      roughness: 0.84,
      metalness: 0.06,
      color: 0xd9dcd9,
    }),
  );

  const darkConcreteMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.concreteDarkAlbedo,
      roughness: 0.94,
      metalness: 0.02,
      color: 0x26292c,
    }),
  );

  const brightSunApronMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.concreteAlbedo,
      color: 0xf6f3ea,
      emissive: new THREE.Color(0xfff4dd),
      emissiveIntensity: 0.95, // Deliberate HDR sunlit bounce surface (>1.0 HDR luma)
      roughness: 0.52,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );

  const steelBeamMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x353c42,
      metalness: 0.78,
      roughness: 0.42,
    }),
  );

  const steelTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x353c42,
      metalness: 0.78,
      roughness: 0.42,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );

  const yellowRailMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd4a42c,
      metalness: 0.25,
      roughness: 0.48,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );

  const hazardMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.hazardAlbedo,
      roughness: 0.62,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );

  const woodMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.woodAlbedo,
      roughnessMap: textures.woodRoughness,
      roughness: 0.76,
      metalness: 0.04,
    }),
  );

  const metalGrateMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.metalGrateAlbedo,
      roughnessMap: textures.metalGrateRoughness,
      roughness: 0.42,
      metalness: 0.82,
    }),
  );

  const gravelMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.gravelAlbedo,
      roughness: 0.96,
      metalness: 0.02,
    }),
  );

  const puddleMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: textures.puddleAlbedo,
      roughnessMap: textures.puddleRoughness,
      roughness: 0.08,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    }),
  );

  // Helper to place a solid architectural box with matching physics AABB + raycast registration
  const addSolidBox = (
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial = 'concrete',
    registerPhysics = true,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(sx, sy, sz)), mat);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    scene.add(mesh);
    raycastMeshes.push(mesh);

    if (registerPhysics) {
      physics.addBox({
        minX: cx - sx * 0.5,
        maxX: cx + sx * 0.5,
        minY: cy - sy * 0.5,
        maxY: cy + sy * 0.5,
        minZ: cz - sz * 0.5,
        maxZ: cz + sz * 0.5,
        surface,
      });
    }
    return mesh;
  };

  // Helper to place an industrial stenciled sign plaque
  const addSign = (
    title: string,
    subtitle: string,
    x: number,
    y: number,
    z: number,
    rotY = 0,
    width = 2.4,
    height = 0.88,
    accent = '#d4a64a',
  ) => {
    const tex = createStencilSignTexture(title, subtitle, accent, '#212529', maxAniso);
    ownedTextures.push(tex);
    const mat = trackMat(
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.55,
        metalness: 0.2,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }),
    );
    const mesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(width, height)), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    scene.add(mesh);
  };

  // Helper to place a flush ground strip plaque (+4mm above floor slab + polygonOffset)
  const addFloorPlaque = (
    title: string,
    subtitle: string,
    x: number,
    z: number,
    accent = '#d4a64a',
    width = 2.5,
  ) => {
    const tex = createStencilSignTexture(title, subtitle, accent, '#1d2124', maxAniso);
    ownedTextures.push(tex);
    const mat = trackMat(
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.65,
        metalness: 0.1,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      }),
    );
    const mesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(width, 0.88)), mat);
    mesh.position.set(x, 0.005, z);
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
  };

  // === Main Concrete Slab & Brutalist Perimeter Blast Walls ===
  const floor = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(54, 68)), concreteFloorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -10);
  floor.receiveShadow = !isSoftwareGl;
  floor.userData.surfaceMaterial = 'concrete';
  scene.add(floor);
  raycastMeshes.push(floor);

  // Perimeter blast walls (non-overlapping corner joints)
  addSolidBox(0, 2.8, 21.5, 52.4, 5.6, 0.8, concreteWallMat, 'concrete'); // South wall (x: -26.2..26.2, z: 21.1..21.9)
  addSolidBox(0, 3.2, -41.5, 52.4, 6.4, 0.8, concreteWallMat, 'concrete'); // North range backstop (x: -26.2..26.2, z: -41.9..-41.1)
  addSolidBox(-25.8, 2.8, -10, 0.8, 5.6, 62.2, concreteWallMat, 'concrete'); // West wall (z: -41.1..21.1)
  addSolidBox(25.8, 2.8, -10, 0.8, 5.6, 62.2, concreteWallMat, 'concrete'); // East wall (z: -41.1..21.1)

  // Perimeter steel buttresses (inset 4cm below wall cap so tops are never coplanar)
  for (let z = -36; z <= 18; z += 9) {
    addSolidBox(-25.05, 2.78, z, 0.7, 5.56, 0.7, steelBeamMat, 'metal');
    addSolidBox(25.05, 2.78, z, 0.7, 5.56, 0.7, steelBeamMat, 'metal');
  }
  const distantMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x5c6469, roughness: 0.92, metalness: 0.05 }),
  );
  const skylineSpecs: [number, number, number, number, number, number][] = [
    [-46, 11, -55, 18, 22, 16],
    [-18, 15, -66, 22, 30, 14],
    [16, 13, -62, 20, 26, 15],
    [48, 10, -48, 16, 20, 18],
    [-52, 9, -8, 14, 18, 28],
    [52, 12, 4, 16, 24, 24],
  ];
  for (const [x, y, z, sx, sy, sz] of skylineSpecs) {
    const b = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(sx, sy, sz)), distantMat);
    b.position.set(x, y, z);
    scene.add(b);
  }

  // Facility welcome banner on south-facing gantry beam
  addSign('BODYCAM CALIBRATION GYM', 'PORTABLE SDK TESTBED · 6 ZONES', 0, 4.1, -9.5, 0, 5.4, 1.35, '#e0a938');

  // =========================================================================
  // ZONE 6 (SOUTH COURTYARD): TACTICAL VAULT & MANTLE TEST COURSE
  // =========================================================================
  // 1) Concrete Jersey Barrier (0.90m high, 0.42m thin) -> VAULT_OVER
  addSolidBox(-6.6, 0.45, 12.0, 2.6, 0.90, 0.42, concreteWallMat, 'concrete');
  // Base plinth (+0.02m wider on X & deeper on Z than concrete wall; bottom raised 1mm clear of floor slab)
  const jerseySkirt = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.62, 0.22, 0.62)),
    darkConcreteMat,
  );
  jerseySkirt.position.set(-6.6, 0.111, 12.0);
  jerseySkirt.castShadow = !isSoftwareGl;
  jerseySkirt.receiveShadow = !isSoftwareGl;
  scene.add(jerseySkirt);
  // Hazard stripe band offset outward by 3mm (0.003m) from each underlying concrete face
  const jerseyStripe = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.606, 0.07, 0.426)),
    hazardMat,
  );
  jerseyStripe.position.set(-6.6, 0.85, 12.0);
  scene.add(jerseyStripe);
  addFloorPlaque('JERSEY BARRIER 0.90M', 'SPACE: VAULT OVER', -6.6, 13.55, '#9ec488');

  // 2) Thick Concrete Block (0.95m high, 1.15m deep) -> CLIMB_ONTO
  addSolidBox(-2.6, 0.475, 11.7, 2.6, 0.95, 1.15, concreteWallMat, 'concrete');
  // Edge trim offset outward by 3mm (0.003m) on X, Y top, and Z front faces
  const blockEdge = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.606, 0.035, 0.083)),
    yellowRailMat,
  );
  blockEdge.position.set(-2.6, 0.9355, 12.2365);
  scene.add(blockEdge);
  addFloorPlaque('CONCRETE BLOCK 0.95M', 'SPACE: CLIMB ONTO', -2.6, 13.55, '#e0a938');

  // 3) Breakable-Glass Window Frame (0.92m sill, 1.12m clear height -> auto-crouch VAULT_OVER + glass shatter)
  const winX = 1.6;
  const winZ = 12.0;
  // Non-overlapping masonry layout: full-height side jambs + in-between sill & lintel
  addSolidBox(winX, 0.46, winZ, 1.30, 0.92, 0.36, concreteWallMat, 'concrete');
  addSolidBox(winX - 1.025, 1.35, winZ, 0.75, 2.70, 0.36, concreteWallMat, 'concrete');
  addSolidBox(winX + 1.025, 1.35, winZ, 0.75, 2.70, 0.36, concreteWallMat, 'concrete');
  addSolidBox(winX, 2.37, winZ, 1.30, 0.66, 0.36, concreteWallMat, 'concrete');
  // Visual steel window frame trim (non-overlapping corner joints, 3mm Z step between sill/head & jambs)
  const sillTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.32, 0.04, 0.406)), steelTrimMat);
  sillTrim.position.set(winX, 0.92, winZ);
  scene.add(sillTrim);
  const headTrim = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.32, 0.04, 0.406)), steelTrimMat);
  headTrim.position.set(winX, 2.04, winZ);
  scene.add(headTrim);
  const jambTrimL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.04, 1.08, 0.40)), steelTrimMat);
  jambTrimL.position.set(winX - 0.64, 1.48, winZ);
  scene.add(jambTrimL);
  const jambTrimR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.04, 1.08, 0.40)), steelTrimMat);
  jambTrimR.position.set(winX + 0.64, 1.48, winZ);
  scene.add(jambTrimR);

  // Tempered Breakable Glass Pane occupying the window opening
  const glassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb6d6de,
      roughness: 0.12,
      metalness: 0.25,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
    }),
  );
  const glassId = 'gym_vault_window_glass';
  const glassPane = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.24, 1.08, 0.035)), glassMat);
  glassPane.position.set(winX, 1.48, winZ);
  glassPane.userData.surfaceMaterial = 'glass';
  glassPane.userData.breakableGlass = true;
  glassPane.userData.breakableId = glassId;
  glassPane.userData.shattered = false;
  scene.add(glassPane);
  raycastMeshes.push(glassPane);
  physics.addBox({
    id: glassId,
    minX: winX - 0.63,
    maxX: winX + 0.63,
    minY: 0.93,
    maxY: 2.03,
    minZ: winZ - 0.04,
    maxZ: winZ + 0.04,
    surface: 'glass',
  });
  addSign('WINDOW BREACH', '0.92M SILL · 1.12M GAP · AUTO-CROUCH', winX, 2.38, winZ + 0.21, 0, 2.1, 0.56, '#7ec4cf');
  addFloorPlaque('BREAKABLE WINDOW', 'SPACE: CROUCH-VAULT', winX, 13.55, '#7ec4cf');

  // 4) 1.85m Shipping Container / Bunker Ledge -> HIGH_MANTLE (two-handed climb)
  const containerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3b4942,
      roughness: 0.64,
      metalness: 0.52,
      map: textures.concreteRoughness,
    }),
  );
  const contX = 6.2;
  const contZ = 11.2;
  addSolidBox(contX, 0.925, contZ, 3.4, 1.85, 2.2, containerMat, 'metal');
  // Corrugated steel vertical ribs along South face (visual depth)
  for (let rx = -1.45; rx <= 1.46; rx += 0.29) {
    const rib = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 1.66, 0.04)), steelBeamMat);
    rib.position.set(contX + rx, 0.92, contZ + 1.11);
    scene.add(rib);
  }
  const contLip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.406, 0.06, 0.08)), yellowRailMat);
  contLip.position.set(contX, 1.84, contZ + 1.093);
  scene.add(contLip);
  addSign('CONTAINER LEDGE 1.85M', 'TWO-HAND HIGH MANTLE', contX, 1.25, contZ + 1.15, 0, 2.4, 0.68, '#e06c38');
  addFloorPlaque('BUNKER LEDGE 1.85M', 'SPACE: HIGH MANTLE', contX, 13.55, '#e06c38');

  // =========================================================================
  // ZONE 1 (WEST WING): STAIRS, CURB STEP-UP GAUNTLET & SLOPED RAMPS
  // =========================================================================
  addSign('STEP-UP & LOCOMOTION BAY', '0.20M STAIRS · 0.25M CURBS · 18°/24° RAMPS', -14.2, 3.6, 12.8, 0, 4.4, 1.15, '#e0a938');

  // 8-Step Brutalist Staircase rising South -> North (z: +7.6 -> +4.72) to 1.60m mezzanine
  const numSteps = 8;
  const stepRise = 0.20;
  const stepTread = 0.36;
  const stairX = -11.4;
  const stairWidth = 2.6;
  const stairStartZ = 7.6;
  for (let i = 0; i < numSteps; i++) {
    const h = (i + 1) * stepRise;
    const zCenter = stairStartZ - i * stepTread - stepTread * 0.5;
    addSolidBox(stairX, h * 0.5, zCenter, stairWidth, h, stepTread - 0.002, concreteWallMat, 'concrete');
    // High-contrast yellow nosing strip offset +3mm outward on X and front Z, seated cleanly on tread
    const nose = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(stairWidth + 0.006, 0.018, 0.043)),
      yellowRailMat,
    );
    nose.position.set(stairX, h + 0.009, zCenter + stepTread * 0.5 - 0.0185);
    scene.add(nose);
  }

  // 1.60m Elevated Mezzanine Deck (z: 4.72 -> 0.5, x: -20.0 -> -9.8)
  // Open drop-off on the East side (-9.8) to test landing shock proportional to vertical impact velocity!
  addSolidBox(-14.9, 0.80, 2.61, 10.2, 1.60, 4.22, concreteWallMat, 'concrete');
  addSign('DROP-OFF EDGE 1.60M', 'LANDING KNEE-SHOCK TEST', -9.75, 1.15, 2.6, Math.PI * 0.5, 2.5, 0.72, '#e06c38');

  // North safety guardrail along the mezzanine back edge (posts stop cleanly at top rail underside 2.51m)
  addSolidBox(-14.9, 2.55, 0.58, 10.2, 0.08, 0.08, yellowRailMat, 'metal');
  for (let px = -19.8; px <= -10.0; px += 2.45) {
    addSolidBox(px, 2.055, 0.58, 0.07, 0.91, 0.07, steelBeamMat, 'metal');
  }

  // Smooth 18° Concrete Sloped Ramp rising from z=9.6 to z=4.7 (baseY 0 -> topY 1.60, run 4.9m -> ~18.1°)
  const buildVisualRamp = (
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    baseY: number,
    topY: number,
    riseAxis: '-z' | '+z' | '+x' | '-x',
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial,
  ) => {
    physics.addRamp({ minX, maxX, minZ, maxZ, baseY, topY, riseAxis, surface });

    const w = maxX - minX;
    const d = maxZ - minZ;
    const h = topY - baseY;
    // Build exact prism BufferGeometry matching riseAxis === '-z' (rises toward minZ)
    const positions = new Float32Array([
      // Top sloped quad (2 tris)
      minX, baseY, maxZ, maxX, baseY, maxZ, maxX, topY, minZ,
      minX, baseY, maxZ, maxX, topY, minZ, minX, topY, minZ,
      // Left side tri
      minX, baseY, maxZ, minX, topY, minZ, minX, baseY, minZ,
      // Right side tri
      maxX, baseY, maxZ, maxX, baseY, minZ, maxX, topY, minZ,
      // Back vertical face (minZ)
      minX, baseY, minZ, minX, topY, minZ, maxX, topY, minZ,
      minX, baseY, minZ, maxX, topY, minZ, maxX, baseY, minZ,
    ]);
    const geo = trackGeo(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const uvs = new Float32Array([
      0, 0, w * 0.5, 0, w * 0.5, d * 0.5,
      0, 0, w * 0.5, d * 0.5, 0, d * 0.5,
      0, 0, d * 0.5, h * 0.5, d * 0.5, 0,
      0, 0, d * 0.5, 0, d * 0.5, h * 0.5,
      0, 0, 0, h * 0.5, w * 0.5, h * 0.5,
      0, 0, w * 0.5, h * 0.5, w * 0.5, 0,
    ]);
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    scene.add(mesh);
    raycastMeshes.push(mesh);
  };

  // Ramp A: 18° concrete ramp (x: -19.6..-16.8, z: 4.72..9.60, butts cleanly against mezzanine maxZ=4.72)
  buildVisualRamp(-19.6, -16.8, 4.72, 9.6, 0, 1.60, '-z', concreteWallMat, 'concrete');
  // Ramp B: Steeper 24° steel-grate ramp (x: -16.1..-13.5, z: 4.72..8.30)
  buildVisualRamp(-16.1, -13.5, 4.72, 8.3, 0, 1.60, '-z', metalGrateMat, 'metal');

  // 3-Stage Step-Up Curb Gauntlet (0.18m, 0.25m, 0.30m curbs in front of stairs)
  addSolidBox(-11.4, 0.09, 10.6, 3.0, 0.18, 0.9, concreteWallMat, 'concrete');
  addSolidBox(-15.0, 0.125, 11.4, 3.0, 0.25, 0.9, concreteWallMat, 'concrete');
  addSolidBox(-18.6, 0.15, 11.4, 3.0, 0.30, 0.9, concreteWallMat, 'concrete');
  addFloorPlaque('CURB 0.18M', 'AUTO STEP-UP', -11.4, 11.65, '#9ec488');
  addFloorPlaque('CURB 0.25M', 'AUTO STEP-UP', -15.0, 12.45, '#e0a938');
  addFloorPlaque('CURB 0.30M', 'MAX STEP LIMIT', -18.6, 12.45, '#e06c38');

  // =========================================================================
  // ZONE 2 (EAST WING): CQB HALLWAY, TIGHT DOORFRAMES & 1.22M CROUCH TUNNEL
  // =========================================================================
  addSign('CQB & CLEARANCE WING', 'LEAN CLEARANCE · WALL PULLBACK · 1.22M TUNNEL', 14.5, 3.8, 12.8, 0, 4.8, 1.15, '#d4a64a');

  // Outer walls of CQB corridor (x: 10.5..18.5, z: 1.5..11.5)
  addSolidBox(10.5, 1.8, 6.5, 0.35, 3.6, 10.0, concreteWallMat, 'concrete');
  addSolidBox(18.5, 1.8, 6.5, 0.35, 3.6, 10.0, concreteWallMat, 'concrete');

  // Mid divider creating two parallel lanes:
  //   Lane A (x: 10.7..13.8): Tight 0.98m Doorframes & CQB Leaning Partitions
  //   Lane B (x: 14.2..18.3): Low 1.22m Concrete Crouch Tunnel
  addSolidBox(14.0, 1.8, 6.5, 0.35, 3.6, 10.0, concreteWallMat, 'concrete');

  // Lane A: Three staggered CQB doorframe partitions (0.98m clear doorways)
  const buildDoorframeWall = (zPos: number, doorCenterX: number, doorWidth = 0.98) => {
    const laneMinX = 10.68;
    const laneMaxX = 13.82;
    const leftW = Math.max(0.12, doorCenterX - doorWidth * 0.5 - laneMinX);
    const rightW = Math.max(0.12, laneMaxX - (doorCenterX + doorWidth * 0.5));
    addSolidBox(laneMinX + leftW * 0.5, 1.8, zPos, leftW, 3.6, 0.28, concreteWallMat, 'concrete');
    addSolidBox(laneMaxX - rightW * 0.5, 1.8, zPos, rightW, 3.6, 0.28, concreteWallMat, 'concrete');
    // Door lintel above 2.18m
    addSolidBox(doorCenterX, 2.89, zPos, doorWidth, 1.42, 0.28, steelBeamMat, 'metal');
    // Steel jamb trim
    addSolidBox(doorCenterX - doorWidth * 0.5 + 0.03, 1.09, zPos, 0.06, 2.18, 0.32, steelBeamMat, 'metal');
    addSolidBox(doorCenterX + doorWidth * 0.5 - 0.03, 1.09, zPos, 0.06, 2.18, 0.32, steelBeamMat, 'metal');
  };
  buildDoorframeWall(10.0, 12.25, 1.02);
  buildDoorframeWall(6.5, 11.65, 0.98);
  buildDoorframeWall(3.0, 12.85, 0.98);

  // Interior reverb zone for CQB hall
  physics.addInteriorZone({
    minX: 10.5,
    maxX: 18.5,
    minY: 0,
    maxY: 3.6,
    minZ: 1.5,
    maxZ: 11.5,
    material: 'concrete',
  });
  // CQB hallway ceiling over Lane A (seated cleanly atop 3.60m walls)
  addSolidBox(12.25, 3.72, 6.5, 3.85, 0.24, 10.0, concreteWallMat, 'concrete');

  // Lane B: Low 1.22m-Clearance Crouch Tunnel (inset 5mm from flanking wall inner faces)
  // Stand capsule is 1.62m -> forces crouch & triggers overhead ceiling lock if player tries to stand inside!
  addSolidBox(16.25, 1.22 + 0.35, 6.25, 4.14, 0.70, 7.5, darkConcreteMat, 'concrete');
  // Yellow/black hazard low-clearance trim bands offset 6mm proud of each tunnel portal face
  addSolidBox(16.25, 1.22 + 0.123, 10.006, 4.136, 0.24, 0.012, hazardMat, 'metal', false);
  addSolidBox(16.25, 1.22 + 0.123, 2.494, 4.136, 0.24, 0.012, hazardMat, 'metal', false);
  addSign('CROUCH TUNNEL · 1.22M', 'OVERHEAD CLEARANCE LOCK TEST', 16.25, 2.38, 10.12, 0, 3.2, 0.82, '#e0a938');
  addSign('CQB DOORFRAMES', 'Q/E LEAN · CANT (B) · LASER (L)', 12.25, 2.85, 10.22, 0, 2.8, 0.76, '#7ec4cf');

  // =========================================================================
  // ZONE 3 (NORTH-WEST): PITCH-BLACK DARKROOM -> BLINDING SUNLIT EXTERIOR BAY
  // =========================================================================
  // Enclosed concrete darkroom: x: -17.725..-4.275, z: -22.725..-10.275, height: 3.6m (non-overlapping joints)
  // Open doorway on South wall (z = -10.5, x: -12.0..-9.6) facing blinding sunlit apron (z: -10.5..-3.0)
  addSolidBox(-11.0, 1.8, -22.5, 13.45, 3.6, 0.45, darkConcreteMat, 'concrete'); // North wall (x: -17.725..-4.275)
  addSolidBox(-17.5, 1.8, -16.5, 0.45, 3.6, 11.55, darkConcreteMat, 'concrete'); // West wall (z: -22.275..-10.725)
  addSolidBox(-4.5, 1.8, -16.5, 0.45, 3.6, 11.55, darkConcreteMat, 'concrete'); // East wall (z: -22.275..-10.725)
  // Roof slab seated cleanly on top of 3.60m walls sealing out all directional sun
  addSolidBox(-11.0, 3.775, -16.5, 13.45, 0.35, 12.45, darkConcreteMat, 'concrete');
  // South wall with 2.40m wide doorway at x = -10.8 (x: -12.0..-9.6), zero overlap with lintel or corners
  addSolidBox(-14.8625, 1.8, -10.5, 5.725, 3.6, 0.45, darkConcreteMat, 'concrete'); // x: -17.725..-12.0
  addSolidBox(-6.9375, 1.8, -10.5, 5.325, 3.6, 0.45, darkConcreteMat, 'concrete'); // x: -9.6..-4.275
  addSolidBox(-10.8, 3.02, -10.5, 2.40, 1.16, 0.45, darkConcreteMat, 'concrete'); // x: -12.0..-9.6, y: 2.44..3.60

  // Interior concrete reverb zone inside darkroom
  physics.addInteriorZone({
    minX: -17.4,
    maxX: -4.6,
    minY: 0,
    maxY: 3.6,
    minZ: -22.4,
    maxZ: -10.5,
    material: 'concrete',
  });

  // Dim red glowing EXIT sign above interior doorway
  const exitMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xff3022 }),
  );
  const exitBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.72, 0.22, 0.08)), exitMat);
  exitBar.position.set(-10.8, 2.68, -10.82);
  scene.add(exitBar);

  // Darkroom exterior sign + interior instructions
  addSign('HDR EXPOSURE DARKROOM', 'STEP INSIDE & LOOK OUT FOR IRIS + LENS DIRT FLARE', -10.8, 3.05, -10.18, 0, 3.9, 0.96, '#e0a938');

  // Blinding sunlit exterior concrete bounce apron (+4mm above floor slab + polygonOffset)
  const sunApron = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(11.5, 8.0)), brightSunApronMat);
  sunApron.rotation.x = -Math.PI / 2;
  sunApron.position.set(-10.8, 0.004, -6.2);
  sunApron.userData.surfaceMaterial = 'concrete';
  scene.add(sunApron);
  raycastMeshes.push(sunApron);

  // High-HDR sunlit white concrete reflector wall facing the darkroom doorway at z = -2.0
  // (low enough to see sky above, brightly lit so exiting darkroom blooms the lens smudge mask)
  const glareReflectorMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: new THREE.Color(0xfff4da),
      emissiveIntensity: 2.35,
      roughness: 0.35,
      metalness: 0.05,
    }),
  );
  addSolidBox(-10.8, 1.25, -2.2, 5.2, 2.5, 0.35, glareReflectorMat, 'concrete');
  addSign('SUNLIT HDR BAY', 'AUTO-EXPOSURE + LENS SMUDGE TEST', -10.8, 2.05, -2.42, Math.PI, 3.0, 0.72, '#222426');

  // =========================================================================
  // ZONE 4 (CENTRAL PROMENADE): LABELED ACOUSTIC FLOOR STRIPS
  // =========================================================================
  const stripSpecs: {
    name: string;
    subtitle: string;
    surface: BodycamSurfaceMaterial;
    x: number;
    mat: THREE.Material;
    accent: string;
  }[] = [
    { name: 'CONCRETE', subtitle: 'CRISP HEEL IMPACT', surface: 'concrete', x: -6.8, mat: concreteWallMat, accent: '#b8c0c4' },
    { name: 'WOOD', subtitle: 'HOLLOW PLANK THUD', surface: 'wood', x: -3.4, mat: woodMat, accent: '#d49b5a' },
    { name: 'METAL GRATE', subtitle: 'METALLIC CLANK', surface: 'metal', x: 0.0, mat: metalGrateMat, accent: '#7ec4cf' },
    { name: 'WATER PUDDLE', subtitle: 'WET SPLASH', surface: 'puddle', x: 3.4, mat: puddleMat, accent: '#5aa6e0' },
    { name: 'GRAVEL', subtitle: 'CRUNCHY AGGREGATE', surface: 'gravel', x: 6.8, mat: gravelMat, accent: '#c9b37a' },
  ];

  const stripMinZ = 2.0;
  const stripMaxZ = 8.4;
  const stripDepth = stripMaxZ - stripMinZ;
  const stripCenterZ = (stripMinZ + stripMaxZ) * 0.5;

  for (const s of stripSpecs) {
    // Raised +0.004m above the floor slab so the bottom face never shares y=0 with the concrete floor
    const pad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.0, 0.025, stripDepth)), s.mat);
    pad.position.set(s.x, 0.0125 + 0.004, stripCenterZ);
    pad.receiveShadow = !isSoftwareGl;
    pad.userData.surfaceMaterial = s.surface;
    scene.add(pad);
    raycastMeshes.push(pad);

    physics.addSurfaceZone({
      minX: s.x - 1.55,
      maxX: s.x + 1.55,
      minZ: stripMinZ,
      maxZ: stripMaxZ,
      minY: -0.2,
      maxY: 0.35,
      surface: s.surface,
    });

    addFloorPlaque(s.name, s.subtitle, s.x, stripMaxZ + 0.65, s.accent);
  }

  // =========================================================================
  // ZONE 5 (NORTH-EAST): BALLISTICS SHOOTING RANGE (10M / 20M / 35M)
  // =========================================================================
  // Firing line counter & safety divider at z = -5.5 (x: 3.5..21.5)
  addSolidBox(3.2, 1.9, -22.5, 0.45, 3.8, 36.0, concreteWallMat, 'concrete'); // West range berm wall
  addSign('BALLISTICS RANGE', '9X19 · 5.45 · 5.56 · 7.62 REAL DROP & DRAG', 12.2, 3.9, -5.5, 0, 5.4, 1.15, '#e06c38');

  // Overhead range baffle beams
  for (const bz of [-8, -16, -24, -32]) {
    addSolidBox(13.5, 4.4, bz, 20.5, 0.45, 0.55, steelBeamMat, 'metal', false);
  }

  // Firing bench dividers (low tables at z = -5.4, height 0.92m with open gaps to walk downrange)
  addSolidBox(6.8, 0.46, -5.4, 2.2, 0.92, 0.72, woodMat, 'wood');
  addSolidBox(15.6, 0.46, -5.4, 2.2, 0.92, 0.72, woodMat, 'wood');

  // Distance line markers on range floor (+4mm above floor slab + polygonOffset)
  const rangeDistances = [
    { label: '10M LINE', z: -15.0 },
    { label: '20M LINE', z: -25.0 },
    { label: '35M LINE', z: -39.5 },
  ];
  for (const d of rangeDistances) {
    const line = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(18.0, 0.14)), yellowRailMat);
    line.rotation.x = -Math.PI / 2;
    line.position.set(13.0, 0.004, d.z);
    scene.add(line);
    addFloorPlaque(d.label, 'RANGE MARKER', 5.2, d.z + 0.65, '#e0a938');
  }

  // Helper to spawn a hinged Reactive AR500 Steel Silhouette Target
  const addSteelTarget = (id: string, x: number, z: number, distanceLabel: string) => {
    // A-frame steel stand
    const standL = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.025, 0.03, 1.68, 8)), steelBeamMat);
    standL.position.set(x - 0.42, 0.84, z);
    const standR = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.025, 0.03, 1.68, 8)), steelBeamMat);
    standR.position.set(x + 0.42, 0.84, z);
    const topBar = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.024, 0.024, 0.92, 8)), steelBeamMat);
    topBar.rotation.z = Math.PI / 2;
    topBar.position.set(x, 1.66, z);
    scene.add(standL, standR, topBar);

    const pivot = new THREE.Group();
    pivot.position.set(x, 1.64, z);
    scene.add(pivot);

    const baseMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.steelTargetAlbedo,
        roughness: 0.36,
        metalness: 0.78,
        emissive: new THREE.Color(0x000000),
      }),
    );
    const plateMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.78, 0.028)), baseMat);
    plateMesh.position.set(0, -0.48, 0);
    plateMesh.castShadow = !isSoftwareGl;
    plateMesh.receiveShadow = !isSoftwareGl;
    plateMesh.userData.surfaceMaterial = 'metal';
    plateMesh.userData.ballisticMaterial = 'steel';
    plateMesh.userData.thicknessM = 0.014;
    plateMesh.userData.impenetrable = true;
    plateMesh.userData.gymTargetKind = 'steel_plate';
    plateMesh.userData.gymTargetId = id;
    plateMesh.userData.gymTargetLabel = `AR500 STEEL (${distanceLabel})`;
    pivot.add(plateMesh);
    raycastMeshes.push(plateMesh);

    // Small base foot collider so player doesn't walk straight through the stand
    physics.addBox({
      minX: x - 0.48,
      maxX: x + 0.48,
      minY: 0,
      maxY: 1.7,
      minZ: z - 0.16,
      maxZ: z + 0.16,
      surface: 'metal',
    });

    steelTargets.push({
      id,
      label: 'AR500 STEEL',
      distanceLabel,
      pivot,
      plateMesh,
      hitAngle: 0,
      hitAngVel: 0,
      hitFlashTimer: 0,
      baseMat,
    });
  };

  // Helper to spawn a Paper Bullseye Target
  const addPaperTarget = (id: string, x: number, z: number, distanceLabel: string) => {
    const postL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.05, 1.75, 0.05)), woodMat);
    postL.position.set(x - 0.46, 0.875, z);
    const postR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.05, 1.75, 0.05)), woodMat);
    postR.position.set(x + 0.46, 0.875, z);
    scene.add(postL, postR);

    const paperMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: textures.paperTargetAlbedo,
        roughness: 0.92,
        metalness: 0.0,
      }),
    );
    const board = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.86, 0.86, 0.025)), paperMat);
    board.position.set(x, 1.32, z);
    board.castShadow = !isSoftwareGl;
    board.receiveShadow = !isSoftwareGl;
    board.userData.surfaceMaterial = 'wood';
    board.userData.ballisticMaterial = 'wood';
    board.userData.thicknessM = 0.004;
    board.userData.gymTargetKind = 'paper';
    board.userData.gymTargetId = id;
    board.userData.gymTargetLabel = `PAPER BULLSEYE (${distanceLabel})`;
    scene.add(board);
    raycastMeshes.push(board);

    paperTargets.push({
      id,
      label: 'PAPER BULLSEYE',
      distanceLabel,
      mesh: board,
    });
  };

  // 10m Bay (Steel + Paper)
  addSteelTarget('steel_10a', 9.2, -15.0, '10M');
  addPaperTarget('paper_10b', 12.8, -15.0, '10M');
  addSteelTarget('steel_10c', 16.4, -15.0, '10M');

  // 20m Bay (Steel + Paper)
  addPaperTarget('paper_20a', 8.0, -25.0, '20M');
  addSteelTarget('steel_20b', 11.4, -25.0, '20M');
  addSteelTarget('steel_20c', 14.8, -25.0, '20M');
  addPaperTarget('paper_20d', 18.2, -25.0, '20M');

  // 35m Long-Range Steel Bay
  addSteelTarget('steel_35a', 9.5, -39.5, '35M');
  addSteelTarget('steel_35b', 13.5, -39.5, '35M');
  addSteelTarget('steel_35c', 17.5, -39.5, '35M');

  // === ZONE 5B: TERMINAL BALLISTICS TEST STATION (Ricochet, Penetration, Fragmentation) ===
  // 1) Angled 16-deg AR500 Steel Ricochet Plate + Witness Timber Board (West range lane)
  const ricochetStand = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.035, 0.045, 0.9, 8)),
    steelBeamMat,
  );
  ricochetStand.position.set(6.2, 0.45, -12.0);
  scene.add(ricochetStand);

  const ricochetPlate = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.95, 0.95, 0.025)),
    trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x525a64,
        metalness: 0.86,
        roughness: 0.28,
      }),
    ),
  );
  ricochetPlate.position.set(6.2, 1.22, -12.0);
  ricochetPlate.rotation.y = Math.PI * 0.5 - 0.28; // ~16-degree grazing angle to shots from firing line
  ricochetPlate.castShadow = !isSoftwareGl;
  ricochetPlate.receiveShadow = !isSoftwareGl;
  ricochetPlate.userData.surfaceMaterial = 'metal';
  ricochetPlate.userData.ballisticMaterial = 'steel';
  ricochetPlate.userData.thicknessM = 0.022;
  ricochetPlate.userData.impenetrable = true;
  ricochetPlate.userData.gymTargetKind = 'ricochet_plate';
  ricochetPlate.userData.gymTargetLabel = '16° RICOCHET STEEL';
  scene.add(ricochetPlate);
  raycastMeshes.push(ricochetPlate);
  addFloorPlaque('16° STEEL PLATE', 'RICOCHET / SPALL TEST', 6.2, -10.8, '#e06c38');

  // Witness timber catch board placed downrange-left of angled ricochet plate
  const witnessWood = addSolidBox(4.3, 1.22, -13.6, 0.04, 1.4, 1.6, woodMat, 'wood', true);
  witnessWood.userData.ballisticMaterial = 'wood';
  witnessWood.userData.thicknessM = 0.04;
  witnessWood.userData.gymTargetKind = 'ballistic_barrier';
  witnessWood.userData.gymTargetLabel = 'RICOCHET WITNESS WOOD';
  penetrableSurfaces.registerSurface({
    id: 'gym_witness_wood',
    mesh: witnessWood,
    kind: 'plywood',
    width: 1.6,
    height: 1.4,
    thickness: 0.04,
    faceAxis: 'x',
    floorY: 0,
    maxHoles: 6,
    hitsToBreach: 1,
  });

  // 2) East Range Penetration Gauntlet: 6mm Sheet Steel, 4cm Timber, 12cm Concrete
  const steelBarrier = addSolidBox(19.6, 0.95, -12.0, 1.25, 1.5, 0.008, metalGrateMat, 'metal', true);
  steelBarrier.userData.ballisticMaterial = 'steel';
  steelBarrier.userData.thicknessM = 0.006;
  steelBarrier.userData.gymTargetKind = 'ballistic_barrier';
  steelBarrier.userData.gymTargetLabel = '6MM SHEET STEEL';
  addFloorPlaque('6MM STEEL', 'AP PENETRATION TEST', 19.6, -10.8, '#7ec4cf', 1.6);

  const timberBarrier = addSolidBox(21.4, 0.95, -12.0, 1.25, 1.5, 0.04, woodMat, 'wood', true);
  timberBarrier.userData.ballisticMaterial = 'wood';
  timberBarrier.userData.thicknessM = 0.04;
  timberBarrier.userData.gymTargetKind = 'ballistic_barrier';
  timberBarrier.userData.gymTargetLabel = '4CM TIMBER PLANK';
  penetrableSurfaces.registerSurface({
    id: 'gym_timber_barrier',
    mesh: timberBarrier,
    kind: 'plywood',
    width: 1.25,
    height: 1.5,
    thickness: 0.04,
    faceAxis: 'z',
    floorY: 0,
    maxHoles: 6,
    hitsToBreach: 1,
  });
  addFloorPlaque('4CM TIMBER', 'COVER PENETRATION', 21.4, -10.8, '#d49b5a', 1.6);

  const concreteBarrier = addSolidBox(23.2, 0.95, -12.0, 1.25, 1.5, 0.12, concreteWallMat, 'concrete', true);
  concreteBarrier.userData.ballisticMaterial = 'concrete';
  concreteBarrier.userData.thicknessM = 0.12;
  concreteBarrier.userData.gymTargetKind = 'ballistic_barrier';
  concreteBarrier.userData.gymTargetLabel = '12CM CONCRETE';
  addFloorPlaque('12CM CONCRETE', 'HEAVY AP / .338 TEST', 23.2, -10.8, '#b8c0c4', 1.6);

  // 3) Shallow Water Trough + Breakable Range Glass Pane at z = -9.0 (water seated cleanly above frame top)
  const waterTroughFrame = addSolidBox(20.4, 0.09, -9.0, 2.2, 0.18, 1.4, steelBeamMat, 'metal', true);
  waterTroughFrame.userData.ballisticMaterial = 'steel';
  waterTroughFrame.userData.thicknessM = 0.05;
  const waterSurface = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.08, 0.016, 1.28)), puddleMat);
  waterSurface.position.set(20.4, 0.189, -9.0);
  waterSurface.userData.surfaceMaterial = 'puddle';
  waterSurface.userData.ballisticMaterial = 'water';
  waterSurface.userData.thicknessM = 0.08;
  waterSurface.userData.gymTargetKind = 'ballistic_barrier';
  waterSurface.userData.gymTargetLabel = 'WATER TROUGH';
  scene.add(waterSurface);
  raycastMeshes.push(waterSurface);
  addFloorPlaque('WATER TROUGH', '<12° HYDRO RICOCHET', 20.4, -7.85, '#5aa6e0');

  // Range Tempered Glass Pane
  const rangeGlassId = 'gym_range_glass';
  const rangeGlass = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 1.15, 0.025)), glassMat);
  rangeGlass.position.set(23.0, 1.15, -9.0);
  rangeGlass.userData.surfaceMaterial = 'glass';
  rangeGlass.userData.ballisticMaterial = 'glass';
  rangeGlass.userData.breakableGlass = true;
  rangeGlass.userData.breakableId = rangeGlassId;
  rangeGlass.userData.shattered = false;
  rangeGlass.userData.gymTargetKind = 'ballistic_barrier';
  rangeGlass.userData.gymTargetLabel = 'TEMPERED GLASS';
  scene.add(rangeGlass);
  raycastMeshes.push(rangeGlass);
  addFloorPlaque('TEMPERED GLASS', 'SHATTER PASS-THROUGH', 23.0, -7.85, '#7ec4cf');

  // =========================================================================
  // INTERACTIVE 3D GUNSMITHING WORKBENCH (Central Courtyard East-South)
  // =========================================================================
  const gunsmithBench = new GunsmithBench({
    scene,
    physics,
    raycastMeshes,
    position: [3.85, 0, 15.2],
    yaw: -0.44,
    isSoftwareGl,
    woodAlbedo: textures.woodAlbedo,
    woodRoughness: textures.woodRoughness,
  });
  addFloorPlaque('GUNSMITHING BENCH', 'LOOK + [F]: MODIFY FIREARM', 3.15, 16.55, '#e0a938');

  physics.setRaycastMeshes(raycastMeshes);

  // Tumbling glass shards spawned when breakable windows shatter
  interface GlassShard {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    rotVel: THREE.Vector3;
    age: number;
    maxAge: number;
  }
  const glassShards: GlassShard[] = [];
  const shardGeo = trackGeo(new THREE.TetrahedronGeometry(0.075, 0));
  const shardMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd0ecf2,
      roughness: 0.14,
      metalness: 0.35,
      transparent: true,
      opacity: 0.65,
    }),
  );

  const shatterBreakable = (
    object: THREE.Object3D,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ): boolean => {
    if (!object.userData?.breakableGlass || object.userData.shattered) {
      return false;
    }
    object.userData.shattered = true;

    // Remove visual mesh + raycast entry + physics collider immediately
    scene.remove(object);
    const idx = raycastMeshes.indexOf(object);
    if (idx !== -1) {
      raycastMeshes.splice(idx, 1);
      physics.setRaycastMeshes(raycastMeshes);
    }
    const breakableId = object.userData.breakableId as string | undefined;
    if (breakableId) {
      physics.disableBoxById(breakableId);
    }

    // Spawn 18 tumbling tempered glass shards bursting along impact direction
    const dirX = impactDir.x;
    const dirY = impactDir.y;
    const dirZ = impactDir.z;
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(shardGeo, shardMat);
      m.position.set(
        impactPoint.x + (Math.random() - 0.5) * 0.9,
        impactPoint.y + (Math.random() - 0.5) * 0.85,
        impactPoint.z + (Math.random() - 0.5) * 0.08,
      );
      m.scale.set(
        0.45 + Math.random() * 1.0,
        0.35 + Math.random() * 0.9,
        0.18 + Math.random() * 0.25,
      );
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      scene.add(m);

      const speed = 1.6 + Math.random() * 3.4;
      glassShards.push({
        mesh: m,
        vel: new THREE.Vector3(
          dirX * speed + (Math.random() - 0.5) * 2.1,
          dirY * speed * 0.5 + 0.6 + Math.random() * 1.9,
          dirZ * speed + (Math.random() - 0.5) * 2.1,
        ),
        rotVel: new THREE.Vector3(
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
          (Math.random() - 0.5) * 14,
        ),
        age: 0,
        maxAge: 2.8 + Math.random() * 1.4,
      });
    }
    return true;
  };

  // Pendulum spring update for reactive AR500 steel plates + glass shards
  const updateDynamicTargets = (dt: number) => {
    const clampedDt = Math.min(dt, 0.05);
    for (let i = 0; i < steelTargets.length; i++) {
      const st = steelTargets[i];
      // Damped harmonic pendulum return with realistic hinge stop
      const accel = -68 * st.hitAngle - 7.5 * st.hitAngVel;
      st.hitAngVel += accel * clampedDt;
      st.hitAngle += st.hitAngVel * clampedDt;
      if (st.hitAngle > 1.15) {
        st.hitAngle = 1.15;
        st.hitAngVel = Math.min(0, st.hitAngVel * -0.25);
      } else if (st.hitAngle < -1.15) {
        st.hitAngle = -1.15;
        st.hitAngVel = Math.max(0, st.hitAngVel * -0.25);
      }
      st.pivot.rotation.x = st.hitAngle;

      if (st.hitFlashTimer > 0) {
        st.hitFlashTimer = Math.max(0, st.hitFlashTimer - clampedDt);
        const f = st.hitFlashTimer / 0.14;
        st.baseMat.emissive.setRGB(f * 0.9, f * 0.45, f * 0.12);
      } else if (st.baseMat.emissive.r > 0.001) {
        st.baseMat.emissive.setRGB(0, 0, 0);
      }
    }

    for (let i = glassShards.length - 1; i >= 0; i--) {
      const sh = glassShards[i];
      sh.age += clampedDt;
      sh.vel.y -= 9.81 * clampedDt;
      sh.mesh.position.addScaledVector(sh.vel, clampedDt);
      sh.mesh.rotation.x += sh.rotVel.x * clampedDt;
      sh.mesh.rotation.y += sh.rotVel.y * clampedDt;
      sh.mesh.rotation.z += sh.rotVel.z * clampedDt;
      if (sh.mesh.position.y < 0.02) {
        sh.mesh.position.y = 0.02;
        sh.vel.y = Math.abs(sh.vel.y) * 0.24;
        sh.vel.x *= 0.62;
        sh.vel.z *= 0.62;
        sh.rotVel.multiplyScalar(0.5);
      }
      if (sh.age >= sh.maxAge) {
        scene.remove(sh.mesh);
        glassShards.splice(i, 1);
      }
    }
    penetrableSurfaces.update(clampedDt);
  };

  return {
    physics,
    raycastMeshes,
    steelTargets,
    paperTargets,
    gunsmithBench,
    penetrableSurfaces,
    shatterBreakable,
    updateDynamicTargets,
    dispose: () => {
      penetrableSurfaces.dispose();
      for (const sh of glassShards) scene.remove(sh.mesh);
      glassShards.length = 0;
      gunsmithBench.dispose();
      envTex.dispose();
      textures.dispose();
      for (const t of ownedTextures) t.dispose();
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      physics.clear();
    },
  };
}

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BodycamPhysicsWorld,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import { loadoutStore } from '../data/loadoutStore';
import { createHideoutMaterials, HideoutMaterialLibrary } from './HideoutMaterials';
import { HideoutElectronicsSystem } from './HideoutElectronicsSystem';
import type { GunWallSlotAnchor } from './HideoutBunkerWorld';

export type ZombiesOutpostInteractKind =
  | 'gun_wall_slot'
  | 'outpost_ops_board'
  | 'outpost_field_radio'
  | 'outpost_ammo_crate'
  | 'outpost_equip_bench'
  | 'outpost_return_airlock';

export interface ZombiesOutpostInteractMeta {
  kind: ZombiesOutpostInteractKind;
  slotIndex?: number;
  maxDistanceM: number;
}

export interface ZombiesOutpostBriefingState {
  mapName: string;
  mapSubtitle: string;
  difficultyLabel: string;
  modifiersSummary: string;
  weatherLabel: string;
  timeOfDayLabel: string;
  botCount: number;
  lobbyCode: string | null;
  lobbyMembersCount: number;
  lobbyMaxPlayers: number;
  bestRound: number;
}

export interface ZombiesOutpostWorldHandle {
  physics: BodycamPhysicsWorld;
  materials: HideoutMaterialLibrary;
  root: THREE.Group;
  raycastMeshes: THREE.Object3D[];
  interactableMeshes: THREE.Mesh[];
  gunWallSlots: GunWallSlotAnchor[];
  syncGunWallSlots: (slots: ReadonlyArray<string | null>) => void;
  setSlotWeaponVisual: (slotIndex: number, weaponId: string | null) => void;
  getSlotTransform: (
    slotIndex: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ) => boolean;
  getPropInteractPos: (kind: ZombiesOutpostInteractKind, outPos: THREE.Vector3) => boolean;
  isInsideReturnRamp: (x: number, z: number) => boolean;
  triggerAmmoCratePop: () => void;
  triggerReturnSeal: () => void;
  setBriefingState: (state: ZombiesOutpostBriefingState) => void;
  electronics: HideoutElectronicsSystem;
  update: (dt: number, listenerPos?: THREE.Vector3) => void;
  dispose: () => void;
}

const MAX_OUTPOST_RACK_SLOTS = 10;

function buildOutpostGroundTexture(maxAniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#222629';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle asphalt aggregate & rain-dampened concrete patches
  let seed = 4182;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) | 0;
    return ((seed >>> 0) % 100000) / 100000;
  };
  for (let i = 0; i < 420; i++) {
    const v = Math.floor(26 + rand() * 24);
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 3},0.16)`;
    ctx.beginPath();
    ctx.arc(rand() * 512, rand() * 512, 12 + rand() * 40, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(10, 12, 14, 0.42)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 256) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
  }
  for (let i = 0; i < 2000; i++) {
    const g = Math.floor(24 + rand() * 58);
    ctx.fillStyle = `rgba(${g},${g},${g},0.14)`;
    ctx.fillRect(rand() * 512, rand() * 512, 2, 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.anisotropy = maxAniso;
  return tex;
}

function drawOpsMapCanvas(
  ctx: CanvasRenderingContext2D,
  state: ZombiesOutpostBriefingState,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = '#111619';
  ctx.fillRect(0, 0, w, h);

  // Subtle quarantine grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1;
  for (let x = 32; x < w; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 32; y < h; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Header hazard strip
  ctx.fillStyle = '#991b1b';
  ctx.fillRect(0, 0, w, 54);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 28px "Oswald", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('QUARANTINE OPERATIONS · SECTOR BRIEFING', 24, 37);

  // Tactical zone map diagram on left half
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(26, 76, 320, 290);
  // Stylized building footprints & containment ring
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.42)';
  ctx.lineWidth = 2;
  ctx.strokeRect(68, 128, 118, 92);
  ctx.strokeRect(198, 118, 108, 146);
  ctx.strokeRect(84, 240, 96, 86);
  ctx.strokeStyle = '#ef4444';
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.arc(186, 222, 112, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#fca5a5';
  ctx.font = '600 15px "IBM Plex Mono", monospace';
  ctx.fillText('HOT ZONE: ACTIVE BREACH', 44, 104);
  ctx.fillStyle = '#f59e0b';
  ctx.fillText('LZ ALPHA · STAGING', 44, 352);

  // Briefing data column on right half
  const rx = 374;
  ctx.fillStyle = '#9ca3af';
  ctx.font = '600 14px "IBM Plex Mono", monospace';
  ctx.fillText('TARGET QUARANTINE ZONE', rx, 98);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '700 32px "Oswald", sans-serif';
  ctx.fillText(state.mapName.toUpperCase(), rx, 134);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 16px "IBM Plex Mono", monospace';
  ctx.fillText(state.mapSubtitle, rx, 160);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '600 14px "IBM Plex Mono", monospace';
  ctx.fillText('THREAT PROFILE & MODIFIERS', rx, 202);
  ctx.fillStyle = '#fbbf24';
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.fillText(state.difficultyLabel.toUpperCase(), rx, 230);
  ctx.fillStyle = '#d1d5db';
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.fillText(state.modifiersSummary, rx, 256);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '600 14px "IBM Plex Mono", monospace';
  ctx.fillText('CONDITIONS & SQUAD', rx, 296);
  ctx.fillStyle = '#e5e7eb';
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.fillText(`${state.weatherLabel} · ${state.timeOfDayLabel}`, rx, 322);
  const squadText = state.lobbyCode
    ? `SQUAD ${state.lobbyCode} (${state.lobbyMembersCount}/${state.lobbyMaxPlayers})`
    : `SOLO + ${state.botCount} ALLIED AI`;
  ctx.fillText(squadText, rx, 346);
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`BEST RECORD: ROUND ${state.bestRound}`, rx, 372);

  // Bottom prompt footer
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(0, h - 46, w, 46);
  ctx.fillStyle = '#f59e0b';
  ctx.font = '600 16px "IBM Plex Mono", monospace';
  ctx.fillText('[E / F] OPEN ZOMBIES OPERATIONS BRIEFING & DEPLOY', 24, h - 17);
}

/**
 * Builds the standalone 3D Fortified Quarantine Outpost Lobby for Zombies mode.
 * Designed for locked 60+ FPS (≤ 7.0ms GPU frametime):
 * - Single shadow-casting floodlight tower + hemisphere night fill + 2 non-shadow accents
 * - Instanced sandbag bunkers, concertina barbed-wire coils, ammo cans, and supply drums
 * - Full physicalized interaction parity (Field Weapon Rack, Ops Map Board, Field Radio,
 *   Supply/Ordnance Crate, Field Medical/Equipment Bench, Return Armored Transport Airlock).
 */
export function buildZombiesOutpostWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  isSoftwareGl: boolean,
): ZombiesOutpostWorldHandle {
  const root = new THREE.Group();
  root.name = 'ZombiesQuarantineOutpostWorld';
  scene.add(root);
  const electronics = new HideoutElectronicsSystem(root);

  const physics = new BodycamPhysicsWorld();
  physics.boundsMinX = -12.6;
  physics.boundsMaxX = 12.6;
  physics.boundsMinZ = -11.4;
  physics.boundsMaxZ = 11.4;

  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const materials = createHideoutMaterials(maxAniso);
  const ownedGeos: THREE.BufferGeometry[] = [];
  const ownedMats: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const raycastMeshes: THREE.Object3D[] = [];
  const interactableMeshes: THREE.Mesh[] = [];

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

  // Nighttime Quarantine Outpost atmosphere + subtle PMREM IBL
  let envTex: THREE.Texture | null = null;
  if (typeof (renderer as { getClearColor?: unknown }).getClearColor === 'function') {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    scene.environment = envTex;
    scene.environmentIntensity = 0.28;
  }
  scene.background = new THREE.Color(0x090c10);
  scene.fog = new THREE.FogExp2(0x0b0f14, 0.022);

  // Lighting (strictly 1 shadow-casting floodlight + cool night hemisphere + 2 non-shadow accents)
  const hemi = new THREE.HemisphereLight(0x4c627e, 0x17191c, 0.62);
  root.add(hemi);

  const floodKey = new THREE.DirectionalLight(0xffe1b5, 1.95);
  floodKey.position.set(-13.5, 14.5, -11.0);
  floodKey.target.position.set(0, 0, -1);
  if (!isSoftwareGl) {
    floodKey.castShadow = true;
    floodKey.shadow.mapSize.set(1024, 1024);
    floodKey.shadow.camera.near = 2;
    floodKey.shadow.camera.far = 38;
    floodKey.shadow.camera.left = -16;
    floodKey.shadow.camera.right = 16;
    floodKey.shadow.camera.top = 16;
    floodKey.shadow.camera.bottom = -16;
    floodKey.shadow.bias = -0.0005;
    floodKey.shadow.normalBias = 0.025;
  }
  root.add(floodKey, floodKey.target);

  const commandLight = new THREE.PointLight(0xffcb8c, 4.2, 18, 1.35);
  commandLight.castShadow = false;
  commandLight.position.set(1.2, 3.6, -5.2);
  root.add(commandLight);

  const flareLight = new THREE.PointLight(0xef4444, 3.2, 16, 1.5);
  flareLight.castShadow = false;
  flareLight.position.set(-1.5, 0.75, 5.8);
  root.add(flareLight);

  // Outpost-specific PBR materials
  const groundTex = trackTex(buildOutpostGroundTexture(maxAniso));
  const groundMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: groundTex,
      roughness: 0.84,
      metalness: 0.06,
    }),
  );
  const sandbagMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6f6552,
      roughness: 0.94,
      metalness: 0.02,
    }),
  );
  const wireMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x646c73,
      roughness: 0.45,
      metalness: 0.85,
    }),
  );
  const canopyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2c342b,
      roughness: 0.88,
      metalness: 0.06,
      side: THREE.DoubleSide,
    }),
  );
  const apcMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x30362f,
      roughness: 0.7,
      metalness: 0.34,
    }),
  );
  const flareEmissiveMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff6b6b,
      emissive: 0xef4444,
      emissiveIntensity: 3.4,
      roughness: 0.2,
    }),
  );
  const amberEmissiveMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfde68a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.6,
      roughness: 0.2,
    }),
  );
  const floodLensMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfff4d6,
      emissive: 0xffdc9a,
      emissiveIntensity: 3.2,
      roughness: 0.15,
    }),
  );
  const drumMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x854d0e,
      roughness: 0.56,
      metalness: 0.45,
    }),
  );
  const medWhiteMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd9dce0,
      roughness: 0.62,
      metalness: 0.08,
    }),
  );
  const hazardFloorMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: materials.hazardStripe.map,
      roughness: 0.68,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );

  const addBox = (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    surface: 'concrete' | 'metal' | 'wood' = 'concrete',
    collidable = true,
    castShadow = false,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    m.castShadow = castShadow && !isSoftwareGl;
    m.receiveShadow = true;
    m.userData.surfaceMaterial = surface;
    root.add(m);
    raycastMeshes.push(m);
    if (collidable) {
      physics.addBox({
        minX: x - w * 0.5,
        maxX: x + w * 0.5,
        minY: y - h * 0.5,
        maxY: y + h * 0.5,
        minZ: z - d * 0.5,
        maxZ: z + d * 0.5,
        surface,
      });
    }
    return m;
  };

  // --------------------------------------------------------------------------
  // 1. EXTENDED FORTIFIED TARMAC GROUND + PERIMETER CONCRETE BARRIERS
  // --------------------------------------------------------------------------
  const ground = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(96, 96)), groundMat);
  ground.rotation.x = -Math.PI * 0.5;
  ground.position.y = 0;
  ground.receiveShadow = true;
  ground.userData.surfaceMaterial = 'concrete';
  root.add(ground);
  raycastMeshes.push(ground);

  // Fortified concrete perimeter walls around walkable yard (±13.2m X, ±12.0m Z)
  // North firing-line barrier wall
  addBox(0, 1.35, -12.1, 26.8, 2.7, 0.7, materials.concreteWall, 'concrete', true, true);
  // West & East fortified perimeter walls
  addBox(-13.1, 1.35, 0, 0.7, 2.7, 24.4, materials.concreteWall, 'concrete', true, true);
  addBox(13.1, 1.35, 0, 0.7, 2.7, 24.4, materials.concreteWall, 'concrete', true, true);
  // South containment bulkhead flanking the Return Airlock / Transport Gate
  addBox(-8.2, 1.65, 11.9, 10.4, 3.3, 0.8, materials.concreteWall, 'concrete', true, true);
  addBox(8.2, 1.65, 11.9, 10.4, 3.3, 0.8, materials.concreteWall, 'concrete', true, true);
  addBox(0, 3.45, 11.9, 6.4, 1.2, 0.9, materials.darkSteel, 'metal', false, false);

  // Distant outer quarantine containment walls & silhouette towers (environmental depth into fog)
  addBox(0, 2.8, -28.0, 64, 5.6, 1.2, materials.concreteWall, 'concrete', false, false);
  addBox(-30.0, 2.8, -4.0, 1.2, 5.6, 56, materials.concreteWall, 'concrete', false, false);
  addBox(30.0, 2.8, -4.0, 1.2, 5.6, 56, materials.concreteWall, 'concrete', false, false);
  for (const [tx, tz] of [
    [-22, -22],
    [22, -22],
    [24, 16],
  ]) {
    const tower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.2, 11.5, 3.2)), materials.darkSteel);
    tower.position.set(tx, 5.75, tz);
    root.add(tower);
    const beacon = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.45, 0.35, 0.45)), flareEmissiveMat);
    beacon.position.set(tx, 11.75, tz);
    root.add(beacon);
  }

  // --------------------------------------------------------------------------
  // 2. INSTANCED SANDBAGS & CONCERTINA BARBED-WIRE COILS (2 Draw Calls Total!)
  // --------------------------------------------------------------------------
  const sandbagGeo = trackGeo(new THREE.BoxGeometry(0.68, 0.24, 0.34));
  const bagMatrices: THREE.Matrix4[] = [];
  const dummy = new THREE.Object3D();

  const pushSandbagWall = (
    startX: number,
    startZ: number,
    stepX: number,
    stepZ: number,
    rotY: number,
    cols: number,
    rows: number,
  ) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const stagger = (r % 2) * 0.32;
        dummy.position.set(
          startX + stepX * (c + stagger),
          0.12 + r * 0.22,
          startZ + stepZ * (c + stagger),
        );
        dummy.rotation.set(0, rotY + ((c * 13 + r * 7) % 5 - 2) * 0.03, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bagMatrices.push(dummy.matrix.clone());
      }
    }
  };
  // North firing-line sandbag breastwork
  pushSandbagWall(-10.8, -11.3, 0.72, 0, 0, 12, 3);
  pushSandbagWall(2.4, -11.3, 0.72, 0, 0, 11, 3);
  // West & East defensive sandbag bunkers
  pushSandbagWall(-12.2, -5.5, 0, 0.72, Math.PI * 0.5, 10, 3);
  pushSandbagWall(12.2, -4.5, 0, 0.72, Math.PI * 0.5, 10, 3);

  const sandbagInst = new THREE.InstancedMesh(sandbagGeo, sandbagMat, bagMatrices.length);
  sandbagInst.receiveShadow = true;
  for (let i = 0; i < bagMatrices.length; i++) {
    sandbagInst.setMatrixAt(i, bagMatrices[i]);
  }
  sandbagInst.instanceMatrix.needsUpdate = true;
  root.add(sandbagInst);

  // Instanced concertina barbed-wire coils mounted atop concrete perimeter walls
  const coilGeo = trackGeo(new THREE.TorusGeometry(0.36, 0.022, 6, 14));
  const coilMatrices: THREE.Matrix4[] = [];
  for (let x = -12.0; x <= 12.0; x += 0.65) {
    dummy.position.set(x, 3.02, -12.1);
    dummy.rotation.set(0.28, 0.52, 0.12);
    dummy.updateMatrix();
    coilMatrices.push(dummy.matrix.clone());
  }
  for (let z = -11.0; z <= 10.5; z += 0.68) {
    for (const sideX of [-13.1, 13.1]) {
      dummy.position.set(sideX, 3.02, z);
      dummy.rotation.set(0.25, Math.PI * 0.5 + 0.45, 0.12);
      dummy.updateMatrix();
      coilMatrices.push(dummy.matrix.clone());
    }
  }
  const wireInst = new THREE.InstancedMesh(coilGeo, wireMat, coilMatrices.length);
  for (let i = 0; i < coilMatrices.length; i++) {
    wireInst.setMatrixAt(i, coilMatrices[i]);
  }
  wireInst.instanceMatrix.needsUpdate = true;
  root.add(wireInst);

  // --------------------------------------------------------------------------
  // 3. TWIN OVERHEAD FLOODLIGHT TOWERS & FLICKERING CRIMSON EMERGENCY FLARES
  // --------------------------------------------------------------------------
  const buildFloodTower = (x: number, z: number, yaw: number): void => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    const pole = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.11, 0.16, 7.6, 8)), materials.darkSteel);
    pole.position.y = 3.8;
    const crossBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.7, 0.14, 0.16)), materials.darkSteel);
    crossBar.position.set(0, 7.55, 0);
    for (const lx of [-0.52, 0.52]) {
      const lampBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.28, 0.24)), materials.darkSteel);
      lampBody.position.set(lx, 7.62, 0.12);
      lampBody.rotation.x = 0.45;
      const lens = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(0.38, 0.2)), floodLensMat);
      lens.position.set(lx, 7.56, 0.245);
      lens.rotation.x = 0.45;
      g.add(lampBody, lens);
    }
    g.add(pole, crossBar);
    root.add(g);
    physics.addBox({
      minX: x - 0.35,
      maxX: x + 0.35,
      minY: 0,
      maxY: 4.0,
      minZ: z - 0.35,
      maxZ: z + 0.35,
      surface: 'metal',
    });
  };
  buildFloodTower(-11.4, -10.2, 0.65);
  buildFloodTower(11.4, 9.6, -2.35);

  // 4 Grounded Emergency Crimson Flares
  const flareEmbers: THREE.Mesh[] = [];
  const flareBodyGeo = trackGeo(new THREE.CylinderGeometry(0.028, 0.032, 0.28, 8));
  const flareGlowGeo = trackGeo(new THREE.SphereGeometry(0.085, 8, 6));
  const flareSpots: Array<[number, number]> = [
    [-3.6, 6.2],
    [3.6, 6.2],
    [-9.5, -6.5],
    [9.4, -7.2],
  ];
  for (const [fx, fz] of flareSpots) {
    const body = new THREE.Mesh(flareBodyGeo, materials.hazardRedEmissive);
    body.position.set(fx, 0.032, fz);
    body.rotation.z = Math.PI * 0.5;
    body.rotation.y = 0.4 + fx * 0.2;
    const glow = new THREE.Mesh(flareGlowGeo, flareEmissiveMat);
    glow.position.set(fx + 0.12, 0.09, fz);
    root.add(body, glow);
    flareEmbers.push(glow);
  }

  // --------------------------------------------------------------------------
  // 4. FIELD WEAPON RACK (Physicalized 10-slot Gun Wall with Swap Choreography)
  // --------------------------------------------------------------------------
  const rackX = -4.2;
  const rackZ = -7.1;
  const rackWidth = 5.8;
  const rackHeight = 1.85;
  const rackCenterY = 1.62;

  // Overhead tactical shelter posts & corrugated canopy roof over Field Weapon Rack
  for (const px of [rackX - 3.2, rackX + 3.2]) {
    addBox(px, 1.55, rackZ - 0.4, 0.14, 3.1, 0.14, materials.darkSteel, 'metal', true);
    addBox(px, 1.55, rackZ + 1.9, 0.14, 3.1, 0.14, materials.darkSteel, 'metal', true);
  }
  const rackRoof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(6.8, 0.09, 2.75)), canopyMat);
  rackRoof.position.set(rackX, 3.12, rackZ + 0.72);
  rackRoof.rotation.x = 0.06;
  root.add(rackRoof);

  // Slatted tactical steel gun wall backing + bench lip
  const rackBacking = addBox(rackX, rackCenterY, rackZ, rackWidth, rackHeight, 0.12, materials.pegboardWall, 'metal', true, true);
  addBox(rackX, 0.34, rackZ + 0.22, rackWidth + 0.2, 0.68, 0.5, materials.darkSteel, 'metal', true, true);
  const rackStrip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(rackWidth - 0.3, 0.035, 0.08)), materials.warmLampEmissive);
  rackStrip.position.set(rackX, rackCenterY + rackHeight * 0.5 + 0.12, rackZ + 0.24);
  root.add(rackStrip);
  const rackSignMat = materials.createSignMaterial('FIELD ARMORY RACK', 'INSPECT · SWAP · EQUIP [E / F]', '#d97706');
  const rackSign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.9, 0.44, 0.05)), rackSignMat);
  rackSign.position.set(rackX, 2.86, rackZ + 0.06);
  root.add(rackSign);
  void rackBacking;

  const gunWallSlots: GunWallSlotAnchor[] = [];
  const COLS = 5;
  const ROWS = 2;
  const colSpacing = 1.12;
  const rowSpacing = 0.64;
  const startX = rackX - ((COLS - 1) * colSpacing) * 0.5;
  const startY = 2.02;
  const rackWeaponQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0, 'YXZ'));

  const bracketBarGeo = trackGeo(new THREE.BoxGeometry(0.03, 0.03, 0.15));
  const proxyGeo = trackGeo(new THREE.BoxGeometry(0.98, 0.38, 0.26));
  const proxyMat = trackMat(new THREE.MeshBasicMaterial({ visible: false }));

  for (let i = 0; i < MAX_OUTPOST_RACK_SLOTS; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const sx = startX + col * colSpacing;
    const sy = startY - row * rowSpacing;
    const sz = rackZ + 0.18;

    const bracketGroup = new THREE.Group();
    bracketGroup.position.set(sx, sy, rackZ + 0.06);
    bracketGroup.visible = false;
    for (const bx of [-0.2, 0.2]) {
      const peg = new THREE.Mesh(bracketBarGeo, materials.brushedSteel);
      peg.position.set(bx, -0.05, 0.07);
      bracketGroup.add(peg);
    }
    root.add(bracketGroup);

    const mountGroup = new THREE.Group();
    mountGroup.position.set(sx, sy, sz);
    mountGroup.quaternion.copy(rackWeaponQuat);
    root.add(mountGroup);

    const proxyMesh = new THREE.Mesh(proxyGeo, proxyMat);
    proxyMesh.position.set(sx, sy, sz + 0.05);
    proxyMesh.visible = false;
    const meta: ZombiesOutpostInteractMeta = {
      kind: 'gun_wall_slot',
      slotIndex: i,
      maxDistanceM: 3.1,
    };
    proxyMesh.userData.outpostInteractable = meta;
    root.add(proxyMesh);
    interactableMeshes.push(proxyMesh);

    gunWallSlots.push({
      index: i,
      weaponId: null,
      worldPos: new THREE.Vector3(sx, sy, sz),
      worldQuat: rackWeaponQuat.clone(),
      mountGroup,
      bracketGroup,
      proxyMesh,
      assembly: null,
    });
  }

  const setSlotWeaponVisual = (slotIndex: number, weaponId: string | null): void => {
    const slot = gunWallSlots[slotIndex];
    if (!slot) return;
    if (slot.assembly) {
      slot.mountGroup.remove(slot.assembly.group);
      slot.assembly.dispose();
      slot.assembly = null;
    }
    slot.weaponId = weaponId;
    if (!weaponId || weaponId === 'unarmed') return;
    const profile = resolveWeaponProfile(weaponId);
    const build = loadoutStore.getActiveWeaponBuild(profile.id);
    const assembly: WeaponModelAssembly = WeaponModelFactory.build({
      id: profile.id,
      holdClass: profile.holdClass,
      barrelLengthM: profile.barrelLengthM,
      visualStyle: profile.visualStyle,
      finish: profile.finish,
      railType: profile.railType,
      isRevolver: profile.isRevolver,
      boreAxisHeightM: profile.boreAxisHeightM,
      rightHandSocket: profile.rightHandSocket,
      leftHandSocket: profile.leftHandSocket,
      muzzleOffset: profile.muzzleOffset,
      laserOffset: profile.laserOffset,
      supportsSuppressor: profile.supportsSuppressor,
      renderLayer: 0,
    });
    WeaponAssembler.applyAttachments(
      assembly,
      profile.massKg,
      profile.barrelLengthM,
      profile.magCapacity,
      build.attachments,
      { thirdPersonMode: true },
    );
    assembly.group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = !isSoftwareGl;
        child.receiveShadow = true;
      }
    });
    const zCenterOffset = profile.holdClass === 'pistol' ? 0.02 : 0.12;
    assembly.group.position.set(0, 0, zCenterOffset);
    slot.mountGroup.add(assembly.group);
    slot.assembly = assembly;
  };

  const syncGunWallSlots = (slots: ReadonlyArray<string | null>): void => {
    for (let i = 0; i < gunWallSlots.length; i++) {
      const targetId = slots[i] ?? null;
      const slot = gunWallSlots[i];
      const occupied = targetId !== null;
      slot.bracketGroup.visible = occupied || i < 4;
      slot.proxyMesh.visible = occupied || i < 4;
      if (slot.weaponId !== targetId) {
        setSlotWeaponVisual(i, targetId);
      }
    }
  };

  const getSlotTransform = (
    slotIndex: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean => {
    const slot = gunWallSlots[slotIndex];
    if (!slot) return false;
    outPos.copy(slot.worldPos);
    outQuat.copy(slot.worldQuat);
    return true;
  };

  // --------------------------------------------------------------------------
  // 5. ZOMBIES OPERATIONS MAP BOARD & FIELD RADIO (Center-East Command Canopy)
  // --------------------------------------------------------------------------
  const cmdX = 4.2;
  const cmdZ = -5.8;

  // Command post overhead tarp & corner poles
  for (const [cx, cz] of [
    [cmdX - 2.4, cmdZ - 1.5],
    [cmdX + 2.4, cmdZ - 1.5],
    [cmdX - 2.4, cmdZ + 1.5],
    [cmdX + 2.4, cmdZ + 1.5],
  ]) {
    addBox(cx, 1.55, cz, 0.12, 3.1, 0.12, materials.darkSteel, 'metal', true);
  }
  const cmdRoof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(5.1, 0.08, 3.3)), canopyMat);
  cmdRoof.position.set(cmdX, 3.12, cmdZ);
  root.add(cmdRoof);

  // Standing Tactical Operations Map Board with dynamic live CanvasTexture
  const opsCanvas = document.createElement('canvas');
  opsCanvas.width = 768;
  opsCanvas.height = 448;
  const opsCtx = opsCanvas.getContext('2d')!;
  const opsTex = trackTex(new THREE.CanvasTexture(opsCanvas));
  opsTex.colorSpace = THREE.SRGBColorSpace;
  opsTex.anisotropy = maxAniso;
  const opsScreenMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: opsTex,
      emissive: 0x261d14,
      emissiveMap: opsTex,
      emissiveIntensity: 0.45,
      roughness: 0.42,
      metalness: 0.2,
    }),
  );

  // Steel A-frame backing stand for Ops Map Board
  addBox(cmdX - 0.55, 1.48, cmdZ - 0.85, 2.32, 1.38, 0.1, materials.darkSteel, 'metal', true, true);
  addBox(cmdX - 1.62, 0.42, cmdZ - 0.85, 0.12, 0.84, 0.55, materials.darkSteel, 'metal', false);
  addBox(cmdX + 0.52, 0.42, cmdZ - 0.85, 0.12, 0.84, 0.55, materials.darkSteel, 'metal', false);
  const opsBoardScreen = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(2.18, 1.26)), opsScreenMat);
  opsBoardScreen.position.set(cmdX - 0.55, 1.48, cmdZ - 0.79);
  root.add(opsBoardScreen);

  const opsBoardPos = new THREE.Vector3(cmdX - 0.55, 1.48, cmdZ - 0.76);
  const opsBoardProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.36, 1.45, 0.55)), proxyMat);
  opsBoardProxy.position.copy(opsBoardPos);
  opsBoardProxy.userData.outpostInteractable = {
    kind: 'outpost_ops_board',
    maxDistanceM: 3.4,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(opsBoardProxy);
  interactableMeshes.push(opsBoardProxy);

  // Field Radio Command Table + Rugged Military Transceiver
  const radioTableX = cmdX + 1.45;
  const radioTableZ = cmdZ + 0.35;
  addBox(radioTableX, 0.42, radioTableZ, 1.38, 0.84, 0.82, materials.tableWood, 'wood', true, true);
  const radioChassis = addBox(
    radioTableX,
    1.01,
    radioTableZ - 0.08,
    0.56,
    0.34,
    0.34,
    materials.lockerSteel,
    'metal',
    false,
    true,
  );
  void radioChassis;
  const radioLed = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.18, 0.08, 0.02)), amberEmissiveMat);
  radioLed.position.set(radioTableX - 0.12, 1.06, radioTableZ + 0.095);
  const radioAntenna = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.008, 0.014, 1.15, 6)), materials.brushedSteel);
  radioAntenna.position.set(radioTableX + 0.22, 1.72, radioTableZ - 0.16);
  const radioHandset = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.06, 0.24)), materials.darkSteel);
  radioHandset.position.set(radioTableX - 0.42, 0.87, radioTableZ + 0.14);
  root.add(radioLed, radioAntenna, radioHandset);

  const radioPos = new THREE.Vector3(radioTableX, 1.04, radioTableZ + 0.08);
  const radioProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 0.85, 0.9)), proxyMat);
  radioProxy.position.copy(radioPos);
  radioProxy.userData.outpostInteractable = {
    kind: 'outpost_field_radio',
    maxDistanceM: 3.1,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(radioProxy);
  interactableMeshes.push(radioProxy);

  // --------------------------------------------------------------------------
  // 6. OUTPOST STAGING PROPS (Supply/Ordnance Crate, Field Med/Equip Bench, Instanced Cans)
  // --------------------------------------------------------------------------
  const crateX = -7.2;
  const crateZ = -1.6;
  addBox(crateX, 0.34, crateZ, 1.22, 0.68, 0.72, materials.ammoCrateBody, 'wood', true, true);
  const crateLidPivot = new THREE.Group();
  crateLidPivot.position.set(crateX, 0.68, crateZ - 0.36);
  const crateLid = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.26, 0.1, 0.76)), materials.ammoCrateTop);
  crateLid.position.set(0, 0.05, 0.36);
  crateLidPivot.add(crateLid);
  root.add(crateLidPivot);

  const cratePos = new THREE.Vector3(crateX, 0.76, crateZ);
  const crateProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.45, 0.95, 0.95)), proxyMat);
  crateProxy.position.set(crateX, 0.56, crateZ);
  crateProxy.userData.outpostInteractable = {
    kind: 'outpost_ammo_crate',
    maxDistanceM: 3.0,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(crateProxy);
  interactableMeshes.push(crateProxy);

  // Tactical Field Medical & Equipment Bench (East side)
  const benchX = 7.6;
  const benchZ = 0.8;
  addBox(benchX, 0.44, benchZ, 1.15, 0.88, 2.35, materials.tableWood, 'wood', true, true);
  // Rubber cleaning mat + medical trauma case + ballistic armor plate prop
  const matMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.65, 0.02, 1.1)), materials.rubberMat);
  matMesh.position.set(benchX - 0.05, 0.89, benchZ - 0.35);
  const medBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.22, 0.52)), medWhiteMat);
  medBox.position.set(benchX + 0.08, 0.99, benchZ + 0.58);
  const medCrossH = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.18, 0.02, 0.06)), materials.hazardRedEmissive);
  medCrossH.position.set(benchX + 0.08, 1.105, benchZ + 0.58);
  const medCrossV = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.02, 0.18)), materials.hazardRedEmissive);
  medCrossV.position.set(benchX + 0.08, 1.105, benchZ + 0.58);
  root.add(matMesh, medBox, medCrossH, medCrossV);

  const benchPos = new THREE.Vector3(benchX - 0.2, 0.96, benchZ);
  const benchProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.4, 1.1, 2.5)), proxyMat);
  benchProxy.position.set(benchX, 0.78, benchZ);
  benchProxy.userData.outpostInteractable = {
    kind: 'outpost_equip_bench',
    maxDistanceM: 3.1,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(benchProxy);
  interactableMeshes.push(benchProxy);

  // Instanced military ammo cans & biohazard supply drums (2 draw calls total)
  const ammoCanGeo = trackGeo(new THREE.BoxGeometry(0.32, 0.22, 0.18));
  const ammoCanCoords: Array<[number, number, number, number]> = [
    [-6.2, 0.11, -1.2, 0.25],
    [-6.3, 0.11, -1.8, -0.18],
    [-6.25, 0.33, -1.5, 0.1],
    [-2.4, 0.11, -6.5, 0.4],
    [-2.1, 0.11, -6.3, -0.3],
    [6.6, 0.11, 2.2, 0.2],
    [6.85, 0.11, 2.45, -0.45],
    [2.8, 0.11, -5.2, 0.15],
  ];
  const ammoCanInst = new THREE.InstancedMesh(ammoCanGeo, materials.lockerSteel, ammoCanCoords.length);
  for (let i = 0; i < ammoCanCoords.length; i++) {
    const [ax, ay, az, ry] = ammoCanCoords[i];
    dummy.position.set(ax, ay, az);
    dummy.rotation.set(0, ry, 0);
    dummy.updateMatrix();
    ammoCanInst.setMatrixAt(i, dummy.matrix);
  }
  ammoCanInst.instanceMatrix.needsUpdate = true;
  root.add(ammoCanInst);

  const drumGeo = trackGeo(new THREE.CylinderGeometry(0.32, 0.32, 0.92, 12));
  const drumCoords: Array<[number, number]> = [
    [-9.8, 2.5],
    [-9.1, 2.9],
    [-9.6, 3.6],
    [9.8, -3.5],
    [10.4, -2.9],
    [9.4, 5.2],
  ];
  const drumInst = new THREE.InstancedMesh(drumGeo, drumMat, drumCoords.length);
  for (let i = 0; i < drumCoords.length; i++) {
    const [dx, dz] = drumCoords[i];
    dummy.position.set(dx, 0.46, dz);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    drumInst.setMatrixAt(i, dummy.matrix);
    physics.addBox({
      minX: dx - 0.36,
      maxX: dx + 0.36,
      minY: 0,
      maxY: 0.95,
      minZ: dz - 0.36,
      maxZ: dz + 0.36,
      surface: 'metal',
    });
  }
  drumInst.instanceMatrix.needsUpdate = true;
  root.add(drumInst);

  // --------------------------------------------------------------------------
  // 7. RETURN AIRLOCK / ARMORED TRANSPORT RAMP (South Gate Z = 9.4..12.0)
  // --------------------------------------------------------------------------
  const returnGateSignMat = materials.createSignMaterial(
    'RETURN AIRLOCK · TRANSPORT',
    'DECON CYCLE BACK TO HIDEOUT [E / F]',
    '#f59e0b',
  );
  const returnSign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.8, 0.56, 0.08)), returnGateSignMat);
  returnSign.position.set(0, 3.38, 11.42);
  returnSign.rotation.y = Math.PI;
  root.add(returnSign);

  // Hazard stripe landing apron leading up to the Armored Transport rear boarding ramp
  const rampStripe = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(3.6, 0.42)), hazardFloorMat);
  rampStripe.rotation.x = -Math.PI * 0.5;
  rampStripe.position.set(0, 0.015, 7.6);
  root.add(rampStripe);

  // Docked Armored Quarantine Transport backed into the South Airlock Gate
  const apcGroup = new THREE.Group();
  apcGroup.position.set(0, 0, 11.8);
  root.add(apcGroup);
  const apcBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.68, 2.05, 4.6)), apcMat);
  apcBody.position.set(0, 1.48, 0.5);
  const apcInterior = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.92, 1.55, 1.8)), materials.cavityBlack);
  apcInterior.position.set(0, 1.32, -1.2);
  const apcRoofLight = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.05, 0.14, 0.24)), amberEmissiveMat);
  apcRoofLight.position.set(0, 2.58, -1.4);
  apcGroup.add(apcBody, apcInterior, apcRoofLight);

  // Animated rear boarding ramp (tilts upward cleanly when sealing for return transition!)
  const returnRampPivot = new THREE.Group();
  returnRampPivot.position.set(0, 0.48, 10.15);
  const rampSlab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.1, 0.14, 2.15)), materials.darkSteel);
  rampSlab.position.set(0, -0.22, -1.02);
  rampSlab.rotation.x = -0.22;
  returnRampPivot.add(rampSlab);
  root.add(returnRampPivot);

  // Colliders flanking the transport hull so player walks onto the ramp cleanly
  physics.addBox({ minX: -3.1, maxX: -1.35, minY: 0, maxY: 2.6, minZ: 9.6, maxZ: 12.2, surface: 'metal' });
  physics.addBox({ minX: 1.35, maxX: 3.1, minY: 0, maxY: 2.6, minZ: 9.6, maxZ: 12.2, surface: 'metal' });
  physics.addBox({ minX: -1.6, maxX: 1.6, minY: 0, maxY: 2.6, minZ: 10.65, maxZ: 12.4, surface: 'metal' });

  // Physical Return Airlock Switch pedestal right beside the transport ramp
  const swX = 2.05;
  const swZ = 8.45;
  addBox(swX, 0.65, swZ, 0.44, 1.3, 0.3, materials.darkSteel, 'metal', true);
  const swBeacon = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 10)), amberEmissiveMat);
  swBeacon.position.set(swX, 1.36, swZ);
  root.add(swBeacon);

  const returnSwitchPos = new THREE.Vector3(swX, 1.28, swZ);
  const returnSwitchProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 1.4, 1.0)), proxyMat);
  returnSwitchProxy.position.set(swX, 1.1, swZ);
  returnSwitchProxy.userData.outpostInteractable = {
    kind: 'outpost_return_airlock',
    maxDistanceM: 3.4,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(returnSwitchProxy);
  interactableMeshes.push(returnSwitchProxy);

  // Secondary return proxy right at the open transport boarding ramp
  const returnRampProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.2, 1.6, 1.1)), proxyMat);
  returnRampProxy.position.set(0, 1.1, 9.5);
  returnRampProxy.userData.outpostInteractable = {
    kind: 'outpost_return_airlock',
    maxDistanceM: 3.5,
  } satisfies ZombiesOutpostInteractMeta;
  root.add(returnRampProxy);
  interactableMeshes.push(returnRampProxy);

  // Register Ops Board, Field Radio, and all Outpost floodlights/beacons as breakable & repairable electronics
  let lastBriefingState: ZombiesOutpostBriefingState = {
    mapName: 'Der Lichtspielhaus',
    mapSubtitle: 'Quarantine Theater Sector',
    difficultyLabel: 'Standard',
    modifiersSummary: 'HP 1.0x · SPD 1.0x · SPAWN 1.0x',
    weatherLabel: 'Auto',
    timeOfDayLabel: 'Night',
    botCount: 0,
    lobbyCode: null,
    lobbyMembersCount: 0,
    lobbyMaxPlayers: 4,
    bestRound: 0,
  };

  electronics.registerNode(
    {
      id: 'zoutpost_ops_board',
      label: 'Zombies Operations Map Board',
      hitMeshes: [opsBoardScreen],
      emissiveMaterials: [opsScreenMat],
      sparkOrigin: opsBoardPos.clone(),
      interactiveLinkId: 'outpost_ops_board',
      repairable: true,
      repairDurationSec: 2.1,
      onBreak: () => {
        opsCtx.fillStyle = '#07090c';
        opsCtx.fillRect(0, 0, opsCanvas.width, opsCanvas.height);
        opsCtx.strokeStyle = 'rgba(200,215,230,0.35)';
        opsCtx.lineWidth = 2;
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + 0.3;
          opsCtx.beginPath();
          opsCtx.moveTo(opsCanvas.width * 0.5, opsCanvas.height * 0.5);
          opsCtx.lineTo(
            opsCanvas.width * 0.5 + Math.cos(ang) * 320,
            opsCanvas.height * 0.5 + Math.sin(ang) * 210,
          );
          opsCtx.stroke();
        }
        opsCtx.fillStyle = '#ef4444';
        opsCtx.font = '700 28px "IBM Plex Mono", monospace';
        opsCtx.fillText('DISPLAY DAMAGED · HOLD [F] TO REPAIR', 72, opsCanvas.height * 0.52);
        opsTex.needsUpdate = true;
      },
      onRepair: () => {
        drawOpsMapCanvas(opsCtx, lastBriefingState);
        opsTex.needsUpdate = true;
      },
    },
    raycastMeshes,
  );

  electronics.registerNode(
    {
      id: 'zoutpost_field_radio',
      label: 'Tactical Field Radio',
      hitMeshes: [radioChassis, radioLed, radioAntenna],
      emissiveMeshes: [radioLed],
      sparkOrigin: radioPos.clone(),
      interactiveLinkId: 'outpost_field_radio',
      repairable: true,
      repairDurationSec: 2.0,
    },
    raycastMeshes,
  );

  electronics.autoRegisterSceneElectronics(root, {
    idPrefix: 'zoutpost_elec',
    raycastMeshes,
    lightMatchRadiusM: 4.5,
  });

  physics.setRaycastMeshes(raycastMeshes);

  // Animation state
  let elapsedSec = 0;
  let cratePopTimer = 0;
  let returnRampTarget = 0;
  let returnRampAngle = 0;
  const fallbackListenerPos = new THREE.Vector3();

  const setBriefingState = (state: ZombiesOutpostBriefingState): void => {
    lastBriefingState = state;
    if (!electronics.isInteractiveLinkBroken('outpost_ops_board')) {
      drawOpsMapCanvas(opsCtx, state);
      opsTex.needsUpdate = true;
    }
  };

  setBriefingState(lastBriefingState);

  const getPropInteractPos = (kind: ZombiesOutpostInteractKind, outPos: THREE.Vector3): boolean => {
    if (kind === 'outpost_ops_board') {
      outPos.copy(opsBoardPos);
      return true;
    }
    if (kind === 'outpost_field_radio') {
      outPos.copy(radioPos);
      return true;
    }
    if (kind === 'outpost_ammo_crate') {
      outPos.copy(cratePos);
      return true;
    }
    if (kind === 'outpost_equip_bench') {
      outPos.copy(benchPos);
      return true;
    }
    if (kind === 'outpost_return_airlock') {
      outPos.copy(returnSwitchPos);
      return true;
    }
    return false;
  };

  const isInsideReturnRamp = (x: number, z: number): boolean =>
    Math.abs(x) <= 1.15 && z >= 9.45 && z <= 10.6;

  const triggerAmmoCratePop = (): void => {
    cratePopTimer = 0.55;
  };

  const triggerReturnSeal = (): void => {
    returnRampTarget = 1;
  };

  const update = (dt: number, listenerPos?: THREE.Vector3): void => {
    const clampedDt = Math.min(dt, 0.05);
    elapsedSec += clampedDt;
    electronics.update(clampedDt, listenerPos ?? fallbackListenerPos);

    // Flickering crimson road flares
    const flicker =
      0.78 + 0.16 * Math.sin(elapsedSec * 19.3) + 0.12 * Math.sin(elapsedSec * 31.7 + 1.2);
    if (!flareLight.userData?.electronicBroken) {
      flareLight.intensity = 2.6 * flicker;
    }
    if (!flareEmissiveMat.userData?.electronicBroken) {
      flareEmissiveMat.emissiveIntensity = 2.5 + flicker * 1.4;
    }
    for (let i = 0; i < flareEmbers.length; i++) {
      const s = 0.88 + 0.24 * Math.sin(elapsedSec * 23 + i * 1.9);
      flareEmbers[i].scale.setScalar(s);
    }

    // Subtle APC diesel idle vibration & amber return beacon pulse
    apcGroup.position.y = Math.sin(elapsedSec * 26.0) * 0.003;
    const beaconPulse = 0.5 + 0.5 * Math.sin(elapsedSec * 5.6);
    if (!amberEmissiveMat.userData?.electronicBroken) {
      amberEmissiveMat.emissiveIntensity = 1.4 + beaconPulse * 2.2;
    }

    // Ammo crate lid pop
    if (cratePopTimer > 0) {
      cratePopTimer = Math.max(0, cratePopTimer - clampedDt);
      const u = 1 - cratePopTimer / 0.55;
      crateLidPivot.rotation.x = -Math.sin(u * Math.PI) * THREE.MathUtils.degToRad(26);
    } else {
      crateLidPivot.rotation.x = 0;
    }

    // Return transport boarding ramp seal lift
    returnRampAngle = THREE.MathUtils.damp(
      returnRampAngle,
      returnRampTarget * THREE.MathUtils.degToRad(68),
      6.5,
      clampedDt,
    );
    returnRampPivot.rotation.x = returnRampAngle;
  };

  return {
    physics,
    materials,
    root,
    raycastMeshes,
    interactableMeshes,
    gunWallSlots,
    syncGunWallSlots,
    setSlotWeaponVisual,
    getSlotTransform,
    getPropInteractPos,
    isInsideReturnRamp,
    triggerAmmoCratePop,
    triggerReturnSeal,
    setBriefingState,
    electronics,
    update,
    dispose: () => {
      electronics.dispose();
      for (const slot of gunWallSlots) {
        if (slot.assembly) {
          slot.mountGroup.remove(slot.assembly.group);
          slot.assembly.dispose();
          slot.assembly = null;
        }
      }
      for (const g of ownedGeos) g.dispose();
      for (const m of ownedMats) m.dispose();
      for (const t of ownedTextures) t.dispose();
      materials.dispose();
      envTex?.dispose();
      scene.environment = null;
      scene.remove(root);
    },
  };
}

import * as THREE from 'three';
import {
  buildAnatomicalHeadAssembly,
  BuiltAnatomicalHeadAssembly,
} from '../bodycam-sdk/character/AnatomicalHeadBuilder';
import {
  FacialExpressionController,
  FacialExpressionInput,
  FacialExpressionIntent,
} from '../bodycam-sdk/character/FacialExpressionController';

export type InfectedArchetypeId = 'quarantine_guard' | 'hazmat_tech' | 'infected_civilian';

export type InfectedPoseMode = 'locomote' | 'tear' | 'vault' | 'windup' | 'stagger' | 'death';

export interface InfectedPoseInput {
  mode: InfectedPoseMode;
  walkCycle: number;
  speedMps: number;
  tearPhase: number;
  vaultT: number;
  windupProgress: number; // 0..1 during melee lunge windup
  staggerRatio: number; // 0..1 hit flinch
  deathProgress: number; // 0..1 buckling fall
  elapsedSec: number;
  dt?: number;
  gazeTargetWorld?: Readonly<THREE.Vector3> | null;
  distanceToCameraM?: number;
  isVisible?: boolean;
}

export interface BuiltInfectedZombieRig {
  archetype: InfectedArchetypeId;
  root: THREE.Group;
  bodyPivot: THREE.Group;
  pelvisGroup: THREE.Group;
  spineLower: THREE.Group;
  spineUpper: THREE.Group;
  neckPivot: THREE.Group;
  headGroup: THREE.Group;
  jawPivot: THREE.Group;
  headAssembly: BuiltAnatomicalHeadAssembly;
  facialController: FacialExpressionController;
  _facialInput: FacialExpressionInput;
  leftHip: THREE.Group;
  leftKnee: THREE.Group;
  leftAnkle: THREE.Group;
  rightHip: THREE.Group;
  rightKnee: THREE.Group;
  rightAnkle: THREE.Group;
  leftShoulder: THREE.Group;
  leftElbow: THREE.Group;
  leftHandPivot: THREE.Group;
  rightShoulder: THREE.Group;
  rightElbow: THREE.Group;
  rightHandPivot: THREE.Group;
  hitMeshes: THREE.Mesh[];
  restPelvisY: number;
  limpSide: -1 | 1;
  headTiltBias: number;
  hunchBias: number;
  deathFallSide: -1 | 1;
  heightScale: number;
}

interface ZombieMaterialSet {
  skin: THREE.MeshStandardMaterial;
  clothesTop: THREE.MeshStandardMaterial;
  clothesPants: THREE.MeshStandardMaterial;
  gearAccent: THREE.MeshStandardMaterial;
  bloodMat: THREE.MeshStandardMaterial;
  bootLeather: THREE.MeshStandardMaterial;
  bootSole: THREE.MeshStandardMaterial;
  visorMat: THREE.MeshStandardMaterial;
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function createCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function buildNecroticSkinTexture(): THREE.CanvasTexture {
  const [c, ctx] = createCanvas(256, 256);
  const rand = seededRand(7741);
  ctx.fillStyle = '#757d6e';
  ctx.fillRect(0, 0, 256, 256);

  // Mottled pallor & livor mortis bruising
  for (let i = 0; i < 180; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const r = 6 + rand() * 26;
    const bruise = rand() < 0.35;
    ctx.fillStyle = bruise
      ? `rgba(68, 52, 62, ${0.08 + rand() * 0.14})`
      : `rgba(${104 + Math.floor(rand() * 28)}, ${112 + Math.floor(rand() * 22)}, ${98 + Math.floor(rand() * 18)}, 0.12)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark subdermal veins
  ctx.strokeStyle = 'rgba(42, 48, 56, 0.34)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 24; i++) {
    let x = rand() * 256;
    let y = rand() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (rand() - 0.5) * 24;
      y += (rand() - 0.5) * 24;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Dried coagulated blood & grime streaks
  for (let i = 0; i < 28; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    ctx.fillStyle = `rgba(78, 16, 16, ${0.18 + rand() * 0.28})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 4 + rand() * 14, 2 + rand() * 8, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function buildTatteredFabricTexture(
  baseHex: string,
  secondaryHex: string,
  bloodIntensity: number,
  seed: number,
): THREE.CanvasTexture {
  const [c, ctx] = createCanvas(256, 256);
  const rand = seededRand(seed);
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 256, 256);

  // Woven cloth grain
  ctx.fillStyle = secondaryHex;
  for (let y = 0; y < 256; y += 4) {
    ctx.globalAlpha = 0.08 + rand() * 0.08;
    ctx.fillRect(0, y, 256, 2);
  }
  for (let x = 0; x < 256; x += 6) {
    ctx.globalAlpha = 0.06 + rand() * 0.07;
    ctx.fillRect(x, 0, 2, 256);
  }
  ctx.globalAlpha = 1;

  // Dirt, soot & damp stain patches
  for (let i = 0; i < 95; i++) {
    ctx.fillStyle = `rgba(18, 16, 14, ${0.08 + rand() * 0.16})`;
    ctx.beginPath();
    ctx.arc(rand() * 256, rand() * 256, 8 + rand() * 26, 0, Math.PI * 2);
    ctx.fill();
  }

  // Torn cloth slash scars
  ctx.strokeStyle = 'rgba(12, 10, 10, 0.55)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 16; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 44, y + (rand() - 0.5) * 28);
    ctx.stroke();
  }

  // Matted blood splatter
  const splats = Math.round(20 * bloodIntensity);
  for (let i = 0; i < splats; i++) {
    ctx.fillStyle = `rgba(82, 14, 14, ${0.22 + rand() * 0.34})`;
    ctx.beginPath();
    ctx.ellipse(
      rand() * 256,
      rand() * 256,
      5 + rand() * 20,
      4 + rand() * 14,
      rand() * Math.PI,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Shared Anatomical Zombie Rig Factory & Zero-GC Procedural Pose Animator.
 * Allocates all geometries, procedural canvas PBR textures, and materials ONCE
 * so 18 simultaneous zombies maintain locked 60+ FPS with operator-grade silhouette fidelity.
 */
export class InfectedZombieRigLibrary {
  private readonly disposables: Array<{ dispose: () => void }> = [];

  // Shared anatomical geometries (matches TacticalOperatorRig ~1.76m human scale)
  private readonly geoPelvis: THREE.CylinderGeometry;
  private readonly geoBelt: THREE.CylinderGeometry;
  private readonly geoAbdomen: THREE.CylinderGeometry;
  private readonly geoChest: THREE.CylinderGeometry;
  private readonly geoVestPlate: THREE.BoxGeometry;
  private readonly geoVestStrap: THREE.BoxGeometry;
  private readonly geoRibDetail: THREE.BoxGeometry;
  private readonly geoTornFlap: THREE.BoxGeometry;

  private readonly geoNeck: THREE.CylinderGeometry;
  private readonly geoHelmetShell: THREE.SphereGeometry;
  private readonly geoVisor: THREE.BoxGeometry;
  private readonly geoRespirator: THREE.CylinderGeometry;

  private readonly geoShoulderCap: THREE.SphereGeometry;
  private readonly geoUpperArm: THREE.CylinderGeometry;
  private readonly geoElbowJoint: THREE.SphereGeometry;
  private readonly geoForearm: THREE.CylinderGeometry;
  private readonly geoPalm: THREE.BoxGeometry;
  private readonly geoFinger: THREE.BoxGeometry;
  private readonly geoBandageWrap: THREE.CylinderGeometry;

  private readonly geoThigh: THREE.CylinderGeometry;
  private readonly geoKneeCap: THREE.SphereGeometry;
  private readonly geoShin: THREE.CylinderGeometry;
  private readonly geoBootSole: THREE.BoxGeometry;
  private readonly geoBootVamp: THREE.BoxGeometry;
  private readonly geoBootShaft: THREE.CylinderGeometry;
  private readonly geoBootToe: THREE.SphereGeometry;

  private readonly archetypeMats: Record<InfectedArchetypeId, ZombieMaterialSet>;

  constructor() {
    const track = <T extends { dispose: () => void }>(res: T): T => {
      this.disposables.push(res);
      return res;
    };

    // Torso & Pelvis geometries
    this.geoPelvis = track(new THREE.CylinderGeometry(0.145, 0.132, 0.17, 10));
    this.geoBelt = track(new THREE.CylinderGeometry(0.15, 0.148, 0.055, 10));
    this.geoAbdomen = track(new THREE.CylinderGeometry(0.135, 0.122, 0.21, 10));
    this.geoChest = track(new THREE.CylinderGeometry(0.175, 0.138, 0.29, 10));
    this.geoVestPlate = track(new THREE.BoxGeometry(0.27, 0.30, 0.045));
    this.geoVestStrap = track(new THREE.BoxGeometry(0.052, 0.15, 0.16));
    this.geoRibDetail = track(new THREE.BoxGeometry(0.17, 0.022, 0.025));
    this.geoTornFlap = track(new THREE.BoxGeometry(0.13, 0.16, 0.022));

    // Neck & Archetype Headgear geometries (skull, face, eyes, jaw, and teeth use AnatomicalHeadBuilder)
    this.geoNeck = track(new THREE.CylinderGeometry(0.050, 0.064, 0.12, 8));
    this.geoHelmetShell = track(
      new THREE.SphereGeometry(0.118, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
    );
    this.geoVisor = track(new THREE.BoxGeometry(0.175, 0.056, 0.024));
    this.geoRespirator = track(new THREE.CylinderGeometry(0.038, 0.044, 0.062, 8));

    // 2-Segment Articulated Arms + Clawed Hands
    this.geoShoulderCap = track(new THREE.SphereGeometry(0.066, 8, 6));
    this.geoUpperArm = track(new THREE.CylinderGeometry(0.054, 0.045, 0.30, 8));
    this.geoElbowJoint = track(new THREE.SphereGeometry(0.046, 8, 6));
    this.geoForearm = track(new THREE.CylinderGeometry(0.044, 0.034, 0.28, 8));
    this.geoPalm = track(new THREE.BoxGeometry(0.068, 0.088, 0.032));
    this.geoFinger = track(new THREE.BoxGeometry(0.014, 0.062, 0.016));
    this.geoBandageWrap = track(new THREE.CylinderGeometry(0.048, 0.042, 0.12, 8));

    // 2-Segment Articulated Legs + Grounded Boots
    this.geoThigh = track(new THREE.CylinderGeometry(0.082, 0.066, 0.41, 8));
    this.geoKneeCap = track(new THREE.SphereGeometry(0.062, 8, 6));
    this.geoShin = track(new THREE.CylinderGeometry(0.062, 0.048, 0.40, 8));
    this.geoBootSole = track(new THREE.BoxGeometry(0.098, 0.024, 0.255));
    this.geoBootVamp = track(new THREE.BoxGeometry(0.092, 0.052, 0.195));
    this.geoBootShaft = track(new THREE.CylinderGeometry(0.052, 0.056, 0.115, 8));
    this.geoBootToe = track(new THREE.SphereGeometry(0.046, 8, 6));

    // Shared procedural PBR textures
    const skinTex = track(buildNecroticSkinTexture());
    const guardTopTex = track(buildTatteredFabricTexture('#2c322c', '#1e241e', 1.25, 3101));
    const guardPantsTex = track(buildTatteredFabricTexture('#242824', '#181b18', 0.9, 3102));
    const hazmatTex = track(buildTatteredFabricTexture('#8c7a38', '#685a26', 1.4, 3201));
    const hazmatPantsTex = track(buildTatteredFabricTexture('#6e6132', '#4c4322', 1.1, 3202));
    const civCoatTex = track(buildTatteredFabricTexture('#3b3330', '#251f1d', 1.45, 3301));
    const civPantsTex = track(buildTatteredFabricTexture('#272d36', '#1b2028', 0.85, 3302));

    const sharedSkin = track(
      new THREE.MeshStandardMaterial({
        map: skinTex,
        roughness: 0.88,
        metalness: 0.03,
      }),
    );
    const sharedBlood = track(
      new THREE.MeshStandardMaterial({
        color: 0x521010,
        roughness: 0.42,
        metalness: 0.08,
      }),
    );
    const sharedBootLeather = track(
      new THREE.MeshStandardMaterial({
        color: 0x1c1a18,
        roughness: 0.78,
        metalness: 0.1,
      }),
    );
    const sharedBootSole = track(
      new THREE.MeshStandardMaterial({
        color: 0x101112,
        roughness: 0.92,
        metalness: 0.05,
      }),
    );
    const sharedVisor = track(
      new THREE.MeshStandardMaterial({
        color: 0x26323a,
        roughness: 0.22,
        metalness: 0.42,
        transparent: true,
        opacity: 0.62,
      }),
    );

    const guardGearMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x202521,
        roughness: 0.82,
        metalness: 0.18,
      }),
    );
    const hazmatGearMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x222629,
        roughness: 0.65,
        metalness: 0.32,
      }),
    );
    const bandageMat = track(
      new THREE.MeshStandardMaterial({
        color: 0x8f8878,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );

    this.archetypeMats = {
      quarantine_guard: {
        skin: sharedSkin,
        clothesTop: track(
          new THREE.MeshStandardMaterial({ map: guardTopTex, roughness: 0.92, metalness: 0.03 }),
        ),
        clothesPants: track(
          new THREE.MeshStandardMaterial({ map: guardPantsTex, roughness: 0.92, metalness: 0.02 }),
        ),
        gearAccent: guardGearMat,
        bloodMat: sharedBlood,
        bootLeather: sharedBootLeather,
        bootSole: sharedBootSole,
        visorMat: sharedVisor,
      },
      hazmat_tech: {
        skin: sharedSkin,
        clothesTop: track(
          new THREE.MeshStandardMaterial({ map: hazmatTex, roughness: 0.72, metalness: 0.08 }),
        ),
        clothesPants: track(
          new THREE.MeshStandardMaterial({ map: hazmatPantsTex, roughness: 0.76, metalness: 0.06 }),
        ),
        gearAccent: hazmatGearMat,
        bloodMat: sharedBlood,
        bootLeather: sharedBootLeather,
        bootSole: sharedBootSole,
        visorMat: sharedVisor,
      },
      infected_civilian: {
        skin: sharedSkin,
        clothesTop: track(
          new THREE.MeshStandardMaterial({ map: civCoatTex, roughness: 0.94, metalness: 0.02 }),
        ),
        clothesPants: track(
          new THREE.MeshStandardMaterial({ map: civPantsTex, roughness: 0.92, metalness: 0.02 }),
        ),
        gearAccent: bandageMat,
        bloodMat: sharedBlood,
        bootLeather: sharedBootLeather,
        bootSole: sharedBootSole,
        visorMat: sharedVisor,
      },
    };
  }

  public buildZombie(actorId: string, forcedArchetype?: InfectedArchetypeId): BuiltInfectedZombieRig {
    const h = hashString(actorId);
    const archetypes: readonly InfectedArchetypeId[] = [
      'quarantine_guard',
      'hazmat_tech',
      'infected_civilian',
    ];
    const archetype = forcedArchetype ?? archetypes[h % archetypes.length];
    const mats = this.archetypeMats[archetype];
    const hitMeshes: THREE.Mesh[] = [];

    const makeMesh = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      hitZone?: 'head' | 'thorax' | 'limb',
      castShadow = false,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = castShadow;
      m.receiveShadow = true;
      if (hitZone) {
        m.userData = {
          combatActorType: 'zombie',
          actorId,
          hitZone,
          surfaceMaterial: 'wood',
        };
        hitMeshes.push(m);
      }
      return m;
    };

    const thighLen = 0.41;
    const shinLen = 0.40;
    const ankleHeight = 0.085;
    const restPelvisY = thighLen + shinLen + ankleHeight; // 0.895m matching TacticalOperatorRig
    const upperArmLen = 0.30;
    const lowerArmLen = 0.28;
    const heightScale = 0.95 + ((h % 11) / 10) * 0.1;

    const root = new THREE.Group();
    const bodyPivot = new THREE.Group();
    bodyPivot.scale.setScalar(heightScale);
    root.add(bodyPivot);

    // === PELVIS GROUP ===
    const pelvisGroup = new THREE.Group();
    pelvisGroup.position.set(0, restPelvisY, 0);
    bodyPivot.add(pelvisGroup);

    const pelvisMesh = makeMesh(this.geoPelvis, mats.clothesPants, 'thorax', true);
    pelvisMesh.scale.set(1.02, 1.0, 0.7);
    const beltMesh = makeMesh(this.geoBelt, mats.gearAccent);
    beltMesh.scale.set(1.04, 1.0, 0.72);
    beltMesh.position.set(0, 0.06, 0);
    pelvisGroup.add(pelvisMesh, beltMesh);

    // === ARTICULATED 2-SEGMENT LEGS + BOOTS ===
    const buildLeg = (side: -1 | 1) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.105, -0.02, 0);

      const thigh = makeMesh(this.geoThigh, mats.clothesPants, 'limb', true);
      thigh.position.set(0, -thighLen * 0.5, 0);
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.set(0, -thighLen, 0);
      hip.add(knee);

      const kneeCap = makeMesh(
        this.geoKneeCap,
        archetype === 'quarantine_guard' ? mats.gearAccent : mats.clothesPants,
      );
      kneeCap.scale.set(0.95, 0.95, 0.72);
      kneeCap.position.set(0, 0, -0.025);

      const shin = makeMesh(this.geoShin, mats.clothesPants, 'limb');
      shin.position.set(0, -shinLen * 0.5, 0);
      knee.add(kneeCap, shin);

      const ankle = new THREE.Group();
      ankle.position.set(0, -shinLen, 0);
      knee.add(ankle);

      // Grounded multi-part boot sitting cleanly at local y = -ankleHeight
      const sole = makeMesh(this.geoBootSole, mats.bootSole);
      sole.position.set(0, -ankleHeight + 0.012, -0.042);
      const vamp = makeMesh(this.geoBootVamp, mats.bootLeather);
      vamp.position.set(0, -ankleHeight + 0.044, -0.032);
      const shaft = makeMesh(this.geoBootShaft, mats.bootLeather);
      shaft.position.set(0, -0.012, 0.005);
      const toe = makeMesh(this.geoBootToe, mats.bootLeather);
      toe.scale.set(0.95, 0.65, 1.15);
      toe.position.set(0, -ankleHeight + 0.036, -0.145);
      ankle.add(sole, vamp, shaft, toe);

      return { hip, knee, ankle };
    };

    const leftLeg = buildLeg(-1);
    const rightLeg = buildLeg(1);
    pelvisGroup.add(leftLeg.hip, rightLeg.hip);

    // === ARTICULATED SPINE (Lower Abdomen -> Upper Thorax) ===
    const spineLower = new THREE.Group();
    spineLower.position.set(0, 0.04, 0);
    pelvisGroup.add(spineLower);

    const abdomen = makeMesh(this.geoAbdomen, mats.clothesTop, 'thorax', true);
    abdomen.scale.set(0.98, 1.0, 0.68);
    abdomen.position.set(0, 0.105, 0);
    spineLower.add(abdomen);

    const spineUpper = new THREE.Group();
    spineUpper.position.set(0, 0.21, 0);
    spineLower.add(spineUpper);

    const chest = makeMesh(this.geoChest, mats.clothesTop, 'thorax', true);
    chest.scale.set(1.06, 1.0, 0.66);
    chest.position.set(0, 0.145, 0);
    spineUpper.add(chest);

    // Bloodied chest wound / tattered gear details by archetype
    const chestStain = makeMesh(this.geoVestPlate, mats.bloodMat);
    chestStain.scale.set(0.74, 0.66, 0.5);
    chestStain.position.set(0.02, 0.14, -0.102);
    spineUpper.add(chestStain);

    if (archetype === 'quarantine_guard') {
      const frontPlate = makeMesh(this.geoVestPlate, mats.gearAccent, 'thorax');
      frontPlate.position.set(0, 0.14, -0.11);
      const backPlate = makeMesh(this.geoVestPlate, mats.gearAccent, 'thorax');
      backPlate.position.set(0, 0.14, 0.11);
      spineUpper.add(frontPlate, backPlate);
      for (const side of [-1, 1]) {
        const strap = makeMesh(this.geoVestStrap, mats.gearAccent);
        strap.position.set(side * 0.105, 0.27, 0);
        strap.rotation.z = -side * 0.15;
        spineUpper.add(strap);
      }
    } else if (archetype === 'hazmat_tech') {
      // Torn hazmat shoulder straps & hanging flap
      for (const side of [-1, 1]) {
        const strap = makeMesh(this.geoVestStrap, mats.gearAccent);
        strap.scale.set(0.7, 1.0, 0.9);
        strap.position.set(side * 0.095, 0.265, 0);
        spineUpper.add(strap);
      }
      const flap = makeMesh(this.geoTornFlap, mats.clothesTop);
      flap.position.set(-0.08, 0.03, -0.115);
      flap.rotation.set(0.18, 0.12, -0.25);
      spineUpper.add(flap);
    } else {
      // Infected civilian: torn shirt exposing subtle shadowed rib contour + ragged jacket lapel
      for (let r = 0; r < 3; r++) {
        const rib = makeMesh(this.geoRibDetail, mats.bloodMat);
        rib.position.set(0.01, 0.19 - r * 0.048, -0.112);
        spineUpper.add(rib);
      }
      const flap = makeMesh(this.geoTornFlap, mats.clothesTop);
      flap.position.set(0.11, 0.05, -0.108);
      flap.rotation.set(0.14, -0.18, 0.2);
      spineUpper.add(flap);
    }

    // === NECK, ANATOMICAL HEAD (15 MORPHS + EYE TRACKING) & ARTICULATED JAW ===
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 0.305, -0.01);
    spineUpper.add(neckPivot);

    const neckMesh = makeMesh(this.geoNeck, mats.skin, 'head');
    neckMesh.position.set(0, 0.04, 0);
    neckPivot.add(neckMesh);

    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.105, -0.005);
    neckPivot.add(headGroup);

    // Articulated Lower Jaw Pivot mounted at TMJ hinge relative to headAssembly (-0.015 Y offset)
    const jawPivot = new THREE.Group();
    jawPivot.position.set(0, 0.057, -0.020);
    headGroup.add(jawPivot);

    const headAssembly = buildAnatomicalHeadAssembly({
      variant: 'zombie',
      toneSeed: h,
      anisotropy: 2,
      hoodMaterial: mats.skin,
      frameMaterial: mats.gearAccent,
      jawParentForLowerTeeth: jawPivot,
      lowerTeethInJawOffset: [0, -0.023, -0.048],
      includeGearAndEyewear: false,
    });
    headAssembly.root.position.set(0, -0.015, 0);
    headGroup.add(headAssembly.root);

    for (let i = 0; i < headAssembly.disposables.length; i++) {
      this.disposables.push(headAssembly.disposables[i]);
    }
    headAssembly.headMesh.userData = {
      combatActorType: 'zombie',
      actorId,
      hitZone: 'head',
      surfaceMaterial: 'wood',
    };
    hitMeshes.push(headAssembly.headMesh);

    // Archetype headgear accents (skewed riot helmet / respirator canister with >= 4mm facial clearance)
    if (archetype === 'quarantine_guard') {
      const helmet = makeMesh(this.geoHelmetShell, mats.gearAccent, 'head');
      helmet.position.set(0, 0.088, 0.002);
      helmet.rotation.set(-0.08, 0, (h & 1 ? 1 : -1) * 0.09);
      const visor = makeMesh(this.geoVisor, mats.visorMat);
      visor.position.set(0, 0.105, -0.108);
      visor.rotation.x = -0.35;
      headGroup.add(helmet, visor);
    } else if (archetype === 'hazmat_tech') {
      // Torn respirator hanging crooked off lower cheek
      const resp = makeMesh(this.geoRespirator, mats.gearAccent);
      resp.position.set(0.052, 0.018, -0.098);
      resp.rotation.set(0.45, 0.25, -0.3);
      headGroup.add(resp);
    }

    // === ARTICULATED 2-SEGMENT ARMS + CLAWED HANDS ===
    const buildArm = (side: -1 | 1) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.205, 0.255, -0.012);

      const cap = makeMesh(this.geoShoulderCap, mats.clothesTop);
      const upperArm = makeMesh(this.geoUpperArm, mats.clothesTop, 'limb', true);
      upperArm.position.set(0, -upperArmLen * 0.5, 0);
      shoulder.add(cap, upperArm);

      const elbow = new THREE.Group();
      elbow.position.set(0, -upperArmLen, 0);
      shoulder.add(elbow);

      const elbowMesh = makeMesh(this.geoElbowJoint, mats.skin);
      const forearm = makeMesh(
        this.geoForearm,
        side === 1 && archetype === 'infected_civilian' ? mats.skin : mats.clothesTop,
        'limb',
      );
      forearm.position.set(0, -lowerArmLen * 0.5, 0);
      elbow.add(elbowMesh, forearm);

      if (side === -1 && archetype !== 'hazmat_tech') {
        const bandage = makeMesh(this.geoBandageWrap, mats.gearAccent);
        bandage.position.set(0, -lowerArmLen * 0.55, 0);
        elbow.add(bandage);
      }

      const handPivot = new THREE.Group();
      handPivot.position.set(0, -lowerArmLen, 0);
      elbow.add(handPivot);

      const palm = makeMesh(this.geoPalm, mats.skin, 'limb');
      palm.position.set(0, -0.044, 0);
      handPivot.add(palm);

      // 3 clawed finger clusters angled inward
      for (let f = -1; f <= 1; f++) {
        const finger = makeMesh(this.geoFinger, mats.skin);
        finger.position.set(f * 0.02, -0.105, -0.012);
        finger.rotation.x = 0.42 + Math.abs(f) * 0.1;
        handPivot.add(finger);
      }

      return { shoulder, elbow, handPivot };
    };

    const leftArm = buildArm(-1);
    const rightArm = buildArm(1);
    spineUpper.add(leftArm.shoulder, rightArm.shoulder);

    return {
      archetype,
      root,
      bodyPivot,
      pelvisGroup,
      spineLower,
      spineUpper,
      neckPivot,
      headGroup,
      jawPivot,
      headAssembly,
      facialController: new FacialExpressionController((h % 997) + 1),
      _facialInput: {
        mode: 'zombie',
        intent: 'shamble',
        stress01: 0.4,
        injury01: 0.5,
        flinchImpulse01: 0,
        gazeTargetWorld: null,
        distanceToCameraM: 0,
        isVisible: true,
      },
      leftHip: leftLeg.hip,
      leftKnee: leftLeg.knee,
      leftAnkle: leftLeg.ankle,
      rightHip: rightLeg.hip,
      rightKnee: rightLeg.knee,
      rightAnkle: rightLeg.ankle,
      leftShoulder: leftArm.shoulder,
      leftElbow: leftArm.elbow,
      leftHandPivot: leftArm.handPivot,
      rightShoulder: rightArm.shoulder,
      rightElbow: rightArm.elbow,
      rightHandPivot: rightArm.handPivot,
      hitMeshes,
      restPelvisY,
      limpSide: (h & 2) === 0 ? -1 : 1,
      headTiltBias: (((h >> 3) % 7) - 3) * 0.065,
      hunchBias: 0.16 + ((h >> 6) % 5) * 0.032,
      deathFallSide: (h & 4) === 0 ? -1 : 1,
      heightScale,
    };
  }

  /**
   * Zero-GC procedural anatomical pose evaluator covering shamble -> frantic sprint blend,
   * two-handed window plank tearing, 3-stage window sill climb/vault, melee lunge windup,
   * bullet hit stagger, and multi-joint buckling death collapse.
   */
  public applyPose(rig: BuiltInfectedZombieRig, input: Readonly<InfectedPoseInput>): void {
    // Reset base pivot transforms cleanly
    rig.bodyPivot.position.set(0, 0, 0);
    rig.bodyPivot.rotation.set(0, 0, 0);
    rig.pelvisGroup.position.set(0, rig.restPelvisY, 0);
    rig.pelvisGroup.rotation.set(0, 0, 0);

    if (input.mode === 'death') {
      const t = THREE.MathUtils.clamp(input.deathProgress, 0, 1);
      const ease = 1 - Math.pow(1 - t, 2.4);
      const buckle = Math.sin(Math.min(1, t * 1.65) * Math.PI * 0.5);
      const side = rig.deathFallSide;

      // Knees buckle first, then full body collapses onto floor
      rig.pelvisGroup.position.y = THREE.MathUtils.lerp(rig.restPelvisY, 0.16, ease);
      rig.pelvisGroup.position.z = ease * 0.34;
      rig.bodyPivot.rotation.set(-ease * 1.48, side * ease * 0.24, side * ease * 0.32);

      rig.leftHip.rotation.set(buckle * 0.85 - ease * 0.55, 0, -0.16 * ease);
      rig.leftKnee.rotation.set(buckle * 1.25 * (1 - ease * 0.5), 0, 0);
      rig.leftAnkle.rotation.set(-0.35 * ease, 0, 0);

      rig.rightHip.rotation.set(buckle * 0.55 - ease * 0.25, 0, 0.22 * ease);
      rig.rightKnee.rotation.set(buckle * 0.95 * (1 - ease * 0.45), 0, 0);
      rig.rightAnkle.rotation.set(-0.28 * ease, 0, 0);

      rig.spineLower.rotation.set(0.18 * ease, side * 0.18 * ease, 0);
      rig.spineUpper.rotation.set(0.14 * ease, -side * 0.12 * ease, side * 0.14 * ease);
      rig.neckPivot.rotation.set(-0.26 * ease, side * 0.35 * ease, side * 0.22 * ease);
      rig.headGroup.rotation.set(0.12 * ease, 0, 0);
      rig.jawPivot.rotation.x = 0.28 * ease;

      // Limbs splay naturally on ground
      rig.leftShoulder.rotation.set(0.42 * ease, 0, -0.85 * ease);
      rig.leftElbow.rotation.set(-0.55 * ease, 0, 0);
      rig.rightShoulder.rotation.set(0.68 * ease, 0, 0.62 * ease);
      rig.rightElbow.rotation.set(-0.78 * ease, 0, 0);
      this.stepZombieFacial(rig, input);
      return;
    }

    if (input.mode === 'vault') {
      const vt = THREE.MathUtils.clamp(input.vaultT, 0, 1);
      const lift = Math.sin(vt * Math.PI);
      const phaseA = Math.min(1, vt / 0.45);
      const phaseB = THREE.MathUtils.clamp((vt - 0.35) / 0.65, 0, 1);

      rig.pelvisGroup.position.y = rig.restPelvisY - 0.12 * lift;
      rig.pelvisGroup.rotation.set(0.32 * lift, 0, Math.sin(vt * Math.PI) * 0.14 * rig.limpSide);
      rig.spineLower.rotation.set(0.34 * lift, 0, 0);
      rig.spineUpper.rotation.set(0.28 * lift, 0, 0);
      rig.neckPivot.rotation.set(-0.32 * lift, 0, rig.headTiltBias);
      rig.headGroup.rotation.set(0, 0, 0);
      rig.jawPivot.rotation.x = 0.24 + lift * 0.18;

      // Alternating high knee-lift climb over window sill
      rig.leftHip.rotation.set(-1.35 * phaseA + 0.65 * phaseB, 0, -0.12);
      rig.leftKnee.rotation.set(1.55 * phaseA - 0.9 * phaseB, 0, 0);
      rig.leftAnkle.rotation.set(0.25, 0, 0);

      rig.rightHip.rotation.set(-0.45 * phaseA - 0.85 * Math.sin(phaseB * Math.PI), 0, 0.12);
      rig.rightKnee.rotation.set(0.55 * phaseA + 1.25 * Math.sin(phaseB * Math.PI), 0, 0);
      rig.rightAnkle.rotation.set(0.2, 0, 0);

      // Hands brace & push down off the window sill
      rig.leftShoulder.rotation.set(1.65 - 0.85 * phaseB, 0.18, -0.18);
      rig.leftElbow.rotation.set(-0.75 - 0.35 * lift, 0, 0);
      rig.leftHandPivot.rotation.set(0.45, 0, 0);
      rig.rightShoulder.rotation.set(1.55 - 0.82 * phaseB, -0.18, 0.18);
      rig.rightElbow.rotation.set(-0.68 - 0.35 * lift, 0, 0);
      rig.rightHandPivot.rotation.set(0.45, 0, 0);
      this.stepZombieFacial(rig, input);
      return;
    }

    if (input.mode === 'tear') {
      const p = input.tearPhase;
      const pull = Math.sin(p);
      const heave = Math.cos(p);

      rig.pelvisGroup.position.y = rig.restPelvisY - 0.055 + heave * 0.022;
      rig.pelvisGroup.rotation.set(0.06, pull * 0.12, 0);
      rig.spineLower.rotation.set(0.18 + pull * 0.12, pull * 0.14, 0);
      rig.spineUpper.rotation.set(0.16 + pull * 0.1, -pull * 0.16, 0.06 * pull);
      rig.neckPivot.rotation.set(-0.18 - pull * 0.12, 0, rig.headTiltBias * 1.2);
      rig.headGroup.rotation.set(0, 0, 0);
      rig.jawPivot.rotation.x = 0.22 + Math.abs(pull) * 0.26;

      // Braced staggered stance
      rig.leftHip.rotation.set(-0.26, 0, -0.06);
      rig.leftKnee.rotation.set(0.32, 0, 0);
      rig.leftAnkle.rotation.set(-0.08, 0, 0);
      rig.rightHip.rotation.set(0.22, 0, 0.06);
      rig.rightKnee.rotation.set(0.22, 0, 0);
      rig.rightAnkle.rotation.set(-0.14, 0, 0);

      // Alternating aggressive two-handed plank clawing & wrenching
      rig.leftShoulder.rotation.set(1.88 + pull * 0.42, 0.22, -0.14);
      rig.leftElbow.rotation.set(-0.72 - Math.max(0, pull) * 0.48, 0, 0);
      rig.leftHandPivot.rotation.set(0.38, 0, 0);

      rig.rightShoulder.rotation.set(1.78 - pull * 0.36, -0.22, 0.14);
      rig.rightElbow.rotation.set(-0.72 - Math.max(0, -pull) * 0.48, 0, 0);
      rig.rightHandPivot.rotation.set(0.38, 0, 0);
      this.stepZombieFacial(rig, input);
      return;
    }

    // Locomotion / Windup / Stagger
    const sprintBlend = THREE.MathUtils.clamp((input.speedMps - 1.9) / 2.2, 0, 1);
    const moveBlend = THREE.MathUtils.clamp(input.speedMps / 0.8, 0, 1);
    const wc = input.walkCycle;
    const sinW = Math.sin(wc);
    const cosW = Math.cos(wc);
    const limp = rig.limpSide;

    // Asymmetric stride: shamblers drag one leg; sprinters drive both knees hard
    const leftAmp = moveBlend * (0.42 + sprintBlend * 0.44) * (limp < 0 ? 0.62 + sprintBlend * 0.38 : 1.0);
    const rightAmp = moveBlend * (0.42 + sprintBlend * 0.44) * (limp > 0 ? 0.62 + sprintBlend * 0.38 : 1.0);

    const lLegPhase = sinW;
    const rLegPhase = -sinW;
    const lLift = Math.max(0, cosW);
    const rLift = Math.max(0, -cosW);

    // Pelvis bob, limp drop & lateral sway
    const limpDrop = (1 - sprintBlend) * 0.045 * Math.max(0, limp * sinW);
    const bounce = Math.abs(sinW) * (0.025 + sprintBlend * 0.042) * moveBlend;
    rig.pelvisGroup.position.y = rig.restPelvisY - 0.045 - sprintBlend * 0.065 - limpDrop + bounce;
    rig.pelvisGroup.rotation.set(
      0.06 + sprintBlend * 0.14,
      sinW * (0.11 + sprintBlend * 0.08) * moveBlend,
      limp * (0.075 * (1 - sprintBlend)) + cosW * 0.065 * moveBlend,
    );

    // Legs (2-segment hip + knee flexion + ankle pitch)
    rig.leftHip.rotation.set(lLegPhase * leftAmp - 0.06, 0, -0.04);
    rig.leftKnee.rotation.set(
      0.16 + lLift * (0.55 + sprintBlend * 0.52) * moveBlend + (limp < 0 ? (1 - sprintBlend) * 0.16 : 0),
      0,
      0,
    );
    rig.leftAnkle.rotation.set(-lLegPhase * 0.22 * moveBlend, 0, 0);

    rig.rightHip.rotation.set(rLegPhase * rightAmp - 0.06, 0, 0.04);
    rig.rightKnee.rotation.set(
      0.16 + rLift * (0.55 + sprintBlend * 0.52) * moveBlend + (limp > 0 ? (1 - sprintBlend) * 0.16 : 0),
      0,
      0,
    );
    rig.rightAnkle.rotation.set(-rLegPhase * 0.22 * moveBlend, 0, 0);

    // Hunched twisted spine + bullet hit stagger recoil
    const stag = THREE.MathUtils.clamp(input.staggerRatio, 0, 1);
    const hunch = rig.hunchBias + sprintBlend * 0.26 - stag * 0.48;
    rig.spineLower.rotation.set(hunch * 0.58, -sinW * 0.14 * moveBlend, limp * 0.06);
    rig.spineUpper.rotation.set(
      hunch * 0.52 - stag * 0.22,
      -sinW * (0.16 + sprintBlend * 0.1) * moveBlend,
      -limp * 0.08 + cosW * 0.05 * moveBlend,
    );

    // Uncanny crooked twitching head & snapping jaw
    const twitch = Math.sin(input.elapsedSec * 7.3 + rig.headTiltBias * 14) * 0.045;
    rig.neckPivot.rotation.set(-hunch * 0.55 - stag * 0.35, sinW * 0.08, rig.headTiltBias + twitch);
    rig.headGroup.rotation.set(-0.08 - stag * 0.18, twitch * 1.2, 0);

    const isWindup = input.mode === 'windup' || input.windupProgress > 0.01;
    if (isWindup) {
      const wp = THREE.MathUtils.clamp(input.windupProgress, 0, 1);
      // Coiled overhead pull-back -> violent snapping slash
      const slash = wp < 0.55 ? -(wp / 0.55) : (wp - 0.55) / 0.45;
      rig.spineUpper.rotation.x += slash * 0.38;
      rig.spineUpper.rotation.y += slash * 0.22;
      rig.jawPivot.rotation.x = 0.48 + Math.max(0, slash) * 0.18;

      rig.leftShoulder.rotation.set(2.35 - slash * 1.15, 0.28, -0.26);
      rig.leftElbow.rotation.set(-0.85 + slash * 0.42, 0, 0);
      rig.leftHandPivot.rotation.set(0.32, 0, 0);

      rig.rightShoulder.rotation.set(2.45 - slash * 1.25, -0.28, 0.26);
      rig.rightElbow.rotation.set(-0.92 + slash * 0.46, 0, 0);
      rig.rightHandPivot.rotation.set(0.32, 0, 0);
    } else if (stag > 0.05) {
      rig.jawPivot.rotation.x = 0.36 * stag;
      rig.leftShoulder.rotation.set(1.15 - stag * 0.65, 0.15, -0.35 * stag);
      rig.leftElbow.rotation.set(-0.95, 0, 0);
      rig.rightShoulder.rotation.set(1.05 - stag * 0.55, -0.15, 0.35 * stag);
      rig.rightElbow.rotation.set(-0.88, 0, 0);
    } else {
      // Grasping reaching arms with organic elbow bend & sprint drive
      const baseArmReach = 1.22 + sprintBlend * 0.34;
      const armSwing = (0.22 + sprintBlend * 0.36) * moveBlend;
      rig.jawPivot.rotation.x = 0.12 + sprintBlend * 0.24 + Math.max(0, sinW) * 0.08;

      rig.leftShoulder.rotation.set(
        baseArmReach - sinW * armSwing,
        0.16 + sinW * 0.1,
        -0.14 - sprintBlend * 0.06,
      );
      rig.leftElbow.rotation.set(-0.62 - sprintBlend * 0.38 - Math.max(0, -sinW) * 0.24, 0, 0);
      rig.leftHandPivot.rotation.set(0.28, 0, -0.12);

      rig.rightShoulder.rotation.set(
        baseArmReach + sinW * armSwing - 0.12,
        -0.16 - sinW * 0.1,
        0.14 + sprintBlend * 0.06,
      );
      rig.rightElbow.rotation.set(-0.74 - sprintBlend * 0.34 - Math.max(0, sinW) * 0.24, 0, 0);
      rig.rightHandPivot.rotation.set(0.28, 0, 0.12);
    }

    this.stepZombieFacial(rig, input);
  }

  private stepZombieFacial(rig: BuiltInfectedZombieRig, input: Readonly<InfectedPoseInput>): void {
    const f = rig._facialInput;
    f.mode = 'zombie';
    let intent: FacialExpressionIntent = 'shamble';
    if (input.mode === 'death') {
      intent = 'dead';
    } else if (input.mode === 'stagger' || input.staggerRatio > 0.05) {
      intent = 'stagger';
    } else if (input.mode === 'windup' || input.windupProgress > 0.05) {
      intent = 'lunge';
    } else if (input.mode === 'tear' || input.mode === 'vault' || input.speedMps > 2.0) {
      intent = 'aggro';
    }
    f.intent = intent;
    f.stress01 = input.mode === 'tear' || input.mode === 'windup' ? 0.95 : THREE.MathUtils.clamp(input.speedMps / 4.0, 0.2, 0.95);
    f.injury01 = 0.7;
    f.flinchImpulse01 = THREE.MathUtils.clamp(input.staggerRatio, 0, 1);
    f.gazeTargetWorld = input.gazeTargetWorld ?? null;
    f.distanceToCameraM = input.distanceToCameraM ?? 0;
    f.isVisible = input.isVisible ?? rig.root.visible;

    const evalDt = input.dt ?? 0.05;
    rig.facialController.step(
      evalDt,
      f,
      rig.headAssembly.root,
      rig.headAssembly.morphTargetInfluences,
      rig.headAssembly.eyeL,
      rig.headAssembly.eyeR,
      rig.jawPivot,
    );
  }

  public dispose(): void {
    for (let i = 0; i < this.disposables.length; i++) {
      this.disposables[i].dispose();
    }
    this.disposables.length = 0;
  }
}

import * as THREE from 'three';
import { LimbId } from '../../data/traumaConfig';
import { HoldClass } from '../../data/weapons';
import {
  buildAnatomicalHeadAssembly,
  BuiltAnatomicalHeadAssembly,
} from '../../bodycam-sdk/character/AnatomicalHeadBuilder';

export interface ArticulatedFinger {
  proximal: THREE.Group;
  middle: THREE.Group;
  distal: THREE.Group;
}

export interface ArticulatedHand {
  root: THREE.Group;
  palm: THREE.Mesh;
  side: -1 | 1;
  thumbProx: THREE.Group;
  thumbDist: THREE.Group;
  index: ArticulatedFinger;
  middle: ArticulatedFinger;
  ring: ArticulatedFinger;
  pinky: ArticulatedFinger;
}

export interface ArticulatedArm {
  clavicle: THREE.Group;
  shoulderPivot: THREE.Object3D;
  upperArm: THREE.Group;
  forearm: THREE.Group;
  hand: ArticulatedHand;
  upperLen: number;
  lowerLen: number;
}

export interface ArticulatedLeg {
  hipPivot: THREE.Object3D;
  thigh: THREE.Group;
  shin: THREE.Group;
  boot: THREE.Group;
  upperLen: number;
  lowerLen: number;
  ankleHeight: number;
}

interface ProceduralFabricSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function hash2(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 53.3) * 43758.5453123;
  return n - Math.floor(n);
}

function buildFabricTextureSet(
  baseRgb: [number, number, number],
  weaveContrast: number,
  wearStrength: number,
  roughBase: number,
  seed: number,
  anisotropy: number,
): ProceduralFabricSet {
  const size = 128;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const actx = albedo.getContext('2d')!;
  const aimg = actx.createImageData(size, size);

  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rctx = rough.getContext('2d')!;
  const rimg = rctx.createImageData(size, size);

  const norm = document.createElement('canvas');
  norm.width = size;
  norm.height = size;
  const nctx = norm.getContext('2d')!;
  const nimg = nctx.createImageData(size, size);

  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Ripstop crosshatch grid + fine thread twill
      const rip = (x % 8 === 0 || y % 8 === 0) ? 1 : 0;
      const twill = ((x + y) % 2 === 0 ? 0.5 : -0.5) * weaveContrast;
      const dirt = (hash2(Math.floor(x / 6), Math.floor(y / 6), seed) - 0.5) * wearStrength;
      const grain = (hash2(x, y, seed + 7) - 0.5) * 0.08;

      const shade = 1 + twill + dirt + grain - rip * 0.06;
      const idx = (y * size + x) * 4;
      aimg.data[idx] = THREE.MathUtils.clamp(Math.round(baseRgb[0] * shade), 8, 240);
      aimg.data[idx + 1] = THREE.MathUtils.clamp(Math.round(baseRgb[1] * shade), 8, 240);
      aimg.data[idx + 2] = THREE.MathUtils.clamp(Math.round(baseRgb[2] * shade), 8, 240);
      aimg.data[idx + 3] = 255;

      const rVal = THREE.MathUtils.clamp(Math.round((roughBase + dirt * 0.25 - rip * 0.04) * 255), 80, 252);
      rimg.data[idx] = rVal;
      rimg.data[idx + 1] = rVal;
      rimg.data[idx + 2] = rVal;
      rimg.data[idx + 3] = 255;

      heights[y * size + x] = rip * 0.35 + twill * 0.8 + grain;
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = (heights[y * size + xp] - heights[y * size + xm]) * 2.2;
      const dy = (heights[yp * size + x] - heights[ym * size + x]) * 2.2;
      const len = Math.hypot(dx, dy, 1);
      const idx = (y * size + x) * 4;
      nimg.data[idx] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      nimg.data[idx + 3] = 255;
    }
  }

  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(2, 2);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;

  const normalMap = new THREE.CanvasTexture(norm);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(2, 2);
  normalMap.anisotropy = anisotropy;

  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.repeat.set(2, 2);
  roughnessMap.anisotropy = anisotropy;

  return { map, normalMap, roughnessMap };
}

/**
 * Full-body articulated first-person / shadow-casting character skeleton.
 * Hierarchy:
 *   root -> pelvis -> spineLower -> spineUpper -> chest -> headGroup (hidden in FPS)
 *                                                       -> clavicleL/R -> upperArm -> forearm -> hand
 *        -> thighL/R -> shinL/R -> bootL/R (driven via 2-bone IK in root space)
 */
export class CharacterSkeleton {
  public readonly root = new THREE.Group();
  public readonly pelvis = new THREE.Group();
  public readonly spineLower = new THREE.Group();
  public readonly spineUpper = new THREE.Group();
  public readonly chest = new THREE.Group();
  public readonly neck = new THREE.Group();
  public readonly headGroup = new THREE.Group();

  /** Chest pouch target anchor in chest local space (used for RELOAD left-hand reach) */
  public readonly magPouchAnchor = new THREE.Object3D();
  public readonly throwHandSocket = new THREE.Object3D();
  public readonly leftPinPinchSocket = new THREE.Object3D();
  public readonly leftPocketAnchor = new THREE.Object3D();
  public readonly leftEyeAimAnchor = new THREE.Object3D();
  public readonly leftChestBalanceAnchor = new THREE.Object3D();

  public readonly leftArm: ArticulatedArm;
  public readonly rightArm: ArticulatedArm;
  public readonly leftLeg: ArticulatedLeg;
  public readonly rightLeg: ArticulatedLeg;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly texSets: ProceduralFabricSet[] = [];
  private readonly selfHitMeshes: THREE.Object3D[] = [];

  private sleeveMat: THREE.MeshStandardMaterial;
  private pantsMat: THREE.MeshStandardMaterial;
  private vestMat: THREE.MeshStandardMaterial;
  private pouchMat: THREE.MeshStandardMaterial;
  private gloveMat: THREE.MeshStandardMaterial;
  private palmLeatherMat: THREE.MeshStandardMaterial;
  private wristSkinMat: THREE.MeshStandardMaterial;
  private knuckleMat: THREE.MeshStandardMaterial;
  private watchDialMat: THREE.MeshStandardMaterial;
  private bootMat: THREE.MeshStandardMaterial;
  private soleMat: THREE.MeshStandardMaterial;
  private hardwareMat: THREE.MeshStandardMaterial;
  private hoodMat: THREE.MeshStandardMaterial;
  private headAssembly: BuiltAnatomicalHeadAssembly | null = null;

  constructor(maxAnisotropy = 4) {
    const aniso = Math.min(8, Math.max(1, maxAnisotropy));

    const sleeveTex = buildFabricTextureSet([68, 76, 58], 0.08, 0.14, 0.88, 17, aniso);
    const pantsTex = buildFabricTextureSet([58, 60, 52], 0.09, 0.18, 0.90, 43, aniso);
    const vestTex = buildFabricTextureSet([78, 72, 54], 0.12, 0.14, 0.84, 71, aniso);
    const bootTex = buildFabricTextureSet([38, 35, 31], 0.04, 0.22, 0.72, 109, aniso);
    const gloveTex = buildFabricTextureSet([44, 46, 42], 0.14, 0.18, 0.78, 137, aniso);
    const palmTex = buildFabricTextureSet([60, 54, 46], 0.10, 0.22, 0.88, 173, aniso);
    this.texSets.push(sleeveTex, pantsTex, vestTex, bootTex, gloveTex, palmTex);

    this.sleeveMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: sleeveTex.map,
        normalMap: sleeveTex.normalMap,
        roughnessMap: sleeveTex.roughnessMap,
        roughness: 0.92,
        metalness: 0.03,
      }),
    );
    this.pantsMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: pantsTex.map,
        normalMap: pantsTex.normalMap,
        roughnessMap: pantsTex.roughnessMap,
        roughness: 0.94,
        metalness: 0.03,
      }),
    );
    this.vestMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: vestTex.map,
        normalMap: vestTex.normalMap,
        roughnessMap: vestTex.roughnessMap,
        roughness: 0.86,
        metalness: 0.06,
      }),
    );
    this.pouchMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: vestTex.map,
        normalMap: vestTex.normalMap,
        color: 0xbab39d,
        roughness: 0.88,
        metalness: 0.05,
      }),
    );
    this.gloveMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: gloveTex.map,
        normalMap: gloveTex.normalMap,
        roughnessMap: gloveTex.roughnessMap,
        roughness: 0.80,
        metalness: 0.06,
      }),
    );
    this.palmLeatherMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: palmTex.map,
        normalMap: palmTex.normalMap,
        roughnessMap: palmTex.roughnessMap,
        roughness: 0.88,
        metalness: 0.04,
      }),
    );
    this.wristSkinMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x9f7c67,
        roughness: 0.72,
        metalness: 0.02,
      }),
    );
    this.knuckleMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x17191b,
        roughness: 0.38,
        metalness: 0.28,
      }),
    );
    this.watchDialMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x0d1210,
        emissive: 0x15281f,
        emissiveIntensity: 0.65,
        roughness: 0.18,
        metalness: 0.25,
      }),
    );
    this.bootMat = this.mat(
      new THREE.MeshStandardMaterial({
        map: bootTex.map,
        normalMap: bootTex.normalMap,
        roughnessMap: bootTex.roughnessMap,
        roughness: 0.76,
        metalness: 0.08,
      }),
    );
    this.soleMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x181818,
        roughness: 0.95,
        metalness: 0.04,
      }),
    );
    this.hardwareMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x202225,
        roughness: 0.36,
        metalness: 0.72,
      }),
    );
    this.hoodMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x252822,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );

    // Helper for rounded/chamfered extruded shapes (plate carrier, pouches, buckle)
    const createChamferedShape = (w: number, h: number, r: number, topTaper = 0): THREE.Shape => {
      const hw = w * 0.5;
      const hh = h * 0.5;
      const rr = Math.min(r, hw * 0.45, hh * 0.45);
      const topW = hw - topTaper;
      const s = new THREE.Shape();
      s.moveTo(-hw + rr, -hh);
      s.lineTo(hw - rr, -hh);
      s.quadraticCurveTo(hw, -hh, hw, -hh + rr);
      s.lineTo(topW, hh - rr);
      s.quadraticCurveTo(topW, hh, topW - rr, hh);
      s.lineTo(-topW + rr, hh);
      s.quadraticCurveTo(-topW, hh, -topW, hh - rr);
      s.lineTo(-hw, -hh + rr);
      s.quadraticCurveTo(-hw, -hh, -hw + rr, -hh);
      return s;
    };

    const createSapiPlateGeo = (w: number, h: number, depth: number): THREE.ExtrudeGeometry => {
      const hw = w * 0.5;
      const hh = h * 0.5;
      const shoulderCutX = hw * 0.46;
      const shoulderCutY = hh * 0.56;
      const s = new THREE.Shape();
      s.moveTo(-hw + 0.015, -hh);
      s.lineTo(hw - 0.015, -hh);
      s.quadraticCurveTo(hw, -hh, hw, -hh + 0.018);
      s.lineTo(hw, shoulderCutY);
      s.lineTo(shoulderCutX, hh);
      s.lineTo(-shoulderCutX, hh);
      s.lineTo(-hw, shoulderCutY);
      s.lineTo(-hw, -hh + 0.018);
      s.quadraticCurveTo(-hw, -hh, -hw + 0.015, -hh);
      const geo = new THREE.ExtrudeGeometry(s, {
        depth,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.009,
        bevelThickness: 0.008,
      });
      geo.center();
      return geo;
    };

    const createRoundedPouchGeo = (w: number, h: number, depth: number, radius = 0.012): THREE.ExtrudeGeometry => {
      const shape = createChamferedShape(w, h, radius, 0.003);
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.006,
        bevelThickness: 0.006,
      });
      geo.center();
      return geo;
    };

    // --- Pelvis & Tactical Belt (Organic tapered ellipse, tucked behind camera z=+0.06m) ---
    this.pelvis.position.set(0, 0.86, 0.21);
    this.root.add(this.pelvis);

    const pelvisMesh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.146, 0.154, 0.14, 16)), this.pantsMat);
    pelvisMesh.scale.set(1.06, 1.0, 0.68);
    pelvisMesh.position.set(0, -0.02, 0);
    this.pelvis.add(pelvisMesh);

    const beltMesh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.152, 0.154, 0.044, 16)), this.vestMat);
    beltMesh.scale.set(1.07, 1.0, 0.69);
    beltMesh.position.set(0, 0.052, 0);
    this.pelvis.add(beltMesh);

    const buckleMesh = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.048, 0.036, 0.014, 0.006)), this.hardwareMat);
    buckleMesh.position.set(0, 0.052, -0.105);
    this.pelvis.add(buckleMesh);

    // Soft contoured hip dump pouch & drop holster
    const dumpPouch = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.088, 0.115, 0.034, 0.016)), this.pouchMat);
    dumpPouch.rotation.y = Math.PI * 0.5;
    dumpPouch.position.set(-0.165, -0.02, 0.01);
    const holster = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.078, 0.135, 0.028, 0.014)), this.hardwareMat);
    holster.rotation.y = -Math.PI * 0.5;
    holster.position.set(0.165, -0.04, -0.005);
    this.pelvis.add(dumpPouch, holster);

    // --- Spine Hierarchy (Anatomical taper & slimmer profile) ---
    this.spineLower.position.set(0, 0.07, 0);
    this.pelvis.add(this.spineLower);

    const abdomen = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.142, 0.138, 0.15, 16)), this.sleeveMat);
    abdomen.scale.set(1.04, 1.0, 0.66);
    abdomen.position.set(0, 0.065, 0);
    this.spineLower.add(abdomen);

    this.spineUpper.position.set(0, 0.13, 0);
    this.spineLower.add(this.spineUpper);

    const midTorso = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.162, 0.142, 0.15, 16)), this.sleeveMat);
    midTorso.scale.set(1.06, 1.0, 0.66);
    midTorso.position.set(0, 0.065, 0);
    this.spineUpper.add(midTorso);

    this.chest.position.set(0, 0.13, 0);
    this.spineUpper.add(this.chest);

    // Upper Chest / Ribcage + Sculpted Trapezius Slope (sits cleanly below 1.42m collar camera)
    const upperTorso = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.148, 0.164, 0.145, 16)), this.sleeveMat);
    upperTorso.scale.set(1.12, 1.0, 0.64);
    upperTorso.position.set(0, 0.035, 0.005);
    this.chest.add(upperTorso);

    const trapSlope = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.155, 16, 10)), this.sleeveMat);
    trapSlope.scale.set(1.12, 0.34, 0.62);
    trapSlope.position.set(0, 0.10, 0.01);
    this.chest.add(trapSlope);

    // Sculpted SAPI-Cut Plate Carrier (beveled angled armor plates + cummerbund)
    const frontPlate = new THREE.Mesh(this.geo(createSapiPlateGeo(0.235, 0.235, 0.022)), this.vestMat);
    frontPlate.position.set(0, -0.022, -0.088);
    frontPlate.rotation.x = 0.06; // subtle backward chest-slope tilt so top doesn't jut out
    const backPlate = new THREE.Mesh(this.geo(createSapiPlateGeo(0.245, 0.255, 0.024)), this.vestMat);
    backPlate.position.set(0, -0.015, 0.102);
    backPlate.rotation.x = -0.04;
    this.chest.add(frontPlate, backPlate);

    // Contoured side cummerbund wrap
    const cummerbund = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.162, 0.155, 0.105, 16)), this.vestMat);
    cummerbund.scale.set(1.08, 1.0, 0.64);
    cummerbund.position.set(0, -0.095, 0.005);
    this.chest.add(cummerbund);

    // Contoured Shoulder Straps draping along the trap slope
    for (const side of [-1, 1]) {
      const strap = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.052, 0.022, 0.175, 0.008)), this.vestMat);
      strap.position.set(side * 0.098, 0.098, 0.008);
      strap.rotation.z = -side * 0.18;
      this.chest.add(strap);
    }

    // 3 Slim Contoured Front Mag Pouches tucked at lower chest / abdomen (y ~ 1.08m)
    for (let i = -1; i <= 1; i++) {
      const pouch = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.058, 0.102, 0.022, 0.010)), this.pouchMat);
      pouch.position.set(i * 0.070, -0.105, -0.106);
      pouch.rotation.set(0.08, -i * 0.14, 0);
      this.chest.add(pouch);

      const flap = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.056, 0.026, 0.024, 0.007)), this.vestMat);
      flap.position.set(i * 0.070, -0.058, -0.104);
      flap.rotation.set(0.08, -i * 0.14, 0);
      this.chest.add(flap);
    }

    // Left-hand RELOAD mag pouch target anchor
    this.magPouchAnchor.position.set(-0.072, -0.095, -0.135);
    this.chest.add(this.magPouchAnchor);

    // Slim Axon Bodycam Mount tucked on upper sternum (well behind camera lens plane)
    const camMount = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.052, 0.066, 0.016, 0.007)), this.hardwareMat);
    camMount.position.set(0.03, 0.042, -0.098);
    camMount.rotation.x = 0.08;
    this.chest.add(camMount);

    // --- Neck & Head Group (Hidden from First-Person Camera!) ---
    this.neck.position.set(0, 0.13, 0.015);
    this.chest.add(this.neck);

    const neckMesh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.052, 0.058, 0.09, 10)), this.hoodMat);
    neckMesh.position.set(0, 0.04, 0);
    this.neck.add(neckMesh);

    this.headGroup.position.set(0, 0.09, 0);
    this.neck.add(this.headGroup);

    const headAssembly = buildAnatomicalHeadAssembly({
      variant: 'male',
      toneSeed: 1,
      anisotropy: 4,
      hoodMaterial: this.hoodMat,
      frameMaterial: this.knuckleMat,
      includeGearAndEyewear: true,
    });
    headAssembly.applyFaceGear('neck_gaiter');
    headAssembly.applyEyewear('none');
    this.headAssembly = headAssembly;
    this.headGroup.add(headAssembly.root);

    const helmet = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.119, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.60)),
      this.vestMat,
    );
    helmet.scale.set(0.95, 1.02, 1.06);
    helmet.position.set(0, 0.115, 0.002);
    helmet.rotation.x = -0.10;
    this.headGroup.add(helmet);
    // Hide head geometry in first-person camera so it never clips the lens
    this.headGroup.visible = false;
    neckMesh.visible = false;

    // --- Articulated Arms (Clavicles, Upper Arms, Forearms, Articulated Hands) ---
    this.leftArm = this.buildArm(-1, 0.31, 0.29);
    this.rightArm = this.buildArm(1, 0.31, 0.29);

    this.throwHandSocket.name = 'throw_hand_socket';
    this.throwHandSocket.position.set(0, -0.026, -0.042);
    this.rightArm.hand.root.add(this.throwHandSocket);

    this.leftPinPinchSocket.name = 'left_pin_pinch_socket';
    this.leftPinPinchSocket.position.set(0.015, -0.014, -0.092);
    this.leftArm.hand.root.add(this.leftPinPinchSocket);

    this.leftPocketAnchor.name = 'left_pocket_anchor';
    this.leftPocketAnchor.position.set(-0.172, -0.08, -0.02);
    this.pelvis.add(this.leftPocketAnchor);

    this.leftEyeAimAnchor.name = 'left_eye_aim_anchor';
    this.leftEyeAimAnchor.position.set(-0.145, 0.015, -0.44);
    this.chest.add(this.leftEyeAimAnchor);

    this.leftChestBalanceAnchor.name = 'left_chest_balance_anchor';
    this.leftChestBalanceAnchor.position.set(-0.155, -0.14, -0.26);
    this.chest.add(this.leftChestBalanceAnchor);

    // --- Articulated Legs (Thighs, Shins, Boots) ---
    this.leftLeg = this.buildLeg(-1, 0.41, 0.40, 0.085);
    this.rightLeg = this.buildLeg(1, 0.41, 0.40, 0.085);

    // Tag every visible body mesh with its anatomical LimbId for self-damage raycasts
    const tagZone = (rootObj: THREE.Object3D, limbId: LimbId, register: boolean): void => {
      rootObj.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          obj.userData.playerLimb = limbId;
          if (register) {
            this.selfHitMeshes.push(obj);
          }
        }
      });
    };

    tagZone(this.pelvis, 'thorax', true);
    tagZone(this.leftArm.upperArm, 'leftArm', true);
    tagZone(this.leftArm.forearm, 'leftArm', true);
    tagZone(this.leftArm.hand.root, 'leftArm', true);
    tagZone(this.rightArm.upperArm, 'rightArm', true);
    tagZone(this.rightArm.forearm, 'rightArm', true);
    tagZone(this.rightArm.hand.root, 'rightArm', true);
    tagZone(this.leftLeg.thigh, 'leftLeg', true);
    tagZone(this.leftLeg.shin, 'leftLeg', true);
    tagZone(this.leftLeg.boot, 'leftLeg', true);
    tagZone(this.rightLeg.thigh, 'rightLeg', true);
    tagZone(this.rightLeg.shin, 'rightLeg', true);
    tagZone(this.rightLeg.boot, 'rightLeg', true);
    tagZone(this.headGroup, 'head', false);
  }

  public getSelfHitMeshes(): THREE.Object3D[] {
    return this.selfHitMeshes;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private buildArm(side: -1 | 1, upperLen: number, lowerLen: number): ArticulatedArm {
    const clavicle = new THREE.Group();
    clavicle.position.set(side * 0.058, 0.092, 0.014);
    this.chest.add(clavicle);

    const shoulderPivot = new THREE.Object3D();
    shoulderPivot.position.set(side * 0.152, 0.002, 0.010);
    clavicle.add(shoulderPivot);

    // Upper Arm (extends along local +Y from 0 -> upperLen)
    const upperArm = new THREE.Group();
    this.root.add(upperArm);

    const shoulderCap = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.052, 10, 8)), this.sleeveMat);
    shoulderCap.position.set(0, 0.008, 0);
    upperArm.add(shoulderCap);

    const bicep = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.042, 0.050, upperLen, 10)),
      this.sleeveMat,
    );
    bicep.position.set(0, upperLen * 0.5, 0);
    upperArm.add(bicep);

    // Tactical sleeve shoulder pocket patch
    const shoulderPocket = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.018, 0.080, 0.056)), this.vestMat);
    shoulderPocket.position.set(side * 0.043, upperLen * 0.32, 0);
    upperArm.add(shoulderPocket);

    // Forearm (extends along local +Y from 0 -> lowerLen, flattened oval cross-section)
    const forearm = new THREE.Group();
    this.root.add(forearm);

    const elbowPad = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.041, 12, 8)), this.knuckleMat);
    elbowPad.scale.set(0.88, 0.96, 0.72);
    elbowPad.position.set(0, 0.015, 0.022);
    forearm.add(elbowPad);

    const sleeveLen = lowerLen - 0.062;
    const foreMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.032, 0.043, sleeveLen, 12)),
      this.sleeveMat,
    );
    foreMesh.scale.set(1.06, 1.0, 0.78);
    foreMesh.position.set(0, sleeveLen * 0.5, 0);
    forearm.add(foreMesh);

    // Rolled tactical sleeve cuff
    const cuff = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0365, 0.0355, 0.026, 12)),
      this.pouchMat,
    );
    cuff.scale.set(1.08, 1.0, 0.79);
    cuff.position.set(0, lowerLen - 0.062, 0);
    forearm.add(cuff);

    const cuffTrim = new THREE.Mesh(
      this.geo(new THREE.TorusGeometry(0.0355, 0.0045, 6, 14)),
      this.sleeveMat,
    );
    cuffTrim.rotation.x = Math.PI * 0.5;
    cuffTrim.scale.set(1.08, 0.79, 1.0);
    cuffTrim.position.set(0, lowerLen - 0.050, 0);
    forearm.add(cuffTrim);

    // Exposed anatomical oval wrist (radius/ulna taper extending seamlessly into glove cuff)
    const wristBridge = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0255, 0.0295, 0.064, 12)),
      this.wristSkinMat,
    );
    wristBridge.scale.set(1.12, 1.0, 0.70);
    wristBridge.position.set(0, lowerLen - 0.028, 0);
    forearm.add(wristBridge);

    // Subtle ulnar styloid bone prominence on outer (+side) dorsal edge of wrist
    const ulnarBone = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.0085, 8, 6)), this.wristSkinMat);
    ulnarBone.scale.set(0.85, 1.25, 0.80);
    ulnarBone.position.set(side * 0.025, lowerLen - 0.014, 0.011);
    forearm.add(ulnarBone);

    // Left wrist field watch (snug NATO nylon strap + brushed gunmetal bezel + recessed dial)
    if (side === -1) {
      const watchY = lowerLen - 0.034;
      const strap = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0295, 0.0305, 0.020, 14)),
        this.knuckleMat,
      );
      strap.scale.set(1.14, 1.0, 0.73);
      strap.position.set(0, watchY, 0);

      const bezel = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0175, 0.0185, 0.0065, 16)),
        this.hardwareMat,
      );
      bezel.rotation.x = Math.PI * 0.5;
      bezel.position.set(0, watchY, 0.022);

      const dial = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0142, 0.0142, 0.0022, 16)),
        this.watchDialMat,
      );
      dial.rotation.x = Math.PI * 0.5;
      dial.position.set(0, watchY, 0.0252);

      const crown = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0024, 0.0024, 0.004, 8)),
        this.hardwareMat,
      );
      crown.rotation.z = Math.PI * 0.5;
      crown.position.set(0.0185, watchY, 0.022);
      forearm.add(strap, bezel, dial, crown);
    }

    const hand = this.buildHand(side);
    this.root.add(hand.root);

    return {
      clavicle,
      shoulderPivot,
      upperArm,
      forearm,
      hand,
      upperLen,
      lowerLen,
    };
  }

  /**
   * Canonical Hand Coordinate Frame:
   * - Origin (0,0,0) = Wrist joint
   * - Local -Z = Toward fingertips (knuckle forward axis)
   * - Local +Y = Back of hand (dorsal) / -Y = Palm surface
   * - Local -X (Right, side=+1) / +X (Left, side=-1) = Radial / Thumb inward toward grip
   */
  private buildHand(side: -1 | 1): ArticulatedHand {
    const root = new THREE.Group();

    // Oval neoprene glove wrist cuff overlapping wrist pivot (0, 0, 0) cleanly
    const wristCuff = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0285, 0.0278, 0.036, 14)),
      this.gloveMat,
    );
    wristCuff.rotation.x = Math.PI * 0.5;
    wristCuff.scale.set(1.13, 1.0, 0.72);
    wristCuff.position.set(0, 0, -0.001);
    root.add(wristCuff);

    // Molded TPR velcro wrist closure strap & pull tab on dorsal wrist
    const strapBand = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0298, 0.0295, 0.013, 14)),
      this.knuckleMat,
    );
    strapBand.rotation.x = Math.PI * 0.5;
    strapBand.scale.set(1.14, 1.0, 0.74);
    strapBand.position.set(0, 0, 0.003);
    root.add(strapBand);

    const strapTab = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.028, 0.004, 0.013)), this.knuckleMat);
    strapTab.position.set(side * 0.008, 0.0195, 0.003);
    strapTab.rotation.z = -side * 0.14;
    root.add(strapTab);

    // Sculpted beveled trapezoid palm (flares from wrist 0.052m -> knuckles 0.068m)
    const palmShape = new THREE.Shape();
    palmShape.moveTo(-0.025, 0.0);
    palmShape.lineTo(0.025, 0.0);
    palmShape.quadraticCurveTo(0.033, 0.030, 0.032, 0.064);
    palmShape.quadraticCurveTo(0.0, 0.072, -0.032, 0.064);
    palmShape.quadraticCurveTo(-0.033, 0.030, -0.025, 0.0);

    const palmGeo = this.geo(
      new THREE.ExtrudeGeometry(palmShape, {
        depth: 0.015,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.0045,
        bevelThickness: 0.0045,
      }),
    );
    // ExtrudeGeometry runs along +Z with shape X/Y; map shape Y -> -Z (toward fingers), extrude Z -> Y (thickness)
    palmGeo.rotateX(-Math.PI * 0.5);
    palmGeo.translate(0, -0.0075, -0.002);

    const palm = new THREE.Mesh(palmGeo, this.gloveMat);
    root.add(palm);

    // Synthetic suede grip overlay on palmar (-Y) face
    const suedePalm = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.054, 0.005, 0.054)),
      this.palmLeatherMat,
    );
    suedePalm.position.set(0, -0.011, -0.038);
    root.add(suedePalm);

    // Anatomical Thenar Eminence (thumb muscle mound) & Hypothenar Pad on palmar (-Y) side
    const thenarMound = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.018, 10, 8)),
      this.palmLeatherMat,
    );
    thenarMound.scale.set(0.95, 0.62, 1.38);
    thenarMound.position.set(-side * 0.017, -0.0085, -0.028);
    thenarMound.rotation.y = side * 0.25;
    root.add(thenarMound);

    const hypothenarPad = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.014, 10, 8)),
      this.palmLeatherMat,
    );
    hypothenarPad.scale.set(0.78, 0.56, 1.45);
    hypothenarPad.position.set(side * 0.021, -0.008, -0.034);
    root.add(hypothenarPad);

    // Molded arched carbon/TPU knuckle guard + 4 individual knuckle domes across MCP arch
    const mcpSpecs: Array<{ x: number; y: number; z: number; splayY: number; r: number; l1: number; l2: number; l3: number }> = [
      { x: -side * 0.024, y: 0.0025, z: -0.067, splayY: side * 0.055, r: 0.0076, l1: 0.030, l2: 0.020, l3: 0.018 },
      { x: -side * 0.008, y: 0.0042, z: -0.071, splayY: side * 0.015, r: 0.0080, l1: 0.034, l2: 0.023, l3: 0.019 },
      { x: side * 0.009, y: 0.0032, z: -0.068, splayY: -side * 0.020, r: 0.0075, l1: 0.031, l2: 0.021, l3: 0.018 },
      { x: side * 0.025, y: 0.0005, z: -0.062, splayY: -side * 0.065, r: 0.0067, l1: 0.025, l2: 0.017, l3: 0.016 },
    ];

    const knuckleBridge = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0075, 0.0075, 0.056, 8)),
      this.knuckleMat,
    );
    knuckleBridge.rotation.z = Math.PI * 0.5;
    knuckleBridge.scale.set(0.75, 1.0, 1.35);
    knuckleBridge.position.set(0, 0.0105, -0.058);
    root.add(knuckleBridge);

    for (let i = 0; i < mcpSpecs.length; i++) {
      const m = mcpSpecs[i];
      const dome = new THREE.Mesh(this.geo(new THREE.SphereGeometry(m.r * 1.16, 10, 8)), this.knuckleMat);
      dome.scale.set(1.05, 0.72, 1.15);
      dome.position.set(m.x, m.y + 0.008, m.z + 0.006);
      root.add(dome);
    }

    // Opposable Thumb with muscular web, joint capsule, and leather tip pad
    const thumbProx = new THREE.Group();
    thumbProx.position.set(-side * 0.029, -0.0055, -0.022);
    thumbProx.rotation.set(0.14, side * 0.48, 0);

    const thumbMcpCap = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.0098, 8, 8)), this.gloveMat);
    thumbProx.add(thumbMcpCap);

    const thumbProxMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0082, 0.0096, 0.029, 10)),
      this.gloveMat,
    );
    thumbProxMesh.scale.set(1.08, 1.0, 0.90);
    thumbProxMesh.rotation.x = Math.PI * 0.5;
    thumbProxMesh.position.set(0, 0, -0.0145);
    thumbProx.add(thumbProxMesh);

    const thumbDist = new THREE.Group();
    thumbDist.position.set(0, 0, -0.029);

    const thumbIpCap = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.0080, 8, 8)), this.gloveMat);
    thumbDist.add(thumbIpCap);

    const thumbDistMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0065, 0.0080, 0.024, 10)),
      this.palmLeatherMat,
    );
    thumbDistMesh.scale.set(1.10, 1.0, 0.86);
    thumbDistMesh.rotation.x = Math.PI * 0.5;
    thumbDistMesh.position.set(0, 0, -0.012);
    thumbDist.add(thumbDistMesh);

    const thumbTipCap = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.0066, 8, 8)),
      this.palmLeatherMat,
    );
    thumbTipCap.scale.set(1.10, 0.86, 1.15);
    thumbTipCap.position.set(0, 0, -0.024);
    thumbDist.add(thumbTipCap);

    thumbProx.add(thumbDist);
    root.add(thumbProx);

    // 3-Phalanx Articulated Finger builder (MCP -> PIP -> DIP -> Rounded Tip)
    const makeFinger = (specIdx: number): ArticulatedFinger => {
      const m = mcpSpecs[specIdx];
      const proximal = new THREE.Group();
      proximal.position.set(m.x, m.y, m.z);
      proximal.rotation.y = m.splayY;

      const mcpJoint = new THREE.Mesh(this.geo(new THREE.SphereGeometry(m.r * 0.98, 8, 8)), this.gloveMat);
      proximal.add(mcpJoint);

      const seg1 = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(m.r * 0.88, m.r, m.l1, 10)),
        this.gloveMat,
      );
      seg1.scale.set(1.04, 1.0, 0.90);
      seg1.rotation.x = Math.PI * 0.5;
      seg1.position.set(0, 0, -m.l1 * 0.5);
      proximal.add(seg1);

      const middle = new THREE.Group();
      middle.position.set(0, 0, -m.l1);

      const pipJoint = new THREE.Mesh(this.geo(new THREE.SphereGeometry(m.r * 0.87, 8, 8)), this.gloveMat);
      middle.add(pipJoint);

      const seg2 = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(m.r * 0.78, m.r * 0.87, m.l2, 10)),
        this.gloveMat,
      );
      seg2.scale.set(1.02, 1.0, 0.88);
      seg2.rotation.x = Math.PI * 0.5;
      seg2.position.set(0, 0, -m.l2 * 0.5);
      middle.add(seg2);

      const distal = new THREE.Group();
      distal.position.set(0, 0, -m.l2);

      const dipJoint = new THREE.Mesh(this.geo(new THREE.SphereGeometry(m.r * 0.77, 8, 8)), this.palmLeatherMat);
      distal.add(dipJoint);

      const seg3 = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(m.r * 0.65, m.r * 0.77, m.l3, 10)),
        this.palmLeatherMat,
      );
      seg3.scale.set(1.04, 1.0, 0.84);
      seg3.rotation.x = Math.PI * 0.5;
      seg3.position.set(0, 0, -m.l3 * 0.5);
      distal.add(seg3);

      const tipCap = new THREE.Mesh(
        this.geo(new THREE.SphereGeometry(m.r * 0.66, 8, 8)),
        this.palmLeatherMat,
      );
      tipCap.scale.set(1.04, 0.84, 1.15);
      tipCap.position.set(0, 0, -m.l3);
      distal.add(tipCap);

      middle.add(distal);
      proximal.add(middle);
      root.add(proximal);
      return { proximal, middle, distal };
    };

    const index = makeFinger(0);
    const middle = makeFinger(1);
    const ring = makeFinger(2);
    const pinky = makeFinger(3);

    return {
      root,
      palm,
      side,
      thumbProx,
      thumbDist,
      index,
      middle,
      ring,
      pinky,
    };
  }

  private buildLeg(side: -1 | 1, upperLen: number, lowerLen: number, ankleHeight: number): ArticulatedLeg {
    const hipPivot = new THREE.Object3D();
    hipPivot.position.set(side * 0.10, -0.04, 0.0);
    this.pelvis.add(hipPivot);

    // Thigh (along +Y from 0 -> upperLen)
    const thigh = new THREE.Group();
    this.root.add(thigh);

    const thighMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.064, 0.084, upperLen, 12)),
      this.pantsMat,
    );
    thighMesh.position.set(0, upperLen * 0.5, 0);
    thigh.add(thighMesh);

    // Contoured cargo side pocket
    const cargoPocket = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.052, 0.054, 0.15, 8)),
      this.pantsMat,
    );
    cargoPocket.scale.set(0.32, 1.0, 0.95);
    cargoPocket.position.set(side * 0.062, upperLen * 0.56, 0);
    thigh.add(cargoPocket);

    // Shin (along +Y from 0 -> lowerLen)
    const shin = new THREE.Group();
    this.root.add(shin);

    const kneePad = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.058, 10, 8)), this.knuckleMat);
    kneePad.scale.set(0.88, 0.92, 0.56);
    kneePad.position.set(0, 0.01, 0.044);
    shin.add(kneePad);

    const shinMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.049, 0.064, lowerLen, 12)),
      this.pantsMat,
    );
    shinMesh.position.set(0, lowerLen * 0.5, 0);
    shin.add(shinMesh);

    // Boot (pivoted at ankle, sole at y = -ankleHeight)
    const boot = new THREE.Group();
    this.root.add(boot);

    const shaft = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.054, 0.058, 0.13, 10)), this.bootMat);
    shaft.position.set(0, -0.01, 0.01);
    boot.add(shaft);

    const vamp = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.098, 0.072, 0.21)), this.bootMat);
    vamp.position.set(0, -ankleHeight + 0.048, -0.055);
    boot.add(vamp);

    const toeCap = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.094, 0.052, 0.068)), this.soleMat);
    toeCap.position.set(0, -ankleHeight + 0.036, -0.145);
    boot.add(toeCap);

    const outsole = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.104, 0.026, 0.255)), this.soleMat);
    outsole.position.set(0, -ankleHeight + 0.013, -0.062);
    boot.add(outsole);

    return {
      hipPivot,
      thigh,
      shin,
      boot,
      upperLen,
      lowerLen,
      ankleHeight,
    };
  }

  public setHeadVisible(visible: boolean): void {
    this.headGroup.visible = visible;
  }

  public applyHandPose(
    side: 'left' | 'right',
    holdClass: HoldClass,
    triggerPulledOrAds: boolean,
    customCurl = 0.85,
    foregripStyle: 'none' | 'vertical' | 'angled' = 'none',
    opts?: {
      leverReleased?: boolean;
      pinchPose01?: number;
    },
  ): void {
    const hand = side === 'left' ? this.leftArm.hand : this.rightArm.hand;
    const s = hand.side;
    const scale = THREE.MathUtils.clamp(customCurl, 0, 1.15);
    const pinchPose01 = THREE.MathUtils.clamp(opts?.pinchPose01 ?? 0, 0, 1);

    const setFinger = (
      f: ArticulatedFinger,
      proxDeg: number,
      midDeg: number,
      distDeg: number,
      splayRad = 0,
    ): void => {
      f.proximal.rotation.x = -THREE.MathUtils.degToRad(proxDeg);
      f.proximal.rotation.y = splayRad;
      f.middle.rotation.x = -THREE.MathUtils.degToRad(midDeg);
      f.distal.rotation.x = -THREE.MathUtils.degToRad(distDeg);
    };

    if (side === 'left' && pinchPose01 > 0.01) {
      const p = pinchPose01;
      setFinger(
        hand.index,
        THREE.MathUtils.lerp(24 * scale, 48, p),
        THREE.MathUtils.lerp(34 * scale, 54, p),
        THREE.MathUtils.lerp(20 * scale, 26, p),
        s * 0.12 * p,
      );
      setFinger(
        hand.middle,
        THREE.MathUtils.lerp(28 * scale, 56, p),
        THREE.MathUtils.lerp(38 * scale, 68, p),
        THREE.MathUtils.lerp(24 * scale, 44, p),
      );
      setFinger(
        hand.ring,
        THREE.MathUtils.lerp(31 * scale, 64, p),
        THREE.MathUtils.lerp(41 * scale, 74, p),
        THREE.MathUtils.lerp(26 * scale, 48, p),
      );
      setFinger(
        hand.pinky,
        THREE.MathUtils.lerp(34 * scale, 68, p),
        THREE.MathUtils.lerp(44 * scale, 78, p),
        THREE.MathUtils.lerp(28 * scale, 52, p),
      );
      hand.thumbProx.rotation.set(
        THREE.MathUtils.lerp(-0.08, -0.34, p),
        s * THREE.MathUtils.lerp(0.22, 0.56, p),
        s * THREE.MathUtils.lerp(0.10, -0.08, p),
      );
      hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.22, -0.44, p), 0, 0);
      return;
    }

    const isFirearm = holdClass === 'pistol' || holdClass === 'rifle' || holdClass === 'shotgun';

    if (side === 'right' && isFirearm) {
      // Natural curved 3-phalanx wrap around pistol grip (staggered middle -> pinky)
      setFinger(hand.middle, 34 * scale, 48 * scale, 28 * scale);
      setFinger(hand.ring, 37 * scale, 51 * scale, 31 * scale);
      setFinger(hand.pinky, 40 * scale, 54 * scale, 34 * scale);

      // Index rests naturally arched along frame when idle, curls smoothly onto trigger in ADS/fire
      if (triggerPulledOrAds) {
        setFinger(hand.index, 22, 42, 26);
      } else {
        setFinger(hand.index, 6, 12, 8);
      }

      // Thumb wraps naturally across upper backstrap/safety
      hand.thumbProx.rotation.set(-0.18, s * 0.58, -s * 0.22);
      hand.thumbDist.rotation.set(-0.56, 0, 0);
      return;
    }

    if (side === 'left' && (holdClass === 'rifle' || holdClass === 'shotgun')) {
      if (foregripStyle === 'vertical') {
        setFinger(hand.index, 74 * scale, 88 * scale, 54 * scale);
        setFinger(hand.middle, 80 * scale, 94 * scale, 58 * scale);
        setFinger(hand.ring, 84 * scale, 98 * scale, 62 * scale);
        setFinger(hand.pinky, 88 * scale, 102 * scale, 66 * scale);
        hand.thumbProx.rotation.set(-0.34, s * 0.44, -s * 0.16);
        hand.thumbDist.rotation.set(-0.52, 0, 0);
        return;
      }
      if (foregripStyle === 'angled') {
        setFinger(hand.index, 14 * scale, 22 * scale, 12 * scale);
        setFinger(hand.middle, 28 * scale, 42 * scale, 26 * scale);
        setFinger(hand.ring, 33 * scale, 47 * scale, 29 * scale);
        setFinger(hand.pinky, 38 * scale, 52 * scale, 32 * scale);
        hand.thumbProx.rotation.set(0.08, s * 0.12, s * 0.28);
        hand.thumbDist.rotation.set(-0.14, 0, 0);
        return;
      }
      // Ergonomic C-clamp / forend cup with realistic progressive phalanx bend
      setFinger(hand.index, 20 * scale, 30 * scale, 18 * scale);
      setFinger(hand.middle, 24 * scale, 35 * scale, 22 * scale);
      setFinger(hand.ring, 27 * scale, 38 * scale, 24 * scale);
      setFinger(hand.pinky, 31 * scale, 42 * scale, 26 * scale);
      hand.thumbProx.rotation.set(-0.06, s * 0.20, s * 0.14);
      hand.thumbDist.rotation.set(-0.22, 0, 0);
      return;
    }

    if (side === 'left' && holdClass === 'pistol') {
      // Two-handed Weaver / thumbs-forward support grip wrapping right knuckles
      setFinger(hand.index, 26 * scale, 38 * scale, 22 * scale);
      setFinger(hand.middle, 30 * scale, 42 * scale, 25 * scale);
      setFinger(hand.ring, 33 * scale, 45 * scale, 27 * scale);
      setFinger(hand.pinky, 36 * scale, 48 * scale, 29 * scale);
      hand.thumbProx.rotation.set(-0.04, s * 0.14, 0);
      hand.thumbDist.rotation.set(-0.10, 0, 0);
      return;
    }

    if (holdClass === 'throwable') {
      if (side === 'right') {
        const leverLift = opts?.leverReleased ? 14 : 0;
        setFinger(hand.index, 46 * scale, 60 * scale, 36 * scale);
        setFinger(
          hand.middle,
          Math.max(12, 54 * scale - leverLift),
          Math.max(16, 66 * scale - leverLift),
          Math.max(10, 42 * scale - leverLift * 0.6),
        );
        setFinger(
          hand.ring,
          Math.max(12, 58 * scale - leverLift),
          Math.max(16, 70 * scale - leverLift),
          Math.max(10, 44 * scale - leverLift * 0.6),
        );
        setFinger(
          hand.pinky,
          Math.max(12, 60 * scale - leverLift),
          Math.max(16, 72 * scale - leverLift),
          Math.max(10, 46 * scale - leverLift * 0.6),
        );
        hand.thumbProx.rotation.set(-0.24, s * 0.44, -s * 0.14);
        hand.thumbDist.rotation.set(-0.42, 0, 0);
      } else {
        setFinger(hand.index, 12, 16, 10, -s * 0.04);
        setFinger(hand.middle, 15, 20, 12);
        setFinger(hand.ring, 18, 24, 14);
        setFinger(hand.pinky, 22, 28, 16, s * 0.04);
        hand.thumbProx.rotation.set(0.06, s * 0.24, s * 0.08);
        hand.thumbDist.rotation.set(-0.14, 0, 0);
      }
      return;
    }

    if (holdClass === 'unarmed') {
      // Three-stage smooth unarmed hand articulation:
      //  - scale ~0.16: flat open-palm vault brace
      //  - scale ~0.42: relaxed semi-curled ready hand (progressive index->pinky curl, thumb natural alongside index)
      //  - scale >=0.85: tight clenched boxing fist (thumb folded cleanly across outside of curled index/middle knuckles)
      const relaxT = THREE.MathUtils.clamp((scale - 0.16) / 0.28, 0, 1);
      const fistT = THREE.MathUtils.clamp((scale - 0.44) / 0.46, 0, 1);

      const lerpStage = (openDeg: number, relaxedDeg: number, fistDeg: number): number => {
        const mid = THREE.MathUtils.lerp(openDeg, relaxedDeg, relaxT);
        return THREE.MathUtils.lerp(mid, fistDeg, fistT);
      };

      setFinger(
        hand.index,
        lerpStage(8, 30, 92),
        lerpStage(10, 38, 104),
        lerpStage(6, 20, 64),
      );
      setFinger(
        hand.middle,
        lerpStage(9, 36, 95),
        lerpStage(11, 44, 108),
        lerpStage(6, 24, 66),
      );
      setFinger(
        hand.ring,
        lerpStage(10, 42, 97),
        lerpStage(12, 50, 110),
        lerpStage(7, 28, 68),
      );
      setFinger(
        hand.pinky,
        lerpStage(11, 48, 98),
        lerpStage(13, 56, 112),
        lerpStage(8, 32, 70),
      );

      // Keep thumb naturally relaxed beside the index finger in ready stance; fold snugly across curled knuckles in fist
      const thumbProxX = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(-0.04, -0.14, relaxT),
        -0.56,
        fistT,
      );
      const thumbProxY = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(s * 0.24, s * 0.28, relaxT),
        -s * 0.24,
        fistT,
      );
      const thumbProxZ = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(0, -s * 0.06, relaxT),
        s * 0.12,
        fistT,
      );
      hand.thumbProx.rotation.set(thumbProxX, thumbProxY, thumbProxZ);
      hand.thumbDist.rotation.set(
        THREE.MathUtils.lerp(THREE.MathUtils.lerp(-0.06, -0.18, relaxT), -0.24, fistT),
        THREE.MathUtils.lerp(THREE.MathUtils.lerp(0, -s * 0.12, relaxT), -s * 1.05, fistT),
        0,
      );
      return;
    }

    // Melee_1h, melee_2h grip
    setFinger(hand.index, 38 * scale, 54 * scale, 34 * scale);
    setFinger(hand.middle, 40 * scale, 56 * scale, 36 * scale);
    setFinger(hand.ring, 42 * scale, 58 * scale, 38 * scale);
    setFinger(hand.pinky, 44 * scale, 60 * scale, 40 * scale);
    hand.thumbProx.rotation.set(-0.30, s * 0.68, -s * 0.28);
    hand.thumbDist.rotation.set(-0.68, 0, 0);
  }

  public setHandGripCurl(side: 'left' | 'right', curl: number, indexTriggerExtend = false): void {
    this.applyHandPose(side, indexTriggerExtend ? 'rifle' : 'melee_1h', !indexTriggerExtend, curl);
  }

  public dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    if (this.headAssembly) {
      for (const d of this.headAssembly.disposables) {
        d.dispose();
      }
    }
    for (const t of this.texSets) {
      t.map.dispose();
      t.normalMap.dispose();
      t.roughnessMap.dispose();
    }
  }
}

import * as THREE from 'three';
import { IR_LAYER, VIEWMODEL_LAYER } from './BodycamPostProcess';
import {
  createTwoBoneIKResult,
  orientLimbAlongYInRootSpace,
  setTransformInRootSpace,
  solveTwoBoneIK,
  TwoBoneIKResult,
} from './IKSolver';
import {
  DEFAULT_OPERATOR_GEAR,
  GLOVE_COLOR_MAP,
  HELMET_COLOR_MAP,
  HitZoneNodeName,
  normalizeOperatorGearConfig,
  OPERATOR_PROFILES,
  OperatorGearConfig,
  OperatorId,
  OperatorProfileSpec,
  SecondaryBoneName,
} from './operator/OperatorTypes';
import {
  buildFabricTextureSet,
  OperatorUniformId,
  ProceduralFabricSet,
  TACTICAL_UNIFORM_PRESETS,
} from './TacticalUniforms';
import { BodycamWeaponHoldClass } from './types';
import {
  DEFAULT_TACTICAL_BELT_SLOT,
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import {
  buildAnatomicalHeadAssembly,
  BuiltAnatomicalHeadAssembly,
  getSkinTonePalette,
} from './character/AnatomicalHeadBuilder';
import {
  FacialExpressionController,
  FacialExpressionInput,
} from './character/FacialExpressionController';
import {
  buildTacticalEquipmentMesh,
  BuiltTacticalEquipmentMesh,
  getBeltSlotTransforms,
} from './equipment/TacticalEquipmentMesh';
import { tacticalEquipmentStore } from './equipment/TacticalEquipmentStore';
import { WeaponHandPoseProfile } from './weapons/WeaponModelFactory';

export interface HandPoseDynamicOptions {
  profile?: Readonly<WeaponHandPoseProfile> | null;
  /** 0..1 smooth continuous blend from frame-indexed trigger discipline (0) onto trigger shoe (1) */
  triggerEngageBlend?: number;
  /** 0..1 live trigger squeeze flexion on right index finger */
  triggerPull01?: number;
  /** 0..1 thumb-index pinch pose for scope throw-lever, elevation turret, or illum dial */
  pinchPose01?: number;
  /** 0..1 finger release opening during suppressor ratcheted regrip strokes */
  gripRelease01?: number;
  /** True when left hand is gripping a cylindrical suppressor tube */
  suppressorGrip?: boolean;
  /** 0..1 right-thumb flick reaching toward receiver safety/fire-selector */
  thumbFlick01?: number;
  /** 0..1 left-thumb press onto flashlight/laser pressure pad */
  padTap01?: number;
  /** True when tactical grenade safety spoon has been released in hand */
  leverReleased?: boolean;
}

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
  toe: THREE.Group;
  upperLen: number;
  lowerLen: number;
  ankleHeight: number;
  toeRestZ: number;
}

export interface OperatorSecondaryNodes {
  readonly sec_chest_l: THREE.Group;
  readonly sec_chest_r: THREE.Group;
  readonly sec_glute_l: THREE.Group;
  readonly sec_glute_r: THREE.Group;
  readonly sec_bicep_l: THREE.Group;
  readonly sec_tricep_l: THREE.Group;
  readonly sec_forearm_l: THREE.Group;
  readonly sec_bicep_r: THREE.Group;
  readonly sec_tricep_r: THREE.Group;
  readonly sec_forearm_r: THREE.Group;
}

export interface OperatorContractSockets {
  readonly socket_weapon_r: THREE.Object3D;
  readonly socket_weapon_holster: THREE.Object3D;
  readonly socket_bodycam_mount: THREE.Object3D;
  readonly ik_pole_elbow_l: THREE.Object3D;
  readonly ik_pole_elbow_r: THREE.Object3D;
}

/**
 * Self-contained full-body articulated tactical character skeleton fulfilling OperatorRigContract.
 * Supports distinct MALE and FEMALE tactical silhouettes with identical canonical bone chains,
 * rest-axis parity (`dot > 0.999`), dedicated `sec_*` soft-tissue child nodes, 17 `hz_*` hit-zone
 * anchors, and a FAST ballistic helmet head group capable of shadow-only rendering in bodycam FPS
 * mode while rendering fully textured in 3D pre-deployment preview and ragdoll views.
 */
export class CharacterSkeleton {
  public readonly operatorId: OperatorId;
  public readonly profile: OperatorProfileSpec;

  public readonly root = new THREE.Group();
  public readonly pelvis = new THREE.Group();
  public readonly spineLower = new THREE.Group();
  public readonly spineUpper = new THREE.Group();
  public readonly chest = new THREE.Group();
  public readonly neck = new THREE.Group();
  public readonly headGroup = new THREE.Group();

  public readonly magPouchAnchor = new THREE.Object3D();
  public readonly beltEquipmentMount = new THREE.Group();
  public readonly throwHandSocket = new THREE.Object3D();
  public readonly rightThumbTipSocket = new THREE.Object3D();
  public readonly leftPinPinchSocket = new THREE.Object3D();
  public readonly leftPocketAnchor = new THREE.Object3D();
  public readonly leftEyeAimAnchor = new THREE.Object3D();
  public readonly leftChestBalanceAnchor = new THREE.Object3D();

  private beltEquipmentMeshes: BuiltTacticalEquipmentMesh[] = [];
  private beltEquipmentState: {
    equipmentId: TacticalEquipmentId;
    beltSlot: TacticalBeltSlot;
    count: number;
    visible: boolean;
  } = {
    equipmentId: DEFAULT_TACTICAL_EQUIPMENT_ID,
    beltSlot: DEFAULT_TACTICAL_BELT_SLOT,
    count: 2,
    visible: true,
  };
  private beltUseWorldLayer = true;

  public readonly leftArm: ArticulatedArm;
  public readonly rightArm: ArticulatedArm;
  public readonly leftLeg: ArticulatedLeg;
  public readonly rightLeg: ArticulatedLeg;

  public readonly secondaryNodes: OperatorSecondaryNodes;
  public readonly secondaryRestPos: Record<SecondaryBoneName, THREE.Vector3>;
  public readonly sockets: OperatorContractSockets;
  public readonly hitZones: Record<HitZoneNodeName, THREE.Object3D>;

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private texSets: ProceduralFabricSet[] = [];
  private readonly anisotropy: number;
  private currentUniformId: OperatorUniformId;
  private currentGear: OperatorGearConfig = { ...DEFAULT_OPERATOR_GEAR };
  private headShadowOnly = false;
  private readonly headMeshes: Array<{ mesh: THREE.Mesh; visibleMat: THREE.Material }> = [];

  // Helmet & NVG mount groups (MICH-2000 vs Mil-Tec + articulating Wilcox shroud pivot)
  private michHelmetGroup: THREE.Group | null = null;
  private milTecHelmetGroup: THREE.Group | null = null;
  private nvgPivotGroup: THREE.Group | null = null;
  private pvs7MountGroup: THREE.Group | null = null;
  private arnvgMountGroup: THREE.Group | null = null;
  private nvgFlippedDown = false;
  private neckGaiterCollarMesh: THREE.Mesh | null = null;
  private irStrobeHousingMesh: THREE.Mesh | null = null;
  private headAssembly: BuiltAnatomicalHeadAssembly | null = null;
  private readonly facialController: FacialExpressionController;
  private readonly _facialInputScratch: FacialExpressionInput = {
    mode: 'human',
    intent: 'calm',
    stress01: 0.1,
    injury01: 0,
    flinchImpulse01: 0,
    gazeTargetWorld: null,
    distanceToCameraM: 1.5,
    isVisible: true,
  };

  // Hand meshes supporting Gloves ON/OFF + live glove color changes
  private readonly gloveOnlyMeshes: THREE.Mesh[] = [];
  private readonly handGlovePrimaryMeshes: THREE.Mesh[] = [];
  private readonly handGlovePalmMeshes: THREE.Mesh[] = [];
  private customGloveTexSets: ProceduralFabricSet[] = [];

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
  private helmetMat: THREE.MeshStandardMaterial;
  private visorMat: THREE.MeshStandardMaterial;
  private iffTrimMat: THREE.MeshStandardMaterial;
  private nvgBodyMat: THREE.MeshStandardMaterial;
  private nvgAluminumMat: THREE.MeshStandardMaterial;
  private nvgLensPvs7Mat: THREE.MeshStandardMaterial;
  private nvgLensArnvgMat: THREE.MeshStandardMaterial;
  private headShadowOnlyMat: THREE.MeshBasicMaterial;
  private armbandMat: THREE.MeshStandardMaterial;
  private readonly armbandMeshes: THREE.Mesh[] = [];
  private irStrobeHousingMat: THREE.MeshStandardMaterial;
  private irStrobeEmitterMat: THREE.MeshBasicMaterial;
  private readonly irStrobeEmitterMeshes: THREE.Mesh[] = [];

  // Pre-allocated scratch objects for zero-GC preview pose solving
  private readonly _previewInvRootMat = new THREE.Matrix4();
  private readonly _previewHipL = new THREE.Vector3();
  private readonly _previewHipR = new THREE.Vector3();
  private readonly _previewAnkleL = new THREE.Vector3();
  private readonly _previewAnkleR = new THREE.Vector3();
  private readonly _previewPoleL = new THREE.Vector3();
  private readonly _previewPoleR = new THREE.Vector3();
  private readonly _previewBootEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _previewBootQuat = new THREE.Quaternion();
  private readonly _previewLegIKL: TwoBoneIKResult = createTwoBoneIKResult();
  private readonly _previewLegIKR: TwoBoneIKResult = createTwoBoneIKResult();

  constructor(
    maxAnisotropy = 4,
    uniformId: OperatorUniformId = 'infection',
    operatorId: OperatorId = 'MALE',
    previewMode = false,
    initialGear?: Partial<OperatorGearConfig>,
  ) {
    this.operatorId = operatorId;
    this.profile = OPERATOR_PROFILES[operatorId] ?? OPERATOR_PROFILES.MALE;
    const p = this.profile;
    this.facialController = new FacialExpressionController(operatorId === 'FEMALE' ? 2 : 1);

    const aniso = Math.min(8, Math.max(1, maxAnisotropy));
    this.anisotropy = aniso;
    this.currentUniformId = uniformId;
    this.currentGear = normalizeOperatorGearConfig({
      ...DEFAULT_OPERATOR_GEAR,
      uniformId,
      ...initialGear,
    });
    const preset = TACTICAL_UNIFORM_PRESETS[uniformId] ?? TACTICAL_UNIFORM_PRESETS.infection;
    const s = preset.seedOffset;

    const sleeveTex = buildFabricTextureSet(preset.sleeveRgb, 0.08, 0.14, 0.88, s + 17, aniso, preset.camoPattern);
    const pantsTex = buildFabricTextureSet(preset.pantsRgb, 0.09, 0.18, 0.90, s + 43, aniso, preset.camoPattern);
    const vestTex = buildFabricTextureSet(preset.vestRgb, 0.12, 0.14, 0.84, s + 71, aniso, preset.camoPattern);
    const bootTex = buildFabricTextureSet(preset.bootRgb, 0.04, 0.22, 0.72, s + 109, aniso, 'olive_bdu');
    const gloveTex = buildFabricTextureSet(preset.gloveRgb, 0.14, 0.18, 0.78, s + 137, aniso, 'olive_bdu');
    const palmTex = buildFabricTextureSet(preset.palmRgb, 0.10, 0.22, 0.88, s + 173, aniso, 'olive_bdu');
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
        color: preset.pouchTintHex,
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
    const headToneSeed = operatorId === 'FEMALE' ? 0 : 1;
    const skinPalette = getSkinTonePalette(headToneSeed, operatorId === 'FEMALE' ? 'female' : 'male');
    this.wristSkinMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: skinPalette.wristHex,
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
    this.armbandMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x3b82f6,
        roughness: 0.86,
        metalness: 0.04,
      }),
    );
    this.irStrobeHousingMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x1e2226,
        roughness: 0.58,
        metalness: 0.24,
      }),
    );
    this.irStrobeEmitterMat = this.mat(
      new THREE.MeshBasicMaterial({
        color: 0xe6fff0,
        transparent: true,
        opacity: 0.95,
      }),
    );
    this.watchDialMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x0d1210,
        emissive: preset.watchEmissiveHex,
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
        color: preset.hardwareHex,
        roughness: 0.36,
        metalness: 0.72,
      }),
    );
    this.hoodMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: preset.hoodHex,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    this.helmetMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: preset.helmetHex,
        roughness: 0.56,
        metalness: 0.16,
      }),
    );
    this.visorMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: preset.visorHex,
        roughness: 0.16,
        metalness: 0.82,
      }),
    );
    this.iffTrimMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: preset.iffTrimHex,
        emissive: preset.iffEmissiveHex,
        emissiveIntensity: preset.iffEmissiveIntensity,
        roughness: 0.42,
        metalness: 0.15,
      }),
    );
    this.nvgBodyMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x181a1e,
        roughness: 0.52,
        metalness: 0.34,
      }),
    );
    this.nvgAluminumMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x22262c,
        roughness: 0.34,
        metalness: 0.78,
      }),
    );
    this.nvgLensPvs7Mat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x102822,
        emissive: 0x0b3a22,
        emissiveIntensity: 0.45,
        roughness: 0.08,
        metalness: 0.85,
      }),
    );
    this.nvgLensArnvgMat = this.mat(
      new THREE.MeshStandardMaterial({
        color: 0x12233b,
        emissive: 0x184c7a,
        emissiveIntensity: 0.55,
        roughness: 0.06,
        metalness: 0.88,
      }),
    );
    // Shadow-only material: WebGLShadowMap overrides with depthMaterial so FAST helmet casts
    // crisp world shadows while colorWrite=false & depthWrite=false render 0 pixels to bodycam lens.
    this.headShadowOnlyMat = this.mat(
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        depthWrite: false,
      }),
    );

    const createChamferedShape = (w: number, h: number, r: number, topTaper = 0): THREE.Shape => {
      const hw = w * 0.5;
      const hh = h * 0.5;
      const rr = Math.min(r, hw * 0.45, hh * 0.45);
      const topW = hw - topTaper;
      const shape = new THREE.Shape();
      shape.moveTo(-hw + rr, -hh);
      shape.lineTo(hw - rr, -hh);
      shape.quadraticCurveTo(hw, -hh, hw, -hh + rr);
      shape.lineTo(topW, hh - rr);
      shape.quadraticCurveTo(topW, hh, topW - rr, hh);
      shape.lineTo(-topW + rr, hh);
      shape.quadraticCurveTo(-topW, hh, -topW, hh - rr);
      shape.lineTo(-hw, -hh + rr);
      shape.quadraticCurveTo(-hw, -hh, -hw + rr, -hh);
      return shape;
    };

    const createSapiPlateGeo = (w: number, h: number, depth: number): THREE.ExtrudeGeometry => {
      const hw = w * 0.5;
      const hh = h * 0.5;
      const shoulderCutX = hw * 0.46;
      const shoulderCutY = hh * 0.56;
      const shape = new THREE.Shape();
      shape.moveTo(-hw + 0.015, -hh);
      shape.lineTo(hw - 0.015, -hh);
      shape.quadraticCurveTo(hw, -hh, hw, -hh + 0.018);
      shape.lineTo(hw, shoulderCutY);
      shape.lineTo(shoulderCutX, hh);
      shape.lineTo(-shoulderCutX, hh);
      shape.lineTo(-hw, shoulderCutY);
      shape.lineTo(-hw, -hh + 0.018);
      shape.quadraticCurveTo(-hw, -hh, -hw + 0.015, -hh);
      const geo = new THREE.ExtrudeGeometry(shape, {
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

    // Canonical names
    this.root.name = 'root';
    this.pelvis.name = 'pelvis';
    this.spineLower.name = 'spine_01';
    this.spineUpper.name = 'spine_02';
    this.chest.name = 'spine_03';
    this.neck.name = 'neck_01';
    this.headGroup.name = 'head';

    // Pelvis & Tactical Belt (rest origin centered over root (0,0,0) between boots)
    const restPelvisY = p.ankleHeight + p.shinLen + p.thighLen + 0.04;
    this.pelvis.position.set(0, restPelvisY, 0);
    this.root.add(this.pelvis);

    const pelvisMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.140 * p.waistWidthScale, 0.154 * p.pelvisWidthScale, 0.145, 16)),
      this.pantsMat,
    );
    pelvisMesh.scale.set(1.06, 1.0, 0.68 * p.pelvisDepthScale);
    pelvisMesh.position.set(0, -0.02, 0);

    const beltMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.148 * p.waistWidthScale, 0.152 * p.pelvisWidthScale, 0.044, 16)),
      this.vestMat,
    );
    beltMesh.scale.set(1.07, 1.0, 0.69 * p.pelvisDepthScale);
    beltMesh.position.set(0, 0.052, 0);

    const buckleMesh = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.048, 0.036, 0.014, 0.006)), this.hardwareMat);
    buckleMesh.position.set(0, 0.052, -0.105 * p.pelvisDepthScale);

    const dumpPouch = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.084, 0.112, 0.030, 0.014)), this.pouchMat);
    dumpPouch.rotation.y = Math.PI * 0.5;
    dumpPouch.position.set(-0.148 * p.pelvisWidthScale, -0.02, 0.01);

    const holster = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.074, 0.132, 0.026, 0.013)), this.hardwareMat);
    holster.rotation.y = -Math.PI * 0.5;
    holster.position.set(0.148 * p.pelvisWidthScale, -0.04, -0.005);

    this.pelvis.add(pelvisMesh, beltMesh, buckleMesh, dumpPouch, holster);

    // Tactical Equipment Belt Mount Group (unit scale, non-canonical child of pelvis)
    this.beltEquipmentMount.name = 'belt_tactical_equipment_slot';
    this.pelvis.add(this.beltEquipmentMount);
    const initialEquip = tacticalEquipmentStore.getSelection();
    this.setBeltEquipment(
      initialEquip.equipmentId,
      initialEquip.beltSlot,
      2,
      initialEquip.mountOnBelt,
    );

    // Secondary Glute Soft-Tissue Nodes (child of pelvis, scale = 1)
    const sec_glute_l = new THREE.Group();
    sec_glute_l.name = 'sec_glute_l';
    sec_glute_l.position.set(-0.068 * p.pelvisWidthScale, -0.034, 0.062 * p.pelvisDepthScale);
    const gluteMeshL = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 12, 10)), this.pantsMat);
    gluteMeshL.scale.set(p.gluteContourScale[0], p.gluteContourScale[1], p.gluteContourScale[2]);
    sec_glute_l.add(gluteMeshL);

    const sec_glute_r = new THREE.Group();
    sec_glute_r.name = 'sec_glute_r';
    sec_glute_r.position.set(0.068 * p.pelvisWidthScale, -0.034, 0.062 * p.pelvisDepthScale);
    const gluteMeshR = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 12, 10)), this.pantsMat);
    gluteMeshR.scale.set(p.gluteContourScale[0], p.gluteContourScale[1], p.gluteContourScale[2]);
    sec_glute_r.add(gluteMeshR);
    this.pelvis.add(sec_glute_l, sec_glute_r);

    // Holster socket (child of pelvis)
    const socket_weapon_holster = new THREE.Object3D();
    socket_weapon_holster.name = 'socket_weapon_holster';
    socket_weapon_holster.position.set(0.175 * p.pelvisWidthScale, -0.04, -0.005);
    this.pelvis.add(socket_weapon_holster);

    // Spine & Plate Carrier
    this.spineLower.position.set(0, 0.07, 0);
    this.pelvis.add(this.spineLower);
    const abdomen = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.136 * p.waistWidthScale, 0.140 * p.pelvisWidthScale, 0.15, 16)),
      this.sleeveMat,
    );
    abdomen.scale.set(1.04, 1.0, 0.66);
    abdomen.position.set(0, 0.065, 0);
    this.spineLower.add(abdomen);

    this.spineUpper.position.set(0, 0.13, 0);
    this.spineLower.add(this.spineUpper);
    const midTorso = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.160 * p.torsoWidthScale, 0.136 * p.waistWidthScale, 0.15, 16)),
      this.sleeveMat,
    );
    midTorso.scale.set(1.06, 1.0, 0.66 * p.chestDepthScale);
    midTorso.position.set(0, 0.065, 0);
    this.spineUpper.add(midTorso);

    this.chest.position.set(0, 0.13, 0);
    this.spineUpper.add(this.chest);

    const upperTorso = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.146 * p.torsoWidthScale, 0.162 * p.torsoWidthScale, 0.145, 16)),
      this.sleeveMat,
    );
    upperTorso.scale.set(1.12, 1.0, 0.64 * p.chestDepthScale);
    upperTorso.position.set(0, 0.035, 0.005);

    const trapSlope = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.155 * p.torsoWidthScale, 16, 10)), this.sleeveMat);
    trapSlope.scale.set(1.10, 0.34, 0.62);
    trapSlope.position.set(0, 0.10, 0.01);

    // Rigid SAPI Plate Carrier (strictly parented to spine_03 with >= 22mm clearance in front of sec_chest_*)
    const plateW = operatorId === 'FEMALE' ? 0.214 : 0.235;
    const plateH = operatorId === 'FEMALE' ? 0.224 : 0.235;
    const frontPlate = new THREE.Mesh(this.geo(createSapiPlateGeo(plateW, plateH, 0.022)), this.vestMat);
    frontPlate.name = 'gear_front_plate';
    frontPlate.position.set(0, -0.022, -0.098);
    frontPlate.rotation.x = 0.06;
    frontPlate.userData.interiorForwardZ = -0.080;
    frontPlate.userData.exteriorForwardZ = -0.114;

    const backPlate = new THREE.Mesh(this.geo(createSapiPlateGeo(plateW + 0.01, plateH + 0.018, 0.024)), this.vestMat);
    backPlate.name = 'gear_back_plate';
    backPlate.position.set(0, -0.015, 0.102);
    backPlate.rotation.x = -0.04;

    const cummerbund = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.158 * p.torsoWidthScale, 0.148 * p.waistWidthScale, 0.105, 16)),
      this.vestMat,
    );
    cummerbund.scale.set(1.08, 1.0, 0.66);
    cummerbund.position.set(0, -0.095, 0.005);
    this.chest.add(upperTorso, trapSlope, frontPlate, backPlate, cummerbund);

    // Secondary Chest Soft-Tissue Nodes (strictly child of spine_03, >= 20mm behind front SAPI plate interior)
    const sec_chest_l = new THREE.Group();
    sec_chest_l.name = 'sec_chest_l';
    sec_chest_l.position.set(-0.064 * p.torsoWidthScale, -0.008, p.chestContourOffsetZ);
    const chestMeshL = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 12, 10)), this.sleeveMat);
    chestMeshL.scale.set(p.chestContourScale[0], p.chestContourScale[1], p.chestContourScale[2]);
    sec_chest_l.add(chestMeshL);

    const sec_chest_r = new THREE.Group();
    sec_chest_r.name = 'sec_chest_r';
    sec_chest_r.position.set(0.064 * p.torsoWidthScale, -0.008, p.chestContourOffsetZ);
    const chestMeshR = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 12, 10)), this.sleeveMat);
    chestMeshR.scale.set(p.chestContourScale[0], p.chestContourScale[1], p.chestContourScale[2]);
    sec_chest_r.add(chestMeshR);
    this.chest.add(sec_chest_l, sec_chest_r);

    for (const side of [-1, 1]) {
      const strap = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.048, 0.022, 0.185, 0.008)), this.vestMat);
      strap.position.set(side * 0.094 * p.torsoWidthScale, 0.098, 0.004);
      strap.rotation.z = -side * 0.18;
      this.chest.add(strap);
    }

    for (let i = -1; i <= 1; i++) {
      const pouch = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.056, 0.102, 0.022, 0.010)), this.pouchMat);
      pouch.position.set(i * 0.068 * p.torsoWidthScale, -0.105, -0.114);
      pouch.rotation.set(0.08, -i * 0.14, 0);
      const flap = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.054, 0.026, 0.024, 0.007)), this.vestMat);
      flap.position.set(i * 0.068 * p.torsoWidthScale, -0.058, -0.112);
      flap.rotation.set(0.08, -i * 0.14, 0);
      this.chest.add(pouch, flap);
    }

    this.magPouchAnchor.name = 'anchor_mag_pouch';
    this.magPouchAnchor.position.set(-0.072 * p.torsoWidthScale, -0.095, -0.142);
    this.chest.add(this.magPouchAnchor);

    // Bodycam Mount Hardware & Canonical Socket (clears front plate exterior at -0.114 by >= 14mm)
    const camMount = new THREE.Mesh(this.geo(createRoundedPouchGeo(0.052, 0.066, 0.016, 0.007)), this.hardwareMat);
    camMount.position.set(0.03, 0.042, -0.108);
    camMount.rotation.x = 0.08;
    const chestIffPatch = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.064, 0.024, 0.01)), this.iffTrimMat);
    chestIffPatch.position.set(-0.052 * p.torsoWidthScale, 0.046, -0.108);
    chestIffPatch.rotation.x = 0.08;
    this.chest.add(camMount, chestIffPatch);

    const socket_bodycam_mount = new THREE.Object3D();
    socket_bodycam_mount.name = 'socket_bodycam_mount';
    socket_bodycam_mount.position.set(0.03, 0.042, -0.128);
    this.chest.add(socket_bodycam_mount);

    const ik_pole_elbow_l = new THREE.Object3D();
    ik_pole_elbow_l.name = 'ik_pole_elbow_l';
    ik_pole_elbow_l.position.set(-0.34, -0.16, 0.24);
    const ik_pole_elbow_r = new THREE.Object3D();
    ik_pole_elbow_r.name = 'ik_pole_elbow_r';
    ik_pole_elbow_r.position.set(0.34, -0.16, 0.24);
    this.chest.add(ik_pole_elbow_l, ik_pole_elbow_r);

    // Neck & Full Tactical Ballistic Head Assembly (anatomical neck + tapered collar + sculpted head)
    this.neck.position.set(0, 0.13, 0.015);
    this.chest.add(this.neck);
    const neckSkinRadiusTop = 0.044 * (operatorId === 'FEMALE' ? 0.92 : 1.0);
    const neckSkinRadiusBot = 0.056 * p.torsoWidthScale;
    const neckSkin = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(neckSkinRadiusTop, neckSkinRadiusBot, 0.095, 14)),
      this.wristSkinMat,
    );
    neckSkin.position.set(0, 0.042, 0);
    this.neck.add(neckSkin);
    this.headMeshes.push({ mesh: neckSkin, visibleMat: this.wristSkinMat });

    const neckGaiter = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.052 * (operatorId === 'FEMALE' ? 0.92 : 1.0), 0.064 * p.torsoWidthScale, 0.088, 14)),
      this.hoodMat,
    );
    neckGaiter.position.set(0, 0.039, 0);
    this.neck.add(neckGaiter);
    this.neckGaiterCollarMesh = neckGaiter;
    this.headMeshes.push({ mesh: neckGaiter, visibleMat: this.hoodMat });

    this.headGroup.position.set(0, 0.09, 0);
    this.neck.add(this.headGroup);
    this.buildTacticalHead(operatorId);

    // Articulated Arms & Legs (Nested Canonical Hierarchy)
    const armBuiltL = this.buildArm(-1, p.upperArmLen, p.lowerArmLen);
    const armBuiltR = this.buildArm(1, p.upperArmLen, p.lowerArmLen);
    this.leftArm = armBuiltL.arm;
    this.rightArm = armBuiltR.arm;

    const socket_weapon_r = new THREE.Object3D();
    socket_weapon_r.name = 'socket_weapon_r';
    socket_weapon_r.position.set(0, 0, -0.035);
    this.rightArm.hand.root.add(socket_weapon_r);

    this.throwHandSocket.name = 'throw_hand_socket';
    this.throwHandSocket.position.set(0, -0.026, -0.042);
    this.rightArm.hand.root.add(this.throwHandSocket);

    this.rightThumbTipSocket.name = 'right_thumb_tip_socket';
    this.rightThumbTipSocket.position.set(0, -0.002, -0.024 * p.handScale);
    this.rightArm.hand.thumbDist.add(this.rightThumbTipSocket);

    this.leftPinPinchSocket.name = 'left_pin_pinch_socket';
    this.leftPinPinchSocket.position.set(0.015, -0.014, -0.092);
    this.leftArm.hand.root.add(this.leftPinPinchSocket);

    this.leftPocketAnchor.name = 'left_pocket_anchor';
    this.leftPocketAnchor.position.set(-0.172 * p.pelvisWidthScale, -0.08, -0.02);
    this.pelvis.add(this.leftPocketAnchor);

    this.leftEyeAimAnchor.name = 'left_eye_aim_anchor';
    this.leftEyeAimAnchor.position.set(-0.145, 0.015, -0.44);
    this.chest.add(this.leftEyeAimAnchor);

    this.leftChestBalanceAnchor.name = 'left_chest_balance_anchor';
    this.leftChestBalanceAnchor.position.set(-0.155, -0.14, -0.26);
    this.chest.add(this.leftChestBalanceAnchor);

    this.leftLeg = this.buildLeg(-1, p.thighLen, p.shinLen, p.ankleHeight);
    this.rightLeg = this.buildLeg(1, p.thighLen, p.shinLen, p.ankleHeight);

    this.secondaryNodes = {
      sec_chest_l,
      sec_chest_r,
      sec_glute_l,
      sec_glute_r,
      sec_bicep_l: armBuiltL.secBicep,
      sec_tricep_l: armBuiltL.secTricep,
      sec_forearm_l: armBuiltL.secForearm,
      sec_bicep_r: armBuiltR.secBicep,
      sec_tricep_r: armBuiltR.secTricep,
      sec_forearm_r: armBuiltR.secForearm,
    };

    this.secondaryRestPos = {
      sec_chest_l: sec_chest_l.position.clone(),
      sec_chest_r: sec_chest_r.position.clone(),
      sec_glute_l: sec_glute_l.position.clone(),
      sec_glute_r: sec_glute_r.position.clone(),
      sec_bicep_l: armBuiltL.secBicep.position.clone(),
      sec_tricep_l: armBuiltL.secTricep.position.clone(),
      sec_forearm_l: armBuiltL.secForearm.position.clone(),
      sec_bicep_r: armBuiltR.secBicep.position.clone(),
      sec_tricep_r: armBuiltR.secTricep.position.clone(),
      sec_forearm_r: armBuiltR.secForearm.position.clone(),
    };

    this.sockets = {
      socket_weapon_r,
      socket_weapon_holster,
      socket_bodycam_mount,
      ik_pole_elbow_l,
      ik_pole_elbow_r,
    };

    // Build all 17 canonical Hit-Zone anchor nodes (`hz_*`)
    const makeHz = (
      name: HitZoneNodeName,
      parent: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      radius: number,
    ): THREE.Object3D => {
      const node = new THREE.Object3D();
      node.name = name;
      node.position.set(x, y, z);
      node.userData.hitZone = name;
      node.userData.hitRadius = radius;
      parent.add(node);
      return node;
    };

    this.hitZones = {
      hz_head: makeHz('hz_head', this.headGroup, 0, 0.11, -0.005, 0.115),
      hz_neck: makeHz('hz_neck', this.neck, 0, 0.045, 0, 0.062),
      hz_chest: makeHz('hz_chest', this.chest, 0, 0.0, 0, 0.155),
      hz_abdomen: makeHz('hz_abdomen', this.spineLower, 0, 0.065, 0, 0.135),
      hz_pelvis: makeHz('hz_pelvis', this.pelvis, 0, -0.01, 0, 0.145),
      hz_upperarm_l: makeHz('hz_upperarm_l', this.leftArm.upperArm, 0, p.upperArmLen * 0.5, 0, 0.055),
      hz_forearm_l: makeHz('hz_forearm_l', this.leftArm.forearm, 0, p.lowerArmLen * 0.5, 0, 0.045),
      hz_hand_l: makeHz('hz_hand_l', this.leftArm.hand.root, 0, 0, -0.04, 0.042),
      hz_upperarm_r: makeHz('hz_upperarm_r', this.rightArm.upperArm, 0, p.upperArmLen * 0.5, 0, 0.055),
      hz_forearm_r: makeHz('hz_forearm_r', this.rightArm.forearm, 0, p.lowerArmLen * 0.5, 0, 0.045),
      hz_hand_r: makeHz('hz_hand_r', this.rightArm.hand.root, 0, 0, -0.04, 0.042),
      hz_thigh_l: makeHz('hz_thigh_l', this.leftLeg.thigh, 0, p.thighLen * 0.5, 0, 0.075),
      hz_calf_l: makeHz('hz_calf_l', this.leftLeg.shin, 0, p.shinLen * 0.5, 0, 0.058),
      hz_foot_l: makeHz('hz_foot_l', this.leftLeg.boot, 0, -0.04, -0.05, 0.055),
      hz_thigh_r: makeHz('hz_thigh_r', this.rightLeg.thigh, 0, p.thighLen * 0.5, 0, 0.075),
      hz_calf_r: makeHz('hz_calf_r', this.rightLeg.shin, 0, p.shinLen * 0.5, 0, 0.058),
      hz_foot_r: makeHz('hz_foot_r', this.rightLeg.boot, 0, -0.04, -0.05, 0.055),
    };

    // Place rig in canonical standing rest pose (identical bone axes for MALE & FEMALE)
    this.applyCanonicalRestPose();

    // Enable shadows across full body
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    // Apply initial helmet/glove/NVG gear configuration cleanly before setting layers
    this.applyGearConfig(this.currentGear);

    if (previewMode) {
      // In 3D turntable preview, everything renders on Layer 0 with fully visible head/helmet
      this.setFirstPersonHeadShadowOnly(false);
    } else {
      // In bodycam FPS mode, arms render on VIEWMODEL_LAYER and head/helmet casts Layer 0 world shadows only
      this.enableArmViewmodelLayer();
      this.setFirstPersonHeadShadowOnly(true);
    }
  }

  private buildTacticalHead(operatorId: OperatorId): void {
    const scaleX = operatorId === 'FEMALE' ? 0.94 : 1.0;
    const registerHeadMesh = (parent: THREE.Object3D, mesh: THREE.Mesh): THREE.Mesh => {
      parent.add(mesh);
      this.headMeshes.push({ mesh, visibleMat: mesh.material as THREE.Material });
      return mesh;
    };

    // Anatomical head, 15 facial morphs, independent eyeballs, oral teeth, face gear & eyewear
    const headVariant = operatorId === 'FEMALE' ? 'female' : 'male';
    const headToneSeed = operatorId === 'FEMALE' ? 0 : 1;
    const assembly = buildAnatomicalHeadAssembly({
      variant: headVariant,
      toneSeed: headToneSeed,
      anisotropy: this.anisotropy,
      hoodMaterial: this.hoodMat,
      frameMaterial: this.knuckleMat,
      includeGearAndEyewear: true,
    });
    this.headAssembly = assembly;
    this.headGroup.add(assembly.root);
    for (let i = 0; i < assembly.allMeshes.length; i++) {
      const m = assembly.allMeshes[i];
      this.headMeshes.push({ mesh: m, visibleMat: m.material as THREE.Material });
    }

    // Tactical tied-back low bun silhouette under rear helmet rim for Female operator
    if (operatorId === 'FEMALE') {
      const hairBun = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.040, 12, 10)), this.knuckleMat);
      hairBun.scale.set(0.92, 0.84, 1.12);
      hairBun.position.set(0, 0.062, 0.104);
      registerHeadMesh(this.headGroup, hairBun);
    }

    // === 1. MICH-2000 HELMET (Full-cut ballistic shell, clean brow, NO shroud/mount) ===
    const michGroup = new THREE.Group();
    michGroup.name = 'helmet_mich';
    this.headGroup.add(michGroup);
    this.michHelmetGroup = michGroup;

    const michShell = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.106, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.54)),
      this.helmetMat,
    );
    michShell.name = 'helmet_mich_shell';
    michShell.scale.set(0.94 * scaleX, 1.00, 1.08);
    michShell.position.set(0, 0.128, 0.004);
    michShell.rotation.x = 0.16;
    registerHeadMesh(michGroup, michShell);

    // Full-cut side ear-flares characteristic of MICH-2000
    for (const side of [-1, 1]) {
      const earFlare = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.040, 0.046, 0.056, 10, 1, false, 0, Math.PI)),
        this.helmetMat,
      );
      earFlare.rotation.y = side > 0 ? 0 : Math.PI;
      earFlare.rotation.z = -side * 0.14;
      earFlare.scale.set(0.52, 1.0, 1.25);
      earFlare.position.set(side * 0.088 * scaleX, 0.095, 0.008);
      registerHeadMesh(michGroup, earFlare);

      const chinStrap = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.008, 0.058, 0.011)), this.knuckleMat);
      chinStrap.position.set(side * 0.080 * scaleX, 0.062, -0.018);
      chinStrap.rotation.z = side * 0.18;
      registerHeadMesh(michGroup, chinStrap);
    }

    // Subtle matte brim trim band
    const michBrim = new THREE.Mesh(this.geo(new THREE.TorusGeometry(0.103, 0.0055, 6, 22)), this.knuckleMat);
    michBrim.rotation.x = Math.PI * 0.5 + 0.16;
    michBrim.scale.set(0.93 * scaleX, 1.07, 1.0);
    michBrim.position.set(0, 0.125, 0.004);
    registerHeadMesh(michGroup, michBrim);

    // === 2. MIL-TEC HIGH-CUT HELMET (ARC rails, ear-pro, counterweight, Wilcox NVG shroud) ===
    const milTecGroup = new THREE.Group();
    milTecGroup.name = 'helmet_mil_tec';
    this.headGroup.add(milTecGroup);
    this.milTecHelmetGroup = milTecGroup;

    const fastShell = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.104, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.50)),
      this.helmetMat,
    );
    fastShell.name = 'helmet_mil_tec_shell';
    fastShell.scale.set(0.92 * scaleX, 0.98, 1.06);
    fastShell.position.set(0, 0.130, 0.002);
    fastShell.rotation.x = 0.16;
    registerHeadMesh(milTecGroup, fastShell);

    // Front Wilcox L4G24 NVG shroud baseplate + dove-tail socket
    const nvgShroud = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.040, 0.046, 0.020)), this.hardwareMat);
    nvgShroud.position.set(0, 0.175, -0.103);
    nvgShroud.rotation.x = -0.18;
    registerHeadMesh(milTecGroup, nvgShroud);

    const shroudPlate = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.028, 0.032, 0.011)), this.nvgAluminumMat);
    shroudPlate.position.set(0, 0.176, -0.111);
    shroudPlate.rotation.x = -0.18;
    registerHeadMesh(milTecGroup, shroudPlate);

    // Side ARC accessory rails & Peltor ComTac ear-pro cups
    for (const side of [-1, 1]) {
      const arcRail = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.012, 0.024, 0.098)), this.knuckleMat);
      arcRail.position.set(side * 0.092 * scaleX, 0.140, -0.006);
      arcRail.rotation.z = -side * 0.12;
      registerHeadMesh(milTecGroup, arcRail);

      const earCup = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.029, 0.032, 0.026, 12)), this.knuckleMat);
      earCup.rotation.z = Math.PI * 0.5;
      earCup.position.set(side * 0.090 * scaleX, 0.096, 0.004);
      registerHeadMesh(milTecGroup, earCup);
    }

    // Rear helmet battery pack / counterweight + IFF strobe patch
    const counterWeight = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.068, 0.040, 0.026)), this.pouchMat);
    counterWeight.position.set(0, 0.118, 0.104);
    registerHeadMesh(milTecGroup, counterWeight);

    const rearIff = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.052, 0.020, 0.008)), this.iffTrimMat);
    rearIff.position.set(0, 0.158, 0.100);
    registerHeadMesh(milTecGroup, rearIff);

    // Helmet crown IR IFF strobe housing (Layer 0) + blinking NVG-only IR emitter (IR_LAYER = 2)
    const strobeHousing = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.026, 0.013, 0.036)),
      this.irStrobeHousingMat,
    );
    strobeHousing.name = 'ir_strobe_housing';
    strobeHousing.position.set(0, 0.228, 0.025);
    registerHeadMesh(this.headGroup, strobeHousing);
    this.irStrobeHousingMesh = strobeHousing;

    const strobeEmitter = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.011, 8, 6)),
      this.irStrobeEmitterMat,
    );
    strobeEmitter.position.set(0, 0.238, 0.025);
    strobeEmitter.layers.set(IR_LAYER);
    strobeEmitter.visible = false;
    this.headGroup.add(strobeEmitter);
    this.irStrobeEmitterMeshes.push(strobeEmitter);

    // === ARTICULATING NVG PIVOT ARM (child of Mil-Tec helmet shroud) ===
    const nvgPivot = new THREE.Group();
    nvgPivot.name = 'nvg_mount_pivot';
    nvgPivot.position.set(0, 0.174, -0.116);
    milTecGroup.add(nvgPivot);
    this.nvgPivotGroup = nvgPivot;

    // Articulating Wilcox G24 arm extending down in front of eyes (when rotation.x = 0)
    const mountArm = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.022, 0.054, 0.018)), this.nvgAluminumMat);
    mountArm.position.set(0, -0.024, -0.014);
    mountArm.rotation.x = 0.25;
    registerHeadMesh(nvgPivot, mountArm);

    // --- 2A. AGM PVS-7 NL2 / NL1 (Classic Bi-Ocular single objective -> dual angled eyepieces) ---
    const pvs7Group = new THREE.Group();
    pvs7Group.name = 'nvg_pvs7';
    pvs7Group.position.set(0, -0.056, -0.028);
    nvgPivot.add(pvs7Group);
    this.pvs7MountGroup = pvs7Group;

    // Main polymer bi-ocular chassis body
    const pvs7Body = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.068, 0.038, 0.064)), this.nvgBodyMat);
    pvs7Body.position.set(0, 0, -0.010);
    registerHeadMesh(pvs7Group, pvs7Body);

    // Single central intensifier objective barrel + knurled focus ring + front multi-coated lens
    const pvs7ObjBarrel = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.021, 0.023, 0.052, 14)),
      this.nvgBodyMat,
    );
    pvs7ObjBarrel.rotation.x = Math.PI * 0.5;
    pvs7ObjBarrel.position.set(0, 0.002, -0.056);
    registerHeadMesh(pvs7Group, pvs7ObjBarrel);

    const pvs7FocusRing = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0245, 0.0245, 0.014, 14)),
      this.nvgAluminumMat,
    );
    pvs7FocusRing.rotation.x = Math.PI * 0.5;
    pvs7FocusRing.position.set(0, 0.002, -0.064);
    registerHeadMesh(pvs7Group, pvs7FocusRing);

    const pvs7FrontLens = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.018, 0.018, 0.004, 14)),
      this.nvgLensPvs7Mat,
    );
    pvs7FrontLens.rotation.x = Math.PI * 0.5;
    pvs7FrontLens.position.set(0, 0.002, -0.082);
    registerHeadMesh(pvs7Group, pvs7FrontLens);

    // Built-in IR illuminator diode dome & rotary gain/ABC switch on top-right
    const pvs7IrDome = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.0065, 0.0075, 0.016, 10)), this.hardwareMat);
    pvs7IrDome.rotation.x = Math.PI * 0.5;
    pvs7IrDome.position.set(0.024, 0.012, -0.044);
    registerHeadMesh(pvs7Group, pvs7IrDome);

    const pvs7Knob = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.008, 0.009, 0.012, 10)), this.nvgAluminumMat);
    pvs7Knob.position.set(-0.022, 0.022, -0.012);
    registerHeadMesh(pvs7Group, pvs7Knob);

    // Dual split angled rear eyepieces + rubber eyecups
    for (const side of [-1, 1]) {
      const eyepiece = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0155, 0.017, 0.036, 12)),
        this.nvgBodyMat,
      );
      eyepiece.rotation.x = Math.PI * 0.5;
      eyepiece.rotation.z = -side * 0.14;
      eyepiece.position.set(side * 0.031, -0.003, 0.024);
      registerHeadMesh(pvs7Group, eyepiece);

      const eyecup = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0185, 0.0155, 0.014, 12)),
        this.knuckleMat,
      );
      eyecup.rotation.x = Math.PI * 0.5;
      eyecup.position.set(side * 0.032, -0.003, 0.044);
      registerHeadMesh(pvs7Group, eyecup);
    }

    // --- 2B. AB NIGHTVISION RNVG-A (ARNVG) BUILD KIT (7075 Aluminum Articulating Dual-Tube + MIL40 Lenses) ---
    const arnvgGroup = new THREE.Group();
    arnvgGroup.name = 'nvg_arnvg';
    arnvgGroup.position.set(0, -0.056, -0.026);
    nvgPivot.add(arnvgGroup);
    this.arnvgMountGroup = arnvgGroup;

    // Central machined 7075-T6 aluminum articulating bridge + battery compartment + LEMO port
    const arnvgBridge = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.072, 0.022, 0.036)), this.nvgAluminumMat);
    arnvgBridge.position.set(0, 0.012, -0.008);
    registerHeadMesh(arnvgGroup, arnvgBridge);

    const arnvgBatt = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.010, 0.010, 0.042, 10)),
      this.hardwareMat,
    );
    arnvgBatt.rotation.x = Math.PI * 0.5;
    arnvgBatt.position.set(0, 0.014, -0.030);
    registerHeadMesh(arnvgGroup, arnvgBatt);

    // Dual articulating pods with ruggedized rings & MIL40 white-phosphor sapphire-coated lenses
    for (const side of [-1, 1]) {
      const podPivot = new THREE.Group();
      podPivot.position.set(side * 0.034, -0.004, -0.008);
      podPivot.rotation.z = side * 0.04;
      arnvgGroup.add(podPivot);

      const tube = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0195, 0.0205, 0.088, 14)),
        this.nvgAluminumMat,
      );
      tube.rotation.x = Math.PI * 0.5;
      tube.position.set(0, 0, -0.014);
      registerHeadMesh(podPivot, tube);

      // MIL40 objective knurled bezel collar
      const mil40Collar = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0225, 0.0215, 0.016, 14)),
        this.nvgBodyMat,
      );
      mil40Collar.rotation.x = Math.PI * 0.5;
      mil40Collar.position.set(0, 0, -0.052);
      registerHeadMesh(podPivot, mil40Collar);

      // Multi-coated sapphire MIL40 objective glass
      const mil40Lens = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0175, 0.0175, 0.004, 14)),
        this.nvgLensArnvgMat,
      );
      mil40Lens.rotation.x = Math.PI * 0.5;
      mil40Lens.position.set(0, 0, -0.060);
      registerHeadMesh(podPivot, mil40Lens);

      // Rear ocular housing & diopter ring
      const ocular = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.017, 0.019, 0.022, 12)),
        this.nvgBodyMat,
      );
      ocular.rotation.x = Math.PI * 0.5;
      ocular.position.set(0, 0, 0.036);
      registerHeadMesh(podPivot, ocular);
    }

    // Default stowed upward position
    this.setNvgFlipped(false);
  }

  public setNvgFlipped(flippedDown: boolean): void {
    this.nvgFlippedDown = flippedDown;
    if (this.nvgPivotGroup) {
      // Stowed cleanly upward over helmet brow (+1.38 rad) vs deployed directly in front of eyes (0.0 rad)
      this.nvgPivotGroup.rotation.x = flippedDown ? 0.0 : 1.38;
    }
  }

  public applyGearConfig(patch: Partial<OperatorGearConfig>): void {
    this.currentGear = normalizeOperatorGearConfig({
      ...this.currentGear,
      ...patch,
    });
    const g = this.currentGear;
    const preset = TACTICAL_UNIFORM_PRESETS[this.currentUniformId] ?? TACTICAL_UNIFORM_PRESETS.infection;

    // 1. Helmet model, strobe visibility & color
    if (this.michHelmetGroup) {
      this.michHelmetGroup.visible = g.helmetType === 'mich';
    }
    if (this.milTecHelmetGroup) {
      this.milTecHelmetGroup.visible = g.helmetType === 'mil_tec';
    }
    if (this.irStrobeHousingMesh) {
      this.irStrobeHousingMesh.visible = g.helmetType !== 'none';
    }
    if (g.helmetType === 'none') {
      for (let i = 0; i < this.irStrobeEmitterMeshes.length; i++) {
        this.irStrobeEmitterMeshes[i].visible = false;
      }
    }
    const hSpec = HELMET_COLOR_MAP[g.helmetColor];
    this.helmetMat.color.setHex(
      g.helmetColor === 'uniform' || !hSpec ? preset.helmetHex : hSpec.hex,
    );

    // 2. NVG Mount visibility (strictly on Mil-Tec)
    const hasNvg = g.helmetType === 'mil_tec' && g.nvgMount !== 'none';
    if (this.nvgPivotGroup) {
      this.nvgPivotGroup.visible = hasNvg;
    }
    if (this.pvs7MountGroup) {
      this.pvs7MountGroup.visible = hasNvg && g.nvgMount === 'pvs7';
    }
    if (this.arnvgMountGroup) {
      this.arnvgMountGroup.visible = hasNvg && g.nvgMount === 'arnvg';
    }
    this.setNvgFlipped(hasNvg && this.nvgFlippedDown);

    // 3. Gloves ON/OFF + Glove Color
    for (let i = 0; i < this.gloveOnlyMeshes.length; i++) {
      this.gloveOnlyMeshes[i].visible = g.glovesEnabled;
    }

    if (g.glovesEnabled) {
      const gSpec = GLOVE_COLOR_MAP[g.gloveColor];
      const gloveRgb: [number, number, number] =
        g.gloveColor === 'uniform' || !gSpec
          ? [preset.gloveRgb[0], preset.gloveRgb[1], preset.gloveRgb[2]]
          : [gSpec.rgb[0], gSpec.rgb[1], gSpec.rgb[2]];
      const palmRgb: [number, number, number] =
        g.gloveColor === 'uniform' || !gSpec
          ? [preset.palmRgb[0], preset.palmRgb[1], preset.palmRgb[2]]
          : [gSpec.palmRgb[0], gSpec.palmRgb[1], gSpec.palmRgb[2]];

      const oldCustom = this.customGloveTexSets;
      const gTex = buildFabricTextureSet(gloveRgb, 0.14, 0.18, 0.78, 137 + gloveRgb[0], this.anisotropy, 'olive_bdu');
      const pTex = buildFabricTextureSet(palmRgb, 0.10, 0.22, 0.88, 173 + palmRgb[0], this.anisotropy, 'olive_bdu');
      this.customGloveTexSets = [gTex, pTex];

      this.gloveMat.map = gTex.map;
      this.gloveMat.normalMap = gTex.normalMap;
      this.gloveMat.roughnessMap = gTex.roughnessMap;
      this.gloveMat.needsUpdate = true;

      this.palmLeatherMat.map = pTex.map;
      this.palmLeatherMat.normalMap = pTex.normalMap;
      this.palmLeatherMat.roughnessMap = pTex.roughnessMap;
      this.palmLeatherMat.needsUpdate = true;

      for (const old of oldCustom) {
        old.map.dispose();
        old.normalMap.dispose();
        old.roughnessMap.dispose();
      }
    }

    for (let i = 0; i < this.handGlovePrimaryMeshes.length; i++) {
      this.handGlovePrimaryMeshes[i].material = g.glovesEnabled ? this.gloveMat : this.wristSkinMat;
    }
    for (let i = 0; i < this.handGlovePalmMeshes.length; i++) {
      this.handGlovePalmMeshes[i].material = g.glovesEnabled ? this.palmLeatherMat : this.wristSkinMat;
    }

    // 4. Face Gear & Eyewear
    if (this.headAssembly) {
      this.headAssembly.applyFaceGear(g.faceGear);
      this.headAssembly.applyEyewear(g.eyewear);
    }
    if (this.neckGaiterCollarMesh) {
      this.neckGaiterCollarMesh.visible = g.faceGear !== 'open_face';
    }
  }

  public updateFacial(
    dt: number,
    patch?: Partial<FacialExpressionInput>,
  ): void {
    if (!this.headAssembly) return;
    const inp = this._facialInputScratch;
    inp.mode = 'human';
    inp.intent = patch?.intent ?? 'calm';
    inp.stress01 = patch?.stress01 ?? 0.1;
    inp.injury01 = patch?.injury01 ?? 0;
    inp.flinchImpulse01 = patch?.flinchImpulse01 ?? 0;
    inp.gazeTargetWorld = patch?.gazeTargetWorld ?? null;
    inp.localGazeYaw = patch?.localGazeYaw;
    inp.localGazePitch = patch?.localGazePitch;
    inp.distanceToCameraM = patch?.distanceToCameraM ?? 1.5;
    inp.isVisible = patch?.isVisible ?? true;
    this.facialController.step(
      dt,
      inp,
      this.headAssembly.root,
      this.headAssembly.morphTargetInfluences,
      this.headAssembly.eyeL,
      this.headAssembly.eyeR,
    );
  }

  public getHeadAssembly(): BuiltAnatomicalHeadAssembly | null {
    return this.headAssembly;
  }

  public getGearConfig(): Readonly<OperatorGearConfig> {
    return this.currentGear;
  }

  /**
   * Controls single-rig head/helmet shadow-only masking:
   * - `true`: Bodycam FPS mode — head & FAST helmet stay visible to Layer 0 shadow maps while
   *   writing zero color/depth pixels to the chest-cam lens (never clips even at -85° downward pitch).
   * - `false`: 3D Pre-Deployment Preview / Third-person / Ragdoll mode — full PBR helmet renders normally.
   */
  public setFirstPersonHeadShadowOnly(shadowOnly: boolean): void {
    this.headShadowOnly = shadowOnly;
    this.headGroup.visible = true;
    for (let i = 0; i < this.headMeshes.length; i++) {
      const entry = this.headMeshes[i];
      entry.mesh.layers.set(0);
      entry.mesh.castShadow = true;
      entry.mesh.receiveShadow = !shadowOnly;
      entry.mesh.material = shadowOnly ? this.headShadowOnlyMat : entry.visibleMat;
    }
    for (let i = 0; i < this.irStrobeEmitterMeshes.length; i++) {
      const emitter = this.irStrobeEmitterMeshes[i];
      emitter.castShadow = shadowOnly;
      emitter.receiveShadow = false;
      emitter.material = shadowOnly ? this.headShadowOnlyMat : this.irStrobeEmitterMat;
      if (shadowOnly) {
        emitter.visible = false;
        emitter.layers.set(0);
      } else {
        emitter.layers.set(IR_LAYER);
      }
    }
  }

  public isHeadShadowOnly(): boolean {
    return this.headShadowOnly;
  }

  /**
   * Resets all primary bones into the canonical standing rest pose (root at `(0,0,0)` between boots,
   * boots resting on `y = 0`, identical bone axis orientations across MALE & FEMALE operators).
   */
  public applyCanonicalRestPose(): void {
    const p = this.profile;
    const restPelvisY = p.ankleHeight + p.shinLen + p.thighLen + 0.04;

    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.scale.set(1, 1, 1);

    this.pelvis.position.set(0, restPelvisY, 0);
    this.pelvis.rotation.set(0, 0, 0);

    this.spineLower.position.set(0, 0.07, 0);
    this.spineLower.rotation.set(0, 0, 0);

    this.spineUpper.position.set(0, 0.13, 0);
    this.spineUpper.rotation.set(0, 0, 0);

    this.chest.position.set(0, 0.13, 0);
    this.chest.rotation.set(0, 0, 0);

    this.neck.position.set(0, 0.13, 0.015);
    this.neck.rotation.set(0, 0, 0);

    this.headGroup.position.set(0, 0.09, 0);
    this.headGroup.rotation.set(0, 0, 0);

    // Arms hanging cleanly downward along -Y (local +Y of arm bone points down -> rotation.x = Math.PI)
    const resetArm = (arm: ArticulatedArm, side: -1 | 1): void => {
      arm.clavicle.position.set(side * p.clavicleOffsetX, 0.092, 0.014);
      arm.clavicle.rotation.set(0, 0, 0);

      arm.shoulderPivot.position.set(side * p.shoulderHalfSpanX, 0.002, 0.010);
      arm.shoulderPivot.rotation.set(0, 0, 0);

      arm.upperArm.position.set(side * p.shoulderHalfSpanX, 0.002, 0.010);
      arm.upperArm.rotation.set(Math.PI, 0, 0);

      arm.forearm.position.set(0, arm.upperLen, 0);
      arm.forearm.rotation.set(0, 0, 0);

      arm.hand.root.position.set(0, arm.lowerLen, 0);
      arm.hand.root.rotation.set(-Math.PI * 0.5, 0, 0);
    };

    resetArm(this.leftArm, -1);
    resetArm(this.rightArm, 1);

    // Legs standing cleanly vertically down to y = 0
    const resetLeg = (leg: ArticulatedLeg, side: -1 | 1): void => {
      leg.hipPivot.position.set(side * p.hipOffsetX, -0.04, 0);
      leg.hipPivot.rotation.set(0, 0, 0);

      leg.thigh.position.set(side * p.hipOffsetX, -0.04, 0);
      leg.thigh.rotation.set(Math.PI, 0, 0);

      leg.shin.position.set(0, leg.upperLen, 0);
      leg.shin.rotation.set(0, 0, 0);

      leg.boot.position.set(0, leg.lowerLen, 0);
      leg.boot.rotation.set(Math.PI, 0, 0);

      leg.toe.position.set(0, -leg.ankleHeight + 0.028, leg.toeRestZ);
      leg.toe.rotation.set(0, 0, 0);
    };

    resetLeg(this.leftLeg, -1);
    resetLeg(this.rightLeg, 1);

    this.applyHandPose('left', 'unarmed', false, 0.42);
    this.applyHandPose('right', 'unarmed', false, 0.42);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Authoritative gender-distinct idle stances for the 3D Pre-Deployment Turntable Stage.
   * Rig local convention: forward is -Z, up is +Y, right is +X, left is -X.
   * - Knees strictly bend anatomically BACKWARD (shin folds toward rear of thigh, knee forward -Z).
   * - Elbows strictly bend anatomically FORWARD (+X in local upperArm frame with Rx(PI) rest).
   * - Arms hang naturally at sides with outward Z clearance so sleeves/gloves never clip gear or hips.
   * - Both boots sit flat at y = 0.000 via root-space 2-bone IK + horizontal outsole leveling.
   */
  public applyPreviewReadyPose(timeSec: number): void {
    this.applyCanonicalRestPose();
    const p = this.profile;
    const isFemale = this.operatorId === 'FEMALE';

    const breath = Math.sin(timeSec * 1.55);
    const breath2 = Math.sin(timeSec * 0.78 + 0.6);
    const gazeScan = Math.sin(timeSec * 0.44) * 0.038;

    if (isFemale) {
      // === FEMALE PREVIEW POSE: Distinct, Tasteful Contrapposto ===
      // Weight shifted onto planted straight right leg (+X); right hip lifted (+Z roll),
      // opposing gentle upper-torso counter-tilt (-Z), subtle 3/4 torso yaw (+Y) with head turned back.
      this.pelvis.position.x = 0.030 + breath2 * 0.0018;
      this.pelvis.position.y -= 0.017 - breath * 0.0020;
      this.pelvis.position.z = 0.004;
      this.pelvis.rotation.set(0.012, -0.045 + breath2 * 0.008, 0.072);

      this.spineLower.rotation.set(0.014 + breath * 0.006, 0.040, -0.022);
      this.spineUpper.rotation.set(0.014 + breath * 0.008, 0.040, -0.022);
      this.chest.rotation.set(-0.016 + breath * 0.010, 0.032, -0.015);
      this.neck.rotation.set(-0.008, -0.032, -0.008);
      this.headGroup.rotation.set(-0.010 + breath * 0.005, -0.055 + gazeScan, -0.006);

      // Arms resting cleanly at sides (~0.12 rad outward Z clearance, relaxed forward elbow bend, palms inward)
      this.leftArm.clavicle.rotation.set(0, 0.02, 0.032 + breath * 0.010);
      this.leftArm.upperArm.rotation.set(Math.PI - 0.035, 0.04, 0.125 + breath * 0.008);
      this.leftArm.forearm.rotation.set(0.22 + breath * 0.012, 0.0, -0.025);
      this.leftArm.hand.root.rotation.set(Math.PI * 0.5, 0.04, 1.32);

      this.rightArm.clavicle.rotation.set(0, -0.02, -0.038 - breath * 0.010);
      this.rightArm.upperArm.rotation.set(Math.PI - 0.025, -0.04, -0.118 - breath * 0.008);
      this.rightArm.forearm.rotation.set(0.20 + breath * 0.012, 0.0, 0.02);
      this.rightArm.hand.root.rotation.set(Math.PI * 0.5, -0.04, -1.32);
    } else {
      // === MALE PREVIEW POSE: Grounded Tactical Operator ===
      // Level pelvis, broad squared chest, relaxed shoulders, level gaze, arms naturally at sides.
      this.pelvis.position.x = breath2 * 0.0014;
      this.pelvis.position.y -= 0.020 - breath * 0.0022;
      this.pelvis.position.z = 0.0;
      this.pelvis.rotation.set(0.015, -0.03 + breath2 * 0.006, 0);

      this.spineLower.rotation.set(0.014 + breath * 0.006, 0.015, 0);
      this.spineUpper.rotation.set(0.014 + breath * 0.008, 0.015, 0);
      this.chest.rotation.set(-0.018 + breath * 0.011, 0.01, 0);
      this.neck.rotation.set(-0.006, -0.01, 0);
      this.headGroup.rotation.set(-0.008 + breath * 0.005, gazeScan * 0.75, 0);

      // Arms hanging naturally downward from outer shoulders (~0.11 rad outward Z clearance, zero gear clipping)
      this.leftArm.clavicle.rotation.set(0, 0.015, 0.028 + breath * 0.011);
      this.leftArm.upperArm.rotation.set(Math.PI - 0.03, 0.03, 0.115 + breath * 0.007);
      this.leftArm.forearm.rotation.set(0.21 + breath * 0.012, 0.0, -0.018);
      this.leftArm.hand.root.rotation.set(Math.PI * 0.5, 0.03, 1.34);

      this.rightArm.clavicle.rotation.set(0, -0.015, -0.028 - breath * 0.011);
      this.rightArm.upperArm.rotation.set(Math.PI - 0.03, -0.03, -0.115 - breath * 0.007);
      this.rightArm.forearm.rotation.set(0.21 + breath * 0.012, 0.0, 0.018);
      this.rightArm.hand.root.rotation.set(Math.PI * 0.5, -0.03, -1.34);
    }

    // Solve both legs in root local space via analytic 2-bone IK with strictly forward (-Z) knee poles:
    // Guarantees knees ALWAYS bend anatomically backward at the shin and both boots sit flat on y = 0.000.
    this.root.updateMatrixWorld(true);
    this._previewInvRootMat.copy(this.root.matrixWorld).invert();
    this.leftLeg.hipPivot.getWorldPosition(this._previewHipL).applyMatrix4(this._previewInvRootMat);
    this.rightLeg.hipPivot.getWorldPosition(this._previewHipR).applyMatrix4(this._previewInvRootMat);

    const ankleY = p.ankleHeight;
    let toeOutLeftRad: number;
    let toeOutRightRad: number;

    if (isFemale) {
      // Right leg straight & supportive under shifted right hip; left leg stepped slightly forward with soft knee bend
      this._previewAnkleR.set(0.104, ankleY, 0.018);
      this._previewAnkleL.set(-0.118, ankleY, -0.082);
      // Forward knee poles (-Z) aligned gently with foot turn-out
      this._previewPoleR.set(0.12, ankleY + 0.40, -0.68);
      this._previewPoleL.set(-0.145, ankleY + 0.39, -0.72);
      toeOutLeftRad = THREE.MathUtils.degToRad(14);
      toeOutRightRad = THREE.MathUtils.degToRad(6);
    } else {
      // Grounded athletic stance: shoulder-width apart, left foot ~0.05m forward, ~8 deg toe-out
      this._previewAnkleL.set(-0.128, ankleY, -0.052);
      this._previewAnkleR.set(0.128, ankleY, 0.022);
      this._previewPoleL.set(-0.165, ankleY + 0.39, -0.70);
      this._previewPoleR.set(0.165, ankleY + 0.39, -0.66);
      toeOutLeftRad = THREE.MathUtils.degToRad(8);
      toeOutRightRad = THREE.MathUtils.degToRad(8);
    }

    // Left Leg IK + flat floor boot orientation (+Y yaw rotates -Z toes outward toward -X)
    solveTwoBoneIK(
      this._previewHipL,
      this._previewAnkleL,
      this._previewPoleL,
      this.leftLeg.upperLen,
      this.leftLeg.lowerLen,
      this._previewLegIKL,
    );
    orientLimbAlongYInRootSpace(
      this.leftLeg.thigh,
      this.root,
      this._previewHipL,
      this._previewLegIKL.midPos,
      this._previewPoleL,
    );
    orientLimbAlongYInRootSpace(
      this.leftLeg.shin,
      this.root,
      this._previewLegIKL.midPos,
      this._previewLegIKL.endPos,
      this._previewPoleL,
    );
    this._previewBootEuler.set(0, toeOutLeftRad, 0, 'YXZ');
    this._previewBootQuat.setFromEuler(this._previewBootEuler);
    setTransformInRootSpace(
      this.leftLeg.boot,
      this.root,
      this._previewLegIKL.endPos,
      this._previewBootQuat,
    );

    // Right Leg IK + flat floor boot orientation (-Y yaw rotates -Z toes outward toward +X)
    solveTwoBoneIK(
      this._previewHipR,
      this._previewAnkleR,
      this._previewPoleR,
      this.rightLeg.upperLen,
      this.rightLeg.lowerLen,
      this._previewLegIKR,
    );
    orientLimbAlongYInRootSpace(
      this.rightLeg.thigh,
      this.root,
      this._previewHipR,
      this._previewLegIKR.midPos,
      this._previewPoleR,
    );
    orientLimbAlongYInRootSpace(
      this.rightLeg.shin,
      this.root,
      this._previewLegIKR.midPos,
      this._previewLegIKR.endPos,
      this._previewPoleR,
    );
    this._previewBootEuler.set(0, -toeOutRightRad, 0, 'YXZ');
    this._previewBootQuat.setFromEuler(this._previewBootEuler);
    setTransformInRootSpace(
      this.rightLeg.boot,
      this.root,
      this._previewLegIKR.endPos,
      this._previewBootQuat,
    );

    this.applyHandPose('left', 'unarmed', false, 0.34);
    this.applyHandPose('right', 'unarmed', false, 0.34);
    this.root.updateMatrixWorld(true);
  }

  public applyUniform(uniformId: OperatorUniformId): void {
    if (this.currentUniformId === uniformId) return;
    this.currentUniformId = uniformId;
    const preset = TACTICAL_UNIFORM_PRESETS[uniformId] ?? TACTICAL_UNIFORM_PRESETS.infection;
    const s = preset.seedOffset;

    const oldSets = this.texSets;
    const sleeveTex = buildFabricTextureSet(preset.sleeveRgb, 0.08, 0.14, 0.88, s + 17, this.anisotropy, preset.camoPattern);
    const pantsTex = buildFabricTextureSet(preset.pantsRgb, 0.09, 0.18, 0.90, s + 43, this.anisotropy, preset.camoPattern);
    const vestTex = buildFabricTextureSet(preset.vestRgb, 0.12, 0.14, 0.84, s + 71, this.anisotropy, preset.camoPattern);
    const bootTex = buildFabricTextureSet(preset.bootRgb, 0.04, 0.22, 0.72, s + 109, this.anisotropy, 'olive_bdu');
    const gloveTex = buildFabricTextureSet(preset.gloveRgb, 0.14, 0.18, 0.78, s + 137, this.anisotropy, 'olive_bdu');
    const palmTex = buildFabricTextureSet(preset.palmRgb, 0.10, 0.22, 0.88, s + 173, this.anisotropy, 'olive_bdu');
    this.texSets = [sleeveTex, pantsTex, vestTex, bootTex, gloveTex, palmTex];

    const bindTex = (mat: THREE.MeshStandardMaterial, tex: ProceduralFabricSet, withRough = true): void => {
      mat.map = tex.map;
      mat.normalMap = tex.normalMap;
      if (withRough) mat.roughnessMap = tex.roughnessMap;
      mat.needsUpdate = true;
    };

    bindTex(this.sleeveMat, sleeveTex);
    bindTex(this.pantsMat, pantsTex);
    bindTex(this.vestMat, vestTex);
    bindTex(this.pouchMat, vestTex, false);
    this.pouchMat.color.setHex(preset.pouchTintHex);
    bindTex(this.gloveMat, gloveTex);
    bindTex(this.palmLeatherMat, palmTex);
    bindTex(this.bootMat, bootTex);

    this.watchDialMat.emissive.setHex(preset.watchEmissiveHex);
    this.hardwareMat.color.setHex(preset.hardwareHex);
    this.hoodMat.color.setHex(preset.hoodHex);
    this.helmetMat.color.setHex(preset.helmetHex);
    this.visorMat.color.setHex(preset.visorHex);
    this.iffTrimMat.color.setHex(preset.iffTrimHex);
    this.iffTrimMat.emissive.setHex(preset.iffEmissiveHex);
    this.iffTrimMat.emissiveIntensity = preset.iffEmissiveIntensity;

    // Re-apply operator custom helmet color & glove color/visibility on top of new uniform
    this.applyGearConfig(this.currentGear);

    for (const t of oldSets) {
      t.map.dispose();
      t.normalMap.dispose();
      t.roughnessMap.dispose();
    }
  }

  public setFactionArmband(colorHex: number | null): void {
    const visible = colorHex !== null;
    if (visible) {
      this.armbandMat.color.setHex(colorHex);
    }
    for (let i = 0; i < this.armbandMeshes.length; i++) {
      this.armbandMeshes[i].visible = visible;
    }
  }

  public setIrStrobe(enabled: boolean, pulseOn = true): void {
    const show =
      enabled && pulseOn && !this.headShadowOnly && this.currentGear.helmetType !== 'none';
    for (let i = 0; i < this.irStrobeEmitterMeshes.length; i++) {
      this.irStrobeEmitterMeshes[i].visible = show;
      if (!this.headShadowOnly) {
        this.irStrobeEmitterMeshes[i].layers.set(IR_LAYER);
      }
    }
  }

  public enableArmViewmodelLayer(): void {
    const assignLayer = (rootObj: THREE.Object3D): void => {
      rootObj.traverse((obj) => {
        if (obj instanceof THREE.Mesh && !this.irStrobeEmitterMeshes.includes(obj)) {
          obj.layers.set(VIEWMODEL_LAYER);
        }
      });
    };
    assignLayer(this.leftArm.clavicle);
    assignLayer(this.rightArm.clavicle);
  }

  public setAllMeshesWorldLayer(): void {
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && !this.irStrobeEmitterMeshes.includes(obj)) {
        obj.layers.set(0);
      }
    });
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geos.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.mats.push(m);
    return m;
  }

  private buildArm(
    side: -1 | 1,
    upperLen: number,
    lowerLen: number,
  ): {
    arm: ArticulatedArm;
    secBicep: THREE.Group;
    secTricep: THREE.Group;
    secForearm: THREE.Group;
  } {
    const p = this.profile;
    const suffix = side < 0 ? 'l' : 'r';
    const armR = p.armRadiusScale;
    const foreR = p.forearmRadiusScale;

    const clavicle = new THREE.Group();
    clavicle.name = `clavicle_${suffix}`;
    clavicle.position.set(side * p.clavicleOffsetX, 0.092, 0.014);
    this.chest.add(clavicle);

    const shoulderPivot = new THREE.Object3D();
    shoulderPivot.name = `pivot_shoulder_${suffix}`;
    shoulderPivot.position.set(side * p.shoulderHalfSpanX, 0.002, 0.010);
    clavicle.add(shoulderPivot);

    // Canonical upperarm_l / upperarm_r strictly parented under clavicle_l / clavicle_r
    const upperArm = new THREE.Group();
    upperArm.name = `upperarm_${suffix}`;
    upperArm.position.copy(shoulderPivot.position);
    clavicle.add(upperArm);

    const shoulderCap = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.052 * armR, 12, 10)), this.sleeveMat);
    shoulderCap.position.set(0, 0.008, 0);
    const bicepCore = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.041 * armR, 0.049 * armR, upperLen, 12)),
      this.sleeveMat,
    );
    bicepCore.position.set(0, upperLen * 0.5, 0);
    const shoulderPocket = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.018, 0.080, 0.054)), this.vestMat);
    shoulderPocket.position.set(side * 0.042 * armR, upperLen * 0.32, 0);
    const shoulderIff = new THREE.Mesh(this.geo(new THREE.BoxGeometry(0.008, 0.036, 0.046)), this.iffTrimMat);
    shoulderIff.position.set(side * 0.052 * armR, upperLen * 0.33, 0);
    // Woven cloth faction identification armband wrapping upper bicep sleeve
    const armband = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0465 * armR, 0.0495 * armR, 0.054, 14)),
      this.armbandMat,
    );
    armband.position.set(0, upperLen * 0.62, 0);
    armband.visible = false;
    this.armbandMeshes.push(armband);
    upperArm.add(shoulderCap, bicepCore, shoulderPocket, shoulderIff, armband);

    // Secondary Bicep & Tricep Soft-Tissue Nodes (children of upperarm_l/r)
    const secBicep = new THREE.Group();
    secBicep.name = `sec_bicep_${suffix}`;
    secBicep.position.set(0, upperLen * 0.48, -0.016 * armR);
    const bicepBelly = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 10, 8)), this.sleeveMat);
    bicepBelly.scale.set(0.034 * armR, 0.072, 0.034 * armR);
    secBicep.add(bicepBelly);

    const secTricep = new THREE.Group();
    secTricep.name = `sec_tricep_${suffix}`;
    secTricep.position.set(0, upperLen * 0.46, 0.018 * armR);
    const tricepBelly = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 10, 8)), this.sleeveMat);
    tricepBelly.scale.set(0.034 * armR, 0.074, 0.034 * armR);
    secTricep.add(tricepBelly);
    upperArm.add(secBicep, secTricep);

    // Canonical lowerarm_l / lowerarm_r strictly parented under upperarm_l / upperarm_r
    const forearm = new THREE.Group();
    forearm.name = `lowerarm_${suffix}`;
    forearm.position.set(0, upperLen, 0);
    upperArm.add(forearm);

    const elbowPad = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.041 * foreR, 12, 8)), this.knuckleMat);
    elbowPad.scale.set(0.88, 0.96, 0.72);
    elbowPad.position.set(0, 0.015, 0.022 * foreR);
    const sleeveLen = lowerLen - 0.062;
    const foreMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.032 * foreR, 0.043 * foreR, sleeveLen, 12)),
      this.sleeveMat,
    );
    foreMesh.scale.set(1.06, 1.0, 0.78);
    foreMesh.position.set(0, sleeveLen * 0.5, 0);
    const cuff = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0365 * foreR, 0.0355 * foreR, 0.026, 12)),
      this.pouchMat,
    );
    cuff.scale.set(1.08, 1.0, 0.79);
    cuff.position.set(0, lowerLen - 0.062, 0);
    const cuffTrim = new THREE.Mesh(
      this.geo(new THREE.TorusGeometry(0.0355 * foreR, 0.0045, 6, 14)),
      this.sleeveMat,
    );
    cuffTrim.rotation.x = Math.PI * 0.5;
    cuffTrim.scale.set(1.08, 0.79, 1.0);
    cuffTrim.position.set(0, lowerLen - 0.050, 0);
    const wristBridge = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0255 * foreR, 0.0295 * foreR, 0.064, 12)),
      this.wristSkinMat,
    );
    wristBridge.scale.set(1.12, 1.0, 0.70);
    wristBridge.position.set(0, lowerLen - 0.028, 0);
    const ulnarBone = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.0085 * foreR, 8, 6)), this.wristSkinMat);
    ulnarBone.scale.set(0.85, 1.25, 0.80);
    ulnarBone.position.set(side * 0.025 * foreR, lowerLen - 0.014, 0.011);
    forearm.add(elbowPad, foreMesh, cuff, cuffTrim, wristBridge, ulnarBone);

    // Secondary Forearm Soft-Tissue Node (child of lowerarm_l/r)
    const secForearm = new THREE.Group();
    secForearm.name = `sec_forearm_${suffix}`;
    secForearm.position.set(0, lowerLen * 0.34, -0.010 * foreR);
    const foreBelly = new THREE.Mesh(this.geo(new THREE.SphereGeometry(1.0, 10, 8)), this.sleeveMat);
    foreBelly.scale.set(0.032 * foreR, 0.064, 0.026 * foreR);
    secForearm.add(foreBelly);
    forearm.add(secForearm);

    if (side === -1) {
      const watchY = lowerLen - 0.034;
      const strap = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(0.0295 * foreR, 0.0305 * foreR, 0.020, 14)),
        this.knuckleMat,
      );
      strap.scale.set(1.14, 1.0, 0.73);
      strap.position.set(0, watchY, 0);
      const bezel = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.0175, 0.0185, 0.0065, 16)), this.hardwareMat);
      bezel.rotation.x = Math.PI * 0.5;
      bezel.position.set(0, watchY, 0.022 * foreR);
      const dial = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(0.0142, 0.0142, 0.0022, 16)), this.watchDialMat);
      dial.rotation.x = Math.PI * 0.5;
      dial.position.set(0, watchY, 0.0252 * foreR);
      forearm.add(strap, bezel, dial);
    }

    // Canonical hand_l / hand_r strictly parented under lowerarm_l / lowerarm_r
    const hand = this.buildHand(side);
    hand.root.name = `hand_${suffix}`;
    hand.root.position.set(0, lowerLen, 0);
    forearm.add(hand.root);

    return {
      arm: { clavicle, shoulderPivot, upperArm, forearm, hand, upperLen, lowerLen },
      secBicep,
      secTricep,
      secForearm,
    };
  }

  private buildHand(side: -1 | 1): ArticulatedHand {
    const hs = this.profile.handScale;
    const root = new THREE.Group();

    const wristCuff = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0285 * hs, 0.0278 * hs, 0.036, 14)),
      this.gloveMat,
    );
    wristCuff.rotation.x = Math.PI * 0.5;
    wristCuff.scale.set(1.13, 1.0, 0.72);
    wristCuff.position.set(0, 0, -0.001);
    const strapBand = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0298 * hs, 0.0295 * hs, 0.013, 14)),
      this.knuckleMat,
    );
    strapBand.rotation.x = Math.PI * 0.5;
    strapBand.scale.set(1.14, 1.0, 0.74);
    strapBand.position.set(0, 0, 0.003);
    this.gloveOnlyMeshes.push(wristCuff, strapBand);
    root.add(wristCuff, strapBand);

    const palmShape = new THREE.Shape();
    palmShape.moveTo(-0.025 * hs, 0.0);
    palmShape.lineTo(0.025 * hs, 0.0);
    palmShape.quadraticCurveTo(0.033 * hs, 0.030 * hs, 0.032 * hs, 0.064 * hs);
    palmShape.quadraticCurveTo(0.0, 0.072 * hs, -0.032 * hs, 0.064 * hs);
    palmShape.quadraticCurveTo(-0.033 * hs, 0.030 * hs, -0.025 * hs, 0.0);

    const palmGeo = this.geo(
      new THREE.ExtrudeGeometry(palmShape, {
        depth: 0.015 * hs,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.0045 * hs,
        bevelThickness: 0.0045 * hs,
      }),
    );
    palmGeo.rotateX(-Math.PI * 0.5);
    palmGeo.translate(0, -0.0075 * hs, -0.002);
    const palm = new THREE.Mesh(palmGeo, this.gloveMat);
    this.handGlovePrimaryMeshes.push(palm);
    root.add(palm);

    const suedePalm = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.054 * hs, 0.005, 0.054 * hs)),
      this.palmLeatherMat,
    );
    suedePalm.position.set(0, -0.011 * hs, -0.038 * hs);
    this.gloveOnlyMeshes.push(suedePalm);
    root.add(suedePalm);

    const mcpSpecs = [
      { x: -side * 0.024 * hs, y: 0.0025, z: -0.067 * hs, splayY: side * 0.055, r: 0.0076 * hs, l1: 0.030 * hs, l2: 0.020 * hs, l3: 0.018 * hs },
      { x: -side * 0.008 * hs, y: 0.0042, z: -0.071 * hs, splayY: side * 0.015, r: 0.0080 * hs, l1: 0.034 * hs, l2: 0.023 * hs, l3: 0.019 * hs },
      { x: side * 0.009 * hs, y: 0.0032, z: -0.068 * hs, splayY: -side * 0.020, r: 0.0075 * hs, l1: 0.031 * hs, l2: 0.021 * hs, l3: 0.018 * hs },
      { x: side * 0.025 * hs, y: 0.0005, z: -0.062 * hs, splayY: -side * 0.065, r: 0.0067 * hs, l1: 0.025 * hs, l2: 0.017 * hs, l3: 0.016 * hs },
    ];

    const knuckleBridge = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0075 * hs, 0.0075 * hs, 0.056 * hs, 8)),
      this.knuckleMat,
    );
    knuckleBridge.rotation.z = Math.PI * 0.5;
    knuckleBridge.scale.set(0.75, 1.0, 1.35);
    knuckleBridge.position.set(0, 0.0105 * hs, -0.058 * hs);
    this.gloveOnlyMeshes.push(knuckleBridge);
    root.add(knuckleBridge);

    for (let i = 0; i < mcpSpecs.length; i++) {
      const m = mcpSpecs[i];
      const dome = new THREE.Mesh(this.geo(new THREE.SphereGeometry(m.r * 1.16, 10, 8)), this.knuckleMat);
      dome.scale.set(1.05, 0.72, 1.15);
      dome.position.set(m.x, m.y + 0.008 * hs, m.z + 0.006 * hs);
      this.gloveOnlyMeshes.push(dome);
      root.add(dome);
    }

    // Sculpted thenar eminence (thumb base muscle mound bridging palm smoothly into thumbProx)
    const thenarMound = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.0145 * hs, 10, 8)),
      this.gloveMat,
    );
    thenarMound.scale.set(0.92, 0.78, 1.28);
    thenarMound.position.set(-side * 0.022 * hs, -0.005 * hs, -0.019 * hs);
    this.handGlovePrimaryMeshes.push(thenarMound);
    root.add(thenarMound);

    const thumbProx = new THREE.Group();
    thumbProx.position.set(-side * 0.029 * hs, -0.0055 * hs, -0.022 * hs);
    thumbProx.rotation.set(0.14, side * 0.48, 0);
    const thumbMcpCap = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.0102 * hs, 10, 8)),
      this.gloveMat,
    );
    thumbMcpCap.scale.set(1.04, 0.92, 1.04);
    this.handGlovePrimaryMeshes.push(thumbMcpCap);
    const thumbProxMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0086 * hs, 0.0102 * hs, 0.029 * hs, 12)),
      this.gloveMat,
    );
    thumbProxMesh.rotation.x = Math.PI * 0.5;
    thumbProxMesh.position.set(0, 0, -0.0145 * hs);
    this.handGlovePrimaryMeshes.push(thumbProxMesh);
    thumbProx.add(thumbMcpCap, thumbProxMesh);

    const thumbDist = new THREE.Group();
    thumbDist.position.set(0, 0, -0.029 * hs);
    const thumbIpCap = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.0088 * hs, 10, 8)),
      this.gloveMat,
    );
    thumbIpCap.scale.set(1.06, 0.90, 1.04);
    this.handGlovePrimaryMeshes.push(thumbIpCap);
    const thumbDistMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.0072 * hs, 0.0086 * hs, 0.024 * hs, 12)),
      this.palmLeatherMat,
    );
    thumbDistMesh.rotation.x = Math.PI * 0.5;
    thumbDistMesh.position.set(0, 0, -0.012 * hs);
    const thumbTipDome = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.0074 * hs, 10, 8)),
      this.palmLeatherMat,
    );
    thumbTipDome.scale.set(1.08, 0.84, 1.14);
    thumbTipDome.position.set(0, -0.0005 * hs, -0.024 * hs);
    this.handGlovePalmMeshes.push(thumbDistMesh, thumbTipDome);
    thumbDist.add(thumbIpCap, thumbDistMesh, thumbTipDome);
    thumbProx.add(thumbDist);
    root.add(thumbProx);

    const makeFinger = (specIdx: number): ArticulatedFinger => {
      const m = mcpSpecs[specIdx];
      const proximal = new THREE.Group();
      proximal.position.set(m.x, m.y, m.z);
      proximal.rotation.y = m.splayY;

      const seg1 = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(m.r * 0.88, m.r, m.l1, 10)), this.gloveMat);
      seg1.rotation.x = Math.PI * 0.5;
      seg1.position.set(0, 0, -m.l1 * 0.5);
      this.handGlovePrimaryMeshes.push(seg1);
      proximal.add(seg1);

      const middle = new THREE.Group();
      middle.position.set(0, 0, -m.l1);
      const seg2 = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(m.r * 0.78, m.r * 0.87, m.l2, 10)), this.gloveMat);
      seg2.rotation.x = Math.PI * 0.5;
      seg2.position.set(0, 0, -m.l2 * 0.5);
      this.handGlovePrimaryMeshes.push(seg2);
      middle.add(seg2);

      const distal = new THREE.Group();
      distal.position.set(0, 0, -m.l2);
      const seg3 = new THREE.Mesh(
        this.geo(new THREE.CylinderGeometry(m.r * 0.65, m.r * 0.77, m.l3, 10)),
        this.palmLeatherMat,
      );
      seg3.rotation.x = Math.PI * 0.5;
      seg3.position.set(0, 0, -m.l3 * 0.5);
      this.handGlovePalmMeshes.push(seg3);
      distal.add(seg3);

      middle.add(distal);
      proximal.add(middle);
      root.add(proximal);
      return { proximal, middle, distal };
    };

    return {
      root,
      palm,
      side,
      thumbProx,
      thumbDist,
      index: makeFinger(0),
      middle: makeFinger(1),
      ring: makeFinger(2),
      pinky: makeFinger(3),
    };
  }

  private buildLeg(side: -1 | 1, upperLen: number, lowerLen: number, ankleHeight: number): ArticulatedLeg {
    const p = this.profile;
    const suffix = side < 0 ? 'l' : 'r';

    const hipPivot = new THREE.Object3D();
    hipPivot.name = `pivot_hip_${suffix}`;
    hipPivot.position.set(side * p.hipOffsetX, -0.04, 0.0);
    this.pelvis.add(hipPivot);

    // Canonical thigh_l / thigh_r strictly parented under pelvis
    const thigh = new THREE.Group();
    thigh.name = `thigh_${suffix}`;
    thigh.position.copy(hipPivot.position);
    this.pelvis.add(thigh);

    const thighMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.064 * p.thighRadiusScale, 0.084 * p.thighRadiusScale, upperLen, 12)),
      this.pantsMat,
    );
    thighMesh.position.set(0, upperLen * 0.5, 0);
    const cargoPocket = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.052 * p.thighRadiusScale, 0.054 * p.thighRadiusScale, 0.15, 8)),
      this.pantsMat,
    );
    cargoPocket.scale.set(0.32, 1.0, 0.95);
    cargoPocket.position.set(side * 0.062 * p.thighRadiusScale, upperLen * 0.56, 0);
    thigh.add(thighMesh, cargoPocket);

    // Canonical calf_l / calf_r strictly parented under thigh_l / thigh_r
    const shin = new THREE.Group();
    shin.name = `calf_${suffix}`;
    shin.position.set(0, upperLen, 0);
    thigh.add(shin);

    const kneePad = new THREE.Mesh(this.geo(new THREE.SphereGeometry(0.058 * p.shinRadiusScale, 10, 8)), this.knuckleMat);
    kneePad.scale.set(0.88, 0.92, 0.56);
    kneePad.position.set(0, 0.01, 0.044 * p.shinRadiusScale);
    const shinMesh = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.049 * p.shinRadiusScale, 0.064 * p.shinRadiusScale, lowerLen, 12)),
      this.pantsMat,
    );
    shinMesh.position.set(0, lowerLen * 0.5, 0);
    shin.add(kneePad, shinMesh);

    // Canonical foot_l / foot_r strictly parented under calf_l / calf_r
    const boot = new THREE.Group();
    boot.name = `foot_${suffix}`;
    boot.position.set(0, lowerLen, 0);
    shin.add(boot);

    // Sculpted Multi-Part Tactical Boot (Female noticeably smaller & sleeker: ~0.82x footprint, narrower toe box, slimmer shaft)
    const isFemale = this.operatorId === 'FEMALE';
    const lenS = isFemale ? 0.82 : 1.0;
    const widS = isFemale ? 0.80 : 1.0;
    const shaftS = isFemale ? 0.84 : 1.0;
    const soleBottomY = -ankleHeight;

    // 1. Contoured Lugged Rubber Outsole (ExtrudeGeometry footprint with tapered toe, arch waist, rounded heel)
    const soleShape = new THREE.Shape();
    const heelW = 0.041 * widS;
    const waistW = 0.036 * widS;
    const ballW = 0.051 * widS;
    const toeW = 0.034 * widS;
    const heelBackY = -0.068 * lenS; // maps to +Z (rear heel) after rotateX(-PI/2)
    const archY = 0.018 * lenS;
    const ballY = 0.118 * lenS;
    const toeTipY = 0.186 * lenS; // maps to -Z (front toe) after rotateX(-PI/2)

    soleShape.moveTo(-heelW * 0.72, heelBackY);
    soleShape.quadraticCurveTo(0, heelBackY - 0.012 * lenS, heelW * 0.72, heelBackY);
    soleShape.quadraticCurveTo(heelW, heelBackY + 0.018 * lenS, heelW * 0.96, heelBackY + 0.056 * lenS);
    soleShape.quadraticCurveTo(waistW, archY, ballW, ballY - 0.012 * lenS);
    soleShape.quadraticCurveTo(ballW * 1.02, ballY + 0.036 * lenS, toeW, toeTipY - 0.016 * lenS);
    soleShape.quadraticCurveTo(0, toeTipY + 0.008 * lenS, -toeW, toeTipY - 0.016 * lenS);
    soleShape.quadraticCurveTo(-ballW * 1.02, ballY + 0.036 * lenS, -ballW, ballY - 0.012 * lenS);
    soleShape.quadraticCurveTo(-waistW, archY, -heelW * 0.96, heelBackY + 0.056 * lenS);
    soleShape.quadraticCurveTo(-heelW, heelBackY + 0.018 * lenS, -heelW * 0.72, heelBackY);

    const midsoleGeo = this.geo(
      new THREE.ExtrudeGeometry(soleShape, {
        depth: 0.016,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.003,
        bevelThickness: 0.003,
      }),
    );
    midsoleGeo.rotateX(-Math.PI * 0.5);
    // Outsole midsole sits slightly raised above lug bottoms so lugs & heel block contact y = 0.000
    const midsole = new THREE.Mesh(midsoleGeo, this.soleMat);
    midsole.position.set(0, soleBottomY + 0.009, 0);
    boot.add(midsole);

    // 2. Raised Rear Heel Block + Transverse Forefoot Tread Lugs (bottom faces flush at y = -ankleHeight)
    const heelBlock = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.080 * widS, 0.016, 0.068 * lenS)),
      this.soleMat,
    );
    heelBlock.position.set(0, soleBottomY + 0.008, 0.034 * lenS);
    boot.add(heelBlock);

    const forefootLugZs = [-0.042, -0.072, -0.102, -0.132, -0.158];
    const lugGeo = this.geo(new THREE.BoxGeometry(0.088 * widS, 0.008, 0.015 * lenS));
    for (let i = 0; i < forefootLugZs.length; i++) {
      const lug = new THREE.Mesh(lugGeo, this.soleMat);
      const widthTaper = i === 4 ? 0.72 : i === 3 ? 0.90 : 1.0;
      lug.scale.set(widthTaper, 1, 1);
      lug.position.set(0, soleBottomY + 0.004, forefootLugZs[i] * lenS);
      boot.add(lug);
    }

    // 3. Sculpted Boot Vamp, Sloped Instep & Reinforced Heel Counter
    const vampShape = new THREE.Shape();
    vampShape.moveTo(-heelW * 0.65, heelBackY + 0.006 * lenS);
    vampShape.quadraticCurveTo(0, heelBackY - 0.006 * lenS, heelW * 0.65, heelBackY + 0.006 * lenS);
    vampShape.quadraticCurveTo(heelW * 0.92, heelBackY + 0.045 * lenS, ballW * 0.88, ballY - 0.012 * lenS);
    vampShape.quadraticCurveTo(ballW * 0.84, ballY + 0.028 * lenS, toeW * 0.82, toeTipY - 0.030 * lenS);
    vampShape.quadraticCurveTo(0, toeTipY - 0.014 * lenS, -toeW * 0.82, toeTipY - 0.030 * lenS);
    vampShape.quadraticCurveTo(-ballW * 0.84, ballY + 0.028 * lenS, -ballW * 0.88, ballY - 0.012 * lenS);
    vampShape.quadraticCurveTo(-heelW * 0.92, heelBackY + 0.045 * lenS, -heelW * 0.65, heelBackY + 0.006 * lenS);

    const vampGeo = this.geo(
      new THREE.ExtrudeGeometry(vampShape, {
        depth: 0.036,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.005,
        bevelThickness: 0.006,
      }),
    );
    vampGeo.rotateX(-Math.PI * 0.5);
    const vamp = new THREE.Mesh(vampGeo, this.bootMat);
    vamp.position.set(0, soleBottomY + 0.024, 0);
    boot.add(vamp);

    // Sloped instep bridge connecting vamp into front of laced shaft
    const instep = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.034 * widS, 0.044 * widS, 0.088 * lenS, 10)),
      this.bootMat,
    );
    instep.rotation.x = Math.PI * 0.34;
    instep.scale.set(1.0, 1.0, 0.72);
    instep.position.set(0, soleBottomY + 0.068, -0.056 * lenS);
    boot.add(instep);

    // Rigid heel counter cup
    const heelCounter = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.041 * widS, 0.044 * widS, 0.056, 10)),
      this.knuckleMat,
    );
    heelCounter.scale.set(0.96, 1.0, 0.88);
    heelCounter.position.set(0, soleBottomY + 0.048, 0.024 * lenS);
    boot.add(heelCounter);

    // 4. Laced Ankle Collar & Shaft meeting lower shin cleanly with ZERO gap
    const shaftH = 0.145;
    const shaft = new THREE.Mesh(
      this.geo(new THREE.CylinderGeometry(0.052 * shaftS, 0.050 * shaftS, shaftH, 12)),
      this.bootMat,
    );
    shaft.scale.set(0.95, 1.0, 1.06);
    // Top of shaft reaches y = +0.078 above ankle joint, tucking seamlessly into lower calf/pant cuff
    shaft.position.set(0, 0.005, 0.006 * lenS);
    boot.add(shaft);

    const collarRoll = new THREE.Mesh(
      this.geo(new THREE.TorusGeometry(0.051 * shaftS, 0.0085 * shaftS, 8, 14)),
      this.knuckleMat,
    );
    collarRoll.rotation.x = Math.PI * 0.5;
    collarRoll.scale.set(0.96, 1.08, 1.0);
    collarRoll.position.set(0, 0.072, 0.006 * lenS);
    boot.add(collarRoll);

    // Front tongue + metallic speed-hook eyelets & horizontal cross-laces
    const tongue = new THREE.Mesh(
      this.geo(new THREE.BoxGeometry(0.036 * widS, 0.112, 0.016)),
      this.pouchMat,
    );
    tongue.position.set(0, 0.012, -0.044 * shaftS);
    tongue.rotation.x = 0.10;
    boot.add(tongue);

    const laceBarGeo = this.geo(new THREE.BoxGeometry(0.038 * widS, 0.0045, 0.006));
    const eyeletGeo = this.geo(new THREE.SphereGeometry(0.0036, 6, 5));
    for (let i = 0; i < 4; i++) {
      const ly = -0.022 + i * 0.024;
      const lz = (-0.052 + i * 0.0025) * shaftS;
      const lace = new THREE.Mesh(laceBarGeo, this.knuckleMat);
      lace.position.set(0, ly, lz);
      boot.add(lace);

      for (const es of [-1, 1]) {
        const eyelet = new THREE.Mesh(eyeletGeo, this.hardwareMat);
        eyelet.position.set(es * 0.020 * widS, ly, lz + 0.002);
        boot.add(eyelet);
      }
    }

    // 5. Canonical toe_l / toe_r strictly parented under foot_l / foot_r (tapered reinforced toe cap)
    const toeRestZ = -0.136 * lenS;
    const toe = new THREE.Group();
    toe.name = `toe_${suffix}`;
    toe.position.set(0, soleBottomY + 0.028, toeRestZ);

    const toeDome = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.042, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.58)),
      this.bootMat,
    );
    toeDome.scale.set(0.96 * widS, 0.78, 1.24 * lenS);
    toeDome.position.set(0, -0.004, 0.002);

    const toeBumper = new THREE.Mesh(
      this.geo(new THREE.SphereGeometry(0.043, 12, 8, 0, Math.PI * 2, Math.PI * 0.26, Math.PI * 0.34)),
      this.soleMat,
    );
    toeBumper.scale.set(0.98 * widS, 0.72, 1.28 * lenS);
    toeBumper.position.set(0, -0.007, -0.002 * lenS);

    toe.add(toeDome, toeBumper);
    boot.add(toe);

    return { hipPivot, thigh, shin, boot, toe, upperLen, lowerLen, ankleHeight, toeRestZ };
  }

  public applyHandPose(
    side: 'left' | 'right',
    holdClass: BodycamWeaponHoldClass,
    triggerPulledOrAds: boolean,
    customCurl = 0.85,
    foregripStyle: 'none' | 'vertical' | 'angled' = 'none',
    opts?: HandPoseDynamicOptions,
  ): void {
    const hand = side === 'left' ? this.leftArm.hand : this.rightArm.hand;
    const s = hand.side;
    const scale = THREE.MathUtils.clamp(customCurl, 0, 1.15);
    const profile = opts?.profile ?? null;
    const triggerPull01 = THREE.MathUtils.clamp(opts?.triggerPull01 ?? 0, 0, 1);
    const pinchPose01 = THREE.MathUtils.clamp(opts?.pinchPose01 ?? 0, 0, 1);
    const gripRelease01 = THREE.MathUtils.clamp(opts?.gripRelease01 ?? 0, 0, 1);
    const thumbFlick01 = THREE.MathUtils.clamp(opts?.thumbFlick01 ?? 0, 0, 1);
    const padTap01 = THREE.MathUtils.clamp(opts?.padTap01 ?? 0, 0, 1);

    const setFinger = (
      f: ArticulatedFinger,
      proxDeg: number,
      midDeg: number,
      distDeg: number,
      splayYRad = 0,
    ): void => {
      f.proximal.rotation.x = -THREE.MathUtils.degToRad(proxDeg);
      f.proximal.rotation.y = splayYRad;
      f.middle.rotation.x = -THREE.MathUtils.degToRad(midDeg);
      f.distal.rotation.x = -THREE.MathUtils.degToRad(distDeg);
    };

    const isFirearm = holdClass === 'pistol' || holdClass === 'rifle' || holdClass === 'shotgun';

    if (side === 'right' && isFirearm) {
      // Geometry-driven right-hand wrap: tighter around slim grips (Makarov 0.024m), wider open arc on chunky grips (Deagle 0.036m)
      const gripW = profile ? profile.gripWidthM : 0.029;
      const gripD = profile ? profile.gripDepthM : 0.044;
      const girthNorm = THREE.MathUtils.clamp(
        ((gripW - 0.024) / 0.014) * 0.6 + ((gripD - 0.038) / 0.016) * 0.4,
        0,
        1,
      );
      // Slimmer grip = slightly higher proximal/mid wrap without clipping through frame
      const gripTight = THREE.MathUtils.lerp(1.12, 0.80, girthNorm) * scale;
      const gripDistTight = THREE.MathUtils.lerp(1.16, 0.74, girthNorm) * scale;

      setFinger(hand.middle, 34 * gripTight, 49 * gripTight, 30 * gripDistTight);
      setFinger(hand.ring, 37 * gripTight, 52 * gripTight, 33 * gripDistTight);
      setFinger(hand.pinky, 41 * gripTight, 56 * gripTight, 36 * gripDistTight);

      // Smooth continuous trigger-discipline blend (0 = straight along frame, 1 = curved onto trigger shoe)
      const engage = THREE.MathUtils.clamp(
        opts?.triggerEngageBlend ?? (triggerPulledOrAds ? 1 : 0),
        0,
        1,
      );
      const restProx = 4;
      const restMid = 7;
      const restDist = 4;
      const restSplay = -s * 0.095;

      // Calibrated natural trigger-shoe contact + smooth squeeze travel
      const onProx = 20 + triggerPull01 * 17;
      const onMid = 37 + triggerPull01 * 22;
      const onDist = 23 + triggerPull01 * 14;
      const onSplay = s * 0.015;

      setFinger(
        hand.index,
        THREE.MathUtils.lerp(restProx, onProx, engage),
        THREE.MathUtils.lerp(restMid, onMid, engage),
        THREE.MathUtils.lerp(restDist, onDist, engage),
        THREE.MathUtils.lerp(restSplay, onSplay, engage),
      );

      // Thumb wraps high tang; smoothly flicks up/forward when actuating left-side safety/selector
      const baseThumbX = THREE.MathUtils.lerp(-0.20, -0.14, girthNorm);
      const baseThumbY = s * THREE.MathUtils.lerp(0.62, 0.50, girthNorm);
      const baseThumbZ = -s * 0.22;
      hand.thumbProx.rotation.set(
        THREE.MathUtils.lerp(baseThumbX, 0.16, thumbFlick01),
        THREE.MathUtils.lerp(baseThumbY, s * 0.22, thumbFlick01),
        THREE.MathUtils.lerp(baseThumbZ, s * 0.14, thumbFlick01),
      );
      hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.56, -0.18, thumbFlick01), 0, 0);
      return;
    }

    // Left-hand suppressor cylinder grip with dynamic ratcheted regrip release
    if (side === 'left' && opts?.suppressorGrip) {
      const suppR = profile ? profile.suppressorRadiusM : 0.019;
      // Larger suppressor diameter -> slightly wider finger arc
      const rNorm = THREE.MathUtils.clamp((suppR - 0.015) / 0.010, 0, 1);
      const closedScale = THREE.MathUtils.lerp(1.06, 0.84, rNorm) * scale;
      // Release opens fingers clearly off the tube during regrip roll-back
      const gripMul = THREE.MathUtils.lerp(closedScale, 0.30, gripRelease01);

      setFinger(hand.index, 52 * gripMul, 66 * gripMul, 42 * gripMul, gripRelease01 * 0.08);
      setFinger(hand.middle, 56 * gripMul, 70 * gripMul, 45 * gripMul);
      setFinger(hand.ring, 58 * gripMul, 72 * gripMul, 47 * gripMul);
      setFinger(hand.pinky, 60 * gripMul, 74 * gripMul, 49 * gripMul, -gripRelease01 * 0.06);
      hand.thumbProx.rotation.set(
        THREE.MathUtils.lerp(-0.30, -0.06, gripRelease01),
        s * THREE.MathUtils.lerp(0.46, 0.22, gripRelease01),
        THREE.MathUtils.lerp(-s * 0.12, s * 0.12, gripRelease01),
      );
      hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.48, -0.12, gripRelease01), 0, 0);
      return;
    }

    // Left-hand thumb-index pinch pose (scope throw-lever, elevation turret, illumination dial)
    if (side === 'left' && pinchPose01 > 0.01) {
      const p = pinchPose01;
      // Thumb and index oppose cleanly to pinch dial/lever; lower 3 fingers curl naturally clear
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

    if (side === 'left' && (holdClass === 'rifle' || holdClass === 'shotgun')) {
      const style =
        foregripStyle === 'vertical'
          ? 'vertical_grip'
          : foregripStyle === 'angled'
            ? 'angled_grip'
            : (profile?.supportStyle ?? 'handguard');
      const suppR = profile ? profile.supportRadiusM : 0.026;
      const rNorm = THREE.MathUtils.clamp((suppR - 0.014) / 0.020, 0, 1);
      const wrapScale = THREE.MathUtils.lerp(1.12, 0.78, rNorm) * scale;

      if (style === 'vertical_grip') {
        setFinger(hand.index, 72 * wrapScale, 86 * wrapScale, 52 * wrapScale);
        setFinger(hand.middle, 78 * wrapScale, 92 * wrapScale, 56 * wrapScale);
        setFinger(hand.ring, 82 * wrapScale, 96 * wrapScale, 60 * wrapScale);
        setFinger(hand.pinky, 86 * wrapScale, 100 * wrapScale, 64 * wrapScale);
        hand.thumbProx.rotation.set(
          THREE.MathUtils.lerp(-0.34, 0.04, padTap01),
          s * THREE.MathUtils.lerp(0.44, 0.24, padTap01),
          THREE.MathUtils.lerp(-s * 0.16, s * 0.14, padTap01),
        );
        hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.52, -0.18, padTap01), 0, 0);
        return;
      }
      if (style === 'angled_grip') {
        setFinger(hand.index, 15 * wrapScale, 24 * wrapScale, 13 * wrapScale);
        setFinger(hand.middle, 28 * wrapScale, 42 * wrapScale, 26 * wrapScale);
        setFinger(hand.ring, 33 * wrapScale, 47 * wrapScale, 29 * wrapScale);
        setFinger(hand.pinky, 38 * wrapScale, 52 * wrapScale, 32 * wrapScale);
        hand.thumbProx.rotation.set(
          THREE.MathUtils.lerp(0.08, 0.18, padTap01),
          s * THREE.MathUtils.lerp(0.12, 0.26, padTap01),
          s * THREE.MathUtils.lerp(0.28, 0.12, padTap01),
        );
        hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.14, -0.30, padTap01), 0, 0);
        return;
      }
      if (style === 'pump_forend') {
        // Firm cradled cup around ribbed shotgun pump forend
        setFinger(hand.index, 30 * wrapScale, 44 * wrapScale, 28 * wrapScale);
        setFinger(hand.middle, 34 * wrapScale, 48 * wrapScale, 31 * wrapScale);
        setFinger(hand.ring, 38 * wrapScale, 52 * wrapScale, 34 * wrapScale);
        setFinger(hand.pinky, 42 * wrapScale, 56 * wrapScale, 36 * wrapScale);
        hand.thumbProx.rotation.set(
          THREE.MathUtils.lerp(-0.10, 0.08, padTap01),
          s * THREE.MathUtils.lerp(0.24, 0.30, padTap01),
          s * 0.16,
        );
        hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.28, -0.36, padTap01), 0, 0);
        return;
      }
      if (style === 'handguard_cradle') {
        // Modern high-thumb C-clamp over slim free-float MLOK handguard
        setFinger(hand.index, 24 * wrapScale, 36 * wrapScale, 22 * wrapScale);
        setFinger(hand.middle, 29 * wrapScale, 42 * wrapScale, 26 * wrapScale);
        setFinger(hand.ring, 33 * wrapScale, 46 * wrapScale, 29 * wrapScale);
        setFinger(hand.pinky, 37 * wrapScale, 50 * wrapScale, 32 * wrapScale);
        hand.thumbProx.rotation.set(
          THREE.MathUtils.lerp(0.04, 0.16, padTap01),
          s * THREE.MathUtils.lerp(0.32, 0.38, padTap01),
          s * THREE.MathUtils.lerp(0.26, 0.14, padTap01),
        );
        hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.16, -0.34, padTap01), 0, 0);
        return;
      }
      setFinger(hand.index, 22 * wrapScale, 32 * wrapScale, 20 * wrapScale);
      setFinger(hand.middle, 26 * wrapScale, 37 * wrapScale, 24 * wrapScale);
      setFinger(hand.ring, 29 * wrapScale, 40 * wrapScale, 26 * wrapScale);
      setFinger(hand.pinky, 33 * wrapScale, 44 * wrapScale, 28 * wrapScale);
      hand.thumbProx.rotation.set(
        THREE.MathUtils.lerp(-0.06, 0.12, padTap01),
        s * THREE.MathUtils.lerp(0.20, 0.30, padTap01),
        s * THREE.MathUtils.lerp(0.14, 0.08, padTap01),
      );
      hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.22, -0.34, padTap01), 0, 0);
      return;
    }

    if (side === 'left' && holdClass === 'pistol') {
      const gripW = profile ? profile.gripWidthM : 0.029;
      const wrapScale = THREE.MathUtils.lerp(1.06, 0.84, THREE.MathUtils.clamp((gripW - 0.024) / 0.014, 0, 1)) * scale;
      setFinger(hand.index, 26 * wrapScale, 38 * wrapScale, 22 * wrapScale);
      setFinger(hand.middle, 30 * wrapScale, 42 * wrapScale, 25 * wrapScale);
      setFinger(hand.ring, 33 * wrapScale, 45 * wrapScale, 27 * wrapScale);
      setFinger(hand.pinky, 36 * wrapScale, 48 * wrapScale, 29 * wrapScale);
      // Forward-indexed support thumb on pistol frame (presses WML paddle on padTap01)
      hand.thumbProx.rotation.set(
        THREE.MathUtils.lerp(-0.04, 0.14, padTap01),
        s * THREE.MathUtils.lerp(0.14, 0.24, padTap01),
        s * THREE.MathUtils.lerp(0.02, -0.08, padTap01),
      );
      hand.thumbDist.rotation.set(THREE.MathUtils.lerp(-0.10, -0.28, padTap01), 0, 0);
      return;
    }

    if (holdClass === 'unarmed') {
      const relaxT = THREE.MathUtils.clamp((scale - 0.16) / 0.28, 0, 1);
      const fistT = THREE.MathUtils.clamp((scale - 0.44) / 0.46, 0, 1);

      const lerpStage = (openDeg: number, relaxedDeg: number, fistDeg: number): number => {
        const mid = THREE.MathUtils.lerp(openDeg, relaxedDeg, relaxT);
        return THREE.MathUtils.lerp(mid, fistDeg, fistT);
      };

      setFinger(hand.index, lerpStage(8, 30, 92), lerpStage(10, 38, 104), lerpStage(6, 20, 64));
      setFinger(hand.middle, lerpStage(10, 38, 96), lerpStage(12, 46, 108), lerpStage(6, 24, 68));
      setFinger(hand.ring, lerpStage(12, 46, 100), lerpStage(14, 52, 110), lerpStage(8, 28, 70));
      setFinger(hand.pinky, lerpStage(14, 54, 104), lerpStage(16, 58, 112), lerpStage(8, 32, 72));

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
        // Left aiming / balance hand (open relaxed blade when not pinching pin)
        setFinger(hand.index, 12, 16, 10, -s * 0.04);
        setFinger(hand.middle, 15, 20, 12);
        setFinger(hand.ring, 18, 24, 14);
        setFinger(hand.pinky, 22, 28, 16, s * 0.04);
        hand.thumbProx.rotation.set(0.06, s * 0.24, s * 0.08);
        hand.thumbDist.rotation.set(-0.14, 0, 0);
      }
      return;
    }

    if (holdClass === 'melee_1h') {
      if (side === 'right') {
        // Forward saber grip: fingers wrap snugly around grooved knife handle; thumb braced forward over crossguard spine
        setFinger(hand.index, 66 * scale, 78 * scale, 50 * scale, s * 0.03);
        setFinger(hand.middle, 70 * scale, 82 * scale, 54 * scale);
        setFinger(hand.ring, 74 * scale, 85 * scale, 56 * scale);
        setFinger(hand.pinky, 76 * scale, 86 * scale, 58 * scale);
        hand.thumbProx.rotation.set(0.10, s * 0.28, -s * 0.10);
        hand.thumbDist.rotation.set(-0.22, 0, 0);
      } else {
        // Off-hand relaxed tactical balance/guard blade pose
        setFinger(hand.index, 22, 30, 18, -s * 0.03);
        setFinger(hand.middle, 26, 35, 20);
        setFinger(hand.ring, 30, 38, 22);
        setFinger(hand.pinky, 34, 42, 24, s * 0.03);
        hand.thumbProx.rotation.set(-0.06, s * 0.26, s * 0.08);
        hand.thumbDist.rotation.set(-0.18, 0, 0);
      }
      return;
    }

    setFinger(hand.index, 60 * scale, 72 * scale, 48 * scale);
    setFinger(hand.middle, 64 * scale, 76 * scale, 50 * scale);
    setFinger(hand.ring, 68 * scale, 78 * scale, 52 * scale);
    setFinger(hand.pinky, 70 * scale, 80 * scale, 54 * scale);
    hand.thumbProx.rotation.set(-0.28, s * 0.42, -s * 0.14);
    hand.thumbDist.rotation.set(-0.48, 0, 0);
  }

  // Pre-allocated scratch helpers for zero-GC analytic 2-segment PDA thumb IK
  private readonly _thumbInvHandMat = new THREE.Matrix4();
  private readonly _thumbTargetLocal = new THREE.Vector3();
  private readonly _thumbToTarget = new THREE.Vector3();
  private readonly _thumbDir = new THREE.Vector3();
  private readonly _thumbPole = new THREE.Vector3(-0.45, 0.85, 0.25).normalize();
  private readonly _thumbBendUp = new THREE.Vector3();
  private readonly _thumbSeg1Dir = new THREE.Vector3();
  private readonly _thumbXAxis = new THREE.Vector3();
  private readonly _thumbYAxis = new THREE.Vector3();
  private readonly _thumbZAxis = new THREE.Vector3();
  private readonly _thumbBasisMat = new THREE.Matrix4();

  /**
   * Articulated tablet grip pose: fingers wrap cleanly around rear rubberized bezel while
   * the right thumb physically rests on the 3D gimbaled joystick cap (or reaches up to press
   * the red power button) via an exact 2-segment analytic thumb contact solver.
   */
  public applyPdaHandPose(
    side: 'left' | 'right',
    powerPressWeight: number,
    joyX: number,
    joyY: number,
    rightThumbWorldTarget?: Readonly<THREE.Vector3>,
  ): void {
    const hand = side === 'left' ? this.leftArm.hand : this.rightArm.hand;
    const s = hand.side;
    const setFinger = (f: ArticulatedFinger, proxDeg: number, midDeg: number, distDeg: number): void => {
      f.proximal.rotation.x = -THREE.MathUtils.degToRad(proxDeg);
      f.middle.rotation.x = -THREE.MathUtils.degToRad(midDeg);
      f.distal.rotation.x = -THREE.MathUtils.degToRad(distDeg);
    };

    // Fingers wrap organically behind the ruggedized tablet housing (natural spread + gentle curl)
    setFinger(hand.index, 34, 48, 30);
    setFinger(hand.middle, 40, 54, 34);
    setFinger(hand.ring, 44, 58, 36);
    setFinger(hand.pinky, 48, 60, 38);

    if (side === 'left') {
      // Left thumb rests naturally upward-inward along the front-left bezel border (matching reference grip)
      hand.thumbProx.rotation.set(0.04, -0.26, -0.14);
      hand.thumbDist.rotation.set(-0.18, 0, 0);
      return;
    }

    if (rightThumbWorldTarget) {
      const len1 = Math.max(0.01, -hand.thumbDist.position.z);
      const tipZ = Math.max(0.01, -this.rightThumbTipSocket.position.z);
      const padY = -this.rightThumbTipSocket.position.y;
      const len2 = Math.hypot(tipZ, padY);
      const tipAngle = Math.atan2(padY, tipZ);

      hand.root.updateWorldMatrix(true, false);
      this._thumbInvHandMat.copy(hand.root.matrixWorld).invert();
      this._thumbTargetLocal.copy(rightThumbWorldTarget).applyMatrix4(this._thumbInvHandMat);

      this._thumbToTarget.copy(this._thumbTargetLocal).sub(hand.thumbProx.position);
      const rawDist = this._thumbToTarget.length();
      if (rawDist > 1e-4) {
        const minDist = Math.abs(len1 - len2) + 0.004;
        const maxDist = len1 + len2 - 0.0005;
        const d = THREE.MathUtils.clamp(rawDist, minDist, maxDist);

        this._thumbDir.copy(this._thumbToTarget).divideScalar(rawDist);

        // Natural outward-forward arch pole so thumb bends smoothly over the front keypad without kinking
        this._thumbPole.set(-0.62, 0.72, 0.30);
        this._thumbBendUp
          .copy(this._thumbPole)
          .addScaledVector(this._thumbDir, -this._thumbPole.dot(this._thumbDir));
        if (this._thumbBendUp.lengthSq() < 1e-6) {
          this._thumbBendUp.set(0, 1, 0);
        } else {
          this._thumbBendUp.normalize();
        }

        const cosA = THREE.MathUtils.clamp((len1 * len1 + d * d - len2 * len2) / (2 * len1 * d), -1, 1);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const cosB = THREE.MathUtils.clamp((len1 * len1 + len2 * len2 - d * d) / (2 * len1 * len2), -1, 1);
        const flexDist = Math.PI - Math.acos(cosB);

        // Segment 1 direction (-Z of thumbProx)
        this._thumbSeg1Dir
          .copy(this._thumbDir)
          .multiplyScalar(cosA)
          .addScaledVector(this._thumbBendUp, sinA)
          .normalize();

        // Orthonormal basis: -Z along proximal phalanx, +Y toward convex outer arch so -X flexion bends distal onto target
        this._thumbZAxis.copy(this._thumbSeg1Dir).negate();
        this._thumbYAxis
          .copy(this._thumbBendUp)
          .addScaledVector(this._thumbSeg1Dir, -this._thumbBendUp.dot(this._thumbSeg1Dir))
          .normalize();
        this._thumbXAxis.crossVectors(this._thumbYAxis, this._thumbZAxis).normalize();
        this._thumbYAxis.crossVectors(this._thumbZAxis, this._thumbXAxis).normalize();

        this._thumbBasisMat.makeBasis(this._thumbXAxis, this._thumbYAxis, this._thumbZAxis);
        hand.thumbProx.quaternion.setFromRotationMatrix(this._thumbBasisMat);
        hand.thumbDist.rotation.set(-(flexDist - tipAngle), 0, 0);
        return;
      }
    }

    // Fallback procedural Euler angles if no world contact point is provided
    const press = THREE.MathUtils.clamp(powerPressWeight, 0, 1);
    const basePitch = 0.04 + joyY * 0.28;
    const baseYaw = s * (0.28 + joyX * 0.28);
    const baseRoll = -s * (0.06 - joyY * 0.14);

    hand.thumbProx.rotation.set(
      THREE.MathUtils.lerp(basePitch, 0.34, press),
      THREE.MathUtils.lerp(baseYaw, s * 0.12, press),
      THREE.MathUtils.lerp(baseRoll, s * 0.18, press),
    );
    hand.thumbDist.rotation.set(
      THREE.MathUtils.lerp(-0.26 - joyY * 0.20, -0.44, press),
      0,
      0,
    );
  }

  public getRightThumbTipWorldPosition(outPos: THREE.Vector3): THREE.Vector3 {
    this.rightThumbTipSocket.updateWorldMatrix(true, false);
    return this.rightThumbTipSocket.getWorldPosition(outPos);
  }

  /**
   * Assigns & rebuilds the 3D tactical equipment meshes mounted on the player's belt.
   * Updates live in Playground/Gym, Battle, Infection, and the 3D Operator Preview.
   */
  public setBeltEquipment(
    equipmentId: TacticalEquipmentId,
    beltSlot: TacticalBeltSlot,
    count = 2,
    visible = true,
  ): void {
    this.beltEquipmentState = { equipmentId, beltSlot, count, visible };

    // Cleanly dispose previous belt equipment meshes
    for (let i = 0; i < this.beltEquipmentMeshes.length; i++) {
      const prev = this.beltEquipmentMeshes[i];
      this.beltEquipmentMount.remove(prev.group);
      prev.dispose();
    }
    this.beltEquipmentMeshes.length = 0;

    if (!visible || count <= 0) {
      this.beltEquipmentMount.visible = false;
      return;
    }

    this.beltEquipmentMount.visible = true;
    const transforms = getBeltSlotTransforms(
      beltSlot,
      this.profile.pelvisWidthScale,
      this.profile.pelvisDepthScale,
    );
    const mountCount = Math.min(transforms.length, Math.max(0, Math.round(count)));

    for (let i = 0; i < mountCount; i++) {
      const built = buildTacticalEquipmentMesh(equipmentId, {
        withBeltClip: true,
        scale: 1.0,
      });
      const tf = transforms[i];
      built.group.position.set(tf.position[0], tf.position[1], tf.position[2]);
      built.group.rotation.set(tf.rotation[0], tf.rotation[1], tf.rotation[2]);
      built.group.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.castShadow = true;
          m.receiveShadow = true;
          m.layers.set(this.beltUseWorldLayer ? 0 : VIEWMODEL_LAYER);
        }
      });
      this.beltEquipmentMount.add(built.group);
      this.beltEquipmentMeshes.push(built);
    }
  }

  public getBeltEquipmentState(): Readonly<{
    equipmentId: TacticalEquipmentId;
    beltSlot: TacticalBeltSlot;
    count: number;
    visible: boolean;
  }> {
    return this.beltEquipmentState;
  }

  /**
   * Gently compresses the mounted belt equipment inward toward the waist centerline
   * when the operator backs or leans flush against a wall so belt grenades never clip.
   */
  public setBeltWallTuck(tuck01: number): void {
    const t = THREE.MathUtils.clamp(tuck01, 0, 1);
    const radialScale = 1 - t * 0.24;
    this.beltEquipmentMount.scale.set(radialScale, 1, radialScale);
  }

  /**
   * Copies the world position of the first mounted belt grenade into `out`.
   * Returns false if no belt grenades are mounted/visible.
   */
  public getBeltGrenadeWorldPosition(out: THREE.Vector3): boolean {
    if (!this.beltEquipmentMount.visible || this.beltEquipmentMeshes.length === 0) {
      return false;
    }
    this.beltEquipmentMeshes[0].group.updateMatrixWorld(true);
    this.beltEquipmentMeshes[0].group.getWorldPosition(out);
    return true;
  }

  public dispose(): void {
    for (let i = 0; i < this.beltEquipmentMeshes.length; i++) {
      const prev = this.beltEquipmentMeshes[i];
      this.beltEquipmentMount.remove(prev.group);
      prev.dispose();
    }
    this.beltEquipmentMeshes.length = 0;
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
    if (this.headAssembly) {
      for (const d of this.headAssembly.disposables) {
        d.dispose();
      }
    }
    this.texSets.forEach((t) => {
      t.map.dispose();
      t.normalMap.dispose();
      t.roughnessMap.dispose();
    });
    this.customGloveTexSets.forEach((t) => {
      t.map.dispose();
      t.normalMap.dispose();
      t.roughnessMap.dispose();
    });
    this.geos.length = 0;
    this.mats.length = 0;
    this.texSets.length = 0;
    this.customGloveTexSets.length = 0;
  }
}

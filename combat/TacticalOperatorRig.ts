import * as THREE from 'three';
import {
  createTwoBoneIKResult,
  solveTwoBoneIK,
  TwoBoneIKResult,
} from '../bodycam-sdk/IKSolver';
import {
  DEFAULT_OPERATOR_ID,
  normalizeOperatorId,
  OPERATOR_PROFILES,
  OperatorId,
} from '../bodycam-sdk/operator/OperatorTypes';
import {
  OperatorUniformId,
  TacticalUniformMaterialBundle,
  TacticalUniformMaterialLibrary,
} from '../bodycam-sdk/TacticalUniforms';
import {
  DEFAULT_TACTICAL_BELT_SLOT,
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import {
  buildTacticalEquipmentMesh,
  BuiltTacticalEquipmentMesh,
  getBeltSlotTransforms,
} from '../bodycam-sdk/equipment/TacticalEquipmentMesh';

export type TacticalActorKind = 'remote_player' | 'bot';

export interface TacticalCombatPose {
  /** 0 = standing, 1 = full tactical crouch */
  crouchBlend: number;
  /** -1 = left lean, +1 = right lean */
  leanBlend: number;
  /** Vertical aim pitch in radians (+up, -down) */
  aimPitch: number;
  /** 0..1 overall ADS blend */
  adsBlend: number;
  /** 0..1 35-degree Point Aim blend */
  pointAimBlend: number;
  /** 0..1 40-degree Canted ADS blend */
  cantBlend: number;
  /** 0..1 tactical reload posture blend */
  reloadBlend: number;
  /** Horizontal travel speed (m/s) for walk/sprint stride */
  speedMps: number;
  /** Continuous stride phase in radians */
  walkCycle: number;
  /** True when sprinting */
  sprint: boolean;
  /** 0..1 discrete shot recoil impulse */
  recoilKick: number;
  /** Continuous firing vibration offset (radians) */
  firingVibration: number;
  /** Torso flinch pitch in radians */
  flinchPitch: number;
  /** 0..1 active vault/climb animation blend */
  vaultBlend?: number;
  /** 0..1 normalized progress through vault/climb maneuver */
  vaultProgress?: number;
  /** Vault maneuver kind for distinct brace vs mantle posture */
  vaultKind?: 'VAULT_OVER' | 'CLIMB_ONTO' | 'HIGH_MANTLE';
}

export interface BuiltTacticalOperatorRig {
  operatorId: OperatorId;
  root: THREE.Group;
  bodyPivot: THREE.Group;
  pelvisGroup: THREE.Group;
  upperBody: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  headGroup: THREE.Group;
  weaponSocket: THREE.Group;
  weaponPivot: THREE.Group;
  muzzleFlash: THREE.Mesh;
  laserBeam: THREE.Mesh;
  flashlightGlow: THREE.Mesh;
  hitMeshes: THREE.Mesh[];
  applyUniform: (uniformId: OperatorUniformId) => void;
  applyCombatPose: (pose: TacticalCombatPose) => void;
  resetRagdollPose: () => void;
  setBeltEquipment: (
    equipmentId: TacticalEquipmentId,
    beltSlot?: TacticalBeltSlot,
    count?: number,
    visible?: boolean,
  ) => void;
}

type MaterialSlot =
  | 'sleeve'
  | 'pants'
  | 'vest'
  | 'pouch'
  | 'glove'
  | 'boot'
  | 'sole'
  | 'knuckle'
  | 'hardware'
  | 'helmet'
  | 'hood'
  | 'skin'
  | 'visor'
  | 'iffTrim'
  | 'gun'
  | 'gunAccent'
  | 'flash'
  | 'laser'
  | 'lightGlow';

// Pre-allocated zero-GC scratch objects shared across all TacticalOperatorRig pose updates
const _ikRes: TwoBoneIKResult = createTwoBoneIKResult();
const _shL = new THREE.Vector3();
const _shR = new THREE.Vector3();
const _gripL = new THREE.Vector3();
const _gripR = new THREE.Vector3();
const _reloadL = new THREE.Vector3();
const _vaultBraceL = new THREE.Vector3();
const _vaultBraceR = new THREE.Vector3();
const _poleL = new THREE.Vector3();
const _poleR = new THREE.Vector3();
const _armAxisX = new THREE.Vector3();
const _armAxisY = new THREE.Vector3();
const _armAxisZ = new THREE.Vector3();
const _armPoleProj = new THREE.Vector3();
const _armMat = new THREE.Matrix4();
const _armQuat = new THREE.Quaternion();
const _armQuatInv = new THREE.Quaternion();
const _foreQuat = new THREE.Quaternion();
const _fallbackVec = new THREE.Vector3();

/**
 * Computes an orientation quaternion in the same frame as `dir` and `poleHint`
 * such that the object's local `-Y` axis points along `dir` (so limbs that hang
 * downward along `-Y` align cleanly with 2-bone IK segments AND stay compatible
 * with ArticulatedRagdoll.syncToBotRig at identity rotation).
 */
function computeNegYSegmentQuat(
  dir: THREE.Vector3,
  poleHint: THREE.Vector3,
  outQuat: THREE.Quaternion,
): THREE.Quaternion {
  // Local +Y points opposite to limb segment direction (toward proximal joint)
  _armAxisY.copy(dir).negate();
  const lenSq = _armAxisY.lengthSq();
  if (lenSq < 1e-8) {
    return outQuat.identity();
  }
  _armAxisY.divideScalar(Math.sqrt(lenSq));

  // Local +Z aligns with the orthogonalized bend-plane pole hint
  _armPoleProj.copy(poleHint).addScaledVector(_armAxisY, -poleHint.dot(_armAxisY));
  if (_armPoleProj.lengthSq() < 1e-6) {
    _fallbackVec.set(0, 0, Math.abs(_armAxisY.z) < 0.9 ? 1 : 0);
    if (_fallbackVec.lengthSq() < 0.5) _fallbackVec.set(1, 0, 0);
    _armPoleProj.crossVectors(_armAxisY, _fallbackVec);
  }
  _armAxisZ.copy(_armPoleProj).normalize();
  _armAxisX.crossVectors(_armAxisY, _armAxisZ).normalize();
  _armAxisZ.crossVectors(_armAxisX, _armAxisY).normalize();

  _armMat.makeBasis(_armAxisX, _armAxisY, _armAxisZ);
  return outQuat.setFromRotationMatrix(_armMat);
}

/**
 * Shared 3D Tactical Operator Rig Factory used by BOTH `RemotePlayerManager` and `BattleBotAI`.
 * Supports BOTH `MALE` and `FEMALE` silhouettes using `OPERATOR_PROFILES`, multi-part sculpted
 * tactical boots (FEMALE smaller & sleeker than MALE), articulated knees/ankles with anatomical
 * backward knee flexion, a proper local `weaponSocket` seated against the right shoulder/chest,
 * and zero-GC 2-bone arm IK locking hands cleanly onto the rifle pistol grip and handguard.
 */
export class TacticalOperatorRigFactory {
  private readonly materialLib: TacticalUniformMaterialLibrary;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  // Shared tactical geometries
  private readonly geoPelvis: THREE.CylinderGeometry;
  private readonly geoBelt: THREE.CylinderGeometry;
  private readonly geoBuckle: THREE.BoxGeometry;
  private readonly geoHolster: THREE.BoxGeometry;
  private readonly geoDumpPouch: THREE.BoxGeometry;

  private readonly geoAbdomen: THREE.CylinderGeometry;
  private readonly geoChest: THREE.CylinderGeometry;
  private readonly geoSapiPlate: THREE.ExtrudeGeometry;
  private readonly geoCummerbund: THREE.CylinderGeometry;
  private readonly geoStrap: THREE.BoxGeometry;
  private readonly geoMagPouch: THREE.BoxGeometry;
  private readonly geoCamMount: THREE.BoxGeometry;
  private readonly geoChestContour: THREE.SphereGeometry;

  private readonly geoThigh: THREE.CylinderGeometry;
  private readonly geoCargoPocket: THREE.BoxGeometry;
  private readonly geoKneePad: THREE.SphereGeometry;
  private readonly geoShin: THREE.CylinderGeometry;

  // Multi-part sculpted tactical boot geometries (shared & scaled cleanly per gender)
  private readonly geoBootOutsole: THREE.ExtrudeGeometry;
  private readonly geoBootHeelBlock: THREE.BoxGeometry;
  private readonly geoBootTreadLug: THREE.BoxGeometry;
  private readonly geoBootVamp: THREE.ExtrudeGeometry;
  private readonly geoBootInstep: THREE.CylinderGeometry;
  private readonly geoBootHeelCounter: THREE.CylinderGeometry;
  private readonly geoBootShaft: THREE.CylinderGeometry;
  private readonly geoBootCollar: THREE.TorusGeometry;
  private readonly geoBootTongue: THREE.BoxGeometry;
  private readonly geoBootLaceBar: THREE.BoxGeometry;
  private readonly geoBootToeDome: THREE.SphereGeometry;
  private readonly geoBootToeBumper: THREE.CylinderGeometry;

  private readonly geoShoulderCap: THREE.SphereGeometry;
  private readonly geoUpperArm: THREE.CylinderGeometry;
  private readonly geoShoulderPatch: THREE.BoxGeometry;
  private readonly geoElbowPad: THREE.SphereGeometry;
  private readonly geoForearm: THREE.CylinderGeometry;
  private readonly geoCuff: THREE.CylinderGeometry;
  private readonly geoGlove: THREE.BoxGeometry;

  private readonly geoNeck: THREE.CylinderGeometry;
  private readonly geoHead: THREE.SphereGeometry;
  private readonly geoBalaclava: THREE.CylinderGeometry;
  private readonly geoHelmetShell: THREE.SphereGeometry;
  private readonly geoHelmetRim: THREE.CylinderGeometry;
  private readonly geoHelmetBand: THREE.CylinderGeometry;
  private readonly geoNvgShroud: THREE.BoxGeometry;
  private readonly geoVisor: THREE.BoxGeometry;
  private readonly geoEarPro: THREE.CylinderGeometry;
  private readonly geoHairBun: THREE.SphereGeometry;

  private readonly geoRifleReceiver: THREE.BoxGeometry;
  private readonly geoRifleHandguard: THREE.BoxGeometry;
  private readonly geoRifleStock: THREE.BoxGeometry;
  private readonly geoRifleButtpad: THREE.BoxGeometry;
  private readonly geoRiflePistolGrip: THREE.BoxGeometry;
  private readonly geoRifleMag: THREE.BoxGeometry;
  private readonly geoRifleOptic: THREE.BoxGeometry;
  private readonly geoRifleBarrel: THREE.CylinderGeometry;
  private readonly geoFlash: THREE.OctahedronGeometry;
  private readonly geoLaser: THREE.CylinderGeometry;
  private readonly geoLightGlow: THREE.SphereGeometry;

  constructor(maxAnisotropy = 4) {
    this.materialLib = new TacticalUniformMaterialLibrary(maxAnisotropy);

    // Pelvis & Belt
    this.geoPelvis = this.track(new THREE.CylinderGeometry(0.146, 0.156, 0.16, 12));
    this.geoBelt = this.track(new THREE.CylinderGeometry(0.154, 0.156, 0.048, 12));
    this.geoBuckle = this.track(new THREE.BoxGeometry(0.054, 0.04, 0.02));
    this.geoHolster = this.track(new THREE.BoxGeometry(0.052, 0.135, 0.088));
    this.geoDumpPouch = this.track(new THREE.BoxGeometry(0.058, 0.115, 0.092));

    // Torso & SAPI Plate Carrier
    this.geoAbdomen = this.track(new THREE.CylinderGeometry(0.148, 0.14, 0.24, 12));
    this.geoChest = this.track(new THREE.CylinderGeometry(0.166, 0.15, 0.31, 12));
    this.geoSapiPlate = this.track(this.createSapiPlateGeo(0.245, 0.265, 0.026));
    this.geoCummerbund = this.track(new THREE.CylinderGeometry(0.17, 0.162, 0.115, 12));
    this.geoStrap = this.track(new THREE.BoxGeometry(0.054, 0.03, 0.19));
    this.geoMagPouch = this.track(new THREE.BoxGeometry(0.058, 0.11, 0.032));
    this.geoCamMount = this.track(new THREE.BoxGeometry(0.052, 0.064, 0.022));
    this.geoChestContour = this.track(new THREE.SphereGeometry(0.068, 10, 8));

    // Articulated Legs + Knee Pads
    this.geoThigh = this.track(new THREE.CylinderGeometry(0.08, 0.064, 0.41, 10));
    this.geoCargoPocket = this.track(new THREE.BoxGeometry(0.03, 0.145, 0.088));
    this.geoKneePad = this.track(new THREE.SphereGeometry(0.056, 8, 6));
    this.geoShin = this.track(new THREE.CylinderGeometry(0.062, 0.05, 0.40, 10));

    // Multi-part Sculpted Tactical Boot (base MALE 1.0 dimensions, scaled down for FEMALE)
    this.geoBootOutsole = this.track(this.createBootFootprintGeo(0.055, 0.044, 0.072, 0.184, 0.017, 0.002));
    this.geoBootHeelBlock = this.track(new THREE.BoxGeometry(0.084, 0.014, 0.072));
    this.geoBootTreadLug = this.track(new THREE.BoxGeometry(0.096, 0.009, 0.013));
    this.geoBootVamp = this.track(this.createBootFootprintGeo(0.05, 0.041, 0.066, 0.162, 0.044, 0.005));
    this.geoBootInstep = this.track(new THREE.CylinderGeometry(0.038, 0.045, 0.098, 10));
    this.geoBootHeelCounter = this.track(new THREE.CylinderGeometry(0.044, 0.048, 0.064, 10));
    this.geoBootShaft = this.track(new THREE.CylinderGeometry(0.052, 0.05, 0.125, 10));
    this.geoBootCollar = this.track(new THREE.TorusGeometry(0.051, 0.01, 6, 12));
    this.geoBootCollar.rotateX(Math.PI * 0.5);
    this.geoBootTongue = this.track(new THREE.BoxGeometry(0.038, 0.088, 0.018));
    this.geoBootLaceBar = this.track(new THREE.BoxGeometry(0.034, 0.0055, 0.006));
    this.geoBootToeDome = this.track(new THREE.SphereGeometry(0.046, 10, 8));
    this.geoBootToeBumper = this.track(new THREE.CylinderGeometry(0.048, 0.05, 0.022, 10, 1, false, -Math.PI * 0.5, Math.PI));

    // Articulated Arms (origin at proximal joint, extending along -Y)
    this.geoShoulderCap = this.track(new THREE.SphereGeometry(0.06, 8, 6));
    this.geoUpperArm = this.track(new THREE.CylinderGeometry(0.051, 0.043, 0.31, 8));
    this.geoShoulderPatch = this.track(new THREE.BoxGeometry(0.016, 0.052, 0.074));
    this.geoElbowPad = this.track(new THREE.SphereGeometry(0.044, 8, 6));
    this.geoForearm = this.track(new THREE.CylinderGeometry(0.043, 0.034, 0.29, 8));
    this.geoCuff = this.track(new THREE.CylinderGeometry(0.037, 0.036, 0.03, 8));
    this.geoGlove = this.track(new THREE.BoxGeometry(0.056, 0.086, 0.042));

    // Head, Balaclava, High-Cut FAST Helmet, Ear-Pro, NVG Shroud, Visor & Female Low Bun
    this.geoNeck = this.track(new THREE.CylinderGeometry(0.054, 0.062, 0.088, 8));
    this.geoHead = this.track(new THREE.SphereGeometry(0.11, 10, 8));
    this.geoBalaclava = this.track(new THREE.CylinderGeometry(0.103, 0.096, 0.118, 10));
    this.geoHelmetShell = this.track(
      new THREE.SphereGeometry(0.134, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62),
    );
    this.geoHelmetRim = this.track(new THREE.CylinderGeometry(0.133, 0.136, 0.03, 12));
    this.geoHelmetBand = this.track(new THREE.CylinderGeometry(0.138, 0.138, 0.032, 12));
    this.geoNvgShroud = this.track(new THREE.BoxGeometry(0.05, 0.054, 0.028));
    this.geoVisor = this.track(new THREE.BoxGeometry(0.18, 0.062, 0.054));
    this.geoEarPro = this.track(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 8));
    this.geoEarPro.rotateZ(Math.PI * 0.5);
    this.geoHairBun = this.track(new THREE.SphereGeometry(0.052, 10, 8));

    // Articulated Tactical Carbine Silhouette (origin near rear receiver / grip area, barrel along -Z)
    this.geoRifleReceiver = this.track(new THREE.BoxGeometry(0.052, 0.084, 0.27));
    this.geoRifleHandguard = this.track(new THREE.BoxGeometry(0.044, 0.052, 0.29));
    this.geoRifleStock = this.track(new THREE.BoxGeometry(0.04, 0.082, 0.20));
    this.geoRifleButtpad = this.track(new THREE.BoxGeometry(0.044, 0.11, 0.024));
    this.geoRiflePistolGrip = this.track(new THREE.BoxGeometry(0.032, 0.105, 0.046));
    this.geoRifleMag = this.track(new THREE.BoxGeometry(0.027, 0.145, 0.064));
    this.geoRifleOptic = this.track(new THREE.BoxGeometry(0.04, 0.046, 0.105));
    this.geoRifleBarrel = this.track(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6));
    this.geoRifleBarrel.rotateX(Math.PI * 0.5);
    this.geoFlash = this.track(new THREE.OctahedronGeometry(0.09, 0));
    this.geoLaser = this.track(new THREE.CylinderGeometry(0.0036, 0.0036, 15, 4));
    this.geoLaser.rotateX(Math.PI * 0.5);
    this.geoLightGlow = this.track(new THREE.SphereGeometry(0.046, 6, 6));
  }

  private track<T extends { dispose: () => void }>(res: T): T {
    this.disposables.push(res);
    return res;
  }

  private createBootFootprintGeo(
    foreHalfW: number,
    heelHalfW: number,
    heelBack: number,
    toeFront: number,
    thickness: number,
    bevel: number,
  ): THREE.ExtrudeGeometry {
    const waistW = heelHalfW * 0.86;
    const shape = new THREE.Shape();
    shape.moveTo(-heelHalfW * 0.72, -heelBack);
    shape.quadraticCurveTo(0, -heelBack - 0.012, heelHalfW * 0.72, -heelBack);
    shape.quadraticCurveTo(heelHalfW, -heelBack * 0.45, waistW, 0.0);
    shape.quadraticCurveTo(foreHalfW * 1.04, toeFront * 0.52, foreHalfW * 0.78, toeFront * 0.88);
    shape.quadraticCurveTo(0, toeFront + 0.01, -foreHalfW * 0.78, toeFront * 0.88);
    shape.quadraticCurveTo(-foreHalfW * 1.04, toeFront * 0.52, -waistW, 0.0);
    shape.quadraticCurveTo(-heelHalfW, -heelBack * 0.45, -heelHalfW * 0.72, -heelBack);

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelEnabled: bevel > 0,
      bevelSegments: 2,
      steps: 1,
      bevelSize: bevel,
      bevelThickness: bevel,
    });
    // Map shape +Y -> world -Z (forward), extrude +Z -> world +Y (up)
    geo.rotateX(-Math.PI * 0.5);
    return geo;
  }

  private createSapiPlateGeo(w: number, h: number, depth: number): THREE.ExtrudeGeometry {
    const hw = w * 0.5;
    const hh = h * 0.5;
    const shoulderCutX = hw * 0.46;
    const shoulderCutY = hh * 0.56;
    const s = new THREE.Shape();
    s.moveTo(-hw + 0.014, -hh);
    s.lineTo(hw - 0.014, -hh);
    s.quadraticCurveTo(hw, -hh, hw, -hh + 0.016);
    s.lineTo(hw, shoulderCutY);
    s.lineTo(shoulderCutX, hh);
    s.lineTo(-shoulderCutX, hh);
    s.lineTo(-hw, shoulderCutY);
    s.lineTo(-hw, -hh + 0.016);
    s.quadraticCurveTo(-hw, -hh, -hw + 0.014, -hh);
    const geo = new THREE.ExtrudeGeometry(s, {
      depth,
      bevelEnabled: true,
      bevelSegments: 1,
      steps: 1,
      bevelSize: 0.007,
      bevelThickness: 0.007,
    });
    geo.center();
    return geo;
  }

  private pickMat(bundle: TacticalUniformMaterialBundle, slot: MaterialSlot): THREE.Material {
    switch (slot) {
      case 'sleeve':
        return bundle.sleeveMat;
      case 'pants':
        return bundle.pantsMat;
      case 'vest':
        return bundle.vestMat;
      case 'pouch':
        return bundle.pouchMat;
      case 'glove':
        return bundle.gloveMat;
      case 'boot':
        return bundle.bootMat;
      case 'sole':
        return bundle.soleMat;
      case 'knuckle':
        return bundle.knuckleMat;
      case 'hardware':
        return bundle.hardwareMat;
      case 'helmet':
        return bundle.helmetMat;
      case 'hood':
        return bundle.hoodMat;
      case 'skin':
        return bundle.skinMat;
      case 'visor':
        return bundle.visorMat;
      case 'iffTrim':
        return bundle.iffTrimMat;
      case 'gun':
        return bundle.gunMat;
      case 'gunAccent':
        return bundle.gunAccentMat;
      case 'flash':
        return bundle.flashMat;
      case 'laser':
        return bundle.laserMat;
      case 'lightGlow':
        return bundle.lightGlowMat;
    }
  }

  public buildOperator(
    actorType: TacticalActorKind,
    actorId: string,
    uniformId: OperatorUniformId,
    rawOperatorId: OperatorId = DEFAULT_OPERATOR_ID,
  ): BuiltTacticalOperatorRig {
    const operatorId = normalizeOperatorId(rawOperatorId);
    const profile = OPERATOR_PROFILES[operatorId];
    const isFemale = operatorId === 'FEMALE';

    const bundle = this.materialLib.getBundle(uniformId);
    const slotBindings: Array<{ mesh: THREE.Mesh; slot: MaterialSlot }> = [];
    const hitMeshes: THREE.Mesh[] = [];

    const makeMesh = (
      geo: THREE.BufferGeometry,
      slot: MaterialSlot,
      hitZone?: 'head' | 'thorax' | 'limb',
      surfaceMaterial: 'wood' | 'metal' = 'wood',
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, this.pickMat(bundle, slot));
      m.castShadow = true;
      m.receiveShadow = true;
      slotBindings.push({ mesh: m, slot });
      if (hitZone) {
        m.userData = {
          combatActorType: actorType,
          actorId,
          hitZone,
          surfaceMaterial,
        };
        hitMeshes.push(m);
      }
      return m;
    };

    const thighLen = profile.thighLen; // 0.41
    const shinLen = profile.shinLen; // 0.40
    const ankleHeight = profile.ankleHeight; // 0.085
    const restPelvisY = thighLen + shinLen + ankleHeight; // 0.895
    const upperArmLen = profile.upperArmLen; // 0.31
    const lowerArmLen = profile.lowerArmLen; // 0.29

    // Gender-specific silhouette dimensions
    const torsoW = profile.torsoWidthScale;
    const waistW = profile.waistWidthScale;
    const pelvisW = profile.pelvisWidthScale;
    const pelvisD = profile.pelvisDepthScale;
    const chestD = profile.chestDepthScale;
    const armR = profile.armRadiusScale;
    const forearmR = profile.forearmRadiusScale;
    const thighR = profile.thighRadiusScale;
    const shinR = profile.shinRadiusScale;
    const shoulderX = isFemale ? 0.184 : 0.218;
    const shoulderY = 0.455;
    const hipOffsetX = profile.hipOffsetX;

    // Boot scale: FEMALE noticeably smaller & sleeker (~0.82x footprint, slimmer shaft)
    const bootLenS = isFemale ? 0.82 : 1.0;
    const bootWidS = isFemale ? 0.80 : 1.0;
    const bootShaftS = isFemale ? 0.84 : 1.0;

    const root = new THREE.Group();
    const bodyPivot = new THREE.Group();
    root.add(bodyPivot);

    // === PELVIS GROUP (parent of legs & upperBody so crouch drops torso + bends knees cleanly) ===
    const pelvisGroup = new THREE.Group();
    pelvisGroup.position.set(0, restPelvisY, 0);
    bodyPivot.add(pelvisGroup);

    const pelvisMesh = makeMesh(this.geoPelvis, 'pants', 'thorax');
    pelvisMesh.scale.set(1.04 * pelvisW, 1.0, 0.68 * pelvisD);
    pelvisMesh.position.set(0, 0.0, 0);

    const beltMesh = makeMesh(this.geoBelt, 'vest');
    beltMesh.scale.set(1.06 * pelvisW, 1.0, 0.7 * pelvisD);
    beltMesh.position.set(0, 0.06, 0);

    const buckle = makeMesh(this.geoBuckle, 'hardware');
    buckle.position.set(0, 0.06, -0.112 * pelvisD);

    const dumpPouch = makeMesh(this.geoDumpPouch, 'pouch');
    dumpPouch.position.set(-0.168 * pelvisW, -0.01, 0.01);

    const holster = makeMesh(this.geoHolster, 'hardware');
    holster.position.set(0.168 * pelvisW, -0.03, -0.005);

    pelvisGroup.add(pelvisMesh, beltMesh, buckle, dumpPouch, holster);

    // Belt Tactical Equipment Mount (grenades / utility canisters on waist belt)
    const beltEquipmentMount = new THREE.Group();
    beltEquipmentMount.name = 'belt_tactical_equipment_slot';
    pelvisGroup.add(beltEquipmentMount);
    const beltBuiltItems: BuiltTacticalEquipmentMesh[] = [];

    const setBeltEquipment = (
      equipmentId: TacticalEquipmentId,
      beltSlot: TacticalBeltSlot = DEFAULT_TACTICAL_BELT_SLOT,
      count = 2,
      visible = true,
    ): void => {
      for (let i = 0; i < beltBuiltItems.length; i++) {
        beltEquipmentMount.remove(beltBuiltItems[i].group);
        beltBuiltItems[i].dispose();
      }
      beltBuiltItems.length = 0;
      if (!visible || count <= 0) {
        beltEquipmentMount.visible = false;
        return;
      }
      beltEquipmentMount.visible = true;
      const transforms = getBeltSlotTransforms(beltSlot, pelvisW, pelvisD);
      const n = Math.min(transforms.length, Math.max(0, Math.round(count)));
      for (let i = 0; i < n; i++) {
        const built = buildTacticalEquipmentMesh(equipmentId, { withBeltClip: true, scale: 1.0 });
        const tf = transforms[i];
        built.group.position.set(tf.position[0], tf.position[1], tf.position[2]);
        built.group.rotation.set(tf.rotation[0], tf.rotation[1], tf.rotation[2]);
        beltEquipmentMount.add(built.group);
        beltBuiltItems.push(built);
      }
    };

    // Equip default tactical frag grenade on third-person operator belts
    setBeltEquipment(DEFAULT_TACTICAL_EQUIPMENT_ID, DEFAULT_TACTICAL_BELT_SLOT, 1, true);
    this.disposables.push({
      dispose: () => {
        for (let i = 0; i < beltBuiltItems.length; i++) {
          beltEquipmentMount.remove(beltBuiltItems[i].group);
          beltBuiltItems[i].dispose();
        }
        beltBuiltItems.length = 0;
      },
    });

    // === ARTICULATED LEGS (Hip -> Thigh -> Knee(backward bend) -> Shin -> Ankle -> Sculpted Multi-Part Boot) ===
    const buildArticulatedLeg = (side: -1 | 1) => {
      const hipPivot = new THREE.Group();
      hipPivot.position.set(side * hipOffsetX, 0, 0);

      const thighMesh = makeMesh(this.geoThigh, 'pants', 'limb');
      thighMesh.scale.set(thighR, 1.0, thighR);
      thighMesh.position.set(0, -thighLen * 0.5, 0);

      const cargoPocket = makeMesh(this.geoCargoPocket, 'pants');
      cargoPocket.scale.set(thighR, 1.0, thighR);
      cargoPocket.position.set(side * 0.072 * thighR, -thighLen * 0.52, 0);

      const kneePivot = new THREE.Group();
      kneePivot.position.set(0, -thighLen, 0);

      const kneePad = makeMesh(this.geoKneePad, 'knuckle');
      kneePad.scale.set(0.9 * shinR, 0.92, 0.56);
      kneePad.position.set(0, 0.005, -0.056 * thighR);

      const shinMesh = makeMesh(this.geoShin, 'pants', 'limb');
      shinMesh.scale.set(shinR, 1.0, shinR);
      shinMesh.position.set(0, -shinLen * 0.5, 0);

      const anklePivot = new THREE.Group();
      anklePivot.position.set(0, -shinLen, 0);

      // Multi-part sculpted tactical boot (sole bottom sits at local y = -ankleHeight = -0.085)
      const bootRoot = new THREE.Group();
      const soleBottomY = -ankleHeight;

      // 1. Contoured lugged rubber outsole
      const outsole = makeMesh(this.geoBootOutsole, 'sole');
      outsole.scale.set(bootWidS, 1.0, bootLenS);
      outsole.position.set(0, soleBottomY + 0.004, 0.0);

      // 2. Raised rear heel block
      const heelBlock = makeMesh(this.geoBootHeelBlock, 'sole');
      heelBlock.scale.set(bootWidS, 1.0, bootLenS);
      heelBlock.position.set(0, soleBottomY + 0.007, 0.03 * bootLenS);

      // 3. Transverse forefoot tread lugs
      for (let i = 0; i < 4; i++) {
        const lug = makeMesh(this.geoBootTreadLug, 'sole');
        lug.scale.set(bootWidS * (1 - i * 0.04), 1.0, bootLenS);
        lug.position.set(0, soleBottomY + 0.0045, (-0.042 - i * 0.032) * bootLenS);
        bootRoot.add(lug);
      }

      // 4. Sculpted vamp upper + sloped instep + heel counter
      const vamp = makeMesh(this.geoBootVamp, 'boot');
      vamp.scale.set(bootWidS, 1.0, bootLenS);
      vamp.position.set(0, soleBottomY + 0.02, 0.0);

      const instep = makeMesh(this.geoBootInstep, 'boot');
      instep.scale.set(bootWidS, 1.0, bootLenS);
      instep.rotation.x = 1.02;
      instep.position.set(0, soleBottomY + 0.068, -0.055 * bootLenS);

      const heelCounter = makeMesh(this.geoBootHeelCounter, 'knuckle');
      heelCounter.scale.set(bootWidS, 1.0, bootLenS);
      heelCounter.position.set(0, soleBottomY + 0.052, 0.032 * bootLenS);

      // 5. Laced ankle collar / shaft meeting lower shin with zero gap
      const shaft = makeMesh(this.geoBootShaft, 'boot');
      shaft.scale.set(bootShaftS, 1.0, bootShaftS);
      shaft.position.set(0, 0.015, 0.004);

      const collar = makeMesh(this.geoBootCollar, 'knuckle');
      collar.scale.set(bootShaftS, 1.0, bootShaftS);
      collar.position.set(0, 0.074, 0.004);

      const tongue = makeMesh(this.geoBootTongue, 'pouch');
      tongue.scale.set(bootShaftS, 1.0, 1.0);
      tongue.rotation.x = 0.14;
      tongue.position.set(0, 0.018, -0.046 * bootShaftS);

      for (let i = 0; i < 4; i++) {
        const lace = makeMesh(this.geoBootLaceBar, 'hardware');
        lace.scale.set(bootShaftS, 1.0, 1.0);
        lace.position.set(0, -0.018 + i * 0.024, (-0.054 + i * 0.003) * bootShaftS);
        bootRoot.add(lace);
      }

      // 6. Tapered rounded toe cap + rubber toe bumper
      const toeDome = makeMesh(this.geoBootToeDome, 'boot');
      toeDome.scale.set(bootWidS * 0.96, 0.68, bootLenS * 1.12);
      toeDome.position.set(0, soleBottomY + 0.044, -0.148 * bootLenS);

      const toeBumper = makeMesh(this.geoBootToeBumper, 'sole');
      toeBumper.scale.set(bootWidS, 1.0, bootLenS);
      toeBumper.rotation.y = Math.PI;
      toeBumper.position.set(0, soleBottomY + 0.025, -0.148 * bootLenS);

      bootRoot.add(
        outsole,
        heelBlock,
        vamp,
        instep,
        heelCounter,
        shaft,
        collar,
        tongue,
        toeDome,
        toeBumper,
      );
      anklePivot.add(bootRoot);

      kneePivot.add(kneePad, shinMesh, anklePivot);
      hipPivot.add(thighMesh, cargoPocket, kneePivot);

      return { hipPivot, kneePivot, anklePivot };
    };

    const leftLegParts = buildArticulatedLeg(-1);
    const rightLegParts = buildArticulatedLeg(1);
    const leftLeg = leftLegParts.hipPivot;
    const rightLeg = rightLegParts.hipPivot;
    pelvisGroup.add(leftLeg, rightLeg);

    // === UPPER BODY (child of pelvisGroup so crouching translates torso, arms, head & rifle together) ===
    const upperBody = new THREE.Group();
    upperBody.position.set(0, 0.035, 0);
    pelvisGroup.add(upperBody);

    const abdomen = makeMesh(this.geoAbdomen, 'sleeve', 'thorax');
    abdomen.scale.set(1.02 * waistW, 1.0, 0.68 * chestD);
    abdomen.position.set(0, 0.12, 0);

    const chest = makeMesh(this.geoChest, 'sleeve', 'thorax');
    chest.scale.set(1.1 * torsoW, 1.0, 0.66 * chestD);
    chest.position.set(0, 0.365, 0);

    const frontPlate = makeMesh(this.geoSapiPlate, 'vest', 'thorax', 'metal');
    frontPlate.scale.set(torsoW, isFemale ? 0.94 : 1.0, 1.0);
    frontPlate.position.set(0, 0.33, -0.104 * chestD);

    const backPlate = makeMesh(this.geoSapiPlate, 'vest', 'thorax', 'metal');
    backPlate.scale.set(torsoW, isFemale ? 0.94 : 1.0, 1.0);
    backPlate.position.set(0, 0.33, 0.108 * chestD);

    const cummerbund = makeMesh(this.geoCummerbund, 'vest');
    cummerbund.scale.set(1.08 * waistW, 1.0, 0.68 * chestD);
    cummerbund.position.set(0, 0.225, 0);

    upperBody.add(abdomen, chest, frontPlate, backPlate, cummerbund);

    // Subtle contoured chest silhouette for FEMALE operator under/integrated with carrier
    if (isFemale) {
      for (const side of [-1, 1]) {
        const contour = makeMesh(this.geoChestContour, 'sleeve');
        contour.scale.set(0.86, 0.78, 0.56);
        contour.position.set(side * 0.056, 0.365, -0.092 * chestD);
        upperBody.add(contour);
      }
    }

    for (const side of [-1, 1]) {
      const strap = makeMesh(this.geoStrap, 'vest');
      strap.scale.set(torsoW, 1.0, 1.0);
      strap.position.set(side * 0.10 * torsoW, 0.495, 0.005);
      strap.rotation.z = -side * 0.16;
      upperBody.add(strap);
    }

    for (let i = -1; i <= 1; i++) {
      const pouch = makeMesh(this.geoMagPouch, 'pouch');
      pouch.scale.set(torsoW, 0.96, 1.0);
      pouch.position.set(i * 0.068 * torsoW, 0.24, -0.125 * chestD);
      pouch.rotation.y = -i * 0.14;
      upperBody.add(pouch);
    }

    // Chest-mounted Axon Bodycam silhouette & IFF patch
    const camMount = makeMesh(this.geoCamMount, 'hardware');
    camMount.position.set(0.034 * torsoW, 0.405, -0.124 * chestD);
    const chestIffPatch = makeMesh(this.geoShoulderPatch, 'iffTrim');
    chestIffPatch.scale.set(1.5, 0.5, 0.28);
    chestIffPatch.position.set(-0.052 * torsoW, 0.415, -0.122 * chestD);
    upperBody.add(camMount, chestIffPatch);

    // === HEAD & BALLISTIC FAST HELMET ===
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.555, 0);
    upperBody.add(headGroup);

    const headScaleXZ = isFemale ? 0.94 : 1.0;
    const neck = makeMesh(this.geoNeck, 'hood');
    neck.scale.set(isFemale ? 0.88 : 1.0, 1.0, isFemale ? 0.88 : 1.0);
    neck.position.set(0, 0.02, 0.005);

    const headCore = makeMesh(this.geoHead, 'skin', 'head');
    headCore.scale.set(0.92 * headScaleXZ, 1.06, 0.96 * headScaleXZ);
    headCore.position.set(0, 0.128, 0);

    const balaclava = makeMesh(this.geoBalaclava, 'hood', 'head');
    balaclava.scale.set(headScaleXZ, 1.0, headScaleXZ);
    balaclava.position.set(0, 0.084, 0.002);

    const helmetShell = makeMesh(this.geoHelmetShell, 'helmet', 'head', 'metal');
    helmetShell.scale.set(headScaleXZ, 0.96, 1.06 * headScaleXZ);
    helmetShell.position.set(0, 0.152, 0.005);

    const helmetRim = makeMesh(this.geoHelmetRim, 'helmet', 'head', 'metal');
    helmetRim.scale.set(headScaleXZ, 1.0, 1.06 * headScaleXZ);
    helmetRim.position.set(0, 0.172, 0.005);

    const helmetBand = makeMesh(this.geoHelmetBand, 'iffTrim');
    helmetBand.scale.set(1.01 * headScaleXZ, 1.0, 1.07 * headScaleXZ);
    helmetBand.position.set(0, 0.182, 0.005);

    const nvgShroud = makeMesh(this.geoNvgShroud, 'hardware');
    nvgShroud.position.set(0, 0.216, -0.128 * headScaleXZ);

    const visor = makeMesh(this.geoVisor, 'visor');
    visor.scale.set(headScaleXZ, 1.0, 1.0);
    visor.position.set(0, 0.142, -0.102 * headScaleXZ);

    const earL = makeMesh(this.geoEarPro, 'hardware');
    earL.position.set(-0.118 * headScaleXZ, 0.128, 0.01);
    const earR = makeMesh(this.geoEarPro, 'hardware');
    earR.position.set(0.118 * headScaleXZ, 0.128, 0.01);

    headGroup.add(
      neck,
      headCore,
      balaclava,
      helmetShell,
      helmetRim,
      helmetBand,
      nvgShroud,
      visor,
      earL,
      earR,
    );

    if (isFemale) {
      // Tactical low hair bun tucked neatly beneath the rear helmet rim
      const bun = makeMesh(this.geoHairBun, 'hood');
      bun.scale.set(0.95, 0.85, 1.05);
      bun.position.set(0, 0.096, 0.115);
      headGroup.add(bun);
    }

    // === ARTICULATED 2-BONE ARMS (UpperArm -> Elbow -> Forearm -> Cuff -> Glove) ===
    // Both segments extend along local -Y so identity rotation hangs naturally down for ragdoll parity.
    const buildArticulatedArm = (side: -1 | 1) => {
      const armPivot = new THREE.Group();
      armPivot.position.set(side * shoulderX, shoulderY, -0.015);

      const shoulder = makeMesh(this.geoShoulderCap, 'sleeve');
      shoulder.scale.set(armR, armR, armR);

      const upperArmMesh = makeMesh(this.geoUpperArm, 'sleeve', 'limb');
      upperArmMesh.scale.set(armR, 1.0, armR);
      upperArmMesh.position.set(0, -upperArmLen * 0.5, 0);

      const patch = makeMesh(this.geoShoulderPatch, 'iffTrim');
      patch.position.set(side * 0.052 * armR, -0.105, -0.008);

      const forearmPivot = new THREE.Group();
      forearmPivot.position.set(0, -upperArmLen, 0);

      const elbow = makeMesh(this.geoElbowPad, 'knuckle');
      elbow.scale.set(armR, armR, armR);

      const forearmMesh = makeMesh(this.geoForearm, 'sleeve', 'limb');
      forearmMesh.scale.set(forearmR, 1.0, forearmR);
      forearmMesh.position.set(0, -lowerArmLen * 0.5, 0);

      const cuff = makeMesh(this.geoCuff, 'pouch');
      cuff.scale.set(forearmR, 1.0, forearmR);
      cuff.position.set(0, -lowerArmLen + 0.022, 0);

      const glove = makeMesh(this.geoGlove, 'glove', 'limb');
      glove.scale.set(profile.handScale, profile.handScale, profile.handScale);
      glove.position.set(0, -lowerArmLen - 0.025, 0);

      forearmPivot.add(elbow, forearmMesh, cuff, glove);
      armPivot.add(shoulder, upperArmMesh, patch, forearmPivot);
      return { armPivot, forearmPivot };
    };

    const leftArmParts = buildArticulatedArm(-1);
    const rightArmParts = buildArticulatedArm(1);
    const leftArm = leftArmParts.armPivot;
    const rightArm = rightArmParts.armPivot;
    upperBody.add(leftArm, rightArm);

    // === DEDICATED LOCAL WEAPON SOCKET ON UPPER CHEST / RIGHT SHOULDER READY-MOUNT ===
    const weaponSocket = new THREE.Group();
    weaponSocket.name = 'weaponSocket';
    weaponSocket.position.set(0.138 * torsoW, 0.315, -0.14);
    upperBody.add(weaponSocket);

    const weaponPivot = new THREE.Group();
    weaponPivot.name = 'weaponPivot';
    weaponSocket.add(weaponPivot);

    // Rifle geometry built around local origin (rear receiver) so stock seats into right shoulder
    const receiver = makeMesh(this.geoRifleReceiver, 'gun');
    receiver.position.set(0, 0.0, -0.08);
    const handguard = makeMesh(this.geoRifleHandguard, 'gunAccent');
    handguard.position.set(0, 0.008, -0.355);
    const stock = makeMesh(this.geoRifleStock, 'gunAccent');
    stock.position.set(0, -0.01, 0.14);
    const buttpad = makeMesh(this.geoRifleButtpad, 'sole');
    buttpad.position.set(0, -0.014, 0.242);
    const pistolGrip = makeMesh(this.geoRiflePistolGrip, 'gunAccent');
    pistolGrip.position.set(0, -0.072, -0.006);
    pistolGrip.rotation.x = -0.32;
    const mag = makeMesh(this.geoRifleMag, 'gunAccent');
    mag.position.set(0, -0.095, -0.145);
    mag.rotation.x = 0.16;
    const optic = makeMesh(this.geoRifleOptic, 'hardware');
    optic.position.set(0, 0.062, -0.065);
    const barrel = makeMesh(this.geoRifleBarrel, 'gun');
    barrel.position.set(0, 0.01, -0.585);

    const muzzleFlash = makeMesh(this.geoFlash, 'flash');
    muzzleFlash.position.set(0, 0.01, -0.74);
    muzzleFlash.visible = false;

    const laserBeam = makeMesh(this.geoLaser, 'laser');
    laserBeam.position.set(0.026, 0.02, -7.85);
    laserBeam.visible = false;

    const flashlightGlow = makeMesh(this.geoLightGlow, 'lightGlow');
    flashlightGlow.position.set(-0.026, -0.008, -0.52);
    flashlightGlow.visible = false;

    weaponPivot.add(
      receiver,
      handguard,
      stock,
      buttpad,
      pistolGrip,
      mag,
      optic,
      barrel,
      muzzleFlash,
      laserBeam,
      flashlightGlow,
    );

    // Local grip anchors in weaponSocket space for 2-bone arm IK
    const rightGripLocal = new THREE.Vector3(0.0, -0.078, -0.012);
    const leftHandguardLocal = new THREE.Vector3(-0.018, -0.022, -0.295);

    const applyUniform = (nextUniformId: OperatorUniformId): void => {
      const nextBundle = this.materialLib.getBundle(nextUniformId);
      for (let i = 0; i < slotBindings.length; i++) {
        const b = slotBindings[i];
        b.mesh.material = this.pickMat(nextBundle, b.slot);
      }
    };

    const applyCombatPose = (pose: TacticalCombatPose): void => {
      const crouch = THREE.MathUtils.clamp(pose.crouchBlend, 0, 1);
      const lean = THREE.MathUtils.clamp(pose.leanBlend, -1, 1);
      const pitch = THREE.MathUtils.clamp(pose.aimPitch, -1.25, 1.25);
      const ads = THREE.MathUtils.clamp(pose.adsBlend, 0, 1);
      const pointAim = THREE.MathUtils.clamp(pose.pointAimBlend, 0, 1);
      const cant = THREE.MathUtils.clamp(pose.cantBlend, 0, 1);
      const reload = THREE.MathUtils.clamp(pose.reloadBlend, 0, 1);
      const recoil = THREE.MathUtils.clamp(pose.recoilKick, 0, 1.5);
      const vaultW = THREE.MathUtils.clamp(pose.vaultBlend ?? 0, 0, 1);
      const vaultProg = THREE.MathUtils.clamp(pose.vaultProgress ?? 0.5, 0, 1);
      const vaultPeak = Math.sin(vaultProg * Math.PI);
      const isHighMantle = pose.vaultKind === 'HIGH_MANTLE';

      // 1. Lower Body: anatomical crouch + stride + vault/climb knee-tuck
      const moveWeight = THREE.MathUtils.clamp((pose.speedMps - 0.15) / 2.2, 0, 1) * (1 - vaultW * 0.85);
      const strideAmp = (pose.sprint ? 0.56 : 0.40) * (1 - crouch * 0.35) * moveWeight;

      const baseThigh = 0.08 + crouch * 0.72; // forward hip flexion (+X)
      const baseKnee = -(0.16 + crouch * 1.42); // backward knee flexion (-X), ALWAYS <= 0

      const sinL = Math.sin(pose.walkCycle);
      const cosL = Math.cos(pose.walkCycle);
      const sinR = -sinL;
      const cosR = -cosL;

      // Left leg (leads the hurdle tuck during vault/climb)
      const swingL = sinL * strideAmp;
      const liftL = Math.max(0, -cosL) * strideAmp * 0.78;
      const trailL = Math.max(0, -sinL) * strideAmp * 0.65;
      const vaultLegLead = Math.sin(Math.min(1, vaultProg * 1.35) * Math.PI);
      const vaultLegTrail = Math.sin(Math.max(0, (vaultProg - 0.18) / 0.82) * Math.PI);

      const thighXL = baseThigh + swingL * 0.85 + liftL * 0.35 + vaultW * vaultLegLead * 1.05;
      const kneeXL = Math.min(-0.06, baseKnee - liftL * 0.95 - trailL * 0.55 - vaultW * vaultLegLead * 1.45);
      const ankleXL = -(thighXL + kneeXL);

      // Right leg (trails slightly behind lead leg over obstacle)
      const swingR = sinR * strideAmp;
      const liftR = Math.max(0, -cosR) * strideAmp * 0.78;
      const trailR = Math.max(0, -sinR) * strideAmp * 0.65;
      const thighXR = baseThigh + swingR * 0.85 + liftR * 0.35 + vaultW * vaultLegTrail * 0.88;
      const kneeXR = Math.min(-0.06, baseKnee - liftR * 0.95 - trailR * 0.55 - vaultW * vaultLegTrail * 1.28);
      const ankleXR = -(thighXR + kneeXR);

      leftLegParts.hipPivot.rotation.set(thighXL, 0.05, vaultW * vaultPeak * 0.14);
      leftLegParts.kneePivot.rotation.set(kneeXL, 0, 0);
      leftLegParts.anklePivot.rotation.set(ankleXL, 0, 0);

      rightLegParts.hipPivot.rotation.set(thighXR, -0.05, -vaultW * vaultPeak * 0.1);
      rightLegParts.kneePivot.rotation.set(kneeXR, 0, 0);
      rightLegParts.anklePivot.rotation.set(ankleXR, 0, 0);

      // Compute exact pelvis Y so the lowest planted boot sole rests flat on y = 0 (and lifts cleanly while vaulting)
      const reachL = thighLen * Math.cos(thighXL) + shinLen * Math.cos(thighXL + kneeXL);
      const reachR = thighLen * Math.cos(thighXR) + shinLen * Math.cos(thighXR + kneeXR);
      const groundedPelvisY = Math.max(reachL, reachR) + ankleHeight;
      const vaultPelvisY = THREE.MathUtils.lerp(Math.max(0.46, groundedPelvisY), restPelvisY - 0.06, vaultW * 0.65);
      pelvisGroup.position.set(0, vaultPelvisY, 0);
      pelvisGroup.rotation.set(0, 0, 0);

      // 2. Upper Body lean, crouch forward cant, vault athletic pitch, and hit flinch
      const crouchTorsoForward = -crouch * 0.12;
      const vaultTorsoForward = -vaultW * (vaultPeak * 0.36 + (isHighMantle ? 0.18 * vaultPeak : 0));
      const vaultRoll = vaultW * vaultPeak * (isHighMantle ? 0.04 : 0.18);
      upperBody.position.set(lean * 0.06 * (1 - vaultW), 0.035, -vaultW * vaultPeak * 0.05);
      upperBody.rotation.set(
        crouchTorsoForward + vaultTorsoForward + pose.flinchPitch,
        0,
        -lean * 0.24 * (1 - vaultW) + vaultRoll,
      );

      // 3. Head aim pitch tracking + subtle cheek-weld roll
      const cheekWeldRoll = (ads - pointAim * 0.35) * 0.11 * (1 - vaultW);
      headGroup.rotation.set(pitch * 0.76 * (1 - vaultW * 0.6) - vaultW * vaultPeak * 0.18, 0, -cheekWeldRoll);

      // 4. Local weaponSocket placement on upper chest / right shoulder ready-mount
      const effAds = ads * (1 - vaultW);
      const effPointAim = pointAim * (1 - vaultW);
      const effCant = cant * (1 - vaultW);
      const primaryAdsW = Math.max(0, effAds - Math.max(effPointAim, effCant));
      const cantW = Math.max(effPointAim, effCant);

      // Hip / Combat Ready (stock seated in right shoulder pocket, barrel forward)
      let wx = 0.138 * torsoW;
      let wy = 0.315;
      let wz = -0.145;
      let wepYaw = 0.11;

      // Primary ADS (raised to cheek weld, centered)
      wx = THREE.MathUtils.lerp(wx, 0.064 * torsoW, primaryAdsW);
      wy = THREE.MathUtils.lerp(wy, 0.435, primaryAdsW);
      wz = THREE.MathUtils.lerp(wz, -0.115, primaryAdsW);
      wepYaw = THREE.MathUtils.lerp(wepYaw, 0.02, primaryAdsW);

      // Point Aim (35° canted) / Canted ADS (40° canted)
      wx = THREE.MathUtils.lerp(wx, 0.112 * torsoW, cantW);
      wy = THREE.MathUtils.lerp(wy, 0.405, cantW);
      wz = THREE.MathUtils.lerp(wz, -0.135, cantW);
      wepYaw = THREE.MathUtils.lerp(wepYaw, 0.04, cantW);

      // Reload posture dip
      wx = THREE.MathUtils.lerp(wx, 0.085 * torsoW, reload);
      wy = THREE.MathUtils.lerp(wy, 0.275, reload);
      wz = THREE.MathUtils.lerp(wz, -0.175, reload);
      wepYaw = THREE.MathUtils.lerp(wepYaw, 0.30, reload);

      // Vault/climb retention tuck (keeps rifle controlled at right ribcage while left hand braces ledge)
      if (vaultW > 0.005) {
        wx = THREE.MathUtils.lerp(wx, 0.20 * torsoW, vaultW);
        wy = THREE.MathUtils.lerp(wy, 0.22, vaultW);
        wz = THREE.MathUtils.lerp(wz, -0.12, vaultW);
        wepYaw = THREE.MathUtils.lerp(wepYaw, -0.22, vaultW);
      }

      const recoilZKick = recoil * 0.045 + Math.abs(pose.firingVibration) * 0.35;
      const recoilPitchKick = recoil * 0.095 + pose.firingVibration;
      const cantRollRad = effPointAim * 0.61 + effCant * 0.70;
      const reloadPitchOffset = -reload * 0.42;
      const reloadRollOffset = reload * 0.42;
      const vaultWepPitch = -vaultW * 0.48;
      const vaultWepRoll = -vaultW * 0.28;

      weaponSocket.position.set(wx, wy, wz + recoilZKick);
      weaponSocket.rotation.set(
        pitch * (1 - vaultW) + recoilPitchKick + reloadPitchOffset + vaultWepPitch,
        wepYaw,
        cantRollRad + reloadRollOffset + vaultWepRoll,
      );
      weaponPivot.position.set(0, 0, 0);
      weaponPivot.rotation.set(0, 0, 0);

      // 5. Two-bone Arm IK in upperBody local space -> hands stay locked on grip/handguard or brace ledge on vault
      _shR.set(shoulderX, shoulderY, -0.015);
      _shL.set(-shoulderX, shoulderY, -0.015);

      _gripR.copy(rightGripLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
      _gripL.copy(leftHandguardLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);

      if (reload > 0.005) {
        _reloadL.set(-0.04 * torsoW, 0.20, -0.155);
        _gripL.lerp(_reloadL, reload);
      }

      if (vaultW > 0.005) {
        // Left hand reaches forward/down (vault/climb) or up-then-down (high mantle) to plant firmly on obstacle
        const braceY = isHighMantle
          ? THREE.MathUtils.lerp(shoulderY + 0.34, 0.08, vaultProg)
          : THREE.MathUtils.lerp(0.24, 0.04, vaultProg);
        _vaultBraceL.set(-shoulderX * 0.92, braceY, -0.36);
        _gripL.lerp(_vaultBraceL, vaultW);

        if (isHighMantle) {
          _vaultBraceR.set(shoulderX * 0.85, braceY + 0.04, -0.34);
          _gripR.lerp(_vaultBraceR, vaultW * 0.72);
        }
      }

      // Natural tactical elbow poles (down, slightly outward & back; shift with canted roll)
      _poleR.set(shoulderX + 0.22 + cantRollRad * 0.14, shoulderY - 0.36, 0.16);
      _poleL.set(-shoulderX - 0.16 - vaultW * 0.14, shoulderY - 0.38 - cantRollRad * 0.08 + vaultW * 0.18, 0.05 + vaultW * 0.12);

      // Solve Right Arm
      solveTwoBoneIK(_shR, _gripR, _poleR, upperArmLen, lowerArmLen, _ikRes);
      computeNegYSegmentQuat(_ikRes.dir1, _poleR.sub(_shR), _armQuat);
      rightArmParts.armPivot.quaternion.copy(_armQuat);
      computeNegYSegmentQuat(_ikRes.dir2, _poleR, _foreQuat);
      _armQuatInv.copy(_armQuat).invert();
      rightArmParts.forearmPivot.quaternion.copy(_armQuatInv).multiply(_foreQuat);

      // Solve Left Arm
      solveTwoBoneIK(_shL, _gripL, _poleL, upperArmLen, lowerArmLen, _ikRes);
      computeNegYSegmentQuat(_ikRes.dir1, _poleL.sub(_shL), _armQuat);
      leftArmParts.armPivot.quaternion.copy(_armQuat);
      computeNegYSegmentQuat(_ikRes.dir2, _poleL, _foreQuat);
      _armQuatInv.copy(_armQuat).invert();
      leftArmParts.forearmPivot.quaternion.copy(_armQuatInv).multiply(_foreQuat);
    };

    const resetRagdollPose = (): void => {
      bodyPivot.position.set(0, 0, 0);
      bodyPivot.rotation.set(0, 0, 0);
      pelvisGroup.position.set(0, restPelvisY, 0);
      pelvisGroup.rotation.set(0, 0, 0);
      upperBody.position.set(0, 0.035, 0);
      upperBody.rotation.set(0, 0, 0);
      headGroup.rotation.set(0, 0, 0);

      leftLegParts.hipPivot.rotation.set(0, 0, 0);
      leftLegParts.kneePivot.rotation.set(0, 0, 0);
      leftLegParts.anklePivot.rotation.set(0, 0, 0);
      rightLegParts.hipPivot.rotation.set(0, 0, 0);
      rightLegParts.kneePivot.rotation.set(0, 0, 0);
      rightLegParts.anklePivot.rotation.set(0, 0, 0);

      leftArmParts.armPivot.rotation.set(0, 0, 0);
      leftArmParts.forearmPivot.rotation.set(0, 0, 0);
      rightArmParts.armPivot.rotation.set(0, 0, 0);
      rightArmParts.forearmPivot.rotation.set(0, 0, 0);

      weaponSocket.position.set(0.138 * torsoW, 0.315, -0.145);
      weaponSocket.rotation.set(0, 0.11, 0);
      weaponPivot.position.set(0, 0, 0);
      weaponPivot.rotation.set(0, 0, 0);
    };

    // Initialize into a clean combat-ready pose immediately
    applyCombatPose({
      crouchBlend: 0,
      leanBlend: 0,
      aimPitch: 0,
      adsBlend: 0,
      pointAimBlend: 0,
      cantBlend: 0,
      reloadBlend: 0,
      speedMps: 0,
      walkCycle: 0,
      sprint: false,
      recoilKick: 0,
      firingVibration: 0,
      flinchPitch: 0,
    });

    return {
      operatorId,
      root,
      bodyPivot,
      pelvisGroup,
      upperBody,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm,
      headGroup,
      weaponSocket,
      weaponPivot,
      muzzleFlash,
      laserBeam,
      flashlightGlow,
      hitMeshes,
      applyUniform,
      applyCombatPose,
      resetRagdollPose,
      setBeltEquipment,
    };
  }

  public dispose(): void {
    this.materialLib.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

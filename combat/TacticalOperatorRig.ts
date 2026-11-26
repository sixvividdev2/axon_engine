import * as THREE from 'three';
import {
  createTwoBoneIKResult,
  solveTwoBoneIK,
  TwoBoneIKResult,
} from '../bodycam-sdk/IKSolver';
import {
  DEFAULT_OPERATOR_ID,
  EyewearId,
  FaceGearId,
  FacePresetId,
  GLOVE_COLOR_LIST,
  HELMET_COLOR_LIST,
  HelmetTypeId,
  normalizeOperatorId,
  NvgMountId,
  OPERATOR_PROFILES,
  OperatorId,
  pickFacePresetFromSeed,
} from '../bodycam-sdk/operator/OperatorTypes';
import {
  buildAnatomicalHeadAssembly,
  BuiltAnatomicalHeadAssembly,
  getSkinTonePalette,
} from '../bodycam-sdk/character/AnatomicalHeadBuilder';
import {
  FacialExpressionController,
  FacialExpressionInput,
  FacialExpressionIntent,
} from '../bodycam-sdk/character/FacialExpressionController';
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
import {
  buildTacticalBackpackMesh,
  BuiltTacticalBackpackMesh,
} from '../bodycam-sdk/equipment/TacticalBackpackMesh';
import type { BackpackTemplateId } from '../src/modes/openworld/inventory/TetrisInventoryTypes';
import { resolveWeaponProfile } from '../bodycam-sdk/weaponProfiles';
import {
  evalRatchetedSuppressorTwist,
  RatchetedSuppressorTwistSample,
} from '../bodycam-sdk/weapons/WeaponAnimator';
import { WeaponAssembler } from '../bodycam-sdk/weapons/WeaponAssembler';
import {
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk/weapons/WeaponModelFactory';
import { normalizeWeaponAttachments, WeaponAttachments } from '../data/attachments';
import { SyncedHandlingAction } from '../data/multiplayer';
import { IR_LAYER } from '../bodycam-sdk/BodycamPostProcess';

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
  /** 0..1 tactical Free Zoom / focus blend (neck/head forward crane + eye squint) */
  focusBlend?: number;
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
  /** Active synced firearm handling action (reload, suppressor toggle, pump, bolt, zoom, etc.) */
  handlingAction?: SyncedHandlingAction;
  /** Normalized 0..1 progress through active handling action */
  handlingProgress?: number;
  /** Equipped tactical ordnance ID when performing a GRENADE_* handling action */
  grenadeEquipmentId?: TacticalEquipmentId;
  /** Normalized 0..1 throw tension / windup charge */
  grenadeCharge01?: number;
  /** Active grenade throw posture ('overhand' | 'underhand') */
  grenadeThrowStyle?: 'overhand' | 'underhand';
  /** 0..1 forward wall/door obstruction compressing 3P weapon into CQB retention */
  wallObstruction01?: number;
  /** 0..1 waist wall proximity compressing belt equipment radially inward */
  beltWallTuck01?: number;
  /** Independent head yaw offset in radians (+left, -right, clamped anatomically) */
  headYaw?: number;
  /** Independent head pitch offset in radians (+up, -down) */
  headPitchOffset?: number;
  /** Independent head roll offset in radians (curious/alert tilt or hit flinch) */
  headRollOffset?: number;
  /** Upper-body yaw offset in radians for natural alert/scanning posture */
  torsoYawOffset?: number;
  /** Frame delta time in seconds for facial expression damping & blink timers */
  dt?: number;
  /** Facial expression intent ('calm', 'alert', 'aiming', 'suppressed', 'injured', 'dead') */
  facialIntent?: FacialExpressionIntent;
  /** 0..1 continuous stress weight for micro-expressions */
  stress01?: number;
  /** 0..1 physical trauma grimace */
  injury01?: number;
  /** 0..1 sharp flinch impulse */
  flinchImpulse01?: number;
  /** World-space point eyes should track */
  gazeTargetWorld?: Readonly<THREE.Vector3> | null;
  /** Distance from camera in meters for 25m / 35m facial LOD throttling & freeze */
  distanceToCameraM?: number;
  /** Whether rig is visible to active camera (false freezes facial evaluation) */
  isVisible?: boolean;
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
  beltHitMeshes: THREE.Mesh[];
  applyUniform: (uniformId: OperatorUniformId) => void;
  applyCombatPose: (pose: TacticalCombatPose) => void;
  resetRagdollPose: () => void;
  setBeltEquipment: (
    equipmentId: TacticalEquipmentId,
    beltSlot?: TacticalBeltSlot,
    count?: number,
    visible?: boolean,
  ) => void;
  setBackpack: (templateId: BackpackTemplateId | null) => void;
  setWeaponClass: (weaponClass: 'pistol' | 'smg' | 'shotgun' | 'rifle') => void;
  setWeaponLoadout: (weaponId: string, attachments?: WeaponAttachments | null) => void;
  setSuppressedVisual: (suppressed: boolean) => void;
  disposeWeapon: () => void;
  setGearAppearance: (gear: {
    glovesEnabled?: boolean;
    gloveColor?: string;
    helmetType?: HelmetTypeId;
    helmetColor?: string;
    nvgMount?: NvgMountId;
    nvgFlipped?: boolean;
    faceGear?: FaceGearId;
    eyewear?: EyewearId;
    facePreset?: FacePresetId;
  }) => void;
  setFactionArmband: (colorHex: number | null) => void;
  setIrStrobe: (enabled: boolean, pulseOn?: boolean) => void;
  setWarningLaser: (active: boolean, lengthM?: number) => void;
  headAssembly: BuiltAnatomicalHeadAssembly;
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
const _handAuxL = new THREE.Vector3();
const _handAuxR = new THREE.Vector3();
const _pouchLocal = new THREE.Vector3();
const _sockTmp = new THREE.Vector3();
const _suppTwistSample: RatchetedSuppressorTwistSample = {
  cumulativeAngle01: 0,
  axial01: 0,
  wristRollRad: 0,
  gripRelease01: 0,
  weaponCounterRollRad: 0,
  strokeIndex: 0,
};

function smoothstep3P(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-5, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function buildAttachmentSig(weaponId: string, att?: WeaponAttachments | null): string {
  if (!att) return `${weaponId}|bare`;
  return [
    weaponId,
    att.optic ?? '',
    att.muzzle ?? '',
    att.suppressorStowed ? 'S' : '',
    att.tactical ?? '',
    att.foregrip ?? '',
    att.railAdapter ?? '',
    att.canted ?? '',
    att.magazine ?? '',
  ].join('|');
}

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
  private readonly geoNvgArm: THREE.BoxGeometry;
  private readonly geoNvgPvs7Body: THREE.BoxGeometry;
  private readonly geoNvgTube: THREE.CylinderGeometry;
  private readonly geoVisor: THREE.BoxGeometry;
  private readonly geoEarPro: THREE.CylinderGeometry;
  private readonly geoHairBun: THREE.SphereGeometry;

  private readonly geoFlash: THREE.OctahedronGeometry;
  private readonly geoLaser: THREE.CylinderGeometry;
  private readonly geoLightGlow: THREE.SphereGeometry;
  private readonly geoArmband: THREE.CylinderGeometry;
  private readonly geoIrStrobeHousing: THREE.BoxGeometry;
  private readonly geoIrStrobeEmitter: THREE.SphereGeometry;

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
      new THREE.SphereGeometry(0.108, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
    );
    this.geoHelmetRim = this.track(new THREE.CylinderGeometry(0.106, 0.109, 0.022, 14));
    this.geoHelmetBand = this.track(new THREE.CylinderGeometry(0.110, 0.110, 0.024, 14));
    this.geoNvgShroud = this.track(new THREE.BoxGeometry(0.05, 0.054, 0.028));
    this.geoNvgArm = this.track(new THREE.BoxGeometry(0.022, 0.022, 0.044));
    this.geoNvgPvs7Body = this.track(new THREE.BoxGeometry(0.088, 0.044, 0.082));
    this.geoNvgTube = this.track(new THREE.CylinderGeometry(0.017, 0.018, 0.092, 8));
    this.geoNvgTube.rotateX(Math.PI * 0.5);
    this.geoVisor = this.track(new THREE.BoxGeometry(0.18, 0.062, 0.054));
    this.geoEarPro = this.track(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 8));
    this.geoEarPro.rotateZ(Math.PI * 0.5);
    this.geoHairBun = this.track(new THREE.SphereGeometry(0.052, 10, 8));

    // Weapon muzzle FX & tactical beam primitives
    this.geoFlash = this.track(new THREE.OctahedronGeometry(0.09, 0));
    this.geoLaser = this.track(new THREE.CylinderGeometry(0.0036, 0.0036, 15, 4));
    this.geoLaser.rotateX(Math.PI * 0.5);
    this.geoLightGlow = this.track(new THREE.SphereGeometry(0.046, 6, 6));
    this.geoArmband = this.track(new THREE.CylinderGeometry(0.053, 0.049, 0.068, 10, 1, true));
    this.geoIrStrobeHousing = this.track(new THREE.BoxGeometry(0.036, 0.015, 0.044));
    this.geoIrStrobeEmitter = this.track(new THREE.SphereGeometry(0.013, 8, 6));
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

    let activeBundle = this.materialLib.getBundle(uniformId);
    const bundle = activeBundle;
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
    dumpPouch.position.set(-0.148 * pelvisW, -0.01, 0.01);

    const holster = makeMesh(this.geoHolster, 'hardware');
    holster.position.set(0.148 * pelvisW, -0.03, -0.005);

    pelvisGroup.add(pelvisMesh, beltMesh, buckle, dumpPouch, holster);

    // Belt Tactical Equipment Mount (grenades / utility canisters on waist belt)
    const beltEquipmentMount = new THREE.Group();
    beltEquipmentMount.name = 'belt_tactical_equipment_slot';
    pelvisGroup.add(beltEquipmentMount);
    const beltBuiltItems: BuiltTacticalEquipmentMesh[] = [];
    const beltHitMeshes: THREE.Mesh[] = [];
    const beltHitGeo = new THREE.SphereGeometry(0.068, 8, 8);
    const beltHitMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      colorWrite: false,
      depthWrite: false,
    });
    this.disposables.push(beltHitGeo, beltHitMat);

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
      beltHitMeshes.length = 0;
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

        // Dedicated shootable ballistic hit-proxy centered on each physical belt grenade
        const hitProxy = new THREE.Mesh(beltHitGeo, beltHitMat);
        hitProxy.name = `belt_grenade_hit_${i}`;
        hitProxy.position.set(0, -0.015, 0);
        hitProxy.userData = {
          combatActorType: actorType,
          actorId,
          hitZone: 'belt_grenade',
          surfaceMaterial: 'metal',
          beltGrenadeEquipmentId: equipmentId,
          beltGrenadeIndex: i,
        };
        built.group.add(hitProxy);
        beltHitMeshes.push(hitProxy);

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
        beltHitMeshes.length = 0;
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

    // 3D Worn Backpack Mount behind rear ballistic plate
    const backpackMount = new THREE.Group();
    backpackMount.name = 'gear_backpack_mount';
    backpackMount.position.set(0, 0.315, 0.122 * chestD);
    upperBody.add(backpackMount);
    let activeBackpackMesh: BuiltTacticalBackpackMesh | null = null;
    let activeBackpackId: BackpackTemplateId | null = null;

    const setBackpack = (templateId: BackpackTemplateId | null): void => {
      if (activeBackpackId === templateId) return;
      if (activeBackpackMesh) {
        backpackMount.remove(activeBackpackMesh.root);
        activeBackpackMesh.dispose();
        activeBackpackMesh = null;
      }
      activeBackpackId = templateId;
      if (!templateId) return;
      const built = buildTacticalBackpackMesh(templateId, {
        mode: 'worn',
        isFemale,
        castShadow: true,
        receiveShadow: true,
      });
      backpackMount.add(built.root);
      activeBackpackMesh = built;
    };

    this.disposables.push({
      dispose: () => {
        if (activeBackpackMesh) {
          backpackMount.remove(activeBackpackMesh.root);
          activeBackpackMesh.dispose();
          activeBackpackMesh = null;
        }
      },
    });

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

    // Deterministic face preset & skin tone seed per actorId so bots & remote operators show varied realistic faces
    let actorSeedHash = 0;
    for (let c = 0; c < actorId.length; c++) {
      actorSeedHash = (actorSeedHash * 31 + actorId.charCodeAt(c)) >>> 0;
    }
    const initialFacePreset = pickFacePresetFromSeed(actorSeedHash);
    const initialSkinPalette = getSkinTonePalette(
      actorSeedHash,
      isFemale ? 'female' : 'male',
      initialFacePreset,
    );
    const actorSkinMat = this.track(activeBundle.skinMat.clone());
    actorSkinMat.color.setHex(initialSkinPalette.wristHex);

    const neckSkin = new THREE.Mesh(this.geoNeck, actorSkinMat);
    neckSkin.castShadow = true;
    neckSkin.receiveShadow = true;
    neckSkin.scale.set(isFemale ? 0.80 : 0.90, 1.02, isFemale ? 0.80 : 0.90);
    neckSkin.position.set(0, 0.022, 0.004);

    const neck = makeMesh(this.geoNeck, 'hood');
    neck.scale.set(isFemale ? 0.88 : 1.0, 1.0, isFemale ? 0.88 : 1.0);
    neck.position.set(0, 0.02, 0.005);

    const headAssembly = buildAnatomicalHeadAssembly({
      variant: isFemale ? 'female' : 'male',
      toneSeed: actorSeedHash,
      facePreset: initialFacePreset,
      anisotropy: 4,
      hoodMaterial: activeBundle.hoodMat,
      frameMaterial: activeBundle.knuckleMat,
      includeGearAndEyewear: true,
    });
    headAssembly.applyHeadgearClearance('mil_tec', 'neck_gaiter');
    headAssembly.root.position.set(0, 0.028, 0);
    headAssembly.headMesh.userData = {
      combatActorType: actorType,
      actorId,
      hitZone: 'head',
      surfaceMaterial: 'wood',
    };
    hitMeshes.push(headAssembly.headMesh);
    for (const child of headAssembly.faceGearGroups.neckGaiter.children) {
      if ((child as THREE.Mesh).isMesh) {
        slotBindings.push({ mesh: child as THREE.Mesh, slot: 'hood' });
      }
    }
    for (const child of headAssembly.faceGearGroups.balaclava.children) {
      if ((child as THREE.Mesh).isMesh) {
        slotBindings.push({ mesh: child as THREE.Mesh, slot: 'hood' });
      }
    }
    this.disposables.push(...headAssembly.disposables);

    const facialController = new FacialExpressionController(actorSeedHash + 7);
    const facialInputScratch: FacialExpressionInput = {
      mode: 'human',
      intent: 'calm',
      stress01: 0.1,
      injury01: 0,
      flinchImpulse01: 0,
      focus01: 0,
      gazeTargetWorld: null,
      distanceToCameraM: 8,
      isVisible: true,
    };

    const helmetShell = makeMesh(this.geoHelmetShell, 'helmet', 'head', 'metal');
    helmetShell.name = 'rig_helmet_shell';
    helmetShell.scale.set(headScaleXZ, 0.98, 1.07 * headScaleXZ);
    helmetShell.position.set(0, 0.156, 0.005);
    helmetShell.rotation.x = 0.15;

    const helmetRim = makeMesh(this.geoHelmetRim, 'helmet', 'head', 'metal');
    helmetRim.name = 'rig_helmet_rim';
    helmetRim.scale.set(headScaleXZ, 1.0, 1.06 * headScaleXZ);
    helmetRim.position.set(0, 0.154, 0.005);
    helmetRim.rotation.x = 0.15;

    const helmetBand = makeMesh(this.geoHelmetBand, 'iffTrim');
    helmetBand.name = 'rig_helmet_band';
    helmetBand.scale.set(1.022 * headScaleXZ, 1.0, 1.082 * headScaleXZ);
    helmetBand.position.set(0, 0.165, 0.005);
    helmetBand.rotation.x = 0.15;

    const nvgShroud = makeMesh(this.geoNvgShroud, 'hardware');
    nvgShroud.name = 'rig_nvg_shroud';
    nvgShroud.position.set(0, 0.203, -0.108 * headScaleXZ);

    // Lightweight 3rd-person articulating NVG pivot (PVS-7 bi-ocular & RNVG-A dual-tube pods)
    const nvgPivot = new THREE.Group();
    nvgPivot.position.set(0, 0.203, -0.114 * headScaleXZ);
    nvgPivot.rotation.x = -1.28;
    nvgPivot.visible = false;

    const nvgArm = makeMesh(this.geoNvgArm, 'hardware');
    nvgArm.position.set(0, -0.012, -0.024);
    nvgPivot.add(nvgArm);

    const pvs7Group = new THREE.Group();
    const pvs7Body = makeMesh(this.geoNvgPvs7Body, 'hardware');
    pvs7Body.position.set(0, -0.042, -0.058);
    const pvs7Obj = makeMesh(this.geoNvgTube, 'gun');
    pvs7Obj.scale.set(1.22, 1.22, 0.72);
    pvs7Obj.position.set(0, -0.042, -0.102);
    pvs7Group.add(pvs7Body, pvs7Obj);
    pvs7Group.visible = false;
    nvgPivot.add(pvs7Group);

    const arnvgGroup = new THREE.Group();
    const arnvgBridge = makeMesh(this.geoNvgArm, 'hardware');
    arnvgBridge.scale.set(3.2, 0.75, 0.52);
    arnvgBridge.position.set(0, -0.036, -0.05);
    const arnvgTubeL = makeMesh(this.geoNvgTube, 'gun');
    arnvgTubeL.position.set(-0.033, -0.046, -0.068);
    const arnvgTubeR = makeMesh(this.geoNvgTube, 'gun');
    arnvgTubeR.position.set(0.033, -0.046, -0.068);
    arnvgGroup.add(arnvgBridge, arnvgTubeL, arnvgTubeR);
    arnvgGroup.visible = false;
    nvgPivot.add(arnvgGroup);

    const earL = makeMesh(this.geoEarPro, 'hardware');
    earL.position.set(-0.095 * headScaleXZ, 0.124, 0.008);
    const earR = makeMesh(this.geoEarPro, 'hardware');
    earR.position.set(0.095 * headScaleXZ, 0.124, 0.008);

    const irStrobeHousing = makeMesh(this.geoIrStrobeHousing, 'hardware');
    irStrobeHousing.name = 'rig_ir_strobe_housing';
    irStrobeHousing.position.set(0, 0.256, 0.025 * headScaleXZ);
    const irStrobeMat = new THREE.MeshBasicMaterial({
      color: 0xd9f99d,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    });
    const irStrobeEmitter = new THREE.Mesh(this.geoIrStrobeEmitter, irStrobeMat);
    irStrobeEmitter.position.set(0, 0.267, 0.025 * headScaleXZ);
    irStrobeEmitter.layers.set(IR_LAYER);
    irStrobeEmitter.visible = false;

    headGroup.add(
      neckSkin,
      neck,
      headAssembly.root,
      helmetShell,
      helmetRim,
      helmetBand,
      nvgShroud,
      nvgPivot,
      earL,
      earR,
      irStrobeHousing,
      irStrobeEmitter,
    );

    if (isFemale) {
      // Tactical low hair bun tucked neatly beneath the rear helmet rim
      const bun = makeMesh(this.geoHairBun, 'hood');
      bun.scale.set(0.95, 0.85, 1.05);
      bun.position.set(0, 0.096, 0.115);
      headGroup.add(bun);
    }

    // Per-rig colored faction armbands (diegetic IFF)
    const armbandMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.72,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const armbandMeshes: THREE.Mesh[] = [];

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

      const armband = new THREE.Mesh(this.geoArmband, armbandMat);
      armband.scale.set(armR, 1.0, armR);
      armband.position.set(0, -0.145, 0);
      armband.visible = false;
      armband.castShadow = false;
      armbandMeshes.push(armband);

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
      armPivot.add(shoulder, upperArmMesh, patch, armband, forearmPivot);
      return { armPivot, forearmPivot, glove };
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

    // Real procedural PBR weapon assembly mounted inside weaponPivot (Layer 0, thirdPersonMode: true)
    const muzzleFlash = makeMesh(this.geoFlash, 'flash');
    muzzleFlash.position.set(0, 0.01, -0.74);
    muzzleFlash.visible = false;

    const laserBeam = makeMesh(this.geoLaser, 'laser');
    laserBeam.position.set(0.026, 0.02, -7.85);
    laserBeam.visible = false;

    const warningLaserMat = new THREE.MeshBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const warningLaserBeam = new THREE.Mesh(this.geoLaser, warningLaserMat);
    warningLaserBeam.position.set(0.026, 0.02, -7.85);
    warningLaserBeam.visible = false;

    const flashlightGlow = makeMesh(this.geoLightGlow, 'lightGlow');
    flashlightGlow.position.set(-0.026, -0.008, -0.52);
    flashlightGlow.visible = false;

    weaponPivot.add(muzzleFlash, laserBeam, warningLaserBeam, flashlightGlow);

    // Local grip anchors in weaponSocket space for 2-bone arm IK (updated dynamically from real assembly sockets)
    const rightGripLocal = new THREE.Vector3(0.0, -0.078, -0.012);
    const leftHandguardLocal = new THREE.Vector3(-0.018, -0.022, -0.295);
    const magWellLocal = new THREE.Vector3(0.0, -0.095, -0.145);
    const boltRackLocal = new THREE.Vector3(-0.025, 0.025, -0.10);
    const boltHandleLocal = new THREE.Vector3(0.04, 0.015, -0.06);
    const suppGripLocal = new THREE.Vector3(0.0, 0.01, -0.66);
    const zoomRingLocal = new THREE.Vector3(-0.022, 0.075, -0.08);
    const turretLocal = new THREE.Vector3(0.0, 0.09, -0.12);
    const illumLocal = new THREE.Vector3(-0.024, 0.075, -0.11);
    const selectorLocal = new THREE.Vector3(-0.022, -0.01, -0.03);
    const padLocal = new THREE.Vector3(-0.022, 0.02, -0.28);

    let weaponAsm: WeaponModelAssembly | null = null;
    let currentWeaponSig = '';
    let baseMagY = 0;
    let basePumpZ = 0;
    let baseBoltZ = 0;
    let baseSuppPos = new THREE.Vector3();
    let baseSuppRot = new THREE.Euler();
    let baseSuppVisible = false;
    let isUnarmedWeapon = false;

    // Right-palm grenade mount for 3P bone-driven ordnance animations (pin pull, cook, charge, throw)
    const grenadeHoldMount = new THREE.Group();
    grenadeHoldMount.name = 'grenadeHoldMount';
    grenadeHoldMount.position.set(0, -lowerArmLen - 0.025, -0.022);
    grenadeHoldMount.rotation.set(0.28, 0, 0);
    grenadeHoldMount.visible = false;
    rightArmParts.forearmPivot.add(grenadeHoldMount);

    const heldGrenadeMeshes = new Map<TacticalEquipmentId, BuiltTacticalEquipmentMesh>();
    const ensureHeldGrenadeMesh = (eqId: TacticalEquipmentId): BuiltTacticalEquipmentMesh => {
      let existing = heldGrenadeMeshes.get(eqId);
      if (!existing) {
        existing = buildTacticalEquipmentMesh(eqId, {
          withBeltClip: false,
          scale: 1.08,
          renderLayer: 0,
        });
        existing.group.visible = false;
        grenadeHoldMount.add(existing.group);
        heldGrenadeMeshes.set(eqId, existing);
      }
      return existing;
    };

    const disposeWeapon = (): void => {
      if (weaponAsm) {
        weaponPivot.remove(weaponAsm.group);
        weaponAsm.dispose();
        weaponAsm = null;
      }
      for (const built of heldGrenadeMeshes.values()) {
        grenadeHoldMount.remove(built.group);
        built.dispose();
      }
      heldGrenadeMeshes.clear();
      armbandMat.dispose();
      irStrobeMat.dispose();
      warningLaserMat.dispose();
      currentWeaponSig = '';
    };

    this.disposables.push({ dispose: disposeWeapon });

    const setFactionArmband = (colorHex: number | null): void => {
      const show = colorHex !== null;
      if (show) {
        armbandMat.color.setHex(colorHex);
      }
      for (let i = 0; i < armbandMeshes.length; i++) {
        armbandMeshes[i].visible = show;
      }
    };

    let hasHelmetEquipped = true;
    const setIrStrobe = (enabled: boolean, pulseOn = true): void => {
      irStrobeEmitter.visible = enabled && pulseOn && hasHelmetEquipped;
    };

    const setWarningLaser = (active: boolean, lengthM = 24): void => {
      warningLaserBeam.visible = active && !isUnarmedWeapon;
      if (active) {
        const clampedLen = THREE.MathUtils.clamp(lengthM, 2, 48);
        const scaleZ = clampedLen / 15;
        warningLaserBeam.scale.set(1.25, 1.25, scaleZ);
        warningLaserBeam.position.set(
          laserBeam.position.x,
          laserBeam.position.y,
          -clampedLen * 0.5 - 0.35,
        );
      }
    };

    const setWeaponLoadout = (
      weaponId: string,
      rawAttachments?: WeaponAttachments | null,
    ): void => {
      const prof = resolveWeaponProfile(weaponId || 'm4a1');
      const normalized = normalizeWeaponAttachments(prof.id, rawAttachments);
      const sig = buildAttachmentSig(prof.id, normalized);
      if (sig === currentWeaponSig && weaponAsm) return;
      currentWeaponSig = sig;

      if (weaponAsm) {
        weaponPivot.remove(weaponAsm.group);
        weaponAsm.dispose();
        weaponAsm = null;
      }

      isUnarmedWeapon = prof.holdClass === 'unarmed' || prof.visualStyle === 'unarmed';
      if (isUnarmedWeapon) {
        muzzleFlash.visible = false;
        laserBeam.visible = false;
        flashlightGlow.visible = false;
        return;
      }

      const asm = WeaponModelFactory.build(
        {
          id: prof.id,
          holdClass: prof.holdClass,
          barrelLengthM: prof.barrelLengthM,
          visualStyle: prof.visualStyle,
          rightHandSocket: prof.rightHandSocket,
          leftHandSocket: prof.leftHandSocket,
          muzzleOffset: prof.muzzleOffset,
          supportsSuppressor: prof.supportsSuppressor,
          finish: prof.finish,
          railType: prof.railType,
          isRevolver: prof.isRevolver,
          renderLayer: 0,
        },
        false,
      );

      WeaponAssembler.applyAttachments(
        asm,
        prof.massKg,
        prof.barrelLengthM,
        prof.magCapacity,
        normalized,
        { thirdPersonMode: true },
      );

      asm.group.traverse((obj) => {
        obj.layers.set(0);
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      weaponPivot.add(asm.group);
      weaponAsm = asm;

      // Sync real socket anchors for 3P 2-bone arm IK & muzzle/laser/light FX
      rightGripLocal.copy(asm.rightHandSocket.position);
      leftHandguardLocal.copy(asm.leftHandSocket.position);
      magWellLocal.copy(asm.magWellSocket.position);
      boltRackLocal.copy(asm.boltRackSocket.position);
      if (asm.boltHandleSocket) boltHandleLocal.copy(asm.boltHandleSocket.position);
      else boltHandleLocal.copy(asm.boltRackSocket.position);
      if (asm.suppressorGripSocket) {
        suppGripLocal.copy(asm.suppressorGripSocket.position);
      } else if (asm.suppressor) {
        suppGripLocal.copy(asm.suppressor.position);
      } else {
        suppGripLocal.copy(asm.muzzleSocket.position);
      }
      if (asm.zoomRingSocket) zoomRingLocal.copy(asm.zoomRingSocket.position);
      else zoomRingLocal.set(-0.02, 0.072, -0.09);
      if (asm.elevationTurretSocket) turretLocal.copy(asm.elevationTurretSocket.position);
      else turretLocal.set(0, 0.088, -0.11);
      if (asm.illumDialSocket) illumLocal.copy(asm.illumDialSocket.position);
      else illumLocal.set(-0.022, 0.072, -0.10);
      selectorLocal.copy(asm.selectorSocket.position);
      padLocal.copy(asm.pressurePadSocket.position);

      baseMagY = asm.magazine ? asm.magazine.position.y : 0;
      basePumpZ = asm.pumpForend ? asm.pumpForend.position.z : 0;
      baseBoltZ = asm.slideOrBolt ? asm.slideOrBolt.position.z : 0;
      if (asm.suppressor) {
        baseSuppPos.copy(asm.suppressor.position);
        baseSuppRot.copy(asm.suppressor.rotation);
        baseSuppVisible = asm.suppressor.visible;
      } else {
        baseSuppVisible = false;
      }

      muzzleFlash.position.copy(asm.muzzleSocket.position);
      laserBeam.position.set(
        asm.laserSocket.position.x,
        asm.laserSocket.position.y,
        asm.laserSocket.position.z - 7.5,
      );
      flashlightGlow.position.copy(asm.flashlightSocket.position);
    };

    const setSuppressedVisual = (suppressed: boolean): void => {
      if (weaponAsm?.suppressor) {
        weaponAsm.suppressor.visible = suppressed;
        baseSuppVisible = suppressed;
      }
      if (weaponAsm) {
        muzzleFlash.position.copy(weaponAsm.muzzleSocket.position);
        if (suppressed && weaponAsm.suppressor) {
          muzzleFlash.position.z = weaponAsm.suppressor.position.z - 0.10;
        }
      }
    };

    const setWeaponClass = (weaponClass: 'pistol' | 'smg' | 'shotgun' | 'rifle'): void => {
      const defaultId =
        weaponClass === 'pistol'
          ? 'glock_17'
          : weaponClass === 'smg'
            ? 'mp5_9mm'
            : weaponClass === 'shotgun'
              ? 'remington_870'
              : 'm4a1';
      setWeaponLoadout(defaultId, null);
    };

    // Build default carbine immediately
    setWeaponLoadout('m4a1', null);

    let customHelmetMat: THREE.MeshStandardMaterial | null = null;
    let customGloveMat: THREE.MeshStandardMaterial | null = null;
    let currentGear: {
      glovesEnabled?: boolean;
      gloveColor?: string;
      helmetType?: HelmetTypeId;
      helmetColor?: string;
      nvgMount?: NvgMountId;
      nvgFlipped?: boolean;
      faceGear?: FaceGearId;
      eyewear?: EyewearId;
      facePreset?: FacePresetId;
    } | null = null;

    const setGearAppearance = (gear: {
      glovesEnabled?: boolean;
      gloveColor?: string;
      helmetType?: HelmetTypeId;
      helmetColor?: string;
      nvgMount?: NvgMountId;
      nvgFlipped?: boolean;
      faceGear?: FaceGearId;
      eyewear?: EyewearId;
      facePreset?: FacePresetId;
    }): void => {
      currentGear = { ...gear };

      // 0. Face Preset & synced actor skin tone (neck + bare hands)
      if (gear.facePreset) {
        headAssembly.applyFacePreset(gear.facePreset);
        const pal = getSkinTonePalette(
          actorSeedHash,
          isFemale ? 'female' : 'male',
          gear.facePreset,
        );
        actorSkinMat.color.setHex(pal.wristHex);
      }

      // 1. Gloves ON/OFF + Color
      if (gear.glovesEnabled === false) {
        leftArmParts.glove.material = actorSkinMat;
        rightArmParts.glove.material = actorSkinMat;
      } else if (gear.gloveColor && gear.gloveColor !== 'uniform') {
        const gSpec = GLOVE_COLOR_LIST.find((c) => c.id === gear.gloveColor);
        if (gSpec) {
          if (!customGloveMat) {
            customGloveMat = activeBundle.gloveMat.clone();
            this.track(customGloveMat);
          }
          customGloveMat.color.setRGB(gSpec.rgb[0] / 255, gSpec.rgb[1] / 255, gSpec.rgb[2] / 255);
          leftArmParts.glove.material = customGloveMat;
          rightArmParts.glove.material = customGloveMat;
        }
      } else {
        leftArmParts.glove.material = activeBundle.gloveMat;
        rightArmParts.glove.material = activeBundle.gloveMat;
      }

      // 2. Helmet Shell (No Helmet vs MICH-2000 low-cut no mount vs Mil-Tec high-cut + mount) + Color
      const effectiveHelmetType: HelmetTypeId = gear.helmetType ?? 'mil_tec';
      const hasHelmet = effectiveHelmetType !== 'none';
      const isMich = effectiveHelmetType === 'mich';
      hasHelmetEquipped = hasHelmet;
      helmetShell.visible = hasHelmet;
      helmetRim.visible = hasHelmet;
      helmetBand.visible = hasHelmet;
      irStrobeHousing.visible = hasHelmet;
      if (!hasHelmet) {
        irStrobeEmitter.visible = false;
      }
      helmetShell.scale.set(headScaleXZ, isMich ? 1.04 : 0.98, 1.07 * headScaleXZ);
      helmetRim.position.y = isMich ? 0.148 : 0.154;
      earL.visible = hasHelmet && !isMich;
      earR.visible = hasHelmet && !isMich;
      nvgShroud.visible = hasHelmet && !isMich;

      if (gear.helmetColor && gear.helmetColor !== 'uniform') {
        const hSpec = HELMET_COLOR_LIST.find((c) => c.id === gear.helmetColor);
        if (hSpec) {
          if (!customHelmetMat) {
            customHelmetMat = activeBundle.helmetMat.clone();
            this.track(customHelmetMat);
          }
          customHelmetMat.color.setHex(hSpec.hex);
          helmetShell.material = customHelmetMat;
          helmetRim.material = customHelmetMat;
        }
      } else {
        helmetShell.material = activeBundle.helmetMat;
        helmetRim.material = activeBundle.helmetMat;
      }

      // 3. Mounted NVG (locked off unless Mil-Tec) & flip-down hinge pose
      const effectiveMount: NvgMountId =
        effectiveHelmetType === 'mil_tec' ? (gear.nvgMount ?? 'none') : 'none';
      nvgPivot.visible = effectiveMount !== 'none';
      pvs7Group.visible = effectiveMount === 'pvs7';
      arnvgGroup.visible = effectiveMount === 'arnvg';
      nvgPivot.rotation.x = gear.nvgFlipped && effectiveMount !== 'none' ? 0.14 : -1.28;

      // 4. Face Gear, Eyewear & Hair/Helmet Clearance
      const faceGear: FaceGearId = gear.faceGear ?? 'neck_gaiter';
      const eyewear: EyewearId = gear.eyewear ?? 'none';
      headAssembly.applyFaceGear(faceGear);
      headAssembly.applyEyewear(eyewear);
      headAssembly.applyHeadgearClearance(effectiveHelmetType, faceGear);
      neck.visible = faceGear !== 'open_face';
    };

    const applyUniform = (nextUniformId: OperatorUniformId): void => {
      activeBundle = this.materialLib.getBundle(nextUniformId);
      for (let i = 0; i < slotBindings.length; i++) {
        const b = slotBindings[i];
        b.mesh.material = this.pickMat(activeBundle, b.slot);
      }
      if (currentGear) {
        setGearAppearance(currentGear);
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

      // Right leg (trails slightly behind lead leg over obstacle, OR thrusts forward during DOOR_KICK!)
      const isDoorKick3P = pose.handlingAction === 'DOOR_KICK';
      const kickProg = isDoorKick3P ? THREE.MathUtils.clamp(pose.handlingProgress ?? 0, 0, 1) : 0;
      const kickChamber = isDoorKick3P ? smoothstep3P(0.0, 0.25, kickProg) : 0;
      const kickThrust = isDoorKick3P
        ? smoothstep3P(0.22, 0.45, kickProg) * (1 - smoothstep3P(0.55, 0.92, kickProg))
        : 0;
      const swingR = sinR * strideAmp * (1 - kickChamber * 0.85);
      const liftR = Math.max(0, -cosR) * strideAmp * 0.78 * (1 - kickChamber * 0.85);
      const trailR = Math.max(0, -sinR) * strideAmp * 0.65 * (1 - kickChamber * 0.85);
      const thighXR =
        baseThigh +
        swingR * 0.85 +
        liftR * 0.35 +
        vaultW * vaultLegTrail * 0.88 +
        kickChamber * 0.68 +
        kickThrust * 0.62;
      const kneeXR = Math.min(
        -0.04,
        baseKnee -
          liftR * 0.95 -
          trailR * 0.55 -
          vaultW * vaultLegTrail * 1.28 -
          kickChamber * 1.15 +
          kickThrust * 1.25,
      );
      const ankleXR = -(thighXR + kneeXR) + kickThrust * 0.25;

      leftLegParts.hipPivot.rotation.set(thighXL, 0.05, vaultW * vaultPeak * 0.14);
      leftLegParts.kneePivot.rotation.set(kneeXL, 0, 0);
      leftLegParts.anklePivot.rotation.set(ankleXL, 0, 0);

      rightLegParts.hipPivot.rotation.set(thighXR, -0.05, -vaultW * vaultPeak * 0.1);
      rightLegParts.kneePivot.rotation.set(kneeXR, 0, 0);
      rightLegParts.anklePivot.rotation.set(ankleXR, 0, 0);

      // Compute exact pelvis Y so the lowest planted boot sole rests flat on y = 0 (and lifts cleanly while vaulting)
      const reachL = thighLen * Math.cos(thighXL) + shinLen * Math.cos(thighXL + kneeXL);
      const reachR = isDoorKick3P
        ? reachL
        : thighLen * Math.cos(thighXR) + shinLen * Math.cos(thighXR + kneeXR);
      const groundedPelvisY = Math.max(reachL, reachR) + ankleHeight;
      const vaultPelvisY = THREE.MathUtils.lerp(Math.max(0.46, groundedPelvisY), restPelvisY - 0.06, vaultW * 0.65);
      pelvisGroup.position.set(0, vaultPelvisY, 0);
      pelvisGroup.rotation.set(-kickThrust * 0.14, 0, 0);

      // Compress belt-mounted gear slightly inward when pressed against nearby walls/doors
      const beltTuck = THREE.MathUtils.clamp(pose.beltWallTuck01 ?? 0, 0, 1);
      const beltScaleXZ = 1 - beltTuck * 0.24;
      beltEquipmentMount.scale.set(beltScaleXZ, 1, beltScaleXZ);

      const hAct: SyncedHandlingAction =
        pose.handlingAction && pose.handlingAction !== 'NONE'
          ? pose.handlingAction
          : reload > 0.05
            ? 'RELOAD'
            : 'NONE';
      const hProg = THREE.MathUtils.clamp(pose.handlingProgress ?? 0, 0, 1);
      const isGrenadeAct =
        hAct === 'GRENADE_DRAW' ||
        hAct === 'GRENADE_PIN_PULL' ||
        hAct === 'GRENADE_COOK' ||
        hAct === 'GRENADE_CHARGE' ||
        hAct === 'GRENADE_THROW_OVERHAND' ||
        hAct === 'GRENADE_THROW_UNDERHAND';
      const gCharge = THREE.MathUtils.clamp(pose.grenadeCharge01 ?? 0, 0, 1);
      const isGrenadeOverhand = (pose.grenadeThrowStyle ?? 'overhand') === 'overhand';

      // 2. Upper Body lean, crouch forward cant, vault athletic pitch, grenade torso coil, and hit flinch
      let grenadeTorsoYaw = 0;
      let grenadeTorsoPitch = 0;
      if (isGrenadeAct) {
        if (hAct === 'GRENADE_CHARGE' && isGrenadeOverhand) {
          grenadeTorsoYaw = -0.28 * gCharge;
          grenadeTorsoPitch = 0.06 * gCharge;
        } else if (hAct === 'GRENADE_THROW_OVERHAND') {
          const whip = smoothstep3P(0.0, 0.34, hProg);
          const rec = smoothstep3P(0.38, 1.0, hProg);
          grenadeTorsoYaw = THREE.MathUtils.lerp(-0.28, 0.24, whip) * (1 - rec);
          grenadeTorsoPitch = -0.14 * whip * (1 - rec);
        } else if (hAct === 'GRENADE_THROW_UNDERHAND') {
          const whip = smoothstep3P(0.0, 0.32, hProg);
          const rec = smoothstep3P(0.36, 1.0, hProg);
          grenadeTorsoYaw = 0.09 * whip * (1 - rec);
          grenadeTorsoPitch = -0.07 * whip * (1 - rec);
        }
      }
      const crouchTorsoForward = -crouch * 0.12;
      const vaultTorsoForward = -vaultW * (vaultPeak * 0.36 + (isHighMantle ? 0.18 * vaultPeak : 0));
      const vaultRoll = vaultW * vaultPeak * (isHighMantle ? 0.04 : 0.18);
      const strideFactor = THREE.MathUtils.clamp(pose.speedMps / 4.8, 0, 1) * (1 - vaultW) * (1 - ads * 0.55);
      const strideTorsoYaw = Math.sin(pose.walkCycle) * 0.055 * strideFactor;
      const strideTorsoRoll = Math.sin(pose.walkCycle) * 0.032 * strideFactor;
      const torsoYawExtra = THREE.MathUtils.clamp(pose.torsoYawOffset ?? 0, -0.35, 0.35) * (1 - vaultW);
      upperBody.position.set(lean * 0.06 * (1 - vaultW), 0.035, -vaultW * vaultPeak * 0.05);
      upperBody.rotation.set(
        crouchTorsoForward + vaultTorsoForward + pose.flinchPitch + grenadeTorsoPitch,
        grenadeTorsoYaw + torsoYawExtra + strideTorsoYaw,
        -lean * 0.24 * (1 - vaultW) + vaultRoll + strideTorsoRoll,
      );

      // 3. Head aim pitch/yaw/roll tracking + Free-Zoom forward neck crane + idle scanning + cheek-weld roll
      const focus = THREE.MathUtils.clamp(pose.focusBlend ?? 0, 0, 1) * (1 - vaultW * 0.75);
      const cheekWeldRoll = (ads - pointAim * 0.35) * 0.11 * (1 - vaultW) * (isGrenadeAct ? 0 : 1);
      const headYaw = THREE.MathUtils.clamp(pose.headYaw ?? 0, -0.78, 0.78) * (1 - vaultW * 0.8);
      const headPitchExtra = THREE.MathUtils.clamp(pose.headPitchOffset ?? 0, -0.35, 0.35);
      const headRollExtra = THREE.MathUtils.clamp(pose.headRollOffset ?? 0, -0.25, 0.25);
      // Shift head forward ~2.9cm from the neck along local -Z with a subtle attentive forward chin tilt;
      // counter-anchor collar & angle neck forward so the neck stays seamlessly seated into the vest collar.
      headGroup.position.set(0, 0.555 - focus * 0.004, -0.029 * focus);
      neckSkin.position.set(0, 0.022, 0.004 + focus * 0.011);
      neckSkin.rotation.set(-focus * 0.22, 0, 0);
      neck.position.set(0, 0.02, 0.005 + focus * 0.016);
      neck.rotation.set(-focus * 0.14, 0, 0);
      headGroup.rotation.order = 'YXZ';
      headGroup.rotation.set(
        THREE.MathUtils.clamp(
          pitch * 0.76 * (1 - vaultW * 0.6) - vaultW * vaultPeak * 0.18 - focus * 0.045 + headPitchExtra,
          -0.68,
          0.62,
        ),
        headYaw,
        -cheekWeldRoll + headRollExtra,
      );

      // Step anatomical facial expression morphs + eyeball gaze tracking (zero-GC LOD)
      const inferredIntent: FacialExpressionIntent =
        pose.facialIntent ??
        (Math.abs(pose.flinchPitch) > 0.08
          ? 'suppressed'
          : ads > 0.45
            ? 'aiming'
            : pose.sprint
              ? 'alert'
              : 'calm');
      facialInputScratch.mode = 'human';
      facialInputScratch.intent = inferredIntent;
      facialInputScratch.stress01 = pose.stress01 ?? (ads * 0.45 + recoil * 0.4);
      facialInputScratch.injury01 = pose.injury01 ?? 0;
      facialInputScratch.flinchImpulse01 = pose.flinchImpulse01 ?? Math.min(1, Math.abs(pose.flinchPitch) * 2.5);
      facialInputScratch.focus01 = focus;
      facialInputScratch.gazeTargetWorld = pose.gazeTargetWorld ?? null;
      facialInputScratch.distanceToCameraM = pose.distanceToCameraM ?? 8;
      facialInputScratch.isVisible = pose.isVisible ?? root.visible;
      facialController.step(
        pose.dt ?? 0.016,
        facialInputScratch,
        headAssembly.root,
        headAssembly.morphTargetInfluences,
        headAssembly.eyeL,
        headAssembly.eyeR,
      );

      // 4. Local weaponSocket placement on upper chest / right shoulder ready-mount
      const effAds = ads * (1 - vaultW) * (isGrenadeAct ? 0 : 1);
      const effPointAim = pointAim * (1 - vaultW) * (isGrenadeAct ? 0 : 1);
      const effCant = cant * (1 - vaultW) * (isGrenadeAct ? 0 : 1);
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

      const isSuppAct = hAct === 'SUPPRESSOR_DETACH' || hAct === 'SUPPRESSOR_ATTACH';
      const suppEnv = isSuppAct
        ? smoothstep3P(0.0, 0.12, hProg) * (1 - smoothstep3P(0.88, 1.0, hProg))
        : 0;
      const isInspectAct = hAct === 'INSPECT';
      const inspectEnv = isInspectAct
        ? smoothstep3P(0.0, 0.18, hProg) * (1 - smoothstep3P(0.82, 1.0, hProg))
        : 0;
      const isChamberCycleAct = hAct === 'CHAMBER_CYCLE';
      const chamberCycleEnv = isChamberCycleAct
        ? smoothstep3P(0.0, 0.16, hProg) * (1 - smoothstep3P(0.82, 1.0, hProg))
        : 0;

      // Reload / Suppressor / Inspect / Chamber-Cycle posture dip
      const effReload = hAct === 'RELOAD' ? Math.max(reload, smoothstep3P(0.0, 0.12, hProg) * (1 - smoothstep3P(0.88, 1.0, hProg))) : reload;
      wx = THREE.MathUtils.lerp(wx, 0.085 * torsoW, effReload);
      wy = THREE.MathUtils.lerp(wy, 0.275, effReload);
      wz = THREE.MathUtils.lerp(wz, -0.175, effReload);
      wepYaw = THREE.MathUtils.lerp(wepYaw, 0.30, effReload);

      if (suppEnv > 0.005) {
        wx = THREE.MathUtils.lerp(wx, 0.095 * torsoW, suppEnv);
        wy = THREE.MathUtils.lerp(wy, 0.30, suppEnv);
        wz = THREE.MathUtils.lerp(wz, -0.08, suppEnv);
        wepYaw = THREE.MathUtils.lerp(wepYaw, 0.36, suppEnv);
      } else if (inspectEnv > 0.005) {
        wx = THREE.MathUtils.lerp(wx, 0.07 * torsoW, inspectEnv);
        wy = THREE.MathUtils.lerp(wy, 0.36, inspectEnv);
        wepYaw = THREE.MathUtils.lerp(wepYaw, 0.42, inspectEnv);
      } else if (chamberCycleEnv > 0.005) {
        wx = THREE.MathUtils.lerp(wx, 0.082 * torsoW, chamberCycleEnv);
        wy = THREE.MathUtils.lerp(wy, 0.345, chamberCycleEnv);
        wz = THREE.MathUtils.lerp(wz, -0.155, chamberCycleEnv);
        wepYaw = THREE.MathUtils.lerp(wepYaw, 0.34, chamberCycleEnv);
      }

      // Vault/climb retention tuck (keeps rifle controlled at right ribcage while left hand braces ledge)
      if (vaultW > 0.005) {
        wx = THREE.MathUtils.lerp(wx, 0.20 * torsoW, vaultW);
        wy = THREE.MathUtils.lerp(wy, 0.22, vaultW);
        wz = THREE.MathUtils.lerp(wz, -0.12, vaultW);
        wepYaw = THREE.MathUtils.lerp(wepYaw, -0.22, vaultW);
      }

      // CQB wall-obstruction compression: pulls rifle back into high-ready/chest retention so barrels never poke through walls
      const wallObs = THREE.MathUtils.clamp(pose.wallObstruction01 ?? 0, 0, 1) * (1 - vaultW);
      if (wallObs > 0.005 && !isGrenadeAct) {
        wx = THREE.MathUtils.lerp(wx, 0.115 * torsoW, wallObs);
        wy = THREE.MathUtils.lerp(wy, 0.255, wallObs);
        wz = THREE.MathUtils.lerp(wz, 0.055, wallObs);
        wepYaw = THREE.MathUtils.lerp(wepYaw, 0.42, wallObs);
      }

      const recoilZKick = recoil * 0.045 + Math.abs(pose.firingVibration) * 0.35;
      const recoilPitchKick = recoil * 0.095 + pose.firingVibration;
      const cantRollRad = effPointAim * 0.61 + effCant * 0.70;
      const reloadPitchOffset = -effReload * 0.38 - suppEnv * 0.22 - chamberCycleEnv * 0.14;
      const reloadRollOffset = effReload * 0.38 + suppEnv * 0.30 + inspectEnv * 0.55 + chamberCycleEnv * 0.44;
      const vaultWepPitch = -vaultW * 0.48;
      const vaultWepRoll = -vaultW * 0.28;
      const wallPitchOffset = wallObs * 0.86;
      const wallRollOffset = wallObs * 0.16;

      weaponSocket.position.set(wx, wy, wz + recoilZKick);
      weaponSocket.rotation.set(
        pitch * (1 - vaultW) * (1 - suppEnv * 0.7) * (1 - wallObs * 0.82) +
          recoilPitchKick +
          reloadPitchOffset +
          vaultWepPitch +
          wallPitchOffset,
        wepYaw,
        cantRollRad + reloadRollOffset + vaultWepRoll + wallRollOffset,
      );
      weaponPivot.position.set(0, 0, 0);
      weaponPivot.rotation.set(0, 0, 0);

      // Animate 3P weapon sub-parts (pump forend, magazine drop, bolt handle, suppressor twist)
      let pumpTravelZ = 0;
      const chamberRackTravel =
        isChamberCycleAct && hProg > 0.20 && hProg < 0.78
          ? hProg < 0.52
            ? smoothstep3P(0.20, 0.52, hProg)
            : 1 - smoothstep3P(0.56, 0.78, hProg)
          : 0;
      if (weaponAsm) {
        if (weaponAsm.pumpForend) {
          if (hAct === 'PUMP') {
            pumpTravelZ =
              hProg < 0.45
                ? smoothstep3P(0.0, 0.45, hProg) * 0.085
                : (1 - smoothstep3P(0.45, 1.0, hProg)) * 0.085;
          } else if (isChamberCycleAct) {
            pumpTravelZ = chamberRackTravel * 0.085;
          }
          weaponAsm.pumpForend.position.z = basePumpZ + pumpTravelZ;
        }
        if (weaponAsm.magazine) {
          if (hAct === 'RELOAD' && hProg > 0.14 && hProg < 0.66) {
            const outT = smoothstep3P(0.14, 0.34, hProg);
            const inT = smoothstep3P(0.48, 0.65, hProg);
            const drop = hProg < 0.42 ? outT : 1 - inT;
            weaponAsm.magazine.position.y = baseMagY - drop * 0.16;
            weaponAsm.magazine.visible = !(hProg >= 0.34 && hProg <= 0.48);
          } else {
            weaponAsm.magazine.position.y = baseMagY;
            weaponAsm.magazine.visible = true;
          }
        }
        if (weaponAsm.slideOrBolt) {
          const boltBack =
            hAct === 'BOLT'
              ? Math.sin(smoothstep3P(0.18, 0.82, hProg) * Math.PI) * 0.065
              : isChamberCycleAct
                ? chamberRackTravel * 0.064
                : hAct === 'RELOAD' && hProg > 0.70 && hProg < 0.88
                  ? Math.sin(smoothstep3P(0.70, 0.88, hProg) * Math.PI) * 0.055
                  : recoil * 0.032;
          weaponAsm.slideOrBolt.position.z = baseBoltZ + boltBack;
        }
        if (weaponAsm.suppressor) {
          if (hAct === 'SUPPRESSOR_DETACH') {
            if (hProg < 0.14) {
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.copy(baseSuppPos);
              weaponAsm.suppressor.rotation.copy(baseSuppRot);
            } else if (hProg < 0.62) {
              evalRatchetedSuppressorTwist((hProg - 0.14) / 0.48, false, _suppTwistSample);
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.set(
                baseSuppPos.x,
                baseSuppPos.y,
                baseSuppPos.z - _suppTwistSample.axial01 * 0.022,
              );
              weaponAsm.suppressor.rotation.set(
                baseSuppRot.x,
                baseSuppRot.y,
                baseSuppRot.z + _suppTwistSample.cumulativeAngle01 * Math.PI * 3.0,
              );
            } else if (hProg < 0.74) {
              const pullT = smoothstep3P(0.62, 0.74, hProg);
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.set(
                baseSuppPos.x,
                baseSuppPos.y,
                baseSuppPos.z - 0.022 - pullT * 0.055,
              );
            } else {
              weaponAsm.suppressor.visible = false;
              weaponAsm.suppressor.position.copy(baseSuppPos);
              weaponAsm.suppressor.rotation.copy(baseSuppRot);
            }
          } else if (hAct === 'SUPPRESSOR_ATTACH') {
            if (hProg < 0.28) {
              weaponAsm.suppressor.visible = false;
            } else if (hProg < 0.40) {
              const seatT = smoothstep3P(0.28, 0.40, hProg);
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.set(
                baseSuppPos.x,
                baseSuppPos.y,
                baseSuppPos.z - 0.022 - (1 - seatT) * 0.055,
              );
            } else if (hProg < 0.86) {
              evalRatchetedSuppressorTwist((hProg - 0.40) / 0.46, true, _suppTwistSample);
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.set(
                baseSuppPos.x,
                baseSuppPos.y,
                baseSuppPos.z - (1 - _suppTwistSample.axial01) * 0.022,
              );
              weaponAsm.suppressor.rotation.set(
                baseSuppRot.x,
                baseSuppRot.y,
                baseSuppRot.z + (1 - _suppTwistSample.cumulativeAngle01) * Math.PI * 3.0,
              );
            } else {
              weaponAsm.suppressor.visible = true;
              weaponAsm.suppressor.position.copy(baseSuppPos);
              weaponAsm.suppressor.rotation.copy(baseSuppRot);
            }
          } else {
            weaponAsm.suppressor.position.copy(baseSuppPos);
            weaponAsm.suppressor.rotation.copy(baseSuppRot);
            weaponAsm.suppressor.visible = baseSuppVisible;
          }
        }
      }

      // 5. Two-bone Arm IK in upperBody local space -> hands stay locked on real weapon sockets (or grenade throw/pin/cook)
      _shR.set(shoulderX, shoulderY, -0.015);
      _shL.set(-shoulderX, shoulderY, -0.015);
      _pouchLocal.set(-0.07 * torsoW, 0.21, -0.145 * chestD);

      if (isGrenadeAct) {
        weaponPivot.visible = false;
        const throwingReleased =
          (hAct === 'GRENADE_THROW_OVERHAND' || hAct === 'GRENADE_THROW_UNDERHAND') &&
          hProg > 0.30;
        grenadeHoldMount.visible = !throwingReleased;

        const activeEqId = pose.grenadeEquipmentId ?? DEFAULT_TACTICAL_EQUIPMENT_ID;
        const activeGMesh = ensureHeldGrenadeMesh(activeEqId);
        for (const [id, mesh] of heldGrenadeMeshes.entries()) {
          mesh.group.visible = id === activeEqId && !throwingReleased;
        }
        const pinStillIn =
          hAct === 'GRENADE_DRAW' || (hAct === 'GRENADE_PIN_PULL' && hProg < 0.72);
        const spoonStillOn = hAct === 'GRENADE_DRAW' || hAct === 'GRENADE_PIN_PULL';
        activeGMesh.pullRingMesh.visible = pinStillIn;
        activeGMesh.spoonGroup.visible = spoonStillOn;

        // 3P 2-bone IK targets & elbow poles across Draw / Pin-Pull / Cook / Charge / Throw
        _poleR.set(shoulderX + 0.22, shoulderY - 0.32, 0.14);
        _poleL.set(-shoulderX - 0.18, shoulderY - 0.34, 0.06);

        if (hAct === 'GRENADE_DRAW') {
          const t = smoothstep3P(0.0, 1.0, hProg);
          _gripR.set(
            THREE.MathUtils.lerp(0.18 * torsoW, 0.13 * torsoW, t),
            THREE.MathUtils.lerp(0.14, 0.36, t),
            THREE.MathUtils.lerp(-0.10, -0.32, t),
          );
          _gripL.set(-0.14 * torsoW, THREE.MathUtils.lerp(0.24, 0.30, t), -0.24);
        } else if (hAct === 'GRENADE_PIN_PULL') {
          _gripR.set(0.09 * torsoW, 0.37, -0.34);
          if (hProg < 0.34) {
            const reachT = smoothstep3P(0.0, 0.34, hProg);
            _gripL.set(
              THREE.MathUtils.lerp(-0.14 * torsoW, 0.06 * torsoW, reachT),
              THREE.MathUtils.lerp(0.30, 0.39, reachT),
              THREE.MathUtils.lerp(-0.24, -0.34, reachT),
            );
          } else if (hProg < 0.72) {
            const pullT = smoothstep3P(0.34, 0.72, hProg);
            _gripL.set(
              THREE.MathUtils.lerp(0.06 * torsoW, -0.10 * torsoW, pullT),
              THREE.MathUtils.lerp(0.39, 0.37, pullT),
              -0.34,
            );
          } else {
            const tuckT = smoothstep3P(0.72, 1.0, hProg);
            _gripL.set(
              THREE.MathUtils.lerp(-0.10 * torsoW, -0.16 * torsoW, tuckT),
              THREE.MathUtils.lerp(0.37, 0.17, tuckT),
              THREE.MathUtils.lerp(-0.34, -0.12, tuckT),
            );
          }
        } else if (hAct === 'GRENADE_COOK') {
          _gripR.set(0.18 * torsoW, 0.48, -0.26);
          _gripL.set(-0.16 * torsoW, 0.38, -0.34);
          _poleR.set(shoulderX + 0.28, shoulderY - 0.16, 0.10);
        } else if (hAct === 'GRENADE_CHARGE') {
          if (isGrenadeOverhand) {
            _gripR.set(
              shoulderX + 0.08 + gCharge * 0.07,
              shoulderY + 0.12 + gCharge * 0.10,
              0.04 + gCharge * 0.14,
            );
            _gripL.set(-0.14 * torsoW, 0.42, -0.44 - gCharge * 0.06);
            _poleR.set(shoulderX + 0.34, shoulderY - 0.04, 0.24);
          } else {
            _gripR.set(
              shoulderX + 0.05,
              0.18 - gCharge * 0.08,
              -0.14 + gCharge * 0.12,
            );
            _gripL.set(-0.17 * torsoW, 0.34, -0.32);
            _poleR.set(shoulderX + 0.24, shoulderY - 0.36, 0.22);
          }
        } else if (hAct === 'GRENADE_THROW_OVERHAND') {
          const whip = smoothstep3P(0.0, 0.32, hProg);
          const rec = smoothstep3P(0.36, 1.0, hProg);
          _gripR.set(
            THREE.MathUtils.lerp(shoulderX + 0.13, 0.09 * torsoW, whip),
            THREE.MathUtils.lerp(shoulderY + 0.20, shoulderY + 0.02 - rec * 0.16, whip),
            THREE.MathUtils.lerp(0.16, -0.50 + rec * 0.22, whip),
          );
          _gripL.set(-0.18 * torsoW, 0.28, -0.14);
          _poleR.set(shoulderX + 0.32, shoulderY + 0.04 - whip * 0.22, 0.18 - whip * 0.18);
        } else {
          // GRENADE_THROW_UNDERHAND
          const whip = smoothstep3P(0.0, 0.30, hProg);
          const rec = smoothstep3P(0.36, 1.0, hProg);
          _gripR.set(
            THREE.MathUtils.lerp(shoulderX + 0.05, 0.10 * torsoW, whip),
            THREE.MathUtils.lerp(0.12, 0.40 - rec * 0.14, whip),
            THREE.MathUtils.lerp(0.04, -0.46 + rec * 0.18, whip),
          );
          _gripL.set(-0.16 * torsoW, 0.32, -0.26);
        }
      } else {
        weaponPivot.visible = !isUnarmedWeapon;
        grenadeHoldMount.visible = false;

        if (isUnarmedWeapon) {
          _gripR.set(shoulderX * 0.85, 0.28, -0.22);
          _gripL.set(-shoulderX * 0.85, 0.28, -0.22);
        } else {
          _gripR.copy(rightGripLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
          _sockTmp.copy(leftHandguardLocal);
          _sockTmp.z += pumpTravelZ;
          _gripL.copy(_sockTmp).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
        }

        // Replicate active firearm handling animations on 3P hands
        if (!isUnarmedWeapon && vaultW < 0.25) {
          if (hAct === 'RELOAD') {
            _handAuxL.copy(magWellLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
            if (hProg > 0.001) {
              if (hProg < 0.16) {
                _gripL.lerp(_handAuxL, smoothstep3P(0.0, 0.16, hProg));
              } else if (hProg < 0.38) {
                _gripL.copy(_handAuxL).lerp(_pouchLocal, smoothstep3P(0.16, 0.38, hProg));
              } else if (hProg < 0.48) {
                _gripL.copy(_pouchLocal);
              } else if (hProg < 0.66) {
                _gripL.copy(_pouchLocal).lerp(_handAuxL, smoothstep3P(0.48, 0.66, hProg));
              } else if (hProg < 0.86) {
                _sockTmp.copy(boltRackLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
                _gripL.copy(_handAuxL).lerp(_sockTmp, smoothstep3P(0.66, 0.76, hProg));
              } else {
                _sockTmp.copy(boltRackLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
                _gripL.lerp(_sockTmp, 1 - smoothstep3P(0.86, 1.0, hProg));
              }
            } else if (effReload > 0.005) {
              _reloadL.copy(_pouchLocal);
              _gripL.lerp(_reloadL, effReload);
            }
          } else if (hAct === 'SUPPRESSOR_DETACH') {
            _handAuxL.copy(suppGripLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
            if (hProg < 0.14) {
              _gripL.lerp(_handAuxL, smoothstep3P(0.0, 0.14, hProg));
            } else if (hProg < 0.72) {
              _gripL.copy(_handAuxL);
            } else if (hProg < 0.88) {
              _gripL.copy(_handAuxL).lerp(_pouchLocal, smoothstep3P(0.72, 0.88, hProg));
            } else {
              _gripL.lerp(_pouchLocal, 1 - smoothstep3P(0.88, 1.0, hProg));
            }
          } else if (hAct === 'SUPPRESSOR_ATTACH') {
            _handAuxL.copy(suppGripLocal).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
            if (hProg < 0.16) {
              _gripL.lerp(_pouchLocal, smoothstep3P(0.0, 0.16, hProg));
            } else if (hProg < 0.30) {
              _gripL.copy(_pouchLocal).lerp(_handAuxL, smoothstep3P(0.16, 0.30, hProg));
            } else if (hProg < 0.86) {
              _gripL.copy(_handAuxL);
            } else {
              _gripL.lerp(_handAuxL, 1 - smoothstep3P(0.86, 1.0, hProg));
            }
          } else if (hAct === 'BOLT') {
            const bEnv = smoothstep3P(0.0, 0.20, hProg) * (1 - smoothstep3P(0.80, 1.0, hProg));
            const bPull = Math.sin(smoothstep3P(0.20, 0.80, hProg) * Math.PI) * 0.065;
            _sockTmp.copy(boltHandleLocal);
            _sockTmp.z += bPull;
            _handAuxR.copy(_sockTmp).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
            _gripR.lerp(_handAuxR, bEnv);
          } else if (hAct === 'CHAMBER_CYCLE') {
            const cEnv = smoothstep3P(0.0, 0.20, hProg) * (1 - smoothstep3P(0.80, 1.0, hProg));
            const isBoltAction = Boolean(weaponAsm?.boltHandlePivot);
            const isPumpAction = Boolean(weaponAsm?.pumpForend);
            if (isBoltAction) {
              _sockTmp.copy(boltHandleLocal);
              _sockTmp.z += chamberRackTravel * 0.068;
              _handAuxR.copy(_sockTmp).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
              _gripR.lerp(_handAuxR, cEnv);
            } else if (!isPumpAction) {
              _sockTmp.copy(boltRackLocal);
              _sockTmp.z += chamberRackTravel * 0.062;
              _handAuxL.copy(_sockTmp).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
              _gripL.lerp(_handAuxL, cEnv);
            }
          } else if (
            hAct === 'ZOOM_TWIST' ||
            hAct === 'TURRET' ||
            hAct === 'ILLUM' ||
            hAct === 'LIGHT_PAD' ||
            hAct === 'SELECTOR' ||
            hAct === 'MAG_CHECK'
          ) {
            const mEnv = smoothstep3P(0.0, 0.25, hProg) * (1 - smoothstep3P(0.72, 1.0, hProg));
            const targetSock =
              hAct === 'ZOOM_TWIST'
                ? zoomRingLocal
                : hAct === 'TURRET'
                  ? turretLocal
                  : hAct === 'ILLUM'
                    ? illumLocal
                    : hAct === 'LIGHT_PAD'
                      ? padLocal
                      : hAct === 'SELECTOR'
                        ? selectorLocal
                        : magWellLocal;
            _handAuxL.copy(targetSock).applyQuaternion(weaponSocket.quaternion).add(weaponSocket.position);
            _gripL.lerp(_handAuxL, mEnv);
          } else if (
            hAct === 'DOOR_OPEN' ||
            hAct === 'DOOR_PEEK' ||
            hAct === 'DOOR_CLOSE_PUSH' ||
            hAct === 'DOOR_CLOSE_SOFT' ||
            hAct === 'PROP_INTERACT'
          ) {
            const reachEnv = smoothstep3P(0.0, 0.24, hProg) * (1 - smoothstep3P(0.72, 1.0, hProg));
            const forwardZ =
              hAct === 'DOOR_CLOSE_PUSH'
                ? -0.58 - Math.sin(smoothstep3P(0.18, 0.72, hProg) * Math.PI) * 0.16
                : -0.52;
            const targetY =
              hAct === 'DOOR_CLOSE_PUSH'
                ? 0.34
                : hAct === 'PROP_INTERACT'
                  ? 0.24
                  : 0.22; // Doorknob height relative to torso
            _handAuxL.set(-0.08 * torsoW, targetY, forwardZ);
            _gripL.lerp(_handAuxL, reachEnv);
          }
        }

        // Natural tactical elbow poles (down, slightly outward & back; shift with canted roll)
        _poleR.set(shoulderX + 0.22 + cantRollRad * 0.14, shoulderY - 0.36, 0.16);
        _poleL.set(-shoulderX - 0.16 - vaultW * 0.14, shoulderY - 0.38 - cantRollRad * 0.08 + vaultW * 0.18, 0.05 + vaultW * 0.12);
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
      headGroup.position.set(0, 0.555, 0);
      headGroup.rotation.set(0, 0, 0);
      neckSkin.position.set(0, 0.022, 0.004);
      neckSkin.rotation.set(0, 0, 0);
      neck.position.set(0, 0.02, 0.005);
      neck.rotation.set(0, 0, 0);

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

      weaponPivot.visible = !isUnarmedWeapon;
      grenadeHoldMount.visible = false;
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
      beltHitMeshes,
      applyUniform,
      applyCombatPose,
      resetRagdollPose,
      setBeltEquipment,
      setBackpack,
      setWeaponClass,
      setWeaponLoadout,
      setSuppressedVisual,
      disposeWeapon,
      setGearAppearance,
      setFactionArmband,
      setIrStrobe,
      setWarningLaser,
      headAssembly,
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

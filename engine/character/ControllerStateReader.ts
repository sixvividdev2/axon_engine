import * as THREE from 'three';
import { VaultStateSnapshot } from '../../bodycam-sdk/movement/VaultController';
import { BodycamController } from '../controller/BodycamController';
import { WeaponRig } from '../weapons/WeaponRig';

export interface CharacterDriverState {
  position: THREE.Vector3;
  torsoYaw: number;
  torsoPitch: number;
  spinePitch: number;
  aimYaw: number;
  aimPitch: number;
  lean: number;
  crouch: boolean;
  sprint: boolean;
  isAds: boolean;
  isCanted: boolean;
  isPointAim: boolean;
  isMoving: boolean;
  grounded: boolean;
  velY: number;
  stepSmoothOffsetY: number;
  landingKneeBend: number;
  landingCompression: number;
  stridePhase: number;
  wallPullback: number;
  recoilSpring: {
    z: number;
    pitch: number;
    roll: number;
  };
  chestHeight: number;
  cameraWorldPos: THREE.Vector3;
  cameraWorldQuat: THREE.Quaternion;
  vaultState: Readonly<VaultStateSnapshot>;
}

/**
 * Clean read-only state reader that extracts controller + weapon rig kinematics
 * for Survival's full-body procedural skeleton and 2-bone IK animator.
 */
export class ControllerStateReader {
  private readonly state: CharacterDriverState = {
    position: new THREE.Vector3(),
    torsoYaw: 0,
    torsoPitch: 0,
    spinePitch: 0,
    aimYaw: 0,
    aimPitch: 0,
    lean: 0,
    crouch: false,
    sprint: false,
    isAds: false,
    isCanted: false,
    isPointAim: false,
    isMoving: false,
    grounded: true,
    velY: 0,
    stepSmoothOffsetY: 0,
    landingKneeBend: 0,
    landingCompression: 0,
    stridePhase: 0,
    wallPullback: 0,
    recoilSpring: { z: 0, pitch: 0, roll: 0 },
    chestHeight: 1.42,
    cameraWorldPos: new THREE.Vector3(),
    cameraWorldQuat: new THREE.Quaternion(),
    vaultState: {
      active: false,
      kind: 'VAULT_OVER',
      mode: 'NONE',
      progress: 0,
      handPinWeightL: 0,
      handPinWeightR: 0,
      handLWorld: new THREE.Vector3(),
      handRWorld: new THREE.Vector3(),
      wallNormal: new THREE.Vector3(0, 0, 1),
      vaultForward: new THREE.Vector3(0, 0, -1),
      weaponRetentionMode: 'NONE',
      weaponRetentionBlend: 0,
      cameraPitchOffset: 0,
      cameraRollOffset: 0,
      cameraDipOffset: 0,
      crouchTransitionWeight: 0,
      legTuckWeight: 0,
      headDuckWeight: 0,
      maxCameraWorldY: Infinity,
    },
  };

  public read(
    controller: BodycamController,
    weaponRig: WeaponRig,
    camera: THREE.PerspectiveCamera,
  ): Readonly<CharacterDriverState> {
    const s = this.state;
    s.position.copy(controller.position);
    s.torsoYaw = controller.torsoYaw;
    s.torsoPitch = controller.torsoPitch;
    s.spinePitch = controller.getSpinePitch();
    s.crouch = controller.crouched;
    s.sprint = controller.isSprinting;
    s.isAds = controller.isAds;
    s.isCanted = controller.isCanted;
    s.isPointAim = controller.isPointAim;
    s.grounded = controller.grounded;
    s.velY = controller.getVerticalVelocity();
    s.stepSmoothOffsetY = controller.getStepSmoothOffsetY();
    s.landingKneeBend = controller.getLandingKneeBend();
    s.landingCompression = controller.getLandingCompression();
    s.vaultState = controller.getVaultState();

    const rigState = weaponRig.getReadOnlyRigState();
    s.aimYaw = rigState.aimYaw;
    s.aimPitch = rigState.aimPitch;
    s.isMoving = rigState.isMoving;
    s.stridePhase = rigState.strideProgress;
    s.wallPullback = rigState.pullbackRatio;
    s.recoilSpring.z = rigState.recoilZ;
    s.recoilSpring.pitch = rigState.recoilPitch;
    s.recoilSpring.roll = rigState.recoilRoll;

    // Derive exact lateral lean from chestCenter (weaponRig.root.position) relative to controller.position
    const rightX = Math.cos(controller.torsoYaw);
    const rightZ = -Math.sin(controller.torsoYaw);
    const dx = weaponRig.root.position.x - controller.position.x;
    const dz = weaponRig.root.position.z - controller.position.z;
    s.lean = dx * rightX + dz * rightZ;
    s.chestHeight = Math.max(0.28, weaponRig.root.position.y - (controller.position.y + s.stepSmoothOffsetY));

    s.cameraWorldPos.copy(camera.position);
    s.cameraWorldQuat.copy(camera.quaternion);

    return s;
  }
}

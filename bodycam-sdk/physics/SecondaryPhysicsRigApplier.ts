import * as THREE from 'three';
import { CharacterSkeleton } from '../CharacterSkeleton';
import {
  SECONDARY_CHANNEL_COUNT,
  SECONDARY_CHANNEL_NAMES,
  SecondaryPhysicsSolver,
} from './SecondaryPhysicsSolver';

export interface SecondaryExcitationInput {
  readonly dt: number;
  readonly rootWorldPos: Readonly<THREE.Vector3>;
  readonly rootWorldQuat: Readonly<THREE.Quaternion>;
  readonly speedMps: number;
  readonly stridePhase: number;
  readonly grounded: boolean;
  readonly recoilImpulse: number; // >= 0 scalar recoil kick from current frame
}

/**
 * Samples local-space torso/pelvis acceleration, gait stride impulses, landing shock,
 * and weapon recoil kick, steps the 120 Hz SecondaryPhysicsSolver, and applies strictly
 * clamped additive offsets exclusively to `sec_*` child nodes post-animation.
 * Zero heap allocations per frame.
 */
export class SecondaryPhysicsRigApplier {
  public readonly solver: SecondaryPhysicsSolver;
  private readonly nodes: THREE.Group[];
  private readonly restPositions: THREE.Vector3[];

  private initialized = false;
  private wasGrounded = true;
  private prevStrideSide = 1;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly currVel = new THREE.Vector3();
  private readonly worldAccel = new THREE.Vector3();
  private readonly localAccel = new THREE.Vector3();
  private readonly invQuat = new THREE.Quaternion();

  constructor(skeleton: CharacterSkeleton) {
    this.solver = new SecondaryPhysicsSolver(skeleton.operatorId);
    this.nodes = new Array<THREE.Group>(SECONDARY_CHANNEL_COUNT);
    this.restPositions = new Array<THREE.Vector3>(SECONDARY_CHANNEL_COUNT);

    for (let i = 0; i < SECONDARY_CHANNEL_COUNT; i++) {
      const name = SECONDARY_CHANNEL_NAMES[i];
      this.nodes[i] = skeleton.secondaryNodes[name];
      this.restPositions[i] = skeleton.secondaryRestPos[name];
    }
  }

  public setRagdollDecay(active: boolean): void {
    this.solver.setDecayMode(active);
  }

  public reset(): void {
    this.solver.reset();
    this.initialized = false;
    this.wasGrounded = true;
    this.prevVel.set(0, 0, 0);
    this.applyToNodes();
  }

  public update(input: SecondaryExcitationInput): void {
    const dt = input.dt > 0.05 ? 0.05 : input.dt < 1e-4 ? 1e-4 : input.dt;

    if (!this.initialized) {
      this.prevPos.copy(input.rootWorldPos);
      this.prevVel.set(0, 0, 0);
      this.wasGrounded = input.grounded;
      this.initialized = true;
      this.solver.step(dt);
      this.applyToNodes();
      return;
    }

    // 1. Compute world linear velocity & acceleration (clamped to reject teleports)
    this.currVel.subVectors(input.rootWorldPos, this.prevPos).divideScalar(dt);
    const speedSq = this.currVel.lengthSq();
    if (speedSq > 400) {
      // Teleport detected -> reset kinematic differentiator cleanly
      this.prevPos.copy(input.rootWorldPos);
      this.prevVel.set(0, 0, 0);
      this.solver.step(dt);
      this.applyToNodes();
      return;
    }

    this.worldAccel.subVectors(this.currVel, this.prevVel).divideScalar(dt);
    // Clamp acceleration spikes cleanly
    const accLen = this.worldAccel.length();
    if (accLen > 38) {
      this.worldAccel.multiplyScalar(38 / accLen);
    }

    // Convert world acceleration to operator local space (inertially opposite: -accel)
    this.invQuat.copy(input.rootWorldQuat).invert();
    this.localAccel.copy(this.worldAccel).applyQuaternion(this.invQuat).multiplyScalar(-0.42);

    // 2. Detect landing shock impulse
    if (!this.wasGrounded && input.grounded) {
      const impactSpeed = Math.min(8.5, Math.max(0, -this.prevVel.y));
      if (impactSpeed > 0.8) {
        const downImp = -Math.min(0.42, impactSpeed * 0.065);
        this.solver.addGlobalImpulse(0, downImp, 0.04);
      }
    }
    this.wasGrounded = input.grounded;

    // 3. Gait stride heel-strike impulse
    const strideSin = Math.sin(input.stridePhase);
    const strideSide = strideSin >= 0 ? 1 : -1;
    if (input.grounded && input.speedMps > 0.85 && strideSide !== this.prevStrideSide) {
      this.prevStrideSide = strideSide;
      const gaitScale = Math.min(1.0, input.speedMps / 4.6);
      const stepVert = -0.14 * gaitScale;
      const stepLat = strideSide * 0.05 * gaitScale;
      this.solver.addGlobalImpulse(stepLat, stepVert, 0.025 * gaitScale);
    }

    // 4. Weapon recoil kick impulse (+Z backward into shoulder/chest/arms)
    if (input.recoilImpulse > 1e-4) {
      const kick = Math.min(0.40, input.recoilImpulse * 0.28);
      this.solver.addGlobalImpulse(0, -kick * 0.25, kick);
    }

    // 5. Feed continuous local inertial acceleration into all enabled channels
    const ax = this.localAccel.x;
    const ay = this.localAccel.y;
    const az = this.localAccel.z;
    for (let ch = 0; ch < SECONDARY_CHANNEL_COUNT; ch++) {
      this.solver.setChannelAcceleration(ch, ax, ay, az);
    }

    this.prevPos.copy(input.rootWorldPos);
    this.prevVel.copy(this.currVel);

    // 6. Step fixed-step 120 Hz SoA solver and apply clamped additive offsets strictly to sec_* nodes
    this.solver.step(dt);
    this.applyToNodes();
  }

  public applyToNodes(): void {
    const pos = this.solver.pos;
    const rx = this.solver.rotX;
    const ry = this.solver.rotY;
    const rz = this.solver.rotZ;

    for (let ch = 0; ch < SECONDARY_CHANNEL_COUNT; ch++) {
      const node = this.nodes[ch];
      const rest = this.restPositions[ch];
      const base = ch * 3;
      node.position.set(
        rest.x + pos[base],
        rest.y + pos[base + 1],
        rest.z + pos[base + 2],
      );
      node.rotation.set(rx[ch], ry[ch], rz[ch]);
    }
  }
}

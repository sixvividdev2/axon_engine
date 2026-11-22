import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../BodycamPhysics';
import { CharacterSkeleton } from '../CharacterSkeleton';
import { orientLimbAlongYInRootSpace, setTransformInRootSpace } from '../IKSolver';
import { RAGDOLL_NODE_NAMES, RagdollNodeName } from '../operator/OperatorTypes';

export const RAGDOLL_FIXED_DT = 1 / 120;
export const RAGDOLL_MAX_SUBSTEPS = 4;
export const RAGDOLL_NODE_COUNT = 15; // Exact 15 anatomical nodes from RAGDOLL_NODE_NAMES

// Node index constants matching RAGDOLL_NODE_NAMES order
export const RD_PELVIS = 0;
export const RD_ABDOMEN = 1;
export const RD_CHEST = 2;
export const RD_NECK = 3;
export const RD_HEAD = 4;
export const RD_UPPERARM_L = 5;
export const RD_FOREARM_L = 6;
export const RD_UPPERARM_R = 7;
export const RD_FOREARM_R = 8;
export const RD_THIGH_L = 9;
export const RD_CALF_L = 10;
export const RD_FOOT_L = 11;
export const RD_THIGH_R = 12;
export const RD_CALF_R = 13;
export const RD_FOOT_R = 14;

const NODE_RADII = new Float32Array([
  0.145, // pelvis
  0.130, // abdomen
  0.150, // chest
  0.065, // neck
  0.115, // head
  0.060, // upperarm_l
  0.050, // forearm_l
  0.060, // upperarm_r
  0.050, // forearm_r
  0.080, // thigh_l
  0.062, // calf_l
  0.055, // foot_l
  0.080, // thigh_r
  0.062, // calf_r
  0.055, // foot_r
]);

const NODE_INV_MASS = new Float32Array([
  1 / 14.0, // pelvis
  1 / 11.0, // abdomen
  1 / 16.0, // chest
  1 / 2.2, // neck
  1 / 5.2, // head
  1 / 2.6, // upperarm_l
  1 / 1.9, // forearm_l
  1 / 2.6, // upperarm_r
  1 / 1.9, // forearm_r
  1 / 8.5, // thigh_l
  1 / 4.2, // calf_l
  1 / 1.6, // foot_l
  1 / 8.5, // thigh_r
  1 / 4.2, // calf_r
  1 / 1.6, // foot_r
]);

// Structural bone-length distance constraints (parent -> child)
const BONE_EDGES: ReadonlyArray<readonly [number, number]> = [
  [RD_PELVIS, RD_ABDOMEN],
  [RD_ABDOMEN, RD_CHEST],
  [RD_CHEST, RD_NECK],
  [RD_NECK, RD_HEAD],
  [RD_CHEST, RD_UPPERARM_L],
  [RD_UPPERARM_L, RD_FOREARM_L],
  [RD_CHEST, RD_UPPERARM_R],
  [RD_UPPERARM_R, RD_FOREARM_R],
  [RD_PELVIS, RD_THIGH_L],
  [RD_THIGH_L, RD_CALF_L],
  [RD_CALF_L, RD_FOOT_L],
  [RD_PELVIS, RD_THIGH_R],
  [RD_THIGH_R, RD_CALF_R],
  [RD_CALF_R, RD_FOOT_R],
];

// Minimum-separation angular cone/hinge limit constraints preventing unnatural joint folding
const ANGULAR_MIN_EDGES: ReadonlyArray<readonly [number, number, number]> = [
  [RD_PELVIS, RD_CHEST, 0.24],
  [RD_ABDOMEN, RD_HEAD, 0.34],
  [RD_CHEST, RD_HEAD, 0.19],
  [RD_UPPERARM_L, RD_UPPERARM_R, 0.26],
  [RD_THIGH_L, RD_THIGH_R, 0.16],
  [RD_PELVIS, RD_CALF_L, 0.24],
  [RD_PELVIS, RD_CALF_R, 0.24],
  [RD_THIGH_L, RD_FOOT_L, 0.20],
  [RD_THIGH_R, RD_FOOT_R, 0.20],
  [RD_CHEST, RD_FOREARM_L, 0.16],
  [RD_CHEST, RD_FOREARM_R, 0.16],
];

const HIT_ZONE_TO_NODE: Readonly<Record<string, number>> = {
  hz_pelvis: RD_PELVIS,
  hz_abdomen: RD_ABDOMEN,
  hz_chest: RD_CHEST,
  hz_neck: RD_NECK,
  hz_head: RD_HEAD,
  hz_upperarm_l: RD_UPPERARM_L,
  hz_forearm_l: RD_FOREARM_L,
  hz_hand_l: RD_FOREARM_L,
  hz_upperarm_r: RD_UPPERARM_R,
  hz_forearm_r: RD_FOREARM_R,
  hz_hand_r: RD_FOREARM_R,
  hz_thigh_l: RD_THIGH_L,
  hz_calf_l: RD_CALF_L,
  hz_foot_l: RD_FOOT_L,
  hz_thigh_r: RD_THIGH_R,
  hz_calf_r: RD_CALF_R,
  hz_foot_r: RD_FOOT_R,
  // Legacy generic combat hit zones
  head: RD_HEAD,
  thorax: RD_CHEST,
  torso: RD_CHEST,
  chest: RD_CHEST,
  leftArm: RD_UPPERARM_L,
  rightArm: RD_UPPERARM_R,
  leftLeg: RD_THIGH_L,
  rightLeg: RD_THIGH_R,
  limb: RD_THIGH_L,
};

/**
 * Custom Zero-Dependency 15-Node Articulated XPBD/Verlet Ragdoll Solver.
 * - Fixed-step `120 Hz` (`MAX_SUBSTEPS = 4`), zero per-step heap allocations
 * - Exact frame-0 pose handoff (`< 2.0 mm` / `< 0.5°`) from live `CharacterSkeleton` or `TacticalOperatorRig`
 * - Collides directly against `BodycamPhysicsWorld` (`boxes`, `ramps`, `getGroundHeight`, `terrainHeightAt`)
 * - Enforces bone-length distance constraints, angular cone/hinge folding limits, surface friction, and sleep damping
 */
export class ArticulatedRagdoll {
  public readonly pos = new Float32Array(RAGDOLL_NODE_COUNT * 3);
  public readonly prevPos = new Float32Array(RAGDOLL_NODE_COUNT * 3);
  public readonly restLen = new Float32Array(BONE_EDGES.length);

  private active = false;
  private sleeping = false;
  private sleepTimer = 0;
  private accumulator = 0;
  private elapsedSec = 0;

  // Scratch vectors for zero-GC skeleton sync
  private readonly _vA = new THREE.Vector3();
  private readonly _vB = new THREE.Vector3();
  private readonly _vC = new THREE.Vector3();
  private readonly _vD = new THREE.Vector3();
  private readonly _vE = new THREE.Vector3();
  private readonly _axisX = new THREE.Vector3();
  private readonly _axisY = new THREE.Vector3();
  private readonly _axisZ = new THREE.Vector3();
  private readonly _mat = new THREE.Matrix4();
  private readonly _quat = new THREE.Quaternion();
  private readonly _invRootMat = new THREE.Matrix4();

  public isActive(): boolean {
    return this.active;
  }

  public isSleeping(): boolean {
    return this.sleeping;
  }

  public deactivate(): void {
    this.active = false;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.accumulator = 0;
    this.elapsedSec = 0;
  }

  /**
   * Captures exact frame-0 world positions of all 15 canonical `hz_*` nodes from a live `CharacterSkeleton`
   * and records their current bone lengths so frame-0 handoff error is `< 0.01 mm` (`<< 2.0 mm`).
   */
  public initializeFromSkeleton(
    skeleton: CharacterSkeleton,
    initialLinearVelocity?: Readonly<THREE.Vector3>,
  ): void {
    skeleton.root.updateMatrixWorld(true);
    const vx = initialLinearVelocity ? initialLinearVelocity.x : 0;
    const vy = initialLinearVelocity ? initialLinearVelocity.y : 0;
    const vz = initialLinearVelocity ? initialLinearVelocity.z : 0;
    const h = RAGDOLL_FIXED_DT;

    for (let i = 0; i < RAGDOLL_NODE_COUNT; i++) {
      const name: RagdollNodeName = RAGDOLL_NODE_NAMES[i];
      const hzNode = skeleton.hitZones[name];
      hzNode.getWorldPosition(this._vA);
      const o = i * 3;
      this.pos[o] = this._vA.x;
      this.pos[o + 1] = this._vA.y;
      this.pos[o + 2] = this._vA.z;
      this.prevPos[o] = this._vA.x - vx * h;
      this.prevPos[o + 1] = this._vA.y - vy * h;
      this.prevPos[o + 2] = this._vA.z - vz * h;
    }

    this.captureRestBoneLengths();
    this.active = true;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.accumulator = 0;
    this.elapsedSec = 0;
  }

  /**
   * Captures exact frame-0 pose from a world-space standing position + yaw (used for Battle bots).
   */
  public initializeFromStandingPose(
    worldPos: Readonly<THREE.Vector3>,
    yawRad: number,
    initialLinearVelocity?: Readonly<THREE.Vector3>,
  ): void {
    const cosY = Math.cos(yawRad);
    const sinY = Math.sin(yawRad);
    const vx = initialLinearVelocity ? initialLinearVelocity.x : 0;
    const vy = initialLinearVelocity ? initialLinearVelocity.y : 0;
    const vz = initialLinearVelocity ? initialLinearVelocity.z : 0;
    const h = RAGDOLL_FIXED_DT;

    // Canonical local offsets matching TacticalOperatorRig proportions (facing -Z at yaw = 0)
    const offsets: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0.90, 0], // pelvis
      [0, 1.04, 0], // abdomen
      [0, 1.28, 0], // chest
      [0, 1.44, 0.01], // neck
      [0, 1.58, 0], // head
      [-0.22, 1.24, -0.04], // upperarm_l
      [-0.20, 1.00, -0.18], // forearm_l
      [0.22, 1.24, -0.04], // upperarm_r
      [0.20, 1.00, -0.18], // forearm_r
      [-0.10, 0.68, 0], // thigh_l
      [-0.10, 0.34, 0.01], // calf_l
      [-0.10, 0.07, -0.04], // foot_l
      [0.10, 0.68, 0], // thigh_r
      [0.10, 0.34, 0.01], // calf_r
      [0.10, 0.07, -0.04], // foot_r
    ];

    for (let i = 0; i < RAGDOLL_NODE_COUNT; i++) {
      const lx = offsets[i][0];
      const ly = offsets[i][1];
      const lz = offsets[i][2];
      const wx = worldPos.x + lx * cosY + lz * sinY;
      const wy = worldPos.y + ly;
      const wz = worldPos.z - lx * sinY + lz * cosY;
      const o = i * 3;
      this.pos[o] = wx;
      this.pos[o + 1] = wy;
      this.pos[o + 2] = wz;
      this.prevPos[o] = wx - vx * h;
      this.prevPos[o + 1] = wy - vy * h;
      this.prevPos[o + 2] = wz - vz * h;
    }

    this.captureRestBoneLengths();
    this.active = true;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.accumulator = 0;
    this.elapsedSec = 0;
  }

  private captureRestBoneLengths(): void {
    const p = this.pos;
    for (let e = 0; e < BONE_EDGES.length; e++) {
      const a = BONE_EDGES[e][0] * 3;
      const b = BONE_EDGES[e][1] * 3;
      const dx = p[b] - p[a];
      const dy = p[b + 1] - p[a + 1];
      const dz = p[b + 2] - p[a + 2];
      this.restLen[e] = Math.max(0.05, Math.hypot(dx, dy, dz));
    }
  }

  /**
   * Applies a directional bullet or blast impulse (N·s) to the targeted anatomical hit zone
   * and distributes damped sympathetic recoil to adjacent nodes.
   */
  public applyHitZoneImpulse(
    hitZone: string,
    impulseDir: Readonly<THREE.Vector3>,
    impulseMagnitudeNs: number,
  ): void {
    if (!this.active) return;
    this.sleeping = false;
    this.sleepTimer = 0;

    const primaryIdx = HIT_ZONE_TO_NODE[hitZone] ?? RD_CHEST;
    const mag = Math.min(280, Math.max(0, impulseMagnitudeNs));
    const len = impulseDir.length();
    if (len < 1e-5 || mag < 1e-4) return;
    const dx = impulseDir.x / len;
    const dy = impulseDir.y / len;
    const dz = impulseDir.z / len;
    const h = RAGDOLL_FIXED_DT;

    // Primary node velocity delta: dv = J * invMass
    const dvPrimary = Math.min(9.5, mag * NODE_INV_MASS[primaryIdx]);
    const po = primaryIdx * 3;
    this.prevPos[po] -= dx * dvPrimary * h;
    this.prevPos[po + 1] -= dy * dvPrimary * h;
    this.prevPos[po + 2] -= dz * dvPrimary * h;

    // Distribute 28% transfer into pelvis/chest core so body collapses realistically in shot direction
    const coreIdx = primaryIdx === RD_CHEST ? RD_PELVIS : RD_CHEST;
    const dvCore = Math.min(4.8, mag * 0.28 * NODE_INV_MASS[coreIdx]);
    const co = coreIdx * 3;
    this.prevPos[co] -= dx * dvCore * h;
    this.prevPos[co + 1] -= dy * dvCore * h;
    this.prevPos[co + 2] -= dz * dvCore * h;
  }

  public getNodeWorldPosition(nodeIndex: number, out: THREE.Vector3): THREE.Vector3 {
    const o = nodeIndex * 3;
    return out.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
  }

  public getNodePosition(nodeIndex: number, out: THREE.Vector3): THREE.Vector3 {
    return this.getNodeWorldPosition(nodeIndex, out);
  }

  /**
   * Advances the 15-node XPBD/Verlet ragdoll at fixed 120 Hz against `BodycamPhysicsWorld`.
   * Zero heap allocations per step.
   */
  public step(
    rawDt: number,
    world: BodycamPhysicsWorld,
    terrainHeightAt?: (x: number, z: number) => number,
  ): number {
    if (!this.active || this.sleeping) return 0;

    const dt = rawDt > 0.05 ? 0.05 : rawDt < 0 ? 0 : rawDt;
    this.accumulator += dt;
    this.elapsedSec += dt;

    let substeps = 0;
    const h = RAGDOLL_FIXED_DT;
    const gStep = -9.81 * h * h;
    const p = this.pos;
    const pp = this.prevPos;

    while (this.accumulator >= h && substeps < RAGDOLL_MAX_SUBSTEPS) {
      this.accumulator -= h;
      substeps++;

      // 1. Verlet integration with mild aerodynamic drag
      const drag = 0.9965;
      for (let i = 0; i < RAGDOLL_NODE_COUNT; i++) {
        const o = i * 3;
        const x = p[o];
        const y = p[o + 1];
        const z = p[o + 2];
        const vx = (x - pp[o]) * drag;
        const vy = (y - pp[o + 1]) * drag;
        const vz = (z - pp[o + 2]) * drag;

        pp[o] = x;
        pp[o + 1] = y;
        pp[o + 2] = z;

        p[o] = x + vx;
        p[o + 1] = y + vy + gStep;
        p[o + 2] = z + vz;
      }

      // 2. XPBD Constraint Projection (4 solver iterations per 120 Hz substep)
      for (let iter = 0; iter < 4; iter++) {
        // 2a. Exact bone-length distance constraints
        for (let e = 0; e < BONE_EDGES.length; e++) {
          const iA = BONE_EDGES[e][0];
          const iB = BONE_EDGES[e][1];
          const oA = iA * 3;
          const oB = iB * 3;

          const dx = p[oB] - p[oA];
          const dy = p[oB + 1] - p[oA + 1];
          const dz = p[oB + 2] - p[oA + 2];
          const d = Math.hypot(dx, dy, dz);
          if (d < 1e-5) continue;

          const err = d - this.restLen[e];
          const wA = NODE_INV_MASS[iA];
          const wB = NODE_INV_MASS[iB];
          const wSum = wA + wB;
          if (wSum <= 0) continue;

          const corr = err / (d * wSum);
          p[oA] += dx * corr * wA;
          p[oA + 1] += dy * corr * wA;
          p[oA + 2] += dz * corr * wA;
          p[oB] -= dx * corr * wB;
          p[oB + 1] -= dy * corr * wB;
          p[oB + 2] -= dz * corr * wB;
        }

        // 2b. Angular cone / hinge anti-folding minimum-separation constraints
        for (let a = 0; a < ANGULAR_MIN_EDGES.length; a++) {
          const iA = ANGULAR_MIN_EDGES[a][0];
          const iB = ANGULAR_MIN_EDGES[a][1];
          const minD = ANGULAR_MIN_EDGES[a][2];
          const oA = iA * 3;
          const oB = iB * 3;

          const dx = p[oB] - p[oA];
          const dy = p[oB + 1] - p[oA + 1];
          const dz = p[oB + 2] - p[oA + 2];
          const d = Math.hypot(dx, dy, dz);
          if (d >= minD || d < 1e-5) continue;

          const wA = NODE_INV_MASS[iA];
          const wB = NODE_INV_MASS[iB];
          const wSum = wA + wB;
          const push = ((minD - d) * 0.55) / (d * wSum);
          p[oA] -= dx * push * wA;
          p[oA + 1] -= dy * push * wA;
          p[oA + 2] -= dz * push * wA;
          p[oB] += dx * push * wB;
          p[oB + 1] += dy * push * wB;
          p[oB + 2] += dz * push * wB;
        }

        // 2c. Direct BodycamPhysicsWorld Collisions (floors, ramps, stairs, walls, cover boxes)
        this.resolveWorldCollisions(world, terrainHeightAt);
      }
    }

    // 3. Sleep detection once kinetic motion settles
    let maxStepDispSq = 0;
    for (let i = 0; i < RAGDOLL_NODE_COUNT; i++) {
      const o = i * 3;
      const dx = p[o] - pp[o];
      const dy = p[o + 1] - pp[o + 1];
      const dz = p[o + 2] - pp[o + 2];
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > maxStepDispSq) maxStepDispSq = dSq;
    }

    // 0.04 m/s threshold at 120 Hz => stepDisp ~ 3.3e-4 m
    if (this.elapsedSec > 0.65 && maxStepDispSq < 1.8e-7) {
      this.sleepTimer += dt;
      if (this.sleepTimer >= 0.45) {
        this.sleeping = true;
      }
    } else {
      this.sleepTimer = 0;
    }

    return substeps;
  }

  private resolveWorldCollisions(
    world: BodycamPhysicsWorld,
    terrainHeightAt?: (x: number, z: number) => number,
  ): void {
    const p = this.pos;
    const pp = this.prevPos;
    const boxes = world.boxes;
    const ramps = world.ramps;
    const minXBound = world.boundsMinX + 0.15;
    const maxXBound = world.boundsMaxX - 0.15;
    const minZBound = world.boundsMinZ + 0.15;
    const maxZBound = world.boundsMaxZ - 0.15;

    for (let i = 0; i < RAGDOLL_NODE_COUNT; i++) {
      const o = i * 3;
      const r = NODE_RADII[i];
      let x = p[o];
      let y = p[o + 1];
      let z = p[o + 2];
      let collided = false;

      // World arena boundary clamps
      if (x < minXBound) {
        x = minXBound;
        collided = true;
      } else if (x > maxXBound) {
        x = maxXBound;
        collided = true;
      }
      if (z < minZBound) {
        z = minZBound;
        collided = true;
      } else if (z > maxZBound) {
        z = maxZBound;
        collided = true;
      }

      // Base terrain / floor surface
      let floorY = world.baseFloorY;
      if (terrainHeightAt) {
        const ty = terrainHeightAt(x, z);
        if (ty > floorY) floorY = ty;
      }

      // Ramp surface evaluation (exact PhysicsRampCollider schema)
      for (let ri = 0; ri < ramps.length; ri++) {
        const ramp = ramps[ri];
        if (x >= ramp.minX && x <= ramp.maxX && z >= ramp.minZ && z <= ramp.maxZ) {
          let t = 0;
          if (ramp.riseAxis === '+x') {
            t = (x - ramp.minX) / Math.max(1e-4, ramp.maxX - ramp.minX);
          } else if (ramp.riseAxis === '-x') {
            t = (ramp.maxX - x) / Math.max(1e-4, ramp.maxX - ramp.minX);
          } else if (ramp.riseAxis === '+z') {
            t = (z - ramp.minZ) / Math.max(1e-4, ramp.maxZ - ramp.minZ);
          } else {
            t = (ramp.maxZ - z) / Math.max(1e-4, ramp.maxZ - ramp.minZ);
          }
          const clampedT = t < 0 ? 0 : t > 1 ? 1 : t;
          const rampY = ramp.baseY + (ramp.topY - ramp.baseY) * clampedT;
          if (rampY <= y + 0.45 && rampY > floorY) {
            floorY = rampY;
          }
        }
      }

      // AABB boxes (walls, cover crates, stair steps, balconies)
      for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi];
        if (b.blocksMovement === false) continue;

        // Closest point on AABB to sphere center
        const cx = x < b.minX ? b.minX : x > b.maxX ? b.maxX : x;
        const cy = y < b.minY ? b.minY : y > b.maxY ? b.maxY : y;
        const cz = z < b.minZ ? b.minZ : z > b.maxZ ? b.maxZ : z;

        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const dSq = dx * dx + dy * dy + dz * dz;

        if (dSq < r * r) {
          if (dSq > 1e-8) {
            const d = Math.sqrt(dSq);
            const pen = r - d;
            x += (dx / d) * pen;
            y += (dy / d) * pen;
            z += (dz / d) * pen;
          } else {
            // Sphere center inside box — push out along shallowest axis (prefer +Y for stair tops)
            const penTop = b.maxY + r - y;
            const penMinX = x - (b.minX - r);
            const penMaxX = b.maxX + r - x;
            const penMinZ = z - (b.minZ - r);
            const penMaxZ = b.maxZ + r - z;
            const minSide = Math.min(penMinX, penMaxX, penMinZ, penMaxZ);
            if (penTop <= minSide + 0.08) {
              y = b.maxY + r;
            } else if (minSide === penMinX) {
              x = b.minX - r;
            } else if (minSide === penMaxX) {
              x = b.maxX + r;
            } else if (minSide === penMinZ) {
              z = b.minZ - r;
            } else {
              z = b.maxZ + r;
            }
          }
          collided = true;
        }
      }

      if (y < floorY + r) {
        y = floorY + r;
        collided = true;
      }

      p[o] = x;
      p[o + 1] = y;
      p[o + 2] = z;

      // Apply tangential contact friction to dampen sliding on floors, stairs & ramps
      if (collided) {
        const friction = 0.72;
        pp[o] = x - (x - pp[o]) * friction;
        pp[o + 1] = y - (y - pp[o + 1]) * 0.45;
        pp[o + 2] = z - (z - pp[o + 2]) * friction;
      }
    }
  }

  /**
   * Writes solved 15-node ragdoll transforms cleanly back into a `CharacterSkeleton`.
   * Zero heap allocations.
   */
  public syncToSkeleton(skeleton: CharacterSkeleton): void {
    if (!this.active) return;

    const pPelvis = this.getNodeWorldPosition(RD_PELVIS, this._vA);
    const pChest = this.getNodeWorldPosition(RD_CHEST, this._vB);
    const pHead = this.getNodeWorldPosition(RD_HEAD, this._vC);
    const pThighL = this.getNodeWorldPosition(RD_THIGH_L, this._vD);
    const pThighR = this.getNodeWorldPosition(RD_THIGH_R, this._vE);

    // Position skeleton root at ground beneath pelvis with identity rotation so root-space == world-offset
    skeleton.root.position.set(pPelvis.x, 0, pPelvis.z);
    skeleton.root.rotation.set(0, 0, 0);
    skeleton.root.updateMatrixWorld(true);
    this._invRootMat.copy(skeleton.root.matrixWorld).invert();

    // Build orthonormal torso basis from pelvis->chest (+Y) and hipL->hipR (+X)
    this._axisY.subVectors(pChest, pPelvis);
    if (this._axisY.lengthSq() < 1e-5) this._axisY.set(0, 1, 0);
    else this._axisY.normalize();

    this._axisX.subVectors(pThighR, pThighL);
    this._axisX.addScaledVector(this._axisY, -this._axisX.dot(this._axisY));
    if (this._axisX.lengthSq() < 1e-5) this._axisX.set(1, 0, 0);
    else this._axisX.normalize();

    this._axisZ.crossVectors(this._axisX, this._axisY).normalize();
    this._axisX.crossVectors(this._axisY, this._axisZ).normalize();
    this._mat.makeBasis(this._axisX, this._axisY, this._axisZ);
    this._quat.setFromRotationMatrix(this._mat);

    skeleton.pelvis.position.set(0, pPelvis.y, 0);
    skeleton.pelvis.quaternion.copy(this._quat);
    skeleton.spineLower.rotation.set(0, 0, 0);
    skeleton.spineUpper.rotation.set(0, 0, 0);
    skeleton.chest.rotation.set(0, 0, 0);
    skeleton.neck.rotation.set(0, 0, 0);
    skeleton.headGroup.rotation.set(0, 0, 0);
    skeleton.root.updateMatrixWorld(true);

    // Orient limbs using root-space helper
    const toRoot = (idx: number, out: THREE.Vector3): THREE.Vector3 => {
      this.getNodeWorldPosition(idx, out).applyMatrix4(this._invRootMat);
      return out;
    };

    const poleHint = this._vE.set(0, 0.5, 0.5);

    // Left Arm
    const shL = this._vA;
    skeleton.leftArm.shoulderPivot.getWorldPosition(shL).applyMatrix4(this._invRootMat);
    const elL = toRoot(RD_UPPERARM_L, this._vB);
    const wrL = toRoot(RD_FOREARM_L, this._vC);
    orientLimbAlongYInRootSpace(skeleton.leftArm.upperArm, skeleton.root, shL, elL, poleHint);
    orientLimbAlongYInRootSpace(skeleton.leftArm.forearm, skeleton.root, elL, wrL, poleHint);

    // Right Arm
    const shR = this._vA;
    skeleton.rightArm.shoulderPivot.getWorldPosition(shR).applyMatrix4(this._invRootMat);
    const elR = toRoot(RD_UPPERARM_R, this._vB);
    const wrR = toRoot(RD_FOREARM_R, this._vC);
    orientLimbAlongYInRootSpace(skeleton.rightArm.upperArm, skeleton.root, shR, elR, poleHint);
    orientLimbAlongYInRootSpace(skeleton.rightArm.forearm, skeleton.root, elR, wrR, poleHint);

    // Left Leg
    const hipL = this._vA;
    skeleton.leftLeg.hipPivot.getWorldPosition(hipL).applyMatrix4(this._invRootMat);
    const kneeL = toRoot(RD_CALF_L, this._vB);
    const footL = toRoot(RD_FOOT_L, this._vC);
    orientLimbAlongYInRootSpace(skeleton.leftLeg.thigh, skeleton.root, hipL, kneeL, poleHint);
    orientLimbAlongYInRootSpace(skeleton.leftLeg.shin, skeleton.root, kneeL, footL, poleHint);

    // Right Leg
    const hipR = this._vA;
    skeleton.rightLeg.hipPivot.getWorldPosition(hipR).applyMatrix4(this._invRootMat);
    const kneeR = toRoot(RD_CALF_R, this._vB);
    const footR = toRoot(RD_FOOT_R, this._vC);
    orientLimbAlongYInRootSpace(skeleton.rightLeg.thigh, skeleton.root, hipR, kneeR, poleHint);
    orientLimbAlongYInRootSpace(skeleton.rightLeg.shin, skeleton.root, kneeR, footR, poleHint);

    // Head subtle follow toward solved head node
    const neckRoot = toRoot(RD_NECK, this._vA);
    setTransformInRootSpace(skeleton.headGroup, skeleton.root, neckRoot, this._quat);
  }

  /**
   * Writes solved ragdoll body center & orientation back to a BattleBot `root` + `bodyPivot` + limbs
   * so eliminated bots collapse physically down stairs, ramps, and cover without clipping floors.
   */
  public syncToBotRig(
    botRoot: THREE.Group,
    bodyPivot: THREE.Group,
    leftLeg: THREE.Group,
    rightLeg: THREE.Group,
    leftArm: THREE.Group,
    rightArm: THREE.Group,
  ): void {
    if (!this.active) return;

    const pPelvis = this.getNodeWorldPosition(RD_PELVIS, this._vA);
    const pChest = this.getNodeWorldPosition(RD_CHEST, this._vB);
    const pThighL = this.getNodeWorldPosition(RD_THIGH_L, this._vD);
    const pThighR = this.getNodeWorldPosition(RD_THIGH_R, this._vE);

    // Torso orthonormal frame
    this._axisY.subVectors(pChest, pPelvis);
    if (this._axisY.lengthSq() < 1e-5) this._axisY.set(0, 1, 0);
    else this._axisY.normalize();

    this._axisX.subVectors(pThighR, pThighL);
    this._axisX.addScaledVector(this._axisY, -this._axisX.dot(this._axisY));
    if (this._axisX.lengthSq() < 1e-5) this._axisX.set(1, 0, 0);
    else this._axisX.normalize();

    this._axisZ.crossVectors(this._axisX, this._axisY).normalize();
    this._axisX.crossVectors(this._axisY, this._axisZ).normalize();
    this._mat.makeBasis(this._axisX, this._axisY, this._axisZ);
    this._quat.setFromRotationMatrix(this._mat);

    // TacticalOperatorRig has pelvis at y ~ 0.90 inside bodyPivot
    botRoot.position.copy(pPelvis);
    botRoot.quaternion.copy(this._quat);
    bodyPivot.position.set(0, -0.90, 0);
    bodyPivot.rotation.set(0, 0, 0);

    // Approximate natural splayed limb angles relative to torso from solved knee/elbow offsets
    const pFootL = this.getNodeWorldPosition(RD_FOOT_L, this._vC);
    const pFootR = this.getNodeWorldPosition(RD_FOOT_R, this._vD);
    this._quat.invert();

    pFootL.sub(pPelvis).applyQuaternion(this._quat);
    pFootR.sub(pPelvis).applyQuaternion(this._quat);
    leftLeg.rotation.set(
      THREE.MathUtils.clamp(Math.atan2(-pFootL.z, Math.max(0.15, -pFootL.y)) * 0.75, -1.1, 1.1),
      0,
      THREE.MathUtils.clamp(Math.atan2(-pFootL.x, Math.max(0.2, -pFootL.y)) * 0.45, -0.45, 0.45),
    );
    rightLeg.rotation.set(
      THREE.MathUtils.clamp(Math.atan2(-pFootR.z, Math.max(0.15, -pFootR.y)) * 0.75, -1.1, 1.1),
      0,
      THREE.MathUtils.clamp(Math.atan2(pFootR.x, Math.max(0.2, -pFootR.y)) * 0.45, -0.45, 0.45),
    );

    const pArmL = this.getNodeWorldPosition(RD_FOREARM_L, this._vC).sub(pChest).applyQuaternion(this._quat);
    const pArmR = this.getNodeWorldPosition(RD_FOREARM_R, this._vD).sub(pChest).applyQuaternion(this._quat);
    leftArm.rotation.set(
      THREE.MathUtils.clamp(Math.atan2(-pArmL.z, Math.max(0.15, -pArmL.y)), -1.4, 1.4),
      0,
      THREE.MathUtils.clamp(-0.35 + pArmL.x * 1.4, -1.2, 0.4),
    );
    rightArm.rotation.set(
      THREE.MathUtils.clamp(Math.atan2(-pArmR.z, Math.max(0.15, -pArmR.y)), -1.4, 1.4),
      0,
      THREE.MathUtils.clamp(0.35 + pArmR.x * 1.4, -0.4, 1.2),
    );
  }
}

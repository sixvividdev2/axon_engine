import * as THREE from 'three';
import {
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  IBodycamWorldAdapter,
} from './types';

export interface PhysicsBoxCollider {
  id?: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  surface?: BodycamSurfaceMaterial;
  blocksMovement?: boolean;
  /** When true, this box participates in fast spatial-grid analytical raycasting */
  blocksRaycast?: boolean;
  /** Optional visual mesh reference returned in BodycamRaycastResult.object for decals/material tags */
  meshRef?: THREE.Object3D | null;
}

/**
 * Dynamic oriented 2D slab collider (used for rotating physical hinged doors).
 * Supports real-time angle updates and capsule push-nudge torque callbacks with zero GC.
 */
export interface PhysicsDynamicSlab {
  id: string;
  originX: number;
  originZ: number;
  minY: number;
  maxY: number;
  /** Unit direction vector in XZ from hinge origin toward latch edge */
  dirX: number;
  dirZ: number;
  length: number;
  halfThickness: number;
  active: boolean;
  /** When false (unlatched open door), capsule pushing nudges the door softly while resolving overlap */
  rigidBlocked?: boolean;
  onCapsulePush?: (
    contactDistAlongSlab: number,
    pushNormalX: number,
    pushNormalZ: number,
    penetration: number,
    moveDeltaX: number,
    moveDeltaZ: number,
  ) => void;
}

/**
 * Axis-aligned walkable sloped ramp collider.
 * Slope rises linearly from baseY to topY along `riseAxis`.
 */
export interface PhysicsRampCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  baseY: number;
  topY: number;
  /** Direction along which height increases from baseY -> topY */
  riseAxis: '+x' | '-x' | '+z' | '-z';
  surface?: BodycamSurfaceMaterial;
}

export interface PhysicsSurfaceZone {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY?: number;
  maxY?: number;
  surface: BodycamSurfaceMaterial;
}

export interface PhysicsInteriorZone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  material: 'concrete' | 'wood' | 'metal';
}

const EPS = 1e-4;
const FOOT_TOLERANCE = 0.04;

// Pre-allocated scratch buffers (zero GC per frame)
const _leanOrigin = new THREE.Vector3();
const _leanForward = new THREE.Vector3();
const _leanUp = new THREE.Vector3(0, 1, 0);
const _leanProbeHit: BodycamRaycastResult = {
  hit: false,
  distance: Infinity,
  pointX: 0,
  pointY: 0,
  pointZ: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  surface: 'concrete',
  object: null,
};

/**
 * Sphere-swept lean clearance query using a 5-ray bundle around the chest camera
 * so leaning Q/E against doorframes and walls halts cleanly without clipping.
 */
export function computeSphereSweptLeanClearance(
  adapter: IBodycamWorldAdapter,
  chestPos: Readonly<THREE.Vector3>,
  leanDir: Readonly<THREE.Vector3>,
  torsoYaw: number,
  maxLeanM: number,
  clearanceRadiusM: number,
): number {
  const probeFar = maxLeanM + clearanceRadiusM + 0.08;
  let minAllowed = maxLeanM;

  // Forward direction in XZ plane for front/back capsule offsets
  _leanForward.set(-Math.sin(torsoYaw), 0, -Math.cos(torsoYaw));

  // 5-ray sphere-bundle offsets around sternum center: center, +Y, -Y, +Fwd, -Fwd
  const r = clearanceRadiusM * 0.85;
  for (let i = 0; i < 5; i++) {
    _leanOrigin.copy(chestPos);
    if (i === 1) _leanOrigin.y += r;
    else if (i === 2) _leanOrigin.y -= r;
    else if (i === 3) _leanOrigin.addScaledVector(_leanForward, r);
    else if (i === 4) _leanOrigin.addScaledVector(_leanForward, -r);

    if (adapter.raycast(_leanOrigin, leanDir, 0.03, probeFar, _leanProbeHit)) {
      const allowed = Math.max(0, _leanProbeHit.distance - clearanceRadiusM - 0.04);
      if (allowed < minAllowed) {
        minAllowed = allowed;
      }
    }
  }
  return minAllowed;
}

/**
 * Overhead clearance raycast check (5-ray vertical cylinder bundle) used when a
 * host adapter does not provide a custom `hasOverheadClearance` implementation.
 */
export function checkOverheadClearanceViaRaycast(
  adapter: IBodycamWorldAdapter,
  x: number,
  baseY: number,
  z: number,
  radius: number,
  crouchHeight: number,
  standHeight: number,
): boolean {
  const probeOriginY = baseY + Math.max(0.35, crouchHeight - 0.12);
  const needDist = standHeight - (probeOriginY - baseY) + 0.08;
  const r = radius * 0.72;

  for (let i = 0; i < 5; i++) {
    let ox = x;
    let oz = z;
    if (i === 1) ox += r;
    else if (i === 2) ox -= r;
    else if (i === 3) oz += r;
    else if (i === 4) oz -= r;

    _leanOrigin.set(ox, probeOriginY, oz);
    if (adapter.raycast(_leanOrigin, _leanUp, 0.02, needDist, _leanProbeHit)) {
      return false;
    }
  }
  return true;
}

/**
 * Reusable, zero-allocation AABB + Ramp Capsule Physics solver.
 * Handles:
 *  - Smooth wall sliding via normal projection (multiple sub-iterations)
 *  - Automatic stair & curb step-up up to `maxStepUpM` (default 0.32m) with overhead validation
 *  - Walkable sloped ramps with exact surface normal & slope angle
 *  - Overhead crouch-tunnel clearance checks
 *  - Ground height queries for dual-boot IK on stairs/curbs/ramps
 */
export class BodycamPhysicsWorld {
  public readonly boxes: PhysicsBoxCollider[] = [];
  public readonly ramps: PhysicsRampCollider[] = [];
  public readonly slabs: PhysicsDynamicSlab[] = [];
  public readonly surfaceZones: PhysicsSurfaceZone[] = [];
  public readonly interiorZones: PhysicsInteriorZone[] = [];

  public baseFloorY = 0;
  public boundsMinX = -48;
  public boundsMaxX = 48;
  public boundsMinZ = -48;
  public boundsMaxZ = 48;

  private readonly _raycaster = new THREE.Raycaster();
  private readonly _rayHits: THREE.Intersection[] = [];
  private readonly _rayNormal = new THREE.Vector3();
  private readonly _rayNormalMat = new THREE.Matrix3();
  private readonly _occDir = new THREE.Vector3();
  private raycastMeshes: THREE.Object3D[] = [];

  // 2D XZ uniform spatial grid for ultra-fast analytical ray-AABB queries (zero per-ray allocations)
  private static readonly GRID_CELL_SIZE = 8.0;
  private rayBoxGridDirty = true;
  private rayBoxGridMinX = 0;
  private rayBoxGridMinZ = 0;
  private rayBoxGridCols = 0;
  private rayBoxGridRows = 0;
  private rayBoxGridCells: Int32Array[] = [];
  private rayBoxIndices: number[] = [];
  private rayBoxVisitStamps: Int32Array = new Int32Array(0);
  private rayStampCounter = 1;

  private terrainRaycastEnabled = false;
  private terrainRaycastSurface: BodycamSurfaceMaterial = 'grass';
  private terrainRaycastMesh: THREE.Object3D | null = null;

  public setRaycastMeshes(meshes: THREE.Object3D[]): void {
    this.raycastMeshes = meshes;
  }

  public addRaycastMesh(mesh: THREE.Object3D): void {
    this.raycastMeshes.push(mesh);
  }

  public addDynamicSlab(slab: PhysicsDynamicSlab): void {
    this.slabs.push(slab);
  }

  public addBox(box: PhysicsBoxCollider): void {
    this.boxes.push(box);
    if (box.blocksRaycast) {
      this.rayBoxGridDirty = true;
    }
  }

  public disableBoxById(id: string): void {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i].id === id) {
        this.boxes[i].blocksMovement = false;
        this.boxes[i].blocksRaycast = false;
        this.rayBoxGridDirty = true;
      }
    }
  }

  public addRamp(ramp: PhysicsRampCollider): void {
    this.ramps.push(ramp);
  }

  public addSurfaceZone(zone: PhysicsSurfaceZone): void {
    this.surfaceZones.push(zone);
  }

  public addInteriorZone(zone: PhysicsInteriorZone): void {
    this.interiorZones.push(zone);
  }

  public getInteriorZones(): readonly PhysicsInteriorZone[] {
    return this.interiorZones;
  }

  public clear(): void {
    this.boxes.length = 0;
    this.ramps.length = 0;
    this.slabs.length = 0;
    this.surfaceZones.length = 0;
    this.interiorZones.length = 0;
    this.raycastMeshes = [];
    this.rayBoxGridDirty = true;
    this.rayBoxGridCells = [];
    this.rayBoxIndices = [];
    this.terrainRaycastEnabled = false;
    this.terrainRaycastMesh = null;
  }

  private terrainHeightSampler: ((x: number, z: number) => number) | null = null;

  public setTerrainHeightSampler(
    fn: ((x: number, z: number) => number) | null,
    options?: {
      enableRaycast?: boolean;
      surface?: BodycamSurfaceMaterial;
      terrainMesh?: THREE.Object3D | null;
    },
  ): void {
    this.terrainHeightSampler = fn;
    this.terrainRaycastEnabled = Boolean(fn && options?.enableRaycast);
    this.terrainRaycastSurface = options?.surface ?? 'grass';
    this.terrainRaycastMesh = options?.terrainMesh ?? null;
  }

  /**
   * Computes exact walkable floor height at (x, z) reachable from `referenceY`,
   * plus surface slope angle in radians (written to outSlope if provided).
   */
  public getGroundHeight(
    x: number,
    z: number,
    referenceY: number,
    maxStepUp = 0.52,
    footRadius = 0.08,
  ): number {
    let bestY = this.baseFloorY;
    if (this.terrainHeightSampler) {
      const ty = this.terrainHeightSampler(x, z);
      if (Number.isFinite(ty) && ty > bestY) {
        bestY = ty;
      }
    }

    const footRSq = footRadius * footRadius;

    // 1. Check walkable tops of box colliders (stairs, curbs, platforms, mezzanines)
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.blocksMovement === false) continue;
      const cx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz > footRSq) {
        continue;
      }
      // Only consider tops that aren't ceilings high above the foot
      if (b.maxY <= referenceY + maxStepUp + 0.02 && b.maxY > bestY) {
        bestY = b.maxY;
      }
    }

    // 2. Check sloped ramps
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (
        x + footRadius < r.minX ||
        x - footRadius > r.maxX ||
        z + footRadius < r.minZ ||
        z - footRadius > r.maxZ
      ) {
        continue;
      }
      const ry = this.sampleRampY(r, x, z);
      if (ry <= referenceY + maxStepUp + 0.14 && ry > bestY) {
        bestY = ry;
      }
    }

    return bestY;
  }

  private sampleRampY(r: PhysicsRampCollider, x: number, z: number): number {
    let t = 0;
    if (r.riseAxis === '+x') {
      t = (x - r.minX) / Math.max(EPS, r.maxX - r.minX);
    } else if (r.riseAxis === '-x') {
      t = (r.maxX - x) / Math.max(EPS, r.maxX - r.minX);
    } else if (r.riseAxis === '+z') {
      t = (z - r.minZ) / Math.max(EPS, r.maxZ - r.minZ);
    } else {
      t = (r.maxZ - z) / Math.max(EPS, r.maxZ - r.minZ);
    }
    t = THREE.MathUtils.clamp(t, 0, 1);
    return r.baseY + (r.topY - r.baseY) * t;
  }

  private sampleRampSlopeRad(r: PhysicsRampCollider): number {
    const run =
      r.riseAxis === '+x' || r.riseAxis === '-x'
        ? Math.max(EPS, r.maxX - r.minX)
        : Math.max(EPS, r.maxZ - r.minZ);
    const rise = Math.abs(r.topY - r.baseY);
    return Math.atan2(rise, run);
  }

  /**
   * Returns true if a capsule centered at (x, baseY, z) with given radius & height
   * intersects any solid box collider horizontally/vertically.
   * Writes penetration push-out normal if colliding.
   */
  private resolveHorizontalBoxes(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    height: number,
    maxStepUpM: number,
    allowStepCandidate: boolean,
    moveDeltaX = 0,
    moveDeltaZ = 0,
  ): {
    outX: number;
    outZ: number;
    hitWall: boolean;
    wallNX: number;
    wallNZ: number;
    candidateStepY: number;
  } {
    let curX = x;
    let curZ = z;
    let hitWall = false;
    let wallNX = 0;
    let wallNZ = 0;
    let candidateStepY = -Infinity;

    const pyMin = baseY + FOOT_TOLERANCE;
    const pyMax = baseY + height;
    const rSq = radius * radius;

    for (let pass = 0; pass < 3; pass++) {
      let pushedThisPass = false;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.blocksMovement === false) continue;
        if (pyMax <= b.minY + EPS || pyMin >= b.maxY - EPS) continue;

        const cx = THREE.MathUtils.clamp(curX, b.minX, b.maxX);
        const cz = THREE.MathUtils.clamp(curZ, b.minZ, b.maxZ);
        const dx = curX - cx;
        const dz = curZ - cz;
        const distSq = dx * dx + dz * dz;

        if (distSq < rSq - 1e-6) {
          // Check if this box is a step-up candidate (stair riser or curb <= maxStepUpM)
          const stepH = b.maxY - baseY;
          if (allowStepCandidate && stepH > 0.005 && stepH <= maxStepUpM + 0.005) {
            if (b.maxY > candidateStepY) {
              candidateStepY = b.maxY;
            }
          }

          hitWall = true;
          pushedThisPass = true;
          if (distSq > 1e-8) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const nz = dz / dist;
            const pen = radius - dist;
            curX += nx * pen;
            curZ += nz * pen;
            wallNX = nx;
            wallNZ = nz;
          } else {
            // Capsule center is inside AABB XZ bounds -> push out nearest face
            const dl = Math.abs(curX - b.minX);
            const dr = Math.abs(b.maxX - curX);
            const df = Math.abs(curZ - b.minZ);
            const db = Math.abs(b.maxZ - curZ);
            const m = Math.min(dl, dr, df, db);
            if (m === dl) {
              curX = b.minX - radius;
              wallNX = -1;
              wallNZ = 0;
            } else if (m === dr) {
              curX = b.maxX + radius;
              wallNX = 1;
              wallNZ = 0;
            } else if (m === df) {
              curZ = b.minZ - radius;
              wallNX = 0;
              wallNZ = -1;
            } else {
              curZ = b.maxZ + radius;
              wallNX = 0;
              wallNZ = 1;
            }
          }
        }
      }

      // Dynamic oriented slabs (physical hinged doors)
      for (let i = 0; i < this.slabs.length; i++) {
        const s = this.slabs[i];
        if (!s.active) continue;
        if (pyMax <= s.minY + EPS || pyMin >= s.maxY - EPS) continue;

        const relX = curX - s.originX;
        const relZ = curZ - s.originZ;
        const proj = THREE.MathUtils.clamp(relX * s.dirX + relZ * s.dirZ, 0, s.length);
        const cx = s.originX + s.dirX * proj;
        const cz = s.originZ + s.dirZ * proj;
        const dx = curX - cx;
        const dz = curZ - cz;
        const distSq = dx * dx + dz * dz;
        const combinedR = radius + s.halfThickness;

        if (distSq < combinedR * combinedR - 1e-6) {
          let nx: number;
          let nz: number;
          let pen: number;
          if (distSq > 1e-8) {
            const dist = Math.sqrt(distSq);
            nx = dx / dist;
            nz = dz / dist;
            pen = combinedR - dist;
          } else {
            // Perpendicular to slab direction
            nx = -s.dirZ;
            nz = s.dirX;
            pen = combinedR;
          }

          if (pass === 0 && s.onCapsulePush) {
            // Push normal from capsule INTO slab is (-nx, -nz)
            s.onCapsulePush(proj, -nx, -nz, pen, moveDeltaX, moveDeltaZ);
          }

          // When unlatched, push capsule out smoothly with slight compliance so walking nudges door naturally
          const pushRatio = s.rigidBlocked === false ? 0.65 : 1.0;
          curX += nx * pen * pushRatio;
          curZ += nz * pen * pushRatio;
          if (s.rigidBlocked !== false) {
            hitWall = true;
            wallNX = nx;
            wallNZ = nz;
          }
          pushedThisPass = true;
        }
      }

      if (!pushedThisPass) break;
    }

    return { outX: curX, outZ: curZ, hitWall, wallNX, wallNZ, candidateStepY };
  }

  public hasOverheadClearance(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    crouchHeight: number,
    standHeight: number,
  ): boolean {
    const checkMinY = baseY + crouchHeight * 0.85;
    const checkMaxY = baseY + standHeight + 0.04;
    const effR = radius * 0.88;
    const rSq = effR * effR;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b.blocksMovement === false) continue;
      if (b.maxY <= checkMinY || b.minY >= checkMaxY) continue;
      const cx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < rSq) {
        return false;
      }
    }
    return true;
  }

  public sweepCapsule(
    startPos: Readonly<THREE.Vector3>,
    deltaX: number,
    deltaY: number,
    deltaZ: number,
    radius: number,
    height: number,
    maxStepUpM: number,
    out: BodycamCapsuleSweepResult,
  ): void {
    const startX = startPos.x;
    const startY = startPos.y;
    const startZ = startPos.z;

    const targetX = THREE.MathUtils.clamp(startX + deltaX, this.boundsMinX, this.boundsMaxX);
    const targetZ = THREE.MathUtils.clamp(startZ + deltaZ, this.boundsMinZ, this.boundsMaxZ);

    // 1. Standard horizontal sweep at current elevation
    const baseRes = this.resolveHorizontalBoxes(
      targetX,
      startY,
      targetZ,
      radius,
      height,
      maxStepUpM,
      true,
      deltaX,
      deltaZ,
    );

    let finalX = baseRes.outX;
    let finalZ = baseRes.outZ;
    let finalY = startY;
    let hitWall = baseRes.hitWall;
    let wallNX = baseRes.wallNX;
    let wallNZ = baseRes.wallNZ;
    let steppedUp = false;
    let stepDeltaY = 0;

    // 2. Automatic Stair / Curb Step-Up evaluation (if blocked by a climbable riser <= maxStepUpM)
    if (baseRes.hitWall && baseRes.candidateStepY > startY + 0.005) {
      const stepY = baseRes.candidateStepY;
      // Resolve horizontal capsule placement at the stepped elevation first
      const stepRes = this.resolveHorizontalBoxes(targetX, stepY, targetZ, radius, height, 0, false);

      // Compare true remaining distance to the intended target (handles diagonal & slow stair walks cleanly)
      const baseRemSq = (targetX - baseRes.outX) ** 2 + (targetZ - baseRes.outZ) ** 2;
      const stepRemSq = (targetX - stepRes.outX) ** 2 + (targetZ - stepRes.outZ) ** 2;

      if (stepRemSq < baseRemSq - 1e-7) {
        // Validate overhead ceiling clearance at the RESOLVED stepped position
        // (start check at stepY + 0.42 so the next stair riser cannot falsely register as a ceiling)
        const canStandAtStep = this.hasOverheadClearance(
          stepRes.outX,
          stepY,
          stepRes.outZ,
          radius * 0.88,
          Math.max(0.48, maxStepUpM + 0.16),
          height,
        );
        if (canStandAtStep) {
          finalX = stepRes.outX;
          finalZ = stepRes.outZ;
          finalY = stepY;
          steppedUp = true;
          stepDeltaY = stepY - startY;
          hitWall = stepRes.hitWall;
          wallNX = stepRes.wallNX;
          wallNZ = stepRes.wallNZ;
        }
      }
    }

    // 3. Vertical gravity / ground snapping / slope tracking / stair step-down
    let proposedY = finalY + deltaY;
    let hitCeiling = false;

    // Ceiling clamp if moving upward
    if (deltaY > 0) {
      const topY = proposedY + height;
      const rSq = (radius * 0.9) * (radius * 0.9);
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.blocksMovement === false) continue;
        if (b.minY >= finalY + height - 0.05 && b.minY < topY) {
          const cx = THREE.MathUtils.clamp(finalX, b.minX, b.maxX);
          const cz = THREE.MathUtils.clamp(finalZ, b.minZ, b.maxZ);
          if ((finalX - cx) * (finalX - cx) + (finalZ - cz) * (finalZ - cz) < rSq) {
            proposedY = b.minY - height;
            hitCeiling = true;
          }
        }
      }
    }

    // Evaluate walkable ground surface using full capsule radius (+1.5cm lip tolerance)
    // so stepping onto a stair edge never immediately loses footing on the same frame
    let groundY = this.getGroundHeight(finalX, finalZ, finalY, maxStepUpM, radius + 0.015);
    if (steppedUp && groundY < finalY) {
      groundY = finalY;
    }

    let grounded = false;
    let slopeAngleRad = 0;

    // Check if standing on a ramp to compute exact slope angle and smooth downhill tracking
    let onRamp = false;
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (
        finalX + radius * 0.5 >= r.minX &&
        finalX - radius * 0.5 <= r.maxX &&
        finalZ + radius * 0.5 >= r.minZ &&
        finalZ - radius * 0.5 <= r.maxZ
      ) {
        const ry = this.sampleRampY(r, finalX, finalZ);
        if (Math.abs(ry - groundY) < 0.08) {
          slopeAngleRad = this.sampleRampSlopeRad(r);
          onRamp = true;
          break;
        }
      }
    }

    const dropToGround = finalY - groundY;
    if (proposedY <= groundY + 0.005) {
      if (!steppedUp && groundY - startY > 0.025 && groundY - startY <= maxStepUpM + 0.05 && !onRamp) {
        steppedUp = true;
        stepDeltaY = groundY - startY;
      }
      finalY = groundY;
      grounded = true;
    } else if (
      !steppedUp &&
      deltaY <= 0.001 &&
      dropToGround > 0.005 &&
      dropToGround <= (onRamp ? 0.24 : maxStepUpM + 0.03)
    ) {
      // Smooth stair step-down & downhill ramp tracking (while tall ledges > maxStepUpM still go airborne!)
      if (!onRamp && dropToGround > 0.025) {
        stepDeltaY = groundY - startY; // Negative delta -> smooth camera glide down stairs
      }
      finalY = groundY;
      grounded = true;
    } else {
      finalY = proposedY;
      grounded = false;
    }

    out.posX = finalX;
    out.posY = finalY;
    out.posZ = finalZ;
    out.grounded = grounded;
    out.steppedUp = steppedUp;
    out.stepDeltaY = stepDeltaY;
    out.hitWall = hitWall;
    out.hitCeiling = hitCeiling;
    out.wallNormalX = wallNX;
    out.wallNormalZ = wallNZ;
    out.groundNormalY = Math.cos(slopeAngleRad);
    out.slopeAngleRad = slopeAngleRad;
  }

  public getSurfaceMaterial(x: number, y: number, z: number): BodycamSurfaceMaterial {
    // 1. Check explicit surface zones (floor strips, puddles, grates, gravel)
    for (let i = 0; i < this.surfaceZones.length; i++) {
      const zZone = this.surfaceZones[i];
      if (x >= zZone.minX && x <= zZone.maxX && z >= zZone.minZ && z <= zZone.maxZ) {
        if (zZone.minY !== undefined && y < zZone.minY - 0.15) continue;
        if (zZone.maxY !== undefined && y > zZone.maxY + 0.25) continue;
        return zZone.surface;
      }
    }

    // 2. Check top of box colliders under feet
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (!b.surface) continue;
      if (
        x >= b.minX - 0.12 &&
        x <= b.maxX + 0.12 &&
        z >= b.minZ - 0.12 &&
        z <= b.maxZ + 0.12 &&
        Math.abs(y - b.maxY) < 0.18
      ) {
        return b.surface;
      }
    }

    // 3. Check ramps
    for (let i = 0; i < this.ramps.length; i++) {
      const r = this.ramps[i];
      if (r.surface && x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) {
        return r.surface;
      }
    }

    return 'concrete';
  }

  public sampleInterior(x: number, y: number, z: number, out: BodycamInteriorSample): void {
    for (let i = 0; i < this.interiorZones.length; i++) {
      const iz = this.interiorZones[i];
      if (
        x >= iz.minX &&
        x <= iz.maxX &&
        y >= iz.minY &&
        y <= iz.maxY &&
        z >= iz.minZ &&
        z <= iz.maxZ
      ) {
        out.isIndoor = true;
        out.material = iz.material;
        return;
      }
    }
    out.isIndoor = false;
    out.material = 'outdoor';
  }

  private isVisibleInHierarchy(obj: THREE.Object3D): boolean {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    return true;
  }

  private rebuildRayBoxGrid(): void {
    this.rayBoxGridDirty = false;
    this.rayBoxIndices.length = 0;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (!b.blocksRaycast || b.blocksMovement === false) continue;
      this.rayBoxIndices.push(i);
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    }

    if (this.rayBoxIndices.length === 0) {
      this.rayBoxGridCols = 0;
      this.rayBoxGridRows = 0;
      this.rayBoxGridCells = [];
      return;
    }

    const cellSize = BodycamPhysicsWorld.GRID_CELL_SIZE;
    this.rayBoxGridMinX = Math.floor(minX / cellSize) * cellSize;
    this.rayBoxGridMinZ = Math.floor(minZ / cellSize) * cellSize;
    this.rayBoxGridCols = Math.max(1, Math.ceil((maxX - this.rayBoxGridMinX) / cellSize) + 1);
    this.rayBoxGridRows = Math.max(1, Math.ceil((maxZ - this.rayBoxGridMinZ) / cellSize) + 1);

    const totalCells = this.rayBoxGridCols * this.rayBoxGridRows;
    const buckets: number[][] = new Array(totalCells);
    for (let c = 0; c < totalCells; c++) buckets[c] = [];

    for (let k = 0; k < this.rayBoxIndices.length; k++) {
      const boxIdx = this.rayBoxIndices[k];
      const b = this.boxes[boxIdx];
      const cx0 = Math.max(0, Math.min(this.rayBoxGridCols - 1, Math.floor((b.minX - this.rayBoxGridMinX) / cellSize)));
      const cx1 = Math.max(0, Math.min(this.rayBoxGridCols - 1, Math.floor((b.maxX - this.rayBoxGridMinX) / cellSize)));
      const cz0 = Math.max(0, Math.min(this.rayBoxGridRows - 1, Math.floor((b.minZ - this.rayBoxGridMinZ) / cellSize)));
      const cz1 = Math.max(0, Math.min(this.rayBoxGridRows - 1, Math.floor((b.maxZ - this.rayBoxGridMinZ) / cellSize)));
      for (let cz = cz0; cz <= cz1; cz++) {
        const rowOff = cz * this.rayBoxGridCols;
        for (let cx = cx0; cx <= cx1; cx++) {
          buckets[rowOff + cx].push(boxIdx);
        }
      }
    }

    this.rayBoxGridCells = new Array(totalCells);
    for (let c = 0; c < totalCells; c++) {
      this.rayBoxGridCells[c] = Int32Array.from(buckets[c]);
    }
    if (this.rayBoxVisitStamps.length < this.boxes.length) {
      this.rayBoxVisitStamps = new Int32Array(this.boxes.length + 64);
    }
  }

  private raycastAnalyticalBoxes(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    far: number,
    earlyExit: boolean,
    out: BodycamRaycastResult | null,
  ): number {
    if (this.rayBoxGridDirty) {
      this.rebuildRayBoxGrid();
    }
    if (this.rayBoxGridCols === 0 || this.rayBoxIndices.length === 0) {
      return Infinity;
    }

    const cellSize = BodycamPhysicsWorld.GRID_CELL_SIZE;
    const invCell = 1.0 / cellSize;
    const gridMinX = this.rayBoxGridMinX;
    const gridMinZ = this.rayBoxGridMinZ;
    const cols = this.rayBoxGridCols;
    const rows = this.rayBoxGridRows;
    const gridMaxX = gridMinX + cols * cellSize;
    const gridMaxZ = gridMinZ + rows * cellSize;

    const invDx = Math.abs(dx) > 1e-8 ? 1.0 / dx : Infinity;
    const invDy = Math.abs(dy) > 1e-8 ? 1.0 / dy : Infinity;
    const invDz = Math.abs(dz) > 1e-8 ? 1.0 / dz : Infinity;

    // Clip ray segment [near, far] against 2D XZ grid bounds
    let tEnter = near;
    let tExit = far;
    if (Number.isFinite(invDx)) {
      const tx1 = (gridMinX - ox) * invDx;
      const tx2 = (gridMaxX - ox) * invDx;
      tEnter = Math.max(tEnter, Math.min(tx1, tx2));
      tExit = Math.min(tExit, Math.max(tx1, tx2));
    } else if (ox < gridMinX || ox > gridMaxX) {
      return Infinity;
    }
    if (Number.isFinite(invDz)) {
      const tz1 = (gridMinZ - oz) * invDz;
      const tz2 = (gridMaxZ - oz) * invDz;
      tEnter = Math.max(tEnter, Math.min(tz1, tz2));
      tExit = Math.min(tExit, Math.max(tz1, tz2));
    } else if (oz < gridMinZ || oz > gridMaxZ) {
      return Infinity;
    }
    if (tExit < tEnter) {
      return Infinity;
    }

    let stamp = ++this.rayStampCounter;
    if (stamp >= 0x3fffffff) {
      this.rayBoxVisitStamps.fill(0);
      this.rayStampCounter = 1;
      stamp = 1;
    }

    const startX = ox + dx * tEnter;
    const startZ = oz + dz * tEnter;
    let cx = Math.max(0, Math.min(cols - 1, Math.floor((startX - gridMinX) * invCell)));
    let cz = Math.max(0, Math.min(rows - 1, Math.floor((startZ - gridMinZ) * invCell)));

    const stepX = dx > 1e-8 ? 1 : dx < -1e-8 ? -1 : 0;
    const stepZ = dz > 1e-8 ? 1 : dz < -1e-8 ? -1 : 0;

    let tMaxX = Infinity;
    let tDeltaX = Infinity;
    if (stepX !== 0) {
      const nextBoundaryX = gridMinX + (cx + (stepX > 0 ? 1 : 0)) * cellSize;
      tMaxX = tEnter + (nextBoundaryX - startX) * invDx;
      tDeltaX = Math.abs(cellSize * invDx);
    }

    let tMaxZ = Infinity;
    let tDeltaZ = Infinity;
    if (stepZ !== 0) {
      const nextBoundaryZ = gridMinZ + (cz + (stepZ > 0 ? 1 : 0)) * cellSize;
      tMaxZ = tEnter + (nextBoundaryZ - startZ) * invDz;
      tDeltaZ = Math.abs(cellSize * invDz);
    }

    let bestT = far;
    let hitFound = false;
    let hitBoxIdx = -1;
    let hitNx = 0;
    let hitNy = 1;
    let hitNz = 0;

    const stamps = this.rayBoxVisitStamps;
    const boxes = this.boxes;
    const maxSteps = cols + rows + 4;

    for (let iter = 0; iter < maxSteps; iter++) {
      const cell = this.rayBoxGridCells[cz * cols + cx];
      for (let i = 0; i < cell.length; i++) {
        const idx = cell[i];
        if (stamps[idx] === stamp) continue;
        stamps[idx] = stamp;

        const b = boxes[idx];
        if (b.blocksMovement === false || !b.blocksRaycast) continue;

        // Branch-minimized slab intersection with exact hit face normal
        let tmin = near;
        let tmax = bestT;
        let nx = 0;
        let ny = 0;
        let nz = 0;

        if (Number.isFinite(invDx)) {
          const t1 = (b.minX - ox) * invDx;
          const t2 = (b.maxX - ox) * invDx;
          const tLo = t1 < t2 ? t1 : t2;
          const tHi = t1 < t2 ? t2 : t1;
          if (tLo > tmin) {
            tmin = tLo;
            nx = t1 < t2 ? -1 : 1;
            ny = 0;
            nz = 0;
          }
          if (tHi < tmax) tmax = tHi;
          if (tmin > tmax) continue;
        } else if (ox < b.minX || ox > b.maxX) {
          continue;
        }

        if (Number.isFinite(invDy)) {
          const t1 = (b.minY - oy) * invDy;
          const t2 = (b.maxY - oy) * invDy;
          const tLo = t1 < t2 ? t1 : t2;
          const tHi = t1 < t2 ? t2 : t1;
          if (tLo > tmin) {
            tmin = tLo;
            nx = 0;
            ny = t1 < t2 ? -1 : 1;
            nz = 0;
          }
          if (tHi < tmax) tmax = tHi;
          if (tmin > tmax) continue;
        } else if (oy < b.minY || oy > b.maxY) {
          continue;
        }

        if (Number.isFinite(invDz)) {
          const t1 = (b.minZ - oz) * invDz;
          const t2 = (b.maxZ - oz) * invDz;
          const tLo = t1 < t2 ? t1 : t2;
          const tHi = t1 < t2 ? t2 : t1;
          if (tLo > tmin) {
            tmin = tLo;
            nx = 0;
            ny = 0;
            nz = t1 < t2 ? -1 : 1;
          }
          if (tHi < tmax) tmax = tHi;
          if (tmin > tmax) continue;
        } else if (oz < b.minZ || oz > b.maxZ) {
          continue;
        }

        if (tmin >= near && tmin <= bestT) {
          if (earlyExit) {
            return tmin;
          }
          bestT = tmin;
          hitFound = true;
          hitBoxIdx = idx;
          if (nx === 0 && ny === 0 && nz === 0) {
            // Origin started inside the box; point normal opposite ray direction
            hitNx = -dx;
            hitNy = -dy;
            hitNz = -dz;
          } else {
            hitNx = nx;
            hitNy = ny;
            hitNz = nz;
          }
        }
      }

      const nextCellT = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (nextCellT > bestT || nextCellT > tExit) {
        break;
      }
      if (tMaxX < tMaxZ) {
        tMaxX += tDeltaX;
        cx += stepX;
        if (cx < 0 || cx >= cols) break;
      } else {
        tMaxZ += tDeltaZ;
        cz += stepZ;
        if (cz < 0 || cz >= rows) break;
      }
    }

    if (hitFound && out && hitBoxIdx >= 0) {
      const b = boxes[hitBoxIdx];
      out.hit = true;
      out.distance = bestT;
      out.pointX = ox + dx * bestT;
      out.pointY = oy + dy * bestT;
      out.pointZ = oz + dz * bestT;
      out.normalX = hitNx;
      out.normalY = hitNy;
      out.normalZ = hitNz;
      out.surface = b.surface ?? 'concrete';
      out.object = b.meshRef ?? null;
      return bestT;
    }

    return hitFound ? bestT : Infinity;
  }

  private raycastAnalyticalTerrain(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    far: number,
    earlyExit: boolean,
    out: BodycamRaycastResult | null,
  ): number {
    if (!this.terrainRaycastEnabled || !this.terrainHeightSampler) {
      return Infinity;
    }
    const sampler = this.terrainHeightSampler;
    const span = far - near;
    if (span <= 1e-4) return Infinity;

    // Choose adaptive marching step proportional to ray length
    const step = span <= 4.0 ? 0.35 : span <= 24.0 ? 0.9 : 1.6;
    let prevT = near;
    let prevX = ox + dx * prevT;
    let prevY = oy + dy * prevT;
    let prevZ = oz + dz * prevT;
    let prevH = sampler(prevX, prevZ);

    // Handle ray originating right at or below terrain heading downward
    if (prevY <= prevH && dy < 0) {
      if (earlyExit) return prevT;
      if (out) {
        this.writeTerrainHit(prevT, prevX, prevH, prevZ, sampler, out);
      }
      return prevT;
    }

    let t = prevT + step;
    while (true) {
      const curT = t < far ? t : far;
      const cx = ox + dx * curT;
      const cy = oy + dy * curT;
      const cz = oz + dz * curT;
      const ch = sampler(cx, cz);

      // Ignore subterranean cutout discontinuities (e.g., Timberline underground bunker opening)
      const isCutoutJump = Math.abs(ch - prevH) > 4.5 && (prevH < -4.5 || ch < -4.5);
      if (!isCutoutJump && cy <= ch) {
        if (earlyExit) {
          return (prevT + curT) * 0.5;
        }
        // Binary search refinement (6 iterations -> <2.5cm precision)
        let lo = prevT;
        let hi = curT;
        for (let iter = 0; iter < 6; iter++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid;
          const my = oy + dy * mid;
          const mz = oz + dz * mid;
          if (my <= sampler(mx, mz)) {
            hi = mid;
          } else {
            lo = mid;
          }
        }
        const hitX = ox + dx * hi;
        const hitZ = oz + dz * hi;
        const hitY = sampler(hitX, hitZ);
        if (out) {
          this.writeTerrainHit(hi, hitX, hitY, hitZ, sampler, out);
        }
        return hi;
      }

      if (curT >= far) break;
      prevT = curT;
      prevX = cx;
      prevY = cy;
      prevZ = cz;
      prevH = ch;
      t += step;
    }

    return Infinity;
  }

  private writeTerrainHit(
    dist: number,
    hx: number,
    hy: number,
    hz: number,
    sampler: (x: number, z: number) => number,
    out: BodycamRaycastResult,
  ): void {
    const eps = 0.25;
    const hx1 = sampler(hx + eps, hz);
    const hx0 = sampler(hx - eps, hz);
    const hz1 = sampler(hx, hz + eps);
    const hz0 = sampler(hx, hz - eps);
    const nx = -(hx1 - hx0) / (2 * eps);
    const nz = -(hz1 - hz0) / (2 * eps);
    const invLen = 1.0 / Math.hypot(nx, 1.0, nz);

    out.hit = true;
    out.distance = dist;
    out.pointX = hx;
    out.pointY = hy;
    out.pointZ = hz;
    out.normalX = nx * invLen;
    out.normalY = invLen;
    out.normalZ = nz * invLen;
    out.surface = this.terrainRaycastSurface;
    out.object = this.terrainRaycastMesh;
  }

  /**
   * Fast early-exit occlusion query for AI line-of-sight and safe-spawn checks.
   * Tests analytical spatial-grid boxes & terrain heightfield first, then only
   * non-analytically-covered custom meshes with immediate return on first hit.
   */
  public isSegmentOccluded(
    from: Readonly<THREE.Vector3>,
    to: Readonly<THREE.Vector3>,
    nearMargin = 0.15,
    farMargin = 0.25,
  ): boolean {
    this._occDir.subVectors(to as THREE.Vector3, from as THREE.Vector3);
    const dist = this._occDir.length();
    if (dist <= nearMargin + farMargin + 0.05) return false;
    const invDist = 1.0 / dist;
    const dx = this._occDir.x * invDist;
    const dy = this._occDir.y * invDist;
    const dz = this._occDir.z * invDist;
    const far = dist - farMargin;

    if (
      this.raycastAnalyticalBoxes(
        from.x,
        from.y,
        from.z,
        dx,
        dy,
        dz,
        nearMargin,
        far,
        true,
        null,
      ) <= far
    ) {
      return true;
    }

    if (
      this.raycastAnalyticalTerrain(
        from.x,
        from.y,
        from.z,
        dx,
        dy,
        dz,
        nearMargin,
        far,
        true,
        null,
      ) <= far
    ) {
      return true;
    }

    this._occDir.set(dx, dy, dz);
    this._raycaster.set(from as THREE.Vector3, this._occDir);
    this._raycaster.near = nearMargin;
    this._raycaster.far = far;

    const meshes = this.raycastMeshes;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m.userData?.analyticalRaycastCovered) continue;
      if (!this.isVisibleInHierarchy(m)) continue;
      this._rayHits.length = 0;
      this._raycaster.intersectObject(m, false, this._rayHits);
      if (this._rayHits.length > 0) {
        return true;
      }
    }

    return false;
  }

  public raycast(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    near: number,
    far: number,
    out: BodycamRaycastResult,
  ): boolean {
    let bestDist = far;
    let found = false;

    // 1. Ultra-fast 2D spatial-grid analytical ray-AABB pass
    const boxDist = this.raycastAnalyticalBoxes(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      near,
      bestDist,
      false,
      out,
    );
    if (boxDist <= bestDist) {
      bestDist = boxDist;
      found = true;
    }

    // 2. Analytical continuous terrain heightfield pass
    const terrDist = this.raycastAnalyticalTerrain(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      near,
      bestDist,
      false,
      out,
    );
    if (terrDist < bestDist) {
      bestDist = terrDist;
      found = true;
    }

    // 3. Selective Three.js mesh raycast pass ONLY for non-analytically-covered custom meshes
    this._raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
    this._raycaster.near = near;
    this._raycaster.far = bestDist;
    this._rayHits.length = 0;

    const meshes = this.raycastMeshes;
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (m.userData?.analyticalRaycastCovered) continue;
      if (!this.isVisibleInHierarchy(m)) continue;
      this._raycaster.intersectObject(m, false, this._rayHits);
    }

    let h: THREE.Intersection | null = null;
    for (let i = 0; i < this._rayHits.length; i++) {
      const cand = this._rayHits[i];
      if (cand.distance < bestDist) {
        bestDist = cand.distance;
        h = cand;
      }
    }

    if (h) {
      out.hit = true;
      out.distance = h.distance;
      out.pointX = h.point.x;
      out.pointY = h.point.y;
      out.pointZ = h.point.z;
      if (h.face) {
        this._rayNormalMat.getNormalMatrix(h.object.matrixWorld);
        this._rayNormal.copy(h.face.normal).applyMatrix3(this._rayNormalMat).normalize();
        out.normalX = this._rayNormal.x;
        out.normalY = this._rayNormal.y;
        out.normalZ = this._rayNormal.z;
      } else {
        out.normalX = 0;
        out.normalY = 1;
        out.normalZ = 0;
      }
      out.surface = (h.object.userData?.surfaceMaterial as BodycamSurfaceMaterial) ?? 'concrete';
      out.object = h.object;
      return true;
    }

    if (found) {
      return true;
    }

    out.hit = false;
    out.distance = Infinity;
    out.object = null;
    return false;
  }

  /** Creates a clean `IBodycamWorldAdapter` wrapping this physics world */
  public createAdapter(
    hooks?: {
      getTraumaModifiers?: IBodycamWorldAdapter['getTraumaModifiers'];
      emitAcousticEvent?: IBodycamWorldAdapter['emitAcousticEvent'];
      shatterBreakable?: IBodycamWorldAdapter['shatterBreakable'];
      meleeSpherecast?: IBodycamWorldAdapter['meleeSpherecast'];
      onMeleeHit?: IBodycamWorldAdapter['onMeleeHit'];
    },
  ): IBodycamWorldAdapter {
    return {
      sweepCapsule: (startPos, dx, dy, dz, radius, height, maxStepUpM, outResult) =>
        this.sweepCapsule(startPos, dx, dy, dz, radius, height, maxStepUpM, outResult),
      raycast: (origin, direction, near, far, outResult) =>
        this.raycast(origin, direction, near, far, outResult),
      getSurfaceMaterial: (x, y, z) => this.getSurfaceMaterial(x, y, z),
      getGroundHeight: (x, z, referenceY) => this.getGroundHeight(x, z, referenceY),
      hasOverheadClearance: (x, baseY, z, radius, crouchH, standH) =>
        this.hasOverheadClearance(x, baseY, z, radius, crouchH, standH),
      sampleInterior: (x, y, z, outSample) => this.sampleInterior(x, y, z, outSample),
      getTraumaModifiers: hooks?.getTraumaModifiers,
      emitAcousticEvent: hooks?.emitAcousticEvent,
      shatterBreakable: hooks?.shatterBreakable,
      meleeSpherecast: hooks?.meleeSpherecast,
      onMeleeHit: hooks?.onMeleeHit,
    };
  }
}

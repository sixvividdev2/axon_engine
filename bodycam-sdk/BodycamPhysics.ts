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
  private raycastMeshes: THREE.Object3D[] = [];

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
  }

  public disableBoxById(id: string): void {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i].id === id) {
        this.boxes[i].blocksMovement = false;
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

  public raycast(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    near: number,
    far: number,
    out: BodycamRaycastResult,
  ): boolean {
    this._raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
    this._raycaster.near = near;
    this._raycaster.far = far;
    this._rayHits.length = 0;
    this._raycaster.intersectObjects(this.raycastMeshes, false, this._rayHits);

    let h: THREE.Intersection | null = null;
    for (let i = 0; i < this._rayHits.length; i++) {
      if (this.isVisibleInHierarchy(this._rayHits[i].object)) {
        h = this._rayHits[i];
        break;
      }
    }

    if (!h) {
      out.hit = false;
      out.distance = Infinity;
      out.object = null;
      return false;
    }

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

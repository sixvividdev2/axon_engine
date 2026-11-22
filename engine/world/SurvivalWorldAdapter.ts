import * as THREE from 'three';
import {
  BodycamAcousticKind,
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamMeleeHitEvent,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  BodycamTraumaModifiers,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { AcousticKind, AcousticSystem } from '../stealth/AcousticSystem';
import { LimbTraumaSystem } from '../trauma/LimbTraumaSystem';
import { BuiltWorld } from './WorldBuilder';

const EPS = 1e-4;
const FOOT_TOLERANCE = 0.04;

function mapAcousticKind(kind: BodycamAcousticKind): AcousticKind {
  switch (kind) {
    case 'footstep_crouch':
    case 'footstep_walk':
    case 'footstep_sprint':
    case 'landing':
    case 'vault_low':
    case 'mantle_heavy':
    case 'glass_shatter':
    case 'door':
    case 'impact':
      return kind;
    case 'gunshot':
      return 'gunshot_loud';
    case 'suppressed_gunshot':
      return 'gunshot_suppressed';
    case 'gear_rattle':
      return 'footstep_crouch';
    default:
      return 'footstep_walk';
  }
}

/**
 * Zero-GC IBodycamWorldAdapter bridging Survival's streamed open-world (`BuiltWorld`),
 * `AcousticSystem`, and `LimbTraumaSystem` to the portable Bodycam SDK movement,
 * capsule step-up/sliding, sphere-swept lean, and grounded tactical vault/mantle systems.
 */
export class SurvivalWorldAdapter implements IBodycamWorldAdapter {
  private world: BuiltWorld;
  private readonly acoustic: AcousticSystem;
  private readonly traumaSystem: LimbTraumaSystem;

  private readonly _raycaster = new THREE.Raycaster();
  private readonly _rayHits: THREE.Intersection[] = [];
  private readonly _rayNormal = new THREE.Vector3();
  private readonly _rayNormalMat = new THREE.Matrix3();
  private readonly _impactPt = new THREE.Vector3();
  private readonly _impactDir = new THREE.Vector3();
  private readonly _sphereRight = new THREE.Vector3();
  private readonly _sphereUp = new THREE.Vector3();
  private readonly _sphereOrigin = new THREE.Vector3();
  private readonly _worldUp = new THREE.Vector3(0, 1, 0);
  private readonly _worldRightFallback = new THREE.Vector3(1, 0, 0);

  private getExtraMeleeTargets?: () => THREE.Object3D[];
  private onMeleeHitHandler?: (event: Readonly<BodycamMeleeHitEvent>) => void;

  private readonly _horizResult = {
    outX: 0,
    outZ: 0,
    hitWall: false,
    wallNX: 0,
    wallNZ: 0,
    candidateStepY: -Infinity,
  };

  constructor(world: BuiltWorld, acoustic: AcousticSystem, traumaSystem: LimbTraumaSystem) {
    this.world = world;
    this.acoustic = acoustic;
    this.traumaSystem = traumaSystem;
  }

  public setWorld(world: BuiltWorld): void {
    this.world = world;
  }

  public setMeleeHooks(
    getExtraTargets: () => THREE.Object3D[],
    onMeleeHit: (event: Readonly<BodycamMeleeHitEvent>) => void,
  ): void {
    this.getExtraMeleeTargets = getExtraTargets;
    this.onMeleeHitHandler = onMeleeHit;
  }

  public getGroundHeight(x: number, z: number, referenceY: number): number {
    return this.sampleWalkableGroundHeight(x, z, referenceY, 0.52, 0.08);
  }

  private sampleWalkableGroundHeight(
    x: number,
    z: number,
    referenceY: number,
    maxStepUp: number,
    footRadius: number,
  ): number {
    let bestY = this.world.groundHeightAt(x, z);
    const footRSq = footRadius * footRadius;
    const boxes = this.world.colliders;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.blocksMovement) continue;
      const cx = THREE.MathUtils.clamp(x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz > footRSq) continue;
      if (b.maxY <= referenceY + maxStepUp + 0.02 && b.maxY > bestY) {
        bestY = b.maxY;
      }
    }

    return bestY;
  }

  private resolveHorizontalBoxes(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    height: number,
    maxStepUpM: number,
    allowStepCandidate: boolean,
  ): typeof this._horizResult {
    let curX = x;
    let curZ = z;
    let hitWall = false;
    let wallNX = 0;
    let wallNZ = 0;
    let candidateStepY = -Infinity;

    const pyMin = baseY + FOOT_TOLERANCE;
    const pyMax = baseY + height;
    const rSq = radius * radius;
    const boxes = this.world.colliders;

    for (let pass = 0; pass < 3; pass++) {
      let pushedThisPass = false;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b.blocksMovement) continue;
        if (pyMax <= b.minY + EPS || pyMin >= b.maxY - EPS) continue;

        const cx = THREE.MathUtils.clamp(curX, b.minX, b.maxX);
        const cz = THREE.MathUtils.clamp(curZ, b.minZ, b.maxZ);
        const dx = curX - cx;
        const dz = curZ - cz;
        const distSq = dx * dx + dz * dz;

        if (distSq < rSq - 1e-6) {
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
      if (!pushedThisPass) break;
    }

    const r = this._horizResult;
    r.outX = curX;
    r.outZ = curZ;
    r.hitWall = hitWall;
    r.wallNX = wallNX;
    r.wallNZ = wallNZ;
    r.candidateStepY = candidateStepY;
    return r;
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
    const boxes = this.world.colliders;

    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.blocksMovement) continue;
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

    const targetX = startX + deltaX;
    const targetZ = startZ + deltaZ;

    // 1. Standard horizontal sweep at current elevation
    const baseRes = this.resolveHorizontalBoxes(targetX, startY, targetZ, radius, height, maxStepUpM, true);
    const baseOutX = baseRes.outX;
    const baseOutZ = baseRes.outZ;
    const baseHitWall = baseRes.hitWall;
    const baseWallNX = baseRes.wallNX;
    const baseWallNZ = baseRes.wallNZ;
    const candidateStepY = baseRes.candidateStepY;

    let finalX = baseOutX;
    let finalZ = baseOutZ;
    let finalY = startY;
    let hitWall = baseHitWall;
    let wallNX = baseWallNX;
    let wallNZ = baseWallNZ;
    let steppedUp = false;
    let stepDeltaY = 0;

    // 2. Automatic Stair / Curb Step-Up evaluation (up to maxStepUpM)
    if (baseHitWall && candidateStepY > startY + 0.005) {
      const stepY = candidateStepY;
      const stepRes = this.resolveHorizontalBoxes(targetX, stepY, targetZ, radius, height, 0, false);

      const baseRemSq = (targetX - baseOutX) ** 2 + (targetZ - baseOutZ) ** 2;
      const stepRemSq = (targetX - stepRes.outX) ** 2 + (targetZ - stepRes.outZ) ** 2;

      if (stepRemSq < baseRemSq - 1e-7) {
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

    // 3. Vertical gravity / ceiling / ground / terrain tracking
    let proposedY = finalY + deltaY;
    let hitCeiling = false;

    if (deltaY > 0) {
      const topY = proposedY + height;
      const rSq = radius * 0.9 * (radius * 0.9);
      const boxes = this.world.colliders;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b.blocksMovement) continue;
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

    let groundY = this.sampleWalkableGroundHeight(finalX, finalZ, finalY, maxStepUpM, radius + 0.015);
    if (steppedUp && groundY < finalY) {
      groundY = finalY;
    }

    // Approximate terrain slope angle for telemetry/tracking
    const terrainY = this.world.groundHeightAt(finalX, finalZ);
    const onTerrain = Math.abs(groundY - terrainY) < 0.05;
    let slopeAngleRad = 0;
    if (onTerrain) {
      const gx = this.world.groundHeightAt(finalX + 0.25, finalZ) - terrainY;
      const gz = this.world.groundHeightAt(finalX, finalZ + 0.25) - terrainY;
      slopeAngleRad = Math.atan(Math.hypot(gx, gz) / 0.25);
    }

    let grounded = false;
    const dropToGround = finalY - groundY;

    if (proposedY <= groundY + 0.005) {
      if (!steppedUp && groundY - startY > 0.025 && groundY - startY <= maxStepUpM + 0.05 && !onTerrain) {
        steppedUp = true;
        stepDeltaY = groundY - startY;
      }
      finalY = groundY;
      grounded = true;
    } else if (
      !steppedUp &&
      deltaY <= 0.001 &&
      dropToGround > 0.005 &&
      dropToGround <= (onTerrain ? 0.26 : maxStepUpM + 0.03)
    ) {
      if (!onTerrain && dropToGround > 0.025) {
        stepDeltaY = groundY - startY;
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
    this._raycaster.intersectObjects(this.world.raycastMeshes, false, this._rayHits);

    if (this._rayHits.length === 0) {
      out.hit = false;
      out.distance = Infinity;
      out.object = null;
      return false;
    }

    const h = this._rayHits[0];
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

    const ud = h.object.userData;
    out.surface = (ud?.surfaceMaterial ?? ud?.surface ?? (ud?.isGlass ? 'glass' : 'concrete')) as BodycamSurfaceMaterial;
    out.object = h.object;
    return true;
  }

  public getSurfaceMaterial(x: number, y: number, z: number): BodycamSurfaceMaterial {
    const boxes = this.world.colliders;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.blocksMovement) continue;
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
    return this.world.surfaceAt(x, z);
  }

  public sampleInterior(x: number, _y: number, z: number, out: BodycamInteriorSample): void {
    const mat = this.world.getIndoorAcoustics(x, z);
    out.isIndoor = mat !== 'outdoor';
    out.material = mat;
  }

  public getTraumaModifiers(): Readonly<BodycamTraumaModifiers> {
    return this.traumaSystem.getModifiersReadOnly();
  }

  public emitAcousticEvent(
    origin: Readonly<THREE.Vector3>,
    radiusMeters: number,
    kind: BodycamAcousticKind,
  ): void {
    this.acoustic.emitNoise(origin as THREE.Vector3, radiusMeters, mapAcousticKind(kind));
  }

  public shatterBreakable(
    object: THREE.Object3D,
    impactPoint: Readonly<THREE.Vector3>,
    impactDir: Readonly<THREE.Vector3>,
  ): boolean {
    const windowId = object.userData?.windowId as string | undefined;
    if (!windowId) return false;
    this._impactPt.copy(impactPoint);
    this._impactDir.copy(impactDir);
    return this.world.shatterWindow(windowId, this._impactPt, this._impactDir);
  }

  public meleeSpherecast(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    radius: number,
    maxDistance: number,
    out: BodycamRaycastResult,
  ): boolean {
    const dir = direction as THREE.Vector3;
    this._sphereRight.crossVectors(dir, this._worldUp);
    if (this._sphereRight.lengthSq() < 1e-4) {
      this._sphereRight.crossVectors(dir, this._worldRightFallback);
    }
    this._sphereRight.normalize();
    this._sphereUp.crossVectors(this._sphereRight, dir).normalize();

    const extraTargets = this.getExtraMeleeTargets ? this.getExtraMeleeTargets() : null;
    const ringR = Math.max(0.02, radius * 0.72);

    let bestDist = Infinity;
    let bestHit = false;
    let bestObj: THREE.Object3D | null = null;
    let bestPtX = 0;
    let bestPtY = 0;
    let bestPtZ = 0;
    let bestNX = 0;
    let bestNY = 1;
    let bestNZ = 0;
    let bestSurface: BodycamSurfaceMaterial = 'concrete';

    // 7-ray hexagonal bundle (center + 6 perimeter rays) for zero-GC spherecast volume
    for (let i = 0; i < 7; i++) {
      this._sphereOrigin.copy(origin);
      if (i > 0) {
        const ang = ((i - 1) / 6) * Math.PI * 2;
        const c = Math.cos(ang) * ringR;
        const s = Math.sin(ang) * ringR;
        this._sphereOrigin.addScaledVector(this._sphereRight, c);
        this._sphereOrigin.addScaledVector(this._sphereUp, s);
      }

      this._raycaster.set(this._sphereOrigin, dir);
      this._raycaster.near = 0.02;
      this._raycaster.far = maxDistance;
      this._rayHits.length = 0;

      if (extraTargets && extraTargets.length > 0) {
        this._raycaster.intersectObjects(extraTargets, false, this._rayHits);
      }
      this._raycaster.intersectObjects(this.world.raycastMeshes, false, this._rayHits);

      for (let hIdx = 0; hIdx < this._rayHits.length; hIdx++) {
        const h = this._rayHits[hIdx];
        const ud = h.object.userData;
        if (ud?.zombieDead) continue;
        // Center ray slightly favored on ties so aimed headshots win over adjacent thorax rays
        const effectiveDist = i === 0 ? h.distance - 0.035 : h.distance;
        if (effectiveDist < bestDist) {
          bestDist = effectiveDist;
          bestHit = true;
          bestObj = h.object;
          bestPtX = h.point.x;
          bestPtY = h.point.y;
          bestPtZ = h.point.z;
          if (h.face) {
            this._rayNormalMat.getNormalMatrix(h.object.matrixWorld);
            this._rayNormal.copy(h.face.normal).applyMatrix3(this._rayNormalMat).normalize();
            bestNX = this._rayNormal.x;
            bestNY = this._rayNormal.y;
            bestNZ = this._rayNormal.z;
          } else {
            bestNX = -dir.x;
            bestNY = -dir.y;
            bestNZ = -dir.z;
          }
          bestSurface = (ud?.surfaceMaterial ??
            ud?.surface ??
            (ud?.isGlass ? 'glass' : 'concrete')) as BodycamSurfaceMaterial;
        }
      }
    }

    if (!bestHit) {
      out.hit = false;
      out.distance = Infinity;
      out.object = null;
      return false;
    }

    out.hit = true;
    out.distance = Math.max(0, bestDist);
    out.pointX = bestPtX;
    out.pointY = bestPtY;
    out.pointZ = bestPtZ;
    out.normalX = bestNX;
    out.normalY = bestNY;
    out.normalZ = bestNZ;
    out.surface = bestSurface;
    out.object = bestObj;
    return true;
  }

  public onMeleeHit(event: Readonly<BodycamMeleeHitEvent>): void {
    this.onMeleeHitHandler?.(event);
  }
}

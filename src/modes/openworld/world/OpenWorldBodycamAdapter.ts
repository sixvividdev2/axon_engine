import * as THREE from 'three';
import {
  BodycamAcousticKind,
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  IBodycamWorldAdapter,
} from '../../../../bodycam-sdk/types';
import { OpenWorldAiDirector } from './OpenWorldAiDirector';
import { OpenWorldChunkStreamer } from './OpenWorldChunkStreamer';
import {
  createTerrainSample,
  OPENWORLD_LANDMARKS,
  sampleOpenWorldTerrain,
  SEA_LEVEL_M,
  WORLD_HALF_M,
} from './OpenWorldTerrain';

// Module-scope zero-GC scratch objects
const _raycaster = new THREE.Raycaster();
const _hits: THREE.Intersection[] = [];
const _terrainSample = createTerrainSample();
const _marchPt = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();

/**
 * Shared Axon `IBodycamWorldAdapter` bridging the 4km Perimeter Operations streaming heightfield
 * and live Phase 3 AI squads into Axon's core `BodycamController`, `CharacterAnimator`,
 * `BallisticsSolver`, and `TacticalGrenadeSystem`.
 * - Zero per-frame heap allocations.
 */
export class OpenWorldBodycamAdapter implements IBodycamWorldAdapter {
  private readonly streamer: OpenWorldChunkStreamer;
  private readonly aiDirector: OpenWorldAiDirector;
  private readonly onAcoustic?: (origin: Readonly<THREE.Vector3>, radiusM: number, kind: BodycamAcousticKind) => void;

  constructor(
    streamer: OpenWorldChunkStreamer,
    aiDirector: OpenWorldAiDirector,
    onAcoustic?: (origin: Readonly<THREE.Vector3>, radiusM: number, kind: BodycamAcousticKind) => void,
  ) {
    this.streamer = streamer;
    this.aiDirector = aiDirector;
    this.onAcoustic = onAcoustic;
  }

  public getGroundHeight(x: number, z: number, _referenceY: number): number {
    return Math.max(SEA_LEVEL_M + 0.18, this.streamer.sampleGroundHeight(x, z));
  }

  public getSurfaceMaterial(x: number, _y: number, z: number): BodycamSurfaceMaterial {
    for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
      const lm = OPENWORLD_LANDMARKS[i];
      if (Math.hypot(x - lm.worldX, z - lm.worldZ) <= lm.padRadiusM * 0.45) {
        return 'concrete';
      }
    }
    sampleOpenWorldTerrain(x, z, _terrainSample);
    if (_terrainSample.isRoad) return 'asphalt';
    if (_terrainSample.isWater || _terrainSample.height < 1.8) return 'puddle';
    if (_terrainSample.isQuarryPit || _terrainSample.biome === 'alpine_ridge_dam') return 'gravel';
    return 'grass';
  }

  public sampleInterior(_x: number, _y: number, _z: number, outSample: BodycamInteriorSample): void {
    outSample.isIndoor = false;
    outSample.material = 'outdoor';
  }

  public hasOverheadClearance(): boolean {
    return true;
  }

  public emitAcousticEvent(
    origin: Readonly<THREE.Vector3>,
    radiusMeters: number,
    kind: BodycamAcousticKind,
  ): void {
    this.onAcoustic?.(origin, radiusMeters, kind);
  }

  public sweepCapsule(
    startPos: Readonly<THREE.Vector3>,
    deltaX: number,
    deltaY: number,
    deltaZ: number,
    _radius: number,
    _height: number,
    _maxStepUpM: number,
    outResult: BodycamCapsuleSweepResult,
  ): void {
    const bound = WORLD_HALF_M - 28;
    const rawX = startPos.x + deltaX;
    const rawZ = startPos.z + deltaZ;
    const clampedX = Math.max(-bound, Math.min(bound, rawX));
    const clampedZ = Math.max(-bound, Math.min(bound, rawZ));

    const hitWall = clampedX !== rawX || clampedZ !== rawZ;
    const groundY = this.getGroundHeight(clampedX, clampedZ, startPos.y);
    const targetY = startPos.y + deltaY;

    let finalY = targetY;
    let grounded = false;
    let steppedUp = false;
    let stepDeltaY = 0;

    if (finalY <= groundY + 0.04) {
      if (groundY > startPos.y + 0.02 && deltaY <= 0.05) {
        steppedUp = true;
        stepDeltaY = groundY - startPos.y;
      }
      finalY = groundY;
      grounded = true;
    }

    // Estimate terrain normal for realistic slope cadence & foot IK tilt
    const gx1 = this.streamer.sampleGroundHeight(clampedX + 0.75, clampedZ);
    const gz1 = this.streamer.sampleGroundHeight(clampedX, clampedZ + 0.75);
    _tmpNormal.set(groundY - gx1, 0.75, groundY - gz1).normalize();
    const groundNormalY = Math.max(0.2, Math.min(1, _tmpNormal.y));

    outResult.posX = clampedX;
    outResult.posY = finalY;
    outResult.posZ = clampedZ;
    outResult.grounded = grounded;
    outResult.hitWall = hitWall;
    outResult.hitCeiling = false;
    outResult.steppedUp = steppedUp;
    outResult.stepDeltaY = stepDeltaY;
    outResult.wallNormalX = hitWall ? -Math.sign(rawX) : 0;
    outResult.wallNormalZ = hitWall ? -Math.sign(rawZ) : 0;
    outResult.groundNormalY = groundNormalY;
    outResult.slopeAngleRad = Math.acos(groundNormalY);
  }

  public raycast(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    near: number,
    far: number,
    outResult: BodycamRaycastResult,
  ): boolean {
    outResult.hit = false;
    outResult.distance = far;
    outResult.object = null;

    let bestDist = far;
    let foundHit = false;

    // 1. Check live AI operator hit meshes first via Three.js Raycaster
    if (this.aiDirector.hitMeshes.length > 0) {
      _raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
      _raycaster.near = near;
      _raycaster.far = far;
      _hits.length = 0;
      _raycaster.intersectObjects(this.aiDirector.hitMeshes, false, _hits);

      for (let i = 0; i < _hits.length; i++) {
        const h = _hits[i];
        const aiId = h.object.userData?.openWorldAiId as string | undefined;
        // Skip dead ragdolling AI or hidden groups
        if (
          (aiId && !this.aiDirector.isAgentAlive(aiId)) ||
          !h.object.visible ||
          (h.object.parent && !h.object.parent.visible) ||
          (h.object.parent?.parent && !h.object.parent.parent.visible)
        ) {
          continue;
        }
        if (h.distance < bestDist) {
          bestDist = h.distance;
          foundHit = true;
          outResult.hit = true;
          outResult.distance = h.distance;
          outResult.pointX = h.point.x;
          outResult.pointY = h.point.y;
          outResult.pointZ = h.point.z;
          if (h.face) {
            _tmpNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
            outResult.normalX = _tmpNormal.x;
            outResult.normalY = _tmpNormal.y;
            outResult.normalZ = _tmpNormal.z;
          } else {
            outResult.normalX = -direction.x;
            outResult.normalY = -direction.y;
            outResult.normalZ = -direction.z;
          }
          outResult.surface = 'concrete';
          outResult.object = h.object;
          break;
        }
      }
    }

    // 2. Fast analytical heightfield raymarch against 4km terrain (coarse + binary refine)
    const maxTerrainDist = Math.min(bestDist, far);
    const stepSize = maxTerrainDist <= 8 ? 0.45 : maxTerrainDist <= 40 ? 1.5 : 3.5;
    let prevT = near;
    const startX = origin.x + direction.x * near;
    const startZ = origin.z + direction.z * near;
    const prevDiff = origin.y + direction.y * near - this.streamer.sampleGroundHeight(startX, startZ);

    if (prevDiff <= 0) {
      const gh = this.streamer.sampleGroundHeight(startX, startZ);
      outResult.hit = true;
      outResult.distance = near;
      outResult.pointX = startX;
      outResult.pointY = gh;
      outResult.pointZ = startZ;
      outResult.normalX = 0;
      outResult.normalY = 1;
      outResult.normalZ = 0;
      outResult.surface = this.getSurfaceMaterial(startX, gh, startZ);
      outResult.object = null;
      return true;
    }

    for (let t = near + stepSize; t <= maxTerrainDist; t += stepSize) {
      const px = origin.x + direction.x * t;
      const pz = origin.z + direction.z * t;
      const py = origin.y + direction.y * t;
      const gh = this.streamer.sampleGroundHeight(px, pz);
      const diff = py - gh;

      if (diff <= 0) {
        // Binary refine intersection point (5 iterations -> ~0.1m precision)
        let lo = prevT;
        let hi = t;
        for (let b = 0; b < 5; b++) {
          const mid = (lo + hi) * 0.5;
          _marchPt.set(
            origin.x + direction.x * mid,
            origin.y + direction.y * mid,
            origin.z + direction.z * mid,
          );
          const midH = this.streamer.sampleGroundHeight(_marchPt.x, _marchPt.z);
          if (_marchPt.y <= midH) hi = mid;
          else lo = mid;
        }

        const hitT = (lo + hi) * 0.5;
        if (hitT < bestDist) {
          const hx = origin.x + direction.x * hitT;
          const hz = origin.z + direction.z * hitT;
          const hy = this.streamer.sampleGroundHeight(hx, hz);
          const hx1 = this.streamer.sampleGroundHeight(hx + 1.0, hz);
          const hz1 = this.streamer.sampleGroundHeight(hx, hz + 1.0);
          _tmpNormal.set(hy - hx1, 1.0, hy - hz1).normalize();
          outResult.hit = true;
          outResult.distance = hitT;
          outResult.pointX = hx;
          outResult.pointY = hy;
          outResult.pointZ = hz;
          outResult.normalX = _tmpNormal.x;
          outResult.normalY = _tmpNormal.y;
          outResult.normalZ = _tmpNormal.z;
          outResult.surface = this.getSurfaceMaterial(hx, hy, hz);
          outResult.object = null;
          foundHit = true;
        }
        break;
      }

      prevT = t;
    }

    return foundHit;
  }
}

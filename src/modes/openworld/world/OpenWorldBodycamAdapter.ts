import * as THREE from 'three';
import {
  BodycamAcousticKind,
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamMeleeHitEvent,
  BodycamRaycastResult,
  BodycamSurfaceMaterial,
  IBodycamWorldAdapter,
} from '../../../../bodycam-sdk/types';
import { OpenWorldAiDirector } from './OpenWorldAiDirector';
import { OpenWorldChunkStreamer } from './OpenWorldChunkStreamer';
import type { OpenWorldConvoyDirector } from './OpenWorldConvoyDirector';
import type { OpenWorldEventDirector } from './OpenWorldEventDirector';
import type { WildlifeManager } from './WildlifeManager';
import type { OpenWorldFobDynamicProps } from './OpenWorldFobDynamicProps';
import {
  createObbRaycastHit,
  createRoadQueryResult,
  queryRoadNetwork,
  resolveCapsuleHorizontalAgainstObbs,
  SolidObb,
} from './OpenWorldCivilizationTopology';
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
const _roadScratch = createRoadQueryResult();
const _obbHitScratch = createObbRaycastHit();
const _capsuleScratch = { x: 0, z: 0, hitWall: false, wallNormalX: 0, wallNormalZ: 0 };
const _gateObbsScratch: SolidObb[] = [];
const _targetHitPointScratch = new THREE.Vector3();
const _targetHitNormalScratch = new THREE.Vector3();
const _marchPt = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();

/**
 * Shared Axon `IBodycamWorldAdapter` bridging the 4km Perimeter Operations streaming heightfield,
 * enterable settlement/gas-station/barn/checkpoint/bridge OBBs & WalkDecks, indoor acoustics,
 * and live Phase 3 AI squads into Axon's core `BodycamController`, `CharacterAnimator`,
 * `BallisticsSolver`, and `TacticalGrenadeSystem`.
 * - Zero per-frame heap allocations.
 */
export class OpenWorldBodycamAdapter implements IBodycamWorldAdapter {
  private readonly streamer: OpenWorldChunkStreamer;
  private readonly aiDirector: OpenWorldAiDirector;
  private readonly onAcoustic?: (origin: Readonly<THREE.Vector3>, radiusM: number, kind: BodycamAcousticKind) => void;
  private wildlifeManager: WildlifeManager | null = null;
  private convoyDirector: OpenWorldConvoyDirector | null = null;
  private eventDirector: OpenWorldEventDirector | null = null;
  private fobDynamicProps: OpenWorldFobDynamicProps | null = null;
  public onMeleeHit?: (event: Readonly<BodycamMeleeHitEvent>) => void;

  constructor(
    streamer: OpenWorldChunkStreamer,
    aiDirector: OpenWorldAiDirector,
    onAcoustic?: (origin: Readonly<THREE.Vector3>, radiusM: number, kind: BodycamAcousticKind) => void,
    wildlifeManager?: WildlifeManager | null,
  ) {
    this.streamer = streamer;
    this.aiDirector = aiDirector;
    this.onAcoustic = onAcoustic;
    this.wildlifeManager = wildlifeManager ?? null;
  }

  public setWildlifeManager(manager: WildlifeManager | null): void {
    this.wildlifeManager = manager;
  }

  public setConvoyDirector(director: OpenWorldConvoyDirector | null): void {
    this.convoyDirector = director;
  }

  public setEventDirector(director: OpenWorldEventDirector | null): void {
    this.eventDirector = director;
  }

  public setFobDynamicProps(props: OpenWorldFobDynamicProps | null): void {
    this.fobDynamicProps = props;
  }

  public getGroundHeight(x: number, z: number, referenceY: number): number {
    return Math.max(SEA_LEVEL_M + 0.18, this.streamer.sampleGroundAndDeckHeight(x, z, referenceY));
  }

  public getSurfaceMaterial(x: number, y: number, z: number): BodycamSurfaceMaterial {
    // 1. Enterable building floors, gas forecourts, and elevated bridge decks
    const deckSurface = this.streamer.sampleWalkDeckSurface(x, z, y);
    if (deckSurface) return deckSurface;

    // 2. Interconnected Road Network (Route 41 Highway & FOB Spurs = asphalt, Dirt Trails = gravel)
    queryRoadNetwork(x, z, _roadScratch);
    if (_roadScratch.onRoad || _roadScratch.onBridge) {
      return _roadScratch.tier === 'dirt_trail' ? 'gravel' : 'asphalt';
    }

    // 3. Major FOB / Industrial concrete landmark pads
    for (let i = 0; i < OPENWORLD_LANDMARKS.length; i++) {
      const lm = OPENWORLD_LANDMARKS[i];
      if (Math.hypot(x - lm.worldX, z - lm.worldZ) <= lm.padRadiusM * 0.45) {
        return 'concrete';
      }
    }

    // 4. Natural 4-biome terrain surface
    sampleOpenWorldTerrain(x, z, _terrainSample);
    if (_terrainSample.isRoad) {
      return _terrainSample.roadTier === 'dirt_trail' ? 'gravel' : 'asphalt';
    }
    if (_terrainSample.isWater || _terrainSample.height < 1.8) return 'puddle';
    if (_terrainSample.isQuarryPit || _terrainSample.biome === 'alpine_ridge_dam') return 'gravel';
    return 'grass';
  }

  public sampleInterior(x: number, y: number, z: number, outSample: BodycamInteriorSample): void {
    this.streamer.sampleIndoorAt(x, y, z, outSample);
  }

  public hasOverheadClearance(
    x: number,
    baseY: number,
    z: number,
    radius: number,
    crouchHeight: number,
    standHeight: number,
  ): boolean {
    return this.streamer.hasOverheadClearance(x, baseY, z, radius, crouchHeight, standHeight);
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
    radius: number,
    height: number,
    maxStepUpM: number,
    outResult: BodycamCapsuleSweepResult,
  ): void {
    const bound = WORLD_HALF_M - 28;
    const rawX = startPos.x + deltaX;
    const rawZ = startPos.z + deltaZ;
    let resolvedX = Math.max(-bound, Math.min(bound, rawX));
    let resolvedZ = Math.max(-bound, Math.min(bound, rawZ));

    let hitWall = resolvedX !== rawX || resolvedZ !== rawZ;
    let wallNx = hitWall ? -Math.sign(rawX) : 0;
    let wallNz = hitWall ? -Math.sign(rawZ) : 0;

    // Resolve horizontal capsule slide against all active chunk walls, vehicles, barriers & bridge rails
    // (Leaves open doorways >= 1.45m wide cleanly passable!)
    this.streamer.resolveCapsuleHorizontal(
      resolvedX,
      startPos.y,
      resolvedZ,
      radius,
      height,
      maxStepUpM,
      _capsuleScratch,
    );
    resolvedX = _capsuleScratch.x;
    resolvedZ = _capsuleScratch.z;
    if (_capsuleScratch.hitWall) {
      hitWall = true;
      wallNx = _capsuleScratch.wallNormalX;
      wallNz = _capsuleScratch.wallNormalZ;
    }

    if (this.fobDynamicProps) {
      this.fobDynamicProps.resolveClosedGateObbs(_gateObbsScratch);
      if (_gateObbsScratch.length > 0) {
        resolveCapsuleHorizontalAgainstObbs(
          _gateObbsScratch,
          resolvedX,
          startPos.y,
          resolvedZ,
          radius,
          height,
          maxStepUpM,
          _capsuleScratch,
        );
        resolvedX = _capsuleScratch.x;
        resolvedZ = _capsuleScratch.z;
        if (_capsuleScratch.hitWall) {
          hitWall = true;
          wallNx = _capsuleScratch.wallNormalX;
          wallNz = _capsuleScratch.wallNormalZ;
        }
      }
    }

    const groundY = this.getGroundHeight(resolvedX, resolvedZ, startPos.y);
    const targetY = startPos.y + deltaY;

    let finalY = targetY;
    let grounded = false;
    let steppedUp = false;
    let stepDeltaY = 0;
    let hitCeiling = false;

    // Ceiling check when moving upward inside buildings / beneath canopies
    if (deltaY > 0.001) {
      const clearUp = this.streamer.hasOverheadClearance(
        resolvedX,
        startPos.y,
        resolvedZ,
        radius * 0.85,
        height * 0.65,
        height + deltaY,
      );
      if (!clearUp) {
        finalY = startPos.y;
        hitCeiling = true;
      }
    }

    if (finalY <= groundY + 0.04) {
      if (groundY > startPos.y + 0.02 && deltaY <= 0.05) {
        steppedUp = true;
        stepDeltaY = groundY - startPos.y;
      }
      finalY = groundY;
      grounded = true;
    }

    // Estimate walkable deck/terrain normal for realistic slope cadence & foot IK tilt
    const gx1 = this.getGroundHeight(resolvedX + 0.65, resolvedZ, finalY);
    const gz1 = this.getGroundHeight(resolvedX, resolvedZ + 0.65, finalY);
    _tmpNormal.set(groundY - gx1, 0.65, groundY - gz1).normalize();
    const groundNormalY = Math.max(0.2, Math.min(1, _tmpNormal.y));

    outResult.posX = resolvedX;
    outResult.posY = finalY;
    outResult.posZ = resolvedZ;
    outResult.grounded = grounded;
    outResult.hitWall = hitWall;
    outResult.hitCeiling = hitCeiling;
    outResult.steppedUp = steppedUp;
    outResult.stepDeltaY = stepDeltaY;
    outResult.wallNormalX = wallNx;
    outResult.wallNormalZ = wallNz;
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

    // 1. Check live nearby AI operator hit meshes first via Three.js Raycaster
    const aiHitMeshes =
      typeof this.aiDirector.getRaycastHitMeshes === 'function'
        ? this.aiDirector.getRaycastHitMeshes()
        : this.aiDirector.hitMeshes;
    if (aiHitMeshes.length > 0) {
      _raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
      _raycaster.near = near;
      _raycaster.far = far;
      _hits.length = 0;
      _raycaster.intersectObjects(aiHitMeshes, false, _hits);

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

    // 1b. Check live wildlife hitboxes (wolves & deer)
    if (this.wildlifeManager && this.wildlifeManager.hitMeshes.length > 0) {
      _raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
      _raycaster.near = near;
      _raycaster.far = bestDist;
      _hits.length = 0;
      _raycaster.intersectObjects(this.wildlifeManager.hitMeshes, false, _hits);

      for (let i = 0; i < _hits.length; i++) {
        const h = _hits[i];
        const wildlifeId = h.object.userData?.openWorldWildlifeId as string | undefined;
        if (!wildlifeId || !this.wildlifeManager.isEntityAlive(wildlifeId) || !h.object.visible) {
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
          outResult.normalX = -direction.x;
          outResult.normalY = -direction.y;
          outResult.normalZ = -direction.z;
          outResult.surface = 'grass';
          outResult.object = h.object;
          break;
        }
      }
    }

    // 1c. Check live Convoy Escort & Dynamic World Event guard hitboxes
    const extraLists: ReadonlyArray<THREE.Object3D[]> = [
      this.convoyDirector ? this.convoyDirector.hitMeshes : [],
      this.eventDirector ? this.eventDirector.hitMeshes : [],
    ];
    for (let lIdx = 0; lIdx < extraLists.length; lIdx++) {
      const list = extraLists[lIdx];
      if (list.length === 0) continue;
      _raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
      _raycaster.near = near;
      _raycaster.far = bestDist;
      _hits.length = 0;
      _raycaster.intersectObjects(list, false, _hits);
      for (let i = 0; i < _hits.length; i++) {
        const h = _hits[i];
        if (!h.object.visible || (h.object.parent && !h.object.parent.visible)) continue;
        if (h.distance < bestDist) {
          bestDist = h.distance;
          foundHit = true;
          outResult.hit = true;
          outResult.distance = h.distance;
          outResult.pointX = h.point.x;
          outResult.pointY = h.point.y;
          outResult.pointZ = h.point.z;
          outResult.normalX = -direction.x;
          outResult.normalY = -direction.y;
          outResult.normalZ = -direction.z;
          outResult.surface = 'concrete';
          outResult.object = h.object;
          break;
        }
      }
    }

    // 2. Zero-GC analytical Ray-vs-OBB test against all active buildings, vehicles, fuel pumps, barriers & bridges
    //    (Stops shots behind solid cover while open doorways & waist-high window bays pass straight through!)
    _obbHitScratch.hit = false;
    _obbHitScratch.distance = bestDist;
    if (
      this.streamer.raycastActiveStructures(
        origin.x,
        origin.y,
        origin.z,
        direction.x,
        direction.y,
        direction.z,
        near,
        _obbHitScratch,
      ) &&
      _obbHitScratch.distance < bestDist
    ) {
      bestDist = _obbHitScratch.distance;
      foundHit = true;
      outResult.hit = true;
      outResult.distance = _obbHitScratch.distance;
      outResult.pointX = _obbHitScratch.pointX;
      outResult.pointY = _obbHitScratch.pointY;
      outResult.pointZ = _obbHitScratch.pointZ;
      outResult.normalX = _obbHitScratch.normalX;
      outResult.normalY = _obbHitScratch.normalY;
      outResult.normalZ = _obbHitScratch.normalZ;
      outResult.surface = _obbHitScratch.surface;
      outResult.object = null;
    }

    // 2b. Check closed FOB checkpoint boom gates & reactive steel gun-range / CQB targets
    if (this.fobDynamicProps) {
      _obbHitScratch.hit = false;
      _obbHitScratch.distance = bestDist;
      if (
        this.fobDynamicProps.raycastClosedGates(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          near,
          _obbHitScratch,
        ) &&
        _obbHitScratch.distance < bestDist
      ) {
        bestDist = _obbHitScratch.distance;
        foundHit = true;
        outResult.hit = true;
        outResult.distance = _obbHitScratch.distance;
        outResult.pointX = _obbHitScratch.pointX;
        outResult.pointY = _obbHitScratch.pointY;
        outResult.pointZ = _obbHitScratch.pointZ;
        outResult.normalX = _obbHitScratch.normalX;
        outResult.normalY = _obbHitScratch.normalY;
        outResult.normalZ = _obbHitScratch.normalZ;
        outResult.surface = 'metal';
        outResult.object = null;
      }

      const targetHit = this.fobDynamicProps.raycastTargets(
        origin,
        direction,
        near,
        bestDist,
        _targetHitPointScratch,
        _targetHitNormalScratch,
      );
      if (targetHit.hit && targetHit.distance < bestDist) {
        bestDist = targetHit.distance;
        foundHit = true;
        outResult.hit = true;
        outResult.distance = targetHit.distance;
        outResult.pointX = _targetHitPointScratch.x;
        outResult.pointY = _targetHitPointScratch.y;
        outResult.pointZ = _targetHitPointScratch.z;
        outResult.normalX = _targetHitNormalScratch.x;
        outResult.normalY = _targetHitNormalScratch.y;
        outResult.normalZ = _targetHitNormalScratch.z;
        outResult.surface = 'metal';
        outResult.object = targetHit.object;
      }
    }

    // 3. Fast analytical heightfield/deck raymarch against 4km terrain & bridge decks (coarse + binary refine)
    const maxTerrainDist = Math.min(bestDist, far);
    const stepSize = maxTerrainDist <= 8 ? 0.45 : maxTerrainDist <= 40 ? 1.5 : 3.5;
    let prevT = near;
    const startX = origin.x + direction.x * near;
    const startY = origin.y + direction.y * near;
    const startZ = origin.z + direction.z * near;
    const startGround = this.streamer.sampleGroundAndDeckHeight(startX, startZ, startY);
    const prevDiff = startY - startGround;

    if (prevDiff <= 0 && near < bestDist) {
      outResult.hit = true;
      outResult.distance = near;
      outResult.pointX = startX;
      outResult.pointY = startGround;
      outResult.pointZ = startZ;
      outResult.normalX = 0;
      outResult.normalY = 1;
      outResult.normalZ = 0;
      outResult.surface = this.getSurfaceMaterial(startX, startGround, startZ);
      outResult.object = null;
      return true;
    }

    for (let t = near + stepSize; t <= maxTerrainDist; t += stepSize) {
      const px = origin.x + direction.x * t;
      const py = origin.y + direction.y * t;
      const pz = origin.z + direction.z * t;
      const gh = this.streamer.sampleGroundAndDeckHeight(px, pz, py);
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
          const midH = this.streamer.sampleGroundAndDeckHeight(_marchPt.x, _marchPt.z, _marchPt.y);
          if (_marchPt.y <= midH) hi = mid;
          else lo = mid;
        }

        const hitT = (lo + hi) * 0.5;
        if (hitT < bestDist) {
          const hx = origin.x + direction.x * hitT;
          const hz = origin.z + direction.z * hitT;
          const hy = this.streamer.sampleGroundAndDeckHeight(hx, hz, origin.y + direction.y * hitT);
          const hx1 = this.streamer.sampleGroundAndDeckHeight(hx + 1.0, hz, hy);
          const hz1 = this.streamer.sampleGroundAndDeckHeight(hx, hz + 1.0, hy);
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

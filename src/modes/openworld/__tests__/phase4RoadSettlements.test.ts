import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type {
  BodycamCapsuleSweepResult,
  BodycamInteriorSample,
  BodycamRaycastResult,
} from '../../../../bodycam-sdk/types';
import { OpenWorldAiDirector } from '../world/OpenWorldAiDirector';
import { OpenWorldBodycamAdapter } from '../world/OpenWorldBodycamAdapter';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import {
  createRoadQueryResult,
  getBakedHorizonTowers,
  getBakedOpenWorldSites,
  getBakedRiverBridges,
  getBakedRoadSegments,
  isOnCivilizationClearance,
  queryBridgeDeckHeight,
  queryRoadNetwork,
} from '../world/OpenWorldCivilizationTopology';
import {
  createTerrainSample,
  evaluateOpenWorldHeight,
  evaluateRawOpenWorldHeight,
  sampleOpenWorldTerrain,
  SEA_LEVEL_M,
} from '../world/OpenWorldTerrain';

function makeSweepResult(): BodycamCapsuleSweepResult {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    grounded: false,
    hitWall: false,
    hitCeiling: false,
    steppedUp: false,
    stepDeltaY: 0,
    wallNormalX: 0,
    wallNormalZ: 0,
    groundNormalY: 1,
    slopeAngleRad: 0,
  };
}

function makeInteriorSample(): BodycamInteriorSample {
  return { isIndoor: false, material: 'outdoor' };
}

function makeRaycastResult(): BodycamRaycastResult {
  return {
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
}

function localToWorld(
  site: { x: number; z: number; yaw: number },
  lx: number,
  lz: number,
): { x: number; z: number } {
  const c = Math.cos(site.yaw);
  const s = Math.sin(site.yaw);
  return {
    x: site.x + lx * c + lz * s,
    z: site.z - lx * s + lz * c,
  };
}

describe('Open World Phase 4 — Road Network, Enterable Settlements & Roadside Infrastructure', () => {
  it('bakes interconnected Route 41 Highway, FOB spurs, 5 dirt trails, 3 river bridges, 36 enterable sites & 8 horizon towers', () => {
    // Trigger idempotent topology bake via terrain evaluator
    evaluateOpenWorldHeight(0, 0);

    const segments = getBakedRoadSegments();
    const bridges = getBakedRiverBridges();
    const sites = getBakedOpenWorldSites();
    const towers = getBakedHorizonTowers();

    expect(segments.length).toBeGreaterThan(220);
    expect(bridges).toHaveLength(3);
    expect(sites.length).toBe(43);
    expect(sites.filter((s) => s.kind === 'gas_station')).toHaveLength(4);
    expect(sites.filter((s) => s.kind === 'checkpoint')).toHaveLength(5);
    expect(sites.filter((s) => s.kind === 'barn')).toHaveLength(5);
    expect(sites.filter((s) => s.kind === 'camp_outpost')).toHaveLength(8);
    expect(
      sites.filter(
        (s) =>
          s.kind === 'house_cabin' ||
          s.kind === 'house_bungalow' ||
          s.kind === 'house_homestead',
      ),
    ).toHaveLength(21);

    expect(towers).toHaveLength(8);
    expect(towers.filter((t) => t.kind === 'water_tower')).toHaveLength(4);
    expect(towers.filter((t) => t.kind === 'radio_mast')).toHaveLength(4);
    for (const mast of towers.filter((t) => t.kind === 'radio_mast')) {
      expect(mast.heightM).toBeGreaterThanOrEqual(54);
    }

    // Route 41 highway surface & dirt trail surface classification
    const roadQ = createRoadQueryResult();
    queryRoadNetwork(-320, 620, roadQ); // Pine Valley Junction on Route 41
    expect(roadQ.onRoad).toBe(true);
    expect(roadQ.tier).toBe('highway');

    queryRoadNetwork(-760, 120, roadQ); // West Pine Logging Trail
    expect(roadQ.onRoad).toBe(true);
    expect(roadQ.tier).toBe('dirt_trail');

    // Corridor clearance protects roads & sites from vegetation spawning
    expect(isOnCivilizationClearance(-320, 620)).toBe(true);
    expect(isOnCivilizationClearance(-400, 960)).toBe(true);
  });

  it('elevates all 3 steel-truss river bridges safely above the carved river water channel', () => {
    evaluateOpenWorldHeight(0, 0);
    const bridges = getBakedRiverBridges();
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    for (const b of bridges) {
      streamer.update(b.centerX, b.centerZ);
      const q = queryBridgeDeckHeight(b.centerX, b.centerZ);
      expect(q.onBridge).toBe(true);
      expect(q.deckY).toBeGreaterThan(SEA_LEVEL_M + 4.5);

      const rawRiverBed = evaluateRawOpenWorldHeight(b.centerX, b.centerZ);
      expect(q.deckY).toBeGreaterThan(rawRiverBed + 4.0);

      // Streamer ground height elevates operators/AI seamlessly onto the bridge deck
      const sampledDeckH = streamer.sampleGroundAndDeckHeight(b.centerX, b.centerZ, q.deckY);
      expect(Math.abs(sampledDeckH - q.deckY)).toBeLessThan(0.25);
      expect(streamer.sampleWalkDeckSurface(b.centerX, b.centerZ, q.deckY)).toBe('asphalt');
    }

    streamer.dispose();
  });

  it('supports enterable residential houses: open doorway pass-through, solid wall slide, window shooting & indoor wood acoustics', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);
    const aiStub = {
      hitMeshes: [] as THREE.Mesh[],
      isAgentAlive: () => false,
    } as unknown as OpenWorldAiDirector;
    const adapter = new OpenWorldBodycamAdapter(streamer, aiStub);

    const bungalow = getBakedOpenWorldSites().find((s) => s.id === 'house_pine_3')!;
    expect(bungalow).toBeDefined();
    streamer.update(bungalow.x, bungalow.z);

    // 1. Site pad terrain is cleanly graded around the house footprint
    const padCenterH = evaluateOpenWorldHeight(bungalow.x, bungalow.z);
    const padEdge = localToWorld(bungalow, 3.0, 2.0);
    expect(Math.abs(evaluateOpenWorldHeight(padEdge.x, padEdge.z) - padCenterH)).toBeLessThan(1.2);

    // 2. Capsule walks cleanly through the open +Z front doorway (local x=0, z=+4.6 -> z=+2.1)
    const outsideDoor = localToWorld(bungalow, 0, 4.6);
    const insideDoor = localToWorld(bungalow, 0, 2.1);
    const startY = adapter.getGroundHeight(outsideDoor.x, outsideDoor.z, bungalow.groundY + 0.5);
    const sweepRes = makeSweepResult();

    // Step across the front doorway threshold in small realistic steps
    const cur = new THREE.Vector3(outsideDoor.x, startY, outsideDoor.z);
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      adapter.sweepCapsule(
        cur,
        (insideDoor.x - outsideDoor.x) / steps,
        -0.02,
        (insideDoor.z - outsideDoor.z) / steps,
        0.34,
        1.76,
        0.35,
        sweepRes,
      );
      cur.set(sweepRes.posX, sweepRes.posY, sweepRes.posZ);
    }
    expect(Math.hypot(cur.x - insideDoor.x, cur.z - insideDoor.z)).toBeLessThan(0.35);

    // 3. Inside house triggers indoor wood acoustics & wood floor footsteps
    const interior = makeInteriorSample();
    adapter.sampleInterior(cur.x, cur.y + 1.0, cur.z, interior);
    expect(interior.isIndoor).toBe(true);
    expect(interior.material).toBe('wood');
    expect(adapter.getSurfaceMaterial(cur.x, cur.y, cur.z)).toBe('wood');

    // Outside yard is outdoor
    adapter.sampleInterior(outsideDoor.x, startY + 1.0, outsideDoor.z, interior);
    expect(interior.isIndoor).toBe(false);
    expect(interior.material).toBe('outdoor');

    // 4. Attempting to walk directly through solid front wall corner (local x=3.2, z=+4.5 -> z=+2.5) is blocked!
    const outsideWall = localToWorld(bungalow, 3.2, 4.5);
    const behindWall = localToWorld(bungalow, 3.2, 2.5);
    const wallCur = new THREE.Vector3(
      outsideWall.x,
      adapter.getGroundHeight(outsideWall.x, outsideWall.z, bungalow.groundY + 0.5),
      outsideWall.z,
    );
    let wallBlocked = false;
    for (let i = 0; i < 6; i++) {
      adapter.sweepCapsule(
        wallCur,
        (behindWall.x - outsideWall.x) / 6,
        -0.02,
        (behindWall.z - outsideWall.z) / 6,
        0.34,
        1.76,
        0.35,
        sweepRes,
      );
      if (sweepRes.hitWall) wallBlocked = true;
      wallCur.set(sweepRes.posX, sweepRes.posY, sweepRes.posZ);
    }
    expect(wallBlocked).toBe(true);
    expect(Math.hypot(wallCur.x - behindWall.x, wallCur.z - behindWall.z)).toBeGreaterThan(0.8);

    // 5. Raycast bullet cover: solid wall stops bullet, open waist-high side window lets bullet pass!
    const rayRes = makeRaycastResult();
    const shotFrom = localToWorld(bungalow, 3.2, 5.5);
    const shotTowardWall = localToWorld(bungalow, 3.2, 1.0);
    const dirWall = new THREE.Vector3(shotTowardWall.x - shotFrom.x, 0, shotTowardWall.z - shotFrom.z).normalize();
    const hitWall = adapter.raycast(
      new THREE.Vector3(shotFrom.x, bungalow.groundY + 1.45, shotFrom.z),
      dirWall,
      0.1,
      12,
      rayRes,
    );
    expect(hitWall).toBe(true);
    expect(rayRes.surface).toBe('wood');
    expect(rayRes.distance).toBeLessThan(3.0);

    // Shot through left (-X) waist-high window opening at chest height (local z=0, y=+1.65m above ground)
    const winFrom = localToWorld(bungalow, -7.2, 0);
    const winThrough = localToWorld(bungalow, -1.0, 0);
    const dirWin = new THREE.Vector3(winThrough.x - winFrom.x, 0, winThrough.z - winFrom.z).normalize();
    const hitWin = adapter.raycast(
      new THREE.Vector3(winFrom.x, bungalow.groundY + 1.65, winFrom.z),
      dirWin,
      0.1,
      5.5,
      rayRes,
    );
    // Passes cleanly through the open window bay without hitting the exterior wall at ~2.0m!
    expect(hitWin).toBe(false);

    streamer.dispose();
  });

  it('builds enterable gas stations & military checkpoints with concrete interiors, ballistic cover & night emissive sync', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);
    const aiStub = {
      hitMeshes: [] as THREE.Mesh[],
      isAgentAlive: () => false,
    } as unknown as OpenWorldAiDirector;
    const adapter = new OpenWorldBodycamAdapter(streamer, aiStub);

    const gas = getBakedOpenWorldSites().find((s) => s.id === 'gas_pine_valley')!;
    expect(gas).toBeDefined();
    streamer.update(gas.x, gas.z);

    // Concrete forecourt surface under canopy
    const forecourt = localToWorld(gas, 0, 4.8);
    expect(adapter.getSurfaceMaterial(forecourt.x, gas.groundY + 0.2, forecourt.z)).toBe('concrete');

    // Inside mini-mart store (-6.2m Z) triggers indoor concrete acoustics
    const insideStore = localToWorld(gas, 0, -6.2);
    const interior = makeInteriorSample();
    adapter.sampleInterior(insideStore.x, gas.groundY + 1.4, insideStore.z, interior);
    expect(interior.isIndoor).toBe(true);
    expect(interior.material).toBe('concrete');

    // Fuel dispenser island provides solid metal ballistic cover
    const pumpFrom = localToWorld(gas, -6.0, 3.3);
    const pumpTo = localToWorld(gas, -1.0, 3.3);
    const pumpDir = new THREE.Vector3(pumpTo.x - pumpFrom.x, 0, pumpTo.z - pumpFrom.z).normalize();
    const rayRes = makeRaycastResult();
    const hitPump = adapter.raycast(
      new THREE.Vector3(pumpFrom.x, gas.groundY + 1.0, pumpFrom.z),
      pumpDir,
      0.1,
      8.0,
      rayRes,
    );
    expect(hitPump).toBe(true);
    expect(rayRes.surface).toBe('metal');

    // Military checkpoint guard shack interior acoustics
    const cp = getBakedOpenWorldSites().find((s) => s.id === 'cp_alpha_gate')!;
    streamer.update(cp.x, cp.z);
    const insideShack = localToWorld(cp, 6.8, 0);
    adapter.sampleInterior(insideShack.x, cp.groundY + 1.3, insideShack.z, interior);
    expect(interior.isIndoor).toBe(true);
    expect(interior.material).toBe('concrete');

    // Footstep surface materials along Route 41 Highway vs Dirt Trail
    const sample = createTerrainSample();
    sampleOpenWorldTerrain(-320, 620, sample);
    expect(sample.roadTier).toBe('highway');
    expect(adapter.getSurfaceMaterial(-320, sample.height, 620)).toBe('asphalt');
    expect(adapter.getSurfaceMaterial(-760, evaluateOpenWorldHeight(-760, 120), 120)).toBe('gravel');

    // Night emissive sync ramps shared material intensity cleanly with zero PointLights
    streamer.setNightFactor(0.0);
    const dayGlow = streamer.getStreetlightEmissiveIntensity();
    streamer.setNightFactor(1.0);
    const nightGlow = streamer.getStreetlightEmissiveIntensity();
    expect(nightGlow).toBeGreaterThan(dayGlow + 1.5);

    // Zero PointLights added by streamer architecture
    let pointLights = 0;
    scene.traverse((obj) => {
      if (obj instanceof THREE.PointLight) pointLights++;
    });
    expect(pointLights).toBe(0);

    // Explicit disposal accounting
    const statsBefore = streamer.getStats();
    expect(statsBefore.totalLoadedChunks).toBe(25);
    streamer.dispose();
    expect(streamer.getStats().totalLoadedChunks).toBe(0);
    expect(streamer.getStats().disposedChunkCount).toBeGreaterThanOrEqual(25);
  });
});

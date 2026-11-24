import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { BodycamAudio } from '../../../../bodycam-sdk/BodycamAudio';
import { OpenWorldAiDirector } from '../world/OpenWorldAiDirector';
import { OpenWorldAmbienceAudio } from '../world/OpenWorldAmbienceAudio';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import {
  getBakedOpenWorldSites,
  getBakedRoadSegments,
  SolidObb,
} from '../world/OpenWorldCivilizationTopology';
import { getFobCompoundSpec } from '../world/OpenWorldFobLayout';
import {
  isEligibleOccluderObb,
  OpenWorldOcclusionCuller,
} from '../world/OpenWorldOcclusionCuller';
import {
  evaluateOpenWorldHeight,
  OPENWORLD_LANDMARKS,
} from '../world/OpenWorldTerrain';
import {
  classifyInsectHabitat,
  isDeerWildernessHabitat,
  WildlifeManager,
} from '../world/WildlifeManager';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    const createMockCanvas = () => ({
      width: 128,
      height: 128,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
        }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        putImageData: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        ellipse: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        strokeText: () => {},
        measureText: () => ({ width: 10 }),
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        drawImage: () => {},
        setLineDash: () => {},
      }),
    });
    (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document = {
      createElement: () => createMockCanvas(),
    };
  }
});

function makeWallObb(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  yaw = 0,
): SolidObb {
  return {
    cx,
    cy,
    cz,
    hx,
    hy,
    hz,
    cosY: Math.cos(yaw),
    sinY: Math.sin(yaw),
    blocksPlayer: true,
    blocksBullets: true,
    surface: 'concrete',
  };
}

describe('Open World Occlusion Culling & Wilderness/Building Fauna Habitats', () => {
  it('occludes assets strictly behind large solid structures while keeping open doorways and close objects visible', () => {
    const culler = new OpenWorldOcclusionCuller();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
    camera.position.set(0, 1.7, 0);
    camera.lookAt(0, 1.7, -50);
    camera.updateMatrixWorld(true);

    // Two solid wall wings at z = -8 flanking a 2.6m wide open doorway at x in [-1.3, +1.3]
    const leftWall = makeWallObb(-7.3, 3.0, -8, 6.0, 3.5, 0.35);
    const rightWall = makeWallObb(7.3, 3.0, -8, 6.0, 3.5, 0.35);
    expect(isEligibleOccluderObb(leftWall)).toBe(true);
    expect(isEligibleOccluderObb(makeWallObb(0, 0.4, -8, 1.0, 0.4, 0.2))).toBe(false);

    culler.beginFrame(camera, 0, 1.7, 0);
    culler.addOccluderObb(leftWall);
    culler.addOccluderObb(rightWall);
    culler.finalizeOccluders();

    const stats = culler.getStats();
    expect(stats.occluderCount).toBe(2);
    expect(stats.coverageRatio).toBeGreaterThan(0.2);

    // 1. Target directly behind the solid left wall wing -> OCCLUDED
    const behindLeftWall = new THREE.Box3(
      new THREE.Vector3(-12, 0.5, -35),
      new THREE.Vector3(-8, 4.0, -31),
    );
    expect(culler.isBoxOccluded(behindLeftWall, 10)).toBe(true);
    expect(culler.isSphereOccluded(-10, 2.0, -32, 1.2, 10)).toBe(true);

    // 2. Target visible straight through the open doorway -> NOT occluded!
    const throughDoorway = new THREE.Box3(
      new THREE.Vector3(-0.6, 0.5, -35),
      new THREE.Vector3(0.6, 2.5, -33),
    );
    expect(culler.isBoxOccluded(throughDoorway, 10)).toBe(false);
    expect(culler.isSphereOccluded(0, 1.7, -34, 1.0, 10)).toBe(false);

    // 3. Target in FRONT of the wall -> NOT occluded!
    const inFront = new THREE.Box3(
      new THREE.Vector3(-4, 0.5, -5.5),
      new THREE.Vector3(-3, 2.0, -4.5),
    );
    expect(culler.isBoxOccluded(inFront, 2)).toBe(false);

    // 4. Target within safety halo (12m) -> NEVER occluded
    const closeTarget = new THREE.Box3(
      new THREE.Vector3(-4, 0.5, -10.5),
      new THREE.Vector3(-3, 2.0, -9.5),
    );
    expect(culler.isBoxOccluded(closeTarget, 12)).toBe(false);
  });

  it('detects full-screen indoor solid wall occlusion and culls distant chunks, landmarks, AI, and wildlife behind structures', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);
    const culler = new OpenWorldOcclusionCuller();

    // Place camera just south of the massive Hydroelectric Dam wall looking straight through it toward far north chunks
    const dam = OPENWORLD_LANDMARKS.find((l) => l.kind === 'dam')!;
    const damBaseH = evaluateOpenWorldHeight(dam.worldX, dam.worldZ);
    const camX = dam.worldX;
    const camY = damBaseH + 12;
    const camZ = dam.worldZ + 18;

    streamer.update(camX, camZ, true);

    const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 3500);
    camera.position.set(camX, camY, camZ);
    camera.lookAt(camX, camY, camZ - 200);
    camera.updateMatrixWorld(true);

    // Without occlusion culler: frustum culling alone keeps chunks ahead visible
    const frustumOnly = streamer.applyCameraCullingAndLods(camera, camX, camZ, false);

    // With occlusion culler: Dam wall (220m x 52m) blocks chunks & assets strictly behind it
    streamer.prepareOcclusionCuller(culler, camera, camX, camY, camZ);
    const withOcclusion = streamer.applyCameraCullingAndLods(camera, camX, camZ, false, culler);

    expect(culler.getStats().occluderCount).toBeGreaterThan(0);
    expect(withOcclusion.occludedChunks + withOcclusion.occludedObjects).toBeGreaterThan(0);
    expect(withOcclusion.visibleChunks).toBeLessThanOrEqual(frustumOnly.visibleChunks);

    // Full-screen wall check: standing 2m directly in front of a massive solid wall occludes entire screen beyond 45m
    const indoorCamera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
    indoorCamera.position.set(0, 1.7, 0);
    indoorCamera.lookAt(0, 1.7, -10);
    indoorCamera.updateMatrixWorld(true);

    culler.beginFrame(indoorCamera, 0, 1.7, 0);
    culler.addOccluderObb(makeWallObb(0, 2.5, -2.5, 16, 8, 0.4));
    culler.finalizeOccluders();
    expect(culler.isScreenFullyOccludedBeyond(indoorCamera, 45)).toBe(true);

    // Verify AI operator & wildlife rigs behind that solid wall are hidden by occlusion culling
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, () => 0, ambience, true);
    wildlife.spawnDeerHerdAt(0, -34, 2);
    wildlife.spawnWolfPackAt(0, -38, 2);
    wildlife.update({
      dt: 0.05,
      elapsedSec: 1.0,
      timeOfDayHours: 12.0,
      nightFactor: 0,
      windSpeedMps: 2,
      isRaining: false,
      playerX: 0,
      playerY: 1.7,
      playerZ: 0,
      playerYawRad: 0,
      playerSpeedMps: 0,
      playerCrouched: false,
      playerSprinting: false,
      playerAlive: true,
      playerOnFoot: true,
      flashlightOn: false,
      occlusionCuller: culler,
    });
    // Every alive deer and wolf strictly behind the wall (>14m away) must be hidden
    let hiddenWildlifeCount = 0;
    wildlife.rootGroup.traverse((obj) => {
      if (obj.name === '' && obj.parent === wildlife.rootGroup && !obj.visible) {
        hiddenWildlifeCount++;
      }
    });
    expect(hiddenWildlifeCount).toBeGreaterThanOrEqual(4);

    // Verify OpenWorldAiDirector hides occluded operators behind solid walls
    const ai = new OpenWorldAiDirector(scene, () => 0, 'pmc_alpha', 1);
    const agents = ai.getAliveAgents();
    expect(agents.length).toBeGreaterThan(0);
    const firstAgent = agents[0];
    const aiCam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
    aiCam.position.set(firstAgent.x, firstAgent.y + 1.7, firstAgent.z + 32);
    aiCam.lookAt(firstAgent.x, firstAgent.y + 1.2, firstAgent.z);
    aiCam.updateMatrixWorld(true);

    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(aiCam.projectionMatrix, aiCam.matrixWorldInverse),
    );
    culler.beginFrame(aiCam, aiCam.position.x, aiCam.position.y, aiCam.position.z);
    // Solid blast wall between camera and the operator
    culler.addOccluderObb(makeWallObb(firstAgent.x, firstAgent.y + 2.5, firstAgent.z + 12, 12, 4.5, 0.5));
    culler.finalizeOccluders();

    ai.update(
      0.016,
      aiCam.position.x,
      aiCam.position.y,
      aiCam.position.z,
      true,
      true,
      false,
      1.0,
      false,
      null,
      () => {},
      { frustum, occlusionCuller: culler },
    );
    expect(firstAgent.rig.root.visible).toBe(false);
    expect(ai.getTelemetry().occludedCount).toBeGreaterThanOrEqual(1);

    ai.dispose();
    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
    streamer.dispose();
  });

  it('strictly focuses deer into deep wilderness well away from roads, settlements, FOBs, and landmarks', () => {
    const segments = getBakedRoadSegments();
    const highwaySeg = segments.find((s) => s.tier === 'highway')!;
    const roadMidX = (highwaySeg.ax + highwaySeg.bx) * 0.5;
    const roadMidZ = (highwaySeg.az + highwaySeg.bz) * 0.5;

    // 1. Roads, settlements, FOBs, and major landmarks must reject deer
    expect(isDeerWildernessHabitat(roadMidX, roadMidZ)).toBe(false);
    expect(isDeerWildernessHabitat(roadMidX + 25, roadMidZ)).toBe(false);

    const sites = getBakedOpenWorldSites();
    for (const s of sites.slice(0, 10)) {
      expect(isDeerWildernessHabitat(s.x, s.z)).toBe(false);
      expect(isDeerWildernessHabitat(s.x + 40, s.z)).toBe(false);
    }

    const fobAlpha = getFobCompoundSpec('landmark_fob_alpha');
    expect(isDeerWildernessHabitat(fobAlpha.worldX, fobAlpha.worldZ)).toBe(false);
    for (const lm of OPENWORLD_LANDMARKS) {
      expect(isDeerWildernessHabitat(lm.worldX, lm.worldZ)).toBe(false);
    }

    // 2. Deep wilderness forest clearings must accept deer
    let foundWildernessSpots = 0;
    for (let x = -1400; x <= 1400; x += 120) {
      for (let z = -900; z <= 700; z += 120) {
        if (isDeerWildernessHabitat(x, z)) foundWildernessSpots++;
      }
    }
    expect(foundWildernessSpots).toBeGreaterThan(20);

    // 3. Dynamic deer spawns must strictly land inside wilderness habitat
    const scene = new THREE.Scene();
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);

    for (let step = 0; step < 120; step++) {
      wildlife.update({
        dt: 0.05,
        elapsedSec: step * 0.05,
        timeOfDayHours: 12.0,
        nightFactor: 0,
        windSpeedMps: 1.5,
        isRaining: false,
        playerX: 520,
        playerY: evaluateOpenWorldHeight(520, -180),
        playerZ: -180,
        playerYawRad: (step * 0.04) % (Math.PI * 2),
        playerSpeedMps: 0,
        playerCrouched: false,
        playerSprinting: false,
        playerAlive: true,
        playerOnFoot: true,
        flashlightOn: false,
      });
    }

    const deerAudits = wildlife.getRecentDynamicSpawns().filter((e) => e.kind === 'deer_herd');
    expect(deerAudits.length).toBeGreaterThan(0);
    for (const entry of deerAudits) {
      expect(isDeerWildernessHabitat(entry.x, entry.z)).toBe(true);
    }

    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
  });

  it('focuses insects to wilderness and occasional buildings while excluding highways, tarmac, and FOB courtyards', () => {
    const segments = getBakedRoadSegments();
    const highwaySeg = segments.find((s) => s.tier === 'highway')!;
    const roadX = (highwaySeg.ax + highwaySeg.bx) * 0.5;
    const roadZ = (highwaySeg.az + highwaySeg.bz) * 0.5;
    const roadY = evaluateOpenWorldHeight(roadX, roadZ);

    // 1. Paved highways, gas forecourts, and FOB courtyards must be forbidden for insects
    expect(classifyInsectHabitat(roadX, roadY, roadZ)).toBe('forbidden');

    const gasStation = getBakedOpenWorldSites().find((s) => s.kind === 'gas_station')!;
    expect(classifyInsectHabitat(gasStation.x, gasStation.groundY, gasStation.z)).toBe('forbidden');

    const fobAlpha = getFobCompoundSpec('landmark_fob_alpha');
    expect(
      classifyInsectHabitat(
        fobAlpha.worldX,
        evaluateOpenWorldHeight(fobAlpha.worldX, fobAlpha.worldZ),
        fobAlpha.worldZ,
      ),
    ).toBe('forbidden');

    // 2. Rural buildings / indoor civilian spaces classify as 'building'
    const cabin = getBakedOpenWorldSites().find((s) => s.kind === 'house_cabin' || s.kind === 'barn')!;
    expect(classifyInsectHabitat(cabin.x, cabin.groundY, cabin.z)).toBe('building');
    expect(
      classifyInsectHabitat(cabin.x + 2, cabin.groundY + 0.3, cabin.z, {
        isIndoor: true,
        material: 'wood',
      }),
    ).toBe('building');

    // 3. Deep forest wilderness classifies as 'wilderness'
    let wildX = 520;
    let wildZ = -180;
    for (let x = 440; x <= 760; x += 20) {
      if (classifyInsectHabitat(x, evaluateOpenWorldHeight(x, -180), -180) === 'wilderness') {
        wildX = x;
        wildZ = -180;
        break;
      }
    }
    expect(classifyInsectHabitat(wildX, evaluateOpenWorldHeight(wildX, wildZ), wildZ)).toBe('wilderness');

    // 4. Live simulation: standing on open highway spawns ZERO insects; wilderness spawns insects cleanly
    const scene = new THREE.Scene();
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);

    for (let step = 0; step < 60; step++) {
      wildlife.update({
        dt: 0.05,
        elapsedSec: step * 0.05,
        timeOfDayHours: 14.0,
        nightFactor: 0,
        windSpeedMps: 1.5,
        isRaining: false,
        playerX: roadX,
        playerY: roadY,
        playerZ: roadZ,
        playerYawRad: 0,
        playerSpeedMps: 0,
        playerCrouched: false,
        playerSprinting: false,
        playerAlive: true,
        playerOnFoot: true,
        flashlightOn: false,
      });
    }
    // Any insects spawned near highway edge must strictly be in wilderness (never on the road!)
    const roadInsects = wildlife
      .getRecentDynamicSpawns()
      .filter((e) => e.kind === 'spider' || e.kind === 'ant');
    for (const ins of roadInsects) {
      expect(classifyInsectHabitat(ins.x, ins.y, ins.z)).not.toBe('forbidden');
    }

    // Now move to wilderness forest -> insects spawn naturally
    for (let step = 0; step < 80; step++) {
      wildlife.update({
        dt: 0.05,
        elapsedSec: 4.0 + step * 0.05,
        timeOfDayHours: 14.0,
        nightFactor: 0,
        windSpeedMps: 1.5,
        isRaining: false,
        playerX: wildX,
        playerY: evaluateOpenWorldHeight(wildX, wildZ),
        playerZ: wildZ,
        playerYawRad: (step * 0.05) % (Math.PI * 2),
        playerSpeedMps: 0,
        playerCrouched: false,
        playerSprinting: false,
        playerAlive: true,
        playerOnFoot: true,
        flashlightOn: false,
      });
    }
    expect(wildlife.getTelemetry().activeInsects).toBeGreaterThan(0);

    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
  });
});

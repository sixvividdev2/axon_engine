import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BodycamAudio } from '../../../../bodycam-sdk/BodycamAudio';
import {
  DEFAULT_AMBIENCE_SFX_MANIFEST,
  OpenWorldAmbienceAudio,
  isHourInWindow,
} from '../world/OpenWorldAmbienceAudio';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import {
  createTerrainSample,
  createWaterProximitySample,
  evaluateOpenWorldHeight,
  queryWaterProximity,
  sampleOpenWorldTerrain,
} from '../world/OpenWorldTerrain';
import {
  WILDLIFE_POOL_BUDGETS,
  WildlifeManager,
  WildlifeUpdateContext,
} from '../world/WildlifeManager';

function makeBaseWildlifeCtx(overrides: Partial<WildlifeUpdateContext> = {}): WildlifeUpdateContext {
  return {
    dt: 0.05,
    elapsedSec: 1.0,
    timeOfDayHours: 12.0,
    nightFactor: 0.0,
    windSpeedMps: 2.0,
    isRaining: false,
    playerX: 500,
    playerY: evaluateOpenWorldHeight(500, 120),
    playerZ: 120,
    playerYawRad: 0,
    playerSpeedMps: 0,
    playerCrouched: false,
    playerSprinting: false,
    playerAlive: true,
    playerOnFoot: true,
    flashlightOn: false,
    ...overrides,
  };
}

describe('Open-World Ecosystem: Ambience, Spatial Audio, Fauna & Foliage', () => {
  it('detects river, coastal marsh, and inland alpine water proximity accurately', () => {
    const t = createTerrainSample();
    const w = createWaterProximitySample();

    // Scan across central river corridor (z = 180, x around -220..220) to find river bank & frog habitat
    let foundRiverWater = false;
    let foundFrogHabitat = false;
    for (let x = -260; x <= 260; x += 6) {
      sampleOpenWorldTerrain(x, 180, t);
      queryWaterProximity(x, 180, t.height, w);
      if (w.waterKind === 'river' && w.waterAudioWeight > 0.35) {
        foundRiverWater = true;
      }
      if (w.isFrogHabitat) {
        foundFrogHabitat = true;
      }
    }
    expect(foundRiverWater).toBe(true);
    expect(foundFrogHabitat).toBe(true);

    // Coastal marsh / estuary near southern shoreline
    sampleOpenWorldTerrain(-180, 1180, t);
    queryWaterProximity(-180, 1180, t.height, w);
    expect(w.waterAudioWeight).toBeGreaterThan(0);

    // Dry inland highland well away from water
    sampleOpenWorldTerrain(980, -360, t);
    queryWaterProximity(980, -360, t.height, w);
    expect(w.isFrogHabitat).toBe(false);
    expect(w.distanceToWaterM).toBeGreaterThan(20);
  });

  it('validates overnight ambience windows, drop-in SFX manifest overrides, and 120m ballistic suppression', () => {
    // Owl window: 21:00 -> 05:00
    expect(isHourInWindow(22.5, 21.0, 5.0)).toBe(true);
    expect(isHourInWindow(3.0, 21.0, 5.0)).toBe(true);
    expect(isHourInWindow(13.0, 21.0, 5.0)).toBe(false);

    // Cricket window: 19:30 -> 06:00
    expect(isHourInWindow(19.75, 19.5, 6.0)).toBe(true);
    expect(isHourInWindow(5.5, 19.5, 6.0)).toBe(true);
    expect(isHourInWindow(12.0, 19.5, 6.0)).toBe(false);

    // Default manifest uses empty arrays for 100% zero-404 procedural fallback
    expect(DEFAULT_AMBIENCE_SFX_MANIFEST.wolf_howl).toEqual([]);
    expect(DEFAULT_AMBIENCE_SFX_MANIFEST.frog_croak).toEqual([]);

    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);

    // Register drop-in custom audio override
    ambience.registerCustomAudioOverrides({
      wolf_howl: ['/audio/custom/timber_wolf_howl.ogg'],
    });
    expect(ambience.getManifestSnapshot().wolf_howl).toEqual(['/audio/custom/timber_wolf_howl.ogg']);

    // Ballistic impulse within 120m triggers 15–30s acoustic silence
    expect(ambience.isFaunaSuppressed()).toBe(false);
    const suppressedFar = ambience.onBallisticImpulse(400, 400, 155, 0, 0);
    expect(suppressedFar).toBe(false);
    expect(ambience.isFaunaSuppressed()).toBe(false);

    const suppressedNear = ambience.onBallisticImpulse(30, 0, 158, 0, 0);
    expect(suppressedNear).toBe(true);
    expect(ambience.isFaunaSuppressed()).toBe(true);
    const rem = ambience.getSuppressedRemainingSec();
    expect(rem).toBeGreaterThanOrEqual(15);
    expect(rem).toBeLessThanOrEqual(30.1);

    ambience.dispose();
    bodycamAudio.dispose();
  });

  it('simulates wolf pack deer-hunting, rival pack fights, deer bolting, and carcass field harvesting', () => {
    const scene = new THREE.Scene();
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);

    // 1. Wolf pack discovers and actively hunts a nearby deer herd (player far away)
    const packA = wildlife.spawnWolfPackAt(420, -120, 3);
    const herdId = wildlife.spawnDeerHerdAt(442, -120, 3);
    expect(packA).toBeTruthy();
    expect(herdId).toBeTruthy();

    let sawHuntPrey = false;
    for (let step = 0; step < 30; step++) {
      wildlife.update(
        makeBaseWildlifeCtx({
          elapsedSec: step * 0.05,
          playerX: 1400,
          playerZ: 1400,
        }),
      );
      const packState = wildlife.getWolfPackStates().find((p) => p.id === packA);
      if (packState?.state === 'HUNT_PREY') {
        sawHuntPrey = true;
        break;
      }
    }
    expect(sawHuntPrey).toBe(true);

    // 2. Rival wolf packs encountering each other away from deer clash in PACK_FIGHT
    const packRivalA = wildlife.spawnWolfPackAt(760, -420, 3);
    const packRivalB = wildlife.spawnWolfPackAt(784, -420, 3);
    let sawPackFight = false;
    for (let step = 0; step < 25; step++) {
      wildlife.update(
        makeBaseWildlifeCtx({
          elapsedSec: 2 + step * 0.05,
          playerX: 1400,
          playerZ: 1400,
        }),
      );
      const states = wildlife.getWolfPackStates();
      if (
        states.some((p) => (p.id === packRivalA || p.id === packRivalB) && p.state === 'PACK_FIGHT')
      ) {
        sawPackFight = true;
        break;
      }
    }
    expect(sawPackFight).toBe(true);

    // 3. Ballistic gunshot shockwave bolts deer herds
    wildlife.onBallisticImpulse(442, -120, 156);
    const herdState = wildlife.getDeerHerdStates().find((h) => h.id === herdId);
    expect(herdState?.state).toBe('BOLT');

    // 4. Down a wolf and field-dress its carcass for FOB cash & pelts/meat
    scene.updateMatrixWorld(true);
    const hitMeshes = wildlife.hitMeshes;
    expect(hitMeshes.length).toBeGreaterThan(0);
    const firstWolfHitbox = hitMeshes.find(
      (m) => typeof m.userData.openWorldWildlifeId === 'string' && m.userData.openWorldWildlifeId.startsWith('wolf_'),
    )!;
    const wolfId = firstWolfHitbox.userData.openWorldWildlifeId as string;
    const worldPos = new THREE.Vector3();
    firstWolfHitbox.getWorldPosition(worldPos);

    const dmgRes = wildlife.applyDamageToEntity(wolfId, 260, worldPos.x + 6, worldPos.z);
    expect(dmgRes.hit).toBe(true);
    expect(dmgRes.killed).toBe(true);
    expect(dmgRes.species).toBe('wolf');

    const prompt = wildlife.findNearestHarvestableCarcass(worldPos.x, worldPos.z);
    expect(prompt).not.toBeNull();
    expect(prompt!.entityId).toBe(wolfId);
    expect(prompt!.cashValueUsd).toBeGreaterThanOrEqual(400);

    const harvest = wildlife.harvestCarcass(wolfId);
    expect(harvest).not.toBeNull();
    expect(harvest!.pelts).toBe(1);
    expect(harvest!.meatKg).toBeGreaterThan(0);
    expect(harvest!.cashUsd).toBeGreaterThanOrEqual(400);
    // Double harvesting same carcass is blocked
    expect(wildlife.harvestCarcass(wolfId)).toBeNull();

    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
  });

  it('spawns physical frogs near river/marsh, daytime-only butterflies, and squishes insects on boot contact', () => {
    const scene = new THREE.Scene();
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);

    // Locate an exact frog habitat point along the central river
    const t = createTerrainSample();
    const w = createWaterProximitySample();
    let bankX = 0;
    let bankZ = 180;
    for (let x = -220; x <= 220; x += 4) {
      sampleOpenWorldTerrain(x, 180, t);
      queryWaterProximity(x, 180, t.height, w);
      if (w.isFrogHabitat) {
        bankX = x;
        bankZ = 180;
        break;
      }
    }
    const bankY = evaluateOpenWorldHeight(bankX, bankZ);

    // Step daytime calm weather near river bank -> frogs & butterflies populate
    for (let i = 0; i < 16; i++) {
      wildlife.update(
        makeBaseWildlifeCtx({
          dt: 0.05,
          elapsedSec: i * 0.05,
          timeOfDayHours: 12.0,
          windSpeedMps: 1.8,
          isRaining: false,
          playerX: bankX,
          playerY: bankY,
          playerZ: bankZ,
        }),
      );
    }
    const dayTelemetry = wildlife.getTelemetry();
    expect(dayTelemetry.activeFrogs).toBeGreaterThan(0);
    expect(dayTelemetry.activeButterflies).toBeGreaterThan(0);

    // Step nighttime -> butterflies disappear cleanly
    wildlife.update(
      makeBaseWildlifeCtx({
        dt: 0.05,
        elapsedSec: 2.0,
        timeOfDayHours: 23.0,
        nightFactor: 1.0,
        playerX: bankX,
        playerY: bankY,
        playerZ: bankZ,
      }),
    );
    expect(wildlife.getTelemetry().activeButterflies).toBe(0);

    // Deterministic Boot Squish verification (< 0.22m footstep contact)
    wildlife.debugPlaceInsectAt(0, bankX + 0.05, bankY, bankZ - 0.04, true);
    wildlife.debugPlaceInsectAt(0, bankX - 0.06, bankY, bankZ + 0.02, false);

    const squish = wildlife.handlePlayerFootstep(bankX, bankY, bankZ);
    expect(squish.squishedCount).toBe(2);
    expect(squish.spidersSquished).toBe(1);
    expect(squish.antsSquished).toBe(1);
    expect(squish.bootGrime01).toBeGreaterThan(0);
    expect(wildlife.getTelemetry().totalSquishedInsects).toBe(2);

    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
  });

  it('populates biome foliage, ground clutter, canopy roosts, and near-player dense micro-grass in active chunks', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    // Stream around a temperate forest coordinate
    const forestX = 520;
    const forestZ = -180;
    streamer.update(forestX, forestZ);
    const stats = streamer.getStats();

    expect(stats.activeChunkCount).toBe(9);
    expect(stats.activeInstanceCount).toBeGreaterThan(150);
    expect(streamer.getActiveTreeRoosts().length).toBeGreaterThan(0);
    expect(streamer.getActiveLogAnchors().length + streamer.getActiveRockAnchors().length).toBeGreaterThan(0);

    // Update GPU wind & near-player grass ring without throwing
    expect(() =>
      streamer.updateFoliageWindAndGrass(1.25, 4.5, 0.35, 0.15, forestX, forestZ),
    ).not.toThrow();

    streamer.dispose();
    expect(streamer.getStats().totalLoadedChunks).toBe(0);
  });

  it('enforces 50% reduced insect pools, spread-out wildlife spawns, and strictly unseen spawning (never in player FOV)', () => {
    // 1. Exact 50% insect reduction verified (spiders: 14->7, ants: 36->18, total: 50->25)
    expect(WILDLIFE_POOL_BUDGETS.spiders).toBe(7);
    expect(WILDLIFE_POOL_BUDGETS.ants).toBe(18);
    expect(WILDLIFE_POOL_BUDGETS.totalInsects).toBe(25);
    expect(WILDLIFE_POOL_BUDGETS.wolfMinPackSeparationM).toBeGreaterThanOrEqual(175);
    expect(WILDLIFE_POOL_BUDGETS.deerMinHerdSeparationM).toBeGreaterThanOrEqual(155);

    const scene = new THREE.Scene();
    const bodycamAudio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(bodycamAudio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, true);

    // 2. Direct visibility gate checks: directly ahead is NEVER hidden; behind shoulders is ALWAYS hidden
    const playerCtx = {
      playerX: 480,
      playerY: evaluateOpenWorldHeight(480, -140),
      playerZ: -140,
      playerYawRad: 0, // Looking straight -Z
    };
    expect(
      wildlife.isHiddenFromPlayerView(480, evaluateOpenWorldHeight(480, -165), -165, playerCtx, 1.0, false),
    ).toBe(false);
    expect(
      wildlife.isHiddenFromPlayerView(480, evaluateOpenWorldHeight(480, -110), -110, playerCtx, 1.0, false),
    ).toBe(true);
    // Too close (< 6m) is rejected even behind the player
    expect(
      wildlife.isHiddenFromPlayerView(480, evaluateOpenWorldHeight(480, -136), -136, playerCtx, 0.2, false),
    ).toBe(false);

    // 3. Run multi-second live simulation in a forest/clearing while rotating camera slowly
    for (let step = 0; step < 120; step++) {
      const yaw = (step * 0.03) % (Math.PI * 2);
      wildlife.update(
        makeBaseWildlifeCtx({
          dt: 0.05,
          elapsedSec: step * 0.05,
          timeOfDayHours: 13.0,
          nightFactor: 0.0,
          windSpeedMps: 1.8,
          isRaining: false,
          playerX: 520,
          playerY: evaluateOpenWorldHeight(520, -180),
          playerZ: -180,
          playerYawRad: yaw,
        }),
      );
    }

    const telemetry = wildlife.getTelemetry();
    expect(telemetry.activeInsects).toBeLessThanOrEqual(25);
    expect(telemetry.activeWolfPacks).toBeGreaterThanOrEqual(1);
    expect(telemetry.aliveDeer).toBeGreaterThan(0);

    // 4. Audit EVERY dynamic spawn across all tiers: 100% must be behind player FOV or terrain-occluded
    const audits = wildlife.getRecentDynamicSpawns();
    expect(audits.length).toBeGreaterThan(0);
    for (const entry of audits) {
      const hiddenBehindFov = entry.dotForward <= -0.22;
      const hiddenByRidgeAtDistance = entry.terrainOccluded && entry.distFromPlayerM >= 140;
      expect(hiddenBehindFov || hiddenByRidgeAtDistance).toBe(true);
      if (entry.kind === 'wolf_pack') {
        expect(entry.distFromPlayerM).toBeGreaterThanOrEqual(135);
      }
      if (entry.kind === 'deer_herd') {
        expect(entry.distFromPlayerM).toBeGreaterThanOrEqual(110);
      }
    }

    wildlife.dispose();
    ambience.dispose();
    bodycamAudio.dispose();
  });
});

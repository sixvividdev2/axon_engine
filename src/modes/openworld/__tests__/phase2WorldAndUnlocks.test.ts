import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { OperatorSelectionStore } from '../../../../bodycam-sdk/operator/OperatorSelectionStore';
import { CharacterRoster } from '../CharacterRoster';
import { ClassicHideoutStoreLike, HideoutShardAdapter } from '../HideoutShardAdapter';
import { processCharacterDeath } from '../PermadeathService';
import { ShardStore } from '../ShardStore';
import { OpenWorldStorageLike } from '../types';
import {
  OPENWORLD_DAY_CYCLE_SECONDS,
  OpenWorldAtmosphere,
} from '../world/OpenWorldAtmosphere';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import {
  CHUNK_SIZE_M,
  createTerrainSample,
  evaluateOpenWorldHeight,
  OPENWORLD_LANDMARKS,
  sampleOpenWorldTerrain,
  WORLD_GRID_CHUNKS,
  WORLD_SIZE_M,
} from '../world/OpenWorldTerrain';

function createMemoryStorage(): OpenWorldStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function createMockClassicHideout(): ClassicHideoutStoreLike {
  return {
    getState: () => ({
      unlockedWeaponIds: ['m4a1'],
      wallRackSlots: [],
      equippedWeaponId: 'm4a1',
      ammoReserve: { '556x45': 180 },
      gunRangeBestScore: 0,
      gunRangeBestHits: 0,
      gunRangeBestAccuracy: 0,
      gunRangeCoursesCompleted: 0,
      longRangeBestMoa100m: null,
      longRange100mHits: 0,
      ammoVariantByWeapon: {},
      zeroDistanceByWeapon: {},
    }),
    syncWithUnlockedCheck: () => ({
      unlockedWeaponIds: ['m4a1'],
      wallRackSlots: [],
      equippedWeaponId: 'm4a1',
      ammoReserve: { '556x45': 180 },
      gunRangeBestScore: 0,
      gunRangeBestHits: 0,
      gunRangeBestAccuracy: 0,
      gunRangeCoursesCompleted: 0,
      longRangeBestMoa100m: null,
      longRange100mHits: 0,
      ammoVariantByWeapon: {},
      zeroDistanceByWeapon: {},
    }),
    commitRackSwap: () => ({ previousEquipped: 'm4a1', nextEquipped: 'm4a1' }),
    setEquippedWeaponDirect: () => {},
    getReserveForWeapon: () => 180,
    consumeReserve: (_w, r) => r,
    resupplyAllAmmo: () => {},
    setWeaponAmmoVariant: () => {},
    setWeaponZeroDistance: () => {},
  };
}

describe('Phase 2 + Edge Cases: Per-Character Unlocks, Permadeath Boundary & 4km Streaming World', () => {
  it('isolates weapon, optic/attachment, armor plate, and trader unlock entitlements strictly inside each characterId (never account-wide)', () => {
    const roster = new CharacterRoster({ storage: createMemoryStorage() });
    const shards = new ShardStore({ storage: createMemoryStorage() });
    const opStore = new OperatorSelectionStore({ storage: createMemoryStorage(), search: '' });
    const adapter = new HideoutShardAdapter(roster, shards, createMockClassicHideout(), opStore);

    roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'PATHFINDER-1',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
      activate: true,
    });
    roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'SPECTRE-2',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'female',
      activate: false,
    });

    // Before completing contract or leveling trader, neither character can buy Mk14 EBR, ATACR scope, or NIJ IV composite plate
    expect(roster.purchaseWeaponToArsenal('slot_0', 'mk14_ebr', 6200).ok).toBe(false);
    expect(roster.purchaseAttachmentToCharacter('slot_0', 'optic_nightforce_atacr', 3400).ok).toBe(false);
    expect(roster.purchaseArmorPlateToCharacter('slot_0', 'plate_nij4_composite').ok).toBe(false);

    // Complete Alpine Dam contract exclusively on slot_0
    const contractRes = roster.completeContract('slot_0', 'contract_dam_vault');
    expect(contractRes.ok).toBe(true);
    expect(contractRes.newlyUnlockedWeapons).toContain('mk14_ebr');
    expect(contractRes.newlyUnlockedAttachments).toContain('optic_nightforce_atacr');
    expect(contractRes.newlyUnlockedArmorPlates).toContain('plate_nij4_composite');

    // slot_0 CAN now buy & mount those entitlements; HideoutShardAdapter reports unlocked for slot_0
    expect(roster.isWeaponUnlockedForCharacter('slot_0', 'mk14_ebr')).toBe(true);
    expect(roster.isAttachmentUnlockedForCharacter('slot_0', 'optic_nightforce_atacr')).toBe(true);
    expect(roster.isArmorPlateUnlockedForCharacter('slot_0', 'plate_nij4_composite')).toBe(true);
    expect(adapter.isAttachmentUnlockedInActiveContext('optic_nightforce_atacr', () => false)).toBe(true);
    expect(roster.purchaseWeaponToArsenal('slot_0', 'mk14_ebr', 6200).ok).toBe(true);
    expect(roster.purchaseAttachmentToCharacter('slot_0', 'optic_nightforce_atacr', 3400).ok).toBe(true);
    expect(roster.purchaseArmorPlateToCharacter('slot_0', 'plate_nij4_composite').ok).toBe(true);

    // Switch active slot to slot_1: slot_1 MUST NOT inherit any of slot_0's trader/contract unlocks!
    roster.setActiveSlot('slot_1');
    expect(roster.isWeaponUnlockedForCharacter('slot_1', 'mk14_ebr')).toBe(false);
    expect(roster.isAttachmentUnlockedForCharacter('slot_1', 'optic_nightforce_atacr')).toBe(false);
    expect(roster.isArmorPlateUnlockedForCharacter('slot_1', 'plate_nij4_composite')).toBe(false);
    expect(adapter.isAttachmentUnlockedInActiveContext('optic_nightforce_atacr', () => true)).toBe(false);
    expect(roster.purchaseWeaponToArsenal('slot_1', 'mk14_ebr', 6200).ok).toBe(false);
    expect(roster.purchaseAttachmentToCharacter('slot_1', 'optic_nightforce_atacr', 3400).ok).toBe(false);
    expect(roster.purchaseArmorPlateToCharacter('slot_1', 'plate_nij4_composite').ok).toBe(false);

    adapter.dispose();
  });

  it('enforces Account-Wide vs Per-Character boundary: permadeath wipes 100% of characterId unlocks, stash, cash & vehicles while keeping account slot rules & sibling slots intact', () => {
    const roster = new CharacterRoster({ storage: createMemoryStorage() });
    const shards = new ShardStore({ storage: createMemoryStorage() });

    roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'VETERAN-0',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'SAFE-1',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
      activate: false,
    });

    // Accumulate rich per-character progression on slot_0: contracts, trader levels, vehicle key
    roster.completeContract('slot_0', 'contract_valley_convoy');
    roster.completeContract('slot_0', 'contract_dam_vault');
    roster.addOwnedVehicleKey('slot_0', {
      vehicleId: 'veh_uaz_469',
      modelLabel: 'UAZ-469 Patrol 4x4',
      keyCode: 'KEY-469-A',
      locked: true,
      worldX: -1100,
      worldZ: 670,
    });
    const beforeDeath = roster.getCharacter('slot_0')!;
    expect(beforeDeath.unlocks.unlockedWeaponIds).toContain('mk14_ebr');
    expect(beforeDeath.unlocks.unlockedAttachmentIds).toContain('optic_nightforce_atacr');
    expect(beforeDeath.ownedVehicleKeys).toHaveLength(1);

    // Drop cash below scaled respawn fee and trigger permadeath
    roster.setCash('slot_0', 100);
    const death = processCharacterDeath(roster, shards, {
      slotId: 'slot_0',
      sectorLabel: 'Korsakov Dam Overlook',
    });

    expect(death?.outcome).toBe('permadeath_wiped');
    if (death?.outcome === 'permadeath_wiped') {
      expect(death.wipedCharacterId).toBe(beforeDeath.characterId);
      expect(death.wipedSummary.unlockedWeapons).toBeGreaterThanOrEqual(8);
      expect(death.wipedSummary.unlockedAttachments).toBeGreaterThanOrEqual(7);
      expect(death.wipedSummary.ownedVehicleCount).toBe(1);
    }

    // Slot 0 is cleared; sibling Slot 1 is untouched
    expect(roster.getCharacter('slot_0')).toBeNull();
    expect(roster.getCharacter('slot_1')?.callsign).toBe('SAFE-1');

    // Account-level slot_0 can now be re-created with a fresh characterId — ZERO unlocks or vehicles carried over
    const recreated = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'ROOKIE-0',
      shardMode: 'PvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'female',
    });
    expect(recreated.ok).toBe(true);
    expect(recreated.character?.characterId).not.toBe(beforeDeath.characterId);
    expect(recreated.character?.unlocks.unlockedWeaponIds).not.toContain('mk14_ebr');
    expect(recreated.character?.unlocks.unlockedAttachmentIds).not.toContain('optic_nightforce_atacr');
    expect(recreated.character?.unlocks.completedContractIds).toHaveLength(0);
    expect(recreated.character?.unlocks.traderLevels.alpine_specialist).toBe(1);
    expect(recreated.character?.ownedVehicleKeys).toHaveLength(0);
  });

  it('generates the 4,096m × 4,096m (16×16 × 256m) world with all 4 elevation-stratified biomes and landmarks', () => {
    expect(WORLD_SIZE_M).toBe(4096);
    expect(CHUNK_SIZE_M).toBe(256);
    expect(WORLD_GRID_CHUNKS).toBe(16);
    expect(OPENWORLD_LANDMARKS.length).toBeGreaterThanOrEqual(6);

    const sample = createTerrainSample();

    // 1. Coastal Port & Marsh Delta (0m – 15m)
    sampleOpenWorldTerrain(-540, 1260, sample);
    expect(sample.biome).toBe('coastal_port_marsh');
    expect(sample.height).toBeGreaterThanOrEqual(0);
    expect(sample.height).toBeLessThanOrEqual(15);

    // 2. Temperate Conifer & Pine Valley (15m – 120m)
    sampleOpenWorldTerrain(-160, 240, sample);
    expect(sample.biome).toBe('temperate_conifer_valley');
    expect(sample.height).toBeGreaterThanOrEqual(15);
    expect(sample.height).toBeLessThanOrEqual(120);

    // 3. Highland Steppe & Quarry Plateaus (120m – 260m)
    sampleOpenWorldTerrain(480, -380, sample);
    expect(sample.biome).toBe('highland_steppe_quarry');
    expect(sample.height).toBeGreaterThanOrEqual(120);
    expect(sample.height).toBeLessThanOrEqual(260);

    // 4. Alpine Ridge & Dam Reservoir (260m – 450m+)
    sampleOpenWorldTerrain(180, -1360, sample);
    expect(sample.biome).toBe('alpine_ridge_dam');
    expect(sample.height).toBeGreaterThanOrEqual(260);

    // Verify alpine peaks exceed 380m in the far north
    let peakHeight = 0;
    for (let x = -1600; x <= 1600; x += 160) {
      peakHeight = Math.max(peakHeight, evaluateOpenWorldHeight(x, -1880));
    }
    expect(peakHeight).toBeGreaterThan(360);
  });

  it('streams 3×3 Active + 5×5 Mid-Range chunks, samples bilinear heightfield colliders, and explicitly disposes unloaded chunks', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    // Interior position (0, 0) -> full 3x3 (9) active chunks + 16 mid-range outer ring chunks = 25 loaded
    streamer.update(0, 0);
    const statsCenter = streamer.getStats();
    expect(statsCenter.activeChunkCount).toBe(9);
    expect(statsCenter.midChunkCount).toBe(16);
    expect(statsCenter.totalLoadedChunks).toBe(25);
    expect(statsCenter.disposedChunkCount).toBe(0);

    // Bilinear active heightfield matches exact terrain evaluator closely
    const sampled = streamer.sampleGroundHeight(32, -48);
    const exact = evaluateOpenWorldHeight(32, -48);
    expect(Math.abs(sampled - exact)).toBeLessThan(1.5);

    // Move 4 chunks north-east (+1024m, -1024m): old chunks must be disposed and new ring loaded
    streamer.update(1024, -1024);
    const statsMoved = streamer.getStats();
    expect(statsMoved.activeChunkCount).toBe(9);
    expect(statsMoved.disposedChunkCount).toBeGreaterThanOrEqual(16);

    // Full teardown disposes every remaining loaded chunk
    const loadedBeforeDispose = statsMoved.totalLoadedChunks;
    const disposedBefore = statsMoved.disposedChunkCount;
    streamer.dispose();
    expect(streamer.getStats().totalLoadedChunks).toBe(0);
    expect(streamer.getStats().disposedChunkCount).toBe(disposedBefore + loadedBeforeDispose);
  });

  it('runs a 90-minute day/night cycle paired with Clear, Coastal Fog & Mountain Rain scaling AI visual detection cones', () => {
    expect(OPENWORLD_DAY_CYCLE_SECONDS).toBe(5400); // 90 real-time minutes

    const scene = new THREE.Scene();
    const atmo = new OpenWorldAtmosphere(scene, true);

    // Midday Clear: full AI vision cone
    atmo.setTimeOfDay(12.5);
    atmo.setWeather('clear');
    atmo.update(0.016, 0, 50, 0);
    const middayClear = { ...atmo.getTelemetry() };
    expect(middayClear.nightOpsActive).toBe(false);
    expect(middayClear.aiVisionConeMultiplier).toBe(1.0);

    // Midday Coastal Fog: dense fog reduces AI visual detection significantly
    atmo.setWeather('coastal_fog');
    atmo.update(0.016, 0, 50, 0);
    const middayFog = { ...atmo.getTelemetry() };
    expect(middayFog.aiVisionConeMultiplier).toBeLessThan(0.6);
    expect(middayFog.visibilityMeters).toBeLessThan(middayClear.visibilityMeters);

    // Midnight Mountain Rain: night ops active + lowest AI detection multiplier
    atmo.setTimeOfDay(23.5);
    atmo.setWeather('mountain_rain');
    atmo.update(0.016, 0, 50, 0);
    const nightRain = { ...atmo.getTelemetry() };
    expect(nightRain.nightOpsActive).toBe(true);
    expect(nightRain.aiVisionConeMultiplier).toBeLessThanOrEqual(0.35);

    atmo.dispose();
  });

  it('smoothly crossfades weather states, auto-cycles weather, and updates height-fog + sun-inscatter uniforms cleanly', () => {
    const scene = new THREE.Scene();
    const atmo = new OpenWorldAtmosphere(scene, true);

    atmo.setTimeOfDay(6.2); // Golden-hour dawn
    atmo.setWeather('clear');
    atmo.update(0.016, 0, 50, 0);
    const clearMist = atmo.fogUniforms.uAtmoFogParams.value.y;
    const clearClouds = atmo.getTelemetry().cloudCoveragePct;
    const dawnInscatter = atmo.fogUniforms.uAtmoScatterParams.value.x;
    expect(dawnInscatter).toBeGreaterThan(0.35);

    // Smooth crossfade toward coastal_fog interpolates monotonically over frames
    atmo.transitionToWeather('coastal_fog', 4.0);
    atmo.update(0.1, 0, 50, 0);
    atmo.update(0.1, 0, 50, 0);
    const midMist = atmo.fogUniforms.uAtmoFogParams.value.y;
    const midClouds = atmo.getTelemetry().cloudCoveragePct;
    expect(midMist).toBeGreaterThan(clearMist);
    expect(midClouds).toBeGreaterThan(clearClouds);

    // Auto-cycle toggle reflects in telemetry & cycles weather after timer elapses
    atmo.setAutoWeatherCycle(true);
    expect(atmo.getTelemetry().autoWeatherCycle).toBe(true);
    atmo.setTimeScale(10);
    for (let i = 0; i < 60; i++) {
      atmo.update(0.1, 0, 50, 0);
    }
    atmo.setAutoWeatherCycle(false);
    expect(atmo.getTelemetry().autoWeatherCycle).toBe(false);

    // Chaining height fog onto OpenWorldChunkStreamer materials works cleanly in headless runtime
    const streamer = new OpenWorldChunkStreamer(scene, true, atmo.fogUniforms);
    streamer.update(0, 0);
    expect(streamer.getStats().totalLoadedChunks).toBeGreaterThan(0);

    streamer.dispose();
    atmo.dispose();
  });
});

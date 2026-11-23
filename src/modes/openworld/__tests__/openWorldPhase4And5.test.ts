import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterRoster } from '../CharacterRoster';
import {
  autoPlaceItemInGrid,
  buildStarterTacticalInventory,
  canPlaceInGrid,
  createAmmoStackItem,
  createBackpackItem,
  createGridContainer,
  createMagazineItem,
  createMedicalItem,
  findQuickReloadMagazine,
  fireRoundFromWeaponSlot,
  isItemAllowedInBelt,
  isItemAllowedInRigMagSlot,
  loadAmmoStackIntoMagazine,
  moveItemWithinGrid,
  placeItemInGrid,
  summarizeMagazineRunsTopFirst,
  swapMagazineIntoWeapon,
  unloadTopRoundsFromMagazine,
} from '../inventory/TetrisInventoryCore';
import { processCharacterDeath } from '../PermadeathService';
import { ShardStore } from '../ShardStore';
import { OpenWorldConvoyDirector } from '../world/OpenWorldConvoyDirector';
import { OpenWorldEventDirector } from '../world/OpenWorldEventDirector';
import {
  classifySupplyTier,
  OpenWorldLogisticsEconomy,
} from '../world/OpenWorldLogisticsEconomy';
import { OpenWorldSectorManager } from '../world/OpenWorldSectorManager';
import { OPENWORLD_LANDMARKS } from '../world/OpenWorldTerrain';

describe('Phase 5: Interactive Tetris Grid Inventory & Mixed Same-Caliber LIFO Magazines', () => {
  it('enforces 2D Tetris spatial bounds, overlap detection, and 90-degree rotation', () => {
    const grid = createGridContainer('test_pack', 'Test Pack', 4, 4);
    const magA = createMagazineItem('mag_556_30', []); // 1x2
    const magB = createMagazineItem('mag_556_30', []); // 1x2

    expect(placeItemInGrid(grid, magA, 0, 0, false)).toBe(true);
    // Overlapping cell (0,1) must be rejected
    expect(canPlaceInGrid(grid, magB, 0, 1, false)).toBe(false);
    // Rotating magB to 2x1 at (1,0) succeeds
    expect(placeItemInGrid(grid, magB, 1, 0, true)).toBe(true);
    // Out-of-bounds rotated placement at x=3 fails
    expect(moveItemWithinGrid(grid, magB.instanceId, 3, 0, true)).toBe(false);
    // Valid rotated move to (2,0) succeeds
    expect(moveItemWithinGrid(grid, magB.instanceId, 2, 0, true)).toBe(true);
  });

  it('enforces Belt restrictions (grenades/meds/mags) and Chest Rig Rifle vs Pistol mag slots', () => {
    const rifleMag = createMagazineItem('mag_556_30', []);
    const pistolMag = createMagazineItem('mag_9x19_17_pistol', []);
    const ammoBox = createAmmoStackItem('556x45_m855', 30);
    const med = createMedicalItem('bandage');
    const pack = createBackpackItem('pack_assault_20l');

    expect(isItemAllowedInBelt(rifleMag)).toBe(true);
    expect(isItemAllowedInBelt(med)).toBe(true);
    expect(isItemAllowedInBelt(ammoBox)).toBe(false);
    expect(isItemAllowedInBelt(pack)).toBe(false);

    expect(isItemAllowedInRigMagSlot(rifleMag, 'rifle')).toBe(true);
    expect(isItemAllowedInRigMagSlot(rifleMag, 'pistol')).toBe(false);
    expect(isItemAllowedInRigMagSlot(pistolMag, 'pistol')).toBe(true);
    expect(isItemAllowedInRigMagSlot(pistolMag, 'rifle')).toBe(false);
  });

  it('mixes arbitrary same-caliber ammo variants in strict LIFO order and rejects cross-caliber rounds', () => {
    const mag = createMagazineItem('mag_556_30', []);
    const fmj = createAmmoStackItem('556x45_m855', 10);
    const epr = createAmmoStackItem('556x45_m855a1', 5);
    const ap = createAmmoStackItem('556x45_m995', 3);
    const wrongCal = createAmmoStackItem('762x39_ps', 10);

    // Reject cross-caliber loading
    const bad = loadAmmoStackIntoMagazine(mag, wrongCal, 5);
    expect(bad.ok).toBe(false);
    expect(mag.rounds.length).toBe(0);

    // Pack FMJ bottom (3), EPR middle (2), M995 AP top (2)
    expect(loadAmmoStackIntoMagazine(mag, fmj, 3).loadedCount).toBe(3);
    expect(loadAmmoStackIntoMagazine(mag, epr, 2).loadedCount).toBe(2);
    expect(loadAmmoStackIntoMagazine(mag, ap, 2).loadedCount).toBe(2);
    expect(mag.rounds.length).toBe(7);

    // Top-first run summary reflects exact LIFO order
    const runs = summarizeMagazineRunsTopFirst(mag);
    expect(runs.map((r) => [r.variantId, r.count])).toEqual([
      ['556x45_m995', 2],
      ['556x45_m855a1', 2],
      ['556x45_m855', 3],
    ]);

    // Firing from weapon slot pops exact variants in LIFO order
    const slot = { weaponId: 'm4a1', chamberedRound: null, loadedMag: mag };
    expect(fireRoundFromWeaponSlot(slot)?.id).toBe('556x45_m995');
    expect(fireRoundFromWeaponSlot(slot)?.id).toBe('556x45_m995');
    expect(fireRoundFromWeaponSlot(slot)?.id).toBe('556x45_m855a1');
    expect(fireRoundFromWeaponSlot(slot)?.id).toBe('556x45_m855a1');
    expect(fireRoundFromWeaponSlot(slot)?.id).toBe('556x45_m855');

    // Unloading top rounds returns loose ammo stacks
    const unloaded = unloadTopRoundsFromMagazine(mag, 2);
    expect(unloaded.length).toBeGreaterThan(0);
    expect(unloaded[0].variantId).toBe('556x45_m855');
  });

  it('requires loaded Chest Rig/Belt mags for [R] Quick Reload, while drag-and-drop reload from Backpack always works even without a Chest Rig', () => {
    const inv = buildStarterTacticalInventory('pmc_alpha', 'm4a1', 'glock_17', 'plate_nij3_steel', '2x2');
    // Starter Chest Rig has loaded M4A1 mags -> quick reload succeeds
    expect(findQuickReloadMagazine(inv, 'm4a1')).not.toBeNull();

    // Unequip Chest Rig completely and ensure Belt has no rifle mags
    inv.chestRig = null;
    inv.beltSlots = [null, null, null, null];

    // Put a freshly loaded 5.56 mag inside the Backpack grid
    const packMag = createMagazineItem('mag_556_30', Array(15).fill('556x45_m995'));
    expect(inv.backpack).not.toBeNull();
    expect(autoPlaceItemInGrid(inv.backpack!.grid, packMag, true)).toBe(true);

    // [R] Quick Reload MUST return null without Chest Rig / Belt mag
    expect(findQuickReloadMagazine(inv, 'm4a1')).toBeNull();

    // Drag-and-drop reload directly from Backpack MUST still work!
    const dragRes = swapMagazineIntoWeapon(inv, 'primary', {
      zone: 'backpack_grid',
      instanceId: packMag.instanceId,
    });
    expect(dragRes.ok).toBe(true);
    expect(inv.primary.loadedMag?.instanceId).toBe(packMag.instanceId);
  });

  it('preserves ONLY Secure Container on Field Hospital respawn and drops removable Backpack with nested items onto shard corpse', () => {
    const roster = new CharacterRoster();
    const shards = new ShardStore();
    const created = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'Nomad-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    });
    expect(created.ok).toBe(true);
    const char = created.character!;

    // Place a high-value item in Secure Container and verify Backpack has items
    const secureItem = createAmmoStackItem('556x45_m995', 30);
    autoPlaceItemInGrid(char.tacticalInventory!.secureContainer, secureItem, true);
    roster.updateTacticalInventory(char.slotId, char.tacticalInventory!);
    const packItemCountBefore = char.tacticalInventory!.backpack!.grid.items.length;
    expect(packItemCountBefore).toBeGreaterThan(0);

    const outcome = processCharacterDeath(roster, shards, {
      slotId: char.slotId,
      worldX: 120,
      worldZ: 240,
      sectorLabel: 'Central Valley',
      causeOfDeath: 'KIA Test',
    });
    expect(outcome?.outcome).toBe('field_hospital_respawn');

    // Shard corpse carries full dropped tactical kit including nested backpack items
    const corpse = shards.getShard('PvPvE').corpses[0];
    expect(corpse.droppedTacticalKit?.backpack?.grid.items.length).toBe(packItemCountBefore);

    // Respawned operator retained Secure Container item
    const respawned = roster.getCharacter(char.slotId)!;
    expect(
      respawned.tacticalInventory?.secureContainer.items.some(
        (p) => p.item.instanceId === secureItem.instanceId,
      ),
    ).toBe(true);
  });
});

describe('Phase 4 & 5: 12-POI Sectors, Comms Fog-of-War, FOB Tier 1-3, Supply-Coupled Trader, Convoys, Contracts & World Events', () => {
  it('defines 12 named POIs (2 FOBs, 3 Comms Towers, 4 Supply Depots + Landmarks) and drives Comms Fog-of-War', () => {
    expect(OPENWORLD_LANDMARKS.length).toBe(12);
    const commsCount = OPENWORLD_LANDMARKS.filter((l) => l.poiRole === 'comms_tower').length;
    const depotCount = OPENWORLD_LANDMARKS.filter((l) => l.poiRole === 'supply_depot').length;
    expect(commsCount).toBe(3);
    expect(depotCount).toBe(4);

    const scene = new THREE.Scene();
    const roster = new CharacterRoster();
    const shards = new ShardStore();
    const mgr = new OpenWorldSectorManager(scene, () => 25, roster, shards, 'PvPvE');

    // Initially comms_south_marsh is held by PMC Alpha, leaving 2 blackout zones for PMC Alpha
    const blackoutsBefore = mgr.getCommsBlackoutZonesForFaction('pmc_alpha');
    expect(blackoutsBefore.length).toBe(2);
    const targetBlackout = blackoutsBefore[0];
    expect(mgr.isPointCoveredByComms(targetBlackout.x, targetBlackout.z, 'pmc_alpha')).toBe(false);

    // Flipping that uncaptured Comms Tower to PMC Alpha clears its Fog-of-War blackout
    shards.flipSector('PvPvE', targetBlackout.sectorId, 'pmc_alpha', 'Alpha-1', targetBlackout.label, { intel: 10 });
    mgr.syncFromShard('PvPvE', null);
    const blackoutsAfter = mgr.getCommsBlackoutZonesForFaction('pmc_alpha');
    expect(blackoutsAfter.length).toBe(1);
    expect(mgr.isPointCoveredByComms(targetBlackout.x, targetBlackout.z, 'pmc_alpha')).toBe(true);

    // Combat alert shifts nearby calm sector to alerted
    mgr.notifyCombatAlert(-160, 240, 100);
    const railyard = mgr.getSectorsSnapshot().find((s) => s.sectorId === 'landmark_timberline_railyard');
    expect(railyard?.alertState).toBe('alerted');

    mgr.dispose();
  });

  it('upgrades FOB Tier 1 -> 2 -> 3 (unlocking 3x3 Secure Container) and couples Trader stock/pricing to supply pools', () => {
    const roster = new CharacterRoster();
    const shards = new ShardStore();
    const economy = new OpenWorldLogisticsEconomy();

    const char = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'Quartermaster-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;
    roster.adjustCash(char.slotId, 50000);
    shards.adjustPmcSupply('PvPvE', 'pmc_alpha', { ammo: 20, medical: 20, fuelParts: 20, intel: 20 }, 'sector_flip', 'Boost');

    expect(classifySupplyTier(80)).toBe('high');
    expect(classifySupplyTier(50)).toBe('strained');
    expect(classifySupplyTier(20)).toBe('starved');

    // Upgrade FOB Tier 1 -> 2 -> 3
    const up2 = economy.fundNextFobUpgrade(roster.getCharacter(char.slotId)!, roster, shards);
    expect(up2.ok).toBe(true);
    expect(up2.newTier).toBe(2);

    const up3 = economy.fundNextFobUpgrade(roster.getCharacter(char.slotId)!, roster, shards);
    expect(up3.ok).toBe(true);
    expect(up3.newTier).toBe(3);

    // Tier 3 upgrades Secure Container from 2x2 to 3x3!
    const upgradedChar = roster.getCharacter(char.slotId)!;
    expect(upgradedChar.secureContainerTier).toBe('3x3');
    expect(upgradedChar.tacticalInventory?.secureContainer.width).toBe(3);
    expect(upgradedChar.tacticalInventory?.secureContainer.height).toBe(3);

    // Starve Ammo pool (<30%) -> M995 AP offer becomes locked & standard ammo price rises 1.45x
    shards.adjustPmcSupply('PvPvE', 'pmc_alpha', { ammo: -80 }, 'convoy_sabotage', 'Starve ammo');
    const starvedSnap = economy.getFobTerminalSnapshot(upgradedChar, shards);
    expect(starvedSnap.supplyTiers.ammo.tier).toBe('starved');
    const m995Offer = starvedSnap.offers.find((o) => o.offerId === 'offer_ammo_556x45_m995');
    expect(m995Offer?.lockedReason).toContain('Starved');
  });

  it('requires disabling Convoy escorts before Hijack/Reroute or Sabotage (+180s enemy restock stall)', () => {
    const scene = new THREE.Scene();
    const roster = new CharacterRoster();
    const shards = new ShardStore();
    const convoys = new OpenWorldConvoyDirector(scene, () => 25);

    const char = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'Raider-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'female',
    }).character!;

    // Cannot hijack Bravo convoy while escorts are alive
    const blocked = convoys.hijackAndRerouteConvoy('convoy_bravo_highland', char, roster, shards);
    expect(blocked.ok).toBe(false);

    // Disable escorts, then sabotage cargo -> stalls Bravo restock by +180s
    expect(convoys.disableEscort('convoy_bravo_highland')).toBe(true);
    const sabRes = convoys.sabotageConvoy('convoy_bravo_highland', char, roster, shards);
    expect(sabRes.ok).toBe(true);
    expect(shards.getShard('PvPvE').restockPenaltySec.pmc_bravo).toBeGreaterThanOrEqual(180);

    // Disable coastal barge escorts and Hijack/Reroute -> increases Alpha supply & cash
    const cashBefore = roster.getCharacter(char.slotId)!.cash;
    expect(convoys.disableEscort('barge_coastal_delta')).toBe(true);
    const hijRes = convoys.hijackAndRerouteConvoy('barge_coastal_delta', roster.getCharacter(char.slotId)!, roster, shards);
    expect(hijRes.ok).toBe(true);
    expect(roster.getCharacter(char.slotId)!.cash).toBeGreaterThan(cashBefore);

    convoys.dispose();
  });

  it('rotates 3-slot Sub-Faction Contracts with rival penalties and runs Night-Weighted Dynamic World Events', () => {
    const roster = new CharacterRoster();
    const char = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'Ghost-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;

    expect(char.contractBoard?.length).toBe(3);
    const first = char.contractBoard![0];
    roster.acceptRotatingContract(char.slotId, first.instanceId);
    const done = roster.completeRotatingContract(char.slotId, first.instanceId);
    expect(done.ok).toBe(true);
    expect(done.rivalId).toBeDefined();

    const updated = roster.getCharacter(char.slotId)!;
    expect(updated.contractBoard![0].instanceId).not.toBe(first.instanceId);
    expect(updated.subFactionStanding[first.subFactionId]).toBeGreaterThan(0);
    expect(updated.subFactionStanding[done.rivalId!]).toBeLessThan(0);

    // Dynamic World Events
    const scene = new THREE.Scene();
    const events = new OpenWorldEventDirector(scene, () => 25);
    expect(events.pickWeightedEventKind(23.0, 0.1)).toBe('smuggler_boat');
    const ev = events.triggerEvent('black_box_drop', 'pmc_alpha');
    expect(ev.guardsAlive).toBe(2);
    expect(ev.lootKit.looseGrid.items.length).toBeGreaterThan(0);
    events.dispose();
  });
});

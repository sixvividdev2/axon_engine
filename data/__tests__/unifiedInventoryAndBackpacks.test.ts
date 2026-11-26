import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldBackpackSystem } from '../../bodycam-sdk/equipment/WorldBackpackSystem';
import {
  addLooseRoundToInventory,
  autoPlaceItemInGrid,
  BASE_ENCUMBRANCE_LIMITS,
  buildModeLoadoutTacticalInventory,
  computeOperatorEncumbrance,
  createAmmoStackItem,
  createBackpackItem,
  createGenericLootItem,
  createLoadedMagazineForWeapon,
  createMagazineItem,
  cycleChamberInWeaponSlot,
  findBestReloadMagazine,
  fireRoundFromWeaponSlot,
  getLoadedAmmoCount,
  loadAmmoStackIntoMagazine,
  resolveMagazineTemplateForWeapon,
  swapMagazineIntoWeapon,
  unloadTopRoundsFromMagazine,
} from '../../src/modes/openworld/inventory/TetrisInventoryCore';
import { BACKPACK_UNLOCK_RANK, backpackUnlockStore } from '../backpackUnlocks';

function makeHeavyItem(name: string, weightKg: number) {
  const item = createGenericLootItem('heavy_test_plate', name, name, 'barter', 2, 2, 250);
  item.weightKg = weightKg;
  return item;
}

describe('Unified Tactical Inventory, Encumbrance, Physical Mags & World Backpacks', () => {
  beforeEach(() => {
    backpackUnlockStore.resetDiscoveriesForTests();
  });

  describe('Weight & Encumbrance 4-band curve + Backpack Capacity Scaling', () => {
    it('scales comfortable, heavy, and max weight thresholds across all 3 backpack tiers', () => {
      const noPack = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: null,
        mode: 'battle',
      });
      const assault = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_assault_20l',
        mode: 'battle',
      });
      const rucksack = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_rucksack_35l',
        mode: 'battle',
      });
      const logistics = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_logistics_55l',
        mode: 'battle',
      });

      const eNone = computeOperatorEncumbrance(noPack);
      const e20 = computeOperatorEncumbrance(assault);
      const e35 = computeOperatorEncumbrance(rucksack);
      const e55 = computeOperatorEncumbrance(logistics);

      expect(eNone.comfortableKg).toBe(BASE_ENCUMBRANCE_LIMITS.comfortableWeightKg);
      expect(eNone.heavyKg).toBe(BASE_ENCUMBRANCE_LIMITS.heavyWeightKg);
      expect(eNone.maxKg).toBe(BASE_ENCUMBRANCE_LIMITS.maxWeightKg);

      expect(e20.maxKg).toBeGreaterThan(eNone.maxKg);
      expect(e35.maxKg).toBeGreaterThan(e20.maxKg);
      expect(e55.maxKg).toBeGreaterThan(e35.maxKg);
      expect(e20.maxKg).toBe(30);
      expect(e35.maxKg).toBe(40);
      expect(e55.maxKg).toBe(52);
    });

    it('transitions smoothly Light -> Moderate -> Heavy -> Overloaded and disables sprint when overloaded', () => {
      const inv = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_assault_20l',
        mode: 'playground',
      });
      // Strip down to light load
      inv.armorPlateId = null;
      inv.backpack!.grid.items = [];
      inv.chestRig!.generalGrid.items = [];

      const light = computeOperatorEncumbrance(inv);
      expect(light.tier).toBe('light');
      expect(light.moveSpeedMult).toBe(1);
      expect(light.canSprint).toBe(true);

      // Push into moderate (> 15 kg, < 23 kg)
      autoPlaceItemInGrid(inv.backpack!.grid, makeHeavyItem('Steel Plate A', 9.0));
      const moderate = computeOperatorEncumbrance(inv);
      expect(moderate.tier).toBe('moderate');
      expect(moderate.moveSpeedMult).toBeLessThan(1);
      expect(moderate.staminaDrainMult).toBeGreaterThan(1);
      expect(moderate.canSprint).toBe(true);

      // Push into heavy (>= 23 kg, <= 30 kg)
      autoPlaceItemInGrid(inv.backpack!.grid, makeHeavyItem('Battery Bank', 8.0));
      const heavy = computeOperatorEncumbrance(inv);
      expect(heavy.tier).toBe('heavy');
      expect(heavy.moveSpeedMult).toBeLessThan(moderate.moveSpeedMult);
      expect(heavy.staminaDrainMult).toBeGreaterThan(moderate.staminaDrainMult);
      expect(heavy.canSprint).toBe(true);

      // Push into overloaded (> 30 kg)
      autoPlaceItemInGrid(inv.backpack!.grid, makeHeavyItem('Generator Core', 8.5));
      const overloaded = computeOperatorEncumbrance(inv);
      expect(overloaded.tier).toBe('overloaded');
      expect(overloaded.canSprint).toBe(false);
      expect(overloaded.moveSpeedMult).toBeLessThan(heavy.moveSpeedMult);
    });
  });

  describe('Physical Magazines, LIFO Packing/Unloading & Chamber Cycling', () => {
    it('prefers Chest Rig magazines (1.0x) over Backpack magazines (1.45x fallback)', () => {
      const inv = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_assault_20l',
        mode: 'battle',
      });
      // Clear chest rig mags, place a loaded mag in backpack first
      inv.chestRig!.rifleMagSlots = inv.chestRig!.rifleMagSlots.map(() => null);
      inv.backpack!.grid.items = [];
      const packMag = createLoadedMagazineForWeapon('m4a1', [
        { variantId: '556x45_m855', count: 30 },
      ]);
      autoPlaceItemInGrid(inv.backpack!.grid, packMag);

      const fromPack = findBestReloadMagazine(inv, 'm4a1', true);
      expect(fromPack).not.toBeNull();
      expect(fromPack!.fromBackpack).toBe(true);
      expect(fromPack!.reloadTimeMult).toBeCloseTo(1.45, 2);

      // Seat a partially loaded mag in the chest rig -> rig must take priority at 1.0x
      inv.chestRig!.rifleMagSlots[0] = createLoadedMagazineForWeapon('m4a1', [
        { variantId: '556x45_m855', count: 18 },
      ]);
      const fromRig = findBestReloadMagazine(inv, 'm4a1', true);
      expect(fromRig).not.toBeNull();
      expect(fromRig!.fromBackpack).toBe(false);
      expect(fromRig!.reloadTimeMult).toBeCloseTo(1.0, 2);
    });

    it('preserves LIFO round ordering when loading/unloading, firing, cycling chamber, and swapping mags', () => {
      const inv = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_assault_20l',
        mode: 'battle',
      });

      const tpl = resolveMagazineTemplateForWeapon('m4a1');
      const mag = createMagazineItem(tpl.templateId, []);
      const fmj = createAmmoStackItem('556x45_m855', 10);
      const ap = createAmmoStackItem('556x45_m995', 3);

      // Load 10 FMJ first (bottom), then 3 AP on top (LIFO top-out)
      const r1 = loadAmmoStackIntoMagazine(mag, fmj, 10);
      expect(r1.loadedCount).toBe(10);
      const r2 = loadAmmoStackIntoMagazine(mag, ap, 3);
      expect(r2.loadedCount).toBe(3);
      expect(mag.rounds.length).toBe(13);

      // Unload 1 top round -> must be AP
      const unloaded = unloadTopRoundsFromMagazine(mag, 1);
      expect(unloaded.length).toBe(1);
      expect(unloaded[0].variantId).toBe('556x45_m995');
      expect(mag.rounds.length).toBe(12);

      // Swap this custom mag into primary and verify old mag is preserved in rig/backpack
      inv.chestRig!.rifleMagSlots[0] = mag;
      const beforeAmmo = getLoadedAmmoCount(inv.primary);
      expect(beforeAmmo).toBeGreaterThan(0);

      const swapRes = swapMagazineIntoWeapon(inv, 'primary', {
        zone: 'chest_rig_rifle',
        slotIndex: 0,
      });
      expect(swapRes.ok).toBe(true);
      expect(inv.primary.loadedMag?.instanceId).toBe(mag.instanceId);

      // Fire 1 round (chambered) then 1 more (top AP from mag), then cycle chamber (next AP)
      const shot1 = fireRoundFromWeaponSlot(inv.primary);
      expect(shot1).not.toBeNull();
      const shot2 = fireRoundFromWeaponSlot(inv.primary);
      expect(shot2?.id).toBe('556x45_m995');

      const cycled = cycleChamberInWeaponSlot(inv.primary);
      expect(cycled.ejectedRound).toBe('556x45_m995');
      expect(cycled.newChamberedRound).toBe('556x45_m855');

      // Recovering the ejected live round puts it back into inventory stacks
      const added = addLooseRoundToInventory(inv, '556x45_m995', 1);
      expect(added).toBe(true);
    });
  });

  describe('WorldBackpackSystem: Drop, 2-Way Transfers, Unequip-First Rule & Unlocks', () => {
    it('retains nested items on drop, persists 2-way transfers, and blocks equip while wearing a pack', () => {
      const scene = new THREE.Scene();
      const worldBackpacks = new WorldBackpackSystem(scene);

      const inv = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: 'pack_assault_20l',
        mode: 'battle',
      });
      const initialItemCount = inv.backpack!.grid.items.length;
      expect(initialItemCount).toBeGreaterThan(0);

      // Spawn a higher-tier world backpack on the ground
      const groundRucksack = createBackpackItem('pack_rucksack_35l');
      const bonusStack = createAmmoStackItem('556x45_m995', 30);
      autoPlaceItemInGrid(groundRucksack.grid, bonusStack);
      const groundEntry = worldBackpacks.spawnBackpack({
        backpack: groundRucksack,
        position: new THREE.Vector3(2, 0, 2),
        isPracticeGear: false,
      });

      // 1. Two-way transfer into unequipped ground backpack while STILL wearing assault pack
      const transferredLoot = createGenericLootItem(
        'enc_drive',
        'Encrypted Drive',
        'Drive',
        'intel',
        1,
        1,
        900,
      );
      autoPlaceItemInGrid(groundRucksack.grid, transferredLoot);
      expect(worldBackpacks.updateContainerContents(groundEntry.id, groundRucksack)).toBe(true);
      expect(worldBackpacks.getEntry(groundEntry.id)?.backpack.grid.items.length).toBe(2);

      // 2. Trying to equip ground backpack while already wearing one MUST fail with requiresUnequipFirst
      const blocked = worldBackpacks.equipFromWorld(groundEntry.id, inv, 1);
      expect(blocked.ok).toBe(false);
      expect(blocked.requiresUnequipFirst).toBe(true);
      expect(inv.backpack?.templateId).toBe('pack_assault_20l');

      // 3. Drop currently equipped assault pack onto the ground — retains all nested items
      const droppedEntry = worldBackpacks.dropFromInventory(
        inv,
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
        () => 0,
      );
      expect(droppedEntry).not.toBeNull();
      expect(inv.backpack).toBeNull();
      expect(droppedEntry!.backpack.grid.items.length).toBe(initialItemCount);

      // 4. Now equipping the ground 35L Rucksack succeeds WITH both nested items intact & permanently unlocks it!
      expect(backpackUnlockStore.isUnlocked('pack_rucksack_35l', 1)).toBe(false);
      const equipped = worldBackpacks.equipFromWorld(groundEntry.id, inv, 1);
      expect(equipped.ok).toBe(true);
      expect(equipped.newlyUnlockedTier).toBe(true);
      expect(inv.backpack?.templateId).toBe('pack_rucksack_35l');
      expect(inv.backpack?.grid.items.length).toBe(2);
      expect(backpackUnlockStore.isUnlocked('pack_rucksack_35l', 1)).toBe(true);

      worldBackpacks.dispose();
    });

    it('enforces Rank 10 / 20 / 30 unlocks and ensures practice rack packs do NOT permanently unlock locked tiers', () => {
      expect(BACKPACK_UNLOCK_RANK.pack_assault_20l).toBe(10);
      expect(BACKPACK_UNLOCK_RANK.pack_rucksack_35l).toBe(20);
      expect(BACKPACK_UNLOCK_RANK.pack_logistics_55l).toBe(30);

      expect(backpackUnlockStore.isUnlocked('pack_assault_20l', 9)).toBe(false);
      expect(backpackUnlockStore.isUnlocked('pack_assault_20l', 10)).toBe(true);
      expect(backpackUnlockStore.isUnlocked('pack_rucksack_35l', 19)).toBe(false);
      expect(backpackUnlockStore.isUnlocked('pack_rucksack_35l', 20)).toBe(true);
      expect(backpackUnlockStore.isUnlocked('pack_logistics_55l', 29)).toBe(false);
      expect(backpackUnlockStore.isUnlocked('pack_logistics_55l', 30)).toBe(true);

      // Equipping a practice rack 55L pack must NOT unlock it at Rank 1
      const scene = new THREE.Scene();
      const worldBackpacks = new WorldBackpackSystem(scene);
      const inv = buildModeLoadoutTacticalInventory({
        primaryWeaponId: 'm4a1',
        secondaryWeaponId: 'makarov_pm',
        backpackId: null,
        mode: 'playground',
      });
      const practiceEntry = worldBackpacks.spawnBackpack({
        backpack: createBackpackItem('pack_logistics_55l'),
        position: new THREE.Vector3(0, 0, 1),
        isPracticeGear: true,
      });
      const res = worldBackpacks.equipFromWorld(practiceEntry.id, inv, 1);
      expect(res.ok).toBe(true);
      expect(res.newlyUnlockedTier).toBe(false);
      expect(backpackUnlockStore.isUnlocked('pack_logistics_55l', 1)).toBe(false);

      worldBackpacks.dispose();
    });
  });
});

import { describe, expect, it } from 'vitest';
import { OperatorSelectionStore } from '../../../../bodycam-sdk/operator/OperatorSelectionStore';
import { CharacterRoster, STARTING_CHARACTER_CASH_USD } from '../CharacterRoster';
import { ClassicHideoutStoreLike, HideoutShardAdapter } from '../HideoutShardAdapter';
import {
  computeFieldHospitalFee,
  getAvailableFieldHospitals,
  getBankruptcyStatus,
  MAX_FIELD_HOSPITAL_FEE_USD,
  MIN_FIELD_HOSPITAL_FEE_USD,
  processCharacterDeath,
} from '../PermadeathService';
import { ShardStore } from '../ShardStore';
import {
  getStandingTier,
  OpenWorldStorageLike,
  PMC_FACTIONS,
  SHARD_RULES,
} from '../types';

function createMemoryStorage(): OpenWorldStorageLike & { writes: number } {
  const map = new Map<string, string>();
  return {
    writes: 0,
    getItem(key: string): string | null {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      this.writes += 1;
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
  };
}

function createMockClassicHideout(): ClassicHideoutStoreLike {
  let state = {
    unlockedWeaponIds: ['m4a1', 'glock_17'],
    wallRackSlots: ['glock_17'] as Array<string | null>,
    equippedWeaponId: 'm4a1',
    ammoReserve: { '556x45': 180, '9x19': 120 } as Record<string, number>,
    gunRangeBestScore: 0,
    gunRangeBestHits: 0,
    gunRangeBestAccuracy: 0,
    gunRangeCoursesCompleted: 0,
    longRangeBestMoa100m: null as number | null,
    longRange100mHits: 0,
    ammoVariantByWeapon: {} as Record<string, string>,
    zeroDistanceByWeapon: {} as Record<string, number>,
  };

  return {
    getState: () => ({
      ...state,
      unlockedWeaponIds: [...state.unlockedWeaponIds],
      wallRackSlots: [...state.wallRackSlots],
      ammoReserve: { ...state.ammoReserve },
      ammoVariantByWeapon: { ...state.ammoVariantByWeapon },
      zeroDistanceByWeapon: { ...state.zeroDistanceByWeapon },
    }),
    syncWithUnlockedCheck: () => ({
      ...state,
      unlockedWeaponIds: [...state.unlockedWeaponIds],
      wallRackSlots: [...state.wallRackSlots],
      ammoReserve: { ...state.ammoReserve },
      ammoVariantByWeapon: { ...state.ammoVariantByWeapon },
      zeroDistanceByWeapon: { ...state.zeroDistanceByWeapon },
    }),
    commitRackSwap: (slotIndex: number) => {
      const prev = state.equippedWeaponId;
      const target = state.wallRackSlots[slotIndex] ?? null;
      const next = target ?? 'unarmed';
      state.wallRackSlots[slotIndex] = prev === 'unarmed' ? null : prev;
      state.equippedWeaponId = next;
      return { previousEquipped: prev, nextEquipped: next };
    },
    setEquippedWeaponDirect: (weaponId: string) => {
      state.equippedWeaponId = weaponId;
    },
    getReserveForWeapon: () => 180,
    consumeReserve: (_w: string, rounds: number) => rounds,
    resupplyAllAmmo: () => {
      state.ammoReserve = { '556x45': 180, '9x19': 120 };
    },
    setWeaponAmmoVariant: (weaponId: string, variantId: string) => {
      state.ammoVariantByWeapon[weaponId] = variantId;
    },
    setWeaponZeroDistance: (weaponId: string, zeroDistanceM: number) => {
      state.zeroDistanceByWeapon[weaponId] = zeroDistanceM;
    },
  };
}

describe('Phase 1: Roster, Dual Shards, Permadeath & Hideout Wiring', () => {
  it('enforces 3-slot creation rules, unique callsigns, and locked creation attributes', () => {
    const storage = createMemoryStorage();
    const roster = new CharacterRoster({ storage });

    const r0 = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'VANGUARD-1',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    expect(r0.ok).toBe(true);
    expect(r0.character?.cash).toBe(STARTING_CHARACTER_CASH_USD);
    expect(r0.character?.shardMode).toBe('PvPvE');
    expect(r0.character?.pmcFaction).toBe('pmc_alpha');
    expect(r0.character?.bodyType).toBe('male');

    // Reject duplicate slot
    const dupSlot = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'OTHER-2',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
    });
    expect(dupSlot.ok).toBe(false);

    // Reject duplicate callsign (case-insensitive)
    const dupName = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'vanguard-1',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
    });
    expect(dupName.ok).toBe(false);

    // Create slot_1 and slot_2 cleanly
    const r1 = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'KESTREL-2',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
    });
    const r2 = roster.createCharacter({
      slotId: 'slot_2',
      callsign: 'WARDEN-3',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'male',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(roster.listCharacters()).toHaveLength(3);

    // Persistence round-trip restores all 3 characters with locked attributes intact
    const reloaded = new CharacterRoster({ storage });
    expect(reloaded.getCharacter('slot_0')?.callsign).toBe('VANGUARD-1');
    expect(reloaded.getCharacter('slot_1')?.bodyType).toBe('female');
    expect(reloaded.getCharacter('slot_1')?.shardMode).toBe('PvE');
    expect(reloaded.getCharacter('slot_2')?.pmcFaction).toBe('pmc_bravo');
  });

  it('100% isolates Arsenal Wall, cash, stash, reputation, and M/F operator rig across characters on opposite shards', () => {
    const rosterStorage = createMemoryStorage();
    const shardStorage = createMemoryStorage();
    const opStorage = createMemoryStorage();

    const roster = new CharacterRoster({ storage: rosterStorage });
    const shards = new ShardStore({ storage: shardStorage });
    const classic = createMockClassicHideout();
    const opStore = new OperatorSelectionStore({ storage: opStorage, search: '' });
    const adapter = new HideoutShardAdapter(roster, shards, classic, opStore);

    // Character A: PvPvE, PMC Alpha, Male
    roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'ALPHA-M',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
      activate: true,
    });
    // HK416 is locked at Quartermaster Lv 1 until Character A earns the Lv 2 unlock entitlement
    expect(roster.purchaseWeaponToArsenal('slot_0', 'hk416', 4600).ok).toBe(false);
    expect(roster.levelUpTrader('slot_0', 'quartermaster_pmc').ok).toBe(true);
    // Purchase HK416 exclusively on Character A
    const buyA = roster.purchaseWeaponToArsenal('slot_0', 'hk416', 4600);
    expect(buyA.ok).toBe(true);
    roster.updateSubFactionStanding('slot_0', 'dockworkers_syndicate', 60);

    // Character B: PvE, PMC Bravo, Female
    roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'BRAVO-F',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
      activate: true,
    });
    roster.updateSubFactionStanding('slot_1', 'alpine_remnant', -40);

    // Verify HideoutShardAdapter switches rig to FEMALE + team_b and mounts ONLY Character B's Arsenal Wall
    expect(opStore.getSelectedOperator()).toBe('FEMALE');
    expect(opStore.getGearConfig().uniformId).toBe(PMC_FACTIONS.pmc_bravo.uniformId);

    const wallB = adapter.syncOwnedWeapons(() => true);
    expect(wallB.isOpenWorldActive).toBe(true);
    expect(wallB.ownedWeaponIds).toEqual([...PMC_FACTIONS.pmc_bravo.starterWeaponIds]);
    expect(wallB.ownedWeaponIds).not.toContain('hk416');
    expect(wallB.ownedWeaponIds).not.toContain('m4a1');

    // Switch back to Character A: rig switches to MALE + team_a, Arsenal Wall shows ONLY Character A's guns (including hk416)
    roster.setActiveSlot('slot_0');
    expect(opStore.getSelectedOperator()).toBe('MALE');
    expect(opStore.getGearConfig().uniformId).toBe(PMC_FACTIONS.pmc_alpha.uniformId);

    const wallA = adapter.syncOwnedWeapons(() => true);
    expect(wallA.ownedWeaponIds).toContain('m4a1');
    expect(wallA.ownedWeaponIds).toContain('hk416');
    expect(wallA.ownedWeaponIds).not.toContain('akm_762');

    // Verify independent cash & reputation meters
    const charA = roster.getCharacter('slot_0')!;
    const charB = roster.getCharacter('slot_1')!;
    expect(charA.cash).toBe(STARTING_CHARACTER_CASH_USD - 4600);
    expect(charB.cash).toBe(STARTING_CHARACTER_CASH_USD);
    expect(getStandingTier(charA.subFactionStanding.dockworkers_syndicate)).toBe('Trusted');
    expect(getStandingTier(charB.subFactionStanding.dockworkers_syndicate)).toBe('Neutral');
    expect(getStandingTier(charB.subFactionStanding.alpine_remnant)).toBe('Hostile');

    // Switching to null transparently restores Classic Career Hideout mode
    roster.setActiveSlot(null);
    const wallClassic = adapter.syncOwnedWeapons(() => true);
    expect(wallClassic.isOpenWorldActive).toBe(false);
    expect(wallClassic.ownedWeaponIds).toEqual(['m4a1', 'glock_17']);

    adapter.dispose();
  });

  it('strictly isolates PvPvE vs PvE shard rules, supply pools, and player corpse looting permissions', () => {
    const shards = new ShardStore({ storage: createMemoryStorage() });

    expect(SHARD_RULES.PvPvE.pmcHostile).toBe(true);
    expect(SHARD_RULES.PvPvE.corpseLootingPlayers).toBe(true);
    expect(SHARD_RULES.PvE.pmcHostile).toBe(false);
    expect(SHARD_RULES.PvE.corpseLootingPlayers).toBe(false);

    // Mutate PvPvE supply pool only
    const beforePvE = shards.getShard('PvE');
    shards.adjustPmcSupply(
      'PvPvE',
      'pmc_alpha',
      { ammo: -15, medical: -10 },
      'sector_flip',
      'Test supply drain in PvPvE',
    );
    expect(shards.getShard('PvPvE').pmcSupplyPools.pmc_alpha.ammo).toBe(53);
    expect(shards.getShard('PvE').pmcSupplyPools.pmc_alpha.ammo).toBe(
      beforePvE.pmcSupplyPools.pmc_alpha.ammo,
    );

    // Corpse looting permissions differ strictly by shard
    const pvpCorpse = shards.addDroppedCorpse('PvPvE', {
      corpseId: 'corpse_pvp_1',
      ownerCharacterId: 'char_owner',
      ownerCallsign: 'OWNER',
      ownerFaction: 'pmc_alpha',
      worldX: 100,
      worldZ: 200,
      sectorLabel: 'Port Pier',
      causeOfDeath: 'KIA',
      droppedWeaponIds: ['m4a1'],
      droppedArmorName: 'JPC-2',
      droppedRigName: 'Mk4',
      droppedItems: [],
      createdAtIso: new Date().toISOString(),
    });
    const pveCorpse = shards.addDroppedCorpse('PvE', {
      corpseId: 'corpse_pve_1',
      ownerCharacterId: 'char_owner',
      ownerCallsign: 'OWNER',
      ownerFaction: 'pmc_alpha',
      worldX: 100,
      worldZ: 200,
      sectorLabel: 'Port Pier',
      causeOfDeath: 'KIA',
      droppedWeaponIds: ['akm_762'],
      droppedArmorName: '6B45',
      droppedRigName: 'Smersh',
      droppedItems: [],
      createdAtIso: new Date().toISOString(),
    });

    expect(shards.canCharacterLootCorpse('PvPvE', pvpCorpse.corpseId, 'char_rival')).toBe(true);
    expect(shards.canCharacterLootCorpse('PvE', pveCorpse.corpseId, 'char_rival')).toBe(false);
    expect(shards.canCharacterLootCorpse('PvE', pveCorpse.corpseId, 'char_owner')).toBe(true);
  });

  it('scales Field Hospital fees ($2,500–$15,000), unlocks Trusted sub-faction medbays, and handles solvent full-drop respawn while retaining Secure Container', () => {
    const roster = new CharacterRoster({ storage: createMemoryStorage() });
    const shards = new ShardStore({ storage: createMemoryStorage() });

    roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'MEDIC-TEST',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });

    const initial = roster.getCharacter('slot_0')!;
    expect(computeFieldHospitalFee(initial)).toBe(MIN_FIELD_HOSPITAL_FEE_USD);

    // Advance to max tier -> fee caps cleanly at $15,000
    roster.advanceProgressionTier('slot_0', 5, 18);
    const veteran = roster.getCharacter('slot_0')!;
    expect(computeFieldHospitalFee(veteran)).toBe(MAX_FIELD_HOSPITAL_FEE_USD);

    // Reset to Tier 1 and unlock Trusted Syndicate Hospital (+50 standing)
    const roster2 = new CharacterRoster({ storage: createMemoryStorage() });
    roster2.createCharacter({
      slotId: 'slot_0',
      callsign: 'SOLVENT-1',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    roster2.updateSubFactionStanding('slot_0', 'dockworkers_syndicate', 55);
    const readyChar = roster2.getCharacter('slot_0')!;
    const hospitals = getAvailableFieldHospitals(readyChar);
    const syndicateMedbay = hospitals.find((h) => h.id === 'hosp_syndicate_drydock');
    expect(syndicateMedbay?.unlocked).toBe(true);

    const secureBefore = readyChar.secureContainerItems.map((i) => i.itemId);
    const cashBefore = readyChar.cash;
    const fee = computeFieldHospitalFee(readyChar);

    const outcome = processCharacterDeath(roster2, shards, {
      slotId: 'slot_0',
      hospitalId: 'hosp_syndicate_drydock',
      sectorLabel: 'Delta Drydock',
    });

    expect(outcome?.outcome).toBe('field_hospital_respawn');
    if (outcome?.outcome === 'field_hospital_respawn') {
      expect(outcome.feePaid).toBe(fee);
      expect(outcome.remainingCash).toBe(cashBefore - fee);
      expect(outcome.hospital.id).toBe('hosp_syndicate_drydock');
      // Full-drop weapons moved to corpse and stripped from Arsenal Wall
      expect(outcome.droppedCorpse.droppedWeaponIds).toContain('m4a1');
      expect(outcome.droppedCorpse.droppedWeaponIds).toContain('glock_17');
      expect(outcome.updatedCharacter.arsenal.ownedWeaponIds).not.toContain('m4a1');
      expect(outcome.updatedCharacter.arsenal.ownedWeaponIds).toContain('hk_mp5');
      // Secure Container items 100% retained
      expect(outcome.retainedSecureItems.map((i) => i.itemId)).toEqual(secureBefore);
    }

    // Corpse exists ONLY in PvPvE shard, not in PvE shard
    expect(shards.getShard('PvPvE').corpses).toHaveLength(1);
    expect(shards.getShard('PvE').corpses).toHaveLength(0);
  });

  it('triggers Bankruptcy Warning on PDA/adapter when cash < respawn fee and permanently wipes character slot upon death', () => {
    const roster = new CharacterRoster({ storage: createMemoryStorage() });
    const shards = new ShardStore({ storage: createMemoryStorage() });
    const classic = createMockClassicHideout();
    const opStore = new OperatorSelectionStore({ storage: createMemoryStorage(), search: '' });
    const adapter = new HideoutShardAdapter(roster, shards, classic, opStore);

    roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'BROKE-OP',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'SURVIVOR-2',
      shardMode: 'PvE',
      pmcFaction: 'pmc_bravo',
      bodyType: 'female',
      activate: false,
    });

    // Drop cash below $2,500 Field Hospital fee
    roster.setCash('slot_0', 900);
    const atRisk = roster.getCharacter('slot_0')!;
    const status = getBankruptcyStatus(atRisk);
    expect(status.isBankruptcyRisk).toBe(true);
    expect(status.shortfall).toBe(1600);
    expect(status.pdaBannerText).toContain('BANKRUPTCY WARNING');

    const pdaOverlay = adapter.getPdaTelemetryOverlay();
    expect(pdaOverlay.active).toBe(true);
    expect(pdaOverlay.bankruptcyWarning).toBe(true);
    expect(pdaOverlay.bankruptcyText).toContain('BANKRUPTCY WARNING');

    // Triggering death with cash < respawnFee permanently deletes slot_0
    const death = processCharacterDeath(roster, shards, {
      slotId: 'slot_0',
      sectorLabel: 'Alpine Dam Approach',
    });

    expect(death?.outcome).toBe('permadeath_wiped');
    expect(roster.getCharacter('slot_0')).toBeNull();
    // Active slot cleanly shifts to remaining slot_1; slot_1 remains 100% intact
    expect(roster.getActiveSlotId()).toBe('slot_1');
    expect(roster.getCharacter('slot_1')?.callsign).toBe('SURVIVOR-2');
    // Corpse still persisted in PvPvE shard
    expect(shards.getShard('PvPvE').corpses).toHaveLength(1);
    expect(shards.getShard('PvPvE').corpses[0].ownerCallsign).toBe('BROKE-OP');

    adapter.dispose();
  });
});

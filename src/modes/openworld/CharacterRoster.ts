import { useEffect, useState } from 'react';
import { resolveWeaponProfile } from '../../../bodycam-sdk/weaponProfiles';
import {
  DEFAULT_OPERATOR_GEAR,
  normalizeOperatorGearConfig,
  OperatorGearConfig,
} from '../../../bodycam-sdk/operator/OperatorTypes';
import { resolveBaseCaliberId } from '../../../data/calibers';
import { normalizeLoadoutWeaponId } from '../../../data/loadoutStore';
import { getDefaultReserveForCaliber } from '../../../hideout/HideoutStateStore';
import {
  CHARACTER_SLOT_IDS,
  CharacterArsenalState,
  CharacterBodyType,
  CharacterSlotId,
  CreateCharacterInput,
  getSecureContainerCapacity,
  InventoryItemRecord,
  OpenWorldCharacter,
  OpenWorldStorageLike,
  PMC_FACTIONS,
  PmcFactionId,
  resolveDefaultStorage,
  ShardMode,
  STANDING_MAX,
  STANDING_MIN,
  SubFactionId,
} from './types';

export interface CharacterRosterState {
  activeSlotId: CharacterSlotId | null;
  slots: Record<CharacterSlotId, OpenWorldCharacter | null>;
}

export interface CharacterRosterOptions {
  storage?: OpenWorldStorageLike | null;
  storageKey?: string;
}

export interface CreateCharacterResult {
  ok: boolean;
  error?: string;
  character?: OpenWorldCharacter;
}

export interface PurchaseWeaponResult {
  ok: boolean;
  error?: string;
  remainingCash?: number;
}

const DEFAULT_STORAGE_KEY = 'axon_openworld_roster_v1';
const MAX_ARSENAL_WALL_SLOTS = 12;
export const STARTING_CHARACTER_CASH_USD = 12000;

const DEFAULT_AMMO_RESERVE: Readonly<Record<string, number>> = {
  '9x19': 120,
  '45acp': 84,
  '50ae': 49,
  '357mag': 54,
  '762x38r': 56,
  '57x28': 150,
  '556x45': 180,
  '545x39': 180,
  '762x39': 180,
  '762x51': 100,
  '762x54r': 80,
  '338_lm': 40,
  '12ga': 48,
};

function makeItemId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function buildStarterStashAndSecure(faction: PmcFactionId): {
  stashItems: InventoryItemRecord[];
  secureContainerItems: InventoryItemRecord[];
  backpackItems: InventoryItemRecord[];
} {
  if (faction === 'pmc_alpha') {
    return {
      stashItems: [
        {
          instanceId: makeItemId('item'),
          itemId: 'ifak_surgical',
          name: 'IFAK Surgical Kit',
          category: 'medical',
          quantity: 2,
          valueUsd: 950,
          slots: 1,
        },
        {
          instanceId: makeItemId('item'),
          itemId: 'ammo_case_556',
          name: '5.56x45 M855A1 Ammo Pack (60rd)',
          category: 'ammo',
          quantity: 2,
          valueUsd: 700,
          slots: 1,
        },
      ],
      secureContainerItems: [
        {
          instanceId: makeItemId('sec'),
          itemId: 'alpha_fob_key',
          name: 'Alpha FOB Armory Keycard',
          category: 'key',
          quantity: 1,
          valueUsd: 1800,
          slots: 1,
        },
        {
          instanceId: makeItemId('sec'),
          itemId: 'encrypted_ssd',
          name: 'Encrypted Recon Drive',
          category: 'intel',
          quantity: 1,
          valueUsd: 2400,
          slots: 1,
        },
      ],
      backpackItems: [
        {
          instanceId: makeItemId('bp'),
          itemId: 'field_bandage',
          name: 'Hemostatic Bandage Roll',
          category: 'medical',
          quantity: 2,
          valueUsd: 220,
          slots: 1,
        },
        {
          instanceId: makeItemId('bp'),
          itemId: 'mre_ration',
          name: 'Tactical Field Ration',
          category: 'barter',
          quantity: 1,
          valueUsd: 140,
          slots: 1,
        },
      ],
    };
  }

  return {
    stashItems: [
      {
        instanceId: makeItemId('item'),
        itemId: 'cms_trauma_kit',
        name: 'Field Trauma Surgery Kit',
        category: 'medical',
        quantity: 2,
        valueUsd: 900,
        slots: 1,
      },
      {
        instanceId: makeItemId('item'),
        itemId: 'ammo_tin_762',
        name: '7.62x39 PS Steel-Core Tin (60rd)',
        category: 'ammo',
        quantity: 2,
        valueUsd: 680,
        slots: 1,
      },
    ],
    secureContainerItems: [
      {
        instanceId: makeItemId('sec'),
        itemId: 'bravo_depot_key',
        name: 'Bravo Supply Depot Key',
        category: 'key',
        quantity: 1,
        valueUsd: 1800,
        slots: 1,
      },
      {
        instanceId: makeItemId('sec'),
        itemId: 'cipher_tape',
        name: 'Ciphered Comms Reel',
        category: 'intel',
        quantity: 1,
        valueUsd: 2200,
        slots: 1,
      },
    ],
    backpackItems: [
      {
        instanceId: makeItemId('bp'),
        itemId: 'ai2_medkit',
        name: 'AI-2 Field Medkit',
        category: 'medical',
        quantity: 2,
        valueUsd: 240,
        slots: 1,
      },
      {
        instanceId: makeItemId('bp'),
        itemId: 'copper_wire',
        name: 'Military Relay Spool',
        category: 'barter',
        quantity: 1,
        valueUsd: 190,
        slots: 1,
      },
    ],
  };
}

function reconcileRackSlots(
  ownedWeaponIds: readonly string[],
  prevSlots: ReadonlyArray<string | null>,
  equippedWeaponId: string,
): Array<string | null> {
  const uniqueOwned = Array.from(new Set(ownedWeaponIds));
  const ownedSet = new Set(uniqueOwned);
  const nextSlots: Array<string | null> = [];
  const placed = new Set<string>();

  if (equippedWeaponId !== 'unarmed' && ownedSet.has(equippedWeaponId)) {
    placed.add(equippedWeaponId);
  }

  for (const slotId of prevSlots) {
    if (nextSlots.length >= MAX_ARSENAL_WALL_SLOTS) break;
    if (slotId === null) {
      nextSlots.push(null);
    } else if (ownedSet.has(slotId) && !placed.has(slotId)) {
      nextSlots.push(slotId);
      placed.add(slotId);
    }
  }

  for (const ownedId of uniqueOwned) {
    if (placed.has(ownedId)) continue;
    if (nextSlots.length < MAX_ARSENAL_WALL_SLOTS) {
      nextSlots.push(ownedId);
      placed.add(ownedId);
    } else {
      const emptyIdx = nextSlots.indexOf(null);
      if (emptyIdx >= 0) {
        nextSlots[emptyIdx] = ownedId;
        placed.add(ownedId);
      }
    }
  }

  const targetBracketCount = Math.min(MAX_ARSENAL_WALL_SLOTS, uniqueOwned.length);
  while (nextSlots.length > targetBracketCount) {
    const lastNull = nextSlots.lastIndexOf(null);
    if (lastNull >= 0) nextSlots.splice(lastNull, 1);
    else break;
  }

  if (
    equippedWeaponId !== 'unarmed' &&
    ownedSet.has(equippedWeaponId) &&
    !nextSlots.includes(null) &&
    nextSlots.length < targetBracketCount
  ) {
    nextSlots.push(null);
  }

  return nextSlots;
}

function buildStarterArsenal(faction: PmcFactionId): CharacterArsenalState {
  const spec = PMC_FACTIONS[faction];
  const owned = [...spec.starterWeaponIds];
  const equipped = spec.starterEquippedWeaponId;
  const rack = reconcileRackSlots(owned, [], equipped);
  return {
    ownedWeaponIds: owned,
    wallRackSlots: rack,
    equippedWeaponId: equipped,
    ammoReserve: { ...DEFAULT_AMMO_RESERVE },
    ammoVariantByWeapon: {},
    zeroDistanceByWeapon: {},
    weaponAttachments: {},
  };
}

function cloneCharacter(c: OpenWorldCharacter): OpenWorldCharacter {
  return {
    ...c,
    stashItems: c.stashItems.map((it) => ({ ...it })),
    secureContainerItems: c.secureContainerItems.map((it) => ({ ...it })),
    arsenal: {
      ownedWeaponIds: [...c.arsenal.ownedWeaponIds],
      wallRackSlots: [...c.arsenal.wallRackSlots],
      equippedWeaponId: c.arsenal.equippedWeaponId,
      ammoReserve: { ...c.arsenal.ammoReserve },
      ammoVariantByWeapon: { ...c.arsenal.ammoVariantByWeapon },
      zeroDistanceByWeapon: { ...c.arsenal.zeroDistanceByWeapon },
      weaponAttachments: Object.fromEntries(
        Object.entries(c.arsenal.weaponAttachments).map(([k, v]) => [k, { ...v }]),
      ),
    },
    equippedKit: {
      ...c.equippedKit,
      backpackItems: c.equippedKit.backpackItems.map((it) => ({ ...it })),
    },
    missions: {
      ...c.missions,
      activeContractIds: [...c.missions.activeContractIds],
    },
    ownedVehicleKeys: c.ownedVehicleKeys.map((v) => ({ ...v })),
    subFactionStanding: { ...c.subFactionStanding },
    operatorGear: { ...c.operatorGear },
  };
}

function sanitizeLoadedCharacter(
  slotId: CharacterSlotId,
  raw: unknown,
): OpenWorldCharacter | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<OpenWorldCharacter>;
  const callsign = typeof obj.callsign === 'string' ? obj.callsign.trim().slice(0, 20) : '';
  if (!callsign) return null;

  const shardMode: ShardMode = obj.shardMode === 'PvE' ? 'PvE' : 'PvPvE';
  const pmcFaction: PmcFactionId = obj.pmcFaction === 'pmc_bravo' ? 'pmc_bravo' : 'pmc_alpha';
  const bodyType: CharacterBodyType = obj.bodyType === 'female' ? 'female' : 'male';
  const factionSpec = PMC_FACTIONS[pmcFaction];

  const ownedRaw = Array.isArray(obj.arsenal?.ownedWeaponIds)
    ? obj.arsenal.ownedWeaponIds
        .map((id) => normalizeLoadoutWeaponId(id, ''))
        .filter((id) => Boolean(id))
    : [...factionSpec.starterWeaponIds];
  const ownedUnique = Array.from(new Set(ownedRaw));
  const ownedSet = new Set(ownedUnique);

  const equippedRaw =
    obj.arsenal?.equippedWeaponId === 'unarmed'
      ? 'unarmed'
      : normalizeLoadoutWeaponId(obj.arsenal?.equippedWeaponId, ownedUnique[0] ?? 'unarmed');
  const equippedWeaponId =
    equippedRaw !== 'unarmed' && !ownedSet.has(equippedRaw)
      ? (ownedUnique[0] ?? 'unarmed')
      : equippedRaw;

  const rawRack = Array.isArray(obj.arsenal?.wallRackSlots)
    ? obj.arsenal.wallRackSlots.map((id) => (id ? normalizeLoadoutWeaponId(id, '') || null : null))
    : [];

  const wallRackSlots = reconcileRackSlots(ownedUnique, rawRack, equippedWeaponId);

  const clampStanding = (val: unknown): number => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return 0;
    return Math.max(STANDING_MIN, Math.min(STANDING_MAX, Math.round(val)));
  };

  return {
    slotId,
    characterId:
      typeof obj.characterId === 'string' && obj.characterId.trim()
        ? obj.characterId
        : `char_${slotId}_${Date.now()}`,
    callsign,
    shardMode,
    pmcFaction,
    bodyType,
    createdAtIso:
      typeof obj.createdAtIso === 'string' ? obj.createdAtIso : new Date().toISOString(),
    cash:
      typeof obj.cash === 'number' && Number.isFinite(obj.cash)
        ? Math.max(0, Math.round(obj.cash))
        : STARTING_CHARACTER_CASH_USD,
    stashItems: Array.isArray(obj.stashItems) ? obj.stashItems.map((it) => ({ ...it })) : [],
    secureContainerTier: obj.secureContainerTier === '3x3' ? '3x3' : '2x2',
    secureContainerItems: Array.isArray(obj.secureContainerItems)
      ? obj.secureContainerItems.map((it) => ({ ...it }))
      : [],
    arsenal: {
      ownedWeaponIds: ownedUnique,
      wallRackSlots,
      equippedWeaponId,
      ammoReserve: {
        ...DEFAULT_AMMO_RESERVE,
        ...(obj.arsenal?.ammoReserve && typeof obj.arsenal.ammoReserve === 'object'
          ? obj.arsenal.ammoReserve
          : {}),
      },
      ammoVariantByWeapon:
        obj.arsenal?.ammoVariantByWeapon && typeof obj.arsenal.ammoVariantByWeapon === 'object'
          ? { ...obj.arsenal.ammoVariantByWeapon }
          : {},
      zeroDistanceByWeapon:
        obj.arsenal?.zeroDistanceByWeapon && typeof obj.arsenal.zeroDistanceByWeapon === 'object'
          ? { ...obj.arsenal.zeroDistanceByWeapon }
          : {},
      weaponAttachments:
        obj.arsenal?.weaponAttachments && typeof obj.arsenal.weaponAttachments === 'object'
          ? { ...obj.arsenal.weaponAttachments }
          : {},
    },
    equippedKit: {
      primaryWeaponId: obj.equippedKit?.primaryWeaponId ?? null,
      secondaryWeaponId: obj.equippedKit?.secondaryWeaponId ?? null,
      armorName: obj.equippedKit?.armorName ?? null,
      rigName: obj.equippedKit?.rigName ?? null,
      backpackItems: Array.isArray(obj.equippedKit?.backpackItems)
        ? obj.equippedKit.backpackItems.map((it) => ({ ...it }))
        : [],
    },
    missions: {
      progressionTier:
        typeof obj.missions?.progressionTier === 'number' &&
        Number.isFinite(obj.missions.progressionTier)
          ? Math.max(1, Math.min(6, Math.floor(obj.missions.progressionTier)))
          : 1,
      completedContracts:
        typeof obj.missions?.completedContracts === 'number' &&
        Number.isFinite(obj.missions.completedContracts)
          ? Math.max(0, Math.floor(obj.missions.completedContracts))
          : 0,
      activeContractIds: Array.isArray(obj.missions?.activeContractIds)
        ? [...obj.missions.activeContractIds]
        : [],
    },
    ownedVehicleKeys: Array.isArray(obj.ownedVehicleKeys)
      ? obj.ownedVehicleKeys.map((v) => ({ ...v }))
      : [],
    subFactionStanding: {
      dockworkers_syndicate: clampStanding(obj.subFactionStanding?.dockworkers_syndicate),
      highland_militia: clampStanding(obj.subFactionStanding?.highland_militia),
      alpine_remnant: clampStanding(obj.subFactionStanding?.alpine_remnant),
    },
    operatorGear: normalizeOperatorGearConfig({
      ...DEFAULT_OPERATOR_GEAR,
      uniformId: factionSpec.uniformId,
      ...(obj.operatorGear ?? {}),
    }),
    deploymentState: obj.deploymentState === 'deployed' ? 'deployed' : 'hideout',
    lastHospitalId:
      typeof obj.lastHospitalId === 'string' && obj.lastHospitalId
        ? obj.lastHospitalId
        : factionSpec.homeHospitalId,
    deathsCount:
      typeof obj.deathsCount === 'number' && Number.isFinite(obj.deathsCount)
        ? Math.max(0, Math.floor(obj.deathsCount))
        : 0,
    exfilsCount:
      typeof obj.exfilsCount === 'number' && Number.isFinite(obj.exfilsCount)
        ? Math.max(0, Math.floor(obj.exfilsCount))
        : 0,
  };
}

type RosterListener = (state: CharacterRosterState) => void;

/**
 * Three-Character Account Roster (`slot_0` – `slot_2`).
 * - Permanent creation-locked attributes: `shardMode`, `pmcFaction`, `bodyType`, `callsign`.
 * - 100% isolated progression per character: cash, stash, 3D Hideout Arsenal Wall,
 *   mission progression, owned vehicle keys, and 3 regional sub-faction reputation meters.
 * - Persists strictly on discrete state transitions (zero per-frame writes).
 */
export class CharacterRoster {
  private state: CharacterRosterState;
  private readonly listeners = new Set<RosterListener>();
  private readonly customStorage?: OpenWorldStorageLike | null;
  private readonly storageKey: string;
  private memoryRaw: string | null = null;

  constructor(options?: CharacterRosterOptions) {
    this.customStorage = options?.storage;
    this.storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
    this.state = this.load();
  }

  private getStorage(): OpenWorldStorageLike | null {
    if (this.customStorage !== undefined) return this.customStorage;
    return resolveDefaultStorage();
  }

  private load(): CharacterRosterState {
    const empty: CharacterRosterState = {
      activeSlotId: null,
      slots: {
        slot_0: null,
        slot_1: null,
        slot_2: null,
      },
    };

    const storage = this.getStorage();
    let raw: string | null = this.memoryRaw;
    if (storage) {
      try {
        raw = storage.getItem(this.storageKey);
      } catch {
        raw = this.memoryRaw;
      }
    }
    if (!raw) return empty;

    try {
      const parsed = JSON.parse(raw) as Partial<CharacterRosterState>;
      const slots: Record<CharacterSlotId, OpenWorldCharacter | null> = {
        slot_0: sanitizeLoadedCharacter('slot_0', parsed.slots?.slot_0),
        slot_1: sanitizeLoadedCharacter('slot_1', parsed.slots?.slot_1),
        slot_2: sanitizeLoadedCharacter('slot_2', parsed.slots?.slot_2),
      };
      const candidateActive =
        parsed.activeSlotId && CHARACTER_SLOT_IDS.includes(parsed.activeSlotId)
          ? parsed.activeSlotId
          : null;
      const activeSlotId = candidateActive && slots[candidateActive] ? candidateActive : null;
      return { activeSlotId, slots };
    } catch {
      return empty;
    }
  }

  private persistAndEmit(): void {
    const encoded = JSON.stringify(this.state);
    this.memoryRaw = encoded;
    const storage = this.getStorage();
    if (storage) {
      try {
        storage.setItem(this.storageKey, encoded);
      } catch {
        // Retain in-memory state if localStorage quota exceeded
      }
    }
    const snap = this.getState();
    for (const fn of this.listeners) fn(snap);
  }

  public getState(): CharacterRosterState {
    return {
      activeSlotId: this.state.activeSlotId,
      slots: {
        slot_0: this.state.slots.slot_0 ? cloneCharacter(this.state.slots.slot_0) : null,
        slot_1: this.state.slots.slot_1 ? cloneCharacter(this.state.slots.slot_1) : null,
        slot_2: this.state.slots.slot_2 ? cloneCharacter(this.state.slots.slot_2) : null,
      },
    };
  }

  public getCharacter(slotId: CharacterSlotId): OpenWorldCharacter | null {
    const c = this.state.slots[slotId];
    return c ? cloneCharacter(c) : null;
  }

  public getActiveCharacter(): OpenWorldCharacter | null {
    if (!this.state.activeSlotId) return null;
    return this.getCharacter(this.state.activeSlotId);
  }

  public getActiveSlotId(): CharacterSlotId | null {
    return this.state.activeSlotId;
  }

  public listCharacters(): OpenWorldCharacter[] {
    const out: OpenWorldCharacter[] = [];
    for (const id of CHARACTER_SLOT_IDS) {
      const c = this.state.slots[id];
      if (c) out.push(cloneCharacter(c));
    }
    return out;
  }

  public createCharacter(input: CreateCharacterInput): CreateCharacterResult {
    const { slotId, shardMode, pmcFaction, bodyType } = input;
    if (!CHARACTER_SLOT_IDS.includes(slotId)) {
      return { ok: false, error: 'Invalid character slot.' };
    }
    if (this.state.slots[slotId] !== null) {
      return { ok: false, error: 'Character slot is already occupied.' };
    }

    const callsign = input.callsign.trim().replace(/\s+/g, ' ').slice(0, 20);
    if (callsign.length < 2) {
      return { ok: false, error: 'Callsign must be at least 2 characters.' };
    }

    const lower = callsign.toLowerCase();
    for (const id of CHARACTER_SLOT_IDS) {
      const existing = this.state.slots[id];
      if (existing && existing.callsign.toLowerCase() === lower) {
        return { ok: false, error: `Callsign "${callsign}" is already assigned to another slot.` };
      }
    }

    const factionSpec = PMC_FACTIONS[pmcFaction];
    const starterItems = buildStarterStashAndSecure(pmcFaction);
    const starterArsenal = buildStarterArsenal(pmcFaction);
    const secondaryStarter =
      factionSpec.starterWeaponIds.find((w) => {
        const prof = resolveWeaponProfile(w);
        return prof.category === 'pistols' || prof.category === 'revolvers';
      }) ?? null;

    const character: OpenWorldCharacter = {
      slotId,
      characterId: `op_${slotId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      callsign,
      shardMode,
      pmcFaction,
      bodyType,
      createdAtIso: new Date().toISOString(),
      cash: STARTING_CHARACTER_CASH_USD,
      stashItems: starterItems.stashItems,
      secureContainerTier: '2x2',
      secureContainerItems: starterItems.secureContainerItems,
      arsenal: starterArsenal,
      equippedKit: {
        primaryWeaponId: factionSpec.starterEquippedWeaponId,
        secondaryWeaponId: secondaryStarter,
        armorName: factionSpec.starterArmorName,
        rigName: factionSpec.starterRigName,
        backpackItems: starterItems.backpackItems,
      },
      missions: {
        progressionTier: 1,
        completedContracts: 0,
        activeContractIds: [],
      },
      ownedVehicleKeys: [],
      subFactionStanding: {
        dockworkers_syndicate: 0,
        highland_militia: 0,
        alpine_remnant: 0,
      },
      operatorGear: normalizeOperatorGearConfig({
        ...DEFAULT_OPERATOR_GEAR,
        uniformId: factionSpec.uniformId,
        helmetColor: pmcFaction === 'pmc_alpha' ? 'black' : 'olive_drab',
        gloveColor: pmcFaction === 'pmc_alpha' ? 'charcoal' : 'olive',
      }),
      deploymentState: 'hideout',
      lastHospitalId: factionSpec.homeHospitalId,
      deathsCount: 0,
      exfilsCount: 0,
    };

    this.state = {
      activeSlotId: input.activate === false ? this.state.activeSlotId : slotId,
      slots: {
        ...this.state.slots,
        [slotId]: character,
      },
    };
    this.persistAndEmit();
    return { ok: true, character: cloneCharacter(character) };
  }

  public setActiveSlot(slotId: CharacterSlotId | null): boolean {
    if (slotId === null) {
      if (this.state.activeSlotId === null) return true;
      this.state = { ...this.state, activeSlotId: null };
      this.persistAndEmit();
      return true;
    }
    if (!this.state.slots[slotId]) return false;
    if (this.state.activeSlotId === slotId) return true;
    this.state = { ...this.state, activeSlotId: slotId };
    this.persistAndEmit();
    return true;
  }

  public deleteCharacter(slotId: CharacterSlotId): OpenWorldCharacter | null {
    const removed = this.state.slots[slotId];
    if (!removed) return null;

    const nextSlots: Record<CharacterSlotId, OpenWorldCharacter | null> = {
      ...this.state.slots,
      [slotId]: null,
    };

    let nextActive = this.state.activeSlotId;
    if (nextActive === slotId) {
      nextActive = CHARACTER_SLOT_IDS.find((id) => nextSlots[id] !== null) ?? null;
    }

    this.state = {
      activeSlotId: nextActive,
      slots: nextSlots,
    };
    this.persistAndEmit();
    return cloneCharacter(removed);
  }

  private mutateCharacter(
    slotId: CharacterSlotId,
    mutator: (char: OpenWorldCharacter) => void,
  ): OpenWorldCharacter | null {
    const existing = this.state.slots[slotId];
    if (!existing) return null;
    const next = cloneCharacter(existing);
    mutator(next);
    this.state = {
      ...this.state,
      slots: {
        ...this.state.slots,
        [slotId]: next,
      },
    };
    this.persistAndEmit();
    return cloneCharacter(next);
  }

  public adjustCash(slotId: CharacterSlotId, deltaUsd: number): OpenWorldCharacter | null {
    return this.mutateCharacter(slotId, (c) => {
      c.cash = Math.max(0, Math.round(c.cash + deltaUsd));
    });
  }

  public setCash(slotId: CharacterSlotId, amountUsd: number): OpenWorldCharacter | null {
    return this.mutateCharacter(slotId, (c) => {
      c.cash = Math.max(0, Math.round(amountUsd));
    });
  }

  public purchaseWeaponToArsenal(
    slotId: CharacterSlotId,
    weaponId: string,
    priceUsd: number,
  ): PurchaseWeaponResult {
    const current = this.state.slots[slotId];
    if (!current) return { ok: false, error: 'Character slot not found.' };
    const canonical = normalizeLoadoutWeaponId(weaponId, '');
    if (!canonical) return { ok: false, error: 'Unknown firearm ID.' };
    if (current.arsenal.ownedWeaponIds.includes(canonical)) {
      return { ok: false, error: 'Firearm already owned in this character\'s Arsenal.' };
    }
    const cleanPrice = Math.max(0, Math.round(priceUsd));
    if (current.cash < cleanPrice) {
      return { ok: false, error: 'Insufficient cash for this purchase.' };
    }

    const updated = this.mutateCharacter(slotId, (c) => {
      c.cash = Math.max(0, c.cash - cleanPrice);
      c.arsenal.ownedWeaponIds = [...c.arsenal.ownedWeaponIds, canonical];
      c.arsenal.wallRackSlots = reconcileRackSlots(
        c.arsenal.ownedWeaponIds,
        c.arsenal.wallRackSlots,
        c.arsenal.equippedWeaponId,
      );
      if (c.arsenal.equippedWeaponId === 'unarmed') {
        c.arsenal.equippedWeaponId = canonical;
        c.arsenal.wallRackSlots = reconcileRackSlots(
          c.arsenal.ownedWeaponIds,
          c.arsenal.wallRackSlots,
          canonical,
        );
      }
    });
    return { ok: true, remainingCash: updated?.cash ?? 0 };
  }

  public commitArsenalRackSwap(
    slotId: CharacterSlotId,
    slotIndex: number,
  ): { previousEquipped: string; nextEquipped: string } {
    const current = this.state.slots[slotId];
    if (!current) return { previousEquipped: 'unarmed', nextEquipped: 'unarmed' };

    const previousEquipped = current.arsenal.equippedWeaponId;
    const slotWeapon = current.arsenal.wallRackSlots[slotIndex] ?? null;
    if (previousEquipped === 'unarmed' && !slotWeapon) {
      return { previousEquipped, nextEquipped: 'unarmed' };
    }

    let nextEquipped = 'unarmed';
    this.mutateCharacter(slotId, (c) => {
      const slots = [...c.arsenal.wallRackSlots];
      if (previousEquipped !== 'unarmed' && slotWeapon) {
        slots[slotIndex] = previousEquipped;
        nextEquipped = slotWeapon;
      } else if (previousEquipped === 'unarmed' && slotWeapon) {
        slots[slotIndex] = null;
        nextEquipped = slotWeapon;
      } else if (previousEquipped !== 'unarmed' && !slotWeapon) {
        slots[slotIndex] = previousEquipped;
        nextEquipped = 'unarmed';
      }
      c.arsenal.wallRackSlots = slots;
      c.arsenal.equippedWeaponId = nextEquipped;
      if (nextEquipped !== 'unarmed') {
        const prof = resolveWeaponProfile(nextEquipped);
        if (prof.category === 'pistols' || prof.category === 'revolvers') {
          c.equippedKit.secondaryWeaponId = prof.id;
        } else {
          c.equippedKit.primaryWeaponId = prof.id;
        }
      }
    });

    return { previousEquipped, nextEquipped };
  }

  public setArsenalEquippedWeapon(slotId: CharacterSlotId, weaponId: string): void {
    const current = this.state.slots[slotId];
    if (!current) return;
    const normalized =
      weaponId === 'unarmed' ? 'unarmed' : normalizeLoadoutWeaponId(weaponId, '');
    if (!normalized) return;
    if (normalized !== 'unarmed' && !current.arsenal.ownedWeaponIds.includes(normalized)) {
      return;
    }
    if (normalized === current.arsenal.equippedWeaponId) return;

    this.mutateCharacter(slotId, (c) => {
      const slots = [...c.arsenal.wallRackSlots];
      const prev = c.arsenal.equippedWeaponId;
      const targetIdx = normalized !== 'unarmed' ? slots.indexOf(normalized) : -1;
      if (targetIdx >= 0) {
        slots[targetIdx] = prev !== 'unarmed' ? prev : null;
      } else if (prev !== 'unarmed' && !slots.includes(prev)) {
        const emptyIdx = slots.indexOf(null);
        if (emptyIdx >= 0) slots[emptyIdx] = prev;
        else if (slots.length < MAX_ARSENAL_WALL_SLOTS) slots.push(prev);
      }
      c.arsenal.wallRackSlots = reconcileRackSlots(c.arsenal.ownedWeaponIds, slots, normalized);
      c.arsenal.equippedWeaponId = normalized;
    });
  }

  public getArsenalReserveForWeapon(slotId: CharacterSlotId, weaponId: string): number {
    const c = this.state.slots[slotId];
    if (!c || weaponId === 'unarmed') return 0;
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    return c.arsenal.ammoReserve[calId] ?? getDefaultReserveForCaliber(calId);
  }

  public consumeArsenalReserve(
    slotId: CharacterSlotId,
    weaponId: string,
    rounds: number,
  ): number {
    const c = this.state.slots[slotId];
    if (!c || weaponId === 'unarmed' || rounds <= 0) return 0;
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    const avail = c.arsenal.ammoReserve[calId] ?? getDefaultReserveForCaliber(calId);
    const taken = Math.min(avail, rounds);
    this.mutateCharacter(slotId, (ch) => {
      ch.arsenal.ammoReserve[calId] = Math.max(0, avail - taken);
    });
    return taken;
  }

  public resupplyArsenalAmmo(slotId: CharacterSlotId): void {
    this.mutateCharacter(slotId, (c) => {
      const next: Record<string, number> = { ...DEFAULT_AMMO_RESERVE };
      for (const calId of Object.keys(c.arsenal.ammoReserve)) {
        next[calId] = Math.max(
          getDefaultReserveForCaliber(calId),
          c.arsenal.ammoReserve[calId] ?? 0,
        );
      }
      c.arsenal.ammoReserve = next;
    });
  }

  public setArsenalAmmoVariant(
    slotId: CharacterSlotId,
    weaponId: string,
    variantId: string,
  ): void {
    if (!weaponId || weaponId === 'unarmed') return;
    this.mutateCharacter(slotId, (c) => {
      c.arsenal.ammoVariantByWeapon[weaponId] = variantId;
    });
  }

  public setArsenalZeroDistance(
    slotId: CharacterSlotId,
    weaponId: string,
    zeroDistanceM: number,
  ): void {
    if (!weaponId || weaponId === 'unarmed') return;
    const clamped = Math.max(25, Math.min(300, Math.round(zeroDistanceM)));
    this.mutateCharacter(slotId, (c) => {
      c.arsenal.zeroDistanceByWeapon[weaponId] = clamped;
    });
  }

  public updateSubFactionStanding(
    slotId: CharacterSlotId,
    subFactionId: SubFactionId,
    delta: number,
  ): OpenWorldCharacter | null {
    return this.mutateCharacter(slotId, (c) => {
      const next = Math.max(
        STANDING_MIN,
        Math.min(STANDING_MAX, Math.round((c.subFactionStanding[subFactionId] ?? 0) + delta)),
      );
      c.subFactionStanding[subFactionId] = next;
    });
  }

  public advanceProgressionTier(
    slotId: CharacterSlotId,
    deltaTiers = 1,
    completedContractsDelta = 2,
  ): OpenWorldCharacter | null {
    return this.mutateCharacter(slotId, (c) => {
      c.missions.progressionTier = Math.max(
        1,
        Math.min(6, c.missions.progressionTier + deltaTiers),
      );
      c.missions.completedContracts = Math.max(
        0,
        c.missions.completedContracts + completedContractsDelta,
      );
    });
  }

  public moveStashItemToSecureContainer(
    slotId: CharacterSlotId,
    instanceId: string,
  ): { ok: boolean; error?: string } {
    const c = this.state.slots[slotId];
    if (!c) return { ok: false, error: 'Character not found.' };
    const idx = c.stashItems.findIndex((it) => it.instanceId === instanceId);
    if (idx < 0) return { ok: false, error: 'Item not found in stash.' };
    const item = c.stashItems[idx];
    const usedSlots = c.secureContainerItems.reduce((acc, it) => acc + Math.max(1, it.slots), 0);
    const cap = getSecureContainerCapacity(c.secureContainerTier);
    if (usedSlots + Math.max(1, item.slots) > cap) {
      return { ok: false, error: `Secure Container (${c.secureContainerTier}) is full.` };
    }
    this.mutateCharacter(slotId, (ch) => {
      const i = ch.stashItems.findIndex((it) => it.instanceId === instanceId);
      if (i >= 0) {
        const [moved] = ch.stashItems.splice(i, 1);
        ch.secureContainerItems.push(moved);
      }
    });
    return { ok: true };
  }

  public moveSecureItemToStash(
    slotId: CharacterSlotId,
    instanceId: string,
  ): { ok: boolean; error?: string } {
    const c = this.state.slots[slotId];
    if (!c) return { ok: false, error: 'Character not found.' };
    const idx = c.secureContainerItems.findIndex((it) => it.instanceId === instanceId);
    if (idx < 0) return { ok: false, error: 'Item not found in Secure Container.' };
    this.mutateCharacter(slotId, (ch) => {
      const i = ch.secureContainerItems.findIndex((it) => it.instanceId === instanceId);
      if (i >= 0) {
        const [moved] = ch.secureContainerItems.splice(i, 1);
        ch.stashItems.push(moved);
      }
    });
    return { ok: true };
  }

  public updateCharacterGear(
    slotId: CharacterSlotId,
    patch: Partial<OperatorGearConfig>,
  ): OpenWorldCharacter | null {
    return this.mutateCharacter(slotId, (c) => {
      c.operatorGear = normalizeOperatorGearConfig({
        ...c.operatorGear,
        ...patch,
      });
    });
  }

  /**
   * Called exclusively by PermadeathService when a solvent character pays their Field Hospital fee
   * and respawns after a full-drop death. Drops deployed/equipped weapons & field kit while keeping
   * Secure Container items and un-deployed Hideout Arsenal / Stash assets intact.
   */
  public applyFieldHospitalRespawn(
    slotId: CharacterSlotId,
    feePaidUsd: number,
    hospitalId: string,
    droppedWeaponIds: readonly string[],
  ): OpenWorldCharacter | null {
    const droppedSet = new Set(droppedWeaponIds);
    return this.mutateCharacter(slotId, (c) => {
      c.cash = Math.max(0, c.cash - Math.max(0, Math.round(feePaidUsd)));
      c.deathsCount += 1;
      c.deploymentState = 'hideout';
      c.lastHospitalId = hospitalId;

      // Remove dropped field weapons from this character's owned Arsenal Wall
      const remainingOwned = c.arsenal.ownedWeaponIds.filter((id) => !droppedSet.has(id));
      const nextEquipped =
        c.arsenal.equippedWeaponId !== 'unarmed' && !droppedSet.has(c.arsenal.equippedWeaponId)
          ? c.arsenal.equippedWeaponId
          : (remainingOwned[0] ?? 'unarmed');

      c.arsenal.ownedWeaponIds = remainingOwned;
      c.arsenal.equippedWeaponId = nextEquipped;
      c.arsenal.wallRackSlots = reconcileRackSlots(
        remainingOwned,
        c.arsenal.wallRackSlots,
        nextEquipped,
      );

      // Clear full-drop field kit (Secure Container items remain 100% untouched!)
      c.equippedKit = {
        primaryWeaponId: nextEquipped !== 'unarmed' ? nextEquipped : null,
        secondaryWeaponId: null,
        armorName: null,
        rigName: null,
        backpackItems: [],
      };
    });
  }

  public subscribe(fn: RosterListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const characterRoster = new CharacterRoster();

export function useCharacterRoster(roster: CharacterRoster = characterRoster): CharacterRosterState {
  const [state, setState] = useState<CharacterRosterState>(() => roster.getState());
  useEffect(() => {
    setState(roster.getState());
    return roster.subscribe((next) => setState(next));
  }, [roster]);
  return state;
}

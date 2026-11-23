import type { WeaponAttachments } from '../../../data/attachments';
import type { OperatorGearConfig, OperatorId } from '../../../bodycam-sdk/operator/OperatorTypes';

export type CharacterSlotId = 'slot_0' | 'slot_1' | 'slot_2';

export const CHARACTER_SLOT_IDS: readonly CharacterSlotId[] = [
  'slot_0',
  'slot_1',
  'slot_2',
] as const;

export type ShardMode = 'PvPvE' | 'PvE';

export type PmcFactionId = 'pmc_alpha' | 'pmc_bravo';

export type CharacterBodyType = 'male' | 'female';

export type SubFactionId =
  | 'dockworkers_syndicate'
  | 'highland_militia'
  | 'alpine_remnant';

export type StandingTier = 'Hostile' | 'Neutral' | 'Trusted';

export type SecureContainerTier = '2x2' | '3x3';

export type InventoryItemCategory =
  | 'key'
  | 'cash_bundle'
  | 'intel'
  | 'medical'
  | 'ammo'
  | 'gear'
  | 'barter';

export type DiscreteTransitionType =
  | 'character_created'
  | 'character_deleted'
  | 'character_switched'
  | 'exfil'
  | 'death'
  | 'field_hospital_respawn'
  | 'permadeath_wipe'
  | 'trader_purchase'
  | 'sector_flip'
  | 'stash_update'
  | 'arsenal_update'
  | 'reputation_update';

export interface OpenWorldStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface ShardRulesSpec {
  readonly mode: ShardMode;
  readonly label: string;
  readonly pmcRelationsLabel: string;
  readonly pmcHostile: boolean;
  readonly friendlyFireRivalPmc: boolean;
  readonly friendlyFireLabel: string;
  readonly corpseLootingPlayers: boolean;
  readonly corpseLootingLabel: string;
  readonly worldStateLabel: string;
}

export const SHARD_RULES: Readonly<Record<ShardMode, ShardRulesSpec>> = {
  PvPvE: {
    mode: 'PvPvE',
    label: 'PvPvE Contested Shard',
    pmcRelationsLabel: 'PMC Alpha & PMC Bravo Hostile',
    pmcHostile: true,
    friendlyFireRivalPmc: true,
    friendlyFireLabel: 'Enabled vs rival PMC (squad rules apply)',
    corpseLootingPlayers: true,
    corpseLootingLabel: 'Full looting of any player or AI corpse',
    worldStateLabel: 'Shared persistent PvPvE territory & supply pools',
  },
  PvE: {
    mode: 'PvE',
    label: 'PvE Cooperative Shard',
    pmcRelationsLabel: 'PMC Alpha & PMC Bravo Allied (Ceasefire)',
    pmcHostile: false,
    friendlyFireRivalPmc: false,
    friendlyFireLabel: 'Disabled between all PMC players',
    corpseLootingPlayers: false,
    corpseLootingLabel: 'Players cannot loot other players\' corpses',
    worldStateLabel: 'Isolated persistent PvE territory & supply pools',
  },
} as const;

export interface PmcFactionSpec {
  readonly id: PmcFactionId;
  readonly name: string;
  readonly shortName: string;
  readonly uniformId: OperatorGearConfig['uniformId'];
  readonly armbandColorHex: string;
  readonly homeHospitalId: string;
  readonly homeHospitalName: string;
  readonly doctrine: string;
  readonly starterWeaponIds: readonly string[];
  readonly starterEquippedWeaponId: string;
  readonly starterArmorName: string;
  readonly starterRigName: string;
}

export const PMC_FACTIONS: Readonly<Record<PmcFactionId, PmcFactionSpec>> = {
  pmc_alpha: {
    id: 'pmc_alpha',
    name: 'PMC Alpha',
    shortName: 'ALPHA',
    uniformId: 'team_a',
    armbandColorHex: '#38bdf8',
    homeHospitalId: 'fob_alpha_medbay',
    homeHospitalName: 'Alpha Forward Surgical Bay',
    doctrine: 'NATO modular carbines, coastal-to-steppe rapid intervention.',
    starterWeaponIds: ['m4a1', 'hk_mp5', 'glock_17'],
    starterEquippedWeaponId: 'm4a1',
    starterArmorName: 'JPC-2 Plate Carrier (NIJ III)',
    starterRigName: 'Mk4 Micro Chest Rig',
  },
  pmc_bravo: {
    id: 'pmc_bravo',
    name: 'PMC Bravo',
    shortName: 'BRAVO',
    uniformId: 'team_b',
    armbandColorHex: '#f59e0b',
    homeHospitalId: 'fob_bravo_clinic',
    homeHospitalName: 'Bravo Field Trauma Clinic',
    doctrine: 'Heavy Eastern-bloc rifles, breacher shotguns, alpine endurance.',
    starterWeaponIds: ['akm_762', 'aks74u', 'remington_870', 'makarov_pm'],
    starterEquippedWeaponId: 'akm_762',
    starterArmorName: '6B45 Ratnik Vest (GOST 4)',
    starterRigName: 'Smersh AK Harness',
  },
} as const;

export interface SubFactionSpec {
  readonly id: SubFactionId;
  readonly name: string;
  readonly shortName: string;
  readonly biomeLabel: string;
  readonly hospitalId: string;
  readonly hospitalName: string;
  readonly rivalId: SubFactionId;
  readonly summary: string;
}

export const SUB_FACTION_LIST: readonly SubFactionSpec[] = [
  {
    id: 'dockworkers_syndicate',
    name: 'Port Dockworkers Syndicate',
    shortName: 'Syndicate',
    biomeLabel: 'Coastal Port & Marsh Delta',
    hospitalId: 'hosp_syndicate_drydock',
    hospitalName: 'Delta Drydock Aid Station',
    rivalId: 'highland_militia',
    summary: 'Controls container terminals, patrol barges, and maritime black-market imports.',
  },
  {
    id: 'highland_militia',
    name: 'Highland Militia',
    shortName: 'Militia',
    biomeLabel: 'Temperate Valley & Steppe Quarry',
    hospitalId: 'hosp_militia_quarry',
    hospitalName: 'Quarry Ridge Field Triage',
    rivalId: 'alpine_remnant',
    summary: 'Holds logging arteries, freight yards, and armored quarry checkpoints.',
  },
  {
    id: 'alpine_remnant',
    name: 'Alpine Remnant',
    shortName: 'Remnant',
    biomeLabel: 'Alpine Ridge & Dam Reservoir',
    hospitalId: 'hosp_remnant_dam',
    hospitalName: 'Dam Summit Med-Bunker',
    rivalId: 'dockworkers_syndicate',
    summary: 'Guards fortified hydroelectric bunkers, radar arrays, and high-tier vaults.',
  },
] as const;

export const SUB_FACTION_MAP: Readonly<Record<SubFactionId, SubFactionSpec>> = Object.fromEntries(
  SUB_FACTION_LIST.map((f) => [f.id, f]),
) as Record<SubFactionId, SubFactionSpec>;

export const STANDING_MIN = -100;
export const STANDING_MAX = 100;
export const STANDING_HOSTILE_MAX = -26;
export const STANDING_TRUSTED_MIN = 50;

export function getStandingTier(standing: number): StandingTier {
  if (standing <= STANDING_HOSTILE_MAX) return 'Hostile';
  if (standing >= STANDING_TRUSTED_MIN) return 'Trusted';
  return 'Neutral';
}

export function bodyTypeToOperatorId(bodyType: CharacterBodyType): OperatorId {
  return bodyType === 'female' ? 'FEMALE' : 'MALE';
}

export function getSecureContainerCapacity(tier: SecureContainerTier): number {
  return tier === '3x3' ? 9 : 4;
}

export interface InventoryItemRecord {
  instanceId: string;
  itemId: string;
  name: string;
  category: InventoryItemCategory;
  quantity: number;
  valueUsd: number;
  slots: number;
}

export interface EquippedFieldKit {
  primaryWeaponId: string | null;
  secondaryWeaponId: string | null;
  armorName: string | null;
  rigName: string | null;
  backpackItems: InventoryItemRecord[];
}

export interface CharacterArsenalState {
  ownedWeaponIds: string[];
  wallRackSlots: Array<string | null>;
  equippedWeaponId: string;
  ammoReserve: Record<string, number>;
  ammoVariantByWeapon: Record<string, string>;
  zeroDistanceByWeapon: Record<string, number>;
  weaponAttachments: Record<string, WeaponAttachments>;
}

export interface CharacterMissionState {
  progressionTier: number;
  completedContracts: number;
  activeContractIds: string[];
}

export interface OwnedVehicleKeyRecord {
  vehicleId: string;
  modelLabel: string;
  keyCode: string;
  locked: boolean;
  worldX: number;
  worldZ: number;
}

export interface OpenWorldCharacter {
  readonly slotId: CharacterSlotId;
  readonly characterId: string;
  readonly callsign: string;
  readonly shardMode: ShardMode;
  readonly pmcFaction: PmcFactionId;
  readonly bodyType: CharacterBodyType;
  readonly createdAtIso: string;
  cash: number;
  stashItems: InventoryItemRecord[];
  secureContainerTier: SecureContainerTier;
  secureContainerItems: InventoryItemRecord[];
  arsenal: CharacterArsenalState;
  equippedKit: EquippedFieldKit;
  missions: CharacterMissionState;
  ownedVehicleKeys: OwnedVehicleKeyRecord[];
  subFactionStanding: Record<SubFactionId, number>;
  operatorGear: OperatorGearConfig;
  deploymentState: 'hideout' | 'deployed';
  lastHospitalId: string;
  deathsCount: number;
  exfilsCount: number;
}

export interface CreateCharacterInput {
  slotId: CharacterSlotId;
  callsign: string;
  shardMode: ShardMode;
  pmcFaction: PmcFactionId;
  bodyType: CharacterBodyType;
  activate?: boolean;
}

export interface FactionSupplyPool {
  ammo: number;
  medical: number;
  fuelParts: number;
  intel: number;
}

export interface DroppedCorpseEntity {
  corpseId: string;
  ownerCharacterId: string;
  ownerCallsign: string;
  ownerFaction: PmcFactionId;
  shardMode: ShardMode;
  worldX: number;
  worldZ: number;
  sectorLabel: string;
  causeOfDeath: string;
  droppedWeaponIds: string[];
  droppedArmorName: string | null;
  droppedRigName: string | null;
  droppedItems: InventoryItemRecord[];
  lootableByOtherPlayers: boolean;
  createdAtIso: string;
}

export interface ShardTransitionLogEntry {
  revision: number;
  type: DiscreteTransitionType;
  timestampIso: string;
  summary: string;
}

export interface ShardWorldState {
  mode: ShardMode;
  revision: number;
  pmcSupplyPools: Record<PmcFactionId, FactionSupplyPool>;
  territoryCounts: {
    pmc_alpha: number;
    pmc_bravo: number;
    neutral: number;
  };
  corpses: DroppedCorpseEntity[];
  recentTransitions: ShardTransitionLogEntry[];
}

export interface OpenWorldQuartermasterOffer {
  readonly weaponId: string;
  readonly priceUsd: number;
  readonly factionAffinity?: PmcFactionId;
  readonly subFactionRequired?: SubFactionId;
  readonly minStanding?: number;
}

export const QUARTERMASTER_FIREARM_OFFERS: readonly OpenWorldQuartermasterOffer[] = [
  { weaponId: 'm4a1', priceUsd: 3200, factionAffinity: 'pmc_alpha' },
  { weaponId: 'hk_mp5', priceUsd: 2400, factionAffinity: 'pmc_alpha' },
  { weaponId: 'hk416', priceUsd: 4600, factionAffinity: 'pmc_alpha' },
  { weaponId: 'sig_mcx', priceUsd: 4800, factionAffinity: 'pmc_alpha' },
  { weaponId: 'akm_762', priceUsd: 2900, factionAffinity: 'pmc_bravo' },
  { weaponId: 'aks74u', priceUsd: 2200, factionAffinity: 'pmc_bravo' },
  { weaponId: 'ak105', priceUsd: 3600, factionAffinity: 'pmc_bravo' },
  { weaponId: 'remington_870', priceUsd: 1850 },
  { weaponId: 'benelli_m4', priceUsd: 3900 },
  { weaponId: 'mosin_m91_30', priceUsd: 2100 },
  { weaponId: 'dragunov_svd', priceUsd: 5400, subFactionRequired: 'highland_militia', minStanding: 25 },
  { weaponId: 'mk14_ebr', priceUsd: 6200, subFactionRequired: 'alpine_remnant', minStanding: 50 },
  { weaponId: 'glock_17', priceUsd: 950 },
  { weaponId: 'makarov_pm', priceUsd: 650 },
  { weaponId: 'beretta_m9', priceUsd: 1100 },
] as const;

export function resolveDefaultStorage(): OpenWorldStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

import type { WeaponAttachments } from '../../../data/attachments';
import type { OperatorGearConfig, OperatorId } from '../../../bodycam-sdk/operator/OperatorTypes';
import type {
  CorpseTacticalLootSnapshot,
  OperatorTacticalInventory,
} from './inventory/TetrisInventoryTypes';

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

export type TraderId =
  | 'quartermaster_pmc'
  | 'syndicate_broker'
  | 'militia_armorer'
  | 'alpine_specialist';

export type StandingTier = 'Hostile' | 'Neutral' | 'Trusted';

export type SecureContainerTier = '2x2' | '3x3';

export type InventoryItemCategory =
  | 'key'
  | 'cash_bundle'
  | 'intel'
  | 'medical'
  | 'ammo'
  | 'gear'
  | 'armor_plate'
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
  | 'trader_level_up'
  | 'contract_completed'
  | 'sector_flip'
  | 'stash_update'
  | 'arsenal_update'
  | 'reputation_update'
  | 'fob_upgrade'
  | 'convoy_escort'
  | 'convoy_hijack'
  | 'convoy_sabotage'
  | 'world_event_resolved'
  | 'inventory_sync';

export type FobTier = 1 | 2 | 3;

export type SectorAlertState = 'calm' | 'alerted' | 'contested' | 'captured';

export type SupplyStockTier = 'high' | 'strained' | 'starved';

export type SupplyResourceKey = keyof FactionSupplyPool;

export type ContractArchetype = 'recon' | 'hvt' | 'sabotage' | 'supply';

export type DynamicWorldEventKind =
  | 'black_box_drop'
  | 'smuggler_boat'
  | 'convoy_ambush'
  | 'sector_counter_assault';

export interface FobUpgradeSpec {
  readonly tier: FobTier;
  readonly name: string;
  readonly cashCostUsd: number;
  readonly minAvgSupplyPct: number;
  readonly unlocksSummary: string;
  readonly physicalUpgrades: readonly string[];
  readonly upgradesSecureContainerTo3x3?: boolean;
}

export const FOB_UPGRADE_SPECS: Readonly<Record<FobTier, FobUpgradeSpec>> = {
  1: {
    tier: 1,
    name: 'Tier 1 — Forward Staging Outpost',
    cashCostUsd: 0,
    minAvgSupplyPct: 0,
    unlocksSummary: 'Basic Medbay, Quartermaster Terminal, Starter Rigs & 2x2 Secure Container.',
    physicalUpgrades: ['Command Console', 'Field Medbay Cot'],
  },
  2: {
    tier: 2,
    name: 'Tier 2 — Fortified Logistics Hub',
    cashCostUsd: 12000,
    minAvgSupplyPct: 40,
    unlocksSummary: 'Unlocks Smersh Rigs, 35L Rucksacks, AP Ammo Boxes, Surgical Bay & Optics Workbench.',
    physicalUpgrades: ['Optics & Munitions Workbench', 'Reinforced Surgical Bay Shelter'],
  },
  3: {
    tier: 3,
    name: 'Tier 3 — Hardened Perimeter Stronghold',
    cashCostUsd: 28000,
    minAvgSupplyPct: 65,
    unlocksSummary: 'Unlocks AVS Heavy Rigs, 55L Logistics Packs, Tungsten AP Rounds, Turret Towers & 3x3 Secure Container.',
    physicalUpgrades: ['Reinforced Helipad Deck', 'Twin Perimeter Watch Turrets', 'Armor Repair Bay'],
    upgradesSecureContainerTo3x3: true,
  },
} as const;

export interface RotatingContractRecord {
  readonly instanceId: string;
  readonly templateId: string;
  readonly slotIndex: 0 | 1 | 2;
  readonly title: string;
  readonly archetype: ContractArchetype;
  readonly subFactionId: SubFactionId;
  readonly targetSectorId: string;
  readonly targetSectorLabel: string;
  readonly summary: string;
  readonly cashRewardUsd: number;
  readonly standingGain: number;
  readonly rivalPenalty: number;
  readonly supplyBonus: Readonly<Partial<FactionSupplyPool>>;
  accepted: boolean;
  progress: number;
  targetCount: number;
  completed: boolean;
}

export interface RotatingContractTemplate {
  readonly templateId: string;
  readonly title: string;
  readonly archetype: ContractArchetype;
  readonly subFactionId: SubFactionId;
  readonly targetSectorId: string;
  readonly targetSectorLabel: string;
  readonly summary: string;
  readonly cashRewardUsd: number;
  readonly standingGain: number;
  readonly rivalPenalty: number;
  readonly targetCount: number;
  readonly supplyBonus: Readonly<Partial<FactionSupplyPool>>;
}

export const ROTATING_CONTRACT_TEMPLATES: readonly RotatingContractTemplate[] = [
  {
    templateId: 'rc_syndicate_recon_marsh',
    title: 'Marsh Comms Sweep',
    archetype: 'recon',
    subFactionId: 'dockworkers_syndicate',
    targetSectorId: 'comms_south_marsh',
    targetSectorLabel: 'South Marsh Relay',
    summary: 'Inspect the South Marsh Relay perimeter and clear hostile spotters.',
    cashRewardUsd: 2600,
    standingGain: 14,
    rivalPenalty: -7,
    targetCount: 1,
    supplyBonus: { intel: 8, fuelParts: 6 },
  },
  {
    templateId: 'rc_syndicate_supply_port',
    title: 'Drydock Fuel Manifest',
    archetype: 'supply',
    subFactionId: 'dockworkers_syndicate',
    targetSectorId: 'landmark_port_terminal',
    targetSectorLabel: 'Coastal Port',
    summary: 'Secure Coastal Port fuel reserves or intercept a hostile supply barge.',
    cashRewardUsd: 3100,
    standingGain: 16,
    rivalPenalty: -8,
    targetCount: 1,
    supplyBonus: { fuelParts: 12, ammo: 5 },
  },
  {
    templateId: 'rc_militia_hvt_valley',
    title: 'Valley Munitions HVT',
    archetype: 'hvt',
    subFactionId: 'highland_militia',
    targetSectorId: 'depot_valley_munitions',
    targetSectorLabel: 'Valley Munitions',
    summary: 'Eliminate hostile guards defending the Valley Munitions Depot.',
    cashRewardUsd: 3400,
    standingGain: 16,
    rivalPenalty: -8,
    targetCount: 2,
    supplyBonus: { ammo: 12 },
  },
  {
    templateId: 'rc_militia_sabotage_pine',
    title: 'Pine Ridge Jammer Sabotage',
    archetype: 'sabotage',
    subFactionId: 'highland_militia',
    targetSectorId: 'comms_pine_ridge',
    targetSectorLabel: 'Pine Ridge Comms',
    summary: 'Disrupt enemy signals at Pine Ridge Comms Tower or sabotage a hostile convoy.',
    cashRewardUsd: 3800,
    standingGain: 18,
    rivalPenalty: -9,
    targetCount: 1,
    supplyBonus: { intel: 10, ammo: 6 },
  },
  {
    templateId: 'rc_remnant_recon_alpine',
    title: 'Alpine Signals Verification',
    archetype: 'recon',
    subFactionId: 'alpine_remnant',
    targetSectorId: 'depot_alpine_signals',
    targetSectorLabel: 'Alpine Signals',
    summary: 'Verify encrypted telemetry arrays at the Alpine Signals Archive.',
    cashRewardUsd: 4200,
    standingGain: 18,
    rivalPenalty: -9,
    targetCount: 1,
    supplyBonus: { intel: 14 },
  },
  {
    templateId: 'rc_remnant_hvt_steppe',
    title: 'Steppe Medbay Purge',
    archetype: 'hvt',
    subFactionId: 'alpine_remnant',
    targetSectorId: 'depot_steppe_medbay',
    targetSectorLabel: 'Steppe Med Depot',
    summary: 'Neutralize hostile raiders around the Steppe Field Hospital Depot.',
    cashRewardUsd: 4500,
    standingGain: 20,
    rivalPenalty: -10,
    targetCount: 2,
    supplyBonus: { medical: 14, intel: 6 },
  },
] as const;

export type OpenWorldBiomeId =
  | 'coastal_port_marsh'
  | 'temperate_conifer_valley'
  | 'highland_steppe_quarry'
  | 'alpine_ridge_dam';

export type OpenWorldWeatherId = 'clear' | 'coastal_fog' | 'mountain_rain';

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
  readonly starterUnlockedWeaponIds: readonly string[];
  readonly starterUnlockedAttachmentIds: readonly string[];
  readonly starterUnlockedArmorPlateIds: readonly string[];
  readonly starterEquippedWeaponId: string;
  readonly starterArmorPlateId: string;
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
    starterUnlockedWeaponIds: ['m4a1', 'hk_mp5', 'remington_870', 'mosin_m91_30', 'glock_17', 'beretta_m9'],
    starterUnlockedAttachmentIds: ['rail_mp5_claw', 'optic_t2_red_dot', 'tac_flashlight', 'grip_angled_afg'],
    starterUnlockedArmorPlateIds: ['plate_nij3_steel'],
    starterEquippedWeaponId: 'm4a1',
    starterArmorPlateId: 'plate_nij3_steel',
    starterArmorName: 'JPC-2 Plate Carrier (NIJ III Steel)',
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
    starterUnlockedWeaponIds: ['akm_762', 'aks74u', 'remington_870', 'mosin_m91_30', 'makarov_pm', 'glock_17'],
    starterUnlockedAttachmentIds: ['rail_b13_dovetail', 'optic_kobra_rd', 'tac_flashlight', 'muzzle_comp_ak'],
    starterUnlockedArmorPlateIds: ['plate_gost4_granit'],
    starterEquippedWeaponId: 'akm_762',
    starterArmorPlateId: 'plate_gost4_granit',
    starterArmorName: '6B45 Ratnik Vest (GOST 4 Granit)',
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
  readonly traderId: TraderId;
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
    traderId: 'syndicate_broker',
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
    traderId: 'militia_armorer',
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
    traderId: 'alpine_specialist',
    summary: 'Guards fortified hydroelectric bunkers, radar arrays, and high-tier vaults.',
  },
] as const;

export const SUB_FACTION_MAP: Readonly<Record<SubFactionId, SubFactionSpec>> = Object.fromEntries(
  SUB_FACTION_LIST.map((f) => [f.id, f]),
) as Record<SubFactionId, SubFactionSpec>;

export interface TraderSpec {
  readonly id: TraderId;
  readonly name: string;
  readonly role: string;
  readonly subFactionId?: SubFactionId;
  readonly maxLevel: number;
  readonly levelUnlocks: Readonly<
    Record<
      number,
      {
        readonly weapons: readonly string[];
        readonly attachments: readonly string[];
        readonly armorPlates: readonly string[];
      }
    >
  >;
}

export const TRADER_LIST: readonly TraderSpec[] = [
  {
    id: 'quartermaster_pmc',
    name: 'PMC Quartermaster',
    role: 'Home FOB Armory & Ballistic Plates',
    maxLevel: 4,
    levelUnlocks: {
      2: {
        weapons: ['hk416', 'ak105'],
        attachments: ['optic_eotech_holo', 'grip_vertical_rk'],
        armorPlates: ['plate_nij3a_ceramic'],
      },
      3: {
        weapons: ['sig_mcx'],
        attachments: ['optic_lpvo_1_6', 'tac_peq_combo', 'mag_m4_60_quad'],
        armorPlates: ['plate_nij4_composite'],
      },
      4: {
        weapons: ['benelli_m4'],
        attachments: ['optic_razor_1_6', 'muzzle_pbs4_545'],
        armorPlates: ['plate_gost5_titanium'],
      },
    },
  },
  {
    id: 'syndicate_broker',
    name: 'Delta Maritime Broker',
    role: 'Coastal Port Smuggled Optics & Suppressors',
    subFactionId: 'dockworkers_syndicate',
    maxLevel: 3,
    levelUnlocks: {
      2: {
        weapons: ['benelli_m4'],
        attachments: ['muzzle_9mm_suppressor', 'optic_rmr_type2'],
        armorPlates: ['plate_nij3a_ceramic'],
      },
      3: {
        weapons: ['sig_mcx'],
        attachments: ['muzzle_salvo_12ga', 'canted_t2_red_dot'],
        armorPlates: ['plate_nij4_composite'],
      },
    },
  },
  {
    id: 'militia_armorer',
    name: 'Quarry Field Armorer',
    role: 'Highland DMRs & Eastern Ballistics',
    subFactionId: 'highland_militia',
    maxLevel: 3,
    levelUnlocks: {
      2: {
        weapons: ['ak105'],
        attachments: ['optic_pso1_4x', 'mag_ak_45_bakelite'],
        armorPlates: ['plate_gost4_granit'],
      },
      3: {
        weapons: ['dragunov_svd'],
        attachments: ['optic_pso1m2', 'muzzle_pbs4_545'],
        armorPlates: ['plate_gost5_titanium'],
      },
    },
  },
  {
    id: 'alpine_specialist',
    name: 'Dam Summit Ordnance',
    role: 'Alpine Long-Range Optics & Heavy Plates',
    subFactionId: 'alpine_remnant',
    maxLevel: 3,
    levelUnlocks: {
      2: {
        weapons: ['mk14_ebr'],
        attachments: ['optic_lpvo_1_6', 'tac_laser_red'],
        armorPlates: ['plate_nij4_composite'],
      },
      3: {
        weapons: ['mk14_ebr'],
        attachments: ['optic_nightforce_atacr', 'muzzle_338_suppressor'],
        armorPlates: ['plate_gost5_titanium'],
      },
    },
  },
] as const;

export const TRADER_MAP: Readonly<Record<TraderId, TraderSpec>> = Object.fromEntries(
  TRADER_LIST.map((t) => [t.id, t]),
) as Record<TraderId, TraderSpec>;

export interface ArmorPlateCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly ratingLabel: string;
  readonly weightKg: number;
  readonly priceUsd: number;
  readonly durability: number;
  readonly traderId: TraderId;
  readonly requiredTraderLevel: number;
}

export const ARMOR_PLATE_CATALOG: readonly ArmorPlateCatalogEntry[] = [
  {
    id: 'plate_nij3_steel',
    name: 'NIJ III AR500 Steel Plate',
    ratingLabel: 'NIJ III',
    weightKg: 3.4,
    priceUsd: 1100,
    durability: 60,
    traderId: 'quartermaster_pmc',
    requiredTraderLevel: 1,
  },
  {
    id: 'plate_gost4_granit',
    name: 'GOST 4 Granit Ceramic Plate',
    ratingLabel: 'GOST 4',
    weightKg: 2.9,
    priceUsd: 1650,
    durability: 72,
    traderId: 'militia_armorer',
    requiredTraderLevel: 1,
  },
  {
    id: 'plate_nij3a_ceramic',
    name: 'NIJ III+ UHMWPE Ceramic Plate',
    ratingLabel: 'NIJ III+',
    weightKg: 2.1,
    priceUsd: 2400,
    durability: 80,
    traderId: 'quartermaster_pmc',
    requiredTraderLevel: 2,
  },
  {
    id: 'plate_nij4_composite',
    name: 'NIJ IV Boron-Carbide Composite',
    ratingLabel: 'NIJ IV',
    weightKg: 2.7,
    priceUsd: 3800,
    durability: 95,
    traderId: 'alpine_specialist',
    requiredTraderLevel: 2,
  },
  {
    id: 'plate_gost5_titanium',
    name: 'GOST 5A Titanium-Ceramic Heavy Plate',
    ratingLabel: 'GOST 5A',
    weightKg: 3.9,
    priceUsd: 5200,
    durability: 115,
    traderId: 'quartermaster_pmc',
    requiredTraderLevel: 4,
  },
] as const;

export const ARMOR_PLATE_MAP: Readonly<Record<string, ArmorPlateCatalogEntry>> = Object.fromEntries(
  ARMOR_PLATE_CATALOG.map((p) => [p.id, p]),
);

export interface OpenWorldContractSpec {
  readonly id: string;
  readonly title: string;
  readonly traderId: TraderId;
  readonly subFactionId?: SubFactionId;
  readonly biomeId: OpenWorldBiomeId;
  readonly cashRewardUsd: number;
  readonly standingDelta: number;
  readonly grantsTraderLevel?: number;
  readonly unlocksWeaponIds: readonly string[];
  readonly unlocksAttachmentIds: readonly string[];
  readonly unlocksArmorPlateIds: readonly string[];
  readonly summary: string;
}

export const OPENWORLD_CONTRACT_CATALOG: readonly OpenWorldContractSpec[] = [
  {
    id: 'contract_port_manifest',
    title: 'Port Pier Manifest Sweep',
    traderId: 'syndicate_broker',
    subFactionId: 'dockworkers_syndicate',
    biomeId: 'coastal_port_marsh',
    cashRewardUsd: 3200,
    standingDelta: 25,
    grantsTraderLevel: 2,
    unlocksWeaponIds: ['benelli_m4'],
    unlocksAttachmentIds: ['optic_rmr_type2', 'muzzle_9mm_suppressor'],
    unlocksArmorPlateIds: ['plate_nij3a_ceramic'],
    summary: 'Recover shipping manifests from the Delta Container Pier to unlock Syndicate CQB hardware.',
  },
  {
    id: 'contract_valley_convoy',
    title: 'Timberline Rail Yard Recon',
    traderId: 'quartermaster_pmc',
    biomeId: 'temperate_conifer_valley',
    cashRewardUsd: 3800,
    standingDelta: 0,
    grantsTraderLevel: 2,
    unlocksWeaponIds: ['hk416', 'ak105'],
    unlocksAttachmentIds: ['optic_eotech_holo', 'grip_vertical_rk'],
    unlocksArmorPlateIds: ['plate_nij3a_ceramic'],
    summary: 'Tag freight locomotives in the Conifer Valley to authorize Tier-2 Quartermaster carbines and EOTech optics.',
  },
  {
    id: 'contract_quarry_relay',
    title: 'Quarry Radar Telemetry',
    traderId: 'militia_armorer',
    subFactionId: 'highland_militia',
    biomeId: 'highland_steppe_quarry',
    cashRewardUsd: 4600,
    standingDelta: 30,
    grantsTraderLevel: 3,
    unlocksWeaponIds: ['dragunov_svd'],
    unlocksAttachmentIds: ['optic_pso1_4x', 'optic_pso1m2', 'muzzle_pbs4_545'],
    unlocksArmorPlateIds: ['plate_gost5_titanium'],
    summary: 'Deliver radar telemetry chips to the Quarry Field Armorer for SVD DMR and PSO optic purchase clearance.',
  },
  {
    id: 'contract_dam_vault',
    title: 'Hydroelectric Dam Overlook',
    traderId: 'alpine_specialist',
    subFactionId: 'alpine_remnant',
    biomeId: 'alpine_ridge_dam',
    cashRewardUsd: 6400,
    standingDelta: 35,
    grantsTraderLevel: 3,
    unlocksWeaponIds: ['mk14_ebr', 'sig_mcx'],
    unlocksAttachmentIds: ['optic_lpvo_1_6', 'optic_nightforce_atacr', 'tac_peq_combo'],
    unlocksArmorPlateIds: ['plate_nij4_composite'],
    summary: 'Secure Alpine weather station drives to unlock Mk14 EBR, LPVO/ATACR long-range optics, and NIJ IV composite plates.',
  },
] as const;

export const OPENWORLD_CONTRACT_MAP: Readonly<Record<string, OpenWorldContractSpec>> =
  Object.fromEntries(OPENWORLD_CONTRACT_CATALOG.map((c) => [c.id, c]));

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
  armorPlateId: string | null;
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

/**
 * Per-character unlock entitlements (strictly bound to `characterId`, never account-wide).
 * Wiped completely if this character triggers permadeath.
 */
export interface CharacterUnlockEntitlements {
  unlockedWeaponIds: string[];
  unlockedAttachmentIds: string[];
  unlockedArmorPlateIds: string[];
  traderLevels: Record<TraderId, number>;
  completedContractIds: string[];
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
  unlocks: CharacterUnlockEntitlements;
  equippedKit: EquippedFieldKit;
  missions: CharacterMissionState;
  ownedVehicleKeys: OwnedVehicleKeyRecord[];
  subFactionStanding: Record<SubFactionId, number>;
  operatorGear: OperatorGearConfig;
  deploymentState: 'hideout' | 'deployed';
  lastHospitalId: string;
  deathsCount: number;
  exfilsCount: number;
  /** Phase 5 spatial Tetris Grid inventory, Chest Rig/Belt/Backpack gear & mixed LIFO magazines */
  tacticalInventory?: OperatorTacticalInventory;
  /** Phase 5 rotating 3-Slot Sub-Faction Contract Board */
  contractBoard?: RotatingContractRecord[];
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
  /** Full-drop Phase 5 tactical kit (weapons, chest rig, removable backpack w/ nested items, belt) */
  droppedTacticalKit?: CorpseTacticalLootSnapshot;
  lootableByOtherPlayers: boolean;
  createdAtIso: string;
}

export interface ShardTransitionLogEntry {
  revision: number;
  type: DiscreteTransitionType;
  timestampIso: string;
  summary: string;
}

export type SectorControlOwner = PmcFactionId | 'neutral';

export interface SectorControlRecord {
  sectorId: string;
  owner: SectorControlOwner;
  captureProgress: number; // 0..100 for current owner stability
  alertState?: SectorAlertState;
  lastFlippedAtIso?: string;
}

export interface ShardWorldState {
  mode: ShardMode;
  revision: number;
  pmcSupplyPools: Record<PmcFactionId, FactionSupplyPool>;
  fobTiers: Record<PmcFactionId, FobTier>;
  /** Extra restock delay (seconds) applied when rival convoys/barges are sabotaged */
  restockPenaltySec: Record<PmcFactionId, number>;
  territoryCounts: {
    pmc_alpha: number;
    pmc_bravo: number;
    neutral: number;
  };
  sectors: Record<string, SectorControlRecord>;
  corpses: DroppedCorpseEntity[];
  recentTransitions: ShardTransitionLogEntry[];
}

export interface OpenWorldQuartermasterOffer {
  readonly weaponId: string;
  readonly priceUsd: number;
  readonly traderId: TraderId;
  readonly requiredTraderLevel: number;
  readonly factionAffinity?: PmcFactionId;
  readonly subFactionRequired?: SubFactionId;
  readonly minStanding?: number;
}

export const QUARTERMASTER_FIREARM_OFFERS: readonly OpenWorldQuartermasterOffer[] = [
  { weaponId: 'm4a1', priceUsd: 3200, traderId: 'quartermaster_pmc', requiredTraderLevel: 1, factionAffinity: 'pmc_alpha' },
  { weaponId: 'hk_mp5', priceUsd: 2400, traderId: 'quartermaster_pmc', requiredTraderLevel: 1, factionAffinity: 'pmc_alpha' },
  { weaponId: 'hk416', priceUsd: 4600, traderId: 'quartermaster_pmc', requiredTraderLevel: 2, factionAffinity: 'pmc_alpha' },
  { weaponId: 'sig_mcx', priceUsd: 4800, traderId: 'quartermaster_pmc', requiredTraderLevel: 3, factionAffinity: 'pmc_alpha' },
  { weaponId: 'akm_762', priceUsd: 2900, traderId: 'quartermaster_pmc', requiredTraderLevel: 1, factionAffinity: 'pmc_bravo' },
  { weaponId: 'aks74u', priceUsd: 2200, traderId: 'quartermaster_pmc', requiredTraderLevel: 1, factionAffinity: 'pmc_bravo' },
  { weaponId: 'ak105', priceUsd: 3600, traderId: 'militia_armorer', requiredTraderLevel: 2, factionAffinity: 'pmc_bravo' },
  { weaponId: 'remington_870', priceUsd: 1850, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
  { weaponId: 'benelli_m4', priceUsd: 3900, traderId: 'syndicate_broker', requiredTraderLevel: 2 },
  { weaponId: 'mosin_m91_30', priceUsd: 2100, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
  { weaponId: 'dragunov_svd', priceUsd: 5400, traderId: 'militia_armorer', requiredTraderLevel: 3, subFactionRequired: 'highland_militia', minStanding: 25 },
  { weaponId: 'mk14_ebr', priceUsd: 6200, traderId: 'alpine_specialist', requiredTraderLevel: 2, subFactionRequired: 'alpine_remnant', minStanding: 50 },
  { weaponId: 'glock_17', priceUsd: 950, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
  { weaponId: 'makarov_pm', priceUsd: 650, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
  { weaponId: 'beretta_m9', priceUsd: 1100, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
] as const;

export interface OpenWorldAttachmentOffer {
  readonly attachmentId: string;
  readonly label: string;
  readonly slotLabel: string;
  readonly priceUsd: number;
  readonly traderId: TraderId;
  readonly requiredTraderLevel: number;
}

export const QUARTERMASTER_ATTACHMENT_OFFERS: readonly OpenWorldAttachmentOffer[] = [
  { attachmentId: 'optic_t2_red_dot', label: 'Aimpoint Micro T-2 Red Dot', slotLabel: 'Optic', priceUsd: 650, traderId: 'quartermaster_pmc', requiredTraderLevel: 1 },
  { attachmentId: 'optic_kobra_rd', label: 'Kobra EKP-1S-03 Reflex', slotLabel: 'Optic', priceUsd: 580, traderId: 'militia_armorer', requiredTraderLevel: 1 },
  { attachmentId: 'optic_eotech_holo', label: 'EOTech EXPS3 Holographic', slotLabel: 'Optic', priceUsd: 1150, traderId: 'quartermaster_pmc', requiredTraderLevel: 2 },
  { attachmentId: 'optic_rmr_type2', label: 'Trijicon RMR Type 2', slotLabel: 'Optic', priceUsd: 890, traderId: 'syndicate_broker', requiredTraderLevel: 2 },
  { attachmentId: 'optic_pso1_4x', label: 'PSO-1 4x24 Prism Scope', slotLabel: 'Optic', priceUsd: 1450, traderId: 'militia_armorer', requiredTraderLevel: 2 },
  { attachmentId: 'optic_lpvo_1_6', label: '1-6x24 Tactical LPVO', slotLabel: 'Optic', priceUsd: 2200, traderId: 'alpine_specialist', requiredTraderLevel: 2 },
  { attachmentId: 'optic_nightforce_atacr', label: 'ATACR 4-16x42 F1 Sniper Scope', slotLabel: 'Optic', priceUsd: 3400, traderId: 'alpine_specialist', requiredTraderLevel: 3 },
  { attachmentId: 'muzzle_9mm_suppressor', label: '9mm Tactical Suppressor', slotLabel: 'Muzzle', priceUsd: 1100, traderId: 'syndicate_broker', requiredTraderLevel: 2 },
  { attachmentId: 'muzzle_pbs4_545', label: 'PBS-4 Rifle Suppressor', slotLabel: 'Muzzle', priceUsd: 1850, traderId: 'militia_armorer', requiredTraderLevel: 3 },
  { attachmentId: 'tac_peq_combo', label: 'AN/PEQ-15 IR/Vis Laser', slotLabel: 'Tactical', priceUsd: 1600, traderId: 'quartermaster_pmc', requiredTraderLevel: 3 },
] as const;

export function resolveDefaultStorage(): OpenWorldStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

import type { AmmoVariantId, BaseCaliberId } from '../../../../data/calibers';

export type TacticalItemKind =
  | 'magazine'
  | 'ammo_stack'
  | 'medical'
  | 'grenade'
  | 'chest_rig'
  | 'backpack'
  | 'armor_plate'
  | 'intel'
  | 'key'
  | 'barter'
  | 'battery'
  | 'weapon_loose';

export type MagazineClass = 'rifle' | 'pistol';

export type BeltAllowedKind = 'grenade' | 'medical' | 'magazine';

export interface GridDimensions {
  readonly width: number;
  readonly height: number;
}

export interface TacticalItemBase {
  instanceId: string;
  templateId: string;
  name: string;
  shortLabel: string;
  kind: TacticalItemKind;
  width: number;
  height: number;
  rotated?: boolean;
  valueUsd: number;
  weightKg: number;
}

export interface MagazineItem extends TacticalItemBase {
  kind: 'magazine';
  magClass: MagazineClass;
  baseCaliber: BaseCaliberId;
  capacity: number;
  /**
   * LIFO bullet stack: index 0 is bottom of magazine, `rounds[rounds.length - 1]` is top round fed next.
   * Allows mixing ANY ammo variants sharing `baseCaliber` in exact custom order.
   */
  rounds: AmmoVariantId[];
}

export interface AmmoStackItem extends TacticalItemBase {
  kind: 'ammo_stack';
  baseCaliber: BaseCaliberId;
  variantId: AmmoVariantId;
  count: number;
  maxStack: number;
}

export interface MedicalItem extends TacticalItemBase {
  kind: 'medical';
  healHp: number;
  stopsBleed: boolean;
  clearsSprintSlow: boolean;
  usesRemaining: number;
  maxUses: number;
}

export interface GrenadeItem extends TacticalItemBase {
  kind: 'grenade';
  equipmentId: string;
  count: number;
}

export interface PlacedGridItem {
  item: TacticalItem;
  x: number;
  y: number;
  rotated: boolean;
}

export interface GridContainer {
  id: string;
  label: string;
  width: number;
  height: number;
  items: PlacedGridItem[];
}

export interface ChestRigItem extends TacticalItemBase {
  kind: 'chest_rig';
  rifleMagCapacity: number;
  pistolMagCapacity: number;
  rifleMagSlots: Array<MagazineItem | null>;
  pistolMagSlots: Array<MagazineItem | null>;
  generalGrid: GridContainer;
}

export interface BackpackItem extends TacticalItemBase {
  kind: 'backpack';
  grid: GridContainer;
}

export interface ArmorPlateItem extends TacticalItemBase {
  kind: 'armor_plate';
  plateId: string;
  durability: number;
  maxDurability: number;
}

export interface LooseWeaponItem extends TacticalItemBase {
  kind: 'weapon_loose';
  weaponId: string;
}

export interface BatteryItem extends TacticalItemBase {
  kind: 'battery';
  chargePct: number;
  usesRemaining: number;
  maxUses: number;
}

export interface GenericLootItem extends TacticalItemBase {
  kind: 'intel' | 'key' | 'barter';
  quantity: number;
}

export type TacticalItem =
  | MagazineItem
  | AmmoStackItem
  | MedicalItem
  | GrenadeItem
  | ChestRigItem
  | BackpackItem
  | ArmorPlateItem
  | LooseWeaponItem
  | BatteryItem
  | GenericLootItem;

export interface EquippedWeaponSlotState {
  weaponId: string | null;
  chamberedRound: AmmoVariantId | null;
  loadedMag: MagazineItem | null;
}

export interface OperatorTacticalInventory {
  primary: EquippedWeaponSlotState;
  secondary: EquippedWeaponSlotState;
  armorPlateId: string | null;
  /** 4 quick-access tactical belt slots restricted to grenades, meds, and mags */
  beltSlots: Array<TacticalItem | null>;
  /** Removable/equippable Chest Rig providing rifle mag slots, pistol mag slots & general pouches */
  chestRig: ChestRigItem | null;
  /** Removable/equippable Backpack gear item carrying its own nested Tetris grid */
  backpack: BackpackItem | null;
  /** Survives death (2x2 starter, upgraded to 3x3 at FOB Tier 3) */
  secureContainer: GridContainer;
}

export interface CorpseTacticalLootSnapshot {
  primaryWeaponId: string | null;
  secondaryWeaponId: string | null;
  armorPlateId: string | null;
  armorName: string | null;
  chestRig: ChestRigItem | null;
  backpack: BackpackItem | null;
  beltSlots: Array<TacticalItem | null>;
  looseGrid: GridContainer;
}

export type ItemSourceLocator =
  | { zone: 'chest_rig_rifle'; slotIndex: number }
  | { zone: 'chest_rig_pistol'; slotIndex: number }
  | { zone: 'chest_rig_grid'; instanceId: string }
  | { zone: 'belt'; slotIndex: number }
  | { zone: 'backpack_grid'; instanceId: string }
  | { zone: 'secure_grid'; instanceId: string }
  | { zone: 'external_grid'; instanceId: string }
  | { zone: 'external_backpack_grid'; instanceId: string }
  | { zone: 'external_rig_rifle'; slotIndex: number }
  | { zone: 'external_rig_pistol'; slotIndex: number }
  | { zone: 'external_rig_grid'; instanceId: string }
  | { zone: 'external_belt'; slotIndex: number };

export type BackpackTemplateId =
  | 'pack_assault_20l'
  | 'pack_rucksack_35l'
  | 'pack_logistics_55l';

export type EncumbranceTier = 'light' | 'moderate' | 'heavy' | 'overloaded';

export interface OperatorEncumbranceState {
  readonly totalWeightKg: number;
  readonly comfortableKg: number;
  readonly heavyKg: number;
  readonly maxKg: number;
  /** 0 at/below comfortableKg, 1 at maxKg, >1 when overloaded */
  readonly ratio01: number;
  readonly tier: EncumbranceTier;
  readonly moveSpeedMult: number;
  readonly staminaDrainMult: number;
  readonly exertionRateMult: number;
  readonly canSprint: boolean;
}

export interface QuickReloadCandidate {
  locator:
    | { zone: 'chest_rig_rifle'; slotIndex: number }
    | { zone: 'chest_rig_pistol'; slotIndex: number }
    | { zone: 'chest_rig_grid'; instanceId: string }
    | { zone: 'belt'; slotIndex: number }
    | { zone: 'backpack_grid'; instanceId: string };
  magazine: MagazineItem;
  fromBackpack?: boolean;
  reloadTimeMult?: number;
}

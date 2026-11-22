export type PoiTemplateId =
  | 'abandoned_house'
  | 'corner_store'
  | 'concrete_bunker'
  | 'industrial_garage'
  | 'roadside_checkpoint';

export type PoiMaterialKind =
  | 'concrete'
  | 'wood'
  | 'rustedMetal'
  | 'darkSteel'
  | 'sandbag';

export type LootTableId =
  | 'residential'
  | 'store_shelves'
  | 'store_counter'
  | 'military_armory'
  | 'industrial_rack'
  | 'checkpoint_supply'
  | 'starter_pack';

export interface PoiBoxDef {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  material: PoiMaterialKind;
  surface: 'concrete' | 'wood' | 'metal';
  penetrableWood?: boolean;
  blocksMovement?: boolean;
  blocksVision?: boolean;
}

export interface PoiWindowDef {
  idSuffix: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

export interface PoiDoorDef {
  idSuffix: string;
  label: string;
  hingeX: number;
  hingeZ: number;
  width: number;
  /** Direction along local X/Z in closed state: '+x' | '-x' | '+z' | '-z' */
  closedDir: '+x' | '-x' | '+z' | '-z';
  /** Direction along local X/Z in open state: '+x' | '-x' | '+z' | '-z' */
  openDir: '+x' | '-x' | '+z' | '-z';
  material: 'wood' | 'metal';
}

export interface PoiContainerDef {
  idSuffix: string;
  label: string;
  x: number;
  y: number;
  z: number;
  style: 'bag' | 'crate' | 'locker';
  lootTable: LootTableId;
}

export interface PoiInteriorZoneDef {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorSurface: 'concrete' | 'wood' | 'metal';
  acoustics: 'concrete' | 'wood';
}

export interface PoiTemplate {
  id: PoiTemplateId;
  name: string;
  footprintWidth: number;
  footprintDepth: number;
  padMargin: number;
  /** Distance from template center to front road edge alignment */
  roadSetback: number;
  /** Which zones count as indoor & supply acoustic/surface properties */
  interiorZones: PoiInteriorZoneDef[];
  /** Slabs, exterior walls, interior partitions */
  structureBoxes: PoiBoxDef[];
  /** Furniture, counters, shelves, generators, barriers, sandbags */
  propBoxes: PoiBoxDef[];
  /** Breakable dirty glass panes */
  windows: PoiWindowDef[];
  /** Interactive hinged doors */
  doors: PoiDoorDef[];
  /** Lootable containers */
  containers: PoiContainerDef[];
  /** Optional subtle interior light position for dark bunkers/buildings */
  dimLightOffset?: [number, number, number];
  /** Ambient zombie spawn slots in local coordinates */
  zombieSpawns: Array<{
    x: number;
    z: number;
    archetype: 'infected_walker' | 'infected_stalker';
    chance: number;
  }>;
}

export interface LootPoolEntry {
  itemId: string;
  minQty: number;
  maxQty: number;
  weight: number;
  /** Optional magazine round fill fraction range */
  magFillMin?: number;
  magFillMax?: number;
}

export const LOOT_TABLES: Record<
  LootTableId,
  { minRolls: number; maxRolls: number; entries: LootPoolEntry[] }
> = {
  starter_pack: {
    minRolls: 6,
    maxRolls: 6,
    entries: [
      { itemId: 'flashlight', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'weapon_ak74u_545', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'mag_545_30', minQty: 1, maxQty: 1, weight: 10, magFillMin: 0.7, magFillMax: 1.0 },
      { itemId: 'weapon_pm_9x19', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'mag_9x19_15', minQty: 1, maxQty: 1, weight: 10, magFillMin: 0.65, magFillMax: 0.85 },
      { itemId: 'weapon_tactical_knife', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'weapon_rgd5_frag', minQty: 1, maxQty: 2, weight: 10 },
      { itemId: 'weapon_throw_bolt', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'bandage', minQty: 2, maxQty: 2, weight: 10 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 8 },
      { itemId: 'aa_battery', minQty: 1, maxQty: 2, weight: 8 },
    ],
  },
  residential: {
    minRolls: 3,
    maxRolls: 5,
    entries: [
      { itemId: 'canned_tushonka', minQty: 1, maxQty: 1, weight: 22 },
      { itemId: 'crackers_ration', minQty: 1, maxQty: 2, weight: 18 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 22 },
      { itemId: 'energy_soda', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'backpack_sling', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'bandage', minQty: 1, maxQty: 2, weight: 20 },
      { itemId: 'painkillers', minQty: 1, maxQty: 2, weight: 12 },
      { itemId: 'splint', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'aa_battery', minQty: 1, maxQty: 2, weight: 22 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'ammo_9x19', minQty: 6, maxQty: 16, weight: 20 },
      { itemId: 'mag_9x19_15', minQty: 1, maxQty: 1, weight: 12, magFillMin: 0.35, magFillMax: 0.9 },
      { itemId: 'medkit', minQty: 1, maxQty: 1, weight: 8 },
      { itemId: 'weapon_pm_9x19', minQty: 1, maxQty: 1, weight: 5 },
      { itemId: 'weapon_tactical_knife', minQty: 1, maxQty: 1, weight: 8 },
      { itemId: 'weapon_throw_bolt', minQty: 1, maxQty: 1, weight: 8 },
      { itemId: 'flashlight', minQty: 1, maxQty: 1, weight: 6 },
    ],
  },
  store_shelves: {
    minRolls: 3,
    maxRolls: 5,
    entries: [
      { itemId: 'canned_tushonka', minQty: 1, maxQty: 1, weight: 26 },
      { itemId: 'crackers_ration', minQty: 1, maxQty: 2, weight: 22 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 28 },
      { itemId: 'energy_soda', minQty: 1, maxQty: 2, weight: 24 },
      { itemId: 'backpack_sling', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'bandage', minQty: 1, maxQty: 3, weight: 20 },
      { itemId: 'painkillers', minQty: 1, maxQty: 2, weight: 14 },
      { itemId: 'splint', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'tourniquet', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'aa_battery', minQty: 1, maxQty: 3, weight: 26 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 2, weight: 20 },
      { itemId: 'medkit', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'flashlight', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'ammo_9x19', minQty: 8, maxQty: 18, weight: 14 },
      { itemId: 'ammo_12ga', minQty: 3, maxQty: 7, weight: 9 },
      { itemId: 'weapon_crowbar', minQty: 1, maxQty: 1, weight: 7 },
    ],
  },
  store_counter: {
    minRolls: 3,
    maxRolls: 5,
    entries: [
      { itemId: 'backpack_sling', minQty: 1, maxQty: 1, weight: 16 },
      { itemId: 'mre_ration', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 18 },
      { itemId: 'energy_soda', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'weapon_pm_9x19', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_mp133_12ga', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'weapon_tactical_knife', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'mag_9x19_15', minQty: 1, maxQty: 1, weight: 22, magFillMin: 0.4, magFillMax: 1.0 },
      { itemId: 'mag_12ga_6', minQty: 1, maxQty: 1, weight: 14, magFillMin: 0.5, magFillMax: 1.0 },
      { itemId: 'ammo_9x19', minQty: 10, maxQty: 22, weight: 20 },
      { itemId: 'aa_battery', minQty: 1, maxQty: 2, weight: 18 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'medkit', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'tourniquet', minQty: 1, maxQty: 1, weight: 9 },
    ],
  },
  military_armory: {
    minRolls: 3,
    maxRolls: 5,
    entries: [
      { itemId: 'backpack_raid', minQty: 1, maxQty: 1, weight: 16 },
      { itemId: 'mre_ration', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_ak74u_545', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_m4_556', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'weapon_akm_762', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'weapon_mp133_12ga', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'weapon_rgd5_frag', minQty: 1, maxQty: 3, weight: 15 },
      { itemId: 'weapon_tactical_knife', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'mag_545_30', minQty: 1, maxQty: 1, weight: 16, magFillMin: 0.5, magFillMax: 1.0 },
      { itemId: 'mag_556_30', minQty: 1, maxQty: 1, weight: 15, magFillMin: 0.5, magFillMax: 1.0 },
      { itemId: 'mag_762_30', minQty: 1, maxQty: 1, weight: 14, magFillMin: 0.45, magFillMax: 1.0 },
      { itemId: 'mag_12ga_6', minQty: 1, maxQty: 1, weight: 12, magFillMin: 0.5, magFillMax: 1.0 },
      { itemId: 'ammo_545x39', minQty: 15, maxQty: 32, weight: 20 },
      { itemId: 'ammo_556x45', minQty: 15, maxQty: 30, weight: 18 },
      { itemId: 'ammo_762x39', minQty: 12, maxQty: 28, weight: 16 },
      { itemId: 'ammo_12ga', minQty: 4, maxQty: 10, weight: 14 },
      { itemId: 'suppressor_rifle', minQty: 1, maxQty: 1, weight: 11 },
      { itemId: 'suppressor_9mm', minQty: 1, maxQty: 1, weight: 11 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 2, weight: 12 },
      { itemId: 'flashlight', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'medkit', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'tourniquet', minQty: 1, maxQty: 2, weight: 14 },
      { itemId: 'splint', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'painkillers', minQty: 1, maxQty: 2, weight: 10 },
    ],
  },
  industrial_rack: {
    minRolls: 2,
    maxRolls: 4,
    entries: [
      { itemId: 'aa_battery', minQty: 1, maxQty: 3, weight: 26 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 3, weight: 22 },
      { itemId: 'backpack_sling', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'flashlight', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_crowbar', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_throw_bolt', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'bandage', minQty: 1, maxQty: 2, weight: 18 },
      { itemId: 'splint', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'ammo_9x19', minQty: 8, maxQty: 18, weight: 18 },
      { itemId: 'ammo_12ga', minQty: 4, maxQty: 8, weight: 16 },
      { itemId: 'ammo_762x39', minQty: 8, maxQty: 18, weight: 12 },
      { itemId: 'mag_12ga_6', minQty: 1, maxQty: 1, weight: 10, magFillMin: 0.4, magFillMax: 1.0 },
      { itemId: 'weapon_mp133_12ga', minQty: 1, maxQty: 1, weight: 8 },
      { itemId: 'suppressor_9mm', minQty: 1, maxQty: 1, weight: 6 },
    ],
  },
  checkpoint_supply: {
    minRolls: 3,
    maxRolls: 5,
    entries: [
      { itemId: 'backpack_sling', minQty: 1, maxQty: 1, weight: 16 },
      { itemId: 'backpack_raid', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'mre_ration', minQty: 1, maxQty: 1, weight: 18 },
      { itemId: 'water_bottle', minQty: 1, maxQty: 1, weight: 18 },
      { itemId: 'canned_tushonka', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'weapon_pm_9x19', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'weapon_ak74u_545', minQty: 1, maxQty: 1, weight: 9 },
      { itemId: 'weapon_rgd5_frag', minQty: 1, maxQty: 2, weight: 14 },
      { itemId: 'mag_9x19_15', minQty: 1, maxQty: 1, weight: 22, magFillMin: 0.5, magFillMax: 1.0 },
      { itemId: 'ammo_9x19', minQty: 10, maxQty: 24, weight: 22 },
      { itemId: 'ammo_545x39', minQty: 10, maxQty: 24, weight: 18 },
      { itemId: 'mag_545_30', minQty: 1, maxQty: 1, weight: 14, magFillMin: 0.5, magFillMax: 0.9 },
      { itemId: 'suppressor_9mm', minQty: 1, maxQty: 1, weight: 10 },
      { itemId: 'aa_battery', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'battery_cell', minQty: 1, maxQty: 2, weight: 16 },
      { itemId: 'bandage', minQty: 1, maxQty: 3, weight: 18 },
      { itemId: 'tourniquet', minQty: 1, maxQty: 1, weight: 14 },
      { itemId: 'splint', minQty: 1, maxQty: 1, weight: 12 },
      { itemId: 'painkillers', minQty: 1, maxQty: 2, weight: 12 },
      { itemId: 'medkit', minQty: 1, maxQty: 1, weight: 12 },
    ],
  },
};

export const POI_TEMPLATES: Record<PoiTemplateId, PoiTemplate> = {
  // 1. Abandoned House: porch (-X side), living room, kitchen, bedroom, hallway
  abandoned_house: {
    id: 'abandoned_house',
    name: 'Abandoned Residence',
    footprintWidth: 15.0,
    footprintDepth: 12.6,
    padMargin: 5.0,
    roadSetback: 13.5,
    interiorZones: [
      { minX: -5.2, maxX: 0.5, minZ: -5.3, maxZ: 5.3, floorSurface: 'concrete', acoustics: 'concrete' },
      { minX: 0.5, maxX: 6.3, minZ: -5.3, maxZ: 5.3, floorSurface: 'wood', acoustics: 'wood' },
    ],
    structureBoxes: [
      // Porch + Main Slab
      { x: -6.3, y: 0.05, z: 0.0, w: 2.3, h: 0.14, d: 5.2, material: 'wood', surface: 'wood' },
      { x: 0.5, y: 0.06, z: 0.0, w: 12.4, h: 0.16, d: 11.2, material: 'concrete', surface: 'concrete' },
      // Porch overhang & Main Roof
      { x: -6.3, y: 2.95, z: 0.0, w: 2.5, h: 0.16, d: 5.4, material: 'wood', surface: 'wood' },
      { x: 0.5, y: 3.44, z: 0.0, w: 13.0, h: 0.22, d: 11.8, material: 'wood', surface: 'wood' },
      // Porch posts
      { x: -7.3, y: 1.5, z: -2.4, w: 0.18, h: 2.8, d: 0.18, material: 'wood', surface: 'wood' },
      { x: -7.3, y: 1.5, z: 2.4, w: 0.18, h: 2.8, d: 0.18, material: 'wood', surface: 'wood' },

      // West Wall (x = -5.55), front door cutout z = -0.6..+0.65
      { x: -5.55, y: 1.74, z: -3.05, w: 0.26, h: 3.2, d: 4.9, material: 'concrete', surface: 'concrete' },
      { x: -5.55, y: 1.74, z: 3.07, w: 0.26, h: 3.2, d: 4.85, material: 'concrete', surface: 'concrete' },
      { x: -5.55, y: 2.84, z: 0.02, w: 0.26, h: 1.0, d: 1.3, material: 'concrete', surface: 'concrete' },

      // South Wall (z = 5.45) with Living window (x=-3.2..-1.2) and Bedroom window (x=2.2..4.2)
      { x: -4.4, y: 1.74, z: 5.45, w: 2.4, h: 3.2, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: -2.2, y: 0.64, z: 5.45, w: 2.0, h: 1.0, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: -2.2, y: 2.80, z: 5.45, w: 2.0, h: 1.08, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 0.5, y: 1.74, z: 5.45, w: 3.4, h: 3.2, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 3.2, y: 0.64, z: 5.45, w: 2.0, h: 1.0, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 3.2, y: 2.80, z: 5.45, w: 2.0, h: 1.08, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 5.4, y: 1.74, z: 5.45, w: 2.4, h: 3.2, d: 0.26, material: 'concrete', surface: 'concrete' },

      // North Wall (z = -5.45) with Kitchen window (x=-1.5..+0.5)
      { x: -3.55, y: 1.74, z: -5.45, w: 4.1, h: 3.2, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: -0.5, y: 0.64, z: -5.45, w: 2.0, h: 1.0, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: -0.5, y: 2.80, z: -5.45, w: 2.0, h: 1.08, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 3.55, y: 1.74, z: -5.45, w: 6.1, h: 3.2, d: 0.26, material: 'concrete', surface: 'concrete' },

      // East Wall (x = 6.55), rear door cutout z = -3.4..-2.15
      { x: 6.55, y: 1.74, z: -4.45, w: 0.26, h: 3.2, d: 2.0, material: 'concrete', surface: 'concrete' },
      { x: 6.55, y: 1.74, z: 1.65, w: 0.26, h: 3.2, d: 7.6, material: 'concrete', surface: 'concrete' },
      { x: 6.55, y: 2.84, z: -2.8, w: 0.26, h: 1.0, d: 1.3, material: 'concrete', surface: 'concrete' },

      // Interior Hallway Partition (x = 0.5), doorway z = 0.8..2.05
      { x: 0.5, y: 1.74, z: -2.3, w: 0.22, h: 3.2, d: 6.2, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 0.5, y: 1.74, z: 3.75, w: 0.22, h: 3.2, d: 3.4, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 0.5, y: 2.84, z: 1.42, w: 0.22, h: 1.0, d: 1.25, material: 'wood', surface: 'wood', penetrableWood: true },

      // Interior Kitchen / Bedroom cross-wall (z = -0.2, x = 0.6..6.4), doorway x = 2.5..3.75
      { x: 1.55, y: 1.74, z: -0.2, w: 1.9, h: 3.2, d: 0.22, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 5.1, y: 1.74, z: -0.2, w: 2.6, h: 3.2, d: 0.22, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 3.12, y: 2.84, z: -0.2, w: 1.25, h: 1.0, d: 0.22, material: 'wood', surface: 'wood', penetrableWood: true },
    ],
    propBoxes: [
      // Living room table & overturned sofa/crate cover
      { x: -2.8, y: 0.5, z: 2.4, w: 1.8, h: 0.72, d: 0.9, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: -3.2, y: 0.56, z: -3.2, w: 1.2, h: 0.88, d: 1.0, material: 'wood', surface: 'wood', penetrableWood: true },
      // Kitchen counter
      { x: 3.4, y: 0.58, z: -4.6, w: 3.4, h: 0.88, d: 0.8, material: 'wood', surface: 'wood', penetrableWood: true },
      // Bedroom bedframe & dresser
      { x: 4.8, y: 0.42, z: 3.4, w: 2.1, h: 0.55, d: 1.4, material: 'wood', surface: 'wood', penetrableWood: true },
    ],
    windows: [
      { idSuffix: 'win_s1', x: -2.2, y: 1.70, z: 5.45, w: 1.98, h: 1.12, d: 0.04 },
      { idSuffix: 'win_s2', x: 3.2, y: 1.70, z: 5.45, w: 1.98, h: 1.12, d: 0.04 },
      { idSuffix: 'win_n1', x: -0.5, y: 1.70, z: -5.45, w: 1.98, h: 1.12, d: 0.04 },
    ],
    doors: [
      {
        idSuffix: 'front_door',
        label: 'Front Porch Door',
        hingeX: -5.55,
        hingeZ: 0.62,
        width: 1.18,
        closedDir: '-z',
        openDir: '+x',
        material: 'wood',
      },
      {
        idSuffix: 'hall_door',
        label: 'Hallway Door',
        hingeX: 0.5,
        hingeZ: 2.02,
        width: 1.18,
        closedDir: '-z',
        openDir: '+x',
        material: 'wood',
      },
      {
        idSuffix: 'bedroom_door',
        label: 'Bedroom Door',
        hingeX: 2.52,
        hingeZ: -0.2,
        width: 1.18,
        closedDir: '+x',
        openDir: '+z',
        material: 'wood',
      },
      {
        idSuffix: 'back_door',
        label: 'Kitchen Back Door',
        hingeX: 6.55,
        hingeZ: -2.18,
        width: 1.18,
        closedDir: '-z',
        openDir: '-x',
        material: 'wood',
      },
    ],
    containers: [
      { idSuffix: 'living_crate', label: 'Living Room Case', x: -2.9, y: 0.86, z: 2.4, style: 'crate', lootTable: 'residential' },
      { idSuffix: 'kitchen_locker', label: 'Kitchen Pantry Cabinet', x: 5.6, y: 0.14, z: -4.4, style: 'locker', lootTable: 'residential' },
      { idSuffix: 'bedroom_pack', label: 'Bedroom Duffel', x: 2.2, y: 0.14, z: 4.5, style: 'bag', lootTable: 'residential' },
    ],
    dimLightOffset: [-1.5, 2.7, 0.5],
    zombieSpawns: [
      { x: 3.5, z: -2.5, archetype: 'infected_walker', chance: 0.65 },
      { x: -3.2, z: 2.2, archetype: 'infected_walker', chance: 0.45 },
    ],
  },

  // 2. Corner Store: wide glass storefront, dual shelving aisles, counter, back storage room
  corner_store: {
    id: 'corner_store',
    name: 'Corner Supply Store',
    footprintWidth: 14.5,
    footprintDepth: 12.6,
    padMargin: 5.0,
    roadSetback: 13.5,
    interiorZones: [
      { minX: -6.4, maxX: 6.4, minZ: -5.4, maxZ: 5.4, floorSurface: 'concrete', acoustics: 'concrete' },
    ],
    structureBoxes: [
      { x: 0, y: 0.06, z: 0, w: 13.4, h: 0.16, d: 11.4, material: 'concrete', surface: 'concrete' },
      { x: 0, y: 3.54, z: 0, w: 14.0, h: 0.24, d: 12.0, material: 'rustedMetal', surface: 'metal' },

      // West Storefront (-X = -6.55) with front glass entrance (z=-0.7..0.7) and large display windows
      { x: -6.55, y: 1.78, z: -5.0, w: 0.26, h: 3.3, d: 1.2, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 0.56, z: -2.6, w: 0.26, h: 0.85, d: 3.6, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 2.95, z: -2.6, w: 0.26, h: 0.96, d: 3.6, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 2.95, z: 0.0, w: 0.26, h: 0.96, d: 1.6, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 0.56, z: 2.6, w: 0.26, h: 0.85, d: 3.6, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 2.95, z: 2.6, w: 0.26, h: 0.96, d: 3.6, material: 'concrete', surface: 'concrete' },
      { x: -6.55, y: 1.78, z: 5.0, w: 0.26, h: 3.3, d: 1.2, material: 'concrete', surface: 'concrete' },

      // North & South Walls
      { x: 0, y: 1.78, z: -5.55, w: 13.2, h: 3.3, d: 0.26, material: 'concrete', surface: 'concrete' },
      { x: 0, y: 1.78, z: 5.55, w: 13.2, h: 3.3, d: 0.26, material: 'concrete', surface: 'concrete' },

      // East Rear Alley Wall (x = 6.55), rear door cutout z = 2.0..3.25
      { x: 6.55, y: 1.78, z: -1.75, w: 0.26, h: 3.3, d: 7.5, material: 'concrete', surface: 'concrete' },
      { x: 6.55, y: 1.78, z: 4.4, w: 0.26, h: 3.3, d: 2.3, material: 'concrete', surface: 'concrete' },
      { x: 6.55, y: 2.92, z: 2.62, w: 0.26, h: 1.0, d: 1.3, material: 'concrete', surface: 'concrete' },

      // Storage Room Partition (x = 2.6), door cutout z = -3.8..-2.55
      { x: 2.6, y: 1.78, z: -4.65, w: 0.22, h: 3.3, d: 1.7, material: 'concrete', surface: 'concrete' },
      { x: 2.6, y: 1.78, z: 1.45, w: 0.22, h: 3.3, d: 8.1, material: 'concrete', surface: 'concrete' },
      { x: 2.6, y: 2.92, z: -3.17, w: 0.22, h: 1.0, d: 1.3, material: 'concrete', surface: 'concrete' },
    ],
    propBoxes: [
      // Dual retail shelving aisles
      { x: -2.4, y: 0.88, z: -2.3, w: 3.6, h: 1.5, d: 0.72, material: 'rustedMetal', surface: 'metal' },
      { x: -2.4, y: 0.88, z: 2.1, w: 3.6, h: 1.5, d: 0.72, material: 'rustedMetal', surface: 'metal' },
      // Service counter
      { x: 1.2, y: 0.62, z: 1.8, w: 0.85, h: 0.96, d: 4.6, material: 'wood', surface: 'wood', penetrableWood: true },
      // Backroom storage racks
      { x: 4.6, y: 0.92, z: -4.6, w: 2.8, h: 1.6, d: 0.75, material: 'darkSteel', surface: 'metal' },
    ],
    windows: [
      { idSuffix: 'display_n', x: -6.55, y: 1.73, z: -2.6, w: 0.04, h: 1.48, d: 3.56 },
      { idSuffix: 'display_s', x: -6.55, y: 1.73, z: 2.6, w: 0.04, h: 1.48, d: 3.56 },
    ],
    doors: [
      {
        idSuffix: 'store_front',
        label: 'Store Entrance',
        hingeX: -6.55,
        hingeZ: 0.62,
        width: 1.24,
        closedDir: '-z',
        openDir: '+x',
        material: 'metal',
      },
      {
        idSuffix: 'storage_door',
        label: 'Backroom Door',
        hingeX: 2.6,
        hingeZ: -2.58,
        width: 1.18,
        closedDir: '-z',
        openDir: '+x',
        material: 'wood',
      },
      {
        idSuffix: 'alley_door',
        label: 'Alley Exit Door',
        hingeX: 6.55,
        hingeZ: 3.22,
        width: 1.18,
        closedDir: '-z',
        openDir: '-x',
        material: 'metal',
      },
    ],
    containers: [
      { idSuffix: 'aisle_crate', label: 'Supply Shelf Crate', x: -2.2, y: 0.14, z: -1.4, style: 'crate', lootTable: 'store_shelves' },
      { idSuffix: 'counter_stash', label: 'Under-Counter Stash', x: 1.9, y: 0.14, z: 2.4, style: 'bag', lootTable: 'store_counter' },
      { idSuffix: 'backroom_locker', label: 'Storage Room Locker', x: 5.7, y: 0.14, z: -0.4, style: 'locker', lootTable: 'store_counter' },
    ],
    dimLightOffset: [-1.0, 2.9, 0.0],
    zombieSpawns: [
      { x: -1.5, z: 0.2, archetype: 'infected_stalker', chance: 0.55 },
      { x: 4.5, z: 1.0, archetype: 'infected_walker', chance: 0.6 },
    ],
  },

  // 3. Concrete Bunker: heavy blast entry, dark airlock corridor, generator room, armory
  concrete_bunker: {
    id: 'concrete_bunker',
    name: 'Reinforced Sector Bunker',
    footprintWidth: 13.0,
    footprintDepth: 11.4,
    padMargin: 5.0,
    roadSetback: 13.0,
    interiorZones: [
      { minX: -5.8, maxX: 5.8, minZ: -4.8, maxZ: 4.8, floorSurface: 'concrete', acoustics: 'concrete' },
    ],
    structureBoxes: [
      // Heavy slab & blast roof
      { x: 0, y: 0.08, z: 0, w: 12.2, h: 0.20, d: 10.2, material: 'concrete', surface: 'concrete' },
      { x: 0, y: 3.28, z: 0, w: 12.6, h: 0.36, d: 10.6, material: 'concrete', surface: 'concrete' },

      // Thick perimeter concrete walls (0.42m thick)
      // West wall (-5.9), blast doorway z = -0.65..0.65
      { x: -5.9, y: 1.65, z: -2.85, w: 0.42, h: 2.95, d: 4.4, material: 'concrete', surface: 'concrete' },
      { x: -5.9, y: 1.65, z: 2.85, w: 0.42, h: 2.95, d: 4.4, material: 'concrete', surface: 'concrete' },
      { x: -5.9, y: 2.68, z: 0.0, w: 0.42, h: 0.9, d: 1.35, material: 'concrete', surface: 'concrete' },

      // North, South, East solid bunker walls
      { x: 0, y: 1.65, z: -4.9, w: 12.2, h: 2.95, d: 0.42, material: 'concrete', surface: 'concrete' },
      { x: 0, y: 1.65, z: 4.9, w: 12.2, h: 2.95, d: 0.42, material: 'concrete', surface: 'concrete' },
      { x: 5.9, y: 1.65, z: 0, w: 0.42, h: 2.95, d: 10.2, material: 'concrete', surface: 'concrete' },

      // Airlock inner bulkhead (x = -2.2), inner door cutout z = -0.65..0.65
      { x: -2.2, y: 1.65, z: -2.7, w: 0.34, h: 2.95, d: 4.1, material: 'concrete', surface: 'concrete' },
      { x: -2.2, y: 1.65, z: 2.7, w: 0.34, h: 2.95, d: 4.1, material: 'concrete', surface: 'concrete' },
      { x: -2.2, y: 2.68, z: 0.0, w: 0.34, h: 0.9, d: 1.35, material: 'concrete', surface: 'concrete' },

      // Generator / Armory Divider (z = 0.2, x = -2.0..5.7), doorway x = 0.6..1.85
      { x: -0.7, y: 1.65, z: 0.2, w: 2.6, h: 2.95, d: 0.3, material: 'concrete', surface: 'concrete' },
      { x: 3.78, y: 1.65, z: 0.2, w: 3.9, h: 2.95, d: 0.3, material: 'concrete', surface: 'concrete' },
      { x: 1.22, y: 2.68, z: 0.2, w: 1.3, h: 0.9, d: 0.3, material: 'concrete', surface: 'concrete' },
    ],
    propBoxes: [
      // Diesel generator unit in North room
      { x: 3.6, y: 0.85, z: -2.7, w: 2.4, h: 1.4, d: 1.2, material: 'rustedMetal', surface: 'metal' },
      // Armory workbench & barrier cover
      { x: 3.8, y: 0.62, z: 3.7, w: 2.8, h: 0.92, d: 0.85, material: 'darkSteel', surface: 'metal' },
      { x: -0.4, y: 0.56, z: 3.2, w: 1.6, h: 0.85, d: 0.65, material: 'concrete', surface: 'concrete' },
    ],
    windows: [],
    doors: [
      {
        idSuffix: 'blast_outer',
        label: 'Outer Blast Door',
        hingeX: -5.9,
        hingeZ: 0.62,
        width: 1.24,
        closedDir: '-z',
        openDir: '+x',
        material: 'metal',
      },
      {
        idSuffix: 'blast_inner',
        label: 'Airlock Bulkhead Door',
        hingeX: -2.2,
        hingeZ: 0.62,
        width: 1.24,
        closedDir: '-z',
        openDir: '+x',
        material: 'metal',
      },
      {
        idSuffix: 'armory_door',
        label: 'Armory Steel Door',
        hingeX: 0.62,
        hingeZ: 0.2,
        width: 1.2,
        closedDir: '+x',
        openDir: '+z',
        material: 'metal',
      },
    ],
    containers: [
      { idSuffix: 'gen_locker', label: 'Duty Locker', x: -1.4, y: 0.18, z: -4.1, style: 'locker', lootTable: 'checkpoint_supply' },
      { idSuffix: 'armory_case_1', label: 'Armory Weapons Case', x: 4.8, y: 0.18, z: 1.6, style: 'crate', lootTable: 'military_armory' },
      { idSuffix: 'armory_case_2', label: 'Spec-Ops Ordnance Box', x: 3.8, y: 1.08, z: 3.7, style: 'crate', lootTable: 'military_armory' },
    ],
    dimLightOffset: [1.5, 2.75, -1.8],
    zombieSpawns: [
      { x: 1.5, z: -2.6, archetype: 'infected_stalker', chance: 0.7 },
      { x: 2.2, z: 2.5, archetype: 'infected_walker', chance: 0.65 },
    ],
  },

  // 4. Industrial Garage: wide vehicle bay with partial roll-up door, side office, tool racks
  industrial_garage: {
    id: 'industrial_garage',
    name: 'Motor Pool Garage',
    footprintWidth: 15.6,
    footprintDepth: 11.6,
    padMargin: 5.0,
    roadSetback: 14.0,
    interiorZones: [
      { minX: -7.0, maxX: 7.0, minZ: -5.0, maxZ: 5.0, floorSurface: 'concrete', acoustics: 'concrete' },
    ],
    structureBoxes: [
      { x: 0, y: 0.06, z: 0, w: 14.6, h: 0.16, d: 10.6, material: 'concrete', surface: 'concrete' },
      { x: 0, y: 3.92, z: 0, w: 15.2, h: 0.22, d: 11.2, material: 'rustedMetal', surface: 'metal' },

      // West Wall (-7.15) with wide 4.4m roll-up bay door (z = -2.2..2.2, partially open overhead from y=2.1..3.8!)
      { x: -7.15, y: 1.98, z: -3.7, w: 0.28, h: 3.7, d: 3.0, material: 'concrete', surface: 'concrete' },
      { x: -7.15, y: 1.98, z: 3.7, w: 0.28, h: 3.7, d: 3.0, material: 'concrete', surface: 'concrete' },
      { x: -7.15, y: 2.98, z: 0.0, w: 0.18, h: 1.75, d: 4.4, material: 'rustedMetal', surface: 'metal' },

      // North Wall (-5.15) & South Wall (+5.15 with office window x = 2.5..4.7)
      { x: 0, y: 1.98, z: -5.15, w: 14.6, h: 3.7, d: 0.28, material: 'concrete', surface: 'concrete' },
      { x: -2.4, y: 1.98, z: 5.15, w: 9.8, h: 3.7, d: 0.28, material: 'concrete', surface: 'concrete' },
      { x: 3.6, y: 0.64, z: 5.15, w: 2.2, h: 1.0, d: 0.28, material: 'concrete', surface: 'concrete' },
      { x: 3.6, y: 2.98, z: 5.15, w: 2.2, h: 1.52, d: 0.28, material: 'concrete', surface: 'concrete' },
      { x: 5.95, y: 1.98, z: 5.15, w: 2.5, h: 3.7, d: 0.28, material: 'concrete', surface: 'concrete' },

      // East Wall (+7.15) with pedestrian exit door at z = -3.4..-2.15
      { x: 7.15, y: 1.98, z: -4.3, w: 0.28, h: 3.7, d: 1.7, material: 'concrete', surface: 'concrete' },
      { x: 7.15, y: 1.98, z: 1.5, w: 0.28, h: 3.7, d: 7.3, material: 'concrete', surface: 'concrete' },
      { x: 7.15, y: 3.08, z: -2.78, w: 0.28, h: 1.5, d: 1.3, material: 'concrete', surface: 'concrete' },

      // Side Office Partition (x = 1.8, z = 0.8..5.0), door cutout z = 1.4..2.65
      { x: 1.8, y: 1.98, z: 3.9, w: 0.22, h: 3.7, d: 2.3, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 1.8, y: 3.08, z: 2.02, w: 0.22, h: 1.5, d: 1.3, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 4.5, y: 1.98, z: 0.8, w: 5.2, h: 3.7, d: 0.22, material: 'wood', surface: 'wood', penetrableWood: true },
    ],
    propBoxes: [
      // Heavy vehicle lift posts & inspection pit blocks / workbenches
      { x: -2.2, y: 0.62, z: -4.2, w: 3.6, h: 0.95, d: 0.85, material: 'darkSteel', surface: 'metal' },
      { x: -1.6, y: 0.52, z: 1.8, w: 1.5, h: 0.82, d: 1.1, material: 'wood', surface: 'wood', penetrableWood: true },
      { x: 5.4, y: 0.88, z: -4.1, w: 2.4, h: 1.5, d: 0.8, material: 'rustedMetal', surface: 'metal' },
      { x: 4.8, y: 0.52, z: 3.6, w: 1.8, h: 0.8, d: 0.9, material: 'wood', surface: 'wood', penetrableWood: true },
    ],
    windows: [
      { idSuffix: 'office_win', x: 3.6, y: 1.68, z: 5.15, w: 2.16, h: 1.12, d: 0.04 },
    ],
    doors: [
      {
        idSuffix: 'office_door',
        label: 'Foreman Office Door',
        hingeX: 1.8,
        hingeZ: 2.62,
        width: 1.18,
        closedDir: '-z',
        openDir: '+x',
        material: 'wood',
      },
      {
        idSuffix: 'garage_rear',
        label: 'Garage Side Exit',
        hingeX: 7.15,
        hingeZ: -2.18,
        width: 1.18,
        closedDir: '-z',
        openDir: '-x',
        material: 'metal',
      },
    ],
    containers: [
      { idSuffix: 'tool_crate', label: 'Garage Tool Chest', x: -2.5, y: 1.1, z: -4.2, style: 'crate', lootTable: 'industrial_rack' },
      { idSuffix: 'rack_locker', label: 'Parts Locker', x: 6.4, y: 0.14, z: -1.0, style: 'locker', lootTable: 'industrial_rack' },
      { idSuffix: 'office_pack', label: 'Office Field Bag', x: 5.8, y: 0.14, z: 4.1, style: 'bag', lootTable: 'residential' },
    ],
    dimLightOffset: [-1.0, 3.3, -1.0],
    zombieSpawns: [
      { x: -2.5, z: -0.5, archetype: 'infected_walker', chance: 0.65 },
      { x: 4.6, z: -2.2, archetype: 'infected_stalker', chance: 0.45 },
    ],
  },

  // 5. Roadside Checkpoint: concrete guard booth, jersey barriers, sandbag emplacements, rear watch-shed
  roadside_checkpoint: {
    id: 'roadside_checkpoint',
    name: 'Cordon Roadblock',
    footprintWidth: 11.4,
    footprintDepth: 11.4,
    padMargin: 4.5,
    roadSetback: 9.8,
    interiorZones: [
      { minX: -2.4, maxX: 1.4, minZ: -1.9, maxZ: 1.9, floorSurface: 'concrete', acoustics: 'concrete' },
    ],
    structureBoxes: [
      // Guard Booth Slab & Roof
      { x: -0.5, y: 0.06, z: 0.0, w: 4.0, h: 0.16, d: 4.0, material: 'concrete', surface: 'concrete' },
      { x: -0.5, y: 2.75, z: 0.0, w: 4.5, h: 0.18, d: 4.5, material: 'rustedMetal', surface: 'metal' },
      // Booth Walls: West wall (-2.35) with window (-1.2..1.2)
      { x: -2.35, y: 0.64, z: 0.0, w: 0.24, h: 1.0, d: 3.8, material: 'concrete', surface: 'concrete' },
      { x: -2.35, y: 2.46, z: 0.0, w: 0.24, h: 0.45, d: 3.8, material: 'concrete', surface: 'concrete' },
      { x: -2.35, y: 1.65, z: -1.65, w: 0.24, h: 1.2, d: 0.55, material: 'concrete', surface: 'concrete' },
      { x: -2.35, y: 1.65, z: 1.65, w: 0.24, h: 1.2, d: 0.55, material: 'concrete', surface: 'concrete' },
      // North Wall (-1.85) solid
      { x: -0.5, y: 1.4, z: -1.85, w: 3.9, h: 2.55, d: 0.24, material: 'concrete', surface: 'concrete' },
      // South Wall (+1.85) with window
      { x: -0.5, y: 0.64, z: 1.85, w: 3.9, h: 1.0, d: 0.24, material: 'concrete', surface: 'concrete' },
      { x: -0.5, y: 2.46, z: 1.85, w: 3.9, h: 0.45, d: 0.24, material: 'concrete', surface: 'concrete' },
      { x: -1.9, y: 1.65, z: 1.85, w: 0.9, h: 1.2, d: 0.24, material: 'concrete', surface: 'concrete' },
      { x: 0.9, y: 1.65, z: 1.85, w: 0.9, h: 1.2, d: 0.24, material: 'concrete', surface: 'concrete' },
      // East Wall (+1.35) with doorway z = -0.6..0.6
      { x: 1.35, y: 1.4, z: -1.25, w: 0.24, h: 2.55, d: 1.25, material: 'concrete', surface: 'concrete' },
      { x: 1.35, y: 1.4, z: 1.25, w: 0.24, h: 2.55, d: 1.25, material: 'concrete', surface: 'concrete' },
      { x: 1.35, y: 2.46, z: 0.0, w: 0.24, h: 0.45, d: 1.25, material: 'concrete', surface: 'concrete' },
    ],
    propBoxes: [
      // Jersey barriers facing road (-X)
      { x: -4.2, y: 0.48, z: -2.4, w: 0.55, h: 0.92, d: 2.6, material: 'concrete', surface: 'concrete' },
      { x: -4.2, y: 0.48, z: 2.4, w: 0.55, h: 0.92, d: 2.6, material: 'concrete', surface: 'concrete' },
      // Sandbag emplacement
      { x: -3.2, y: 0.42, z: -4.4, w: 2.4, h: 0.78, d: 0.68, material: 'sandbag', surface: 'concrete' },
      { x: 2.8, y: 0.42, z: -3.8, w: 0.68, h: 0.78, d: 2.2, material: 'sandbag', surface: 'concrete' },
      // Rear shelter shed wall/roof
      { x: 4.2, y: 0.52, z: 2.2, w: 1.2, h: 0.9, d: 1.2, material: 'wood', surface: 'wood', penetrableWood: true },
    ],
    windows: [
      { idSuffix: 'booth_w', x: -2.35, y: 1.69, z: 0.0, w: 0.04, h: 1.12, d: 2.7 },
      { idSuffix: 'booth_s', x: -0.5, y: 1.69, z: 1.85, w: 1.88, h: 1.12, d: 0.04 },
    ],
    doors: [
      {
        idSuffix: 'booth_door',
        label: 'Guardhouse Door',
        hingeX: 1.35,
        hingeZ: 0.58,
        width: 1.12,
        closedDir: '-z',
        openDir: '+x',
        material: 'metal',
      },
    ],
    containers: [
      { idSuffix: 'booth_locker', label: 'Guardhouse Locker', x: -1.4, y: 0.14, z: -1.2, style: 'locker', lootTable: 'checkpoint_supply' },
      { idSuffix: 'sandbag_crate', label: 'Checkpoint Ammo Crate', x: 3.4, y: 0.1, z: -3.8, style: 'crate', lootTable: 'checkpoint_supply' },
    ],
    dimLightOffset: [-0.5, 2.35, 0.0],
    zombieSpawns: [
      { x: -3.0, z: 3.6, archetype: 'infected_walker', chance: 0.6 },
      { x: 3.5, z: -1.5, archetype: 'infected_stalker', chance: 0.4 },
    ],
  },
};

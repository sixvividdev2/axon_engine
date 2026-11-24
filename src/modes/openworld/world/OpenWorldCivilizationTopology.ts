import type { BodycamSurfaceMaterial } from '../../../../bodycam-sdk/types';

export const CIV_WORLD_SIZE_M = 4096;
export const CIV_WORLD_HALF_M = CIV_WORLD_SIZE_M * 0.5;
export const CIV_CHUNK_SIZE_M = 256;
export const CIV_GRID_CHUNKS = CIV_WORLD_SIZE_M / CIV_CHUNK_SIZE_M; // 16

export type RoadTier = 'none' | 'highway' | 'fob_spur' | 'dirt_trail';

export interface RoadWaypoint {
  readonly x: number;
  readonly z: number;
}

export interface RoadRouteDef {
  readonly id: string;
  readonly name: string;
  readonly tier: Exclude<RoadTier, 'none'>;
  readonly widthM: number;
  readonly shoulderM: number;
  readonly controlPoints: readonly RoadWaypoint[];
}

export interface BakedRoadSegment {
  readonly routeId: string;
  readonly tier: Exclude<RoadTier, 'none'>;
  readonly ax: number;
  readonly az: number;
  readonly ay: number;
  readonly bx: number;
  readonly bz: number;
  readonly by: number;
  readonly lengthM: number;
  readonly halfWidthM: number;
  readonly shoulderM: number;
  readonly dirX: number;
  readonly dirZ: number;
  readonly perpX: number;
  readonly perpZ: number;
  readonly distFromStartM: number;
  readonly isBridge: boolean;
  readonly bridgeId: string | null;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface RiverBridgeDef {
  readonly id: string;
  readonly name: string;
  readonly routeId: string;
  readonly startX: number;
  readonly startZ: number;
  readonly endX: number;
  readonly endZ: number;
  readonly widthM: number;
}

export interface BakedRiverBridge extends RiverBridgeDef {
  readonly centerX: number;
  readonly centerZ: number;
  readonly lengthM: number;
  readonly yaw: number;
  readonly dirX: number;
  readonly dirZ: number;
  readonly cosY: number;
  readonly sinY: number;
  readonly startY: number;
  readonly endY: number;
  readonly deckY: number;
}

export type OpenWorldSiteKind =
  | 'gas_station'
  | 'house_cabin'
  | 'house_bungalow'
  | 'house_homestead'
  | 'barn'
  | 'checkpoint'
  | 'camp_outpost';

export interface OpenWorldSiteDef {
  readonly id: string;
  readonly name: string;
  readonly settlementName: string;
  readonly kind: OpenWorldSiteKind;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly padRadiusM: number;
  readonly variantSeed: number;
  readonly brandColorHex?: number;
}

export interface BakedOpenWorldSite extends OpenWorldSiteDef {
  readonly groundY: number;
}

export type HorizonTowerKind = 'water_tower' | 'radio_mast';

export interface HorizonTowerDef {
  readonly id: string;
  readonly name: string;
  readonly kind: HorizonTowerKind;
  readonly x: number;
  readonly z: number;
  readonly heightM: number;
}

export interface BakedHorizonTower extends HorizonTowerDef {
  readonly groundY: number;
}

export interface RoadQueryResult {
  onRoad: boolean;
  onShoulder: boolean;
  onBridge: boolean;
  tier: RoadTier;
  distanceM: number;
  halfWidthM: number;
  shoulderM: number;
  targetY: number;
  dirX: number;
  dirZ: number;
  bridgeId: string | null;
}

export interface SitePadQueryResult {
  onPad: boolean;
  blend: number;
  targetY: number;
  siteKind: OpenWorldSiteKind | null;
}

export function createRoadQueryResult(): RoadQueryResult {
  return {
    onRoad: false,
    onShoulder: false,
    onBridge: false,
    tier: 'none',
    distanceM: Infinity,
    halfWidthM: 0,
    shoulderM: 0,
    targetY: 0,
    dirX: 0,
    dirZ: -1,
    bridgeId: null,
  };
}

export function createSitePadQueryResult(): SitePadQueryResult {
  return {
    onPad: false,
    blend: 0,
    targetY: 0,
    siteKind: null,
  };
}

// ============================================================================
// UNIFIED OBB PHYSICS, WALKABLE DECK & INDOOR ACOUSTIC PRIMITIVES (Zero-GC)
// ============================================================================

export interface SolidObb {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly cosY: number; // cos(yaw)
  readonly sinY: number; // sin(yaw)
  readonly surface: BodycamSurfaceMaterial;
  readonly blocksBullets: boolean;
  readonly blocksPlayer: boolean;
}

export interface WalkDeck {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
  readonly cosY: number;
  readonly sinY: number;
  readonly baseY: number;
  /** Optional longitudinal slope along local Z (for bridge deck grade) */
  readonly slopeAlongZ: number;
  readonly thicknessM: number;
  readonly surface: BodycamSurfaceMaterial;
}

export interface IndoorVolume {
  readonly cx: number;
  readonly cz: number;
  readonly hx: number;
  readonly hz: number;
  readonly cosY: number;
  readonly sinY: number;
  readonly minY: number;
  readonly maxY: number;
  readonly material: 'concrete' | 'wood' | 'metal';
}

export interface ObbRaycastHit {
  hit: boolean;
  distance: number;
  pointX: number;
  pointY: number;
  pointZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  surface: BodycamSurfaceMaterial;
}

export function createObbRaycastHit(): ObbRaycastHit {
  return {
    hit: false,
    distance: Infinity,
    pointX: 0,
    pointY: 0,
    pointZ: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    surface: 'concrete',
  };
}

// ============================================================================
// DETERMINISTIC 4KM ROAD GRAPH, RIVER BRIDGES & SETTLEMENTS
// ============================================================================

/**
 * 3 Elevated Steel-Truss River Bridges anchored directly across the carved central river channel.
 */
export const RIVER_BRIDGE_DEFS: readonly RiverBridgeDef[] = [
  {
    id: 'bridge_south_valley',
    name: 'South Valley Steel Bridge',
    routeId: 'route_south_connector',
    startX: -185,
    startZ: 660,
    endX: -70,
    endZ: 652,
    widthM: 10.6,
  },
  {
    id: 'bridge_central_timberline',
    name: 'Timberline Rail River Bridge',
    routeId: 'route_east_valley',
    startX: -98,
    startZ: 224,
    endX: 16,
    endZ: 216,
    widthM: 10.6,
  },
  {
    id: 'bridge_upper_gorge',
    name: 'Route 41 Upper Gorge Bridge',
    routeId: 'route_41_highway',
    startX: -152,
    startZ: -64,
    endX: -32,
    endZ: -116,
    widthM: 11.6,
  },
] as const;

export const ROAD_ROUTE_DEFS: readonly RoadRouteDef[] = [
  {
    id: 'route_41_highway',
    name: 'Route 41 Tactical Highway',
    tier: 'highway',
    widthM: 11.0,
    shoulderM: 4.5,
    controlPoints: [
      { x: -535, z: 1235 }, // Delta Coastal Port gate
      { x: -485, z: 1095 },
      { x: -435, z: 965 },  // Coastal Port Approach Gas Station
      { x: -380, z: 800 },
      { x: -320, z: 620 },  // Pine Valley Junction (Alpha FOB Spur + South Bridge)
      { x: -245, z: 430 },
      { x: -175, z: 245 },  // Timberline Rail Yard
      { x: -165, z: 65 },
      { x: -152, z: -64 },  // Upper Gorge Bridge South Abutment
      { x: -32, z: -116 },  // Upper Gorge Bridge North Abutment
      { x: 110, z: -185 },
      { x: 265, z: -255 },  // Steppe Crossroads & Rest Stop Gas
      { x: 465, z: -375 },  // Highland Quarry Junction (Bravo FOB Spur)
      { x: 445, z: -565 },
      { x: 375, z: -760 },  // Highland Pass Checkpoint
      { x: 315, z: -935 },
      { x: 265, z: -1080 }, // Alpine Pass Fuel Depot
      { x: 215, z: -1220 },
      { x: 185, z: -1330 }, // Alpine Dam Approach
    ],
  },
  {
    id: 'route_alpha_fob_spur',
    name: 'Alpha FOB Paved Spur',
    tier: 'fob_spur',
    widthM: 9.0,
    shoulderM: 3.5,
    controlPoints: [
      { x: -1095, z: 682 }, // PMC Alpha FOB exit apron
      { x: -955, z: 672 },
      { x: -820, z: 660 },  // Alpha Gatehouse Checkpoint
      { x: -610, z: 644 },  // Alpha Approach Village
      { x: -460, z: 632 },
      { x: -320, z: 620 },  // Route 41 Junction
    ],
  },
  {
    id: 'route_bravo_fob_spur',
    name: 'Bravo FOB Paved Spur',
    tier: 'fob_spur',
    widthM: 9.0,
    shoulderM: 3.5,
    controlPoints: [
      { x: 1135, z: -632 }, // PMC Bravo FOB exit apron
      { x: 995, z: -580 },
      { x: 855, z: -525 },  // Bravo Gatehouse Checkpoint
      { x: 685, z: -458 },
      { x: 465, z: -375 },  // Route 41 Quarry Junction
    ],
  },
  {
    id: 'route_east_valley',
    name: 'East Timberline Connector',
    tier: 'fob_spur',
    widthM: 9.0,
    shoulderM: 3.5,
    controlPoints: [
      { x: -175, z: 245 }, // Timberline Rail Yard
      { x: -98, z: 224 },  // Central River Bridge West Abutment
      { x: 16, z: 216 },   // Central River Bridge East Abutment
      { x: 145, z: 205 },
      { x: 255, z: 192 },  // East Timber Hamlet
      { x: 268, z: 20 },
      { x: 265, z: -255 }, // Steppe Crossroads
    ],
  },
  {
    id: 'route_south_connector',
    name: 'South Valley River Crossing',
    tier: 'fob_spur',
    widthM: 9.0,
    shoulderM: 3.5,
    controlPoints: [
      { x: -320, z: 620 }, // Pine Valley Junction
      { x: -245, z: 650 },
      { x: -185, z: 660 }, // South Valley Bridge West Abutment
      { x: -70, z: 652 },  // South Valley Bridge East Abutment
      { x: 95, z: 625 },
      { x: 220, z: 540 },  // South East Homesteads
      { x: 250, z: 365 },
      { x: 255, z: 192 },  // East Timber Hamlet
    ],
  },
  {
    id: 'trail_coastal_marsh',
    name: 'Coastal Marsh Homestead Track',
    tier: 'dirt_trail',
    widthM: 6.5,
    shoulderM: 2.5,
    controlPoints: [
      { x: -485, z: 1095 },
      { x: -640, z: 1118 },
      { x: -795, z: 1126 },
      { x: -920, z: 1112 }, // Marsh Village
    ],
  },
  {
    id: 'trail_west_logging',
    name: 'West Pine Logging Trail',
    tier: 'dirt_trail',
    widthM: 6.5,
    shoulderM: 2.5,
    controlPoints: [
      { x: -610, z: 644 },
      { x: -720, z: 485 },
      { x: -775, z: 295 },
      { x: -760, z: 120 },  // West Logging Homestead & Barn
      { x: -710, z: -70 },
      { x: -640, z: -240 }, // West Radio Ridge Overlook
    ],
  },
  {
    id: 'trail_steppe_farmstead',
    name: 'Steppe Farmstead Dirt Track',
    tier: 'dirt_trail',
    widthM: 6.5,
    shoulderM: 2.5,
    controlPoints: [
      { x: 255, z: 192 },
      { x: 445, z: 182 },
      { x: 645, z: 158 },
      { x: 815, z: 128 }, // Steppe Farmstead
    ],
  },
  {
    id: 'trail_highland_ridge',
    name: 'Highland Overlook Track',
    tier: 'dirt_trail',
    widthM: 6.5,
    shoulderM: 2.5,
    controlPoints: [
      { x: 375, z: -760 },
      { x: 185, z: -780 },
      { x: -20, z: -805 },
      { x: -215, z: -820 }, // Highland Overlook Hamlet
    ],
  },
  {
    id: 'trail_alpine_relay',
    name: 'Alpine Relay Service Trail',
    tier: 'dirt_trail',
    widthM: 6.5,
    shoulderM: 2.5,
    controlPoints: [
      { x: 265, z: -1080 },
      { x: 440, z: -1095 },
      { x: 610, z: -1112 },
      { x: 760, z: -1120 }, // Alpine Radio Mast Ridge
    ],
  },
] as const;

/**
 * Curated & deterministic enterable sites distributed across all 4 biomes:
 * - 4 Roadside Gas Stations
 * - 6 Settlements/Hamlets totaling 22 enterable houses + 5 enterable timber barns
 * - 5 Military Roadside Checkpoints
 */
export const OPENWORLD_SITE_DEFS: readonly OpenWorldSiteDef[] = [
  // === 4 ROADSIDE GAS STATIONS ===
  {
    id: 'gas_coastal_approach',
    name: 'Delta Fuel & Service',
    settlementName: 'Coastal Approach',
    kind: 'gas_station',
    x: -400,
    z: 960,
    yaw: -1.32,
    padRadiusM: 26,
    variantSeed: 101,
    brandColorHex: 0xb93829, // Industrial red/amber
  },
  {
    id: 'gas_pine_valley',
    name: 'Route 41 Pine Junction Fuel',
    settlementName: 'Pine Valley Junction',
    kind: 'gas_station',
    x: -362,
    z: 595,
    yaw: 1.48,
    padRadiusM: 26,
    variantSeed: 202,
    brandColorHex: 0x1d6f72, // Petrol teal
  },
  {
    id: 'gas_steppe_crossroads',
    name: 'Steppe Crossroads Truck Stop',
    settlementName: 'Steppe Crossroads',
    kind: 'gas_station',
    x: 222,
    z: -245,
    yaw: 1.15,
    padRadiusM: 26,
    variantSeed: 303,
    brandColorHex: 0xc47b21, // Industrial amber
  },
  {
    id: 'gas_alpine_depot',
    name: 'Alpine Pass Fuel Depot',
    settlementName: 'Alpine Pass',
    kind: 'gas_station',
    x: 226,
    z: -1082,
    yaw: 1.52,
    padRadiusM: 26,
    variantSeed: 404,
    brandColorHex: 0x9e3226,
  },

  // === 5 MILITARY ROADSIDE CHECKPOINTS ===
  {
    id: 'cp_alpha_gate',
    name: 'Alpha FOB Highway Gatehouse',
    settlementName: 'Alpha Perimeter',
    kind: 'checkpoint',
    x: -820,
    z: 660,
    yaw: 1.48,
    padRadiusM: 18,
    variantSeed: 501,
  },
  {
    id: 'cp_bravo_gate',
    name: 'Bravo FOB Highway Gatehouse',
    settlementName: 'Bravo Perimeter',
    kind: 'checkpoint',
    x: 855,
    z: -525,
    yaw: 1.94,
    padRadiusM: 18,
    variantSeed: 502,
  },
  {
    id: 'cp_bridge_south',
    name: 'South Valley Bridge Roadblock',
    settlementName: 'Valley Crossing',
    kind: 'checkpoint',
    x: -242,
    z: 650,
    yaw: 1.72,
    padRadiusM: 18,
    variantSeed: 503,
  },
  {
    id: 'cp_highland_pass',
    name: 'Route 41 Highland Checkpoint',
    settlementName: 'Highland Pass',
    kind: 'checkpoint',
    x: 375,
    z: -760,
    yaw: -0.32,
    padRadiusM: 18,
    variantSeed: 504,
  },
  {
    id: 'cp_alpine_approach',
    name: 'Dam Security Roadblock',
    settlementName: 'Alpine Approach',
    kind: 'checkpoint',
    x: 215,
    z: -1220,
    yaw: -0.26,
    padRadiusM: 18,
    variantSeed: 505,
  },

  // === SETTLEMENT 1: MARSH HAMLET (Coastal Port & Marsh Delta) ===
  {
    id: 'house_marsh_1',
    name: 'Marsh Dock Cottage',
    settlementName: 'Marsh Hamlet',
    kind: 'house_cabin',
    x: -875,
    z: 1094,
    yaw: 0.12,
    padRadiusM: 13,
    variantSeed: 601,
  },
  {
    id: 'house_marsh_2',
    name: 'Estuary Fisherman Bungalow',
    settlementName: 'Marsh Hamlet',
    kind: 'house_bungalow',
    x: -918,
    z: 1134,
    yaw: 3.04,
    padRadiusM: 15,
    variantSeed: 602,
  },
  {
    id: 'house_marsh_3',
    name: 'Tidal Creek Shack',
    settlementName: 'Marsh Hamlet',
    kind: 'house_cabin',
    x: -955,
    z: 1096,
    yaw: -0.45,
    padRadiusM: 13,
    variantSeed: 603,
  },
  {
    id: 'barn_marsh_1',
    name: 'Marsh Boat & Gear Barn',
    settlementName: 'Marsh Hamlet',
    kind: 'barn',
    x: -828,
    z: 1144,
    yaw: 1.54,
    padRadiusM: 16,
    variantSeed: 604,
  },

  // === SETTLEMENT 2: ALPHA APPROACH VILLAGE (Conifer Valley West) ===
  {
    id: 'house_alpha_1',
    name: 'Alpha Road Homestead',
    settlementName: 'Alpha Approach Village',
    kind: 'house_homestead',
    x: -635,
    z: 622,
    yaw: 0.08,
    padRadiusM: 15,
    variantSeed: 701,
  },
  {
    id: 'house_alpha_2',
    name: 'Spruce Line Bungalow',
    settlementName: 'Alpha Approach Village',
    kind: 'house_bungalow',
    x: -572,
    z: 622,
    yaw: -0.05,
    padRadiusM: 15,
    variantSeed: 702,
  },
  {
    id: 'house_alpha_3',
    name: 'FOB Spur Cabin',
    settlementName: 'Alpha Approach Village',
    kind: 'house_cabin',
    x: -612,
    z: 668,
    yaw: 3.12,
    padRadiusM: 13,
    variantSeed: 703,
  },
  {
    id: 'house_alpha_4',
    name: 'West Logging Cabin',
    settlementName: 'West Logging Homestead',
    kind: 'house_bungalow',
    x: -788,
    z: 122,
    yaw: 1.5,
    padRadiusM: 15,
    variantSeed: 704,
  },
  {
    id: 'barn_west_logging',
    name: 'Timberline Logging Barn',
    settlementName: 'West Logging Homestead',
    kind: 'barn',
    x: -730,
    z: 112,
    yaw: -1.52,
    padRadiusM: 16,
    variantSeed: 705,
  },

  // === SETTLEMENT 3: PINE VALLEY CROSSING HAMLET (Central Highway) ===
  {
    id: 'house_pine_1',
    name: 'Route 41 Inn House',
    settlementName: 'Pine Valley Hamlet',
    kind: 'house_homestead',
    x: -286,
    z: 598,
    yaw: -1.52,
    padRadiusM: 15,
    variantSeed: 801,
  },
  {
    id: 'house_pine_2',
    name: 'Pine Junction Cottage',
    settlementName: 'Pine Valley Hamlet',
    kind: 'house_cabin',
    x: -292,
    z: 562,
    yaw: -1.45,
    padRadiusM: 13,
    variantSeed: 802,
  },
  {
    id: 'house_pine_3',
    name: 'Valley Road Bungalow',
    settlementName: 'Pine Valley Hamlet',
    kind: 'house_bungalow',
    x: -362,
    z: 648,
    yaw: 1.56,
    padRadiusM: 15,
    variantSeed: 803,
  },
  {
    id: 'house_pine_4',
    name: 'South Bridge Watch House',
    settlementName: 'Pine Valley Hamlet',
    kind: 'house_cabin',
    x: -285,
    z: 682,
    yaw: 3.1,
    padRadiusM: 13,
    variantSeed: 804,
  },

  // === SETTLEMENT 4: EAST TIMBER HOMESTEADS (Across River Bridges) ===
  {
    id: 'house_east_1',
    name: 'East Timber Farmhouse',
    settlementName: 'East Timber Hamlet',
    kind: 'house_homestead',
    x: 288,
    z: 215,
    yaw: -1.6,
    padRadiusM: 15,
    variantSeed: 901,
  },
  {
    id: 'house_east_2',
    name: 'Riverbend Bungalow',
    settlementName: 'East Timber Hamlet',
    kind: 'house_bungalow',
    x: 222,
    z: 166,
    yaw: 0.14,
    padRadiusM: 15,
    variantSeed: 902,
  },
  {
    id: 'house_east_3',
    name: 'Mill Creek Cabin',
    settlementName: 'East Timber Hamlet',
    kind: 'house_cabin',
    x: 288,
    z: 165,
    yaw: -0.25,
    padRadiusM: 13,
    variantSeed: 903,
  },
  {
    id: 'house_east_4',
    name: 'South Valley Crossing House',
    settlementName: 'South East Homesteads',
    kind: 'house_bungalow',
    x: 252,
    z: 545,
    yaw: -1.55,
    padRadiusM: 15,
    variantSeed: 904,
  },
  {
    id: 'barn_east_timber',
    name: 'East Valley Red Barn',
    settlementName: 'East Timber Hamlet',
    kind: 'barn',
    x: 215,
    z: 235,
    yaw: 1.48,
    padRadiusM: 16,
    variantSeed: 905,
  },

  // === SETTLEMENT 5: STEPPE FARMSTEAD & CROSSROADS (Highland Quarry) ===
  {
    id: 'house_steppe_1',
    name: 'Steppe Crossroads House',
    settlementName: 'Steppe Crossroads',
    kind: 'house_bungalow',
    x: 298,
    z: -280,
    yaw: -1.85,
    padRadiusM: 15,
    variantSeed: 1001,
  },
  {
    id: 'house_steppe_2',
    name: 'Quarry Rim Homestead',
    settlementName: 'Steppe Farmstead',
    kind: 'house_homestead',
    x: 795,
    z: 152,
    yaw: 3.05,
    padRadiusM: 15,
    variantSeed: 1002,
  },
  {
    id: 'house_steppe_3',
    name: 'Steppe Ranch Cabin',
    settlementName: 'Steppe Farmstead',
    kind: 'house_cabin',
    x: 842,
    z: 106,
    yaw: 0.12,
    padRadiusM: 13,
    variantSeed: 1003,
  },
  {
    id: 'barn_steppe_1',
    name: 'Steppe Grain & Hay Barn',
    settlementName: 'Steppe Farmstead',
    kind: 'barn',
    x: 785,
    z: 96,
    yaw: 0.04,
    padRadiusM: 16,
    variantSeed: 1004,
  },

  // === SETTLEMENT 6: HIGHLAND OVERLOOK VILLAGE (Highland / Alpine Border) ===
  {
    id: 'house_highland_1',
    name: 'Ridge Overlook Homestead',
    settlementName: 'Highland Overlook Village',
    kind: 'house_homestead',
    x: -188,
    z: -846,
    yaw: 0.15,
    padRadiusM: 15,
    variantSeed: 1101,
  },
  {
    id: 'house_highland_2',
    name: 'Alpine Scout Cabin',
    settlementName: 'Highland Overlook Village',
    kind: 'house_cabin',
    x: -242,
    z: -800,
    yaw: 2.95,
    padRadiusM: 13,
    variantSeed: 1102,
  },
  {
    id: 'house_highland_3',
    name: 'Pass Watch Bungalow',
    settlementName: 'Highland Overlook Village',
    kind: 'house_bungalow',
    x: -232,
    z: -852,
    yaw: -0.2,
    padRadiusM: 15,
    variantSeed: 1103,
  },
  {
    id: 'barn_highland_1',
    name: 'Highland Timber Barn',
    settlementName: 'Highland Overlook Village',
    kind: 'barn',
    x: -146,
    z: -802,
    yaw: 1.58,
    padRadiusM: 16,
    variantSeed: 1104,
  },

  // === 8 ROADSIDE MILITIA / LOGGING FIELD CAMPS & AMBUSH OUTPOSTS ===
  {
    id: 'camp_coastal_watch',
    name: 'Coastal Highway Recon Camp',
    settlementName: 'Coastal Approach',
    kind: 'camp_outpost',
    x: -472,
    z: 972,
    yaw: 1.45,
    padRadiusM: 14,
    variantSeed: 1201,
  },
  {
    id: 'camp_south_bridge_east',
    name: 'South Bridge Overlook Camp',
    settlementName: 'Valley Crossing',
    kind: 'camp_outpost',
    x: 22,
    z: 608,
    yaw: 3.05,
    padRadiusM: 14,
    variantSeed: 1202,
  },
  {
    id: 'camp_west_timber_cut',
    name: 'West Pine Logging Camp',
    settlementName: 'West Pine Trail',
    kind: 'camp_outpost',
    x: -726,
    z: 338,
    yaw: -1.45,
    padRadiusM: 14,
    variantSeed: 1203,
  },
  {
    id: 'camp_central_rail_overlook',
    name: 'Route 41 Ambush Bivouac',
    settlementName: 'Timberline Corridor',
    kind: 'camp_outpost',
    x: -178,
    z: 355,
    yaw: -1.25,
    padRadiusM: 14,
    variantSeed: 1204,
  },
  {
    id: 'camp_east_valley_timber',
    name: 'East Valley Timber Post',
    settlementName: 'East Timberline',
    kind: 'camp_outpost',
    x: 304,
    z: 58,
    yaw: -1.55,
    padRadiusM: 14,
    variantSeed: 1205,
  },
  {
    id: 'camp_quarry_staging',
    name: 'Quarry Rim Staging Camp',
    settlementName: 'Highland Quarry',
    kind: 'camp_outpost',
    x: 575,
    z: -454,
    yaw: 0.32,
    padRadiusM: 14,
    variantSeed: 1206,
  },
  {
    id: 'camp_highland_ambush',
    name: 'Highland Trail Outpost',
    settlementName: 'Highland Overlook',
    kind: 'camp_outpost',
    x: 95,
    z: -756,
    yaw: 3.08,
    padRadiusM: 14,
    variantSeed: 1207,
  },
  {
    id: 'camp_alpine_bivouac',
    name: 'Alpine Relay Field Camp',
    settlementName: 'Alpine Relay Ridge',
    kind: 'camp_outpost',
    x: 525,
    z: -1068,
    yaw: 3.12,
    padRadiusM: 14,
    variantSeed: 1208,
  },
] as const;

/**
 * Persistent Horizon-Layer vertical regional landmarks (Water Towers & Guyed Radio Masts)
 * visible across the 4km theater for orientation on foot, optics, and recon flight.
 */
export const HORIZON_TOWER_DEFS: readonly HorizonTowerDef[] = [
  // 4 Elevated Municipal Water Towers
  { id: 'tower_water_marsh', name: 'Marsh Municipal Water Tower', kind: 'water_tower', x: -855, z: 1068, heightM: 28 },
  { id: 'tower_water_pine', name: 'Pine Valley Water Tower', kind: 'water_tower', x: -392, z: 560, heightM: 30 },
  { id: 'tower_water_east', name: 'East Timber Water Tower', kind: 'water_tower', x: 318, z: 245, heightM: 29 },
  { id: 'tower_water_steppe', name: 'Steppe Crossroads Water Tower', kind: 'water_tower', x: 325, z: -222, heightM: 32 },

  // 4 Tall Red/White Guyed Lattice Radio Masts
  { id: 'mast_west_ridge', name: 'West Ridge Comms Mast', kind: 'radio_mast', x: -640, z: -258, heightM: 58 },
  { id: 'mast_highland_village', name: 'Highland Overlook Relay Mast', kind: 'radio_mast', x: -255, z: -878, heightM: 62 },
  { id: 'mast_alpine_relay', name: 'Alpine Summit Radio Mast', kind: 'radio_mast', x: 778, z: -1125, heightM: 64 },
  { id: 'mast_bravo_overlook', name: 'Bravo Ridge Signal Mast', kind: 'radio_mast', x: 960, z: -465, heightM: 54 },
] as const;

// ============================================================================
// BAKED TOPOLOGY & CHUNK SPATIAL BUCKETS
// ============================================================================

let _isBaked = false;
const _bakedSegments: BakedRoadSegment[] = [];
const _bakedBridges: BakedRiverBridge[] = [];
const _bakedSites: BakedOpenWorldSite[] = [];
const _bakedTowers: BakedHorizonTower[] = [];

// 16 x 16 spatial index buckets for ultra-fast terrain grading & chunk building
const _chunkRoadBuckets: BakedRoadSegment[][] = Array.from(
  { length: CIV_GRID_CHUNKS * CIV_GRID_CHUNKS },
  () => [],
);
const _chunkSiteBuckets: BakedOpenWorldSite[][] = Array.from(
  { length: CIV_GRID_CHUNKS * CIV_GRID_CHUNKS },
  () => [],
);
const _chunkBridgeBuckets: BakedRiverBridge[][] = Array.from(
  { length: CIV_GRID_CHUNKS * CIV_GRID_CHUNKS },
  () => [],
);

function clampChunkIdx(v: number): number {
  return Math.max(0, Math.min(CIV_GRID_CHUNKS - 1, v));
}

function posToChunkIdx(worldPos: number): number {
  return clampChunkIdx(Math.floor((worldPos + CIV_WORLD_HALF_M) / CIV_CHUNK_SIZE_M));
}

function bucketIndex(cx: number, cz: number): number {
  return cz * CIV_GRID_CHUNKS + cx;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  if (Math.abs(d) < 1e-6) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / d));
  return t * t * (3 - 2 * t);
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function findMatchingBridge(
  routeId: string,
  mx: number,
  mz: number,
): BakedRiverBridge | null {
  for (let i = 0; i < _bakedBridges.length; i++) {
    const b = _bakedBridges[i];
    if (b.routeId !== routeId) continue;
    const dx = mx - b.centerX;
    const dz = mz - b.centerZ;
    // Transform into bridge local space (forward along bridge dir)
    const along = dx * b.dirX + dz * b.dirZ;
    const across = Math.abs(-dx * b.dirZ + dz * b.dirX);
    if (Math.abs(along) <= b.lengthM * 0.52 && across <= b.widthM * 1.15) {
      return b;
    }
  }
  return null;
}

/**
 * Deterministically bakes all road spline segments, bridge deck heights, site pad elevations,
 * and 16×16 chunk spatial buckets from the raw 4-biome heightfield. Idempotent & zero-runtime-cost.
 */
export function ensureCivilizationTopologyBaked(
  rawHeightEvaluator: (x: number, z: number) => number,
  seaLevelM = 0.0,
): void {
  if (_isBaked) return;
  _isBaked = true;

  // 1. Bake River Bridges first so intersecting road segments snap directly to bridge abutments
  for (let i = 0; i < RIVER_BRIDGE_DEFS.length; i++) {
    const def = RIVER_BRIDGE_DEFS[i];
    const dx = def.endX - def.startX;
    const dz = def.endZ - def.startZ;
    const lengthM = Math.hypot(dx, dz);
    const dirX = dx / Math.max(1e-4, lengthM);
    const dirZ = dz / Math.max(1e-4, lengthM);
    const yaw = Math.atan2(dirX, dirZ);

    const hStartRaw = rawHeightEvaluator(def.startX, def.startZ);
    const hEndRaw = rawHeightEvaluator(def.endX, def.endZ);
    const hMidRaw = rawHeightEvaluator((def.startX + def.endX) * 0.5, (def.startZ + def.endZ) * 0.5);
    const minClearY = Math.max(seaLevelM + 5.5, hMidRaw + 5.0);
    const startY = Math.max(hStartRaw + 0.65, minClearY);
    const endY = Math.max(hEndRaw + 0.65, minClearY);
    const deckY = (startY + endY) * 0.5;

    const baked: BakedRiverBridge = {
      ...def,
      centerX: (def.startX + def.endX) * 0.5,
      centerZ: (def.startZ + def.endZ) * 0.5,
      lengthM,
      yaw,
      dirX,
      dirZ,
      cosY: Math.cos(yaw),
      sinY: Math.sin(yaw),
      startY,
      endY,
      deckY,
    };
    _bakedBridges.push(baked);

    const pad = lengthM * 0.55 + 24;
    const cMinX = posToChunkIdx(baked.centerX - pad);
    const cMaxX = posToChunkIdx(baked.centerX + pad);
    const cMinZ = posToChunkIdx(baked.centerZ - pad);
    const cMaxZ = posToChunkIdx(baked.centerZ + pad);
    for (let cz = cMinZ; cz <= cMaxZ; cz++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        _chunkBridgeBuckets[bucketIndex(cx, cz)].push(baked);
      }
    }
  }

  // 2. Bake smoothed road spline polylines into ~22m segments with smoothly filtered elevations
  for (let r = 0; r < ROAD_ROUTE_DEFS.length; r++) {
    const route = ROAD_ROUTE_DEFS[r];
    const pts = route.controlPoints;
    const densePts: Array<{ x: number; z: number; y: number; bridge: BakedRiverBridge | null }> = [];

    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(pts.length - 1, i + 2)];

      const segDist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      // Keep exact bridge segments straight (linear) so road meets abutments seamlessly
      const midBridge = findMatchingBridge(route.id, (p1.x + p2.x) * 0.5, (p1.z + p2.z) * 0.5);
      const subSteps = Math.max(2, Math.round(segDist / 22));

      for (let s = 0; s < subSteps; s++) {
        if (i > 0 && s === 0) continue;
        const t = s / subSteps;
        const x = midBridge ? p1.x + (p2.x - p1.x) * t : catmullRom(p0.x, p1.x, p2.x, p3.x, t);
        const z = midBridge ? p1.z + (p2.z - p1.z) * t : catmullRom(p0.z, p1.z, p2.z, p3.z, t);
        const br = findMatchingBridge(route.id, x, z);
        let y: number;
        if (br) {
          const along = ((x - br.startX) * br.dirX + (z - br.startZ) * br.dirZ) / Math.max(1e-4, br.lengthM);
          const clamped = Math.max(0, Math.min(1, along));
          y = br.startY + (br.endY - br.startY) * clamped;
        } else {
          y = Math.max(seaLevelM + 1.1, rawHeightEvaluator(x, z));
        }
        densePts.push({ x, z, y, bridge: br });
      }
    }
    const last = pts[pts.length - 1];
    densePts.push({
      x: last.x,
      z: last.z,
      y: Math.max(seaLevelM + 1.1, rawHeightEvaluator(last.x, last.z)),
      bridge: null,
    });

    // 2-pass longitudinal elevation smoothing (preserves bridge decks & endpoints cleanly)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < densePts.length - 1; i++) {
        if (densePts[i].bridge) continue;
        densePts[i].y =
          densePts[i - 1].y * 0.25 + densePts[i].y * 0.5 + densePts[i + 1].y * 0.25;
      }
    }

    let accumDist = 0;
    const halfWidthM = route.widthM * 0.5;
    for (let i = 0; i < densePts.length - 1; i++) {
      const a = densePts[i];
      const b = densePts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.2) continue;
      const dirX = dx / len;
      const dirZ = dz / len;
      const br = findMatchingBridge(route.id, (a.x + b.x) * 0.5, (a.z + b.z) * 0.5);
      const margin = halfWidthM + route.shoulderM + 10;

      const seg: BakedRoadSegment = {
        routeId: route.id,
        tier: route.tier,
        ax: a.x,
        az: a.z,
        ay: a.y,
        bx: b.x,
        bz: b.z,
        by: b.y,
        lengthM: len,
        halfWidthM,
        shoulderM: route.shoulderM,
        dirX,
        dirZ,
        perpX: -dirZ,
        perpZ: dirX,
        distFromStartM: accumDist,
        isBridge: Boolean(br),
        bridgeId: br?.id ?? null,
        minX: Math.min(a.x, b.x) - margin,
        maxX: Math.max(a.x, b.x) + margin,
        minZ: Math.min(a.z, b.z) - margin,
        maxZ: Math.max(a.z, b.z) + margin,
      };
      _bakedSegments.push(seg);
      accumDist += len;

      const cMinX = posToChunkIdx(seg.minX);
      const cMaxX = posToChunkIdx(seg.maxX);
      const cMinZ = posToChunkIdx(seg.minZ);
      const cMaxZ = posToChunkIdx(seg.maxZ);
      for (let cz = cMinZ; cz <= cMaxZ; cz++) {
        for (let cx = cMinX; cx <= cMaxX; cx++) {
          _chunkRoadBuckets[bucketIndex(cx, cz)].push(seg);
        }
      }
    }
  }

  // 3. Bake Sites (Gas Stations, Houses, Barns, Checkpoints) with level foundation pad heights
  const tmpRoad = createRoadQueryResult();
  for (let i = 0; i < OPENWORLD_SITE_DEFS.length; i++) {
    const def = OPENWORLD_SITE_DEFS[i];
    // For checkpoints sitting directly on a road, match the road elevation exactly
    queryRoadNetwork(def.x, def.z, tmpRoad);
    let groundY: number;
    if (def.kind === 'checkpoint' && tmpRoad.distanceM < 18) {
      groundY = tmpRoad.targetY;
    } else if (def.kind === 'gas_station' && tmpRoad.distanceM < 45) {
      // Grade gas station forecourt smoothly near adjacent road height
      const rawH = rawHeightEvaluator(def.x, def.z);
      groundY = Math.max(seaLevelM + 1.4, rawH * 0.45 + tmpRoad.targetY * 0.55);
    } else {
      groundY = Math.max(seaLevelM + 1.4, rawHeightEvaluator(def.x, def.z));
    }

    const baked: BakedOpenWorldSite = {
      ...def,
      groundY,
    };
    _bakedSites.push(baked);

    const pad = def.padRadiusM * 1.65 + 12;
    const cMinX = posToChunkIdx(def.x - pad);
    const cMaxX = posToChunkIdx(def.x + pad);
    const cMinZ = posToChunkIdx(def.z - pad);
    const cMaxZ = posToChunkIdx(def.z + pad);
    for (let cz = cMinZ; cz <= cMaxZ; cz++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        _chunkSiteBuckets[bucketIndex(cx, cz)].push(baked);
      }
    }
  }

  // 4. Bake Tall Horizon Landmarks (Water Towers & Radio Masts)
  for (let i = 0; i < HORIZON_TOWER_DEFS.length; i++) {
    const def = HORIZON_TOWER_DEFS[i];
    _bakedTowers.push({
      ...def,
      groundY: Math.max(seaLevelM + 1.5, rawHeightEvaluator(def.x, def.z)),
    });
  }
}

export function getBakedRoadSegments(): readonly BakedRoadSegment[] {
  return _bakedSegments;
}

export function getBakedRiverBridges(): readonly BakedRiverBridge[] {
  return _bakedBridges;
}

export function getBakedOpenWorldSites(): readonly BakedOpenWorldSite[] {
  return _bakedSites;
}

export function getBakedHorizonTowers(): readonly BakedHorizonTower[] {
  return _bakedTowers;
}

export function getRoadSegmentsInChunk(cx: number, cz: number): readonly BakedRoadSegment[] {
  if (cx < 0 || cx >= CIV_GRID_CHUNKS || cz < 0 || cz >= CIV_GRID_CHUNKS) return [];
  return _chunkRoadBuckets[bucketIndex(cx, cz)];
}

export function getSitesInChunk(cx: number, cz: number): readonly BakedOpenWorldSite[] {
  if (cx < 0 || cx >= CIV_GRID_CHUNKS || cz < 0 || cz >= CIV_GRID_CHUNKS) return [];
  return _chunkSiteBuckets[bucketIndex(cx, cz)];
}

export function getBridgesInChunk(cx: number, cz: number): readonly BakedRiverBridge[] {
  if (cx < 0 || cx >= CIV_GRID_CHUNKS || cz < 0 || cz >= CIV_GRID_CHUNKS) return [];
  return _chunkBridgeBuckets[bucketIndex(cx, cz)];
}

// ============================================================================
// ZERO-ALLOCATION ROAD, BRIDGE & PAD QUERIES (Hot-path safe)
// ============================================================================

export function queryRoadNetwork(
  x: number,
  z: number,
  out: RoadQueryResult,
): RoadQueryResult {
  out.onRoad = false;
  out.onShoulder = false;
  out.onBridge = false;
  out.tier = 'none';
  out.distanceM = Infinity;
  out.halfWidthM = 0;
  out.shoulderM = 0;
  out.targetY = 0;
  out.dirX = 0;
  out.dirZ = -1;
  out.bridgeId = null;

  const cx = posToChunkIdx(x);
  const cz = posToChunkIdx(z);
  const bucket = _chunkRoadBuckets[bucketIndex(cx, cz)];
  if (bucket.length === 0) return out;

  let bestScore = Infinity;
  let bestDist = Infinity;
  let bestSeg: BakedRoadSegment | null = null;
  let bestT = 0;

  for (let i = 0; i < bucket.length; i++) {
    const seg = bucket[i];
    if (x < seg.minX || x > seg.maxX || z < seg.minZ || z > seg.maxZ) continue;
    const vx = x - seg.ax;
    const vz = z - seg.az;
    let t = (vx * seg.dirX + vz * seg.dirZ) / seg.lengthM;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = seg.ax + seg.dirX * seg.lengthM * t;
    const pz = seg.az + seg.dirZ * seg.lengthM * t;
    const dist = Math.hypot(x - px, z - pz);
    // Normalized score prefers highway over dirt trail right at junctions
    const edgeExcess = dist - seg.halfWidthM;
    const tierBias = seg.tier === 'highway' ? -0.45 : seg.tier === 'fob_spur' ? -0.2 : 0;
    const score = edgeExcess + tierBias;
    if (score < bestScore) {
      bestScore = score;
      bestDist = dist;
      bestSeg = seg;
      bestT = t;
    }
  }

  if (!bestSeg) return out;

  const totalEnvelope = bestSeg.halfWidthM + bestSeg.shoulderM;
  out.distanceM = bestDist;
  out.halfWidthM = bestSeg.halfWidthM;
  out.shoulderM = bestSeg.shoulderM;
  out.targetY = bestSeg.ay + (bestSeg.by - bestSeg.ay) * bestT;
  out.dirX = bestSeg.dirX;
  out.dirZ = bestSeg.dirZ;
  out.tier = bestSeg.tier;
  out.onBridge = bestSeg.isBridge && bestDist <= bestSeg.halfWidthM + 1.2;
  out.bridgeId = bestSeg.bridgeId;
  out.onRoad = bestDist <= bestSeg.halfWidthM;
  out.onShoulder = bestDist <= totalEnvelope;
  return out;
}

export function querySitePad(
  x: number,
  z: number,
  out: SitePadQueryResult,
): SitePadQueryResult {
  out.onPad = false;
  out.blend = 0;
  out.targetY = 0;
  out.siteKind = null;

  const cx = posToChunkIdx(x);
  const cz = posToChunkIdx(z);
  const bucket = _chunkSiteBuckets[bucketIndex(cx, cz)];
  if (bucket.length === 0) return out;

  let bestBlend = 0;
  let bestY = 0;
  let bestKind: OpenWorldSiteKind | null = null;

  for (let i = 0; i < bucket.length; i++) {
    const s = bucket[i];
    const dist = Math.hypot(x - s.x, z - s.z);
    const outer = s.padRadiusM * 1.65;
    if (dist < outer) {
      const blend = 1.0 - smoothstep(s.padRadiusM * 0.62, outer, dist);
      if (blend > bestBlend) {
        bestBlend = blend;
        bestY = s.groundY;
        bestKind = s.kind;
      }
    }
  }

  if (bestBlend > 0) {
    out.onPad = bestBlend > 0.45;
    out.blend = bestBlend;
    out.targetY = bestY;
    out.siteKind = bestKind;
  }
  return out;
}

/**
 * Checks if `(x, z)` lies within any bridge span footprint and returns exact bridge deck Y.
 */
export function queryBridgeDeckHeight(x: number, z: number): {
  onBridge: boolean;
  deckY: number;
  bridge: BakedRiverBridge | null;
} {
  const cx = posToChunkIdx(x);
  const cz = posToChunkIdx(z);
  const bucket = _chunkBridgeBuckets[bucketIndex(cx, cz)];
  for (let i = 0; i < bucket.length; i++) {
    const b = bucket[i];
    const dx = x - b.centerX;
    const dz = z - b.centerZ;
    const along = dx * b.dirX + dz * b.dirZ;
    const across = Math.abs(-dx * b.dirZ + dz * b.dirX);
    if (Math.abs(along) <= b.lengthM * 0.5 + 1.2 && across <= b.widthM * 0.5) {
      const t = Math.max(0, Math.min(1, (along + b.lengthM * 0.5) / b.lengthM));
      return {
        onBridge: true,
        deckY: b.startY + (b.endY - b.startY) * t,
        bridge: b,
      };
    }
  }
  return { onBridge: false, deckY: -9999, bridge: null };
}

const _clearRoadScratch = createRoadQueryResult();
const _clearPadScratch = createSitePadQueryResult();

/**
 * Shared corridor clearance test: prevents trees, boulders, and scrub from spawning
 * on roadways, shoulders, bridge spans, or inside buildings/gas forecourts/checkpoints.
 */
export function isOnCivilizationClearance(x: number, z: number, extraMarginM = 3.2): boolean {
  queryRoadNetwork(x, z, _clearRoadScratch);
  if (
    _clearRoadScratch.tier !== 'none' &&
    _clearRoadScratch.distanceM <= _clearRoadScratch.halfWidthM + _clearRoadScratch.shoulderM + extraMarginM
  ) {
    return true;
  }
  querySitePad(x, z, _clearPadScratch);
  if (_clearPadScratch.blend > 0.12) {
    return true;
  }
  for (let i = 0; i < _bakedTowers.length; i++) {
    const t = _bakedTowers[i];
    if (Math.hypot(x - t.x, z - t.z) < 16 + extraMarginM) return true;
  }
  return false;
}

// ============================================================================
// ZERO-GC OBB CAPSULE SLIDE, RAYCAST, WALK-DECK & INDOOR VOLUME SOLVERS
// ============================================================================

export function sampleWalkDeckHeightFromList(
  decks: readonly WalkDeck[],
  x: number,
  z: number,
  referenceY: number,
): { found: boolean; topY: number; surface: BodycamSurfaceMaterial } {
  let found = false;
  let bestY = -Infinity;
  let bestSurface: BodycamSurfaceMaterial = 'concrete';

  for (let i = 0; i < decks.length; i++) {
    const d = decks[i];
    const dx = x - d.cx;
    const dz = z - d.cz;
    // World -> local (inverse rotation by yaw)
    const lx = dx * d.cosY - dz * d.sinY;
    const lz = dx * d.sinY + dz * d.cosY;
    if (Math.abs(lx) <= d.hx && Math.abs(lz) <= d.hz) {
      const topY = d.baseY + lz * d.slopeAlongZ;
      // Allow stepping onto or walking across decks up to 1.6m above feet (covers bridge ramp transitions)
      if (topY <= referenceY + 1.65 && topY > bestY) {
        bestY = topY;
        bestSurface = d.surface;
        found = true;
      }
    }
  }
  return { found, topY: bestY, surface: bestSurface };
}

export function sampleIndoorVolumeFromList(
  volumes: readonly IndoorVolume[],
  x: number,
  y: number,
  z: number,
): { isIndoor: boolean; material: 'concrete' | 'wood' | 'metal' | 'outdoor' } {
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i];
    if (y < v.minY || y > v.maxY) continue;
    const dx = x - v.cx;
    const dz = z - v.cz;
    const lx = dx * v.cosY - dz * v.sinY;
    const lz = dx * v.sinY + dz * v.cosY;
    if (Math.abs(lx) <= v.hx && Math.abs(lz) <= v.hz) {
      return { isIndoor: true, material: v.material };
    }
  }
  return { isIndoor: false, material: 'outdoor' };
}

/**
 * Resolves a vertical player capsule horizontally against a list of `SolidObb`s (walls, vehicles,
 * fuel pumps, counters, guardrails, bridge parapets) with smooth sliding and doorway pass-through.
 * Zero allocations.
 */
export function resolveCapsuleHorizontalAgainstObbs(
  obbs: readonly SolidObb[],
  posX: number,
  footY: number,
  posZ: number,
  radius: number,
  height: number,
  maxStepUpM: number,
  outPos: { x: number; z: number; hitWall: boolean; wallNormalX: number; wallNormalZ: number },
): void {
  let x = posX;
  let z = posZ;
  let hitWall = false;
  let wallNx = 0;
  let wallNz = 0;

  const capMinY = footY + Math.max(0.18, maxStepUpM);
  const capMaxY = footY + height - 0.08;

  // 2 solver passes handle 90-degree interior room corners cleanly without snagging
  for (let pass = 0; pass < 2; pass++) {
    let movedThisPass = false;
    for (let i = 0; i < obbs.length; i++) {
      const b = obbs[i];
      if (!b.blocksPlayer) continue;
      // Vertical overlap check (skip floor slabs below step-up or lintels above head!)
      const bMinY = b.cy - b.hy;
      const bMaxY = b.cy + b.hy;
      if (bMaxY <= capMinY || bMinY >= capMaxY) continue;

      const dx = x - b.cx;
      const dz = z - b.cz;
      // Transform circle center into OBB local XZ plane (inverse Y rotation)
      const lx = dx * b.cosY - dz * b.sinY;
      const lz = dx * b.sinY + dz * b.cosY;

      // Quick broadphase reject
      if (Math.abs(lx) > b.hx + radius || Math.abs(lz) > b.hz + radius) continue;

      const closestX = Math.max(-b.hx, Math.min(b.hx, lx));
      const closestZ = Math.max(-b.hz, Math.min(b.hz, lz));
      const diffX = lx - closestX;
      const diffZ = lz - closestZ;
      const distSq = diffX * diffX + diffZ * diffZ;

      if (distSq >= radius * radius) continue;

      let pushLocalX = 0;
      let pushLocalZ = 0;
      let nLocalX = 0;
      let nLocalZ = 0;

      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const pen = radius - dist;
        nLocalX = diffX / dist;
        nLocalZ = diffZ / dist;
        pushLocalX = nLocalX * pen;
        pushLocalZ = nLocalZ * pen;
      } else {
        // Center is inside OBB footprint: push out along shallowest local axis
        const penX = b.hx - Math.abs(lx);
        const penZ = b.hz - Math.abs(lz);
        if (penX < penZ) {
          nLocalX = lx >= 0 ? 1 : -1;
          pushLocalX = nLocalX * (penX + radius);
        } else {
          nLocalZ = lz >= 0 ? 1 : -1;
          pushLocalZ = nLocalZ * (penZ + radius);
        }
      }

      // Rotate push & normal back to world XZ
      const pushWx = pushLocalX * b.cosY + pushLocalZ * b.sinY;
      const pushWz = -pushLocalX * b.sinY + pushLocalZ * b.cosY;
      x += pushWx;
      z += pushWz;
      wallNx = nLocalX * b.cosY + nLocalZ * b.sinY;
      wallNz = -nLocalX * b.sinY + nLocalZ * b.cosY;
      hitWall = true;
      movedThisPass = true;
    }
    if (!movedThisPass) break;
  }

  outPos.x = x;
  outPos.z = z;
  outPos.hitWall = hitWall;
  outPos.wallNormalX = wallNx;
  outPos.wallNormalZ = wallNz;
}

/**
 * Checks whether standing up from crouch at `(x, baseY, z)` is clear of low OBB ceilings/lintels.
 */
export function hasOverheadClearanceAgainstObbs(
  obbs: readonly SolidObb[],
  x: number,
  baseY: number,
  z: number,
  radius: number,
  crouchHeight: number,
  standHeight: number,
): boolean {
  const checkMinY = baseY + crouchHeight * 0.7;
  const checkMaxY = baseY + standHeight;
  const r = radius * 0.85;

  for (let i = 0; i < obbs.length; i++) {
    const b = obbs[i];
    if (!b.blocksPlayer) continue;
    const bMinY = b.cy - b.hy;
    const bMaxY = b.cy + b.hy;
    if (bMaxY <= checkMinY || bMinY >= checkMaxY) continue;

    const dx = x - b.cx;
    const dz = z - b.cz;
    const lx = dx * b.cosY - dz * b.sinY;
    const lz = dx * b.sinY + dz * b.cosY;
    if (Math.abs(lx) < b.hx + r && Math.abs(lz) < b.hz + r) {
      return false;
    }
  }
  return true;
}

/**
 * Exact zero-GC Ray-vs-OBB slab intersection test against active chunk solid cover & decks.
 * Updates `outHit` only if a closer valid hit in `[near, outHit.distance)` is found.
 */
export function raycastAgainstObbs(
  obbs: readonly SolidObb[],
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  near: number,
  outHit: ObbRaycastHit,
): boolean {
  let foundCloser = false;

  for (let i = 0; i < obbs.length; i++) {
    const b = obbs[i];
    if (!b.blocksBullets) continue;

    // Transform ray origin & direction into OBB local frame
    const rx = ox - b.cx;
    const ry = oy - b.cy;
    const rz = oz - b.cz;

    const lox = rx * b.cosY - rz * b.sinY;
    const loy = ry;
    const loz = rx * b.sinY + rz * b.cosY;

    const ldx = dx * b.cosY - dz * b.sinY;
    const ldy = dy;
    const ldz = dx * b.sinY + dz * b.cosY;

    let tMin = near;
    let tMax = outHit.distance;
    let hitAxis = -1;
    let hitSign = 1;

    // X slab
    if (Math.abs(ldx) < 1e-8) {
      if (lox < -b.hx || lox > b.hx) continue;
    } else {
      const inv = 1 / ldx;
      let t1 = (-b.hx - lox) * inv;
      let t2 = (b.hx - lox) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        hitAxis = 0;
        hitSign = s;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }

    // Y slab
    if (Math.abs(ldy) < 1e-8) {
      if (loy < -b.hy || loy > b.hy) continue;
    } else {
      const inv = 1 / ldy;
      let t1 = (-b.hy - loy) * inv;
      let t2 = (b.hy - loy) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        hitAxis = 1;
        hitSign = s;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }

    // Z slab
    if (Math.abs(ldz) < 1e-8) {
      if (loz < -b.hz || loz > b.hz) continue;
    } else {
      const inv = 1 / ldz;
      let t1 = (-b.hz - loz) * inv;
      let t2 = (b.hz - loz) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tMin) {
        tMin = t1;
        hitAxis = 2;
        hitSign = s;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }

    if (tMin >= near && tMin < outHit.distance) {
      outHit.hit = true;
      outHit.distance = tMin;
      outHit.pointX = ox + dx * tMin;
      outHit.pointY = oy + dy * tMin;
      outHit.pointZ = oz + dz * tMin;

      // Local normal -> world normal
      if (hitAxis === 0) {
        outHit.normalX = hitSign * b.cosY;
        outHit.normalY = 0;
        outHit.normalZ = -hitSign * b.sinY;
      } else if (hitAxis === 1) {
        outHit.normalX = 0;
        outHit.normalY = hitSign;
        outHit.normalZ = 0;
      } else if (hitAxis === 2) {
        outHit.normalX = hitSign * b.sinY;
        outHit.normalY = 0;
        outHit.normalZ = hitSign * b.cosY;
      } else {
        outHit.normalX = -dx;
        outHit.normalY = -dy;
        outHit.normalZ = -dz;
      }
      outHit.surface = b.surface;
      foundCloser = true;
    }
  }

  return foundCloser;
}

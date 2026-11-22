import { KINO_THEATER_MAP } from './KinoTheaterMap';
import { KORSAKOV_SUBSTATION_MAP } from './KorsakovSubstationMap';
import { PRIPYAT_BLOCK_MAP } from './PripyatBlockMap';
import { TIMBERLINE_COMPOUND_MAP } from './TimberlineCompoundMap';
import { IMapDefinition } from './types';

export const BATTLE_MAPS: readonly IMapDefinition[] = [
  PRIPYAT_BLOCK_MAP,
  TIMBERLINE_COMPOUND_MAP,
  KORSAKOV_SUBSTATION_MAP,
];

/**
 * Extensible Infection Map Registry.
 * Adding Map 2 or Map 3 later is a single entry in this array.
 */
export const ZOMBIE_MAPS: readonly IMapDefinition[] = [
  KINO_THEATER_MAP,
  {
    id: 'stalingrad_depot',
    name: 'Stalingrad Rail Depot',
    subtitle: 'Sector Locked · Coming Soon',
    description:
      'Frozen freight yard, bombed-out locomotive shed, and underground maintenance tunnels.',
    mode: 'infection',
    status: 'coming_soon',
    environmentTags: ['Sector Locked', 'Coming Soon'],
    accentHex: '#991b1b',
    previewStyle: 'locked_depot',
    build: KINO_THEATER_MAP.build,
  },
  {
    id: 'objekt_47',
    name: 'Bunker Objekt-47',
    subtitle: 'Sector Locked · Coming Soon',
    description:
      'Subterranean Cold War bio-containment complex with blast doors and flooded reactor decks.',
    mode: 'infection',
    status: 'coming_soon',
    environmentTags: ['Sector Locked', 'Coming Soon'],
    accentHex: '#991b1b',
    previewStyle: 'locked_bunker',
    build: KINO_THEATER_MAP.build,
  },
];

export const ALL_MAPS: readonly IMapDefinition[] = [...BATTLE_MAPS, ...ZOMBIE_MAPS];

export function getMapDefinitionById(mapId: string): IMapDefinition | undefined {
  return ALL_MAPS.find((m) => m.id === mapId);
}

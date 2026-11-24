import { BUNKER_OBJEKT_47_MAP } from './BunkerObjekt47Map';
import { KINO_THEATER_MAP } from './KinoTheaterMap';
import { KORSAKOV_SUBSTATION_MAP } from './KorsakovSubstationMap';
import { PRIPYAT_BLOCK_MAP } from './PripyatBlockMap';
import { STALINGRAD_DEPOT_MAP } from './StalingradDepotMap';
import { TIMBERLINE_COMPOUND_MAP } from './TimberlineCompoundMap';
import { VOLGA_CORRIDOR_MAP } from './VolgaCorridorMap';
import { IMapDefinition } from './types';

export const BATTLE_MAPS: readonly IMapDefinition[] = [
  PRIPYAT_BLOCK_MAP,
  TIMBERLINE_COMPOUND_MAP,
  KORSAKOV_SUBSTATION_MAP,
  VOLGA_CORRIDOR_MAP,
];

/**
 * Extensible Infection Map Registry.
 * All three Infection maps (Kino Theater, Stalingrad Rail Depot, Bunker Objekt-47) are playable.
 */
export const ZOMBIE_MAPS: readonly IMapDefinition[] = [
  KINO_THEATER_MAP,
  STALINGRAD_DEPOT_MAP,
  BUNKER_OBJEKT_47_MAP,
];

export const ALL_MAPS: readonly IMapDefinition[] = [...BATTLE_MAPS, ...ZOMBIE_MAPS];

export function getMapDefinitionById(mapId: string): IMapDefinition | undefined {
  return ALL_MAPS.find((m) => m.id === mapId);
}

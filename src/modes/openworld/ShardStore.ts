import { useEffect, useState } from 'react';
import {
  DiscreteTransitionType,
  DroppedCorpseEntity,
  FactionSupplyPool,
  OpenWorldStorageLike,
  PmcFactionId,
  resolveDefaultStorage,
  SectorControlOwner,
  SectorControlRecord,
  SHARD_RULES,
  ShardMode,
  ShardWorldState,
} from './types';

export interface DualShardStoreState {
  shards: Record<ShardMode, ShardWorldState>;
}

export interface ShardStoreOptions {
  storage?: OpenWorldStorageLike | null;
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = 'axon_openworld_shards_v1';
const MAX_CORPSES_PER_SHARD = 48;
const MAX_TRANSITION_LOG = 24;

function createInitialSupplyPool(mode: ShardMode, faction: PmcFactionId): FactionSupplyPool {
  if (mode === 'PvPvE') {
    return faction === 'pmc_alpha'
      ? { ammo: 68, medical: 64, fuelParts: 62, intel: 55 }
      : { ammo: 71, medical: 60, fuelParts: 66, intel: 52 };
  }
  return faction === 'pmc_alpha'
    ? { ammo: 78, medical: 80, fuelParts: 74, intel: 70 }
    : { ammo: 76, medical: 78, fuelParts: 75, intel: 68 };
}

function createInitialSectors(mode: ShardMode): Record<string, SectorControlRecord> {
  return {
    landmark_fob_alpha: {
      sectorId: 'landmark_fob_alpha',
      owner: 'pmc_alpha',
      captureProgress: 100,
    },
    landmark_fob_bravo: {
      sectorId: 'landmark_fob_bravo',
      owner: 'pmc_bravo',
      captureProgress: 100,
    },
    landmark_port_terminal: {
      sectorId: 'landmark_port_terminal',
      owner: mode === 'PvE' ? 'pmc_alpha' : 'neutral',
      captureProgress: mode === 'PvE' ? 100 : 0,
    },
    landmark_timberline_railyard: {
      sectorId: 'landmark_timberline_railyard',
      owner: 'neutral',
      captureProgress: 0,
    },
    landmark_steppe_quarry: {
      sectorId: 'landmark_steppe_quarry',
      owner: mode === 'PvE' ? 'pmc_bravo' : 'neutral',
      captureProgress: mode === 'PvE' ? 100 : 0,
    },
    landmark_alpine_dam: {
      sectorId: 'landmark_alpine_dam',
      owner: 'neutral',
      captureProgress: 0,
    },
  };
}

function countTerritories(sectors: Record<string, SectorControlRecord>): {
  pmc_alpha: number;
  pmc_bravo: number;
  neutral: number;
} {
  let pmc_alpha = 0;
  let pmc_bravo = 0;
  let neutral = 0;
  for (const rec of Object.values(sectors)) {
    if (rec.owner === 'pmc_alpha') pmc_alpha++;
    else if (rec.owner === 'pmc_bravo') pmc_bravo++;
    else neutral++;
  }
  return { pmc_alpha, pmc_bravo, neutral };
}

function createInitialShard(mode: ShardMode): ShardWorldState {
  const sectors = createInitialSectors(mode);
  return {
    mode,
    revision: 0,
    pmcSupplyPools: {
      pmc_alpha: createInitialSupplyPool(mode, 'pmc_alpha'),
      pmc_bravo: createInitialSupplyPool(mode, 'pmc_bravo'),
    },
    territoryCounts: countTerritories(sectors),
    sectors,
    corpses: [],
    recentTransitions: [],
  };
}

function cloneShard(s: ShardWorldState): ShardWorldState {
  const clonedSectors: Record<string, SectorControlRecord> = {};
  for (const [k, v] of Object.entries(s.sectors)) {
    clonedSectors[k] = { ...v };
  }
  return {
    mode: s.mode,
    revision: s.revision,
    pmcSupplyPools: {
      pmc_alpha: { ...s.pmcSupplyPools.pmc_alpha },
      pmc_bravo: { ...s.pmcSupplyPools.pmc_bravo },
    },
    territoryCounts: { ...s.territoryCounts },
    sectors: clonedSectors,
    corpses: s.corpses.map((c) => ({
      ...c,
      droppedWeaponIds: [...c.droppedWeaponIds],
      droppedItems: c.droppedItems.map((it) => ({ ...it })),
    })),
    recentTransitions: s.recentTransitions.map((t) => ({ ...t })),
  };
}

type ShardStoreListener = (state: DualShardStoreState) => void;

/**
 * Isolated Dual-Shard Persistent World State (`PvPvE` vs `PvE`).
 * Strictly isolates territory control, PMC supply pools, and full-drop corpse entities
 * between shards. Persists ONLY on discrete state transitions (D1-ready).
 */
export class ShardStore {
  private state: DualShardStoreState;
  private readonly listeners = new Set<ShardStoreListener>();
  private readonly customStorage?: OpenWorldStorageLike | null;
  private readonly storageKey: string;
  private memoryRaw: string | null = null;

  constructor(options?: ShardStoreOptions) {
    this.customStorage = options?.storage;
    this.storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY;
    this.state = this.load();
  }

  private getStorage(): OpenWorldStorageLike | null {
    if (this.customStorage !== undefined) return this.customStorage;
    return resolveDefaultStorage();
  }

  private load(): DualShardStoreState {
    const fallback: DualShardStoreState = {
      shards: {
        PvPvE: createInitialShard('PvPvE'),
        PvE: createInitialShard('PvE'),
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
    if (!raw) return fallback;

    try {
      const parsed = JSON.parse(raw) as Partial<DualShardStoreState>;
      const parseOne = (mode: ShardMode): ShardWorldState => {
        const def = createInitialShard(mode);
        const src = parsed.shards?.[mode];
        if (!src || typeof src !== 'object') return def;
        return {
          mode,
          revision:
            typeof src.revision === 'number' && Number.isFinite(src.revision)
              ? Math.max(0, Math.floor(src.revision))
              : 0,
          pmcSupplyPools: {
            pmc_alpha: {
              ammo: clampPct(src.pmcSupplyPools?.pmc_alpha?.ammo, def.pmcSupplyPools.pmc_alpha.ammo),
              medical: clampPct(src.pmcSupplyPools?.pmc_alpha?.medical, def.pmcSupplyPools.pmc_alpha.medical),
              fuelParts: clampPct(src.pmcSupplyPools?.pmc_alpha?.fuelParts, def.pmcSupplyPools.pmc_alpha.fuelParts),
              intel: clampPct(src.pmcSupplyPools?.pmc_alpha?.intel, def.pmcSupplyPools.pmc_alpha.intel),
            },
            pmc_bravo: {
              ammo: clampPct(src.pmcSupplyPools?.pmc_bravo?.ammo, def.pmcSupplyPools.pmc_bravo.ammo),
              medical: clampPct(src.pmcSupplyPools?.pmc_bravo?.medical, def.pmcSupplyPools.pmc_bravo.medical),
              fuelParts: clampPct(src.pmcSupplyPools?.pmc_bravo?.fuelParts, def.pmcSupplyPools.pmc_bravo.fuelParts),
              intel: clampPct(src.pmcSupplyPools?.pmc_bravo?.intel, def.pmcSupplyPools.pmc_bravo.intel),
            },
          },
          ...(() => {
            const mergedSectors: Record<string, SectorControlRecord> = { ...def.sectors };
            if (src.sectors && typeof src.sectors === 'object') {
              for (const [secId, rec] of Object.entries(src.sectors)) {
                if (rec && typeof rec === 'object') {
                  const owner: SectorControlOwner =
                    rec.owner === 'pmc_alpha' || rec.owner === 'pmc_bravo' ? rec.owner : 'neutral';
                  mergedSectors[secId] = {
                    sectorId: secId,
                    owner,
                    captureProgress: clampPct(rec.captureProgress, owner === 'neutral' ? 0 : 100),
                    lastFlippedAtIso: typeof rec.lastFlippedAtIso === 'string' ? rec.lastFlippedAtIso : undefined,
                  };
                }
              }
            }
            return {
              sectors: mergedSectors,
              territoryCounts: countTerritories(mergedSectors),
            };
          })(),
          corpses: Array.isArray(src.corpses)
            ? src.corpses.slice(0, MAX_CORPSES_PER_SHARD).map((c) => ({
                ...c,
                shardMode: mode,
                lootableByOtherPlayers: SHARD_RULES[mode].corpseLootingPlayers,
                droppedWeaponIds: Array.isArray(c.droppedWeaponIds) ? [...c.droppedWeaponIds] : [],
                droppedItems: Array.isArray(c.droppedItems) ? c.droppedItems.map((it) => ({ ...it })) : [],
              }))
            : [],
          recentTransitions: Array.isArray(src.recentTransitions)
            ? src.recentTransitions.slice(0, MAX_TRANSITION_LOG).map((t) => ({ ...t }))
            : [],
        };
      };
      return {
        shards: {
          PvPvE: parseOne('PvPvE'),
          PvE: parseOne('PvE'),
        },
      };
    } catch {
      return fallback;
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
        // Storage quota fallback retained in memory
      }
    }
    const snap = this.getState();
    for (const fn of this.listeners) fn(snap);
  }

  public getState(): DualShardStoreState {
    return {
      shards: {
        PvPvE: cloneShard(this.state.shards.PvPvE),
        PvE: cloneShard(this.state.shards.PvE),
      },
    };
  }

  public getShard(mode: ShardMode): ShardWorldState {
    return cloneShard(this.state.shards[mode]);
  }

  public getRules(mode: ShardMode) {
    return SHARD_RULES[mode];
  }

  /**
   * Discrete state transition write: records a persistent lootable corpse inside ONLY the target shard.
   */
  public addDroppedCorpse(
    mode: ShardMode,
    corpse: Omit<DroppedCorpseEntity, 'shardMode' | 'lootableByOtherPlayers'>,
    transitionType: DiscreteTransitionType = 'death',
  ): DroppedCorpseEntity {
    const rules = SHARD_RULES[mode];
    const entity: DroppedCorpseEntity = {
      ...corpse,
      shardMode: mode,
      lootableByOtherPlayers: rules.corpseLootingPlayers,
      droppedWeaponIds: [...corpse.droppedWeaponIds],
      droppedItems: corpse.droppedItems.map((it) => ({ ...it })),
    };

    const shard = this.state.shards[mode];
    const nextRev = shard.revision + 1;
    const nextCorpses = [entity, ...shard.corpses].slice(0, MAX_CORPSES_PER_SHARD);
    const nextLog = [
      {
        revision: nextRev,
        type: transitionType,
        timestampIso: entity.createdAtIso,
        summary: `${entity.ownerCallsign} dropped ${entity.droppedWeaponIds.length} weapon(s) & ${entity.droppedItems.length} item(s) at ${entity.sectorLabel}`,
      },
      ...shard.recentTransitions,
    ].slice(0, MAX_TRANSITION_LOG);

    this.state = {
      shards: {
        ...this.state.shards,
        [mode]: {
          ...shard,
          revision: nextRev,
          corpses: nextCorpses,
          recentTransitions: nextLog,
        },
      },
    };
    this.persistAndEmit();
    return {
      ...entity,
      droppedWeaponIds: [...entity.droppedWeaponIds],
      droppedItems: entity.droppedItems.map((it) => ({ ...it })),
    };
  }

  /**
   * Discrete state transition write: checks if an observer character can loot a specific corpse
   * under the active shard's PvPvE / PvE rules.
   */
  public canCharacterLootCorpse(
    mode: ShardMode,
    corpseId: string,
    looterCharacterId: string,
  ): boolean {
    const corpse = this.state.shards[mode].corpses.find((c) => c.corpseId === corpseId);
    if (!corpse) return false;
    if (corpse.ownerCharacterId === looterCharacterId) return true;
    return SHARD_RULES[mode].corpseLootingPlayers;
  }

  /**
   * Discrete state transition write: claims/loots a persistent corpse if permitted by shard rules.
   */
  public lootAndRemoveCorpse(
    mode: ShardMode,
    corpseId: string,
    looterCharacterId: string,
    looterCallsign: string,
  ): { ok: boolean; error?: string; corpse?: DroppedCorpseEntity } {
    const shard = this.state.shards[mode];
    const target = shard.corpses.find((c) => c.corpseId === corpseId);
    if (!target) return { ok: false, error: 'Corpse no longer exists in this shard.' };
    if (!this.canCharacterLootCorpse(mode, corpseId, looterCharacterId)) {
      return {
        ok: false,
        error: 'PvE Cooperative Shard rules prevent looting another player\'s corpse.',
      };
    }
    const nextRev = shard.revision + 1;
    const nextCorpses = shard.corpses.filter((c) => c.corpseId !== corpseId);
    this.state = {
      shards: {
        ...this.state.shards,
        [mode]: {
          ...shard,
          revision: nextRev,
          corpses: nextCorpses,
          recentTransitions: [
            {
              revision: nextRev,
              type: 'stash_update',
              timestampIso: new Date().toISOString(),
              summary: `${looterCallsign} recovered gear from ${target.ownerCallsign}'s corpse at ${target.sectorLabel}`,
            },
            ...shard.recentTransitions,
          ].slice(0, MAX_TRANSITION_LOG),
        },
      },
    };
    this.persistAndEmit();
    return {
      ok: true,
      corpse: {
        ...target,
        droppedWeaponIds: [...target.droppedWeaponIds],
        droppedItems: target.droppedItems.map((it) => ({ ...it })),
      },
    };
  }

  /**
   * Discrete state transition write: flips ownership of a strategic sector in ONE shard,
   * recalculates territory counts, and awards supply pool deltas to the capturing PMC.
   */
  public flipSector(
    mode: ShardMode,
    sectorId: string,
    newOwner: SectorControlOwner,
    actorCallsign: string,
    sectorLabel: string,
    supplyBonus?: Partial<FactionSupplyPool>,
  ): { changed: boolean; previousOwner: SectorControlOwner; sector: SectorControlRecord } {
    const shard = this.state.shards[mode];
    const prev = shard.sectors[sectorId] ?? {
      sectorId,
      owner: 'neutral' as SectorControlOwner,
      captureProgress: 0,
    };
    const previousOwner = prev.owner;
    const nowIso = new Date().toISOString();
    const updatedRecord: SectorControlRecord = {
      sectorId,
      owner: newOwner,
      captureProgress: newOwner === 'neutral' ? 0 : 100,
      lastFlippedAtIso: nowIso,
    };
    const nextSectors: Record<string, SectorControlRecord> = {
      ...shard.sectors,
      [sectorId]: updatedRecord,
    };
    const nextCounts = countTerritories(nextSectors);
    const nextPools = {
      pmc_alpha: { ...shard.pmcSupplyPools.pmc_alpha },
      pmc_bravo: { ...shard.pmcSupplyPools.pmc_bravo },
    };
    if (newOwner !== 'neutral' && supplyBonus) {
      const p = nextPools[newOwner];
      nextPools[newOwner] = {
        ammo: clampPct(p.ammo + (supplyBonus.ammo ?? 0), p.ammo),
        medical: clampPct(p.medical + (supplyBonus.medical ?? 0), p.medical),
        fuelParts: clampPct(p.fuelParts + (supplyBonus.fuelParts ?? 0), p.fuelParts),
        intel: clampPct(p.intel + (supplyBonus.intel ?? 0), p.intel),
      };
    }

    const nextRev = shard.revision + 1;
    const ownerLabel =
      newOwner === 'pmc_alpha'
        ? 'PMC Alpha'
        : newOwner === 'pmc_bravo'
          ? 'PMC Bravo'
          : 'Neutral';

    this.state = {
      shards: {
        ...this.state.shards,
        [mode]: {
          ...shard,
          revision: nextRev,
          sectors: nextSectors,
          territoryCounts: nextCounts,
          pmcSupplyPools: nextPools,
          recentTransitions: [
            {
              revision: nextRev,
              type: 'sector_flip',
              timestampIso: nowIso,
              summary: `${actorCallsign} flipped ${sectorLabel} to ${ownerLabel}`,
            },
            ...shard.recentTransitions,
          ].slice(0, MAX_TRANSITION_LOG),
        },
      },
    };
    this.persistAndEmit();
    return {
      changed: previousOwner !== newOwner,
      previousOwner,
      sector: { ...updatedRecord },
    };
  }

  /**
   * Discrete state transition write: adjusts a PMC's supply pool in ONE shard without touching the other.
   */
  public adjustPmcSupply(
    mode: ShardMode,
    faction: PmcFactionId,
    delta: Partial<FactionSupplyPool>,
    transitionType: DiscreteTransitionType,
    summary: string,
  ): FactionSupplyPool {
    const shard = this.state.shards[mode];
    const prev = shard.pmcSupplyPools[faction];
    const nextPool: FactionSupplyPool = {
      ammo: clampPct(prev.ammo + (delta.ammo ?? 0), prev.ammo),
      medical: clampPct(prev.medical + (delta.medical ?? 0), prev.medical),
      fuelParts: clampPct(prev.fuelParts + (delta.fuelParts ?? 0), prev.fuelParts),
      intel: clampPct(prev.intel + (delta.intel ?? 0), prev.intel),
    };
    const nextRev = shard.revision + 1;
    this.state = {
      shards: {
        ...this.state.shards,
        [mode]: {
          ...shard,
          revision: nextRev,
          pmcSupplyPools: {
            ...shard.pmcSupplyPools,
            [faction]: nextPool,
          },
          recentTransitions: [
            {
              revision: nextRev,
              type: transitionType,
              timestampIso: new Date().toISOString(),
              summary,
            },
            ...shard.recentTransitions,
          ].slice(0, MAX_TRANSITION_LOG),
        },
      },
    };
    this.persistAndEmit();
    return { ...nextPool };
  }

  /**
   * Discrete state transition log for Exfil, Field Hospital Respawn, Permadeath Wipe, Trader Purchase, etc.
   */
  public recordDiscreteTransition(
    mode: ShardMode,
    type: DiscreteTransitionType,
    summary: string,
  ): void {
    const shard = this.state.shards[mode];
    const nextRev = shard.revision + 1;
    this.state = {
      shards: {
        ...this.state.shards,
        [mode]: {
          ...shard,
          revision: nextRev,
          recentTransitions: [
            {
              revision: nextRev,
              type,
              timestampIso: new Date().toISOString(),
              summary,
            },
            ...shard.recentTransitions,
          ].slice(0, MAX_TRANSITION_LOG),
        },
      },
    };
    this.persistAndEmit();
  }

  public getAveragePmcSupplyPct(mode: ShardMode, faction: PmcFactionId): number {
    const p = this.state.shards[mode].pmcSupplyPools[faction];
    return Math.round((p.ammo + p.medical + p.fuelParts + p.intel) / 4);
  }

  public subscribe(fn: ShardStoreListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

function clampPct(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export const shardStore = new ShardStore();

export function useShardStore(store: ShardStore = shardStore): DualShardStoreState {
  const [state, setState] = useState<DualShardStoreState>(() => store.getState());
  useEffect(() => {
    setState(store.getState());
    return store.subscribe((next) => setState(next));
  }, [store]);
  return state;
}

import { useEffect, useState } from 'react';
import {
  DEFAULT_OPERATOR_GEAR,
  DEFAULT_OPERATOR_ID,
  isOperatorId,
  normalizeOperatorGearConfig,
  normalizeOperatorId,
  OPERATOR_GEAR_STORAGE_KEY,
  OPERATOR_STORAGE_KEY,
  OperatorGearConfig,
  OperatorId,
} from './OperatorTypes';

type OperatorListener = (operatorId: OperatorId) => void;
type OperatorGearListener = (gear: OperatorGearConfig) => void;

export interface OperatorStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface OperatorStoreOptions {
  storage?: OperatorStorageLike | null;
  search?: string | null;
}

function parseOperatorQueryOverride(searchStr?: string | null): OperatorId | null {
  const rawSearch =
    searchStr !== undefined
      ? searchStr
      : typeof window !== 'undefined' && window.location
        ? window.location.search
        : '';
  if (!rawSearch) return null;
  try {
    const params = new URLSearchParams(rawSearch);
    const val = params.get('operator');
    if (!val) return null;
    const upper = val.trim().toUpperCase();
    return isOperatorId(upper) ? upper : null;
  } catch {
    return null;
  }
}

function resolveDefaultStorage(): OperatorStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Persistent Operator Selection & Tactical Gear Store.
 * - Persists operator gender under versioned key `bfps.operator.v1`
 * - Persists uniform, gloves, helmet & NVG mount under `bfps.operator.gear.v1`
 * - Falls back cleanly to in-memory storage if browser storage is blocked
 * - Sanitizes corrupted/unknown values back to safe defaults
 * - Supports deterministic top-precedence URL query override `?operator=male|female`
 */
export class OperatorSelectionStore {
  private selectedId: OperatorId = DEFAULT_OPERATOR_ID;
  private gearConfig: OperatorGearConfig = { ...DEFAULT_OPERATOR_GEAR };
  private memoryValue: string | null = null;
  private memoryGearValue: string | null = null;
  private readonly listeners = new Set<OperatorListener>();
  private readonly gearListeners = new Set<OperatorGearListener>();
  private readonly customStorage?: OperatorStorageLike | null;
  private readonly customSearch?: string | null;

  constructor(options?: OperatorStoreOptions) {
    this.customStorage = options?.storage;
    this.customSearch = options?.search;
    this.selectedId = this.hydrate();
    this.gearConfig = this.hydrateGear();
  }

  private getStorage(): OperatorStorageLike | null {
    if (this.customStorage !== undefined) return this.customStorage;
    return resolveDefaultStorage();
  }

  private readRaw(): string | null {
    const storage = this.getStorage();
    if (storage) {
      try {
        return storage.getItem(OPERATOR_STORAGE_KEY);
      } catch {
        return this.memoryValue;
      }
    }
    return this.memoryValue;
  }

  private writeRaw(value: OperatorId): void {
    this.memoryValue = value;
    const storage = this.getStorage();
    if (storage) {
      try {
        storage.setItem(OPERATOR_STORAGE_KEY, value);
      } catch {
        // Storage unavailable/quota exceeded — in-memory fallback stays active
      }
    }
  }

  private readGearRaw(): string | null {
    const storage = this.getStorage();
    if (storage) {
      try {
        return storage.getItem(OPERATOR_GEAR_STORAGE_KEY);
      } catch {
        return this.memoryGearValue;
      }
    }
    return this.memoryGearValue;
  }

  private writeGearRaw(cfg: OperatorGearConfig): void {
    const encoded = JSON.stringify(cfg);
    this.memoryGearValue = encoded;
    const storage = this.getStorage();
    if (storage) {
      try {
        storage.setItem(OPERATOR_GEAR_STORAGE_KEY, encoded);
      } catch {
        // Storage unavailable/quota exceeded
      }
    }
  }

  public getUrlOverride(): OperatorId | null {
    return parseOperatorQueryOverride(this.customSearch);
  }

  public hydrate(): OperatorId {
    const override = this.getUrlOverride();
    if (override) {
      return override;
    }

    const raw = this.readRaw();
    if (raw === null) {
      return DEFAULT_OPERATOR_ID;
    }

    const trimmed = raw.trim().toUpperCase();
    if (isOperatorId(trimmed)) {
      if (trimmed !== raw) {
        this.writeRaw(trimmed);
      }
      return trimmed;
    }

    // Sanitize corrupted value back to DEFAULT_OPERATOR_ID ('MALE')
    this.writeRaw(DEFAULT_OPERATOR_ID);
    return DEFAULT_OPERATOR_ID;
  }

  public hydrateGear(): OperatorGearConfig {
    const raw = this.readGearRaw();
    if (!raw) return { ...DEFAULT_OPERATOR_GEAR };
    try {
      const parsed = JSON.parse(raw);
      return normalizeOperatorGearConfig(parsed);
    } catch {
      return { ...DEFAULT_OPERATOR_GEAR };
    }
  }

  public getSelectedOperator(): OperatorId {
    const override = this.getUrlOverride();
    if (override) {
      return override;
    }
    return this.selectedId;
  }

  public setSelectedOperator(next: OperatorId): OperatorId {
    const normalized = normalizeOperatorId(next);
    this.selectedId = normalized;
    this.writeRaw(normalized);
    const effective = this.getSelectedOperator();
    this.listeners.forEach((fn) => fn(effective));
    return effective;
  }

  public getGearConfig(): OperatorGearConfig {
    return { ...this.gearConfig };
  }

  public setGearConfig(patch: Partial<OperatorGearConfig>): OperatorGearConfig {
    const merged = normalizeOperatorGearConfig({
      ...this.gearConfig,
      ...patch,
    });
    this.gearConfig = merged;
    this.writeGearRaw(merged);
    const snap = { ...merged };
    this.gearListeners.forEach((fn) => fn(snap));
    return snap;
  }

  public subscribe(listener: OperatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeGear(listener: OperatorGearListener): () => void {
    this.gearListeners.add(listener);
    return () => {
      this.gearListeners.delete(listener);
    };
  }
}

export const operatorSelectionStore = new OperatorSelectionStore();

export function useOperatorSelection(
  store: OperatorSelectionStore = operatorSelectionStore,
): readonly [OperatorId, (next: OperatorId) => void, OperatorId | null] {
  const [operatorId, setOperatorId] = useState<OperatorId>(() => store.getSelectedOperator());
  const urlOverride = store.getUrlOverride();

  useEffect(() => {
    setOperatorId(store.getSelectedOperator());
    return store.subscribe((next) => setOperatorId(next));
  }, [store]);

  const setSelected = (next: OperatorId): void => {
    store.setSelectedOperator(next);
  };

  return [operatorId, setSelected, urlOverride] as const;
}

export function useOperatorGearConfig(
  store: OperatorSelectionStore = operatorSelectionStore,
): readonly [OperatorGearConfig, (patch: Partial<OperatorGearConfig>) => void] {
  const [gear, setGear] = useState<OperatorGearConfig>(() => store.getGearConfig());

  useEffect(() => {
    setGear(store.getGearConfig());
    return store.subscribeGear((next) => setGear(next));
  }, [store]);

  const updateGear = (patch: Partial<OperatorGearConfig>): void => {
    store.setGearConfig(patch);
  };

  return [gear, updateGear] as const;
}

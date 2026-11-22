import { useEffect, useState } from 'react';
import {
  DEFAULT_TACTICAL_BELT_SLOT,
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  normalizeTacticalBeltSlot,
  normalizeTacticalEquipmentId,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../../data/tacticalEquipment';

export const TACTICAL_EQUIPMENT_STORAGE_KEY = 'bfps.tactical_equipment.v1';

export interface TacticalEquipmentSelection {
  equipmentId: TacticalEquipmentId;
  beltSlot: TacticalBeltSlot;
  mountOnBelt: boolean;
}

type TacticalEquipmentListener = (selection: TacticalEquipmentSelection) => void;

export interface TacticalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveDefaultStorage(): TacticalStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_SELECTION: TacticalEquipmentSelection = {
  equipmentId: DEFAULT_TACTICAL_EQUIPMENT_ID,
  beltSlot: DEFAULT_TACTICAL_BELT_SLOT,
  mountOnBelt: true,
};

/**
 * Persistent cross-mode Tactical Equipment & Belt Assignment Store.
 * Synchronizes the equipped grenade / utility item and its 3D belt mount slot
 * across Main Menu Loadouts, Multiplayer Lobbies, Playground/GymTunerPanel,
 * Combat Sessions, and the 3D Operator Preview.
 */
export class TacticalEquipmentStore {
  private selection: TacticalEquipmentSelection = { ...DEFAULT_SELECTION };
  private memoryRaw: string | null = null;
  private readonly listeners = new Set<TacticalEquipmentListener>();
  private readonly customStorage?: TacticalStorageLike | null;

  constructor(storage?: TacticalStorageLike | null) {
    this.customStorage = storage;
    this.selection = this.hydrate();
  }

  private getStorage(): TacticalStorageLike | null {
    if (this.customStorage !== undefined) return this.customStorage;
    return resolveDefaultStorage();
  }

  private readRaw(): string | null {
    const storage = this.getStorage();
    if (storage) {
      try {
        return storage.getItem(TACTICAL_EQUIPMENT_STORAGE_KEY);
      } catch {
        return this.memoryRaw;
      }
    }
    return this.memoryRaw;
  }

  private writeSelection(next: TacticalEquipmentSelection): void {
    const serialized = JSON.stringify(next);
    this.memoryRaw = serialized;
    const storage = this.getStorage();
    if (storage) {
      try {
        storage.setItem(TACTICAL_EQUIPMENT_STORAGE_KEY, serialized);
      } catch {
        // Storage unavailable / quota exceeded — keep in-memory state
      }
    }
  }

  public hydrate(): TacticalEquipmentSelection {
    const raw = this.readRaw();
    if (!raw) return { ...DEFAULT_SELECTION };
    try {
      const parsed = JSON.parse(raw) as Partial<TacticalEquipmentSelection>;
      return {
        equipmentId: normalizeTacticalEquipmentId(parsed.equipmentId),
        beltSlot: normalizeTacticalBeltSlot(parsed.beltSlot),
        mountOnBelt: typeof parsed.mountOnBelt === 'boolean' ? parsed.mountOnBelt : true,
      };
    } catch {
      return { ...DEFAULT_SELECTION };
    }
  }

  public getSelection(): TacticalEquipmentSelection {
    return { ...this.selection };
  }

  public setEquipment(equipmentId: TacticalEquipmentId): TacticalEquipmentSelection {
    const normalized = normalizeTacticalEquipmentId(equipmentId);
    if (this.selection.equipmentId === normalized) return this.getSelection();
    this.selection = { ...this.selection, equipmentId: normalized };
    this.writeSelection(this.selection);
    this.emit();
    return this.getSelection();
  }

  public setBeltSlot(beltSlot: TacticalBeltSlot): TacticalEquipmentSelection {
    const normalized = normalizeTacticalBeltSlot(beltSlot);
    if (this.selection.beltSlot === normalized) return this.getSelection();
    this.selection = { ...this.selection, beltSlot: normalized };
    this.writeSelection(this.selection);
    this.emit();
    return this.getSelection();
  }

  public setMountOnBelt(mountOnBelt: boolean): TacticalEquipmentSelection {
    const nextBool = Boolean(mountOnBelt);
    if (this.selection.mountOnBelt === nextBool) return this.getSelection();
    this.selection = { ...this.selection, mountOnBelt: nextBool };
    this.writeSelection(this.selection);
    this.emit();
    return this.getSelection();
  }

  public update(patch: Partial<TacticalEquipmentSelection>): TacticalEquipmentSelection {
    const next: TacticalEquipmentSelection = {
      equipmentId:
        patch.equipmentId !== undefined
          ? normalizeTacticalEquipmentId(patch.equipmentId)
          : this.selection.equipmentId,
      beltSlot:
        patch.beltSlot !== undefined
          ? normalizeTacticalBeltSlot(patch.beltSlot)
          : this.selection.beltSlot,
      mountOnBelt:
        patch.mountOnBelt !== undefined
          ? Boolean(patch.mountOnBelt)
          : this.selection.mountOnBelt,
    };
    if (
      next.equipmentId === this.selection.equipmentId &&
      next.beltSlot === this.selection.beltSlot &&
      next.mountOnBelt === this.selection.mountOnBelt
    ) {
      return this.getSelection();
    }
    this.selection = next;
    this.writeSelection(this.selection);
    this.emit();
    return this.getSelection();
  }

  public subscribe(listener: TacticalEquipmentListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSelection();
    this.listeners.forEach((fn) => fn(snap));
  }
}

export const tacticalEquipmentStore = new TacticalEquipmentStore();

export function useTacticalEquipmentSelection(
  store: TacticalEquipmentStore = tacticalEquipmentStore,
): {
  selection: TacticalEquipmentSelection;
  setEquipment: (id: TacticalEquipmentId) => void;
  setBeltSlot: (slot: TacticalBeltSlot) => void;
  setMountOnBelt: (visible: boolean) => void;
} {
  const [selection, setSelection] = useState<TacticalEquipmentSelection>(() =>
    store.getSelection(),
  );

  useEffect(() => {
    setSelection(store.getSelection());
    return store.subscribe((next) => setSelection(next));
  }, [store]);

  return {
    selection,
    setEquipment: (id: TacticalEquipmentId) => {
      store.setEquipment(id);
    },
    setBeltSlot: (slot: TacticalBeltSlot) => {
      store.setBeltSlot(slot);
    },
    setMountOnBelt: (visible: boolean) => {
      store.setMountOnBelt(visible);
    },
  };
}

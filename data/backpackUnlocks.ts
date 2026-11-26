import { useEffect, useState } from 'react';
import {
  BACKPACK_TEMPLATES,
  BackpackTemplate,
  getBackpackTemplate,
  isBackpackTemplateId,
} from '../src/modes/openworld/inventory/TetrisInventoryCore';
import type { BackpackTemplateId } from '../src/modes/openworld/inventory/TetrisInventoryTypes';

export const BACKPACK_UNLOCK_RANK: Readonly<Record<BackpackTemplateId, number>> = {
  pack_assault_20l: 10,
  pack_rucksack_35l: 20,
  pack_logistics_55l: 30,
};

export interface BackpackUnlockToast {
  readonly id: string;
  readonly templateId: BackpackTemplateId;
  readonly name: string;
  readonly source: 'world_pickup' | 'rank_up';
  readonly createdAt: number;
}

export interface BackpackUnlockSnapshot {
  readonly discoveredIds: readonly BackpackTemplateId[];
  readonly activeToast: BackpackUnlockToast | null;
}

const STORAGE_PREFIX = 'axon_backpack_discoveries_v1';

class BackpackUnlockStore {
  private activeUserKey = 'guest';
  private discovered = new Set<BackpackTemplateId>();
  private activeToast: BackpackUnlockToast | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(snap: BackpackUnlockSnapshot) => void>();

  constructor() {
    this.loadForKey('guest');
  }

  private storageKey(userKey: string): string {
    return `${STORAGE_PREFIX}:${userKey}`;
  }

  private loadForKey(userKey: string): void {
    this.activeUserKey = userKey || 'guest';
    this.discovered.clear();
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      const raw = window.localStorage.getItem(this.storageKey(this.activeUserKey));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isBackpackTemplateId(item)) {
            this.discovered.add(item);
          }
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }

  private persist(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      window.localStorage.setItem(
        this.storageKey(this.activeUserKey),
        JSON.stringify(Array.from(this.discovered)),
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      fn(snap);
    }
  }

  public setActiveUser(userId: string | null | undefined): void {
    const nextKey = userId && userId.trim() ? userId.trim() : 'guest';
    if (nextKey === this.activeUserKey) return;
    this.loadForKey(nextKey);
    this.emit();
  }

  public getSnapshot(): BackpackUnlockSnapshot {
    return {
      discoveredIds: Array.from(this.discovered),
      activeToast: this.activeToast,
    };
  }

  public getRequiredRank(templateId: BackpackTemplateId): number {
    return BACKPACK_UNLOCK_RANK[templateId] ?? 10;
  }

  public isUnlocked(templateId: BackpackTemplateId, careerRank: number): boolean {
    const cleanRank = Math.max(1, Math.floor(careerRank || 1));
    if (cleanRank >= this.getRequiredRank(templateId)) return true;
    return this.discovered.has(templateId);
  }

  public isDiscoveredInWorld(templateId: BackpackTemplateId): boolean {
    return this.discovered.has(templateId);
  }

  public getUnlockedTemplates(careerRank: number): BackpackTemplate[] {
    return BACKPACK_TEMPLATES.filter((t) => this.isUnlocked(t.templateId, careerRank));
  }

  /**
   * Permanently unlocks a backpack tier when found and picked up in the world.
   * Practice rack preview packs (e.g. Hideout/Playground test props) do not grant permanent unlocks.
   * Returns true if this call newly unlocked the backpack.
   */
  public unlockByWorldPickup(
    templateId: string,
    options?: { isPracticeGear?: boolean; currentRank?: number },
  ): boolean {
    if (!isBackpackTemplateId(templateId)) return false;
    if (options?.isPracticeGear) return false;
    const rank = options?.currentRank ?? 1;
    const alreadyUnlocked = this.isUnlocked(templateId, rank);
    if (!this.discovered.has(templateId)) {
      this.discovered.add(templateId);
      this.persist();
    }
    if (!alreadyUnlocked) {
      const tpl = getBackpackTemplate(templateId);
      this.pushToast({
        id: `bp_unlock_${templateId}_${Date.now()}`,
        templateId,
        name: tpl?.name ?? templateId,
        source: 'world_pickup',
        createdAt: Date.now(),
      });
      return true;
    }
    this.emit();
    return false;
  }

  public notifyRankUnlock(templateId: BackpackTemplateId): void {
    const tpl = getBackpackTemplate(templateId);
    this.pushToast({
      id: `bp_rank_${templateId}_${Date.now()}`,
      templateId,
      name: tpl?.name ?? templateId,
      source: 'rank_up',
      createdAt: Date.now(),
    });
  }

  public dismissToast(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.activeToast = null;
    this.emit();
  }

  public resetDiscoveriesForTests(): void {
    this.discovered.clear();
    this.activeToast = null;
    this.persist();
    this.emit();
  }

  private pushToast(toast: BackpackUnlockToast): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.activeToast = toast;
    this.emit();
    if (typeof window !== 'undefined') {
      this.toastTimer = setTimeout(() => {
        this.activeToast = null;
        this.toastTimer = null;
        this.emit();
      }, 5200);
    }
  }

  public subscribe(fn: (snap: BackpackUnlockSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const backpackUnlockStore = new BackpackUnlockStore();

export function useBackpackUnlocks(): BackpackUnlockSnapshot {
  const [snap, setSnap] = useState<BackpackUnlockSnapshot>(() =>
    backpackUnlockStore.getSnapshot(),
  );
  useEffect(() => {
    return backpackUnlockStore.subscribe(setSnap);
  }, []);
  return snap;
}

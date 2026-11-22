import { normalizeWeaponAttachments, WeaponAttachments } from '../../data/attachments';
import { SaveSlotData, SaveSlotMeta } from '../types';

const DB_NAME = 'cordon04_saves_db';
const DB_VERSION = 1;
const STORE_NAME = 'saves';
const GYM_LOADOUT_STORAGE_KEY = 'axon_gunsmith_loadout_v1';
const INFECTION_RECORDS_STORAGE_KEY = 'axon_infection_records_v1';

export interface InfectionMapRecord {
  mapId: string;
  highestRound: number;
  bestKills: number;
  bestHeadshots: number;
  updatedAt: number;
}

export class SaveManager {
  private dbPromise: Promise<IDBDatabase> | null = null;

  public loadInfectionRecords(): Record<string, InfectionMapRecord> {
    try {
      const raw = window.localStorage.getItem(INFECTION_RECORDS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, InfectionMapRecord>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  public recordInfectionRun(
    mapId: string,
    roundReached: number,
    kills: number,
    headshots: number,
  ): { record: InfectionMapRecord; isNewRoundRecord: boolean } {
    const all = this.loadInfectionRecords();
    const prev = all[mapId];
    const isNewRoundRecord = !prev || roundReached > prev.highestRound;
    const next: InfectionMapRecord = {
      mapId,
      highestRound: Math.max(prev?.highestRound ?? 0, roundReached),
      bestKills: Math.max(prev?.bestKills ?? 0, kills),
      bestHeadshots: Math.max(prev?.bestHeadshots ?? 0, headshots),
      updatedAt: Date.now(),
    };
    all[mapId] = next;
    try {
      window.localStorage.setItem(INFECTION_RECORDS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Ignore storage quota errors
    }
    return { record: next, isNewRoundRecord };
  }

  public saveGymLoadout(attachmentsByWeapon: Record<string, WeaponAttachments>): void {
    try {
      const normalized: Record<string, WeaponAttachments> = {};
      for (const weaponId of Object.keys(attachmentsByWeapon)) {
        normalized[weaponId] = normalizeWeaponAttachments(weaponId, attachmentsByWeapon[weaponId]);
      }
      window.localStorage.setItem(GYM_LOADOUT_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage quota or private browsing errors
    }
  }

  public loadGymLoadout(): Record<string, WeaponAttachments> | null {
    try {
      const raw = window.localStorage.getItem(GYM_LOADOUT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, WeaponAttachments>;
      if (!parsed || typeof parsed !== 'object') return null;
      const clean: Record<string, WeaponAttachments> = {};
      for (const weaponId of Object.keys(parsed)) {
        clean[weaponId] = normalizeWeaponAttachments(weaponId, parsed[weaponId]);
      }
      return clean;
    } catch {
      return null;
    }
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  public async saveSlot(data: SaveSlotData): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async loadSlot(id: string): Promise<SaveSlotData | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as SaveSlotData | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  public async deleteSlot(id: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async listSlots(): Promise<SaveSlotMeta[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as SaveSlotData[]) ?? [];
        const metas: SaveSlotMeta[] = rows
          .map((r) => ({
            id: r.id,
            name: r.name,
            isQuicksave: r.isQuicksave,
            savedAt: r.savedAt,
            playtimeSec: r.playtimeSec,
            worldSeed: r.worldSeed,
          }))
          .sort((a, b) => b.savedAt - a.savedAt);
        resolve(metas);
      };
      req.onerror = () => reject(req.error);
    });
  }
}

import {
  GYM_ARMORY_WEAPONS,
  resolveWeaponProfile,
  SDK_WEAPON_PROFILES,
} from '../bodycam-sdk';
import { resolveBaseCaliberId } from '../data/calibers';
import { loadoutStore, normalizeLoadoutWeaponId } from '../data/loadoutStore';

export interface HideoutPersistedState {
  /** Owned/unlocked firearm IDs known to the Hideout */
  unlockedWeaponIds: string[];
  /** Ordered Gun Wall slot contents (weaponId or null when currently held in hands) */
  wallRackSlots: Array<string | null>;
  /** Currently held weapon ID in the Hideout ('unarmed' or canonical SDK weapon ID) */
  equippedWeaponId: string;
  /** Reserve ammo rounds keyed by BaseCaliberId */
  ammoReserve: Record<string, number>;
  /** Phase 2 Gun Range 30s CQB Pop-Up Course personal bests */
  gunRangeBestScore: number;
  gunRangeBestHits: number;
  gunRangeBestAccuracy: number;
  gunRangeCoursesCompleted: number;
  /** Phase 3 100m Long-Range Gallery & Ballistics Bench persistence */
  longRangeBestMoa100m: number | null;
  longRange100mHits: number;
  ammoVariantByWeapon: Record<string, string>;
  zeroDistanceByWeapon: Record<string, number>;
}

const STORAGE_KEY = 'axon_hideout_state_v1';
const MAX_RACK_SLOTS = 12;

const DEFAULT_RESERVE_BY_CALIBER: Readonly<Record<string, number>> = {
  '9x19': 120,
  '45acp': 84,
  '50ae': 49,
  '357mag': 54,
  '762x38r': 56,
  '57x28': 200,
  '556x45': 180,
  '545x39': 180,
  '762x39': 180,
  '762x51': 100,
  '762x54r': 80,
  '338_lm': 40,
  '12ga': 48,
};

function getAllCatalogWeaponIds(): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const w of GYM_ARMORY_WEAPONS) {
    if (!seen.has(w.id) && w.holdClass !== 'unarmed') {
      seen.add(w.id);
      ordered.push(w.id);
    }
  }
  if (!seen.has('akm_762') && SDK_WEAPON_PROFILES.akm_762) {
    seen.add('akm_762');
    ordered.push('akm_762');
  }
  return ordered;
}

export function getDefaultReserveForCaliber(caliberId: string): number {
  return DEFAULT_RESERVE_BY_CALIBER[caliberId] ?? 120;
}

type HideoutStateListener = (state: HideoutPersistedState) => void;

/**
 * Persistent Hideout State Store (`localStorage`).
 * Strictly tracks ONLY owned/unlocked firearms on the Arsenal Gun Wall
 * (never populates unowned firearms or silhouettes), keeps `equippedWeaponId`
 * synced with `loadoutStore`, and manages reserve ammunition.
 */
class HideoutStateStore {
  private state: HideoutPersistedState;
  private readonly listeners = new Set<HideoutStateListener>();

  constructor() {
    this.state = this.load();
  }

  private load(): HideoutPersistedState {
    const activeLoadout = loadoutStore.getActiveSlot();
    const defaultEquipped = normalizeLoadoutWeaponId(activeLoadout.primaryWeaponId, 'm4a1');
    const fallback: HideoutPersistedState = {
      unlockedWeaponIds: ['m4a1', 'akm_762', 'hk_mp5', 'remington_870', 'mosin_m91_30', 'makarov_pm'],
      wallRackSlots: ['akm_762', 'hk_mp5', 'remington_870', 'mosin_m91_30', 'makarov_pm'],
      equippedWeaponId: defaultEquipped,
      ammoReserve: { ...DEFAULT_RESERVE_BY_CALIBER },
      gunRangeBestScore: 0,
      gunRangeBestHits: 0,
      gunRangeBestAccuracy: 0,
      gunRangeCoursesCompleted: 0,
      longRangeBestMoa100m: null,
      longRange100mHits: 0,
      ammoVariantByWeapon: {},
      zeroDistanceByWeapon: {},
    };

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<HideoutPersistedState>;
      const unlocked = Array.isArray(parsed.unlockedWeaponIds)
        ? parsed.unlockedWeaponIds
            .map((id) => normalizeLoadoutWeaponId(id, ''))
            .filter((id) => Boolean(id))
        : fallback.unlockedWeaponIds;
      const equippedRaw =
        parsed.equippedWeaponId === 'unarmed'
          ? 'unarmed'
          : normalizeLoadoutWeaponId(parsed.equippedWeaponId, defaultEquipped);
      const wallSlots = Array.isArray(parsed.wallRackSlots)
        ? parsed.wallRackSlots.map((id) => (id ? normalizeLoadoutWeaponId(id, '') || null : null))
        : fallback.wallRackSlots;
      const ammoReserve: Record<string, number> = {
        ...DEFAULT_RESERVE_BY_CALIBER,
        ...(parsed.ammoReserve && typeof parsed.ammoReserve === 'object' ? parsed.ammoReserve : {}),
      };
      return {
        unlockedWeaponIds: Array.from(new Set(unlocked)),
        wallRackSlots: wallSlots,
        equippedWeaponId: equippedRaw,
        ammoReserve,
        gunRangeBestScore:
          typeof parsed.gunRangeBestScore === 'number' && Number.isFinite(parsed.gunRangeBestScore)
            ? Math.max(0, Math.round(parsed.gunRangeBestScore))
            : 0,
        gunRangeBestHits:
          typeof parsed.gunRangeBestHits === 'number' && Number.isFinite(parsed.gunRangeBestHits)
            ? Math.max(0, Math.round(parsed.gunRangeBestHits))
            : 0,
        gunRangeBestAccuracy:
          typeof parsed.gunRangeBestAccuracy === 'number' && Number.isFinite(parsed.gunRangeBestAccuracy)
            ? Math.max(0, Math.min(100, Math.round(parsed.gunRangeBestAccuracy)))
            : 0,
        gunRangeCoursesCompleted:
          typeof parsed.gunRangeCoursesCompleted === 'number' &&
          Number.isFinite(parsed.gunRangeCoursesCompleted)
            ? Math.max(0, Math.round(parsed.gunRangeCoursesCompleted))
            : 0,
        longRangeBestMoa100m:
          typeof parsed.longRangeBestMoa100m === 'number' &&
          Number.isFinite(parsed.longRangeBestMoa100m) &&
          parsed.longRangeBestMoa100m > 0
            ? Math.round(parsed.longRangeBestMoa100m * 100) / 100
            : null,
        longRange100mHits:
          typeof parsed.longRange100mHits === 'number' &&
          Number.isFinite(parsed.longRange100mHits)
            ? Math.max(0, Math.round(parsed.longRange100mHits))
            : 0,
        ammoVariantByWeapon:
          parsed.ammoVariantByWeapon && typeof parsed.ammoVariantByWeapon === 'object'
            ? { ...parsed.ammoVariantByWeapon }
            : {},
        zeroDistanceByWeapon:
          parsed.zeroDistanceByWeapon && typeof parsed.zeroDistanceByWeapon === 'object'
            ? { ...parsed.zeroDistanceByWeapon }
            : {},
      };
    } catch {
      return fallback;
    }
  }

  private saveAndEmit(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage quota errors
    }
    const snap = this.getState();
    for (const fn of this.listeners) fn(snap);
  }

  public getState(): HideoutPersistedState {
    return {
      unlockedWeaponIds: [...this.state.unlockedWeaponIds],
      wallRackSlots: [...this.state.wallRackSlots],
      equippedWeaponId: this.state.equippedWeaponId,
      ammoReserve: { ...this.state.ammoReserve },
      gunRangeBestScore: this.state.gunRangeBestScore,
      gunRangeBestHits: this.state.gunRangeBestHits,
      gunRangeBestAccuracy: this.state.gunRangeBestAccuracy,
      gunRangeCoursesCompleted: this.state.gunRangeCoursesCompleted,
      longRangeBestMoa100m: this.state.longRangeBestMoa100m,
      longRange100mHits: this.state.longRange100mHits,
      ammoVariantByWeapon: { ...this.state.ammoVariantByWeapon },
      zeroDistanceByWeapon: { ...this.state.zeroDistanceByWeapon },
    };
  }

  /**
   * Reconciles the Gun Wall slots strictly against the player's currently unlocked weapons.
   * Unowned weapons are removed immediately; newly unlocked weapons are mounted into open slots.
   */
  public syncWithUnlockedCheck(isWeaponUnlocked: (weaponId: string) => boolean): HideoutPersistedState {
    const catalogIds = getAllCatalogWeaponIds();
    const ownedIds = catalogIds.filter((id) => isWeaponUnlocked(id));
    const ownedSet = new Set(ownedIds);

    let equipped = this.state.equippedWeaponId;
    if (equipped !== 'unarmed' && !ownedSet.has(equipped)) {
      equipped = ownedIds[0] ?? 'unarmed';
    }

    // Preserve existing player-arranged rack order for still-owned guns (excluding the currently held gun)
    const nextSlots: Array<string | null> = [];
    const placed = new Set<string>();
    if (equipped !== 'unarmed') {
      placed.add(equipped);
    }

    for (const slotId of this.state.wallRackSlots) {
      if (nextSlots.length >= MAX_RACK_SLOTS) break;
      if (slotId === null) {
        nextSlots.push(null);
      } else if (ownedSet.has(slotId) && !placed.has(slotId)) {
        nextSlots.push(slotId);
        placed.add(slotId);
      }
    }

    // Add any newly owned firearms not yet on the wall (fill empty slots only if excess, or append cleanly)
    for (const ownedId of ownedIds) {
      if (placed.has(ownedId)) continue;
      if (nextSlots.length < MAX_RACK_SLOTS) {
        nextSlots.push(ownedId);
        placed.add(ownedId);
      } else {
        const emptyIdx = nextSlots.findIndex((s) => s === null);
        if (emptyIdx >= 0) {
          nextSlots[emptyIdx] = ownedId;
          placed.add(ownedId);
        }
      }
    }

    // Trim trailing excess null slots beyond owned count so rack only exposes brackets matching owned guns
    const targetBracketCount = Math.min(MAX_RACK_SLOTS, Math.max(ownedIds.length, 1));
    while (nextSlots.length > targetBracketCount) {
      const lastNull = nextSlots.lastIndexOf(null);
      if (lastNull >= 0) nextSlots.splice(lastNull, 1);
      else break;
    }
    // Guarantee at least one open bracket when holding a gun if ownedCount <= MAX_RACK_SLOTS
    if (equipped !== 'unarmed' && !nextSlots.includes(null) && nextSlots.length < targetBracketCount) {
      nextSlots.push(null);
    }

    this.state = {
      ...this.state,
      unlockedWeaponIds: ownedIds,
      wallRackSlots: nextSlots,
      equippedWeaponId: equipped,
    };
    this.saveAndEmit();
    return this.getState();
  }

  /**
   * Swaps the currently held firearm with the weapon at `slotIndex` on the Gun Wall.
   * - Armed + occupied slot: hangs held weapon in `slotIndex`, equips target weapon.
   * - Unarmed + occupied slot: lifts target weapon from `slotIndex` (leaves slot open/null).
   * - Armed + empty slot: hangs held weapon into `slotIndex` (player becomes unarmed).
   */
  public commitRackSwap(slotIndex: number): { previousEquipped: string; nextEquipped: string } {
    const slots = [...this.state.wallRackSlots];
    const previousEquipped = this.state.equippedWeaponId;
    const slotWeapon = slots[slotIndex] ?? null;

    if (previousEquipped === 'unarmed' && !slotWeapon) {
      return { previousEquipped, nextEquipped: 'unarmed' };
    }

    let nextEquipped = 'unarmed';
    if (previousEquipped !== 'unarmed' && slotWeapon) {
      slots[slotIndex] = previousEquipped;
      nextEquipped = slotWeapon;
    } else if (previousEquipped === 'unarmed' && slotWeapon) {
      slots[slotIndex] = null;
      nextEquipped = slotWeapon;
    } else if (previousEquipped !== 'unarmed' && !slotWeapon) {
      slots[slotIndex] = previousEquipped;
      nextEquipped = 'unarmed';
    }

    this.state = {
      ...this.state,
      wallRackSlots: slots,
      equippedWeaponId: nextEquipped,
    };
    this.syncEquippedToLoadoutStore(nextEquipped);
    this.saveAndEmit();
    return { previousEquipped, nextEquipped };
  }

  public setEquippedWeaponDirect(weaponId: string): void {
    const normalized =
      weaponId === 'unarmed' ? 'unarmed' : normalizeLoadoutWeaponId(weaponId, 'm4a1');
    if (normalized === this.state.equippedWeaponId) return;

    const slots = [...this.state.wallRackSlots];
    const prev = this.state.equippedWeaponId;

    // Remove newly equipped weapon from its wall slot if present
    const targetIdx = normalized !== 'unarmed' ? slots.indexOf(normalized) : -1;
    if (targetIdx >= 0) {
      slots[targetIdx] = prev !== 'unarmed' ? prev : null;
    } else if (prev !== 'unarmed' && !slots.includes(prev)) {
      const emptyIdx = slots.indexOf(null);
      if (emptyIdx >= 0) slots[emptyIdx] = prev;
      else if (slots.length < MAX_RACK_SLOTS) slots.push(prev);
    }

    this.state = {
      ...this.state,
      wallRackSlots: slots,
      equippedWeaponId: normalized,
    };
    this.syncEquippedToLoadoutStore(normalized);
    this.saveAndEmit();
  }

  private syncEquippedToLoadoutStore(weaponId: string): void {
    if (weaponId === 'unarmed') return;
    const prof = resolveWeaponProfile(weaponId);
    const activeIdx = loadoutStore.getState().activeIndex;
    if (prof.category === 'pistols' || prof.category === 'revolvers') {
      loadoutStore.setSlotSecondaryWeapon(activeIdx, prof.id);
    } else {
      loadoutStore.setSlotPrimaryWeapon(activeIdx, prof.id);
    }
  }

  public getReserveForWeapon(weaponId: string): number {
    if (weaponId === 'unarmed') return 0;
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    return this.state.ammoReserve[calId] ?? getDefaultReserveForCaliber(calId);
  }

  public consumeReserve(weaponId: string, rounds: number): number {
    if (weaponId === 'unarmed' || rounds <= 0) return 0;
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    const avail = this.state.ammoReserve[calId] ?? getDefaultReserveForCaliber(calId);
    const taken = Math.min(avail, rounds);
    this.state = {
      ...this.state,
      ammoReserve: {
        ...this.state.ammoReserve,
        [calId]: Math.max(0, avail - taken),
      },
    };
    this.saveAndEmit();
    return taken;
  }

  public resupplyAllAmmo(): void {
    const nextReserve: Record<string, number> = { ...DEFAULT_RESERVE_BY_CALIBER };
    for (const calId of Object.keys(this.state.ammoReserve)) {
      nextReserve[calId] = Math.max(
        getDefaultReserveForCaliber(calId),
        this.state.ammoReserve[calId] ?? 0,
      );
    }
    this.state = {
      ...this.state,
      ammoReserve: nextReserve,
    };
    this.saveAndEmit();
  }

  public recordGunRangeRun(score: number, hits: number, accuracyPct: number): boolean {
    const cleanScore = Math.max(0, Math.round(score));
    const cleanHits = Math.max(0, Math.round(hits));
    const cleanAcc = Math.max(0, Math.min(100, Math.round(accuracyPct)));
    const isNewBest = cleanScore > this.state.gunRangeBestScore && cleanScore > 0;
    this.state = {
      ...this.state,
      gunRangeBestScore: Math.max(this.state.gunRangeBestScore, cleanScore),
      gunRangeBestHits: Math.max(this.state.gunRangeBestHits, cleanHits),
      gunRangeBestAccuracy: Math.max(this.state.gunRangeBestAccuracy, cleanAcc),
      gunRangeCoursesCompleted: this.state.gunRangeCoursesCompleted + 1,
    };
    this.saveAndEmit();
    return isNewBest;
  }

  public setWeaponAmmoVariant(weaponId: string, variantId: string): void {
    if (!weaponId || weaponId === 'unarmed') return;
    this.state = {
      ...this.state,
      ammoVariantByWeapon: {
        ...this.state.ammoVariantByWeapon,
        [weaponId]: variantId,
      },
    };
    this.saveAndEmit();
  }

  public setWeaponZeroDistance(weaponId: string, zeroDistanceM: number): void {
    if (!weaponId || weaponId === 'unarmed') return;
    const clamped = Math.max(25, Math.min(300, Math.round(zeroDistanceM)));
    this.state = {
      ...this.state,
      zeroDistanceByWeapon: {
        ...this.state.zeroDistanceByWeapon,
        [weaponId]: clamped,
      },
    };
    this.saveAndEmit();
  }

  public recordLongRangeHit(groupMoa100m: number | null): boolean {
    let isNewBest = false;
    let nextBest = this.state.longRangeBestMoa100m;
    if (groupMoa100m !== null && Number.isFinite(groupMoa100m) && groupMoa100m > 0) {
      const cleanMoa = Math.round(groupMoa100m * 100) / 100;
      if (nextBest === null || cleanMoa < nextBest) {
        nextBest = cleanMoa;
        isNewBest = true;
      }
    }
    this.state = {
      ...this.state,
      longRange100mHits: this.state.longRange100mHits + 1,
      longRangeBestMoa100m: nextBest,
    };
    this.saveAndEmit();
    return isNewBest;
  }

  public subscribe(fn: HideoutStateListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const hideoutStateStore = new HideoutStateStore();

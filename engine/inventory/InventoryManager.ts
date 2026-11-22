import { CaliberId } from '../../data/calibers';
import { ITEMS, ItemSpec } from '../../data/items';
import { WEAPONS, WeaponId } from '../../data/weapons';
import {
  EncumbranceTier,
  EquippedWeaponState,
  GridDimensions,
  GridPlacedItem,
  InventoryItemInstance,
  InventorySaveState,
  InventorySnapshotState,
  StorageZoneId,
  WeaponSlotsState,
} from '../types';

export const POCKETS_DIMS: GridDimensions = { cols: 4, rows: 1 };
export const RIG_DIMS: GridDimensions = { cols: 4, rows: 3 };

export const COMFORTABLE_WEIGHT_KG = 12.0;
export const HEAVY_WEIGHT_KG = 24.0;
export const MAX_WEIGHT_KG = 34.0;

let invUidSeq = 5000;
export function makeInvUid(prefix: string): string {
  invUidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${invUidSeq}`;
}

export function getLooseAmmoItemIdForCaliber(caliberId: CaliberId): string | null {
  switch (caliberId) {
    case '9x19_fmj':
      return 'ammo_9x19';
    case '545x39_7n6':
      return 'ammo_545x39';
    case '556x45_m855':
      return 'ammo_556x45';
    case '762x39_ps':
      return 'ammo_762x39';
    case '12ga_00buck':
      return 'ammo_12ga';
    default:
      return null;
  }
}

export function getRoundWeightKg(caliberId: CaliberId): number {
  const ammoItemId = getLooseAmmoItemIdForCaliber(caliberId);
  if (ammoItemId && ITEMS[ammoItemId]) {
    return ITEMS[ammoItemId].weightKg;
  }
  return 0.012;
}

/**
 * Ensures any magazine instance has a consistent `roundArray` and synced `rounds` count.
 */
export function normalizeMagazineItem(item: InventoryItemInstance): InventoryItemInstance {
  const spec = ITEMS[item.itemId];
  if (!spec || spec.category !== 'magazine') return item;
  const cap = spec.magCapacity ?? 15;
  const defaultCal = spec.caliberId ?? '9x19_fmj';

  if (Array.isArray(item.roundArray)) {
    const trimmed = item.roundArray.slice(0, cap);
    item.roundArray = trimmed;
    item.rounds = trimmed.length;
  } else {
    const count = Math.max(0, Math.min(cap, Math.round(item.rounds ?? 0)));
    item.roundArray = new Array<CaliberId>(count).fill(defaultCal);
    item.rounds = count;
  }
  return item;
}

export function cloneItemInstance(item: InventoryItemInstance): InventoryItemInstance {
  const copy: InventoryItemInstance = {
    uid: item.uid,
    itemId: item.itemId,
    quantity: item.quantity,
    rounds: item.rounds,
    roundArray: item.roundArray ? [...item.roundArray] : undefined,
  };
  return normalizeMagazineItem(copy);
}

export function getMagRoundCount(item: InventoryItemInstance): number {
  if (Array.isArray(item.roundArray)) return item.roundArray.length;
  return item.rounds ?? 0;
}

export function pushRoundToMag(mag: InventoryItemInstance, caliberId: CaliberId): boolean {
  normalizeMagazineItem(mag);
  const cap = ITEMS[mag.itemId]?.magCapacity ?? 0;
  if (!mag.roundArray || mag.roundArray.length >= cap) return false;
  mag.roundArray.push(caliberId);
  mag.rounds = mag.roundArray.length;
  return true;
}

export function popRoundFromMag(mag: InventoryItemInstance): CaliberId | null {
  normalizeMagazineItem(mag);
  if (!mag.roundArray || mag.roundArray.length === 0) return null;
  const cal = mag.roundArray.pop() ?? null;
  mag.rounds = mag.roundArray.length;
  return cal;
}

export function computeItemWeightKg(item: InventoryItemInstance): number {
  const spec = ITEMS[item.itemId];
  if (!spec) return 0;
  if (spec.category === 'magazine') {
    normalizeMagazineItem(item);
    let roundsWeight = 0;
    if (item.roundArray) {
      for (let i = 0; i < item.roundArray.length; i++) {
        roundsWeight += getRoundWeightKg(item.roundArray[i]);
      }
    }
    return spec.weightKg + roundsWeight;
  }
  return spec.weightKg * Math.max(1, item.quantity);
}

export function getItemGridDims(itemId: string, rotated: boolean): { w: number; h: number } {
  const spec = ITEMS[itemId];
  const baseW = spec?.gridW ?? 1;
  const baseH = spec?.gridH ?? 1;
  return rotated ? { w: baseH, h: baseW } : { w: baseW, h: baseH };
}

export interface EncumbranceModifiers {
  carryWeightKg: number;
  encumbranceRatio: number;
  encumbranceTier: EncumbranceTier;
  staminaDrainMult: number;
  exertionRateMult: number;
  moveSpeedMult: number;
  canSprint: boolean;
}

export interface ReloadMagCandidate {
  placed: GridPlacedItem;
  zone: StorageZoneId;
  rounds: number;
  reloadTimeMult: number;
}

export class InventoryManager {
  private placed: GridPlacedItem[] = [];
  private equippedBackpack: InventoryItemInstance | null = null;
  private weaponSlots: WeaponSlotsState = {
    primary: null,
    sidearm: null,
    melee: null,
    throwable: null,
  };

  public resetEmpty(): void {
    this.placed = [];
    this.equippedBackpack = null;
    this.weaponSlots = {
      primary: null,
      sidearm: null,
      melee: null,
      throwable: null,
    };
  }

  public getZoneDims(zone: StorageZoneId): GridDimensions | null {
    if (zone === 'pockets') return POCKETS_DIMS;
    if (zone === 'rig') return RIG_DIMS;
    if (zone === 'backpack') {
      if (!this.equippedBackpack) return null;
      const spec = ITEMS[this.equippedBackpack.itemId];
      if (!spec?.backpackCols || !spec?.backpackRows) return null;
      return { cols: spec.backpackCols, rows: spec.backpackRows };
    }
    return null;
  }

  public getEquippedBackpack(): InventoryItemInstance | null {
    return this.equippedBackpack;
  }

  public getWeaponSlots(): WeaponSlotsState {
    return { ...this.weaponSlots };
  }

  public setWeaponSlot(slot: keyof WeaponSlotsState, weaponId: WeaponId | null): void {
    this.weaponSlots[slot] = weaponId;
  }

  public getPlacedItems(): GridPlacedItem[] {
    return this.placed;
  }

  public getAllFlatItems(): InventoryItemInstance[] {
    return this.placed.map((p) => p.item);
  }

  public findPlacedByUid(uid: string): GridPlacedItem | null {
    return this.placed.find((p) => p.item.uid === uid) ?? null;
  }

  public getItemQuantity(itemId: string): number {
    let total = 0;
    for (const p of this.placed) {
      if (p.item.itemId === itemId) total += p.item.quantity;
    }
    return total;
  }

  public findItemByItemIdPriority(
    itemId: string,
    zoneOrder: StorageZoneId[] = ['rig', 'pockets', 'backpack'],
  ): GridPlacedItem | null {
    for (const zone of zoneOrder) {
      const hit = this.placed.find((p) => p.zone === zone && p.item.itemId === itemId);
      if (hit) return hit;
    }
    return null;
  }

  public canPlaceInZone(
    zone: StorageZoneId,
    x: number,
    y: number,
    w: number,
    h: number,
    ignoreUid?: string,
  ): boolean {
    const dims = this.getZoneDims(zone);
    if (!dims) return false;
    if (x < 0 || y < 0 || x + w > dims.cols || y + h > dims.rows) return false;

    for (const p of this.placed) {
      if (p.zone !== zone) continue;
      if (ignoreUid && p.item.uid === ignoreUid) continue;
      const d = getItemGridDims(p.item.itemId, p.rotated);
      const overlaps =
        x < p.x + d.w &&
        x + w > p.x &&
        y < p.y + d.h &&
        y + h > p.y;
      if (overlaps) return false;
    }
    return true;
  }

  public findFirstFitInZone(
    zone: StorageZoneId,
    itemId: string,
    ignoreUid?: string,
  ): { x: number; y: number; rotated: boolean } | null {
    const dims = this.getZoneDims(zone);
    if (!dims) return null;
    const spec = ITEMS[itemId];
    if (!spec) return null;

    const orientations = spec.gridW === spec.gridH ? [false] : [false, true];
    for (const rotated of orientations) {
      const { w, h } = getItemGridDims(itemId, rotated);
      for (let y = 0; y <= dims.rows - h; y++) {
        for (let x = 0; x <= dims.cols - w; x++) {
          if (this.canPlaceInZone(zone, x, y, w, h, ignoreUid)) {
            return { x, y, rotated };
          }
        }
      }
    }
    return null;
  }

  private getPreferredZoneOrder(spec: ItemSpec): StorageZoneId[] {
    if (spec.category === 'magazine' || spec.category === 'medical') {
      return ['rig', 'pockets', 'backpack'];
    }
    if (spec.category === 'ammo' || spec.category === 'gear') {
      return ['pockets', 'rig', 'backpack'];
    }
    if (spec.category === 'food' || spec.category === 'drink' || spec.category === 'attachment') {
      return ['backpack', 'rig', 'pockets'];
    }
    return ['backpack', 'rig', 'pockets'];
  }

  /**
   * Attempts to place an item into player grids (stacking onto matching stacks first if stackable).
   * Returns `{ added: boolean; remainder: InventoryItemInstance | null; placedZone?: StorageZoneId }`.
   */
  public addItem(
    rawItem: InventoryItemInstance,
    preferredZones?: StorageZoneId[],
  ): { added: boolean; remainder: InventoryItemInstance | null; placedZone?: StorageZoneId } {
    const item = cloneItemInstance(rawItem);
    const spec = ITEMS[item.itemId];
    if (!spec) return { added: false, remainder: item };

    const zones = preferredZones ?? this.getPreferredZoneOrder(spec);

    // 1. Merge into existing partial stacks if stackable
    if (spec.stackable && spec.maxStack > 1) {
      let remainingQty = item.quantity;
      let mergedAny = false;
      for (const zone of zones) {
        for (const p of this.placed) {
          if (p.zone !== zone) continue;
          if (p.item.itemId === item.itemId && p.item.quantity < spec.maxStack) {
            const space = spec.maxStack - p.item.quantity;
            const add = Math.min(space, remainingQty);
            p.item.quantity += add;
            remainingQty -= add;
            mergedAny = true;
            if (remainingQty <= 0) {
              return { added: true, remainder: null, placedZone: zone };
            }
          }
        }
      }
      item.quantity = remainingQty;
      if (remainingQty <= 0) {
        return { added: mergedAny, remainder: null };
      }
    }

    // 2. Place as new grid item(s)
    for (const zone of zones) {
      const fit = this.findFirstFitInZone(zone, item.itemId);
      if (fit) {
        const toPlace = cloneItemInstance(item);
        if (spec.stackable && toPlace.quantity > spec.maxStack) {
          const overflowQty = toPlace.quantity - spec.maxStack;
          toPlace.quantity = spec.maxStack;
          this.placed.push({ item: toPlace, zone, x: fit.x, y: fit.y, rotated: fit.rotated });
          const rest = this.addItem({ ...item, uid: makeInvUid('stk'), quantity: overflowQty }, zones);
          return { added: true, remainder: rest.remainder, placedZone: zone };
        }
        this.placed.push({ item: toPlace, zone, x: fit.x, y: fit.y, rotated: fit.rotated });
        return { added: true, remainder: null, placedZone: zone };
      }
    }

    return { added: false, remainder: item };
  }

  public addItemAt(
    rawItem: InventoryItemInstance,
    zone: StorageZoneId,
    x: number,
    y: number,
    rotated = false,
  ): boolean {
    const item = cloneItemInstance(rawItem);
    const { w, h } = getItemGridDims(item.itemId, rotated);
    if (!this.canPlaceInZone(zone, x, y, w, h)) return false;
    this.placed.push({ item, zone, x, y, rotated });
    return true;
  }

  public moveItem(
    uid: string,
    targetZone: StorageZoneId,
    targetX: number,
    targetY: number,
    rotated?: boolean,
  ): boolean {
    const entry = this.findPlacedByUid(uid);
    if (!entry) return false;
    const spec = ITEMS[entry.item.itemId];
    if (!spec) return false;

    const nextRot = rotated !== undefined ? rotated : entry.rotated;
    const { w, h } = getItemGridDims(entry.item.itemId, nextRot);

    // Check if dropping onto an existing matching stackable item in that cell
    if (spec.stackable && spec.maxStack > 1) {
      const targetAtCell = this.getItemAtCell(targetZone, targetX, targetY);
      if (
        targetAtCell &&
        targetAtCell.item.uid !== uid &&
        targetAtCell.item.itemId === entry.item.itemId &&
        targetAtCell.item.quantity < spec.maxStack
      ) {
        const space = spec.maxStack - targetAtCell.item.quantity;
        const moveQty = Math.min(space, entry.item.quantity);
        targetAtCell.item.quantity += moveQty;
        entry.item.quantity -= moveQty;
        if (entry.item.quantity <= 0) {
          this.removeItemByUid(uid);
        }
        return true;
      }
    }

    if (!this.canPlaceInZone(targetZone, targetX, targetY, w, h, uid)) {
      return false;
    }

    entry.zone = targetZone;
    entry.x = targetX;
    entry.y = targetY;
    entry.rotated = nextRot;
    return true;
  }

  public quickTransferWithinPlayer(uid: string): StorageZoneId | null {
    const entry = this.findPlacedByUid(uid);
    if (!entry) return null;
    const targets: StorageZoneId[] =
      entry.zone === 'rig'
        ? ['backpack', 'pockets']
        : entry.zone === 'pockets'
          ? ['rig', 'backpack']
          : ['rig', 'pockets'];

    const spec = ITEMS[entry.item.itemId];
    for (const tz of targets) {
      if (!this.getZoneDims(tz)) continue;
      // Stack merge check first
      if (spec?.stackable && spec.maxStack > 1) {
        const existing = this.placed.find(
          (p) =>
            p.zone === tz &&
            p.item.uid !== uid &&
            p.item.itemId === entry.item.itemId &&
            p.item.quantity < spec.maxStack,
        );
        if (existing) {
          const space = spec.maxStack - existing.item.quantity;
          const moveQty = Math.min(space, entry.item.quantity);
          existing.item.quantity += moveQty;
          entry.item.quantity -= moveQty;
          if (entry.item.quantity <= 0) {
            this.removeItemByUid(uid);
          }
          return tz;
        }
      }
      const fit = this.findFirstFitInZone(tz, entry.item.itemId, uid);
      if (fit) {
        entry.zone = tz;
        entry.x = fit.x;
        entry.y = fit.y;
        entry.rotated = fit.rotated;
        return tz;
      }
    }
    return null;
  }

  public rotateItem(uid: string): boolean {
    const entry = this.findPlacedByUid(uid);
    if (!entry) return false;
    const spec = ITEMS[entry.item.itemId];
    if (!spec || spec.gridW === spec.gridH) return false;
    const nextRot = !entry.rotated;
    const { w, h } = getItemGridDims(entry.item.itemId, nextRot);
    if (this.canPlaceInZone(entry.zone, entry.x, entry.y, w, h, uid)) {
      entry.rotated = nextRot;
      return true;
    }
    // Try slight anchor shift inside same zone so rotating near an edge still feels responsive
    const dims = this.getZoneDims(entry.zone);
    if (!dims) return false;
    const clampedX = Math.min(entry.x, dims.cols - w);
    const clampedY = Math.min(entry.y, dims.rows - h);
    if (clampedX >= 0 && clampedY >= 0 && this.canPlaceInZone(entry.zone, clampedX, clampedY, w, h, uid)) {
      entry.x = clampedX;
      entry.y = clampedY;
      entry.rotated = nextRot;
      return true;
    }
    return false;
  }

  public getItemAtCell(zone: StorageZoneId, x: number, y: number): GridPlacedItem | null {
    for (const p of this.placed) {
      if (p.zone !== zone) continue;
      const { w, h } = getItemGridDims(p.item.itemId, p.rotated);
      if (x >= p.x && x < p.x + w && y >= p.y && y < p.y + h) {
        return p;
      }
    }
    return null;
  }

  public removeItemByUid(uid: string): InventoryItemInstance | null {
    const idx = this.placed.findIndex((p) => p.item.uid === uid);
    if (idx === -1) return null;
    return this.placed.splice(idx, 1)[0].item;
  }

  public consumeQuantityByUid(uid: string, count: number): boolean {
    const idx = this.placed.findIndex((p) => p.item.uid === uid);
    if (idx === -1) return false;
    const item = this.placed[idx].item;
    if (item.quantity < count) return false;
    item.quantity -= count;
    if (item.quantity <= 0) {
      this.placed.splice(idx, 1);
    }
    return true;
  }

  public equipBackpack(
    newPack: InventoryItemInstance,
  ): { equipped: boolean; replaced: InventoryItemInstance | null; error?: string } {
    const spec = ITEMS[newPack.itemId];
    if (!spec || spec.category !== 'backpack' || !spec.backpackCols || !spec.backpackRows) {
      return { equipped: false, replaced: null, error: 'Not a backpack' };
    }

    const oldPack = this.equippedBackpack;
    if (!oldPack) {
      this.equippedBackpack = cloneItemInstance(newPack);
      return { equipped: true, replaced: null };
    }

    // Verify all current backpack items fit into the new backpack dimensions
    const backpackItems = this.placed.filter((p) => p.zone === 'backpack');
    const prevPack = this.equippedBackpack;
    const prevPlacements = backpackItems.map((p) => ({
      ref: p,
      x: p.x,
      y: p.y,
      rotated: p.rotated,
    }));

    // Temporarily swap to test fit
    this.equippedBackpack = cloneItemInstance(newPack);
    const nonBackpack = this.placed.filter((p) => p.zone !== 'backpack');
    this.placed = [...nonBackpack];

    let allFit = true;
    for (const bpItem of backpackItems) {
      const fit = this.findFirstFitInZone('backpack', bpItem.item.itemId);
      if (!fit) {
        allFit = false;
        break;
      }
      this.placed.push({
        item: bpItem.item,
        zone: 'backpack',
        x: fit.x,
        y: fit.y,
        rotated: fit.rotated,
      });
    }

    if (!allFit) {
      // Rollback
      this.equippedBackpack = prevPack;
      this.placed = [
        ...nonBackpack,
        ...prevPlacements.map((pp) => ({
          item: pp.ref.item,
          zone: 'backpack' as StorageZoneId,
          x: pp.x,
          y: pp.y,
          rotated: pp.rotated,
        })),
      ];
      return {
        equipped: false,
        replaced: null,
        error: 'Current backpack contents do not fit in smaller pack',
      };
    }

    return { equipped: true, replaced: oldPack };
  }

  public unequipBackpack(): { removed: InventoryItemInstance | null; error?: string } {
    if (!this.equippedBackpack) return { removed: null };
    const hasItems = this.placed.some((p) => p.zone === 'backpack');
    if (hasItems) {
      return { removed: null, error: 'Empty backpack before removing it' };
    }
    const removed = this.equippedBackpack;
    this.equippedBackpack = null;
    return { removed };
  }

  /**
   * Finds the fullest compatible magazine for R reload:
   * 1) Tactical Rig / Pockets (fast reload: 1.0x duration)
   * 2) Backpack fallback (slower reload: 1.55x duration)
   */
  public findBestMagazineForReload(compatibleMagId: string): ReloadMagCandidate | null {
    let bestFast: GridPlacedItem | null = null;
    let bestFastRounds = -1;

    for (const p of this.placed) {
      if (p.zone !== 'rig' && p.zone !== 'pockets') continue;
      if (p.item.itemId !== compatibleMagId) continue;
      const r = getMagRoundCount(p.item);
      if (r > bestFastRounds) {
        bestFastRounds = r;
        bestFast = p;
      }
    }

    if (bestFast && bestFastRounds > 0) {
      return {
        placed: bestFast,
        zone: bestFast.zone,
        rounds: bestFastRounds,
        reloadTimeMult: 1.0,
      };
    }

    let bestPack: GridPlacedItem | null = null;
    let bestPackRounds = -1;
    for (const p of this.placed) {
      if (p.zone !== 'backpack') continue;
      if (p.item.itemId !== compatibleMagId) continue;
      const r = getMagRoundCount(p.item);
      if (r > bestPackRounds) {
        bestPackRounds = r;
        bestPack = p;
      }
    }

    if (bestPack && bestPackRounds > 0) {
      return {
        placed: bestPack,
        zone: 'backpack',
        rounds: bestPackRounds,
        reloadTimeMult: 1.55,
      };
    }

    // If only empty compatible mags exist, prefer rig/pockets first
    if (bestFast) {
      return { placed: bestFast, zone: bestFast.zone, rounds: bestFastRounds, reloadTimeMult: 1.0 };
    }
    if (bestPack) {
      return { placed: bestPack, zone: 'backpack', rounds: bestPackRounds, reloadTimeMult: 1.55 };
    }

    return null;
  }

  public computeEncumbrance(
    ownedWeapons: WeaponId[],
    weaponStates: Partial<Record<WeaponId, EquippedWeaponState>>,
    hasFlashlight: boolean,
  ): EncumbranceModifiers {
    let weightKg = 0;

    // Equipped / slung weapons + loaded mags + chambered round + suppressors
    for (const wId of ownedWeapons) {
      if (wId === 'unarmed') continue;
      const wSpec = WEAPONS[wId];
      if (!wSpec) continue;
      // Consumable throwables (RGD-5) are counted inside grid items so we don't double-count
      if (wSpec.consumableOnThrow) continue;
      if (wSpec.itemId && ITEMS[wSpec.itemId]) {
        weightKg += ITEMS[wSpec.itemId].weightKg;
      }
      const ws = weaponStates[wId];
      if (ws) {
        if (ws.loadedMag) {
          weightKg += computeItemWeightKg(ws.loadedMag);
        }
        if (ws.chambered && wSpec.caliberId) {
          weightKg += getRoundWeightKg(ws.chamberedCaliber ?? wSpec.caliberId);
        }
        if (ws.suppressorAttachedId && ITEMS[ws.suppressorAttachedId]) {
          weightKg += ITEMS[ws.suppressorAttachedId].weightKg;
        }
      }
    }

    if (hasFlashlight && ITEMS.flashlight) {
      weightKg += ITEMS.flashlight.weightKg;
    }

    if (this.equippedBackpack && ITEMS[this.equippedBackpack.itemId]) {
      weightKg += ITEMS[this.equippedBackpack.itemId].weightKg;
    }

    // All grid items across Pockets, Tactical Rig, and Backpack
    for (const p of this.placed) {
      weightKg += computeItemWeightKg(p.item);
    }

    const carryWeightKg = Math.round(weightKg * 100) / 100;
    const rawRatio = Math.max(0, (carryWeightKg - COMFORTABLE_WEIGHT_KG) / (MAX_WEIGHT_KG - COMFORTABLE_WEIGHT_KG));
    const encumbranceRatio = Math.min(1.4, rawRatio);

    let encumbranceTier: EncumbranceTier = 'light';
    if (carryWeightKg >= MAX_WEIGHT_KG) encumbranceTier = 'overloaded';
    else if (carryWeightKg >= HEAVY_WEIGHT_KG) encumbranceTier = 'heavy';
    else if (carryWeightKg > COMFORTABLE_WEIGHT_KG) encumbranceTier = 'moderate';

    const clamped = Math.min(1.0, encumbranceRatio);
    const staminaDrainMult = 1.0 + clamped * 1.15 + Math.max(0, encumbranceRatio - 1.0) * 1.2;
    const exertionRateMult = 1.0 + clamped * 0.85 + Math.max(0, encumbranceRatio - 1.0) * 0.9;
    const moveSpeedMult =
      encumbranceTier === 'overloaded'
        ? Math.max(0.62, 0.78 - (encumbranceRatio - 1.0) * 0.35)
        : 1.0 - clamped * 0.22;
    const canSprint = carryWeightKg < MAX_WEIGHT_KG + 3.0;

    return {
      carryWeightKg,
      encumbranceRatio,
      encumbranceTier,
      staminaDrainMult,
      exertionRateMult,
      moveSpeedMult,
      canSprint,
    };
  }

  public buildSnapshot(
    ownedWeapons: WeaponId[],
    weaponStates: Partial<Record<WeaponId, EquippedWeaponState>>,
    hasFlashlight: boolean,
  ): InventorySnapshotState {
    const enc = this.computeEncumbrance(ownedWeapons, weaponStates, hasFlashlight);
    return {
      pocketsDims: { ...POCKETS_DIMS },
      rigDims: { ...RIG_DIMS },
      backpackDims: this.getZoneDims('backpack'),
      equippedBackpack: this.equippedBackpack ? cloneItemInstance(this.equippedBackpack) : null,
      placed: this.placed.map((p) => ({
        zone: p.zone,
        x: p.x,
        y: p.y,
        rotated: p.rotated,
        item: cloneItemInstance(p.item),
      })),
      weaponSlots: { ...this.weaponSlots },
      carryWeightKg: enc.carryWeightKg,
      comfortableWeightKg: COMFORTABLE_WEIGHT_KG,
      maxWeightKg: MAX_WEIGHT_KG,
      encumbranceRatio: enc.encumbranceRatio,
      encumbranceTier: enc.encumbranceTier,
    };
  }

  public exportSaveState(): InventorySaveState {
    return {
      placed: this.placed.map((p) => ({
        zone: p.zone,
        x: p.x,
        y: p.y,
        rotated: p.rotated,
        item: cloneItemInstance(p.item),
      })),
      equippedBackpack: this.equippedBackpack ? cloneItemInstance(this.equippedBackpack) : null,
      weaponSlots: { ...this.weaponSlots },
    };
  }

  public loadSaveState(
    save: InventorySaveState | undefined,
    legacyInventory: InventoryItemInstance[],
    ownedWeapons: WeaponId[],
  ): void {
    this.resetEmpty();

    if (save && Array.isArray(save.placed)) {
      this.equippedBackpack = save.equippedBackpack ? cloneItemInstance(save.equippedBackpack) : null;
      if (save.weaponSlots) {
        this.weaponSlots = { ...save.weaponSlots };
      } else {
        this.syncWeaponSlotsFromOwned(ownedWeapons);
      }

      for (const p of save.placed) {
        const item = cloneItemInstance(p.item);
        const { w, h } = getItemGridDims(item.itemId, Boolean(p.rotated));
        if (this.canPlaceInZone(p.zone, p.x, p.y, w, h)) {
          this.placed.push({
            item,
            zone: p.zone,
            x: p.x,
            y: p.y,
            rotated: Boolean(p.rotated),
          });
        } else {
          this.addItem(item);
        }
      }
      return;
    }

    // Backwards-compatible migration for older saves without gridInventory
    this.syncWeaponSlotsFromOwned(ownedWeapons);
    for (const raw of legacyInventory) {
      const item = cloneItemInstance(raw);
      if (ITEMS[item.itemId]?.category === 'backpack' && !this.equippedBackpack) {
        this.equippedBackpack = item;
      } else {
        this.addItem(item);
      }
    }
  }

  public syncWeaponSlotsFromOwned(ownedWeapons: WeaponId[]): void {
    for (const wId of ownedWeapons) {
      if (wId === 'unarmed') continue;
      const spec = WEAPONS[wId];
      if (!spec) continue;
      if (spec.slotKind === 'primary' && !this.weaponSlots.primary) {
        this.weaponSlots.primary = wId;
      } else if (spec.slotKind === 'sidearm' && !this.weaponSlots.sidearm) {
        this.weaponSlots.sidearm = wId;
      } else if (spec.slotKind === 'melee' && !this.weaponSlots.melee) {
        this.weaponSlots.melee = wId;
      } else if (spec.slotKind === 'throwable' && !this.weaponSlots.throwable) {
        this.weaponSlots.throwable = wId;
      }
    }
  }
}

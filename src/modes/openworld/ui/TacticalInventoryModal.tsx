import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Backpack,
  Crosshair,
  HeartPulse,
  Lock,
  Package,
  RefreshCw,
  RotateCw,
  Scale,
  Shield,
  Skull,
  Trophy,
  X,
  Zap,
} from 'lucide-react';
import { AMMO_VARIANTS, BASE_CALIBERS } from '../../../../data/calibers';
import { resolveWeaponProfile } from '../../../../bodycam-sdk/weaponProfiles';
import {
  autoPlaceItemInGrid,
  BACKPACK_TEMPLATES,
  canPlaceInGrid,
  cloneCorpseLootSnapshot,
  cloneTacticalInventory,
  computeOperatorEncumbrance,
  computeTacticalItemWeightKg,
  extractItemByLocator,
  getBackpackTemplate,
  getEffectiveSize,
  isItemAllowedInBelt,
  isItemAllowedInRigMagSlot,
  isMagazineCompatibleWithWeapon,
  loadAmmoStackIntoMagazine,
  peekItemByLocator,
  peekNextRoundVariant,
  placeItemInGrid,
  stowItemIntoOperatorInventory,
  summarizeMagazineRunsTopFirst,
  unloadTopRoundsFromMagazine,
} from '../inventory/TetrisInventoryCore';
import type {
  AmmoStackItem,
  CorpseTacticalLootSnapshot,
  EncumbranceTier,
  GridContainer,
  ItemSourceLocator,
  MagazineItem,
  MedicalItem,
  OperatorTacticalInventory,
  PlacedGridItem,
  TacticalItem,
} from '../inventory/TetrisInventoryTypes';
import { ARMOR_PLATE_MAP } from '../types';

export interface ExternalLootContext {
  readonly kind: 'corpse' | 'event_crate' | 'ground_backpack';
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly lootKit: CorpseTacticalLootSnapshot;
  readonly isPracticeGear?: boolean;
}

export interface InventoryScoreboardRow {
  readonly id: string;
  readonly name: string;
  readonly team: 'A' | 'B' | 'FFA' | 'SQUAD';
  readonly kills: number;
  readonly deaths: number;
  readonly isPlayer: boolean;
  readonly points?: number;
  readonly enemyDogtags?: number;
  readonly friendlyDogtags?: number;
  readonly poiCaptures?: number;
  readonly territoryPoints?: number;
  readonly flagCaptures?: number;
  readonly flagReturns?: number;
  readonly hillControlSec?: number;
  readonly conquestEliminated?: boolean;
  readonly conquestLivesRemaining?: number;
}

export interface InventoryScoreboardData {
  readonly mode: 'battle' | 'infection';
  readonly title: string;
  readonly mapName: string;
  readonly targetLabel: string;
  readonly scoreColumnLabel: string;
  readonly battleRule?: string;
  readonly round?: number;
  readonly rows: ReadonlyArray<InventoryScoreboardRow>;
}

interface TacticalInventoryModalProps {
  inventory: OperatorTacticalInventory;
  externalLoot: ExternalLootContext | null;
  playerHp: number;
  maxHp: number;
  bleeding: boolean;
  sprintSlow: boolean;
  pdaBatteryPct?: number;
  modeLabel?: string;
  showSecureContainer?: boolean;
  allowInstantMagPack?: boolean;
  scoreboard?: InventoryScoreboardData | null;
  initialTab?: 'gear' | 'scoreboard';
  onMutateInventory: (
    nextInv: OperatorTacticalInventory,
    nextExternal?: CorpseTacticalLootSnapshot | null,
    statusNote?: string,
  ) => void;
  onTriggerDragReload: (
    weaponSlotKey: 'primary' | 'secondary',
    sourceLocator: ItemSourceLocator,
  ) => void;
  onUseMedicalItem: (
    locator: ItemSourceLocator,
    med: MedicalItem,
  ) => void;
  onUsePdaBattery?: (locator: ItemSourceLocator) => void;
  onDropEquippedBackpack?: () => void;
  onEquipGroundBackpack?: (
    containerId: string,
  ) => { ok: boolean; error?: string; requiresUnequipFirst?: boolean };
  onRestockBenchAmmo?: () => void;
  onMagPackTickAudio?: () => void;
  onClose: () => void;
}

type GridZoneKey =
  | 'chest_rig_grid'
  | 'backpack_grid'
  | 'secure_grid'
  | 'external_grid'
  | 'external_backpack_grid'
  | 'external_rig_grid';

interface DragState {
  locator: ItemSourceLocator;
  item: TacticalItem;
  rotated: boolean;
}

type MagInspectorTarget =
  | { kind: 'weapon'; slot: 'primary' | 'secondary' }
  | { kind: 'locator'; locator: ItemSourceLocator };

interface MagPackingJob {
  readonly target: MagInspectorTarget;
  readonly ammoLocator: ItemSourceLocator;
  readonly variantShort: string;
  readonly totalRounds: number;
  readonly loadedSoFar: number;
  readonly remaining: number;
}

const CELL_PX = 38;
const MAG_PACK_ROUND_MS = 185;

function itemToneClass(item: TacticalItem): string {
  switch (item.kind) {
    case 'magazine':
      return item.rounds.length > 0
        ? 'border-amber-400/50 bg-[#1d1912] text-amber-100'
        : 'border-white/15 bg-[#15181f] text-neutral-400';
    case 'ammo_stack':
      return 'border-sky-400/45 bg-[#111b24] text-sky-100';
    case 'medical':
      return 'border-emerald-400/50 bg-[#102019] text-emerald-100';
    case 'grenade':
      return 'border-red-400/50 bg-[#231214] text-red-100';
    case 'chest_rig':
    case 'backpack':
      return 'border-indigo-400/50 bg-[#141728] text-indigo-100';
    case 'intel':
    case 'key':
      return 'border-amber-300/60 bg-[#221c10] text-amber-100';
    case 'battery':
      return 'border-cyan-400/55 bg-[#0e2026] text-cyan-100';
    default:
      return 'border-white/18 bg-[#171b22] text-neutral-200';
  }
}

function itemBadgeText(item: TacticalItem): string {
  if (item.kind === 'magazine') return `${item.rounds.length}/${item.capacity}`;
  if (item.kind === 'ammo_stack') return `x${item.count}`;
  if (item.kind === 'medical') return `${item.usesRemaining}/${item.maxUses}`;
  if (item.kind === 'grenade') return `x${item.count}`;
  if (item.kind === 'battery') return `${item.chargePct}%`;
  if (item.kind === 'backpack') return `${item.grid.width}x${item.grid.height}`;
  if (item.kind === 'chest_rig') return `${item.rifleMagCapacity}R/${item.pistolMagCapacity}P`;
  return `$${item.valueUsd}`;
}

function encumbranceTone(tier: EncumbranceTier): {
  badge: string;
  bar: string;
  text: string;
  label: string;
} {
  switch (tier) {
    case 'light':
      return {
        badge: 'border-emerald-400/50 bg-emerald-950/60 text-emerald-300',
        bar: 'bg-emerald-400',
        text: 'text-emerald-300',
        label: 'LIGHT',
      };
    case 'moderate':
      return {
        badge: 'border-sky-400/50 bg-sky-950/60 text-sky-300',
        bar: 'bg-sky-400',
        text: 'text-sky-300',
        label: 'MODERATE',
      };
    case 'heavy':
      return {
        badge: 'border-amber-400/60 bg-amber-950/65 text-amber-300',
        bar: 'bg-amber-400',
        text: 'text-amber-300',
        label: 'HEAVY',
      };
    case 'overloaded':
      return {
        badge: 'border-red-500/75 bg-red-950/80 text-red-200',
        bar: 'bg-red-500',
        text: 'text-red-300',
        label: 'OVERLOADED',
      };
  }
}

function collectLooseAmmoStacks(
  inv: OperatorTacticalInventory,
  caliber: string,
  includeSecure: boolean,
): Array<{ locator: ItemSourceLocator; stack: AmmoStackItem; where: string }> {
  const out: Array<{ locator: ItemSourceLocator; stack: AmmoStackItem; where: string }> = [];
  if (inv.chestRig) {
    for (const p of inv.chestRig.generalGrid.items) {
      if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === caliber && p.item.count > 0) {
        out.push({
          locator: { zone: 'chest_rig_grid', instanceId: p.item.instanceId },
          stack: p.item,
          where: 'Chest Rig',
        });
      }
    }
  }
  if (inv.backpack) {
    for (const p of inv.backpack.grid.items) {
      if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === caliber && p.item.count > 0) {
        out.push({
          locator: { zone: 'backpack_grid', instanceId: p.item.instanceId },
          stack: p.item,
          where: 'Backpack',
        });
      }
    }
  }
  if (includeSecure) {
    for (const p of inv.secureContainer.items) {
      if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === caliber && p.item.count > 0) {
        out.push({
          locator: { zone: 'secure_grid', instanceId: p.item.instanceId },
          stack: p.item,
          where: 'Secure',
        });
      }
    }
  }
  return out;
}

function getGridByZone(
  inv: OperatorTacticalInventory,
  external: CorpseTacticalLootSnapshot | null,
  zone: GridZoneKey,
): GridContainer | null {
  switch (zone) {
    case 'chest_rig_grid':
      return inv.chestRig?.generalGrid ?? null;
    case 'backpack_grid':
      return inv.backpack?.grid ?? null;
    case 'secure_grid':
      return inv.secureContainer;
    case 'external_grid':
      return external?.looseGrid ?? null;
    case 'external_backpack_grid':
      return external?.backpack?.grid ?? null;
    case 'external_rig_grid':
      return external?.chestRig?.generalGrid ?? null;
  }
}

export const TacticalInventoryModal: React.FC<TacticalInventoryModalProps> = ({
  inventory,
  externalLoot,
  playerHp,
  maxHp,
  bleeding,
  sprintSlow,
  pdaBatteryPct,
  modeLabel,
  showSecureContainer = true,
  allowInstantMagPack = false,
  scoreboard = null,
  initialTab = 'gear',
  onMutateInventory,
  onTriggerDragReload,
  onUseMedicalItem,
  onUsePdaBattery,
  onDropEquippedBackpack,
  onEquipGroundBackpack,
  onRestockBenchAmmo,
  onMagPackTickAudio,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'gear' | 'scoreboard'>(
    scoreboard && initialTab === 'scoreboard' ? 'scoreboard' : 'gear',
  );
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverCell, setHoverCell] = useState<{ zone: GridZoneKey; x: number; y: number } | null>(
    null,
  );
  const [inspectedTarget, setInspectedTarget] = useState<MagInspectorTarget>({
    kind: 'weapon',
    slot: 'primary',
  });
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [packingJob, setPackingJob] = useState<MagPackingJob | null>(null);

  // Latest props ref so the bullet-by-bullet packing interval always mutates fresh state
  const latestRef = useRef({
    inventory,
    externalLoot,
    onMutateInventory,
    onMagPackTickAudio,
  });
  latestRef.current = {
    inventory,
    externalLoot,
    onMutateInventory,
    onMagPackTickAudio,
  };

  // Switch back to Gear tab automatically if a ground backpack / loot container opens
  useEffect(() => {
    if (externalLoot) {
      setActiveTab('gear');
    }
  }, [externalLoot]);

  // [R] rotates carried/dragged item 90°, [Esc] cancels packing/drag or closes modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyR' && drag) {
        e.preventDefault();
        e.stopPropagation();
        setDrag((prev) => (prev ? { ...prev, rotated: !prev.rotated } : null));
      } else if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (packingJob) {
          setPackingJob(null);
          setLocalNotice('Cancelled magazine packing.');
        } else if (drag) {
          setDrag(null);
          setHoverCell(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag, packingJob, onClose]);

  // Timed bullet-by-bullet magazine packing tick (realistic loading in combat & field)
  useEffect(() => {
    if (!packingJob) return;
    const timer = window.setTimeout(() => {
      const { inventory: curInv, externalLoot: curExt, onMutateInventory: emit, onMagPackTickAudio: tickAudio } =
        latestRef.current;
      const nextInv = cloneTacticalInventory(curInv);
      const nextExt = curExt ? cloneCorpseLootSnapshot(curExt.lootKit) : null;

      const targetMag =
        packingJob.target.kind === 'weapon'
          ? nextInv[packingJob.target.slot].loadedMag
          : peekItemByLocator(nextInv, packingJob.target.locator, nextExt);
      const stack = peekItemByLocator(nextInv, packingJob.ammoLocator, nextExt);

      if (
        !targetMag ||
        targetMag.kind !== 'magazine' ||
        !stack ||
        stack.kind !== 'ammo_stack' ||
        stack.count <= 0 ||
        targetMag.rounds.length >= targetMag.capacity
      ) {
        setPackingJob(null);
        return;
      }

      const res = loadAmmoStackIntoMagazine(targetMag, stack, 1);
      if (!res.ok || res.loadedCount <= 0) {
        setPackingJob(null);
        if (res.error) setLocalNotice(res.error);
        return;
      }
      if (stack.count <= 0) {
        extractItemByLocator(nextInv, packingJob.ammoLocator, nextExt);
      }

      tickAudio?.();
      const loadedSoFar = packingJob.loadedSoFar + res.loadedCount;
      const remaining = packingJob.remaining - res.loadedCount;
      const done =
        remaining <= 0 ||
        stack.count <= 0 ||
        targetMag.rounds.length >= targetMag.capacity;

      emit(
        nextInv,
        nextExt,
        done
          ? `Packed ${loadedSoFar} ${packingJob.variantShort} round(s) into ${targetMag.shortLabel}`
          : undefined,
      );

      if (done) {
        setLocalNotice(
          `Loaded +${loadedSoFar} ${packingJob.variantShort} into ${targetMag.shortLabel} (${targetMag.rounds.length}/${targetMag.capacity})`,
        );
        setPackingJob(null);
      } else {
        setPackingJob({
          ...packingJob,
          loadedSoFar,
          remaining,
        });
      }
    }, MAG_PACK_ROUND_MS);

    return () => window.clearTimeout(timer);
  }, [packingJob]);

  const encumbrance = useMemo(() => computeOperatorEncumbrance(inventory), [inventory]);
  const encTone = encumbranceTone(encumbrance.tier);
  const weightBarPct = Math.min(
    100,
    Math.round((encumbrance.totalWeightKg / Math.max(1, encumbrance.maxKg)) * 100),
  );
  const comfortMarkerPct = Math.round(
    (encumbrance.comfortableKg / Math.max(1, encumbrance.maxKg)) * 100,
  );
  const heavyMarkerPct = Math.round(
    (encumbrance.heavyKg / Math.max(1, encumbrance.maxKg)) * 100,
  );

  const inspectedMag: MagazineItem | null = useMemo(() => {
    if (inspectedTarget.kind === 'weapon') {
      return inventory[inspectedTarget.slot].loadedMag;
    }
    const found = peekItemByLocator(
      inventory,
      inspectedTarget.locator,
      externalLoot?.lootKit ?? null,
    );
    return found && found.kind === 'magazine' ? found : null;
  }, [inspectedTarget, inventory, externalLoot]);

  const inspectedRuns = useMemo(
    () => (inspectedMag ? summarizeMagazineRunsTopFirst(inspectedMag) : []),
    [inspectedMag],
  );

  const compatibleAmmoStacks = useMemo(
    () =>
      inspectedMag
        ? collectLooseAmmoStacks(inventory, inspectedMag.baseCaliber, showSecureContainer)
        : [],
    [inspectedMag, inventory, showSecureContainer],
  );

  const commit = (
    mutator: (
      inv: OperatorTacticalInventory,
      ext: CorpseTacticalLootSnapshot | null,
    ) => string | void,
  ) => {
    const nextInv = cloneTacticalInventory(inventory);
    const nextExt = externalLoot ? cloneCorpseLootSnapshot(externalLoot.lootKit) : null;
    const note = mutator(nextInv, nextExt);
    const noteText = typeof note === 'string' ? note : undefined;
    if (noteText) setLocalNotice(noteText);
    onMutateInventory(nextInv, nextExt, noteText);
  };

  const beginDrag = (locator: ItemSourceLocator, item: TacticalItem, rotated = false) => {
    if (packingJob) setPackingJob(null);
    setDrag({ locator, item, rotated });
    setLocalNotice(null);
    if (item.kind === 'magazine') {
      setInspectedTarget({ kind: 'locator', locator });
    }
  };

  const startPackingRounds = (
    target: MagInspectorTarget,
    ammoLocator: ItemSourceLocator,
    requestedCount: number,
    instant = false,
  ) => {
    const targetMag =
      target.kind === 'weapon'
        ? inventory[target.slot].loadedMag
        : peekItemByLocator(inventory, target.locator, externalLoot?.lootKit ?? null);
    if (!targetMag || targetMag.kind !== 'magazine') {
      setLocalNotice('Select a magazine first.');
      return;
    }
    const stack = peekItemByLocator(inventory, ammoLocator, externalLoot?.lootKit ?? null);
    if (!stack || stack.kind !== 'ammo_stack' || stack.count <= 0) {
      setLocalNotice('Ammo stack unavailable.');
      return;
    }
    if (stack.baseCaliber !== targetMag.baseCaliber) {
      setLocalNotice(
        `Caliber mismatch: ${BASE_CALIBERS[stack.baseCaliber]?.shortLabel ?? stack.baseCaliber} cannot load into ${BASE_CALIBERS[targetMag.baseCaliber]?.shortLabel ?? targetMag.baseCaliber} mag.`,
      );
      return;
    }
    const freeSpace = targetMag.capacity - targetMag.rounds.length;
    if (freeSpace <= 0) {
      setLocalNotice(`${targetMag.shortLabel} is already full.`);
      return;
    }
    const countToLoad = Math.min(freeSpace, stack.count, Math.max(1, requestedCount));
    const variantShort = AMMO_VARIANTS[stack.variantId]?.shortName ?? stack.shortLabel;

    // Single round or bench instant-pack completes immediately; multi-round loads bullet-by-bullet!
    if (instant || countToLoad === 1) {
      commit((inv, ext) => {
        const mag =
          target.kind === 'weapon'
            ? inv[target.slot].loadedMag
            : peekItemByLocator(inv, target.locator, ext);
        const src = peekItemByLocator(inv, ammoLocator, ext);
        if (!mag || mag.kind !== 'magazine' || !src || src.kind !== 'ammo_stack') {
          return 'Could not load rounds.';
        }
        const res = loadAmmoStackIntoMagazine(mag, src, countToLoad);
        if (!res.ok) return res.error ?? 'Could not pack rounds.';
        if (src.count <= 0) {
          extractItemByLocator(inv, ammoLocator, ext);
        }
        onMagPackTickAudio?.();
        return `Loaded +${res.loadedCount} ${variantShort} into ${mag.shortLabel} (${mag.rounds.length}/${mag.capacity})`;
      });
      return;
    }

    setInspectedTarget(target);
    setPackingJob({
      target,
      ammoLocator,
      variantShort,
      totalRounds: countToLoad,
      loadedSoFar: 0,
      remaining: countToLoad,
    });
    setLocalNotice(`Packing ${countToLoad} ${variantShort} round(s) into ${targetMag.shortLabel}...`);
  };

  const handleDropOnGridCell = (zone: GridZoneKey, cellX: number, cellY: number) => {
    if (!drag) return;
    if (
      (drag.item.kind === 'backpack' && (zone === 'backpack_grid' || zone === 'external_backpack_grid')) ||
      (drag.item.kind === 'chest_rig' && zone === 'chest_rig_grid')
    ) {
      setLocalNotice('Cannot nest a backpack or chest rig inside itself.');
      setDrag(null);
      return;
    }

    commit((inv, ext) => {
      const targetGrid = getGridByZone(inv, ext, zone);
      if (!targetGrid) return 'Container unavailable.';

      const sameGrid = drag.locator.zone === zone;
      const ignoreId = sameGrid ? drag.item.instanceId : undefined;
      if (!canPlaceInGrid(targetGrid, drag.item, cellX, cellY, drag.rotated, ignoreId)) {
        return `Does not fit at (${cellX},${cellY}). Press [R] to rotate.`;
      }
      const extracted = extractItemByLocator(inv, drag.locator, ext);
      if (!extracted) return 'Failed to move item.';
      placeItemInGrid(targetGrid, extracted, cellX, cellY, drag.rotated);
      return `Placed ${extracted.shortLabel} in ${targetGrid.label}`;
    });
    setDrag(null);
    setHoverCell(null);
  };

  const handleDropAmmoOnMagazine = (
    targetLocator: ItemSourceLocator | { weaponSlot: 'primary' | 'secondary' },
  ) => {
    if (!drag || drag.item.kind !== 'ammo_stack') return;
    const target: MagInspectorTarget =
      'weaponSlot' in targetLocator
        ? { kind: 'weapon', slot: targetLocator.weaponSlot }
        : { kind: 'locator', locator: targetLocator };
    const ammoLoc = drag.locator;
    const qty = drag.item.count;
    setDrag(null);
    startPackingRounds(target, ammoLoc, qty, allowInstantMagPack);
  };

  const handleDropOnBeltSlot = (slotIndex: number) => {
    if (!drag) return;
    const existing = inventory.beltSlots[slotIndex];
    if (existing?.kind === 'magazine' && drag.item.kind === 'ammo_stack') {
      handleDropAmmoOnMagazine({ zone: 'belt', slotIndex });
      return;
    }
    if (!isItemAllowedInBelt(drag.item)) {
      setLocalNotice('Belt slots only accept Grenades, Medical Kits, or Magazines.');
      setDrag(null);
      return;
    }
    if (existing) {
      setLocalNotice('Belt slot occupied — move existing item first.');
      setDrag(null);
      return;
    }
    commit((inv, ext) => {
      const extracted = extractItemByLocator(inv, drag.locator, ext);
      if (!extracted) return 'Move failed.';
      inv.beltSlots[slotIndex] = extracted;
      return `Slotted ${extracted.shortLabel} onto Belt B${slotIndex + 1}`;
    });
    setDrag(null);
  };

  const handleDropOnRigMagSlot = (slotType: 'rifle' | 'pistol', slotIndex: number) => {
    if (!drag || !inventory.chestRig) return;
    const arr =
      slotType === 'rifle'
        ? inventory.chestRig.rifleMagSlots
        : inventory.chestRig.pistolMagSlots;
    const existing = arr[slotIndex];
    if (existing && drag.item.kind === 'ammo_stack') {
      handleDropAmmoOnMagazine({
        zone: slotType === 'rifle' ? 'chest_rig_rifle' : 'chest_rig_pistol',
        slotIndex,
      });
      return;
    }
    if (!isItemAllowedInRigMagSlot(drag.item, slotType)) {
      setLocalNotice(
        slotType === 'rifle'
          ? 'Rifle Mag Slot requires a Rifle / Carbine / SMG Magazine.'
          : 'Pistol Mag Slot requires a Pistol Magazine.',
      );
      setDrag(null);
      return;
    }
    if (existing) {
      setLocalNotice('Rig mag pouch already occupied.');
      setDrag(null);
      return;
    }
    commit((inv, ext) => {
      if (!inv.chestRig) return 'No Chest Rig equipped.';
      const extracted = extractItemByLocator(inv, drag.locator, ext);
      if (!extracted || extracted.kind !== 'magazine') return 'Move failed.';
      if (slotType === 'rifle') inv.chestRig.rifleMagSlots[slotIndex] = extracted;
      else inv.chestRig.pistolMagSlots[slotIndex] = extracted;
      return `Seated ${extracted.shortLabel} in Chest Rig (${slotType} pouch)`;
    });
    setDrag(null);
  };

  const handleDropOnWeaponSlot = (weaponSlotKey: 'primary' | 'secondary') => {
    if (!drag) return;
    const wSlot = inventory[weaponSlotKey];
    if (!wSlot.weaponId || wSlot.weaponId === 'unarmed') {
      setLocalNotice('No firearm in this weapon slot.');
      setDrag(null);
      return;
    }
    if (drag.item.kind === 'ammo_stack' && wSlot.loadedMag) {
      handleDropAmmoOnMagazine({ weaponSlot: weaponSlotKey });
      return;
    }
    if (drag.item.kind !== 'magazine') {
      setLocalNotice('Drag a loaded compatible Magazine onto the weapon to reload.');
      setDrag(null);
      return;
    }
    if (!isMagazineCompatibleWithWeapon(drag.item, wSlot.weaponId)) {
      setLocalNotice(
        `Incompatible mag (${drag.item.shortLabel}) for ${resolveWeaponProfile(wSlot.weaponId).name}.`,
      );
      setDrag(null);
      return;
    }
    if (drag.item.rounds.length <= 0) {
      setLocalNotice('Magazine is empty — load rounds into it before reloading.');
      setDrag(null);
      return;
    }
    const loc = drag.locator;
    setDrag(null);
    onTriggerDragReload(weaponSlotKey, loc);
  };

  const handleUnloadFromInspector = (count: number) => {
    if (packingJob) setPackingJob(null);
    commit((inv, ext) => {
      const targetMag =
        inspectedTarget.kind === 'weapon'
          ? inv[inspectedTarget.slot].loadedMag
          : peekItemByLocator(inv, inspectedTarget.locator, ext);
      if (!targetMag || targetMag.kind !== 'magazine') return 'Select a magazine first.';
      if (targetMag.rounds.length === 0) return 'Magazine is already empty.';
      const stacks = unloadTopRoundsFromMagazine(targetMag, count);
      let stowedCount = 0;
      for (const s of stacks) {
        const qty = s.count;
        const placed =
          (inv.backpack && autoPlaceItemInGrid(inv.backpack.grid, s, true)) ||
          (inv.chestRig && autoPlaceItemInGrid(inv.chestRig.generalGrid, s, true)) ||
          (showSecureContainer && autoPlaceItemInGrid(inv.secureContainer, s, true));
        if (placed) {
          stowedCount += qty;
        } else {
          for (let i = 0; i < s.count; i++) targetMag.rounds.push(s.variantId);
        }
      }
      return stowedCount > 0
        ? `Unloaded ${stowedCount} top round(s) into loose stacks`
        : 'No grid space for unloaded ammo stacks.';
    });
  };

  const handleUnequipGear = (gearKind: 'chest_rig' | 'backpack') => {
    if (packingJob) setPackingJob(null);
    if (gearKind === 'backpack' && onDropEquippedBackpack) {
      onDropEquippedBackpack();
      setLocalNotice('Dropped backpack onto the ground with all its contents intact.');
      return;
    }
    commit((inv, ext) => {
      if (gearKind === 'chest_rig' && inv.chestRig) {
        const rig = inv.chestRig;
        const placed =
          (inv.backpack && autoPlaceItemInGrid(inv.backpack.grid, rig, true)) ||
          (ext && autoPlaceItemInGrid(ext.looseGrid, rig, true));
        if (!placed) {
          return 'No space in Backpack or Loot Crate to stow Chest Rig.';
        }
        inv.chestRig = null;
        return `Unequipped ${rig.shortLabel} ([R] quick-reload now limited to Belt/Pack mags)`;
      }
      if (gearKind === 'backpack' && inv.backpack) {
        const pack = inv.backpack;
        if (ext && !ext.backpack) {
          ext.backpack = pack;
          inv.backpack = null;
          return `Dropped ${pack.shortLabel} (with ${pack.grid.items.length} nested items) into Loot Container`;
        }
        return 'No drop handler active for this container.';
      }
      return 'Nothing equipped.';
    });
  };

  const handleEquipGroundPackClick = () => {
    if (!externalLoot || externalLoot.kind !== 'ground_backpack') return;
    if (packingJob) setPackingJob(null);
    if (inventory.backpack) {
      setLocalNotice('Drop your currently equipped backpack first before putting this one on.');
      return;
    }
    if (onEquipGroundBackpack) {
      const res = onEquipGroundBackpack(externalLoot.id);
      if (!res.ok && res.error) {
        setLocalNotice(res.error);
      }
      return;
    }
    // Fallback if no world handler provided
    handleEquipGearFromExternal('backpack');
  };

  const handleEquipGearFromExternal = (gearKind: 'chest_rig' | 'backpack') => {
    if (packingJob) setPackingJob(null);
    if (gearKind === 'backpack' && externalLoot?.kind === 'ground_backpack') {
      handleEquipGroundPackClick();
      return;
    }
    if (gearKind === 'backpack' && inventory.backpack) {
      setLocalNotice('Drop your currently equipped backpack first before equipping another pack.');
      return;
    }
    commit((inv, ext) => {
      if (!ext) return 'No external container.';
      if (gearKind === 'backpack' && ext.backpack) {
        inv.backpack = ext.backpack;
        ext.backpack = null;
        return `Equipped ${inv.backpack.shortLabel} (${inv.backpack.grid.items.length} nested items intact)`;
      }
      if (gearKind === 'chest_rig' && ext.chestRig) {
        const prev = inv.chestRig;
        inv.chestRig = ext.chestRig;
        ext.chestRig = prev;
        return `Equipped ${inv.chestRig.shortLabel}`;
      }
      return 'Gear item unavailable.';
    });
  };

  const handleEquipGearFromGrid = (locator: ItemSourceLocator) => {
    if (packingJob) setPackingJob(null);
    commit((inv, ext) => {
      const target = peekItemByLocator(inv, locator, ext);
      if (!target) return 'Item not found.';
      if (target.kind === 'chest_rig') {
        const extracted = extractItemByLocator(inv, locator, ext);
        if (!extracted || extracted.kind !== 'chest_rig') return 'Failed.';
        const prev = inv.chestRig;
        inv.chestRig = extracted;
        if (prev) stowItemIntoOperatorInventory(inv, prev);
        return `Equipped ${extracted.shortLabel}`;
      }
      if (target.kind === 'backpack') {
        if (inv.backpack) {
          return 'Drop your currently equipped backpack first before putting this pack on.';
        }
        const extracted = extractItemByLocator(inv, locator, ext);
        if (!extracted || extracted.kind !== 'backpack') return 'Failed.';
        inv.backpack = extracted;
        return `Equipped ${extracted.shortLabel} (${extracted.grid.items.length} items intact)`;
      }
      return 'Not equippable gear.';
    });
  };

  const handleQuickLootFromExternal = (locator: ItemSourceLocator) => {
    commit((inv, ext) => {
      const extracted = extractItemByLocator(inv, locator, ext);
      if (!extracted) return 'Item unavailable.';
      if (stowItemIntoOperatorInventory(inv, extracted)) {
        return `Transferred ${extracted.shortLabel} into your gear`;
      }
      // Put back if full
      if (ext) {
        if (locator.zone === 'external_backpack_grid' && ext.backpack) {
          autoPlaceItemInGrid(ext.backpack.grid, extracted, true);
        } else {
          autoPlaceItemInGrid(ext.looseGrid, extracted, true);
        }
      }
      return `No Tetris space for ${extracted.shortLabel}.`;
    });
  };

  const handleQuickTransferToGroundPack = (locator: ItemSourceLocator) => {
    if (!externalLoot?.lootKit.backpack) return;
    commit((inv, ext) => {
      if (!ext?.backpack) return 'Ground backpack unavailable.';
      const peek = peekItemByLocator(inv, locator, ext);
      if (!peek) return 'Item unavailable.';
      if (peek.kind === 'backpack') return 'Cannot place a backpack inside another backpack.';
      const extracted = extractItemByLocator(inv, locator, ext);
      if (!extracted) return 'Item unavailable.';
      if (autoPlaceItemInGrid(ext.backpack.grid, extracted, true)) {
        return `Stowed ${extracted.shortLabel} into ${ext.backpack.shortLabel}`;
      }
      stowItemIntoOperatorInventory(inv, extracted);
      return `No space left inside ${ext.backpack.shortLabel}.`;
    });
  };

  const renderTetrisGrid = (
    grid: GridContainer,
    zone: GridZoneKey,
    accentBorder = 'border-white/15',
  ) => {
    const hoverValid =
      drag && hoverCell && hoverCell.zone === zone
        ? canPlaceInGrid(
            grid,
            drag.item,
            hoverCell.x,
            hoverCell.y,
            drag.rotated,
            drag.locator.zone === zone ? drag.item.instanceId : undefined,
          )
        : false;
    const ghostSize = drag ? getEffectiveSize(drag.item, drag.rotated) : null;

    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between font-mono-tabular text-[11px] text-neutral-400">
          <span className="font-semibold text-neutral-200">{grid.label}</span>
          <span>
            {grid.width}x{grid.height} · {grid.items.length} item(s)
          </span>
        </div>

        <div
          className={`relative border ${accentBorder} bg-[#090c10] select-none`}
          style={{
            width: grid.width * CELL_PX + 2,
            height: grid.height * CELL_PX + 2,
          }}
          onMouseLeave={() => {
            if (hoverCell?.zone === zone) setHoverCell(null);
          }}
        >
          {/* Background cell matrix */}
          {Array.from({ length: grid.height }).map((_, cy) =>
            Array.from({ length: grid.width }).map((__, cx) => (
              <div
                key={`${cx}_${cy}`}
                onMouseEnter={() => drag && setHoverCell({ zone, x: cx, y: cy })}
                onClick={() => drag && handleDropOnGridCell(zone, cx, cy)}
                className="absolute border border-white/[0.06] hover:bg-white/[0.04]"
                style={{
                  left: cx * CELL_PX,
                  top: cy * CELL_PX,
                  width: CELL_PX,
                  height: CELL_PX,
                }}
              />
            )),
          )}

          {/* Hover ghost footprint */}
          {drag && hoverCell && hoverCell.zone === zone && ghostSize && (
            <div
              className={`pointer-events-none absolute z-20 border-2 ${
                hoverValid
                  ? 'border-emerald-400 bg-emerald-500/20'
                  : 'border-red-500 bg-red-500/25'
              }`}
              style={{
                left: hoverCell.x * CELL_PX,
                top: hoverCell.y * CELL_PX,
                width: Math.min(grid.width - hoverCell.x, ghostSize.w) * CELL_PX,
                height: Math.min(grid.height - hoverCell.y, ghostSize.h) * CELL_PX,
              }}
            />
          )}

          {/* Placed Tetris items */}
          {grid.items.map((placed: PlacedGridItem) => {
            const { w, h } = getEffectiveSize(placed.item, placed.rotated);
            const loc: ItemSourceLocator = { zone, instanceId: placed.item.instanceId };
            const itemKg = computeTacticalItemWeightKg(placed.item);
            const isCarried =
              drag &&
              drag.locator.zone === zone &&
              'instanceId' in drag.locator &&
              drag.locator.instanceId === placed.item.instanceId;
            const isSelectedMag =
              inspectedTarget.kind === 'locator' &&
              inspectedTarget.locator.zone === zone &&
              'instanceId' in inspectedTarget.locator &&
              inspectedTarget.locator.instanceId === placed.item.instanceId;

            return (
              <div
                key={placed.item.instanceId}
                onClick={(e) => {
                  e.stopPropagation();
                  if (drag) {
                    if (drag.item.kind === 'ammo_stack' && placed.item.kind === 'magazine') {
                      handleDropAmmoOnMagazine(loc);
                      return;
                    }
                    handleDropOnGridCell(zone, placed.x, placed.y);
                    return;
                  }
                  beginDrag(loc, placed.item, placed.rotated);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (placed.item.kind === 'medical' && !zone.startsWith('external_')) {
                    onUseMedicalItem(loc, placed.item);
                  } else if (
                    placed.item.kind === 'battery' &&
                    !zone.startsWith('external_') &&
                    onUsePdaBattery
                  ) {
                    onUsePdaBattery(loc);
                  } else if (placed.item.kind === 'magazine') {
                    setInspectedTarget({ kind: 'locator', locator: loc });
                  } else if (placed.item.kind === 'chest_rig' || placed.item.kind === 'backpack') {
                    handleEquipGearFromGrid(loc);
                  } else if (zone.startsWith('external_')) {
                    handleQuickLootFromExternal(loc);
                  } else if (externalLoot?.kind === 'ground_backpack' && externalLoot.lootKit.backpack) {
                    handleQuickTransferToGroundPack(loc);
                  }
                }}
                title={`${placed.item.name} (${w}x${h} · ${itemKg.toFixed(2)} kg) — Click to pick up/drop · Right-click to inspect/use/transfer`}
                className={`absolute z-10 flex cursor-pointer flex-col justify-between overflow-hidden border p-1 transition-colors ${itemToneClass(placed.item)} ${
                  isCarried ? 'opacity-40 ring-1 ring-amber-400' : 'hover:brightness-125'
                } ${isSelectedMag ? 'ring-1 ring-amber-300' : ''}`}
                style={{
                  left: placed.x * CELL_PX + 1,
                  top: placed.y * CELL_PX + 1,
                  width: w * CELL_PX - 2,
                  height: h * CELL_PX - 2,
                }}
              >
                <div className="truncate font-mono-tabular text-[10px] font-semibold leading-tight">
                  {placed.item.shortLabel}
                </div>
                <div className="flex items-end justify-between gap-0.5 font-mono-tabular text-[9px] text-neutral-300">
                  <span className="truncate">{itemBadgeText(placed.item)}</span>
                  {placed.item.kind === 'medical' && !zone.startsWith('external_') && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onUseMedicalItem(loc, placed.item as MedicalItem);
                      }}
                      className="border border-emerald-400/60 bg-emerald-950/90 px-1 text-[8px] font-semibold text-emerald-200 hover:bg-emerald-800"
                    >
                      USE
                    </button>
                  )}
                  {placed.item.kind === 'battery' && !zone.startsWith('external_') && onUsePdaBattery && (
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onUsePdaBattery(loc);
                      }}
                      className="border border-cyan-400/60 bg-cyan-950/90 px-1 text-[8px] font-semibold text-cyan-200 hover:bg-cyan-800"
                    >
                      PDA
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderWeaponCard = (slotKey: 'primary' | 'secondary', label: string) => {
    const slot = inventory[slotKey];
    const prof = slot.weaponId && slot.weaponId !== 'unarmed' ? resolveWeaponProfile(slot.weaponId) : null;
    const nextRound = peekNextRoundVariant(slot);
    const totalLoaded = (slot.chamberedRound ? 1 : 0) + (slot.loadedMag?.rounds.length ?? 0);
    const canDropReload =
      drag &&
      drag.item.kind === 'magazine' &&
      slot.weaponId &&
      isMagazineCompatibleWithWeapon(drag.item, slot.weaponId) &&
      drag.item.rounds.length > 0;

    return (
      <div
        onClick={() => drag && handleDropOnWeaponSlot(slotKey)}
        className={`border p-2.5 transition-colors ${
          canDropReload
            ? 'cursor-pointer border-emerald-400 bg-emerald-950/30'
            : 'border-white/14 bg-[#12161e]'
        }`}
      >
        <div className="flex items-center justify-between font-mono-tabular text-[11px]">
          <span className="font-semibold text-neutral-400">{label}</span>
          {prof && <span className="text-neutral-300">{prof.caliberLabel}</span>}
        </div>

        {prof ? (
          <>
            <div className="mt-1 flex items-center justify-between">
              <div className="text-xs font-semibold text-neutral-50">{prof.name}</div>
              <span className="font-mono-tabular text-xs font-semibold text-amber-300">
                {totalLoaded}/{slot.loadedMag?.capacity ?? prof.magCapacity}
              </span>
            </div>

            <div className="mt-1.5 flex items-center justify-between gap-2 font-mono-tabular text-[11px]">
              <span className="text-neutral-400">
                Chamber:{' '}
                <strong className="text-sky-200">
                  {nextRound ? `${nextRound.shortName} (PEN ${nextRound.penetrationRating})` : 'EMPTY'}
                </strong>
              </span>
              {slot.loadedMag && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setInspectedTarget({ kind: 'weapon', slot: slotKey });
                  }}
                  className="cursor-pointer border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] text-neutral-200 hover:border-amber-400/60"
                >
                  Inspect Mag
                </button>
              )}
            </div>

            {canDropReload && (
              <div className="mt-1.5 border border-emerald-400/60 bg-emerald-950/60 px-2 py-1 font-mono-tabular text-[10px] font-semibold text-emerald-200">
                CLICK TO DRAG-RELOAD ({drag.item.shortLabel}) — TRIGGERS 1P RELOAD ANIMATION
              </div>
            )}
          </>
        ) : (
          <div className="mt-1 font-mono-tabular text-[11px] text-neutral-500">Empty Weapon Slot</div>
        )}
      </div>
    );
  };

  const plateSpec = inventory.armorPlateId ? ARMOR_PLATE_MAP[inventory.armorPlateId] : null;
  const equippedPackTpl = inventory.backpack
    ? getBackpackTemplate(inventory.backpack.templateId)
    : null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-4"
      onClick={() => {
        if (drag) {
          setDrag(null);
          setHoverCell(null);
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-[1380px] flex-col border border-white/18 bg-[#0b0e13] text-neutral-100 shadow-2xl"
      >
        {/* Top Bar: Title, Optional Match Scoreboard Tabs, Live Weight/Encumbrance Meter & Close */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/12 bg-[#10141c] px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-amber-400" />
              <span className="font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-100">
                {modeLabel ? `${modeLabel} · Tactical Inventory` : 'Operator Tactical Rig & Tetris Inventory'}
              </span>
            </div>

            {/* Integrated Gear | Scoreboard Switcher for Battle & Infection */}
            {scoreboard && (
              <div className="flex border border-white/15 bg-black/45 font-mono-tabular text-[11px]">
                <button
                  type="button"
                  onClick={() => setActiveTab('gear')}
                  className={`flex cursor-pointer items-center gap-1.5 px-3 py-1 font-semibold uppercase tracking-wider transition-colors ${
                    activeTab === 'gear'
                      ? 'bg-amber-500/20 text-amber-200'
                      : 'text-neutral-400 hover:text-neutral-100'
                  }`}
                >
                  <Backpack className="h-3.5 w-3.5" />
                  <span>Tactical Gear</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('scoreboard')}
                  className={`flex cursor-pointer items-center gap-1.5 border-l border-white/15 px-3 py-1 font-semibold uppercase tracking-wider transition-colors ${
                    activeTab === 'scoreboard'
                      ? 'bg-amber-500/20 text-amber-200'
                      : 'text-neutral-400 hover:text-neutral-100'
                  }`}
                >
                  <Trophy className="h-3.5 w-3.5" />
                  <span>Scoreboard</span>
                </button>
              </div>
            )}

            <span className="border border-white/12 bg-black/40 px-2 py-0.5 font-mono-tabular text-[11px] text-neutral-300">
              HP {Math.round(playerHp)}/{Math.round(maxHp)}
              {bleeding ? ' · BLEEDING' : ''}
              {sprintSlow ? ' · LEG TRAUMA' : ''}
              {typeof pdaBatteryPct === 'number' ? ` · PDA ${Math.round(pdaBatteryPct)}%` : ''}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px]">
            {/* Live Weight & Encumbrance Readout */}
            <div className="flex items-center gap-2.5 border border-white/14 bg-[#090c10] px-2.5 py-1">
              <Scale className={`h-3.5 w-3.5 ${encTone.text}`} />
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="font-semibold text-neutral-100">
                    {encumbrance.totalWeightKg.toFixed(1)} / {encumbrance.maxKg.toFixed(0)} kg
                  </span>
                  <span className={`border px-1 py-px text-[9px] font-bold uppercase ${encTone.badge}`}>
                    {encTone.label}
                  </span>
                  <span className="text-neutral-400">
                    SPD {Math.round(encumbrance.moveSpeedMult * 100)}%
                    {!encumbrance.canSprint ? ' · NO SPRINT' : ''}
                  </span>
                </div>
                <div className="relative h-1.5 w-44 overflow-hidden bg-neutral-800">
                  <div
                    className={`h-full transition-all ${encTone.bar}`}
                    style={{ width: `${weightBarPct}%` }}
                  />
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/40"
                    style={{ left: `${comfortMarkerPct}%` }}
                  />
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-amber-300/60"
                    style={{ left: `${heavyMarkerPct}%` }}
                  />
                </div>
              </div>
            </div>

            {onRestockBenchAmmo && (
              <button
                type="button"
                onClick={() => {
                  onRestockBenchAmmo();
                  setLocalNotice('Restocked bench loose ammo & spare magazines.');
                }}
                className="flex cursor-pointer items-center gap-1 border border-emerald-400/50 bg-emerald-950/50 px-2 py-1 text-[10px] font-semibold text-emerald-200 hover:bg-emerald-900/60"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Restock Ammo</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-1 border border-white/15 bg-[#151a24] px-2.5 py-1 text-xs text-neutral-200 hover:border-amber-400/60"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close [Tab]</span>
            </button>
          </div>
        </div>

        {/* Sub-bar: Held item controls or quick hints */}
        {activeTab === 'gear' && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#0d1118] px-4 py-1.5 font-mono-tabular text-[11px]">
            {drag ? (
              <div className="flex items-center gap-2 text-amber-200">
                <span>
                  HOLDING: <strong>{drag.item.shortLabel}</strong> ({getEffectiveSize(drag.item, drag.rotated).w}x
                  {getEffectiveSize(drag.item, drag.rotated).h})
                </span>
                <button
                  type="button"
                  onClick={() => setDrag((d) => (d ? { ...d, rotated: !d.rotated } : null))}
                  className="flex cursor-pointer items-center gap-1 border border-amber-400/60 bg-black/50 px-1.5 py-0.5 text-[10px] hover:bg-amber-900/50"
                >
                  <RotateCw className="h-3 w-3" />
                  <span>[R] Rotate</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDrag(null)}
                  className="cursor-pointer border border-white/20 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:text-white"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <span className="text-neutral-400">
                Click item to pick up/move · [R] Rotate · Drop Ammo on Mag to load · Drop Mag on Weapon to 1P Reload
              </span>
            )}
            {localNotice && <span className="text-amber-300">{localNotice}</span>}
          </div>
        )}

        {/* === SCOREBOARD TAB (Battle & Infection) === */}
        {activeTab === 'scoreboard' && scoreboard ? (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="mx-auto max-w-3xl border border-white/15 bg-[#10141c] p-4">
              <div className="flex items-center justify-between border-b border-white/12 pb-2.5">
                <div>
                  <div className="font-display text-lg font-bold uppercase tracking-wider text-neutral-50">
                    {scoreboard.title} · {scoreboard.mapName}
                  </div>
                  {typeof scoreboard.round === 'number' && (
                    <div className="font-mono-tabular text-xs text-red-400">
                      Round {scoreboard.round}
                    </div>
                  )}
                </div>
                <span className="border border-white/12 bg-black/40 px-2.5 py-1 font-mono-tabular text-xs text-neutral-300">
                  {scoreboard.targetLabel}
                </span>
              </div>

              <div className="mt-3 flex flex-col gap-1 font-mono-tabular text-xs">
                <div className="grid grid-cols-12 px-2.5 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
                  <span className="col-span-4">Operator</span>
                  <span className="col-span-2">Unit</span>
                  <span className="col-span-3 text-right text-amber-400">
                    {scoreboard.scoreColumnLabel}
                  </span>
                  <span className="col-span-1 text-right">K</span>
                  <span className="col-span-2 text-right">
                    {scoreboard.mode === 'infection' ? 'DOWNS' : 'D'}
                  </span>
                </div>
                {scoreboard.rows.map((row) => (
                  <div
                    key={row.id}
                    className={`grid grid-cols-12 items-center px-2.5 py-2 ${
                      row.isPlayer
                        ? 'border border-amber-500/50 bg-amber-500/10 text-amber-200'
                        : 'bg-[#0b0f16] text-neutral-200'
                    }`}
                  >
                    <span className="col-span-4 truncate font-semibold">
                      {row.name}
                      {scoreboard.battleRule === 'conquest' && (
                        <span
                          className={`ml-1.5 text-[9px] uppercase ${
                            row.conquestEliminated ? 'text-red-400' : 'text-neutral-400'
                          }`}
                        >
                          {row.conquestEliminated
                            ? 'OUT'
                            : row.conquestLivesRemaining !== undefined
                              ? `[${row.conquestLivesRemaining}L]`
                              : ''}
                        </span>
                      )}
                    </span>
                    <span
                      className={`col-span-2 text-[11px] ${
                        row.team === 'A' || row.team === 'SQUAD'
                          ? 'text-sky-400'
                          : row.team === 'B'
                            ? 'text-orange-400'
                            : 'text-neutral-400'
                      }`}
                    >
                      {row.team === 'FFA'
                        ? 'SOLO'
                        : row.team === 'SQUAD'
                          ? 'SQUAD'
                          : `TEAM ${row.team}`}
                    </span>
                    <span className="col-span-3 text-right font-semibold text-amber-300">
                      {scoreboard.mode === 'infection'
                        ? `${row.points ?? 0} PTS`
                        : scoreboard.battleRule === 'kc' || scoreboard.battleRule === 'kc_ffa'
                          ? `${row.enemyDogtags ?? 0} / ${row.friendlyDogtags ?? 0}`
                          : scoreboard.battleRule === 'conquest'
                            ? `${row.poiCaptures ?? 0} · ${Math.round(row.territoryPoints ?? 0)}pt`
                            : scoreboard.battleRule === 'ctf'
                              ? `${row.flagCaptures ?? 0} / ${row.flagReturns ?? 0}`
                              : scoreboard.battleRule === 'koth'
                                ? `${Math.round(row.hillControlSec ?? 0)}s`
                                : `${row.kills}`}
                    </span>
                    <span className="col-span-1 text-right font-semibold">{row.kills}</span>
                    <span className="col-span-2 text-right text-neutral-400">{row.deaths}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* === TACTICAL GEAR 3-COLUMN BODY === */
          <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[310px_minmax(0,1fr)_370px]">
            {/* COLUMN 1: Equipped Weapons, Armor, Tactical Belt, Gear Slots, Optional Secure Container */}
            <div className="space-y-3">
              {renderWeaponCard('primary', 'PRIMARY WEAPON (1)')}
              {renderWeaponCard('secondary', 'SIDEARM (2)')}

              {/* Armor Plate */}
              <div className="flex items-center justify-between border border-white/12 bg-[#12161e] px-2.5 py-2 font-mono-tabular text-[11px]">
                <span className="flex items-center gap-1.5 text-neutral-400">
                  <Shield className="h-3.5 w-3.5 text-sky-400" />
                  <span>Armor Plate</span>
                </span>
                <span className="font-semibold text-neutral-100">
                  {plateSpec ? `${plateSpec.ratingLabel} (${plateSpec.durability})` : 'None'}
                </span>
              </div>

              {/* Tactical Belt (4 Quick Slots: Grenades / Meds / Mags ONLY) */}
              <div className="space-y-1.5 border border-white/12 bg-[#10141c] p-2.5">
                <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                  <span className="font-semibold text-neutral-200">TACTICAL BELT (4 SLOTS)</span>
                  <span className="text-[10px] text-neutral-400">GRENADE / MED / MAG</span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {inventory.beltSlots.map((item, idx) => {
                    const loc: ItemSourceLocator = { zone: 'belt', slotIndex: idx };
                    return (
                      <div
                        key={idx}
                        onClick={() => {
                          if (drag) {
                            handleDropOnBeltSlot(idx);
                          } else if (item) {
                            beginDrag(loc, item, false);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (item?.kind === 'medical') onUseMedicalItem(loc, item);
                          else if (item?.kind === 'magazine') {
                            setInspectedTarget({ kind: 'locator', locator: loc });
                          }
                        }}
                        className={`flex h-14 cursor-pointer flex-col justify-between border p-1 font-mono-tabular text-[10px] ${
                          item
                            ? itemToneClass(item)
                            : 'border-dashed border-white/15 bg-[#090c10] text-neutral-600 hover:border-amber-400/50'
                        }`}
                      >
                        <span className="truncate font-semibold">
                          {item ? item.shortLabel : `B${idx + 1}`}
                        </span>
                        <div className="flex items-center justify-between text-[9px]">
                          <span>{item ? itemBadgeText(item) : 'EMPTY'}</span>
                          {item?.kind === 'medical' && (
                            <button
                              type="button"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onUseMedicalItem(loc, item);
                              }}
                              className="border border-emerald-400/60 bg-emerald-950/90 px-1 text-[8px] text-emerald-200"
                            >
                              USE
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Removable Gear Slots: Chest Rig + Backpack */}
              <div className="grid grid-cols-2 gap-2">
                <div className="border border-white/12 bg-[#10141c] p-2 font-mono-tabular text-[11px]">
                  <div className="text-[10px] text-neutral-400">CHEST RIG SLOT</div>
                  <div className="mt-0.5 truncate font-semibold text-neutral-100">
                    {inventory.chestRig ? inventory.chestRig.shortLabel : 'UNEQUIPPED'}
                  </div>
                  {inventory.chestRig && (
                    <button
                      type="button"
                      onClick={() => handleUnequipGear('chest_rig')}
                      className="mt-1.5 w-full cursor-pointer border border-white/15 bg-black/40 py-0.5 text-[10px] text-neutral-300 hover:border-amber-400/60"
                    >
                      Unequip Rig
                    </button>
                  )}
                </div>

                <div className="border border-white/12 bg-[#10141c] p-2 font-mono-tabular text-[11px]">
                  <div className="flex items-center justify-between text-[10px] text-neutral-400">
                    <span className="flex items-center gap-1">
                      <Backpack className="h-3 w-3 text-amber-400" />
                      <span>BACKPACK</span>
                    </span>
                    {equippedPackTpl && (
                      <span className="text-[9px] text-sky-300">
                        {equippedPackTpl.maxWeightKg}kg
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-semibold text-neutral-100">
                    {inventory.backpack ? inventory.backpack.shortLabel : 'EMPTY SLOT'}
                  </div>
                  {inventory.backpack ? (
                    <>
                      <div className="text-[9px] text-neutral-400">
                        {computeTacticalItemWeightKg(inventory.backpack).toFixed(1)} kg ·{' '}
                        {inventory.backpack.grid.items.length} item(s)
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUnequipGear('backpack')}
                        className="mt-1 w-full cursor-pointer border border-amber-400/50 bg-amber-950/35 py-0.5 text-[10px] font-semibold text-amber-200 hover:border-amber-300 hover:bg-amber-900/45"
                      >
                        Drop On Ground
                      </button>
                    </>
                  ) : (
                    <div className="mt-1 text-[9px] text-neutral-500">
                      Interact [F] with any ground backpack to put it on.
                    </div>
                  )}
                </div>
              </div>

              {/* Secure Container (Open World Only) */}
              {showSecureContainer && (
                <div className="border border-sky-400/35 bg-[#0c141d] p-2.5">
                  <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[11px] text-sky-300">
                    <span className="flex items-center gap-1 font-semibold">
                      <Lock className="h-3.5 w-3.5" />
                      <span>SECURE CONTAINER</span>
                    </span>
                    <span className="text-[10px]">SURVIVES DEATH</span>
                  </div>
                  {renderTetrisGrid(inventory.secureContainer, 'secure_grid', 'border-sky-400/40')}
                </div>
              )}
            </div>

            {/* COLUMN 2: Chest Rig (Rifle/Pistol Mag Slots + General Grid) & Active Backpack Tetris Grid */}
            <div className="space-y-4">
              {/* Chest Rig Container */}
              <div className="border border-white/14 bg-[#10141c] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2">
                  <div className="font-mono-tabular text-xs font-semibold text-amber-200">
                    {inventory.chestRig
                      ? `CHEST RIG · ${inventory.chestRig.name}`
                      : 'NO CHEST RIG EQUIPPED'}
                  </div>
                  <span className="font-mono-tabular text-[10px] text-neutral-400">
                    [R] RELOAD: RIG/BELT (1.0x) · BACKPACK FALLBACK (1.45x)
                  </span>
                </div>

                {inventory.chestRig ? (
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {/* Dedicated Rifle Mag Slots */}
                      <div className="space-y-1">
                        <div className="font-mono-tabular text-[10px] font-semibold text-neutral-300">
                          RIFLE MAG SLOTS ({inventory.chestRig.rifleMagCapacity})
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {inventory.chestRig.rifleMagSlots.map((mag, idx) => {
                            const loc: ItemSourceLocator = { zone: 'chest_rig_rifle', slotIndex: idx };
                            return (
                              <div
                                key={idx}
                                onClick={() => {
                                  if (drag) handleDropOnRigMagSlot('rifle', idx);
                                  else if (mag) beginDrag(loc, mag, false);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  if (mag) setInspectedTarget({ kind: 'locator', locator: loc });
                                }}
                                className={`flex h-16 w-16 cursor-pointer flex-col justify-between border p-1 font-mono-tabular text-[10px] ${
                                  mag
                                    ? itemToneClass(mag)
                                    : 'border-dashed border-white/18 bg-[#090c10] text-neutral-600 hover:border-amber-400/50'
                                }`}
                              >
                                <span className="truncate font-semibold">
                                  {mag ? mag.shortLabel : `R-MAG ${idx + 1}`}
                                </span>
                                <span className="text-[9px]">
                                  {mag ? `${mag.rounds.length}/${mag.capacity}` : 'RIFLE'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Dedicated Pistol Mag Slots */}
                      <div className="space-y-1">
                        <div className="font-mono-tabular text-[10px] font-semibold text-neutral-300">
                          PISTOL MAG SLOTS ({inventory.chestRig.pistolMagCapacity})
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {inventory.chestRig.pistolMagSlots.map((mag, idx) => {
                            const loc: ItemSourceLocator = { zone: 'chest_rig_pistol', slotIndex: idx };
                            return (
                              <div
                                key={idx}
                                onClick={() => {
                                  if (drag) handleDropOnRigMagSlot('pistol', idx);
                                  else if (mag) beginDrag(loc, mag, false);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  if (mag) setInspectedTarget({ kind: 'locator', locator: loc });
                                }}
                                className={`flex h-14 w-16 cursor-pointer flex-col justify-between border p-1 font-mono-tabular text-[10px] ${
                                  mag
                                    ? itemToneClass(mag)
                                    : 'border-dashed border-white/18 bg-[#090c10] text-neutral-600 hover:border-amber-400/50'
                                }`}
                              >
                                <span className="truncate font-semibold">
                                  {mag ? mag.shortLabel : `P-MAG ${idx + 1}`}
                                </span>
                                <span className="text-[9px]">
                                  {mag ? `${mag.rounds.length}/${mag.capacity}` : 'PISTOL'}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* Chest Rig General Pouch Grid */}
                    {renderTetrisGrid(inventory.chestRig.generalGrid, 'chest_rig_grid')}
                  </div>
                ) : (
                  <div className="mt-2 border border-amber-500/35 bg-amber-950/20 p-2.5 font-mono-tabular text-[11px] text-amber-200">
                    No Chest Rig equipped. Reloads will draw from Belt slots or fall back to Backpack magazines (slower).
                  </div>
                )}
              </div>

              {/* Active Backpack Nested Tetris Grid */}
              <div className="border border-white/14 bg-[#10141c] p-3">
                {inventory.backpack ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between border-b border-white/10 pb-1.5 font-mono-tabular text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-indigo-200">
                        <Backpack className="h-3.5 w-3.5 text-indigo-400" />
                        <span>EQUIPPED · {inventory.backpack.name}</span>
                      </span>
                      {equippedPackTpl && (
                        <span className="text-[10px] text-neutral-400">
                          {equippedPackTpl.skinLabel} · Max {equippedPackTpl.maxWeightKg} kg
                        </span>
                      )}
                    </div>
                    {renderTetrisGrid(inventory.backpack.grid, 'backpack_grid', 'border-indigo-400/35')}
                  </div>
                ) : (
                  <div className="font-mono-tabular text-xs text-neutral-400">
                    No Backpack equipped. Equip one in your Loadout Workbench (Rank 10/20/30) or find and put on an in-world backpack to carry more gear and increase weight capacity.
                  </div>
                )}
              </div>
            </div>

            {/* COLUMN 3: Interactive Magazine Loader + Ground Backpack / Corpse / Crate Container */}
            <div className="space-y-3">
              {/* Interactive Mixed-Ammo LIFO Magazine Loader */}
              <div className="border border-amber-500/35 bg-[#10141c] p-3">
                <div className="flex items-center justify-between border-b border-white/10 pb-2">
                  <span className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-amber-200">
                    <Crosshair className="h-3.5 w-3.5" />
                    <span>MAGAZINE LOADER &amp; LIFO STACK</span>
                  </span>
                  {inspectedMag && (
                    <span className="font-mono-tabular text-[11px] text-neutral-300">
                      {BASE_CALIBERS[inspectedMag.baseCaliber]?.shortLabel} · {inspectedMag.rounds.length}/
                      {inspectedMag.capacity}
                    </span>
                  )}
                </div>

                {/* Live Bullet-by-Bullet Packing Progress Bar */}
                {packingJob && (
                  <div className="mt-2 space-y-1 border border-amber-400/60 bg-amber-950/45 p-2 font-mono-tabular text-[10px]">
                    <div className="flex items-center justify-between text-amber-200">
                      <span>
                        LOADING {packingJob.variantShort} ({packingJob.loadedSoFar}/{packingJob.totalRounds})
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setPackingJob(null);
                          setLocalNotice('Paused magazine packing.');
                        }}
                        className="cursor-pointer border border-amber-400/50 bg-black/50 px-1.5 py-0.5 text-[9px] text-amber-100 hover:bg-amber-900/60"
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden bg-black/70">
                      <div
                        className="h-full bg-amber-400 transition-all"
                        style={{
                          width: `${Math.round((packingJob.loadedSoFar / Math.max(1, packingJob.totalRounds)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {inspectedMag ? (
                  <div className="mt-2.5 space-y-2.5">
                    <div className="flex items-center justify-between font-mono-tabular text-[11px]">
                      <span className="font-semibold text-neutral-100">{inspectedMag.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleUnloadFromInspector(1)}
                          disabled={inspectedMag.rounds.length === 0}
                          className="cursor-pointer border border-white/15 bg-black/40 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:border-amber-400/60 disabled:opacity-40"
                        >
                          -1 Top
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUnloadFromInspector(5)}
                          disabled={inspectedMag.rounds.length === 0}
                          className="cursor-pointer border border-white/15 bg-black/40 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:border-amber-400/60 disabled:opacity-40"
                        >
                          -5 Top
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUnloadFromInspector(inspectedMag.rounds.length)}
                          disabled={inspectedMag.rounds.length === 0}
                          className="cursor-pointer border border-red-500/45 bg-red-950/40 px-1.5 py-0.5 text-[10px] text-red-200 hover:border-red-400 disabled:opacity-40"
                        >
                          Empty
                        </button>
                      </div>
                    </div>

                    {/* LIFO Stack Runs (Top -> Bottom) */}
                    <div className="space-y-1 border border-white/10 bg-[#090c10] p-2">
                      <div className="flex items-center justify-between font-mono-tabular text-[9px] uppercase text-neutral-500">
                        <span>TOP (FIRES FIRST)</span>
                        <span>PEN RATING</span>
                      </div>
                      {inspectedRuns.length === 0 ? (
                        <div className="py-2 text-center font-mono-tabular text-[11px] text-neutral-500">
                          Empty Magazine — Load Same-Caliber Rounds Below
                        </div>
                      ) : (
                        inspectedRuns.map((run, idx) => (
                          <div
                            key={`${run.variantId}_${idx}`}
                            className="flex items-center justify-between border border-white/10 bg-[#141922] px-2 py-1 font-mono-tabular text-[11px]"
                          >
                            <span className="flex items-center gap-1.5">
                              <span className="font-semibold text-sky-200">{run.shortName}</span>
                              <span className="text-[10px] text-neutral-400">
                                {run.coreType.toUpperCase()}
                              </span>
                            </span>
                            <span className="text-amber-200">
                              x{run.count} · PEN {run.penetrationRating}
                            </span>
                          </div>
                        ))
                      )}
                      <div className="text-right font-mono-tabular text-[9px] uppercase text-neutral-500">
                        BOTTOM OF MAGAZINE
                      </div>
                    </div>

                    {/* Compatible Same-Caliber Loose Ammo Stacks */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between font-mono-tabular text-[10px] font-semibold text-neutral-400">
                        <span>LOAD SAME-CALIBER LOOSE ROUNDS</span>
                        <span className="text-[9px] text-neutral-500">
                          {allowInstantMagPack ? 'BENCH MODE' : 'TIMED LOAD'}
                        </span>
                      </div>
                      {compatibleAmmoStacks.length === 0 ? (
                        <div className="font-mono-tabular text-[11px] text-neutral-500">
                          No loose {BASE_CALIBERS[inspectedMag.baseCaliber]?.shortLabel} ammo stacks available.
                        </div>
                      ) : (
                        compatibleAmmoStacks.map(({ locator, stack, where }) => {
                          const def = AMMO_VARIANTS[stack.variantId];
                          const isFull = inspectedMag.rounds.length >= inspectedMag.capacity;
                          return (
                            <div
                              key={stack.instanceId}
                              className="flex items-center justify-between gap-2 border border-white/10 bg-[#131822] px-2 py-1.5 font-mono-tabular text-[11px]"
                            >
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-sky-200">
                                  {def?.shortName ?? stack.shortLabel} ({stack.count}rd)
                                </div>
                                <div className="text-[10px] text-neutral-400">
                                  {where} · PEN {def?.penetrationRating ?? 0} · {def?.coreType.toUpperCase()}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => startPackingRounds(inspectedTarget, locator, 1, true)}
                                  disabled={isFull}
                                  className="cursor-pointer border border-sky-400/50 bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-100 hover:bg-sky-900/70 disabled:opacity-35"
                                >
                                  +1
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    startPackingRounds(inspectedTarget, locator, 5, false)
                                  }
                                  disabled={isFull}
                                  className="cursor-pointer border border-sky-400/50 bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-100 hover:bg-sky-900/70 disabled:opacity-35"
                                >
                                  +5
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    startPackingRounds(
                                      inspectedTarget,
                                      locator,
                                      inspectedMag.capacity - inspectedMag.rounds.length,
                                      false,
                                    )
                                  }
                                  disabled={isFull}
                                  className="cursor-pointer border border-amber-400/60 bg-amber-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-900/70 disabled:opacity-35"
                                >
                                  Fill
                                </button>
                                {allowInstantMagPack && (
                                  <button
                                    type="button"
                                    title="Instant Bench Load"
                                    onClick={() =>
                                      startPackingRounds(
                                        inspectedTarget,
                                        locator,
                                        inspectedMag.capacity - inspectedMag.rounds.length,
                                        true,
                                      )
                                    }
                                    disabled={isFull}
                                    className="cursor-pointer border border-emerald-400/60 bg-emerald-950/60 px-1 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-900/70 disabled:opacity-35"
                                  >
                                    <Zap className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 font-mono-tabular text-[11px] text-neutral-400">
                    Click any Magazine (or &ldquo;Inspect Mag&rdquo; on a weapon) to load loose rounds or arrange mixed same-caliber LIFO stacks.
                  </div>
                )}
              </div>

              {/* === EXTERNAL CONTAINER: IN-WORLD GROUND BACKPACK === */}
              {externalLoot && externalLoot.kind === 'ground_backpack' && externalLoot.lootKit.backpack && (
                <div className="space-y-2.5 border border-indigo-400/50 bg-[#101424] p-3">
                  <div className="flex items-center justify-between border-b border-white/10 pb-2">
                    <span className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-indigo-200">
                      <Backpack className="h-3.5 w-3.5 text-indigo-400" />
                      <span>{externalLoot.title}</span>
                    </span>
                    <span className="border border-indigo-400/40 bg-indigo-950/60 px-1.5 py-0.5 font-mono-tabular text-[9px] uppercase text-indigo-200">
                      {externalLoot.isPracticeGear ? 'BENCH PACK' : 'GROUND PACK'}
                    </span>
                  </div>
                  <div className="font-mono-tabular text-[10px] text-neutral-300">
                    {externalLoot.subtitle}
                  </div>

                  {/* Exact Equip / Unequip-First Enforcement */}
                  {inventory.backpack === null ? (
                    <button
                      type="button"
                      onClick={handleEquipGroundPackClick}
                      className="flex w-full cursor-pointer items-center justify-between border border-emerald-400/70 bg-emerald-950/60 px-3 py-2 font-mono-tabular text-xs font-semibold text-emerald-100 hover:bg-emerald-900/65"
                    >
                      <span>EQUIP BACKPACK ONTO OPERATOR</span>
                      <span className="text-[10px] text-emerald-300">
                        KEEPS {externalLoot.lootKit.backpack.grid.items.length} ITEM(S)
                      </span>
                    </button>
                  ) : (
                    <div className="space-y-1.5 border border-amber-400/45 bg-amber-950/35 p-2 font-mono-tabular text-[10px]">
                      <div className="text-amber-200">
                        You are wearing <strong>{inventory.backpack.shortLabel}</strong>. Take off / drop your equipped backpack first to put this one on.
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled
                          className="flex-1 cursor-not-allowed border border-white/15 bg-black/40 py-1 text-neutral-500"
                        >
                          Equip Pack (Slot Full)
                        </button>
                        {onDropEquippedBackpack && (
                          <button
                            type="button"
                            onClick={() => handleUnequipGear('backpack')}
                            className="cursor-pointer border border-amber-400/70 bg-amber-900/50 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-800/60"
                          >
                            Drop My Pack First
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Always-visible 2-way Tetris grid for putting items IN or taking items OUT */}
                  {renderTetrisGrid(
                    externalLoot.lootKit.backpack.grid,
                    'external_backpack_grid',
                    'border-indigo-400/45',
                  )}

                  <div className="flex items-center gap-1.5 font-mono-tabular text-[10px] text-neutral-400">
                    <ArrowDownToLine className="h-3 w-3 shrink-0" />
                    <span>
                      Drag items freely between your Rig/Pack and this ground backpack (or right-click to quick-transfer).
                    </span>
                  </div>
                </div>
              )}

              {/* === EXTERNAL CONTAINER: CORPSE / EVENT CRATE === */}
              {externalLoot && externalLoot.kind !== 'ground_backpack' && (
                <div className="space-y-2.5 border border-red-500/40 bg-[#141015] p-3">
                  <div className="flex items-center justify-between border-b border-white/10 pb-2">
                    <span className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-red-200">
                      <Skull className="h-3.5 w-3.5 text-red-400" />
                      <span>{externalLoot.title}</span>
                    </span>
                    <span className="font-mono-tabular text-[10px] text-neutral-400">
                      {externalLoot.kind === 'corpse' ? 'FULL-DROP' : 'EVENT CRATE'}
                    </span>
                  </div>
                  <div className="font-mono-tabular text-[10px] text-neutral-400">
                    {externalLoot.subtitle}
                  </div>

                  {/* Corpse Removable Gear (Backpack & Chest Rig) */}
                  {(externalLoot.lootKit.backpack || externalLoot.lootKit.chestRig) && (
                    <div className="grid grid-cols-2 gap-2">
                      {externalLoot.lootKit.chestRig && (
                        <button
                          type="button"
                          onClick={() => handleEquipGearFromExternal('chest_rig')}
                          className="flex cursor-pointer flex-col border border-indigo-400/50 bg-[#141728] p-2 text-left font-mono-tabular text-[10px] hover:border-indigo-300"
                        >
                          <span className="text-indigo-300">SWAP CHEST RIG</span>
                          <span className="font-semibold text-white">
                            {externalLoot.lootKit.chestRig.shortLabel}
                          </span>
                        </button>
                      )}
                      {externalLoot.lootKit.backpack && (
                        <button
                          type="button"
                          onClick={() => handleEquipGearFromExternal('backpack')}
                          disabled={inventory.backpack !== null}
                          title={
                            inventory.backpack !== null
                              ? 'Drop your equipped backpack first to put this one on'
                              : 'Equip this backpack with all its contents'
                          }
                          className={`flex flex-col border p-2 text-left font-mono-tabular text-[10px] ${
                            inventory.backpack !== null
                              ? 'cursor-not-allowed border-white/15 bg-black/40 text-neutral-500'
                              : 'cursor-pointer border-indigo-400/50 bg-[#141728] hover:border-indigo-300'
                          }`}
                        >
                          <span className="text-indigo-300">
                            {inventory.backpack !== null ? 'DROP PACK FIRST' : 'EQUIP BACKPACK'}
                          </span>
                          <span className="font-semibold text-white">
                            {externalLoot.lootKit.backpack.shortLabel} (
                            {externalLoot.lootKit.backpack.grid.items.length} items)
                          </span>
                        </button>
                      )}
                    </div>
                  )}

                  {/* External Loose Loot Grid */}
                  {renderTetrisGrid(externalLoot.lootKit.looseGrid, 'external_grid', 'border-red-500/35')}

                  {/* External Backpack Contents */}
                  {externalLoot.lootKit.backpack && (
                    <div className="pt-1">
                      {renderTetrisGrid(
                        externalLoot.lootKit.backpack.grid,
                        'external_backpack_grid',
                        'border-indigo-400/35',
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 font-mono-tabular text-[10px] text-neutral-400">
                    <ArrowDownToLine className="h-3 w-3" />
                    <span>Click to drag items across grids or right-click external items to quick-loot.</span>
                  </div>
                </div>
              )}

              {/* Quick Medical Notice */}
              {(bleeding || sprintSlow || playerHp < maxHp) && (
                <div className="flex items-center gap-2 border border-emerald-500/35 bg-emerald-950/30 px-2.5 py-2 font-mono-tabular text-[11px] text-emerald-200">
                  <HeartPulse className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span>Right-click or press USE on any Bandage, Splint, or IFAK to treat wounds immediately.</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

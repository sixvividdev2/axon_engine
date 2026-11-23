import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  Backpack,
  Crosshair,
  HeartPulse,
  Lock,
  Package,
  RotateCw,
  Shield,
  Skull,
  X,
} from 'lucide-react';
import { AMMO_VARIANTS, BASE_CALIBERS } from '../../../../data/calibers';
import { resolveWeaponProfile } from '../../../../bodycam-sdk/weaponProfiles';
import {
  autoPlaceItemInGrid,
  canPlaceInGrid,
  cloneCorpseLootSnapshot,
  cloneTacticalInventory,
  extractItemByLocator,
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
  readonly kind: 'corpse' | 'event_crate';
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly lootKit: CorpseTacticalLootSnapshot;
}

interface TacticalInventoryModalProps {
  inventory: OperatorTacticalInventory;
  externalLoot: ExternalLootContext | null;
  playerHp: number;
  maxHp: number;
  bleeding: boolean;
  sprintSlow: boolean;
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

const CELL_PX = 38;

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
    default:
      return 'border-white/18 bg-[#171b22] text-neutral-200';
  }
}

function itemBadgeText(item: TacticalItem): string {
  if (item.kind === 'magazine') return `${item.rounds.length}/${item.capacity}`;
  if (item.kind === 'ammo_stack') return `x${item.count}`;
  if (item.kind === 'medical') return `${item.usesRemaining}/${item.maxUses}`;
  if (item.kind === 'grenade') return `x${item.count}`;
  if (item.kind === 'backpack') return `${item.grid.width}x${item.grid.height}`;
  if (item.kind === 'chest_rig') return `${item.rifleMagCapacity}R/${item.pistolMagCapacity}P`;
  return `$${item.valueUsd}`;
}

function collectLooseAmmoStacks(
  inv: OperatorTacticalInventory,
  caliber: string,
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
  for (const p of inv.secureContainer.items) {
    if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === caliber && p.item.count > 0) {
      out.push({
        locator: { zone: 'secure_grid', instanceId: p.item.instanceId },
        stack: p.item,
        where: 'Secure',
      });
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
  onMutateInventory,
  onTriggerDragReload,
  onUseMedicalItem,
  onClose,
}) => {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverCell, setHoverCell] = useState<{ zone: GridZoneKey; x: number; y: number } | null>(
    null,
  );
  const [inspectedTarget, setInspectedTarget] = useState<MagInspectorTarget>({
    kind: 'weapon',
    slot: 'primary',
  });
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  // [R] rotates carried/dragged item 90°, [Esc] cancels drag or closes modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyR' && drag) {
        e.preventDefault();
        e.stopPropagation();
        setDrag((prev) => (prev ? { ...prev, rotated: !prev.rotated } : null));
      } else if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (drag) {
          setDrag(null);
          setHoverCell(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag, onClose]);

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
    () => (inspectedMag ? collectLooseAmmoStacks(inventory, inspectedMag.baseCaliber) : []),
    [inspectedMag, inventory],
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
    setDrag({ locator, item, rotated });
    setLocalNotice(null);
    if (item.kind === 'magazine') {
      setInspectedTarget({ kind: 'locator', locator });
    }
  };

  const handleDropOnGridCell = (zone: GridZoneKey, cellX: number, cellY: number) => {
    if (!drag) return;
    // Prevent placing a backpack inside itself or a chest rig inside itself
    if (
      (drag.item.kind === 'backpack' && zone === 'backpack_grid') ||
      (drag.item.kind === 'chest_rig' && zone === 'chest_rig_grid')
    ) {
      setLocalNotice('Cannot nest a container inside itself.');
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
      return `Placed ${extracted.shortLabel}`;
    });
    setDrag(null);
    setHoverCell(null);
  };

  const handleDropAmmoOnMagazine = (targetLocator: ItemSourceLocator | { weaponSlot: 'primary' | 'secondary' }) => {
    if (!drag || drag.item.kind !== 'ammo_stack') return;
    commit((inv, ext) => {
      const targetMag =
        'weaponSlot' in targetLocator
          ? inv[targetLocator.weaponSlot].loadedMag
          : peekItemByLocator(inv, targetLocator, ext);
      if (!targetMag || targetMag.kind !== 'magazine') return 'Target is not a magazine.';
      const stack = peekItemByLocator(inv, drag.locator, ext);
      if (!stack || stack.kind !== 'ammo_stack') return 'Ammo stack missing.';

      const res = loadAmmoStackIntoMagazine(targetMag, stack);
      if (!res.ok) return res.error ?? 'Could not load rounds.';
      if (stack.count <= 0) {
        extractItemByLocator(inv, drag.locator, ext);
      }
      return `Packed +${res.loadedCount} ${AMMO_VARIANTS[stack.variantId]?.shortName ?? stack.shortLabel} into ${targetMag.shortLabel}`;
    });
    setDrag(null);
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
      setLocalNotice(`Incompatible mag (${drag.item.shortLabel}) for ${resolveWeaponProfile(wSlot.weaponId).name}.`);
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

  const handlePackFromInspector = (
    ammoLocator: ItemSourceLocator,
    amount: number,
  ) => {
    commit((inv, ext) => {
      const targetMag =
        inspectedTarget.kind === 'weapon'
          ? inv[inspectedTarget.slot].loadedMag
          : peekItemByLocator(inv, inspectedTarget.locator, ext);
      if (!targetMag || targetMag.kind !== 'magazine') return 'Select a magazine first.';
      const stack = peekItemByLocator(inv, ammoLocator, ext);
      if (!stack || stack.kind !== 'ammo_stack') return 'Ammo stack unavailable.';
      const res = loadAmmoStackIntoMagazine(targetMag, stack, amount);
      if (!res.ok) return res.error ?? 'Could not pack rounds.';
      if (stack.count <= 0) {
        extractItemByLocator(inv, ammoLocator, ext);
      }
      return `Loaded +${res.loadedCount} ${AMMO_VARIANTS[stack.variantId]?.shortName ?? stack.shortLabel} on top of ${targetMag.shortLabel}`;
    });
  };

  const handleUnloadFromInspector = (count: number) => {
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
          autoPlaceItemInGrid(inv.secureContainer, s, true);
        if (placed) {
          stowedCount += qty;
        } else {
          // Put rounds back if zero inventory space
          for (let i = 0; i < s.count; i++) targetMag.rounds.push(s.variantId);
        }
      }
      return stowedCount > 0
        ? `Unloaded ${stowedCount} top round(s) into loose stacks`
        : 'No grid space for unloaded ammo stacks.';
    });
  };

  const handleUnequipGear = (gearKind: 'chest_rig' | 'backpack') => {
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
        return `Unequipped ${rig.shortLabel} ([R] quick-reload now limited to Belt mags)`;
      }
      if (gearKind === 'backpack' && inv.backpack) {
        const pack = inv.backpack;
        if (ext && !ext.backpack) {
          ext.backpack = pack;
          inv.backpack = null;
          return `Dropped ${pack.shortLabel} (with ${pack.grid.items.length} nested items) into Loot Container`;
        }
        return 'Open a Corpse / Loot Crate to drop or swap your Backpack.';
      }
      return 'Nothing equipped.';
    });
  };

  const handleEquipGearFromExternal = (gearKind: 'chest_rig' | 'backpack') => {
    commit((inv, ext) => {
      if (!ext) return 'No external container.';
      if (gearKind === 'backpack' && ext.backpack) {
        const prev = inv.backpack;
        inv.backpack = ext.backpack;
        ext.backpack = prev;
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
        const extracted = extractItemByLocator(inv, locator, ext);
        if (!extracted || extracted.kind !== 'backpack') return 'Failed.';
        const prev = inv.backpack;
        inv.backpack = extracted;
        if (prev && ext && !ext.backpack) ext.backpack = prev;
        return `Equipped ${extracted.shortLabel}`;
      }
      return 'Not equippable gear.';
    });
  };

  const handleQuickLootFromExternal = (locator: ItemSourceLocator) => {
    commit((inv, ext) => {
      const extracted = extractItemByLocator(inv, locator, ext);
      if (!extracted) return 'Item unavailable.';
      if (stowItemIntoOperatorInventory(inv, extracted)) {
        return `Looted ${extracted.shortLabel}`;
      }
      // Put back if full
      if (ext) autoPlaceItemInGrid(ext.looseGrid, extracted, true);
      return `No Tetris space for ${extracted.shortLabel}.`;
    });
  };

  const renderTetrisGrid = (grid: GridContainer, zone: GridZoneKey, accentBorder = 'border-white/15') => {
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
                    // Dropping ammo stack onto a magazine directly loads it!
                    if (drag.item.kind === 'ammo_stack' && placed.item.kind === 'magazine') {
                      handleDropAmmoOnMagazine(loc);
                      return;
                    }
                    // Otherwise try placing at this cell
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
                  } else if (placed.item.kind === 'magazine') {
                    setInspectedTarget({ kind: 'locator', locator: loc });
                  } else if (placed.item.kind === 'chest_rig' || placed.item.kind === 'backpack') {
                    handleEquipGearFromGrid(loc);
                  } else if (zone.startsWith('external_')) {
                    handleQuickLootFromExternal(loc);
                  }
                }}
                title={`${placed.item.name} (${w}x${h}) — Click to pick up/drop · Right-click to inspect/use/equip`}
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
        className="flex max-h-[92vh] w-full max-w-[1360px] flex-col border border-white/18 bg-[#0b0e13] text-neutral-100 shadow-2xl"
      >
        {/* Top Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/12 bg-[#10141c] px-4 py-2.5">
          <div className="flex items-center gap-3">
            <Package className="h-4 w-4 text-amber-400" />
            <span className="font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-100">
              Operator Tactical Rig &amp; Tetris Inventory
            </span>
            <span className="border border-white/12 bg-black/40 px-2 py-0.5 font-mono-tabular text-[11px] text-neutral-300">
              HP {playerHp}/{maxHp}
              {bleeding ? ' · BLEEDING' : ''}
              {sprintSlow ? ' · LEG TRAUMA' : ''}
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono-tabular text-[11px]">
            {drag ? (
              <div className="flex items-center gap-2 border border-amber-400/70 bg-amber-950/50 px-2.5 py-1 text-amber-200">
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
                Click item to pick up · [R] Rotate · Drop Ammo on Mag to mix LIFO · Drop Mag on Weapon to 1P Reload
              </span>
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

        {localNotice && (
          <div className="border-b border-amber-500/35 bg-amber-950/35 px-4 py-1.5 font-mono-tabular text-[11px] text-amber-200">
            {localNotice}
          </div>
        )}

        {/* Main 3-Column Body */}
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[310px_minmax(0,1fr)_360px]">
          {/* COLUMN 1: Equipped Weapons, Armor, Tactical Belt, Gear Slots, Secure Container */}
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
                        else if (item?.kind === 'magazine') setInspectedTarget({ kind: 'locator', locator: loc });
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
                <div className="flex items-center gap-1 text-[10px] text-neutral-400">
                  <Backpack className="h-3 w-3" />
                  <span>BACKPACK GEAR</span>
                </div>
                <div className="mt-0.5 truncate font-semibold text-neutral-100">
                  {inventory.backpack ? inventory.backpack.shortLabel : 'NO BACKPACK'}
                </div>
                {inventory.backpack && (
                  <button
                    type="button"
                    onClick={() => handleUnequipGear('backpack')}
                    className="mt-1.5 w-full cursor-pointer border border-white/15 bg-black/40 py-0.5 text-[10px] text-neutral-300 hover:border-amber-400/60"
                  >
                    Drop Pack
                  </button>
                )}
              </div>
            </div>

            {/* Secure Container (Survives Death) */}
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
                  [R] QUICK RELOAD PULLS ONLY FROM CHEST RIG &amp; BELT
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

                  {/* Chest Rig General Pouch Grid (accepts anything + mags) */}
                  {renderTetrisGrid(inventory.chestRig.generalGrid, 'chest_rig_grid')}
                </div>
              ) : (
                <div className="mt-2 border border-amber-500/35 bg-amber-950/20 p-2.5 font-mono-tabular text-[11px] text-amber-200">
                  No Chest Rig equipped. Press [R] requires mags in Chest Rig or Belt — drag any loaded magazine from your Backpack onto a Weapon slot to perform an animated fallback reload.
                </div>
              )}
            </div>

            {/* Active Backpack Nested Tetris Grid */}
            <div className="border border-white/14 bg-[#10141c] p-3">
              {inventory.backpack ? (
                renderTetrisGrid(inventory.backpack.grid, 'backpack_grid')
              ) : (
                <div className="font-mono-tabular text-xs text-neutral-400">
                  No Backpack equipped. Purchase a Patrol/Field/Logistics Pack at your Home FOB Terminal or loot one from a corpse.
                </div>
              )}
            </div>
          </div>

          {/* COLUMN 3: Mixed-Ammo LIFO Stack Inspector + Optional Corpse / Event Crate Loot */}
          <div className="space-y-3">
            {/* Mixed Same-Caliber LIFO Magazine Stack Inspector */}
            <div className="border border-amber-500/35 bg-[#10141c] p-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-amber-200">
                  <Crosshair className="h-3.5 w-3.5" />
                  <span>MAGAZINE LIFO AMMO STACK</span>
                </span>
                {inspectedMag && (
                  <span className="font-mono-tabular text-[11px] text-neutral-300">
                    {BASE_CALIBERS[inspectedMag.baseCaliber]?.shortLabel} · {inspectedMag.rounds.length}/
                    {inspectedMag.capacity}
                  </span>
                )}
              </div>

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
                        Empty Magazine — Pack Same-Caliber Rounds Below
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
                    <div className="font-mono-tabular text-[10px] font-semibold text-neutral-400">
                      PACK SAME-CALIBER LOOSE ROUNDS (MIX ANY ORDER)
                    </div>
                    {compatibleAmmoStacks.length === 0 ? (
                      <div className="font-mono-tabular text-[11px] text-neutral-500">
                        No loose {BASE_CALIBERS[inspectedMag.baseCaliber]?.shortLabel} ammo stacks in Rig/Pack/Secure.
                      </div>
                    ) : (
                      compatibleAmmoStacks.map(({ locator, stack, where }) => {
                        const def = AMMO_VARIANTS[stack.variantId];
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
                                onClick={() => handlePackFromInspector(locator, 1)}
                                disabled={inspectedMag.rounds.length >= inspectedMag.capacity}
                                className="cursor-pointer border border-sky-400/50 bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-100 hover:bg-sky-900/70 disabled:opacity-35"
                              >
                                +1
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePackFromInspector(locator, 5)}
                                disabled={inspectedMag.rounds.length >= inspectedMag.capacity}
                                className="cursor-pointer border border-sky-400/50 bg-sky-950/60 px-1.5 py-0.5 text-[10px] text-sky-100 hover:bg-sky-900/70 disabled:opacity-35"
                              >
                                +5
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handlePackFromInspector(
                                    locator,
                                    inspectedMag.capacity - inspectedMag.rounds.length,
                                  )
                                }
                                disabled={inspectedMag.rounds.length >= inspectedMag.capacity}
                                className="cursor-pointer border border-amber-400/60 bg-amber-950/60 px-1.5 py-0.5 text-[10px] font-semibold text-amber-100 hover:bg-amber-900/70 disabled:opacity-35"
                              >
                                Fill
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-2 font-mono-tabular text-[11px] text-neutral-400">
                  Click any Magazine (or &ldquo;Inspect Mag&rdquo; on a weapon) to manage custom mixed same-caliber ammo stacks.
                </div>
              )}
            </div>

            {/* External Corpse / World Event Salvage Panel */}
            {externalLoot && (
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
                        className="flex cursor-pointer flex-col border border-indigo-400/50 bg-[#141728] p-2 text-left font-mono-tabular text-[10px] hover:border-indigo-300"
                      >
                        <span className="text-indigo-300">SWAP BACKPACK</span>
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

                {/* External Backpack Contents if corpse still has backpack */}
                {externalLoot.lootKit.backpack &&
                  externalLoot.lootKit.backpack.grid.items.length > 0 && (
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
      </div>
    </div>
  );
};

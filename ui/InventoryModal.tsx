import React, { useEffect, useMemo, useState } from 'react';
import {
  Backpack,
  BatteryCharging,
  Crosshair,
  Droplets,
  Flashlight,
  PackageOpen,
  RotateCw,
  ShieldAlert,
  Square,
  Utensils,
  Weight,
  X,
} from 'lucide-react';
import { CALIBERS } from '../data/calibers';
import { ITEMS, ItemCategory, ItemSpec } from '../data/items';
import { LIMB_CONFIGS, LIMB_IDS, LimbId, LimbState } from '../data/traumaConfig';
import { WEAPONS, WeaponId } from '../data/weapons';
import {
  EquippedWeaponState,
  GameSnapshot,
  GridDimensions,
  GridPlacedItem,
  InventoryItemInstance,
  StorageZoneId,
  WeaponSlotsState,
} from '../engine/types';

export interface InventoryModalProps {
  snapshot: GameSnapshot;
  onClose: () => void;
  onEquipWeapon: (id: WeaponId) => void;
  onDropWeaponSlot: (slot: keyof WeaponSlotsState) => void;
  onDetachSuppressor: () => void;
  onSwapBestBattery: () => void;
  onInstallBattery: (uid: string) => void;
  onEquipBackpackFromGrid: (uid: string) => void;
  onEquipBackpackFromSource: (containerId: string, uid: string) => void;
  onUnequipBackpack: () => void;
  onMoveGridItem: (
    uid: string,
    targetZone: StorageZoneId,
    targetX: number,
    targetY: number,
    rotated?: boolean,
  ) => void;
  onRotateGridItem: (uid: string) => void;
  onCtrlClickGridItem: (uid: string) => void;
  onTakeItemFromSource: (
    containerId: string,
    uid: string,
    targetZone?: StorageZoneId,
    targetX?: number,
    targetY?: number,
    rotated?: boolean,
  ) => void;
  onTakeAllFromSource: (containerId: string) => void;
  onDepositGridItemToContainer: (uid: string, containerId: string) => void;
  onUseItem: (uid: string, targetLimbId?: LimbId) => void;
  onTreatLimb: (limbId: LimbId) => void;
  onDropItem: (uid: string) => void;
  onStartPackMag: (
    magUid: string,
    magLocation?: 'grid' | 'loaded',
    magWeaponId?: WeaponId,
    preferredAmmoUid?: string,
  ) => void;
  onStartUnloadMag: (
    magUid: string,
    magLocation?: 'grid' | 'loaded',
    magWeaponId?: WeaponId,
  ) => void;
  onCancelMagPack: () => void;
}

interface DragPayload {
  kind: 'grid' | 'source';
  uid: string;
  itemId: string;
  sourceZone?: StorageZoneId;
  sourceContainerId?: string;
  rotated: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: 'grid' | 'source' | 'loadedMag';
  item: InventoryItemInstance;
  containerId?: string;
  weaponId?: WeaponId;
}

interface HoverCellState {
  zone: StorageZoneId;
  x: number;
  y: number;
}

const CELL_SIZE_PX = 46;

function getLimbColors(l: LimbState): { fill: string; stroke: string; textClass: string } {
  if (l.blackedOut || l.hp <= 0) {
    return { fill: '#141212', stroke: '#dc2626', textClass: 'text-red-400' };
  }
  const ratio = l.hp / Math.max(1, l.maxHp);
  if (l.heavyBleed || ratio < 0.35) {
    return { fill: '#451414', stroke: '#ef4444', textClass: 'text-red-400' };
  }
  if (l.lightBleed || l.fracture || ratio < 0.78) {
    return { fill: '#422c12', stroke: '#f59e0b', textClass: 'text-amber-400' };
  }
  return { fill: '#1a2e22', stroke: '#4ade80', textClass: 'text-emerald-400' };
}

function getMagRounds(item: InventoryItemInstance): number {
  if (Array.isArray(item.roundArray)) return item.roundArray.length;
  return item.rounds ?? 0;
}

function getEffectiveFootprint(spec: ItemSpec, rotated: boolean): { w: number; h: number } {
  return rotated ? { w: spec.gridH, h: spec.gridW } : { w: spec.gridW, h: spec.gridH };
}

function getItemUnitWeight(item: InventoryItemInstance): number {
  const spec = ITEMS[item.itemId];
  if (!spec) return 0;
  if (spec.category === 'magazine') {
    const rds = getMagRounds(item);
    const cal = spec.caliberId ? CALIBERS[spec.caliberId] : null;
    const roundKg = cal ? (cal.bulletMassGrams * 1.45) / 1000 : 0.012;
    return spec.weightKg + rds * roundKg;
  }
  return spec.weightKg * Math.max(1, item.quantity);
}

function getCategoryTileClasses(cat: ItemCategory): string {
  switch (cat) {
    case 'magazine':
      return 'bg-zinc-900/95 border-amber-500/45 hover:border-amber-400';
    case 'ammo':
      return 'bg-stone-900/95 border-yellow-600/45 hover:border-yellow-400';
    case 'medical':
      return 'bg-rose-950/65 border-rose-500/45 hover:border-rose-400';
    case 'food':
      return 'bg-emerald-950/60 border-emerald-500/40 hover:border-emerald-400';
    case 'drink':
      return 'bg-cyan-950/65 border-cyan-500/40 hover:border-cyan-400';
    case 'gear':
      return 'bg-sky-950/60 border-sky-500/40 hover:border-sky-400';
    case 'attachment':
      return 'bg-amber-950/55 border-amber-400/45 hover:border-amber-300';
    case 'backpack':
      return 'bg-lime-950/55 border-lime-500/45 hover:border-lime-400';
    case 'weapon':
      return 'bg-neutral-800/95 border-neutral-500/60 hover:border-neutral-300';
    default:
      return 'bg-neutral-900 border-neutral-700 hover:border-neutral-500';
  }
}

function canPlacePreview(
  placed: GridPlacedItem[],
  dims: GridDimensions,
  zone: StorageZoneId,
  x: number,
  y: number,
  w: number,
  h: number,
  ignoreUid?: string,
): boolean {
  if (x < 0 || y < 0 || x + w > dims.cols || y + h > dims.rows) return false;
  for (const p of placed) {
    if (p.zone !== zone) continue;
    if (ignoreUid && p.item.uid === ignoreUid) continue;
    const sp = ITEMS[p.item.itemId];
    if (!sp) continue;
    const fp = getEffectiveFootprint(sp, p.rotated);
    const overlap =
      x < p.x + fp.w && x + w > p.x && y < p.y + fp.h && y + h > p.y;
    if (overlap) return false;
  }
  return true;
}

export const InventoryModal: React.FC<InventoryModalProps> = ({
  snapshot,
  onClose,
  onEquipWeapon,
  onDropWeaponSlot,
  onDetachSuppressor,
  onSwapBestBattery,
  onInstallBattery,
  onEquipBackpackFromGrid,
  onEquipBackpackFromSource,
  onUnequipBackpack,
  onMoveGridItem,
  onRotateGridItem,
  onCtrlClickGridItem,
  onTakeItemFromSource,
  onTakeAllFromSource,
  onDepositGridItemToContainer,
  onUseItem,
  onTreatLimb,
  onDropItem,
  onStartPackMag,
  onStartUnloadMag,
  onCancelMagPack,
}) => {
  const [selectedLimb, setSelectedLimb] = useState<LimbId>('thorax');
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [hoverCell, setHoverCell] = useState<HoverCellState | null>(null);
  const [hoverMagUid, setHoverMagUid] = useState<string | null>(null);
  const [hoverBatterySlot, setHoverBatterySlot] = useState(false);
  const [hoverBackpackSlot, setHoverBackpackSlot] = useState(false);
  const [hoverGroundDrop, setHoverGroundDrop] = useState(false);
  const [hoverContainerId, setHoverContainerId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const grid = snapshot.gridInventory;
  const vitals = snapshot.vitals;
  const limbs = snapshot.trauma.limbs;
  const mod = snapshot.trauma.modifiers;
  const activeLimb = limbs[selectedLimb];
  const activeLimbCfg = LIMB_CONFIGS[selectedLimb];
  const activePack = snapshot.activeMagPack;

  // Close context menu on outside click or Escape; press R during drag to rotate preview
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && contextMenu) {
        e.stopPropagation();
        setContextMenu(null);
      } else if (e.code === 'KeyR' && dragPayload) {
        e.preventDefault();
        setDragPayload((prev) => (prev ? { ...prev, rotated: !prev.rotated } : null));
      }
    };
    const onClickWindow = () => setContextMenu(null);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('click', onClickWindow);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onClickWindow);
    };
  }, [contextMenu, dragPayload]);

  const clearDragState = () => {
    setDragPayload(null);
    setHoverCell(null);
    setHoverMagUid(null);
    setHoverBatterySlot(false);
    setHoverBackpackSlot(false);
    setHoverGroundDrop(false);
    setHoverContainerId(null);
  };

  const hasSpareBattery = useMemo(
    () =>
      grid.placed.some((p) => {
        const sp = ITEMS[p.item.itemId];
        return Boolean(sp?.batteryRestore);
      }),
    [grid.placed],
  );

  const findPartialMagForCaliber = (
    caliberId: string,
  ): { uid: string; location: 'grid' | 'loaded'; weaponId?: WeaponId } | null => {
    // 1. Prefer loaded mag in equipped weapon if compatible & not full
    const eqWs = snapshot.weaponStates[snapshot.equippedWeaponId];
    if (eqWs?.loadedMag) {
      const mSpec = ITEMS[eqWs.loadedMag.itemId];
      if (
        mSpec?.caliberId === caliberId &&
        mSpec.magCapacity &&
        getMagRounds(eqWs.loadedMag) < mSpec.magCapacity
      ) {
        return { uid: eqWs.loadedMag.uid, location: 'loaded', weaponId: snapshot.equippedWeaponId };
      }
    }
    // 2. Check rig -> pockets -> backpack magazines
    const zoneOrder: StorageZoneId[] = ['rig', 'pockets', 'backpack'];
    for (const z of zoneOrder) {
      const candidate = grid.placed.find((p) => {
        if (p.zone !== z) return false;
        const mSpec = ITEMS[p.item.itemId];
        return (
          mSpec?.category === 'magazine' &&
          mSpec.caliberId === caliberId &&
          Boolean(mSpec.magCapacity) &&
          getMagRounds(p.item) < (mSpec.magCapacity ?? 0)
        );
      });
      if (candidate) {
        return { uid: candidate.item.uid, location: 'grid' };
      }
    }
    // 3. Check other slung weapons' loaded mags
    for (const [wId, ws] of Object.entries(snapshot.weaponStates)) {
      if (!ws?.loadedMag) continue;
      const mSpec = ITEMS[ws.loadedMag.itemId];
      if (
        mSpec?.caliberId === caliberId &&
        mSpec.magCapacity &&
        getMagRounds(ws.loadedMag) < mSpec.magCapacity
      ) {
        return { uid: ws.loadedMag.uid, location: 'loaded', weaponId: wId as WeaponId };
      }
    }
    return null;
  };

  const isDragAmmoCompatibleWithMag = (magItem: InventoryItemInstance): boolean => {
    if (!dragPayload || dragPayload.kind !== 'grid') return false;
    const dragSpec = ITEMS[dragPayload.itemId];
    const magSpec = ITEMS[magItem.itemId];
    if (!dragSpec || !magSpec) return false;
    if (dragSpec.category !== 'ammo' || magSpec.category !== 'magazine') return false;
    if (!dragSpec.caliberId || dragSpec.caliberId !== magSpec.caliberId) return false;
    return getMagRounds(magItem) < (magSpec.magCapacity ?? 0);
  };

  const openContextMenu = (
    e: React.MouseEvent,
    menu: Omit<ContextMenuState, 'x' | 'y'>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const clampedX = Math.min(e.clientX, window.innerWidth - 220);
    const clampedY = Math.min(e.clientY, window.innerHeight - 240);
    setContextMenu({ ...menu, x: Math.max(12, clampedX), y: Math.max(12, clampedY) });
  };

  const handleGridCellDrop = (zone: StorageZoneId, cellX: number, cellY: number) => {
    if (!dragPayload) return;
    if (dragPayload.kind === 'grid') {
      onMoveGridItem(dragPayload.uid, zone, cellX, cellY, dragPayload.rotated);
    } else if (dragPayload.kind === 'source' && dragPayload.sourceContainerId) {
      onTakeItemFromSource(
        dragPayload.sourceContainerId,
        dragPayload.uid,
        zone,
        cellX,
        cellY,
        dragPayload.rotated,
      );
    }
    clearDragState();
  };

  const encumbranceColor =
    grid.encumbranceTier === 'overloaded'
      ? 'text-red-400'
      : grid.encumbranceTier === 'heavy'
        ? 'text-orange-400'
        : grid.encumbranceTier === 'moderate'
          ? 'text-amber-300'
          : 'text-neutral-300';

  const hungerColor =
    vitals.hunger < 15 ? 'text-red-400' : vitals.hunger < 32 ? 'text-amber-400' : 'text-emerald-400';
  const hydrationColor =
    vitals.hydration < 15 ? 'text-red-400' : vitals.hydration < 32 ? 'text-amber-400' : 'text-cyan-400';
  const batteryPct = Math.round(snapshot.battery * 100);
  const batteryColor =
    batteryPct <= 15 ? 'text-red-400' : batteryPct <= 35 ? 'text-amber-400' : 'text-sky-400';

  const statusSummaryParts: string[] = [`Condition ${Math.round(mod.normalizedHealth)}%`];
  if (mod.anyHeavyBleed) statusSummaryParts.push('Heavy Bleed');
  else if (mod.anyLightBleed) statusSummaryParts.push('Light Bleed');
  if (mod.anyFracture) statusSummaryParts.push('Fracture');
  if (mod.painkillerRemainingSec > 0.5) {
    statusSummaryParts.push(`Analgesic ${Math.ceil(mod.painkillerRemainingSec)}s`);
  }

  const renderStorageGrid = (
    zone: StorageZoneId,
    title: string,
    subtitle: string,
    dims: GridDimensions,
  ) => {
    const zoneItems = grid.placed.filter((p) => p.zone === zone);
    const widthPx = dims.cols * CELL_SIZE_PX;
    const heightPx = dims.rows * CELL_SIZE_PX;

    let previewEl: React.ReactNode = null;
    if (dragPayload && hoverCell && hoverCell.zone === zone) {
      const dSpec = ITEMS[dragPayload.itemId];
      if (dSpec) {
        const fp = getEffectiveFootprint(dSpec, dragPayload.rotated);
        const fits = canPlacePreview(
          grid.placed,
          dims,
          zone,
          hoverCell.x,
          hoverCell.y,
          fp.w,
          fp.h,
          dragPayload.kind === 'grid' ? dragPayload.uid : undefined,
        );
        // Check if dropping directly onto a stackable matching item
        const occupying = zoneItems.find((p) => {
          if (dragPayload.kind === 'grid' && p.item.uid === dragPayload.uid) return false;
          const sp = ITEMS[p.item.itemId];
          if (!sp) return false;
          const pfp = getEffectiveFootprint(sp, p.rotated);
          return (
            hoverCell.x >= p.x &&
            hoverCell.x < p.x + pfp.w &&
            hoverCell.y >= p.y &&
            hoverCell.y < p.y + pfp.h
          );
        });
        const stackMergeValid =
          Boolean(occupying) &&
          dSpec.stackable &&
          occupying?.item.itemId === dSpec.id &&
          (occupying?.item.quantity ?? 0) < dSpec.maxStack;

        const valid = fits || stackMergeValid;
        previewEl = (
          <div
            className={`pointer-events-none absolute z-20 border-2 transition-colors ${
              valid
                ? 'border-emerald-400 bg-emerald-500/20'
                : 'border-red-500 bg-red-500/25'
            }`}
            style={{
              left: hoverCell.x * CELL_SIZE_PX,
              top: hoverCell.y * CELL_SIZE_PX,
              width: Math.min(fp.w, dims.cols - hoverCell.x) * CELL_SIZE_PX,
              height: Math.min(fp.h, dims.rows - hoverCell.y) * CELL_SIZE_PX,
            }}
          />
        );
      }
    }

    return (
      <div className="border border-neutral-800 bg-neutral-900/55 p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-200">
              {title}
            </span>
            <span className="text-[11px] font-mono-tabular text-neutral-500 truncate">
              {dims.cols}×{dims.rows} · {subtitle}
            </span>
          </div>
          <span className="text-[11px] font-mono-tabular text-neutral-500 shrink-0">
            {zoneItems.length} item{zoneItems.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="overflow-x-auto pb-0.5">
          <div
            className="relative bg-neutral-950 border border-neutral-800 select-none"
            style={{ width: widthPx, height: heightPx }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setHoverCell((prev) => (prev?.zone === zone ? null : prev));
              }
            }}
          >
            {/* Background Grid Cells */}
            {Array.from({ length: dims.rows }).map((_, r) =>
              Array.from({ length: dims.cols }).map((__, c) => (
                <div
                  key={`${r}-${c}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setHoverCell((prev) =>
                      prev && prev.zone === zone && prev.x === c && prev.y === r
                        ? prev
                        : { zone, x: c, y: r },
                    );
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleGridCellDrop(zone, c, r);
                  }}
                  className="absolute border-r border-b border-neutral-800/75"
                  style={{
                    left: c * CELL_SIZE_PX,
                    top: r * CELL_SIZE_PX,
                    width: CELL_SIZE_PX,
                    height: CELL_SIZE_PX,
                  }}
                />
              )),
            )}

            {/* Drag Ghost Preview */}
            {previewEl}

            {/* Placed Item Tiles */}
            {zoneItems.map((placed) => {
              const spec = ITEMS[placed.item.itemId];
              if (!spec) return null;
              const fp = getEffectiveFootprint(spec, placed.rotated);
              const isMag = spec.category === 'magazine';
              const magCap = spec.magCapacity ?? 0;
              const magRounds = isMag ? getMagRounds(placed.item) : 0;
              const isBeingPacked = activePack?.magUid === placed.item.uid;
              const canReceiveAmmo = isMag && isDragAmmoCompatibleWithMag(placed.item);
              const isHoveredPackTarget = hoverMagUid === placed.item.uid && canReceiveAmmo;
              const weightKg = getItemUnitWeight(placed.item);

              return (
                <div
                  key={placed.item.uid}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', placed.item.uid);
                    setContextMenu(null);
                    setDragPayload({
                      kind: 'grid',
                      uid: placed.item.uid,
                      itemId: placed.item.itemId,
                      sourceZone: placed.zone,
                      rotated: placed.rotated,
                    });
                  }}
                  onDragEnd={clearDragState}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (canReceiveAmmo) {
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'copy';
                      setHoverMagUid(placed.item.uid);
                      setHoverCell(null);
                    } else {
                      // Allow stack merge or placement check using tile origin cell
                      setHoverMagUid(null);
                      setHoverCell({ zone, x: placed.x, y: placed.y });
                    }
                  }}
                  onDragLeave={() => {
                    setHoverMagUid((prev) => (prev === placed.item.uid ? null : prev));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (canReceiveAmmo && dragPayload?.kind === 'grid') {
                      onStartPackMag(placed.item.uid, 'grid', undefined, dragPayload.uid);
                      clearDragState();
                      return;
                    }
                    handleGridCellDrop(zone, placed.x, placed.y);
                  }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.preventDefault();
                      onCtrlClickGridItem(placed.item.uid);
                    }
                  }}
                  onDoubleClick={() => {
                    if (spec.category === 'magazine') {
                      onStartPackMag(placed.item.uid, 'grid');
                    } else if (spec.category === 'backpack') {
                      onEquipBackpackFromGrid(placed.item.uid);
                    } else if (spec.batteryRestore) {
                      onInstallBattery(placed.item.uid);
                    } else if (
                      spec.category === 'medical' ||
                      spec.category === 'food' ||
                      spec.category === 'drink' ||
                      spec.category === 'attachment' ||
                      spec.category === 'weapon'
                    ) {
                      onUseItem(
                        placed.item.uid,
                        spec.category === 'medical' ? selectedLimb : undefined,
                      );
                    }
                  }}
                  onContextMenu={(e) =>
                    openContextMenu(e, { kind: 'grid', item: placed.item })
                  }
                  title={`${spec.name}\n${spec.description}\n${weightKg.toFixed(2)} kg`}
                  className={`absolute z-10 p-1 flex flex-col justify-between border transition-colors cursor-grab active:cursor-grabbing overflow-hidden ${getCategoryTileClasses(
                    spec.category,
                  )} ${
                    isHoveredPackTarget
                      ? 'ring-2 ring-amber-400 border-amber-300 bg-amber-950/80'
                      : isBeingPacked
                        ? 'ring-1 ring-amber-400 border-amber-400'
                        : ''
                  }`}
                  style={{
                    left: placed.x * CELL_SIZE_PX + 1,
                    top: placed.y * CELL_SIZE_PX + 1,
                    width: fp.w * CELL_SIZE_PX - 2,
                    height: fp.h * CELL_SIZE_PX - 2,
                  }}
                >
                  <div className="flex items-start justify-between gap-0.5 leading-tight">
                    <span className="text-[10px] font-semibold text-neutral-100 leading-tight line-clamp-2 break-words">
                      {spec.shortName}
                    </span>
                    {placed.rotated && (
                      <RotateCw className="w-2.5 h-2.5 text-neutral-500 shrink-0 mt-0.5" />
                    )}
                  </div>

                  {isHoveredPackTarget ? (
                    <div className="text-[10px] font-mono-tabular font-semibold text-amber-300 uppercase">
                      + Pack
                    </div>
                  ) : (
                    <div className="mt-auto">
                      <div className="flex items-end justify-between gap-1 text-[10px] font-mono-tabular">
                        {isMag ? (
                          <span
                            className={
                              magRounds === 0
                                ? 'text-red-400 font-semibold'
                                : magRounds < magCap
                                  ? 'text-amber-300 font-semibold'
                                  : 'text-emerald-300 font-semibold'
                            }
                          >
                            {magRounds}/{magCap}
                          </span>
                        ) : spec.stackable || placed.item.quantity > 1 ? (
                          <span className="text-amber-200 font-semibold">
                            ×{placed.item.quantity}
                          </span>
                        ) : spec.batteryRestore ? (
                          <span className="text-sky-300">
                            +{Math.round(spec.batteryRestore * 100)}%
                          </span>
                        ) : (
                          <span className="text-neutral-500 text-[9px]">
                            {weightKg.toFixed(1)}k
                          </span>
                        )}
                        {fp.w >= 2 && (
                          <span className="text-[9px] text-neutral-500">
                            {weightKg.toFixed(2)}kg
                          </span>
                        )}
                      </div>
                      {isMag && magCap > 0 && (
                        <div className="mt-0.5 h-0.5 w-full bg-neutral-800 overflow-hidden">
                          <div
                            className={
                              magRounds === 0
                                ? 'h-full bg-red-500'
                                : magRounds < magCap * 0.4
                                  ? 'h-full bg-amber-500'
                                  : 'h-full bg-emerald-400'
                            }
                            style={{ width: `${Math.min(100, (magRounds / magCap) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const weaponSlotDefs: Array<{
    key: keyof WeaponSlotsState;
    label: string;
    hotkey: string;
  }> = [
    { key: 'primary', label: 'Primary', hotkey: '1' },
    { key: 'sidearm', label: 'Sidearm', hotkey: '2' },
    { key: 'melee', label: 'Melee', hotkey: '3' },
    { key: 'throwable', label: 'Throwable', hotkey: '4' },
  ];

  const renderWeaponSlotCard = (
    slotKey: keyof WeaponSlotsState,
    label: string,
    hotkey: string,
  ) => {
    const wId = grid.weaponSlots[slotKey];
    const wSpec = wId ? WEAPONS[wId] : null;
    const ws: EquippedWeaponState | undefined = wId ? snapshot.weaponStates[wId] : undefined;
    const isActive = Boolean(wId && snapshot.equippedWeaponId === wId);
    const loadedMag = ws?.loadedMag ?? null;
    const loadedMagSpec = loadedMag ? ITEMS[loadedMag.itemId] : null;
    const loadedRounds = loadedMag ? getMagRounds(loadedMag) : 0;
    const loadedCap = loadedMagSpec?.magCapacity ?? 0;
    const canDropAmmoOntoLoaded = Boolean(loadedMag && isDragAmmoCompatibleWithMag(loadedMag));
    const isHoverLoaded = Boolean(loadedMag && hoverMagUid === loadedMag.uid && canDropAmmoOntoLoaded);

    return (
      <div
        key={slotKey}
        onDragOver={(e) => {
          if (canDropAmmoOntoLoaded && loadedMag) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setHoverMagUid(loadedMag.uid);
          }
        }}
        onDragLeave={() => {
          if (loadedMag) {
            setHoverMagUid((prev) => (prev === loadedMag.uid ? null : prev));
          }
        }}
        onDrop={(e) => {
          if (canDropAmmoOntoLoaded && loadedMag && wId && dragPayload?.kind === 'grid') {
            e.preventDefault();
            e.stopPropagation();
            onStartPackMag(loadedMag.uid, 'loaded', wId, dragPayload.uid);
            clearDragState();
          }
        }}
        onContextMenu={(e) => {
          if (loadedMag && wId) {
            openContextMenu(e, { kind: 'loadedMag', item: loadedMag, weaponId: wId });
          }
        }}
        className={`border p-2.5 transition-colors ${
          isHoverLoaded
            ? 'border-amber-400 bg-amber-950/50 ring-1 ring-amber-400'
            : isActive
              ? 'border-amber-500/80 bg-amber-500/10'
              : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700'
        }`}
      >
        <div className="flex items-center justify-between gap-1 text-[10px] font-mono-tabular uppercase tracking-wider text-neutral-500">
          <span>
            [{hotkey}] {label}
          </span>
          {wId && (
            <button
              type="button"
              onClick={() => onDropWeaponSlot(slotKey)}
              className="text-neutral-500 hover:text-red-400 cursor-pointer whitespace-nowrap shrink-0"
              title="Drop weapon to ground"
            >
              Drop
            </button>
          )}
        </div>

        {wId && wSpec ? (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => onEquipWeapon(wId)}
              className="w-full text-left cursor-pointer group"
            >
              <div
                className={`text-xs font-semibold truncate ${
                  isActive ? 'text-amber-300' : 'text-neutral-100 group-hover:text-amber-200'
                }`}
              >
                {wSpec.itemId ? (ITEMS[wSpec.itemId]?.shortName ?? wSpec.name) : wSpec.name}
              </div>
            </button>

            {wSpec.compatibleMagId && ws ? (
              <div className="mt-1.5 space-y-1">
                <div className="flex items-center justify-between text-[10px] font-mono-tabular text-neutral-400">
                  <span>
                    {loadedMag
                      ? `${loadedRounds}/${loadedCap}${ws.chambered ? '+1' : ''}`
                      : ws.chambered
                        ? '0+1'
                        : 'No Mag'}
                  </span>
                  {ws.suppressorAttachedId ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!isActive) onEquipWeapon(wId);
                        onDetachSuppressor();
                      }}
                      className="text-amber-400 hover:text-amber-300 underline cursor-pointer"
                    >
                      Supp.
                    </button>
                  ) : (
                    <span className="text-neutral-600">Loud</span>
                  )}
                </div>

                {loadedMag && (
                  <div className="flex items-center gap-1 pt-0.5">
                    <button
                      type="button"
                      onClick={() => onStartPackMag(loadedMag.uid, 'loaded', wId)}
                      disabled={loadedRounds >= loadedCap}
                      className="flex-1 py-0.5 text-[10px] font-mono-tabular border border-neutral-700 bg-neutral-950 text-neutral-200 hover:border-amber-500 hover:text-amber-300 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                    >
                      Pack
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartUnloadMag(loadedMag.uid, 'loaded', wId)}
                      disabled={loadedRounds <= 0}
                      className="flex-1 py-0.5 text-[10px] font-mono-tabular border border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                    >
                      Unload
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-1 text-[10px] font-mono-tabular text-neutral-500">
                {wSpec.holdClass === 'melee_1h'
                  ? `Silent ${(wSpec.meleeRangeM ?? 1.75).toFixed(1)}m`
                  : wSpec.fuseDurationSec
                    ? `${wSpec.fuseDurationSec}s Fuse`
                    : 'Sound Lure'}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2 text-[11px] text-neutral-600 font-mono-tabular">Empty Slot</div>
        )}
      </div>
    );
  };

  const renderContextMenu = () => {
    if (!contextMenu) return null;
    const { item, kind, containerId, weaponId } = contextMenu;
    const spec = ITEMS[item.itemId];
    if (!spec) return null;

    const actions: Array<{ label: string; tone?: 'accent' | 'danger'; onClick: () => void }> = [];

    if (kind === 'source' && containerId) {
      actions.push({
        label: 'Take to Rig / Pack',
        tone: 'accent',
        onClick: () => onTakeItemFromSource(containerId, item.uid),
      });
      if (spec.category === 'backpack') {
        actions.push({
          label: 'Equip Backpack',
          tone: 'accent',
          onClick: () => onEquipBackpackFromSource(containerId, item.uid),
        });
      }
    } else if (kind === 'loadedMag' && weaponId) {
      const rds = getMagRounds(item);
      const cap = spec.magCapacity ?? 0;
      if (rds < cap) {
        actions.push({
          label: `Pack Loaded Mag (${rds}/${cap})`,
          tone: 'accent',
          onClick: () => onStartPackMag(item.uid, 'loaded', weaponId),
        });
      }
      if (rds > 0) {
        actions.push({
          label: `Unload Loaded Mag (${rds} rds)`,
          onClick: () => onStartUnloadMag(item.uid, 'loaded', weaponId),
        });
      }
    } else if (kind === 'grid') {
      if (spec.category === 'magazine') {
        const rds = getMagRounds(item);
        const cap = spec.magCapacity ?? 0;
        if (rds < cap) {
          actions.push({
            label: `Pack Magazine (${rds}/${cap})`,
            tone: 'accent',
            onClick: () => onStartPackMag(item.uid, 'grid'),
          });
        }
        if (rds > 0) {
          actions.push({
            label: `Unload Rounds (${rds} rds)`,
            onClick: () => onStartUnloadMag(item.uid, 'grid'),
          });
        }
      } else if (spec.category === 'ammo' && spec.caliberId) {
        const targetMag = findPartialMagForCaliber(spec.caliberId);
        if (targetMag) {
          actions.push({
            label: 'Pack Matching Magazine',
            tone: 'accent',
            onClick: () =>
              onStartPackMag(targetMag.uid, targetMag.location, targetMag.weaponId, item.uid),
          });
        }
      } else if (spec.category === 'medical') {
        actions.push({
          label: `Apply to ${activeLimbCfg.shortLabel}`,
          tone: 'accent',
          onClick: () => onUseItem(item.uid, selectedLimb),
        });
      } else if (spec.category === 'food') {
        actions.push({
          label: 'Eat Ration',
          tone: 'accent',
          onClick: () => onUseItem(item.uid),
        });
      } else if (spec.category === 'drink') {
        actions.push({
          label: 'Drink',
          tone: 'accent',
          onClick: () => onUseItem(item.uid),
        });
      } else if (spec.batteryRestore) {
        actions.push({
          label: `Install in Flashlight (+${Math.round(spec.batteryRestore * 100)}%)`,
          tone: 'accent',
          onClick: () => onInstallBattery(item.uid),
        });
      } else if (spec.category === 'attachment') {
        actions.push({
          label: 'Attach to Weapon',
          tone: 'accent',
          onClick: () => onUseItem(item.uid),
        });
      } else if (spec.category === 'backpack') {
        actions.push({
          label: 'Equip Backpack',
          tone: 'accent',
          onClick: () => onEquipBackpackFromGrid(item.uid),
        });
      } else if (spec.category === 'weapon') {
        actions.push({
          label: 'Equip Weapon',
          tone: 'accent',
          onClick: () => onUseItem(item.uid),
        });
      }

      if (spec.gridW !== spec.gridH) {
        actions.push({
          label: 'Rotate 90°',
          onClick: () => onRotateGridItem(item.uid),
        });
      }

      actions.push({
        label: snapshot.activeContainer ? 'Move to Container (Ctrl+Click)' : 'Quick-Transfer (Ctrl+Click)',
        onClick: () => onCtrlClickGridItem(item.uid),
      });

      actions.push({
        label: 'Drop to Ground',
        tone: 'danger',
        onClick: () => onDropItem(item.uid),
      });
    }

    return (
      <div
        className="fixed z-50 w-52 border border-neutral-700 bg-neutral-950 shadow-2xl py-1"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1.5 border-b border-neutral-800">
          <div className="text-xs font-semibold text-neutral-100 truncate">{spec.name}</div>
          <div className="text-[10px] font-mono-tabular text-neutral-500">
            {getItemUnitWeight(item).toFixed(2)} kg · {spec.gridW}×{spec.gridH} cells
          </div>
        </div>
        {actions.map((act) => (
          <button
            key={act.label}
            type="button"
            onClick={() => {
              act.onClick();
              setContextMenu(null);
            }}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer ${
              act.tone === 'accent'
                ? 'text-amber-300 hover:bg-amber-500/15'
                : act.tone === 'danger'
                  ? 'text-red-400 hover:bg-red-500/15'
                  : 'text-neutral-200 hover:bg-neutral-800'
            }`}
          >
            {act.label}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-neutral-950/82 p-3 md:p-5"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="w-full max-w-[1440px] border border-neutral-800 bg-neutral-950/96 p-4 md:p-5 max-h-[95vh] flex flex-col">
        {/* Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-3 shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-display text-xl font-semibold tracking-wide text-neutral-100 uppercase">
                Tactical Rig &amp; Trauma Triage
              </h2>
              <span className="text-xs font-mono-tabular text-neutral-400">
                {statusSummaryParts.join(' · ')}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] font-mono-tabular text-neutral-500">
              Drag items across grids · Press R while dragging to rotate · Drag loose ammo onto mags to pack · Ctrl+Click quick-transfer · Right-Click menu
            </p>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="hidden sm:flex items-center gap-3 text-xs font-mono-tabular">
              <span className={`flex items-center gap-1 ${encumbranceColor}`}>
                <Weight className="w-3.5 h-3.5" />
                {grid.carryWeightKg.toFixed(1)}/{grid.maxWeightKg.toFixed(0)}kg ({grid.encumbranceTier})
              </span>
              <span className="text-neutral-700">|</span>
              <span className={`flex items-center gap-1 ${hungerColor}`}>
                <Utensils className="w-3.5 h-3.5" />
                {Math.round(vitals.hunger)}%
              </span>
              <span className={`flex items-center gap-1 ${hydrationColor}`}>
                <Droplets className="w-3.5 h-3.5" />
                {Math.round(vitals.hydration)}%
              </span>
              <span className={`flex items-center gap-1 ${batteryColor}`}>
                <Flashlight className="w-3.5 h-3.5" />
                {batteryPct}%
              </span>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              Close (Tab)
            </button>
          </div>
        </div>

        {/* Active Mag Packing / Unloading Progress Banner */}
        {activePack && (
          <div className="mt-3 border border-amber-500/50 bg-amber-950/30 px-3.5 py-2 flex items-center justify-between gap-4 shrink-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between text-xs font-mono-tabular">
                <span className="text-amber-300 font-semibold uppercase tracking-wide">
                  {activePack.mode === 'pack' ? 'Packing Magazine' : 'Unloading Magazine'} · {activePack.label}
                </span>
                <span className="text-neutral-200">
                  {activePack.currentRounds}/{activePack.capacity} rds
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full bg-neutral-900 overflow-hidden">
                <div
                  className="h-full bg-amber-400 transition-[width] duration-75"
                  style={{
                    width: `${Math.min(100, (activePack.progressSec / Math.max(0.05, activePack.stepSec)) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={onCancelMagPack}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-amber-500/60 bg-neutral-950 text-amber-300 hover:bg-amber-500 hover:text-neutral-950 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
          </div>
        )}

        {/* Main 3-Column Tarkov × Zomboid Split View */}
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 overflow-y-auto pr-0.5 flex-1 min-h-0">
          {/* LEFT COLUMN: Nearby Container & Ground Items */}
          <div className="lg:col-span-3 flex flex-col gap-3 min-h-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                <PackageOpen className="w-3.5 h-3.5 text-amber-400" />
                Nearby Loot &amp; Ground
              </span>
              <span className="text-[10px] font-mono-tabular text-neutral-500">
                Ctrl+Click take
              </span>
            </div>

            <div className="space-y-3 flex-1 overflow-y-auto pr-1">
              {snapshot.nearbyLootSources.length === 0 ? (
                <div className="border border-dashed border-neutral-800 bg-neutral-900/25 py-8 px-3 text-center text-xs text-neutral-500">
                  No open container or items on ground nearby.
                </div>
              ) : (
                snapshot.nearbyLootSources.map((src) => {
                  const isOpenActive = snapshot.activeContainer?.id === src.containerId;
                  const canDepositHere = !src.isDropped && dragPayload?.kind === 'grid';
                  const isHoveredDest = hoverContainerId === src.containerId && canDepositHere;

                  return (
                    <div
                      key={src.containerId}
                      onDragOver={(e) => {
                        if (canDepositHere) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setHoverContainerId(src.containerId);
                        }
                      }}
                      onDragLeave={() => {
                        setHoverContainerId((prev) => (prev === src.containerId ? null : prev));
                      }}
                      onDrop={(e) => {
                        if (canDepositHere && dragPayload?.kind === 'grid') {
                          e.preventDefault();
                          e.stopPropagation();
                          onDepositGridItemToContainer(dragPayload.uid, src.containerId);
                          clearDragState();
                        }
                      }}
                      className={`border p-2.5 transition-colors ${
                        isHoveredDest
                          ? 'border-amber-400 bg-amber-950/35'
                          : isOpenActive
                            ? 'border-amber-500/45 bg-neutral-900/75'
                            : 'border-neutral-800 bg-neutral-900/45'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span
                          className={`text-xs font-semibold truncate ${
                            isOpenActive ? 'text-amber-400' : 'text-neutral-300'
                          }`}
                        >
                          {src.label}
                        </span>
                        {src.items.length > 0 && (
                          <button
                            type="button"
                            onClick={() => onTakeAllFromSource(src.containerId)}
                            className="px-2 py-0.5 text-[11px] font-medium bg-amber-500 text-neutral-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap shrink-0"
                          >
                            Take All
                          </button>
                        )}
                      </div>

                      {src.items.length === 0 ? (
                        <div className="border border-dashed border-neutral-800/80 py-4 text-center text-[11px] text-neutral-500">
                          {canDepositHere ? 'Drop item here to stow' : 'Empty'}
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {src.items.map((item) => {
                            const spec = ITEMS[item.itemId];
                            if (!spec) return null;
                            const isMag = spec.category === 'magazine';
                            const wt = getItemUnitWeight(item);

                            return (
                              <div
                                key={item.uid}
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.effectAllowed = 'move';
                                  e.dataTransfer.setData('text/plain', item.uid);
                                  setContextMenu(null);
                                  setDragPayload({
                                    kind: 'source',
                                    uid: item.uid,
                                    itemId: item.itemId,
                                    sourceContainerId: src.containerId,
                                    rotated: false,
                                  });
                                }}
                                onDragEnd={clearDragState}
                                onClick={(e) => {
                                  if (e.ctrlKey || e.metaKey) {
                                    e.preventDefault();
                                    onTakeItemFromSource(src.containerId, item.uid);
                                  }
                                }}
                                onContextMenu={(e) =>
                                  openContextMenu(e, {
                                    kind: 'source',
                                    item,
                                    containerId: src.containerId,
                                  })
                                }
                                className="flex items-center justify-between gap-2 border border-neutral-800 bg-neutral-950/80 hover:border-neutral-600 px-2.5 py-1.5 cursor-grab active:cursor-grabbing"
                              >
                                <div className="min-w-0">
                                  <div className="text-xs font-medium text-neutral-200 truncate">
                                    {spec.name}
                                  </div>
                                  <div className="text-[10px] font-mono-tabular text-neutral-500">
                                    {isMag
                                      ? `${getMagRounds(item)}/${spec.magCapacity ?? 0} rds`
                                      : item.quantity > 1
                                        ? `×${item.quantity}`
                                        : spec.category === 'backpack'
                                          ? `${spec.backpackCols}×${spec.backpackRows} pack`
                                          : spec.category}
                                    {' · '}
                                    {spec.gridW}×{spec.gridH}
                                    {' · '}
                                    {wt.toFixed(2)}kg
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onTakeItemFromSource(src.containerId, item.uid);
                                  }}
                                  className="px-2 py-1 text-[11px] font-medium bg-neutral-800 text-neutral-100 hover:bg-amber-500 hover:text-neutral-950 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  {spec.category === 'backpack' && !grid.equippedBackpack
                                    ? 'Equip'
                                    : 'Take'}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Ground Drop Zone */}
            <div
              onDragOver={(e) => {
                if (dragPayload?.kind === 'grid') {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setHoverGroundDrop(true);
                }
              }}
              onDragLeave={() => setHoverGroundDrop(false)}
              onDrop={(e) => {
                if (dragPayload?.kind === 'grid') {
                  e.preventDefault();
                  e.stopPropagation();
                  onDropItem(dragPayload.uid);
                  clearDragState();
                }
              }}
              className={`border border-dashed px-3 py-3 text-center text-[11px] font-mono-tabular transition-colors shrink-0 ${
                hoverGroundDrop
                  ? 'border-red-400 bg-red-950/35 text-red-300'
                  : 'border-neutral-800 bg-neutral-900/30 text-neutral-500'
              }`}
            >
              {hoverGroundDrop ? 'Release to drop item on ground' : 'Drag rig/pack item here to drop on ground'}
            </div>
          </div>

          {/* CENTER COLUMN: Survival Vitals, Weapon/Backpack Slots, 6-Limb Trauma */}
          <div className="lg:col-span-4 space-y-3">
            {/* Survival Vitals & WML Power Panel (Tab-only) */}
            <div className="border border-neutral-800 bg-neutral-900/55 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
                  Vitals &amp; WML Power
                </span>
                <span className={`text-[11px] font-mono-tabular ${encumbranceColor}`}>
                  {grid.carryWeightKg.toFixed(1)} kg · {grid.encumbranceTier.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {/* Hunger */}
                <div className="border border-neutral-800 bg-neutral-950/80 p-2">
                  <div className="flex items-center justify-between text-[10px] font-mono-tabular text-neutral-400">
                    <span>Energy</span>
                    <span className={hungerColor}>{Math.round(vitals.hunger)}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-neutral-800 overflow-hidden">
                    <div
                      className={
                        vitals.hunger < 15
                          ? 'h-full bg-red-500'
                          : vitals.hunger < 32
                            ? 'h-full bg-amber-400'
                            : 'h-full bg-emerald-400'
                      }
                      style={{ width: `${Math.max(0, Math.min(100, vitals.hunger))}%` }}
                    />
                  </div>
                </div>

                {/* Hydration */}
                <div className="border border-neutral-800 bg-neutral-950/80 p-2">
                  <div className="flex items-center justify-between text-[10px] font-mono-tabular text-neutral-400">
                    <span>Hydration</span>
                    <span className={hydrationColor}>{Math.round(vitals.hydration)}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-neutral-800 overflow-hidden">
                    <div
                      className={
                        vitals.hydration < 15
                          ? 'h-full bg-red-500'
                          : vitals.hydration < 32
                            ? 'h-full bg-amber-400'
                            : 'h-full bg-cyan-400'
                      }
                      style={{ width: `${Math.max(0, Math.min(100, vitals.hydration))}%` }}
                    />
                  </div>
                </div>

                {/* WML Battery Slot (Drag Target for AA / CR123A) */}
                <div
                  onDragOver={(e) => {
                    if (
                      dragPayload?.kind === 'grid' &&
                      ITEMS[dragPayload.itemId]?.batteryRestore
                    ) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      setHoverBatterySlot(true);
                    }
                  }}
                  onDragLeave={() => setHoverBatterySlot(false)}
                  onDrop={(e) => {
                    if (
                      dragPayload?.kind === 'grid' &&
                      ITEMS[dragPayload.itemId]?.batteryRestore
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      onInstallBattery(dragPayload.uid);
                      clearDragState();
                    }
                  }}
                  className={`border p-2 transition-colors ${
                    hoverBatterySlot
                      ? 'border-sky-400 bg-sky-950/50'
                      : 'border-neutral-800 bg-neutral-950/80'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] font-mono-tabular text-neutral-400">
                    <span>WML [T]</span>
                    <span className={batteryColor}>{batteryPct}%</span>
                  </div>
                  <div className="mt-1.5 h-1.5 bg-neutral-800 overflow-hidden">
                    <div
                      className={
                        batteryPct <= 15
                          ? 'h-full bg-red-500'
                          : batteryPct <= 35
                            ? 'h-full bg-amber-400'
                            : 'h-full bg-sky-400'
                      }
                      style={{ width: `${Math.max(0, Math.min(100, batteryPct))}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 text-[10px] font-mono-tabular text-neutral-500">
                <span>
                  {batteryPct <= 0
                    ? 'Flashlight dead — install AA / CR123A cell'
                    : batteryPct <= 15
                      ? 'Low battery — beam dimming & flickering'
                      : 'Drag AA / CR123A onto WML to recharge'}
                </span>
                <button
                  type="button"
                  onClick={onSwapBestBattery}
                  disabled={!hasSpareBattery || batteryPct >= 99}
                  className="flex items-center gap-1 px-2 py-0.5 border border-neutral-700 bg-neutral-950 text-sky-300 hover:border-sky-400 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap shrink-0"
                >
                  <BatteryCharging className="w-3 h-3" />
                  Swap Cell
                </button>
              </div>
            </div>

            {/* Slung Weapons & Backpack Equipment Slots */}
            <div className="border border-neutral-800 bg-neutral-900/55 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                  <Crosshair className="w-3.5 h-3.5 text-amber-400" />
                  Loadout Slots
                </span>
                <span className="text-[10px] font-mono-tabular text-neutral-500">
                  [0] Holster · Drag ammo onto gun to pack
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {weaponSlotDefs.map((slot) =>
                  renderWeaponSlotCard(slot.key, slot.label, slot.hotkey),
                )}
              </div>

              {/* Backpack Wearable Slot */}
              <div
                onDragOver={(e) => {
                  if (dragPayload && ITEMS[dragPayload.itemId]?.category === 'backpack') {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setHoverBackpackSlot(true);
                  }
                }}
                onDragLeave={() => setHoverBackpackSlot(false)}
                onDrop={(e) => {
                  if (dragPayload && ITEMS[dragPayload.itemId]?.category === 'backpack') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragPayload.kind === 'grid') {
                      onEquipBackpackFromGrid(dragPayload.uid);
                    } else if (dragPayload.sourceContainerId) {
                      onEquipBackpackFromSource(dragPayload.sourceContainerId, dragPayload.uid);
                    }
                    clearDragState();
                  }
                }}
                className={`border px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                  hoverBackpackSlot
                    ? 'border-lime-400 bg-lime-950/40'
                    : 'border-neutral-800 bg-neutral-950/75'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Backpack
                    className={`w-4 h-4 shrink-0 ${
                      grid.equippedBackpack ? 'text-lime-400' : 'text-neutral-600'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-neutral-200 truncate">
                      {grid.equippedBackpack
                        ? ITEMS[grid.equippedBackpack.itemId]?.name ?? 'Backpack'
                        : 'No Backpack Equipped'}
                    </div>
                    <div className="text-[10px] font-mono-tabular text-neutral-500 truncate">
                      {grid.backpackDims
                        ? `${grid.backpackDims.cols}×${grid.backpackDims.rows} storage grid · Slower reload access`
                        : 'Scavenge a Patrol (4×4) or Raid (5×5) pack in houses/stores'}
                    </div>
                  </div>
                </div>

                {grid.equippedBackpack && (
                  <button
                    type="button"
                    onClick={onUnequipBackpack}
                    className="px-2 py-1 text-[10px] font-mono-tabular border border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-red-500 hover:text-red-300 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    Unequip
                  </button>
                )}
              </div>
            </div>

            {/* 6-Limb Trauma Silhouette & Triage */}
            <div className="border border-neutral-800 bg-neutral-900/55 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400 flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                  6-Zone Trauma
                </span>
                <span className="text-[10px] font-mono-tabular text-neutral-500">
                  [5] Bleed · [6] Med/Splint
                </span>
              </div>

              <div className="grid grid-cols-12 gap-2.5 items-center">
                <div className="col-span-5 flex justify-center bg-neutral-950/75 border border-neutral-800/80 py-1.5">
                  <svg viewBox="0 0 120 205" className="w-24 h-44 select-none">
                    <g onClick={() => setSelectedLimb('head')} className="cursor-pointer">
                      <rect
                        x="47"
                        y="10"
                        width="26"
                        height="28"
                        rx="6"
                        fill={getLimbColors(limbs.head).fill}
                        stroke={selectedLimb === 'head' ? '#fbbf24' : getLimbColors(limbs.head).stroke}
                        strokeWidth={selectedLimb === 'head' ? 2.2 : 1.4}
                      />
                      <text x="60" y="28" textAnchor="middle" fontSize="9" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.head.hp)}
                      </text>
                    </g>
                    <g onClick={() => setSelectedLimb('thorax')} className="cursor-pointer">
                      <polygon
                        points="38,44 82,44 77,104 43,104"
                        fill={getLimbColors(limbs.thorax).fill}
                        stroke={selectedLimb === 'thorax' ? '#fbbf24' : getLimbColors(limbs.thorax).stroke}
                        strokeWidth={selectedLimb === 'thorax' ? 2.2 : 1.4}
                      />
                      <text x="60" y="77" textAnchor="middle" fontSize="10" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.thorax.hp)}
                      </text>
                    </g>
                    <g onClick={() => setSelectedLimb('leftArm')} className="cursor-pointer">
                      <rect
                        x="86"
                        y="46"
                        width="17"
                        height="58"
                        rx="3"
                        fill={getLimbColors(limbs.leftArm).fill}
                        stroke={selectedLimb === 'leftArm' ? '#fbbf24' : getLimbColors(limbs.leftArm).stroke}
                        strokeWidth={selectedLimb === 'leftArm' ? 2.2 : 1.4}
                      />
                      <text x="94.5" y="78" textAnchor="middle" fontSize="8.5" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.leftArm.hp)}
                      </text>
                    </g>
                    <g onClick={() => setSelectedLimb('rightArm')} className="cursor-pointer">
                      <rect
                        x="17"
                        y="46"
                        width="17"
                        height="58"
                        rx="3"
                        fill={getLimbColors(limbs.rightArm).fill}
                        stroke={selectedLimb === 'rightArm' ? '#fbbf24' : getLimbColors(limbs.rightArm).stroke}
                        strokeWidth={selectedLimb === 'rightArm' ? 2.2 : 1.4}
                      />
                      <text x="25.5" y="78" textAnchor="middle" fontSize="8.5" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.rightArm.hp)}
                      </text>
                    </g>
                    <g onClick={() => setSelectedLimb('leftLeg')} className="cursor-pointer">
                      <rect
                        x="63"
                        y="110"
                        width="19"
                        height="82"
                        rx="3"
                        fill={getLimbColors(limbs.leftLeg).fill}
                        stroke={selectedLimb === 'leftLeg' ? '#fbbf24' : getLimbColors(limbs.leftLeg).stroke}
                        strokeWidth={selectedLimb === 'leftLeg' ? 2.2 : 1.4}
                      />
                      <text x="72.5" y="154" textAnchor="middle" fontSize="9" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.leftLeg.hp)}
                      </text>
                    </g>
                    <g onClick={() => setSelectedLimb('rightLeg')} className="cursor-pointer">
                      <rect
                        x="38"
                        y="110"
                        width="19"
                        height="82"
                        rx="3"
                        fill={getLimbColors(limbs.rightLeg).fill}
                        stroke={selectedLimb === 'rightLeg' ? '#fbbf24' : getLimbColors(limbs.rightLeg).stroke}
                        strokeWidth={selectedLimb === 'rightLeg' ? 2.2 : 1.4}
                      />
                      <text x="47.5" y="154" textAnchor="middle" fontSize="9" fill="#e5e5e5" fontFamily="monospace">
                        {Math.ceil(limbs.rightLeg.hp)}
                      </text>
                    </g>
                  </svg>
                </div>

                <div className="col-span-7 space-y-1">
                  {LIMB_IDS.map((id) => {
                    const cfg = LIMB_CONFIGS[id];
                    const l = limbs[id];
                    const colors = getLimbColors(l);
                    const isSel = selectedLimb === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setSelectedLimb(id)}
                        className={`w-full flex items-center justify-between px-2 py-1 text-[11px] font-mono-tabular border transition-colors cursor-pointer ${
                          isSel
                            ? 'border-amber-500 bg-neutral-800/90 text-neutral-100'
                            : 'border-neutral-800 bg-neutral-950/60 text-neutral-300 hover:bg-neutral-900'
                        }`}
                      >
                        <span className="truncate">{cfg.label}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          {l.heavyBleed && <span className="text-red-400 font-semibold">HB</span>}
                          {!l.heavyBleed && l.lightBleed && <span className="text-amber-400 font-semibold">LB</span>}
                          {l.fracture && <span className="text-orange-400 font-semibold">FX</span>}
                          {l.blackedOut && <span className="text-red-500 font-semibold">BLK</span>}
                          <span className={colors.textClass}>
                            {Math.ceil(l.hp)}/{l.maxHp}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-2.5 border-t border-neutral-800 pt-2 flex items-center justify-between gap-2">
                <div className="text-[11px] text-neutral-400 min-w-0">
                  <div className="font-medium text-neutral-200 truncate">
                    {activeLimbCfg.label}
                  </div>
                  <div className="font-mono-tabular text-[10px] text-neutral-400 truncate">
                    {[
                      activeLimb.blackedOut ? 'Blacked Out' : null,
                      activeLimb.heavyBleed ? 'Heavy Bleed' : activeLimb.lightBleed ? 'Light Bleed' : null,
                      activeLimb.fracture ? 'Fractured' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || (activeLimb.hp < activeLimb.maxHp ? 'Damaged tissue' : 'No trauma')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onTreatLimb(selectedLimb)}
                  className="shrink-0 px-2.5 py-1 text-xs font-medium bg-amber-500 text-neutral-950 hover:bg-amber-400 cursor-pointer whitespace-nowrap"
                >
                  Treat Zone
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Pockets (4×1), Tactical Rig (4×3), Backpack Grid */}
          <div className="lg:col-span-5 space-y-3">
            {renderStorageGrid('pockets', 'Pockets', 'Quick Belt Access', grid.pocketsDims)}
            {renderStorageGrid('rig', 'Tactical Chest Rig', 'Fast Reload Priority', grid.rigDims)}

            {grid.backpackDims ? (
              renderStorageGrid(
                'backpack',
                ITEMS[grid.equippedBackpack?.itemId ?? '']?.shortName ?? 'Backpack',
                'Slower Reload Pull',
                grid.backpackDims,
              )
            ) : (
              <div className="border border-dashed border-neutral-800 bg-neutral-900/30 p-5 text-center">
                <Backpack className="w-5 h-5 text-neutral-600 mx-auto mb-1.5" />
                <div className="text-xs font-medium text-neutral-400">
                  Backpack Grid Locked — No Pack Worn
                </div>
                <p className="mt-1 text-[11px] font-mono-tabular text-neutral-500">
                  Search houses, roadside vehicles, and stores for a Patrol Sling (4×4) or Raid Backpack (5×5).
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right-Click Context Menu */}
      {renderContextMenu()}
    </div>
  );
};

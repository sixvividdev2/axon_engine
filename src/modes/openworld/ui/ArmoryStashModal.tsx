import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Backpack,
  Crosshair,
  Lock,
  RefreshCw,
  Shield,
  X,
} from 'lucide-react';
import { resolveWeaponProfile } from '../../../../bodycam-sdk';
import type {
  ItemSourceLocator,
  OperatorTacticalInventory,
  TacticalItem,
} from '../inventory/TetrisInventoryTypes';
import {
  ARMOR_PLATE_MAP,
  OpenWorldCharacter,
  PMC_FACTIONS,
} from '../types';

export interface ArmoryStashModalProps {
  character: OpenWorldCharacter;
  onDepositItem: (locator: ItemSourceLocator) => void;
  onWithdrawItem: (
    stashInstanceId: string,
    target?: 'auto' | 'backpack' | 'secure' | 'belt',
  ) => void;
  onEquipWeapon: (slotKey: 'primary' | 'secondary', weaponId: string) => void;
  onEquipArmorPlate: (plateId: string) => void;
  onResupplyAmmo: () => void;
  onClose: () => void;
}

type ArmoryTab = 'stash' | 'weapons' | 'armor';

interface DeployedEntry {
  key: string;
  zoneLabel: string;
  item: TacticalItem;
  locator: ItemSourceLocator;
}

function formatItemDetail(item: TacticalItem): string {
  switch (item.kind) {
    case 'magazine':
      return `${item.rounds.length}/${item.capacity} rds · ${item.baseCaliber}`;
    case 'ammo_stack':
      return `${item.count}/${item.maxStack} rds · ${item.baseCaliber}`;
    case 'medical':
      return `${item.usesRemaining}/${item.maxUses} uses · +${item.healHp} HP`;
    case 'grenade':
      return `x${item.count} · Tactical Ordnance`;
    case 'armor_plate':
      return `${Math.round(item.durability)}/${item.maxDurability} dur`;
    case 'intel':
    case 'key':
    case 'barter':
      return `x${item.quantity} · ${item.kind.toUpperCase()}`;
    default:
      return `${item.width}x${item.height}`;
  }
}

function formatKindLabel(kind: TacticalItem['kind']): string {
  switch (kind) {
    case 'magazine':
      return 'MAG';
    case 'ammo_stack':
      return 'AMMO';
    case 'medical':
      return 'MED';
    case 'grenade':
      return 'ORD';
    case 'armor_plate':
      return 'PLATE';
    case 'chest_rig':
      return 'RIG';
    case 'backpack':
      return 'PACK';
    case 'weapon_loose':
      return 'WPN';
    case 'intel':
      return 'INTEL';
    case 'key':
      return 'KEY';
    case 'barter':
      return 'LOOT';
  }
}

function collectDeployedEntries(inv: OperatorTacticalInventory | undefined): DeployedEntry[] {
  if (!inv) return [];
  const entries: DeployedEntry[] = [];

  if (inv.chestRig) {
    inv.chestRig.rifleMagSlots.forEach((mag, idx) => {
      if (mag) {
        entries.push({
          key: `rig_r_${idx}_${mag.instanceId}`,
          zoneLabel: `Chest Rig · Rifle Slot ${idx + 1}`,
          item: mag,
          locator: { zone: 'chest_rig_rifle', slotIndex: idx },
        });
      }
    });
    inv.chestRig.pistolMagSlots.forEach((mag, idx) => {
      if (mag) {
        entries.push({
          key: `rig_p_${idx}_${mag.instanceId}`,
          zoneLabel: `Chest Rig · Pistol Slot ${idx + 1}`,
          item: mag,
          locator: { zone: 'chest_rig_pistol', slotIndex: idx },
        });
      }
    });
    for (const placed of inv.chestRig.generalGrid.items) {
      entries.push({
        key: `rig_g_${placed.item.instanceId}`,
        zoneLabel: 'Chest Rig · Utility Pouch',
        item: placed.item,
        locator: { zone: 'chest_rig_grid', instanceId: placed.item.instanceId },
      });
    }
  }

  inv.beltSlots.forEach((item, idx) => {
    if (item) {
      entries.push({
        key: `belt_${idx}_${item.instanceId}`,
        zoneLabel: `Tactical Belt · Slot ${idx + 1}`,
        item,
        locator: { zone: 'belt', slotIndex: idx },
      });
    }
  });

  if (inv.backpack) {
    for (const placed of inv.backpack.grid.items) {
      entries.push({
        key: `pack_${placed.item.instanceId}`,
        zoneLabel: `Backpack · ${inv.backpack.shortLabel}`,
        item: placed.item,
        locator: { zone: 'backpack_grid', instanceId: placed.item.instanceId },
      });
    }
  }

  for (const placed of inv.secureContainer.items) {
    entries.push({
      key: `sec_${placed.item.instanceId}`,
      zoneLabel: `Secure Container (${inv.secureContainer.width}x${inv.secureContainer.height})`,
      item: placed.item,
      locator: { zone: 'secure_grid', instanceId: placed.item.instanceId },
    });
  }

  return entries;
}

export const ArmoryStashModal: React.FC<ArmoryStashModalProps> = ({
  character,
  onDepositItem,
  onWithdrawItem,
  onEquipWeapon,
  onEquipArmorPlate,
  onResupplyAmmo,
  onClose,
}) => {
  const [tab, setTab] = useState<ArmoryTab>('stash');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const factionSpec = PMC_FACTIONS[character.pmcFaction];
  const stashItems = character.tacticalStashItems ?? [];
  const deployedEntries = collectDeployedEntries(character.tacticalInventory);

  const equippedPrimaryId =
    character.tacticalInventory?.primary.weaponId ?? character.equippedKit.primaryWeaponId ?? null;
  const equippedSecondaryId =
    character.tacticalInventory?.secondary.weaponId ?? character.equippedKit.secondaryWeaponId ?? null;
  const equippedPlateId =
    character.tacticalInventory?.armorPlateId ?? character.equippedKit.armorPlateId ?? 'plate_nij3_steel';

  const primaryProfile = equippedPrimaryId ? resolveWeaponProfile(equippedPrimaryId) : null;
  const secondaryProfile = equippedSecondaryId ? resolveWeaponProfile(equippedSecondaryId) : null;
  const activePlateSpec = ARMOR_PLATE_MAP[equippedPlateId];

  const stashTotalUsd = stashItems.reduce((sum, item) => sum + Math.max(0, item.valueUsd), 0);

  return (
    <div className="pointer-events-auto fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-4">
      <div className="flex max-h-[92vh] w-full max-w-[1180px] flex-col border border-white/18 bg-[#0b0e13] text-neutral-100 shadow-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/12 bg-[#10141c] px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 font-mono-tabular">
            <Lock className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-neutral-50">
              {factionSpec.name} · FOB Armory &amp; Stash Lockers
            </span>
            <span className="text-xs text-neutral-300">
              {character.callsign} ·{' '}
              <strong className="text-emerald-300">${character.cash.toLocaleString()}</strong> ·{' '}
              <span className="text-amber-300">{stashItems.length} Locker Items</span>{' '}
              <span className="text-neutral-500">(${stashTotalUsd.toLocaleString()})</span>
            </span>
          </div>

          <div className="flex items-center gap-2 font-mono-tabular text-xs">
            <button
              type="button"
              onClick={onResupplyAmmo}
              className="flex cursor-pointer items-center gap-1.5 border border-emerald-500/50 bg-emerald-950/45 px-2.5 py-1 text-[11px] font-medium text-emerald-200 transition-colors hover:border-emerald-400 hover:bg-emerald-900/55"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Refill Reserve Ammo</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-1 border border-white/15 bg-[#151a24] px-2.5 py-1 text-[11px] text-neutral-200 transition-colors hover:border-amber-400/60"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close [Esc]</span>
            </button>
          </div>
        </div>

        {/* Two-Column Armory Body */}
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-white/10 lg:grid-cols-12 lg:divide-x lg:divide-y-0">
          {/* Left Column: Stash Lockers, Firearms Rack, Armor Plates */}
          <div className="flex min-h-0 flex-col lg:col-span-7">
            <div className="flex items-center gap-1 border-b border-white/10 bg-[#0e1219] px-4 py-2">
              {(
                [
                  { id: 'stash', label: `Stash Lockers (${stashItems.length})`, icon: Archive },
                  {
                    id: 'weapons',
                    label: `Firearms Rack (${character.arsenal.ownedWeaponIds.length})`,
                    icon: Crosshair,
                  },
                  {
                    id: 'armor',
                    label: `Armor Plates (${character.unlocks.unlockedArmorPlateIds.length})`,
                    icon: Shield,
                  },
                ] as const
              ).map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors ${
                      tab === t.id
                        ? 'border-amber-400/70 bg-amber-950/50 text-amber-200'
                        : 'border-white/10 bg-[#141922] text-neutral-400 hover:border-white/25 hover:text-neutral-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === 'stash' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between font-mono-tabular text-[11px] text-neutral-400">
                    <span>PERSISTENT PERSONAL LOCKER BAY · SURVIVES FIELD DEATH</span>
                    <span>WITHDRAW TO FIELD KIT</span>
                  </div>
                  {stashItems.length === 0 ? (
                    <div className="border border-white/10 bg-[#10141c] p-6 text-center font-mono-tabular text-xs text-neutral-400">
                      Locker bay is empty. Deposit mags, meds, ordnance, or salvage from your Deployed Field Kit on the right.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {stashItems.map((item) => (
                        <div
                          key={item.instanceId}
                          className="flex flex-wrap items-center justify-between gap-2 border border-white/10 bg-[#11161f] px-3 py-2 font-mono-tabular"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs font-semibold text-neutral-100">
                              <span className="text-[10px] font-bold tracking-wider text-amber-300">
                                {formatKindLabel(item.kind)}
                              </span>
                              <span className="truncate">{item.name}</span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-neutral-400">
                              {formatItemDetail(item)} · {item.weightKg.toFixed(2)} kg · ${item.valueUsd.toLocaleString()}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => onWithdrawItem(item.instanceId, 'auto')}
                              className="flex cursor-pointer items-center gap-1 border border-emerald-500/55 bg-emerald-950/45 px-2.5 py-1 text-[11px] font-medium text-emerald-200 transition-colors hover:border-emerald-400 hover:bg-emerald-900/55"
                            >
                              <span>Withdraw</span>
                              <ArrowRight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onWithdrawItem(item.instanceId, 'backpack')}
                              className="cursor-pointer border border-white/15 bg-[#161c27] px-2 py-1 text-[10px] text-neutral-300 transition-colors hover:border-amber-400/60 hover:text-amber-200"
                              title="Place directly into Backpack grid"
                            >
                              Pack
                            </button>
                            <button
                              type="button"
                              onClick={() => onWithdrawItem(item.instanceId, 'secure')}
                              className="cursor-pointer border border-white/15 bg-[#161c27] px-2 py-1 text-[10px] text-neutral-300 transition-colors hover:border-sky-400/60 hover:text-sky-200"
                              title="Place directly into Secure Container"
                            >
                              Secure
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'weapons' && (
                <div className="space-y-2">
                  <div className="font-mono-tabular text-[11px] text-neutral-400">
                    ARMORY RACK · EQUIP OWNED FIREARMS INTO ACTIVE PRIMARY OR SECONDARY SLOTS
                  </div>
                  <div className="space-y-1.5">
                    {character.arsenal.ownedWeaponIds.map((wId) => {
                      const prof = resolveWeaponProfile(wId);
                      const isPrimary = equippedPrimaryId === prof.id;
                      const isSecondary = equippedSecondaryId === prof.id;
                      return (
                        <div
                          key={wId}
                          className={`flex flex-wrap items-center justify-between gap-2 border px-3 py-2.5 font-mono-tabular ${
                            isPrimary || isSecondary
                              ? 'border-amber-400/55 bg-amber-950/20'
                              : 'border-white/10 bg-[#11161f]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-neutral-100">
                              <span>{prof.name}</span>
                              {isPrimary && (
                                <span className="text-[10px] font-bold uppercase text-amber-300">
                                  · ACTIVE PRIMARY
                                </span>
                              )}
                              {isSecondary && (
                                <span className="text-[10px] font-bold uppercase text-sky-300">
                                  · ACTIVE SECONDARY
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11px] text-neutral-400">
                              {prof.caliberLabel} · {prof.fireMode.toUpperCase()} · {prof.magCapacity} rd mag ·{' '}
                              {prof.category.toUpperCase()}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isPrimary}
                              onClick={() => onEquipWeapon('primary', prof.id)}
                              className={`cursor-pointer border px-2.5 py-1 text-[11px] font-semibold uppercase transition-colors ${
                                isPrimary
                                  ? 'cursor-default border-amber-400/50 bg-amber-950/50 text-amber-200 opacity-75'
                                  : 'border-white/18 bg-[#171d28] text-neutral-200 hover:border-amber-400/70 hover:text-amber-200'
                              }`}
                            >
                              {isPrimary ? 'Primary' : 'Set Primary'}
                            </button>
                            <button
                              type="button"
                              disabled={isSecondary}
                              onClick={() => onEquipWeapon('secondary', prof.id)}
                              className={`cursor-pointer border px-2.5 py-1 text-[11px] font-semibold uppercase transition-colors ${
                                isSecondary
                                  ? 'cursor-default border-sky-400/50 bg-sky-950/50 text-sky-200 opacity-75'
                                  : 'border-white/18 bg-[#171d28] text-neutral-200 hover:border-sky-400/70 hover:text-sky-200'
                              }`}
                            >
                              {isSecondary ? 'Secondary' : 'Set Secondary'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {tab === 'armor' && (
                <div className="space-y-2">
                  <div className="font-mono-tabular text-[11px] text-neutral-400">
                    BALLISTIC PLATE BENCH · SWAP UNLOCKED HARD PLATES INTO CARRIER
                  </div>
                  <div className="space-y-1.5">
                    {character.unlocks.unlockedArmorPlateIds.map((plateId) => {
                      const spec = ARMOR_PLATE_MAP[plateId];
                      if (!spec) return null;
                      const isEquipped = equippedPlateId === plateId;
                      return (
                        <div
                          key={plateId}
                          className={`flex flex-wrap items-center justify-between gap-2 border px-3 py-2.5 font-mono-tabular ${
                            isEquipped
                              ? 'border-emerald-400/55 bg-emerald-950/20'
                              : 'border-white/10 bg-[#11161f]'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs font-semibold text-neutral-100">
                              <span className="text-[10px] font-bold text-emerald-300">
                                {spec.ratingLabel}
                              </span>
                              <span>{spec.name}</span>
                              {isEquipped && (
                                <span className="text-[10px] font-bold uppercase text-emerald-300">
                                  · INSERTED
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11px] text-neutral-400">
                              Durability {spec.durability} · Weight {spec.weightKg.toFixed(1)} kg · Value $
                              {spec.priceUsd.toLocaleString()}
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={isEquipped}
                            onClick={() => onEquipArmorPlate(plateId)}
                            className={`cursor-pointer border px-3 py-1 text-[11px] font-semibold uppercase transition-colors ${
                              isEquipped
                                ? 'cursor-default border-emerald-400/50 bg-emerald-950/50 text-emerald-200 opacity-75'
                                : 'border-white/18 bg-[#171d28] text-neutral-200 hover:border-emerald-400/70 hover:text-emerald-200'
                            }`}
                          >
                            {isEquipped ? 'Equipped' : 'Equip Plate'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Deployed Field Kit (Deposit into Lockers) */}
          <div className="flex min-h-0 flex-col bg-[#0d1118] lg:col-span-5">
            <div className="border-b border-white/10 bg-[#10141c] px-4 py-2.5 font-mono-tabular">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-100">
                  <Backpack className="h-3.5 w-3.5 text-sky-300" />
                  <span>Deployed Field Kit</span>
                </span>
                <span className="text-[11px] text-neutral-400">
                  {deployedEntries.length} Stowable Items
                </span>
              </div>

              {/* Active Equipped Loadout Strip */}
              <div className="mt-2 grid grid-cols-3 gap-1.5 text-[10px]">
                <div className="border border-white/10 bg-[#141922] px-2 py-1.5">
                  <div className="text-neutral-500">PRIMARY [1]</div>
                  <div className="truncate font-semibold text-amber-200">
                    {primaryProfile ? primaryProfile.name : 'Empty'}
                  </div>
                </div>
                <div className="border border-white/10 bg-[#141922] px-2 py-1.5">
                  <div className="text-neutral-500">SECONDARY [2]</div>
                  <div className="truncate font-semibold text-sky-200">
                    {secondaryProfile ? secondaryProfile.name : 'Empty'}
                  </div>
                </div>
                <div className="border border-white/10 bg-[#141922] px-2 py-1.5">
                  <div className="text-neutral-500">PLATE CARRIER</div>
                  <div className="truncate font-semibold text-emerald-200">
                    {activePlateSpec ? activePlateSpec.ratingLabel : character.equippedKit.armorName}
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {deployedEntries.length === 0 ? (
                <div className="border border-white/10 bg-[#11161f] p-6 text-center font-mono-tabular text-xs text-neutral-400">
                  No loose magazines, meds, grenades, or loot items in Rig, Belt, Backpack, or Secure Container.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {deployedEntries.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex items-center justify-between gap-2 border border-white/10 bg-[#11161f] px-3 py-2 font-mono-tabular"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-100">
                          <span className="text-[10px] font-bold text-sky-300">
                            {formatKindLabel(entry.item.kind)}
                          </span>
                          <span className="truncate">{entry.item.name}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-neutral-400">
                          {entry.zoneLabel} · {formatItemDetail(entry.item)}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => onDepositItem(entry.locator)}
                        className="flex shrink-0 cursor-pointer items-center gap-1 border border-amber-500/50 bg-amber-950/40 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:border-amber-400 hover:bg-amber-900/50"
                      >
                        <ArrowLeft className="h-3 w-3" />
                        <span>Store</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

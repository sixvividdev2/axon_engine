import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Award,
  Check,
  Clock,
  Compass,
  Crosshair,
  HeartPulse,
  Lock,
  Plus,
  Shield,
  Skull,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { resolveWeaponProfile } from '../../../bodycam-sdk/weaponProfiles';
import {
  DEFAULT_FACE_PRESET_ID,
  FacePresetId,
  getFacePresetsForOperator,
} from '../../../bodycam-sdk/operator/OperatorTypes';
import { characterRoster, STARTING_CHARACTER_CASH_USD } from './CharacterRoster';
import { useHideoutShardAdapter } from './HideoutShardAdapter';
import {
  CharacterDeathOutcome,
  computeFieldHospitalFee,
  getAvailableFieldHospitals,
  processCharacterDeath,
} from './PermadeathService';
import { shardStore } from './ShardStore';
import {
  computeUnifiedRestockRemainingSec,
  evaluateSupplyResourceStatus,
  formatRestockTimer,
} from './world/OpenWorldLogisticsEconomy';
import { createPdaBatteryItem, stowItemIntoOperatorInventory } from './inventory/TetrisInventoryCore';
import {
  ARMOR_PLATE_CATALOG,
  CHARACTER_SLOT_IDS,
  CharacterBodyType,
  CharacterSlotId,
  getSecureContainerCapacity,
  getStandingTier,
  OPENWORLD_CONTRACT_CATALOG,
  PMC_FACTIONS,
  PmcFactionId,
  QUARTERMASTER_ATTACHMENT_OFFERS,
  QUARTERMASTER_FIREARM_OFFERS,
  SHARD_RULES,
  ShardMode,
  SUB_FACTION_LIST,
  SUB_FACTION_MAP,
  SubFactionId,
  TRADER_LIST,
  TRADER_MAP,
  TraderId,
} from './types';

type SubTabId =
  | 'shards_reputation'
  | 'traders_unlocks'
  | 'arsenal_stash'
  | 'hospital_permadeath';

interface PerimeterOpsTerminalPanelProps {
  onDeployOpenWorld?: (slotId: CharacterSlotId) => void;
}

function formatUsd(amount: number): string {
  return `$${Math.max(0, Math.round(amount)).toLocaleString()}`;
}

/**
 * Perimeter Operations Ready Room Terminal Panel.
 * Manages the 3-slot persistent Character Roster, Dual-Shard (`PvPvE` / `PvE`) state,
 * per-character trader/contract/weapon/optic/armor-plate unlock entitlements,
 * isolated 3D Hideout Arsenal Wall, Stash vs Secure Container, and Field Hospital / Permadeath loop.
 */
export const PerimeterOpsTerminalPanel: React.FC<PerimeterOpsTerminalPanelProps> = ({
  onDeployOpenWorld,
}) => {
  const { roster, shards, activeCharacter, activeShard, bankruptcy } = useHideoutShardAdapter();

  const [subTab, setSubTab] = useState<SubTabId>('shards_reputation');
  const [creatingSlot, setCreatingSlot] = useState<CharacterSlotId | null>(null);
  const [callsignInput, setCallsignInput] = useState('');
  const [shardInput, setShardInput] = useState<ShardMode>('PvPvE');
  const [factionInput, setFactionInput] = useState<PmcFactionId>('pmc_alpha');
  const [bodyInput, setBodyInput] = useState<CharacterBodyType>('male');
  const [facePresetInput, setFacePresetInput] = useState<FacePresetId>(DEFAULT_FACE_PRESET_ID);
  const [formError, setFormError] = useState<string | null>(null);

  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState<CharacterSlotId | null>(null);
  const [selectedHospitalId, setSelectedHospitalId] = useState<string>('');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [lastDeathOutcome, setLastDeathOutcome] = useState<CharacterDeathOutcome | null>(null);
  const [clockTick, setClockTick] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setClockTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const hideoutSupply = useMemo(() => {
    if (!activeCharacter || !activeShard) return null;
    const pool = activeShard.pmcSupplyPools[activeCharacter.pmcFaction];
    const sabotage = activeShard.restockPenaltySec[activeCharacter.pmcFaction] ?? 0;
    const ammoStatus = evaluateSupplyResourceStatus('ammo', pool.ammo);
    const fuelStatus = evaluateSupplyResourceStatus('fuelParts', pool.fuelParts);
    const restock = computeUnifiedRestockRemainingSec(pool, sabotage, clockTick);
    return { pool, ammoStatus, fuelStatus, restock, sabotage };
  }, [activeCharacter, activeShard, clockTick]);

  const handlePurchasePdaBattery = () => {
    if (!activeCharacter || !hideoutSupply) return;
    const price = Math.round(180 * hideoutSupply.fuelStatus.priceMultiplier);
    if (activeCharacter.cash < price) {
      setActionNotice('Insufficient cash for CR123A PDA Battery.');
      return;
    }
    const fresh = characterRoster.getCharacter(activeCharacter.slotId);
    if (!fresh?.tacticalInventory) {
      setActionNotice('Operator tactical rig unavailable.');
      return;
    }
    const placed = stowItemIntoOperatorInventory(fresh.tacticalInventory, createPdaBatteryItem(100));
    if (!placed) {
      setActionNotice('No 1x1 Tetris grid space available in Chest Rig or Backpack.');
      return;
    }
    characterRoster.adjustCash(activeCharacter.slotId, -price);
    characterRoster.updateTacticalInventory(activeCharacter.slotId, fresh.tacticalInventory);
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'trader_purchase',
      `${activeCharacter.callsign} bought CR123A PDA Cell (${formatUsd(price)})`,
    );
    setActionNotice(`Issued CR123A Lithium PDA Cell (${formatUsd(price)}) into field rig.`);
  };

  const hospitals = useMemo(
    () => (activeCharacter ? getAvailableFieldHospitals(activeCharacter) : []),
    [activeCharacter],
  );

  const effectiveHospitalId = useMemo(() => {
    if (!hospitals.length) return '';
    const valid = hospitals.find((h) => h.id === selectedHospitalId && h.unlocked);
    return valid ? valid.id : hospitals[0].id;
  }, [hospitals, selectedHospitalId]);

  const startCreatingSlot = (slotId: CharacterSlotId) => {
    const slotNum = CHARACTER_SLOT_IDS.indexOf(slotId) + 1;
    setCreatingSlot(slotId);
    setCallsignInput(`NOMAD-0${slotNum}`);
    setShardInput(slotNum === 2 ? 'PvE' : 'PvPvE');
    setFactionInput(slotNum === 2 ? 'pmc_bravo' : 'pmc_alpha');
    setBodyInput(slotNum === 2 ? 'female' : 'male');
    setFacePresetInput(
      slotNum === 2 ? 'face_02' : slotNum === 3 ? 'face_03' : DEFAULT_FACE_PRESET_ID,
    );
    setFormError(null);
    setConfirmDeleteSlot(null);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!creatingSlot) return;
    const res = characterRoster.createCharacter({
      slotId: creatingSlot,
      callsign: callsignInput,
      shardMode: shardInput,
      pmcFaction: factionInput,
      bodyType: bodyInput,
      facePreset: facePresetInput,
      activate: true,
    });
    if (!res.ok || !res.character) {
      setFormError(res.error ?? 'Failed to create character.');
      return;
    }
    shardStore.recordDiscreteTransition(
      res.character.shardMode,
      'character_created',
      `${res.character.callsign} (${PMC_FACTIONS[res.character.pmcFaction].name}, ${res.character.bodyType}) entered ${res.character.shardMode} shard`,
    );
    setCreatingSlot(null);
    setFormError(null);
    setLastDeathOutcome(null);
    setActionNotice(
      `Activated ${res.character.callsign} — Hideout Arsenal Wall & ${res.character.bodyType === 'female' ? 'Female' : 'Male'} rig synced.`,
    );
  };

  const handleActivateSlot = (slotId: CharacterSlotId) => {
    const ok = characterRoster.setActiveSlot(slotId);
    if (!ok) return;
    const target = characterRoster.getCharacter(slotId);
    setConfirmDeleteSlot(null);
    setLastDeathOutcome(null);
    if (target) {
      setActionNotice(
        `Switched Hideout to ${target.callsign} (${target.shardMode} · ${PMC_FACTIONS[target.pmcFaction].name} · ${target.arsenal.ownedWeaponIds.length} weapons on wall).`,
      );
    }
  };

  const handleSwitchClassic = () => {
    characterRoster.setActiveSlot(null);
    setConfirmDeleteSlot(null);
    setActionNotice('Returned Hideout Arsenal Wall to Classic Career Mode.');
  };

  const handleDeleteSlot = (slotId: CharacterSlotId) => {
    const removed = characterRoster.deleteCharacter(slotId);
    setConfirmDeleteSlot(null);
    if (removed) {
      shardStore.recordDiscreteTransition(
        removed.shardMode,
        'character_deleted',
        `${removed.callsign} (${slotId}) manually retired`,
      );
      setActionNotice(`Deleted ${removed.callsign} (${slotId}) and cleared slot progression.`);
    }
  };

  const handlePurchaseWeapon = (weaponId: string, priceUsd: number) => {
    if (!activeCharacter) return;
    const res = characterRoster.purchaseWeaponToArsenal(activeCharacter.slotId, weaponId, priceUsd);
    if (!res.ok) {
      setActionNotice(res.error ?? 'Unable to purchase firearm.');
      return;
    }
    const prof = resolveWeaponProfile(weaponId);
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'trader_purchase',
      `${activeCharacter.callsign} purchased ${prof.name} for ${formatUsd(priceUsd)}`,
    );
    setActionNotice(
      `Purchased ${prof.name} for ${formatUsd(priceUsd)} — mounted live on ${activeCharacter.callsign}'s 3D Arsenal Wall.`,
    );
  };

  const handleLevelUpTrader = (traderId: TraderId) => {
    if (!activeCharacter) return;
    const res = characterRoster.levelUpTrader(activeCharacter.slotId, traderId);
    if (!res.ok) {
      setActionNotice(res.error ?? 'Unable to level up trader.');
      return;
    }
    const trader = TRADER_MAP[traderId];
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'trader_level_up',
      `${activeCharacter.callsign} advanced ${trader.name} to Lv ${res.newLevel} (character-scoped unlocks)`,
    );
    const unlockedCount =
      (res.newlyUnlockedWeapons?.length ?? 0) +
      (res.newlyUnlockedAttachments?.length ?? 0) +
      (res.newlyUnlockedArmorPlates?.length ?? 0);
    setActionNotice(
      `${activeCharacter.callsign} reached ${trader.name} Lv ${res.newLevel} (+${unlockedCount} new entitlements unlocked strictly for this character).`,
    );
  };

  const handleCompleteContract = (contractId: string) => {
    if (!activeCharacter) return;
    const res = characterRoster.completeContract(activeCharacter.slotId, contractId);
    if (!res.ok) {
      setActionNotice(res.error ?? 'Unable to complete contract.');
      return;
    }
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'contract_completed',
      `${activeCharacter.callsign} completed contract ${contractId} (per-character unlock entitlements granted)`,
    );
    setActionNotice(
      `Contract completed for ${activeCharacter.callsign}: unlocked ${res.newlyUnlockedWeapons?.length ?? 0} firearm(s), ${res.newlyUnlockedAttachments?.length ?? 0} optic/attachment(s), and ${res.newlyUnlockedArmorPlates?.length ?? 0} armor plate(s) exclusively on this slot.`,
    );
  };

  const handlePurchaseAttachment = (attachmentId: string, label: string, priceUsd: number) => {
    if (!activeCharacter) return;
    const res = characterRoster.purchaseAttachmentToCharacter(
      activeCharacter.slotId,
      attachmentId,
      priceUsd,
    );
    if (!res.ok) {
      setActionNotice(res.error ?? 'Unable to buy attachment.');
      return;
    }
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'trader_purchase',
      `${activeCharacter.callsign} purchased ${label} for ${formatUsd(priceUsd)}`,
    );
    setActionNotice(`Purchased ${label} for ${formatUsd(priceUsd)} into ${activeCharacter.callsign}'s stash.`);
  };

  const handlePurchaseArmorPlate = (plateId: string, plateName: string) => {
    if (!activeCharacter) return;
    const res = characterRoster.purchaseArmorPlateToCharacter(activeCharacter.slotId, plateId, true);
    if (!res.ok) {
      setActionNotice(res.error ?? 'Unable to buy armor plate.');
      return;
    }
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'trader_purchase',
      `${activeCharacter.callsign} equipped ${plateName}`,
    );
    setActionNotice(`Purchased & equipped ${plateName} on ${activeCharacter.callsign}.`);
  };

  const handleAdjustStanding = (subFactionId: SubFactionId, delta: number) => {
    if (!activeCharacter) return;
    const updated = characterRoster.updateSubFactionStanding(
      activeCharacter.slotId,
      subFactionId,
      delta,
    );
    if (!updated) return;
    const sf = SUB_FACTION_MAP[subFactionId];
    const nextVal = updated.subFactionStanding[subFactionId];
    shardStore.recordDiscreteTransition(
      activeCharacter.shardMode,
      'reputation_update',
      `${activeCharacter.callsign} standing with ${sf.shortName}: ${nextVal >= 0 ? '+' : ''}${nextVal} (${getStandingTier(nextVal)})`,
    );
    setActionNotice(
      `${sf.name} standing updated to ${nextVal >= 0 ? '+' : ''}${nextVal} (${getStandingTier(nextVal)}).`,
    );
  };

  const handleSimulateFieldDeath = () => {
    if (!activeCharacter) return;
    const outcome = processCharacterDeath(characterRoster, shardStore, {
      slotId: activeCharacter.slotId,
      hospitalId: effectiveHospitalId || undefined,
      causeOfDeath: 'KIA · Field Operations Simulation',
      sectorLabel:
        activeCharacter.pmcFaction === 'pmc_alpha'
          ? 'Coastal Port Container Pier'
          : 'Highland Quarry Perimeter',
      worldX: activeCharacter.pmcFaction === 'pmc_alpha' ? -840 : 620,
      worldZ: activeCharacter.pmcFaction === 'pmc_alpha' ? 1120 : -490,
    });
    if (!outcome) return;
    setLastDeathOutcome(outcome);
    if (outcome.outcome === 'permadeath_wiped') {
      setActionNotice(
        `PERMADEATH WIPE: ${outcome.callsign} died with ${formatUsd(outcome.cashAtDeath)} below the ${formatUsd(outcome.requiredFee)} Field Hospital fee. Character slot deleted.`,
      );
    } else {
      setActionNotice(
        `Field Hospital Respawn: ${outcome.callsign} recovered at ${outcome.hospital.name} (-${formatUsd(outcome.feePaid)}). Equipped gear dropped to ${activeCharacter.shardMode} corpse; Secure Container retained.`,
      );
    }
  };

  const secureSlotsUsed = activeCharacter
    ? activeCharacter.secureContainerItems.reduce((acc, it) => acc + Math.max(1, it.slots), 0)
    : 0;
  const secureSlotsCap = activeCharacter
    ? getSecureContainerCapacity(activeCharacter.secureContainerTier)
    : 4;

  return (
    <div className="flex flex-col gap-5">
      {/* Header & Mode Switch */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-wide text-neutral-50">
            Perimeter Operations Roster
          </h2>
          <p className="mt-0.5 text-xs text-neutral-400">
            3 independent characters with locked Shard, PMC Faction, and M/F Rig. Switching slots
            updates the 3D Hideout Arsenal Wall, operator model, and GPS PDA live.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono-tabular text-xs text-neutral-400">
            Active Hideout Context:{' '}
            <strong className="font-semibold text-neutral-100">
              {activeCharacter
                ? `${activeCharacter.callsign} (${activeCharacter.shardMode})`
                : 'Classic Career Mode'}
            </strong>
          </span>
          {activeCharacter && onDeployOpenWorld && (
            <button
              type="button"
              onClick={() => onDeployOpenWorld(activeCharacter.slotId)}
              className="flex cursor-pointer items-center gap-1.5 border border-amber-400 bg-amber-500/20 px-3.5 py-1.5 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-500 hover:text-neutral-950 whitespace-nowrap shrink-0"
            >
              <Compass className="h-3.5 w-3.5" />
              <span>Deploy to 4km Perimeter</span>
            </button>
          )}
          {activeCharacter && (
            <button
              type="button"
              onClick={handleSwitchClassic}
              className="cursor-pointer border border-white/14 bg-[#151a22] px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap shrink-0"
            >
              Return to Classic Mode
            </button>
          )}
        </div>
      </div>

      {/* Bankruptcy Warning Banner (Explicit text + icon, never color alone) */}
      {activeCharacter && bankruptcy?.isBankruptcyRisk && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border border-red-500/70 bg-red-950/65 px-4 py-3 text-xs text-red-100"
        >
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
            <span className="font-mono-tabular font-semibold tracking-wide">
              BANKRUPTCY WARNING · {activeCharacter.callsign} CASH {formatUsd(bankruptcy.currentCash)}{' '}
              BELOW MEDEVAC FEE {formatUsd(bankruptcy.nextRespawnFee)} (SHORTFALL{' '}
              {formatUsd(bankruptcy.shortfall)}) · NEXT DEATH PERMANENTLY WIPES THIS CHARACTER SLOT
            </span>
          </div>
          <span className="font-mono-tabular text-[11px] font-semibold uppercase text-red-300">
            PDA ALERT ACTIVE
          </span>
        </div>
      )}

      {/* Action Feedback / Post-Death Outcome Banner */}
      {lastDeathOutcome && (
        <div
          className={`flex flex-wrap items-start justify-between gap-3 border px-4 py-3 text-xs ${
            lastDeathOutcome.outcome === 'permadeath_wiped'
              ? 'border-red-500/70 bg-[#1c0d10] text-red-100'
              : 'border-amber-500/55 bg-[#19150d] text-amber-100'
          }`}
        >
          <div className="space-y-1">
            <div className="font-display text-sm font-bold tracking-wide">
              {lastDeathOutcome.outcome === 'permadeath_wiped'
                ? `PERMADEATH WIPE — ${lastDeathOutcome.callsign} (${lastDeathOutcome.slotId}) DELETED`
                : `FIELD HOSPITAL RESPAWN — ${lastDeathOutcome.callsign}`}
            </div>
            {lastDeathOutcome.outcome === 'permadeath_wiped' ? (
              <div className="font-mono-tabular text-xs text-red-200/90">
                Cash at death {formatUsd(lastDeathOutcome.cashAtDeath)} &lt; Medevac fee{' '}
                {formatUsd(lastDeathOutcome.requiredFee)} · Purged{' '}
                {lastDeathOutcome.wipedSummary.unlockedWeapons} weapon unlocks,{' '}
                {lastDeathOutcome.wipedSummary.unlockedAttachments} optics,{' '}
                {lastDeathOutcome.wipedSummary.unlockedArmorPlates} armor plates,{' '}
                {lastDeathOutcome.wipedSummary.stashItemCount} stash stacks &amp;{' '}
                {lastDeathOutcome.wipedSummary.ownedVehicleCount} vehicles · Corpse logged in{' '}
                {lastDeathOutcome.droppedCorpse.shardMode} shard.
              </div>
            ) : (
              <div className="font-mono-tabular text-xs text-amber-200/90">
                Recovered at {lastDeathOutcome.hospital.name} · Paid{' '}
                {formatUsd(lastDeathOutcome.feePaid)} · Remaining cash{' '}
                {formatUsd(lastDeathOutcome.remainingCash)} · Dropped{' '}
                {lastDeathOutcome.droppedCorpse.droppedWeaponIds.length} field weapon(s) to{' '}
                {lastDeathOutcome.droppedCorpse.shardMode} corpse · Retained{' '}
                {lastDeathOutcome.retainedSecureItems.length} Secure Container item(s).
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setLastDeathOutcome(null)}
            className="cursor-pointer border border-white/15 bg-[#12151b] px-2.5 py-1 text-[11px] text-neutral-300 hover:text-white whitespace-nowrap shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {actionNotice && !lastDeathOutcome && (
        <div className="flex items-center justify-between gap-3 border border-white/12 bg-[#11161e] px-4 py-2 font-mono-tabular text-xs text-neutral-200">
          <span>{actionNotice}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="cursor-pointer text-[11px] text-neutral-400 hover:text-neutral-100 whitespace-nowrap"
          >
            Clear
          </button>
        </div>
      )}

      {/* 3-Slot Character Roster Grid */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {CHARACTER_SLOT_IDS.map((slotId, index) => {
          const char = roster.slots[slotId];
          const isActive = roster.activeSlotId === slotId;

          if (!char) {
            return (
              <div
                key={slotId}
                className="flex min-h-[156px] flex-col justify-between border border-dashed border-white/15 bg-[#0f1319] p-4"
              >
                <div>
                  <div className="font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-500">
                    Slot 0{index + 1} · Empty
                  </div>
                  <div className="mt-1 font-display text-base font-semibold text-neutral-300">
                    Unassigned Operator Slot
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    Starts with {formatUsd(STARTING_CHARACTER_CASH_USD)}, faction Arsenal Wall,
                    2x2 Secure Container, and independent reputation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startCreatingSlot(slotId)}
                  className="mt-3 flex cursor-pointer items-center justify-center gap-2 border border-amber-500/45 bg-amber-500/12 px-3 py-2 text-xs font-semibold text-amber-200 transition-colors hover:border-amber-400 hover:bg-amber-500/20 whitespace-nowrap"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Create Character</span>
                </button>
              </div>
            );
          }

          const faction = PMC_FACTIONS[char.pmcFaction];
          const fee = computeFieldHospitalFee(char);
          const bankrupt = char.cash < fee;

          return (
            <div
              key={slotId}
              className={`flex min-h-[156px] flex-col justify-between border p-4 transition-colors ${
                isActive
                  ? 'border-amber-400/80 bg-[#141922]'
                  : 'border-white/12 bg-[#10141b] hover:border-white/25'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                    Slot 0{index + 1} · {isActive ? 'ACTIVE IN HIDEOUT' : 'STANDBY'}
                  </span>
                  <span className="flex items-center gap-1 font-mono-tabular text-[11px] text-neutral-400">
                    <Lock className="h-3 w-3 text-neutral-500" />
                    <span>{char.shardMode}</span>
                  </span>
                </div>

                <div className="mt-1 flex items-baseline justify-between gap-2">
                  <span className="font-display text-lg font-bold tracking-wide text-neutral-50">
                    {char.callsign}
                  </span>
                  <span className="font-mono-tabular text-sm font-semibold text-emerald-300">
                    {formatUsd(char.cash)}
                  </span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono-tabular text-[11px] text-neutral-400">
                  <span
                    className={
                      char.pmcFaction === 'pmc_alpha' ? 'text-sky-300' : 'text-amber-300'
                    }
                  >
                    {faction.name}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{char.bodyType === 'female' ? 'Female Rig' : 'Male Rig'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{char.arsenal.ownedWeaponIds.length} Firearms</span>
                  <span aria-hidden="true">·</span>
                  <span>Tier {char.missions.progressionTier}</span>
                </div>

                <div className="mt-2 font-mono-tabular text-[11px]">
                  {bankrupt ? (
                    <span className="font-semibold text-red-400">
                      BANKRUPTCY RISK · Medevac {formatUsd(fee)}
                    </span>
                  ) : (
                    <span className="text-neutral-400">
                      Field Hospital Fee {formatUsd(fee)} · Safe Margin
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/8 pt-2.5">
                {isActive ? (
                  <span className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-amber-300">
                    <Check className="h-3.5 w-3.5" />
                    <span>Loaded in Hideout</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleActivateSlot(slotId)}
                    className="cursor-pointer bg-amber-500 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap shrink-0"
                  >
                    Switch to Slot
                  </button>
                )}

                {confirmDeleteSlot === slotId ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleDeleteSlot(slotId)}
                      className="cursor-pointer bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-500 whitespace-nowrap"
                    >
                      Confirm Wipe
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteSlot(null)}
                      className="cursor-pointer border border-white/12 bg-[#161b23] px-2 py-1 text-[11px] text-neutral-300 hover:text-white whitespace-nowrap"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteSlot(slotId)}
                    className="flex cursor-pointer items-center gap-1 border border-white/10 bg-[#151a22] px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:border-red-500/50 hover:text-red-300 whitespace-nowrap shrink-0"
                    title="Delete character slot"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Delete</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Inline Character Creation Drawer */}
      {creatingSlot && (
        <form
          onSubmit={handleCreateSubmit}
          className="border border-amber-500/45 bg-[#11161e] p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-amber-400" />
              <h3 className="font-display text-lg font-bold text-neutral-50">
                Create Operator — Slot 0{CHARACTER_SLOT_IDS.indexOf(creatingSlot) + 1}
              </h3>
            </div>
            <span className="font-mono-tabular text-[11px] text-amber-300">
              Shard, PMC Faction, Body Rig &amp; Callsign are permanently locked after creation
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-4">
            {/* Callsign */}
            <div>
              <label
                htmlFor="ow-callsign"
                className="block font-mono-tabular text-[11px] text-neutral-400"
              >
                Unique Callsign
              </label>
              <input
                id="ow-callsign"
                type="text"
                maxLength={20}
                value={callsignInput}
                onChange={(e) => setCallsignInput(e.target.value)}
                placeholder="e.g. VANGUARD-1"
                className="mt-1.5 w-full border border-white/14 bg-[#0c1016] px-3 py-2 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
              />
            </div>

            {/* Locked Shard */}
            <div>
              <div className="font-mono-tabular text-[11px] text-neutral-400">
                Shard Mode (Locked)
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {(['PvPvE', 'PvE'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setShardInput(mode)}
                    className={`cursor-pointer border py-2 font-mono-tabular text-xs font-semibold transition-colors whitespace-nowrap ${
                      shardInput === mode
                        ? mode === 'PvPvE'
                          ? 'border-red-400 bg-red-500/20 text-red-100'
                          : 'border-emerald-400 bg-emerald-500/20 text-emerald-100'
                        : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">
                {SHARD_RULES[shardInput].pmcRelationsLabel}
              </div>
            </div>

            {/* Locked PMC Faction */}
            <div>
              <div className="font-mono-tabular text-[11px] text-neutral-400">
                PMC Faction (Locked)
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {(['pmc_alpha', 'pmc_bravo'] as const).map((fid) => (
                  <button
                    key={fid}
                    type="button"
                    onClick={() => setFactionInput(fid)}
                    className={`cursor-pointer border py-2 font-mono-tabular text-xs font-semibold transition-colors whitespace-nowrap ${
                      factionInput === fid
                        ? fid === 'pmc_alpha'
                          ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                          : 'border-amber-400 bg-amber-500/20 text-amber-100'
                        : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                    }`}
                  >
                    {PMC_FACTIONS[fid].name}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">
                Starter Wall:{' '}
                {PMC_FACTIONS[factionInput].starterWeaponIds
                  .map((id) => resolveWeaponProfile(id).name)
                  .join(', ')}
              </div>
            </div>

            {/* Locked Body Type */}
            <div>
              <div className="font-mono-tabular text-[11px] text-neutral-400">
                Operator Body Rig (Locked)
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {(['male', 'female'] as const).map((bt) => (
                  <button
                    key={bt}
                    type="button"
                    onClick={() => setBodyInput(bt)}
                    className={`cursor-pointer border py-2 font-mono-tabular text-xs font-semibold capitalize transition-colors whitespace-nowrap ${
                      bodyInput === bt
                        ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                        : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                    }`}
                  >
                    {bt}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-neutral-400">
                Shared skeleton + gender-tuned secondary physics
              </div>
            </div>
          </div>

          {/* Face Identity Selector (3 sculpted presets per gender) */}
          <div className="mt-4 border-t border-white/10 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                Operator Face &amp; Hair Preset ({bodyInput === 'female' ? 'Female' : 'Male'} Roster)
              </div>
              <span className="font-mono-tabular text-[11px] text-neutral-500">
                Sculpted skull/jaw profile, skin &amp; eye tone, and offset hair cut
              </span>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Character Face Preset">
              {getFacePresetsForOperator(bodyInput === 'female' ? 'FEMALE' : 'MALE').map((preset) => {
                const active = facePresetInput === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setFacePresetInput(preset.id)}
                    className={`flex cursor-pointer flex-col gap-1 border p-3 text-left transition-colors ${
                      active
                        ? 'border-amber-400 bg-amber-500/15 text-amber-100'
                        : 'border-white/10 bg-[#0d1118] text-neutral-300 hover:border-white/25 hover:text-neutral-100'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono-tabular text-xs font-semibold tracking-wide">
                        {preset.label}
                      </span>
                      <span className="flex items-center gap-1">
                        <span
                          className="inline-block h-3 w-3 border border-white/25"
                          style={{ backgroundColor: preset.skinSwatchHex }}
                          title="Skin Tone"
                        />
                        <span
                          className="inline-block h-3 w-3 border border-white/25"
                          style={{ backgroundColor: preset.hairSwatchHex }}
                          title="Hair Tone"
                        />
                        <span
                          className="inline-block h-3 w-3 border border-white/25"
                          style={{ backgroundColor: preset.eyeSwatchHex }}
                          title="Iris Tone"
                        />
                      </span>
                    </div>
                    <div className="font-mono-tabular text-[11px] text-amber-300/85">
                      {preset.hairStyleLabel}
                    </div>
                    <div className="text-[11px] leading-snug text-neutral-400">
                      {preset.summary}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {formError && (
            <div className="mt-3 font-mono-tabular text-xs text-red-400">{formError}</div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => {
                setCreatingSlot(null);
                setFormError(null);
              }}
              className="cursor-pointer border border-white/14 bg-[#161b23] px-4 py-2 text-xs font-medium text-neutral-300 hover:text-white whitespace-nowrap"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="cursor-pointer bg-amber-500 px-5 py-2 font-display text-xs font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap"
            >
              Lock Attributes &amp; Enter Hideout
            </button>
          </div>
        </form>
      )}

      {/* Active Character Detail Workspace */}
      {activeCharacter && activeShard ? (
        <div className="flex flex-col gap-4 border border-white/10 bg-[#0f131a] p-4">
          {/* Sub-Tab Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSubTab('shards_reputation')}
                className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  subTab === 'shards_reputation'
                    ? 'border-sky-400 bg-sky-500/18 text-sky-100'
                    : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                }`}
              >
                <Shield className="h-3.5 w-3.5" />
                <span>Shards &amp; Reputation</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('traders_unlocks')}
                className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  subTab === 'traders_unlocks'
                    ? 'border-emerald-400 bg-emerald-500/18 text-emerald-100'
                    : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                }`}
              >
                <Award className="h-3.5 w-3.5" />
                <span>Traders &amp; Unlocks</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('arsenal_stash')}
                className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  subTab === 'arsenal_stash'
                    ? 'border-amber-400 bg-amber-500/18 text-amber-100'
                    : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                <span>Arsenal Wall &amp; Stash</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('hospital_permadeath')}
                className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  subTab === 'hospital_permadeath'
                    ? 'border-red-400 bg-red-500/18 text-red-100'
                    : 'border-white/10 bg-[#151a22] text-neutral-400 hover:text-neutral-100'
                }`}
              >
                <HeartPulse className="h-3.5 w-3.5" />
                <span>Field Hospital &amp; Permadeath</span>
              </button>
            </div>

            <div className="font-mono-tabular text-xs text-neutral-400">
              <span>{activeCharacter.callsign}</span>
              <span className="mx-2 text-neutral-600">·</span>
              <span className="text-emerald-300">{formatUsd(activeCharacter.cash)}</span>
              <span className="mx-2 text-neutral-600">·</span>
              <span>Deaths {activeCharacter.deathsCount}</span>
              <span className="mx-2 text-neutral-600">·</span>
              <span>Shard Rev {activeShard.revision}</span>
            </div>
          </div>

          {/* SUB-TAB 1: DUAL SHARDS & SUB-FACTION STANDING */}
          {subTab === 'shards_reputation' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              {/* Dual-Shard Rule Matrix & Supply Pools */}
              <div className="space-y-3 lg:col-span-6">
                <div className="text-xs font-semibold text-neutral-200">
                  Dual-Shard Isolation ({activeCharacter.shardMode} Active)
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(['PvPvE', 'PvE'] as const).map((mode) => {
                    const rules = SHARD_RULES[mode];
                    const sw = shards.shards[mode];
                    const selected = activeCharacter.shardMode === mode;
                    return (
                      <div
                        key={mode}
                        className={`border p-3 text-xs ${
                          selected
                            ? 'border-sky-400/70 bg-[#131b24]'
                            : 'border-white/10 bg-[#11151c] opacity-75'
                        }`}
                      >
                        <div className="flex items-center justify-between font-mono-tabular">
                          <span className="font-bold text-neutral-100">{mode} Shard</span>
                          <span className="text-[11px] text-neutral-400">
                            {selected ? 'ASSIGNED' : 'ISOLATED'}
                          </span>
                        </div>
                        <div className="mt-2 space-y-1 text-[11px] text-neutral-300">
                          <div>{rules.pmcRelationsLabel}</div>
                          <div className="text-neutral-400">FF: {rules.friendlyFireLabel}</div>
                          <div className="text-neutral-400">
                            Corpses: {rules.corpseLootingLabel}
                          </div>
                        </div>
                        <div className="mt-2.5 flex items-center justify-between border-t border-white/8 pt-2 font-mono-tabular text-[11px] text-neutral-400">
                          <span>
                            Sectors A:{sw.territoryCounts.pmc_alpha} · B:
                            {sw.territoryCounts.pmc_bravo} · N:{sw.territoryCounts.neutral}
                          </span>
                          <span>{sw.corpses.length} Corpses</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Active Shard PMC Supply Pools */}
                <div className="border border-white/10 bg-[#11151c] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-neutral-200">
                      {activeCharacter.shardMode} PMC Logistics Supply Pools
                    </span>
                    <span className="font-mono-tabular text-[11px] text-neutral-400">
                      Alpha vs Bravo
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-3 font-mono-tabular text-[11px]">
                    {(['pmc_alpha', 'pmc_bravo'] as const).map((fid) => {
                      const pool = activeShard.pmcSupplyPools[fid];
                      return (
                        <div key={fid} className="space-y-1">
                          <div
                            className={`font-semibold ${
                              fid === 'pmc_alpha' ? 'text-sky-300' : 'text-amber-300'
                            }`}
                          >
                            {PMC_FACTIONS[fid].name}
                          </div>
                          <div className="text-neutral-300">
                            Ammo {pool.ammo}% · Med {pool.medical}%
                          </div>
                          <div className="text-neutral-400">
                            Fuel/Parts {pool.fuelParts}% · Intel {pool.intel}%
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 3 Independent Regional Sub-Faction Standing Meters */}
              <div className="space-y-2.5 lg:col-span-6">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-neutral-200">
                    Regional Sub-Faction Standing (-100 to +100)
                  </span>
                  <span className="font-mono-tabular text-[11px] text-neutral-400">
                    +50 Trusted unlocks regional Field Hospital
                  </span>
                </div>

                {SUB_FACTION_LIST.map((sf) => {
                  const val = activeCharacter.subFactionStanding[sf.id] ?? 0;
                  const tier = getStandingTier(val);
                  const pct = Math.round(((val + 100) / 200) * 100);
                  return (
                    <div
                      key={sf.id}
                      className="border border-white/10 bg-[#11151c] p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-semibold text-neutral-100">{sf.name}</span>
                          <span className="mx-2 text-neutral-600">·</span>
                          <span className="text-[11px] text-neutral-400">{sf.biomeLabel}</span>
                        </div>
                        <div className="font-mono-tabular text-xs font-semibold">
                          <span
                            className={
                              tier === 'Trusted'
                                ? 'text-emerald-300'
                                : tier === 'Hostile'
                                  ? 'text-red-400'
                                  : 'text-neutral-300'
                            }
                          >
                            {tier} ({val >= 0 ? `+${val}` : val})
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 h-1.5 w-full bg-[#1b222c]">
                        <div
                          className={`h-full transition-all ${
                            tier === 'Trusted'
                              ? 'bg-emerald-400'
                              : tier === 'Hostile'
                                ? 'bg-red-500'
                                : 'bg-amber-400'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-neutral-400">
                          {tier === 'Trusted'
                            ? `Unlocked: ${sf.hospitalName}`
                            : `Medbay locked until +50 (${sf.hospitalName})`}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleAdjustStanding(sf.id, -25)}
                            className="cursor-pointer border border-white/10 bg-[#161b23] px-2 py-0.5 font-mono-tabular text-[11px] text-red-300 hover:border-red-400/50 whitespace-nowrap"
                          >
                            -25 Hostile
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAdjustStanding(sf.id, 25)}
                            className="cursor-pointer border border-white/10 bg-[#161b23] px-2 py-0.5 font-mono-tabular text-[11px] text-emerald-300 hover:border-emerald-400/50 whitespace-nowrap"
                          >
                            +25 Contract
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* SUB-TAB 1B: PER-CHARACTER TRADERS, CONTRACTS & UNLOCK ENTITLEMENTS */}
          {subTab === 'traders_unlocks' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border border-white/10 bg-[#10151d] px-3.5 py-2.5 text-xs text-neutral-300">
                <span>
                  <strong className="text-neutral-100">Character-Scoped Unlocks:</strong> All trader
                  levels, contracts, weapon/optic/armor-plate purchase clearances belong strictly to{' '}
                  <span className="font-mono-tabular text-amber-300">{activeCharacter.callsign}</span>{' '}
                  (never account-wide) and wipe completely on permadeath.
                </span>
                <span className="font-mono-tabular text-[11px] text-neutral-400">
                  Unlocked: {activeCharacter.unlocks.unlockedWeaponIds.length} Firearms ·{' '}
                  {activeCharacter.unlocks.unlockedAttachmentIds.length} Optics/Mods ·{' '}
                  {activeCharacter.unlocks.unlockedArmorPlateIds.length} Armor Plates
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                {/* Traders & Field Contracts */}
                <div className="space-y-3 lg:col-span-6">
                  <div className="text-xs font-semibold text-neutral-200">
                    Per-Character Trader Levels
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {TRADER_LIST.map((tr) => {
                      const lv = activeCharacter.unlocks.traderLevels[tr.id] ?? 1;
                      const maxed = lv >= tr.maxLevel;
                      return (
                        <div
                          key={tr.id}
                          className="flex flex-col justify-between border border-white/10 bg-[#11151c] p-3 text-xs"
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-neutral-100">{tr.name}</span>
                              <span className="font-mono-tabular text-emerald-300">
                                Lv {lv}/{tr.maxLevel}
                              </span>
                            </div>
                            <div className="mt-0.5 text-[11px] text-neutral-400">{tr.role}</div>
                          </div>
                          <button
                            type="button"
                            disabled={maxed}
                            onClick={() => handleLevelUpTrader(tr.id)}
                            className={`mt-2.5 border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
                              maxed
                                ? 'cursor-default border-white/8 bg-[#10141b] text-neutral-500'
                                : 'cursor-pointer border-emerald-500/50 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-500 hover:text-neutral-950'
                            }`}
                          >
                            {maxed ? 'Max Level Reached' : `Advance to Lv ${lv + 1}`}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="text-xs font-semibold text-neutral-200">
                    Perimeter Field Contracts (Grants Firearm, Optic &amp; Plate Unlocks)
                  </div>
                  <div className="space-y-2">
                    {OPENWORLD_CONTRACT_CATALOG.map((ct) => {
                      const done = activeCharacter.unlocks.completedContractIds.includes(ct.id);
                      return (
                        <div
                          key={ct.id}
                          className="flex items-center justify-between gap-3 border border-white/10 bg-[#11151c] p-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="font-semibold text-neutral-100">{ct.title}</div>
                            <div className="mt-0.5 text-[11px] text-neutral-400">{ct.summary}</div>
                            <div className="mt-1 font-mono-tabular text-[11px] text-neutral-300">
                              Reward {formatUsd(ct.cashRewardUsd)} · +{ct.unlocksWeaponIds.length}{' '}
                              Weapons · +{ct.unlocksAttachmentIds.length} Optics/Mods · +
                              {ct.unlocksArmorPlateIds.length} Plates
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={done}
                            onClick={() => handleCompleteContract(ct.id)}
                            className={`border px-3 py-1.5 font-mono-tabular text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                              done
                                ? 'cursor-default border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
                                : 'cursor-pointer border-amber-400/65 bg-amber-500/15 text-amber-200 hover:bg-amber-500 hover:text-neutral-950'
                            }`}
                          >
                            {done ? 'Completed' : 'Complete Contract'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Per-Character Optics/Attachments & Armor Plates */}
                <div className="space-y-3 lg:col-span-6">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-neutral-200">
                      Optics &amp; Attachments ({activeCharacter.callsign} Entitlements)
                    </span>
                    <span className="font-mono-tabular text-emerald-300">
                      Cash {formatUsd(activeCharacter.cash)}
                    </span>
                  </div>
                  <div className="grid max-h-[210px] grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
                    {QUARTERMASTER_ATTACHMENT_OFFERS.map((att) => {
                      const unlocked = activeCharacter.unlocks.unlockedAttachmentIds.includes(
                        att.attachmentId,
                      );
                      const affordable = activeCharacter.cash >= att.priceUsd;
                      return (
                        <div
                          key={att.attachmentId}
                          className="flex items-center justify-between gap-2 border border-white/10 bg-[#141922] px-2.5 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-neutral-100">{att.label}</div>
                            <div className="font-mono-tabular text-[11px] text-neutral-400">
                              {att.slotLabel} · {formatUsd(att.priceUsd)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={!unlocked || !affordable}
                            onClick={() =>
                              handlePurchaseAttachment(att.attachmentId, att.label, att.priceUsd)
                            }
                            className={`border px-2.5 py-1 font-mono-tabular text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                              !unlocked
                                ? 'cursor-not-allowed border-white/8 bg-[#10141b] text-neutral-500'
                                : !affordable
                                  ? 'cursor-not-allowed border-white/8 bg-[#10141b] text-neutral-500'
                                  : 'cursor-pointer border-amber-400/65 bg-amber-500/15 text-amber-200 hover:bg-amber-500 hover:text-neutral-950'
                            }`}
                          >
                            {unlocked ? 'Buy' : `Lv ${att.requiredTraderLevel} Lock`}
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div className="text-xs font-semibold text-neutral-200">
                    Ballistic Armor Plates (Equipped:{' '}
                    <span className="font-mono-tabular text-amber-200">
                      {activeCharacter.equippedKit.armorName ?? 'None'}
                    </span>
                    )
                  </div>
                  <div className="space-y-1.5">
                    {ARMOR_PLATE_CATALOG.map((plate) => {
                      const unlocked = activeCharacter.unlocks.unlockedArmorPlateIds.includes(
                        plate.id,
                      );
                      const equipped = activeCharacter.equippedKit.armorPlateId === plate.id;
                      const affordable = activeCharacter.cash >= plate.priceUsd;
                      return (
                        <div
                          key={plate.id}
                          className="flex items-center justify-between gap-2 border border-white/10 bg-[#141922] px-3 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-neutral-100">
                              {plate.name}
                            </div>
                            <div className="font-mono-tabular text-[11px] text-neutral-400">
                              {plate.ratingLabel} · {plate.weightKg}kg · Dur {plate.durability} ·{' '}
                              {formatUsd(plate.priceUsd)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={!unlocked || equipped || !affordable}
                            onClick={() => handlePurchaseArmorPlate(plate.id, plate.name)}
                            className={`border px-2.5 py-1 font-mono-tabular text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                              equipped
                                ? 'cursor-default border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                : !unlocked
                                  ? 'cursor-not-allowed border-white/8 bg-[#10141b] text-neutral-500'
                                  : !affordable
                                    ? 'cursor-not-allowed border-white/8 bg-[#10141b] text-neutral-500'
                                    : 'cursor-pointer border-amber-400/65 bg-amber-500/15 text-amber-200 hover:bg-amber-500 hover:text-neutral-950'
                            }`}
                          >
                            {equipped
                              ? 'Equipped'
                              : unlocked
                                ? 'Buy & Equip'
                                : `Lv ${plate.requiredTraderLevel} Lock`}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SUB-TAB 2: ISOLATED ARSENAL WALL, QUARTERMASTER & STASH/SECURE CONTAINER */}
          {subTab === 'arsenal_stash' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              {/* Isolated Character Arsenal Wall + Quartermaster Purchases */}
              <div className="space-y-3 lg:col-span-7">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-neutral-200">
                    {activeCharacter.callsign}&apos;s 3D Hideout Arsenal Wall (
                    {activeCharacter.arsenal.ownedWeaponIds.length} Owned)
                  </span>
                  <span className="font-mono-tabular text-[11px] text-neutral-400">
                    Only owned firearms mount on wall brackets
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5 border border-white/10 bg-[#11151c] p-3">
                  {activeCharacter.arsenal.ownedWeaponIds.length === 0 ? (
                    <span className="font-mono-tabular text-xs text-neutral-500">
                      Arsenal Wall empty — purchase a firearm below.
                    </span>
                  ) : (
                    activeCharacter.arsenal.ownedWeaponIds.map((wid) => {
                      const prof = resolveWeaponProfile(wid);
                      const isHeld = activeCharacter.arsenal.equippedWeaponId === wid;
                      return (
                        <button
                          key={wid}
                          type="button"
                          onClick={() => {
                            characterRoster.setArsenalEquippedWeapon(activeCharacter.slotId, wid);
                            setActionNotice(
                              `Equipped ${prof.name} for ${activeCharacter.callsign}.`,
                            );
                          }}
                          className={`cursor-pointer border px-2.5 py-1.5 font-mono-tabular text-xs transition-colors whitespace-nowrap ${
                            isHeld
                              ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                              : 'border-white/12 bg-[#161c25] text-neutral-300 hover:border-white/30'
                          }`}
                        >
                          {prof.name} {isHeld ? '· HELD' : '· ON WALL'}
                        </button>
                      );
                    })
                  )}
                </div>

                {/* Quartermaster Buy List (Coupled to Live PMC Supply Pool & 30m/60m/2h+ Restock Timer) */}
                <div className="border border-white/10 bg-[#11151c] p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-neutral-200">
                      Quartermaster Firearms (Supply-Coupled · Mounts to 3D Wall)
                    </span>
                    <div className="flex items-center gap-3 font-mono-tabular text-[11px]">
                      {hideoutSupply && (
                        <span
                          className={
                            hideoutSupply.ammoStatus.tier === 'high'
                              ? 'text-emerald-300'
                              : hideoutSupply.ammoStatus.tier === 'strained'
                                ? 'text-amber-300'
                                : 'text-red-400'
                          }
                        >
                          <Clock className="mr-1 inline h-3 w-3" />
                          {hideoutSupply.ammoStatus.tierLabel} ({hideoutSupply.ammoStatus.pct}%) · Restock{' '}
                          {formatRestockTimer(hideoutSupply.restock.remainingSec)}
                        </span>
                      )}
                      <span className="text-emerald-300">
                        Cash {formatUsd(activeCharacter.cash)}
                      </span>
                    </div>
                  </div>
                  {hideoutSupply && (
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border border-white/8 bg-[#0c1016] px-2.5 py-1.5 font-mono-tabular text-[11px] text-neutral-300">
                      <span>
                        Supply Pricing {Math.round(hideoutSupply.ammoStatus.priceMultiplier * 100)}% ·
                        {hideoutSupply.ammoStatus.tier === 'starved'
                          ? ' STARVED (<30%): High-tier Lv2+ stock gated until supply recovers'
                          : ' Synced with In-World FOB Quartermaster'}
                      </span>
                      <button
                        type="button"
                        onClick={handlePurchasePdaBattery}
                        className="cursor-pointer border border-cyan-400/55 bg-cyan-950/50 px-2 py-0.5 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-900/60"
                      >
                        Buy CR123A PDA Cell ({formatUsd(180 * hideoutSupply.fuelStatus.priceMultiplier)})
                      </button>
                    </div>
                  )}
                  <div className="grid max-h-[240px] grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
                    {QUARTERMASTER_FIREARM_OFFERS.map((offer) => {
                      const prof = resolveWeaponProfile(offer.weaponId);
                      const owned = activeCharacter.arsenal.ownedWeaponIds.includes(offer.weaponId);
                      const unlockedForChar = activeCharacter.unlocks.unlockedWeaponIds.includes(
                        offer.weaponId,
                      );
                      const reqStanding =
                        offer.subFactionRequired && offer.minStanding !== undefined
                          ? (activeCharacter.subFactionStanding[offer.subFactionRequired] ?? 0) <
                            offer.minStanding
                          : false;
                      const starvedOut =
                        hideoutSupply?.ammoStatus.tier === 'starved' && offer.requiredTraderLevel >= 2;
                      const scaledPrice = Math.round(
                        offer.priceUsd * (hideoutSupply?.ammoStatus.priceMultiplier ?? 1),
                      );
                      const affordable = activeCharacter.cash >= scaledPrice;
                      const disabled =
                        owned || !unlockedForChar || reqStanding || starvedOut || !affordable;
                      return (
                        <div
                          key={offer.weaponId}
                          className="flex items-center justify-between gap-2 border border-white/8 bg-[#141922] px-2.5 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium text-neutral-100">{prof.name}</div>
                            <div className="font-mono-tabular text-[11px] text-neutral-400">
                              {formatUsd(scaledPrice)} · {TRADER_MAP[offer.traderId].name} Lv{' '}
                              {offer.requiredTraderLevel}
                              {offer.subFactionRequired && offer.minStanding !== undefined
                                ? ` · ${SUB_FACTION_MAP[offer.subFactionRequired].shortName} +${offer.minStanding}`
                                : ''}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => handlePurchaseWeapon(offer.weaponId, scaledPrice)}
                            className={`border px-2.5 py-1 font-mono-tabular text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                              owned
                                ? 'cursor-default border-emerald-500/35 bg-emerald-500/12 text-emerald-300'
                                : disabled
                                  ? 'cursor-not-allowed border-white/8 bg-[#11151b] text-neutral-600'
                                  : 'cursor-pointer border-amber-400/65 bg-amber-500/15 text-amber-200 hover:bg-amber-500 hover:text-neutral-950'
                            }`}
                          >
                            {owned
                              ? 'Owned'
                              : starvedOut
                                ? 'Starved'
                                : !unlockedForChar
                                  ? 'Trader Lock'
                                  : reqStanding
                                    ? 'Rep Lock'
                                    : 'Buy'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Isolated Stash vs Secure Container (Survives Full-Drop Death) */}
              <div className="space-y-3 lg:col-span-5">
                <div className="border border-emerald-500/35 bg-[#101816] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-emerald-200">
                      Secure Container ({activeCharacter.secureContainerTier}) · Kept on Death
                    </span>
                    <span className="font-mono-tabular text-[11px] text-emerald-300">
                      {secureSlotsUsed}/{secureSlotsCap} slots
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {activeCharacter.secureContainerItems.length === 0 ? (
                      <div className="font-mono-tabular text-[11px] text-neutral-500">
                        Empty — transfer keys or high-value intel here to protect from full-drop
                        death.
                      </div>
                    ) : (
                      activeCharacter.secureContainerItems.map((it) => (
                        <div
                          key={it.instanceId}
                          className="flex items-center justify-between gap-2 border border-white/10 bg-[#121c1a] px-2.5 py-1.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-neutral-100">{it.name}</div>
                            <div className="font-mono-tabular text-[11px] text-neutral-400">
                              x{it.quantity} · {formatUsd(it.valueUsd)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              characterRoster.moveSecureItemToStash(
                                activeCharacter.slotId,
                                it.instanceId,
                              )
                            }
                            className="flex cursor-pointer items-center gap-1 border border-white/12 bg-[#162220] px-2 py-1 text-[11px] text-neutral-300 hover:text-white whitespace-nowrap shrink-0"
                          >
                            <ArrowLeftRight className="h-3 w-3" />
                            <span>To Stash</span>
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="border border-white/10 bg-[#11151c] p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-neutral-200">
                      Hideout Personal Stash ({activeCharacter.stashItems.length} Stacks)
                    </span>
                    <span className="font-mono-tabular text-[11px] text-neutral-400">
                      Wiped only on Permadeath
                    </span>
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {activeCharacter.stashItems.length === 0 ? (
                      <div className="font-mono-tabular text-[11px] text-neutral-500">
                        Stash empty.
                      </div>
                    ) : (
                      activeCharacter.stashItems.map((it) => (
                        <div
                          key={it.instanceId}
                          className="flex items-center justify-between gap-2 border border-white/8 bg-[#151a23] px-2.5 py-1.5 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-neutral-100">{it.name}</div>
                            <div className="font-mono-tabular text-[11px] text-neutral-400">
                              x{it.quantity} · {formatUsd(it.valueUsd)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const res = characterRoster.moveStashItemToSecureContainer(
                                activeCharacter.slotId,
                                it.instanceId,
                              );
                              if (!res.ok && res.error) setActionNotice(res.error);
                            }}
                            className="flex cursor-pointer items-center gap-1 border border-emerald-500/35 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-500/20 whitespace-nowrap shrink-0"
                          >
                            <ArrowLeftRight className="h-3 w-3" />
                            <span>Secure</span>
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SUB-TAB 3: FIELD HOSPITAL, SCALED FEES, FULL-DROP CORPSES & PERMADEATH */}
          {subTab === 'hospital_permadeath' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">
                <div className="border border-white/10 bg-[#11151c] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-neutral-200">
                        Field Hospital Medevac Coverage
                      </div>
                      <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                        Progression Tier {activeCharacter.missions.progressionTier} ·{' '}
                        {activeCharacter.missions.completedContracts} Contracts Completed
                      </div>
                    </div>
                    <div className="text-right font-mono-tabular">
                      <div className="text-sm font-bold text-amber-300">
                        Fee {formatUsd(computeFieldHospitalFee(activeCharacter))}
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        Cash {formatUsd(activeCharacter.cash)}
                      </div>
                    </div>
                  </div>

                  {/* Available Hospitals */}
                  <div className="mt-3 space-y-1.5">
                    <div className="font-mono-tabular text-[11px] text-neutral-400">
                      Respawn Field Hospital (Home FOB + Trusted Sub-Faction Medbays)
                    </div>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {hospitals.map((h) => {
                        const selected = effectiveHospitalId === h.id;
                        return (
                          <button
                            key={h.id}
                            type="button"
                            disabled={!h.unlocked}
                            onClick={() => setSelectedHospitalId(h.id)}
                            className={`border px-3 py-2 text-left text-xs transition-colors ${
                              !h.unlocked
                                ? 'cursor-not-allowed border-white/6 bg-[#0d1016] text-neutral-600'
                                : selected
                                  ? 'cursor-pointer border-emerald-400 bg-emerald-500/15 text-emerald-100'
                                  : 'cursor-pointer border-white/12 bg-[#151a23] text-neutral-300 hover:border-white/30'
                            }`}
                          >
                            <div className="font-semibold">{h.name}</div>
                            <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                              {h.unlocked
                                ? `${h.ownerLabel} · Available`
                                : `Locked · Need +${h.requiredStanding} ${h.ownerLabel}`}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Economy & Tier Test Controls */}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => characterRoster.adjustCash(activeCharacter.slotId, 5000)}
                        className="cursor-pointer border border-white/12 bg-[#161c25] px-2.5 py-1.5 font-mono-tabular text-[11px] text-emerald-300 hover:border-emerald-400/50 whitespace-nowrap"
                      >
                        +$5,000 Payout
                      </button>
                      <button
                        type="button"
                        onClick={() => characterRoster.setCash(activeCharacter.slotId, 1200)}
                        className="cursor-pointer border border-white/12 bg-[#161c25] px-2.5 py-1.5 font-mono-tabular text-[11px] text-red-300 hover:border-red-400/50 whitespace-nowrap"
                      >
                        Set Low Cash ($1,200)
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          characterRoster.advanceProgressionTier(activeCharacter.slotId, 1, 3)
                        }
                        className="cursor-pointer border border-white/12 bg-[#161c25] px-2.5 py-1.5 font-mono-tabular text-[11px] text-sky-300 hover:border-sky-400/50 whitespace-nowrap"
                      >
                        Advance Tier (+Fee)
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={handleSimulateFieldDeath}
                      className="flex cursor-pointer items-center gap-1.5 bg-red-600 px-4 py-2 font-mono-tabular text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-red-500 whitespace-nowrap shrink-0"
                    >
                      <Skull className="h-3.5 w-3.5" />
                      <span>
                        {bankruptcy?.isBankruptcyRisk
                          ? 'Simulate Death (Permadeath Wipe)'
                          : 'Simulate Field Death'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Active Shard Persistent Full-Drop Corpses Ledger */}
              <div className="border border-white/10 bg-[#11151c] p-4 lg:col-span-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-neutral-200">
                    {activeCharacter.shardMode} Persistent Corpses ({activeShard.corpses.length})
                  </span>
                  <span className="font-mono-tabular text-[11px] text-neutral-400">
                    {SHARD_RULES[activeCharacter.shardMode].corpseLootingPlayers
                      ? 'PvP Looting Enabled'
                      : 'PvE Owner-Only'}
                  </span>
                </div>

                <div className="mt-2.5 max-h-[240px] space-y-2 overflow-y-auto pr-1">
                  {activeShard.corpses.length === 0 ? (
                    <div className="font-mono-tabular text-xs text-neutral-500">
                      No dropped corpses recorded in the {activeCharacter.shardMode} shard yet.
                    </div>
                  ) : (
                    activeShard.corpses.slice(0, 8).map((corpse) => (
                      <div
                        key={corpse.corpseId}
                        className="border border-white/8 bg-[#151a23] p-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between font-mono-tabular">
                          <span className="font-semibold text-neutral-100">
                            {corpse.ownerCallsign}
                          </span>
                          <span className="text-[11px] text-neutral-400">{corpse.sectorLabel}</span>
                        </div>
                        <div className="mt-1 font-mono-tabular text-[11px] text-neutral-400">
                          Weapons:{' '}
                          {corpse.droppedWeaponIds.length > 0
                            ? corpse.droppedWeaponIds
                                .map((id) => resolveWeaponProfile(id).name)
                                .join(', ')
                            : 'None'}
                        </div>
                        <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-500">
                          {corpse.droppedItems.length} backpack item(s) ·{' '}
                          {corpse.lootableByOtherPlayers
                            ? 'Lootable by any PMC'
                            : 'Protected (PvE)'}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="border border-white/10 bg-[#10141c] p-5 text-center">
          <div className="font-display text-base font-semibold text-neutral-200">
            No Perimeter Operations Character Active
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            Create a character in any of the 3 slots above to isolate your 3D Hideout Arsenal Wall,
            cash balance, Secure Container, M/F operator rig, and Shard state. Classic Battle &amp;
            Infection modes remain fully available.
          </p>
        </div>
      )}
    </div>
  );
};

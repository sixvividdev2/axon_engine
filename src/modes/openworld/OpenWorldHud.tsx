import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CloudFog,
  CloudRain,
  Compass,
  Eye,
  Flashlight,
  Heart,
  LogOut,
  Map as MapIcon,
  Navigation,
  Radio,
  Shield,
  Skull,
  Sun,
  Truck,
  X,
} from 'lucide-react';
import type { BodycamLensPresetId } from '../../../bodycam-sdk';
import { openGameSettings } from '../../../data/gameSettingsStore';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  useAdaptiveScaling,
  useGraphicsQuality,
} from '../../../data/graphicsQuality';
import type {
  CorpseTacticalLootSnapshot,
  ItemSourceLocator,
  MedicalItem,
  OperatorTacticalInventory,
} from './inventory/TetrisInventoryTypes';
import {
  DynamicWorldEventKind,
  OPENWORLD_CONTRACT_CATALOG,
  OpenWorldWeatherId,
  SectorControlOwner,
  SUB_FACTION_MAP,
} from './types';
import { ArmoryStashModal } from './ui/ArmoryStashModal';
import { FobTerminalModal } from './ui/FobTerminalModal';
import { TacticalInventoryModal } from './ui/TacticalInventoryModal';
import {
  OpenWorldNavMode,
  OpenWorldNvgMode,
  OpenWorldRenderPipeline,
  OpenWorldSessionSnapshot,
} from './world/OpenWorldSessionEngine';

interface OpenWorldHudProps {
  snapshot: OpenWorldSessionSnapshot;
  onRequestLock: () => void;
  onSetNavMode: (mode: OpenWorldNavMode) => void;
  onSetRenderPipeline: (mode: OpenWorldRenderPipeline) => void;
  onSetLensPreset: (preset: BodycamLensPresetId) => void;
  onSetNvgMode: (mode: OpenWorldNvgMode) => void;
  onToggleFlashlight: () => void;
  onTogglePda: () => void;
  onOpenInventory: () => void;
  onCloseModal: () => void;
  onMutateInventory: (
    nextInv: OperatorTacticalInventory,
    nextExternal?: CorpseTacticalLootSnapshot | null,
    statusNote?: string,
  ) => void;
  onTriggerDragReload: (
    weaponSlotKey: 'primary' | 'secondary',
    sourceLocator: ItemSourceLocator,
  ) => void;
  onUseMedicalItem: (locator: ItemSourceLocator, med: MedicalItem) => void;
  onUsePdaBattery: (locator: ItemSourceLocator) => void;
  onFastTravelToSector: (sectorId: string) => void;
  onFundFobUpgrade: () => void;
  onBuyFobOffer: (offerId: string) => void;
  onAcceptContract: (slotIndex: number) => void;
  onCompleteContract: (slotIndex: number) => void;
  onDepositArmoryItem: (locator: ItemSourceLocator) => void;
  onWithdrawArmoryItem: (
    stashInstanceId: string,
    target?: 'auto' | 'backpack' | 'secure' | 'belt',
  ) => void;
  onEquipArmoryWeapon: (slotKey: 'primary' | 'secondary', weaponId: string) => void;
  onEquipArmoryArmorPlate: (plateId: string) => void;
  onResupplyArmoryAmmo: () => void;
  onSabotageConvoy: () => void;
  onTriggerWorldEvent: (kind: DynamicWorldEventKind) => void;
  onExecuteInteract: () => void;
  onTeleportLandmark: (landmarkId: string) => void;
  onSetTimeOfDay: (hours: number) => void;
  onSetTimeScale: (scale: number) => void;
  onSetWeather: (weather: OpenWorldWeatherId) => void;
  onSetAutoWeather: (enabled: boolean) => void;
  onExfilToHideout: () => void;
  onTriggerFieldDeath: () => void;
}

type DockTabId = 'sectors' | 'logistics' | 'atmosphere' | 'ops';

const WEATHER_OPTIONS: ReadonlyArray<{ id: OpenWorldWeatherId; label: string }> = [
  { id: 'clear', label: 'Clear' },
  { id: 'coastal_fog', label: 'Coastal Fog' },
  { id: 'mountain_rain', label: 'Mountain Rain' },
];

const TIME_PRESETS: ReadonlyArray<{ label: string; hours: number }> = [
  { label: '06:00 Dawn', hours: 6.0 },
  { label: '12:00 Noon', hours: 12.0 },
  { label: '18:30 Dusk', hours: 18.5 },
  { label: '23:30 Night', hours: 23.5 },
];

const LENS_PRESET_OPTIONS: ReadonlyArray<{ id: BodycamLensPresetId; label: string }> = [
  { id: 'axon_body_4', label: 'Axon Body 4' },
  { id: 'gopro_chest', label: 'GoPro Chest' },
  { id: 'clean_raw', label: 'Clean Raw' },
];

const NVG_OPTIONS: ReadonlyArray<{ id: OpenWorldNvgMode; label: string }> = [
  { id: 'none', label: 'NVG Off' },
  { id: 'pvs7', label: 'PVS-7 Green' },
  { id: 'arnvg', label: 'ARNVG White' },
];

function formatUsd(amount: number): string {
  return `$${Math.max(0, Math.round(amount)).toLocaleString()}`;
}

function ownerTagColor(owner: SectorControlOwner): string {
  if (owner === 'pmc_alpha') return 'text-sky-300';
  if (owner === 'pmc_bravo') return 'text-amber-300';
  if (owner === 'subfaction') return 'text-teal-300';
  if (owner === 'contested') return 'text-red-400';
  return 'text-neutral-400';
}

function ownerShort(owner: SectorControlOwner): string {
  if (owner === 'pmc_alpha') return 'ALPHA';
  if (owner === 'pmc_bravo') return 'BRAVO';
  if (owner === 'subfaction') return 'LOCAL';
  if (owner === 'contested') return 'CONTESTED';
  return 'NEUTRAL';
}

export const OpenWorldHud: React.FC<OpenWorldHudProps> = ({
  snapshot,
  onRequestLock,
  onSetNavMode,
  onSetRenderPipeline,
  onSetLensPreset,
  onSetNvgMode,
  onToggleFlashlight,
  onTogglePda,
  onCloseModal,
  onMutateInventory,
  onTriggerDragReload,
  onUseMedicalItem,
  onUsePdaBattery,
  onFastTravelToSector,
  onFundFobUpgrade,
  onBuyFobOffer,
  onAcceptContract,
  onCompleteContract,
  onDepositArmoryItem,
  onWithdrawArmoryItem,
  onEquipArmoryWeapon,
  onEquipArmoryArmorPlate,
  onResupplyArmoryAmmo,
  onSabotageConvoy,
  onTriggerWorldEvent,
  onExecuteInteract,
  onTeleportLandmark,
  onSetTimeOfDay,
  onSetTimeScale,
  onSetWeather,
  onSetAutoWeather,
  onExfilToHideout,
  onTriggerFieldDeath,
}) => {
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTabId>('sectors');
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const [adaptiveScaling, setAdaptiveScaling] = useAdaptiveScaling();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyH') {
        setDockOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const char = snapshot.character;
  const atmo = snapshot.atmosphere;
  const combat = snapshot.combat;
  const completedContracts = new Set(char?.unlocks.completedContractIds ?? []);

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4 select-none">
      {/* Subtle Combat Damage Border Flash */}
      {combat.damageFlashAlpha > 0.02 && (
        <div
          className="pointer-events-none fixed inset-0 border-8 border-red-600/80"
          style={{ opacity: Math.min(0.85, combat.damageFlashAlpha) }}
        />
      )}

      {/* Unobstructed Top Row — Only shows Resume/Exfil actions when pointer is unlocked */}
      <div className="flex items-start justify-end">
        {!snapshot.pointerLocked && snapshot.activeModal === null && (
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onRequestLock}
              className="cursor-pointer border border-white/15 bg-[#12161e]/95 px-3.5 py-2 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-400/70 hover:text-amber-200 whitespace-nowrap shrink-0"
            >
              Click to Engage
            </button>
            <button
              type="button"
              onClick={onExfilToHideout}
              className="flex cursor-pointer items-center gap-1.5 border border-amber-500/60 bg-[#1a160f]/95 px-3.5 py-2 text-xs font-semibold text-amber-200 transition-colors hover:border-amber-400 hover:bg-[#241e13] whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Exfil to Hideout</span>
            </button>
          </div>
        )}
      </div>

      {/* Keep center viewport 100% open for diegetic aiming, optics, and 3D GPS PDA */}
      <div className="flex-1" />

      {/* Bottom Row: Non-occluding Alerts/Interactables + Minimal Operator Vitals Strip + Control Dock */}
      <div className="flex flex-col items-center gap-2">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-1.5">
          {char && snapshot.bankruptcy?.isBankruptcyRisk && (
            <div
              role="alert"
              className="pointer-events-auto flex items-center gap-2.5 border border-red-500/75 bg-[#200c10] px-4 py-1.5 text-xs text-red-100"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
              <span className="font-mono-tabular font-semibold">
                BANKRUPTCY WARNING · Cash {formatUsd(snapshot.bankruptcy.currentCash)} below Medevac{' '}
                {formatUsd(snapshot.bankruptcy.nextRespawnFee)} · Death permanently wipes {char.callsign}
              </span>
            </div>
          )}

          {snapshot.toastMessage && (
            <div className="border border-amber-500/45 bg-[#111419]/95 px-4 py-1.5 font-mono-tabular text-xs text-amber-100">
              {snapshot.toastMessage}
            </div>
          )}

          {snapshot.interactable && snapshot.navMode === 'foot' && snapshot.activeModal === null && (
            <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onExecuteInteract}
                className={`flex cursor-pointer flex-col gap-1.5 border px-4 py-1.5 text-left text-xs ${
                  snapshot.interactable.canExecute
                    ? 'border-amber-400/70 bg-[#12161d]/95 text-neutral-100 hover:border-amber-300'
                    : 'border-red-500/50 bg-[#1b1114]/95 text-red-100'
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="border border-amber-400/60 bg-amber-500/20 px-1.5 py-0.5 font-mono-tabular font-semibold text-amber-200 whitespace-nowrap">
                    {snapshot.interactable.holdToRepair ? 'HOLD F' : 'F'}
                  </span>
                  <div>
                    <div className="font-semibold">{snapshot.interactable.label}</div>
                    <div className="text-[11px] text-neutral-400">{snapshot.interactable.sublabel}</div>
                  </div>
                </div>
                {snapshot.interactable.holdToRepair && (snapshot.interactable.repairProgress ?? 0) > 0 && (
                  <div className="h-1.5 w-full overflow-hidden bg-white/10">
                    <div
                      className="h-full bg-amber-400 transition-[width] duration-75"
                      style={{
                        width: `${Math.min(100, Math.round((snapshot.interactable.repairProgress ?? 0) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </button>

              {snapshot.interactable.kind === 'convoy_hijack' && snapshot.interactable.canExecute && (
                <button
                  type="button"
                  onClick={onSabotageConvoy}
                  className="flex cursor-pointer items-center gap-2 border border-red-500/70 bg-[#200f12]/95 px-3.5 py-1.5 text-xs font-semibold text-red-100 hover:border-red-400"
                >
                  <span className="border border-red-400/60 bg-red-500/20 px-1.5 py-0.5 font-mono-tabular text-red-200">
                    X
                  </span>
                  <span>Sabotage Cargo (-15 Supply / +180s Stall)</span>
                </button>
              )}
            </div>
          )}

          {snapshot.lastDeathOutcome && (
            <div
              className={`pointer-events-auto flex flex-wrap items-center justify-between gap-3 border px-4 py-2 text-xs ${
                snapshot.lastDeathOutcome.outcome === 'permadeath_wiped'
                  ? 'border-red-500/80 bg-[#210d11] text-red-100'
                  : 'border-amber-500/65 bg-[#1b160e] text-amber-100'
              }`}
            >
              <span className="font-mono-tabular">
                {snapshot.lastDeathOutcome.outcome === 'permadeath_wiped'
                  ? `PERMADEATH WIPE: ${snapshot.lastDeathOutcome.callsign} deleted (${snapshot.lastDeathOutcome.wipedSummary.unlockedWeapons} weapon unlocks, ${snapshot.lastDeathOutcome.wipedSummary.unlockedAttachments} optics, ${snapshot.lastDeathOutcome.wipedSummary.stashItemCount} stash items & ${snapshot.lastDeathOutcome.wipedSummary.ownedVehicleCount} vehicles purged).`
                  : `FIELD HOSPITAL RESPAWN: ${snapshot.lastDeathOutcome.callsign} recovered at ${snapshot.lastDeathOutcome.hospital.name} (-${formatUsd(snapshot.lastDeathOutcome.feePaid)}). Corpse logged in shard; Secure Container retained.`}
              </span>
              <button
                type="button"
                onClick={onExfilToHideout}
                className="cursor-pointer border border-white/20 bg-black/40 px-3 py-1 text-[11px] font-semibold text-white hover:border-white/50 whitespace-nowrap shrink-0"
              >
                Return to Hideout
              </button>
            </div>
          )}
        </div>
        {snapshot.navMode === 'foot' && (
          <div className="flex w-full items-end justify-start">
            {/* Minimal Bottom-Left Operator Vitals (HP, Armor Plate & Trauma only) */}
            <div className="flex items-center gap-3.5 border border-white/10 bg-[#0b0e13]/88 px-3.5 py-2 font-mono-tabular text-xs text-neutral-200">
              <div className="flex items-center gap-1.5">
                <Heart className="h-3.5 w-3.5 text-red-400" />
                <span className={combat.hp <= 30 ? 'font-semibold text-red-400' : 'text-neutral-100'}>
                  {combat.hp}
                </span>
                <span className="text-neutral-500">HP</span>
              </div>
              <span aria-hidden="true" className="text-neutral-600">·</span>
              <div className="flex items-center gap-1.5">
                <Shield className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-neutral-100">
                  {combat.armorDurability}/{combat.maxArmorDurability}
                </span>
                <span className="text-[11px] text-neutral-400">{combat.armorLabel}</span>
              </div>
              {combat.bleedingRemainingSec > 0 && (
                <>
                  <span aria-hidden="true" className="text-neutral-600">·</span>
                  <span className="font-semibold text-red-400">
                    BLEED {Math.ceil(combat.bleedingRemainingSec)}s
                  </span>
                </>
              )}
              {combat.sprintSlowRemainingSec > 0 && (
                <>
                  <span aria-hidden="true" className="text-neutral-600">·</span>
                  <span className="text-amber-300">
                    LEG TRAUMA {Math.ceil(combat.sprintSlowRemainingSec)}s
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Explicit [H] Theater Operations Drawer (hidden cleanly when collapsed) */}
        {dockOpen && (
          <div className="pointer-events-auto mx-auto flex w-full max-w-[940px] flex-col items-center">
            <div className="w-full border border-white/14 bg-[#0d1117] px-4 py-3 text-xs text-neutral-200">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-2.5">
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: 'sectors', label: '4km Sectors & Control' },
                      { id: 'logistics', label: 'Supply Pools & Contracts' },
                      { id: 'atmosphere', label: '90m Cycle & Weather' },
                      { id: 'ops', label: 'Field Ops' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setDockTab(t.id)}
                      className={`cursor-pointer px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        dockTab === t.id
                          ? 'bg-amber-500/20 text-amber-200 border border-amber-500/50'
                          : 'border border-transparent text-neutral-400 hover:text-neutral-100'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Quick Hardware Toggles */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onTogglePda}
                    disabled={snapshot.navMode !== 'foot'}
                    className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                      combat.isPdaOpen
                        ? 'border-emerald-400/70 bg-emerald-950/60 text-emerald-200'
                        : 'border-white/14 bg-[#141922] text-neutral-200 hover:border-white/30'
                    }`}
                  >
                    <MapIcon className="h-3.5 w-3.5" />
                    <span>GPS PDA</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      onSetNavMode(snapshot.navMode === 'foot' ? 'recon_flight' : 'foot')
                    }
                    className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      snapshot.navMode === 'recon_flight'
                        ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                        : 'border-white/14 bg-[#141922] text-neutral-200 hover:border-white/30'
                    }`}
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    <span>{snapshot.navMode === 'recon_flight' ? 'Recon Flight' : 'Foot Bodycam'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={onToggleFlashlight}
                    className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      snapshot.flashlightOn
                        ? 'border-amber-400/75 bg-amber-950/60 text-amber-200'
                        : 'border-white/14 bg-[#141922] text-neutral-300 hover:border-white/30'
                    }`}
                  >
                    <Flashlight className="h-3.5 w-3.5" />
                    <span>Light</span>
                  </button>
                </div>
              </div>

              {/* Tab Content */}
              <div className="pt-2.5">
                {dockTab === 'sectors' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 text-[11px] text-neutral-400 mr-1">
                      <Compass className="h-3.5 w-3.5" />
                      <span>Fast Insert:</span>
                    </span>
                    {snapshot.sectors.map((sec) => (
                      <button
                        key={sec.sectorId}
                        type="button"
                        onClick={() => onTeleportLandmark(sec.sectorId)}
                        className="flex cursor-pointer items-center gap-2 border border-white/12 bg-[#141922] px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap shrink-0"
                      >
                        <span>{sec.shortLabel}</span>
                        <span className={`font-mono-tabular text-[10px] ${ownerTagColor(sec.owner)}`}>
                          {ownerShort(sec.owner)}
                        </span>
                        {sec.hostileGarrisonCount > 0 && (
                          <span className="font-mono-tabular text-[10px] text-red-400">
                            {sec.hostileGarrisonCount}H
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {dockTab === 'logistics' && (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                      <div className="space-y-1.5 border border-white/10 bg-[#12161e] p-2.5 font-mono-tabular text-[11px]">
                        <div className="flex items-center justify-between text-neutral-300">
                          <span className="font-semibold text-sky-300">PMC Alpha Supply Pool</span>
                          <span>
                            Ammo {snapshot.pmcSupplyPools.pmc_alpha.ammo}% · Med {snapshot.pmcSupplyPools.pmc_alpha.medical}% · Fuel {snapshot.pmcSupplyPools.pmc_alpha.fuelParts}% · Intel {snapshot.pmcSupplyPools.pmc_alpha.intel}%
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-neutral-300">
                          <span className="font-semibold text-amber-300">PMC Bravo Supply Pool</span>
                          <span>
                            Ammo {snapshot.pmcSupplyPools.pmc_bravo.ammo}% · Med {snapshot.pmcSupplyPools.pmc_bravo.medical}% · Fuel {snapshot.pmcSupplyPools.pmc_bravo.fuelParts}% · Intel {snapshot.pmcSupplyPools.pmc_bravo.intel}%
                          </span>
                        </div>
                        <div className="border-t border-white/10 pt-1 text-[10px] text-neutral-400">
                          Visit your physical Home FOB Logistics Terminal ([F]) to fund FOB Tier 1–3 upgrades &amp; purchase Supply-Coupled Trader stock.
                        </div>
                      </div>

                      <div className="space-y-1 border border-white/10 bg-[#12161e] p-2.5 font-mono-tabular text-[11px]">
                        <div className="flex items-center gap-1.5 font-semibold text-neutral-200">
                          <Truck className="h-3.5 w-3.5 text-amber-300" />
                          <span>Live Supply Convoys &amp; Barges</span>
                        </div>
                        {snapshot.convoys.map((cv) => (
                          <div key={cv.id} className="flex items-center justify-between text-[10px] text-neutral-300">
                            <span className={cv.ownerFaction === 'pmc_alpha' ? 'text-sky-300' : 'text-amber-300'}>
                              {cv.label}
                            </span>
                            <span>
                              {cv.state === 'disabled_awaiting_action'
                                ? 'DISABLED — [F] HIJACK / [X] SABOTAGE'
                                : cv.state === 'en_route'
                                  ? `EN ROUTE (${cv.aliveEscorts}/${cv.totalEscorts} Escorts)`
                                  : cv.state.toUpperCase()}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 3-Slot Rotating Sub-Faction Contracts + Biome Terminal Contracts */}
                    {char && char.contractBoard && char.contractBoard.length > 0 && (
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                        {char.contractBoard.map((c) => (
                          <div
                            key={c.instanceId}
                            className="flex items-center justify-between gap-2 border border-white/10 bg-[#12161e] px-2.5 py-1.5 font-mono-tabular text-[10px]"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-neutral-100">
                                [{c.archetype.toUpperCase()}] {c.title}
                              </div>
                              <div className="text-neutral-400">
                                {SUB_FACTION_MAP[c.subFactionId].shortName} +{c.standingGain} · ${c.cashRewardUsd.toLocaleString()} · {c.progress}/{c.targetCount}
                              </div>
                            </div>
                            {!c.accepted ? (
                              <button
                                type="button"
                                onClick={() => onAcceptContract(c.slotIndex)}
                                className="shrink-0 cursor-pointer border border-amber-400/60 bg-amber-950/50 px-2 py-1 text-amber-200 hover:bg-amber-900/60"
                              >
                                Accept
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onCompleteContract(c.slotIndex)}
                                className="shrink-0 cursor-pointer border border-emerald-400/60 bg-emerald-950/50 px-2 py-1 text-emerald-200 hover:bg-emerald-900/60"
                              >
                                Turn In
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 border border-white/10 bg-[#12161e] p-2 text-[10px]">
                      <span className="font-mono-tabular text-neutral-400 mr-1">Biome Terminals:</span>
                      {OPENWORLD_CONTRACT_CATALOG.map((c) => {
                        const done = completedContracts.has(c.id);
                        return (
                          <span
                            key={c.id}
                            className={`flex items-center gap-1 border px-2 py-0.5 font-mono-tabular ${
                              done
                                ? 'border-emerald-500/40 bg-emerald-950/50 text-emerald-300'
                                : 'border-white/12 bg-black/30 text-neutral-300'
                            }`}
                          >
                            {done && <Check className="h-3 w-3" />}
                            <span>{c.title}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {dockTab === 'atmosphere' && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Sun className="h-3.5 w-3.5 text-neutral-400 mr-0.5" />
                      {TIME_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => onSetTimeOfDay(p.hours)}
                          className="cursor-pointer border border-white/12 bg-[#141922] px-2.5 py-1.5 text-xs font-mono-tabular text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap shrink-0"
                        >
                          {p.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => onSetTimeScale(atmo.timeScale === 1 ? 60 : 1)}
                        className={`cursor-pointer border px-2.5 py-1.5 text-xs font-mono-tabular transition-colors whitespace-nowrap shrink-0 ${
                          atmo.timeScale > 1
                            ? 'border-amber-400/70 bg-amber-950/60 text-amber-200'
                            : 'border-white/12 bg-[#141922] text-neutral-300'
                        }`}
                      >
                        {atmo.timeScale > 1 ? '60x Fast Cycle' : '1x (90m Cycle)'}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {WEATHER_OPTIONS.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          onClick={() => onSetWeather(w.id)}
                          className={`flex cursor-pointer items-center gap-1 border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            atmo.weather === w.id
                              ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                              : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                          }`}
                        >
                          {w.id === 'coastal_fog' && <CloudFog className="h-3.5 w-3.5" />}
                          {w.id === 'mountain_rain' && <CloudRain className="h-3.5 w-3.5" />}
                          <span>{w.label}</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => onSetAutoWeather(!atmo.autoWeatherCycle)}
                        className={`cursor-pointer border px-2.5 py-1.5 text-xs font-mono-tabular transition-colors whitespace-nowrap shrink-0 ${
                          atmo.autoWeatherCycle
                            ? 'border-emerald-400/70 bg-emerald-950/60 text-emerald-200'
                            : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                        }`}
                      >
                        {atmo.autoWeatherCycle ? 'Auto Cycle: ON' : 'Auto Cycle: OFF'}
                      </button>
                      <span className="ml-1 font-mono-tabular text-[11px] text-neutral-400 whitespace-nowrap">
                        Clouds {atmo.cloudCoveragePct}% · Rays {atmo.godraysActive ? 'Active' : 'Standby'}
                      </span>
                    </div>
                  </div>
                )}

                {dockTab === 'ops' && (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="flex items-center gap-1 text-[11px] font-medium text-neutral-400 mr-1">
                          <Camera className="h-3.5 w-3.5" />
                          <span>Render:</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => onSetRenderPipeline('direct')}
                          className={`cursor-pointer border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            snapshot.renderPipeline === 'direct'
                              ? 'border-amber-400/70 bg-amber-950/60 text-amber-200'
                              : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                          }`}
                        >
                          Direct 2-Pass
                        </button>
                        <button
                          type="button"
                          onClick={() => onSetRenderPipeline('bodycam_post')}
                          className={`cursor-pointer border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            snapshot.renderPipeline === 'bodycam_post'
                              ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                              : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                          }`}
                        >
                          Bodycam Optical
                        </button>

                        {snapshot.renderPipeline === 'bodycam_post' && (
                          <>
                            <span className="text-neutral-600 mx-1">|</span>
                            {LENS_PRESET_OPTIONS.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => onSetLensPreset(p.id)}
                                className={`cursor-pointer border px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                                  snapshot.lensPreset === p.id
                                    ? 'border-sky-400/65 bg-sky-950/50 text-sky-200'
                                    : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="flex items-center gap-1 text-[11px] font-medium text-neutral-400 mr-0.5">
                          <Eye className="h-3.5 w-3.5" />
                          <span>NVG</span>
                        </span>
                        {NVG_OPTIONS.map((n) => (
                          <button
                            key={n.id}
                            type="button"
                            onClick={() => onSetNvgMode(n.id)}
                            className={`cursor-pointer border px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                              snapshot.nvgMode === n.id
                                ? 'border-emerald-400/70 bg-emerald-950/60 text-emerald-200'
                                : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                            }`}
                          >
                            {n.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Graphics Quality Presets & Opt-In Adaptive Scaling (OFF by default) */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium text-neutral-400 mr-1">Quality:</span>
                        {GRAPHICS_QUALITY_ORDER.map((gid) => (
                          <button
                            key={gid}
                            type="button"
                            onClick={() => setGraphicsQuality(gid)}
                            className={`cursor-pointer border px-2 py-1 font-mono-tabular text-[10px] font-semibold uppercase transition-colors whitespace-nowrap shrink-0 ${
                              graphicsQuality === gid
                                ? 'border-amber-400/75 bg-amber-950/60 text-amber-200'
                                : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                            }`}
                            title={GRAPHICS_QUALITY_PROFILES[gid].description}
                          >
                            {GRAPHICS_QUALITY_PROFILES[gid].shortLabel}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setAdaptiveScaling(!adaptiveScaling)}
                        className={`cursor-pointer border px-2.5 py-1 font-mono-tabular text-[10px] font-semibold uppercase transition-colors whitespace-nowrap shrink-0 ${
                          adaptiveScaling
                            ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                            : 'border-white/12 bg-[#141922] text-neutral-300 hover:border-white/30'
                        }`}
                        title="Automatically scale resolution and sky/godrays if FPS dips below target (OFF by default)"
                      >
                        Adaptive Scaling: {adaptiveScaling ? 'ON' : 'OFF'}
                      </button>
                    </div>

                    {/* Phase 5 Dynamic World Events Scheduler & Manual Triggers */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2">
                      <div className="flex flex-wrap items-center gap-1.5 font-mono-tabular text-[11px]">
                        <Radio className="h-3.5 w-3.5 text-amber-300" />
                        <span className="text-neutral-300">
                          World Events (Auto {snapshot.worldEvent.nextPeriodicEventSec}s):
                        </span>
                        {(
                          [
                            { id: 'black_box_drop', label: 'Black-Box Drop' },
                            { id: 'smuggler_boat', label: 'Smuggler Boat' },
                            { id: 'convoy_ambush', label: 'Convoy Ambush' },
                            { id: 'sector_counter_assault', label: 'Counter-Assault' },
                          ] as const
                        ).map((ev) => (
                          <button
                            key={ev.id}
                            type="button"
                            onClick={() => onTriggerWorldEvent(ev.id)}
                            className="cursor-pointer border border-amber-400/45 bg-amber-950/40 px-2 py-1 text-[10px] font-medium text-amber-200 hover:border-amber-300 hover:bg-amber-900/50 whitespace-nowrap shrink-0"
                          >
                            Trigger {ev.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono-tabular text-[11px] text-neutral-400">
                          TAC-PDA Battery {combat.pdaBatteryPct}%
                        </span>
                        <button
                          type="button"
                          onClick={() => openGameSettings('controls')}
                          className="cursor-pointer border border-white/14 bg-[#141922] px-2.5 py-1 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-200 hover:border-amber-400/70 hover:text-amber-200 whitespace-nowrap shrink-0"
                        >
                          Settings &amp; Controls
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={onExfilToHideout}
                          className="flex cursor-pointer items-center gap-1.5 border border-amber-500/60 bg-[#1a160f] px-3 py-1.5 text-xs font-semibold text-amber-200 hover:border-amber-400 whitespace-nowrap shrink-0"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          <span>Exfil</span>
                        </button>
                        {char && (
                          <button
                            type="button"
                            onClick={onTriggerFieldDeath}
                            className="flex cursor-pointer items-center gap-1.5 border border-red-500/65 bg-red-950/55 px-3 py-1.5 text-xs font-semibold text-red-200 transition-colors hover:border-red-400 hover:bg-red-950/80 whitespace-nowrap shrink-0"
                          >
                            <Skull className="h-3.5 w-3.5" />
                            <span>Simulate Field Death</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Phase 5 Interactive Tetris Grid Inventory & Corpse/Event Loot Modal */}
      {(snapshot.activeModal === 'inventory' ||
        snapshot.activeModal === 'corpse_loot' ||
        snapshot.activeModal === 'event_loot') &&
        char?.tacticalInventory && (
          <TacticalInventoryModal
            inventory={char.tacticalInventory}
            externalLoot={snapshot.externalLoot}
            playerHp={combat.hp}
            maxHp={combat.maxHp}
            bleeding={combat.bleedingRemainingSec > 0}
            sprintSlow={combat.sprintSlowRemainingSec > 0}
            pdaBatteryPct={combat.pdaBatteryPct}
            onMutateInventory={onMutateInventory}
            onTriggerDragReload={onTriggerDragReload}
            onUseMedicalItem={onUseMedicalItem}
            onUsePdaBattery={onUsePdaBattery}
            onClose={onCloseModal}
          />
        )}

      {/* Phase 4 In-World Home FOB & Trusted Sub-Faction Black-Market Terminal Modal */}
      {(snapshot.activeModal === 'fob_terminal' ||
        snapshot.activeModal === 'black_market_terminal') &&
        snapshot.fobTerminalState &&
        char && (
          <FobTerminalModal
            terminal={snapshot.fobTerminalState}
            cashUsd={char.cash}
            callsign={char.callsign}
            contractBoard={char.contractBoard ?? []}
            blackMarketContext={snapshot.blackMarketContext}
            onFundUpgrade={onFundFobUpgrade}
            onBuyOffer={onBuyFobOffer}
            onAcceptContract={onAcceptContract}
            onCompleteContract={onCompleteContract}
            onClose={onCloseModal}
          />
        )}

      {/* FOB Armory & Persistent Player Stash Lockers Modal */}
      {snapshot.activeModal === 'armory_stash' && char && (
        <ArmoryStashModal
          character={char}
          onDepositItem={onDepositArmoryItem}
          onWithdrawItem={onWithdrawArmoryItem}
          onEquipWeapon={onEquipArmoryWeapon}
          onEquipArmorPlate={onEquipArmoryArmorPlate}
          onResupplyAmmo={onResupplyArmoryAmmo}
          onClose={onCloseModal}
        />
      )}

      {/* Tier 3 FOB Fast-Travel Helipad Dispatch Modal */}
      {snapshot.activeModal === 'helipad_travel' && (
        <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg border border-white/15 bg-[#0c1016] text-neutral-100 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-neutral-50">
                  Tier 3 Helipad — Tactical Fast-Travel Dispatch
                </h2>
                <p className="text-xs text-neutral-400">
                  Select any friendly FOB or secured sector landing zone for immediate rotor insertion.
                </p>
              </div>
              <button
                type="button"
                onClick={onCloseModal}
                className="cursor-pointer border border-white/15 p-1.5 text-neutral-400 hover:border-white/35 hover:text-neutral-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2">
              {snapshot.fastTravelDestinations.map((dest) => (
                <button
                  key={dest.sectorId}
                  type="button"
                  onClick={() => onFastTravelToSector(dest.sectorId)}
                  className="flex cursor-pointer items-center justify-between border border-white/12 bg-[#131820] px-3 py-2.5 text-left transition-colors hover:border-amber-400/70 hover:bg-[#19202b]"
                >
                  <div>
                    <div className="text-xs font-semibold text-neutral-100">{dest.name}</div>
                    <div className="font-mono-tabular text-[10px] text-neutral-400">
                      {dest.isFob ? 'HOME FOB LZ' : 'SECURED SECTOR LZ'} · ({Math.round(dest.worldX)},{' '}
                      {Math.round(dest.worldZ)})
                    </div>
                  </div>
                  <Compass className="h-4 w-4 shrink-0 text-amber-300" />
                </button>
              ))}
              {snapshot.fastTravelDestinations.length === 0 && (
                <div className="col-span-2 border border-white/10 bg-[#12161e] p-3 text-xs text-neutral-400">
                  No friendly landing zones currently secured.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

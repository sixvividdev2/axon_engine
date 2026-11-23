import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CloudFog,
  CloudRain,
  Compass,
  Crosshair,
  Eye,
  Flag,
  Flashlight,
  Heart,
  LogOut,
  Map as MapIcon,
  Navigation,
  Shield,
  Skull,
  Sun,
} from 'lucide-react';
import type { BodycamLensPresetId } from '../../../bodycam-sdk';
import {
  OPENWORLD_CONTRACT_CATALOG,
  OpenWorldWeatherId,
  PMC_FACTIONS,
  SectorControlOwner,
} from './types';
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
  onExecuteInteract: () => void;
  onTeleportLandmark: (landmarkId: string) => void;
  onSetTimeOfDay: (hours: number) => void;
  onSetTimeScale: (scale: number) => void;
  onSetWeather: (weather: OpenWorldWeatherId) => void;
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
  return 'text-neutral-400';
}

function ownerShort(owner: SectorControlOwner): string {
  if (owner === 'pmc_alpha') return 'ALPHA';
  if (owner === 'pmc_bravo') return 'BRAVO';
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
  onExecuteInteract,
  onTeleportLandmark,
  onSetTimeOfDay,
  onSetTimeScale,
  onSetWeather,
  onExfilToHideout,
  onTriggerFieldDeath,
}) => {
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<DockTabId>('sectors');

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
  const faction = char ? PMC_FACTIONS[char.pmcFaction] : null;
  const atmo = snapshot.atmosphere;
  const combat = snapshot.combat;
  const activeSector = snapshot.activeSector;
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

      {/* Brief Ballistic Hitmarker Cross */}
      {combat.hitMarkerAlpha > 0.04 && (
        <div
          className="pointer-events-none fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ opacity: Math.min(1, combat.hitMarkerAlpha) }}
        >
          <Crosshair
            className={`h-6 w-6 ${combat.hitMarkerHeadshot ? 'text-amber-300' : 'text-neutral-100'}`}
          />
        </div>
      )}

      {/* Top Row: Compact Telemetry + Active Sector Banner + Exfil/Lock Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="pointer-events-auto space-y-1 bg-[#0b0e13]/90 border border-white/10 px-3.5 py-2 text-xs text-neutral-200">
          <div className="flex flex-wrap items-center gap-2 font-mono-tabular">
            <span className="font-semibold text-neutral-50">
              {char ? char.callsign : 'Recon Observer'}
            </span>
            {char && faction && (
              <>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span className="text-amber-300">{char.shardMode}</span>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span>{faction.shortName}</span>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span className="text-neutral-100">{formatUsd(char.cash)}</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-neutral-400">
            <span className="text-neutral-200">{snapshot.biomeName}</span>
            <span aria-hidden="true">·</span>
            <span>Elev {snapshot.groundY.toFixed(1)}m</span>
            <span aria-hidden="true">·</span>
            <span className="text-sky-300">Alpha {snapshot.territoryCounts.pmc_alpha}</span>
            <span className="text-amber-300">Bravo {snapshot.territoryCounts.pmc_bravo}</span>
            <span>Neutral {snapshot.territoryCounts.neutral}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-neutral-400">
            <span>{atmo.timeFormatted} {atmo.phaseLabel}</span>
            <span aria-hidden="true">·</span>
            <span>{atmo.weatherLabel}</span>
            <span aria-hidden="true">·</span>
            <span>AI Sight {snapshot.ai.effectiveVisionRangeM}m</span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.drawCalls} calls</span>
          </div>
        </div>

        {/* Center-Top Active Sector Capture Indicator (visible only inside capture perimeter) */}
        {activeSector && !activeSector.isFob && (
          <div className="border border-white/14 bg-[#0b0e13]/92 px-4 py-2 text-xs text-neutral-100">
            <div className="flex items-center justify-between gap-4 font-mono-tabular">
              <span className="flex items-center gap-1.5 font-semibold">
                <Flag className={`h-3.5 w-3.5 ${ownerTagColor(activeSector.owner)}`} />
                <span>{activeSector.shortLabel}</span>
              </span>
              <span className={`text-[11px] font-semibold ${ownerTagColor(activeSector.owner)}`}>
                {ownerShort(activeSector.owner)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-52 bg-white/10">
              <div
                className={`h-full transition-all duration-150 ${
                  activeSector.contested ? 'bg-red-500' : 'bg-amber-400'
                }`}
                style={{ width: `${Math.round(activeSector.liveCapturePct)}%` }}
              />
            </div>
            <div className="mt-1 font-mono-tabular text-[11px] text-neutral-400">
              {activeSector.contested
                ? `Contested · Clear ${activeSector.hostileGarrisonCount} hostile(s)`
                : char && activeSector.owner === char.pmcFaction
                  ? 'Sector Secured · Supply Line Active'
                  : `Capturing Sector (${Math.round(activeSector.liveCapturePct)}%)`}
            </div>
          </div>
        )}

        {/* Right Top: Render Pipeline Toggle, Pointer Lock & Exfil */}
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onSetRenderPipeline(
                snapshot.renderPipeline === 'direct' ? 'bodycam_post' : 'direct',
              )
            }
            className={`flex cursor-pointer items-center gap-1.5 border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              snapshot.renderPipeline === 'bodycam_post'
                ? 'border-sky-400/65 bg-sky-950/65 text-sky-200 hover:border-sky-300'
                : 'border-white/15 bg-[#12161e] text-neutral-200 hover:border-amber-400/60 hover:text-amber-200'
            }`}
          >
            <Camera className="h-3.5 w-3.5" />
            <span>
              {snapshot.renderPipeline === 'bodycam_post' ? 'Bodycam Lens' : 'Direct 2-Pass'}
            </span>
          </button>
          {!snapshot.pointerLocked && (
            <button
              type="button"
              onClick={onRequestLock}
              className="cursor-pointer border border-white/15 bg-[#12161e] px-3.5 py-2 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-400/70 hover:text-amber-200 whitespace-nowrap shrink-0"
            >
              Click to Engage (WASD + LMB)
            </button>
          )}
          <button
            type="button"
            onClick={onExfilToHideout}
            className="flex cursor-pointer items-center gap-1.5 border border-amber-500/60 bg-[#1a160f] px-3.5 py-2 text-xs font-semibold text-amber-200 transition-colors hover:border-amber-400 hover:bg-[#241e13] whitespace-nowrap shrink-0"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Exfil to Hideout</span>
          </button>
        </div>
      </div>

      {/* Alerts / Toast / Interact Prompt Stack */}
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2">
        {char && snapshot.bankruptcy?.isBankruptcyRisk && (
          <div
            role="alert"
            className="pointer-events-auto flex items-center gap-2.5 border border-red-500/75 bg-[#200c10] px-4 py-2 text-xs text-red-100"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
            <span className="font-mono-tabular font-semibold">
              BANKRUPTCY WARNING · Cash {formatUsd(snapshot.bankruptcy.currentCash)} below Medevac{' '}
              {formatUsd(snapshot.bankruptcy.nextRespawnFee)} · Death permanently wipes {char.callsign}
            </span>
          </div>
        )}

        {snapshot.toastMessage && (
          <div className="border border-amber-500/45 bg-[#111419]/95 px-4 py-2 font-mono-tabular text-xs text-amber-100">
            {snapshot.toastMessage}
          </div>
        )}

        {snapshot.interactable && snapshot.navMode === 'foot' && (
          <button
            type="button"
            onClick={onExecuteInteract}
            className={`pointer-events-auto flex cursor-pointer items-center gap-3 border px-4 py-2 text-left text-xs ${
              snapshot.interactable.canExecute
                ? 'border-amber-400/70 bg-[#12161d]/95 text-neutral-100 hover:border-amber-300'
                : 'border-red-500/50 bg-[#1b1114]/95 text-red-100'
            }`}
          >
            <span className="border border-amber-400/60 bg-amber-500/20 px-1.5 py-0.5 font-mono-tabular font-semibold text-amber-200">
              F
            </span>
            <div>
              <div className="font-semibold">{snapshot.interactable.label}</div>
              <div className="text-[11px] text-neutral-400">{snapshot.interactable.sublabel}</div>
            </div>
          </button>
        )}

        {snapshot.lastDeathOutcome && (
          <div
            className={`pointer-events-auto flex flex-wrap items-center justify-between gap-3 border px-4 py-2.5 text-xs ${
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

      {/* Bottom Row: Minimal Operator Vitals Strip + Collapsible Unified Bottom Control Dock */}
      <div className="flex flex-col items-center gap-2">
        {snapshot.navMode === 'foot' && (
          <div className="flex w-full items-end justify-between gap-4">
            {/* Compact Bottom-Left Vitals & Armor */}
            <div className="flex items-center gap-4 border border-white/10 bg-[#0b0e13]/90 px-3.5 py-2 font-mono-tabular text-xs text-neutral-200">
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
              {combat.killsThisSortie > 0 && (
                <>
                  <span aria-hidden="true" className="text-neutral-600">·</span>
                  <span className="text-amber-300">{combat.killsThisSortie} EKIA</span>
                </>
              )}
            </div>

            {/* Compact Bottom-Right Weapon & Ordnance Readout */}
            <div className="flex items-center gap-3 border border-white/10 bg-[#0b0e13]/90 px-3.5 py-2 font-mono-tabular text-xs text-neutral-200">
              <div>
                <span className="font-semibold text-neutral-50">{combat.equippedWeaponName}</span>
                {combat.equippedCaliber && (
                  <span className="ml-2 text-[11px] text-neutral-400">{combat.equippedCaliber}</span>
                )}
              </div>
              {combat.magCapacity > 0 && (
                <>
                  <span aria-hidden="true" className="text-neutral-600">·</span>
                  <span>
                    <strong className={combat.ammoInMag <= 5 ? 'text-amber-400' : 'text-neutral-50'}>
                      {combat.reloading ? 'RLD' : combat.ammoInMag}
                    </strong>
                    <span className="text-neutral-400"> / {combat.ammoReserve}</span>
                  </span>
                </>
              )}
              <span aria-hidden="true" className="text-neutral-600">·</span>
              <span className="text-neutral-300">
                {combat.grenadeDrawn ? `ORD:${combat.grenadeHoldStage}` : `FRAG x${combat.grenadeCount}`}
              </span>
              <span aria-hidden="true" className="text-neutral-600">·</span>
              <span className={combat.isPdaOpen ? 'text-emerald-300' : 'text-neutral-400'}>
                [M] PDA
              </span>
            </div>
          </div>
        )}

        {/* Collapsible Unified Bottom Control Dock (Zero Center / Flank Occlusion) */}
        <div className="pointer-events-auto mx-auto flex w-full max-w-[940px] flex-col items-center">
          <button
            type="button"
            onClick={() => setDockOpen((prev) => !prev)}
            className="flex cursor-pointer items-center gap-1.5 border border-b-0 border-white/15 bg-[#0e1218] px-3.5 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:text-neutral-50 whitespace-nowrap"
          >
            {dockOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            <span>{dockOpen ? 'Hide Theater Controls (H)' : 'Theater Controls & Sectors (H)'}</span>
          </button>

          {dockOpen && (
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
                    <span>GPS PDA (M)</span>
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
                    <span>{snapshot.navMode === 'recon_flight' ? 'Recon Flight (V)' : 'Foot Bodycam (V)'}</span>
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
                    <span>Light (L)</span>
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
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5 border border-white/10 bg-[#12161e] p-2.5 font-mono-tabular text-[11px]">
                      <div className="flex items-center justify-between text-neutral-300">
                        <span className="text-sky-300 font-semibold">PMC Alpha Supply Pool</span>
                        <span>
                          Ammo {snapshot.pmcSupplyPools.pmc_alpha.ammo}% · Med {snapshot.pmcSupplyPools.pmc_alpha.medical}% · Fuel {snapshot.pmcSupplyPools.pmc_alpha.fuelParts}% · Intel {snapshot.pmcSupplyPools.pmc_alpha.intel}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-neutral-300">
                        <span className="text-amber-300 font-semibold">PMC Bravo Supply Pool</span>
                        <span>
                          Ammo {snapshot.pmcSupplyPools.pmc_bravo.ammo}% · Med {snapshot.pmcSupplyPools.pmc_bravo.medical}% · Fuel {snapshot.pmcSupplyPools.pmc_bravo.fuelParts}% · Intel {snapshot.pmcSupplyPools.pmc_bravo.intel}%
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 border border-white/10 bg-[#12161e] p-2.5 text-[11px]">
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

                    <div className="flex items-center gap-1.5">
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
                          <span>[N]</span>
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

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-2">
                      <div className="font-mono-tabular text-[11px] text-neutral-400">
                        LMB Fire · RMB ADS · MMB/B Cant · R Reload · G/4 Grenade · M GPS PDA · N NVG · F Interact · Q/E Lean · C Crouch · AI Alive: {snapshot.ai.totalAlive} ({snapshot.ai.hostileEngaging} Engaging) · Corpses: {snapshot.shardCorpseCount}
                      </div>
                      {char && (
                        <button
                          type="button"
                          onClick={onTriggerFieldDeath}
                          className="flex cursor-pointer items-center gap-1.5 border border-red-500/65 bg-red-950/55 px-3 py-1.5 text-xs font-semibold text-red-200 transition-colors hover:border-red-400 hover:bg-red-950/80 whitespace-nowrap shrink-0"
                        >
                          <Skull className="h-3.5 w-3.5" />
                          <span>Simulate Field Death Here</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

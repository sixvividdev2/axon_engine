import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CloudFog,
  CloudRain,
  Compass,
  Flashlight,
  LogOut,
  Navigation,
  Skull,
  Sun,
} from 'lucide-react';
import { OpenWorldWeatherId, PMC_FACTIONS } from './types';
import { OpenWorldNavMode, OpenWorldSessionSnapshot } from './world/OpenWorldSessionEngine';
import { OPENWORLD_LANDMARKS } from './world/OpenWorldTerrain';

interface OpenWorldHudProps {
  snapshot: OpenWorldSessionSnapshot;
  onRequestLock: () => void;
  onSetNavMode: (mode: OpenWorldNavMode) => void;
  onToggleFlashlight: () => void;
  onTeleportLandmark: (landmarkId: string) => void;
  onSetTimeOfDay: (hours: number) => void;
  onSetTimeScale: (scale: number) => void;
  onSetWeather: (weather: OpenWorldWeatherId) => void;
  onExfilToHideout: () => void;
  onTriggerFieldDeath: () => void;
}

type DockTabId = 'sectors' | 'atmosphere' | 'ops';

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

function formatUsd(amount: number): string {
  return `$${Math.max(0, Math.round(amount)).toLocaleString()}`;
}

export const OpenWorldHud: React.FC<OpenWorldHudProps> = ({
  snapshot,
  onRequestLock,
  onSetNavMode,
  onToggleFlashlight,
  onTeleportLandmark,
  onSetTimeOfDay,
  onSetTimeScale,
  onSetWeather,
  onExfilToHideout,
  onTriggerFieldDeath,
}) => {
  const [dockOpen, setDockOpen] = useState(true);
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

  return (
    <div className="pointer-events-none fixed inset-0 z-20 flex flex-col justify-between p-4 select-none">
      {/* Top Row: Minimal Unboxed Telemetry + Bankruptcy Alert */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="pointer-events-auto space-y-1 bg-[#0b0e13]/90 border border-white/10 px-3.5 py-2.5 text-xs text-neutral-200">
          <div className="flex flex-wrap items-center gap-2 font-mono-tabular">
            <span className="font-semibold text-neutral-50">
              {char ? char.callsign : 'Recon Observer'}
            </span>
            {char && faction && (
              <>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span className="text-amber-300">{char.shardMode}</span>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span>{faction.name}</span>
                <span aria-hidden="true" className="text-neutral-600">·</span>
                <span className="text-neutral-100">{formatUsd(char.cash)}</span>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-neutral-400">
            <span className="text-neutral-200">{snapshot.biomeName}</span>
            <span aria-hidden="true">·</span>
            <span>Elev {snapshot.groundY.toFixed(1)}m ({snapshot.biomeElevationBand})</span>
            <span aria-hidden="true">·</span>
            <span>
              Grid ({snapshot.streamer.centerChunkX},{snapshot.streamer.centerChunkZ})
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Active {snapshot.streamer.activeChunkCount} / Mid {snapshot.streamer.midChunkCount}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[11px] text-neutral-400">
            <span>{atmo.timeFormatted} {atmo.phaseLabel}</span>
            <span aria-hidden="true">·</span>
            <span>{atmo.weatherLabel}</span>
            <span aria-hidden="true">·</span>
            <span>AI Vision {Math.round(atmo.aiVisionConeMultiplier * 100)}%</span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.drawCalls} calls</span>
            <span aria-hidden="true">·</span>
            <span>{snapshot.nearestLandmarkName} ({snapshot.nearestLandmarkDistM}m)</span>
          </div>
        </div>

        {/* Right Top: Exfil & Pointer Lock Action */}
        <div className="pointer-events-auto flex items-center gap-2">
          {!snapshot.pointerLocked && (
            <button
              type="button"
              onClick={onRequestLock}
              className="cursor-pointer border border-white/15 bg-[#12161e] px-3.5 py-2 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-400/70 hover:text-amber-200 whitespace-nowrap shrink-0"
            >
              Click to Look (WASD)
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

      {/* Explicit Bankruptcy Warning or Post-Death Outcome Banner */}
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

      {/* Collapsible Unified Bottom Control Dock (Zero Center / Flank Occlusion) */}
      <div className="pointer-events-auto mx-auto flex w-full max-w-[920px] flex-col items-center">
        <button
          type="button"
          onClick={() => setDockOpen((prev) => !prev)}
          className="flex cursor-pointer items-center gap-1.5 border border-b-0 border-white/15 bg-[#0e1218] px-3.5 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:text-neutral-50 whitespace-nowrap"
        >
          {dockOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          <span>{dockOpen ? 'Hide Controls (H)' : 'Show Controls (H)'}</span>
        </button>

        {dockOpen && (
          <div className="w-full border border-white/14 bg-[#0d1117] px-4 py-3 text-xs text-neutral-200">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-2.5">
              {/* Dock Category Tabs */}
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'sectors', label: '4km Sectors' },
                    { id: 'atmosphere', label: '90m Cycle & Weather' },
                    { id: 'ops', label: 'Traversal & Field Test' },
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
                  onClick={() =>
                    onSetNavMode(snapshot.navMode === 'foot' ? 'recon_flight' : 'foot')
                  }
                  className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    snapshot.navMode === 'recon_flight'
                      ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                      : 'border-white/14 bg-[#141922] text-neutral-200 hover:border-white/30'
                  }`}
                >
                  <Navigation className="h-3.5 w-3.5" />
                  <span>{snapshot.navMode === 'recon_flight' ? 'Recon Flight (V)' : 'Foot Patrol (V)'}</span>
                </button>

                <button
                  type="button"
                  onClick={onToggleFlashlight}
                  className={`flex cursor-pointer items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    snapshot.flashlightOn
                      ? 'border-amber-400/75 bg-amber-950/60 text-amber-200'
                      : 'border-white/14 bg-[#141922] text-neutral-300 hover:border-white/30'
                  }`}
                >
                  <Flashlight className="h-3.5 w-3.5" />
                  <span>Light {snapshot.flashlightOn ? 'On' : 'Off'} (F)</span>
                </button>
              </div>
            </div>

            {/* Tab Content Row */}
            <div className="pt-2.5">
              {dockTab === 'sectors' && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1 text-[11px] text-neutral-400 mr-1">
                    <Compass className="h-3.5 w-3.5" />
                    <span>Insert:</span>
                  </span>
                  {OPENWORLD_LANDMARKS.map((lm) => (
                    <button
                      key={lm.id}
                      type="button"
                      onClick={() => onTeleportLandmark(lm.id)}
                      className="cursor-pointer border border-white/12 bg-[#141922] px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap shrink-0"
                    >
                      {lm.shortLabel}
                    </button>
                  ))}
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
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-mono-tabular text-[11px] text-neutral-400">
                    WASD Move · Shift Sprint/Boost · Space Jump/Climb · C Descend · Arrow Keys or Click to Look ·
                    Disposed Chunks: {snapshot.streamer.disposedChunkCount} · Shard Corpses: {snapshot.shardCorpseCount}
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
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

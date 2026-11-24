import React from 'react';
import { ArrowLeft, Radio, Shield, Sliders, Volume2, Wrench } from 'lucide-react';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  GraphicsQualityId,
  useGraphicsQuality,
} from '../data/graphicsQuality';
import type { ZombiesLobbySnapshot } from './ZombiesLobbyController';
import { openGameSettings } from '../data/gameSettingsStore';

interface ZombiesOutpostHudProps {
  snapshot: ZombiesLobbySnapshot;
  modalOpen: boolean;
  onRequestLock: () => void;
  onOpenZombiesOps: () => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onReturnToHideout: () => void;
  onVolumeChange: (volume: number) => void;
  onGraphicsChange: (quality: GraphicsQualityId) => void;
}

/**
 * Clean minimal diegetic HUD & ESC Pause Menu for the standalone 3D Zombies Outpost Lobby.
 * Strictly zero backdrop-filter over WebGL, zero static pill badges, zero pulsing dots.
 */
export const ZombiesOutpostHud: React.FC<ZombiesOutpostHudProps> = ({
  snapshot,
  modalOpen,
  onRequestLock,
  onOpenZombiesOps,
  onOpenGunsmith,
  onOpenOperatorGear,
  onReturnToHideout,
  onVolumeChange,
  onGraphicsChange,
}) => {
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const showLiveHud = snapshot.pointerLocked && !snapshot.pauseOpen && !modalOpen;
  const showEntryPrompt = !snapshot.pointerLocked && !snapshot.pauseOpen && !modalOpen;
  const showPauseMenu = snapshot.pauseOpen && !modalOpen;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 select-none">
      {/* Top-left outpost location & FPS */}
      {!showPauseMenu && !modalOpen && (
        <div className="fixed left-6 top-5 flex items-baseline gap-3 text-neutral-200/85">
          <span className="font-display text-sm font-semibold tracking-wider text-neutral-100">
            {snapshot.locationLabel}
          </span>
          <span className="text-xs text-neutral-500" aria-hidden="true">
            ·
          </span>
          <span className="font-mono-tabular text-xs text-neutral-400">
            {snapshot.fps} FPS
          </span>
        </div>
      )}

      {/* Subtle center interact dot */}
      {showLiveHud && snapshot.interactReticleState !== 'hidden' && (
        <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div
            className={
              snapshot.interactReticleState === 'ready'
                ? 'h-2 w-2 rounded-full border border-amber-300 bg-amber-400/85'
                : 'h-1.5 w-1.5 rounded-full bg-white/45'
            }
          />
        </div>
      )}

      {/* Grounded interaction prompt */}
      {showLiveHud && snapshot.prompt && snapshot.prompt.options.length > 0 && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2">
          <div className="flex min-w-[260px] flex-col gap-1 border border-white/15 bg-[#0d1014]/92 px-3.5 py-2.5 text-neutral-100">
            {snapshot.prompt.targetLabel && (
              <div className="flex items-center justify-between border-b border-white/10 pb-1 text-[11px] font-medium tracking-wider text-neutral-400 uppercase">
                <span>{snapshot.prompt.targetLabel}</span>
                {snapshot.prompt.options.length > 1 && (
                  <span className="font-mono-tabular text-[10px] text-amber-400">SCROLL</span>
                )}
              </div>
            )}
            <div className="flex flex-col gap-1 pt-0.5">
              {snapshot.prompt.options.map((opt, idx) => {
                const selected = idx === snapshot.prompt!.selectedIndex;
                return (
                  <div
                    key={opt.id}
                    className={`flex items-center justify-between gap-4 px-2 py-1 text-xs ${
                      selected
                        ? 'border-l-2 border-amber-400 bg-white/8 font-semibold text-white'
                        : 'border-l-2 border-transparent text-neutral-400'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {selected && (
                        <kbd className="border border-amber-400/60 bg-amber-500/18 px-1.5 py-0.5 font-mono-tabular text-[10px] font-bold text-amber-200">
                          {snapshot.prompt!.key}
                        </kbd>
                      )}
                      <span>{opt.label}</span>
                    </div>
                    {opt.hint && (
                      <span className="font-mono-tabular text-[11px] text-neutral-400">
                        {opt.hint}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Quiet bottom toast */}
      {showLiveHud && snapshot.toastMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 border border-white/14 bg-[#0d1014]/92 px-4 py-1.5 text-xs font-medium text-neutral-200">
          {snapshot.toastMessage}
        </div>
      )}

      {/* Click-to-engage prompt on initial outpost arrival */}
      {showEntryPrompt && (
        <div className="pointer-events-auto fixed inset-0 flex items-end justify-center pb-14">
          <button
            type="button"
            onClick={onRequestLock}
            className="cursor-pointer border border-amber-400/60 bg-[#0d1014]/94 px-6 py-3 font-display text-sm font-semibold uppercase tracking-wider text-neutral-100 transition-colors hover:border-amber-300 hover:bg-[#151a20]"
          >
            Click to Engage Quarantine Outpost
          </button>
        </div>
      )}

      {/* ESC Pause Menu */}
      {showPauseMenu && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-[#06080b]/82 p-6">
          <div className="flex w-full max-w-md flex-col gap-4 border border-white/14 bg-[#0d1015] p-6 text-neutral-100">
            <div className="flex flex-col gap-0.5 border-b border-white/10 pb-3">
              <h2 className="font-display text-xl font-bold tracking-wider text-white">
                Quarantine Outpost
              </h2>
              <p className="text-xs text-neutral-400">
                Inspect field rack weapons, plan Zombies ops, or return to the main Hideout.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onRequestLock}
                className="cursor-pointer border border-amber-500/70 bg-amber-500/18 px-4 py-2.5 text-left font-display text-sm font-semibold uppercase tracking-wider text-amber-100 transition-colors hover:bg-amber-500/28"
              >
                Resume Outpost
              </button>
              <button
                type="button"
                onClick={onOpenZombiesOps}
                className="flex cursor-pointer items-center gap-2.5 border border-red-500/55 bg-red-600/18 px-4 py-2 text-left text-xs font-semibold text-red-100 transition-colors hover:bg-red-600/28"
              >
                <Radio className="h-4 w-4 text-red-400" />
                <span>Zombies Operations Briefing</span>
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onOpenGunsmith}
                  className="flex cursor-pointer items-center gap-2 border border-white/12 bg-[#141820] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60"
                >
                  <Wrench className="h-3.5 w-3.5 text-amber-400" />
                  <span>Gunsmith</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenOperatorGear}
                  className="flex cursor-pointer items-center gap-2 border border-white/12 bg-[#141820] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60"
                >
                  <Shield className="h-3.5 w-3.5 text-amber-400" />
                  <span>Operator Gear</span>
                </button>
              </div>
              <button
                type="button"
                onClick={onReturnToHideout}
                className="flex cursor-pointer items-center gap-2.5 border border-white/14 bg-[#141820] px-4 py-2 text-left text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4 text-amber-400" />
                <span>Return to Hideout (Airlock Transport)</span>
              </button>
            </div>

            {/* Audio & Graphics Controls */}
            <div className="flex flex-col gap-3 border-t border-white/10 pt-3 text-xs">
              <label className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-neutral-300">
                  <Volume2 className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Master Volume</span>
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={snapshot.masterVolume}
                    onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                    className="w-28 accent-amber-500"
                  />
                  <span className="w-9 text-right font-mono-tabular text-neutral-400">
                    {Math.round(snapshot.masterVolume * 100)}%
                  </span>
                </div>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="flex items-center gap-2 text-neutral-300">
                  <Sliders className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Graphics Preset</span>
                </span>
                <div className="grid grid-cols-4 gap-1">
                  {GRAPHICS_QUALITY_ORDER.map((qid) => (
                    <button
                      key={qid}
                      type="button"
                      onClick={() => {
                        setGraphicsQuality(qid);
                        onGraphicsChange(qid);
                      }}
                      className={`cursor-pointer border py-1 text-[11px] font-medium transition-colors ${
                        graphicsQuality === qid
                          ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                          : 'border-white/10 bg-[#151922] text-neutral-400 hover:border-white/25 hover:text-neutral-100'
                      }`}
                    >
                      {GRAPHICS_QUALITY_PROFILES[qid].label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => openGameSettings('controls')}
                className="flex cursor-pointer items-center justify-center gap-2 border border-white/12 bg-[#141820] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60 hover:text-amber-200"
              >
                <Sliders className="h-3.5 w-3.5 text-amber-400" />
                <span>Game Settings &amp; Controls</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

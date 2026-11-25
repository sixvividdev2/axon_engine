import React, { useEffect } from 'react';
import { Keyboard, Sliders, User, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  closeGameSettings,
  setGameSettingsTab,
  useGameSettingsModal,
} from '../data/gameSettingsStore';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  HORIZON_FOG_LEAD_M,
  OPEN_WORLD_RENDER_DISTANCE_LIMITS,
  PHYSICS_PROPS_QUALITY_ORDER,
  PhysicsPropsQualityId,
  REDUCE_ANIMATION_DISTANCE_LIMITS,
  RENDER_DISTANCE_LIMITS,
  resolvePhysicsPropBudget,
  useAdaptiveScaling,
  useDistancePerformanceSettings,
  useGraphicsQuality,
  usePhysicsPropsQuality,
} from '../data/graphicsQuality';
import { useKillfeedPreference } from '../data/killfeedSettings';
import { useHeadshotSfxPreference } from '../data/audioSettings';
import { keybindStore } from '../data/keybindStore';
import { ControlsSettingsTab } from './ControlsSettingsTab';

export const GameSettingsModal: React.FC = () => {
  const { open, tab } = useGameSettingsModal();
  const { user, openAccountSettings, openAuthModal } = useAuth();
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const [physicsPropsQuality, setPhysicsPropsQuality] = usePhysicsPropsQuality();
  const [adaptiveScaling, setAdaptiveScaling] = useAdaptiveScaling();
  const [distanceSettings, distanceActions] = useDistancePerformanceSettings();
  const [personalKillfeed, setPersonalKillfeed] = useKillfeedPreference();
  const [headshotSfx, setHeadshotSfx] = useHeadshotSfxPreference();
  const resolvedPhysicsBudget = resolvePhysicsPropBudget(graphicsQuality, physicsPropsQuality);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        if (keybindStore.isCapturing()) return;
        e.stopPropagation();
        closeGameSettings();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/84 px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-settings-title"
    >
      <div className="relative flex max-h-[88vh] w-full max-w-3xl flex-col border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="font-mono-tabular text-[11px] uppercase tracking-[0.18em] text-amber-400">
              System Configuration
            </div>
            <h2
              id="game-settings-title"
              className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50"
            >
              Game Settings
            </h2>
          </div>

          <button
            type="button"
            onClick={closeGameSettings}
            aria-label="Close game settings"
            className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Settings Navigation Tabs */}
        <div
          className="flex items-center gap-1.5 border-b border-neutral-800 bg-[#0d1015] px-6 py-2.5"
          role="tablist"
          aria-label="Game Settings Tabs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'general'}
            onClick={() => setGameSettingsTab('general')}
            className={`flex cursor-pointer items-center gap-2 whitespace-nowrap shrink-0 border px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
              tab === 'general'
                ? 'border-amber-400 bg-amber-500/15 text-amber-300'
                : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100'
            }`}
          >
            <Sliders className="h-3.5 w-3.5" />
            <span>Video &amp; HUD</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'controls'}
            onClick={() => setGameSettingsTab('controls')}
            className={`flex cursor-pointer items-center gap-2 whitespace-nowrap shrink-0 border px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
              tab === 'controls'
                ? 'border-amber-400 bg-amber-500/15 text-amber-300'
                : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100'
            }`}
          >
            <Keyboard className="h-3.5 w-3.5" />
            <span>Controls</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'general' && (
            <div className="flex flex-col gap-5">
              {/* Graphics Quality */}
              <section className="border border-neutral-800 bg-neutral-900/55 p-4">
                <div className="flex items-center justify-between gap-4 border-b border-neutral-800/80 pb-2.5">
                  <div>
                    <h3 className="font-display text-sm font-bold uppercase tracking-wider text-neutral-100">
                      Graphics Quality Preset
                    </h3>
                    <p className="mt-0.5 text-xs text-neutral-400">
                      {GRAPHICS_QUALITY_PROFILES[graphicsQuality].description}
                    </p>
                  </div>
                  <span className="font-mono-tabular text-xs font-semibold uppercase text-amber-400">
                    {GRAPHICS_QUALITY_PROFILES[graphicsQuality].label}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {GRAPHICS_QUALITY_ORDER.map((gid) => {
                    const active = graphicsQuality === gid;
                    return (
                      <button
                        key={gid}
                        type="button"
                        onClick={() => setGraphicsQuality(gid)}
                        className={`cursor-pointer whitespace-nowrap border py-2 font-mono-tabular text-xs font-semibold uppercase transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        {GRAPHICS_QUALITY_PROFILES[gid].label}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 border-t border-neutral-800/80 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-medium text-neutral-200">
                        Dynamic Physics Props &amp; Wind Debris
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        GPU-instanced bottles, cans, wind-blown papers &amp; crates ({resolvedPhysicsBudget.maxTotalProps} max props · {resolvedPhysicsBudget.maxActiveBodies} active bodies).
                      </div>
                    </div>
                    <span className="font-mono-tabular text-xs font-semibold uppercase text-emerald-400">
                      {physicsPropsQuality === 'auto' ? `AUTO (${graphicsQuality})` : physicsPropsQuality}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-5 gap-1.5">
                    {PHYSICS_PROPS_QUALITY_ORDER.map((pid: PhysicsPropsQualityId) => {
                      const active = physicsPropsQuality === pid;
                      return (
                        <button
                          key={pid}
                          type="button"
                          onClick={() => setPhysicsPropsQuality(pid)}
                          className={`cursor-pointer whitespace-nowrap border py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors ${
                            active
                              ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                          }`}
                        >
                          {pid === 'auto' ? 'Auto' : pid}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-4 border-t border-neutral-800/80 pt-3">
                  <div>
                    <div className="text-xs font-medium text-neutral-200">
                      Adaptive Resolution Scaling
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      Automatically scale internal DPR when framerate dips below target.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAdaptiveScaling(!adaptiveScaling)}
                    className={`cursor-pointer whitespace-nowrap shrink-0 border px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase transition-colors ${
                      adaptiveScaling
                        ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                        : 'border-neutral-700 bg-neutral-950 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {adaptiveScaling ? 'ON (Dynamic DPR)' : 'OFF (Fixed Native)'}
                  </button>
                </div>

                {/* Distance & Animation LOD Sliders */}
                <div className="mt-4 flex flex-col gap-3.5 border-t border-neutral-800/80 pt-3.5">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-medium text-neutral-200">
                          Render Distance (Conquest &amp; Maps)
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          Horizon distance fog begins {HORIZON_FOG_LEAD_M} m before clip ({Math.max(12, distanceSettings.renderDistanceM - HORIZON_FOG_LEAD_M)} m–{distanceSettings.renderDistanceM} m) for seamless blending.
                        </div>
                      </div>
                      <span className="font-mono-tabular text-xs font-semibold text-amber-400">
                        {distanceSettings.renderDistanceM} m
                      </span>
                    </div>
                    <input
                      type="range"
                      min={RENDER_DISTANCE_LIMITS.min}
                      max={RENDER_DISTANCE_LIMITS.max}
                      step={RENDER_DISTANCE_LIMITS.step}
                      value={distanceSettings.renderDistanceM}
                      onChange={(e) => distanceActions.setRenderDistanceM(Number(e.target.value))}
                      aria-label="Render Distance"
                      className="mt-2 h-1.5 w-full cursor-pointer accent-amber-400"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-medium text-neutral-200">
                          Open World Render Distance
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          Controls 4 km theater draw distance and AAA horizon fog ramp ({Math.max(12, distanceSettings.openWorldRenderDistanceM - HORIZON_FOG_LEAD_M)} m–{distanceSettings.openWorldRenderDistanceM} m).
                        </div>
                      </div>
                      <span className="font-mono-tabular text-xs font-semibold text-amber-400">
                        {distanceSettings.openWorldRenderDistanceM} m
                      </span>
                    </div>
                    <input
                      type="range"
                      min={OPEN_WORLD_RENDER_DISTANCE_LIMITS.min}
                      max={OPEN_WORLD_RENDER_DISTANCE_LIMITS.max}
                      step={OPEN_WORLD_RENDER_DISTANCE_LIMITS.step}
                      value={distanceSettings.openWorldRenderDistanceM}
                      onChange={(e) => distanceActions.setOpenWorldRenderDistanceM(Number(e.target.value))}
                      aria-label="Open World Render Distance"
                      className="mt-2 h-1.5 w-full cursor-pointer accent-amber-400"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-medium text-neutral-200">
                          Reduced Animation Distance
                        </div>
                        <div className="text-[11px] text-neutral-400">
                          Operators, zombies, and wildlife beyond this distance animate at half rate to boost CPU FPS.
                        </div>
                      </div>
                      <span className="font-mono-tabular text-xs font-semibold text-sky-300">
                        {distanceSettings.reduceAnimationDistanceM} m
                      </span>
                    </div>
                    <input
                      type="range"
                      min={REDUCE_ANIMATION_DISTANCE_LIMITS.min}
                      max={REDUCE_ANIMATION_DISTANCE_LIMITS.max}
                      step={REDUCE_ANIMATION_DISTANCE_LIMITS.step}
                      value={distanceSettings.reduceAnimationDistanceM}
                      onChange={(e) => distanceActions.setReduceAnimationDistanceM(Number(e.target.value))}
                      aria-label="Reduced Animation Distance"
                      className="mt-2 h-1.5 w-full cursor-pointer accent-sky-400"
                    />
                  </div>
                </div>
              </section>

              {/* HUD & Feed */}
              <section className="border border-neutral-800 bg-neutral-900/55 p-4">
                <h3 className="font-display text-sm font-bold uppercase tracking-wider text-neutral-100">
                  Combat HUD &amp; Telemetry
                </h3>
                <div className="mt-3 flex items-center justify-between gap-4">
                  <div>
                    <div className="text-xs font-medium text-neutral-200">Killfeed Overlay</div>
                    <div className="text-[11px] text-neutral-400">
                      Display elimination feed in Battle and Infection modes unless overridden by match host.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPersonalKillfeed(!personalKillfeed)}
                    className={`cursor-pointer whitespace-nowrap shrink-0 border px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase transition-colors ${
                      personalKillfeed
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                        : 'border-neutral-700 bg-neutral-950 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {personalKillfeed ? 'ON' : 'OFF'}
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between gap-4 border-t border-neutral-800/80 pt-3.5">
                  <div>
                    <div className="text-xs font-medium text-neutral-200">
                      Headshot Indicator SFX
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      Fleshy thud &amp; blood splat audio cue on headshots (10% quieter). Disabled by default for full immersion.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHeadshotSfx(!headshotSfx)}
                    className={`cursor-pointer whitespace-nowrap shrink-0 border px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase transition-colors ${
                      headshotSfx
                        ? 'border-amber-400/80 bg-amber-950/50 text-amber-200'
                        : 'border-neutral-700 bg-neutral-950 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {headshotSfx ? 'ON' : 'OFF'}
                  </button>
                </div>
              </section>

              {/* Career Profile */}
              <section className="flex flex-wrap items-center justify-between gap-3 border border-neutral-800 bg-neutral-900/40 p-4">
                <div className="flex items-center gap-2.5">
                  <User className="h-4 w-4 text-amber-400" />
                  <div>
                    <div className="text-xs font-semibold text-neutral-100">
                      {user ? `Signed in as ${user.username}` : 'Playing as Guest Operator'}
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      {user
                        ? 'Manage your callsign, career rank dossier, or progress reset.'
                        : 'Sign in to save career XP, weapon unlocks, and multiplayer squad data.'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    closeGameSettings();
                    if (user) {
                      openAccountSettings();
                    } else {
                      openAuthModal(null);
                    }
                  }}
                  className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-950 px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400 hover:text-amber-300"
                >
                  {user ? 'Open Account Dossier' : 'Sign In / Register'}
                </button>
              </section>
            </div>
          )}

          {tab === 'controls' && <ControlsSettingsTab />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-800 bg-[#0d1015] px-6 py-3">
          <span className="font-mono-tabular text-[11px] text-neutral-500">
            F1 opens live Bodycam Optics &amp; SDK Calibration during gameplay
          </span>
          <button
            type="button"
            onClick={closeGameSettings}
            className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-5 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

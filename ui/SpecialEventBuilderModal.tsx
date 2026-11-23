import React, { useState } from 'react';
import { Sliders, X } from 'lucide-react';
import {
  DEFAULT_SPECIAL_EVENT_CONFIG,
  EventCycleModeId,
  SpecialEventConfig,
  SpecialEventRecord,
} from '../data/multiplayer';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import { BotDifficultyId } from '../maps/types';
import { WeatherTimeControls } from './WeatherTimeControls';

interface SpecialEventBuilderModalProps {
  initialEvent?: SpecialEventRecord | null;
  onSave: (payload: {
    id?: string;
    name: string;
    description: string;
    config: SpecialEventConfig;
  }) => Promise<void>;
  onClose: () => void;
}

const CYCLE_OPTIONS: Array<{ id: EventCycleModeId; label: string }> = [
  { id: 'battle_tdm', label: 'Battle · TDM' },
  { id: 'battle_ffa', label: 'Battle · FFA' },
  { id: 'infection', label: 'Infection' },
];

export const SpecialEventBuilderModal: React.FC<SpecialEventBuilderModalProps> = ({
  initialEvent,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState<string>(initialEvent?.name ?? '');
  const [description, setDescription] = useState<string>(initialEvent?.description ?? '');
  const [cfg, setCfg] = useState<SpecialEventConfig>(
    initialEvent ? { ...initialEvent.config } : { ...DEFAULT_SPECIAL_EVENT_CONFIG },
  );
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const patchCfg = (patch: Partial<SpecialEventConfig>) => {
    setCfg((prev) => ({ ...prev, ...patch }));
  };

  const toggleCycleMode = (id: EventCycleModeId) => {
    setCfg((prev) => {
      const exists = prev.cyclePool.includes(id);
      if (exists && prev.cyclePool.length <= 1) return prev;
      return {
        ...prev,
        cyclePool: exists
          ? prev.cyclePool.filter((m) => m !== id)
          : [...prev.cyclePool, id],
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || trimmedName.length > 48) {
      setError('Event name must be between 2 and 48 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: initialEvent?.id,
        name: trimmedName,
        description: description.trim().slice(0, 280),
        config: cfg,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Special Event.');
    } finally {
      setSaving(false);
    }
  };

  const availableMaps = cfg.mode === 'infection' ? ZOMBIE_MAPS : BATTLE_MAPS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/85 p-4 backdrop-blur-sm">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col border border-neutral-700 bg-neutral-950 text-neutral-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center gap-3">
            <Sliders className="h-5 w-5 text-amber-400" />
            <div>
              <div className="font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-amber-400">
                Special Event Sandbox Builder
              </div>
              <h2 className="font-display text-2xl font-bold uppercase tracking-wide text-neutral-50">
                {initialEvent ? `Edit · ${initialEvent.name}` : 'Create Custom Special Event'}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
            aria-label="Close builder"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
            {error && (
              <div className="border border-red-500/70 bg-red-950/60 px-3.5 py-2 font-mono-tabular text-xs text-red-200">
                {error}
              </div>
            )}

            {/* Section 1: Event Identity */}
            <section className="space-y-3 border-b border-neutral-800/80 pb-5">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                1 · Event Identity &amp; Share Code
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Event Name *
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={48}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Friday Night Hardcore Elimination"
                    className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-amber-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Event Description (Optional · Shown in Event Lobby Footer)
                  </label>
                  <input
                    type="text"
                    maxLength={280}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Leave blank for no footer description"
                    className="mt-1.5 w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-amber-400 focus:outline-none"
                  />
                </div>
              </div>
              {initialEvent && (
                <div className="font-mono-tabular text-xs text-neutral-400">
                  Saved Hash Code:{' '}
                  <span className="font-semibold text-sky-300">{initialEvent.hashCode}</span>{' '}
                  (players pasting this code join directly without requesting host permission)
                </div>
              )}
            </section>

            {/* Section 2: Mode, Map, Rotation & Capacity */}
            <section className="space-y-4 border-b border-neutral-800/80 pb-5">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                2 · Mode, Map Rotation &amp; Lobby Capacity
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Starting Mode
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-1">
                    {(
                      [
                        { label: 'TDM', mode: 'battle' as const, rule: 'tdm' as const },
                        { label: 'FFA', mode: 'battle' as const, rule: 'ffa' as const },
                        { label: 'Zombies', mode: 'infection' as const, rule: 'tdm' as const },
                      ]
                    ).map((opt) => {
                      const active =
                        cfg.mode === opt.mode &&
                        (opt.mode === 'infection' || cfg.battleRule === opt.rule);
                      return (
                        <button
                          key={opt.label}
                          type="button"
                          onClick={() =>
                            patchCfg({
                              mode: opt.mode,
                              battleRule: opt.rule,
                              mapId:
                                opt.mode === 'infection'
                                  ? 'kino_theater'
                                  : cfg.mapId === 'kino_theater'
                                    ? 'pripyat_block'
                                    : cfg.mapId,
                            })
                          }
                          className={`cursor-pointer border py-2 font-mono-tabular text-[11px] font-semibold uppercase ${
                            active
                              ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                              : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Map Sector
                  </label>
                  <select
                    value={cfg.mapId}
                    onChange={(e) => patchCfg({ mapId: e.target.value })}
                    className="mt-1.5 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
                  >
                    {availableMaps.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    <span>Max Players</span>
                    <span className="text-amber-300">{cfg.maxPlayers}</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={8}
                    step={1}
                    value={cfg.maxPlayers}
                    onChange={(e) => patchCfg({ maxPlayers: Number(e.target.value) })}
                    className="mt-2.5 w-full accent-amber-400"
                  />
                  <div className="flex justify-between font-mono-tabular text-[10px] text-neutral-500">
                    <span>2</span>
                    <span>8</span>
                  </div>
                </div>
              </div>

              {/* Cycle modes toggle */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-neutral-800/90 bg-neutral-900/50 px-4 py-3">
                <label className="flex cursor-pointer items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={cfg.cycleModesBetweenGames}
                    onChange={(e) => patchCfg({ cycleModesBetweenGames: e.target.checked })}
                    className="h-4 w-4 accent-amber-400"
                  />
                  <div>
                    <div className="font-mono-tabular text-xs font-semibold text-neutral-100">
                      Cycle Modes Between Games
                    </div>
                    <div className="text-[11px] text-neutral-400">
                      Automatically rotate to the next selected mode after each match returns to lobby
                    </div>
                  </div>
                </label>

                {cfg.cycleModesBetweenGames && (
                  <div className="flex items-center gap-1.5">
                    {CYCLE_OPTIONS.map((opt) => {
                      const active = cfg.cyclePool.includes(opt.id);
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => toggleCycleMode(opt.id)}
                          className={`cursor-pointer border px-2.5 py-1 font-mono-tabular text-[11px] ${
                            active
                              ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-500'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Weather & 5x Dynamic Time of Day */}
              <WeatherTimeControls
                mapId={cfg.mapId}
                weatherPreset={cfg.weatherPreset ?? 'auto'}
                timeOfDayStart={cfg.timeOfDayStart ?? 'auto'}
                accent="amber"
                onChangeWeather={(weatherPreset) => patchCfg({ weatherPreset })}
                onChangeTimeOfDay={(timeOfDayStart) => patchCfg({ timeOfDayStart })}
              />
            </section>

            {/* Section 3: Player Health, Movement & Elimination Rules */}
            <section className="space-y-4 border-b border-neutral-800/80 pb-5">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                3 · Player Rules, Respawn &amp; Elimination
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Player Health</span>
                    <span className="text-amber-300">{cfg.playerHealth} HP</span>
                  </div>
                  <input
                    type="range"
                    min={25}
                    max={500}
                    step={5}
                    value={cfg.playerHealth}
                    onChange={(e) => patchCfg({ playerHealth: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Player Move Speed</span>
                    <span className="text-amber-300">{cfg.playerMoveSpeedMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.05}
                    value={cfg.playerMoveSpeedMult}
                    onChange={(e) => patchCfg({ playerMoveSpeedMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Lives Before Full Death</span>
                    <span className="text-amber-300">
                      {cfg.livesPerRound} {cfg.livesPerRound === 1 ? '(1-Life)' : ''}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={cfg.livesPerRound}
                    onChange={(e) => patchCfg({ livesPerRound: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Rounds Per Match</span>
                    <span className="text-amber-300">{cfg.roundsPerMatch}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={1}
                    value={cfg.roundsPerMatch}
                    onChange={(e) => patchCfg({ roundsPerMatch: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="border border-neutral-800 bg-neutral-900/50 p-3">
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    When a Player Dies
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => patchCfg({ playerRespawnEnabled: true })}
                      className={`cursor-pointer border py-1.5 font-mono-tabular text-[11px] ${
                        cfg.playerRespawnEnabled
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      Respawn
                    </button>
                    <button
                      type="button"
                      onClick={() => patchCfg({ playerRespawnEnabled: false })}
                      className={`cursor-pointer border py-1.5 font-mono-tabular text-[11px] ${
                        !cfg.playerRespawnEnabled
                          ? 'border-red-500 bg-red-950/60 text-red-200'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      Die &amp; Spectate
                    </button>
                  </div>
                </div>

                <div className="border border-neutral-800 bg-neutral-900/50 p-3">
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    When an AI Bot Dies
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => patchCfg({ aiRespawnEnabled: true })}
                      className={`cursor-pointer border py-1.5 font-mono-tabular text-[11px] ${
                        cfg.aiRespawnEnabled
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      Respawn AI
                    </button>
                    <button
                      type="button"
                      onClick={() => patchCfg({ aiRespawnEnabled: false })}
                      className={`cursor-pointer border py-1.5 font-mono-tabular text-[11px] ${
                        !cfg.aiRespawnEnabled
                          ? 'border-red-500 bg-red-950/60 text-red-200'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400'
                      }`}
                    >
                      Eliminated
                    </button>
                  </div>
                </div>

                <label className="block border border-neutral-800 bg-neutral-900/50 p-3">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Kill Limit</span>
                    <span className="text-amber-300">{cfg.killLimit}</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={cfg.killLimit}
                    onChange={(e) => patchCfg({ killLimit: Number(e.target.value) })}
                    className="mt-2 w-full accent-amber-400"
                  />
                </label>
              </div>

              <div className="border border-neutral-800 bg-neutral-900/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                      Lobby Killfeed Policy (Host Override)
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      Overrides every joined player&apos;s killfeed setting while in this event lobby
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        { id: 'player_choice' as const, label: 'Player Choice' },
                        { id: 'force_on' as const, label: 'Force On' },
                        { id: 'force_off' as const, label: 'Force Off' },
                      ]
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => patchCfg({ killfeedPolicy: opt.id })}
                        className={`cursor-pointer whitespace-nowrap border px-2.5 py-1.5 font-mono-tabular text-[11px] ${
                          (cfg.killfeedPolicy ?? 'player_choice') === opt.id
                            ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                            : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            {/* Section 4: AI Bots Tuning */}
            <section className="space-y-4 border-b border-neutral-800/80 pb-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                  4 · Tactical AI Bots
                </div>
                <label className="flex cursor-pointer items-center gap-2 font-mono-tabular text-xs">
                  <input
                    type="checkbox"
                    checked={cfg.botsEnabled}
                    onChange={(e) =>
                      patchCfg({
                        botsEnabled: e.target.checked,
                        botCount: e.target.checked ? Math.max(1, cfg.botCount || 6) : 0,
                      })
                    }
                    className="h-4 w-4 accent-amber-400"
                  />
                  <span className={cfg.botsEnabled ? 'text-neutral-100' : 'text-neutral-500'}>
                    {cfg.botsEnabled ? 'Bots Enabled' : 'Bots OFF (Players Only)'}
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Bot Count</span>
                    <span className="text-amber-300">{cfg.botsEnabled ? cfg.botCount : 0}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    disabled={!cfg.botsEnabled}
                    value={cfg.botsEnabled ? cfg.botCount : 0}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      patchCfg({ botCount: val, botsEnabled: val > 0 });
                    }}
                    className="mt-1.5 w-full accent-amber-400 disabled:opacity-40"
                  />
                </label>

                <div>
                  <div className="font-mono-tabular text-[11px] text-neutral-300">Difficulty</div>
                  <select
                    value={cfg.botDifficulty}
                    onChange={(e) => patchCfg({ botDifficulty: e.target.value as BotDifficultyId })}
                    className="mt-1 w-full border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono-tabular text-xs text-neutral-100"
                  >
                    <option value="recruit">Recruit</option>
                    <option value="tactical">Tactical</option>
                    <option value="veteran">Veteran</option>
                  </select>
                </div>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">AI Health</span>
                    <span className="text-amber-300">{cfg.aiHealth} HP</span>
                  </div>
                  <input
                    type="range"
                    min={25}
                    max={400}
                    step={5}
                    value={cfg.aiHealth}
                    onChange={(e) => patchCfg({ aiHealth: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">AI Accuracy</span>
                    <span className="text-amber-300">{cfg.aiAccuracyMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={2.5}
                    step={0.05}
                    value={cfg.aiAccuracyMult}
                    onChange={(e) => patchCfg({ aiAccuracyMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">AI Move Speed</span>
                    <span className="text-amber-300">{cfg.aiMoveSpeedMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.0}
                    step={0.05}
                    value={cfg.aiMoveSpeedMult}
                    onChange={(e) => patchCfg({ aiMoveSpeedMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-amber-400"
                  />
                </label>
              </div>
            </section>

            {/* Section 5: Infection / Zombie Tuning */}
            <section className="space-y-4">
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-red-400">
                5 · Infection / Zombie Horde Tuning
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Zombie Health</span>
                    <span className="text-red-300">{cfg.zombieHealthMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={4.0}
                    step={0.05}
                    value={cfg.zombieHealthMult}
                    onChange={(e) => patchCfg({ zombieHealthMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-red-500"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Zombie Speed</span>
                    <span className="text-red-300">{cfg.zombieMoveSpeedMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.5}
                    step={0.05}
                    value={cfg.zombieMoveSpeedMult}
                    onChange={(e) => patchCfg({ zombieMoveSpeedMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-red-500"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Attack Speed</span>
                    <span className="text-red-300">{cfg.zombieAttackSpeedMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.5}
                    step={0.05}
                    value={cfg.zombieAttackSpeedMult}
                    onChange={(e) => patchCfg({ zombieAttackSpeedMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-red-500"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Spawn Amount</span>
                    <span className="text-red-300">{cfg.zombieSpawnAmountMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={3.0}
                    step={0.05}
                    value={cfg.zombieSpawnAmountMult}
                    onChange={(e) => patchCfg({ zombieSpawnAmountMult: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-red-500"
                  />
                </label>

                <label className="block">
                  <div className="flex justify-between font-mono-tabular text-[11px]">
                    <span className="text-neutral-300">Wave Break</span>
                    <span className="text-red-300">{cfg.waveBreakIntervalSec}s</span>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={30}
                    step={1}
                    value={cfg.waveBreakIntervalSec}
                    onChange={(e) => patchCfg({ waveBreakIntervalSec: Number(e.target.value) })}
                    className="mt-1.5 w-full accent-red-500"
                  />
                </label>
              </div>
            </section>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-3 border-t border-neutral-800 bg-neutral-950 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer border border-neutral-700 px-5 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="cursor-pointer bg-amber-500 px-6 py-2 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {saving ? 'Saving...' : initialEvent ? 'Save Event Changes' : 'Save Special Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

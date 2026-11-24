import React, { useMemo } from 'react';
import { Radio, Shield, Skull, Users, Wrench, X } from 'lucide-react';
import { useTacticalEquipmentSelection } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import { useLobby } from '../context/LobbyContext';
import { TACTICAL_EQUIPMENT_LIST } from '../data/tacticalEquipment';
import { InfectionMapRecord, SaveManager } from '../engine/persistence/SaveManager';
import { ZOMBIE_MAPS } from '../maps/MapRegistry';
import {
  BotDifficultyId,
  InfectionMatchConfig,
  ZombieDifficultyPresetId,
} from '../maps/types';
import { MapSelector } from '../ui/MapSelector';
import { WeatherTimeControls } from '../ui/WeatherTimeControls';

interface ZombiesOpsModalProps {
  infectionConfig: InfectionMatchConfig;
  onChangeInfectionConfig: (next: InfectionMatchConfig) => void;
  onDeployInfection: (config: InfectionMatchConfig) => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onClose: () => void;
}

const INFECTION_BOT_COUNTS = [0, 1, 2, 3] as const;
const BOT_DIFFICULTIES: ReadonlyArray<{ id: BotDifficultyId; label: string }> = [
  { id: 'recruit', label: 'Recruit' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'veteran', label: 'Veteran' },
];

export const ZOMBIE_DIFFICULTY_PRESETS: ReadonlyArray<{
  id: Exclude<ZombieDifficultyPresetId, 'custom'>;
  label: string;
  desc: string;
  zombieHealthMult: number;
  zombieMoveSpeedMult: number;
  zombieAttackSpeedMult: number;
  zombieSpawnAmountMult: number;
  waveBreakIntervalSec: number;
}> = [
  {
    id: 'standard',
    label: 'Standard',
    desc: 'Baseline quarantine containment curve (1.0x HP, 1.0x speed, 7s intermission).',
    zombieHealthMult: 1.0,
    zombieMoveSpeedMult: 1.0,
    zombieAttackSpeedMult: 1.0,
    zombieSpawnAmountMult: 1.0,
    waveBreakIntervalSec: 7.0,
  },
  {
    id: 'hardcore',
    label: 'Hardcore',
    desc: 'Aggressive sprinters with 1.35x durability, faster strikes, and denser waves.',
    zombieHealthMult: 1.35,
    zombieMoveSpeedMult: 1.18,
    zombieAttackSpeedMult: 1.25,
    zombieSpawnAmountMult: 1.3,
    waveBreakIntervalSec: 5.0,
  },
  {
    id: 'nightmare',
    label: 'Nightmare',
    desc: 'Overwhelming horde surge (1.75x HP, 1.32x speed, 1.55x spawns, 3.5s breaks).',
    zombieHealthMult: 1.75,
    zombieMoveSpeedMult: 1.32,
    zombieAttackSpeedMult: 1.45,
    zombieSpawnAmountMult: 1.55,
    waveBreakIntervalSec: 3.5,
  },
];

/**
 * Grounded Zombies Operations Briefing & Launch Modal opened from the 3D Outpost Map Board or Field Radio.
 * Uses solid matte surfaces (zero backdrop-filter over WebGL), zero static pill badges,
 * zero pulsing dots, and tabular numerals.
 */
export const ZombiesOpsModal: React.FC<ZombiesOpsModalProps> = ({
  infectionConfig,
  onChangeInfectionConfig,
  onDeployInfection,
  onOpenGunsmith,
  onOpenOperatorGear,
  onClose,
}) => {
  const { lobby } = useLobby();
  const { selection: tacticalSelection, setEquipment: setTacticalEquipmentId } =
    useTacticalEquipmentSelection();

  const infectionRecords: Record<string, InfectionMapRecord> = useMemo(() => {
    const sm = new SaveManager();
    return sm.loadInfectionRecords();
  }, []);

  const activePreset: ZombieDifficultyPresetId = infectionConfig.difficultyPreset ?? 'standard';
  const hpMult = infectionConfig.zombieHealthMult ?? 1.0;
  const spdMult = infectionConfig.zombieMoveSpeedMult ?? 1.0;
  const atkMult = infectionConfig.zombieAttackSpeedMult ?? 1.0;
  const spawnMult = infectionConfig.zombieSpawnAmountMult ?? 1.0;
  const breakSec = infectionConfig.waveBreakIntervalSec ?? 7.0;

  const update = (patch: Partial<InfectionMatchConfig>) =>
    onChangeInfectionConfig({ ...infectionConfig, ...patch });

  const applyPreset = (presetId: Exclude<ZombieDifficultyPresetId, 'custom'>) => {
    const p = ZOMBIE_DIFFICULTY_PRESETS.find((x) => x.id === presetId);
    if (!p) return;
    update({
      difficultyPreset: p.id,
      zombieHealthMult: p.zombieHealthMult,
      zombieMoveSpeedMult: p.zombieMoveSpeedMult,
      zombieAttackSpeedMult: p.zombieAttackSpeedMult,
      zombieSpawnAmountMult: p.zombieSpawnAmountMult,
      waveBreakIntervalSec: p.waveBreakIntervalSec,
    });
  };

  const selectedMap = ZOMBIE_MAPS.find((m) => m.id === infectionConfig.mapId) ?? ZOMBIE_MAPS[0];
  const mapRecord = infectionRecords[selectedMap.id];

  const handleDeploy = () => {
    onDeployInfection({
      ...infectionConfig,
      mapId: selectedMap.status === 'playable' ? selectedMap.id : ZOMBIE_MAPS[0].id,
      tacticalEquipmentId: tacticalSelection.equipmentId,
      weatherPreset: infectionConfig.weatherPreset ?? 'auto',
      timeOfDayStart: infectionConfig.timeOfDayStart ?? 'auto',
      difficultyPreset: activePreset,
      zombieHealthMult: hpMult,
      zombieMoveSpeedMult: spdMult,
      zombieAttackSpeedMult: atkMult,
      zombieSpawnAmountMult: spawnMult,
      waveBreakIntervalSec: breakSec,
    });
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#06080b]/88 p-4 sm:p-6">
      <div className="flex h-full max-h-[880px] w-full max-w-[1180px] flex-col border border-white/14 bg-[#0d1015] text-neutral-100 shadow-2xl">
        {/* Header Bar */}
        <header className="flex items-center justify-between gap-4 border-b border-white/10 bg-[#11151c] px-6 py-3.5">
          <div className="flex items-center gap-3">
            <Skull className="h-5 w-5 text-red-500" />
            <div className="flex flex-col">
              <span className="font-display text-lg font-bold tracking-wider text-neutral-50">
                Zombies Operations Briefing
              </span>
              <span className="font-mono-tabular text-xs text-neutral-400">
                Fortified Quarantine Outpost · Dispatch Terminal
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenGunsmith}
              className="flex cursor-pointer items-center gap-1.5 border border-white/12 bg-[#161b23] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60 hover:text-white whitespace-nowrap"
            >
              <Wrench className="h-3.5 w-3.5 text-amber-400" />
              <span>Gunsmith</span>
            </button>
            <button
              type="button"
              onClick={onOpenOperatorGear}
              className="flex cursor-pointer items-center gap-1.5 border border-white/12 bg-[#161b23] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60 hover:text-white whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5 text-amber-400" />
              <span>Operator Gear</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-1.5 border border-white/14 bg-[#171c24] px-3.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-red-500/60 hover:text-white whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close Board</span>
            </button>
          </div>
        </header>

        {/* Squad Status Strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/8 bg-[#0a0d11] px-6 py-2.5 text-xs font-mono-tabular">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-neutral-300">
            <Radio className="h-3.5 w-3.5 text-red-400" />
            <span className="text-neutral-500">SECTOR</span>
            <span className="font-semibold text-neutral-100">{selectedMap.name}</span>
            <span className="text-neutral-600" aria-hidden="true">
              ·
            </span>
            <span className="text-neutral-400">
              Best Round: <strong className="text-neutral-100">{mapRecord?.highestRound ?? 0}</strong>
            </span>
            <span className="text-neutral-600" aria-hidden="true">
              ·
            </span>
            <span className="text-neutral-400">
              Best Kills: <strong className="text-neutral-100">{mapRecord?.bestKills ?? 0}</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 text-neutral-300">
            <Users className="h-3.5 w-3.5 text-amber-400" />
            {lobby ? (
              <span>
                Squad {lobby.code} · {lobby.members.length}/{lobby.maxPlayers} Operators Ready
              </span>
            ) : (
              <span>
                Solo Operator + {infectionConfig.botCount ?? 0} Allied AI
              </span>
            )}
          </div>
        </div>

        {/* Scrollable Two-Column Configuration Body */}
        <div className="grid flex-1 grid-cols-1 gap-6 overflow-y-auto p-6 lg:grid-cols-12">
          {/* Left 7 cols: Map Selection & Environmental Conditions */}
          <div className="flex flex-col gap-5 lg:col-span-7">
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-neutral-200">
                  Quarantine Sector Selection
                </h2>
                <span className="font-mono-tabular text-xs text-neutral-500">
                  {ZOMBIE_MAPS.filter((m) => m.status === 'playable').length} Active ·{' '}
                  {ZOMBIE_MAPS.length} Mapped
                </span>
              </div>
              <MapSelector
                maps={ZOMBIE_MAPS}
                selectedMapId={infectionConfig.mapId}
                onSelectMap={(mapId) => update({ mapId })}
                theme="infection"
                infectionRecords={infectionRecords}
              />
            </section>

            <section className="flex flex-col gap-3 border-t border-white/8 pt-4">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-neutral-200">
                Weather &amp; Time of Day
              </h2>
              <WeatherTimeControls
                mapId={infectionConfig.mapId}
                accent="red"
                weatherPreset={infectionConfig.weatherPreset ?? 'auto'}
                timeOfDayStart={infectionConfig.timeOfDayStart ?? 'auto'}
                onChangeWeather={(weatherPreset) => update({ weatherPreset })}
                onChangeTimeOfDay={(timeOfDayStart) => update({ timeOfDayStart })}
              />
            </section>
          </div>

          {/* Right 5 cols: Difficulty Presets, Round Modifiers, Allied AI & Starter Ordnance */}
          <div className="flex flex-col gap-5 lg:col-span-5">
            {/* Difficulty Presets */}
            <section className="flex flex-col gap-2.5 border border-white/10 bg-[#11151c] p-4">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-neutral-200">
                Threat Difficulty
              </h2>
              <div className="grid grid-cols-3 gap-1.5">
                {ZOMBIE_DIFFICULTY_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyPreset(p.id)}
                    className={`cursor-pointer border px-2.5 py-2 text-xs font-semibold transition-colors ${
                      activePreset === p.id
                        ? 'border-red-500 bg-red-600/22 text-red-100'
                        : 'border-white/10 bg-[#161b23] text-neutral-300 hover:border-white/25 hover:text-white'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-neutral-400">
                {ZOMBIE_DIFFICULTY_PRESETS.find((p) => p.id === activePreset)?.desc ??
                  'Custom round tuning modifiers active.'}
              </p>
            </section>

            {/* Fine-Tuned Round Modifiers */}
            <section className="flex flex-col gap-3 border border-white/10 bg-[#11151c] p-4">
              <div className="flex items-baseline justify-between">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-neutral-200">
                  Round Modifiers
                </h2>
                <span className="font-mono-tabular text-[11px] uppercase text-amber-400">
                  {activePreset}
                </span>
              </div>

              <div className="flex flex-col gap-2.5 text-xs">
                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular text-neutral-300">
                    <span>Infected Health</span>
                    <span>{hpMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.5}
                    max={2.5}
                    step={0.05}
                    value={hpMult}
                    onChange={(e) =>
                      update({
                        difficultyPreset: 'custom',
                        zombieHealthMult: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-red-500"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular text-neutral-300">
                    <span>Movement Speed</span>
                    <span>{spdMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.65}
                    max={1.6}
                    step={0.05}
                    value={spdMult}
                    onChange={(e) =>
                      update({
                        difficultyPreset: 'custom',
                        zombieMoveSpeedMult: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-red-500"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular text-neutral-300">
                    <span>Attack Cadence</span>
                    <span>{atkMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.7}
                    max={1.8}
                    step={0.05}
                    value={atkMult}
                    onChange={(e) =>
                      update({
                        difficultyPreset: 'custom',
                        zombieAttackSpeedMult: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-red-500"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular text-neutral-300">
                    <span>Wave Horde Density</span>
                    <span>{spawnMult.toFixed(2)}x</span>
                  </div>
                  <input
                    type="range"
                    min={0.6}
                    max={2.0}
                    step={0.05}
                    value={spawnMult}
                    onChange={(e) =>
                      update({
                        difficultyPreset: 'custom',
                        zombieSpawnAmountMult: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-red-500"
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <div className="flex justify-between font-mono-tabular text-neutral-300">
                    <span>Wave Break Timer</span>
                    <span>{breakSec.toFixed(1)}s</span>
                  </div>
                  <input
                    type="range"
                    min={2.5}
                    max={15.0}
                    step={0.5}
                    value={breakSec}
                    onChange={(e) =>
                      update({
                        difficultyPreset: 'custom',
                        waveBreakIntervalSec: parseFloat(e.target.value),
                      })
                    }
                    className="w-full accent-red-500"
                  />
                </label>
              </div>
            </section>

            {/* Allied AI Fireteam & Tactical Ordnance */}
            <section className="flex flex-col gap-3 border border-white/10 bg-[#11151c] p-4">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-neutral-200">
                Allied AI Support &amp; Ordnance
              </h2>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-neutral-400">Friendly AI Operators</span>
                <div className="grid grid-cols-4 gap-1.5">
                  {INFECTION_BOT_COUNTS.map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => update({ botCount: cnt })}
                      className={`cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                        (infectionConfig.botCount ?? 0) === cnt
                          ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                          : 'border-white/10 bg-[#161b23] text-neutral-300 hover:border-white/25'
                      }`}
                    >
                      {cnt === 0 ? 'Solo' : `+${cnt} AI`}
                    </button>
                  ))}
                </div>
              </div>

              {(infectionConfig.botCount ?? 0) > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-neutral-400">AI Skill Level</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {BOT_DIFFICULTIES.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => update({ botDifficulty: d.id })}
                        className={`cursor-pointer border py-1.5 text-xs font-medium transition-colors ${
                          (infectionConfig.botDifficulty ?? 'tactical') === d.id
                            ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                            : 'border-white/10 bg-[#161b23] text-neutral-300 hover:border-white/25'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-neutral-400">Starting Tactical Equipment</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {TACTICAL_EQUIPMENT_LIST.map((eq) => (
                    <button
                      key={eq.id}
                      type="button"
                      onClick={() => setTacticalEquipmentId(eq.id)}
                      className={`cursor-pointer border px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                        tacticalSelection.equipmentId === eq.id
                          ? 'border-amber-400 bg-amber-500/20 text-amber-100'
                          : 'border-white/10 bg-[#161b23] text-neutral-300 hover:border-white/25'
                      }`}
                    >
                      {eq.shortName}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Footer Launch Action */}
        <footer className="flex items-center justify-between gap-4 border-t border-white/10 bg-[#11151c] px-6 py-4">
          <div className="flex flex-col text-xs text-neutral-400">
            <span>
              Selected Sector:{' '}
              <strong className="text-neutral-100">{selectedMap.name}</strong>
            </span>
            <span className="font-mono-tabular text-[11px] text-neutral-500">
              HP {hpMult.toFixed(2)}x · Speed {spdMult.toFixed(2)}x · Attack {atkMult.toFixed(2)}x ·
              Spawns {spawnMult.toFixed(2)}x
            </span>
          </div>
          <button
            type="button"
            disabled={selectedMap.status !== 'playable'}
            onClick={handleDeploy}
            className="flex cursor-pointer items-center gap-2 border border-red-500 bg-red-600 px-6 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Skull className="h-4 w-4" />
            <span>Deploy to Quarantine Zone</span>
          </button>
        </footer>
      </div>
    </div>
  );
};

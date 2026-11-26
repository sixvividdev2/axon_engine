import React, { useMemo, useState } from 'react';
import {
  Crosshair,
  Lock,
  Radio,
  Shield,
  Target,
  User,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { GYM_ARMORY_WEAPONS, SDK_WEAPON_PROFILES } from '../bodycam-sdk';
import { useTacticalEquipmentSelection } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import { useOperatorSelection } from '../bodycam-sdk/operator/OperatorSelectionStore';
import { OPERATOR_PROFILES } from '../bodycam-sdk/operator/OperatorTypes';
import { useAuth } from '../context/AuthContext';
import { useLobby } from '../context/LobbyContext';
import { useLoadoutStore } from '../data/loadoutStore';
import { formatRankLabel, getWeaponUnlockRank } from '../data/progression';
import { TACTICAL_EQUIPMENT_LIST, TacticalEquipmentId } from '../data/tacticalEquipment';
import { BATTLE_MAPS } from '../maps/MapRegistry';
import {
  BattleMatchConfig,
  BattleRuleId,
  BotDifficultyId,
  getDefaultScoreLimitForRule,
} from '../maps/types';
import { MapSelector } from '../ui/MapSelector';
import { MultiplayerHubPanel } from '../ui/MultiplayerHubPanel';
import { WeatherTimeControls } from '../ui/WeatherTimeControls';

export type OpsLaptopTabId = 'battle' | 'multiplayer' | 'gym';

export const OPS_LAPTOP_TABS: readonly OpsLaptopTabId[] = ['battle', 'multiplayer', 'gym'] as const;

interface HideoutOpsLaptopModalProps {
  initialTab: OpsLaptopTabId;
  battleConfig: BattleMatchConfig;
  onChangeBattleConfig: (next: BattleMatchConfig) => void;
  onDeployBattle: (config: BattleMatchConfig) => void;
  onLaunchPlayground: () => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onClose: () => void;
}

const BOT_COUNTS = [4, 6, 8, 10] as const;
const BATTLE_MODE_OPTIONS: ReadonlyArray<{ id: BattleRuleId; short: string; name: string }> = [
  { id: 'tdm', short: 'TDM', name: 'Team Deathmatch' },
  { id: 'ffa', short: 'FFA', name: 'Free-For-All' },
  { id: 'conquest', short: 'Conquest', name: 'Territory Control' },
  { id: 'ctf', short: 'CTF', name: 'Capture the Flag' },
  { id: 'koth', short: 'KOTH', name: 'King of the Hill' },
  { id: 'kc_tdm', short: 'KC · TDM', name: 'Kill Confirmed Team' },
  { id: 'kc_ffa', short: 'KC · FFA', name: 'Kill Confirmed FFA' },
];
const DIFFICULTIES: ReadonlyArray<{ id: BotDifficultyId; label: string }> = [
  { id: 'recruit', label: 'Recruit' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'veteran', label: 'Veteran' },
];

function getScoreLimitPresets(rule: BattleRuleId): { label: string; values: readonly number[] } {
  switch (rule) {
    case 'conquest':
      return { label: 'Territory Target', values: [300, 500, 750, 1000] };
    case 'ctf':
      return { label: 'Flag Captures', values: [3, 5, 7, 10] };
    case 'koth':
      return { label: 'Hill Score', values: [120, 180, 250, 350] };
    case 'kc_tdm':
    case 'kc_ffa':
      return { label: 'Tag Limit', values: [20, 30, 40, 50] };
    default:
      return { label: 'Kill Limit', values: [20, 30, 40, 50] };
  }
}

function getBattleRuleSummary(rule: BattleRuleId): string {
  switch (rule) {
    case 'conquest':
      return 'Conquest · Most Territory Controlled Wins · Protected HQs · Helicopter Insertion';
    case 'ctf':
      return 'Capture the Flag · Home Flag Required to Score · Carrier Drop & Teammate Return';
    case 'koth':
      return 'King of the Hill · Rotating Hills (45s) · Uncontested Control Scores';
    case 'kc_tdm':
      return 'Kill Confirmed TDM · Most Enemy Dogtags Wins · Friendly Dogtags Tracked Separately';
    case 'kc_ffa':
      return 'Kill Confirmed FFA · Most Enemy Dogtags Wins · Recover Own Tag for Bonus XP';
    case 'ffa':
      return 'Free-For-All · Every Operator Hostile · Spawn Protection Active';
    case 'tdm':
    default:
      return 'Team A vs Team B · Friendly Fire Off · Helicopter Insertion';
  }
}

/**
 * Diegetic Ready Room Ops Command Laptop Terminal.
 * Dedicated to Combat Ops, Squads & Multiplayer Lobbies, and the standalone Calibration Gym / Playground.
 * Perimeter Operations has its own dedicated Ready Room laptop and North Wing;
 * Infection is staged physically via the Sector 4 Infection Airlock and 3D Infection Outpost.
 */
export const HideoutOpsLaptopModal: React.FC<HideoutOpsLaptopModalProps> = ({
  initialTab,
  battleConfig,
  onChangeBattleConfig,
  onDeployBattle,
  onLaunchPlayground,
  onOpenGunsmith,
  onOpenOperatorGear,
  onClose,
}) => {
  const { user, effectiveRank, openAuthModal, isWeaponUnlocked } = useAuth();
  const { lobby } = useLobby();
  const [selectedOperatorId] = useOperatorSelection();
  const { selection: tacticalSelection, setEquipment: setTacticalEquipmentId } =
    useTacticalEquipmentSelection();
  const loadoutState = useLoadoutStore();
  const activeLoadout = loadoutState.slots[loadoutState.activeIndex] ?? loadoutState.slots[0];

  const [activeTab, setActiveTab] = useState<OpsLaptopTabId>(
    initialTab === 'gym' ? 'gym' : lobby ? 'multiplayer' : initialTab,
  );

  const primaryWeapons = useMemo(
    () => [
      ...GYM_ARMORY_WEAPONS.filter(
        (w) =>
          w.category === 'carbines' ||
          w.category === 'pdws' ||
          w.category === 'shotguns' ||
          w.category === 'dmrs' ||
          w.category === 'bolt_action',
      ),
      SDK_WEAPON_PROFILES.akm_762,
    ],
    [],
  );

  const sidearmWeapons = useMemo(
    () => GYM_ARMORY_WEAPONS.filter((w) => w.category === 'pistols' || w.category === 'revolvers'),
    [],
  );

  const operatorProfile = OPERATOR_PROFILES[selectedOperatorId];
  const updateBattle = (patch: Partial<BattleMatchConfig>) =>
    onChangeBattleConfig({ ...battleConfig, ...patch });

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#06080b]/88 p-4 sm:p-6">
      <div className="flex h-full max-h-[880px] w-full max-w-[1220px] flex-col border border-white/14 bg-[#0d1015] text-neutral-100 shadow-2xl">
        {/* Clean 3-Zone Top Bar */}
        <header className="flex items-center justify-between gap-6 border-b border-white/10 bg-[#11151c] px-6 py-3.5">
          <span className="font-display text-lg font-bold tracking-wider text-neutral-50 whitespace-nowrap shrink-0">
            Ops Command Terminal
          </span>

          <nav className="flex items-center gap-1.5" aria-label="Operations Mode">
            <button
              type="button"
              onClick={() => setActiveTab('battle')}
              className={`flex cursor-pointer items-center gap-2 border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'battle'
                  ? 'border-amber-400 bg-amber-500/18 text-amber-200'
                  : 'border-white/10 bg-[#151a22] text-neutral-400 hover:border-white/25 hover:text-neutral-100'
              }`}
            >
              <Crosshair className="h-3.5 w-3.5" />
              <span>Combat Ops</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('multiplayer')}
              className={`flex cursor-pointer items-center gap-2 border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'multiplayer'
                  ? 'border-sky-400 bg-sky-500/18 text-sky-200'
                  : 'border-white/10 bg-[#151a22] text-neutral-400 hover:border-white/25 hover:text-neutral-100'
              }`}
            >
              <Users className="h-3.5 w-3.5" />
              <span>Squads &amp; Lobbies</span>
              {!user && <Lock className="h-3 w-3 text-amber-400" />}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('gym')}
              className={`flex cursor-pointer items-center gap-2 border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'gym'
                  ? 'border-amber-400 bg-amber-500/18 text-amber-100'
                  : 'border-white/10 bg-[#151a22] text-neutral-400 hover:border-white/25 hover:text-neutral-100'
              }`}
            >
              <Target className="h-3.5 w-3.5" />
              <span>Calibration Gym &amp; Playground</span>
            </button>
          </nav>

          <button
            type="button"
            onClick={onClose}
            className="flex cursor-pointer items-center gap-2 border border-white/14 bg-[#171c24] px-3.5 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/60 hover:text-white whitespace-nowrap shrink-0"
          >
            <X className="h-3.5 w-3.5" />
            <span>Close Terminal</span>
          </button>
        </header>

        {/* Quiet Unboxed Operator & Kit Readiness Strip */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/8 bg-[#0b0e13] px-6 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono-tabular text-neutral-300">
            <span className="text-neutral-500">Operator</span>
            <span className="font-semibold text-neutral-100">{operatorProfile.label}</span>
            <span className="text-neutral-600" aria-hidden="true">
              ·
            </span>
            <span>{formatRankLabel(effectiveRank, user?.prestige ?? 0)}</span>
            <span className="text-neutral-600" aria-hidden="true">
              ·
            </span>
            <span className="text-neutral-400">Loadout {activeLoadout.name}</span>
            {lobby && (
              <>
                <span className="text-neutral-600" aria-hidden="true">
                  ·
                </span>
                <span className="font-semibold text-sky-300">
                  Squad Lobby {lobby.code} ({lobby.members.length}/{lobby.maxPlayers})
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenGunsmith}
              className="flex cursor-pointer items-center gap-1.5 border border-white/10 bg-[#141921] px-2.5 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-amber-500/50 hover:text-amber-200 whitespace-nowrap"
            >
              <Wrench className="h-3 w-3 text-amber-400" />
              <span>Gunsmith</span>
            </button>
            <button
              type="button"
              onClick={onOpenOperatorGear}
              className="flex cursor-pointer items-center gap-1.5 border border-white/10 bg-[#141921] px-2.5 py-1 text-[11px] font-medium text-neutral-300 transition-colors hover:border-amber-500/50 hover:text-amber-200 whitespace-nowrap"
            >
              <Shield className="h-3 w-3 text-amber-400" />
              <span>Operator Gear</span>
            </button>
          </div>
        </div>

        {/* Terminal Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeTab === 'battle' && (
            <div className="flex flex-col gap-5">
              {/* Top Row: Heading + Rule Selector */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-wide text-neutral-50">
                    Solo Tactical Deployment
                  </h2>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    Changes sync live to the Ready Room briefing wall, laptop display, and telemetry
                    monitors.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {BATTLE_MODE_OPTIONS.map((r) => {
                    const active = battleConfig.rule === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          const defLimit = getDefaultScoreLimitForRule(r.id);
                          updateBattle({
                            rule: r.id,
                            scoreLimit: defLimit,
                            killLimit:
                              r.id === 'tdm' || r.id === 'ffa' || r.id === 'kc_tdm' || r.id === 'kc_ffa'
                                ? defLimit
                                : battleConfig.killLimit,
                          });
                        }}
                        title={r.name}
                        className={`cursor-pointer border px-3 py-2 font-mono-tabular text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          active
                            ? 'border-amber-400 bg-amber-500 text-neutral-950'
                            : 'border-white/12 bg-[#141820] text-neutral-300 hover:border-white/30'
                        }`}
                      >
                        {r.short}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Match Parameters & Active Kit Strip */}
              <div className="grid grid-cols-1 gap-3 border border-white/10 bg-[#11151b] p-4 md:grid-cols-6">
                <div>
                  <div className="font-mono-tabular text-[11px] text-neutral-400">Combatants</div>
                  <div className="mt-1.5 flex gap-1">
                    {BOT_COUNTS.map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => updateBattle({ botCount: cnt })}
                        className={`flex-1 cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                          battleConfig.botCount === cnt
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-white/10 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {cnt}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  {(() => {
                    const preset = getScoreLimitPresets(battleConfig.rule);
                    const activeVal =
                      battleConfig.scoreLimit ??
                      (battleConfig.rule === 'tdm' ||
                      battleConfig.rule === 'ffa' ||
                      battleConfig.rule === 'kc_tdm' ||
                      battleConfig.rule === 'kc_ffa'
                        ? battleConfig.killLimit
                        : getDefaultScoreLimitForRule(battleConfig.rule));
                    return (
                      <>
                        <div className="font-mono-tabular text-[11px] text-neutral-400">
                          {preset.label}
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          {preset.values.map((lim) => (
                            <button
                              key={lim}
                              type="button"
                              onClick={() =>
                                updateBattle({
                                  scoreLimit: lim,
                                  killLimit:
                                    battleConfig.rule === 'tdm' ||
                                    battleConfig.rule === 'ffa' ||
                                    battleConfig.rule === 'kc_tdm' ||
                                    battleConfig.rule === 'kc_ffa'
                                      ? lim
                                      : battleConfig.killLimit,
                                })
                              }
                              className={`flex-1 cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                                activeVal === lim
                                  ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                                  : 'border-white/10 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                              }`}
                            >
                              {lim}
                            </button>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div>
                  <div className="font-mono-tabular text-[11px] text-neutral-400">AI Difficulty</div>
                  <div className="mt-1.5 flex gap-1">
                    {DIFFICULTIES.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => updateBattle({ difficulty: d.id })}
                        className={`flex-1 cursor-pointer border px-1.5 py-1.5 font-mono-tabular text-[11px] font-semibold transition-colors whitespace-nowrap ${
                          battleConfig.difficulty === d.id
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-white/10 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="ops-primary-select"
                    className="block font-mono-tabular text-[11px] text-neutral-400"
                  >
                    Primary Weapon
                  </label>
                  <select
                    id="ops-primary-select"
                    value={battleConfig.primaryWeaponId}
                    onChange={(e) => {
                      if (isWeaponUnlocked(e.target.value)) {
                        updateBattle({ primaryWeaponId: e.target.value });
                      }
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-white/12 bg-[#161b23] px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
                  >
                    {primaryWeapons.map((w) => {
                      const unlocked = isWeaponUnlocked(w.id);
                      const reqRank = getWeaponUnlockRank(w.id);
                      return (
                        <option key={w.id} value={w.id} disabled={!unlocked}>
                          {unlocked ? w.name : `${w.name} [Rank ${reqRank}]`}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="ops-sidearm-select"
                    className="block font-mono-tabular text-[11px] text-neutral-400"
                  >
                    Sidearm
                  </label>
                  <select
                    id="ops-sidearm-select"
                    value={battleConfig.secondaryWeaponId}
                    onChange={(e) => {
                      if (isWeaponUnlocked(e.target.value)) {
                        updateBattle({ secondaryWeaponId: e.target.value });
                      }
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-white/12 bg-[#161b23] px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
                  >
                    {sidearmWeapons.map((w) => {
                      const unlocked = isWeaponUnlocked(w.id);
                      const reqRank = getWeaponUnlockRank(w.id);
                      return (
                        <option key={w.id} value={w.id} disabled={!unlocked}>
                          {unlocked ? w.name : `${w.name} [Rank ${reqRank}]`}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="ops-grenade-select"
                    className="block font-mono-tabular text-[11px] text-amber-300"
                  >
                    Belt Ordnance
                  </label>
                  <select
                    id="ops-grenade-select"
                    value={tacticalSelection.equipmentId}
                    onChange={(e) => {
                      const nextId = e.target.value as TacticalEquipmentId;
                      setTacticalEquipmentId(nextId);
                      updateBattle({ tacticalEquipmentId: nextId });
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-white/12 bg-[#161b23] px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
                  >
                    {TACTICAL_EQUIPMENT_LIST.map((eq) => (
                      <option key={eq.id} value={eq.id}>
                        {eq.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Combat Sector Selection */}
              <div>
                <div className="mb-2 text-xs font-medium text-neutral-400">Combat Sector</div>
                <MapSelector
                  maps={BATTLE_MAPS}
                  selectedMapId={battleConfig.mapId}
                  onSelectMap={(mapId) => updateBattle({ mapId })}
                  theme="tactical"
                />
              </div>

              {/* Weather & 5x Dynamic Time of Day */}
              <WeatherTimeControls
                mapId={battleConfig.mapId}
                weatherPreset={battleConfig.weatherPreset ?? 'auto'}
                timeOfDayStart={battleConfig.timeOfDayStart ?? 'auto'}
                accent="amber"
                onChangeWeather={(weatherPreset) => updateBattle({ weatherPreset })}
                onChangeTimeOfDay={(timeOfDayStart) => updateBattle({ timeOfDayStart })}
              />

              {/* Host Match Rules: Hitmarkers & Combat HUD */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-white/10 bg-[#11151b] px-4 py-3">
                <div>
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                    Match Rules · HUD &amp; Hitmarkers
                  </div>
                  <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                    Choose whether Battle matches run with Hitmarkers and Combat HUD enabled
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      updateBattle({ hitmarkersEnabled: battleConfig.hitmarkersEnabled === false })
                    }
                    className={`cursor-pointer whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors ${
                      battleConfig.hitmarkersEnabled !== false
                        ? 'border-emerald-500/70 bg-emerald-950/45 text-emerald-300'
                        : 'border-white/12 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    Hitmarkers: {battleConfig.hitmarkersEnabled !== false ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateBattle({ hudEnabled: battleConfig.hudEnabled === false })
                    }
                    className={`cursor-pointer whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors ${
                      battleConfig.hudEnabled !== false
                        ? 'border-emerald-500/70 bg-emerald-950/45 text-emerald-300'
                        : 'border-white/12 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    Combat HUD: {battleConfig.hudEnabled !== false ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>

              {/* Deploy Footer */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4">
                <div className="font-mono-tabular text-xs text-neutral-400">
                  {getBattleRuleSummary(battleConfig.rule)}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onDeployBattle({
                      ...battleConfig,
                      tacticalEquipmentId: tacticalSelection.equipmentId,
                      weatherPreset: battleConfig.weatherPreset ?? 'auto',
                      timeOfDayStart: battleConfig.timeOfDayStart ?? 'auto',
                      hitmarkersEnabled: battleConfig.hitmarkersEnabled !== false,
                      hudEnabled: battleConfig.hudEnabled !== false,
                    })
                  }
                  className="cursor-pointer bg-amber-500 px-8 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap shrink-0"
                >
                  Deploy Match
                </button>
              </div>
            </div>
          )}

          {activeTab === 'multiplayer' && (
            <div className="flex flex-col gap-4">
              {user ? (
                <MultiplayerHubPanel onOpenLoadoutWorkbench={onOpenGunsmith} />
              ) : (
                <div className="mx-auto my-12 flex max-w-lg flex-col items-center border border-white/10 bg-[#11151c] p-8 text-center">
                  <Radio className="h-8 w-8 text-sky-400" />
                  <h3 className="mt-3 font-display text-xl font-bold text-neutral-50">
                    Sign In for Squads &amp; Multiplayer Lobbies
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-neutral-400">
                    Host private or public lobbies, join friends by room code, and run custom
                    Special Events directly from your Ready Room laptop. Solo Combat Ops,
                    Perimeter Ops, and Infection remain playable offline.
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      openAuthModal(
                        'Sign in to access Multiplayer Lobbies, Special Events, and Friend Squads.',
                      )
                    }
                    className="mt-5 flex cursor-pointer items-center gap-2 bg-amber-500 px-6 py-2.5 text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap"
                  >
                    <User className="h-3.5 w-3.5" />
                    <span>Sign In</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'gym' && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-wide text-amber-50">
                    Calibration Gym &amp; Playground
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-neutral-400">
                    Standalone live-fire testing range for weapon ballistics, PiP optics tuning,
                    bodycam camera kinematics, tactical grenades, destructible barriers, and
                    third-person rig calibration. Also accessible on foot through the transit door
                    in the Gun Range foyer.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onLaunchPlayground}
                  className="cursor-pointer bg-amber-500 px-8 py-3 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap shrink-0"
                >
                  Launch Calibration Gym
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="border border-white/10 bg-[#11151b] p-5">
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                    Station 01 · Ballistics &amp; Optics
                  </div>
                  <div className="mt-2 font-display text-lg font-bold text-neutral-50">
                    Full Armory &amp; Live PiP Scopes
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
                    Swap across all unlocked and experimental firearms, test recoil impulse, zero
                    long-range optics, and inspect ballistic penetration on steel, timber, and
                    concrete lanes.
                  </p>
                </div>

                <div className="border border-white/10 bg-[#11151b] p-5">
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-sky-300">
                    Station 02 · Bodycam &amp; Rig Tuner
                  </div>
                  <div className="mt-2 font-display text-lg font-bold text-neutral-50">
                    Real-Time Kinematics Sandbox
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
                    Tune headbob damping, chest-cam FOV, vault clearances, secondary gear physics,
                    and live lens distortion with instant visual feedback.
                  </p>
                </div>

                <div className="border border-white/10 bg-[#11151b] p-5">
                  <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
                    Station 03 · Ordnance &amp; Movement
                  </div>
                  <div className="mt-2 font-display text-lg font-bold text-neutral-50">
                    Grenade Pit &amp; Parkour Course
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
                    Practice grenade cooking, smoke screening, flashbang breaches, backpack drops,
                    and timed obstacle climbs with unlimited resupply.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 border border-amber-500/25 bg-[#12100c] px-5 py-4">
                <div className="text-xs text-neutral-300">
                  Looking for <span className="font-semibold text-red-300">Infection</span>? Walk
                  South through the <span className="font-semibold text-neutral-100">Sector 4 Infection Airlock</span>{' '}
                  to board the APC escort to the 3D Infection Outpost.
                </div>
                <div className="font-mono-tabular text-[11px] text-neutral-500">
                  Direct Access: Gun Range North Foyer Transit Door
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

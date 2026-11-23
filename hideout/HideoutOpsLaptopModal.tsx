import React, { useMemo, useState } from 'react';
import {
  Crosshair,
  Lock,
  Radio,
  Shield,
  Skull,
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
import { InfectionMapRecord, SaveManager } from '../engine/persistence/SaveManager';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import {
  BattleMatchConfig,
  BattleRuleId,
  BotDifficultyId,
  InfectionMatchConfig,
} from '../maps/types';
import { MapSelector } from '../ui/MapSelector';
import { MultiplayerHubPanel } from '../ui/MultiplayerHubPanel';
import { WeatherTimeControls } from '../ui/WeatherTimeControls';

export type OpsLaptopTabId = 'battle' | 'multiplayer' | 'infection';

interface HideoutOpsLaptopModalProps {
  initialTab: OpsLaptopTabId;
  battleConfig: BattleMatchConfig;
  infectionConfig: InfectionMatchConfig;
  onChangeBattleConfig: (next: BattleMatchConfig) => void;
  onChangeInfectionConfig: (next: InfectionMatchConfig) => void;
  onDeployBattle: (config: BattleMatchConfig) => void;
  onDeployInfection: (config: InfectionMatchConfig) => void;
  onLaunchPlayground: () => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onClose: () => void;
}

const BOT_COUNTS = [4, 6, 8, 10] as const;
const INFECTION_BOT_COUNTS = [0, 1, 2, 3] as const;
const KILL_LIMITS = [20, 30, 40, 50] as const;
const DIFFICULTIES: ReadonlyArray<{ id: BotDifficultyId; label: string }> = [
  { id: 'recruit', label: 'Recruit' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'veteran', label: 'Veteran' },
];

/**
 * Diegetic Ready Room Ops Command Laptop Terminal.
 * Uses solid matte surfaces (zero backdrop-filter over WebGL), zero static pill badges,
 * zero pulsing dots, and tabular numerals. Fully wired to Battle, Infection, and Multiplayer.
 */
export const HideoutOpsLaptopModal: React.FC<HideoutOpsLaptopModalProps> = ({
  initialTab,
  battleConfig,
  infectionConfig,
  onChangeBattleConfig,
  onChangeInfectionConfig,
  onDeployBattle,
  onDeployInfection,
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

  const [activeTab, setActiveTab] = useState<OpsLaptopTabId>(lobby ? 'multiplayer' : initialTab);

  const infectionRecords: Record<string, InfectionMapRecord> = useMemo(() => {
    const sm = new SaveManager();
    return sm.loadInfectionRecords();
  }, []);

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
  const updateInfection = (patch: Partial<InfectionMatchConfig>) =>
    onChangeInfectionConfig({ ...infectionConfig, ...patch });

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
              onClick={() => setActiveTab('infection')}
              className={`flex cursor-pointer items-center gap-2 border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'infection'
                  ? 'border-red-500 bg-red-600/20 text-red-100'
                  : 'border-white/10 bg-[#151a22] text-neutral-400 hover:border-white/25 hover:text-neutral-100'
              }`}
            >
              <Skull className="h-3.5 w-3.5" />
              <span>Containment &amp; Gym</span>
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
              {/* Top Row: Heading + TDM/FFA Selector */}
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

                <div className="flex items-center gap-1.5">
                  {(
                    [
                      { id: 'tdm' as BattleRuleId, label: 'TDM · Team Deathmatch' },
                      { id: 'ffa' as BattleRuleId, label: 'FFA · Free-For-All' },
                    ]
                  ).map((r) => {
                    const active = battleConfig.rule === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => updateBattle({ rule: r.id })}
                        className={`cursor-pointer border px-4 py-2 font-mono-tabular text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          active
                            ? 'border-amber-400 bg-amber-500 text-neutral-950'
                            : 'border-white/12 bg-[#141820] text-neutral-300 hover:border-white/30'
                        }`}
                      >
                        {r.label}
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
                  <div className="font-mono-tabular text-[11px] text-neutral-400">Kill Limit</div>
                  <div className="mt-1.5 flex gap-1">
                    {KILL_LIMITS.map((lim) => (
                      <button
                        key={lim}
                        type="button"
                        onClick={() => updateBattle({ killLimit: lim })}
                        className={`flex-1 cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                          battleConfig.killLimit === lim
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-white/10 bg-[#161b23] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {lim}
                      </button>
                    ))}
                  </div>
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

              {/* Deploy Footer */}
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4">
                <div className="font-mono-tabular text-xs text-neutral-400">
                  {battleConfig.rule === 'tdm'
                    ? 'Team A vs Team B · Friendly Fire Off'
                    : 'Free-For-All · Every Operator Hostile'}{' '}
                  · Gunsmith Attachments Synced
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onDeployBattle({
                      ...battleConfig,
                      tacticalEquipmentId: tacticalSelection.equipmentId,
                      weatherPreset: battleConfig.weatherPreset ?? 'auto',
                      timeOfDayStart: battleConfig.timeOfDayStart ?? 'auto',
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
                    Special Events directly from your Ready Room laptop. Solo Combat Ops and
                    Containment remain playable offline.
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

          {activeTab === 'infection' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-wide text-red-50">
                    Containment Ops &amp; Calibration Facility
                  </h2>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    Deploy straight into round-based Infection survival or open the standalone
                    Calibration Playground.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onLaunchPlayground}
                  className="cursor-pointer border border-white/14 bg-[#151a22] px-4 py-2 text-xs font-semibold text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap shrink-0"
                >
                  Open Calibration Playground
                </button>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium text-red-300/85">Containment Site</div>
                <MapSelector
                  maps={ZOMBIE_MAPS}
                  selectedMapId={infectionConfig.mapId}
                  onSelectMap={(mapId) => updateInfection({ mapId })}
                  theme="infection"
                  infectionRecords={infectionRecords}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 border border-red-950/70 bg-[#120e10] p-4 md:grid-cols-12">
                <div className="md:col-span-5">
                  <div className="text-xs font-semibold text-sky-300">
                    Friendly AI Squadmates (0–3)
                  </div>
                  <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                    Allied operators filling your 4-man containment squad
                  </div>
                </div>
                <div className="flex items-center gap-1.5 md:col-span-4">
                  {INFECTION_BOT_COUNTS.map((cnt) => {
                    const active = (infectionConfig.botCount ?? 0) === cnt;
                    return (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => updateInfection({ botCount: cnt })}
                        className={`flex-1 cursor-pointer border py-2 font-mono-tabular text-xs font-semibold transition-colors ${
                          active
                            ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                            : 'border-white/10 bg-[#171316] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {cnt === 0 ? 'Solo' : `${cnt} Bot${cnt > 1 ? 's' : ''}`}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-1 md:col-span-3">
                  {DIFFICULTIES.map((d) => {
                    const active = (infectionConfig.botDifficulty ?? 'tactical') === d.id;
                    const disabled = (infectionConfig.botCount ?? 0) === 0;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => updateInfection({ botDifficulty: d.id })}
                        className={`flex-1 border py-2 font-mono-tabular text-[11px] font-semibold transition-colors ${
                          disabled
                            ? 'cursor-not-allowed border-white/5 bg-[#121012] text-neutral-600'
                            : active
                              ? 'cursor-pointer border-sky-400 bg-sky-500/20 text-sky-200'
                              : 'cursor-pointer border-white/10 bg-[#171316] text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <WeatherTimeControls
                mapId={infectionConfig.mapId}
                weatherPreset={infectionConfig.weatherPreset ?? 'auto'}
                timeOfDayStart={infectionConfig.timeOfDayStart ?? 'auto'}
                accent="red"
                onChangeWeather={(weatherPreset) => updateInfection({ weatherPreset })}
                onChangeTimeOfDay={(timeOfDayStart) => updateInfection({ timeOfDayStart })}
              />

              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4">
                <span className="font-mono-tabular text-xs text-neutral-400">
                  Start Pistol · Wall-Buys · Mystery Crate · Power &amp; Perks
                </span>
                <button
                  type="button"
                  onClick={() =>
                    onDeployInfection({
                      ...infectionConfig,
                      tacticalEquipmentId: tacticalSelection.equipmentId,
                      weatherPreset: infectionConfig.weatherPreset ?? 'auto',
                      timeOfDayStart: infectionConfig.timeOfDayStart ?? 'auto',
                    })
                  }
                  className="cursor-pointer bg-red-600 px-8 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-white transition-colors hover:bg-red-500 whitespace-nowrap shrink-0"
                >
                  Deploy Containment
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

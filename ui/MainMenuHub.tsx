import React, { useEffect, useMemo, useState } from 'react';
import { Lock, Settings, User, Users } from 'lucide-react';
import { GYM_ARMORY_WEAPONS, SDK_WEAPON_PROFILES } from '../bodycam-sdk';
import { useAuth } from '../context/AuthContext';
import { useLobby } from '../context/LobbyContext';
import { useSocial } from '../context/SocialContext';
import {
  formatRankLabel,
  getRankTitleInfo,
  getWeaponUnlockRank,
} from '../data/progression';
import { InfectionMapRecord, SaveManager } from '../engine/persistence/SaveManager';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import {
  BattleMatchConfig,
  BattleRuleId,
  BotDifficultyId,
  InfectionMatchConfig,
  TopLevelModeId,
} from '../maps/types';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  useAdaptiveScaling,
  useGraphicsQuality,
} from '../data/graphicsQuality';
import { useKillfeedPreference } from '../data/killfeedSettings';
import { useLoadoutStore } from '../data/loadoutStore';
import { guestRecentMatchStore, useGuestRecentMatches } from '../data/recentMatchStore';
import { MapSelector } from './MapSelector';
import { MenuBackdrop3D, MenuBackdropMood } from './MenuBackdrop3D';
import { MultiplayerHubPanel } from './MultiplayerHubPanel';
import { OperatorSelectPanel } from './OperatorSelectPanel';
import { RecentMatchesPanel } from './RecentMatchesPanel';
import { UnifiedLoadoutWorkbench } from './UnifiedLoadoutWorkbench';
import { useOperatorSelection } from '../bodycam-sdk/operator/OperatorSelectionStore';
import { OPERATOR_PROFILES } from '../bodycam-sdk/operator/OperatorTypes';
import { useTacticalEquipmentSelection } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import {
  TACTICAL_EQUIPMENT_LIST,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { WeatherTimeControls } from './WeatherTimeControls';
import { openGameSettings } from '../data/gameSettingsStore';

export type HubTabId = TopLevelModeId | 'loadout' | 'operator' | 'multiplayer';

interface MainMenuHubProps {
  initialTab?: HubTabId;
  initialBattleConfig: BattleMatchConfig;
  initialInfectionConfig: InfectionMatchConfig;
  onLaunchPlayground: () => void;
  onLaunchBattle: (config: BattleMatchConfig) => void;
  onLaunchInfection: (config: InfectionMatchConfig) => void;
}

const BOT_COUNTS = [4, 6, 8, 10] as const;
const INFECTION_BOT_COUNTS = [0, 1, 2, 3] as const;
const KILL_LIMITS = [20, 30, 40, 50] as const;
const DIFFICULTIES: Array<{ id: BotDifficultyId; label: string }> = [
  { id: 'recruit', label: 'Recruit' },
  { id: 'tactical', label: 'Tactical' },
  { id: 'veteran', label: 'Veteran' },
];

export const MainMenuHub: React.FC<MainMenuHubProps> = ({
  initialTab = 'battle',
  initialBattleConfig,
  initialInfectionConfig,
  onLaunchPlayground,
  onLaunchBattle,
  onLaunchInfection,
}) => {
  const {
    user,
    effectiveRank,
    openAuthModal,
    openAccountSettings,
    requireAuth,
    isWeaponUnlocked,
    isAttachmentUnlocked,
    getWeaponProgress,
  } = useAuth();
  const { friends, incomingRequests, openDrawer: openSocialDrawer } = useSocial();
  const { lobby } = useLobby();
  const [selectedOperatorId] = useOperatorSelection();
  const { selection: tacticalSelection, setEquipment: setTacticalEquipmentId } =
    useTacticalEquipmentSelection();
  const loadoutState = useLoadoutStore();
  const activeLoadout = loadoutState.slots[loadoutState.activeIndex] ?? loadoutState.slots[0];
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const [adaptiveScaling, setAdaptiveScaling] = useAdaptiveScaling();
  const [personalKillfeed, setPersonalKillfeed] = useKillfeedPreference();
  const [lobbyWorkbenchOpen, setLobbyWorkbenchOpen] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<HubTabId>(lobby ? 'multiplayer' : initialTab);
  const [battleConfig, setBattleConfig] = useState<BattleMatchConfig>(initialBattleConfig);
  const [infectionConfig, setInfectionConfig] =
    useState<InfectionMatchConfig>(initialInfectionConfig);
  const guestRecentMatches = useGuestRecentMatches();
  const recentMatches = user ? (user.recentMatches ?? []) : guestRecentMatches;

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

  // Ensure selected Battle loadout falls back to unlocked Rank 1 starters if account was reset
  useEffect(() => {
    setBattleConfig((prev) => {
      const nextPrimary = isWeaponUnlocked(prev.primaryWeaponId) ? prev.primaryWeaponId : 'm4a1';
      const nextSecondary = isWeaponUnlocked(prev.secondaryWeaponId)
        ? prev.secondaryWeaponId
        : 'makarov_pm';
      if (nextPrimary === prev.primaryWeaponId && nextSecondary === prev.secondaryWeaponId) {
        return prev;
      }
      return { ...prev, primaryWeaponId: nextPrimary, secondaryWeaponId: nextSecondary };
    });
  }, [effectiveRank, isWeaponUnlocked]);

  // Exit multiplayer tab automatically if user signs out; jump to multiplayer when joining a lobby
  useEffect(() => {
    if (!user && activeTab === 'multiplayer') {
      setActiveTab('battle');
    } else if (user && lobby && activeTab !== 'multiplayer') {
      setActiveTab('multiplayer');
    }
  }, [user, lobby, activeTab]);

  // Keep Battle weapons synced with the active Loadout slot whenever user edits Loadout tab
  useEffect(() => {
    setBattleConfig((prev) => {
      const nextPrimary = isWeaponUnlocked(activeLoadout.primaryWeaponId)
        ? activeLoadout.primaryWeaponId
        : prev.primaryWeaponId;
      const nextSecondary = isWeaponUnlocked(activeLoadout.secondaryWeaponId)
        ? activeLoadout.secondaryWeaponId
        : prev.secondaryWeaponId;
      if (nextPrimary === prev.primaryWeaponId && nextSecondary === prev.secondaryWeaponId) {
        return prev;
      }
      return { ...prev, primaryWeaponId: nextPrimary, secondaryWeaponId: nextSecondary };
    });
  }, [activeLoadout.primaryWeaponId, activeLoadout.secondaryWeaponId, isWeaponUnlocked]);

  const isInfection = activeTab === 'infection';
  const isOperatorTab = activeTab === 'operator';
  const isLoadoutTab = activeTab === 'loadout' || lobbyWorkbenchOpen;
  const mood: MenuBackdropMood =
    activeTab === 'multiplayer' || activeTab === 'operator' || activeTab === 'loadout'
      ? 'battle'
      : activeTab;
  const rankInfo = getRankTitleInfo(effectiveRank);
  const selectedOperatorProfile = OPERATOR_PROFILES[selectedOperatorId];

  const updateBattle = (patch: Partial<BattleMatchConfig>) => {
    setBattleConfig((prev) => ({ ...prev, ...patch }));
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 select-none">
      {/* Live 3D Architectural Backdrop (unmounted during Operator or CAD Loadout Stage to avoid competing WebGL contexts) */}
      {!isOperatorTab && !isLoadoutTab && <MenuBackdrop3D mood={mood} />}

      {/* Directional contrast scrim + Infection crimson arterial vignette */}
      {!isOperatorTab && !isLoadoutTab && (
        <div
          className={`pointer-events-none fixed inset-0 z-[1] transition-opacity duration-500 ${
            isInfection ? 'infection-vignette' : ''
          }`}
          style={{
            background: isInfection
              ? 'linear-gradient(105deg, rgba(10,4,6,0.92) 0%, rgba(16,6,9,0.78) 55%, rgba(10,4,6,0.62) 100%)'
              : 'linear-gradient(105deg, rgba(9,11,14,0.92) 0%, rgba(11,14,18,0.76) 58%, rgba(9,11,14,0.52) 100%)',
          }}
        />
      )}

      {/* Foreground Menu Layout */}
      <div className="relative z-10 flex h-full w-full flex-col justify-between px-6 py-5 sm:px-10 sm:py-7">
        {/* Top Masthead, Mode Navigation & Account Trigger */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800/80 pb-4">
          <div className="flex items-baseline gap-4">
            <h1 className="font-display text-3xl font-bold uppercase tracking-wider text-neutral-50 whitespace-nowrap shrink-0">
              AXON ENGINE
            </h1>
            <span
              className={`hidden font-mono-tabular text-[11px] uppercase tracking-[0.2em] xl:inline ${
                isInfection ? 'text-red-400' : 'text-amber-400/90'
              }`}
            >
              Tactical Bodycam Simulation
            </span>
          </div>

          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Game Modes">
            {(
              [
                { id: 'playground', label: 'PLAYGROUND', sub: 'Range & Ballistics', gated: false },
                { id: 'battle', label: 'BATTLE', sub: 'Solo TDM & FFA', gated: false },
                { id: 'infection', label: 'INFECTION', sub: 'Solo Zombies', gated: false },
                { id: 'loadout', label: 'LOADOUT', sub: activeLoadout.name, gated: false },
                {
                  id: 'operator',
                  label: 'OPERATOR',
                  sub: selectedOperatorProfile.label,
                  gated: false,
                },
                { id: 'multiplayer', label: 'MULTIPLAYER', sub: 'Lobbies & Events', gated: true },
              ] as const
            ).map((item) => {
              const active = activeTab === item.id;
              const isInfTab = item.id === 'infection';
              const isMpTab = item.id === 'multiplayer';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.gated) {
                      requireAuth(
                        'Multiplayer Lobbies, Special Events, and Social Hub require a signed-in AXON ENGINE account. Singleplayer modes remain playable without signing in.',
                        () => setActiveTab('multiplayer'),
                      );
                    } else {
                      setActiveTab(item.id);
                    }
                  }}
                  className={`cursor-pointer whitespace-nowrap shrink-0 border px-3.5 py-2 text-left transition-colors ${
                    active
                      ? isInfTab
                        ? 'border-red-500 bg-red-950/75 text-red-50'
                        : isMpTab
                          ? 'border-sky-400 bg-sky-500/15 text-neutral-50'
                          : 'border-amber-400 bg-amber-500/15 text-neutral-50'
                      : 'border-neutral-800 bg-neutral-950/80 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-display text-sm font-bold uppercase tracking-wider">
                    <span>{item.label}</span>
                    {item.gated && !user && <Lock className="h-3 w-3 text-amber-400/90" />}
                  </div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider opacity-75">
                    {item.sub}
                  </div>
                </button>
              );
            })}
          </nav>

          {/* Right Account, Settings & Social Controls */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => openGameSettings('general')}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border border-neutral-800 bg-neutral-950/85 px-3 py-2 font-mono-tabular text-xs text-neutral-300 transition-colors hover:border-amber-400/70 hover:text-neutral-50"
            >
              <Settings className="h-3.5 w-3.5 text-amber-400" />
              <span>Settings</span>
            </button>

            <button
              type="button"
              onClick={() => openSocialDrawer(incomingRequests.length > 0 ? 'requests' : 'friends')}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border border-neutral-800 bg-neutral-950/85 px-3 py-2 font-mono-tabular text-xs text-neutral-300 transition-colors hover:border-amber-400/70 hover:text-neutral-50"
            >
              <Users className="h-3.5 w-3.5 text-amber-400" />
              <span>Social</span>
              {user && incomingRequests.length > 0 && (
                <span className="font-semibold text-amber-400">({incomingRequests.length})</span>
              )}
              {user && incomingRequests.length === 0 && friends.length > 0 && (
                <span className="text-neutral-500">
                  · {friends.filter((f) => f.status !== 'offline').length}
                </span>
              )}
            </button>

            {user ? (
              <button
                type="button"
                onClick={openAccountSettings}
                className="flex cursor-pointer items-center gap-2.5 whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-950/90 px-3.5 py-1.5 text-left transition-colors hover:border-amber-400"
              >
                <div
                  className="flex h-7 w-7 items-center justify-center border bg-neutral-900 font-display text-xs font-bold"
                  style={{ borderColor: rankInfo.accentHex, color: rankInfo.accentHex }}
                >
                  {user.rank}
                </div>
                <div>
                  <div className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-neutral-50">
                    <span>{user.username}</span>
                    <Settings className="h-3 w-3 text-neutral-400" />
                  </div>
                  <div className="font-mono-tabular text-[10px] text-neutral-400">
                    {formatRankLabel(user.rank, user.prestige)}
                  </div>
                </div>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openAuthModal(null)}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 bg-amber-500 px-4 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
              >
                <User className="h-3.5 w-3.5" />
                <span>Sign In</span>
              </button>
            )}
          </div>
        </header>

        {/* Center Contextual Mode Briefing */}
        <main
          className={
            isOperatorTab
              ? 'flex flex-1 min-h-0 flex-col py-3'
              : 'my-auto flex max-h-[calc(100vh-175px)] flex-col overflow-y-auto py-4 pr-1'
          }
        >
          {activeTab === 'playground' && (
            <div className="max-w-3xl">
              <div className="font-mono-tabular text-[11px] uppercase tracking-[0.2em] text-amber-400">
                Calibration Facility · 42 Firearms · Modular Gunsmith
              </div>
              <h2 className="mt-1 font-display text-5xl font-bold uppercase tracking-wide text-neutral-50">
                PLAYGROUND
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-neutral-300">
                Enter the full-scale bodycam testing facility to tune optics, test coupled ballistics
                against reactive AR500 steel and penetration barriers, practice tactical vaulting &amp;
                Point Aim, and customize all 42 firearms at the Gunsmithing Bench. Saved attachments
                automatically carry over into Battle and Infection.
              </p>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-neutral-800/80 py-3 font-mono-tabular text-xs text-neutral-300">
                <span>42 Firearms &amp; 44+ Ammo Cartridges</span>
                <span className="text-neutral-600">·</span>
                <span>Dual-Render PiP Scopes &amp; Canted Sights</span>
                <span className="text-neutral-600">·</span>
                <span>Belt Tactical Ordnance &amp; Gunsmith Persistence</span>
              </div>

              {/* Belt Tactical Grenade Selector for Playground */}
              <div className="mt-4 border border-neutral-800 bg-neutral-950/88 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                    Belt Tactical Equipment (All Modes)
                  </span>
                  <span className="font-mono-tabular text-[10px] text-amber-300">
                    Hold H / 5 in Range · 4 / H in Combat
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {TACTICAL_EQUIPMENT_LIST.map((eq) => {
                    const active = tacticalSelection.equipmentId === eq.id;
                    return (
                      <button
                        key={eq.id}
                        type="button"
                        onClick={() => setTacticalEquipmentId(eq.id)}
                        className={`cursor-pointer border px-2.5 py-2 text-left font-mono-tabular transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-neutral-800 bg-neutral-900/80 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        <div className="text-[11px] font-semibold uppercase">{eq.shortName}</div>
                        <div className="text-[9px] uppercase opacity-75">
                          {eq.category} · {eq.fuseSec.toFixed(1)}s fuse
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onLaunchPlayground}
                  className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-7 py-3 font-display text-base font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
                >
                  Enter Playground
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('battle')}
                  className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-950/85 px-5 py-3 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
                >
                  Configure Battle Match
                </button>
              </div>
            </div>
          )}

          {activeTab === 'battle' && (
            <div className="flex w-full max-w-5xl flex-col gap-5">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="font-mono-tabular text-[11px] uppercase tracking-[0.2em] text-amber-400">
                    AI Tactical Skirmish · Unified Bodycam Combat
                  </div>
                  <h2 className="mt-0.5 font-display text-4xl font-bold uppercase tracking-wide text-neutral-50">
                    BATTLE
                  </h2>
                </div>

                {/* Rule Selector: TDM vs FFA */}
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
                        className={`cursor-pointer whitespace-nowrap shrink-0 border px-4 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500 text-neutral-950'
                            : 'border-neutral-700 bg-neutral-950/85 text-neutral-300 hover:border-neutral-500'
                        }`}
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Match Parameters & Loadout Strip */}
              <div className="grid grid-cols-1 gap-3 border border-neutral-800 bg-neutral-950/88 p-4 md:grid-cols-6">
                {/* Bot Count */}
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Combatants (Bots)
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    {BOT_COUNTS.map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => updateBattle({ botCount: cnt })}
                        className={`flex-1 cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                          battleConfig.botCount === cnt
                            ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {cnt}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Kill Limit */}
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Kill Limit
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    {KILL_LIMITS.map((lim) => (
                      <button
                        key={lim}
                        type="button"
                        onClick={() => updateBattle({ killLimit: lim })}
                        className={`flex-1 cursor-pointer border py-1.5 font-mono-tabular text-xs font-semibold transition-colors ${
                          battleConfig.killLimit === lim
                            ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {lim}
                      </button>
                    ))}
                  </div>
                </div>

                {/* AI Difficulty */}
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    AI Difficulty
                  </div>
                  <div className="mt-1.5 flex gap-1">
                    {DIFFICULTIES.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => updateBattle({ difficulty: d.id })}
                        className={`flex-1 cursor-pointer whitespace-nowrap border px-1.5 py-1.5 font-mono-tabular text-[11px] font-semibold transition-colors ${
                          battleConfig.difficulty === d.id
                            ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Primary Weapon */}
                <div>
                  <label
                    htmlFor="battle-primary-select"
                    className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400"
                  >
                    Primary Weapon
                  </label>
                  <select
                    id="battle-primary-select"
                    value={battleConfig.primaryWeaponId}
                    onChange={(e) => {
                      if (isWeaponUnlocked(e.target.value)) {
                        updateBattle({ primaryWeaponId: e.target.value });
                      }
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
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

                {/* Sidearm Weapon */}
                <div>
                  <label
                    htmlFor="battle-sidearm-select"
                    className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400"
                  >
                    Sidearm
                  </label>
                  <select
                    id="battle-sidearm-select"
                    value={battleConfig.secondaryWeaponId}
                    onChange={(e) => {
                      if (isWeaponUnlocked(e.target.value)) {
                        updateBattle({ secondaryWeaponId: e.target.value });
                      }
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
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

                {/* Tactical Grenade */}
                <div>
                  <label
                    htmlFor="battle-grenade-select"
                    className="block font-mono-tabular text-[10px] uppercase tracking-wider text-amber-400/90"
                  >
                    Tactical Grenade
                  </label>
                  <select
                    id="battle-grenade-select"
                    value={tacticalSelection.equipmentId}
                    onChange={(e) => {
                      const nextId = e.target.value as TacticalEquipmentId;
                      setTacticalEquipmentId(nextId);
                      updateBattle({ tacticalEquipmentId: nextId });
                    }}
                    className="mt-1.5 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100 focus:border-amber-400 focus:outline-none"
                  >
                    {TACTICAL_EQUIPMENT_LIST.map((eq) => (
                      <option key={eq.id} value={eq.id}>
                        {eq.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Shared MapSelector (theme="tactical") */}
              <div>
                <div className="mb-2 font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                  Select Combat Sector
                </div>
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

              {/* Host Match Visibility Controls (Hitmarkers & Combat HUD) */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-neutral-800 bg-neutral-950/88 px-4 py-3">
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-amber-400">
                    Match Rules · HUD &amp; Hitmarkers
                  </div>
                  <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                    Toggle Battle hitmarkers and combat HUD overlays independently (also adjustable live in-match)
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
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
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
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    Combat HUD: {battleConfig.hudEnabled !== false ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="font-mono-tabular text-xs text-neutral-400">
                  {battleConfig.rule === 'tdm'
                    ? 'Team A (Blue) vs Team B (Orange) · No Friendly Fire'
                    : 'Free-For-All · Every Operator Hostile'}{' '}
                  · Gunsmith Attachments Synced
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onLaunchBattle({
                      ...battleConfig,
                      tacticalEquipmentId: tacticalSelection.equipmentId,
                      weatherPreset: battleConfig.weatherPreset ?? 'auto',
                      timeOfDayStart: battleConfig.timeOfDayStart ?? 'auto',
                      hitmarkersEnabled: battleConfig.hitmarkersEnabled !== false,
                      hudEnabled: battleConfig.hudEnabled !== false,
                    })
                  }
                  className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-8 py-3 font-display text-base font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
                >
                  Deploy Match
                </button>
              </div>

              <RecentMatchesPanel
                matches={recentMatches}
                isGuest={!user}
                accent="amber"
                onClearGuestHistory={() => guestRecentMatchStore.clear()}
              />
            </div>
          )}

          {activeTab === 'infection' && (
            <div className="flex w-full max-w-5xl flex-col gap-5">
              <div>
                <div className="font-mono-tabular text-[11px] uppercase tracking-[0.22em] text-red-400">
                  Round-Based Survival Horror · Melee Horde
                </div>
                <h2 className="mt-0.5 font-display text-4xl font-bold uppercase tracking-wide text-red-50">
                  INFECTION
                </h2>
                <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-neutral-300">
                  Hold out against escalating waves of infected. Earn points from hits, headshots,
                  and melee takedowns to breach barricaded zones, restore theater power, pull
                  firearms from chalk wall-buys or the 950 PTS Mystery Crate, and activate Perk
                  Machines.
                </p>
              </div>

              {/* Shared MapSelector (theme="infection") */}
              <div>
                <div className="mb-2 font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-red-300/80">
                  Select Containment Site
                </div>
                <MapSelector
                  maps={ZOMBIE_MAPS}
                  selectedMapId={infectionConfig.mapId}
                  onSelectMap={(mapId) =>
                    setInfectionConfig((prev) => ({
                      ...prev,
                      mapId,
                    }))
                  }
                  theme="infection"
                  infectionRecords={infectionRecords}
                />
              </div>

              {/* Friendly AI Squadmates (0–3 filling 4-operator squad) & Difficulty */}
              <div className="grid grid-cols-1 gap-3 border border-red-950/80 bg-neutral-950/88 p-4 md:grid-cols-12">
                <div className="md:col-span-5">
                  <div className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-sky-300">
                    Friendly AI Squadmates (0–3)
                  </div>
                  <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                    Always allied · fills remaining slots in your 4-operator squad
                  </div>
                </div>
                <div className="flex items-center gap-1.5 md:col-span-4">
                  {INFECTION_BOT_COUNTS.map((cnt) => {
                    const active = (infectionConfig.botCount ?? 0) === cnt;
                    return (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() =>
                          setInfectionConfig((prev) => ({
                            ...prev,
                            botCount: cnt,
                          }))
                        }
                        className={`flex-1 cursor-pointer border py-2 font-mono-tabular text-xs font-semibold transition-colors ${
                          active
                            ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
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
                        onClick={() =>
                          setInfectionConfig((prev) => ({
                            ...prev,
                            botDifficulty: d.id,
                          }))
                        }
                        className={`flex-1 cursor-pointer border py-2 font-mono-tabular text-[10px] font-semibold uppercase transition-colors disabled:opacity-35 ${
                          active
                            ? 'border-red-500 bg-red-600/25 text-red-100'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Starting Belt Grenade Selector for Infection */}
              <div className="flex flex-wrap items-center justify-between gap-3 border border-red-950/80 bg-neutral-950/86 px-4 py-3">
                <div>
                  <div className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-red-400">
                    Starting Belt Ordnance (+1 Per Cleared Wave)
                  </div>
                  <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-400">
                    Mounted on operator waist belt · Hold 4 or H to cook &amp; throw
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {TACTICAL_EQUIPMENT_LIST.map((eq) => {
                    const active = tacticalSelection.equipmentId === eq.id;
                    return (
                      <button
                        key={eq.id}
                        type="button"
                        onClick={() => {
                          setTacticalEquipmentId(eq.id);
                          setInfectionConfig((prev) => ({
                            ...prev,
                            tacticalEquipmentId: eq.id,
                          }));
                        }}
                        className={`cursor-pointer whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors ${
                          active
                            ? 'border-red-500 bg-red-600/25 text-red-100'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        {eq.shortName}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Weather & 5x Dynamic Time of Day (Outdoor Containment Sites) */}
              <WeatherTimeControls
                mapId={infectionConfig.mapId}
                weatherPreset={infectionConfig.weatherPreset ?? 'auto'}
                timeOfDayStart={infectionConfig.timeOfDayStart ?? 'auto'}
                accent="red"
                onChangeWeather={(weatherPreset) =>
                  setInfectionConfig((prev) => ({ ...prev, weatherPreset }))
                }
                onChangeTimeOfDay={(timeOfDayStart) =>
                  setInfectionConfig((prev) => ({ ...prev, timeOfDayStart }))
                }
              />

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-red-950/80 pt-3">
                <div className="font-mono-tabular text-[11px] text-neutral-300">
                  Hold [F] Repair Window Barriers (+5 PTS) · Buyable Doors · Backstage Power ·
                  Wall-Buys &amp; Mystery Crate · Allied Bots
                </div>
                <button
                  type="button"
                  onClick={() =>
                    onLaunchInfection({
                      ...infectionConfig,
                      botCount: infectionConfig.botCount ?? 0,
                      botDifficulty: infectionConfig.botDifficulty ?? 'tactical',
                      tacticalEquipmentId: tacticalSelection.equipmentId,
                      weatherPreset: infectionConfig.weatherPreset ?? 'auto',
                      timeOfDayStart: infectionConfig.timeOfDayStart ?? 'auto',
                    })
                  }
                  className="cursor-pointer whitespace-nowrap shrink-0 bg-red-600 px-8 py-3 font-display text-base font-bold uppercase tracking-wider text-neutral-50 transition-colors hover:bg-red-500"
                >
                  Enter Infection
                </button>
              </div>

              <RecentMatchesPanel
                matches={recentMatches}
                isGuest={!user}
                accent="red"
                onClearGuestHistory={() => guestRecentMatchStore.clear()}
              />
            </div>
          )}

          {activeTab === 'operator' && (
            <OperatorSelectPanel
              onDeploy={onLaunchPlayground}
              deployLabel="Deploy to Playground"
            />
          )}

          {activeTab === 'multiplayer' && user && (
            <MultiplayerHubPanel
              onOpenLoadoutWorkbench={() => setLobbyWorkbenchOpen(true)}
            />
          )}
        </main>

        {/* Bottom Game Settings, 4-Mode Graphics Quality & Killfeed Toggle Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800/70 pt-3 font-mono-tabular text-[11px] text-neutral-400">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openGameSettings('controls')}
              className="cursor-pointer whitespace-nowrap border border-neutral-800 bg-neutral-900 px-2.5 py-1 text-[10px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-amber-400/70 hover:text-amber-300"
            >
              Game Settings · Controls
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-[10px] uppercase text-neutral-500">Graphics</span>
              {GRAPHICS_QUALITY_ORDER.map((gid) => (
                <button
                  key={gid}
                  type="button"
                  onClick={() => setGraphicsQuality(gid)}
                  className={`cursor-pointer border px-1.5 py-0.5 text-[10px] uppercase transition-colors whitespace-nowrap shrink-0 ${
                    graphicsQuality === gid
                      ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-200'
                  }`}
                  title={GRAPHICS_QUALITY_PROFILES[gid].description}
                >
                  {GRAPHICS_QUALITY_PROFILES[gid].shortLabel}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAdaptiveScaling(!adaptiveScaling)}
                className={`ml-1 cursor-pointer border px-2 py-0.5 text-[10px] uppercase transition-colors whitespace-nowrap shrink-0 ${
                  adaptiveScaling
                    ? 'border-sky-400/70 bg-sky-950/50 text-sky-300'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-200'
                }`}
                title="Automatically scale resolution & secondary effects if framerate drops below target (OFF by default)"
              >
                Adaptive: {adaptiveScaling ? 'ON' : 'OFF'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPersonalKillfeed(!personalKillfeed)}
              className={`cursor-pointer border px-2 py-0.5 text-[10px] uppercase transition-colors ${
                personalKillfeed
                  ? 'border-emerald-500/60 bg-emerald-950/40 text-emerald-300'
                  : 'border-neutral-800 bg-neutral-900 text-neutral-500'
              }`}
            >
              Killfeed: {personalKillfeed ? 'ON' : 'OFF'}
            </button>
          </div>
        </footer>
      </div>

      {/* Unified CAD Loadout & Gunsmith Workbench Overlay (Main Menu Loadout Tab or Lobby Quick Edit) */}
      {(activeTab === 'loadout' || lobbyWorkbenchOpen) && (
        <UnifiedLoadoutWorkbench
          careerRank={effectiveRank}
          getWeaponProgress={getWeaponProgress}
          isWeaponUnlocked={isWeaponUnlocked}
          isAttachmentUnlocked={isAttachmentUnlocked}
          onClose={() => {
            if (lobbyWorkbenchOpen) {
              setLobbyWorkbenchOpen(false);
            } else {
              setActiveTab('battle');
            }
          }}
          closeLabel={lobbyWorkbenchOpen ? 'Back to Lobby' : 'Back to Menu'}
        />
      )}
    </div>
  );
};

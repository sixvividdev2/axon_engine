import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Edit3,
  Globe,
  Hash,
  Lock,
  Minus,
  Play,
  Plus,
  RefreshCw,
  Sliders,
  Trash2,
  Users,
} from 'lucide-react';
import { useLobby } from '../context/LobbyContext';
import {
  eventCycleIdToModeRule,
  EventCycleModeId,
  formatLobbyModeLabel,
  formatMapDisplayName,
  isInfectionMapId,
  LobbyBrowserEntry,
  LobbyModeId,
  LobbyVisibility,
  modeRuleToEventCycleId,
  SpecialEventRecord,
} from '../data/multiplayer';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import { BattleRuleId, BotDifficultyId } from '../maps/types';
import { LobbyRoomView } from './LobbyRoomView';
import { SpecialEventBuilderModal } from './SpecialEventBuilderModal';

interface MultiplayerHubPanelProps {
  onOpenLoadoutWorkbench?: () => void;
}

export const MultiplayerHubPanel: React.FC<MultiplayerHubPanelProps> = ({
  onOpenLoadoutWorkbench,
}) => {
  const {
    lobby,
    connecting,
    error,
    kickedNotice,
    savedEvents,
    publicLobbies,
    friendLobbies,
    browserLoading,
    clearError,
    clearKickedNotice,
    refreshBrowser,
    refreshEvents,
    saveEvent,
    removeEvent,
    hostStandardLobby,
    hostSpecialEvent,
    joinByCodeOrHash,
    joinLobbyDirect,
  } = useLobby();

  // Direct join bar (Event Hash Code or Lobby Code)
  const [joinInput, setJoinInput] = useState<string>('');
  const [joinBusy, setJoinBusy] = useState<boolean>(false);

  // Host Standard Lobby form
  const [visibility, setVisibility] = useState<LobbyVisibility>('public');
  const [mode, setMode] = useState<LobbyModeId>('battle');
  const [battleRule, setBattleRule] = useState<BattleRuleId>('tdm');
  const [mapId, setMapId] = useState<string>('pripyat_block');
  const [maxPlayers, setMaxPlayers] = useState<number>(8);
  const [botsEnabled, setBotsEnabled] = useState<boolean>(true);
  const [botCount, setBotCount] = useState<number>(6);
  const [killLimit, setKillLimit] = useState<number>(30);
  const [botDifficulty, setBotDifficulty] = useState<BotDifficultyId>('tactical');
  const [hostBusy, setHostBusy] = useState<boolean>(false);

  // Special Event Builder modal state
  const [builderOpen, setBuilderOpen] = useState<boolean>(false);
  const [editingEvent, setEditingEvent] = useState<SpecialEventRecord | null>(null);
  const [eventHostVisibility, setEventHostVisibility] = useState<LobbyVisibility>('public');
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);

  useEffect(() => {
    void refreshBrowser();
    void refreshEvents();
  }, [refreshBrowser, refreshEvents]);

  // If currently inside an active lobby, render the live LobbyRoomView
  if (lobby) {
    return <LobbyRoomView onOpenLoadoutWorkbench={onOpenLoadoutWorkbench} />;
  }

  const availableMaps = mode === 'infection' ? ZOMBIE_MAPS : BATTLE_MAPS;
  const isInfMode = mode === 'infection';
  const maxAllowedPlayers = isInfMode ? 4 : 8;
  const effectiveMaxPlayers = Math.min(maxPlayers, maxAllowedPlayers);
  const maxAllowedBots = isInfMode ? Math.max(0, effectiveMaxPlayers - 1) : 10;
  const effectiveBotCount = botsEnabled ? Math.min(botCount, maxAllowedBots) : 0;

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinInput.trim()) return;
    setJoinBusy(true);
    try {
      await joinByCodeOrHash(joinInput);
      setJoinInput('');
    } catch {
      // Error surfaced via LobbyContext
    } finally {
      setJoinBusy(false);
    }
  };

  const handleHostStandard = async () => {
    setHostBusy(true);
    try {
      await hostStandardLobby({
        visibility,
        mode,
        battleRule,
        mapId,
        maxPlayers: effectiveMaxPlayers,
        botsEnabled: effectiveBotCount > 0,
        botCount: effectiveBotCount,
        killLimit,
        botDifficulty,
      });
    } catch {
      // Error surfaced via LobbyContext
    } finally {
      setHostBusy(false);
    }
  };

  const copyEventHash = (ev: SpecialEventRecord) => {
    void navigator.clipboard?.writeText(ev.hashCode);
    setCopiedEventId(ev.id);
    window.setTimeout(() => setCopiedEventId(null), 1600);
  };

  const renderBrowserCard = (entry: LobbyBrowserEntry) => {
    const isEvent = Boolean(entry.eventName);
    return (
      <div
        key={entry.code}
        className={`flex items-center justify-between gap-3 border px-3.5 py-2.5 ${
          isEvent
            ? 'border-amber-500/45 bg-amber-950/15'
            : 'border-neutral-800 bg-neutral-900/70'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide text-neutral-100">
            <span className="truncate">
              {isEvent ? entry.eventName : formatLobbyModeLabel(entry.mode, entry.battleRule)}
            </span>
            {entry.status === 'in_match' && (
              <span className="font-mono-tabular text-[10px] font-semibold text-amber-400">
                IN MATCH
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono-tabular text-[11px] text-neutral-400">
            <span>Host: {entry.hostUsername}</span>
            <span className="text-neutral-600">·</span>
            <span>{formatMapDisplayName(entry.mapId)}</span>
            <span className="text-neutral-600">·</span>
            <span>
              {entry.playerCount}/{entry.maxPlayers} Players
            </span>
            <span className="text-neutral-600">·</span>
            <span>{entry.botsEnabled ? `${entry.botCount} Bots` : 'Players Only'}</span>
          </div>
        </div>

        <button
          type="button"
          disabled={entry.playerCount >= entry.maxPlayers || connecting}
          onClick={() => void joinLobbyDirect(entry.code, entry.eventHashCode)}
          className="cursor-pointer whitespace-nowrap shrink-0 border border-sky-400/70 bg-sky-500/15 px-3.5 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
        >
          {entry.playerCount >= entry.maxPlayers ? 'Full' : 'Join'}
        </button>
      </div>
    );
  };

  return (
    <div className="flex w-full max-w-6xl flex-col gap-5">
      {/* Top Direct Join Bar (Event Hash Code or Lobby Code) */}
      <div className="flex flex-wrap items-center justify-between gap-4 border border-neutral-800 bg-neutral-950/90 px-5 py-3.5">
        <div>
          <div className="font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-sky-400">
            Multiplayer Lobbies &amp; Special Events
          </div>
          <h2 className="font-display text-3xl font-bold uppercase tracking-wide text-neutral-50">
            MULTIPLAYER
          </h2>
        </div>

        <form onSubmit={handleJoinSubmit} className="flex flex-1 items-center gap-2 sm:max-w-md">
          <div className="relative flex-1">
            <Hash className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
            <input
              type="text"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
              placeholder="Paste Event Hash Code (EVT-...) or Lobby Code"
              className="w-full border border-neutral-700 bg-neutral-900 py-2 pr-3 pl-8 font-mono-tabular text-xs uppercase text-neutral-100 placeholder:normal-case placeholder:text-neutral-500 focus:border-sky-400 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={joinBusy || connecting || !joinInput.trim()}
            className="cursor-pointer whitespace-nowrap shrink-0 bg-sky-500 px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-neutral-950 hover:bg-sky-400 disabled:opacity-45"
          >
            {joinBusy || connecting ? 'Joining...' : 'Direct Join'}
          </button>
        </form>
      </div>

      {kickedNotice && (
        <div className="flex items-center justify-between border border-red-600/80 bg-red-950/70 px-4 py-2.5 font-mono-tabular text-xs text-red-200">
          <span>{kickedNotice}</span>
          <button type="button" onClick={clearKickedNotice} className="cursor-pointer underline">
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between border border-amber-500/70 bg-amber-950/50 px-4 py-2.5 font-mono-tabular text-xs text-amber-200">
          <span>{error}</span>
          <button type="button" onClick={clearError} className="cursor-pointer underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Main 2-column grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: Host Standard Lobby + My Special Events */}
        <div className="space-y-5 lg:col-span-6">
          {/* Host Standard Lobby Card */}
          <div className="border border-neutral-800 bg-neutral-950/90 p-5">
            <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
              Host Standard Lobby
            </div>

            {/* Discovery Tier */}
            <div className="mt-3">
              <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Discovery Privacy
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'public' as LobbyVisibility, label: 'Public', icon: Globe },
                    { id: 'friends_only' as LobbyVisibility, label: 'Friends-Only', icon: Users },
                    { id: 'private' as LobbyVisibility, label: 'Private', icon: Lock },
                  ]
                ).map((item) => {
                  const Icon = item.icon;
                  const active = visibility === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setVisibility(item.id)}
                      className={`flex cursor-pointer items-center justify-center gap-1.5 border py-2 font-mono-tabular text-[11px] font-semibold ${
                        active
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Mode & Map */}
            <div className="mt-3.5 grid grid-cols-2 gap-3">
              <div>
                <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  Game Mode
                </label>
                <select
                  value={modeRuleToEventCycleId(mode, battleRule)}
                  onChange={(e) => {
                    const mapped = eventCycleIdToModeRule(e.target.value as EventCycleModeId);
                    if (mapped.mode === 'infection') {
                      setMode('infection');
                      if (!isInfectionMapId(mapId)) setMapId('kino_theater');
                      setMaxPlayers(4);
                      setBotCount((c) => Math.min(c, 3));
                    } else {
                      setMode('battle');
                      setBattleRule(mapped.battleRule);
                      if (isInfectionMapId(mapId)) setMapId('pripyat_block');
                    }
                  }}
                  className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-2 font-mono-tabular text-xs text-neutral-100"
                >
                  <option value="battle_tdm">Battle · TDM</option>
                  <option value="battle_ffa">Battle · FFA</option>
                  <option value="battle_conquest">Battle · Conquest</option>
                  <option value="battle_ctf">Battle · Capture the Flag</option>
                  <option value="battle_koth">Battle · King of the Hill</option>
                  <option value="battle_kc_tdm">Battle · Kill Confirmed (TDM)</option>
                  <option value="battle_kc_ffa">Battle · Kill Confirmed (FFA)</option>
                  <option value="infection">Infection (Co-op Zombies)</option>
                </select>
              </div>

              <div>
                <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  Sector Map
                </label>
                <select
                  value={mapId}
                  onChange={(e) => setMapId(e.target.value)}
                  className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-2 font-mono-tabular text-xs text-neutral-100"
                >
                  {availableMaps.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Max Players & AI Bots ON/OFF + Stepper */}
            <div className="mt-3.5 grid grid-cols-2 gap-3">
              <div className="border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  Max Players (2–{maxAllowedPlayers})
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={effectiveMaxPlayers <= 2}
                    onClick={() => {
                      const next = Math.max(2, effectiveMaxPlayers - 1);
                      setMaxPlayers(next);
                      if (isInfMode) {
                        setBotCount((c) => Math.min(c, Math.max(0, next - 1)));
                      }
                    }}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-display text-xl font-bold text-neutral-50">
                    {effectiveMaxPlayers}
                  </span>
                  <button
                    type="button"
                    disabled={effectiveMaxPlayers >= maxAllowedPlayers}
                    onClick={() => setMaxPlayers(Math.min(maxAllowedPlayers, effectiveMaxPlayers + 1))}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="border border-neutral-800 bg-neutral-900/60 p-3">
                <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  <span>{isInfMode ? `Ally Bots (0–${maxAllowedBots})` : 'AI Bots'}</span>
                  <button
                    type="button"
                    disabled={maxAllowedBots <= 0}
                    onClick={() => {
                      const next = !botsEnabled;
                      setBotsEnabled(next);
                      if (next && effectiveBotCount === 0) {
                        setBotCount(isInfMode ? maxAllowedBots : 6);
                      }
                    }}
                    className={`cursor-pointer border px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-35 ${
                      effectiveBotCount > 0
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                        : 'border-neutral-700 bg-neutral-950 text-neutral-400'
                    }`}
                  >
                    {effectiveBotCount > 0 ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={effectiveBotCount <= 0}
                    onClick={() => {
                      const next = Math.max(0, effectiveBotCount - 1);
                      setBotCount(next);
                      if (next === 0) setBotsEnabled(false);
                    }}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-display text-xl font-bold text-neutral-50">
                    {effectiveBotCount}
                  </span>
                  <button
                    type="button"
                    disabled={effectiveBotCount >= maxAllowedBots}
                    onClick={() => {
                      setBotsEnabled(true);
                      setBotCount(Math.min(maxAllowedBots, effectiveBotCount + 1));
                    }}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                {isInfMode && (
                  <div className="mt-1 font-mono-tabular text-[9px] text-sky-300/85">
                    Always friendly · fills empty squad slots
                  </div>
                )}
              </div>
            </div>

            {mode === 'battle' ? (
              <div className="mt-3.5 grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Kill Limit
                  </label>
                  <select
                    value={killLimit}
                    onChange={(e) => setKillLimit(Number(e.target.value))}
                    className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                  >
                    {[20, 30, 40, 50, 75, 100].map((k) => (
                      <option key={k} value={k}>
                        {k} Kills
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    AI Difficulty
                  </label>
                  <select
                    value={botDifficulty}
                    onChange={(e) => setBotDifficulty(e.target.value as BotDifficultyId)}
                    className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                  >
                    <option value="recruit">Recruit</option>
                    <option value="tactical">Tactical</option>
                    <option value="veteran">Veteran</option>
                  </select>
                </div>
              </div>
            ) : (
              effectiveBotCount > 0 && (
                <div className="mt-3.5">
                  <label className="block font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                    Friendly Bot Difficulty
                  </label>
                  <select
                    value={botDifficulty}
                    onChange={(e) => setBotDifficulty(e.target.value as BotDifficultyId)}
                    className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                  >
                    <option value="recruit">Recruit</option>
                    <option value="tactical">Tactical</option>
                    <option value="veteran">Veteran</option>
                  </select>
                </div>
              )
            )}

            <button
              type="button"
              disabled={hostBusy || connecting}
              onClick={() => void handleHostStandard()}
              className="mt-4 flex w-full cursor-pointer items-center justify-center gap-2 bg-amber-500 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>{hostBusy ? 'Creating Lobby...' : 'Host Lobby'}</span>
            </button>
          </div>

          {/* My Saved Special Events */}
          <div className="border border-amber-500/35 bg-neutral-950/90 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                  My Special Events ({savedEvents.length})
                </div>
                <div className="text-[11px] text-neutral-400">
                  Saved sandbox rulesets with shareable direct-join hash codes
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingEvent(null);
                  setBuilderOpen(true);
                }}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-amber-400 bg-amber-500/15 px-3 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-amber-300 hover:bg-amber-500/25"
              >
                <Sliders className="h-3.5 w-3.5" />
                <span>Create Event</span>
              </button>
            </div>

            {savedEvents.length > 0 && (
              <div className="mt-3 flex items-center justify-between border-y border-neutral-800/80 py-2 font-mono-tabular text-[11px] text-neutral-400">
                <span>Launch Visibility:</span>
                <div className="flex gap-1">
                  {(['public', 'friends_only', 'private'] as LobbyVisibility[]).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setEventHostVisibility(v)}
                      className={`cursor-pointer border px-2 py-0.5 text-[10px] uppercase ${
                        eventHostVisibility === v
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400'
                      }`}
                    >
                      {v === 'friends_only' ? 'Friends' : v}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3 space-y-2.5">
              {savedEvents.length === 0 ? (
                <div className="border border-dashed border-neutral-800 px-4 py-5 text-center font-mono-tabular text-xs text-neutral-500">
                  No Special Events saved yet. Build a custom event to tune player HP, speed, AI,
                  zombies, elimination rounds, and share an instant hash code.
                </div>
              ) : (
                savedEvents.map((ev) => (
                  <div
                    key={ev.id}
                    className="border border-neutral-800 bg-neutral-900/65 p-3.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-display text-base font-bold uppercase tracking-wide text-neutral-100">
                          {ev.name}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono-tabular text-[11px] text-neutral-400">
                          <span>{formatLobbyModeLabel(ev.config.mode, ev.config.battleRule)}</span>
                          <span className="text-neutral-600">·</span>
                          <span>{formatMapDisplayName(ev.config.mapId)}</span>
                          <span className="text-neutral-600">·</span>
                          <span>Max {ev.config.maxPlayers}</span>
                          <span className="text-neutral-600">·</span>
                          <span>
                            {ev.config.playerRespawnEnabled
                              ? 'Respawn'
                              : `${ev.config.livesPerRound}-Life Elim`}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => copyEventHash(ev)}
                        className="flex cursor-pointer items-center gap-1 whitespace-nowrap border border-amber-500/40 bg-amber-950/30 px-2 py-1 font-mono-tabular text-[10px] font-semibold text-amber-300 hover:bg-amber-950/60"
                        title="Copy Event Hash Code"
                      >
                        <span>{ev.hashCode}</span>
                        {copiedEventId === ev.id ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>

                    {ev.description && (
                      <p className="mt-1.5 line-clamp-2 text-xs text-neutral-400">
                        {ev.description}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void hostSpecialEvent(ev.id, eventHostVisibility)}
                        className="flex cursor-pointer items-center gap-1.5 bg-amber-500 px-3 py-1 font-display text-xs font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
                      >
                        <Play className="h-3 w-3 fill-current" />
                        <span>Host Event</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingEvent(ev);
                          setBuilderOpen(true);
                        }}
                        className="flex cursor-pointer items-center gap-1 border border-neutral-700 bg-neutral-950 px-2.5 py-1 font-mono-tabular text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                      >
                        <Edit3 className="h-3 w-3" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeEvent(ev.id)}
                        className="flex cursor-pointer items-center gap-1 border border-red-900/70 bg-red-950/30 px-2.5 py-1 font-mono-tabular text-[11px] text-red-300 hover:bg-red-950/70"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right: Active Lobby Browser (Friends-Only + Public) */}
        <div className="flex flex-col border border-neutral-800 bg-neutral-950/90 p-5 lg:col-span-6">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
            <div>
              <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-400">
                Active Lobby Browser
              </div>
              <div className="text-[11px] text-neutral-400">
                Private lobbies stay hidden unless the Host invites you or shares an Event Hash Code
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refreshBrowser()}
              disabled={browserLoading}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-xs text-neutral-200 hover:border-sky-400 hover:text-sky-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${browserLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          <div className="mt-4 space-y-5">
            {/* Friends-Only Lobbies */}
            <div>
              <div className="mb-2 flex items-center gap-2 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-amber-300">
                <Users className="h-3.5 w-3.5" />
                <span>Friends-Only Lobbies ({friendLobbies.length})</span>
              </div>
              {friendLobbies.length === 0 ? (
                <div className="border border-neutral-800/80 bg-neutral-900/35 px-4 py-4 font-mono-tabular text-xs text-neutral-500">
                  No active Friends-Only lobbies right now.
                </div>
              ) : (
                <div className="space-y-2">{friendLobbies.map(renderBrowserCard)}</div>
              )}
            </div>

            {/* Public Lobbies */}
            <div>
              <div className="mb-2 flex items-center gap-2 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-sky-300">
                <Globe className="h-3.5 w-3.5" />
                <span>Public Lobbies ({publicLobbies.length})</span>
              </div>
              {publicLobbies.length === 0 ? (
                <div className="border border-neutral-800/80 bg-neutral-900/35 px-4 py-6 text-center font-mono-tabular text-xs text-neutral-500">
                  No Public lobbies active yet. Host a lobby on the left or paste a Special Event
                  Hash Code above.
                </div>
              ) : (
                <div className="space-y-2">{publicLobbies.map(renderBrowserCard)}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {builderOpen && (
        <SpecialEventBuilderModal
          initialEvent={editingEvent}
          onSave={async (payload) => {
            await saveEvent(payload);
          }}
          onClose={() => {
            setBuilderOpen(false);
            setEditingEvent(null);
          }}
        />
      )}
    </div>
  );
};

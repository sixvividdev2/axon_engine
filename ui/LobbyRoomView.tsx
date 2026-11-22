import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Crown,
  Globe,
  Lock,
  LogOut,
  Minus,
  Play,
  Plus,
  Send,
  Shield,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLobby } from '../context/LobbyContext';
import { useSocial } from '../context/SocialContext';
import {
  formatLobbyModeLabel,
  formatMapDisplayName,
  LobbyVisibility,
} from '../data/multiplayer';
import { formatRankLabel } from '../data/progression';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import { BotDifficultyId } from '../maps/types';
import {
  formatKillfeedPolicyLabel,
  LobbyKillfeedPolicy,
  resolveEffectiveKillfeed,
  useKillfeedPreference,
} from '../data/killfeedSettings';
import { useLoadoutStore } from '../data/loadoutStore';
import { useTacticalEquipmentSelection } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import { TACTICAL_EQUIPMENT_LIST } from '../data/tacticalEquipment';

interface LobbyRoomViewProps {
  onOpenLoadoutWorkbench?: () => void;
}

export const LobbyRoomView: React.FC<LobbyRoomViewProps> = ({ onOpenLoadoutWorkbench }) => {
  const { user } = useAuth();
  const {
    lobby,
    isHost,
    error,
    clearError,
    leaveLobby,
    updateSettings,
    kickPlayer,
    switchTeam,
    toggleReady,
    sendChat,
    startMatch,
  } = useLobby();
  const { openDrawer: openSocialDrawer } = useSocial();
  const { selection: tacticalSelection, setEquipment: setTacticalEquipmentId } =
    useTacticalEquipmentSelection();
  const [personalKillfeed, setPersonalKillfeed] = useKillfeedPreference();
  const loadoutState = useLoadoutStore();
  const activeLoadout = loadoutState.slots[loadoutState.activeIndex] ?? loadoutState.slots[0];

  const [chatText, setChatText] = useState<string>('');
  const [copiedKey, setCopiedKey] = useState<'lobby' | 'event' | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lobby?.chat.length]);

  if (!lobby || !user) return null;

  const ev = lobby.specialEvent;
  const isSpecialEvent = Boolean(ev);
  const isTdm = lobby.mode === 'battle' && lobby.battleRule === 'tdm';
  const myMember = lobby.members.find((m) => m.userId === user.id);
  const availableMaps = lobby.mode === 'infection' ? ZOMBIE_MAPS : BATTLE_MAPS;

  const copyCode = (text: string, which: 'lobby' | 'event') => {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(which);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatText.trim()) return;
    sendChat(chatText);
    setChatText('');
  };

  const visibilityMeta: Record<LobbyVisibility, { label: string; desc: string }> = {
    public: { label: 'Public', desc: 'Anyone can see & join' },
    friends_only: { label: 'Friends-Only', desc: 'Visible only to your friends' },
    private: { label: 'Private', desc: 'Hidden from all unless invited' },
  };

  return (
    <div
      className={`flex w-full max-w-6xl flex-col border ${
        isSpecialEvent
          ? 'border-amber-500/70 bg-neutral-950/94'
          : 'border-neutral-800 bg-neutral-950/92'
      }`}
    >
      {/* === TOP HEADER (Distinct Special Event vs Standard Lobby) === */}
      {isSpecialEvent && ev ? (
        <div className="border-b border-amber-500/35 bg-gradient-to-r from-amber-950/50 via-neutral-950 to-neutral-950 px-6 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="font-mono-tabular text-[10px] uppercase tracking-[0.24em] text-amber-400">
                Special Event Lobby · {formatLobbyModeLabel(lobby.mode, lobby.battleRule)} ·{' '}
                {formatMapDisplayName(lobby.mapId)}
              </div>
              {/* Event Name (Top Header) */}
              <h2 className="mt-1 font-display text-3xl font-bold uppercase tracking-wide text-neutral-50 sm:text-4xl">
                {ev.name}
              </h2>
              {/* Creator's name directly underneath in smaller sub-header */}
              <div className="mt-0.5 font-mono-tabular text-xs uppercase tracking-wider text-amber-200/85">
                Created by {ev.creatorUsername}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => copyCode(ev.hashCode, 'event')}
                className="flex cursor-pointer items-center gap-2 whitespace-nowrap border border-amber-400/70 bg-amber-500/15 px-3 py-1.5 font-mono-tabular text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
                title="Share this Event Hash Code for instant direct join"
              >
                <span>HASH: {ev.hashCode}</span>
                {copiedKey === 'event' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => copyCode(lobby.code, 'lobby')}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-xs text-neutral-200 hover:border-neutral-500"
              >
                <span>{lobby.code}</span>
                {copiedKey === 'lobby' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-neutral-400" />
                )}
              </button>
              <button
                type="button"
                onClick={leaveLobby}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-red-800/80 bg-red-950/50 px-3 py-1.5 font-mono-tabular text-xs uppercase tracking-wider text-red-200 hover:bg-red-900/60"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Leave</span>
              </button>
            </div>
          </div>

          {/* Sandbox Event Rules Strip */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-amber-500/20 pt-2.5 font-mono-tabular text-[11px] text-neutral-300">
            <span>HP {ev.config.playerHealth}</span>
            <span className="text-neutral-600">·</span>
            <span>Speed {ev.config.playerMoveSpeedMult.toFixed(2)}x</span>
            <span className="text-neutral-600">·</span>
            <span>
              {ev.config.playerRespawnEnabled
                ? 'Player Respawn ON'
                : `Elimination · ${ev.config.livesPerRound} ${ev.config.livesPerRound === 1 ? 'Life' : 'Lives'}/Rd`}
            </span>
            <span className="text-neutral-600">·</span>
            <span>
              {ev.config.roundsPerMatch} {ev.config.roundsPerMatch === 1 ? 'Round' : 'Rounds'}
            </span>
            <span className="text-neutral-600">·</span>
            <span>
              {lobby.botsEnabled
                ? `Bots ${lobby.botCount} (HP ${ev.config.aiHealth}, Acc ${ev.config.aiAccuracyMult.toFixed(2)}x)`
                : 'Players Only (Bots OFF)'}
            </span>
            {ev.config.cycleModesBetweenGames && (
              <>
                <span className="text-neutral-600">·</span>
                <span className="text-sky-300">Mode Cycle ON</span>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="flex items-center gap-2 font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-sky-400">
              <span>Multiplayer Lobby</span>
              <span className="text-neutral-600">·</span>
              <span>{visibilityMeta[lobby.visibility].label}</span>
              <span className="text-neutral-600">·</span>
              <span>
                {lobby.members.length} / {lobby.maxPlayers} Operators
              </span>
            </div>
            <h2 className="mt-0.5 font-display text-3xl font-bold uppercase tracking-wide text-neutral-50">
              {formatLobbyModeLabel(lobby.mode, lobby.battleRule)} —{' '}
              {formatMapDisplayName(lobby.mapId)}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => copyCode(lobby.code, 'lobby')}
              className="flex cursor-pointer items-center gap-2 whitespace-nowrap border border-sky-500/60 bg-sky-500/15 px-3.5 py-1.5 font-mono-tabular text-xs font-semibold text-sky-200 hover:bg-sky-500/25"
            >
              <span>CODE: {lobby.code}</span>
              {copiedKey === 'lobby' ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={leaveLobby}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-red-800/80 bg-red-950/50 px-3 py-1.5 font-mono-tabular text-xs uppercase tracking-wider text-red-200 hover:bg-red-900/60"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Leave Lobby</span>
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between border-b border-red-700/70 bg-red-950/60 px-6 py-2 font-mono-tabular text-xs text-red-200">
          <span>{error}</span>
          <button type="button" onClick={clearError} className="cursor-pointer underline">
            Dismiss
          </button>
        </div>
      )}

      {/* === MAIN BODY: 2 COLUMNS (Settings + Roster / Chat) === */}
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-12">
        {/* Left: Lobby Controls (Host Editable vs Joined Read-Only) */}
        <div className="space-y-4 border-b border-neutral-800 p-5 lg:col-span-5 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between">
            <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-300">
              {isHost ? 'Host Configuration' : 'Match Configuration (Host Controlled)'}
            </div>
            {isHost && (
              <button
                type="button"
                onClick={() => openSocialDrawer('friends')}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-amber-400/70 bg-amber-500/15 px-2.5 py-1 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-amber-300 hover:bg-amber-500/25"
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Invite Friends</span>
              </button>
            )}
          </div>

          {/* Discovery / Privacy */}
          <div>
            <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
              Lobby Discovery
            </div>
            {isHost ? (
              <div className="mt-1.5 grid grid-cols-3 gap-1">
                {(
                  [
                    { id: 'public' as LobbyVisibility, label: 'Public', icon: Globe },
                    { id: 'friends_only' as LobbyVisibility, label: 'Friends', icon: Users },
                    { id: 'private' as LobbyVisibility, label: 'Private', icon: Lock },
                  ]
                ).map((v) => {
                  const Icon = v.icon;
                  const active = lobby.visibility === v.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => updateSettings({ visibility: v.id })}
                      className={`flex cursor-pointer items-center justify-center gap-1.5 border py-1.5 font-mono-tabular text-[11px] font-semibold ${
                        active
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      <span>{v.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-1 font-mono-tabular text-xs text-neutral-200">
                {visibilityMeta[lobby.visibility].label} — {visibilityMeta[lobby.visibility].desc}
              </div>
            )}
          </div>

          {/* Mode & Map */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Mode
              </div>
              {isHost ? (
                <select
                  value={
                    lobby.mode === 'infection'
                      ? 'infection'
                      : lobby.battleRule === 'ffa'
                        ? 'battle_ffa'
                        : 'battle_tdm'
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'infection') {
                      updateSettings({ mode: 'infection', mapId: 'kino_theater' });
                    } else {
                      updateSettings({
                        mode: 'battle',
                        battleRule: v === 'battle_ffa' ? 'ffa' : 'tdm',
                        mapId: lobby.mapId === 'kino_theater' ? 'pripyat_block' : lobby.mapId,
                      });
                    }
                  }}
                  className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                >
                  <option value="battle_tdm">Battle · TDM</option>
                  <option value="battle_ffa">Battle · FFA</option>
                  <option value="infection">Infection</option>
                </select>
              ) : (
                <div className="mt-1 font-mono-tabular text-xs text-neutral-100">
                  {formatLobbyModeLabel(lobby.mode, lobby.battleRule)}
                </div>
              )}
            </div>

            <div>
              <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Map
              </div>
              {isHost ? (
                <select
                  value={lobby.mapId}
                  onChange={(e) => updateSettings({ mapId: e.target.value })}
                  className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                >
                  {availableMaps.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="mt-1 font-mono-tabular text-xs text-neutral-100">
                  {formatMapDisplayName(lobby.mapId)}
                </div>
              )}
            </div>
          </div>

          {/* Max Players (2..8) & AI Bots ON/OFF + Stepper */}
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-neutral-800 bg-neutral-900/50 p-3">
              <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Max Players (2–8)
              </div>
              {isHost ? (
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={lobby.maxPlayers <= Math.max(2, lobby.members.length)}
                    onClick={() => updateSettings({ maxPlayers: lobby.maxPlayers - 1 })}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-display text-xl font-bold text-neutral-50">
                    {lobby.maxPlayers}
                  </span>
                  <button
                    type="button"
                    disabled={lobby.maxPlayers >= 8}
                    onClick={() => updateSettings({ maxPlayers: lobby.maxPlayers + 1 })}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="mt-1.5 font-display text-xl font-bold text-neutral-100">
                  {lobby.maxPlayers}
                </div>
              )}
            </div>

            <div className="border border-neutral-800 bg-neutral-900/50 p-3">
              <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                <span>AI Bots</span>
                {isHost ? (
                  <button
                    type="button"
                    onClick={() => updateSettings({ botsEnabled: !lobby.botsEnabled })}
                    className={`cursor-pointer border px-1.5 py-0.5 text-[10px] font-semibold ${
                      lobby.botsEnabled
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                        : 'border-neutral-700 bg-neutral-950 text-neutral-400'
                    }`}
                  >
                    {lobby.botsEnabled ? 'ON' : 'OFF'}
                  </button>
                ) : (
                  <span className={lobby.botsEnabled ? 'text-emerald-300' : 'text-neutral-500'}>
                    {lobby.botsEnabled ? 'ON' : 'OFF'}
                  </span>
                )}
              </div>
              {isHost ? (
                <div className="mt-2 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={!lobby.botsEnabled || lobby.botCount <= 0}
                    onClick={() => updateSettings({ botCount: Math.max(0, lobby.botCount - 1) })}
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="font-display text-xl font-bold text-neutral-50">
                    {lobby.botsEnabled ? lobby.botCount : 0}
                  </span>
                  <button
                    type="button"
                    disabled={lobby.botCount >= 10}
                    onClick={() =>
                      updateSettings({ botsEnabled: true, botCount: Math.min(10, lobby.botCount + 1) })
                    }
                    className="cursor-pointer border border-neutral-700 bg-neutral-950 p-1.5 text-neutral-200 hover:border-amber-400 disabled:opacity-35"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="mt-1.5 font-mono-tabular text-sm font-semibold text-neutral-100">
                  {lobby.botsEnabled ? `${lobby.botCount} Bots` : 'Players Only'}
                </div>
              )}
            </div>
          </div>

          {/* Battle Kill Limit & Difficulty */}
          {lobby.mode === 'battle' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  Kill Limit
                </div>
                {isHost ? (
                  <select
                    value={lobby.killLimit}
                    onChange={(e) => updateSettings({ killLimit: Number(e.target.value) })}
                    className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                  >
                    {[15, 20, 30, 40, 50, 75, 100].map((k) => (
                      <option key={k} value={k}>
                        {k} Kills
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="mt-1 font-mono-tabular text-xs text-neutral-200">
                    {lobby.killLimit} Kills
                  </div>
                )}
              </div>
              <div>
                <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  Bot Difficulty
                </div>
                {isHost ? (
                  <select
                    value={lobby.botDifficulty}
                    onChange={(e) =>
                      updateSettings({ botDifficulty: e.target.value as BotDifficultyId })
                    }
                    className="mt-1 w-full cursor-pointer border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
                  >
                    <option value="recruit">Recruit</option>
                    <option value="tactical">Tactical</option>
                    <option value="veteran">Veteran</option>
                  </select>
                ) : (
                  <div className="mt-1 font-mono-tabular text-xs capitalize text-neutral-200">
                    {lobby.botDifficulty}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Host Killfeed Policy Override & Personal Toggle */}
          <div className="border border-neutral-800 bg-neutral-900/50 p-3">
            <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
              <span>Killfeed HUD Policy</span>
              <span className="text-amber-300">
                {formatKillfeedPolicyLabel(lobby.killfeedPolicy ?? 'player_choice')}
              </span>
            </div>
            {isHost ? (
              <>
                <div className="mt-1.5 grid grid-cols-3 gap-1">
                  {(
                    [
                      { id: 'player_choice', label: 'Player' },
                      { id: 'force_on', label: 'Force On' },
                      { id: 'force_off', label: 'Force Off' },
                    ] as Array<{ id: LobbyKillfeedPolicy; label: string }>
                  ).map((opt) => {
                    const active = (lobby.killfeedPolicy ?? 'player_choice') === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => updateSettings({ killfeedPolicy: opt.id })}
                        className={`cursor-pointer border py-1 font-mono-tabular text-[10px] font-semibold uppercase transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                            : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 text-[10px] text-neutral-500">
                  Force On / Off overrides every joined player while in this lobby.
                </div>
              </>
            ) : (
              <div className="mt-1.5 flex items-center justify-between text-[11px]">
                {(() => {
                  const eff = resolveEffectiveKillfeed(
                    personalKillfeed,
                    lobby.killfeedPolicy ?? 'player_choice',
                  );
                  if (eff.overriddenByHost) {
                    return (
                      <span className="font-mono-tabular text-amber-300">
                        {eff.overrideLabel} (Locked by Host)
                      </span>
                    );
                  }
                  return (
                    <>
                      <span className="text-neutral-400">Personal Killfeed</span>
                      <button
                        type="button"
                        onClick={() => setPersonalKillfeed(!personalKillfeed)}
                        className={`cursor-pointer border px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase ${
                          personalKillfeed
                            ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                            : 'border-neutral-700 bg-neutral-950 text-neutral-400'
                        }`}
                      >
                        {personalKillfeed ? 'ON' : 'OFF'}
                      </button>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Active Loadout & Gunsmith Bench Quick Access */}
          <div className="border border-neutral-800 bg-neutral-900/50 p-3">
            <div className="flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
              <span>Active Loadout · {activeLoadout.name}</span>
              {onOpenLoadoutWorkbench && (
                <button
                  type="button"
                  onClick={onOpenLoadoutWorkbench}
                  className="cursor-pointer border border-sky-500/60 bg-sky-500/15 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold text-sky-300 hover:bg-sky-500/25"
                >
                  Open Gunsmith
                </button>
              )}
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1">
              {TACTICAL_EQUIPMENT_LIST.map((eq) => {
                const active = tacticalSelection.equipmentId === eq.id;
                return (
                  <button
                    key={eq.id}
                    type="button"
                    onClick={() => setTacticalEquipmentId(eq.id)}
                    className={`cursor-pointer border px-2 py-1 text-left font-mono-tabular text-[10px] font-semibold uppercase transition-colors ${
                      active
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                        : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                    }`}
                  >
                    {eq.shortName}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Action CTA: Host Launch Match vs Joined Ready/Team */}
          <div className="space-y-2 border-t border-neutral-800 pt-4">
            {isTdm && (
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => switchTeam('A')}
                  className={`cursor-pointer border py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider ${
                    myMember?.team === 'A'
                      ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  Join Team A
                </button>
                <button
                  type="button"
                  onClick={() => switchTeam('B')}
                  className={`cursor-pointer border py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider ${
                    myMember?.team === 'B'
                      ? 'border-orange-400 bg-orange-500/20 text-orange-200'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  Join Team B
                </button>
              </div>
            )}

            {isHost ? (
              <button
                type="button"
                onClick={startMatch}
                className="flex w-full cursor-pointer items-center justify-center gap-2 bg-amber-500 py-3 font-display text-base font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Launch Match</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={toggleReady}
                className={`flex w-full cursor-pointer items-center justify-center gap-2 border py-3 font-display text-base font-bold uppercase tracking-wider transition-colors ${
                  myMember?.ready
                    ? 'border-emerald-500 bg-emerald-600/25 text-emerald-200 hover:bg-emerald-600/35'
                    : 'border-amber-400 bg-amber-500 text-neutral-950 hover:bg-amber-400'
                }`}
              >
                <Shield className="h-4 w-4" />
                <span>{myMember?.ready ? 'Ready · Waiting for Host' : 'Mark Ready'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Right: Squad Roster & Live Lobby Chat */}
        <div className="flex flex-col justify-between p-5 lg:col-span-7">
          {/* Roster */}
          <div>
            <div className="flex items-center justify-between">
              <span className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-300">
                Squad Roster ({lobby.members.length}/{lobby.maxPlayers})
              </span>
              <span className="font-mono-tabular text-[11px] text-neutral-500">
                Host: {lobby.hostUsername}
              </span>
            </div>

            <div className="mt-2.5 space-y-1.5">
              {lobby.members.map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center justify-between gap-3 border border-neutral-800/90 bg-neutral-900/65 px-3 py-2"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {isTdm && (
                      <span
                        className={`w-8 text-center font-mono-tabular text-[10px] font-bold uppercase ${
                          m.team === 'A'
                            ? 'border border-sky-500/50 bg-sky-950/60 text-sky-300'
                            : 'border border-orange-500/50 bg-orange-950/60 text-orange-300'
                        }`}
                      >
                        T-{m.team}
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-mono-tabular text-xs font-semibold text-neutral-100">
                        <span className="truncate">{m.username}</span>
                        {m.isHost && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
                        {m.userId === user.id && (
                          <span className="text-[10px] text-neutral-500">(YOU)</span>
                        )}
                      </div>
                      <div className="font-mono-tabular text-[10px] text-neutral-400">
                        {formatRankLabel(m.rank, m.prestige)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`font-mono-tabular text-[10px] uppercase tracking-wider ${
                        m.ready ? 'text-emerald-400' : 'text-neutral-500'
                      }`}
                    >
                      {m.isHost ? 'HOST' : m.ready ? 'READY' : 'NOT READY'}
                    </span>
                    {isHost && !m.isHost && (
                      <button
                        type="button"
                        onClick={() => kickPlayer(m.userId)}
                        className="flex cursor-pointer items-center gap-1 border border-red-800/70 bg-red-950/40 px-2 py-1 font-mono-tabular text-[10px] uppercase text-red-300 hover:bg-red-900/60"
                        title={`Kick ${m.username}`}
                      >
                        <UserX className="h-3 w-3" />
                        <span>Kick</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Lobby Chat */}
          <div className="mt-5 flex flex-col border border-neutral-800 bg-neutral-950/90">
            <div className="border-b border-neutral-800 px-3 py-1.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
              Lobby Comms
            </div>
            <div className="h-36 space-y-1.5 overflow-y-auto px-3 py-2 font-mono-tabular text-xs">
              {lobby.chat.map((c) => (
                <div key={c.id} className="leading-snug">
                  {c.system ? (
                    <span className="text-neutral-500">[{c.text}]</span>
                  ) : (
                    <>
                      <span className="font-semibold text-amber-300">{c.username}: </span>
                      <span className="text-neutral-200">{c.text}</span>
                    </>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form
              onSubmit={handleChatSubmit}
              className="flex items-center border-t border-neutral-800"
            >
              <input
                type="text"
                maxLength={240}
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder="Message squad..."
                className="flex-1 bg-transparent px-3 py-2 font-mono-tabular text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
              />
              <button
                type="submit"
                className="cursor-pointer border-l border-neutral-800 px-3 py-2 text-neutral-300 hover:bg-neutral-900 hover:text-amber-300"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* === SPECIAL EVENT DESCRIPTION FOOTER (Omitted cleanly if empty) === */}
      {isSpecialEvent && ev && ev.description.trim().length > 0 && (
        <div className="border-t border-amber-500/30 bg-amber-950/20 px-6 py-3">
          <div className="font-mono-tabular text-[10px] uppercase tracking-[0.18em] text-amber-400/90">
            Event Briefing
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-200">{ev.description}</p>
        </div>
      )}
    </div>
  );
};

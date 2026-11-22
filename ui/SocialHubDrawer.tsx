import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Clock,
  RefreshCw,
  Search,
  Send,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSocial } from '../context/SocialContext';
import { formatRankLabel, getRankTitleInfo } from '../data/progression';
import { ApiError } from '../services/authApi';
import {
  FriendPresenceStatus,
  PlayerSearchEntry,
  searchPlayersByUsername,
} from '../services/socialApi';

type SocialTab = 'friends' | 'search' | 'requests' | 'recent';

function formatRelativeTime(tsMs: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - tsMs) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function presenceLabel(status: FriendPresenceStatus, lobbyMode?: string | null, eventName?: string | null): {
  text: string;
  colorClass: string;
  dotClass: string;
} {
  if (status === 'in_lobby') {
    const detail = eventName ? `Event: ${eventName}` : lobbyMode ? `Lobby · ${lobbyMode}` : 'In Lobby';
    return { text: detail, colorClass: 'text-sky-300', dotClass: 'bg-sky-400' };
  }
  if (status === 'in_match') {
    return {
      text: lobbyMode ? `In Match · ${lobbyMode}` : 'In Match',
      colorClass: 'text-amber-300',
      dotClass: 'bg-amber-400',
    };
  }
  if (status === 'online') {
    return { text: 'Online', colorClass: 'text-emerald-400', dotClass: 'bg-emerald-400' };
  }
  return { text: 'Offline', colorClass: 'text-neutral-500', dotClass: 'bg-neutral-600' };
}

export const SocialHubDrawer: React.FC = () => {
  const { user } = useAuth();
  const {
    friends,
    incomingRequests,
    outgoingRequests,
    recentPlayers,
    loading,
    wsConnected,
    drawerOpen,
    closeDrawer,
    requestedTab,
    setRequestedTab,
    activeLobby,
    refreshOverview,
    sendRequest,
    acceptRequest,
    declineRequest,
    cancelRequest,
    unfriend,
    inviteFriendToCurrentLobby,
    joinFriendLobbyHandlerRef,
  } = useSocial();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PlayerSearchEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const sortedFriends = useMemo(() => {
    const order: Record<FriendPresenceStatus, number> = {
      in_lobby: 0,
      in_match: 1,
      online: 2,
      offline: 3,
    };
    return [...friends].sort((a, b) => {
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return a.username.toLowerCase().localeCompare(b.username.toLowerCase());
    });
  }, [friends]);

  const onlineCount = useMemo(
    () => friends.filter((f) => f.status !== 'offline').length,
    [friends],
  );

  // Debounced player search when on Search tab
  useEffect(() => {
    if (!drawerOpen || requestedTab !== 'search') return;
    const trimmed = searchQuery.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchPlayersByUsername(trimmed)
        .then((players) => {
          if (!cancelled) setSearchResults(players);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, requestedTab, searchQuery]);

  if (!drawerOpen || !user) return null;

  const showFeedback = (kind: 'ok' | 'err', text: string) => {
    setFeedback({ kind, text });
    window.setTimeout(() => {
      setFeedback((prev) => (prev?.text === text ? null : prev));
    }, 4000);
  };

  const handleSendFriendRequest = async (targetUserId: string, targetName: string) => {
    setActionBusyId(targetUserId);
    try {
      const status = await sendRequest(targetUserId);
      setSearchResults((prev) =>
        prev.map((p) =>
          p.userId === targetUserId
            ? { ...p, relationship: status === 'accepted' ? 'friend' : 'outgoing' }
            : p,
        ),
      );
      showFeedback(
        'ok',
        status === 'accepted'
          ? `You and ${targetName} are now friends.`
          : `Friend request sent to ${targetName}.`,
      );
    } catch (err) {
      showFeedback('err', err instanceof ApiError ? err.message : 'Unable to send friend request.');
    } finally {
      setActionBusyId(null);
    }
  };

  const handleInviteFriend = async (friendUserId: string, friendName: string) => {
    setActionBusyId(`invite-${friendUserId}`);
    try {
      const { delivered } = await inviteFriendToCurrentLobby(friendUserId);
      showFeedback(
        'ok',
        delivered
          ? `Lobby invite sent to ${friendName}.`
          : `${friendName} is currently offline — invite could not be delivered live.`,
      );
    } catch (err) {
      showFeedback('err', err instanceof Error ? err.message : 'Could not send invite.');
    } finally {
      setActionBusyId(null);
    }
  };

  const tabs: Array<{ id: SocialTab; label: string; count?: number }> = [
    { id: 'friends', label: 'Friends', count: friends.length },
    { id: 'search', label: 'Search' },
    { id: 'requests', label: 'Requests', count: incomingRequests.length },
    { id: 'recent', label: 'Recent', count: recentPlayers.length },
  ];

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="social-hub-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDrawer();
      }}
    >
      <aside className="flex h-full w-full max-w-md flex-col border-l border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        {/* Drawer Header */}
        <div className="flex items-start justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 font-mono-tabular text-[11px] text-neutral-400">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  wsConnected ? 'bg-emerald-400' : 'bg-neutral-600'
                }`}
              />
              <span>{wsConnected ? 'Live Presence Connected' : 'Reconnecting Presence'}</span>
              <span>·</span>
              <span>{onlineCount} Online</span>
            </div>
            <h2
              id="social-hub-title"
              className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50"
            >
              Social Hub
            </h2>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refreshOverview()}
              aria-label="Refresh social list"
              className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Close Social Hub"
              className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 4-Tab Segmented Navigation */}
        <div className="grid grid-cols-4 border-b border-neutral-800 bg-neutral-900/40">
          {tabs.map((tab) => {
            const active = requestedTab === tab.id;
            const hasAlert = tab.id === 'requests' && incomingRequests.length > 0;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setRequestedTab(tab.id)}
                className={`cursor-pointer whitespace-nowrap border-b-2 py-2.5 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                  active
                    ? 'border-amber-400 bg-neutral-900 text-neutral-50'
                    : 'border-transparent text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <span>{tab.label}</span>
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span
                    className={`ml-1 ${
                      hasAlert ? 'text-amber-400' : 'text-neutral-500'
                    }`}
                  >
                    ({tab.count})
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Inline Action Feedback */}
        {feedback && (
          <div
            className={`border-b px-5 py-2.5 text-xs ${
              feedback.kind === 'ok'
                ? 'border-emerald-800/70 bg-emerald-950/40 text-emerald-200'
                : 'border-red-800/70 bg-red-950/40 text-red-200'
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* Active Tab Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* === FRIENDS TAB === */}
          {requestedTab === 'friends' && (
            <div className="flex flex-col gap-2.5">
              {sortedFriends.length === 0 ? (
                <div className="border border-neutral-800 bg-neutral-900/40 p-6 text-center">
                  <Users className="mx-auto h-6 w-6 text-neutral-500" />
                  <div className="mt-2 text-sm font-medium text-neutral-200">No friends yet</div>
                  <p className="mt-1 text-xs text-neutral-400">
                    Search by username to send friend requests and see when squadmates are online or in a lobby.
                  </p>
                  <button
                    type="button"
                    onClick={() => setRequestedTab('search')}
                    className="mt-4 cursor-pointer bg-amber-500 px-4 py-1.5 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
                  >
                    Search Players
                  </button>
                </div>
              ) : (
                sortedFriends.map((f) => {
                  const p = presenceLabel(f.status, f.lobbyMode, f.eventName);
                  const rInfo = getRankTitleInfo(f.rank);
                  const confirmingRemove = confirmRemoveId === f.userId;
                  return (
                    <div
                      key={f.userId}
                      className="flex flex-col gap-2 border border-neutral-800/90 bg-neutral-900/50 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="font-mono-tabular text-[10px] font-semibold"
                              style={{ color: rInfo.accentHex }}
                            >
                              R{f.rank}
                            </span>
                            <span className="truncate font-mono-tabular text-sm font-semibold text-neutral-100">
                              {f.username}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 font-mono-tabular text-[11px]">
                            <span className={`inline-block h-1.5 w-1.5 rounded-full ${p.dotClass}`} />
                            <span className={p.colorClass}>{p.text}</span>
                            <span className="text-neutral-600">·</span>
                            <span className="text-neutral-400">
                              {formatRankLabel(f.rank, f.prestige)}
                            </span>
                          </div>
                        </div>

                        {confirmingRemove ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={actionBusyId === f.userId}
                              onClick={async () => {
                                setActionBusyId(f.userId);
                                try {
                                  await unfriend(f.userId);
                                  setConfirmRemoveId(null);
                                  showFeedback('ok', `Removed ${f.username} from friends.`);
                                } finally {
                                  setActionBusyId(null);
                                }
                              }}
                              className="cursor-pointer border border-red-600 bg-red-600 px-2 py-1 font-mono-tabular text-[10px] font-semibold uppercase text-white"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmRemoveId(null)}
                              className="cursor-pointer border border-neutral-700 px-2 py-1 font-mono-tabular text-[10px] uppercase text-neutral-300"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveId(f.userId)}
                            title="Remove friend"
                            aria-label={`Remove ${f.username}`}
                            className="cursor-pointer p-1 text-neutral-500 transition-colors hover:text-red-400"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Contextual Lobby Actions */}
                      <div className="flex items-center gap-2 border-t border-neutral-800/70 pt-2">
                        <button
                          type="button"
                          disabled={
                            !activeLobby ||
                            !activeLobby.canInvite ||
                            actionBusyId === `invite-${f.userId}`
                          }
                          onClick={() => void handleInviteFriend(f.userId, f.username)}
                          className={`flex flex-1 items-center justify-center gap-1.5 border px-2.5 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider transition-colors ${
                            activeLobby && activeLobby.canInvite
                              ? 'cursor-pointer border-amber-500/70 bg-amber-500/12 text-amber-200 hover:bg-amber-500/25'
                              : 'cursor-not-allowed border-neutral-800 bg-neutral-950/60 text-neutral-600'
                          }`}
                        >
                          <Send className="h-3 w-3" />
                          <span>{activeLobby ? 'Invite to Lobby' : 'Invite (In Lobby)'}</span>
                        </button>

                        {f.joinable && f.lobbyCode && (
                          <button
                            type="button"
                            onClick={() => {
                              if (joinFriendLobbyHandlerRef.current && f.lobbyCode) {
                                joinFriendLobbyHandlerRef.current(f.lobbyCode);
                                closeDrawer();
                              } else {
                                showFeedback(
                                  'ok',
                                  `Lobby code ${f.lobbyCode} — live Lobby Join opens in Phase 3.`,
                                );
                              }
                            }}
                            className="cursor-pointer whitespace-nowrap border border-sky-400 bg-sky-500/15 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-sky-200 transition-colors hover:bg-sky-500/25"
                          >
                            Join
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* === SEARCH TAB === */}
          {requestedTab === 'search' && (
            <div className="flex flex-col gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search exact or partial username..."
                  aria-label="Search players by username"
                  autoFocus
                  className="w-full border border-neutral-700 bg-neutral-900 py-2.5 pr-3 pl-9 font-mono-tabular text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-amber-400 focus:outline-none"
                />
              </div>

              {searchQuery.trim().length < 2 ? (
                <div className="border border-neutral-800/80 bg-neutral-900/30 p-4 text-xs text-neutral-400">
                  Type at least 2 characters of a player&apos;s username to find accounts and send a friend request.
                </div>
              ) : searching ? (
                <div className="p-4 text-center font-mono-tabular text-xs text-neutral-400">
                  Searching callsigns...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="border border-neutral-800/80 bg-neutral-900/30 p-4 text-xs text-neutral-400">
                  No accounts found matching &ldquo;{searchQuery.trim()}&rdquo;.
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {searchResults.map((p) => {
                    const rInfo = getRankTitleInfo(p.rank);
                    return (
                      <div
                        key={p.userId}
                        className="flex items-center justify-between gap-3 border border-neutral-800 bg-neutral-900/50 px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono-tabular text-sm font-semibold text-neutral-100">
                            {p.username}
                          </div>
                          <div className="font-mono-tabular text-[11px] text-neutral-400">
                            <span style={{ color: rInfo.accentHex }}>{rInfo.title}</span> · Rank{' '}
                            {p.rank}
                          </div>
                        </div>

                        {p.relationship === 'friend' ? (
                          <span className="shrink-0 font-mono-tabular text-[11px] text-emerald-400">
                            Friends
                          </span>
                        ) : p.relationship === 'outgoing' ? (
                          <span className="shrink-0 font-mono-tabular text-[11px] text-neutral-400">
                            Requested
                          </span>
                        ) : p.relationship === 'incoming' && p.requestId ? (
                          <button
                            type="button"
                            disabled={actionBusyId === p.requestId}
                            onClick={async () => {
                              if (!p.requestId) return;
                              setActionBusyId(p.requestId);
                              try {
                                await acceptRequest(p.requestId);
                                setSearchResults((prev) =>
                                  prev.map((x) =>
                                    x.userId === p.userId ? { ...x, relationship: 'friend' } : x,
                                  ),
                                );
                                showFeedback('ok', `Added ${p.username} as a friend.`);
                              } finally {
                                setActionBusyId(null);
                              }
                            }}
                            className="cursor-pointer whitespace-nowrap shrink-0 bg-emerald-500 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase text-neutral-950 hover:bg-emerald-400"
                          >
                            Accept
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={actionBusyId === p.userId}
                            onClick={() => void handleSendFriendRequest(p.userId, p.username)}
                            className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 bg-amber-500 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase text-neutral-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
                          >
                            <UserPlus className="h-3 w-3" />
                            <span>Add Friend</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* === REQUESTS TAB === */}
          {requestedTab === 'requests' && (
            <div className="flex flex-col gap-5">
              {/* Incoming */}
              <section>
                <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-400">
                  Incoming Requests ({incomingRequests.length})
                </div>
                {incomingRequests.length === 0 ? (
                  <div className="mt-2 border border-neutral-800/80 bg-neutral-900/30 p-3.5 text-xs text-neutral-500">
                    No incoming friend requests.
                  </div>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {incomingRequests.map((req) => (
                      <div
                        key={req.id}
                        className="flex items-center justify-between gap-2 border border-neutral-800 bg-neutral-900/50 px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono-tabular text-sm font-semibold text-neutral-100">
                            {req.username}
                          </div>
                          <div className="font-mono-tabular text-[11px] text-neutral-400">
                            {formatRankLabel(req.rank, req.prestige)} ·{' '}
                            {formatRelativeTime(req.createdAt)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={actionBusyId === req.id}
                            onClick={async () => {
                              setActionBusyId(req.id);
                              try {
                                await acceptRequest(req.id);
                                showFeedback('ok', `${req.username} added to your friends list.`);
                              } finally {
                                setActionBusyId(null);
                              }
                            }}
                            className="flex cursor-pointer items-center gap-1 bg-amber-500 px-2.5 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase text-neutral-950 hover:bg-amber-400"
                          >
                            <Check className="h-3 w-3" />
                            <span>Accept</span>
                          </button>
                          <button
                            type="button"
                            disabled={actionBusyId === req.id}
                            onClick={async () => {
                              setActionBusyId(req.id);
                              try {
                                await declineRequest(req.id);
                              } finally {
                                setActionBusyId(null);
                              }
                            }}
                            className="cursor-pointer border border-neutral-700 px-2.5 py-1.5 font-mono-tabular text-[11px] uppercase text-neutral-300 hover:border-neutral-500"
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Outgoing */}
              <section>
                <div className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
                  Outgoing Requests ({outgoingRequests.length})
                </div>
                {outgoingRequests.length === 0 ? (
                  <div className="mt-2 border border-neutral-800/80 bg-neutral-900/30 p-3.5 text-xs text-neutral-500">
                    No pending outgoing requests.
                  </div>
                ) : (
                  <div className="mt-2 flex flex-col gap-2">
                    {outgoingRequests.map((req) => (
                      <div
                        key={req.id}
                        className="flex items-center justify-between gap-2 border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono-tabular text-sm font-semibold text-neutral-100">
                            {req.username}
                          </div>
                          <div className="font-mono-tabular text-[11px] text-neutral-400">
                            Pending · {formatRelativeTime(req.createdAt)}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={actionBusyId === req.id}
                          onClick={async () => {
                            setActionBusyId(req.id);
                            try {
                              await cancelRequest(req.id);
                              showFeedback('ok', `Cancelled request to ${req.username}.`);
                            } finally {
                              setActionBusyId(null);
                            }
                          }}
                          className="cursor-pointer shrink-0 border border-neutral-700 px-2.5 py-1.5 font-mono-tabular text-[11px] uppercase text-neutral-300 hover:border-red-500/70 hover:text-red-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* === RECENT PLAYERS TAB === */}
          {requestedTab === 'recent' && (
            <div className="flex flex-col gap-2.5">
              {recentPlayers.length === 0 ? (
                <div className="border border-neutral-800 bg-neutral-900/40 p-6 text-center">
                  <Clock className="mx-auto h-6 w-6 text-neutral-500" />
                  <div className="mt-2 text-sm font-medium text-neutral-200">
                    No recent players yet
                  </div>
                  <p className="mt-1 text-xs text-neutral-400">
                    Players you share a multiplayer Battle, Infection, or Special Event match with appear here automatically (latest 25).
                  </p>
                </div>
              ) : (
                recentPlayers.map((rp) => (
                  <div
                    key={rp.userId}
                    className="flex items-center justify-between gap-3 border border-neutral-800 bg-neutral-900/50 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono-tabular text-sm font-semibold text-neutral-100">
                        {rp.username}
                      </div>
                      <div className="font-mono-tabular text-[11px] text-neutral-400">
                        {rp.mode.toUpperCase()} · {formatRelativeTime(rp.lastPlayedAt)} · Rank{' '}
                        {rp.rank}
                      </div>
                    </div>

                    {rp.relationship === 'friend' ? (
                      <span className="shrink-0 font-mono-tabular text-[11px] text-emerald-400">
                        Friends
                      </span>
                    ) : rp.relationship === 'outgoing' ? (
                      <span className="shrink-0 font-mono-tabular text-[11px] text-neutral-400">
                        Requested
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={actionBusyId === rp.userId}
                        onClick={() => void handleSendFriendRequest(rp.userId, rp.username)}
                        className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 bg-amber-500 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase text-neutral-950 hover:bg-amber-400"
                      >
                        <UserPlus className="h-3 w-3" />
                        <span>Add Friend</span>
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

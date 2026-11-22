import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  acceptFriendRequest,
  cancelOutgoingFriendRequest,
  declineFriendRequest,
  fetchSocialOverview,
  FriendEntry,
  FriendPresenceStatus,
  FriendRequestEntry,
  LobbyInvitePayload,
  RecentPlayerEntry,
  removeFriend,
  sendFriendRequest,
} from '../services/socialApi';
import { invitePlayerToLobby } from '../services/lobbyApi';
import { useAuth } from './AuthContext';

export interface ActiveLobbyContextMeta {
  lobbyCode: string;
  visibility: 'public' | 'friends_only' | 'private';
  mode: string;
  mapName: string;
  eventName?: string | null;
  canInvite: boolean;
}

export interface SocialNoticeToast {
  id: string;
  title: string;
  body: string;
  actionLabel?: string;
  createdAt: number;
}

interface SocialContextValue {
  friends: FriendEntry[];
  incomingRequests: FriendRequestEntry[];
  outgoingRequests: FriendRequestEntry[];
  recentPlayers: RecentPlayerEntry[];
  pendingInvites: LobbyInvitePayload[];
  notices: SocialNoticeToast[];
  loading: boolean;
  wsConnected: boolean;
  drawerOpen: boolean;
  activeLobby: ActiveLobbyContextMeta | null;
  openDrawer: (initialTab?: 'friends' | 'search' | 'requests' | 'recent') => void;
  closeDrawer: () => void;
  requestedTab: 'friends' | 'search' | 'requests' | 'recent';
  setRequestedTab: (tab: 'friends' | 'search' | 'requests' | 'recent') => void;
  refreshOverview: () => Promise<void>;
  updatePresence: (
    status: Exclude<FriendPresenceStatus, 'offline'>,
    lobbyMeta?: ActiveLobbyContextMeta | null,
  ) => void;
  setActiveLobby: (meta: ActiveLobbyContextMeta | null) => void;
  sendRequest: (targetUserId: string) => Promise<'pending' | 'accepted'>;
  acceptRequest: (requestId: string) => Promise<void>;
  declineRequest: (requestId: string) => Promise<void>;
  cancelRequest: (requestId: string) => Promise<void>;
  unfriend: (friendUserId: string) => Promise<void>;
  inviteFriendToCurrentLobby: (targetUserId: string) => Promise<{ delivered: boolean }>;
  dismissInvite: (inviteId: string) => void;
  dismissNotice: (noticeId: string) => void;
  acceptInviteHandlerRef: React.MutableRefObject<((invite: LobbyInvitePayload) => void) | null>;
  joinFriendLobbyHandlerRef: React.MutableRefObject<((lobbyCode: string) => void) | null>;
}

const SocialContext = createContext<SocialContextValue | null>(null);

export const SocialProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, requireAuth } = useAuth();
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<FriendRequestEntry[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<FriendRequestEntry[]>([]);
  const [recentPlayers, setRecentPlayers] = useState<RecentPlayerEntry[]>([]);
  const [pendingInvites, setPendingInvites] = useState<LobbyInvitePayload[]>([]);
  const [notices, setNotices] = useState<SocialNoticeToast[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [requestedTab, setRequestedTab] = useState<'friends' | 'search' | 'requests' | 'recent'>(
    'friends',
  );
  const [activeLobby, setActiveLobbyState] = useState<ActiveLobbyContextMeta | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const latestPresenceRef = useRef<{
    status: Exclude<FriendPresenceStatus, 'offline'>;
    lobbyMeta: ActiveLobbyContextMeta | null;
  }>({ status: 'online', lobbyMeta: null });

  const acceptInviteHandlerRef = useRef<((invite: LobbyInvitePayload) => void) | null>(null);
  const joinFriendLobbyHandlerRef = useRef<((lobbyCode: string) => void) | null>(null);

  const pushNotice = useCallback((title: string, body: string, actionLabel?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setNotices((prev) => [{ id, title, body, actionLabel, createdAt: Date.now() }, ...prev].slice(0, 4));
    window.setTimeout(() => {
      setNotices((prev) => prev.filter((n) => n.id !== id));
    }, 6500);
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!user) {
      setFriends([]);
      setIncomingRequests([]);
      setOutgoingRequests([]);
      setRecentPlayers([]);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchSocialOverview();
      setFriends(data.friends);
      setIncomingRequests(data.incomingRequests);
      setOutgoingRequests(data.outgoingRequests);
      setRecentPlayers(data.recentPlayers);
    } catch {
      // Retain last known list on transient failure
    } finally {
      setLoading(false);
    }
  }, [user]);

  const sendPresenceOverSocket = useCallback(
    (
      ws: WebSocket | null,
      status: Exclude<FriendPresenceStatus, 'offline'>,
      lobbyMeta: ActiveLobbyContextMeta | null,
    ) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'presence:update',
          status,
          lobbyCode: lobbyMeta?.lobbyCode ?? null,
          lobbyVisibility: lobbyMeta?.visibility ?? null,
          lobbyMode: lobbyMeta?.mode ?? null,
          eventName: lobbyMeta?.eventName ?? null,
          joinable:
            Boolean(lobbyMeta) &&
            lobbyMeta?.visibility !== 'private' &&
            status === 'in_lobby',
        }),
      );
    },
    [],
  );

  const updatePresence = useCallback(
    (
      status: Exclude<FriendPresenceStatus, 'offline'>,
      lobbyMeta?: ActiveLobbyContextMeta | null,
    ) => {
      const nextMeta = lobbyMeta === undefined ? latestPresenceRef.current.lobbyMeta : lobbyMeta;
      latestPresenceRef.current = { status, lobbyMeta: nextMeta };
      sendPresenceOverSocket(wsRef.current, status, nextMeta);
    },
    [sendPresenceOverSocket],
  );

  const setActiveLobby = useCallback(
    (meta: ActiveLobbyContextMeta | null) => {
      setActiveLobbyState(meta);
      updatePresence(meta ? 'in_lobby' : 'online', meta);
    },
    [updatePresence],
  );

  // Connect & auto-reconnect to /ws/social whenever signed in
  useEffect(() => {
    if (!user) {
      setDrawerOpen(false);
      setFriends([]);
      setIncomingRequests([]);
      setOutgoingRequests([]);
      setRecentPlayers([]);
      setPendingInvites([]);
      setWsConnected(false);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    let cancelled = false;
    void refreshOverview();

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/social`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        setWsConnected(true);
        sendPresenceOverSocket(
          ws,
          latestPresenceRef.current.status,
          latestPresenceRef.current.lobbyMeta,
        );
        if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (msg.type === 'presence:changed' && msg.presence && typeof msg.presence === 'object') {
            const p = msg.presence as {
              userId: string;
              username?: string;
              rank?: number;
              prestige?: number;
              status: FriendPresenceStatus;
              lobbyCode?: string | null;
              lobbyVisibility?: 'public' | 'friends_only' | 'private' | null;
              lobbyMode?: string | null;
              eventName?: string | null;
              joinable?: boolean;
            };
            setFriends((prev) =>
              prev.map((f) =>
                f.userId === p.userId
                  ? {
                      ...f,
                      username: p.username ?? f.username,
                      rank: p.rank ?? f.rank,
                      prestige: p.prestige ?? f.prestige,
                      status: p.status,
                      lobbyCode: p.lobbyCode ?? null,
                      lobbyVisibility: p.lobbyVisibility ?? null,
                      lobbyMode: p.lobbyMode ?? null,
                      eventName: p.eventName ?? null,
                      joinable: Boolean(p.joinable),
                    }
                  : f,
              ),
            );
          } else if (msg.type === 'social:refresh') {
            void refreshOverview();
            if (typeof msg.notice === 'string' && msg.notice.trim()) {
              pushNotice('Social Update', msg.notice);
            }
          } else if (msg.type === 'social:friend_request') {
            void refreshOverview();
            const fromName = typeof msg.fromUsername === 'string' ? msg.fromUsername : 'A player';
            pushNotice('Friend Request', `${fromName} sent you a friend request.`, 'View');
          } else if (msg.type === 'lobby:invite' && msg.invite && typeof msg.invite === 'object') {
            const inv = msg.invite as LobbyInvitePayload;
            setPendingInvites((prev) => {
              if (prev.some((x) => x.id === inv.id)) return prev;
              return [inv, ...prev].slice(0, 4);
            });
            window.setTimeout(() => {
              setPendingInvites((prev) => prev.filter((x) => x.id !== inv.id));
            }, 30000);
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (!cancelled) {
          reconnectTimerRef.current = window.setTimeout(connect, 3500);
        }
      };

      ws.onerror = () => {
        // Handled by onclose reconnect
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current !== null) {
        window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [user, refreshOverview, pushNotice, sendPresenceOverSocket]);

  const openDrawer = useCallback(
    (initialTab?: 'friends' | 'search' | 'requests' | 'recent') => {
      requireAuth(
        'Sign in to open the Social Hub, manage friends, view live online status, and send lobby invites.',
        () => {
          if (initialTab) setRequestedTab(initialTab);
          setDrawerOpen(true);
          void refreshOverview();
        },
      );
    },
    [requireAuth, refreshOverview],
  );

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const sendRequest = useCallback(
    async (targetUserId: string) => {
      const res = await sendFriendRequest(targetUserId);
      await refreshOverview();
      return res.status;
    },
    [refreshOverview],
  );

  const acceptRequest = useCallback(
    async (requestId: string) => {
      await acceptFriendRequest(requestId);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const declineRequest = useCallback(
    async (requestId: string) => {
      await declineFriendRequest(requestId);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const cancelRequest = useCallback(
    async (requestId: string) => {
      await cancelOutgoingFriendRequest(requestId);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const unfriend = useCallback(
    async (friendUserId: string) => {
      await removeFriend(friendUserId);
      await refreshOverview();
    },
    [refreshOverview],
  );

  const inviteFriendToCurrentLobby = useCallback(
    async (targetUserId: string) => {
      if (!activeLobby) {
        throw new Error('Create or join a lobby first to invite friends.');
      }
      const res = await invitePlayerToLobby(activeLobby.lobbyCode, targetUserId);
      return { delivered: res.delivered };
    },
    [activeLobby],
  );

  const dismissInvite = useCallback((inviteId: string) => {
    setPendingInvites((prev) => prev.filter((i) => i.id !== inviteId));
  }, []);

  const dismissNotice = useCallback((noticeId: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== noticeId));
  }, []);

  const value = useMemo<SocialContextValue>(
    () => ({
      friends,
      incomingRequests,
      outgoingRequests,
      recentPlayers,
      pendingInvites,
      notices,
      loading,
      wsConnected,
      drawerOpen,
      activeLobby,
      openDrawer,
      closeDrawer,
      requestedTab,
      setRequestedTab,
      refreshOverview,
      updatePresence,
      setActiveLobby,
      sendRequest,
      acceptRequest,
      declineRequest,
      cancelRequest,
      unfriend,
      inviteFriendToCurrentLobby,
      dismissInvite,
      dismissNotice,
      acceptInviteHandlerRef,
      joinFriendLobbyHandlerRef,
    }),
    [
      friends,
      incomingRequests,
      outgoingRequests,
      recentPlayers,
      pendingInvites,
      notices,
      loading,
      wsConnected,
      drawerOpen,
      activeLobby,
      openDrawer,
      closeDrawer,
      requestedTab,
      refreshOverview,
      updatePresence,
      setActiveLobby,
      sendRequest,
      acceptRequest,
      declineRequest,
      cancelRequest,
      unfriend,
      inviteFriendToCurrentLobby,
      dismissInvite,
      dismissNotice,
    ],
  );

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>;
};

export function useSocial(): SocialContextValue {
  const ctx = useContext(SocialContext);
  if (!ctx) {
    throw new Error('useSocial must be used inside SocialProvider');
  }
  return ctx;
}

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
  formatLobbyModeLabel,
  formatMapDisplayName,
  LobbyBrowserEntry,
  LobbyChatMessage,
  LobbyRoomState,
  LobbySettingsPatch,
  LobbyTeamId,
  LobbyVisibility,
  SpecialEventConfig,
  SpecialEventRecord,
} from '../data/multiplayer';
import {
  createLobby,
  CreateLobbyPayload,
  createSpecialEvent,
  deleteSpecialEvent,
  fetchLobbyBrowser,
  fetchMySpecialEvents,
  resolveLobbyOrEventJoin,
  updateSpecialEvent,
} from '../services/lobbyApi';
import { useAuth } from './AuthContext';
import { useSocial } from './SocialContext';

export interface MatchLifecycleSignal {
  kind: 'start' | 'restart' | 'end_to_lobby';
  lobby: LobbyRoomState;
  seq: number;
}

interface LobbyContextValue {
  lobby: LobbyRoomState | null;
  isHost: boolean;
  connecting: boolean;
  error: string | null;
  kickedNotice: string | null;
  savedEvents: SpecialEventRecord[];
  publicLobbies: LobbyBrowserEntry[];
  friendLobbies: LobbyBrowserEntry[];
  browserLoading: boolean;
  matchSignal: MatchLifecycleSignal | null;
  clearError: () => void;
  clearKickedNotice: () => void;
  refreshBrowser: () => Promise<void>;
  refreshEvents: () => Promise<void>;
  saveEvent: (payload: {
    id?: string;
    name: string;
    description: string;
    config: SpecialEventConfig;
  }) => Promise<SpecialEventRecord>;
  removeEvent: (eventId: string) => Promise<void>;
  hostStandardLobby: (payload: CreateLobbyPayload) => Promise<void>;
  hostSpecialEvent: (eventId: string, visibility: LobbyVisibility) => Promise<void>;
  joinByCodeOrHash: (codeOrHash: string) => Promise<void>;
  joinLobbyDirect: (lobbyCode: string, eventHash?: string | null) => Promise<void>;
  leaveLobby: () => void;
  updateSettings: (patch: LobbySettingsPatch) => void;
  kickPlayer: (targetUserId: string) => void;
  switchTeam: (team: LobbyTeamId) => void;
  toggleReady: () => void;
  sendChat: (text: string) => void;
  startMatch: () => void;
  hostRestartMatch: () => void;
  hostEndMatchToLobby: () => void;
  sendGameMessage: (payload: Record<string, unknown>) => void;
  subscribeGameMessages: (listener: (msg: Record<string, unknown>) => void) => () => void;
}

const LobbyContext = createContext<LobbyContextValue | null>(null);

export const LobbyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const {
    setActiveLobby,
    updatePresence,
    acceptInviteHandlerRef,
    joinFriendLobbyHandlerRef,
    closeDrawer,
  } = useSocial();

  const [lobby, setLobby] = useState<LobbyRoomState | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [kickedNotice, setKickedNotice] = useState<string | null>(null);
  const [savedEvents, setSavedEvents] = useState<SpecialEventRecord[]>([]);
  const [publicLobbies, setPublicLobbies] = useState<LobbyBrowserEntry[]>([]);
  const [friendLobbies, setFriendLobbies] = useState<LobbyBrowserEntry[]>([]);
  const [browserLoading, setBrowserLoading] = useState<boolean>(false);
  const [matchSignal, setMatchSignal] = useState<MatchLifecycleSignal | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const signalCounterRef = useRef<number>(0);
  const gameListenersRef = useRef<Set<(msg: Record<string, unknown>) => void>>(new Set());
  const lastMatchSyncRef = useRef<Record<string, unknown> | null>(null);

  const isHost = Boolean(user && lobby && lobby.hostUserId === user.id);

  const closeSocketOnly = useCallback(() => {
    lastMatchSyncRef.current = null;
    if (pingTimerRef.current !== null) {
      window.clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
    if (wsRef.current) {
      const sock = wsRef.current;
      wsRef.current = null;
      try {
        sock.onclose = null;
        sock.onerror = null;
        sock.onmessage = null;
        sock.close(1000, 'Switching lobby');
      } catch {
        // Ignore close errors
      }
    }
  }, []);

  const refreshBrowser = useCallback(async () => {
    if (!user) {
      setPublicLobbies([]);
      setFriendLobbies([]);
      return;
    }
    setBrowserLoading(true);
    try {
      const data = await fetchLobbyBrowser();
      setPublicLobbies(data.publicLobbies);
      setFriendLobbies(data.friendLobbies);
    } catch {
      // Keep last known browser entries
    } finally {
      setBrowserLoading(false);
    }
  }, [user]);

  const refreshEvents = useCallback(async () => {
    if (!user) {
      setSavedEvents([]);
      return;
    }
    try {
      const data = await fetchMySpecialEvents();
      setSavedEvents(data.events);
    } catch {
      // Keep last known saved events
    }
  }, [user]);

  const connectToLobbySocket = useCallback(
    (code: string, eventHash?: string | null) => {
      closeSocketOnly();
      setConnecting(true);
      setError(null);
      setKickedNotice(null);

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = eventHash ? `?eventHash=${encodeURIComponent(eventHash)}` : '';
      const ws = new WebSocket(
        `${proto}//${window.location.host}/ws/lobby/${encodeURIComponent(code)}${qs}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnecting(false);
        if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (msg.type === 'lobby:state' && msg.state) {
            setLobby(msg.state as LobbyRoomState);
          } else if (msg.type === 'lobby:chat' && msg.message) {
            const chatMsg = msg.message as LobbyChatMessage;
            setLobby((prev) =>
              prev ? { ...prev, chat: [...prev.chat.slice(-49), chatMsg] } : prev,
            );
          } else if (msg.type === 'lobby:error' && typeof msg.error === 'string') {
            setError(msg.error);
          } else if (msg.type === 'lobby:kicked') {
            const reason =
              typeof msg.reason === 'string' ? msg.reason : 'You were kicked by the lobby Host.';
            setKickedNotice(reason);
            setLobby(null);
            closeSocketOnly();
          } else if (msg.type === 'match:start' && msg.state) {
            lastMatchSyncRef.current = null;
            const st = msg.state as LobbyRoomState;
            setLobby(st);
            signalCounterRef.current += 1;
            setMatchSignal({ kind: 'start', lobby: st, seq: signalCounterRef.current });
          } else if (msg.type === 'match:restart' && msg.state) {
            lastMatchSyncRef.current = null;
            const st = msg.state as LobbyRoomState;
            setLobby(st);
            signalCounterRef.current += 1;
            setMatchSignal({ kind: 'restart', lobby: st, seq: signalCounterRef.current });
          } else if (msg.type === 'match:end_to_lobby' && msg.state) {
            lastMatchSyncRef.current = null;
            const st = msg.state as LobbyRoomState;
            setLobby(st);
            signalCounterRef.current += 1;
            setMatchSignal({ kind: 'end_to_lobby', lobby: st, seq: signalCounterRef.current });
          } else if (typeof msg.type === 'string' && msg.type.startsWith('game:')) {
            if (msg.type === 'game:match_sync') {
              lastMatchSyncRef.current = msg;
            }
            for (const fn of gameListenersRef.current) {
              fn(msg);
            }
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = (ev) => {
        setConnecting(false);
        if (pingTimerRef.current !== null) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (wsRef.current === ws) {
          wsRef.current = null;
          setLobby((prev) => {
            if (prev && ev.code !== 1000 && ev.code !== 4003) {
              setError('Disconnected from lobby room.');
            }
            return null;
          });
        }
      };

      ws.onerror = () => {
        setConnecting(false);
      };
    },
    [closeSocketOnly],
  );

  // Sync lobby presence into SocialContext whenever lobby updates
  useEffect(() => {
    if (!lobby || !user) {
      setActiveLobby(null);
      return;
    }
    const meta = {
      lobbyCode: lobby.code,
      visibility: lobby.visibility,
      mode: formatLobbyModeLabel(lobby.mode, lobby.battleRule),
      mapName: formatMapDisplayName(lobby.mapId),
      eventName: lobby.specialEvent?.name ?? null,
      canInvite: lobby.hostUserId === user.id,
    };
    setActiveLobby(meta);
    if (lobby.status === 'in_match') {
      updatePresence('in_match', meta);
    }
  }, [lobby, user, setActiveLobby, updatePresence]);

  // Clean up on sign-out
  useEffect(() => {
    if (!user) {
      closeSocketOnly();
      setLobby(null);
      setSavedEvents([]);
      setPublicLobbies([]);
      setFriendLobbies([]);
      return;
    }
    void refreshEvents();
    void refreshBrowser();
  }, [user, closeSocketOnly, refreshEvents, refreshBrowser]);

  const leaveLobby = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'lobby:leave' }));
      } catch {
        // Ignore
      }
    }
    closeSocketOnly();
    setLobby(null);
    setError(null);
    void refreshBrowser();
  }, [closeSocketOnly, refreshBrowser]);

  const joinLobbyDirect = useCallback(
    async (lobbyCode: string, eventHash?: string | null) => {
      const normalized = lobbyCode.trim().toUpperCase();
      if (!normalized) return;
      setError(null);
      setKickedNotice(null);
      try {
        if (!eventHash) {
          await resolveLobbyOrEventJoin(normalized);
        }
        connectToLobbySocket(normalized, eventHash ?? null);
        closeDrawer();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to join lobby.';
        setError(message);
        throw err;
      }
    },
    [connectToLobbySocket, closeDrawer],
  );

  const joinByCodeOrHash = useCallback(
    async (codeOrHash: string) => {
      const trimmed = codeOrHash.trim().toUpperCase();
      if (!trimmed) {
        setError('Enter a Lobby Code or Event Hash Code.');
        return;
      }
      setError(null);
      setKickedNotice(null);
      try {
        const resolved = await resolveLobbyOrEventJoin(trimmed);
        connectToLobbySocket(resolved.lobbyCode, resolved.eventHash);
        closeDrawer();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not join with that code.';
        setError(message);
        throw err;
      }
    },
    [connectToLobbySocket, closeDrawer],
  );

  // Wire SocialContext instant Invite Toast Accept & Friend "Join" buttons directly into LobbyContext!
  useEffect(() => {
    acceptInviteHandlerRef.current = (invite) => {
      void joinLobbyDirect(invite.lobbyCode);
    };
    joinFriendLobbyHandlerRef.current = (lobbyCode) => {
      void joinLobbyDirect(lobbyCode);
    };
    return () => {
      acceptInviteHandlerRef.current = null;
      joinFriendLobbyHandlerRef.current = null;
    };
  }, [acceptInviteHandlerRef, joinFriendLobbyHandlerRef, joinLobbyDirect]);

  const hostStandardLobby = useCallback(
    async (payload: CreateLobbyPayload) => {
      setError(null);
      setKickedNotice(null);
      const res = await createLobby(payload);
      if (res.lobby) {
        setLobby(res.lobby);
      }
      connectToLobbySocket(res.code);
      void refreshBrowser();
    },
    [connectToLobbySocket, refreshBrowser],
  );

  const hostSpecialEvent = useCallback(
    async (eventId: string, visibility: LobbyVisibility) => {
      setError(null);
      setKickedNotice(null);
      const res = await createLobby({ visibility, specialEventId: eventId });
      if (res.lobby) {
        setLobby(res.lobby);
      }
      connectToLobbySocket(res.code);
      void refreshBrowser();
    },
    [connectToLobbySocket, refreshBrowser],
  );

  const saveEvent = useCallback(
    async (payload: {
      id?: string;
      name: string;
      description: string;
      config: SpecialEventConfig;
    }) => {
      const res = payload.id
        ? await updateSpecialEvent(payload.id, {
            name: payload.name,
            description: payload.description,
            config: payload.config,
          })
        : await createSpecialEvent({
            name: payload.name,
            description: payload.description,
            config: payload.config,
          });
      await refreshEvents();
      return res.event;
    },
    [refreshEvents],
  );

  const removeEvent = useCallback(
    async (eventId: string) => {
      await deleteSpecialEvent(eventId);
      await refreshEvents();
    },
    [refreshEvents],
  );

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const updateSettings = useCallback(
    (patch: LobbySettingsPatch) => sendWs({ type: 'lobby:update_settings', patch }),
    [sendWs],
  );

  const kickPlayer = useCallback(
    (targetUserId: string) => sendWs({ type: 'lobby:kick', targetUserId }),
    [sendWs],
  );

  const switchTeam = useCallback(
    (team: LobbyTeamId) => sendWs({ type: 'lobby:switch_team', team }),
    [sendWs],
  );

  const toggleReady = useCallback(() => sendWs({ type: 'lobby:toggle_ready' }), [sendWs]);

  const sendChat = useCallback(
    (text: string) => {
      const cleaned = text.trim();
      if (cleaned) sendWs({ type: 'lobby:chat', text: cleaned });
    },
    [sendWs],
  );

  const startMatch = useCallback(() => sendWs({ type: 'lobby:start_match' }), [sendWs]);
  const hostRestartMatch = useCallback(() => sendWs({ type: 'match:restart' }), [sendWs]);
  const hostEndMatchToLobby = useCallback(() => sendWs({ type: 'match:end_to_lobby' }), [sendWs]);

  const subscribeGameMessages = useCallback(
    (listener: (msg: Record<string, unknown>) => void) => {
      gameListenersRef.current.add(listener);
      if (lastMatchSyncRef.current) {
        listener(lastMatchSyncRef.current);
      }
      return () => {
        gameListenersRef.current.delete(listener);
      };
    },
    [],
  );

  const value = useMemo<LobbyContextValue>(
    () => ({
      lobby,
      isHost,
      connecting,
      error,
      kickedNotice,
      savedEvents,
      publicLobbies,
      friendLobbies,
      browserLoading,
      matchSignal,
      clearError: () => setError(null),
      clearKickedNotice: () => setKickedNotice(null),
      refreshBrowser,
      refreshEvents,
      saveEvent,
      removeEvent,
      hostStandardLobby,
      hostSpecialEvent,
      joinByCodeOrHash,
      joinLobbyDirect,
      leaveLobby,
      updateSettings,
      kickPlayer,
      switchTeam,
      toggleReady,
      sendChat,
      startMatch,
      hostRestartMatch,
      hostEndMatchToLobby,
      sendGameMessage: sendWs,
      subscribeGameMessages,
    }),
    [
      lobby,
      isHost,
      connecting,
      error,
      kickedNotice,
      savedEvents,
      publicLobbies,
      friendLobbies,
      browserLoading,
      matchSignal,
      refreshBrowser,
      refreshEvents,
      saveEvent,
      removeEvent,
      hostStandardLobby,
      hostSpecialEvent,
      joinByCodeOrHash,
      joinLobbyDirect,
      leaveLobby,
      updateSettings,
      kickPlayer,
      switchTeam,
      toggleReady,
      sendChat,
      startMatch,
      hostRestartMatch,
      hostEndMatchToLobby,
      sendWs,
      subscribeGameMessages,
    ],
  );

  return <LobbyContext.Provider value={value}>{children}</LobbyContext.Provider>;
};

export function useLobby(): LobbyContextValue {
  const ctx = useContext(LobbyContext);
  if (!ctx) throw new Error('useLobby must be used inside LobbyProvider');
  return ctx;
}

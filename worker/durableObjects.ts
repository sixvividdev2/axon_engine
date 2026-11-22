import {
  LobbyChatMessage,
  LobbyMember,
  LobbyModeId,
  LobbyRoomState,
  LobbySettingsPatch,
  LobbyTeamId,
  LobbyVisibility,
  sanitizeSpecialEventConfig,
  SpecialEventRecord,
} from '../data/multiplayer';
import { generateId } from './crypto';
import {
  CachedMatchState,
  createDefaultMatchState,
  validateAndSanitizeGameMessage,
} from './gameRelayGuard';
import {
  CloudflareWebSocket,
  DurableObjectState,
  PresenceStatus,
  UserPresenceState,
  WorkerEnv,
} from './types';

interface SocketAttachment {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  status: PresenceStatus;
  lobbyCode?: string | null;
  lobbyVisibility?: LobbyVisibility | null;
  lobbyMode?: string | null;
  eventName?: string | null;
  joinable?: boolean;
  updatedAt: number;
}

interface LobbySocketAttachment {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
}

interface CfWebSocketPairCtor {
  new (): { 0: CloudflareWebSocket; 1: CloudflareWebSocket };
}

function createWebSocketPair(): [CloudflareWebSocket, CloudflareWebSocket] {
  const Ctor = (globalThis as unknown as { WebSocketPair: CfWebSocketPairCtor }).WebSocketPair;
  const pair = new Ctor();
  return [pair[0], pair[1]];
}

function safeSend(ws: CloudflareWebSocket, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Socket may already be closing
  }
}

/**
 * Global Presence & Live Invite Hub Durable Object (WebSocket Hibernation API).
 */
export class SocialHubDO {
  private readonly state: DurableObjectState;
  private readonly env: WorkerEnv;

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.state = state;
    this.env = env;
  }

  private getAggregatedPresence(userId: string): UserPresenceState | null {
    const sockets = this.state.getWebSockets(`user:${userId}`);
    if (sockets.length === 0) return null;

    const priority: Record<PresenceStatus, number> = {
      offline: 0,
      online: 1,
      in_lobby: 2,
      in_match: 3,
    };

    let best: SocketAttachment | null = null;
    for (const ws of sockets) {
      const att = ws.deserializeAttachment?.() as SocketAttachment | null;
      if (!att) continue;
      if (!best || priority[att.status] >= priority[best.status]) {
        best = att;
      }
    }
    if (!best) return null;

    return {
      userId: best.userId,
      username: best.username,
      rank: best.rank,
      prestige: best.prestige,
      status: best.status,
      lobbyCode: best.lobbyCode ?? null,
      lobbyVisibility: best.lobbyVisibility ?? null,
      lobbyMode: best.lobbyMode ?? null,
      eventName: best.eventName ?? null,
      joinable: Boolean(best.joinable),
      updatedAt: best.updatedAt,
    };
  }

  private async getFriendIds(userId: string): Promise<string[]> {
    try {
      const res = await this.env.DB.prepare(
        `SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS friend_id
         FROM friendships
         WHERE user_a_id = ? OR user_b_id = ?`,
      )
        .bind(userId, userId, userId)
        .all<{ friend_id: string }>();
      return (res.results ?? []).map((r) => r.friend_id);
    } catch {
      return [];
    }
  }

  private async broadcastPresenceToFriends(
    userId: string,
    presence: UserPresenceState,
  ): Promise<void> {
    const friendIds = await this.getFriendIds(userId);
    const sanitized: UserPresenceState =
      presence.lobbyVisibility === 'private'
        ? {
            ...presence,
            lobbyCode: null,
            lobbyVisibility: null,
            lobbyMode: null,
            eventName: null,
            joinable: false,
          }
        : presence;
    const msg = { type: 'presence:changed', presence: sanitized };
    for (const fid of friendIds) {
      for (const ws of this.state.getWebSockets(`user:${fid}`)) {
        safeSend(ws, msg);
      }
    }
  }

  private sendToUser(userId: string, payload: unknown): number {
    const sockets = this.state.getWebSockets(`user:${userId}`);
    for (const ws of sockets) {
      safeSend(ws, payload);
    }
    return sockets.length;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/internal/presence-batch' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { userIds?: string[] };
      const map: Record<string, UserPresenceState> = {};
      for (const uid of body.userIds ?? []) {
        const p = this.getAggregatedPresence(uid);
        if (p) map[uid] = p;
      }
      return new Response(JSON.stringify({ presence: map }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/internal/push' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        targetUserIds?: string[];
        event?: unknown;
      };
      let delivered = 0;
      for (const uid of body.targetUserIds ?? []) {
        delivered += this.sendToUser(uid, body.event);
      }
      return new Response(JSON.stringify({ ok: true, delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (path === '/internal/rename' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        userId?: string;
        username?: string;
      };
      if (body.userId && body.username) {
        for (const ws of this.state.getWebSockets(`user:${body.userId}`)) {
          const att = ws.deserializeAttachment?.() as SocketAttachment | null;
          if (att) {
            att.username = body.username;
            att.updatedAt = Date.now();
            ws.serializeAttachment?.(att);
          }
        }
        const presence = this.getAggregatedPresence(body.userId);
        if (presence) {
          await this.broadcastPresenceToFriends(body.userId, presence);
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const userId = request.headers.get('X-Auth-User-Id');
      const username = request.headers.get('X-Auth-Username');
      const rank = Number(request.headers.get('X-Auth-Rank') ?? '1') || 1;
      const prestige = Number(request.headers.get('X-Auth-Prestige') ?? '0') || 0;

      if (!userId || !username) {
        return new Response('Unauthorized', { status: 401 });
      }

      const [client, server] = createWebSocketPair();
      const attachment: SocketAttachment = {
        userId,
        username,
        rank,
        prestige,
        status: 'online',
        lobbyCode: null,
        lobbyVisibility: null,
        lobbyMode: null,
        eventName: null,
        joinable: false,
        updatedAt: Date.now(),
      };

      this.state.acceptWebSocket(server, [`user:${userId}`]);
      server.serializeAttachment?.(attachment);

      const presence = this.getAggregatedPresence(userId) ?? attachment;
      safeSend(server, { type: 'social:connected', presence });
      await this.broadcastPresenceToFriends(userId, presence);

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit);
    }

    return new Response(JSON.stringify({ ok: true, service: 'SocialHubDO' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async webSocketMessage(ws: CloudflareWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const att = ws.deserializeAttachment?.() as SocketAttachment | null;
    if (!att) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === 'ping') {
      safeSend(ws, { type: 'pong', ts: Date.now() });
      return;
    }

    if (parsed.type === 'presence:update') {
      const status = parsed.status;
      if (status === 'online' || status === 'in_lobby' || status === 'in_match') {
        att.status = status;
        att.lobbyCode = typeof parsed.lobbyCode === 'string' ? parsed.lobbyCode : null;
        att.lobbyVisibility =
          parsed.lobbyVisibility === 'public' ||
          parsed.lobbyVisibility === 'friends_only' ||
          parsed.lobbyVisibility === 'private'
            ? parsed.lobbyVisibility
            : null;
        att.lobbyMode = typeof parsed.lobbyMode === 'string' ? parsed.lobbyMode : null;
        att.eventName = typeof parsed.eventName === 'string' ? parsed.eventName : null;
        att.joinable = Boolean(parsed.joinable);
        att.updatedAt = Date.now();
        ws.serializeAttachment?.(att);

        const aggregated = this.getAggregatedPresence(att.userId);
        if (aggregated) {
          await this.broadcastPresenceToFriends(att.userId, aggregated);
        }
      }
    }
  }

  async webSocketClose(ws: CloudflareWebSocket): Promise<void> {
    const att = ws.deserializeAttachment?.() as SocketAttachment | null;
    if (!att) return;

    const remaining = this.getAggregatedPresence(att.userId);
    if (remaining) {
      await this.broadcastPresenceToFriends(att.userId, remaining);
    } else {
      await this.broadcastPresenceToFriends(att.userId, {
        userId: att.userId,
        username: att.username,
        rank: att.rank,
        prestige: att.prestige,
        status: 'offline',
        lobbyCode: null,
        lobbyVisibility: null,
        lobbyMode: null,
        eventName: null,
        joinable: false,
        updatedAt: Date.now(),
      });
    }
  }

  async webSocketError(ws: CloudflareWebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

interface PersistedLobbyRoom {
  state: LobbyRoomState;
  kickedUserIds: string[];
  invitedUserIds: string[];
  matchState?: CachedMatchState;
}

/**
 * Isolated Multiplayer Lobby & Match Sync Durable Object (1 instance per lobby code).
 * Enforces Host vs. Joined permissions server-side, 3-tier discovery (Public, Friends-Only,
 * Private invite-only), direct hash-code joining for Special Events, kicked blocklists,
 * and automatic Host migration on Host leave.
 */
export class LobbyRoomDO {
  private readonly state: DurableObjectState;
  private readonly env: WorkerEnv;
  private room: PersistedLobbyRoom | null = null;

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.state = state;
    this.env = env;
  }

  private async loadRoom(): Promise<PersistedLobbyRoom | null> {
    if (this.room) return this.room;
    const storage = (this.state as unknown as { storage?: { get: <T>(k: string) => Promise<T | undefined> } }).storage;
    if (storage) {
      const saved = await storage.get<PersistedLobbyRoom>('room');
      if (saved) {
        if (!saved.matchState) {
          saved.matchState = createDefaultMatchState();
        }
        this.room = saved;
        return saved;
      }
    }
    return null;
  }

  private async saveRoom(): Promise<void> {
    const storage = (
      this.state as unknown as {
        storage?: {
          put: (k: string, v: unknown) => Promise<void>;
          delete: (k: string) => Promise<void>;
        };
      }
    ).storage;
    if (!storage) return;
    if (this.room) {
      await storage.put('room', this.room);
    } else {
      await storage.delete('room');
    }
  }

  private async syncActiveLobbyIndex(): Promise<void> {
    if (!this.room) return;
    const st = this.room.state;
    const now = Date.now();
    try {
      if (st.members.length === 0) {
        await this.env.DB.prepare('DELETE FROM active_lobbies WHERE code = ?').bind(st.code).run();
        return;
      }
      await this.env.DB.prepare(
        `INSERT INTO active_lobbies (
          code, host_user_id, visibility, mode, map_id,
          event_id, event_hash_code, event_name, creator_username,
          player_count, max_players, bots_enabled, bot_count, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          host_user_id = excluded.host_user_id,
          visibility = excluded.visibility,
          mode = excluded.mode,
          map_id = excluded.map_id,
          event_id = excluded.event_id,
          event_hash_code = excluded.event_hash_code,
          event_name = excluded.event_name,
          creator_username = excluded.creator_username,
          player_count = excluded.player_count,
          max_players = excluded.max_players,
          bots_enabled = excluded.bots_enabled,
          bot_count = excluded.bot_count,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
        .bind(
          st.code,
          st.hostUserId,
          st.visibility,
          st.mode === 'infection' ? 'infection' : st.battleRule === 'ffa' ? 'battle_ffa' : 'battle_tdm',
          st.mapId,
          st.specialEvent?.id ?? null,
          st.specialEvent?.hashCode ?? null,
          st.specialEvent?.name ?? null,
          st.specialEvent?.creatorUsername ?? null,
          st.members.length,
          st.maxPlayers,
          st.botsEnabled ? 1 : 0,
          st.botCount,
          st.status,
          now,
        )
        .run();
    } catch {
      // Non-fatal index sync failure
    }
  }

  private async isFriendWithHost(userId: string, hostUserId: string): Promise<boolean> {
    if (userId === hostUserId) return true;
    const [a, b] = userId < hostUserId ? [userId, hostUserId] : [hostUserId, userId];
    const row = await this.env.DB.prepare(
      'SELECT 1 FROM friendships WHERE user_a_id = ? AND user_b_id = ?',
    )
      .bind(a, b)
      .first();
    return Boolean(row);
  }

  private async recordRecentPlayersForMatch(st: LobbyRoomState): Promise<void> {
    const ids = st.members.map((m) => m.userId);
    if (ids.length < 2) return;
    const now = Date.now();
    const modeLabel = st.specialEvent
      ? `EVENT: ${st.specialEvent.name}`.slice(0, 32)
      : st.mode === 'infection'
        ? 'INFECTION'
        : st.battleRule === 'ffa'
          ? 'BATTLE FFA'
          : 'BATTLE TDM';

    const stmts = [];
    for (const uid of ids) {
      for (const peerId of ids) {
        if (uid === peerId) continue;
        stmts.push(
          this.env.DB.prepare(
            `INSERT INTO recent_players (user_id, peer_user_id, last_played_at, mode)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, peer_user_id)
             DO UPDATE SET last_played_at = excluded.last_played_at, mode = excluded.mode`,
          ).bind(uid, peerId, now, modeLabel),
        );
      }
      stmts.push(
        this.env.DB.prepare(
          `DELETE FROM recent_players
           WHERE user_id = ? AND peer_user_id NOT IN (
             SELECT peer_user_id FROM recent_players
             WHERE user_id = ?
             ORDER BY last_played_at DESC
             LIMIT 25
           )`,
        ).bind(uid, uid),
      );
    }
    try {
      await this.env.DB.batch(stmts);
    } catch {
      // Non-fatal recent players write
    }
  }

  private broadcast(payload: unknown, excludeUserId?: string): void {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      const att = ws.deserializeAttachment?.() as LobbySocketAttachment | null;
      if (excludeUserId && att?.userId === excludeUserId) continue;
      safeSend(ws, payload);
    }
  }

  private sendToUser(userId: string, payload: unknown): void {
    for (const ws of this.state.getWebSockets(`user:${userId}`)) {
      safeSend(ws, payload);
    }
  }

  private pushSystemChat(text: string): void {
    if (!this.room) return;
    const msg: LobbyChatMessage = {
      id: generateId(),
      userId: 'system',
      username: 'SYSTEM',
      text,
      system: true,
      createdAt: Date.now(),
    };
    this.room.state.chat = [...this.room.state.chat.slice(-49), msg];
  }

  private pickBalancedTeam(members: LobbyMember[]): LobbyTeamId {
    const countA = members.filter((m) => m.team === 'A').length;
    const countB = members.filter((m) => m.team === 'B').length;
    return countA <= countB ? 'A' : 'B';
  }

  private async removeMember(userId: string, reasonText?: string): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    const idx = room.state.members.findIndex((m) => m.userId === userId);
    if (idx < 0) return;

    const [removed] = room.state.members.splice(idx, 1);
    if (reasonText) {
      this.pushSystemChat(reasonText);
    } else {
      this.pushSystemChat(`${removed.username} left the lobby.`);
    }

    if (room.state.members.length === 0) {
      await this.env.DB.prepare('DELETE FROM active_lobbies WHERE code = ?')
        .bind(room.state.code)
        .run()
        .catch(() => {});
      this.room = null;
      await this.saveRoom();
      return;
    }

    // Auto-promote next joined player if Host leaves
    if (room.state.hostUserId === userId) {
      const nextHost = room.state.members[0];
      room.state.hostUserId = nextHost.userId;
      room.state.hostUsername = nextHost.username;
      room.state.members = room.state.members.map((m) => ({
        ...m,
        isHost: m.userId === nextHost.userId,
      }));
      this.pushSystemChat(`${nextHost.username} is now the Host.`);
    }

    room.state.updatedAt = Date.now();
    await this.saveRoom();
    await this.syncActiveLobbyIndex();
    this.broadcast({ type: 'lobby:state', state: room.state });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Internal RPC: initialize room on lobby creation
    if (path === '/internal/init' && request.method === 'POST') {
      const body = (await request.json()) as {
        code: string;
        host: { userId: string; username: string; rank: number; prestige: number };
        visibility: LobbyVisibility;
        mode: LobbyModeId;
        battleRule: 'tdm' | 'ffa';
        mapId: string;
        maxPlayers: number;
        botsEnabled: boolean;
        botCount: number;
        killLimit: number;
        botDifficulty: 'recruit' | 'tactical' | 'veteran';
        specialEvent: SpecialEventRecord | null;
      };

      const now = Date.now();
      const ev = body.specialEvent;
      const mode: LobbyModeId = ev ? ev.config.mode : body.mode;
      const battleRule = ev ? ev.config.battleRule : body.battleRule;
      const mapId = ev ? ev.config.mapId : body.mapId;
      const maxPlayers = Math.max(2, Math.min(8, Math.round(ev ? ev.config.maxPlayers : body.maxPlayers)));
      const botsEnabled = ev ? ev.config.botsEnabled : Boolean(body.botsEnabled);
      const botCount = botsEnabled
        ? Math.max(0, Math.min(10, Math.round(ev ? ev.config.botCount : body.botCount)))
        : 0;

      this.room = {
        state: {
          code: body.code,
          hostUserId: body.host.userId,
          hostUsername: body.host.username,
          visibility: body.visibility,
          mode,
          battleRule,
          mapId,
          maxPlayers,
          botsEnabled,
          botCount,
          killLimit: ev ? ev.config.killLimit : Math.max(10, Math.min(100, body.killLimit || 30)),
          botDifficulty: ev ? ev.config.botDifficulty : body.botDifficulty,
          status: 'lobby',
          matchSequence: 0,
          specialEvent: ev,
          members: [
            {
              userId: body.host.userId,
              username: body.host.username,
              rank: body.host.rank,
              prestige: body.host.prestige,
              team: 'A',
              ready: true,
              isHost: true,
              connected: false,
              joinedAt: now,
            },
          ],
          chat: [
            {
              id: generateId(),
              userId: 'system',
              username: 'SYSTEM',
              text: ev
                ? `Special Event "${ev.name}" opened by ${body.host.username}.`
                : `Lobby ${body.code} created by ${body.host.username}.`,
              system: true,
              createdAt: now,
            },
          ],
          updatedAt: now,
        },
        kickedUserIds: [],
        invitedUserIds: [],
        matchState: createDefaultMatchState(),
      };

      await this.saveRoom();
      await this.syncActiveLobbyIndex();
      return new Response(JSON.stringify({ ok: true, state: this.room.state }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Internal RPC: inspect room for join pre-check
    if (path === '/internal/check-access' && request.method === 'POST') {
      const room = await this.loadRoom();
      if (!room) {
        return new Response(JSON.stringify({ allowed: false, error: 'Lobby not found or closed.' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = (await request.json()) as {
        userId: string;
        eventHash?: string | null;
      };
      const st = room.state;
      if (room.kickedUserIds.includes(body.userId)) {
        return new Response(
          JSON.stringify({ allowed: false, error: 'You were kicked from this lobby session.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const alreadyMember = st.members.some((m) => m.userId === body.userId);
      if (!alreadyMember && st.members.length >= st.maxPlayers) {
        return new Response(JSON.stringify({ allowed: false, error: 'This lobby is full.' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const validEventHash =
        Boolean(body.eventHash) &&
        Boolean(st.specialEvent?.hashCode) &&
        body.eventHash?.trim().toUpperCase() === st.specialEvent?.hashCode.toUpperCase();

      if (
        !alreadyMember &&
        !validEventHash &&
        body.userId !== st.hostUserId &&
        !room.invitedUserIds.includes(body.userId)
      ) {
        if (st.visibility === 'private') {
          return new Response(
            JSON.stringify({
              allowed: false,
              error: 'This lobby is Private. You need a direct invite from the Host to join.',
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (st.visibility === 'friends_only') {
          const isFriend = await this.isFriendWithHost(body.userId, st.hostUserId);
          if (!isFriend) {
            return new Response(
              JSON.stringify({
                allowed: false,
                error: 'This lobby is Friends-Only. Only friends of the Host can join.',
              }),
              { status: 403, headers: { 'Content-Type': 'application/json' } },
            );
          }
        }
      }

      return new Response(JSON.stringify({ allowed: true, state: st }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Internal RPC: Host authorizes an invited user ID (allows joining even Private lobbies)
    if (path === '/internal/invite' && request.method === 'POST') {
      const room = await this.loadRoom();
      if (!room) {
        return new Response(JSON.stringify({ error: 'Lobby not found.' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const body = (await request.json()) as { hostUserId: string; targetUserId: string };
      if (room.state.hostUserId !== body.hostUserId) {
        return new Response(JSON.stringify({ error: 'Only the Host can invite players.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (!room.invitedUserIds.includes(body.targetUserId)) {
        room.invitedUserIds.push(body.targetUserId);
      }
      // If Host explicitly re-invites a previously kicked player, unban them
      room.kickedUserIds = room.kickedUserIds.filter((id) => id !== body.targetUserId);
      await this.saveRoom();
      return new Response(JSON.stringify({ ok: true, state: room.state }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Authenticated WebSocket upgrade
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const room = await this.loadRoom();
      if (!room) return new Response('Lobby not found', { status: 404 });

      const userId = request.headers.get('X-Auth-User-Id');
      const username = request.headers.get('X-Auth-Username');
      const rank = Number(request.headers.get('X-Auth-Rank') ?? '1') || 1;
      const prestige = Number(request.headers.get('X-Auth-Prestige') ?? '0') || 0;
      const eventHash = url.searchParams.get('eventHash')?.trim().toUpperCase() ?? null;

      if (!userId || !username) return new Response('Unauthorized', { status: 401 });

      const st = room.state;
      if (room.kickedUserIds.includes(userId)) {
        return new Response('Kicked from lobby session', { status: 403 });
      }

      const existing = st.members.find((m) => m.userId === userId);
      const validEventHash =
        Boolean(eventHash) &&
        Boolean(st.specialEvent?.hashCode) &&
        eventHash === st.specialEvent?.hashCode.toUpperCase();

      if (!existing) {
        if (st.members.length >= st.maxPlayers) {
          return new Response('Lobby is full', { status: 409 });
        }
        if (
          !validEventHash &&
          userId !== st.hostUserId &&
          !room.invitedUserIds.includes(userId)
        ) {
          if (st.visibility === 'private') {
            return new Response('Private lobby requires invite', { status: 403 });
          }
          if (st.visibility === 'friends_only') {
            const isFriend = await this.isFriendWithHost(userId, st.hostUserId);
            if (!isFriend) {
              return new Response('Friends-Only lobby', { status: 403 });
            }
          }
        }
        st.members.push({
          userId,
          username,
          rank,
          prestige,
          team: this.pickBalancedTeam(st.members),
          ready: false,
          isHost: userId === st.hostUserId,
          connected: true,
          joinedAt: Date.now(),
        });
        this.pushSystemChat(
          validEventHash
            ? `${username} joined via Event Hash Code.`
            : `${username} joined the lobby.`,
        );
      } else {
        existing.username = username;
        existing.rank = rank;
        existing.prestige = prestige;
        existing.connected = true;
      }

      const [client, server] = createWebSocketPair();
      this.state.acceptWebSocket(server, [`user:${userId}`]);
      server.serializeAttachment?.({ userId, username, rank, prestige } satisfies LobbySocketAttachment);

      st.updatedAt = Date.now();
      await this.saveRoom();
      await this.syncActiveLobbyIndex();
      this.broadcast({ type: 'lobby:state', state: st });

      // Hydrate late-joining or reconnecting clients with cached authoritative Infection match state
      if (st.status === 'in_match') {
        const ms = room.matchState ?? createDefaultMatchState();
        safeSend(server, {
          type: 'game:match_sync',
          powerOn: ms.powerOn,
          openedDoorIds: ms.openedDoorIds,
          unlockedZoneIds: ms.unlockedZoneIds,
          round: ms.round,
          zombiesRemaining: ms.zombiesRemaining,
          senderIsHost: true,
          ts: Date.now(),
        });
      }

      return new Response(null, {
        status: 101,
        webSocket: client,
      } as ResponseInit);
    }

    return new Response(JSON.stringify({ ok: true, service: 'LobbyRoomDO' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async webSocketMessage(ws: CloudflareWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const att = ws.deserializeAttachment?.() as LobbySocketAttachment | null;
    if (!att) return;
    const room = await this.loadRoom();
    if (!room) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    const st = room.state;
    const isHost = att.userId === st.hostUserId;

    if (parsed.type === 'ping') {
      safeSend(ws, { type: 'pong', ts: Date.now() });
      return;
    }

    if (parsed.type === 'lobby:update_settings') {
      if (!isHost) {
        safeSend(ws, { type: 'lobby:error', error: 'Only the Host can change lobby settings.' });
        return;
      }
      const patch = (parsed.patch ?? {}) as LobbySettingsPatch;
      if (
        patch.visibility === 'public' ||
        patch.visibility === 'friends_only' ||
        patch.visibility === 'private'
      ) {
        st.visibility = patch.visibility;
      }
      if (patch.mode === 'battle' || patch.mode === 'infection') {
        st.mode = patch.mode;
        if (st.mode === 'infection' && st.mapId !== 'kino_theater') {
          st.mapId = 'kino_theater';
        } else if (st.mode === 'battle' && st.mapId === 'kino_theater') {
          st.mapId = 'pripyat_block';
        }
      }
      if (patch.battleRule === 'tdm' || patch.battleRule === 'ffa') {
        st.battleRule = patch.battleRule;
      }
      if (
        patch.mapId === 'pripyat_block' ||
        patch.mapId === 'timberline_compound' ||
        patch.mapId === 'kino_theater'
      ) {
        st.mapId = patch.mapId;
      }
      if (typeof patch.maxPlayers === 'number') {
        st.maxPlayers = Math.max(
          Math.max(2, st.members.length),
          Math.min(8, Math.round(patch.maxPlayers)),
        );
      }
      if (typeof patch.botsEnabled === 'boolean') {
        st.botsEnabled = patch.botsEnabled;
        if (!st.botsEnabled) st.botCount = 0;
        else if (st.botCount === 0) st.botCount = 6;
      }
      if (typeof patch.botCount === 'number') {
        st.botCount = Math.max(0, Math.min(10, Math.round(patch.botCount)));
        st.botsEnabled = st.botCount > 0;
      }
      if (typeof patch.killLimit === 'number') {
        st.killLimit = Math.max(10, Math.min(100, Math.round(patch.killLimit)));
      }
      if (
        patch.botDifficulty === 'recruit' ||
        patch.botDifficulty === 'tactical' ||
        patch.botDifficulty === 'veteran'
      ) {
        st.botDifficulty = patch.botDifficulty;
      }
      if (st.specialEvent) {
        st.specialEvent = {
          ...st.specialEvent,
          config: sanitizeSpecialEventConfig({
            ...st.specialEvent.config,
            mode: st.mode,
            battleRule: st.battleRule,
            mapId: st.mapId,
            maxPlayers: st.maxPlayers,
            botsEnabled: st.botsEnabled,
            botCount: st.botCount,
            killLimit: st.killLimit,
            botDifficulty: st.botDifficulty,
          }),
        };
      }
      st.updatedAt = Date.now();
      await this.saveRoom();
      await this.syncActiveLobbyIndex();
      this.broadcast({ type: 'lobby:state', state: st });
      return;
    }

    if (parsed.type === 'lobby:kick') {
      if (!isHost) {
        safeSend(ws, { type: 'lobby:error', error: 'Only the Host can kick players.' });
        return;
      }
      const targetId = String(parsed.targetUserId ?? '');
      if (!targetId || targetId === st.hostUserId) return;
      const targetMember = st.members.find((m) => m.userId === targetId);
      if (!targetMember) return;

      if (!room.kickedUserIds.includes(targetId)) {
        room.kickedUserIds.push(targetId);
      }
      room.invitedUserIds = room.invitedUserIds.filter((id) => id !== targetId);

      for (const s of this.state.getWebSockets(`user:${targetId}`)) {
        safeSend(s, { type: 'lobby:kicked', reason: 'You were kicked by the lobby Host.' });
        try {
          s.close(4003, 'Kicked by Host');
        } catch {
          // Ignore close errors
        }
      }
      await this.removeMember(targetId, `${targetMember.username} was kicked by the Host.`);
      return;
    }

    if (parsed.type === 'lobby:switch_team') {
      const targetTeam: LobbyTeamId = parsed.team === 'B' ? 'B' : 'A';
      const member = st.members.find((m) => m.userId === att.userId);
      if (!member) return;
      member.team = targetTeam;
      st.updatedAt = Date.now();
      await this.saveRoom();
      this.broadcast({ type: 'lobby:state', state: st });
      return;
    }

    if (parsed.type === 'lobby:toggle_ready') {
      const member = st.members.find((m) => m.userId === att.userId);
      if (!member) return;
      member.ready = !member.ready;
      st.updatedAt = Date.now();
      await this.saveRoom();
      this.broadcast({ type: 'lobby:state', state: st });
      return;
    }

    if (parsed.type === 'lobby:chat') {
      const text = String(parsed.text ?? '').trim().slice(0, 240);
      if (!text) return;
      const msg: LobbyChatMessage = {
        id: generateId(),
        userId: att.userId,
        username: att.username,
        text,
        createdAt: Date.now(),
      };
      st.chat = [...st.chat.slice(-49), msg];
      st.updatedAt = Date.now();
      await this.saveRoom();
      this.broadcast({ type: 'lobby:chat', message: msg });
      return;
    }

    if (parsed.type === 'lobby:start_match') {
      if (!isHost) {
        safeSend(ws, { type: 'lobby:error', error: 'Only the Host can start the match.' });
        return;
      }
      st.status = 'in_match';
      st.matchSequence += 1;
      st.updatedAt = Date.now();
      room.matchState = createDefaultMatchState();
      this.pushSystemChat(`Host ${att.username} launched the match.`);
      await this.saveRoom();
      await this.syncActiveLobbyIndex();
      await this.recordRecentPlayersForMatch(st);
      this.broadcast({ type: 'lobby:state', state: st });
      this.broadcast({ type: 'match:start', state: st });
      return;
    }

    if (parsed.type === 'match:restart') {
      if (!isHost) {
        safeSend(ws, { type: 'lobby:error', error: 'Only the Host can restart the match.' });
        return;
      }
      st.status = 'in_match';
      st.matchSequence += 1;
      st.updatedAt = Date.now();
      room.matchState = createDefaultMatchState();
      await this.saveRoom();
      this.broadcast({ type: 'match:restart', state: st });
      return;
    }

    if (parsed.type === 'match:end_to_lobby') {
      if (!isHost) {
        safeSend(ws, {
          type: 'lobby:error',
          error: 'Only the Host can end the match for the whole squad.',
        });
        return;
      }
      st.status = 'lobby';
      room.matchState = createDefaultMatchState();
      if (st.specialEvent?.config.cycleModesBetweenGames && st.specialEvent.config.cyclePool.length > 1) {
        const pool = st.specialEvent.config.cyclePool;
        const curKey =
          st.mode === 'infection' ? 'infection' : st.battleRule === 'ffa' ? 'battle_ffa' : 'battle_tdm';
        const curIdx = pool.indexOf(curKey);
        const nextKey = pool[(curIdx + 1) % pool.length];
        if (nextKey === 'infection') {
          st.mode = 'infection';
          st.mapId = 'kino_theater';
        } else {
          st.mode = 'battle';
          st.battleRule = nextKey === 'battle_ffa' ? 'ffa' : 'tdm';
          if (st.mapId === 'kino_theater') st.mapId = 'pripyat_block';
        }
        this.pushSystemChat(
          `Event cycled next game to ${nextKey === 'infection' ? 'INFECTION' : nextKey === 'battle_ffa' ? 'BATTLE · FFA' : 'BATTLE · TDM'}.`,
        );
      }
      st.updatedAt = Date.now();
      this.pushSystemChat(`Host ${att.username} ended the match and returned the squad to lobby.`);
      await this.saveRoom();
      await this.syncActiveLobbyIndex();
      this.broadcast({ type: 'match:end_to_lobby', state: st });
      this.broadcast({ type: 'lobby:state', state: st });
      return;
    }

    if (parsed.type === 'lobby:leave') {
      await this.removeMember(att.userId);
      try {
        ws.close(1000, 'Left lobby');
      } catch {
        // Ignore
      }
      return;
    }

    // Relay in-match multiplayer events (Phase 4–5) with strict Host authority, validation & match-state cache
    if (typeof parsed.type === 'string' && parsed.type.startsWith('game:')) {
      if (!room.matchState) {
        room.matchState = createDefaultMatchState();
      }
      const res = validateAndSanitizeGameMessage(parsed, st, room.matchState, {
        userId: att.userId,
        username: att.username,
      });
      if (!res) return;

      if (res.matchStateChanged) {
        await this.saveRoom();
      }
      if (res.targetUserId) {
        this.sendToUser(res.targetUserId, res.payload);
      } else {
        this.broadcast(res.payload, att.userId);
      }
    }
  }

  async webSocketClose(ws: CloudflareWebSocket): Promise<void> {
    const att = ws.deserializeAttachment?.() as LobbySocketAttachment | null;
    if (!att) return;
    const stillConnected = this.state.getWebSockets(`user:${att.userId}`).length > 0;
    if (!stillConnected) {
      await this.removeMember(att.userId);
    }
  }

  async webSocketError(ws: CloudflareWebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  formatLobbyModeLabel,
  formatMapDisplayName,
  generateEventHashCode,
  generateLobbyCode,
  LobbyBrowserEntry,
  LobbyChatMessage,
  LobbyMember,
  LobbyModeId,
  LobbyRoomState,
  LobbySettingsPatch,
  LobbyTeamId,
  LobbyVisibility,
  sanitizeSpecialEventConfig,
  SpecialEventRecord,
} from './data/multiplayer';
import {
  applyMatchProgression,
  CareerProgressionState,
  getStarterUnlockedAttachments,
  MatchResultInput,
  WeaponProgressRecord,
} from './data/progression';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  generateId,
  generateRandomHex,
  hashPassword,
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sha256Hex,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyPassword,
} from './worker/crypto';
import {
  CachedMatchState,
  createDefaultMatchState,
  validateAndSanitizeGameMessage,
} from './worker/gameRelayGuard';
import { sendWelcomeEmail } from './worker/email';
import { PresenceStatus, UserPresenceState } from './worker/types';

interface LocalUserRecord {
  id: string;
  email: string;
  emailLower: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  passwordSalt: string;
  rank: number;
  xp: number;
  prestige: number;
  prestigeXp: number;
  cash: number;
  kills: number;
  deaths: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
  highestInfectionRound: number;
  createdAt: number;
  updatedAt: number;
  weaponProgress: Record<string, WeaponProgressRecord>;
  unlockedAttachments: string[];
}

interface LocalSessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

interface LocalFriendship {
  userAId: string;
  userBId: string;
  createdAt: number;
}

interface LocalFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: 'pending';
  createdAt: number;
}

interface LocalRecentPlayer {
  userId: string;
  peerUserId: string;
  lastPlayedAt: number;
  mode: string;
}

interface LocalStoreData {
  users: Record<string, LocalUserRecord>;
  sessions: Record<string, LocalSessionRecord>;
  friendships: LocalFriendship[];
  friendRequests: LocalFriendRequest[];
  recentPlayers: LocalRecentPlayer[];
  specialEvents: Record<string, SpecialEventRecord>;
}

interface ConnectedSocialSocket {
  ws: WebSocket;
  presence: UserPresenceState;
}

interface LocalLobbySocketMeta {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
}

interface LocalLobbyRoom {
  state: LobbyRoomState;
  kickedUserIds: Set<string>;
  invitedUserIds: Set<string>;
  sockets: Map<WebSocket, LocalLobbySocketMeta>;
  matchState: CachedMatchState;
}

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SERVER_PEPPER =
  process.env.PASSWORD_PEPPER?.trim() ||
  crypto.createHash('sha256').update(`cordon-local-dev-${os.hostname()}`).digest('hex');

const DB_FILE = path.join(os.tmpdir(), 'cordon04-preview-db.json');

function loadStore(): LocalStoreData {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LocalStoreData>;
      if (parsed && typeof parsed.users === 'object' && typeof parsed.sessions === 'object') {
        return {
          users: parsed.users ?? {},
          sessions: parsed.sessions ?? {},
          friendships: Array.isArray(parsed.friendships) ? parsed.friendships : [],
          friendRequests: Array.isArray(parsed.friendRequests) ? parsed.friendRequests : [],
          recentPlayers: Array.isArray(parsed.recentPlayers) ? parsed.recentPlayers : [],
          specialEvents:
            parsed.specialEvents && typeof parsed.specialEvents === 'object'
              ? parsed.specialEvents
              : {},
        };
      }
    }
  } catch {
    // Recreate clean local store if unreadable
  }
  return {
    users: {},
    sessions: {},
    friendships: [],
    friendRequests: [],
    recentPlayers: [],
    specialEvents: {},
  };
}

const store: LocalStoreData = loadStore();

function persistStore(): void {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch (err) {
    console.warn('[LocalDB] Could not persist preview DB file:', err);
  }
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function areFriends(a: string, b: string): boolean {
  const [ua, ub] = canonicalPair(a, b);
  return store.friendships.some((f) => f.userAId === ua && f.userBId === ub);
}

function getFriendIdsOf(userId: string): string[] {
  const ids: string[] = [];
  for (const f of store.friendships) {
    if (f.userAId === userId) ids.push(f.userBId);
    else if (f.userBId === userId) ids.push(f.userAId);
  }
  return ids;
}

// Live in-memory SocialHub socket map (exact parity with Cloudflare SocialHubDO)
const socialSocketsByUser = new Map<string, Set<ConnectedSocialSocket>>();

// Live in-memory Multiplayer Lobbies map (exact parity with Cloudflare LobbyRoomDO)
const activeLobbyRooms = new Map<string, LocalLobbyRoom>();

function lobbyToBrowserEntry(room: LocalLobbyRoom): LobbyBrowserEntry {
  const st = room.state;
  return {
    code: st.code,
    hostUserId: st.hostUserId,
    hostUsername: st.hostUsername,
    visibility: st.visibility,
    mode: st.mode,
    battleRule: st.battleRule,
    mapId: st.mapId,
    playerCount: st.members.length,
    maxPlayers: st.maxPlayers,
    botsEnabled: st.botsEnabled,
    botCount: st.botCount,
    status: st.status,
    eventHashCode: st.specialEvent?.hashCode ?? null,
    eventName: st.specialEvent?.name ?? null,
    creatorUsername: st.specialEvent?.creatorUsername ?? null,
    updatedAt: st.updatedAt,
  };
}

function broadcastLobbyRoom(room: LocalLobbyRoom, payload: unknown, excludeUserId?: string): void {
  for (const [ws, meta] of room.sockets.entries()) {
    if (excludeUserId && meta.userId === excludeUserId) continue;
    sendWsJson(ws, payload);
  }
}

function sendToLobbyUser(room: LocalLobbyRoom, targetUserId: string, payload: unknown): void {
  for (const [ws, meta] of room.sockets.entries()) {
    if (meta.userId === targetUserId) {
      sendWsJson(ws, payload);
    }
  }
}

function pushLobbySystemChat(room: LocalLobbyRoom, text: string): void {
  const msg: LobbyChatMessage = {
    id: generateId(),
    userId: 'system',
    username: 'SYSTEM',
    text,
    system: true,
    createdAt: Date.now(),
  };
  room.state.chat = [...room.state.chat.slice(-49), msg];
}

function pickBalancedLobbyTeam(members: LobbyMember[]): LobbyTeamId {
  const a = members.filter((m) => m.team === 'A').length;
  const b = members.filter((m) => m.team === 'B').length;
  return a <= b ? 'A' : 'B';
}

function recordLocalRecentPlayers(st: LobbyRoomState): void {
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

  for (const uid of ids) {
    for (const peerId of ids) {
      if (uid === peerId) continue;
      const existing = store.recentPlayers.find(
        (rp) => rp.userId === uid && rp.peerUserId === peerId,
      );
      if (existing) {
        existing.lastPlayedAt = now;
        existing.mode = modeLabel;
      } else {
        store.recentPlayers.push({
          userId: uid,
          peerUserId: peerId,
          lastPlayedAt: now,
          mode: modeLabel,
        });
      }
    }
    const mine = store.recentPlayers
      .filter((rp) => rp.userId === uid)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 25);
    const others = store.recentPlayers.filter((rp) => rp.userId !== uid);
    store.recentPlayers = [...others, ...mine];
  }
  persistStore();
}

function removeLocalLobbyMember(room: LocalLobbyRoom, userId: string, reasonText?: string): void {
  const idx = room.state.members.findIndex((m) => m.userId === userId);
  if (idx < 0) return;
  const [removed] = room.state.members.splice(idx, 1);
  pushLobbySystemChat(room, reasonText ?? `${removed.username} left the lobby.`);

  if (room.state.members.length === 0) {
    activeLobbyRooms.delete(room.state.code);
    return;
  }

  if (room.state.hostUserId === userId) {
    const nextHost = room.state.members[0];
    room.state.hostUserId = nextHost.userId;
    room.state.hostUsername = nextHost.username;
    room.state.members = room.state.members.map((m) => ({
      ...m,
      isHost: m.userId === nextHost.userId,
    }));
    pushLobbySystemChat(room, `${nextHost.username} is now the Host.`);
  }

  room.state.updatedAt = Date.now();
  broadcastLobbyRoom(room, { type: 'lobby:state', state: room.state });
}

function checkLocalLobbyAccess(
  room: LocalLobbyRoom,
  userId: string,
  eventHash?: string | null,
): { allowed: boolean; status?: number; error?: string } {
  const st = room.state;
  if (room.kickedUserIds.has(userId)) {
    return { allowed: false, status: 403, error: 'You were kicked from this lobby session.' };
  }
  const alreadyMember = st.members.some((m) => m.userId === userId);
  if (!alreadyMember && st.members.length >= st.maxPlayers) {
    return { allowed: false, status: 409, error: 'This lobby is full.' };
  }
  const validEventHash =
    Boolean(eventHash) &&
    Boolean(st.specialEvent?.hashCode) &&
    eventHash?.trim().toUpperCase() === st.specialEvent?.hashCode.toUpperCase();

  if (
    !alreadyMember &&
    !validEventHash &&
    userId !== st.hostUserId &&
    !room.invitedUserIds.has(userId)
  ) {
    if (st.visibility === 'private') {
      return {
        allowed: false,
        status: 403,
        error: 'This lobby is Private. You need a direct invite from the Host to join.',
      };
    }
    if (st.visibility === 'friends_only' && !areFriends(userId, st.hostUserId)) {
      return {
        allowed: false,
        status: 403,
        error: 'This lobby is Friends-Only. Only friends of the Host can join.',
      };
    }
  }
  return { allowed: true };
}

function sendWsJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore closing socket errors
    }
  }
}

function getAggregatedPresence(userId: string): UserPresenceState | null {
  const set = socialSocketsByUser.get(userId);
  if (!set || set.size === 0) return null;
  const priority: Record<PresenceStatus, number> = {
    offline: 0,
    online: 1,
    in_lobby: 2,
    in_match: 3,
  };
  let best: UserPresenceState | null = null;
  for (const conn of set) {
    if (!best || priority[conn.presence.status] >= priority[best.status]) {
      best = conn.presence;
    }
  }
  return best;
}

function pushToUser(userId: string, event: unknown): number {
  const set = socialSocketsByUser.get(userId);
  if (!set || set.size === 0) return 0;
  for (const conn of set) {
    sendWsJson(conn.ws, event);
  }
  return set.size;
}

function broadcastPresenceToFriends(userId: string, presence: UserPresenceState): void {
  const friendIds = getFriendIdsOf(userId);
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

  for (const fid of friendIds) {
    pushToUser(fid, { type: 'presence:changed', presence: sanitized });
  }
}

function serializeAccount(u: LocalUserRecord) {
  const unlockedSet = new Set<string>([...getStarterUnlockedAttachments(), ...u.unlockedAttachments]);
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    rank: u.rank,
    xp: u.xp,
    prestige: u.prestige,
    prestigeXp: u.prestigeXp,
    cash: u.cash,
    kills: u.kills,
    deaths: u.deaths,
    wins: u.wins,
    losses: u.losses,
    matchesPlayed: u.matchesPlayed,
    highestInfectionRound: u.highestInfectionRound,
    createdAt: u.createdAt,
    weaponProgress: u.weaponProgress,
    unlockedAttachments: Array.from(unlockedSet),
  };
}

function buildSocialOverview(userId: string) {
  const friendRows = store.friendships
    .filter((f) => f.userAId === userId || f.userBId === userId)
    .map((f) => {
      const friendId = f.userAId === userId ? f.userBId : f.userAId;
      const friendUser = store.users[friendId];
      if (!friendUser) return null;
      const p = getAggregatedPresence(friendId);
      const isPrivate = p?.lobbyVisibility === 'private';
      return {
        userId: friendUser.id,
        username: friendUser.username,
        rank: friendUser.rank,
        prestige: friendUser.prestige,
        friendsSince: f.createdAt,
        status: p?.status ?? ('offline' as PresenceStatus),
        lobbyCode: isPrivate ? null : (p?.lobbyCode ?? null),
        lobbyVisibility: isPrivate ? null : (p?.lobbyVisibility ?? null),
        lobbyMode: isPrivate ? null : (p?.lobbyMode ?? null),
        eventName: isPrivate ? null : (p?.eventName ?? null),
        joinable: isPrivate ? false : Boolean(p?.joinable),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()));

  const friendIdSet = new Set(friendRows.map((f) => f.userId));

  const incomingRequests = store.friendRequests
    .filter((r) => r.toUserId === userId && r.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => {
      const from = store.users[r.fromUserId];
      if (!from) return null;
      return {
        id: r.id,
        userId: from.id,
        username: from.username,
        rank: from.rank,
        prestige: from.prestige,
        createdAt: r.createdAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const outgoingRequests = store.friendRequests
    .filter((r) => r.fromUserId === userId && r.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => {
      const to = store.users[r.toUserId];
      if (!to) return null;
      return {
        id: r.id,
        userId: to.id,
        username: to.username,
        rank: to.rank,
        prestige: to.prestige,
        createdAt: r.createdAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const incomingByUser = new Set(incomingRequests.map((r) => r.userId));
  const outgoingByUser = new Set(outgoingRequests.map((r) => r.userId));

  const recentPlayers = store.recentPlayers
    .filter((rp) => rp.userId === userId)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, 25)
    .map((rp) => {
      const peer = store.users[rp.peerUserId];
      if (!peer) return null;
      return {
        userId: peer.id,
        username: peer.username,
        rank: peer.rank,
        prestige: peer.prestige,
        mode: rp.mode,
        lastPlayedAt: rp.lastPlayedAt,
        relationship: friendIdSet.has(peer.id)
          ? 'friend'
          : incomingByUser.has(peer.id)
            ? 'incoming'
            : outgoingByUser.has(peer.id)
              ? 'outgoing'
              : 'none',
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return { friends: friendRows, incomingRequests, outgoingRequests, recentPlayers };
}

function isHttpsReq(req: express.Request): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  return req.secure;
}

function verifyCsrf(req: express.Request): boolean {
  if (req.headers['x-requested-with'] === 'XMLHttpRequest') return true;
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  if (origin && host) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

async function getUserByCookieHeader(
  cookieHeader: string | undefined,
): Promise<LocalUserRecord | null> {
  const cookies = parseCookieHeader(cookieHeader);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken || rawToken.length < 16) return null;

  const tokenHash = await sha256Hex(rawToken);
  const session = store.sessions[tokenHash];
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    delete store.sessions[tokenHash];
    persistStore();
    return null;
  }
  return store.users[session.userId] ?? null;
}

async function getAuthenticatedUser(req: express.Request): Promise<LocalUserRecord | null> {
  return getUserByCookieHeader(req.headers.cookie);
}

async function createLocalSession(userId: string): Promise<string> {
  const rawToken = generateRandomHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  store.sessions[tokenHash] = {
    tokenHash,
    userId,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
  };
  persistStore();
  return rawToken;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !verifyCsrf(req)) {
      res.status(403).json({ error: 'Invalid request origin.' });
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, runtime: 'local-preview-parity' });
  });

  // === AUTH & ACCOUNT ===

  app.get('/api/auth/me', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    res.json({ user: user ? serializeAccount(user) : null });
  });

  app.post('/api/auth/register', async (req, res) => {
    const email = String(req.body?.email ?? '').trim();
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');

    const emailErr = validateEmail(email);
    if (emailErr) {
      res.status(400).json({ error: emailErr });
      return;
    }
    const userErr = validateUsername(username);
    if (userErr) {
      res.status(400).json({ error: userErr });
      return;
    }
    const passErr = validatePassword(password);
    if (passErr) {
      res.status(400).json({ error: passErr });
      return;
    }

    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();

    for (const existing of Object.values(store.users)) {
      if (existing.usernameLower === usernameLower) {
        res.status(409).json({
          error: 'That username is already taken. Choose a different callsign.',
        });
        return;
      }
      if (existing.emailLower === emailLower) {
        res.status(409).json({ error: 'An account with this email already exists.' });
        return;
      }
    }

    const { hashHex, saltHex } = await hashPassword(password, SERVER_PEPPER);
    const now = Date.now();
    const userId = generateId();

    const record: LocalUserRecord = {
      id: userId,
      email,
      emailLower,
      username,
      usernameLower,
      passwordHash: hashHex,
      passwordSalt: saltHex,
      rank: 1,
      xp: 0,
      prestige: 0,
      prestigeXp: 0,
      cash: 0,
      kills: 0,
      deaths: 0,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      highestInfectionRound: 0,
      createdAt: now,
      updatedAt: now,
      weaponProgress: {},
      unlockedAttachments: getStarterUnlockedAttachments(),
    };

    store.users[userId] = record;
    persistStore();

    const rawToken = await createLocalSession(userId);
    void sendWelcomeEmail(
      {
        RESEND_API_KEY: process.env.RESEND_API_KEY,
        FROM_EMAIL: process.env.FROM_EMAIL,
      },
      email,
      username,
    );

    res.setHeader('Set-Cookie', buildSessionCookie(rawToken, isHttpsReq(req)));
    res.status(201).json({ user: serializeAccount(record) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!identifier || !password) {
      res.status(400).json({ error: 'Enter your username or email and password.' });
      return;
    }

    const found = Object.values(store.users).find(
      (u) => u.emailLower === identifier || u.usernameLower === identifier,
    );
    if (!found) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const valid = await verifyPassword(
      password,
      SERVER_PEPPER,
      found.passwordSalt,
      found.passwordHash,
    );
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const rawToken = await createLocalSession(found.id);
    res.setHeader('Set-Cookie', buildSessionCookie(rawToken, isHttpsReq(req)));
    res.json({ user: serializeAccount(found) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    const cookies = parseCookieHeader(req.headers.cookie);
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (rawToken) {
      const tokenHash = await sha256Hex(rawToken);
      delete store.sessions[tokenHash];
      persistStore();
    }
    res.setHeader('Set-Cookie', buildClearSessionCookie(isHttpsReq(req)));
    res.json({ ok: true });
  });

  app.patch('/api/account/username', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to update your username.' });
      return;
    }

    const nextUsername = String(req.body?.username ?? '').trim();
    const validationErr = validateUsername(nextUsername);
    if (validationErr) {
      res.status(400).json({ error: validationErr });
      return;
    }

    const nextLower = nextUsername.toLowerCase();
    for (const existing of Object.values(store.users)) {
      if (existing.id !== user.id && existing.usernameLower === nextLower) {
        res.status(409).json({
          error: 'That username is already in use by another account.',
        });
        return;
      }
    }

    user.username = nextUsername;
    user.usernameLower = nextLower;
    user.updatedAt = Date.now();
    persistStore();

    // Sync active sockets & notify friends of rename
    const sockets = socialSocketsByUser.get(user.id);
    if (sockets) {
      for (const conn of sockets) {
        conn.presence.username = nextUsername;
      }
      const agg = getAggregatedPresence(user.id);
      if (agg) broadcastPresenceToFriends(user.id, agg);
    }

    res.json({ user: serializeAccount(user) });
  });

  app.post('/api/account/reset', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to reset account progress.' });
      return;
    }
    if (req.body?.confirm !== 'RESET_ALL_PROGRESS') {
      res.status(400).json({ error: 'Explicit reset confirmation is required.' });
      return;
    }

    user.rank = 1;
    user.xp = 0;
    user.prestige = 0;
    user.prestigeXp = 0;
    user.cash = 0;
    user.kills = 0;
    user.deaths = 0;
    user.wins = 0;
    user.losses = 0;
    user.matchesPlayed = 0;
    user.highestInfectionRound = 0;
    user.weaponProgress = {};
    user.unlockedAttachments = getStarterUnlockedAttachments();
    user.updatedAt = Date.now();
    persistStore();

    res.json({ user: serializeAccount(user), reset: true });
  });

  app.post('/api/progression/commit', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to save match progression.' });
      return;
    }

    const body = req.body as MatchResultInput | undefined;
    if (!body || (body.mode !== 'battle' && body.mode !== 'infection')) {
      res.status(400).json({ error: 'Invalid match progression payload.' });
      return;
    }

    const career: CareerProgressionState = {
      rank: user.rank,
      xp: user.xp,
      prestige: user.prestige,
      prestigeXp: user.prestigeXp,
      cash: user.cash,
      kills: user.kills,
      deaths: user.deaths,
      wins: user.wins,
      losses: user.losses,
      matchesPlayed: user.matchesPlayed,
      highestInfectionRound: user.highestInfectionRound,
    };

    const { nextCareer, nextWeaponProgress, nextUnlockedAttachments, summary } =
      applyMatchProgression(
        career,
        user.weaponProgress,
        new Set([...getStarterUnlockedAttachments(), ...user.unlockedAttachments]),
        body,
      );

    user.rank = nextCareer.rank;
    user.xp = nextCareer.xp;
    user.prestige = nextCareer.prestige;
    user.prestigeXp = nextCareer.prestigeXp;
    user.cash = nextCareer.cash;
    user.kills = nextCareer.kills;
    user.deaths = nextCareer.deaths;
    user.wins = nextCareer.wins;
    user.losses = nextCareer.losses;
    user.matchesPlayed = nextCareer.matchesPlayed;
    user.highestInfectionRound = nextCareer.highestInfectionRound;
    user.weaponProgress = nextWeaponProgress;
    user.unlockedAttachments = Array.from(nextUnlockedAttachments);
    user.updatedAt = Date.now();
    persistStore();

    res.json({ user: serializeAccount(user), summary });
  });

  // === PHASE 2: SOCIAL HUB ENDPOINTS ===

  app.get('/api/social/overview', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to view the Social Hub.' });
      return;
    }
    res.json(buildSocialOverview(user.id));
  });

  app.get('/api/players/search', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to search players.' });
      return;
    }

    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) {
      res.json({ players: [] });
      return;
    }

    const overview = buildSocialOverview(user.id);
    const friendIds = new Set(overview.friends.map((f) => f.userId));
    const incomingByUser = new Map(overview.incomingRequests.map((r) => [r.userId, r.id]));
    const outgoingByUser = new Map(overview.outgoingRequests.map((r) => [r.userId, r.id]));

    const players = Object.values(store.users)
      .filter((u) => u.id !== user.id && u.usernameLower.includes(q))
      .sort((a, b) => {
        const aExact = a.usernameLower === q ? 0 : a.usernameLower.startsWith(q) ? 1 : 2;
        const bExact = b.usernameLower === q ? 0 : b.usernameLower.startsWith(q) ? 1 : 2;
        if (aExact !== bExact) return aExact - bExact;
        return a.usernameLower.localeCompare(b.usernameLower);
      })
      .slice(0, 15)
      .map((p) => ({
        userId: p.id,
        username: p.username,
        rank: p.rank,
        prestige: p.prestige,
        relationship: friendIds.has(p.id)
          ? 'friend'
          : incomingByUser.has(p.id)
            ? 'incoming'
            : outgoingByUser.has(p.id)
              ? 'outgoing'
              : 'none',
        requestId: incomingByUser.get(p.id) ?? outgoingByUser.get(p.id) ?? null,
      }));

    res.json({ players });
  });

  app.post('/api/friends/request', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to send friend requests.' });
      return;
    }

    const targetUserId = String(req.body?.targetUserId ?? '').trim();
    if (!targetUserId || targetUserId === user.id) {
      res.status(400).json({ error: 'Select a valid player to add.' });
      return;
    }

    const target = store.users[targetUserId];
    if (!target) {
      res.status(404).json({ error: 'Player not found.' });
      return;
    }

    if (areFriends(user.id, targetUserId)) {
      res.status(409).json({ error: 'You are already friends with this player.' });
      return;
    }

    const now = Date.now();
    const reciprocalIdx = store.friendRequests.findIndex(
      (r) => r.fromUserId === targetUserId && r.toUserId === user.id && r.status === 'pending',
    );

    if (reciprocalIdx >= 0) {
      store.friendRequests.splice(reciprocalIdx, 1);
      const [ua, ub] = canonicalPair(user.id, targetUserId);
      store.friendships.push({ userAId: ua, userBId: ub, createdAt: now });
      persistStore();

      pushToUser(user.id, {
        type: 'social:refresh',
        notice: `You and ${target.username} are now friends.`,
      });
      pushToUser(targetUserId, {
        type: 'social:refresh',
        notice: `You and ${user.username} are now friends.`,
      });
      res.json({ status: 'accepted' });
      return;
    }

    const existing = store.friendRequests.find(
      (r) => r.fromUserId === user.id && r.toUserId === targetUserId,
    );
    if (existing) {
      existing.createdAt = now;
    } else {
      store.friendRequests.push({
        id: generateId(),
        fromUserId: user.id,
        toUserId: targetUserId,
        status: 'pending',
        createdAt: now,
      });
    }
    persistStore();

    pushToUser(targetUserId, {
      type: 'social:friend_request',
      fromUserId: user.id,
      fromUsername: user.username,
      fromRank: user.rank,
    });

    res.status(201).json({ status: 'pending' });
  });

  app.post('/api/friends/requests/:id/accept', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const idx = store.friendRequests.findIndex(
      (r) => r.id === req.params.id && r.toUserId === user.id && r.status === 'pending',
    );
    if (idx < 0) {
      res.status(404).json({ error: 'Friend request not found.' });
      return;
    }

    const reqObj = store.friendRequests[idx];
    store.friendRequests.splice(idx, 1);
    if (!areFriends(reqObj.fromUserId, reqObj.toUserId)) {
      const [ua, ub] = canonicalPair(reqObj.fromUserId, reqObj.toUserId);
      store.friendships.push({ userAId: ua, userBId: ub, createdAt: Date.now() });
    }
    persistStore();

    pushToUser(reqObj.fromUserId, {
      type: 'social:refresh',
      notice: `${user.username} accepted your friend request.`,
    });
    pushToUser(reqObj.toUserId, { type: 'social:refresh' });
    res.json({ ok: true });
  });

  app.post('/api/friends/requests/:id/decline', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const idx = store.friendRequests.findIndex(
      (r) => r.id === req.params.id && r.toUserId === user.id,
    );
    if (idx < 0) {
      res.status(404).json({ error: 'Friend request not found.' });
      return;
    }
    const [removed] = store.friendRequests.splice(idx, 1);
    persistStore();
    pushToUser(removed.fromUserId, { type: 'social:refresh' });
    res.json({ ok: true });
  });

  app.delete('/api/friends/requests/:id', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const idx = store.friendRequests.findIndex(
      (r) => r.id === req.params.id && r.fromUserId === user.id,
    );
    if (idx < 0) {
      res.status(404).json({ error: 'Outgoing request not found.' });
      return;
    }
    const [removed] = store.friendRequests.splice(idx, 1);
    persistStore();
    pushToUser(removed.toUserId, { type: 'social:refresh' });
    res.json({ ok: true });
  });

  app.delete('/api/friends/:friendUserId', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const friendUserId = req.params.friendUserId;
    const [ua, ub] = canonicalPair(user.id, friendUserId);
    store.friendships = store.friendships.filter(
      (f) => !(f.userAId === ua && f.userBId === ub),
    );
    persistStore();
    pushToUser(friendUserId, { type: 'social:refresh' });
    res.json({ ok: true });
  });

  app.post('/api/social/invite', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const targetUserId = String(req.body?.targetUserId ?? '').trim();
    const lobbyCode = String(req.body?.lobbyCode ?? '').trim().toUpperCase();
    if (!targetUserId || !lobbyCode) {
      res.status(400).json({ error: 'Friend and lobby code are required.' });
      return;
    }

    if (!areFriends(user.id, targetUserId)) {
      res.status(403).json({ error: 'You can only send quick invites to friends on your list.' });
      return;
    }

    const delivered = pushToUser(targetUserId, {
      type: 'lobby:invite',
      invite: {
        id: generateId(),
        fromUserId: user.id,
        fromUsername: user.username,
        fromRank: user.rank,
        lobbyCode,
        mode: String(req.body?.mode ?? 'BATTLE'),
        mapName: String(req.body?.mapName ?? 'Pripyat Block'),
        eventName: req.body?.eventName ? String(req.body.eventName) : null,
        createdAt: Date.now(),
      },
    });

    res.json({ ok: true, delivered: delivered > 0 });
  });

  app.post('/api/players/recent', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const mode = String(req.body?.mode ?? 'battle').slice(0, 32);
    const peerIds = Array.from(new Set<string>(req.body?.peerUserIds ?? [])).filter(
      (id) => typeof id === 'string' && id.length > 0 && id !== user.id && Boolean(store.users[id]),
    );
    if (peerIds.length === 0) {
      res.json({ ok: true });
      return;
    }

    const now = Date.now();
    for (const peerId of peerIds) {
      const existing = store.recentPlayers.find(
        (rp) => rp.userId === user.id && rp.peerUserId === peerId,
      );
      if (existing) {
        existing.lastPlayedAt = now;
        existing.mode = mode;
      } else {
        store.recentPlayers.push({
          userId: user.id,
          peerUserId: peerId,
          lastPlayedAt: now,
          mode,
        });
      }
    }

    // Keep latest 25 per user
    const mine = store.recentPlayers
      .filter((rp) => rp.userId === user.id)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, 25);
    const others = store.recentPlayers.filter((rp) => rp.userId !== user.id);
    store.recentPlayers = [...others, ...mine];
    persistStore();

    res.json({ ok: true });
  });

  // === PHASE 3: SPECIAL EVENTS & MULTIPLAYER LOBBIES ===

  app.get('/api/events', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to view your Special Events.' });
      return;
    }
    const events = Object.values(store.specialEvents)
      .filter((e) => e.creatorUserId === user.id)
      .map((e) => ({
        ...e,
        creatorUsername: store.users[e.creatorUserId]?.username ?? e.creatorUsername,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ events });
  });

  app.post('/api/events', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to create a Special Event.' });
      return;
    }
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim().slice(0, 280);
    if (name.length < 2 || name.length > 48) {
      res.status(400).json({ error: 'Event name must be between 2 and 48 characters.' });
      return;
    }
    const config = sanitizeSpecialEventConfig(req.body?.config);
    const now = Date.now();
    const id = generateId();
    let hashCode = generateEventHashCode();
    const existingHashes = new Set(Object.values(store.specialEvents).map((e) => e.hashCode));
    while (existingHashes.has(hashCode)) {
      hashCode = generateEventHashCode();
    }
    const event: SpecialEventRecord = {
      id,
      hashCode,
      creatorUserId: user.id,
      creatorUsername: user.username,
      name,
      description,
      config,
      createdAt: now,
      updatedAt: now,
    };
    store.specialEvents[id] = event;
    persistStore();
    res.status(201).json({ event });
  });

  app.get('/api/events/by-hash/:hashCode', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    const hashCode = String(req.params.hashCode ?? '').trim().toUpperCase();
    const found = Object.values(store.specialEvents).find(
      (e) => e.hashCode.toUpperCase() === hashCode,
    );
    if (!found) {
      res.status(404).json({ error: 'No Special Event found for that hash code.' });
      return;
    }
    const active = Array.from(activeLobbyRooms.values()).find(
      (r) => r.state.specialEvent?.hashCode.toUpperCase() === hashCode,
    );
    res.json({
      event: {
        ...found,
        creatorUsername: store.users[found.creatorUserId]?.username ?? found.creatorUsername,
      },
      activeLobbyCode: active?.state.code ?? null,
    });
  });

  app.put('/api/events/:id', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to update your Special Event.' });
      return;
    }
    const existing = store.specialEvents[req.params.id];
    if (!existing || existing.creatorUserId !== user.id) {
      res.status(404).json({ error: 'Special Event not found or not owned by you.' });
      return;
    }
    const name = String(req.body?.name ?? existing.name).trim();
    const description = String(req.body?.description ?? existing.description).trim().slice(0, 280);
    if (name.length < 2 || name.length > 48) {
      res.status(400).json({ error: 'Event name must be between 2 and 48 characters.' });
      return;
    }
    const updated: SpecialEventRecord = {
      ...existing,
      creatorUsername: user.username,
      name,
      description,
      config: sanitizeSpecialEventConfig(req.body?.config ?? existing.config),
      updatedAt: Date.now(),
    };
    store.specialEvents[existing.id] = updated;
    persistStore();
    res.json({ event: updated });
  });

  app.delete('/api/events/:id', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    const existing = store.specialEvents[req.params.id];
    if (!existing || existing.creatorUserId !== user.id) {
      res.status(404).json({ error: 'Special Event not found.' });
      return;
    }
    delete store.specialEvents[req.params.id];
    persistStore();
    res.json({ ok: true });
  });

  app.get('/api/lobbies', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to browse lobbies.' });
      return;
    }
    const rooms = Array.from(activeLobbyRooms.values()).sort(
      (a, b) => b.state.updatedAt - a.state.updatedAt,
    );
    const publicLobbies = rooms
      .filter((r) => r.state.visibility === 'public')
      .map(lobbyToBrowserEntry);
    const friendLobbies = rooms
      .filter(
        (r) =>
          r.state.visibility === 'friends_only' &&
          (r.state.hostUserId === user.id || areFriends(user.id, r.state.hostUserId)),
      )
      .map(lobbyToBrowserEntry);
    res.json({ publicLobbies, friendLobbies });
  });

  app.post('/api/lobbies', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to host a lobby.' });
      return;
    }

    let specialEvent: SpecialEventRecord | null = null;
    if (req.body?.specialEventId) {
      const ev = store.specialEvents[String(req.body.specialEventId)];
      if (!ev) {
        res.status(404).json({ error: 'Special Event not found.' });
        return;
      }
      specialEvent = {
        ...ev,
        creatorUsername: store.users[ev.creatorUserId]?.username ?? ev.creatorUsername,
      };
    }

    const visibility: LobbyVisibility =
      req.body?.visibility === 'private' || req.body?.visibility === 'friends_only'
        ? req.body.visibility
        : 'public';
    const mode: LobbyModeId = specialEvent
      ? specialEvent.config.mode
      : req.body?.mode === 'infection'
        ? 'infection'
        : 'battle';
    const battleRule = specialEvent
      ? specialEvent.config.battleRule
      : req.body?.battleRule === 'ffa'
        ? 'ffa'
        : 'tdm';
    const validMaps = new Set([
      'pripyat_block',
      'timberline_compound',
      'korsakov_substation',
      'kino_theater',
    ]);
    const defaultMap = mode === 'infection' ? 'kino_theater' : 'pripyat_block';
    const mapId = specialEvent
      ? specialEvent.config.mapId
      : typeof req.body?.mapId === 'string' && validMaps.has(req.body.mapId)
        ? req.body.mapId
        : defaultMap;
    const maxPlayers = Math.max(
      2,
      Math.min(
        8,
        Math.round(Number(specialEvent ? specialEvent.config.maxPlayers : (req.body?.maxPlayers ?? 8)) || 8),
      ),
    );
    const botsEnabled = specialEvent
      ? specialEvent.config.botsEnabled
      : typeof req.body?.botsEnabled === 'boolean'
        ? req.body.botsEnabled
        : true;
    const botCount = botsEnabled
      ? Math.max(
          0,
          Math.min(
            10,
            Math.round(Number(specialEvent ? specialEvent.config.botCount : (req.body?.botCount ?? 6)) || 0),
          ),
        )
      : 0;
    const killLimit = Math.max(
      10,
      Math.min(
        100,
        Math.round(Number(specialEvent ? specialEvent.config.killLimit : (req.body?.killLimit ?? 30)) || 30),
      ),
    );
    const botDifficulty = specialEvent
      ? specialEvent.config.botDifficulty
      : req.body?.botDifficulty === 'recruit' || req.body?.botDifficulty === 'veteran'
        ? req.body.botDifficulty
        : 'tactical';
    const killfeedPolicy = specialEvent
      ? (specialEvent.config.killfeedPolicy ?? 'player_choice')
      : req.body?.killfeedPolicy === 'force_on' || req.body?.killfeedPolicy === 'force_off'
        ? req.body.killfeedPolicy
        : 'player_choice';

    let code = generateLobbyCode();
    while (activeLobbyRooms.has(code)) {
      code = generateLobbyCode();
    }

    const now = Date.now();
    const room: LocalLobbyRoom = {
      state: {
        code,
        hostUserId: user.id,
        hostUsername: user.username,
        visibility,
        mode,
        battleRule,
        mapId,
        maxPlayers,
        botsEnabled,
        botCount,
        killLimit,
        botDifficulty,
        killfeedPolicy,
        status: 'lobby',
        matchSequence: 0,
        specialEvent,
        members: [
          {
            userId: user.id,
            username: user.username,
            rank: user.rank,
            prestige: user.prestige,
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
            text: specialEvent
              ? `Special Event "${specialEvent.name}" opened by ${user.username}.`
              : `Lobby ${code} created by ${user.username}.`,
            system: true,
            createdAt: now,
          },
        ],
        updatedAt: now,
      },
      kickedUserIds: new Set(),
      invitedUserIds: new Set(),
      sockets: new Map(),
      matchState: createDefaultMatchState(),
    };

    activeLobbyRooms.set(code, room);
    res.status(201).json({ code, lobby: room.state });
  });

  app.post('/api/lobbies/resolve-join', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in to join a lobby.' });
      return;
    }

    const normalized = String(req.body?.codeOrHash ?? '').trim().toUpperCase();
    if (!normalized || normalized.length < 4) {
      res.status(400).json({ error: 'Enter a valid Lobby Code or Event Hash Code.' });
      return;
    }

    // 1) Active lobby hosting this Special Event hash code (permissionless direct join!)
    const eventRoom = Array.from(activeLobbyRooms.values()).find(
      (r) => r.state.specialEvent?.hashCode.toUpperCase() === normalized,
    );
    if (eventRoom) {
      const check = checkLocalLobbyAccess(eventRoom, user.id, normalized);
      if (!check.allowed) {
        res.status(check.status ?? 403).json({ error: check.error ?? 'Access denied.' });
        return;
      }
      res.json({
        lobbyCode: eventRoom.state.code,
        eventHash: normalized,
        joinType: 'event_hash',
      });
      return;
    }

    // 2) Saved Special Event exists but no active lobby running
    const savedEvent = Object.values(store.specialEvents).find(
      (e) => e.hashCode.toUpperCase() === normalized,
    );
    if (savedEvent) {
      const creatorName = store.users[savedEvent.creatorUserId]?.username ?? savedEvent.creatorUsername;
      res.status(404).json({
        error: `No active lobby is currently hosting "${savedEvent.name}". Ask ${creatorName} to launch it or host it yourself.`,
        savedEvent: { ...savedEvent, creatorUsername: creatorName },
      });
      return;
    }

    // 3) Standard lobby code
    const room = activeLobbyRooms.get(normalized);
    if (!room) {
      res.status(404).json({ error: 'Lobby not found or already closed.' });
      return;
    }
    const check = checkLocalLobbyAccess(room, user.id, null);
    if (!check.allowed) {
      res.status(check.status ?? 403).json({ error: check.error ?? 'Access denied.' });
      return;
    }
    res.json({ lobbyCode: room.state.code, eventHash: null, joinType: 'code' });
  });

  app.post('/api/lobbies/:code/invite', async (req, res) => {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }

    const code = String(req.params.code ?? '').trim().toUpperCase();
    const targetUserId = String(req.body?.targetUserId ?? '').trim();
    if (!targetUserId) {
      res.status(400).json({ error: 'Select a player to invite.' });
      return;
    }
    const room = activeLobbyRooms.get(code);
    if (!room) {
      res.status(404).json({ error: 'Lobby not found.' });
      return;
    }
    if (room.state.hostUserId !== user.id) {
      res.status(403).json({ error: 'Only the Host can invite players.' });
      return;
    }

    room.invitedUserIds.add(targetUserId);
    room.kickedUserIds.delete(targetUserId);

    const st = room.state;
    const delivered = pushToUser(targetUserId, {
      type: 'lobby:invite',
      invite: {
        id: generateId(),
        fromUserId: user.id,
        fromUsername: user.username,
        fromRank: user.rank,
        lobbyCode: st.code,
        mode: formatLobbyModeLabel(st.mode, st.battleRule),
        mapName: formatMapDisplayName(st.mapId),
        eventName: st.specialEvent?.name ?? null,
        createdAt: Date.now(),
      },
    });
    res.json({ ok: true, delivered: delivered > 0 });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const reqUrl = req.url ?? '';
    if (reqUrl.startsWith('/ws/social')) {
      void getUserByCookieHeader(req.headers.cookie).then((user) => {
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const conn: ConnectedSocialSocket = {
            ws,
            presence: {
              userId: user.id,
              username: user.username,
              rank: user.rank,
              prestige: user.prestige,
              status: 'online',
              lobbyCode: null,
              lobbyVisibility: null,
              lobbyMode: null,
              eventName: null,
              joinable: false,
              updatedAt: Date.now(),
            },
          };

          let userSet = socialSocketsByUser.get(user.id);
          if (!userSet) {
            userSet = new Set();
            socialSocketsByUser.set(user.id, userSet);
          }
          userSet.add(conn);

          const agg = getAggregatedPresence(user.id) ?? conn.presence;
          sendWsJson(ws, { type: 'social:connected', presence: agg });
          broadcastPresenceToFriends(user.id, agg);

          ws.on('message', (raw) => {
            try {
              const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
              if (parsed.type === 'ping') {
                sendWsJson(ws, { type: 'pong', ts: Date.now() });
                return;
              }
              if (parsed.type === 'presence:update') {
                const st = parsed.status;
                if (st === 'online' || st === 'in_lobby' || st === 'in_match') {
                  conn.presence.status = st;
                  conn.presence.lobbyCode =
                    typeof parsed.lobbyCode === 'string' ? parsed.lobbyCode : null;
                  conn.presence.lobbyVisibility =
                    parsed.lobbyVisibility === 'public' ||
                    parsed.lobbyVisibility === 'friends_only' ||
                    parsed.lobbyVisibility === 'private'
                      ? parsed.lobbyVisibility
                      : null;
                  conn.presence.lobbyMode =
                    typeof parsed.lobbyMode === 'string' ? parsed.lobbyMode : null;
                  conn.presence.eventName =
                    typeof parsed.eventName === 'string' ? parsed.eventName : null;
                  conn.presence.joinable = Boolean(parsed.joinable);
                  conn.presence.updatedAt = Date.now();

                  const nextAgg = getAggregatedPresence(user.id);
                  if (nextAgg) broadcastPresenceToFriends(user.id, nextAgg);
                }
              }
            } catch {
              // Ignore malformed frames
            }
          });

          const cleanup = () => {
            const set = socialSocketsByUser.get(user.id);
            if (set) {
              set.delete(conn);
              if (set.size === 0) {
                socialSocketsByUser.delete(user.id);
              }
            }
            const remaining = getAggregatedPresence(user.id);
            if (remaining) {
              broadcastPresenceToFriends(user.id, remaining);
            } else {
              broadcastPresenceToFriends(user.id, {
                ...conn.presence,
                status: 'offline',
                lobbyCode: null,
                lobbyVisibility: null,
                lobbyMode: null,
                eventName: null,
                joinable: false,
                updatedAt: Date.now(),
              });
            }
          };

          ws.on('close', cleanup);
          ws.on('error', cleanup);
        });
      });
      return;
    }

    if (reqUrl.startsWith('/ws/lobby/')) {
      void getUserByCookieHeader(req.headers.cookie).then((user) => {
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        const parsedUrl = new URL(reqUrl, 'http://localhost');
        const code = decodeURIComponent(parsedUrl.pathname.slice('/ws/lobby/'.length))
          .trim()
          .toUpperCase();
        const eventHash = parsedUrl.searchParams.get('eventHash')?.trim().toUpperCase() ?? null;
        const room = activeLobbyRooms.get(code);
        if (!room) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        const check = checkLocalLobbyAccess(room, user.id, eventHash);
        if (!check.allowed) {
          socket.write(`HTTP/1.1 ${check.status ?? 403} Forbidden\r\n\r\n`);
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          const st = room.state;
          const existing = st.members.find((m) => m.userId === user.id);
          const validEventHash =
            Boolean(eventHash) &&
            Boolean(st.specialEvent?.hashCode) &&
            eventHash === st.specialEvent?.hashCode.toUpperCase();

          if (!existing) {
            st.members.push({
              userId: user.id,
              username: user.username,
              rank: user.rank,
              prestige: user.prestige,
              team: pickBalancedLobbyTeam(st.members),
              ready: false,
              isHost: user.id === st.hostUserId,
              connected: true,
              joinedAt: Date.now(),
            });
            pushLobbySystemChat(
              room,
              validEventHash
                ? `${user.username} joined via Event Hash Code.`
                : `${user.username} joined the lobby.`,
            );
          } else {
            existing.username = user.username;
            existing.rank = user.rank;
            existing.prestige = user.prestige;
            existing.connected = true;
          }

          room.sockets.set(ws, {
            userId: user.id,
            username: user.username,
            rank: user.rank,
            prestige: user.prestige,
          });

          st.updatedAt = Date.now();
          broadcastLobbyRoom(room, { type: 'lobby:state', state: st });

          if (st.status === 'in_match') {
            sendWsJson(ws, {
              type: 'game:match_sync',
              powerOn: room.matchState.powerOn,
              openedDoorIds: room.matchState.openedDoorIds,
              unlockedZoneIds: room.matchState.unlockedZoneIds,
              round: room.matchState.round,
              zombiesRemaining: room.matchState.zombiesRemaining,
              senderIsHost: true,
              ts: Date.now(),
            });
          }

          ws.on('message', (raw) => {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(String(raw)) as Record<string, unknown>;
            } catch {
              return;
            }
            const isHost = user.id === st.hostUserId;

            if (parsed.type === 'ping') {
              sendWsJson(ws, { type: 'pong', ts: Date.now() });
              return;
            }

            if (parsed.type === 'lobby:update_settings') {
              if (!isHost) {
                sendWsJson(ws, {
                  type: 'lobby:error',
                  error: 'Only the Host can change lobby settings.',
                });
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
                patch.mapId === 'korsakov_substation' ||
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
              if (
                patch.killfeedPolicy === 'player_choice' ||
                patch.killfeedPolicy === 'force_on' ||
                patch.killfeedPolicy === 'force_off'
              ) {
                st.killfeedPolicy = patch.killfeedPolicy;
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
                    killfeedPolicy: st.killfeedPolicy,
                  }),
                };
              }
              st.updatedAt = Date.now();
              broadcastLobbyRoom(room, { type: 'lobby:state', state: st });
              return;
            }

            if (parsed.type === 'lobby:kick') {
              if (!isHost) {
                sendWsJson(ws, { type: 'lobby:error', error: 'Only the Host can kick players.' });
                return;
              }
              const targetId = String(parsed.targetUserId ?? '');
              if (!targetId || targetId === st.hostUserId) return;
              const targetMember = st.members.find((m) => m.userId === targetId);
              if (!targetMember) return;

              room.kickedUserIds.add(targetId);
              room.invitedUserIds.delete(targetId);
              for (const [sock, meta] of Array.from(room.sockets.entries())) {
                if (meta.userId === targetId) {
                  sendWsJson(sock, {
                    type: 'lobby:kicked',
                    reason: 'You were kicked by the lobby Host.',
                  });
                  room.sockets.delete(sock);
                  try {
                    sock.close(4003, 'Kicked by Host');
                  } catch {
                    // Ignore
                  }
                }
              }
              removeLocalLobbyMember(room, targetId, `${targetMember.username} was kicked by the Host.`);
              return;
            }

            if (parsed.type === 'lobby:switch_team') {
              const member = st.members.find((m) => m.userId === user.id);
              if (!member) return;
              member.team = parsed.team === 'B' ? 'B' : 'A';
              st.updatedAt = Date.now();
              broadcastLobbyRoom(room, { type: 'lobby:state', state: st });
              return;
            }

            if (parsed.type === 'lobby:toggle_ready') {
              const member = st.members.find((m) => m.userId === user.id);
              if (!member) return;
              member.ready = !member.ready;
              st.updatedAt = Date.now();
              broadcastLobbyRoom(room, { type: 'lobby:state', state: st });
              return;
            }

            if (parsed.type === 'lobby:chat') {
              const text = String(parsed.text ?? '').trim().slice(0, 240);
              if (!text) return;
              const msg: LobbyChatMessage = {
                id: generateId(),
                userId: user.id,
                username: user.username,
                text,
                createdAt: Date.now(),
              };
              st.chat = [...st.chat.slice(-49), msg];
              st.updatedAt = Date.now();
              broadcastLobbyRoom(room, { type: 'lobby:chat', message: msg });
              return;
            }

            if (parsed.type === 'lobby:start_match') {
              if (!isHost) {
                sendWsJson(ws, { type: 'lobby:error', error: 'Only the Host can start the match.' });
                return;
              }
              st.status = 'in_match';
              st.matchSequence += 1;
              st.updatedAt = Date.now();
              room.matchState = createDefaultMatchState();
              pushLobbySystemChat(room, `Host ${user.username} launched the match.`);
              recordLocalRecentPlayers(st);
              broadcastLobbyRoom(room, { type: 'lobby:state', state: st });
              broadcastLobbyRoom(room, { type: 'match:start', state: st });
              return;
            }

            if (parsed.type === 'match:restart') {
              if (!isHost) {
                sendWsJson(ws, { type: 'lobby:error', error: 'Only the Host can restart the match.' });
                return;
              }
              st.status = 'in_match';
              st.matchSequence += 1;
              st.updatedAt = Date.now();
              room.matchState = createDefaultMatchState();
              broadcastLobbyRoom(room, { type: 'match:restart', state: st });
              return;
            }

            if (parsed.type === 'match:end_to_lobby') {
              if (!isHost) {
                sendWsJson(ws, {
                  type: 'lobby:error',
                  error: 'Only the Host can end the match for the whole squad.',
                });
                return;
              }
              st.status = 'lobby';
              room.matchState = createDefaultMatchState();
              if (
                st.specialEvent?.config.cycleModesBetweenGames &&
                st.specialEvent.config.cyclePool.length > 1
              ) {
                const pool = st.specialEvent.config.cyclePool;
                const curKey =
                  st.mode === 'infection'
                    ? 'infection'
                    : st.battleRule === 'ffa'
                      ? 'battle_ffa'
                      : 'battle_tdm';
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
                pushLobbySystemChat(
                  room,
                  `Event cycled next game to ${nextKey === 'infection' ? 'INFECTION' : nextKey === 'battle_ffa' ? 'BATTLE · FFA' : 'BATTLE · TDM'}.`,
                );
              }
              st.updatedAt = Date.now();
              pushLobbySystemChat(
                room,
                `Host ${user.username} ended the match and returned the squad to lobby.`,
              );
              broadcastLobbyRoom(room, { type: 'match:end_to_lobby', state: st });
              broadcastLobbyRoom(room, { type: 'lobby:state', state: st });
              return;
            }

            if (parsed.type === 'lobby:leave') {
              room.sockets.delete(ws);
              removeLocalLobbyMember(room, user.id);
              try {
                ws.close(1000, 'Left lobby');
              } catch {
                // Ignore
              }
              return;
            }

            if (typeof parsed.type === 'string' && parsed.type.startsWith('game:')) {
              const res = validateAndSanitizeGameMessage(parsed, st, room.matchState, {
                userId: user.id,
                username: user.username,
              });
              if (!res) return;

              if (res.targetUserId) {
                sendToLobbyUser(room, res.targetUserId, res.payload);
              } else {
                broadcastLobbyRoom(room, res.payload, user.id);
              }
            }
          });

          const cleanup = () => {
            room.sockets.delete(ws);
            let stillConnected = false;
            for (const meta of room.sockets.values()) {
              if (meta.userId === user.id) {
                stillConnected = true;
                break;
              }
            }
            if (!stillConnected) {
              removeLocalLobbyMember(room, user.id);
            }
          };

          ws.on('close', cleanup);
          ws.on('error', cleanup);
        });
      });
      return;
    }

    socket.destroy();
  });

  if (IS_PROD) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[CORDON-04] Server running at http://0.0.0.0:${PORT}`);
  });
}

void startServer();

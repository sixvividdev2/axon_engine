import {
  formatLobbyModeLabel,
  formatMapDisplayName,
  generateEventHashCode,
  generateLobbyCode,
  LobbyBrowserEntry,
  LobbyModeId,
  LobbyRoomState,
  LobbyVisibility,
  sanitizeSpecialEventConfig,
  sanitizeTimeOfDayStart,
  sanitizeWeatherPreset,
  SpecialEventRecord,
  TimeOfDayStartSetting,
  WeatherPresetId,
} from '../data/multiplayer';
import {
  applyMatchProgression,
  buildRecentMatchRecord,
  CareerProgressionState,
  getStarterUnlockedAttachments,
  MAX_RECENT_MATCHES,
  RecentMatchRecord,
  sanitizeMatchResultInput,
  sanitizeRecentMatchRecord,
  WeaponProgressRecord,
} from '../data/progression';
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
} from './crypto';
import { LobbyRoomDO, SocialHubDO } from './durableObjects';
import { sendWelcomeEmail } from './email';
import { D1Database, ExecutionContext, UserPresenceState, WorkerEnv } from './types';

export { LobbyRoomDO, SocialHubDO };

interface DbUserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  password_salt: string;
  rank: number;
  xp: number;
  prestige: number;
  prestige_xp: number;
  cash: number;
  kills: number;
  deaths: number;
  wins: number;
  losses: number;
  matches_played: number;
  highest_infection_round: number;
  created_at: number;
  updated_at: number;
}

interface DbWeaponProgressRow {
  weapon_id: string;
  xp: number;
  level: number;
  kills: number;
}

interface DbAttachmentRow {
  attachment_id: string;
}

interface DbRecentMatchRow {
  id: string;
  completed_at: number;
  payload_json: string;
}

interface DbSpecialEventRow {
  id: string;
  hash_code: string;
  creator_user_id: string;
  creator_username: string;
  name: string;
  description: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

interface DbActiveLobbyRow {
  code: string;
  host_user_id: string;
  host_username: string;
  visibility: string;
  mode: string;
  map_id: string;
  event_id: string | null;
  event_hash_code: string | null;
  event_name: string | null;
  creator_username: string | null;
  player_count: number;
  max_players: number;
  bots_enabled: number;
  bot_count: number;
  status: string;
  updated_at: number;
}

function rowToSpecialEvent(row: DbSpecialEventRow): SpecialEventRecord {
  let parsedConfig: unknown = {};
  try {
    parsedConfig = JSON.parse(row.config_json);
  } catch {
    parsedConfig = {};
  }
  return {
    id: row.id,
    hashCode: row.hash_code,
    creatorUserId: row.creator_user_id,
    creatorUsername: row.creator_username,
    name: row.name,
    description: row.description,
    config: sanitizeSpecialEventConfig(parsedConfig),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBrowserEntry(row: DbActiveLobbyRow): LobbyBrowserEntry {
  const mode: LobbyModeId = row.mode === 'infection' ? 'infection' : 'battle';
  const battleRule = row.mode === 'battle_ffa' ? 'ffa' : 'tdm';
  const visibility: LobbyVisibility =
    row.visibility === 'private' || row.visibility === 'friends_only'
      ? row.visibility
      : 'public';
  return {
    code: row.code,
    hostUserId: row.host_user_id,
    hostUsername: row.host_username,
    visibility,
    mode,
    battleRule,
    mapId: row.map_id,
    playerCount: row.player_count,
    maxPlayers: row.max_players,
    botsEnabled: row.bots_enabled === 1,
    botCount: row.bot_count,
    status: row.status === 'in_match' ? 'in_match' : 'lobby',
    eventHashCode: row.event_hash_code,
    eventName: row.event_name,
    creatorUsername: row.creator_username,
    updatedAt: row.updated_at,
  };
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

function isHttpsRequest(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.toLowerCase() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return true;
  }
}

function verifyCsrfHeaderOrOrigin(request: Request): boolean {
  const xrw = request.headers.get('x-requested-with');
  if (xrw === 'XMLHttpRequest') return true;
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (origin && host) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const parsed = (await request.json()) as T;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalFriendPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function getSocialHubStub(env: WorkerEnv) {
  return env.SOCIAL_HUB.get(env.SOCIAL_HUB.idFromName('global'));
}

async function pushSocialEvent(
  env: WorkerEnv,
  targetUserIds: string[],
  event: unknown,
): Promise<number> {
  if (targetUserIds.length === 0) return 0;
  try {
    const res = await getSocialHubStub(env).fetch('https://social-hub/internal/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserIds, event }),
    });
    const data = (await res.json().catch(() => ({}))) as { delivered?: number };
    return data.delivered ?? 0;
  } catch {
    return 0;
  }
}

async function fetchPresenceBatch(
  env: WorkerEnv,
  userIds: string[],
): Promise<Record<string, UserPresenceState>> {
  if (userIds.length === 0) return {};
  try {
    const res = await getSocialHubStub(env).fetch('https://social-hub/internal/presence-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      presence?: Record<string, UserPresenceState>;
    };
    return data.presence ?? {};
  } catch {
    return {};
  }
}

async function loadAccountPayload(db: D1Database, userRow: DbUserRow) {
  const [wpRes, attRes, rmRes] = await Promise.all([
    db
      .prepare('SELECT weapon_id, xp, level, kills FROM weapon_progress WHERE user_id = ?')
      .bind(userRow.id)
      .all<DbWeaponProgressRow>(),
    db
      .prepare('SELECT attachment_id FROM unlocked_attachments WHERE user_id = ?')
      .bind(userRow.id)
      .all<DbAttachmentRow>(),
    db
      .prepare(
        'SELECT id, completed_at, payload_json FROM recent_matches WHERE user_id = ? ORDER BY completed_at DESC LIMIT ?',
      )
      .bind(userRow.id, MAX_RECENT_MATCHES)
      .all<DbRecentMatchRow>()
      .catch(() => ({ results: [] as DbRecentMatchRow[] })),
  ]);

  const weaponProgress: Record<string, WeaponProgressRecord> = {};
  for (const row of wpRes.results ?? []) {
    weaponProgress[row.weapon_id] = {
      weaponId: row.weapon_id,
      xp: row.xp,
      level: row.level,
      kills: row.kills,
    };
  }

  const unlockedSet = new Set<string>(getStarterUnlockedAttachments());
  for (const row of attRes.results ?? []) {
    unlockedSet.add(row.attachment_id);
  }

  const recentMatches: RecentMatchRecord[] = [];
  for (const row of rmRes.results ?? []) {
    try {
      const parsed = JSON.parse(row.payload_json);
      const clean = sanitizeRecentMatchRecord(parsed);
      if (clean) recentMatches.push(clean);
    } catch {
      // Ignore malformed stored match row
    }
  }

  return {
    id: userRow.id,
    email: userRow.email,
    username: userRow.username,
    rank: userRow.rank,
    xp: userRow.xp,
    prestige: userRow.prestige,
    prestigeXp: userRow.prestige_xp,
    cash: userRow.cash,
    kills: userRow.kills,
    deaths: userRow.deaths,
    wins: userRow.wins,
    losses: userRow.losses,
    matchesPlayed: userRow.matches_played,
    highestInfectionRound: userRow.highest_infection_round,
    createdAt: userRow.created_at,
    weaponProgress,
    unlockedAttachments: Array.from(unlockedSet),
    recentMatches,
  };
}

async function authenticateRequest(request: Request, db: D1Database): Promise<DbUserRow | null> {
  const cookies = parseCookieHeader(request.headers.get('cookie'));
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (!rawToken || rawToken.length < 16) return null;

  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const row = await db
    .prepare(
      `SELECT u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<DbUserRow>();

  return row ?? null;
}

async function createSession(db: D1Database, userId: string): Promise<string> {
  const rawToken = generateRandomHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, userId, expiresAt, now)
    .run();

  return rawToken;
}

async function loadSocialOverview(env: WorkerEnv, userId: string) {
  const [friendsRes, incomingRes, outgoingRes, recentRes] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.username, u.rank, u.prestige, f.created_at AS friends_since
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END
       WHERE f.user_a_id = ? OR f.user_b_id = ?
       ORDER BY u.username_lower ASC`,
    )
      .bind(userId, userId, userId)
      .all<{
        id: string;
        username: string;
        rank: number;
        prestige: number;
        friends_since: number;
      }>(),
    env.DB.prepare(
      `SELECT r.id, r.from_user_id, r.created_at, u.username, u.rank, u.prestige
       FROM friend_requests r
       JOIN users u ON u.id = r.from_user_id
       WHERE r.to_user_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
    )
      .bind(userId)
      .all<{
        id: string;
        from_user_id: string;
        created_at: number;
        username: string;
        rank: number;
        prestige: number;
      }>(),
    env.DB.prepare(
      `SELECT r.id, r.to_user_id, r.created_at, u.username, u.rank, u.prestige
       FROM friend_requests r
       JOIN users u ON u.id = r.to_user_id
       WHERE r.from_user_id = ? AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
    )
      .bind(userId)
      .all<{
        id: string;
        to_user_id: string;
        created_at: number;
        username: string;
        rank: number;
        prestige: number;
      }>(),
    env.DB.prepare(
      `SELECT rp.peer_user_id, rp.last_played_at, rp.mode, u.username, u.rank, u.prestige
       FROM recent_players rp
       JOIN users u ON u.id = rp.peer_user_id
       WHERE rp.user_id = ?
       ORDER BY rp.last_played_at DESC
       LIMIT 25`,
    )
      .bind(userId)
      .all<{
        peer_user_id: string;
        last_played_at: number;
        mode: string;
        username: string;
        rank: number;
        prestige: number;
      }>(),
  ]);

  const friendRows = friendsRes.results ?? [];
  const friendIds = friendRows.map((f) => f.id);
  const friendIdSet = new Set(friendIds);
  const incomingRows = incomingRes.results ?? [];
  const outgoingRows = outgoingRes.results ?? [];
  const incomingByUser = new Set(incomingRows.map((r) => r.from_user_id));
  const outgoingByUser = new Set(outgoingRows.map((r) => r.to_user_id));

  const livePresence = await fetchPresenceBatch(env, friendIds);

  const friends = friendRows.map((f) => {
    const p = livePresence[f.id];
    const isPrivate = p?.lobbyVisibility === 'private';
    return {
      userId: f.id,
      username: f.username,
      rank: f.rank,
      prestige: f.prestige,
      friendsSince: f.friends_since,
      status: p?.status ?? 'offline',
      lobbyCode: isPrivate ? null : (p?.lobbyCode ?? null),
      lobbyVisibility: isPrivate ? null : (p?.lobbyVisibility ?? null),
      lobbyMode: isPrivate ? null : (p?.lobbyMode ?? null),
      eventName: isPrivate ? null : (p?.eventName ?? null),
      joinable: isPrivate ? false : Boolean(p?.joinable),
    };
  });

  const incomingRequests = incomingRows.map((r) => ({
    id: r.id,
    userId: r.from_user_id,
    username: r.username,
    rank: r.rank,
    prestige: r.prestige,
    createdAt: r.created_at,
  }));

  const outgoingRequests = outgoingRows.map((r) => ({
    id: r.id,
    userId: r.to_user_id,
    username: r.username,
    rank: r.rank,
    prestige: r.prestige,
    createdAt: r.created_at,
  }));

  const recentPlayers = (recentRes.results ?? []).map((rp) => ({
    userId: rp.peer_user_id,
    username: rp.username,
    rank: rp.rank,
    prestige: rp.prestige,
    mode: rp.mode,
    lastPlayedAt: rp.last_played_at,
    relationship: friendIdSet.has(rp.peer_user_id)
      ? 'friend'
      : incomingByUser.has(rp.peer_user_id)
        ? 'incoming'
        : outgoingByUser.has(rp.peer_user_id)
          ? 'outgoing'
          : 'none',
  }));

  return { friends, incomingRequests, outgoingRequests, recentPlayers };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const pepper = env.PASSWORD_PEPPER ?? '';
    const isHttps = isHttpsRequest(request);

    // Authenticated WebSocket route: Social Hub live presence & invites
    if (path === '/ws/social') {
      const userRow = await authenticateRequest(request, env.DB);
      if (!userRow) return json({ error: 'Authentication required.' }, 401);

      const headers = new Headers(request.headers);
      // Strip any client-supplied auth headers and attach server-verified identity
      headers.delete('X-Auth-User-Id');
      headers.delete('X-Auth-Username');
      headers.delete('X-Auth-Rank');
      headers.delete('X-Auth-Prestige');
      headers.set('X-Auth-User-Id', userRow.id);
      headers.set('X-Auth-Username', userRow.username);
      headers.set('X-Auth-Rank', String(userRow.rank));
      headers.set('X-Auth-Prestige', String(userRow.prestige));

      const authedReq = new Request(request.url, { method: request.method, headers });
      return getSocialHubStub(env).fetch(authedReq);
    }

    if (path.startsWith('/ws/lobby/')) {
      const userRow = await authenticateRequest(request, env.DB);
      if (!userRow) return json({ error: 'Authentication required.' }, 401);

      const code = decodeURIComponent(path.slice('/ws/lobby/'.length)).trim().toUpperCase();
      if (!code || code.length > 24) return json({ error: 'Lobby code is required.' }, 400);

      const headers = new Headers(request.headers);
      headers.delete('X-Auth-User-Id');
      headers.delete('X-Auth-Username');
      headers.delete('X-Auth-Rank');
      headers.delete('X-Auth-Prestige');
      headers.set('X-Auth-User-Id', userRow.id);
      headers.set('X-Auth-Username', userRow.username);
      headers.set('X-Auth-Rank', String(userRow.rank));
      headers.set('X-Auth-Prestige', String(userRow.prestige));

      const authedReq = new Request(request.url, { method: request.method, headers });
      const id = env.LOBBY_ROOM.idFromName(code);
      return env.LOBBY_ROOM.get(id).fetch(authedReq);
    }

    // REST API routes
    if (path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD' && !verifyCsrfHeaderOrOrigin(request)) {
        return json({ error: 'Invalid request origin.' }, 403);
      }

      if (path === '/api/health' && method === 'GET') {
        return json({ ok: true, runtime: 'cloudflare-worker' });
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ user: null }, 200);
        const user = await loadAccountPayload(env.DB, userRow);
        return json({ user }, 200);
      }

      if (path === '/api/auth/register' && method === 'POST') {
        const body = await readJsonBody<{
          email?: string;
          username?: string;
          password?: string;
        }>(request);
        if (!body) return json({ error: 'Invalid JSON request body.' }, 400);

        const email = String(body.email ?? '').trim();
        const username = String(body.username ?? '').trim();
        const password = String(body.password ?? '');

        const emailErr = validateEmail(email);
        if (emailErr) return json({ error: emailErr }, 400);
        const userErr = validateUsername(username);
        if (userErr) return json({ error: userErr }, 400);
        const passErr = validatePassword(password);
        if (passErr) return json({ error: passErr }, 400);

        const emailLower = email.toLowerCase();
        const usernameLower = username.toLowerCase();

        const existing = await env.DB.prepare(
          'SELECT email_lower, username_lower FROM users WHERE email_lower = ? OR username_lower = ? LIMIT 1',
        )
          .bind(emailLower, usernameLower)
          .first<{ email_lower: string; username_lower: string }>();

        if (existing) {
          if (existing.username_lower === usernameLower) {
            return json(
              { error: 'That username is already taken. Choose a different callsign.' },
              409,
            );
          }
          return json({ error: 'An account with this email already exists.' }, 409);
        }

        const { hashHex, saltHex } = await hashPassword(password, pepper);
        const userId = generateId();
        const now = Date.now();
        const starterAttachments = getStarterUnlockedAttachments();

        const statements = [
          env.DB.prepare(
            `INSERT INTO users (
              id, email, email_lower, username, username_lower,
              password_hash, password_salt,
              rank, xp, prestige, prestige_xp, cash,
              kills, deaths, wins, losses, matches_played, highest_infection_round,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
          ).bind(userId, email, emailLower, username, usernameLower, hashHex, saltHex, now, now),
          ...starterAttachments.map((attId) =>
            env.DB.prepare(
              'INSERT OR IGNORE INTO unlocked_attachments (user_id, attachment_id, unlocked_at) VALUES (?, ?, ?)',
            ).bind(userId, attId, now),
          ),
        ];

        try {
          await env.DB.batch(statements);
        } catch {
          return json({ error: 'Username or email is already registered.' }, 409);
        }

        const rawToken = await createSession(env.DB, userId);
        const createdUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(userId)
          .first<DbUserRow>();

        ctx.waitUntil(sendWelcomeEmail(env, email, username));

        const payload = createdUser ? await loadAccountPayload(env.DB, createdUser) : null;
        return json({ user: payload }, 201, {
          'Set-Cookie': buildSessionCookie(rawToken, isHttps),
        });
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const body = await readJsonBody<{ identifier?: string; password?: string }>(request);
        if (!body) return json({ error: 'Invalid JSON request body.' }, 400);

        const identifier = String(body.identifier ?? '').trim().toLowerCase();
        const password = String(body.password ?? '');
        if (!identifier || !password) {
          return json({ error: 'Enter your username or email and password.' }, 400);
        }

        const userRow = await env.DB.prepare(
          'SELECT * FROM users WHERE email_lower = ? OR username_lower = ? LIMIT 1',
        )
          .bind(identifier, identifier)
          .first<DbUserRow>();

        if (!userRow) {
          return json({ error: 'Invalid credentials.' }, 401);
        }

        const valid = await verifyPassword(
          password,
          pepper,
          userRow.password_salt,
          userRow.password_hash,
        );
        if (!valid) {
          return json({ error: 'Invalid credentials.' }, 401);
        }

        const rawToken = await createSession(env.DB, userRow.id);
        const user = await loadAccountPayload(env.DB, userRow);
        return json({ user }, 200, {
          'Set-Cookie': buildSessionCookie(rawToken, isHttps),
        });
      }

      if (path === '/api/auth/logout' && method === 'POST') {
        const cookies = parseCookieHeader(request.headers.get('cookie'));
        const rawToken = cookies[SESSION_COOKIE_NAME];
        if (rawToken) {
          const tokenHash = await sha256Hex(rawToken);
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
        }
        return json({ ok: true }, 200, {
          'Set-Cookie': buildClearSessionCookie(isHttps),
        });
      }

      if (path === '/api/account/username' && method === 'PATCH') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to update your username.' }, 401);

        const body = await readJsonBody<{ username?: string }>(request);
        const nextUsername = String(body?.username ?? '').trim();
        const validationErr = validateUsername(nextUsername);
        if (validationErr) return json({ error: validationErr }, 400);

        const nextLower = nextUsername.toLowerCase();
        if (nextLower === userRow.username.toLowerCase() && nextUsername === userRow.username) {
          const user = await loadAccountPayload(env.DB, userRow);
          return json({ user }, 200);
        }

        const taken = await env.DB.prepare(
          'SELECT id FROM users WHERE username_lower = ? AND id != ? LIMIT 1',
        )
          .bind(nextLower, userRow.id)
          .first<{ id: string }>();

        if (taken) {
          return json({ error: 'That username is already in use by another account.' }, 409);
        }

        const now = Date.now();
        try {
          await env.DB.prepare(
            'UPDATE users SET username = ?, username_lower = ?, updated_at = ? WHERE id = ?',
          )
            .bind(nextUsername, nextLower, now, userRow.id)
            .run();
        } catch {
          return json({ error: 'That username is already in use by another account.' }, 409);
        }

        ctx.waitUntil(
          getSocialHubStub(env)
            .fetch('https://social-hub/internal/rename', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: userRow.id, username: nextUsername }),
            })
            .catch(() => {}),
        );

        const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(userRow.id)
          .first<DbUserRow>();
        const user = updated ? await loadAccountPayload(env.DB, updated) : null;
        return json({ user }, 200);
      }

      if (path === '/api/account/reset' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to reset account progress.' }, 401);

        const body = await readJsonBody<{ confirm?: string }>(request);
        if (body?.confirm !== 'RESET_ALL_PROGRESS') {
          return json({ error: 'Explicit reset confirmation is required.' }, 400);
        }

        const now = Date.now();
        const starterAttachments = getStarterUnlockedAttachments();

        await env.DB.batch([
          env.DB.prepare(
            `UPDATE users
             SET rank = 1, xp = 0, prestige = 0, prestige_xp = 0, cash = 0,
                 kills = 0, deaths = 0, wins = 0, losses = 0,
                 matches_played = 0, highest_infection_round = 0, updated_at = ?
             WHERE id = ?`,
          ).bind(now, userRow.id),
          env.DB.prepare('DELETE FROM weapon_progress WHERE user_id = ?').bind(userRow.id),
          env.DB.prepare('DELETE FROM unlocked_attachments WHERE user_id = ?').bind(userRow.id),
          env.DB.prepare('DELETE FROM recent_matches WHERE user_id = ?').bind(userRow.id),
          ...starterAttachments.map((attId) =>
            env.DB.prepare(
              'INSERT OR IGNORE INTO unlocked_attachments (user_id, attachment_id, unlocked_at) VALUES (?, ?, ?)',
            ).bind(userRow.id, attId, now),
          ),
        ]);

        const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(userRow.id)
          .first<DbUserRow>();
        const user = updated ? await loadAccountPayload(env.DB, updated) : null;
        return json({ user, reset: true }, 200);
      }

      if (path === '/api/progression/commit' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to save match progression.' }, 401);

        const rawBody = await readJsonBody<unknown>(request);
        const body = sanitizeMatchResultInput(rawBody);
        if (!body) {
          return json({ error: 'Invalid match progression payload.' }, 400);
        }

        const currentAccount = await loadAccountPayload(env.DB, userRow);
        const career: CareerProgressionState = {
          rank: currentAccount.rank,
          xp: currentAccount.xp,
          prestige: currentAccount.prestige,
          prestigeXp: currentAccount.prestigeXp,
          cash: currentAccount.cash,
          kills: currentAccount.kills,
          deaths: currentAccount.deaths,
          wins: currentAccount.wins,
          losses: currentAccount.losses,
          matchesPlayed: currentAccount.matchesPlayed,
          highestInfectionRound: currentAccount.highestInfectionRound,
        };

        const { nextCareer, nextWeaponProgress, nextUnlockedAttachments, summary } =
          applyMatchProgression(
            career,
            currentAccount.weaponProgress,
            new Set(currentAccount.unlockedAttachments),
            body,
          );

        const now = Date.now();
        const recentRecord = buildRecentMatchRecord(body, {
          id: generateId(),
          completedAt: now,
          netXp: summary.breakdown.netXp,
          cashEarned: summary.breakdown.cashEarned,
          isGuest: false,
        });

        const stmts = [
          env.DB.prepare(
            `UPDATE users
             SET rank = ?, xp = ?, prestige = ?, prestige_xp = ?, cash = ?,
                 kills = ?, deaths = ?, wins = ?, losses = ?,
                 matches_played = ?, highest_infection_round = ?, updated_at = ?
             WHERE id = ?`,
          ).bind(
            nextCareer.rank,
            nextCareer.xp,
            nextCareer.prestige,
            nextCareer.prestigeXp,
            nextCareer.cash,
            nextCareer.kills,
            nextCareer.deaths,
            nextCareer.wins,
            nextCareer.losses,
            nextCareer.matchesPlayed,
            nextCareer.highestInfectionRound,
            now,
            userRow.id,
          ),
        ];

        for (const rec of Object.values(nextWeaponProgress)) {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO weapon_progress (user_id, weapon_id, xp, level, kills, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id, weapon_id)
               DO UPDATE SET xp = excluded.xp, level = excluded.level, kills = excluded.kills, updated_at = excluded.updated_at`,
            ).bind(userRow.id, rec.weaponId, rec.xp, rec.level, rec.kills, now),
          );
        }

        for (const attId of nextUnlockedAttachments) {
          stmts.push(
            env.DB.prepare(
              'INSERT OR IGNORE INTO unlocked_attachments (user_id, attachment_id, unlocked_at) VALUES (?, ?, ?)',
            ).bind(userRow.id, attId, now),
          );
        }

        stmts.push(
          env.DB.prepare(
            `INSERT INTO recent_matches (id, user_id, completed_at, payload_json)
             VALUES (?, ?, ?, ?)`,
          ).bind(recentRecord.id, userRow.id, recentRecord.completedAt, JSON.stringify(recentRecord)),
          env.DB.prepare(
            `DELETE FROM recent_matches
             WHERE user_id = ? AND id NOT IN (
               SELECT id FROM recent_matches
               WHERE user_id = ?
               ORDER BY completed_at DESC
               LIMIT ?
             )`,
          ).bind(userRow.id, userRow.id, MAX_RECENT_MATCHES),
        );

        await env.DB.batch(stmts);

        const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
          .bind(userRow.id)
          .first<DbUserRow>();
        const user = updated ? await loadAccountPayload(env.DB, updated) : null;
        return json({ user, summary }, 200);
      }

      // === PHASE 2: SOCIAL HUB ENDPOINTS ===

      if (path === '/api/social/overview' && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to view the Social Hub.' }, 401);
        const overview = await loadSocialOverview(env, userRow.id);
        return json(overview, 200);
      }

      if (path === '/api/players/search' && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to search players.' }, 401);

        const rawQ = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        if (rawQ.length < 2) return json({ players: [] }, 200);

        const escaped = rawQ.replace(/[%_\\]/g, '\\$&');
        const prefixPattern = `${escaped}%`;
        const containsPattern = `%${escaped}%`;

        const matchesRes = await env.DB.prepare(
          `SELECT id, username, rank, prestige
           FROM users
           WHERE id != ? AND username_lower LIKE ? ESCAPE '\\'
           ORDER BY CASE WHEN username_lower = ? THEN 0 WHEN username_lower LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                    username_lower ASC
           LIMIT 15`,
        )
          .bind(userRow.id, containsPattern, rawQ, prefixPattern)
          .all<{ id: string; username: string; rank: number; prestige: number }>();

        const overview = await loadSocialOverview(env, userRow.id);
        const friendIds = new Set(overview.friends.map((f) => f.userId));
        const incomingByUser = new Map(overview.incomingRequests.map((r) => [r.userId, r.id]));
        const outgoingByUser = new Map(overview.outgoingRequests.map((r) => [r.userId, r.id]));

        const players = (matchesRes.results ?? []).map((p) => ({
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

        return json({ players }, 200);
      }

      if (path === '/api/friends/request' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to send friend requests.' }, 401);

        const body = await readJsonBody<{ targetUserId?: string }>(request);
        const targetUserId = String(body?.targetUserId ?? '').trim();
        if (!targetUserId || targetUserId === userRow.id) {
          return json({ error: 'Select a valid player to add.' }, 400);
        }

        const targetUser = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?')
          .bind(targetUserId)
          .first<{ id: string; username: string }>();
        if (!targetUser) return json({ error: 'Player not found.' }, 404);

        const [a, b] = canonicalFriendPair(userRow.id, targetUserId);
        const alreadyFriends = await env.DB.prepare(
          'SELECT 1 FROM friendships WHERE user_a_id = ? AND user_b_id = ?',
        )
          .bind(a, b)
          .first();
        if (alreadyFriends) {
          return json({ error: 'You are already friends with this player.' }, 409);
        }

        const now = Date.now();

        // If target already sent us a pending request, auto-accept into a friendship!
        const reciprocal = await env.DB.prepare(
          `SELECT id FROM friend_requests
           WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'`,
        )
          .bind(targetUserId, userRow.id)
          .first<{ id: string }>();

        if (reciprocal) {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(reciprocal.id),
            env.DB.prepare(
              'INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at) VALUES (?, ?, ?)',
            ).bind(a, b, now),
          ]);
          ctx.waitUntil(
            pushSocialEvent(env, [userRow.id, targetUserId], {
              type: 'social:refresh',
              notice: `${userRow.username} and ${targetUser.username} are now friends.`,
            }),
          );
          return json({ status: 'accepted' }, 200);
        }

        const existingReq = await env.DB.prepare(
          `SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`,
        )
          .bind(userRow.id, targetUserId)
          .first<{ id: string }>();

        if (existingReq) {
          await env.DB.prepare(
            `UPDATE friend_requests SET status = 'pending', created_at = ? WHERE id = ?`,
          )
            .bind(now, existingReq.id)
            .run();
        } else {
          await env.DB.prepare(
            `INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at)
             VALUES (?, ?, ?, 'pending', ?)`,
          )
            .bind(generateId(), userRow.id, targetUserId, now)
            .run();
        }

        ctx.waitUntil(
          pushSocialEvent(env, [targetUserId], {
            type: 'social:friend_request',
            fromUserId: userRow.id,
            fromUsername: userRow.username,
            fromRank: userRow.rank,
          }),
        );

        return json({ status: 'pending' }, 201);
      }

      const acceptMatch = path.match(/^\/api\/friends\/requests\/([^/]+)\/accept$/);
      if (acceptMatch && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const reqId = decodeURIComponent(acceptMatch[1]);
        const reqRow = await env.DB.prepare(
          `SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ? AND status = 'pending'`,
        )
          .bind(reqId)
          .first<{ id: string; from_user_id: string; to_user_id: string }>();

        if (!reqRow || reqRow.to_user_id !== userRow.id) {
          return json({ error: 'Friend request not found.' }, 404);
        }

        const [a, b] = canonicalFriendPair(reqRow.from_user_id, reqRow.to_user_id);
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(reqRow.id),
          env.DB.prepare(
            'INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at) VALUES (?, ?, ?)',
          ).bind(a, b, now),
        ]);

        ctx.waitUntil(
          pushSocialEvent(env, [reqRow.from_user_id, reqRow.to_user_id], {
            type: 'social:refresh',
            notice: `${userRow.username} accepted your friend request.`,
          }),
        );
        return json({ ok: true }, 200);
      }

      const declineMatch = path.match(/^\/api\/friends\/requests\/([^/]+)\/decline$/);
      if (declineMatch && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const reqId = decodeURIComponent(declineMatch[1]);
        const reqRow = await env.DB.prepare(
          'SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ?',
        )
          .bind(reqId)
          .first<{ id: string; from_user_id: string; to_user_id: string }>();

        if (!reqRow || reqRow.to_user_id !== userRow.id) {
          return json({ error: 'Friend request not found.' }, 404);
        }

        await env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(reqRow.id).run();
        ctx.waitUntil(
          pushSocialEvent(env, [reqRow.from_user_id], { type: 'social:refresh' }),
        );
        return json({ ok: true }, 200);
      }

      const cancelMatch = path.match(/^\/api\/friends\/requests\/([^/]+)$/);
      if (cancelMatch && method === 'DELETE') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const reqId = decodeURIComponent(cancelMatch[1]);
        const reqRow = await env.DB.prepare(
          'SELECT id, from_user_id, to_user_id FROM friend_requests WHERE id = ?',
        )
          .bind(reqId)
          .first<{ id: string; from_user_id: string; to_user_id: string }>();

        if (!reqRow || reqRow.from_user_id !== userRow.id) {
          return json({ error: 'Outgoing request not found.' }, 404);
        }

        await env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(reqRow.id).run();
        ctx.waitUntil(pushSocialEvent(env, [reqRow.to_user_id], { type: 'social:refresh' }));
        return json({ ok: true }, 200);
      }

      const removeFriendMatch = path.match(/^\/api\/friends\/([^/]+)$/);
      if (removeFriendMatch && method === 'DELETE') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const friendUserId = decodeURIComponent(removeFriendMatch[1]);
        const [a, b] = canonicalFriendPair(userRow.id, friendUserId);
        await env.DB.prepare('DELETE FROM friendships WHERE user_a_id = ? AND user_b_id = ?')
          .bind(a, b)
          .run();

        ctx.waitUntil(pushSocialEvent(env, [friendUserId], { type: 'social:refresh' }));
        return json({ ok: true }, 200);
      }

      if (path === '/api/social/invite' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const body = await readJsonBody<{
          targetUserId?: string;
          lobbyCode?: string;
          mode?: string;
          mapName?: string;
          eventName?: string | null;
        }>(request);

        const targetUserId = String(body?.targetUserId ?? '').trim();
        const lobbyCode = String(body?.lobbyCode ?? '').trim().toUpperCase();
        if (!targetUserId || !lobbyCode) {
          return json({ error: 'Friend and lobby code are required.' }, 400);
        }

        const [a, b] = canonicalFriendPair(userRow.id, targetUserId);
        const isFriend = await env.DB.prepare(
          'SELECT 1 FROM friendships WHERE user_a_id = ? AND user_b_id = ?',
        )
          .bind(a, b)
          .first();
        if (!isFriend) {
          return json({ error: 'You can only send quick invites to friends on your list.' }, 403);
        }

        const inviteEvent = {
          type: 'lobby:invite',
          invite: {
            id: generateId(),
            fromUserId: userRow.id,
            fromUsername: userRow.username,
            fromRank: userRow.rank,
            lobbyCode,
            mode: String(body?.mode ?? 'BATTLE'),
            mapName: String(body?.mapName ?? 'Pripyat Block'),
            eventName: body?.eventName ? String(body.eventName) : null,
            createdAt: Date.now(),
          },
        };

        const delivered = await pushSocialEvent(env, [targetUserId], inviteEvent);
        return json({ ok: true, delivered: delivered > 0 }, 200);
      }

      if (path === '/api/players/recent' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const body = await readJsonBody<{ peerUserIds?: string[]; mode?: string }>(request);
        const mode = String(body?.mode ?? 'battle').slice(0, 32);
        const peers = Array.from(new Set(body?.peerUserIds ?? [])).filter(
          (id) => typeof id === 'string' && id.length > 0 && id !== userRow.id,
        );
        if (peers.length === 0) return json({ ok: true }, 200);

        const now = Date.now();
        const stmts = peers.map((peerId) =>
          env.DB.prepare(
            `INSERT INTO recent_players (user_id, peer_user_id, last_played_at, mode)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, peer_user_id)
             DO UPDATE SET last_played_at = excluded.last_played_at, mode = excluded.mode`,
          ).bind(userRow.id, peerId, now, mode),
        );
        // Keep latest 25 per user
        stmts.push(
          env.DB.prepare(
            `DELETE FROM recent_players
             WHERE user_id = ? AND peer_user_id NOT IN (
               SELECT peer_user_id FROM recent_players
               WHERE user_id = ?
               ORDER BY last_played_at DESC
               LIMIT 25
             )`,
          ).bind(userRow.id, userRow.id),
        );

        await env.DB.batch(stmts);
        return json({ ok: true }, 200);
      }

      // === PHASE 3: SPECIAL EVENTS & MULTIPLAYER LOBBIES ===

      if (path === '/api/events' && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to view your Special Events.' }, 401);

        const res = await env.DB.prepare(
          `SELECT e.*, u.username AS creator_username
           FROM special_events e
           JOIN users u ON u.id = e.creator_user_id
           WHERE e.creator_user_id = ?
           ORDER BY e.updated_at DESC`,
        )
          .bind(userRow.id)
          .all<DbSpecialEventRow>();

        return json({ events: (res.results ?? []).map(rowToSpecialEvent) }, 200);
      }

      if (path === '/api/events' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to create a Special Event.' }, 401);

        const body = await readJsonBody<{
          name?: string;
          description?: string;
          config?: unknown;
        }>(request);
        const name = String(body?.name ?? '').trim();
        const description = String(body?.description ?? '').trim().slice(0, 280);
        if (name.length < 2 || name.length > 48) {
          return json({ error: 'Event name must be between 2 and 48 characters.' }, 400);
        }

        const config = sanitizeSpecialEventConfig(body?.config);
        const now = Date.now();
        const id = generateId();
        let hashCode = generateEventHashCode();
        for (let attempt = 0; attempt < 5; attempt++) {
          const exists = await env.DB.prepare('SELECT 1 FROM special_events WHERE hash_code = ?')
            .bind(hashCode)
            .first();
          if (!exists) break;
          hashCode = generateEventHashCode();
        }

        await env.DB.prepare(
          `INSERT INTO special_events (id, hash_code, creator_user_id, name, description, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(id, hashCode, userRow.id, name, description, JSON.stringify(config), now, now)
          .run();

        const event: SpecialEventRecord = {
          id,
          hashCode,
          creatorUserId: userRow.id,
          creatorUsername: userRow.username,
          name,
          description,
          config,
          createdAt: now,
          updatedAt: now,
        };
        return json({ event }, 201);
      }

      const eventByHashMatch = path.match(/^\/api\/events\/by-hash\/([^/]+)$/);
      if (eventByHashMatch && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const hashCode = decodeURIComponent(eventByHashMatch[1]).trim().toUpperCase();
        const evRow = await env.DB.prepare(
          `SELECT e.*, u.username AS creator_username
           FROM special_events e
           JOIN users u ON u.id = e.creator_user_id
           WHERE e.hash_code = ?`,
        )
          .bind(hashCode)
          .first<DbSpecialEventRow>();

        if (!evRow) {
          return json({ error: 'No Special Event found for that hash code.' }, 404);
        }

        const activeLobby = await env.DB.prepare(
          `SELECT code FROM active_lobbies WHERE event_hash_code = ? ORDER BY updated_at DESC LIMIT 1`,
        )
          .bind(hashCode)
          .first<{ code: string }>();

        return json(
          {
            event: rowToSpecialEvent(evRow),
            activeLobbyCode: activeLobby?.code ?? null,
          },
          200,
        );
      }

      const eventIdMatch = path.match(/^\/api\/events\/([^/]+)$/);
      if (eventIdMatch && method === 'PUT') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to update your Special Event.' }, 401);

        const eventId = decodeURIComponent(eventIdMatch[1]);
        const existing = await env.DB.prepare(
          `SELECT e.*, u.username AS creator_username
           FROM special_events e
           JOIN users u ON u.id = e.creator_user_id
           WHERE e.id = ?`,
        )
          .bind(eventId)
          .first<DbSpecialEventRow>();

        if (!existing || existing.creator_user_id !== userRow.id) {
          return json({ error: 'Special Event not found or not owned by you.' }, 404);
        }

        const body = await readJsonBody<{
          name?: string;
          description?: string;
          config?: unknown;
        }>(request);
        const name = String(body?.name ?? existing.name).trim();
        const description = String(body?.description ?? existing.description).trim().slice(0, 280);
        if (name.length < 2 || name.length > 48) {
          return json({ error: 'Event name must be between 2 and 48 characters.' }, 400);
        }
        const config = sanitizeSpecialEventConfig(body?.config ?? JSON.parse(existing.config_json));
        const now = Date.now();

        await env.DB.prepare(
          `UPDATE special_events SET name = ?, description = ?, config_json = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(name, description, JSON.stringify(config), now, eventId)
          .run();

        return json(
          {
            event: {
              id: existing.id,
              hashCode: existing.hash_code,
              creatorUserId: existing.creator_user_id,
              creatorUsername: userRow.username,
              name,
              description,
              config,
              createdAt: existing.created_at,
              updatedAt: now,
            } satisfies SpecialEventRecord,
          },
          200,
        );
      }

      if (eventIdMatch && method === 'DELETE') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const eventId = decodeURIComponent(eventIdMatch[1]);
        const existing = await env.DB.prepare(
          'SELECT creator_user_id FROM special_events WHERE id = ?',
        )
          .bind(eventId)
          .first<{ creator_user_id: string }>();
        if (!existing || existing.creator_user_id !== userRow.id) {
          return json({ error: 'Special Event not found.' }, 404);
        }

        await env.DB.prepare('DELETE FROM special_events WHERE id = ?').bind(eventId).run();
        return json({ ok: true }, 200);
      }

      if (path === '/api/lobbies' && method === 'GET') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to browse lobbies.' }, 401);

        const cutoff = Date.now() - 6 * 60 * 60 * 1000;
        await env.DB.prepare('DELETE FROM active_lobbies WHERE updated_at < ?')
          .bind(cutoff)
          .run()
          .catch(() => {});

        const [publicRes, friendRes] = await Promise.all([
          env.DB.prepare(
            `SELECT a.*, u.username AS host_username
             FROM active_lobbies a
             JOIN users u ON u.id = a.host_user_id
             WHERE a.visibility = 'public'
             ORDER BY a.updated_at DESC
             LIMIT 40`,
          ).all<DbActiveLobbyRow>(),
          env.DB.prepare(
            `SELECT a.*, u.username AS host_username
             FROM active_lobbies a
             JOIN users u ON u.id = a.host_user_id
             JOIN friendships f
               ON (f.user_a_id = ? AND f.user_b_id = a.host_user_id)
               OR (f.user_b_id = ? AND f.user_a_id = a.host_user_id)
             WHERE a.visibility = 'friends_only'
             ORDER BY a.updated_at DESC
             LIMIT 40`,
          )
            .bind(userRow.id, userRow.id)
            .all<DbActiveLobbyRow>(),
        ]);

        return json(
          {
            publicLobbies: (publicRes.results ?? []).map(rowToBrowserEntry),
            friendLobbies: (friendRes.results ?? []).map(rowToBrowserEntry),
          },
          200,
        );
      }

      if (path === '/api/lobbies' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to host a lobby.' }, 401);

        const body = await readJsonBody<{
          visibility?: LobbyVisibility;
          mode?: LobbyModeId;
          battleRule?: 'tdm' | 'ffa';
          mapId?: string;
          maxPlayers?: number;
          botsEnabled?: boolean;
          botCount?: number;
          killLimit?: number;
          botDifficulty?: 'recruit' | 'tactical' | 'veteran';
          killfeedPolicy?: 'player_choice' | 'force_on' | 'force_off';
          weatherPreset?: WeatherPresetId;
          timeOfDayStart?: TimeOfDayStartSetting;
          hitmarkersEnabled?: boolean;
          hudEnabled?: boolean;
          specialEventId?: string | null;
        }>(request);

        let specialEvent: SpecialEventRecord | null = null;
        if (body?.specialEventId) {
          const evRow = await env.DB.prepare(
            `SELECT e.*, u.username AS creator_username
             FROM special_events e
             JOIN users u ON u.id = e.creator_user_id
             WHERE e.id = ?`,
          )
            .bind(String(body.specialEventId))
            .first<DbSpecialEventRow>();

          if (!evRow) {
            return json({ error: 'Special Event not found.' }, 404);
          }
          specialEvent = rowToSpecialEvent(evRow);
        }

        const visibility: LobbyVisibility =
          body?.visibility === 'private' || body?.visibility === 'friends_only'
            ? body.visibility
            : 'public';
        const mode: LobbyModeId = specialEvent
          ? specialEvent.config.mode
          : body?.mode === 'infection'
            ? 'infection'
            : 'battle';
        const battleRule = specialEvent
          ? specialEvent.config.battleRule
          : body?.battleRule === 'ffa'
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
          : typeof body?.mapId === 'string' && validMaps.has(body.mapId)
            ? body.mapId
            : defaultMap;
        const maxPlayers = Math.max(
          2,
          Math.min(8, Math.round(Number(specialEvent ? specialEvent.config.maxPlayers : (body?.maxPlayers ?? 8)) || 8)),
        );
        const botsEnabled = specialEvent
          ? specialEvent.config.botsEnabled
          : typeof body?.botsEnabled === 'boolean'
            ? body.botsEnabled
            : true;
        const botCount = botsEnabled
          ? Math.max(
              0,
              Math.min(10, Math.round(Number(specialEvent ? specialEvent.config.botCount : (body?.botCount ?? 6)) || 0)),
            )
          : 0;
        const killLimit = Math.max(
          10,
          Math.min(100, Math.round(Number(specialEvent ? specialEvent.config.killLimit : (body?.killLimit ?? 30)) || 30)),
        );
        const botDifficulty = specialEvent
          ? specialEvent.config.botDifficulty
          : body?.botDifficulty === 'recruit' || body?.botDifficulty === 'veteran'
            ? body.botDifficulty
            : 'tactical';
        const killfeedPolicy = specialEvent
          ? (specialEvent.config.killfeedPolicy ?? 'player_choice')
          : body?.killfeedPolicy === 'force_on' || body?.killfeedPolicy === 'force_off'
            ? body.killfeedPolicy
            : 'player_choice';
        const weatherPreset = sanitizeWeatherPreset(
          specialEvent ? specialEvent.config.weatherPreset : body?.weatherPreset,
        );
        const timeOfDayStart = sanitizeTimeOfDayStart(
          specialEvent ? specialEvent.config.timeOfDayStart : body?.timeOfDayStart,
        );
        const hitmarkersEnabled = specialEvent
          ? specialEvent.config.hitmarkersEnabled !== false
          : typeof body?.hitmarkersEnabled === 'boolean'
            ? body.hitmarkersEnabled
            : true;
        const hudEnabled = specialEvent
          ? specialEvent.config.hudEnabled !== false
          : typeof body?.hudEnabled === 'boolean'
            ? body.hudEnabled
            : true;

        let code = generateLobbyCode();
        for (let attempt = 0; attempt < 5; attempt++) {
          const exists = await env.DB.prepare('SELECT 1 FROM active_lobbies WHERE code = ?')
            .bind(code)
            .first();
          if (!exists) break;
          code = generateLobbyCode();
        }

        const stub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(code));
        const initRes = await stub.fetch('https://lobby-room/internal/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            host: {
              userId: userRow.id,
              username: userRow.username,
              rank: userRow.rank,
              prestige: userRow.prestige,
            },
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
            weatherPreset,
            timeOfDayStart,
            hitmarkersEnabled,
            hudEnabled,
            specialEvent,
          }),
        });
        const initData = (await initRes.json()) as { ok?: boolean; state?: LobbyRoomState };
        return json({ code, lobby: initData.state ?? null }, 201);
      }

      if (path === '/api/lobbies/resolve-join' && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in to join a lobby.' }, 401);

        const body = await readJsonBody<{ codeOrHash?: string }>(request);
        const normalized = String(body?.codeOrHash ?? '').trim().toUpperCase();
        if (!normalized || normalized.length < 4) {
          return json({ error: 'Enter a valid Lobby Code or Event Hash Code.' }, 400);
        }

        // 1) Check if an active lobby is currently running this Special Event hash code (direct join without permission!)
        const eventLobby = await env.DB.prepare(
          `SELECT code FROM active_lobbies WHERE event_hash_code = ? ORDER BY updated_at DESC LIMIT 1`,
        )
          .bind(normalized)
          .first<{ code: string }>();

        if (eventLobby) {
          const stub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(eventLobby.code));
          const checkRes = await stub.fetch('https://lobby-room/internal/check-access', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userRow.id, eventHash: normalized }),
          });
          const checkData = (await checkRes.json()) as { allowed?: boolean; error?: string };
          if (!checkRes.ok || !checkData.allowed) {
            return json({ error: checkData.error ?? 'Unable to join event lobby.' }, checkRes.status || 403);
          }
          return json(
            { lobbyCode: eventLobby.code, eventHash: normalized, joinType: 'event_hash' },
            200,
          );
        }

        // 2) Check if this matches a saved Special Event that isn't currently active
        const savedEvent = await env.DB.prepare(
          `SELECT e.*, u.username AS creator_username
           FROM special_events e
           JOIN users u ON u.id = e.creator_user_id
           WHERE e.hash_code = ?`,
        )
          .bind(normalized)
          .first<DbSpecialEventRow>();

        if (savedEvent) {
          return json(
            {
              error: `No active lobby is currently hosting "${savedEvent.name}". Ask ${savedEvent.creator_username} to launch the event or host it yourself.`,
              savedEvent: rowToSpecialEvent(savedEvent),
            },
            404,
          );
        }

        // 3) Otherwise treat as a standard lobby code
        const stub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(normalized));
        const checkRes = await stub.fetch('https://lobby-room/internal/check-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userRow.id }),
        });
        const checkData = (await checkRes.json()) as { allowed?: boolean; error?: string };
        if (!checkRes.ok || !checkData.allowed) {
          return json({ error: checkData.error ?? 'Lobby not found or access denied.' }, checkRes.status || 403);
        }

        return json({ lobbyCode: normalized, eventHash: null, joinType: 'code' }, 200);
      }

      const lobbyInviteMatch = path.match(/^\/api\/lobbies\/([^/]+)\/invite$/);
      if (lobbyInviteMatch && method === 'POST') {
        const userRow = await authenticateRequest(request, env.DB);
        if (!userRow) return json({ error: 'Sign in required.' }, 401);

        const code = decodeURIComponent(lobbyInviteMatch[1]).trim().toUpperCase();
        const body = await readJsonBody<{ targetUserId?: string }>(request);
        const targetUserId = String(body?.targetUserId ?? '').trim();
        if (!targetUserId) return json({ error: 'Select a player to invite.' }, 400);

        const stub = env.LOBBY_ROOM.get(env.LOBBY_ROOM.idFromName(code));
        const inviteRes = await stub.fetch('https://lobby-room/internal/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostUserId: userRow.id, targetUserId }),
        });
        const inviteData = (await inviteRes.json()) as {
          ok?: boolean;
          error?: string;
          state?: LobbyRoomState;
        };
        if (!inviteRes.ok || !inviteData.ok || !inviteData.state) {
          return json({ error: inviteData.error ?? 'Could not send invite.' }, inviteRes.status || 403);
        }

        const st = inviteData.state;
        const delivered = await pushSocialEvent(env, [targetUserId], {
          type: 'lobby:invite',
          invite: {
            id: generateId(),
            fromUserId: userRow.id,
            fromUsername: userRow.username,
            fromRank: userRow.rank,
            lobbyCode: st.code,
            mode: formatLobbyModeLabel(st.mode, st.battleRule),
            mapName: formatMapDisplayName(st.mapId),
            eventName: st.specialEvent?.name ?? null,
            createdAt: Date.now(),
          },
        });

        return json({ ok: true, delivered: delivered > 0 }, 200);
      }

      return json({ error: 'API endpoint not found.' }, 404);
    }

    // Serve Vite static assets via Cloudflare Workers Assets binding
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('AXON ENGINE Cloudflare Worker ready.', { status: 200 });
  },
};

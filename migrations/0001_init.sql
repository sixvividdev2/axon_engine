-- CORDON-04 Cloudflare D1 Initial Schema (SQLite)
-- Covers Accounts, Sessions, Progression, Weapon/Attachment Unlocks, Social Hub,
-- Special Events, and Active Lobbies.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_lower TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  prestige INTEGER NOT NULL DEFAULT 0,
  prestige_xp INTEGER NOT NULL DEFAULT 0,
  cash INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  highest_infection_round INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS friendships (
  user_a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a_id, user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b_id);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE (from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);

CREATE TABLE IF NOT EXISTS recent_players (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_played_at INTEGER NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, peer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_recent_players_order ON recent_players(user_id, last_played_at DESC);

CREATE TABLE IF NOT EXISTS weapon_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weapon_id TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  kills INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, weapon_id)
);

CREATE TABLE IF NOT EXISTS unlocked_attachments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS special_events (
  id TEXT PRIMARY KEY,
  hash_code TEXT NOT NULL UNIQUE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_special_events_creator ON special_events(creator_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS active_lobbies (
  code TEXT PRIMARY KEY,
  host_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'public',
  mode TEXT NOT NULL DEFAULT 'battle',
  map_id TEXT NOT NULL DEFAULT 'pripyat_block',
  event_id TEXT REFERENCES special_events(id) ON DELETE SET NULL,
  event_hash_code TEXT,
  event_name TEXT,
  creator_username TEXT,
  player_count INTEGER NOT NULL DEFAULT 1,
  max_players INTEGER NOT NULL DEFAULT 8,
  bots_enabled INTEGER NOT NULL DEFAULT 1,
  bot_count INTEGER NOT NULL DEFAULT 6,
  status TEXT NOT NULL DEFAULT 'lobby',
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_lobbies_vis ON active_lobbies(visibility, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_active_lobbies_event_hash ON active_lobbies(event_hash_code);

CREATE TABLE IF NOT EXISTS recent_matches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recent_matches_user ON recent_matches(user_id, completed_at DESC);


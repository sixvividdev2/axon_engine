import {
  LobbyBrowserEntry,
  LobbyModeId,
  LobbyRoomState,
  LobbyVisibility,
  SpecialEventConfig,
  SpecialEventRecord,
} from '../data/multiplayer';
import { BattleRuleId, BotDifficultyId } from '../maps/types';

async function lobbyJsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`) as Error & {
      status?: number;
      payload?: unknown;
    };
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function fetchMySpecialEvents(): Promise<{ events: SpecialEventRecord[] }> {
  return lobbyJsonFetch('/api/events', { method: 'GET' });
}

export async function createSpecialEvent(payload: {
  name: string;
  description: string;
  config: SpecialEventConfig;
}): Promise<{ event: SpecialEventRecord }> {
  return lobbyJsonFetch('/api/events', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateSpecialEvent(
  eventId: string,
  payload: {
    name: string;
    description: string;
    config: SpecialEventConfig;
  },
): Promise<{ event: SpecialEventRecord }> {
  return lobbyJsonFetch(`/api/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteSpecialEvent(eventId: string): Promise<{ ok: boolean }> {
  return lobbyJsonFetch(`/api/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}

export async function fetchLobbyBrowser(): Promise<{
  publicLobbies: LobbyBrowserEntry[];
  friendLobbies: LobbyBrowserEntry[];
}> {
  return lobbyJsonFetch('/api/lobbies', { method: 'GET' });
}

export interface CreateLobbyPayload {
  visibility: LobbyVisibility;
  mode?: LobbyModeId;
  battleRule?: BattleRuleId;
  mapId?: string;
  maxPlayers?: number;
  botsEnabled?: boolean;
  botCount?: number;
  killLimit?: number;
  botDifficulty?: BotDifficultyId;
  specialEventId?: string | null;
}

export async function createLobby(
  payload: CreateLobbyPayload,
): Promise<{ code: string; lobby: LobbyRoomState | null }> {
  return lobbyJsonFetch('/api/lobbies', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function resolveLobbyOrEventJoin(codeOrHash: string): Promise<{
  lobbyCode: string;
  eventHash: string | null;
  joinType: 'event_hash' | 'code';
}> {
  return lobbyJsonFetch('/api/lobbies/resolve-join', {
    method: 'POST',
    body: JSON.stringify({ codeOrHash }),
  });
}

export async function invitePlayerToLobby(
  lobbyCode: string,
  targetUserId: string,
): Promise<{ ok: boolean; delivered: boolean }> {
  return lobbyJsonFetch(`/api/lobbies/${encodeURIComponent(lobbyCode)}/invite`, {
    method: 'POST',
    body: JSON.stringify({ targetUserId }),
  });
}

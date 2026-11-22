import { ApiError } from './authApi';

export type FriendPresenceStatus = 'offline' | 'online' | 'in_lobby' | 'in_match';
export type PlayerRelationship = 'none' | 'friend' | 'incoming' | 'outgoing';

export interface FriendEntry {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  friendsSince: number;
  status: FriendPresenceStatus;
  lobbyCode: string | null;
  lobbyVisibility: 'public' | 'friends_only' | 'private' | null;
  lobbyMode: string | null;
  eventName: string | null;
  joinable: boolean;
}

export interface FriendRequestEntry {
  id: string;
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  createdAt: number;
}

export interface RecentPlayerEntry {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  mode: string;
  lastPlayedAt: number;
  relationship: PlayerRelationship;
}

export interface PlayerSearchEntry {
  userId: string;
  username: string;
  rank: number;
  prestige: number;
  relationship: PlayerRelationship;
  requestId: string | null;
}

export interface SocialOverviewResponse {
  friends: FriendEntry[];
  incomingRequests: FriendRequestEntry[];
  outgoingRequests: FriendRequestEntry[];
  recentPlayers: RecentPlayerEntry[];
}

export interface LobbyInvitePayload {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromRank: number;
  lobbyCode: string;
  mode: string;
  mapName: string;
  eventName: string | null;
  createdAt: number;
}

async function socialRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.headers ?? {}),
    },
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }

  if (!res.ok) {
    const msg =
      typeof data.error === 'string' && data.error.trim().length > 0
        ? data.error
        : `Request failed (${res.status}).`;
    throw new ApiError(msg, res.status);
  }

  return data as T;
}

export async function fetchSocialOverview(): Promise<SocialOverviewResponse> {
  return socialRequest<SocialOverviewResponse>('/api/social/overview', { method: 'GET' });
}

export async function searchPlayersByUsername(query: string): Promise<PlayerSearchEntry[]> {
  const q = encodeURIComponent(query.trim());
  const data = await socialRequest<{ players: PlayerSearchEntry[] }>(`/api/players/search?q=${q}`, {
    method: 'GET',
  });
  return data.players ?? [];
}

export async function sendFriendRequest(
  targetUserId: string,
): Promise<{ status: 'pending' | 'accepted' }> {
  return socialRequest<{ status: 'pending' | 'accepted' }>('/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ targetUserId }),
  });
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  await socialRequest<{ ok: boolean }>(
    `/api/friends/requests/${encodeURIComponent(requestId)}/accept`,
    { method: 'POST' },
  );
}

export async function declineFriendRequest(requestId: string): Promise<void> {
  await socialRequest<{ ok: boolean }>(
    `/api/friends/requests/${encodeURIComponent(requestId)}/decline`,
    { method: 'POST' },
  );
}

export async function cancelOutgoingFriendRequest(requestId: string): Promise<void> {
  await socialRequest<{ ok: boolean }>(`/api/friends/requests/${encodeURIComponent(requestId)}`, {
    method: 'DELETE',
  });
}

export async function removeFriend(friendUserId: string): Promise<void> {
  await socialRequest<{ ok: boolean }>(`/api/friends/${encodeURIComponent(friendUserId)}`, {
    method: 'DELETE',
  });
}

export async function sendLobbyInvite(params: {
  targetUserId: string;
  lobbyCode: string;
  mode: string;
  mapName: string;
  eventName?: string | null;
}): Promise<{ ok: boolean; delivered: boolean }> {
  return socialRequest<{ ok: boolean; delivered: boolean }>('/api/social/invite', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function recordRecentPlayers(peerUserIds: string[], mode: string): Promise<void> {
  await socialRequest<{ ok: boolean }>('/api/players/recent', {
    method: 'POST',
    body: JSON.stringify({ peerUserIds, mode }),
  });
}

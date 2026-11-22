import {
  MatchProgressionSummary,
  MatchResultInput,
  WeaponProgressRecord,
} from '../data/progression';

export interface AccountProfile {
  id: string;
  email: string;
  username: string;
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
  weaponProgress: Record<string, WeaponProgressRecord>;
  unlockedAttachments: string[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
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

export async function fetchCurrentAccount(): Promise<AccountProfile | null> {
  const data = await apiRequest<{ user: AccountProfile | null }>('/api/auth/me', {
    method: 'GET',
  });
  return data.user ?? null;
}

export async function registerAccount(params: {
  email: string;
  username: string;
  password: string;
}): Promise<AccountProfile> {
  const data = await apiRequest<{ user: AccountProfile }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.user;
}

export async function loginAccount(params: {
  identifier: string;
  password: string;
}): Promise<AccountProfile> {
  const data = await apiRequest<{ user: AccountProfile }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.user;
}

export async function logoutAccount(): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export async function updateAccountUsername(username: string): Promise<AccountProfile> {
  const data = await apiRequest<{ user: AccountProfile }>('/api/account/username', {
    method: 'PATCH',
    body: JSON.stringify({ username }),
  });
  return data.user;
}

export async function resetAccountProgress(): Promise<AccountProfile> {
  const data = await apiRequest<{ user: AccountProfile; reset: boolean }>('/api/account/reset', {
    method: 'POST',
    body: JSON.stringify({ confirm: 'RESET_ALL_PROGRESS' }),
  });
  return data.user;
}

export async function commitMatchProgression(
  input: MatchResultInput,
): Promise<{ user: AccountProfile; summary: MatchProgressionSummary }> {
  return apiRequest<{ user: AccountProfile; summary: MatchProgressionSummary }>(
    '/api/progression/commit',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

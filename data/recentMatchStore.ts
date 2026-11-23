import { useEffect, useState } from 'react';
import {
  appendRecentMatch,
  MAX_RECENT_MATCHES,
  RecentMatchRecord,
  sanitizeRecentMatchRecord,
} from './progression';

const GUEST_RECENT_MATCHES_KEY = 'axon_guest_recent_matches_v1';

type RecentMatchesListener = (matches: RecentMatchRecord[]) => void;

class GuestRecentMatchStore {
  private matches: RecentMatchRecord[];
  private readonly listeners = new Set<RecentMatchesListener>();

  constructor() {
    this.matches = this.load();
  }

  private load(): RecentMatchRecord[] {
    if (typeof window === 'undefined' || !window.localStorage) {
      return [];
    }
    try {
      const raw = window.localStorage.getItem(GUEST_RECENT_MATCHES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const sanitized = parsed
        .map((item) => sanitizeRecentMatchRecord(item))
        .filter((item): item is RecentMatchRecord => item !== null)
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, MAX_RECENT_MATCHES);
      return sanitized;
    } catch {
      return [];
    }
  }

  private saveAndEmit(): void {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(GUEST_RECENT_MATCHES_KEY, JSON.stringify(this.matches));
      } catch {
        // Ignore storage quota errors
      }
    }
    const snapshot = this.getMatches();
    for (const fn of this.listeners) {
      fn(snapshot);
    }
  }

  public getMatches(): RecentMatchRecord[] {
    return this.matches.map((m) => ({
      ...m,
      weaponStats: m.weaponStats.map((w) => ({ ...w })),
    }));
  }

  public recordMatch(record: RecentMatchRecord): void {
    const clean = sanitizeRecentMatchRecord({ ...record, isGuest: true });
    if (!clean) return;
    this.matches = appendRecentMatch(this.matches, clean, MAX_RECENT_MATCHES);
    this.saveAndEmit();
  }

  public clear(): void {
    this.matches = [];
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(GUEST_RECENT_MATCHES_KEY);
      } catch {
        // Ignore storage errors
      }
    }
    for (const fn of this.listeners) {
      fn([]);
    }
  }

  public subscribe(fn: RecentMatchesListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const guestRecentMatchStore = new GuestRecentMatchStore();

export function useGuestRecentMatches(): RecentMatchRecord[] {
  const [matches, setMatches] = useState<RecentMatchRecord[]>(() =>
    guestRecentMatchStore.getMatches(),
  );

  useEffect(() => {
    return guestRecentMatchStore.subscribe((next) => setMatches(next));
  }, []);

  return matches;
}

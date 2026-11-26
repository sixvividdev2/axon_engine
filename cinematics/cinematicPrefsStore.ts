import { useEffect, useState } from 'react';

const PROLOGUE_SEEN_KEY = 'axon_prologue_cinematic_seen_v1';

type ReplayListener = () => void;
type PrefListener = (seen: boolean) => void;

class CinematicPrefsStore {
  private prologueSeen = false;
  private readonly replayListeners = new Set<ReplayListener>();
  private readonly prefListeners = new Set<PrefListener>();

  constructor() {
    this.prologueSeen = this.readPrologueSeen();
  }

  private readPrologueSeen(): boolean {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return false;
      return window.localStorage.getItem(PROLOGUE_SEEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  public isPrologueSeen(): boolean {
    return this.prologueSeen;
  }

  public shouldPlayPrologueOnLaunch(): boolean {
    return !this.prologueSeen;
  }

  public markPrologueSeen(): void {
    if (this.prologueSeen) return;
    this.prologueSeen = true;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(PROLOGUE_SEEN_KEY, '1');
      }
    } catch {
      // Ignore storage quota / sandbox restrictions
    }
    for (const fn of this.prefListeners) fn(this.prologueSeen);
  }

  public resetPrologueSeen(): void {
    this.prologueSeen = false;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(PROLOGUE_SEEN_KEY);
      }
    } catch {
      // Ignore storage errors
    }
    for (const fn of this.prefListeners) fn(this.prologueSeen);
  }

  /**
   * Triggers immediate replay of the Prologue Cinematic from anywhere (e.g., Game Settings).
   */
  public requestReplayPrologue(): void {
    for (const fn of this.replayListeners) fn();
  }

  public subscribeReplay(listener: ReplayListener): () => void {
    this.replayListeners.add(listener);
    return () => {
      this.replayListeners.delete(listener);
    };
  }

  public subscribeSeen(listener: PrefListener): () => void {
    this.prefListeners.add(listener);
    return () => {
      this.prefListeners.delete(listener);
    };
  }
}

export const cinematicPrefsStore = new CinematicPrefsStore();

export function usePrologueSeen(): boolean {
  const [seen, setSeen] = useState<boolean>(() => cinematicPrefsStore.isPrologueSeen());
  useEffect(() => {
    setSeen(cinematicPrefsStore.isPrologueSeen());
    return cinematicPrefsStore.subscribeSeen(setSeen);
  }, []);
  return seen;
}

import React, { useEffect, useRef, useState } from 'react';
import { BattleKillfeedEntry } from '../combat/BattleBotAI';

interface KillfeedOverlayProps {
  entries: readonly BattleKillfeedEntry[];
  enabled: boolean;
  localPlayerName?: string;
}

interface AnimatedFeedItem {
  entry: BattleKillfeedEntry;
  exiting: boolean;
}

const VISIBLE_LIFETIME_MS = 5200;
const EXIT_DURATION_MS = 280;
const MAX_ROWS = 5;

const HeadshotCrosshairIcon: React.FC = () => (
  <svg
    viewBox="0 0 16 16"
    className="h-3.5 w-3.5 shrink-0 text-amber-400"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-label="Headshot"
  >
    <circle cx="8" cy="8" r="4.5" />
    <line x1="8" y1="1.2" x2="8" y2="4.2" />
    <line x1="8" y1="11.8" x2="8" y2="14.8" />
    <line x1="1.2" y1="8" x2="4.2" y2="8" />
    <line x1="11.8" y1="8" x2="14.8" y2="8" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

const EliminationIcon: React.FC<{ isDeath?: boolean }> = ({ isDeath }) => (
  <svg
    viewBox="0 0 16 16"
    className={`h-3 w-3 shrink-0 ${isDeath ? 'text-red-400' : 'text-neutral-400'}`}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    {isDeath ? (
      <>
        <circle cx="8" cy="6.8" r="4.2" />
        <path d="M6 11v2.2h4V11" />
        <circle cx="6.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
        <circle cx="9.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
      </>
    ) : (
      <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    )}
  </svg>
);

function teamNameColor(team: BattleKillfeedEntry['killerTeam'], isLocal: boolean): string {
  if (isLocal) return 'text-amber-300 font-semibold';
  if (team === 'A') return 'text-sky-300 font-semibold';
  if (team === 'B') return 'text-orange-400 font-semibold';
  return 'text-neutral-100 font-semibold';
}

function victimNameColor(team: BattleKillfeedEntry['victimTeam'], isLocal: boolean): string {
  if (isLocal) return 'text-red-300 font-semibold';
  if (team === 'A') return 'text-sky-200/85';
  if (team === 'B') return 'text-orange-300/85';
  return 'text-neutral-300';
}

/**
 * Sleek CSS-animated Killfeed displaying kills, headshots, and deaths
 * with smooth GPU-composited slide-in and fade-out lifecycle transitions.
 */
export const KillfeedOverlay: React.FC<KillfeedOverlayProps> = ({
  entries,
  enabled,
  localPlayerName = 'YOU',
}) => {
  const [items, setItems] = useState<AnimatedFeedItem[]>([]);
  const timersRef = useRef<Map<number, { exitId: number; removeId: number }>>(new Map());
  const seenIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!enabled) {
      for (const pair of timersRef.current.values()) {
        window.clearTimeout(pair.exitId);
        window.clearTimeout(pair.removeId);
      }
      timersRef.current.clear();
      setItems([]);
      return;
    }

    const incomingNew: BattleKillfeedEntry[] = [];
    for (const entry of entries) {
      if (!seenIdsRef.current.has(entry.id)) {
        seenIdsRef.current.add(entry.id);
        incomingNew.push(entry);
      }
    }

    if (incomingNew.length === 0) return;

    setItems((prev) => {
      const next = [
        ...incomingNew.map((entry) => ({ entry, exiting: false })),
        ...prev,
      ];
      if (next.length > MAX_ROWS) {
        const overflow = next.slice(MAX_ROWS);
        for (const old of overflow) {
          const t = timersRef.current.get(old.entry.id);
          if (t) {
            window.clearTimeout(t.exitId);
            window.clearTimeout(t.removeId);
            timersRef.current.delete(old.entry.id);
          }
        }
        return next.slice(0, MAX_ROWS);
      }
      return next;
    });

    for (const entry of incomingNew) {
      const exitId = window.setTimeout(() => {
        setItems((prev) =>
          prev.map((it) => (it.entry.id === entry.id ? { ...it, exiting: true } : it)),
        );
      }, VISIBLE_LIFETIME_MS);

      const removeId = window.setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.entry.id !== entry.id));
        timersRef.current.delete(entry.id);
      }, VISIBLE_LIFETIME_MS + EXIT_DURATION_MS);

      timersRef.current.set(entry.id, { exitId, removeId });
    }
  }, [entries, enabled]);

  useEffect(() => {
    return () => {
      for (const pair of timersRef.current.values()) {
        window.clearTimeout(pair.exitId);
        window.clearTimeout(pair.removeId);
      }
      timersRef.current.clear();
    };
  }, []);

  if (!enabled || items.length === 0) return null;

  const localLower = localPlayerName.toLowerCase();

  return (
    <div
      className="pointer-events-none fixed top-4 left-5 z-20 flex flex-col gap-1.5 font-mono-tabular text-[11px]"
      aria-live="polite"
      aria-label="Combat killfeed"
    >
      {items.map(({ entry, exiting }) => {
        const killerIsLocal =
          entry.killerName === 'YOU' || entry.killerName.toLowerCase() === localLower;
        const victimIsLocal =
          entry.victimName === 'YOU' || entry.victimName.toLowerCase() === localLower;
        const isSelfDeath =
          entry.killerName.toLowerCase() === entry.victimName.toLowerCase() ||
          entry.weaponLabel === 'DOWNED' ||
          entry.weaponLabel === 'KIA';
        const involvesLocal = killerIsLocal || victimIsLocal;

        return (
          <div
            key={entry.id}
            className={`flex items-center gap-2 border px-2.5 py-1 tracking-wide shadow-sm ${
              exiting ? 'killfeed-entry-exit' : 'killfeed-entry-enter'
            } ${
              victimIsLocal
                ? 'border-red-500/55 bg-neutral-950/90 text-neutral-100'
                : involvesLocal
                  ? 'border-amber-400/55 bg-neutral-950/90 text-neutral-100'
                  : 'border-white/10 bg-neutral-950/84 text-neutral-200'
            }`}
          >
            {!isSelfDeath && (
              <span className={teamNameColor(entry.killerTeam, killerIsLocal)}>
                {entry.killerName}
              </span>
            )}

            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-400">
              <EliminationIcon isDeath={isSelfDeath || victimIsLocal} />
              <span className={entry.headshot ? 'text-amber-300' : 'text-neutral-300/90'}>
                {entry.weaponLabel}
              </span>
              {entry.headshot && <HeadshotCrosshairIcon />}
            </span>

            <span className={victimNameColor(entry.victimTeam, victimIsLocal)}>
              {entry.victimName}
            </span>
          </div>
        );
      })}
    </div>
  );
};

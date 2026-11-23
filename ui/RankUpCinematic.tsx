import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Award,
  ChevronRight,
  Clock,
  Crosshair,
  EyeOff,
  Flame,
  Shield,
  Sparkles,
  Swords,
  Target,
  Trophy,
  Users,
} from 'lucide-react';
import { resolveWeaponProfile } from '../bodycam-sdk';
import { ATTACHMENTS } from '../data/attachments';
import {
  getRankTitleInfo,
  MatchLeaderboardEntry,
  MatchProgressionSummary,
  MAX_RANK,
  POST_MATCH_BADGES,
  PostMatchBadgeId,
} from '../data/progression';

interface RankUpCinematicProps {
  summary: MatchProgressionSummary;
  onContinue: () => void;
  onSignIn?: () => void;
}

type CinematicPhase = 1 | 2 | 3 | 4;

interface SparkParticle {
  id: number;
  leftPct: number;
  delayMs: number;
  durationMs: number;
  sizePx: number;
  driftX: number;
}

function formatDurationClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatUnitLabel(team: 'A' | 'B' | 'FFA', mode: 'battle' | 'infection'): string {
  if (mode === 'infection') return 'Squad';
  if (team === 'A') return 'Team A';
  if (team === 'B') return 'Team B';
  return 'FFA';
}

function formatOutcomeLabel(outcome: 'victory' | 'defeat' | 'completed'): string {
  if (outcome === 'victory') return 'Victory';
  if (outcome === 'defeat') return 'Defeat';
  return 'Completed';
}

interface BadgeStyleSpec {
  icon: React.FC<{ className?: string }>;
  className: string;
}

const BADGE_STYLE_MAP: Readonly<Record<PostMatchBadgeId, BadgeStyleSpec>> = {
  most_kills: {
    icon: Crosshair,
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
  },
  most_headshots: {
    icon: Target,
    className: 'border-sky-500/35 bg-sky-500/10 text-sky-300',
  },
  most_assists: {
    icon: Users,
    className: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300',
  },
  grenadier: {
    icon: Flame,
    className: 'border-orange-500/35 bg-orange-500/10 text-orange-300',
  },
  assassin: {
    icon: Swords,
    className: 'border-rose-500/35 bg-rose-500/10 text-rose-300',
  },
  coward: {
    icon: EyeOff,
    className: 'border-neutral-600/60 bg-neutral-800/80 text-neutral-300',
  },
  afk_artist: {
    icon: Clock,
    className: 'border-purple-500/35 bg-purple-500/10 text-purple-300',
  },
};

function getBadgeTooltip(
  badgeId: PostMatchBadgeId,
  stats: {
    kills: number;
    headshots: number;
    assists: number;
    grenadeKills: number;
    meleeKills: number;
    damageDealt: number;
    afkRatio?: number;
  },
): string {
  const meta = POST_MATCH_BADGES[badgeId];
  switch (badgeId) {
    case 'most_kills':
      return `${meta.description} (${stats.kills} kills)`;
    case 'most_headshots':
      return `${meta.description} (${stats.headshots} headshots)`;
    case 'most_assists':
      return `${meta.description} (${stats.assists} assists)`;
    case 'grenadier':
      return `${meta.description} (${stats.grenadeKills} grenade kills)`;
    case 'assassin':
      return `${meta.description} (${stats.meleeKills} melee kills)`;
    case 'coward':
      return `${meta.description} (${stats.kills} kills · ${stats.assists} assists · ${stats.damageDealt} dmg)`;
    case 'afk_artist': {
      const pct = Math.round((stats.afkRatio ?? 0.5) * 100);
      return `${meta.description} (${pct}% inactive)`;
    }
  }
}

const PostMatchBadgeTag: React.FC<{
  badgeId: PostMatchBadgeId;
  tooltip: string;
}> = ({ badgeId, tooltip }) => {
  const meta = POST_MATCH_BADGES[badgeId];
  const spec = BADGE_STYLE_MAP[badgeId];
  const Icon = spec.icon;
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono-tabular text-[10px] font-medium uppercase tracking-wider ${spec.className}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{meta.label}</span>
    </span>
  );
};

function playCinematicAudio(promoted: boolean): () => void {
  try {
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return () => {};
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const riseOsc = ctx.createOscillator();
    const riseGain = ctx.createGain();
    riseOsc.type = 'triangle';
    riseOsc.frequency.setValueAtTime(160, now);
    riseOsc.frequency.exponentialRampToValueAtTime(promoted ? 640 : 420, now + 1.48);
    riseGain.gain.setValueAtTime(0.001, now);
    riseGain.gain.linearRampToValueAtTime(0.08, now + 0.2);
    riseGain.gain.linearRampToValueAtTime(0.11, now + 1.42);
    riseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55);
    riseOsc.connect(riseGain).connect(ctx.destination);
    riseOsc.start(now);
    riseOsc.stop(now + 1.58);

    if (promoted) {
      const humOsc = ctx.createOscillator();
      const humGain = ctx.createGain();
      humOsc.type = 'sine';
      humOsc.frequency.setValueAtTime(92, now + 1.5);
      humOsc.frequency.linearRampToValueAtTime(125, now + 2.02);
      humGain.gain.setValueAtTime(0.001, now + 1.5);
      humGain.gain.linearRampToValueAtTime(0.09, now + 1.9);
      humGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.05);
      humOsc.connect(humGain).connect(ctx.destination);
      humOsc.start(now + 1.5);
      humOsc.stop(now + 2.08);

      const bassOsc = ctx.createOscillator();
      const bassGain = ctx.createGain();
      bassOsc.type = 'sine';
      bassOsc.frequency.setValueAtTime(140, now + 2.2);
      bassOsc.frequency.exponentialRampToValueAtTime(36, now + 2.75);
      bassGain.gain.setValueAtTime(0.24, now + 2.2);
      bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.95);
      bassOsc.connect(bassGain).connect(ctx.destination);
      bassOsc.start(now + 2.2);
      bassOsc.stop(now + 3.0);

      const chordFreqs = [523.25, 659.25, 783.99, 1046.5];
      chordFreqs.forEach((freq, idx) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = idx % 2 === 0 ? 'triangle' : 'sine';
        o.frequency.setValueAtTime(freq, now + 2.22 + idx * 0.025);
        g.gain.setValueAtTime(0.001, now + 2.22 + idx * 0.025);
        g.gain.linearRampToValueAtTime(0.055, now + 2.26 + idx * 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 3.7);
        o.connect(g).connect(ctx.destination);
        o.start(now + 2.22 + idx * 0.025);
        o.stop(now + 3.75);
      });
    }

    return () => {
      void ctx.close().catch(() => {});
    };
  } catch {
    return () => {};
  }
}

export const RankUpCinematic: React.FC<RankUpCinematicProps> = ({
  summary,
  onContinue,
  onSignIn,
}) => {
  const isGuest = summary.isGuest;
  const promoted = !isGuest && (summary.rankedUp || summary.prestigedUp);
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const skipCinematicIntro = isGuest || reducedMotion;

  const [phase, setPhase] = useState<CinematicPhase>(skipCinematicIntro ? 4 : 1);
  const [rollProgress, setRollProgress] = useState<number>(skipCinematicIntro ? 1 : 0);
  const [flashActive, setFlashActive] = useState<boolean>(false);
  const [shakeActive, setShakeActive] = useState<boolean>(false);
  const rafRef = useRef<number | null>(null);

  const particles = useMemo<SparkParticle[]>(() => {
    const arr: SparkParticle[] = [];
    for (let i = 0; i < 24; i++) {
      arr.push({
        id: i,
        leftPct: 12 + ((i * 37) % 76),
        delayMs: (i * 180) % 2200,
        durationMs: 2400 + ((i * 310) % 1800),
        sizePx: 2 + (i % 3),
        driftX: ((i % 7) - 3) * 14,
      });
    }
    return arr;
  }, []);

  useEffect(() => {
    if (skipCinematicIntro) {
      setPhase(4);
      setRollProgress(1);
      return;
    }

    const cleanupAudio = playCinematicAudio(promoted);
    const startMs = performance.now();

    const tick = (now: number) => {
      const elapsedSec = (now - startMs) / 1000;

      if (elapsedSec < 1.5) {
        setPhase(1);
        setRollProgress(Math.min(1, elapsedSec / 1.45));
      } else if (promoted && elapsedSec < 2.2) {
        setPhase(2);
        setRollProgress(1);
      } else if (promoted && elapsedSec < 3.0) {
        setPhase(3);
        setRollProgress(1);
      } else {
        setPhase(4);
        setRollProgress(1);
      }

      if (elapsedSec < 5.2) {
        rafRef.current = window.requestAnimationFrame(tick);
      }
    };

    rafRef.current = window.requestAnimationFrame(tick);

    const flashTimer = promoted
      ? window.setTimeout(() => {
          setFlashActive(true);
          setShakeActive(true);
          window.setTimeout(() => setFlashActive(false), 240);
          window.setTimeout(() => setShakeActive(false), 420);
        }, 2200)
      : null;

    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (flashTimer !== null) window.clearTimeout(flashTimer);
      cleanupAudio();
    };
  }, [promoted, skipCinematicIntro]);

  const showNewBadge = !promoted || phase >= 3;
  const activeRankNum = showNewBadge ? summary.after.rank : summary.before.rank;
  const activePrestigeNum = showNewBadge ? summary.after.prestige : summary.before.prestige;
  const rankInfo = getRankTitleInfo(activeRankNum);
  const isVeteranMode = activeRankNum >= MAX_RANK;

  const beforeRatio = isVeteranMode
    ? summary.before.prestigeXp / Math.max(1, summary.before.prestigeXpForNext)
    : summary.before.xp / Math.max(1, summary.before.xpForNext);
  const afterRatio = isVeteranMode
    ? summary.after.prestigeXp / Math.max(1, summary.after.prestigeXpForNext)
    : summary.after.xp / Math.max(1, summary.after.xpForNext);

  let displayFillRatio = beforeRatio;
  if (phase === 1) {
    const targetP1 = promoted ? 1 : afterRatio;
    displayFillRatio = beforeRatio + (targetP1 - beforeRatio) * rollProgress;
  } else if (phase === 2) {
    displayFillRatio = 1;
  } else {
    displayFillRatio = afterRatio;
  }

  const clampedFill = Math.max(0, Math.min(1, displayFillRatio));
  const ringRadius = 74;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringDashOffset = ringCircumference * (1 - clampedFill);

  const tickedNetXp = Math.round(summary.breakdown.netXp * (phase === 1 ? rollProgress : 1));
  const tickedCash = Math.round(summary.breakdown.cashEarned * (phase === 1 ? rollProgress : 1));

  const accentColor = summary.prestigedUp
    ? '#38BDF8'
    : promoted
      ? '#F59E0B'
      : rankInfo.accentHex;

  const unlockItems = useMemo(() => {
    const items: Array<{ key: string; kind: string; title: string; detail: string }> = [];
    for (const wid of summary.newlyUnlockedWeapons) {
      const prof = resolveWeaponProfile(wid);
      items.push({
        key: `w-${wid}`,
        kind: 'FIREARM UNLOCKED',
        title: prof.name,
        detail: `${prof.caliberLabel} · Ready in Armory & Gunsmith`,
      });
    }
    for (const grant of summary.autoGrantedSniperScopes) {
      const att = ATTACHMENTS[grant.attachmentId];
      const prof = resolveWeaponProfile(grant.weaponId);
      if (att) {
        items.push({
          key: `scope-${grant.weaponId}-${grant.attachmentId}`,
          kind: 'SNIPER SCOPE GRANTED',
          title: att.name,
          detail: `Auto-unlocked with ${prof.name}`,
        });
      }
    }
    for (const attId of summary.newlyUnlockedAttachments) {
      if (summary.autoGrantedSniperScopes.some((g) => g.attachmentId === attId)) continue;
      const att = ATTACHMENTS[attId];
      if (att) {
        items.push({
          key: `att-${attId}`,
          kind: 'GLOBAL ATTACHMENT',
          title: att.name,
          detail: 'Usable across all compatible firearms',
        });
      }
    }
    return items;
  }, [
    summary.autoGrantedSniperScopes,
    summary.newlyUnlockedAttachments,
    summary.newlyUnlockedWeapons,
  ]);

  const showPostMatchDetails = isGuest || phase >= 4 || !promoted;
  const mvp = summary.mvp;
  const mvpAfkRatio = useMemo(() => {
    if (!mvp) return 0;
    const matched = summary.leaderboard.find((r) => r.id === mvp.id);
    return matched?.afkRatio ?? 0;
  }, [mvp, summary.leaderboard]);

  const outcomeColorClass =
    summary.matchOutcome === 'victory'
      ? 'text-emerald-400'
      : summary.matchOutcome === 'defeat'
        ? 'text-red-400'
        : 'text-amber-300';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center overflow-y-auto bg-neutral-950/94 px-4 py-6 text-neutral-100 backdrop-blur-md select-none sm:px-6 sm:py-8"
      role="dialog"
      aria-modal="true"
      aria-label="Post-Match Summary and Progression Report"
    >
      <div
        className="pointer-events-none fixed inset-0 z-30 transition-opacity duration-200"
        style={{
          background: `radial-gradient(circle at center, ${accentColor}75 0%, rgba(255,255,255,0.22) 35%, transparent 72%)`,
          opacity: flashActive ? 1 : 0,
        }}
      />

      {!isGuest && phase === 4 && !reducedMotion && (
        <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
          {particles.map((p) => (
            <span
              key={p.id}
              className="rankup-spark absolute bottom-1/4 rounded-full"
              style={{
                left: `${p.leftPct}%`,
                width: `${p.sizePx}px`,
                height: `${p.sizePx}px`,
                backgroundColor: accentColor,
                animationDelay: `${p.delayMs}ms`,
                animationDuration: `${p.durationMs}ms`,
                ['--spark-drift-x' as string]: `${p.driftX}px`,
              }}
            />
          ))}
        </div>
      )}

      <div
        className={`relative z-10 my-auto flex w-full max-w-5xl flex-col items-center ${
          shakeActive ? 'rankup-shake' : ''
        }`}
      >
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 font-mono-tabular text-xs uppercase tracking-[0.22em] text-neutral-400">
          <span>
            {isGuest
              ? 'After-Action Match Summary'
              : summary.prestigedUp && phase >= 3
                ? 'Veteran Prestige Advancement'
                : summary.rankedUp && phase >= 3
                  ? 'Field Promotion Confirmed'
                  : 'After-Action Progression Report'}
          </span>
          <span className="text-neutral-600">·</span>
          <span className={outcomeColorClass}>{formatOutcomeLabel(summary.matchOutcome)}</span>
          <span className="text-neutral-600">·</span>
          <span>{summary.mode}</span>
          {summary.mapName && (
            <>
              <span className="text-neutral-600">·</span>
              <span className="text-neutral-300">{summary.mapName}</span>
            </>
          )}
          <span className="text-neutral-600">·</span>
          <span>{formatDurationClock(summary.matchDurationSec)}</span>
        </div>

        {isGuest ? (
          <div className="mt-4 flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 border border-neutral-800 bg-neutral-900/70 px-4 py-3">
            <div>
              <h2 className="font-display text-2xl font-bold uppercase tracking-wider text-neutral-50 sm:text-3xl">
                {formatOutcomeLabel(summary.matchOutcome)} · Combat Session Summary
              </h2>
              <p className="mt-0.5 text-xs text-neutral-400">
                Guest Session · Career XP, rank progression, and firearm unlocks are skipped for guests.
              </p>
            </div>
            {onSignIn && (
              <button
                type="button"
                onClick={onSignIn}
                className="cursor-pointer rounded-sm border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-500/50 hover:text-amber-300"
              >
                Sign In to Save XP
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="relative mt-5 flex h-44 w-44 items-center justify-center">
              <div
                className="pointer-events-none absolute inset-0 rounded-full transition-all duration-300"
                style={{
                  background: `radial-gradient(circle, ${accentColor}40 0%, transparent 68%)`,
                  opacity: phase === 2 ? 0.95 : phase === 3 ? 1 : phase === 4 && promoted ? 0.45 : 0.18,
                  transform: phase === 2 ? 'scale(1.18)' : phase === 3 ? 'scale(1.32)' : 'scale(1.0)',
                }}
              />

              <svg className="h-40 w-40 -rotate-90" viewBox="0 0 180 180" aria-hidden="true">
                <circle
                  cx="90"
                  cy="90"
                  r={ringRadius}
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="7"
                />
                <circle
                  cx="90"
                  cy="90"
                  r={ringRadius}
                  fill="none"
                  stroke={accentColor}
                  strokeWidth={phase === 2 ? '10' : '7'}
                  strokeLinecap="butt"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringDashOffset}
                  style={{
                    transition: phase === 1 ? 'none' : 'stroke-dashoffset 450ms cubic-bezier(0.16, 1, 0.3, 1)',
                    filter: phase === 2 ? `drop-shadow(0 0 12px ${accentColor})` : 'none',
                  }}
                />
              </svg>

              <div
                className={`absolute flex h-28 w-28 flex-col items-center justify-center border bg-neutral-950/95 transition-transform ${
                  phase === 2
                    ? 'rankup-tension-vibrate'
                    : phase === 3 && promoted
                      ? 'rankup-impact-pop'
                      : ''
                }`}
                style={{
                  borderColor: accentColor,
                  boxShadow:
                    phase >= 3 && promoted
                      ? `0 0 32px ${accentColor}45, inset 0 0 18px ${accentColor}22`
                      : 'none',
                }}
              >
                {isVeteranMode ? (
                  <Award className="h-5 w-5" style={{ color: accentColor }} />
                ) : (
                  <Shield className="h-5 w-5" style={{ color: accentColor }} />
                )}
                <span className="mt-0.5 font-display text-3xl font-bold leading-none text-neutral-50">
                  {activeRankNum}
                </span>
                <span
                  className="mt-1 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.2em]"
                  style={{ color: accentColor }}
                >
                  {isVeteranMode && activePrestigeNum > 0
                    ? `PRESTIGE ${activePrestigeNum}`
                    : rankInfo.shortTitle}
                </span>
              </div>
            </div>

            <div className="mt-3 overflow-hidden text-center">
              <div
                className="transition-all duration-500"
                style={{
                  transform:
                    phase >= 3 || !promoted ? 'translateY(0)' : 'translateY(14px)',
                  opacity: phase >= 3 || !promoted ? 1 : 0.72,
                }}
              >
                {promoted && phase >= 3 && (
                  <div
                    className="font-mono-tabular text-xs font-semibold uppercase tracking-[0.34em]"
                    style={{ color: accentColor }}
                  >
                    {summary.prestigedUp ? 'PRESTIGE UNLOCKED' : 'PROMOTED'}
                  </div>
                )}
                <h2 className="mt-0.5 font-display text-3xl font-bold uppercase tracking-wider text-neutral-50 sm:text-4xl">
                  {isVeteranMode && activePrestigeNum > 0
                    ? `VETERAN 100 · PRESTIGE ${activePrestigeNum}`
                    : `${rankInfo.title.toUpperCase()} · RANK ${activeRankNum}`}
                </h2>
              </div>
            </div>

            <div className="mt-4 w-full max-w-2xl">
              <div className="flex items-center justify-between font-mono-tabular text-xs">
                <span className="text-neutral-400">
                  {isVeteranMode ? 'Prestige Progress' : 'Rank Progress'}
                </span>
                <span className={tickedNetXp >= 0 ? 'text-amber-300' : 'text-red-400'}>
                  {tickedNetXp >= 0 ? `+${tickedNetXp.toLocaleString()}` : tickedNetXp.toLocaleString()} XP · +${tickedCash.toLocaleString()}
                </span>
              </div>
              <div className="mt-1.5 h-2 w-full overflow-hidden bg-neutral-900">
                <div
                  className="h-full"
                  style={{
                    width: `${(clampedFill * 100).toFixed(1)}%`,
                    backgroundColor: accentColor,
                    transition: phase === 1 ? 'none' : 'width 420ms cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono-tabular text-[11px] text-neutral-400">
                <span>Kills +{summary.breakdown.killXp}</span>
                {summary.breakdown.headshotXp > 0 && (
                  <span>· Headshots +{summary.breakdown.headshotXp}</span>
                )}
                {summary.breakdown.deathPenaltyXp > 0 && (
                  <span className="text-red-400">· Deaths -{summary.breakdown.deathPenaltyXp}</span>
                )}
                <span
                  className={
                    summary.breakdown.matchOutcomeXp >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }
                >
                  · Match {summary.breakdown.matchOutcomeXp >= 0 ? '+' : ''}
                  {summary.breakdown.matchOutcomeXp}
                </span>
                {summary.breakdown.roundBonusXp > 0 && (
                  <span>· Waves +{summary.breakdown.roundBonusXp}</span>
                )}
              </div>
            </div>
          </>
        )}

        <div
          className="mt-6 flex w-full flex-col gap-4 transition-all duration-500"
          style={{
            opacity: showPostMatchDetails ? 1 : 0,
            transform: showPostMatchDetails ? 'translateY(0)' : 'translateY(18px)',
          }}
        >
          {mvp && (
            <section
              aria-label="Match MVP Highlight"
              className="border border-amber-500/40 bg-neutral-900/80 p-4"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center border border-amber-500/50 bg-amber-500/15 text-amber-300">
                    <Trophy className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400">
                      <span>Match MVP</span>
                      <span className="text-neutral-600">·</span>
                      <span className="text-neutral-400">Highest Kill-to-Death Ratio</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <h3 className="font-display text-2xl font-bold uppercase tracking-wide text-neutral-50">
                        {mvp.name}
                      </h3>
                      {mvp.isLocalPlayer && (
                        <span className="rounded-sm border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-amber-300">
                          YOU
                        </span>
                      )}
                      {mvp.isBot && (
                        <span className="rounded-sm border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] font-medium uppercase tracking-wider text-neutral-400">
                          AI
                        </span>
                      )}
                      <span className="rounded-sm border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                        {formatUnitLabel(mvp.team, summary.mode)}
                      </span>
                    </div>
                    {mvp.badges.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        {mvp.badges.map((badgeId) => (
                          <PostMatchBadgeTag
                            key={`mvp-${badgeId}`}
                            badgeId={badgeId}
                            tooltip={getBadgeTooltip(badgeId, { ...mvp, afkRatio: mvpAfkRatio })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <div className="border border-amber-500/35 bg-neutral-950/90 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-amber-400">
                      K/D
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-bold text-neutral-50">
                      {mvp.kdDisplay}
                    </div>
                    {mvp.kdRatio === null && (
                      <div className="font-mono-tabular text-[9px] uppercase tracking-wider text-emerald-400">
                        Zero Deaths
                      </div>
                    )}
                  </div>
                  <div className="border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
                      Kills
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-semibold text-neutral-100">
                      {mvp.kills}
                    </div>
                  </div>
                  <div className="border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
                      Deaths
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-semibold text-neutral-300">
                      {mvp.deaths}
                    </div>
                  </div>
                  <div className="border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
                      Assists
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-semibold text-neutral-300">
                      {mvp.assists}
                    </div>
                  </div>
                  <div className="border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
                      Headshots
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-semibold text-sky-300">
                      {mvp.headshots}
                    </div>
                  </div>
                  <div className="border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-center">
                    <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-500">
                      Damage
                    </div>
                    <div className="mt-0.5 font-mono-tabular text-xl font-semibold text-neutral-200">
                      {mvp.damageDealt.toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {summary.leaderboard.length > 0 && (
            <section
              aria-label="End-of-Match Leaderboard and Player Strengths"
              className="border border-neutral-800 bg-neutral-900/75"
            >
              <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
                <span className="font-mono-tabular text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-300">
                  Match Leaderboard & Player Strengths
                </span>
                <span className="font-mono-tabular text-[11px] text-neutral-500">
                  {summary.leaderboard.length}{' '}
                  {summary.leaderboard.length === 1 ? 'Combatant' : 'Combatants'}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[740px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-neutral-800/80 bg-neutral-950/50 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                      <th className="w-10 px-3 py-2">#</th>
                      <th className="px-3 py-2">Operator</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-2.5 py-2 text-right">K</th>
                      <th className="px-2.5 py-2 text-right">D</th>
                      <th className="px-2.5 py-2 text-right">A</th>
                      <th className="px-2.5 py-2 text-right">K/D</th>
                      <th className="px-2.5 py-2 text-right">HS</th>
                      <th className="px-2.5 py-2 text-right">DMG</th>
                      <th className="px-3 py-2">Strengths</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800/60">
                    {summary.leaderboard.map((entry: MatchLeaderboardEntry) => {
                      const rowHighlight = entry.isLocalPlayer
                        ? 'bg-amber-500/10'
                        : entry.isMvp
                          ? 'bg-neutral-800/35'
                          : '';
                      return (
                        <tr key={entry.id} className={`transition-colors hover:bg-neutral-800/40 ${rowHighlight}`}>
                          <td className="px-3 py-2.5 font-mono-tabular text-xs font-semibold text-neutral-400">
                            {entry.rankPosition}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`text-xs font-semibold ${
                                  entry.isLocalPlayer ? 'text-amber-300' : 'text-neutral-100'
                                }`}
                              >
                                {entry.name}
                              </span>
                              {entry.isLocalPlayer && (
                                <span className="rounded-sm border border-amber-500/35 bg-amber-500/15 px-1 py-0.2 font-mono-tabular text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                                  YOU
                                </span>
                              )}
                              {entry.isMvp && (
                                <span className="inline-flex items-center gap-0.5 rounded-sm border border-amber-500/40 bg-amber-500/15 px-1 py-0.2 font-mono-tabular text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                                  <Trophy className="h-2.5 w-2.5" />
                                  <span>MVP</span>
                                </span>
                              )}
                              {entry.isBot && (
                                <span className="rounded-sm border border-neutral-700 bg-neutral-950 px-1 py-0.2 font-mono-tabular text-[9px] uppercase tracking-wider text-neutral-400">
                                  AI
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                            {formatUnitLabel(entry.team, summary.mode)}
                          </td>
                          <td className="px-2.5 py-2.5 text-right font-mono-tabular text-xs font-semibold text-neutral-100">
                            {entry.kills}
                          </td>
                          <td className="px-2.5 py-2.5 text-right font-mono-tabular text-xs text-neutral-300">
                            {entry.deaths}
                          </td>
                          <td className="px-2.5 py-2.5 text-right font-mono-tabular text-xs text-neutral-300">
                            {entry.assists}
                          </td>
                          <td
                            className={`px-2.5 py-2.5 text-right font-mono-tabular text-xs font-semibold ${
                              entry.isMvp ? 'text-amber-300' : 'text-neutral-200'
                            }`}
                          >
                            {entry.kdDisplay}
                          </td>
                          <td className="px-2.5 py-2.5 text-right font-mono-tabular text-xs text-sky-300">
                            {entry.headshots}
                          </td>
                          <td className="px-2.5 py-2.5 text-right font-mono-tabular text-xs text-neutral-300">
                            {entry.damageDealt.toLocaleString()}
                          </td>
                          <td className="px-3 py-2.5">
                            {entry.badges.length > 0 ? (
                              <div className="flex flex-wrap items-center gap-1">
                                {entry.badges.map((badgeId) => (
                                  <PostMatchBadgeTag
                                    key={`${entry.id}-${badgeId}`}
                                    badgeId={badgeId}
                                    tooltip={getBadgeTooltip(badgeId, entry)}
                                  />
                                ))}
                              </div>
                            ) : (
                              <span className="font-mono-tabular text-xs text-neutral-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {!isGuest && (unlockItems.length > 0 || summary.gunDeltas.length > 0) && (
            <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
              {unlockItems.length > 0 && (
                <div className="border border-neutral-800 bg-neutral-900/75 p-3.5">
                  <div className="flex items-center gap-1.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>New Unlocks ({unlockItems.length})</span>
                  </div>
                  <div className="mt-2.5 flex max-h-36 flex-col gap-2 overflow-y-auto pr-1">
                    {unlockItems.map((item) => (
                      <div
                        key={item.key}
                        className="border-t border-neutral-800/80 pt-2 first:border-t-0 first:pt-0"
                      >
                        <div className="font-mono-tabular text-[10px] uppercase tracking-wider text-sky-300">
                          {item.kind}
                        </div>
                        <div className="text-xs font-semibold text-neutral-100">{item.title}</div>
                        <div className="text-[11px] text-neutral-400">{item.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {summary.gunDeltas.length > 0 && (
                <div
                  className={`border border-neutral-800 bg-neutral-900/75 p-3.5 ${
                    unlockItems.length === 0 ? 'sm:col-span-2' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-300">
                    <Crosshair className="h-3.5 w-3.5 text-amber-400" />
                    <span>Weapon Mastery XP</span>
                  </div>
                  <div className="mt-2.5 flex max-h-36 flex-col gap-2 overflow-y-auto pr-1">
                    {summary.gunDeltas.map((g) => {
                      const prof = resolveWeaponProfile(g.weaponId);
                      const pct = Math.min(100, (g.afterXp / Math.max(1, g.nextLevelXp)) * 100);
                      return (
                        <div key={g.weaponId} className="font-mono-tabular text-xs">
                          <div className="flex items-center justify-between">
                            <span className="truncate text-neutral-100">{prof.name}</span>
                            <span className="shrink-0 text-amber-300">
                              Lv.{g.afterLevel}
                              {g.afterLevel > g.beforeLevel ? ' UP' : ''} (+{g.xpGained} XP)
                            </span>
                          </div>
                          <div className="mt-1 h-1 w-full bg-neutral-950">
                            <div className="h-full bg-amber-400" style={{ width: `${pct.toFixed(1)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-6">
          <button
            type="button"
            onClick={onContinue}
            className="flex cursor-pointer items-center gap-2 bg-amber-500 px-7 py-2.5 font-display text-base font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
          >
            <span>Continue</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

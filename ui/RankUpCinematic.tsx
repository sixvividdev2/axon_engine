import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Award, ChevronRight, Crosshair, Shield, Sparkles } from 'lucide-react';
import { resolveWeaponProfile } from '../bodycam-sdk';
import { ATTACHMENTS } from '../data/attachments';
import {
  getRankTitleInfo,
  MatchProgressionSummary,
  MAX_RANK,
} from '../data/progression';

interface RankUpCinematicProps {
  summary: MatchProgressionSummary;
  onContinue: () => void;
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

function playCinematicAudio(promoted: boolean): () => void {
  try {
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return () => {};
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // Phase 1 (0.0s - 1.5s): Rising tension pitch sweep
    const riseOsc = ctx.createOscillator();
    const riseGain = ctx.createGain();
    riseOsc.type = 'triangle';
    riseOsc.frequency.setValueAtTime(160, now);
    riseOsc.frequency.exponentialRampToValueAtTime(promoted ? 640 : 420, now + 1.48);
    riseGain.gain.setValueAtTime(0.001, now);
    riseGain.gain.linearRampToValueAtTime(0.08, now + 0.2);
    riseGain.gain.linearRampToValueAtTime(0.11, now + 1.42);
    // Phase 2 vacuum cut at 1.5s
    riseGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.55);
    riseOsc.connect(riseGain).connect(ctx.destination);
    riseOsc.start(now);
    riseOsc.stop(now + 1.58);

    if (promoted) {
      // Phase 2 tension hum (1.5s - 2.05s) then dead silence vacuum (2.05s - 2.2s)
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

      // Phase 3 (2.2s): Heavy bass drop + metallic slam
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

      // Metallic lock chime chord (2.22s - 3.6s)
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

export const RankUpCinematic: React.FC<RankUpCinematicProps> = ({ summary, onContinue }) => {
  const promoted = summary.rankedUp || summary.prestigedUp;
  const reducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const [phase, setPhase] = useState<CinematicPhase>(reducedMotion ? 4 : 1);
  const [rollProgress, setRollProgress] = useState<number>(reducedMotion ? 1 : 0);
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
    if (reducedMotion) return;

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
  }, [promoted, reducedMotion]);

  const showNewBadge = !promoted || phase >= 3;
  const activeRankNum = showNewBadge ? summary.after.rank : summary.before.rank;
  const activePrestigeNum = showNewBadge ? summary.after.prestige : summary.before.prestige;
  const rankInfo = getRankTitleInfo(activeRankNum);
  const isVeteranMode = activeRankNum >= MAX_RANK;

  // Radial & linear progress values across phases
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

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-neutral-950/92 px-6 py-8 text-neutral-100 backdrop-blur-md select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Match Progression Report"
    >
      {/* Phase 3 Impact Flash */}
      <div
        className="pointer-events-none fixed inset-0 z-30 transition-opacity duration-200"
        style={{
          background: `radial-gradient(circle at center, ${accentColor}75 0%, rgba(255,255,255,0.22) 35%, transparent 72%)`,
          opacity: flashActive ? 1 : 0,
        }}
      />

      {/* Phase 4 Ambient Drift Sparks */}
      {phase === 4 && !reducedMotion && (
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

      {/* Main Centered Stage */}
      <div
        className={`relative z-10 flex w-full max-w-3xl flex-col items-center ${
          shakeActive ? 'rankup-shake' : ''
        }`}
      >
        {/* Top Phase Kicker */}
        <div className="font-mono-tabular text-xs uppercase tracking-[0.26em] text-neutral-400">
          {summary.prestigedUp && phase >= 3
            ? 'Veteran Prestige Advancement'
            : summary.rankedUp && phase >= 3
              ? 'Field Promotion Confirmed'
              : 'After-Action Progression Report'}
        </div>

        {/* Center Radial Emblem & Tension Core */}
        <div className="relative mt-6 flex h-48 w-48 items-center justify-center">
          {/* Outer Energy Surge Glow in Phase 2 & 3 */}
          <div
            className="pointer-events-none absolute inset-0 rounded-full transition-all duration-300"
            style={{
              background: `radial-gradient(circle, ${accentColor}40 0%, transparent 68%)`,
              opacity: phase === 2 ? 0.95 : phase === 3 ? 1 : phase === 4 && promoted ? 0.45 : 0.18,
              transform: phase === 2 ? 'scale(1.18)' : phase === 3 ? 'scale(1.32)' : 'scale(1.0)',
            }}
          />

          {/* SVG Radial XP Ring */}
          <svg className="h-44 w-44 -rotate-90" viewBox="0 0 180 180" aria-hidden="true">
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

          {/* Emblem Core */}
          <div
            className={`absolute flex h-32 w-32 flex-col items-center justify-center border bg-neutral-950/95 transition-transform ${
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
            <span className="mt-0.5 font-display text-4xl font-bold leading-none text-neutral-50">
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

        {/* Kinetic Reveal Headline */}
        <div className="mt-5 overflow-hidden text-center">
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
            <h2 className="mt-1 font-display text-4xl font-bold uppercase tracking-wider text-neutral-50 sm:text-5xl">
              {isVeteranMode && activePrestigeNum > 0
                ? `VETERAN 100 · PRESTIGE ${activePrestigeNum}`
                : `${rankInfo.title.toUpperCase()} · RANK ${activeRankNum}`}
            </h2>
          </div>
        </div>

        {/* Linear XP Bar & Numeric Telemetry */}
        <div className="mt-5 w-full max-w-xl">
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

          {/* Match XP Breakdown Row */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 font-mono-tabular text-[11px] text-neutral-400">
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

        {/* Phase 4 Reward Rail: Unlocks & Gun Mastery */}
        <div
          className="mt-6 grid w-full max-w-2xl grid-cols-1 gap-3 transition-all duration-500 sm:grid-cols-2"
          style={{
            opacity: phase >= 4 || !promoted ? 1 : 0,
            transform: phase >= 4 || !promoted ? 'translateY(0)' : 'translateY(18px)',
          }}
        >
          {/* Newly Unlocked Firearms & Attachments */}
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

          {/* Gun XP Deltas */}
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

        {/* Continue Action */}
        <div className="mt-7">
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

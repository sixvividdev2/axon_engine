import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Clock,
  Crosshair,
  Download,
  RotateCcw,
  Shield,
  Target,
} from 'lucide-react';
import {
  buildMatchSummaryExportPayload,
  compareRecentMatches,
  ComparisonTrend,
  formatMatchExportFilename,
  MAX_RECENT_MATCHES,
  RecentMatchRecord,
} from '../data/progression';
import { formatBattleRuleShort } from '../maps/types';

interface RecentMatchesPanelProps {
  matches: readonly RecentMatchRecord[];
  isGuest: boolean;
  accent?: 'amber' | 'red';
  onClearGuestHistory?: () => void;
}

function formatDurationClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatMatchTimestamp(ts: number): string {
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Recent';
  }
}

function formatModeRuleLabel(match: RecentMatchRecord): string {
  if (match.mode === 'infection') {
    const wave = match.infectionRound && match.infectionRound > 0 ? match.infectionRound : 1;
    return `Infection · Wave ${wave}`;
  }
  if (match.battleRule) {
    return `Battle · ${formatBattleRuleShort(match.battleRule)}`;
  }
  return 'Battle';
}

function getOutcomeDisplay(outcome: RecentMatchRecord['outcome']): {
  label: string;
  textClassName: string;
} {
  if (outcome === 'victory') {
    return {
      label: 'Victory',
      textClassName: 'text-emerald-400',
    };
  }
  if (outcome === 'defeat') {
    return {
      label: 'Defeat',
      textClassName: 'text-red-400',
    };
  }
  return {
    label: 'Completed',
    textClassName: 'text-amber-300',
  };
}

function getTrendTextClass(trend: ComparisonTrend): string {
  if (trend === 'better') return 'text-emerald-400';
  if (trend === 'worse') return 'text-red-400';
  if (trend === 'equal') return 'text-neutral-400';
  return 'text-neutral-300';
}

function getTrendArrow(trend: ComparisonTrend): string {
  if (trend === 'better') return ' ↑';
  if (trend === 'worse') return ' ↓';
  return '';
}

function triggerMatchJsonDownload(match: RecentMatchRecord): void {
  const payload = buildMatchSummaryExportPayload(match);
  const jsonText = JSON.stringify(payload, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = formatMatchExportFilename(match);
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export const RecentMatchesPanel: React.FC<RecentMatchesPanelProps> = ({
  matches,
  isGuest,
  accent = 'amber',
  onClearGuestHistory,
}) => {
  const visibleMatches = matches.slice(0, MAX_RECENT_MATCHES);
  const canCompare = visibleMatches.length >= 2;
  const [compareOpen, setCompareOpen] = useState<boolean>(false);
  const [downloadedMatchId, setDownloadedMatchId] = useState<string | null>(null);
  const downloadResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!canCompare && compareOpen) {
      setCompareOpen(false);
    }
  }, [canCompare, compareOpen]);

  useEffect(() => {
    return () => {
      if (downloadResetTimerRef.current !== null) {
        window.clearTimeout(downloadResetTimerRef.current);
      }
    };
  }, []);

  const comparison = useMemo(() => {
    if (!compareOpen || visibleMatches.length < 2) return null;
    return compareRecentMatches(visibleMatches[0], visibleMatches[1]);
  }, [compareOpen, visibleMatches]);

  const borderShell =
    accent === 'red' ? 'border-red-950/80 bg-neutral-950/88' : 'border-neutral-800 bg-neutral-950/88';
  const headingAccent = accent === 'red' ? 'text-red-400' : 'text-amber-400';
  const activeToggleClass =
    accent === 'red'
      ? 'border-red-500 bg-red-600/20 text-red-100'
      : 'border-amber-400 bg-amber-500/20 text-amber-200';

  const handleDownloadMatch = (match: RecentMatchRecord) => {
    triggerMatchJsonDownload(match);
    setDownloadedMatchId(match.id);
    if (downloadResetTimerRef.current !== null) {
      window.clearTimeout(downloadResetTimerRef.current);
    }
    downloadResetTimerRef.current = window.setTimeout(() => {
      setDownloadedMatchId(null);
      downloadResetTimerRef.current = null;
    }, 1800);
  };

  return (
    <section
      aria-label="Recent Matches"
      className={`border ${borderShell} p-4`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800/80 pb-3">
        <div>
          <div className={`font-mono-tabular text-[11px] uppercase tracking-[0.16em] ${headingAccent}`}>
            Last {MAX_RECENT_MATCHES} Combat Sessions · {isGuest ? 'Local Guest Storage' : 'Account Synced'}
          </div>
          <h3 className="mt-0.5 font-display text-lg font-bold uppercase tracking-wider text-neutral-100">
            Recent Matches
          </h3>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-xs text-neutral-400">
          <span className="mr-1">
            {visibleMatches.length} / {MAX_RECENT_MATCHES} Logged
          </span>

          <button
            type="button"
            disabled={!canCompare}
            onClick={() => setCompareOpen((prev) => !prev)}
            aria-expanded={compareOpen}
            title={
              canCompare
                ? 'Compare stats from the two most recent matches side by side'
                : 'Complete at least 2 matches to compare'
            }
            className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors focus-visible:outline-2 focus-visible:outline-amber-400 disabled:cursor-not-allowed disabled:opacity-40 ${
              compareOpen
                ? activeToggleClass
                : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-neutral-500 hover:text-white'
            }`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            <span>{compareOpen ? 'Hide Comparison' : 'Compare Last 2'}</span>
          </button>

          {isGuest && visibleMatches.length > 0 && onClearGuestHistory && (
            <button
              type="button"
              onClick={onClearGuestHistory}
              className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-[11px] uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 focus-visible:outline-2 focus-visible:outline-amber-400"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Side-by-Side Comparison Matrix of the Two Most Recent Matches */}
      {comparison && (
        <div
          aria-label="Side-by-Side Match Comparison"
          className="mt-3 border border-neutral-800 bg-neutral-900/65 p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-800/80 pb-2.5">
            <h4 className="font-display text-sm font-bold uppercase tracking-wider text-neutral-100">
              Latest vs Previous Match Comparison
            </h4>
            <span className="font-mono-tabular text-[11px] text-neutral-400">
              Delta compares Match #1 against Match #2
            </span>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left font-mono-tabular text-xs">
              <thead>
                <tr className="border-b border-neutral-800 text-[11px] text-neutral-400">
                  <th className="py-2 pr-3 font-medium uppercase tracking-wider">Metric</th>
                  <th className="py-2 px-3 font-medium">
                    <div className="text-neutral-100">
                      #1 Latest ·{' '}
                      <span className={getOutcomeDisplay(comparison.latest.outcome).textClassName}>
                        {getOutcomeDisplay(comparison.latest.outcome).label}
                      </span>
                    </div>
                    <div className="text-[11px] font-normal text-neutral-400">
                      {formatModeRuleLabel(comparison.latest)} · {comparison.latest.mapName} ·{' '}
                      {formatMatchTimestamp(comparison.latest.completedAt)}
                    </div>
                  </th>
                  <th className="py-2 px-3 font-medium">
                    <div className="text-neutral-100">
                      #2 Previous ·{' '}
                      <span className={getOutcomeDisplay(comparison.previous.outcome).textClassName}>
                        {getOutcomeDisplay(comparison.previous.outcome).label}
                      </span>
                    </div>
                    <div className="text-[11px] font-normal text-neutral-400">
                      {formatModeRuleLabel(comparison.previous)} · {comparison.previous.mapName} ·{' '}
                      {formatMatchTimestamp(comparison.previous.completedAt)}
                    </div>
                  </th>
                  <th className="py-2 pl-3 text-right font-medium uppercase tracking-wider">
                    Delta
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800/70">
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">Kills</td>
                  <td className="py-2 px-3 font-semibold text-neutral-100">
                    {comparison.latest.kills}
                  </td>
                  <td className="py-2 px-3 font-semibold text-neutral-200">
                    {comparison.previous.kills}
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.kills.trend)}`}>
                    {comparison.kills.deltaText}
                    {getTrendArrow(comparison.kills.trend)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">Deaths</td>
                  <td className="py-2 px-3 font-semibold text-neutral-100">
                    {comparison.latest.deaths}
                  </td>
                  <td className="py-2 px-3 font-semibold text-neutral-200">
                    {comparison.previous.deaths}
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.deaths.trend)}`}>
                    {comparison.deaths.deltaText}
                    {comparison.deaths.trend === 'better'
                      ? ' ↓ (Fewer)'
                      : comparison.deaths.trend === 'worse'
                        ? ' ↑ (More)'
                        : ''}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">K/D Ratio</td>
                  <td className="py-2 px-3 font-semibold text-neutral-100">
                    {comparison.latest.kdDisplay}
                  </td>
                  <td className="py-2 px-3 font-semibold text-neutral-200">
                    {comparison.previous.kdDisplay}
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.kd.trend)}`}>
                    {comparison.kd.deltaText}
                    {getTrendArrow(comparison.kd.trend)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">Headshots</td>
                  <td className="py-2 px-3 font-semibold text-sky-300">
                    {comparison.latest.headshots}{' '}
                    <span className="font-normal text-neutral-400">
                      ({comparison.headshots.latestPct}%)
                    </span>
                  </td>
                  <td className="py-2 px-3 font-semibold text-sky-300/90">
                    {comparison.previous.headshots}{' '}
                    <span className="font-normal text-neutral-400">
                      ({comparison.headshots.previousPct}%)
                    </span>
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.headshots.trend)}`}>
                    {comparison.headshots.deltaText}
                    {getTrendArrow(comparison.headshots.trend)}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">Duration</td>
                  <td className="py-2 px-3 font-semibold text-neutral-100">
                    {formatDurationClock(comparison.latest.durationSec)}
                  </td>
                  <td className="py-2 px-3 font-semibold text-neutral-200">
                    {formatDurationClock(comparison.previous.durationSec)}
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.duration.trend)}`}>
                    {comparison.duration.deltaText}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">XP Earned</td>
                  <td className="py-2 px-3 font-semibold text-amber-300">
                    {comparison.latest.isGuest
                      ? 'Guest (0 XP)'
                      : `${comparison.latest.netXp >= 0 ? '+' : ''}${comparison.latest.netXp.toLocaleString()} XP`}
                  </td>
                  <td className="py-2 px-3 font-semibold text-amber-300/90">
                    {comparison.previous.isGuest
                      ? 'Guest (0 XP)'
                      : `${comparison.previous.netXp >= 0 ? '+' : ''}${comparison.previous.netXp.toLocaleString()} XP`}
                  </td>
                  <td className={`py-2 pl-3 text-right font-semibold ${getTrendTextClass(comparison.xp.trend)}`}>
                    {comparison.xp.deltaText}
                    {comparison.xp.comparable ? getTrendArrow(comparison.xp.trend) : ''}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-3 text-neutral-400">Top Weapon</td>
                  <td className="py-2 px-3 text-neutral-100">
                    {comparison.topWeapon.latestLabel}
                  </td>
                  <td className="py-2 px-3 text-neutral-200">
                    {comparison.topWeapon.previousLabel}
                  </td>
                  <td className="py-2 pl-3 text-right text-neutral-300">
                    {comparison.topWeapon.statusText}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {visibleMatches.length === 0 ? (
        <div className="mt-3 border border-neutral-800/80 bg-neutral-900/45 px-4 py-5 font-mono-tabular text-xs text-neutral-400">
          No completed matches logged yet. Complete a Battle or Infection session to record your
          outcome, K/D ratio, weapon stats, duration, and XP earned.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {visibleMatches.map((match) => {
            const outcomeMeta = getOutcomeDisplay(match.outcome);
            const signedXp =
              match.netXp >= 0 ? `+${match.netXp.toLocaleString()}` : match.netXp.toLocaleString();
            const isDownloaded = downloadedMatchId === match.id;

            return (
              <article
                key={match.id}
                className="border border-neutral-800/90 bg-neutral-900/55 px-4 py-3.5"
              >
                {/* Top Row: Outcome, Mode/Wave, Map, Timestamp & Download Action */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 font-mono-tabular text-xs">
                    <span className={`font-semibold uppercase tracking-wider ${outcomeMeta.textClassName}`}>
                      {outcomeMeta.label}
                    </span>
                    <span className="text-neutral-600" aria-hidden="true">·</span>
                    <span className="font-semibold text-neutral-100">
                      {formatModeRuleLabel(match)}
                    </span>
                    <span className="text-neutral-600" aria-hidden="true">·</span>
                    <span className="text-neutral-300">{match.mapName}</span>
                    <span className="text-neutral-600" aria-hidden="true">·</span>
                    <span className="text-neutral-400">
                      {formatMatchTimestamp(match.completedAt)}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleDownloadMatch(match)}
                    className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-950/90 px-3 py-1.5 font-mono-tabular text-[11px] font-medium text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-400"
                  >
                    {isDownloaded ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-emerald-300">Downloaded JSON</span>
                      </>
                    ) : (
                      <>
                        <Download className="h-3.5 w-3.5 text-amber-400" />
                        <span>Download Match Summary</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Middle Row: Core Match Metrics */}
                <div className="mt-3 grid grid-cols-2 gap-3 border-t border-neutral-800/70 pt-3 font-mono-tabular sm:grid-cols-5">
                  <div>
                    <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                      <Crosshair className="h-3 w-3" />
                      <span>Kills / Deaths</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold text-neutral-100">
                      {match.kills} / {match.deaths}
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-neutral-400">K/D Ratio</div>
                    <div className="mt-0.5 text-sm font-semibold text-neutral-100">
                      {match.kdDisplay}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                      <Target className="h-3 w-3" />
                      <span>Headshots</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold text-sky-300">
                      {match.headshots}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                      <Clock className="h-3 w-3" />
                      <span>Duration</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold text-neutral-200">
                      {formatDurationClock(match.durationSec)}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-1 text-[11px] text-neutral-400">
                      <Shield className="h-3 w-3" />
                      <span>XP Earned</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {match.isGuest ? (
                        <span className="text-neutral-400">Guest Session</span>
                      ) : (
                        <span className={match.netXp >= 0 ? 'text-amber-300' : 'text-red-300'}>
                          {signedXp} XP
                          {match.cashEarned > 0 && (
                            <span className="ml-1.5 text-[11px] font-normal text-neutral-400">
                              (+${match.cashEarned.toLocaleString()})
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Optional Mode Objective & Dogtag Telemetry */}
                {(match.battleRule === 'kc_tdm' ||
                  match.battleRule === 'kc_ffa' ||
                  match.battleRule === 'conquest' ||
                  match.battleRule === 'ctf' ||
                  match.battleRule === 'koth') && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-800/70 pt-2 font-mono-tabular text-[11px] text-neutral-300">
                    {(match.battleRule === 'kc_tdm' || match.battleRule === 'kc_ffa') && (
                      <>
                        <span>
                          Enemy Dogtags:{' '}
                          <strong className="text-amber-300">{match.enemyDogtags ?? 0}</strong>
                        </span>
                        <span>
                          Secured Friendly Dogtags:{' '}
                          <strong className="text-sky-300">{match.friendlyDogtags ?? 0}</strong>
                          {(match.selfDogtagsRecovered ?? 0) > 0 && (
                            <span className="ml-1 text-emerald-300">
                              ({match.selfDogtagsRecovered} Own Tag)
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {match.battleRule === 'conquest' && (
                      <>
                        <span>
                          POI Captures:{' '}
                          <strong className="text-amber-300">{match.poiCaptures ?? 0}</strong>
                        </span>
                        <span>
                          Territory Score:{' '}
                          <strong className="text-sky-300">
                            {Math.round(match.teamScoreA ?? 0)}–{Math.round(match.teamScoreB ?? 0)}
                          </strong>
                        </span>
                      </>
                    )}
                    {match.battleRule === 'ctf' && (
                      <>
                        <span>
                          Flag Captures:{' '}
                          <strong className="text-amber-300">{match.flagCaptures ?? 0}</strong>
                        </span>
                        <span>
                          Flag Returns:{' '}
                          <strong className="text-sky-300">{match.flagReturns ?? 0}</strong>
                        </span>
                      </>
                    )}
                    {match.battleRule === 'koth' && (
                      <span>
                        Hill Control:{' '}
                        <strong className="text-amber-300">
                          {Math.round(match.hillControlSec ?? 0)}s
                        </strong>
                      </span>
                    )}
                  </div>
                )}

                {/* Bottom Row: Per-Weapon Elimination Stats */}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-800/70 pt-2.5 font-mono-tabular text-xs">
                  <span className="text-[11px] text-neutral-400">Weapon Stats:</span>
                  {match.weaponStats.length > 0 ? (
                    match.weaponStats.map((w, idx) => (
                      <React.Fragment key={w.weaponId}>
                        {idx > 0 && (
                          <span className="text-neutral-600" aria-hidden="true">·</span>
                        )}
                        <span className="text-neutral-200">
                          {w.weaponName}{' '}
                          <span className={`font-semibold ${headingAccent}`}>×{w.kills}</span>
                        </span>
                      </React.Fragment>
                    ))
                  ) : (
                    <span className="text-neutral-500">No weapon eliminations recorded</span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

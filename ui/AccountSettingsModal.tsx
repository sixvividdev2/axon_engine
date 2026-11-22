import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, LogOut, RotateCcw, Shield, UserCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  formatRankLabel,
  getRankTitleInfo,
  MAX_PRESTIGE,
  MAX_RANK,
  WEAPON_UNLOCK_RANK,
  xpRequiredForNextPrestige,
  xpRequiredForNextRank,
} from '../data/progression';
import { ApiError } from '../services/authApi';

const RESET_COUNTDOWN_SEC = 5;

export const AccountSettingsModal: React.FC = () => {
  const {
    user,
    accountSettingsOpen,
    closeAccountSettings,
    changeUsername,
    resetProgress,
    logout,
    unlockedAttachmentSet,
  } = useAuth();

  const [newUsername, setNewUsername] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [usernameSuccess, setUsernameSuccess] = useState<string | null>(null);

  // Reset Account 5-second countdown gate state
  const [resetGateOpen, setResetGateOpen] = useState(false);
  const [countdown, setCountdown] = useState(RESET_COUNTDOWN_SEC);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  useEffect(() => {
    if (accountSettingsOpen && user) {
      setNewUsername(user.username);
      setUsernameError(null);
      setUsernameSuccess(null);
      setResetNotice(null);
    }
  }, [accountSettingsOpen, user]);

  useEffect(() => {
    if (!resetGateOpen) return;
    setCountdown(RESET_COUNTDOWN_SEC);
    setResetError(null);
    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resetGateOpen]);

  const unlockedWeaponsCount = useMemo(() => {
    if (!user) return 0;
    const seen = new Set<string>();
    for (const [wid, req] of Object.entries(WEAPON_UNLOCK_RANK)) {
      if (
        wid === 'pm_9x19' ||
        wid === 'm4_556' ||
        wid === 'mp133_12ga' ||
        wid === 'aks74u_545' ||
        wid === 'ak74u_545'
      ) {
        continue;
      }
      if (user.rank >= req) seen.add(wid);
    }
    return seen.size;
  }, [user]);

  if (!accountSettingsOpen || !user) return null;

  const rankInfo = getRankTitleInfo(user.rank);
  const isVeteran = user.rank >= MAX_RANK;
  const currentXp = isVeteran ? user.prestigeXp : user.xp;
  const nextXp = isVeteran
    ? xpRequiredForNextPrestige(user.prestige)
    : xpRequiredForNextRank(user.rank);
  const xpPct = Math.max(0, Math.min(100, (currentXp / Math.max(1, nextXp)) * 100));
  const kdRatio =
    user.deaths > 0 ? (user.kills / user.deaths).toFixed(2) : user.kills.toFixed(2);

  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setUsernameError(null);
    setUsernameSuccess(null);
    const trimmed = newUsername.trim();
    if (!trimmed) {
      setUsernameError('Enter a username.');
      return;
    }
    setUsernameSaving(true);
    try {
      await changeUsername(trimmed);
      setUsernameSuccess('Username updated.');
    } catch (err) {
      setUsernameError(err instanceof ApiError ? err.message : 'Unable to update username.');
    } finally {
      setUsernameSaving(false);
    }
  };

  const handleConfirmReset = async () => {
    if (countdown > 0 || resetting) return;
    setResetting(true);
    setResetError(null);
    try {
      await resetProgress();
      setResetGateOpen(false);
      setResetNotice('Account progress reset to Rank 1 (Private). Your account and username were kept.');
    } catch (err) {
      setResetError(err instanceof ApiError ? err.message : 'Failed to reset account progress.');
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/82 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-settings-title"
    >
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl">
        {/* Top Bar */}
        <div className="flex items-start justify-between border-b border-neutral-800 px-6 py-4">
          <div>
            <div className="font-mono-tabular text-[11px] uppercase tracking-[0.18em] text-amber-400">
              Account Settings &amp; Career Dossier
            </div>
            <h2
              id="account-settings-title"
              className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50"
            >
              {user.username}
            </h2>
            <div className="mt-0.5 font-mono-tabular text-xs text-neutral-400">
              {user.email} · {formatRankLabel(user.rank, user.prestige)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void logout()}
              className="flex cursor-pointer items-center gap-1.5 border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </button>
            <button
              type="button"
              onClick={closeAccountSettings}
              aria-label="Close account settings"
              className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex flex-col gap-6 overflow-y-auto px-6 py-5">
          {resetNotice && (
            <div className="border border-amber-500/60 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
              {resetNotice}
            </div>
          )}

          {/* Career Rank & Prestige Card */}
          <section className="border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <div
                  className="flex h-12 w-12 items-center justify-center border bg-neutral-950 font-display text-xl font-bold"
                  style={{ borderColor: rankInfo.accentHex, color: rankInfo.accentHex }}
                >
                  {user.rank}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Shield className="h-3.5 w-3.5" style={{ color: rankInfo.accentHex }} />
                    <span className="font-display text-lg font-bold uppercase tracking-wide text-neutral-50">
                      {rankInfo.title}
                    </span>
                    {isVeteran && (
                      <span className="font-mono-tabular text-xs text-sky-300">
                        · Prestige {user.prestige} / {MAX_PRESTIGE}
                      </span>
                    )}
                  </div>
                  <div className="font-mono-tabular text-xs text-neutral-400">
                    {isVeteran
                      ? user.prestige >= MAX_PRESTIGE
                        ? 'Maximum Prestige Achieved'
                        : `Prestige ${user.prestige + 1} Progress`
                      : `Next Rank: ${user.rank + 1}`}
                  </div>
                </div>
              </div>
              <div className="text-right font-mono-tabular text-xs">
                <div className="text-neutral-200">
                  {currentXp.toLocaleString()} / {nextXp.toLocaleString()} XP
                </div>
                <div className="text-amber-300">${user.cash.toLocaleString()} Cash</div>
              </div>
            </div>

            <div className="mt-3.5 h-2 w-full overflow-hidden bg-neutral-950">
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: `${xpPct.toFixed(1)}%`,
                  backgroundColor: isVeteran ? '#38BDF8' : rankInfo.accentHex,
                }}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-neutral-800/80 pt-3.5 font-mono-tabular text-xs sm:grid-cols-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">Kills / Deaths</div>
                <div className="mt-0.5 text-neutral-100">
                  {user.kills} / {user.deaths} ({kdRatio})
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">Wins / Losses</div>
                <div className="mt-0.5 text-neutral-100">
                  {user.wins}W · {user.losses}L
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">Arsenal Unlocked</div>
                <div className="mt-0.5 text-neutral-100">{unlockedWeaponsCount} / 42 Firearms</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-500">Global Attachments</div>
                <div className="mt-0.5 text-neutral-100">{unlockedAttachmentSet.size} Unlocked</div>
              </div>
            </div>
          </section>

          {/* Reset / Change Username */}
          <section className="border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-amber-400" />
              <h3 className="font-display text-base font-bold uppercase tracking-wide text-neutral-100">
                Change Username
              </h3>
            </div>
            <p className="mt-1 text-xs text-neutral-400">
              Update your callsign across lobbies, leaderboards, and friends lists. Existing account names cannot be reused.
            </p>

            <form onSubmit={handleUsernameSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                minLength={3}
                maxLength={20}
                required
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                aria-label="New username"
                className="flex-1 border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono-tabular text-sm text-neutral-100 focus:border-amber-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={usernameSaving || newUsername.trim() === user.username}
                className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-5 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {usernameSaving ? 'Saving...' : 'Save Username'}
              </button>
            </form>

            {usernameError && (
              <div className="mt-2 text-xs text-red-400">{usernameError}</div>
            )}
            {usernameSuccess && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>{usernameSuccess}</span>
              </div>
            )}
          </section>

          {/* Danger Zone: Reset Account Progress */}
          <section className="border border-red-900/70 bg-red-950/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-red-400">
                  <RotateCcw className="h-4 w-4" />
                  <h3 className="font-display text-base font-bold uppercase tracking-wide">
                    Reset Account Progress
                  </h3>
                </div>
                <p className="mt-1 max-w-lg text-xs leading-relaxed text-neutral-300">
                  Wipes all rank, prestige, weapon XP, weapon &amp; attachment unlocks, cash, and stats back to a fresh Rank 1 profile without deleting your account or username.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setResetGateOpen(true)}
                className="cursor-pointer whitespace-nowrap shrink-0 border border-red-600 bg-red-950/80 px-4 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-red-100 transition-colors hover:bg-red-700"
              >
                Reset Account
              </button>
            </div>
          </section>
        </div>

        {/* 5-Second Countdown Confirmation Gate */}
        {resetGateOpen && (
          <div
            className="fixed inset-0 z-60 flex items-center justify-center bg-black/88 px-4 backdrop-blur-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
          >
            <div className="w-full max-w-md border border-red-700 bg-neutral-950 p-6 text-neutral-100 shadow-2xl">
              <div className="flex items-center gap-2.5 text-red-400">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <h3
                  id="reset-confirm-title"
                  className="font-display text-xl font-bold uppercase tracking-wide"
                >
                  Are You Sure?
                </h3>
              </div>

              <p className="mt-3 text-sm leading-relaxed text-neutral-300">
                Resetting your account permanently erases ALL progression and cannot be undone. You will lose:
              </p>

              <ul className="mt-3 space-y-1.5 border-y border-neutral-800 py-3 font-mono-tabular text-xs text-red-200">
                <li>· Career Rank ({user.rank}) &amp; Prestige ({user.prestige}) reset to Rank 1 (Private)</li>
                <li>· All Rank XP, Prestige XP, and Per-Gun XP / Gun Levels</li>
                <li>· All unlocked weapons (reverted to Rank 1 starter loadout)</li>
                <li>· All globally unlocked attachments (reverted to starter Mosin scope)</li>
                <li>· Cash (${user.cash.toLocaleString()}), Kills, Deaths, Wins, Losses &amp; Records</li>
              </ul>

              <p className="mt-3 text-xs text-neutral-400">
                Your account login, email, and username (<span className="text-neutral-200">{user.username}</span>) will remain active.
              </p>

              {resetError && (
                <div className="mt-3 border border-red-700 bg-red-950/70 px-3 py-2 text-xs text-red-200">
                  {resetError}
                </div>
              )}

              <div className="mt-5 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  disabled={resetting}
                  onClick={() => setResetGateOpen(false)}
                  className="cursor-pointer border border-neutral-700 bg-neutral-900 px-4 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider text-neutral-200 transition-colors hover:border-neutral-500"
                >
                  No, Cancel
                </button>
                <button
                  type="button"
                  disabled={countdown > 0 || resetting}
                  onClick={() => void handleConfirmReset()}
                  className={`px-4 py-2 font-mono-tabular text-xs font-semibold uppercase tracking-wider transition-colors ${
                    countdown > 0 || resetting
                      ? 'cursor-not-allowed border border-red-900/60 bg-red-950/40 text-red-400/70'
                      : 'cursor-pointer border border-red-500 bg-red-600 text-white hover:bg-red-500'
                  }`}
                >
                  {resetting
                    ? 'Resetting...'
                    : countdown > 0
                      ? `Yes, Reset (${countdown}s)`
                      : 'Yes, Reset Everything'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

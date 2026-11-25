import React, { useEffect, useState } from 'react';
import { WEAPONS } from '../data/weapons';
import { GameSnapshot } from '../engine/types';
import { HeartRateIndicator } from './HeartRateIndicator';

interface HudOverlayProps {
  snapshot: GameSnapshot;
  onRequestLock: () => void;
  onOpenTuner: () => void;
}

function formatBodycamTime(startMs: number, playtimeSec: number): string {
  const d = new Date(startMs + playtimeSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const HudOverlay: React.FC<HudOverlayProps> = ({
  snapshot,
  onRequestLock,
  onOpenTuner,
}) => {
  const [nowMs, setNowMs] = useState(() => performance.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(performance.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const showMagCheck =
    snapshot.magCheckReadout && nowMs < snapshot.magCheckReadout.expiresAtMs;
  const activeSpec = WEAPONS[snapshot.equippedWeaponId];
  const fragCount = snapshot.inventory
    .filter((i) => i.itemId === 'weapon_rgd5_frag')
    .reduce((acc, i) => acc + i.quantity, 0);

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between p-5">
      {/* Top Bar: Minimal AXON REC timestamp & live biometric ECG telemetry */}
      <div className="flex items-start justify-between">
        <div />
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-3 text-xs tracking-wider text-neutral-200/90 font-mono-tabular drop-shadow-[0_1px_2px_rgba(0,0,0,0.95)]">
            <span className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-xs bg-red-600" />
              <span>AXON REC</span>
            </span>
            <span className="text-neutral-400">
              {formatBodycamTime(snapshot.recordingStartMs, snapshot.playtimeSec)}
            </span>
          </div>
          <HeartRateIndicator
            bpm={snapshot.vitals.heartRateBpm}
            stress={snapshot.vitals.heartStress}
            holdBreath={snapshot.vitals.holdBreathActive}
            bleeding={snapshot.bleeding}
          />
        </div>
      </div>

      {/* Center Minimalist [F] Interaction Dot (no text clutter, no crosshair) */}
      <div className="pointer-events-none fixed inset-0 flex items-center justify-center">
        {snapshot.mode === 'playing' && snapshot.interactionDotVisible && !snapshot.repairPromptLabel && (
          <div className="flex items-center gap-1.5 text-[11px] font-mono-tabular text-neutral-100/90">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="rounded-xs bg-neutral-950/75 px-1.5 py-0.5 border border-white/15">
              F
            </span>
          </div>
        )}

        {snapshot.mode === 'playing' && snapshot.pointerLocked && snapshot.repairPromptLabel && (
          <div className="mt-16 flex flex-col items-center gap-1.5">
            <div className="border border-amber-400/50 bg-neutral-950/85 px-2.5 py-1 text-[11px] font-mono-tabular uppercase tracking-wider text-amber-200">
              {snapshot.repairPromptLabel}
            </div>
            {(snapshot.repairProgress ?? 0) > 0 && (
              <div className="h-1.5 w-40 overflow-hidden bg-neutral-950/90 border border-amber-500/40">
                <div
                  className="h-full bg-amber-400 transition-[width] duration-75"
                  style={{ width: `${Math.round((snapshot.repairProgress ?? 0) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {snapshot.mode === 'playing' && !snapshot.pointerLocked && !snapshot.tunerOpen && (
          <button
            type="button"
            onClick={onRequestLock}
            className="pointer-events-auto rounded border border-white/20 bg-neutral-950/90 px-4 py-2 text-xs font-medium tracking-wide text-neutral-200 hover:bg-neutral-900 transition-colors cursor-pointer"
          >
            Click viewport to engage bodycam
          </button>
        )}

        {snapshot.mode === 'playing' && snapshot.pointerLocked && snapshot.standBlockedByCeiling && (
          <div className="mt-20 border border-amber-500/40 bg-neutral-950/80 px-2.5 py-1 text-[10px] font-mono-tabular uppercase tracking-wider text-amber-300">
            Overhead Clearance Blocked · Crouch Locked
          </div>
        )}
      </div>

      {/* Bottom area: minimal quick-slot strip, transient Mag Check readout (1.2s) & subtle toast */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col items-start gap-2">
          {snapshot.activeMagPack && (
            <span className="text-xs font-mono-tabular text-amber-300/95 bg-neutral-950/85 px-2.5 py-1 border border-amber-500/35">
              {snapshot.activeMagPack.mode === 'pack' ? 'Packing' : 'Unloading'}{' '}
              {snapshot.activeMagPack.label} ({snapshot.activeMagPack.currentRounds}/{snapshot.activeMagPack.capacity})
            </span>
          )}
          {snapshot.toastMessage && (
            <span className="text-xs font-mono-tabular text-neutral-300/90 bg-neutral-950/80 px-2.5 py-1 border border-white/10">
              {snapshot.toastMessage}
            </span>
          )}
          {snapshot.mode === 'playing' && snapshot.throwableStatusLabel && (
            <span
              className={`px-2.5 py-1 border font-mono-tabular text-[11px] uppercase tracking-wider ${
                snapshot.throwableLiveFuse
                  ? 'animate-pulse border-red-500/85 bg-red-950/75 text-red-200'
                  : 'border-amber-400/75 bg-neutral-950/90 text-amber-200'
              }`}
            >
              {snapshot.throwableStatusLabel}
            </span>
          )}
          {snapshot.mode === 'playing' && (
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono-tabular text-neutral-400">
              {(
                [
                  { key: '1', kind: 'primary', label: 'Primary' },
                  { key: '2', kind: 'sidearm', label: 'Sidearm' },
                  { key: '3', kind: 'melee', label: 'Melee' },
                  {
                    key: '4',
                    kind: 'throwable',
                    label: snapshot.equippedWeaponId === 'rgd5_frag' ? `Frag (${fragCount})` : 'Frag/Bolt',
                  },
                  { key: '0', kind: 'unarmed', label: 'Unarmed' },
                ] as const
              ).map((slot) => {
                const isActive = activeSpec?.slotKind === slot.kind;
                return (
                  <span
                    key={slot.key}
                    className={`px-1.5 py-0.5 border ${
                      isActive
                        ? 'border-amber-500/60 bg-neutral-950/90 text-amber-300'
                        : 'border-white/10 bg-neutral-950/60 text-neutral-400'
                    }`}
                  >
                    [{slot.key}] {slot.label}
                  </span>
                );
              })}
              {snapshot.armedAdsMode === 'POINT_AIM' && (
                <span className="px-1.5 py-0.5 border border-sky-400/60 bg-sky-500/15 text-sky-300 font-semibold">
                  PT-AIM
                </span>
              )}
              {snapshot.armedAdsMode === 'CANTED' && (
                <span className="px-1.5 py-0.5 border border-amber-400/60 bg-amber-500/15 text-amber-300 font-semibold">
                  CANTED
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          {showMagCheck && snapshot.magCheckReadout && (
            <div className="text-sm font-mono-tabular tracking-wide text-amber-200/95 bg-neutral-950/80 px-3 py-1 border border-amber-500/30">
              {snapshot.magCheckReadout.text}
            </div>
          )}

          {snapshot.mode === 'playing' && (
            <button
              type="button"
              onClick={onOpenTuner}
              className="pointer-events-auto text-[11px] font-mono-tabular text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              Optics Tuner
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

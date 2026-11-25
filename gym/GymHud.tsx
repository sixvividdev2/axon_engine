import React from 'react';
import { TerminalOutcome } from '../bodycam-sdk';
import { HeartRateIndicator } from '../ui/HeartRateIndicator';
import { GymSnapshot } from './GymEngine';
import { GYM_ZONE_PRESETS, GymZoneId } from './GymWorld';
import { openGameSettings } from '../data/gameSettingsStore';

interface GymHudProps {
  snapshot: GymSnapshot;
  onRequestLock: () => void;
  onOpenTuner: () => void;
  onTeleportZone: (zone: GymZoneId) => void;
  onReturnToMenu: () => void;
}

function formatRecTimestamp(elapsedSec: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const fr = String(Math.floor((elapsedSec % 1) * 30)).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}:${fr} UTC`;
}

function outcomeStyle(outcome: TerminalOutcome): { label: string; badgeClass: string } {
  switch (outcome) {
    case 'ricochet':
      return {
        label: 'RICOCHET',
        badgeClass: 'border-amber-400/80 bg-amber-500/20 text-amber-200',
      };
    case 'fragment':
      return {
        label: 'FRAGMENT',
        badgeClass: 'border-orange-400/80 bg-orange-500/20 text-orange-200',
      };
    case 'penetrate':
      return {
        label: 'PENETRATED',
        badgeClass: 'border-emerald-400/80 bg-emerald-500/20 text-emerald-200',
      };
    case 'stop':
    default:
      return {
        label: 'STOPPED',
        badgeClass: 'border-neutral-600 bg-neutral-800/80 text-neutral-200',
      };
  }
}

export const GymHud: React.FC<GymHudProps> = ({
  snapshot,
  onRequestLock,
  onOpenTuner,
  onTeleportZone,
  onReturnToMenu,
}) => {
  const {
    config,
    telemetry,
    pointerLocked,
    tunerOpen,
    gunsmithOpen,
    lookingAtBench,
    lastHit,
    toastMessage,
  } = snapshot;

  const hitFresh = lastHit && performance.now() - lastHit.timestampMs < 4600;
  const presetBadge =
    config.lensPreset === 'gopro_chest'
      ? 'GOPRO // REC'
      : config.lensPreset === 'clean_raw'
        ? 'RAW // REC'
        : 'AXON // REC';

  const hitStyle = lastHit ? outcomeStyle(lastHit.outcome) : null;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 select-none">
      {/* Flashbang Concussive Whiteout Overlay */}
      {snapshot.flashBlindAlpha > 0.01 && (
        <div
          className="pointer-events-none fixed inset-0 z-40 bg-sky-50"
          style={{ opacity: Math.min(0.96, snapshot.flashBlindAlpha) }}
        />
      )}

      {/* Authentic 4-Stage Grenade Manual of Arms Prompt (Zero HUD power/cook bar) */}
      {snapshot.grenadeHoldStage !== 'HOLSTERED' && !gunsmithOpen && (
        <div
          className={`pointer-events-none fixed top-[58%] left-1/2 z-30 w-80 -translate-x-1/2 border px-3 py-1.5 font-mono-tabular ${
            snapshot.grenadeHoldStage === 'LEVER_RELEASED'
              ? 'animate-pulse border-red-500/90 bg-red-950/60'
              : snapshot.grenadeHoldStage === 'PIN_PULLED'
                ? 'border-amber-400/85 bg-neutral-950/92'
                : 'border-neutral-600/90 bg-neutral-950/90'
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider">
            <span
              className={
                snapshot.grenadeHoldStage === 'LEVER_RELEASED'
                  ? 'font-semibold text-red-300'
                  : snapshot.grenadeHoldStage === 'PIN_PULLED'
                    ? 'font-semibold text-amber-300'
                    : 'font-semibold text-neutral-100'
              }
            >
              {snapshot.tacticalEquipmentShortName}
              {snapshot.grenadeHoldStage === 'DRAWN'
                ? ' · READY'
                : snapshot.grenadeHoldStage === 'PIN_PULLED'
                  ? ' · PIN PULLED'
                  : ' · LIVE FUSE'}
            </span>
            <span className="text-neutral-200">
              {snapshot.grenadeHoldStage === 'DRAWN'
                ? 'RMB PIN · [H] STOW'
                : snapshot.grenadeHoldStage === 'PIN_PULLED'
                  ? 'RMB SPOON · LMB LOB/HOLD'
                  : snapshot.grenadeThrowHeld && snapshot.grenadeThrowStyle === 'overhand'
                    ? 'REL LMB OVERHAND'
                    : 'LMB LOB / HOLD'}
            </span>
          </div>
          {snapshot.grenadeHoldStage === 'PIN_PULLED' && (
            <div className="mt-1 text-[9px] uppercase tracking-wider text-neutral-300">
              {snapshot.grenadeThrowHeld
                ? `Charging ${snapshot.grenadeThrowStyle === 'overhand' ? 'OVERHAND' : 'LOB'} — Release LMB`
                : 'Safety lever gripped — chemical delay NOT burning'}
            </div>
          )}
          {snapshot.grenadeHoldStage === 'LEVER_RELEASED' && (
            <div className="mt-1 text-[9px] uppercase tracking-wider text-red-200">
              {snapshot.grenadeThrowHeld
                ? `LIVE FUSE — Charging ${snapshot.grenadeThrowStyle === 'overhand' ? 'OVERHAND' : 'LOB'} — Release LMB`
                : 'Spoon detached — chemical delay burning'}
            </div>
          )}
        </div>
      )}

      {/* Diegetic Bodycam Recording Overlay (Toggleable in F1 Optics Tuner) */}
      {config.showRecOverlay && !gunsmithOpen && (
        <div
          className="fixed top-4 right-5 flex flex-col items-end font-mono-tabular text-[11px] leading-tight tracking-wider text-neutral-100/90"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-red-600" />
            <span className="font-semibold text-neutral-50">{presetBadge}</span>
            <span className="text-neutral-300/80">X6039A842</span>
          </div>
          <div className="mt-0.5 text-[10px] text-neutral-200/80">
            {formatRecTimestamp(snapshot.recordingElapsedSec)}
          </div>
          <div className="mt-1.5">
            <HeartRateIndicator
              bpm={snapshot.heartRateBpm}
              stress={snapshot.heartStress}
              holdBreath={snapshot.holdBreathActive}
              bleeding={snapshot.simulatedArmTrauma}
            />
          </div>
        </div>
      )}

      {/* Subtle Overhead Clearance Lock Cue (only visible when trying to stand inside crouch tunnel) */}
      {pointerLocked && !gunsmithOpen && telemetry.standBlockedByCeiling && (
        <div className="fixed top-14 left-1/2 -translate-x-1/2 border border-amber-500/70 bg-neutral-950/90 px-3 py-1 font-mono-tabular text-[11px] font-medium uppercase tracking-widest text-amber-300">
          Overhead Clearance Blocked · Crouch Locked
        </div>
      )}

      {/* Gunsmithing Bench / Broken Electronic Repair Prompt */}
      {pointerLocked && !gunsmithOpen && (lookingAtBench || snapshot.repairPromptLabel) && (
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 translate-y-12 border border-amber-400/80 bg-neutral-950/92 px-4 py-1.5 font-mono-tabular text-xs font-medium uppercase tracking-wider text-amber-200">
          <div>{lookingAtBench ? '[F] Open Gunsmithing Bench' : snapshot.repairPromptLabel}</div>
          {!lookingAtBench && snapshot.repairProgress > 0 && (
            <div className="mt-1.5 h-1 w-full overflow-hidden bg-neutral-800">
              <div
                className="h-full bg-amber-400 transition-[width] duration-75"
                style={{ width: `${Math.round(snapshot.repairProgress * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Transient Terminal Ballistics Range Telemetry */}
      {pointerLocked && !gunsmithOpen && hitFresh && lastHit && hitStyle && (
        <div className="fixed top-5 left-5 border-l-2 border-amber-400 bg-neutral-950/85 px-3 py-2 font-mono-tabular text-xs text-neutral-100">
          <div className="flex items-center gap-2">
            <span className={`border px-1.5 py-0.5 text-[10px] font-semibold ${hitStyle.badgeClass}`}>
              {hitStyle.label}
              {lastHit.outcome === 'penetrate' && lastHit.penetrationThicknessM > 0
                ? ` · ${Math.round(lastHit.penetrationThicknessM * 1000)}mm`
                : lastHit.outcome === 'ricochet'
                  ? ` · ${lastHit.grazingAngleDeg.toFixed(1)}°`
                  : ''}
            </span>
            <span className="font-semibold text-amber-300">{lastHit.targetLabel}</span>
            <span className="text-neutral-400">·</span>
            <span>{lastHit.distanceM.toFixed(1)}m</span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-300">
            {lastHit.ammoLabel} ({lastHit.caliberLabel}) · {lastHit.material.toUpperCase()} ·{' '}
            {Math.round(lastHit.impactSpeedMps)} m/s · {Math.round(lastHit.energyJoules)} J
          </div>
        </div>
      )}

      {/* Transient Action / Mode Toast */}
      {toastMessage && !gunsmithOpen && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 border border-neutral-700/80 bg-neutral-950/90 px-3.5 py-1.5 font-mono-tabular text-xs text-neutral-100">
          {toastMessage}
        </div>
      )}

      {/* Minimal Bottom Reference Strip when active */}
      {pointerLocked && !gunsmithOpen && (
        <div
          className="fixed bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-300/75"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
        >
          <span className="text-neutral-100">{snapshot.equippedWeaponName}</span>
          <span className="text-sky-300">{snapshot.ammoVariantLabel}</span>
          <span className="text-emerald-300/90">
            ZERO {snapshot.zeroDistanceM}m
            {snapshot.zeroElevationMrad !== 0
              ? ` ${snapshot.zeroElevationMrad > 0 ? '+' : ''}${snapshot.zeroElevationMrad.toFixed(1)}`
              : ''}
          </span>
          {snapshot.isSubsonic && <span className="text-emerald-300">SUB</span>}
          {snapshot.isBoltCycling && <span className="text-amber-300">BOLT</span>}
          {snapshot.isMagnifiedOptic && (
            <span className="text-amber-300">
              {snapshot.activeOpticZoom.toFixed(1)}x {snapshot.reticleIlluminated ? 'ILLUM' : 'ETCHED'}
            </span>
          )}
          {snapshot.armedAdsMode === 'POINT_AIM' && (
            <span className="border border-sky-400/60 bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300">
              PT-AIM
            </span>
          )}
          {snapshot.armedAdsMode === 'CANTED' && (
            <span className="border border-amber-400/60 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
              CANTED
            </span>
          )}
          <span className="text-neutral-400">
            {snapshot.ammoInMag}/{snapshot.magCapacity}
          </span>
          <span className="text-neutral-600">|</span>
          <span className={snapshot.grenadeCount > 0 ? 'text-amber-300' : 'text-red-400'}>
            {snapshot.tacticalEquipmentShortName} {snapshot.grenadeCount}/{snapshot.grenadeMax}
          </span>
          {snapshot.nvgMount !== 'none' && (
            <>
              <span className="text-neutral-600">|</span>
              <span
                className={
                  snapshot.nvgActive
                    ? snapshot.nvgMount === 'arnvg'
                      ? 'font-semibold text-sky-300'
                      : 'font-semibold text-emerald-300'
                    : 'text-neutral-400'
                }
              >
                {snapshot.nvgMount === 'arnvg' ? 'RNVG-A P45' : 'PVS-7 P43'}
                {snapshot.nvgActive ? (snapshot.irIlluminatorOn ? ' · IR ON' : ' · ON') : ''}
              </span>
            </>
          )}
          {snapshot.toggleablePumpSemi && (
            <>
              <span className="text-neutral-600">|</span>
              <span className="text-amber-300">
                {snapshot.spas12Mode === 'semi' ? 'Semi-Auto' : 'Pump-Action'}
              </span>
            </>
          )}
        </div>
      )}

      {/* Clean Unlocked Entry / Pause Overlay (no full-screen blur wall — keeps live 3D gym visible) */}
      {!pointerLocked && !tunerOpen && !gunsmithOpen && (
        <div className="pointer-events-auto fixed inset-0 flex flex-col justify-between p-6">
          {/* Top-left facility title */}
          <div className="max-w-md border border-neutral-800 bg-neutral-950/90 px-4 py-3 text-neutral-100">
            <div className="font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-amber-400">
              Portable Bodycam SDK · Range &amp; Gunsmith
            </div>
            <h1 className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50">
              PLAYGROUND
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-neutral-300">
              Test grounded tactical vaulting &amp; high mantling, 42 military-simulation firearms,
              44+ coupled ammo cartridges, grazing ricochet, fragmentation &amp; cover penetration,
              bolt-action cycling IK, modular gunsmithing, HDR darkroom flare, and chest-mic acoustics.
            </p>
          </div>

          {/* Center-bottom action deck */}
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 border border-neutral-800 bg-neutral-950/92 p-4 text-neutral-100">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onRequestLock}
                  className="cursor-pointer whitespace-nowrap shrink-0 bg-amber-500 px-5 py-2 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
                >
                  Enter Playground
                </button>
                <button
                  type="button"
                  onClick={onOpenTuner}
                  className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-900 px-4 py-2 font-mono-tabular text-xs font-medium uppercase tracking-wider text-neutral-100 transition-colors hover:border-amber-400/70 hover:text-amber-300"
                >
                  F1 · Armory &amp; SDK Tuner
                </button>
                <button
                  type="button"
                  onClick={() => openGameSettings('controls')}
                  className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-900 px-4 py-2 font-mono-tabular text-xs font-medium uppercase tracking-wider text-neutral-100 transition-colors hover:border-amber-400/70 hover:text-amber-300"
                >
                  Settings &amp; Controls
                </button>
              </div>
              <button
                type="button"
                onClick={onReturnToMenu}
                className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700/80 bg-neutral-900/90 px-3.5 py-2 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-50"
              >
                Return to Main Menu
              </button>
            </div>

            {/* Quick-jump calibration bays */}
            <div className="flex flex-wrap items-center gap-1.5 border-t border-neutral-800 pt-2.5">
              <span className="mr-1 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Jump to Bay:
              </span>
              {GYM_ZONE_PRESETS.map((z) => (
                <button
                  key={z.id}
                  type="button"
                  onClick={() => {
                    onTeleportZone(z.id);
                    onRequestLock();
                  }}
                  className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-800 bg-neutral-900 px-2.5 py-1 font-mono-tabular text-[11px] text-neutral-200 transition-colors hover:border-amber-500/70 hover:text-amber-300"
                >
                  {z.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

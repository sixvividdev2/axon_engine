import React from 'react';
import {
  Crosshair,
  Laptop,
  Shield,
  Sliders,
  User,
  Users,
  Volume2,
  Wrench,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSocial } from '../context/SocialContext';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  GraphicsQualityId,
  useAdaptiveScaling,
  useGraphicsQuality,
} from '../data/graphicsQuality';
import { HubTabId } from '../ui/MainMenuHub';
import { OpsLaptopTabId } from './HideoutOpsLaptopModal';
import { HideoutSnapshot } from './HideoutSessionController';
import { PMC_FACTIONS, useHideoutShardAdapter } from '../src/modes/openworld';

interface HideoutHudProps {
  snapshot: HideoutSnapshot;
  modalOpen: boolean;
  onRequestLock: () => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onOpenOpsLaptop: (tab?: OpsLaptopTabId) => void;
  onVolumeChange: (volume: number) => void;
  onGraphicsChange: (quality: GraphicsQualityId) => void;
  onOpenClassicHub: (tab: HubTabId) => void;
  onLaunchPlayground: () => void;
}

/**
 * Minimal diegetic Hideout HUD & ESC Pause Overlay.
 * Follows zero viewport occlusion, zero backdrop-filter over WebGL,
 * zero static pill clutter, and zero pulsing status dots.
 */
export const HideoutHud: React.FC<HideoutHudProps> = ({
  snapshot,
  modalOpen,
  onRequestLock,
  onOpenGunsmith,
  onOpenOperatorGear,
  onOpenOpsLaptop,
  onVolumeChange,
  onGraphicsChange,
  onOpenClassicHub,
  onLaunchPlayground,
}) => {
  const { user, openAuthModal, openAccountSettings } = useAuth();
  const { openDrawer: openSocialDrawer, incomingRequests } = useSocial();
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const [adaptiveScaling, setAdaptiveScaling] = useAdaptiveScaling();
  const { activeCharacter, bankruptcy } = useHideoutShardAdapter();

  const showLiveHud = snapshot.pointerLocked && !snapshot.pauseOpen && !modalOpen;
  const showEntryPrompt = !snapshot.pointerLocked && !snapshot.pauseOpen && !modalOpen;
  const showPauseMenu = snapshot.pauseOpen && !modalOpen;

  return (
    <div className="pointer-events-none fixed inset-0 z-10 select-none">
      {/* Subtle top-left room location & active Perimeter Ops operator readout (clean unboxed typography) */}
      {!showPauseMenu && !modalOpen && (
        <div className="fixed left-6 top-5 flex flex-col gap-0.5 text-neutral-200/85">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-sm font-semibold tracking-wider text-neutral-100">
              {snapshot.currentRoomLabel}
            </span>
            <span className="text-xs text-neutral-500" aria-hidden="true">
              ·
            </span>
            <span className="font-mono-tabular text-xs text-neutral-400">
              {snapshot.fps} FPS
            </span>
          </div>
          {activeCharacter && (
            <div className="flex flex-wrap items-baseline gap-x-2 font-mono-tabular text-xs">
              <span className="font-semibold text-emerald-300">{activeCharacter.callsign}</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="text-neutral-300">{activeCharacter.shardMode}</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="text-neutral-400">
                {PMC_FACTIONS[activeCharacter.pmcFaction].name}
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="text-neutral-200">
                ${activeCharacter.cash.toLocaleString()}
              </span>
              {bankruptcy?.isBankruptcyRisk && (
                <>
                  <span className="text-neutral-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-semibold text-red-400">
                    BANKRUPTCY WARNING · MEDEVAC ${bankruptcy.nextRespawnFee.toLocaleString()}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Gun Range top-center course HUD & hit-zone confirmation (zero backdrop-filter, zero pills) */}
      {showLiveHud && (snapshot.currentRoomId === 'gun_range' || snapshot.gunRange.phase !== 'idle') && (
        <div className="fixed left-1/2 top-5 -translate-x-1/2 flex flex-col items-center gap-2">
          {snapshot.gunRange.phase === 'countdown' && (
            <div className="flex items-baseline gap-3 border border-amber-500/40 bg-[#0d0f12]/92 px-4 py-1.5 text-xs">
              <span className="font-display font-semibold tracking-wider text-amber-300">
                30s CQB Course
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="font-mono-tabular font-semibold text-neutral-100">
                Starting in {Math.max(1, Math.ceil(snapshot.gunRange.countdownSec))}
              </span>
            </div>
          )}

          {snapshot.gunRange.phase === 'active' && (
            <div className="flex items-baseline gap-3 border border-white/12 bg-[#0d0f12]/92 px-4 py-1.5 font-mono-tabular text-xs text-neutral-200">
              <span
                className={`font-semibold ${
                  snapshot.gunRange.timeRemainingSec <= 5.0
                    ? 'text-red-400'
                    : 'text-amber-300'
                }`}
              >
                {snapshot.gunRange.timeRemainingSec.toFixed(1)}s
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>
                Score <strong className="font-semibold text-neutral-50">{snapshot.gunRange.score}</strong>
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>
                Hits <strong className="font-semibold text-neutral-100">{snapshot.gunRange.hits}</strong>
                {snapshot.gunRange.headshots > 0 ? ` (${snapshot.gunRange.headshots} HS)` : ''}
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>Acc {snapshot.gunRange.accuracyPct}%</span>
              {snapshot.gunRange.streak >= 3 && (
                <>
                  <span className="text-neutral-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-amber-400">Streak x{snapshot.gunRange.streak}</span>
                </>
              )}
            </div>
          )}

          {snapshot.gunRange.phase === 'finished' && (
            <div className="flex items-baseline gap-3 border border-amber-500/35 bg-[#0d0f12]/92 px-4 py-1.5 font-mono-tabular text-xs text-neutral-200">
              <span className="font-display font-semibold tracking-wide text-amber-300">
                {snapshot.gunRange.isNewBest ? 'New Record' : 'Course Complete'}
              </span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="font-semibold text-neutral-50">{snapshot.gunRange.score} pts</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>{snapshot.gunRange.hits} hits</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>{snapshot.gunRange.accuracyPct}% acc</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="text-neutral-400">Best {snapshot.gunRange.bestScore}</span>
            </div>
          )}

          {snapshot.gunRange.phase === 'idle' &&
            snapshot.currentRoomId === 'gun_range' &&
            snapshot.longRange.inGalleryBay && (
              <div className="flex items-baseline gap-2.5 text-xs text-neutral-300/90">
                <span className="font-medium text-sky-300">100m Gallery</span>
                <span className="text-neutral-600" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono-tabular text-neutral-200">
                  Trolley {snapshot.longRange.trolleyDistanceM}m
                  {snapshot.longRange.trolleyMoving
                    ? ` → ${snapshot.longRange.trolleyTargetDistanceM}m`
                    : ''}
                </span>
                <span className="text-neutral-600" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono-tabular text-neutral-300">
                  Zero {snapshot.zeroDistanceM}m
                </span>
                {snapshot.longRange.lastChrono && (
                  <>
                    <span className="text-neutral-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono-tabular text-amber-300">
                      {snapshot.longRange.lastChrono.muzzleVelocityMs} m/s
                    </span>
                  </>
                )}
                {snapshot.longRange.groupSizeMoa !== null && (
                  <>
                    <span className="text-neutral-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono-tabular text-sky-300">
                      Group {snapshot.longRange.groupSizeMoa.toFixed(2)} MOA
                    </span>
                  </>
                )}
              </div>
            )}

          {snapshot.gunRange.phase === 'idle' &&
            snapshot.currentRoomId === 'gun_range' &&
            !snapshot.longRange.inGalleryBay && (
              <div className="flex items-baseline gap-2.5 text-xs text-neutral-300/85">
                <span className="font-medium text-amber-300/90">Live Fire Active</span>
                {snapshot.gunRange.bestScore > 0 && (
                  <>
                    <span className="text-neutral-600" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono-tabular text-neutral-300">
                      CQB Best {snapshot.gunRange.bestScore}
                    </span>
                  </>
                )}
                <span className="text-neutral-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-neutral-400">
                  Shoot Amber Paddle or Use Console [F] for 30s Course
                </span>
              </div>
            )}

          {/* Transient target impact confirmation tick (positioned cleanly above reticle/prompt) */}
          {snapshot.longRange.lastHit &&
          (!snapshot.gunRange.lastHit ||
            snapshot.longRange.lastHit.timestampMs >= snapshot.gunRange.lastHit.timestampMs) ? (
            <div
              className={`font-mono-tabular text-xs font-medium tracking-wide ${
                snapshot.longRange.lastHit.outcome === 'penetrate'
                  ? 'text-emerald-400'
                  : snapshot.longRange.lastHit.outcome === 'stop'
                    ? 'text-red-400'
                    : 'text-amber-300'
              }`}
            >
              {snapshot.longRange.lastHit.zoneLabel} · {snapshot.longRange.lastHit.distanceM}m ·{' '}
              {snapshot.longRange.lastHit.impactSpeedMs} m/s ·{' '}
              {snapshot.longRange.lastHit.impactEnergyJ} J
              {snapshot.longRange.lastHit.groupMoa !== null
                ? ` · ${snapshot.longRange.lastHit.groupMoa.toFixed(2)} MOA`
                : ''}
            </div>
          ) : (
            snapshot.gunRange.lastHit && (
              <div
                className={`font-mono-tabular text-xs font-medium tracking-wide ${
                  snapshot.gunRange.lastHit.isNoShoot
                    ? 'text-red-400'
                    : snapshot.gunRange.lastHit.zone === 'head' ||
                        snapshot.gunRange.lastHit.zone === 'gong' ||
                        snapshot.gunRange.lastHit.zone === 'paddle'
                      ? 'text-amber-300'
                      : 'text-neutral-100'
                }`}
              >
                {snapshot.gunRange.lastHit.zone === 'no_shoot'
                  ? `NO-SHOOT ${snapshot.gunRange.lastHit.scoreDelta}`
                  : snapshot.gunRange.lastHit.zone === 'paddle'
                    ? snapshot.gunRange.lastHit.label
                    : snapshot.gunRange.lastHit.zone === 'head'
                      ? `HEADSHOT +${snapshot.gunRange.lastHit.scoreDelta} · ${snapshot.gunRange.lastHit.distanceM}m`
                      : snapshot.gunRange.lastHit.zone === 'gong'
                        ? `STEEL GONG · ${snapshot.gunRange.lastHit.distanceM}m`
                        : snapshot.gunRange.lastHit.zone === 'a_zone'
                          ? `A-ZONE +${snapshot.gunRange.lastHit.scoreDelta} · ${snapshot.gunRange.lastHit.distanceM}m`
                          : `TORSO +${snapshot.gunRange.lastHit.scoreDelta} · ${snapshot.gunRange.lastHit.distanceM}m`}
              </div>
            )
          )}
        </div>
      )}

      {/* Subtle bottom-right equipped weapon readout when exploring */}
      {showLiveHud && (
        <div className="fixed bottom-5 right-6 text-right">
          <div className="font-display text-sm font-semibold tracking-wide text-neutral-100">
            {snapshot.grenadeDrawn ? snapshot.grenadeName : snapshot.equippedWeaponName}
          </div>
          {snapshot.grenadeDrawn ? (
            <div className="mt-0.5 flex items-center justify-end gap-2 font-mono-tabular text-xs text-neutral-400">
              <span className="text-amber-300">
                {snapshot.grenadeHoldStage === 'DRAWN'
                  ? 'RMB Pull Pin'
                  : snapshot.grenadeHoldStage === 'PIN_PULLED'
                    ? 'LMB Throw · RMB Spoon'
                    : 'LIVE FUSE · LMB Throw'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-neutral-200">{snapshot.grenadeCount} left</span>
            </div>
          ) : snapshot.equippedWeaponId !== 'unarmed' ? (
            <div className="mt-0.5 flex items-center justify-end gap-2 font-mono-tabular text-xs text-neutral-400">
              <span>{snapshot.activeAmmoLabel || snapshot.equippedCaliber}</span>
              <span aria-hidden="true">·</span>
              <span>Zero {snapshot.zeroDistanceM}m</span>
              {snapshot.hasVariableZoom && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-sky-300">{snapshot.activeOpticZoom.toFixed(1)}x</span>
                </>
              )}
              {snapshot.armedAdsMode !== 'PRIMARY' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-300">
                    {snapshot.armedAdsMode === 'POINT_AIM' ? 'Point Aim' : 'Canted Optic'}
                  </span>
                </>
              )}
              {snapshot.nvgActive && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-300">
                    {snapshot.irActive ? 'NVG + IR' : 'NVG'}
                  </span>
                </>
              )}
              {snapshot.fireModeLabel && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-neutral-300">{snapshot.fireModeLabel}</span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span className="text-amber-400">
                {snapshot.ammoInMag}/{snapshot.ammoReserve}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 flex items-center justify-end gap-2 font-mono-tabular text-xs text-neutral-400">
              <span>LMB Jab · RMB+LMB Hook</span>
              {snapshot.nvgActive && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-300">
                    {snapshot.irActive ? 'NVG + IR' : 'NVG'}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Compact bottom-center PDA controls hint strip when TAC-PDA is open */}
      {showLiveHud && snapshot.isPdaOpen && (
        <div
          className="fixed bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-2.5 whitespace-nowrap font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-300/80 lg:flex"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
        >
          <span className="text-emerald-300">TAC-PDA ACTIVE</span>
          <span>LMB+Drag Pan</span>
          <span>Wheel Zoom</span>
          <span>R / RMB Center</span>
          <span className="text-amber-300">M Stow PDA</span>
        </div>
      )}

      {/* Contextual interact dot (hidden by default; white when near, yellow when ready) + [F] Scroll menu */}
      {showLiveHud && !snapshot.isPdaOpen && snapshot.interactReticleState !== 'hidden' && (
        <div className="fixed inset-0 flex flex-col items-center justify-center">
          <div
            className={`h-1.5 w-1.5 rounded-full transition-transform duration-150 ${
              snapshot.interactReticleState === 'ready'
                ? 'scale-125 bg-amber-400'
                : 'bg-neutral-100/80'
            }`}
          />

          {snapshot.prompt && snapshot.prompt.options.length > 0 && (
            <div
              className="mt-5 min-w-[184px] border border-white/12 bg-[#0d0f12]/92 px-2.5 py-2"
              style={{ borderRadius: 4 }}
            >
              {snapshot.prompt.targetLabel && (
                <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-white/10 pb-1 text-[11px] font-medium tracking-wide text-neutral-400">
                  <span>{snapshot.prompt.targetLabel}</span>
                  {snapshot.prompt.options.length > 1 && (
                    <span className="font-mono-tabular text-[10px] text-neutral-500">Scroll</span>
                  )}
                </div>
              )}
              <div className="flex flex-col gap-1">
                {snapshot.prompt.options.map((opt, idx) => {
                  const selected = idx === snapshot.prompt!.selectedIndex;
                  return (
                    <div
                      key={opt.id}
                      className={`flex items-center justify-between gap-3 px-1.5 py-0.5 text-sm whitespace-nowrap transition-colors ${
                        selected
                          ? 'bg-amber-500/12 font-medium text-neutral-50'
                          : 'text-neutral-400'
                      }`}
                      style={{ borderRadius: 3 }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center">
                          {selected ? (
                            <kbd className="inline-flex h-5 min-w-5 items-center justify-center border border-amber-500/65 bg-amber-500/20 px-1 font-mono-tabular text-[11px] font-semibold text-amber-300">
                              {snapshot.prompt!.key}
                            </kbd>
                          ) : (
                            <span className="h-1 w-1 rounded-full bg-neutral-600" />
                          )}
                        </span>
                        <span>{opt.label}</span>
                      </div>
                      {opt.hint && (
                        <span
                          className={`text-[11px] ${
                            selected ? 'text-amber-300/85' : 'text-neutral-500'
                          }`}
                        >
                          {opt.hint}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compact status toast (Personal Stash, Resupply, Weapon Swap, Repair) */}
      {snapshot.toastMessage && !showPauseMenu && !modalOpen && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 border border-amber-500/35 bg-[#0e1013]/92 px-4 py-2 text-xs font-medium text-amber-100">
          {snapshot.toastMessage}
        </div>
      )}

      {/* Non-blocking initial spawn entry prompt (3D Arsenal Room remains 100% visible) */}
      {showEntryPrompt && (
        <div className="pointer-events-auto fixed bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onRequestLock}
            className="flex items-center gap-3 border border-amber-500/55 bg-[#101216]/94 px-6 py-3 text-sm font-semibold tracking-wide text-neutral-100 transition-colors hover:border-amber-400 hover:bg-[#16191f] whitespace-nowrap"
          >
            <Crosshair className="h-4 w-4 text-amber-400" />
            <span>Click to Enter Hideout</span>
          </button>
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <span>WASD Move</span>
            <span aria-hidden="true">·</span>
            <span>Q/E Lean</span>
            <span aria-hidden="true">·</span>
            <span>F + Scroll Interact</span>
            <span aria-hidden="true">·</span>
            <span>V Bash</span>
            <span aria-hidden="true">·</span>
            <span>X Kick</span>
            <span aria-hidden="true">·</span>
            <span>M PDA</span>
            <span aria-hidden="true">·</span>
            <span>Space / 2x Spin Vault</span>
            <span aria-hidden="true">·</span>
            <span>ESC Menu</span>
          </div>
        </div>
      )}

      {/* Minimal ESC Pause Overlay (solid surface, zero backdrop-filter) */}
      {showPauseMenu && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-[#07080a]/78 p-6">
          <div className="w-full max-w-md border border-white/12 bg-[#101216] p-6 text-neutral-100 shadow-2xl">
            <div className="flex items-baseline justify-between border-b border-white/10 pb-4">
              <div>
                <h2 className="font-display text-2xl font-semibold tracking-wide text-neutral-50">
                  Hideout Paused
                </h2>
                <p className="mt-0.5 text-xs text-neutral-400">
                  {snapshot.currentRoomLabel} · {snapshot.equippedWeaponName}
                </p>
              </div>
              <button
                type="button"
                onClick={onRequestLock}
                className="bg-amber-600 px-4 py-2 text-xs font-semibold text-neutral-950 transition-colors hover:bg-amber-500 whitespace-nowrap"
              >
                Resume
              </button>
            </div>

            {/* Hideout Stations */}
            <div className="mt-5 space-y-2">
              <div className="text-xs font-medium text-neutral-400">Hideout Stations</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onOpenOpsLaptop('perimeter')}
                  className="flex items-center justify-center gap-1.5 border border-emerald-500/40 bg-[#121e1b] px-2.5 py-2.5 text-xs font-medium text-emerald-100 transition-colors hover:border-emerald-400 hover:bg-[#172824] whitespace-nowrap"
                >
                  <User className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Perimeter Roster</span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenOpsLaptop('battle')}
                  className="flex items-center justify-center gap-1.5 border border-sky-500/35 bg-[#151c24] px-2.5 py-2.5 text-xs font-medium text-sky-100 transition-colors hover:border-sky-400 hover:bg-[#1b2430] whitespace-nowrap"
                >
                  <Laptop className="h-3.5 w-3.5 text-sky-400" />
                  <span>Ops Laptop</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenGunsmith}
                  className="flex items-center justify-center gap-1.5 border border-white/10 bg-[#171a20] px-2.5 py-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-500/50 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  <Wrench className="h-3.5 w-3.5 text-amber-400" />
                  <span>Gunsmith</span>
                </button>
                <button
                  type="button"
                  onClick={onOpenOperatorGear}
                  className="flex items-center justify-center gap-1.5 border border-white/10 bg-[#171a20] px-2.5 py-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-500/50 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  <Shield className="h-3.5 w-3.5 text-amber-400" />
                  <span>Operator</span>
                </button>
              </div>
            </div>

            {/* Quick Match Deployment & Training */}
            <div className="mt-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-400">Deploy &amp; Training</span>
                <button
                  type="button"
                  onClick={() => onOpenClassicHub('battle')}
                  className="text-[11px] text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-300 hover:underline whitespace-nowrap"
                >
                  Classic Menu Hub
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onOpenOpsLaptop('battle')}
                  className="border border-white/10 bg-[#171a20] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-500/50 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  Combat Ops
                </button>
                <button
                  type="button"
                  onClick={() => onOpenOpsLaptop('infection')}
                  className="border border-white/10 bg-[#171a20] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-red-500/45 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  Containment Ops
                </button>
                <button
                  type="button"
                  onClick={() => onOpenOpsLaptop('multiplayer')}
                  className="border border-white/10 bg-[#171a20] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-sky-400/50 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  Squads &amp; Lobbies
                </button>
                <button
                  type="button"
                  onClick={onLaunchPlayground}
                  className="border border-white/10 bg-[#171a20] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-white/25 hover:bg-[#1d2128] whitespace-nowrap"
                >
                  Calibration Gym
                </button>
              </div>
            </div>

            {/* Audio & Graphics Controls */}
            <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
              <div className="flex items-center justify-between gap-4">
                <label
                  htmlFor="hideout-master-vol"
                  className="flex items-center gap-2 text-xs font-medium text-neutral-300 whitespace-nowrap"
                >
                  <Volume2 className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Master Audio</span>
                </label>
                <div className="flex items-center gap-2.5">
                  <input
                    id="hideout-master-vol"
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(snapshot.masterVolume * 100)}
                    onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                    className="h-1.5 w-32 accent-amber-500"
                  />
                  <span className="w-9 text-right font-mono-tabular text-xs text-neutral-400">
                    {Math.round(snapshot.masterVolume * 100)}%
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-xs font-medium text-neutral-300 whitespace-nowrap">
                  <Sliders className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Graphics</span>
                </span>
                <div className="flex items-center gap-1 bg-[#171a20] p-0.5">
                  {GRAPHICS_QUALITY_ORDER.map((q) => {
                    const active = graphicsQuality === q;
                    return (
                      <button
                        key={q}
                        type="button"
                        onClick={() => {
                          setGraphicsQuality(q);
                          onGraphicsChange(q);
                        }}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                          active
                            ? 'bg-amber-600 text-neutral-950'
                            : 'text-neutral-400 hover:text-neutral-100'
                        }`}
                      >
                        {GRAPHICS_QUALITY_PROFILES[q].label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-neutral-400 whitespace-nowrap">
                  Adaptive Scaling
                </span>
                <button
                  type="button"
                  onClick={() => setAdaptiveScaling(!adaptiveScaling)}
                  className={`cursor-pointer border px-3 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    adaptiveScaling
                      ? 'border-sky-400/70 bg-sky-950/60 text-sky-200'
                      : 'border-white/10 bg-[#171a20] text-neutral-400 hover:text-neutral-100'
                  }`}
                  title="Automatically scale resolution when FPS drops (OFF by default)"
                >
                  {adaptiveScaling ? 'ON (Dynamic DPR)' : 'OFF (Fixed Native)'}
                </button>
              </div>
            </div>

            {/* Account & Social Footer Actions */}
            <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
              <button
                type="button"
                onClick={() => (user ? openAccountSettings() : openAuthModal())}
                className="flex items-center gap-2 text-xs font-medium text-neutral-300 transition-colors hover:text-neutral-100 whitespace-nowrap"
              >
                <User className="h-3.5 w-3.5 text-neutral-400" />
                <span>{user ? user.username : 'Sign In / Account'}</span>
              </button>
              <button
                type="button"
                onClick={() => openSocialDrawer()}
                className="flex items-center gap-2 text-xs font-medium text-neutral-300 transition-colors hover:text-neutral-100 whitespace-nowrap"
              >
                <Users className="h-3.5 w-3.5 text-neutral-400" />
                <span>
                  Social{incomingRequests.length > 0 ? ` (${incomingRequests.length})` : ''}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

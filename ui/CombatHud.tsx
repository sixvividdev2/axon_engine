import React from 'react';
import {
  BodycamLensPresetId,
  BodycamSDKConfig,
  LENS_PRESETS,
} from '../bodycam-sdk';
import { CombatSessionSnapshot } from '../combat/CombatSessionEngine';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  GraphicsQualityId,
  useGraphicsQuality,
} from '../data/graphicsQuality';
import {
  LobbyKillfeedPolicy,
  resolveEffectiveKillfeed,
  useKillfeedPreference,
} from '../data/killfeedSettings';
import {
  TACTICAL_BELT_SLOTS,
  TACTICAL_EQUIPMENT_LIST,
  TacticalBeltSlot,
  TacticalEquipmentId,
} from '../data/tacticalEquipment';
import { HeartRateIndicator } from './HeartRateIndicator';
import { KillfeedOverlay } from './KillfeedOverlay';

export interface MultiplayerHudControls {
  isHost: boolean;
  lobbyCode: string;
  eventName?: string | null;
  killfeedPolicy?: LobbyKillfeedPolicy;
  localPlayerName?: string;
  onHostUpdateKillfeedPolicy?: (policy: LobbyKillfeedPolicy) => void;
  onHostRestart: () => void;
  onHostEndToLobby: () => void;
  onLeaveMatch: () => void;
}

interface CombatHudProps {
  snapshot: CombatSessionSnapshot;
  multiplayerSession?: MultiplayerHudControls | null;
  onRequestLock: () => void;
  onToggleTuner: (open: boolean) => void;
  onUpdateConfig: (patch: Partial<BodycamSDKConfig>) => void;
  onApplyLensPreset: (preset: BodycamLensPresetId) => void;
  onSelectTacticalEquipment: (id: TacticalEquipmentId) => void;
  onSelectTacticalBeltSlot: (slot: TacticalBeltSlot) => void;
  onToggleTacticalMountOnBelt: (mount: boolean) => void;
  onRematch: () => void;
  onReturnToMenu: (tab?: 'battle' | 'infection') => void;
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

export const CombatHud: React.FC<CombatHudProps> = ({
  snapshot,
  multiplayerSession,
  onRequestLock,
  onToggleTuner,
  onUpdateConfig,
  onApplyLensPreset,
  onSelectTacticalEquipment,
  onSelectTacticalBeltSlot,
  onToggleTacticalMountOnBelt,
  onRematch,
  onReturnToMenu,
}) => {
  const isBattle = snapshot.mode === 'battle';
  const isInfection = snapshot.mode === 'infection';
  const [personalKillfeed, setPersonalKillfeed] = useKillfeedPreference();
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const effectiveKillfeed = resolveEffectiveKillfeed(
    personalKillfeed && snapshot.config.showKillfeed,
    multiplayerSession?.killfeedPolicy ?? null,
  );
  const hpRatio = Math.max(0, Math.min(1, snapshot.hp / Math.max(1, snapshot.maxHp)));
  const presetLabel =
    snapshot.config.lensPreset === 'gopro_chest'
      ? 'GOPRO REC'
      : snapshot.config.lensPreset === 'clean_raw'
        ? 'RAW REC'
        : 'AXON REC';

  const paused =
    !snapshot.pointerLocked &&
    !snapshot.tunerOpen &&
    !snapshot.gameOver &&
    snapshot.matchOutcome === 'active';

  return (
    <div className="pointer-events-none fixed inset-0 z-10 select-none">
      {/* Top-Left CSS-Animated Killfeed (Active in Battle & Infection; Host Override > Player Toggle) */}
      <KillfeedOverlay
        entries={snapshot.killfeed}
        enabled={effectiveKillfeed.enabled}
        localPlayerName={multiplayerSession?.localPlayerName ?? 'YOU'}
      />

      {/* Mid-Left Tactical Squad Radio Feed (Allied Bot Comms in Infection & Battle TDM) */}
      {snapshot.squadComms.length > 0 && (
        <div className="pointer-events-none fixed left-5 bottom-40 z-10 flex w-72 flex-col gap-1 font-mono-tabular">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
            SQUAD RADIO · VHF CH-04
          </div>
          {snapshot.squadComms.map((msg) => {
            const accent =
              msg.category === 'threat'
                ? 'border-l-red-500 text-red-300'
                : msg.category === 'economy'
                  ? 'border-l-amber-400 text-amber-200'
                  : msg.category === 'ack'
                    ? 'border-l-emerald-400 text-emerald-200'
                    : 'border-l-sky-400 text-sky-200';
            return (
              <div
                key={msg.id}
                className={`border border-neutral-800/80 border-l-2 bg-neutral-950/84 px-2 py-1 text-[10px] leading-snug ${accent}`}
              >
                <span className="mr-1.5 font-semibold uppercase tracking-wider">
                  [{msg.callsign}]
                </span>
                <span className="text-neutral-100">{msg.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* World-Projected Tactical Pings (Z Key · Auto-Detect Location / Enemy / Item · Distance Fade) */}
      {snapshot.tacticalPings.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
          {snapshot.tacticalPings.map((ping) => {
            const isEnemy = ping.kind === 'enemy';
            const isItem = ping.kind === 'item';
            const accentHex = isEnemy ? '#ef4444' : isItem ? '#f59e0b' : '#38bdf8';
            const textCls = isEnemy
              ? 'text-red-400'
              : isItem
                ? 'text-amber-300'
                : 'text-sky-300';
            const borderCls = isEnemy
              ? 'border-red-500/80 bg-neutral-950/88'
              : isItem
                ? 'border-amber-400/80 bg-neutral-950/88'
                : 'border-sky-400/80 bg-neutral-950/88';

            return (
              <div
                key={ping.id}
                className="fixed top-0 left-0 flex flex-col items-center font-mono-tabular will-change-transform"
                style={{
                  transform: `translate3d(${ping.screenX}vw, ${ping.screenY}vh, 0) translate(-50%, -100%) scale(${ping.scale})`,
                  opacity: ping.opacity,
                }}
              >
                {/* Compact Tactical Tag */}
                <div
                  className={`flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap ${borderCls}`}
                >
                  <span className={textCls}>{ping.label}</span>
                  <span className="text-neutral-200">{ping.distanceM}M</span>
                </div>
                {!ping.isLocal && (
                  <div
                    className="mt-0.5 text-[9px] uppercase tracking-wider text-neutral-300"
                    style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
                  >
                    {ping.senderName}
                  </div>
                )}
                {/* Crisp Geometric Tactical Icon */}
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  className="mt-0.5"
                  style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9))' }}
                >
                  {isEnemy ? (
                    <>
                      <polygon
                        points="12,2 22,12 12,22 2,12"
                        fill="rgba(127,29,29,0.55)"
                        stroke={accentHex}
                        strokeWidth="2"
                      />
                      <line x1="12" y1="7" x2="12" y2="17" stroke={accentHex} strokeWidth="1.6" />
                      <line x1="7" y1="12" x2="17" y2="12" stroke={accentHex} strokeWidth="1.6" />
                    </>
                  ) : isItem ? (
                    <>
                      <polygon
                        points="12,2 20.5,7 20.5,17 12,22 3.5,17 3.5,7"
                        fill="rgba(120,53,15,0.52)"
                        stroke={accentHex}
                        strokeWidth="2"
                      />
                      <rect x="9.5" y="9.5" width="5" height="5" fill={accentHex} />
                    </>
                  ) : (
                    <>
                      <polygon
                        points="12,21 3,6 12,10 21,6"
                        fill="rgba(12,74,110,0.52)"
                        stroke={accentHex}
                        strokeWidth="2"
                        strokeLinejoin="miter"
                      />
                    </>
                  )}
                </svg>
              </div>
            );
          })}
        </div>
      )}

      {/* Peripheral Damage Flash Overlay */}
      {snapshot.damageFlash > 0.02 && (
        <div
          className="fixed inset-0"
          style={{
            background: `radial-gradient(circle at center, transparent 48%, rgba(185, 28, 28, ${(
              snapshot.damageFlash * 0.55
            ).toFixed(3)}) 100%)`,
          }}
        />
      )}

      {/* Flashbang Whiteout Overlay */}
      {snapshot.flashBlindAlpha > 0.01 && (
        <div
          className="fixed inset-0 z-20"
          style={{
            backgroundColor: `rgba(242, 248, 255, ${Math.min(0.96, snapshot.flashBlindAlpha).toFixed(3)})`,
          }}
        />
      )}

      {/* Top-Right Diegetic Bodycam Recording Stamp & ECG */}
      {snapshot.config.showRecOverlay && (
        <div
          className="fixed top-4 right-5 flex flex-col items-end font-mono-tabular text-[11px] leading-tight tracking-wider text-neutral-100/90"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.92)' }}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-red-600" />
            <span className="font-semibold text-neutral-50">{presetLabel}</span>
            <span className="text-neutral-300/80">{snapshot.mapName.toUpperCase()}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-neutral-200/80">
            {formatRecTimestamp(snapshot.recordingElapsedSec)}
          </div>
          {snapshot.supportsDynamicWeatherTime && (
            <div className="mt-0.5 text-[10px] uppercase tracking-wider text-amber-300/90">
              {snapshot.gameClockText} · {snapshot.weatherLabel} ·{' '}
              {snapshot.windSpeedMps.toFixed(1)} m/s
            </div>
          )}
          <div className="mt-1.5">
            <HeartRateIndicator
              bpm={snapshot.heartRateBpm}
              stress={snapshot.heartStress}
              holdBreath={snapshot.holdBreathActive}
              bleeding={hpRatio < 0.35}
            />
          </div>
        </div>
      )}

      {/* === BATTLE HUD ELEMENTS === */}
      {isBattle && (
        <>
          {/* Top-Center Score Bar */}
          <div className="fixed top-4 left-1/2 flex -translate-x-1/2 items-center gap-4 border border-neutral-800/90 bg-neutral-950/88 px-4 py-1.5 font-mono-tabular text-xs text-neutral-100">
            {snapshot.battleRule === 'tdm' ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-sky-400">TEAM A</span>
                  <span className="font-display text-lg font-bold text-sky-300">
                    {snapshot.scoreA}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-500">
                  LIMIT {snapshot.killLimit}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-display text-lg font-bold text-orange-400">
                    {snapshot.scoreB}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-orange-400">
                    TEAM B
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-amber-400">YOU</span>
                  <span className="font-display text-lg font-bold text-neutral-50">
                    {snapshot.playerKills}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-500">
                  LIMIT {snapshot.killLimit}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-neutral-400">
                    LEADER ({snapshot.ffaLeaderName})
                  </span>
                  <span className="font-display text-lg font-bold text-amber-300">
                    {snapshot.ffaLeaderKills}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Respawn / Eliminated Spectating Banner */}
          {!snapshot.playerAlive && snapshot.matchOutcome === 'active' && (
            snapshot.spectating ? (
              <div className="fixed bottom-16 left-1/2 -translate-x-1/2 border border-amber-500/70 bg-neutral-950/92 px-6 py-3 text-center">
                <div className="font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-amber-400">
                  Eliminated · Spectating
                </div>
                <div className="mt-0.5 font-display text-xl font-bold uppercase tracking-wider text-neutral-50">
                  {snapshot.spectatingTargetName
                    ? `Watching ${snapshot.spectatingTargetName}`
                    : 'Awaiting Round Conclusion'}
                </div>
                <div className="mt-0.5 font-mono-tabular text-[10px] text-neutral-400">
                  Click / Space to cycle operator camera · Esc for menu
                </div>
              </div>
            ) : (
              <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border border-red-600/80 bg-neutral-950/92 px-6 py-4 text-center">
                <div className="font-display text-2xl font-bold uppercase tracking-wider text-red-400">
                  Operator Down
                </div>
                <div className="mt-1 font-mono-tabular text-xs text-neutral-300">
                  Redeploying in {snapshot.respawnTimerSec.toFixed(1)}s
                </div>
              </div>
            )
          )}

          {/* Hold-Tab Live Scoreboard */}
          {snapshot.scoreboardOpen && snapshot.matchOutcome === 'active' && (
            <div className="fixed top-1/2 left-1/2 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 border border-neutral-700 bg-neutral-950/94 p-4">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                <span className="font-display text-lg font-bold uppercase tracking-wider text-neutral-50">
                  {snapshot.battleRule === 'tdm' ? 'Team Deathmatch' : 'Free-For-All'} ·{' '}
                  {snapshot.mapName}
                </span>
                <span className="font-mono-tabular text-xs text-neutral-400">
                  Limit {snapshot.killLimit}
                </span>
              </div>
              <div className="mt-2.5 flex flex-col gap-1 font-mono-tabular text-xs">
                <div className="grid grid-cols-12 px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
                  <span className="col-span-5">Operator</span>
                  <span className="col-span-3">Unit</span>
                  <span className="col-span-2 text-right">Kills</span>
                  <span className="col-span-2 text-right">Deaths</span>
                </div>
                {snapshot.scoreboard.map((row) => (
                  <div
                    key={row.id}
                    className={`grid grid-cols-12 items-center px-2 py-1.5 ${
                      row.isPlayer
                        ? 'border border-amber-500/50 bg-amber-500/10 text-amber-200'
                        : 'bg-neutral-900/75 text-neutral-200'
                    }`}
                  >
                    <span className="col-span-5 font-semibold">{row.name}</span>
                    <span
                      className={`col-span-3 text-[11px] ${
                        row.team === 'A'
                          ? 'text-sky-400'
                          : row.team === 'B'
                            ? 'text-orange-400'
                            : 'text-neutral-400'
                      }`}
                    >
                      {row.team === 'FFA' ? 'SOLO' : `TEAM ${row.team}`}
                    </span>
                    <span className="col-span-2 text-right font-semibold">{row.kills}</span>
                    <span className="col-span-2 text-right text-neutral-400">{row.deaths}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* === INFECTION HUD ELEMENTS === */}
      {isInfection && (
        <>
          {/* Round Start / Intermission Announcement */}
          {(snapshot.roundState.roundBannerSec > 0 || snapshot.roundState.intermissionSec > 0) && (
            <div className="fixed top-20 left-1/2 -translate-x-1/2 text-center">
              {snapshot.roundState.intermissionSec > 0 ? (
                <div className="border border-red-900/80 bg-neutral-950/90 px-5 py-2">
                  <div className="font-display text-xl font-bold uppercase tracking-widest text-red-400">
                    Round {snapshot.roundState.round} Cleared
                  </div>
                  <div className="font-mono-tabular text-[11px] text-neutral-300">
                    Next Wave in {snapshot.roundState.intermissionSec.toFixed(1)}s
                  </div>
                </div>
              ) : (
                <div
                  className="font-display text-4xl font-bold uppercase tracking-[0.22em] text-red-500"
                  style={{ textShadow: '0 2px 12px rgba(0,0,0,0.95)' }}
                >
                  ROUND {snapshot.roundState.round}
                </div>
              )}
            </div>
          )}

          {/* Co-op Infection Downed / Spectating Banner */}
          {!snapshot.playerAlive && snapshot.spectating && !snapshot.gameOver && (
            <div className="fixed bottom-32 left-1/2 -translate-x-1/2 border border-red-500/70 bg-neutral-950/92 px-6 py-3 text-center">
              <div className="font-display text-lg font-bold uppercase tracking-widest text-red-400">
                Downed · Spectating Squad
              </div>
              <div className="mt-1 font-mono-tabular text-xs text-neutral-100">
                {snapshot.spectatingTargetName
                  ? `Watching ${snapshot.spectatingTargetName} · Reinforces Next Round`
                  : 'Waiting for surviving squadmate · Reinforces Next Round'}
              </div>
              <div className="mt-0.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Click / Space to cycle operator camera
              </div>
            </div>
          )}

          {/* Bottom-Left Distressed Crimson Round Numeral, Remaining, Power & Perks */}
          <div className="fixed bottom-5 left-5 flex flex-col gap-2">
            <div className="flex items-end gap-4">
              <div
                className="font-display text-6xl leading-none font-bold text-red-600"
                style={{ textShadow: '0 3px 10px rgba(0,0,0,0.95)' }}
              >
                {snapshot.roundState.round}
              </div>
              <div
                className="pb-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-200"
                style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
              >
                <div>Infected Remaining: {snapshot.roundState.zombiesRemaining}</div>
                <div className={snapshot.powerOn ? 'text-amber-300' : 'text-neutral-400'}>
                  Power: {snapshot.powerOn ? 'ONLINE' : 'OFFLINE'}
                </div>
                {snapshot.friendlyBotsTotal > 0 && (
                  <div className="text-sky-300">
                    Allied Bots: {snapshot.friendlyBotsAlive}/{snapshot.friendlyBotsTotal}
                  </div>
                )}
              </div>
            </div>

            {snapshot.infectionSquadBots.length > 0 && (
              <div className="flex flex-wrap gap-1.5 font-mono-tabular text-[10px]">
                {snapshot.infectionSquadBots.map((bot) => (
                  <div
                    key={bot.id}
                    className={`flex items-center gap-1.5 border px-2 py-0.5 ${
                      bot.alive
                        ? 'border-neutral-700/90 bg-neutral-950/85 text-neutral-200'
                        : 'border-red-900/80 bg-red-950/70 text-red-300'
                    }`}
                  >
                    <span className="font-semibold uppercase text-sky-300">{bot.name}</span>
                    <span className="text-neutral-400">
                      {bot.alive ? bot.weaponLabel : 'DOWN'}
                    </span>
                    <span className="font-semibold text-amber-300">{bot.points}</span>
                  </div>
                ))}
              </div>
            )}

            {snapshot.perks.length > 0 && (
              <div className="flex items-center gap-2 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider">
                {snapshot.perks.includes('vitality') && (
                  <span className="border border-red-500/80 bg-red-950/90 px-2 py-0.5 text-red-200">
                    Vitality Reserve · 160 HP
                  </span>
                )}
                {snapshot.perks.includes('rapid_handling') && (
                  <span className="border border-emerald-500/80 bg-emerald-950/90 px-2 py-0.5 text-emerald-200">
                    Rapid Handling · 1.6x Reload
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Center-Bottom [F] Interact / Hold [F] Barrier Repair Prompt */}
          {snapshot.pointerLocked && snapshot.nearbyPrompt && (
            <div className="fixed bottom-24 left-1/2 min-w-[260px] -translate-x-1/2 border border-neutral-700 bg-neutral-950/92 px-4 py-2 text-center font-mono-tabular text-xs">
              <div className="flex items-center justify-center gap-2 font-semibold uppercase tracking-wider text-neutral-50">
                <span>
                  {snapshot.nearbyPrompt.isHoldAction ? 'HOLD [F]' : '[F]'}{' '}
                  {snapshot.nearbyPrompt.actionText}
                </span>
                {snapshot.nearbyPrompt.cost > 0 && (
                  <span
                    className={
                      snapshot.nearbyPrompt.canAfford ? 'text-amber-300' : 'text-red-400'
                    }
                  >
                    {snapshot.nearbyPrompt.cost} PTS
                  </span>
                )}
              </div>
              {snapshot.nearbyPrompt.isHoldAction &&
                typeof snapshot.nearbyPrompt.planksRemaining === 'number' &&
                typeof snapshot.nearbyPrompt.maxPlanks === 'number' && (
                  <div className="mt-1.5 flex flex-col gap-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-300">
                      <span>
                        Planks: {snapshot.nearbyPrompt.planksRemaining} /{' '}
                        {snapshot.nearbyPrompt.maxPlanks}
                      </span>
                      <span className="text-amber-300">+5 PTS / Plank</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden bg-neutral-800">
                      <div
                        className="h-full bg-amber-400 transition-all duration-75"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((snapshot.nearbyPrompt.holdProgress ?? 0) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              {snapshot.nearbyPrompt.blockedReason && (
                <div className="mt-0.5 text-[10px] uppercase tracking-wider text-red-400">
                  {snapshot.nearbyPrompt.blockedReason}
                </div>
              )}
            </div>
          )}

          {/* Points Counter & Floating +PTS Popups (Bottom-Right above Weapon Block) */}
          <div className="fixed right-5 bottom-24 flex flex-col items-end">
            <div className="mb-1 flex flex-col items-end gap-0.5 font-mono-tabular text-[11px]">
              {snapshot.pointsPopups.map((p) => (
                <div
                  key={p.id}
                  className="font-semibold text-amber-300"
                  style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
                >
                  +{p.amount} {p.label}
                </div>
              ))}
            </div>
            <div className="border border-amber-500/50 bg-neutral-950/88 px-3.5 py-1.5 font-mono-tabular">
              <span className="text-lg font-bold text-amber-300">{snapshot.points}</span>
              <span className="ml-1.5 text-[10px] uppercase tracking-wider text-neutral-400">
                PTS
              </span>
            </div>
          </div>
        </>
      )}

      {/* Subtle Center Hitmarker Ticks (only visible briefly on hit) */}
      {snapshot.pointerLocked && snapshot.hitmarkerActive && (
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <svg width="28" height="28" viewBox="0 0 28 28">
            <g
              stroke={snapshot.hitmarkerHeadshot || snapshot.hitmarkerKill ? '#ef4444' : '#f8fafc'}
              strokeWidth={snapshot.hitmarkerKill ? '2.4' : '1.8'}
              strokeLinecap="square"
            >
              <line x1="6" y1="6" x2="10.5" y2="10.5" />
              <line x1="22" y1="6" x2="17.5" y2="10.5" />
              <line x1="6" y1="22" x2="10.5" y2="17.5" />
              <line x1="22" y1="22" x2="17.5" y2="17.5" />
            </g>
          </svg>
        </div>
      )}

      {/* Authentic 4-Stage Grenade Manual of Arms Indicator (Zero HUD power/cook bar) */}
      {snapshot.pointerLocked && snapshot.grenadeHoldStage !== 'HOLSTERED' && (
        <div
          className={`fixed top-[56%] left-1/2 flex w-80 -translate-x-1/2 flex-col gap-1 border px-3.5 py-1.5 font-mono-tabular ${
            snapshot.grenadeHoldStage === 'LEVER_RELEASED'
              ? 'animate-pulse border-red-500/90 bg-red-950/60'
              : snapshot.grenadeHoldStage === 'PIN_PULLED'
                ? 'border-amber-400/85 bg-neutral-950/92'
                : 'border-neutral-600/85 bg-neutral-950/90'
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider">
            <span
              className={
                snapshot.grenadeHoldStage === 'LEVER_RELEASED'
                  ? 'text-red-300'
                  : snapshot.grenadeHoldStage === 'PIN_PULLED'
                    ? 'text-amber-300'
                    : 'text-neutral-100'
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
                ? 'RMB PIN · [H/4] STOW'
                : snapshot.grenadeHoldStage === 'PIN_PULLED'
                  ? 'RMB SPOON · LMB LOB/HOLD'
                  : snapshot.grenadeThrowHeld && snapshot.grenadeThrowStyle === 'overhand'
                    ? 'REL LMB OVERHAND'
                    : 'LMB LOB / HOLD'}
            </span>
          </div>
          {snapshot.grenadeHoldStage === 'PIN_PULLED' && (
            <div className="text-[9px] uppercase tracking-wider text-neutral-300">
              {snapshot.grenadeThrowHeld
                ? `Charging ${snapshot.grenadeThrowStyle === 'overhand' ? 'OVERHAND' : 'LOB'} — Release LMB`
                : 'Lever gripped — fuse NOT running'}
            </div>
          )}
          {snapshot.grenadeHoldStage === 'LEVER_RELEASED' && (
            <div className="text-[9px] uppercase tracking-wider text-red-200">
              {snapshot.grenadeThrowHeld
                ? `LIVE FUSE — Charging ${snapshot.grenadeThrowStyle === 'overhand' ? 'OVERHAND' : 'LOB'} — Release LMB`
                : 'Spoon detached — chemical delay burning'}
            </div>
          )}
        </div>
      )}

      {/* Transient Toast */}
      {snapshot.toastMessage && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 border border-neutral-700/80 bg-neutral-950/90 px-3.5 py-1.5 font-mono-tabular text-xs text-neutral-100">
          {snapshot.toastMessage}
        </div>
      )}

      {/* Bottom-Right Health, Belt Ordnance & Weapon Status Block */}
      <div className="fixed right-5 bottom-4 flex flex-col items-end gap-1.5">
        {/* Tactical Health Bar */}
        <div className="flex items-center gap-2.5 bg-neutral-950/86 px-3 py-1.5 font-mono-tabular text-[11px]">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400">
            {snapshot.isRegenerating ? 'REGEN' : 'HP'}
          </span>
          <div className="h-1.5 w-28 overflow-hidden bg-neutral-800">
            <div
              className={`h-full transition-all duration-100 ${
                hpRatio > 0.45 ? 'bg-emerald-400' : hpRatio > 0.22 ? 'bg-amber-400' : 'bg-red-500'
              }`}
              style={{ width: `${Math.round(hpRatio * 100)}%` }}
            />
          </div>
          <span className="w-8 text-right font-semibold text-neutral-100">{snapshot.hp}</span>
        </div>

        <div className="flex items-stretch gap-1.5">
          {/* Helmet-Mounted Night Vision & IR Illuminator Indicator */}
          {snapshot.nvgMount !== 'none' && (
            <div
              className={`flex flex-col justify-center border px-3 py-1.5 font-mono-tabular text-right ${
                snapshot.nvgActive
                  ? snapshot.nvgMount === 'arnvg'
                    ? 'border-sky-500/80 bg-neutral-950/90 text-sky-200'
                    : 'border-emerald-500/80 bg-neutral-950/90 text-emerald-200'
                  : 'border-neutral-800/90 bg-neutral-950/88 text-neutral-400'
              }`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider">
                {snapshot.nvgMount === 'arnvg' ? 'RNVG-A P45' : 'PVS-7 P43'}
              </div>
              <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[10px] uppercase">
                <span className={snapshot.nvgActive ? 'font-bold' : 'text-neutral-500'}>
                  {snapshot.nvgActive ? 'ON' : 'STOW'}
                </span>
                <span className="border border-neutral-700 bg-neutral-900 px-1 text-[9px] text-neutral-300">
                  J
                </span>
                {snapshot.nvgActive && (
                  <span
                    className={`border px-1 text-[9px] font-semibold ${
                      snapshot.irIlluminatorOn
                        ? 'border-amber-400 bg-amber-950/80 text-amber-200'
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400'
                    }`}
                  >
                    IR {snapshot.irIlluminatorOn ? 'ON' : 'N'}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Belt Tactical Grenade Slot */}
          <div
            className={`flex flex-col justify-center border px-3 py-1.5 font-mono-tabular text-right ${
              snapshot.grenadeHoldStage === 'LEVER_RELEASED'
                ? 'border-red-500 bg-red-950/75 text-red-200'
                : snapshot.grenadeHoldStage !== 'HOLSTERED'
                  ? 'border-amber-400 bg-amber-950/75 text-amber-200'
                  : snapshot.grenadeCount > 0
                    ? 'border-neutral-800/90 bg-neutral-950/88 text-neutral-200'
                    : 'border-neutral-800/60 bg-neutral-950/72 text-neutral-500'
            }`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider">
              {snapshot.tacticalEquipmentShortName}
            </div>
            <div className="mt-0.5 flex items-baseline justify-end gap-1.5">
              <span className="font-display text-lg leading-none font-bold text-amber-300">
                {snapshot.grenadeCount}
              </span>
              <span className="text-[10px] text-neutral-400">/ {snapshot.grenadeMax}</span>
              <span className="border border-neutral-700 bg-neutral-900 px-1 text-[9px] text-neutral-300">
                4/H
              </span>
            </div>
          </div>

          {/* Active Weapon & Ammo */}
          <div className="flex items-center gap-3 border border-neutral-800/90 bg-neutral-950/88 px-3.5 py-2 font-mono-tabular">
            <div className="text-right">
              <div className="text-xs font-semibold text-neutral-100">
                {snapshot.equippedWeaponName}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-neutral-400">
                {snapshot.isReloading
                  ? 'RELOADING...'
                  : snapshot.armedAdsMode === 'POINT_AIM'
                    ? 'POINT AIM'
                    : snapshot.armedAdsMode === 'CANTED'
                      ? 'CANTED'
                      : `${snapshot.equippedCaliber} · Z ${snapshot.zeroDistanceM}m`}
              </div>
            </div>
            <div className="border-l border-neutral-800 pl-3 text-right">
              <span className="font-display text-2xl font-bold text-neutral-50">
                {snapshot.ammoInMag}
              </span>
              <span className="ml-1 text-xs text-neutral-400">
                / {snapshot.reserveAmmo < 0 ? 'INF' : snapshot.reserveAmmo}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom-Center Compact Controls Hint Strip */}
      {snapshot.pointerLocked && (
        <div
          className="fixed bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-2.5 whitespace-nowrap font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-300/75 lg:flex"
          style={{ textShadow: '0 1px 2px rgba(0,0,0,0.95)' }}
        >
          {snapshot.isPdaOpen ? (
            <>
              <span className="text-emerald-300">TAC-PDA ACTIVE</span>
              <span>Mouse Joystick Pan</span>
              <span>Wheel Zoom</span>
              <span>R / RMB Center</span>
              <span className="text-amber-300">M Stow PDA</span>
            </>
          ) : (
            <>
              <span>1-2 Weapons</span>
              <span className="text-amber-300">4 / H Grenade</span>
              <span className="text-emerald-300">M Tac Map</span>
              {snapshot.nvgMount !== 'none' && (
                <span className="text-sky-300">J NVG · N IR</span>
              )}
              <span>R Reload</span>
              <span>MMB Pt-Aim</span>
              <span>V Bash</span>
              <span>X Kick</span>
              <span className="text-sky-300">Z Ping</span>
              {isBattle && <span>Tab Scoreboard</span>}
              {isInfection && <span className="text-amber-300">F Interact · Hold F Repair</span>}
              <span>F1 Optics</span>
            </>
          )}
        </div>
      )}

      {/* === PAUSE OVERLAY (Unlocked during active session) === */}
      {paused && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-neutral-950/65 p-6">
          <div className="w-full max-w-md border border-neutral-700 bg-neutral-950/95 p-6 text-neutral-100">
            <div
              className={`font-mono-tabular text-[10px] uppercase tracking-[0.2em] ${
                isInfection ? 'text-red-400' : 'text-amber-400'
              }`}
            >
              {isInfection
                ? `Infection · Round ${snapshot.roundState.round}`
                : `${snapshot.battleRule === 'tdm' ? 'Team Deathmatch' : 'Free-For-All'} · ${snapshot.mapName}`}
            </div>
            <h2 className="mt-1 font-display text-3xl font-bold uppercase tracking-wide text-neutral-50">
              {snapshot.mapName}
            </h2>
            <p className="mt-1.5 text-xs text-neutral-400">
              Click Resume to lock cursor and continue combat. Press Esc at any time to pause.
            </p>

            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={onRequestLock}
                className={`w-full cursor-pointer py-2.5 font-display text-sm font-bold uppercase tracking-wider transition-colors ${
                  isInfection
                    ? 'bg-red-600 text-neutral-50 hover:bg-red-500'
                    : 'bg-amber-500 text-neutral-950 hover:bg-amber-400'
                }`}
              >
                Resume Combat
              </button>
              <button
                type="button"
                onClick={() => onToggleTuner(true)}
                className="w-full cursor-pointer border border-neutral-700 bg-neutral-900 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
              >
                F1 · Bodycam Optics Settings
              </button>
              {multiplayerSession ? (
                <>
                  {multiplayerSession.isHost ? (
                    <>
                      <button
                        type="button"
                        onClick={multiplayerSession.onHostRestart}
                        className="w-full cursor-pointer border border-amber-500/60 bg-amber-950/35 py-2 font-mono-tabular text-xs uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-900/50"
                      >
                        Host · Restart Match (All Players)
                      </button>
                      <button
                        type="button"
                        onClick={multiplayerSession.onHostEndToLobby}
                        className="w-full cursor-pointer border border-sky-500/60 bg-sky-950/35 py-2 font-mono-tabular text-xs uppercase tracking-wider text-sky-200 transition-colors hover:bg-sky-900/50"
                      >
                        Host · Return All to Lobby (Quit With Squad)
                      </button>
                    </>
                  ) : (
                    <div className="border border-neutral-800 bg-neutral-900/50 px-3 py-2 font-mono-tabular text-[11px] text-neutral-400">
                      Lobby {multiplayerSession.lobbyCode} · Match controls are Host-only.
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={multiplayerSession.onLeaveMatch}
                    className="w-full cursor-pointer border border-red-900/70 bg-red-950/35 py-2 font-mono-tabular text-xs uppercase tracking-wider text-red-200 transition-colors hover:bg-red-900/55"
                  >
                    {multiplayerSession.isHost ? 'Leave Lobby Alone (Auto-Promote Host)' : 'Leave Match'}
                  </button>
                </>
              ) : (
                <>
                  {isBattle && (
                    <button
                      type="button"
                      onClick={onRematch}
                      className="w-full cursor-pointer border border-neutral-800 bg-neutral-900/90 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100"
                    >
                      Restart Match
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onReturnToMenu(isInfection ? 'infection' : 'battle')}
                    className="w-full cursor-pointer border border-neutral-800 bg-neutral-950 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-100"
                  >
                    Return to Main Menu
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* === COMPACT F1 OPTICS TUNER DRAWER === */}
      {snapshot.tunerOpen && (
        <div className="pointer-events-auto fixed top-5 right-5 z-30 w-80 border border-neutral-700 bg-neutral-950/96 p-4 text-neutral-100">
          <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
            <span className="font-display text-base font-bold uppercase tracking-wider">
              Bodycam Optics (F1)
            </span>
            <button
              type="button"
              onClick={() => onToggleTuner(false)}
              className="cursor-pointer font-mono-tabular text-xs text-neutral-400 hover:text-neutral-100"
            >
              Close
            </button>
          </div>

          <div className="mt-3 flex flex-col gap-3 text-xs">
            <div>
              <div className="mb-1.5 font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                Lens Preset
              </div>
              <div className="grid grid-cols-3 gap-1">
                {(['axon_body_4', 'gopro_chest', 'clean_raw'] as BodycamLensPresetId[]).map(
                  (pid) => (
                    <button
                      key={pid}
                      type="button"
                      onClick={() => onApplyLensPreset(pid)}
                      className={`cursor-pointer border py-1 font-mono-tabular text-[10px] uppercase ${
                        snapshot.config.lensPreset === pid
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400'
                      }`}
                    >
                      {LENS_PRESETS[pid].label}
                    </button>
                  ),
                )}
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <div className="flex justify-between font-mono-tabular text-[11px]">
                <span className="text-neutral-300">Base Horizontal FOV</span>
                <span className="text-amber-300">{snapshot.config.baseHFovDeg}°</span>
              </div>
              <input
                type="range"
                min={80}
                max={112}
                step={1}
                value={snapshot.config.baseHFovDeg}
                onChange={(e) => onUpdateConfig({ baseHFovDeg: Number(e.target.value) })}
                className="accent-amber-400"
              />
            </label>

            <label className="flex flex-col gap-1">
              <div className="flex justify-between font-mono-tabular text-[11px]">
                <span className="text-neutral-300">Fisheye Distortion</span>
                <span className="text-amber-300">
                  {snapshot.config.fisheyeStrength.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={0.28}
                step={0.01}
                value={snapshot.config.fisheyeStrength}
                onChange={(e) => onUpdateConfig({ fisheyeStrength: Number(e.target.value) })}
                className="accent-amber-400"
              />
            </label>

            <label className="flex flex-col gap-1">
              <div className="flex justify-between font-mono-tabular text-[11px]">
                <span className="text-neutral-300">Master Volume</span>
                <span className="text-amber-300">
                  {Math.round(snapshot.config.masterVolume * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={snapshot.config.masterVolume}
                onChange={(e) => onUpdateConfig({ masterVolume: Number(e.target.value) })}
                className="accent-amber-400"
              />
            </label>

            {/* Belt Tactical Equipment Assignment */}
            <div className="border-t border-neutral-800 pt-3">
              <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                <span>Tactical Belt Slot</span>
                <button
                  type="button"
                  onClick={() => onToggleTacticalMountOnBelt(!snapshot.tacticalMountOnBelt)}
                  className={`cursor-pointer border px-1.5 py-0.5 text-[9px] font-semibold ${
                    snapshot.tacticalMountOnBelt
                      ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                      : 'border-neutral-700 bg-neutral-900 text-neutral-400'
                  }`}
                >
                  Belt Mesh: {snapshot.tacticalMountOnBelt ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {TACTICAL_EQUIPMENT_LIST.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectTacticalEquipment(item.id)}
                    className={`cursor-pointer border px-2 py-1 text-left font-mono-tabular text-[10px] ${
                      snapshot.tacticalEquipmentId === item.id
                        ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {item.shortName}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1">
                {TACTICAL_BELT_SLOTS.map((slot) => (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => onSelectTacticalBeltSlot(slot.id)}
                    className={`cursor-pointer border py-1 font-mono-tabular text-[9px] uppercase ${
                      snapshot.tacticalBeltSlot === slot.id
                        ? 'border-amber-400/80 bg-amber-500/15 text-amber-300'
                        : 'border-neutral-800 bg-neutral-900 text-neutral-500 hover:text-neutral-300'
                    }`}
                  >
                    {slot.shortLabel}
                  </button>
                ))}
              </div>
            </div>

            {/* HUD Killfeed & Graphics Quality */}
            <div className="border-t border-neutral-800 pt-3">
              <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                <span>Killfeed HUD</span>
                {effectiveKillfeed.overriddenByHost ? (
                  <span className="text-amber-300">{effectiveKillfeed.overrideLabel}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const next = !personalKillfeed;
                      setPersonalKillfeed(next);
                      onUpdateConfig({ showKillfeed: next });
                    }}
                    className={`cursor-pointer border px-2 py-0.5 text-[10px] font-semibold ${
                      personalKillfeed
                        ? 'border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                        : 'border-neutral-700 bg-neutral-900 text-neutral-400'
                    }`}
                  >
                    {personalKillfeed ? 'ON' : 'OFF'}
                  </button>
                )}
              </div>

              {multiplayerSession?.isHost && multiplayerSession.onHostUpdateKillfeedPolicy && (
                <div className="mt-2">
                  <div className="mb-1 font-mono-tabular text-[9px] uppercase tracking-wider text-amber-300/90">
                    Host Lobby Override (All Players)
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: 'player_choice', label: 'Player' },
                        { id: 'force_on', label: 'Force On' },
                        { id: 'force_off', label: 'Force Off' },
                      ] as Array<{ id: LobbyKillfeedPolicy; label: string }>
                    ).map((opt) => {
                      const active =
                        (multiplayerSession.killfeedPolicy ?? 'player_choice') === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => multiplayerSession.onHostUpdateKillfeedPolicy?.(opt.id)}
                          className={`cursor-pointer border py-1 font-mono-tabular text-[9px] uppercase ${
                            active
                              ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                              : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                  <span>Graphics Mode</span>
                  <span className="text-amber-300">
                    {GRAPHICS_QUALITY_PROFILES[graphicsQuality].label}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1">
                  {GRAPHICS_QUALITY_ORDER.map((gid: GraphicsQualityId) => (
                    <button
                      key={gid}
                      type="button"
                      onClick={() => {
                        setGraphicsQuality(gid);
                        onUpdateConfig({ graphicsQuality: gid });
                      }}
                      className={`cursor-pointer border py-1 font-mono-tabular text-[9px] uppercase ${
                        graphicsQuality === gid
                          ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                          : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      {GRAPHICS_QUALITY_PROFILES[gid].shortLabel}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onRequestLock}
              className="mt-1 w-full cursor-pointer bg-amber-500 py-2 font-display text-xs font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
            >
              Resume Combat
            </button>
          </div>
        </div>
      )}

      {/* === BATTLE VICTORY / DEFEAT MODAL === */}
      {isBattle && snapshot.matchOutcome !== 'active' && (
        <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/78 p-6">
          <div className="w-full max-w-xl border border-neutral-700 bg-neutral-950 p-6 text-neutral-100">
            <div
              className={`font-mono-tabular text-xs uppercase tracking-[0.22em] ${
                snapshot.matchOutcome === 'victory' ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              Match Complete · {snapshot.mapName}
            </div>
            <h2 className="mt-1 font-display text-4xl font-bold uppercase tracking-wider text-neutral-50">
              {snapshot.matchOutcome === 'victory' ? 'VICTORY' : 'DEFEAT'}
            </h2>

            <div className="mt-3 flex items-center gap-6 border-y border-neutral-800 py-2.5 font-mono-tabular text-xs text-neutral-300">
              {snapshot.battleRule === 'tdm' ? (
                <span>
                  Team A <strong className="text-sky-300">{snapshot.scoreA}</strong> — Team B{' '}
                  <strong className="text-orange-400">{snapshot.scoreB}</strong>
                </span>
              ) : (
                <span>
                  Leader: <strong className="text-amber-300">{snapshot.ffaLeaderName}</strong> (
                  {snapshot.ffaLeaderKills})
                </span>
              )}
              <span>
                Your K/D:{' '}
                <strong className="text-neutral-50">
                  {snapshot.playerKills}/{snapshot.playerDeaths}
                </strong>
              </span>
              <span>
                Headshots: <strong className="text-neutral-50">{snapshot.playerHeadshots}</strong>
              </span>
            </div>

            <div className="mt-3 max-h-48 overflow-y-auto font-mono-tabular text-xs">
              {snapshot.scoreboard.map((row) => (
                <div
                  key={row.id}
                  className={`grid grid-cols-12 px-2 py-1 ${
                    row.isPlayer ? 'bg-amber-500/15 text-amber-200' : 'text-neutral-300'
                  }`}
                >
                  <span className="col-span-6 font-semibold">{row.name}</span>
                  <span className="col-span-2 text-neutral-500">
                    {row.team === 'FFA' ? 'SOLO' : `T-${row.team}`}
                  </span>
                  <span className="col-span-2 text-right">{row.kills} K</span>
                  <span className="col-span-2 text-right text-neutral-500">{row.deaths} D</span>
                </div>
              ))}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {multiplayerSession ? (
                multiplayerSession.isHost ? (
                  <>
                    <button
                      type="button"
                      onClick={multiplayerSession.onHostRestart}
                      className="cursor-pointer whitespace-nowrap bg-amber-500 px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
                    >
                      Restart Match (Squad)
                    </button>
                    <button
                      type="button"
                      onClick={multiplayerSession.onHostEndToLobby}
                      className="cursor-pointer whitespace-nowrap border border-sky-500/70 bg-sky-950/40 px-5 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-sky-200 hover:bg-sky-900/60"
                    >
                      Return All to Lobby
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={multiplayerSession.onLeaveMatch}
                    className="cursor-pointer whitespace-nowrap border border-neutral-700 bg-neutral-900 px-5 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 hover:border-neutral-500"
                  >
                    Leave Lobby
                  </button>
                )
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onRematch}
                    className="cursor-pointer whitespace-nowrap bg-amber-500 px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
                  >
                    Rematch
                  </button>
                  <button
                    type="button"
                    onClick={() => onReturnToMenu('battle')}
                    className="cursor-pointer whitespace-nowrap border border-neutral-700 bg-neutral-900 px-5 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 hover:border-neutral-500"
                  >
                    Change Map / Settings
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* === INFECTION GAME OVER MODAL === */}
      {isInfection && snapshot.gameOver && (
        <div className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/82 p-6">
          <div className="w-full max-w-md border border-red-800/80 bg-neutral-950 p-6 text-neutral-100">
            <div className="font-mono-tabular text-xs uppercase tracking-[0.22em] text-red-400">
              {snapshot.mapName} · Overrun
            </div>
            <h2 className="mt-1 font-display text-4xl font-bold uppercase tracking-wider text-red-500">
              YOU SURVIVED {snapshot.roundState.round}{' '}
              {snapshot.roundState.round === 1 ? 'ROUND' : 'ROUNDS'}
            </h2>

            <div className="mt-4 grid grid-cols-3 gap-2 border-y border-red-950/80 py-3 font-mono-tabular text-center">
              <div>
                <div className="text-xl font-bold text-neutral-50">{snapshot.playerKills}</div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">Kills</div>
              </div>
              <div>
                <div className="text-xl font-bold text-red-300">{snapshot.playerHeadshots}</div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">
                  Headshots
                </div>
              </div>
              <div>
                <div className="text-xl font-bold text-amber-300">{snapshot.points}</div>
                <div className="text-[10px] uppercase tracking-wider text-neutral-400">Points</div>
              </div>
            </div>

            <div className="mt-5 flex gap-2">
              {multiplayerSession ? (
                multiplayerSession.isHost ? (
                  <>
                    <button
                      type="button"
                      onClick={multiplayerSession.onHostRestart}
                      className="flex-1 cursor-pointer bg-red-600 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-50 hover:bg-red-500"
                    >
                      Restart Sector
                    </button>
                    <button
                      type="button"
                      onClick={multiplayerSession.onHostEndToLobby}
                      className="flex-1 cursor-pointer border border-sky-500/70 bg-sky-950/40 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-sky-200 hover:bg-sky-900/60"
                    >
                      Return All to Lobby
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={multiplayerSession.onLeaveMatch}
                    className="flex-1 cursor-pointer border border-neutral-700 bg-neutral-900 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 hover:border-neutral-500"
                  >
                    Leave Lobby
                  </button>
                )
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onRematch}
                    className="flex-1 cursor-pointer bg-red-600 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-50 hover:bg-red-500"
                  >
                    Retry Sector
                  </button>
                  <button
                    type="button"
                    onClick={() => onReturnToMenu('infection')}
                    className="flex-1 cursor-pointer border border-neutral-700 bg-neutral-900 py-2.5 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 hover:border-neutral-500"
                  >
                    Main Menu
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

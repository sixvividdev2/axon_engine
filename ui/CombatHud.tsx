import React, { useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  BodycamLensPresetId,
  BodycamSDKConfig,
  LENS_PRESETS,
  resolveWeaponProfile,
} from '../bodycam-sdk';
import { CombatSessionSnapshot } from '../combat/CombatSessionEngine';
import {
  formatBattleRuleName,
  formatBattleRuleShort,
  isKillConfirmedRule,
  isTeamBattleRule,
} from '../maps/types';
import { openGameSettings } from '../data/gameSettingsStore';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  GraphicsQualityId,
  useAdaptiveScaling,
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
import { ControlsSettingsTab } from './ControlsSettingsTab';
import { HeartRateIndicator } from './HeartRateIndicator';
import { KillfeedOverlay } from './KillfeedOverlay';

const HUD_SLIDE_TRANSITION = { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const };
const MODAL_TRANSITION = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

export interface MultiplayerHudControls {
  isHost: boolean;
  lobbyCode: string;
  eventName?: string | null;
  killfeedPolicy?: LobbyKillfeedPolicy;
  hitmarkersEnabled?: boolean;
  hudEnabled?: boolean;
  localPlayerName?: string;
  onHostUpdateKillfeedPolicy?: (policy: LobbyKillfeedPolicy) => void;
  onHostUpdateMatchVisibility?: (patch: {
    hitmarkersEnabled?: boolean;
    hudEnabled?: boolean;
  }) => void;
  onHostRestart: () => void;
  onHostEndToLobby: () => void;
  onLeaveMatch: () => void;
}

interface CombatHudProps {
  snapshot: CombatSessionSnapshot;
  multiplayerSession?: MultiplayerHudControls | null;
  onUpdateHostMatchVisibility?: (patch: {
    hitmarkersEnabled?: boolean;
    hudEnabled?: boolean;
  }) => void;
  onRequestLock: () => void;
  onToggleTuner: (open: boolean) => void;
  onUpdateConfig: (patch: Partial<BodycamSDKConfig>) => void;
  onApplyLensPreset: (preset: BodycamLensPresetId) => void;
  onSelectTacticalEquipment: (id: TacticalEquipmentId) => void;
  onSelectTacticalBeltSlot: (slot: TacticalBeltSlot) => void;
  onToggleTacticalMountOnBelt: (mount: boolean) => void;
  onSelectConquestLoadout?: (slotId: string) => void;
  onSelectConquestSpawn?: (spawnId: string) => void;
  onConfirmConquestRedeploy?: () => void;
  onCycleSpectateTarget?: (dir: 1 | -1) => void;
  onToggleSpectateOverview?: () => void;
  onRematch: () => void;
  onReturnToMenu: (tab?: 'battle' | 'infection') => void;
}

function formatMatchClock(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
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
  onUpdateHostMatchVisibility,
  onRequestLock,
  onToggleTuner,
  onUpdateConfig,
  onApplyLensPreset,
  onSelectTacticalEquipment,
  onSelectTacticalBeltSlot,
  onToggleTacticalMountOnBelt,
  onSelectConquestLoadout,
  onSelectConquestSpawn,
  onConfirmConquestRedeploy,
  onCycleSpectateTarget,
  onToggleSpectateOverview,
  onRematch,
  onReturnToMenu,
}) => {
  const isBattle = snapshot.mode === 'battle';
  const isInfection = snapshot.mode === 'infection';
  const [personalKillfeed, setPersonalKillfeed] = useKillfeedPreference();
  const [graphicsQuality, setGraphicsQuality] = useGraphicsQuality();
  const [adaptiveScaling, setAdaptiveScaling] = useAdaptiveScaling();
  const [localHudVisible, setLocalHudVisible] = useState(true);
  const [tunerTab, setTunerTab] = useState<'optics' | 'controls'>('optics');
  const effectiveKillfeed = resolveEffectiveKillfeed(
    personalKillfeed && snapshot.config.showKillfeed,
    multiplayerSession?.killfeedPolicy ?? null,
  );
  const hostHudEnabled = isBattle ? snapshot.hudEnabled : true;
  const showMatchHud = hostHudEnabled && localHudVisible;
  const showHitmarkers = isBattle ? snapshot.hitmarkersEnabled : true;
  const canEditHostBattleRules =
    isBattle && (!multiplayerSession || multiplayerSession.isHost);
  const applyHostVisibility = (patch: { hitmarkersEnabled?: boolean; hudEnabled?: boolean }) => {
    if (multiplayerSession?.onHostUpdateMatchVisibility) {
      multiplayerSession.onHostUpdateMatchVisibility(patch);
    }
    onUpdateHostMatchVisibility?.(patch);
  };
  const hpRatio = Math.max(0, Math.min(1, snapshot.hp / Math.max(1, snapshot.maxHp)));
  const presetLabel =
    snapshot.config.lensPreset === 'gopro_chest'
      ? 'GOPRO REC'
      : snapshot.config.lensPreset === 'clean_raw'
        ? 'RAW REC'
        : 'AXON REC';

  const modeHud = snapshot.modeHud;
  const conquestRedeployOpen =
    isBattle &&
    Boolean(modeHud?.conquestAwaitingRedeploy) &&
    snapshot.matchOutcome === 'active';
  const conquestSpectatingActive =
    isBattle &&
    Boolean(modeHud?.conquestSpectating) &&
    snapshot.matchOutcome === 'active';

  const paused =
    !snapshot.pointerLocked &&
    !snapshot.tunerOpen &&
    !snapshot.gameOver &&
    !conquestRedeployOpen &&
    !conquestSpectatingActive &&
    snapshot.matchOutcome === 'active';

  return (
    <MotionConfig reducedMotion="user">
    <div className="pointer-events-none fixed inset-0 z-10 select-none">
      {/* Top-Left Animated Killfeed (Active in Battle & Infection; Host Override > Player Toggle) */}
      <AnimatePresence>
        {showMatchHud && effectiveKillfeed.enabled && (
          <motion.div
            key="hud-killfeed-wrap"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={HUD_SLIDE_TRANSITION}
          >
            <KillfeedOverlay
              entries={snapshot.killfeed}
              enabled={true}
              localPlayerName={multiplayerSession?.localPlayerName ?? 'YOU'}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mid-Left Tactical Squad Radio Feed (Allied Bot Comms in Infection & Battle TDM) */}
      <AnimatePresence>
        {showMatchHud && snapshot.squadComms.length > 0 && (
          <motion.div
            key="hud-squad-radio"
            initial={{ opacity: 0, x: -28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -28 }}
            transition={HUD_SLIDE_TRANSITION}
            className="pointer-events-none fixed left-5 bottom-40 z-10 flex w-72 flex-col gap-1 font-mono-tabular"
          >
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
          </motion.div>
        )}
      </AnimatePresence>

      {/* World-Projected Tactical Pings (Z Key · Auto-Detect Location / Enemy / Item · Distance Fade) */}
      {showMatchHud && snapshot.tacticalPings.length > 0 && (
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
      <AnimatePresence>
        {showMatchHud && snapshot.config.showRecOverlay && (
          <motion.div
            key="hud-rec-overlay"
            initial={{ opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 28 }}
            transition={HUD_SLIDE_TRANSITION}
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
          </motion.div>
        )}
      </AnimatePresence>

      {/* === BATTLE HUD ELEMENTS === */}
      {isBattle && (
        <>
          {/* Top-Center Mode Score & Objective Strip */}
          <AnimatePresence>
            {showMatchHud && (
              <div className="fixed top-4 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
                <motion.div
                  key="hud-battle-score"
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={HUD_SLIDE_TRANSITION}
                  className="flex flex-col items-center gap-1 border border-neutral-800/90 bg-[#0d1015]/92 px-4 py-1.5 font-mono-tabular text-xs text-neutral-100"
                >
                  <div className="flex items-center gap-4">
                    {isTeamBattleRule(snapshot.battleRule) ? (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider text-sky-400">
                            TEAM A
                          </span>
                          <span className="font-display text-lg font-bold text-sky-300">
                            {Math.round(snapshot.scoreA)}
                          </span>
                        </div>
                        <div className="flex flex-col items-center leading-tight">
                          <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-400">
                            {formatBattleRuleShort(snapshot.battleRule)}
                          </span>
                          <span className="text-[10px] text-neutral-400">
                            {modeHud && modeHud.remainingSec > 0
                              ? `${formatMatchClock(modeHud.remainingSec)} · / ${modeHud.scoreLimit}`
                              : `LIMIT ${modeHud?.scoreLimit ?? snapshot.killLimit}`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-display text-lg font-bold text-orange-400">
                            {Math.round(snapshot.scoreB)}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-orange-400">
                            TEAM B
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider text-amber-400">
                            {snapshot.battleRule === 'kc_ffa' ? 'ENEMY TAGS' : 'YOU'}
                          </span>
                          <span className="font-display text-lg font-bold text-neutral-50">
                            {snapshot.battleRule === 'kc_ffa'
                              ? (modeHud?.localEnemyTags ?? 0)
                              : snapshot.playerKills}
                          </span>
                        </div>
                        <div className="flex flex-col items-center leading-tight">
                          <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-400">
                            {formatBattleRuleShort(snapshot.battleRule)}
                          </span>
                          <span className="text-[10px] text-neutral-400">
                            LIMIT {modeHud?.scoreLimit ?? snapshot.killLimit}
                          </span>
                        </div>
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

                  {/* Conquest POI Status Row, Territory Rate & Loadout Attrition */}
                  {snapshot.battleRule === 'conquest' && modeHud && (
                    <div className="flex flex-wrap items-center justify-center gap-1.5 border-t border-neutral-800/90 pt-1">
                      {modeHud.conquestPois.map((poi) => {
                        const lockedAlert = poi.contested || (poi.kind === 'fob' && poi.underAttack);
                        const ownerCls = lockedAlert
                          ? 'border-amber-400/90 bg-amber-950/60 text-amber-200'
                          : poi.owner === 'A'
                            ? 'border-sky-500/80 bg-sky-950/55 text-sky-200'
                            : poi.owner === 'B'
                              ? 'border-orange-500/80 bg-orange-950/55 text-orange-200'
                              : 'border-neutral-700 bg-neutral-900/80 text-neutral-300';
                        const fillPct = Math.round(Math.abs(poi.progress) * 100);
                        const barColor = poi.progress >= 0 ? 'bg-sky-400' : 'bg-orange-400';
                        return (
                          <div
                            key={poi.id}
                            className={`flex min-w-[54px] flex-col items-center border px-1.5 py-0.5 text-[9px] uppercase ${ownerCls}`}
                          >
                            <span className="font-semibold tracking-wider">
                              {poi.code}
                              {poi.contested ? ' !' : poi.kind === 'fob' && poi.underAttack ? ' ATK' : ''}
                            </span>
                            <div className="mt-0.5 h-1 w-full bg-neutral-950/80">
                              <div
                                className={`h-full ${barColor}`}
                                style={{ width: `${fillPct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                      {(modeHud.conquestTerritoryRateA > 0 || modeHud.conquestTerritoryRateB > 0) && (
                        <div className="border border-neutral-800 bg-neutral-950/90 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-300">
                          <span className="text-sky-400">+{modeHud.conquestTerritoryRateA.toFixed(1)}/s</span>
                          {' · '}
                          <span className="text-orange-400">+{modeHud.conquestTerritoryRateB.toFixed(1)}/s</span>
                        </div>
                      )}
                      <div className="ml-0.5 border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300">
                        LOADOUTS {modeHud.conquestRemainingLives}/{modeHud.conquestTotalLives}
                      </div>
                      <div className="border border-neutral-800 bg-neutral-950/90 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
                        RES <span className="text-sky-400">{modeHud.conquestTeamRemainingLivesA}</span>
                        /
                        <span className="text-orange-400">{modeHud.conquestTeamRemainingLivesB}</span>
                      </div>
                    </div>
                  )}

                  {/* CTF Flag Status Row */}
                  {snapshot.battleRule === 'ctf' && modeHud?.ctfFlags && (
                    <div className="flex items-center gap-3 border-t border-neutral-800/90 pt-1 text-[10px] uppercase">
                      {modeHud.ctfFlags.map((flag) => (
                        <div
                          key={flag.team}
                          className={`flex items-center gap-1.5 border px-2 py-0.5 ${
                            flag.team === 'A'
                              ? 'border-sky-500/50 bg-sky-950/35 text-sky-200'
                              : 'border-orange-500/50 bg-orange-950/35 text-orange-200'
                          }`}
                        >
                          <span className="font-semibold">FLAG {flag.team}:</span>
                          <span
                            className={
                              flag.status === 'home'
                                ? 'text-emerald-300'
                                : flag.status === 'carried'
                                  ? 'text-amber-300'
                                  : 'text-red-300'
                            }
                          >
                            {flag.status === 'home'
                              ? 'HOME'
                              : flag.status === 'carried'
                                ? `TAKEN (${flag.carrierName ?? 'OP'})`
                                : `DROPPED ${Math.ceil(flag.returnTimerSec)}s`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* KOTH Active Hill & Rotation Preview */}
                  {snapshot.battleRule === 'koth' && modeHud?.koth && (
                    <div className="flex flex-wrap items-center justify-center gap-2 border-t border-neutral-800/90 pt-1 text-[10px] uppercase">
                      <span
                        className={`border px-2 py-0.5 font-semibold ${
                          modeHud.koth.contested
                            ? 'border-amber-400/80 bg-amber-950/50 text-amber-200'
                            : modeHud.koth.owner === 'A'
                              ? 'border-sky-500/70 bg-sky-950/50 text-sky-200'
                              : modeHud.koth.owner === 'B'
                                ? 'border-orange-500/70 bg-orange-950/50 text-orange-200'
                                : 'border-neutral-700 bg-neutral-900 text-neutral-200'
                        }`}
                      >
                        HILL: {modeHud.koth.activeHillLabel}
                        {modeHud.koth.contested
                          ? ' · CONTESTED'
                          : modeHud.koth.owner
                            ? ` · TEAM ${modeHud.koth.owner}`
                            : ' · OPEN'}
                      </span>
                      <span className="text-neutral-300">
                        ROTATE {Math.ceil(modeHud.koth.hillTimerSec)}s
                      </span>
                      {modeHud.koth.previewActive && (
                        <span className="text-amber-300">
                          NEXT: {modeHud.koth.nextHillLabel}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Kill Confirmed Separate Friendly Dogtags Tracker */}
                  {isKillConfirmedRule(snapshot.battleRule) && modeHud && (
                    <div className="flex flex-wrap items-center justify-center gap-3 border-t border-neutral-800/90 pt-1 text-[10px] uppercase">
                      {snapshot.battleRule === 'kc_tdm' ? (
                        <>
                          <span className="text-amber-300">
                            YOUR ENEMY TAGS: {modeHud.localEnemyTags}
                          </span>
                          <span className="text-sky-300">
                            SECURED FRIENDLY TAGS: YOU {modeHud.localFriendlyTags} · TEAM A{' '}
                            {modeHud.friendlyTagsA} / B {modeHud.friendlyTagsB}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-sky-300">
                            SECURED FRIENDLY (OWN TAGS): {modeHud.localFriendlyTags} (+XP ONLY)
                          </span>
                          <span className="text-neutral-400">
                            TAGS IN FIELD: {modeHud.activeDogtagCount}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </motion.div>

                {/* Active Objective / Standing-In-Sector Status */}
                {modeHud?.localStandingInObjective && (
                  <div className="border border-amber-400/70 bg-[#0d1015]/92 px-3 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                    {modeHud.localStandingInObjective}
                  </div>
                )}

                {/* Spawn Protection Active Indicator */}
                {snapshot.playerAlive && snapshot.spawnProtectionRemainingSec > 0.05 && (
                  <div className="border border-emerald-500/75 bg-emerald-950/85 px-3 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
                    SPAWN PROTECTION · {snapshot.spawnProtectionRemainingSec.toFixed(1)}s · ATTACKING CANCELS
                  </div>
                )}
              </div>
            )}
          </AnimatePresence>

          {/* Conquest Tactical Redeploy Screen (Choose Unused Loadout + HQ / Uncontested Friendly FOB) */}
          <AnimatePresence>
            {conquestRedeployOpen && modeHud && (
              <motion.div
                key="hud-conquest-redeploy"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={MODAL_TRANSITION}
                className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/76 p-5"
              >
                <div className="w-full max-w-3xl border border-neutral-700 bg-[#0d1015] p-5 text-neutral-100">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-800 pb-3">
                    <div>
                      <div className="font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-400">
                        Conquest Tactical Redeploy · 1 Life Per Loadout
                      </div>
                      <h2 className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wider text-neutral-50">
                        Select Unused Loadout &amp; Deployment Point
                      </h2>
                    </div>
                    <div className="border border-amber-500/45 bg-neutral-950 px-3 py-1.5 text-right font-mono-tabular">
                      <div className="text-[9px] uppercase tracking-wider text-neutral-400">
                        Remaining Loadouts
                      </div>
                      <div className="text-base font-bold text-amber-300">
                        {modeHud.conquestRemainingLives} / {modeHud.conquestTotalLives}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                    {/* Left: Custom Loadout Slots */}
                    <div>
                      <div className="mb-2 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                        1 · Unused Loadouts
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {modeHud.conquestLoadouts.map((slot) => {
                          const pName = resolveWeaponProfile(slot.primaryWeaponId).name;
                          const sName = resolveWeaponProfile(slot.secondaryWeaponId).name;
                          return (
                            <button
                              key={slot.id}
                              type="button"
                              disabled={slot.expended}
                              onClick={() => onSelectConquestLoadout?.(slot.id)}
                              className={`flex items-center justify-between border px-3 py-2 text-left font-mono-tabular transition-colors ${
                                slot.expended
                                  ? 'cursor-not-allowed border-neutral-800 bg-neutral-950/60 text-neutral-600 line-through'
                                  : slot.active
                                    ? 'cursor-pointer border-amber-400 bg-amber-500/15 text-neutral-50'
                                    : 'cursor-pointer border-neutral-800 bg-neutral-900/90 text-neutral-200 hover:border-neutral-600'
                              }`}
                            >
                              <div>
                                <div className="text-xs font-semibold uppercase">{slot.name}</div>
                                <div className="text-[10px] text-neutral-400">
                                  {pName} · {sName}
                                </div>
                              </div>
                              <span
                                className={`text-[10px] font-semibold uppercase tracking-wider ${
                                  slot.expended
                                    ? 'text-red-500/80'
                                    : slot.active
                                      ? 'text-amber-300'
                                      : 'text-emerald-400'
                                }`}
                              >
                                {slot.expended ? 'EXPENDED' : slot.active ? 'SELECTED' : 'READY'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Right: Team HQ & Uncontested Friendly FOBs */}
                    <div>
                      <div className="mb-2 font-mono-tabular text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">
                        2 · Spawn Location (HQ or Uncontested Friendly FOB)
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {modeHud.conquestSpawnOptions.map((opt) => {
                          const selected = modeHud.conquestSelectedSpawnId === opt.id && opt.available;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              disabled={!opt.available}
                              onClick={() => onSelectConquestSpawn?.(opt.id)}
                              className={`flex items-center justify-between border px-3 py-2 text-left font-mono-tabular transition-colors ${
                                !opt.available
                                  ? 'cursor-not-allowed border-red-900/60 bg-red-950/20 text-neutral-500'
                                  : selected
                                    ? 'cursor-pointer border-sky-400 bg-sky-500/15 text-neutral-50'
                                    : 'cursor-pointer border-neutral-800 bg-neutral-900/90 text-neutral-200 hover:border-neutral-600'
                              }`}
                            >
                              <div>
                                <div className="text-xs font-semibold uppercase">
                                  [{opt.code}] {opt.label}
                                </div>
                                <div className="text-[10px] text-neutral-400">
                                  {opt.kind === 'hq'
                                    ? 'Protected Team HQ · Always Safe'
                                    : opt.available
                                      ? 'Friendly Controlled FOB · Safe Spawn'
                                      : opt.reason ?? 'Unavailable'}
                                </div>
                              </div>
                              <span
                                className={`text-[10px] font-semibold uppercase tracking-wider ${
                                  !opt.available
                                    ? 'text-red-400'
                                    : selected
                                      ? 'text-sky-300'
                                      : 'text-emerald-400'
                                }`}
                              >
                                {!opt.available ? 'BLOCKED' : selected ? 'SELECTED' : 'SAFE'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-800 pt-3">
                    <button
                      type="button"
                      onClick={() =>
                        multiplayerSession
                          ? multiplayerSession.onLeaveMatch()
                          : onReturnToMenu('battle')
                      }
                      className="cursor-pointer border border-neutral-700 bg-neutral-950 px-4 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-200"
                    >
                      Leave Match
                    </button>
                    <button
                      type="button"
                      onClick={() => onConfirmConquestRedeploy?.()}
                      className="cursor-pointer bg-amber-500 px-6 py-2.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
                    >
                      Deploy Operator
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Respawn / Eliminated Spectating Banner */}
          <AnimatePresence>
            {!snapshot.playerAlive && !conquestRedeployOpen && snapshot.matchOutcome === 'active' && (
              snapshot.spectating || conquestSpectatingActive ? (
                <div className="pointer-events-auto fixed bottom-10 left-1/2 -translate-x-1/2">
                  <motion.div
                    key="hud-battle-spectating"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 16 }}
                    transition={HUD_SLIDE_TRANSITION}
                    className="border border-amber-500/70 bg-[#0d1015]/95 px-5 py-3 text-center"
                  >
                    <div className="font-mono-tabular text-[10px] uppercase tracking-[0.2em] text-amber-400">
                      {conquestSpectatingActive
                        ? 'All Loadouts Expended · Spectating Match'
                        : 'Eliminated · Spectating'}
                    </div>
                    <div className="mt-0.5 font-display text-xl font-bold uppercase tracking-wider text-neutral-50">
                      {snapshot.spectateOverview
                        ? 'Tactical Sector Overview'
                        : snapshot.spectatingTargetName
                          ? `Watching ${snapshot.spectatingTargetName}`
                          : 'Awaiting Match Conclusion'}
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2 font-mono-tabular text-[11px]">
                      <button
                        type="button"
                        onClick={() => onCycleSpectateTarget?.(-1)}
                        className="cursor-pointer border border-neutral-700 bg-neutral-900 px-3 py-1 uppercase tracking-wider text-neutral-200 hover:border-amber-400 hover:text-amber-300"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => onCycleSpectateTarget?.(1)}
                        className="cursor-pointer border border-neutral-700 bg-neutral-900 px-3 py-1 uppercase tracking-wider text-neutral-200 hover:border-amber-400 hover:text-amber-300"
                      >
                        Next
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleSpectateOverview?.()}
                        className={`cursor-pointer border px-3 py-1 uppercase tracking-wider ${
                          snapshot.spectateOverview
                            ? 'border-sky-400 bg-sky-500/20 text-sky-200'
                            : 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-sky-400'
                        }`}
                      >
                        {snapshot.spectateOverview ? 'Follow Operator' : 'Aerial Overview'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          multiplayerSession
                            ? multiplayerSession.onLeaveMatch()
                            : onReturnToMenu('battle')
                        }
                        className="cursor-pointer border border-red-900/80 bg-red-950/40 px-3 py-1 uppercase tracking-wider text-red-200 hover:bg-red-900/60"
                      >
                        Leave Match
                      </button>
                    </div>
                  </motion.div>
                </div>
              ) : (
                <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                  <motion.div
                    key="hud-battle-down"
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={MODAL_TRANSITION}
                    className="border border-red-600/80 bg-neutral-950/92 px-6 py-4 text-center"
                  >
                    <div className="font-display text-2xl font-bold uppercase tracking-wider text-red-400">
                      Operator Down
                    </div>
                    <div className="mt-1 font-mono-tabular text-xs text-neutral-300">
                      Redeploying in {snapshot.respawnTimerSec.toFixed(1)}s
                    </div>
                  </motion.div>
                </div>
              )
            )}
          </AnimatePresence>

          {/* Hold-Tab Live Scoreboard */}
          <AnimatePresence>
            {snapshot.scoreboardOpen && snapshot.matchOutcome === 'active' && (
              <div className="fixed top-1/2 left-1/2 w-full max-w-2xl -translate-x-1/2 -translate-y-1/2">
                <motion.div
                  key="hud-battle-scoreboard"
                  initial={{ opacity: 0, scale: 0.96, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 10 }}
                  transition={MODAL_TRANSITION}
                  className="border border-neutral-700 bg-neutral-950/94 p-4"
                >
                  <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
                    <span className="font-display text-lg font-bold uppercase tracking-wider text-neutral-50">
                      {formatBattleRuleName(snapshot.battleRule)} · {snapshot.mapName}
                    </span>
                    <span className="font-mono-tabular text-xs text-neutral-400">
                      Target {modeHud?.scoreLimit ?? snapshot.killLimit}
                    </span>
                  </div>
                  <div className="mt-2.5 flex flex-col gap-1 font-mono-tabular text-xs">
                    <div className="grid grid-cols-12 px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
                      <span className="col-span-4">Operator</span>
                      <span className="col-span-2">Unit</span>
                      <span className="col-span-3 text-right text-amber-400">
                        {isKillConfirmedRule(snapshot.battleRule)
                          ? 'Enemy / Friendly Tags'
                          : snapshot.battleRule === 'conquest'
                            ? 'Captures'
                            : snapshot.battleRule === 'ctf'
                              ? 'Caps / Rets'
                              : snapshot.battleRule === 'koth'
                                ? 'Hill Time'
                                : 'Score'}
                      </span>
                      <span className="col-span-1 text-right">K</span>
                      <span className="col-span-2 text-right">D</span>
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
                        <span className="col-span-4 truncate font-semibold">
                          {row.name}
                          {snapshot.battleRule === 'conquest' && (
                            <span
                              className={`ml-1.5 text-[9px] uppercase ${
                                row.conquestEliminated ? 'text-red-400' : 'text-neutral-400'
                              }`}
                            >
                              {row.conquestEliminated
                                ? 'OUT'
                                : row.conquestLivesRemaining !== undefined
                                  ? `[${row.conquestLivesRemaining}L]`
                                  : ''}
                            </span>
                          )}
                        </span>
                        <span
                          className={`col-span-2 text-[11px] ${
                            row.team === 'A'
                              ? 'text-sky-400'
                              : row.team === 'B'
                                ? 'text-orange-400'
                                : 'text-neutral-400'
                          }`}
                        >
                          {row.team === 'FFA' ? 'SOLO' : `TEAM ${row.team}`}
                        </span>
                        <span className="col-span-3 text-right font-semibold text-amber-300">
                          {isKillConfirmedRule(snapshot.battleRule)
                            ? `${row.enemyDogtags ?? 0} / ${row.friendlyDogtags ?? 0}`
                            : snapshot.battleRule === 'conquest'
                              ? `${row.poiCaptures ?? 0} · ${Math.round(row.territoryPoints ?? 0)}pt`
                              : snapshot.battleRule === 'ctf'
                                ? `${row.flagCaptures ?? 0} / ${row.flagReturns ?? 0}`
                                : snapshot.battleRule === 'koth'
                                  ? `${Math.round(row.hillControlSec ?? 0)}s`
                                  : `${row.kills}`}
                        </span>
                        <span className="col-span-1 text-right font-semibold">{row.kills}</span>
                        <span className="col-span-2 text-right text-neutral-400">{row.deaths}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* === INFECTION HUD ELEMENTS === */}
      {isInfection && (
        <>
          {/* Round Start / Intermission Announcement */}
          <AnimatePresence>
            {showMatchHud &&
              (snapshot.roundState.roundBannerSec > 0 || snapshot.roundState.intermissionSec > 0) && (
                <div className="fixed top-20 left-1/2 -translate-x-1/2 text-center">
                  <motion.div
                    key="hud-infection-banner"
                    initial={{ opacity: 0, y: -16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -16 }}
                    transition={HUD_SLIDE_TRANSITION}
                  >
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
                  </motion.div>
                </div>
              )}
          </AnimatePresence>

          {/* Co-op Infection Downed / Spectating Banner */}
          <AnimatePresence>
            {!snapshot.playerAlive && snapshot.spectating && !snapshot.gameOver && (
              <div className="fixed bottom-32 left-1/2 -translate-x-1/2">
                <motion.div
                  key="hud-infection-spectating"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 16 }}
                  transition={HUD_SLIDE_TRANSITION}
                  className="border border-red-500/70 bg-neutral-950/92 px-6 py-3 text-center"
                >
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
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/* Bottom-Left Distressed Crimson Round Numeral, Remaining, Power & Perks */}
          <AnimatePresence>
            {showMatchHud && (
              <motion.div
                key="hud-infection-round"
                initial={{ opacity: 0, x: -28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -28 }}
                transition={HUD_SLIDE_TRANSITION}
                className="fixed bottom-5 left-5 flex flex-col gap-2"
              >
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
              </motion.div>
            )}
          </AnimatePresence>

          {/* Center-Bottom [F] Interact / Hold [F] Barrier Repair Prompt */}
          <AnimatePresence>
            {showMatchHud && snapshot.pointerLocked && snapshot.nearbyPrompt && (
              <div className="fixed bottom-24 left-1/2 min-w-[260px] -translate-x-1/2">
                <motion.div
                  key="hud-infection-prompt"
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 14 }}
                  transition={HUD_SLIDE_TRANSITION}
                  className="border border-neutral-700 bg-neutral-950/92 px-4 py-2 text-center font-mono-tabular text-xs"
                >
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
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/* Points Counter & Floating +PTS Popups (Bottom-Right above Weapon Block) */}
          <AnimatePresence>
            {showMatchHud && (
              <motion.div
                key="hud-infection-points"
                initial={{ opacity: 0, x: 28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 28 }}
                transition={HUD_SLIDE_TRANSITION}
                className="fixed right-5 bottom-24 flex flex-col items-end"
              >
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
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* Subtle Center Hitmarker Ticks (Crosshair Hit Confirmation; Host-controllable in Battle) */}
      <AnimatePresence>
        {showMatchHud && snapshot.pointerLocked && showHitmarkers && snapshot.hitmarkerActive && (
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <motion.div
              key="hud-hitmarker-crosshair"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.15 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            >
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
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Authentic 4-Stage Grenade Manual of Arms Indicator */}
      <AnimatePresence>
        {showMatchHud && snapshot.pointerLocked && snapshot.grenadeHoldStage !== 'HOLSTERED' && (
          <div className="fixed top-[56%] left-1/2 w-80 -translate-x-1/2">
            <motion.div
              key="hud-grenade-indicator"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={HUD_SLIDE_TRANSITION}
              className={`flex flex-col gap-1 border px-3.5 py-1.5 font-mono-tabular ${
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
                    ? 'RMB PIN'
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
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Transient Toast */}
      <AnimatePresence>
        {showMatchHud && snapshot.toastMessage && (
          <div className="fixed bottom-12 left-1/2 -translate-x-1/2">
            <motion.div
              key="hud-toast"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={HUD_SLIDE_TRANSITION}
              className="border border-neutral-700/80 bg-neutral-950/90 px-3.5 py-1.5 font-mono-tabular text-xs text-neutral-100"
            >
              {snapshot.toastMessage}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Bottom-Right Health, Belt Ordnance & Weapon / Ammo Count Block */}
      <AnimatePresence>
        {showMatchHud && (
          <motion.div
            key="hud-ammo-health"
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 36 }}
            transition={HUD_SLIDE_TRANSITION}
            className="fixed right-5 bottom-4 flex flex-col items-end gap-1.5"
          >
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
                    {snapshot.nvgActive && (
                      <span
                        className={`border px-1 text-[9px] font-semibold ${
                          snapshot.irIlluminatorOn
                            ? 'border-amber-400 bg-amber-950/80 text-amber-200'
                            : 'border-neutral-700 bg-neutral-900 text-neutral-400'
                        }`}
                      >
                        IR {snapshot.irIlluminatorOn ? 'ON' : 'OFF'}
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
          </motion.div>
        )}
      </AnimatePresence>

      {/* Contextual Door Interact Crosshair Dot + [F] Scroll Menu */}
      <AnimatePresence>
        {showMatchHud &&
          snapshot.pointerLocked &&
          snapshot.playerAlive &&
          !snapshot.isPdaOpen &&
          snapshot.doorInteractReticle !== 'hidden' && (
            <motion.div
              key="hud-interact-reticle"
              initial={{ opacity: 0, scale: 0.78, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.78, y: 6 }}
              transition={HUD_SLIDE_TRANSITION}
              className="pointer-events-none fixed inset-0 flex flex-col items-center justify-center"
            >
              <div
                className={`h-1.5 w-1.5 rounded-full transition-transform duration-150 ${
                  snapshot.doorInteractReticle === 'ready'
                    ? 'scale-125 bg-amber-400'
                    : 'bg-neutral-100/80'
                }`}
              />
              <AnimatePresence>
                {snapshot.doorPrompt && snapshot.doorPrompt.options.length > 0 && (
                  <motion.div
                    key="hud-door-prompt"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={HUD_SLIDE_TRANSITION}
                    className="mt-5 min-w-[184px] border border-white/12 bg-[#0d0f12]/92 px-2.5 py-2"
                    style={{ borderRadius: 4 }}
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-white/10 pb-1 text-[11px] font-medium tracking-wide text-neutral-400">
                      <span>{snapshot.doorPrompt.targetLabel}</span>
                      {snapshot.doorPrompt.options.length > 1 && (
                        <span className="font-mono-tabular text-[10px] text-neutral-500">Scroll</span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      {snapshot.doorPrompt.options.map((opt, idx) => {
                        const selected = idx === snapshot.doorPrompt!.selectedIndex;
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
                                    {snapshot.doorPrompt!.key}
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
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
      </AnimatePresence>

      {/* === PAUSE OVERLAY (Unlocked during active session) === */}
      <AnimatePresence>
        {paused && (
          <motion.div
            key="hud-pause-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MODAL_TRANSITION}
            className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-neutral-950/65 p-6"
          >
            <motion.div
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.98 }}
              transition={MODAL_TRANSITION}
              className="w-full max-w-md border border-neutral-700 bg-neutral-950/95 p-6 text-neutral-100"
            >
              <div
                className={`font-mono-tabular text-[10px] uppercase tracking-[0.2em] ${
                  isInfection ? 'text-red-400' : 'text-amber-400'
                }`}
              >
                {isInfection
                  ? `Infection · Round ${snapshot.roundState.round}`
                  : `${formatBattleRuleName(snapshot.battleRule)} · ${snapshot.mapName}`}
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
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTunerTab('optics');
                      onToggleTuner(true);
                    }}
                    className="cursor-pointer border border-neutral-700 bg-neutral-900 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
                  >
                    F1 · Optics &amp; Gear
                  </button>
                  <button
                    type="button"
                    onClick={() => openGameSettings('controls')}
                    className="cursor-pointer border border-neutral-700 bg-neutral-900 py-2 font-mono-tabular text-xs uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
                  >
                    Settings &amp; Controls
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!hostHudEnabled}
                  onClick={() => setLocalHudVisible((prev) => !prev)}
                  className={`w-full border py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    showMatchHud
                      ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/40 text-emerald-300'
                      : 'cursor-pointer border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {hostHudEnabled
                    ? `HUD Overlay: ${localHudVisible ? 'ON' : 'OFF'}`
                    : 'HUD Overlay: OFF (Host Locked)'}
                </button>
                {isBattle && (
                  <div className="border border-neutral-800 bg-neutral-900/75 p-3">
                    <div className="mb-2 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-amber-300">
                      <span>{canEditHostBattleRules ? 'Host Match Rules' : 'Host Match Rules (Locked)'}</span>
                      {multiplayerSession && (
                        <span className="text-neutral-500">Live Sync</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!canEditHostBattleRules}
                        onClick={() =>
                          applyHostVisibility({ hitmarkersEnabled: !snapshot.hitmarkersEnabled })
                        }
                        className={`border px-2.5 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-65 ${
                          snapshot.hitmarkersEnabled
                            ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/45 text-emerald-300'
                            : 'cursor-pointer border-neutral-700 bg-neutral-950 text-neutral-400'
                        }`}
                      >
                        Hitmarkers: {snapshot.hitmarkersEnabled ? 'ON' : 'OFF'}
                      </button>
                      <button
                        type="button"
                        disabled={!canEditHostBattleRules}
                        onClick={() => applyHostVisibility({ hudEnabled: !snapshot.hudEnabled })}
                        className={`border px-2.5 py-1.5 font-mono-tabular text-[11px] font-semibold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-65 ${
                          snapshot.hudEnabled
                            ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/45 text-emerald-300'
                            : 'cursor-pointer border-neutral-700 bg-neutral-950 text-neutral-400'
                        }`}
                      >
                        Combat HUD: {snapshot.hudEnabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                  </div>
                )}
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* === COMPACT F1 OPTICS & CONTROLS SETTINGS DRAWER === */}
      <AnimatePresence>
        {snapshot.tunerOpen && (
          <motion.div
            key="hud-tuner-drawer"
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 36 }}
            transition={MODAL_TRANSITION}
            className="pointer-events-auto fixed top-5 right-5 z-30 flex max-h-[90vh] w-80 flex-col border border-neutral-700 bg-neutral-950/96 p-4 text-neutral-100"
          >
            <div className="flex items-center justify-between border-b border-neutral-800 pb-2">
              <span className="font-display text-base font-bold uppercase tracking-wider">
                Game Settings (F1)
              </span>
              <button
                type="button"
                onClick={() => onToggleTuner(false)}
                className="cursor-pointer font-mono-tabular text-xs text-neutral-400 hover:text-neutral-100"
              >
                Close
              </button>
            </div>

            <div className="mt-2.5 grid grid-cols-2 gap-1 border-b border-neutral-800 pb-2.5 font-mono-tabular text-[10px] uppercase">
              <button
                type="button"
                onClick={() => setTunerTab('optics')}
                className={`cursor-pointer whitespace-nowrap border py-1.5 font-semibold transition-colors ${
                  tunerTab === 'optics'
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Optics &amp; Gear
              </button>
              <button
                type="button"
                onClick={() => setTunerTab('controls')}
                className={`cursor-pointer whitespace-nowrap border py-1.5 font-semibold transition-colors ${
                  tunerTab === 'controls'
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                Controls
              </button>
            </div>

            <div className="mt-3 flex flex-1 flex-col gap-3 overflow-y-auto pr-0.5 text-xs">
              {tunerTab === 'controls' ? (
                <ControlsSettingsTab compact />
              ) : (
                <>
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

                  {/* HUD Visibility, Killfeed & Graphics Quality */}
                  <div className="border-t border-neutral-800 pt-3">
                    <div className="mb-1.5 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                      <span>HUD Overlay</span>
                      <button
                        type="button"
                        disabled={!hostHudEnabled}
                        onClick={() => setLocalHudVisible((prev) => !prev)}
                        className={`border px-2 py-0.5 text-[10px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                          showMatchHud
                            ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                            : 'cursor-pointer border-neutral-700 bg-neutral-900 text-neutral-400'
                        }`}
                      >
                        {hostHudEnabled ? (localHudVisible ? 'ON' : 'OFF') : 'HOST OFF'}
                      </button>
                    </div>

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

                    {isBattle && (
                      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          disabled={!canEditHostBattleRules}
                          onClick={() =>
                            applyHostVisibility({ hitmarkersEnabled: !snapshot.hitmarkersEnabled })
                          }
                          className={`border py-1 font-mono-tabular text-[9px] font-semibold uppercase disabled:cursor-not-allowed disabled:opacity-60 ${
                            snapshot.hitmarkersEnabled
                              ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                              : 'cursor-pointer border-neutral-700 bg-neutral-900 text-neutral-400'
                          }`}
                        >
                          Hitmarkers: {snapshot.hitmarkersEnabled ? 'ON' : 'OFF'}
                        </button>
                        <button
                          type="button"
                          disabled={!canEditHostBattleRules}
                          onClick={() => applyHostVisibility({ hudEnabled: !snapshot.hudEnabled })}
                          className={`border py-1 font-mono-tabular text-[9px] font-semibold uppercase disabled:cursor-not-allowed disabled:opacity-60 ${
                            snapshot.hudEnabled
                              ? 'cursor-pointer border-emerald-500/70 bg-emerald-950/50 text-emerald-300'
                              : 'cursor-pointer border-neutral-700 bg-neutral-900 text-neutral-400'
                          }`}
                        >
                          HUD: {snapshot.hudEnabled ? 'ON' : 'OFF'}
                        </button>
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
                      <div className="mt-2 flex items-center justify-between font-mono-tabular text-[10px] uppercase tracking-wider text-neutral-400">
                        <span>Adaptive Scaling</span>
                        <button
                          type="button"
                          onClick={() => setAdaptiveScaling(!adaptiveScaling)}
                          className={`cursor-pointer border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap shrink-0 ${
                            adaptiveScaling
                              ? 'border-sky-500/70 bg-sky-950/50 text-sky-300'
                              : 'border-neutral-700 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                          }`}
                          title="Auto-scale DPR if frame rate drops below target (OFF by default)"
                        >
                          {adaptiveScaling ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={onRequestLock}
              className="mt-3 w-full cursor-pointer bg-amber-500 py-2 font-display text-xs font-bold uppercase tracking-wider text-neutral-950 hover:bg-amber-400"
            >
              Resume Combat
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* === BATTLE VICTORY / DEFEAT MODAL === */}
      <AnimatePresence>
        {isBattle && snapshot.matchOutcome !== 'active' && (
          <motion.div
            key="hud-battle-outcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MODAL_TRANSITION}
            className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/78 p-6"
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={MODAL_TRANSITION}
              className="w-full max-w-xl border border-neutral-700 bg-neutral-950 p-6 text-neutral-100"
            >
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

              <div className="mt-3 flex flex-wrap items-center gap-6 border-y border-neutral-800 py-2.5 font-mono-tabular text-xs text-neutral-300">
                {isTeamBattleRule(snapshot.battleRule) ? (
                  <span>
                    Team A <strong className="text-sky-300">{Math.round(snapshot.scoreA)}</strong> — Team B{' '}
                    <strong className="text-orange-400">{Math.round(snapshot.scoreB)}</strong>
                  </span>
                ) : (
                  <span>
                    Leader: <strong className="text-amber-300">{snapshot.ffaLeaderName}</strong> (
                    {snapshot.ffaLeaderKills})
                  </span>
                )}
                {isKillConfirmedRule(snapshot.battleRule) && modeHud && (
                  <>
                    <span>
                      Your Enemy Tags:{' '}
                      <strong className="text-amber-300">{modeHud.localEnemyTags}</strong>
                    </span>
                    <span>
                      Secured Friendly:{' '}
                      <strong className="text-sky-300">{modeHud.localFriendlyTags}</strong>
                    </span>
                  </>
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* === INFECTION GAME OVER MODAL === */}
      <AnimatePresence>
        {isInfection && snapshot.gameOver && (
          <motion.div
            key="hud-infection-gameover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MODAL_TRANSITION}
            className="pointer-events-auto fixed inset-0 z-30 flex items-center justify-center bg-neutral-950/82 p-6"
          >
            <motion.div
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97 }}
              transition={MODAL_TRANSITION}
              className="w-full max-w-md border border-red-800/80 bg-neutral-950 p-6 text-neutral-100"
            >
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
};

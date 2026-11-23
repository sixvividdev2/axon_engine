import { useEffect, useRef, useState } from 'react';
import { tacticalEquipmentStore } from './bodycam-sdk';
import {
  CombatSessionEngine,
  CombatSessionParams,
  CombatSessionSnapshot,
  MultiplayerSessionBridge,
} from './combat/CombatSessionEngine';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LobbyProvider, useLobby } from './context/LobbyContext';
import { SocialProvider, useSocial } from './context/SocialContext';
import { loadoutStore } from './data/loadoutStore';
import { buildGuestMatchSummary, MatchProgressionSummary, MatchResultInput } from './data/progression';
import { GymEngine, GymSnapshot } from './gym/GymEngine';
import { GymHud } from './gym/GymHud';
import { GymTunerPanel } from './gym/GymTunerPanel';
import {
  BattleMatchConfig,
  InfectionMatchConfig,
} from './maps/types';
import { AccountSettingsModal } from './ui/AccountSettingsModal';
import { AuthModal } from './ui/AuthModal';
import { CombatHud, MultiplayerHudControls } from './ui/CombatHud';
import { HubTabId, MainMenuHub } from './ui/MainMenuHub';
import { RankUpCinematic } from './ui/RankUpCinematic';
import { SocialHubDrawer } from './ui/SocialHubDrawer';
import { SocialInviteToast } from './ui/SocialInviteToast';
import { UnifiedLoadoutWorkbench } from './ui/UnifiedLoadoutWorkbench';

type ActiveView =
  | { kind: 'menu'; tab: HubTabId }
  | { kind: 'playground' }
  | { kind: 'combat'; params: CombatSessionParams; sessionKey: number; isMultiplayer: boolean };

const DEFAULT_BATTLE_CONFIG: BattleMatchConfig = {
  mapId: 'pripyat_block',
  rule: 'tdm',
  botCount: 6,
  killLimit: 30,
  difficulty: 'tactical',
  primaryWeaponId: 'm4a1',
  secondaryWeaponId: 'makarov_pm',
  weatherPreset: 'auto',
  timeOfDayStart: 'auto',
};

const DEFAULT_INFECTION_CONFIG: InfectionMatchConfig = {
  mapId: 'kino_theater',
  botCount: 0,
  botDifficulty: 'tactical',
  weatherPreset: 'auto',
  timeOfDayStart: 'auto',
};

function PlaygroundView({ onReturnToMenu }: { onReturnToMenu: () => void }) {
  const { effectiveRank, isWeaponUnlocked, isAttachmentUnlocked, getWeaponProgress } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GymEngine | null>(null);
  const [snapshot, setSnapshot] = useState<GymSnapshot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const engine = new GymEngine(el);
    engineRef.current = engine;
    const unsub = engine.subscribe((next) => {
      setSnapshot(next);
    });

    return () => {
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const engine = engineRef.current;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-neutral-950">
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {snapshot && (
        <GymHud
          snapshot={snapshot}
          onRequestLock={() => engine?.requestLock()}
          onOpenTuner={() => engine?.setTunerOpen(true)}
          onTeleportZone={(zone) => engine?.teleportToZone(zone)}
          onReturnToMenu={onReturnToMenu}
        />
      )}

      {snapshot && snapshot.tunerOpen && (
        <GymTunerPanel
          snapshot={snapshot}
          onUpdateConfig={(patch) => engine?.updateConfig(patch)}
          onApplyLensPreset={(preset) => engine?.applyLensPreset(preset)}
          onResetConfig={() => engine?.resetConfig()}
          onTeleportZone={(zone) => engine?.teleportToZone(zone)}
          onSwitchWeapon={(id) => {
            if (isWeaponUnlocked(id)) {
              engine?.switchWeapon(id);
            }
          }}
          onSelectAmmoVariant={(variantId) => engine?.selectAmmoVariant(variantId)}
          onToggleFireMode={() => engine?.toggleFireMode()}
          onToggleSuppressor={() => engine?.toggleSuppressor()}
          onToggleReticleIllumination={() => engine?.toggleReticleIllumination()}
          onToggleArmTrauma={() => engine?.toggleSimulatedArmTrauma()}
          onSelectTacticalEquipment={(id) => engine?.setTacticalEquipment(id)}
          onSelectTacticalBeltSlot={(slot) => engine?.setTacticalBeltSlot(slot)}
          onToggleTacticalMountOnBelt={(mount) => engine?.setTacticalMountOnBelt(mount)}
          onRestockTacticalEquipment={() => engine?.restockTacticalEquipment()}
          onQuickThrowTactical={() => {
            engine?.setTunerOpen(false);
            engine?.triggerQuickThrow();
          }}
          onClose={() => engine?.setTunerOpen(false)}
          onResumeLock={() => engine?.requestLock()}
          onReturnToMenu={onReturnToMenu}
        />
      )}

      {snapshot && snapshot.gunsmithOpen && (
        <UnifiedLoadoutWorkbench
          gymBridge={{
            weaponId: snapshot.equippedWeaponId,
            weaponName: snapshot.equippedWeaponName,
            caliberLabel: snapshot.equippedCaliber,
            activeCaliberId: snapshot.activeCaliberId,
            activeAmmoVariantId: snapshot.activeAmmoVariantId,
            toggleablePumpSemi: snapshot.toggleablePumpSemi,
            spas12Mode: snapshot.spas12Mode,
            attachments: snapshot.attachments,
            stats: snapshot.derivedStats,
            pins: snapshot.gunsmithPins,
            zeroDistanceM: snapshot.zeroDistanceM,
            zeroElevationMrad: snapshot.zeroElevationMrad,
            heightOverBoreM: snapshot.heightOverBoreM,
            onSelectWeapon: (id) => engine?.selectGunsmithWeapon(id),
            onSelectAmmoVariant: (variantId) => engine?.selectAmmoVariant(variantId),
            onSelectZeroDistance: (distanceM) => engine?.selectZeroDistance(distanceM),
            onAdjustElevationMrad: (mrad) => engine?.adjustZeroElevationMrad(mrad),
            onTestFireSound: () => engine?.playGunsmithTestFireSound(),
            onTurretClickSound: (up) => engine?.playGunsmithTurretClick(up),
            onToggleFireMode: () => engine?.toggleFireMode(),
            onSelectAttachment: (slot, attachmentId) => {
              if (attachmentId && !isAttachmentUnlocked(attachmentId)) return;
              if (!isWeaponUnlocked(snapshot.equippedWeaponId)) return;
              engine?.selectGunsmithAttachment(slot, attachmentId);
            },
            onSelectReticleColor: (slot, colorId) =>
              engine?.selectGunsmithReticleColor(slot, colorId),
            onStripAll: () => engine?.stripGunsmithWeapon(),
            onOrbit: (dx, dy) => engine?.orbitGunsmith(dx, dy),
            onZoom: (deltaY) => engine?.zoomGunsmith(deltaY),
          }}
          careerRank={effectiveRank}
          getWeaponProgress={getWeaponProgress}
          isWeaponUnlocked={isWeaponUnlocked}
          isAttachmentUnlocked={isAttachmentUnlocked}
          onClose={() => engine?.closeGunsmith()}
          closeLabel="Return to Range"
        />
      )}
    </main>
  );
}

function CombatSessionView({
  params,
  multiplayerSession,
  onRestartInfection,
  onReturnToMenu,
}: {
  params: CombatSessionParams;
  multiplayerSession?: MultiplayerHudControls | null;
  onRestartInfection: () => void;
  onReturnToMenu: (tab?: 'battle' | 'infection') => void;
}) {
  const { user, commitMatch, openAuthModal } = useAuth();
  const { lobby } = useLobby();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CombatSessionEngine | null>(null);
  const [snapshot, setSnapshot] = useState<CombatSessionSnapshot | null>(null);
  const [rankSummary, setRankSummary] = useState<MatchProgressionSummary | null>(null);
  const committedMatchRef = useRef<boolean>(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    committedMatchRef.current = false;
    setRankSummary(null);

    const engine = new CombatSessionEngine(el, params);
    engineRef.current = engine;
    const unsub = engine.subscribe((next) => {
      setSnapshot(next);
    });

    return () => {
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, [params]);

  // Keep RemotePlayerManager roster pruned & hand over Host AI authority on live Host Migration
  useEffect(() => {
    if (lobby && engineRef.current) {
      engineRef.current.syncMultiplayerMembers(
        lobby.members,
        Boolean(user && lobby.hostUserId === user.id),
      );
    }
  }, [lobby, user]);

  // Track match completion and display full post-match summary (MVP, leaderboard, badges + career XP for signed-in users)
  useEffect(() => {
    if (!snapshot || committedMatchRef.current) return;
    const matchEnded =
      (snapshot.mode === 'battle' && snapshot.matchOutcome !== 'active') ||
      (snapshot.mode === 'infection' && snapshot.gameOver);
    if (!matchEnded) return;

    committedMatchRef.current = true;
    const outcome =
      snapshot.mode === 'battle'
        ? snapshot.matchOutcome === 'victory'
          ? 'victory'
          : 'defeat'
        : 'completed';

    const combatants = snapshot.combatants.map((c) =>
      c.isLocalPlayer && c.name === 'YOU' && user?.username
        ? { ...c, name: user.username }
        : c,
    );

    const matchInput: MatchResultInput = {
      mode: snapshot.mode,
      kills: snapshot.playerKills,
      headshots: snapshot.playerHeadshots,
      deaths: snapshot.playerDeaths,
      outcome,
      infectionRound: snapshot.mode === 'infection' ? snapshot.roundState.round : undefined,
      weaponKills: snapshot.weaponKills,
      mapName: snapshot.mapName,
      matchDurationSec: snapshot.matchDurationSec,
      combatants,
    };

    if (!user) {
      setRankSummary(buildGuestMatchSummary(matchInput));
      return;
    }

    void commitMatch(matchInput).then((summary) => {
      setRankSummary(summary ?? buildGuestMatchSummary(matchInput));
    });
  }, [snapshot, user, commitMatch]);

  const engine = engineRef.current;

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-neutral-950">
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {snapshot && (
        <CombatHud
          snapshot={snapshot}
          multiplayerSession={multiplayerSession}
          onRequestLock={() => engine?.requestLock()}
          onToggleTuner={(open) => engine?.setTunerOpen(open)}
          onUpdateConfig={(patch) => engine?.updateConfig(patch)}
          onApplyLensPreset={(preset) => engine?.applyLensPreset(preset)}
          onSelectTacticalEquipment={(id) => engine?.setTacticalEquipment(id)}
          onSelectTacticalBeltSlot={(slot) => engine?.setTacticalBeltSlot(slot)}
          onToggleTacticalMountOnBelt={(mount) => engine?.setTacticalMountOnBelt(mount)}
          onRematch={() => {
            committedMatchRef.current = false;
            setRankSummary(null);
            if (params.mode === 'battle') {
              engine?.rematchBattle();
            } else {
              onRestartInfection();
            }
          }}
          onReturnToMenu={onReturnToMenu}
        />
      )}

      {rankSummary && (
        <RankUpCinematic
          summary={rankSummary}
          onContinue={() => setRankSummary(null)}
          onSignIn={
            rankSummary.isGuest
              ? () => openAuthModal('Sign in to save career XP, rank progression, and weapon unlocks.')
              : undefined
          }
        />
      )}
    </main>
  );
}

function AppShell() {
  const { user } = useAuth();
  const { updatePresence } = useSocial();
  const {
    lobby,
    isHost,
    matchSignal,
    updateSettings,
    hostRestartMatch,
    hostEndMatchToLobby,
    leaveLobby,
    sendGameMessage,
    subscribeGameMessages,
  } = useLobby();
  const [battleConfig, setBattleConfig] = useState<BattleMatchConfig>(DEFAULT_BATTLE_CONFIG);
  const [infectionConfig, setInfectionConfig] =
    useState<InfectionMatchConfig>(DEFAULT_INFECTION_CONFIG);
  const [view, setView] = useState<ActiveView>({ kind: 'menu', tab: 'battle' });
  const lastHandledSignalSeqRef = useRef<number>(0);

  // React to authoritative multiplayer lobby match start / restart / return-all-to-lobby signals
  useEffect(() => {
    if (!matchSignal || matchSignal.seq === lastHandledSignalSeqRef.current) return;
    lastHandledSignalSeqRef.current = matchSignal.seq;

    if (matchSignal.kind === 'end_to_lobby') {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      setView({ kind: 'menu', tab: 'multiplayer' });
      return;
    }

    const st = matchSignal.lobby;
    const localMember = user ? st.members.find((m) => m.userId === user.id) : null;
    const mpBridge: MultiplayerSessionBridge | undefined = user
      ? {
          lobbyCode: st.code,
          localUserId: user.id,
          localUsername: user.username,
          localTeam: localMember?.team ?? 'A',
          isHost: st.hostUserId === user.id,
          members: st.members,
          specialEventConfig: st.specialEvent?.config ?? null,
          sendMessage: sendGameMessage,
          subscribeMessages: subscribeGameMessages,
        }
      : undefined;

    const activeLoadout = loadoutStore.getActiveSlot();
    const selectedTacticalId =
      tacticalEquipmentStore.getSelection().equipmentId || activeLoadout.tacticalEquipmentId;
    const maxInfectionBots = Math.max(0, st.maxPlayers - st.members.length);
    const weatherPreset = st.weatherPreset ?? st.specialEvent?.config.weatherPreset ?? 'auto';
    const timeOfDayStart =
      st.timeOfDayStart ?? st.specialEvent?.config.timeOfDayStart ?? 'auto';
    const params: CombatSessionParams =
      st.mode === 'infection'
        ? {
            mode: 'infection',
            infectionConfig: {
              mapId: st.mapId,
              botCount: st.botsEnabled ? Math.min(st.botCount, maxInfectionBots) : 0,
              botDifficulty: st.botDifficulty,
              tacticalEquipmentId: selectedTacticalId,
              weatherPreset,
              timeOfDayStart,
            },
            multiplayer: mpBridge,
          }
        : {
            mode: 'battle',
            battleConfig: {
              mapId: st.mapId,
              rule: st.battleRule,
              botCount: st.botsEnabled ? st.botCount : 0,
              killLimit: st.killLimit,
              difficulty: st.botDifficulty,
              primaryWeaponId: activeLoadout.primaryWeaponId || battleConfig.primaryWeaponId,
              secondaryWeaponId: activeLoadout.secondaryWeaponId || battleConfig.secondaryWeaponId,
              tacticalEquipmentId: selectedTacticalId,
              weatherPreset,
              timeOfDayStart,
            },
            multiplayer: mpBridge,
          };

    setView({
      kind: 'combat',
      params,
      sessionKey: Date.now() + matchSignal.seq,
      isMultiplayer: true,
    });
  }, [
    matchSignal,
    user,
    battleConfig.primaryWeaponId,
    battleConfig.secondaryWeaponId,
    sendGameMessage,
    subscribeGameMessages,
  ]);

  useEffect(() => {
    if (view.kind === 'combat' && !view.isMultiplayer) {
      updatePresence('in_match', null);
    } else if (view.kind !== 'combat' && !lobby) {
      updatePresence('online', null);
    }
  }, [view, lobby, updatePresence]);

  const multiplayerHudControls: MultiplayerHudControls | null =
    view.kind === 'combat' && view.isMultiplayer && lobby
      ? {
          isHost,
          lobbyCode: lobby.code,
          eventName: lobby.specialEvent?.name ?? null,
          killfeedPolicy: lobby.killfeedPolicy ?? 'player_choice',
          localPlayerName: user?.username ?? 'YOU',
          onHostUpdateKillfeedPolicy: (policy) => updateSettings({ killfeedPolicy: policy }),
          onHostRestart: hostRestartMatch,
          onHostEndToLobby: hostEndMatchToLobby,
          onLeaveMatch: () => {
            if (document.pointerLockElement) {
              document.exitPointerLock();
            }
            leaveLobby();
            setView({ kind: 'menu', tab: 'multiplayer' });
          },
        }
      : null;

  return (
    <>
      {view.kind === 'menu' && (
        <MainMenuHub
          initialTab={view.tab}
          initialBattleConfig={battleConfig}
          initialInfectionConfig={infectionConfig}
          onLaunchPlayground={() => setView({ kind: 'playground' })}
          onLaunchBattle={(cfg) => {
            setBattleConfig(cfg);
            setView({
              kind: 'combat',
              params: { mode: 'battle', battleConfig: cfg },
              sessionKey: Date.now(),
              isMultiplayer: false,
            });
          }}
          onLaunchInfection={(cfg) => {
            setInfectionConfig(cfg);
            setView({
              kind: 'combat',
              params: { mode: 'infection', infectionConfig: cfg },
              sessionKey: Date.now(),
              isMultiplayer: false,
            });
          }}
        />
      )}

      {view.kind === 'playground' && (
        <PlaygroundView
          onReturnToMenu={() => setView({ kind: 'menu', tab: 'playground' })}
        />
      )}

      {view.kind === 'combat' && (
        <CombatSessionView
          key={view.sessionKey}
          params={view.params}
          multiplayerSession={multiplayerHudControls}
          onRestartInfection={() =>
            setView({
              kind: 'combat',
              params: view.params,
              sessionKey: Date.now(),
              isMultiplayer: view.isMultiplayer,
            })
          }
          onReturnToMenu={(tab) =>
            setView({
              kind: 'menu',
              tab: view.isMultiplayer ? 'multiplayer' : (tab ?? 'battle'),
            })
          }
        />
      )}

      <AuthModal />
      <AccountSettingsModal />
      <SocialHubDrawer />
      <SocialInviteToast />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SocialProvider>
        <LobbyProvider>
          <AppShell />
        </LobbyProvider>
      </SocialProvider>
    </AuthProvider>
  );
}

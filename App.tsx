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
import {
  buildGuestMatchSummary,
  buildRecentMatchRecord,
  MatchProgressionSummary,
  MatchResultInput,
} from './data/progression';
import { guestRecentMatchStore } from './data/recentMatchStore';
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
import { GameSettingsModal } from './ui/GameSettingsModal';
import { HubTabId, MainMenuHub } from './ui/MainMenuHub';
import { RankUpCinematic } from './ui/RankUpCinematic';
import { SocialHubDrawer } from './ui/SocialHubDrawer';
import { SocialInviteToast } from './ui/SocialInviteToast';
import { BackpackUnlockToast } from './ui/BackpackUnlockToast';
import { UnifiedLoadoutWorkbench } from './ui/UnifiedLoadoutWorkbench';
import { HideoutView } from './hideout/HideoutView';
import { CharacterSlotId, OpenWorldView } from './src/modes/openworld';
import { TutorialView } from './tutorial/TutorialView';

type ActiveView =
  | { kind: 'hideout' }
  | { kind: 'openworld'; slotId: CharacterSlotId | null }
  | { kind: 'menu'; tab: HubTabId }
  | { kind: 'playground' }
  | { kind: 'tutorial'; returnTo: 'hideout' | 'playground' | 'openworld'; openWorldSlotId?: CharacterSlotId | null }
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
  hitmarkersEnabled: true,
  hudEnabled: true,
};

const DEFAULT_INFECTION_CONFIG: InfectionMatchConfig = {
  mapId: 'kino_theater',
  botCount: 0,
  botDifficulty: 'tactical',
  weatherPreset: 'auto',
  timeOfDayStart: 'auto',
};

function PlaygroundView({
  onReturnToMenu,
  onLaunchTutorial,
}: {
  onReturnToMenu: () => void;
  onLaunchTutorial: () => void;
}) {
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
          onLaunchTutorial={onLaunchTutorial}
          onReturnToMenu={onReturnToMenu}
          onCloseInventory={() => engine?.closeInventory(true)}
          onMutateInventory={(nextInv, nextExternal, statusNote) =>
            engine?.applyInventoryMutation(nextInv, nextExternal, statusNote)
          }
          onTriggerDragReload={(slotKey, locator) =>
            engine?.triggerInventoryDragReload(slotKey, locator)
          }
          onUseMedicalItem={(locator, med) => engine?.useMedicalItemFromInventory(locator, med)}
          onDropEquippedBackpack={() => {
            engine?.dropEquippedBackpack();
          }}
          onEquipGroundBackpack={(containerId) =>
            engine?.equipGroundBackpack(containerId) ?? {
              ok: false,
              error: 'Playground not ready.',
            }
          }
          onRestockBenchAmmo={() => engine?.restockBenchAmmo()}
          onMagPackTickAudio={() => engine?.playMagPackTickAudio()}
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
  onUpdateSoloBattleVisibility,
  onRestartInfection,
  onLaunchTutorial,
  onReturnToMenu,
}: {
  params: CombatSessionParams;
  multiplayerSession?: MultiplayerHudControls | null;
  onUpdateSoloBattleVisibility?: (patch: {
    hitmarkersEnabled?: boolean;
    hudEnabled?: boolean;
  }) => void;
  onRestartInfection: () => void;
  onLaunchTutorial?: () => void;
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

  // Keep RemotePlayerManager roster pruned, hand over Host AI authority on live Host Migration,
  // and sync live Host Battle HUD/Hitmarker visibility toggles across all clients
  useEffect(() => {
    if (lobby && engineRef.current) {
      engineRef.current.syncMultiplayerMembers(
        lobby.members,
        Boolean(user && lobby.hostUserId === user.id),
      );
      if (params.mode === 'battle') {
        engineRef.current.setHostMatchVisibility({
          hitmarkersEnabled: lobby.hitmarkersEnabled !== false,
          hudEnabled: lobby.hudEnabled !== false,
        });
      }
    }
  }, [lobby, user, params.mode]);

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

    const localCombatant = combatants.find((c) => c.isLocalPlayer);
    const mh = snapshot.modeHud;
    const matchInput: MatchResultInput = {
      mode: snapshot.mode,
      battleRule: snapshot.mode === 'battle' ? snapshot.battleRule : undefined,
      kills: snapshot.playerKills,
      headshots: snapshot.playerHeadshots,
      deaths: snapshot.playerDeaths,
      outcome,
      infectionRound: snapshot.mode === 'infection' ? snapshot.roundState.round : undefined,
      weaponKills: snapshot.weaponKills,
      mapId: snapshot.mapId,
      mapName: snapshot.mapName,
      matchDurationSec: snapshot.matchDurationSec,
      combatants,
      enemyDogtags: localCombatant?.enemyDogtags ?? mh?.localEnemyTags ?? 0,
      friendlyDogtags: localCombatant?.friendlyDogtags ?? mh?.localFriendlyTags ?? 0,
      selfDogtagsRecovered: localCombatant?.selfDogtagsRecovered ?? mh?.localSelfTags ?? 0,
      poiCaptures: localCombatant?.poiCaptures ?? 0,
      territoryPoints: localCombatant?.territoryPoints ?? 0,
      flagCaptures: localCombatant?.flagCaptures ?? 0,
      flagReturns: localCombatant?.flagReturns ?? 0,
      hillControlSec: localCombatant?.hillControlSec ?? 0,
      teamScoreA: snapshot.mode === 'battle' ? snapshot.scoreA : undefined,
      teamScoreB: snapshot.mode === 'battle' ? snapshot.scoreB : undefined,
      teamFriendlyDogtagsA: mh?.friendlyTagsA,
      teamFriendlyDogtagsB: mh?.friendlyTagsB,
    };

    if (!user) {
      guestRecentMatchStore.recordMatch(
        buildRecentMatchRecord(matchInput, {
          netXp: 0,
          cashEarned: 0,
          isGuest: true,
        }),
      );
      setRankSummary(buildGuestMatchSummary(matchInput));
      return;
    }

    void commitMatch(matchInput).then((summary) => {
      if (!summary) {
        guestRecentMatchStore.recordMatch(
          buildRecentMatchRecord(matchInput, {
            netXp: 0,
            cashEarned: 0,
            isGuest: true,
          }),
        );
        setRankSummary(buildGuestMatchSummary(matchInput));
        return;
      }
      setRankSummary(summary);
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
          onUpdateHostMatchVisibility={(patch) => {
            engine?.setHostMatchVisibility(patch);
            if (!multiplayerSession && params.mode === 'battle') {
              onUpdateSoloBattleVisibility?.(patch);
            }
          }}
          onRequestLock={() => engine?.requestLock()}
          onToggleTuner={(open) => engine?.setTunerOpen(open)}
          onUpdateConfig={(patch) => engine?.updateConfig(patch)}
          onApplyLensPreset={(preset) => engine?.applyLensPreset(preset)}
          onSelectTacticalEquipment={(id) => engine?.setTacticalEquipment(id)}
          onSelectTacticalBeltSlot={(slot) => engine?.setTacticalBeltSlot(slot)}
          onToggleTacticalMountOnBelt={(mount) => engine?.setTacticalMountOnBelt(mount)}
          onSelectConquestLoadout={(slotId) => engine?.selectConquestLoadout(slotId)}
          onSelectConquestSpawn={(spawnId) => engine?.selectConquestSpawn(spawnId)}
          onConfirmConquestRedeploy={() => engine?.confirmConquestRedeploy()}
          onCycleSpectateTarget={(dir) => engine?.cycleSpectateTarget(dir)}
          onToggleSpectateOverview={() => engine?.toggleSpectateOverview()}
          onCloseInventory={() => engine?.closeInventory(true)}
          onMutateInventory={(nextInv, nextExternal, statusNote) =>
            engine?.applyInventoryMutation(nextInv, nextExternal, statusNote)
          }
          onTriggerDragReload={(slotKey, locator) =>
            engine?.triggerInventoryDragReload(slotKey, locator)
          }
          onUseMedicalItem={(locator, med) =>
            engine?.useMedicalItemFromInventory(locator, med)
          }
          onDropEquippedBackpack={() => {
            engine?.dropEquippedBackpack();
          }}
          onEquipGroundBackpack={(containerId) =>
            engine?.equipGroundBackpack(containerId) ?? {
              ok: false,
              error: 'Session not ready.',
            }
          }
          onMagPackTickAudio={() => engine?.playMagPackTickAudio()}
          onRematch={() => {
            committedMatchRef.current = false;
            setRankSummary(null);
            if (params.mode === 'battle') {
              engine?.rematchBattle();
            } else {
              onRestartInfection();
            }
          }}
          onLaunchTutorial={onLaunchTutorial}
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
  const [view, setView] = useState<ActiveView>({ kind: 'hideout' });
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
              scoreLimit: st.killLimit,
              difficulty: st.botDifficulty,
              primaryWeaponId: activeLoadout.primaryWeaponId || battleConfig.primaryWeaponId,
              secondaryWeaponId: activeLoadout.secondaryWeaponId || battleConfig.secondaryWeaponId,
              tacticalEquipmentId: selectedTacticalId,
              weatherPreset,
              timeOfDayStart,
              hitmarkersEnabled:
                st.hitmarkersEnabled ?? st.specialEvent?.config.hitmarkersEnabled ?? true,
              hudEnabled: st.hudEnabled ?? st.specialEvent?.config.hudEnabled ?? true,
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
          hitmarkersEnabled: lobby.hitmarkersEnabled !== false,
          hudEnabled: lobby.hudEnabled !== false,
          localPlayerName: user?.username ?? 'YOU',
          onHostUpdateKillfeedPolicy: (policy) => updateSettings({ killfeedPolicy: policy }),
          onHostUpdateMatchVisibility: (patch) => updateSettings(patch),
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
      {view.kind === 'hideout' && (
        <HideoutView
          battleConfig={battleConfig}
          infectionConfig={infectionConfig}
          onChangeBattleConfig={setBattleConfig}
          onChangeInfectionConfig={setInfectionConfig}
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
          onLaunchOpenWorld={(slotId) => setView({ kind: 'openworld', slotId })}
          onOpenClassicHub={(tab) => setView({ kind: 'menu', tab })}
          onLaunchPlayground={() => setView({ kind: 'playground' })}
          onLaunchTutorial={() => setView({ kind: 'tutorial', returnTo: 'hideout' })}
        />
      )}

      {view.kind === 'openworld' && (
        <OpenWorldView
          slotId={view.slotId}
          onExitToHideout={() => setView({ kind: 'hideout' })}
          onLaunchTutorial={() =>
            setView({
              kind: 'tutorial',
              returnTo: 'openworld',
              openWorldSlotId: view.slotId,
            })
          }
        />
      )}

      {view.kind === 'menu' && (
        <div className="relative h-screen w-screen overflow-hidden">
          <button
            type="button"
            onClick={() => setView({ kind: 'hideout' })}
            className="fixed bottom-4 left-4 z-50 border border-amber-500/50 bg-[#101216]/95 px-4 py-2 text-xs font-semibold text-amber-200 transition-colors hover:border-amber-400 hover:bg-[#191d24] whitespace-nowrap"
          >
            Return to 3D Hideout
          </button>
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
        </div>
      )}

      {view.kind === 'playground' && (
        <PlaygroundView
          onReturnToMenu={() => setView({ kind: 'hideout' })}
          onLaunchTutorial={() => setView({ kind: 'tutorial', returnTo: 'playground' })}
        />
      )}

      {view.kind === 'tutorial' && (
        <TutorialView
          returnLabel={
            view.returnTo === 'playground'
              ? 'Return to Calibration Gym'
              : view.returnTo === 'openworld'
                ? 'Return to Open World'
                : 'Return to Hideout'
          }
          onExit={() => {
            if (view.returnTo === 'playground') {
              setView({ kind: 'playground' });
            } else if (view.returnTo === 'openworld') {
              setView({ kind: 'openworld', slotId: view.openWorldSlotId ?? null });
            } else {
              setView({ kind: 'hideout' });
            }
          }}
        />
      )}

      {view.kind === 'combat' && (
        <CombatSessionView
          key={view.sessionKey}
          params={view.params}
          multiplayerSession={multiplayerHudControls}
          onUpdateSoloBattleVisibility={(patch) =>
            setBattleConfig((prev) => ({ ...prev, ...patch }))
          }
          onRestartInfection={() =>
            setView({
              kind: 'combat',
              params: view.params,
              sessionKey: Date.now(),
              isMultiplayer: view.isMultiplayer,
            })
          }
          onLaunchTutorial={
            !view.isMultiplayer
              ? () => setView({ kind: 'tutorial', returnTo: 'hideout' })
              : undefined
          }
          onReturnToMenu={(tab) =>
            setView(
              view.isMultiplayer
                ? { kind: 'menu', tab: 'multiplayer' }
                : tab
                  ? { kind: 'hideout' }
                  : { kind: 'hideout' },
            )
          }
        />
      )}

      <AuthModal />
      <AccountSettingsModal />
      <GameSettingsModal />
      <SocialHubDrawer />
      <SocialInviteToast />
      <BackpackUnlockToast />
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

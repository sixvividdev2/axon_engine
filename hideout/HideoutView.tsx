import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { resolveWeaponProfile } from '../bodycam-sdk';
import { useTacticalEquipmentSelection } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import { useOperatorSelection } from '../bodycam-sdk/operator/OperatorSelectionStore';
import { OPERATOR_PROFILES } from '../bodycam-sdk/operator/OperatorTypes';
import { useAuth } from '../context/AuthContext';
import { useLobby } from '../context/LobbyContext';
import { useLoadoutStore } from '../data/loadoutStore';
import { formatRankLabel } from '../data/progression';
import { getTacticalEquipmentDef } from '../data/tacticalEquipment';
import { SaveManager } from '../engine/persistence/SaveManager';
import { BATTLE_MAPS, ZOMBIE_MAPS } from '../maps/MapRegistry';
import { BattleMatchConfig, formatBattleRuleName, InfectionMatchConfig } from '../maps/types';
import { HubTabId } from '../ui/MainMenuHub';
import { OperatorSelectPanel } from '../ui/OperatorSelectPanel';
import { UnifiedLoadoutWorkbench } from '../ui/UnifiedLoadoutWorkbench';
import { formatTimeOfDayLabel, formatWeatherPresetLabel } from '../ui/WeatherTimeControls';
import {
  AirlockTransitionDirection,
  AirlockTransitionOverlay,
} from './AirlockTransitionOverlay';
import { HideoutHud } from './HideoutHud';
import { HideoutOpsLaptopModal, OpsLaptopTabId } from './HideoutOpsLaptopModal';
import { ReadyRoomBriefingState } from './HideoutReadyRoom';
import { HideoutSessionController, HideoutSnapshot } from './HideoutSessionController';
import { ZombiesLobbyController, ZombiesLobbySnapshot } from './ZombiesLobbyController';
import { ZombiesOpsModal } from './ZombiesOpsModal';
import { ZombiesOutpostHud } from './ZombiesOutpostHud';
import type { ZombiesOutpostBriefingState } from './ZombiesOutpostWorld';
import {
  CharacterSlotId,
  hideoutShardAdapter,
  useHideoutShardAdapter,
} from '../src/modes/openworld';

interface HideoutViewProps {
  battleConfig: BattleMatchConfig;
  infectionConfig: InfectionMatchConfig;
  onChangeBattleConfig: (next: BattleMatchConfig) => void;
  onChangeInfectionConfig: (next: InfectionMatchConfig) => void;
  onLaunchBattle: (config: BattleMatchConfig) => void;
  onLaunchInfection: (config: InfectionMatchConfig) => void;
  onLaunchOpenWorld?: (slotId: CharacterSlotId) => void;
  onOpenClassicHub: (tab: HubTabId) => void;
  onLaunchPlayground: () => void;
  onLaunchTutorial: () => void;
}

type ActiveHubScene = 'hideout' | 'zombies_outpost';
type HideoutModalKind = 'none' | 'gunsmith' | 'operator' | 'ops_laptop' | 'zombies_ops';

/**
 * Top-level React host for the 3D Tactical Hideout AND standalone 3D Zombies Quarantine Outpost Lobby.
 * Strictly renders ONLY ONE 3D WebGL scene/controller at a time inside the isolated canvas ref,
 * swapping cleanly at peak decontamination mist occlusion during the ~1.8s Airlock Transition.
 */
export const HideoutView: React.FC<HideoutViewProps> = ({
  battleConfig,
  infectionConfig,
  onChangeBattleConfig,
  onChangeInfectionConfig,
  onLaunchBattle,
  onLaunchInfection,
  onLaunchOpenWorld,
  onOpenClassicHub,
  onLaunchPlayground,
  onLaunchTutorial,
}) => {
  const {
    user,
    effectiveRank,
    isWeaponUnlocked,
    isAttachmentUnlocked,
    getWeaponProgress,
  } = useAuth();
  const { lobby } = useLobby();
  const [selectedOperatorId] = useOperatorSelection();
  const { selection: tacticalSelection } = useTacticalEquipmentSelection();
  const loadoutState = useLoadoutStore();
  const activeLoadout = loadoutState.slots[loadoutState.activeIndex] ?? loadoutState.slots[0];
  const openWorldSnap = useHideoutShardAdapter();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const hideoutControllerRef = useRef<HideoutSessionController | null>(null);
  const zombiesControllerRef = useRef<ZombiesLobbyController | null>(null);
  const hideoutSpawnZoneRef = useRef<'arsenal' | 'airlock_return'>('arsenal');

  const isWeaponUnlockedRef = useRef(isWeaponUnlocked);
  isWeaponUnlockedRef.current = isWeaponUnlocked;

  const battleConfigRef = useRef(battleConfig);
  battleConfigRef.current = battleConfig;
  const tacticalIdRef = useRef(tacticalSelection.equipmentId);
  tacticalIdRef.current = tacticalSelection.equipmentId;
  const onLaunchBattleRef = useRef(onLaunchBattle);
  onLaunchBattleRef.current = onLaunchBattle;
  const onChangeBattleConfigRef = useRef(onChangeBattleConfig);
  onChangeBattleConfigRef.current = onChangeBattleConfig;

  const [activeScene, setActiveScene] = useState<ActiveHubScene>('hideout');
  const [transition, setTransition] = useState<{
    active: boolean;
    direction: AirlockTransitionDirection;
  }>({ active: false, direction: 'to_outpost' });

  const [hideoutSnapshot, setHideoutSnapshot] = useState<HideoutSnapshot | null>(null);
  const [zombiesSnapshot, setZombiesSnapshot] = useState<ZombiesLobbySnapshot | null>(null);
  const [activeModal, setActiveModal] = useState<HideoutModalKind>('none');
  const [opsLaptopTab, setOpsLaptopTab] = useState<OpsLaptopTabId>('battle');

  const beginAirlockTransition = useCallback((direction: AirlockTransitionDirection) => {
    setActiveModal('none');
    setTransition((prev) => (prev.active ? prev : { active: true, direction }));
  }, []);

  const beginAirlockTransitionRef = useRef(beginAirlockTransition);
  beginAirlockTransitionRef.current = beginAirlockTransition;

  // Keep staged Battle primary/secondary synced when player swaps active Loadout in Gunsmith
  useEffect(() => {
    const nextPrimary = isWeaponUnlocked(activeLoadout.primaryWeaponId)
      ? activeLoadout.primaryWeaponId
      : battleConfig.primaryWeaponId;
    const nextSecondary = isWeaponUnlocked(activeLoadout.secondaryWeaponId)
      ? activeLoadout.secondaryWeaponId
      : battleConfig.secondaryWeaponId;
    if (
      nextPrimary !== battleConfig.primaryWeaponId ||
      nextSecondary !== battleConfig.secondaryWeaponId
    ) {
      onChangeBattleConfig({
        ...battleConfig,
        primaryWeaponId: nextPrimary,
        secondaryWeaponId: nextSecondary,
      });
    }
  }, [
    activeLoadout.primaryWeaponId,
    activeLoadout.secondaryWeaponId,
    battleConfig,
    isWeaponUnlocked,
    onChangeBattleConfig,
  ]);

  const readyRoomBriefing: ReadyRoomBriefingState = useMemo(() => {
    const mapDef = BATTLE_MAPS.find((m) => m.id === battleConfig.mapId) ?? BATTLE_MAPS[0];
    const primaryProf = resolveWeaponProfile(battleConfig.primaryWeaponId);
    const secondaryProf = resolveWeaponProfile(battleConfig.secondaryWeaponId);
    const grenadeDef = getTacticalEquipmentDef(tacticalSelection.equipmentId);
    const opProfile = OPERATOR_PROFILES[selectedOperatorId];
    const diffLabel =
      battleConfig.difficulty === 'veteran'
        ? 'Veteran'
        : battleConfig.difficulty === 'recruit'
          ? 'Recruit'
          : 'Tactical';
    return {
      mapId: mapDef.id,
      mapName: mapDef.name,
      mapSubtitle: mapDef.subtitle,
      ruleLabel: formatBattleRuleName(battleConfig.rule),
      botCount: battleConfig.botCount,
      killLimit: battleConfig.scoreLimit ?? battleConfig.killLimit,
      difficultyLabel: diffLabel,
      weatherLabel: formatWeatherPresetLabel(battleConfig.weatherPreset),
      timeOfDayLabel: formatTimeOfDayLabel(battleConfig.timeOfDayStart),
      primaryWeaponName: primaryProf.name,
      secondaryWeaponName: secondaryProf.name,
      grenadeName: grenadeDef.shortName,
      operatorLabel: opProfile.label,
      rankLabel: formatRankLabel(effectiveRank, user?.prestige ?? 0),
      lobbyCode: lobby?.code ?? null,
      lobbyMembersCount: lobby?.members.length ?? 0,
      lobbyMaxPlayers: lobby?.maxPlayers ?? 0,
      openWorldCharacter: openWorldSnap.readyRoomSummary,
    };
  }, [
    battleConfig,
    tacticalSelection.equipmentId,
    selectedOperatorId,
    effectiveRank,
    user?.prestige,
    lobby?.code,
    lobby?.members.length,
    lobby?.maxPlayers,
    openWorldSnap.readyRoomSummary,
  ]);

  const zombiesBriefing: ZombiesOutpostBriefingState = useMemo(() => {
    const zMap = ZOMBIE_MAPS.find((m) => m.id === infectionConfig.mapId) ?? ZOMBIE_MAPS[0];
    const sm = new SaveManager();
    const rec = sm.loadInfectionRecords()[zMap.id];
    const hp = (infectionConfig.zombieHealthMult ?? 1.0).toFixed(2);
    const spd = (infectionConfig.zombieMoveSpeedMult ?? 1.0).toFixed(2);
    const spn = (infectionConfig.zombieSpawnAmountMult ?? 1.0).toFixed(2);
    const diff = infectionConfig.difficultyPreset ?? 'standard';
    return {
      mapName: zMap.name,
      mapSubtitle: zMap.subtitle,
      difficultyLabel: diff.charAt(0).toUpperCase() + diff.slice(1),
      modifiersSummary: `HP ${hp}x · SPD ${spd}x · SPAWN ${spn}x`,
      weatherLabel: formatWeatherPresetLabel(infectionConfig.weatherPreset),
      timeOfDayLabel: formatTimeOfDayLabel(infectionConfig.timeOfDayStart),
      botCount: infectionConfig.botCount ?? 0,
      lobbyCode: lobby?.code ?? null,
      lobbyMembersCount: lobby?.members.length ?? 0,
      lobbyMaxPlayers: lobby?.maxPlayers ?? 4,
      bestRound: rec?.highestRound ?? 0,
    };
  }, [
    infectionConfig,
    lobby?.code,
    lobby?.members.length,
    lobby?.maxPlayers,
  ]);

  const briefingRef = useRef(readyRoomBriefing);
  briefingRef.current = readyRoomBriefing;
  const zombiesBriefingRef = useRef(zombiesBriefing);
  zombiesBriefingRef.current = zombiesBriefing;

  // Mount EXCLUSIVELY the active 3D scene controller (Hideout OR Zombies Outpost)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (activeScene === 'hideout') {
      const controller = new HideoutSessionController(el, {
        isWeaponUnlocked: (weaponId) => isWeaponUnlockedRef.current(weaponId),
        initialSpawnZone: hideoutSpawnZoneRef.current,
        onOpenGunsmith: () => setActiveModal('gunsmith'),
        onOpenOperatorGear: () => setActiveModal('operator'),
        onOpenOpsLaptop: (initialTab = 'battle') => {
          setOpsLaptopTab(initialTab);
          setActiveModal('ops_laptop');
        },
        onQuickDeployBattle: () => {
          const cfg = battleConfigRef.current;
          onLaunchBattleRef.current({
            ...cfg,
            tacticalEquipmentId: tacticalIdRef.current,
            weatherPreset: cfg.weatherPreset ?? 'auto',
            timeOfDayStart: cfg.timeOfDayStart ?? 'auto',
          });
        },
        onCycleStagedMap: () => {
          const cfg = battleConfigRef.current;
          const playableMaps = BATTLE_MAPS.filter((m) => m.status === 'playable');
          const list = playableMaps.length > 0 ? playableMaps : BATTLE_MAPS;
          const idx = list.findIndex((m) => m.id === cfg.mapId);
          const nextMap = list[(idx + 1) % list.length];
          onChangeBattleConfigRef.current({ ...cfg, mapId: nextMap.id });
          return nextMap.name;
        },
        onEnterZombiesOutpost: () => {
          beginAirlockTransitionRef.current('to_outpost');
        },
      });
      hideoutControllerRef.current = controller;
      controller.syncOpsBriefing(briefingRef.current);
      const unsub = controller.subscribe((next) => setHideoutSnapshot(next));

      return () => {
        unsub();
        controller.dispose();
        hideoutControllerRef.current = null;
        setHideoutSnapshot(null);
      };
    }

    // activeScene === 'zombies_outpost'
    const zController = new ZombiesLobbyController(el, {
      isWeaponUnlocked: (weaponId) => isWeaponUnlockedRef.current(weaponId),
      onOpenZombiesOps: () => setActiveModal('zombies_ops'),
      onOpenGunsmith: () => setActiveModal('gunsmith'),
      onOpenOperatorGear: () => setActiveModal('operator'),
      onReturnToHideout: () => {
        beginAirlockTransitionRef.current('to_hideout');
      },
    });
    zombiesControllerRef.current = zController;
    zController.syncBriefing(zombiesBriefingRef.current);
    const unsub = zController.subscribe((next) => setZombiesSnapshot(next));

    return () => {
      unsub();
      zController.dispose();
      zombiesControllerRef.current = null;
      setZombiesSnapshot(null);
    };
  }, [activeScene]);

  // Re-sync owned weapons on rank / unlock updates
  useEffect(() => {
    hideoutControllerRef.current?.syncOwnedWeapons();
    zombiesControllerRef.current?.syncOwnedWeapons();
  }, [effectiveRank, isWeaponUnlocked]);

  // Push live briefing data into the active 3D scene displays
  useEffect(() => {
    hideoutControllerRef.current?.syncOpsBriefing(readyRoomBriefing);
  }, [readyRoomBriefing]);

  useEffect(() => {
    zombiesControllerRef.current?.syncBriefing(zombiesBriefing);
  }, [zombiesBriefing]);

  const setActiveControllerModal = useCallback((open: boolean) => {
    hideoutControllerRef.current?.setModalActive(open);
    zombiesControllerRef.current?.setModalActive(open);
  }, []);

  const requestActivePointerLock = useCallback(() => {
    hideoutControllerRef.current?.requestPointerLock();
    zombiesControllerRef.current?.requestPointerLock();
  }, []);

  const closeModalAndResume = useCallback(() => {
    setActiveModal('none');
    setActiveControllerModal(false);
    hideoutControllerRef.current?.syncOwnedWeapons();
    zombiesControllerRef.current?.syncOwnedWeapons();
    requestActivePointerLock();
  }, [requestActivePointerLock, setActiveControllerModal]);

  // Escape closes Ops modals cleanly
  useEffect(() => {
    if (activeModal !== 'ops_laptop' && activeModal !== 'zombies_ops') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModalAndResume();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModal, closeModalAndResume]);

  const openModal = (kind: Exclude<HideoutModalKind, 'none'>, opsTab?: OpsLaptopTabId) => {
    hideoutControllerRef.current?.setPauseOpen(false);
    zombiesControllerRef.current?.setPauseOpen(false);
    setActiveControllerModal(true);
    if (kind === 'ops_laptop' && opsTab) {
      setOpsLaptopTab(opsTab);
    }
    setActiveModal(kind);
  };

  // Peak decontamination mist occlusion: dispose outgoing 3D scene and mount destination 3D scene
  const handleMidpointSwap = useCallback(() => {
    if (transition.direction === 'to_outpost') {
      setActiveScene('zombies_outpost');
    } else {
      hideoutSpawnZoneRef.current = 'airlock_return';
      setActiveScene('hideout');
    }
  }, [transition.direction]);

  const handleTransitionComplete = useCallback(() => {
    setTransition((prev) => ({ ...prev, active: false }));
    requestActivePointerLock();
  }, [requestActivePointerLock]);

  const returnLabel = activeScene === 'zombies_outpost' ? 'Return to Outpost' : 'Return to Hideout';

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#090a0b]">
      {/* Isolated single WebGL canvas host */}
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {/* Main Hideout HUD */}
      {activeScene === 'hideout' && hideoutSnapshot && (
        <HideoutHud
          snapshot={hideoutSnapshot}
          modalOpen={activeModal !== 'none' || transition.active}
          onRequestLock={() => hideoutControllerRef.current?.requestPointerLock()}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onOpenOpsLaptop={(tab = 'battle') => openModal('ops_laptop', tab)}
          onVolumeChange={(v) => hideoutControllerRef.current?.setMasterVolume(v)}
          onGraphicsChange={() => hideoutControllerRef.current?.applyGraphicsQuality()}
          onOpenClassicHub={onOpenClassicHub}
          onLaunchPlayground={onLaunchPlayground}
          onLaunchTutorial={onLaunchTutorial}
        />
      )}

      {/* Standalone 3D Zombies Outpost Lobby HUD */}
      {activeScene === 'zombies_outpost' && zombiesSnapshot && (
        <ZombiesOutpostHud
          snapshot={zombiesSnapshot}
          modalOpen={activeModal !== 'none' || transition.active}
          onRequestLock={() => zombiesControllerRef.current?.requestPointerLock()}
          onOpenZombiesOps={() => openModal('zombies_ops')}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onReturnToHideout={() => {
            zombiesControllerRef.current?.setPauseOpen(false);
            zombiesControllerRef.current?.triggerReturnToHideout();
          }}
          onLaunchTutorial={onLaunchTutorial}
          onVolumeChange={(v) => zombiesControllerRef.current?.setMasterVolume(v)}
          onGraphicsChange={() => zombiesControllerRef.current?.applyGraphicsQuality()}
        />
      )}

      {/* Animated Bio-Containment Airlock & Transport Transition Overlay */}
      <AirlockTransitionOverlay
        active={transition.active}
        direction={transition.direction}
        onMidpointSwap={handleMidpointSwap}
        onComplete={handleTransitionComplete}
      />

      {/* Zombies Outpost Operations Map Board / Field Radio Modal */}
      {activeModal === 'zombies_ops' && (
        <ZombiesOpsModal
          infectionConfig={infectionConfig}
          onChangeInfectionConfig={onChangeInfectionConfig}
          onDeployInfection={(cfg) => {
            setActiveModal('none');
            onLaunchInfection(cfg);
          }}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onClose={closeModalAndResume}
        />
      )}

      {/* Ready Room Ops Command Laptop Terminal Overlay */}
      {activeModal === 'ops_laptop' && (
        <HideoutOpsLaptopModal
          initialTab={opsLaptopTab}
          battleConfig={battleConfig}
          infectionConfig={infectionConfig}
          onChangeBattleConfig={onChangeBattleConfig}
          onChangeInfectionConfig={onChangeInfectionConfig}
          onDeployBattle={(cfg) => {
            setActiveModal('none');
            onLaunchBattle(cfg);
          }}
          onDeployInfection={(cfg) => {
            setActiveModal('none');
            onLaunchInfection(cfg);
          }}
          onDeployOpenWorld={
            onLaunchOpenWorld
              ? (slotId) => {
                  setActiveModal('none');
                  onLaunchOpenWorld(slotId);
                }
              : undefined
          }
          onLaunchPlayground={() => {
            setActiveModal('none');
            onLaunchPlayground();
          }}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onClose={closeModalAndResume}
        />
      )}

      {/* Gunsmith Workbench Overlay */}
      {activeModal === 'gunsmith' && (
        <div className="fixed inset-0 z-30">
          <UnifiedLoadoutWorkbench
            careerRank={effectiveRank}
            getWeaponProgress={getWeaponProgress}
            isWeaponUnlocked={(wid) =>
              hideoutShardAdapter.isWeaponOwnedInActiveContext(wid, isWeaponUnlocked)
            }
            isAttachmentUnlocked={(attId) =>
              hideoutShardAdapter.isAttachmentUnlockedInActiveContext(attId, isAttachmentUnlocked)
            }
            onClose={closeModalAndResume}
            closeLabel={returnLabel}
          />
        </div>
      )}

      {/* Operator Gear Overlay */}
      {activeModal === 'operator' && (
        <div className="fixed inset-0 z-30 flex flex-col bg-[#090a0b]">
          <div className="flex items-center justify-between border-b border-white/10 bg-[#101216] px-6 py-3">
            <span className="font-display text-lg font-semibold tracking-wide text-neutral-100">
              Operator Gear &amp; Rig
            </span>
            <button
              type="button"
              onClick={closeModalAndResume}
              className="flex items-center gap-2 border border-white/15 bg-[#181b20] px-3.5 py-1.5 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-500/60 hover:bg-[#20242b] whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>{returnLabel}</span>
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <OperatorSelectPanel
              onDeploy={closeModalAndResume}
              deployLabel={`Apply & ${returnLabel}`}
            />
          </div>
        </div>
      )}
    </main>
  );
};

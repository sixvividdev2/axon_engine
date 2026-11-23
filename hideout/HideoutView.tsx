import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { BATTLE_MAPS } from '../maps/MapRegistry';
import { BattleMatchConfig, InfectionMatchConfig } from '../maps/types';
import { HubTabId } from '../ui/MainMenuHub';
import { OperatorSelectPanel } from '../ui/OperatorSelectPanel';
import { UnifiedLoadoutWorkbench } from '../ui/UnifiedLoadoutWorkbench';
import { formatTimeOfDayLabel, formatWeatherPresetLabel } from '../ui/WeatherTimeControls';
import { HideoutHud } from './HideoutHud';
import { HideoutOpsLaptopModal, OpsLaptopTabId } from './HideoutOpsLaptopModal';
import { ReadyRoomBriefingState } from './HideoutReadyRoom';
import { HideoutSessionController, HideoutSnapshot } from './HideoutSessionController';

interface HideoutViewProps {
  battleConfig: BattleMatchConfig;
  infectionConfig: InfectionMatchConfig;
  onChangeBattleConfig: (next: BattleMatchConfig) => void;
  onChangeInfectionConfig: (next: InfectionMatchConfig) => void;
  onLaunchBattle: (config: BattleMatchConfig) => void;
  onLaunchInfection: (config: InfectionMatchConfig) => void;
  onOpenClassicHub: (tab: HubTabId) => void;
  onLaunchPlayground: () => void;
}

type HideoutModalKind = 'none' | 'gunsmith' | 'operator' | 'ops_laptop';

/**
 * Top-level React host for the 3D Tactical Hideout.
 * Keeps the WebGL canvas mounted inside an isolated ref container so React modal
 * and HUD state changes never tear down or reset the 3D scene.
 */
export const HideoutView: React.FC<HideoutViewProps> = ({
  battleConfig,
  infectionConfig,
  onChangeBattleConfig,
  onChangeInfectionConfig,
  onLaunchBattle,
  onLaunchInfection,
  onOpenClassicHub,
  onLaunchPlayground,
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<HideoutSessionController | null>(null);
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

  const [snapshot, setSnapshot] = useState<HideoutSnapshot | null>(null);
  const [activeModal, setActiveModal] = useState<HideoutModalKind>('none');
  const [opsLaptopTab, setOpsLaptopTab] = useState<OpsLaptopTabId>('battle');

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
      ruleLabel: battleConfig.rule === 'ffa' ? 'FFA · Free-For-All' : 'TDM · Team Deathmatch',
      botCount: battleConfig.botCount,
      killLimit: battleConfig.killLimit,
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
  ]);

  const briefingRef = useRef(readyRoomBriefing);
  briefingRef.current = readyRoomBriefing;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const controller = new HideoutSessionController(el, {
      isWeaponUnlocked: (weaponId) => isWeaponUnlockedRef.current(weaponId),
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
    });
    controllerRef.current = controller;
    controller.syncOpsBriefing(briefingRef.current);
    const unsub = controller.subscribe((next) => setSnapshot(next));

    return () => {
      unsub();
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Re-sync owned Gun Wall roster whenever account rank / unlocks change
  useEffect(() => {
    controllerRef.current?.syncOwnedWeapons();
  }, [effectiveRank, isWeaponUnlocked]);

  // Push live staged match, loadout, weather & squad lobby updates to 3D Ready Room screens
  useEffect(() => {
    controllerRef.current?.syncOpsBriefing(readyRoomBriefing);
  }, [readyRoomBriefing]);

  // Escape closes Ops Command Laptop cleanly back into the Ready Room
  useEffect(() => {
    if (activeModal !== 'ops_laptop') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModalAndResume();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeModal]);

  const closeModalAndResume = () => {
    setActiveModal('none');
    controllerRef.current?.setModalActive(false);
    controllerRef.current?.syncOwnedWeapons();
    controllerRef.current?.requestPointerLock();
  };

  const openModal = (kind: Exclude<HideoutModalKind, 'none'>, opsTab?: OpsLaptopTabId) => {
    controllerRef.current?.setPauseOpen(false);
    controllerRef.current?.setModalActive(true);
    if (kind === 'ops_laptop' && opsTab) {
      setOpsLaptopTab(opsTab);
    }
    setActiveModal(kind);
  };

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#090a0b]">
      {/* Isolated WebGL canvas host */}
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {snapshot && (
        <HideoutHud
          snapshot={snapshot}
          modalOpen={activeModal !== 'none'}
          onRequestLock={() => controllerRef.current?.requestPointerLock()}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onOpenOpsLaptop={(tab = 'battle') => openModal('ops_laptop', tab)}
          onVolumeChange={(v) => controllerRef.current?.setMasterVolume(v)}
          onGraphicsChange={() => controllerRef.current?.applyGraphicsQuality()}
          onOpenClassicHub={onOpenClassicHub}
          onLaunchPlayground={onLaunchPlayground}
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
          onLaunchPlayground={() => {
            setActiveModal('none');
            onLaunchPlayground();
          }}
          onOpenGunsmith={() => openModal('gunsmith')}
          onOpenOperatorGear={() => openModal('operator')}
          onClose={closeModalAndResume}
        />
      )}

      {/* Arsenal Prep Table Gunsmith Workbench Overlay */}
      {activeModal === 'gunsmith' && (
        <div className="fixed inset-0 z-30">
          <UnifiedLoadoutWorkbench
            careerRank={effectiveRank}
            getWeaponProgress={getWeaponProgress}
            isWeaponUnlocked={isWeaponUnlocked}
            isAttachmentUnlocked={isAttachmentUnlocked}
            onClose={closeModalAndResume}
            closeLabel="Return to Hideout"
          />
        </div>
      )}

      {/* Arsenal Locker Operator Gear Overlay */}
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
              <span>Return to Hideout</span>
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <OperatorSelectPanel
              onDeploy={closeModalAndResume}
              deployLabel="Apply & Return to Hideout"
            />
          </div>
        </div>
      )}
    </main>
  );
};

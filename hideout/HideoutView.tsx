import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { HubTabId } from '../ui/MainMenuHub';
import { OperatorSelectPanel } from '../ui/OperatorSelectPanel';
import { UnifiedLoadoutWorkbench } from '../ui/UnifiedLoadoutWorkbench';
import { HideoutHud } from './HideoutHud';
import { HideoutSessionController, HideoutSnapshot } from './HideoutSessionController';

interface HideoutViewProps {
  onOpenClassicHub: (tab: HubTabId) => void;
  onLaunchPlayground: () => void;
}

type HideoutModalKind = 'none' | 'gunsmith' | 'operator';

/**
 * Top-level React host for the 3D Tactical Hideout.
 * Keeps the WebGL canvas mounted inside an isolated ref container so React modal
 * and HUD state changes never tear down or reset the 3D scene.
 */
export const HideoutView: React.FC<HideoutViewProps> = ({
  onOpenClassicHub,
  onLaunchPlayground,
}) => {
  const {
    effectiveRank,
    isWeaponUnlocked,
    isAttachmentUnlocked,
    getWeaponProgress,
  } = useAuth();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<HideoutSessionController | null>(null);
  const isWeaponUnlockedRef = useRef(isWeaponUnlocked);
  isWeaponUnlockedRef.current = isWeaponUnlocked;

  const [snapshot, setSnapshot] = useState<HideoutSnapshot | null>(null);
  const [activeModal, setActiveModal] = useState<HideoutModalKind>('none');

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const controller = new HideoutSessionController(el, {
      isWeaponUnlocked: (weaponId) => isWeaponUnlockedRef.current(weaponId),
      onOpenGunsmith: () => setActiveModal('gunsmith'),
      onOpenOperatorGear: () => setActiveModal('operator'),
    });
    controllerRef.current = controller;
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

  const closeModalAndResume = () => {
    setActiveModal('none');
    controllerRef.current?.setModalActive(false);
    controllerRef.current?.syncOwnedWeapons();
    controllerRef.current?.requestPointerLock();
  };

  const openModal = (kind: Exclude<HideoutModalKind, 'none'>) => {
    controllerRef.current?.setPauseOpen(false);
    controllerRef.current?.setModalActive(true);
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
          onVolumeChange={(v) => controllerRef.current?.setMasterVolume(v)}
          onGraphicsChange={() => controllerRef.current?.applyGraphicsQuality()}
          onOpenClassicHub={onOpenClassicHub}
          onLaunchPlayground={onLaunchPlayground}
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
            closeLabel="Return to Arsenal"
          />
        </div>
      )}

      {/* Arsenal Locker Operator Gear Overlay */}
      {activeModal === 'operator' && (
        <div className="fixed inset-0 z-30 flex flex-col bg-[#090a0b]">
          <div className="flex items-center justify-between border-b border-white/10 bg-[#101216] px-6 py-3">
            <span className="font-display text-lg font-semibold tracking-wide text-neutral-100">
              Operator Gear & Rig
            </span>
            <button
              type="button"
              onClick={closeModalAndResume}
              className="flex items-center gap-2 border border-white/15 bg-[#181b20] px-3.5 py-1.5 text-xs font-medium text-neutral-100 transition-colors hover:border-amber-500/60 hover:bg-[#20242b] whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>Return to Arsenal</span>
            </button>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <OperatorSelectPanel
              onDeploy={closeModalAndResume}
              deployLabel="Apply & Return to Arsenal"
            />
          </div>
        </div>
      )}
    </main>
  );
};

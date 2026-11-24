import React, { useEffect, useRef, useState } from 'react';
import { CharacterSlotId } from './types';
import { OpenWorldHud } from './OpenWorldHud';
import {
  OpenWorldSessionEngine,
  OpenWorldSessionSnapshot,
} from './world/OpenWorldSessionEngine';

interface OpenWorldViewProps {
  slotId?: CharacterSlotId | null;
  onExitToHideout: () => void;
}

/**
 * Isolated React host for the 4km × 4km 4-Biome Perimeter Operations streaming world.
 * Keeps the WebGL canvas mounted inside a dedicated ref container so HUD updates never
 * tear down or reset the streaming terrain scene.
 */
export const OpenWorldView: React.FC<OpenWorldViewProps> = ({
  slotId,
  onExitToHideout,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<OpenWorldSessionEngine | null>(null);
  const [snapshot, setSnapshot] = useState<OpenWorldSessionSnapshot | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const engine = new OpenWorldSessionEngine(el, slotId);
    engineRef.current = engine;
    const unsub = engine.subscribe((next) => setSnapshot(next));

    return () => {
      unsub();
      engine.dispose();
      engineRef.current = null;
    };
  }, [slotId]);

  const handleExfil = () => {
    engineRef.current?.commitExfilToHideout();
    onExitToHideout();
  };

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[#0a0d12]">
      <div ref={containerRef} className="fixed inset-0 h-full w-full" />

      {snapshot && (
        <OpenWorldHud
          snapshot={snapshot}
          onRequestLock={() => engineRef.current?.requestPointerLock()}
          onSetNavMode={(mode) => engineRef.current?.setNavMode(mode)}
          onSetRenderPipeline={(mode) => engineRef.current?.setRenderPipeline(mode)}
          onSetLensPreset={(preset) => engineRef.current?.setLensPreset(preset)}
          onSetNvgMode={(mode) => engineRef.current?.setNvgMode(mode)}
          onToggleFlashlight={() => engineRef.current?.toggleFlashlight()}
          onTogglePda={() => engineRef.current?.togglePda()}
          onOpenInventory={() => engineRef.current?.openInventory()}
          onCloseModal={() => engineRef.current?.closeActiveModal()}
          onMutateInventory={(inv, ext, note) =>
            engineRef.current?.applyInventoryMutation(inv, ext, note)
          }
          onTriggerDragReload={(slotKey, loc) =>
            engineRef.current?.triggerInventoryDragReload(slotKey, loc)
          }
          onUseMedicalItem={(loc, med) =>
            engineRef.current?.useMedicalItemFromInventory(loc, med)
          }
          onUsePdaBattery={(loc) => engineRef.current?.usePdaBatteryFromInventory(loc)}
          onFastTravelToSector={(secId) => engineRef.current?.fastTravelToSector(secId)}
          onFundFobUpgrade={() => engineRef.current?.fundFobUpgrade()}
          onBuyFobOffer={(offerId) => engineRef.current?.buyFobTraderOffer(offerId)}
          onAcceptContract={(idx) => engineRef.current?.acceptRotatingContract(idx)}
          onCompleteContract={(idx) => engineRef.current?.completeRotatingContract(idx)}
          onDepositArmoryItem={(loc) => engineRef.current?.depositItemToArmoryStash(loc)}
          onWithdrawArmoryItem={(id, target) =>
            engineRef.current?.withdrawItemFromArmoryStash(id, target)
          }
          onEquipArmoryWeapon={(slotKey, wId) =>
            engineRef.current?.equipArmoryWeapon(slotKey, wId)
          }
          onEquipArmoryArmorPlate={(plateId) => engineRef.current?.equipArmoryArmorPlate(plateId)}
          onResupplyArmoryAmmo={() => engineRef.current?.resupplyArmoryAmmo()}
          onSabotageConvoy={() => engineRef.current?.sabotageNearestConvoy()}
          onTriggerWorldEvent={(kind) => engineRef.current?.triggerDynamicWorldEvent(kind)}
          onExecuteInteract={() => engineRef.current?.executeFieldInteraction()}
          onTeleportLandmark={(id) => engineRef.current?.teleportToLandmark(id)}
          onSetTimeOfDay={(h) => engineRef.current?.setTimeOfDay(h)}
          onSetTimeScale={(s) => engineRef.current?.setTimeScale(s)}
          onSetWeather={(w) => engineRef.current?.setWeather(w)}
          onSetAutoWeather={(enabled) => engineRef.current?.setAutoWeatherCycle(enabled)}
          onExfilToHideout={handleExfil}
          onTriggerFieldDeath={() => engineRef.current?.triggerFieldDeathAtCurrentPosition()}
        />
      )}
    </main>
  );
};

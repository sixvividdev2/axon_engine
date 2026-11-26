import React, { useEffect } from 'react';
import { Compass, Shield, Wrench, X } from 'lucide-react';
import {
  CharacterSlotId,
  PerimeterOpsTerminalPanel,
  PMC_FACTIONS,
  useHideoutShardAdapter,
} from '../src/modes/openworld';

interface HideoutPerimeterLaptopModalProps {
  onDeployOpenWorld?: (slotId: CharacterSlotId) => void;
  onOpenGunsmith: () => void;
  onOpenOperatorGear: () => void;
  onClose: () => void;
}

/**
 * Dedicated Perimeter Operations Laptop Terminal Modal.
 * Opened exclusively from the separate Ready Room Perimeter Ops Laptop,
 * the Perimeter Wing Contract Officer, or Roster Operator alcoves — completely decoupled
 * from the Arsenal Tactical Locker and the Combat Ops Command Laptop.
 */
export const HideoutPerimeterLaptopModal: React.FC<HideoutPerimeterLaptopModalProps> = ({
  onDeployOpenWorld,
  onOpenGunsmith,
  onOpenOperatorGear,
  onClose,
}) => {
  const { activeCharacter, bankruptcy } = useHideoutShardAdapter();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#060908]/88 p-4 sm:p-6">
      <div className="flex h-full max-h-[880px] w-full max-w-[1220px] flex-col border border-emerald-500/28 bg-[#0b100e] text-neutral-100 shadow-2xl">
        <header className="flex items-center justify-between gap-6 border-b border-emerald-500/18 bg-[#0f1714] px-6 py-3.5">
          <div className="flex items-center gap-3">
            <Compass className="h-5 w-5 text-emerald-400" />
            <div className="flex flex-col">
              <span className="font-display text-lg font-bold tracking-wider text-neutral-50 whitespace-nowrap">
                Perimeter Operations Terminal
              </span>
              <span className="font-mono-tabular text-[11px] text-emerald-300/80">
                Dedicated Ready Room Uplink · 3-Slot Roster · Persistent Shards · Helipad Dispatch
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onOpenGunsmith}
              className="flex cursor-pointer items-center gap-1.5 border border-white/12 bg-[#141d19] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap"
            >
              <Wrench className="h-3.5 w-3.5 text-amber-400" />
              <span>Gunsmith</span>
            </button>
            <button
              type="button"
              onClick={onOpenOperatorGear}
              className="flex cursor-pointer items-center gap-1.5 border border-white/12 bg-[#141d19] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-amber-200 whitespace-nowrap"
            >
              <Shield className="h-3.5 w-3.5 text-amber-400" />
              <span>Operator Gear</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex cursor-pointer items-center gap-2 border border-white/14 bg-[#17211d] px-3.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:border-emerald-400/60 hover:text-white whitespace-nowrap"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close Terminal</span>
            </button>
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/8 bg-[#090d0b] px-6 py-2.5 font-mono-tabular text-xs text-neutral-300">
          {activeCharacter ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-neutral-500">Active Point</span>
              <span className="font-semibold text-emerald-300">{activeCharacter.callsign}</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>{PMC_FACTIONS[activeCharacter.pmcFaction].name}</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span>{activeCharacter.shardMode} Shard</span>
              <span className="text-neutral-600" aria-hidden="true">
                ·
              </span>
              <span className="text-neutral-100">${activeCharacter.cash.toLocaleString()}</span>
              {bankruptcy?.isBankruptcyRisk && (
                <>
                  <span className="text-neutral-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="font-semibold text-red-400">
                    BANKRUPTCY RISK (MEDEVAC ${bankruptcy.nextRespawnFee.toLocaleString()})
                  </span>
                </>
              )}
            </div>
          ) : (
            <span className="text-neutral-400">
              No Perimeter Operator active — recruit or activate a slot below or in the Perimeter Ops Wing alcoves.
            </span>
          )}
          <span className="text-[11px] text-emerald-400/80">
            HELIPAD PAD 01 · VALKYRIE 2-1 STANDBY
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <PerimeterOpsTerminalPanel onDeployOpenWorld={onDeployOpenWorld} />
        </div>
      </div>
    </div>
  );
};

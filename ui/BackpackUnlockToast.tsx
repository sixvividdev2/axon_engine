import React, { useEffect } from 'react';
import { Backpack, Check, X } from 'lucide-react';
import {
  backpackUnlockStore,
  useBackpackUnlocks,
} from '../data/backpackUnlocks';
import { getBackpackTemplate } from '../src/modes/openworld/inventory/TetrisInventoryCore';

/**
 * Non-blocking tactical toast notification mounted globally in App.tsx.
 * Announces newly unlocked backpack tiers whether earned via Career Rank (10/20/30)
 * or discovered & picked up in the field.
 */
export const BackpackUnlockToast: React.FC = () => {
  const { activeToast } = useBackpackUnlocks();

  useEffect(() => {
    if (!activeToast) return;
    const timer = window.setTimeout(() => {
      backpackUnlockStore.dismissToast();
    }, 6500);
    return () => window.clearTimeout(timer);
  }, [activeToast]);

  if (!activeToast) return null;

  const tpl = getBackpackTemplate(activeToast.templateId);
  if (!tpl) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-[95] -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-3 border border-amber-400/70 bg-[#0d1118]/95 px-4 py-2.5 text-neutral-100 shadow-2xl">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center border border-amber-400/60 bg-amber-950/50"
          style={{ borderColor: tpl.accentHex }}
        >
          <Backpack className="h-4 w-4 text-amber-300" />
        </div>
        <div className="min-w-0 font-mono-tabular">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-amber-300">
            <Check className="h-3 w-3 text-emerald-400" />
            <span>
              {activeToast.source === 'world_pickup'
                ? 'FIELD DISCOVERY · BACKPACK UNLOCKED'
                : `RANK ${tpl.unlockRank} MILESTONE · BACKPACK UNLOCKED`}
            </span>
          </div>
          <div className="mt-0.5 text-xs font-semibold text-white">
            {tpl.name}{' '}
            <span className="font-normal text-neutral-400">
              ({tpl.gridWidth}x{tpl.gridHeight} Grid · {tpl.maxWeightKg} kg Max Carry)
            </span>
          </div>
          <div className="text-[10px] text-emerald-300">
            Now permanently available in your Loadout Workbench across all modes.
          </div>
        </div>
        <button
          type="button"
          onClick={() => backpackUnlockStore.dismissToast()}
          className="ml-1 cursor-pointer border border-white/15 p-1 text-neutral-400 hover:border-white/40 hover:text-white"
          aria-label="Dismiss backpack unlock notice"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

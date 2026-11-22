import React from 'react';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import { GameSnapshot } from '../engine/types';

interface MainMenuProps {
  snapshot: GameSnapshot;
  onNewGame: () => void;
  onLoadSave: (id: string) => void;
  onDeleteSave: (id: string) => void;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export const MainMenu: React.FC<MainMenuProps> = ({
  snapshot,
  onNewGame,
  onLoadSave,
  onDeleteSave,
}) => {
  const latestSave = snapshot.saveSlots[0] ?? null;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-neutral-950/70 p-6">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-12 gap-8 border border-neutral-800 bg-neutral-950/95 p-8">
        {/* Left Column: Title & Primary Entry */}
        <div className="md:col-span-6 flex flex-col justify-between gap-6">
          <div>
            <p className="text-xs font-mono-tabular tracking-widest text-neutral-400">
              Perimeter Sector 04 · Overcast Clearing
            </p>
            <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-neutral-100 uppercase">
              AXON ENGINE
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">
              You wake empty-handed along the perimeter road. Scavenge gear, manage individual
              magazines, watch your acoustic footprint, and survive the fog.
            </p>
          </div>

          <div className="flex flex-col gap-2.5">
            {latestSave && (
              <button
                type="button"
                onClick={() => onLoadSave(latestSave.id)}
                className="flex items-center justify-between px-4 py-3 bg-amber-500 text-neutral-950 font-semibold text-sm hover:bg-amber-400 transition-colors cursor-pointer whitespace-nowrap"
              >
                <span className="flex items-center gap-2">
                  <Play className="w-4 h-4" />
                  Continue Last Expedition
                </span>
                <span className="text-xs font-mono-tabular opacity-80">
                  {latestSave.name}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={onNewGame}
              className="flex items-center justify-center gap-2 px-4 py-3 border border-neutral-700 bg-neutral-900 text-neutral-100 font-medium text-sm hover:bg-neutral-800 transition-colors cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="w-4 h-4" />
              New Expedition (Wake Unarmed)
            </button>
          </div>

          {/* Concise Controls Reference */}
          <div className="border-t border-neutral-800 pt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-neutral-400">
            <div><span className="font-mono-tabular text-neutral-200">WASD / Shift</span> · Move / Sprint</div>
            <div><span className="font-mono-tabular text-neutral-200">Q / E / C</span> · Lean / Crouch</div>
            <div><span className="font-mono-tabular text-neutral-200">RMB + Shift/Alt</span> · ADS / Hold Breath</div>
            <div><span className="font-mono-tabular text-neutral-200">R / Alt+T</span> · Reload / Mag Check</div>
            <div><span className="font-mono-tabular text-neutral-200">5 / 6</span> · Bleed / Med Quick-Use</div>
            <div><span className="font-mono-tabular text-neutral-200">F / T / Tab</span> · Interact / Light / Rig</div>
          </div>
        </div>

        {/* Right Column: Persistent IndexedDB Save Slots */}
        <div className="md:col-span-6 flex flex-col border-t md:border-t-0 md:border-l border-neutral-800 pt-6 md:pt-0 md:pl-8">
          <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">Saved Expeditions</h2>
            <span className="text-xs font-mono-tabular text-neutral-500">
              {snapshot.saveSlots.length} slots
            </span>
          </div>

          <div className="mt-3 flex-1 max-h-72 overflow-y-auto space-y-2 pr-1">
            {snapshot.saveSlots.length === 0 ? (
              <div className="py-12 text-center text-xs text-neutral-500">
                No saved expeditions in browser storage yet. Press F5 during play to quicksave.
              </div>
            ) : (
              snapshot.saveSlots.map((slot) => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between gap-3 border border-neutral-800 bg-neutral-900/70 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-neutral-200">
                      {slot.name}
                    </div>
                    <div className="text-[11px] font-mono-tabular text-neutral-500">
                      {new Date(slot.savedAt).toLocaleString()} · {formatDuration(slot.playtimeSec)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onLoadSave(slot.id)}
                      className="px-2.5 py-1.5 text-xs font-medium bg-neutral-800 text-neutral-100 hover:bg-neutral-700 transition-colors cursor-pointer"
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteSave(slot.id)}
                      aria-label={`Delete ${slot.name}`}
                      className="p-1.5 text-neutral-400 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

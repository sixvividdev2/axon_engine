import React, { useState } from 'react';
import { Save, Trash2, Upload, RotateCcw } from 'lucide-react';
import { GameSnapshot } from '../engine/types';

interface SaveManagerModalProps {
  snapshot: GameSnapshot;
  onResume: () => void;
  onSaveNamed: (name: string, overwriteId?: string) => void;
  onQuicksave: () => void;
  onQuickload: () => void;
  onLoadSlot: (id: string) => void;
  onDeleteSlot: (id: string) => void;
  onMainMenu: () => void;
  onNewGame: () => void;
}

export const SaveManagerModal: React.FC<SaveManagerModalProps> = ({
  snapshot,
  onResume,
  onSaveNamed,
  onQuicksave,
  onQuickload,
  onLoadSlot,
  onDeleteSlot,
  onMainMenu,
  onNewGame,
}) => {
  const [saveName, setSaveName] = useState('');
  const isDead = snapshot.mode === 'dead';

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveNamed(saveName);
    setSaveName('');
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-neutral-950/80 p-6">
      <div className="w-full max-w-2xl border border-neutral-800 bg-neutral-950/95 p-6">
        <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
          <div>
            <h2 className="font-display text-2xl font-semibold tracking-wide text-neutral-100 uppercase">
              {isDead ? 'Signal Lost — Operator Down' : 'Expedition Paused'}
            </h2>
            <p className="text-xs font-mono-tabular text-neutral-400">
              Seed #{snapshot.worldSeed} · Elapsed {Math.floor(snapshot.playtimeSec)}s
            </p>
          </div>
          {!isDead && (
            <button
              type="button"
              onClick={onResume}
              className="px-4 py-2 text-xs font-semibold bg-amber-500 text-neutral-950 hover:bg-amber-400 cursor-pointer"
            >
              Resume (Esc)
            </button>
          )}
        </div>

        {/* Quick Actions */}
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          {!isDead && (
            <button
              type="button"
              onClick={onQuicksave}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              Quicksave (F5)
            </button>
          )}
          <button
            type="button"
            onClick={onQuickload}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            Quickload (F9)
          </button>
          <button
            type="button"
            onClick={onNewGame}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restart Clearing
          </button>
          <button
            type="button"
            onClick={onMainMenu}
            className="ml-auto px-3 py-2 text-xs font-medium text-neutral-400 hover:text-neutral-200 cursor-pointer"
          >
            Main Menu
          </button>
        </div>

        {/* Create New Named Save */}
        {!isDead && (
          <form onSubmit={handleSaveSubmit} className="mt-4 flex gap-2">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Name new save slot (e.g. Before House Breach)..."
              className="flex-1 border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-amber-500"
            />
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold bg-neutral-200 text-neutral-950 hover:bg-white cursor-pointer whitespace-nowrap"
            >
              Save Slot
            </button>
          </form>
        )}

        {/* Saved Slots List */}
        <div className="mt-4 max-h-64 overflow-y-auto space-y-2 pr-1">
          {snapshot.saveSlots.length === 0 ? (
            <div className="py-8 text-center text-xs text-neutral-500">
              No IndexedDB saves stored yet.
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
                    {new Date(slot.savedAt).toLocaleString()} · {Math.floor(slot.playtimeSec)}s
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onLoadSlot(slot.id)}
                    className="px-2.5 py-1 text-xs font-medium bg-neutral-800 text-neutral-100 hover:bg-neutral-700 cursor-pointer"
                  >
                    Load
                  </button>
                  {!isDead && !slot.isQuicksave && (
                    <button
                      type="button"
                      onClick={() => onSaveNamed(slot.name, slot.id)}
                      className="px-2.5 py-1 text-xs font-medium bg-neutral-800 text-amber-300 hover:bg-neutral-700 cursor-pointer"
                    >
                      Overwrite
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDeleteSlot(slot.id)}
                    aria-label={`Delete ${slot.name}`}
                    className="p-1.5 text-neutral-400 hover:text-red-400 cursor-pointer"
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
  );
};

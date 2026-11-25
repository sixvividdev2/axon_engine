import React, { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  DEFAULT_KEYBINDS,
  formatInputCodeLabel,
  isValidInputCode,
  KEYBIND_ACTION_MAP,
  KEYBIND_ACTIONS,
  KEYBIND_GROUPS,
  KeybindActionId,
  keybindStore,
  mouseButtonToCode,
  useKeybinds,
} from '../data/keybindStore';

interface ControlsSettingsTabProps {
  compact?: boolean;
}

interface MapperNotice {
  tone: 'info' | 'warning';
  message: string;
}

export const ControlsSettingsTab: React.FC<ControlsSettingsTabProps> = ({ compact = false }) => {
  const { user } = useAuth();
  const keybinds = useKeybinds();
  const [capturingActionId, setCapturingActionId] = useState<KeybindActionId | null>(null);
  const [notice, setNotice] = useState<MapperNotice | null>(null);

  useEffect(() => {
    if (!capturingActionId) {
      keybindStore.setCapturing(false);
      return;
    }

    keybindStore.setCapturing(true);

    const applyCapturedCode = (inputCode: string) => {
      const result = keybindStore.rebindAction(capturingActionId, inputCode);
      const targetLabel = KEYBIND_ACTION_MAP[capturingActionId].label;
      const keyLabel = formatInputCodeLabel(inputCode);

      if (result.clearedActions.length > 0) {
        const clearedNames = result.clearedActions
          .map((id) => KEYBIND_ACTION_MAP[id].label)
          .join(', ');
        setNotice({
          tone: 'warning',
          message: `Moved [${keyLabel}] from ${clearedNames} to ${targetLabel}. ${clearedNames} is now Unbound.`,
        });
      } else {
        setNotice({
          tone: 'info',
          message: `Bound ${targetLabel} to [${keyLabel}].`,
        });
      }
      setCapturingActionId(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.code === 'Escape') {
        setCapturingActionId(null);
        return;
      }

      if (e.code === 'Backspace' || e.code === 'Delete') {
        const targetLabel = KEYBIND_ACTION_MAP[capturingActionId].label;
        keybindStore.unbindAction(capturingActionId);
        setNotice({
          tone: 'warning',
          message: `${targetLabel} is now Unbound.`,
        });
        setCapturingActionId(null);
        return;
      }

      if (!isValidInputCode(e.code)) {
        setNotice({
          tone: 'warning',
          message: 'That key is reserved by the system and cannot be assigned.',
        });
        return;
      }

      applyCapturedCode(e.code);
    };

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-keybind-cancel="true"]')) {
        e.preventDefault();
        e.stopPropagation();
        setCapturingActionId(null);
        return;
      }

      const mouseCode = mouseButtonToCode(e.button);
      if (!mouseCode) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      applyCapturedCode(mouseCode);
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      keybindStore.setCapturing(false);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [capturingActionId]);

  const hasOverrides = Object.keys(keybinds.overrides).length > 0;

  const persistenceLabel = user
    ? keybinds.syncStatus === 'saving'
      ? `Saving to ${user.username} account...`
      : keybinds.syncStatus === 'error'
        ? `Account sync error — saved locally`
        : `Saved to ${user.username} account`
    : 'Saved locally (Guest)';

  const handleResetAction = (actionId: KeybindActionId) => {
    const res = keybindStore.resetAction(actionId);
    const targetLabel = KEYBIND_ACTION_MAP[actionId].label;
    const defaultLabel = formatInputCodeLabel(DEFAULT_KEYBINDS[actionId]);
    if (res.clearedActions.length > 0) {
      const clearedNames = res.clearedActions.map((id) => KEYBIND_ACTION_MAP[id].label).join(', ');
      setNotice({
        tone: 'warning',
        message: `Restored ${targetLabel} to [${defaultLabel}]. ${clearedNames} is now Unbound.`,
      });
    } else {
      setNotice({
        tone: 'info',
        message: `Restored ${targetLabel} to [${defaultLabel}].`,
      });
    }
  };

  const handleResetAll = () => {
    setCapturingActionId(null);
    keybindStore.resetAllDefaults();
    setNotice({
      tone: 'info',
      message: 'All keybinds restored to defaults.',
    });
  };

  return (
    <div className={compact ? 'flex flex-col gap-3' : 'flex flex-col gap-4'}>
      {/* Persistence & Global Reset Bar */}
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border border-neutral-800 bg-neutral-950 ${
          compact ? 'px-2.5 py-2' : 'px-4 py-2.5'
        }`}
      >
        <div className="min-w-0">
          <div
            className={`font-mono-tabular font-semibold ${
              keybinds.syncStatus === 'error' ? 'text-red-400' : 'text-neutral-200'
            } ${compact ? 'text-[10px]' : 'text-xs'}`}
          >
            {persistenceLabel}
          </div>
          {!compact && (
            <div className="mt-0.5 text-[11px] text-neutral-400">
              Click any key to rebind. Press Esc to cancel or Backspace to unbind.
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleResetAll}
          disabled={!hasOverrides}
          className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap shrink-0 border px-2.5 py-1 font-mono-tabular font-semibold uppercase tracking-wider transition-colors ${
            compact ? 'text-[10px]' : 'text-[11px]'
          } ${
            hasOverrides
              ? 'border-neutral-700 bg-neutral-900 text-neutral-200 hover:border-amber-400 hover:text-amber-300'
              : 'cursor-not-allowed border-neutral-800 bg-neutral-950 text-neutral-600'
          }`}
        >
          <RotateCcw className="h-3 w-3" />
          <span>{compact ? 'Reset All' : 'Reset All Defaults'}</span>
        </button>
      </div>

      {/* Active Capture Prompt */}
      {capturingActionId && (
        <div className="flex items-center justify-between gap-3 border border-amber-500/80 bg-[#1a1409] px-3 py-2 text-xs text-amber-200">
          <span className="font-mono-tabular">
            Listening for <strong>{KEYBIND_ACTION_MAP[capturingActionId].label}</strong> — press any
            key or mouse button (Esc cancels · Backspace unbinds).
          </span>
          <button
            type="button"
            data-keybind-cancel="true"
            onClick={() => setCapturingActionId(null)}
            className="cursor-pointer whitespace-nowrap shrink-0 border border-amber-500/70 bg-neutral-950 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase text-amber-200 hover:bg-amber-500/20"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Conflict / Rebind Notice */}
      {notice && (
        <div
          className={`flex items-start justify-between gap-3 border px-3 py-2 text-xs ${
            notice.tone === 'warning'
              ? 'border-amber-500/60 bg-[#19130a] text-amber-200'
              : 'border-neutral-700 bg-neutral-900 text-neutral-200'
          }`}
          role="status"
        >
          <span className="font-mono-tabular text-[11px] leading-relaxed">{notice.message}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notice"
            className="cursor-pointer shrink-0 p-0.5 text-neutral-400 hover:text-neutral-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Rebindable Action Groups */}
      {KEYBIND_GROUPS.map((group) => {
        const actions = KEYBIND_ACTIONS.filter((a) => a.group === group.id);
        return (
          <section
            key={group.id}
            className={`border border-neutral-800 bg-neutral-900/75 ${compact ? 'p-2.5' : 'p-4'}`}
          >
            <div className="border-b border-neutral-800 pb-2">
              <h3
                className={`font-display font-bold uppercase tracking-wider text-amber-400 ${
                  compact ? 'text-xs' : 'text-sm'
                }`}
              >
                {group.title}
              </h3>
              {!compact && <p className="mt-0.5 text-xs text-neutral-400">{group.description}</p>}
            </div>

            <div
              className={`mt-2.5 grid gap-x-5 gap-y-2 ${
                compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'
              }`}
            >
              {actions.map((def) => {
                const boundCode = keybinds.bindings[def.id];
                const isCapturing = capturingActionId === def.id;
                const isUnbound = boundCode === null;
                const isModified = boundCode !== def.defaultCode;
                const displayLabel = isCapturing ? 'Press key...' : formatInputCodeLabel(boundCode);

                return (
                  <div
                    key={def.id}
                    className="flex items-center justify-between gap-2.5 border-b border-neutral-800/50 pb-1.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div
                        className={
                          compact
                            ? 'text-[11px] text-neutral-100'
                            : 'text-xs font-medium text-neutral-100'
                        }
                      >
                        {def.label}
                      </div>
                      {!compact && def.description && (
                        <div className="mt-0.5 text-[10px] text-neutral-400">{def.description}</div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {isCapturing ? (
                        <>
                          <span className="inline-flex min-w-[76px] items-center justify-center whitespace-nowrap border border-amber-400 bg-amber-500/20 px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase text-amber-200">
                            Press key...
                          </span>
                          <button
                            type="button"
                            data-keybind-cancel="true"
                            onClick={() => setCapturingActionId(null)}
                            className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] uppercase text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setCapturingActionId(def.id)}
                            title={`Click to rebind ${def.label}`}
                            className={`inline-flex min-w-[56px] cursor-pointer items-center justify-center whitespace-nowrap shrink-0 border px-2 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase transition-colors ${
                              isUnbound
                                ? 'border-red-500/70 bg-red-950/60 text-red-300 hover:border-red-400'
                                : isModified
                                  ? 'border-sky-400/70 bg-sky-950/50 text-sky-200 hover:border-amber-400 hover:text-amber-200'
                                  : 'border-neutral-700 bg-neutral-950 text-amber-300 hover:border-amber-400 hover:bg-neutral-900'
                            }`}
                          >
                            {displayLabel}
                          </button>

                          {isModified && (
                            <button
                              type="button"
                              onClick={() => handleResetAction(def.id)}
                              title={`Reset ${def.label} to ${formatInputCodeLabel(def.defaultCode)}`}
                              className="cursor-pointer whitespace-nowrap shrink-0 border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] uppercase text-neutral-400 hover:border-neutral-600 hover:text-neutral-100"
                            >
                              Reset
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* Fixed System Controls Reference */}
      <div className="border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono-tabular text-[10px] text-neutral-400">
        Fixed inputs: <span className="text-neutral-200">Scroll Wheel</span> cycles interact prompts
        &amp; variable optic zoom · <span className="text-neutral-200">Esc</span> opens Pause /
        closes menus · <span className="text-neutral-200">Alt + Laser</span> toggles IR laser mode.
      </div>
    </div>
  );
};

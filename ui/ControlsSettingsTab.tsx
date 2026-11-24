import React from 'react';
import { CONTROL_BINDING_GROUPS } from '../data/controlsCatalog';

interface ControlsSettingsTabProps {
  compact?: boolean;
}

export const ControlsSettingsTab: React.FC<ControlsSettingsTabProps> = ({ compact = false }) => {
  return (
    <div className={compact ? 'flex flex-col gap-3' : 'flex flex-col gap-5'}>
      {CONTROL_BINDING_GROUPS.map((group) => (
        <section
          key={group.id}
          className={`border border-neutral-800 bg-neutral-900/55 ${compact ? 'p-3' : 'p-4'}`}
        >
          <div className="border-b border-neutral-800/80 pb-2">
            <h3
              className={`font-display font-bold uppercase tracking-wider text-amber-400 ${
                compact ? 'text-xs' : 'text-sm'
              }`}
            >
              {group.title}
            </h3>
            {!compact && (
              <p className="mt-0.5 text-xs text-neutral-400">{group.description}</p>
            )}
          </div>

          <div
            className={`mt-2.5 grid gap-x-5 gap-y-2 ${
              compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'
            }`}
          >
            {group.bindings.map((binding) => (
              <div
                key={binding.id}
                className="flex items-start justify-between gap-3 border-b border-neutral-800/40 pb-1.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className={compact ? 'text-[11px] text-neutral-100' : 'text-xs font-medium text-neutral-100'}>
                    {binding.action}
                  </div>
                  {binding.detail && (
                    <div className="mt-0.5 font-mono-tabular text-[10px] text-neutral-400">
                      {binding.detail}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {binding.keys.map((k, idx) => (
                    <React.Fragment key={`${binding.id}-${k}`}>
                      {idx > 0 && (
                        <span className="font-mono-tabular text-[10px] text-neutral-600">/</span>
                      )}
                      <kbd className="inline-flex min-w-[24px] items-center justify-center border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase text-amber-300">
                        {k}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

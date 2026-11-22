import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { useOperatorSelection } from '../bodycam-sdk/operator/OperatorSelectionStore';
import { OPERATOR_PROFILES, OperatorId } from '../bodycam-sdk/operator/OperatorTypes';
import { OperatorUniformId } from '../bodycam-sdk/TacticalUniforms';
import { OperatorPreviewStage } from './OperatorPreviewStage';

interface OperatorSelectPanelProps {
  onDeploy: () => void;
  deployLabel?: string;
}

const UNIFORM_SWATCHES: ReadonlyArray<{
  id: OperatorUniformId;
  label: string;
  swatchHex: string;
}> = [
  { id: 'team_a', label: 'Coalition Slate', swatchHex: '#334861' },
  { id: 'team_b', label: 'OPFOR Arid', swatchHex: '#7d684c' },
  { id: 'ffa', label: 'Contractor Ash', swatchHex: '#3b4046' },
  { id: 'infection', label: 'Containment BDU', swatchHex: '#4b553f' },
];

export const OperatorSelectPanel: React.FC<OperatorSelectPanelProps> = ({
  onDeploy,
  deployLabel = 'Deploy Operator',
}) => {
  const [operatorId, setOperatorId] = useOperatorSelection();
  const [uniformId, setUniformId] = useState<OperatorUniformId>('team_a');
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [contextLost, setContextLost] = useState(false);

  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<OperatorPreviewStage | null>(null);

  useEffect(() => {
    const el = stageContainerRef.current;
    if (!el) return;
    const stage = new OperatorPreviewStage({
      container: el,
      initialOperator: operatorId,
      initialUniform: uniformId,
      onContextStatusChange: (lost) => setContextLost(lost),
    });
    stageRef.current = stage;
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
    // Mount once for stable WebGL context; operator/uniform updates hot-swap below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stageRef.current?.setOperator(operatorId);
  }, [operatorId]);

  useEffect(() => {
    stageRef.current?.setUniform(uniformId);
  }, [uniformId]);

  const profile = OPERATOR_PROFILES[operatorId];

  const handleSelectOperator = (next: OperatorId) => {
    setOperatorId(next);
  };

  return (
    <div className="relative flex h-full w-full flex-1 overflow-hidden border border-neutral-800/80 bg-[#0e1217]">
      {/* Unobstructed 100% Central 3D Inspection Viewport */}
      <div
        ref={stageContainerRef}
        className="h-full w-full"
        aria-label="3D Operator Turntable Preview"
      />

      {/* WebGL context-loss fallback */}
      {contextLost && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0e1217] p-6 text-center">
          <div className="max-w-sm border border-neutral-800 bg-[#12161c] p-5">
            <div className="font-display text-lg font-bold uppercase tracking-wider text-neutral-100">
              3D Preview Unavailable
            </div>
            <p className="mt-2 text-xs leading-relaxed text-neutral-400">
              WebGL preview context was interrupted. Operator selection ({profile.label}) remains
              active and saved for deployment.
            </p>
          </div>
        </div>
      )}

      {/* Minimal Top-Left Callsign Readout (zero sidecards, zero backdrop-blur) */}
      <div className="pointer-events-none absolute top-4 left-5">
        <div className="font-mono-tabular text-[11px] uppercase tracking-[0.2em] text-amber-400">
          {profile.callsign} · {profile.label}
        </div>
        <div className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50">
          {profile.role}
        </div>
        <div className="mt-1 font-mono-tabular text-[11px] text-neutral-400">
          Drag to Rotate · Scroll to Zoom · Double-Click to Reset
        </div>
      </div>

      {/* Collapsible Bottom Control Dock (solid matte slate, zero backdrop-blur) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
        <div className="pointer-events-auto border border-neutral-800 bg-[#0d1014]/95 px-4 py-3 shadow-2xl">
          {dockCollapsed ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono-tabular text-xs uppercase tracking-wider text-neutral-300">
                {profile.label} · {profile.callsign}
              </span>
              <button
                type="button"
                onClick={() => setDockCollapsed(false)}
                className="flex cursor-pointer items-center gap-1.5 border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                <span>Show Controls</span>
              </button>
              <button
                type="button"
                onClick={onDeploy}
                className="cursor-pointer bg-amber-500 px-5 py-1.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
              >
                {deployLabel}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              {/* Male / Female Segmented Toggle */}
              <div className="flex items-center gap-1" role="radiogroup" aria-label="Operator Rig">
                {(['MALE', 'FEMALE'] as const).map((id) => {
                  const active = operatorId === id;
                  const item = OPERATOR_PROFILES[id];
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => handleSelectOperator(id)}
                      className={`cursor-pointer whitespace-nowrap border px-4 py-2 font-display text-sm font-bold uppercase tracking-wider transition-colors ${
                        active
                          ? 'border-amber-400 bg-amber-500 text-neutral-950'
                          : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <div className="hidden h-7 w-px bg-neutral-800 sm:block" />

              {/* Uniform Preview Swatches */}
              <div className="flex items-center gap-1.5" aria-label="Uniform Preview">
                {UNIFORM_SWATCHES.map((sw) => {
                  const active = uniformId === sw.id;
                  return (
                    <button
                      key={sw.id}
                      type="button"
                      onClick={() => setUniformId(sw.id)}
                      title={sw.label}
                      className={`flex cursor-pointer items-center gap-1.5 border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                        active
                          ? 'border-amber-400 bg-neutral-900 text-neutral-100'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                      }`}
                    >
                      <span
                        className="inline-block h-3 w-3 border border-white/20"
                        style={{ backgroundColor: sw.swatchHex }}
                      />
                      <span className="hidden md:inline">{sw.label.split(' ')[0]}</span>
                    </button>
                  );
                })}
              </div>

              <div className="hidden h-7 w-px bg-neutral-800 sm:block" />

              {/* Reset View & Collapse */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => stageRef.current?.resetCamera()}
                  className="flex cursor-pointer items-center gap-1.5 border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-amber-400/70 hover:text-neutral-100"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Reset View</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDockCollapsed(true)}
                  className="flex cursor-pointer items-center gap-1 border border-neutral-800 bg-neutral-950 px-2.5 py-2 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Hide</span>
                </button>
              </div>

              {/* Primary Deploy CTA */}
              <button
                type="button"
                onClick={onDeploy}
                className="cursor-pointer whitespace-nowrap bg-amber-500 px-6 py-2 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
              >
                {deployLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

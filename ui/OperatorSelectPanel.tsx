import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import {
  useOperatorGearConfig,
  useOperatorSelection,
} from '../bodycam-sdk/operator/OperatorSelectionStore';
import {
  GLOVE_COLOR_LIST,
  HELMET_COLOR_LIST,
  HELMET_TYPE_LIST,
  NVG_MOUNT_LIST,
  OPERATOR_PROFILES,
  OperatorId,
} from '../bodycam-sdk/operator/OperatorTypes';
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

type GearDockTab = 'rig' | 'gloves' | 'helmet';

export const OperatorSelectPanel: React.FC<OperatorSelectPanelProps> = ({
  onDeploy,
  deployLabel = 'Deploy Operator',
}) => {
  const [operatorId, setOperatorId] = useOperatorSelection();
  const [gear, updateGear] = useOperatorGearConfig();
  const [activeTab, setActiveTab] = useState<GearDockTab>('rig');
  const [nvgFlippedPreview, setNvgFlippedPreview] = useState(false);
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
      initialUniform: gear.uniformId,
      initialGear: gear,
      onContextStatusChange: (lost) => setContextLost(lost),
    });
    stageRef.current = stage;
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
    // Mount once for stable WebGL context; operator & gear updates hot-swap below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stageRef.current?.setOperator(operatorId);
  }, [operatorId]);

  useEffect(() => {
    stageRef.current?.setGear(gear);
    if (gear.nvgMount === 'none' && nvgFlippedPreview) {
      setNvgFlippedPreview(false);
    }
  }, [gear, nvgFlippedPreview]);

  useEffect(() => {
    stageRef.current?.setNvgFlipped(nvgFlippedPreview);
  }, [nvgFlippedPreview]);

  const profile = OPERATOR_PROFILES[operatorId];
  const helmetSpec = HELMET_TYPE_LIST.find((h) => h.id === gear.helmetType) ?? HELMET_TYPE_LIST[0];
  const nvgSpec = NVG_MOUNT_LIST.find((n) => n.id === gear.nvgMount) ?? NVG_MOUNT_LIST[0];
  const gloveColorSpec = GLOVE_COLOR_LIST.find((g) => g.id === gear.gloveColor) ?? GLOVE_COLOR_LIST[0];
  const helmetColorSpec =
    HELMET_COLOR_LIST.find((c) => c.id === gear.helmetColor) ?? HELMET_COLOR_LIST[0];
  const canMountNvg = helmetSpec.hasMount;

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

      {/* Minimal Top-Left Callsign & Active Gear Summary (zero sidecards, zero backdrop-blur) */}
      <div className="pointer-events-none absolute top-4 left-5">
        <div className="font-mono-tabular text-[11px] uppercase tracking-[0.2em] text-amber-400">
          {profile.callsign} · {profile.label}
        </div>
        <div className="mt-0.5 font-display text-2xl font-bold uppercase tracking-wide text-neutral-50">
          {profile.role}
        </div>
        <div className="mt-1 font-mono-tabular text-[11px] text-neutral-300">
          {helmetSpec.label} ({helmetColorSpec.label}) ·{' '}
          {gear.nvgMount === 'none' ? 'No NVG' : `${nvgSpec.shortLabel} (${nvgSpec.phosphorLabel})`} ·{' '}
          {gear.glovesEnabled ? `Gloves: ${gloveColorSpec.label}` : 'Bare Hands'}
        </div>
        <div className="mt-0.5 font-mono-tabular text-[11px] text-neutral-500">
          Drag to Rotate · Scroll to Zoom · Double-Click to Reset
        </div>
      </div>

      {/* Collapsible Bottom Control Dock (solid matte slate, zero backdrop-blur) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
        <div className="pointer-events-auto max-w-[min(980px,96vw)] border border-neutral-800 bg-[#0d1014]/95 px-4 py-3 shadow-2xl">
          {dockCollapsed ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono-tabular text-xs uppercase tracking-wider text-neutral-300">
                {profile.label} · {helmetSpec.shortLabel} · {nvgSpec.shortLabel}
              </span>
              <button
                type="button"
                onClick={() => setDockCollapsed(false)}
                className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-200 transition-colors hover:border-amber-400/70 hover:text-amber-300"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                <span>Show Controls</span>
              </button>
              <button
                type="button"
                onClick={onDeploy}
                className="cursor-pointer whitespace-nowrap bg-amber-500 px-5 py-1.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
              >
                {deployLabel}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Top Row: Category Tabs + Utility Actions + Deploy */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800/90 pb-2.5">
                <div className="flex items-center gap-1" role="tablist" aria-label="Operator Customization">
                  {(
                    [
                      { id: 'rig', label: 'Operator & Uniform' },
                      { id: 'gloves', label: 'Gloves' },
                      { id: 'helmet', label: 'Helmet & NVG' },
                    ] as const
                  ).map((tab) => {
                    const active = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setActiveTab(tab.id)}
                        className={`cursor-pointer whitespace-nowrap border px-3.5 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider transition-colors ${
                          active
                            ? 'border-amber-400 bg-amber-500/15 text-amber-300'
                            : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                        }`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  {gear.nvgMount !== 'none' && (
                    <button
                      type="button"
                      onClick={() => setNvgFlippedPreview((prev) => !prev)}
                      className={`cursor-pointer whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider transition-colors ${
                        nvgFlippedPreview
                          ? 'border-emerald-400 bg-emerald-500/15 text-emerald-300'
                          : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-amber-400/70 hover:text-neutral-100'
                      }`}
                    >
                      {nvgFlippedPreview ? 'Stow NVG' : 'Flip NVG Down'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => stageRef.current?.resetCamera()}
                    className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-amber-400/70 hover:text-neutral-100"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset View</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDockCollapsed(true)}
                    className="flex cursor-pointer items-center gap-1 whitespace-nowrap border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                    <span>Hide</span>
                  </button>
                  <button
                    type="button"
                    onClick={onDeploy}
                    className="cursor-pointer whitespace-nowrap bg-amber-500 px-5 py-1.5 font-display text-sm font-bold uppercase tracking-wider text-neutral-950 transition-colors hover:bg-amber-400"
                  >
                    {deployLabel}
                  </button>
                </div>
              </div>

              {/* Active Tab Controls */}
              {activeTab === 'rig' && (
                <div className="flex flex-wrap items-center gap-4">
                  {/* Male / Female Segmented Toggle */}
                  <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Operator Rig">
                    <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                      Operator
                    </span>
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
                          className={`cursor-pointer whitespace-nowrap border px-4 py-1.5 font-display text-sm font-bold uppercase tracking-wider transition-colors ${
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

                  <div className="hidden h-6 w-px bg-neutral-800 sm:block" />

                  {/* Persisted Uniform Selector */}
                  <div className="flex flex-wrap items-center gap-1.5" aria-label="Uniform">
                    <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                      Uniform
                    </span>
                    {UNIFORM_SWATCHES.map((sw) => {
                      const active = gear.uniformId === sw.id;
                      return (
                        <button
                          key={sw.id}
                          type="button"
                          onClick={() => updateGear({ uniformId: sw.id })}
                          title={sw.label}
                          className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                            active
                              ? 'border-amber-400 bg-neutral-900 text-neutral-100'
                              : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                          }`}
                        >
                          <span
                            className="inline-block h-3 w-3 border border-white/20"
                            style={{ backgroundColor: sw.swatchHex }}
                          />
                          <span>{sw.label.split(' ')[0]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'gloves' && (
                <div className="flex flex-wrap items-center gap-4">
                  {/* Gloves ON / Bare Hands */}
                  <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Gloves Toggle">
                    <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                      Hands
                    </span>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={gear.glovesEnabled}
                      onClick={() => updateGear({ glovesEnabled: true })}
                      className={`cursor-pointer whitespace-nowrap border px-3.5 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider transition-colors ${
                        gear.glovesEnabled
                          ? 'border-amber-400 bg-amber-500 text-neutral-950 font-semibold'
                          : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500'
                      }`}
                    >
                      Gloves On
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!gear.glovesEnabled}
                      onClick={() => updateGear({ glovesEnabled: false })}
                      className={`cursor-pointer whitespace-nowrap border px-3.5 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider transition-colors ${
                        !gear.glovesEnabled
                          ? 'border-amber-400 bg-amber-500 text-neutral-950 font-semibold'
                          : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500'
                      }`}
                    >
                      Bare Hands
                    </button>
                  </div>

                  <div className="hidden h-6 w-px bg-neutral-800 sm:block" />

                  {/* Glove Color Swatches */}
                  <div className="flex flex-wrap items-center gap-1.5" aria-label="Glove Color">
                    <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                      Color
                    </span>
                    {GLOVE_COLOR_LIST.map((color) => {
                      const active = gear.glovesEnabled && gear.gloveColor === color.id;
                      return (
                        <button
                          key={color.id}
                          type="button"
                          disabled={!gear.glovesEnabled}
                          onClick={() => updateGear({ glovesEnabled: true, gloveColor: color.id })}
                          title={color.label}
                          className={`flex items-center gap-1.5 whitespace-nowrap border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                            !gear.glovesEnabled
                              ? 'cursor-not-allowed border-neutral-800/60 bg-neutral-950/60 text-neutral-600'
                              : active
                                ? 'cursor-pointer border-amber-400 bg-neutral-900 text-neutral-100'
                                : 'cursor-pointer border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                          }`}
                        >
                          <span
                            className="inline-block h-3 w-3 border border-white/25"
                            style={{ backgroundColor: color.swatchHex }}
                          />
                          <span>{color.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeTab === 'helmet' && (
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-4">
                    {/* Helmet Shell Type: MICH vs Mil-Tec */}
                    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Helmet Model">
                      <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                        Helmet
                      </span>
                      {HELMET_TYPE_LIST.map((h) => {
                        const active = gear.helmetType === h.id;
                        return (
                          <button
                            key={h.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => updateGear({ helmetType: h.id })}
                            title={h.summary}
                            className={`cursor-pointer whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] uppercase tracking-wider transition-colors ${
                              active
                                ? 'border-amber-400 bg-amber-500 text-neutral-950 font-semibold'
                                : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100'
                            }`}
                          >
                            {h.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="hidden h-6 w-px bg-neutral-800 sm:block" />

                    {/* Helmet Color Swatches */}
                    <div className="flex flex-wrap items-center gap-1.5" aria-label="Helmet Color">
                      <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                        Finish
                      </span>
                      {HELMET_COLOR_LIST.map((c) => {
                        const active = gear.helmetColor === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => updateGear({ helmetColor: c.id })}
                            title={c.label}
                            className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border px-2.5 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                              active
                                ? 'border-amber-400 bg-neutral-900 text-neutral-100'
                                : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                            }`}
                          >
                            <span
                              className="inline-block h-3 w-3 border border-white/25"
                              style={{ backgroundColor: c.swatchHex }}
                            />
                            <span>{c.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* NVG Shroud Mount Row */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800/70 pt-2">
                    <span className="mr-1 font-mono-tabular text-[11px] uppercase tracking-wider text-neutral-400">
                      NVG Mount
                    </span>
                    {NVG_MOUNT_LIST.map((nvg) => {
                      const active = gear.nvgMount === nvg.id;
                      const locked = nvg.id !== 'none' && !canMountNvg;
                      return (
                        <button
                          key={nvg.id}
                          type="button"
                          disabled={locked}
                          onClick={() => updateGear({ nvgMount: nvg.id })}
                          title={locked ? 'Requires Mil-Tec Helmet with Wilcox Shroud' : nvg.summary}
                          className={`whitespace-nowrap border px-3 py-1.5 font-mono-tabular text-[11px] transition-colors ${
                            locked
                              ? 'cursor-not-allowed border-neutral-800/50 bg-neutral-950/50 text-neutral-600'
                              : active
                                ? 'cursor-pointer border-amber-400 bg-amber-500/15 text-amber-200'
                                : 'cursor-pointer border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                          }`}
                        >
                          {nvg.label}
                          {nvg.id !== 'none' ? ` · ${nvg.phosphorLabel}` : ''}
                        </button>
                      );
                    })}
                    {!canMountNvg ? (
                      <span className="font-mono-tabular text-[11px] text-neutral-500">
                        MICH has no shroud — select Mil-Tec to mount NVGs
                      </span>
                    ) : (
                      <span className="font-mono-tabular text-[11px] text-neutral-400">
                        In-Game: [J] Flip NVG · [N] IR Illuminator
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

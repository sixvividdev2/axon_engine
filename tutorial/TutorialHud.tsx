import React from 'react';
import {
  Check,
  ChevronRight,
  Crosshair,
  RotateCcw,
  Settings,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { openGameSettings } from '../data/gameSettingsStore';
import { formatInputCodeLabel, KeybindActionId, useKeybinds } from '../data/keybindStore';
import { TUTORIAL_STEPS, TutorialStepId } from './TutorialCourseLogic';
import type { TutorialSnapshot } from './TutorialEngine';

interface TutorialHudProps {
  snapshot: TutorialSnapshot;
  returnLabel: string;
  onRequestLock: () => void;
  onSkipStep: () => void;
  onJumpStep: (index: number) => void;
  onRestart: () => void;
  onVolumeChange: (vol: number) => void;
  onExit: () => void;
}

function formatTimer(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const TutorialHud: React.FC<TutorialHudProps> = ({
  snapshot,
  returnLabel,
  onRequestLock,
  onSkipStep,
  onJumpStep,
  onRestart,
  onVolumeChange,
  onExit,
}) => {
  const keybinds = useKeybinds();
  const k = (action: KeybindActionId) => formatInputCodeLabel(keybinds.bindings[action]);

  const resolveTaskKeyHint = (taskId: string, fallback: string): string => {
    switch (taskId) {
      case 'move':
        return `${k('move_forward')} ${k('move_left')} ${k('move_backward')} ${k('move_right')}`;
      case 'sprint':
        return k('sprint');
      case 'crouch':
        return k('crouch');
      case 'lean':
        return `${k('lean_left')} / ${k('lean_right')}`;
      case 'vault':
        return k('vault');
      case 'ads':
        return k('ads');
      case 'hold_breath':
        return k('hold_breath');
      case 'targets':
        return k('fire');
      case 'alt_aim':
        return `${k('canted_optic')} / ${k('point_aim')}`;
      case 'reload':
        return k('reload');
      case 'accessory':
        return `${k('suppressor')} / ${k('inspect')}`;
      case 'swap':
        return `${k('slot_primary')} / ${k('slot_secondary')} / ${k('slot_knife')}`;
      case 'door':
        return `${k('interact')} / ${k('push_kick')}`;
      case 'melee':
        return `${k('melee_bash')} / ${k('push_kick')}`;
      case 'light_laser':
        return `${k('flashlight')} / ${k('laser')}`;
      case 'nvg':
        return k('nvg');
      case 'draw':
        return `${k('grenade_belt')} / ${k('grenade_draw')}`;
      case 'pin':
        return k('ads');
      case 'throw':
        return k('fire');
      case 'open_pda':
        return `${k('pda')} / ${k('tactical_map')}`;
      case 'pda_action':
        return `${k('vault')} / ${k('ping')}`;
      default:
        return fallback;
    }
  };

  const resolveStepSummary = (stepId: TutorialStepId, fallback: string): string => {
    switch (stepId) {
      case 'move_stance':
        return `${k('move_forward')}${k('move_left')}${k('move_backward')}${k('move_right')} Move · ${k('sprint')} Sprint · ${k('crouch')} Crouch · ${k('lean_left')}/${k('lean_right')} Lean`;
      case 'vault_mantle':
        return `${k('vault')} Vault / Mantle Barrier`;
      case 'aim_shoot':
        return `${k('ads')} ADS · ${k('hold_breath')} Hold Breath · ${k('fire')} Fire · ${k('switch_fire_mode')} Fire Mode`;
      case 'weapon_handling':
        return `${k('canted_optic')} Canted · ${k('point_aim')} Point Aim · ${k('reload')} Reload · ${k('suppressor')} Suppressor · ${k('switch_fire_mode')} Fire Mode`;
      case 'breach_cqb':
        return `${k('interact')} Interact Door · ${k('melee_bash')} Weapon Bash · ${k('push_kick')} Push-Kick Breach`;
      case 'tactical_optics':
        return `${k('flashlight')} Flashlight · ${k('laser')} Laser · ${k('nvg')} Flip NVG`;
      case 'grenade_throw':
        return `${k('grenade_belt')} / ${k('grenade_draw')} Draw · ${k('ads')} Pull Pin · ${k('fire')} Throw`;
      case 'pda_fire_support':
        return `${k('pda')} / ${k('tactical_map')} Open PDA · ${k('scoreboard_inventory')} Fire Support · ${k('vault')} Strike · ${k('ping')} Ping`;
      default:
        return fallback;
    }
  };

  const { course } = snapshot;
  const { activeStep } = course;
  const showStartGate = !snapshot.pointerLocked && !snapshot.pauseOpen && !course.courseComplete;
  const showPause = snapshot.pauseOpen && !course.courseComplete;

  return (
    <div className="pointer-events-none fixed inset-0 z-20 select-none text-neutral-100">
      {/* Top-Left Compact Walkthrough Objective Card (solid surface, zero backdrop-blur) */}
      {!course.courseComplete && (
        <div className="fixed top-4 left-4 w-[320px] max-w-[90vw] border border-white/12 bg-[#0d1014]/92 px-4 py-3.5 shadow-xl">
          <div className="flex items-baseline justify-between gap-2 text-xs text-neutral-400">
            <span className="font-medium text-amber-400">
              {activeStep.bayLabel} · Step {course.currentStepIndex + 1} of {course.totalSteps}
            </span>
            <span className="font-mono-tabular text-[11px] text-neutral-400">
              {formatTimer(course.elapsedSec)}
            </span>
          </div>

          <h1 className="mt-1 font-display text-lg font-semibold leading-snug text-neutral-50">
            {activeStep.title}
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-neutral-300">
            {activeStep.instruction}
          </p>

          {/* Live Sub-Task Checklist */}
          <ul className="mt-3 space-y-1.5 border-t border-white/10 pt-2.5">
            {course.tasks.map((task) => (
              <li
                key={task.id}
                className={`flex items-center justify-between gap-2 text-xs ${
                  task.done ? 'text-emerald-300' : 'text-neutral-200'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] ${
                      task.done
                        ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-300'
                        : 'border-white/20 bg-neutral-900 text-neutral-500'
                    }`}
                  >
                    {task.done ? <Check className="h-3 w-3" /> : ''}
                  </span>
                  <span className={task.done ? 'line-through opacity-75' : ''}>
                    {task.label}
                    {task.requiredCount > 1
                      ? ` (${task.currentCount}/${task.requiredCount})`
                      : ''}
                  </span>
                </span>
                <span className="shrink-0 font-mono-tabular text-[11px] text-amber-300/90">
                  {resolveTaskKeyHint(task.id, task.keyHint)}
                </span>
              </li>
            ))}
          </ul>

          {/* Thin progress bar */}
          <div className="mt-3 h-1 w-full bg-neutral-800">
            <div
              className="h-full bg-amber-500 transition-transform duration-200 origin-left"
              style={{
                transform: `scaleX(${Math.max(
                  0.06,
                  (course.completedStepIds.length + (course.stepJustCompleted ? 0 : 0.25)) /
                    course.totalSteps,
                )})`,
              }}
            />
          </div>
        </div>
      )}

      {/* Minimal Top-Right Weapon / Gear Readout */}
      {snapshot.pointerLocked && !course.courseComplete && (
        <div className="fixed top-4 right-4 border border-white/10 bg-[#0d1014]/88 px-3.5 py-2 text-right font-mono-tabular text-xs text-neutral-200">
          <div className="font-semibold text-neutral-50">{snapshot.equippedWeaponName}</div>
          <div className="mt-0.5 text-[11px] text-neutral-400">
            {snapshot.magCapacity > 0
              ? `${snapshot.ammoInMag} / ${snapshot.magCapacity} · ${snapshot.fireModeLabel}`
              : 'Melee'}
            {' · '}
            Grenades {snapshot.grenadeCount}
            {snapshot.nvgActive ? ' · NVG ON' : ''}
            {snapshot.flashlightOn ? ' · Light' : ''}
            {snapshot.laserOn ? ' · Laser' : ''}
          </div>
        </div>
      )}

      {/* Contextual Door Interact Prompt */}
      {snapshot.pointerLocked && snapshot.doorPrompt && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 border border-amber-500/45 bg-[#0d1014]/92 px-4 py-1.5 font-mono-tabular text-xs text-amber-200">
          {snapshot.doorPrompt}
        </div>
      )}

      {/* Action Feedback Toast */}
      {snapshot.toastMessage && snapshot.pointerLocked && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 border border-white/14 bg-[#0d1014]/94 px-4 py-1.5 text-xs font-medium text-neutral-100">
          {snapshot.toastMessage}
        </div>
      )}

      {/* Compact Bottom Keybind Strip */}
      {snapshot.pointerLocked && !course.courseComplete && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 border border-white/10 bg-[#0d1014]/88 px-4 py-2 font-mono-tabular text-[11px] text-neutral-300 whitespace-nowrap">
          <span>{resolveStepSummary(activeStep.id, activeStep.keySummary)}</span>
          <span className="mx-2 text-neutral-600">·</span>
          <span className="text-neutral-400">Esc Pause / Skip Station</span>
        </div>
      )}

      {/* Initial Entry Gate */}
      {showStartGate && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-[#07090c]/70 p-6">
          <div className="w-full max-w-md border border-white/12 bg-[#101318] p-6 text-neutral-100 shadow-2xl">
            <div className="text-xs font-medium text-amber-400">
              8-Station 3D Field Course
            </div>
            <h2 className="mt-1 font-display text-2xl font-semibold text-neutral-50">
              Interactive Mechanics Walkthrough
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-neutral-300">
              Walk through an 8-bay training killhouse to practice movement, vaulting,
              marksmanship, optics, door breaching, night vision, grenades, and the 3D
              TAC-PDA. Press Esc at any time to skip a station or exit.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={onRequestLock}
                className="flex flex-1 cursor-pointer items-center justify-center gap-2 bg-amber-500 px-4 py-2.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap"
              >
                <Crosshair className="h-4 w-4" />
                <span>Start Walkthrough</span>
              </button>
              <button
                type="button"
                onClick={onExit}
                className="cursor-pointer border border-white/14 bg-[#171b22] px-4 py-2.5 text-xs font-medium text-neutral-300 transition-colors hover:border-white/30 hover:text-white whitespace-nowrap"
              >
                {returnLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ESC Pause Menu (Jump Stations, Skip, Restart, Settings, Exit) */}
      {showPause && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-[#07090c]/78 p-6">
          <div className="w-full max-w-md border border-white/12 bg-[#101318] p-6 text-neutral-100 shadow-2xl">
            <div className="flex items-baseline justify-between border-b border-white/10 pb-3.5">
              <div>
                <h2 className="font-display text-xl font-semibold text-neutral-50">
                  Tutorial Paused
                </h2>
                <p className="mt-0.5 text-xs text-neutral-400">
                  {activeStep.bayLabel} · {activeStep.title}
                </p>
              </div>
              <button
                type="button"
                onClick={onRequestLock}
                className="cursor-pointer bg-amber-500 px-4 py-2 text-xs font-semibold text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap"
              >
                Resume
              </button>
            </div>

            {/* Station Quick-Jump List */}
            <div className="mt-4">
              <div className="text-xs font-medium text-neutral-400">Jump to Station</div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {TUTORIAL_STEPS.map((st) => {
                  const active = st.index === course.currentStepIndex;
                  const done = course.completedStepIds.includes(st.id);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => {
                        onJumpStep(st.index);
                        onRequestLock();
                      }}
                      className={`flex cursor-pointer items-center justify-between gap-1.5 border px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                        active
                          ? 'border-amber-400/70 bg-amber-500/15 text-amber-100'
                          : done
                            ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200 hover:border-emerald-400/60'
                            : 'border-white/10 bg-[#161a21] text-neutral-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      <span className="truncate">
                        {st.index + 1}. {st.title.split('&')[0].trim()}
                      </span>
                      {done ? (
                        <Check className="h-3 w-3 shrink-0 text-emerald-400" />
                      ) : (
                        <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Utility Actions */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  onSkipStep();
                  onRequestLock();
                }}
                className="flex cursor-pointer items-center justify-center gap-1.5 border border-white/12 bg-[#171b22] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-white whitespace-nowrap"
              >
                <SkipForward className="h-3.5 w-3.5 text-amber-400" />
                <span>Skip Station</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onRestart();
                  onRequestLock();
                }}
                className="flex cursor-pointer items-center justify-center gap-1.5 border border-white/12 bg-[#171b22] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-white/30 hover:text-white whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5 text-neutral-400" />
                <span>Restart Course</span>
              </button>
            </div>

            {/* Volume & Settings */}
            <div className="mt-4 space-y-3 border-t border-white/10 pt-3.5">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="tut-master-vol"
                  className="flex items-center gap-2 text-xs text-neutral-300 whitespace-nowrap"
                >
                  <Volume2 className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Master Audio</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="tut-master-vol"
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(snapshot.masterVolume * 100)}
                    onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
                    className="h-1.5 w-32 accent-amber-500"
                  />
                  <span className="w-9 text-right font-mono-tabular text-xs text-neutral-400">
                    {Math.round(snapshot.masterVolume * 100)}%
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openGameSettings('controls')}
                  className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 border border-white/12 bg-[#171b22] px-3 py-2 text-xs font-medium text-neutral-200 transition-colors hover:border-amber-400/60 hover:text-white whitespace-nowrap"
                >
                  <Settings className="h-3.5 w-3.5 text-neutral-400" />
                  <span>Settings &amp; Controls</span>
                </button>
                <button
                  type="button"
                  onClick={onExit}
                  className="flex-1 cursor-pointer border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs font-medium text-red-200 transition-colors hover:border-red-400 hover:bg-red-900/45 whitespace-nowrap"
                >
                  {returnLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Course Complete Summary */}
      {course.courseComplete && (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-[#07090c]/80 p-6">
          <div className="w-full max-w-md border border-emerald-500/40 bg-[#101318] p-6 text-neutral-100 shadow-2xl">
            <div className="text-xs font-medium text-emerald-400">
              All 8 Stations Cleared · {formatTimer(course.elapsedSec)}
            </div>
            <h2 className="mt-1 font-display text-2xl font-semibold text-neutral-50">
              Field Training Complete
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-neutral-300">
              You have completed movement, vaulting, marksmanship, weapon handling,
              breaching, night vision, belt ordnance, and 3D TAC-PDA fire support drills.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={onExit}
                className="flex-1 cursor-pointer bg-amber-500 px-4 py-2.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-amber-400 whitespace-nowrap"
              >
                {returnLabel}
              </button>
              <button
                type="button"
                onClick={() => {
                  onRestart();
                  onRequestLock();
                }}
                className="flex cursor-pointer items-center gap-1.5 border border-white/14 bg-[#171b22] px-4 py-2.5 text-xs font-medium text-neutral-200 transition-colors hover:border-white/30 hover:text-white whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Run Again</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

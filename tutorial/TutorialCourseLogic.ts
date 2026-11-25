export type TutorialStepId =
  | 'move_stance'
  | 'vault_mantle'
  | 'aim_shoot'
  | 'weapon_handling'
  | 'breach_cqb'
  | 'tactical_optics'
  | 'grenade_throw'
  | 'pda_fire_support';

export type TutorialEventType =
  | 'move'
  | 'sprint'
  | 'crouch'
  | 'lean'
  | 'vault'
  | 'ads'
  | 'hold_breath'
  | 'steel_hit'
  | 'alt_aim'
  | 'reload'
  | 'accessory'
  | 'weapon_swap'
  | 'door_interact'
  | 'melee'
  | 'light_or_laser'
  | 'nvg_toggle'
  | 'grenade_draw'
  | 'grenade_pin'
  | 'grenade_throw'
  | 'pda_open'
  | 'pda_action';

export interface TutorialTaskSpec {
  readonly id: string;
  readonly label: string;
  readonly keyHint: string;
  readonly event: TutorialEventType;
  readonly requiredCount: number;
}

export interface TutorialStepSpec {
  readonly id: TutorialStepId;
  readonly index: number;
  readonly bayLabel: string;
  readonly title: string;
  readonly instruction: string;
  readonly keySummary: string;
  readonly spawnPos: readonly [number, number, number];
  readonly spawnYaw: number;
  readonly waypointPos: readonly [number, number, number];
  readonly tasks: readonly TutorialTaskSpec[];
}

export interface TutorialTaskProgress {
  readonly id: string;
  readonly label: string;
  readonly keyHint: string;
  readonly currentCount: number;
  readonly requiredCount: number;
  readonly done: boolean;
}

export interface TutorialCourseSnapshot {
  readonly currentStepIndex: number;
  readonly totalSteps: number;
  readonly activeStep: TutorialStepSpec;
  readonly tasks: readonly TutorialTaskProgress[];
  readonly completedStepIds: readonly TutorialStepId[];
  readonly courseComplete: boolean;
  readonly stepJustCompleted: boolean;
  readonly elapsedSec: number;
}

export const TUTORIAL_STEPS: readonly TutorialStepSpec[] = [
  {
    id: 'move_stance',
    index: 0,
    bayLabel: 'Bay 01',
    title: 'Movement, Sprint & Stance',
    instruction: 'Move down the lane, sprint, crouch under the yellow beam, and lean past the barricade.',
    keySummary: 'WASD Move · Shift Sprint · C Crouch · Q/E Lean',
    spawnPos: [0, 0, 22.0],
    spawnYaw: 0,
    waypointPos: [0, 0, 14.2],
    tasks: [
      { id: 'move', label: 'Move forward into Bay 01', keyHint: 'W A S D', event: 'move', requiredCount: 1 },
      { id: 'sprint', label: 'Hold Tactical Sprint', keyHint: 'Shift', event: 'sprint', requiredCount: 1 },
      { id: 'crouch', label: 'Toggle Crouch under beam', keyHint: 'C', event: 'crouch', requiredCount: 1 },
      { id: 'lean', label: 'Lean left or right', keyHint: 'Q / E', event: 'lean', requiredCount: 1 },
    ],
  },
  {
    id: 'vault_mantle',
    index: 1,
    bayLabel: 'Bay 02',
    title: 'Vaulting & Obstacles',
    instruction: 'Walk up to the concrete Jersey barrier and press Space to vault cleanly over it.',
    keySummary: 'Space Vault / Mantle Barrier',
    spawnPos: [0, 0, 12.2],
    spawnYaw: 0,
    waypointPos: [0, 0, 7.6],
    tasks: [
      { id: 'vault', label: 'Vault over the concrete barrier', keyHint: 'Space', event: 'vault', requiredCount: 1 },
    ],
  },
  {
    id: 'aim_shoot',
    index: 2,
    bayLabel: 'Bay 03',
    title: 'Aiming, Hold Breath & Shooting',
    instruction: 'Aim down sights at the firing line, steady your breath, and ring all 3 steel targets.',
    keySummary: 'RMB ADS · Shift Hold Breath · LMB Fire',
    spawnPos: [-1.4, 0, 3.8],
    spawnYaw: -0.25,
    waypointPos: [-1.4, 0, 1.8],
    tasks: [
      { id: 'ads', label: 'Aim Down Sights', keyHint: 'RMB', event: 'ads', requiredCount: 1 },
      { id: 'hold_breath', label: 'Hold Breath while ADS', keyHint: 'Shift', event: 'hold_breath', requiredCount: 1 },
      { id: 'targets', label: 'Hit reactive steel targets', keyHint: 'LMB', event: 'steel_hit', requiredCount: 3 },
    ],
  },
  {
    id: 'weapon_handling',
    index: 3,
    bayLabel: 'Bay 04',
    title: 'Optics, Reload & Weapon Slots',
    instruction: 'Test backup aiming, reload your rifle, attach/detach the suppressor, and swap slots.',
    keySummary: 'B Canted · MMB Point Aim · R Reload · G Suppressor · 1/2/3 Slots',
    spawnPos: [0, 0, -4.6],
    spawnYaw: 0,
    waypointPos: [0, 0, -7.8],
    tasks: [
      { id: 'alt_aim', label: 'Toggle Canted Optic or Point Aim', keyHint: 'B / MMB', event: 'alt_aim', requiredCount: 1 },
      { id: 'reload', label: 'Reload your weapon', keyHint: 'R', event: 'reload', requiredCount: 1 },
      { id: 'accessory', label: 'Toggle Suppressor or Inspect', keyHint: 'G / I', event: 'accessory', requiredCount: 1 },
      { id: 'swap', label: 'Swap weapon slots (Sidearm / Knife)', keyHint: '1 / 2 / 3', event: 'weapon_swap', requiredCount: 1 },
    ],
  },
  {
    id: 'breach_cqb',
    index: 4,
    bayLabel: 'Bay 05',
    title: 'Doors & CQB Breach',
    instruction: 'Interact with the training door or kick it open, and practice a melee strike.',
    keySummary: 'F Interact Door · V Weapon Bash · X Push-Kick Breach',
    spawnPos: [0, 0, -12.6],
    spawnYaw: 0,
    waypointPos: [0, 0, -15.4],
    tasks: [
      { id: 'door', label: 'Open or kick-breach the door', keyHint: 'F / X', event: 'door_interact', requiredCount: 1 },
      { id: 'melee', label: 'Perform Weapon Bash or Push-Kick', keyHint: 'V / X', event: 'melee', requiredCount: 1 },
    ],
  },
  {
    id: 'tactical_optics',
    index: 5,
    bayLabel: 'Bay 06',
    title: 'Flashlight, Laser & Night Vision',
    instruction: 'Step into the darkened alcove, activate your light or laser, and flip down NVGs.',
    keySummary: 'T Flashlight · L Laser · J Flip NVG',
    spawnPos: [0, 0, -19.8],
    spawnYaw: 0,
    waypointPos: [0, 0, -23.4],
    tasks: [
      { id: 'light_laser', label: 'Toggle Flashlight or Laser', keyHint: 'T / L', event: 'light_or_laser', requiredCount: 1 },
      { id: 'nvg', label: 'Flip Night Vision Goggles', keyHint: 'J', event: 'nvg_toggle', requiredCount: 1 },
    ],
  },
  {
    id: 'grenade_throw',
    index: 6,
    bayLabel: 'Bay 07',
    title: 'Belt Ordnance (Grenades)',
    instruction: 'Draw a frag grenade from your belt, pull the pin, and toss it into the blast pit.',
    keySummary: '4 / H Draw · RMB Pull Pin · LMB Throw',
    spawnPos: [0, 0, -28.4],
    spawnYaw: 0,
    waypointPos: [0, 0, -31.0],
    tasks: [
      { id: 'draw', label: 'Draw belt grenade', keyHint: '4 / H', event: 'grenade_draw', requiredCount: 1 },
      { id: 'pin', label: 'Pull safety pin', keyHint: 'RMB', event: 'grenade_pin', requiredCount: 1 },
      { id: 'throw', label: 'Throw grenade into pit', keyHint: 'LMB', event: 'grenade_throw', requiredCount: 1 },
    ],
  },
  {
    id: 'pda_fire_support',
    index: 7,
    bayLabel: 'Bay 08',
    title: '3D TAC-PDA, Map & Fire Support',
    instruction: 'Raise your TAC-PDA to check the tactical map, then call a training strike or drop a ping.',
    keySummary: 'P / M Open PDA · Tab Fire Support · Space Strike · Z Ping',
    spawnPos: [0, 0, -36.8],
    spawnYaw: 0,
    waypointPos: [0, 0, -39.6],
    tasks: [
      { id: 'open_pda', label: 'Open 3D TAC-PDA / Map', keyHint: 'P / M', event: 'pda_open', requiredCount: 1 },
      { id: 'pda_action', label: 'Call Fire Support or Ping target', keyHint: 'Space / Z', event: 'pda_action', requiredCount: 1 },
    ],
  },
];

const AUTO_ADVANCE_DELAY_SEC = 0.85;

/**
 * Pure state machine driving the 8-station 3D Mechanics Walkthrough Tutorial.
 * Zero DOM/WebGL coupling so it can be unit-tested deterministically.
 */
export class TutorialCourseStateMachine {
  private currentStepIndex = 0;
  private taskCounts = new Map<string, number>();
  private completedSteps = new Set<TutorialStepId>();
  private uniqueSteelTargetsHit = new Set<string>();
  private courseComplete = false;
  private advanceTimerSec = -1;
  private elapsedSec = 0;

  private readonly onStepComplete?: (step: TutorialStepSpec, allDone: boolean) => void;
  private readonly onTaskComplete?: (taskLabel: string) => void;

  constructor(opts?: {
    onStepComplete?: (step: TutorialStepSpec, allDone: boolean) => void;
    onTaskComplete?: (taskLabel: string) => void;
  }) {
    this.onStepComplete = opts?.onStepComplete;
    this.onTaskComplete = opts?.onTaskComplete;
  }

  public getActiveStep(): TutorialStepSpec {
    return TUTORIAL_STEPS[this.currentStepIndex] ?? TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1];
  }

  public isCourseComplete(): boolean {
    return this.courseComplete;
  }

  public tick(dt: number, active: boolean): boolean {
    if (!active) return false;
    const safeDt = Math.max(0, Math.min(0.1, dt));
    if (!this.courseComplete) {
      this.elapsedSec += safeDt;
    }

    if (this.advanceTimerSec >= 0) {
      this.advanceTimerSec -= safeDt;
      if (this.advanceTimerSec <= 0) {
        this.advanceTimerSec = -1;
        if (this.currentStepIndex + 1 < TUTORIAL_STEPS.length) {
          this.currentStepIndex += 1;
          this.taskCounts.clear();
          this.uniqueSteelTargetsHit.clear();
          return true;
        }
        this.courseComplete = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Records a gameplay mechanic event. Returns true if task or step state changed.
   */
  public recordEvent(event: TutorialEventType, targetId?: string): boolean {
    if (this.courseComplete || this.advanceTimerSec >= 0) return false;
    const step = this.getActiveStep();
    let changed = false;

    for (let i = 0; i < step.tasks.length; i++) {
      const task = step.tasks[i];
      if (task.event !== event) continue;

      const prev = this.taskCounts.get(task.id) ?? 0;
      if (prev >= task.requiredCount) continue;

      if (event === 'steel_hit' && targetId) {
        if (this.uniqueSteelTargetsHit.has(targetId)) {
          continue;
        }
        this.uniqueSteelTargetsHit.add(targetId);
      }

      const next = Math.min(task.requiredCount, prev + 1);
      if (next !== prev) {
        this.taskCounts.set(task.id, next);
        changed = true;
        if (next >= task.requiredCount) {
          this.onTaskComplete?.(task.label);
        }
      }
    }

    if (!changed) return false;

    // Check whether all tasks in the current station are satisfied
    let allDone = true;
    for (let i = 0; i < step.tasks.length; i++) {
      const t = step.tasks[i];
      if ((this.taskCounts.get(t.id) ?? 0) < t.requiredCount) {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      this.completedSteps.add(step.id);
      const isFinalStep = this.currentStepIndex >= TUTORIAL_STEPS.length - 1;
      this.advanceTimerSec = AUTO_ADVANCE_DELAY_SEC;
      this.onStepComplete?.(step, isFinalStep);
    }

    return true;
  }

  public skipStep(): TutorialStepSpec {
    this.advanceTimerSec = -1;
    const cur = this.getActiveStep();
    this.completedSteps.add(cur.id);
    if (this.currentStepIndex + 1 < TUTORIAL_STEPS.length) {
      this.currentStepIndex += 1;
      this.taskCounts.clear();
      this.uniqueSteelTargetsHit.clear();
    } else {
      this.courseComplete = true;
    }
    return this.getActiveStep();
  }

  public jumpToStep(index: number): TutorialStepSpec {
    const clamped = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, Math.floor(index)));
    this.currentStepIndex = clamped;
    this.advanceTimerSec = -1;
    this.courseComplete = false;
    this.taskCounts.clear();
    this.uniqueSteelTargetsHit.clear();
    return this.getActiveStep();
  }

  public restart(): TutorialStepSpec {
    this.currentStepIndex = 0;
    this.taskCounts.clear();
    this.completedSteps.clear();
    this.uniqueSteelTargetsHit.clear();
    this.courseComplete = false;
    this.advanceTimerSec = -1;
    this.elapsedSec = 0;
    return this.getActiveStep();
  }

  public getSnapshot(): TutorialCourseSnapshot {
    const step = this.getActiveStep();
    const tasks: TutorialTaskProgress[] = step.tasks.map((t) => {
      const cur = this.taskCounts.get(t.id) ?? 0;
      return {
        id: t.id,
        label: t.label,
        keyHint: t.keyHint,
        currentCount: cur,
        requiredCount: t.requiredCount,
        done: cur >= t.requiredCount || this.courseComplete,
      };
    });
    return {
      currentStepIndex: this.currentStepIndex,
      totalSteps: TUTORIAL_STEPS.length,
      activeStep: step,
      tasks,
      completedStepIds: Array.from(this.completedSteps),
      courseComplete: this.courseComplete,
      stepJustCompleted: this.advanceTimerSec >= 0,
      elapsedSec: this.elapsedSec,
    };
  }
}

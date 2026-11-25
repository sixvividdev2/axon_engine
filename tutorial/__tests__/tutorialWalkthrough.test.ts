import { describe, expect, it } from 'vitest';
import {
  TUTORIAL_STEPS,
  TutorialCourseStateMachine,
} from '../TutorialCourseLogic';

describe('TutorialCourseStateMachine', () => {
  it('walks through all 8 tactical mechanics stations cleanly to completion', () => {
    const course = new TutorialCourseStateMachine();
    expect(TUTORIAL_STEPS).toHaveLength(8);
    expect(course.getSnapshot().currentStepIndex).toBe(0);
    expect(course.getSnapshot().activeStep.id).toBe('move_stance');
    expect(course.getSnapshot().courseComplete).toBe(false);

    // Bay 01: Movement, Sprint, Crouch, Lean
    course.recordEvent('move');
    course.recordEvent('sprint');
    course.recordEvent('crouch');
    expect(course.getSnapshot().stepJustCompleted).toBe(false);
    course.recordEvent('lean');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);

    // Auto-advances after 0.85s hold (note: tick clamps dt to 0.1s per step)
    for (let i = 0; i < 8; i++) {
      expect(course.tick(0.1, true)).toBe(false);
    }
    expect(course.getSnapshot().currentStepIndex).toBe(0);
    expect(course.tick(0.1, true)).toBe(true);
    expect(course.getSnapshot().currentStepIndex).toBe(1);
    expect(course.getSnapshot().activeStep.id).toBe('vault_mantle');

    const advanceDelay = () => {
      for (let i = 0; i < 10; i++) course.tick(0.1, true);
    };

    // Bay 02: Vault
    course.recordEvent('vault');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('aim_shoot');

    // Bay 03: ADS, Hold Breath, 3 unique steel targets (duplicates ignored)
    course.recordEvent('ads');
    course.recordEvent('hold_breath');
    course.recordEvent('steel_hit', 'Alpha Steel');
    course.recordEvent('steel_hit', 'Alpha Steel');
    expect(course.getSnapshot().tasks[2].currentCount).toBe(1);
    course.recordEvent('steel_hit', 'Bravo Steel');
    course.recordEvent('steel_hit', 'Charlie Steel');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('weapon_handling');

    // Bay 04: Canted/Point-aim, Reload, Suppressor/Inspect, Swap weapon
    course.recordEvent('alt_aim');
    course.recordEvent('reload');
    course.recordEvent('accessory');
    course.recordEvent('weapon_swap');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('breach_cqb');

    // Bay 05: Door interact + Melee/Kick
    course.recordEvent('door_interact');
    course.recordEvent('melee');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('tactical_optics');

    // Bay 06: Flashlight/Laser + NVG
    course.recordEvent('light_or_laser');
    course.recordEvent('nvg_toggle');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('grenade_throw');

    // Bay 07: Grenade Draw, Pull Pin, Throw
    course.recordEvent('grenade_draw');
    course.recordEvent('grenade_pin');
    course.recordEvent('grenade_throw');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();
    expect(course.getSnapshot().activeStep.id).toBe('pda_fire_support');

    // Bay 08: TAC-PDA + Strike/Ping
    course.recordEvent('pda_open');
    course.recordEvent('pda_action');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);
    advanceDelay();

    const finalSnap = course.getSnapshot();
    expect(finalSnap.courseComplete).toBe(true);
    expect(finalSnap.completedStepIds).toHaveLength(8);
  });

  it('supports skipStep, jumpToStep, and clean restart', () => {
    const course = new TutorialCourseStateMachine();
    course.skipStep();
    expect(course.getSnapshot().currentStepIndex).toBe(1);
    expect(course.getSnapshot().completedStepIds).toHaveLength(1);

    course.jumpToStep(5);
    expect(course.getSnapshot().currentStepIndex).toBe(5);
    expect(course.getSnapshot().activeStep.id).toBe('tactical_optics');

    course.recordEvent('light_or_laser');
    course.recordEvent('nvg_toggle');
    expect(course.getSnapshot().stepJustCompleted).toBe(true);

    course.restart();
    const reset = course.getSnapshot();
    expect(reset.currentStepIndex).toBe(0);
    expect(reset.completedStepIds).toHaveLength(0);
    expect(reset.courseComplete).toBe(false);
    expect(reset.stepJustCompleted).toBe(false);
  });
});

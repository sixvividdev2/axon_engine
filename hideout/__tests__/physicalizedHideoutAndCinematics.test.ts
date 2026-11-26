import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OPS_LAPTOP_TABS } from '../HideoutOpsLaptopModal';
import { HIDEOUT_ROOMS, resolveHideoutRoom } from '../HideoutBunkerWorld';
import {
  computeNpcGazeAngles,
  NPC_GAZE_MAX_PITCH_RAD,
  NPC_GAZE_MAX_YAW_RAD,
} from '../BunkerNpcSystem';
import {
  CINEMATIC_SEQUENCES,
  CINEMATIC_SKIP_HOLD_SEC,
  clampVehicleMouseLook,
  HELI_MOUSE_LOOK_MAX_PITCH_RAD,
  HELI_MOUSE_LOOK_MAX_YAW_RAD,
  HELI_MOUSE_LOOK_MIN_PITCH_RAD,
  stepSkipHoldProgress,
} from '../../cinematics/CinematicDirector';
import {
  CINEMATIC_VOICE_MANIFEST,
  CinematicSequenceId,
  getVoiceCuesForSequence,
} from '../../cinematics/cinematicVoiceManifest';
import { cinematicPrefsStore } from '../../cinematics/cinematicPrefsStore';

describe('Physicalized 3D Hideout, Perimeter Wing & Infection Decoupling', () => {
  it('decouples Ops Command Laptop tabs strictly to battle, multiplayer, and gym (no infection or perimeter)', () => {
    expect([...OPS_LAPTOP_TABS]).toEqual(['battle', 'multiplayer', 'gym']);
    expect(OPS_LAPTOP_TABS).not.toContain('infection');
    expect(OPS_LAPTOP_TABS).not.toContain('perimeter');
  });

  it('includes the dedicated Perimeter Ops Wing and renames Sector 4 back to Infection Airlock', () => {
    const roomIds = HIDEOUT_ROOMS.map((r) => r.id);
    expect(roomIds).toContain('perimeter_wing');
    const airlock = HIDEOUT_ROOMS.find((r) => r.id === 'zombies_portal');
    expect(airlock?.label).toBe('Sector 4 · Infection Airlock');
    expect(airlock?.label.toLowerCase()).not.toContain('containment');

    // Verify spatial resolver routes into the North Perimeter Ops Wing
    const wingRoom = resolveHideoutRoom(-11.5, -10.0);
    expect(wingRoom.id).toBe('perimeter_wing');
    expect(wingRoom.label).toBe('Perimeter Ops Wing');
  });

  it('clamps interactive Bunker NPC head/neck gaze tracking to anatomical limits and ignores rear targets', () => {
    const npcPos = { x: 0, y: 0, z: 0 };
    // Facing -Z (yaw = 0); target directly in front slightly above eye level
    const front = computeNpcGazeAngles(npcPos, 0, { x: 0, y: 1.72, z: -3.0 });
    expect(front.inRange).toBe(true);
    expect(Math.abs(front.targetYawRad)).toBeLessThan(0.01);

    // Target far to the left (~85 deg) should be clamped to NPC_GAZE_MAX_YAW_RAD
    const farLeft = computeNpcGazeAngles(npcPos, 0, { x: -3.0, y: 1.62, z: -0.25 });
    expect(farLeft.inRange).toBe(true);
    expect(farLeft.targetYawRad).toBeCloseTo(NPC_GAZE_MAX_YAW_RAD, 4);

    // Target steeply overhead should clamp pitch to NPC_GAZE_MAX_PITCH_RAD
    const overhead = computeNpcGazeAngles(npcPos, 0, { x: 0, y: 5.5, z: -1.5 });
    expect(overhead.inRange).toBe(true);
    expect(overhead.targetPitchRad).toBeCloseTo(NPC_GAZE_MAX_PITCH_RAD, 4);

    // Target directly behind NPC (>115 deg) should be ignored
    const behind = computeNpcGazeAngles(npcPos, 0, { x: 0, y: 1.62, z: 2.5 });
    expect(behind.inRange).toBe(false);

    // Target beyond max gaze range should be ignored
    const tooFar = computeNpcGazeAngles(npcPos, 0, { x: 0, y: 1.62, z: -12.0 });
    expect(tooFar.inRange).toBe(false);
  });
});

describe('AAA Cinematics Suite (Prologue, Gun-Mounted Camera, Mouse-Look & Controls)', () => {
  const ALL_SEQUENCES: CinematicSequenceId[] = [
    'prologue',
    'apc_to_outpost',
    'apc_to_hideout',
    'infection_breach',
    'heli_to_perimeter',
    'heli_to_conquest',
    'heli_to_battle',
  ];

  it('defines all 7 cinematic sequences with gun-mounted camera combat kills and FP mouse-look vehicle seats', () => {
    for (const seqId of ALL_SEQUENCES) {
      const def = CINEMATIC_SEQUENCES[seqId];
      expect(def).toBeDefined();
      expect(def.durationSec).toBeGreaterThan(5);
      expect(def.title.length).toBeGreaterThan(6);
    }

    // Prologue: Aerial Sweep + Gun-Cam Room-Clearing Kill + FP Helicopter Mouse-Look + Intake Briefing
    expect(CINEMATIC_SEQUENCES.prologue.hasGunCamBeat).toBe(true);
    expect(CINEMATIC_SEQUENCES.prologue.hasMouseLookPhase).toBe(true);

    // Combat & Infection deployment cinematics must include gun-mounted camera firefight beats
    expect(CINEMATIC_SEQUENCES.infection_breach.hasGunCamBeat).toBe(true);
    expect(CINEMATIC_SEQUENCES.heli_to_conquest.hasGunCamBeat).toBe(true);
    expect(CINEMATIC_SEQUENCES.heli_to_battle.hasGunCamBeat).toBe(true);

    // Perimeter Ops, Conquest, Battle, and APC transits must include live FP vehicle mouse-look seats
    expect(CINEMATIC_SEQUENCES.heli_to_perimeter.hasMouseLookPhase).toBe(true);
    expect(CINEMATIC_SEQUENCES.apc_to_outpost.hasMouseLookPhase).toBe(true);
    expect(CINEMATIC_SEQUENCES.apc_to_hideout.hasMouseLookPhase).toBe(true);
  });

  it('clamps first-person vehicle mouse-look yaw and pitch cleanly', () => {
    const clampedHigh = clampVehicleMouseLook(THREE.MathUtils.degToRad(140), THREE.MathUtils.degToRad(80));
    expect(clampedHigh.yawRad).toBeCloseTo(HELI_MOUSE_LOOK_MAX_YAW_RAD, 4);
    expect(clampedHigh.pitchRad).toBeCloseTo(HELI_MOUSE_LOOK_MAX_PITCH_RAD, 4);

    const clampedLow = clampVehicleMouseLook(THREE.MathUtils.degToRad(-120), THREE.MathUtils.degToRad(-75));
    expect(clampedLow.yawRad).toBeCloseTo(-HELI_MOUSE_LOOK_MAX_YAW_RAD, 4);
    expect(clampedLow.pitchRad).toBeCloseTo(HELI_MOUSE_LOOK_MIN_PITCH_RAD, 4);
  });

  it('requires holding Enter for 1.2s to trigger skip and decays smoothly when released', () => {
    // Holding for half the threshold should not skip
    const half = stepSkipHoldProgress(0, true, CINEMATIC_SKIP_HOLD_SEC * 0.5);
    expect(half.skipped).toBe(false);
    expect(half.next01).toBeCloseTo(0.5, 3);

    // Releasing decays progress
    const decayed = stepSkipHoldProgress(half.next01, false, 0.15);
    expect(decayed.skipped).toBe(false);
    expect(decayed.next01).toBeLessThan(half.next01);

    // Holding continuously past 1.2s triggers skip
    const full = stepSkipHoldProgress(0, true, CINEMATIC_SKIP_HOLD_SEC + 0.05);
    expect(full.skipped).toBe(true);
    expect(full.next01).toBe(1);
  });

  it('provides static pre-baked WAV manifest paths for all 7 sequences (zero runtime LLM calls)', () => {
    expect(CINEMATIC_VOICE_MANIFEST.length).toBeGreaterThanOrEqual(14);
    for (const seqId of ALL_SEQUENCES) {
      const cues = getVoiceCuesForSequence(seqId);
      expect(cues.length).toBeGreaterThanOrEqual(1);
      for (const cue of cues) {
        expect(cue.audioUrl.startsWith('/audio/cinematics/')).toBe(true);
        expect(cue.audioUrl.endsWith('.wav')).toBe(true);
        expect(cue.text.trim().length).toBeGreaterThan(8);
      }
    }
  });

  it('tracks prologueSeen persistence and replay listener cleanly', () => {
    let replayed = 0;
    const unsub = cinematicPrefsStore.subscribeReplay(() => {
      replayed += 1;
    });
    cinematicPrefsStore.requestReplayPrologue();
    expect(replayed).toBe(1);
    unsub();
  });
});

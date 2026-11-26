import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  computePrologueDisembarkCameraPosition,
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
import { CharacterSkeleton } from '../../bodycam-sdk/CharacterSkeleton';
import {
  computeLowReadyRifleTargets,
  poseSeatedOperator,
  poseStandingNpcGesture,
  SeatedOperatorStyle,
  StandingNpcGesture,
} from '../../bodycam-sdk/character/ProceduralCharacterPoser';
import {
  buildCinematicHelicopter,
  HELI_DEFAULT_CABIN_YAW_RAD,
} from '../../cinematics/CinematicVehiclesAndRigs';
import {
  buildCorridorCombatVfx,
  buildWarzoneBattlefieldVfx,
  computeHelicopterSmokeWakeImpulse,
  HelicopterWakeEmitter,
  WarzoneLightManager,
} from '../../cinematics/CinematicWarzoneVfx';
import { buildWarzoneGroundTargets } from '../../cinematics/CinematicGroundTargets';

// Minimal headless 2D canvas stub so real CharacterSkeleton (fabric textures) can run in Node Vitest
const _origDocument = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
    const noop = () => {};
    const baseCtx: Record<string, unknown> = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      measureText: () => ({ width: 10 }),
    };
    const fakeCtx = new Proxy(baseCtx, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return noop;
      },
      set(target, prop, value) {
        target[prop as string] = value;
        return true;
      },
    });
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 128,
        height: 128,
        getContext: () => fakeCtx,
      }),
    };
  }
});

afterAll(() => {
  if (typeof _origDocument === 'undefined') {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = _origDocument;
  }
});

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

  it('keeps all standing Hideout & Outpost NPC gestures grounded below shoulder height (zero inverted arms)', () => {
    const skel = new CharacterSkeleton();
    const weaponMount = new THREE.Group();
    skel.chest.add(weaponMount);

    const lowReady = computeLowReadyRifleTargets(0, 0);
    expect(lowReady.rightHandRoot[1]).toBeGreaterThan(0.95);
    expect(lowReady.rightHandRoot[1]).toBeLessThan(1.38);
    expect(lowReady.leftHandRoot[1]).toBeGreaterThan(0.95);
    expect(lowReady.leftHandRoot[1]).toBeLessThan(1.38);
    expect(lowReady.rightElbowPoleRoot[1]).toBeLessThan(1.35);
    expect(lowReady.leftElbowPoleRoot[1]).toBeLessThan(1.35);

    const gestures: StandingNpcGesture[] = [
      'tinker',
      'briefing',
      'clipboard',
      'radio_check',
      'rifle_ready',
      'at_ease',
    ];
    const rShoulder = new THREE.Vector3();
    const lShoulder = new THREE.Vector3();
    const rHand = new THREE.Vector3();
    const lHand = new THREE.Vector3();

    for (const gesture of gestures) {
      poseStandingNpcGesture(skel, gesture, 2.5, {
        playerNear: true,
        weaponMount: gesture === 'rifle_ready' || gesture === 'at_ease' ? weaponMount : null,
      });
      skel.rightArm.shoulderPivot.getWorldPosition(rShoulder);
      skel.leftArm.shoulderPivot.getWorldPosition(lShoulder);
      skel.rightArm.hand.root.getWorldPosition(rHand);
      skel.leftArm.hand.root.getWorldPosition(lHand);

      // Hands must NEVER invert overhead above shoulders
      expect(rHand.y).toBeLessThan(rShoulder.y);
      expect(lHand.y).toBeLessThan(lShoulder.y);
      expect(rHand.y).toBeGreaterThan(0.70);
      expect(lHand.y).toBeGreaterThan(0.70);
    }
  });

  it('seats helicopter pilots, door gunners, troop-bay squadmates, and APC drivers cleanly inside vehicle headroom with forward knees', () => {
    const skel = new CharacterSkeleton();
    const weaponMount = new THREE.Group();
    skel.chest.add(weaponMount);

    const styles: SeatedOperatorStyle[] = [
      'heli_pilot',
      'heli_door_gunner',
      'heli_crew',
      'apc_driver',
    ];
    const headPos = new THREE.Vector3();
    const hipPos = new THREE.Vector3();
    const rShoulder = new THREE.Vector3();
    const rHand = new THREE.Vector3();
    const lHand = new THREE.Vector3();
    const rBoot = new THREE.Vector3();

    for (const style of styles) {
      poseSeatedOperator(skel, style, 4.2, {
        seatHeightAboveFloor: style === 'apc_driver' ? 0.42 : 0.44,
        recoilKick01: style === 'heli_door_gunner' ? 0.8 : 0,
        weaponMount: style === 'heli_crew' ? weaponMount : null,
      });
      skel.headGroup.getWorldPosition(headPos);
      skel.rightLeg.hipPivot.getWorldPosition(hipPos);
      skel.rightArm.shoulderPivot.getWorldPosition(rShoulder);
      skel.rightArm.hand.root.getWorldPosition(rHand);
      skel.leftArm.hand.root.getWorldPosition(lHand);
      skel.rightLeg.boot.getWorldPosition(rBoot);

      // Pelvis lowered to seat cushion so head stays well below 1.47m cabin ceiling clearance
      expect(skel.pelvis.position.y).toBeLessThan(0.50);
      expect(headPos.y).toBeLessThan(1.36);
      // Boots planted forward on cabin deck floor
      expect(rBoot.z).toBeLessThan(hipPos.z - 0.25);
      expect(rBoot.y).toBeLessThan(0.18);
      // Hands gripping controls/rifle cleanly below shoulder height
      expect(rHand.y).toBeLessThan(rShoulder.y);
      expect(lHand.y).toBeLessThan(rShoulder.y);
    }
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

  it('defines all 7 expanded cinematic sequences with full pacing, gun-mounted camera breaches, and FP mouse-look seats', () => {
    for (const seqId of ALL_SEQUENCES) {
      const def = CINEMATIC_SEQUENCES[seqId];
      expect(def).toBeDefined();
      expect(def.durationSec).toBeGreaterThanOrEqual(15);
      expect(def.title.length).toBeGreaterThan(6);
    }

    // Verify expanded cinematic runtimes (~48s Prologue, ~24.5-26s transits, ~15.5s Infection Breach)
    expect(CINEMATIC_SEQUENCES.prologue.durationSec).toBeGreaterThanOrEqual(45);
    expect(CINEMATIC_SEQUENCES.apc_to_outpost.durationSec).toBeGreaterThanOrEqual(24);
    expect(CINEMATIC_SEQUENCES.apc_to_hideout.durationSec).toBeGreaterThanOrEqual(24);
    expect(CINEMATIC_SEQUENCES.heli_to_perimeter.durationSec).toBeGreaterThanOrEqual(24);
    expect(CINEMATIC_SEQUENCES.heli_to_conquest.durationSec).toBeGreaterThanOrEqual(25);
    expect(CINEMATIC_SEQUENCES.heli_to_battle.durationSec).toBeGreaterThanOrEqual(25);
    expect(CINEMATIC_SEQUENCES.infection_breach.durationSec).toBeGreaterThanOrEqual(15);

    // Prologue: Aerial Sweep + Squadmate 3-Kill Gun-Cam Breach + FP Helicopter Mouse-Look + Intake Briefing
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

  it('provides static pre-baked WAV manifest paths using valid Gemini 3.8 TTS voices timed inside each sequence', () => {
    const VALID_VOICES = new Set(['Charon', 'Fenrir', 'Kore', 'Puck', 'Zephyr']);
    expect(CINEMATIC_VOICE_MANIFEST.length).toBeGreaterThanOrEqual(20);
    for (const seqId of ALL_SEQUENCES) {
      const def = CINEMATIC_SEQUENCES[seqId];
      const cues = getVoiceCuesForSequence(seqId);
      expect(cues.length).toBeGreaterThanOrEqual(2);
      for (const cue of cues) {
        expect(VALID_VOICES.has(cue.geminiVoice)).toBe(true);
        expect(cue.audioUrl.startsWith('/audio/cinematics/')).toBe(true);
        expect(cue.audioUrl.endsWith('.wav')).toBe(true);
        expect(cue.text.trim().length).toBeGreaterThan(8);
        expect(cue.startSec).toBeGreaterThanOrEqual(0);
        expect(cue.startSec).toBeLessThan(def.durationSec);
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

  it('frames the active door gunner, seated squadmate, and cockpit pilot inside the helicopter default view cone', () => {
    const heli = buildCinematicHelicopter(true);
    heli.updateCrew(2.4, true);
    heli.root.updateMatrixWorld(true);

    const camPos = new THREE.Vector3();
    heli.passengerSeatAnchor.getWorldPosition(camPos);

    // Default forward camera ray at HELI_DEFAULT_CABIN_YAW_RAD (+36 deg forward-left across cabin)
    const camDir = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(-0.05, HELI_DEFAULT_CABIN_YAW_RAD, 0, 'YXZ'),
    );

    const targetPos = new THREE.Vector3();
    for (const member of [heli.doorGunnerSkeleton, heli.crewSkeleton, heli.pilotSkeleton]) {
      member.headGroup.getWorldPosition(targetPos);
      const toMember = targetPos.clone().sub(camPos).normalize();
      const angleDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(camDir.dot(toMember), -1, 1)));
      // All 3 crew members must sit comfortably inside +/-38 deg of neutral camera center!
      expect(angleDeg).toBeLessThan(38);
    }

    heli.dispose();
  });

  it('steps warzone battlefield VFX and corridor firefight tracers/sparks cleanly with artillery triggers', () => {
    const warzone = buildWarzoneBattlefieldVfx(true);
    let blasts = 0;
    for (let t = 0; t <= 12; t += 0.5) {
      warzone.update(t, 0.5, () => {
        blasts += 1;
      });
    }
    expect(blasts).toBeGreaterThanOrEqual(4);
    warzone.dispose();

    const corridorVfx = buildCorridorCombatVfx();
    corridorVfx.spawnTracer(new THREE.Vector3(0, 1.4, -2), new THREE.Vector3(0, 1.4, -10), false);
    corridorVfx.spawnTracer(new THREE.Vector3(0, 1.4, -10), new THREE.Vector3(0, 1.4, -2), true);
    corridorVfx.spawnImpactBurst(new THREE.Vector3(0, 1.3, -10), true);
    corridorVfx.update(0.05);
    corridorVfx.reset();
    corridorVfx.dispose();
  });

  it('manages dynamic warzone blast lights inside a strict zero-shadow pool and displaces smoke clouds via escort helicopter rotor wash', () => {
    const lightMgr = new WarzoneLightManager(3);
    expect(lightMgr.getPoolSize()).toBe(3);
    lightMgr.triggerFlash(new THREE.Vector3(0, 5, -20), 0xff9a3c, 60, 80, 1.0, 10);
    lightMgr.triggerFlash(new THREE.Vector3(10, 6, -30), 0xffd166, 40, 60, 0.5, 8);
    lightMgr.triggerFlash(new THREE.Vector3(-10, 4, -25), 0xff9a3c, 50, 75, 0.8, 9);
    lightMgr.triggerFlash(new THREE.Vector3(5, 8, -15), 0xff8c2b, 80, 95, 1.2, 12);
    const activeCount = lightMgr.update(0.1);
    expect(activeCount).toBeLessThanOrEqual(3);
    expect(activeCount).toBe(3);
    lightMgr.root.traverse((obj) => {
      if ((obj as THREE.Light).isLight) {
        expect((obj as THREE.Light).castShadow).toBe(false);
      }
    });

    // Verify pure rotor-wash impulse is strong directly beneath a moving helicopter
    const impulse = new THREE.Vector3();
    const emitter: HelicopterWakeEmitter = {
      position: new THREE.Vector3(-16, 10, -26),
      velocity: new THREE.Vector3(8, -1, 6),
      rotorRadiusM: 6.2,
      downwashStrength: 1.5,
    };
    const mag = computeHelicopterSmokeWakeImpulse(new THREE.Vector3(-14, 5, -25), emitter, impulse);
    expect(mag).toBeGreaterThan(5);

    // Compare identical warzone VFX runs with vs. without escort helicopter wake emitter
    const baseline = buildWarzoneBattlefieldVfx(true);
    const withWake = buildWarzoneBattlefieldVfx(true);
    let wakeDisplacementTotal = 0;
    for (let step = 0; step < 30; step++) {
      const t = step * 0.05;
      emitter.position.set(-22 + step * 0.9, 9.5, -48 + step * 0.8);
      baseline.update(t, 0.05);
      const telemetry = withWake.update(t, 0.05, { wakeEmitters: [emitter] });
      wakeDisplacementTotal += telemetry.smokeWakeDisplacementSum;
    }
    expect(wakeDisplacementTotal).toBeGreaterThan(2.0);
    const basePos = baseline.getSmokeCloudPositions();
    const wakePos = withWake.getSmokeCloudPositions();
    let maxCloudDelta = 0;
    for (let i = 0; i < basePos.length; i++) {
      maxCloudDelta = Math.max(maxCloudDelta, basePos[i].distanceTo(wakePos[i]));
    }
    expect(maxCloudDelta).toBeGreaterThan(0.5);
    baseline.dispose();
    withWake.dispose();
  });

  it('drives smooth idle-to-firing crew transitions, 3-point cabin illumination, and world-space door-gunner tracking', () => {
    const heli = buildCinematicHelicopter(true);
    let cabinLightCount = 0;
    heli.root.traverse((obj) => {
      if ((obj as THREE.PointLight).isPointLight) {
        expect((obj as THREE.PointLight).castShadow).toBe(false);
        cabinLightCount += 1;
      }
    });
    // 3 cabin lights + 1 door gun flash light = 4 non-shadow PointLights
    expect(cabinLightCount).toBeGreaterThanOrEqual(4);

    // Start in calm idle -> engage should remain low
    for (let i = 0; i < 15; i++) {
      heli.updateCrew(i * 0.05, {
        dt: 0.05,
        combatIntensity01: 0.05,
        gunnerFiring: false,
        squadmateFiring: false,
      });
    }
    const idleState = heli.getCrewEngagementState();
    expect(idleState.gunnerEngage01).toBeLessThan(0.15);
    expect(idleState.squadEngage01).toBeLessThan(0.1);

    // Ramp smoothly into active combat targeting a ground tank off port bow
    const tankWorldPos = new THREE.Vector3(-35, 1.5, -28);
    heli.root.position.set(-20, 14, -36);
    heli.root.updateMatrixWorld(true);
    for (let i = 0; i < 30; i++) {
      heli.updateCrew(1.0 + i * 0.04, {
        dt: 0.04,
        combatIntensity01: 0.95,
        gunnerFiring: true,
        squadmateFiring: true,
        aimTargetWorldPos: tankWorldPos,
      });
    }
    const combatState = heli.getCrewEngagementState();
    expect(combatState.gunnerEngage01).toBeGreaterThan(0.85);
    expect(combatState.squadEngage01).toBeGreaterThan(0.85);

    // Relax back toward calm idle when combat ends
    for (let i = 0; i < 40; i++) {
      heli.updateCrew(3.0 + i * 0.04, {
        dt: 0.04,
        combatIntensity01: 0.05,
        gunnerFiring: false,
        squadmateFiring: false,
      });
    }
    const calmAgain = heli.getCrewEngagementState();
    expect(calmAgain.gunnerEngage01).toBeLessThan(0.2);
    expect(calmAgain.squadEngage01).toBeLessThan(0.2);
    heli.dispose();
  });

  it('engages composite 3D hostile tanks, APCs, and infantry with mixed catastrophic explosions and non-explosive neutralizations', () => {
    const targets = buildWarzoneGroundTargets(true);
    const explodedKinds: string[] = [];
    const neutralizedKinds: string[] = [];
    let sparkBursts = 0;
    let disableSmokePuffs = 0;
    let engagedTargetCount = 0;
    const seenIds = new Set<string>();

    for (let t = 23.5; t <= 31.2; t += 0.05) {
      const active = targets.update(t, 0.05, 'prologue_gunner', {
        onHitSparks: () => {
          sparkBursts += 1;
        },
        onExplode: (_pos, kind) => {
          explodedKinds.push(kind);
        },
        onDisableSmoke: () => {
          disableSmokePuffs += 1;
        },
        onNeutralize: (_pos, kind) => {
          neutralizedKinds.push(kind);
        },
      });
      if (active && !seenIds.has(active.targetId)) {
        seenIds.add(active.targetId);
        engagedTargetCount += 1;
      }
    }

    // Door gunner must engage tanks, APCs, AND hostile infantry with both exploding & non-exploding outcomes!
    expect(engagedTargetCount).toBeGreaterThanOrEqual(4);
    expect(sparkBursts).toBeGreaterThanOrEqual(8);
    expect(disableSmokePuffs).toBeGreaterThanOrEqual(2);
    expect(explodedKinds).toContain('tank');
    expect(explodedKinds).toContain('apc');
    expect(neutralizedKinds).toContain('apc');
    expect(neutralizedKinds).toContain('infantry');

    const summaries = targets.getTargetSummaries().filter((s) =>
      ['infantry_flank_1', 'infantry_flank_2', 'apc_west_column', 'tank_valley_lead', 'apc_ridge_rear'].includes(
        s.id,
      ),
    );
    expect(summaries.some((s) => s.state === 'exploded')).toBe(true);
    expect(summaries.some((s) => s.state === 'neutralized')).toBe(true);
    targets.dispose();
  });

  it('keeps the Act 3 Prologue disembark camera path completely clear of the landed helicopter nose and windshield', () => {
    const camPos = new THREE.Vector3();
    // Landed helicopter at (0, 0.08, 0) rotated PI has its forward nose ending at z <= 3.75m
    const helicopterNoseFrontZ = 3.75;
    for (let u = 0; u <= 1.001; u += 0.1) {
      computePrologueDisembarkCameraPosition(u, 38.0 + u * 6.5, camPos);
      expect(camPos.z).toBeGreaterThan(helicopterNoseFrontZ + 0.9);
      expect(camPos.z).toBeLessThanOrEqual(9.0);
    }
  });
});


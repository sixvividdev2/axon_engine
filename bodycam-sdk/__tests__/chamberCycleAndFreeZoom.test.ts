import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BodycamController,
  BodycamInputState,
  BodycamPhysicsWorld,
  createBodycamTelemetry,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  EjectedLiveRoundPool,
  IBodycamAudioSource,
  resolveWeaponProfile,
  WeaponRig,
} from '../index';
import { FACIAL_MORPH_COUNT, FACIAL_MORPH_INDEX } from '../character/AnatomicalHeadBuilder';
import { FacialExpressionController } from '../character/FacialExpressionController';
import { TacticalOperatorRigFactory, TacticalCombatPose } from '../../combat/TacticalOperatorRig';
import { DEFAULT_KEYBINDS, keybindStore } from '../../data/keybindStore';
import { LobbyRoomState } from '../../data/multiplayer';
import {
  createDefaultMatchState,
  validateAndSanitizeGameMessage,
} from '../../worker/gameRelayGuard';

function installMockCanvas(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const noop = () => {};
  const grad = { addColorStop: noop };
  const makeCtx = () => ({
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    fillRect: noop,
    clearRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    clip: noop,
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop,
  });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 256,
          height: 256,
          getContext: () => makeCtx(),
        };
      }
      return {};
    },
  };
}

function createNoopAudio(): IBodycamAudioSource {
  return {
    updateListener: () => {},
    setInteriorAcoustics: () => {},
    playFootstep: () => {},
    playGearRattle: () => {},
    playHandSlap: () => {},
    playBootScuff: () => {},
    playGlassShatter: () => {},
    playWeaponCue: () => {},
    playBreathCue: () => {},
  };
}

function createFlatTestAdapter() {
  const physics = new BodycamPhysicsWorld();
  physics.boundsMinX = -40;
  physics.boundsMaxX = 40;
  physics.boundsMinZ = -40;
  physics.boundsMaxZ = 40;
  physics.addBox({
    minX: -50,
    maxX: 50,
    minY: -1,
    maxY: 0,
    minZ: -50,
    maxZ: 50,
    surface: 'concrete',
    blocksMovement: true,
    blocksRaycast: true,
  });
  return physics.createAdapter({
    getTraumaModifiers: () => DEFAULT_TRAUMA_MODIFIERS,
  });
}

function makeBaseInput(overrides: Partial<BodycamInputState> = {}): BodycamInputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    leanLeft: false,
    leanRight: false,
    ads: false,
    cant: false,
    adsMode: 'PRIMARY',
    holdBreath: false,
    freeZoom: false,
    vault: false,
    ...overrides,
  };
}

describe('Manual Chamber Cycling & Tactical Free Zoom (Focus)', () => {
  beforeAll(() => {
    installMockCanvas();
  });

  beforeEach(() => {
    keybindStore.setActiveUser(null, null, null);
    keybindStore.resetAllDefaults();
  });

  it('configures default keybinds for Cycle Chamber (Y), Free Zoom (MMB), and Point Aim (Alt)', () => {
    expect(DEFAULT_KEYBINDS.cycle_chamber).toBe('KeyY');
    expect(DEFAULT_KEYBINDS.free_zoom).toBe('Mouse1');
    expect(DEFAULT_KEYBINDS.point_aim).toBe('AltLeft');
    expect(keybindStore.getLabel('cycle_chamber')).toBe('Y');
    expect(keybindStore.getLabel('free_zoom')).toBe('MMB');
    expect(keybindStore.getLabel('point_aim')).toBe('Alt');
    expect(keybindStore.matchesMouseButton(1, 'free_zoom')).toBe(true);
    expect(keybindStore.matchesKeyCode('KeyY', 'cycle_chamber')).toBe(true);
    expect(keybindStore.matchesKeyCode('AltLeft', 'point_aim')).toBe(true);

    // Rebinding cycle_chamber to another key cleanly moves ownership
    const rebind = keybindStore.rebindAction('cycle_chamber', 'KeyU');
    expect(rebind.changed).toBe(true);
    expect(keybindStore.getCode('cycle_chamber')).toBe('KeyU');
    expect(keybindStore.matchesKeyCode('KeyU', 'cycle_chamber')).toBe(true);
    expect(keybindStore.matchesKeyCode('KeyY', 'cycle_chamber')).toBe(false);
  });

  it('animates WeaponRig chamber cycling across weapon platforms, invokes onExtractApex only with a live round, and clears bolt lockback', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.02, 200);
    scene.add(camera);
    const audio = createNoopAudio();
    const adapter = createFlatTestAdapter();
    const rig = new WeaponRig(scene, false, audio);
    const camPos = new THREE.Vector3(0, 1.55, 0);
    const camQuat = new THREE.Quaternion();

    const stepRig = (prof: ReturnType<typeof resolveWeaponProfile>, steps: number, startSec = 0) => {
      for (let i = 0; i < steps; i++) {
        rig.updateRig(
          0.016,
          startSec + i * 0.016,
          prof,
          0,
          0,
          false,
          false,
          false,
          false,
          0,
          0,
          0,
          camPos,
          camQuat,
          adapter,
          DEFAULT_BODYCAM_SDK_CONFIG,
        );
      }
    };

    const platforms = ['m4_556', 'pm_9x19', 'm870_12g', 'mosin_762'] as const;
    for (const weaponId of platforms) {
      const prof = resolveWeaponProfile(weaponId);
      rig.setWeaponProfile(prof);
      rig.setAmmoState(prof.magCapacity);

      // Live round cycle: fires onExtractApex exactly once & exposes synced CHAMBER_CYCLE action
      let extractCalls = 0;
      let completeCalls = 0;
      const started = rig.triggerChamberCycle({
        hasLiveRound: true,
        onExtractApex: (pos, quat) => {
          extractCalls += 1;
          expect(Number.isFinite(pos.x)).toBe(true);
          expect(Number.isFinite(pos.y)).toBe(true);
          expect(Number.isFinite(pos.z)).toBe(true);
          expect(Number.isFinite(quat.w)).toBe(true);
        },
        onComplete: () => {
          completeCalls += 1;
        },
      });
      expect(started).toBe(true);
      expect(rig.isChamberCycling()).toBe(true);
      expect(rig.isBlockingFiringAction()).toBe(true);
      expect(rig.getSyncedHandlingSnapshot().action).toBe('CHAMBER_CYCLE');

      stepRig(prof, 110, 0);

      expect(extractCalls).toBe(1);
      expect(completeCalls).toBe(1);
      expect(rig.isChamberCycling()).toBe(false);
      expect(rig.isBlockingFiringAction()).toBe(false);

      // Dry-rack when chamber is empty: must NOT fire onExtractApex, and finishes cleanly
      rig.setAmmoState(0);
      let dryExtractCalls = 0;
      const dryStarted = rig.triggerChamberCycle({
        hasLiveRound: false,
        onExtractApex: () => {
          dryExtractCalls += 1;
        },
      });
      expect(dryStarted).toBe(true);
      stepRig(prof, 110, 2.0);
      expect(dryExtractCalls).toBe(0);
      expect(rig.isChamberCycling()).toBe(false);
    }

    rig.dispose();
  });

  it('spawns pooled live rounds with gentle manual-extraction velocity, settles them on the floor, and supports pickup recovery', () => {
    const scene = new THREE.Scene();
    const adapter = createFlatTestAdapter();
    const pool = new EjectedLiveRoundPool(scene);

    const id = pool.spawnRound({
      position: new THREE.Vector3(0, 1.35, 0),
      quaternion: new THREE.Quaternion(),
      caliberId: '556x45',
      caliberLabel: '5.56 NATO',
      weaponId: 'm4_556',
      holdClass: 'rifle',
    });

    expect(pool.getActiveCount()).toBe(1);
    const initial = pool.getRoundDebugState(id);
    expect(initial).not.toBeNull();
    expect(initial!.kind).toBe('rifle');
    // Gentler than fired brass (~2.4-3.1 m/s): manual extraction lands cleanly nearby (< 2.0 m/s)
    expect(initial!.velocity.length()).toBeGreaterThan(0.8);
    expect(initial!.velocity.length()).toBeLessThan(2.0);

    // Step physics until the live cartridge bounces and settles flat on y = 0 floor
    for (let i = 0; i < 140; i++) {
      pool.update(0.016, adapter);
    }

    const settled = pool.getRoundDebugState(id);
    expect(settled).not.toBeNull();
    expect(settled!.settled).toBe(true);
    expect(settled!.position.y).toBeGreaterThan(0);
    expect(settled!.position.y).toBeLessThan(0.05);

    // Look directly at the settled live cartridge from eye height and verify pickup detection
    const camPos = new THREE.Vector3(settled!.position.x, 1.55, settled!.position.z + 0.65);
    const camDir = settled!.position.clone().sub(camPos).normalize();
    const candidate = pool.findLookedAtPickup(camPos, camDir);
    expect(candidate).not.toBeNull();
    expect(candidate!.id).toBe(id);
    expect(candidate!.caliberId).toBe('556x45');
    expect(candidate!.caliberLabel).toBe('5.56 NATO');

    // Collect the live round back into ammo reserve
    const collected = pool.collectRound(id);
    expect(collected).not.toBeNull();
    expect(collected!.caliberId).toBe('556x45');
    expect(collected!.weaponId).toBe('m4_556');
    expect(pool.getActiveCount()).toBe(0);
    expect(pool.findLookedAtPickup(camPos, camDir)).toBeNull();

    pool.dispose();
  });

  it('applies smooth ~13% Free Zoom FOV reduction across Hip, Sprint, and stacked ADS stances', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(80, 16 / 9, 0.02, 200);
    scene.add(camera);
    const audio = createNoopAudio();
    const rig = new WeaponRig(scene, false, audio);
    const prof = resolveWeaponProfile('m4_556');
    rig.setWeaponProfile(prof);
    const controller = new BodycamController(camera, rig, audio);
    const adapter = createFlatTestAdapter();
    const cfg = { ...DEFAULT_BODYCAM_SDK_CONFIG, baseFov: 80 };
    const telemetry = createBodycamTelemetry();

    let t = 0;
    const stepMany = (input: BodycamInputState, steps = 90) => {
      for (let i = 0; i < steps; i++) {
        t += 0.016;
        controller.update(0.016, t, input, adapter, prof, cfg, 1.0, 100);
      }
    };

    const getHFovDeg = (): number => {
      const vRad = THREE.MathUtils.degToRad(camera.fov);
      return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(vRad * 0.5) * camera.aspect));
    };

    // 1. Baseline hip FOV
    stepMany(makeBaseInput({ freeZoom: false }));
    const hipBaseHFov = getHFovDeg();
    controller.writeTelemetry(telemetry, 0.5, 1.0, false);
    expect(telemetry.focusBlend).toBeLessThan(0.02);

    // 2. Hip + Free Zoom -> ~13% horizontal FOV reduction (ratio ~0.87)
    stepMany(makeBaseInput({ freeZoom: true }));
    const hipFocusHFov = getHFovDeg();
    controller.writeTelemetry(telemetry, 0.5, 1.0, false);
    expect(telemetry.focusBlend).toBeGreaterThan(0.95);
    const hipRatio = hipFocusHFov / hipBaseHFov;
    expect(hipRatio).toBeGreaterThan(0.85);
    expect(hipRatio).toBeLessThan(0.89);

    // 3. Sprint + Free Zoom -> works seamlessly even while sprinting
    stepMany(makeBaseInput({ forward: true, sprint: true, freeZoom: false }));
    const sprintBaseHFov = getHFovDeg();
    stepMany(makeBaseInput({ forward: true, sprint: true, freeZoom: true }));
    const sprintFocusHFov = getHFovDeg();
    const sprintRatio = sprintFocusHFov / sprintBaseHFov;
    expect(sprintRatio).toBeGreaterThan(0.85);
    expect(sprintRatio).toBeLessThan(0.89);

    // 4. ADS + Free Zoom -> stacks smoothly on top of ADS magnification
    stepMany(makeBaseInput({ ads: true, freeZoom: false }));
    const adsBaseHFov = getHFovDeg();
    expect(adsBaseHFov).toBeLessThan(hipBaseHFov);
    stepMany(makeBaseInput({ ads: true, freeZoom: true }));
    const adsFocusHFov = getHFovDeg();
    const adsRatio = adsFocusHFov / adsBaseHFov;
    expect(adsRatio).toBeGreaterThan(0.85);
    expect(adsRatio).toBeLessThan(0.89);

    // 5. Release returns cleanly to unzoomed ADS FOV
    stepMany(makeBaseInput({ ads: true, freeZoom: false }));
    expect(getHFovDeg()).toBeCloseTo(adsBaseHFov, 0);

    rig.dispose();
  });

  it('animates operator forward head crane and bilateral eye squint when focusing', () => {
    // 1. FacialExpressionController bilateral eye squint on focus01
    const facial = new FacialExpressionController(7);
    const headObj = new THREE.Object3D();
    const eyeL = new THREE.Object3D();
    const eyeR = new THREE.Object3D();
    const morphs = new Array<number>(FACIAL_MORPH_COUNT).fill(0);

    for (let i = 0; i < 60; i++) {
      facial.step(
        0.016,
        {
          mode: 'human',
          intent: 'alert',
          stress01: 0,
          injury01: 0,
          flinchImpulse01: 0,
          focus01: 0,
          distanceToCameraM: 4,
          isVisible: true,
        },
        headObj,
        morphs,
        eyeL,
        eyeR,
      );
    }
    const baseSquintL = morphs[FACIAL_MORPH_INDEX.eye_squint_l];
    const baseSquintR = morphs[FACIAL_MORPH_INDEX.eye_squint_r];

    for (let i = 0; i < 60; i++) {
      facial.step(
        0.016,
        {
          mode: 'human',
          intent: 'alert',
          stress01: 0,
          injury01: 0,
          flinchImpulse01: 0,
          focus01: 1,
          distanceToCameraM: 4,
          isVisible: true,
        },
        headObj,
        morphs,
        eyeL,
        eyeR,
      );
    }
    expect(morphs[FACIAL_MORPH_INDEX.eye_squint_l]).toBeGreaterThan(baseSquintL + 0.3);
    expect(morphs[FACIAL_MORPH_INDEX.eye_squint_r]).toBeGreaterThan(baseSquintR + 0.3);
    expect(morphs[FACIAL_MORPH_INDEX.brow_furrow_down]).toBeGreaterThan(0.2);

    // 2. TacticalOperatorRig 3P forward head crane + CHAMBER_CYCLE handling action
    const factory = new TacticalOperatorRigFactory();
    const rig = factory.buildOperator('remote_player', 'remote_1', 'team_a');
    rig.setWeaponLoadout('m4_556');
    const basePose: TacticalCombatPose = {
      crouchBlend: 0,
      leanBlend: 0,
      aimPitch: 0,
      adsBlend: 0,
      pointAimBlend: 0,
      cantBlend: 0,
      focusBlend: 0,
      reloadBlend: 0,
      speedMps: 0,
      walkCycle: 0,
      sprint: false,
      recoilKick: 0,
      firingVibration: 0,
      flinchPitch: 0,
      handlingAction: 'NONE',
      handlingProgress: 0,
    };

    rig.applyCombatPose(basePose);
    const neutralHeadZ = rig.headGroup.position.z;

    rig.applyCombatPose({ ...basePose, focusBlend: 1.0 });
    const focusedHeadZ = rig.headGroup.position.z;
    // Head cranes visibly forward along local -Z (~2.9 cm)
    expect(focusedHeadZ).toBeLessThan(neutralHeadZ - 0.02);

    // 3P CHAMBER_CYCLE pose evaluates cleanly with finite transforms
    rig.applyCombatPose({
      ...basePose,
      handlingAction: 'CHAMBER_CYCLE',
      handlingProgress: 0.48,
    });
    expect(Number.isFinite(rig.weaponSocket.position.x)).toBe(true);
    expect(Number.isFinite(rig.weaponSocket.rotation.z)).toBe(true);
    expect(Number.isFinite(rig.headGroup.position.z)).toBe(true);

    factory.dispose();
  });

  it('sanitizes multiplayer game:state focus and preserves CHAMBER_CYCLE handling action in gameRelayGuard', () => {
    const roomState: LobbyRoomState = {
      code: 'TST001',
      hostUserId: 'u_host',
      hostUsername: 'Alpha1',
      visibility: 'private',
      mode: 'battle',
      battleRule: 'tdm',
      mapId: 'stalingrad_depot',
      maxPlayers: 8,
      botsEnabled: false,
      botCount: 0,
      killLimit: 50,
      botDifficulty: 'tactical',
      status: 'in_match',
      matchSequence: 1,
      specialEvent: null,
      members: [
        {
          userId: 'u_host',
          username: 'Alpha1',
          team: 'A',
          rank: 1,
          prestige: 0,
          connected: true,
          ready: true,
          isHost: true,
          joinedAt: Date.now(),
        },
      ],
      chat: [],
      updatedAt: Date.now(),
    };
    const matchState = createDefaultMatchState();

    const res = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 1.25,
        y: 0,
        z: -4.5,
        yaw: 0.5,
        pitch: 0.1,
        focus: 1.75,
        ha: 'CHAMBER_CYCLE',
        hprog: 0.52,
      },
      roomState,
      matchState,
      { userId: 'u_host', username: 'Alpha1' },
    );

    expect(res).not.toBeNull();
    expect(res!.payload.focus).toBe(1);
    expect(res!.payload.ha).toBe('CHAMBER_CYCLE');
    expect(res!.payload.hprog).toBeCloseTo(0.52, 2);

    const resNeg = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        focus: -0.4,
      },
      roomState,
      matchState,
      { userId: 'u_host', username: 'Alpha1' },
    );
    expect(resNeg).not.toBeNull();
    expect(resNeg!.payload.focus).toBe(0);
  });
});

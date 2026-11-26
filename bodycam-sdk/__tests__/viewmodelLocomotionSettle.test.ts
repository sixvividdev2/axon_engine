import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BodycamController,
  BodycamInputState,
  BodycamPhysicsWorld,
  CharacterAnimator,
  CharacterSkeleton,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DEFAULT_TRAUMA_MODIFIERS,
  IBodycamAudioSource,
  resolveWeaponProfile,
  WeaponRig,
} from '../index';
import { CharacterAnimator as EngineCharacterAnimator } from '../../engine/character/CharacterAnimator';
import { CharacterSkeleton as EngineCharacterSkeleton } from '../../engine/character/CharacterSkeleton';
import { CharacterDriverState } from '../../engine/character/ControllerStateReader';
import { WeaponRig as EngineWeaponRig } from '../../engine/weapons/WeaponRig';
import { WEAPONS } from '../../data/weapons';

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
  physics.boundsMinX = -80;
  physics.boundsMaxX = 80;
  physics.boundsMinZ = -80;
  physics.boundsMaxZ = 80;
  physics.addBox({
    minX: -90,
    maxX: 90,
    minY: -1,
    maxY: 0,
    minZ: -90,
    maxZ: 90,
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

interface RigFrameSample {
  isMoving: boolean;
  isSprinting: boolean;
  bobPhase: number;
  strideProgress: number;
  weaponPos: THREE.Vector3;
  weaponQuat: THREE.Quaternion;
  pelvisPos: THREE.Vector3;
  spinePitch: number;
  rightHandLocal: THREE.Vector3;
  leftHandLocal: THREE.Vector3;
  leftBootLocal: THREE.Vector3;
  rightBootLocal: THREE.Vector3;
}

function sampleRigFrame(
  controller: BodycamController,
  weaponRig: WeaponRig,
  skeleton: CharacterSkeleton,
): RigFrameSample {
  skeleton.root.updateMatrixWorld(true);
  weaponRig.root.updateMatrixWorld(true);

  const rigState = weaponRig.getReadOnlyRigState();
  const rootInv = new THREE.Matrix4().copy(skeleton.root.matrixWorld).invert();
  const toRootLocal = (obj: THREE.Object3D): THREE.Vector3 => {
    const world = new THREE.Vector3();
    obj.getWorldPosition(world);
    return world.applyMatrix4(rootInv);
  };

  return {
    isMoving: rigState.isMoving,
    isSprinting: controller.isSprinting,
    bobPhase: rigState.bobPhase,
    strideProgress: rigState.strideProgress,
    weaponPos: weaponRig.weaponPivot.position.clone(),
    weaponQuat: weaponRig.weaponPivot.quaternion.clone(),
    pelvisPos: skeleton.pelvis.position.clone(),
    spinePitch: skeleton.spineLower.rotation.x,
    rightHandLocal: toRootLocal(skeleton.rightArm.hand.root),
    leftHandLocal: toRootLocal(skeleton.leftArm.hand.root),
    leftBootLocal: toRootLocal(skeleton.leftLeg.boot),
    rightBootLocal: toRootLocal(skeleton.rightLeg.boot),
  };
}

interface TransitionDeltas {
  maxWeaponPosDelta: number;
  maxWeaponAngleDelta: number;
  maxPelvisPosDelta: number;
  maxSpinePitchDelta: number;
  maxRightHandDelta: number;
  maxLeftHandDelta: number;
  maxLeftBootDelta: number;
  maxRightBootDelta: number;
}

function measureMaxFrameDeltas(samples: RigFrameSample[], startIdx: number, endIdx: number): TransitionDeltas {
  const out: TransitionDeltas = {
    maxWeaponPosDelta: 0,
    maxWeaponAngleDelta: 0,
    maxPelvisPosDelta: 0,
    maxSpinePitchDelta: 0,
    maxRightHandDelta: 0,
    maxLeftHandDelta: 0,
    maxLeftBootDelta: 0,
    maxRightBootDelta: 0,
  };
  for (let i = Math.max(1, startIdx); i <= Math.min(samples.length - 1, endIdx); i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    out.maxWeaponPosDelta = Math.max(out.maxWeaponPosDelta, prev.weaponPos.distanceTo(curr.weaponPos));
    out.maxWeaponAngleDelta = Math.max(out.maxWeaponAngleDelta, prev.weaponQuat.angleTo(curr.weaponQuat));
    out.maxPelvisPosDelta = Math.max(out.maxPelvisPosDelta, prev.pelvisPos.distanceTo(curr.pelvisPos));
    out.maxSpinePitchDelta = Math.max(out.maxSpinePitchDelta, Math.abs(curr.spinePitch - prev.spinePitch));
    out.maxRightHandDelta = Math.max(out.maxRightHandDelta, prev.rightHandLocal.distanceTo(curr.rightHandLocal));
    out.maxLeftHandDelta = Math.max(out.maxLeftHandDelta, prev.leftHandLocal.distanceTo(curr.leftHandLocal));
    out.maxLeftBootDelta = Math.max(out.maxLeftBootDelta, prev.leftBootLocal.distanceTo(curr.leftBootLocal));
    out.maxRightBootDelta = Math.max(out.maxRightBootDelta, prev.rightBootLocal.distanceTo(curr.rightBootLocal));
  }
  return out;
}

describe('Viewmodel Locomotion Stop & Rest Settle Continuity', () => {
  beforeAll(() => {
    installMockCanvas();
  });

  function runSdkMoveThenStopScenario(options: {
    weaponId: string;
    sprint: boolean;
    ads?: boolean;
    moveFrames: number;
    idleFrames?: number;
  }) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.02, 200);
    scene.add(camera);
    const audio = createNoopAudio();
    const adapter = createFlatTestAdapter();
    const weaponRig = new WeaponRig(scene, false, audio);
    const prof = resolveWeaponProfile(options.weaponId);
    weaponRig.setWeaponProfile(prof, false);
    weaponRig.setAmmoState(prof.magCapacity);

    const controller = new BodycamController(camera, weaponRig, audio);
    controller.snapTo(0, 0, 0, 0, 0);

    const skeleton = new CharacterSkeleton(1, 'team_a', 'MALE');
    scene.add(skeleton.root);
    const animator = new CharacterAnimator(skeleton, weaponRig, audio);

    const dt = 1 / 60;
    let elapsed = 0;
    const samples: RigFrameSample[] = [];

    const stepFrame = (input: BodycamInputState) => {
      elapsed += dt;
      controller.update(dt, elapsed, input, adapter, prof, DEFAULT_BODYCAM_SDK_CONFIG);
      animator.update(dt, elapsed, controller, adapter, prof, input.ads);
      samples.push(sampleRigFrame(controller, weaponRig, skeleton));
    };

    // Warm up at idle first so weapon equip / initial IK blend has fully settled
    const baseIdle = makeBaseInput({ ads: !!options.ads });
    for (let i = 0; i < 45; i++) {
      stepFrame(baseIdle);
    }

    // Move forward (walk or sprint) until mid-stride
    const moveStartIdx = samples.length;
    const moveInput = makeBaseInput({
      forward: true,
      sprint: options.sprint,
      ads: !!options.ads,
    });
    for (let i = 0; i < options.moveFrames; i++) {
      stepFrame(moveInput);
    }

    // Stop moving and let viewmodel smoothly damp into rest
    const stopIdx = samples.length;
    const idleFrames = options.idleFrames ?? 75;
    for (let i = 0; i < idleFrames; i++) {
      stepFrame(baseIdle);
    }

    weaponRig.dispose();
    skeleton.dispose();

    return { samples, moveStartIdx, stopIdx };
  }

  it('keeps bobPhase and strideProgress continuous without teleporting to 0.72 when stopping walk or sprint', () => {
    for (const sprint of [false, true]) {
      const { samples, stopIdx } = runSdkMoveThenStopScenario({
        weaponId: 'm4_556',
        sprint,
        moveFrames: 42, // lands mid-stride away from 0.72
        idleFrames: 30,
      });

      // Find the exact frame where isMoving flips from true to false
      let flipIdx = -1;
      for (let i = stopIdx; i < samples.length; i++) {
        if (samples[i - 1].isMoving && !samples[i].isMoving) {
          flipIdx = i;
          break;
        }
      }
      expect(flipIdx).toBeGreaterThan(stopIdx - 1);

      const beforeFlip = samples[flipIdx - 1];
      const onFlip = samples[flipIdx];
      const afterFlip = samples[flipIdx + 1];

      // bobPhase must stay monotonic/continuous (no jump back or reset)
      expect(Math.abs(onFlip.bobPhase - beforeFlip.bobPhase)).toBeLessThan(0.25);
      expect(Math.abs(afterFlip.bobPhase - onFlip.bobPhase)).toBeLessThan(0.05);

      // strideProgress must NOT snap to 0.72 on the stop frame
      const rawStrideJump = Math.abs(onFlip.strideProgress - beforeFlip.strideProgress);
      const wrappedStrideJump = Math.min(rawStrideJump, 1 - rawStrideJump);
      expect(wrappedStrideJump).toBeLessThan(0.12);
    }
  });

  it('smoothly damps weapon, arms, pelvis, spine, and boots into rest after armed walk and sprint stops (hip-fire and ADS)', () => {
    const scenarios = [
      { name: 'rifle walk hip-fire', weaponId: 'm4_556', sprint: false, ads: false, moveFrames: 38 },
      { name: 'rifle sprint hip-fire', weaponId: 'm4_556', sprint: true, ads: false, moveFrames: 44 },
      { name: 'rifle walk ADS', weaponId: 'm4_556', sprint: false, ads: true, moveFrames: 40 },
    ];

    for (const sc of scenarios) {
      const { samples, stopIdx } = runSdkMoveThenStopScenario({
        weaponId: sc.weaponId,
        sprint: sc.sprint,
        ads: sc.ads,
        moveFrames: sc.moveFrames,
        idleFrames: 80,
      });

      // Find the exact frame where isMoving transitions from true -> false (where the old flicker fired)
      let flipIdx = -1;
      for (let i = stopIdx; i < samples.length; i++) {
        if (samples[i - 1].isMoving && !samples[i].isMoving) {
          flipIdx = i;
          break;
        }
      }
      expect(flipIdx, `${sc.name} should transition to idle`).toBeGreaterThan(stopIdx - 1);

      // Measure steady-state moving motion, deceleration window, exact isMoving flip frame, and settled tail
      const steadyMove = measureMaxFrameDeltas(samples, stopIdx - 12, stopIdx - 1);
      const stopWindow = measureMaxFrameDeltas(samples, stopIdx, Math.min(samples.length - 1, flipIdx + 12));
      const flipWindow = measureMaxFrameDeltas(samples, flipIdx, flipIdx + 2);
      const settledTail = measureMaxFrameDeltas(samples, samples.length - 12, samples.length - 1);

      // Zero single-frame flicker/snap during deceleration (never spikes above smooth locomotion motion)
      expect(stopWindow.maxWeaponPosDelta, `${sc.name} weaponPos`).toBeLessThan(0.018);
      expect(stopWindow.maxWeaponAngleDelta, `${sc.name} weaponAngle`).toBeLessThan(0.075);
      expect(stopWindow.maxPelvisPosDelta, `${sc.name} pelvisPos`).toBeLessThan(0.008);
      expect(stopWindow.maxSpinePitchDelta, `${sc.name} spinePitch`).toBeLessThan(0.025);
      expect(stopWindow.maxRightHandDelta, `${sc.name} rightHand`).toBeLessThan(0.025);
      expect(stopWindow.maxLeftHandDelta, `${sc.name} leftHand`).toBeLessThan(0.025);
      expect(stopWindow.maxLeftBootDelta, `${sc.name} leftBoot`).toBeLessThan(
        Math.max(0.045, steadyMove.maxLeftBootDelta * 1.15),
      );
      expect(stopWindow.maxRightBootDelta, `${sc.name} rightBoot`).toBeLessThan(
        Math.max(0.045, steadyMove.maxRightBootDelta * 1.15),
      );

      // Exact isMoving: true -> false boundary must have zero snap/flicker across full viewmodel
      expect(flipWindow.maxWeaponPosDelta, `${sc.name} flip weaponPos`).toBeLessThan(0.005);
      expect(flipWindow.maxWeaponAngleDelta, `${sc.name} flip weaponAngle`).toBeLessThan(0.018);
      expect(flipWindow.maxPelvisPosDelta, `${sc.name} flip pelvisPos`).toBeLessThan(0.003);
      expect(flipWindow.maxLeftHandDelta, `${sc.name} flip leftHand`).toBeLessThan(0.010);
      expect(flipWindow.maxRightHandDelta, `${sc.name} flip rightHand`).toBeLessThan(0.010);
      expect(flipWindow.maxLeftBootDelta, `${sc.name} flip leftBoot`).toBeLessThan(0.018);
      expect(flipWindow.maxRightBootDelta, `${sc.name} flip rightBoot`).toBeLessThan(0.018);

      // Rig must converge cleanly to a calm resting idle state after ~1.3s
      expect(settledTail.maxWeaponPosDelta, `${sc.name} settled weaponPos`).toBeLessThan(0.0025);
      expect(settledTail.maxPelvisPosDelta, `${sc.name} settled pelvisPos`).toBeLessThan(0.0015);
      expect(settledTail.maxLeftBootDelta, `${sc.name} settled leftBoot`).toBeLessThan(0.003);
      expect(settledTail.maxRightBootDelta, `${sc.name} settled rightBoot`).toBeLessThan(0.003);
    }
  });

  it('smoothly settles full unarmed viewmodel (pelvis, spine, arms, and legs) after sprinting into idle', () => {
    const { samples, stopIdx } = runSdkMoveThenStopScenario({
      weaponId: 'unarmed',
      sprint: true,
      ads: false,
      moveFrames: 42,
      idleFrames: 85,
    });

    let flipIdx = -1;
    for (let i = stopIdx; i < samples.length; i++) {
      if (samples[i - 1].isMoving && !samples[i].isMoving) {
        flipIdx = i;
        break;
      }
    }
    expect(flipIdx).toBeGreaterThan(stopIdx - 1);

    const steadyMove = measureMaxFrameDeltas(samples, stopIdx - 12, stopIdx - 1);
    const stopWindow = measureMaxFrameDeltas(samples, stopIdx, Math.min(samples.length - 1, flipIdx + 12));
    const flipWindow = measureMaxFrameDeltas(samples, flipIdx, flipIdx + 2);
    const settledTail = measureMaxFrameDeltas(samples, samples.length - 12, samples.length - 1);

    expect(stopWindow.maxPelvisPosDelta).toBeLessThan(0.008);
    expect(stopWindow.maxSpinePitchDelta).toBeLessThan(0.025);
    expect(stopWindow.maxRightHandDelta).toBeLessThan(0.060);
    expect(stopWindow.maxLeftHandDelta).toBeLessThan(0.060);
    expect(stopWindow.maxLeftBootDelta).toBeLessThan(Math.max(0.045, steadyMove.maxLeftBootDelta * 1.15));
    expect(stopWindow.maxRightBootDelta).toBeLessThan(Math.max(0.045, steadyMove.maxRightBootDelta * 1.15));

    // Exact isMoving: true -> false boundary must have zero snap/flicker across unarmed arms & legs
    expect(flipWindow.maxPelvisPosDelta).toBeLessThan(0.003);
    expect(flipWindow.maxRightHandDelta).toBeLessThan(0.012);
    expect(flipWindow.maxLeftHandDelta).toBeLessThan(0.012);
    expect(flipWindow.maxLeftBootDelta).toBeLessThan(0.018);
    expect(flipWindow.maxRightBootDelta).toBeLessThan(0.018);

    expect(settledTail.maxPelvisPosDelta).toBeLessThan(0.0015);
    expect(settledTail.maxRightHandDelta).toBeLessThan(0.003);
    expect(settledTail.maxLeftHandDelta).toBeLessThan(0.003);
    expect(settledTail.maxLeftBootDelta).toBeLessThan(0.003);
    expect(settledTail.maxRightBootDelta).toBeLessThan(0.003);
  });

  it('preserves strafe travel axis during deceleration in Survival Engine CharacterAnimator without boot axis snap', () => {
    const scene = new THREE.Scene();
    const audio = createNoopAudio();
    const weaponRig = new EngineWeaponRig(scene, false, audio);
    const spec = WEAPONS.unarmed;
    weaponRig.setWeapon('unarmed', false);

    const skeleton = new EngineCharacterSkeleton(1);
    scene.add(skeleton.root);
    const animator = new EngineCharacterAnimator(skeleton, weaponRig, audio);

    const state: CharacterDriverState = {
      position: new THREE.Vector3(0, 0, 0),
      torsoYaw: 0,
      torsoPitch: 0,
      spinePitch: 0,
      aimYaw: 0,
      aimPitch: 0,
      lean: 0,
      crouch: false,
      sprint: false,
      isAds: false,
      isCanted: false,
      isPointAim: false,
      isMoving: false,
      grounded: true,
      velY: 0,
      stepSmoothOffsetY: 0,
      landingKneeBend: 0,
      landingCompression: 0,
      stridePhase: 0,
      bobPhase: 0,
      wallPullback: 0,
      recoilSpring: { z: 0, pitch: 0, roll: 0 },
      chestHeight: 1.42,
      cameraWorldPos: new THREE.Vector3(0, 1.55, 0),
      cameraWorldQuat: new THREE.Quaternion(),
      vaultState: {
        active: false,
        kind: 'VAULT_OVER',
        mode: 'NONE',
        progress: 0,
        handPinWeightL: 0,
        handPinWeightR: 0,
        handLWorld: new THREE.Vector3(),
        handRWorld: new THREE.Vector3(),
        wallNormal: new THREE.Vector3(0, 0, 1),
        vaultForward: new THREE.Vector3(0, 0, -1),
        weaponRetentionMode: 'NONE',
        weaponRetentionBlend: 0,
        cameraPitchOffset: 0,
        cameraRollOffset: 0,
        cameraDipOffset: 0,
        crouchTransitionWeight: 0,
        legTuckWeight: 0,
        headDuckWeight: 0,
        maxCameraWorldY: Infinity,
        spinYawOffset: 0,
        spinRollOffset: 0,
      },
    };

    const dt = 1 / 60;
    let elapsed = 0;
    let bobPhase = 0;
    const bootLocalHistory: Array<{ left: THREE.Vector3; right: THREE.Vector3; pelvis: THREE.Vector3 }> = [];

    const step = (strafeSpeedX: number, moving: boolean) => {
      elapsed += dt;
      state.position.x += strafeSpeedX * dt;
      state.cameraWorldPos.set(state.position.x, 1.55, state.position.z);
      state.isMoving = moving;
      if (moving) {
        bobPhase += dt * 7.6;
        state.bobPhase = bobPhase;
        state.stridePhase = (bobPhase % Math.PI) / Math.PI;
      }
      animator.update(dt, elapsed, state, spec, () => 0);
      skeleton.root.updateMatrixWorld(true);
      const rootInv = new THREE.Matrix4().copy(skeleton.root.matrixWorld).invert();
      const lBoot = new THREE.Vector3();
      const rBoot = new THREE.Vector3();
      skeleton.leftLeg.boot.getWorldPosition(lBoot);
      skeleton.rightLeg.boot.getWorldPosition(rBoot);
      bootLocalHistory.push({
        left: lBoot.applyMatrix4(rootInv),
        right: rBoot.applyMatrix4(rootInv),
        pelvis: skeleton.pelvis.position.clone(),
      });
    };

    // Strafe purely sideways (+X) for 35 frames, then stop instantaneously to 0 velocity
    for (let i = 0; i < 35; i++) {
      step(2.6, true);
    }
    const stopIdx = bootLocalHistory.length;
    for (let i = 0; i < 40; i++) {
      step(0, false);
    }

    // Check that the exact stop frame and settle frames have no sudden lateral-to-forward boot teleport
    let maxLeftBootJump = 0;
    let maxRightBootJump = 0;
    let maxPelvisJump = 0;
    for (let i = stopIdx; i < stopIdx + 15; i++) {
      maxLeftBootJump = Math.max(maxLeftBootJump, bootLocalHistory[i - 1].left.distanceTo(bootLocalHistory[i].left));
      maxRightBootJump = Math.max(maxRightBootJump, bootLocalHistory[i - 1].right.distanceTo(bootLocalHistory[i].right));
      maxPelvisJump = Math.max(maxPelvisJump, bootLocalHistory[i - 1].pelvis.distanceTo(bootLocalHistory[i].pelvis));
    }

    expect(maxLeftBootJump).toBeLessThan(0.04);
    expect(maxRightBootJump).toBeLessThan(0.04);
    expect(maxPelvisJump).toBeLessThan(0.008);

    weaponRig.dispose();
    skeleton.dispose();
  });
});

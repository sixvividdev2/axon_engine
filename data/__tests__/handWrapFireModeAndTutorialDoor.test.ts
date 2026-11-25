import * as THREE from 'three';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BodycamPhysicsWorld,
  CharacterSkeleton,
  resolveWeaponProfile,
} from '../../bodycam-sdk';
import { WeaponAssembler } from '../../bodycam-sdk/weapons/WeaponAssembler';
import { WeaponModelFactory } from '../../bodycam-sdk/weapons/WeaponModelFactory';
import { DestructibleDoorSystem } from '../../doors/DestructibleDoorSystem';
import { HoldRepairController } from '../../doors/HoldRepairController';
import { PlayerInteractAnimator } from '../../doors/PlayerInteractAnimator';
import { createBareAttachments, normalizeWeaponAttachments } from '../attachments';
import {
  canonicalizeFireModeWeaponId,
  fireModeStore,
  formatFireModeLabel,
  getEffectiveFireRpm,
  isSingleShotFireMode,
  shouldCyclePumpOnShot,
} from '../fireModeControl';

function installHeadlessCanvasStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const noop = () => {};
  const fakeGrad = { addColorStop: noop };
  const fakeCtx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    fillRect: noop,
    clearRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    ellipse: noop,
    rect: noop,
    roundRect: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 20 }),
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setLineDash: noop,
    drawImage: noop,
    createLinearGradient: () => fakeGrad,
    createRadialGradient: () => fakeGrad,
    createPattern: () => null,
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    putImageData: noop,
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 256,
          height: 256,
          style: {},
          getContext: () => fakeCtx,
        };
      }
      return { style: {} };
    },
  };
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
}

describe('Pillar 1 — Anatomical Left-Hand Finger Wrap & Foregrip Alignment', () => {
  beforeAll(() => {
    installHeadlessCanvasStub();
  });

  function evaluateLeftHandOnWeapon(
    weaponId: string,
    foregripId: string | null,
    foregripStyle: 'none' | 'vertical' | 'angled',
    curl: number,
  ) {
    const prof = resolveWeaponProfile(weaponId);
    const asm = WeaponModelFactory.build(prof);
    const att = normalizeWeaponAttachments(weaponId, {
      ...createBareAttachments(),
      foregrip: foregripId,
    });
    WeaponAssembler.applyAttachments(
      asm,
      prof.massKg,
      prof.barrelLengthM,
      prof.magCapacity,
      att,
    );
    asm.group.updateMatrixWorld(true);

    const skel = new CharacterSkeleton();
    skel.applyHandPose('left', prof.holdClass, false, curl, foregripStyle, {
      profile: asm.handPoseProfile,
    });

    // Place wrist directly at leftHandSocket in weapon space (identical to CharacterAnimator IK)
    const hand = skel.leftArm.hand;
    const wrist = hand.root;
    skel.root.updateMatrixWorld(true);

    const invWristWorld = new THREE.Matrix4().copy(wrist.matrixWorld).invert();
    const socketPos = new THREE.Vector3();
    const socketQuat = new THREE.Quaternion();
    asm.leftHandSocket.getWorldPosition(socketPos);
    asm.leftHandSocket.getWorldQuaternion(socketQuat);
    const socketMat = new THREE.Matrix4().compose(
      socketPos,
      socketQuat,
      new THREE.Vector3(1, 1, 1),
    );
    const toGun = new THREE.Matrix4().multiplyMatrices(socketMat, invWristWorld);

    const samplePoint = (node: THREE.Object3D, localOffset?: THREE.Vector3): THREE.Vector3 => {
      const p = localOffset ? localOffset.clone() : new THREE.Vector3();
      return p.applyMatrix4(node.matrixWorld).applyMatrix4(toGun);
    };

    const thumbPts = [
      samplePoint(hand.thumbProx),
      samplePoint(hand.thumbDist),
      samplePoint(hand.thumbDist, new THREE.Vector3(0, 0, -0.020)),
      samplePoint(hand.thumbDist, new THREE.Vector3(0, 0, -0.028)),
    ];
    const sampleFinger = (f: typeof hand.index) => [
      samplePoint(f.proximal),
      samplePoint(f.middle),
      samplePoint(f.distal),
      samplePoint(f.distal, new THREE.Vector3(0, 0, -0.017)),
    ];
    const fingerJoints = [
      thumbPts,
      sampleFinger(hand.index),
      sampleFinger(hand.middle),
      sampleFinger(hand.ring),
      sampleFinger(hand.pinky),
    ];

    const mountPos = new THREE.Vector3();
    asm.foregripMountSocket.getWorldPosition(mountPos);

    asm.dispose();
    skel.dispose();

    return { asm, socketPos, mountPos, fingerJoints };
  }

  it('C-clamps bare M4A1 handguard with curled fingers wrapping right/top-right and thumb high on left', () => {
    const { fingerJoints, mountPos } = evaluateLeftHandOnWeapon(
      'm4_556',
      null,
      'none',
      0.88,
    );
    const [thumb, index, middle, ring, pinky] = fingerJoints;
    // All 4 fingers wrap up around the right side (+X) and curl inward toward top-right (tips move inward vs PIP)
    for (const f of [index, middle, ring, pinky]) {
      const mcp = f[0];
      const pip = f[1];
      const tip = f[3];
      expect(pip.x).toBeGreaterThan(0.015);
      // Finger curls back inward across the upper-right edge instead of sticking straight up
      expect(tip.x).toBeLessThan(pip.x);
      // Fingers wrap upward well above the bottom rail (mountPos.y)
      expect(tip.y).toBeGreaterThan(mountPos.y + 0.015);
      // Fingers never clip vertically down into the rail centerline
      expect(mcp.y).toBeLessThan(mountPos.y + 0.015);
    }
    // Thumb rides high along the left/top-left side of the handguard
    expect(thumb[3].x).toBeLessThan(0.005);
    expect(thumb[3].y).toBeGreaterThan(mountPos.y + 0.01);
  });

  it('parents Remington 870 leftHandSocket to pumpForend and cradles underneath cleanly', () => {
    const prof = resolveWeaponProfile('remington_870');
    const asm = WeaponModelFactory.build(prof);
    expect(asm.pumpForend).not.toBeNull();
    expect(asm.leftHandSocket.parent).toBe(asm.pumpForend);
    asm.dispose();

    const { fingerJoints, mountPos } = evaluateLeftHandOnWeapon(
      'remington_870',
      null,
      'none',
      0.85,
    );
    const [thumb, index, middle, ring, pinky] = fingerJoints;
    // Cradle: palm/MCP underneath the pump, fingers curve up right flank, thumb rests left flank
    for (const f of [index, middle, ring, pinky]) {
      expect(f[0].y).toBeLessThan(mountPos.y + 0.01);
      expect(f[1].x).toBeGreaterThan(0.012);
    }
    expect(thumb[3].x).toBeLessThan(-0.005);
  });

  it('locks vertical foregrip fist wrap onto foregripMountSocket shaft without piercing grip axis', () => {
    const { fingerJoints, mountPos, socketPos } = evaluateLeftHandOnWeapon(
      'm4_556',
      'grip_vertical_rk',
      'vertical',
      1.0,
    );
    // Wrist socket sits ~5cm aft of shaft so palm & curled fingers wrap directly around the vertical grip
    expect(socketPos.y).toBeLessThan(mountPos.y - 0.02);
    expect(Math.abs(socketPos.z - mountPos.z)).toBeLessThan(0.06);

    // Index through pinky wrap horizontally around the vertical grip cylinder:
    // palm on left-rear -> MCP left-front -> PIP front -> DIP right flank (+Z) -> TIP curls inward (-X, +Z)
    const [, index, middle, ring, pinky] = fingerJoints;
    for (const f of [index, middle, ring, pinky]) {
      const pip = f[1];
      const dip = f[2];
      const tip = f[3];
      // Vertical grip shaft centerline is at (0, y, mountPos.z) with radius 0.0155m
      const pipRad = Math.hypot(pip.x, pip.z - mountPos.z);
      const dipRad = Math.hypot(dip.x, dip.z - mountPos.z);
      const tipRad = Math.hypot(tip.x, tip.z - mountPos.z);
      expect(pipRad).toBeGreaterThan(0.014);
      expect(dipRad).toBeGreaterThan(0.014);
      expect(tipRad).toBeGreaterThan(0.008);
      // Finger wraps backward (+Z) from PIP to DIP around the right flank of the cylinder
      expect(dip.z).toBeGreaterThan(pip.z);
      // Fingertip curls >180 deg inward (-X) toward the rear/palm side (locked closed fist)
      expect(tip.x).toBeLessThan(dip.x);
    }
  });

  it('wraps angled foregrip tightly with thumb indexed forward along the left side rail', () => {
    const { fingerJoints, mountPos } = evaluateLeftHandOnWeapon(
      'm4_556',
      'grip_angled_afg',
      'angled',
      0.92,
    );
    const [thumb, index, middle, ring] = fingerJoints;
    // Thumb indexes forward (-Z) along left side (-X) near the rail
    expect(thumb[3].x).toBeLessThan(-0.008);
    expect(thumb[3].z).toBeLessThan(thumb[0].z);
    // Fingers wrap snugly up the right flank
    for (const f of [index, middle, ring]) {
      expect(f[1].x).toBeGreaterThan(0.012);
      expect(f[3].x).toBeLessThan(f[1].x);
      expect(f[2].y).toBeGreaterThan(mountPos.y - 0.03);
    }
  });
});

describe('Pillar 2 — Persistent Unified Fire-Mode Store Across All Modes', () => {
  let memStorage: Storage;

  beforeEach(() => {
    memStorage = createMemoryStorage();
    (globalThis as unknown as { window: unknown }).window = {
      localStorage: memStorage,
    };
    fireModeStore.resetForTesting();
  });

  it('normalizes weapon ID aliases and persists fire mode across swaps, unequips, and reloads', () => {
    expect(canonicalizeFireModeWeaponId('m4_556')).toBe('m4a1');
    expect(canonicalizeFireModeWeaponId('m4a1')).toBe('m4a1');
    expect(canonicalizeFireModeWeaponId('aks74u_545')).toBe('aks74u');
    expect(canonicalizeFireModeWeaponId('akm_762')).toBe('akm');

    const m4Tutorial = resolveWeaponProfile('m4_556');
    const m4Combat = resolveWeaponProfile('m4a1');
    const akm = resolveWeaponProfile('akm_762');

    expect(fireModeStore.getEffectiveMode(m4Tutorial)).toBe('auto');

    // Switch M4 to SEMI
    const res = fireModeStore.toggle(m4Tutorial);
    expect(res.toggled).toBe(true);
    expect(res.nextMode).toBe('semi');
    expect(formatFireModeLabel(res.nextMode)).toBe('SEMI');
    expect(isSingleShotFireMode(res.nextMode)).toBe(true);
    expect(isSingleShotFireMode('auto')).toBe(false);

    // Switching to another weapon & back (and even using combat alias 'm4a1') preserves SEMI!
    expect(fireModeStore.getEffectiveMode(akm)).toBe('auto');
    expect(fireModeStore.getEffectiveMode(m4Combat)).toBe('semi');
    expect(fireModeStore.getEffectiveMode(m4Tutorial)).toBe('semi');

    // Reloading from localStorage preserves the saved fire mode state
    fireModeStore.reloadFromStorage();
    expect(fireModeStore.getEffectiveMode(m4Tutorial)).toBe('semi');
    expect(fireModeStore.getEffectiveMode(m4Combat)).toBe('semi');
  });

  it('handles SPAS-12 dual semi/pump RPM and pump cycling parity', () => {
    const spas = resolveWeaponProfile('spas_12');
    expect(fireModeStore.getEffectiveMode(spas)).toBe('semi');
    const semiRpm = getEffectiveFireRpm(spas, 'semi');
    expect(semiRpm).toBeGreaterThanOrEqual(spas.rpm);
    expect(shouldCyclePumpOnShot(spas, 'semi')).toBe(false);

    const toggled = fireModeStore.toggle(spas);
    expect(toggled.toggled).toBe(true);
    expect(toggled.nextMode).toBe('pump');
    expect(isSingleShotFireMode('pump')).toBe(true);
    const pumpRpm = getEffectiveFireRpm(spas, 'pump');
    expect(pumpRpm).toBeLessThan(semiRpm);
    expect(pumpRpm).toBe(85);
    expect(shouldCyclePumpOnShot(spas, 'pump')).toBe(true);
  });
});

describe('Pillar 3 — Tutorial Bay 05 Full Destructible Door & Hold-to-Repair', () => {
  beforeAll(() => {
    installHeadlessCanvasStub();
  });

  it('supports full open/peek/close/soft-close, bullet chipping destruction, melee bash, kick breach, and hold-to-repair', () => {
    const root = new THREE.Group();
    const physics = new BodycamPhysicsWorld();
    const doorSystem = new DestructibleDoorSystem(root, physics, true);
    const doorId = 'tutorial_breach_door';

    doorSystem.addDoor({
      id: doorId,
      label: 'Bay 05 Breach Door',
      hingePos: [-0.57, 0, -16.8],
      closedYawRad: 0,
      swingSign: 1,
      width: 1.14,
      height: 2.24,
      thickness: 0.075,
      repairable: true,
      style: 'bunker_wood',
      addFrameJamb: false,
    });

    const door = doorSystem.getDoor(doorId)!;
    expect(door).toBeDefined();
    expect(door.latched).toBe(true);
    expect(door.damageState).toBe(0);

    const actorPos = new THREE.Vector3(0, 1.5, -15.6);
    const actorFwd = new THREE.Vector3(0, 0, -1);

    // 1. Closed latched door exposes Open, Peek, Kick options
    const closedOpts = doorSystem.getInteractOptions(doorId, false, 0, actorPos);
    const closedIds = closedOpts.map((o) => o.id);
    expect(closedIds).toContain('open');
    expect(closedIds).toContain('peek');
    expect(closedIds).toContain('kick');

    // 2. Peek unlatches and swings slightly open
    expect(
      doorSystem.executeOption(doorId, 'peek', {
        actorPos,
        actorForward: actorFwd,
        horizontalSpeedMps: 0,
        isSprinting: false,
      }),
    ).toBe(true);
    expect(door.latched).toBe(false);
    for (let i = 0; i < 20; i++) doorSystem.update(0.025, actorPos);
    expect(Math.abs(door.angleRad)).toBeGreaterThan(0.15);

    // Open door exposes Close & Soft Close
    const openIds = doorSystem.getInteractOptions(doorId, false, 0, actorPos).map((o) => o.id);
    expect(openIds).toContain('close');
    expect(openIds).toContain('close_soft');

    // 3. Bullet chipping progresses damage states 0 -> 1 -> 2 -> 3 and breaches center panel
    const hitPt = new THREE.Vector3(0, 1.25, -16.8);
    for (let s = 0; s < 12; s++) {
      doorSystem.applyBulletImpact(doorId, hitPt, actorFwd, 40);
    }
    expect(door.damageState).toBe(3);
    expect(door.centerBreachPanel.visible).toBe(false);

    // Damaged door exposes Hold-to-Repair option
    const damagedIds = doorSystem.getInteractOptions(doorId, false, 0, actorPos).map((o) => o.id);
    expect(damagedIds).toContain('repair');

    // 4. Hold-to-Repair completes after holding for durationSec and restores intact closed door
    const holdRepair = new HoldRepairController();
    const interactAnim = new PlayerInteractAnimator();
    const cam = new THREE.PerspectiveCamera();
    cam.position.copy(actorPos);

    let repairDone = false;
    const anchor = new THREE.Vector3();
    doorSystem.getRepairAnchorWorldPos(doorId, anchor);

    holdRepair.start(
      {
        kind: 'DOOR_REPAIR',
        targetId: doorId,
        label: 'Repairing Bay 05 Breach Door',
        durationSec: 2.0,
        anchorPos: anchor,
        onComplete: () => {
          repairDone = doorSystem.executeOption(doorId, 'repair', {
            actorPos,
            actorForward: actorFwd,
            horizontalSpeedMps: 0,
            isSprinting: false,
          });
        },
      },
      interactAnim,
    );

    expect(holdRepair.isActive()).toBe(true);
    for (let i = 0; i < 50; i++) {
      holdRepair.step(0.05, true, actorPos, cam, interactAnim, 3.5);
    }
    expect(repairDone).toBe(true);
    expect(holdRepair.isActive()).toBe(false);
    expect(door.damageState).toBe(0);
    expect(door.hingeMode).toBe('attached');
    expect(door.latched).toBe(true);
    expect(door.centerBreachPanel.visible).toBe(true);

    // 5. Sprint-kick destroys the door off hinges and still exposes repair proxy
    doorSystem.executeKick(doorId, actorFwd, 6.0, true, undefined, false, 1, hitPt);
    expect(door.hingeMode).not.toBe('attached');
    const destroyedIds = doorSystem.getInteractOptions(doorId, false, 0, actorPos).map((o) => o.id);
    expect(destroyedIds).toEqual(['repair']);

    doorSystem.dispose();
  });
});

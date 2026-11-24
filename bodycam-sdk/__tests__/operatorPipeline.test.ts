import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ArticulatedRagdoll,
  BodycamController,
  BodycamPhysicsWorld,
  CharacterAnimator,
  CharacterSkeleton,
  DEFAULT_BODYCAM_SDK_CONFIG,
  FACIAL_MORPH_TARGET_NAMES,
  FacialExpressionController,
  HELMET_TYPE_LIST,
  OPERATOR_STORAGE_KEY,
  OperatorAssetLoader,
  OperatorSelectionStore,
  OperatorStorageLike,
  RD_CHEST,
  RD_HEAD,
  RD_PELVIS,
  RAGDOLL_NODE_COUNT,
  RigContractViolationError,
  SDK_WEAPON_PROFILES,
  SecondaryPhysicsSolver,
  TACTICAL_EQUIPMENT_STORAGE_KEY,
  TacticalEquipmentStore,
  TacticalGrenadeSystem,
  TacticalPdaDevice,
  createPdaMotionState,
  getWeaponsByCategory,
  normalizeOperatorGearConfig,
  PdaHudTelemetry,
  WeaponRig,
  buildTacticalEquipmentMesh,
  simulateMaterialPenetration,
  simulateTrajectoryProfile,
  solveZeroPitchRad,
  resolveWeaponProfile,
  validateCrossOperatorParity,
  validateOperatorRig,
} from '../index';
import {
  ATTACHMENTS,
  computeDerivedWeaponStats,
  createBareAttachments,
  getCompatibleAttachments,
  getOwnedSuppressorDef,
  getRequiredRailAdapterId,
  normalizeWeaponAttachments,
} from '../../data/attachments';
import { AMMO_VARIANTS } from '../../data/calibers';
import { WEAPON_UNLOCK_RANK } from '../../data/progression';
import { PMC_FACTIONS } from '../../src/modes/openworld/types';
import { evalRatchetedSuppressorTwist, RatchetedSuppressorTwistSample } from '../weapons/WeaponAnimator';
import { WeaponModelFactory } from '../weapons/WeaponModelFactory';
import {
  createDefaultMatchState,
  validateAndSanitizeGameMessage,
} from '../../worker/gameRelayGuard';
import { LobbyRoomState } from '../../data/multiplayer';
import { WEAPONS } from '../../data/weapons';
import { CharacterSkeleton as SurvivalCharacterSkeleton } from '../../engine/character/CharacterSkeleton';
import { CharacterAnimator as SurvivalCharacterAnimator } from '../../engine/character/CharacterAnimator';
import { CharacterDriverState } from '../../engine/character/ControllerStateReader';
import { WeaponRig as SurvivalWeaponRig } from '../../engine/weapons/WeaponRig';
import { TacticalOperatorRigFactory } from '../../combat/TacticalOperatorRig';
import { InfectedZombieRigLibrary } from '../../combat/InfectedZombieRig';

/**
 * Minimal headless 2D canvas stub so Three.js CanvasTexture procedural PBR materials
 * instantiate cleanly under Node/Vitest without native canvas bindings.
 */
function installHeadlessCanvasStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const noop = () => {};
  const fakeGrad = { addColorStop: noop };
  const fakeCtx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
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
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    setLineDash: noop,
    createLinearGradient: () => fakeGrad,
    createRadialGradient: () => fakeGrad,
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: noop,
  };

  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        return {
          width: 256,
          height: 256,
          getContext: () => fakeCtx,
        };
      }
      return { style: {} };
    },
  };
}

class MemoryStorage implements OperatorStorageLike {
  private readonly map = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  public setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  public removeItem(key: string): void {
    this.map.delete(key);
  }
}

beforeAll(() => {
  installHeadlessCanvasStub();
});

describe('Phase 1 — OperatorSelectionStore persistence, sanitization & URL override', () => {
  it('persists selection under bfps.operator.v1 and survives reload', () => {
    const storage = new MemoryStorage();
    const storeA = new OperatorSelectionStore({ storage, search: '' });
    expect(storeA.getSelectedOperator()).toBe('MALE');

    storeA.setSelectedOperator('FEMALE');
    expect(storage.getItem(OPERATOR_STORAGE_KEY)).toBe('FEMALE');

    const storeB = new OperatorSelectionStore({ storage, search: '' });
    expect(storeB.getSelectedOperator()).toBe('FEMALE');
  });

  it('sanitizes corrupted or unknown storage values back to MALE', () => {
    const storage = new MemoryStorage();
    storage.setItem(OPERATOR_STORAGE_KEY, 'INVALID_CORRUPT_OPERATOR');
    const store = new OperatorSelectionStore({ storage, search: '' });
    expect(store.getSelectedOperator()).toBe('MALE');
    expect(storage.getItem(OPERATOR_STORAGE_KEY)).toBe('MALE');
  });

  it('falls back cleanly to in-memory storage when storage throws', () => {
    const brokenStorage: OperatorStorageLike = {
      getItem: () => {
        throw new Error('SecurityError: storage blocked');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new OperatorSelectionStore({ storage: brokenStorage, search: '' });
    expect(store.getSelectedOperator()).toBe('MALE');
    store.setSelectedOperator('FEMALE');
    expect(store.getSelectedOperator()).toBe('FEMALE');
  });

  it('gives URL query override (?operator=female / ?operator=male) top precedence', () => {
    const storage = new MemoryStorage();
    storage.setItem(OPERATOR_STORAGE_KEY, 'MALE');
    const storeFemale = new OperatorSelectionStore({
      storage,
      search: '?operator=female&debug=1',
    });
    expect(storeFemale.getSelectedOperator()).toBe('FEMALE');
    expect(storeFemale.getUrlOverride()).toBe('FEMALE');

    storage.setItem(OPERATOR_STORAGE_KEY, 'FEMALE');
    const storeMale = new OperatorSelectionStore({ storage, search: '?operator=male' });
    expect(storeMale.getSelectedOperator()).toBe('MALE');
  });
});

describe('Phase 2 — Shared Operator Rig Contract, Parity & First-Person Head Masking', () => {
  it('validates both MALE and FEMALE procedural rigs in STRICT mode and passes cross-operator parity', () => {
    const male = new CharacterSkeleton(1, 'team_a', 'MALE');
    const female = new CharacterSkeleton(1, 'team_a', 'FEMALE');

    const maleReport = validateOperatorRig(male.root, 'MALE', 'STRICT');
    const femaleReport = validateOperatorRig(female.root, 'FEMALE', 'STRICT');
    expect(maleReport.valid).toBe(true);
    expect(femaleReport.valid).toBe(true);

    const parityReport = validateCrossOperatorParity(male.root, female.root, 'STRICT');
    expect(parityReport.valid).toBe(true);
    expect(parityReport.issues).toHaveLength(0);
  });

  it('rejects missing nodes, invalid parent chains, and non-unit scales with RigContractViolationError in STRICT mode', () => {
    // Missing node
    const missingRig = new CharacterSkeleton(1, 'team_a', 'FEMALE');
    const targetNode = missingRig.root.getObjectByName('socket_weapon_r');
    expect(targetNode).toBeTruthy();
    targetNode!.parent?.remove(targetNode!);
    expect(() => validateOperatorRig(missingRig.root, 'FEMALE', 'STRICT')).toThrow(
      RigContractViolationError,
    );

    // Invalid parent chain
    const reparentedRig = new CharacterSkeleton(1, 'team_a', 'FEMALE');
    const headNode = reparentedRig.root.getObjectByName('head')!;
    reparentedRig.root.add(headNode);
    const badParentReport = validateOperatorRig(reparentedRig.root, 'FEMALE', 'SAFE_FALLBACK');
    expect(badParentReport.valid).toBe(false);
    expect(badParentReport.issues.some((i) => i.code === 'INVALID_PARENT' && i.nodeName === 'head')).toBe(true);

    // Non-unit scale
    const scaledRig = new CharacterSkeleton(1, 'team_a', 'MALE');
    const upperArmNode = scaledRig.root.getObjectByName('upperarm_l')!;
    upperArmNode.scale.set(1.08, 1.0, 1.0);
    const badScaleReport = validateOperatorRig(scaledRig.root, 'MALE', 'SAFE_FALLBACK');
    expect(badScaleReport.valid).toBe(false);
    expect(badScaleReport.issues.some((i) => i.code === 'NON_UNIT_SCALE')).toBe(true);
  });

  it('enforces single-rig shadow-only head & helmet masking in first-person bodycam mode', () => {
    const skel = new CharacterSkeleton(1, 'team_a', 'FEMALE');
    skel.setFirstPersonHeadShadowOnly(true);

    let headMeshCount = 0;
    skel.headGroup.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        headMeshCount++;
        const mesh = obj as THREE.Mesh;
        expect(mesh.castShadow).toBe(true);
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          expect(m.colorWrite).toBe(false);
          expect(m.depthWrite).toBe(false);
        }
      }
    });
    expect(headMeshCount).toBeGreaterThan(0);

    skel.setFirstPersonHeadShadowOnly(false);
    skel.headGroup.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          expect(m.colorWrite).toBe(true);
          expect(m.depthWrite).toBe(true);
        }
      }
    });
  });

  it('loads validated procedural operator and falls back to MALE via SAFE_FALLBACK on invalid GLB URL', async () => {
    const loader = new OperatorAssetLoader();
    const loaded = loader.loadProceduralOperator('FEMALE', {
      maxAnisotropy: 1,
      uniformId: 'team_b',
      validationMode: 'SAFE_FALLBACK',
    });
    expect(loaded.operatorId).toBe('FEMALE');
    expect(loaded.fallbackTriggered).toBe(false);
    expect(loaded.validationReport.valid).toBe(true);

    // Non-existent / invalid GLB in SAFE_FALLBACK mode must fall back cleanly to MALE
    const fb = await loader.loadOperator('FEMALE', {
      maxAnisotropy: 1,
      uniformId: 'team_b',
      glbUrl: 'invalid://corrupted-rig.glb',
      validationMode: 'SAFE_FALLBACK',
    });
    expect(fb.operatorId).toBe('MALE');
    expect(fb.fallbackTriggered).toBe(true);
    expect(fb.validationReport.valid).toBe(true);
  });
});

describe('Phase 3 — Ownership-Gated Twist-and-Stow Suppressor Mechanics', () => {
  it('rejects suppressor toggle on a bare weapon and never fabricates a suppressor', () => {
    const scene = new THREE.Scene();
    const rig = new WeaponRig(scene, true);
    const bare = createBareAttachments();
    rig.setWeaponProfile(SDK_WEAPON_PROFILES.m4_556, bare);

    expect(rig.isSuppressorOwned()).toBe(false);
    expect(getOwnedSuppressorDef(bare)).toBeNull();
    expect(rig.getDerivedStats().isSuppressed).toBe(false);

    let callbackFired = false;
    const res = rig.triggerFieldSuppressorToggle(() => {
      callbackFired = true;
    });
    expect(res).toBe('no_suppressor');
    expect(callbackFired).toBe(false);
    expect(rig.isSuppressorActionActive()).toBe(false);
    expect(rig.getDerivedStats().isSuppressed).toBe(false);
  });

  it('executes full blocking detach/stow and re-attach sequence, blocks ADS & re-entry, and cancels safely on weapon swap', () => {
    const scene = new THREE.Scene();
    const rig = new WeaponRig(scene, true);
    const prof = SDK_WEAPON_PROFILES.m4_556;
    const suppDef = getCompatibleAttachments('m4_556', 'muzzle').find((d) => d.isSuppressor);
    expect(suppDef).toBeTruthy();
    const att = normalizeWeaponAttachments('m4_556', { muzzle: suppDef!.id });
    const adapter = new BodycamPhysicsWorld().createAdapter();
    const camPos = new THREE.Vector3(0, 1.5, 0);
    const camQuat = new THREE.Quaternion();
    rig.setWeaponProfile(prof, att);

    expect(rig.isSuppressorOwned()).toBe(true);
    expect(rig.isSuppressorStowed()).toBe(false);
    expect(rig.getDerivedStats().isSuppressed).toBe(true);

    // 1. Start detach/stow sequence
    let completedAttached: boolean | null = null;
    const detachRes = rig.triggerFieldSuppressorToggle((nowAttached) => {
      completedAttached = nowAttached;
    });
    expect(detachRes).toBe('started_detach');
    expect(rig.isSuppressorActionActive()).toBe(true);

    // Re-entrant toggle while active is blocked
    expect(rig.triggerFieldSuppressorToggle()).toBe('busy');

    // Advance partway (~0.7s) while trying to ADS -> ADS must remain suppressed
    for (let i = 0; i < 42; i++) {
      rig.updateRig(
        1 / 60,
        i / 60,
        prof,
        0,
        0,
        true,
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
    expect(rig.isSuppressorActionActive()).toBe(true);
    expect(rig.getReadOnlyRigState().adsBlend).toBeLessThan(0.05);

    // Finish sequence (~2.4s total)
    for (let i = 42; i < 160; i++) {
      rig.updateRig(
        1 / 60,
        i / 60,
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
    expect(rig.isSuppressorActionActive()).toBe(false);
    expect(completedAttached).toBe(false);
    expect(rig.isSuppressorStowed()).toBe(true);
    expect(rig.getDerivedStats().isSuppressed).toBe(false);

    // Verify derived stats helper also reflects stowed suppressor
    const stowedStats = computeDerivedWeaponStats(
      prof.massKg,
      prof.barrelLengthM,
      prof.magCapacity,
      { ...att, suppressorStowed: true },
    );
    expect(stowedStats.isSuppressed).toBe(false);

    // 2. Start re-attach and cancel midway via weapon swap -> must stay stowed with no stuck state
    let attachCompleted = false;
    expect(rig.triggerFieldSuppressorToggle(() => { attachCompleted = true; })).toBe('started_attach');
    expect(rig.isSuppressorActionActive()).toBe(true);
    for (let i = 0; i < 20; i++) {
      rig.updateRig(
        1 / 60,
        i / 60,
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
    rig.setWeaponProfile(SDK_WEAPON_PROFILES.pm_9x19, createBareAttachments());
    expect(rig.isSuppressorActionActive()).toBe(false);
    expect(attachCompleted).toBe(false);

    // 3. Switch back to stowed M4A1 and complete re-attach
    rig.setWeaponProfile(prof, { ...att, suppressorStowed: true });
    expect(rig.isSuppressorStowed()).toBe(true);
    let reattached: boolean | null = null;
    expect(
      rig.triggerFieldSuppressorToggle((nowAttached) => {
        reattached = nowAttached;
      }),
    ).toBe('started_attach');
    for (let i = 0; i < 165; i++) {
      rig.updateRig(
        1 / 60,
        i / 60,
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
    expect(rig.isSuppressorActionActive()).toBe(false);
    expect(reattached).toBe(true);
    expect(rig.isSuppressorStowed()).toBe(false);
    expect(rig.getDerivedStats().isSuppressed).toBe(true);
  });
});

describe('Phase 4 — SecondaryPhysicsSolver Clamps, Isolation & Zero-GC Performance', () => {
  it('saturates strictly within anatomical clamps under extreme 50 m/s² acceleration & 5 m/s shock, locking unused channels at 0', () => {
    const femaleSolver = new SecondaryPhysicsSolver('FEMALE');
    const maleSolver = new SecondaryPhysicsSolver('MALE');

    for (let step = 0; step < 300; step++) {
      for (let ch = 0; ch < 10; ch++) {
        femaleSolver.setChannelAcceleration(ch, 50, -50, 50);
        maleSolver.setChannelAcceleration(ch, 50, -50, 50);
      }
      if (step % 15 === 0) {
        femaleSolver.addGlobalImpulse(5, -5, 5);
        maleSolver.addGlobalImpulse(5, -5, 5);
      }
      femaleSolver.step(1 / 60);
      maleSolver.step(1 / 60);

      // Female chest channels (0, 1): Y in [-14mm, +10mm], Z in [-6mm, +10mm]
      for (const ch of [0, 1]) {
        const base = ch * 3;
        expect(femaleSolver.pos[base + 1]).toBeGreaterThanOrEqual(-0.014 - 1e-6);
        expect(femaleSolver.pos[base + 1]).toBeLessThanOrEqual(0.010 + 1e-6);
        expect(femaleSolver.pos[base + 2]).toBeGreaterThanOrEqual(-0.006 - 1e-6);
        expect(femaleSolver.pos[base + 2]).toBeLessThanOrEqual(0.010 + 1e-6);
        expect(Math.abs(femaleSolver.rotX[ch])).toBeLessThanOrEqual(0.06 + 1e-6);
      }
      // Female arm channels (4..9) must remain strictly locked at 0
      for (let ch = 4; ch < 10; ch++) {
        const base = ch * 3;
        expect(femaleSolver.pos[base]).toBe(0);
        expect(femaleSolver.pos[base + 1]).toBe(0);
        expect(femaleSolver.pos[base + 2]).toBe(0);
      }

      // Male arm channels (4..9): displacement <= 4mm
      for (let ch = 4; ch < 10; ch++) {
        const base = ch * 3;
        expect(Math.abs(maleSolver.pos[base])).toBeLessThanOrEqual(0.004 + 1e-6);
        expect(Math.abs(maleSolver.pos[base + 1])).toBeLessThanOrEqual(0.004 + 1e-6);
        expect(Math.abs(maleSolver.pos[base + 2])).toBeLessThanOrEqual(0.004 + 1e-6);
      }
      // Male chest & glute channels (0..3) must remain strictly locked at 0
      for (let ch = 0; ch < 4; ch++) {
        const base = ch * 3;
        expect(maleSolver.pos[base]).toBe(0);
        expect(maleSolver.pos[base + 1]).toBe(0);
        expect(maleSolver.pos[base + 2]).toBe(0);
      }
    }
  });

  it('meets performance budget (< 0.35 ms/frame across 10,000 simulation steps)', () => {
    const solver = new SecondaryPhysicsSolver('FEMALE');
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) {
      solver.setChannelAcceleration(0, Math.sin(i * 0.1) * 4, -9.8, Math.cos(i * 0.1) * 3);
      solver.setChannelAcceleration(1, -Math.sin(i * 0.1) * 4, -9.8, Math.cos(i * 0.1) * 3);
      solver.step(1 / 60);
    }
    const elapsedMs = performance.now() - t0;
    const msPerFrame = elapsedMs / 10_000;
    expect(msPerFrame).toBeLessThan(0.35);
  });
});

describe('Phase 5 — ArticulatedRagdoll Handoff, Impulse & World Collision', () => {
  it('hands off from live CharacterSkeleton with < 2.0 mm error and responds to directional hit-zone impulse', () => {
    const skel = new CharacterSkeleton(1, 'team_a', 'FEMALE');
    skel.root.position.set(2.5, 0, -1.2);
    skel.root.rotation.set(0, 0.4, 0);
    skel.root.updateMatrixWorld(true);

    const ragdoll = new ArticulatedRagdoll();
    ragdoll.initializeFromSkeleton(skel, new THREE.Vector3(0, 0, 0));
    expect(ragdoll.isActive()).toBe(true);

    // Verify frame-0 handoff error < 2.0 mm on pelvis, chest, and head
    const livePos = new THREE.Vector3();
    const rdPos = new THREE.Vector3();
    const checkPairs: Array<[THREE.Object3D, number]> = [
      [skel.hitZones.hz_pelvis, RD_PELVIS],
      [skel.hitZones.hz_chest, RD_CHEST],
      [skel.hitZones.hz_head, RD_HEAD],
    ];
    for (const [bone, idx] of checkPairs) {
      bone.getWorldPosition(livePos);
      ragdoll.getNodePosition(idx, rdPos);
      expect(livePos.distanceTo(rdPos)).toBeLessThan(0.002);
    }

    // Apply directional headshot impulse along +X and verify head accelerates in +X
    const headBefore = new THREE.Vector3();
    const headAfter = new THREE.Vector3();
    ragdoll.getNodePosition(RD_HEAD, headBefore);
    ragdoll.applyHitZoneImpulse('hz_head', new THREE.Vector3(1, 0.1, 0).normalize(), 4.5);

    const world = new BodycamPhysicsWorld();
    for (let i = 0; i < 6; i++) {
      ragdoll.step(1 / 60, world);
    }
    ragdoll.getNodePosition(RD_HEAD, headAfter);
    expect(headAfter.x - headBefore.x).toBeGreaterThan(0.05);
  });

  it('settles cleanly above stairs and ramp geometry with finite coordinates and enters sleep', () => {
    const world = new BodycamPhysicsWorld();
    // Build a stair step and a sloped ramp directly beneath the ragdoll
    world.addBox({ minX: -2, maxX: 2, minY: 0, maxY: 0.35, minZ: -2, maxZ: 0 });
    world.addRamp({
      minX: -2,
      maxX: 2,
      minZ: 0,
      maxZ: 3,
      baseY: 0.0,
      topY: 0.35,
      riseAxis: '-z',
    });

    const ragdoll = new ArticulatedRagdoll();
    ragdoll.initializeFromStandingPose(new THREE.Vector3(0, 0.35, -0.3), 0, new THREE.Vector3(0, 0, 1.2));
    ragdoll.applyHitZoneImpulse('thorax', new THREE.Vector3(0, 0.15, 1).normalize(), 3.8);

    // Simulate 3.0 seconds at 60 Hz
    for (let i = 0; i < 180; i++) {
      ragdoll.step(1 / 60, world);
    }

    // All 15 nodes must remain finite and above ground plane (y >= 0.02)
    for (let n = 0; n < RAGDOLL_NODE_COUNT; n++) {
      const x = ragdoll.pos[n * 3];
      const y = ragdoll.pos[n * 3 + 1];
      const z = ragdoll.pos[n * 3 + 2];
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0.02);
    }

    // Should settle and sleep cleanly
    expect(ragdoll.isSleeping()).toBe(true);
  });
});

describe('Phase 6 — Tactical Equipment Belt Mounting & Persistent Store', () => {
  it('mounts grenades onto the pelvis belt slot for MALE and FEMALE while preserving STRICT rig parity', () => {
    const male = new CharacterSkeleton(1, 'team_a', 'MALE');
    const female = new CharacterSkeleton(1, 'team_a', 'FEMALE');

    male.setBeltEquipment('m67_frag', 'front_left', 2, true);
    female.setBeltEquipment('m84_flash', 'right_hip', 3, true);

    expect(male.getBeltEquipmentState()).toEqual({
      equipmentId: 'm67_frag',
      beltSlot: 'front_left',
      count: 2,
      visible: true,
    });
    expect(female.getBeltEquipmentState()).toEqual({
      equipmentId: 'm84_flash',
      beltSlot: 'right_hip',
      count: 3,
      visible: true,
    });

    const maleReport = validateOperatorRig(male.root, 'MALE', 'STRICT');
    const femaleReport = validateOperatorRig(female.root, 'FEMALE', 'STRICT');
    expect(maleReport.valid).toBe(true);
    expect(femaleReport.valid).toBe(true);

    const parityReport = validateCrossOperatorParity(male.root, female.root, 'STRICT');
    expect(parityReport.valid).toBe(true);
    expect(parityReport.issues).toHaveLength(0);

    // Unmounting or depleting hides mounted meshes without breaking parity
    male.setBeltEquipment('an_m14_thermite', 'rear_belt', 0, false);
    expect(validateOperatorRig(male.root, 'MALE', 'STRICT').valid).toBe(true);
  });

  it('persists TacticalEquipmentStore changes and notifies subscribers cleanly', () => {
    const storage = new MemoryStorage();
    const storeA = new TacticalEquipmentStore(storage);
    expect(storeA.getSelection()).toEqual({
      equipmentId: 'm67_frag',
      beltSlot: 'front_left',
      mountOnBelt: true,
    });

    const notifications: Array<{ equipmentId: string; beltSlot: string; mountOnBelt: boolean }> = [];
    const unsubscribe = storeA.subscribe((next) => notifications.push(next));

    storeA.setEquipment('m18_smoke');
    storeA.setBeltSlot('left_hip');
    storeA.setMountOnBelt(false);

    expect(notifications).toHaveLength(3);
    expect(notifications[2]).toEqual({
      equipmentId: 'm18_smoke',
      beltSlot: 'left_hip',
      mountOnBelt: false,
    });
    expect(storage.getItem(TACTICAL_EQUIPMENT_STORAGE_KEY)).toBeTruthy();

    unsubscribe();
    storeA.setMountOnBelt(true);
    expect(notifications).toHaveLength(3);

    const storeB = new TacticalEquipmentStore(storage);
    expect(storeB.getSelection()).toEqual({
      equipmentId: 'm18_smoke',
      beltSlot: 'left_hip',
      mountOnBelt: true,
    });
  });
});

describe('Phase 7 — Rail-Adapter Optics, Razor PiP Hollow Geometry & Ballistics Zeroing', () => {
  it('enforces B-13 AK dovetail and MP5 claw rail adapters before mounting Picatinny optics', () => {
    // AKM requires B-13 dovetail adapter to mount Razor 1-6x, while PSO-1M2 mounts natively
    expect(getRequiredRailAdapterId(ATTACHMENTS.optic_razor_1_6, 'akm_762')).toBe('rail_b13_dovetail');
    const bareAkmOptics = getCompatibleAttachments('akm_762', 'optic', createBareAttachments());
    expect(bareAkmOptics.some((o) => o.id === 'optic_pso1m2')).toBe(true);
    expect(bareAkmOptics.some((o) => o.id === 'optic_razor_1_6')).toBe(false);

    const b13AkmOptics = getCompatibleAttachments('akm_762', 'optic', {
      railAdapter: 'rail_b13_dovetail',
    });
    expect(b13AkmOptics.some((o) => o.id === 'optic_razor_1_6')).toBe(true);

    // Stripping the B-13 adapter automatically clears Picatinny optics during normalization
    const strippedAkm = normalizeWeaponAttachments('akm_762', {
      railAdapter: null,
      optic: 'optic_razor_1_6',
    });
    expect(strippedAkm.optic).toBeUndefined();

    // MP5 requires claw mount adapter for Razor 1-6x
    expect(getRequiredRailAdapterId(ATTACHMENTS.optic_razor_1_6, 'hk_mp5')).toBe('rail_mp5_claw');
    const bareMp5Optics = getCompatibleAttachments('hk_mp5', 'optic', createBareAttachments());
    expect(bareMp5Optics.some((o) => o.id === 'optic_razor_1_6')).toBe(false);
    const clawMp5Optics = getCompatibleAttachments('hk_mp5', 'optic', {
      railAdapter: 'rail_mp5_claw',
    });
    expect(clawMp5Optics.some((o) => o.id === 'optic_razor_1_6')).toBe(true);

    // RMR Type 2 mounts cleanly on Glock 17 slide & M4A1 receiver
    expect(
      getCompatibleAttachments('glock_17', 'optic', createBareAttachments()).some(
        (o) => o.id === 'optic_rmr_type2',
      ),
    ).toBe(true);
  });

  it('assembles Vortex Razor 1-6x with hollow ocular ring, zoomRingPivot, zoomRingSocket & elevation turret', () => {
    const scene = new THREE.Scene();
    const rig = new WeaponRig(scene, true);
    const att = normalizeWeaponAttachments('m4_556', { optic: 'optic_razor_1_6' });
    rig.setWeaponProfile(SDK_WEAPON_PROFILES.m4_556, att);
    const assembly = rig.getModelAssembly();

    expect(assembly).toBeTruthy();
    expect(assembly!.opticGroup).toBeTruthy();
    expect(assembly!.scopeLensMaterial).toBeTruthy();
    expect(assembly!.zoomRingPivot).toBeTruthy();
    expect(assembly!.zoomRingSocket).toBeTruthy();
    expect(assembly!.elevationTurretMesh).toBeTruthy();
    expect(assembly!.scopeLensMaterial?.polygonOffset).toBe(true);
  });

  it('solves HOB zeroing pitch accurately and simulates deterministic trajectory & material penetration', () => {
    const m855a1 = AMMO_VARIANTS['556x45_m855a1'];
    const pitch100 = solveZeroPitchRad({
      muzzleVelocityMs: m855a1.baseVelocityMs,
      bc: m855a1.ballisticCoefficient,
      heightOverBoreM: 0.068,
      zeroDistanceM: 100,
    });
    const pitch300 = solveZeroPitchRad({
      muzzleVelocityMs: m855a1.baseVelocityMs,
      bc: m855a1.ballisticCoefficient,
      heightOverBoreM: 0.068,
      zeroDistanceM: 300,
    });
    expect(pitch100).toBeGreaterThan(0);
    expect(pitch300).toBeGreaterThan(pitch100);

    const profile = simulateTrajectoryProfile({
      ammo: m855a1,
      heightOverBoreM: 0.068,
      zeroDistanceM: 100,
      maxRangeM: 400,
    });
    expect(profile.points.length).toBeGreaterThan(40);
    const at100 = profile.rangeGates.find((g) => g.distanceM === 100);
    expect(at100).toBeTruthy();
    expect(Math.abs(at100!.dropCm)).toBeLessThan(1.5);

    // M855A1 AP penetrates pine timber cleanly and stops on thick AR500 steel
    const woodPen = simulateMaterialPenetration({
      ammo: m855a1,
      impactSpeedMs: 850,
      material: 'wood',
      thicknessM: 0.038,
      obliquityDeg: 0,
    });
    expect(woodPen.outcome).toBe('penetrate');
    expect(woodPen.exitSpeedMs).toBeGreaterThan(600);

    const ar500Stop = simulateMaterialPenetration({
      ammo: m855a1,
      impactSpeedMs: 700,
      material: 'steel',
      thicknessM: 0.014,
      obliquityDeg: 5,
    });
    expect(ar500Stop.outcome).not.toBe('penetrate');
  });
});

describe('Phase 8 — Ratcheted Suppressor IK, Sprint Emergency Cancel, Geometry Hand Poses & MP Guard Parity', () => {
  it('evaluates 3-stroke ratcheted suppressor twist with stationary regrip intervals and positive finger release', () => {
    const out: RatchetedSuppressorTwistSample = {
      cumulativeAngle01: 0,
      axial01: 0,
      wristRollRad: 0,
      gripRelease01: 0,
      weaponCounterRollRad: 0,
      strokeIndex: 0,
    };

    // Start of stroke 0 -> 0 progress
    evalRatchetedSuppressorTwist(0, false, out);
    expect(out.cumulativeAngle01).toBeCloseTo(0, 5);
    expect(out.axial01).toBeCloseTo(0, 5);
    expect(out.strokeIndex).toBe(0);

    // End of twist portion of stroke 0 (u = 0.68 / 3) vs mid-regrip (u = 0.84 / 3):
    // Suppressor cumulative angle & axial travel MUST stay frozen while fingers open to regrip!
    evalRatchetedSuppressorTwist(0.68 / 3, false, out);
    const angleAtRegripStart = out.cumulativeAngle01;
    const axialAtRegripStart = out.axial01;
    expect(angleAtRegripStart).toBeCloseTo(1 / 3, 4);

    evalRatchetedSuppressorTwist(0.84 / 3, false, out);
    expect(out.cumulativeAngle01).toBeCloseTo(angleAtRegripStart, 5);
    expect(out.axial01).toBeCloseTo(axialAtRegripStart, 5);
    expect(out.gripRelease01).toBeGreaterThan(0.5);

    // Stroke 1 and Stroke 2 reach 2/3 and 1.0 respectively
    evalRatchetedSuppressorTwist((1 + 0.72) / 3, true, out);
    expect(out.strokeIndex).toBe(1);
    expect(out.cumulativeAngle01).toBeCloseTo(2 / 3, 4);

    evalRatchetedSuppressorTwist(1.0, true, out);
    expect(out.strokeIndex).toBe(2);
    expect(out.cumulativeAngle01).toBeCloseTo(1.0, 5);
    expect(out.axial01).toBeCloseTo(1.0, 5);
  });

  it('blocks firing during suppressor toggle and emergency-cancels cleanly on sprint preserving pre-action state', () => {
    const scene = new THREE.Scene();
    const rig = new WeaponRig(scene, true);
    const prof = SDK_WEAPON_PROFILES.m4_556;
    const suppDef = getCompatibleAttachments('m4_556', 'muzzle').find((d) => d.isSuppressor)!;
    const att = normalizeWeaponAttachments('m4_556', { muzzle: suppDef.id });
    const adapter = new BodycamPhysicsWorld().createAdapter();
    const camPos = new THREE.Vector3(0, 1.5, 0);
    const camQuat = new THREE.Quaternion();
    rig.setWeaponProfile(prof, att);

    let completed = false;
    expect(rig.triggerFieldSuppressorToggle(() => { completed = true; })).toBe('started_detach');
    expect(rig.isBlockingFiringAction()).toBe(true);
    expect(rig.getSyncedHandlingSnapshot().action).toBe('SUPPRESSOR_DETACH');

    // Step 15 frames normally
    for (let i = 0; i < 15; i++) {
      rig.updateRig(
        1 / 60,
        i / 60,
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
    expect(rig.isBlockingFiringAction()).toBe(true);

    // Trigger emergency cancel via sprint (arg 8 = isSprinting: true) -> must abort cleanly and keep suppressor mounted!
    rig.updateRig(
      1 / 60,
      16 / 60,
      prof,
      0,
      0,
      false,
      false,
      true,
      true,
      0,
      0,
      0,
      camPos,
      camQuat,
      adapter,
      DEFAULT_BODYCAM_SDK_CONFIG,
    );
    expect(rig.isSuppressorActionActive()).toBe(false);
    expect(rig.isBlockingFiringAction()).toBe(false);
    expect(completed).toBe(false);
    expect(rig.isSuppressorStowed()).toBe(false);
    expect(rig.getDerivedStats().isSuppressed).toBe(true);
  });

  it('builds valid geometry-driven handPoseProfile data across pistol, rifle, and pump shotgun models', () => {
    const ids = ['glock_17', 'm4_556', 'remington_870'] as const;
    for (const id of ids) {
      const built = WeaponModelFactory.build(resolveWeaponProfile(id));
      const hp = built.handPoseProfile;
      expect(hp).toBeTruthy();
      expect(hp.gripWidthM).toBeGreaterThan(0.015);
      expect(hp.gripWidthM).toBeLessThan(0.06);
      expect(hp.supportRadiusM).toBeGreaterThan(0.01);
      expect(hp.supportRadiusM).toBeLessThan(0.06);
      expect(hp.triggerReachM).toBeGreaterThan(0.01);
      expect(hp.triggerReachM).toBeLessThan(0.12);
      expect(built.trigger).toBeTruthy();
    }
    const glock = WeaponModelFactory.build(resolveWeaponProfile('glock_17'));
    expect(glock.handPoseProfile.supportStyle).toBe('pistol_cup');
    const rem = WeaponModelFactory.build(resolveWeaponProfile('remington_870'));
    expect(rem.handPoseProfile.supportStyle).toBe('pump_forend');
  });

  it('sanitizes att, ha, hprog, and sup across game:state, game:bots_sync, and game:bot_fire in gameRelayGuard', () => {
    const roomState: LobbyRoomState = {
      code: 'TST001',
      hostUserId: 'host_1',
      hostUsername: 'HOST',
      visibility: 'private',
      mode: 'battle',
      battleRule: 'tdm',
      mapId: 'timberline_compound',
      maxPlayers: 8,
      botsEnabled: true,
      botCount: 4,
      killLimit: 30,
      botDifficulty: 'tactical',
      status: 'in_match',
      matchSequence: 1,
      specialEvent: null,
      members: [
        {
          userId: 'host_1',
          username: 'HOST',
          team: 'A',
          ready: true,
          isHost: true,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
        {
          userId: 'peer_2',
          username: 'PEER',
          team: 'B',
          ready: true,
          isHost: false,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
      ],
      chat: [],
      updatedAt: Date.now(),
    };
    const matchState = createDefaultMatchState();

    // 1. Valid & out-of-range game:state from peer
    const stateRes = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 1.5,
        y: 0.0,
        z: -3.25,
        yaw: 0.5,
        pitch: 0.1,
        weaponId: 'm4a1',
        att: { o: 'optic_razor_1_6', m: 'muzzle_socom_556', ss: false, evil: 'DROP TABLE' },
        ha: 'SUPPRESSOR_DETACH',
        hprog: 1.75,
        sup: true,
        hp: 100,
        maxHp: 100,
        alive: true,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(stateRes).toBeTruthy();
    expect(stateRes!.payload.ha).toBe('SUPPRESSOR_DETACH');
    expect(stateRes!.payload.hprog).toBe(1);
    expect(stateRes!.payload.sup).toBe(true);
    expect(stateRes!.payload.att).toEqual({
      o: 'optic_razor_1_6',
      m: 'muzzle_socom_556',
      ss: false,
    });

    // Invalid ha enum degrades cleanly to 'NONE'
    const badHaRes = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        ha: 'EXPLOIT_ACTION',
        hprog: -5,
        hp: 100,
        maxHp: 100,
        alive: true,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(badHaRes).toBeTruthy();
    expect(badHaRes!.payload.ha).toBe('NONE');
    expect(badHaRes!.payload.hprog).toBe(0);

    // 2. Host game:bots_sync & game:bot_fire preserve sanitized att, ha, hprog, sup
    const botSyncRes = validateAndSanitizeGameMessage(
      {
        type: 'game:bots_sync',
        scoreA: 2,
        scoreB: 1,
        bots: [
          {
            id: 'bot_0',
            name: 'ALPHA-1',
            team: 'A',
            weaponId: 'm4a1',
            att: { o: 'optic_eotech_exps3', m: 'muzzle_socom_556', ss: false },
            ha: 'SUPPRESSOR_ATTACH',
            hprog: 0.42,
            sup: true,
            x: 2,
            y: 0,
            z: 4,
            yaw: 1.2,
            alive: true,
            hp: 100,
            maxHp: 100,
            kills: 1,
            deaths: 0,
          },
        ],
      },
      roomState,
      matchState,
      { userId: 'host_1', username: 'HOST' },
    );
    expect(botSyncRes).toBeTruthy();
    const syncedBots = botSyncRes!.payload.bots as Array<Record<string, unknown>>;
    expect(syncedBots).toHaveLength(1);
    expect(syncedBots[0].ha).toBe('SUPPRESSOR_ATTACH');
    expect(syncedBots[0].hprog).toBe(0.42);
    expect(syncedBots[0].sup).toBe(true);
    expect(syncedBots[0].att).toEqual({
      o: 'optic_eotech_exps3',
      m: 'muzzle_socom_556',
      ss: false,
    });

    const botFireRes = validateAndSanitizeGameMessage(
      {
        type: 'game:bot_fire',
        botId: 'bot_0',
        ox: 1,
        oy: 1.5,
        oz: 2,
        ex: 10,
        ey: 1.5,
        ez: 2,
        weaponId: 'm4a1',
        caliberId: '556x45',
        sup: true,
      },
      roomState,
      matchState,
      { userId: 'host_1', username: 'HOST' },
    );
    expect(botFireRes).toBeTruthy();
    expect(botFireRes!.payload.sup).toBe(true);
    expect(botFireRes!.payload.weaponId).toBe('m4a1');
    expect(botFireRes!.payload.caliberId).toBe('556x45');
  });
});

describe('Phase 4 — Bone-Driven Tactical Grenade Manual of Arms, Survival Parity & MP Relay Guard', () => {
  it('exposes separable grenade parts (pullRingMesh, spoonGroup, anchors) and passes cross-operator rig parity with new grenade sockets', () => {
    for (const eqId of ['m67_frag', 'm84_flash', 'm18_smoke', 'an_m14_thermite'] as const) {
      const built = buildTacticalEquipmentMesh(eqId, { withBeltClip: false });
      expect(built.pullRingMesh).toBeTruthy();
      expect(built.spoonGroup).toBeTruthy();
      expect(built.spoonAnchor).toBeTruthy();
      expect(built.pinAnchor).toBeTruthy();
      expect(built.pinPullAxis.length()).toBeGreaterThan(0.5);
      built.dispose();
    }

    const male = new CharacterSkeleton(1, 'team_a', 'MALE');
    const female = new CharacterSkeleton(1, 'team_b', 'FEMALE');
    expect(male.throwHandSocket).toBeTruthy();
    expect(male.leftPinPinchSocket).toBeTruthy();
    expect(male.leftPocketAnchor).toBeTruthy();
    expect(male.leftEyeAimAnchor).toBeTruthy();
    expect(male.leftChestBalanceAnchor).toBeTruthy();
    expect(female.throwHandSocket).toBeTruthy();
    expect(female.leftPinPinchSocket).toBeTruthy();

    const parity = validateCrossOperatorParity(male.root, female.root, 'STRICT');
    expect(parity.valid).toBe(true);
    expect(parity.issues).toHaveLength(0);
    male.dispose();
    female.dispose();
  });

  it('enforces 4-stage RMB pin/spoon + LMB underhand/overhand throw, safe holster vs live toss, focus-loss reset, and overcook detonation in TacticalGrenadeSystem', () => {
    const scene = new THREE.Scene();
    const adapter = new BodycamPhysicsWorld().createAdapter();
    let inHandDetonations = 0;
    let totalDetonations = 0;
    const sys = new TacticalGrenadeSystem({
      scene,
      physics: adapter,
      worldRaycastMeshes: [],
      onDetonate: () => {
        totalDetonations += 1;
      },
      onInHandDetonate: () => {
        inHandDetonations += 1;
      },
    });
    const skel = new CharacterSkeleton(1, 'team_a', 'MALE');

    // Stage 1: Draw (fuse NOT running)
    expect(sys.drawGrenade('m67_frag')).toBe(true);
    expect(sys.getHoldStage()).toBe('DRAWN');
    expect(sys.isLeverReleased()).toBe(false);
    // Cannot pull spoon before pin or start throw while pin intact
    expect(sys.releaseLever()).toBe(false);
    expect(sys.beginThrowInput()).toBe(false);

    // Stage 2: 1st RMB pulls pin into pocket, spoon stays gripped -> fuse MUST NOT run
    expect(sys.pullPin()).toBe(true);
    expect(sys.getHoldStage()).toBe('PIN_PULLED');
    expect(sys.isLeverReleased()).toBe(false);
    for (let i = 0; i < 160; i++) {
      sys.update(0.05);
      sys.syncHeldBoneAttachment(skel.throwHandSocket, skel.leftPinPinchSocket, skel.leftPocketAnchor);
    }
    expect(inHandDetonations).toBe(0);
    expect(sys.getHoldStage()).toBe('PIN_PULLED');
    expect(sys.getPinPullPhase()).toBe('EYE_AIM');

    // Safe holster before lever release returns 'holstered' and spends 0 grenades
    expect(
      sys.holsterOrTossOnSwitch(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1)),
    ).toBe('holstered');
    expect(sys.getHoldStage()).toBe('HOLSTERED');

    // Quick LMB click (<0.18s) from PIN_PULLED -> underhand lob (~10.0 m/s)
    expect(sys.drawGrenade('m67_frag')).toBe(true);
    expect(sys.pullPin()).toBe(true);
    expect(sys.beginThrowInput()).toBe(true);
    sys.update(0.05);
    expect(sys.releaseThrowInput()).toBe('underhand');
    for (let i = 0; i < 3; i++) sys.update(0.03);
    const lobRes = sys.consumePendingThrowRelease(
      new THREE.Vector3(0.2, 1.4, -0.3),
      new THREE.Vector3(0, 0, -1),
    );
    expect(lobRes).toBeTruthy();
    expect(lobRes!.thrown).toBe(true);
    expect(lobRes!.style).toBe('underhand');
    expect(lobRes!.speedMps).toBeCloseTo(10.0, 2);
    const launchedLob = sys.consumeLastLaunchedThrow();
    expect(launchedLob?.style).toBe('underhand');

    // Long LMB hold (>=0.18s) -> overhand power throw (13.5..22.5 m/s) & focus-loss guard
    expect(sys.drawGrenade('m67_frag')).toBe(true);
    expect(sys.pullPin()).toBe(true);
    expect(sys.releaseLever()).toBe(true);
    expect(sys.getHoldStage()).toBe('LEVER_RELEASED');
    sys.syncHeldBoneAttachment(skel.throwHandSocket, skel.leftPinPinchSocket, skel.leftPocketAnchor);
    expect(sys.getHeldGrenadeMesh()?.spoonGroup.visible).toBe(false);

    expect(sys.beginThrowInput()).toBe(true);
    for (let i = 0; i < 12; i++) sys.update(0.04); // 0.48s held -> overhand
    expect(sys.getThrowStyle()).toBe('overhand');
    expect(sys.getCharge01()).toBeGreaterThan(0.2);

    // Window blur clears held LMB charge WITHOUT canceling the live lever-released fuse
    sys.resetHeldInputOnFocusLoss();
    expect(sys.isThrowInputHeld()).toBe(false);
    expect(sys.getCharge01()).toBe(0);
    expect(sys.getHoldStage()).toBe('LEVER_RELEASED');

    // Switching weapons while lever is released tosses the live grenade clear ('tossed')
    expect(
      sys.holsterOrTossOnSwitch(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1)),
    ).toBe('tossed');
    const tossedLive = sys.consumeLastLaunchedThrow();
    expect(tossedLive).toBeTruthy();
    expect(sys.getHoldStage()).toBe('HOLSTERED');

    // Overhand release speed check + overcook in-hand detonation check
    expect(sys.drawGrenade('m67_frag')).toBe(true);
    expect(sys.pullPin()).toBe(true);
    expect(sys.beginThrowInput()).toBe(true);
    for (let i = 0; i < 25; i++) sys.update(0.05); // 1.25s full charge
    expect(sys.releaseThrowInput()).toBe('overhand');
    for (let i = 0; i < 3; i++) sys.update(0.03);
    const powerRes = sys.consumePendingThrowRelease(
      new THREE.Vector3(0.2, 1.4, -0.3),
      new THREE.Vector3(0, 0, -1),
    );
    expect(powerRes?.style).toBe('overhand');
    expect(powerRes?.speedMps).toBeCloseTo(22.5, 1);

    // Overcooking in hand triggers onInHandDetonate & resets to HOLSTERED
    expect(sys.drawGrenade('m84_flash')).toBe(true);
    expect(sys.pullPin()).toBe(true);
    expect(sys.releaseLever()).toBe(true);
    for (let i = 0; i < 120; i++) {
      sys.update(0.05, new THREE.Vector3(0, 1.4, 0));
    }
    expect(inHandDetonations).toBe(1);
    expect(totalDetonations).toBeGreaterThanOrEqual(1);
    expect(sys.getHoldStage()).toBe('HOLSTERED');

    skel.dispose();
    sys.dispose();
  });

  it('implements Survival RGD-5 4-stage RMB/LMB parity and Bolt click/hold throw in Survival CharacterAnimator', () => {
    const scene = new THREE.Scene();
    const skel = new SurvivalCharacterSkeleton(1);
    const rig = new SurvivalWeaponRig(scene, true);
    const animator = new SurvivalCharacterAnimator(skel, rig);
    const adapter = new BodycamPhysicsWorld().createAdapter();

    const released: Array<{ id: string; speed: number; style: string; fuse: number }> = [];
    let overcooked = 0;
    animator.setCallbacks({
      onThrowRelease: (spec, _pos, remFuse, speed, style) => {
        released.push({ id: spec.id, speed, style, fuse: remFuse });
      },
      onOvercookedDetonate: () => {
        overcooked += 1;
      },
    });

    const driverState: CharacterDriverState = {
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
      wallPullback: 0,
      recoilSpring: { z: 0, pitch: 0, roll: 0 },
      chestHeight: 1.4,
      cameraWorldPos: new THREE.Vector3(0, 1.42, 0),
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

    const fragSpec = WEAPONS.rgd5_frag;
    const boltSpec = WEAPONS.throw_bolt;
    const groundFn = () => 0;

    // RGD-5 requires pin pull before throwing
    expect(animator.beginThrowInput(fragSpec)).toBe(false);
    expect(animator.pullThrowablePin(fragSpec)).toBe(true);
    expect(animator.getThrowableStage()).toBe('PIN_PULLED');
    expect(animator.isThrowableLiveFuse()).toBe(false);

    // Safe holster before lever release
    expect(animator.holsterOrTossThrowable(fragSpec)).toBe('holstered');
    expect(animator.getThrowableStage()).toBe('READY');

    // Pin -> Lever -> Quick LMB lob
    expect(animator.pullThrowablePin(fragSpec)).toBe(true);
    expect(animator.releaseThrowableLever(fragSpec)).toBe(true);
    expect(animator.isThrowableLiveFuse()).toBe(true);
    expect(animator.beginThrowInput(fragSpec)).toBe(true);
    animator.update(0.04, 0.04, driverState, fragSpec, groundFn, undefined, adapter);
    expect(animator.releaseThrowInput(fragSpec)).toBe('underhand');
    for (let i = 0; i < 4; i++) {
      animator.update(0.03, 0.1 + i * 0.03, driverState, fragSpec, groundFn, undefined, adapter);
    }
    expect(released).toHaveLength(1);
    expect(released[0].id).toBe('rgd5_frag');
    expect(released[0].style).toBe('underhand');
    expect(released[0].speed).toBeCloseTo(10.0, 2);

    // Throwing Bolt bypasses pin/spoon and supports direct LMB hold -> overhand power throw
    // Step 1 frame to switch equipped weapon from rgd5_frag -> throw_bolt (clears throwCooldownHideTimer)
    animator.update(0.02, 0.5, driverState, boltSpec, groundFn, undefined, adapter);
    expect(animator.beginThrowInput(boltSpec)).toBe(true);
    for (let i = 0; i < 20; i++) {
      animator.update(0.05, 1 + i * 0.05, driverState, boltSpec, groundFn, undefined, adapter);
    }
    expect(animator.releaseThrowInput(boltSpec)).toBe('overhand');
    for (let i = 0; i < 4; i++) {
      animator.update(0.03, 2 + i * 0.03, driverState, boltSpec, groundFn, undefined, adapter);
    }
    expect(released).toHaveLength(2);
    expect(released[1].id).toBe('throw_bolt');
    expect(released[1].style).toBe('overhand');
    expect(released[1].speed).toBeGreaterThan(20);

    // Switch back to RGD-5 and test overcooked in-hand detonation
    animator.update(0.02, 2.5, driverState, fragSpec, groundFn, undefined, adapter);
    expect(animator.pullThrowablePin(fragSpec)).toBe(true);
    expect(animator.releaseThrowableLever(fragSpec)).toBe(true);
    for (let i = 0; i < 110; i++) {
      animator.update(0.05, 3 + i * 0.05, driverState, fragSpec, groundFn, undefined, adapter);
    }
    expect(overcooked).toBe(1);

    rig.dispose();
    skel.dispose();
  });

  it('animates 3P TacticalOperatorRig grenade stances (hides firearm, shows palm ordnance) and sanitizes MP grenade events', () => {
    const factory = new TacticalOperatorRigFactory(1);
    const opRig = factory.buildOperator('bot', 'bot_test', 'team_a', 'MALE');
    opRig.setWeaponLoadout('m4a1', createBareAttachments());

    opRig.applyCombatPose({
      crouchBlend: 0,
      leanBlend: 0,
      aimPitch: 0.1,
      adsBlend: 0,
      pointAimBlend: 0,
      cantBlend: 0,
      reloadBlend: 0,
      speedMps: 0,
      walkCycle: 0,
      sprint: false,
      recoilKick: 0,
      firingVibration: 0,
      flinchPitch: 0,
      handlingAction: 'GRENADE_CHARGE',
      handlingProgress: 0.65,
      grenadeEquipmentId: 'm67_frag',
      grenadeCharge01: 0.85,
      grenadeThrowStyle: 'overhand',
    });
    expect(opRig.weaponPivot.visible).toBe(false);
    expect(opRig.muzzleFlash.visible).toBe(false);

    opRig.applyCombatPose({
      crouchBlend: 0,
      leanBlend: 0,
      aimPitch: 0,
      adsBlend: 0,
      pointAimBlend: 0,
      cantBlend: 0,
      reloadBlend: 0,
      speedMps: 0,
      walkCycle: 0,
      sprint: false,
      recoilKick: 0,
      firingVibration: 0,
      flinchPitch: 0,
      handlingAction: 'NONE',
      handlingProgress: 0,
    });
    expect(opRig.weaponPivot.visible).toBe(true);
    factory.dispose();

    const roomState: LobbyRoomState = {
      code: 'GRN001',
      hostUserId: 'host_1',
      hostUsername: 'HOST',
      visibility: 'private',
      mode: 'battle',
      battleRule: 'tdm',
      mapId: 'timberline_compound',
      maxPlayers: 8,
      botsEnabled: true,
      botCount: 2,
      killLimit: 30,
      botDifficulty: 'tactical',
      status: 'in_match',
      matchSequence: 1,
      specialEvent: null,
      members: [
        {
          userId: 'host_1',
          username: 'HOST',
          team: 'A',
          ready: true,
          isHost: true,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
        {
          userId: 'peer_2',
          username: 'PEER',
          team: 'B',
          ready: true,
          isHost: false,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
      ],
      chat: [],
      updatedAt: Date.now(),
    };
    const matchState = createDefaultMatchState();

    // Peer can broadcast own throw; spoofed actorId or isBot=true is rejected/overwritten
    const peerThrow = validateAndSanitizeGameMessage(
      {
        type: 'game:grenade_event',
        kind: 'throw',
        equipmentId: 'm84_flash',
        actorId: 'spoofed_host',
        px: 3.5,
        py: 1.6,
        pz: -2.0,
        vx: 12.0,
        vy: 3.5,
        vz: -14.0,
        fuseRemainingSec: 2.2,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(peerThrow).toBeTruthy();
    expect(peerThrow!.payload.actorId).toBe('peer_2');
    expect(peerThrow!.payload.equipmentId).toBe('m84_flash');
    expect(peerThrow!.payload.fuseRemainingSec).toBe(2.2);

    const spoofedBotThrow = validateAndSanitizeGameMessage(
      {
        type: 'game:grenade_event',
        kind: 'throw',
        equipmentId: 'm67_frag',
        isBot: true,
        actorId: 'bot_0',
        px: 0,
        py: 1,
        pz: 0,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(spoofedBotThrow).toBeNull();

    const invalidEquip = validateAndSanitizeGameMessage(
      {
        type: 'game:grenade_event',
        kind: 'throw',
        equipmentId: 'nuke_exploit',
        px: 0,
        py: 1,
        pz: 0,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(invalidEquip).toBeNull();

    // State sync sanitizes grenade fields geq, gc, gts alongside ha=GRENADE_CHARGE
    const grenadeState = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 1,
        y: 0,
        z: 1,
        yaw: 0,
        pitch: 0,
        ha: 'GRENADE_CHARGE',
        hprog: 0.7,
        geq: 'm18_smoke',
        gc: 2.4,
        gts: 'overhand',
        hp: 100,
        maxHp: 100,
        alive: true,
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(grenadeState).toBeTruthy();
    expect(grenadeState!.payload.ha).toBe('GRENADE_CHARGE');
    expect(grenadeState!.payload.geq).toBe('m18_smoke');
    expect(grenadeState!.payload.gc).toBe(1);
    expect(grenadeState!.payload.gts).toBe('overhand');
  });
});

describe('Phase 9 — Tactical PDA Click+Drag Grab-Sheet Pan, Zero-Snap GPS Unlock & Physical Thumb-on-Joystick', () => {
  const makeTelemetry = (playerX = 25, playerZ = -20): PdaHudTelemetry => ({
    playerX,
    playerZ,
    playerYawRad: 0.35,
    gameClockText: '14:22',
    weatherLabel: 'CLEAR',
    windSpeedMps: 3.4,
    windAngleRad: 0.5,
    modeLabel: 'BATTLE',
    zoneLabel: 'TIMBERLINE',
    allies: [],
    pings: [],
  });

  const advanceToActive = (pda: TacticalPdaDevice, tel: PdaHudTelemetry): void => {
    pda.setTelemetry(tel);
    pda.setOpen(true);
    let elapsed = 0;
    for (let i = 0; i < 65; i++) {
      elapsed += 1 / 60;
      pda.update(1 / 60, elapsed, 0, false);
    }
    expect(pda.getPhase()).toBe('ACTIVE');
  };

  const placeObjectWorldTransform = (
    obj: THREE.Object3D,
    worldPos: THREE.Vector3,
    worldQuat: THREE.Quaternion,
  ): void => {
    const parent = obj.parent!;
    parent.updateMatrixWorld(true);
    const invParentMat = parent.matrixWorld.clone().invert();
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    obj.position.copy(worldPos).applyMatrix4(invParentMat);
    obj.quaternion.copy(parentWorldQuat).invert().multiply(worldQuat);
    obj.updateMatrixWorld(true);
  };

  it('enforces drag-gated grab-sheet 1:1 panning, zero-snap unlock from off-center player UV, zoom & recenter', () => {
    const pda = new TacticalPdaDevice();
    // Default mapAspectBounds is [-48, 48] x [-48, 48], so (24, -19.2) maps to UV (0.75, 0.30)
    const tel = makeTelemetry(24, -19.2);
    advanceToActive(pda, tel);

    expect(pda.isCenteredOnPlayer()).toBe(true);
    const startUV = pda.getPanCenterUV();
    expect(startUV.u).toBeCloseTo(0.75, 4);
    expect(startUV.v).toBeCloseTo(0.30, 4);

    // Free mouse look (dragging = false) must NOT pan map or break GPS lock
    pda.applyMouseDelta(120, 80);
    pda.applyDragDelta(-90, 60);
    expect(pda.isCenteredOnPlayer()).toBe(true);
    expect(pda.getPanCenterUV().u).toBeCloseTo(0.75, 4);
    expect(pda.getPanCenterUV().v).toBeCloseTo(0.30, 4);
    expect(pda.getThumbIntent()).toEqual({ x: 0, y: 0 });

    // Hold LMB (setDragging(true)) and drag DOWN (dy > 0) -> grab-sheet pulls north (-V) into view
    // with ZERO snap to map center (0.5, 0.5)
    pda.setDragging(true);
    expect(pda.isDragging()).toBe(true);
    pda.applyDragDelta(0, 20);
    expect(pda.isCenteredOnPlayer()).toBe(false);
    const afterDown = pda.getPanCenterUV();
    expect(afterDown.u).toBeCloseTo(0.75, 4);
    expect(afterDown.v).toBeLessThan(0.30);
    expect(afterDown.v).toBeGreaterThan(0.24); // started from 0.30, NOT snapped to 0.5
    expect(pda.getThumbIntent().y).toBeLessThan(-0.2);

    // Drag RIGHT (dx > 0) -> grab-sheet pulls west (-U) into view and pushes thumb right (+X)
    pda.applyDragDelta(25, 0);
    const afterRight = pda.getPanCenterUV();
    expect(afterRight.u).toBeLessThan(afterDown.u);
    expect(afterRight.u).toBeGreaterThan(0.68);
    expect(pda.getThumbIntent().x).toBeGreaterThan(0.2);

    // Wheel zoom in & out
    const zoom0 = pda.getMapZoom();
    pda.applyWheel(-120);
    expect(pda.getMapZoom()).toBeGreaterThan(zoom0);
    const zoomedIn = pda.getMapZoom();
    pda.applyWheel(240);
    expect(pda.getMapZoom()).toBeLessThan(zoomedIn);

    // Releasing LMB + updating smoothly recenters thumbIntent while keeping free-pan position
    pda.setDragging(false);
    expect(pda.isDragging()).toBe(false);
    let elapsed = 2.0;
    for (let i = 0; i < 45; i++) {
      elapsed += 1 / 60;
      pda.update(1 / 60, elapsed, 0, false);
    }
    expect(Math.hypot(pda.getThumbIntent().x, pda.getThumbIntent().y)).toBeLessThan(0.02);
    expect(pda.isCenteredOnPlayer()).toBe(false);

    // R / RMB recenter restores GPS lock onto live player UV
    pda.recenterOnPlayer();
    expect(pda.isCenteredOnPlayer()).toBe(true);
    expect(pda.getPanCenterUV().u).toBeCloseTo(0.75, 4);
    expect(pda.getPanCenterUV().v).toBeCloseTo(0.30, 4);

    // Stowing clears active drag cleanly and can be smoothly reversed mid-stow
    pda.setDragging(true);
    pda.setOpen(false);
    expect(pda.isDragging()).toBe(false);
    for (let i = 0; i < 10; i++) {
      elapsed += 1 / 60;
      pda.update(1 / 60, elapsed, 0, false);
    }
    pda.setOpen(true);
    expect(pda.isOpen()).toBe(true);

    pda.dispose();
  });

  it('places the articulated right thumbtip directly onto the 3D joystick cap and drives gimbal tilt for both MALE and FEMALE rigs', () => {
    for (const opId of ['MALE', 'FEMALE'] as const) {
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.02, 100);
      camera.position.set(1.5, 1.65, -2.0);
      camera.rotation.set(-0.18, 0.95, 0, 'YXZ'); // arbitrary non-North heading + pitch
      camera.updateMatrixWorld(true);

      const pda = new TacticalPdaDevice();
      camera.add(pda.root);
      scene.add(camera);

      const tel = makeTelemetry(12, 8);
      advanceToActive(pda, tel);
      scene.updateMatrixWorld(true);

      const skel = new CharacterSkeleton(1, 'team_a', opId);
      scene.add(skel.root);

      const gripPos = new THREE.Vector3();
      const gripQuat = new THREE.Quaternion();
      const thumbTarget = new THREE.Vector3();
      const thumbTip = new THREE.Vector3();

      // Mount right hand at the exact PDA right grip world transform
      pda.getRightGripWorldTransform(gripPos, gripQuat);
      placeObjectWorldTransform(skel.rightArm.hand.root, gripPos, gripQuat);

      // 1. Neutral rest: right thumbtip rests squarely on center of 3D joystick cap (< 4mm)
      //    with a gentle, organic interphalangeal curve (no sharp 90° mechanical kink)
      pda.getRightThumbWorldTarget(thumbTarget);
      skel.applyPdaHandPose('right', 0, 0, 0, thumbTarget);
      skel.root.updateMatrixWorld(true);
      skel.getRightThumbTipWorldPosition(thumbTip);
      expect(thumbTip.distanceTo(thumbTarget)).toBeLessThan(0.004);
      expect(Math.abs(skel.rightArm.hand.thumbDist.rotation.x)).toBeLessThan(1.15);

      for (let i = 0; i < 20; i++) {
        pda.driveJoystickFromThumbWorldPos(thumbTip, 1 / 60, 1.0);
      }
      expect(Math.abs(pda.getJoystickTilt().x)).toBeLessThan(0.08);
      expect(Math.abs(pda.getJoystickTilt().y)).toBeLessThan(0.08);

      // 2. LMB + Drag right & down: thumb moves with drag and physically drives joystick gimbal
      pda.setDragging(true);
      let elapsed = 2.0;
      for (let i = 0; i < 12; i++) {
        elapsed += 1 / 60;
        pda.applyDragDelta(16, 12); // dx > 0 (+X), dy > 0 (-Y)
        pda.update(1 / 60, elapsed, 0, false);
        scene.updateMatrixWorld(true);

        pda.getRightGripWorldTransform(gripPos, gripQuat);
        placeObjectWorldTransform(skel.rightArm.hand.root, gripPos, gripQuat);

        const intent = pda.getThumbIntent();
        pda.getRightThumbWorldTarget(thumbTarget);
        skel.applyPdaHandPose('right', 0, intent.x, intent.y, thumbTarget);
        skel.root.updateMatrixWorld(true);
        skel.getRightThumbTipWorldPosition(thumbTip);
        expect(thumbTip.distanceTo(thumbTarget)).toBeLessThan(0.004);

        pda.driveJoystickFromThumbWorldPos(thumbTip, 1 / 60, 1.0);
      }

      const deflected = pda.getJoystickTilt();
      expect(deflected.x).toBeGreaterThan(0.35);
      expect(deflected.y).toBeLessThan(-0.25);

      // 3. Releasing drag smoothly recenters thumb and joystick gimbal to neutral
      pda.setDragging(false);
      for (let i = 0; i < 45; i++) {
        elapsed += 1 / 60;
        pda.update(1 / 60, elapsed, 0, false);
        scene.updateMatrixWorld(true);

        pda.getRightGripWorldTransform(gripPos, gripQuat);
        placeObjectWorldTransform(skel.rightArm.hand.root, gripPos, gripQuat);

        const intent = pda.getThumbIntent();
        pda.getRightThumbWorldTarget(thumbTarget);
        skel.applyPdaHandPose('right', 0, intent.x, intent.y, thumbTarget);
        skel.root.updateMatrixWorld(true);
        skel.getRightThumbTipWorldPosition(thumbTip);
        pda.driveJoystickFromThumbWorldPos(thumbTip, 1 / 60, 1.0);
      }
      expect(Math.abs(pda.getJoystickTilt().x)).toBeLessThan(0.08);
      expect(Math.abs(pda.getJoystickTilt().y)).toBeLessThan(0.08);

      skel.dispose();
      pda.dispose();
    }
  });
});

describe('Phase 10 — Anatomical Top-Side Shoulder Origin & Unarmed Side-Rest / Athletic Sprint / Guard-Sprint', () => {
  it('seats shoulder pivots high and laterally outside the front chest plate on MALE, FEMALE, and Survival rigs', () => {
    for (const opId of ['MALE', 'FEMALE'] as const) {
      const skel = new CharacterSkeleton(1, 'team_a', opId);
      skel.root.updateMatrixWorld(true);

      const invChest = skel.chest.matrixWorld.clone().invert();
      const shL = new THREE.Vector3();
      const shR = new THREE.Vector3();
      skel.leftArm.shoulderPivot.getWorldPosition(shL).applyMatrix4(invChest);
      skel.rightArm.shoulderPivot.getWorldPosition(shR).applyMatrix4(invChest);

      // Shoulders must sit high at the top torso ridge (>= 0.085m in chest local Y),
      // wide outside the SAPI carrier (|X| >= 0.18m), and rearward in the coronal plane (Z > 0.015m)
      expect(shL.y).toBeGreaterThanOrEqual(0.085);
      expect(shR.y).toBeGreaterThanOrEqual(0.085);
      expect(Math.abs(shL.x)).toBeGreaterThanOrEqual(0.18);
      expect(Math.abs(shR.x)).toBeGreaterThanOrEqual(0.18);
      expect(shL.z).toBeGreaterThan(0.015);
      expect(shR.z).toBeGreaterThan(0.015);

      expect(validateOperatorRig(skel.root, opId, 'STRICT').valid).toBe(true);
      skel.dispose();
    }

    // Survival skeleton parity check
    const survSkel = new SurvivalCharacterSkeleton();
    survSkel.root.updateMatrixWorld(true);
    const invSurvChest = survSkel.chest.matrixWorld.clone().invert();
    const survShR = new THREE.Vector3();
    survSkel.rightArm.shoulderPivot.getWorldPosition(survShR).applyMatrix4(invSurvChest);
    expect(survShR.y).toBeGreaterThanOrEqual(0.085);
    expect(survShR.x).toBeGreaterThanOrEqual(0.18);
    expect(survShR.z).toBeGreaterThan(0.015);
    survSkel.dispose();
  });

  it('rests unarmed arms at the sides even when looking straight down (-70°), pumps athletically on sprint, and preserves guard-sprint in SDK & Survival', () => {
    // 1. Bodycam SDK CharacterAnimator
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.02, 100);
    const world = new BodycamPhysicsWorld();
    const adapter = world.createAdapter();
    const skel = new CharacterSkeleton(1, 'team_a', 'MALE');
    const weaponRig = new WeaponRig(scene, true);
    const noopAudio = new Proxy(
      {},
      { get: () => () => {} },
    ) as unknown as ConstructorParameters<typeof BodycamController>[2];
    const controller = new BodycamController(camera, weaponRig, noopAudio);
    const animator = new CharacterAnimator(skel, weaponRig);
    scene.add(skel.root);

    const unarmedProf = SDK_WEAPON_PROFILES.unarmed;
    weaponRig.setWeaponProfile(unarmedProf);

    const inputBase = {
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
      adsMode: 'PRIMARY' as const,
      holdBreath: false,
      vault: false,
    };

    // Pitch steeply downward (-70 deg) while unarmed idle
    controller.torsoPitch = -1.22;
    let elapsed = 0;
    for (let i = 0; i < 40; i++) {
      elapsed += 1 / 60;
      controller.update(1 / 60, elapsed, inputBase, adapter, unarmedProf, DEFAULT_BODYCAM_SDK_CONFIG);
      controller.torsoPitch = -1.22;
      weaponRig.updateRig(
        1 / 60,
        elapsed,
        unarmedProf,
        0,
        0,
        false,
        false,
        false,
        false,
        0,
        0,
        0,
        camera.position,
        camera.quaternion,
        adapter,
        DEFAULT_BODYCAM_SDK_CONFIG,
      );
      animator.update(1 / 60, elapsed, controller, adapter, unarmedProf, false);
    }

    const shR = new THREE.Vector3();
    const handR = new THREE.Vector3();
    skel.rightArm.shoulderPivot.getWorldPosition(shR);
    skel.rightArm.hand.root.getWorldPosition(handR);
    skel.root.worldToLocal(shR);
    skel.root.worldToLocal(handR);

    // Side-rest invariant: hand hangs cleanly down beside the hip/thigh (y ~0.48..0.58m below shoulder,
    // z stays close to shoulder coronal plane instead of floating 35cm out in front!)
    expect(shR.y - handR.y).toBeGreaterThan(0.45);
    expect(Math.abs(handR.z - shR.z)).toBeLessThan(0.12);
    expect(handR.x).toBeGreaterThan(shR.x);

    // Non-guard unarmed sprint -> athletic pumping arm pose (hand rises & drives forward/back dynamically)
    const sprintInput = { ...inputBase, forward: true, sprint: true };
    let maxSprintForward = 0;
    let minSprintDrop = Infinity;
    for (let i = 0; i < 55; i++) {
      elapsed += 1 / 60;
      controller.update(1 / 60, elapsed, sprintInput, adapter, unarmedProf, DEFAULT_BODYCAM_SDK_CONFIG);
      weaponRig.updateRig(
        1 / 60,
        elapsed,
        unarmedProf,
        1.0,
        (elapsed * 2.1) % 1,
        false,
        false,
        true,
        true,
        0,
        0,
        0,
        camera.position,
        camera.quaternion,
        adapter,
        DEFAULT_BODYCAM_SDK_CONFIG,
      );
      animator.update(1 / 60, elapsed, controller, adapter, unarmedProf, false);
      skel.rightArm.shoulderPivot.getWorldPosition(shR);
      skel.rightArm.hand.root.getWorldPosition(handR);
      skel.root.worldToLocal(shR);
      skel.root.worldToLocal(handR);
      maxSprintForward = Math.max(maxSprintForward, shR.z - handR.z);
      minSprintDrop = Math.min(minSprintDrop, shR.y - handR.y);
    }
    expect(maxSprintForward).toBeGreaterThan(0.18);
    expect(minSprintDrop).toBeLessThan(0.40);

    // Guard-Sprint (Right-Click held + Sprint) -> raises fists cleanly into boxing guard
    const guardSprintInput = { ...sprintInput, ads: true };
    for (let i = 0; i < 30; i++) {
      elapsed += 1 / 60;
      controller.update(1 / 60, elapsed, guardSprintInput, adapter, unarmedProf, DEFAULT_BODYCAM_SDK_CONFIG);
      weaponRig.updateRig(
        1 / 60,
        elapsed,
        unarmedProf,
        1.0,
        (elapsed * 2.1) % 1,
        true,
        false,
        true,
        true,
        0,
        0,
        0,
        camera.position,
        camera.quaternion,
        adapter,
        DEFAULT_BODYCAM_SDK_CONFIG,
      );
      animator.update(1 / 60, elapsed, controller, adapter, unarmedProf, true);
    }
    expect(animator.getUnarmedGuardBlend()).toBeGreaterThan(0.85);
    skel.rightArm.shoulderPivot.getWorldPosition(shR);
    skel.rightArm.hand.root.getWorldPosition(handR);
    skel.root.worldToLocal(shR);
    skel.root.worldToLocal(handR);
    expect(shR.y - handR.y).toBeLessThan(0.20); // raised up in boxing guard

    skel.dispose();
    weaponRig.dispose();

    // 2. Survival CharacterAnimator parity: side-rest on look-down + guard-sprint preserved
    const survScene = new THREE.Scene();
    const survSkel = new SurvivalCharacterSkeleton(1);
    const survRig = new SurvivalWeaponRig(survScene, true);
    const survAnim = new SurvivalCharacterAnimator(survSkel, survRig);
    survScene.add(survSkel.root);

    const makeSurvState = (overrides: Partial<CharacterDriverState> = {}): CharacterDriverState => ({
      position: new THREE.Vector3(0, 0, 0),
      torsoYaw: 0,
      torsoPitch: -1.22,
      spinePitch: -1.22,
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
      wallPullback: 0,
      recoilSpring: { z: 0, pitch: 0, roll: 0 },
      chestHeight: 1.4,
      cameraWorldPos: new THREE.Vector3(0, 1.42, 0),
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
      ...overrides,
    });

    const survUnarmed = WEAPONS.unarmed;
    let sTime = 0;
    for (let i = 0; i < 30; i++) {
      sTime += 1 / 60;
      survAnim.update(1 / 60, sTime, makeSurvState(), survUnarmed, () => 0, undefined, adapter, undefined, false);
    }
    survSkel.rightArm.shoulderPivot.getWorldPosition(shR);
    survSkel.rightArm.hand.root.getWorldPosition(handR);
    survSkel.root.worldToLocal(shR);
    survSkel.root.worldToLocal(handR);
    expect(shR.y - handR.y).toBeGreaterThan(0.45);
    expect(Math.abs(handR.z - shR.z)).toBeLessThan(0.12);

    // Guard-sprint in Survival preserves raised fists
    for (let i = 0; i < 30; i++) {
      sTime += 1 / 60;
      survAnim.update(
        1 / 60,
        sTime,
        makeSurvState({ torsoPitch: 0, spinePitch: 0, isMoving: true, sprint: true, isAds: true, stridePhase: (sTime * 2) % 1 }),
        survUnarmed,
        () => 0,
        undefined,
        adapter,
        undefined,
        true,
      );
    }
    expect(survAnim.getUnarmedGuardBlend()).toBeGreaterThan(0.85);
    survRig.dispose();
    survSkel.dispose();
  });
});

describe('Phase 11 — Coupled Tactical PDA Locomotion Sway, Sprint Pump, Inertia & Zero-Slip Hand Lock', () => {
  it('drives PDA from live gait bob, sprint drop/pump, turn lag, strafe roll & lean tilt while keeping both hands welded (<2mm slip)', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 100);
    scene.add(camera);

    const physics = new BodycamPhysicsWorld();
    const adapter = physics.createAdapter();
    const weaponRig = new WeaponRig(scene, true);
    const noopAudio = new Proxy(
      {},
      { get: () => () => {} },
    ) as unknown as ConstructorParameters<typeof BodycamController>[2];
    const controller = new BodycamController(camera, weaponRig, noopAudio);
    const skel = new CharacterSkeleton(1);
    const animator = new CharacterAnimator(skel, weaponRig);
    const pda = new TacticalPdaDevice();
    camera.add(pda.root);
    scene.add(skel.root);
    animator.setPdaDevice(pda);

    const prof = SDK_WEAPON_PROFILES.m4a1;
    weaponRig.setWeaponProfile(prof);
    const motion = createPdaMotionState();

    const baseInput = {
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
      adsMode: 'PRIMARY' as const,
      holdBreath: false,
      vault: false,
    };

    const stepFrame = (
      elapsed: number,
      input: typeof baseInput,
      mouseDx = 0,
      mouseDy = 0,
    ): void => {
      if (mouseDx !== 0 || mouseDy !== 0) {
        controller.handleMouseMove(mouseDx, mouseDy, DEFAULT_BODYCAM_SDK_CONFIG);
      }
      controller.update(1 / 60, elapsed, input, adapter, prof, DEFAULT_BODYCAM_SDK_CONFIG);
      camera.updateMatrixWorld(true);
      controller.writePdaMotionState(motion);
      pda.update(1 / 60, elapsed, motion.moveRatio, motion.isCrouched, motion);
      animator.update(1 / 60, elapsed, controller, adapter, prof, false);
    };

    // 1. Open PDA and settle into ACTIVE idle hold
    pda.setOpen(true);
    let elapsed = 0;
    for (let i = 0; i < 65; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, baseInput);
    }
    expect(pda.getPhase()).toBe('ACTIVE');
    const chassis = pda.root.children[0];
    const idleY = chassis.position.y;

    // 2. Walking forward -> grounded figure-8 bob + <2mm hand-to-PDA lock on both hands
    const walkInput = { ...baseInput, forward: true };
    let walkMinX = Infinity;
    let walkMaxX = -Infinity;
    let walkMinY = Infinity;
    let walkMaxY = -Infinity;
    let maxWalkHandSlip = 0;
    const handPos = new THREE.Vector3();
    const sockPos = new THREE.Vector3();
    const sockQuat = new THREE.Quaternion();

    for (let i = 0; i < 80; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, walkInput);
      walkMinX = Math.min(walkMinX, chassis.position.x);
      walkMaxX = Math.max(walkMaxX, chassis.position.x);
      walkMinY = Math.min(walkMinY, chassis.position.y);
      walkMaxY = Math.max(walkMaxY, chassis.position.y);

      skel.rightArm.hand.root.getWorldPosition(handPos);
      pda.getRightGripWorldTransform(sockPos, sockQuat);
      maxWalkHandSlip = Math.max(maxWalkHandSlip, handPos.distanceTo(sockPos));

      skel.leftArm.hand.root.getWorldPosition(handPos);
      pda.getLeftGripWorldTransform(sockPos, sockQuat);
      maxWalkHandSlip = Math.max(maxWalkHandSlip, handPos.distanceTo(sockPos));
    }
    const walkSpanX = walkMaxX - walkMinX;
    const walkSpanY = walkMaxY - walkMinY;
    expect(walkSpanX).toBeGreaterThan(0.010);
    expect(walkSpanY).toBeGreaterThan(0.005);
    expect(maxWalkHandSlip).toBeLessThan(0.002);

    // 3. Sprinting -> lowers PDA smoothly and drives larger rhythmic stride pump while keeping screen active
    const sprintInput = { ...baseInput, forward: true, sprint: true };
    let sprintMinX = Infinity;
    let sprintMaxX = -Infinity;
    let sprintAvgY = 0;
    let sprintSamples = 0;
    let maxSprintHandSlip = 0;
    for (let i = 0; i < 90; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, sprintInput);
      if (i >= 30) {
        sprintMinX = Math.min(sprintMinX, chassis.position.x);
        sprintMaxX = Math.max(sprintMaxX, chassis.position.x);
        sprintAvgY += chassis.position.y;
        sprintSamples += 1;

        skel.rightArm.hand.root.getWorldPosition(handPos);
        pda.getRightGripWorldTransform(sockPos, sockQuat);
        maxSprintHandSlip = Math.max(maxSprintHandSlip, handPos.distanceTo(sockPos));

        skel.leftArm.hand.root.getWorldPosition(handPos);
        pda.getLeftGripWorldTransform(sockPos, sockQuat);
        maxSprintHandSlip = Math.max(maxSprintHandSlip, handPos.distanceTo(sockPos));
      }
    }
    sprintAvgY /= Math.max(1, sprintSamples);
    expect(pda.getPhase()).toBe('ACTIVE');
    expect(idleY - sprintAvgY).toBeGreaterThan(0.035); // lowered noticeably during sprint
    expect(sprintMaxX - sprintMinX).toBeGreaterThan(walkSpanX * 1.6); // stronger stride pump
    expect(maxSprintHandSlip).toBeLessThan(0.002); // zero slip even during sprint pump!

    // 4a. Pure camera turn -> physical yaw/pitch/roll inertia lag + leftward lag shift (no strafe cancellation)
    for (let i = 0; i < 35; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, baseInput);
    }
    const neutralPosX = chassis.position.x;
    const neutralRotZ = chassis.rotation.z;
    const neutralRotY = chassis.rotation.y;

    let peakTurnYawDelta = 0;
    let minTurnPosX = Infinity;
    let maxTurnHandSlip = 0;
    for (let i = 0; i < 18; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, baseInput, 28, -8);
      peakTurnYawDelta = Math.max(peakTurnYawDelta, Math.abs(chassis.rotation.y - neutralRotY));
      minTurnPosX = Math.min(minTurnPosX, chassis.position.x);

      skel.rightArm.hand.root.getWorldPosition(handPos);
      pda.getRightGripWorldTransform(sockPos, sockQuat);
      maxTurnHandSlip = Math.max(maxTurnHandSlip, handPos.distanceTo(sockPos));

      skel.leftArm.hand.root.getWorldPosition(handPos);
      pda.getLeftGripWorldTransform(sockPos, sockQuat);
      maxTurnHandSlip = Math.max(maxTurnHandSlip, handPos.distanceTo(sockPos));
    }
    expect(peakTurnYawDelta).toBeGreaterThan(0.020); // crisp grounded yaw inertia lag
    expect(neutralPosX - minTurnPosX).toBeGreaterThan(0.004); // tablet lags left on rightward turn
    expect(maxTurnHandSlip).toBeLessThan(0.002); // hands stay rigidly locked through turns!

    // 4b. Strafe right + Lean right -> harmonious bank roll & tilt with zero hand slip
    const strafeLean = { ...baseInput, right: true, leanRight: true };
    let peakLeanStrafeRollDelta = 0;
    for (let i = 0; i < 30; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, strafeLean);
      peakLeanStrafeRollDelta = Math.max(
        peakLeanStrafeRollDelta,
        Math.abs(chassis.rotation.z - neutralRotZ),
      );

      skel.rightArm.hand.root.getWorldPosition(handPos);
      pda.getRightGripWorldTransform(sockPos, sockQuat);
      maxTurnHandSlip = Math.max(maxTurnHandSlip, handPos.distanceTo(sockPos));

      skel.leftArm.hand.root.getWorldPosition(handPos);
      pda.getLeftGripWorldTransform(sockPos, sockQuat);
      maxTurnHandSlip = Math.max(maxTurnHandSlip, handPos.distanceTo(sockPos));
    }
    expect(peakLeanStrafeRollDelta).toBeGreaterThan(0.055);
    expect(maxTurnHandSlip).toBeLessThan(0.002);

    // Right thumbtip still physically seated on the 3D joystick cap
    const thumbTip = new THREE.Vector3();
    const joyTarget = new THREE.Vector3();
    skel.getRightThumbTipWorldPosition(thumbTip);
    pda.getRightThumbWorldTarget(joyTarget);
    expect(thumbTip.distanceTo(joyTarget)).toBeLessThan(0.004);

    // Settling back to idle decays turn/strafe/lean tilt cleanly back toward neutral
    for (let i = 0; i < 60; i++) {
      elapsed += 1 / 60;
      stepFrame(elapsed, baseInput);
    }
    expect(Math.abs(chassis.rotation.z - neutralRotZ)).toBeLessThan(0.015);
    expect(Math.abs(chassis.rotation.y - neutralRotY)).toBeLessThan(0.015);

    pda.dispose();
    skel.dispose();
    weaponRig.dispose();
  });
});

describe('Phase 12 — Anatomical Faces, 15 Morph Targets, Eyeball Gaze LOD, Starter Shotgun & Frustum Z-Fighting Audits', () => {
  it('places Remington 870 Pump Shotgun #1 in Shotguns and unlocks it at Rank 1 across Progression and Open World factions', () => {
    const shotguns = getWeaponsByCategory('shotguns');
    expect(shotguns.length).toBeGreaterThanOrEqual(2);
    expect(shotguns[0].id).toBe('remington_870');
    expect(shotguns[1].id).toBe('mossberg_590a1');
    expect(WEAPON_UNLOCK_RANK.remington_870).toBe(1);
    expect(PMC_FACTIONS.pmc_alpha.starterWeaponIds).toContain('remington_870');
    expect(PMC_FACTIONS.pmc_bravo.starterWeaponIds).toContain('remington_870');
    expect(PMC_FACTIONS.pmc_alpha.starterUnlockedWeaponIds).toContain('remington_870');
    expect(PMC_FACTIONS.pmc_bravo.starterUnlockedWeaponIds).toContain('remington_870');
  });

  it('builds 15 morph targets and eye_l/eye_r pivots on CharacterSkeleton, TacticalOperatorRig, and InfectedZombieRig with strict parity & FPS masking', () => {
    for (const opId of ['MALE', 'FEMALE'] as const) {
      const skel = new CharacterSkeleton(1, 'infection', opId, true);
      const asm = skel.getHeadAssembly()!;
      expect(asm).not.toBeNull();
      expect(asm.eyeL.name).toBe('eye_l');
      expect(asm.eyeR.name).toBe('eye_r');
      const dict = asm.headMesh.morphTargetDictionary!;
      expect(dict).toBeDefined();
      for (const morphName of FACIAL_MORPH_TARGET_NAMES) {
        expect(typeof dict[morphName]).toBe('number');
      }
      expect(asm.headMesh.morphTargetInfluences?.length).toBe(FACIAL_MORPH_TARGET_NAMES.length);

      // Hot-swapping faceGear & eyewear preserves unit head scale & STRICT parity
      skel.applyGearConfig({ faceGear: 'open_face', eyewear: 'clear_glasses' });
      expect(asm.faceGearGroups.neckGaiter.visible).toBe(false);
      expect(asm.faceGearGroups.balaclava.visible).toBe(false);
      expect(asm.eyewearGroups.clearGlasses.visible).toBe(true);
      expect(validateOperatorRig(skel.root, opId, 'STRICT').valid).toBe(true);

      // First-person shadow-only hides all head meshes cleanly (no eye/teeth/mask/glass leak)
      skel.setFirstPersonHeadShadowOnly(true);
      asm.root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mat = (obj as THREE.Mesh).material as THREE.Material;
          expect(mat.colorWrite).toBe(false);
          expect(mat.depthWrite).toBe(false);
        }
      });
      skel.setFirstPersonHeadShadowOnly(false);
      expect((asm.headMesh.material as THREE.MeshStandardMaterial).depthWrite).toBe(true);
      expect((asm.headMesh.material as THREE.MeshStandardMaterial).colorWrite).toBe(true);
      skel.dispose();
    }

    // TacticalOperatorRig 3P face assembly + zero-GC combat pose facial expression drive
    const opFactory = new TacticalOperatorRigFactory(1);
    const rig = opFactory.buildOperator('bot', 'op_face_test', 'team_a', 'MALE');
    const rigHead = rig.headGroup.getObjectByName('anatomical_head_mesh') as THREE.Mesh;
    expect(rigHead).toBeDefined();
    expect(rigHead).toBe(rig.headAssembly.headMesh);
    for (const morphName of FACIAL_MORPH_TARGET_NAMES) {
      expect(typeof rigHead.morphTargetDictionary?.[morphName]).toBe('number');
    }
    expect(rig.headGroup.getObjectByName('eye_l')).toBeDefined();
    expect(rig.headGroup.getObjectByName('eye_r')).toBeDefined();
    opFactory.dispose();

    // InfectedZombieRig shares 15 morph targets & eye pivots with zero MeshBasicMaterial
    const zLib = new InfectedZombieRigLibrary();
    const zRig = zLib.buildZombie('z_face_test', 'quarantine_guard');
    const zFace = zRig.headGroup.getObjectByName('anatomical_face_mesh') ?? zRig.headGroup.getObjectByName('anatomical_head_mesh');
    const zFaceMesh = zFace as THREE.Mesh;
    expect(zFaceMesh).toBeDefined();
    for (const morphName of FACIAL_MORPH_TARGET_NAMES) {
      expect(typeof zFaceMesh.morphTargetDictionary?.[morphName]).toBe('number');
    }
    expect(zRig.headGroup.getObjectByName('eye_l')).toBeDefined();
    expect(zRig.headGroup.getObjectByName('eye_r')).toBeDefined();
    expect(zRig.jawPivot.parent).toBe(zRig.headGroup);
    let basicCount = 0;
    zRig.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mats = Array.isArray((obj as THREE.Mesh).material)
          ? ((obj as THREE.Mesh).material as THREE.Material[])
          : [(obj as THREE.Mesh).material];
        for (const m of mats) {
          if ((m as THREE.Material).type === 'MeshBasicMaterial') basicCount += 1;
        }
      }
    });
    expect(basicCount).toBe(0);
    zLib.dispose();
  });

  it('clamps eyeball gaze yaw/pitch, enforces finite morph weights, and respects 25m/35m LOD culling', () => {
    const skel = new CharacterSkeleton(1, 'infection', 'FEMALE', true);
    const asm = skel.getHeadAssembly()!;
    const ctrl = new FacialExpressionController(7);
    const influences = asm.headMesh.morphTargetInfluences!;

    // Extreme gaze target off to the side/up -> eyeball pivots must remain anatomically clamped
    const extremeTarget = new THREE.Vector3(25, 18, -2);
    for (let i = 0; i < 40; i++) {
      ctrl.step(
        1 / 60,
        {
          mode: 'human',
          intent: 'suppressed',
          stress01: 0.9,
          injury01: 0.4,
          flinchImpulse01: i === 5 ? 1.0 : 0,
          gazeTargetWorld: extremeTarget,
          distanceToCameraM: 4,
          isVisible: true,
        },
        asm.root,
        influences,
        asm.eyeL,
        asm.eyeR,
      );
    }

    expect(Math.abs(asm.eyeL.rotation.y)).toBeLessThanOrEqual(0.481);
    expect(Math.abs(asm.eyeL.rotation.x)).toBeLessThanOrEqual(0.301);
    expect(Math.abs(asm.eyeR.rotation.y)).toBeLessThanOrEqual(0.481);
    for (const w of influences) {
      expect(Number.isFinite(w)).toBe(true);
      expect(Number.isNaN(w)).toBe(false);
    }
    expect(ctrl.getCurrentWeight('brow_furrow_down')).toBeGreaterThan(0.05);

    // Distance > 35m freezes morph updates cleanly
    const frozenSnapshot = influences.slice();
    for (let i = 0; i < 30; i++) {
      ctrl.step(
        1 / 60,
        {
          mode: 'human',
          intent: 'calm',
          stress01: 0,
          injury01: 0,
          flinchImpulse01: 0,
          distanceToCameraM: 42,
          isVisible: true,
        },
        asm.root,
        influences,
        asm.eyeL,
        asm.eyeR,
      );
    }
    expect(influences).toEqual(frozenSnapshot);
    skel.dispose();
  });

  it('persists and sanitizes faceGear and eyewear across Locker config and multiplayer packets', () => {
    const defaults = normalizeOperatorGearConfig(undefined);
    expect(defaults.faceGear).toBe('neck_gaiter');
    expect(defaults.eyewear).toBe('none');

    const normalized = normalizeOperatorGearConfig({
      faceGear: 'open_face',
      eyewear: 'clear_glasses',
    });
    expect(normalized.faceGear).toBe('open_face');
    expect(normalized.eyewear).toBe('clear_glasses');

    const corrupted = normalizeOperatorGearConfig({
      faceGear: 'bogus_mask' as unknown as 'neck_gaiter',
      eyewear: 'laser_eyes' as unknown as 'none',
    });
    expect(corrupted.faceGear).toBe('neck_gaiter');
    expect(corrupted.eyewear).toBe('none');

    const roomState: LobbyRoomState = {
      code: 'TST002',
      hostUserId: 'host_1',
      hostUsername: 'HOST',
      visibility: 'private',
      mode: 'battle',
      battleRule: 'tdm',
      mapId: 'timberline_compound',
      maxPlayers: 8,
      botsEnabled: true,
      botCount: 4,
      killLimit: 30,
      botDifficulty: 'tactical',
      status: 'in_match',
      matchSequence: 1,
      specialEvent: null,
      members: [
        {
          userId: 'host_1',
          username: 'HOST',
          team: 'A',
          ready: true,
          isHost: true,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
        {
          userId: 'peer_2',
          username: 'PEER',
          team: 'B',
          ready: true,
          isHost: false,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
      ],
      chat: [],
      updatedAt: Date.now(),
    };
    const matchState = createDefaultMatchState();
    const validState = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        weaponId: 'remington_870',
        hp: 100,
        maxHp: 100,
        alive: true,
        faceGear: 'balaclava',
        eyewear: 'tinted_visor',
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(validState).toBeTruthy();
    expect(validState!.payload.faceGear).toBe('balaclava');
    expect(validState!.payload.eyewear).toBe('tinted_visor');
  });

  it('enforces tightened PerspectiveCamera near planes (>= 0.08m interior/combat) and separated preview pedestal geometry', () => {
    const camFiles = [
      'arena/CadGunsmithStage.ts',
      'arena/BallisticsSimViewport.ts',
      'engine/GameEngine.ts',
      'hideout/ZombiesLobbyController.ts',
      'hideout/HideoutSessionController.ts',
      'gym/GymEngine.ts',
      'bodycam-sdk/weapons/ScopeRenderer.ts',
      'combat/CombatSessionEngine.ts',
      'ui/OperatorPreviewStage.ts',
    ];
    const camRegex = /new THREE\.PerspectiveCamera\(\s*[\s\S]*?,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,?\s*\)/g;
    for (const rel of camFiles) {
      const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
      const matches = [...src.matchAll(camRegex)];
      expect(matches.length, `expected PerspectiveCamera in ${rel}`).toBeGreaterThan(0);
      for (const m of matches) {
        const near = Number(m[1]);
        const far = Number(m[2]);
        expect(near, `${rel} camera near`).toBeGreaterThanOrEqual(0.08);
        expect(far / near, `${rel} far/near ratio`).toBeLessThanOrEqual(16000);
      }
    }

    // OperatorPreviewStage turntable pedestal vertical clearance
    const previewSrc = readFileSync(resolve(process.cwd(), 'ui/OperatorPreviewStage.ts'), 'utf8');
    expect(previewSrc).toContain('plinth.position.y = -0.0325');
    expect(previewSrc).toContain('deck.position.y = -0.005');
    expect(previewSrc).toContain('ring.position.y = 0.003');
  });

  it('supports No Helmet (none) across locker config, 1P/3P rigs, IR strobe gating, and multiplayer sanitization', () => {
    expect(HELMET_TYPE_LIST.some((h) => h.id === 'none')).toBe(true);

    const noHelmetGear = normalizeOperatorGearConfig({
      helmetType: 'none',
      nvgMount: 'arnvg',
      faceGear: 'open_face',
      eyewear: 'tinted_visor',
    });
    expect(noHelmetGear.helmetType).toBe('none');
    expect(noHelmetGear.nvgMount).toBe('none');

    for (const opId of ['MALE', 'FEMALE'] as const) {
      const skel = new CharacterSkeleton(1, 'team_a', opId, true, noHelmetGear);
      expect(skel.headGroup.getObjectByName('helmet_mich')!.visible).toBe(false);
      expect(skel.headGroup.getObjectByName('helmet_mil_tec')!.visible).toBe(false);
      skel.setIrStrobe(true);
      expect(skel.headGroup.getObjectByName('ir_strobe_housing')!.visible).toBe(false);
      expect(validateOperatorRig(skel.root, opId, 'STRICT').valid).toBe(true);
      skel.dispose();
    }

    const opFactory = new TacticalOperatorRigFactory(1);
    const bareRig = opFactory.buildOperator('bot', 'op_no_helmet', 'team_a', 'MALE');
    bareRig.setGearAppearance(noHelmetGear);
    bareRig.setIrStrobe(true, true);
    expect(bareRig.headGroup.getObjectByName('rig_helmet_shell')!.visible).toBe(false);
    expect(bareRig.headGroup.getObjectByName('rig_helmet_rim')!.visible).toBe(false);
    expect(bareRig.headGroup.getObjectByName('rig_helmet_band')!.visible).toBe(false);
    expect(bareRig.headGroup.getObjectByName('rig_ir_strobe_housing')!.visible).toBe(false);
    expect(bareRig.headGroup.getObjectByName('rig_nvg_shroud')!.visible).toBe(false);
    opFactory.dispose();

    const roomState: LobbyRoomState = {
      code: 'TST003',
      hostUserId: 'host_1',
      hostUsername: 'HOST',
      visibility: 'private',
      mode: 'battle',
      battleRule: 'tdm',
      mapId: 'timberline_compound',
      maxPlayers: 8,
      botsEnabled: true,
      botCount: 4,
      killLimit: 30,
      botDifficulty: 'tactical',
      status: 'in_match',
      matchSequence: 1,
      specialEvent: null,
      members: [
        {
          userId: 'host_1',
          username: 'HOST',
          team: 'A',
          ready: true,
          isHost: true,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
        {
          userId: 'peer_2',
          username: 'PEER',
          team: 'B',
          ready: true,
          isHost: false,
          rank: 1,
          prestige: 0,
          connected: true,
          joinedAt: Date.now(),
        },
      ],
      chat: [],
      updatedAt: Date.now(),
    };
    const matchState = createDefaultMatchState();
    const packet = validateAndSanitizeGameMessage(
      {
        type: 'game:state',
        x: 0,
        y: 0,
        z: 0,
        yaw: 0,
        pitch: 0,
        weaponId: 'm4a1',
        hp: 100,
        maxHp: 100,
        alive: true,
        helmetType: 'none',
        nvgMount: 'arnvg',
      },
      roomState,
      matchState,
      { userId: 'peer_2', username: 'PEER' },
    );
    expect(packet).toBeTruthy();
    expect(packet!.payload.helmetType).toBe('none');
    expect(packet!.payload.nvgMount).toBe('none');
  });

  it('builds contoured polycarbonate ballistic visors with MeshPhysicalMaterial clearcoat and upright helmet brow clearance', () => {
    const skel = new CharacterSkeleton(1, 'team_a', 'MALE', true, {
      helmetType: 'mich',
      eyewear: 'tinted_visor',
    });
    const asm = skel.getHeadAssembly()!;
    let physicalVisorCount = 0;
    asm.eyewearGroups.tintedVisor.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mat = (obj as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
        if (mat && mat.isMeshPhysicalMaterial && mat.transparent) {
          expect(mat.clearcoat).toBeGreaterThanOrEqual(0.95);
          expect(mat.depthWrite).toBe(true);
          physicalVisorCount += 1;
        }
      }
    });
    expect(physicalVisorCount).toBeGreaterThan(0);
    // Helmets sit slightly pitched back to expose brow & eyes cleanly (positive rotation.x)
    const michShell = skel.headGroup.getObjectByName('helmet_mich_shell')!;
    const fastShell = skel.headGroup.getObjectByName('helmet_mil_tec_shell')!;
    expect(michShell.rotation.x).toBeGreaterThan(0.05);
    expect(fastShell.rotation.x).toBeGreaterThan(0.05);
    skel.dispose();

    const zLib = new InfectedZombieRigLibrary();
    const guard = zLib.buildZombie('z_guard_visor', 'quarantine_guard');
    let guardPhysicalVisors = 0;
    guard.headGroup.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mat = (obj as THREE.Mesh).material as THREE.MeshPhysicalMaterial;
        if (mat && mat.isMeshPhysicalMaterial && mat.transparent) {
          expect(mat.clearcoat).toBeGreaterThanOrEqual(0.95);
          expect(mat.depthWrite).toBe(true);
          guardPhysicalVisors += 1;
        }
      }
    });
    expect(guardPhysicalVisors).toBeGreaterThan(0);
    zLib.dispose();
  });

  it('enforces [F] as the sole interact key and UI prompt across Hideout, Zombies Outpost, and Gym', () => {
    const hideoutCtrl = readFileSync(resolve(process.cwd(), 'hideout/HideoutSessionController.ts'), 'utf8');
    const zombiesCtrl = readFileSync(resolve(process.cwd(), 'hideout/ZombiesLobbyController.ts'), 'utf8');
    const gymHud = readFileSync(resolve(process.cwd(), 'gym/GymHud.tsx'), 'utf8');
    const gymWorld = readFileSync(resolve(process.cwd(), 'gym/GymWorld.ts'), 'utf8');
    const gymEngine = readFileSync(resolve(process.cwd(), 'gym/GymEngine.ts'), 'utf8');

    expect(hideoutCtrl).not.toMatch(/key:\s*'E'/);
    expect(zombiesCtrl).not.toMatch(/key:\s*'E'/);
    expect(zombiesCtrl).not.toContain('E / F');
    expect(gymHud).toContain('[F] Open Gunsmithing Bench');
    expect(gymHud).not.toContain('[E]');
    expect(gymWorld).toContain('LOOK + [F]: MODIFY FIREARM');
    expect(gymWorld).not.toContain('[E]');
    expect(gymEngine).not.toContain('Gunsmith Bench [E]');
    expect(gymEngine).not.toMatch(/case 'KeyE':(?:(?!\bbreak;)[\s\S])*?(openGunsmith|executeSelectedInteract)/);
    expect(hideoutCtrl).not.toMatch(/case 'KeyE':(?:(?!\bbreak;)[\s\S])*?(openGunsmith|executeSelectedInteract)/);
    expect(zombiesCtrl).not.toMatch(/case 'KeyE':(?:(?!\bbreak;)[\s\S])*?(openGunsmith|executeSelectedInteract)/);
  });
});







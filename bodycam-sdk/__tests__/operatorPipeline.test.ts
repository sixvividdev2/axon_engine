import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ArticulatedRagdoll,
  BodycamPhysicsWorld,
  CharacterSkeleton,
  DEFAULT_BODYCAM_SDK_CONFIG,
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





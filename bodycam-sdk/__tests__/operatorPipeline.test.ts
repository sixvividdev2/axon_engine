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
  WeaponRig,
  validateCrossOperatorParity,
  validateOperatorRig,
} from '../index';
import {
  computeDerivedWeaponStats,
  createBareAttachments,
  getCompatibleAttachments,
  getOwnedSuppressorDef,
  normalizeWeaponAttachments,
} from '../../data/attachments';

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

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BodycamController } from '../../bodycam-sdk/BodycamController';
import type { IBodycamAudioSource } from '../../bodycam-sdk/IBodycamAudioSource';
import { VaultController } from '../../bodycam-sdk/movement/VaultController';
import { createVaultCandidate } from '../../bodycam-sdk/movement/VaultDetector';
import {
  BodycamInputState,
  DEFAULT_BODYCAM_SDK_CONFIG,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { resolveWeaponProfile } from '../../bodycam-sdk/weaponProfiles';
import { WeaponRig } from '../../bodycam-sdk/WeaponRig';
import {
  computeHingeTorqueScalar,
  computeTargetHingeAngularImpulse,
} from '../../bodycam-sdk/weapons/BallisticsSolver';
import { computeBeltGrenadeDetonationChance } from '../tacticalEquipment';

const NOOP_AUDIO: IBodycamAudioSource = {
  updateListener: () => {},
  setInteriorAcoustics: () => {},
  playFootstep: () => {},
  playGearRattle: () => {},
  playHandSlap: () => {},
  playBootScuff: () => {},
  playGlassShatter: () => {},
};

const FLAT_WORLD: IBodycamWorldAdapter = {
  getSurfaceMaterial: () => 'concrete',
  raycast: (_origin, _dir, _near, _far, out) => {
    out.hit = false;
    return false;
  },
  sweepCapsule: (startPos, dx, dy, dz, _r, _h, _step, out) => {
    out.posX = startPos.x + dx;
    out.posY = startPos.y + dy;
    out.posZ = startPos.z + dz;
    out.grounded = out.posY <= 0.001;
    out.steppedUp = false;
    out.stepDeltaY = 0;
    out.hitWall = false;
    out.hitCeiling = false;
    out.wallNormalX = 0;
    out.wallNormalZ = 1;
    out.groundNormalY = 1;
    out.slopeAngleRad = 0;
  },
  getGroundHeight: () => 0,
};

function makeTestVaultCandidate() {
  const c = createVaultCandidate();
  c.valid = true;
  c.kind = 'VAULT_OVER';
  c.ledgeHeight = 0.85;
  c.obstacleDepth = 0.45;
  c.surface = 'wood';
  c.entryPos.set(0, 0, 1.0);
  c.apexPos.set(0, 1.05, 0.25);
  c.landPos.set(0, 0, -0.8);
  c.ledgeCenter.set(0, 0.85, 0.25);
  c.wallNormal.set(0, 0, 1);
  c.vaultForward.set(0, 0, -1);
  c.handLWorld.set(-0.22, 0.86, 0.4);
  c.handRWorld.set(0.22, 0.86, 0.4);
  return c;
}

describe('computeBeltGrenadeDetonationChance', () => {
  it('gives even light pistol rounds a real detonation chance and scales monotonically with energy & bullet mass', () => {
    const rimfire = computeBeltGrenadeDetonationChance(140, 'lead_fmj', 2.6);
    const nineMm = computeBeltGrenadeDetonationChance(480, 'lead_fmj', 7.5);
    const rifle556 = computeBeltGrenadeDetonationChance(1750, 'lead_fmj', 4.0);
    const rifle308 = computeBeltGrenadeDetonationChance(3300, 'lead_fmj', 9.8);
    const slug12g = computeBeltGrenadeDetonationChance(3300, 'lead_slug', 28.3);
    const antiMat = computeBeltGrenadeDetonationChance(14500, 'steel_core_ap', 42.0);

    expect(rimfire).toBeGreaterThanOrEqual(0.12);
    expect(nineMm).toBeGreaterThan(rimfire);
    expect(rifle556).toBeGreaterThan(nineMm);
    expect(rifle308).toBeGreaterThan(rifle556);
    expect(slug12g).toBeGreaterThan(rifle308);
    expect(antiMat).toBeGreaterThanOrEqual(slug12g);
    expect(antiMat).toBeLessThanOrEqual(0.96);
  });

  it('increases cookoff likelihood for AP and incendiary/tracer core rounds', () => {
    const base = computeBeltGrenadeDetonationChance(900, 'lead_fmj', 8.0);
    const ap = computeBeltGrenadeDetonationChance(900, 'steel_core_ap', 8.0);
    const inc = computeBeltGrenadeDetonationChance(900, 'incendiary', 8.0);

    expect(ap).toBeGreaterThan(base);
    expect(inc).toBeGreaterThan(ap);
  });
});

describe('VaultController spin vs standard vault', () => {
  it('keeps zero spin yaw offset during standard single-Space VAULT_OVER', () => {
    const vc = new VaultController();
    const pos = new THREE.Vector3();
    vc.start(makeTestVaultCandidate(), undefined, undefined, false, false, 1);

    expect(vc.getReadOnlyState().mode).toBe('VAULT_OVER');
    for (let i = 0; i < 10; i++) {
      vc.update(0.05, pos, FLAT_WORLD, NOOP_AUDIO);
      expect(vc.getReadOnlyState().spinYawOffset).toBe(0);
    }
  });

  it('executes a full +/- 2*PI 360-degree spin on double-Space SPIN_VAULT and lands cleanly', () => {
    const vc = new VaultController();
    const pos = new THREE.Vector3();
    vc.start(makeTestVaultCandidate(), undefined, undefined, false, false, 1);

    // Simulate double-tap Space early in vault upgrading smoothly into SPIN_VAULT
    vc.update(0.06, pos, FLAT_WORLD, NOOP_AUDIO);
    expect(vc.upgradeToSpinVault(-1)).toBe(true);
    expect(vc.getReadOnlyState().mode).toBe('SPIN_VAULT');

    let peakAbsSpin = 0;
    let completed = false;
    for (let i = 0; i < 40; i++) {
      const res = vc.update(0.03, pos, FLAT_WORLD, NOOP_AUDIO);
      peakAbsSpin = Math.max(peakAbsSpin, Math.abs(vc.getReadOnlyState().spinYawOffset));
      if (res.completed) {
        completed = true;
        break;
      }
    }

    expect(completed).toBe(true);
    expect(peakAbsSpin).toBeCloseTo(Math.PI * 2, 3);
    expect(vc.getReadOnlyState().spinYawOffset).toBe(0);
    expect(pos.z).toBeCloseTo(-0.8, 3);
  });
});

function createVaultBoxWorldAdapter(): IBodycamWorldAdapter {
  const wallBox = new THREE.Mesh(
    new THREE.BoxGeometry(4, 0.85, 0.45),
    new THREE.MeshBasicMaterial(),
  );
  wallBox.position.set(0, 0.425, 0);
  wallBox.updateMatrixWorld(true);

  const floorBox = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.2, 20),
    new THREE.MeshBasicMaterial(),
  );
  floorBox.position.set(0, -0.1, 0);
  floorBox.updateMatrixWorld(true);

  const raycaster = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];

  return {
    getSurfaceMaterial: () => 'concrete',
    raycast: (origin, dir, near, far, out) => {
      raycaster.set(origin, dir);
      raycaster.near = near;
      raycaster.far = far;
      hits.length = 0;
      raycaster.intersectObjects([wallBox, floorBox], false, hits);
      if (hits.length === 0) {
        out.hit = false;
        out.object = null;
        return false;
      }
      const h = hits[0];
      out.hit = true;
      out.distance = h.distance;
      out.pointX = h.point.x;
      out.pointY = h.point.y;
      out.pointZ = h.point.z;
      const n = h.face?.normal ?? new THREE.Vector3(0, 1, 0);
      out.normalX = n.x;
      out.normalY = n.y;
      out.normalZ = n.z;
      out.object = h.object;
      return true;
    },
    sweepCapsule: (startPos, dx, dy, dz, _r, _h, _step, out) => {
      out.posX = startPos.x + dx;
      out.posY = Math.max(0, startPos.y + dy);
      out.posZ = startPos.z + dz;
      out.grounded = out.posY <= 0.001;
      out.steppedUp = false;
      out.stepDeltaY = 0;
      out.hitWall = false;
      out.hitCeiling = false;
      out.wallNormalX = 0;
      out.wallNormalZ = 1;
      out.groundNormalY = 1;
      out.slopeAngleRad = 0;
    },
    getGroundHeight: () => 0,
  };
}

function makeBlankInput(): BodycamInputState {
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
    holdBreath: false,
    vault: false,
  };
}

describe('BodycamController single-Space vs double-Space vaulting', () => {
  it('performs a zero-spin regular vault on single Space even after full 2*PI yaw turns', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.05, 100);
    const rig = new WeaponRig(scene, true, NOOP_AUDIO);
    const controller = new BodycamController(camera, rig, NOOP_AUDIO);
    const adapter = createVaultBoxWorldAdapter();
    const profile = resolveWeaponProfile('m4a1');
    const cfg = DEFAULT_BODYCAM_SDK_CONFIG;

    // Simulate having turned a full 360 degrees (yaw = 2*PI) facing -Z toward wall at z = 0
    controller.snapTo(0, 0, 0.85, Math.PI * 2, 0);

    const input = makeBlankInput();
    input.forward = true;
    input.vault = true;

    let elapsed = 0;
    const dt = 1 / 60;
    controller.update(dt, elapsed, input, adapter, profile, cfg);

    expect(controller.isVaulting()).toBe(true);
    expect(controller.getVaultState().mode).toBe('VAULT_OVER');

    // Release Space after single tap and step through the full vault
    input.vault = false;
    let maxTorsoYawDrift = 0;
    let maxSpinYaw = 0;
    for (let i = 0; i < 60; i++) {
      elapsed += dt;
      controller.update(dt, elapsed, input, adapter, profile, cfg);
      maxTorsoYawDrift = Math.max(maxTorsoYawDrift, Math.abs(controller.torsoYaw - Math.PI * 2));
      maxSpinYaw = Math.max(maxSpinYaw, Math.abs(controller.getVaultState().spinYawOffset));
      if (!controller.isVaulting()) break;
    }

    expect(controller.isVaulting()).toBe(false);
    expect(maxSpinYaw).toBe(0);
    // Must stay within glance clamp without snapping 2*PI around
    expect(maxTorsoYawDrift).toBeLessThan(0.15);
  });

  it('upgrades to SPIN_VAULT on double-Space and resets double-Space timer on completion and landing', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.05, 100);
    const rig = new WeaponRig(scene, true, NOOP_AUDIO);
    const controller = new BodycamController(camera, rig, NOOP_AUDIO);
    const adapter = createVaultBoxWorldAdapter();
    const profile = resolveWeaponProfile('m4a1');
    const cfg = DEFAULT_BODYCAM_SDK_CONFIG;

    controller.snapTo(0, 0, 0.85, 0, 0);
    const input = makeBlankInput();
    input.forward = true;
    const dt = 1 / 60;
    let elapsed = 0;

    // 1st Space press starts regular VAULT_OVER
    input.vault = true;
    controller.update(dt, elapsed, input, adapter, profile, cfg);
    expect(controller.getVaultState().mode).toBe('VAULT_OVER');

    // Release 1st Space, advance ~0.10s, then press 2nd Space -> SPIN_VAULT
    input.vault = false;
    for (let i = 0; i < 5; i++) {
      elapsed += dt;
      controller.update(dt, elapsed, input, adapter, profile, cfg);
    }
    input.vault = true;
    elapsed += dt;
    controller.update(dt, elapsed, input, adapter, profile, cfg);
    expect(controller.getVaultState().mode).toBe('SPIN_VAULT');

    // Finish spin vault
    input.vault = false;
    let peakSpin = 0;
    for (let i = 0; i < 80; i++) {
      elapsed += dt;
      controller.update(dt, elapsed, input, adapter, profile, cfg);
      peakSpin = Math.max(peakSpin, Math.abs(controller.getVaultState().spinYawOffset));
      if (!controller.isVaulting()) break;
    }
    expect(peakSpin).toBeGreaterThan(Math.PI * 1.8);

    // Jump in open area, land, and verify immediate single Space in front of wall does NOT spin
    controller.snapTo(0, 0, 5.0, 0, 0);
    input.forward = false;
    input.vault = true;
    elapsed += dt;
    controller.update(dt, elapsed, input, adapter, profile, cfg);
    expect(controller.grounded).toBe(false);
    input.vault = false;
    for (let i = 0; i < 60; i++) {
      elapsed += dt;
      controller.update(dt, elapsed, input, adapter, profile, cfg);
      if (controller.grounded) break;
    }
    expect(controller.grounded).toBe(true);

    // Move close to obstacle (keeping elapsed within 0.2s window won't trigger spin after landing)
    controller.position.set(0, 0, 0.85);
    input.forward = true;
    input.vault = true;
    elapsed += dt;
    controller.update(dt, elapsed, input, adapter, profile, cfg);
    expect(controller.isVaulting()).toBe(true);
    expect(controller.getVaultState().mode).toBe('VAULT_OVER');
  });
});

describe('Target hinge 3D cross-product torque physics', () => {
  it('computes opposing hinge signs for bottom-hinged poppers vs top-hinged gongs under identical downrange shot', () => {
    // Arm pointing +Y (plate above bottom hinge) hit by bullet moving +Z:
    // r = (0, +1, 0), F = (0, 0, +1) -> r x F = (+1, 0, 0) => +X torque (tips away downrange)
    const bottomTau = computeHingeTorqueScalar(0, 1, 0, 0, 0, 1, 1, 0, 0);
    // Arm pointing -Y (gong below top hinge) hit by bullet moving +Z:
    // r = (0, -1, 0), F = (0, 0, +1) -> r x F = (-1, 0, 0) => -X torque (bottom kicks away +Z)
    const topTau = computeHingeTorqueScalar(0, -1, 0, 0, 0, 1, 1, 0, 0);

    expect(bottomTau).toBeGreaterThan(0);
    expect(topTau).toBeLessThan(0);

    const bottomPivot = new THREE.Object3D();
    bottomPivot.position.set(0, 0.5, 10);
    const topPivot = new THREE.Object3D();
    topPivot.position.set(0, 2.0, 10);

    const shotDir = new THREE.Vector3(0, 0, 1);
    const bottomDelta = computeTargetHingeAngularImpulse({
      pivot: bottomPivot,
      hitPointWorld: new THREE.Vector3(0, 1.05, 10),
      incomingDir: shotDir,
      impactSpeedMs: 850,
      bulletMassGrams: 4.0,
      outcome: 'stop',
    });
    const topDelta = computeTargetHingeAngularImpulse({
      pivot: topPivot,
      hitPointWorld: new THREE.Vector3(0, 1.45, 10),
      incomingDir: shotDir,
      impactSpeedMs: 850,
      bulletMassGrams: 4.0,
      outcome: 'stop',
    });

    expect(bottomDelta).toBeGreaterThan(0);
    expect(topDelta).toBeLessThan(0);
  });

  it('scales impulse between partial penetration and ricochet restitution', () => {
    const pivot = new THREE.Object3D();
    pivot.position.set(0, 1.0, 10);
    const hitPoint = new THREE.Vector3(0, 1.45, 10);
    const inDir = new THREE.Vector3(0, 0, 1);
    const outDir = new THREE.Vector3(0.45, 0.35, -0.82).normalize();

    const penDelta = computeTargetHingeAngularImpulse({
      pivot,
      hitPointWorld: hitPoint,
      incomingDir: inDir,
      impactSpeedMs: 900,
      bulletMassGrams: 9.8,
      effectiveInertia: 0.65,
      outcome: 'penetrate',
    });
    const stopDelta = computeTargetHingeAngularImpulse({
      pivot,
      hitPointWorld: hitPoint,
      incomingDir: inDir,
      impactSpeedMs: 900,
      bulletMassGrams: 9.8,
      effectiveInertia: 0.65,
      outcome: 'stop',
    });
    const ricoDelta = computeTargetHingeAngularImpulse({
      pivot,
      hitPointWorld: hitPoint,
      incomingDir: inDir,
      impactSpeedMs: 900,
      bulletMassGrams: 9.8,
      effectiveInertia: 0.65,
      outcome: 'ricochet',
      outgoingDir: outDir,
    });

    expect(penDelta).toBeGreaterThan(0);
    expect(stopDelta).toBeGreaterThan(penDelta);
    expect(ricoDelta).toBeGreaterThan(stopDelta);
  });
});

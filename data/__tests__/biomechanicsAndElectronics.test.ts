import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BodycamController } from '../../bodycam-sdk/BodycamController';
import {
  BodycamInputState,
  BodycamWeaponProfile,
  DEFAULT_BODYCAM_SDK_CONFIG,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { getWeaponsByCategory, resolveWeaponProfile } from '../../bodycam-sdk/weaponProfiles';
import { WeaponRig } from '../../bodycam-sdk/WeaponRig';
import {
  graphicsQualityStore,
  HORIZON_FOG_LEAD_M,
  OPEN_WORLD_RENDER_DISTANCE_LIMITS,
  REDUCE_ANIMATION_DISTANCE_LIMITS,
  RENDER_DISTANCE_LIMITS,
} from '../graphicsQuality';
import { HoldRepairController } from '../../doors/HoldRepairController';
import { PlayerInteractAnimator } from '../../doors/PlayerInteractAnimator';
import { VitalsSystem } from '../../engine/survival/VitalsSystem';
import { createHorizonFogUniforms, updateHorizonFogUniforms } from '../../engine/world/HorizonFog';
import { HideoutElectronicsSystem } from '../../hideout/HideoutElectronicsSystem';

function makeFlatWorldAdapter(): IBodycamWorldAdapter {
  return {
    getGroundHeight: () => 0,
    getSurfaceMaterial: () => 'concrete',
    sweepCapsule: () => ({ hit: false, fraction: 1, normalX: 0, normalY: 1, normalZ: 0 }),
    raycast: () => false,
  };
}

function makeWeaponProfile(
  id: string,
  massKg: number,
  holdClass: BodycamWeaponProfile['holdClass'] = 'rifle',
): BodycamWeaponProfile {
  const base =
    holdClass === 'pistol'
      ? getWeaponsByCategory('pistols')[0]
      : resolveWeaponProfile('m4a1');
  return {
    ...base,
    id,
    name: id,
    massKg,
    holdClass,
  };
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
    vault: false,
    ...overrides,
  };
}

const noopAudio = {
  updateListener: () => {},
  setInteriorAcoustics: () => {},
  playFootstep: () => {},
  playGearRattle: () => {},
  playHandSlap: () => {},
  playBootScuff: () => {},
  playBreathCue: () => {},
  playWeaponCue: () => {},
  playMeleeWhoosh: () => {},
  playMeleeImpact: () => {},
  playTacticalSwitchClick: () => {},
  playGlassShatter: () => {},
};

describe('Distance Settings & AAA Horizon Fog', () => {
  it('defaults to 220m standard render, 300m open world render, 75m half-rate animation, and 15m fog lead', () => {
    expect(RENDER_DISTANCE_LIMITS.default).toBe(220);
    expect(OPEN_WORLD_RENDER_DISTANCE_LIMITS.default).toBe(300);
    expect(REDUCE_ANIMATION_DISTANCE_LIMITS.default).toBe(75);
    expect(HORIZON_FOG_LEAD_M).toBe(15);

    const uniforms = createHorizonFogUniforms(220);
    expect(uniforms.uHorizonFogRange.value.x).toBe(205);
    expect(uniforms.uHorizonFogRange.value.y).toBe(220);

    updateHorizonFogUniforms(uniforms, 300);
    expect(uniforms.uHorizonFogRange.value.x).toBe(285);
    expect(uniforms.uHorizonFogRange.value.y).toBe(300);
  });

  it('clamps and notifies subscribers when updating distance settings', () => {
    const prev = { ...graphicsQualityStore.getDistanceSettings() };
    const seen: number[] = [];
    const unsub = graphicsQualityStore.subscribeDistanceSettings((ds) => {
      seen.push(ds.renderDistanceM);
    });
    graphicsQualityStore.setRenderDistanceM(260);
    graphicsQualityStore.setReduceAnimationDistanceM(90);
    const next = graphicsQualityStore.getDistanceSettings();
    expect(next.renderDistanceM).toBe(260);
    expect(next.reduceAnimationDistanceM).toBe(90);
    expect(seen).toContain(260);
    unsub();
    graphicsQualityStore.setRenderDistanceM(prev.renderDistanceM);
    graphicsQualityStore.setReduceAnimationDistanceM(prev.reduceAnimationDistanceM);
  });
});

describe('Stamina Cooldown, Hold Breath Gate, Arm Stamina & Heart Rate Biomechanics', () => {
  it('blocks Hold Breath in VitalsSystem whenever stamina is below 20%', () => {
    const vitals = new VitalsSystem();
    const baseInput = {
      isSprinting: false,
      isMoving: false,
      isAds: true,
      wantsHoldBreath: true,
      isHealingOrBleeding: false,
      encumbranceRatio: 0,
      stamina: 0.15,
      moveSpeedRatio: 0,
      crouched: false,
      exertion: 0.2,
      health: 100,
      lightBleeding: false,
      heavyBleeding: false,
      heartbeatSeverity: 0,
      threatLevel: 0,
    };

    vitals.update(0.05, baseInput);
    expect(vitals.holdBreathActive).toBe(false);

    vitals.update(0.05, { ...baseInput, stamina: 0.25 });
    expect(vitals.holdBreathActive).toBe(true);

    vitals.update(0.05, { ...baseInput, stamina: 0.18 });
    expect(vitals.holdBreathActive).toBe(false);
  });

  it('locks Shift-sprint below 5% stamina until stamina recovers to at least 20%', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.08, 240);
    const rig = new WeaponRig(scene, true, noopAudio);
    const ctrl = new BodycamController(camera, rig, noopAudio);
    const world = makeFlatWorldAdapter();
    const rifle = makeWeaponProfile('ak74', 3.4);

    let stamina = 0.04;
    let elapsed = 0;
    const step = (dt: number, sprint: boolean) => {
      elapsed += dt;
      ctrl.update(
        dt,
        elapsed,
        makeBaseInput({ forward: true, sprint }),
        world,
        rifle,
        DEFAULT_BODYCAM_SDK_CONFIG,
        stamina,
        100,
        (drain) => {
          stamina = Math.max(0, stamina - drain);
        },
      );
    };

    // Stamina below 5%: latches sprintExhausted and prevents sprinting
    step(0.05, true);
    expect(ctrl.sprintExhausted).toBe(true);
    expect(ctrl.isSprinting).toBe(false);

    // Still locked at 15% stamina (prevents pose flickering)
    stamina = 0.15;
    step(0.05, true);
    expect(ctrl.sprintExhausted).toBe(true);
    expect(ctrl.isSprinting).toBe(false);

    // Unlocks once stamina >= 20%
    stamina = 0.21;
    step(0.05, true);
    expect(ctrl.sprintExhausted).toBe(false);
    expect(ctrl.isSprinting).toBe(true);

    rig.dispose();
  });

  it('drains arm stamina in all aim modes (not hip fire), scales with weapon mass, drains per shot, and stays aimed at 0%', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.08, 240);
    const rig = new WeaponRig(scene, true, noopAudio);
    const ctrl = new BodycamController(camera, rig, noopAudio);
    const world = makeFlatWorldAdapter();
    const lightPistol = makeWeaponProfile('pistol', 0.9, 'pistol');
    const heavyRifle = makeWeaponProfile('lmg', 6.8, 'rifle');

    let elapsed = 0;
    const runSteps = (
      steps: number,
      dt: number,
      input: Partial<BodycamInputState>,
      profile: BodycamWeaponProfile,
      stamina = 1.0,
    ) => {
      for (let i = 0; i < steps; i++) {
        elapsed += dt;
        ctrl.update(
          dt,
          elapsed,
          makeBaseInput(input),
          world,
          profile,
          DEFAULT_BODYCAM_SDK_CONFIG,
          stamina,
          100,
        );
      }
    };

    // Hip fire does not drain arm stamina
    runSteps(20, 0.05, { ads: false }, heavyRifle);
    expect(ctrl.armStamina).toBeCloseTo(1.0, 4);

    // Aiming light pistol drains slower than heavy rifle
    runSteps(40, 0.05, { ads: true, adsMode: 'PRIMARY' }, lightPistol);
    const afterPistol = ctrl.armStamina;
    expect(afterPistol).toBeLessThan(1.0);

    ctrl.armStamina = 1.0;
    runSteps(40, 0.05, { ads: true, adsMode: 'PRIMARY' }, heavyRifle);
    const afterHeavy = ctrl.armStamina;
    expect(afterHeavy).toBeLessThan(afterPistol);

    // Point-aim also drains arm stamina
    const beforePointAim = ctrl.armStamina;
    runSteps(20, 0.05, { ads: true, adsMode: 'POINT_AIM' }, heavyRifle);
    expect(ctrl.armStamina).toBeLessThan(beforePointAim);

    // Firing while aimed drains additional arm stamina
    const beforeShot = ctrl.armStamina;
    ctrl.applyRecoil(0.03, 0.005, 0.012);
    expect(ctrl.armStamina).toBeLessThan(beforeShot);

    // Deplete arm stamina to 0%: player MUST remain aimed (never forced to hip-fire)
    ctrl.armStamina = 0;
    runSteps(10, 0.05, { ads: true, adsMode: 'PRIMARY' }, heavyRifle, 0.8);
    expect(ctrl.isAds).toBe(true);
    expect(ctrl.aimStance).toBe('ADS');

    // Heart rate coupling updates cleanly
    ctrl.setHeartRateBpm(62);
    runSteps(10, 0.05, { ads: true }, lightPistol);
    const calmBpm = ctrl.getHeartRateBpm();
    ctrl.setHeartRateBpm(162);
    runSteps(10, 0.05, { ads: true }, lightPistol);
    expect(ctrl.getHeartRateBpm()).toBeGreaterThan(calmBpm + 80);

    rig.dispose();
  });
});

describe('Universal Breakable Electronics & Two-Handed Hold [F] Repair', () => {
  it('breaks electronics on impact, blocks interactive link until repaired, supports origin rebase & chunk removal', () => {
    const scene = new THREE.Scene();
    const electronics = new HideoutElectronicsSystem(scene);

    const meshMat = new THREE.MeshStandardMaterial({
      color: 0x22262b,
      emissive: 0x38bdf8,
      emissiveIntensity: 1.4,
    });
    const screenMesh = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.1), meshMat);
    screenMesh.position.set(0, 1.4, -2);
    scene.add(screenMesh);
    screenMesh.updateMatrixWorld(true);

    const light = new THREE.PointLight(0x38bdf8, 2.5, 8);
    light.position.set(0, 1.4, -1.8);
    scene.add(light);

    electronics.registerNode({
      id: 'surv_0_0_terminal',
      label: 'FOB Terminal',
      interactiveLinkId: 'fob_terminal',
      hitMeshes: [screenMesh],
      emissiveMaterials: [meshMat],
      linkedLights: [{ light, dropFraction: 1.0 }],
      sparkOrigin: new THREE.Vector3(0, 1.4, -2),
    });

    expect(electronics.isInteractiveLinkBroken('fob_terminal')).toBe(false);

    const listenerPos = new THREE.Vector3(0, 1.5, 0);
    // Shooting breaks it, kills emissive & light, and marks interactive link broken
    const handled = electronics.handleImpact(
      screenMesh,
      new THREE.Vector3(0, 1.4, -1.95),
      new THREE.Vector3(0, 0, 1),
      listenerPos,
    );
    expect(handled).toBeTruthy();
    expect(electronics.isInteractiveLinkBroken('fob_terminal')).toBe(true);
    expect(light.intensity).toBe(0);
    expect(meshMat.emissiveIntensity).toBe(0);

    // Findable as repair target when player looks at it within range
    const target = electronics.findBrokenRepairTarget(
      listenerPos,
      new THREE.Vector3(0, 0, -1),
      2.8,
    );
    expect(target?.id).toBe('surv_0_0_terminal');
    expect(target?.label).toBe('FOB Terminal');

    // Repair restores emissive, light, and interactive link
    expect(electronics.repairNode('surv_0_0_terminal', listenerPos)).toBe(true);
    expect(electronics.isInteractiveLinkBroken('fob_terminal')).toBe(false);
    expect(light.intensity).toBeGreaterThan(2.0);
    expect(meshMat.emissiveIntensity).toBeGreaterThan(1.0);

    // Floating-origin rebase shifts internal node anchor & chunk prefix cleanup removes node
    electronics.shiftOrigin(10, -5);
    electronics.removeNodesByPrefix('surv_0_0_');
    expect(electronics.repairNode('surv_0_0_terminal', listenerPos)).toBe(false);

    electronics.dispose();
    screenMesh.geometry.dispose();
    meshMat.dispose();
  });

  it('runs HoldRepairController with two-handed 1P IK animation over 1.8-2.5s and cancels on release', () => {
    const animator = new PlayerInteractAnimator();
    const holdRepair = new HoldRepairController();
    const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 100);
    camera.position.set(0, 1.5, 0);
    camera.lookAt(0, 1.4, -1.5);
    camera.updateMatrixWorld(true);

    const onComplete = vi.fn();
    const onTick = vi.fn();
    const anchor = new THREE.Vector3(0, 1.4, -1.5);

    holdRepair.start(
      {
        kind: 'DOOR_REPAIR',
        targetId: 'door_1',
        label: 'Breached Door',
        durationSec: 2.2,
        anchorPos: anchor,
        onWorkTick: onTick,
        onComplete,
      },
      animator,
    );

    expect(holdRepair.isActive()).toBe(true);
    expect(animator.isHoldRepairActive()).toBe(true);

    // Step halfway -> both hands active in IK override
    for (let i = 0; i < 25; i++) {
      holdRepair.step(0.04, true, camera.position, camera, animator);
    }
    expect(animator.ikOverride.active).toBe(true);
    expect(animator.ikOverride.leftWeight).toBeGreaterThan(0);
    expect(animator.ikOverride.rightWeight).toBeGreaterThan(0);
    expect(onTick).toHaveBeenCalled();

    // Release F early -> cancels cleanly without completing
    holdRepair.step(0.04, false, camera.position, camera, animator);
    expect(holdRepair.isActive()).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    // Full hold completes and invokes callback
    holdRepair.start(
      {
        kind: 'ELECTRONICS_REPAIR',
        targetId: 'panel_1',
        label: 'Power Panel',
        durationSec: 1.9,
        anchorPos: anchor,
        onComplete,
      },
      animator,
    );
    for (let i = 0; i < 60; i++) {
      if (holdRepair.step(0.04, true, camera.position, camera, animator)) break;
    }
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(holdRepair.isActive()).toBe(false);
  });
});

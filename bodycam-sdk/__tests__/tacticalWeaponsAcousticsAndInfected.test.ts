import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BodycamAudio,
  classifyBallisticFlyby,
  computeSpatialGunshotEnvelope,
  OPEN_WORLD_MAX_GUNSHOT_RANGE_M,
  OPEN_WORLD_SHARP_GUNSHOT_RANGE_M,
  SPEED_OF_SOUND_MPS,
} from '../BodycamAudio';
import {
  BALLISTIC_FLYBY_MAX_RADIUS_M,
  BallisticsSolver,
  evaluateBallisticFlybyPCA,
} from '../weapons/BallisticsSolver';
import { WeaponModelFactory } from '../weapons/WeaponModelFactory';
import { resolveReloadPlatformStyle, WeaponAnimator } from '../weapons/WeaponAnimator';
import { computeWeaponSpringTuning, WeaponRig } from '../WeaponRig';
import { CharacterSkeleton, computeGeometryDrivenGripWrap } from '../CharacterSkeleton';
import { CharacterAnimator } from '../CharacterAnimator';
import { buildAnatomicalHeadAssembly } from '../character/AnatomicalHeadBuilder';
import { SDK_WEAPON_PROFILES } from '../weaponProfiles';
import { resolveAiWeaponAudioProfile } from '../../src/modes/openworld/world/OpenWorldAiDirector';
import { InfectedZombieRigLibrary } from '../../combat/InfectedZombieRig';
import {
  computeZombieSpawnVariant,
  CRAWLER_BLEED_OUT_MAX_SEC,
  CRAWLER_BLEED_OUT_MIN_SEC,
  InfectionZombieAI,
} from '../../combat/InfectionZombieAI';
import { BuiltMapInstance } from '../../maps/types';
import { BodycamController } from '../BodycamController';
import { DEFAULT_BODYCAM_SDK_CONFIG, IBodycamWorldAdapter } from '../types';
import { getDefaultAmmoVariant } from '../../data/calibers';

function installMockCanvas(): void {
  if (typeof globalThis.window === 'undefined') {
    (globalThis as unknown as { window: unknown }).window = {};
  }
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

function makeMinimalInfectionMap(): BuiltMapInstance {
  const group = new THREE.Group();
  const node = {
    id: 'n0',
    position: [0, 0, 0] as [number, number, number],
    zoneId: 'lobby',
    neighbors: [] as string[],
  };
  return {
    id: 'test_outpost',
    group,
    physics: {
      boxes: [],
      boundsMinX: -30,
      boundsMaxX: 30,
      boundsMinZ: -30,
      boundsMaxZ: 30,
      getGroundHeight: () => 0,
    } as unknown as BuiltMapInstance['physics'],
    navGraph: {
      nodes: [node],
      byId: new Map([['n0', node]]),
    },
    spawnPoints: {
      teamA: [[0, 0, 0]],
      teamB: [[0, 0, 0]],
      ffa: [[0, 0, 0]],
      zombieSpawners: [
        {
          id: 'sp_1',
          zoneId: 'lobby',
          spawnPos: [0, 0, -8],
          windowOuterPos: [0, 0, -5],
          sillPos: [0, 0.9, -4.5],
          entryPos: [0, 0, -4],
        },
      ],
    },
    interactables: [],
    windowBarriers: [],
    lights: [],
    dispose: () => {},
  } as unknown as BuiltMapInstance;
}

beforeAll(() => {
  installMockCanvas();
});

describe('Pillar 1 — HK MP5 & Open-Top V-Notch H&K Rotary Drum Sights', () => {
  it('builds MP5RollerSMG with open-top V-notch drum (zero closed rear torus) aligned to hooded front sight post', () => {
    const mp5Spec = SDK_WEAPON_PROFILES.hk_mp5;
    expect(mp5Spec).toBeDefined();

    const asm = WeaponModelFactory.build(
      {
        id: mp5Spec.id,
        holdClass: mp5Spec.holdClass,
        barrelLengthM: mp5Spec.barrelLengthM,
        visualStyle: mp5Spec.visualStyle,
        finish: mp5Spec.finish,
        railType: mp5Spec.railType,
        rightHandSocket: mp5Spec.rightHandSocket,
        leftHandSocket: mp5Spec.leftHandSocket,
        muzzleOffset: mp5Spec.muzzleOffset,
        laserOffset: mp5Spec.laserOffset,
        supportsSuppressor: mp5Spec.supportsSuppressor,
      },
      false,
    );

    const rearDrum = asm.group.getObjectByName('mp5RearVNotchDrum');
    const frontHood = asm.group.getObjectByName('mp5FrontSightHood');
    const frontPost = asm.group.getObjectByName('mp5FrontSightPost');
    const handguard = asm.group.getObjectByName('mp5TropicalHandguard');

    expect(rearDrum).toBeDefined();
    expect(frontHood).toBeDefined();
    expect(frontPost).toBeDefined();
    expect(handguard).toBeDefined();

    // Rear sight must be an open-top V-notch drum, NEVER a sight-blocking closed TorusGeometry
    let rearHasTorus = false;
    rearDrum?.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        if ((obj as THREE.Mesh).geometry instanceof THREE.TorusGeometry) {
          rearHasTorus = true;
        }
      }
    });
    expect(rearHasTorus).toBe(false);

    // Front sight hood is a slim circular ring centered on the bore & aligned with ironSightAnchorPos
    expect((frontHood as THREE.Mesh).geometry).toBeInstanceOf(THREE.TorusGeometry);
    expect(Math.abs(asm.ironSightAnchorPos.x)).toBeLessThan(0.001);
    expect(Math.abs(frontHood!.position.x)).toBeLessThan(0.001);
    expect(Math.abs(frontHood!.position.y - asm.ironSightAnchorPos.y)).toBeLessThan(0.004);

    asm.dispose();
  });
});

describe('Pillar 2 — Open World Spatial & Dynamic AI Gunshot Audio', () => {
  it('models 300m crisp cracks, 300-650m distant muffled firefights, >650m silence, and speed-of-sound delay', () => {
    const close = computeSpatialGunshotEnvelope(45, false, false, OPEN_WORLD_MAX_GUNSHOT_RANGE_M);
    const midSharp = computeSpatialGunshotEnvelope(
      OPEN_WORLD_SHARP_GUNSHOT_RANGE_M,
      false,
      false,
      OPEN_WORLD_MAX_GUNSHOT_RANGE_M,
    );
    const farMuffled = computeSpatialGunshotEnvelope(520, false, false, OPEN_WORLD_MAX_GUNSHOT_RANGE_M);
    const outOfRange = computeSpatialGunshotEnvelope(690, false, false, OPEN_WORLD_MAX_GUNSHOT_RANGE_M);

    expect(close.audible).toBe(true);
    expect(close.isDistantMuffled).toBe(false);
    expect(close.gainScale).toBeGreaterThan(midSharp.gainScale);
    expect(close.lowpassHz).toBeGreaterThan(farMuffled.lowpassHz);

    expect(midSharp.audible).toBe(true);
    expect(midSharp.isDistantMuffled).toBe(false);
    expect(midSharp.delaySec).toBeCloseTo(OPEN_WORLD_SHARP_GUNSHOT_RANGE_M / SPEED_OF_SOUND_MPS, 3);

    expect(farMuffled.audible).toBe(true);
    expect(farMuffled.isDistantMuffled).toBe(true);
    expect(farMuffled.gainScale).toBeGreaterThan(0.02);
    expect(farMuffled.reverbWetGain).toBeGreaterThan(0.1);
    expect(farMuffled.delaySec).toBeCloseTo(520 / SPEED_OF_SOUND_MPS, 3);

    expect(outOfRange.audible).toBe(false);
    expect(outOfRange.gainScale).toBe(0);
  });

  it('resolves distinct realistic weapon audio profiles for Open World AI weapons', () => {
    const rifle = resolveAiWeaponAudioProfile('m4a1', false);
    const sniper = resolveAiWeaponAudioProfile('dragunov_svd', false);
    const pistol = resolveAiWeaponAudioProfile('makarov_pm', false);
    const suppressed = resolveAiWeaponAudioProfile('hk_mp5', true);

    expect(rifle.weightClass).toBe('carbine');
    expect(rifle.muzzleVelocityMs).toBeGreaterThan(SPEED_OF_SOUND_MPS);
    expect(sniper.weightClass).toBe('heavy_rifle');
    expect(sniper.caliberMm).toBeGreaterThanOrEqual(7.6);
    expect(pistol.weightClass).toBe('pistol');
    expect(suppressed.suppressed).toBe(true);
  });
});

describe('Pillar 3 — Ballistic Supersonic Crack / Snap & Subsonic Whizz Audio', () => {
  it('computes exact Point of Closest Approach (PCA) on projectile segments', () => {
    const prev = new THREE.Vector3(0, 1.6, -20);
    const curr = new THREE.Vector3(0, 1.6, 20);
    const head = new THREE.Vector3(1.0, 1.6, 0);
    const closest = new THREE.Vector3();

    const res = evaluateBallisticFlybyPCA(prev, curr, head, BALLISTIC_FLYBY_MAX_RADIUS_M, false, closest);
    expect(res.t).toBeCloseTo(0.5, 4);
    expect(closest.x).toBeCloseTo(0, 4);
    expect(closest.z).toBeCloseTo(0, 4);
    expect(res.missDistM).toBeCloseTo(1.0, 4);
    expect(res.triggered).toBe(true);
  });

  it('classifies supersonic (>343 m/s) N-wave crack + chest thump + micro-flinch vs subsonic smooth whizz', () => {
    const superClose = classifyBallisticFlyby(860, 0.85, 5.56, 1750);
    const superMid = classifyBallisticFlyby(780, 3.2, 7.62, 2400);
    const subClose = classifyBallisticFlyby(295, 0.9, 9.0, 420);

    expect(superClose.isSupersonic).toBe(true);
    expect(superClose.machNumber).toBeGreaterThan(2.0);
    expect(superClose.hasChestThump).toBe(true);
    expect(superClose.triggerMicroFlinch).toBe(true);
    expect(superClose.flinchDeg).toBeGreaterThanOrEqual(0.3);
    expect(superClose.flinchDeg).toBeLessThanOrEqual(0.6);

    expect(superMid.isSupersonic).toBe(true);
    expect(superMid.hasChestThump).toBe(false);
    expect(superMid.triggerMicroFlinch).toBe(false);
    expect(superMid.flinchDeg).toBe(0);

    expect(subClose.isSupersonic).toBe(false);
    expect(subClose.hasChestThump).toBe(false);
    expect(subClose.triggerMicroFlinch).toBe(false);
    expect(subClose.flinchDeg).toBe(0);
  });

  it('triggers flyby audio strictly once per non-local bullet within 4.5m and ignores local player shots', () => {
    const scene = new THREE.Scene();
    const solver = new BallisticsSolver(scene);
    const playBallisticFlyby = vi.fn();
    const onSupersonicNearMiss = vi.fn();
    const ammo556 = getDefaultAmmoVariant('556x45');

    const flybyCtx = {
      listenerHeadPos: new THREE.Vector3(1.0, 1.6, 0),
      listenerRightDir: new THREE.Vector3(1, 0, 0),
      audio: { playBallisticFlyby } as unknown as BodycamAudio,
      onSupersonicNearMiss,
    };

    const dummyAdapter = {
      raycast: () => false,
    } as unknown as IBodycamWorldAdapter;

    // 1. Enemy supersonic bullet passing 1.0m from head
    solver.spawnShot({
      origin: new THREE.Vector3(0, 1.6, -15),
      direction: new THREE.Vector3(0, 0, 1),
      ammo: ammo556,
      weaponId: 'm4a1',
      weaponSpreadMOA: 0,
      isLocalPlayer: false,
      caliberMm: 5.56,
    });

    // 2. Local player bullet passing near head (must NEVER trigger flyby)
    solver.spawnShot({
      origin: new THREE.Vector3(0.5, 1.6, -10),
      direction: new THREE.Vector3(0, 0, 1),
      ammo: ammo556,
      weaponId: 'm4a1',
      weaponSpreadMOA: 0,
      isLocalPlayer: true,
      caliberMm: 5.56,
    });

    // 3. Distant enemy bullet passing 8m away (> 4.5m radius, must NOT trigger)
    solver.spawnShot({
      origin: new THREE.Vector3(9.0, 1.6, -15),
      direction: new THREE.Vector3(0, 0, 1),
      ammo: ammo556,
      weaponId: 'm4a1',
      weaponSpreadMOA: 0,
      isLocalPlayer: false,
      caliberMm: 5.56,
    });

    expect(BALLISTIC_FLYBY_MAX_RADIUS_M).toBe(4.5);

    for (let i = 0; i < 6; i++) {
      solver.update(0.016, dummyAdapter, undefined, flybyCtx);
    }

    expect(playBallisticFlyby).toHaveBeenCalledTimes(1);
    const params = playBallisticFlyby.mock.calls[0][0];
    expect(params.speedMs).toBeGreaterThan(SPEED_OF_SOUND_MPS);
    expect(params.missDistM).toBeLessThan(1.2);
    expect(onSupersonicNearMiss).toHaveBeenCalledTimes(1);

    solver.dispose();
  });

  it('applies involuntary bodycam micro-flinch without disrupting player aimYaw or aimPitch', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.03, 500);
    const rig = new WeaponRig(scene, true);
    const audio = new BodycamAudio();
    const controller = new BodycamController(camera, rig, audio);
    const yawBefore = controller.aimYaw;
    const pitchBefore = controller.aimPitch;
    controller.applyBallisticMicroFlinch(0.5, 1);
    expect(controller.aimYaw).toBe(yawBefore);
    expect(controller.aimPitch).toBe(pitchBefore);
    rig.dispose();
  });
});

describe('Pillar 4 — Infected Iris-Only Glow, Red-Eyed Runners & Legless Bleed-Out Crawlers', () => {
  it('applies strictly iris-only emissive mask (yellow for walkers/crawlers, red for runners)', () => {
    const hoodMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

    const zombieHead = buildAnatomicalHeadAssembly({
      variant: 'zombie',
      toneSeed: 0.42,
      hoodMaterial: hoodMat,
      frameMaterial: frameMat,
      irisGlowMode: 'yellow',
    });
    const zombieEyeMat = zombieHead.eyeBallL.material as THREE.MeshStandardMaterial;
    expect(zombieHead.getIrisGlow()).toBe('yellow');
    expect(zombieEyeMat.emissiveMap).toBeTruthy();
    expect(zombieEyeMat.emissiveIntensity).toBeGreaterThan(1.5);
    const yellowHex = zombieEyeMat.emissive.getHex();

    zombieHead.applyIrisGlow('red');
    expect(zombieHead.getIrisGlow()).toBe('red');
    expect(zombieEyeMat.emissive.getHex()).not.toBe(yellowHex);
    expect(zombieEyeMat.emissive.r).toBeGreaterThan(0.8);
    expect(zombieEyeMat.emissive.g).toBeLessThan(0.3);

    const operatorHead = buildAnatomicalHeadAssembly({
      variant: 'male',
      toneSeed: 0.25,
      hoodMaterial: hoodMat,
      frameMaterial: frameMat,
    });
    const opEyeMat = operatorHead.eyeBallL.material as THREE.MeshStandardMaterial;
    expect(operatorHead.getIrisGlow()).toBe('none');
    expect(opEyeMat.emissiveIntensity).toBe(0);

    for (const d of zombieHead.disposables) d.dispose();
    for (const d of operatorHead.disposables) d.dispose();
    hoodMat.dispose();
    frameMat.dispose();
  });

  it('severs zombie legs with exposed femur bone stumps and lowers crawler pelvis cleanly', () => {
    const lib = new InfectedZombieRigLibrary();
    const rig = lib.buildZombie('z_crawl_test', 'infected_civilian', 'walker');

    expect(rig.legsSevered).toBe(false);
    expect(rig.leftLowerLegGroup.visible).toBe(true);
    expect(rig.leftSeveredStumpGroup.visible).toBe(false);
    const initialHitCount = rig.hitMeshes.length;

    lib.setZombieVariant(rig, 'crawler');
    expect(rig.legsSevered).toBe(true);
    expect(rig.leftLowerLegGroup.visible).toBe(false);
    expect(rig.rightLowerLegGroup.visible).toBe(false);
    expect(rig.leftSeveredStumpGroup.visible).toBe(true);
    expect(rig.rightSeveredStumpGroup.visible).toBe(true);
    expect(rig.hitMeshes.length).toBeLessThan(initialHitCount);
    expect(rig.headAssembly.getIrisGlow()).toBe('yellow');

    lib.applyPose(rig, {
      mode: 'locomote',
      walkCycle: 1.2,
      speedMps: 0.9,
      tearPhase: 0,
      vaultT: 0,
      windupProgress: 0,
      staggerRatio: 0,
      deathProgress: 0,
      elapsedSec: 2,
      dt: 0.016,
      variant: 'crawler',
    });
    expect(rig.pelvisGroup.position.y).toBeLessThan(0.32);

    // Verify face-down prone orientation, forward -Z facing head, trailing stumps, low crawling arms, and floor clearance
    const getVisibleMinY = (root: THREE.Object3D): number => {
      let minY = Infinity;
      const box = new THREE.Box3();
      const visit = (obj: THREE.Object3D) => {
        if (!obj.visible) return;
        if ((obj as THREE.Mesh).isMesh) {
          box.setFromObject(obj);
          if (box.min.y < minY) minY = box.min.y;
        }
        for (const child of obj.children) visit(child);
      };
      visit(root);
      return minY;
    };

    const pelvisWorld = new THREE.Vector3();
    const headWorld = new THREE.Vector3();
    const stumpWorld = new THREE.Vector3();
    const handLWorld = new THREE.Vector3();
    const handRWorld = new THREE.Vector3();
    const headForward = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();

    for (const phase of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
      lib.applyPose(rig, {
        mode: 'locomote',
        walkCycle: phase,
        speedMps: 1.0,
        tearPhase: 0,
        vaultT: 0,
        windupProgress: 0,
        staggerRatio: 0,
        deathProgress: 0,
        elapsedSec: 1.5,
        dt: 0.016,
        variant: 'crawler',
      });
      rig.root.updateMatrixWorld(true);
      rig.pelvisGroup.getWorldPosition(pelvisWorld);
      rig.headGroup.getWorldPosition(headWorld);
      rig.leftSeveredStumpGroup.getWorldPosition(stumpWorld);
      rig.leftHandPivot.getWorldPosition(handLWorld);
      rig.rightHandPivot.getWorldPosition(handRWorld);
      rig.headGroup.getWorldQuaternion(headQuat);
      headForward.set(0, 0, -1).applyQuaternion(headQuat);

      // Head strictly forward of pelvis (-Z), facing forward, stumps trailing behind (+Z)
      expect(headWorld.z).toBeLessThan(pelvisWorld.z - 0.35);
      expect(stumpWorld.z).toBeGreaterThanOrEqual(pelvisWorld.z - 0.05);
      expect(headForward.z).toBeLessThan(-0.85);
      // Crawling hands stay low near floor (never waving overhead above head height)
      expect(handLWorld.y).toBeLessThan(headWorld.y - 0.20);
      expect(handRWorld.y).toBeLessThan(headWorld.y - 0.20);
      expect(handLWorld.z).toBeLessThan(headWorld.z);
      // Zero floor clipping on any visible mesh
      expect(getVisibleMinY(rig.root)).toBeGreaterThan(-0.01);
    }

    // Verify flat face-down death collapse stays above floor
    lib.applyPose(rig, {
      mode: 'death',
      walkCycle: 0,
      speedMps: 0,
      tearPhase: 0,
      vaultT: 0,
      windupProgress: 0,
      staggerRatio: 0,
      deathProgress: 1.0,
      elapsedSec: 2.0,
      dt: 0.016,
      variant: 'crawler',
    });
    rig.root.updateMatrixWorld(true);
    expect(getVisibleMinY(rig.root)).toBeGreaterThan(-0.02);

    lib.dispose();
  });

  it('spawns rare runners and natural crawlers, converts leg-shot zombies into crawlers, and bleeds them out over ~2 minutes', () => {
    expect(computeZombieSpawnVariant(3, 0.02)).toBe('runner');
    expect(computeZombieSpawnVariant(3, 0.15)).toBe('crawler');
    expect(computeZombieSpawnVariant(3, 0.85)).toBe('walker');

    const scene = new THREE.Scene();
    const map = makeMinimalInfectionMap();
    const audio = new BodycamAudio();
    const ai = new InfectionZombieAI(scene, map, audio, { zombieSpawnAmountMult: 1 });
    const playerPos = new THREE.Vector3(0, 0, 2);

    // Advance until first zombie spawns
    for (let i = 0; i < 40; i++) {
      ai.update(0.1, playerPos, true, () => {}, () => {});
      if (ai.getAliveZombieTargets().length > 0) break;
    }

    const targets = ai.getAliveZombieTargets();
    expect(targets.length).toBeGreaterThan(0);
    const target = targets[0];

    // Shoot lower legs repeatedly to sever legs into a live crawler
    let converted = false;
    for (let shot = 0; shot < 4; shot++) {
      const res = ai.applyBulletDamage(
        target.id,
        34,
        'limb',
        new THREE.Vector3(target.pos.x, target.pos.y + 0.42, target.pos.z),
        new THREE.Vector3(0, 0, -1),
      );
      if (res.convertedToCrawler) {
        converted = true;
        break;
      }
    }

    const summary = ai.getZombieActorSummary(target.id);
    expect(summary).not.toBeNull();
    expect(summary!.variant).toBe('crawler');
    expect(summary!.legsSevered).toBe(true);
    expect(summary!.alive).toBe(true);
    expect(summary!.irisGlow).toBe('yellow');
    expect(summary!.bleedOutRemainingSec).toBeGreaterThanOrEqual(CRAWLER_BLEED_OUT_MIN_SEC - 1);
    expect(summary!.bleedOutRemainingSec).toBeLessThanOrEqual(CRAWLER_BLEED_OUT_MAX_SEC + 1);
    if (target.variant !== 'crawler') {
      expect(converted).toBe(true);
    }

    // Head target height drops cleanly for prone crawler
    const headPos = new THREE.Vector3();
    expect(ai.getZombieHeadPosition(target.id, headPos)).toBe(true);
    expect(headPos.y - target.pos.y).toBeLessThan(0.6);

    // Simulate ~160s passing without attacking: crawler slowly bleeds out and dies cleanly
    for (let t = 0; t < 160; t++) {
      ai.update(1.0, playerPos, true, () => {}, () => {});
    }
    const postBleed = ai.getZombieActorSummary(target.id);
    expect(postBleed === null || postBleed.alive === false).toBe(true);

    ai.dispose();
  });
});

describe('Pillar 5 — Coupled 6-DOF Weapon Spring Physics, Platform Manual of Arms & Grip Wrapping', () => {
  it('tunes coupled spring-damper parameters by weapon mass (snappy pistol/MP5 vs heavier rifle/shotgun)', () => {
    const light = computeWeaponSpringTuning(0.68);
    const heavy = computeWeaponSpringTuning(1.38);

    expect(light.rotOmega).toBeGreaterThan(heavy.rotOmega);
    expect(light.posOmega).toBeGreaterThan(heavy.posOmega);
    expect(light.rotZeta).toBeGreaterThan(heavy.rotZeta);
    expect(heavy.counterTiltGain).toBeGreaterThan(light.counterTiltGain);
  });

  it('couples camera turn inertia into barrel lag, counter-tilt roll, and translational drag in WeaponRig', () => {
    const scene = new THREE.Scene();
    const rig = new WeaponRig(scene, true);
    rig.setWeaponProfile(SDK_WEAPON_PROFILES.hk_mp5, false);

    rig.addInertia(0.06, -0.02, 1.0);
    const adapter = { raycast: () => false } as unknown as IBodycamWorldAdapter;
    rig.updateRig(
      0.016,
      0.5,
      SDK_WEAPON_PROFILES.hk_mp5,
      0,
      0,
      false,
      false,
      false,
      true,
      1.0,
      0,
      0,
      new THREE.Vector3(0, 1.6, 0),
      new THREE.Quaternion(),
      adapter,
      DEFAULT_BODYCAM_SDK_CONFIG,
    );

    const snap = rig.getCoupledSpringSnapshot();
    expect(Math.abs(snap.lagYaw)).toBeGreaterThan(0.005);
    expect(Math.abs(snap.lagRoll)).toBeGreaterThan(0.001);
    expect(Math.abs(snap.motionPosX)).toBeGreaterThan(0.0001);

    rig.dispose();
  });

  it('resolves platform-specific manual of arms including MP5 H&K Slap, AR bolt-catch slap, AK rock-and-lock, and pistol cant', () => {
    expect(resolveReloadPlatformStyle('MP5RollerSMG', 'carbine', true)).toBe('mp5_hk_slap');
    expect(resolveReloadPlatformStyle('ARCarbine', 'carbine', true)).toBe('ar_bolt_catch');
    expect(resolveReloadPlatformStyle('AKStamped', 'carbine', true)).toBe('ak_rock_lock');
    expect(resolveReloadPlatformStyle('PistolModern', 'pistol', true)).toBe('pistol_cant');

    const scene = new THREE.Scene();
    const mp5Spec = SDK_WEAPON_PROFILES.hk_mp5;
    const asm = WeaponModelFactory.build(
      {
        id: mp5Spec.id,
        holdClass: mp5Spec.holdClass,
        barrelLengthM: mp5Spec.barrelLengthM,
        visualStyle: mp5Spec.visualStyle,
        finish: mp5Spec.finish,
        railType: mp5Spec.railType,
        rightHandSocket: mp5Spec.rightHandSocket,
        leftHandSocket: mp5Spec.leftHandSocket,
        muzzleOffset: mp5Spec.muzzleOffset,
        laserOffset: mp5Spec.laserOffset,
        supportsSuppressor: mp5Spec.supportsSuppressor,
      },
      false,
    );
    const animator = new WeaponAnimator(scene);
    animator.attachModel(asm, 'carbine', false);
    animator.setAmmoState(0, true);
    animator.triggerReload(2.0);

    expect(animator.isMp5HkSlap()).toBe(true);

    const shoulder = new THREE.Group();
    const pivot = new THREE.Group();
    shoulder.add(pivot);
    const outPos = new THREE.Vector3();
    const outRot = new THREE.Vector3();
    let sawHkSlapDownwardJolt = false;

    for (let i = 0; i < 45; i++) {
      animator.updatePoseGraph({
        dt: 0.05,
        elapsed: i * 0.05,
        isFirearm: true,
        isUnarmed: false,
        massHandlingFactor: 0.85,
        weightClass: 'carbine',
        aimYaw: 0,
        aimPitch: 0,
        isAds: false,
        isCanted: false,
        isSprinting: false,
        isMoving: false,
        bobPhase: 0,
        verticalMotionOffset: 0,
        pullbackRatio: 0,
        barrelLengthM: mp5Spec.barrelLengthM,
        vaultRetentionMode: 'NONE',
        vaultRetentionBlend: 0,
        adsSpeedMult: 1,
        cantAngleRad: 0.6,
        hipOffset: mp5Spec.hipOffset,
        cantOffset: mp5Spec.cantOffset,
        lowReadyOffset: mp5Spec.lowReadyOffset,
        lowReadyRotation: mp5Spec.lowReadyRotation,
        breathX: 0,
        breathY: 0,
        recoilZ: 0,
        recoilPitch: 0,
        recoilRoll: 0,
        sightMisalignPitch: 0,
        sightMisalignYaw: 0,
        sightMisalignRoll: 0,
        lagYaw: 0,
        lagPitch: 0,
        camWorldPos: new THREE.Vector3(0, 1.6, 0),
        camWorldQuat: new THREE.Quaternion(),
        shoulderAnchor: shoulder,
        weaponPivot: pivot,
      });
      if (animator.consumeMechanicalSpringImpulse(outPos, outRot)) {
        if (outPos.y < -0.08 && outRot.x < -0.15) {
          sawHkSlapDownwardJolt = true;
        }
      }
    }

    expect(sawHkSlapDownwardJolt).toBe(true);
    animator.dispose();
    asm.dispose();
  });

  it('derives tighter finger curls on slim grips/rails and wider arcs on chunky grips/quad-rails', () => {
    const slimMakarov = computeGeometryDrivenGripWrap(0.024, 0.038, 0.016);
    const chunkyDeagleQuad = computeGeometryDrivenGripWrap(0.036, 0.052, 0.033);

    expect(slimMakarov.primaryWrapTight).toBeGreaterThan(chunkyDeagleQuad.primaryWrapTight);
    expect(slimMakarov.primaryDistTight).toBeGreaterThan(chunkyDeagleQuad.primaryDistTight);
    expect(slimMakarov.supportWrapTight).toBeGreaterThan(chunkyDeagleQuad.supportWrapTight);
  });

  it('keeps left support hand locked (<2mm drift) onto primary weapon handguards during ADS upward pitch (-30° to +68°)', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1.6, 0.03, 500);
    const rig = new WeaponRig(scene, true);
    const audio = new BodycamAudio();
    const ctrl = new BodycamController(camera, rig, audio);
    const skel = new CharacterSkeleton(4, 'infection', 'MALE');
    scene.add(skel.root);
    const charAnim = new CharacterAnimator(skel, rig);

    const adapter = {
      raycast: () => false,
      getGroundHeight: () => 0,
      getSurfaceMaterial: () => 'concrete',
      sweepCapsule: (...args: unknown[]) => {
        const last = args[args.length - 1] as { hit?: boolean } | undefined;
        if (last && typeof last === 'object') {
          last.hit = false;
          return last;
        }
        return { hit: false };
      },
      sampleInterior: () => ({ isIndoor: false, material: 'concrete' }),
    } as unknown as IBodycamWorldAdapter;

    const adsInput = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      sprint: false,
      crouch: false,
      leanLeft: false,
      leanRight: false,
      ads: true,
      cant: false,
      holdBreath: false,
    };

    const handLPos = new THREE.Vector3();
    const sockLPos = new THREE.Vector3();
    const sockLQuat = new THREE.Quaternion();
    const handRPos = new THREE.Vector3();
    const sockRPos = new THREE.Vector3();

    for (const wid of ['m4a1', 'hk_mp5', 'remington_m24', 'benelli_m4'] as const) {
      const spec = SDK_WEAPON_PROFILES[wid];
      rig.setWeaponProfile(spec, false);
      for (const deg of [-30, 0, 25, 45, 68]) {
        const rad = THREE.MathUtils.degToRad(deg);
        ctrl.torsoPitch = rad;
        (ctrl as unknown as { targetTorsoPitch: number }).targetTorsoPitch = rad;
        ctrl.aimPitch = 0;
        for (let i = 0; i < 30; i++) {
          ctrl.update(0.016, i * 0.016, adsInput, adapter, spec, DEFAULT_BODYCAM_SDK_CONFIG);
          charAnim.update(0.016, i * 0.016, ctrl, adapter, spec);
        }
        skel.leftArm.hand.root.getWorldPosition(handLPos);
        rig.getLiveLeftHandSocketWorldTransform(sockLPos, sockLQuat);
        skel.rightArm.hand.root.getWorldPosition(handRPos);
        rig.rightHandSocketAnchor.getWorldPosition(sockRPos);

        expect(handLPos.distanceTo(sockLPos)).toBeLessThan(0.002);
        expect(handRPos.distanceTo(sockRPos)).toBeLessThan(0.002);
      }
    }

    skel.dispose();
    rig.dispose();
  });
});

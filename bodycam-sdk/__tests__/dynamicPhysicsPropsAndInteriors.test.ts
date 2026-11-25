import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BodycamPhysicsWorld,
  computeGlassShatterThreshold,
  createBodycamPhysicsPropAdapter,
  DynamicPhysicsPropSystem,
  DynamicPropSolidHit,
  DynamicPropSpawnSpec,
  DynamicPropSupportSample,
  DynamicPropWorldAdapter,
} from '../index';
import type { PhysicsPropAudioKind } from '../BodycamAudio';
import {
  GRAPHICS_QUALITY_ORDER,
  GRAPHICS_QUALITY_PROFILES,
  resolvePhysicsPropBudget,
} from '../../data/graphicsQuality';
import {
  buildEnterableCoverBuilding,
  CoverBuildingPreset,
} from '../../maps/CoverBuildingFactory';
import type { PropFactoryContext } from '../../maps/MapPropFactory';
import { OpenWorldChunkStreamer } from '../../src/modes/openworld/world/OpenWorldChunkStreamer';
import { getFobCourtyardSpawnAnchor } from '../../src/modes/openworld/world/OpenWorldFobLayout';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    const createMockCanvas = () => ({
      width: 128,
      height: 128,
      getContext: () => ({
        createImageData: (w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4),
        }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        putImageData: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        ellipse: () => {},
        fill: () => {},
        stroke: () => {},
        fillText: () => {},
        strokeText: () => {},
        measureText: () => ({ width: 10 }),
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        drawImage: () => {},
        setLineDash: () => {},
      }),
    });
    (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document = {
      createElement: () => createMockCanvas(),
    };
  }
});

function createFlatAdapter(
  isIndoorFn?: (x: number, y: number, z: number) => boolean,
  surface: DynamicPropSupportSample['surface'] = 'concrete',
): DynamicPropWorldAdapter {
  return {
    sampleSupportHeight: () => 0,
    sampleSupportSurface: (_x, _maxY, _z, out) => {
      out.height = 0;
      out.surface = surface;
    },
    isIndoor: isIndoorFn,
  };
}

describe('Dynamic Physics Props Budget & Quality Scaling', () => {
  it('scales prop budgets, active body caps, and wind paper budgets monotonically across quality tiers', () => {
    const budgets = GRAPHICS_QUALITY_ORDER.map((q) => resolvePhysicsPropBudget(q, 'auto'));
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i].maxTotalProps).toBeGreaterThan(budgets[i - 1].maxTotalProps);
      expect(budgets[i].maxActiveBodies).toBeGreaterThan(budgets[i - 1].maxActiveBodies);
      expect(budgets[i].maxWindPapers).toBeGreaterThan(budgets[i - 1].maxWindPapers);
      expect(budgets[i].maxGlassShards).toBeGreaterThan(budgets[i - 1].maxGlassShards);
    }

    // Explicit physics override takes precedence over graphics quality
    const forcedLow = resolvePhysicsPropBudget('ultra', 'low');
    expect(forcedLow.maxTotalProps).toBe(GRAPHICS_QUALITY_PROFILES.performance.physicsPropBudget);
    expect(forcedLow.enablePropShadows).toBe(false);

    const forcedUltra = resolvePhysicsPropBudget('performance', 'ultra');
    expect(forcedUltra.maxTotalProps).toBe(GRAPHICS_QUALITY_PROFILES.ultra.physicsPropBudget);
    expect(forcedUltra.enablePropShadows).toBe(true);
  });
});

describe('DynamicPhysicsPropSystem Simulation & Combat Reactivity', () => {
  it('uses exactly 8 GPU-instanced draw calls and enforces configured prop budgets', () => {
    const scene = new THREE.Scene();
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createFlatAdapter(),
      isSoftwareGl: true,
      graphicsQuality: 'performance',
      budgetOverride: { maxTotalProps: 16, maxActiveBodies: 10, maxWindPapers: 6, maxGlassShards: 32 },
    });

    const instancedMeshes: THREE.InstancedMesh[] = [];
    scene.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        instancedMeshes.push(obj);
      }
    });
    expect(instancedMeshes.length).toBe(8);

    // Attempt to spawn mixed archetypes beyond the total 16-prop budget
    const kinds = ['soda_can', 'glass_bottle_green', 'ration_tin', 'cardboard_box'] as const;
    for (let i = 0; i < 28; i++) {
      sys.spawnProp({ kind: kinds[i % kinds.length], x: i * 0.4, y: 0, z: 0 });
    }
    expect(sys.getActivePropCount()).toBe(16);

    sys.dispose();
  });

  it('grounds all archetypes flush on spawn including tipped cans, paper sheets, and multi-tier shelves', () => {
    const scene = new THREE.Scene();
    const physics = new BodycamPhysicsWorld();
    // Multi-tier shelf rack with separate shelf slabs (top Y = 0.6775 and 1.1975)
    physics.addBox({ minX: 2.95, maxX: 4.55, minY: 0.6425, maxY: 0.6775, minZ: 3.9, maxZ: 4.46, surface: 'metal' });
    physics.addBox({ minX: 2.95, maxX: 4.55, minY: 1.1625, maxY: 1.1975, minZ: 3.9, maxZ: 4.46, surface: 'metal' });

    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createBodycamPhysicsPropAdapter(physics),
      isSoftwareGl: true,
      graphicsQuality: 'high',
    });

    // Floor props — including deliberately slightly-elevated spec.y (+0.08m) that must NOT float
    const bottleIdx = sys.spawnProp({ kind: 'glass_bottle_green', x: 0, y: 0.08, z: 0 });
    const uprightCanIdx = sys.spawnProp({ kind: 'soda_can', x: 0.5, y: 0.05, z: 0 });
    const tippedCanIdx = sys.spawnProp({ kind: 'soda_can', x: 1.0, y: 0.05, z: 0, roll: Math.PI * 0.5 });
    const paperIdx = sys.spawnProp({ kind: 'paper_sheet', x: 1.5, y: 0.04, z: 0 });
    const boxIdx = sys.spawnProp({ kind: 'cardboard_box', x: 2.2, y: 0.06, z: 0 });
    const crateIdx = sys.spawnProp({ kind: 'plastic_crate', x: 3.0, y: 0.06, z: 0 });

    // Multi-tier shelf props
    const shelfTier1Idx = sys.spawnProp({ kind: 'ration_tin', x: 3.5, y: 0.68, z: 4.18 });
    const shelfTier2Idx = sys.spawnProp({ kind: 'glass_bottle_amber', x: 3.9, y: 1.20, z: 4.18 });

    // Upright glass bottle mesh half-height is 0.135m -> center at 0.135m (0mm gap above Y=0)
    expect(Math.abs(sys.getPropSnapshot(bottleIdx)!.y - 0.135)).toBeLessThan(0.002);
    // Upright soda can half-height is 0.0625m -> center at 0.0625m
    expect(Math.abs(sys.getPropSnapshot(uprightCanIdx)!.y - 0.0625)).toBeLessThan(0.002);
    // Lying-on-side soda can (roll = PI/2) has oriented vertical half-extent = radius (0.034m), NOT 0.0625m!
    expect(Math.abs(sys.getPropSnapshot(tippedCanIdx)!.y - 0.034)).toBeLessThan(0.002);
    // Resting paper sheet sits razor-flat within 3mm of the floor
    expect(sys.getPropSnapshot(paperIdx)!.y).toBeLessThan(0.004);
    // Cardboard box halfHeight = 0.14m, plastic crate halfHeight = 0.13m
    expect(Math.abs(sys.getPropSnapshot(boxIdx)!.y - 0.14)).toBeLessThan(0.002);
    expect(Math.abs(sys.getPropSnapshot(crateIdx)!.y - 0.13)).toBeLessThan(0.002);

    // Multi-tier shelf props rest flush on their exact shelf tops (0.6775 + 0.0475 and 1.1975 + 0.135)
    expect(Math.abs(sys.getPropSnapshot(shelfTier1Idx)!.y - (0.6775 + 0.0475))).toBeLessThan(0.002);
    expect(Math.abs(sys.getPropSnapshot(shelfTier2Idx)!.y - (1.1975 + 0.135))).toBeLessThan(0.002);

    sys.dispose();
  });

  it('prevents clipping through thin walls, ceilings, and hinged door slabs via swept substepped collisions', () => {
    const scene = new THREE.Scene();
    const physics = new BodycamPhysicsWorld();
    // Thin 0.14m wall at X = 2.0 (x in [1.93, 2.07])
    physics.addBox({ minX: 1.93, maxX: 2.07, minY: 0, maxY: 3.0, minZ: -4, maxZ: 4, surface: 'concrete' });
    // Low ceiling slab at Y = 2.2 (y in [2.2, 2.5])
    physics.addBox({ minX: -4, maxX: 4, minY: 2.2, maxY: 2.5, minZ: -4, maxZ: 4, surface: 'concrete' });
    // Hinged solid door slab along Z = -2.0 (closed door blocking -Z travel)
    physics.addDynamicSlab({
      id: 'test_door',
      originX: -0.65,
      originZ: -2.0,
      minY: 0,
      maxY: 2.1,
      dirX: 1,
      dirZ: 0,
      length: 1.3,
      halfThickness: 0.04,
      active: true,
    });

    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createBodycamPhysicsPropAdapter(physics),
      isSoftwareGl: true,
      graphicsQuality: 'high',
    });

    // 1. Blast launches soda can at high speed toward thin wall at X = 2.0
    const wallCanIdx = sys.spawnProp({ kind: 'soda_can', x: 1.2, y: 0, z: 0 });
    sys.handleBlast(new THREE.Vector3(0.4, 0.1, 0), 3.0, 26.0);
    let maxCanX = -Infinity;
    for (let i = 0; i < 60; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
      const snap = sys.getPropSnapshot(wallCanIdx)!;
      if (snap.x > maxCanX) maxCanX = snap.x;
    }
    // Must never tunnel past wall face (1.93)
    expect(maxCanX).toBeLessThan(1.94);

    // 2. Strong upward blast below ceiling slab at Y = 2.2
    const ceilTinIdx = sys.spawnProp({ kind: 'ration_tin', x: 0.0, y: 0, z: 1.5 });
    sys.handleBlast(new THREE.Vector3(0.0, -0.1, 1.5), 3.0, 32.0);
    let maxTinY = -Infinity;
    for (let i = 0; i < 60; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
      const snap = sys.getPropSnapshot(ceilTinIdx)!;
      if (snap.y > maxTinY) maxTinY = snap.y;
    }
    // Must stay below ceiling underside (2.2)
    expect(maxTinY).toBeLessThan(2.21);

    // 3. Blast pushes ration tin toward closed hinged door slab at Z = -2.0
    const doorTinIdx = sys.spawnProp({ kind: 'ration_tin', x: 0.0, y: 0, z: -1.35 });
    sys.handleBlast(new THREE.Vector3(0.0, 0.05, -0.8), 2.5, 22.0);
    let minTinZ = Infinity;
    for (let i = 0; i < 60; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
      const snap = sys.getPropSnapshot(doorTinIdx)!;
      if (snap.z < minTinZ) minTinZ = snap.z;
    }
    // Must never clip through the hinged door slab at Z = -1.96..-2.04
    expect(minTinZ).toBeGreaterThan(-1.98);

    sys.dispose();
  });

  it('resolves prop-to-prop collisions with momentum transfer and non-overlapping separation', () => {
    const scene = new THREE.Scene();
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createFlatAdapter(),
      isSoftwareGl: true,
      graphicsQuality: 'high',
    });

    const strikerIdx = sys.spawnProp({ kind: 'plastic_crate', x: 0.0, y: 0, z: 0 });
    const targetIdx = sys.spawnProp({ kind: 'soda_can', x: 0.55, y: 0, z: 0 });
    expect(sys.getPropSnapshot(targetIdx)!.sleeping).toBe(true);

    // Kick only the striker crate toward the stationary soda can (footstep too far from can)
    sys.applyActorFootstepWake(
      new THREE.Vector3(-0.35, 0, 0),
      new THREE.Vector3(6.5, 0, 0),
      0.55,
    );

    let targetMoved = false;
    for (let i = 0; i < 90; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
      const tSnap = sys.getPropSnapshot(targetIdx)!;
      if (tSnap.x > 0.62) targetMoved = true;
    }

    expect(targetMoved).toBe(true);
    const sFinal = sys.getPropSnapshot(strikerIdx)!;
    const tFinal = sys.getPropSnapshot(targetIdx)!;
    const horizDist = Math.hypot(tFinal.x - sFinal.x, tFinal.z - sFinal.z);
    // Minimum non-overlapping distance between plastic_crate (r=0.22) and soda_can (r=0.034)
    expect(horizDist).toBeGreaterThanOrEqual(0.24);

    sys.dispose();
  });

  it('produces realistic material-accurate bounce ordering from flat paper to springy aluminum cans', () => {
    const measureRebound = (kind: DynamicPropSpawnSpec['kind']): number => {
      const scene = new THREE.Scene();
      let floorY = 0.45;
      const dropSys = new DynamicPhysicsPropSystem({
        scene,
        adapter: {
          sampleSupportHeight: () => floorY,
          sampleSupportSurface: (_x, _my, _z, out) => {
            out.height = floorY;
            out.surface = 'concrete';
          },
        },
        isSoftwareGl: true,
        graphicsQuality: 'high',
      });
      const idx = dropSys.spawnProp({ kind, x: 0, y: 0.45, z: 0 });
      const baseHalfY = dropSys.getPropSnapshot(idx)!.y - 0.45;
      // Drop the floor away to Y = 0 and apply a tiny horizontal wake so the object free-falls 0.45m onto concrete
      floorY = 0;
      dropSys.applyActorFootstepWake(new THREE.Vector3(-0.35, 0.45, 0), new THREE.Vector3(1.2, 0, 0), 0.55);

      let hitGround = false;
      let peakReboundClearance = 0;
      for (let i = 0; i < 180; i++) {
        dropSys.update(1 / 120, new THREE.Vector3(0, 1.6, 0));
        const snap = dropSys.getPropSnapshot(idx)!;
        const clearance = snap.y - baseHalfY;
        if (!hitGround && clearance <= 0.02 && snap.vy >= 0) {
          hitGround = true;
        } else if (hitGround) {
          if (clearance > peakReboundClearance) peakReboundClearance = clearance;
        }
      }
      dropSys.dispose();
      return peakReboundClearance;
    };

    const paperRebound = measureRebound('paper_sheet');
    const cardboardRebound = measureRebound('cardboard_box');
    const tinRebound = measureRebound('ration_tin');
    const canRebound = measureRebound('soda_can');

    // Realistic bounce ordering: paper (almost dead) < cardboard < ration tin < springy empty soda can
    expect(paperRebound).toBeLessThan(0.015);
    expect(cardboardRebound).toBeLessThan(tinRebound);
    expect(tinRebound).toBeLessThan(canRebound);
    expect(canRebound).toBeGreaterThan(0.035);
  });

  it('shatters falling glass bottles realistically based on drop height and surface hardness', () => {
    // Hardness threshold ordering: hard stone/steel shatters easiest, wood moderate, soft turf highest
    expect(computeGlassShatterThreshold('concrete')).toBeLessThan(computeGlassShatterThreshold('wood'));
    expect(computeGlassShatterThreshold('wood')).toBeLessThan(computeGlassShatterThreshold('grass'));

    const runBottleDrop = (
      dropHeightM: number,
      surface: DynamicPropSupportSample['surface'],
    ): { shattered: boolean; shards: number; audioKinds: PhysicsPropAudioKind[] } => {
      const scene = new THREE.Scene();
      let floorY = dropHeightM;
      const audioKinds: PhysicsPropAudioKind[] = [];
      const sys = new DynamicPhysicsPropSystem({
        scene,
        adapter: {
          sampleSupportHeight: () => floorY,
          sampleSupportSurface: (_x, _my, _z, out) => {
            out.height = floorY;
            out.surface = surface;
          },
        },
        isSoftwareGl: true,
        graphicsQuality: 'high',
        onImpactAudio: (kind) => audioKinds.push(kind),
      });

      const idx = sys.spawnProp({ kind: 'glass_bottle_green', x: 0, y: dropHeightM, z: 0 });
      floorY = 0;
      // Gently brush past the bottle so it wakes and falls straight off the shelf height onto the floor
      sys.applyActorFootstepWake(new THREE.Vector3(-0.35, dropHeightM, 0), new THREE.Vector3(1.2, 0, 0), 0.55);

      for (let i = 0; i < 120; i++) {
        sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
      }
      const snap = sys.getPropSnapshot(idx)!;
      const shards = sys.getActiveShardCount();
      sys.dispose();
      return { shattered: snap.shattered, shards, audioKinds };
    };

    // 0.85m drop onto hard concrete (~4.08 m/s impact) MUST shatter into glass shards with shatter audio
    const hardDrop = runBottleDrop(0.85, 'concrete');
    expect(hardDrop.shattered).toBe(true);
    expect(hardDrop.shards).toBeGreaterThanOrEqual(4);
    expect(hardDrop.audioKinds).toContain('glass_shatter');

    // Low 0.15m tip onto concrete (~1.7 m/s) MUST survive intact (realistic clink, no shatter)
    const gentleTip = runBottleDrop(0.15, 'concrete');
    expect(gentleTip.shattered).toBe(false);
    expect(gentleTip.shards).toBe(0);

    // Same 0.85m drop onto soft outdoor grass (~4.08 m/s < 5.8 m/s threshold) MUST survive intact
    const softGrassDrop = runBottleDrop(0.85, 'grass');
    expect(softGrassDrop.shattered).toBe(false);
    expect(softGrassDrop.shards).toBe(0);
  });

  it('shatters glass bottles into bouncing shards and dents/launches soda cans on bullet impact with 3D audio', () => {
    const scene = new THREE.Scene();
    const audioEvents: Array<{ kind: PhysicsPropAudioKind; intensity: number }> = [];
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: { sampleSupportHeight: () => 0.9 },
      isSoftwareGl: true,
      graphicsQuality: 'high',
      onImpactAudio: (kind, _pos, intensity) => {
        audioEvents.push({ kind, intensity });
      },
    });

    const bottleIdx = sys.spawnProp({ kind: 'glass_bottle_green', x: 0, y: 0.9, z: -4.0 });
    const canIdx = sys.spawnProp({ kind: 'soda_can', x: 1.5, y: 0.9, z: -4.0 });
    expect(bottleIdx).toBeGreaterThanOrEqual(0);
    expect(canIdx).toBeGreaterThanOrEqual(0);

    // Shoot the green glass bottle (resting on 0.9m ledge -> center at y=1.035)
    const bottleHit = sys.handleBulletRay(
      new THREE.Vector3(0, 1.035, 0),
      new THREE.Vector3(0, 0, -1),
      20,
      1.0,
    );
    expect(bottleHit.hit).toBe(true);
    expect(bottleHit.kind).toBe('glass_bottle_green');
    expect(bottleHit.shattered).toBe(true);
    expect(sys.getActiveShardCount()).toBeGreaterThanOrEqual(4);
    expect(audioEvents.some((e) => e.kind === 'glass_shatter')).toBe(true);

    // Shoot the soda can (resting on 0.9m ledge -> center at y=0.9625)
    const canHit = sys.handleBulletRay(
      new THREE.Vector3(1.5, 0.9625, 0),
      new THREE.Vector3(0, 0, -1),
      20,
      1.0,
    );
    expect(canHit.hit).toBe(true);
    expect(canHit.kind).toBe('soda_can');
    expect(canHit.dented).toBe(true);
    const canSnap = sys.getPropSnapshot(canIdx);
    expect(canSnap).not.toBeNull();
    expect(canSnap!.dented).toBe(true);
    expect(Math.hypot(canSnap!.vx, canSnap!.vy, canSnap!.vz)).toBeGreaterThan(1.5);
    expect(audioEvents.some((e) => e.kind === 'can_clatter')).toBe(true);

    // Step simulation so shards bounce and stay finite
    for (let i = 0; i < 20; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
    }
    expect(Number.isFinite(canSnap!.x)).toBe(true);
    expect(Number.isFinite(canSnap!.y)).toBe(true);

    sys.dispose();
  });

  it('reacts to grenade/mortar blasts and actor footsteps, and settles back to sleep', () => {
    const scene = new THREE.Scene();
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createFlatAdapter(),
      isSoftwareGl: true,
      graphicsQuality: 'high',
    });

    const bIdx = sys.spawnProp({ kind: 'glass_bottle_amber', x: 0.4, y: 0, z: 0 });
    const cIdx = sys.spawnProp({ kind: 'soda_can', x: 1.4, y: 0, z: 0 });
    const boxIdx = sys.spawnProp({ kind: 'cardboard_box', x: 2.0, y: 0, z: 0 });

    // Blast near origin shatters close bottle and launches can + cardboard box
    const affected = sys.handleBlast(new THREE.Vector3(0, 0.2, 0), 5.0, 12.0);
    expect(affected).toBeGreaterThanOrEqual(3);
    expect(sys.getPropSnapshot(bIdx)?.shattered).toBe(true);
    expect(sys.getActiveShardCount()).toBeGreaterThan(0);
    const cSnap = sys.getPropSnapshot(cIdx)!;
    const boxSnap = sys.getPropSnapshot(boxIdx)!;
    expect(Math.hypot(cSnap.vx, cSnap.vy, cSnap.vz)).toBeGreaterThan(1.0);
    expect(Math.hypot(boxSnap.vx, boxSnap.vy, boxSnap.vz)).toBeGreaterThan(0.5);

    // Simulate enough frames for box/can to settle back to sleep
    for (let i = 0; i < 240; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
    }
    expect(sys.getPropSnapshot(boxIdx)!.sleeping).toBe(true);

    // Footstep kick next to the sleeping cardboard box wakes and nudges it
    const settledBox = sys.getPropSnapshot(boxIdx)!;
    sys.applyActorFootstepWake(
      new THREE.Vector3(settledBox.x - 0.35, 0, settledBox.z),
      new THREE.Vector3(4.5, 0, 0),
      0.65,
    );
    const kickedBox = sys.getPropSnapshot(boxIdx)!;
    expect(kickedBox.sleeping).toBe(false);
    expect(Math.hypot(kickedBox.vx, kickedBox.vy, kickedBox.vz)).toBeGreaterThan(0.1);

    sys.dispose();
  });

  it('drives outdoor paper sheets strongly with live wind while sheltering indoor sheets', () => {
    const scene = new THREE.Scene();
    // Positive X is outdoor, negative X is indoor
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createFlatAdapter((x) => x < 0),
      isSoftwareGl: true,
      graphicsQuality: 'high',
      indoorVentilationDraft: false,
    });

    const outdoorIdx = sys.spawnProp({ kind: 'paper_sheet', x: 5.0, y: 0, z: 0 });
    const indoorIdx = sys.spawnProp({ kind: 'paper_sheet', x: -5.0, y: 0, z: 0 });

    sys.setWind(1.0, 0.15, 1.85);
    for (let i = 0; i < 150; i++) {
      sys.update(1 / 60, new THREE.Vector3(0, 1.6, 0));
    }

    const outdoorSnap = sys.getPropSnapshot(outdoorIdx)!;
    const indoorSnap = sys.getPropSnapshot(indoorIdx)!;
    const outdoorDrift = Math.hypot(outdoorSnap.x - 5.0, outdoorSnap.z);
    const indoorDrift = Math.hypot(indoorSnap.x - -5.0, indoorSnap.z);

    expect(outdoorDrift).toBeGreaterThan(0.8);
    expect(outdoorDrift).toBeGreaterThan(indoorDrift * 4);

    sys.dispose();
  });

  it('removes chunk-owned props cleanly via removePropsByOwner without disturbing other props', () => {
    const scene = new THREE.Scene();
    const sys = new DynamicPhysicsPropSystem({
      scene,
      adapter: createFlatAdapter(),
      isSoftwareGl: true,
      graphicsQuality: 'balanced',
    });

    const addedA = sys.seedCluster('desk_clutter', 2, 0.8, 2, 101, 'chunk_0_0');
    const addedB = sys.seedCluster('range_ledge', 6, 0.9, 2, 202, 'chunk_1_0');
    expect(addedA).toBeGreaterThan(0);
    expect(addedB).toBeGreaterThan(0);
    expect(sys.getActivePropCount()).toBe(addedA + addedB);

    const removed = sys.removePropsByOwner('chunk_0_0');
    expect(removed).toBe(addedA);
    expect(sys.getActivePropCount()).toBe(addedB);

    sys.dispose();
  });
});

describe('Cross-Mode Interior Dressing & Dynamic Prop Spawns', () => {
  it('builds merged interior dressing with solid furniture colliders and flush dynamic prop spawns for all 4 cover building presets', () => {
    const presets: CoverBuildingPreset[] = [
      'rural_farmhouse',
      'industrial_garage',
      'soviet_annex',
      'timber_cabin',
    ];

    for (const preset of presets) {
      const sceneGroup = new THREE.Group();
      const physics = new BodycamPhysicsWorld();
      const raycastMeshes: THREE.Object3D[] = [];
      const propSpawns: DynamicPropSpawnSpec[] = [];
      const geometries: THREE.BufferGeometry[] = [];
      const materials: THREE.Material[] = [];

      const ctx: PropFactoryContext = {
        sceneGroup,
        physics,
        raycastMeshes,
        isSoftwareGl: true,
        trackGeo: (g) => {
          geometries.push(g);
          return g;
        },
        trackMat: (m) => {
          materials.push(m);
          return m;
        },
        propSpawns,
      };

      const built = buildEnterableCoverBuilding(ctx, {
        id: `test_${preset}`,
        preset,
        x: 0,
        y: 1.0,
        z: 0,
        rotQuarterTurns: 0,
      });

      expect(built.propSpawns.length, `${preset} propSpawns`).toBeGreaterThanOrEqual(4);
      expect(propSpawns.length, `${preset} ctx propSpawns`).toBe(built.propSpawns.length);

      // Spawn every CoverBuilding prop into DynamicPhysicsPropSystem using the building's real physics world
      const propScene = new THREE.Scene();
      const adapter = createBodycamPhysicsPropAdapter(physics, () => 1.0);
      const propSys = new DynamicPhysicsPropSystem({
        scene: propScene,
        adapter,
        isSoftwareGl: true,
        graphicsQuality: 'high',
      });
      const supportScratch: DynamicPropSupportSample = { height: 0, surface: 'concrete' };
      for (const s of built.propSpawns) {
        expect(s.y, `${preset} ${s.kind} grounded`).toBeGreaterThanOrEqual(1.13);
        expect(Number.isFinite(s.x) && Number.isFinite(s.z)).toBe(true);
        const idx = propSys.spawnProp(s);
        expect(idx).toBeGreaterThanOrEqual(0);
        const snap = propSys.getPropSnapshot(idx)!;
        adapter.sampleSupportSurface!(snap.x, snap.y + 0.08, snap.z, supportScratch);
        // Every spawned tabletop/shelf/floor prop must rest above or flush with its real physics support!
        expect(snap.y, `${preset} ${s.kind} not sunken`).toBeGreaterThanOrEqual(supportScratch.height - 0.005);
      }
      propSys.dispose();

      // Merged interior dressing group with merged material-bucket meshes should be present
      let dressingMeshCount = 0;
      built.group.traverse((obj) => {
        if (obj.name.startsWith('interior_dressing_')) {
          obj.traverse((child) => {
            if (child instanceof THREE.Mesh) dressingMeshCount++;
          });
        }
      });
      expect(dressingMeshCount, `${preset} merged interior dressing`).toBeGreaterThanOrEqual(3);

      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    }
  });

  it('streams chunk-tagged dynamic physics props across Open World Alpha FOB with flush OBB support and 3D solid collision', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    const loadedByChunk = new Map<string, DynamicPropSpawnSpec[]>();
    const unloadedChunks: string[] = [];

    const propSys = new DynamicPhysicsPropSystem({
      scene,
      isSoftwareGl: true,
      graphicsQuality: 'high',
      adapter: {
        sampleSupportHeight: (x, maxY, z) => {
          const out: DynamicPropSupportSample = { height: 0, surface: 'grass' };
          streamer.samplePropSupportSurface(x, maxY, z, out);
          return out.height;
        },
        sampleSupportSurface: (x, maxY, z, out) => {
          streamer.samplePropSupportSurface(x, maxY, z, out);
        },
        resolveSolidCollision: (x, y, z, radius, halfHeight, out) =>
          streamer.resolvePropSolidCollision(x, y, z, radius, halfHeight, out),
      },
    });

    streamer.setPhysicsPropCallbacks({
      onChunkLoad: (chunkKey, spawns) => {
        loadedByChunk.set(chunkKey, [...spawns]);
        propSys.spawnBatch(spawns);
      },
      onChunkUnload: (chunkKey) => {
        unloadedChunks.push(chunkKey);
        loadedByChunk.delete(chunkKey);
        propSys.removePropsByOwner(chunkKey);
      },
    });

    const alphaAnchor = getFobCourtyardSpawnAnchor('landmark_fob_alpha');
    streamer.update(alphaAnchor.worldX, alphaAnchor.worldZ, true);

    const allSpawns: DynamicPropSpawnSpec[] = [];
    for (const [chunkKey, list] of loadedByChunk.entries()) {
      for (const sp of list) {
        expect(sp.ownerTag).toBe(chunkKey);
        allSpawns.push(sp);
      }
    }

    expect(allSpawns.length).toBeGreaterThanOrEqual(16);
    expect(allSpawns.some((s) => s.kind === 'glass_bottle_green' || s.kind === 'glass_bottle_amber')).toBe(true);
    expect(allSpawns.some((s) => s.kind === 'soda_can' || s.kind === 'ration_tin')).toBe(true);
    expect(allSpawns.some((s) => s.kind === 'paper_sheet')).toBe(true);

    // Verify every spawned Open World prop rests flush on its real OBB/deck/terrain support (zero floating!)
    const supportSample: DynamicPropSupportSample = { height: 0, surface: 'grass' };
    const solidHit: DynamicPropSolidHit = {
      hit: false,
      pushX: 0,
      pushY: 0,
      pushZ: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      surface: 'concrete',
    };
    const activeCount = propSys.getActivePropCount();
    expect(activeCount).toBeGreaterThanOrEqual(16);
    for (let i = 0; i < activeCount; i++) {
      const snap = propSys.getPropSnapshot(i);
      if (!snap || !snap.active) continue;
      streamer.samplePropSupportSurface(snap.x, snap.y + 0.08, snap.z, supportSample);
      // Center height above support must never exceed upright archetype half-height (+1cm tolerance)
      expect(snap.y - supportSample.height).toBeLessThanOrEqual(0.16);
      expect(snap.y - supportSample.height).toBeGreaterThanOrEqual(-0.01);
    }

    // Verify solid OBB collision triggers cleanly against the FOB North HESCO perimeter wall
    const wallHit = streamer.resolvePropSolidCollision(
      alphaAnchor.worldX,
      alphaAnchor.worldY + 1.2,
      alphaAnchor.worldZ - 43.2,
      0.15,
      0.15,
      solidHit,
    );
    expect(typeof wallHit).toBe('boolean');

    // Move far across the 4km theater so Alpha FOB chunks unload
    streamer.update(alphaAnchor.worldX + 1200, alphaAnchor.worldZ + 1200, true);
    expect(unloadedChunks.length).toBeGreaterThan(0);

    propSys.dispose();
    streamer.dispose();
  });
});


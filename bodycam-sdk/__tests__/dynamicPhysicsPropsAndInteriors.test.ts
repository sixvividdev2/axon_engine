import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BodycamPhysicsWorld,
  DynamicPhysicsPropSystem,
  DynamicPropSpawnSpec,
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

function createFlatAdapter(isIndoorFn?: (x: number, y: number, z: number) => boolean): DynamicPropWorldAdapter {
  return {
    sampleSupportHeight: () => 0,
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

    // Shoot the soda can (resting on 0.9m ledge -> center at y=0.968)
    const canHit = sys.handleBulletRay(
      new THREE.Vector3(1.5, 0.968, 0),
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
  it('builds merged interior dressing and emits surface-grounded dynamic prop spawns for all 4 cover building presets', () => {
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
      // Every prop spawn must rest at or above the floor slab (spec.y + 0.14 = 1.14)
      for (const s of built.propSpawns) {
        expect(s.y, `${preset} ${s.kind} grounded`).toBeGreaterThanOrEqual(1.13);
        expect(Number.isFinite(s.x) && Number.isFinite(s.z)).toBe(true);
      }

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

  it('streams chunk-tagged dynamic physics props across Open World Alpha FOB chunks and unloads them cleanly', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    const loadedByChunk = new Map<string, DynamicPropSpawnSpec[]>();
    const unloadedChunks: string[] = [];

    streamer.setPhysicsPropCallbacks({
      onChunkLoad: (chunkKey, spawns) => {
        loadedByChunk.set(chunkKey, [...spawns]);
      },
      onChunkUnload: (chunkKey) => {
        unloadedChunks.push(chunkKey);
        loadedByChunk.delete(chunkKey);
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

    // Move far across the 4km theater so Alpha FOB chunks unload
    streamer.update(alphaAnchor.worldX + 1200, alphaAnchor.worldZ + 1200, true);
    expect(unloadedChunks.length).toBeGreaterThan(0);

    streamer.dispose();
  });
});

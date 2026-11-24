import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { BodycamAudio } from '../../../../bodycam-sdk';
import { OpenWorldAiDirector } from '../world/OpenWorldAiDirector';
import { OpenWorldAmbienceAudio } from '../world/OpenWorldAmbienceAudio';
import { MACRO_OCCLUDER_LAYER, OpenWorldAtmosphere } from '../world/OpenWorldAtmosphere';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import { getBakedOpenWorldSites } from '../world/OpenWorldCivilizationTopology';
import { OpenWorldFoliageBuilder } from '../world/OpenWorldFoliageBuilder';
import { evaluateOpenWorldHeight } from '../world/OpenWorldTerrain';
import { WildlifeManager } from '../world/WildlifeManager';

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

function buildTestCamera(posX: number, posY: number, posZ: number, yawRad = 0): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2200);
  cam.position.set(posX, posY, posZ);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(0, yawRad, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

describe('Open World Performance, Backface & Frustum Culling, LODs & Map Density Overhaul', () => {
  it('enforces FrontSide backface culling on all solid 3D world materials while keeping DoubleSide only on 2D foliage blades & wings', () => {
    const scene = new THREE.Scene();
    const atmo = new OpenWorldAtmosphere(scene, false);
    const streamer = new OpenWorldChunkStreamer(scene, false);
    const audio = new BodycamAudio();
    const ambience = new OpenWorldAmbienceAudio(audio);
    const wildlife = new WildlifeManager(scene, evaluateOpenWorldHeight, ambience, false);

    // Load an active forest + settlement region
    streamer.update(0, 0, true);

    const solidDoubleSideViolations: string[] = [];
    const allowedDoubleSideNames = new Set([
      'openworld_near_grass_ring',
      'chunk_grass',
      'chunk_ferns',
      'chunk_rushes',
      'chunk_brush',
    ]);

    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        // Sky dome intentionally uses BackSide; butterflies & open 2D botanical blades use DoubleSide
        if (m.side === THREE.DoubleSide) {
          const isAllowedBotanical =
            allowedDoubleSideNames.has(obj.name) ||
            (obj instanceof THREE.InstancedMesh &&
              (obj.geometry.getAttribute('aWingSide') !== undefined ||
                obj.geometry.getAttribute('aSway') !== undefined));
          if (!isAllowedBotanical) {
            solidDoubleSideViolations.push(`${obj.name || obj.type}:${m.type}`);
          }
        }
      }
    });

    expect(solidDoubleSideViolations).toEqual([]);

    // Confirm foliage solid clutter materials are explicitly FrontSide and 2D blade materials are DoubleSide
    const foliage = new OpenWorldFoliageBuilder(scene, false);
    const foliageMats = foliage.getSharedMaterials();
    expect(foliageMats.filter((m) => m.side === THREE.DoubleSide).length).toBe(4);
    expect(foliageMats.filter((m) => m.side === THREE.FrontSide).length).toBe(4);

    foliage.dispose();
    wildlife.dispose();
    ambience.dispose();
    streamer.dispose();
    atmo.dispose();
  });

  it('culls terrain chunks behind the player while preserving the 22m 360-deg safety halo and shadow-pass halo', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, false);
    const px = 0;
    const pz = 0;
    const py = evaluateOpenWorldHeight(px, pz) + 1.7;
    streamer.update(px, pz, true);

    const cam = buildTestCamera(px, py, pz, 0); // Looking toward -Z
    const resNormal = streamer.applyCameraCullingAndLods(cam, px, pz, false);

    // Out of 25 loaded chunks (5x5), chunks strictly behind (+Z) should be culled
    expect(resNormal.visibleChunks + resNormal.culledChunks).toBe(25);
    expect(resNormal.culledChunks).toBeGreaterThanOrEqual(6);
    expect(resNormal.visibleChunks).toBeLessThan(20);

    // Center chunk (where player stands, nearDist = 0 <= 22m) MUST remain visible
    const chunksRoot = streamer.rootGroup.getObjectByName('openworld_chunk_rings')!;
    const centerChunk = chunksRoot.getObjectByName('chunk_8_8_active') ?? chunksRoot.children.find((c) => c.name.includes('_active'));
    expect(centerChunk).toBeDefined();
    expect(centerChunk!.visible).toBe(true);

    // Far-behind mid chunk (+Z, 2 chunks behind) MUST be culled when shadow halo is off
    const behindMid = chunksRoot.children.find(
      (c) => c.name.endsWith('_mid') && c.position.z > pz + 350,
    );
    expect(behindMid).toBeDefined();
    expect(behindMid!.visible).toBe(false);

    // Shadow-pass preparation ensures close chunks behind player cast shadows into view
    streamer.prepareForShadowPass(px, pz);
    const nearBehindActive = chunksRoot.children.find(
      (c) => c.name.endsWith('_active') && c.position.z > pz + 180 && Math.abs(c.position.x - px) < 120,
    );
    if (nearBehindActive) {
      expect(nearBehindActive.visible).toBe(true);
    }

    // And keepShadowHalo=true keeps shadow-range active chunks visible on 15Hz shadow frames
    const resShadow = streamer.applyCameraCullingAndLods(cam, px, pz, true);
    expect(resShadow.visibleChunks).toBeGreaterThanOrEqual(resNormal.visibleChunks);
    expect(resShadow.culledChunks).toBeGreaterThan(0);

    streamer.dispose();
  });

  it('populates mid-range 5x5 conifer groves, 4km horizon forest canopy, 8 enterable camp outposts, and ambient smoke plumes', () => {
    const sites = getBakedOpenWorldSites();
    const camps = sites.filter((s) => s.kind === 'camp_outpost');
    expect(camps.length).toBe(8);
    expect(sites.length).toBe(43);

    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, false);
    streamer.update(0, 0, true);

    // 4km Horizon Forest Canopy + 1-draw-call ambient smoke plumes exist in horizon proxy
    const horizonForest = streamer.rootGroup.getObjectByName('horizon_forest_canopy') as THREE.InstancedMesh | undefined;
    expect(horizonForest).toBeDefined();
    expect(horizonForest!.count).toBeGreaterThan(250);
    expect(horizonForest!.layers.isEnabled(MACRO_OCCLUDER_LAYER)).toBe(true);

    const ambientSmoke = streamer.rootGroup.getObjectByName('openworld_ambient_smoke') as THREE.InstancedMesh | undefined;
    expect(ambientSmoke).toBeDefined();
    expect(ambientSmoke!.count).toBeGreaterThanOrEqual(48);
    streamer.updateAmbientSmoke(0.05);

    // Mid-range 5x5 wooded chunks carry low-poly conifer InstancedMeshes on MACRO_OCCLUDER_LAYER
    const chunksRoot = streamer.rootGroup.getObjectByName('openworld_chunk_rings')!;
    let midTreeMeshes = 0;
    chunksRoot.traverse((o) => {
      if (o instanceof THREE.InstancedMesh && o.name.startsWith('mid_conifers_')) {
        midTreeMeshes++;
        expect(o.layers.isEnabled(MACRO_OCCLUDER_LAYER)).toBe(true);
      }
    });
    expect(midTreeMeshes).toBeGreaterThanOrEqual(4);

    // Delta-triggered shadow updates stay idle when player & sun are stationary, and fire immediately on movement
    const atmo = new OpenWorldAtmosphere(scene, false);
    expect(atmo.consumeShadowUpdateNeeded(0.016, 0, 0)).toBe(true); // First frame dirty
    expect(atmo.consumeShadowUpdateNeeded(0.016, 0, 0)).toBe(false); // Stationary cooldown
    expect(atmo.consumeShadowUpdateNeeded(0.08, 4.5, 0)).toBe(true); // Moved > 3m after 15Hz gate

    atmo.dispose();
    streamer.dispose();
  });

  it('applies 3-tier AI Operator LODs, behind-camera culling, and active roadside checkpoint/camp patrols', () => {
    const scene = new THREE.Scene();
    const director = new OpenWorldAiDirector(scene, evaluateOpenWorldHeight, 'pmc_alpha', 1);

    const agents = director.getAliveAgents();
    // Base FOB + landmark squads + new roadside checkpoint & camp patrols
    expect(agents.length).toBeGreaterThanOrEqual(42);
    const roadPatrols = agents.filter((a) => a.callsign.includes('-RD-'));
    expect(roadPatrols.length).toBeGreaterThanOrEqual(14);

    // Position player facing -Z with agents placed at LOD0, LOD1, LOD2, and strictly behind camera
    const px = 0;
    const pz = 0;
    const py = evaluateOpenWorldHeight(px, pz) + 1.7;
    const cam = buildTestCamera(px, py, pz, 0);
    const frustum = new THREE.Frustum();
    const projScreen = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);

    // Mutate 4 distinct agents to exact test distances
    const aLod0 = agents[0];
    aLod0.x = 0;
    aLod0.z = -40; // 40m ahead -> LOD0
    aLod0.y = evaluateOpenWorldHeight(aLod0.x, aLod0.z);

    const aLod1 = agents[1];
    aLod1.x = 0;
    aLod1.z = -120; // 120m ahead -> LOD1
    aLod1.y = evaluateOpenWorldHeight(aLod1.x, aLod1.z);

    const aLod2 = agents[2];
    aLod2.x = 0;
    aLod2.z = -240; // 240m ahead -> LOD2 shared proxy
    aLod2.y = evaluateOpenWorldHeight(aLod2.x, aLod2.z);

    const aBehind = agents[3];
    aBehind.x = 0;
    aBehind.z = 55; // 55m strictly behind camera -> culled!
    aBehind.y = evaluateOpenWorldHeight(aBehind.x, aBehind.z);

    const aCloseBehind = agents[4];
    aCloseBehind.x = 0;
    aCloseBehind.z = 10; // 10m behind camera -> inside 18m close safety bubble -> visible!
    aCloseBehind.y = evaluateOpenWorldHeight(aCloseBehind.x, aCloseBehind.z);

    director.update(0.016, px, py, pz, true, true, false, 1.0, false, null, () => {}, { frustum });

    expect(aLod0.lodTier).toBe(0);
    expect(aLod0.rig.root.visible).toBe(true);
    expect(aLod0.shadowCastEnabled).toBe(true);

    expect(aLod1.lodTier).toBe(1);
    expect(aLod1.rig.root.visible).toBe(true);
    expect(aLod1.shadowCastEnabled).toBe(false);

    expect(aLod2.lodTier).toBe(2);
    expect(aLod2.rig.root.visible).toBe(false);
    const proxyMesh = director.rootGroup.getObjectByName('openworld_ai_lod2_proxies') as THREE.InstancedMesh | undefined;
    expect(proxyMesh).toBeDefined();
    expect(proxyMesh!.visible).toBe(true);
    expect(proxyMesh!.count).toBeGreaterThanOrEqual(1);

    expect(aBehind.rig.root.visible).toBe(false);
    expect(aCloseBehind.rig.root.visible).toBe(true);

    const tel = director.getTelemetry();
    expect(tel.lod0Count).toBeGreaterThanOrEqual(2);
    expect(tel.lod1Count).toBeGreaterThanOrEqual(1);
    expect(tel.lod2Count).toBeGreaterThanOrEqual(1);
    expect(tel.culledBehindCount).toBeGreaterThanOrEqual(1);

    director.dispose();
  });
});

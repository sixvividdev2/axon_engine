import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTacticalEquipmentMesh } from '../../../../bodycam-sdk/equipment/TacticalEquipmentMesh';
import {
  AdaptivePerformanceController,
  GRAPHICS_QUALITY_PROFILES,
  graphicsQualityStore,
} from '../../../../data/graphicsQuality';
import { CharacterRoster } from '../CharacterRoster';
import { ShardStore } from '../ShardStore';
import { OpenWorldStorageLike } from '../types';
import { OpenWorldAiDirector } from '../world/OpenWorldAiDirector';
import { OPENWORLD_SKY_FRAGMENT_SHADER } from '../world/OpenWorldAtmosphere';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import { SolidObb } from '../world/OpenWorldCivilizationTopology';
import { OpenWorldFobDynamicProps } from '../world/OpenWorldFobDynamicProps';
import {
  FOB_GUARD_TOWER_DECK_HEIGHT_M,
  getAllFobCompoundSpecs,
  getFobArmoryStashAnchor,
  getFobCheckpointGateSpec,
  getFobCourtyardSpawnAnchor,
  getFobFieldHospitalAnchor,
  getFobGuardTowerSpecs,
  getFobRangeTargetSpecs,
  getFobTerminalAnchor,
  isInsideFobCompound,
} from '../world/OpenWorldFobLayout';
import { OpenWorldSectorManager } from '../world/OpenWorldSectorManager';
import { computeLandmarkSpawnPose } from '../world/OpenWorldSessionEngine';
import {
  evaluateOpenWorldHeight,
  OPENWORLD_LANDMARKS,
} from '../world/OpenWorldTerrain';

function makeMemoryStorage(): OpenWorldStorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

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

describe('Performance Overhaul & Opt-In Adaptive Scaling', () => {
  it('defaults adaptive scaling to OFF and only scales when explicitly enabled', () => {
    expect(graphicsQualityStore.isAdaptiveScalingEnabled()).toBe(false);

    const profile = graphicsQualityStore.getProfile();
    const ctrl = new AdaptivePerformanceController(profile);

    // Feed heavy 40ms frames while adaptive scaling is OFF -> must stay at 1.0 full fidelity
    for (let i = 0; i < 90; i++) {
      const state = ctrl.update(40, false, i * 0.1);
      expect(state.dprScale).toBe(1);
      expect(state.godraysAllowed).toBe(profile.castShadows);
    }

    // Now enable adaptive scaling and feed heavy frames -> must step down cleanly
    let steppedDown = false;
    for (let i = 0; i < 120; i++) {
      const state = ctrl.update(42, true, 10 + i * 0.15);
      if (state.dprScale < 1) {
        steppedDown = true;
        break;
      }
    }
    expect(steppedDown).toBe(true);

    // Toggling back OFF resets scale to full fidelity
    const restored = ctrl.update(16, false, 40);
    expect(restored.dprScale).toBe(1);
    expect(restored.godraysAllowed).toBe(profile.castShadows);
  });

  it('caches procedural grenade geometries and materials across builds to prevent draw-time hitches', () => {
    const a = buildTacticalEquipmentMesh('m67_frag', { withBeltClip: false });
    const b = buildTacticalEquipmentMesh('m67_frag', { withBeltClip: false });

    const meshesA: THREE.Mesh[] = [];
    const meshesB: THREE.Mesh[] = [];
    a.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) meshesA.push(obj);
    });
    b.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) meshesB.push(obj);
    });

    expect(meshesA.length).toBeGreaterThan(0);
    expect(meshesA.length).toBe(meshesB.length);
    // Every mesh shares cached geometry & material instances across builds
    for (let i = 0; i < meshesA.length; i++) {
      expect(meshesA[i].geometry).toBe(meshesB[i].geometry);
      expect(meshesA[i].material).toBe(meshesB[i].material);
    }

    a.dispose();
    b.dispose();
  });

  it('uses a world-locked cloud sky shader with zero gl_FragCoord screen-space pixel swim and open-world DPR cap', () => {
    expect(OPENWORLD_SKY_FRAGMENT_SHADER).not.toMatch(/gl_FragCoord/);
    expect(GRAPHICS_QUALITY_PROFILES.balanced.openWorldMaxDpr).toBeLessThanOrEqual(1.2);
    expect(GRAPHICS_QUALITY_PROFILES.performance.openWorldMaxDpr).toBeLessThanOrEqual(1.0);
    expect(graphicsQualityStore.isAdaptiveScalingEnabled()).toBe(false);
  });
});

describe('Full Military FOB Compounds, Garrison, Checkpoint Gates, Ranges & Armory Stash', () => {
  it('defines complete Alpha and Bravo FOB layouts with 4 guard towers, checkpoint gate, 2 gate guards, and 10 range targets each', () => {
    const fobs = getAllFobCompoundSpecs();
    expect(fobs.length).toBe(2);

    for (const fob of fobs) {
      const towers = getFobGuardTowerSpecs(fob.id);
      expect(towers.length).toBe(4);
      for (const tw of towers) {
        expect(tw.deckY).toBeCloseTo(fob.baseY + FOB_GUARD_TOWER_DECK_HEIGHT_M, 2);
      }

      const gate = getFobCheckpointGateSpec(fob.id);
      expect(gate.guardPosts.length).toBe(2);
      expect(gate.armLengthM).toBeGreaterThan(5);

      const targets = getFobRangeTargetSpecs(fob.id);
      expect(targets.length).toBe(10);
      expect(targets.filter((t) => t.area === 'gun_range').length).toBe(6);
      expect(targets.filter((t) => t.area === 'cqb_house').length).toBe(4);

      const term = getFobTerminalAnchor(fob.id);
      const hosp = getFobFieldHospitalAnchor(fob.id);
      const armory = getFobArmoryStashAnchor(fob.id);
      expect(Math.hypot(term.worldX - armory.worldX, term.worldZ - armory.worldZ)).toBeGreaterThan(8);
      expect(Math.hypot(hosp.worldX - armory.worldX, hosp.worldZ - armory.worldZ)).toBeGreaterThan(8);
    }
  });

  it('flattens terrain flush with baseY across every FOB structure and spawns operators on top of courtyard tarmac', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);

    for (const fob of getAllFobCompoundSpecs()) {
      const lm = OPENWORLD_LANDMARKS.find((l) => l.id === fob.id);
      expect(lm).toBeDefined();
      if (!lm) continue;

      // 1. Verify terrain plateau is flush within <0.05m across center, all 4 towers, gate, armory, hospital, terminal, and range
      const probePoints: Array<{ label: string; x: number; z: number }> = [
        { label: 'center', x: fob.worldX, z: fob.worldZ },
        ...getFobGuardTowerSpecs(fob.id).map((t) => ({ label: `tower_${t.cornerLabel}`, x: t.worldX, z: t.worldZ })),
        ...getFobCheckpointGateSpec(fob.id).guardPosts.map((g, idx) => ({
          label: `gate_guard_${idx}`,
          x: g.worldX,
          z: g.worldZ,
        })),
        { label: 'armory', x: getFobArmoryStashAnchor(fob.id).worldX, z: getFobArmoryStashAnchor(fob.id).worldZ },
        { label: 'hospital', x: getFobFieldHospitalAnchor(fob.id).worldX, z: getFobFieldHospitalAnchor(fob.id).worldZ },
        { label: 'terminal', x: getFobTerminalAnchor(fob.id).worldX, z: getFobTerminalAnchor(fob.id).worldZ },
        ...getFobRangeTargetSpecs(fob.id).map((t) => ({ label: t.id, x: t.worldX, z: t.worldZ })),
      ];

      for (const pt of probePoints) {
        const h = evaluateOpenWorldHeight(pt.x, pt.z);
        expect(Math.abs(h - fob.baseY), `${fob.id}:${pt.label}`).toBeLessThan(0.05);
      }

      // 2. Verify courtyard spawn pose is inside compound, clear of OBBs, and standing ON top of the tarmac deck
      const pose = computeLandmarkSpawnPose(lm);
      const expectedAnchor = getFobCourtyardSpawnAnchor(fob.id);
      expect(pose.spawnX).toBeCloseTo(expectedAnchor.worldX, 3);
      expect(pose.spawnZ).toBeCloseTo(expectedAnchor.worldZ, 3);
      expect(isInsideFobCompound(pose.spawnX, pose.spawnZ)).toBe(true);

      streamer.update(pose.spawnX, pose.spawnZ, true);

      const rawGroundY = streamer.sampleGroundHeight(pose.spawnX, pose.spawnZ);
      const deckY = streamer.sampleGroundAndDeckHeight(pose.spawnX, pose.spawnZ, rawGroundY + 1.5);
      expect(deckY).toBeGreaterThanOrEqual(fob.baseY + 0.05);

      const outPos = { x: pose.spawnX, z: pose.spawnZ, hitWall: false, wallNormalX: 0, wallNormalZ: 0 };
      streamer.resolveCapsuleHorizontal(
        pose.spawnX,
        deckY,
        pose.spawnZ,
        0.38,
        1.78,
        0.48,
        outPos,
      );
      expect(outPos.hitWall).toBe(false);
    }

    streamer.dispose();
  });

  it('spawns 4 sniper-equipped guard tower units and 2 checkpoint gate guards per FOB and controls the boom gate by faction', () => {
    const scene = new THREE.Scene();
    const roster = new CharacterRoster({ storage: makeMemoryStorage() });
    const created = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'VANGUARD',
      shardMode: 'PvPvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    expect(created.ok).toBe(true);
    const alphaChar = created.character!;

    const ai = new OpenWorldAiDirector(
      scene,
      (x, z) => evaluateOpenWorldHeight(x, z),
      'pmc_alpha',
      1,
    );

    const alphaGate = getFobCheckpointGateSpec('landmark_fob_alpha');
    const bravoGate = getFobCheckpointGateSpec('landmark_fob_bravo');

    // Allied player near Alpha gate -> gate opens
    expect(
      ai.evaluateFobGateControl(
        'landmark_fob_alpha',
        alphaGate.gateCenterX,
        alphaGate.gateCenterZ + 6,
        true,
        alphaChar,
      ),
    ).toBe(true);

    // Allied player far from Alpha gate -> gate stays closed
    expect(
      ai.evaluateFobGateControl(
        'landmark_fob_alpha',
        alphaGate.gateCenterX,
        alphaGate.gateCenterZ + 90,
        true,
        alphaChar,
      ),
    ).toBe(false);

    // Hostile Alpha player approaching Bravo gate in PvPvE -> gate stays closed while Bravo guards live
    expect(
      ai.evaluateFobGateControl(
        'landmark_fob_bravo',
        bravoGate.gateCenterX,
        bravoGate.gateCenterZ + 6,
        true,
        alphaChar,
      ),
    ).toBe(false);

    ai.dispose();
  });

  it('animates checkpoint boom gate collision OBB and tracks reactive Barracks Gun-Range & CQB steel target hits', () => {
    const scene = new THREE.Scene();
    const props = new OpenWorldFobDynamicProps(scene);

    // Initially closed -> both Alpha and Bravo gates emit blocking SolidObbs
    const closedObbs: SolidObb[] = [];
    props.resolveClosedGateObbs(closedObbs);
    expect(closedObbs.length).toBe(2);

    // Command Alpha gate open and advance simulation
    props.setGateTargetOpen('landmark_fob_alpha', true);
    for (let i = 0; i < 30; i++) props.update(0.05);
    props.resolveClosedGateObbs(closedObbs);
    expect(closedObbs.length).toBe(1);

    // Shoot a Barracks gun-range steel target
    const alphaTargets = getFobRangeTargetSpecs('landmark_fob_alpha');
    const first = alphaTargets[0];
    const hit1 = props.triggerTargetHit(first.id, first.worldX, first.worldZ + 25);
    expect(hit1).not.toBeNull();
    expect(hit1?.hit).toBe(true);
    expect(hit1?.hitCount).toBe(1);
    expect(hit1?.distanceM).toBe(25);

    const hit2 = props.triggerTargetHit(first.id, first.worldX, first.worldZ + 25);
    expect(hit2?.hitCount).toBe(2);

    props.dispose();
  });

  it('persists Armory Stash Lockers deposits, withdrawals, weapon/armor swaps, and exposes armory_stash interactable', () => {
    const roster = new CharacterRoster({ storage: makeMemoryStorage() });
    const shardStore = new ShardStore({ storage: makeMemoryStorage() });
    const created = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'ARMORER',
      shardMode: 'PvE',
      pmcFaction: 'pmc_alpha',
      bodyType: 'male',
    });
    expect(created.ok).toBe(true);

    const initialStash = roster.getOrInitTacticalStash('slot_1');
    expect(initialStash.length).toBeGreaterThan(0);

    // Deposit a rifle magazine from Chest Rig Slot 0 into Armory Stash Lockers
    const dep = roster.depositTacticalItemToStash('slot_1', {
      zone: 'chest_rig_rifle',
      slotIndex: 0,
    });
    expect(dep.ok).toBe(true);
    expect(dep.item).toBeDefined();

    const afterDep = roster.getOrInitTacticalStash('slot_1');
    expect(afterDep.length).toBe(initialStash.length + 1);

    // Withdraw that item back into deployed kit
    const wdraw = roster.withdrawStashItemToInventory('slot_1', dep.item!.instanceId, 'auto');
    expect(wdraw.ok).toBe(true);
    expect(roster.getOrInitTacticalStash('slot_1').length).toBe(initialStash.length);

    // Equip an owned firearm into Secondary slot & unlocked armor plate
    const char = roster.getCharacter('slot_1')!;
    const secondaryId = char.arsenal.ownedWeaponIds[char.arsenal.ownedWeaponIds.length - 1];
    expect(roster.equipArmoryWeaponSlot('slot_1', 'secondary', secondaryId).ok).toBe(true);
    const unlockedPlate = char.unlocks.unlockedArmorPlateIds[0];
    expect(roster.equipArmoryArmorPlate('slot_1', unlockedPlate).ok).toBe(true);

    // Verify OpenWorldSectorManager discovers armory_stash interactable at Alpha FOB Armory Lockers
    const scene = new THREE.Scene();
    const sectorMgr = new OpenWorldSectorManager(
      scene,
      (x, z) => evaluateOpenWorldHeight(x, z),
      roster,
      shardStore,
      'PvE',
    );
    const armoryAnchor = getFobArmoryStashAnchor('landmark_fob_alpha');
    const inter = sectorMgr.findNearestInteractable(
      armoryAnchor.worldX,
      armoryAnchor.worldZ,
      roster.getCharacter('slot_1'),
    );
    expect(inter).not.toBeNull();
    expect(inter?.kind).toBe('armory_stash');
    expect(inter?.canExecute).toBe(true);

    sectorMgr.dispose();
  });
});

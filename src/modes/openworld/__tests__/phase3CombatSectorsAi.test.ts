import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CharacterRoster } from '../CharacterRoster';
import { processCharacterDeath } from '../PermadeathService';
import { ShardStore } from '../ShardStore';
import { OpenWorldStorageLike } from '../types';
import { DEFAULT_BODYCAM_SDK_CONFIG } from '../../../../bodycam-sdk';
import {
  computeEffectiveAiVisionRange,
  evaluateAiRelation,
  OpenWorldAiDirector,
} from '../world/OpenWorldAiDirector';
import { OpenWorldSectorManager } from '../world/OpenWorldSectorManager';
import {
  applyLensPresetToConfig,
  computeLandmarkSpawnPose,
  resolvePlayerArmorHit,
} from '../world/OpenWorldSessionEngine';
import { OPENWORLD_LANDMARKS } from '../world/OpenWorldTerrain';

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

function makeHarness() {
  const roster = new CharacterRoster({ storage: makeMemoryStorage() });
  const shards = new ShardStore({ storage: makeMemoryStorage() });
  return { roster, shards };
}

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    const createMockCanvas = () => {
      const canvas = {
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
          beginPath: () => {},
          closePath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          quadraticCurveTo: () => {},
          bezierCurveTo: () => {},
          stroke: () => {},
          fill: () => {},
          arc: () => {},
          ellipse: () => {},
          save: () => {},
          restore: () => {},
          translate: () => {},
          rotate: () => {},
          scale: () => {},
          clearRect: () => {},
          fillText: () => {},
          strokeText: () => {},
          setLineDash: () => {},
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          globalAlpha: 1,
          font: '',
          textAlign: 'left',
          textBaseline: 'alphabetic',
        }),
      };
      return canvas;
    };
    (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document =
      {
        createElement: (tag: string) => (tag === 'canvas' ? createMockCanvas() : {}),
      };
  }
});

describe('Phase 3: Perimeter Operations — Bodycam Combat, Dynamic Sectors & Tactical AI', () => {
  it('commits shard-isolated sector_flip capture, awards $1,500 & boosts PMC supply pool without touching the other shard', () => {
    const { roster, shards } = makeHarness();
    const created = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'ALPHA-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    });
    expect(created.ok).toBe(true);
    const char = created.character!;
    const cashBefore = char.cash;
    const pvpveBefore = shards.getShard('PvPvE');
    const pveBefore = shards.getShard('PvE');

    const scene = new THREE.Scene();
    const mgr = new OpenWorldSectorManager(scene, () => 45, roster, shards, 'PvPvE');

    const railyard = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_timberline_railyard')!;

    // While hostiles remain, sector is contested and does not advance capture
    const contestedEv = mgr.update(
      2.0,
      railyard.worldX,
      railyard.worldZ,
      roster.getCharacter('slot_0'),
      (sid) => (sid === railyard.id ? 2 : 0),
    );
    expect(contestedEv).toBeNull();
    const contestedSnap = mgr.getActiveSectorAt(railyard.worldX, railyard.worldZ);
    expect(contestedSnap?.contested).toBe(true);
    expect(contestedSnap?.liveCapturePct).toBe(0);

    // Once garrison is cleared, holding the zone (~5.6s at 18%/sec) flips ownership
    let flipped = null;
    for (let i = 0; i < 12; i++) {
      const ev = mgr.update(
        0.55,
        railyard.worldX,
        railyard.worldZ,
        roster.getCharacter('slot_0'),
        () => 0,
      );
      if (ev) {
        flipped = ev;
        break;
      }
    }

    expect(flipped).not.toBeNull();
    expect(flipped!.sectorId).toBe('landmark_timberline_railyard');
    expect(flipped!.newOwner).toBe('pmc_alpha');
    expect(flipped!.cashBonusUsd).toBe(1500);

    // Discrete shard write verified in PvPvE; PvE shard completely isolated
    const pvpveAfter = shards.getShard('PvPvE');
    const pveAfter = shards.getShard('PvE');
    expect(pvpveAfter.sectors['landmark_timberline_railyard'].owner).toBe('pmc_alpha');
    expect(pvpveAfter.territoryCounts.pmc_alpha).toBe(pvpveBefore.territoryCounts.pmc_alpha + 1);
    expect(pvpveAfter.pmcSupplyPools.pmc_alpha.ammo).toBeGreaterThan(
      pvpveBefore.pmcSupplyPools.pmc_alpha.ammo,
    );
    expect(pvpveAfter.recentTransitions[0]?.type).toBe('sector_flip');
    expect(roster.getCharacter('slot_0')!.cash).toBe(cashBefore + 1500);

    expect(pveAfter.sectors['landmark_timberline_railyard'].owner).toBe('neutral');
    expect(pveAfter.revision).toBe(pveBefore.revision);

    mgr.dispose();
  });

  it('enforces Dual-Shard AI ROE (PvPvE hostile rival PMC vs PvE ceasefire) and Sub-Faction standing/provocation', () => {
    const baseStanding = {
      dockworkers_syndicate: 60, // Trusted -> allied
      highland_militia: 5, // Neutral
      alpine_remnant: -40, // Hostile
    } as const;
    const unprovoked = new Set<'dockworkers_syndicate' | 'highland_militia' | 'alpine_remnant'>();

    // Rival PMC ROE differs strictly by ShardMode
    expect(evaluateAiRelation('pmc_bravo', 'PvPvE', 'pmc_alpha', baseStanding, unprovoked)).toBe(
      'hostile',
    );
    expect(evaluateAiRelation('pmc_bravo', 'PvE', 'pmc_alpha', baseStanding, unprovoked)).toBe(
      'allied',
    );
    expect(evaluateAiRelation('pmc_alpha', 'PvPvE', 'pmc_alpha', baseStanding, unprovoked)).toBe(
      'allied',
    );

    // Sub-Faction standing tiers
    expect(
      evaluateAiRelation('dockworkers_syndicate', 'PvPvE', 'pmc_alpha', baseStanding, unprovoked),
    ).toBe('allied');
    expect(
      evaluateAiRelation('highland_militia', 'PvPvE', 'pmc_alpha', baseStanding, unprovoked),
    ).toBe('neutral');
    expect(
      evaluateAiRelation('alpine_remnant', 'PvPvE', 'pmc_alpha', baseStanding, unprovoked),
    ).toBe('hostile');

    // Provoking a neutral sub-faction flips them hostile
    const provoked = new Set<'dockworkers_syndicate' | 'highland_militia' | 'alpine_remnant'>([
      'highland_militia',
    ]);
    expect(
      evaluateAiRelation('highland_militia', 'PvPvE', 'pmc_alpha', baseStanding, provoked),
    ).toBe('hostile');

    // Verify OpenWorldAiDirector real friendly-fire damage + standing penalty + retaliation in PvE
    const { roster } = makeHarness();
    const pveChar = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'COOP-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvE',
      bodyType: 'female',
    }).character!;

    const scene = new THREE.Scene();
    const ai = new OpenWorldAiDirector(scene, () => 40, 'pmc_alpha');
    const bravoAgent = ai.getAliveAgents().find((a) => a.faction === 'pmc_bravo')!;
    const friendlyHit = ai.applyDamage(bravoAgent.id, 30, 'torso', pveChar);
    expect(friendlyHit.blockedFriendly).toBe(false);
    expect(friendlyHit.hit).toBe(true);
    expect(friendlyHit.friendlyFire).toBe(true);
    expect(friendlyHit.standingPenalty).toBeGreaterThan(0);
    expect(bravoAgent.hp).toBeLessThan(100);
    expect(bravoAgent.retaliationHostile).toBe(true);

    // Eliminating a sub-faction operator returns standing penalty & rival gain
    const militiaAgent = ai.getAliveAgents().find((a) => a.faction === 'highland_militia')!;
    const lethalHit = ai.applyDamage(militiaAgent.id, 80, 'head', pveChar);
    expect(lethalHit.hit).toBe(true);
    expect(lethalHit.eliminated).toBeDefined();
    expect(lethalHit.eliminated!.headshot).toBe(true);
    expect(lethalHit.eliminated!.subFactionStandingDelta?.subFactionId).toBe('highland_militia');
    expect(lethalHit.eliminated!.subFactionStandingDelta?.delta).toBeLessThan(0);
    expect(lethalHit.eliminated!.subFactionStandingDelta?.rivalDelta).toBeGreaterThan(0);

    ai.dispose();
  });

  it('scales AI visual detection cone with day/night + weather and reveals night flashlights', () => {
    const clearDayRange = computeEffectiveAiVisionRange(1.0, false, false);
    const coastalFogRange = computeEffectiveAiVisionRange(0.45, false, false);
    const nightStealthRange = computeEffectiveAiVisionRange(0.32, false, true);
    const nightFlashlightRange = computeEffectiveAiVisionRange(0.32, true, true);

    expect(clearDayRange).toBeGreaterThan(coastalFogRange);
    expect(coastalFogRange).toBeGreaterThan(nightStealthRange);
    expect(nightFlashlightRange).toBeGreaterThan(nightStealthRange);
  });

  it('mitigates 65% ballistic damage on intact armor plates and triggers Field Hospital vs Permadeath on lethal HP loss', () => {
    const armoredHit = resolvePlayerArmorHit(100, 100, 20);
    expect(armoredHit.absorbedByArmor).toBeCloseTo(13, 4);
    expect(armoredHit.nextArmor).toBeCloseTo(87, 4);
    expect(armoredHit.hpDamage).toBeCloseTo(7, 4);
    expect(armoredHit.nextHp).toBeCloseTo(93, 4);

    // Unarmored lethal hit depletes HP to 0
    const lethalUnarmored = resolvePlayerArmorHit(18, 0, 24);
    expect(lethalUnarmored.nextHp).toBe(0);
    expect(lethalUnarmored.absorbedByArmor).toBe(0);

    // Lethal death with insufficient funds wipes character via PermadeathService
    const { roster, shards } = makeHarness();
    const brokeChar = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'BROKE-7',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;
    roster.adjustCash('slot_1', -(brokeChar.cash - 100)); // Below $2,500 Field Hospital fee

    const outcome = processCharacterDeath(roster, shards, {
      slotId: 'slot_1',
      worldX: 250,
      worldZ: -120,
      sectorLabel: 'Timberline Rail Yard',
      causeOfDeath: 'Eliminated by BRAVO-04',
    });
    expect(outcome.outcome).toBe('permadeath_wiped');
    expect(roster.getCharacter('slot_1')).toBeNull();
    expect(shards.getShard('PvPvE').corpses.length).toBe(1);
  });

  it('enforces PvPvE vs PvE corpse looting rules and blocks in-world contract terminals until hostile garrison is cleared', () => {
    const { roster, shards } = makeHarness();
    const pveOwner = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'OWNER-PVE',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvE',
      bodyType: 'male',
    }).character!;
    const pveOther = roster.createCharacter({
      slotId: 'slot_1',
      callsign: 'OTHER-PVE',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvE',
      bodyType: 'female',
    }).character!;

    const pveCorpse = shards.addDroppedCorpse('PvE', {
      corpseId: 'corpse_pve_1',
      ownerCharacterId: pveOwner.characterId,
      ownerCallsign: pveOwner.callsign,
      ownerFaction: pveOwner.pmcFaction,
      worldX: 0,
      worldZ: 0,
      sectorLabel: 'Port Terminal',
      causeOfDeath: 'Hostile sniper fire',
      droppedWeaponIds: ['ak74m'],
      droppedArmorName: 'JPC-2 Plate Carrier',
      droppedRigName: 'Mk4 Micro Chest Rig',
      droppedItems: [
        {
          instanceId: 'item_inst_1',
          itemId: 'ifak_medkit',
          name: 'IFAK Medkit',
          category: 'medical',
          quantity: 1,
          valueUsd: 450,
          slots: 1,
        },
      ],
      createdAtIso: new Date().toISOString(),
    });

    // Other player blocked from looting PvE corpse; owner allowed
    const denied = shards.lootAndRemoveCorpse(
      'PvE',
      pveCorpse.corpseId,
      pveOther.characterId,
      pveOther.callsign,
    );
    expect(denied.ok).toBe(false);

    const recovered = shards.lootAndRemoveCorpse(
      'PvE',
      pveCorpse.corpseId,
      pveOwner.characterId,
      pveOwner.callsign,
    );
    expect(recovered.ok).toBe(true);
    expect(shards.getShard('PvE').corpses.length).toBe(0);

    // Contract terminal blocked while hostile garrison count > 0, succeeds once cleared
    const scene = new THREE.Scene();
    const mgr = new OpenWorldSectorManager(scene, () => 20, roster, shards, 'PvE');
    const portLm = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_port_terminal')!;

    // Update with 2 hostiles present
    mgr.update(0.1, portLm.worldX + 6.5, portLm.worldZ + 6.5, pveOwner, (sid) =>
      sid === portLm.id ? 2 : 0,
    );
    const blocked = mgr.executeContractTerminal('contract_port_manifest', pveOwner);
    expect(blocked.ok).toBe(false);

    // Update with 0 hostiles -> contract uploads and grants per-character unlocks only to slot_0
    mgr.update(0.1, portLm.worldX + 6.5, portLm.worldZ + 6.5, pveOwner, () => 0);
    const completed = mgr.executeContractTerminal('contract_port_manifest', pveOwner);
    expect(completed.ok).toBe(true);

    const updatedOwner = roster.getCharacter('slot_0')!;
    const untouchedOther = roster.getCharacter('slot_1')!;
    expect(updatedOwner.unlocks.completedContractIds).toContain('contract_port_manifest');
    expect(untouchedOther.unlocks.completedContractIds).not.toContain('contract_port_manifest');
    expect(shards.getShard('PvE').recentTransitions[0]?.type).toBe('reputation_update');

    mgr.dispose();
  });

  it('frames initial FOB and landmark spawns directly toward each base compound and 4km horizon', () => {
    for (const lm of OPENWORLD_LANDMARKS) {
      const pose = computeLandmarkSpawnPose(lm);
      // Forward vector in Three.js YXZ Euler is (-sin(yaw), 0, -cos(yaw))
      const fwdX = -Math.sin(pose.faceYaw);
      const fwdZ = -Math.cos(pose.faceYaw);
      const toX = lm.worldX - pose.spawnX;
      const toZ = lm.worldZ - pose.spawnZ;
      const len = Math.hypot(toX, toZ);
      expect(len).toBeGreaterThan(20);
      const dot = (fwdX * toX + fwdZ * toZ) / len;
      expect(dot).toBeGreaterThan(0.999);
      expect(pose.footPitch).toBeCloseTo(-0.04, 3);
    }

    // Alpha FOB spawns southwest facing northeast toward central valley/alpine peaks
    const alphaFob = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_fob_alpha')!;
    const alphaPose = computeLandmarkSpawnPose(alphaFob);
    expect(alphaPose.spawnX).toBeLessThan(alphaFob.worldX);
    expect(alphaPose.spawnZ).toBeGreaterThan(alphaFob.worldZ);

    // Bravo FOB spawns northeast facing southwest toward quarry/coast horizon
    const bravoFob = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_fob_bravo')!;
    const bravoPose = computeLandmarkSpawnPose(bravoFob);
    expect(bravoPose.spawnX).toBeGreaterThan(bravoFob.worldX);
    expect(bravoPose.spawnZ).toBeLessThan(bravoFob.worldZ);
  });

  it('keeps aiming, FOV, deadzone, and recoil physics 100% invariant when switching optical lens presets', () => {
    const cfg = { ...DEFAULT_BODYCAM_SDK_CONFIG };
    const physicsBefore = {
      baseHFovDeg: cfg.baseHFovDeg,
      adsHFovDeg: cfg.adsHFovDeg,
      sprintHFovDeg: cfg.sprintHFovDeg,
      deadzoneYawDeg: cfg.deadzoneYawDeg,
      deadzonePitchDeg: cfg.deadzonePitchDeg,
      torsoFollowStiffness: cfg.torsoFollowStiffness,
      adsCameraShakeScale: cfg.adsCameraShakeScale,
      hipRecoilSwayScale: cfg.hipRecoilSwayScale,
      weaponInertiaScale: cfg.weaponInertiaScale,
    };

    for (const preset of ['gopro_chest', 'clean_raw', 'axon_body_4'] as const) {
      applyLensPresetToConfig(cfg, preset);
      expect(cfg.lensPreset).toBe(preset);
      expect(cfg.baseHFovDeg).toBe(physicsBefore.baseHFovDeg);
      expect(cfg.adsHFovDeg).toBe(physicsBefore.adsHFovDeg);
      expect(cfg.sprintHFovDeg).toBe(physicsBefore.sprintHFovDeg);
      expect(cfg.deadzoneYawDeg).toBe(physicsBefore.deadzoneYawDeg);
      expect(cfg.deadzonePitchDeg).toBe(physicsBefore.deadzonePitchDeg);
      expect(cfg.torsoFollowStiffness).toBe(physicsBefore.torsoFollowStiffness);
      expect(cfg.adsCameraShakeScale).toBe(physicsBefore.adsCameraShakeScale);
      expect(cfg.hipRecoilSwayScale).toBe(physicsBefore.hipRecoilSwayScale);
      expect(cfg.weaponInertiaScale).toBe(physicsBefore.weaponInertiaScale);
    }
  });

  it('spawns Battle-parity mixed MALE/FEMALE operators with procedural weapons, 2-bone IK pose updates, and ArticulatedRagdoll terrain collapse', () => {
    const { roster } = makeHarness();
    const player = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'RECON-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;

    const scene = new THREE.Scene();
    const groundHeight = (x: number, z: number) => 22 + Math.sin(x * 0.01) * 1.5 + Math.cos(z * 0.01);
    const ai = new OpenWorldAiDirector(scene, groundHeight, 'pmc_alpha');
    const alive = ai.getAliveAgents();

    // Mixed MALE & FEMALE rigs across factions
    expect(alive.length).toBeGreaterThan(10);
    expect(alive.some((a) => a.operatorId === 'MALE')).toBe(true);
    expect(alive.some((a) => a.operatorId === 'FEMALE')).toBe(true);

    // Every operator uses Battle mode TacticalOperatorRig with a real procedural weapon + anatomical hitboxes
    for (const agent of alive) {
      expect(agent.rig.weaponSocket.children.length).toBeGreaterThan(0);
      expect(agent.rig.hitMeshes.length).toBeGreaterThanOrEqual(4);
      expect(agent.rig.hitMeshes.every((m) => m.userData.openWorldAiId === agent.id)).toBe(true);
      expect(agent.rig.hitMeshes.some((m) => m.userData.hitZone === 'head')).toBe(true);
      expect(agent.rig.hitMeshes.some((m) => m.userData.hitZone === 'torso')).toBe(true);
      expect(agent.rig.hitMeshes.some((m) => m.userData.hitZone === 'limb')).toBe(true);
    }

    // Engage a hostile agent within active simulation radius to exercise 2-bone IK combat pose
    const target = alive.find((a) => a.faction === 'pmc_bravo')!;
    const playerX = target.x + 18;
    const playerZ = target.z + 6;
    const playerY = groundHeight(playerX, playerZ) + 1.65;

    for (let i = 0; i < 6; i++) {
      ai.update(0.05, playerX, playerY, playerZ, true, true, false, 1.0, false, player, () => {});
    }
    expect(target.adsBlend).toBeGreaterThan(0);

    // Lethal headshot activates Battle ArticulatedRagdoll collapse on terrain
    const impactDir = new THREE.Vector3(-1, -0.05, -0.3).normalize();
    const hit = ai.applyDamage(target.id, 120, 'head', player, impactDir);
    expect(hit.hit).toBe(true);
    expect(hit.eliminated?.headshot).toBe(true);
    expect(ai.isAgentAlive(target.id)).toBe(false);
    expect(target.ragdoll.isActive()).toBe(true);
    expect(target.rig.root.visible).toBe(true);

    // Stepping simulation advances ragdoll physics onto terrain heightfield cleanly
    for (let i = 0; i < 10; i++) {
      ai.update(0.016, playerX, playerY, playerZ, true, true, false, 1.0, false, player, () => {});
    }
    expect(target.ragdoll.isActive()).toBe(true);
    expect(target.rig.root.visible).toBe(true);

    ai.dispose();
  });
});

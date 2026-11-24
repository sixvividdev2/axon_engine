import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CharacterRoster } from '../CharacterRoster';
import { ShardStore } from '../ShardStore';
import { OpenWorldStorageLike } from '../types';
import { OpenWorldAiDirector, type AiNeutralWarningEvent } from '../world/OpenWorldAiDirector';
import { OpenWorldSectorManager } from '../world/OpenWorldSectorManager';
import { OpenWorldChunkStreamer } from '../world/OpenWorldChunkStreamer';
import {
  FOB_TRADER_OFFERS,
  RESTOCK_INTERVAL_HIGH_SEC,
  RESTOCK_INTERVAL_STRAINED_SEC,
  RESTOCK_INTERVAL_STARVED_SEC,
  classifySupplyTier,
  computeUnifiedRestockRemainingSec,
  evaluateSupplyResourceStatus,
} from '../world/OpenWorldLogisticsEconomy';
import { createPdaBatteryItem } from '../inventory/TetrisInventoryCore';
import { TacticalPdaDevice } from '../../../../bodycam-sdk/TacticalPdaDevice';
import { resolveWeaponProfile } from '../../../../bodycam-sdk/weaponProfiles';
import { WeaponModelFactory } from '../../../../bodycam-sdk/weapons/WeaponModelFactory';
import {
  DEFAULT_SPECIAL_EVENT_CONFIG,
  sanitizeSpecialEventConfig,
} from '../../../../data/multiplayer';

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

function makeStores() {
  const roster = new CharacterRoster({ storage: makeMemoryStorage() });
  const shards = new ShardStore({ storage: makeMemoryStorage() });
  return { roster, shards };
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
        clip: () => {},
        rect: () => {},
        roundRect: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        clearRect: () => {},
        drawImage: () => {},
        fillText: () => {},
        strokeText: () => {},
        measureText: (s: string) => ({ width: s.length * 7 }),
        setLineDash: () => {},
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        globalAlpha: 1,
        font: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
      }),
    });
    (globalThis as unknown as { document: { createElement: (tag: string) => unknown } }).document =
      {
        createElement: (tag: string) => (tag === 'canvas' ? createMockCanvas() : {}),
      };
  }
});

describe('Perimeter Operations Master Spec Regressions', () => {
  it('enforces neutral sub-faction 3-stage aim-at & perimeter-breach warning escalation', () => {
    const { roster } = makeStores();
    const char = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'RECON-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;
    // Neutral standing (0 is within -25..+49)
    char.subFactionStanding.highland_militia = 0;

    const scene = new THREE.Scene();
    const ai = new OpenWorldAiDirector(scene, () => 40, 'pmc_alpha');
    const militia = ai.getAliveAgents().find((a) => a.faction === 'highland_militia')!;
    expect(militia).toBeDefined();

    const warnings: AiNeutralWarningEvent[] = [];
    // Place player 8m in front of the militia guard (within perimeter breach) aiming right at them
    const playerX = militia.x;
    const playerZ = militia.z + 8;

    ai.update(
      0.25,
      playerX,
      militia.y,
      playerZ,
      true,
      true,
      false,
      1.0,
      false,
      char,
      () => {},
      {
        playerAds: true,
        playerAimDirX: 0,
        playerAimDirY: 0,
        playerAimDirZ: -1,
        onNeutralWarning: (ev) => warnings.push(ev),
      },
    );

    expect(militia.neutralAlertStage).toBe('warned');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].subFactionId).toBe('highland_militia');

    // Sustained breach/aim past 3.5s escalates to hostile
    for (let i = 0; i < 20; i++) {
      ai.update(
        0.25,
        playerX,
        militia.y,
        playerZ,
        true,
        true,
        false,
        1.0,
        false,
        char,
        () => {},
        {
          playerAds: true,
          playerAimDirX: 0,
          playerAimDirY: 0,
          playerAimDirZ: -1,
          onNeutralWarning: (ev) => warnings.push(ev),
        },
      );
    }

    expect(militia.neutralAlertStage).toBe('hostile');
    expect(ai.getRelationForAgent(militia, char)).toBe('hostile');
    ai.dispose();
  });

  it('unlocks Trusted sub-faction physical POI stations only when standing >= +50', () => {
    const { roster, shards } = makeStores();
    const char = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'DIPLOMAT-1',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'female',
    }).character!;
    const scene = new THREE.Scene();
    const mgr = new OpenWorldSectorManager(scene, () => 40, roster, shards, 'PvPvE');
    const militiaSector = mgr
      .getSectorsSnapshot()
      .find((s) => s.subFactionId === 'highland_militia' && s.subFactionMarketX !== undefined)!;
    expect(militiaSector).toBeDefined();

    // Neutral standing (0): Trusted sub-faction stations show up as blocked (canExecute === false)
    char.subFactionStanding.highland_militia = 0;
    const neutralNearBlackMarket = mgr.findNearestInteractable(
      militiaSector.subFactionMarketX!,
      militiaSector.subFactionMarketZ!,
      char,
    );
    expect(neutralNearBlackMarket?.kind).toBe('subfaction_black_market');
    expect(neutralNearBlackMarket?.canExecute).toBe(false);

    // Trusted standing (+60): Black Market, Field Stash, and Medic Tent unlock (canExecute === true)
    char.subFactionStanding.highland_militia = 60;
    const trustedBlackMarket = mgr.findNearestInteractable(
      militiaSector.subFactionMarketX!,
      militiaSector.subFactionMarketZ!,
      char,
    );
    expect(trustedBlackMarket?.kind).toBe('subfaction_black_market');
    expect(trustedBlackMarket?.canExecute).toBe(true);

    const trustedStash = mgr.findNearestInteractable(
      militiaSector.subFactionStashX!,
      militiaSector.subFactionStashZ!,
      char,
    );
    expect(trustedStash?.kind).toBe('subfaction_stash');
    expect(trustedStash?.canExecute).toBe(true);

    const trustedMedic = mgr.findNearestInteractable(
      militiaSector.subFactionMedicX!,
      militiaSector.subFactionMedicZ!,
      char,
    );
    expect(trustedMedic?.kind).toBe('subfaction_medic');
    expect(trustedMedic?.canExecute).toBe(true);

    mgr.dispose();
  });

  it('implements Sector Control Model parity (signed captureProgress, heat, contested owner) and FOB Tier 3 systems', () => {
    const { roster, shards } = makeStores();
    const char = roster.createCharacter({
      slotId: 'slot_0',
      callsign: 'ALPHA-CMD',
      pmcFaction: 'pmc_alpha',
      shardMode: 'PvPvE',
      bodyType: 'male',
    }).character!;
    const scene = new THREE.Scene();
    const mgr = new OpenWorldSectorManager(scene, () => 40, roster, shards, 'PvPvE');

    const sectors = mgr.getSectorsSnapshot();
    const subFactionSector = sectors.find((s) => s.subFactionId === 'highland_militia')!;
    expect(subFactionSector).toBeDefined();
    expect(subFactionSector.owner).toBe('subfaction');
    expect(typeof subFactionSector.heat).toBe('number');
    expect(subFactionSector.signedCaptureProgress).toBeGreaterThanOrEqual(-100);
    expect(subFactionSector.signedCaptureProgress).toBeLessThanOrEqual(100);

    // Marking sector contested raises heat and flips contested flag
    mgr.markSectorContested(subFactionSector.sectorId);
    const updated = mgr.getSectorsSnapshot().find((s) => s.sectorId === subFactionSector.sectorId)!;
    expect(updated.contested).toBe(true);
    expect(updated.heat).toBeGreaterThan(0);

    // Upgrade Alpha FOB to Tier 3 -> unlocks active AA/Mortar defense turrets + Fast Travel destinations
    shards.setFobTier('PvPvE', 'pmc_alpha', 3, 'ALPHA-CMD');
    mgr.update(0.1, 0, 0, char, () => 0);

    const alphaTurrets = mgr.getFobDefenseTurrets().filter((t) => t.faction === 'pmc_alpha');
    expect(alphaTurrets.length).toBeGreaterThanOrEqual(2);
    expect(alphaTurrets.some((t) => t.role === 'aa_autocannon')).toBe(true);
    expect(alphaTurrets.some((t) => t.role === 'mortar')).toBe(true);

    const fastTravelTargets = mgr.getFastTravelDestinations('pmc_alpha');
    expect(fastTravelTargets.length).toBeGreaterThanOrEqual(1);

    mgr.dispose();
  });

  it('enforces real-time 30m/60m/2h supply-coupled trader restocks and CR123A battery stock', () => {
    expect(RESTOCK_INTERVAL_HIGH_SEC).toBe(1800);
    expect(RESTOCK_INTERVAL_STRAINED_SEC).toBe(3600);
    expect(RESTOCK_INTERVAL_STARVED_SEC).toBe(7200);

    expect(classifySupplyTier(80)).toBe('high');
    expect(classifySupplyTier(50)).toBe('strained');
    expect(classifySupplyTier(20)).toBe('starved');

    const highStatus = evaluateSupplyResourceStatus('ammo', 85);
    const strainedStatus = evaluateSupplyResourceStatus('ammo', 50);
    const starvedStatus = evaluateSupplyResourceStatus('ammo', 15);

    expect(highStatus.restockIntervalSec).toBe(1800);
    expect(strainedStatus.restockIntervalSec).toBe(3600);
    expect(starvedStatus.restockIntervalSec).toBe(7200);
    expect(starvedStatus.priceMultiplier).toBeGreaterThan(highStatus.priceMultiplier);

    const unified = computeUnifiedRestockRemainingSec(
      { ammo: 85, medical: 85, fuelParts: 85, intel: 85 },
      0,
      600_000,
    );
    expect(unified.cycleIntervalSec).toBe(1800);
    expect(unified.remainingSec).toBeGreaterThan(0);
    expect(unified.remainingSec).toBeLessThanOrEqual(1800);

    const batteryOffer = FOB_TRADER_OFFERS.find((o) => o.offerId === 'offer_pda_battery');
    expect(batteryOffer).toBeDefined();
    expect(batteryOffer!.category).toBe('utility');
    expect(batteryOffer!.createItem().kind).toBe('battery');
  });

  it('drains TacticalPdaDevice battery while open, shuts off at 0%, and recharges via CR123A replacement', () => {
    const pda = new TacticalPdaDevice();
    pda.setBatteryDrainEnabled(true, 10); // fast drain for deterministic test
    expect(pda.getBatteryPct()).toBe(100);
    expect(pda.isBatteryDepleted()).toBe(false);

    // Open PDA and advance through draw/active phases (dt clamped at 0.05s internally)
    pda.setOpen(true);
    let elapsed = 0;
    for (let i = 0; i < 40; i++) {
      elapsed += 0.05;
      pda.update(0.05, elapsed);
    }
    expect(pda.getBatteryPct()).toBeLessThan(100);

    // Drain completely to 0% -> shuts off
    for (let i = 0; i < 240; i++) {
      elapsed += 0.05;
      pda.update(0.05, elapsed);
    }
    expect(pda.getBatteryPct()).toBe(0);
    expect(pda.isBatteryDepleted()).toBe(true);

    // Replace battery restores 100%
    pda.replaceBattery();
    expect(pda.getBatteryPct()).toBe(100);
    expect(pda.isBatteryDepleted()).toBe(false);

    // Verify 1x1 CR123A item in Tetris inventory factory
    const inst = createPdaBatteryItem(100);
    expect(inst.templateId).toBe('pda_battery');
    expect(inst.kind).toBe('battery');
    expect(inst.width).toBe(1);
    expect(inst.height).toBe(1);
    expect(inst.chargePct).toBe(100);

    pda.dispose();
  });

  it('defines dedicated Combat Knife (melee_1h) distinct from strictly empty Unarmed hands', () => {
    const knifeProfile = resolveWeaponProfile('combat_knife');
    const unarmedProfile = resolveWeaponProfile('unarmed');
    expect(knifeProfile.id).toBe('combat_knife');
    expect(knifeProfile.holdClass).toBe('melee_1h');
    expect(unarmedProfile.id).toBe('unarmed');
    expect(unarmedProfile.holdClass).toBe('unarmed');

    const knifeModel = WeaponModelFactory.build(knifeProfile, false);
    const unarmedModel = WeaponModelFactory.build(unarmedProfile, false);

    let knifeMeshCount = 0;
    knifeModel.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) knifeMeshCount++;
    });
    let unarmedMeshCount = 0;
    unarmedModel.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) unarmedMeshCount++;
    });

    expect(knifeMeshCount).toBeGreaterThanOrEqual(4);
    expect(unarmedMeshCount).toBe(0);

    knifeModel.dispose();
    unarmedModel.dispose();
  });

  it('batches heterogeneous static tactical chunk props into THREE.BatchedMesh and disposes cleanly', () => {
    const scene = new THREE.Scene();
    const streamer = new OpenWorldChunkStreamer(scene, true);
    streamer.update(0, 0, true);

    const stats = streamer.getStats();
    expect(stats.activeChunkCount).toBe(9);
    expect(stats.activeBatchedMeshCount).toBeGreaterThan(0);

    let foundBatchedMesh = false;
    scene.traverse((obj) => {
      if ((obj as THREE.BatchedMesh).isBatchedMesh) {
        foundBatchedMesh = true;
      }
    });
    expect(foundBatchedMesh).toBe(true);

    streamer.dispose();
    expect(streamer.getStats().activeBatchedMeshCount).toBe(0);
  });

  it('preserves Battle Mode Host Match Controls (hitmarkersEnabled & hudEnabled) defaults and explicit toggles', () => {
    expect(DEFAULT_SPECIAL_EVENT_CONFIG.hitmarkersEnabled).toBe(true);
    expect(DEFAULT_SPECIAL_EVENT_CONFIG.hudEnabled).toBe(true);

    const defaults = sanitizeSpecialEventConfig({});
    expect(defaults.hitmarkersEnabled).toBe(true);
    expect(defaults.hudEnabled).toBe(true);

    const hardcore = sanitizeSpecialEventConfig({
      hitmarkersEnabled: false,
      hudEnabled: false,
    });
    expect(hardcore.hitmarkersEnabled).toBe(false);
    expect(hardcore.hudEnabled).toBe(false);

    const mixed = sanitizeSpecialEventConfig({
      hitmarkersEnabled: false,
      hudEnabled: true,
    });
    expect(mixed.hitmarkersEnabled).toBe(false);
    expect(mixed.hudEnabled).toBe(true);
  });
});

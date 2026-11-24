import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BATTLE_MAPS,
  getMapDefinitionById,
  ZOMBIE_MAPS,
} from '../../maps/MapRegistry';
import { BattleModeController, ModeActorSample } from '../BattleModeController';
import { applyMatchProgression, type CareerProgressionState } from '../../data/progression';

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    const noop = () => {};
    const makeCtx = () => ({
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
      arc: noop,
      ellipse: noop,
      quadraticCurveTo: noop,
      bezierCurveTo: noop,
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
      drawImage: noop,
      measureText: () => ({ width: 40 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: noop,
    });
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({
        width: 256,
        height: 256,
        getContext: () => makeCtx(),
      }),
    };
  }
  vi.spyOn(THREE.PMREMGenerator.prototype, 'fromScene').mockImplementation(
    () =>
      ({
        texture: new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1),
        dispose: () => {},
      }) as unknown as ReturnType<THREE.PMREMGenerator['fromScene']>,
  );
  vi.spyOn(THREE.PMREMGenerator.prototype, 'dispose').mockImplementation(() => {});
});

function buildMapById(id: string) {
  const def = getMapDefinitionById(id);
  if (!def) throw new Error(`Map not found: ${id}`);
  const scene = new THREE.Scene();
  const mockRenderer = {
    capabilities: { getMaxAnisotropy: () => 4 },
    getPixelRatio: () => 1,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
  } as unknown as THREE.WebGLRenderer;
  return def.build(scene, mockRenderer, true, 'balanced');
}

function makeTestLoadouts() {
  return [
    { id: 'slot-1', name: 'Assault', primaryWeaponId: 'm4a1_sbr', secondaryWeaponId: 'glock_19' },
    { id: 'slot-2', name: 'CQB', primaryWeaponId: 'mp7a1', secondaryWeaponId: 'glock_19' },
    { id: 'slot-3', name: 'Marksman', primaryWeaponId: 'mk18_mod1', secondaryWeaponId: 'm1911' },
  ];
}

describe('All 7 Battle & Infection Maps Registry and Build Validation', () => {
  it('registers and unlocks all 3 Infection maps (Kino, Stalingrad Depot, Objekt-47) with valid gameplay geometry', () => {
    const ids = ZOMBIE_MAPS.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['der_lichtspielhaus', 'stalingrad_depot', 'objekt_47']));
    for (const def of ZOMBIE_MAPS) {
      expect(def.status).toBe('playable');
      const built = buildMapById(def.id);
      expect(built.spawnPoints.playerStart).toBeDefined();
      expect(built.navGraph.nodes.length).toBeGreaterThanOrEqual(8);
      expect(built.spawnPoints.zombieSpawners.length).toBeGreaterThanOrEqual(4);
      expect(built.windowBarriers.length).toBeGreaterThanOrEqual(2);
      expect(built.interactables.some((i) => i.kind === 'power_switch')).toBe(true);
      built.dispose();
    }
  });

  it('registers and unlocks all 4 Battle maps (including Volga Frontier Corridor) with complete battleObjectives', () => {
    const ids = BATTLE_MAPS.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'pripyat_block',
        'timberline_compound',
        'korsakov_substation',
        'volga_corridor',
      ]),
    );
    for (const def of BATTLE_MAPS) {
      expect(def.status).toBe('playable');
      const built = buildMapById(def.id);
      expect(built.battleObjectives).toBeDefined();
      const obj = built.battleObjectives!;
      expect(obj.hqA.spawnPoints.length).toBeGreaterThanOrEqual(2);
      expect(obj.hqB.spawnPoints.length).toBeGreaterThanOrEqual(2);
      expect(obj.conquestPois.length).toBeGreaterThanOrEqual(3);
      expect(obj.conquestPois.some((p) => p.kind === 'fob')).toBe(true);
      expect(obj.conquestPois.some((p) => p.kind === 'checkpoint')).toBe(true);
      expect(obj.conquestPois.some((p) => p.kind === 'outpost')).toBe(true);
      expect(obj.ctfFlags.length).toBe(2);
      expect(obj.kothHills.length).toBeGreaterThanOrEqual(3);
      built.dispose();
    }
  });
});

describe('Conquest Battle Mode: Territory Win, Protected HQs, 1-Life-Per-Loadout & Contested FOB Blocking', () => {
  it('wins strictly by accumulated Territory Points over time (not kills) and keeps HQs protected', () => {
    const map = buildMapById('volga_corridor');
    const group = new THREE.Group();
    let victoryEvent: { winnerTeam: string; reason: string } | null = null;

    const ctrl = new BattleModeController({
      rule: 'conquest',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      scoreLimit: 30,
      matchDurationSec: 300,
      conquestLoadouts: makeTestLoadouts(),
      activeLoadoutId: 'slot-1',
      callbacks: {
        onMatchVictory: (ev) => {
          victoryEvent = ev;
        },
      },
    });

    const pois = map.battleObjectives!.conquestPois;
    const outpost = pois.find((p) => p.kind === 'outpost') ?? pois[0];
    const [ox, oy, oz] = outpost.position;

    // Team A holds the outpost without getting a single kill
    const actors: ModeActorSample[] = [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: ox, y: oy, z: oz, isLocalPlayer: true },
      { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: 95, y: 0, z: 0 },
    ];

    for (let i = 0; i < 400; i++) {
      ctrl.update(0.1, actors);
      if (victoryEvent) break;
    }

    expect(ctrl.scoreA).toBeGreaterThanOrEqual(30);
    expect(ctrl.scoreB).toBe(0);
    expect(victoryEvent).not.toBeNull();
    expect(victoryEvent!.winnerTeam).toBe('A');
    expect(ctrl.getActorStats('local').poiCaptures).toBeGreaterThanOrEqual(1);

    // HQs remain protected and always available as spawn options
    const optionsA = ctrl.getConquestSpawnOptionsForTeam('A');
    const hqOptionA = optionsA.find((o) => o.kind === 'hq');
    expect(hqOptionA).toBeDefined();
    expect(hqOptionA!.available).toBe(true);

    ctrl.dispose();
    map.dispose();
  });

  it('enforces 1 life per loadout slot, blocks contested friendly FOB spawns, and enters spectator mode once all loadouts are expended', () => {
    const map = buildMapById('volga_corridor');
    const group = new THREE.Group();

    const ctrl = new BattleModeController({
      rule: 'conquest',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      conquestLoadouts: makeTestLoadouts(),
      activeLoadoutId: 'slot-1',
    });

    const fobA = map.battleObjectives!.conquestPois.find((p) => p.kind === 'fob')!;
    const [fx, fy, fz] = fobA.position;

    // Capture FOB-A for Team A (6.5s capture -> 80 ticks at dt=0.1s)
    const capActors: ModeActorSample[] = [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: fx, y: fy, z: fz, isLocalPlayer: true },
    ];
    for (let i = 0; i < 80; i++) ctrl.update(0.1, capActors);

    // Uncontested friendly FOB-A should be available for Team A respawn
    expect(ctrl.isConquestSpawnAvailable('A', fobA.id)).toBe(true);

    // Now an enemy enters FOB-A -> contested -> spawn MUST be blocked!
    const contestedActors: ModeActorSample[] = [
      { id: 'a2', name: 'ALLY', team: 'A', alive: true, x: fx, y: fy, z: fz },
      { id: 'b1', name: 'ENEMY', team: 'B', alive: true, x: fx + 1, y: fy, z: fz },
    ];
    ctrl.update(0.25, contestedActors);
    expect(ctrl.isConquestSpawnAvailable('A', fobA.id)).toBe(false);

    // HQ remains available even while FOB is contested
    const hqOpt = ctrl.getConquestSpawnOptionsForTeam('A').find((o) => o.kind === 'hq')!;
    expect(ctrl.isConquestSpawnAvailable('A', hqOpt.id)).toBe(true);

    // Expend all 3 loadouts -> 1st & 2nd death open Redeploy, 3rd death enters Spectator Mode
    const d1 = ctrl.onLocalPlayerDeathConquest();
    expect(d1.remainingLives).toBe(2);
    expect(d1.enteringSpectator).toBe(false);
    expect(ctrl.isLocalAwaitingRedeploy()).toBe(true);
    ctrl.selectConquestLoadout('slot-2');
    ctrl.selectConquestSpawn(hqOpt.id);
    const redeploy1 = ctrl.confirmConquestRedeploy([], []);
    expect(redeploy1).not.toBeNull();
    expect(redeploy1!.loadout.id).toBe('slot-2');

    const d2 = ctrl.onLocalPlayerDeathConquest();
    expect(d2.remainingLives).toBe(1);
    expect(d2.enteringSpectator).toBe(false);
    ctrl.selectConquestLoadout('slot-3');
    ctrl.selectConquestSpawn(hqOpt.id);
    const redeploy2 = ctrl.confirmConquestRedeploy([], []);
    expect(redeploy2).not.toBeNull();
    expect(redeploy2!.loadout.id).toBe('slot-3');

    const d3 = ctrl.onLocalPlayerDeathConquest();
    expect(d3.remainingLives).toBe(0);
    expect(d3.enteringSpectator).toBe(true);
    expect(ctrl.isLocalSpectating()).toBe(true);
    expect(ctrl.isLocalAwaitingRedeploy()).toBe(false);

    ctrl.dispose();
    map.dispose();
  });
});

describe('Universal Battle Spawn Protection & Safe-Spawn Scorer', () => {
  it('avoids enemies, LOS, and crossfire heat zones and cancels spawn protection immediately on attack', () => {
    const map = buildMapById('pripyat_block');
    const group = new THREE.Group();
    const ctrl = new BattleModeController({
      rule: 'tdm',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
    });

    const candidates = [
      { position: [0, 0, 0] as [number, number, number], yaw: 0 },
      { position: [5, 0, 0] as [number, number, number], yaw: 0 },
      { position: [45, 0, 45] as [number, number, number], yaw: 0 },
    ];
    // Place enemy next to candidate 0 and register crossfire heat at candidate 1
    const enemies = [{ x: 1, y: 0, z: 0 }];
    ctrl.recordCrossfireHeat(5, 0, 0, 10);

    const chosen = ctrl.selectSafeSpawnPoint(candidates, enemies, map.raycastMeshes);
    expect(chosen.position[0]).toBe(45);

    // Grant 2.5s spawn protection
    ctrl.grantSpawnProtection('local', 2.5);
    expect(ctrl.isSpawnProtected('local')).toBe(true);
    expect(ctrl.getSpawnProtectionRemaining('local')).toBeGreaterThan(2.0);

    // Tick 1.0s -> still protected
    ctrl.update(1.0, []);
    expect(ctrl.isSpawnProtected('local')).toBe(true);

    // Attack cancels immediately
    ctrl.cancelSpawnProtection('local');
    expect(ctrl.isSpawnProtected('local')).toBe(false);

    ctrl.dispose();
    map.dispose();
  });
});

describe('Classic CTF & Rotating KOTH Battle Modes', () => {
  it('enforces classic CTF home-flag-required-to-score rule, drop on death, and instant teammate return', () => {
    const map = buildMapById('pripyat_block');
    const group = new THREE.Group();
    const ctrl = new BattleModeController({
      rule: 'ctf',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      scoreLimit: 3,
    });

    const flagAPos = map.battleObjectives!.ctfFlags[0].position;
    const flagBPos = map.battleObjectives!.ctfFlags[1].position;

    // Player A picks up Flag B, while Enemy B picks up Flag A simultaneously
    const actorsBothTake: ModeActorSample[] = [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: flagBPos[0], y: flagBPos[1], z: flagBPos[2], isLocalPlayer: true },
      { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: flagAPos[0], y: flagAPos[1], z: flagAPos[2] },
    ];
    ctrl.update(0.1, actorsBothTake);

    // Player A runs back to Base A while Flag A is still stolen -> CANNOT score yet
    const actorsHomeStolen: ModeActorSample[] = [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: flagAPos[0], y: flagAPos[1], z: flagAPos[2], isLocalPlayer: true },
      { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: flagAPos[0] + 15, y: flagAPos[1], z: flagAPos[2] },
    ];
    ctrl.update(0.1, actorsHomeStolen);
    expect(ctrl.scoreA).toBe(0);

    // Enemy B dies and drops Flag A -> Ally A2 touches dropped Flag A -> instant return
    ctrl.onActorKilled({
      victimId: 'b1',
      victimTeam: 'B',
      x: flagAPos[0] + 15,
      y: flagAPos[1],
      z: flagAPos[2],
    });
    const actorsReturnAndScore: ModeActorSample[] = [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: flagAPos[0], y: flagAPos[1], z: flagAPos[2], isLocalPlayer: true },
      { id: 'a2', name: 'ALLY-2', team: 'A', alive: true, x: flagAPos[0] + 15, y: flagAPos[1], z: flagAPos[2] },
    ];
    ctrl.update(0.1, actorsReturnAndScore);
    ctrl.update(0.1, actorsReturnAndScore);

    expect(ctrl.getActorStats('a2').flagReturns).toBe(1);
    expect(ctrl.scoreA).toBe(1);
    expect(ctrl.getActorStats('local').flagCaptures).toBe(1);

    ctrl.dispose();
    map.dispose();
  });

  it('rotates KOTH hills every 45s with 10s preview and pauses scoring while contested', () => {
    const map = buildMapById('timberline_compound');
    const group = new THREE.Group();
    const ctrl = new BattleModeController({
      rule: 'koth',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      scoreLimit: 250,
    });

    const hill0 = map.battleObjectives!.kothHills[0];
    const [hx, hy, hz] = hill0.position;

    // Contested: both teams inside -> score stays 0 (2.0s total)
    for (let i = 0; i < 20; i++) {
      ctrl.update(0.1, [
        { id: 'local', name: 'YOU', team: 'A', alive: true, x: hx, y: hy, z: hz, isLocalPlayer: true },
        { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: hx + 1, y: hy, z: hz },
      ]);
    }
    expect(ctrl.scoreA).toBe(0);
    expect(ctrl.scoreB).toBe(0);
    expect(ctrl.getHudSnapshot().koth?.contested).toBe(true);

    // Uncontested Team A inside -> earns hill points (2.0s total)
    for (let i = 0; i < 20; i++) {
      ctrl.update(0.1, [
        { id: 'local', name: 'YOU', team: 'A', alive: true, x: hx, y: hy, z: hz, isLocalPlayer: true },
      ]);
    }
    expect(ctrl.scoreA).toBeGreaterThan(0);

    // Advance 33s more (total 37s elapsed, 8s left <= 10s preview window)
    for (let i = 0; i < 330; i++) ctrl.update(0.1, []);
    const hudPreview = ctrl.getHudSnapshot().koth!;
    expect(hudPreview.previewActive).toBe(true);
    expect(hudPreview.activeHillIndex).toBe(0);

    // Advance 10s more -> past 45s -> rotates to hill 1
    for (let i = 0; i < 100; i++) ctrl.update(0.1, []);
    expect(ctrl.getHudSnapshot().koth!.activeHillIndex).toBe(1);

    ctrl.dispose();
    map.dispose();
  });
});

describe('Kill Confirmed TDM & Kill Confirmed FFA + Post-Match Progression XP & Badges', () => {
  it('separates Enemy Dogtags (win score) from Secured Friendly Dogtags (non-scoring tracker + XP) in KC TDM and KC FFA', () => {
    const map = buildMapById('korsakov_substation');
    const group = new THREE.Group();

    // 1. KC TDM test
    const kcTdm = new BattleModeController({
      rule: 'kc_tdm',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      scoreLimit: 40,
    });

    // Team A kills Enemy B1 -> drops Team B dogtag at (10, 0, 10)
    kcTdm.onActorKilled({
      victimId: 'b1',
      victimTeam: 'B',
      x: 10,
      y: 0,
      z: 10,
    });
    // Enemy B kills Ally A2 -> drops Team A dogtag at (20, 0, 20)
    kcTdm.onActorKilled({
      victimId: 'a2',
      victimTeam: 'A',
      x: 20,
      y: 0,
      z: 20,
    });

    // Local player collects Enemy B1 tag -> +1 scoreA, +1 enemyDogtags
    kcTdm.update(0.1, [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: 10, y: 0, z: 10, isLocalPlayer: true },
    ]);
    expect(kcTdm.scoreA).toBe(1);
    expect(kcTdm.getActorStats('local').enemyDogtags).toBe(1);
    expect(kcTdm.friendlyTagsA).toBe(0);

    // Local player collects Friendly A2 tag -> scoreA MUST NOT increase; tracked in Secured Friendly Dogtags
    kcTdm.update(0.1, [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: 20, y: 0, z: 20, isLocalPlayer: true },
    ]);
    expect(kcTdm.scoreA).toBe(1); // Unchanged!
    expect(kcTdm.friendlyTagsA).toBe(1);
    expect(kcTdm.getActorStats('local').friendlyDogtags).toBe(1);
    kcTdm.dispose();

    // 2. KC FFA test: own-tag recovery tracked in friendlyDogtags/selfDogtagsRecovered without increasing enemy win score
    const kcFfa = new BattleModeController({
      rule: 'kc_ffa',
      map,
      sceneGroup: group,
      localPlayerTeam: 'FFA',
      localPlayerId: 'local',
      scoreLimit: 25,
    });

    kcFfa.onActorKilled({
      victimId: 'local',
      victimTeam: 'FFA',
      x: 5,
      y: 0,
      z: 5,
    });
    // Wait past 0.75s self-pickup grace window (10 ticks x 0.1s = 1.0s), then local player respawns and recovers own dogtag
    for (let i = 0; i < 10; i++) kcFfa.update(0.1, []);
    kcFfa.update(0.1, [
      { id: 'local', name: 'YOU', team: 'FFA', alive: true, x: 5, y: 0, z: 5, isLocalPlayer: true },
    ]);
    const selfStats = kcFfa.getActorStats('local');
    expect(selfStats.enemyDogtags).toBe(0);
    expect(selfStats.friendlyDogtags).toBe(1);
    expect(selfStats.selfDogtagsRecovered).toBe(1);
    kcFfa.dispose();

    // 3. Progression & Level-Up itemized XP test for KC FFA (large +140 XP per own-tag recovery)
    const career: CareerProgressionState = {
      rank: 1,
      xp: 0,
      prestige: 0,
      prestigeXp: 0,
      cash: 500,
      kills: 0,
      deaths: 0,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      highestInfectionRound: 0,
    };
    const { summary } = applyMatchProgression(career, {}, new Set<string>(), {
      mode: 'battle',
      battleRule: 'kc_ffa',
      kills: 10,
      headshots: 3,
      deaths: 4,
      outcome: 'victory',
      weaponKills: {},
      mapId: 'korsakov_substation',
      mapName: 'Korsakov Substation',
      enemyDogtags: 8,
      friendlyDogtags: 2,
      selfDogtagsRecovered: 2,
      combatants: [
        {
          id: 'local',
          name: 'YOU',
          team: 'FFA',
          isLocalPlayer: true,
          isBot: false,
          kills: 10,
          deaths: 4,
          headshots: 3,
          assists: 0,
          grenadeKills: 0,
          meleeKills: 0,
          damageDealt: 1200,
          afkSeconds: 0,
          enemyDogtags: 8,
          friendlyDogtags: 2,
          selfDogtagsRecovered: 2,
        },
        {
          id: 'bot-1',
          name: 'RAVEN',
          team: 'FFA',
          isLocalPlayer: false,
          isBot: true,
          kills: 12,
          deaths: 5,
          headshots: 1,
          assists: 0,
          grenadeKills: 0,
          meleeKills: 0,
          damageDealt: 1100,
          afkSeconds: 0,
          enemyDogtags: 5,
          friendlyDogtags: 9, // High friendly tags must NOT overtake rank 1 enemy tags!
        },
      ],
    });

    expect(summary.breakdown.enemyDogtagXp).toBe(8 * 45);
    expect(summary.breakdown.friendlyDogtagXp).toBe(2 * 140);
    expect(summary.leaderboard[0].id).toBe('local');
    expect(summary.leaderboard[0].badges).toContain('tag_collector');
    expect(summary.leaderboard[1].badges).toContain('tag_rescuer');

    map.dispose();
  });
});

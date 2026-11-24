import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BATTLE_MAPS,
  getMapDefinitionById,
  ZOMBIE_MAPS,
} from '../../maps/MapRegistry';
import { BattleModeController, ModeActorSample } from '../BattleModeController';
import { applyMatchProgression, type CareerProgressionState } from '../../data/progression';
import {
  clampSpringState,
  createRaycastResult,
  stepAnalyticalDampedSpring,
} from '../../bodycam-sdk';

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

function buildMapById(id: string, options?: { battleRule?: 'tdm' | 'ffa' | 'ctf' | 'koth' | 'conquest' | 'kc_tdm' | 'kc_ffa' }) {
  const def = getMapDefinitionById(id);
  if (!def) throw new Error(`Map not found: ${id}`);
  const scene = new THREE.Scene();
  const mockRenderer = {
    capabilities: { getMaxAnisotropy: () => 4 },
    getPixelRatio: () => 1,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1,
  } as unknown as THREE.WebGLRenderer;
  return def.build(scene, mockRenderer, true, 'balanced', options);
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

  it('locks friendly FOB spawns on lone enemy intrusion OR active enemy fire and enforces 1-life-per-loadout attrition for bots and remote participants', () => {
    const map = buildMapById('volga_corridor');
    const group = new THREE.Group();

    const hostCtrl = new BattleModeController({
      rule: 'conquest',
      map,
      sceneGroup: group,
      localPlayerTeam: 'A',
      localPlayerId: 'local',
      scoreLimit: 500,
      conquestLoadouts: makeTestLoadouts(), // 3 loadouts -> 3 lives for every participant
      activeLoadoutId: 'slot-1',
    });

    const fobA = map.battleObjectives!.conquestPois.find((p) => p.kind === 'fob')!;
    const [fx, fy, fz] = fobA.position;

    // Capture FOB-A for Team A
    for (let i = 0; i < 80; i++) {
      hostCtrl.update(0.1, [
        { id: 'local', name: 'YOU', team: 'A', alive: true, x: fx, y: fy, z: fz, isLocalPlayer: true },
      ]);
    }
    expect(hostCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(true);

    // Case 1: Lone enemy enters FOB-A (0 friendlies inside -> contested is false, but underAttack MUST lock spawn!)
    hostCtrl.update(0.1, [
      { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: fx, y: fy, z: fz },
    ]);
    expect(hostCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(false);
    const hudIntrusion = hostCtrl.getHudSnapshot();
    expect(hudIntrusion.conquestPois.find((p) => p.id === fobA.id)?.underAttack).toBe(true);

    // Enemy leaves -> FOB clears immediately once no fire timer is active
    hostCtrl.update(0.1, [
      { id: 'b1', name: 'BRAVO-1', team: 'B', alive: true, x: 95, y: 0, z: 0 },
    ]);
    expect(hostCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(true);

    // Case 2: Hostile gunfire/grenade strikes near friendly FOB-A -> locks spawn for 6s window
    hostCtrl.reportConquestAttack(fx + 2, fz - 2, 'B');
    hostCtrl.update(0.1, [
      { id: 'local', name: 'YOU', team: 'A', alive: true, x: -92, y: 0, z: 0, isLocalPlayer: true },
    ]);
    expect(hostCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(false);

    // After 6.2s without further enemy attack, FOB-A unlocks again
    for (let i = 0; i < 62; i++) {
      hostCtrl.update(0.1, [
        { id: 'local', name: 'YOU', team: 'A', alive: true, x: -92, y: 0, z: 0, isLocalPlayer: true },
      ]);
    }
    expect(hostCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(true);

    // Case 3: Unified 1-life-per-loadout attrition across bots AND remote human participants
    hostCtrl.initBotConquestLives('bot_0', 3, 'A');
    hostCtrl.registerConquestParticipant('remote_b1', 'B', 3);
    expect(hostCtrl.consumeBotConquestLife('bot_0', 'A')).toBe(2);
    expect(hostCtrl.onConquestParticipantRespawn('bot_0')).toBe(true);
    expect(hostCtrl.consumeBotConquestLife('bot_0', 'A')).toBe(1);
    expect(hostCtrl.consumeBotConquestLife('bot_0', 'A')).toBe(0);
    expect(hostCtrl.onConquestParticipantRespawn('bot_0')).toBe(false);

    expect(hostCtrl.consumeConquestParticipantLife('remote_b1', 'B')).toBe(2);
    expect(hostCtrl.consumeConquestParticipantLife('remote_b1', 'B')).toBe(1);
    expect(hostCtrl.consumeConquestParticipantLife('remote_b1', 'B')).toBe(0);
    expect(hostCtrl.onConquestParticipantRespawn('remote_b1')).toBe(false);
    expect(hostCtrl.getConquestParticipantAttrition('remote_b1')?.eliminated).toBe(true);

    // Case 4: Host-to-client sync packet replicates FOB under-attack lock & team reserves
    hostCtrl.reportConquestAttack(fx, fz, 'B');
    const pkt = hostCtrl.exportSyncPacket();
    const clientCtrl = new BattleModeController({
      rule: 'conquest',
      map,
      sceneGroup: new THREE.Group(),
      localPlayerTeam: 'A',
      localPlayerId: 'client_a',
      isAuthority: false,
      conquestLoadouts: makeTestLoadouts(),
    });
    clientCtrl.applySyncPacket(pkt);
    expect(clientCtrl.isConquestSpawnAvailable('A', fobA.id)).toBe(false);
    expect(clientCtrl.getHudSnapshot().conquestTeamRemainingLivesA).toBe(pkt.teamRemainingLivesA);

    clientCtrl.dispose();
    hostCtrl.dispose();
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

describe('Conquest performance and shooting spring stability', () => {
  it('keeps camera shake and weapon recoil springs bounded and convergent under severe lag dt', () => {
    const dtSamples = [1 / 60, 0.05, 0.08, 0.15];
    const springProfiles = [
      { label: 'camShakePos', omega: 32, zeta: 0.72, impulseVel: 0.45, limit: 0.015 },
      { label: 'camShakePitch', omega: 28, zeta: 0.72, impulseVel: 0.9, limit: 0.06 },
      { label: 'weaponRecoilZ', omega: 28, zeta: 1.0, impulseVel: 1.4, limit: 0.085 },
      { label: 'weaponRecoilPitch', omega: 24, zeta: 1.0, impulseVel: 2.8, limit: 0.35 },
    ];

    for (const profile of springProfiles) {
      for (const dt of dtSamples) {
        let value = 0;
        let velocity = profile.impulseVel;
        let maxAbsVal = 0;
        let maxAbsVel = Math.abs(velocity);

        for (let step = 0; step < 60; step++) {
          const [nextVal, nextVel] = stepAnalyticalDampedSpring(
            value,
            velocity,
            0,
            profile.omega,
            profile.zeta,
            dt,
          );
          const [clampedVal, clampedVel] = clampSpringState(
            nextVal,
            nextVel,
            -profile.limit,
            profile.limit,
          );
          value = clampedVal;
          velocity = clampedVel;

          expect(Number.isFinite(value)).toBe(true);
          expect(Number.isFinite(velocity)).toBe(true);
          expect(Math.abs(value)).toBeLessThanOrEqual(profile.limit + 1e-9);

          maxAbsVal = Math.max(maxAbsVal, Math.abs(value));
          maxAbsVel = Math.max(maxAbsVel, Math.abs(velocity));
        }

        // Must never amplify velocity into an unstable explosion and must settle near 0
        expect(maxAbsVel).toBeLessThan(profile.impulseVel * 2.0 + 1e-6);
        expect(maxAbsVal).toBeGreaterThan(0);
        expect(Math.abs(value)).toBeLessThan(1e-3);
        expect(Math.abs(velocity)).toBeLessThan(1e-2);
      }
    }

    // Clamping at hard bounds must zero outward velocity while preserving inward return velocity
    const [pinnedVal, pinnedVel] = clampSpringState(0.09, 2.5, -0.06, 0.06);
    expect(pinnedVal).toBe(0.06);
    expect(pinnedVel).toBe(0);

    const [returningVal, returningVel] = clampSpringState(0.09, -1.2, -0.06, 0.06);
    expect(returningVal).toBe(0.06);
    expect(returningVel).toBe(-1.2);
  });

  it('accelerates Volga Corridor raycasts and occlusion without losing terrain/cover accuracy or visuals', () => {
    const map = buildMapById('volga_corridor');

    // Terrain and instanced cover should remain visible in the scene while tagged for analytical raycasts
    const coveredMeshes = map.raycastMeshes.filter((m) => m.userData?.analyticalRaycastCovered === true);
    expect(coveredMeshes.length).toBeGreaterThanOrEqual(3);
    for (const m of coveredMeshes) {
      expect(m.visible).toBe(true);
    }

    // Downward raycast should hit analytical heightfield terrain with upward normal and grass surface
    const hit = createRaycastResult();
    const sampleX = 12;
    const sampleZ = -8;
    const expectedY = map.physics.getGroundHeight(sampleX, sampleZ, 12);
    const didHit = map.physics.raycast(
      new THREE.Vector3(sampleX, expectedY + 12, sampleZ),
      new THREE.Vector3(0, -1, 0),
      0.01,
      30,
      hit,
    );
    expect(didHit).toBe(true);
    expect(hit.surface).toBe('grass');
    expect(hit.normalY).toBeGreaterThan(0.5);
    expect(Math.abs(hit.pointY - expectedY)).toBeLessThan(0.12);

    // Line-of-sight occlusion through solid terrain vs open sky
    const openSky = map.physics.isSegmentOccluded(
      new THREE.Vector3(0, 28, 0),
      new THREE.Vector3(40, 28, 0),
    );
    expect(openSky).toBe(false);

    const throughTerrain = map.physics.isSegmentOccluded(
      new THREE.Vector3(sampleX, expectedY + 4, sampleZ),
      new THREE.Vector3(sampleX, expectedY - 4, sampleZ),
    );
    expect(throughTerrain).toBe(true);

    // Daytime-off night floodlights should start with visible=false to avoid dead PBR shader cost
    const nightLights = map.envBindings?.nightLights ?? [];
    expect(nightLights.length).toBeGreaterThan(0);
    for (const nl of nightLights) {
      if (nl.light.intensity <= 0.01) {
        expect(nl.light.visible).toBe(false);
      }
    }

    map.dispose();
  });

  it('accelerates Timberline Compound raycasts while respecting the underground bunker cutout', () => {
    const map = buildMapById('timberline_compound');

    const hit = createRaycastResult();
    const outerY = map.physics.getGroundHeight(35, 35, 10);
    const outerHit = map.physics.raycast(
      new THREE.Vector3(35, outerY + 10, 35),
      new THREE.Vector3(0, -1, 0),
      0.01,
      25,
      hit,
    );
    expect(outerHit).toBe(true);
    expect(Math.abs(hit.pointY - outerY)).toBeLessThan(0.15);

    // Inside the underground bunker chamber (footprint x in [42.6, 62.4], z in [-16.4, 4.4], floor at Y = -3.6),
    // an open horizontal ray at eye height must not falsely collide with surface terrain.
    const bunkerClear = map.physics.isSegmentOccluded(
      new THREE.Vector3(53.5, -2.0, -8.0),
      new THREE.Vector3(56.5, -2.0, -4.0),
    );
    expect(bunkerClear).toBe(false);

    map.dispose();
  });
});

describe('Expanded Conquest Maps, Spread HQs, Enterable Cover Buildings & High-Detail Foliage/Rocks', () => {
  const mapExpectations: Array<{
    id: string;
    minHqDistanceM: number;
    expectedPois: number;
    minCoverBuildings: number;
  }> = [
    { id: 'volga_corridor', minHqDistanceM: 280, expectedPois: 8, minCoverBuildings: 6 },
    { id: 'timberline_compound', minHqDistanceM: 250, expectedPois: 7, minCoverBuildings: 5 },
    { id: 'pripyat_block', minHqDistanceM: 180, expectedPois: 7, minCoverBuildings: 5 },
    { id: 'korsakov_substation', minHqDistanceM: 180, expectedPois: 7, minCoverBuildings: 5 },
  ];

  it('expands bounds, spreads HQs apart, adds extra POIs and neutral enterable cover buildings with connected NavGraph on all 4 Battle maps in Conquest', () => {
    for (const spec of mapExpectations) {
      const classic = buildMapById(spec.id, { battleRule: 'tdm' });
      const conquest = buildMapById(spec.id, { battleRule: 'conquest' });

      expect(classic.isExpandedConquest).toBe(false);
      expect(conquest.isExpandedConquest).toBe(true);

      // Playable footprint strictly larger in Conquest
      const classicArea =
        (classic.physics.boundsMaxX - classic.physics.boundsMinX) *
        (classic.physics.boundsMaxZ - classic.physics.boundsMinZ);
      const conquestArea =
        (conquest.physics.boundsMaxX - conquest.physics.boundsMinX) *
        (conquest.physics.boundsMaxZ - conquest.physics.boundsMinZ);
      expect(conquestArea).toBeGreaterThan(classicArea * 1.4);

      // Spread-out HQs
      const classicObj = classic.battleObjectives!;
      const cqObj = conquest.battleObjectives!;
      const classicHqDist = Math.hypot(
        classicObj.hqA.position[0] - classicObj.hqB.position[0],
        classicObj.hqA.position[2] - classicObj.hqB.position[2],
      );
      const cqHqDist = Math.hypot(
        cqObj.hqA.position[0] - cqObj.hqB.position[0],
        cqObj.hqA.position[2] - cqObj.hqB.position[2],
      );
      expect(cqHqDist).toBeGreaterThanOrEqual(spec.minHqDistanceM);
      expect(cqHqDist).toBeGreaterThan(classicHqDist * 1.35);

      // Expanded POI roster (FOBs, Checkpoints, Outpost)
      expect(cqObj.conquestPois.length).toBe(spec.expectedPois);
      expect(cqObj.conquestPois.filter((p) => p.kind === 'fob').length).toBeGreaterThanOrEqual(3);
      expect(cqObj.conquestPois.filter((p) => p.kind === 'checkpoint').length).toBeGreaterThanOrEqual(3);
      expect(cqObj.conquestPois.filter((p) => p.kind === 'outpost').length).toBeGreaterThanOrEqual(1);

      // Neutral enterable cover buildings present (strictly non-objective)
      const coverGroups = conquest.sceneGroup.children.filter(
        (child) => child.name && child.name.startsWith('cover_building_'),
      );
      expect(coverGroups.length).toBeGreaterThanOrEqual(spec.minCoverBuildings);
      for (const cg of coverGroups) {
        let wallCount = 0;
        cg.traverse((obj) => {
          if (obj instanceof THREE.Mesh && obj.userData?.analyticalRaycastCovered === true) {
            wallCount++;
          }
        });
        expect(wallCount).toBeGreaterThanOrEqual(10);
      }

      // NavGraph BFS reachability: Alpha HQ -> Bravo HQ and every cover building interior node
      const nodes = conquest.navGraph.nodes;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const nearestNodeId = (pos: [number, number, number]) => {
        let best = nodes[0];
        let bestD = Infinity;
        for (const n of nodes) {
          const d = Math.hypot(n.position[0] - pos[0], n.position[2] - pos[2]);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
        return best.id;
      };
      const startId = nearestNodeId(cqObj.hqA.position);
      const goalId = nearestNodeId(cqObj.hqB.position);
      const visited = new Set<string>([startId]);
      const queue = [startId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const node = byId.get(cur);
        if (!node) continue;
        for (const nxt of node.neighbors) {
          if (!visited.has(nxt)) {
            visited.add(nxt);
            queue.push(nxt);
          }
        }
      }
      expect(visited.has(goalId)).toBe(true);
      const coverInteriorNodes = nodes.filter((n) => n.id.startsWith('cb_') && n.id.endsWith('_in'));
      expect(coverInteriorNodes.length).toBeGreaterThanOrEqual(spec.minCoverBuildings);
      for (const cin of coverInteriorNodes) {
        expect(visited.has(cin.id)).toBe(true);
      }

      // High-detail sculpted boulders & trees use InstancedMesh with analyticalRaycastCovered = true
      const instancedMeshes: THREE.InstancedMesh[] = [];
      conquest.sceneGroup.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) instancedMeshes.push(obj);
      });
      const analyticalInstanced = instancedMeshes.filter(
        (m) => m.userData?.analyticalRaycastCovered === true,
      );
      expect(analyticalInstanced.length).toBeGreaterThanOrEqual(1);

      classic.dispose();
      conquest.dispose();
    }
  });

  it('preserves Timberline underground bunker cutout in Conquest-expanded mode', () => {
    const cqTimber = buildMapById('timberline_compound', { battleRule: 'conquest' });
    const bunkerClear = cqTimber.physics.isSegmentOccluded(
      new THREE.Vector3(53.5, -2.0, -8.0),
      new THREE.Vector3(56.5, -2.0, -4.0),
    );
    expect(bunkerClear).toBe(false);
    cqTimber.dispose();
  });
});



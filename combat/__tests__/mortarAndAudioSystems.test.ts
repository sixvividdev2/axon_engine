import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIRE_SUPPORT_CULL_RADIUS_M,
  FIRE_SUPPORT_MAX_VOICES,
  FireSupportVoicePool,
} from '../../bodycam-sdk/BodycamAudio';
import { BodycamController } from '../../bodycam-sdk/BodycamController';
import {
  BodycamInputState,
  DEFAULT_BODYCAM_SDK_CONFIG,
  IBodycamWorldAdapter,
} from '../../bodycam-sdk/types';
import { resolveWeaponProfile } from '../../bodycam-sdk/weaponProfiles';
import {
  isHeadshotSfxEnabled,
  resetHeadshotSfxCacheForTest,
  setHeadshotSfxEnabled,
} from '../../data/audioSettings';
import { LobbyRoomState } from '../../data/multiplayer';
import { VitalsSystem } from '../../engine/survival/VitalsSystem';
import {
  createDefaultMatchState,
  validateAndSanitizeGameMessage,
} from '../../worker/gameRelayGuard';
import {
  MORTAR_CHARGE_SPECS,
  MORTAR_MAX_ELEVATION_RAD,
  MORTAR_MIN_ELEVATION_RAD,
  applyForwardObserverCorrection,
  simulateMortarImpact,
  solveMortarFiringTable,
} from '../MortarBallistics';
import {
  MAX_MORTAR_PITS,
  MAX_SCORCH_DECAL_POOL,
  MORTAR_AI_RECLAIM_DELAY_SEC,
  MORTAR_CREW_REINFORCE_SEC,
  MORTAR_DANGER_CLOSE_RADIUS_M,
  MORTAR_HQ_EXCLUSION_RADIUS_M,
  MORTAR_KIA_COOLDOWN_REFUND_RATIO,
  MORTAR_MISSION_CADENCE_SEC,
  MORTAR_MISSION_CEP_M,
  MORTAR_MISSION_ROUNDS,
  MORTAR_RELOAD_AI_LOADER_SEC,
  MORTAR_RELOAD_SOLO_SEC,
  MORTAR_SWEEP_COOLDOWN_SEC,
  MortarEmplacementSystem,
  MortarMissionEvent,
  MortarSiteConfig,
  computeMortarBlastDamageForActor,
  evaluateMortarDangerClose,
} from '../MortarEmplacementSystem';

function createFlatWorldAdapter(): IBodycamWorldAdapter {
  return {
    sweepCapsule(startPos, dx, dy, dz, _r, _h, _step, out) {
      out.posX = startPos.x + dx;
      out.posY = Math.max(0, startPos.y + dy);
      out.posZ = startPos.z + dz;
      out.grounded = out.posY <= 0.001;
      out.steppedUp = false;
      out.stepDeltaY = 0;
      out.hitWall = false;
      out.hitCeiling = false;
      out.wallNormalX = 0;
      out.wallNormalZ = 0;
      out.groundNormalY = 1;
      out.slopeAngleRad = 0;
    },
    raycast() {
      return false;
    },
    getGroundHeight() {
      return 0;
    },
    isPointSolid() {
      return false;
    },
    getSurfaceMaterial() {
      return 'concrete';
    },
    getBounds() {
      return { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
    },
  } as unknown as IBodycamWorldAdapter;
}

function createBaseInput(overrides: Partial<BodycamInputState> = {}): BodycamInputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    leanLeft: false,
    leanRight: false,
    ads: true,
    adsMode: 'PRIMARY',
    cant: false,
    holdBreath: false,
    vault: false,
    ...overrides,
  };
}

function createSampleLobbyState(): LobbyRoomState {
  return {
    code: 'MORTAR',
    hostUserId: 'host-1',
    hostUsername: 'AlphaLead',
    visibility: 'private',
    status: 'in_match',
    mode: 'battle',
    mapId: 'conquest_valley',
    battleRule: 'conquest',
    maxPlayers: 12,
    botsEnabled: true,
    botCount: 8,
    killLimit: 50,
    botDifficulty: 'tactical',
    matchSequence: 1,
    specialEvent: null,
    chat: [],
    members: [
      {
        userId: 'host-1',
        username: 'AlphaLead',
        rank: 10,
        prestige: 0,
        team: 'A',
        ready: true,
        isHost: true,
        connected: true,
        joinedAt: 1,
      },
      {
        userId: 'peer-2',
        username: 'BravoTwo',
        rank: 8,
        prestige: 0,
        team: 'B',
        ready: true,
        isHost: false,
        connected: true,
        joinedAt: 2,
      },
    ],
    updatedAt: 1,
  };
}

describe('Opt-in Headshot Indicator SFX Settings', () => {
  beforeEach(() => {
    resetHeadshotSfxCacheForTest();
  });

  it('defaults to disabled (false) for full immersion and toggles cleanly', () => {
    expect(isHeadshotSfxEnabled()).toBe(false);
    setHeadshotSfxEnabled(true);
    expect(isHeadshotSfxEnabled()).toBe(true);
    setHeadshotSfxEnabled(false);
    expect(isHeadshotSfxEnabled()).toBe(false);
  });
});

function createStubWeaponRig() {
  const profile = resolveWeaponProfile('m4a1_sbr');
  return {
    root: new THREE.Group(),
    hasCantedOptic: () => false,
    isMagnifiedOpticActive: () => false,
    getTotalMassKg: () => 3.5,
    getOpticZoomMultiplier: () => 1.0,
    isReloading: () => false,
    isSuppressorActionActive: () => false,
    isInspecting: () => false,
    addInertia: () => {},
    applyWeaponRecoil: () => {},
    updateRig: () => {},
    getWeaponProfile: () => profile,
    getReadOnlyRigState: () => ({
      adsBlend: 1,
      cantedBlend: 0,
      pointAimBlend: 0,
      sprintBlend: 0,
      reloadBlend: 0,
      opticZoom: 1,
    }),
  } as any;
}

function createStubAudio() {
  return new Proxy(
    {},
    {
      get: () => () => {},
    },
  ) as any;
}

describe('Hold-Breath Full-Recovery Cooldown & Anti-Spam Debounce', () => {
  it('BodycamController locks hold breath until lung reserve recovers to 100% after depletion', () => {
    const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const ctrl = new BodycamController(cam, createStubWeaponRig(), createStubAudio());
    const adapter = createFlatWorldAdapter();
    const weapon = resolveWeaponProfile('m4a1_sbr');
    const cfg = { ...DEFAULT_BODYCAM_SDK_CONFIG };

    // Deplete full hold-breath reserve while holding breath in ADS
    let t = 0;
    for (let i = 0; i < 480; i++) {
      t += 1 / 60;
      ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    }
    expect(ctrl.isHoldBreathDepletedLocked()).toBe(true);
    expect(ctrl.isHoldBreathActive()).toBe(false);

    // Recover partially and attempt to re-engage hold breath -> must remain locked
    for (let i = 0; i < 150; i++) {
      t += 1 / 60;
      ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: false }), adapter, weapon, cfg, 1.0, 100);
    }
    expect(ctrl.getHoldBreathRemainingFraction()).toBeGreaterThan(0.15);
    expect(ctrl.getHoldBreathRemainingFraction()).toBeLessThan(0.99);
    expect(ctrl.isHoldBreathDepletedLocked()).toBe(true);

    ctrl.update(1 / 60, t + 1 / 60, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    expect(ctrl.isHoldBreathActive()).toBe(false);

    // Recover all the way to 100% -> lock clears and hold breath works again
    for (let i = 0; i < 600; i++) {
      t += 1 / 60;
      ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: false }), adapter, weapon, cfg, 1.0, 100);
    }
    expect(ctrl.isHoldBreathDepletedLocked()).toBe(false);
    expect(ctrl.getHoldBreathRemainingFraction()).toBeCloseTo(1.0, 2);

    ctrl.update(1 / 60, t + 1 / 60, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    expect(ctrl.isHoldBreathActive()).toBe(true);
  });

  it('BodycamController enforces voluntary early-release debounce to prevent spam', () => {
    const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 500);
    const ctrl = new BodycamController(cam, createStubWeaponRig(), createStubAudio());
    const adapter = createFlatWorldAdapter();
    const weapon = resolveWeaponProfile('m4a1_sbr');
    const cfg = { ...DEFAULT_BODYCAM_SDK_CONFIG };

    let t = 0;
    // Engage hold breath for 0.3s then release
    for (let i = 0; i < 18; i++) {
      t += 1 / 60;
      ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    }
    expect(ctrl.isHoldBreathActive()).toBe(true);

    t += 1 / 60;
    ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: false }), adapter, weapon, cfg, 1.0, 100);
    expect(ctrl.isHoldBreathActive()).toBe(false);

    // Immediate re-press within 0.65s debounce is ignored
    t += 0.1;
    ctrl.update(0.1, t, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    expect(ctrl.isHoldBreathActive()).toBe(false);

    // After debounce expires (>0.65s), hold breath engages cleanly
    for (let i = 0; i < 45; i++) {
      t += 1 / 60;
      ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: false }), adapter, weapon, cfg, 1.0, 100);
    }
    t += 1 / 60;
    ctrl.update(1 / 60, t, createBaseInput({ ads: true, holdBreath: true }), adapter, weapon, cfg, 1.0, 100);
    expect(ctrl.isHoldBreathActive()).toBe(true);
  });

  it('VitalsSystem mirrors full-recovery depletion lockout and voluntary release debounce', () => {
    const vitals = new VitalsSystem();

    // Hold breath until full 7.0s reserve is depleted (460 frames = 7.67s)
    for (let i = 0; i < 460; i++) {
      vitals.update(1 / 60, {
        isSprinting: false,
        isMoving: false,
        isAds: true,
        wantsHoldBreath: true,
        isHealingOrBleeding: false,
        encumbranceRatio: 0,
        stamina: 1.0,
      });
    }
    expect(vitals.holdBreathDepletedLock).toBe(true);
    expect(vitals.holdBreathActive).toBe(false);

    // Partial recovery (~40%) -> still locked
    for (let i = 0; i < 120; i++) {
      vitals.update(1 / 60, {
        isSprinting: false,
        isMoving: false,
        isAds: true,
        wantsHoldBreath: false,
        isHealingOrBleeding: false,
        encumbranceRatio: 0,
        stamina: 1.0,
      });
    }
    expect(vitals.holdBreathDepletedLock).toBe(true);
    vitals.update(1 / 60, {
      isSprinting: false,
      isMoving: false,
      isAds: true,
      wantsHoldBreath: true,
      isHealingOrBleeding: false,
      encumbranceRatio: 0,
      stamina: 1.0,
    });
    expect(vitals.holdBreathActive).toBe(false);

    // Full recovery (7.0s / ~0.90/s = ~7.8s -> 540 frames) -> unlocks cleanly
    for (let i = 0; i < 540; i++) {
      vitals.update(1 / 60, {
        isSprinting: false,
        isMoving: false,
        isAds: true,
        wantsHoldBreath: false,
        isHealingOrBleeding: false,
        encumbranceRatio: 0,
        stamina: 1.0,
      });
    }
    expect(vitals.holdBreathDepletedLock).toBe(false);
    vitals.update(1 / 60, {
      isSprinting: false,
      isMoving: false,
      isAds: true,
      wantsHoldBreath: true,
      isHealingOrBleeding: false,
      encumbranceRatio: 0,
      stamina: 1.0,
    });
    expect(vitals.holdBreathActive).toBe(true);
  });
});

describe('FireSupportVoicePool (12-Voice Cap, Priority Stealing & 350m Cull)', () => {
  it('enforces hard 12-voice cap, protects P0, steals oldest P2 first, and culls >350m', () => {
    const pool = new FireSupportVoicePool(FIRE_SUPPORT_MAX_VOICES, FIRE_SUPPORT_CULL_RADIUS_M);
    const stopped: string[] = [];

    // Beyond 350m cull radius is rejected immediately
    expect(pool.acquire(0, 355, 1.0, 2.0, () => stopped.push('far'))).toBeNull();

    // Fill 10 P0 voices and 2 P2 voices (= 12 total)
    for (let i = 0; i < 10; i++) {
      expect(pool.acquire(0, 50, 1.0 + i * 0.01, 5.0, () => stopped.push(`p0_${i}`))).not.toBeNull();
    }
    expect(pool.acquire(2, 90, 2.0, 5.0, () => stopped.push('p2_oldest'))).not.toBeNull();
    expect(pool.acquire(2, 90, 2.1, 5.0, () => stopped.push('p2_newer'))).not.toBeNull();
    expect(pool.getActiveCount(2.2)).toBe(12);

    // New P1 voice steals oldest P2 voice first
    expect(pool.acquire(1, 30, 2.2, 5.0, () => stopped.push('p1_a'))).not.toBeNull();
    expect(stopped).toEqual(['p2_oldest']);
    expect(pool.getActiveCount(2.2)).toBe(12);

    // Next P1 steals remaining P2 voice
    expect(pool.acquire(1, 30, 2.3, 5.0, () => stopped.push('p1_b'))).not.toBeNull();
    expect(stopped).toEqual(['p2_oldest', 'p2_newer']);

    // Now pool has 10 P0 + 2 P1. A new P2 cannot steal P0 or P1 -> rejected!
    expect(pool.acquire(2, 80, 2.4, 5.0, () => stopped.push('p2_denied'))).toBeNull();
    expect(pool.getActiveCount(2.4)).toBe(12);

    // Fill all 12 slots with P0 -> P1 cannot steal P0!
    const p0OnlyPool = new FireSupportVoicePool(12, 350);
    for (let i = 0; i < 12; i++) {
      expect(p0OnlyPool.acquire(0, 20, 1.0 + i * 0.01, 5.0, () => {})).not.toBeNull();
    }
    expect(p0OnlyPool.acquire(1, 15, 2.0, 5.0, () => {})).toBeNull();
  });
});

describe('81mm Mortar Ballistics & Firing Table Solver', () => {
  it('solves high-angle 45°-80° firing solutions across Charges 1-4 with round-trip accuracy and wind compensation', () => {
    const origin = new THREE.Vector3(0, 2.0, 0);
    const target = new THREE.Vector3(180, 5.0, -240); // 300m horizontal, +3m elevation delta
    const windX = 5.5;
    const windZ = -2.2;

    const sol = solveMortarFiringTable(origin, target, windX, windZ);
    const rec = sol.recommended;
    expect(rec).not.toBeNull();
    expect(rec?.inRange).toBe(true);
    expect(rec!.elevationRad).toBeGreaterThanOrEqual(MORTAR_MIN_ELEVATION_RAD - 1e-4);
    expect(rec!.elevationRad).toBeLessThanOrEqual(MORTAR_MAX_ELEVATION_RAD + 1e-4);
    expect(rec!.charge).toBeGreaterThanOrEqual(1);
    expect(rec!.charge).toBeLessThanOrEqual(4);
    expect(rec!.deflectionMils).toBeGreaterThanOrEqual(0);
    expect(rec!.deflectionMils).toBeLessThan(6400);

    // Simulate the solved elevation/azimuth under identical wind -> should land within 5m of target
    const sim = simulateMortarImpact(
      origin,
      rec!.azimuthRad,
      rec!.elevationRad,
      rec!.charge,
      windX,
      windZ,
      () => target.y,
    );
    const missDist = Math.hypot(sim.impactPos.x - target.x, sim.impactPos.z - target.z);
    expect(missDist).toBeLessThan(5.0);

    // Forward observer Add/Drop & Left/Right correction shifts target accurately
    const corrected = applyForwardObserverCorrection(origin, target, 50, -25);
    const baseDist = Math.hypot(target.x - origin.x, target.z - origin.z);
    const corrDist = Math.hypot(corrected.x - origin.x, corrected.z - origin.z);
    expect(corrDist).toBeGreaterThan(baseDist + 40);
    expect(MORTAR_CHARGE_SPECS[4].maxRangeM).toBeGreaterThan(MORTAR_CHARGE_SPECS[1].maxRangeM);
  });
});

describe('MortarEmplacementSystem (Phase 1 + Phase 2 Constraints)', () => {
  function buildTestSites(count = 6): MortarSiteConfig[] {
    const sites: MortarSiteConfig[] = [
      {
        pitId: 'mortar_hq_a',
        ownerTeam: 'A',
        sourceType: 'HQ',
        sourceId: 'hq_a',
        position: [-200, 0, 0],
        zeroBearingRad: Math.PI * 0.5,
        active: true,
      },
      {
        pitId: 'mortar_hq_b',
        ownerTeam: 'B',
        sourceType: 'HQ',
        sourceId: 'hq_b',
        position: [200, 0, 0],
        zeroBearingRad: Math.PI * 1.5,
        active: true,
      },
    ];
    for (let i = 2; i < count; i++) {
      sites.push({
        pitId: `mortar_fob_${i}`,
        ownerTeam: i % 2 === 0 ? 'A' : 'B',
        sourceType: 'FOB',
        sourceId: `fob_${i}`,
        position: [-80 + i * 35, 0, 40],
        zeroBearingRad: 0,
        active: false,
      });
    }
    return sites;
  }

  it('caps pits at MAX_MORTAR_PITS (6), skips inactive/KIA pits, and reinforces crew in 50s', () => {
    const scene = new THREE.Scene();
    const sys = new MortarEmplacementSystem({ scene, isHost: true });
    sys.configureSites(buildTestSites(9));

    expect(sys.getPitStates().length).toBe(MAX_MORTAR_PITS);
    expect(sys.getDiagnostics().scorchDecalPoolSize).toBe(MAX_SCORCH_DECAL_POOL);

    // Only the 2 HQ pits are active initially; 4 FOB pits are INACTIVE -> activeTickedPits === 2
    sys.update(0.016, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    expect(sys.getDiagnostics().activeTickedPits).toBe(2);

    // Kill both crewmen on Team B HQ pit -> transitions to KIA_REINFORCING (0ms active tick)
    const gHit = sys.damageCrewMember('mortar_hq_b', 'gunner', 120, true);
    const lHit = sys.damageCrewMember('mortar_hq_b', 'loader', 120, false);
    expect(gHit?.killed).toBe(true);
    expect(lHit?.bothCrewDead).toBe(true);
    expect(sys.getPitState('mortar_hq_b')?.status).toBe('KIA_REINFORCING');
    expect(sys.getPitState('mortar_hq_b')?.respawnTimerSec).toBe(MORTAR_CREW_REINFORCE_SEC);

    sys.update(0.016, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    expect(sys.getDiagnostics().activeTickedPits).toBe(1);

    // Advance 50s -> crew reinforces back to ACTIVE_AI with 100 HP each
    for (let i = 0; i < 505; i++) {
      sys.update(0.1, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    }
    const after = sys.getPitState('mortar_hq_b');
    expect(after?.status).toBe('ACTIVE_AI');
    expect(after?.gunnerAiHp).toBe(100);
    expect(after?.loaderAiHp).toBe(100);

    // Runtime kill-switch disables everything cleanly
    sys.setEnabled(false);
    sys.update(0.016, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    expect(sys.getDiagnostics().activeTickedPits).toBe(0);
    sys.dispose();
  });

  it('enforces host seat arbitration, living enemy crew lock, enemy infiltration, and 2.4s -> 4.2s loader death cadence', () => {
    const scene = new THREE.Scene();
    const sys = new MortarEmplacementSystem({ scene, isHost: true });
    sys.configureSites(buildTestSites(2));

    // Player 1 mounts friendly Team A HQ pit
    const p1Mount = sys.requestSeat('mortar_hq_a', 'p1', 'Alpha1', 'A');
    expect(p1Mount.ok).toBe(true);
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('PLAYER_MANNED');

    // Player 2 cannot steal Player 1's occupied station
    const stealAttempt = sys.requestSeat('mortar_hq_a', 'p2', 'Alpha2', 'A');
    expect(stealAttempt.ok).toBe(false);
    expect(stealAttempt.reason).toContain('Station Occupied');

    // Fire with AI Loader alive -> reload duration is 2.4s and recoil knocks bubble off-level
    const shot1 = sys.tryPlayerFire('mortar_hq_a', 'p1', 'A');
    expect(shot1).not.toBeNull();
    const hudWithLoader = sys.getPlayerMortarHudTelemetry('mortar_hq_a', false);
    expect(hudWithLoader?.reloadDurationSec).toBeCloseTo(MORTAR_RELOAD_AI_LOADER_SEC, 2);
    expect(hudWithLoader?.isLevelSettled).toBe(false);

    // Re-leveling bubble & stakes restores level
    for (let i = 0; i < 60; i++) {
      sys.relevelBubbleAndStakes('mortar_hq_a', 0.05);
    }
    expect(sys.getPlayerMortarHudTelemetry('mortar_hq_a', false)?.isLevelSettled).toBe(true);

    // Kill AI Loader mid-session -> reload cadence dynamically switches 2.4s -> 4.2s
    sys.damageCrewMember('mortar_hq_a', 'loader', 120, true);
    const hudSolo = sys.getPlayerMortarHudTelemetry('mortar_hq_a', false);
    expect(hudSolo?.reloadDurationSec).toBeCloseTo(MORTAR_RELOAD_SOLO_SEC, 2);
    expect(hudSolo?.aiLoaderAlive).toBe(false);

    // Player 1 exits -> AI gunner reclaims after 1.0s
    expect(sys.releaseSeat('mortar_hq_a', 'p1')).toBe(true);
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('ACTIVE_AI');
    sys.update(MORTAR_AI_RECLAIM_DELAY_SEC + 0.1, { localPlayerPos: new THREE.Vector3(-200, 0, 0) });

    // Team A player tries to mount Team B pit while enemy crew is alive -> blocked!
    const enemyBlocked = sys.requestSeat('mortar_hq_b', 'p1', 'Alpha1', 'A');
    expect(enemyBlocked.ok).toBe(false);
    expect(enemyBlocked.reason).toBe('Neutralize Enemy Crew First');

    // Kill both enemy crewmen -> Team A player can infiltrate & operate captured enemy mortar on solo 4.2s cadence!
    sys.damageCrewMember('mortar_hq_b', 'gunner', 120, true);
    sys.damageCrewMember('mortar_hq_b', 'loader', 120, true);
    const infiltrate = sys.requestSeat('mortar_hq_b', 'p1', 'Alpha1', 'A');
    expect(infiltrate.ok).toBe(true);
    const capHud = sys.getPlayerMortarHudTelemetry('mortar_hq_b', false);
    expect(capHud?.isCapturedEnemyPit).toBe(true);
    expect(capHud?.reloadDurationSec).toBeCloseTo(MORTAR_RELOAD_SOLO_SEC, 2);

    sys.dispose();
  });

  it('enforces 65m HQ exclusion & 80m friendly flag safety for autonomous AI and exact blast damage ratios', () => {
    const scene = new THREE.Scene();
    const sys = new MortarEmplacementSystem({ scene, isHost: true });
    sys.configureSites(buildTestSites(2));

    const exclusions = [
      { x: 200, z: 0, radiusM: MORTAR_HQ_EXCLUSION_RADIUS_M, team: 'B' as const, kind: 'hq' as const },
      { x: -100, z: 0, radiusM: 80, team: 'A' as const, kind: 'flag' as const },
    ];
    // Target inside Team B HQ exclusion (x=210) and target within 80m of Team A flag (x=-90) must be skipped
    const picked = sys.selectAutonomousAiTarget(
      'mortar_hq_a',
      [
        { id: 'e_hq', team: 'B', x: 210, y: 0, z: 0, alive: true },
        { id: 'e_near_flag', team: 'B', x: -90, y: 0, z: 0, alive: true },
        { id: 'e_valid', team: 'B', x: 50, y: 0, z: 20, alive: true },
      ],
      exclusions,
    );
    expect(picked).not.toBeNull();
    expect(picked!.x).toBeCloseTo(50, 1);
    expect(picked!.z).toBeCloseTo(20, 1);

    // Blast damage rules: 100% enemy, 100% caller self-damage, 25% teammate splash
    const enemyDmg = computeMortarBlastDamageForActor({
      distanceM: 3,
      blastRadiusM: 13,
      maxDamage: 138,
      actorId: 'enemy-1',
      actorTeam: 'B',
      callerId: 'p1',
      callerTeam: 'A',
    });
    const selfDmg = computeMortarBlastDamageForActor({
      distanceM: 3,
      blastRadiusM: 13,
      maxDamage: 138,
      actorId: 'p1',
      actorTeam: 'A',
      callerId: 'p1',
      callerTeam: 'A',
    });
    const mateDmg = computeMortarBlastDamageForActor({
      distanceM: 3,
      blastRadiusM: 13,
      maxDamage: 138,
      actorId: 'mate-2',
      actorTeam: 'A',
      callerId: 'p1',
      callerTeam: 'A',
    });

    expect(enemyDmg.damage).toBeGreaterThan(80);
    expect(selfDmg.damage).toBe(enemyDmg.damage);
    expect(mateDmg.isFriendlySplash).toBe(true);
    expect(mateDmg.damage).toBe(Math.round(enemyDmg.damage * 0.25));

    sys.dispose();
  });
});

describe('gameRelayGuard Mortar Packet Security', () => {
  it('blocks non-host forged fire_support_sync/mortar_launch and sanitizes client mortar requests', () => {
    const lobby = createSampleLobbyState();
    const matchState = createDefaultMatchState();

    // Non-host trying to broadcast host-only mortar_launch must be rejected
    const forged = validateAndSanitizeGameMessage(
      { type: 'game:mortar_launch', pitId: 'mortar_hq_a', shellId: 's1' },
      lobby,
      matchState,
      { userId: 'peer-2', username: 'BravoTwo' },
    );
    expect(forged).toBeNull();

    // Invalid charge level (99) is rejected outright by relay guard
    const invalidCharge = validateAndSanitizeGameMessage(
      {
        type: 'game:mortar_fire_request',
        pitId: 'mortar_hq_b',
        azimuthRad: 1.25,
        elevationRad: 1.0,
        chargeLevel: 99,
      },
      lobby,
      matchState,
      { userId: 'peer-2', username: 'BravoTwo' },
    );
    expect(invalidCharge).toBeNull();

    // Valid client fire request clamps out-of-range elevation into [45°, 80°]
    const clientFire = validateAndSanitizeGameMessage(
      {
        type: 'game:mortar_fire_request',
        pitId: 'mortar_hq_b',
        azimuthRad: 1.25,
        elevationRad: 0.1, // below 45 deg -> clamped up
        chargeLevel: 3,
      },
      lobby,
      matchState,
      { userId: 'peer-2', username: 'BravoTwo' },
    );
    expect(clientFire).not.toBeNull();
    expect(clientFire?.payload.chargeLevel).toBe(3);
    expect(Number(clientFire?.payload.elevationRad)).toBeGreaterThanOrEqual(0.78);

    // Host fire_support_sync passes and caps pit list to 6
    const hostSync = validateAndSanitizeGameMessage(
      {
        type: 'game:fire_support_sync',
        enabled: true,
        pits: Array.from({ length: 10 }, (_, idx) => ({
          pitId: `pit_${idx}`,
          ownerTeam: 'A',
          sourceType: 'HQ',
          sourceId: 'hq_a',
          position: [0, 0, 0],
          status: 'ACTIVE_AI',
          gunnerAiHp: 100,
          loaderAiHp: 100,
          respawnTimerSec: 0,
          seatedPlayerId: null,
          seatedPlayerName: null,
          seatedPlayerTeam: null,
          currentAzimuthRad: 0,
          currentElevationRad: 1.0,
          currentChargeLevel: 2,
          reloadProgress01: 1,
        })),
      },
      lobby,
      matchState,
      { userId: 'host-1', username: 'AlphaLead' },
    );
    expect(hostSync).not.toBeNull();
    expect((hostSync?.payload.pits as unknown[]).length).toBe(6);
  });

  it('validates Phase 3 fire_support_request, host-only fire_support_rejected, and sync teams/activeMissions', () => {
    const lobby = createSampleLobbyState();
    const matchState = createDefaultMatchState();

    // Client mortar sweep request routes to host with sanitized finite coordinates
    const req = validateAndSanitizeGameMessage(
      {
        type: 'game:fire_support_request',
        kind: 'mortar_sweep',
        targetX: 42.1234,
        targetZ: -88.9876,
      },
      lobby,
      matchState,
      { userId: 'peer-2', username: 'BravoTwo' },
    );
    expect(req).not.toBeNull();
    expect(req?.targetUserId).toBe('host-1');
    expect(req?.payload.targetX).toBe(42.12);
    expect(req?.payload.targetZ).toBe(-88.99);

    // Invalid kind or NaN coords rejected
    expect(
      validateAndSanitizeGameMessage(
        { type: 'game:fire_support_request', kind: 'invalid', targetX: 10, targetZ: 10 },
        lobby,
        matchState,
        { userId: 'peer-2', username: 'BravoTwo' },
      ),
    ).toBeNull();
    expect(
      validateAndSanitizeGameMessage(
        { type: 'game:fire_support_request', kind: 'mortar_sweep', targetX: Number.NaN, targetZ: 10 },
        lobby,
        matchState,
        { userId: 'peer-2', username: 'BravoTwo' },
      ),
    ).toBeNull();

    // Non-host forged fire_support_rejected blocked; host rejection routed directly to requester
    expect(
      validateAndSanitizeGameMessage(
        {
          type: 'game:fire_support_rejected',
          targetUserId: 'host-1',
          kind: 'mortar_sweep',
          reason: 'forged',
        },
        lobby,
        matchState,
        { userId: 'peer-2', username: 'BravoTwo' },
      ),
    ).toBeNull();

    const hostRej = validateAndSanitizeGameMessage(
      {
        type: 'game:fire_support_rejected',
        targetUserId: 'peer-2',
        kind: 'mortar_sweep',
        reason: 'Target Inside 65m HQ No-Fire Zone',
      },
      lobby,
      matchState,
      { userId: 'host-1', username: 'AlphaLead' },
    );
    expect(hostRej).not.toBeNull();
    expect(hostRej?.targetUserId).toBe('peer-2');
    expect(hostRej?.payload.reason).toBe('Target Inside 65m HQ No-Fire Zone');

    // Host fire_support_sync sanitizes teams tuple and caps activeMissions to 2
    const syncWithMissions = validateAndSanitizeGameMessage(
      {
        type: 'game:fire_support_sync',
        enabled: true,
        pits: [],
        teams: [
          {
            team: 'A',
            airStrikeCooldownSec: 0,
            airStrikeMaxCooldownSec: 150,
            mortarStrikeCooldownSec: 71.4,
            mortarStrikeMaxCooldownSec: 75,
            activeBomberId: null,
            activeMortarMissionId: 'fm_A_1',
          },
          {
            team: 'B',
            airStrikeCooldownSec: 0,
            airStrikeMaxCooldownSec: 150,
            mortarStrikeCooldownSec: 0,
            mortarStrikeMaxCooldownSec: 75,
            activeBomberId: null,
            activeMortarMissionId: null,
          },
        ],
        activeMissions: [
          { missionId: 'm1', pitId: 'p1', team: 'A', targetX: 10, targetZ: 20, roundsRemaining: 4, totalRounds: 5, callerName: 'Alpha' },
          { missionId: 'm2', pitId: 'p2', team: 'B', targetX: 30, targetZ: 40, roundsRemaining: 2, totalRounds: 5, callerName: 'Bravo' },
          { missionId: 'm3', pitId: 'p3', team: 'A', targetX: 50, targetZ: 60, roundsRemaining: 1, totalRounds: 5, callerName: 'Extra' },
        ],
      },
      lobby,
      matchState,
      { userId: 'host-1', username: 'AlphaLead' },
    );
    expect(syncWithMissions).not.toBeNull();
    expect((syncWithMissions?.payload.teams as unknown[]).length).toBe(2);
    expect((syncWithMissions?.payload.activeMissions as unknown[]).length).toBe(2);
  });
});

describe('Phase 3 Conquest Fire Support — 1-Sweep 5-Round Mortar Overrides', () => {
  function buildPhase3Sites(): MortarSiteConfig[] {
    return [
      {
        pitId: 'mortar_hq_a',
        ownerTeam: 'A',
        sourceType: 'HQ',
        sourceId: 'hq_a',
        position: [-200, 0, 0],
        zeroBearingRad: Math.PI * 0.5,
        active: true,
      },
      {
        pitId: 'mortar_hq_b',
        ownerTeam: 'B',
        sourceType: 'HQ',
        sourceId: 'hq_b',
        position: [200, 0, 0],
        zeroBearingRad: Math.PI * 1.5,
        active: true,
      },
    ];
  }

  it('executes 5-round 1.4s cadence 18m CEP fire mission with 75s cooldown, 65m HQ block, and 45m Danger Close warning', () => {
    const scene = new THREE.Scene();
    const launched: Array<{ callerId: string; callerTeam: string; ix: number; iz: number; t: number }> = [];
    const events: MortarMissionEvent[] = [];
    let simTime = 0;

    const sys = new MortarEmplacementSystem({
      scene,
      isHost: true,
      onLaunchBroadcast: (pkt) => {
        launched.push({
          callerId: pkt.callerId,
          callerTeam: pkt.callerTeam,
          ix: pkt.ix,
          iz: pkt.iz,
          t: simTime,
        });
      },
      onMissionEvent: (ev) => events.push(ev),
    });
    sys.configureSites(buildPhase3Sites());

    const exclusions = [
      { x: -200, z: 0, radiusM: MORTAR_HQ_EXCLUSION_RADIUS_M, team: 'A' as const, kind: 'hq' as const },
      { x: 200, z: 0, radiusM: MORTAR_HQ_EXCLUSION_RADIUS_M, team: 'B' as const, kind: 'hq' as const },
    ];

    // 1. Target inside 65m Enemy HQ exclusion is rejected without starting cooldown
    const hqBlocked = sys.requestMortarFireMission({
      callerId: 'p1',
      callerName: 'Alpha1',
      callerTeam: 'A',
      targetX: 185,
      targetZ: 10,
      exclusionZones: exclusions,
      friendlyPositions: [{ x: 0, z: 0 }],
    });
    expect(hqBlocked.ok).toBe(false);
    expect(hqBlocked.reason).toContain('65m HQ');
    expect(sys.getTeamFireSupportState('A').mortarStrikeCooldownSec).toBe(0);

    // 2. Danger Close (<45m) helper & reticle evaluation accurately detect friendly proximity
    const dcClose = evaluateMortarDangerClose(20, 10, [{ x: 5, z: 10 }], MORTAR_DANGER_CLOSE_RADIUS_M);
    expect(dcClose.dangerClose).toBe(true);
    expect(dcClose.minFriendlyDistM).toBeCloseTo(15, 2);

    const evalClose = sys.evaluateFireMissionTarget({
      team: 'A',
      targetX: 20,
      targetZ: 10,
      exclusionZones: exclusions,
      friendlyPositions: [{ x: 0, z: 10 }], // 20m away -> Danger Close
    });
    expect(evalClose.canCall).toBe(true);
    expect(evalClose.dangerClose).toBe(true);

    // 3. Call valid 5-round Mortar Sweep at (20, 10) with Danger Close warning
    const callRes = sys.requestMortarFireMission({
      callerId: 'p1',
      callerName: 'Alpha1',
      callerTeam: 'A',
      targetX: 20,
      targetZ: 10,
      exclusionZones: exclusions,
      friendlyPositions: [{ x: 0, z: 10 }],
    });
    expect(callRes.ok).toBe(true);
    expect(callRes.dangerClose).toBe(true);
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('FIRE_MISSION');
    expect(sys.getTeamFireSupportState('A').mortarStrikeCooldownSec).toBeCloseTo(MORTAR_SWEEP_COOLDOWN_SEC, 2);

    // Concurrent request on Team A while active is rejected
    const concurrent = sys.requestMortarFireMission({
      callerId: 'p2',
      callerName: 'Alpha2',
      callerTeam: 'A',
      targetX: 30,
      targetZ: -20,
      exclusionZones: exclusions,
      friendlyPositions: [],
    });
    expect(concurrent.ok).toBe(false);

    // Advance 8.0s in 0.05s steps -> all 5 rounds launch at ~1.4s cadence within ~18m CEP (+ small ballistic tolerance)
    for (let i = 0; i < 160; i++) {
      simTime += 0.05;
      sys.update(0.05, {
        localPlayerPos: new THREE.Vector3(0, 0, 0),
        exclusionZones: exclusions,
      });
    }

    expect(launched.length).toBe(MORTAR_MISSION_ROUNDS);
    for (const r of launched) {
      expect(r.callerId).toBe('p1');
      expect(r.callerTeam).toBe('A');
      const missFromTarget = Math.hypot(r.ix - 20, r.iz - 10);
      expect(missFromTarget).toBeLessThanOrEqual(MORTAR_MISSION_CEP_M + 6.5);
    }
    // Check 1.4s cadence between consecutive shells
    for (let i = 1; i < launched.length; i++) {
      const gap = launched[i].t - launched[i - 1].t;
      expect(gap).toBeGreaterThanOrEqual(MORTAR_MISSION_CADENCE_SEC - 0.1);
      expect(gap).toBeLessThanOrEqual(MORTAR_MISSION_CADENCE_SEC + 0.1);
    }

    // Pit returns to ACTIVE_AI and team cooldown continues counting down from 75s
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('ACTIVE_AI');
    expect(sys.getTeamFireSupportState('A').activeMortarMissionId).toBeNull();
    expect(sys.getTeamFireSupportState('A').mortarStrikeCooldownSec).toBeGreaterThan(60);
    expect(events.map((e) => e.kind)).toEqual(['started', 'completed']);

    sys.dispose();
  });

  it('aborts active fire mission cleanly on mid-mission player [F] takeover without refunding 75s cooldown', () => {
    const scene = new THREE.Scene();
    const launched: string[] = [];
    const events: MortarMissionEvent[] = [];

    const sys = new MortarEmplacementSystem({
      scene,
      isHost: true,
      onLaunchBroadcast: (pkt) => launched.push(pkt.shellId),
      onMissionEvent: (ev) => events.push(ev),
    });
    sys.configureSites(buildPhase3Sites());

    const res = sys.requestMortarFireMission({
      callerId: 'p1',
      callerName: 'Alpha1',
      callerTeam: 'A',
      targetX: 10,
      targetZ: 0,
      exclusionZones: [],
      friendlyPositions: [],
    });
    expect(res.ok).toBe(true);

    // Let 1 round launch (0.3s)
    for (let i = 0; i < 6; i++) {
      sys.update(0.05, { localPlayerPos: new THREE.Vector3(-200, 0, 0) });
    }
    expect(launched.length).toBe(1);

    // Friendly player presses [F] to seize the mortar mid-mission
    const seatRes = sys.requestSeat('mortar_hq_a', 'p2', 'Alpha2', 'A');
    expect(seatRes.ok).toBe(true);
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('PLAYER_MANNED');
    expect(sys.getPitState('mortar_hq_a')?.activeMissionId).toBeNull();
    expect(sys.getTeamFireSupportState('A').activeMortarMissionId).toBeNull();
    // Team 75s cooldown remains consumed (no refund on voluntary friendly takeover)
    expect(sys.getTeamFireSupportState('A').mortarStrikeCooldownSec).toBeGreaterThan(72);

    // Advance 5 more seconds -> zero additional AI sweep rounds fire
    for (let i = 0; i < 100; i++) {
      sys.update(0.05, { localPlayerPos: new THREE.Vector3(-200, 0, 0) });
    }
    expect(launched.length).toBe(1);
    expect(events.some((e) => e.kind === 'aborted_takeover' && e.refundedCooldownSec === 0)).toBe(true);

    sys.dispose();
  });

  it('aborts active fire mission and refunds 50% (37.5s) of 75s cooldown if enemy kills AI crew mid-sweep', () => {
    const scene = new THREE.Scene();
    const launched: string[] = [];
    const events: MortarMissionEvent[] = [];

    const sys = new MortarEmplacementSystem({
      scene,
      isHost: true,
      onLaunchBroadcast: (pkt) => launched.push(pkt.shellId),
      onMissionEvent: (ev) => events.push(ev),
    });
    sys.configureSites(buildPhase3Sites());

    const res = sys.requestMortarFireMission({
      callerId: 'p1',
      callerName: 'Alpha1',
      callerTeam: 'A',
      targetX: 25,
      targetZ: -15,
      exclusionZones: [],
      friendlyPositions: [],
    });
    expect(res.ok).toBe(true);

    // Fire 1st round
    for (let i = 0; i < 6; i++) {
      sys.update(0.05, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    }
    expect(launched.length).toBe(1);
    const cdBeforeKia = sys.getTeamFireSupportState('A').mortarStrikeCooldownSec;
    expect(cdBeforeKia).toBeGreaterThan(74);

    // Enemy kills both AI crewmen mid-mission -> immediate abort + 50% (37.5s) cooldown refund!
    sys.damageCrewMember('mortar_hq_a', 'gunner', 120, true);
    const secondKill = sys.damageCrewMember('mortar_hq_a', 'loader', 120, true);
    const expectedRefund = MORTAR_SWEEP_COOLDOWN_SEC * MORTAR_KIA_COOLDOWN_REFUND_RATIO;

    expect(secondKill?.bothCrewDead).toBe(true);
    expect(secondKill?.abortedMissionRefundSec).toBeCloseTo(expectedRefund, 2);
    expect(sys.getPitState('mortar_hq_a')?.status).toBe('KIA_REINFORCING');
    expect(sys.getTeamFireSupportState('A').activeMortarMissionId).toBeNull();
    expect(sys.getTeamFireSupportState('A').mortarStrikeCooldownSec).toBeCloseTo(
      cdBeforeKia - expectedRefund,
      1,
    );
    expect(events.some((e) => e.kind === 'aborted_crew_kia' && e.refundedCooldownSec === expectedRefund)).toBe(true);

    // Advance 5 more seconds -> no remaining sweep rounds fire while KIA_REINFORCING
    for (let i = 0; i < 100; i++) {
      sys.update(0.05, { localPlayerPos: new THREE.Vector3(0, 0, 0) });
    }
    expect(launched.length).toBe(1);

    sys.dispose();
  });
});

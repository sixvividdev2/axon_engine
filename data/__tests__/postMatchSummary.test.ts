import { describe, expect, it } from 'vitest';
import {
  appendRecentMatch,
  applyMatchProgression,
  buildGuestMatchSummary,
  buildMatchSummaryExportPayload,
  buildRecentMatchRecord,
  compareRecentMatches,
  computePostMatchSummary,
  formatMatchExportFilename,
  MAX_RECENT_MATCHES,
  resolveMatchWeaponName,
  sanitizeMatchResultInput,
  sanitizeRecentMatchRecord,
  type CareerProgressionState,
  type CombatantMatchStats,
} from '../progression';

function makeCombatant(overrides: Partial<CombatantMatchStats> & { id: string; name: string }): CombatantMatchStats {
  return {
    team: 'A',
    isLocalPlayer: false,
    isBot: false,
    kills: 0,
    deaths: 0,
    headshots: 0,
    assists: 0,
    grenadeKills: 0,
    meleeKills: 0,
    damageDealt: 0,
    afkSeconds: 0,
    ...overrides,
  };
}

describe('computePostMatchSummary', () => {
  it('treats 0 deaths with >= 1 kill as infinite K/D for Match MVP and tie-breaks by kills', () => {
    const combatants: CombatantMatchStats[] = [
      makeCombatant({ id: 'a', name: 'ALPHA', kills: 12, deaths: 1, headshots: 4, assists: 2, damageDealt: 1200 }),
      makeCombatant({ id: 'b', name: 'BRAVO-BOT', isBot: true, kills: 5, deaths: 0, headshots: 2, damageDealt: 550 }),
      makeCombatant({ id: 'c', name: 'CHARLIE', isLocalPlayer: true, kills: 7, deaths: 0, headshots: 3, damageDealt: 820 }),
    ];

    const res = computePostMatchSummary({
      mode: 'battle',
      kills: 7,
      headshots: 3,
      deaths: 0,
      outcome: 'victory',
      weaponKills: {},
      matchDurationSec: 180,
      combatants,
    });

    expect(res.mvp?.id).toBe('c');
    expect(res.mvp?.kdRatio).toBeNull();
    expect(res.mvp?.kdDisplay).toBe('∞');

    // Leaderboard still sorts primarily by kills descending
    expect(res.leaderboard.map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(res.leaderboard.find((e) => e.id === 'c')?.isMvp).toBe(true);
  });

  it('allows AI bots to win Match MVP and awards multiple badges to the same player', () => {
    const combatants: CombatantMatchStats[] = [
      makeCombatant({
        id: 'bot1',
        name: 'SPECTRE-01',
        isBot: true,
        team: 'B',
        kills: 15,
        deaths: 2,
        headshots: 8,
        assists: 1,
        grenadeKills: 4,
        meleeKills: 3,
        damageDealt: 1800,
      }),
      makeCombatant({
        id: 'p1',
        name: 'YOU',
        isLocalPlayer: true,
        kills: 10,
        deaths: 4,
        headshots: 3,
        assists: 6,
        grenadeKills: 1,
        meleeKills: 0,
        damageDealt: 1150,
      }),
    ];

    const res = computePostMatchSummary({
      mode: 'battle',
      kills: 10,
      headshots: 3,
      deaths: 4,
      outcome: 'defeat',
      weaponKills: {},
      matchDurationSec: 200,
      combatants,
    });

    expect(res.mvp?.id).toBe('bot1');
    expect(res.mvp?.isBot).toBe(true);
    expect(res.mvp?.badges).toEqual(
      expect.arrayContaining(['most_kills', 'most_headshots', 'grenadier', 'assassin']),
    );
    expect(res.mvp?.badges).toHaveLength(4);

    const playerRow = res.leaderboard.find((e) => e.id === 'p1');
    expect(playerRow?.badges).toContain('most_assists');
  });

  it('distinguishes AFK-Artist (> 50% AFK) from Coward (lowest active combat regardless of deaths)', () => {
    const combatants: CombatantMatchStats[] = [
      makeCombatant({
        id: 'top',
        name: 'ACE',
        kills: 14,
        deaths: 8,
        assists: 2,
        damageDealt: 1600,
        afkSeconds: 0,
      }),
      makeCombatant({
        id: 'camper',
        name: 'CAMPER',
        kills: 0,
        deaths: 0, // zero deaths should NOT save them from Coward because they did almost nothing
        assists: 0,
        damageDealt: 20,
        afkSeconds: 10,
      }),
      makeCombatant({
        id: 'idler',
        name: 'IDLER',
        kills: 0,
        deaths: 1,
        assists: 0,
        damageDealt: 0,
        afkSeconds: 130, // > 50% of 200s
      }),
    ];

    const res = computePostMatchSummary({
      mode: 'battle',
      kills: 14,
      headshots: 0,
      deaths: 8,
      outcome: 'victory',
      weaponKills: {},
      matchDurationSec: 200,
      combatants,
    });

    const camper = res.leaderboard.find((e) => e.id === 'camper');
    const idler = res.leaderboard.find((e) => e.id === 'idler');
    expect(camper?.badges).toContain('coward');
    expect(camper?.badges).not.toContain('afk_artist');
    expect(idler?.badges).toContain('afk_artist');
    expect(idler?.badges).not.toContain('coward');
  });

  it('builds guest and authenticated MatchProgressionSummary payloads consistently', () => {
    const input = {
      mode: 'battle' as const,
      kills: 8,
      headshots: 3,
      deaths: 2,
      outcome: 'victory' as const,
      weaponKills: { m4a1: 8 },
      mapName: 'Pripyat Block',
      matchDurationSec: 150,
      combatants: [
        makeCombatant({ id: 'p1', name: 'YOU', isLocalPlayer: true, kills: 8, deaths: 2, headshots: 3, damageDealt: 900 }),
        makeCombatant({ id: 'bot2', name: 'VIKING', isBot: true, team: 'B', kills: 4, deaths: 5, assists: 2, damageDealt: 500 }),
      ],
    };

    const guestSummary = buildGuestMatchSummary(input);
    expect(guestSummary.isGuest).toBe(true);
    expect(guestSummary.breakdown.netXp).toBe(0);
    expect(guestSummary.mvp?.id).toBe('p1');
    expect(guestSummary.leaderboard).toHaveLength(2);

    const starterCareer: CareerProgressionState = {
      rank: 1,
      xp: 0,
      prestige: 0,
      prestigeXp: 0,
      cash: 0,
      kills: 0,
      deaths: 0,
      wins: 0,
      losses: 0,
      matchesPlayed: 0,
      highestInfectionRound: 0,
    };
    const authResult = applyMatchProgression(starterCareer, {}, new Set<string>(), input);
    expect(authResult.summary.isGuest).toBe(false);
    expect(authResult.summary.breakdown.netXp).toBeGreaterThan(0);
    expect(authResult.summary.mvp?.id).toBe('p1');
    expect(authResult.summary.leaderboard).toHaveLength(2);
    expect(authResult.summary.mapName).toBe('Pripyat Block');
  });

  it('builds, resolves weapon names, sanitizes, and caps RecentMatchRecord history to 5 entries', () => {
    expect(resolveMatchWeaponName('m4a1')).toBe('Colt M4A1 SOPMOD Block II');
    expect(resolveMatchWeaponName('m67_frag')).toBe('M67 Frag Grenade');
    expect(resolveMatchWeaponName('tactical_knife')).toBe('Tactical Knife');

    const sanitizedInput = sanitizeMatchResultInput({
      mode: 'battle',
      battleRule: 'ffa',
      kills: 11,
      headshots: 20, // clamped to kills
      deaths: 0,
      outcome: 'victory',
      weaponKills: { m4a1: 7, makarov_pm: 3, m67_frag: 1, ignored_zero: 0 },
      mapId: 'pripyat_block',
      mapName: 'Pripyat Block',
      matchDurationSec: 215,
    });
    expect(sanitizedInput).not.toBeNull();
    expect(sanitizedInput?.headshots).toBe(11);
    expect(sanitizedInput?.weaponKills).toEqual({ m4a1: 7, makarov_pm: 3, m67_frag: 1 });

    const firstRecord = buildRecentMatchRecord(sanitizedInput!, {
      id: 'm1',
      completedAt: 1000,
      netXp: 1625,
      cashEarned: 535,
      isGuest: false,
    });

    expect(firstRecord.kdDisplay).toBe('∞');
    expect(firstRecord.durationSec).toBe(215);
    expect(firstRecord.netXp).toBe(1625);
    expect(firstRecord.weaponStats.map((w) => [w.weaponId, w.kills])).toEqual([
      ['m4a1', 7],
      ['makarov_pm', 3],
      ['m67_frag', 1],
    ]);

    const reSanitized = sanitizeRecentMatchRecord(JSON.parse(JSON.stringify(firstRecord)));
    expect(reSanitized).toEqual(firstRecord);

    let history = [firstRecord];
    for (let i = 2; i <= 7; i++) {
      const rec = buildRecentMatchRecord(
        {
          mode: 'infection',
          kills: i * 10,
          headshots: i * 2,
          deaths: 1,
          outcome: 'completed',
          infectionRound: i,
          weaponKills: { hk_mp5: i * 10 },
          mapId: 'kino_theater',
          mapName: 'Kino Theater',
          matchDurationSec: 300 + i,
        },
        {
          id: `m${i}`,
          completedAt: i * 1000,
          netXp: 500 + i * 50,
          cashEarned: 200,
          isGuest: false,
        },
      );
      history = appendRecentMatch(history, rec, MAX_RECENT_MATCHES);
    }

    expect(history).toHaveLength(MAX_RECENT_MATCHES);
    expect(history.map((h) => h.id)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3']);
  });

  it('compares the two most recent matches side-by-side and builds JSON export payloads', () => {
    const latest = buildRecentMatchRecord(
      {
        mode: 'battle',
        battleRule: 'tdm',
        kills: 14,
        headshots: 7,
        deaths: 2,
        outcome: 'victory',
        weaponKills: { m4a1: 10, hk_mp5: 4 },
        mapId: 'pripyat_block',
        mapName: 'Pripyat Block',
        matchDurationSec: 210,
      },
      {
        id: 'match-latest-01',
        completedAt: Date.UTC(2026, 10, 23, 14, 0, 0),
        netXp: 1775,
        cashEarned: 570,
        isGuest: false,
      },
    );

    const previous = buildRecentMatchRecord(
      {
        mode: 'battle',
        battleRule: 'tdm',
        kills: 8,
        headshots: 2,
        deaths: 4,
        outcome: 'defeat',
        weaponKills: { m4a1: 8 },
        mapId: 'timberline_compound',
        mapName: 'Timberline Valley',
        matchDurationSec: 185,
      },
      {
        id: 'match-prev-02',
        completedAt: Date.UTC(2026, 10, 23, 13, 30, 0),
        netXp: 540,
        cashEarned: 260,
        isGuest: false,
      },
    );

    const cmp = compareRecentMatches(latest, previous);
    expect(cmp.kills).toEqual({ deltaText: '+6', trend: 'better' });
    expect(cmp.deaths).toEqual({ deltaText: '-2', trend: 'better' });
    expect(cmp.kd).toEqual({ deltaText: '+5.00', trend: 'better' });
    expect(cmp.headshots.deltaText).toBe('+5');
    expect(cmp.headshots.latestPct).toBe(50);
    expect(cmp.headshots.previousPct).toBe(25);
    expect(cmp.duration.deltaText).toBe('+0:25');
    expect(cmp.xp).toEqual({ comparable: true, deltaText: '+1,235 XP', trend: 'better' });
    expect(cmp.topWeapon.statusText).toBe('Same (+2 kills)');

    // Deathless latest vs finite previous K/D produces +∞
    const deathless = buildRecentMatchRecord(
      {
        mode: 'battle',
        kills: 6,
        headshots: 1,
        deaths: 0,
        outcome: 'victory',
        weaponKills: { ak105: 6 },
        mapName: 'Korsakov Substation',
        matchDurationSec: 120,
      },
      { id: 'match-inf', completedAt: 5000, netXp: 900, cashEarned: 300, isGuest: false },
    );
    const infCmp = compareRecentMatches(deathless, previous);
    expect(infCmp.kd).toEqual({ deltaText: '+∞', trend: 'better' });

    const exported = buildMatchSummaryExportPayload(latest, '2026-11-23T22:00:00.000Z');
    expect(exported.schemaVersion).toBe(1);
    expect(exported.exportedAt).toBe('2026-11-23T22:00:00.000Z');
    expect(exported.match.id).toBe('match-latest-01');
    expect(exported.match.stats.headshotAccuracyPct).toBe(50);
    expect(exported.match.stats.kdDisplay).toBe('7.00');
    expect(exported.match.weaponStats).toHaveLength(2);

    const filename = formatMatchExportFilename(latest);
    expect(filename).toBe('axon-match-battle-pripyat-block-2026-11-23-matchlat.json');
  });
});



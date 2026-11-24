import { ATTACHMENTS, WEAPON_COMPAT_META } from './attachments';
import { SDK_WEAPON_PROFILES } from '../bodycam-sdk/weaponProfiles';
import { TACTICAL_EQUIPMENT_CATALOG } from './tacticalEquipment';
import { BattleRuleId, isValidBattleRule } from '../maps/types';

export const MAX_RANK = 100;
export const MAX_PRESTIGE = 10;
export const MAX_GUN_LEVEL = 20;

export interface RankTitleInfo {
  rank: number;
  title: string;
  shortTitle: string;
  tier: 'private' | 'enlisted' | 'nco' | 'officer' | 'command' | 'veteran';
  accentHex: string;
}

export interface CareerProgressionState {
  rank: number; // 1..100
  xp: number; // XP within current rank
  prestige: number; // 0..10 (unlocked after Rank 100)
  prestigeXp: number; // XP within current prestige tier
  cash: number;
  kills: number;
  deaths: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
  highestInfectionRound: number;
}

export interface WeaponProgressRecord {
  weaponId: string;
  xp: number;
  level: number;
  kills: number;
}

export type PostMatchBadgeId =
  | 'most_kills'
  | 'most_headshots'
  | 'most_assists'
  | 'grenadier'
  | 'assassin'
  | 'tag_collector'
  | 'tag_rescuer'
  | 'sector_commander'
  | 'flag_runner'
  | 'hill_anchor'
  | 'coward'
  | 'afk_artist';

export interface PostMatchBadgeMeta {
  id: PostMatchBadgeId;
  label: string;
  description: string;
}

export const POST_MATCH_BADGES: Readonly<Record<PostMatchBadgeId, PostMatchBadgeMeta>> = {
  most_kills: {
    id: 'most_kills',
    label: 'Most Kills',
    description: 'Highest total eliminations in the match',
  },
  most_headshots: {
    id: 'most_headshots',
    label: 'Most Headshots',
    description: 'Most precision headshot eliminations',
  },
  most_assists: {
    id: 'most_assists',
    label: 'Most Assists',
    description: 'Most kill assists across engagements',
  },
  grenadier: {
    id: 'grenadier',
    label: 'Grenadier',
    description: 'Most explosive & ordnance eliminations',
  },
  assassin: {
    id: 'assassin',
    label: 'Assassin',
    description: 'Most close-quarters melee eliminations',
  },
  tag_collector: {
    id: 'tag_collector',
    label: 'Tag Hunter',
    description: 'Most enemy dogtags secured in Kill Confirmed',
  },
  tag_rescuer: {
    id: 'tag_rescuer',
    label: 'Dogtag Rescuer',
    description: 'Most friendly or personal dogtags recovered',
  },
  sector_commander: {
    id: 'sector_commander',
    label: 'Sector Commander',
    description: 'Most Conquest POIs captured and held',
  },
  flag_runner: {
    id: 'flag_runner',
    label: 'Flag Runner',
    description: 'Most flags captured or returned in CTF',
  },
  hill_anchor: {
    id: 'hill_anchor',
    label: 'Hill Anchor',
    description: 'Longest uncontested hill control time in KOTH',
  },
  coward: {
    id: 'coward',
    label: 'Coward',
    description: 'Least combat contribution among active operators',
  },
  afk_artist: {
    id: 'afk_artist',
    label: 'AFK-Artist',
    description: 'Inactive for more than half of the match',
  },
};

export interface CombatantMatchStats {
  id: string;
  name: string;
  team: 'A' | 'B' | 'FFA';
  isLocalPlayer: boolean;
  isBot: boolean;
  kills: number;
  deaths: number;
  headshots: number;
  assists: number;
  grenadeKills: number;
  meleeKills: number;
  damageDealt: number;
  afkSeconds: number;
  /** Mode-specific objective telemetry (optional; defaults to 0) */
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  poiCaptures?: number;
  territoryPoints?: number;
  flagCaptures?: number;
  flagReturns?: number;
  hillControlSec?: number;
}

export interface MatchLeaderboardEntry extends CombatantMatchStats {
  rankPosition: number;
  /** Null represents infinite K/D (deaths === 0 with at least 1 kill). */
  kdRatio: number | null;
  kdDisplay: string;
  afkRatio: number;
  isMvp: boolean;
  badges: PostMatchBadgeId[];
}

export interface MatchMvpHighlight {
  id: string;
  name: string;
  team: 'A' | 'B' | 'FFA';
  isLocalPlayer: boolean;
  isBot: boolean;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  grenadeKills: number;
  meleeKills: number;
  damageDealt: number;
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  poiCaptures?: number;
  territoryPoints?: number;
  flagCaptures?: number;
  flagReturns?: number;
  hillControlSec?: number;
  kdRatio: number | null;
  kdDisplay: string;
  badges: PostMatchBadgeId[];
}

export interface MatchResultInput {
  mode: 'battle' | 'infection';
  battleRule?: BattleRuleId;
  kills: number;
  headshots: number;
  deaths: number;
  outcome: 'victory' | 'defeat' | 'completed';
  infectionRound?: number;
  weaponKills: Record<string, number>;
  mapId?: string;
  mapName?: string;
  matchDurationSec?: number;
  combatants?: CombatantMatchStats[];
  /** Local player objective telemetry */
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  poiCaptures?: number;
  territoryPoints?: number;
  flagCaptures?: number;
  flagReturns?: number;
  hillControlSec?: number;
  /** Team aggregate scoreboard telemetry */
  teamScoreA?: number;
  teamScoreB?: number;
  teamFriendlyDogtagsA?: number;
  teamFriendlyDogtagsB?: number;
}

export const MAX_RECENT_MATCHES = 5;

export interface RecentMatchWeaponStat {
  weaponId: string;
  weaponName: string;
  kills: number;
}

export interface RecentMatchRecord {
  id: string;
  completedAt: number;
  mode: 'battle' | 'infection';
  battleRule?: BattleRuleId;
  infectionRound?: number;
  mapId?: string;
  mapName: string;
  outcome: 'victory' | 'defeat' | 'completed';
  kills: number;
  deaths: number;
  headshots: number;
  kdDisplay: string;
  durationSec: number;
  netXp: number;
  cashEarned: number;
  isGuest: boolean;
  weaponStats: RecentMatchWeaponStat[];
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  poiCaptures?: number;
  territoryPoints?: number;
  flagCaptures?: number;
  flagReturns?: number;
  hillControlSec?: number;
  teamScoreA?: number;
  teamScoreB?: number;
}

export interface GunLevelDelta {
  weaponId: string;
  beforeLevel: number;
  afterLevel: number;
  beforeXp: number;
  afterXp: number;
  xpGained: number;
  nextLevelXp: number;
}

export interface MatchProgressionSummary {
  isGuest: boolean;
  mode: 'battle' | 'infection';
  battleRule?: BattleRuleId;
  mapName?: string;
  matchOutcome: 'victory' | 'defeat' | 'completed';
  matchDurationSec: number;
  mvp: MatchMvpHighlight | null;
  leaderboard: MatchLeaderboardEntry[];
  teamScoreA?: number;
  teamScoreB?: number;
  teamFriendlyDogtagsA?: number;
  teamFriendlyDogtagsB?: number;
  enemyDogtags?: number;
  friendlyDogtags?: number;
  selfDogtagsRecovered?: number;
  objectiveStats?: {
    enemyDogtags: number;
    friendlyDogtags: number;
    selfDogtagsRecovered: number;
    poiCaptures: number;
    territoryPoints: number;
    flagCaptures: number;
    flagReturns: number;
    hillControlSec: number;
  };
  before: {
    rank: number;
    xp: number;
    xpForNext: number;
    prestige: number;
    prestigeXp: number;
    prestigeXpForNext: number;
    title: string;
  };
  after: {
    rank: number;
    xp: number;
    xpForNext: number;
    prestige: number;
    prestigeXp: number;
    prestigeXpForNext: number;
    title: string;
  };
  breakdown: {
    killXp: number;
    headshotXp: number;
    deathPenaltyXp: number;
    matchOutcomeXp: number;
    roundBonusXp: number;
    enemyDogtagXp?: number;
    friendlyDogtagXp?: number;
    objectiveXp?: number;
    netXp: number;
    cashEarned: number;
  };
  rankedUp: boolean;
  prestigedUp: boolean;
  newlyUnlockedWeapons: string[];
  newlyUnlockedAttachments: string[];
  autoGrantedSniperScopes: Array<{ weaponId: string; attachmentId: string }>;
  gunDeltas: GunLevelDelta[];
}

/**
 * Starter firearms unlocked at Rank 1:
 * - 1st Pistol: Makarov PM
 * - 1st Revolver: Nagant M1895
 * - 2 Rifles (1 AK platform + 1 M4 platform): AK-105 / AKM 7.62 + Colt M4A1
 * - 1 Shotgun: Remington 870
 * - 1 SMG / PDW: HK MP5
 * - 1 Bolt-Action Rifle: Mosin-Nagant M91/30 (auto-unlocks its first scope!)
 * - 0 DMRs / Marksman Rifles unlocked at start.
 */
export const STARTER_WEAPON_IDS: ReadonlySet<string> = new Set([
  'makarov_pm',
  'pm_9x19',
  'nagant_m1895',
  'm4a1',
  'm4_556',
  'akm_762',
  'ak105',
  'remington_870',
  'mp133_12ga',
  'hk_mp5',
  'mosin_m91_30',
]);

/**
 * Bolt-Action sniper rifles automatically unlock their first compatible scope
 * when the rifle itself is unlocked. Explicitly excludes DMRs.
 */
export const BOLT_ACTION_AUTO_SCOPE: Readonly<Record<string, string>> = {
  mosin_m91_30: 'optic_pso1m2',
  colt_c19: 'optic_razor_1_6',
  remington_m24: 'optic_razor_1_6',
  sv_98: 'optic_nightforce_atacr',
  ai_awm: 'optic_nightforce_atacr',
  barrett_mrad: 'optic_nightforce_atacr',
};

/**
 * Performance-scaled Career Rank unlock curve (Ranks 1–100) for all 42 arsenal firearms
 * plus legacy survival weapon aliases. Better ballistic performance / armor penetration /
 * modularity unlocks at progressively higher ranks. Zero DMRs at Rank 1.
 */
export const WEAPON_UNLOCK_RANK: Readonly<Record<string, number>> = {
  // === RANK 1 STARTERS ===
  makarov_pm: 1,
  pm_9x19: 1,
  nagant_m1895: 1,
  m4a1: 1,
  m4_556: 1,
  akm_762: 1,
  ak105: 1,
  remington_870: 1,
  mp133_12ga: 1,
  hk_mp5: 1,
  mosin_m91_30: 1,

  // === EARLY PROGRESSION (RANKS 3–25) ===
  sw_model_10: 3,
  mp443_grach: 5,
  mossberg_590a1: 8,
  beretta_m9: 11,
  aks74u: 14,
  aks74u_545: 14,
  ak74u_545: 14,
  webley_mk6: 17,
  glock_17: 20,
  colt_c8: 23,
  colt_c19: 25,

  // === MID-TIER TACTICAL PROGRESSION (RANKS 28–55) ===
  sig_p226: 28,
  sig_sg552: 31,
  dragunov_svd: 34, // First DMR unlocked at Rank 34
  spas_12: 37,
  pl15: 40,
  fn_scar_l: 43,
  remington_m24: 46,
  jericho_941: 49,
  mk14_ebr: 52,
  colt_python: 55,

  // === HIGH-PERFORMANCE OPERATIVE TIER (RANKS 58–80) ===
  benelli_m4: 58,
  fn_p90: 61,
  sig_mcx: 64,
  kac_m110: 67,
  saiga_12: 70,
  sw_model_29: 73,
  sv_98: 76,
  colt_c20: 79,

  // === APEX / VETERAN TIER (RANKS 82–100) ===
  hk416: 82,
  chiappa_rhino: 85,
  fn_scar_h_pr: 88,
  ai_awm: 91,
  desert_eagle_xix: 93,
  hk_g28: 95,
  ks_23: 97,
  barrett_mrad: 100,
};

/**
 * Per-Gun Level attachment unlock curve (Gun Levels 2..20).
 * Basic lights, reflex dots, brakes, and grips unlock early; extended mags,
 * magnified optics, caliber conversions, and SUPPRESSORS unlock mid-to-late
 * (suppressors are NEVER the first unlock).
 * Once unlocked on ANY gun, an attachment is globally unlocked for all compatible guns.
 */
export const ATTACHMENT_UNLOCK_GUN_LEVEL: Readonly<Record<string, number>> = {
  // Early utility & basic optics (Lv. 2–5)
  tac_flashlight: 2,
  optic_rmr_micro: 3,
  optic_kobra_rd: 3,
  muzzle_comp_ak: 4,
  grip_angled_afg: 4,
  optic_t2_red_dot: 5,
  mag_pm_12: 5,

  // Rail Adapters & Starter Reflex (Lv. 1)
  rail_b13_dovetail: 1,
  rail_mp5_claw: 1,
  optic_rmr_type2: 1,

  // Mid-tier handling, lasers, holos & standard mags (Lv. 6–10)
  tac_laser_red: 6,
  optic_eotech_holo: 7,
  grip_vertical_rk: 7,
  canted_t2_red_dot: 8,
  canted_kobra_rd: 8,
  mag_ak_30: 8,
  optic_pso1_4x: 9,
  optic_pso1m2: 1,
  mag_saiga_10: 9,
  canted_eotech_holo: 10,
  mag_ar10_20: 10,

  // Mid-late tactical modules, magnified optics & SUPPRESSORS (Lv. 11–15)
  optic_pso4: 11,
  tac_peq_combo: 11,
  muzzle_nagant_bramit: 12,
  muzzle_9mm_suppressor: 12,
  optic_lpvo_1_6: 12,
  optic_razor_1_6: 1,
  mag_ak_45_bakelite: 13,
  muzzle_pbs4_545: 14,
  muzzle_salvo_12ga: 15,

  // Late mastery optics, drum/quad mags, heavy suppressors & caliber conversions (Lv. 16–20)
  mag_m4_60_quad: 16,
  conv_deagle_357: 16,
  optic_nightforce_atacr: 16,
  muzzle_338_suppressor: 17,
  conv_deagle_44: 18,
  conv_mrad_300nm: 19,
  conv_mrad_338nm: 20,
};

export function getWeaponUnlockRank(weaponId: string): number {
  return WEAPON_UNLOCK_RANK[weaponId] ?? 1;
}

export function isWeaponUnlockedAtRank(weaponId: string, rank: number): boolean {
  return rank >= getWeaponUnlockRank(weaponId);
}

export function getAttachmentRequiredGunLevel(attachmentId: string): number {
  return ATTACHMENT_UNLOCK_GUN_LEVEL[attachmentId] ?? 2;
}

export function getRankTitleInfo(rank: number): RankTitleInfo {
  const clamped = Math.max(1, Math.min(MAX_RANK, Math.floor(rank)));
  if (clamped <= 5) {
    return {
      rank: clamped,
      title: 'Private',
      shortTitle: 'PVT',
      tier: 'private',
      accentHex: '#94A3B8',
    };
  }
  if (clamped <= 15) {
    return {
      rank: clamped,
      title: 'Corporal',
      shortTitle: 'CPL',
      tier: 'enlisted',
      accentHex: '#CBD5E1',
    };
  }
  if (clamped <= 30) {
    return {
      rank: clamped,
      title: 'Sergeant',
      shortTitle: 'SGT',
      tier: 'nco',
      accentHex: '#38BDF8',
    };
  }
  if (clamped <= 45) {
    return {
      rank: clamped,
      title: 'Staff Sergeant',
      shortTitle: 'SSG',
      tier: 'nco',
      accentHex: '#22D3EE',
    };
  }
  if (clamped <= 60) {
    return {
      rank: clamped,
      title: 'Lieutenant',
      shortTitle: 'LT',
      tier: 'officer',
      accentHex: '#FBBF24',
    };
  }
  if (clamped <= 75) {
    return {
      rank: clamped,
      title: 'Captain',
      shortTitle: 'CPT',
      tier: 'officer',
      accentHex: '#F59E0B',
    };
  }
  if (clamped <= 89) {
    return {
      rank: clamped,
      title: 'Major',
      shortTitle: 'MAJ',
      tier: 'command',
      accentHex: '#FB923C',
    };
  }
  if (clamped <= 99) {
    return {
      rank: clamped,
      title: 'Commander',
      shortTitle: 'CMD',
      tier: 'command',
      accentHex: '#F87171',
    };
  }
  return {
    rank: 100,
    title: 'Veteran',
    shortTitle: 'VET',
    tier: 'veteran',
    accentHex: '#F59E0B',
  };
}

export function formatRankLabel(rank: number, prestige: number): string {
  const info = getRankTitleInfo(rank);
  if (rank >= MAX_RANK && prestige > 0) {
    return `${info.title} 100 · Prestige ${prestige}`;
  }
  return `${info.title} · Rank ${Math.max(1, Math.min(MAX_RANK, rank))}`;
}

/**
 * Escalating XP needed to advance from `rank` to `rank + 1`.
 */
export function xpRequiredForNextRank(rank: number): number {
  const r = Math.max(1, Math.min(MAX_RANK, Math.floor(rank)));
  return Math.round(450 + (r - 1) * 145 + Math.pow(r - 1, 1.48) * 18);
}

/**
 * Steeper XP curve for Prestige 1..10 once Veteran (Rank 100) is reached.
 */
export function xpRequiredForNextPrestige(currentPrestige: number): number {
  const p = Math.max(0, Math.min(MAX_PRESTIGE, Math.floor(currentPrestige)));
  return Math.round(14000 + p * 7500 + p * p * 2200);
}

/**
 * Escalating per-gun XP needed to advance from `level` to `level + 1`.
 */
export function xpRequiredForNextGunLevel(level: number): number {
  const lv = Math.max(1, Math.min(MAX_GUN_LEVEL, Math.floor(level)));
  return Math.round(140 + (lv - 1) * 90 + (lv - 1) * (lv - 1) * 20);
}

/**
 * Starter attachments granted automatically for Rank 1 starter bolt-action rifle (Mosin).
 */
export function getStarterUnlockedAttachments(): string[] {
  return [BOLT_ACTION_AUTO_SCOPE.mosin_m91_30];
}

/**
 * Lists compatible attachments unlocked specifically when `weaponId` reaches `gunLevel`.
 */
export function getCompatibleAttachmentsForWeapon(weaponId: string): string[] {
  const meta = WEAPON_COMPAT_META[weaponId];
  if (!meta) return [];
  const ids: string[] = [];
  for (const def of Object.values(ATTACHMENTS)) {
    if (def.excludedWeapons?.includes(weaponId)) continue;
    if (def.requiresSuppressorSupport && !meta.supportsSuppressor) continue;
    if (def.slot === 'canted' && meta.supportsCanted === false) continue;
    if (def.slot === 'foregrip' && meta.supportsForegrip === false) continue;
    if (def.slot === 'tactical' && meta.supportsLaser === false && def.enablesLaser) continue;

    const explicitMatch = def.compatibleWeapons.includes(weaponId);
    const railMatch = def.compatibleRails ? def.compatibleRails.includes(meta.railType) : false;
    const catMatch = def.compatibleCategories
      ? def.compatibleCategories.includes(meta.category)
      : true;

    if (explicitMatch || (railMatch && catMatch)) {
      ids.push(def.id);
    }
  }
  return ids;
}

export function getAutoScopesForUnlockedRank(rank: number): Array<{ weaponId: string; attachmentId: string }> {
  const grants: Array<{ weaponId: string; attachmentId: string }> = [];
  for (const [weaponId, scopeId] of Object.entries(BOLT_ACTION_AUTO_SCOPE)) {
    if (isWeaponUnlockedAtRank(weaponId, rank)) {
      grants.push({ weaponId, attachmentId: scopeId });
    }
  }
  return grants;
}

/**
 * Applies a completed match's results to a player's career state, per-gun XP map,
 * and global unlocked attachment set. Pure function shared between Worker, local server, and UI.
 */
export function applyMatchProgression(
  career: CareerProgressionState,
  weaponProgress: Record<string, WeaponProgressRecord>,
  existingAttachments: ReadonlySet<string>,
  input: MatchResultInput,
): {
  nextCareer: CareerProgressionState;
  nextWeaponProgress: Record<string, WeaponProgressRecord>;
  nextUnlockedAttachments: Set<string>;
  summary: MatchProgressionSummary;
} {
  const kills = Math.max(0, Math.floor(input.kills || 0));
  const headshots = Math.max(0, Math.min(kills, Math.floor(input.headshots || 0)));
  const deaths = Math.max(0, Math.floor(input.deaths || 0));
  const infectionRound = Math.max(0, Math.floor(input.infectionRound || 0));

  const enemyDogtags = Math.max(0, Math.floor(input.enemyDogtags || 0));
  const friendlyDogtags = Math.max(0, Math.floor(input.friendlyDogtags || 0));
  const selfDogtagsRecovered = Math.max(
    0,
    Math.min(friendlyDogtags, Math.floor(input.selfDogtagsRecovered || 0)),
  );
  const poiCaptures = Math.max(0, Math.floor(input.poiCaptures || 0));
  const territoryPoints = Math.max(0, Math.round(input.territoryPoints || 0));
  const flagCaptures = Math.max(0, Math.floor(input.flagCaptures || 0));
  const flagReturns = Math.max(0, Math.floor(input.flagReturns || 0));
  const hillControlSec = Math.max(0, Math.round(input.hillControlSec || 0));

  const killXp = kills * 100;
  const headshotXp = headshots * 25;
  const deathPenaltyXp = deaths * 40;
  const matchOutcomeXp =
    input.outcome === 'victory' ? 350 : input.outcome === 'defeat' ? -150 : 120;
  const roundBonusXp = input.mode === 'infection' ? infectionRound * 75 : 0;

  const enemyDogtagXp = enemyDogtags * 45;
  // Recovering your own dogtag in Kill Confirmed FFA grants a substantial +140 XP bonus (does NOT affect win rate);
  // securing a teammate's dogtag in KC TDM grants +65 XP (also separate from win score).
  const otherFriendlyTags = Math.max(0, friendlyDogtags - selfDogtagsRecovered);
  const friendlyDogtagXp =
    selfDogtagsRecovered * 140 + otherFriendlyTags * 65;
  const objectiveXp =
    poiCaptures * 90 +
    Math.round(territoryPoints * 0.45) +
    flagCaptures * 180 +
    flagReturns * 65 +
    Math.round(hillControlSec * 3.5);

  const netXp =
    killXp +
    headshotXp -
    deathPenaltyXp +
    matchOutcomeXp +
    roundBonusXp +
    enemyDogtagXp +
    friendlyDogtagXp +
    objectiveXp;
  const cashEarned = Math.max(
    0,
    kills * 25 +
      headshots * 10 +
      (input.outcome === 'victory' ? 150 : 40) +
      infectionRound * 30 +
      enemyDogtags * 15 +
      friendlyDogtags * 20 +
      poiCaptures * 30 +
      flagCaptures * 60 +
      flagReturns * 20 +
      Math.round(hillControlSec * 1),
  );

  const beforeRank = Math.max(1, Math.min(MAX_RANK, career.rank));
  const beforePrestige = Math.max(0, Math.min(MAX_PRESTIGE, career.prestige));
  const beforeXp = Math.max(0, career.xp);
  const beforePrestigeXp = Math.max(0, career.prestigeXp);

  let rank = beforeRank;
  let xp = beforeXp;
  let prestige = beforePrestige;
  let prestigeXp = beforePrestigeXp;

  if (rank < MAX_RANK) {
    xp = Math.max(0, xp + netXp);
    while (rank < MAX_RANK) {
      const needed = xpRequiredForNextRank(rank);
      if (xp >= needed) {
        xp -= needed;
        rank += 1;
      } else {
        break;
      }
    }
    // Overflow into Prestige XP once Veteran (Rank 100) is reached
    if (rank >= MAX_RANK && xp > 0) {
      prestigeXp += xp;
      xp = 0;
    }
  } else {
    prestigeXp = Math.max(0, prestigeXp + netXp);
  }

  // Advance Prestige 1..10 once Veteran 100 is reached
  if (rank >= MAX_RANK) {
    xp = 0;
    while (prestige < MAX_PRESTIGE) {
      const neededPrestige = xpRequiredForNextPrestige(prestige);
      if (prestigeXp >= neededPrestige) {
        prestigeXp -= neededPrestige;
        prestige += 1;
      } else {
        break;
      }
    }
    if (prestige >= MAX_PRESTIGE) {
      prestigeXp = Math.min(prestigeXp, xpRequiredForNextPrestige(MAX_PRESTIGE));
    }
  }

  // Determine newly unlocked weapons from rank increase
  const newlyUnlockedWeapons: string[] = [];
  const nextUnlockedAttachments = new Set<string>(existingAttachments);
  const autoGrantedSniperScopes: Array<{ weaponId: string; attachmentId: string }> = [];

  if (rank > beforeRank) {
    const seen = new Set<string>();
    for (const [weaponId, reqRank] of Object.entries(WEAPON_UNLOCK_RANK)) {
      if (
        weaponId === 'pm_9x19' ||
        weaponId === 'm4_556' ||
        weaponId === 'mp133_12ga' ||
        weaponId === 'aks74u_545' ||
        weaponId === 'ak74u_545'
      ) {
        continue;
      }
      if (reqRank > beforeRank && reqRank <= rank && !seen.has(weaponId)) {
        seen.add(weaponId);
        newlyUnlockedWeapons.push(weaponId);
        const autoScope = BOLT_ACTION_AUTO_SCOPE[weaponId];
        if (autoScope) {
          if (!nextUnlockedAttachments.has(autoScope)) {
            nextUnlockedAttachments.add(autoScope);
            autoGrantedSniperScopes.push({ weaponId, attachmentId: autoScope });
          }
        }
      }
    }
  }

  // Per-gun XP and global attachment unlocks
  const nextWeaponProgress: Record<string, WeaponProgressRecord> = {};
  for (const [wid, rec] of Object.entries(weaponProgress)) {
    nextWeaponProgress[wid] = { ...rec };
  }

  const gunDeltas: GunLevelDelta[] = [];
  const newlyUnlockedAttachments: string[] = [];

  for (const [rawWeaponId, rawKills] of Object.entries(input.weaponKills || {})) {
    const wKills = Math.max(0, Math.floor(rawKills || 0));
    if (wKills <= 0) continue;

    const prev = nextWeaponProgress[rawWeaponId] ?? {
      weaponId: rawWeaponId,
      xp: 0,
      level: 1,
      kills: 0,
    };

    const gunXpGain = wKills * 115;
    let gLevel = Math.max(1, Math.min(MAX_GUN_LEVEL, prev.level));
    let gXp = Math.max(0, prev.xp) + gunXpGain;

    while (gLevel < MAX_GUN_LEVEL) {
      const needed = xpRequiredForNextGunLevel(gLevel);
      if (gXp >= needed) {
        gXp -= needed;
        gLevel += 1;
      } else {
        break;
      }
    }

    nextWeaponProgress[rawWeaponId] = {
      weaponId: rawWeaponId,
      xp: gXp,
      level: gLevel,
      kills: prev.kills + wKills,
    };

    gunDeltas.push({
      weaponId: rawWeaponId,
      beforeLevel: prev.level,
      afterLevel: gLevel,
      beforeXp: prev.xp,
      afterXp: gXp,
      xpGained: gunXpGain,
      nextLevelXp: xpRequiredForNextGunLevel(gLevel),
    });

    // Unlock any compatible attachments whose required gun level has now been reached
    const compatIds = getCompatibleAttachmentsForWeapon(rawWeaponId);
    for (const attId of compatIds) {
      const reqLv = getAttachmentRequiredGunLevel(attId);
      if (gLevel >= reqLv && !nextUnlockedAttachments.has(attId)) {
        nextUnlockedAttachments.add(attId);
        newlyUnlockedAttachments.push(attId);
      }
    }
  }

  // Ensure auto-granted sniper scopes are included in newlyUnlockedAttachments summary
  for (const grant of autoGrantedSniperScopes) {
    if (!newlyUnlockedAttachments.includes(grant.attachmentId)) {
      newlyUnlockedAttachments.push(grant.attachmentId);
    }
  }

  const nextCareer: CareerProgressionState = {
    rank,
    xp,
    prestige,
    prestigeXp,
    cash: career.cash + cashEarned,
    kills: career.kills + kills,
    deaths: career.deaths + deaths,
    wins: career.wins + (input.outcome === 'victory' ? 1 : 0),
    losses: career.losses + (input.outcome === 'defeat' ? 1 : 0),
    matchesPlayed: career.matchesPlayed + 1,
    highestInfectionRound: Math.max(career.highestInfectionRound, infectionRound),
  };

  const postMatch = computePostMatchSummary(input);

  return {
    nextCareer,
    nextWeaponProgress,
    nextUnlockedAttachments,
    summary: {
      isGuest: false,
      mode: input.mode,
      battleRule: input.mode === 'battle' ? input.battleRule : undefined,
      mapName: input.mapName,
      matchOutcome: input.outcome,
      matchDurationSec: postMatch.matchDurationSec,
      mvp: postMatch.mvp,
      leaderboard: postMatch.leaderboard,
      teamScoreA: input.teamScoreA,
      teamScoreB: input.teamScoreB,
      teamFriendlyDogtagsA: input.teamFriendlyDogtagsA,
      teamFriendlyDogtagsB: input.teamFriendlyDogtagsB,
      enemyDogtags,
      friendlyDogtags,
      selfDogtagsRecovered,
      objectiveStats: {
        enemyDogtags,
        friendlyDogtags,
        selfDogtagsRecovered,
        poiCaptures,
        territoryPoints,
        flagCaptures,
        flagReturns,
        hillControlSec,
      },
      before: {
        rank: beforeRank,
        xp: beforeXp,
        xpForNext: xpRequiredForNextRank(beforeRank),
        prestige: beforePrestige,
        prestigeXp: beforePrestigeXp,
        prestigeXpForNext: xpRequiredForNextPrestige(beforePrestige),
        title: getRankTitleInfo(beforeRank).title,
      },
      after: {
        rank,
        xp,
        xpForNext: xpRequiredForNextRank(rank),
        prestige,
        prestigeXp,
        prestigeXpForNext: xpRequiredForNextPrestige(prestige),
        title: getRankTitleInfo(rank).title,
      },
      breakdown: {
        killXp,
        headshotXp,
        deathPenaltyXp,
        matchOutcomeXp,
        roundBonusXp,
        enemyDogtagXp,
        friendlyDogtagXp,
        objectiveXp,
        netXp,
        cashEarned,
      },
      rankedUp: rank > beforeRank,
      prestigedUp: prestige > beforePrestige,
      newlyUnlockedWeapons,
      newlyUnlockedAttachments,
      autoGrantedSniperScopes,
      gunDeltas,
    },
  };
}

function sanitizeCombatantStats(raw: CombatantMatchStats): CombatantMatchStats {
  const kills = Math.max(0, Math.floor(raw.kills || 0));
  const deaths = Math.max(0, Math.floor(raw.deaths || 0));
  const headshots = Math.max(0, Math.min(kills, Math.floor(raw.headshots || 0)));
  const assists = Math.max(0, Math.floor(raw.assists || 0));
  const grenadeKills = Math.max(0, Math.min(kills, Math.floor(raw.grenadeKills || 0)));
  const meleeKills = Math.max(0, Math.min(kills, Math.floor(raw.meleeKills || 0)));
  const damageDealt = Math.max(0, Math.round(raw.damageDealt || 0));
  const afkSeconds = Math.max(0, Number(raw.afkSeconds || 0));
  const enemyDogtags = Math.max(0, Math.floor(raw.enemyDogtags || 0));
  const friendlyDogtags = Math.max(0, Math.floor(raw.friendlyDogtags || 0));
  const selfDogtagsRecovered = Math.max(
    0,
    Math.min(friendlyDogtags, Math.floor(raw.selfDogtagsRecovered || 0)),
  );
  const poiCaptures = Math.max(0, Math.floor(raw.poiCaptures || 0));
  const territoryPoints = Math.max(0, Math.round(raw.territoryPoints || 0));
  const flagCaptures = Math.max(0, Math.floor(raw.flagCaptures || 0));
  const flagReturns = Math.max(0, Math.floor(raw.flagReturns || 0));
  const hillControlSec = Math.max(0, Math.round(raw.hillControlSec || 0));
  return {
    id: String(raw.id || 'unknown'),
    name: String(raw.name || 'OPERATOR'),
    team: raw.team === 'B' ? 'B' : raw.team === 'FFA' ? 'FFA' : 'A',
    isLocalPlayer: Boolean(raw.isLocalPlayer),
    isBot: Boolean(raw.isBot),
    kills,
    deaths,
    headshots,
    assists,
    grenadeKills,
    meleeKills,
    damageDealt,
    afkSeconds,
    enemyDogtags,
    friendlyDogtags,
    selfDogtagsRecovered,
    poiCaptures,
    territoryPoints,
    flagCaptures,
    flagReturns,
    hillControlSec,
  };
}

function computeKdSortValue(kills: number, deaths: number): number {
  if (deaths === 0) {
    return kills > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return kills / deaths;
}

function formatKdDisplay(kills: number, deaths: number): { kdRatio: number | null; kdDisplay: string } {
  if (deaths === 0) {
    if (kills > 0) {
      return { kdRatio: null, kdDisplay: '∞' };
    }
    return { kdRatio: 0, kdDisplay: '0.00' };
  }
  const ratio = kills / deaths;
  return { kdRatio: Number(ratio.toFixed(2)), kdDisplay: ratio.toFixed(2) };
}

/**
 * Computes Match MVP (highest K/D ratio, treating 0 deaths with >=1 kill as infinite K/D
 * and tie-breaking by kills, assists, headshots, damageDealt), full sorted leaderboard,
 * and multi-award strength badges across all human and AI combatants.
 */
export function computePostMatchSummary(input: MatchResultInput): {
  matchDurationSec: number;
  mvp: MatchMvpHighlight | null;
  leaderboard: MatchLeaderboardEntry[];
} {
  const matchDurationSec = Math.max(1, Math.round(input.matchDurationSec ?? 0));
  const rawList: CombatantMatchStats[] =
    Array.isArray(input.combatants) && input.combatants.length > 0
      ? input.combatants.map(sanitizeCombatantStats)
      : [
          sanitizeCombatantStats({
            id: 'player',
            name: 'YOU',
            team: 'A',
            isLocalPlayer: true,
            isBot: false,
            kills: input.kills,
            deaths: input.deaths,
            headshots: input.headshots,
            assists: 0,
            grenadeKills: 0,
            meleeKills: 0,
            damageDealt: 0,
            afkSeconds: 0,
          }),
        ];

  if (rawList.length === 0) {
    return { matchDurationSec, mvp: null, leaderboard: [] };
  }

  // 1. Determine Match MVP by highest K/D ratio (0 deaths + >0 kills = Infinity, tie-break by kills)
  let mvpCandidate = rawList[0];
  for (let i = 1; i < rawList.length; i++) {
    const c = rawList[i];
    const cKd = computeKdSortValue(c.kills, c.deaths);
    const mKd = computeKdSortValue(mvpCandidate.kills, mvpCandidate.deaths);
    if (cKd !== mKd) {
      if (cKd > mKd) mvpCandidate = c;
      continue;
    }
    if (c.kills !== mvpCandidate.kills) {
      if (c.kills > mvpCandidate.kills) mvpCandidate = c;
      continue;
    }
    if (c.assists !== mvpCandidate.assists) {
      if (c.assists > mvpCandidate.assists) mvpCandidate = c;
      continue;
    }
    if (c.headshots !== mvpCandidate.headshots) {
      if (c.headshots > mvpCandidate.headshots) mvpCandidate = c;
      continue;
    }
    if (c.damageDealt !== mvpCandidate.damageDealt) {
      if (c.damageDealt > mvpCandidate.damageDealt) mvpCandidate = c;
      continue;
    }
    if (c.deaths !== mvpCandidate.deaths) {
      if (c.deaths < mvpCandidate.deaths) mvpCandidate = c;
      continue;
    }
    if (c.isLocalPlayer && !mvpCandidate.isLocalPlayer) {
      mvpCandidate = c;
    }
  }

  // 2. Compute category maxima for positive strength badges
  let maxKills = 0;
  let maxHeadshots = 0;
  let maxAssists = 0;
  let maxGrenadeKills = 0;
  let maxMeleeKills = 0;
  let maxEnemyTags = 0;
  let maxFriendlyTags = 0;
  let maxPoiCaptures = 0;
  let maxFlagActions = 0;
  let maxHillSec = 0;
  for (const c of rawList) {
    if (c.kills > maxKills) maxKills = c.kills;
    if (c.headshots > maxHeadshots) maxHeadshots = c.headshots;
    if (c.assists > maxAssists) maxAssists = c.assists;
    if (c.grenadeKills > maxGrenadeKills) maxGrenadeKills = c.grenadeKills;
    if (c.meleeKills > maxMeleeKills) maxMeleeKills = c.meleeKills;
    if ((c.enemyDogtags ?? 0) > maxEnemyTags) maxEnemyTags = c.enemyDogtags ?? 0;
    if ((c.friendlyDogtags ?? 0) > maxFriendlyTags) maxFriendlyTags = c.friendlyDogtags ?? 0;
    if ((c.poiCaptures ?? 0) > maxPoiCaptures) maxPoiCaptures = c.poiCaptures ?? 0;
    const flagActs = (c.flagCaptures ?? 0) * 3 + (c.flagReturns ?? 0);
    if (flagActs > maxFlagActions) maxFlagActions = flagActs;
    if ((c.hillControlSec ?? 0) > maxHillSec) maxHillSec = c.hillControlSec ?? 0;
  }

  // 3. Identify AFK-Artist (> 50% match duration AFK) and Coward (lowest active combat contribution, NOT AFK)
  const afkArtistIds = new Set<string>();
  const activeForCowardCheck: Array<{ id: string; score: number }> = [];
  let topCombatScore = 0;

  for (const c of rawList) {
    const afkRatio = matchDurationSec > 0 ? Math.min(1, c.afkSeconds / matchDurationSec) : 0;
    const combatScore =
      c.kills * 100 +
      c.assists * 45 +
      c.damageDealt * 0.5 +
      (c.enemyDogtags ?? 0) * 50 +
      (c.poiCaptures ?? 0) * 80 +
      (c.flagCaptures ?? 0) * 160 +
      (c.hillControlSec ?? 0) * 4;
    if (combatScore > topCombatScore) topCombatScore = combatScore;
    if (afkRatio > 0.5) {
      afkArtistIds.add(c.id);
    } else {
      activeForCowardCheck.push({ id: c.id, score: combatScore });
    }
  }

  const cowardIds = new Set<string>();
  if (rawList.length >= 2 && activeForCowardCheck.length >= 2 && topCombatScore > 0) {
    let minScore = Number.POSITIVE_INFINITY;
    for (const entry of activeForCowardCheck) {
      if (entry.id === mvpCandidate.id) continue;
      if (entry.score < minScore) {
        minScore = entry.score;
      }
    }
    if (Number.isFinite(minScore) && minScore < topCombatScore) {
      for (const entry of activeForCowardCheck) {
        if (entry.id !== mvpCandidate.id && entry.score === minScore) {
          cowardIds.add(entry.id);
        }
      }
    }
  }

  // 4. Sort full leaderboard by primary mode objective (Friendly Dogtags NEVER affect rank/win!)
  const rule = input.battleRule;
  const primaryObjectiveScore = (c: CombatantMatchStats): number => {
    if (rule === 'kc_tdm' || rule === 'kc_ffa') {
      return c.enemyDogtags ?? 0;
    }
    if (rule === 'conquest') {
      return (c.poiCaptures ?? 0) * 120 + (c.territoryPoints ?? 0);
    }
    if (rule === 'ctf') {
      return (c.flagCaptures ?? 0) * 150 + (c.flagReturns ?? 0) * 40;
    }
    if (rule === 'koth') {
      return c.hillControlSec ?? 0;
    }
    return c.kills;
  };

  const sorted = [...rawList].sort((a, b) => {
    const objDiff = primaryObjectiveScore(b) - primaryObjectiveScore(a);
    if (objDiff !== 0) return objDiff;
    if (b.kills !== a.kills) return b.kills - a.kills;
    if (b.assists !== a.assists) return b.assists - a.assists;
    if (a.deaths !== b.deaths) return a.deaths - b.deaths;
    if (b.headshots !== a.headshots) return b.headshots - a.headshots;
    if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;
    if (a.isLocalPlayer !== b.isLocalPlayer) return a.isLocalPlayer ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const leaderboard: MatchLeaderboardEntry[] = sorted.map((c, idx) => {
    const badges: PostMatchBadgeId[] = [];
    if (maxKills > 0 && c.kills === maxKills) badges.push('most_kills');
    if (maxHeadshots > 0 && c.headshots === maxHeadshots) badges.push('most_headshots');
    if (maxAssists > 0 && c.assists === maxAssists) badges.push('most_assists');
    if (maxGrenadeKills > 0 && c.grenadeKills === maxGrenadeKills) badges.push('grenadier');
    if (maxMeleeKills > 0 && c.meleeKills === maxMeleeKills) badges.push('assassin');
    if (maxEnemyTags > 0 && (c.enemyDogtags ?? 0) === maxEnemyTags) badges.push('tag_collector');
    if (maxFriendlyTags > 0 && (c.friendlyDogtags ?? 0) === maxFriendlyTags) badges.push('tag_rescuer');
    if (maxPoiCaptures > 0 && (c.poiCaptures ?? 0) === maxPoiCaptures) badges.push('sector_commander');
    const flagActs = (c.flagCaptures ?? 0) * 3 + (c.flagReturns ?? 0);
    if (maxFlagActions > 0 && flagActs === maxFlagActions) badges.push('flag_runner');
    if (maxHillSec > 0 && (c.hillControlSec ?? 0) === maxHillSec) badges.push('hill_anchor');
    if (cowardIds.has(c.id)) badges.push('coward');
    if (afkArtistIds.has(c.id)) badges.push('afk_artist');

    const { kdRatio, kdDisplay } = formatKdDisplay(c.kills, c.deaths);
    const afkRatio = matchDurationSec > 0 ? Math.min(1, c.afkSeconds / matchDurationSec) : 0;

    return {
      ...c,
      rankPosition: idx + 1,
      kdRatio,
      kdDisplay,
      afkRatio,
      isMvp: c.id === mvpCandidate.id,
      badges,
    };
  });

  const mvpRow = leaderboard.find((r) => r.isMvp) ?? leaderboard[0];
  const mvp: MatchMvpHighlight = {
    id: mvpRow.id,
    name: mvpRow.name,
    team: mvpRow.team,
    isLocalPlayer: mvpRow.isLocalPlayer,
    isBot: mvpRow.isBot,
    kills: mvpRow.kills,
    deaths: mvpRow.deaths,
    assists: mvpRow.assists,
    headshots: mvpRow.headshots,
    grenadeKills: mvpRow.grenadeKills,
    meleeKills: mvpRow.meleeKills,
    damageDealt: mvpRow.damageDealt,
    enemyDogtags: mvpRow.enemyDogtags,
    friendlyDogtags: mvpRow.friendlyDogtags,
    selfDogtagsRecovered: mvpRow.selfDogtagsRecovered,
    poiCaptures: mvpRow.poiCaptures,
    territoryPoints: mvpRow.territoryPoints,
    flagCaptures: mvpRow.flagCaptures,
    flagReturns: mvpRow.flagReturns,
    hillControlSec: mvpRow.hillControlSec,
    kdRatio: mvpRow.kdRatio,
    kdDisplay: mvpRow.kdDisplay,
    badges: [...mvpRow.badges],
  };

  return {
    matchDurationSec,
    mvp,
    leaderboard,
  };
}

/**
 * Builds a complete post-match summary for unauthenticated guest sessions so every player
 * sees the Match MVP, full leaderboard, and strength badges without career XP persistence.
 */
export function buildGuestMatchSummary(input: MatchResultInput): MatchProgressionSummary {
  const postMatch = computePostMatchSummary(input);
  const baseTitle = getRankTitleInfo(1).title;
  const xpForNext = xpRequiredForNextRank(1);
  const prestigeXpForNext = xpRequiredForNextPrestige(0);

  return {
    isGuest: true,
    mode: input.mode,
    battleRule: input.mode === 'battle' ? input.battleRule : undefined,
    mapName: input.mapName,
    matchOutcome: input.outcome,
    matchDurationSec: postMatch.matchDurationSec,
    mvp: postMatch.mvp,
    leaderboard: postMatch.leaderboard,
    teamScoreA: input.teamScoreA,
    teamScoreB: input.teamScoreB,
    teamFriendlyDogtagsA: input.teamFriendlyDogtagsA,
    teamFriendlyDogtagsB: input.teamFriendlyDogtagsB,
    enemyDogtags: Math.max(0, Math.floor(input.enemyDogtags || 0)),
    friendlyDogtags: Math.max(0, Math.floor(input.friendlyDogtags || 0)),
    selfDogtagsRecovered: Math.max(0, Math.floor(input.selfDogtagsRecovered || 0)),
    objectiveStats: {
      enemyDogtags: Math.max(0, Math.floor(input.enemyDogtags || 0)),
      friendlyDogtags: Math.max(0, Math.floor(input.friendlyDogtags || 0)),
      selfDogtagsRecovered: Math.max(0, Math.floor(input.selfDogtagsRecovered || 0)),
      poiCaptures: Math.max(0, Math.floor(input.poiCaptures || 0)),
      territoryPoints: Math.max(0, Math.round(input.territoryPoints || 0)),
      flagCaptures: Math.max(0, Math.floor(input.flagCaptures || 0)),
      flagReturns: Math.max(0, Math.floor(input.flagReturns || 0)),
      hillControlSec: Math.max(0, Math.round(input.hillControlSec || 0)),
    },
    before: {
      rank: 1,
      xp: 0,
      xpForNext,
      prestige: 0,
      prestigeXp: 0,
      prestigeXpForNext,
      title: baseTitle,
    },
    after: {
      rank: 1,
      xp: 0,
      xpForNext,
      prestige: 0,
      prestigeXp: 0,
      prestigeXpForNext,
      title: baseTitle,
    },
    breakdown: {
      killXp: 0,
      headshotXp: 0,
      deathPenaltyXp: 0,
      matchOutcomeXp: 0,
      roundBonusXp: 0,
      enemyDogtagXp: 0,
      friendlyDogtagXp: 0,
      objectiveXp: 0,
      netXp: 0,
      cashEarned: 0,
    },
    rankedUp: false,
    prestigedUp: false,
    newlyUnlockedWeapons: [],
    newlyUnlockedAttachments: [],
    autoGrantedSniperScopes: [],
    gunDeltas: [],
  };
}

const SPECIAL_MATCH_WEAPON_NAMES: Readonly<Record<string, string>> = {
  tactical_knife: 'Tactical Knife',
  crowbar: 'Crowbar',
  rgd5_frag: 'RGD-5 Frag',
  grenade: 'Frag Grenade',
  melee: 'Melee Takedown',
};

const MATCH_MAP_FALLBACK_NAMES: Readonly<Record<string, string>> = {
  pripyat_block: 'Pripyat Block',
  timberline_compound: 'Timberline Valley',
  korsakov_substation: 'Korsakov Substation',
  volga_corridor: 'Volga Frontier Corridor',
  kino_theater: 'Kino Theater',
  stalingrad_depot: 'Stalingrad Rail Depot',
  objekt_47: 'Bunker Objekt-47',
};

export function resolveMatchWeaponName(weaponId: string): string {
  const id = String(weaponId ?? '').trim();
  if (!id) return 'Unknown Weapon';

  const profile = SDK_WEAPON_PROFILES[id];
  if (profile?.name && profile.id !== 'unarmed') {
    return profile.name;
  }

  if (Object.prototype.hasOwnProperty.call(TACTICAL_EQUIPMENT_CATALOG, id)) {
    return TACTICAL_EQUIPMENT_CATALOG[id as keyof typeof TACTICAL_EQUIPMENT_CATALOG].name;
  }

  const special = SPECIAL_MATCH_WEAPON_NAMES[id];
  if (special) return special;

  return id
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function generateRecentMatchId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `match_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sanitizeMatchResultInput(raw: unknown): MatchResultInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== 'battle' && obj.mode !== 'infection') return null;

  const kills = Math.max(0, Math.min(10000, Math.floor(Number(obj.kills) || 0)));
  const deaths = Math.max(0, Math.min(10000, Math.floor(Number(obj.deaths) || 0)));
  const headshots = Math.max(0, Math.min(kills, Math.floor(Number(obj.headshots) || 0)));
  const outcome: 'victory' | 'defeat' | 'completed' =
    obj.outcome === 'victory' || obj.outcome === 'defeat' || obj.outcome === 'completed'
      ? obj.outcome
      : obj.mode === 'infection'
        ? 'completed'
        : 'defeat';

  const battleRule: BattleRuleId | undefined =
    obj.mode === 'battle' && isValidBattleRule(obj.battleRule)
      ? obj.battleRule
      : undefined;

  const infectionRound =
    obj.mode === 'infection' && obj.infectionRound !== undefined
      ? Math.max(1, Math.min(1000, Math.floor(Number(obj.infectionRound) || 1)))
      : undefined;

  const mapId =
    typeof obj.mapId === 'string' && obj.mapId.trim()
      ? obj.mapId.trim().slice(0, 64)
      : undefined;
  const mapName =
    typeof obj.mapName === 'string' && obj.mapName.trim()
      ? obj.mapName.trim().slice(0, 80)
      : undefined;

  const matchDurationSec =
    obj.matchDurationSec !== undefined
      ? Math.max(1, Math.min(86400, Math.round(Number(obj.matchDurationSec) || 1)))
      : undefined;

  const weaponKills: Record<string, number> = {};
  if (obj.weaponKills && typeof obj.weaponKills === 'object') {
    let count = 0;
    for (const [k, v] of Object.entries(obj.weaponKills as Record<string, unknown>)) {
      if (count >= 48) break;
      const wid = String(k).trim().slice(0, 64);
      const wKills = Math.max(0, Math.min(10000, Math.floor(Number(v) || 0)));
      if (wid && wKills > 0) {
        weaponKills[wid] = wKills;
        count += 1;
      }
    }
  }

  const combatants = Array.isArray(obj.combatants)
    ? obj.combatants
        .slice(0, 32)
        .filter((c): c is CombatantMatchStats => Boolean(c && typeof c === 'object'))
        .map(sanitizeCombatantStats)
    : undefined;

  const optInt = (val: unknown, max = 100000): number | undefined =>
    val !== undefined && Number.isFinite(Number(val))
      ? Math.max(0, Math.min(max, Math.round(Number(val))))
      : undefined;

  return {
    mode: obj.mode,
    battleRule,
    kills,
    headshots,
    deaths,
    outcome,
    infectionRound,
    weaponKills,
    mapId,
    mapName,
    matchDurationSec,
    combatants,
    enemyDogtags: optInt(obj.enemyDogtags),
    friendlyDogtags: optInt(obj.friendlyDogtags),
    selfDogtagsRecovered: optInt(obj.selfDogtagsRecovered),
    poiCaptures: optInt(obj.poiCaptures),
    territoryPoints: optInt(obj.territoryPoints),
    flagCaptures: optInt(obj.flagCaptures),
    flagReturns: optInt(obj.flagReturns),
    hillControlSec: optInt(obj.hillControlSec),
    teamScoreA: optInt(obj.teamScoreA),
    teamScoreB: optInt(obj.teamScoreB),
    teamFriendlyDogtagsA: optInt(obj.teamFriendlyDogtagsA),
    teamFriendlyDogtagsB: optInt(obj.teamFriendlyDogtagsB),
  };
}

export function buildRecentMatchRecord(
  input: MatchResultInput,
  opts: {
    id?: string;
    completedAt?: number;
    netXp: number;
    cashEarned: number;
    isGuest: boolean;
  },
): RecentMatchRecord {
  const kills = Math.max(0, Math.floor(input.kills || 0));
  const deaths = Math.max(0, Math.floor(input.deaths || 0));
  const headshots = Math.max(0, Math.min(kills, Math.floor(input.headshots || 0)));
  const durationSec = Math.max(1, Math.round(input.matchDurationSec ?? 0));
  const { kdDisplay } = formatKdDisplay(kills, deaths);

  const weaponStats: RecentMatchWeaponStat[] = Object.entries(input.weaponKills || {})
    .map(([rawId, rawKills]) => {
      const weaponId = String(rawId).trim();
      const wKills = Math.max(0, Math.floor(rawKills || 0));
      return {
        weaponId,
        weaponName: resolveMatchWeaponName(weaponId),
        kills: wKills,
      };
    })
    .filter((w) => w.weaponId.length > 0 && w.kills > 0)
    .sort((a, b) => b.kills - a.kills || a.weaponName.localeCompare(b.weaponName));

  const mapId = input.mapId?.trim() || undefined;
  const fallbackMap =
    (mapId ? MATCH_MAP_FALLBACK_NAMES[mapId] : undefined) ??
    (input.mode === 'infection' ? 'Kino Theater' : 'Combat Sector');

  return {
    id: opts.id?.trim() || generateRecentMatchId(),
    completedAt: typeof opts.completedAt === 'number' && Number.isFinite(opts.completedAt)
      ? Math.round(opts.completedAt)
      : Date.now(),
    mode: input.mode,
    battleRule: input.mode === 'battle' ? input.battleRule : undefined,
    infectionRound:
      input.mode === 'infection' && typeof input.infectionRound === 'number'
        ? Math.max(1, Math.floor(input.infectionRound))
        : undefined,
    mapId,
    mapName: input.mapName?.trim() || fallbackMap,
    outcome: input.outcome,
    kills,
    deaths,
    headshots,
    kdDisplay,
    durationSec,
    netXp: Math.round(opts.netXp || 0),
    cashEarned: Math.max(0, Math.round(opts.cashEarned || 0)),
    isGuest: Boolean(opts.isGuest),
    weaponStats,
    enemyDogtags: input.enemyDogtags,
    friendlyDogtags: input.friendlyDogtags,
    selfDogtagsRecovered: input.selfDogtagsRecovered,
    poiCaptures: input.poiCaptures,
    territoryPoints: input.territoryPoints,
    flagCaptures: input.flagCaptures,
    flagReturns: input.flagReturns,
    hillControlSec: input.hillControlSec,
    teamScoreA: input.teamScoreA,
    teamScoreB: input.teamScoreB,
  };
}

export function sanitizeRecentMatchRecord(raw: unknown): RecentMatchRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.mode !== 'battle' && obj.mode !== 'infection') return null;

  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim().slice(0, 100) : generateRecentMatchId();
  const completedAt =
    typeof obj.completedAt === 'number' && Number.isFinite(obj.completedAt) && obj.completedAt > 0
      ? Math.round(obj.completedAt)
      : Date.now();
  const kills = Math.max(0, Math.floor(Number(obj.kills) || 0));
  const deaths = Math.max(0, Math.floor(Number(obj.deaths) || 0));
  const headshots = Math.max(0, Math.min(kills, Math.floor(Number(obj.headshots) || 0)));
  const durationSec = Math.max(1, Math.round(Number(obj.durationSec) || 1));
  const outcome: 'victory' | 'defeat' | 'completed' =
    obj.outcome === 'victory' || obj.outcome === 'defeat' || obj.outcome === 'completed'
      ? obj.outcome
      : obj.mode === 'infection'
        ? 'completed'
        : 'defeat';

  const weaponStats: RecentMatchWeaponStat[] = Array.isArray(obj.weaponStats)
    ? obj.weaponStats
        .slice(0, 48)
        .filter((w): w is Record<string, unknown> => Boolean(w && typeof w === 'object'))
        .map((w) => {
          const weaponId = String(w.weaponId ?? '').trim().slice(0, 64);
          const wKills = Math.max(0, Math.floor(Number(w.kills) || 0));
          const weaponName =
            typeof w.weaponName === 'string' && w.weaponName.trim()
              ? w.weaponName.trim().slice(0, 80)
              : resolveMatchWeaponName(weaponId);
          return { weaponId, weaponName, kills: wKills };
        })
        .filter((w) => w.weaponId.length > 0 && w.kills > 0)
        .sort((a, b) => b.kills - a.kills || a.weaponName.localeCompare(b.weaponName))
    : [];

  const mapId =
    typeof obj.mapId === 'string' && obj.mapId.trim()
      ? obj.mapId.trim().slice(0, 64)
      : undefined;
  const mapName =
    typeof obj.mapName === 'string' && obj.mapName.trim()
      ? obj.mapName.trim().slice(0, 80)
      : (mapId ? MATCH_MAP_FALLBACK_NAMES[mapId] : undefined) ??
        (obj.mode === 'infection' ? 'Kino Theater' : 'Combat Sector');

  const { kdDisplay } = formatKdDisplay(kills, deaths);
  const optInt = (v: unknown): number | undefined =>
    v !== undefined && Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : undefined;

  return {
    id,
    completedAt,
    mode: obj.mode,
    battleRule:
      obj.mode === 'battle' && isValidBattleRule(obj.battleRule)
        ? obj.battleRule
        : undefined,
    infectionRound:
      obj.mode === 'infection' && typeof obj.infectionRound === 'number' && obj.infectionRound > 0
        ? Math.floor(obj.infectionRound)
        : undefined,
    mapId,
    mapName,
    outcome,
    kills,
    deaths,
    headshots,
    kdDisplay,
    durationSec,
    netXp: Math.round(Number(obj.netXp) || 0),
    cashEarned: Math.max(0, Math.round(Number(obj.cashEarned) || 0)),
    isGuest: Boolean(obj.isGuest),
    weaponStats,
    enemyDogtags: optInt(obj.enemyDogtags),
    friendlyDogtags: optInt(obj.friendlyDogtags),
    selfDogtagsRecovered: optInt(obj.selfDogtagsRecovered),
    poiCaptures: optInt(obj.poiCaptures),
    territoryPoints: optInt(obj.territoryPoints),
    flagCaptures: optInt(obj.flagCaptures),
    flagReturns: optInt(obj.flagReturns),
    hillControlSec: optInt(obj.hillControlSec),
    teamScoreA: optInt(obj.teamScoreA),
    teamScoreB: optInt(obj.teamScoreB),
  };
}

export function appendRecentMatch(
  existing: readonly RecentMatchRecord[],
  next: RecentMatchRecord,
  limit = MAX_RECENT_MATCHES,
): RecentMatchRecord[] {
  const cap = Math.max(1, Math.floor(limit));
  const deduped = [next, ...existing.filter((m) => m.id !== next.id)];
  return deduped.sort((a, b) => b.completedAt - a.completedAt).slice(0, cap);
}

export type ComparisonTrend = 'better' | 'worse' | 'equal' | 'neutral';

export interface RecentMatchMetricDelta {
  deltaText: string;
  trend: ComparisonTrend;
}

export interface RecentMatchComparison {
  latest: RecentMatchRecord;
  previous: RecentMatchRecord;
  kills: RecentMatchMetricDelta;
  deaths: RecentMatchMetricDelta;
  kd: RecentMatchMetricDelta;
  headshots: RecentMatchMetricDelta & {
    latestPct: number;
    previousPct: number;
  };
  duration: RecentMatchMetricDelta;
  xp: RecentMatchMetricDelta & { comparable: boolean };
  topWeapon: {
    latestLabel: string;
    previousLabel: string;
    statusText: string;
  };
}

function formatSignedDelta(value: number, suffix = ''): string {
  if (value > 0) return `+${value.toLocaleString()}${suffix}`;
  if (value < 0) return `${value.toLocaleString()}${suffix}`;
  return `0${suffix}`;
}

function formatDurationDelta(deltaSec: number): string {
  const sign = deltaSec > 0 ? '+' : deltaSec < 0 ? '-' : '';
  const abs = Math.abs(Math.round(deltaSec));
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
}

export function compareRecentMatches(
  latest: RecentMatchRecord,
  previous: RecentMatchRecord,
): RecentMatchComparison {
  const killsDiff = latest.kills - previous.kills;
  const deathsDiff = latest.deaths - previous.deaths;
  const hsDiff = latest.headshots - previous.headshots;
  const durationDiff = latest.durationSec - previous.durationSec;

  const latestKdVal = computeKdSortValue(latest.kills, latest.deaths);
  const previousKdVal = computeKdSortValue(previous.kills, previous.deaths);
  let kdDeltaText = '0.00';
  let kdTrend: ComparisonTrend = 'equal';

  if (latestKdVal === previousKdVal) {
    kdDeltaText = '0.00';
    kdTrend = 'equal';
  } else if (!Number.isFinite(latestKdVal) && Number.isFinite(previousKdVal)) {
    kdDeltaText = '+∞';
    kdTrend = 'better';
  } else if (Number.isFinite(latestKdVal) && !Number.isFinite(previousKdVal)) {
    kdDeltaText = '-∞';
    kdTrend = 'worse';
  } else {
    const kdDiff = latestKdVal - previousKdVal;
    kdDeltaText = kdDiff > 0 ? `+${kdDiff.toFixed(2)}` : kdDiff.toFixed(2);
    kdTrend = kdDiff > 0 ? 'better' : kdDiff < 0 ? 'worse' : 'equal';
  }

  const latestPct = latest.kills > 0 ? Math.round((latest.headshots / latest.kills) * 100) : 0;
  const previousPct = previous.kills > 0 ? Math.round((previous.headshots / previous.kills) * 100) : 0;

  const xpComparable = !latest.isGuest && !previous.isGuest;
  const xpDiff = latest.netXp - previous.netXp;

  const latestTop = latest.weaponStats[0] ?? null;
  const previousTop = previous.weaponStats[0] ?? null;
  const latestLabel = latestTop ? `${latestTop.weaponName} (×${latestTop.kills})` : 'None';
  const previousLabel = previousTop ? `${previousTop.weaponName} (×${previousTop.kills})` : 'None';
  let statusText = '—';
  if (latestTop && previousTop) {
    if (latestTop.weaponId === previousTop.weaponId) {
      statusText = `Same (${formatSignedDelta(latestTop.kills - previousTop.kills)} kills)`;
    } else {
      statusText = 'Changed';
    }
  } else if (latestTop || previousTop) {
    statusText = 'Changed';
  }

  return {
    latest,
    previous,
    kills: {
      deltaText: formatSignedDelta(killsDiff),
      trend: killsDiff > 0 ? 'better' : killsDiff < 0 ? 'worse' : 'equal',
    },
    deaths: {
      deltaText: formatSignedDelta(deathsDiff),
      trend: deathsDiff < 0 ? 'better' : deathsDiff > 0 ? 'worse' : 'equal',
    },
    kd: {
      deltaText: kdDeltaText,
      trend: kdTrend,
    },
    headshots: {
      deltaText: formatSignedDelta(hsDiff),
      trend: hsDiff > 0 ? 'better' : hsDiff < 0 ? 'worse' : 'equal',
      latestPct,
      previousPct,
    },
    duration: {
      deltaText: formatDurationDelta(durationDiff),
      trend: 'neutral',
    },
    xp: {
      comparable: xpComparable,
      deltaText: xpComparable ? formatSignedDelta(xpDiff, ' XP') : 'Guest',
      trend: !xpComparable
        ? 'neutral'
        : xpDiff > 0
          ? 'better'
          : xpDiff < 0
            ? 'worse'
            : 'equal',
    },
    topWeapon: {
      latestLabel,
      previousLabel,
      statusText,
    },
  };
}

export interface MatchSummaryExportPayload {
  schemaVersion: 1;
  exportedAt: string;
  match: {
    id: string;
    completedAt: number;
    completedAtIso: string;
    mode: 'battle' | 'infection';
    battleRule: BattleRuleId | null;
    infectionRound: number | null;
    mapId: string | null;
    mapName: string;
    outcome: 'victory' | 'defeat' | 'completed';
    durationSec: number;
    isGuest: boolean;
    stats: {
      kills: number;
      deaths: number;
      headshots: number;
      kdDisplay: string;
      headshotAccuracyPct: number;
      netXp: number;
      cashEarned: number;
    };
    weaponStats: RecentMatchWeaponStat[];
  };
}

export function buildMatchSummaryExportPayload(
  match: RecentMatchRecord,
  exportedAtIso = new Date().toISOString(),
): MatchSummaryExportPayload {
  const headshotAccuracyPct =
    match.kills > 0 ? Math.round((match.headshots / match.kills) * 100) : 0;

  return {
    schemaVersion: 1,
    exportedAt: exportedAtIso,
    match: {
      id: match.id,
      completedAt: match.completedAt,
      completedAtIso: new Date(match.completedAt).toISOString(),
      mode: match.mode,
      battleRule: match.battleRule ?? null,
      infectionRound: match.infectionRound ?? null,
      mapId: match.mapId ?? null,
      mapName: match.mapName,
      outcome: match.outcome,
      durationSec: match.durationSec,
      isGuest: match.isGuest,
      stats: {
        kills: match.kills,
        deaths: match.deaths,
        headshots: match.headshots,
        kdDisplay: match.kdDisplay,
        headshotAccuracyPct,
        netXp: match.netXp,
        cashEarned: match.cashEarned,
      },
      weaponStats: match.weaponStats.map((w) => ({
        weaponId: w.weaponId,
        weaponName: w.weaponName,
        kills: w.kills,
      })),
    },
  };
}

export function formatMatchExportFilename(match: RecentMatchRecord): string {
  const datePart = new Date(match.completedAt).toISOString().slice(0, 10);
  const mapSlug = (match.mapId || match.mapName || 'sector')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  const idSlug = match.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 8);
  return `axon-match-${match.mode}-${mapSlug || 'sector'}-${datePart}-${idSlug || 'log'}.json`;
}


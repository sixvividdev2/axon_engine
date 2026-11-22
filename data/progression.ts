import { ATTACHMENTS, WEAPON_COMPAT_META } from './attachments';

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

export interface MatchResultInput {
  mode: 'battle' | 'infection';
  kills: number;
  headshots: number;
  deaths: number;
  outcome: 'victory' | 'defeat' | 'completed';
  infectionRound?: number;
  weaponKills: Record<string, number>;
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
  mosin_m91_30: 'optic_pso1_4x',
  colt_c19: 'optic_lpvo_1_6',
  remington_m24: 'optic_lpvo_1_6',
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

  // Mid-tier handling, lasers, holos & standard mags (Lv. 6–10)
  tac_laser_red: 6,
  optic_eotech_holo: 7,
  grip_vertical_rk: 7,
  canted_t2_red_dot: 8,
  canted_kobra_rd: 8,
  mag_ak_30: 8,
  optic_pso1_4x: 9,
  mag_saiga_10: 9,
  canted_eotech_holo: 10,
  mag_ar10_20: 10,

  // Mid-late tactical modules, magnified optics & SUPPRESSORS (Lv. 11–15)
  optic_pso4: 11,
  tac_peq_combo: 11,
  muzzle_nagant_bramit: 12,
  muzzle_9mm_suppressor: 12,
  optic_lpvo_1_6: 12,
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

  const killXp = kills * 100;
  const headshotXp = headshots * 25;
  const deathPenaltyXp = deaths * 40;
  const matchOutcomeXp =
    input.outcome === 'victory' ? 350 : input.outcome === 'defeat' ? -150 : 120;
  const roundBonusXp = input.mode === 'infection' ? infectionRound * 75 : 0;

  const netXp = killXp + headshotXp - deathPenaltyXp + matchOutcomeXp + roundBonusXp;
  const cashEarned = Math.max(
    0,
    kills * 25 + headshots * 10 + (input.outcome === 'victory' ? 150 : 40) + infectionRound * 30,
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

  return {
    nextCareer,
    nextWeaponProgress,
    nextUnlockedAttachments,
    summary: {
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

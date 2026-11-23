import { CharacterRoster } from './CharacterRoster';
import { ShardStore } from './ShardStore';
import {
  CharacterSlotId,
  DroppedCorpseEntity,
  InventoryItemRecord,
  OpenWorldCharacter,
  PMC_FACTIONS,
  STANDING_TRUSTED_MIN,
  SUB_FACTION_LIST,
} from './types';

export const MIN_FIELD_HOSPITAL_FEE_USD = 2500;
export const MAX_FIELD_HOSPITAL_FEE_USD = 15000;

/**
 * Tiered Field Hospital medical fee ladder ($2,500 early tier -> $15,000 late tier).
 */
const TIER_FEE_LADDER: readonly number[] = [
  2500, // Tier 1
  4500, // Tier 2
  7000, // Tier 3
  9500, // Tier 4
  12000, // Tier 5
  15000, // Tier 6+
] as const;

export interface FieldHospitalOption {
  id: string;
  name: string;
  ownerLabel: string;
  source: 'pmc_fob' | 'sub_faction';
  unlocked: boolean;
  requiredStanding?: number;
}

export type BankruptcySeverity = 'safe' | 'low_margin' | 'bankruptcy_risk';

export interface BankruptcyStatus {
  isBankruptcyRisk: boolean;
  severity: BankruptcySeverity;
  currentCash: number;
  nextRespawnFee: number;
  shortfall: number;
  marginAfterRespawn: number;
  pdaBannerText: string | null;
}

export interface CharacterDeathInput {
  slotId: CharacterSlotId;
  causeOfDeath?: string;
  worldX?: number;
  worldZ?: number;
  sectorLabel?: string;
  hospitalId?: string;
}

export type CharacterDeathOutcome =
  | {
      outcome: 'field_hospital_respawn';
      slotId: CharacterSlotId;
      callsign: string;
      feePaid: number;
      remainingCash: number;
      hospital: FieldHospitalOption;
      droppedCorpse: DroppedCorpseEntity;
      retainedSecureItems: InventoryItemRecord[];
      updatedCharacter: OpenWorldCharacter;
    }
  | {
      outcome: 'permadeath_wiped';
      slotId: CharacterSlotId;
      wipedCharacterId: string;
      callsign: string;
      requiredFee: number;
      cashAtDeath: number;
      shortfall: number;
      droppedCorpse: DroppedCorpseEntity;
      wipedSummary: {
        unlockedWeapons: number;
        unlockedAttachments: number;
        unlockedArmorPlates: number;
        completedContracts: number;
        stashItemCount: number;
        ownedVehicleCount: number;
      };
    };

/**
 * Computes scaled Field Hospital respawn fee ($2,500 early tier -> $15,000 late tier)
 * from character progression tier and completed contract milestones.
 */
export function computeFieldHospitalFee(character: OpenWorldCharacter): number {
  const tierIndex = Math.max(
    0,
    Math.min(TIER_FEE_LADDER.length - 1, Math.floor(character.missions.progressionTier) - 1),
  );
  const baseFee = TIER_FEE_LADDER[tierIndex];
  const contractBonus = Math.min(2500, Math.floor(character.missions.completedContracts / 3) * 500);
  return Math.max(
    MIN_FIELD_HOSPITAL_FEE_USD,
    Math.min(MAX_FIELD_HOSPITAL_FEE_USD, baseFee + contractBonus),
  );
}

/**
 * Evaluates soft-lock Bankruptcy Warning status for the physical GPS PDA and Ready Room terminal.
 */
export function getBankruptcyStatus(character: OpenWorldCharacter): BankruptcyStatus {
  const nextRespawnFee = computeFieldHospitalFee(character);
  const currentCash = Math.max(0, Math.round(character.cash));
  const isBankruptcyRisk = currentCash < nextRespawnFee;
  const shortfall = Math.max(0, nextRespawnFee - currentCash);
  const marginAfterRespawn = currentCash - nextRespawnFee;

  let severity: BankruptcySeverity = 'safe';
  if (isBankruptcyRisk) {
    severity = 'bankruptcy_risk';
  } else if (marginAfterRespawn < nextRespawnFee * 0.5) {
    severity = 'low_margin';
  }

  return {
    isBankruptcyRisk,
    severity,
    currentCash,
    nextRespawnFee,
    shortfall,
    marginAfterRespawn,
    pdaBannerText: isBankruptcyRisk
      ? `BANKRUPTCY WARNING · CASH $${currentCash.toLocaleString()} < MEDEVAC $${nextRespawnFee.toLocaleString()} · DEATH WIPES CHARACTER`
      : null,
  };
}

/**
 * Lists the character's PMC Home FOB Field Hospital plus any regional sub-faction
 * Field Hospitals unlocked by reaching Trusted standing (+50 to +100).
 */
export function getAvailableFieldHospitals(character: OpenWorldCharacter): FieldHospitalOption[] {
  const faction = PMC_FACTIONS[character.pmcFaction];
  const options: FieldHospitalOption[] = [
    {
      id: faction.homeHospitalId,
      name: faction.homeHospitalName,
      ownerLabel: faction.name,
      source: 'pmc_fob',
      unlocked: true,
    },
  ];

  for (const sf of SUB_FACTION_LIST) {
    const standing = character.subFactionStanding[sf.id] ?? 0;
    options.push({
      id: sf.hospitalId,
      name: sf.hospitalName,
      ownerLabel: sf.name,
      source: 'sub_faction',
      unlocked: standing >= STANDING_TRUSTED_MIN,
      requiredStanding: STANDING_TRUSTED_MIN,
    });
  }

  return options;
}

/**
 * Authoritative Permadeath & Full-Drop Corpse Service.
 * - Drops 100% of equipped weapons, attachments, armor, tactical rig, and backpack contents
 *   onto a persistent lootable corpse entity inside the character's shard (`PvPvE` or `PvE`).
 * - Retains ONLY items inside the character's Secure Container (and Hideout Stash on respawn).
 * - If `character.cash < currentRespawnFee`: permanently deletes the character slot
 *   (wiping stash, Arsenal Wall, vehicles, and reputation).
 * - If `character.cash >= currentRespawnFee`: deducts fee and respawns at controlled/trusted Field Hospital.
 */
export function processCharacterDeath(
  roster: CharacterRoster,
  shards: ShardStore,
  input: CharacterDeathInput,
): CharacterDeathOutcome | null {
  const character = roster.getCharacter(input.slotId);
  if (!character) return null;

  const requiredFee = computeFieldHospitalFee(character);
  const droppedWeaponsSet = new Set<string>();
  if (character.equippedKit.primaryWeaponId) {
    droppedWeaponsSet.add(character.equippedKit.primaryWeaponId);
  }
  if (character.equippedKit.secondaryWeaponId) {
    droppedWeaponsSet.add(character.equippedKit.secondaryWeaponId);
  }
  if (character.arsenal.equippedWeaponId && character.arsenal.equippedWeaponId !== 'unarmed') {
    droppedWeaponsSet.add(character.arsenal.equippedWeaponId);
  }
  const droppedWeaponIds = Array.from(droppedWeaponsSet);
  const droppedItems = character.equippedKit.backpackItems.map((it) => ({ ...it }));
  const nowIso = new Date().toISOString();

  const isBankrupt = character.cash < requiredFee;

  // 1. Spawn persistent full-drop corpse entity on that character's shard
  const droppedCorpse = shards.addDroppedCorpse(
    character.shardMode,
    {
      corpseId: `corpse_${character.characterId}_${Date.now()}`,
      ownerCharacterId: character.characterId,
      ownerCallsign: character.callsign,
      ownerFaction: character.pmcFaction,
      worldX: input.worldX ?? 0,
      worldZ: input.worldZ ?? 0,
      sectorLabel: input.sectorLabel ?? 'Highland Quarry Perimeter',
      causeOfDeath: input.causeOfDeath ?? 'KIA · Ballistic Trauma',
      droppedWeaponIds,
      droppedArmorName: character.equippedKit.armorName,
      droppedRigName: character.equippedKit.rigName,
      droppedItems,
      createdAtIso: nowIso,
    },
    isBankrupt ? 'permadeath_wipe' : 'death',
  );

  // 2. Permadeath Bankruptcy Check: cash < respawn fee => permanent character deletion
  // Wipes 100% of this characterId's unlocks, stored gear, cash, vehicles, and reputation
  // while leaving account-level roster slots and sibling characters untouched.
  if (isBankrupt) {
    const shortfall = requiredFee - character.cash;
    const wipedSummary = {
      unlockedWeapons: character.unlocks.unlockedWeaponIds.length,
      unlockedAttachments: character.unlocks.unlockedAttachmentIds.length,
      unlockedArmorPlates: character.unlocks.unlockedArmorPlateIds.length,
      completedContracts: character.unlocks.completedContractIds.length,
      stashItemCount: character.stashItems.length,
      ownedVehicleCount: character.ownedVehicleKeys.length,
    };
    roster.deleteCharacter(character.slotId);
    shards.recordDiscreteTransition(
      character.shardMode,
      'permadeath_wipe',
      `${character.callsign} (${character.slotId}) wiped — cash $${character.cash.toLocaleString()} below $${requiredFee.toLocaleString()} Field Hospital fee (unlocks, stash & vehicles purged)`,
    );
    return {
      outcome: 'permadeath_wiped',
      slotId: character.slotId,
      wipedCharacterId: character.characterId,
      callsign: character.callsign,
      requiredFee,
      cashAtDeath: character.cash,
      shortfall,
      droppedCorpse,
      wipedSummary,
    };
  }

  // 3. Solvent Respawn at chosen controlled/trusted Field Hospital
  const hospitals = getAvailableFieldHospitals(character);
  const chosenHospital =
    hospitals.find((h) => h.id === input.hospitalId && h.unlocked) ?? hospitals[0];

  const updatedCharacter = roster.applyFieldHospitalRespawn(
    character.slotId,
    requiredFee,
    chosenHospital.id,
    droppedWeaponIds,
  );
  if (!updatedCharacter) return null;

  shards.recordDiscreteTransition(
    character.shardMode,
    'field_hospital_respawn',
    `${character.callsign} respawned at ${chosenHospital.name} (-$${requiredFee.toLocaleString()}, remaining $${updatedCharacter.cash.toLocaleString()})`,
  );

  return {
    outcome: 'field_hospital_respawn',
    slotId: character.slotId,
    callsign: character.callsign,
    feePaid: requiredFee,
    remainingCash: updatedCharacter.cash,
    hospital: chosenHospital,
    droppedCorpse,
    retainedSecureItems: updatedCharacter.secureContainerItems.map((it) => ({ ...it })),
    updatedCharacter,
  };
}

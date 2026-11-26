import { useEffect, useState } from 'react';
import { resolveWeaponProfile } from '../../../bodycam-sdk/weaponProfiles';
import {
  OperatorSelectionStore,
  operatorSelectionStore,
} from '../../../bodycam-sdk/operator/OperatorSelectionStore';
import { hideoutStateStore } from '../../../hideout/HideoutStateStore';
import { CharacterRoster, characterRoster, CharacterRosterState } from './CharacterRoster';
import {
  BankruptcyStatus,
  computeFieldHospitalFee,
  getBankruptcyStatus,
} from './PermadeathService';
import { DualShardStoreState, ShardStore, shardStore } from './ShardStore';
import {
  bodyTypeToOperatorId,
  CharacterSlotId,
  OpenWorldCharacter,
  PMC_FACTIONS,
  SHARD_RULES,
  ShardMode,
  ShardWorldState,
} from './types';

export interface ClassicHideoutStoreLike {
  getState: typeof hideoutStateStore.getState;
  syncWithUnlockedCheck: typeof hideoutStateStore.syncWithUnlockedCheck;
  commitRackSwap: typeof hideoutStateStore.commitRackSwap;
  setEquippedWeaponDirect: typeof hideoutStateStore.setEquippedWeaponDirect;
  getReserveForWeapon: typeof hideoutStateStore.getReserveForWeapon;
  consumeReserve: typeof hideoutStateStore.consumeReserve;
  addReserve?: typeof hideoutStateStore.addReserve;
  resupplyAllAmmo: typeof hideoutStateStore.resupplyAllAmmo;
  setWeaponAmmoVariant: typeof hideoutStateStore.setWeaponAmmoVariant;
  setWeaponZeroDistance: typeof hideoutStateStore.setWeaponZeroDistance;
}

export interface HideoutArsenalSnapshot {
  isOpenWorldActive: boolean;
  activeSlotId: CharacterSlotId | null;
  ownedWeaponIds: string[];
  wallRackSlots: Array<string | null>;
  equippedWeaponId: string;
}

export interface PdaOpenWorldOverlay {
  active: boolean;
  characterCallsign?: string;
  shardLabel?: string;
  factionLabel?: string;
  cashUsd?: number;
  respawnFeeUsd?: number;
  bankruptcyWarning: boolean;
  bankruptcyText?: string;
}

export interface ReadyRoomOpenWorldSummary {
  slotId: CharacterSlotId;
  callsign: string;
  shardMode: ShardMode;
  shardLabel: string;
  factionName: string;
  factionShort: string;
  bodyTypeLabel: string;
  cashUsd: number;
  respawnFeeUsd: number;
  isBankruptcyRisk: boolean;
  ownedWeaponCount: number;
  progressionTier: number;
}

export interface HideoutShardAdapterSnapshot {
  roster: CharacterRosterState;
  shards: DualShardStoreState;
  activeCharacter: OpenWorldCharacter | null;
  activeShard: ShardWorldState | null;
  bankruptcy: BankruptcyStatus | null;
  pdaOverlay: PdaOpenWorldOverlay;
  readyRoomSummary: ReadyRoomOpenWorldSummary | null;
}

type AdapterListener = (snapshot: HideoutShardAdapterSnapshot) => void;

/**
 * Bridges Perimeter Operations (`CharacterRoster`, `ShardStore`, `PermadeathService`) into the
 * existing 3D Hideout without modifying Battle or Infection combat modes.
 *
 * - When an Open World character slot is active (`activeSlotId !== null`), the 3D Arsenal Gun Wall,
 *   equipped firearm, ammo reserves, optic zero, ammo load, and M/F operator rig + uniform are
 *   100% isolated to that character.
 * - When no Open World character is active (`activeSlotId === null`), transparently falls back to
 *   Classic Career Mode (`hideoutStateStore`).
 */
export class HideoutShardAdapter {
  private readonly roster: CharacterRoster;
  private readonly shards: ShardStore;
  private readonly classicHideout: ClassicHideoutStoreLike;
  private readonly operatorStore: OperatorSelectionStore;
  private readonly listeners = new Set<AdapterListener>();

  private syncingOperatorFromCharacter = false;
  private lastSyncedCharacterKey = '';
  private readonly unsubRoster: () => void;
  private readonly unsubShards: () => void;
  private readonly unsubOperatorGear: () => void;

  constructor(
    roster: CharacterRoster = characterRoster,
    shards: ShardStore = shardStore,
    classicHideout: ClassicHideoutStoreLike = hideoutStateStore,
    operatorStore: OperatorSelectionStore = operatorSelectionStore,
  ) {
    this.roster = roster;
    this.shards = shards;
    this.classicHideout = classicHideout;
    this.operatorStore = operatorStore;

    // Initial operator rig sync if a character slot was already active on load
    this.syncOperatorRigFromActiveCharacter(false);

    this.unsubRoster = this.roster.subscribe(() => {
      this.syncOperatorRigFromActiveCharacter(false);
      this.emit();
    });

    this.unsubShards = this.shards.subscribe(() => {
      this.emit();
    });

    // When the player customizes helmet/gloves/NVG/uniform in the Hideout Locker while
    // playing an Open World character, persist gear edits back to that character slot
    // (locked bodyType remains immutable).
    this.unsubOperatorGear = this.operatorStore.subscribeGear((nextGear) => {
      if (this.syncingOperatorFromCharacter) return;
      const active = this.roster.getActiveCharacter();
      if (!active) return;
      const prev = active.operatorGear;
      const changed =
        prev.uniformId !== nextGear.uniformId ||
        prev.glovesEnabled !== nextGear.glovesEnabled ||
        prev.gloveColor !== nextGear.gloveColor ||
        prev.helmetType !== nextGear.helmetType ||
        prev.helmetColor !== nextGear.helmetColor ||
        prev.nvgMount !== nextGear.nvgMount ||
        prev.faceGear !== nextGear.faceGear ||
        prev.eyewear !== nextGear.eyewear ||
        prev.facePreset !== nextGear.facePreset;
      if (changed) {
        this.roster.updateCharacterGear(active.slotId, nextGear);
      }
    });
  }

  public isOpenWorldActive(): boolean {
    return this.roster.getActiveCharacter() !== null;
  }

  public getActiveCharacter(): OpenWorldCharacter | null {
    return this.roster.getActiveCharacter();
  }

  public getRoster(): CharacterRoster {
    return this.roster;
  }

  public getShardStore(): ShardStore {
    return this.shards;
  }

  public syncOperatorRigFromActiveCharacter(force = false): void {
    const active = this.roster.getActiveCharacter();
    if (!active) {
      this.lastSyncedCharacterKey = '';
      return;
    }

    const rigKey = `${active.characterId}|${active.bodyType}|${active.operatorGear.uniformId}|${active.operatorGear.glovesEnabled}|${active.operatorGear.helmetType}|${active.operatorGear.helmetColor}|${active.operatorGear.gloveColor}|${active.operatorGear.nvgMount}|${active.operatorGear.faceGear}|${active.operatorGear.eyewear}`;
    if (!force && rigKey === this.lastSyncedCharacterKey) {
      return;
    }
    this.lastSyncedCharacterKey = rigKey;

    const targetOp = bodyTypeToOperatorId(active.bodyType);
    this.syncingOperatorFromCharacter = true;
    try {
      if (this.operatorStore.getSelectedOperator() !== targetOp) {
        this.operatorStore.setSelectedOperator(targetOp);
      }
      this.operatorStore.setGearConfig(active.operatorGear);
    } finally {
      this.syncingOperatorFromCharacter = false;
    }
  }

  public isWeaponOwnedInActiveContext(
    weaponId: string,
    classicUnlockCheck: (weaponId: string) => boolean,
  ): boolean {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return active.arsenal.ownedWeaponIds.includes(weaponId);
    }
    return classicUnlockCheck(weaponId);
  }

  public isAttachmentUnlockedInActiveContext(
    attachmentId: string,
    classicUnlockCheck: (attachmentId: string) => boolean,
  ): boolean {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return active.unlocks.unlockedAttachmentIds.includes(attachmentId);
    }
    return classicUnlockCheck(attachmentId);
  }

  public isArmorPlateUnlockedInActiveContext(armorPlateId: string): boolean {
    const active = this.roster.getActiveCharacter();
    if (!active) return true;
    return active.unlocks.unlockedArmorPlateIds.includes(armorPlateId);
  }

  public syncOwnedWeapons(
    classicUnlockCheck: (weaponId: string) => boolean,
  ): HideoutArsenalSnapshot {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return {
        isOpenWorldActive: true,
        activeSlotId: active.slotId,
        ownedWeaponIds: [...active.arsenal.ownedWeaponIds],
        wallRackSlots: [...active.arsenal.wallRackSlots],
        equippedWeaponId: active.arsenal.equippedWeaponId,
      };
    }

    const classic = this.classicHideout.syncWithUnlockedCheck(classicUnlockCheck);
    return {
      isOpenWorldActive: false,
      activeSlotId: null,
      ownedWeaponIds: [...classic.unlockedWeaponIds],
      wallRackSlots: [...classic.wallRackSlots],
      equippedWeaponId: classic.equippedWeaponId,
    };
  }

  public getWallRackSlots(): Array<string | null> {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return [...active.arsenal.wallRackSlots];
    }
    return [...this.classicHideout.getState().wallRackSlots];
  }

  public getEquippedWeaponId(): string {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return active.arsenal.equippedWeaponId;
    }
    return this.classicHideout.getState().equippedWeaponId;
  }

  public resolveQuickSlotWeaponId(
    slot: 1 | 2 | 3,
    classicFallbackId: string,
  ): string {
    if (slot === 3) return 'unarmed';
    const active = this.roster.getActiveCharacter();
    if (!active) return classicFallbackId;

    const owned = active.arsenal.ownedWeaponIds;
    if (slot === 1) {
      if (
        active.equippedKit.primaryWeaponId &&
        owned.includes(active.equippedKit.primaryWeaponId)
      ) {
        return active.equippedKit.primaryWeaponId;
      }
      const firstLongGun = owned.find((id) => {
        const prof = resolveWeaponProfile(id);
        return prof.category !== 'pistols' && prof.category !== 'revolvers';
      });
      return firstLongGun ?? owned[0] ?? 'unarmed';
    }

    if (
      active.equippedKit.secondaryWeaponId &&
      owned.includes(active.equippedKit.secondaryWeaponId)
    ) {
      return active.equippedKit.secondaryWeaponId;
    }
    const firstPistol = owned.find((id) => {
      const prof = resolveWeaponProfile(id);
      return prof.category === 'pistols' || prof.category === 'revolvers';
    });
    return firstPistol ?? 'unarmed';
  }

  public commitRackSwap(
    slotIndex: number,
  ): { previousEquipped: string; nextEquipped: string; wallRackSlots: Array<string | null> } {
    const active = this.roster.getActiveCharacter();
    if (active) {
      const res = this.roster.commitArsenalRackSwap(active.slotId, slotIndex);
      const updated = this.roster.getCharacter(active.slotId);
      return {
        ...res,
        wallRackSlots: updated ? [...updated.arsenal.wallRackSlots] : [],
      };
    }

    const res = this.classicHideout.commitRackSwap(slotIndex);
    return {
      ...res,
      wallRackSlots: [...this.classicHideout.getState().wallRackSlots],
    };
  }

  public setEquippedWeaponDirect(weaponId: string): Array<string | null> {
    const active = this.roster.getActiveCharacter();
    if (active) {
      this.roster.setArsenalEquippedWeapon(active.slotId, weaponId);
      const updated = this.roster.getCharacter(active.slotId);
      return updated ? [...updated.arsenal.wallRackSlots] : [];
    }
    this.classicHideout.setEquippedWeaponDirect(weaponId);
    return [...this.classicHideout.getState().wallRackSlots];
  }

  public getReserveForWeapon(weaponId: string): number {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return this.roster.getArsenalReserveForWeapon(active.slotId, weaponId);
    }
    return this.classicHideout.getReserveForWeapon(weaponId);
  }

  public consumeReserve(weaponId: string, rounds: number): number {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return this.roster.consumeArsenalReserve(active.slotId, weaponId, rounds);
    }
    return this.classicHideout.consumeReserve(weaponId, rounds);
  }

  public addReserve(weaponId: string, rounds: number): number {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return this.roster.addArsenalReserve(active.slotId, weaponId, rounds);
    }
    return this.classicHideout.addReserve ? this.classicHideout.addReserve(weaponId, rounds) : 0;
  }

  public resupplyAllAmmo(): void {
    const active = this.roster.getActiveCharacter();
    if (active) {
      this.roster.resupplyArsenalAmmo(active.slotId);
      return;
    }
    this.classicHideout.resupplyAllAmmo();
  }

  public getAmmoVariantId(weaponId: string): string | undefined {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return active.arsenal.ammoVariantByWeapon[weaponId];
    }
    return this.classicHideout.getState().ammoVariantByWeapon[weaponId];
  }

  public setWeaponAmmoVariant(weaponId: string, variantId: string): void {
    const active = this.roster.getActiveCharacter();
    if (active) {
      this.roster.setArsenalAmmoVariant(active.slotId, weaponId, variantId);
      return;
    }
    this.classicHideout.setWeaponAmmoVariant(weaponId, variantId);
  }

  public getZeroDistance(weaponId: string): number | undefined {
    const active = this.roster.getActiveCharacter();
    if (active) {
      return active.arsenal.zeroDistanceByWeapon[weaponId];
    }
    return this.classicHideout.getState().zeroDistanceByWeapon[weaponId];
  }

  public setWeaponZeroDistance(weaponId: string, zeroDistanceM: number): void {
    const active = this.roster.getActiveCharacter();
    if (active) {
      this.roster.setArsenalZeroDistance(active.slotId, weaponId, zeroDistanceM);
      return;
    }
    this.classicHideout.setWeaponZeroDistance(weaponId, zeroDistanceM);
  }

  public getPdaTelemetryOverlay(): PdaOpenWorldOverlay {
    const active = this.roster.getActiveCharacter();
    if (!active) {
      return { active: false, bankruptcyWarning: false };
    }
    const status = getBankruptcyStatus(active);
    const faction = PMC_FACTIONS[active.pmcFaction];
    return {
      active: true,
      characterCallsign: active.callsign,
      shardLabel: active.shardMode,
      factionLabel: faction.shortName,
      cashUsd: status.currentCash,
      respawnFeeUsd: status.nextRespawnFee,
      bankruptcyWarning: status.isBankruptcyRisk,
      bankruptcyText: status.pdaBannerText ?? undefined,
    };
  }

  public getReadyRoomSummary(): ReadyRoomOpenWorldSummary | null {
    const active = this.roster.getActiveCharacter();
    if (!active) return null;
    const faction = PMC_FACTIONS[active.pmcFaction];
    const fee = computeFieldHospitalFee(active);
    return {
      slotId: active.slotId,
      callsign: active.callsign,
      shardMode: active.shardMode,
      shardLabel: SHARD_RULES[active.shardMode].label,
      factionName: faction.name,
      factionShort: faction.shortName,
      bodyTypeLabel: active.bodyType === 'female' ? 'Female Rig' : 'Male Rig',
      cashUsd: active.cash,
      respawnFeeUsd: fee,
      isBankruptcyRisk: active.cash < fee,
      ownedWeaponCount: active.arsenal.ownedWeaponIds.length,
      progressionTier: active.missions.progressionTier,
    };
  }

  public getSnapshot(): HideoutShardAdapterSnapshot {
    const rosterState = this.roster.getState();
    const shardsState = this.shards.getState();
    const activeCharacter = rosterState.activeSlotId
      ? rosterState.slots[rosterState.activeSlotId]
      : null;
    const activeShard = activeCharacter ? shardsState.shards[activeCharacter.shardMode] : null;
    const bankruptcy = activeCharacter ? getBankruptcyStatus(activeCharacter) : null;

    return {
      roster: rosterState,
      shards: shardsState,
      activeCharacter,
      activeShard,
      bankruptcy,
      pdaOverlay: this.getPdaTelemetryOverlay(),
      readyRoomSummary: this.getReadyRoomSummary(),
    };
  }

  public subscribe(listener: AdapterListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public dispose(): void {
    this.unsubRoster();
    this.unsubShards();
    this.unsubOperatorGear();
    this.listeners.clear();
  }
}

export const hideoutShardAdapter = new HideoutShardAdapter();

export function useHideoutShardAdapter(
  adapter: HideoutShardAdapter = hideoutShardAdapter,
): HideoutShardAdapterSnapshot {
  const [snap, setSnap] = useState<HideoutShardAdapterSnapshot>(() => adapter.getSnapshot());
  useEffect(() => {
    setSnap(adapter.getSnapshot());
    return adapter.subscribe((next) => setSnap(next));
  }, [adapter]);
  return snap;
}

import type { AmmoVariantId } from '../../../../data/calibers';
import type { CharacterRoster } from '../CharacterRoster';
import {
  BACKPACK_TEMPLATES,
  CHEST_RIG_TEMPLATES,
  createAmmoStackItem,
  createBackpackItem,
  createChestRigItem,
  createGrenadeItem,
  createMagazineItem,
  createMedicalItem,
  createPdaBatteryItem,
  MAGAZINE_TEMPLATES,
  stowItemIntoOperatorInventory,
} from '../inventory/TetrisInventoryCore';
import type { TacticalItem } from '../inventory/TetrisInventoryTypes';
import type { ShardStore } from '../ShardStore';
import {
  ARMOR_PLATE_CATALOG,
  FactionSupplyPool,
  FOB_UPGRADE_SPECS,
  FobTier,
  OpenWorldCharacter,
  PmcFactionId,
  ShardMode,
  SupplyResourceKey,
  SupplyStockTier,
} from '../types';

export interface SupplyTierStatus {
  resource: SupplyResourceKey;
  label: string;
  pct: number;
  tier: SupplyStockTier;
  tierLabel: 'HIGH' | 'STRAINED' | 'STARVED';
  priceMultiplier: number;
  stockScale: number;
  restockIntervalSec: number;
}

export interface FobTraderOffer {
  readonly offerId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly category: 'ammo' | 'magazine' | 'rig' | 'backpack' | 'medical' | 'ordnance' | 'armor' | 'utility';
  readonly supplyResource: SupplyResourceKey;
  readonly basePriceUsd: number;
  readonly baseStock: number;
  readonly requiredFobTier: FobTier;
  readonly starvedLocked: boolean;
  readonly description: string;
  readonly createItem: () => TacticalItem | null;
  readonly armorPlateId?: string;
}

export interface EvaluatedFobTraderOffer {
  offerId: string;
  name: string;
  shortLabel: string;
  category: FobTraderOffer['category'];
  supplyResource: SupplyResourceKey;
  stockTier: SupplyStockTier;
  priceUsd: number;
  remainingStock: number;
  maxStock: number;
  requiredFobTier: FobTier;
  lockedReason: string | null;
  description: string;
}

export interface FobTerminalStateSnapshot {
  faction: PmcFactionId;
  shardMode: ShardMode;
  fobTier: FobTier;
  avgSupplyPct: number;
  nextUpgrade: {
    targetTier: FobTier;
    name: string;
    cashCostUsd: number;
    minAvgSupplyPct: number;
    unlocksSummary: string;
    physicalUpgrades: readonly string[];
    canFund: boolean;
    blockedReason: string | null;
  } | null;
  supplyTiers: Record<SupplyResourceKey, SupplyTierStatus>;
  restockRemainingSec: number;
  sabotageDelaySec: number;
  offers: EvaluatedFobTraderOffer[];
}

export function classifySupplyTier(pct: number): SupplyStockTier {
  if (pct > 70) return 'high';
  if (pct >= 30) return 'strained';
  return 'starved';
}

export const RESTOCK_INTERVAL_HIGH_SEC = 1800; // 30 minutes (>70% supply)
export const RESTOCK_INTERVAL_STRAINED_SEC = 3600; // 60 minutes (30-70% supply)
export const RESTOCK_INTERVAL_STARVED_SEC = 7200; // 2 hours (<30% supply)

export function formatRestockTimer(totalSec: number): string {
  const clean = Math.max(0, Math.ceil(totalSec));
  const hrs = Math.floor(clean / 3600);
  const mins = Math.floor((clean % 3600) / 60);
  const secs = clean % 60;
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Computes the unified wall-clock remaining restock countdown shared identically between
 * Hideout Ready Room Quartermaster (`PerimeterOpsTerminalPanel`) and In-World FOB Quartermaster.
 */
export function computeUnifiedRestockRemainingSec(
  pool: FactionSupplyPool,
  sabotageDelaySec = 0,
  nowMs = Date.now(),
): { remainingSec: number; cycleIntervalSec: number; tier: SupplyStockTier } {
  const avg = (pool.ammo + pool.medical + pool.fuelParts + pool.intel) / 4;
  const st = evaluateSupplyResourceStatus('ammo', avg);
  const cycleIntervalSec = Math.max(60, st.restockIntervalSec + Math.max(0, Math.round(sabotageDelaySec)));
  const elapsedSec = Math.floor(nowMs / 1000) % cycleIntervalSec;
  return {
    remainingSec: Math.max(1, cycleIntervalSec - elapsedSec),
    cycleIntervalSec,
    tier: st.tier,
  };
}

export function evaluateSupplyResourceStatus(
  resource: SupplyResourceKey,
  pct: number,
): SupplyTierStatus {
  const cleanPct = Math.max(0, Math.min(100, Math.round(pct)));
  const tier = classifySupplyTier(cleanPct);
  const labelMap: Record<SupplyResourceKey, string> = {
    ammo: 'Ammunition',
    medical: 'Medical',
    fuelParts: 'Fuel & Parts',
    intel: 'Intel & Comms',
  };
  if (tier === 'high') {
    return {
      resource,
      label: labelMap[resource],
      pct: cleanPct,
      tier,
      tierLabel: 'HIGH',
      priceMultiplier: 1.0,
      stockScale: 1.0,
      restockIntervalSec: RESTOCK_INTERVAL_HIGH_SEC,
    };
  }
  if (tier === 'strained') {
    return {
      resource,
      label: labelMap[resource],
      pct: cleanPct,
      tier,
      tierLabel: 'STRAINED',
      priceMultiplier: 1.2,
      stockScale: 0.5,
      restockIntervalSec: RESTOCK_INTERVAL_STRAINED_SEC,
    };
  }
  return {
    resource,
    label: labelMap[resource],
    pct: cleanPct,
    tier,
    tierLabel: 'STARVED',
    priceMultiplier: 1.45,
    stockScale: 0.25,
    restockIntervalSec: RESTOCK_INTERVAL_STARVED_SEC,
  };
}

function makeAmmoOffer(
  variantId: AmmoVariantId,
  name: string,
  shortLabel: string,
  count: number,
  basePriceUsd: number,
  requiredFobTier: FobTier,
  starvedLocked: boolean,
  description: string,
): FobTraderOffer {
  return {
    offerId: `offer_ammo_${variantId}`,
    name,
    shortLabel,
    category: 'ammo',
    supplyResource: 'ammo',
    basePriceUsd,
    baseStock: starvedLocked ? 4 : 8,
    requiredFobTier,
    starvedLocked,
    description,
    createItem: () => createAmmoStackItem(variantId, count),
  };
}

export const FOB_TRADER_OFFERS: readonly FobTraderOffer[] = [
  // === MIXED-VARIANT LOOSE AMMO BOXES (mix freely in same-caliber mags!) ===
  makeAmmoOffer('556x45_m855', '5.56x45 M855 FMJ (60rd)', 'M855 x60', 60, 420, 1, false, 'Standard NATO ball rounds.'),
  makeAmmoOffer('556x45_m855a1', '5.56x45 M855A1 EPR (30rd)', 'M855A1 x30', 30, 390, 2, true, 'Steel-penetrator EPR rounds for armor.'),
  makeAmmoOffer('556x45_m995', '5.56x45 M995 Tungsten AP (30rd)', 'M995 AP x30', 30, 620, 3, true, 'Tungsten-core armor-piercing rounds.'),
  makeAmmoOffer('556x45_mk262', '5.56x45 Mk262 OTM (30rd)', 'Mk262 x30', 30, 460, 2, true, 'Heavy 77gr open-tip match rounds.'),
  makeAmmoOffer('762x39_ps', '7.62x39 PS Steel-Core (60rd)', '7.62 PS x60', 60, 410, 1, false, 'Standard Eastern-bloc steel core.'),
  makeAmmoOffer('762x39_7n23', '7.62x39 7N23 BP AP (30rd)', '7N23 BP x30', 30, 490, 2, true, 'Hardened BP armor-piercing rounds.'),
  makeAmmoOffer('545x39_7n6', '5.45x39 7N6 Ball (60rd)', '7N6 x60', 60, 380, 1, false, 'Standard 5.45 service ammunition.'),
  makeAmmoOffer('545x39_7n22', '5.45x39 7N22 BP AP (30rd)', '7N22 BP x30', 30, 470, 2, true, 'Steel-core AP 5.45 rounds.'),
  makeAmmoOffer('762x51_m80', '7.62x51 M80 Ball (40rd)', 'M80 x40', 40, 460, 1, false, 'Full-power NATO DMR ball rounds.'),
  makeAmmoOffer('762x51_m993', '7.62x51 M993 AP (20rd)', 'M993 AP x20', 20, 640, 3, true, 'Tungsten-core heavy DMR AP.'),
  makeAmmoOffer('9x19_fmj', '9x19mm FMJ (50rd)', '9x19 FMJ x50', 50, 260, 1, false, 'Standard sidearm & SMG ball.'),
  makeAmmoOffer('9x19_7n21', '9x19mm 7N21 +P+ AP (30rd)', '7N21 AP x30', 30, 340, 2, true, 'Over-pressure AP 9mm rounds.'),
  makeAmmoOffer('9x19_147_sub', '9x19mm 147gr Subsonic (30rd)', '9mm SUB x30', 30, 310, 2, false, 'Subsonic suppressed sidearm rounds.'),
  makeAmmoOffer('9x18_pst', '9x18mm Makarov Pst (40rd)', '9x18 Pst x40', 40, 220, 1, false, 'Standard Makarov ball.'),
  makeAmmoOffer('9x18_pmm', '9x18mm PMM +P (30rd)', 'PMM +P x30', 30, 290, 2, true, 'High-velocity Makarov rounds.'),
  makeAmmoOffer('12ga_00buck', '12ga 00 Buckshot (24 shells)', '00 Buck x24', 24, 300, 1, false, 'Close-quarters 9-pellet buckshot.'),
  makeAmmoOffer('12ga_foster_slug', '12ga Foster Slugs (16 shells)', '12ga Slug x16', 16, 340, 2, true, 'Heavy breaching & mid-range slugs.'),

  // === MAGAZINES (empty, ready to pack with custom mixed stacks) ===
  ...MAGAZINE_TEMPLATES.map(
    (m): FobTraderOffer => ({
      offerId: `offer_${m.templateId}`,
      name: m.name,
      shortLabel: m.shortLabel,
      category: 'magazine',
      supplyResource: 'ammo',
      basePriceUsd: m.valueUsd,
      baseStock: 6,
      requiredFobTier: 1,
      starvedLocked: false,
      description: `${m.magClass === 'rifle' ? 'Rifle' : 'Pistol'} magazine (${m.capacity}rd) — fits Chest Rig ${m.magClass} slots.`,
      createItem: () => createMagazineItem(m.templateId, []),
    }),
  ),

  // === CHEST RIGS (Tier 1 -> Tier 3) ===
  ...CHEST_RIG_TEMPLATES.map(
    (r): FobTraderOffer => ({
      offerId: `offer_${r.templateId}`,
      name: r.name,
      shortLabel: r.shortLabel,
      category: 'rig',
      supplyResource: 'fuelParts',
      basePriceUsd: r.valueUsd,
      baseStock: 3,
      requiredFobTier: r.requiredFobTier,
      starvedLocked: r.requiredFobTier >= 3,
      description: `${r.rifleMagSlots} Rifle Mag + ${r.pistolMagSlots} Pistol Mag slots + ${r.generalWidth}x${r.generalHeight} pouch grid.`,
      createItem: () => createChestRigItem(r.templateId),
    }),
  ),

  // === BACKPACKS (Removable Gear Items, Tier 1 -> Tier 3) ===
  ...BACKPACK_TEMPLATES.map(
    (b): FobTraderOffer => ({
      offerId: `offer_${b.templateId}`,
      name: b.name,
      shortLabel: b.shortLabel,
      category: 'backpack',
      supplyResource: 'fuelParts',
      basePriceUsd: b.valueUsd,
      baseStock: 3,
      requiredFobTier: b.requiredFobTier,
      starvedLocked: b.requiredFobTier >= 3,
      description: `Removable ${b.gridWidth}x${b.gridHeight} Tetris pack — survives transfer & corpse looting.`,
      createItem: () => createBackpackItem(b.templateId),
    }),
  ),

  // === MEDICAL & ORDNANCE ===
  {
    offerId: 'offer_med_bandage',
    name: 'Hemostatic Field Bandage',
    shortLabel: 'Bandage',
    category: 'medical',
    supplyResource: 'medical',
    basePriceUsd: 240,
    baseStock: 8,
    requiredFobTier: 1,
    starvedLocked: false,
    description: 'Stops bleeding & restores +20 HP (2 uses). Fits Belt.',
    createItem: () => createMedicalItem('bandage'),
  },
  {
    offerId: 'offer_med_splint',
    name: 'Combat Splint & Autoinjector',
    shortLabel: 'Splint',
    category: 'medical',
    supplyResource: 'medical',
    basePriceUsd: 520,
    baseStock: 5,
    requiredFobTier: 1,
    starvedLocked: false,
    description: 'Clears leg trauma sprint slow & restores +25 HP. Fits Belt.',
    createItem: () => createMedicalItem('splint_stim'),
  },
  {
    offerId: 'offer_med_ifak',
    name: 'IFAK Surgical Trauma Kit',
    shortLabel: 'IFAK',
    category: 'medical',
    supplyResource: 'medical',
    basePriceUsd: 950,
    baseStock: 4,
    requiredFobTier: 2,
    starvedLocked: true,
    description: 'Full trauma treatment: +65 HP, stops bleeding & clears sprint slow (2 uses).',
    createItem: () => createMedicalItem('ifak'),
  },
  {
    offerId: 'offer_ord_m67',
    name: 'M67 Fragmentation Grenade',
    shortLabel: 'M67 Frag',
    category: 'ordnance',
    supplyResource: 'ammo',
    basePriceUsd: 380,
    baseStock: 6,
    requiredFobTier: 1,
    starvedLocked: false,
    description: '4-phase fragmentation ordnance. Fits Belt or Chest Rig pouches.',
    createItem: () => createGrenadeItem('m67_frag'),
  },
  {
    offerId: 'offer_pda_battery',
    name: 'CR123A Lithium PDA Cell',
    shortLabel: 'CR123A',
    category: 'utility',
    supplyResource: 'fuelParts',
    basePriceUsd: 180,
    baseStock: 10,
    requiredFobTier: 1,
    starvedLocked: false,
    description: '1x1 replacement lithium battery cell. Restores Handheld GPS PDA charge to 100%.',
    createItem: () => createPdaBatteryItem(100),
  },

  // === ARMOR PLATES ===
  ...ARMOR_PLATE_CATALOG.slice(0, 4).map(
    (p, idx): FobTraderOffer => ({
      offerId: `offer_plate_${p.id}`,
      name: p.name,
      shortLabel: p.ratingLabel,
      category: 'armor',
      supplyResource: 'fuelParts',
      basePriceUsd: p.priceUsd,
      baseStock: 3,
      requiredFobTier: idx >= 3 ? 3 : idx >= 2 ? 2 : 1,
      starvedLocked: idx >= 2,
      description: `${p.ratingLabel} ballistic insert (${p.durability} durability). Equips immediately.`,
      armorPlateId: p.id,
      createItem: () => null,
    }),
  ),
];

/**
 * Stateful Supply-Coupled FOB Quartermaster & Upgrade Controller.
 * Strictly accessed from physical in-world FOB Terminals (`[F]`).
 */
export class OpenWorldLogisticsEconomy {
  private readonly purchasedCounts = new Map<string, number>();
  private lastCycleBucket = -1;
  private restockElapsedSec = 0;

  public update(dt: number, pool: FactionSupplyPool, sabotageDelaySec: number): void {
    const unified = computeUnifiedRestockRemainingSec(pool, sabotageDelaySec);
    const bucket = Math.floor(Date.now() / 1000 / unified.cycleIntervalSec);
    if (this.lastCycleBucket >= 0 && bucket !== this.lastCycleBucket) {
      this.purchasedCounts.clear();
      this.restockElapsedSec = 0;
    }
    this.lastCycleBucket = bucket;
    this.restockElapsedSec += dt;
    if (this.restockElapsedSec >= unified.cycleIntervalSec) {
      this.restockElapsedSec = 0;
      this.purchasedCounts.clear();
    }
  }

  public getFobTerminalSnapshot(
    character: OpenWorldCharacter,
    shards: ShardStore,
    options?: { blackMarketDiscount?: boolean },
  ): FobTerminalStateSnapshot {
    const shard = shards.getShard(character.shardMode);
    const faction = character.pmcFaction;
    const pool = shard.pmcSupplyPools[faction];
    const fobTier = options?.blackMarketDiscount ? 3 : (shard.fobTiers[faction] ?? 1);
    const sabotageDelaySec = shard.restockPenaltySec[faction] ?? 0;
    const avgSupplyPct = Math.round((pool.ammo + pool.medical + pool.fuelParts + pool.intel) / 4);

    const supplyTiers: Record<SupplyResourceKey, SupplyTierStatus> = {
      ammo: evaluateSupplyResourceStatus('ammo', pool.ammo),
      medical: evaluateSupplyResourceStatus('medical', pool.medical),
      fuelParts: evaluateSupplyResourceStatus('fuelParts', pool.fuelParts),
      intel: evaluateSupplyResourceStatus('intel', pool.intel),
    };

    const unified = computeUnifiedRestockRemainingSec(pool, sabotageDelaySec);
    const restockRemainingSec = unified.remainingSec;

    let nextUpgrade: FobTerminalStateSnapshot['nextUpgrade'] = null;
    if (fobTier < 3) {
      const targetTier = (fobTier + 1) as FobTier;
      const spec = FOB_UPGRADE_SPECS[targetTier];
      let blockedReason: string | null = null;
      if (character.cash < spec.cashCostUsd) {
        blockedReason = `Need $${spec.cashCostUsd.toLocaleString()} cash (have $${character.cash.toLocaleString()})`;
      } else if (avgSupplyPct < spec.minAvgSupplyPct) {
        blockedReason = `Requires ${spec.minAvgSupplyPct}% avg PMC supply (currently ${avgSupplyPct}%)`;
      }
      nextUpgrade = {
        targetTier,
        name: spec.name,
        cashCostUsd: spec.cashCostUsd,
        minAvgSupplyPct: spec.minAvgSupplyPct,
        unlocksSummary: spec.unlocksSummary,
        physicalUpgrades: spec.physicalUpgrades,
        canFund: blockedReason === null,
        blockedReason,
      };
    }

    const offers: EvaluatedFobTraderOffer[] = FOB_TRADER_OFFERS.map((offer) => {
      const st = supplyTiers[offer.supplyResource];
      const maxStock =
        st.tier === 'starved' && offer.starvedLocked
          ? 0
          : Math.max(1, Math.round(offer.baseStock * st.stockScale));
      const key = `${character.shardMode}:${faction}:${offer.offerId}`;
      const bought = this.purchasedCounts.get(key) ?? 0;
      const remainingStock = Math.max(0, maxStock - bought);
      const priceMult = options?.blackMarketDiscount ? st.priceMultiplier * 0.85 : st.priceMultiplier;
      const priceUsd = Math.round(offer.basePriceUsd * priceMult);

      let lockedReason: string | null = null;
      if (fobTier < offer.requiredFobTier) {
        lockedReason = `Requires FOB Tier ${offer.requiredFobTier}`;
      } else if (!options?.blackMarketDiscount && st.tier === 'starved' && offer.starvedLocked) {
        lockedReason = `${st.label} Starved (<30%)`;
      } else if (remainingStock <= 0) {
        lockedReason = `Out of Stock (Restock ${formatRestockTimer(restockRemainingSec)})`;
      } else if (character.cash < priceUsd) {
        lockedReason = 'Insufficient Cash';
      }

      return {
        offerId: offer.offerId,
        name: offer.name,
        shortLabel: offer.shortLabel,
        category: offer.category,
        supplyResource: offer.supplyResource,
        stockTier: st.tier,
        priceUsd,
        remainingStock,
        maxStock,
        requiredFobTier: offer.requiredFobTier,
        lockedReason,
        description: offer.description,
      };
    });

    return {
      faction,
      shardMode: character.shardMode,
      fobTier,
      avgSupplyPct,
      nextUpgrade,
      supplyTiers,
      restockRemainingSec,
      sabotageDelaySec,
      offers,
    };
  }

  public fundNextFobUpgrade(
    character: OpenWorldCharacter,
    roster: CharacterRoster,
    shards: ShardStore,
  ): { ok: boolean; newTier?: FobTier; message: string } {
    const snap = this.getFobTerminalSnapshot(character, shards);
    if (!snap.nextUpgrade) {
      return { ok: false, message: 'FOB is already upgraded to maximum Tier 3.' };
    }
    if (!snap.nextUpgrade.canFund) {
      return { ok: false, message: snap.nextUpgrade.blockedReason ?? 'Upgrade requirements not met.' };
    }

    const targetTier = snap.nextUpgrade.targetTier;
    const spec = FOB_UPGRADE_SPECS[targetTier];
    roster.adjustCash(character.slotId, -spec.cashCostUsd);
    shards.setFobTier(character.shardMode, character.pmcFaction, targetTier, character.callsign);

    if (spec.upgradesSecureContainerTo3x3) {
      roster.upgradeSecureContainerTier(character.slotId, '3x3');
    }

    return {
      ok: true,
      newTier: targetTier,
      message: `${spec.name} constructed! ${spec.upgradesSecureContainerTo3x3 ? 'Secure Container upgraded to 3x3.' : ''}`,
    };
  }

  public purchaseTraderOffer(
    offerId: string,
    character: OpenWorldCharacter,
    roster: CharacterRoster,
    shards: ShardStore,
    options?: { blackMarketDiscount?: boolean },
  ): { ok: boolean; message: string; equippedPlateId?: string } {
    const offer = FOB_TRADER_OFFERS.find((o) => o.offerId === offerId);
    if (!offer) return { ok: false, message: 'Unknown Quartermaster item.' };

    const snap = this.getFobTerminalSnapshot(character, shards, options);
    const evalOffer = snap.offers.find((o) => o.offerId === offerId);
    if (!evalOffer) return { ok: false, message: 'Offer unavailable.' };
    if (evalOffer.lockedReason) {
      return { ok: false, message: evalOffer.lockedReason };
    }

    const freshChar = roster.getCharacter(character.slotId);
    if (!freshChar || !freshChar.tacticalInventory) {
      return { ok: false, message: 'Operator tactical inventory unavailable.' };
    }

    const inv = freshChar.tacticalInventory;

    if (offer.armorPlateId) {
      inv.armorPlateId = offer.armorPlateId;
      roster.adjustCash(character.slotId, -evalOffer.priceUsd);
      roster.updateTacticalInventory(character.slotId, inv);
      const key = `${character.shardMode}:${character.pmcFaction}:${offer.offerId}`;
      this.purchasedCounts.set(key, (this.purchasedCounts.get(key) ?? 0) + 1);
      shards.recordDiscreteTransition(
        character.shardMode,
        'trader_purchase',
        `${character.callsign} purchased ${offer.name} ($${evalOffer.priceUsd.toLocaleString()})`,
      );
      return {
        ok: true,
        equippedPlateId: offer.armorPlateId,
        message: `Equipped ${offer.name} (-$${evalOffer.priceUsd.toLocaleString()})`,
      };
    }

    const item = offer.createItem();
    if (!item) return { ok: false, message: 'Failed to issue item.' };

    let placed = false;
    if (item.kind === 'chest_rig' && !inv.chestRig) {
      inv.chestRig = item;
      placed = true;
    } else if (item.kind === 'backpack' && !inv.backpack) {
      inv.backpack = item;
      placed = true;
    } else {
      placed = stowItemIntoOperatorInventory(inv, item);
      if (!placed && item.kind === 'chest_rig') {
        // Swap into Chest Rig slot if operator wants an upgrade (preserve contents into backpack if possible)
        inv.chestRig = item;
        placed = true;
      } else if (!placed && item.kind === 'backpack') {
        // Transfer existing backpack contents into upgraded backpack if larger
        if (inv.backpack) {
          for (const p of inv.backpack.grid.items) {
            item.grid.items.push(p);
          }
        }
        inv.backpack = item;
        placed = true;
      }
    }

    if (!placed) {
      return {
        ok: false,
        message: `No Tetris grid space in Rig, Belt, or Backpack for ${offer.shortLabel}. Free up space or equip a larger backpack.`,
      };
    }

    roster.adjustCash(character.slotId, -evalOffer.priceUsd);
    roster.updateTacticalInventory(character.slotId, inv);
    const key = `${character.shardMode}:${character.pmcFaction}:${offer.offerId}`;
    this.purchasedCounts.set(key, (this.purchasedCounts.get(key) ?? 0) + 1);
    shards.recordDiscreteTransition(
      character.shardMode,
      'trader_purchase',
      `${character.callsign} bought ${offer.name} ($${evalOffer.priceUsd.toLocaleString()})`,
    );

    return {
      ok: true,
      message: `Issued ${offer.name} (-$${evalOffer.priceUsd.toLocaleString()})`,
    };
  }
}

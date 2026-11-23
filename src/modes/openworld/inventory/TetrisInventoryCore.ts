import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  BASE_CALIBERS,
  BaseCaliberId,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../../../../data/calibers';
import { resolveWeaponProfile } from '../../../../bodycam-sdk/weaponProfiles';
import type { PmcFactionId, SecureContainerTier } from '../types';
import {
  AmmoStackItem,
  BackpackItem,
  BeltAllowedKind,
  ChestRigItem,
  CorpseTacticalLootSnapshot,
  EquippedWeaponSlotState,
  GenericLootItem,
  GrenadeItem,
  GridContainer,
  ItemSourceLocator,
  MagazineClass,
  MagazineItem,
  MedicalItem,
  OperatorTacticalInventory,
  PlacedGridItem,
  QuickReloadCandidate,
  TacticalItem,
} from './TetrisInventoryTypes';

let _uidSeq = 1;
export function nextTacticalItemId(prefix: string): string {
  _uidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_uidSeq.toString(36)}`;
}

// ============================================================================
// GEAR, MAGAZINE & AMMO TEMPLATES
// ============================================================================

export interface ChestRigTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly rifleMagSlots: number;
  readonly pistolMagSlots: number;
  readonly generalWidth: number;
  readonly generalHeight: number;
  readonly itemWidth: number;
  readonly itemHeight: number;
  readonly valueUsd: number;
  readonly weightKg: number;
  readonly requiredFobTier: 1 | 2 | 3;
}

export const CHEST_RIG_TEMPLATES: readonly ChestRigTemplate[] = [
  {
    templateId: 'rig_mk4_micro',
    name: 'Mk4 Micro Chest Rig',
    shortLabel: 'Mk4 Rig',
    rifleMagSlots: 3,
    pistolMagSlots: 2,
    generalWidth: 4,
    generalHeight: 2,
    itemWidth: 3,
    itemHeight: 2,
    valueUsd: 950,
    weightKg: 0.9,
    requiredFobTier: 1,
  },
  {
    templateId: 'rig_smersh_assault',
    name: 'Smersh Assault Harness',
    shortLabel: 'Smersh Rig',
    rifleMagSlots: 4,
    pistolMagSlots: 2,
    generalWidth: 4,
    generalHeight: 3,
    itemWidth: 3,
    itemHeight: 3,
    valueUsd: 1850,
    weightKg: 1.4,
    requiredFobTier: 2,
  },
  {
    templateId: 'rig_avs_breacher',
    name: 'AVS Heavy Breacher Rig',
    shortLabel: 'AVS Heavy',
    rifleMagSlots: 6,
    pistolMagSlots: 4,
    generalWidth: 5,
    generalHeight: 3,
    itemWidth: 4,
    itemHeight: 3,
    valueUsd: 3400,
    weightKg: 2.1,
    requiredFobTier: 3,
  },
] as const;

export interface BackpackTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly itemWidth: number;
  readonly itemHeight: number;
  readonly valueUsd: number;
  readonly weightKg: number;
  readonly requiredFobTier: 1 | 2 | 3;
}

export const BACKPACK_TEMPLATES: readonly BackpackTemplate[] = [
  {
    templateId: 'pack_assault_20l',
    name: '20L Patrol Assault Pack',
    shortLabel: 'Assault 20L',
    gridWidth: 4,
    gridHeight: 5,
    itemWidth: 3,
    itemHeight: 4,
    valueUsd: 850,
    weightKg: 1.2,
    requiredFobTier: 1,
  },
  {
    templateId: 'pack_rucksack_35l',
    name: '35L Highland Field Rucksack',
    shortLabel: 'Field 35L',
    gridWidth: 5,
    gridHeight: 6,
    itemWidth: 4,
    itemHeight: 4,
    valueUsd: 1950,
    weightKg: 1.9,
    requiredFobTier: 2,
  },
  {
    templateId: 'pack_logistics_55l',
    name: '55L Heavy Logistics Pack',
    shortLabel: 'Heavy 55L',
    gridWidth: 6,
    gridHeight: 7,
    itemWidth: 4,
    itemHeight: 5,
    valueUsd: 3600,
    weightKg: 2.6,
    requiredFobTier: 3,
  },
] as const;

export interface MagazineTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly magClass: MagazineClass;
  readonly baseCaliber: BaseCaliberId;
  readonly capacity: number;
  readonly width: number;
  readonly height: number;
  readonly valueUsd: number;
  readonly weightKg: number;
}

export const MAGAZINE_TEMPLATES: readonly MagazineTemplate[] = [
  {
    templateId: 'mag_556_30',
    name: 'STANAG 5.56x45 30rd Mag',
    shortLabel: '5.56 30rd',
    magClass: 'rifle',
    baseCaliber: '5.56x45',
    capacity: 30,
    width: 1,
    height: 2,
    valueUsd: 160,
    weightKg: 0.25,
  },
  {
    templateId: 'mag_545_30',
    name: 'AK-74 5.45x39 30rd Mag',
    shortLabel: '5.45 30rd',
    magClass: 'rifle',
    baseCaliber: '5.45x39',
    capacity: 30,
    width: 1,
    height: 2,
    valueUsd: 150,
    weightKg: 0.24,
  },
  {
    templateId: 'mag_762x39_30',
    name: 'AKM 7.62x39 30rd Steel Mag',
    shortLabel: '7.62 30rd',
    magClass: 'rifle',
    baseCaliber: '7.62x39',
    capacity: 30,
    width: 1,
    height: 2,
    valueUsd: 170,
    weightKg: 0.34,
  },
  {
    templateId: 'mag_762x51_20',
    name: 'NATO 7.62x51 20rd DMR Mag',
    shortLabel: '7.62N 20rd',
    magClass: 'rifle',
    baseCaliber: '7.62x51',
    capacity: 20,
    width: 1,
    height: 2,
    valueUsd: 240,
    weightKg: 0.31,
  },
  {
    templateId: 'mag_762x54r_10',
    name: 'SVD 7.62x54R 10rd Mag',
    shortLabel: '54R 10rd',
    magClass: 'rifle',
    baseCaliber: '7.62x54r',
    capacity: 10,
    width: 1,
    height: 2,
    valueUsd: 220,
    weightKg: 0.26,
  },
  {
    templateId: 'mag_9x19_30_smg',
    name: 'MP5 9x19 30rd Curved Mag',
    shortLabel: '9x19 30rd',
    magClass: 'rifle',
    baseCaliber: '9x19',
    capacity: 30,
    width: 1,
    height: 2,
    valueUsd: 140,
    weightKg: 0.22,
  },
  {
    templateId: 'mag_9x19_17_pistol',
    name: '9x19 17rd Pistol Mag',
    shortLabel: '9x19 17rd',
    magClass: 'pistol',
    baseCaliber: '9x19',
    capacity: 17,
    width: 1,
    height: 1,
    valueUsd: 95,
    weightKg: 0.14,
  },
  {
    templateId: 'mag_9x18_8_pistol',
    name: 'PM 9x18 8rd Pistol Mag',
    shortLabel: '9x18 8rd',
    magClass: 'pistol',
    baseCaliber: '9x18',
    capacity: 8,
    width: 1,
    height: 1,
    valueUsd: 75,
    weightKg: 0.11,
  },
  {
    templateId: 'mag_12ga_8_caddy',
    name: '12ga 8-Shell Tactical Caddy',
    shortLabel: '12ga 8rd',
    magClass: 'rifle',
    baseCaliber: '12ga',
    capacity: 8,
    width: 1,
    height: 2,
    valueUsd: 130,
    weightKg: 0.35,
  },
] as const;

export const BELT_ALLOWED_KINDS: ReadonlySet<BeltAllowedKind> = new Set([
  'grenade',
  'medical',
  'magazine',
]);

// ============================================================================
// ITEM FACTORY HELPERS
// ============================================================================

export function createGridContainer(
  id: string,
  label: string,
  width: number,
  height: number,
): GridContainer {
  return { id, label, width, height, items: [] };
}

export function createChestRigItem(templateId = 'rig_mk4_micro'): ChestRigItem {
  const tpl = CHEST_RIG_TEMPLATES.find((r) => r.templateId === templateId) ?? CHEST_RIG_TEMPLATES[0];
  return {
    instanceId: nextTacticalItemId('rig'),
    templateId: tpl.templateId,
    name: tpl.name,
    shortLabel: tpl.shortLabel,
    kind: 'chest_rig',
    width: tpl.itemWidth,
    height: tpl.itemHeight,
    valueUsd: tpl.valueUsd,
    weightKg: tpl.weightKg,
    rifleMagCapacity: tpl.rifleMagSlots,
    pistolMagCapacity: tpl.pistolMagSlots,
    rifleMagSlots: Array.from({ length: tpl.rifleMagSlots }, () => null),
    pistolMagSlots: Array.from({ length: tpl.pistolMagSlots }, () => null),
    generalGrid: createGridContainer(
      nextTacticalItemId('rig_grid'),
      `${tpl.shortLabel} Pouches`,
      tpl.generalWidth,
      tpl.generalHeight,
    ),
  };
}

export function createBackpackItem(templateId = 'pack_assault_20l'): BackpackItem {
  const tpl = BACKPACK_TEMPLATES.find((b) => b.templateId === templateId) ?? BACKPACK_TEMPLATES[0];
  return {
    instanceId: nextTacticalItemId('pack'),
    templateId: tpl.templateId,
    name: tpl.name,
    shortLabel: tpl.shortLabel,
    kind: 'backpack',
    width: tpl.itemWidth,
    height: tpl.itemHeight,
    valueUsd: tpl.valueUsd,
    weightKg: tpl.weightKg,
    grid: createGridContainer(
      nextTacticalItemId('pack_grid'),
      tpl.name,
      tpl.gridWidth,
      tpl.gridHeight,
    ),
  };
}

export function getWeaponMagClass(weaponId: string): MagazineClass {
  const prof = resolveWeaponProfile(weaponId);
  return prof.category === 'pistols' || prof.category === 'revolvers' ? 'pistol' : 'rifle';
}

export function getWeaponBaseCaliber(weaponId: string): BaseCaliberId {
  const prof = resolveWeaponProfile(weaponId);
  return resolveBaseCaliberId(prof.defaultCaliberId);
}

export function resolveMagazineTemplateForWeapon(weaponId: string): MagazineTemplate {
  const prof = resolveWeaponProfile(weaponId);
  const magClass = getWeaponMagClass(weaponId);
  const baseCal = getWeaponBaseCaliber(weaponId);
  const exact = MAGAZINE_TEMPLATES.find(
    (t) => t.baseCaliber === baseCal && t.magClass === magClass,
  );
  if (exact) return exact;
  const calOnly = MAGAZINE_TEMPLATES.find((t) => t.baseCaliber === baseCal);
  if (calOnly) return calOnly;
  return {
    templateId: `mag_${baseCal}_${magClass}`,
    name: `${BASE_CALIBERS[baseCal]?.shortLabel ?? baseCal} ${prof.magCapacity}rd Mag`,
    shortLabel: `${BASE_CALIBERS[baseCal]?.shortLabel ?? baseCal} ${prof.magCapacity}rd`,
    magClass,
    baseCaliber: baseCal,
    capacity: Math.max(4, prof.magCapacity),
    width: 1,
    height: magClass === 'pistol' ? 1 : 2,
    valueUsd: 150,
    weightKg: magClass === 'pistol' ? 0.14 : 0.25,
  };
}

export function createMagazineItem(
  templateOrWeaponId: string,
  fillRounds?: readonly AmmoVariantId[],
): MagazineItem {
  const byTpl = MAGAZINE_TEMPLATES.find((m) => m.templateId === templateOrWeaponId);
  const tpl = byTpl ?? resolveMagazineTemplateForWeapon(templateOrWeaponId);
  const rounds: AmmoVariantId[] = [];
  if (fillRounds) {
    for (let i = 0; i < Math.min(tpl.capacity, fillRounds.length); i++) {
      const vId = fillRounds[i];
      if (AMMO_VARIANTS[vId]?.caliberId === tpl.baseCaliber) {
        rounds.push(vId);
      }
    }
  }
  return {
    instanceId: nextTacticalItemId('mag'),
    templateId: tpl.templateId,
    name: tpl.name,
    shortLabel: tpl.shortLabel,
    kind: 'magazine',
    width: tpl.width,
    height: tpl.height,
    valueUsd: tpl.valueUsd,
    weightKg: tpl.weightKg,
    magClass: tpl.magClass,
    baseCaliber: tpl.baseCaliber,
    capacity: tpl.capacity,
    rounds,
  };
}

export function createLoadedMagazineForWeapon(
  weaponId: string,
  pattern?: readonly { variantId: AmmoVariantId; count: number }[],
): MagazineItem {
  const tpl = resolveMagazineTemplateForWeapon(weaponId);
  const rounds: AmmoVariantId[] = [];
  if (pattern && pattern.length > 0) {
    for (const seg of pattern) {
      if (AMMO_VARIANTS[seg.variantId]?.caliberId !== tpl.baseCaliber) continue;
      for (let i = 0; i < seg.count && rounds.length < tpl.capacity; i++) {
        rounds.push(seg.variantId);
      }
    }
  } else {
    const def = getDefaultAmmoVariant(tpl.baseCaliber).id;
    for (let i = 0; i < tpl.capacity; i++) rounds.push(def);
  }
  return createMagazineItem(tpl.templateId, rounds);
}

export function createAmmoStackItem(
  variantId: AmmoVariantId,
  count: number,
  maxStack = 60,
): AmmoStackItem {
  const def = AMMO_VARIANTS[variantId] ?? AMMO_VARIANTS['556x45_m855'];
  const cal = BASE_CALIBERS[def.caliberId];
  const cleanCount = Math.max(1, Math.min(maxStack, Math.round(count)));
  const unitPrice = def.penetrationRating >= 45 ? 16 : def.penetrationRating >= 35 ? 11 : 7;
  return {
    instanceId: nextTacticalItemId('ammo'),
    templateId: `ammo_${def.id}`,
    name: `${cal.shortLabel} ${def.shortName} Box`,
    shortLabel: def.shortName,
    kind: 'ammo_stack',
    width: 1,
    height: 1,
    valueUsd: unitPrice * cleanCount,
    weightKg: Number(((def.bulletMassGrams * 1.9 * cleanCount) / 1000).toFixed(2)),
    baseCaliber: def.caliberId,
    variantId: def.id,
    count: cleanCount,
    maxStack,
  };
}

export function createMedicalItem(
  variant: 'bandage' | 'ifak' | 'splint_stim',
): MedicalItem {
  if (variant === 'ifak') {
    return {
      instanceId: nextTacticalItemId('med'),
      templateId: 'med_ifak_surgical',
      name: 'IFAK Surgical Trauma Kit',
      shortLabel: 'IFAK',
      kind: 'medical',
      width: 1,
      height: 2,
      valueUsd: 950,
      weightKg: 0.45,
      healHp: 65,
      stopsBleed: true,
      clearsSprintSlow: true,
      usesRemaining: 2,
      maxUses: 2,
    };
  }
  if (variant === 'splint_stim') {
    return {
      instanceId: nextTacticalItemId('med'),
      templateId: 'med_morphine_splint',
      name: 'Combat Splint & Autoinjector',
      shortLabel: 'Splint',
      kind: 'medical',
      width: 1,
      height: 1,
      valueUsd: 520,
      weightKg: 0.18,
      healHp: 25,
      stopsBleed: false,
      clearsSprintSlow: true,
      usesRemaining: 1,
      maxUses: 1,
    };
  }
  return {
    instanceId: nextTacticalItemId('med'),
    templateId: 'med_hemostatic_bandage',
    name: 'Hemostatic Field Bandage',
    shortLabel: 'Bandage',
    kind: 'medical',
    width: 1,
    height: 1,
    valueUsd: 240,
    weightKg: 0.12,
    healHp: 20,
    stopsBleed: true,
    clearsSprintSlow: false,
    usesRemaining: 2,
    maxUses: 2,
  };
}

export function createGrenadeItem(equipmentId = 'm67_frag'): GrenadeItem {
  return {
    instanceId: nextTacticalItemId('ord'),
    templateId: `ord_${equipmentId}`,
    name: equipmentId === 'm84_flash' ? 'M84 Stun Grenade' : 'M67 Fragmentation Grenade',
    shortLabel: equipmentId === 'm84_flash' ? 'M84 Flash' : 'M67 Frag',
    kind: 'grenade',
    width: 1,
    height: 1,
    valueUsd: 380,
    weightKg: 0.4,
    equipmentId,
    count: 1,
  };
}

export function createGenericLootItem(
  templateId: string,
  name: string,
  shortLabel: string,
  kind: 'intel' | 'key' | 'barter',
  width: number,
  height: number,
  valueUsd: number,
  quantity = 1,
): GenericLootItem {
  return {
    instanceId: nextTacticalItemId(kind),
    templateId,
    name,
    shortLabel,
    kind,
    width,
    height,
    valueUsd,
    weightKg: 0.25 * width * height,
    quantity,
  };
}

// ============================================================================
// DEEP CLONE HELPERS
// ============================================================================

export function cloneGridContainer(c: GridContainer): GridContainer {
  return {
    id: c.id,
    label: c.label,
    width: c.width,
    height: c.height,
    items: c.items.map((p) => ({
      x: p.x,
      y: p.y,
      rotated: p.rotated,
      item: cloneTacticalItem(p.item),
    })),
  };
}

export function cloneTacticalItem<T extends TacticalItem>(item: T): T {
  if (item.kind === 'magazine') {
    return { ...item, rounds: [...item.rounds] } as T;
  }
  if (item.kind === 'chest_rig') {
    return {
      ...item,
      rifleMagSlots: item.rifleMagSlots.map((m) => (m ? cloneTacticalItem(m) : null)),
      pistolMagSlots: item.pistolMagSlots.map((m) => (m ? cloneTacticalItem(m) : null)),
      generalGrid: cloneGridContainer(item.generalGrid),
    } as T;
  }
  if (item.kind === 'backpack') {
    return {
      ...item,
      grid: cloneGridContainer(item.grid),
    } as T;
  }
  return { ...item };
}

export function cloneWeaponSlot(slot: EquippedWeaponSlotState): EquippedWeaponSlotState {
  return {
    weaponId: slot.weaponId,
    chamberedRound: slot.chamberedRound,
    loadedMag: slot.loadedMag ? cloneTacticalItem(slot.loadedMag) : null,
  };
}

export function cloneTacticalInventory(inv: OperatorTacticalInventory): OperatorTacticalInventory {
  return {
    primary: cloneWeaponSlot(inv.primary),
    secondary: cloneWeaponSlot(inv.secondary),
    armorPlateId: inv.armorPlateId,
    beltSlots: inv.beltSlots.map((it) => (it ? cloneTacticalItem(it) : null)),
    chestRig: inv.chestRig ? cloneTacticalItem(inv.chestRig) : null,
    backpack: inv.backpack ? cloneTacticalItem(inv.backpack) : null,
    secureContainer: cloneGridContainer(inv.secureContainer),
  };
}

export function cloneCorpseLootSnapshot(
  snap: CorpseTacticalLootSnapshot,
): CorpseTacticalLootSnapshot {
  return {
    primaryWeaponId: snap.primaryWeaponId,
    secondaryWeaponId: snap.secondaryWeaponId,
    armorPlateId: snap.armorPlateId,
    armorName: snap.armorName,
    chestRig: snap.chestRig ? cloneTacticalItem(snap.chestRig) : null,
    backpack: snap.backpack ? cloneTacticalItem(snap.backpack) : null,
    beltSlots: snap.beltSlots.map((it) => (it ? cloneTacticalItem(it) : null)),
    looseGrid: cloneGridContainer(snap.looseGrid),
  };
}

// ============================================================================
// TETRIS GRID SPATIAL SOLVER (Collision, Rotation, Auto-Fit)
// ============================================================================

export function getEffectiveSize(
  item: Pick<TacticalItem, 'width' | 'height'>,
  rotated: boolean,
): { w: number; h: number } {
  return rotated ? { w: item.height, h: item.width } : { w: item.width, h: item.height };
}

export function canPlaceInGrid(
  grid: GridContainer,
  item: Pick<TacticalItem, 'width' | 'height'>,
  x: number,
  y: number,
  rotated: boolean,
  ignoreInstanceId?: string,
): boolean {
  const { w, h } = getEffectiveSize(item, rotated);
  if (x < 0 || y < 0 || x + w > grid.width || y + h > grid.height) return false;

  for (let i = 0; i < grid.items.length; i++) {
    const placed = grid.items[i];
    if (ignoreInstanceId && placed.item.instanceId === ignoreInstanceId) continue;
    const other = getEffectiveSize(placed.item, placed.rotated);
    const overlaps =
      x < placed.x + other.w &&
      x + w > placed.x &&
      y < placed.y + other.h &&
      y + h > placed.y;
    if (overlaps) return false;
  }
  return true;
}

export function findFirstGridFit(
  grid: GridContainer,
  item: Pick<TacticalItem, 'width' | 'height'>,
  allowRotate = true,
  ignoreInstanceId?: string,
): { x: number; y: number; rotated: boolean } | null {
  const orientations: boolean[] =
    allowRotate && item.width !== item.height ? [false, true] : [false];
  for (const rotated of orientations) {
    const { w, h } = getEffectiveSize(item, rotated);
    for (let y = 0; y <= grid.height - h; y++) {
      for (let x = 0; x <= grid.width - w; x++) {
        if (canPlaceInGrid(grid, item, x, y, rotated, ignoreInstanceId)) {
          return { x, y, rotated };
        }
      }
    }
  }
  return null;
}

export function placeItemInGrid(
  grid: GridContainer,
  item: TacticalItem,
  x: number,
  y: number,
  rotated = false,
): boolean {
  if (!canPlaceInGrid(grid, item, x, y, rotated)) return false;
  grid.items.push({ item, x, y, rotated });
  return true;
}

export function autoPlaceItemInGrid(
  grid: GridContainer,
  item: TacticalItem,
  allowRotate = true,
): boolean {
  // Merge identical ammo stacks first if space exists in an existing stack
  if (item.kind === 'ammo_stack') {
    for (const placed of grid.items) {
      if (
        placed.item.kind === 'ammo_stack' &&
        placed.item.variantId === item.variantId &&
        placed.item.count < placed.item.maxStack
      ) {
        const space = placed.item.maxStack - placed.item.count;
        const add = Math.min(space, item.count);
        placed.item.count += add;
        item.count -= add;
        if (item.count <= 0) return true;
      }
    }
  }
  const fit = findFirstGridFit(grid, item, allowRotate);
  if (!fit) return false;
  grid.items.push({ item, x: fit.x, y: fit.y, rotated: fit.rotated });
  return true;
}

export function removeItemFromGrid(grid: GridContainer, instanceId: string): PlacedGridItem | null {
  const idx = grid.items.findIndex((p) => p.item.instanceId === instanceId);
  if (idx < 0) return null;
  const [removed] = grid.items.splice(idx, 1);
  return removed;
}

export function moveItemWithinGrid(
  grid: GridContainer,
  instanceId: string,
  targetX: number,
  targetY: number,
  rotated: boolean,
): boolean {
  const placed = grid.items.find((p) => p.item.instanceId === instanceId);
  if (!placed) return false;
  if (!canPlaceInGrid(grid, placed.item, targetX, targetY, rotated, instanceId)) return false;
  placed.x = targetX;
  placed.y = targetY;
  placed.rotated = rotated;
  return true;
}

export function isItemAllowedInBelt(item: TacticalItem): boolean {
  return BELT_ALLOWED_KINDS.has(item.kind as BeltAllowedKind);
}

export function isItemAllowedInRigMagSlot(
  item: TacticalItem,
  slotType: 'rifle' | 'pistol',
): item is MagazineItem {
  return item.kind === 'magazine' && item.magClass === slotType;
}

// ============================================================================
// MIXED SAME-CALIBER LIFO MAGAZINE PACKING & UNPACKING
// ============================================================================

export interface PackAmmoResult {
  ok: boolean;
  loadedCount: number;
  remainingStackCount: number;
  error?: string;
}

/**
 * Loads rounds from a loose ammo stack onto the TOP of a magazine's LIFO stack.
 * Enforces strict base-caliber compatibility while allowing ANY variants of the same caliber
 * to be mixed in arbitrary player-chosen order (e.g. FMJ bottom + AP middle + OTM/Subsonic top).
 */
export function loadAmmoStackIntoMagazine(
  mag: MagazineItem,
  stack: AmmoStackItem,
  requestedCount = stack.count,
): PackAmmoResult {
  if (stack.baseCaliber !== mag.baseCaliber) {
    return {
      ok: false,
      loadedCount: 0,
      remainingStackCount: stack.count,
      error: `Caliber mismatch: ${BASE_CALIBERS[stack.baseCaliber].shortLabel} cannot load into ${BASE_CALIBERS[mag.baseCaliber].shortLabel} magazine.`,
    };
  }
  const space = Math.max(0, mag.capacity - mag.rounds.length);
  if (space <= 0) {
    return {
      ok: false,
      loadedCount: 0,
      remainingStackCount: stack.count,
      error: 'Magazine is already full.',
    };
  }
  const toLoad = Math.max(0, Math.min(space, stack.count, Math.floor(requestedCount)));
  if (toLoad <= 0) {
    return { ok: false, loadedCount: 0, remainingStackCount: stack.count, error: 'No rounds to load.' };
  }
  for (let i = 0; i < toLoad; i++) {
    mag.rounds.push(stack.variantId);
  }
  stack.count -= toLoad;
  return {
    ok: true,
    loadedCount: toLoad,
    remainingStackCount: stack.count,
  };
}

/**
 * Pops `count` rounds from the TOP of a magazine's LIFO stack and returns grouped `AmmoStackItem`s.
 */
export function unloadTopRoundsFromMagazine(
  mag: MagazineItem,
  count = 1,
): AmmoStackItem[] {
  const take = Math.max(0, Math.min(mag.rounds.length, Math.floor(count)));
  if (take <= 0) return [];
  const countsByVariant = new Map<AmmoVariantId, number>();
  for (let i = 0; i < take; i++) {
    const popped = mag.rounds.pop();
    if (!popped) break;
    countsByVariant.set(popped, (countsByVariant.get(popped) ?? 0) + 1);
  }
  const out: AmmoStackItem[] = [];
  for (const [vId, qty] of countsByVariant.entries()) {
    out.push(createAmmoStackItem(vId, qty));
  }
  return out;
}

export interface MagazineStackRun {
  variantId: AmmoVariantId;
  shortName: string;
  count: number;
  coreType: AmmoVariantDef['coreType'];
  penetrationRating: number;
}

/**
 * Compresses the magazine LIFO stack into readable runs ordered TOP-TO-BOTTOM (next-to-fire first)
 * for the Magazine Stack Inspector UI.
 */
export function summarizeMagazineRunsTopFirst(mag: MagazineItem): MagazineStackRun[] {
  const runs: MagazineStackRun[] = [];
  for (let i = mag.rounds.length - 1; i >= 0; i--) {
    const vId = mag.rounds[i];
    const last = runs[runs.length - 1];
    if (last && last.variantId === vId) {
      last.count += 1;
    } else {
      const def = AMMO_VARIANTS[vId] ?? AMMO_VARIANTS['556x45_m855'];
      runs.push({
        variantId: vId,
        shortName: def.shortName,
        count: 1,
        coreType: def.coreType,
        penetrationRating: def.penetrationRating,
      });
    }
  }
  return runs;
}

// ============================================================================
// WEAPON FIRING, CHAMBERING & CHEST-RIG vs DRAG-DROP RELOAD LOGIC
// ============================================================================

export function isMagazineCompatibleWithWeapon(mag: MagazineItem, weaponId: string): boolean {
  if (!weaponId || weaponId === 'unarmed') return false;
  const cal = getWeaponBaseCaliber(weaponId);
  const cls = getWeaponMagClass(weaponId);
  return mag.baseCaliber === cal && mag.magClass === cls;
}

export function getWeaponSlotByWeaponId(
  inv: OperatorTacticalInventory,
  weaponId: string,
): 'primary' | 'secondary' | null {
  if (inv.primary.weaponId === weaponId) return 'primary';
  if (inv.secondary.weaponId === weaponId) return 'secondary';
  return null;
}

export function getLoadedAmmoCount(slot: EquippedWeaponSlotState): number {
  return (slot.chamberedRound ? 1 : 0) + (slot.loadedMag?.rounds.length ?? 0);
}

export function peekNextRoundVariant(slot: EquippedWeaponSlotState): AmmoVariantDef | null {
  const nextId =
    slot.chamberedRound ??
    (slot.loadedMag && slot.loadedMag.rounds.length > 0
      ? slot.loadedMag.rounds[slot.loadedMag.rounds.length - 1]
      : null);
  if (!nextId) return null;
  return AMMO_VARIANTS[nextId] ?? null;
}

/**
 * Fires 1 round from the weapon slot: shoots `chamberedRound` (or pops top of `loadedMag` if unchambered),
 * then automatically strips the next top round from `loadedMag.rounds` into `chamberedRound`.
 * Returns the exact `AmmoVariantDef` fired so BallisticsSolver uses true mixed-ammo stats per shot.
 */
export function fireRoundFromWeaponSlot(slot: EquippedWeaponSlotState): AmmoVariantDef | null {
  let firedId: AmmoVariantId | null = null;
  if (slot.chamberedRound) {
    firedId = slot.chamberedRound;
    slot.chamberedRound =
      slot.loadedMag && slot.loadedMag.rounds.length > 0
        ? (slot.loadedMag.rounds.pop() ?? null)
        : null;
  } else if (slot.loadedMag && slot.loadedMag.rounds.length > 0) {
    firedId = slot.loadedMag.rounds.pop() ?? null;
    slot.chamberedRound =
      slot.loadedMag.rounds.length > 0 ? (slot.loadedMag.rounds.pop() ?? null) : null;
  }
  if (!firedId) return null;
  return AMMO_VARIANTS[firedId] ?? null;
}

/**
 * Finds the best loaded compatible magazine eligible for `[R]` Quick Reload.
 * Strictly requires magazines seated in the equipped **Chest Rig** (rifle/pistol mag slots or rig pouches)
 * OR **Belt** mag slots. Never pulls directly from Backpack or Secure Container for `[R]`.
 */
export function findQuickReloadMagazine(
  inv: OperatorTacticalInventory,
  weaponId: string,
): QuickReloadCandidate | null {
  if (!weaponId || weaponId === 'unarmed') return null;
  let best: QuickReloadCandidate | null = null;

  const consider = (
    locator: QuickReloadCandidate['locator'],
    mag: MagazineItem | null | undefined,
  ) => {
    if (!mag || mag.rounds.length <= 0) return;
    if (!isMagazineCompatibleWithWeapon(mag, weaponId)) return;
    if (!best || mag.rounds.length > best.magazine.rounds.length) {
      best = { locator, magazine: mag };
    }
  };

  if (inv.chestRig) {
    for (let i = 0; i < inv.chestRig.rifleMagSlots.length; i++) {
      consider({ zone: 'chest_rig_rifle', slotIndex: i }, inv.chestRig.rifleMagSlots[i]);
    }
    for (let i = 0; i < inv.chestRig.pistolMagSlots.length; i++) {
      consider({ zone: 'chest_rig_pistol', slotIndex: i }, inv.chestRig.pistolMagSlots[i]);
    }
    for (const placed of inv.chestRig.generalGrid.items) {
      if (placed.item.kind === 'magazine') {
        consider(
          { zone: 'chest_rig_grid', instanceId: placed.item.instanceId },
          placed.item,
        );
      }
    }
  }

  for (let i = 0; i < inv.beltSlots.length; i++) {
    const it = inv.beltSlots[i];
    if (it && it.kind === 'magazine') {
      consider({ zone: 'belt', slotIndex: i }, it);
    }
  }

  return best;
}

/**
 * Counts total accessible compatible rounds in Chest Rig + Belt (shown as quick-reload reserve on HUD)
 * and total compatible rounds across Backpack + Secure Container.
 */
export function countCompatibleReserveRounds(
  inv: OperatorTacticalInventory,
  weaponId: string,
): { rigAndBeltRounds: number; rigAndBeltMags: number; backpackRounds: number } {
  if (!weaponId || weaponId === 'unarmed') {
    return { rigAndBeltRounds: 0, rigAndBeltMags: 0, backpackRounds: 0 };
  }
  const cal = getWeaponBaseCaliber(weaponId);
  let rigAndBeltRounds = 0;
  let rigAndBeltMags = 0;
  let backpackRounds = 0;

  if (inv.chestRig) {
    for (const m of inv.chestRig.rifleMagSlots) {
      if (m && isMagazineCompatibleWithWeapon(m, weaponId) && m.rounds.length > 0) {
        rigAndBeltRounds += m.rounds.length;
        rigAndBeltMags += 1;
      }
    }
    for (const m of inv.chestRig.pistolMagSlots) {
      if (m && isMagazineCompatibleWithWeapon(m, weaponId) && m.rounds.length > 0) {
        rigAndBeltRounds += m.rounds.length;
        rigAndBeltMags += 1;
      }
    }
    for (const p of inv.chestRig.generalGrid.items) {
      if (p.item.kind === 'magazine' && isMagazineCompatibleWithWeapon(p.item, weaponId) && p.item.rounds.length > 0) {
        rigAndBeltRounds += p.item.rounds.length;
        rigAndBeltMags += 1;
      }
    }
  }
  for (const b of inv.beltSlots) {
    if (b && b.kind === 'magazine' && isMagazineCompatibleWithWeapon(b, weaponId) && b.rounds.length > 0) {
      rigAndBeltRounds += b.rounds.length;
      rigAndBeltMags += 1;
    }
  }
  if (inv.backpack) {
    for (const p of inv.backpack.grid.items) {
      if (p.item.kind === 'magazine' && isMagazineCompatibleWithWeapon(p.item, weaponId)) {
        backpackRounds += p.item.rounds.length;
      } else if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === cal) {
        backpackRounds += p.item.count;
      }
    }
  }
  for (const p of inv.secureContainer.items) {
    if (p.item.kind === 'magazine' && isMagazineCompatibleWithWeapon(p.item, weaponId)) {
      backpackRounds += p.item.rounds.length;
    } else if (p.item.kind === 'ammo_stack' && p.item.baseCaliber === cal) {
      backpackRounds += p.item.count;
    }
  }

  return { rigAndBeltRounds, rigAndBeltMags, backpackRounds };
}

export function extractItemByLocator(
  inv: OperatorTacticalInventory,
  locator: ItemSourceLocator,
  external?: CorpseTacticalLootSnapshot | null,
): TacticalItem | null {
  switch (locator.zone) {
    case 'chest_rig_rifle': {
      if (!inv.chestRig) return null;
      const m = inv.chestRig.rifleMagSlots[locator.slotIndex] ?? null;
      if (m) inv.chestRig.rifleMagSlots[locator.slotIndex] = null;
      return m;
    }
    case 'chest_rig_pistol': {
      if (!inv.chestRig) return null;
      const m = inv.chestRig.pistolMagSlots[locator.slotIndex] ?? null;
      if (m) inv.chestRig.pistolMagSlots[locator.slotIndex] = null;
      return m;
    }
    case 'chest_rig_grid':
      return inv.chestRig ? (removeItemFromGrid(inv.chestRig.generalGrid, locator.instanceId)?.item ?? null) : null;
    case 'belt': {
      const it = inv.beltSlots[locator.slotIndex] ?? null;
      if (it) inv.beltSlots[locator.slotIndex] = null;
      return it;
    }
    case 'backpack_grid':
      return inv.backpack ? (removeItemFromGrid(inv.backpack.grid, locator.instanceId)?.item ?? null) : null;
    case 'secure_grid':
      return removeItemFromGrid(inv.secureContainer, locator.instanceId)?.item ?? null;
    case 'external_grid':
      return external ? (removeItemFromGrid(external.looseGrid, locator.instanceId)?.item ?? null) : null;
    case 'external_backpack_grid':
      return external?.backpack
        ? (removeItemFromGrid(external.backpack.grid, locator.instanceId)?.item ?? null)
        : null;
    case 'external_rig_rifle': {
      if (!external?.chestRig) return null;
      const m = external.chestRig.rifleMagSlots[locator.slotIndex] ?? null;
      if (m) external.chestRig.rifleMagSlots[locator.slotIndex] = null;
      return m;
    }
    case 'external_rig_pistol': {
      if (!external?.chestRig) return null;
      const m = external.chestRig.pistolMagSlots[locator.slotIndex] ?? null;
      if (m) external.chestRig.pistolMagSlots[locator.slotIndex] = null;
      return m;
    }
    case 'external_rig_grid':
      return external?.chestRig
        ? (removeItemFromGrid(external.chestRig.generalGrid, locator.instanceId)?.item ?? null)
        : null;
    case 'external_belt': {
      if (!external) return null;
      const it = external.beltSlots[locator.slotIndex] ?? null;
      if (it) external.beltSlots[locator.slotIndex] = null;
      return it;
    }
  }
}

export function peekItemByLocator(
  inv: OperatorTacticalInventory,
  locator: ItemSourceLocator,
  external?: CorpseTacticalLootSnapshot | null,
): TacticalItem | null {
  switch (locator.zone) {
    case 'chest_rig_rifle':
      return inv.chestRig?.rifleMagSlots[locator.slotIndex] ?? null;
    case 'chest_rig_pistol':
      return inv.chestRig?.pistolMagSlots[locator.slotIndex] ?? null;
    case 'chest_rig_grid':
      return inv.chestRig?.generalGrid.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'belt':
      return inv.beltSlots[locator.slotIndex] ?? null;
    case 'backpack_grid':
      return inv.backpack?.grid.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'secure_grid':
      return inv.secureContainer.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'external_grid':
      return external?.looseGrid.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'external_backpack_grid':
      return external?.backpack?.grid.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'external_rig_rifle':
      return external?.chestRig?.rifleMagSlots[locator.slotIndex] ?? null;
    case 'external_rig_pistol':
      return external?.chestRig?.pistolMagSlots[locator.slotIndex] ?? null;
    case 'external_rig_grid':
      return external?.chestRig?.generalGrid.items.find((p) => p.item.instanceId === locator.instanceId)?.item ?? null;
    case 'external_belt':
      return external?.beltSlots[locator.slotIndex] ?? null;
  }
}

/**
 * Stows a magazine (e.g. swapped out during reload) into the best available operator slot:
 * 1. Matching Chest Rig mag slot
 * 2. Chest Rig general pouches
 * 3. Belt slot
 * 4. Backpack grid
 */
export function stowItemIntoOperatorInventory(
  inv: OperatorTacticalInventory,
  item: TacticalItem,
): boolean {
  if (item.kind === 'magazine' && inv.chestRig) {
    const arr =
      item.magClass === 'rifle' ? inv.chestRig.rifleMagSlots : inv.chestRig.pistolMagSlots;
    const emptyIdx = arr.indexOf(null);
    if (emptyIdx >= 0) {
      arr[emptyIdx] = item;
      return true;
    }
  }
  if (inv.chestRig && autoPlaceItemInGrid(inv.chestRig.generalGrid, item, true)) {
    return true;
  }
  if (isItemAllowedInBelt(item)) {
    const bIdx = inv.beltSlots.indexOf(null);
    if (bIdx >= 0) {
      inv.beltSlots[bIdx] = item;
      return true;
    }
  }
  if (inv.backpack && autoPlaceItemInGrid(inv.backpack.grid, item, true)) {
    return true;
  }
  return false;
}

export interface SwapMagazineResult {
  ok: boolean;
  error?: string;
  insertedMag?: MagazineItem;
  ejectedMag?: MagazineItem | null;
  ejectedStowed: boolean;
}

/**
 * Swaps a specific magazine (from Chest Rig, Belt, Backpack, Secure Container, or Loot Crate)
 * into a weapon slot. Chambers a round if the chamber was empty.
 */
export function swapMagazineIntoWeapon(
  inv: OperatorTacticalInventory,
  weaponSlotKey: 'primary' | 'secondary',
  sourceLocator: ItemSourceLocator,
  external?: CorpseTacticalLootSnapshot | null,
): SwapMagazineResult {
  const slot = inv[weaponSlotKey];
  if (!slot.weaponId || slot.weaponId === 'unarmed') {
    return { ok: false, error: 'No weapon equipped in that slot.', ejectedStowed: false };
  }
  const peeked = peekItemByLocator(inv, sourceLocator, external);
  if (!peeked || peeked.kind !== 'magazine') {
    return { ok: false, error: 'Selected item is not a magazine.', ejectedStowed: false };
  }
  if (!isMagazineCompatibleWithWeapon(peeked, slot.weaponId)) {
    return {
      ok: false,
      error: `Incompatible magazine (${peeked.shortLabel}) for ${resolveWeaponProfile(slot.weaponId).name}.`,
      ejectedStowed: false,
    };
  }
  if (peeked.rounds.length <= 0) {
    return {
      ok: false,
      error: 'Cannot reload an empty magazine — load rounds into it first.',
      ejectedStowed: false,
    };
  }

  const extracted = extractItemByLocator(inv, sourceLocator, external);
  if (!extracted || extracted.kind !== 'magazine') {
    return { ok: false, error: 'Failed to retrieve magazine.', ejectedStowed: false };
  }

  const previousMag = slot.loadedMag;
  slot.loadedMag = extracted;
  if (!slot.chamberedRound && extracted.rounds.length > 0) {
    slot.chamberedRound = extracted.rounds.pop() ?? null;
  }

  let ejectedStowed = true;
  if (previousMag) {
    ejectedStowed = stowItemIntoOperatorInventory(inv, previousMag);
  }

  return {
    ok: true,
    insertedMag: extracted,
    ejectedMag: previousMag,
    ejectedStowed,
  };
}

export function countGrenadesInInventory(inv: OperatorTacticalInventory): number {
  let count = 0;
  for (const it of inv.beltSlots) {
    if (it?.kind === 'grenade') count += it.count;
  }
  if (inv.chestRig) {
    for (const p of inv.chestRig.generalGrid.items) {
      if (p.item.kind === 'grenade') count += p.item.count;
    }
  }
  return count;
}

export function consumeOneGrenadeFromInventory(inv: OperatorTacticalInventory): boolean {
  for (let i = 0; i < inv.beltSlots.length; i++) {
    const it = inv.beltSlots[i];
    if (it?.kind === 'grenade') {
      if (it.count > 1) it.count -= 1;
      else inv.beltSlots[i] = null;
      return true;
    }
  }
  if (inv.chestRig) {
    for (const p of inv.chestRig.generalGrid.items) {
      if (p.item.kind === 'grenade') {
        if (p.item.count > 1) p.item.count -= 1;
        else removeItemFromGrid(inv.chestRig.generalGrid, p.item.instanceId);
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// STARTER & CORPSE SNAPSHOT BUILDERS
// ============================================================================

export function buildStarterTacticalInventory(
  faction: PmcFactionId,
  primaryWeaponId: string | null,
  secondaryWeaponId: string | null,
  armorPlateId: string | null,
  secureTier: SecureContainerTier = '2x2',
): OperatorTacticalInventory {
  const secDim = secureTier === '3x3' ? 3 : 2;
  const secureContainer = createGridContainer('secure_container', `Secure Container (${secureTier})`, secDim, secDim);

  const primaryWep = primaryWeaponId ?? (faction === 'pmc_bravo' ? 'akm_762' : 'm4a1');
  const secondaryWep = secondaryWeaponId ?? (faction === 'pmc_bravo' ? 'makarov_pm' : 'glock_17');

  const chestRig = createChestRigItem(faction === 'pmc_bravo' ? 'rig_smersh_assault' : 'rig_mk4_micro');
  const backpack = createBackpackItem('pack_assault_20l');

  // Primary seated mag + 2 spare loaded rifle mags in Chest Rig rifle mag slots
  // Demonstrate mixed-ammo stacking right out of the box (e.g. M855 bottom + M855A1 top)
  const primaryLoadedMag =
    faction === 'pmc_alpha' && primaryWep === 'm4a1'
      ? createLoadedMagazineForWeapon(primaryWep, [
          { variantId: '556x45_m855', count: 20 },
          { variantId: '556x45_m855a1', count: 10 },
        ])
      : faction === 'pmc_bravo' && primaryWep === 'akm_762'
        ? createLoadedMagazineForWeapon(primaryWep, [
            { variantId: '762x39_ps', count: 20 },
            { variantId: '762x39_7n23', count: 10 },
          ])
        : createLoadedMagazineForWeapon(primaryWep);

  const primaryChamber = primaryLoadedMag.rounds.pop() ?? null;

  chestRig.rifleMagSlots[0] = createLoadedMagazineForWeapon(primaryWep);
  chestRig.rifleMagSlots[1] = createLoadedMagazineForWeapon(primaryWep);
  // Leave 3rd rifle slot open for tactical mag retention

  const secLoadedMag = createLoadedMagazineForWeapon(secondaryWep);
  const secChamber = secLoadedMag.rounds.pop() ?? null;
  chestRig.pistolMagSlots[0] = createLoadedMagazineForWeapon(secondaryWep);
  chestRig.pistolMagSlots[1] = createLoadedMagazineForWeapon(secondaryWep);

  // Chest rig general pouches: IFAK + extra bandage
  autoPlaceItemInGrid(chestRig.generalGrid, createMedicalItem('ifak'));
  autoPlaceItemInGrid(chestRig.generalGrid, createMedicalItem('bandage'));

  // Tactical Belt: 2x M67 Frag, 1x Hemostatic Bandage, 1x Combat Splint
  const beltSlots: Array<TacticalItem | null> = [
    createGrenadeItem('m67_frag'),
    createGrenadeItem('m67_frag'),
    createMedicalItem('bandage'),
    createMedicalItem('splint_stim'),
  ];

  // Backpack: loose ammo boxes of MULTIPLE same-caliber variants so players can immediately mix & top up mags!
  if (faction === 'pmc_alpha') {
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('556x45_m855', 60));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('556x45_m855a1', 30));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('556x45_m995', 15));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('9x19_fmj', 34));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('9x19_7n21', 17));
    autoPlaceItemInGrid(backpack.grid, createMagazineItem('mag_556_30', [])); // Empty spare mag ready to pack
  } else {
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('762x39_ps', 60));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('762x39_7n23', 30));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('9x18_pst', 24));
    autoPlaceItemInGrid(backpack.grid, createAmmoStackItem('9x18_pmm', 16));
    autoPlaceItemInGrid(backpack.grid, createMagazineItem('mag_762x39_30', []));
  }
  autoPlaceItemInGrid(backpack.grid, createMedicalItem('ifak'));

  // Secure Container: FOB Keycard + Encrypted Recon Drive (survives death)
  autoPlaceItemInGrid(
    secureContainer,
    createGenericLootItem(
      faction === 'pmc_alpha' ? 'alpha_fob_key' : 'bravo_depot_key',
      faction === 'pmc_alpha' ? 'Alpha FOB Armory Keycard' : 'Bravo Depot Keycard',
      'FOB Key',
      'key',
      1,
      1,
      1800,
    ),
  );
  autoPlaceItemInGrid(
    secureContainer,
    createGenericLootItem(
      'encrypted_recon_drive',
      'Encrypted Recon Drive',
      'SSD Intel',
      'intel',
      1,
      1,
      2400,
    ),
  );

  return {
    primary: {
      weaponId: primaryWep,
      chamberedRound: primaryChamber,
      loadedMag: primaryLoadedMag,
    },
    secondary: {
      weaponId: secondaryWep,
      chamberedRound: secChamber,
      loadedMag: secLoadedMag,
    },
    armorPlateId,
    beltSlots,
    chestRig,
    backpack,
    secureContainer,
  };
}

/**
 * Extracts a full-drop corpse snapshot from the dying operator's tactical inventory
 * (weapons, armor, chest rig, belt, and removable backpack with all nested items intact),
 * leaving ONLY the Secure Container untouched.
 */
export function buildCorpseLootSnapshotFromInventory(
  inv: OperatorTacticalInventory,
  armorName: string | null,
): CorpseTacticalLootSnapshot {
  const looseGrid = createGridContainer('corpse_loose', 'Dropped Gear & Mags', 5, 3);
  if (inv.primary.loadedMag) {
    autoPlaceItemInGrid(looseGrid, cloneTacticalItem(inv.primary.loadedMag));
  }
  if (inv.secondary.loadedMag) {
    autoPlaceItemInGrid(looseGrid, cloneTacticalItem(inv.secondary.loadedMag));
  }
  return {
    primaryWeaponId: inv.primary.weaponId,
    secondaryWeaponId: inv.secondary.weaponId,
    armorPlateId: inv.armorPlateId,
    armorName,
    chestRig: inv.chestRig ? cloneTacticalItem(inv.chestRig) : null,
    backpack: inv.backpack ? cloneTacticalItem(inv.backpack) : null,
    beltSlots: inv.beltSlots.map((it) => (it ? cloneTacticalItem(it) : null)),
    looseGrid,
  };
}

/**
 * Resizes an operator's Secure Container (e.g. 2x2 -> 3x3 at FOB Tier 3) while preserving all items.
 */
export function resizeSecureContainer(
  inv: OperatorTacticalInventory,
  tier: SecureContainerTier,
): void {
  const dim = tier === '3x3' ? 3 : 2;
  inv.secureContainer.width = dim;
  inv.secureContainer.height = dim;
  inv.secureContainer.label = `Secure Container (${tier})`;
}

/**
 * Lists all AmmoVariantDef options matching a base caliber (used for Trader & Magazine Loader UI).
 */
export function getVariantsForBaseCaliber(baseCaliber: BaseCaliberId): AmmoVariantDef[] {
  return Object.values(AMMO_VARIANTS).filter((v) => v.caliberId === baseCaliber);
}

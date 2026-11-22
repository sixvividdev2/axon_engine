import { useEffect, useState } from 'react';
import {
  AttachmentSlot,
  createBareAttachments,
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
  ReticleColorId,
  WeaponAttachments,
} from './attachments';
import { AmmoVariantId, getDefaultAmmoVariant, resolveBaseCaliberId } from './calibers';
import { TacticalBeltSlot, TacticalEquipmentId } from './tacticalEquipment';
import { tacticalEquipmentStore } from '../bodycam-sdk/equipment/TacticalEquipmentStore';
import { resolveWeaponProfile } from '../bodycam-sdk/weaponProfiles';

export interface SavedWeaponBuild {
  weaponId: string;
  attachments: WeaponAttachments;
  ammoVariantId: AmmoVariantId;
  zeroDistanceM: number;
  zeroElevationMrad: number;
  spas12Mode: 'semi' | 'pump';
}

export interface CustomLoadoutSlot {
  id: string;
  name: string;
  primaryWeaponId: string;
  secondaryWeaponId: string;
  tacticalEquipmentId: TacticalEquipmentId;
  tacticalBeltSlot: TacticalBeltSlot;
  mountOnBelt: boolean;
  /** Per-weapon builds persisted inside this loadout slot */
  weaponBuilds: Record<string, SavedWeaponBuild>;
}

export interface LoadoutStoreState {
  activeIndex: number;
  slots: CustomLoadoutSlot[];
}

export const MAX_CUSTOM_LOADOUTS = 5;

const STORAGE_KEY = 'axon_unified_loadouts_v1';

function createDefaultWeaponBuild(weaponId: string): SavedWeaponBuild {
  const profile = resolveWeaponProfile(weaponId);
  const attachments = createBareAttachments();
  const caliberId = resolveBaseCaliberId(profile.defaultCaliberId);
  const ammoVariantId = getDefaultAmmoVariant(caliberId).id;
  const zeroDistanceM = getDefaultZeroDistanceM(profile.category);
  return {
    weaponId,
    attachments,
    ammoVariantId,
    zeroDistanceM,
    zeroElevationMrad: 0,
    spas12Mode: 'semi',
  };
}

function createDefaultLoadoutSlots(): CustomLoadoutSlot[] {
  const presets: Array<{
    name: string;
    primary: string;
    secondary: string;
    tactical: TacticalEquipmentId;
  }> = [
    { name: 'Assault', primary: 'm4a1', secondary: 'makarov_pm', tactical: 'm67_frag' },
    { name: 'CQB Breacher', primary: 'mp5a5', secondary: 'glock19', tactical: 'm84_flash' },
    { name: 'Marksman', primary: 'svd_dragunov', secondary: 'makarov_pm', tactical: 'm18_smoke' },
    { name: 'Heavy Support', primary: 'akm_762', secondary: 'colt_1911', tactical: 'an_m14_thermite' },
    { name: 'Recon Custom', primary: 'm4a1', secondary: 'makarov_pm', tactical: 'm67_frag' },
  ];

  return presets.map((p, idx) => ({
    id: `loadout_${idx + 1}`,
    name: p.name,
    primaryWeaponId: p.primary,
    secondaryWeaponId: p.secondary,
    tacticalEquipmentId: p.tactical,
    tacticalBeltSlot: 'right_hip',
    mountOnBelt: true,
    weaponBuilds: {
      [p.primary]: createDefaultWeaponBuild(p.primary),
      [p.secondary]: createDefaultWeaponBuild(p.secondary),
    },
  }));
}

type LoadoutListener = (state: LoadoutStoreState) => void;

class LoadoutStore {
  private state: LoadoutStoreState;
  private readonly listeners = new Set<LoadoutListener>();

  constructor() {
    this.state = this.load();
  }

  private load(): LoadoutStoreState {
    const fallback: LoadoutStoreState = {
      activeIndex: 0,
      slots: createDefaultLoadoutSlots(),
    };
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<LoadoutStoreState>;
      if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) return fallback;

      const defaults = createDefaultLoadoutSlots();
      const slots: CustomLoadoutSlot[] = defaults.map((def, i) => {
        const s = parsed.slots?.[i];
        if (!s || typeof s !== 'object') return def;
        return {
          id: def.id,
          name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 22) : def.name,
          primaryWeaponId:
            typeof s.primaryWeaponId === 'string' ? s.primaryWeaponId : def.primaryWeaponId,
          secondaryWeaponId:
            typeof s.secondaryWeaponId === 'string' ? s.secondaryWeaponId : def.secondaryWeaponId,
          tacticalEquipmentId:
            (s.tacticalEquipmentId as TacticalEquipmentId) || def.tacticalEquipmentId,
          tacticalBeltSlot: (s.tacticalBeltSlot as TacticalBeltSlot) || def.tacticalBeltSlot,
          mountOnBelt: typeof s.mountOnBelt === 'boolean' ? s.mountOnBelt : def.mountOnBelt,
          weaponBuilds:
            s.weaponBuilds && typeof s.weaponBuilds === 'object' ? s.weaponBuilds : def.weaponBuilds,
        };
      });

      const activeIndex =
        typeof parsed.activeIndex === 'number' &&
        parsed.activeIndex >= 0 &&
        parsed.activeIndex < MAX_CUSTOM_LOADOUTS
          ? Math.floor(parsed.activeIndex)
          : 0;

      return { activeIndex, slots };
    } catch {
      return fallback;
    }
  }

  private saveAndEmit(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage quota errors
    }
    const snapshot = this.getState();
    for (const fn of this.listeners) {
      fn(snapshot);
    }
  }

  public getState(): LoadoutStoreState {
    return {
      activeIndex: this.state.activeIndex,
      slots: this.state.slots.map((s) => ({ ...s, weaponBuilds: { ...s.weaponBuilds } })),
    };
  }

  public getActiveSlot(): CustomLoadoutSlot {
    return this.state.slots[this.state.activeIndex] ?? this.state.slots[0];
  }

  public getWeaponBuild(slotIndex: number, weaponId: string): SavedWeaponBuild {
    const slot = this.state.slots[slotIndex] ?? this.state.slots[0];
    const existing = slot.weaponBuilds[weaponId];
    if (existing) {
      return {
        ...existing,
        attachments: normalizeWeaponAttachments(weaponId, existing.attachments),
      };
    }
    return createDefaultWeaponBuild(weaponId);
  }

  public getActiveWeaponBuild(weaponId: string): SavedWeaponBuild {
    return this.getWeaponBuild(this.state.activeIndex, weaponId);
  }

  public setActiveIndex(index: number): void {
    const clamped = Math.max(0, Math.min(MAX_CUSTOM_LOADOUTS - 1, Math.floor(index)));
    if (clamped === this.state.activeIndex) return;
    this.state = { ...this.state, activeIndex: clamped };
    const slot = this.getActiveSlot();
    tacticalEquipmentStore.setEquipment(slot.tacticalEquipmentId);
    tacticalEquipmentStore.setBeltSlot(slot.tacticalBeltSlot);
    tacticalEquipmentStore.setMountOnBelt(slot.mountOnBelt);
    this.saveAndEmit();
  }

  public renameSlot(index: number, name: string): void {
    const trimmed = name.trim().slice(0, 22);
    if (!trimmed || index < 0 || index >= this.state.slots.length) return;
    const nextSlots = [...this.state.slots];
    nextSlots[index] = { ...nextSlots[index], name: trimmed };
    this.state = { ...this.state, slots: nextSlots };
    this.saveAndEmit();
  }

  public setSlotPrimaryWeapon(index: number, weaponId: string): void {
    if (index < 0 || index >= this.state.slots.length) return;
    const nextSlots = [...this.state.slots];
    const slot = nextSlots[index];
    const builds = { ...slot.weaponBuilds };
    if (!builds[weaponId]) builds[weaponId] = createDefaultWeaponBuild(weaponId);
    nextSlots[index] = { ...slot, primaryWeaponId: weaponId, weaponBuilds: builds };
    this.state = { ...this.state, slots: nextSlots };
    this.saveAndEmit();
  }

  public setSlotSecondaryWeapon(index: number, weaponId: string): void {
    if (index < 0 || index >= this.state.slots.length) return;
    const nextSlots = [...this.state.slots];
    const slot = nextSlots[index];
    const builds = { ...slot.weaponBuilds };
    if (!builds[weaponId]) builds[weaponId] = createDefaultWeaponBuild(weaponId);
    nextSlots[index] = { ...slot, secondaryWeaponId: weaponId, weaponBuilds: builds };
    this.state = { ...this.state, slots: nextSlots };
    this.saveAndEmit();
  }

  public setSlotTacticalEquipment(
    index: number,
    equipmentId: TacticalEquipmentId,
    beltSlot?: TacticalBeltSlot,
    mountOnBelt?: boolean,
  ): void {
    if (index < 0 || index >= this.state.slots.length) return;
    const nextSlots = [...this.state.slots];
    const slot = nextSlots[index];
    nextSlots[index] = {
      ...slot,
      tacticalEquipmentId: equipmentId,
      tacticalBeltSlot: beltSlot ?? slot.tacticalBeltSlot,
      mountOnBelt: mountOnBelt ?? slot.mountOnBelt,
    };
    this.state = { ...this.state, slots: nextSlots };
    if (index === this.state.activeIndex) {
      tacticalEquipmentStore.setEquipment(equipmentId);
      if (beltSlot) tacticalEquipmentStore.setBeltSlot(beltSlot);
      if (typeof mountOnBelt === 'boolean') tacticalEquipmentStore.setMountOnBelt(mountOnBelt);
    }
    this.saveAndEmit();
  }

  public updateWeaponBuild(
    index: number,
    weaponId: string,
    updater: (prev: SavedWeaponBuild) => SavedWeaponBuild,
  ): void {
    if (index < 0 || index >= this.state.slots.length) return;
    const nextSlots = [...this.state.slots];
    const slot = nextSlots[index];
    const prevBuild = this.getWeaponBuild(index, weaponId);
    const nextBuild = updater(prevBuild);
    nextBuild.attachments = normalizeWeaponAttachments(weaponId, nextBuild.attachments);
    nextSlots[index] = {
      ...slot,
      weaponBuilds: {
        ...slot.weaponBuilds,
        [weaponId]: nextBuild,
      },
    };
    this.state = { ...this.state, slots: nextSlots };
    this.saveAndEmit();
  }

  public setWeaponAttachment(
    index: number,
    weaponId: string,
    slotKey: AttachmentSlot,
    attachmentId: string | null,
  ): void {
    this.updateWeaponBuild(index, weaponId, (prev) => ({
      ...prev,
      attachments: {
        ...prev.attachments,
        [slotKey]: attachmentId,
      },
    }));
  }

  public setWeaponReticleColor(
    index: number,
    weaponId: string,
    slotKey: 'optic' | 'canted',
    colorId: ReticleColorId,
  ): void {
    this.updateWeaponBuild(index, weaponId, (prev) => ({
      ...prev,
      attachments: {
        ...prev.attachments,
        ...(slotKey === 'optic'
          ? { opticReticleColor: colorId }
          : { cantedReticleColor: colorId }),
      },
    }));
  }

  public stripWeaponAttachments(index: number, weaponId: string): void {
    this.updateWeaponBuild(index, weaponId, (prev) => ({
      ...prev,
      attachments: createBareAttachments(),
    }));
  }

  public resetSlotToDefault(index: number): void {
    if (index < 0 || index >= this.state.slots.length) return;
    const defaults = createDefaultLoadoutSlots();
    const nextSlots = [...this.state.slots];
    nextSlots[index] = defaults[index];
    this.state = { ...this.state, slots: nextSlots };
    if (index === this.state.activeIndex) {
      tacticalEquipmentStore.setEquipment(nextSlots[index].tacticalEquipmentId);
      tacticalEquipmentStore.setBeltSlot(nextSlots[index].tacticalBeltSlot);
      tacticalEquipmentStore.setMountOnBelt(nextSlots[index].mountOnBelt);
    }
    this.saveAndEmit();
  }

  public subscribe(fn: LoadoutListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export const loadoutStore = new LoadoutStore();

export function useLoadoutStore(): LoadoutStoreState {
  const [state, setState] = useState<LoadoutStoreState>(() => loadoutStore.getState());
  useEffect(() => {
    return loadoutStore.subscribe((next) => setState(next));
  }, []);
  return state;
}

import * as THREE from 'three';
import {
  cloneTacticalItem,
  computeTacticalItemWeightKg,
  createPopulatedWorldBackpack,
  getBackpackTemplate,
  isBackpackTemplateId,
  nextTacticalItemId,
} from '../../src/modes/openworld/inventory/TetrisInventoryCore';
import type {
  BackpackItem,
  BackpackTemplateId,
  CorpseTacticalLootSnapshot,
  OperatorTacticalInventory,
} from '../../src/modes/openworld/inventory/TetrisInventoryTypes';
import type { ExternalLootContext } from '../../src/modes/openworld/ui/TacticalInventoryModal';
import { backpackUnlockStore } from '../../data/backpackUnlocks';
import { buildTacticalBackpackMesh, BuiltTacticalBackpackMesh } from './TacticalBackpackMesh';

export interface WorldBackpackEntry {
  readonly id: string;
  readonly position: THREE.Vector3;
  yaw: number;
  backpack: BackpackItem;
  ownerId: string | null;
  ownerLabel: string | null;
  isPracticeGear: boolean;
  built: BuiltTacticalBackpackMesh;
  ringMesh: THREE.Mesh;
}

export interface WorldBackpackInteractCandidate {
  readonly id: string;
  readonly templateId: BackpackTemplateId;
  readonly name: string;
  readonly shortLabel: string;
  readonly itemCount: number;
  readonly weightKg: number;
  readonly distanceM: number;
  readonly isPracticeGear: boolean;
  readonly ownerLabel: string | null;
}

export interface WorldBackpackEquipResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly requiresUnequipFirst?: boolean;
  readonly equippedPack?: BackpackItem;
  readonly newlyUnlockedTier?: boolean;
}

/**
 * Reusable 3D In-World Backpack Container Manager shared across ALL playable modes
 * (Open World, Battle, Infection, Hideout, Zombies Outpost, Playground, and Field Training).
 *
 * Supports:
 * - Dropping an equipped backpack onto the ground retaining ALL nested Tetris items
 * - Spawning discoverable world supply/loot backpacks or practice-rack packs
 * - Opening any ground backpack for two-way item transfer (even while wearing a pack)
 * - Equipping a ground backpack directly into an EMPTY backpack slot (enforcing "take yours off first")
 * - Permanent progression unlocks when discovering & equipping locked tiers in real play
 */
export class WorldBackpackSystem {
  public readonly group = new THREE.Group();
  private readonly entries = new Map<string, WorldBackpackEntry>();
  private readonly ringGeo: THREE.RingGeometry;
  private readonly ringMatIdle: THREE.MeshBasicMaterial;
  private readonly ringMatHover: THREE.MeshBasicMaterial;
  private highlightedId: string | null = null;

  private readonly _tmpToPack = new THREE.Vector3();
  private readonly _tmpLook = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.group.name = 'world_backpacks_root';
    scene.add(this.group);

    this.ringGeo = new THREE.RingGeometry(0.26, 0.31, 24);
    this.ringGeo.rotateX(-Math.PI * 0.5);
    this.ringMatIdle = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ringMatHover = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  public getEntries(): WorldBackpackEntry[] {
    return Array.from(this.entries.values());
  }

  public getEntry(containerId: string): WorldBackpackEntry | null {
    return this.entries.get(containerId) ?? null;
  }

  public spawnBackpack(options: {
    id?: string;
    backpack: BackpackItem;
    position: THREE.Vector3;
    yaw?: number;
    ownerId?: string | null;
    ownerLabel?: string | null;
    isPracticeGear?: boolean;
  }): WorldBackpackEntry {
    const id = options.id ?? nextTacticalItemId('wpack');
    const existing = this.entries.get(id);
    if (existing) {
      this.removeBackpack(id);
    }

    const templateId: BackpackTemplateId = isBackpackTemplateId(options.backpack.templateId)
      ? options.backpack.templateId
      : 'pack_assault_20l';

    const built = buildTacticalBackpackMesh(templateId, {
      mode: 'ground',
      worldBackpackId: id,
      castShadow: true,
      receiveShadow: true,
    });
    built.root.position.copy(options.position);
    built.root.rotation.y = options.yaw ?? 0;

    const ringMesh = new THREE.Mesh(this.ringGeo, this.ringMatIdle);
    ringMesh.position.set(0, 0.018, 0);
    built.root.add(ringMesh);

    this.group.add(built.root);

    const entry: WorldBackpackEntry = {
      id,
      position: options.position.clone(),
      yaw: options.yaw ?? 0,
      backpack: cloneTacticalItem(options.backpack),
      ownerId: options.ownerId ?? null,
      ownerLabel: options.ownerLabel ?? null,
      isPracticeGear: Boolean(options.isPracticeGear),
      built,
      ringMesh,
    };
    this.entries.set(id, entry);
    return entry;
  }

  public spawnLootBackpackPreset(options: {
    id?: string;
    templateId: BackpackTemplateId;
    position: THREE.Vector3;
    yaw?: number;
    primaryWeaponId?: string;
    ownerLabel?: string | null;
    isPracticeGear?: boolean;
  }): WorldBackpackEntry {
    const pack = createPopulatedWorldBackpack(options.templateId, options.primaryWeaponId ?? 'm4a1');
    return this.spawnBackpack({
      id: options.id,
      backpack: pack,
      position: options.position,
      yaw: options.yaw,
      ownerLabel: options.ownerLabel ?? (options.isPracticeGear ? 'Gear Rack' : 'Field Supply Pack'),
      isPracticeGear: options.isPracticeGear,
    });
  }

  /**
   * Detaches the operator's currently equipped backpack and drops it flush onto the ground
   * in front of them, retaining EVERY nested item in its exact grid coordinates.
   */
  public dropFromInventory(
    inv: OperatorTacticalInventory,
    playerFeetPos: THREE.Vector3,
    forwardDir: THREE.Vector3,
    resolveGroundY: (x: number, z: number, fallbackY: number) => number,
    options?: {
      id?: string;
      ownerId?: string | null;
      ownerLabel?: string | null;
    },
  ): WorldBackpackEntry | null {
    if (!inv.backpack) return null;
    const droppedPack = inv.backpack;
    inv.backpack = null;

    const horizLen = Math.hypot(forwardDir.x, forwardDir.z);
    const fx = horizLen > 1e-4 ? forwardDir.x / horizLen : 0;
    const fz = horizLen > 1e-4 ? forwardDir.z / horizLen : -1;
    const dropX = playerFeetPos.x + fx * 0.92;
    const dropZ = playerFeetPos.z + fz * 0.92;
    const dropY = resolveGroundY(dropX, dropZ, playerFeetPos.y);
    const yaw = Math.atan2(fx, fz) + Math.PI;

    return this.spawnBackpack({
      id: options?.id,
      backpack: droppedPack,
      position: new THREE.Vector3(dropX, dropY, dropZ),
      yaw,
      ownerId: options?.ownerId ?? null,
      ownerLabel: options?.ownerLabel ?? 'Dropped Pack',
      isPracticeGear: false,
    });
  }

  public removeBackpack(containerId: string): boolean {
    const entry = this.entries.get(containerId);
    if (!entry) return false;
    this.group.remove(entry.built.root);
    entry.built.dispose();
    this.entries.delete(containerId);
    if (this.highlightedId === containerId) {
      this.highlightedId = null;
    }
    return true;
  }

  public updateContainerContents(containerId: string, nextBackpack: BackpackItem): boolean {
    const entry = this.entries.get(containerId);
    if (!entry) return false;
    entry.backpack = cloneTacticalItem(nextBackpack);
    return true;
  }

  /**
   * Equips an in-world backpack onto the operator.
   * Strictly enforces the rule: if the operator ALREADY wears a backpack, they must
   * take off / drop their current pack first.
   */
  public equipFromWorld(
    containerId: string,
    inv: OperatorTacticalInventory,
    careerRank = 1,
  ): WorldBackpackEquipResult {
    const entry = this.entries.get(containerId);
    if (!entry) {
      return { ok: false, error: 'Backpack is no longer on the ground.' };
    }
    if (inv.backpack !== null) {
      return {
        ok: false,
        requiresUnequipFirst: true,
        error: 'Take off or drop your current backpack before equipping another.',
      };
    }

    const equippedPack = cloneTacticalItem(entry.backpack);
    inv.backpack = equippedPack;
    const isPractice = entry.isPracticeGear;
    this.removeBackpack(containerId);

    const newlyUnlockedTier = backpackUnlockStore.unlockByWorldPickup(equippedPack.templateId, {
      isPracticeGear: isPractice,
      currentRank: careerRank,
    });

    return {
      ok: true,
      equippedPack,
      newlyUnlockedTier,
    };
  }

  /**
   * Finds the best ground backpack the player is looking at (or standing right over) within range
   * and updates its subtle ground highlight ring.
   */
  public findInteractable(
    eyePos: THREE.Vector3,
    lookDir: THREE.Vector3,
    maxDistM = 3.1,
  ): WorldBackpackInteractCandidate | null {
    this._tmpLook.copy(lookDir).normalize();
    let bestEntry: WorldBackpackEntry | null = null;
    let bestScore = -Infinity;
    let bestDist = Infinity;

    for (const entry of this.entries.values()) {
      this._tmpToPack.set(
        entry.position.x - eyePos.x,
        entry.position.y + 0.25 - eyePos.y,
        entry.position.z - eyePos.z,
      );
      const dist = this._tmpToPack.length();
      if (dist > maxDistM || dist < 0.05) continue;
      this._tmpToPack.divideScalar(dist);
      const dot = this._tmpToPack.dot(this._tmpLook);
      // Require looking roughly toward the pack unless standing almost directly over it
      const minDot = dist < 1.35 ? 0.55 : 0.78;
      if (dot < minDot) continue;
      const score = dot * 2.2 - dist * 0.38;
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
        bestDist = dist;
      }
    }

    const nextHighlight = bestEntry?.id ?? null;
    if (nextHighlight !== this.highlightedId) {
      if (this.highlightedId) {
        const prev = this.entries.get(this.highlightedId);
        if (prev) prev.ringMesh.material = this.ringMatIdle;
      }
      if (bestEntry) {
        bestEntry.ringMesh.material = this.ringMatHover;
      }
      this.highlightedId = nextHighlight;
    }

    if (!bestEntry) return null;
    const templateId: BackpackTemplateId = isBackpackTemplateId(bestEntry.backpack.templateId)
      ? bestEntry.backpack.templateId
      : 'pack_assault_20l';
    const tpl = getBackpackTemplate(templateId);
    return {
      id: bestEntry.id,
      templateId,
      name: tpl?.name ?? bestEntry.backpack.name,
      shortLabel: tpl?.shortLabel ?? bestEntry.backpack.shortLabel,
      itemCount: bestEntry.backpack.grid.items.length,
      weightKg: computeTacticalItemWeightKg(bestEntry.backpack),
      distanceM: Number(bestDist.toFixed(2)),
      isPracticeGear: bestEntry.isPracticeGear,
      ownerLabel: bestEntry.ownerLabel,
    };
  }

  /**
   * Wraps a ground backpack into an `ExternalLootContext` so `TacticalInventoryModal`
   * opens it cleanly side-by-side for two-way transfers & equip actions.
   */
  public buildExternalLootContext(containerId: string): ExternalLootContext | null {
    const entry = this.entries.get(containerId);
    if (!entry) return null;
    const packClone = cloneTacticalItem(entry.backpack);
    const tpl = getBackpackTemplate(packClone.templateId);
    const lootKit: CorpseTacticalLootSnapshot = {
      primaryWeaponId: null,
      secondaryWeaponId: null,
      armorPlateId: null,
      armorName: null,
      chestRig: null,
      backpack: packClone,
      beltSlots: [null, null, null, null],
      looseGrid: {
        id: `${entry.id}_loose`,
        label: 'Ground Surface',
        width: 4,
        height: 2,
        items: [],
      },
    };
    return {
      kind: 'ground_backpack',
      id: entry.id,
      title: tpl?.name ?? packClone.name,
      subtitle: `${packClone.grid.width}x${packClone.grid.height} Grid · ${computeTacticalItemWeightKg(packClone).toFixed(1)} kg${entry.ownerLabel ? ` · ${entry.ownerLabel}` : ''}`,
      lootKit,
      isPracticeGear: entry.isPracticeGear,
    };
  }

  public clear(): void {
    for (const id of Array.from(this.entries.keys())) {
      this.removeBackpack(id);
    }
    this.highlightedId = null;
  }

  public dispose(): void {
    this.clear();
    this.ringGeo.dispose();
    this.ringMatIdle.dispose();
    this.ringMatHover.dispose();
    this.group.parent?.remove(this.group);
  }
}

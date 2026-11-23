import * as THREE from 'three';
import {
  autoPlaceItemInGrid,
  createAmmoStackItem,
  createGenericLootItem,
  createGridContainer,
  createMagazineItem,
  createMedicalItem,
} from '../inventory/TetrisInventoryCore';
import type { CorpseTacticalLootSnapshot } from '../inventory/TetrisInventoryTypes';
import {
  DynamicWorldEventKind,
  OpenWorldCharacter,
  PmcFactionId,
} from '../types';
import { SEA_LEVEL_M } from './OpenWorldTerrain';

export interface ActiveWorldEventState {
  readonly eventId: string;
  readonly kind: DynamicWorldEventKind;
  readonly title: string;
  readonly summary: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sectorId?: string;
  remainingSec: number;
  resolved: boolean;
  lootClaimed: boolean;
  guardsAlive: number;
  readonly lootKit: CorpseTacticalLootSnapshot;
}

export interface WorldEventTelemetry {
  activeEvent: {
    eventId: string;
    kind: DynamicWorldEventKind;
    title: string;
    summary: string;
    x: number;
    z: number;
    remainingSec: number;
    guardsAlive: number;
    lootClaimed: boolean;
  } | null;
  nextPeriodicEventSec: number;
  completedEventsCount: number;
}

interface EventGuard {
  guardId: string;
  hp: number;
  alive: boolean;
  meshGroup: THREE.Group;
}

const MIN_PERIODIC_SEC = 300; // 5 minutes
const MAX_PERIODIC_SEC = 480; // 8 minutes

/**
 * Phase 5 Map-Wide Dynamic World Events Director:
 * - Black-Box Drop (night-weighted): falling orbital pod, crimson flare, encrypted intel & exotic AP ammo.
 * - Smuggler Boat (night-weighted): coastal contraband landing with high-value optics, AP ammo & cash.
 * - Convoy Ambush: disabled high-priority truck on Route 41 with ammo & trauma salvage crates.
 * - Sector Counter-Assault: hostile strike team assaulting a POI with bonus defense payout.
 * Triggers periodically every 5-8 minutes AND supports manual triggers from the Ops Dock.
 */
export class OpenWorldEventDirector {
  public readonly rootGroup = new THREE.Group();
  public readonly hitMeshes: THREE.Object3D[] = [];

  private readonly sampleGroundHeight: (x: number, z: number) => number;
  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];

  private activeEvent: ActiveWorldEventState | null = null;
  private activeVisualGroup: THREE.Group | null = null;
  private activeFlareMat: THREE.MeshStandardMaterial | null = null;
  private readonly activeGuards: EventGuard[] = [];

  private nextEventCountdownSec = 360; // Initial 6 min periodic timer
  private completedEventsCount = 0;
  private animTime = 0;

  constructor(
    scene: THREE.Scene,
    sampleGroundHeight: (x: number, z: number) => number,
  ) {
    this.sampleGroundHeight = sampleGroundHeight;
    this.rootGroup.name = 'openworld_dynamic_events';
    scene.add(this.rootGroup);
    this.initSharedAssets();
  }

  private initSharedAssets(): void {
    const podGeo = new THREE.CylinderGeometry(0.95, 1.25, 2.5, 8);
    const boatGeo = new THREE.BoxGeometry(3.4, 1.1, 8.2);
    const crateGeo = new THREE.BoxGeometry(1.4, 0.85, 0.95);
    const flareGeo = new THREE.OctahedronGeometry(0.36, 0);
    const smokeGeo = new THREE.CylinderGeometry(0.35, 1.6, 16, 8, 1, true);
    const guardBodyGeo = new THREE.CapsuleGeometry(0.32, 0.95, 4, 8);
    const guardHeadGeo = new THREE.SphereGeometry(0.21, 8, 6);
    this.sharedGeos.push(podGeo, boatGeo, crateGeo, flareGeo, smokeGeo, guardBodyGeo, guardHeadGeo);

    const metalMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.42, metalness: 0.68 });
    const boatMat = new THREE.MeshStandardMaterial({ color: 0x29323c, roughness: 0.72, metalness: 0.25 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x3f4a36, roughness: 0.78, metalness: 0.16 });
    const smokeMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const guardMat = new THREE.MeshStandardMaterial({ color: 0x451a1a, roughness: 0.85, metalness: 0.12 });
    this.sharedMats.push(metalMat, boatMat, crateMat, smokeMat, guardMat);
  }

  /**
   * Selects a weighted Dynamic World Event kind, boosting covert events (Smuggler Boat & Black-Box Drop)
   * during Night Operations (20:00 - 05:00).
   */
  public pickWeightedEventKind(timeOfDayHours: number, rngVal = Math.random()): DynamicWorldEventKind {
    const isNight = timeOfDayHours >= 20 || timeOfDayHours < 5;
    const weights: ReadonlyArray<{ kind: DynamicWorldEventKind; weight: number }> = isNight
      ? [
          { kind: 'smuggler_boat', weight: 36 },
          { kind: 'black_box_drop', weight: 34 },
          { kind: 'convoy_ambush', weight: 16 },
          { kind: 'sector_counter_assault', weight: 14 },
        ]
      : [
          { kind: 'black_box_drop', weight: 25 },
          { kind: 'convoy_ambush', weight: 30 },
          { kind: 'sector_counter_assault', weight: 28 },
          { kind: 'smuggler_boat', weight: 17 },
        ];

    const total = weights.reduce((a, w) => a + w.weight, 0);
    let cursor = Math.max(0, Math.min(0.9999, rngVal)) * total;
    for (const w of weights) {
      cursor -= w.weight;
      if (cursor <= 0) return w.kind;
    }
    return 'black_box_drop';
  }

  public triggerEvent(
    kind: DynamicWorldEventKind,
    playerFaction: PmcFactionId = 'pmc_alpha',
  ): ActiveWorldEventState {
    this.clearActiveVisuals();

    const eventId = `evt_${kind}_${Date.now().toString(36)}`;
    let x = -120;
    let z = 180;
    let title = 'Black-Box Recon Drop';
    let summary = 'Flare-lit reconnaissance pod dropped with encrypted intel & tungsten AP crates.';
    let sectorId: string | undefined;

    const lootGrid = createGridContainer(`evt_grid_${eventId}`, 'World Event Salvage Crate', 6, 4);

    if (kind === 'black_box_drop') {
      x = -240;
      z = -220;
      title = 'Black-Box Recon Drop';
      summary = 'Orbital flight recorder & tungsten AP supply pod down near Central Valley ridge.';
      autoPlaceItemInGrid(
        lootGrid,
        createGenericLootItem('evt_blackbox_drive', 'Encrypted Black-Box Recorder', 'Black-Box', 'intel', 2, 1, 6800),
      );
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('556x45_m995', 30));
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('762x51_m993', 20));
      autoPlaceItemInGrid(lootGrid, createMagazineItem('mag_556_30', Array(30).fill('556x45_m995')));
      autoPlaceItemInGrid(lootGrid, createMedicalItem('ifak'));
    } else if (kind === 'smuggler_boat') {
      x = -380;
      z = 1320;
      title = 'Covert Smuggler Boat Landing';
      summary = 'Unmarked Syndicate contraband skiff beached along the Coastal Port marsh delta.';
      autoPlaceItemInGrid(
        lootGrid,
        createGenericLootItem('evt_contraband_case', 'Syndicate Smuggled Optics Case', 'Optics Case', 'barter', 2, 2, 7400),
      );
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('9x19_7n21', 40));
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('9x19_147_sub', 40));
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('762x39_7n23', 30));
      autoPlaceItemInGrid(lootGrid, createMedicalItem('ifak'));
    } else if (kind === 'convoy_ambush') {
      x = 140;
      z = 360;
      title = 'Route 41 Convoy Ambush';
      summary = 'Disabled logistics truck under fire along Route 41 — clear raiders and salvage munitions.';
      autoPlaceItemInGrid(
        lootGrid,
        createGenericLootItem('evt_manifest_ledger', 'Military Convoy Manifest', 'Manifest', 'intel', 1, 1, 4200),
      );
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('556x45_m855a1', 60));
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('762x39_7n23', 45));
      autoPlaceItemInGrid(lootGrid, createMedicalItem('ifak'));
      autoPlaceItemInGrid(lootGrid, createMedicalItem('splint_stim'));
    } else {
      // Sector Counter-Assault
      x = playerFaction === 'pmc_alpha' ? -160 : 480;
      z = playerFaction === 'pmc_alpha' ? 240 : -380;
      sectorId =
        playerFaction === 'pmc_alpha' ? 'landmark_timberline_railyard' : 'landmark_steppe_quarry';
      title = 'Hostile Sector Counter-Assault';
      summary = 'Rival strike team pushing central sector perimeter — eliminate attackers for defense bonus.';
      autoPlaceItemInGrid(
        lootGrid,
        createGenericLootItem('evt_strike_orders', 'Hostile Strike Team Orders', 'Orders', 'intel', 1, 1, 5200),
      );
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('556x45_mk262', 30));
      autoPlaceItemInGrid(lootGrid, createAmmoStackItem('545x39_7n22', 30));
      autoPlaceItemInGrid(lootGrid, createMedicalItem('ifak'));
    }

    const y =
      kind === 'smuggler_boat'
        ? SEA_LEVEL_M + 0.15
        : Math.max(SEA_LEVEL_M + 0.25, this.sampleGroundHeight(x, z));

    const lootKit: CorpseTacticalLootSnapshot = {
      primaryWeaponId: null,
      secondaryWeaponId: null,
      armorPlateId: null,
      armorName: null,
      chestRig: null,
      backpack: null,
      beltSlots: [null, null, null, null],
      looseGrid: lootGrid,
    };

    const g = new THREE.Group();
    g.name = `event_visual_${eventId}`;
    g.position.set(x, y, z);

    const [podGeo, boatGeo, crateGeo, flareGeo, smokeGeo, guardBodyGeo, guardHeadGeo] =
      this.sharedGeos;
    const [metalMat, boatMat, crateMat, smokeMat, guardMat] = this.sharedMats;

    const flareMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xdc2626,
      emissiveIntensity: 1.8,
      roughness: 0.2,
    });
    this.activeFlareMat = flareMat;

    if (kind === 'smuggler_boat') {
      const boat = new THREE.Mesh(boatGeo, boatMat);
      boat.position.y = 0.55;
      g.add(boat);
    } else {
      const pod = new THREE.Mesh(podGeo, metalMat);
      pod.position.y = 1.25;
      g.add(pod);
    }

    const crate = new THREE.Mesh(crateGeo, crateMat);
    crate.position.set(2.1, 0.42, 0.6);
    const flare = new THREE.Mesh(flareGeo, flareMat);
    flare.position.set(0, 3.1, 0);
    const smoke = new THREE.Mesh(smokeGeo, smokeMat);
    smoke.position.set(0, 8.5, 0);
    g.add(crate, flare, smoke);
    this.rootGroup.add(g);
    this.activeVisualGroup = g;

    // Spawn 2 perimeter event guards (shootable via hitMeshes)
    const offsets: ReadonlyArray<[number, number]> = [
      [-4.2, 3.4],
      [4.5, -2.8],
    ];
    for (let i = 0; i < offsets.length; i++) {
      const [ox, oz] = offsets[i];
      const gx = x + ox;
      const gz = z + oz;
      const gy = Math.max(SEA_LEVEL_M + 0.2, this.sampleGroundHeight(gx, gz));
      const guardId = `${eventId}_guard_${i}`;
      const gg = new THREE.Group();
      gg.position.set(gx, gy, gz);
      const body = new THREE.Mesh(guardBodyGeo, guardMat);
      body.position.y = 0.92;
      body.userData = { openWorldEventGuardId: guardId };
      const head = new THREE.Mesh(guardHeadGeo, guardMat);
      head.position.y = 1.65;
      head.userData = { openWorldEventGuardId: guardId, hitZone: 'head' };
      gg.add(body, head);
      this.rootGroup.add(gg);
      this.hitMeshes.push(body, head);
      this.activeGuards.push({
        guardId,
        hp: 85,
        alive: true,
        meshGroup: gg,
      });
    }

    this.activeEvent = {
      eventId,
      kind,
      title,
      summary,
      x,
      y,
      z,
      sectorId,
      remainingSec: 360,
      resolved: false,
      lootClaimed: false,
      guardsAlive: this.activeGuards.length,
      lootKit,
    };

    // Reset next periodic event timer to 5–8 minutes
    this.nextEventCountdownSec =
      MIN_PERIODIC_SEC + Math.floor(Math.random() * (MAX_PERIODIC_SEC - MIN_PERIODIC_SEC + 1));

    return this.activeEvent;
  }

  public update(
    dt: number,
    timeOfDayHours: number,
    playerFaction: PmcFactionId,
  ): ActiveWorldEventState | null {
    this.animTime += dt;
    let newlyTriggered: ActiveWorldEventState | null = null;

    if (this.activeEvent) {
      this.activeEvent.remainingSec = Math.max(0, this.activeEvent.remainingSec - dt);
      if (this.activeFlareMat) {
        this.activeFlareMat.emissiveIntensity = 1.1 + Math.sin(this.animTime * 6.5) * 0.7;
      }
      if (this.activeEvent.remainingSec <= 0) {
        this.clearActiveVisuals();
      }
    } else {
      this.nextEventCountdownSec -= dt;
      if (this.nextEventCountdownSec <= 0) {
        const kind = this.pickWeightedEventKind(timeOfDayHours);
        newlyTriggered = this.triggerEvent(kind, playerFaction);
      }
    }

    return newlyTriggered;
  }

  public applyDamageToGuard(
    guardId: string,
    damage: number,
  ): { hit: boolean; killed: boolean; allCleared: boolean } {
    for (const g of this.activeGuards) {
      if (g.guardId !== guardId || !g.alive) continue;
      g.hp -= damage;
      if (g.hp <= 0) {
        g.alive = false;
        g.meshGroup.visible = false;
        const aliveLeft = this.activeGuards.filter((x) => x.alive).length;
        if (this.activeEvent) {
          this.activeEvent.guardsAlive = aliveLeft;
        }
        return { hit: true, killed: true, allCleared: aliveLeft === 0 };
      }
      return { hit: true, killed: false, allCleared: false };
    }
    return { hit: false, killed: false, allCleared: false };
  }

  public getActiveEvent(): ActiveWorldEventState | null {
    return this.activeEvent;
  }

  public findNearestInteractableCrate(
    playerX: number,
    playerZ: number,
  ): {
    eventId: string;
    label: string;
    sublabel: string;
    distanceM: number;
    canExecute: boolean;
    blockedReason?: string;
  } | null {
    const ev = this.activeEvent;
    if (!ev || ev.lootClaimed) return null;
    const d = Math.hypot(playerX - ev.x, playerZ - ev.z);
    if (d > 8.5) return null;
    const blocked = ev.guardsAlive > 0;
    return {
      eventId: ev.eventId,
      label: blocked ? `${ev.title} Crate (Guarded)` : `Loot ${ev.title} Crate`,
      sublabel: blocked
        ? `Eliminate ${ev.guardsAlive} remaining event guard(s) first`
        : `${ev.lootKit.looseGrid.items.length} salvage item(s) — opens Tetris Loot Grid`,
      distanceM: d,
      canExecute: !blocked,
      blockedReason: blocked ? `Clear ${ev.guardsAlive} event guard(s) first.` : undefined,
    };
  }

  public markEventLootUpdated(nextKit: CorpseTacticalLootSnapshot): boolean {
    if (!this.activeEvent) return false;
    this.activeEvent.lootKit.looseGrid = nextKit.looseGrid;
    if (nextKit.looseGrid.items.length === 0 && !this.activeEvent.lootClaimed) {
      this.activeEvent.lootClaimed = true;
      this.activeEvent.resolved = true;
      this.completedEventsCount += 1;
      return true;
    }
    return false;
  }

  public getTelemetry(): WorldEventTelemetry {
    return {
      activeEvent: this.activeEvent
        ? {
            eventId: this.activeEvent.eventId,
            kind: this.activeEvent.kind,
            title: this.activeEvent.title,
            summary: this.activeEvent.summary,
            x: Math.round(this.activeEvent.x),
            z: Math.round(this.activeEvent.z),
            remainingSec: Math.ceil(this.activeEvent.remainingSec),
            guardsAlive: this.activeEvent.guardsAlive,
            lootClaimed: this.activeEvent.lootClaimed,
          }
        : null,
      nextPeriodicEventSec: Math.max(0, Math.ceil(this.nextEventCountdownSec)),
      completedEventsCount: this.completedEventsCount,
    };
  }

  private clearActiveVisuals(): void {
    if (this.activeVisualGroup) {
      this.rootGroup.remove(this.activeVisualGroup);
      this.activeVisualGroup = null;
    }
    if (this.activeFlareMat) {
      this.activeFlareMat.dispose();
      this.activeFlareMat = null;
    }
    for (const g of this.activeGuards) {
      this.rootGroup.remove(g.meshGroup);
    }
    this.activeGuards.length = 0;
    this.hitMeshes.length = 0;
    this.activeEvent = null;
  }

  public dispose(): void {
    this.clearActiveVisuals();
    if (this.rootGroup.parent) {
      this.rootGroup.parent.remove(this.rootGroup);
    }
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
  }
}

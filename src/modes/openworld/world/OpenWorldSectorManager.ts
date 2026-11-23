import * as THREE from 'three';
import { CharacterRoster } from '../CharacterRoster';
import { ShardStore } from '../ShardStore';
import {
  FactionSupplyPool,
  FobTier,
  OPENWORLD_CONTRACT_CATALOG,
  OPENWORLD_CONTRACT_MAP,
  OpenWorldCharacter,
  OpenWorldContractSpec,
  PmcFactionId,
  SectorAlertState,
  SectorControlOwner,
  ShardMode,
  SUB_FACTION_MAP,
  SubFactionId,
  SupplyResourceKey,
} from '../types';
import {
  OPENWORLD_LANDMARKS,
  OpenWorldLandmarkSpec,
  OpenWorldPoiRole,
  SEA_LEVEL_M,
} from './OpenWorldTerrain';

export interface SectorRuntimeState {
  readonly sectorId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly biomeId: OpenWorldLandmarkSpec['biomeId'];
  readonly poiRole: OpenWorldPoiRole;
  readonly worldX: number;
  readonly worldZ: number;
  readonly groundY: number;
  readonly isFob: boolean;
  readonly commsCoverageRadiusM?: number;
  readonly supplyResource?: SupplyResourceKey;
  readonly homeFaction?: PmcFactionId;
  readonly subFactionId?: SubFactionId;
  readonly contractId: string | null;
  readonly supplyYield: Readonly<Partial<FactionSupplyPool>>;
  owner: SectorControlOwner;
  alertState: SectorAlertState;
  /** 0..100 live capture progress toward the player's PMC faction while inside capture zone */
  liveCapturePct: number;
  contested: boolean;
  hostileGarrisonCount: number;
  terminalX: number;
  terminalZ: number;
  alertDecaySec: number;
}

export interface SectorCaptureCompleteEvent {
  sectorId: string;
  sectorName: string;
  poiRole: OpenWorldPoiRole;
  newOwner: PmcFactionId;
  cashBonusUsd: number;
  supplyBonus: Partial<FactionSupplyPool>;
}

export interface CommsBlackoutZone {
  sectorId: string;
  label: string;
  x: number;
  z: number;
  radiusM: number;
  owner: SectorControlOwner;
}

export interface OpenWorldInteractableContext {
  kind:
    | 'contract'
    | 'sector_terminal'
    | 'fob_resupply'
    | 'fob_terminal'
    | 'corpse'
    | 'wildlife_harvest'
    | 'convoy_hijack'
    | 'world_event_crate';
  id: string;
  label: string;
  sublabel: string;
  distanceM: number;
  canExecute: boolean;
  blockedReason?: string;
}

const SECTOR_CAPTURE_RADIUS_M = 48;
const SECTOR_CAPTURE_RATE_PER_SEC = 18; // ~5.5s uncontested capture
const SECTOR_CAPTURE_CASH_BONUS = 1500;
const SUPPLY_DEPOT_TICK_INTERVAL_SEC = 90;

const SECTOR_SUPPLY_YIELDS: Readonly<Record<string, Partial<FactionSupplyPool>>> = {
  landmark_port_terminal: { fuelParts: 14, ammo: 8, intel: 6 },
  landmark_timberline_railyard: { ammo: 14, fuelParts: 10, medical: 6 },
  landmark_steppe_quarry: { intel: 14, ammo: 10, fuelParts: 6 },
  landmark_alpine_dam: { medical: 14, intel: 14, ammo: 8 },
  comms_south_marsh: { intel: 10, fuelParts: 4 },
  comms_pine_ridge: { intel: 10, ammo: 4 },
  comms_alpine_relay: { intel: 12, medical: 4 },
  depot_valley_munitions: { ammo: 18 },
  depot_steppe_medbay: { medical: 18 },
  depot_alpine_signals: { intel: 18 },
};

const CONTRACT_BY_LANDMARK: Readonly<Record<string, string>> = {
  landmark_port_terminal: 'contract_port_manifest',
  landmark_timberline_railyard: 'contract_valley_convoy',
  landmark_steppe_quarry: 'contract_quarry_relay',
  landmark_alpine_dam: 'contract_dam_vault',
};

const OWNER_COLORS: Readonly<Record<SectorControlOwner, number>> = {
  pmc_alpha: 0x38bdf8,
  pmc_bravo: 0xf59e0b,
  neutral: 0x94a3b8,
};

interface SectorVisualHandle {
  sectorId: string;
  flagMesh: THREE.Mesh;
  beaconMesh: THREE.Mesh;
  ringMesh: THREE.Mesh;
  flagMat: THREE.MeshStandardMaterial;
  beaconMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshBasicMaterial;
  contractScreenMat: THREE.MeshStandardMaterial | null;
  fobTier2Group: THREE.Group | null;
  fobTier3Group: THREE.Group | null;
}

/**
 * Phase 4 Dynamic Territory Control (12 POIs, 4-State Machine: Calm -> Alerted -> Contested -> Captured),
 * 3 Regional Comms Towers (PDA Fog-of-War), 4 Supply Depots, Physical FOB Tier 1-3 Upgrades,
 * In-World FOB Logistics/Quartermaster Terminals, and Biome Contracts.
 * - Commits discrete `sector_flip`, `contract_completed`, and supply tick writes to ShardStore & CharacterRoster.
 * - Zero per-frame heap allocations; explicit `.dispose()` teardown.
 */
export class OpenWorldSectorManager {
  public readonly rootGroup = new THREE.Group();
  private readonly sectors = new Map<string, SectorRuntimeState>();
  private readonly visuals = new Map<string, SectorVisualHandle>();
  private readonly sharedGeometries: THREE.BufferGeometry[] = [];
  private readonly sharedMaterials: THREE.Material[] = [];

  private readonly roster: CharacterRoster;
  private readonly shards: ShardStore;
  private activeShardMode: ShardMode = 'PvPvE';
  private waveTime = 0;
  private supplyDepotTickAccum = 0;

  constructor(
    scene: THREE.Scene,
    sampleGroundHeight: (x: number, z: number) => number,
    roster: CharacterRoster,
    shards: ShardStore,
    initialShardMode: ShardMode = 'PvPvE',
  ) {
    this.roster = roster;
    this.shards = shards;
    this.activeShardMode = initialShardMode;
    this.rootGroup.name = 'openworld_sector_beacons';
    scene.add(this.rootGroup);

    this.initSectorsAndVisuals(sampleGroundHeight);
    this.syncFromShard(initialShardMode);
  }

  private initSectorsAndVisuals(sampleGroundHeight: (x: number, z: number) => number): void {
    const padGeo = new THREE.BoxGeometry(4.6, 0.28, 4.6);
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.14, 11.5, 8);
    const commsTowerGeo = new THREE.CylinderGeometry(0.28, 0.95, 24.0, 6);
    const dishGeo = new THREE.CylinderGeometry(1.15, 0.25, 0.45, 10);
    dishGeo.rotateX(Math.PI * 0.5);
    const depotBunkerGeo = new THREE.BoxGeometry(6.8, 3.1, 4.6);
    const fuelTankGeo = new THREE.CylinderGeometry(1.05, 1.05, 3.6, 10);
    fuelTankGeo.rotateZ(Math.PI * 0.5);

    const crossBarGeo = new THREE.BoxGeometry(1.9, 0.08, 0.08);
    const flagGeo = new THREE.PlaneGeometry(2.6, 1.45, 4, 1);
    flagGeo.translate(1.3, 0, 0);
    const beaconGeo = new THREE.OctahedronGeometry(0.42, 0);
    const crateGeo = new THREE.BoxGeometry(1.15, 0.85, 0.72);
    const antennaGeo = new THREE.CylinderGeometry(0.02, 0.03, 1.45, 5);
    const ringGeo = new THREE.RingGeometry(SECTOR_CAPTURE_RADIUS_M - 0.65, SECTOR_CAPTURE_RADIUS_M, 48);
    ringGeo.rotateX(-Math.PI * 0.5);

    // Contract / FOB terminal console geometries
    const laptopBaseGeo = new THREE.BoxGeometry(0.54, 0.06, 0.38);
    const laptopLidGeo = new THREE.BoxGeometry(0.54, 0.34, 0.04);
    const caseGeo = new THREE.BoxGeometry(0.88, 0.52, 0.62);
    const fobConsoleDeskGeo = new THREE.BoxGeometry(2.2, 0.95, 0.9);
    const fobScreenGeo = new THREE.BoxGeometry(1.5, 0.72, 0.06);

    // Physical FOB Tier 2 & Tier 3 Upgrade geometries
    const tier2ShelterGeo = new THREE.BoxGeometry(7.2, 3.4, 5.2);
    const tier2BenchGeo = new THREE.BoxGeometry(2.8, 1.05, 1.1);
    const tier3HelipadGeo = new THREE.CylinderGeometry(7.2, 7.6, 0.36, 16);
    const tier3TurretBaseGeo = new THREE.CylinderGeometry(0.85, 1.05, 4.4, 8);
    const tier3TurretHeadGeo = new THREE.BoxGeometry(1.45, 0.95, 1.9);

    this.sharedGeometries.push(
      padGeo,
      mastGeo,
      commsTowerGeo,
      dishGeo,
      depotBunkerGeo,
      fuelTankGeo,
      crossBarGeo,
      flagGeo,
      beaconGeo,
      crateGeo,
      antennaGeo,
      ringGeo,
      laptopBaseGeo,
      laptopLidGeo,
      caseGeo,
      fobConsoleDeskGeo,
      fobScreenGeo,
      tier2ShelterGeo,
      tier2BenchGeo,
      tier3HelipadGeo,
      tier3TurretBaseGeo,
      tier3TurretHeadGeo,
    );

    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x4b5158, roughness: 0.92, metalness: 0.06 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x353a40, roughness: 0.45, metalness: 0.72 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x3b4434, roughness: 0.78, metalness: 0.18 });
    const caseMat = new THREE.MeshStandardMaterial({ color: 0x26292f, roughness: 0.55, metalness: 0.35 });
    const commsRedMat = new THREE.MeshStandardMaterial({ color: 0x8f2d2d, roughness: 0.58, metalness: 0.42 });
    const medMat = new THREE.MeshStandardMaterial({ color: 0xd4d9df, roughness: 0.72, metalness: 0.12 });
    const fobScreenMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 1.1,
      roughness: 0.2,
    });
    const helipadMat = new THREE.MeshStandardMaterial({ color: 0x2e343c, roughness: 0.88, metalness: 0.15 });

    this.sharedMaterials.push(
      concreteMat,
      steelMat,
      crateMat,
      caseMat,
      commsRedMat,
      medMat,
      fobScreenMat,
      helipadMat,
    );

    for (const lm of OPENWORLD_LANDMARKS) {
      const groundY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(lm.worldX, lm.worldZ));
      const isFob = lm.poiRole === 'fob';
      const contractId = CONTRACT_BY_LANDMARK[lm.id] ?? null;

      // Place FOB Logistics/Quartermaster terminal or Contract terminal cleanly offset from flagpole
      const terminalX = lm.worldX + (isFob ? -6.8 : 6.5);
      const terminalZ = lm.worldZ + 6.5;
      const termY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(terminalX, terminalZ));
      const initialOwner: SectorControlOwner = lm.pmcFactionId ?? 'neutral';

      const state: SectorRuntimeState = {
        sectorId: lm.id,
        name: lm.name,
        shortLabel: lm.shortLabel,
        biomeId: lm.biomeId,
        poiRole: lm.poiRole,
        worldX: lm.worldX,
        worldZ: lm.worldZ,
        groundY,
        isFob,
        commsCoverageRadiusM: lm.commsCoverageRadiusM,
        supplyResource: lm.supplyResource,
        homeFaction: lm.pmcFactionId,
        subFactionId: lm.subFactionId,
        contractId,
        supplyYield: SECTOR_SUPPLY_YIELDS[lm.id] ?? { ammo: 8, medical: 8 },
        owner: initialOwner,
        alertState: initialOwner === 'neutral' ? 'calm' : 'captured',
        liveCapturePct: initialOwner !== 'neutral' ? 100 : 0,
        contested: false,
        hostileGarrisonCount: 0,
        terminalX,
        terminalZ,
        alertDecaySec: 0,
      };
      this.sectors.set(lm.id, state);

      const g = new THREE.Group();
      g.name = `sector_beacon_${lm.id}`;
      g.position.set(lm.worldX, groundY, lm.worldZ);

      const pad = new THREE.Mesh(padGeo, concreteMat);
      pad.position.y = 0.14;
      pad.receiveShadow = true;

      const mast = new THREE.Mesh(mastGeo, steelMat);
      mast.position.y = 5.75;

      const crossBar = new THREE.Mesh(crossBarGeo, steelMat);
      crossBar.position.set(0, 10.6, 0);

      const flagMat = new THREE.MeshStandardMaterial({
        color: OWNER_COLORS[state.owner],
        roughness: 0.72,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      const beaconMat = new THREE.MeshStandardMaterial({
        color: OWNER_COLORS[state.owner],
        emissive: OWNER_COLORS[state.owner],
        emissiveIntensity: 1.15,
        roughness: 0.25,
        metalness: 0.4,
      });
      const ringMat = new THREE.MeshBasicMaterial({
        color: OWNER_COLORS[state.owner],
        transparent: true,
        opacity: isFob ? 0.16 : 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.sharedMaterials.push(flagMat, beaconMat, ringMat);

      const flagMesh = new THREE.Mesh(flagGeo, flagMat);
      flagMesh.position.set(0.1, 9.85, 0);

      const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
      beaconMesh.position.y = lm.poiRole === 'comms_tower' ? 24.4 : 11.95;

      const radioCrate = new THREE.Mesh(crateGeo, crateMat);
      radioCrate.position.set(1.4, 0.56, 0.8);

      const radioAnt = new THREE.Mesh(antennaGeo, steelMat);
      radioAnt.position.set(1.85, 1.5, 0.8);

      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.y = 0.25;

      g.add(pad, mast, crossBar, flagMesh, beaconMesh, radioCrate, radioAnt, ringMesh);

      // Distinct Phase 4 3D Landmark Silhouettes for Comms Towers & Supply Depots
      if (lm.poiRole === 'comms_tower') {
        const tower = new THREE.Mesh(commsTowerGeo, commsRedMat);
        tower.position.set(0, 12.0, -3.2);
        const dish1 = new THREE.Mesh(dishGeo, medMat);
        dish1.position.set(0, 18.5, -2.0);
        const dish2 = new THREE.Mesh(dishGeo, medMat);
        dish2.position.set(0.9, 15.2, -3.2);
        dish2.rotation.y = Math.PI * 0.5;
        g.add(tower, dish1, dish2);
      } else if (lm.poiRole === 'supply_depot' && lm.kind === 'supply_depot') {
        const bunker = new THREE.Mesh(
          depotBunkerGeo,
          lm.supplyResource === 'medical' ? medMat : concreteMat,
        );
        bunker.position.set(0, 1.55, -5.8);
        const tank = new THREE.Mesh(fuelTankGeo, steelMat);
        tank.position.set(5.4, 1.15, -4.4);
        g.add(bunker, tank);
      }

      // Physical In-World FOB Logistics & Quartermaster Terminal + Tier 2/3 Upgrade Structures
      let fobTier2Group: THREE.Group | null = null;
      let fobTier3Group: THREE.Group | null = null;

      if (isFob) {
        const termGroup = new THREE.Group();
        termGroup.name = `fob_logistics_terminal_${lm.id}`;
        termGroup.position.set(terminalX, termY, terminalZ);

        const desk = new THREE.Mesh(fobConsoleDeskGeo, caseMat);
        desk.position.y = 0.48;
        const screen = new THREE.Mesh(fobScreenGeo, fobScreenMat);
        screen.position.set(0, 1.32, -0.18);
        const ant = new THREE.Mesh(antennaGeo, steelMat);
        ant.position.set(0.95, 1.65, -0.2);
        termGroup.add(desk, screen, ant);
        this.rootGroup.add(termGroup);

        // Tier 2 Physical FOB Upgrade (Optics Workbench + Surgical Bay Shelter)
        fobTier2Group = new THREE.Group();
        fobTier2Group.name = `fob_tier2_${lm.id}`;
        const shelter = new THREE.Mesh(tier2ShelterGeo, medMat);
        shelter.position.set(-10.5, 1.7, -5.0);
        const bench = new THREE.Mesh(tier2BenchGeo, crateMat);
        bench.position.set(-10.5, 0.55, 1.8);
        fobTier2Group.add(shelter, bench);
        fobTier2Group.visible = false;
        g.add(fobTier2Group);

        // Tier 3 Physical FOB Upgrade (Reinforced Helipad + Twin Perimeter Turret Towers)
        fobTier3Group = new THREE.Group();
        fobTier3Group.name = `fob_tier3_${lm.id}`;
        const helipad = new THREE.Mesh(tier3HelipadGeo, helipadMat);
        helipad.position.set(13.5, 0.18, -7.5);
        for (const [tx, tz] of [
          [-15.5, 11.5],
          [15.5, 11.5],
        ]) {
          const tBase = new THREE.Mesh(tier3TurretBaseGeo, concreteMat);
          tBase.position.set(tx, 2.2, tz);
          const tHead = new THREE.Mesh(tier3TurretHeadGeo, steelMat);
          tHead.position.set(tx, 4.85, tz);
          fobTier3Group.add(tBase, tHead);
        }
        fobTier3Group.add(helipad);
        fobTier3Group.visible = false;
        g.add(fobTier3Group);
      }

      this.rootGroup.add(g);

      let contractScreenMat: THREE.MeshStandardMaterial | null = null;
      if (contractId) {
        const termGroup = new THREE.Group();
        termGroup.name = `contract_terminal_${contractId}`;
        termGroup.position.set(terminalX, termY, terminalZ);

        const pelican = new THREE.Mesh(caseGeo, caseMat);
        pelican.position.y = 0.26;
        const base = new THREE.Mesh(laptopBaseGeo, steelMat);
        base.position.set(0, 0.55, 0);
        contractScreenMat = new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x0284c7,
          emissiveIntensity: 0.9,
          roughness: 0.2,
          metalness: 0.2,
        });
        this.sharedMaterials.push(contractScreenMat);
        const lid = new THREE.Mesh(laptopLidGeo, contractScreenMat);
        lid.position.set(0, 0.72, -0.18);
        lid.rotation.x = -0.22;
        const ant = new THREE.Mesh(antennaGeo, steelMat);
        ant.position.set(0.36, 0.9, -0.22);

        termGroup.add(pelican, base, lid, ant);
        this.rootGroup.add(termGroup);
      }

      this.visuals.set(lm.id, {
        sectorId: lm.id,
        flagMesh,
        beaconMesh,
        ringMesh,
        flagMat,
        beaconMat,
        ringMat,
        contractScreenMat,
        fobTier2Group,
        fobTier3Group,
      });
    }
  }

  public syncFromShard(mode: ShardMode, activeCharacter?: OpenWorldCharacter | null): void {
    this.activeShardMode = mode;
    const shard = this.shards.getShard(mode);
    const completedSet = new Set(activeCharacter?.unlocks.completedContractIds ?? []);

    for (const sector of this.sectors.values()) {
      const persisted = shard.sectors[sector.sectorId];
      if (persisted) {
        sector.owner = persisted.owner;
        if (activeCharacter && persisted.owner === activeCharacter.pmcFaction) {
          sector.liveCapturePct = 100;
          if (sector.alertState !== 'contested' && sector.alertState !== 'alerted') {
            sector.alertState = 'captured';
          }
        } else if (persisted.owner === 'neutral') {
          sector.liveCapturePct = Math.min(sector.liveCapturePct, 99);
          if (sector.alertState === 'captured') {
            sector.alertState = 'calm';
          }
        }
      }
      const vis = this.visuals.get(sector.sectorId);
      if (vis) {
        const hex = OWNER_COLORS[sector.owner];
        vis.flagMat.color.setHex(hex);
        vis.beaconMat.color.setHex(hex);
        vis.beaconMat.emissive.setHex(hex);
        vis.ringMat.color.setHex(hex);
        if (vis.contractScreenMat && sector.contractId) {
          const done = completedSet.has(sector.contractId);
          vis.contractScreenMat.color.setHex(done ? 0x22c55e : 0xf59e0b);
          vis.contractScreenMat.emissive.setHex(done ? 0x15803d : 0xd97706);
        }
        if (sector.isFob && sector.homeFaction) {
          const tier: FobTier = shard.fobTiers[sector.homeFaction] ?? 1;
          if (vis.fobTier2Group) vis.fobTier2Group.visible = tier >= 2;
          if (vis.fobTier3Group) vis.fobTier3Group.visible = tier >= 3;
        }
      }
    }
  }

  /**
   * Transitions nearby non-FOB sectors from `calm` -> `alerted` upon gunfire or explosions.
   */
  public notifyCombatAlert(originX: number, originZ: number, radiusM = 135): void {
    for (const sector of this.sectors.values()) {
      if (sector.isFob) continue;
      if (Math.hypot(originX - sector.worldX, originZ - sector.worldZ) <= radiusM) {
        sector.alertDecaySec = 45;
        if (sector.alertState === 'calm') {
          sector.alertState = 'alerted';
        }
      }
    }
  }

  /**
   * Forces a sector into `contested` state (used by Dynamic World Event: Sector Counter-Assault).
   */
  public markSectorContested(sectorId: string): void {
    const s = this.sectors.get(sectorId);
    if (!s || s.isFob) return;
    s.contested = true;
    s.alertState = 'contested';
    s.alertDecaySec = 90;
  }

  /**
   * Returns all Comms Tower regional blackout zones where `faction` does NOT control the relay tower.
   * Used directly by the 3D handheld Tactical PDA to render regional Fog-of-War static overlays.
   */
  public getCommsBlackoutZonesForFaction(faction: PmcFactionId): CommsBlackoutZone[] {
    const out: CommsBlackoutZone[] = [];
    for (const s of this.sectors.values()) {
      if (s.poiRole !== 'comms_tower' || !s.commsCoverageRadiusM) continue;
      if (s.owner !== faction) {
        out.push({
          sectorId: s.sectorId,
          label: s.shortLabel,
          x: s.worldX,
          z: s.worldZ,
          radiusM: s.commsCoverageRadiusM,
          owner: s.owner,
        });
      }
    }
    return out;
  }

  /**
   * Returns true if world coordinate `(x, z)` is covered by a friendly Comms Tower relay
   * OR lies outside every uncaptured Comms Tower blackout zone.
   */
  public isPointCoveredByComms(x: number, z: number, faction: PmcFactionId): boolean {
    let blockedByUncaptured = false;
    for (const s of this.sectors.values()) {
      if (s.poiRole !== 'comms_tower' || !s.commsCoverageRadiusM) continue;
      if (Math.hypot(x - s.worldX, z - s.worldZ) <= s.commsCoverageRadiusM) {
        if (s.owner === faction) {
          return true;
        }
        blockedByUncaptured = true;
      }
    }
    return !blockedByUncaptured;
  }

  /**
   * Advances 4-state sector machine, supply depot passive ticks, and flag wind motion (zero allocations).
   */
  public update(
    dt: number,
    playerX: number,
    playerZ: number,
    character: OpenWorldCharacter | null,
    getHostileGarrisonCount: (sectorId: string) => number,
  ): SectorCaptureCompleteEvent | null {
    this.waveTime += dt;
    let captureEvent: SectorCaptureCompleteEvent | null = null;

    // Periodic Supply Depot passive supply ticks (every 90s for controlled depots)
    this.supplyDepotTickAccum += dt;
    if (this.supplyDepotTickAccum >= SUPPLY_DEPOT_TICK_INTERVAL_SEC) {
      this.supplyDepotTickAccum = 0;
      const alphaDelta: Partial<FactionSupplyPool> = {};
      const bravoDelta: Partial<FactionSupplyPool> = {};
      let alphaAny = false;
      let bravoAny = false;
      for (const s of this.sectors.values()) {
        if (s.poiRole !== 'supply_depot' || !s.supplyResource) continue;
        if (s.owner === 'pmc_alpha') {
          alphaDelta[s.supplyResource] = (alphaDelta[s.supplyResource] ?? 0) + 3;
          alphaAny = true;
        } else if (s.owner === 'pmc_bravo') {
          bravoDelta[s.supplyResource] = (bravoDelta[s.supplyResource] ?? 0) + 3;
          bravoAny = true;
        }
      }
      if (alphaAny) {
        this.shards.adjustPmcSupply(
          this.activeShardMode,
          'pmc_alpha',
          alphaDelta,
          'sector_flip',
          'Controlled Supply Depots delivered logistics tick to PMC Alpha',
        );
      }
      if (bravoAny) {
        this.shards.adjustPmcSupply(
          this.activeShardMode,
          'pmc_bravo',
          bravoDelta,
          'sector_flip',
          'Controlled Supply Depots delivered logistics tick to PMC Bravo',
        );
      }
    }

    for (const sector of this.sectors.values()) {
      const vis = this.visuals.get(sector.sectorId);
      if (vis) {
        vis.flagMesh.rotation.y = Math.sin(this.waveTime * 2.4 + sector.worldX * 0.01) * 0.16;
        vis.beaconMesh.rotation.y += dt * 0.85;
      }

      const hostiles = getHostileGarrisonCount(sector.sectorId);
      sector.hostileGarrisonCount = hostiles;

      if (sector.alertDecaySec > 0) {
        sector.alertDecaySec = Math.max(0, sector.alertDecaySec - dt);
      }

      if (sector.isFob || !character) {
        sector.contested = false;
        sector.alertState = 'captured';
        continue;
      }

      const dist = Math.hypot(playerX - sector.worldX, playerZ - sector.worldZ);
      const inZone = dist <= SECTOR_CAPTURE_RADIUS_M;

      if (sector.owner === character.pmcFaction) {
        sector.liveCapturePct = 100;
        sector.contested = inZone && hostiles > 0;
        sector.alertState = sector.contested
          ? 'contested'
          : sector.alertDecaySec > 0
            ? 'alerted'
            : 'captured';
        continue;
      }

      if (inZone) {
        if (hostiles > 0) {
          sector.contested = true;
          sector.alertState = 'contested';
        } else {
          sector.contested = false;
          sector.alertState = 'contested';
          sector.liveCapturePct = Math.min(100, sector.liveCapturePct + SECTOR_CAPTURE_RATE_PER_SEC * dt);
          if (sector.liveCapturePct >= 100) {
            const flip = this.shards.flipSector(
              character.shardMode,
              sector.sectorId,
              character.pmcFaction,
              character.callsign,
              sector.name,
              sector.supplyYield,
            );
            sector.owner = flip.sector.owner;
            sector.alertState = 'captured';
            this.roster.adjustCash(character.slotId, SECTOR_CAPTURE_CASH_BONUS);
            this.syncFromShard(character.shardMode, this.roster.getCharacter(character.slotId));
            captureEvent = {
              sectorId: sector.sectorId,
              sectorName: sector.name,
              poiRole: sector.poiRole,
              newOwner: character.pmcFaction,
              cashBonusUsd: SECTOR_CAPTURE_CASH_BONUS,
              supplyBonus: { ...sector.supplyYield },
            };
          }
        }
      } else {
        sector.contested = false;
        if (sector.liveCapturePct > 0) {
          sector.liveCapturePct = Math.max(0, sector.liveCapturePct - 6 * dt);
        }
        if (dist <= SECTOR_CAPTURE_RADIUS_M * 1.9) {
          sector.alertState = 'alerted';
        } else if (sector.alertDecaySec <= 0) {
          sector.alertState = sector.owner === 'neutral' ? 'calm' : 'captured';
        }
      }
    }

    return captureEvent;
  }

  /**
   * Scans for nearest actionable 3D interactable:
   * - In-World Home FOB Logistics & Quartermaster Terminal (`fob_terminal` — ONLY place for FOB Tier 1-3 Upgrades & Supply-Coupled Trader!)
   * - Home FOB Medbay & Resupply (`fob_resupply`)
   * - Biome Contract Terminals (`contract`)
   * - Dropped Shard Corpses (`corpse`)
   */
  public findNearestInteractable(
    playerX: number,
    playerZ: number,
    character: OpenWorldCharacter | null,
  ): OpenWorldInteractableContext | null {
    let best: OpenWorldInteractableContext | null = null;
    let bestDist = 9.0;

    if (character) {
      const completed = new Set(character.unlocks.completedContractIds);
      const fobTier = this.shards.getFobTier(character.shardMode, character.pmcFaction);

      // 1. In-World Home FOB Logistics & Quartermaster Terminal
      for (const sector of this.sectors.values()) {
        if (!sector.isFob || sector.homeFaction !== character.pmcFaction) continue;
        const dTerm = Math.hypot(playerX - sector.terminalX, playerZ - sector.terminalZ);
        if (dTerm < bestDist) {
          bestDist = dTerm;
          best = {
            kind: 'fob_terminal',
            id: sector.sectorId,
            label: `FOB Logistics & Quartermaster Terminal (${sector.shortLabel} · Tier ${fobTier})`,
            sublabel: 'Fund Tier 1–3 FOB Upgrades, Supply-Coupled Trader Stock & 3-Slot Contract Board',
            distanceM: dTerm,
            canExecute: true,
          };
        }

        const dFob = Math.hypot(playerX - sector.worldX, playerZ - sector.worldZ);
        if (dFob < bestDist) {
          bestDist = dFob;
          best = {
            kind: 'fob_resupply',
            id: sector.sectorId,
            label: `FOB Surgical Medbay (${sector.shortLabel})`,
            sublabel: 'Restore 100% HP, cure bleeding/leg trauma & repair Armor Plate',
            distanceM: dFob,
            canExecute: true,
          };
        }
      }

      // 2. Biome Contract Terminals
      for (const sector of this.sectors.values()) {
        if (!sector.contractId) continue;
        const d = Math.hypot(playerX - sector.terminalX, playerZ - sector.terminalZ);
        if (d < bestDist) {
          const spec: OpenWorldContractSpec | undefined = OPENWORLD_CONTRACT_MAP[sector.contractId];
          if (!spec) continue;
          const alreadyDone = completed.has(spec.id);
          const blockedByHostiles = !alreadyDone && sector.hostileGarrisonCount > 0;
          bestDist = d;
          best = {
            kind: 'contract',
            id: spec.id,
            label: alreadyDone ? `${spec.title} (Completed)` : `Complete Contract: ${spec.title}`,
            sublabel: alreadyDone
              ? 'Intel already uploaded for this character'
              : blockedByHostiles
                ? `Clear ${sector.hostileGarrisonCount} hostile garrison contact(s) first`
                : `+$${spec.cashRewardUsd.toLocaleString()} · Unlocks ${spec.unlocksWeaponIds.length} weapons / ${spec.unlocksAttachmentIds.length} optics`,
            distanceM: d,
            canExecute: !alreadyDone && !blockedByHostiles,
            blockedReason: alreadyDone
              ? 'Contract already completed.'
              : blockedByHostiles
                ? `Clear ${sector.hostileGarrisonCount} hostile contact(s) in ${sector.shortLabel} first.`
                : undefined,
          };
        }
      }

      // 3. Dropped Shard Corpses (enforces PvPvE vs PvE corpse looting rules)
      const shard = this.shards.getShard(character.shardMode);
      for (const corpse of shard.corpses) {
        const d = Math.hypot(playerX - corpse.worldX, playerZ - corpse.worldZ);
        if (d < bestDist) {
          const allowed = this.shards.canCharacterLootCorpse(
            character.shardMode,
            corpse.corpseId,
            character.characterId,
          );
          bestDist = d;
          best = {
            kind: 'corpse',
            id: corpse.corpseId,
            label: `Loot Corpse: ${corpse.ownerCallsign}`,
            sublabel: allowed
              ? `Opens Tetris Corpse Loot (${corpse.droppedWeaponIds.length} weapons · Rig & Backpack)`
              : 'Protected by PvE Cooperative Shard rules (owner-only recovery)',
            distanceM: d,
            canExecute: allowed,
            blockedReason: allowed
              ? undefined
              : "PvE Cooperative Shard rules prevent looting another player's corpse.",
          };
        }
      }
    }

    return best;
  }

  public executeContractTerminal(
    contractId: string,
    character: OpenWorldCharacter,
  ): { ok: boolean; message: string } {
    const spec = OPENWORLD_CONTRACT_MAP[contractId];
    if (!spec) return { ok: false, message: 'Unknown contract terminal.' };

    const sector = Array.from(this.sectors.values()).find((s) => s.contractId === contractId);
    if (sector && sector.hostileGarrisonCount > 0) {
      return {
        ok: false,
        message: `Eliminate ${sector.hostileGarrisonCount} hostile(s) guarding ${sector.shortLabel} before uploading intel.`,
      };
    }

    const res = this.roster.completeContract(character.slotId, contractId);
    if (!res.ok) {
      return { ok: false, message: res.error ?? 'Contract completion failed.' };
    }

    this.shards.recordDiscreteTransition(
      character.shardMode,
      'contract_completed',
      `${character.callsign} completed "${spec.title}" (+$${spec.cashRewardUsd.toLocaleString()})`,
    );

    if (spec.subFactionId) {
      const sf = SUB_FACTION_MAP[spec.subFactionId];
      this.shards.adjustPmcSupply(
        character.shardMode,
        character.pmcFaction,
        { intel: 8, ammo: 5 },
        'reputation_update',
        `${character.callsign} gained +${spec.standingDelta} standing with ${sf.shortName}`,
      );
    }

    this.syncFromShard(character.shardMode, this.roster.getCharacter(character.slotId));
    return {
      ok: true,
      message: `Contract Complete: ${spec.title} (+$${spec.cashRewardUsd.toLocaleString()}, unlocked ${spec.unlocksWeaponIds.length} weapon(s) & ${spec.unlocksAttachmentIds.length} optic(s))`,
    };
  }

  public getSectorsSnapshot(): SectorRuntimeState[] {
    return Array.from(this.sectors.values()).map((s) => ({ ...s }));
  }

  public getActiveSectorAt(x: number, z: number): SectorRuntimeState | null {
    for (const s of this.sectors.values()) {
      if (Math.hypot(x - s.worldX, z - s.worldZ) <= SECTOR_CAPTURE_RADIUS_M) {
        return { ...s };
      }
    }
    return null;
  }

  public getAllContracts(): readonly OpenWorldContractSpec[] {
    return OPENWORLD_CONTRACT_CATALOG;
  }

  public dispose(): void {
    if (this.rootGroup.parent) {
      this.rootGroup.parent.remove(this.rootGroup);
    }
    for (const g of this.sharedGeometries) g.dispose();
    for (const m of this.sharedMaterials) m.dispose();
    this.sharedGeometries.length = 0;
    this.sharedMaterials.length = 0;
    this.visuals.clear();
    this.sectors.clear();
  }
}

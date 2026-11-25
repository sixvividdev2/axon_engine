import * as THREE from 'three';
import { CharacterRoster } from '../CharacterRoster';
import { ShardStore } from '../ShardStore';
import {
  FactionSupplyPool,
  FobTier,
  getStandingTier,
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
  TRADER_MAP,
} from '../types';
import {
  OPENWORLD_LANDMARKS,
  OpenWorldLandmarkSpec,
  OpenWorldPoiRole,
  SEA_LEVEL_M,
} from './OpenWorldTerrain';
import {
  fobLocalToWorld,
  getFobArmoryStashAnchor,
  getFobCompoundSpec,
  getFobFieldHospitalAnchor,
  getFobHelipadAnchor,
  getFobTerminalAnchor,
  getFobVehicleRepairBayAnchor,
  isFobCompoundId,
} from './OpenWorldFobLayout';

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
  /** Signed capture progress (-100 = Bravo, 0 = Neutral/Subfaction, +100 = Alpha) */
  signedCaptureProgress: number;
  /** Dynamic combat escalation heat (0..100) */
  heat: number;
  contested: boolean;
  hostileGarrisonCount: number;
  terminalX: number;
  terminalZ: number;
  medbayX: number;
  medbayZ: number;
  armoryX: number;
  armoryZ: number;
  helipadX: number;
  helipadZ: number;
  repairBayX: number;
  repairBayZ: number;
  subFactionStashX?: number;
  subFactionStashZ?: number;
  subFactionMedicX?: number;
  subFactionMedicZ?: number;
  subFactionMarketX?: number;
  subFactionMarketZ?: number;
  alertDecaySec: number;
}

export interface FobDefenseTurretHandle {
  readonly sectorId: string;
  readonly faction: PmcFactionId;
  readonly role: 'aa_autocannon' | 'mortar';
  readonly headMesh: THREE.Mesh;
  readonly barrelMesh: THREE.Mesh;
  readonly muzzleFlashMesh: THREE.Mesh;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  fireCooldown: number;
  muzzleFlashTimer: number;
}

export interface FastTravelDestination {
  readonly sectorId: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly worldX: number;
  readonly worldZ: number;
  readonly owner: SectorControlOwner;
  readonly isFob: boolean;
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
    | 'armory_stash'
    | 'fob_vehicle_repair'
    | 'fob_helipad_travel'
    | 'subfaction_stash'
    | 'subfaction_medic'
    | 'subfaction_black_market'
    | 'corpse'
    | 'wildlife_harvest'
    | 'convoy_hijack'
    | 'world_event_crate'
    | 'electronic_repair';
  id: string;
  label: string;
  sublabel: string;
  distanceM: number;
  canExecute: boolean;
  blockedReason?: string;
  subFactionId?: SubFactionId;
  holdToRepair?: boolean;
  repairProgress?: number;
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
  subfaction: 0xd97706,
  contested: 0xf97316,
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
 * 3 Regional Comms Towers (PDA Fog-of-War), 4 Supply Depots, Physical FOB Tier 1-3 Upgrades
 * (including live AA/Mortar perimeter turrets, Vehicle Repair Bay & Fast-Travel Helipad at Tier 3),
 * Trusted Sub-Faction POI Stations (Forward Stash, Field Medic, Black-Market Terminal),
 * In-World FOB Logistics/Quartermaster Terminals, and Biome Contracts.
 * - Commits discrete `sector_flip`, `contract_completed`, and supply tick writes to ShardStore & CharacterRoster.
 * - Zero per-frame heap allocations; explicit `.dispose()` teardown.
 */
export class OpenWorldSectorManager {
  public readonly rootGroup = new THREE.Group();
  private readonly sectors = new Map<string, SectorRuntimeState>();
  private readonly visuals = new Map<string, SectorVisualHandle>();
  private readonly fobTurrets: FobDefenseTurretHandle[] = [];
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
    const tier3HeliRingGeo = new THREE.RingGeometry(4.8, 5.9, 32);
    tier3HeliRingGeo.rotateX(-Math.PI * 0.5);
    const tier3TurretBaseGeo = new THREE.CylinderGeometry(0.85, 1.05, 4.4, 8);
    const tier3TurretHeadGeo = new THREE.BoxGeometry(1.45, 0.95, 1.9);
    const tier3BarrelGeo = new THREE.CylinderGeometry(0.08, 0.11, 2.3, 8);
    tier3BarrelGeo.rotateX(Math.PI * 0.5);
    const tier3FlashGeo = new THREE.OctahedronGeometry(0.45, 0);
    const repairGantryGeo = new THREE.BoxGeometry(6.8, 0.35, 0.45);
    const repairPostGeo = new THREE.BoxGeometry(0.32, 3.6, 0.32);
    const subFactionLockerGeo = new THREE.BoxGeometry(1.5, 1.65, 0.75);
    const subFactionMedicTentGeo = new THREE.BoxGeometry(3.2, 2.35, 2.6);

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
      tier3HeliRingGeo,
      tier3TurretBaseGeo,
      tier3TurretHeadGeo,
      tier3BarrelGeo,
      tier3FlashGeo,
      repairGantryGeo,
      repairPostGeo,
      subFactionLockerGeo,
      subFactionMedicTentGeo,
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
    const helipadMat = new THREE.MeshStandardMaterial({
      color: 0xd99b26,
      roughness: 0.72,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });

    const turretFlashMat = new THREE.MeshBasicMaterial({
      color: 0xfde047,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    const blackMarketScreenMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 1.0,
      roughness: 0.25,
    });

    this.sharedMaterials.push(
      concreteMat,
      steelMat,
      crateMat,
      caseMat,
      commsRedMat,
      medMat,
      fobScreenMat,
      helipadMat,
      turretFlashMat,
      blackMarketScreenMat,
    );

    for (const lm of OPENWORLD_LANDMARKS) {
      const isFob = lm.poiRole === 'fob';
      const rawGroundY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(lm.worldX, lm.worldZ));
      const groundY = isFob ? Math.max(rawGroundY, lm.targetElevationM + 0.08) : rawGroundY;
      const contractId = CONTRACT_BY_LANDMARK[lm.id] ?? null;

      // Place FOB Logistics/Quartermaster terminal, Field Hospital & Armory Lockers on exact FOB compound anchors
      const fobTerm = isFobCompoundId(lm.id) ? getFobTerminalAnchor(lm.id) : null;
      const fobHosp = isFobCompoundId(lm.id) ? getFobFieldHospitalAnchor(lm.id) : null;
      const fobArmory = isFobCompoundId(lm.id) ? getFobArmoryStashAnchor(lm.id) : null;
      const fobHeli = isFobCompoundId(lm.id) ? getFobHelipadAnchor(lm.id) : null;
      const fobRepair = isFobCompoundId(lm.id) ? getFobVehicleRepairBayAnchor(lm.id) : null;

      const terminalX = fobTerm ? fobTerm.worldX : lm.worldX + 6.5;
      const terminalZ = fobTerm ? fobTerm.worldZ : lm.worldZ + 6.5;
      const medbayX = fobHosp ? fobHosp.worldX : lm.worldX;
      const medbayZ = fobHosp ? fobHosp.worldZ : lm.worldZ;
      const armoryX = fobArmory ? fobArmory.worldX : lm.worldX;
      const armoryZ = fobArmory ? fobArmory.worldZ : lm.worldZ;
      const helipadX = fobHeli ? fobHeli.worldX : lm.worldX;
      const helipadZ = fobHeli ? fobHeli.worldZ : lm.worldZ;
      const repairBayX = fobRepair ? fobRepair.worldX : lm.worldX;
      const repairBayZ = fobRepair ? fobRepair.worldZ : lm.worldZ;

      const hasSubFactionPoi = Boolean(!isFob && lm.subFactionId);
      const subFactionStashX = hasSubFactionPoi ? lm.worldX - 11.5 : undefined;
      const subFactionStashZ = hasSubFactionPoi ? lm.worldZ + 8.5 : undefined;
      const subFactionMedicX = hasSubFactionPoi ? lm.worldX - 15.5 : undefined;
      const subFactionMedicZ = hasSubFactionPoi ? lm.worldZ - 7.5 : undefined;
      const subFactionMarketX = hasSubFactionPoi ? lm.worldX + 12.5 : undefined;
      const subFactionMarketZ = hasSubFactionPoi ? lm.worldZ - 9.5 : undefined;

      const rawTermY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(terminalX, terminalZ));
      const termY = fobTerm ? Math.max(rawTermY, fobTerm.worldY) : rawTermY;
      const initialOwner: SectorControlOwner = lm.pmcFactionId ?? (lm.subFactionId ? 'subfaction' : 'neutral');

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
        alertState: initialOwner === 'pmc_alpha' || initialOwner === 'pmc_bravo' ? 'captured' : 'calm',
        liveCapturePct: initialOwner === 'pmc_alpha' || initialOwner === 'pmc_bravo' ? 100 : 0,
        signedCaptureProgress:
          initialOwner === 'pmc_alpha' ? 100 : initialOwner === 'pmc_bravo' ? -100 : 0,
        heat: 0,
        contested: false,
        hostileGarrisonCount: 0,
        terminalX,
        terminalZ,
        medbayX,
        medbayZ,
        armoryX,
        armoryZ,
        helipadX,
        helipadZ,
        repairBayX,
        repairBayZ,
        subFactionStashX,
        subFactionStashZ,
        subFactionMedicX,
        subFactionMedicZ,
        subFactionMarketX,
        subFactionMarketZ,
        alertDecaySec: 0,
      };
      this.sectors.set(lm.id, state);

      const fobSpec = isFob && isFobCompoundId(lm.id) ? getFobCompoundSpec(lm.id) : null;
      const beaconXZ = fobSpec ? fobLocalToWorld(fobSpec, -14.0, 18.0) : { x: lm.worldX, z: lm.worldZ };
      const beaconY = fobSpec ? fobSpec.baseY + 0.08 : groundY;

      const g = new THREE.Group();
      g.name = `sector_beacon_${lm.id}`;
      g.position.set(beaconXZ.x, beaconY, beaconXZ.z);
      if (fobSpec) g.rotation.y = fobSpec.yaw;

      const pad = new THREE.Mesh(padGeo, concreteMat);
      pad.position.y = 0.14;
      pad.receiveShadow = true;

      const mast = new THREE.Mesh(mastGeo, steelMat);
      mast.position.y = 6.03;

      const crossBar = new THREE.Mesh(crossBarGeo, steelMat);
      crossBar.position.set(0, 10.88, 0);

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
        opacity: isFob ? 0.0 : 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.sharedMaterials.push(flagMat, beaconMat, ringMat);

      const flagMesh = new THREE.Mesh(flagGeo, flagMat);
      flagMesh.position.set(0.1, 10.13, 0);

      const beaconMesh = new THREE.Mesh(beaconGeo, beaconMat);
      beaconMesh.position.y = lm.poiRole === 'comms_tower' ? 24.4 : 12.23;
      beaconMesh.name = `sector_beacon_lamp_${lm.id}`;
      beaconMesh.userData.electronicKind = 'beacon';
      beaconMesh.userData.electronicLabel = `${lm.shortLabel} Sector Beacon`;
      beaconMesh.userData.electronicHp = 28;
      beaconMesh.userData.repairable = true;

      const radioCrate = new THREE.Mesh(crateGeo, crateMat);
      radioCrate.position.set(1.4, 0.705, 0.8);

      const radioAnt = new THREE.Mesh(antennaGeo, steelMat);
      radioAnt.position.set(1.85, 1.855, 0.8);

      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.position.y = 0.25;
      ringMesh.visible = !isFob;

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

      if (isFob && fobSpec) {
        const termGroup = new THREE.Group();
        termGroup.name = `fob_logistics_terminal_${lm.id}`;
        termGroup.position.set(terminalX, termY, terminalZ);
        if (fobTerm) termGroup.rotation.y = fobTerm.yaw;

        const desk = new THREE.Mesh(fobConsoleDeskGeo, caseMat);
        desk.position.y = 0.48;
        const localFobScreenMat = fobScreenMat.clone();
        this.sharedMaterials.push(localFobScreenMat);
        const screen = new THREE.Mesh(fobScreenGeo, localFobScreenMat);
        screen.name = `fob_terminal_screen_${lm.id}`;
        screen.position.set(0, 1.32, -0.18);
        screen.userData.electronicKind = 'screen';
        screen.userData.electronicLabel = `${lm.shortLabel} FOB Command Terminal`;
        screen.userData.electronicHp = 45;
        screen.userData.interactiveLinkId = `fob_terminal:${lm.id}`;
        screen.userData.repairable = true;
        screen.userData.repairDurationSec = 2.2;
        const ant = new THREE.Mesh(antennaGeo, steelMat);
        ant.position.set(0.95, 1.65, -0.2);
        termGroup.add(desk, screen, ant);
        this.rootGroup.add(termGroup);

        // Tier 2 Physical FOB Upgrade (Exterior Logistics Supply Wing + Armory Optics Workbench, clear of all buildings)
        fobTier2Group = new THREE.Group();
        fobTier2Group.name = `fob_tier2_${lm.id}`;
        fobTier2Group.position.set(fobSpec.worldX, fobSpec.baseY, fobSpec.worldZ);
        fobTier2Group.rotation.y = fobSpec.yaw;
        const shelter = new THREE.Mesh(tier2ShelterGeo, medMat);
        shelter.position.set(-17.5, 1.78, -4.0);
        const bench = new THREE.Mesh(tier2BenchGeo, crateMat);
        bench.position.set(10.2, 0.605, -6.8);
        fobTier2Group.add(shelter, bench);
        fobTier2Group.visible = false;
        this.rootGroup.add(fobTier2Group);

        // Tier 3 Physical FOB Upgrade (Live AA/Mortar Perimeter Turrets + Vehicle Repair Bay + Fast-Travel Helipad)
        const heliAnchor = getFobHelipadAnchor(fobSpec.id);
        const repairAnchor = getFobVehicleRepairBayAnchor(fobSpec.id);
        fobTier3Group = new THREE.Group();
        fobTier3Group.name = `fob_tier3_${lm.id}`;
        fobTier3Group.position.set(fobSpec.worldX, fobSpec.baseY, fobSpec.worldZ);
        fobTier3Group.rotation.y = fobSpec.yaw;

        // Helipad Tier 3 beacon ring
        const helipad = new THREE.Mesh(tier3HeliRingGeo, helipadMat);
        helipad.position.set(heliAnchor.localX, 0.175, heliAnchor.localZ);
        fobTier3Group.add(helipad);

        // Vehicle Repair & Refuel Bay Gantry
        const repairGantry = new THREE.Mesh(repairGantryGeo, helipadMat);
        repairGantry.position.set(repairAnchor.localX, 3.68, repairAnchor.localZ);
        const postL = new THREE.Mesh(repairPostGeo, steelMat);
        postL.position.set(repairAnchor.localX - 3.2, 1.88, repairAnchor.localZ);
        const postR = new THREE.Mesh(repairPostGeo, steelMat);
        postR.position.set(repairAnchor.localX + 3.2, 1.88, repairAnchor.localZ);
        fobTier3Group.add(repairGantry, postL, postR);

        // Live tracking/firing AA Autocannon & Mortar Turrets
        const turretSpecs: ReadonlyArray<{ lx: number; lz: number; role: 'aa_autocannon' | 'mortar' }> = [
          { lx: -12.5, lz: 34.5, role: 'aa_autocannon' },
          { lx: 12.5, lz: 34.5, role: 'mortar' },
        ];
        for (const ts of turretSpecs) {
          const tBase = new THREE.Mesh(tier3TurretBaseGeo, concreteMat);
          tBase.position.set(ts.lx, 2.28, ts.lz);
          const tHead = new THREE.Mesh(tier3TurretHeadGeo, steelMat);
          tHead.position.set(ts.lx, 4.955, ts.lz);
          const tBarrel = new THREE.Mesh(tier3BarrelGeo, caseMat);
          tBarrel.position.set(0, 0.12, 1.35);
          if (ts.role === 'mortar') {
            tBarrel.rotation.x = -0.58;
          }
          const tFlash = new THREE.Mesh(tier3FlashGeo, turretFlashMat);
          tFlash.position.set(0, 0.12, 2.55);
          tFlash.visible = false;
          tHead.add(tBarrel, tFlash);
          fobTier3Group.add(tBase, tHead);

          const wPos = fobLocalToWorld(fobSpec, ts.lx, ts.lz);
          this.fobTurrets.push({
            sectorId: lm.id,
            faction: fobSpec.faction,
            role: ts.role,
            headMesh: tHead,
            barrelMesh: tBarrel,
            muzzleFlashMesh: tFlash,
            worldX: wPos.x,
            worldY: fobSpec.baseY + 4.955,
            worldZ: wPos.z,
            fireCooldown: 0,
            muzzleFlashTimer: 0,
          });
        }
        fobTier3Group.visible = false;
        this.rootGroup.add(fobTier3Group);
      }

      // Physical In-World Trusted Sub-Faction POI Stations (Forward Stash, Field Medic, Black-Market Terminal)
      if (hasSubFactionPoi && subFactionStashX !== undefined && subFactionStashZ !== undefined &&
          subFactionMedicX !== undefined && subFactionMedicZ !== undefined &&
          subFactionMarketX !== undefined && subFactionMarketZ !== undefined) {
        const stashY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(subFactionStashX, subFactionStashZ));
        const stashMesh = new THREE.Mesh(subFactionLockerGeo, crateMat);
        stashMesh.position.set(subFactionStashX, stashY + 0.825, subFactionStashZ);
        this.rootGroup.add(stashMesh);

        const medicY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(subFactionMedicX, subFactionMedicZ));
        const medicMesh = new THREE.Mesh(subFactionMedicTentGeo, medMat);
        medicMesh.position.set(subFactionMedicX, medicY + 1.18, subFactionMedicZ);
        this.rootGroup.add(medicMesh);

        const marketY = Math.max(SEA_LEVEL_M + 0.3, sampleGroundHeight(subFactionMarketX, subFactionMarketZ));
        const marketGroup = new THREE.Group();
        marketGroup.position.set(subFactionMarketX, marketY, subFactionMarketZ);
        const bmDesk = new THREE.Mesh(caseGeo, caseMat);
        bmDesk.position.y = 0.28;
        const localBmMat = blackMarketScreenMat.clone();
        this.sharedMaterials.push(localBmMat);
        const bmScreen = new THREE.Mesh(laptopLidGeo, localBmMat);
        bmScreen.name = `black_market_screen_${lm.id}`;
        bmScreen.position.set(0, 0.74, -0.14);
        bmScreen.userData.electronicKind = 'screen';
        bmScreen.userData.electronicLabel = `${lm.shortLabel} Black-Market Terminal`;
        bmScreen.userData.electronicHp = 35;
        bmScreen.userData.interactiveLinkId = `subfaction_black_market:${lm.id}`;
        bmScreen.userData.repairable = true;
        bmScreen.userData.repairDurationSec = 2.0;
        marketGroup.add(bmDesk, bmScreen);
        this.rootGroup.add(marketGroup);
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
        lid.name = `contract_terminal_screen_${contractId}`;
        lid.position.set(0, 0.72, -0.18);
        lid.rotation.x = -0.22;
        lid.userData.electronicKind = 'screen';
        lid.userData.electronicLabel = `${lm.shortLabel} Contract Terminal`;
        lid.userData.electronicHp = 35;
        lid.userData.interactiveLinkId = `contract:${contractId}`;
        lid.userData.repairable = true;
        lid.userData.repairDurationSec = 2.0;
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
   * Transitions nearby non-FOB sectors from `calm` -> `alerted` upon gunfire or explosions,
   * and raises dynamic sector combat `heat` (0..100).
   */
  public notifyCombatAlert(originX: number, originZ: number, radiusM = 135, heatDelta = 14): void {
    for (const sector of this.sectors.values()) {
      if (sector.isFob) continue;
      if (Math.hypot(originX - sector.worldX, originZ - sector.worldZ) <= radiusM) {
        sector.alertDecaySec = 45;
        sector.heat = Math.min(100, sector.heat + heatDelta);
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
    s.owner = 'contested';
    s.alertState = 'contested';
    s.heat = Math.min(100, Math.max(s.heat, 65));
    s.alertDecaySec = 90;
  }

  public getFobDefenseTurrets(): readonly FobDefenseTurretHandle[] {
    return this.fobTurrets;
  }

  public getFastTravelDestinations(faction: PmcFactionId): FastTravelDestination[] {
    const out: FastTravelDestination[] = [];
    for (const s of this.sectors.values()) {
      if (s.owner === faction || (s.isFob && s.homeFaction === faction)) {
        out.push({
          sectorId: s.sectorId,
          name: s.name,
          shortLabel: s.shortLabel,
          worldX: s.isFob ? s.helipadX : s.worldX + 12,
          worldZ: s.isFob ? s.helipadZ : s.worldZ + 12,
          owner: s.owner,
          isFob: s.isFob,
        });
      }
    }
    return out;
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
      } else if (sector.heat > 0) {
        sector.heat = Math.max(0, sector.heat - dt * 1.8);
      }

      if (sector.isFob || !character) {
        sector.contested = false;
        sector.alertState = 'captured';
        sector.signedCaptureProgress =
          sector.owner === 'pmc_alpha' ? 100 : sector.owner === 'pmc_bravo' ? -100 : 0;
        continue;
      }

      const dist = Math.hypot(playerX - sector.worldX, playerZ - sector.worldZ);
      const inZone = dist <= SECTOR_CAPTURE_RADIUS_M;
      const factionSign = character.pmcFaction === 'pmc_alpha' ? 1 : -1;

      if (sector.owner === character.pmcFaction) {
        sector.liveCapturePct = 100;
        sector.signedCaptureProgress = factionSign * 100;
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
          sector.heat = Math.min(100, sector.heat + dt * 4.5);
        } else {
          sector.contested = false;
          sector.alertState = 'contested';
          sector.liveCapturePct = Math.min(100, sector.liveCapturePct + SECTOR_CAPTURE_RATE_PER_SEC * dt);
          sector.signedCaptureProgress = factionSign * sector.liveCapturePct;
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
            sector.signedCaptureProgress = factionSign * 100;
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
          sector.signedCaptureProgress = factionSign * sector.liveCapturePct;
        }
        if (dist <= SECTOR_CAPTURE_RADIUS_M * 1.9) {
          sector.alertState = 'alerted';
        } else if (sector.alertDecaySec <= 0) {
          sector.alertState =
            sector.owner === 'neutral' || sector.owner === 'subfaction' ? 'calm' : 'captured';
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

      // 1. In-World Home FOB Command Terminal, Armory Stash Lockers & Field Hospital
      for (const sector of this.sectors.values()) {
        if (!sector.isFob || sector.homeFaction !== character.pmcFaction) continue;
        const dTerm = Math.hypot(playerX - sector.terminalX, playerZ - sector.terminalZ);
        if (dTerm < bestDist) {
          bestDist = dTerm;
          best = {
            kind: 'fob_terminal',
            id: sector.sectorId,
            label: `FOB Command & Quartermaster Terminal (${sector.shortLabel} · Tier ${fobTier})`,
            sublabel: 'Fund Tier 1–3 FOB Upgrades, Supply-Coupled Trader Stock & 3-Slot Contract Board',
            distanceM: dTerm,
            canExecute: true,
          };
        }

        const dArmory = Math.hypot(playerX - sector.armoryX, playerZ - sector.armoryZ);
        if (dArmory < bestDist) {
          bestDist = dArmory;
          best = {
            kind: 'armory_stash',
            id: sector.sectorId,
            label: `FOB Armory Stash Lockers (${sector.shortLabel})`,
            sublabel: 'Access Operator Stash Storage, Transfer Items, Swap Weapons & Refill Ammo',
            distanceM: dArmory,
            canExecute: true,
          };
        }

        const dMed = Math.hypot(playerX - sector.medbayX, playerZ - sector.medbayZ);
        if (dMed < bestDist) {
          bestDist = dMed;
          best = {
            kind: 'fob_resupply',
            id: sector.sectorId,
            label: `FOB Field Hospital (${sector.shortLabel})`,
            sublabel: 'Restore 100% HP, cure bleeding/leg trauma & repair Armor Plate',
            distanceM: dMed,
            canExecute: true,
          };
        }

        // Tier 3 Vehicle Repair Bay & Fast-Travel Helipad
        const dRepair = Math.hypot(playerX - sector.repairBayX, playerZ - sector.repairBayZ);
        if (dRepair < bestDist) {
          bestDist = dRepair;
          best = {
            kind: 'fob_vehicle_repair',
            id: sector.sectorId,
            label: `Vehicle Repair & Refuel Bay (${sector.shortLabel})`,
            sublabel:
              fobTier >= 3
                ? 'Repair & refuel nearby friendly vehicles to 100%'
                : 'Requires FOB Tier 3 construction at Command Terminal',
            distanceM: dRepair,
            canExecute: fobTier >= 3,
            blockedReason: fobTier >= 3 ? undefined : 'Requires FOB Tier 3 upgrade.',
          };
        }

        const dHeli = Math.hypot(playerX - sector.helipadX, playerZ - sector.helipadZ);
        if (dHeli < bestDist) {
          bestDist = dHeli;
          best = {
            kind: 'fob_helipad_travel',
            id: sector.sectorId,
            label: `Fast-Travel Helipad Dispatch (${sector.shortLabel})`,
            sublabel:
              fobTier >= 3
                ? 'Airlift rapidly to any friendly controlled sector or FOB'
                : 'Requires FOB Tier 3 construction at Command Terminal',
            distanceM: dHeli,
            canExecute: fobTier >= 3,
            blockedReason: fobTier >= 3 ? undefined : 'Requires FOB Tier 3 upgrade.',
          };
        }
      }

      // 1B. Trusted Sub-Faction Physical POI Services (Forward Field Stash, Field Medic, Black-Market Terminal)
      for (const sector of this.sectors.values()) {
        if (!sector.subFactionId || sector.isFob) continue;
        const sf = SUB_FACTION_MAP[sector.subFactionId];
        const standing = character.subFactionStanding[sector.subFactionId] ?? 0;
        const isTrusted = getStandingTier(standing) === 'Trusted';

        if (sector.subFactionStashX !== undefined && sector.subFactionStashZ !== undefined) {
          const dStash = Math.hypot(playerX - sector.subFactionStashX, playerZ - sector.subFactionStashZ);
          if (dStash < bestDist) {
            bestDist = dStash;
            best = {
              kind: 'subfaction_stash',
              id: sector.sectorId,
              subFactionId: sector.subFactionId,
              label: `${sf.shortName} Forward Field Stash`,
              sublabel: isTrusted
                ? 'Trusted Access — Open persistent Operator Stash & Armory Lockers'
                : `Requires Trusted Standing (+50 ${sf.shortName}; current ${standing >= 0 ? `+${standing}` : standing})`,
              distanceM: dStash,
              canExecute: isTrusted,
              blockedReason: isTrusted ? undefined : `Requires +50 Trusted standing with ${sf.name}.`,
            };
          }
        }

        if (sector.subFactionMedicX !== undefined && sector.subFactionMedicZ !== undefined) {
          const dSfMed = Math.hypot(playerX - sector.subFactionMedicX, playerZ - sector.subFactionMedicZ);
          if (dSfMed < bestDist) {
            bestDist = dSfMed;
            best = {
              kind: 'subfaction_medic',
              id: sector.sectorId,
              subFactionId: sector.subFactionId,
              label: `${sf.shortName} Field Medic Triage`,
              sublabel: isTrusted
                ? 'Trusted Access — Full HP heal, stop bleeding & clear leg trauma'
                : `Requires Trusted Standing (+50 ${sf.shortName}; current ${standing >= 0 ? `+${standing}` : standing})`,
              distanceM: dSfMed,
              canExecute: isTrusted,
              blockedReason: isTrusted ? undefined : `Requires +50 Trusted standing with ${sf.name}.`,
            };
          }
        }

        if (sector.subFactionMarketX !== undefined && sector.subFactionMarketZ !== undefined) {
          const dBm = Math.hypot(playerX - sector.subFactionMarketX, playerZ - sector.subFactionMarketZ);
          if (dBm < bestDist) {
            bestDist = dBm;
            const tr = TRADER_MAP[sf.traderId];
            best = {
              kind: 'subfaction_black_market',
              id: sector.sectorId,
              subFactionId: sector.subFactionId,
              label: `${sf.shortName} Black-Market Terminal (${tr.name})`,
              sublabel: isTrusted
                ? 'Trusted Access — Unlocks discounted Tier 3 contraband & AP ammo'
                : `Requires Trusted Standing (+50 ${sf.shortName}; current ${standing >= 0 ? `+${standing}` : standing})`,
              distanceM: dBm,
              canExecute: isTrusted,
              blockedReason: isTrusted ? undefined : `Requires +50 Trusted standing with ${sf.name}.`,
            };
          }
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
    this.fobTurrets.length = 0;
    this.visuals.clear();
    this.sectors.clear();
  }
}

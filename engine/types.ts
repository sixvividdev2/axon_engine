import { AdsMode, AimStance } from '../bodycam-sdk/types';
import { AiArchetypeId } from '../data/aiArchetypes';
import { WeaponAttachments } from '../data/attachments';
import { CaliberId } from '../data/calibers';
import { LimbId, LimbState, TraumaModifiers, TraumaSaveState } from '../data/traumaConfig';
import { WeaponId } from '../data/weapons';

export type GameMode = 'menu' | 'playing' | 'inventory' | 'pause' | 'dead';

export interface InventoryItemInstance {
  uid: string;
  itemId: string;
  quantity: number;
  /** Legacy / fast round count for category === 'magazine' (always synced with roundArray.length) */
  rounds?: number;
  /** Exact per-round caliber stack (bottom -> top) for category === 'magazine' */
  roundArray?: CaliberId[];
}

export type StorageZoneId = 'pockets' | 'rig' | 'backpack';

export interface GridDimensions {
  cols: number;
  rows: number;
}

export interface GridPlacedItem {
  item: InventoryItemInstance;
  zone: StorageZoneId;
  x: number;
  y: number;
  rotated: boolean;
}

export interface WeaponSlotsState {
  primary: WeaponId | null;
  sidearm: WeaponId | null;
  melee: WeaponId | null;
  throwable: WeaponId | null;
}

export interface InventorySaveState {
  placed: GridPlacedItem[];
  equippedBackpack: InventoryItemInstance | null;
  weaponSlots: WeaponSlotsState;
}

export type EncumbranceTier = 'light' | 'moderate' | 'heavy' | 'overloaded';

export interface InventorySnapshotState {
  pocketsDims: GridDimensions;
  rigDims: GridDimensions;
  backpackDims: GridDimensions | null;
  equippedBackpack: InventoryItemInstance | null;
  placed: GridPlacedItem[];
  weaponSlots: WeaponSlotsState;
  carryWeightKg: number;
  comfortableWeightKg: number;
  maxWeightKg: number;
  encumbranceRatio: number;
  encumbranceTier: EncumbranceTier;
}

export interface ActiveMagPackState {
  mode: 'pack' | 'unload';
  magUid: string;
  magLocation: 'grid' | 'loaded';
  magWeaponId?: WeaponId;
  ammoUid?: string;
  progressSec: number;
  stepSec: number;
  currentRounds: number;
  capacity: number;
  label: string;
}

export interface NearbyLootSource {
  containerId: string;
  label: string;
  isDropped: boolean;
  items: InventoryItemInstance[];
}

export interface VitalsSaveState {
  hunger: number;
  hydration: number;
  holdBreathRemainingSec: number;
}

export interface VitalsSnapshotState {
  hunger: number;
  hydration: number;
  holdBreathActive: boolean;
  holdBreathRemainingSec: number;
  holdBreathMaxSec: number;
  holdBreathReboundSec: number;
  batteryFlickering: boolean;
  heartRateBpm: number;
  heartStress: number;
}

export interface EquippedWeaponState {
  weaponId: WeaponId;
  loadedMag: InventoryItemInstance | null;
  chambered: boolean;
  chamberedCaliber?: CaliberId | null;
  suppressorAttachedId: string | null;
  attachments?: WeaponAttachments;
}

export interface ContainerLootState {
  id: string;
  label: string;
  searched: boolean;
  items: InventoryItemInstance[];
}

export interface DoorSaveState {
  id: string;
  isOpen: boolean;
}

export type ZombieStateName = 'IDLE_WANDER' | 'INVESTIGATE' | 'CHASE' | 'ATTACK' | 'DEAD';

export interface ZombieSaveState {
  id: string;
  archetypeId: AiArchetypeId;
  position: [number, number, number];
  yaw: number;
  hp: number;
  state: ZombieStateName;
  investigateTarget: [number, number, number] | null;
  trauma?: TraumaSaveState;
}

export interface TunerSettings {
  deadzoneYawDeg: number;
  deadzonePitchDeg: number;
  torsoFollowStiffness: number;
  minWeaponPitchDeg: number;
  maxWeaponPitchDeg: number;
  adsCameraShakeScale: number;
  hipRecoilSwayScale: number;
  fisheyeStrength: number;
  chromaticAberration: number;
  isoGrain: number;
  autoExposureSpeed: number;
  micClippingDrive: number;
  flashlightAngleDeg: number;
  opticParallaxStrength: number;
  masterVolume: number;
  debugStealthAI: boolean;
}

export const DEFAULT_TUNER_SETTINGS: TunerSettings = {
  deadzoneYawDeg: 10,
  deadzonePitchDeg: 8,
  torsoFollowStiffness: 11.5,
  minWeaponPitchDeg: -50,
  maxWeaponPitchDeg: 68,
  adsCameraShakeScale: 1.0,
  hipRecoilSwayScale: 1.0,
  fisheyeStrength: 0.14,
  chromaticAberration: 0.0028,
  isoGrain: 0.055,
  autoExposureSpeed: 2.4,
  micClippingDrive: 4.5,
  flashlightAngleDeg: 26,
  opticParallaxStrength: 1.0,
  masterVolume: 0.85,
  debugStealthAI: false,
};

export type BiomeId =
  | 'plains'
  | 'forest_valley'
  | 'mountains'
  | 'swamp'
  | 'desert'
  | 'oasis'
  | 'ocean';

export interface DroppedItemState {
  id: string;
  position: [number, number, number];
  item: InventoryItemInstance;
}

export interface ChunkDelta {
  openedDoors: Record<string, boolean>;
  brokenWindows: string[];
  lootedContainers: Record<string, ContainerLootState>;
  killedZombieIds: string[];
  droppedItems: DroppedItemState[];
}

export interface SaveSlotData {
  id: string;
  name: string;
  isQuicksave: boolean;
  savedAt: number;
  worldSeed: number;
  playtimeSec: number;
  player: {
    position: [number, number, number];
    torsoYaw: number;
    torsoPitch: number;
    crouched: boolean;
    health: number;
    stamina: number;
    bleeding: boolean;
    trauma?: TraumaSaveState;
    battery: number;
    flashlightOn: boolean;
    hasFlashlight: boolean;
    equippedWeaponId: WeaponId;
    ownedWeapons: WeaponId[];
    weaponStates: Partial<Record<WeaponId, EquippedWeaponState>>;
    inventory: InventoryItemInstance[];
    gridInventory?: InventorySaveState;
    vitals?: VitalsSaveState;
  };
  containers: Record<string, ContainerLootState>;
  doors: Record<string, DoorSaveState>;
  zombies: ZombieSaveState[];
  chunkDeltas?: Record<string, ChunkDelta>;
}

export interface SaveSlotMeta {
  id: string;
  name: string;
  isQuicksave: boolean;
  savedAt: number;
  playtimeSec: number;
  worldSeed: number;
}

export interface MagCheckReadout {
  text: string;
  expiresAtMs: number;
}

export interface GameSnapshot {
  mode: GameMode;
  pointerLocked: boolean;
  tunerOpen: boolean;
  tuner: TunerSettings;
  battery: number;
  hasFlashlight: boolean;
  flashlightOn: boolean;
  health: number;
  stamina: number;
  bleeding: boolean;
  trauma: {
    limbs: Record<LimbId, LimbState>;
    modifiers: TraumaModifiers;
  };
  vitals: VitalsSnapshotState;
  equippedWeaponId: WeaponId;
  ownedWeapons: WeaponId[];
  weaponState: EquippedWeaponState;
  weaponStates: Partial<Record<WeaponId, EquippedWeaponState>>;
  inventory: InventoryItemInstance[];
  gridInventory: InventorySnapshotState;
  activeMagPack: ActiveMagPackState | null;
  activeContainer: ContainerLootState | null;
  nearbyLootSources: NearbyLootSource[];
  interactionDotVisible: boolean;
  standBlockedByCeiling: boolean;
  aimStance: AimStance;
  armedAdsMode: AdsMode;
  isCanted: boolean;
  isPointAim: boolean;
  hasCantedOptic: boolean;
  laserOn: boolean;
  magCheckReadout: MagCheckReadout | null;
  toastMessage: string | null;
  recordingStartMs: number;
  playtimeSec: number;
  worldSeed: number;
  saveSlots: SaveSlotMeta[];
  zombieDebugStats?: {
    totalAlive: number;
    investigating: number;
    chasing: number;
  };
  exposureDebug?: {
    avgLuminance: number;
    exposure: number;
  };
  throwableStatusLabel?: string;
  throwableLiveFuse?: boolean;
}

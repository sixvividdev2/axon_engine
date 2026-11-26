import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  AdsMode,
  BallisticImpactEvent,
  BallisticsSolver,
  BodycamAudio,
  BodycamController,
  BodycamInputState,
  BodycamLensPresetId,
  BodycamMeleeHitEvent,
  BodycamPostProcess,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  createPdaMotionState,
  DEFAULT_BODYCAM_SDK_CONFIG,
  DynamicPhysicsPropSystem,
  type DynamicPropSupportSample,
  EjectedLiveRoundPool,
  GrenadeDetonationEvent,
  GrenadeHoldStage,
  LENS_PRESETS,
  operatorAssetLoader,
  OperatorId,
  resolveWeaponProfile,
  ScopePassParams,
  ScopeRenderer,
  SDK_WEAPON_PROFILES,
  TacticalGrenadeSystem,
  TacticalPdaDevice,
  type PdaCommsBlackoutZone,
  type PdaConvoyMarker,
  type PdaHudTelemetry,
  type PdaPingMarker,
  type PdaSectorOverlay,
  type PdaTabMode,
  type PdaVehicleMarker,
  VIEWMODEL_LAYER,
  WeaponRig,
  WorldBackpackSystem,
} from '../../../../bodycam-sdk';
import { backpackUnlockStore } from '../../../../data/backpackUnlocks';
import {
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
} from '../../../../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  BASE_CALIBERS,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../../../../data/calibers';
import {
  AdaptivePerformanceController,
  graphicsQualityStore,
  type GraphicsQualityProfile,
} from '../../../../data/graphicsQuality';
import {
  fireModeStore,
  formatFireModeLabel,
  getEffectiveFireRpm,
  isSingleShotFireMode,
  shouldCyclePumpOnShot,
} from '../../../../data/fireModeControl';
import { keybindStore } from '../../../../data/keybindStore';
import {
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  getTacticalEquipmentDef,
  TacticalEquipmentId,
} from '../../../../data/tacticalEquipment';
import { HoldRepairController } from '../../../../doors/HoldRepairController';
import { PlayerInteractAnimator } from '../../../../doors/PlayerInteractAnimator';
import {
  type BrokenElectronicRepairTarget,
  HideoutElectronicsSystem,
} from '../../../../hideout/HideoutElectronicsSystem';
import { characterRoster } from '../CharacterRoster';
import {
  autoPlaceItemInGrid,
  cloneCorpseLootSnapshot,
  cloneTacticalInventory,
  computeOperatorEncumbrance,
  consumeOneGrenadeFromInventory,
  countCompatibleReserveRounds,
  countGrenadesInInventory,
  createAmmoStackItem,
  extractItemByLocator,
  findBestReloadMagazine,
  fireRoundFromWeaponSlot,
  getLoadedAmmoCount,
  getWeaponSlotByWeaponId,
  isBackpackTemplateId,
  peekItemByLocator,
  peekNextRoundVariant,
  swapMagazineIntoWeapon,
} from '../inventory/TetrisInventoryCore';
import type {
  CorpseTacticalLootSnapshot,
  ItemSourceLocator,
  MedicalItem,
  OperatorTacticalInventory,
} from '../inventory/TetrisInventoryTypes';
import {
  BankruptcyStatus,
  CharacterDeathOutcome,
  getBankruptcyStatus,
  processCharacterDeath,
} from '../PermadeathService';
import { shardStore } from '../ShardStore';
import {
  ARMOR_PLATE_MAP,
  bodyTypeToOperatorId,
  CharacterSlotId,
  DynamicWorldEventKind,
  FactionSupplyPool,
  FobTier,
  OpenWorldBiomeId,
  OpenWorldCharacter,
  OpenWorldWeatherId,
  PMC_FACTIONS,
  PmcFactionId,
  SUB_FACTION_MAP,
} from '../types';
import type { ExternalLootContext } from '../ui/TacticalInventoryModal';
import {
  AiDamageToPlayerEvent,
  AiEliminationEvent,
  AiHitZone,
  AiSummaryTelemetry,
  OpenWorldAiDirector,
} from './OpenWorldAiDirector';
import { AtmosphereTelemetry, OpenWorldAtmosphere } from './OpenWorldAtmosphere';
import { OpenWorldAmbienceAudio } from './OpenWorldAmbienceAudio';
import { OpenWorldBodycamAdapter } from './OpenWorldBodycamAdapter';
import { OpenWorldChunkStreamer, StreamerStats } from './OpenWorldChunkStreamer';
import { OpenWorldOcclusionCuller } from './OpenWorldOcclusionCuller';
import {
  createObbRaycastHit,
  getBakedHorizonTowers,
  getBakedOpenWorldSites,
  getBakedRiverBridges,
  getBakedRoadSegments,
} from './OpenWorldCivilizationTopology';
import {
  ConvoySummaryTelemetry,
  OpenWorldConvoyDirector,
} from './OpenWorldConvoyDirector';
import {
  OpenWorldEventDirector,
  WorldEventTelemetry,
} from './OpenWorldEventDirector';
import { OpenWorldFobDynamicProps } from './OpenWorldFobDynamicProps';
import {
  FobCompoundId,
  getFobCourtyardSpawnAnchor,
  isFobCompoundId,
} from './OpenWorldFobLayout';
import {
  FobTerminalStateSnapshot,
  OpenWorldLogisticsEconomy,
} from './OpenWorldLogisticsEconomy';
import {
  FastTravelDestination,
  OpenWorldInteractableContext,
  OpenWorldSectorManager,
  SectorRuntimeState,
} from './OpenWorldSectorManager';
import {
  WildlifeManager,
  WildlifeSummaryTelemetry,
  WolfBitePlayerEvent,
} from './WildlifeManager';
import {
  createTerrainSample,
  getNearestLandmark,
  OPENWORLD_BIOMES,
  OPENWORLD_LANDMARKS,
  OpenWorldLandmarkSpec,
  sampleOpenWorldTerrain,
  SEA_LEVEL_M,
  WORLD_HALF_M,
} from './OpenWorldTerrain';

export type OpenWorldNavMode = 'foot' | 'recon_flight';
export type OpenWorldRenderPipeline = 'direct' | 'bodycam_post';
export type OpenWorldNvgMode = 'none' | 'pvs7' | 'arnvg';

export type OpenWorldModalKind =
  | 'inventory'
  | 'fob_terminal'
  | 'black_market_terminal'
  | 'armory_stash'
  | 'corpse_loot'
  | 'event_loot'
  | 'helipad_travel'
  | null;

export interface OpenWorldCombatTelemetry {
  hp: number;
  maxHp: number;
  armorDurability: number;
  maxArmorDurability: number;
  armorLabel: string;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  activeRoundLabel: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  rigQuickMagCount: number;
  backpackReserveRounds: number;
  hasChestRig: boolean;
  fireModeLabel: string;
  reloading: boolean;
  isAds: boolean;
  armedAdsMode: AdsMode;
  isPdaOpen: boolean;
  pdaBatteryPct: number;
  grenadeDrawn: boolean;
  grenadeHoldStage: GrenadeHoldStage;
  grenadeCount: number;
  killsThisSortie: number;
  damageFlashAlpha: number;
  hitMarkerAlpha: number;
  hitMarkerHeadshot: boolean;
  bleedingRemainingSec: number;
  sprintSlowRemainingSec: number;
}

export interface OpenWorldSessionSnapshot {
  character: OpenWorldCharacter | null;
  bankruptcy: BankruptcyStatus | null;
  pointerLocked: boolean;
  activeModal: OpenWorldModalKind;
  externalLoot: ExternalLootContext | null;
  fobTerminalState: FobTerminalStateSnapshot | null;
  blackMarketContext: { subFactionName: string; traderName: string; discountPct: number } | null;
  fastTravelDestinations: FastTravelDestination[];
  fobTier: FobTier;
  navMode: OpenWorldNavMode;
  renderPipeline: OpenWorldRenderPipeline;
  lensPreset: BodycamLensPresetId;
  nvgMode: OpenWorldNvgMode;
  flashlightOn: boolean;
  worldX: number;
  worldY: number;
  worldZ: number;
  groundY: number;
  altitudeAglM: number;
  headingDeg: number;
  biomeId: OpenWorldBiomeId;
  biomeName: string;
  biomeElevationBand: string;
  nearestLandmarkName: string;
  nearestLandmarkDistM: number;
  atmosphere: AtmosphereTelemetry;
  streamer: StreamerStats;
  combat: OpenWorldCombatTelemetry;
  ai: AiSummaryTelemetry;
  wildlife: WildlifeSummaryTelemetry;
  sectors: SectorRuntimeState[];
  activeSector: SectorRuntimeState | null;
  commsBlackoutCount: number;
  convoys: ConvoySummaryTelemetry[];
  worldEvent: WorldEventTelemetry;
  territoryCounts: { pmc_alpha: number; pmc_bravo: number; neutral: number };
  pmcSupplyPools: Record<PmcFactionId, FactionSupplyPool>;
  interactable: OpenWorldInteractableContext | null;
  toastMessage: string | null;
  drawCalls: number;
  triangles: number;
  frameTimeMs: number;
  fps: number;
  shardCorpseCount: number;
  lastDeathOutcome: CharacterDeathOutcome | null;
}

type SnapshotListener = (snap: OpenWorldSessionSnapshot) => void;

// Module-scope zero-GC scratch objects
const _terrainScratch = createTerrainSample();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveVec = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _camPos = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _muzzlePos = new THREE.Vector3();
const _muzzleDir = new THREE.Vector3();
const _flashTargetPos = new THREE.Vector3();
const _whipVel = new THREE.Vector2();
const _aiLosHitScratch = createObbRaycastHit();
const _cullFrustum = new THREE.Frustum();
const _cullProjScreen = new THREE.Matrix4();

const RENDER_PREFS_STORAGE_KEY = 'axon_openworld_render_prefs_v1';

interface StoredRenderPrefs {
  renderPipeline: OpenWorldRenderPipeline;
  lensPreset: BodycamLensPresetId;
}

function loadStoredRenderPrefs(): StoredRenderPrefs {
  const fallback: StoredRenderPrefs = {
    renderPipeline: 'direct',
    lensPreset: 'axon_body_4',
  };
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(RENDER_PREFS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredRenderPrefs>;
    const renderPipeline: OpenWorldRenderPipeline =
      parsed.renderPipeline === 'bodycam_post' ? 'bodycam_post' : 'direct';
    const lensPreset: BodycamLensPresetId =
      parsed.lensPreset === 'gopro_chest' || parsed.lensPreset === 'clean_raw'
        ? parsed.lensPreset
        : 'axon_body_4';
    return { renderPipeline, lensPreset };
  } catch {
    return fallback;
  }
}

function saveStoredRenderPrefs(prefs: StoredRenderPrefs): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(RENDER_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Pure optical-preset applier: updates ONLY shader/lens visual uniforms while leaving
 * 100% of camera movement, FOV, deadzone, ADS, and recoil physics untouched.
 */
export function applyLensPresetToConfig(
  config: BodycamSDKConfig,
  presetId: BodycamLensPresetId,
): void {
  const preset = LENS_PRESETS[presetId] ?? LENS_PRESETS.axon_body_4;
  config.lensPreset = preset.id;
  config.fisheyeStrength = preset.fisheyeStrength;
  config.chromaticAberration = preset.chromaticAberration;
  config.isoGrain = preset.isoGrain;
  config.lensDirtStrength = preset.lensDirtStrength;
  config.motionBlurStrength = preset.motionBlurStrength;
}

/**
 * Computes an oriented approach spawn pose that frames the landmark compound and 4km horizon
 * directly ahead of the operator using Three.js right-handed `-Z` forward convention.
 */
export function computeLandmarkSpawnPose(lm: OpenWorldLandmarkSpec): {
  spawnX: number;
  spawnZ: number;
  faceYaw: number;
  footPitch: number;
  flightPitch: number;
} {
  if (isFobCompoundId(lm.id)) {
    const anchor = getFobCourtyardSpawnAnchor(lm.id as FobCompoundId);
    return {
      spawnX: anchor.worldX,
      spawnZ: anchor.worldZ,
      faceYaw: anchor.yaw,
      footPitch: -0.04,
      flightPitch: -0.24,
    };
  }
  const spawnX = lm.worldX;
  const spawnZ = lm.worldZ + 28;
  const dx = lm.worldX - spawnX;
  const dz = lm.worldZ - spawnZ;
  // In Three.js YXZ Euler, forward is (-sin(yaw), 0, -cos(yaw)) -> yaw = atan2(-dx, -dz)
  const faceYaw = Math.atan2(-dx, -dz);
  return {
    spawnX,
    spawnZ,
    faceYaw,
    footPitch: -0.04,
    flightPitch: -0.24,
  };
}

function detectSoftwareWebGl(): boolean {
  if (typeof document === 'undefined') return true;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

/**
 * Generates a crisp procedural 4km × 4km topographic contour + biome + vector road network +
 * river bridges + settlements + gas stations + checkpoints + horizon towers map
 * for the physical 3D handheld GPS PDA OLED (zero external textures / zero 404s).
 */
function buildProcedural4kmTopoCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(size, size);
  const dst = img.data;
  const sample = createTerrainSample();
  const worldSpan = WORLD_HALF_M * 2;

  for (let py = 0; py < size; py++) {
    // North (-Z) is top of map
    const wz = -WORLD_HALF_M + (py / (size - 1)) * worldSpan;
    for (let px = 0; px < size; px++) {
      const wx = -WORLD_HALF_M + (px / (size - 1)) * worldSpan;
      sampleOpenWorldTerrain(wx, wz, sample);
      const di = (py * size + px) * 4;

      let r: number;
      let g: number;
      let b: number;
      if (sample.isWater) {
        r = 18;
        g = 48;
        b = 72;
      } else {
        r = Math.round(sample.r * 185 + 16);
        g = Math.round(sample.g * 195 + 20);
        b = Math.round(sample.b * 175 + 16);
        // Crisp 35m topographic contour isolines
        const contourMod = Math.abs(sample.height) % 35;
        if (contourMod < 2.2) {
          r = Math.max(0, r - 28);
          g = Math.max(0, g - 24);
          b = Math.max(0, b - 24);
        }
      }
      dst[di] = Math.min(255, r);
      dst[di + 1] = Math.min(255, g);
      dst[di + 2] = Math.min(255, b);
      dst[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const toMapX = (wx: number) => ((wx + WORLD_HALF_M) / worldSpan) * size;
  const toMapY = (wz: number) => ((wz + WORLD_HALF_M) / worldSpan) * size;

  // 1. Vector Road Network Overlay (Dirt Trails dashed, FOB Spurs solid, Route 41 double-line)
  const segments = getBakedRoadSegments();
  ctx.lineCap = 'round';

  // Dirt Trails (dashed tan lines)
  ctx.save();
  ctx.strokeStyle = 'rgba(186, 158, 118, 0.86)';
  ctx.lineWidth = 1.6;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.tier !== 'dirt_trail') continue;
    ctx.moveTo(toMapX(seg.ax), toMapY(seg.az));
    ctx.lineTo(toMapX(seg.bx), toMapY(seg.bz));
  }
  ctx.stroke();
  ctx.restore();

  // FOB Spurs & Connectors (dark outline + warm tarmac fill)
  ctx.strokeStyle = 'rgba(22, 26, 30, 0.85)';
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.tier !== 'fob_spur') continue;
    ctx.moveTo(toMapX(seg.ax), toMapY(seg.az));
    ctx.lineTo(toMapX(seg.bx), toMapY(seg.bz));
  }
  ctx.stroke();
  ctx.strokeStyle = '#c8c4b8';
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // Route 41 Main Highway (prominent double-cased tactical corridor)
  ctx.strokeStyle = 'rgba(18, 22, 26, 0.92)';
  ctx.lineWidth = 6.2;
  ctx.beginPath();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.tier !== 'highway') continue;
    ctx.moveTo(toMapX(seg.ax), toMapY(seg.az));
    ctx.lineTo(toMapX(seg.bx), toMapY(seg.bz));
  }
  ctx.stroke();
  ctx.strokeStyle = '#e5b85c';
  ctx.lineWidth = 3.2;
  ctx.stroke();
  ctx.strokeStyle = '#2a2e33';
  ctx.lineWidth = 1.0;
  ctx.stroke();

  // 2. Steel-Truss River Bridges (crisp parallel deck ticks)
  const bridges = getBakedRiverBridges();
  for (let i = 0; i < bridges.length; i++) {
    const br = bridges[i];
    const x1 = toMapX(br.startX);
    const y1 = toMapY(br.startZ);
    const x2 = toMapX(br.endX);
    const y2 = toMapY(br.endZ);
    ctx.strokeStyle = '#e2f1ff';
    ctx.lineWidth = 4.6;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2.0;
    ctx.stroke();
  }

  // 3. Settlements (Houses & Barns), Gas Stations & Military Checkpoints
  const sites = getBakedOpenWorldSites();
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    const mx = toMapX(s.x);
    const my = toMapY(s.z);
    if (s.kind === 'gas_station') {
      // Amber square badge with white fuel dot
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(mx - 4, my - 4, 8, 8);
      ctx.strokeStyle = '#111827';
      ctx.lineWidth = 1;
      ctx.strokeRect(mx - 4, my - 4, 8, 8);
      ctx.fillStyle = '#111827';
      ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
    } else if (s.kind === 'checkpoint') {
      // Red/white tactical roadblock diamond
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(mx, my - 4);
      ctx.lineTo(mx + 4, my);
      ctx.lineTo(mx, my + 4);
      ctx.lineTo(mx - 4, my);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (s.kind === 'barn') {
      ctx.fillStyle = '#b45309';
      ctx.fillRect(mx - 2.5, my - 2.5, 5, 5);
    } else {
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(mx - 2, my - 2, 4, 4);
    }
  }

  // 4. Vertical Horizon Landmarks (Water Towers = cyan circles, Radio Masts = crimson triangles)
  const towers = getBakedHorizonTowers();
  for (let i = 0; i < towers.length; i++) {
    const tw = towers[i];
    const mx = toMapX(tw.x);
    const my = toMapY(tw.z);
    if (tw.kind === 'water_tower') {
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.moveTo(mx, my - 4);
      ctx.lineTo(mx + 3.5, my + 3);
      ctx.lineTo(mx - 3.5, my + 3);
      ctx.closePath();
      ctx.fill();
    }
  }

  return canvas;
}

/**
 * Computes armor-mitigated incoming damage (pure helper also usable in unit tests).
 * Armor plates absorb 65% of ballistic damage while intact; remaining blunt trauma hits HP.
 */
export function resolvePlayerArmorHit(
  currentHp: number,
  currentArmor: number,
  incomingDamage: number,
): { nextHp: number; nextArmor: number; absorbedByArmor: number; hpDamage: number } {
  const dmg = Math.max(0, incomingDamage);
  if (currentArmor <= 0 || dmg <= 0) {
    const nextHp = Math.max(0, currentHp - dmg);
    return { nextHp, nextArmor: 0, absorbedByArmor: 0, hpDamage: dmg };
  }
  const desiredAbsorb = dmg * 0.65;
  const absorbedByArmor = Math.min(currentArmor, desiredAbsorb);
  const nextArmor = Math.max(0, currentArmor - absorbedByArmor);
  const hpDamage = Math.max(1, dmg - absorbedByArmor);
  const nextHp = Math.max(0, currentHp - hpDamage);
  return { nextHp, nextArmor, absorbedByArmor, hpDamage };
}

/**
 * Phase 3 Interactive 4km × 4km 4-Biome Open World Session Engine.
 * - Integrates Axon's shared `bodycam-sdk` (BodycamController, WeaponRig, M/F CharacterSkeleton,
 *   CharacterAnimator IK, BallisticsSolver, TacticalPdaDevice, TacticalGrenadeSystem, BodycamAudio)
 *   directly into the 4km streaming world under strict `src/modes/openworld/` isolation.
 * - Runs Dynamic Territory Control (`OpenWorldSectorManager`) & Tactical AI Squads (`OpenWorldAiDirector`).
 * - Enforces <= 7.0ms frametime budget, <200 draw calls, zero per-frame allocations,
 *   and explicit `.dispose()` teardown.
 */
export class OpenWorldSessionEngine {
  private readonly container: HTMLElement;
  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly envTexture: THREE.Texture | null;

  private readonly atmosphere: OpenWorldAtmosphere;
  private readonly streamer: OpenWorldChunkStreamer;
  private readonly occlusionCuller = new OpenWorldOcclusionCuller();
  private readonly sectorManager: OpenWorldSectorManager;
  private readonly logisticsEconomy: OpenWorldLogisticsEconomy;
  private readonly convoyDirector: OpenWorldConvoyDirector;
  private readonly eventDirector: OpenWorldEventDirector;
  private readonly aiDirector: OpenWorldAiDirector;
  private readonly fobDynamicProps: OpenWorldFobDynamicProps;
  private readonly electronicsSystem: HideoutElectronicsSystem;
  private readonly interactAnimator = new PlayerInteractAnimator();
  private readonly holdRepair = new HoldRepairController();
  private readonly bodycamAdapter: OpenWorldBodycamAdapter;

  // Shared Axon Bodycam Core subsystems
  private readonly audio: BodycamAudio;
  private readonly ambienceAudio: OpenWorldAmbienceAudio;
  private readonly wildlifeManager: WildlifeManager;
  private readonly ballistics: BallisticsSolver;
  private readonly ejectedLiveRounds: EjectedLiveRoundPool;
  private readonly _liveRoundVel = new THREE.Vector3();
  private readonly _liveRoundTerrainSample = createTerrainSample();
  private readonly weaponRig: WeaponRig;
  private readonly skeleton: CharacterSkeleton;
  private readonly animator: CharacterAnimator;
  private readonly controller: BodycamController;
  private readonly pdaDevice: TacticalPdaDevice;
  private readonly grenadeSystem: TacticalGrenadeSystem;
  private readonly flashlight: THREE.SpotLight;
  private readonly scopeRenderer: ScopeRenderer;
  private readonly _scopePassParams: ScopePassParams;
  private postProcess: BodycamPostProcess | null = null;

  private readonly config: BodycamSDKConfig = { ...DEFAULT_BODYCAM_SDK_CONFIG };
  private readonly input: BodycamInputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    crouch: false,
    leanLeft: false,
    leanRight: false,
    ads: false,
    cant: false,
    adsMode: 'PRIMARY',
    holdBreath: false,
    freeZoom: false,
    vault: false,
  };
  private readonly _pdaMotionScratch = createPdaMotionState();
  private readonly _pdaPings: PdaPingMarker[] = [];
  private readonly _pdaBlackoutZones: PdaCommsBlackoutZone[] = [];
  private readonly _pdaConvoys: PdaConvoyMarker[] = [];
  private readonly _pdaSectors: PdaSectorOverlay[] = [];
  private readonly _pdaVehicles: PdaVehicleMarker[] = [];
  private readonly _pdaTelemetryScratch: PdaHudTelemetry = {
    playerX: 0,
    playerZ: 0,
    playerYawRad: 0,
    gameClockText: '09:30',
    weatherLabel: 'CLEAR',
    windSpeedMps: 3.2,
    windAngleRad: 0.7,
    modeLabel: 'PERIMETER OPS',
    zoneLabel: 'ALPHA FOB',
    pings: [],
    commsBlackoutZones: [],
    convoys: [],
    sectors: [],
    vehicles: [],
    batteryPct: 100,
  };

  private readonly corpseMarkerGroup = new THREE.Group();
  private readonly corpseGeometries: THREE.BufferGeometry[] = [];
  private readonly corpseMaterials: THREE.Material[] = [];
  private readonly worldBackpacks: WorldBackpackSystem;

  private readonly keysDown = new Set<string>();
  private readonly listeners = new Set<SnapshotListener>();

  private activeSlotId: CharacterSlotId | null = null;
  private activeModal: OpenWorldModalKind = null;
  private activeExternalLoot: ExternalLootContext | null = null;
  private activeBlackMarketContext: {
    subFactionName: string;
    traderName: string;
    discountPct: number;
  } | null = null;
  private navMode: OpenWorldNavMode = 'foot';
  private renderPipeline: OpenWorldRenderPipeline = 'direct';
  private nvgMode: OpenWorldNvgMode = 'none';
  private flashlightOn = false;
  private pointerLocked = false;
  private disposed = false;

  // Combat & weapon state
  private playerHp = 100;
  private readonly playerMaxHp = 100;
  private armorDurability = 60;
  private maxArmorDurability = 60;
  private armorLabel = 'NIJ III AR500';
  private equippedWeaponId = 'm4a1';
  private readonly magAmmoByWeapon: Record<string, number> = {};
  private armedAdsMode: AdsMode = 'PRIMARY';
  private isFiring = false;
  private semiTriggerConsumed = false;
  private fireCooldown = 0;
  private reloadTimer = 0;
  private pendingReloadWeaponId: string | null = null;
  private pendingReloadSpec: {
    weaponId: string;
    weaponSlotKey: 'primary' | 'secondary';
    sourceLocator: ItemSourceLocator;
  } | null = null;
  private tacticalEquipmentId: TacticalEquipmentId = DEFAULT_TACTICAL_EQUIPMENT_ID;
  private grenadeCount = 2;
  private shiftHeld = false;
  private holdBreathHeld = false;
  private freeZoomHeld = false;
  private killsThisSortie = 0;
  private damageFlashAlpha = 0;
  private hitMarkerAlpha = 0;
  private hitMarkerHeadshot = false;
  private bleedingRemainingSec = 0;
  private sprintSlowRemainingSec = 0;
  private footstepSideSign = 1;
  private lastPlayerX = 0;
  private lastPlayerZ = 0;
  private smoothPlayerSpeedMps = 0;
  private stamina = 1.0;
  private heartRateBpm = 74;
  private nearbyElectronicRepair: BrokenElectronicRepairTarget | null = null;
  private toastMessage: string | null = null;
  private toastTimerSec = 0;
  private activeInteractable: OpenWorldInteractableContext | null = null;

  // Recon Flight kinematic state (used when navMode === 'recon_flight')
  private flightX = -1120;
  private flightY = 85;
  private flightZ = 680;
  private flightYaw = 0.65;
  private flightPitch = -0.22;

  // Timing & telemetry
  private frameHandle = 0;
  private lastNowMs = 0;
  private elapsedSec = 0;
  private smoothFrameMs = 8.0;
  private hudEmitAccum = 0;
  private pdaTelemetryAccum = 0;
  private lastDeathOutcome: CharacterDeathOutcome | null = null;

  private unsubRoster: (() => void) | null = null;
  private unsubShards: (() => void) | null = null;
  private unsubQuality: (() => void) | null = null;
  private unsubAdaptive: (() => void) | null = null;
  private unsubDistance: (() => void) | null = null;
  private readonly adaptivePerf: AdaptivePerformanceController;
  private qualityProfile: GraphicsQualityProfile;
  private readonly physicsProps: DynamicPhysicsPropSystem;
  private readonly _propActorVelScratch = new THREE.Vector3();

  constructor(container: HTMLElement, slotId?: CharacterSlotId | null) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGl();
    this.qualityProfile = graphicsQualityStore.getProfile();
    this.adaptivePerf = new AdaptivePerformanceController(this.qualityProfile, true);

    // Renderer configured per Three.js studio PBR + software WebGL guard
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl && this.qualityProfile.antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.autoClear = false; // Enables crisp depth-cleared VIEWMODEL_LAYER 2-pass
    this.renderer.setPixelRatio(
      this.isSoftwareGl
        ? 1
        : Math.min(window.devicePixelRatio || 1, this.qualityProfile.openWorldMaxDpr),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && this.qualityProfile.castShadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled;
    this.renderer.setSize(
      Math.max(1, container.clientWidth),
      Math.max(1, container.clientHeight),
    );
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      72,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.25,
      4700,
    );
    this.scene.add(this.camera);

    // Restore saved render pipeline & optical lens preset without altering movement/aiming physics
    const storedPrefs = loadStoredRenderPrefs();
    applyLensPresetToConfig(this.config, storedPrefs.lensPreset);
    this.renderPipeline = storedPrefs.renderPipeline;

    // Procedural Studio IBL via RoomEnvironment on every device
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.envTexture = rt.texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    // Resolve active character before building faction-aware AI & operator rig
    const targetChar =
      (slotId ? characterRoster.getCharacter(slotId) : null) ??
      characterRoster.getActiveCharacter();
    this.activeSlotId = targetChar?.slotId ?? null;
    const playerFaction: PmcFactionId = targetChar?.pmcFaction ?? 'pmc_alpha';
    const initialShard = targetChar?.shardMode ?? 'PvPvE';

    // Atmosphere (90m day/night cycle + regional weather) & 3-Ring Chunk Streamer
    this.atmosphere = new OpenWorldAtmosphere(this.scene, this.isSoftwareGl);
    // Let sun/moon and hemisphere fill illuminate 1P arms, weapon & PDA on VIEWMODEL_LAYER
    this.atmosphere.sunLight.layers.enable(VIEWMODEL_LAYER);
    this.atmosphere.hemiLight.layers.enable(VIEWMODEL_LAYER);

    this.streamer = new OpenWorldChunkStreamer(
      this.scene,
      this.isSoftwareGl,
      this.atmosphere.fogUniforms,
    );
    this.atmosphere.setQualityProfile(this.qualityProfile, this.adaptivePerf.state);
    this.streamer.applyQualityProfile(this.qualityProfile, false);

    // Unified chunk-streamed GPU-instanced physics props (FOB & settlement bottles, cans, wind papers, crates)
    const owIndoorScratch = { isIndoor: false, material: 'outdoor' as 'concrete' | 'wood' | 'metal' | 'outdoor' };
    const owSupportScratch: DynamicPropSupportSample = { height: 0, surface: 'grass' };
    this.physicsProps = new DynamicPhysicsPropSystem({
      scene: this.scene,
      isSoftwareGl: this.isSoftwareGl,
      graphicsQuality: this.qualityProfile.id,
      maxAniso: Math.min(4, this.renderer.capabilities.getMaxAnisotropy()),
      adapter: {
        sampleSupportHeight: (x, maxSurfaceY, z) => {
          this.streamer.samplePropSupportSurface(x, maxSurfaceY, z, owSupportScratch);
          return owSupportScratch.height;
        },
        sampleSupportSurface: (x, maxSurfaceY, z, out) => {
          this.streamer.samplePropSupportSurface(x, maxSurfaceY, z, out);
        },
        resolveSolidCollision: (x, y, z, radius, halfHeight, out) =>
          this.streamer.resolvePropSolidCollision(x, y, z, radius, halfHeight, out),
        isIndoor: (x, y, z) => {
          this.streamer.sampleIndoorAt(x, y, z, owIndoorScratch);
          return owIndoorScratch.isIndoor;
        },
      },
      onImpactAudio: (kind, pos, intensity) => {
        this.audio.playPhysicsPropImpact(kind, pos, intensity);
      },
    });
    this.streamer.setPhysicsPropCallbacks({
      onChunkLoad: (_chunkKey, spawns) => {
        this.physicsProps.spawnBatch(spawns);
      },
      onChunkUnload: (chunkKey) => {
        this.physicsProps.removePropsByOwner(chunkKey);
      },
    });

    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Phase 3 & 4 Dynamic Sector Control, Supply-Coupled Logistics, Convoys & Dynamic Events
    this.sectorManager = new OpenWorldSectorManager(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      characterRoster,
      shardStore,
      initialShard,
    );
    this.logisticsEconomy = new OpenWorldLogisticsEconomy();
    this.convoyDirector = new OpenWorldConvoyDirector(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
    );
    this.eventDirector = new OpenWorldEventDirector(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
    );
    this.aiDirector = new OpenWorldAiDirector(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      playerFaction,
      maxAniso,
      (ax, ay, az, bx, by, bz) => {
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.35) return false;
        const inv = 1 / dist;
        _aiLosHitScratch.hit = false;
        _aiLosHitScratch.distance = dist - 0.25;
        return this.streamer.raycastActiveStructures(
          ax,
          ay,
          az,
          dx * inv,
          dy * inv,
          dz * inv,
          0.25,
          _aiLosHitScratch,
        );
      },
    );

    // Bridge 4km heightfield, AI hitboxes, convoys, events & wildlife into Axon's shared bodycam-sdk
    this.bodycamAdapter = new OpenWorldBodycamAdapter(
      this.streamer,
      this.aiDirector,
      (origin, radius, kind) => {
        if (kind === 'gunshot' || kind === 'suppressed_gunshot') {
          const db = kind === 'suppressed_gunshot' ? 124 : 158;
          this.aiDirector.notifyPlayerGunshot(origin.x, origin.z, radius);
          this.sectorManager.notifyCombatAlert(origin.x, origin.z, radius);
          this.ambienceAudio.onBallisticImpulse(
            origin.x,
            origin.z,
            db,
            this.controller.position.x,
            this.controller.position.z,
          );
          this.wildlifeManager.onBallisticImpulse(origin.x, origin.z, db);
        } else if (
          kind === 'footstep_crouch' ||
          kind === 'footstep_walk' ||
          kind === 'footstep_sprint' ||
          kind === 'landing'
        ) {
          // Alternating left/right boot contact coordinates for insect boot-squish check (< 0.22m)
          this.footstepSideSign = -this.footstepSideSign;
          const lateral = this.footstepSideSign * 0.14;
          const cosY = Math.cos(this.controller.aimYaw);
          const sinY = Math.sin(this.controller.aimYaw);
          const footX = origin.x + cosY * lateral;
          const footZ = origin.z - sinY * lateral;
          this.wildlifeManager.handlePlayerFootstep(footX, origin.y, footZ);
        }
      },
    );

    // Shared Axon Bodycam Audio, Spatial Ambience Engine & Living Wildlife Ecosystem
    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.audio.setInteriorAcoustics(false, 'outdoor');

    this.ambienceAudio = new OpenWorldAmbienceAudio(this.audio);
    this.wildlifeManager = new WildlifeManager(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      this.ambienceAudio,
      this.isSoftwareGl,
    );
    this.fobDynamicProps = new OpenWorldFobDynamicProps(this.scene);
    this.electronicsSystem = new HideoutElectronicsSystem(this.scene);
    this.electronicsSystem.autoRegisterSceneElectronics(this.sectorManager.rootGroup, {
      idPrefix: 'ow_sector',
      lightMatchRadiusM: 4.5,
    });
    this.bodycamAdapter.setFobDynamicProps(this.fobDynamicProps);
    this.bodycamAdapter.setElectronicsSystem(this.electronicsSystem);
    this.bodycamAdapter.setWildlifeManager(this.wildlifeManager);
    this.bodycamAdapter.setConvoyDirector(this.convoyDirector);
    this.bodycamAdapter.setEventDirector(this.eventDirector);
    this.bodycamAdapter.onMeleeHit = (ev) => this.handleMeleeHit(ev);

    this.ballistics = new BallisticsSolver(this.scene);
    this.ejectedLiveRounds = new EjectedLiveRoundPool(this.scene);

    this.weaponRig = new WeaponRig(this.scene, this.isSoftwareGl, this.audio);
    this.weaponRig.flashlight.intensity = 0;
    this.scene.add(this.weaponRig.root);

    this.scopeRenderer = new ScopeRenderer(this.isSoftwareGl, 640);
    this._scopePassParams = {
      renderer: this.renderer,
      scene: this.scene,
      mainCamera: this.camera,
      assembly: null,
      isMagnifiedOptic: false,
      zoomMult: 1,
      adsBlend: 0,
      cantBlend: 0,
      reticleIlluminated: true,
      flashlightOn: false,
      sightMisalignYaw: 0,
      sightMisalignPitch: 0,
      dt: 0.016,
      elapsed: 0,
      mainAvgLuminance: 0.22,
    };

    const operatorId: OperatorId = targetChar ? bodyTypeToOperatorId(targetChar.bodyType) : 'MALE';
    const loadedOp = operatorAssetLoader.loadProceduralOperator(operatorId, {
      maxAnisotropy: maxAniso,
      uniformId: targetChar?.operatorGear.uniformId ?? PMC_FACTIONS[playerFaction].uniformId,
      gear: targetChar?.operatorGear,
      previewMode: false,
      validationMode: 'SAFE_FALLBACK',
    });
    this.skeleton = loadedOp.skeleton;
    this.skeleton.setFirstPersonHeadShadowOnly(true);
    this.skeleton.enableArmViewmodelLayer();
    this.skeleton.setFactionArmband(playerFaction === 'pmc_alpha' ? 0x38bdf8 : 0xf59e0b);
    this.skeleton.setIrStrobe(true, false);
    this.scene.add(this.skeleton.root);

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);

    this.pdaDevice = new TacticalPdaDevice(this.audio);
    this.pdaDevice.setBatteryDrainEnabled(true);
    this.pdaDevice.setElevationSampler((wx, wz) => this.streamer.sampleTerrainHeightOnly(wx, wz));
    this.camera.add(this.pdaDevice.root);
    this.animator.setPdaDevice(this.pdaDevice);
    const topoCanvas = buildProcedural4kmTopoCanvas();
    if (topoCanvas) {
      this.pdaDevice.setCustomMapCanvas(topoCanvas, {
        minX: -WORLD_HALF_M,
        maxX: WORLD_HALF_M,
        minZ: -WORLD_HALF_M,
        maxZ: WORLD_HALF_M,
      });
    }

    this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
    this.grenadeSystem = new TacticalGrenadeSystem({
      scene: this.scene,
      physics: this.bodycamAdapter,
      worldRaycastMeshes: this.aiDirector.activeHitMeshes,
      worldBounds: {
        minX: -WORLD_HALF_M + 24,
        maxX: WORLD_HALF_M - 24,
        minZ: -WORLD_HALF_M + 24,
        maxZ: WORLD_HALF_M - 24,
      },
      audio: this.audio,
      onDetonate: (ev) => this.handleGrenadeDetonation(ev),
      onInHandDetonate: (ev) => this.handleGrenadeDetonation(ev),
    });
    this.animator.setGrenadeSystem(this.grenadeSystem);

    // Tactical Weapon-Mounted Flashlight for Night Ops & Coastal Fog
    this.flashlight = new THREE.SpotLight(0xfff4df, 0, 105, Math.PI * 0.22, 0.45, 1.35);
    this.flashlight.castShadow = false;
    this.flashlight.layers.enable(VIEWMODEL_LAYER);
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlight.target);

    this.corpseMarkerGroup.name = 'openworld_shard_corpses';
    this.scene.add(this.corpseMarkerGroup);

    this.worldBackpacks = new WorldBackpackSystem(this.scene);

    // Sync character armor plate, equipped weapon & initial FOB deployment
    this.syncCharacterLoadout(targetChar);

    if (targetChar) {
      characterRoster.setDeploymentState(targetChar.slotId, 'deployed');
      const fobId =
        targetChar.pmcFaction === 'pmc_bravo' ? 'landmark_fob_bravo' : 'landmark_fob_alpha';
      this.teleportToLandmark(fobId, false);
    } else {
      this.teleportToLandmark('landmark_fob_alpha', false);
    }

    this.rebuildShardCorpseMarkers();
    // Spawn 3 discoverable field supply backpacks near FOBs/outposts so players can loot & unlock tiers in-world
    for (const lm of OPENWORLD_LANDMARKS) {
      if (lm.id === 'landmark_fob_alpha') {
        const px = lm.worldX + 9.5;
        const pz = lm.worldZ + 6.0;
        this.worldBackpacks.spawnLootBackpackPreset({
          templateId: 'pack_assault_20l',
          position: new THREE.Vector3(px, this.streamer.sampleGroundHeight(px, pz), pz),
          ownerLabel: 'FOB Alpha Surplus Pack',
        });
      } else if (lm.id === 'landmark_fob_bravo') {
        const px = lm.worldX - 8.5;
        const pz = lm.worldZ + 7.5;
        this.worldBackpacks.spawnLootBackpackPreset({
          templateId: 'pack_rucksack_35l',
          position: new THREE.Vector3(px, this.streamer.sampleGroundHeight(px, pz), pz),
          ownerLabel: 'FOB Bravo Field Pack',
        });
      } else if (lm.id === 'landmark_radar_array' || lm.id === 'landmark_port_terminal') {
        const px = lm.worldX + 12.0;
        const pz = lm.worldZ - 9.0;
        this.worldBackpacks.spawnLootBackpackPreset({
          templateId: 'pack_logistics_55l',
          position: new THREE.Vector3(px, this.streamer.sampleGroundHeight(px, pz), pz),
          ownerLabel: 'Logistics Cache Pack',
        });
      }
    }
    this.sectorManager.syncFromShard(initialShard, targetChar);
    this.applyRenderPipelineMode(this.renderPipeline);

    if (!this.isSoftwareGl) {
      this.grenadeSystem.prewarm(
        this.renderer,
        this.scene,
        this.camera,
        this.skeleton.throwHandSocket,
        VIEWMODEL_LAYER,
      );
      this.streamer.prewarmShaders(this.renderer, this.scene, this.camera);
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.unsubRoster = characterRoster.subscribe(() => {
      const c = this.getActiveCharacter();
      if (c) {
        this.sectorManager.syncFromShard(c.shardMode, c);
      }
      this.emitSnapshot();
    });
    this.unsubShards = shardStore.subscribe(() => {
      const c = this.getActiveCharacter();
      if (c) {
        this.sectorManager.syncFromShard(c.shardMode, c);
      }
      this.rebuildShardCorpseMarkers();
      this.emitSnapshot();
    });
    this.unsubQuality = graphicsQualityStore.subscribe(() => {
      this.applyGraphicsQuality(graphicsQualityStore.getProfile(), true);
    });
    this.unsubAdaptive = graphicsQualityStore.subscribeAdaptiveScaling((enabled) => {
      if (!enabled) {
        this.adaptivePerf.reset(this.qualityProfile);
        this.applyEffectiveDprAndEffects();
      }
    });
    this.unsubDistance = graphicsQualityStore.subscribeDistanceSettings(() => {
      this.applyDistancePerformanceSettings();
    });
    this.applyDistancePerformanceSettings();

    this.lastNowMs = performance.now();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  private applyDistancePerformanceSettings(): void {
    const renderDistM = graphicsQualityStore.getOpenWorldRenderDistanceM();
    this.camera.far = renderDistM + 18;
    this.camera.updateProjectionMatrix();
    this.atmosphere.setRenderDistance(renderDistM, this.camera.far);
    this.streamer.setRenderDistance(renderDistM);
  }

  private applyGraphicsQuality(profile: GraphicsQualityProfile, rebuildChunks: boolean): void {
    this.qualityProfile = profile;
    this.adaptivePerf.reset(profile);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl && profile.castShadows;
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.atmosphere.setQualityProfile(profile, this.adaptivePerf.state);
    this.streamer.applyQualityProfile(profile, rebuildChunks);
    this.applyDistancePerformanceSettings();
    this.applyEffectiveDprAndEffects();
  }

  private applyEffectiveDprAndEffects(): void {
    if (this.isSoftwareGl) return;
    const dpr = graphicsQualityStore.isAdaptiveScalingEnabled()
      ? this.adaptivePerf.state.effectiveDpr
      : Math.min(window.devicePixelRatio || 1, this.qualityProfile.openWorldMaxDpr);
    this.renderer.setPixelRatio(dpr);
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.postProcess?.setSize(w, h);
    this.atmosphere.setSize(w, h);
    this.atmosphere.setQualityProfile(
      this.qualityProfile,
      graphicsQualityStore.isAdaptiveScalingEnabled() ? this.adaptivePerf.state : undefined,
    );
  }

  private getActiveCharacter(): OpenWorldCharacter | null {
    return this.activeSlotId ? characterRoster.getCharacter(this.activeSlotId) : null;
  }

  private syncCharacterLoadout(char: OpenWorldCharacter | null): void {
    const plateId =
      char?.tacticalInventory?.armorPlateId ?? char?.equippedKit.armorPlateId ?? 'plate_nij3_steel';
    const plateSpec = ARMOR_PLATE_MAP[plateId];
    this.maxArmorDurability = plateSpec?.durability ?? 60;
    this.armorDurability = this.maxArmorDurability;
    this.armorLabel = plateSpec ? `${plateSpec.ratingLabel} Plate` : 'NIJ III Plate';

    if (char?.tacticalInventory) {
      this.grenadeCount = countGrenadesInInventory(char.tacticalInventory);
      const bpId = char.tacticalInventory.backpack?.templateId ?? null;
      this.skeleton.setBackpack(isBackpackTemplateId(bpId) ? bpId : null);
    } else {
      this.skeleton.setBackpack(null);
    }

    const weaponId =
      char?.tacticalInventory?.primary.weaponId ??
      (char?.arsenal.equippedWeaponId && char.arsenal.equippedWeaponId !== 'unarmed'
        ? char.arsenal.equippedWeaponId
        : (char?.arsenal.ownedWeaponIds[0] ?? 'm4a1'));
    this.equipWeapon(weaponId);
  }

  private isNonFirearmEquipped(weaponId = this.equippedWeaponId): boolean {
    return weaponId === 'unarmed' || weaponId === 'combat_knife';
  }

  private getCurrentLoadedCountForWeapon(weaponId: string): number {
    if (this.isNonFirearmEquipped(weaponId)) return 0;
    const prof = resolveWeaponProfile(weaponId);
    const char = this.getActiveCharacter();
    if (char?.tacticalInventory) {
      const slotKey = getWeaponSlotByWeaponId(char.tacticalInventory, prof.id);
      if (slotKey) {
        return getLoadedAmmoCount(char.tacticalInventory[slotKey]);
      }
    }
    return this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
  }

  private equipWeapon(weaponId: string): void {
    this.equippedWeaponId = weaponId;
    const prof = resolveWeaponProfile(weaponId);
    const char = this.getActiveCharacter();
    const rawAttachments = char?.arsenal.weaponAttachments[prof.id] ?? {};
    const attachments = normalizeWeaponAttachments(prof.id, rawAttachments);
    this.weaponRig.setWeaponProfile(prof, attachments);

    if (!this.isNonFirearmEquipped(weaponId)) {
      const loaded = this.getCurrentLoadedCountForWeapon(prof.id);
      this.magAmmoByWeapon[prof.id] = loaded;
      this.weaponRig.setAmmoState(loaded, true);
      const zeroM = char?.arsenal.zeroDistanceByWeapon[prof.id] ?? getDefaultZeroDistanceM(prof.category);
      this.weaponRig.setZeroConfig(zeroM, 0, 0);
    }
    this.reloadTimer = 0;
    this.pendingReloadWeaponId = null;
    this.pendingReloadSpec = null;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
  }

  private getActiveAmmoVariant(weaponId: string): AmmoVariantDef {
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    const char = this.getActiveCharacter();
    if (char?.tacticalInventory) {
      const slotKey = getWeaponSlotByWeaponId(char.tacticalInventory, prof.id);
      if (slotKey) {
        const nextVar = peekNextRoundVariant(char.tacticalInventory[slotKey]);
        if (nextVar) return nextVar;
      }
    }
    const stored = char?.arsenal.ammoVariantByWeapon[prof.id] as AmmoVariantId | undefined;
    if (stored && AMMO_VARIANTS[stored]?.caliberId === calId) {
      return AMMO_VARIANTS[stored];
    }
    return getDefaultAmmoVariant(calId);
  }

  private getReserveAmmoForWeapon(weaponId: string): number {
    if (this.isNonFirearmEquipped(weaponId)) return 0;
    const char = this.getActiveCharacter();
    if (char?.tacticalInventory) {
      return countCompatibleReserveRounds(char.tacticalInventory, weaponId).rigAndBeltRounds;
    }
    if (this.activeSlotId) {
      return characterRoster.getArsenalReserveForWeapon(this.activeSlotId, weaponId);
    }
    return 180;
  }

  private showToast(msg: string, durationSec = 4.2): void {
    this.toastMessage = msg;
    this.toastTimerSec = durationSec;
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
  }

  private unbindEvents(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
  }

  private clearInputs(): void {
    this.keysDown.clear();
    this.input.forward = false;
    this.input.backward = false;
    this.input.left = false;
    this.input.right = false;
    this.input.sprint = false;
    this.input.leanLeft = false;
    this.input.leanRight = false;
    this.input.ads = false;
    this.input.freeZoom = false;
    this.input.vault = false;
    this.shiftHeld = false;
    this.holdBreathHeld = false;
    this.freeZoomHeld = false;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.pdaDevice.setDragging(false);
    this.holdRepair.cancel(this.interactAnimator);
  }

  private readonly onWindowBlur = (): void => {
    this.clearInputs();
  };

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postProcess?.setSize(w, h);
    this.atmosphere.setSize(w, h);
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.pointerLocked) e.preventDefault();
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.clearInputs();
    }
    this.emitSnapshot();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.pointerLocked || this.navMode !== 'foot') return;
    if (this.pdaDevice.isOpen()) {
      e.preventDefault();
      this.pdaDevice.applyWheel(e.deltaY);
      return;
    }
    if (this.input.ads && this.weaponRig.hasVariableZoom()) {
      e.preventDefault();
      this.weaponRig.cycleOpticZoom(e.deltaY < 0 ? 1 : -1, true);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (keybindStore.isCapturing()) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (keybindStore.matchesKeyCode(e.code, 'hold_breath')) {
      this.holdBreathHeld = true;
    }
    if (keybindStore.matchesKeyCode(e.code, 'free_zoom')) {
      this.freeZoomHeld = true;
    }
    if (keybindStore.matchesKeyCode(e.code, 'point_aim')) {
      e.preventDefault();
      if (
        !e.repeat &&
        this.activeModal === null &&
        this.navMode === 'foot' &&
        !this.pdaDevice.isBlockingWeaponActions() &&
        !this.grenadeSystem.isDrawn()
      ) {
        this.cycleAimMode();
      }
      return;
    }

    const code = keybindStore.resolveManagedInputCode(e.code);
    if (!code) return;
    this.keysDown.add(code);

    // Global open-world hotkeys
    if (!e.repeat) {
      if (code === 'Tab') {
        e.preventDefault();
        if (this.activeModal === 'inventory' || this.activeModal === 'corpse_loot' || this.activeModal === 'event_loot') {
          this.closeActiveModal();
        } else {
          this.openInventory();
        }
        return;
      }
      if (code === 'Escape' && this.activeModal !== null) {
        this.closeActiveModal();
        return;
      }
      if (this.activeModal !== null) {
        return;
      }
      if (code === 'KeyI') {
        if (this.navMode === 'foot' && !this.pdaDevice.isBlockingWeaponActions() && !this.grenadeSystem.isDrawn()) {
          this.weaponRig.triggerInspect();
        }
        return;
      }
      if (code === 'KeyY') {
        this.triggerChamberCycle();
        return;
      }
      if (code === 'KeyV') {
        this.setNavMode(this.navMode === 'foot' ? 'recon_flight' : 'foot');
        return;
      }
      if (code === 'KeyL' || code === 'KeyT') {
        this.toggleFlashlight();
        return;
      }
      if (code === 'KeyN' || code === 'KeyJ') {
        this.cycleNvgMode();
        return;
      }
      if (code === 'KeyX') {
        if (this.activeInteractable?.kind === 'convoy_hijack') {
          this.sabotageNearestConvoy();
        }
        return;
      }
      if (code === 'KeyF') {
        if (this.navMode === 'foot' && this.activeInteractable?.kind === 'electronic_repair' && this.nearbyElectronicRepair) {
          const target = this.nearbyElectronicRepair;
          this.isFiring = false;
          this.input.ads = false;
          this.holdRepair.start(
            {
              kind: 'ELECTRONICS_REPAIR',
              targetId: target.id,
              label: `Repairing ${target.label}`,
              durationSec: target.durationSec,
              anchorPos: target.anchorPos,
              dynamicAnchorProvider: (out) =>
                this.electronicsSystem.getRepairAnchorWorldPos(target.id, out),
              onWorkTick: (phaseIndex, anchorPos) => {
                this.electronicsSystem.playRepairWorkTick(anchorPos, phaseIndex);
              },
              onComplete: () => {
                this.camera.getWorldPosition(_camPos);
                if (this.electronicsSystem.repairNode(target.id, _camPos)) {
                  this.showToast(`${target.label} Repaired & Online`, 3.2);
                  this.emitSnapshot();
                }
              },
            },
            this.interactAnimator,
          );
          this.emitSnapshot();
          return;
        }
        if (this.activeInteractable) {
          this.executeFieldInteraction();
        } else {
          this.toggleFlashlight();
        }
        return;
      }
    }

    if (this.activeModal !== null || this.navMode !== 'foot') return;

    switch (code) {
      case 'KeyW':
        this.input.forward = true;
        break;
      case 'KeyS':
        this.input.backward = true;
        break;
      case 'KeyA':
        this.input.left = true;
        break;
      case 'KeyD':
        this.input.right = true;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.shiftHeld = true;
        break;
      case 'KeyC':
      case 'ControlLeft':
        if (!e.repeat) this.input.crouch = !this.input.crouch;
        break;
      case 'KeyQ':
        this.input.leanLeft = true;
        break;
      case 'KeyE':
        this.input.leanRight = true;
        break;
      case 'Space':
        e.preventDefault();
        if (!this.pdaDevice.isOpen()) {
          this.input.vault = true;
        }
        break;
      case 'KeyR':
        if (!e.repeat) this.startReload();
        break;
      case 'KeyP':
        if (!e.repeat) this.togglePda();
        break;
      case 'KeyM':
        if (!e.repeat) this.togglePda('tac_map');
        break;
      case 'KeyG':
      case 'KeyH':
      case 'Digit4':
        if (!e.repeat && !this.pdaDevice.isBlockingWeaponActions()) {
          this.toggleGrenade();
        }
        break;
      case 'Digit1':
        if (!e.repeat) this.switchWeaponSlot(1);
        break;
      case 'Digit2':
        if (!e.repeat) this.switchWeaponSlot(2);
        break;
      case 'Digit3':
        if (!e.repeat) this.switchWeaponSlot(3);
        break;
      case 'Digit0':
        if (!e.repeat) this.switchWeaponSlot(0);
        break;
      case 'KeyB':
        if (!e.repeat) this.cycleAimMode();
        break;
      case 'KeyK':
        if (!e.repeat && !this.isNonFirearmEquipped() && !this.pdaDevice.isBlockingWeaponActions() && !this.grenadeSystem.isDrawn()) {
          const prof = resolveWeaponProfile(this.equippedWeaponId);
          const res = fireModeStore.toggle(prof);
          if (res.toggled) {
            this.weaponRig.emitModeToggleCue();
            this.audio.playWeaponCue('mode_toggle', { intensity: 0.55 });
            this.showToast(`Fire Mode: ${res.label}`, 1.8);
            this.emitSnapshot();
          }
        }
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (keybindStore.matchesKeyCode(e.code, 'hold_breath')) {
      this.holdBreathHeld = false;
    }
    if (keybindStore.matchesKeyCode(e.code, 'free_zoom')) {
      this.freeZoomHeld = false;
    }
    const code = keybindStore.resolveManagedInputCode(e.code);
    if (!code) return;
    this.keysDown.delete(code);
    switch (code) {
      case 'KeyW':
        this.input.forward = false;
        break;
      case 'KeyS':
        this.input.backward = false;
        break;
      case 'KeyA':
        this.input.left = false;
        break;
      case 'KeyD':
        this.input.right = false;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.shiftHeld = false;
        break;
      case 'KeyQ':
        this.input.leanLeft = false;
        break;
      case 'KeyE':
        this.input.leanRight = false;
        break;
      case 'Space':
        this.input.vault = false;
        break;
      case 'KeyF':
        if (this.holdRepair.isActive()) {
          this.holdRepair.cancel(this.interactAnimator);
          this.emitSnapshot();
        }
        break;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    const dx = THREE.MathUtils.clamp(e.movementX, -140, 140);
    const dy = THREE.MathUtils.clamp(e.movementY, -140, 140);

    if (this.navMode === 'recon_flight') {
      const sens = 0.0021;
      this.flightYaw -= dx * sens;
      this.flightPitch = THREE.MathUtils.clamp(
        this.flightPitch - dy * sens,
        -Math.PI * 0.46,
        Math.PI * 0.46,
      );
      return;
    }

    if (this.pdaDevice.isOpen() && this.pdaDevice.isDragging()) {
      this.pdaDevice.applyDragDelta(dx, dy);
      return;
    }
    this.controller.handleMouseMove(dx, dy, this.config);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault();
    if (this.activeModal !== null || keybindStore.isCapturing()) return;
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    if (this.navMode !== 'foot') return;

    this.audio.ensureInitialized();

    const isFireBtn = keybindStore.matchesMouseButton(e.button, 'fire');
    const isAdsBtn = keybindStore.matchesMouseButton(e.button, 'ads');
    const isPointAimBtn = keybindStore.matchesMouseButton(e.button, 'point_aim');
    const isFreeZoomBtn = keybindStore.matchesMouseButton(e.button, 'free_zoom');
    const isCycleChamberBtn = keybindStore.matchesMouseButton(e.button, 'cycle_chamber');

    if (isFreeZoomBtn) {
      this.freeZoomHeld = true;
      return;
    }

    // Tactical PDA Grab-Sheet Drag / GPS Recenter
    if (this.pdaDevice.isBlockingWeaponActions()) {
      if (isFireBtn && this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
      } else if (isAdsBtn && this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      }
      return;
    }

    // 4-Phase Tactical Grenade Manual of Arms
    if (this.grenadeSystem.isDrawn()) {
      this.input.ads = false;
      const stage = this.grenadeSystem.getHoldStage();
      if (isAdsBtn) {
        if (stage === 'DRAWN') {
          this.grenadeSystem.pullPin();
          this.emitSnapshot();
        } else if (stage === 'PIN_PULLED') {
          this.grenadeSystem.releaseLever();
          this.emitSnapshot();
        }
      } else if (isFireBtn && (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED')) {
        this.grenadeSystem.beginThrowInput();
        this.emitSnapshot();
      }
      return;
    }

    if (isPointAimBtn) {
      this.cycleAimMode();
      return;
    }

    if (isCycleChamberBtn) {
      this.triggerChamberCycle();
      return;
    }

    if (isAdsBtn) {
      if (this.equippedWeaponId === 'combat_knife') {
        this.animator.triggerKnifeStab(this.controller);
        return;
      }
      this.input.ads = true;
    } else if (isFireBtn) {
      if (this.equippedWeaponId === 'combat_knife') {
        this.animator.triggerKnifeSlash(this.controller);
        return;
      }
      if (this.equippedWeaponId === 'unarmed') {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
        return;
      }
      this.isFiring = true;
      this.tryFireShot();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (keybindStore.matchesMouseButton(e.button, 'free_zoom')) {
      this.freeZoomHeld = false;
    }
    if (keybindStore.matchesMouseButton(e.button, 'fire')) {
      if (this.pdaDevice.isDragging()) {
        this.pdaDevice.setDragging(false);
      }
      if (this.grenadeSystem.isThrowInputHeld()) {
        this.grenadeSystem.releaseThrowInput();
        this.emitSnapshot();
      }
      this.isFiring = false;
      this.semiTriggerConsumed = false;
    }
    if (keybindStore.matchesMouseButton(e.button, 'ads')) {
      this.input.ads = false;
    }
  };

  public requestPointerLock(): void {
    const el = this.renderer.domElement;
    if (document.pointerLockElement === el || typeof el.requestPointerLock !== 'function') return;
    this.audio.ensureInitialized();
    try {
      const res = el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === 'function') {
        res.catch(() => {
          // Ignore Chromium post-ESC pointer-lock cooldown or headless rejections
        });
      }
    } catch {
      // Ignore pointer lock rejection in automated/headless environments
    }
  }

  public exitPointerLock(): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
  }

  public togglePda(targetTab?: PdaTabMode): void {
    if (this.navMode !== 'foot') return;
    const wasOpen = this.pdaDevice.isOpen();
    if (targetTab && wasOpen && this.pdaDevice.getActiveTab() !== targetTab) {
      this.pdaDevice.setActiveTab(targetTab);
      this.audio.playPdaButtonClick();
      this.emitSnapshot();
      return;
    }
    const next = !wasOpen;
    if (next) {
      if (targetTab) {
        this.pdaDevice.setActiveTab(targetTab);
      }
      this.isFiring = false;
      this.input.ads = false;
      this.reloadTimer = 0;
    }
    this.pdaDevice.setOpen(next);
    this.emitSnapshot();
  }

  private toggleGrenade(): void {
    if (this.grenadeSystem.isDrawn()) {
      this.camera.getWorldPosition(_camPos);
      this.camera.getWorldDirection(_lookDir).normalize();
      const res = this.grenadeSystem.holsterOrTossOnSwitch(_camPos, _lookDir);
      if (res === 'tossed') {
        this.grenadeCount = Math.max(0, this.grenadeCount - 1);
      }
      this.emitSnapshot();
      return;
    }
    if (this.grenadeCount <= 0) {
      return;
    }
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = 0;
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    this.grenadeSystem.drawGrenade(def.id);
    this.audio.playGearRattle('weapon_swap', 0.55);
    this.emitSnapshot();
  }

  private switchWeaponSlot(slot: 0 | 1 | 2 | 3): void {
    const char = this.getActiveCharacter();
    if (slot === 0) {
      if (this.equippedWeaponId !== 'unarmed') {
        this.equipWeapon('unarmed');
        this.audio.playGearRattle('weapon_swap', 0.35);
        this.emitSnapshot();
      }
      return;
    }
    if (slot === 3) {
      if (this.equippedWeaponId !== 'combat_knife') {
        this.equipWeapon('combat_knife');
        this.audio.playGearRattle('weapon_swap', 0.45);
        this.emitSnapshot();
      }
      return;
    }
    const owned = char?.arsenal.ownedWeaponIds ?? ['m4a1', 'glock_17'];
    let targetId = owned[0] ?? 'm4a1';
    if (slot === 2) {
      targetId =
        owned.find((id) => {
          const cat = resolveWeaponProfile(id).category;
          return cat === 'pistols' || cat === 'revolvers';
        }) ??
        owned[1] ??
        owned[0] ??
        'glock_17';
    } else {
      targetId =
        owned.find((id) => {
          const cat = resolveWeaponProfile(id).category;
          return cat !== 'pistols' && cat !== 'revolvers';
        }) ??
        owned[0] ??
        'm4a1';
    }
    if (targetId !== this.equippedWeaponId) {
      this.equipWeapon(targetId);
      this.audio.playGearRattle('weapon_swap', 0.45);
      this.emitSnapshot();
    }
  }

  private cycleAimMode(): void {
    const order: AdsMode[] = ['PRIMARY', 'POINT_AIM', 'CANTED'];
    const idx = order.indexOf(this.armedAdsMode);
    this.armedAdsMode = order[(idx + 1) % order.length];
    this.input.adsMode = this.armedAdsMode;
    this.audio.playWeaponCue('mode_toggle', { intensity: 0.35 });
    this.emitSnapshot();
  }

  private triggerChamberCycle(): void {
    if (
      this.activeModal !== null ||
      this.navMode !== 'foot' ||
      this.isNonFirearmEquipped() ||
      this.reloadTimer > 0 ||
      this.grenadeSystem.isDrawn() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.weaponRig.isSuppressorActionActive() ||
      this.weaponRig.isChamberCycling() ||
      this.controller.isVaulting()
    ) {
      return;
    }
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    if (prof.magCapacity <= 0) return;

    const char = this.getActiveCharacter();
    let curAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
    if (char?.tacticalInventory) {
      const slotKey = getWeaponSlotByWeaponId(char.tacticalInventory, prof.id);
      if (slotKey) {
        curAmmo = getLoadedAmmoCount(char.tacticalInventory[slotKey]);
      }
    }
    const hasLiveRound = curAmmo > 0;
    const weaponId = prof.id;
    const baseCal = resolveBaseCaliberId(prof.caliberLabel);
    const defaultCaliberLabel = BASE_CALIBERS[baseCal]?.shortLabel ?? baseCal;

    const started = this.animator.triggerChamberCycle({
      hasLiveRound,
      onExtractApex: (pos, quat) => {
        if (this.equippedWeaponId !== weaponId) return;
        const activeCharNow = this.getActiveCharacter();
        let ejectedVariantId: string = baseCal;
        let ejectedLabel = defaultCaliberLabel;
        if (activeCharNow?.tacticalInventory) {
          const slotKey = getWeaponSlotByWeaponId(activeCharNow.tacticalInventory, weaponId);
          if (slotKey) {
            const invClone = cloneTacticalInventory(activeCharNow.tacticalInventory);
            const extractedVariant = fireRoundFromWeaponSlot(invClone[slotKey]);
            if (!extractedVariant) return;
            const nextAmmo = getLoadedAmmoCount(invClone[slotKey]);
            this.magAmmoByWeapon[weaponId] = nextAmmo;
            this.weaponRig.setAmmoState(nextAmmo, true);
            characterRoster.updateTacticalInventory(activeCharNow.slotId, invClone);
            ejectedVariantId = extractedVariant.id;
            ejectedLabel = `${defaultCaliberLabel} ${extractedVariant.shortName}`;
          } else {
            const magNow = this.magAmmoByWeapon[weaponId] ?? 0;
            if (magNow <= 0) return;
            this.magAmmoByWeapon[weaponId] = magNow - 1;
            this.weaponRig.setAmmoState(magNow - 1, true);
          }
        } else {
          const magNow = this.magAmmoByWeapon[weaponId] ?? 0;
          if (magNow <= 0) return;
          this.magAmmoByWeapon[weaponId] = magNow - 1;
          this.weaponRig.setAmmoState(magNow - 1, true);
        }

        this.controller.getVelocity(this._liveRoundVel);
        this.ejectedLiveRounds.spawnRound({
          position: pos,
          quaternion: quat,
          caliberId: ejectedVariantId,
          caliberLabel: ejectedLabel,
          weaponId,
          holdClass: prof.holdClass,
          carrierVelocity: this._liveRoundVel,
        });
        this.emitSnapshot();
      },
      onComplete: () => {
        this.emitSnapshot();
      },
    });
    if (started) {
      this.isFiring = false;
      this.emitSnapshot();
    }
  }

  private startReload(): void {
    if (
      this.isNonFirearmEquipped() ||
      this.reloadTimer > 0 ||
      this.weaponRig.isChamberCycling() ||
      this.grenadeSystem.isDrawn() ||
      this.pdaDevice.isBlockingWeaponActions()
    ) {
      return;
    }
    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const char = this.getActiveCharacter();

    // Phase 5 Chest Rig / Belt Quick Reload Enforcement:
    // `[R]` strictly pulls loaded compatible magazines from the equipped Chest Rig or Belt!
    // If none exist there (or no Chest Rig is worn), operator can always drag-reload inside [Tab] Inventory.
    if (char?.tacticalInventory) {
      const slotKey = getWeaponSlotByWeaponId(char.tacticalInventory, prof.id);
      if (slotKey) {
        const candidate = findBestReloadMagazine(char.tacticalInventory, prof.id);
        if (!candidate) {
          this.showToast(
            'No loaded compatible magazine in Rig, Belt, or Backpack — press [Tab] to pack rounds',
            4.0,
          );
          this.emitSnapshot();
          return;
        }
        this.isFiring = false;
        this.input.ads = false;
        this.reloadTimer = Math.max(1.1, prof.reloadDurationSec) * candidate.reloadTimeMult;
        this.pendingReloadWeaponId = prof.id;
        this.pendingReloadSpec = {
          weaponId: prof.id,
          weaponSlotKey: slotKey,
          sourceLocator: candidate.locator,
        };
        this.weaponRig.triggerReload(this.reloadTimer);
        this.audio.playWeaponCue('mag_out', { intensity: 0.65 });
        if (candidate.fromBackpack) {
          this.showToast('Pulling spare magazine from Backpack (slower reload)', 2.4);
        }
        this.emitSnapshot();
        return;
      }
    }

    const curMag = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
    if (curMag >= prof.magCapacity) return;
    const reserve = this.getReserveAmmoForWeapon(prof.id);
    if (reserve <= 0) {
      this.showToast('No Reserve Ammo — Resupply at Home FOB');
      return;
    }
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = Math.max(1.1, prof.reloadDurationSec);
    this.pendingReloadWeaponId = prof.id;
    this.pendingReloadSpec = null;
    this.weaponRig.triggerReload(this.reloadTimer);
    this.audio.playWeaponCue('mag_out', { intensity: 0.65 });
    this.emitSnapshot();
  }

  /**
   * Always-working Phase 5 Inventory Drag-and-Drop Fallback Reload:
   * Works even with NO Chest Rig equipped (or pulling directly from Backpack / Secure / Loot Crate)
   * AND triggers the real first-person `WeaponRig.triggerReload()` animation + audio!
   */
  public triggerInventoryDragReload(
    weaponSlotKey: 'primary' | 'secondary',
    sourceLocator: ItemSourceLocator,
  ): void {
    const char = this.getActiveCharacter();
    if (!char?.tacticalInventory) return;
    const slot = char.tacticalInventory[weaponSlotKey];
    if (!slot.weaponId || slot.weaponId === 'unarmed') return;

    const prof = resolveWeaponProfile(slot.weaponId);
    if (this.equippedWeaponId !== prof.id) {
      this.equipWeapon(prof.id);
    }

    // Close inventory modal so operator watches the real 1P reload animation in-world
    this.closeActiveModal();
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = Math.max(1.15, prof.reloadDurationSec);
    this.pendingReloadWeaponId = prof.id;
    this.pendingReloadSpec = {
      weaponId: prof.id,
      weaponSlotKey,
      sourceLocator,
    };
    this.weaponRig.triggerReload(this.reloadTimer);
    this.audio.playWeaponCue('mag_out', { intensity: 0.7 });
    this.showToast(`Manual Drag-Reloading ${prof.name}...`, 2.6);
    this.emitSnapshot();
  }

  private tryFireShot(): void {
    if (
      this.activeModal !== null ||
      this.navMode !== 'foot' ||
      this.isNonFirearmEquipped() ||
      this.fireCooldown > 0 ||
      this.reloadTimer > 0 ||
      this.controller.isSprinting ||
      this.weaponRig.isBlockingFiringAction() ||
      this.pdaDevice.isBlockingWeaponActions() ||
      this.grenadeSystem.isDrawn()
    ) {
      return;
    }

    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const effMode = fireModeStore.getEffectiveMode(prof);
    const isSingle = isSingleShotFireMode(effMode);
    if (isSingle && this.semiTriggerConsumed) return;

    const char = this.getActiveCharacter();
    let activeAmmo: AmmoVariantDef = this.getActiveAmmoVariant(prof.id);
    let nextAmmo = 0;

    // Phase 5 LIFO Mixed-Ammo Magazine Firing: pops exact top round & feeds true AmmoVariantDef to BallisticsSolver
    if (char?.tacticalInventory) {
      const slotKey = getWeaponSlotByWeaponId(char.tacticalInventory, prof.id);
      if (slotKey) {
        const invClone = cloneTacticalInventory(char.tacticalInventory);
        const firedVariant = fireRoundFromWeaponSlot(invClone[slotKey]);
        if (!firedVariant) {
          this.weaponRig.triggerDryFire();
          this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
          this.semiTriggerConsumed = true;
          this.fireCooldown = 0.22;
          this.showToast('Empty Magazine — Press [R] (Rig) or [Tab] to Drag-Reload');
          return;
        }
        activeAmmo = firedVariant;
        nextAmmo = getLoadedAmmoCount(invClone[slotKey]);
        this.magAmmoByWeapon[prof.id] = nextAmmo;
        characterRoster.updateTacticalInventory(char.slotId, invClone);
      } else {
        const curAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
        if (curAmmo <= 0) {
          this.weaponRig.triggerDryFire();
          this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
          this.semiTriggerConsumed = true;
          this.fireCooldown = 0.22;
          this.showToast('Empty Magazine — Press [R] to Reload');
          return;
        }
        nextAmmo = curAmmo - 1;
        this.magAmmoByWeapon[prof.id] = nextAmmo;
      }
    } else {
      const curAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
      if (curAmmo <= 0) {
        this.weaponRig.triggerDryFire();
        this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
        this.semiTriggerConsumed = true;
        this.fireCooldown = 0.22;
        this.showToast('Empty Magazine — Press [R] to Reload');
        return;
      }
      nextAmmo = curAmmo - 1;
      this.magAmmoByWeapon[prof.id] = nextAmmo;
    }

    const effectiveRpm = getEffectiveFireRpm(prof, effMode);
    this.fireCooldown = 60 / Math.max(30, effectiveRpm);
    if (isSingle) this.semiTriggerConsumed = true;

    const derived = this.weaponRig.getDerivedStats();
    const suppressed = derived.isSuppressed;

    this.weaponRig.getMuzzleWorldTransform(_muzzlePos, _muzzleDir, true);
    this.ballistics.spawnShot({
      origin: _muzzlePos,
      direction: _muzzleDir,
      ammo: activeAmmo,
      weaponId: prof.id,
      barrelVelocityMult: prof.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult: derived.velocityMult,
      weaponSpreadMOA: Math.hypot(prof.spreadMOA, activeAmmo.spreadMOA),
      audio: this.audio,
    });
    this.physicsProps.handleBulletRay(_muzzlePos, _muzzleDir, 75, 1.15);

    this.weaponRig.triggerFire(suppressed, nextAmmo, shouldCyclePumpOnShot(prof, effMode));
    this.weaponRig.setAmmoState(nextAmmo, true);
    this.heartRateBpm = Math.min(168, this.heartRateBpm + 1.8);
    this.controller.applyRecoil(
      prof.recoilPitchRad,
      prof.recoilYawRad,
      prof.kickBackM,
      this.config.sightMisalignStrength,
      {
        adsCameraShakeScale: this.config.adsCameraShakeScale,
        hipRecoilSwayScale: this.config.hipRecoilSwayScale,
        stanceCoupled: true,
      },
    );

    const audioWeight: 'pistol' | 'carbine' | 'heavy_rifle' =
      prof.weightClass === 'pistol' || prof.weightClass === 'heavy_rifle'
        ? prof.weightClass
        : 'carbine';
    this.audio.playWeaponCue('fire', {
      position: _muzzlePos,
      weightClass: audioWeight,
      caliberId: activeAmmo.caliberId,
      suppressed,
      isSubsonic: activeAmmo.isSubsonic,
      muzzleComp: derived.hasCompensator,
    });

    // Notify nearby AI squads, sector 4-state alert & living ecosystem acoustically
    const shotDb = suppressed ? 124 : 158;
    const acousticRange = suppressed ? 42 : 125;
    this.aiDirector.notifyPlayerGunshot(
      this.controller.position.x,
      this.controller.position.z,
      acousticRange,
    );
    this.sectorManager.notifyCombatAlert(
      this.controller.position.x,
      this.controller.position.z,
      acousticRange,
    );
    this.ambienceAudio.onBallisticImpulse(
      this.controller.position.x,
      this.controller.position.z,
      shotDb,
      this.controller.position.x,
      this.controller.position.z,
    );
    this.wildlifeManager.onBallisticImpulse(
      this.controller.position.x,
      this.controller.position.z,
      shotDb,
    );
  }

  private handleMeleeHit(ev: Readonly<BodycamMeleeHitEvent>): void {
    const char = this.getActiveCharacter();
    const dmg =
      ev.attackType === 'knife_stab'
        ? 96
        : ev.attackType === 'knife_slash'
          ? 56
          : ev.attackType === 'kick'
            ? 32
            : 24;

    const hitObj = ev.object;
    if (!hitObj) return;

    this.camera.getWorldPosition(_camPos);
    const elecMelee = this.electronicsSystem.handleImpact(hitObj, ev.point, ev.normal, _camPos);
    if (elecMelee) {
      if (!elecMelee.alreadyBroken) {
        this.showToast(`${elecMelee.label} Damaged — Hold [F] to Repair`, 3.0);
      }
      return;
    }

    const rangeTargetId = hitObj.userData?.openWorldRangeTargetId as string | undefined;
    if (rangeTargetId) {
      this.fobDynamicProps.triggerTargetHit(
        rangeTargetId,
        this.controller.position.x,
        this.controller.position.z,
      );
      return;
    }

    const wildlifeId = hitObj.userData?.openWorldWildlifeId as string | undefined;
    if (wildlifeId) {
      this.wildlifeManager.applyDamageToEntity(
        wildlifeId,
        dmg,
        this.controller.position.x,
        this.controller.position.z,
      );
      return;
    }

    const aiId = hitObj.userData?.openWorldAiId as string | undefined;
    if (aiId) {
      const rawZone = String(hitObj.userData?.hitZone ?? 'torso');
      const hitZone: AiHitZone =
        rawZone === 'head' ? 'head' : rawZone === 'limb' ? 'limb' : 'torso';
      const res = this.aiDirector.applyDamage(aiId, dmg, hitZone, char, ev.direction);
      if (res.hit) {
        if (res.friendlyFire && char && res.standingPenalty > 0) {
          characterRoster.adjustCash(char.slotId, -res.standingPenalty * 20);
        }
        if (res.eliminated) {
          this.handleAiElimination(res.eliminated);
        }
      }
    }
  }

  private handleBallisticImpact(ev: Readonly<BallisticImpactEvent>): void {
    // Disperse any daytime butterflies near bullet impact/path
    this.wildlifeManager.notifyBulletPass(ev.point.x, ev.point.z, 7.5);

    const char = this.getActiveCharacter();

    // 0a. Breakable Open World electronics (FOB terminals, black-market consoles, contract laptops, beacons)
    if (ev.object) {
      this.camera.getWorldPosition(_camPos);
      const elecHit = this.electronicsSystem.handleImpact(ev.object, ev.point, ev.normal, _camPos);
      if (elecHit) {
        if (!elecHit.alreadyBroken) {
          this.showToast(`${elecHit.label} Damaged — Hold [F] to Repair`, 3.2);
        }
        return;
      }
    }

    // 0. FOB Barracks Gun Range & CQB Shoot-House reactive steel target hit
    const rangeTargetId = ev.object?.userData?.openWorldRangeTargetId as string | undefined;
    if (rangeTargetId) {
      const res = this.fobDynamicProps.triggerTargetHit(
        rangeTargetId,
        this.controller.position.x,
        this.controller.position.z,
      );
      if (res?.hit) {
        this.audio.playImpact(ev.point, 'metal');
      }
      return;
    }

    // 1. Convoy Escort Guard hit
    const convoyGuardId = ev.object?.userData?.openWorldConvoyGuardId as string | undefined;
    if (convoyGuardId) {
      const dmg = Math.max(24, Math.min(72, ev.impactEnergyJ * 0.024));
      const res = this.convoyDirector.applyDamageToGuard(convoyGuardId, dmg, char);
      if (res.hit) {
        this.audio.playImpact(ev.point, 'metal');
        if (res.killed) {
          this.killsThisSortie += 1;
        }
      }
      return;
    }

    // 2. Dynamic World Event Guard hit
    const eventGuardId = ev.object?.userData?.openWorldEventGuardId as string | undefined;
    if (eventGuardId) {
      const dmg = Math.max(24, Math.min(72, ev.impactEnergyJ * 0.024));
      const res = this.eventDirector.applyDamageToGuard(eventGuardId, dmg);
      if (res.hit) {
        this.audio.playImpact(ev.point, 'metal');
        if (res.killed) {
          this.killsThisSortie += 1;
        }
      }
      return;
    }

    // 3. Living Wildlife hit (zero popups on wildlife kills)
    const wildlifeId = ev.object?.userData?.openWorldWildlifeId as string | undefined;
    if (wildlifeId) {
      const dmg = Math.max(24, Math.min(75, ev.impactEnergyJ * 0.024));
      const res = this.wildlifeManager.applyDamageToEntity(
        wildlifeId,
        dmg,
        this.controller.position.x,
        this.controller.position.z,
      );
      if (res?.hit) {
        this.audio.playImpact(ev.point, 'wood');
      }
      return;
    }

    // 4. AI Patrol / Garrison hit (Real Friendly Fire enabled in PvPvE & PvE)
    const aiId = ev.object?.userData?.openWorldAiId as string | undefined;
    if (!aiId) return;

    const rawZone = String(ev.object?.userData?.hitZone ?? 'torso');
    const hitZone: AiHitZone =
      rawZone === 'head' ? 'head' : rawZone === 'limb' ? 'limb' : 'torso';
    const baseDmg = Math.max(22, Math.min(68, ev.impactEnergyJ * 0.022));
    const res = this.aiDirector.applyDamage(aiId, baseDmg, hitZone, char, ev.incomingDir);

    if (res.hit) {
      this.audio.playImpact(ev.point, hitZone === 'head' ? 'metal' : 'wood');
      if (hitZone === 'head') {
        this.audio.playHeadshotIndicator();
      }
      if (res.friendlyFire && char && res.standingPenalty > 0) {
        characterRoster.adjustCash(char.slotId, -res.standingPenalty * 25);
      }
      if (res.eliminated) {
        this.handleAiElimination(res.eliminated);
      }
    }
  }

  private handleGrenadeDetonation(ev: GrenadeDetonationEvent): void {
    const char = this.getActiveCharacter();
    const kills = this.aiDirector.applyExplosionSplash(
      ev.position.x,
      ev.position.y,
      ev.position.z,
      Math.max(8, ev.radiusM),
      Math.max(110, ev.maxDamage),
      char,
    );
    for (const k of kills) {
      this.handleAiElimination(k);
    }
    this.camera.getWorldPosition(_camPos);
    this.electronicsSystem.handleExplosion(ev.position, Math.max(8, ev.radiusM), _camPos);
    if (!ev.isTick && (ev.kind === 'frag' || ev.kind === 'thermite' || ev.kind === 'flash')) {
      this.physicsProps.handleBlast(ev.position, Math.max(8.5, ev.radiusM * 1.15), ev.kind === 'frag' ? 14.5 : 8.5);
    }
    this.aiDirector.notifyPlayerGunshot(ev.position.x, ev.position.z, 175);
    this.ambienceAudio.onBallisticImpulse(
      ev.position.x,
      ev.position.z,
      172,
      this.controller.position.x,
      this.controller.position.z,
    );
    this.wildlifeManager.onBallisticImpulse(ev.position.x, ev.position.z, 172);
  }

  private handleAiElimination(ev: AiEliminationEvent): void {
    this.killsThisSortie += 1;
    const char = this.getActiveCharacter();
    if (char) {
      if (ev.bountyUsd > 0) {
        characterRoster.adjustCash(char.slotId, ev.bountyUsd);
      }
      if (ev.subFactionStandingDelta) {
        const d = ev.subFactionStandingDelta;
        characterRoster.updateSubFactionStanding(char.slotId, d.subFactionId, d.delta);
        characterRoster.updateSubFactionStanding(char.slotId, d.rivalId, d.rivalDelta);
      }
    }
    this.emitSnapshot();
  }

  private handleIncomingAiDamage(ev: AiDamageToPlayerEvent): void {
    if (this.playerHp <= 0 || this.navMode !== 'foot') return;
    const resolved = resolvePlayerArmorHit(this.playerHp, this.armorDurability, ev.damage);
    this.playerHp = resolved.nextHp;
    this.armorDurability = resolved.nextArmor;
    this.damageFlashAlpha = Math.min(1.0, this.damageFlashAlpha + 0.65);

    this.controller.applyRecoil(0.025, (Math.random() - 0.5) * 0.03, 0.012, 0.25);

    if (this.playerHp <= 0) {
      this.triggerFieldDeathAtCurrentPosition(
        undefined,
        `KIA by ${ev.attackerCallsign} (${ev.distanceM}m)`,
      );
    }
  }

  private handleWolfBitePlayer(ev: WolfBitePlayerEvent): void {
    if (this.playerHp <= 0 || this.navMode !== 'foot') return;
    // Wolf bites target lower legs & forearms — direct HP damage + active bleeding + sprint slow
    this.playerHp = Math.max(0, this.playerHp - ev.damageHp);
    this.bleedingRemainingSec = Math.max(this.bleedingRemainingSec, ev.bleedDurationSec);
    this.sprintSlowRemainingSec = Math.max(this.sprintSlowRemainingSec, ev.sprintSlowDurationSec);
    this.damageFlashAlpha = Math.min(1.0, this.damageFlashAlpha + 0.85);
    this.controller.applyRecoil(0.05, (Math.random() - 0.5) * 0.08, 0.025, 0.35);
    this.audio.playMeleeImpact(
      new THREE.Vector3(ev.originX, ev.originY, ev.originZ),
      'cross',
      'flesh',
      1.1,
    );

    if (this.playerHp <= 0) {
      this.triggerFieldDeathAtCurrentPosition(
        undefined,
        'KIA · Mauled by Timber Wolf Pack',
      );
    }
  }

  public openInventory(): void {
    this.activeModal = 'inventory';
    this.activeExternalLoot = null;
    this.clearInputs();
    this.exitPointerLock();
    this.emitSnapshot();
  }

  public closeActiveModal(): void {
    this.activeModal = null;
    this.activeExternalLoot = null;
    this.activeBlackMarketContext = null;
    this.emitSnapshot();
  }

  public applyInventoryMutation(
    nextInv: OperatorTacticalInventory,
    nextExternal?: CorpseTacticalLootSnapshot | null,
    statusNote?: string,
  ): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    characterRoster.updateTacticalInventory(char.slotId, nextInv);
    this.grenadeCount = countGrenadesInInventory(nextInv);
    const bpId = nextInv.backpack?.templateId ?? null;
    this.skeleton.setBackpack(isBackpackTemplateId(bpId) ? bpId : null);
    if (isBackpackTemplateId(bpId)) {
      backpackUnlockStore.unlockByWorldPickup(bpId, { isPracticeGear: false });
    }

    if (!this.isNonFirearmEquipped()) {
      const prof = resolveWeaponProfile(this.equippedWeaponId);
      const slotKey = getWeaponSlotByWeaponId(nextInv, prof.id);
      if (slotKey) {
        const loaded = getLoadedAmmoCount(nextInv[slotKey]);
        this.magAmmoByWeapon[prof.id] = loaded;
        this.weaponRig.setAmmoState(loaded, true);
      }
    }

    if (this.activeExternalLoot && nextExternal) {
      if (this.activeExternalLoot.kind === 'corpse') {
        shardStore.updateCorpseTacticalKit(char.shardMode, this.activeExternalLoot.id, nextExternal);
        this.activeExternalLoot = { ...this.activeExternalLoot, lootKit: nextExternal };
      } else if (this.activeExternalLoot.kind === 'event_crate') {
        const cleared = this.eventDirector.markEventLootUpdated(nextExternal);
        this.activeExternalLoot = { ...this.activeExternalLoot, lootKit: nextExternal };
        if (cleared) {
          characterRoster.adjustCash(char.slotId, 1800);
          characterRoster.recordRotatingContractProgress(char.slotId, (rec) => rec.archetype === 'recon', 1);
          this.showToast('WORLD EVENT CRATE CLEARED: +$1,800 Salvage Completion Bonus', 4.8);
        }
      } else if (this.activeExternalLoot.kind === 'ground_backpack' && nextExternal.backpack) {
        this.worldBackpacks.updateContainerContents(this.activeExternalLoot.id, nextExternal.backpack);
        const refreshed = this.worldBackpacks.buildExternalLootContext(this.activeExternalLoot.id);
        this.activeExternalLoot = refreshed ?? null;
      }
    }

    if (statusNote) {
      this.showToast(statusNote, 3.0);
    }
    this.emitSnapshot();
  }

  public dropEquippedBackpack(): void {
    const char = this.getActiveCharacter();
    if (!char?.tacticalInventory?.backpack) return;
    const invClone = cloneTacticalInventory(char.tacticalInventory);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    forward.normalize();

    const dropped = this.worldBackpacks.dropFromInventory(
      invClone,
      this.controller.position,
      forward,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      { ownerLabel: char.callsign },
    );
    if (!dropped) return;

    characterRoster.updateTacticalInventory(char.slotId, invClone);
    this.skeleton.setBackpack(null);
    this.audio.playGearRattle('weapon_swap', 0.65);
    if (!this.activeExternalLoot) {
      this.activeExternalLoot = this.worldBackpacks.buildExternalLootContext(dropped.id);
    }
    this.showToast(
      `Dropped ${dropped.backpack.shortLabel} (${dropped.backpack.grid.items.length} item(s)) on ground`,
      3.0,
    );
    this.emitSnapshot();
  }

  public equipGroundBackpack(containerId: string): {
    ok: boolean;
    error?: string;
    requiresUnequipFirst?: boolean;
  } {
    const char = this.getActiveCharacter();
    if (!char?.tacticalInventory) {
      return { ok: false, error: 'Inventory unavailable.' };
    }
    const invClone = cloneTacticalInventory(char.tacticalInventory);
    const res = this.worldBackpacks.equipFromWorld(containerId, invClone);
    if (!res.ok) return res;

    characterRoster.updateTacticalInventory(char.slotId, invClone);
    const bpId = invClone.backpack?.templateId ?? null;
    this.skeleton.setBackpack(isBackpackTemplateId(bpId) ? bpId : null);
    this.audio.playGearRattle('weapon_swap', 0.7);
    if (this.activeExternalLoot?.id === containerId) {
      this.activeExternalLoot = null;
    }
    this.showToast(
      `Equipped ${invClone.backpack?.shortLabel ?? 'Backpack'} (${invClone.backpack?.grid.items.length ?? 0} item(s) intact)`,
      3.4,
    );
    this.emitSnapshot();
    return { ok: true };
  }

  public playMagPackTickAudio(): void {
    this.audio.playTacticalSwitchClick(true);
  }

  public useMedicalItemFromInventory(locator: ItemSourceLocator, _med: MedicalItem): void {
    const char = this.getActiveCharacter();
    if (!char?.tacticalInventory) return;
    const inv = cloneTacticalInventory(char.tacticalInventory);
    const target = peekItemByLocator(inv, locator, null);
    if (!target || target.kind !== 'medical') return;

    this.playerHp = Math.min(this.playerMaxHp, this.playerHp + target.healHp);
    if (target.stopsBleed) this.bleedingRemainingSec = 0;
    if (target.clearsSprintSlow) this.sprintSlowRemainingSec = 0;

    target.usesRemaining -= 1;
    if (target.usesRemaining <= 0) {
      extractItemByLocator(inv, locator, null);
    }
    characterRoster.updateTacticalInventory(char.slotId, inv);
    this.audio.playGearRattle('weapon_swap', 0.55);
    this.showToast(`Applied ${target.name} (+${target.healHp} HP)`, 3.4);
    this.emitSnapshot();
  }

  public usePdaBatteryFromInventory(locator: ItemSourceLocator): void {
    const char = this.getActiveCharacter();
    if (!char?.tacticalInventory) return;
    const inv = cloneTacticalInventory(char.tacticalInventory);
    const target = peekItemByLocator(inv, locator, null);
    if (!target || target.kind !== 'battery') return;

    const restored = this.pdaDevice.replaceBattery(target.chargePct);
    extractItemByLocator(inv, locator, null);
    characterRoster.updateTacticalInventory(char.slotId, inv);
    this.audio.playTacticalSwitchClick(true);
    this.showToast(`GPS PDA Battery Swapped (${Math.round(restored)}%)`, 3.0);
    this.emitSnapshot();
  }

  public fastTravelToSector(sectorId: string): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const destinations = this.sectorManager.getFastTravelDestinations(char.pmcFaction);
    const target = destinations.find((d) => d.sectorId === sectorId);
    if (!target) return;
    this.closeActiveModal();
    this.teleportToLandmark(target.sectorId, false);
    this.audio.playWeaponCue('mode_toggle', { intensity: 0.7 });
    this.showToast(`Helipad Fast-Travel: Inserted at ${target.name}`, 3.6);
    this.emitSnapshot();
  }

  public fundFobUpgrade(): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = this.logisticsEconomy.fundNextFobUpgrade(char, characterRoster, shardStore);
    if (res.ok) {
      this.sectorManager.syncFromShard(char.shardMode, characterRoster.getCharacter(char.slotId));
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.85 });
    }
    this.showToast(res.message, 4.8);
    this.emitSnapshot();
  }

  public buyFobTraderOffer(offerId: string): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = this.logisticsEconomy.purchaseTraderOffer(
      offerId,
      char,
      characterRoster,
      shardStore,
      { blackMarketDiscount: this.activeModal === 'black_market_terminal' },
    );
    if (res.ok) {
      if (res.equippedPlateId) {
        const plateSpec = ARMOR_PLATE_MAP[res.equippedPlateId];
        this.maxArmorDurability = plateSpec?.durability ?? 60;
        this.armorDurability = this.maxArmorDurability;
        this.armorLabel = plateSpec ? `${plateSpec.ratingLabel} Plate` : 'Armor Plate';
      }
      const refreshed = characterRoster.getCharacter(char.slotId);
      if (refreshed?.tacticalInventory) {
        this.grenadeCount = countGrenadesInInventory(refreshed.tacticalInventory);
      }
      this.audio.playWeaponCue('mag_in', { intensity: 0.65 });
    }
    this.showToast(res.message, 4.0);
    this.emitSnapshot();
  }

  public acceptRotatingContract(slotIndex: number): void {
    const char = this.getActiveCharacter();
    if (!char?.contractBoard) return;
    const target = char.contractBoard.find((rec) => rec.slotIndex === slotIndex) ?? char.contractBoard[slotIndex];
    if (!target) return;
    const updated = characterRoster.acceptRotatingContract(char.slotId, target.instanceId);
    if (updated) {
      this.showToast(`Accepted Contract: ${target.title} (${SUB_FACTION_MAP[target.subFactionId].shortName})`, 4.0);
      this.emitSnapshot();
    }
  }

  public completeRotatingContract(slotIndex: number): void {
    const char = this.getActiveCharacter();
    if (!char?.contractBoard) return;
    const target = char.contractBoard.find((rec) => rec.slotIndex === slotIndex) ?? char.contractBoard[slotIndex];
    if (!target) return;
    const res = characterRoster.completeRotatingContract(char.slotId, target.instanceId);
    if (res.ok && res.completed) {
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.8 });
      this.showToast(
        `Contract Complete: ${res.completed.title} (+$${res.completed.cashRewardUsd.toLocaleString()}, +${res.completed.standingGain} ${SUB_FACTION_MAP[res.completed.subFactionId].shortName})`,
        5.0,
      );
      this.emitSnapshot();
    }
  }

  public sabotageNearestConvoy(): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const inter = this.activeInteractable;
    if (!inter || inter.kind !== 'convoy_hijack') return;
    const res = this.convoyDirector.sabotageConvoy(inter.id, char, characterRoster, shardStore);
    if (res.ok) {
      characterRoster.recordRotatingContractProgress(char.slotId, (rec) => rec.archetype === 'sabotage', 1);
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.9 });
    }
    this.showToast(res.message, 5.2);
    this.emitSnapshot();
  }

  public triggerDynamicWorldEvent(kind: DynamicWorldEventKind): void {
    const char = this.getActiveCharacter();
    const faction: PmcFactionId = char?.pmcFaction ?? 'pmc_alpha';
    const ev = this.eventDirector.triggerEvent(kind, faction);
    if (ev.sectorId) {
      this.sectorManager.markSectorContested(ev.sectorId);
    }
    this.audio.playWeaponCue('mode_toggle', { intensity: 0.75 });
    this.showToast(`WORLD EVENT ACTIVE: ${ev.title} (${Math.round(ev.x)}, ${Math.round(ev.z)})`, 5.5);
    this.emitSnapshot();
  }

  public executeFieldInteraction(): void {
    const inter = this.activeInteractable;
    const char = this.getActiveCharacter();
    if (!inter) return;

    if (inter.kind === 'live_round_pickup') {
      const roundId = Number(inter.id);
      const collected = this.ejectedLiveRounds.collectRound(roundId);
      if (collected) {
        let storedInInventory = false;
        if (char?.tacticalInventory) {
          const invClone = cloneTacticalInventory(char.tacticalInventory);
          const resolvedVariant: AmmoVariantId =
            collected.caliberId in AMMO_VARIANTS
              ? (collected.caliberId as AmmoVariantId)
              : getDefaultAmmoVariant(collected.caliberId).id;

          // Try stacking onto an existing loose ammo box of the same variant first
          const grids = [
            ...(invClone.chestRig ? [invClone.chestRig.generalGrid] : []),
            ...(invClone.backpack ? [invClone.backpack.grid] : []),
            invClone.secureContainer,
          ];
          for (const grid of grids) {
            const match = grid.items.find(
              (entry) =>
                entry.item.kind === 'ammo_stack' &&
                entry.item.variantId === resolvedVariant &&
                entry.item.count < entry.item.maxStack,
            );
            if (match && match.item.kind === 'ammo_stack') {
              match.item.count += 1;
              storedInInventory = true;
              break;
            }
          }
          if (!storedInInventory) {
            const looseItem = createAmmoStackItem(resolvedVariant, 1);
            for (const grid of grids) {
              if (autoPlaceItemInGrid(grid, looseItem)) {
                storedInInventory = true;
                break;
              }
            }
          }
          if (storedInInventory) {
            characterRoster.updateTacticalInventory(char.slotId, invClone);
          }
        }
        if (!storedInInventory && this.activeSlotId) {
          characterRoster.addArsenalReserve(this.activeSlotId, collected.weaponId, 1);
        }
        this.audio.playGearRattle('crouch', 0.42);
        this.showToast(`+1 ${collected.caliberLabel} Round Recovered`, 2.0);
        this.activeInteractable = null;
        this.emitSnapshot();
      }
      return;
    }

    if (inter.kind === 'wildlife_harvest') {
      const harvest = this.wildlifeManager.harvestCarcass(inter.id);
      if (harvest) {
        if (char) {
          characterRoster.adjustCash(char.slotId, harvest.cashUsd);
        }
        this.showToast(harvest.summaryLabel, 4.5);
        this.activeInteractable = null;
        this.emitSnapshot();
      }
      return;
    }

    if (inter.kind === 'ground_backpack') {
      const ctx = this.worldBackpacks.buildExternalLootContext(inter.id);
      if (ctx) {
        this.activeModal = 'inventory';
        this.activeExternalLoot = ctx;
        this.clearInputs();
        this.exitPointerLock();
        this.audio.playGearRattle('weapon_swap', 0.55);
        this.emitSnapshot();
      }
      return;
    }

    if (!char) return;

    if (!inter.canExecute) {
      this.showToast(inter.blockedReason ?? 'Action currently unavailable.');
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'fob_terminal') {
      this.activeModal = 'fob_terminal';
      this.activeExternalLoot = null;
      this.clearInputs();
      this.exitPointerLock();
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.55 });
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'convoy_hijack') {
      const res = this.convoyDirector.hijackAndRerouteConvoy(inter.id, char, characterRoster, shardStore);
      if (res.ok) {
        characterRoster.recordRotatingContractProgress(char.slotId, (rec) => rec.archetype === 'supply', 1);
        this.audio.playWeaponCue('mode_toggle', { intensity: 0.85 });
      }
      this.showToast(res.message, 5.2);
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'world_event_crate') {
      const ev = this.eventDirector.getActiveEvent();
      if (ev) {
        this.activeModal = 'event_loot';
        this.activeExternalLoot = {
          kind: 'event_crate',
          id: ev.eventId,
          title: ev.title,
          subtitle: ev.summary,
          lootKit: cloneCorpseLootSnapshot(ev.lootKit),
        };
        this.clearInputs();
        this.exitPointerLock();
        this.audio.playGearRattle('weapon_swap', 0.55);
        this.emitSnapshot();
      }
      return;
    }

    if (inter.kind === 'contract') {
      const res = this.sectorManager.executeContractTerminal(inter.id, char);
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.7 });
      this.showToast(res.message, 5.5);
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'fob_resupply') {
      characterRoster.resupplyArsenalAmmo(char.slotId);
      this.playerHp = this.playerMaxHp;
      this.armorDurability = this.maxArmorDurability;
      this.bleedingRemainingSec = 0;
      this.sprintSlowRemainingSec = 0;
      this.audio.playWeaponCue('mag_in', { intensity: 0.8 });
      this.showToast('FOB Field Hospital: 100% HP, Bleeding/Trauma Cured & Armor Repaired');
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'armory_stash' || inter.kind === 'subfaction_stash') {
      characterRoster.getOrInitTacticalStash(char.slotId);
      this.activeModal = 'armory_stash';
      this.activeExternalLoot = null;
      this.clearInputs();
      this.exitPointerLock();
      this.audio.playGearRattle('weapon_swap', 0.65);
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'subfaction_medic') {
      this.playerHp = this.playerMaxHp;
      this.bleedingRemainingSec = 0;
      this.sprintSlowRemainingSec = 0;
      this.audio.playWeaponCue('mag_in', { intensity: 0.75 });
      this.showToast(`${inter.label}: 100% HP Restored · Bleeding & Leg Trauma Cleared`, 3.6);
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'subfaction_black_market') {
      this.activeModal = 'black_market_terminal';
      this.activeExternalLoot = null;
      const traderMatch = /\(([^)]+)\)/.exec(inter.label);
      this.activeBlackMarketContext = {
        subFactionName: inter.label.replace(/\s*Black-Market Terminal.*$/i, '').trim(),
        traderName: traderMatch ? traderMatch[1] : 'Black-Market Quartermaster',
        discountPct: 15,
      };
      this.clearInputs();
      this.exitPointerLock();
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.6 });
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'fob_vehicle_repair') {
      this.armorDurability = this.maxArmorDurability;
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.75 });
      this.showToast('Tier 3 Repair Bay: Vehicles Refueled & Repaired · Ballistic Plate Restored', 3.8);
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'fob_helipad_travel') {
      this.activeModal = 'helipad_travel';
      this.activeExternalLoot = null;
      this.clearInputs();
      this.exitPointerLock();
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.6 });
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'corpse') {
      const corpse = shardStore
        .getShard(char.shardMode)
        .corpses.find((c) => c.corpseId === inter.id);
      if (!corpse) {
        this.showToast('Corpse already cleared.');
        return;
      }
      if (char.shardMode === 'PvE' && corpse.ownerCharacterId !== char.characterId) {
        this.showToast('PvE Shard Rule: Only the corpse owner may recover dropped gear.');
        return;
      }
      if (corpse.droppedTacticalKit) {
        this.activeModal = 'corpse_loot';
        this.activeExternalLoot = {
          kind: 'corpse',
          id: corpse.corpseId,
          title: `KIA Corpse · ${corpse.ownerCallsign}`,
          subtitle: `${corpse.shardMode} Full-Drop · ${corpse.causeOfDeath} · Drag items or swap Backpack/Rig`,
          lootKit: cloneCorpseLootSnapshot(corpse.droppedTacticalKit),
        };
        this.clearInputs();
        this.exitPointerLock();
        this.audio.playGearRattle('weapon_swap', 0.6);
        this.emitSnapshot();
        return;
      }

      const lootRes = shardStore.lootAndRemoveCorpse(
        char.shardMode,
        inter.id,
        char.characterId,
        char.callsign,
      );
      if (!lootRes.ok || !lootRes.corpse) {
        this.showToast(lootRes.error ?? 'Cannot loot corpse.');
        this.emitSnapshot();
        return;
      }
      characterRoster.addRecoveredCorpseLoot(
        char.slotId,
        lootRes.corpse.droppedWeaponIds,
        lootRes.corpse.droppedItems,
      );
      this.audio.playGearRattle('weapon_swap', 0.6);
      this.showToast(
        `Recovered ${lootRes.corpse.droppedWeaponIds.length} weapon(s) & ${lootRes.corpse.droppedItems.length} item(s) from ${lootRes.corpse.ownerCallsign}`,
      );
      this.rebuildShardCorpseMarkers();
      this.emitSnapshot();
    }
  }

  public depositItemToArmoryStash(locator: ItemSourceLocator): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = characterRoster.depositTacticalItemToStash(char.slotId, locator);
    if (!res.ok) {
      this.showToast(res.error ?? 'Could not deposit item into Armory Stash.');
    } else if (res.item) {
      const updated = this.getActiveCharacter();
      if (updated?.tacticalInventory) {
        this.grenadeCount = countGrenadesInInventory(updated.tacticalInventory);
      }
      this.audio.playGearRattle('weapon_swap', 0.45);
      this.showToast(`Stored ${res.item.name} in FOB Armory Stash Lockers`, 2.6);
    }
    this.emitSnapshot();
  }

  public withdrawItemFromArmoryStash(
    stashInstanceId: string,
    target: 'auto' | 'backpack' | 'secure' | 'belt' = 'auto',
  ): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = characterRoster.withdrawStashItemToInventory(char.slotId, stashInstanceId, target);
    if (!res.ok) {
      this.showToast(res.error ?? 'No free inventory space to withdraw item.');
    } else if (res.item) {
      const updated = this.getActiveCharacter();
      if (updated?.tacticalInventory) {
        this.grenadeCount = countGrenadesInInventory(updated.tacticalInventory);
      }
      this.audio.playGearRattle('weapon_swap', 0.45);
      this.showToast(`Withdrew ${res.item.name} into Field Kit`, 2.6);
    }
    this.emitSnapshot();
  }

  public equipArmoryWeapon(slotKey: 'primary' | 'secondary', weaponId: string): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = characterRoster.equipArmoryWeaponSlot(char.slotId, slotKey, weaponId);
    if (!res.ok) {
      this.showToast(res.error ?? 'Could not equip firearm.');
      this.emitSnapshot();
      return;
    }
    const prof = resolveWeaponProfile(weaponId);
    if (slotKey === 'primary' || this.equippedWeaponId === 'unarmed') {
      this.equipWeapon(prof.id);
    }
    this.audio.playWeaponCue('mag_in', { intensity: 0.65 });
    this.showToast(`Armory Rack: ${prof.name} assigned to ${slotKey.toUpperCase()}`, 2.8);
    this.emitSnapshot();
  }

  public equipArmoryArmorPlate(plateId: string): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    const res = characterRoster.equipArmoryArmorPlate(char.slotId, plateId);
    if (!res.ok) {
      this.showToast(res.error ?? 'Could not equip armor plate.');
      this.emitSnapshot();
      return;
    }
    const spec = ARMOR_PLATE_MAP[plateId];
    if (spec) {
      this.maxArmorDurability = spec.durability;
      this.armorDurability = spec.durability;
      this.armorLabel = `${spec.ratingLabel} Plate`;
    }
    this.audio.playGearRattle('weapon_swap', 0.6);
    this.showToast(`Armory Bench: Inserted ${spec?.name ?? plateId}`, 2.8);
    this.emitSnapshot();
  }

  public resupplyArmoryAmmo(): void {
    const char = this.getActiveCharacter();
    if (!char) return;
    characterRoster.resupplyArsenalAmmo(char.slotId);
    this.audio.playWeaponCue('mag_in', { intensity: 0.72 });
    this.showToast('FOB Armory: Reserve ammunition topped off', 2.8);
    this.emitSnapshot();
  }

  public setNavMode(mode: OpenWorldNavMode): void {
    if (this.navMode === mode) return;
    this.navMode = mode;
    if (mode === 'recon_flight') {
      this.pdaDevice.setOpen(false);
      this.isFiring = false;
      this.input.ads = false;
      this.flightX = this.controller.position.x;
      this.flightZ = this.controller.position.z;
      const ground = this.streamer.sampleGroundHeight(this.flightX, this.flightZ);
      this.flightY = Math.max(ground + 45, this.controller.position.y + 42);
      this.flightYaw = this.controller.aimYaw;
      this.flightPitch = -0.24;
      this.skeleton.root.visible = false;
      this.weaponRig.root.visible = false;
    } else {
      const ground = Math.max(
        SEA_LEVEL_M + 0.35,
        this.streamer.sampleGroundHeight(this.flightX, this.flightZ),
      );
      this.controller.position.set(this.flightX, ground, this.flightZ);
      this.controller.torsoYaw = this.flightYaw;
      this.controller.aimYaw = this.flightYaw;
      this.controller.torsoPitch = 0;
      this.controller.aimPitch = 0;
      this.skeleton.root.visible = true;
    }
    this.emitSnapshot();
  }

  private runScopeRenderPass(): void {
    if (this.disposed || this.navMode !== 'foot' || !this.weaponRig.root.visible) return;
    if (!this.weaponRig.isMagnifiedOpticActive()) return;
    const rigState = this.weaponRig.getReadOnlyRigState();
    if (rigState.adsBlend < 0.05) return;
    const sp = this._scopePassParams;
    sp.assembly = this.weaponRig.getModelAssembly();
    sp.isMagnifiedOptic = true;
    sp.zoomMult = this.weaponRig.getActiveOpticZoomMult();
    sp.adsBlend = rigState.adsBlend;
    sp.cantBlend = rigState.cantBlend;
    sp.opticParallaxStrength = this.config.opticParallaxStrength ?? 1.0;
    sp.reticleIlluminated = this.weaponRig.reticleIlluminated;
    sp.flashlightOn = this.flashlightOn && this.weaponRig.getDerivedStats().hasFlashlight;
    sp.sightMisalignYaw = rigState.sightMisalignYaw;
    sp.sightMisalignPitch = rigState.sightMisalignPitch;
    sp.elapsed = this.elapsedSec;
    sp.mainAvgLuminance = this.postProcess ? this.postProcess.getAverageLuminance() : 0.22;
    this.atmosphere.setGodraysEnabledForPass(false);
    try {
      this.scopeRenderer.renderScopePass(sp);
    } finally {
      this.atmosphere.setGodraysEnabledForPass(true);
    }
  }

  private ensurePostProcess(): BodycamPostProcess {
    if (!this.postProcess) {
      this.postProcess = new BodycamPostProcess(
        this.renderer,
        this.scene,
        this.camera,
        this.isSoftwareGl,
      );
      this.postProcess.setSize(
        Math.max(1, this.container.clientWidth),
        Math.max(1, this.container.clientHeight),
      );
      this.postProcess.setNvgState(this.nvgMode, this.nvgMode !== 'none', false);
      this.postProcess.setBeforeMainRenderCallback(() => {
        this.runScopeRenderPass();
        this.atmosphere.prepareGodrays(this.renderer, this.camera);
      });
    }
    return this.postProcess;
  }

  private applyRenderPipelineMode(mode: OpenWorldRenderPipeline): void {
    this.renderPipeline = mode;
    if (mode === 'bodycam_post') {
      const pp = this.ensurePostProcess();
      // BodycamPostProcess runs its own ACES tone-mapping pass in GLSL
      this.renderer.toneMapping = THREE.NoToneMapping;
      pp.setNvgState(this.nvgMode, this.nvgMode !== 'none', false);
    } else {
      // Direct 2-Pass renders straight to the default framebuffer with WebGL ACES tone-mapping
      this.renderer.setRenderTarget(null);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.08;
    }
  }

  public setRenderPipeline(mode: OpenWorldRenderPipeline): void {
    if (this.renderPipeline === mode) return;
    this.applyRenderPipelineMode(mode);
    saveStoredRenderPrefs({
      renderPipeline: this.renderPipeline,
      lensPreset: this.config.lensPreset,
    });
    this.emitSnapshot();
  }

  public setLensPreset(preset: BodycamLensPresetId): void {
    applyLensPresetToConfig(this.config, preset);
    saveStoredRenderPrefs({
      renderPipeline: this.renderPipeline,
      lensPreset: this.config.lensPreset,
    });
    this.emitSnapshot();
  }

  public setNvgMode(mode: OpenWorldNvgMode): void {
    this.nvgMode = mode;
    if (mode !== 'none' && this.renderPipeline !== 'bodycam_post') {
      this.applyRenderPipelineMode('bodycam_post');
      saveStoredRenderPrefs({
        renderPipeline: this.renderPipeline,
        lensPreset: this.config.lensPreset,
      });
    }
    this.postProcess?.setNvgState(mode, mode !== 'none', false);
    this.audio.playTacticalSwitchClick(mode !== 'none');
    this.emitSnapshot();
  }

  public cycleNvgMode(): void {
    const next: OpenWorldNvgMode =
      this.nvgMode === 'none' ? 'pvs7' : this.nvgMode === 'pvs7' ? 'arnvg' : 'none';
    this.setNvgMode(next);
  }

  public toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.audio.playTacticalSwitchClick(this.flashlightOn);
    this.emitSnapshot();
  }

  public setTimeOfDay(hours: number): void {
    this.atmosphere.setTimeOfDay(hours);
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.emitSnapshot();
  }

  public setWeather(weather: OpenWorldWeatherId): void {
    this.atmosphere.transitionToWeather(weather, 4.0);
    this.emitSnapshot();
  }

  public setAutoWeatherCycle(enabled: boolean): void {
    this.atmosphere.setAutoWeatherCycle(enabled);
    this.emitSnapshot();
  }

  public setTimeScale(scale: number): void {
    this.atmosphere.setTimeScale(scale);
    this.emitSnapshot();
  }

  public teleportToLandmark(landmarkId: string, emit = true): void {
    const lm: OpenWorldLandmarkSpec =
      OPENWORLD_LANDMARKS.find((l) => l.id === landmarkId) ?? OPENWORLD_LANDMARKS[0];
    const pose = computeLandmarkSpawnPose(lm);
    this.streamer.update(pose.spawnX, pose.spawnZ, true);
    const rawGround = this.streamer.sampleGroundHeight(pose.spawnX, pose.spawnZ);
    const ground = Math.max(
      SEA_LEVEL_M + 0.35,
      this.streamer.sampleGroundAndDeckHeight(pose.spawnX, pose.spawnZ, rawGround + 1.5),
    );
    if (this.renderer.shadowMap.enabled) {
      this.renderer.shadowMap.needsUpdate = true;
    }

    this.controller.position.set(pose.spawnX, ground, pose.spawnZ);
    this.controller.torsoYaw = pose.faceYaw;
    this.controller.aimYaw = pose.faceYaw;
    this.controller.torsoPitch = pose.footPitch;
    this.controller.aimPitch = pose.footPitch;
    this.skeleton.applyCanonicalRestPose();
    this.animator.resetSecondaryPhysics();

    this.flightX = pose.spawnX;
    this.flightZ = pose.spawnZ;
    this.flightY = ground + 55;
    this.flightYaw = pose.faceYaw;
    this.flightPitch = pose.flightPitch;

    if (emit) this.emitSnapshot();
  }

  public commitExfilToHideout(): OpenWorldCharacter | null {
    if (!this.activeSlotId) return null;
    const updated = characterRoster.recordExfil(this.activeSlotId, 0);
    if (updated) {
      const px = this.navMode === 'foot' ? this.controller.position.x : this.flightX;
      const pz = this.navMode === 'foot' ? this.controller.position.z : this.flightZ;
      const nearest = getNearestLandmark(px, pz);
      shardStore.recordDiscreteTransition(
        updated.shardMode,
        'exfil',
        `${updated.callsign} exfilled safely near ${nearest.landmark.shortLabel}`,
      );
    }
    this.emitSnapshot();
    return updated;
  }

  public triggerFieldDeathAtCurrentPosition(
    hospitalId?: string,
    causeOfDeath = 'KIA · Perimeter Operations Field Engagement',
  ): CharacterDeathOutcome | null {
    if (!this.activeSlotId) return null;
    const px = this.navMode === 'foot' ? this.controller.position.x : this.flightX;
    const pz = this.navMode === 'foot' ? this.controller.position.z : this.flightZ;
    const nearest = getNearestLandmark(px, pz);
    const outcome = processCharacterDeath(characterRoster, shardStore, {
      slotId: this.activeSlotId,
      hospitalId,
      worldX: Math.round(px),
      worldZ: Math.round(pz),
      sectorLabel: nearest.landmark.name,
      causeOfDeath,
    });
    this.lastDeathOutcome = outcome;

    if (outcome?.outcome === 'permadeath_wiped') {
      this.activeSlotId = characterRoster.getActiveSlotId();
      this.exitPointerLock();
    } else if (outcome?.outcome === 'field_hospital_respawn') {
      // Recover at home FOB / Field Hospital with fresh vitals & remaining starter weapon
      this.playerHp = this.playerMaxHp;
      this.armorDurability = this.maxArmorDurability;
      this.bleedingRemainingSec = 0;
      this.sprintSlowRemainingSec = 0;
      this.stamina = 1.0;
      this.heartRateBpm = 74;
      this.holdRepair.cancel(this.interactAnimator);
      this.aiDirector.resetProvocations();
      const respawnLandmark =
        outcome.updatedCharacter.pmcFaction === 'pmc_bravo'
          ? 'landmark_fob_bravo'
          : 'landmark_fob_alpha';
      this.teleportToLandmark(respawnLandmark, false);
      this.syncCharacterLoadout(outcome.updatedCharacter);
    }

    this.rebuildShardCorpseMarkers();
    this.emitSnapshot();
    return outcome;
  }

  private rebuildShardCorpseMarkers(): void {
    while (this.corpseMarkerGroup.children.length > 0) {
      this.corpseMarkerGroup.remove(this.corpseMarkerGroup.children[0]);
    }
    for (const g of this.corpseGeometries) g.dispose();
    for (const m of this.corpseMaterials) m.dispose();
    this.corpseGeometries.length = 0;
    this.corpseMaterials.length = 0;

    const active = this.getActiveCharacter();
    if (!active) return;
    const shard = shardStore.getShard(active.shardMode);
    if (shard.corpses.length === 0) return;

    const bagGeo = new THREE.BoxGeometry(1.1, 0.55, 0.75);
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 4.2, 6);
    const beaconGeo = new THREE.OctahedronGeometry(0.32, 0);
    const bagMat = new THREE.MeshStandardMaterial({ color: 0x3b352c, roughness: 0.85, metalness: 0.1 });
    const beaconMat = new THREE.MeshStandardMaterial({
      color: active.shardMode === 'PvPvE' ? 0xef4444 : 0x38bdf8,
      emissive: active.shardMode === 'PvPvE' ? 0x991b1b : 0x0369a1,
      emissiveIntensity: 1.0,
      roughness: 0.3,
    });
    this.corpseGeometries.push(bagGeo, poleGeo, beaconGeo);
    this.corpseMaterials.push(bagMat, beaconMat);

    for (const corpse of shard.corpses) {
      const y = Math.max(SEA_LEVEL_M + 0.2, this.streamer.sampleGroundHeight(corpse.worldX, corpse.worldZ));
      const g = new THREE.Group();
      g.position.set(corpse.worldX, y, corpse.worldZ);
      const bag = new THREE.Mesh(bagGeo, bagMat);
      bag.position.y = 0.28;
      const pole = new THREE.Mesh(poleGeo, bagMat);
      pole.position.y = 2.1;
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = 4.4;
      g.add(bag, pole, beacon);
      this.corpseMarkerGroup.add(g);
    }
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameHandle = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameHandle = window.setTimeout(cb, 80);
      }
    };
    this.frameHandle = window.setTimeout(poll, 5);
  }

  private readonly tick = (): void => {
    if (this.disposed) return;

    const now = performance.now();
    const rawDt = Math.max(0.001, (now - this.lastNowMs) * 0.001);
    const dt = Math.min(0.05, rawDt);
    this.lastNowMs = now;
    this.elapsedSec += dt;

    if (this.toastTimerSec > 0) {
      this.toastTimerSec = Math.max(0, this.toastTimerSec - dt);
      if (this.toastTimerSec <= 0) this.toastMessage = null;
    }
    if (this.damageFlashAlpha > 0) {
      this.damageFlashAlpha = Math.max(0, this.damageFlashAlpha - dt * 1.9);
    }
    if (this.hitMarkerAlpha > 0) {
      this.hitMarkerAlpha = Math.max(0, this.hitMarkerAlpha - dt * 4.5);
    }

    const activeChar = this.getActiveCharacter();

    if (this.navMode === 'foot') {
      this.stepFootBodycam(dt, activeChar);
    } else {
      this.stepReconFlight(dt);
    }

    const px = this.navMode === 'foot' ? this.controller.position.x : this.flightX;
    const py = this.navMode === 'foot' ? this.controller.position.y + 1.45 : this.flightY;
    const pz = this.navMode === 'foot' ? this.controller.position.z : this.flightZ;

    // Tick wolf-bite bleeding & leg-trauma sprint slow
    if (this.bleedingRemainingSec > 0 && this.playerHp > 0 && this.navMode === 'foot') {
      this.bleedingRemainingSec = Math.max(0, this.bleedingRemainingSec - dt);
      this.playerHp = Math.max(0, this.playerHp - dt * 1.45);
      this.damageFlashAlpha = Math.max(
        this.damageFlashAlpha,
        0.12 + Math.sin(this.elapsedSec * 5.2) * 0.06,
      );
      if (this.playerHp <= 0) {
        this.triggerFieldDeathAtCurrentPosition(undefined, 'KIA · Exsanguination from Wolf Bite');
      }
    }
    if (this.sprintSlowRemainingSec > 0) {
      this.sprintSlowRemainingSec = Math.max(0, this.sprintSlowRemainingSec - dt);
    }

    // Track horizontal speed smoothly for wind velocity & cricket proximity ducking
    const moveStep = Math.hypot(px - this.lastPlayerX, pz - this.lastPlayerZ);
    const instSpeed = dt > 0.001 ? Math.min(25, moveStep / dt) : 0;
    this.smoothPlayerSpeedMps = this.smoothPlayerSpeedMps * 0.85 + instSpeed * 0.15;
    this.lastPlayerX = px;
    this.lastPlayerZ = pz;

    // Stream 3x3 active / 5x5 mid-range rings incrementally (center chunk immediate, outer rings time-sliced)
    this.streamer.update(px, pz, false);
    this.streamer.flushStreamQueue(3.5);

    // Update 90-minute day/night lighting, sky dome, fog, rain & roadside night emissives
    this.atmosphere.update(dt, px, py, pz);
    const nightFactor = this.atmosphere.getNightFactor();
    this.streamer.setNightFactor(nightFactor);
    const atmoTel = this.atmosphere.getTelemetry();
    const currentBiome = this.sampleBiomeAt(px, pz);

    // Derive dynamic weather wind speed, gust envelope & wetness for audio + GPU foliage shader
    const altitudeWindBoost = THREE.MathUtils.clamp((py - 40) / 340, 0, 1) * 5.5;
    const baseWindMps =
      atmoTel.weather === 'mountain_rain'
        ? 11.5
        : atmoTel.weather === 'coastal_fog'
          ? 6.2
          : 3.4;
    const gust01 = Math.max(
      0,
      Math.sin(this.elapsedSec * 0.31) * 0.55 + Math.sin(this.elapsedSec * 0.77 + 1.4) * 0.45,
    );
    const windSpeedMps = baseWindMps + altitudeWindBoost + gust01 * 3.8;
    const wetness01 = atmoTel.weather === 'mountain_rain' ? 0.92 : atmoTel.weather === 'coastal_fog' ? 0.35 : 0.0;
    const windAng = 0.56 + Math.sin(this.elapsedSec * 0.07) * 0.25;
    this.physicsProps.setWind(Math.cos(windAng), Math.sin(windAng), Math.min(2.3, windSpeedMps * 0.14));
    if (this.navMode === 'foot' && this.playerHp > 0) {
      this.controller.getVelocity(this._propActorVelScratch);
      this.physicsProps.applyActorFootstepWake(this.controller.position, this._propActorVelScratch, 0.54);
    }
    this.physicsProps.update(dt, this.camera.position);

    this.camera.updateMatrixWorld();
    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_lookDir);
    _cullProjScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    _cullFrustum.setFromProjectionMatrix(_cullProjScreen);

    // Populate conservative software Hi-Z occlusion depth buffer from large solid structures & landmarks
    this.streamer.prepareOcclusionCuller(
      this.occlusionCuller,
      this.camera,
      _camPos.x,
      _camPos.y,
      _camPos.z,
    );

    this.audio.setWindWeather(windSpeedMps, gust01, atmoTel.weather === 'mountain_rain' ? 0.85 : 0);
    this.streamer.updateFoliageWindAndGrass(
      this.elapsedSec,
      windSpeedMps,
      gust01,
      wetness01,
      px,
      pz,
      _lookDir.x,
      _lookDir.z,
    );
    this.streamer.updateAmbientSmoke(dt);

    // Update Spatial Ambience Engine (Wind/Foliage + Water/Marsh beds, Night Owls, Proximity-Ducked Crickets)
    this.ambienceAudio.update({
      dt,
      timeOfDayHours: atmoTel.timeOfDayHours,
      nightFactor,
      weather: atmoTel.weather,
      windSpeedMps,
      gust01,
      playerX: px,
      playerY: py,
      playerZ: pz,
      playerSpeedMps: this.smoothPlayerSpeedMps,
      biome: currentBiome,
      nearbyTreeRoosts: this.streamer.getActiveTreeRoosts(),
    });

    // Update Living Ecosystem (Wolf Packs, Deer Herds, Physical Frogs, Daytime Butterflies, Spiders & Ants)
    this.wildlifeManager.update({
      dt,
      elapsedSec: this.elapsedSec,
      timeOfDayHours: atmoTel.timeOfDayHours,
      nightFactor,
      windSpeedMps,
      isRaining: atmoTel.weather === 'mountain_rain',
      playerX: px,
      playerY: py,
      playerZ: pz,
      playerYawRad: this.navMode === 'foot' ? this.controller.aimYaw : this.flightYaw,
      playerSpeedMps: this.smoothPlayerSpeedMps,
      playerCrouched: this.input.crouch,
      playerSprinting: this.controller.isSprinting,
      playerAlive: this.playerHp > 0,
      playerOnFoot: this.navMode === 'foot',
      flashlightOn: this.flashlightOn,
      nearbyLogs: this.streamer.getActiveLogAnchors(),
      nearbyRocks: this.streamer.getActiveRockAnchors(),
      occlusionCuller: this.occlusionCuller,
      sampleIndoorAt: (x, y, z, out) => this.streamer.sampleIndoorAt(x, y, z, out),
      onWolfBitePlayer: (ev) => this.handleWolfBitePlayer(ev),
    });

    // Update Phase 3 Tactical AI Squads (vision scaled by Atmosphere + Flashlight + 3-tier LOD, frustum & occlusion culling)
    this.camera.getWorldPosition(_camPos);
    const camRight = _camRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const flybyCtx = {
      listenerHeadPos: _camPos,
      listenerRightDir: camRight,
      audio: this.audio,
      onSupersonicNearMiss: (flinchDeg: number, sideSign: number) => {
        if (this.navMode === 'foot' && this.playerHp > 0) {
          this.controller.applyBallisticMicroFlinch(flinchDeg, sideSign);
        }
      },
    };
    this.aiDirector.update(
      dt,
      px,
      py,
      pz,
      this.navMode === 'foot',
      this.playerHp > 0,
      this.flashlightOn,
      atmoTel.aiVisionConeMultiplier,
      atmoTel.nightOpsActive,
      activeChar,
      (ev) => this.handleIncomingAiDamage(ev),
      {
        playerAds: this.input.ads,
        playerAimDirX: _lookDir.x,
        playerAimDirY: _lookDir.y,
        playerAimDirZ: _lookDir.z,
        frustum: _cullFrustum,
        occlusionCuller: this.occlusionCuller,
        onNeutralWarning: () => {
          this.audio.playTacticalSwitchClick(true);
        },
        onAiGunshot: (shotEv) => {
          this.audio.playWeaponCue('fire', {
            position: shotEv.muzzlePos,
            weightClass: shotEv.weightClass,
            caliberId: shotEv.caliberId,
            suppressed: shotEv.suppressed,
            isSubsonic: shotEv.isSubsonic,
            intensity: shotEv.isAmbientDistant ? 0.82 : 0.96,
            maxAudibleDistanceM: 650,
            speedOfSoundDelay: true,
          });
          if (!shotEv.isAmbientDistant && this.navMode === 'foot') {
            BallisticsSolver.triggerSegmentFlyby(
              shotEv.muzzlePos,
              shotEv.targetEndPos,
              shotEv.muzzleVelocityMs,
              shotEv.caliberMm,
              shotEv.energyJ,
              flybyCtx,
            );
          }
        },
      },
    );

    // Step FOB Tier 3 Live AA/Mortar Perimeter Defense Turrets
    const defenseTurrets = this.sectorManager.getFobDefenseTurrets();
    const shardModeNow = activeChar?.shardMode ?? 'PvPvE';
    for (let i = 0; i < defenseTurrets.length; i++) {
      const turret = defenseTurrets[i];
      if (shardStore.getFobTier(shardModeNow, turret.faction) < 3) continue;
      if (turret.fireCooldown > 0) turret.fireCooldown = Math.max(0, turret.fireCooldown - dt);
      if (turret.muzzleFlashTimer > 0) {
        turret.muzzleFlashTimer = Math.max(0, turret.muzzleFlashTimer - dt);
        if (turret.muzzleFlashTimer <= 0) turret.muzzleFlashMesh.visible = false;
      }
      const target = this.aiDirector.findNearestHostileToPoint(
        turret.worldX,
        turret.worldZ,
        145,
        turret.faction,
        shardModeNow,
      );
      if (target) {
        const wantYaw = Math.atan2(target.x - turret.worldX, target.z - turret.worldZ);
        const curYaw = turret.headMesh.rotation.y;
        const diff = Math.atan2(Math.sin(wantYaw - curYaw), Math.cos(wantYaw - curYaw));
        turret.headMesh.rotation.y = curYaw + diff * Math.min(1, dt * 6.0);
        if (turret.fireCooldown <= 0 && Math.abs(diff) < 0.35) {
          turret.fireCooldown = 1.65;
          turret.muzzleFlashTimer = 0.08;
          turret.muzzleFlashMesh.visible = true;
          this.aiDirector.applyTurretDamage(target.agentId, 46, turret.worldX, turret.worldZ);
          if (Math.hypot(px - turret.worldX, pz - turret.worldZ) <= 650) {
            this.audio.playWeaponCue('fire', {
              position: _muzzlePos.set(turret.worldX, turret.worldY, turret.worldZ),
              weightClass: 'heavy_rifle',
              caliberId: '762x51',
              suppressed: false,
              maxAudibleDistanceM: 650,
              speedOfSoundDelay: true,
            });
          }
        }
      }
    }

    // Update FOB Checkpoint Boom Gates (AI guard controlled) & reactive Barracks Gun Range / CQB targets
    const alphaGateOpen = this.aiDirector.evaluateFobGateControl(
      'landmark_fob_alpha',
      px,
      pz,
      this.playerHp > 0,
      activeChar,
    );
    const bravoGateOpen = this.aiDirector.evaluateFobGateControl(
      'landmark_fob_bravo',
      px,
      pz,
      this.playerHp > 0,
      activeChar,
    );
    this.fobDynamicProps.setGateTargetOpen('landmark_fob_alpha', alphaGateOpen);
    this.fobDynamicProps.setGateTargetOpen('landmark_fob_bravo', bravoGateOpen);
    this.fobDynamicProps.update(dt);

    // Update Phase 3 & 4 Dynamic Territory Control, Supply Depots, Convoys, World Events & FOB Restock
    const capEv = this.sectorManager.update(dt, px, pz, activeChar, (secId) =>
      this.aiDirector.getHostileGarrisonCount(secId, activeChar),
    );
    if (capEv) {
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.85 });
      if (activeChar) {
        characterRoster.recordRotatingContractProgress(activeChar.slotId, (rec) => rec.archetype === 'recon', 1);
      }
    }

    if (activeChar) {
      const shard = shardStore.getShard(activeChar.shardMode);
      this.logisticsEconomy.update(
        dt,
        shard.pmcSupplyPools[activeChar.pmcFaction],
        shard.restockPenaltySec[activeChar.pmcFaction] ?? 0,
      );
    }

    this.convoyDirector.update(
      dt,
      px,
      pz,
      activeChar,
      characterRoster,
      shardStore,
    );

    const spawnedEvent = this.eventDirector.update(
      dt,
      atmoTel.timeOfDayHours,
      activeChar?.pmcFaction ?? 'pmc_alpha',
    );
    if (spawnedEvent && spawnedEvent.sectorId) {
      this.sectorManager.markSectorContested(spawnedEvent.sectorId);
    }

    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_lookDir).normalize();
    this.electronicsSystem.update(dt, _camPos);

    // Update nearest contextual 3D interactable (FOB Terminal, Convoys, Event Crates, Corpses, Contracts, Wildlife & Electronic Repairs)
    if (this.navMode === 'foot' && this.activeModal === null) {
      const candidates: OpenWorldInteractableContext[] = [];
      const activeRep = this.holdRepair.getState();
      this.nearbyElectronicRepair = this.electronicsSystem.findBrokenRepairTarget(
        _camPos,
        _lookDir,
        3.25,
      );

      if (activeRep) {
        candidates.push({
          kind: 'electronic_repair',
          id: activeRep.targetId,
          label: `${activeRep.label} (${Math.round(activeRep.progress01 * 100)}%)`,
          sublabel: 'Hold [F] to complete electrical repair',
          distanceM: 0.1,
          canExecute: true,
          holdToRepair: true,
          repairProgress: activeRep.progress01,
        });
      } else if (this.nearbyElectronicRepair) {
        candidates.push({
          kind: 'electronic_repair',
          id: this.nearbyElectronicRepair.id,
          label: `Repair ${this.nearbyElectronicRepair.label}`,
          sublabel: `Hold [F] (${this.nearbyElectronicRepair.durationSec.toFixed(1)}s) to restore electronics`,
          distanceM: Math.max(0.15, this.nearbyElectronicRepair.distanceM - 0.5),
          canExecute: true,
          holdToRepair: true,
          repairProgress: 0,
        });
      }

      const sectorInter = this.sectorManager.findNearestInteractable(px, pz, activeChar);
      if (sectorInter) {
        const linkKey =
          sectorInter.kind === 'fob_terminal' ||
          sectorInter.kind === 'subfaction_black_market' ||
          sectorInter.kind === 'contract'
            ? `${sectorInter.kind}:${sectorInter.id}`
            : null;
        if (linkKey && this.electronicsSystem.isInteractiveLinkBroken(linkKey)) {
          sectorInter.canExecute = false;
          sectorInter.blockedReason = 'Terminal damaged — look at screen and Hold [F] to repair.';
          sectorInter.sublabel = 'ELECTRONICS DAMAGED · Hold [F] on terminal screen to repair';
        }
        candidates.push(sectorInter);
      }

      const harvestPrompt = this.wildlifeManager.findNearestHarvestableCarcass(px, pz);
      if (harvestPrompt) {
        candidates.push({
          kind: 'wildlife_harvest',
          id: harvestPrompt.entityId,
          label: harvestPrompt.label,
          sublabel: harvestPrompt.sublabel,
          distanceM: harvestPrompt.distanceM,
          canExecute: true,
        });
      }

      const convoyPrompt = this.convoyDirector.findNearestInteractableConvoy(px, pz, activeChar);
      if (convoyPrompt) {
        candidates.push({
          kind: 'convoy_hijack',
          id: convoyPrompt.convoyId,
          label: convoyPrompt.label,
          sublabel: convoyPrompt.sublabel,
          distanceM: convoyPrompt.distanceM,
          canExecute: convoyPrompt.canHijackOrSabotage,
          blockedReason: convoyPrompt.blockedReason,
        });
      }

      const eventPrompt = this.eventDirector.findNearestInteractableCrate(px, pz);
      if (eventPrompt) {
        candidates.push({
          kind: 'world_event_crate',
          id: eventPrompt.eventId,
          label: eventPrompt.label,
          sublabel: eventPrompt.sublabel,
          distanceM: eventPrompt.distanceM,
          canExecute: eventPrompt.canExecute,
          blockedReason: eventPrompt.blockedReason,
        });
      }

      if (this.navMode === 'foot') {
        this.camera.getWorldPosition(_camPos);
        this.camera.getWorldDirection(_forward).normalize();
        const liveCand = this.ejectedLiveRounds.findLookedAtPickup(_camPos, _forward, 2.65);
        if (liveCand) {
          candidates.push({
            kind: 'live_round_pickup',
            id: String(liveCand.id),
            label: `Pick up 1x ${liveCand.caliberLabel} Round`,
            sublabel: 'Intact Live Cartridge',
            distanceM: liveCand.distanceM,
            canExecute: true,
          });
        }
        const bpCand = this.worldBackpacks.findInteractable(_camPos, _forward, 3.0);
        if (bpCand) {
          candidates.push({
            kind: 'ground_backpack',
            id: bpCand.id,
            label: `Inspect / Equip ${bpCand.name}`,
            sublabel: `${bpCand.itemCount} item(s) inside · [F] Open Container`,
            distanceM: bpCand.distanceM,
            canExecute: true,
          });
        }
      }

      candidates.sort((a, b) => a.distanceM - b.distanceM);
      this.activeInteractable = candidates[0] ?? null;
    } else {
      this.nearbyElectronicRepair = null;
      this.activeInteractable = null;
    }

    // Step ballistic projectiles & grenades (with PCA supersonic/subsonic flyby acoustics)
    this.ballistics.update(
      dt,
      this.bodycamAdapter,
      (ev) => this.handleBallisticImpact(ev),
      flybyCtx,
    );
    this.ejectedLiveRounds.update(
      dt,
      this.bodycamAdapter,
      (x, z) => sampleOpenWorldTerrain(x, z, this._liveRoundTerrainSample).height,
      this.audio,
    );
    if (this.navMode === 'foot') {
      this.camera.getWorldPosition(_camPos);
      const wasLive = this.grenadeSystem.isLeverReleased();
      this.grenadeSystem.update(dt, _camPos);
      const launched = this.grenadeSystem.consumeLastLaunchedThrow();
      if (launched || (wasLive && !this.grenadeSystem.isLeverReleased())) {
        if (activeChar?.tacticalInventory) {
          const invClone = cloneTacticalInventory(activeChar.tacticalInventory);
          consumeOneGrenadeFromInventory(invClone);
          characterRoster.updateTacticalInventory(activeChar.slotId, invClone);
          this.grenadeCount = countGrenadesInInventory(invClone);
        } else {
          this.grenadeCount = Math.max(0, this.grenadeCount - 1);
        }
      }
    }

    // Position weapon flashlight along camera view vector (zero allocations)
    if (this.flashlightOn) {
      this.flashlight.intensity = 7.2;
      this.camera.getWorldPosition(_camPos);
      this.camera.getWorldDirection(_forward);
      this.flashlight.position.set(_camPos.x, _camPos.y - 0.12, _camPos.z);
      _flashTargetPos.copy(this.flashlight.position).addScaledVector(_forward, 28);
      this.flashlight.target.position.copy(_flashTargetPos);
    } else {
      this.flashlight.intensity = 0;
    }

    // Delta-triggered directional shadow map refresh (<= 15Hz when moving / sun shifting)
    const shadowUpdated =
      this.renderer.shadowMap.enabled && this.atmosphere.consumeShadowUpdateNeeded(dt, px, pz);
    if (shadowUpdated) {
      this.renderer.shadowMap.needsUpdate = true;
    }

    // Camera frustum + behind-player + conservative occlusion culling (preserves <= 105m shadow-caster halo on shadow-refresh frames)
    this.streamer.applyCameraCullingAndLods(
      this.camera,
      px,
      pz,
      shadowUpdated,
      this.occlusionCuller,
    );

    // Final output pass (branches ONLY after identical unified simulation step)
    const renderStart = performance.now();
    if (this.renderPipeline === 'bodycam_post') {
      const pp = this.ensurePostProcess();
      this.controller.getWhipVelocity(_whipVel);
      pp.update(
        dt,
        this.elapsedSec,
        this.config,
        this.navMode === 'foot' ? _whipVel.x : 0,
        this.navMode === 'foot' ? _whipVel.y : 0,
        this.playerHp,
        false,
        undefined,
        this.navMode === 'foot' ? this.controller.getHoldBreathVignette() : 0,
      );
      pp.render();
    } else {
      this.renderDirectTwoPass();
    }
    const renderElapsed = performance.now() - renderStart;
    this.smoothFrameMs = this.smoothFrameMs * 0.9 + Math.max(renderElapsed, rawDt * 1000) * 0.1;

    if (!this.isSoftwareGl) {
      const adaptiveOn = graphicsQualityStore.isAdaptiveScalingEnabled();
      const adapState = this.adaptivePerf.update(rawDt * 1000, adaptiveOn, this.elapsedSec);
      if (adapState.changed) {
        this.applyEffectiveDprAndEffects();
      }
    }

    this.hudEmitAccum += rawDt;
    if (this.hudEmitAccum >= 0.2) {
      this.hudEmitAccum = 0;
      this.emitSnapshot();
    }

    this.scheduleNextFrame();
  };

  /**
   * Direct Two-Pass WebGL renderer (zero offscreen HDR render targets).
   * Explicitly suspends `scene.background`, `scene.fog`, and shadow-map updates during Pass 2
   * so Three.js never clears the rendered 4km world behind the first-person viewmodel.
   */
  private renderDirectTwoPass(): void {
    // Render Battle-mode PiP Scope lens texture before world Pass 1 when magnified optic is equipped
    this.runScopeRenderPass();
    // Prepare half-res sun/cloud/terrain occlusion & radial scatter godrays prior to Layer 0 pass
    this.atmosphere.prepareGodrays(this.renderer, this.camera);

    const prevAutoClear = this.renderer.autoClear;
    const prevShadowAutoUpdate = this.renderer.shadowMap.autoUpdate;
    const prevBackground = this.scene.background;
    const prevFog = this.scene.fog;
    const prevNear = this.camera.near;
    const prevFar = this.camera.far;

    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = false;
    this.renderer.clear(true, true, true);

    // Pass 1: 4km World (Layer 0)
    this.camera.layers.set(0);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: Depth-cleared First-Person Arms, Weapon & Handheld PDA (VIEWMODEL_LAYER)
    if (this.navMode === 'foot') {
      this.renderer.clearDepth();
      this.renderer.shadowMap.autoUpdate = false;
      this.scene.background = null;
      this.scene.fog = null;
      this.camera.near = 0.015;
      this.camera.far = 4.0;
      this.camera.updateProjectionMatrix();
      this.camera.layers.set(VIEWMODEL_LAYER);
      this.renderer.render(this.scene, this.camera);

      this.camera.layers.set(0);
      this.camera.near = prevNear;
      this.camera.far = prevFar;
      this.camera.updateProjectionMatrix();
      this.scene.background = prevBackground;
      this.scene.fog = prevFog;
      this.renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    }

    this.renderer.autoClear = prevAutoClear;
  }

  private stepFootBodycam(dt: number, activeChar: OpenWorldCharacter | null): void {
    // Accessible arrow-key look fallback when not pointer locked
    const turnSpeed = 1.55;
    if (this.keysDown.has('ArrowLeft')) this.controller.handleMouseMove(-turnSpeed * dt * 260, 0, this.config);
    if (this.keysDown.has('ArrowRight')) this.controller.handleMouseMove(turnSpeed * dt * 260, 0, this.config);
    if (this.keysDown.has('ArrowUp')) this.controller.handleMouseMove(0, -turnSpeed * dt * 200, this.config);
    if (this.keysDown.has('ArrowDown')) this.controller.handleMouseMove(0, turnSpeed * dt * 200, this.config);

    const pdaBusy = this.pdaDevice.isBlockingWeaponActions();
    const grenadeDrawn = this.grenadeSystem.isDrawn();
    if (pdaBusy || grenadeDrawn) {
      this.input.ads = false;
    }

    this.input.adsMode = this.armedAdsMode;
    this.input.sprint =
      !pdaBusy &&
      this.sprintSlowRemainingSec <= 0 &&
      this.shiftHeld &&
      this.input.forward &&
      !this.input.ads;
    this.input.holdBreath =
      !pdaBusy && this.holdBreathHeld && this.input.ads && !this.isNonFirearmEquipped();
    this.input.freeZoom =
      this.freeZoomHeld &&
      this.pointerLocked &&
      this.activeModal === null &&
      this.navMode === 'foot' &&
      !pdaBusy;

    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    }
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer <= 0 && this.pendingReloadWeaponId) {
        const wId = this.pendingReloadWeaponId;
        const spec = this.pendingReloadSpec;
        this.pendingReloadWeaponId = null;
        this.pendingReloadSpec = null;
        if (wId === this.equippedWeaponId) {
          const prof = resolveWeaponProfile(wId);
          if (spec && activeChar?.tacticalInventory) {
            const invClone = cloneTacticalInventory(activeChar.tacticalInventory);
            const swapRes = swapMagazineIntoWeapon(
              invClone,
              spec.weaponSlotKey,
              spec.sourceLocator,
              this.activeExternalLoot?.lootKit ?? null,
            );
            if (swapRes.ok) {
              characterRoster.updateTacticalInventory(activeChar.slotId, invClone);
              const nextAmmo = getLoadedAmmoCount(invClone[spec.weaponSlotKey]);
              this.magAmmoByWeapon[prof.id] = nextAmmo;
              this.weaponRig.setAmmoState(nextAmmo, true);
              this.audio.playWeaponCue('mag_in', { intensity: 0.75 });
            }
          } else {
            const curMag = this.magAmmoByWeapon[prof.id] ?? 0;
            const needed = Math.max(0, prof.magCapacity - curMag);
            const taken = this.activeSlotId
              ? characterRoster.consumeArsenalReserve(this.activeSlotId, prof.id, needed)
              : needed;
            const nextAmmo = curMag + taken;
            this.magAmmoByWeapon[prof.id] = nextAmmo;
            this.weaponRig.setAmmoState(nextAmmo, true);
            this.audio.playWeaponCue('mag_in', { intensity: 0.72 });
          }
        }
      }
    }

    const prof = resolveWeaponProfile(this.equippedWeaponId);
    const repairActive = this.holdRepair.isActive();
    if (repairActive) {
      this.input.ads = false;
      this.input.sprint = false;
      this.isFiring = false;
    }

    // Stamina drain/regen & heart-rate biomechanics coupled to weapon stability
    const isMoving =
      this.input.forward || this.input.backward || this.input.left || this.input.right;
    if (this.controller.isSprinting && isMoving) {
      this.stamina = Math.max(0, this.stamina - dt * 0.145);
    } else if (this.controller.isHoldBreathActive()) {
      this.stamina = Math.max(0, this.stamina - dt * 0.14);
    } else {
      const regenRate = !isMoving ? (this.input.crouch ? 0.15 : 0.125) : 0.075;
      this.stamina = Math.min(1.0, this.stamina + dt * regenRate);
    }

    const hpStress = Math.max(0, 1 - this.playerHp / this.playerMaxHp) * 34;
    const bleedStress = this.bleedingRemainingSec > 0 ? 18 : 0;
    const exertionStress =
      (this.controller.isSprinting ? 38 : isMoving ? 14 : 0) + (1 - this.stamina) * 32;
    const targetHr = THREE.MathUtils.clamp(
      68 + exertionStress + hpStress + bleedStress + this.damageFlashAlpha * 28,
      64,
      172,
    );
    const hrLerp = targetHr > this.heartRateBpm ? dt * 2.2 : dt * 0.55;
    this.heartRateBpm += (targetHr - this.heartRateBpm) * Math.min(1, hrLerp);
    this.controller.setHeartRateBpm(this.heartRateBpm);

    const enc = activeChar?.tacticalInventory
      ? computeOperatorEncumbrance(activeChar.tacticalInventory)
      : null;
    this.controller.update(
      dt,
      this.elapsedSec,
      this.input,
      this.bodycamAdapter,
      prof,
      this.config,
      this.stamina,
      this.playerHp,
      (drainAmt) => {
        this.stamina = Math.max(0, this.stamina - drainAmt);
      },
      enc
        ? {
            encumbranceRatio: enc.ratio01,
            swayAmpMult: 1 + enc.ratio01 * 0.25,
            staminaDrainMult: enc.staminaDrainMult,
            exertionRateMult: enc.exertionRateMult,
            moveSpeedMult: enc.moveSpeedMult,
            canSprint: enc.canSprint && this.sprintSlowRemainingSec <= 0,
          }
        : undefined,
    );

    // Step Hold [F] two-handed repair IK before full-body animator
    if (this.holdRepair.isActive()) {
      this.holdRepair.step(
        dt,
        this.keysDown.has('KeyF'),
        this.controller.position,
        this.camera,
        this.interactAnimator,
        3.55,
      );
      this.animator.setExternalHandOverride(
        this.interactAnimator.isActive() ? this.interactAnimator.ikOverride : null,
      );
    } else if (this.interactAnimator.isActive()) {
      const active = this.interactAnimator.update(dt, this.camera);
      this.animator.setExternalHandOverride(active ? this.interactAnimator.ikOverride : null);
    } else {
      this.animator.setExternalHandOverride(null);
    }

    // Update physical 3D Tactical GPS PDA telemetry (60Hz when open, 1Hz when holstered)
    this.pdaTelemetryAccum += dt;
    if (this.pdaDevice.isOpen() || this.pdaTelemetryAccum >= 1.0) {
      this.pdaTelemetryAccum = 0;
      this.updatePdaTelemetry(activeChar);
    }
    this.controller.writePdaMotionState(this._pdaMotionScratch);
    this.pdaDevice.update(
      dt,
      this.elapsedSec,
      this._pdaMotionScratch.moveRatio,
      this._pdaMotionScratch.isCrouched,
      this._pdaMotionScratch,
    );

    // Update full-body procedural M/F skeleton & hand/finger IK
    this.animator.update(
      dt,
      this.elapsedSec,
      this.controller,
      this.bodycamAdapter,
      prof,
      this.input.ads,
    );
    this.animator.applyCameraAdditiveOverlay(this.camera);

    // Pulse player's helmet IR strobe for allied NVG identification
    this.skeleton.setIrStrobe(true, this.elapsedSec % 1.35 < 0.16);
    this.skeleton.root.visible = true;
    this.weaponRig.root.visible =
      !this.grenadeSystem.isWeaponHidden() && !this.pdaDevice.isWeaponHidden();

    // Spatial audio listener update
    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_lookDir).normalize();
    _camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.audio.updateListener(_camPos, _lookDir, _camUp);

    // Automatic fire hold
    if (this.isFiring && this.pointerLocked && !this.holdRepair.isActive()) {
      this.tryFireShot();
    }
  }

  private updatePdaTelemetry(activeChar: OpenWorldCharacter | null): void {
    const atmo = this.atmosphere.getTelemetry();
    const nearest = getNearestLandmark(this.controller.position.x, this.controller.position.z);
    const bk = activeChar ? getBankruptcyStatus(activeChar) : null;
    const playerFaction: PmcFactionId = activeChar?.pmcFaction ?? 'pmc_alpha';

    // 1. Comms Tower Regional Fog-of-War blackout zones
    this._pdaBlackoutZones.length = 0;
    const blackouts = this.sectorManager.getCommsBlackoutZonesForFaction(playerFaction);
    for (let i = 0; i < blackouts.length; i++) {
      const bz = blackouts[i];
      this._pdaBlackoutZones.push({
        x: bz.x,
        z: bz.z,
        radiusM: bz.radiusM,
        label: bz.label.toUpperCase(),
      });
    }

    // 2. Sector, World Event & Corpse pings (obscured inside uncaptured Comms Tower Fog-of-War)
    this._pdaPings.length = 0;
    const sectors = this.sectorManager.getSectorsSnapshot();
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      this._pdaPings.push({
        x: s.worldX,
        z: s.worldZ,
        label: s.shortLabel.toUpperCase(),
        kind:
          activeChar && s.owner === activeChar.pmcFaction
            ? 'poi'
            : s.owner === 'neutral'
              ? 'order'
              : 'danger',
      });
    }

    const activeEvt = this.eventDirector.getActiveEvent();
    if (activeEvt && !activeEvt.lootClaimed) {
      this._pdaPings.push({
        x: activeEvt.x,
        z: activeEvt.z,
        label: activeEvt.kind === 'black_box_drop' ? 'BLACK-BOX' : 'WORLD EVT',
        kind: 'contact',
      });
    }

    if (activeChar) {
      const shardCorpses = shardStore.getShard(activeChar.shardMode).corpses;
      for (let i = 0; i < Math.min(6, shardCorpses.length); i++) {
        const c = shardCorpses[i];
        this._pdaPings.push({
          x: c.worldX,
          z: c.worldZ,
          label: `KIA ${c.ownerCallsign}`,
          kind: 'danger',
        });
      }
    }

    // 2b. Sector borders, live contest progress rings & heat overlays for PDA OLED
    this._pdaSectors.length = 0;
    for (let i = 0; i < sectors.length; i++) {
      const s = sectors[i];
      this._pdaSectors.push({
        id: s.sectorId,
        code: s.shortLabel.toUpperCase(),
        name: s.name,
        x: s.worldX,
        z: s.worldZ,
        radiusM: s.isFob ? 72 : 52,
        owner: s.contested ? 'contested' : s.owner,
        captureProgress: s.signedCaptureProgress,
        heat: s.heat,
      });
    }

    // 3. Convoy, Barge & Owned Vehicle markers
    this._pdaConvoys.length = 0;
    this._pdaVehicles.length = 0;
    const convoys = this.convoyDirector.getTelemetrySnapshot();
    for (let i = 0; i < convoys.length; i++) {
      const cv = convoys[i];
      if (cv.state === 'hijacked' || cv.state === 'sabotaged') continue;
      const friendly = cv.ownerFaction === playerFaction;
      if (!friendly && !this.sectorManager.isPointCoveredByComms(cv.x, cv.z, playerFaction)) {
        continue;
      }
      this._pdaConvoys.push({
        x: cv.x,
        z: cv.z,
        label: cv.kind === 'supply_barge' ? 'BARGE' : 'CONVOY',
        friendly,
        disabled: cv.state === 'disabled_awaiting_action',
      });
    }

    if (activeChar && activeChar.ownedVehicleKeys.length > 0) {
      for (let i = 0; i < Math.min(8, activeChar.ownedVehicleKeys.length); i++) {
        const v = activeChar.ownedVehicleKeys[i];
        const lower = `${v.vehicleId} ${v.modelLabel}`.toLowerCase();
        this._pdaVehicles.push({
          id: v.vehicleId,
          x: v.worldX,
          z: v.worldZ,
          label: v.modelLabel.slice(0, 10).toUpperCase(),
          kind:
            lower.includes('heli') || lower.includes('ah6') || lower.includes('uh60')
              ? 'air'
              : lower.includes('boat') || lower.includes('rhib')
                ? 'boat'
                : 'ground',
          owned: true,
        });
      }
    }

    const t = this._pdaTelemetryScratch;
    t.playerX = this.controller.position.x;
    t.playerZ = this.controller.position.z;
    t.playerYawRad = this.controller.aimYaw;
    t.gameClockText = atmo.timeFormatted;
    t.weatherLabel = atmo.weatherLabel.toUpperCase();
    t.modeLabel = activeChar ? `PERIMETER · ${activeChar.shardMode}` : 'PERIMETER OPS';
    t.zoneLabel = nearest.landmark.shortLabel.toUpperCase();
    t.pings = this._pdaPings;
    t.commsBlackoutZones = this._pdaBlackoutZones;
    t.convoys = this._pdaConvoys;
    t.sectors = this._pdaSectors;
    t.vehicles = this._pdaVehicles;
    t.batteryPct = this.pdaDevice.getBatteryPct();
    t.characterCallsign = activeChar?.callsign;
    t.shardLabel = activeChar?.shardMode;
    t.factionLabel = activeChar ? PMC_FACTIONS[activeChar.pmcFaction].shortName : undefined;
    t.cashUsd = activeChar?.cash;
    t.respawnFeeUsd = bk?.nextRespawnFee;
    t.bankruptcyWarning = bk?.isBankruptcyRisk ?? false;
    t.bankruptcyText = bk?.pdaBannerText ?? undefined;
    this.pdaDevice.setTelemetry(t);
  }

  private stepReconFlight(dt: number): void {
    const turnSpeed = 1.65;
    if (this.keysDown.has('ArrowLeft')) this.flightYaw += turnSpeed * dt;
    if (this.keysDown.has('ArrowRight')) this.flightYaw -= turnSpeed * dt;
    if (this.keysDown.has('ArrowUp')) {
      this.flightPitch = Math.min(Math.PI * 0.45, this.flightPitch + turnSpeed * 0.7 * dt);
    }
    if (this.keysDown.has('ArrowDown')) {
      this.flightPitch = Math.max(-Math.PI * 0.45, this.flightPitch - turnSpeed * 0.7 * dt);
    }

    _forward.set(-Math.sin(this.flightYaw), 0, -Math.cos(this.flightYaw));
    _right.crossVectors(_forward, _worldUp).normalize();
    _moveVec.set(0, 0, 0);

    if (this.keysDown.has('KeyW')) _moveVec.add(_forward);
    if (this.keysDown.has('KeyS')) _moveVec.sub(_forward);
    if (this.keysDown.has('KeyD')) _moveVec.add(_right);
    if (this.keysDown.has('KeyA')) _moveVec.sub(_right);

    if (_moveVec.lengthSq() > 0.0001) _moveVec.normalize();
    const sprinting = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');
    const speed = sprinting ? 145 : 64;
    this.flightX = THREE.MathUtils.clamp(
      this.flightX + _moveVec.x * speed * dt,
      -WORLD_HALF_M + 24,
      WORLD_HALF_M - 24,
    );
    this.flightZ = THREE.MathUtils.clamp(
      this.flightZ + _moveVec.z * speed * dt,
      -WORLD_HALF_M + 24,
      WORLD_HALF_M - 24,
    );

    let vMove = 0;
    if (this.keysDown.has('Space') || this.keysDown.has('KeyE')) vMove += 1;
    if (this.keysDown.has('KeyC') || this.keysDown.has('ControlLeft') || this.keysDown.has('KeyQ')) vMove -= 1;
    this.flightY += vMove * (sprinting ? 85 : 42) * dt;
    const ground = Math.max(SEA_LEVEL_M, this.streamer.sampleGroundHeight(this.flightX, this.flightZ));
    this.flightY = THREE.MathUtils.clamp(this.flightY, ground + 4.5, 760);

    _euler.set(this.flightPitch, this.flightYaw, 0, 'YXZ');
    this.camera.position.set(this.flightX, this.flightY, this.flightZ);
    this.camera.quaternion.setFromEuler(_euler);
  }

  public getSnapshot(): OpenWorldSessionSnapshot {
    const character = this.getActiveCharacter();
    const bankruptcy = character ? getBankruptcyStatus(character) : null;
    const px = this.navMode === 'foot' ? this.controller.position.x : this.flightX;
    const py = this.navMode === 'foot' ? this.controller.position.y + 1.45 : this.flightY;
    const pz = this.navMode === 'foot' ? this.controller.position.z : this.flightZ;
    const yawRad = this.navMode === 'foot' ? this.controller.aimYaw : this.flightYaw;

    const groundY = this.streamer.sampleGroundHeight(px, pz);
    const biomeId = this.sampleBiomeAt(px, pz);
    const biomeMeta = OPENWORLD_BIOMES[biomeId];
    const nearest = getNearestLandmark(px, pz);
    const headingDeg = (((-yawRad * 180) / Math.PI) % 360 + 360) % 360;

    const shardMode = character?.shardMode ?? 'PvPvE';
    const shard = shardStore.getShard(shardMode);
    const faction: PmcFactionId = character?.pmcFaction ?? 'pmc_alpha';
    const prof: BodycamWeaponProfile = resolveWeaponProfile(this.equippedWeaponId);
    const nonFirearm = this.isNonFirearmEquipped();
    const ammoInMag = this.getCurrentLoadedCountForWeapon(this.equippedWeaponId);
    const reserveInfo =
      character?.tacticalInventory && !nonFirearm
        ? countCompatibleReserveRounds(character.tacticalInventory, this.equippedWeaponId)
        : {
            rigAndBeltRounds: this.getReserveAmmoForWeapon(this.equippedWeaponId),
            rigAndBeltMags: 0,
            backpackRounds: 0,
          };
    const nextRound = !nonFirearm ? this.getActiveAmmoVariant(this.equippedWeaponId) : null;

    return {
      character,
      bankruptcy,
      pointerLocked: this.pointerLocked,
      activeModal: this.activeModal,
      externalLoot: this.activeExternalLoot,
      fobTerminalState:
        (this.activeModal === 'fob_terminal' || this.activeModal === 'black_market_terminal') &&
        character
          ? this.logisticsEconomy.getFobTerminalSnapshot(character, shardStore, {
              blackMarketDiscount: this.activeModal === 'black_market_terminal',
            })
          : null,
      blackMarketContext:
        this.activeModal === 'black_market_terminal' ? this.activeBlackMarketContext : null,
      fastTravelDestinations:
        this.activeModal === 'helipad_travel'
          ? this.sectorManager.getFastTravelDestinations(faction)
          : [],
      fobTier: shardStore.getFobTier(shardMode, faction),
      navMode: this.navMode,
      renderPipeline: this.renderPipeline,
      lensPreset: this.config.lensPreset,
      nvgMode: this.nvgMode,
      flashlightOn: this.flashlightOn,
      worldX: Math.round(px),
      worldY: Math.round(py * 10) / 10,
      worldZ: Math.round(pz),
      groundY: Math.round(groundY * 10) / 10,
      altitudeAglM: Math.max(0, Math.round(py - groundY)),
      headingDeg: Math.round(headingDeg),
      biomeId,
      biomeName: biomeMeta.name,
      biomeElevationBand: biomeMeta.elevationRangeLabel,
      nearestLandmarkName: nearest.landmark.name,
      nearestLandmarkDistM: Math.round(nearest.distanceM),
      atmosphere: { ...this.atmosphere.getTelemetry() },
      streamer: this.streamer.getStats(),
      combat: {
        hp: Math.round(this.playerHp),
        maxHp: this.playerMaxHp,
        armorDurability: Math.round(this.armorDurability),
        maxArmorDurability: this.maxArmorDurability,
        armorLabel: this.armorLabel,
        equippedWeaponId: this.equippedWeaponId,
        equippedWeaponName:
          this.equippedWeaponId === 'unarmed'
            ? 'Empty Hands'
            : this.equippedWeaponId === 'combat_knife'
              ? 'Combat Knife'
              : prof.name,
        equippedCaliber: nonFirearm ? '' : prof.caliberLabel,
        activeRoundLabel: nextRound ? nextRound.shortName : '',
        ammoInMag,
        magCapacity: nonFirearm ? 0 : prof.magCapacity,
        ammoReserve: reserveInfo.rigAndBeltRounds,
        rigQuickMagCount: reserveInfo.rigAndBeltMags,
        backpackReserveRounds: reserveInfo.backpackRounds,
        hasChestRig: Boolean(character?.tacticalInventory?.chestRig),
        fireModeLabel: nonFirearm
          ? ''
          : formatFireModeLabel(fireModeStore.getEffectiveMode(prof)),
        reloading: this.reloadTimer > 0,
        isAds: this.input.ads,
        armedAdsMode: this.armedAdsMode,
        isPdaOpen: this.pdaDevice.isOpen(),
        pdaBatteryPct: Math.round(this.pdaDevice.getBatteryPct()),
        grenadeDrawn: this.grenadeSystem.isDrawn(),
        grenadeHoldStage: this.grenadeSystem.getHoldStage(),
        grenadeCount: this.grenadeCount,
        killsThisSortie: this.killsThisSortie,
        damageFlashAlpha: this.damageFlashAlpha,
        hitMarkerAlpha: 0,
        hitMarkerHeadshot: false,
        bleedingRemainingSec: Math.round(this.bleedingRemainingSec * 10) / 10,
        sprintSlowRemainingSec: Math.round(this.sprintSlowRemainingSec * 10) / 10,
      },
      ai: this.aiDirector.getTelemetry(),
      wildlife: this.wildlifeManager.getTelemetry(),
      sectors: this.sectorManager.getSectorsSnapshot(),
      activeSector: this.sectorManager.getActiveSectorAt(px, pz),
      commsBlackoutCount: this.sectorManager.getCommsBlackoutZonesForFaction(faction).length,
      convoys: this.convoyDirector.getTelemetrySnapshot(),
      worldEvent: this.eventDirector.getTelemetry(),
      territoryCounts: { ...shard.territoryCounts },
      pmcSupplyPools: {
        pmc_alpha: { ...shard.pmcSupplyPools.pmc_alpha },
        pmc_bravo: { ...shard.pmcSupplyPools.pmc_bravo },
      },
      interactable: this.activeInteractable ? { ...this.activeInteractable } : null,
      toastMessage: this.toastMessage,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameTimeMs: Math.round(this.smoothFrameMs * 10) / 10,
      fps: Math.round(1000 / Math.max(1, this.smoothFrameMs)),
      shardCorpseCount: shard.corpses.length,
      lastDeathOutcome: this.lastDeathOutcome,
    };
  }

  private sampleBiomeAt(x: number, z: number): OpenWorldBiomeId {
    const h = this.streamer.sampleGroundHeight(x, z);
    _terrainScratch.height = h;
    if (h < 15 || (z > 1180 && h < 22)) return 'coastal_port_marsh';
    if (h < 120) return 'temperate_conifer_valley';
    if (h < 260) return 'highland_steppe_quarry';
    return 'alpine_ridge_dam';
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    window.clearTimeout(this.frameHandle);
    this.exitPointerLock();
    this.unbindEvents();
    this.unsubRoster?.();
    this.unsubShards?.();
    this.unsubQuality?.();
    this.unsubAdaptive?.();
    this.unsubDistance?.();
    this.holdRepair.cancel(this.interactAnimator);
    this.listeners.clear();

    for (const g of this.corpseGeometries) g.dispose();
    for (const m of this.corpseMaterials) m.dispose();
    this.postProcess?.dispose();
    this.postProcess = null;
    this.scopeRenderer.dispose();
    this.aiDirector.dispose();
    this.fobDynamicProps.dispose();
    this.electronicsSystem.dispose();
    this.convoyDirector.dispose();
    this.eventDirector.dispose();
    this.wildlifeManager.dispose();
    this.ambienceAudio.dispose();
    this.sectorManager.dispose();
    this.grenadeSystem.dispose();
    this.pdaDevice.dispose();
    this.ballistics.dispose();
    this.ejectedLiveRounds.dispose();
    this.worldBackpacks.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
    this.streamer.setPhysicsPropCallbacks(null);
    this.physicsProps.dispose();
    this.audio.dispose();
    this.streamer.dispose();
    this.atmosphere.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

export { PMC_FACTIONS, SDK_WEAPON_PROFILES };

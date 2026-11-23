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
  BodycamPostProcess,
  BodycamSDKConfig,
  BodycamWeaponProfile,
  CharacterAnimator,
  CharacterSkeleton,
  createPdaMotionState,
  DEFAULT_BODYCAM_SDK_CONFIG,
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
  type PdaHudTelemetry,
  type PdaPingMarker,
  VIEWMODEL_LAYER,
  WeaponRig,
} from '../../../../bodycam-sdk';
import {
  getDefaultZeroDistanceM,
  normalizeWeaponAttachments,
} from '../../../../data/attachments';
import {
  AMMO_VARIANTS,
  AmmoVariantDef,
  AmmoVariantId,
  getDefaultAmmoVariant,
  resolveBaseCaliberId,
} from '../../../../data/calibers';
import {
  DEFAULT_TACTICAL_EQUIPMENT_ID,
  getTacticalEquipmentDef,
  TacticalEquipmentId,
} from '../../../../data/tacticalEquipment';
import { characterRoster } from '../CharacterRoster';
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
  FactionSupplyPool,
  OpenWorldBiomeId,
  OpenWorldCharacter,
  OpenWorldWeatherId,
  PMC_FACTIONS,
  PmcFactionId,
  SUB_FACTION_MAP,
} from '../types';
import {
  AiDamageToPlayerEvent,
  AiEliminationEvent,
  AiHitZone,
  AiSummaryTelemetry,
  OpenWorldAiDirector,
} from './OpenWorldAiDirector';
import { AtmosphereTelemetry, OpenWorldAtmosphere } from './OpenWorldAtmosphere';
import { OpenWorldBodycamAdapter } from './OpenWorldBodycamAdapter';
import { OpenWorldChunkStreamer, StreamerStats } from './OpenWorldChunkStreamer';
import {
  OpenWorldInteractableContext,
  OpenWorldSectorManager,
  SectorRuntimeState,
} from './OpenWorldSectorManager';
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

export interface OpenWorldCombatTelemetry {
  hp: number;
  maxHp: number;
  armorDurability: number;
  maxArmorDurability: number;
  armorLabel: string;
  equippedWeaponId: string;
  equippedWeaponName: string;
  equippedCaliber: string;
  ammoInMag: number;
  magCapacity: number;
  ammoReserve: number;
  fireModeLabel: string;
  reloading: boolean;
  isAds: boolean;
  armedAdsMode: AdsMode;
  isPdaOpen: boolean;
  grenadeDrawn: boolean;
  grenadeHoldStage: GrenadeHoldStage;
  grenadeCount: number;
  killsThisSortie: number;
  damageFlashAlpha: number;
  hitMarkerAlpha: number;
  hitMarkerHeadshot: boolean;
}

export interface OpenWorldSessionSnapshot {
  character: OpenWorldCharacter | null;
  bankruptcy: BankruptcyStatus | null;
  pointerLocked: boolean;
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
  sectors: SectorRuntimeState[];
  activeSector: SectorRuntimeState | null;
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
const _lookDir = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _muzzlePos = new THREE.Vector3();
const _muzzleDir = new THREE.Vector3();
const _flashTargetPos = new THREE.Vector3();
const _whipVel = new THREE.Vector2();

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
  let offsetX = 0;
  let offsetZ = 28;
  if (lm.kind === 'fob_alpha') {
    // Southwest staging edge -> looks northeast across Alpha FOB pad toward Pine Valley & Alpine peaks
    offsetX = -24;
    offsetZ = 22;
  } else if (lm.kind === 'fob_bravo') {
    // Northeast ridge edge -> looks southwest across Bravo Outpost toward Quarry & Coastal horizon
    offsetX = 24;
    offsetZ = -22;
  }
  const spawnX = lm.worldX + offsetX;
  const spawnZ = lm.worldZ + offsetZ;
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
 * Generates a crisp procedural 4km × 4km topographic contour + biome + road + water map
 * for the physical 3D handheld GPS PDA OLED (zero external textures / zero 404s).
 */
function buildProcedural4kmTopoCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(size, size);
  const dst = img.data;
  const sample = createTerrainSample();

  for (let py = 0; py < size; py++) {
    // North (-Z) is top of map
    const wz = -WORLD_HALF_M + (py / (size - 1)) * (WORLD_HALF_M * 2);
    for (let px = 0; px < size; px++) {
      const wx = -WORLD_HALF_M + (px / (size - 1)) * (WORLD_HALF_M * 2);
      sampleOpenWorldTerrain(wx, wz, sample);
      const di = (py * size + px) * 4;

      let r: number;
      let g: number;
      let b: number;
      if (sample.isWater) {
        r = 18;
        g = 46;
        b = 68;
      } else if (sample.isRoad) {
        r = 148;
        g = 142;
        b = 122;
      } else {
        r = Math.round(sample.r * 195 + 18);
        g = Math.round(sample.g * 205 + 22);
        b = Math.round(sample.b * 185 + 18);
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
  private readonly sectorManager: OpenWorldSectorManager;
  private readonly aiDirector: OpenWorldAiDirector;
  private readonly bodycamAdapter: OpenWorldBodycamAdapter;

  // Shared Axon Bodycam Core subsystems
  private readonly audio: BodycamAudio;
  private readonly ballistics: BallisticsSolver;
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
    vault: false,
  };
  private readonly _pdaMotionScratch = createPdaMotionState();
  private readonly _pdaPings: PdaPingMarker[] = [];
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
  };

  private readonly corpseMarkerGroup = new THREE.Group();
  private readonly corpseGeometries: THREE.BufferGeometry[] = [];
  private readonly corpseMaterials: THREE.Material[] = [];

  private readonly keysDown = new Set<string>();
  private readonly listeners = new Set<SnapshotListener>();

  private activeSlotId: CharacterSlotId | null = null;
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
  private tacticalEquipmentId: TacticalEquipmentId = DEFAULT_TACTICAL_EQUIPMENT_ID;
  private grenadeCount = 2;
  private shiftHeld = false;
  private killsThisSortie = 0;
  private damageFlashAlpha = 0;
  private hitMarkerAlpha = 0;
  private hitMarkerHeadshot = false;
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
  private lastDeathOutcome: CharacterDeathOutcome | null = null;

  private unsubRoster: (() => void) | null = null;
  private unsubShards: (() => void) | null = null;

  constructor(container: HTMLElement, slotId?: CharacterSlotId | null) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGl();

    // Renderer configured per Three.js studio PBR + software WebGL guard
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.autoClear = false; // Enables crisp depth-cleared VIEWMODEL_LAYER 2-pass
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
      0.14,
      5400,
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

    this.streamer = new OpenWorldChunkStreamer(this.scene, this.isSoftwareGl);

    const maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    // Phase 3 Dynamic Sector Control & Battle-Parity Tactical AI Squads
    this.sectorManager = new OpenWorldSectorManager(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      characterRoster,
      shardStore,
      initialShard,
    );
    this.aiDirector = new OpenWorldAiDirector(
      this.scene,
      (x, z) => this.streamer.sampleGroundHeight(x, z),
      playerFaction,
      maxAniso,
    );

    // Bridge 4km heightfield & AI hitboxes into Axon's shared bodycam-sdk
    this.bodycamAdapter = new OpenWorldBodycamAdapter(
      this.streamer,
      this.aiDirector,
      (origin, radius, kind) => {
        if (kind === 'gunshot' || kind === 'suppressed_gunshot') {
          this.aiDirector.notifyPlayerGunshot(origin.x, origin.z, radius);
        }
      },
    );

    // Shared Axon Bodycam Audio, Ballistics, WeaponRig, ScopeRenderer, M/F Operator Rig, Animator, Controller, PDA & Grenades
    this.audio = new BodycamAudio();
    this.audio.setSettings(
      this.config.micClippingDrive,
      this.config.masterVolume,
      this.config.gearRattleGain,
    );
    this.audio.setInteriorAcoustics(false, 'outdoor');

    this.ballistics = new BallisticsSolver(this.scene);

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
    this.scene.add(this.skeleton.root);

    this.animator = new CharacterAnimator(this.skeleton, this.weaponRig, this.audio);
    this.controller = new BodycamController(this.camera, this.weaponRig, this.audio);

    this.pdaDevice = new TacticalPdaDevice(this.audio);
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
      worldRaycastMeshes: this.aiDirector.hitMeshes,
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
    this.sectorManager.syncFromShard(initialShard, targetChar);
    this.applyRenderPipelineMode(this.renderPipeline);

    if (!this.isSoftwareGl) {
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

    this.lastNowMs = performance.now();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  private getActiveCharacter(): OpenWorldCharacter | null {
    return this.activeSlotId ? characterRoster.getCharacter(this.activeSlotId) : null;
  }

  private syncCharacterLoadout(char: OpenWorldCharacter | null): void {
    const plateId = char?.equippedKit.armorPlateId ?? 'plate_nij3_steel';
    const plateSpec = ARMOR_PLATE_MAP[plateId];
    this.maxArmorDurability = plateSpec?.durability ?? 60;
    this.armorDurability = this.maxArmorDurability;
    this.armorLabel = plateSpec ? `${plateSpec.ratingLabel} Plate` : 'NIJ III Plate';

    const weaponId =
      char?.arsenal.equippedWeaponId && char.arsenal.equippedWeaponId !== 'unarmed'
        ? char.arsenal.equippedWeaponId
        : (char?.arsenal.ownedWeaponIds[0] ?? 'm4a1');
    this.equipWeapon(weaponId);
  }

  private equipWeapon(weaponId: string): void {
    this.equippedWeaponId = weaponId;
    const prof = resolveWeaponProfile(weaponId);
    const char = this.getActiveCharacter();
    const rawAttachments = char?.arsenal.weaponAttachments[prof.id] ?? {};
    const attachments = normalizeWeaponAttachments(prof.id, rawAttachments);
    this.weaponRig.setWeaponProfile(prof, attachments);

    if (weaponId !== 'unarmed') {
      if (this.magAmmoByWeapon[prof.id] === undefined) {
        this.magAmmoByWeapon[prof.id] = prof.magCapacity;
      }
      this.weaponRig.setAmmoState(this.magAmmoByWeapon[prof.id], true);
      const zeroM = char?.arsenal.zeroDistanceByWeapon[prof.id] ?? getDefaultZeroDistanceM(prof.category);
      this.weaponRig.setZeroConfig(zeroM, 0, 0);
    }
    this.reloadTimer = 0;
    this.pendingReloadWeaponId = null;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
  }

  private getActiveAmmoVariant(weaponId: string): AmmoVariantDef {
    const prof = resolveWeaponProfile(weaponId);
    const calId = resolveBaseCaliberId(prof.defaultCaliberId);
    const char = this.getActiveCharacter();
    const stored = char?.arsenal.ammoVariantByWeapon[prof.id] as AmmoVariantId | undefined;
    if (stored && AMMO_VARIANTS[stored]?.caliberId === calId) {
      return AMMO_VARIANTS[stored];
    }
    return getDefaultAmmoVariant(calId);
  }

  private getReserveAmmoForWeapon(weaponId: string): number {
    if (weaponId === 'unarmed') return 0;
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
    this.input.vault = false;
    this.shiftHeld = false;
    this.isFiring = false;
    this.semiTriggerConsumed = false;
    this.pdaDevice.setDragging(false);
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
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    this.keysDown.add(e.code);

    // Global open-world hotkeys
    if (!e.repeat) {
      if (e.code === 'KeyV') {
        this.setNavMode(this.navMode === 'foot' ? 'recon_flight' : 'foot');
        return;
      }
      if (e.code === 'KeyL') {
        this.toggleFlashlight();
        return;
      }
      if (e.code === 'KeyN') {
        this.cycleNvgMode();
        return;
      }
      if (e.code === 'KeyF') {
        if (this.activeInteractable) {
          this.executeFieldInteraction();
        } else {
          this.toggleFlashlight();
        }
        return;
      }
    }

    if (this.navMode !== 'foot') return;

    switch (e.code) {
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
      case 'KeyM':
        if (!e.repeat) this.togglePda();
        break;
      case 'KeyG':
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
      case 'KeyB':
        if (!e.repeat) this.cycleAimMode();
        break;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
    switch (e.code) {
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
    if (!this.pointerLocked) {
      if (e.target === this.renderer.domElement) {
        this.requestPointerLock();
      }
      return;
    }
    if (this.navMode !== 'foot') return;

    this.audio.ensureInitialized();

    // Tactical PDA Grab-Sheet Drag / GPS Recenter
    if (this.pdaDevice.isBlockingWeaponActions()) {
      if (e.button === 0 && this.pdaDevice.isOpen()) {
        this.pdaDevice.setDragging(true);
      } else if (e.button === 2 && this.pdaDevice.isOpen()) {
        this.pdaDevice.recenterOnPlayer();
      }
      return;
    }

    // 4-Phase Tactical Grenade Manual of Arms
    if (this.grenadeSystem.isDrawn()) {
      this.input.ads = false;
      const stage = this.grenadeSystem.getHoldStage();
      if (e.button === 2) {
        if (stage === 'DRAWN') {
          this.grenadeSystem.pullPin();
          this.emitSnapshot();
        } else if (stage === 'PIN_PULLED') {
          this.grenadeSystem.releaseLever();
          this.emitSnapshot();
        }
      } else if (e.button === 0 && (stage === 'PIN_PULLED' || stage === 'LEVER_RELEASED')) {
        this.grenadeSystem.beginThrowInput();
        this.emitSnapshot();
      }
      return;
    }

    if (e.button === 1) {
      this.cycleAimMode();
      return;
    }

    if (e.button === 2) {
      this.input.ads = true;
    } else if (e.button === 0) {
      if (this.equippedWeaponId === 'unarmed') {
        this.animator.triggerUnarmedPunch(this.controller, this.input.ads);
        return;
      }
      this.isFiring = true;
      this.tryFireShot();
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (this.pdaDevice.isDragging()) {
        this.pdaDevice.setDragging(false);
      }
      if (this.grenadeSystem.isThrowInputHeld()) {
        this.grenadeSystem.releaseThrowInput();
        this.emitSnapshot();
      }
      this.isFiring = false;
      this.semiTriggerConsumed = false;
    } else if (e.button === 2) {
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

  public togglePda(): void {
    if (this.navMode !== 'foot') return;
    const next = !this.pdaDevice.isOpen();
    if (next) {
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
        this.showToast('Live Grenade Tossed Clear');
      }
      this.emitSnapshot();
      return;
    }
    if (this.grenadeCount <= 0) {
      this.showToast('No Grenades Left — Resupply at Home FOB');
      return;
    }
    this.isFiring = false;
    this.input.ads = false;
    this.reloadTimer = 0;
    const def = getTacticalEquipmentDef(this.tacticalEquipmentId);
    this.grenadeSystem.drawGrenade(def.id);
    this.audio.playGearRattle('weapon_swap', 0.55);
    this.showToast(`${def.shortName} Ready · [RMB] Pin/Spoon · [LMB] Throw`);
    this.emitSnapshot();
  }

  private switchWeaponSlot(slot: 1 | 2 | 3): void {
    const char = this.getActiveCharacter();
    if (slot === 3) {
      this.equipWeapon('unarmed');
      this.showToast('Unarmed');
      this.emitSnapshot();
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
      this.showToast(`Equipped ${resolveWeaponProfile(targetId).name}`);
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

  private startReload(): void {
    if (
      this.equippedWeaponId === 'unarmed' ||
      this.reloadTimer > 0 ||
      this.grenadeSystem.isDrawn() ||
      this.pdaDevice.isBlockingWeaponActions()
    ) {
      return;
    }
    const prof = resolveWeaponProfile(this.equippedWeaponId);
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
    this.weaponRig.triggerReload(this.reloadTimer);
    this.audio.playWeaponCue('mag_out', { intensity: 0.65 });
    this.emitSnapshot();
  }

  private tryFireShot(): void {
    if (
      this.navMode !== 'foot' ||
      this.equippedWeaponId === 'unarmed' ||
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
    const curAmmo = this.magAmmoByWeapon[prof.id] ?? prof.magCapacity;
    const isSingle = prof.fireMode === 'semi' || prof.fireMode === 'bolt' || prof.fireMode === 'pump';
    if (isSingle && this.semiTriggerConsumed) return;

    if (curAmmo <= 0) {
      this.weaponRig.triggerDryFire();
      this.audio.playWeaponCue('dryfire', { intensity: 0.6 });
      this.semiTriggerConsumed = true;
      this.fireCooldown = 0.22;
      this.showToast('Empty Magazine — Press [R] to Reload');
      return;
    }

    const nextAmmo = curAmmo - 1;
    this.magAmmoByWeapon[prof.id] = nextAmmo;
    this.fireCooldown = 60 / Math.max(30, prof.rpm);
    if (isSingle) this.semiTriggerConsumed = true;

    const derived = this.weaponRig.getDerivedStats();
    const activeAmmo = this.getActiveAmmoVariant(prof.id);
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

    this.weaponRig.triggerFire(suppressed, nextAmmo);
    this.weaponRig.setAmmoState(nextAmmo, true);
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

    // Notify nearby AI squads acoustically (suppressed rounds carry far less distance)
    this.aiDirector.notifyPlayerGunshot(
      this.controller.position.x,
      this.controller.position.z,
      suppressed ? 42 : 125,
    );
  }

  private handleBallisticImpact(ev: Readonly<BallisticImpactEvent>): void {
    const aiId = ev.object?.userData?.openWorldAiId as string | undefined;
    if (!aiId) return;

    const rawZone = String(ev.object?.userData?.hitZone ?? 'torso');
    const hitZone: AiHitZone =
      rawZone === 'head' ? 'head' : rawZone === 'limb' ? 'limb' : 'torso';
    const baseDmg = Math.max(22, Math.min(68, ev.impactEnergyJ * 0.022));
    const char = this.getActiveCharacter();
    const res = this.aiDirector.applyDamage(aiId, baseDmg, hitZone, char, ev.incomingDir);

    if (res.blockedFriendly) {
      this.showToast('Ceasefire / Friendly Target — Hold Fire', 2.2);
      return;
    }
    if (res.hit) {
      this.hitMarkerAlpha = 1.0;
      this.hitMarkerHeadshot = hitZone === 'head';
      this.audio.playImpact(ev.point, hitZone === 'head' ? 'metal' : 'wood');
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
    this.aiDirector.notifyPlayerGunshot(ev.position.x, ev.position.z, 175);
  }

  private handleAiElimination(ev: AiEliminationEvent): void {
    this.killsThisSortie += 1;
    const char = this.getActiveCharacter();
    if (char) {
      characterRoster.adjustCash(char.slotId, ev.bountyUsd);
      if (ev.subFactionStandingDelta) {
        const d = ev.subFactionStandingDelta;
        characterRoster.updateSubFactionStanding(char.slotId, d.subFactionId, d.delta);
        characterRoster.updateSubFactionStanding(char.slotId, d.rivalId, d.rivalDelta);
        const sf = SUB_FACTION_MAP[d.subFactionId];
        const rival = SUB_FACTION_MAP[d.rivalId];
        this.showToast(
          `Eliminated ${ev.callsign}${ev.headshot ? ' (Headshot)' : ''} · +$${ev.bountyUsd} · ${sf.shortName} ${d.delta} / ${rival.shortName} +${d.rivalDelta}`,
        );
      } else {
        this.showToast(
          `Eliminated ${ev.callsign}${ev.headshot ? ' (Headshot)' : ''} · +$${ev.bountyUsd}`,
        );
      }
    } else {
      this.showToast(`Eliminated ${ev.callsign}`);
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

  public executeFieldInteraction(): void {
    const inter = this.activeInteractable;
    const char = this.getActiveCharacter();
    if (!inter || !char) return;

    if (!inter.canExecute) {
      this.showToast(inter.blockedReason ?? 'Action currently unavailable.');
      this.emitSnapshot();
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
      const prof = resolveWeaponProfile(this.equippedWeaponId);
      if (this.equippedWeaponId !== 'unarmed') {
        this.magAmmoByWeapon[prof.id] = prof.magCapacity;
        this.weaponRig.setAmmoState(prof.magCapacity, true);
      }
      this.playerHp = this.playerMaxHp;
      this.armorDurability = this.maxArmorDurability;
      this.grenadeCount = getTacticalEquipmentDef(this.tacticalEquipmentId).maxCarry;
      this.audio.playWeaponCue('mag_in', { intensity: 0.8 });
      this.showToast('FOB Medbay & Armory: 100% HP, Fresh Plate & Full Ammo Restored');
      this.emitSnapshot();
      return;
    }

    if (inter.kind === 'corpse') {
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
    this.scopeRenderer.renderScopePass(sp);
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
      this.postProcess.setBeforeMainRenderCallback(() => this.runScopeRenderPass());
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
    this.showToast(
      mode === 'bodycam_post'
        ? `Render Pipeline: Bodycam Optical (${LENS_PRESETS[this.config.lensPreset].label})`
        : 'Render Pipeline: Direct 2-Pass (Low-Latency)',
      2.6,
    );
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
    this.emitSnapshot();
  }

  public setWeather(weather: OpenWorldWeatherId): void {
    this.atmosphere.setWeather(weather);
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
    this.streamer.update(pose.spawnX, pose.spawnZ);
    const ground = Math.max(
      SEA_LEVEL_M + 0.35,
      this.streamer.sampleGroundHeight(pose.spawnX, pose.spawnZ),
    );

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

    // Stream 3x3 active / 5x5 mid-range rings on chunk crossing
    this.streamer.update(px, pz);

    // Update 90-minute day/night lighting, sky dome, fog, and rain
    this.atmosphere.update(dt, px, py, pz);
    const atmoTel = this.atmosphere.getTelemetry();

    // Update Phase 3 Tactical AI Squads (vision scaled by Atmosphere + Flashlight)
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
    );

    // Update Phase 3 Dynamic Territory Control & Sector Beacons
    const capEv = this.sectorManager.update(dt, px, pz, activeChar, (secId) =>
      this.aiDirector.getHostileGarrisonCount(secId, activeChar),
    );
    if (capEv) {
      this.audio.playWeaponCue('mode_toggle', { intensity: 0.85 });
      this.showToast(
        `SECTOR CAPTURED: ${capEv.sectorName} flipped to ${PMC_FACTIONS[capEv.newOwner].name} (+$${capEv.cashBonusUsd.toLocaleString()} & Supply Boost)`,
        5.5,
      );
    }

    // Update nearest contextual 3D interactable
    this.activeInteractable =
      this.navMode === 'foot'
        ? this.sectorManager.findNearestInteractable(px, pz, activeChar)
        : null;

    // Step ballistic projectiles & grenades
    this.ballistics.update(dt, this.bodycamAdapter, (ev) => this.handleBallisticImpact(ev));
    if (this.navMode === 'foot') {
      this.camera.getWorldPosition(_camPos);
      const wasLive = this.grenadeSystem.isLeverReleased();
      this.grenadeSystem.update(dt, _camPos);
      const launched = this.grenadeSystem.consumeLastLaunchedThrow();
      if (launched || (wasLive && !this.grenadeSystem.isLeverReleased())) {
        this.grenadeCount = Math.max(0, this.grenadeCount - 1);
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

    this.hudEmitAccum += rawDt;
    if (this.hudEmitAccum >= 0.12) {
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
      !pdaBusy && this.shiftHeld && this.input.forward && !this.input.ads;
    this.input.holdBreath =
      !pdaBusy && this.shiftHeld && this.input.ads && this.equippedWeaponId !== 'unarmed';

    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    }
    if (this.reloadTimer > 0) {
      this.reloadTimer = Math.max(0, this.reloadTimer - dt);
      if (this.reloadTimer <= 0 && this.pendingReloadWeaponId) {
        const wId = this.pendingReloadWeaponId;
        this.pendingReloadWeaponId = null;
        if (wId === this.equippedWeaponId) {
          const prof = resolveWeaponProfile(wId);
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

    const prof = resolveWeaponProfile(this.equippedWeaponId);
    this.controller.update(
      dt,
      this.elapsedSec,
      this.input,
      this.bodycamAdapter,
      prof,
      this.config,
      1.0,
      this.playerHp,
    );

    // Update physical 3D Tactical GPS PDA telemetry (zero-GC reuse)
    this.updatePdaTelemetry(activeChar);
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

    this.skeleton.root.visible = true;
    this.weaponRig.root.visible =
      !this.grenadeSystem.isWeaponHidden() && !this.pdaDevice.isWeaponHidden();

    // Spatial audio listener update
    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_lookDir).normalize();
    _camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.audio.updateListener(_camPos, _lookDir, _camUp);

    // Automatic fire hold
    if (this.isFiring && this.pointerLocked) {
      this.tryFireShot();
    }
  }

  private updatePdaTelemetry(activeChar: OpenWorldCharacter | null): void {
    const atmo = this.atmosphere.getTelemetry();
    const nearest = getNearestLandmark(this.controller.position.x, this.controller.position.z);
    const bk = activeChar ? getBankruptcyStatus(activeChar) : null;

    // Populate pre-allocated sector + corpse pings array cleanly
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

    const t = this._pdaTelemetryScratch;
    t.playerX = this.controller.position.x;
    t.playerZ = this.controller.position.z;
    t.playerYawRad = this.controller.aimYaw;
    t.gameClockText = atmo.timeFormatted;
    t.weatherLabel = atmo.weatherLabel.toUpperCase();
    t.modeLabel = activeChar ? `PERIMETER · ${activeChar.shardMode}` : 'PERIMETER OPS';
    t.zoneLabel = nearest.landmark.shortLabel.toUpperCase();
    t.pings = this._pdaPings;
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
    const prof: BodycamWeaponProfile = resolveWeaponProfile(this.equippedWeaponId);
    const ammoInMag =
      this.equippedWeaponId === 'unarmed'
        ? 0
        : (this.magAmmoByWeapon[prof.id] ?? prof.magCapacity);

    return {
      character,
      bankruptcy,
      pointerLocked: this.pointerLocked,
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
        equippedWeaponName: this.equippedWeaponId === 'unarmed' ? 'Unarmed' : prof.name,
        equippedCaliber: this.equippedWeaponId === 'unarmed' ? '' : prof.caliberLabel,
        ammoInMag,
        magCapacity: this.equippedWeaponId === 'unarmed' ? 0 : prof.magCapacity,
        ammoReserve: this.getReserveAmmoForWeapon(this.equippedWeaponId),
        fireModeLabel:
          this.equippedWeaponId === 'unarmed'
            ? ''
            : prof.fireMode.toUpperCase(),
        reloading: this.reloadTimer > 0,
        isAds: this.input.ads,
        armedAdsMode: this.armedAdsMode,
        isPdaOpen: this.pdaDevice.isOpen(),
        grenadeDrawn: this.grenadeSystem.isDrawn(),
        grenadeHoldStage: this.grenadeSystem.getHoldStage(),
        grenadeCount: this.grenadeCount,
        killsThisSortie: this.killsThisSortie,
        damageFlashAlpha: this.damageFlashAlpha,
        hitMarkerAlpha: this.hitMarkerAlpha,
        hitMarkerHeadshot: this.hitMarkerHeadshot,
      },
      ai: this.aiDirector.getTelemetry(),
      sectors: this.sectorManager.getSectorsSnapshot(),
      activeSector: this.sectorManager.getActiveSectorAt(px, pz),
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
    this.listeners.clear();

    for (const g of this.corpseGeometries) g.dispose();
    for (const m of this.corpseMaterials) m.dispose();
    this.postProcess?.dispose();
    this.postProcess = null;
    this.scopeRenderer.dispose();
    this.aiDirector.dispose();
    this.sectorManager.dispose();
    this.grenadeSystem.dispose();
    this.pdaDevice.dispose();
    this.ballistics.dispose();
    this.weaponRig.dispose();
    this.skeleton.dispose();
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

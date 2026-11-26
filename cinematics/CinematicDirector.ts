import * as THREE from 'three';
import {
  operatorAssetLoader,
  poseHostileCombatant,
  poseSeatedOperator,
  poseStandingNpcGesture,
  poseWalkingOperator,
} from '../bodycam-sdk';
import type { CharacterSkeleton } from '../bodycam-sdk';
import { CinematicAudioPlayer } from './CinematicAudioPlayer';
import {
  CinematicSequenceId,
  CinematicVoiceCue,
  getVoiceCuesForSequence,
} from './cinematicVoiceManifest';
import {
  ArmedCinematicOperator,
  buildArmedCinematicOperator,
  buildCinematicApc,
  buildCinematicHelicopter,
  buildEscortGunship,
  buildGunCamRig,
  CinematicApcRig,
  CinematicEscortGunshipRig,
  CinematicHelicopterRig,
  GunCamRig,
  HELI_DEFAULT_CABIN_YAW_RAD,
} from './CinematicVehiclesAndRigs';
import {
  buildCorridorCombatVfx,
  buildWarzoneBattlefieldVfx,
  CinematicWarzoneVfx,
  CorridorCombatVfx,
} from './CinematicWarzoneVfx';

export type CinematicCameraMode =
  | 'drone_aerial'
  | 'gun_cam'
  | 'fp_helicopter'
  | 'fp_apc'
  | 'fp_walk'
  | 'external_vehicle'
  | 'intake_briefing';

export interface CinematicSnapshot {
  sequence: CinematicSequenceId;
  elapsedSec: number;
  durationSec: number;
  paused: boolean;
  audioBlocked: boolean;
  skipHoldProgress01: number;
  fadeOpacity01: number;
  cameraMode: CinematicCameraMode;
  feedLabel: string;
  locationLabel: string;
  mouseLookActive: boolean;
  killConfirmedFlash: boolean;
  killCount: number;
  caption: { speaker: string; text: string } | null;
}

export interface CinematicDirectorCallbacks {
  onMidpointSwap?: () => void;
  onComplete: () => void;
}

export const CINEMATIC_SKIP_HOLD_SEC = 1.2;
export const HELI_MOUSE_LOOK_MAX_YAW_RAD = THREE.MathUtils.degToRad(65);
export const HELI_MOUSE_LOOK_MIN_PITCH_RAD = THREE.MathUtils.degToRad(-35);
export const HELI_MOUSE_LOOK_MAX_PITCH_RAD = THREE.MathUtils.degToRad(30);

export interface CinematicSequenceMeta {
  readonly id: CinematicSequenceId;
  readonly durationSec: number;
  readonly midpointFadeSec: number | null;
  readonly hasGunCamBeat: boolean;
  readonly hasMouseLookPhase: boolean;
  readonly title: string;
}

export const CINEMATIC_SEQUENCES: Record<CinematicSequenceId, CinematicSequenceMeta> = {
  prologue: {
    id: 'prologue',
    durationSec: 48.0,
    midpointFadeSec: null,
    hasGunCamBeat: true,
    hasMouseLookPhase: true,
    title: 'OPERATION AXON · PROLOGUE',
  },
  apc_to_outpost: {
    id: 'apc_to_outpost',
    durationSec: 24.5,
    midpointFadeSec: 14.8,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'CONVOY TRANSIT · SECTOR 4 → INFECTION OUTPOST',
  },
  apc_to_hideout: {
    id: 'apc_to_hideout',
    durationSec: 24.5,
    midpointFadeSec: 14.8,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'CONVOY EXTRACT · INFECTION OUTPOST → HIDEOUT',
  },
  infection_breach: {
    id: 'infection_breach',
    durationSec: 15.5,
    midpointFadeSec: 14.8,
    hasGunCamBeat: true,
    hasMouseLookPhase: false,
    title: 'INFECTION HOT ZONE · BREACH INSERTION',
  },
  heli_to_perimeter: {
    id: 'heli_to_perimeter',
    durationSec: 24.5,
    midpointFadeSec: 10.3,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'VALKYRIE 2-1 · PERIMETER OPS INSERTION',
  },
  heli_to_conquest: {
    id: 'heli_to_conquest',
    durationSec: 26.0,
    midpointFadeSec: 10.3,
    hasGunCamBeat: true,
    hasMouseLookPhase: true,
    title: 'VALKYRIE 2-1 · CONQUEST THEATER ASSAULT',
  },
  heli_to_battle: {
    id: 'heli_to_battle',
    durationSec: 26.0,
    midpointFadeSec: 10.3,
    hasGunCamBeat: true,
    hasMouseLookPhase: true,
    title: 'VALKYRIE 2-1 · COMBAT SECTOR INSERTION',
  },
};

/** Pure helper for clamping FP helicopter/vehicle mouse-look angles (tested in unit tests). */
export function clampVehicleMouseLook(
  yawRad: number,
  pitchRad: number,
): { yawRad: number; pitchRad: number } {
  return {
    yawRad: THREE.MathUtils.clamp(yawRad, -HELI_MOUSE_LOOK_MAX_YAW_RAD, HELI_MOUSE_LOOK_MAX_YAW_RAD),
    pitchRad: THREE.MathUtils.clamp(
      pitchRad,
      HELI_MOUSE_LOOK_MIN_PITCH_RAD,
      HELI_MOUSE_LOOK_MAX_PITCH_RAD,
    ),
  };
}

/** Pure helper advancing/decaying the `Hold [Enter] to Skip` meter (tested in unit tests). */
export function stepSkipHoldProgress(
  current01: number,
  enterHeld: boolean,
  dtSec: number,
): { next01: number; skipped: boolean } {
  if (enterHeld) {
    const next = Math.min(1, current01 + Math.max(0, dtSec) / CINEMATIC_SKIP_HOLD_SEC);
    return { next01: next, skipped: next >= 1 };
  }
  const decayed = Math.max(0, current01 - Math.max(0, dtSec) * 2.4);
  return { next01: decayed, skipped: false };
}

interface GunCamHostileSlot {
  actor: ArmedCinematicOperator;
  coverX: number;
  exposedX: number;
  zPos: number;
  peekStartSec: number;
  peekEndSec: number;
  killTimeSec: number;
  returnFireTimes: number[];
  returnFireMask: number;
  flashTimer: number;
  downBlend: number;
}

type SnapshotListener = (snap: CinematicSnapshot) => void;

/**
 * Single-WebGL-Context AAA 3D Cinematic Director.
 * Renders the 48s Prologue, 24.5s APC Escort Transits, 24.5–26s Helicopter Insertions,
 * 15.5s Infection Hot Zone Breach, and Squadmate-Assisted 3-Kill Gun-Mounted Camera Firefights.
 *
 * Strictly enforces:
 * - Zero per-frame heap allocations in the render loop
 * - <= 1 directional shadow caster (disabled on software GL)
 * - Software GL `afterDraw` pacing
 * - All character limbs driven via canonical two-bone IK (`ProceduralCharacterPoser`)
 */
export class CinematicDirector {
  private readonly container: HTMLElement;
  private readonly sequence: CinematicSequenceId;
  private readonly meta: CinematicSequenceMeta;
  private readonly callbacks: CinematicDirectorCallbacks;
  private readonly listeners = new Set<SnapshotListener>();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;
  private readonly audio = new CinematicAudioPlayer();

  private readonly cues: readonly CinematicVoiceCue[];
  private readonly playedCueIds = new Set<string>();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  private heliRig: CinematicHelicopterRig | null = null;
  private escortGunship: CinematicEscortGunshipRig | null = null;
  private apcRig: CinematicApcRig | null = null;
  private gunCamRig: GunCamRig | null = null;
  private warzoneVfx: CinematicWarzoneVfx | null = null;
  private corridorVfx: CorridorCombatVfx | null = null;
  private escortNpc: CharacterSkeleton | null = null;
  private commanderNpc: CharacterSkeleton | null = null;
  private breachSquadmate: ArmedCinematicOperator | null = null;
  private corridorHostiles: GunCamHostileSlot[] = [];
  private corridorGroup: THREE.Group | null = null;
  private terrainGroup: THREE.Group | null = null;

  private elapsedSec = 0;
  private paused = false;
  private enterHeld = false;
  private skipHoldProgress01 = 0;
  private midpointFired = false;
  private completed = false;
  private disposed = false;

  // Live constrained mouse-look offsets during FP helicopter / APC cabin beats
  private lookTargetYaw = 0;
  private lookTargetPitch = 0;
  private lookCurrentYaw = 0;
  private lookCurrentPitch = 0;
  private mouseLookActive = false;

  // Gun-cam firefight & foley event trackers
  private shotsFiredMask = 0;
  private squadShotsMask = 0;
  private doorSlamMask = 0;
  private lastFootstepBucket = -1;
  private lastDoorGunnerBucket = -1;
  private muzzleFlashTimer = 0;
  private squadFlashTimer = 0;
  private gunRecoilKick = 0;
  private squadRecoilKick = 0;
  private killConfirmedTimer = 0;
  private killCount = 0;

  private rafId = 0;
  private softwareTimerId = 0;
  private lastFrameMs = 0;
  private lastEmitMs = 0;

  // Scratch vectors/quaternions (zero per-frame GC)
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
  private readonly _v3 = new THREE.Vector3();
  private readonly _v4 = new THREE.Vector3();
  private readonly _q1 = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');

  private currentCameraMode: CinematicCameraMode = 'drone_aerial';
  private currentFeedLabel = 'OVERWATCH FEED';
  private currentLocationLabel = 'SECTOR PERIMETER';
  private currentFadeOpacity = 0;

  constructor(
    container: HTMLElement,
    sequence: CinematicSequenceId,
    callbacks: CinematicDirectorCallbacks,
  ) {
    this.container = container;
    this.sequence = sequence;
    this.meta = CINEMATIC_SEQUENCES[sequence];
    this.callbacks = callbacks;
    this.cues = getVoiceCuesForSequence(sequence);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glStr = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
    this.isSoftwareGl = /swiftshader|llvmpipe|software|mesa/i.test(glStr);

    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(
      Math.max(1, container.clientWidth || window.innerWidth),
      Math.max(1, container.clientHeight || window.innerHeight),
    );
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090e14);
    this.scene.fog = new THREE.FogExp2(0x0c131c, 0.0095);

    this.camera = new THREE.PerspectiveCamera(
      64,
      Math.max(1, container.clientWidth || window.innerWidth) /
        Math.max(1, container.clientHeight || window.innerHeight),
      0.04,
      280,
    );

    this.buildCinematicStage();
    this.audio.preloadCues(this.cues);

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('resize', this.onResize);

    this.lastFrameMs = performance.now();
    this.emitSnapshot(true);
    this.scheduleNextFrame();
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.ownedGeos.push(g);
    return g;
  }

  private trackMat<T extends THREE.Material>(m: T): T {
    this.ownedMats.push(m);
    return m;
  }

  private buildCinematicStage(): void {
    // Atmospheric twilight military lighting (strictly <= 1 shadow caster)
    const hemi = new THREE.HemisphereLight(0x6c87a6, 0x1b2025, 0.78);
    this.scene.add(hemi);

    const keyDir = new THREE.DirectionalLight(0xffddb8, 1.9);
    keyDir.position.set(22, 36, 18);
    if (!this.isSoftwareGl) {
      keyDir.castShadow = true;
      keyDir.shadow.mapSize.set(1024, 1024);
      keyDir.shadow.camera.near = 2;
      keyDir.shadow.camera.far = 95;
      keyDir.shadow.camera.left = -30;
      keyDir.shadow.camera.right = 30;
      keyDir.shadow.camera.top = 30;
      keyDir.shadow.camera.bottom = -30;
    }
    this.scene.add(keyDir);

    // Build shared exterior tactical terrain (helipad, bunker entrance, road, hills, watchtowers)
    const terrain = new THREE.Group();
    this.terrainGroup = terrain;
    this.scene.add(terrain);

    const groundMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x1d231f, roughness: 0.92, metalness: 0.04 }),
    );
    const tarmacMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x24292f, roughness: 0.82, metalness: 0.08 }),
    );
    const concreteMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.88, metalness: 0.06 }),
    );
    const padLineMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.55,
        roughness: 0.6,
      }),
    );
    // Subtle dark-amber tower aviation lamps (never bright red laser-like dots)
    const towerLampAmberMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfde68a,
        emissive: 0xd97706,
        emissiveIntensity: 1.4,
      }),
    );
    const padLightGreenMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xa7f3d0,
        emissive: 0x10b981,
        emissiveIntensity: 2.2,
      }),
    );

    const ground = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(320, 320)), groundMat);
    ground.rotation.x = -Math.PI * 0.5;
    ground.receiveShadow = true;
    terrain.add(ground);

    // Asphalt convoy road & Helipad Zero-One apron
    const road = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(10.5, 0.06, 150)), tarmacMat);
    road.position.set(0, 0.02, -38);
    road.receiveShadow = true;
    terrain.add(road);

    const helipad = new THREE.Mesh(this.trackGeo(new THREE.CylinderGeometry(8.8, 9.1, 0.12, 24)), tarmacMat);
    helipad.position.set(0, 0.06, 0);
    helipad.receiveShadow = true;
    terrain.add(helipad);

    // Helipad "H" stencil & perimeter green edge lights
    const hLeft = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.42, 0.02, 4.4)), padLineMat);
    hLeft.position.set(-1.5, 0.13, 0);
    const hRight = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.42, 0.02, 4.4)), padLineMat);
    hRight.position.set(1.5, 0.13, 0);
    const hBar = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(3.2, 0.02, 0.42)), padLineMat);
    hBar.position.set(0, 0.13, 0);
    terrain.add(hLeft, hRight, hBar);

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const lamp = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.22, 0.14, 0.22)), padLightGreenMat);
      lamp.position.set(Math.cos(a) * 8.3, 0.16, Math.sin(a) * 8.3);
      terrain.add(lamp);
    }

    // Bunker Intake Bulkhead structure at Z = +15.5m
    const bunkerFace = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(19, 6.4, 5.5)), concreteMat);
    bunkerFace.position.set(0, 3.2, 15.5);
    bunkerFace.receiveShadow = true;
    terrain.add(bunkerFace);

    const bunkerLight = new THREE.PointLight(0xffd299, 10, 24, 1.4);
    bunkerLight.position.set(0, 4.4, 11.2);
    terrain.add(bunkerLight);

    // Perimeter ridgeline hills & off-axis watchtowers for sweeping aerial depth
    const hillGeo = this.trackGeo(new THREE.ConeGeometry(30, 18, 7));
    const hillSpots: Array<[number, number, number]> = [
      [-58, -58, 1.35],
      [56, -66, 1.2],
      [-72, 14, 1.05],
      [68, 20, 1.28],
      [-24, -104, 1.5],
      [34, -98, 1.35],
    ];
    for (const [hx, hz, hs] of hillSpots) {
      const h = new THREE.Mesh(hillGeo, groundMat);
      h.position.set(hx, 6.5 * hs, hz);
      h.scale.set(hs, hs, hs);
      terrain.add(h);
    }

    const towerGeo = this.trackGeo(new THREE.BoxGeometry(2.6, 11, 2.6));
    const beaconGeo = this.trackGeo(new THREE.BoxGeometry(0.26, 0.18, 0.26));
    for (const [tx, tz] of [
      [-24, -18],
      [24, -18],
      [-26, -54],
      [26, -54],
      [-18, 13],
      [18, 13],
    ]) {
      const tw = new THREE.Mesh(towerGeo, concreteMat);
      tw.position.set(tx, 5.5, tz);
      const bc = new THREE.Mesh(beaconGeo, towerLampAmberMat);
      bc.position.set(tx, 11.15, tz);
      terrain.add(tw, bc);
    }

    // Active Combined-Arms Warzone VFX Layer (valley tracer crossfire, AA flak, artillery blasts,
    // burning armored wrecks with smoke plumes, sweeping searchlights, and illumination flares)
    this.warzoneVfx = buildWarzoneBattlefieldVfx(this.isSoftwareGl);
    terrain.add(this.warzoneVfx.root);

    // Build High-Contrast Backlit 34m Concrete Breach Corridor at Y = -40m for Gun-Cam Firefights
    if (this.meta.hasGunCamBeat) {
      const corr = new THREE.Group();
      corr.position.set(0, -40, 0);
      this.corridorGroup = corr;
      this.scene.add(corr);

      const corrFloor = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(6.0, 0.2, 36)), concreteMat);
      corrFloor.position.set(0, -0.1, -13);
      const corrCeil = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(6.0, 0.2, 36)), concreteMat);
      corrCeil.position.set(0, 3.5, -13);
      const corrLeft = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.3, 3.6, 36)), concreteMat);
      corrLeft.position.set(-2.95, 1.7, -13);
      const corrRight = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.3, 3.6, 36)), concreteMat);
      corrRight.position.set(2.95, 1.7, -13);
      const corrBack = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(6.2, 3.6, 0.4)), concreteMat);
      corrBack.position.set(0, 1.7, -30.5);

      // Waist-high tactical cover crates placed off-axis so peeking enemies' upper torsos stay 100% visible!
      const barrier1 = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.35, 0.92, 0.7)), tarmacMat);
      barrier1.position.set(-1.75, 0.46, -7.8);
      const barrier2 = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.35, 0.95, 0.7)), tarmacMat);
      barrier2.position.set(1.8, 0.48, -12.8);
      const rearFrameL = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.6, 3.4, 0.45)), concreteMat);
      rearFrameL.position.set(-2.1, 1.7, -19.6);
      const rearFrameR = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.6, 3.4, 0.45)), concreteMat);
      rearFrameR.position.set(2.1, 1.7, -19.6);
      corr.add(corrFloor, corrCeil, corrLeft, corrRight, corrBack, barrier1, barrier2, rearFrameL, rearFrameR);

      // Luminous wall backlight strips & high-contrast kill-zone floodlights BEHIND each enemy
      // so dark-armored hostiles pop as crisp unmistakable silhouettes down the entire corridor!
      const stripAmberMat = this.trackMat(
        new THREE.MeshBasicMaterial({ color: 0xfde68a }),
      );
      const stripRedMat = this.trackMat(
        new THREE.MeshBasicMaterial({ color: 0xfca5a5 }),
      );
      for (const [sz, mat] of [
        [-10.2, stripAmberMat],
        [-15.2, stripAmberMat],
        [-20.6, stripRedMat],
      ] as const) {
        const strip = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(3.8, 0.14, 0.16)), mat);
        strip.position.set(0, 3.32, sz);
        corr.add(strip);
      }

      const corrLightEntry = new THREE.PointLight(0x93c5fd, 8.5, 16, 1.3);
      corrLightEntry.position.set(0, 2.95, -4.0);
      const corrLightKill1 = new THREE.PointLight(0xffd28a, 14.0, 14, 1.25);
      corrLightKill1.position.set(-0.3, 2.65, -10.4); // backlights Hostile 1 at z=-8.6
      const corrLightKill2 = new THREE.PointLight(0xffb86c, 15.0, 15, 1.25);
      corrLightKill2.position.set(0.35, 2.65, -15.4); // backlights Hostile 2 at z=-13.6
      const corrLightKill3 = new THREE.PointLight(0xf87171, 16.0, 16, 1.25);
      corrLightKill3.position.set(0, 2.6, -20.8); // crimson backlight behind Hostile 3 at z=-18.6
      corr.add(corrLightEntry, corrLightKill1, corrLightKill2, corrLightKill3);

      this.corridorVfx = buildCorridorCombatVfx();
      corr.add(this.corridorVfx.root);

      this.gunCamRig = buildGunCamRig();
      this.gunCamRig.root.position.set(0.36, 1.44, -1.2);
      corr.add(this.gunCamRig.root);

      // Allied Breach Squadmate advancing stacked ahead-left of your gun-mounted camera!
      this.breachSquadmate = buildArmedCinematicOperator({
        operatorId: 'MALE',
        uniformId: 'team_a',
        helmetType: 'mil_tec',
        helmetColor: 'desert_tan',
        faceGear: 'neck_gaiter',
        weaponId: 'm4a1',
      });
      this.breachSquadmate.skeleton.root.position.set(-1.18, 0, -3.4);
      this.breachSquadmate.skeleton.root.rotation.y = 0; // advancing down -Z corridor
      corr.add(this.breachSquadmate.skeleton.root);

      // 3 Staged Backlit Corridor Hostiles in prime 5.5-8.5m range, each returning visible red tracer fire!
      const hostileUniform = this.sequence === 'infection_breach' ? 'infection' : 'ffa';
      const hostileSpecs = [
        {
          coverX: -1.15,
          exposedX: -0.1,
          zPos: -8.6,
          peekStartSec: 0.75,
          peekEndSec: 1.75,
          killTimeSec: 2.85,
          returnFireTimes: [1.55, 1.95, 2.35],
          weaponId: 'akm_762',
        },
        {
          coverX: 1.35,
          exposedX: 0.28,
          zPos: -13.6,
          peekStartSec: 3.65,
          peekEndSec: 4.65,
          killTimeSec: 5.75,
          returnFireTimes: [4.4, 4.82, 5.2],
          weaponId: 'mp5',
        },
        {
          coverX: -0.95,
          exposedX: 0.08,
          zPos: -18.6,
          peekStartSec: 6.45,
          peekEndSec: 7.35,
          killTimeSec: 8.35,
          returnFireTimes: [7.15, 7.55, 7.88],
          weaponId: 'akm_762',
        },
      ];

      for (const spec of hostileSpecs) {
        const actor = buildArmedCinematicOperator({
          operatorId: 'MALE',
          uniformId: hostileUniform,
          helmetType: 'mich',
          helmetColor: 'coyote_brown',
          faceGear: 'balaclava',
          weaponId: spec.weaponId,
        });
        actor.skeleton.root.position.set(spec.coverX, 0, spec.zPos);
        actor.skeleton.root.rotation.y = Math.PI; // facing +Z toward breacher team
        poseHostileCombatant(actor.skeleton, 0, 0, actor.weaponMount);
        corr.add(actor.skeleton.root);
        this.corridorHostiles.push({
          actor,
          coverX: spec.coverX,
          exposedX: spec.exposedX,
          zPos: spec.zPos,
          peekStartSec: spec.peekStartSec,
          peekEndSec: spec.peekEndSec,
          killTimeSec: spec.killTimeSec,
          returnFireTimes: spec.returnFireTimes,
          returnFireMask: 0,
          flashTimer: 0,
          downBlend: 0,
        });
      }
    }

    // Spawn Helicopter + Escort Gunship or APC + Escort/Commander NPCs depending on sequence
    const needsHeli =
      this.sequence === 'prologue' ||
      this.sequence === 'heli_to_perimeter' ||
      this.sequence === 'heli_to_conquest' ||
      this.sequence === 'heli_to_battle';
    const needsApc =
      this.sequence === 'apc_to_outpost' ||
      this.sequence === 'apc_to_hideout' ||
      this.sequence === 'infection_breach';

    if (needsHeli) {
      this.heliRig = buildCinematicHelicopter(this.isSoftwareGl);
      this.scene.add(this.heliRig.root);

      this.escortGunship = buildEscortGunship(this.isSoftwareGl);
      this.escortGunship.root.position.set(-28, 18, -58);
      this.scene.add(this.escortGunship.root);
    }

    if (needsApc) {
      this.apcRig = buildCinematicApc(this.isSoftwareGl);
      this.scene.add(this.apcRig.root);

      const driverOp = operatorAssetLoader.loadProceduralOperator('MALE', {
        previewMode: true,
        uniformId: 'infection',
        gear: {
          uniformId: 'infection',
          helmetType: 'mich',
          helmetColor: 'olive_drab',
          eyewear: 'clear_glasses',
        },
      });
      this.escortNpc = driverOp.skeleton;
      this.escortNpc.setFirstPersonHeadShadowOnly(false);
      this.scene.add(this.escortNpc.root);
    }

    if (this.sequence === 'prologue') {
      const cmdOp = operatorAssetLoader.loadProceduralOperator('FEMALE', {
        previewMode: true,
        uniformId: 'ffa',
        gear: {
          uniformId: 'ffa',
          helmetType: 'none',
          facePreset: 'face_01',
        },
      });
      this.commanderNpc = cmdOp.skeleton;
      this.commanderNpc.setFirstPersonHeadShadowOnly(false);
      this.commanderNpc.root.position.set(0, 0, 11.2);
      this.commanderNpc.root.rotation.y = 0; // facing -Z toward arriving player
      poseStandingNpcGesture(this.commanderNpc, 'briefing', 0, { playerNear: true });
      this.scene.add(this.commanderNpc.root);
    }
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.buildSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public unlockAudio(): void {
    this.audio.unlockAudio();
    this.emitSnapshot(true);
  }

  public togglePause(): void {
    if (this.completed || this.disposed) return;
    this.paused = !this.paused;
    this.audio.setPaused(this.paused);
    this.emitSnapshot(true);
  }

  public setEnterHeld(held: boolean): void {
    this.enterHeld = held;
  }

  public forceSkip(): void {
    if (this.completed || this.disposed) return;
    this.finishCinematic();
  }

  private finishCinematic(): void {
    if (this.completed) return;
    this.completed = true;
    if (!this.midpointFired && this.meta.midpointFadeSec !== null) {
      this.midpointFired = true;
      this.callbacks.onMidpointSwap?.();
    }
    this.audio.stopAll();
    this.emitSnapshot(true);
    this.callbacks.onComplete();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || this.completed) return;
    if (e.code === 'Space') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) {
        this.togglePause();
      }
      return;
    }
    if (e.code === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.enterHeld = true;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Enter') {
      this.enterHeld = false;
    }
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.disposed || this.paused || !this.mouseLookActive) return;
    const nx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1;
    const ny = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1;
    const clamped = clampVehicleMouseLook(
      -nx * HELI_MOUSE_LOOK_MAX_YAW_RAD,
      -ny * THREE.MathUtils.degToRad(30),
    );
    this.lookTargetYaw = clamped.yawRad;
    this.lookTargetPitch = clamped.pitchRad;
  };

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private scheduleNextFrame(): void {
    if (this.disposed || this.completed) return;
    if (this.isSoftwareGl) {
      this.softwareTimerId = window.setTimeout(() => {
        this.rafId = requestAnimationFrame(this.tick);
      }, 28);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (now: number): void => {
    if (this.disposed || this.completed) return;
    const rawDt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameMs) * 0.001));
    this.lastFrameMs = now;

    // Hold [Enter] to skip works even while paused
    const skipStep = stepSkipHoldProgress(this.skipHoldProgress01, this.enterHeld, rawDt);
    this.skipHoldProgress01 = skipStep.next01;
    if (skipStep.skipped) {
      this.finishCinematic();
      return;
    }

    if (!this.paused) {
      this.elapsedSec += rawDt;

      for (const cue of this.cues) {
        if (this.elapsedSec >= cue.startSec && !this.playedCueIds.has(cue.id)) {
          this.playedCueIds.add(cue.id);
          this.audio.playVoiceCue(cue);
        }
      }

      if (
        !this.midpointFired &&
        this.meta.midpointFadeSec !== null &&
        this.elapsedSec >= this.meta.midpointFadeSec
      ) {
        this.midpointFired = true;
        this.callbacks.onMidpointSwap?.();
      }

      this.stepSequence(rawDt);

      if (this.elapsedSec >= this.meta.durationSec) {
        this.finishCinematic();
        return;
      }
    }

    this.renderer.render(this.scene, this.camera);

    if (now - this.lastEmitMs >= 50 || this.enterHeld) {
      this.lastEmitMs = now;
      this.emitSnapshot(false);
    }

    this.scheduleNextFrame();
  };

  private triggerFootstepCadence(t: number, cadenceHz: number, surface: 'tarmac' | 'concrete'): void {
    const bucket = Math.floor(t * cadenceHz);
    if (bucket !== this.lastFootstepBucket) {
      this.lastFootstepBucket = bucket;
      this.audio.playFootstep(surface);
    }
  }

  private triggerDoorSlamOnce(bitIndex: number): void {
    const bit = 1 << bitIndex;
    if ((this.doorSlamMask & bit) === 0) {
      this.doorSlamMask |= bit;
      this.audio.playDoorSlam();
    }
  }

  private stepSequence(dt: number): void {
    const t = this.elapsedSec;
    this.lookCurrentYaw = THREE.MathUtils.damp(this.lookCurrentYaw, this.lookTargetYaw, 7.0, dt);
    this.lookCurrentPitch = THREE.MathUtils.damp(
      this.lookCurrentPitch,
      this.lookTargetPitch,
      7.0,
      dt,
    );

    if (this.muzzleFlashTimer > 0) this.muzzleFlashTimer = Math.max(0, this.muzzleFlashTimer - dt);
    if (this.squadFlashTimer > 0) this.squadFlashTimer = Math.max(0, this.squadFlashTimer - dt);
    this.gunRecoilKick = THREE.MathUtils.damp(this.gunRecoilKick, 0, 14.0, dt);
    this.squadRecoilKick = THREE.MathUtils.damp(this.squadRecoilKick, 0, 14.0, dt);
    if (this.killConfirmedTimer > 0) {
      this.killConfirmedTimer = Math.max(0, this.killConfirmedTimer - dt);
    }

    // Step warzone battlefield VFX (tracers, AA flak, artillery fireballs, smoke, searchlights, flares)
    if (this.warzoneVfx) {
      const exteriorActive = this.currentCameraMode !== 'gun_cam';
      this.warzoneVfx.update(t, dt, (intensity) => {
        if (exteriorActive) {
          this.audio.playDistantArtillery(intensity);
        }
      });
    }

    // Spin helicopter rotors (door gunner firing bursts are driven per-sequence below)
    if (this.heliRig) {
      this.heliRig.mainRotorPivot.rotation.y += dt * 26.0;
      this.heliRig.tailRotorPivot.rotation.x += dt * 42.0;
      this.heliRig.navStrobeMat.emissiveIntensity = Math.sin(t * 7.5) > 0.65 ? 3.2 : 0.45;
    }
    if (this.apcRig) {
      this.apcRig.beaconMat.emissiveIntensity = 1.4 + 2.2 * (0.5 + 0.5 * Math.sin(t * 8.5));
    }

    switch (this.sequence) {
      case 'prologue':
        this.stepPrologue(t, dt);
        break;
      case 'apc_to_outpost':
      case 'apc_to_hideout':
        this.stepApcEscort(t, dt);
        break;
      case 'infection_breach':
        this.stepInfectionBreach(t, dt);
        break;
      case 'heli_to_perimeter':
      case 'heli_to_conquest':
      case 'heli_to_battle':
        this.stepHelicopterInsertion(t, dt);
        break;
    }
  }

  private triggerDoorGunnerFiringAudio(t: number, active: boolean): void {
    if (!active) return;
    const bucket = Math.floor(t * 7.5);
    if (bucket !== this.lastDoorGunnerBucket) {
      this.lastDoorGunnerBucket = bucket;
      this.audio.playDoorGunnerBurst();
    }
  }

  /**
   * High-contrast Squadmate-Assisted 3-Hostile Gun-Mounted Camera corridor firefight (~9.5–11s).
   * Features backlit enemy silhouettes in prime 5.5–8.5m range, visible red hostile return tracers,
   * 100% direct target tracking, golden outgoing tracers, and bright impact spark bursts on every hit.
   */
  private stepGunCamFirefight(localT: number, durationSec: number, dt: number): void {
    if (!this.gunCamRig || this.corridorHostiles.length === 0) return;
    this.currentCameraMode = 'gun_cam';
    this.currentFeedLabel = 'WEAPON RAIL CAM · BREACH-01';
    this.currentLocationLabel = 'SECTOR 4 CORRIDOR · LIVE CONTACT';
    this.mouseLookActive = false;
    this.audio.setScoreIntensity(0.9);

    const progress = Math.min(1, localT / Math.max(1, durationSec));
    const zPos = THREE.MathUtils.lerp(-1.2, -11.0, progress);
    const swayX = Math.sin(localT * 3.1) * 0.032;
    const bobY = Math.abs(Math.sin(localT * 6.2)) * 0.022;
    this.gunCamRig.root.position.set(0.36 + swayX, 1.42 + bobY, zPos);

    this.triggerFootstepCadence(localT, 2.0, 'concrete');

    // Find current living target (for direct aim lock, outgoing tracers & hit sparks!)
    let activeTarget: GunCamHostileSlot = this.corridorHostiles[this.corridorHostiles.length - 1];
    for (let i = 0; i < this.corridorHostiles.length; i++) {
      const h = this.corridorHostiles[i];
      if (localT < h.killTimeSec + 0.15) {
        activeTarget = h;
        break;
      }
    }

    // Step all 3 backlit corridor hostiles (peeking out -> firing red return tracers -> collapsing!)
    for (let i = 0; i < this.corridorHostiles.length; i++) {
      const h = this.corridorHostiles[i];
      const peekU = THREE.MathUtils.smoothstep(localT, h.peekStartSec, h.peekEndSec);
      const hx = THREE.MathUtils.lerp(h.coverX, h.exposedX, peekU);

      if (h.flashTimer > 0) h.flashTimer = Math.max(0, h.flashTimer - dt);

      if (localT >= h.killTimeSec) {
        h.downBlend = THREE.MathUtils.damp(h.downBlend, 1, 7.6, dt);
      } else {
        h.downBlend = 0;
        // Hostile return-fire bursts: visible enemy muzzle flash + bright red incoming tracers!
        for (let s = 0; s < h.returnFireTimes.length; s++) {
          const bit = 1 << s;
          if (localT >= h.returnFireTimes[s] && (h.returnFireMask & bit) === 0) {
            h.returnFireMask |= bit;
            h.flashTimer = 0.085;
            this.audio.playEnemyIncomingShot();
            if (this.corridorVfx) {
              this._v3.set(hx + 0.1, 1.38, h.zPos + 0.72);
              this._v4.set(
                this.gunCamRig.root.position.x + (s % 2 === 0 ? -0.55 : 0.42),
                1.32 + (s - 1) * 0.14,
                zPos + 1.8,
              );
              this.corridorVfx.spawnTracer(this._v3, this._v4, true);
              // Sparks ricocheting near player cover wall on incoming fire
              this._v4.set(s % 2 === 0 ? -1.45 : 1.55, 1.15, zPos - 2.6);
              this.corridorVfx.spawnImpactBurst(this._v4, false);
            }
          }
        }
      }

      h.actor.muzzleFlashMesh.visible = h.flashTimer > 0 && h.downBlend < 0.1;
      h.actor.muzzleFlashMesh.rotation.z = localT * 52;
      h.actor.skeleton.root.position.set(hx, -h.downBlend * 0.12, h.zPos);
      poseHostileCombatant(h.actor.skeleton, localT, h.downBlend, h.actor.weaponMount);
    }

    const activePeekU = THREE.MathUtils.smoothstep(
      localT,
      activeTarget.peekStartSec,
      activeTarget.peekEndSec,
    );
    const activeTargetX = THREE.MathUtils.lerp(
      activeTarget.coverX,
      activeTarget.exposedX,
      activePeekU,
    );
    const activeTargetZ = activeTarget.zPos;

    // Allied Breach Squadmate advancing stacked ahead-left firing suppressive golden tracers!
    if (this.breachSquadmate) {
      const squadZ = zPos - 2.0 + Math.sin(localT * 1.4) * 0.16;
      const squadX = -1.16 + Math.sin(localT * 1.1) * 0.12;
      this.breachSquadmate.skeleton.root.position.set(squadX, 0, squadZ);
      this.breachSquadmate.skeleton.root.rotation.y = Math.sin(localT * 1.6) * 0.08;

      const squadShotTimes = [1.45, 1.72, 4.35, 4.62, 7.05, 7.32];
      for (let i = 0; i < squadShotTimes.length; i++) {
        const bit = 1 << i;
        if (localT >= squadShotTimes[i] && (this.squadShotsMask & bit) === 0) {
          this.squadShotsMask |= bit;
          this.squadFlashTimer = 0.075;
          this.squadRecoilKick = 0.85;
          this.audio.playGunshot(false, true);
          if (this.corridorVfx) {
            this._v3.set(squadX + 0.18, 1.36, squadZ - 0.72);
            this._v4.set(activeTargetX - 0.22, 1.24, activeTargetZ);
            this.corridorVfx.spawnTracer(this._v3, this._v4, false);
            this.corridorVfx.spawnImpactBurst(this._v4, false);
          }
        }
      }
      this.breachSquadmate.muzzleFlashMesh.visible = this.squadFlashTimer > 0;
      this.breachSquadmate.muzzleFlashMesh.rotation.z = localT * 48;

      poseWalkingOperator(this.breachSquadmate.skeleton, localT * 5.6, 0.72, {
        aimBlend01: 0.94,
        recoilKick01: this.squadRecoilKick,
        headYawRad: Math.sin(localT * 1.8) * 0.1,
        weaponMount: this.breachSquadmate.weaponMount,
      });
    }

    // Player weapon-rail bursts clearing all 3 backlit hostiles with tracers + hit spark bursts!
    const playerShots: Array<{ time: number; isKill: boolean; targetIdx: number }> = [
      { time: 2.25, isKill: false, targetIdx: 0 },
      { time: 2.55, isKill: false, targetIdx: 0 },
      { time: 2.85, isKill: true, targetIdx: 0 },
      { time: 5.15, isKill: false, targetIdx: 1 },
      { time: 5.45, isKill: false, targetIdx: 1 },
      { time: 5.75, isKill: true, targetIdx: 1 },
      { time: 7.82, isKill: false, targetIdx: 2 },
      { time: 8.08, isKill: false, targetIdx: 2 },
      { time: 8.35, isKill: true, targetIdx: 2 },
    ];
    for (let i = 0; i < playerShots.length; i++) {
      const bit = 1 << i;
      if (localT >= playerShots[i].time && (this.shotsFiredMask & bit) === 0) {
        this.shotsFiredMask |= bit;
        this.muzzleFlashTimer = 0.08;
        this.gunRecoilKick = playerShots[i].isKill ? 0.095 : 0.064;
        this.audio.playGunshot(playerShots[i].isKill, false);

        const targetSlot = this.corridorHostiles[playerShots[i].targetIdx] ?? activeTarget;
        if (this.corridorVfx) {
          this._v3.set(
            this.gunCamRig.root.position.x,
            this.gunCamRig.root.position.y + 0.05,
            zPos - 0.75,
          );
          this._v4.set(
            targetSlot.actor.skeleton.root.position.x,
            playerShots[i].isKill ? 1.42 : 1.24,
            targetSlot.zPos,
          );
          this.corridorVfx.spawnTracer(this._v3, this._v4, false);
          this.corridorVfx.spawnImpactBurst(this._v4, playerShots[i].isKill);
        }

        if (playerShots[i].isKill) {
          this.killCount += 1;
          this.killConfirmedTimer = 1.45;
        }
      }
    }

    this.corridorVfx?.update(dt);

    // 100% Direct Target Lock onto active hostile's upper torso (zero under-steering!)
    const dx = activeTargetX - this.gunCamRig.root.position.x;
    const dy = 1.32 - this.gunCamRig.root.position.y;
    const dz = Math.min(-2.2, activeTargetZ - this.gunCamRig.root.position.z);
    const desiredYaw = THREE.MathUtils.clamp(Math.atan2(-dx, -dz), -0.34, 0.34);
    const desiredPitch = THREE.MathUtils.clamp(Math.atan2(dy, Math.abs(dz)), -0.14, 0.14);

    this.gunCamRig.weaponPivot.rotation.y = THREE.MathUtils.damp(
      this.gunCamRig.weaponPivot.rotation.y,
      desiredYaw,
      9.0,
      dt,
    );
    this.gunCamRig.weaponPivot.rotation.x = desiredPitch + this.gunRecoilKick * 1.35;
    this.gunCamRig.weaponPivot.rotation.z = -this.gunRecoilKick * 0.32;
    this.gunCamRig.weaponPivot.position.set(0, 0, this.gunRecoilKick * 0.34);

    const flashOn = this.muzzleFlashTimer > 0;
    this.gunCamRig.muzzleFlashMesh.visible = flashOn;
    this.gunCamRig.muzzleFlashMesh.rotation.z = localT * 45;
    this.gunCamRig.muzzleLight.intensity = flashOn ? 22 : 0;

    // Lock camera tightly onto the unobstructed upper-right Picatinny side-rail mount
    this.gunCamRig.root.updateMatrixWorld(true);
    this.gunCamRig.cameraAnchor.getWorldPosition(this._v1);
    this.gunCamRig.cameraAnchor.getWorldQuaternion(this._q1);
    this.camera.position.copy(this._v1);
    this.camera.quaternion.copy(this._q1);
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
  }

  private stepPrologue(t: number, dt: number): void {
    // Smooth cinematic crossfades between Act 1A (0-12s), Act 1B (12-23s), Act 2 (23-38s), Act 3 (38-48s)
    if (t < 1.1) {
      this.currentFadeOpacity = 1 - t / 1.1;
    } else if (t > 11.65 && t < 12.35) {
      this.currentFadeOpacity = 1 - Math.abs(t - 12.0) / 0.35;
    } else if (t > 22.6 && t < 23.4) {
      this.currentFadeOpacity = 1 - Math.abs(t - 23.0) / 0.4;
    } else if (t > 37.65 && t < 38.35) {
      this.currentFadeOpacity = 1 - Math.abs(t - 38.0) / 0.35;
    } else if (t > 46.8) {
      this.currentFadeOpacity = Math.min(1, (t - 46.8) / 1.2);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 12.0) {
      // ACT 1A (12s): Clean Cinema Aerial Sweep over Active Combined-Arms Warzone Valley & Escort Gunship
      this.audio.setAmbience('drone_wind');
      this.audio.setScoreIntensity(0.62);
      this.currentCameraMode = 'drone_aerial';
      this.currentFeedLabel = '';
      this.currentLocationLabel = '';
      this.mouseLookActive = false;

      const u = t / 12.0;
      const smoothU = THREE.MathUtils.smoothstep(u, 0, 1);
      this.camera.position.set(
        THREE.MathUtils.lerp(-34, 22, smoothU),
        THREE.MathUtils.lerp(28, 13.5, smoothU),
        THREE.MathUtils.lerp(-78, -12, smoothU),
      );
      this._v1.set(THREE.MathUtils.lerp(-6, 0, smoothU), 2.8, THREE.MathUtils.lerp(-34, -4, smoothU));
      this.camera.lookAt(this._v1);
      this.camera.fov = 52;
      this.camera.updateProjectionMatrix();

      if (this.heliRig) {
        this.heliRig.root.position.set(-48, 22, -52);
        this.heliRig.updateCrew(t, false);
      }
      if (this.escortGunship) {
        // Wingman gunship Valkyrie 2-2 sweeping across valley firing downward bursts!
        this.escortGunship.root.position.set(
          THREE.MathUtils.lerp(-28, 16, smoothU),
          THREE.MathUtils.lerp(17, 11.5, smoothU) + Math.sin(t * 1.4) * 0.8,
          THREE.MathUtils.lerp(-60, -24, smoothU),
        );
        this.escortGunship.root.rotation.set(-0.14, -0.78, -0.18);
        const gunshipFiring = (t > 1.8 && t < 5.2) || (t > 7.0 && t < 10.6);
        this.escortGunship.updateCombat(t, dt, gunshipFiring);
      }
      return;
    }

    if (t < 23.0) {
      // ACT 1B (11s): Backlit Squadmate-Assisted 3-Kill Gun-Mounted Camera Corridor Breach
      this.audio.setAmbience('bunker_hum');
      this.stepGunCamFirefight(t - 12.0, 11.0, dt);
      return;
    }

    if (t < 38.0 && this.heliRig) {
      // ACT 2 (15s): Interactive First-Person Helicopter Ride WITH ACTIVE DOOR GUNNER + SEATED SQUADMATE + LIVE MOUSE-LOOK
      this.audio.setAmbience('helicopter');
      this.audio.setScoreIntensity(0.55);
      const u = (t - 23.0) / 15.0;
      const descent = THREE.MathUtils.smoothstep(u, 0, 1);

      // Door gunner engages valley targets in crisp bursts during descent (24.2-26.6s & 28.0-30.2s)
      const gunnerFiring = (t >= 24.2 && t <= 26.6) || (t >= 28.0 && t <= 30.2);
      this.heliRig.updateCrew(t, gunnerFiring);
      this.triggerDoorGunnerFiringAudio(t, gunnerFiring);

      this.heliRig.root.position.set(
        THREE.MathUtils.lerp(-30, 0, descent),
        THREE.MathUtils.lerp(22, 0.08, descent),
        THREE.MathUtils.lerp(-58, 0, descent),
      );
      this.heliRig.root.rotation.set(
        THREE.MathUtils.lerp(-0.12, 0.01, descent),
        THREE.MathUtils.lerp(-0.42, Math.PI, descent),
        Math.sin(t * 1.1) * 0.025 * (1 - descent),
      );
      this.heliRig.root.updateMatrixWorld(true);

      if (this.escortGunship) {
        // Escort gunship flying wingman off port-forward bow visible through open doors & cockpit!
        this.escortGunship.root.position.set(
          this.heliRig.root.position.x - 16,
          this.heliRig.root.position.y + 4.2 + Math.sin(t * 1.3) * 0.7,
          this.heliRig.root.position.z - 14,
        );
        this.escortGunship.root.rotation.set(-0.12, this.heliRig.root.rotation.y + 0.12, -0.1);
        this.escortGunship.updateCombat(t, dt, t < 33.5 && Math.sin(t * 1.4) > 0.15);
      }

      const isExternalCut = t >= 30.5 && t <= 33.8;
      if (isExternalCut) {
        this.currentCameraMode = 'external_vehicle';
        this.currentFeedLabel = 'PAD CAM 01 · VALKYRIE 2-1 APPROACH';
        this.currentLocationLabel = 'BUNKER HELIPAD ZERO-ONE';
        this.mouseLookActive = false;
        const cutU = (t - 30.5) / 3.3;
        this.camera.position.set(
          THREE.MathUtils.lerp(13.5, 9.5, cutU),
          THREE.MathUtils.lerp(5.2, 3.2, cutU),
          THREE.MathUtils.lerp(10.5, 6.2, cutU),
        );
        this.camera.lookAt(this.heliRig.root.position);
        this.camera.fov = 50;
        this.camera.updateProjectionMatrix();
      } else {
        this.currentCameraMode = 'fp_helicopter';
        this.currentFeedLabel = 'VALKYRIE 2-1 TROOP BAY · MOVE MOUSE TO LOOK';
        this.currentLocationLabel = 'FINAL DESCENT · HELIPAD ZERO-ONE';
        this.mouseLookActive = true;

        this.heliRig.passengerSeatAnchor.getWorldPosition(this._v1);
        this.heliRig.passengerSeatAnchor.getWorldQuaternion(this._q1);
        this._euler.set(
          this.lookCurrentPitch - 0.05,
          HELI_DEFAULT_CABIN_YAW_RAD + this.lookCurrentYaw,
          Math.sin(t * 18) * 0.0035,
          'YXZ',
        );
        this._q2.setFromEuler(this._euler);
        this.camera.position.copy(this._v1);
        this.camera.quaternion.copy(this._q1).multiply(this._q2);
        this.camera.fov = 74;
        this.camera.updateProjectionMatrix();
      }
      return;
    }

    // ACT 3 (10s): Touchdown Disembark Walk & Ops Commander Airlock Briefing
    this.audio.setAmbience('bunker_hum');
    this.audio.setScoreIntensity(0.35);
    this.currentCameraMode = 'intake_briefing';
    this.currentFeedLabel = 'SECTOR 01 · AIRLOCK INTAKE';
    this.currentLocationLabel = 'HIDEOUT ENTRANCE BULKHEAD';
    this.mouseLookActive = false;

    const u = Math.min(1, (t - 38.0) / 10.0);
    if (this.heliRig) {
      this.heliRig.root.position.set(0, 0.08, 0);
      this.heliRig.root.rotation.set(0, Math.PI, 0);
      this.heliRig.updateCrew(t, false);
    }
    if (this.escortGunship) {
      this.escortGunship.root.position.set(-28, 18, -32);
      this.escortGunship.updateCombat(t, dt, false);
    }
    if (this.commanderNpc) {
      poseStandingNpcGesture(this.commanderNpc, 'briefing', t, {
        headYawRad: Math.sin(t * 0.9) * 0.07,
        playerNear: true,
      });
    }

    const walkU = Math.min(1, u / 0.65);
    if (walkU < 0.98) {
      this.triggerFootstepCadence(t, 1.85, 'tarmac');
    }
    const walkZ = THREE.MathUtils.lerp(3.2, 8.9, THREE.MathUtils.smoothstep(walkU, 0, 1));
    const bob = walkU < 0.98 ? Math.abs(Math.sin(t * 6.2)) * 0.032 * (1 - walkU * 0.5) : 0;
    this.camera.position.set(Math.sin(t * 3.1) * 0.025 * (1 - walkU), 1.64 + bob, walkZ);
    this._v1.set(0, 1.56, 11.2);
    this.camera.lookAt(this._v1);
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
  }

  private stepApcEscort(t: number, dt: number): void {
    if (!this.apcRig || !this.escortNpc) return;
    const isOutbound = this.sequence === 'apc_to_outpost';
    this.audio.setAmbience('apc_diesel');
    this.audio.setScoreIntensity(0.38);

    const mid = this.meta.midpointFadeSec ?? 14.8;
    if (t < 0.7) {
      this.currentFadeOpacity = 1 - t / 0.7;
    } else if (t > mid - 0.8 && t < mid + 0.8) {
      this.currentFadeOpacity = 1 - Math.abs(t - mid) / 0.8;
    } else if (t > this.meta.durationSec - 0.85) {
      this.currentFadeOpacity = Math.min(1, (t - (this.meta.durationSec - 0.85)) / 0.85);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 5.5) {
      // Phase 1 (5.5s): Driver walks naturally beside you from bunker gate toward idling APC
      const u = t / 5.5;
      this.currentCameraMode = 'fp_walk';
      this.currentFeedLabel = 'CONVOY ESCORT · BOARDING';
      this.currentLocationLabel = isOutbound ? 'SECTOR 4 APRON' : 'OUTPOST SOUTH GATE';
      this.mouseLookActive = false;
      this.audio.setVehicleThrottle(0.05);
      this.triggerFootstepCadence(t, 1.9, 'tarmac');

      this.apcRig.root.position.set(0, 0, -5.2);
      this.apcRig.root.rotation.set(0, 0, 0);
      this.apcRig.driverDoorPivot.rotation.y = THREE.MathUtils.degToRad(58);
      this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58);

      this.escortNpc.root.visible = true;
      this.escortNpc.root.position.set(
        THREE.MathUtils.lerp(-1.15, -1.95, u),
        0,
        THREE.MathUtils.lerp(4.8, -4.5, u),
      );
      this.escortNpc.root.rotation.y = 0;
      poseWalkingOperator(this.escortNpc, t * 5.8, 0.85, { headYawRad: -0.28 });

      this.camera.position.set(
        THREE.MathUtils.lerp(0.9, 2.08, u),
        1.64 + Math.abs(Math.sin(t * 5.8)) * 0.032,
        THREE.MathUtils.lerp(5.3, -4.3, u),
      );
      this._v1.set(THREE.MathUtils.lerp(-0.35, 0.6, u), 1.44, -5.4);
      this.camera.lookAt(this._v1);
      return;
    }

    if (t < 10.3) {
      // Phase 2 (4.8s): Driver enters driver seat while you board passenger seat & armored doors slam shut
      const u = (t - 5.5) / 4.8;
      this.currentCameraMode = 'fp_apc';
      this.currentFeedLabel = 'PASSENGER CAB · MOVE MOUSE TO LOOK';
      this.currentLocationLabel = 'ARMORED TRANSPORT · SEALING HATCHES';
      this.mouseLookActive = true;
      this.audio.setVehicleThrottle(0.18 + u * 0.2);

      this.apcRig.root.position.set(0, 0, -5.2);
      this.apcRig.root.rotation.set(0, 0, 0);
      const closeU = THREE.MathUtils.smoothstep(u, 0.48, 0.86);
      this.apcRig.driverDoorPivot.rotation.y = THREE.MathUtils.degToRad(58 * (1 - closeU));
      this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58 * (1 - closeU));
      if (u >= 0.85) {
        this.triggerDoorSlamOnce(0);
      }

      // Seat driver cleanly on cab floor deck behind steering wheel via two-bone IK
      this.apcRig.root.updateMatrixWorld(true);
      this.apcRig.driverSeatAnchor.getWorldPosition(this._v1);
      this.escortNpc.root.position.copy(this._v1);
      this.escortNpc.root.rotation.y = 0;
      poseSeatedOperator(this.escortNpc, 'apc_driver', t, {
        seatHeightAboveFloor: 0.42,
        headYawRad: -0.22 * (1 - closeU),
      });

      this.apcRig.passengerSeatAnchor.getWorldPosition(this._v2);
      const seatU = THREE.MathUtils.smoothstep(u, 0, 0.52);
      this.camera.position.set(
        THREE.MathUtils.lerp(2.08, this._v2.x, seatU),
        THREE.MathUtils.lerp(1.64, this._v2.y, seatU),
        THREE.MathUtils.lerp(-4.3, this._v2.z, seatU),
      );
      this._euler.set(this.lookCurrentPitch - 0.04, this.lookCurrentYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
      return;
    }

    if (t < mid) {
      // Phase 3 (4.5s): APC revs diesel & drives away into night mist (external chase cut)
      const u = (t - 10.3) / (mid - 10.3);
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'CONVOY TRANSIT · EN ROUTE';
      this.currentLocationLabel = isOutbound ? 'TRANSIT → QUARANTINE BELT' : 'TRANSIT → BUNKER SECTOR 4';
      this.mouseLookActive = false;
      this.audio.setVehicleThrottle(0.45 + u * 0.55);

      const zTravel = THREE.MathUtils.lerp(-5.2, -46, u * u);
      this.apcRig.root.position.set(0, Math.sin(t * 22) * 0.012, zTravel);
      this.apcRig.root.rotation.set(0, 0, 0);
      this.apcRig.driverDoorPivot.rotation.y = 0;
      this.apcRig.passengerDoorPivot.rotation.y = 0;
      this.apcRig.root.updateMatrixWorld(true);
      this.apcRig.driverSeatAnchor.getWorldPosition(this._v1);
      this.escortNpc.root.position.copy(this._v1);
      this.escortNpc.root.rotation.y = 0;
      poseSeatedOperator(this.escortNpc, 'apc_driver', t, { seatHeightAboveFloor: 0.42 });
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * (8 + u * 18);

      this.camera.position.set(5.4, 2.45, -1.8);
      this._v1.set(0, 1.5, zTravel);
      this.camera.lookAt(this._v1);
      return;
    }

    if (t < 20.0) {
      // Phase 4 (5.2s): Fade back in driving up to destination gate from passenger cab with mouse-look
      const u = (t - mid) / (20.0 - mid);
      const easeOut = 1 - Math.pow(1 - Math.min(1, u), 2.2);
      this.currentCameraMode = 'fp_apc';
      this.currentFeedLabel = 'ARRIVAL APPROACH · MOVE MOUSE TO LOOK';
      this.currentLocationLabel = isOutbound ? 'FORTIFIED INFECTION OUTPOST' : 'HIDEOUT SECTOR 4 AIRLOCK';
      this.mouseLookActive = true;
      this.audio.setVehicleThrottle(Math.max(0.08, 0.85 * (1 - easeOut)));

      const zArrive = THREE.MathUtils.lerp(-44, -4.5, easeOut);
      this.apcRig.root.position.set(0, Math.sin(t * 18) * 0.01 * (1 - easeOut), zArrive);
      this.apcRig.root.rotation.set(0, Math.PI, 0);
      this.apcRig.driverDoorPivot.rotation.y = 0;
      this.apcRig.passengerDoorPivot.rotation.y = 0;
      this.apcRig.root.updateMatrixWorld(true);
      this.apcRig.driverSeatAnchor.getWorldPosition(this._v1);
      this.escortNpc.root.position.copy(this._v1);
      this.escortNpc.root.rotation.y = Math.PI;
      poseSeatedOperator(this.escortNpc, 'apc_driver', t, { seatHeightAboveFloor: 0.42 });
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 16 * (1 - easeOut);

      this.apcRig.passengerSeatAnchor.getWorldPosition(this._v1);
      this.camera.position.copy(this._v1);
      this._euler.set(this.lookCurrentPitch - 0.04, Math.PI + this.lookCurrentYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
      return;
    }

    // Phase 5 (4.5s): Driver lets you out onto tarmac, door closes, and APC drives away
    const u = Math.min(1, (t - 20.0) / (this.meta.durationSec - 20.0));
    this.currentCameraMode = 'fp_walk';
    this.currentFeedLabel = 'CONVOY DROP-OFF';
    this.currentLocationLabel = isOutbound ? 'INFECTION OUTPOST YARD' : 'HIDEOUT AIRLOCK BAY';
    this.mouseLookActive = false;

    const departU = THREE.MathUtils.smoothstep(u, 0.44, 1.0);
    const doorOpen =
      THREE.MathUtils.smoothstep(u, 0, 0.22) * (1 - THREE.MathUtils.smoothstep(u, 0.34, 0.48));
    if (u >= 0.47) {
      this.triggerDoorSlamOnce(1);
    }
    this.audio.setVehicleThrottle(0.12 + departU * 0.8);
    const zAway = THREE.MathUtils.lerp(-4.5, 28, departU * departU);

    this.apcRig.root.position.set(-1.2, 0, zAway);
    this.apcRig.root.rotation.set(0, Math.PI, 0);
    this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58 * doorOpen);
    this.apcRig.root.updateMatrixWorld(true);
    this.apcRig.driverSeatAnchor.getWorldPosition(this._v1);
    this.escortNpc.root.position.copy(this._v1);
    this.escortNpc.root.rotation.y = Math.PI;
    poseSeatedOperator(this.escortNpc, 'apc_driver', t, { seatHeightAboveFloor: 0.42 });
    if (departU > 0.02) {
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 16 * departU;
    }

    const stepOutU = Math.min(1, u * 2.4);
    if (stepOutU < 0.95) {
      this.triggerFootstepCadence(t, 2.0, 'tarmac');
    }
    this.camera.position.set(THREE.MathUtils.lerp(0.6, 2.8, stepOutU), 1.64, -3.8);
    this._v1.set(-1.0, 1.5, zAway);
    this.camera.lookAt(this._v1);
  }

  private stepInfectionBreach(t: number, dt: number): void {
    if (t < 0.55) {
      this.currentFadeOpacity = 1 - t / 0.55;
    } else if (t > 5.7 && t < 6.3) {
      this.currentFadeOpacity = 1 - Math.abs(t - 6.0) / 0.3;
    } else if (t > 14.7) {
      this.currentFadeOpacity = Math.min(1, (t - 14.7) / 0.8);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 6.0 && this.apcRig) {
      this.audio.setAmbience('apc_diesel');
      this.audio.setScoreIntensity(0.65);
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'BREACH CONVOY · HOT ZONE ENTRY';
      this.currentLocationLabel = 'QUARANTINE BREACH CORRIDOR';
      this.mouseLookActive = false;

      const u = t / 6.0;
      const ease = 1 - Math.pow(1 - u, 2);
      this.audio.setVehicleThrottle(0.9 * (1 - ease * 0.65));
      const z = THREE.MathUtils.lerp(-42, -5.2, ease);
      this.apcRig.root.position.set(0, Math.sin(t * 24) * 0.015, z);
      this.apcRig.root.rotation.set(0, Math.PI, 0);
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 18 * (1 - u * 0.6);
      if (this.escortNpc) {
        this.apcRig.root.updateMatrixWorld(true);
        this.apcRig.driverSeatAnchor.getWorldPosition(this._v1);
        this.escortNpc.root.position.copy(this._v1);
        this.escortNpc.root.rotation.y = Math.PI;
        poseSeatedOperator(this.escortNpc, 'apc_driver', t, { seatHeightAboveFloor: 0.42 });
      }

      this.camera.position.set(6.2, 2.6, THREE.MathUtils.lerp(-10, -1.5, ease));
      this._v1.set(0, 1.45, z);
      this.camera.lookAt(this._v1);
      return;
    }

    this.audio.setAmbience('bunker_hum');
    this.stepGunCamFirefight(t - 6.0, 9.5, dt);
  }

  private stepHelicopterInsertion(t: number, dt: number): void {
    if (!this.heliRig) return;
    const mid = this.meta.midpointFadeSec ?? 10.3;
    const isCombat = this.sequence === 'heli_to_battle' || this.sequence === 'heli_to_conquest';
    const destLabel =
      this.sequence === 'heli_to_perimeter'
        ? 'PERIMETER OPERATIONS ZONE'
        : this.sequence === 'heli_to_conquest'
          ? 'CONQUEST THEATER HQ'
          : 'ACTIVE COMBAT SECTOR';

    if (t < 0.65) {
      this.currentFadeOpacity = 1 - t / 0.65;
    } else if (t > mid - 0.65 && t < mid + 0.65) {
      this.currentFadeOpacity = 1 - Math.abs(t - mid) / 0.65;
    } else if (isCombat && t > 16.2 && t < 16.8) {
      this.currentFadeOpacity = 1 - Math.abs(t - 16.5) / 0.3;
    } else if (t > this.meta.durationSec - 0.8) {
      this.currentFadeOpacity = Math.min(1, (t - (this.meta.durationSec - 0.8)) / 0.8);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 5.5) {
      // Phase 1 (5.5s): Walk onto Helipad Zero-One & climb into Valkyrie 2-1 starboard bench
      this.audio.setAmbience('helicopter');
      this.audio.setScoreIntensity(0.45);
      const u = t / 5.5;
      this.currentCameraMode = u < 0.58 ? 'fp_walk' : 'fp_helicopter';
      this.currentFeedLabel =
        u < 0.58
          ? 'HELIPAD PAD 01 · BOARDING VALKYRIE 2-1'
          : 'VALKYRIE 2-1 TROOP BAY · MOVE MOUSE TO LOOK';
      this.currentLocationLabel = 'BUNKER HELIPAD ZERO-ONE';
      this.mouseLookActive = u >= 0.58;
      if (u < 0.55) {
        this.triggerFootstepCadence(t, 1.9, 'tarmac');
      }

      this.heliRig.root.position.set(0, 0.08, 0);
      this.heliRig.root.rotation.set(0, 0, 0);
      this.heliRig.updateCrew(t, false);
      this.heliRig.root.updateMatrixWorld(true);
      this.heliRig.passengerSeatAnchor.getWorldPosition(this._v2);

      if (this.escortGunship) {
        this.escortGunship.root.position.set(-22, 16, -34);
        this.escortGunship.root.rotation.set(-0.08, 0.35, -0.08);
        this.escortGunship.updateCombat(t, dt, true);
      }

      const boardU = THREE.MathUtils.smoothstep(u, 0, 0.7);
      this.camera.position.set(
        THREE.MathUtils.lerp(4.8, this._v2.x, boardU),
        THREE.MathUtils.lerp(1.64, this._v2.y, boardU) + Math.abs(Math.sin(t * 6.0)) * 0.025 * (1 - boardU),
        THREE.MathUtils.lerp(4.6, this._v2.z, boardU),
      );
      if (this.mouseLookActive) {
        this._euler.set(
          this.lookCurrentPitch - 0.05,
          HELI_DEFAULT_CABIN_YAW_RAD + this.lookCurrentYaw,
          0,
          'YXZ',
        );
        this.camera.quaternion.setFromEuler(this._euler);
        this.camera.fov = 74;
        this.camera.updateProjectionMatrix();
      } else {
        this._v1.set(0, 1.65, 0);
        this.camera.lookAt(this._v1);
      }
      return;
    }

    if (t < mid) {
      // Phase 2 (4.8s): Liftoff & banked climb out over perimeter ridgelines
      this.audio.setAmbience('helicopter');
      this.audio.setScoreIntensity(0.58);
      const u = (t - 5.5) / (mid - 5.5);
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'PAD CAM 01 · VALKYRIE 2-1 LIFTOFF';
      this.currentLocationLabel = `DEPARTING → ${destLabel}`;
      this.mouseLookActive = false;

      const lift = u * u;
      this.heliRig.root.position.set(
        THREE.MathUtils.lerp(0, -14, lift),
        THREE.MathUtils.lerp(0.08, 19.5, lift),
        THREE.MathUtils.lerp(0, -38, lift),
      );
      this.heliRig.root.rotation.set(-0.18 * u, 0.22 * u, 0.14 * u);
      this.heliRig.updateCrew(t, false);

      if (this.escortGunship) {
        this.escortGunship.root.position.set(
          this.heliRig.root.position.x - 18,
          this.heliRig.root.position.y + 6,
          this.heliRig.root.position.z - 14,
        );
        this.escortGunship.root.rotation.set(-0.14, 0.25, 0.1);
        this.escortGunship.updateCombat(t, dt, true);
      }

      this.camera.position.set(11.5, 3.2, 8.5);
      this.camera.lookAt(this.heliRig.root.position);
      this.camera.fov = 52;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (isCombat && t >= 16.5) {
      // Combat Modes Final Act (9.5s): Backlit Squadmate-Assisted 3-Kill Gun-Cam Compound Breach!
      this.audio.setAmbience('bunker_hum');
      this.stepGunCamFirefight(t - 16.5, 9.5, dt);
      return;
    }

    // Phase 3: Fade back in inside Valkyrie 2-1 troop bay with ACTIVE DOOR GUNNER + SEATED SQUADMATE + mouse-look!
    this.audio.setAmbience('helicopter');
    this.audio.setScoreIntensity(isCombat ? 0.78 : 0.56);
    const flyDur = isCombat ? 16.5 - mid : this.meta.durationSec - mid;
    const u = Math.min(1, (t - mid) / Math.max(1, flyDur));
    const descent = THREE.MathUtils.smoothstep(u, 0, 1);

    const gunnerFiring = t >= mid + 1.0 && t <= mid + 4.8;
    this.heliRig.updateCrew(t, gunnerFiring);
    this.triggerDoorGunnerFiringAudio(t, gunnerFiring);

    this.heliRig.root.position.set(
      THREE.MathUtils.lerp(20, 0, descent),
      THREE.MathUtils.lerp(20, isCombat ? 8.5 : 0.22, descent),
      THREE.MathUtils.lerp(-56, 0, descent),
    );
    this.heliRig.root.rotation.set(
      THREE.MathUtils.lerp(-0.14, 0.02, descent),
      THREE.MathUtils.lerp(0.32, Math.PI, descent),
      Math.sin(t * 1.4) * 0.035 * (1 - descent),
    );
    this.heliRig.root.updateMatrixWorld(true);

    if (this.escortGunship) {
      this.escortGunship.root.position.set(
        this.heliRig.root.position.x - 16,
        this.heliRig.root.position.y + 4.0 + Math.sin(t * 1.2) * 0.7,
        this.heliRig.root.position.z - 12,
      );
      this.escortGunship.root.rotation.set(-0.12, this.heliRig.root.rotation.y + 0.14, -0.08);
      this.escortGunship.updateCombat(t, dt, true);
    }

    // Perimeter Ops finishes with a dramatic external touchdown shot on the last 5.5 seconds
    const showExternalLz = !isCombat && t >= 19.0;
    if (showExternalLz) {
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'FOB LZ · TOUCHDOWN';
      this.currentLocationLabel = destLabel;
      this.mouseLookActive = false;
      this.camera.position.set(11.8, 3.6, 8.4);
      this.camera.lookAt(this.heliRig.root.position);
      this.camera.fov = 52;
      this.camera.updateProjectionMatrix();
    } else {
      this.currentCameraMode = 'fp_helicopter';
      this.currentFeedLabel = 'VALKYRIE 2-1 APPROACH · MOVE MOUSE TO LOOK';
      this.currentLocationLabel = destLabel;
      this.mouseLookActive = true;

      this.heliRig.passengerSeatAnchor.getWorldPosition(this._v1);
      this.heliRig.passengerSeatAnchor.getWorldQuaternion(this._q1);
      this._euler.set(
        this.lookCurrentPitch - 0.05,
        HELI_DEFAULT_CABIN_YAW_RAD + this.lookCurrentYaw,
        Math.sin(t * 18) * 0.004,
        'YXZ',
      );
      this._q2.setFromEuler(this._euler);
      this.camera.position.copy(this._v1);
      this.camera.quaternion.copy(this._q1).multiply(this._q2);
      this.camera.fov = 74;
      this.camera.updateProjectionMatrix();
    }
  }

  private getActiveCaption(): { speaker: string; text: string } | null {
    for (let i = this.cues.length - 1; i >= 0; i--) {
      const c = this.cues[i];
      if (this.elapsedSec >= c.startSec && this.elapsedSec <= c.startSec + c.durationSec) {
        return { speaker: c.speaker, text: c.text };
      }
    }
    return null;
  }

  private buildSnapshot(): CinematicSnapshot {
    return {
      sequence: this.sequence,
      elapsedSec: this.elapsedSec,
      durationSec: this.meta.durationSec,
      paused: this.paused,
      audioBlocked: this.audio.isAudioBlocked(),
      skipHoldProgress01: this.skipHoldProgress01,
      fadeOpacity01: this.currentFadeOpacity,
      cameraMode: this.currentCameraMode,
      feedLabel: this.currentFeedLabel,
      locationLabel: this.currentLocationLabel,
      mouseLookActive: this.mouseLookActive,
      killConfirmedFlash: this.killConfirmedTimer > 0,
      killCount: this.killCount,
      caption: this.getActiveCaption(),
    };
  }

  private emitSnapshot(force: boolean): void {
    if (this.listeners.size === 0 && !force) return;
    const snap = this.buildSnapshot();
    for (const fn of this.listeners) {
      fn(snap);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.softwareTimerId);

    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('resize', this.onResize);

    this.audio.dispose();
    this.heliRig?.dispose();
    this.escortGunship?.dispose();
    this.apcRig?.dispose();
    this.gunCamRig?.dispose();
    this.warzoneVfx?.dispose();
    this.corridorVfx?.dispose();
    this.escortNpc?.dispose();
    this.commanderNpc?.dispose();
    this.breachSquadmate?.dispose();
    for (const h of this.corridorHostiles) {
      h.actor.dispose();
    }
    this.corridorHostiles = [];

    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }
}

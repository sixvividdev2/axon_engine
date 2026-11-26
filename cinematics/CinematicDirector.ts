import * as THREE from 'three';
import { operatorAssetLoader } from '../bodycam-sdk';
import type { CharacterSkeleton } from '../bodycam-sdk';
import { CinematicAudioPlayer } from './CinematicAudioPlayer';
import {
  CinematicSequenceId,
  CinematicVoiceCue,
  getVoiceCuesForSequence,
} from './cinematicVoiceManifest';
import {
  buildCinematicApc,
  buildCinematicHelicopter,
  buildGunCamRig,
  CinematicApcRig,
  CinematicHelicopterRig,
  GunCamRig,
} from './CinematicVehiclesAndRigs';

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
  skipHoldProgress01: number;
  fadeOpacity01: number;
  cameraMode: CinematicCameraMode;
  feedLabel: string;
  locationLabel: string;
  mouseLookActive: boolean;
  killConfirmedFlash: boolean;
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
    durationSec: 23.0,
    midpointFadeSec: null,
    hasGunCamBeat: true,
    hasMouseLookPhase: true,
    title: 'OPERATION AXON · PROLOGUE',
  },
  apc_to_outpost: {
    id: 'apc_to_outpost',
    durationSec: 12.2,
    midpointFadeSec: 6.4,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'CONVOY TRANSIT · SECTOR 4 → INFECTION OUTPOST',
  },
  apc_to_hideout: {
    id: 'apc_to_hideout',
    durationSec: 12.0,
    midpointFadeSec: 6.2,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'CONVOY EXTRACT · INFECTION OUTPOST → HIDEOUT',
  },
  infection_breach: {
    id: 'infection_breach',
    durationSec: 7.6,
    midpointFadeSec: 7.0,
    hasGunCamBeat: true,
    hasMouseLookPhase: false,
    title: 'INFECTION HOT ZONE · BREACH INSERTION',
  },
  heli_to_perimeter: {
    id: 'heli_to_perimeter',
    durationSec: 12.4,
    midpointFadeSec: 6.5,
    hasGunCamBeat: false,
    hasMouseLookPhase: true,
    title: 'VALKYRIE 2-1 · PERIMETER OPS INSERTION',
  },
  heli_to_conquest: {
    id: 'heli_to_conquest',
    durationSec: 12.6,
    midpointFadeSec: 6.4,
    hasGunCamBeat: true,
    hasMouseLookPhase: true,
    title: 'VALKYRIE 2-1 · CONQUEST THEATER ASSAULT',
  },
  heli_to_battle: {
    id: 'heli_to_battle',
    durationSec: 12.6,
    midpointFadeSec: 6.4,
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

type SnapshotListener = (snap: CinematicSnapshot) => void;

/**
 * Single-WebGL-Context AAA 3D Cinematic Director.
 * Renders all Prologue, APC Escort, Helicopter Insertion, Aerial Drone Sweep,
 * and Gun-Mounted Camera room-clearing firefight kill-shot cinematics.
 *
 * Strictly enforces:
 * - Zero per-frame heap allocations in the render loop
 * - <= 1 directional shadow caster (disabled on software GL)
 * - Software GL `afterDraw` pacing
 * - Clean `[Space]` pause/play and `Hold [Enter]` skip with guaranteed midpoint swap
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
  private apcRig: CinematicApcRig | null = null;
  private gunCamRig: GunCamRig | null = null;
  private escortNpc: CharacterSkeleton | null = null;
  private commanderNpc: CharacterSkeleton | null = null;
  private hostileNpc: CharacterSkeleton | null = null;
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

  // Gun-cam shot state
  private shotsFiredMask = 0;
  private muzzleFlashTimer = 0;
  private gunRecoilKick = 0;
  private hostileDownBlend = 0;
  private killConfirmedTimer = 0;

  private rafId = 0;
  private softwareTimerId = 0;
  private lastFrameMs = 0;
  private lastEmitMs = 0;

  // Scratch vectors/quaternions (zero per-frame GC)
  private readonly _v1 = new THREE.Vector3();
  private readonly _v2 = new THREE.Vector3();
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
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090d12);
    this.scene.fog = new THREE.FogExp2(0x0d131a, 0.011);

    this.camera = new THREE.PerspectiveCamera(
      64,
      Math.max(1, container.clientWidth || window.innerWidth) /
        Math.max(1, container.clientHeight || window.innerHeight),
      0.04,
      260,
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
    // Atmospheric twilight / night military lighting (strictly <= 1 shadow caster)
    const hemi = new THREE.HemisphereLight(0x647d99, 0x1b1e22, 0.72);
    this.scene.add(hemi);

    const keyDir = new THREE.DirectionalLight(0xffddb8, 1.85);
    keyDir.position.set(22, 34, 18);
    if (!this.isSoftwareGl) {
      keyDir.castShadow = true;
      keyDir.shadow.mapSize.set(1024, 1024);
      keyDir.shadow.camera.near = 2;
      keyDir.shadow.camera.far = 90;
      keyDir.shadow.camera.left = -28;
      keyDir.shadow.camera.right = 28;
      keyDir.shadow.camera.top = 28;
      keyDir.shadow.camera.bottom = -28;
    }
    this.scene.add(keyDir);

    // Build shared exterior tactical terrain (helipad, bunker entrance, road, hills, watchtowers)
    const terrain = new THREE.Group();
    this.terrainGroup = terrain;
    this.scene.add(terrain);

    const groundMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x1e2420, roughness: 0.92, metalness: 0.04 }),
    );
    const tarmacMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.82, metalness: 0.08 }),
    );
    const concreteMat = this.trackMat(
      new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.88, metalness: 0.06 }),
    );
    const padLineMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xd97706,
        emissiveIntensity: 0.55,
        roughness: 0.6,
      }),
    );
    const beaconRedMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xff8080,
        emissive: 0xef4444,
        emissiveIntensity: 3.0,
      }),
    );
    const padLightGreenMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xa7f3d0,
        emissive: 0x10b981,
        emissiveIntensity: 2.6,
      }),
    );

    const ground = new THREE.Mesh(this.trackGeo(new THREE.PlaneGeometry(260, 260)), groundMat);
    ground.rotation.x = -Math.PI * 0.5;
    ground.receiveShadow = true;
    terrain.add(ground);

    // Asphalt convoy road & Helipad Zero-One apron
    const road = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(10, 0.06, 130)), tarmacMat);
    road.position.set(0, 0.02, -32);
    road.receiveShadow = true;
    terrain.add(road);

    const helipad = new THREE.Mesh(this.trackGeo(new THREE.CylinderGeometry(8.5, 8.8, 0.12, 24)), tarmacMat);
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
      lamp.position.set(Math.cos(a) * 8.1, 0.16, Math.sin(a) * 8.1);
      terrain.add(lamp);
    }

    // Bunker Intake Bulkhead structure at Z = +14m
    const bunkerFace = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(18, 6.2, 5.5)), concreteMat);
    bunkerFace.position.set(0, 3.1, 15.5);
    bunkerFace.receiveShadow = true;
    terrain.add(bunkerFace);

    const bunkerLight = new THREE.PointLight(0xffd299, 10, 22, 1.4);
    bunkerLight.position.set(0, 4.2, 11.4);
    terrain.add(bunkerLight);

    // Perimeter ridgeline hills, barracks silhouettes & watchtowers for aerial drone sweep depth
    const hillGeo = this.trackGeo(new THREE.ConeGeometry(28, 16, 7));
    const hillSpots: Array<[number, number, number]> = [
      [-55, -55, 1.3],
      [52, -62, 1.15],
      [-68, 12, 1.0],
      [64, 18, 1.25],
      [0, -96, 1.45],
    ];
    for (const [hx, hz, hs] of hillSpots) {
      const h = new THREE.Mesh(hillGeo, groundMat);
      h.position.set(hx, 6 * hs, hz);
      h.scale.set(hs, hs, hs);
      terrain.add(h);
    }

    const towerGeo = this.trackGeo(new THREE.BoxGeometry(2.6, 11, 2.6));
    const beaconGeo = this.trackGeo(new THREE.SphereGeometry(0.24, 8, 6));
    for (const [tx, tz] of [
      [-18, -16],
      [18, -16],
      [-22, -48],
      [22, -48],
      [-16, 12],
      [16, 12],
    ]) {
      const tw = new THREE.Mesh(towerGeo, concreteMat);
      tw.position.set(tx, 5.5, tz);
      const bc = new THREE.Mesh(beaconGeo, beaconRedMat);
      bc.position.set(tx, 11.3, tz);
      terrain.add(tw, bc);
    }

    // Build isolated Concrete Room-Clearing Corridor Stage at Y = -40m for Gun-Mounted Camera firefight scenes
    if (this.meta.hasGunCamBeat) {
      const corr = new THREE.Group();
      corr.position.set(0, -40, 0);
      this.corridorGroup = corr;
      this.scene.add(corr);

      const corrFloor = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(5.4, 0.2, 24)), concreteMat);
      corrFloor.position.set(0, -0.1, -6);
      const corrCeil = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(5.4, 0.2, 24)), concreteMat);
      corrCeil.position.set(0, 3.4, -6);
      const corrLeft = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.3, 3.5, 24)), concreteMat);
      corrLeft.position.set(-2.65, 1.65, -6);
      const corrRight = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(0.3, 3.5, 24)), concreteMat);
      corrRight.position.set(2.65, 1.65, -6);
      const corrBack = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(5.6, 3.5, 0.4)), concreteMat);
      corrBack.position.set(0, 1.65, -17.5);
      // Tactical cover crate halfway down corridor
      const barrier = new THREE.Mesh(this.trackGeo(new THREE.BoxGeometry(1.4, 1.15, 0.7)), tarmacMat);
      barrier.position.set(-1.1, 0.58, -8.5);
      corr.add(corrFloor, corrCeil, corrLeft, corrRight, corrBack, barrier);

      const corrLight1 = new THREE.PointLight(0x93c5fd, 5.5, 16, 1.5);
      corrLight1.position.set(0, 2.95, -4);
      const corrLight2 = new THREE.PointLight(0xf87171, 6.2, 16, 1.5);
      corrLight2.position.set(0.4, 2.8, -12.5);
      corr.add(corrLight1, corrLight2);

      this.gunCamRig = buildGunCamRig();
      this.gunCamRig.root.position.set(0.1, 1.46, -1.8);
      corr.add(this.gunCamRig.root);

      const hostileOp = operatorAssetLoader.loadProceduralOperator('MALE', {
        previewMode: true,
        uniformId: this.sequence === 'infection_breach' ? 'infection' : 'ffa',
        gear: {
          uniformId: this.sequence === 'infection_breach' ? 'infection' : 'ffa',
          helmetType: 'mich',
          helmetColor: 'black',
          faceGear: 'balaclava',
        },
      });
      this.hostileNpc = hostileOp.skeleton;
      this.hostileNpc.setFirstPersonHeadShadowOnly(false);
      this.hostileNpc.root.position.set(0.55, 0, -11.4);
      this.hostileNpc.root.rotation.y = Math.PI; // facing shooter
      corr.add(this.hostileNpc.root);
    }

    // Spawn Helicopter or APC + Escort/Commander NPCs depending on sequence
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
    }

    if (needsApc) {
      this.apcRig = buildCinematicApc(this.isSoftwareGl);
      this.scene.add(this.apcRig.root);

      // Convoy Driver NPC walking alongside player & entering driver seat
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
    const nx = (e.clientX / Math.max(1, window.innerWidth)) * 2 - 1; // -1..+1
    const ny = (e.clientY / Math.max(1, window.innerHeight)) * 2 - 1; // -1..+1
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

      // Fire voiceover cues right on schedule
      for (const cue of this.cues) {
        if (this.elapsedSec >= cue.startSec && !this.playedCueIds.has(cue.id)) {
          this.playedCueIds.add(cue.id);
          this.audio.playVoiceCue(cue);
        }
      }

      // Fire midpoint scene swap cleanly at peak fade-to-black occlusion
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

  private stepSequence(dt: number): void {
    const t = this.elapsedSec;
    this.lookCurrentYaw = THREE.MathUtils.damp(this.lookCurrentYaw, this.lookTargetYaw, 7.0, dt);
    this.lookCurrentPitch = THREE.MathUtils.damp(
      this.lookCurrentPitch,
      this.lookTargetPitch,
      7.0,
      dt,
    );

    if (this.muzzleFlashTimer > 0) {
      this.muzzleFlashTimer = Math.max(0, this.muzzleFlashTimer - dt);
    }
    this.gunRecoilKick = THREE.MathUtils.damp(this.gunRecoilKick, 0, 14.0, dt);
    if (this.killConfirmedTimer > 0) {
      this.killConfirmedTimer = Math.max(0, this.killConfirmedTimer - dt);
    }

    // Spin rotors & flash beacons if present
    if (this.heliRig) {
      this.heliRig.mainRotorPivot.rotation.y += dt * 26.0;
      this.heliRig.tailRotorPivot.rotation.x += dt * 42.0;
      this.heliRig.navStrobeMat.emissiveIntensity =
        Math.sin(t * 7.5) > 0.65 ? 4.2 : 0.4;
    }
    if (this.apcRig) {
      this.apcRig.beaconMat.emissiveIntensity = 1.4 + 2.4 * (0.5 + 0.5 * Math.sin(t * 9.0));
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

  private stepGunCamFirefight(localT: number, dt: number): void {
    if (!this.gunCamRig || !this.hostileNpc) return;
    this.currentCameraMode = 'gun_cam';
    this.currentFeedLabel = 'WEAPON RAIL CAM · BREACH-01';
    this.currentLocationLabel = 'CONTAINMENT CORRIDOR · LIVE CONTACT';
    this.mouseLookActive = false;

    // Advance breacher rifle smoothly down the corridor while clearing right-to-left
    const zPos = THREE.MathUtils.lerp(-1.2, -5.2, Math.min(1, localT / 3.8));
    const swayX = Math.sin(localT * 3.4) * 0.05;
    const bobY = Math.abs(Math.sin(localT * 6.8)) * 0.032;
    this.gunCamRig.root.position.set(0.18 + swayX, 1.44 + bobY, zPos);

    // Track hostile stepping out from cover at t=1.0..2.2s
    const stepOut = THREE.MathUtils.smoothstep(localT, 0.4, 1.5);
    const hostileX = THREE.MathUtils.lerp(-1.1, 0.35, stepOut);
    this.hostileNpc.root.position.set(hostileX, 0, -11.4);

    // Fire 3 crisp shots at localT = 1.55s, 1.82s, 2.15s (kill shot!)
    const shotTimes = [1.55, 1.82, 2.15];
    for (let i = 0; i < shotTimes.length; i++) {
      const bit = 1 << i;
      if (localT >= shotTimes[i] && (this.shotsFiredMask & bit) === 0) {
        this.shotsFiredMask |= bit;
        this.muzzleFlashTimer = 0.065;
        this.gunRecoilKick = i === 2 ? 0.095 : 0.068;
        this.audio.playGunshot(i === 2);
        if (i === 2) {
          this.killConfirmedTimer = 1.35;
        }
      }
    }

    // Hostile drops dramatically on the 3rd (kill) shot
    if (localT >= 2.15) {
      this.hostileDownBlend = THREE.MathUtils.damp(this.hostileDownBlend, 1, 8.5, dt);
    } else {
      this.hostileDownBlend = 0;
    }
    this.hostileNpc.root.rotation.x = -this.hostileDownBlend * (Math.PI * 0.48);
    this.hostileNpc.root.position.y = -this.hostileDownBlend * 0.14;
    this.hostileNpc.rightArm.upperArm.rotation.set(-0.9 + this.hostileDownBlend * 0.6, 0, -0.2);

    // Weapon pivot aims directly at hostile + snappy upward/rearward gun-cam recoil kick
    const aimYaw = THREE.MathUtils.lerp(-0.14, -0.02, stepOut);
    this.gunCamRig.weaponPivot.rotation.set(
      this.gunRecoilKick * 1.45,
      aimYaw,
      -this.gunRecoilKick * 0.4,
    );
    this.gunCamRig.weaponPivot.position.set(0, 0, this.gunRecoilKick * 0.35);

    const flashOn = this.muzzleFlashTimer > 0;
    this.gunCamRig.muzzleFlashMesh.visible = flashOn;
    this.gunCamRig.muzzleFlashMesh.rotation.z = localT * 45;
    this.gunCamRig.muzzleLight.intensity = flashOn ? 18 : 0;

    // Lock camera tightly onto the weapon's upper side-rail mount!
    this.gunCamRig.root.updateMatrixWorld(true);
    this.gunCamRig.cameraAnchor.getWorldPosition(this._v1);
    this.gunCamRig.cameraAnchor.getWorldQuaternion(this._q1);
    this.camera.position.copy(this._v1);
    this.camera.quaternion.copy(this._q1);
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
  }

  private stepPrologue(t: number, dt: number): void {
    // Fade in at start & subtle crossfade between Act 1, Gun-Cam, Act 2, Act 3
    if (t < 0.7) {
      this.currentFadeOpacity = 1 - t / 0.7;
    } else if (t > 5.45 && t < 5.95) {
      this.currentFadeOpacity = 1 - Math.abs(t - 5.7) / 0.25;
    } else if (t > 10.25 && t < 10.85) {
      this.currentFadeOpacity = 1 - Math.abs(t - 10.55) / 0.3;
    } else if (t > 22.1) {
      this.currentFadeOpacity = Math.min(1, (t - 22.1) / 0.85);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 5.7) {
      // ACT 1A: Aerial Tactical Drone Sweep over Perimeter & Quarantine Corridor
      this.audio.setAmbience('drone_wind');
      this.currentCameraMode = 'drone_aerial';
      this.currentFeedLabel = 'OVERWATCH DRONE · REAPER-04';
      this.currentLocationLabel = 'PERIMETER QUARANTINE CORRIDOR';
      this.mouseLookActive = false;

      const u = t / 5.7;
      this.camera.position.set(
        THREE.MathUtils.lerp(-24, 14, u),
        THREE.MathUtils.lerp(24, 15.5, u),
        THREE.MathUtils.lerp(-58, -14, u),
      );
      this._v1.set(0, 2.2, -6);
      this.camera.lookAt(this._v1);
      this.camera.fov = 54;
      this.camera.updateProjectionMatrix();
      if (this.heliRig) {
        this.heliRig.root.position.set(-45, 22, -45);
      }
      return;
    }

    if (t < 10.55) {
      // ACT 1B: Gun-Mounted Camera Room-Clearing Firefight & Kill Shot
      this.audio.setAmbience('bunker_hum');
      this.stepGunCamFirefight(t - 5.7, dt);
      return;
    }

    if (t < 17.6 && this.heliRig) {
      // ACT 2: First-Person Helicopter Arrival WITH LIVE MOUSE-LOOK + brief external flyby cut
      this.audio.setAmbience('helicopter');
      const u = (t - 10.55) / 7.05;
      const descent = THREE.MathUtils.smoothstep(u, 0, 1);

      this.heliRig.root.position.set(
        THREE.MathUtils.lerp(-22, 0, descent),
        THREE.MathUtils.lerp(18, 0.08, descent),
        THREE.MathUtils.lerp(-42, 0, descent),
      );
      this.heliRig.root.rotation.set(
        THREE.MathUtils.lerp(-0.14, 0.02, descent),
        THREE.MathUtils.lerp(-0.48, Math.PI, descent),
        Math.sin(t * 1.4) * 0.03 * (1 - descent),
      );
      this.heliRig.root.updateMatrixWorld(true);

      const isExternalCut = t >= 14.2 && t <= 15.8;
      if (isExternalCut) {
        this.currentCameraMode = 'external_vehicle';
        this.currentFeedLabel = 'PAD CAM 01 · FINAL APPROACH';
        this.currentLocationLabel = 'BUNKER HELIPAD ZERO-ONE';
        this.mouseLookActive = false;
        this.camera.position.set(11.5, 4.4, 8.2);
        this.camera.lookAt(this.heliRig.root.position);
        this.camera.fov = 52;
        this.camera.updateProjectionMatrix();
      } else {
        this.currentCameraMode = 'fp_helicopter';
        this.currentFeedLabel = 'BODYCAM · VALKYRIE 2-1 BAY (MOVE MOUSE TO LOOK)';
        this.currentLocationLabel = 'DESCENDING · BUNKER HELIPAD 01';
        this.mouseLookActive = true;

        this.heliRig.passengerSeatAnchor.getWorldPosition(this._v1);
        this.heliRig.passengerSeatAnchor.getWorldQuaternion(this._q1);
        // Base view looks diagonally forward-left across open troop bay toward pilots & helipad
        this._euler.set(
          this.lookCurrentPitch - 0.08,
          Math.PI * 0.42 + this.lookCurrentYaw,
          Math.sin(t * 18) * 0.004,
          'YXZ',
        );
        this._q2.setFromEuler(this._euler);
        this.camera.position.copy(this._v1);
        this.camera.quaternion.copy(this._q1).multiply(this._q2);
        this.camera.fov = 72;
        this.camera.updateProjectionMatrix();
      }
      return;
    }

    // ACT 3: Touchdown & Airlock Intake Briefing with Ops Commander
    this.audio.setAmbience('bunker_hum');
    this.currentCameraMode = 'intake_briefing';
    this.currentFeedLabel = 'BODYCAM · SECTOR 01 INTAKE';
    this.currentLocationLabel = 'HIDEOUT AIRLOCK ENTRANCE';
    this.mouseLookActive = false;

    const u = Math.min(1, (t - 17.6) / 5.4);
    if (this.heliRig) {
      this.heliRig.root.position.set(0, 0.08, 0);
      this.heliRig.root.rotation.set(0, Math.PI, 0);
    }
    if (this.commanderNpc) {
      this.commanderNpc.rightArm.upperArm.rotation.set(-0.55 + Math.sin(t * 2.5) * 0.16, 0.1, -0.18);
      this.commanderNpc.rightArm.forearm.rotation.set(-0.72, 0, 0);
      this.commanderNpc.headGroup.rotation.y = Math.sin(t * 1.4) * 0.08;
    }

    const walkZ = THREE.MathUtils.lerp(4.2, 8.8, Math.min(1, u * 1.15));
    const bob = Math.abs(Math.sin(t * 7.2)) * 0.035 * (1 - u * 0.7);
    this.camera.position.set(Math.sin(t * 3.6) * 0.03, 1.64 + bob, walkZ);
    this._v1.set(0, 1.56, 11.2);
    this.camera.lookAt(this._v1);
    this.camera.fov = 64;
    this.camera.updateProjectionMatrix();
  }

  private stepApcEscort(t: number, dt: number): void {
    if (!this.apcRig || !this.escortNpc) return;
    const isOutbound = this.sequence === 'apc_to_outpost';
    this.audio.setAmbience('apc_diesel');

    // Fade to black around midpoint (t = 6.0..7.0) to swap Hideout <-> Infection Outpost seamlessly
    const mid = this.meta.midpointFadeSec ?? 6.4;
    if (t < 0.45) {
      this.currentFadeOpacity = 1 - t / 0.45;
    } else if (t > mid - 0.55 && t < mid + 0.55) {
      this.currentFadeOpacity = 1 - Math.abs(t - mid) / 0.55;
    } else if (t > this.meta.durationSec - 0.55) {
      this.currentFadeOpacity = Math.min(1, (t - (this.meta.durationSec - 0.55)) / 0.55);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 2.6) {
      // Phase 1: Driver NPC walks alongside player from bunker gate toward idling APC
      const u = t / 2.6;
      this.currentCameraMode = 'fp_walk';
      this.currentFeedLabel = 'BODYCAM · CONVOY ESCORT';
      this.currentLocationLabel = isOutbound ? 'SECTOR 4 APRON' : 'OUTPOST SOUTH GATE';
      this.mouseLookActive = false;

      this.apcRig.root.position.set(0, 0, -4.5);
      this.apcRig.root.rotation.set(0, 0, 0);
      this.apcRig.driverDoorPivot.rotation.y = THREE.MathUtils.degToRad(58);
      this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58);

      // Driver walks on left (-X) toward driver door
      this.escortNpc.root.visible = true;
      this.escortNpc.root.position.set(
        THREE.MathUtils.lerp(-1.1, -1.95, u),
        0,
        THREE.MathUtils.lerp(4.2, -3.9, u),
      );
      this.escortNpc.root.rotation.y = 0;
      const stride = Math.sin(t * 7.8);
      this.escortNpc.leftLeg.thigh.rotation.x = stride * 0.42;
      this.escortNpc.rightLeg.thigh.rotation.x = -stride * 0.42;
      this.escortNpc.headGroup.rotation.y = -0.35;

      // Player walks on right (+X) toward passenger door
      this.camera.position.set(
        THREE.MathUtils.lerp(0.85, 2.05, u),
        1.64 + Math.abs(Math.sin(t * 7.8)) * 0.032,
        THREE.MathUtils.lerp(4.8, -3.7, u),
      );
      this._v1.set(THREE.MathUtils.lerp(-0.4, 0.6, u), 1.42, -4.8);
      this.camera.lookAt(this._v1);
      return;
    }

    if (t < 4.5) {
      // Phase 2: Driver climbs into driver seat while player enters passenger side & door seals
      const u = (t - 2.6) / 1.9;
      this.currentCameraMode = 'fp_apc';
      this.currentFeedLabel = 'BODYCAM · BOARDING PASSENGER CAB (MOUSE LOOK)';
      this.currentLocationLabel = 'ARMORED TRANSPORT · BOARDING';
      this.mouseLookActive = true;

      this.apcRig.root.position.set(0, 0, -4.5);
      // Doors swing shut smoothly in second half
      const closeU = THREE.MathUtils.smoothstep(u, 0.45, 0.95);
      this.apcRig.driverDoorPivot.rotation.y = THREE.MathUtils.degToRad(58 * (1 - closeU));
      this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58 * (1 - closeU));

      // Driver sits in driver seat
      this.escortNpc.root.position.set(-0.62, 0.58, -5.02);
      this.escortNpc.root.rotation.y = 0;
      this.escortNpc.leftLeg.thigh.rotation.x = -1.25;
      this.escortNpc.rightLeg.thigh.rotation.x = -1.25;

      // Smoothly move camera from passenger doorway into passenger seat
      this.apcRig.root.updateMatrixWorld(true);
      this.apcRig.passengerSeatAnchor.getWorldPosition(this._v2);
      this.camera.position.set(
        THREE.MathUtils.lerp(2.05, this._v2.x, THREE.MathUtils.smoothstep(u, 0, 0.65)),
        THREE.MathUtils.lerp(1.64, this._v2.y, THREE.MathUtils.smoothstep(u, 0, 0.65)),
        THREE.MathUtils.lerp(-3.7, this._v2.z, THREE.MathUtils.smoothstep(u, 0, 0.65)),
      );
      this._euler.set(this.lookCurrentPitch - 0.04, this.lookCurrentYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
      return;
    }

    if (t < mid) {
      // Phase 3: APC accelerates & drives away into the night mist (external chase cut)
      const u = (t - 4.5) / (mid - 4.5);
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'CONVOY CAM · EN ROUTE';
      this.currentLocationLabel = isOutbound ? 'TRANSIT → QUARANTINE BELT' : 'TRANSIT → BUNKER SECTOR 4';
      this.mouseLookActive = false;

      const zTravel = THREE.MathUtils.lerp(-4.5, -32, u * u);
      this.apcRig.root.position.set(0, Math.sin(t * 24) * 0.012, zTravel);
      this.apcRig.driverDoorPivot.rotation.y = 0;
      this.apcRig.passengerDoorPivot.rotation.y = 0;
      this.escortNpc.root.position.set(-0.62, 0.58, zTravel - 0.52);
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * (8 + u * 16);

      this.camera.position.set(4.8, 2.35, -1.5);
      this._v1.set(0, 1.45, zTravel);
      this.camera.lookAt(this._v1);
      return;
    }

    if (t < 9.8) {
      // Phase 4: Fade back in driving up to destination gate from inside passenger cab
      const u = (t - mid) / (9.8 - mid);
      const easeOut = 1 - Math.pow(1 - Math.min(1, u), 2.4);
      this.currentCameraMode = 'fp_apc';
      this.currentFeedLabel = 'BODYCAM · ARRIVAL APPROACH (MOUSE LOOK)';
      this.currentLocationLabel = isOutbound ? 'FORTIFIED INFECTION OUTPOST' : 'HIDEOUT SECTOR 4 AIRLOCK';
      this.mouseLookActive = true;

      const zArrive = THREE.MathUtils.lerp(-34, -4.5, easeOut);
      this.apcRig.root.position.set(0, Math.sin(t * 20) * 0.01 * (1 - easeOut), zArrive);
      this.apcRig.root.rotation.set(0, Math.PI, 0); // driving South toward bunker gate at Z=+14
      this.apcRig.driverDoorPivot.rotation.y = 0;
      this.apcRig.passengerDoorPivot.rotation.y = 0;
      this.escortNpc.root.position.set(0.62, 0.58, zArrive + 0.52);
      this.escortNpc.root.rotation.y = Math.PI;
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 14 * (1 - easeOut);

      this.apcRig.root.updateMatrixWorld(true);
      this.apcRig.passengerSeatAnchor.getWorldPosition(this._v1);
      this.camera.position.copy(this._v1);
      this._euler.set(this.lookCurrentPitch - 0.04, Math.PI + this.lookCurrentYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
      return;
    }

    // Phase 5: Driver lets player out on tarmac and drives APC away!
    const u = Math.min(1, (t - 9.8) / (this.meta.durationSec - 9.8));
    this.currentCameraMode = 'fp_walk';
    this.currentFeedLabel = 'BODYCAM · DISEMBARKED';
    this.currentLocationLabel = isOutbound ? 'INFECTION OUTPOST YARD' : 'HIDEOUT AIRLOCK BAY';
    this.mouseLookActive = false;

    const departU = THREE.MathUtils.smoothstep(u, 0.42, 1.0);
    const doorOpen = THREE.MathUtils.smoothstep(u, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(u, 0.35, 0.52));
    const zAway = THREE.MathUtils.lerp(-4.5, 22, departU * departU);

    this.apcRig.root.position.set(-1.2, 0, zAway);
    this.apcRig.root.rotation.set(0, Math.PI, 0);
    this.apcRig.passengerDoorPivot.rotation.y = -THREE.MathUtils.degToRad(58 * doorOpen);
    this.escortNpc.root.position.set(-0.58, 0.58, zAway + 0.52);
    this.escortNpc.root.rotation.y = Math.PI;
    if (departU > 0.02) {
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 14 * departU;
    }

    // Player steps out to side & watches driver pull away
    this.camera.position.set(THREE.MathUtils.lerp(0.6, 2.5, Math.min(1, u * 2.2)), 1.64, -3.8);
    this._v1.set(-1.0, 1.5, zAway);
    this.camera.lookAt(this._v1);
  }

  private stepInfectionBreach(t: number, dt: number): void {
    if (t < 0.35) {
      this.currentFadeOpacity = 1 - t / 0.35;
    } else if (t > 3.25 && t < 3.65) {
      this.currentFadeOpacity = 1 - Math.abs(t - 3.45) / 0.2;
    } else if (t > 6.85) {
      this.currentFadeOpacity = Math.min(1, (t - 6.85) / 0.7);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 3.45 && this.apcRig) {
      this.audio.setAmbience('apc_diesel');
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'BREACH CONVOY · HOT ZONE ENTRY';
      this.currentLocationLabel = 'QUARANTINE BREACH CORRIDOR';
      this.mouseLookActive = false;

      const u = t / 3.45;
      const z = THREE.MathUtils.lerp(-28, -5.5, 1 - Math.pow(1 - u, 2));
      this.apcRig.root.position.set(0, Math.sin(t * 26) * 0.015, z);
      this.apcRig.root.rotation.set(0, Math.PI, 0);
      for (const w of this.apcRig.wheels) w.rotation.x -= dt * 18 * (1 - u * 0.7);
      if (this.escortNpc) this.escortNpc.root.visible = false;

      this.camera.position.set(5.4, 2.4, -2.0);
      this._v1.set(0, 1.4, z);
      this.camera.lookAt(this._v1);
      return;
    }

    this.audio.setAmbience('bunker_hum');
    this.stepGunCamFirefight(t - 3.45, dt);
  }

  private stepHelicopterInsertion(t: number, dt: number): void {
    if (!this.heliRig) return;
    const mid = this.meta.midpointFadeSec ?? 6.4;
    const isCombat = this.sequence === 'heli_to_battle' || this.sequence === 'heli_to_conquest';
    const destLabel =
      this.sequence === 'heli_to_perimeter'
        ? 'PERIMETER OPERATIONS ZONE'
        : this.sequence === 'heli_to_conquest'
          ? 'CONQUEST THEATER HQ'
          : 'ACTIVE COMBAT SECTOR';

    if (t < 0.45) {
      this.currentFadeOpacity = 1 - t / 0.45;
    } else if (t > mid - 0.5 && t < mid + 0.5) {
      this.currentFadeOpacity = 1 - Math.abs(t - mid) / 0.5;
    } else if (isCombat && t > 9.45 && t < 9.85) {
      this.currentFadeOpacity = 1 - Math.abs(t - 9.65) / 0.2;
    } else if (t > this.meta.durationSec - 0.55) {
      this.currentFadeOpacity = Math.min(1, (t - (this.meta.durationSec - 0.55)) / 0.55);
    } else {
      this.currentFadeOpacity = 0;
    }

    if (t < 3.6) {
      // Phase 1: Walk onto Pad 01 & climb into Valkyrie 2-1 troop bay
      this.audio.setAmbience('helicopter');
      const u = t / 3.6;
      this.currentCameraMode = u < 0.55 ? 'fp_walk' : 'fp_helicopter';
      this.currentFeedLabel =
        u < 0.55
          ? 'BODYCAM · HELIPAD PAD 01 BOARDING'
          : 'BODYCAM · VALKYRIE 2-1 BAY (MOVE MOUSE TO LOOK)';
      this.currentLocationLabel = 'BUNKER HELIPAD ZERO-ONE';
      this.mouseLookActive = u >= 0.55;

      this.heliRig.root.position.set(0, 0.08, 0);
      this.heliRig.root.rotation.set(0, 0, 0);
      this.heliRig.root.updateMatrixWorld(true);
      this.heliRig.passengerSeatAnchor.getWorldPosition(this._v2);

      const boardU = THREE.MathUtils.smoothstep(u, 0, 0.72);
      this.camera.position.set(
        THREE.MathUtils.lerp(4.4, this._v2.x, boardU),
        THREE.MathUtils.lerp(1.64, this._v2.y, boardU) + Math.abs(Math.sin(t * 7.2)) * 0.025 * (1 - boardU),
        THREE.MathUtils.lerp(4.2, this._v2.z, boardU),
      );
      if (this.mouseLookActive) {
        this._euler.set(this.lookCurrentPitch - 0.05, Math.PI * 0.42 + this.lookCurrentYaw, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(this._euler);
      } else {
        this._v1.set(0, 1.65, 0);
        this.camera.lookAt(this._v1);
      }
      return;
    }

    if (t < mid) {
      // Phase 2: Helicopter lifts off & banks into flight (external chase cut)
      this.audio.setAmbience('helicopter');
      const u = (t - 3.6) / (mid - 3.6);
      this.currentCameraMode = 'external_vehicle';
      this.currentFeedLabel = 'PAD CAM 01 · LIFTOFF CONFIRMED';
      this.currentLocationLabel = `EN ROUTE → ${destLabel}`;
      this.mouseLookActive = false;

      const lift = u * u;
      this.heliRig.root.position.set(
        THREE.MathUtils.lerp(0, -14, lift),
        THREE.MathUtils.lerp(0.08, 17, lift),
        THREE.MathUtils.lerp(0, -34, lift),
      );
      this.heliRig.root.rotation.set(-0.22 * u, 0.35 * u, 0.16 * u);

      this.camera.position.set(9.5, 3.2, 8.8);
      this.camera.lookAt(this.heliRig.root.position);
      return;
    }

    if (isCombat && t < 9.65) {
      // Phase 3A (Combat/Conquest): Vanguard Gun-Mounted Camera Firefight & Kill Shot!
      this.audio.setAmbience('bunker_hum');
      this.stepGunCamFirefight(t - mid, dt);
      return;
    }

    if (!isCombat && t < 9.65) {
      // Phase 3A (Perimeter Ops): Tactical Drone Recon sweep into FOB LZ
      this.audio.setAmbience('drone_wind');
      this.currentCameraMode = 'drone_aerial';
      this.currentFeedLabel = 'OVERWATCH DRONE · LZ RECON';
      this.currentLocationLabel = destLabel;
      this.mouseLookActive = false;

      const u = (t - mid) / (9.65 - mid);
      this.camera.position.set(
        THREE.MathUtils.lerp(22, -8, u),
        THREE.MathUtils.lerp(18, 9, u),
        THREE.MathUtils.lerp(-42, -12, u),
      );
      this._v1.set(0, 1.5, 0);
      this.camera.lookAt(this._v1);
      return;
    }

    // Phase 4: Final LZ Touchdown, disembark & Valkyrie 2-1 egress
    this.audio.setAmbience('helicopter');
    const u = Math.min(1, (t - 9.65) / (this.meta.durationSec - 9.65));
    const egress = THREE.MathUtils.smoothstep(u, 0.52, 1.0);
    this.currentCameraMode = u < 0.45 ? 'fp_helicopter' : 'fp_walk';
    this.currentFeedLabel = u < 0.45 ? 'BODYCAM · LZ TOUCHDOWN (MOUSE LOOK)' : 'BODYCAM · BOOTS ON GROUND';
    this.currentLocationLabel = destLabel;
    this.mouseLookActive = u < 0.45;

    this.heliRig.root.position.set(
      THREE.MathUtils.lerp(0, -10, egress * egress),
      THREE.MathUtils.lerp(0.08, 12, egress * egress),
      THREE.MathUtils.lerp(0, -24, egress * egress),
    );
    this.heliRig.root.rotation.set(-0.2 * egress, 0.3 * egress, 0.12 * egress);

    if (u < 0.45) {
      this.heliRig.root.updateMatrixWorld(true);
      this.heliRig.passengerSeatAnchor.getWorldPosition(this._v1);
      this.camera.position.copy(this._v1);
      this._euler.set(this.lookCurrentPitch - 0.06, Math.PI * 0.45 + this.lookCurrentYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
    } else {
      this.camera.position.set(3.2, 1.52, 2.8);
      this.camera.lookAt(this.heliRig.root.position);
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
      skipHoldProgress01: this.skipHoldProgress01,
      fadeOpacity01: this.currentFadeOpacity,
      cameraMode: this.currentCameraMode,
      feedLabel: this.currentFeedLabel,
      locationLabel: this.currentLocationLabel,
      mouseLookActive: this.mouseLookActive,
      killConfirmedFlash: this.killConfirmedTimer > 0,
      caption: this.getActiveCaption(),
    };
  }

  private emitSnapshot(force: boolean): void {
    if (force) this.lastEmitMs = performance.now();
    const snap = this.buildSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.softwareTimerId);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('resize', this.onResize);

    this.audio.dispose();
    this.heliRig?.dispose();
    this.apcRig?.dispose();
    this.gunCamRig?.dispose();
    this.escortNpc?.dispose();
    this.commanderNpc?.dispose();
    this.hostileNpc?.dispose();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.listeners.clear();
  }
}

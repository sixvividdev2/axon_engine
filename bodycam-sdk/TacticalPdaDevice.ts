import * as THREE from 'three';
import { IBodycamAudioSource } from './IBodycamAudioSource';
import { VIEWMODEL_LAYER } from './BodycamPostProcess';

export type PdaPhase = 'STOWED' | 'DRAWING' | 'POWER_PRESS' | 'ACTIVE' | 'POWER_OFF' | 'STOWING';

export interface PdaMapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PdaAllyMarker {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw?: number;
  alive: boolean;
  isMedic?: boolean;
}

export interface PdaPingMarker {
  x: number;
  z: number;
  label?: string;
  kind?: 'order' | 'contact' | 'poi' | 'danger';
  ttlSec?: number;
}

export interface PdaCommsBlackoutZone {
  x: number;
  z: number;
  radiusM: number;
  label: string;
}

export interface PdaConvoyMarker {
  x: number;
  z: number;
  label: string;
  friendly: boolean;
  disabled?: boolean;
}

export interface PdaSectorOverlay {
  id: string;
  code: string;
  name: string;
  x: number;
  z: number;
  radiusM: number;
  owner: 'pmc_alpha' | 'pmc_bravo' | 'subfaction' | 'contested' | 'neutral';
  /** Signed capture progress (-100..+100) or 0..100 normalized contest meter */
  captureProgress: number;
  /** Live battle heat 0..100 */
  heat?: number;
  /** Optional explicit world-space polygon vertices [x, z] for sector border rendering */
  polygon?: ReadonlyArray<readonly [number, number]>;
}

export interface PdaVehicleMarker {
  id: string;
  label: string;
  x: number;
  z: number;
  kind: 'ground' | 'air' | 'boat';
  owned?: boolean;
}

export interface PdaMortarFiringTableTelemetry {
  pitId: string;
  pitX: number;
  pitZ: number;
  currentDeflectionMils: number;
  currentElevationMils: number;
  currentElevationDeg: number;
  currentChargeLevel: 1 | 2 | 3 | 4;
  targetX: number;
  targetZ: number;
  targetRangeM: number;
  recommendedCharge: 1 | 2 | 3 | 4 | null;
  solutionDeflectionMils: number;
  solutionElevationMils: number;
  solutionElevationDeg: number;
  solutionFlightTimeSec: number;
  windLeadMils: number;
  inRange: boolean;
  foAddDropM: number;
  foLeftRightM: number;
}

export type PdaTabMode = 'tac_map' | 'fire_support';

export interface PdaMortarPitMarker {
  pitId: string;
  ownerTeam: 'A' | 'B';
  friendly: boolean;
  sourceType: 'HQ' | 'FOB';
  x: number;
  z: number;
  status: 'INACTIVE' | 'ACTIVE_AI' | 'FIRE_MISSION' | 'PLAYER_MANNED' | 'KIA_REINFORCING';
  respawnTimerSec: number;
  seatedPlayerName: string | null;
}

export interface PdaActiveMortarMissionMarker {
  missionId: string;
  pitId: string;
  team: 'A' | 'B';
  friendly: boolean;
  targetX: number;
  targetZ: number;
  roundsRemaining: number;
  totalRounds: number;
  callerName: string;
}

export interface PdaHqExclusionZone {
  x: number;
  z: number;
  radiusM: number;
  friendly: boolean;
}

export interface PdaFireSupportTelemetry {
  enabled: boolean;
  localTeam: 'A' | 'B';
  mortarCooldownSec: number;
  mortarMaxCooldownSec: number;
  activeMortarMissionId: string | null;
  availableAiBatteries: number;
  totalFriendlyBatteries: number;
  pits: readonly PdaMortarPitMarker[];
  activeMissions: readonly PdaActiveMortarMissionMarker[];
  hqExclusions: readonly PdaHqExclusionZone[];
  reticleX: number;
  reticleZ: number;
  reticleDangerClose: boolean;
  reticleMinFriendlyDistM: number;
  reticleInHqExclusion: boolean;
  reticleInRange: boolean;
  canCallMortarSweep: boolean;
  blockReason: string | null;
}

export interface PdaHudTelemetry {
  playerX: number;
  playerZ: number;
  playerYawRad: number;
  gameClockText: string;
  weatherLabel: string;
  windSpeedMps: number;
  windAngleRad: number;
  modeLabel?: string;
  zoneLabel?: string;
  allies?: readonly PdaAllyMarker[];
  pings?: readonly PdaPingMarker[];
  commsBlackoutZones?: readonly PdaCommsBlackoutZone[];
  convoys?: readonly PdaConvoyMarker[];
  sectors?: readonly PdaSectorOverlay[];
  vehicles?: readonly PdaVehicleMarker[];
  characterCallsign?: string;
  shardLabel?: string;
  factionLabel?: string;
  cashUsd?: number;
  respawnFeeUsd?: number;
  bankruptcyWarning?: boolean;
  bankruptcyText?: string;
  batteryPct?: number;
  mortarTable?: PdaMortarFiringTableTelemetry | null;
  fireSupport?: PdaFireSupportTelemetry | null;
}

export interface PdaOrthoCaptureOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  bounds: PdaMapBounds;
  excludeObjects?: readonly THREE.Object3D[];
}

/**
 * Live zero-GC locomotion, breathing, suspension, turn-lag, strafe, and lean motion snapshot
 * populated by BodycamController so the held 3D PDA moves as one grounded physical unit with the hands.
 */
export interface PdaMotionState {
  bobPhase: number;
  bobWeight: number;
  moveRatio: number;
  isMoving: boolean;
  isSprinting: boolean;
  isCrouched: boolean;
  breathX: number;
  breathY: number;
  verticalOffset: number;
  localStrafeVel: number;
  leanMeters: number;
  turnVelYaw: number;
  turnVelPitch: number;
}

export function createPdaMotionState(): PdaMotionState {
  return {
    bobPhase: 0,
    bobWeight: 0,
    moveRatio: 0,
    isMoving: false,
    isSprinting: false,
    isCrouched: false,
    breathX: 0,
    breathY: 0,
    verticalOffset: 0,
    localStrafeVel: 0,
    leanMeters: 0,
    turnVelYaw: 0,
    turnVelPitch: 0,
  };
}

const COMPASS_LABELS: ReadonlyArray<{ deg: number; label: string; major: boolean }> = [
  { deg: 0, label: 'N', major: true },
  { deg: 45, label: 'NE', major: false },
  { deg: 90, label: 'E', major: true },
  { deg: 135, label: 'SE', major: false },
  { deg: 180, label: 'S', major: true },
  { deg: 225, label: 'SW', major: false },
  { deg: 270, label: 'W', major: true },
  { deg: 315, label: 'NW', major: false },
];

const DRAWING_DUR = 0.19;
const POWER_PRESS_DUR = 0.27;
const POWER_OFF_DUR = 0.14;
const STOWING_DUR = 0.18;

const SCREEN_W = 1024;
const SCREEN_H = 640;

const JOY_PIVOT_X = 0.098;
const JOY_PIVOT_Y = -0.001;
const JOY_PIVOT_Z = 0.0082;
const JOY_CAP_Z = 0.0184;
const JOY_TRAVEL_M = 0.0052;
const JOY_MAX_TILT_RAD = 0.52;

const POWER_BTN_X = 0.092;
const POWER_BTN_Y = 0.045;
const POWER_BTN_Z = 0.0128;

function smoothstep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * STALKER-inspired physical 3D handheld Tactical Map PDA rendered on VIEWMODEL_LAYER.
 * Features:
 *  - Multi-stage equip choreography (stow weapon -> draw tablet -> press power button w/ tactile tilt -> bring closer)
 *  - Gimbaled 3D thumbstick & animated power button on right keypad
 *  - Live 1024x1024 top-down orthographic satellite capture (auto-slices overhead roofs)
 *  - Dynamic compass strip, 5x game clock, live weather + wind vector, ally & ping markers, zoom/pan reticle
 */
export class TacticalPdaDevice {
  public readonly root = new THREE.Group();
  private readonly deviceGroup = new THREE.Group();
  private readonly joystickPivot = new THREE.Group();
  private readonly powerBtnMesh: THREE.Mesh;
  private readonly screenMesh: THREE.Mesh;
  private readonly screenMat: THREE.MeshBasicMaterial;
  private readonly screenTexture: THREE.CanvasTexture;
  private readonly screenCanvas: HTMLCanvasElement;
  private readonly screenCtx: CanvasRenderingContext2D;
  // Split-rate offscreen cache: heavy map/sector/battery telemetry redraws strictly at <= 10 Hz
  private readonly telemetryCacheCanvas: HTMLCanvasElement;
  private readonly telemetryCacheCtx: CanvasRenderingContext2D;

  private readonly ledTopMat: THREE.MeshStandardMaterial;
  private readonly ledMidMat: THREE.MeshStandardMaterial;
  private readonly ledBotMat: THREE.MeshStandardMaterial;
  private readonly powerBtnMat: THREE.MeshStandardMaterial;

  // Hand & thumb IK sockets (parented under deviceGroup so hands stay locked during tilt/sway)
  private readonly leftGripSocket = new THREE.Object3D();
  private readonly rightGripSocket = new THREE.Object3D();
  private readonly rightThumbJoySocket = new THREE.Object3D();
  private readonly rightThumbPowerSocket = new THREE.Object3D();

  // Cached orthographic top-down terrain/architecture image + optional cached elevation contours
  private mapCacheCanvas: HTMLCanvasElement | null = null;
  private contourCacheCanvas: HTMLCanvasElement | null = null;
  private mapBounds: PdaMapBounds = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
  private mapAspectBounds: PdaMapBounds = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };

  private audio?: IBodycamAudioSource;
  private phase: PdaPhase = 'STOWED';
  private phaseTimer = 0;
  private powerButtonAudioPlayed = false;
  private screenOn = false;
  private bootTimer = 0;

  // Functional CR123A battery system (drains while powered ON in Open World; replaceable via inventory)
  private batteryPct = 100;
  private batteryDrainEnabled = false;
  private batteryDrainRatePerSec = 0.085; // ~19.6 min continuous screen-on runtime per fresh cell

  // Motion & interactive joystick state
  private weaponStowBlend = 0;
  private raiseBlend = 0;
  private bringCloserBlend = 0;
  private dragging = false;
  private thumbIntentX = 0; // desired thumb sweep intent from LMB+Drag (-1..1, circularly clamped)
  private thumbIntentY = 0;
  private joyTiltX = 0; // actual physical joystick tilt driven by post-IK thumbtip (-1..1)
  private joyTiltY = 0; // actual physical joystick tilt driven by post-IK thumbtip (-1..1)
  private panCenterU = 0.5; // normalized map center U (0.02..0.98)
  private panCenterV = 0.5; // normalized map center V (0.02..0.98)
  private mapZoom = 1.15;
  private centerOnPlayer = true;
  private wheelClickCooldown = 0;

  private tiltImpulseX = 0;
  private tiltImpulseZ = 0;
  private swayPhase = 0;
  // Damped bodycam locomotion, sprint carry, vertical suspension, turn inertia, strafe & lean state
  private sprintBlend = 0;
  private moveBlend = 0;
  private vertHeave = 0;
  private lookLagYaw = 0;
  private lookLagPitch = 0;
  private strafeInertia = 0;
  private leanTilt = 0;
  private redrawAccum = 0;
  private telemetryRedrawAccum = 0;
  private telemetryCacheDirty = true;
  private screenDirty = true;
  private activeTab: PdaTabMode = 'tac_map';
  private cachedCenterU = 0.5;
  private cachedCenterV = 0.5;
  private cachedDrawSize = 540;
  private telemetryRedrawCount = 0;
  private overlayRedrawCount = 0;

  // Latest tactical telemetry snapshot
  private telemetry: PdaHudTelemetry = {
    playerX: 0,
    playerZ: 0,
    playerYawRad: 0,
    gameClockText: '12:00',
    weatherLabel: 'CLEAR',
    windSpeedMps: 2.5,
    windAngleRad: 0.4,
  };

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];

  private readonly _tmpPos = new THREE.Vector3();
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _thumbLocal = new THREE.Vector3();
  private readonly _invDeviceMat = new THREE.Matrix4();
  private readonly _invRootMat = new THREE.Matrix4();
  private readonly _postIkDeltaLocal = new THREE.Vector3();

  constructor(audio?: IBodycamAudioSource) {
    this.audio = audio;
    this.root.name = 'tactical_pda_root';
    this.deviceGroup.name = 'tactical_pda_chassis';
    this.root.add(this.deviceGroup);

    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geos.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      this.mats.push(m);
      return m;
    };

    // === 1. RUGGED MIL-SPEC CHASSIS GEOMETRY (WIDTH ~0.275m, HEIGHT ~0.165m) ===
    const matPolymer = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x2c302c, roughness: 0.78, metalness: 0.14 }),
    );
    const matBumper = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x1b1e1c, roughness: 0.90, metalness: 0.06 }),
    );
    const matMetal = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x4b514e, roughness: 0.42, metalness: 0.78 }),
    );
    const matBezelDark = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x131615, roughness: 0.56, metalness: 0.25 }),
    );
    const matKeycap = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x232625, roughness: 0.72, metalness: 0.18 }),
    );

    // Main tablet slab
    const body = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.268, 0.156, 0.015)), matPolymer);
    this.deviceGroup.add(body);

    // Rubberized corner bumpers & top/bottom protective rails
    const bumperCoords: ReadonlyArray<[number, number, number, number]> = [
      [-0.128, 0.072, 0.028, 0.026],
      [0.128, 0.072, 0.028, 0.026],
      [-0.128, -0.072, 0.028, 0.026],
      [0.128, -0.072, 0.028, 0.026],
    ];
    for (const [bx, by, bw, bh] of bumperCoords) {
      const bumper = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(bw, bh, 0.019)), matBumper);
      bumper.position.set(bx, by, 0);
      this.deviceGroup.add(bumper);
    }

    // Left & right ergonomic grip bolsters (where palm heels lock)
    const gripL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.122, 0.021)), matBumper);
    gripL.position.set(-0.130, 0, 0.001);
    const gripR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.022, 0.122, 0.021)), matBumper);
    gripR.position.set(0.130, 0, 0.001);
    this.deviceGroup.add(gripL, gripR);

    // Top-left recessed antenna nub & lanyard loop
    const antenna = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.006, 0.0075, 0.024, 10)), matBumper);
    antenna.position.set(-0.095, 0.086, 0);
    const screwGeo = trackGeo(new THREE.CylinderGeometry(0.0024, 0.0024, 0.003, 8));
    for (const [sx, sy] of [
      [-0.124, 0.068],
      [-0.124, -0.068],
      [0.124, 0.068],
      [0.124, -0.068],
    ]) {
      const screw = new THREE.Mesh(screwGeo, matMetal);
      screw.rotation.x = Math.PI * 0.5;
      screw.position.set(sx, sy, 0.0096);
      this.deviceGroup.add(screw);
    }
    this.deviceGroup.add(antenna);

    // Inner recessed screen frame & dynamic 1024x640 OLED CanvasTexture
    const screenFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.186, 0.126, 0.004)), matBezelDark);
    screenFrame.position.set(-0.022, 0.0, 0.007);
    this.deviceGroup.add(screenFrame);

    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = SCREEN_W;
    this.screenCanvas.height = SCREEN_H;
    const ctx = this.screenCanvas.getContext('2d');
    if (!ctx) throw new Error('Unable to acquire 2D canvas context for TacticalPdaDevice');
    this.screenCtx = ctx;

    this.telemetryCacheCanvas = document.createElement('canvas');
    this.telemetryCacheCanvas.width = SCREEN_W;
    this.telemetryCacheCanvas.height = SCREEN_H;
    const tCtx = this.telemetryCacheCanvas.getContext('2d');
    if (!tCtx) throw new Error('Unable to acquire 2D telemetry cache context for TacticalPdaDevice');
    this.telemetryCacheCtx = tCtx;

    this.screenTexture = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTexture.colorSpace = THREE.SRGBColorSpace;
    this.screenTexture.minFilter = THREE.LinearFilter;
    this.screenTexture.magFilter = THREE.LinearFilter;

    this.screenMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: this.screenTexture,
        toneMapped: false,
      }),
    );
    this.screenMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(0.174, 0.112)), this.screenMat);
    this.screenMesh.position.set(-0.022, 0.0, 0.0094);
    this.deviceGroup.add(this.screenMesh);

    // Status LED indicators on separator bar right of screen
    const ledGeo = trackGeo(new THREE.BoxGeometry(0.0032, 0.011, 0.002));
    this.ledTopMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x164e2b, emissive: 0x10b981, emissiveIntensity: 0.05 }),
    );
    this.ledMidMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x4e1616, emissive: 0xef4444, emissiveIntensity: 0.05 }),
    );
    this.ledBotMat = trackMat(
      new THREE.MeshStandardMaterial({ color: 0x164e2b, emissive: 0x34d399, emissiveIntensity: 0.05 }),
    );
    const ledTop = new THREE.Mesh(ledGeo, this.ledTopMat);
    ledTop.position.set(0.072, 0.036, 0.0085);
    const ledMid = new THREE.Mesh(ledGeo, this.ledMidMat);
    ledMid.position.set(0.072, 0.012, 0.0085);
    const ledBot = new THREE.Mesh(ledGeo, this.ledBotMat);
    ledBot.position.set(0.072, -0.012, 0.0085);
    this.deviceGroup.add(ledTop, ledMid, ledBot);

    // Right-hand tactile keypad + red Power button + 3D Gimbaled Thumbstick
    this.powerBtnMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x7f1d1d,
        emissive: 0xdc2626,
        emissiveIntensity: 0.35,
        roughness: 0.45,
      }),
    );
    this.powerBtnMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.014, 0.012, 0.0045)), this.powerBtnMat);
    this.powerBtnMesh.position.set(0.092, 0.045, 0.0092);
    this.deviceGroup.add(this.powerBtnMesh);

    // Secondary function keypad buttons
    const keyPositions: ReadonlyArray<[number, number]> = [
      [0.109, 0.045],
      [0.092, 0.028],
      [0.109, 0.028],
      [0.092, -0.030],
      [0.109, -0.030],
      [0.092, -0.046],
      [0.109, -0.046],
    ];
    const keyGeo = trackGeo(new THREE.BoxGeometry(0.013, 0.011, 0.0035));
    for (const [kx, ky] of keyPositions) {
      const kMesh = new THREE.Mesh(keyGeo, matKeycap);
      kMesh.position.set(kx, ky, 0.0086);
      this.deviceGroup.add(kMesh);
    }

    // Joystick recessed collar & 3D gimbaled thumbstick shaft + concave cap
    const joyWell = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0135, 0.0145, 0.003, 16)), matBezelDark);
    joyWell.rotation.x = Math.PI * 0.5;
    joyWell.position.set(0.098, -0.001, 0.0076);
    this.deviceGroup.add(joyWell);

    this.joystickPivot.position.set(0.098, -0.001, 0.0082);
    const joyShaft = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0026, 0.0034, 0.007, 10)), matMetal);
    joyShaft.rotation.x = Math.PI * 0.5;
    joyShaft.position.set(0, 0, 0.0032);
    const joyCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.0092, 0.0078, 0.0038, 16)), matBumper);
    joyCap.rotation.x = Math.PI * 0.5;
    joyCap.position.set(0, 0, 0.0072);
    const joyRing = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.0084, 0.0011, 6, 16)), matKeycap);
    joyRing.position.set(0, 0, 0.0090);
    this.joystickPivot.add(joyShaft, joyCap, joyRing);
    this.deviceGroup.add(this.joystickPivot);

    // === 2. HAND & THUMB IK SOCKETS (deviceGroup local space) ===
    // Hand local convention: -Z points toward fingers, +Y is dorsal (back of hand), -Y is palm,
    // -side * X is radial/thumb side.
    // Build exact side-cradle orthonormal bases so forearms enter naturally from lower-left / lower-right,
    // palms wrap flush around the side bolsters, four fingers curl behind the casing, left thumb rests
    // along the upper-left bezel, and right thumb arches gently (~25-35°) onto the 3D joystick cap.
    const buildGripQuat = (side: -1 | 1): THREE.Quaternion => {
      const zAxis = new THREE.Vector3(side * 0.16, -0.68, 0.71).normalize();
      const dorsalHint = new THREE.Vector3(side * 0.84, 0.34, 0.42).normalize();
      const yAxis = dorsalHint.clone().addScaledVector(zAxis, -dorsalHint.dot(zAxis)).normalize();
      const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
      yAxis.crossVectors(zAxis, xAxis).normalize();
      return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis),
      );
    };

    this.leftGripSocket.position.set(-0.156, -0.049, 0.014);
    this.leftGripSocket.quaternion.copy(buildGripQuat(-1));

    this.rightGripSocket.position.set(0.158, -0.059, 0.014);
    this.rightGripSocket.quaternion.copy(buildGripQuat(1));

    // Right thumb targets inside deviceGroup space
    this.rightThumbJoySocket.position.set(JOY_PIVOT_X, JOY_PIVOT_Y, JOY_CAP_Z);
    this.rightThumbPowerSocket.position.set(POWER_BTN_X, POWER_BTN_Y, POWER_BTN_Z);
    this.deviceGroup.add(
      this.leftGripSocket,
      this.rightGripSocket,
      this.rightThumbJoySocket,
      this.rightThumbPowerSocket,
    );

    // Place everything on VIEWMODEL_LAYER so chest-cam sees PDA cleanly without world wall clipping
    this.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.layers.set(VIEWMODEL_LAYER);
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });

    this.deviceGroup.visible = false;
    this.drawScreenCanvas(0);
  }

  public setAudio(audio: IBodycamAudioSource): void {
    this.audio = audio;
  }

  public isOpen(): boolean {
    return this.phase === 'DRAWING' || this.phase === 'POWER_PRESS' || this.phase === 'ACTIVE';
  }

  public isActiveReady(): boolean {
    return this.phase === 'ACTIVE';
  }

  public isBlockingWeaponActions(): boolean {
    return this.phase !== 'STOWED' || this.weaponStowBlend > 0.04;
  }

  public isWeaponHidden(): boolean {
    return this.weaponStowBlend > 0.65;
  }

  public getWeaponStowBlend(): number {
    return this.weaponStowBlend;
  }

  public getPhase(): PdaPhase {
    return this.phase;
  }

  public getPowerPressWeight(): number {
    if (this.phase !== 'POWER_PRESS') return 0;
    const p = THREE.MathUtils.clamp(this.phaseTimer / POWER_PRESS_DUR, 0, 1);
    return Math.sin(p * Math.PI);
  }

  public getJoystickTilt(): { x: number; y: number } {
    return { x: this.joyTiltX, y: this.joyTiltY };
  }

  public getThumbIntent(): { x: number; y: number } {
    return { x: this.thumbIntentX, y: this.thumbIntentY };
  }

  public isDragging(): boolean {
    return this.dragging && this.isOpen();
  }

  public setDragging(dragging: boolean): void {
    const next = Boolean(dragging) && this.isOpen();
    if (this.dragging === next) return;
    this.dragging = next;
  }

  public getPanCenterUV(): { u: number; v: number } {
    if (this.centerOnPlayer) {
      const pUV = this.worldToMapUV(this.telemetry.playerX, this.telemetry.playerZ);
      return {
        u: THREE.MathUtils.clamp(pUV.u, 0.02, 0.98),
        v: THREE.MathUtils.clamp(pUV.v, 0.02, 0.98),
      };
    }
    return { u: this.panCenterU, v: this.panCenterV };
  }

  /** Converts current PDA center reticle UV back into world (x, z) meters for Mortar Ballistic Firing Table lookup. */
  public getReticleWorldCoords(): { x: number; z: number } {
    const uv = this.getPanCenterUV();
    const spanX = Math.max(1, this.mapAspectBounds.maxX - this.mapAspectBounds.minX);
    const spanZ = Math.max(1, this.mapAspectBounds.maxZ - this.mapAspectBounds.minZ);
    return {
      x: this.mapAspectBounds.minX + uv.u * spanX,
      z: this.mapAspectBounds.minZ + uv.v * spanZ,
    };
  }

  public isCenteredOnPlayer(): boolean {
    return this.centerOnPlayer;
  }

  public getMapZoom(): number {
    return this.mapZoom;
  }

  public getActiveTab(): PdaTabMode {
    return this.activeTab;
  }

  public setActiveTab(tab: PdaTabMode): void {
    const resolved: PdaTabMode =
      tab === 'fire_support' && !this.telemetry.fireSupport?.enabled ? 'tac_map' : tab;
    if (this.activeTab === resolved) return;
    this.activeTab = resolved;
    this.telemetryCacheDirty = true;
    this.screenDirty = true;
  }

  public toggleTab(): PdaTabMode {
    if (!this.telemetry.fireSupport?.enabled) {
      this.activeTab = 'tac_map';
      return this.activeTab;
    }
    const next: PdaTabMode = this.activeTab === 'tac_map' ? 'fire_support' : 'tac_map';
    this.setActiveTab(next);
    this.audio?.playPdaButtonClick();
    return this.activeTab;
  }

  /** Diagnostic counters verifying split-rate 10 Hz telemetry vs 60+ FPS interactive reticle rendering. */
  public getSplitRateStats(): { telemetryRedrawCount: number; overlayRedrawCount: number } {
    return {
      telemetryRedrawCount: this.telemetryRedrawCount,
      overlayRedrawCount: this.overlayRedrawCount,
    };
  }

  public setBatteryDrainEnabled(enabled: boolean, ratePerSec = 0.085): void {
    this.batteryDrainEnabled = enabled;
    this.batteryDrainRatePerSec = Math.max(0, ratePerSec);
  }

  public setBatteryPct(pct: number): void {
    const clamped = THREE.MathUtils.clamp(pct, 0, 100);
    if (Math.abs(clamped - this.batteryPct) > 1e-4) {
      this.batteryPct = clamped;
      if (this.batteryPct <= 0 && this.screenOn) {
        this.screenOn = false;
      }
      this.screenDirty = true;
    }
  }

  public getBatteryPct(): number {
    return this.batteryPct;
  }

  public isBatteryDepleted(): boolean {
    return this.batteryPct <= 0.001;
  }

  public replaceBattery(chargePct = 100): number {
    this.batteryPct = Math.max(0, Math.min(100, chargePct));
    if (this.phase === 'ACTIVE' && !this.screenOn && this.batteryPct > 0) {
      this.screenOn = true;
      this.bootTimer = 0;
    }
    this.audio?.playPdaPowerSound(true);
    this.screenDirty = true;
    return this.batteryPct;
  }

  /**
   * Pre-renders crisp marching-squares topographic elevation contour lines (minor 25m / index 100m)
   * onto a cached offscreen canvas so zero height queries run inside the 60fps loop.
   */
  public setElevationSampler(
    sampleHeight: (x: number, z: number) => number,
    bounds?: PdaMapBounds,
  ): void {
    const b = bounds ?? this.mapAspectBounds;
    const size = 512;
    const gridN = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const heights = new Float32Array((gridN + 1) * (gridN + 1));
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let j = 0; j <= gridN; j++) {
      const wz = b.minZ + (j / gridN) * spanZ;
      for (let i = 0; i <= gridN; i++) {
        const wx = b.minX + (i / gridN) * spanX;
        const h = sampleHeight(wx, wz);
        heights[j * (gridN + 1) + i] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }

    const cellPx = size / gridN;
    const startElev = Math.ceil(Math.max(10, minH) / 25) * 25;
    const endElev = Math.min(480, maxH);

    for (let elev = startElev; elev <= endElev; elev += 25) {
      const isIndex = elev % 100 === 0;
      ctx.strokeStyle = isIndex ? 'rgba(203, 213, 225, 0.34)' : 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = isIndex ? 1.4 : 0.85;
      ctx.beginPath();

      for (let j = 0; j < gridN; j++) {
        const row0 = j * (gridN + 1);
        const row1 = (j + 1) * (gridN + 1);
        for (let i = 0; i < gridN; i++) {
          const h00 = heights[row0 + i];
          const h10 = heights[row0 + i + 1];
          const h11 = heights[row1 + i + 1];
          const h01 = heights[row1 + i];

          const pts: number[] = [];
          const interp = (a: number, bVal: number) => {
            const denom = bVal - a;
            return Math.abs(denom) < 1e-4 ? 0.5 : (elev - a) / denom;
          };
          if ((h00 < elev) !== (h10 < elev)) {
            pts.push((i + interp(h00, h10)) * cellPx, j * cellPx);
          }
          if ((h10 < elev) !== (h11 < elev)) {
            pts.push((i + 1) * cellPx, (j + interp(h10, h11)) * cellPx);
          }
          if ((h01 < elev) !== (h11 < elev)) {
            pts.push((i + interp(h01, h11)) * cellPx, (j + 1) * cellPx);
          }
          if ((h00 < elev) !== (h01 < elev)) {
            pts.push(i * cellPx, (j + interp(h00, h01)) * cellPx);
          }
          if (pts.length >= 4) {
            ctx.moveTo(pts[0], pts[1]);
            ctx.lineTo(pts[2], pts[3]);
          }
        }
      }
      ctx.stroke();
    }

    this.contourCacheCanvas = canvas;
    this.screenDirty = true;
  }

  /**
   * Drives the 3D joystick gimbal strictly from the player's solved post-IK right thumbtip
   * position in world space relative to the physical joystick pivot, so the concave cap
   * tracks directly beneath the operator's thumb pad without inducing map pan drift.
   */
  public driveJoystickFromThumbWorldPos(
    thumbTipWorld: Readonly<THREE.Vector3>,
    dt: number,
    ikWeight = 1.0,
  ): void {
    if (!this.isOpen() || ikWeight < 0.55) {
      this.joyTiltX = THREE.MathUtils.damp(this.joyTiltX, 0, 16, dt);
      this.joyTiltY = THREE.MathUtils.damp(this.joyTiltY, 0, 16, dt);
      this.joystickPivot.rotation.set(
        -this.joyTiltY * JOY_MAX_TILT_RAD,
        this.joyTiltX * JOY_MAX_TILT_RAD,
        0,
        'YXZ',
      );
      return;
    }

    this.deviceGroup.updateMatrixWorld(true);
    this._invDeviceMat.copy(this.deviceGroup.matrixWorld).invert();
    this._thumbLocal.copy(thumbTipWorld).applyMatrix4(this._invDeviceMat);

    const pressW = this.getPowerPressWeight();
    const dx = this._thumbLocal.x - JOY_PIVOT_X;
    const dy = this._thumbLocal.y - JOY_PIVOT_Y;
    const dz = this._thumbLocal.z - JOY_CAP_Z;
    const radialDist = Math.hypot(dx, dy);

    // Thumb only physically drives the joystick when resting on/near the cap and not pressing Power
    const onStick = pressW < 0.08 && radialDist < 0.022 && Math.abs(dz) < 0.025;
    if (!onStick) {
      this.joyTiltX = THREE.MathUtils.damp(this.joyTiltX, 0, 18, dt);
      this.joyTiltY = THREE.MathUtils.damp(this.joyTiltY, 0, 18, dt);
    } else {
      let targetX = dx / JOY_TRAVEL_M;
      let targetY = dy / JOY_TRAVEL_M;
      const mag = Math.hypot(targetX, targetY);
      if (mag > 1) {
        targetX /= mag;
        targetY /= mag;
      } else if (mag < 0.03) {
        targetX = 0;
        targetY = 0;
      }
      this.joyTiltX = THREE.MathUtils.damp(this.joyTiltX, targetX, 28, dt);
      this.joyTiltY = THREE.MathUtils.damp(this.joyTiltY, targetY, 28, dt);
    }

    this.joystickPivot.rotation.set(
      -this.joyTiltY * JOY_MAX_TILT_RAD,
      this.joyTiltX * JOY_MAX_TILT_RAD,
      0,
      'YXZ',
    );
    this.joystickPivot.updateMatrixWorld(true);
  }

  public toggle(): void {
    this.setOpen(!this.isOpen());
  }

  public setOpen(open: boolean): void {
    if (open) {
      if (this.phase === 'STOWED' || this.phase === 'STOWING') {
        this.phase = 'DRAWING';
        this.phaseTimer = THREE.MathUtils.clamp(this.raiseBlend, 0, 1) * DRAWING_DUR;
        this.powerButtonAudioPlayed = false;
        this.screenOn = false;
        this.bootTimer = 0;
        this.dragging = false;
        this.thumbIntentX = 0;
        this.thumbIntentY = 0;
        this.deviceGroup.visible = true;
        this.screenDirty = true;
      } else if (this.phase === 'POWER_OFF') {
        if (this.screenOn) {
          this.phase = 'ACTIVE';
          this.phaseTimer = 0.2;
        } else {
          this.phase = 'POWER_PRESS';
          this.phaseTimer = 0;
          this.powerButtonAudioPlayed = false;
        }
        this.dragging = false;
        this.thumbIntentX = 0;
        this.thumbIntentY = 0;
        this.deviceGroup.visible = true;
        this.screenDirty = true;
      }
    } else {
      this.dragging = false;
      if (this.phase === 'DRAWING') {
        this.phase = 'STOWING';
        this.phaseTimer = (1 - THREE.MathUtils.clamp(this.raiseBlend, 0, 1)) * STOWING_DUR;
        this.thumbIntentX = 0;
        this.thumbIntentY = 0;
      } else if (this.phase === 'POWER_PRESS' || this.phase === 'ACTIVE') {
        this.phase = 'POWER_OFF';
        this.phaseTimer = 0;
        this.thumbIntentX = 0;
        this.thumbIntentY = 0;
        if (this.screenOn) {
          this.audio?.playPdaPowerSound(false);
        }
        this.screenDirty = true;
      }
    }
  }

  /**
   * Called on mouse move while LMB is held (Click + Drag) on the PDA:
   *  - Grab-sheet 1:1 map panning (drag down pulls north into view, drag right pulls west into view)
   *  - Zero-snap transition out of GPS lock starting from player's live map UV
   *  - Circularly clamped tactile right-thumb deflection driving the 3D gimbaled joystick
   */
  public applyDragDelta(dx: number, dy: number): void {
    if (!this.isOpen() || !this.dragging) return;
    if (this.phase !== 'ACTIVE') return;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;

    if (this.centerOnPlayer) {
      const pUV = this.worldToMapUV(this.telemetry.playerX, this.telemetry.playerZ);
      this.panCenterU = THREE.MathUtils.clamp(pUV.u, 0.02, 0.98);
      this.panCenterV = THREE.MathUtils.clamp(pUV.v, 0.02, 0.98);
      this.centerOnPlayer = false;
    }

    // Grab-sheet drag: pulling mouse down (dy > 0) shifts map sheet downward, revealing north (smaller V)
    const panSens = 0.00145 / Math.max(0.8, this.mapZoom);
    this.panCenterU = THREE.MathUtils.clamp(this.panCenterU - dx * panSens, 0.02, 0.98);
    this.panCenterV = THREE.MathUtils.clamp(this.panCenterV - dy * panSens, 0.02, 0.98);

    // Thumb glides in the physical drag direction on the 3D joystick cap (+X right, +Y up)
    const stepX = THREE.MathUtils.clamp(dx * 0.032, -0.6, 0.6);
    const stepY = THREE.MathUtils.clamp(-dy * 0.032, -0.6, 0.6);
    this.thumbIntentX += stepX;
    this.thumbIntentY += stepY;
    const len = Math.hypot(this.thumbIntentX, this.thumbIntentY);
    if (len > 1) {
      this.thumbIntentX /= len;
      this.thumbIntentY /= len;
    }
    this.screenDirty = true;
  }

  /** Legacy alias routed through drag-gated panning so free mouse look never drifts the PDA. */
  public applyMouseDelta(dx: number, dy: number): void {
    this.applyDragDelta(dx, dy);
  }

  /** Mouse wheel / trackpad zoom on tactical map. */
  public applyWheel(deltaY: number): void {
    if (!this.isOpen() || Math.abs(deltaY) < 0.01) return;
    const step = THREE.MathUtils.clamp(deltaY / 100, -1.5, 1.5);
    const factor = Math.pow(0.88, step);
    const nextZoom = THREE.MathUtils.clamp(this.mapZoom * factor, 0.9, 3.6);
    if (Math.abs(nextZoom - this.mapZoom) > 1e-4) {
      this.mapZoom = nextZoom;
      if (this.wheelClickCooldown <= 0) {
        this.audio?.playPdaButtonClick();
        this.wheelClickCooldown = 0.075;
      }
      this.screenDirty = true;
    }
  }

  /** Snap view back onto operator position. */
  public recenterOnPlayer(): void {
    const pUV = this.worldToMapUV(this.telemetry.playerX, this.telemetry.playerZ);
    this.panCenterU = THREE.MathUtils.clamp(pUV.u, 0.02, 0.98);
    this.panCenterV = THREE.MathUtils.clamp(pUV.v, 0.02, 0.98);
    this.centerOnPlayer = true;
    this.audio?.playPdaButtonClick();
    this.telemetryCacheDirty = true;
    this.screenDirty = true;
  }

  public setTelemetry(next: PdaHudTelemetry): void {
    this.telemetry = next;
    if (this.activeTab === 'fire_support' && !next.fireSupport?.enabled) {
      this.activeTab = 'tac_map';
      this.telemetryCacheDirty = true;
      this.screenDirty = true;
    }
  }

  /** Captures a clean top-down orthographic map of the level once on match load. */
  public captureOrthographicMap(opts: PdaOrthoCaptureOptions): void {
    const { renderer, scene, bounds, excludeObjects } = opts;
    this.mapBounds = { ...bounds };

    const spanX = Math.max(12, bounds.maxX - bounds.minX);
    const spanZ = Math.max(12, bounds.maxZ - bounds.minZ);
    const padRatio = 0.05;
    const wWorld = spanX * (1 + padRatio * 2);
    const dWorld = spanZ * (1 + padRatio * 2);
    const cx = (bounds.minX + bounds.maxX) * 0.5;
    const cz = (bounds.minZ + bounds.maxZ) * 0.5;

    // Preserve aspect ratio matching 1024x1024 square render target so buildings never stretch
    const maxSpan = Math.max(wWorld, dWorld);
    const halfSpan = maxSpan * 0.5;
    this.mapAspectBounds = {
      minX: cx - halfSpan,
      maxX: cx + halfSpan,
      minZ: cz - halfSpan,
      maxZ: cz + halfSpan,
    };

    const texSize = 1024;
    const rt = new THREE.WebGLRenderTarget(texSize, texSize, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });

    const orthoCam = new THREE.OrthographicCamera(
      -halfSpan,
      halfSpan,
      halfSpan,
      -halfSpan,
      0.5,
      240,
    );
    orthoCam.position.set(cx, 95, cz);
    orthoCam.up.set(0, 0, -1); // -Z (North) UP on image
    orthoCam.lookAt(cx, 0, cz);
    orthoCam.updateMatrixWorld(true);

    const hiddenObjects: Array<{ obj: THREE.Object3D; prevVisible: boolean }> = [];
    const bbox = new THREE.Box3();
    const excludeSet = new Set<THREE.Object3D>(excludeObjects ?? []);
    excludeSet.add(this.root);

    scene.traverse((obj) => {
      if (!obj.visible) return;
      if (excludeSet.has(obj)) {
        hiddenObjects.push({ obj, prevVisible: true });
        obj.visible = false;
        return;
      }
      if (obj.userData?.isRoof === true) {
        hiddenObjects.push({ obj, prevVisible: true });
        obj.visible = false;
        return;
      }
      if ((obj as THREE.Mesh).isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh && obj.layers.test(orthoCam.layers)) {
        const mesh = obj as THREE.Mesh;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        bbox.setFromObject(mesh);
        const minY = bbox.min.y;
        const height = bbox.max.y - bbox.min.y;
        const width = bbox.max.x - bbox.min.x;
        const depth = bbox.max.z - bbox.min.z;
        // Slice large overhead ceiling/roof slabs so interiors & catwalks stay legible on Tac-Map
        if (minY >= 3.05 && height <= 0.9 && width * depth >= 20) {
          hiddenObjects.push({ obj, prevVisible: true });
          obj.visible = false;
        }
      }
    });

    // Inject temporary neutral overhead cartographic daylight rig so midnight/storm starts still yield readable maps
    const mapRig = new THREE.Group();
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x334155, 1.35);
    const sun = new THREE.DirectionalLight(0xf8fafc, 1.45);
    sun.position.set(cx + 25, 85, cz + 18);
    mapRig.add(hemi, sun);
    scene.add(mapRig);

    const savedTarget = renderer.getRenderTarget();
    const savedFog = scene.fog;
    const savedClearColor = new THREE.Color();
    renderer.getClearColor(savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    const savedExposure = renderer.toneMappingExposure;

    try {
      scene.fog = null;
      renderer.setClearColor(0x0c1317, 1);
      renderer.toneMappingExposure = Math.max(1.15, savedExposure);
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      renderer.render(scene, orthoCam);

      const pixels = new Uint8Array(texSize * texSize * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, texSize, texSize, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = texSize;
      canvas.height = texSize;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imgData = ctx.createImageData(texSize, texSize);
        const dst = imgData.data;
        // Flip Y (WebGL bottom-up -> Canvas top-down) + apply crisp tactical olive-slate contrast
        for (let y = 0; y < texSize; y++) {
          const srcRow = (texSize - 1 - y) * texSize * 4;
          const dstRow = y * texSize * 4;
          for (let x = 0; x < texSize; x++) {
            const si = srcRow + x * 4;
            const di = dstRow + x * 4;
            const r = pixels[si];
            const g = pixels[si + 1];
            const b = pixels[si + 2];
            const luma = 0.299 * r + 0.587 * g + 0.114 * b;
            // Desaturate slightly and tint subtly into tactical recon slate/sage
            dst[di] = Math.min(255, Math.round(r * 0.72 + luma * 0.20 + 6));
            dst[di + 1] = Math.min(255, Math.round(g * 0.76 + luma * 0.24 + 10));
            dst[di + 2] = Math.min(255, Math.round(b * 0.72 + luma * 0.22 + 8));
            dst[di + 3] = 255;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        this.mapCacheCanvas = canvas;
        this.screenDirty = true;
      }
    } finally {
      for (let i = 0; i < hiddenObjects.length; i++) {
        hiddenObjects[i].obj.visible = hiddenObjects[i].prevVisible;
      }
      scene.remove(mapRig);
      hemi.dispose();
      sun.dispose();
      scene.fog = savedFog;
      renderer.setClearColor(savedClearColor, savedClearAlpha);
      renderer.toneMappingExposure = savedExposure;
      renderer.setRenderTarget(savedTarget);
      rt.dispose();
    }
  }

  /** Supplies a pre-rendered procedural topographic canvas (e.g. 4km open-world theater) directly to the PDA OLED. */
  public setCustomMapCanvas(canvas: HTMLCanvasElement, bounds: PdaMapBounds): void {
    this.mapBounds = { ...bounds };
    this.mapAspectBounds = { ...bounds };
    this.mapCacheCanvas = canvas;
    this.screenDirty = true;
  }

  /** Advance state machine, coupled bodycam locomotion/inertia pose, joystick gimbal & OLED texture redraw. */
  public update(
    dt: number,
    elapsed: number,
    moveSpeedRatio = 0,
    isCrouched = false,
    motion?: Readonly<PdaMotionState>,
  ): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    const effMoveRatio = motion ? motion.moveRatio : moveSpeedRatio;
    const effCrouched = motion ? motion.isCrouched : isCrouched;
    this.phaseTimer += clampedDt;
    this.swayPhase += clampedDt * (1.4 + effMoveRatio * 3.8);
    if (this.wheelClickCooldown > 0) {
      this.wheelClickCooldown = Math.max(0, this.wheelClickCooldown - clampedDt);
    }

    // Decay thumb motor intent smoothly back toward rest when mouse stops moving
    const intentDamp = Math.exp(-12 * clampedDt);
    this.thumbIntentX *= intentDamp;
    this.thumbIntentY *= intentDamp;

    // Decay tactile tilt impulse from power-button press
    const impDamp = Math.exp(-11 * clampedDt);
    this.tiltImpulseX *= impDamp;
    this.tiltImpulseZ *= impDamp;

    if (this.phase === 'DRAWING') {
      this.weaponStowBlend = smoothstep01(this.phaseTimer / DRAWING_DUR);
      if (this.phaseTimer >= DRAWING_DUR) {
        this.phase = 'POWER_PRESS';
        this.phaseTimer = 0;
        this.powerButtonAudioPlayed = false;
      }
    } else if (this.phase === 'POWER_PRESS') {
      this.weaponStowBlend = 1;
      const p = THREE.MathUtils.clamp(this.phaseTimer / POWER_PRESS_DUR, 0, 1);
      if (p >= 0.42 && !this.powerButtonAudioPlayed) {
        this.powerButtonAudioPlayed = true;
        this.tiltImpulseX = 0.095;
        this.tiltImpulseZ = -0.075;
        if (!this.isBatteryDepleted()) {
          this.screenOn = true;
          this.bootTimer = 0;
          this.audio?.playPdaPowerSound(true);
        } else {
          this.screenOn = false;
          this.audio?.playPdaButtonClick();
        }
        this.screenDirty = true;
      }
      if (this.phaseTimer >= POWER_PRESS_DUR) {
        this.phase = 'ACTIVE';
        this.phaseTimer = 0;
      }
    } else if (this.phase === 'ACTIVE') {
      this.weaponStowBlend = 1;
      if (this.screenOn) {
        this.bootTimer += clampedDt;
        if (this.batteryDrainEnabled && this.batteryPct > 0) {
          this.batteryPct = Math.max(0, this.batteryPct - this.batteryDrainRatePerSec * clampedDt);
          if (this.batteryPct <= 0) {
            this.screenOn = false;
            this.audio?.playPdaPowerSound(false);
            this.screenDirty = true;
          }
        }
      }
    } else if (this.phase === 'POWER_OFF') {
      this.weaponStowBlend = 1;
      const p = THREE.MathUtils.clamp(this.phaseTimer / POWER_OFF_DUR, 0, 1);
      if (p >= 0.35 && this.screenOn) {
        this.screenOn = false;
        this.screenDirty = true;
      }
      if (this.phaseTimer >= POWER_OFF_DUR) {
        this.phase = 'STOWING';
        this.phaseTimer = 0;
      }
    } else if (this.phase === 'STOWING') {
      this.weaponStowBlend = 1 - smoothstep01(this.phaseTimer / STOWING_DUR);
      if (this.phaseTimer >= STOWING_DUR) {
        this.phase = 'STOWED';
        this.phaseTimer = 0;
        this.weaponStowBlend = 0;
        this.raiseBlend = 0;
        this.bringCloserBlend = 0;
        this.sprintBlend = 0;
        this.moveBlend = 0;
        this.vertHeave = 0;
        this.lookLagYaw = 0;
        this.lookLagPitch = 0;
        this.strafeInertia = 0;
        this.leanTilt = 0;
        this.deviceGroup.visible = false;
      }
    } else {
      this.weaponStowBlend = 0;
      this.raiseBlend = 0;
      this.bringCloserBlend = 0;
      this.sprintBlend = 0;
      this.moveBlend = 0;
      this.vertHeave = 0;
      this.lookLagYaw = 0;
      this.lookLagPitch = 0;
      this.strafeInertia = 0;
      this.leanTilt = 0;
      this.deviceGroup.visible = false;
      return;
    }

    this.deviceGroup.visible = true;

    // === POSITION & ERGONOMIC STALKER FRAMING IN CAMERA SPACE ===
    // Camera faces -Z. PDA sits around ~25cm in front of chest-cam lens tilted cleanly for readability,
    // leaving top strip clear so operator keeps situational awareness above top bezel.
    let targetRaise = 0;
    let targetBringCloser = 0;
    if (this.phase === 'DRAWING') {
      targetRaise = smoothstep01(this.phaseTimer / DRAWING_DUR);
      targetBringCloser = 0;
    } else if (this.phase === 'POWER_PRESS') {
      targetRaise = 1;
      targetBringCloser = smoothstep01(Math.max(0, (this.phaseTimer - 0.14) / 0.13)) * 0.25;
    } else if (this.phase === 'ACTIVE') {
      targetRaise = 1;
      targetBringCloser = 1;
    } else if (this.phase === 'POWER_OFF') {
      targetRaise = 1;
      targetBringCloser = 0.35;
    } else if (this.phase === 'STOWING') {
      targetRaise = 1 - smoothstep01(this.phaseTimer / STOWING_DUR);
      targetBringCloser = 0;
    }

    this.raiseBlend = targetRaise;
    this.bringCloserBlend = THREE.MathUtils.damp(
      this.bringCloserBlend,
      targetBringCloser,
      16,
      clampedDt,
    );
    const raiseT = this.raiseBlend;
    const bringCloserT = this.bringCloserBlend;

    // === COUPLED BODYCAM LOCOMOTION, LOWERED SPRINT PUMP, BREATHING, HEAVE & TURN/STRAFE/LEAN INERTIA ===
    const wantsSprint = Boolean(motion?.isSprinting && this.phase === 'ACTIVE');
    this.sprintBlend = THREE.MathUtils.damp(this.sprintBlend, wantsSprint ? 1 : 0, 9.5, clampedDt);
    const sp = this.sprintBlend;

    const targetMoveBlend = motion
      ? THREE.MathUtils.clamp(Math.max(motion.bobWeight, motion.isMoving ? Math.min(1, motion.moveRatio) : 0), 0, 1)
      : THREE.MathUtils.clamp(effMoveRatio, 0, 1);
    this.moveBlend = THREE.MathUtils.damp(this.moveBlend, targetMoveBlend, 11.5, clampedDt);

    const gaitPhase = motion ? motion.bobPhase : this.swayPhase;
    const crouchScale = effCrouched ? 0.65 : 1.0;
    const dragStab = this.dragging ? 0.55 : 1.0;
    const bobEnv = this.moveBlend * crouchScale * dragStab * raiseT;

    // Figure-8 footstep bob (grounded & readable while walking; stronger rhythmic pump when sprinting)
    const bobAmpX = THREE.MathUtils.lerp(0.0085, 0.022, sp);
    const bobAmpY = THREE.MathUtils.lerp(0.0075, 0.019, sp);
    const bobAmpZ = THREE.MathUtils.lerp(0.0025, 0.0085, sp);
    const bobRollAmp = THREE.MathUtils.lerp(0.022, 0.068, sp);
    const bobPitchAmp = THREE.MathUtils.lerp(0.014, 0.036, sp);

    const walkSwayX = Math.sin(gaitPhase) * bobAmpX * bobEnv;
    const walkSwayY = (-Math.cos(gaitPhase * 2) * 0.5 - 0.5) * bobAmpY * bobEnv;
    const walkSwayZ = Math.sin(gaitPhase * 2) * bobAmpZ * bobEnv;
    const walkRoll = Math.sin(gaitPhase - 0.25) * bobRollAmp * bobEnv;
    const walkPitch = -Math.cos(gaitPhase * 2 - 0.35) * bobPitchAmp * bobEnv;

    // Breathing drift synced to BodycamController chest breath & exertion
    const breathX = motion ? motion.breathX : Math.sin(elapsed * 1.45) * 0.0022;
    const breathY = motion ? motion.breathY : Math.cos(elapsed * 2.15) * 0.0018;
    const breathPosX = breathX * 0.48 * raiseT;
    const breathPosY = breathY * 0.52 * raiseT;
    const breathRotYaw = -breathX * 0.42 * raiseT;
    const breathRotPitch = breathY * 0.48 * raiseT;

    // Jump, step-up & landing vertical suspension heave
    const targetVert = motion ? THREE.MathUtils.clamp(motion.verticalOffset, -0.14, 0.08) : 0;
    this.vertHeave = THREE.MathUtils.damp(this.vertHeave, targetVert, 16, clampedDt);
    const heavePosY = this.vertHeave * 0.24 * raiseT;
    const heavePosZ = Math.min(0, this.vertHeave) * 0.05 * raiseT;
    const heavePitch = this.vertHeave * 0.48 * raiseT;

    // Camera-turn physical weight inertia (muted during LMB map drag when camera stays stationary)
    // Right-handed Y-up camera: turning right => turnVelYaw < 0 => lookLagYaw > 0 => tablet trails LEFT (-X, +rotY, +rotZ)
    // Pitching up => turnVelPitch > 0 => lookLagPitch < 0 => tablet trails DOWN (-Y, -rotX)
    const targetLagYaw =
      motion && !this.dragging
        ? THREE.MathUtils.clamp(-motion.turnVelYaw * 0.026, -0.11, 0.11)
        : 0;
    const targetLagPitch =
      motion && !this.dragging
        ? THREE.MathUtils.clamp(-motion.turnVelPitch * 0.022, -0.09, 0.09)
        : 0;
    this.lookLagYaw = THREE.MathUtils.damp(this.lookLagYaw, targetLagYaw, 11.5, clampedDt);
    this.lookLagPitch = THREE.MathUtils.damp(this.lookLagPitch, targetLagPitch, 11.5, clampedDt);
    const lagPosX = -this.lookLagYaw * 0.15 * raiseT;
    const lagPosY = this.lookLagPitch * 0.12 * raiseT;
    const lagRotYaw = this.lookLagYaw * 0.85 * raiseT;
    const lagRotPitch = this.lookLagPitch * 0.72 * raiseT;
    const lagRotRoll = this.lookLagYaw * 0.52 * raiseT;

    // Lateral strafe inertia & Q/E lean tilt
    const targetStrafe = motion ? THREE.MathUtils.clamp(motion.localStrafeVel / 4.5, -1, 1) : 0;
    this.strafeInertia = THREE.MathUtils.damp(this.strafeInertia, targetStrafe, 10.5, clampedDt);
    const strafePosX = -this.strafeInertia * 0.010 * raiseT;
    const strafeRotYaw = -this.strafeInertia * 0.010 * raiseT;
    const strafeRotRoll = -this.strafeInertia * 0.044 * raiseT;

    const targetLean = motion ? THREE.MathUtils.clamp(motion.leanMeters / 0.35, -1, 1) : 0;
    this.leanTilt = THREE.MathUtils.damp(this.leanTilt, targetLean, 11, clampedDt);
    const leanPosX = this.leanTilt * 0.008 * raiseT;
    const leanRotRoll = -this.leanTilt * 0.068 * raiseT;

    // Lowered athletic carry offset during sprint (opens top sightline while pumping with stride)
    const sprintDropX = sp * 0.012 * raiseT;
    const sprintDropY = -sp * 0.052 * raiseT;
    const sprintDropZ = -sp * 0.018 * raiseT;
    const sprintPitch = -sp * 0.14 * raiseT;
    const sprintRoll = -sp * 0.06 * raiseT;

    const crouchY = effCrouched ? -0.009 : 0;

    // Base draw -> inspection bring-closer curve
    const baseX = THREE.MathUtils.lerp(-0.14, 0.004, raiseT);
    const baseY = THREE.MathUtils.lerp(-0.34, THREE.MathUtils.lerp(-0.105, -0.044, bringCloserT), raiseT);
    const baseZ = THREE.MathUtils.lerp(-0.33, THREE.MathUtils.lerp(-0.305, -0.238, bringCloserT), raiseT);

    // Subtle thumbstick micro-tilt so device feels physically held without inducing IK feedback lag
    const joyDevicePitch = this.joyTiltY * 0.014;
    const joyDeviceYaw = -this.joyTiltX * 0.016;

    this.deviceGroup.position.set(
      baseX +
        walkSwayX +
        breathPosX +
        lagPosX +
        strafePosX +
        leanPosX +
        sprintDropX +
        this.joyTiltX * 0.002,
      baseY +
        walkSwayY +
        breathPosY +
        heavePosY +
        lagPosY +
        sprintDropY +
        crouchY -
        this.joyTiltY * 0.0015,
      baseZ + walkSwayZ + heavePosZ + sprintDropZ,
    );

    this.deviceGroup.rotation.set(
      THREE.MathUtils.lerp(0.65, THREE.MathUtils.lerp(-0.24, -0.15, bringCloserT), raiseT) +
        this.tiltImpulseX +
        joyDevicePitch +
        walkPitch +
        breathRotPitch +
        heavePitch +
        lagRotPitch +
        sprintPitch,
      THREE.MathUtils.lerp(0.45, -0.025, raiseT) +
        joyDeviceYaw +
        breathRotYaw +
        lagRotYaw +
        strafeRotYaw,
      THREE.MathUtils.lerp(-0.32, 0.015, raiseT) +
        this.tiltImpulseZ +
        walkRoll +
        lagRotRoll +
        strafeRotRoll +
        leanRotRoll +
        sprintRoll,
      'YXZ',
    );

    // Apply thumb-driven gimbal rotation + depress power switch
    this.joystickPivot.rotation.set(
      -this.joyTiltY * JOY_MAX_TILT_RAD,
      this.joyTiltX * JOY_MAX_TILT_RAD,
      0,
      'YXZ',
    );
    const pressDepth = this.getPowerPressWeight();
    this.powerBtnMesh.position.z = 0.0092 - pressDepth * 0.0024;
    this.powerBtnMat.emissiveIntensity = this.screenOn ? 0.95 : 0.28 + pressDepth * 0.5;

    // LEDs & Backlit OLED Screen emissive state
    if (this.screenOn) {
      const pulse = 0.7 + 0.3 * Math.sin(elapsed * 4.2);
      this.ledTopMat.emissiveIntensity = 1.65;
      this.ledMidMat.emissiveIntensity = 0.35 + pulse * 0.45;
      this.ledBotMat.emissiveIntensity = 1.45;
    } else {
      this.ledTopMat.emissiveIntensity = 0.04;
      this.ledMidMat.emissiveIntensity = 0.04;
      this.ledBotMat.emissiveIntensity = 0.04;
    }

    this.deviceGroup.updateMatrixWorld(true);

    // Split-rate OLED rendering:
    //  - Underlying sector/battery/map telemetry cache redraws strictly throttled to <= 10 Hz (0.10s)
    //  - Interactive reticle, Danger Close 45m ring & Fire Support HUD composite at 60+ FPS (0.016s)
    //    when on Fire Support tab or actively dragging/zooming, and ~16 Hz idle on Tac-Map.
    this.telemetryRedrawAccum += clampedDt;
    this.redrawAccum += clampedDt;

    const highRateInteractive =
      this.screenOn && (this.activeTab === 'fire_support' || this.dragging || this.bootTimer < 0.28);
    const overlayInterval = highRateInteractive ? 0.0155 : 0.062;

    const shouldRefreshTelemetry =
      this.screenOn &&
      (this.telemetryCacheDirty || this.telemetryRedrawAccum >= 0.1);
    if (shouldRefreshTelemetry) {
      this.telemetryRedrawAccum = 0;
      this.telemetryCacheDirty = false;
      this.drawTelemetryBaseLayer(elapsed);
      this.telemetryRedrawCount++;
      this.screenDirty = true;
    }

    if (this.screenDirty || (this.screenOn && this.redrawAccum >= overlayInterval)) {
      this.redrawAccum = 0;
      this.screenDirty = false;
      this.drawScreenCanvas(elapsed);
      this.overlayRedrawCount++;
      this.screenTexture.needsUpdate = true;
    }
  }

  /** World-space target for Left Hand holding the PDA side grip. */
  public getLeftGripWorldTransform(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    this.leftGripSocket.getWorldPosition(outPos);
    this.leftGripSocket.getWorldQuaternion(outQuat);
  }

  /** World-space target for Right Hand holding the PDA side grip (shifts up in device-local space when pressing Power). */
  public getRightGripWorldTransform(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    const pressW = this.getPowerPressWeight();
    outPos.copy(this.rightGripSocket.position);
    if (pressW > 0.005) {
      outPos.x -= pressW * 0.006;
      outPos.y += pressW * 0.040;
    }
    this.deviceGroup.localToWorld(outPos);
    this.rightGripSocket.getWorldQuaternion(outQuat);
  }

  /**
   * Post-IK reach guard: applies a single-frame world-space residual correction (converted into
   * root-local space) if extreme pitch/lean ever clamps arm IK reach, ensuring the tablet never
   * visually detaches from the solved palms. Zero drift accumulation because update() resets position.
   */
  public applyPostIkWorldOffset(deltaWorld: Readonly<THREE.Vector3>): void {
    const lenSq = deltaWorld.lengthSq();
    if (lenSq < 1e-10) return;
    this.root.updateMatrixWorld(true);
    this._invRootMat.copy(this.root.matrixWorld).invert();
    this._postIkDeltaLocal.copy(deltaWorld).transformDirection(this._invRootMat);
    const mag = Math.sqrt(lenSq);
    this._postIkDeltaLocal.multiplyScalar(mag);
    this.deviceGroup.position.add(this._postIkDeltaLocal);
    this.deviceGroup.updateMatrixWorld(true);
  }

  /** World-space right thumb fingertip target (physical 3D joystick cap contact vs red power button). */
  public getRightThumbWorldTarget(outPos: THREE.Vector3): void {
    const pW = this.getPowerPressWeight();
    outPos.set(
      JOY_PIVOT_X + this.thumbIntentX * JOY_TRAVEL_M,
      JOY_PIVOT_Y + this.thumbIntentY * JOY_TRAVEL_M,
      JOY_CAP_Z,
    );
    if (pW > 0.005) {
      this._tmpPos.set(POWER_BTN_X, POWER_BTN_Y, POWER_BTN_Z - pW * 0.0022);
      outPos.lerp(this._tmpPos, pW);
    }
    this.deviceGroup.localToWorld(outPos);
  }

  private worldToMapUV(x: number, z: number): { u: number; v: number } {
    const b = this.mapAspectBounds;
    const spanX = Math.max(1, b.maxX - b.minX);
    const spanZ = Math.max(1, b.maxZ - b.minZ);
    return {
      u: (x - b.minX) / spanX,
      v: (z - b.minZ) / spanZ,
    };
  }

  /**
   * 10 Hz cached telemetry layer: draws top telemetry bar, orthographic satellite map, contours,
   * sectors, vehicles, grid, convoys, pings, allies, mortar battery icons, HQ 65m no-fire zones,
   * comms blackout zones, local operator arrow, and bottom status strip onto `telemetryCacheCanvas`.
   */
  private drawTelemetryBaseLayer(elapsed: number): void {
    const ctx = this.telemetryCacheCtx;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

    // 1. Base OS Background
    ctx.fillStyle = '#091114';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // === 2. TOP TELEMETRY & COMPASS BAR (y: 0..64) ===
    const topBarH = 64;
    ctx.fillStyle = '#0e171b';
    ctx.fillRect(0, 0, SCREEN_W, topBarH);
    ctx.strokeStyle = '#253941';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, topBarH);
    ctx.lineTo(SCREEN_W, topBarH);
    ctx.stroke();

    // Left: Tactical Clock + Weather + Wind Speed
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 28px monospace';
    ctx.fillText(this.telemetry.gameClockText || '12:00', 18, 34);

    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(
      `${(this.telemetry.weatherLabel || 'CLEAR').toUpperCase()} · ${this.telemetry.windSpeedMps.toFixed(1)} m/s`,
      18,
      54,
    );

    // Center: Scrolling Magnetic Compass Tape
    const compCx = SCREEN_W * 0.52;
    const compW = 360;
    const headingRad = -this.telemetry.playerYawRad;
    let headingDeg = (THREE.MathUtils.radToDeg(headingRad) % 360 + 360) % 360;
    if (headingDeg >= 360) headingDeg -= 360;

    ctx.save();
    ctx.beginPath();
    ctx.rect(compCx - compW * 0.5, 4, compW, topBarH - 8);
    ctx.clip();

    ctx.fillStyle = '#081013';
    ctx.fillRect(compCx - compW * 0.5, 4, compW, topBarH - 8);
    const pxPerDeg = 3.2;

    for (let d = -60; d <= 60; d += 15) {
      const snappedDeg = Math.round((headingDeg + d) / 15) * 15;
      const diff = snappedDeg - headingDeg;
      const x = compCx + diff * pxPerDeg;
      const normDeg = ((snappedDeg % 360) + 360) % 360;
      const match = COMPASS_LABELS.find((c) => c.deg === normDeg);
      ctx.strokeStyle = match?.major ? '#e2e8f0' : '#475569';
      ctx.beginPath();
      ctx.moveTo(x, 38);
      ctx.lineTo(x, match ? 48 : 44);
      ctx.stroke();
      if (match) {
        ctx.textAlign = 'center';
        ctx.fillStyle = normDeg === 0 ? '#f59e0b' : match.major ? '#f8fafc' : '#94a3b8';
        ctx.font = match.major ? 'bold 17px monospace' : '14px monospace';
        ctx.fillText(match.label, x, 31);
      }
    }
    ctx.restore();

    // Center Heading Index Needle & Numeric Bearing
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(compCx, 6);
    ctx.lineTo(compCx - 6, 14);
    ctx.lineTo(compCx + 6, 14);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(headingDeg).toString().padStart(3, '0')}°`, compCx, 58);

    // Right: Zone Label, Zoom & Corner Battery Widget
    const effBattery = Math.round(
      typeof this.telemetry.batteryPct === 'number' ? this.telemetry.batteryPct : this.batteryPct,
    );
    const lowBatt = effBattery < 20;
    const battCol = lowBatt ? (Math.sin(elapsed * 7) > 0 ? '#f59e0b' : '#ef4444') : '#34d399';

    ctx.textAlign = 'right';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(this.telemetry.zoneLabel || this.telemetry.modeLabel || 'AO TAC-MAP', SCREEN_W - 140, 27);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '13px monospace';
    ctx.fillText(`ZOOM ${this.mapZoom.toFixed(1)}x`, SCREEN_W - 140, 48);

    // Corner Battery Indicator
    const bx = SCREEN_W - 122;
    const by = 14;
    const bw = 46;
    const bh = 18;
    ctx.strokeStyle = battCol;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = battCol;
    ctx.fillRect(bx + bw, by + 5, 4, bh - 10);
    const filledCells = Math.ceil((effBattery / 100) * 4);
    for (let c = 0; c < 4; c++) {
      if (c < filledCells) {
        ctx.fillStyle = battCol;
        ctx.fillRect(bx + 3 + c * 10.2, by + 3, 8, bh - 6);
      }
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = lowBatt ? '#fbbf24' : '#cbd5e1';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(lowBatt ? `LOW ${effBattery}%` : `${effBattery}%`, bx + bw * 0.5 + 2, 50);

    // Wind direction dial
    const vaneCx = SCREEN_W - 34;
    const vaneCy = 32;
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(vaneCx, vaneCy, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(vaneCx, vaneCy);
    ctx.rotate(this.telemetry.windAngleRad);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 11);
    ctx.lineTo(0, -11);
    ctx.moveTo(-5, -5);
    ctx.lineTo(0, -11);
    ctx.lineTo(5, -5);
    ctx.stroke();
    ctx.restore();

    // === 3. MAIN TACTICAL MAP VIEWPORT (y: 64..604) ===
    const mapTop = topBarH;
    const mapBot = SCREEN_H - 36;
    const mapH = mapBot - mapTop;
    const mapW = SCREEN_W;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mapTop, mapW, mapH);
    ctx.clip();

    const pUV = this.worldToMapUV(this.telemetry.playerX, this.telemetry.playerZ);
    const centerU = this.centerOnPlayer
      ? THREE.MathUtils.clamp(pUV.u, 0.02, 0.98)
      : THREE.MathUtils.clamp(this.panCenterU, 0.02, 0.98);
    const centerV = this.centerOnPlayer
      ? THREE.MathUtils.clamp(pUV.v, 0.02, 0.98)
      : THREE.MathUtils.clamp(this.panCenterV, 0.02, 0.98);

    const drawSize = Math.min(mapW, mapH) * 1.15 * this.mapZoom;
    this.cachedCenterU = centerU;
    this.cachedCenterV = centerV;
    this.cachedDrawSize = drawSize;

    const imgLeft = mapW * 0.5 - centerU * drawSize;
    const imgTop = mapTop + mapH * 0.5 - centerV * drawSize;
    const worldSpanX = Math.max(1, this.mapAspectBounds.maxX - this.mapAspectBounds.minX);

    const uvToScreen = (u: number, v: number): { sx: number; sy: number } => ({
      sx: imgLeft + u * drawSize,
      sy: imgTop + v * drawSize,
    });

    if (this.mapCacheCanvas) {
      ctx.drawImage(this.mapCacheCanvas, imgLeft, imgTop, drawSize, drawSize);
    } else {
      ctx.fillStyle = '#0f1b1f';
      ctx.fillRect(0, mapTop, mapW, mapH);
    }

    if (this.contourCacheCanvas) {
      ctx.drawImage(this.contourCacheCanvas, imgLeft, imgTop, drawSize, drawSize);
    }

    // Sector Border Polygons & Live Contest Progress Rings
    if (this.telemetry.sectors && this.telemetry.sectors.length > 0) {
      for (const sec of this.telemetry.sectors) {
        const uv = this.worldToMapUV(sec.x, sec.z);
        const pt = uvToScreen(uv.u, uv.v);
        const radPx = Math.max(22, (sec.radiusM / worldSpanX) * drawSize);
        const ownerColor =
          sec.owner === 'pmc_alpha'
            ? '#38bdf8'
            : sec.owner === 'pmc_bravo'
              ? '#f43f5e'
              : sec.owner === 'subfaction'
                ? '#f59e0b'
                : sec.owner === 'contested'
                  ? '#fb923c'
                  : '#94a3b8';
        const ownerFill =
          sec.owner === 'pmc_alpha'
            ? 'rgba(56, 189, 248, 0.08)'
            : sec.owner === 'pmc_bravo'
              ? 'rgba(244, 63, 94, 0.08)'
              : sec.owner === 'subfaction'
                ? 'rgba(245, 158, 11, 0.08)'
                : sec.owner === 'contested'
                  ? 'rgba(251, 146, 60, 0.14)'
                  : 'rgba(148, 163, 184, 0.05)';

        ctx.beginPath();
        if (sec.polygon && sec.polygon.length >= 3) {
          for (let k = 0; k < sec.polygon.length; k++) {
            const puv = this.worldToMapUV(sec.polygon[k][0], sec.polygon[k][1]);
            const spt = uvToScreen(puv.u, puv.v);
            if (k === 0) ctx.moveTo(spt.sx, spt.sy);
            else ctx.lineTo(spt.sx, spt.sy);
          }
          ctx.closePath();
        } else {
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2 + Math.PI / 6;
            const hx = pt.sx + Math.cos(ang) * radPx;
            const hy = pt.sy + Math.sin(ang) * radPx;
            if (k === 0) ctx.moveTo(hx, hy);
            else ctx.lineTo(hx, hy);
          }
          ctx.closePath();
        }
        ctx.fillStyle = ownerFill;
        ctx.fill();
        ctx.strokeStyle = ownerColor;
        ctx.lineWidth = sec.owner === 'contested' ? 2.2 : 1.5;
        ctx.setLineDash(sec.owner === 'contested' ? [7, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);

        const absProg = THREE.MathUtils.clamp(Math.abs(sec.captureProgress) / 100, 0, 1);
        const isContestedRing =
          sec.owner === 'contested' || (absProg > 0.02 && absProg < 0.99);
        if (isContestedRing) {
          const ringR = Math.max(14, radPx * 0.44);
          ctx.strokeStyle = 'rgba(15, 23, 42, 0.72)';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(pt.sx, pt.sy, ringR, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = sec.captureProgress >= 0 ? '#38bdf8' : '#f43f5e';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.arc(pt.sx, pt.sy, ringR, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * absProg);
          ctx.stroke();
        }

        ctx.fillStyle = ownerColor;
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(sec.code.toUpperCase(), pt.sx, pt.sy - 3);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.8)';
        ctx.font = '10px monospace';
        ctx.fillText(sec.name.slice(0, 14).toUpperCase(), pt.sx, pt.sy + 10);
      }
      ctx.textAlign = 'left';
    }

    // Conquest 65m HQ No-Fire Exclusion Cylinders (drawn clearly in Fire Support tab)
    const fs = this.telemetry.fireSupport;
    if (fs?.enabled && this.activeTab === 'fire_support' && fs.hqExclusions.length > 0) {
      for (const hq of fs.hqExclusions) {
        const uv = this.worldToMapUV(hq.x, hq.z);
        const pt = uvToScreen(uv.u, uv.v);
        const radPx = Math.max(18, (hq.radiusM / worldSpanX) * drawSize);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, radPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(248, 113, 113, 0.65)';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, radPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fca5a5';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(hq.friendly ? 'FRIENDLY HQ · NO-FIRE' : 'ENEMY HQ · NO-FIRE', pt.sx, pt.sy - radPx - 6);
      }
      ctx.textAlign = 'left';
    }

    // Owned / Tracked Vehicles
    if (this.telemetry.vehicles && this.telemetry.vehicles.length > 0) {
      for (const veh of this.telemetry.vehicles) {
        const uv = this.worldToMapUV(veh.x, veh.z);
        const pt = uvToScreen(uv.u, uv.v);
        const vCol = veh.owned ? '#34d399' : '#94a3b8';
        ctx.save();
        ctx.translate(pt.sx, pt.sy);
        ctx.fillStyle = vCol;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2;
        if (veh.kind === 'air') {
          ctx.beginPath();
          ctx.moveTo(0, -8);
          ctx.lineTo(8, 0);
          ctx.lineTo(0, 8);
          ctx.lineTo(-8, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(-7, -5, 14, 10);
          ctx.strokeRect(-7, -5, 14, 10);
        }
        ctx.restore();
        ctx.fillStyle = vCol;
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(veh.label.slice(0, 14).toUpperCase(), pt.sx + 10, pt.sy + 4);
      }
    }

    // Tactical grid overlay (A-H / 1-8)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    const gridCount = 8;
    for (let i = 0; i <= gridCount; i++) {
      const f = i / gridCount;
      const gx = imgLeft + f * drawSize;
      const gy = imgTop + f * drawSize;
      ctx.beginPath();
      ctx.moveTo(gx, mapTop);
      ctx.lineTo(gx, mapBot);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(mapW, gy);
      ctx.stroke();
      if (i < gridCount) {
        ctx.fillText(String.fromCharCode(65 + i), gx + 5, mapTop + 15);
        ctx.fillText(`${i + 1}`, 8, gy + 15);
      }
    }

    // Friendly Mortar Battery Emplacement Telemetry (10 Hz layer)
    if (fs?.enabled && fs.pits.length > 0) {
      for (const pit of fs.pits) {
        if (pit.status === 'INACTIVE' || !pit.friendly) continue;
        const uv = this.worldToMapUV(pit.x, pit.z);
        const pt = uvToScreen(uv.u, uv.v);
        const col =
          pit.status === 'FIRE_MISSION'
            ? '#f59e0b'
            : pit.status === 'PLAYER_MANNED'
              ? '#38bdf8'
              : pit.status === 'KIA_REINFORCING'
                ? '#ef4444'
                : '#34d399';
        // Crisp military mortar tube + baseplate icon
        ctx.save();
        ctx.translate(pt.sx, pt.sy);
        ctx.fillStyle = '#091114';
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-4, 4);
        ctx.lineTo(4, -4);
        ctx.moveTo(-3, -4);
        ctx.lineTo(4, -4);
        ctx.lineTo(4, 3);
        ctx.stroke();
        ctx.restore();

        const tag =
          pit.status === 'FIRE_MISSION'
            ? `${pit.sourceType} MTR · FIRING`
            : pit.status === 'PLAYER_MANNED'
              ? `${pit.sourceType} MTR · MANNED`
              : pit.status === 'KIA_REINFORCING'
                ? `${pit.sourceType} MTR · KIA ${Math.ceil(pit.respawnTimerSec)}s`
                : `${pit.sourceType} MTR · READY`;
        ctx.fillStyle = col;
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(tag, pt.sx, pt.sy + 21);
      }
      ctx.textAlign = 'left';
    }

    // Live Supply Convoys & Barges
    if (this.telemetry.convoys) {
      for (const cv of this.telemetry.convoys) {
        const uv = this.worldToMapUV(cv.x, cv.z);
        const pt = uvToScreen(uv.u, uv.v);
        const col = cv.disabled ? '#f59e0b' : cv.friendly ? '#38bdf8' : '#f43f5e';
        ctx.fillStyle = col;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 2;
        ctx.fillRect(pt.sx - 6, pt.sy - 4, 12, 8);
        ctx.strokeRect(pt.sx - 6, pt.sy - 4, 12, 8);
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(cv.label.slice(0, 16).toUpperCase(), pt.sx + 9, pt.sy + 4);
      }
    }

    // Active Tactical Pings
    if (this.telemetry.pings) {
      for (const ping of this.telemetry.pings) {
        const uv = this.worldToMapUV(ping.x, ping.z);
        const pt = uvToScreen(uv.u, uv.v);
        const pulseR = 10 + (Math.sin(elapsed * 5.2) * 0.5 + 0.5) * 6;
        const color =
          ping.kind === 'danger' || ping.kind === 'contact'
            ? '#ef4444'
            : ping.kind === 'poi'
              ? '#fbbf24'
              : '#38bdf8';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, pulseR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, 4.5, 0, Math.PI * 2);
        ctx.fill();
        if (ping.label) {
          ctx.font = 'bold 13px monospace';
          ctx.fillText(ping.label, pt.sx + 10, pt.sy - 8);
        }
      }
    }

    // Ally Operators
    if (this.telemetry.allies) {
      for (const ally of this.telemetry.allies) {
        if (!ally.alive) continue;
        const uv = this.worldToMapUV(ally.x, ally.z);
        const pt = uvToScreen(uv.u, uv.v);
        ctx.fillStyle = ally.isMedic ? '#34d399' : '#38bdf8';
        ctx.strokeStyle = '#082f49';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e0f2fe';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(ally.name.slice(0, 10).toUpperCase(), pt.sx, pt.sy - 11);
      }
    }

    // Regional Comms Tower Fog-of-War Static Overlays
    if (this.telemetry.commsBlackoutZones && this.telemetry.commsBlackoutZones.length > 0) {
      for (const zone of this.telemetry.commsBlackoutZones) {
        const uv = this.worldToMapUV(zone.x, zone.z);
        const pt = uvToScreen(uv.u, uv.v);
        const radPx = (zone.radiusM / worldSpanX) * drawSize;
        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, radPx, 0, Math.PI * 2);
        ctx.clip();

        ctx.fillStyle = 'rgba(8, 12, 16, 0.72)';
        ctx.fillRect(pt.sx - radPx, pt.sy - radPx, radPx * 2, radPx * 2);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
        ctx.lineWidth = 1.5;
        const scanOffset = Math.floor(elapsed * 42) % 10;
        ctx.beginPath();
        for (let sy = pt.sy - radPx + scanOffset; sy < pt.sy + radPx; sy += 10) {
          ctx.moveTo(pt.sx - radPx, sy);
          ctx.lineTo(pt.sx + radPx, sy);
        }
        ctx.stroke();
        ctx.restore();

        ctx.strokeStyle = 'rgba(248, 113, 113, 0.75)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.arc(pt.sx, pt.sy, radPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#fca5a5';
        ctx.font = 'bold 13px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`NO COMMS · ${zone.label.toUpperCase()}`, pt.sx, pt.sy - 6);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px monospace';
        ctx.fillText('CAPTURE TOWER TO RESTORE GPS', pt.sx, pt.sy + 12);
        ctx.textAlign = 'left';
      }
    }

    // Local Operator Arrow & Vision Cone
    const pScreen = uvToScreen(pUV.u, pUV.v);
    ctx.save();
    ctx.translate(pScreen.sx, pScreen.sy);
    ctx.rotate(-this.telemetry.playerYawRad);
    const coneGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 62);
    coneGrad.addColorStop(0, 'rgba(245, 158, 11, 0.34)');
    coneGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 62, -Math.PI * 0.5 - 0.45, -Math.PI * 0.5 + 0.45);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    // === 4. BOTTOM STATUS STRIP ===
    ctx.fillStyle = '#0d1519';
    ctx.fillRect(0, mapBot, SCREEN_W, SCREEN_H - mapBot);
    ctx.strokeStyle = '#253941';
    ctx.beginPath();
    ctx.moveTo(0, mapBot);
    ctx.lineTo(SCREEN_W, mapBot);
    ctx.stroke();

    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    if (this.telemetry.characterCallsign) {
      const cashStr =
        typeof this.telemetry.cashUsd === 'number'
          ? `$${this.telemetry.cashUsd.toLocaleString()}`
          : '--';
      const feeStr =
        typeof this.telemetry.respawnFeeUsd === 'number'
          ? `$${this.telemetry.respawnFeeUsd.toLocaleString()}`
          : '--';
      ctx.fillStyle = this.telemetry.bankruptcyWarning ? '#fca5a5' : '#cbd5e1';
      ctx.fillText(
        `${this.telemetry.characterCallsign.toUpperCase()} · ${this.telemetry.shardLabel ?? 'OW'} · ${this.telemetry.factionLabel ?? 'PMC'} · CASH ${cashStr} · MEDEVAC ${feeStr}`,
        16,
        SCREEN_H - 13,
      );
    } else if (fs?.enabled && this.activeTab === 'fire_support') {
      ctx.fillStyle = '#fbbf24';
      ctx.fillText(
        `LMB+DRAG AIM · WHEEL ZOOM · [SPACE] CALL 81MM MORTAR SWEEP · [TAB] TAC-MAP · [R] CENTER`,
        16,
        SCREEN_H - 13,
      );
    } else {
      const tabHint = fs?.enabled ? ' · [TAB] FIRE SUPPORT' : '';
      ctx.fillText(
        `GRID ${Math.round(this.telemetry.playerX)}E ${Math.round(-this.telemetry.playerZ)}N · LMB+DRAG PAN · WHEEL ZOOM · R CENTER${tabHint}`,
        16,
        SCREEN_H - 13,
      );
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = this.telemetry.bankruptcyWarning
      ? '#f87171'
      : this.activeTab === 'fire_support'
        ? '#f59e0b'
        : this.centerOnPlayer
          ? '#10b981'
          : '#38bdf8';
    ctx.fillText(
      this.telemetry.bankruptcyWarning
        ? 'MEDEVAC UNFUNDED'
        : this.activeTab === 'fire_support'
          ? 'FIRE SUPPORT'
          : this.centerOnPlayer
            ? 'GPS LOCKED'
            : 'FREE PAN',
      SCREEN_W - 16,
      SCREEN_H - 13,
    );
  }

  /**
   * 60+ FPS interactive composite pass: blits the 10 Hz `telemetryCacheCanvas` with smooth pan/zoom
   * interpolation and draws the live targeting reticle, 45m Danger Close ring, active mortar mission
   * impact rings, tab strip, Fire Support command card, and seated mortar firing table on top.
   */
  private drawScreenCanvas(elapsed: number): void {
    const ctx = this.screenCtx;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

    if (!this.screenOn) {
      const offGrad = ctx.createLinearGradient(0, 0, SCREEN_W, SCREEN_H);
      offGrad.addColorStop(0, '#0c1012');
      offGrad.addColorStop(0.5, '#12181a');
      offGrad.addColorStop(1, '#080b0c');
      ctx.fillStyle = offGrad;
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      if (this.isBatteryDepleted()) {
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
        ctx.lineWidth = 3;
        ctx.strokeRect(SCREEN_W * 0.5 - 46, SCREEN_H * 0.5 - 52, 86, 40);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.55)';
        ctx.fillRect(SCREEN_W * 0.5 + 40, SCREEN_H * 0.5 - 42, 8, 20);
        ctx.fillStyle = 'rgba(248, 113, 113, 0.78)';
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('BATTERY DEPLETED · 0%', SCREEN_W * 0.5, SCREEN_H * 0.5 + 24);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
        ctx.font = 'bold 14px monospace';
        ctx.fillText('SWAP CR123A CELL IN INVENTORY [TAB]', SCREEN_W * 0.5, SCREEN_H * 0.5 + 50);
      } else {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('AXON TACTICAL PDA · STANDBY', SCREEN_W * 0.5, SCREEN_H * 0.5);
      }
      return;
    }

    const bootProgress = THREE.MathUtils.clamp(this.bootTimer / 0.26, 0, 1);
    const topBarH = 64;
    const mapTop = topBarH;
    const mapBot = SCREEN_H - 36;
    const mapH = mapBot - mapTop;
    const mapW = SCREEN_W;

    // 1. Blit cached 10 Hz map region with smooth 60 FPS pan/zoom interpolation between 10 Hz rebakes
    const pUV = this.worldToMapUV(this.telemetry.playerX, this.telemetry.playerZ);
    const centerU = this.centerOnPlayer
      ? THREE.MathUtils.clamp(pUV.u, 0.02, 0.98)
      : THREE.MathUtils.clamp(this.panCenterU, 0.02, 0.98);
    const centerV = this.centerOnPlayer
      ? THREE.MathUtils.clamp(pUV.v, 0.02, 0.98)
      : THREE.MathUtils.clamp(this.panCenterV, 0.02, 0.98);
    const drawSize = Math.min(mapW, mapH) * 1.15 * this.mapZoom;
    const imgLeft = mapW * 0.5 - centerU * drawSize;
    const imgTop = mapTop + mapH * 0.5 - centerV * drawSize;
    const worldSpanX = Math.max(1, this.mapAspectBounds.maxX - this.mapAspectBounds.minX);

    const uvToScreen = (u: number, v: number): { sx: number; sy: number } => ({
      sx: imgLeft + u * drawSize,
      sy: imgTop + v * drawSize,
    });

    ctx.fillStyle = '#091114';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

    // Map viewport blit (interpolated cleanly during live drag/zoom)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, mapTop, mapW, mapH);
    ctx.clip();

    const scaleRatio = drawSize / Math.max(1, this.cachedDrawSize);
    const shiftX = (this.cachedCenterU - centerU) * drawSize;
    const shiftY = (this.cachedCenterV - centerV) * drawSize;
    const mapCenterX = mapW * 0.5;
    const mapCenterY = mapTop + mapH * 0.5;
    if (Math.abs(scaleRatio - 1) < 0.0005 && Math.abs(shiftX) < 0.25 && Math.abs(shiftY) < 0.25) {
      ctx.drawImage(this.telemetryCacheCanvas, 0, mapTop, mapW, mapH, 0, mapTop, mapW, mapH);
    } else {
      ctx.save();
      ctx.translate(mapCenterX + shiftX, mapCenterY + shiftY);
      ctx.scale(scaleRatio, scaleRatio);
      ctx.drawImage(
        this.telemetryCacheCanvas,
        0,
        mapTop,
        mapW,
        mapH,
        -mapW * 0.5,
        -mapH * 0.5,
        mapW,
        mapH,
      );
      ctx.restore();
    }

    // === 60+ FPS INTERACTIVE RETICLE, ACTIVE MORTAR MISSIONS & 45M DANGER CLOSE RING ===
    const fs = this.telemetry.fireSupport;
    if (fs?.enabled && fs.activeMissions.length > 0) {
      const cepPx = Math.max(12, (18 / worldSpanX) * drawSize);
      const pulse = 0.55 + 0.45 * Math.sin(elapsed * 8.5);
      for (const m of fs.activeMissions) {
        if (!m.friendly) continue;
        const mUV = this.worldToMapUV(m.targetX, m.targetZ);
        const mPt = uvToScreen(mUV.u, mUV.v);
        ctx.fillStyle = `rgba(245, 158, 11, ${0.10 + pulse * 0.08})`;
        ctx.beginPath();
        ctx.arc(mPt.sx, mPt.sy, cepPx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.arc(mPt.sx, mPt.sy, cepPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#fde68a';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(
          `81MM SWEEP · ${m.roundsRemaining}/${m.totalRounds} RDS`,
          mPt.sx,
          mPt.sy - cepPx - 7,
        );
      }
      ctx.textAlign = 'left';
    }

    // Interactive Fire Support Target Reticle + 45m Danger Close Ring (60+ FPS)
    if (fs?.enabled && this.activeTab === 'fire_support') {
      const rCx = mapW * 0.5 + this.joyTiltX * 14;
      const rCy = mapTop + mapH * 0.5 - this.joyTiltY * 14;
      const dangerClosePx = Math.max(24, (45 / worldSpanX) * drawSize);
      const cepPx = Math.max(10, (18 / worldSpanX) * drawSize);
      const warnPulse = 0.5 + 0.5 * Math.sin(elapsed * 9.0);

      // 45m Danger Close radius ring
      if (fs.reticleInHqExclusion) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
        ctx.beginPath();
        ctx.arc(rCx, rCy, dangerClosePx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.4;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.arc(rCx, rCy, dangerClosePx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (fs.reticleDangerClose) {
        ctx.fillStyle = `rgba(245, 158, 11, ${0.11 + warnPulse * 0.10})`;
        ctx.beginPath();
        ctx.arc(rCx, rCy, dangerClosePx, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = warnPulse > 0.5 ? '#ef4444' : '#f59e0b';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([9, 5]);
        ctx.beginPath();
        ctx.arc(rCx, rCy, dangerClosePx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = fs.canCallMortarSweep
          ? 'rgba(56, 189, 248, 0.35)'
          : 'rgba(148, 163, 184, 0.30)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 6]);
        ctx.beginPath();
        ctx.arc(rCx, rCy, dangerClosePx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Inner 18m CEP dispersal circle
      const reticleCol = fs.reticleInHqExclusion || !fs.reticleInRange
        ? '#f87171'
        : fs.reticleDangerClose
          ? '#f59e0b'
          : fs.canCallMortarSweep
            ? '#34d399'
            : '#94a3b8';
      ctx.strokeStyle = reticleCol;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(rCx, rCy, cepPx, 0, Math.PI * 2);
      ctx.stroke();

      // Precision crosshair ticks
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rCx - cepPx - 10, rCy);
      ctx.lineTo(rCx - 5, rCy);
      ctx.moveTo(rCx + 5, rCy);
      ctx.lineTo(rCx + cepPx + 10, rCy);
      ctx.moveTo(rCx, rCy - cepPx - 10);
      ctx.lineTo(rCx, rCy - 5);
      ctx.moveTo(rCx, rCy + 5);
      ctx.lineTo(rCx, rCy + cepPx + 10);
      ctx.stroke();

      // Diegetic reticle ring tag (Danger Close / HQ No-Fire / 45m clearance)
      ctx.textAlign = 'center';
      ctx.font = 'bold 12px monospace';
      if (fs.reticleInHqExclusion) {
        ctx.fillStyle = '#fca5a5';
        ctx.fillText('HQ 65M NO-FIRE ZONE', rCx, rCy - dangerClosePx - 8);
      } else if (fs.reticleDangerClose) {
        ctx.fillStyle = warnPulse > 0.5 ? '#fca5a5' : '#fcd34d';
        ctx.fillText(
          `! DANGER CLOSE · FRIENDLY ${Math.round(fs.reticleMinFriendlyDistM)}M`,
          rCx,
          rCy - dangerClosePx - 8,
        );
      } else if (!fs.reticleInRange) {
        ctx.fillStyle = '#fca5a5';
        ctx.fillText('OUT OF 81MM RANGE', rCx, rCy - dangerClosePx - 8);
      } else {
        ctx.fillStyle = '#a7f3d0';
        ctx.fillText('18M CEP · 45M CLEARANCE', rCx, rCy - dangerClosePx - 8);
      }
      ctx.textAlign = 'left';
    } else if (!this.centerOnPlayer) {
      // Standard TAC-MAP free-pan reticle
      const rCx = mapW * 0.5 + this.joyTiltX * 14;
      const rCy = mapTop + mapH * 0.5 - this.joyTiltY * 14;
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rCx - 12, rCy);
      ctx.lineTo(rCx - 4, rCy);
      ctx.moveTo(rCx + 4, rCy);
      ctx.lineTo(rCx + 12, rCy);
      ctx.moveTo(rCx, rCy - 12);
      ctx.lineTo(rCx, rCy - 4);
      ctx.moveTo(rCx, rCy + 4);
      ctx.lineTo(rCx, rCy + 12);
      ctx.stroke();
    }

    // 81mm Mortar Gun-Target Line & Target Crosshair when seated in a mortar
    const mt = this.telemetry.mortarTable;
    if (mt) {
      const pitUV = this.worldToMapUV(mt.pitX, mt.pitZ);
      const tgtUV = this.worldToMapUV(mt.targetX, mt.targetZ);
      const pitPt = uvToScreen(pitUV.u, pitUV.v);
      const tgtPt = uvToScreen(tgtUV.u, tgtUV.v);

      ctx.strokeStyle = mt.inRange ? 'rgba(245, 158, 11, 0.85)' : 'rgba(248, 113, 113, 0.78)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(pitPt.sx, pitPt.sy);
      ctx.lineTo(tgtPt.sx, tgtPt.sy);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = mt.inRange ? '#fbbf24' : '#f87171';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tgtPt.sx, tgtPt.sy, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tgtPt.sx - 16, tgtPt.sy);
      ctx.lineTo(tgtPt.sx - 6, tgtPt.sy);
      ctx.moveTo(tgtPt.sx + 6, tgtPt.sy);
      ctx.lineTo(tgtPt.sx + 16, tgtPt.sy);
      ctx.moveTo(tgtPt.sx, tgtPt.sy - 16);
      ctx.lineTo(tgtPt.sx, tgtPt.sy - 6);
      ctx.moveTo(tgtPt.sx, tgtPt.sy + 6);
      ctx.lineTo(tgtPt.sx, tgtPt.sy + 16);
      ctx.stroke();
    }

    ctx.restore();

    // 2. Blit crisp cached top bar & bottom status strip directly from 10 Hz cache
    ctx.drawImage(this.telemetryCacheCanvas, 0, 0, SCREEN_W, topBarH, 0, 0, SCREEN_W, topBarH);
    ctx.drawImage(
      this.telemetryCacheCanvas,
      0,
      mapBot,
      SCREEN_W,
      SCREEN_H - mapBot,
      0,
      mapBot,
      SCREEN_W,
      SCREEN_H - mapBot,
    );

    // 3. Conquest Tab Header Strip (Top-Left below top bar when Fire Support enabled)
    if (fs?.enabled) {
      const tabX = 14;
      const tabY = mapTop + 12;
      const tabW = 136;
      const tabH = 30;
      const isFs = this.activeTab === 'fire_support';

      // Tab 1: TAC-MAP
      ctx.fillStyle = !isFs ? 'rgba(14, 23, 27, 0.95)' : 'rgba(9, 17, 20, 0.78)';
      ctx.fillRect(tabX, tabY, tabW, tabH);
      ctx.strokeStyle = !isFs ? '#38bdf8' : '#334155';
      ctx.lineWidth = !isFs ? 2 : 1;
      ctx.strokeRect(tabX, tabY, tabW, tabH);
      ctx.fillStyle = !isFs ? '#f8fafc' : '#94a3b8';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('TAC-MAP', tabX + tabW * 0.5, tabY + 19);

      // Tab 2: FIRE SUPPORT
      const tab2X = tabX + tabW + 6;
      const tab2W = 178;
      ctx.fillStyle = isFs ? 'rgba(28, 22, 12, 0.95)' : 'rgba(9, 17, 20, 0.78)';
      ctx.fillRect(tab2X, tabY, tab2W, tabH);
      ctx.strokeStyle = isFs ? '#f59e0b' : '#334155';
      ctx.lineWidth = isFs ? 2 : 1;
      ctx.strokeRect(tab2X, tabY, tab2W, tabH);
      ctx.fillStyle = isFs ? '#fbbf24' : '#94a3b8';
      ctx.fillText('[TAB] FIRE SUPPORT', tab2X + tab2W * 0.5, tabY + 19);
      ctx.textAlign = 'left';
    }

    // 4. Fire Support Command Card (Top-Right when Fire Support tab active & not seated in mortar)
    if (fs?.enabled && this.activeTab === 'fire_support' && !mt) {
      const cardW = 326;
      const cardH = fs.reticleDangerClose ? 228 : 202;
      const cardX = SCREEN_W - cardW - 14;
      const cardY = mapTop + 12;

      ctx.fillStyle = 'rgba(10, 16, 20, 0.94)';
      ctx.fillRect(cardX, cardY, cardW, cardH);
      ctx.strokeStyle = fs.reticleDangerClose
        ? '#f59e0b'
        : fs.canCallMortarSweep
          ? '#34d399'
          : '#475569';
      ctx.lineWidth = 2;
      ctx.strokeRect(cardX, cardY, cardW, cardH);

      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('CONQUEST FIRE SUPPORT', cardX + 12, cardY + 22);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 13px monospace';
      ctx.fillText('81MM MORTAR SWEEP · 5 RDS · 18M CEP', cardX + 12, cardY + 44);

      ctx.fillStyle = fs.availableAiBatteries > 0 ? '#34d399' : '#f87171';
      ctx.font = '12px monospace';
      ctx.fillText(
        `AI BATTERIES READY: ${fs.availableAiBatteries}/${fs.totalFriendlyBatteries} · CADENCE 1.4S`,
        cardX + 12,
        cardY + 64,
      );

      // Cooldown / Active Mission Status Bar
      const barX = cardX + 12;
      const barY = cardY + 76;
      const barW = cardW - 24;
      const barH = 14;
      ctx.fillStyle = '#132026';
      ctx.fillRect(barX, barY, barW, barH);
      const cdFrac = THREE.MathUtils.clamp(
        1 - fs.mortarCooldownSec / Math.max(1, fs.mortarMaxCooldownSec),
        0,
        1,
      );
      ctx.fillStyle = fs.activeMortarMissionId
        ? '#f59e0b'
        : fs.mortarCooldownSec > 0.05
          ? '#38bdf8'
          : '#10b981';
      ctx.fillRect(barX, barY, barW * (fs.activeMortarMissionId ? 1 : cdFrac), barH);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.strokeRect(barX, barY, barW, barH);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 12px monospace';
      const statusText = fs.activeMortarMissionId
        ? 'FIRE MISSION IN PROGRESS — ROUNDS OUT'
        : fs.mortarCooldownSec > 0.05
          ? `COOLDOWN: ${Math.ceil(fs.mortarCooldownSec)}S / ${Math.round(fs.mortarMaxCooldownSec)}S`
          : 'BATTERY READY — STANDING BY';
      ctx.fillText(statusText, cardX + 12, cardY + 108);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px monospace';
      ctx.fillText(
        `TGT GRID ${Math.round(fs.reticleX)}E ${Math.round(-fs.reticleZ)}N · 65M HQ SAFE`,
        cardX + 12,
        cardY + 128,
      );

      let nextY = cardY + 144;
      if (fs.reticleDangerClose) {
        ctx.fillStyle = 'rgba(180, 83, 9, 0.35)';
        ctx.fillRect(cardX + 10, nextY - 6, cardW - 20, 24);
        ctx.strokeStyle = '#f59e0b';
        ctx.strokeRect(cardX + 10, nextY - 6, cardW - 20, 24);
        ctx.fillStyle = '#fde68a';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(
          `! DANGER CLOSE (<45M): ALLY AT ${Math.round(fs.reticleMinFriendlyDistM)}M`,
          cardX + 16,
          nextY + 10,
        );
        nextY += 28;
      }

      // Action Prompt Box
      ctx.fillStyle = fs.canCallMortarSweep
        ? 'rgba(16, 185, 129, 0.22)'
        : 'rgba(127, 29, 29, 0.30)';
      ctx.fillRect(cardX + 10, nextY, cardW - 20, 28);
      ctx.strokeStyle = fs.canCallMortarSweep ? '#34d399' : '#f87171';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cardX + 10, nextY, cardW - 20, 28);
      ctx.fillStyle = fs.canCallMortarSweep ? '#ecfdf5' : '#fecaca';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(
        fs.canCallMortarSweep
          ? '[SPACE] CALL 5-RD MORTAR SWEEP'
          : (fs.blockReason ?? 'FIRE SUPPORT UNAVAILABLE').toUpperCase().slice(0, 38),
        cardX + cardW * 0.5,
        nextY + 18,
      );

      ctx.textAlign = 'left';
      ctx.fillStyle = '#64748b';
      ctx.font = '11px monospace';
      ctx.fillText('AIR STRIKE CORRIDOR · PHASE 4 STANDBY', cardX + 12, cardY + cardH - 10);
    }

    // 5. 81mm Ballistic Firing Table Card (Top-Right when seated on a mortar)
    if (mt) {
      const cardW = 310;
      const cardH = 198;
      const cardX = SCREEN_W - cardW - 14;
      const cardY = mapTop + 14;

      ctx.fillStyle = 'rgba(10, 16, 20, 0.93)';
      ctx.fillRect(cardX, cardY, cardW, cardH);
      ctx.strokeStyle = mt.inRange ? '#f59e0b' : '#f87171';
      ctx.lineWidth = 2;
      ctx.strokeRect(cardX, cardY, cardW, cardH);

      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('81MM BALLISTIC FIRING TABLE', cardX + 12, cardY + 22);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px monospace';
      ctx.fillText(
        `RNG ${Math.round(mt.targetRangeM)}m · WIND LEAD ${mt.windLeadMils >= 0 ? '+' : ''}${mt.windLeadMils} MIL`,
        cardX + 12,
        cardY + 42,
      );

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cardX + 10, cardY + 52);
      ctx.lineTo(cardX + cardW - 10, cardY + 52);
      ctx.stroke();

      if (mt.inRange && mt.recommendedCharge) {
        ctx.fillStyle = '#34d399';
        ctx.font = 'bold 16px monospace';
        ctx.fillText(
          `CHG ${mt.recommendedCharge} · DEF ${String(mt.solutionDeflectionMils).padStart(4, '0')} MIL`,
          cardX + 12,
          cardY + 76,
        );
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(
          `ELV ${String(mt.solutionElevationMils).padStart(4, '0')} MIL (${mt.solutionElevationDeg.toFixed(1)}°)`,
          cardX + 12,
          cardY + 100,
        );
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '13px monospace';
        ctx.fillText(
          `EST TOF ${mt.solutionFlightTimeSec.toFixed(1)}s`,
          cardX + 12,
          cardY + 122,
        );
      } else {
        ctx.fillStyle = '#f87171';
        ctx.font = 'bold 15px monospace';
        ctx.fillText('TARGET OUT OF 81MM ARC', cardX + 12, cardY + 86);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '12px monospace';
        ctx.fillText('PAN RETICLE 35m–700m FROM PIT', cardX + 12, cardY + 108);
      }

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.beginPath();
      ctx.moveTo(cardX + 10, cardY + 134);
      ctx.lineTo(cardX + cardW - 10, cardY + 134);
      ctx.stroke();

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '12px monospace';
      ctx.fillText(
        `TUBE: CHG ${mt.currentChargeLevel} · DEF ${String(mt.currentDeflectionMils).padStart(4, '0')} · ELV ${mt.currentElevationDeg.toFixed(1)}°`,
        cardX + 12,
        cardY + 156,
      );
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(
        `FO CORR: ADD/DRP ${mt.foAddDropM >= 0 ? '+' : ''}${mt.foAddDropM}m · L/R ${mt.foLeftRightM >= 0 ? '+' : ''}${mt.foLeftRightM}m`,
        cardX + 12,
        cardY + 176,
      );
      ctx.fillStyle = '#64748b';
      ctx.font = '11px monospace';
      ctx.fillText('PAN MAP TO COMPUTE TARGET SOLUTION', cardX + 12, cardY + 192);
    }

    // 6. Diegetic Perimeter Operations Bankruptcy Warning Banner
    if (this.telemetry.bankruptcyWarning) {
      const warnH = 44;
      ctx.fillStyle = 'rgba(127, 29, 29, 0.94)';
      ctx.fillRect(0, mapTop, SCREEN_W, warnH);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, mapTop + warnH);
      ctx.lineTo(SCREEN_W, mapTop + warnH);
      ctx.stroke();

      ctx.fillStyle = '#fef2f2';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      const msg =
        this.telemetry.bankruptcyText ||
        'BANKRUPTCY WARNING · INSUFFICIENT MEDEVAC FUNDS · DEATH WIPES CHARACTER';
      ctx.fillText(msg.slice(0, 86), SCREEN_W * 0.5, mapTop + 27);
      ctx.textAlign = 'left';
    }

    // 7. Boot scanline wipe effect
    if (bootProgress < 1) {
      ctx.fillStyle = `rgba(9, 17, 20, ${1 - bootProgress})`;
      ctx.fillRect(0, SCREEN_H * bootProgress, SCREEN_W, SCREEN_H * (1 - bootProgress));
      ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';
      ctx.fillRect(0, SCREEN_H * bootProgress - 2, SCREEN_W, 4);
    }
  }

  public dispose(): void {
    this.screenTexture.dispose();
    this.geos.forEach((g) => g.dispose());
    this.mats.forEach((m) => m.dispose());
    this.geos.length = 0;
    this.mats.length = 0;
    this.mapCacheCanvas = null;
    this.contourCacheCanvas = null;
  }
}

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
  characterCallsign?: string;
  shardLabel?: string;
  factionLabel?: string;
  cashUsd?: number;
  respawnFeeUsd?: number;
  bankruptcyWarning?: boolean;
  bankruptcyText?: string;
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

  private readonly ledTopMat: THREE.MeshStandardMaterial;
  private readonly ledMidMat: THREE.MeshStandardMaterial;
  private readonly ledBotMat: THREE.MeshStandardMaterial;
  private readonly powerBtnMat: THREE.MeshStandardMaterial;

  // Hand & thumb IK sockets (parented under deviceGroup so hands stay locked during tilt/sway)
  private readonly leftGripSocket = new THREE.Object3D();
  private readonly rightGripSocket = new THREE.Object3D();
  private readonly rightThumbJoySocket = new THREE.Object3D();
  private readonly rightThumbPowerSocket = new THREE.Object3D();

  // Cached orthographic top-down terrain/architecture image
  private mapCacheCanvas: HTMLCanvasElement | null = null;
  private mapBounds: PdaMapBounds = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
  private mapAspectBounds: PdaMapBounds = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };

  private audio?: IBodycamAudioSource;
  private phase: PdaPhase = 'STOWED';
  private phaseTimer = 0;
  private powerButtonAudioPlayed = false;
  private screenOn = false;
  private bootTimer = 0;

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
  private screenDirty = true;

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

  public isCenteredOnPlayer(): boolean {
    return this.centerOnPlayer;
  }

  public getMapZoom(): number {
    return this.mapZoom;
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
    this.screenDirty = true;
  }

  public setTelemetry(next: PdaHudTelemetry): void {
    this.telemetry = next;
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
        this.screenOn = true;
        this.bootTimer = 0;
        this.tiltImpulseX = 0.095;
        this.tiltImpulseZ = -0.075;
        this.audio?.playPdaPowerSound(true);
        this.screenDirty = true;
      }
      if (this.phaseTimer >= POWER_PRESS_DUR) {
        this.phase = 'ACTIVE';
        this.phaseTimer = 0;
      }
    } else if (this.phase === 'ACTIVE') {
      this.weaponStowBlend = 1;
      this.bootTimer += clampedDt;
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

    // Throttled OLED canvas redraw (~16 Hz when screen active for crisp 60fps perf)
    this.redrawAccum += clampedDt;
    if (this.screenDirty || (this.screenOn && this.redrawAccum >= 0.062)) {
      this.redrawAccum = 0;
      this.screenDirty = false;
      this.drawScreenCanvas(elapsed);
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

  private drawScreenCanvas(elapsed: number): void {
    const ctx = this.screenCtx;
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);

    if (!this.screenOn) {
      // Matte powered-off IPS panel with subtle reflection gradient
      const offGrad = ctx.createLinearGradient(0, 0, SCREEN_W, SCREEN_H);
      offGrad.addColorStop(0, '#0c1012');
      offGrad.addColorStop(0.5, '#12181a');
      offGrad.addColorStop(1, '#080b0c');
      ctx.fillStyle = offGrad;
      ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
      ctx.fillStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('AXON TACTICAL PDA · STANDBY', SCREEN_W * 0.5, SCREEN_H * 0.5);
      return;
    }

    // Boot animation overlay in first 0.25s
    const bootProgress = THREE.MathUtils.clamp(this.bootTimer / 0.26, 0, 1);

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
    const headingRad = -this.telemetry.playerYawRad; // Three.js +Y yaw: left turn is +yaw, map heading 0 = North (-Z)
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

    // Right: Wind Vane & Zone Label
    ctx.textAlign = 'right';
    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 15px monospace';
    ctx.fillText(this.telemetry.zoneLabel || this.telemetry.modeLabel || 'AO TAC-MAP', SCREEN_W - 64, 29);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '13px monospace';
    ctx.fillText(`ZOOM ${this.mapZoom.toFixed(1)}x`, SCREEN_W - 64, 49);

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
    const imgLeft = mapW * 0.5 - centerU * drawSize;
    const imgTop = mapTop + mapH * 0.5 - centerV * drawSize;

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

    // Live Supply Convoys & Barges (only visible when not masked by Comms Fog-of-War)
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

    // Phase 4 Regional Comms Tower Fog-of-War Static Overlays
    if (this.telemetry.commsBlackoutZones && this.telemetry.commsBlackoutZones.length > 0) {
      const worldSpanX = Math.max(1, this.mapAspectBounds.maxX - this.mapAspectBounds.minX);
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

        // Animated horizontal RF static scanlines
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
    // Vision cone (-Z = canvas up)
    const coneGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, 62);
    coneGrad.addColorStop(0, 'rgba(245, 158, 11, 0.34)');
    coneGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
    ctx.fillStyle = coneGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 62, -Math.PI * 0.5 - 0.45, -Math.PI * 0.5 + 0.45);
    ctx.closePath();
    ctx.fill();

    // Operator triangle chevron
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

    // Subtle pan reticle if zoomed/panned off player
    if (!this.centerOnPlayer) {
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

    ctx.restore();

    // Diegetic Perimeter Operations Bankruptcy Warning Banner (never conveyed by color alone)
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
    } else {
      ctx.fillText(
        `GRID ${Math.round(this.telemetry.playerX)}E ${Math.round(-this.telemetry.playerZ)}N · LMB+DRAG PAN · WHEEL ZOOM · R/RMB CENTER`,
        16,
        SCREEN_H - 13,
      );
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = this.telemetry.bankruptcyWarning
      ? '#f87171'
      : this.centerOnPlayer
        ? '#10b981'
        : '#38bdf8';
    ctx.fillText(
      this.telemetry.bankruptcyWarning
        ? 'MEDEVAC UNFUNDED'
        : this.centerOnPlayer
          ? 'GPS LOCKED'
          : 'FREE PAN',
      SCREEN_W - 16,
      SCREEN_H - 13,
    );

    // Boot scanline wipe effect
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
  }
}

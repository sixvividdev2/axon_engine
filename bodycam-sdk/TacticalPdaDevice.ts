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
}

export interface PdaOrthoCaptureOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  bounds: PdaMapBounds;
  excludeObjects?: readonly THREE.Object3D[];
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
  private joyTiltX = 0; // left/right (-1..1)
  private joyTiltY = 0; // up/down (-1..1)
  private panOffsetU = 0; // normalized map pan (-0.4..0.4)
  private panOffsetV = 0;
  private mapZoom = 1.15;
  private centerOnPlayer = true;

  private tiltImpulseX = 0;
  private tiltImpulseZ = 0;
  private swayPhase = 0;
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
    // Hand local convention: -Z points toward fingers, +Y is back of hand, +X is outward (right hand) / inward.
    // Left palm wraps around left bezel gripping from underside/side:
    this.leftGripSocket.position.set(-0.145, -0.036, -0.006);
    this.leftGripSocket.rotation.set(0.32, -0.45, -1.28, 'YXZ');

    // Right palm grips right bezel so right thumb naturally rests over keypad/joystick:
    this.rightGripSocket.position.set(0.145, -0.038, -0.006);
    this.rightGripSocket.rotation.set(0.32, 0.45, 1.28, 'YXZ');

    // Right thumb targets inside deviceGroup space
    this.rightThumbJoySocket.position.set(0.098, -0.001, 0.018);
    this.rightThumbPowerSocket.position.set(0.092, 0.045, 0.015);
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

  public toggle(): void {
    this.setOpen(!this.isOpen());
  }

  public setOpen(open: boolean): void {
    if (open) {
      if (this.phase === 'STOWED' || this.phase === 'STOWING' || this.phase === 'POWER_OFF') {
        this.phase = 'DRAWING';
        this.phaseTimer = 0;
        this.powerButtonAudioPlayed = false;
        this.screenOn = false;
        this.bootTimer = 0;
        this.deviceGroup.visible = true;
        this.screenDirty = true;
      }
    } else {
      if (this.phase === 'DRAWING') {
        this.phase = 'STOWING';
        this.phaseTimer = 0;
      } else if (this.phase === 'POWER_PRESS' || this.phase === 'ACTIVE') {
        this.phase = 'POWER_OFF';
        this.phaseTimer = 0;
        this.audio?.playPdaPowerSound(false);
        this.screenDirty = true;
      }
    }
  }

  /** Called from mouse move while PDA is open to animate the 3D thumbstick & pan cursor. */
  public applyMouseDelta(dx: number, dy: number): void {
    if (!this.isOpen()) return;
    const targetX = THREE.MathUtils.clamp(dx * 0.048, -1, 1);
    const targetY = THREE.MathUtils.clamp(-dy * 0.048, -1, 1);
    this.joyTiltX = THREE.MathUtils.clamp(this.joyTiltX + targetX * 0.45, -1, 1);
    this.joyTiltY = THREE.MathUtils.clamp(this.joyTiltY + targetY * 0.45, -1, 1);

    if (this.phase === 'ACTIVE') {
      const panSpeed = 0.00055 / Math.max(0.8, this.mapZoom);
      this.panOffsetU = THREE.MathUtils.clamp(this.panOffsetU + dx * panSpeed, -0.45, 0.45);
      this.panOffsetV = THREE.MathUtils.clamp(this.panOffsetV + dy * panSpeed, -0.45, 0.45);
      if (Math.abs(dx) + Math.abs(dy) > 1.5) {
        this.centerOnPlayer = false;
      }
      this.screenDirty = true;
    }
  }

  /** Mouse wheel zoom on tactical map. */
  public applyWheel(deltaY: number): void {
    if (!this.isOpen()) return;
    const factor = deltaY > 0 ? 0.88 : 1.13;
    this.mapZoom = THREE.MathUtils.clamp(this.mapZoom * factor, 0.9, 3.6);
    this.audio?.playPdaButtonClick();
    this.screenDirty = true;
  }

  /** Snap view back onto operator position. */
  public recenterOnPlayer(): void {
    this.centerOnPlayer = true;
    this.panOffsetU = 0;
    this.panOffsetV = 0;
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

  /** Advance state machine, 3D pose interpolation, joystick gimbal & OLED texture redraw. */
  public update(
    dt: number,
    elapsed: number,
    moveSpeedRatio = 0,
    isCrouched = false,
  ): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    this.phaseTimer += clampedDt;
    this.swayPhase += clampedDt * (1.4 + moveSpeedRatio * 3.8);

    // Decay thumbstick back toward center when mouse stops moving
    const joyDamp = Math.exp(-14 * clampedDt);
    this.joyTiltX *= joyDamp;
    this.joyTiltY *= joyDamp;

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
        this.deviceGroup.visible = false;
      }
    } else {
      this.weaponStowBlend = 0;
      this.deviceGroup.visible = false;
      return;
    }

    this.deviceGroup.visible = true;

    // === POSITION & ERGONOMIC STALKER FRAMING IN CAMERA SPACE ===
    // Camera faces -Z. PDA sits around ~25cm in front of chest-cam lens tilted cleanly for readability,
    // leaving top strip clear so operator keeps situational awareness above top bezel.
    let raiseT = 0;
    let bringCloserT = 0;
    if (this.phase === 'DRAWING') {
      raiseT = smoothstep01(this.phaseTimer / DRAWING_DUR);
      bringCloserT = 0;
    } else if (this.phase === 'POWER_PRESS') {
      raiseT = 1;
      bringCloserT = smoothstep01(Math.max(0, (this.phaseTimer - 0.14) / 0.13)) * 0.25;
    } else if (this.phase === 'ACTIVE') {
      raiseT = 1;
      bringCloserT = smoothstep01(Math.min(1, this.phaseTimer / 0.18));
    } else if (this.phase === 'POWER_OFF') {
      raiseT = 1;
      bringCloserT = 1 - smoothstep01(this.phaseTimer / POWER_OFF_DUR) * 0.65;
    } else if (this.phase === 'STOWING') {
      raiseT = 1 - smoothstep01(this.phaseTimer / STOWING_DUR);
      bringCloserT = 0;
    }

    const crouchY = isCrouched ? -0.008 : 0;
    const walkSwayX = Math.sin(this.swayPhase) * (0.0018 + moveSpeedRatio * 0.0045);
    const walkSwayY = Math.abs(Math.cos(this.swayPhase)) * (0.0014 + moveSpeedRatio * 0.0038);

    // Base draw -> inspection bring-closer curve
    const baseX = THREE.MathUtils.lerp(-0.14, 0.004, raiseT);
    const baseY = THREE.MathUtils.lerp(-0.34, THREE.MathUtils.lerp(-0.105, -0.044, bringCloserT), raiseT);
    const baseZ = THREE.MathUtils.lerp(-0.33, THREE.MathUtils.lerp(-0.305, -0.238, bringCloserT), raiseT);

    // Gentle thumbstick mouse micro-tilt so device feels physically held by hands
    const joyDevicePitch = this.joyTiltY * 0.032;
    const joyDeviceYaw = -this.joyTiltX * 0.036;

    this.deviceGroup.position.set(
      baseX + walkSwayX + this.joyTiltX * 0.004,
      baseY + walkSwayY + crouchY - this.joyTiltY * 0.003,
      baseZ,
    );

    this.deviceGroup.rotation.set(
      THREE.MathUtils.lerp(0.65, THREE.MathUtils.lerp(-0.24, -0.15, bringCloserT), raiseT) +
        this.tiltImpulseX +
        joyDevicePitch,
      THREE.MathUtils.lerp(0.45, -0.025, raiseT) + joyDeviceYaw,
      THREE.MathUtils.lerp(-0.32, 0.015, raiseT) + this.tiltImpulseZ,
      'YXZ',
    );

    // Animate 3D gimbaled thumbstick copying mouse movement + depress power switch
    this.joystickPivot.rotation.set(-this.joyTiltY * 0.42, 0, -this.joyTiltX * 0.42, 'YXZ');
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

  /** World-space target for Right Hand holding the PDA side grip. */
  public getRightGripWorldTransform(outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    this.rightGripSocket.getWorldPosition(outPos);
    this.rightGripSocket.getWorldQuaternion(outQuat);
  }

  /** World-space right thumb fingertip target (joystick vs power button). */
  public getRightThumbWorldTarget(outPos: THREE.Vector3): void {
    const pW = this.getPowerPressWeight();
    this.rightThumbJoySocket.getWorldPosition(outPos);
    if (pW > 0.01) {
      this.rightThumbPowerSocket.getWorldPosition(this._tmpPos);
      outPos.lerp(this._tmpPos, pW);
    } else {
      outPos.x += this.joyTiltX * 0.004;
      outPos.y += this.joyTiltY * 0.004;
    }
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
    const centerU = this.centerOnPlayer ? pUV.u : THREE.MathUtils.clamp(0.5 + this.panOffsetU, 0.05, 0.95);
    const centerV = this.centerOnPlayer ? pUV.v : THREE.MathUtils.clamp(0.5 + this.panOffsetV, 0.05, 0.95);

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
    ctx.fillText(
      `GRID ${Math.round(this.telemetry.playerX)}E ${Math.round(-this.telemetry.playerZ)}N · MOUSE PAN · WHEEL ZOOM · R CENTER`,
      16,
      SCREEN_H - 13,
    );
    ctx.textAlign = 'right';
    ctx.fillStyle = '#10b981';
    ctx.fillText('LINK ACTIVE', SCREEN_W - 16, SCREEN_H - 13);

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

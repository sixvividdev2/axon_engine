import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BodycamPhysicsWorld,
  BodycamWeaponProfile,
  resolveWeaponProfile,
} from '../bodycam-sdk';
import { DerivedWeaponStats, WeaponAttachments } from '../data/attachments';
import {
  createEmptyPinProjections,
  GunsmithBench,
  GunsmithPinProjection,
} from './GunsmithBench';

export interface CadGunsmithStageOptions {
  container: HTMLElement;
  initialWeaponId: string;
  initialAttachments: WeaponAttachments;
  onPinsUpdate?: (pins: GunsmithPinProjection[]) => void;
}

function detectSoftwareGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

/**
 * Standalone 3D Military CAD Wireframe Studio viewport hosting a TRUE-PBR
 * GunsmithBench and WeaponModelFactory firearm.
 * Unifies the dark navy/slate CAD wireframe aesthetic of BallisticsSimViewport
 * with photorealistic PBR hardware renders on the workbench vise.
 */
export class CadGunsmithStage {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly envRT: THREE.WebGLRenderTarget;
  private readonly bench: GunsmithBench;
  private readonly isSoftwareGl: boolean;
  private readonly onPinsUpdate?: (pins: GunsmithPinProjection[]) => void;

  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly pins: GunsmithPinProjection[] = createEmptyPinProjections();
  private readonly resizeObserver: ResizeObserver;

  private readonly _dummyFpsPos = new THREE.Vector3(0, 1.35, 1.15);
  private readonly _dummyFpsQuat = new THREE.Quaternion();
  private disposed = false;
  private rafId = 0;
  private timerId: number | null = null;
  private lastTimeMs = 0;
  private pinEmitAccum = 0;
  private cadPulseMesh: THREE.LineSegments | null = null;

  constructor(opts: CadGunsmithStageOptions) {
    this.container = opts.container;
    this.onPinsUpdate = opts.onPinsUpdate;
    this.isSoftwareGl = detectSoftwareGl();

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    const renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = !this.isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setSize(width, height, false);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070c14);
    scene.fog = new THREE.FogExp2(0x070c14, 0.085);
    this.scene = scene;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    this.envRT = pmrem.fromScene(roomEnv, 0.04);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.62;
    roomEnv.dispose();
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.08, 48);
    this.camera.position.set(0.45, 1.32, 0.85);
    this.camera.lookAt(0, 1.05, 0);

    this.buildCadWireframeStudio();

    const dummyPhysics = new BodycamPhysicsWorld();
    const raycastMeshes: THREE.Object3D[] = [];
    this.bench = new GunsmithBench({
      scene,
      physics: dummyPhysics,
      raycastMeshes,
      position: [0, 0, 0],
      yaw: 0,
      isSoftwareGl: this.isSoftwareGl,
    });

    const initialProfile = resolveWeaponProfile(opts.initialWeaponId);
    this.bench.enter(
      this.camera,
      initialProfile,
      opts.initialAttachments,
    );

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    this.lastTimeMs = performance.now();
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

  private buildCadWireframeStudio(): void {
    // 1. Studio 3-point PBR lighting so the wooden bench & metal firearm look photorealistic
    const hemi = new THREE.HemisphereLight(0xa7c5e3, 0x0b1220, 0.78);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff1dc, 2.1);
    key.position.set(2.4, 4.2, 2.8);
    if (!this.isSoftwareGl) {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 12;
      const d = 2.4;
      key.shadow.camera.left = -d;
      key.shadow.camera.right = d;
      key.shadow.camera.top = d;
      key.shadow.camera.bottom = -d;
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.014;
    }
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x5fa8f5, 1.35);
    rim.position.set(-2.8, 2.2, -2.5);
    this.scene.add(rim);

    // 2. Deep gradient CAD studio dome (matching BallisticsSimViewport blue/slate/black palette)
    const domeGeo = this.trackGeo(new THREE.SphereGeometry(22, 24, 16));
    const domeCanvas = document.createElement('canvas');
    domeCanvas.width = 4;
    domeCanvas.height = 256;
    const ctx = domeCanvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, '#04070d');
    grad.addColorStop(0.45, '#0b1422');
    grad.addColorStop(0.68, '#132033');
    grad.addColorStop(1.0, '#05080e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const domeTex = new THREE.CanvasTexture(domeCanvas);
    domeTex.colorSpace = THREE.SRGBColorSpace;
    const domeMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        map: domeTex,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    const dome = new THREE.Mesh(domeGeo, domeMat);
    this.scene.add(dome);

    // 3. Dark matte floor baseplane cleanly below the CAD wireframe grid (zero z-fighting)
    const floorMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x09101b,
        roughness: 0.9,
        metalness: 0.12,
      }),
    );
    const floorMesh = new THREE.Mesh(
      this.trackGeo(new THREE.CircleGeometry(16, 48)),
      floorMat,
    );
    floorMesh.rotation.x = -Math.PI * 0.5;
    floorMesh.position.y = -0.025;
    floorMesh.receiveShadow = !this.isSoftwareGl;
    this.scene.add(floorMesh);

    // 4. Crisp white/slate CAD architectural floor coordinate grid (y = 0.002)
    const majorGrid = new THREE.GridHelper(18, 18, 0x7dd3fc, 0x263b54);
    majorGrid.position.y = 0.002;
    const majorMats = Array.isArray(majorGrid.material)
      ? majorGrid.material
      : [majorGrid.material];
    for (const m of majorMats) {
      m.transparent = true;
      m.opacity = 0.42;
      this.trackMat(m);
    }
    this.trackGeo(majorGrid.geometry);
    this.scene.add(majorGrid);

    const fineGrid = new THREE.GridHelper(10, 40, 0x3b5878, 0x162538);
    fineGrid.position.y = 0.005;
    const fineMats = Array.isArray(fineGrid.material)
      ? fineGrid.material
      : [fineGrid.material];
    for (const m of fineMats) {
      m.transparent = true;
      m.opacity = 0.28;
      this.trackMat(m);
    }
    this.trackGeo(fineGrid.geometry);
    this.scene.add(fineGrid);

    // 5. Concentric CAD calibration compass rings + degree ticks around the gunsmith bench
    const ringLineMat = this.trackMat(
      new THREE.LineBasicMaterial({
        color: 0xdbeafe,
        transparent: true,
        opacity: 0.34,
      }),
    );
    const accentLineMat = this.trackMat(
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.52,
      }),
    );

    const ringPts: number[] = [];
    for (const radius of [1.45, 2.25, 3.6]) {
      const segs = 72;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        ringPts.push(
          Math.cos(a0) * radius,
          0.01,
          Math.sin(a0) * radius,
          Math.cos(a1) * radius,
          0.01,
          Math.sin(a1) * radius,
        );
      }
    }
    // Degree ticks around outer ring
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const inner = deg % 45 === 0 ? 1.32 : 1.4;
      const outer = deg % 45 === 0 ? 1.58 : 1.5;
      ringPts.push(
        Math.cos(rad) * inner,
        0.012,
        Math.sin(rad) * inner,
        Math.cos(rad) * outer,
        0.012,
        Math.sin(rad) * outer,
      );
    }
    const ringGeo = this.trackGeo(new THREE.BufferGeometry());
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPts, 3));
    const rings = new THREE.LineSegments(ringGeo, ringLineMat);
    this.scene.add(rings);

    // 6. Architectural CAD wireframe backdrop cage (clean spatial frame behind the bench)
    const framePts: number[] = [];
    const bw = 3.2;
    const bh = 2.6;
    const bz = -1.75;
    // Vertical backdrop elevation grid
    for (let x = -bw; x <= bw + 0.01; x += 0.8) {
      framePts.push(x, 0.01, bz, x, bh, bz);
    }
    for (let y = 0.4; y <= bh + 0.01; y += 0.44) {
      framePts.push(-bw, y, bz, bw, y, bz);
    }
    // Subtle corner datum L-brackets at floor & ceiling corners
    const bLen = 0.35;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * 2.1;
        const cz = sz * 1.45;
        framePts.push(cx, 0.014, cz, cx - sx * bLen, 0.014, cz);
        framePts.push(cx, 0.014, cz, cx, 0.014, cz - sz * bLen);
        framePts.push(cx, 0.014, cz, cx, 0.32, cz);
      }
    }
    const frameGeo = this.trackGeo(new THREE.BufferGeometry());
    frameGeo.setAttribute('position', new THREE.Float32BufferAttribute(framePts, 3));
    this.cadPulseMesh = new THREE.LineSegments(frameGeo, accentLineMat);
    this.scene.add(this.cadPulseMesh);
  }

  public setShowcaseWeapon(
    profile: BodycamWeaponProfile,
    attachments: WeaponAttachments,
  ): DerivedWeaponStats {
    const stats = this.bench.setShowcaseWeapon(profile, attachments);
    this.pinEmitAccum = 1;
    if (!this.disposed) {
      this.renderer.render(this.scene, this.camera);
      if (this.onPinsUpdate) {
        const w = Math.max(1, this.container.clientWidth);
        const h = Math.max(1, this.container.clientHeight);
        this.bench.projectPins(this.camera, w, h, this.pins);
        this.onPinsUpdate(this.pins.map((p) => ({ ...p })));
        this.pinEmitAccum = 0;
      }
    }
    return stats;
  }

  public setShowcaseTurretElevation(elevationMrad: number): void {
    this.bench.setShowcaseTurretElevation(elevationMrad);
  }

  public getHeightOverBoreM(): number {
    return this.bench.getShowcaseHeightOverBoreM();
  }

  public orbit(dx: number, dy: number): void {
    this.bench.orbitDrag(dx, dy);
  }

  public zoom(deltaY: number): void {
    this.bench.zoomWheel(deltaY);
  }

  private handleResize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.timerId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const status = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
      if (status === gl.UNSIGNALED) {
        this.timerId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.timerId = window.setTimeout(cb, 75);
      }
    };
    this.timerId = window.setTimeout(poll, 5);
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    try {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTimeMs) / 1000));
      this.lastTimeMs = now;

      this.bench.updateCamera(dt, this.camera, this._dummyFpsPos, this._dummyFpsQuat);
      this.renderer.render(this.scene, this.camera);

      this.pinEmitAccum += dt;
      if (this.onPinsUpdate && this.pinEmitAccum >= 0.032) {
        this.pinEmitAccum = 0;
        const w = Math.max(1, this.container.clientWidth);
        const h = Math.max(1, this.container.clientHeight);
        this.bench.projectPins(this.camera, w, h, this.pins);
        this.onPinsUpdate(this.pins.map((p) => ({ ...p })));
      }
    } finally {
      this.scheduleNextFrame();
    }
  };

  public dispose(): void {
    this.disposed = true;
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.resizeObserver.disconnect();
    this.bench.dispose();
    this.envRT.dispose();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

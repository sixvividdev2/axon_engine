import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CharacterSkeleton } from '../bodycam-sdk/CharacterSkeleton';
import { operatorAssetLoader } from '../bodycam-sdk/operator/OperatorAssetLoader';
import {
  DEFAULT_OPERATOR_GEAR,
  normalizeOperatorGearConfig,
  OperatorGearConfig,
  OperatorId,
} from '../bodycam-sdk/operator/OperatorTypes';
import { SecondaryPhysicsRigApplier } from '../bodycam-sdk/physics/SecondaryPhysicsRigApplier';
import { OperatorUniformId } from '../bodycam-sdk/TacticalUniforms';
import { tacticalEquipmentStore } from '../bodycam-sdk/equipment/TacticalEquipmentStore';

const HERO_YAW = 0.34;
const HERO_PITCH = 0.07;
const HERO_DIST = 2.55;
const TARGET_Y = 1.04;

export interface OperatorPreviewStageOptions {
  container: HTMLElement;
  initialOperator: OperatorId;
  initialUniform?: OperatorUniformId;
  initialGear?: Partial<OperatorGearConfig>;
  onContextStatusChange?: (lost: boolean) => void;
}

/**
 * Isolated 3D tactical turntable viewport for the Operator Selection screen.
 * Uses the exact same canonical `CharacterSkeleton` rig and procedural PBR uniform
 * materials spawned in Playground, Battle, and Infection.
 */
export class OperatorPreviewStage {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pmremGenerator: THREE.PMREMGenerator;
  private readonly envRT: THREE.WebGLRenderTarget;
  private readonly isSoftwareGl: boolean;
  private readonly maxAnisotropy: number;
  private readonly onContextStatusChange?: (lost: boolean) => void;

  private readonly turntableGroup = new THREE.Group();
  private skeleton: CharacterSkeleton | null = null;
  private secondaryApplier: SecondaryPhysicsRigApplier | null = null;
  private currentOperatorId: OperatorId;
  private currentUniformId: OperatorUniformId;
  private currentGear: OperatorGearConfig;
  private currentNvgFlipped = false;

  // Orbit camera state (exponentially damped, zero-GC)
  private targetYaw = HERO_YAW;
  private targetPitch = HERO_PITCH;
  private targetDist = HERO_DIST;
  private currentYaw = HERO_YAW;
  private currentPitch = HERO_PITCH;
  private currentDist = HERO_DIST;
  private dragging = false;
  private activePointerId: number | null = null;
  private lastPointerX = 0;
  private lastPointerY = 0;

  // Loop & lifecycle
  private disposed = false;
  private contextLost = false;
  private rafId = 0;
  private timerId: number | null = null;
  private lastFrameMs = 0;
  private elapsedSec = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly stageDisposables: Array<{ dispose: () => void }> = [];
  private readonly unsubTacticalEquipment: () => void;

  // Scratch vectors
  private readonly _lookTarget = new THREE.Vector3(0, TARGET_Y, 0);
  private readonly _zeroRootPos = new THREE.Vector3(0, 0, 0);

  constructor(opts: OperatorPreviewStageOptions) {
    this.container = opts.container;
    this.currentOperatorId = opts.initialOperator;
    this.currentGear = normalizeOperatorGearConfig({
      ...DEFAULT_OPERATOR_GEAR,
      ...opts.initialGear,
      ...(opts.initialUniform ? { uniformId: opts.initialUniform } : {}),
    });
    this.currentUniformId = this.currentGear.uniformId;
    this.onContextStatusChange = opts.onContextStatusChange;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.cursor = 'grab';
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.isSoftwareGl = this.detectSoftwareWebGL(renderer);

    const scene = new THREE.Scene();
    const bgHex = 0x0e1217;
    scene.background = new THREE.Color(bgHex);
    scene.fog = new THREE.FogExp2(bgHex, 0.068);
    this.scene = scene;

    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    const roomEnv = new RoomEnvironment();
    this.envRT = this.pmremGenerator.fromScene(roomEnv, 0.04);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.58;
    roomEnv.dispose();

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(36, width / height, 0.12, 42);
    renderer.setSize(width, height, false);

    this.buildStudioEnvironment();
    scene.add(this.turntableGroup);
    this.loadOperatorRig(this.currentOperatorId);

    this.unsubTacticalEquipment = tacticalEquipmentStore.subscribe((sel) => {
      if (!this.disposed && this.skeleton) {
        this.skeleton.setBeltEquipment(sel.equipmentId, sel.beltSlot, 2, sel.mountOnBelt);
      }
    });

    // Event listeners
    const dom = renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('dblclick', this.onDoubleClick);
    dom.addEventListener('webglcontextlost', this.onContextLost);
    dom.addEventListener('webglcontextrestored', this.onContextRestored);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);

    this.lastFrameMs = performance.now();
    this.updateCameraTransform(1);
    this.scheduleNextFrame();
  }

  private detectSoftwareWebGL(renderer: THREE.WebGLRenderer): boolean {
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return false;
      const str = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
      return /swiftshader|llvmpipe|mesa|software/i.test(str);
    } catch {
      return false;
    }
  }

  private trackDisposable<T extends { dispose: () => void }>(item: T): T {
    this.stageDisposables.push(item);
    return item;
  }

  private buildStudioEnvironment(): void {
    // 1. Tactical lighting rig: warm studio key + cool overhead fill + crisp rear rim
    const hemi = new THREE.HemisphereLight(0xb8cbe0, 0x161a20, 0.85);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff1dc, 2.35);
    key.position.set(2.8, 4.4, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 14;
    const s = 2.1;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x8bb8e8, 1.45);
    rim.position.set(-2.6, 2.8, -3.4);
    this.scene.add(rim);

    const amberAccent = new THREE.PointLight(0xf59e0b, 0.9, 6.5, 1.8);
    amberAccent.position.set(1.6, 1.15, -1.8);
    this.scene.add(amberAccent);

    // 2. Grounded matte concrete hangar floor + raised inspection turntable pedestal
    const floorMat = this.trackDisposable(
      new THREE.MeshStandardMaterial({
        color: 0x11151b,
        roughness: 0.92,
        metalness: 0.06,
      }),
    );
    const floor = new THREE.Mesh(this.trackDisposable(new THREE.CircleGeometry(14, 48)), floorMat);
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = -0.055;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Cylindrical steel inspection platform (top face sits precisely at y = 0.000)
    const plinthMat = this.trackDisposable(
      new THREE.MeshStandardMaterial({
        color: 0x1b2028,
        roughness: 0.78,
        metalness: 0.28,
      }),
    );
    const plinth = new THREE.Mesh(
      this.trackDisposable(new THREE.CylinderGeometry(0.92, 1.0, 0.055, 48)),
      plinthMat,
    );
    plinth.position.y = -0.0275;
    plinth.receiveShadow = true;
    this.scene.add(plinth);

    const deckMat = this.trackDisposable(
      new THREE.MeshStandardMaterial({
        color: 0x222831,
        roughness: 0.86,
        metalness: 0.16,
      }),
    );
    const deck = new THREE.Mesh(
      this.trackDisposable(new THREE.CylinderGeometry(0.84, 0.84, 0.004, 48)),
      deckMat,
    );
    deck.position.y = -0.002;
    deck.receiveShadow = true;
    this.scene.add(deck);

    // Subtle amber perimeter calibration ring
    const ringMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.34,
      }),
    );
    const ring = new THREE.Mesh(this.trackDisposable(new THREE.RingGeometry(0.855, 0.87, 64)), ringMat);
    ring.rotation.x = -Math.PI * 0.5;
    ring.position.y = 0.0015;
    this.scene.add(ring);

    // Subtle cardinal ticks around the turntable
    const tickGeo = this.trackDisposable(new THREE.BoxGeometry(0.012, 0.003, 0.055));
    const tickMat = this.trackDisposable(
      new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.45 }),
    );
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.position.set(Math.sin(ang) * 0.78, 0.0015, Math.cos(ang) * 0.78);
      tick.rotation.y = ang;
      this.scene.add(tick);
    }

    // Subtle background architectural framing pilasters for spatial depth
    const wallMat = this.trackDisposable(
      new THREE.MeshStandardMaterial({
        color: 0x141921,
        roughness: 0.9,
        metalness: 0.14,
      }),
    );
    const pillarGeo = this.trackDisposable(new THREE.BoxGeometry(0.42, 4.8, 0.42));
    for (const x of [-3.4, -1.7, 1.7, 3.4]) {
      const p = new THREE.Mesh(pillarGeo, wallMat);
      p.position.set(x, 2.34, -4.4);
      this.scene.add(p);
    }
  }

  private loadOperatorRig(operatorId: OperatorId): void {
    if (this.skeleton) {
      this.turntableGroup.remove(this.skeleton.root);
      this.skeleton.dispose();
      this.skeleton = null;
      this.secondaryApplier = null;
    }

    const loaded = operatorAssetLoader.loadProceduralOperator(operatorId, {
      maxAnisotropy: this.maxAnisotropy,
      uniformId: this.currentUniformId,
      gear: this.currentGear,
      previewMode: true,
      validationMode: 'SAFE_FALLBACK',
    });

    const skel = loaded.skeleton;
    const sel = tacticalEquipmentStore.getSelection();
    skel.setBeltEquipment(sel.equipmentId, sel.beltSlot, 2, sel.mountOnBelt);
    skel.setNvgFlipped(this.currentNvgFlipped);
    skel.setFirstPersonHeadShadowOnly(false);
    skel.setAllMeshesWorldLayer();
    // Face +Z toward the front studio camera so operator looks naturally toward the viewer
    skel.root.rotation.y = Math.PI;
    skel.applyPreviewReadyPose(this.elapsedSec);

    this.turntableGroup.add(skel.root);
    this.skeleton = skel;
    this.currentOperatorId = loaded.operatorId;
    this.secondaryApplier = new SecondaryPhysicsRigApplier(skel);
  }

  public setOperator(operatorId: OperatorId): void {
    if (this.disposed) return;
    if (this.currentOperatorId === operatorId && this.skeleton) return;
    this.loadOperatorRig(operatorId);
  }

  public setUniform(uniformId: OperatorUniformId): void {
    if (this.disposed) return;
    this.currentUniformId = uniformId;
    this.currentGear = normalizeOperatorGearConfig({ ...this.currentGear, uniformId });
    if (this.skeleton) {
      this.skeleton.applyUniform(uniformId);
    }
  }

  public setGear(gear: Partial<OperatorGearConfig>): void {
    if (this.disposed) return;
    this.currentGear = normalizeOperatorGearConfig({ ...this.currentGear, ...gear });
    this.currentUniformId = this.currentGear.uniformId;
    if (this.currentGear.nvgMount === 'none') {
      this.currentNvgFlipped = false;
    }
    if (this.skeleton) {
      this.skeleton.applyUniform(this.currentGear.uniformId);
      this.skeleton.applyGearConfig(this.currentGear);
      this.skeleton.setNvgFlipped(this.currentNvgFlipped);
      this.skeleton.setAllMeshesWorldLayer();
    }
  }

  public setNvgFlipped(flippedDown: boolean): void {
    if (this.disposed) return;
    this.currentNvgFlipped = this.currentGear.nvgMount !== 'none' && flippedDown;
    if (this.skeleton) {
      this.skeleton.setNvgFlipped(this.currentNvgFlipped);
    }
  }

  public resetCamera(): void {
    this.targetYaw = HERO_YAW;
    this.targetPitch = HERO_PITCH;
    this.targetDist = HERO_DIST;
  }

  private handleResize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.dragging = true;
    this.activePointerId = e.pointerId;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    // Cancel active damping momentum immediately on grab
    this.targetYaw = this.currentYaw;
    this.targetPitch = this.currentPitch;
    this.renderer.domElement.style.cursor = 'grabbing';
    try {
      this.renderer.domElement.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unsupported
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || (this.activePointerId !== null && e.pointerId !== this.activePointerId)) {
      return;
    }
    const dx = e.clientX - this.lastPointerX;
    const dy = e.clientY - this.lastPointerY;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    this.targetYaw -= dx * 0.0085;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + dy * 0.0055, -0.22, 0.48);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.dragging || (this.activePointerId !== null && e.pointerId !== this.activePointerId)) {
      return;
    }
    this.dragging = false;
    this.activePointerId = null;
    this.renderer.domElement.style.cursor = 'grab';
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.targetDist = THREE.MathUtils.clamp(this.targetDist + e.deltaY * 0.0014, 1.55, 3.55);
  };

  private onDoubleClick = (): void => {
    this.resetCamera();
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.onContextStatusChange?.(true);
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.onContextStatusChange?.(false);
    this.scheduleNextFrame();
  };

  private updateCameraTransform(dt: number): void {
    const lambda = this.dragging ? 22 : 10;
    this.currentYaw = THREE.MathUtils.damp(this.currentYaw, this.targetYaw, lambda, dt);
    this.currentPitch = THREE.MathUtils.damp(this.currentPitch, this.targetPitch, lambda, dt);
    this.currentDist = THREE.MathUtils.damp(this.currentDist, this.targetDist, 10, dt);

    const cosP = Math.cos(this.currentPitch);
    const sinP = Math.sin(this.currentPitch);
    const camX = Math.sin(this.currentYaw) * cosP * this.currentDist;
    const camY = TARGET_Y + sinP * this.currentDist;
    const camZ = Math.cos(this.currentYaw) * cosP * this.currentDist;

    this.camera.position.set(camX, camY, camZ);
    this._lookTarget.set(0, TARGET_Y - (this.currentDist - 2.55) * 0.04, 0);
    this.camera.lookAt(this._lookTarget);
  }

  private scheduleNextFrame(): void {
    if (this.disposed || this.contextLost) return;
    if (this.isSoftwareGl) {
      this.timerId = window.setTimeout(() => {
        this.timerId = null;
        this.rafId = window.requestAnimationFrame(this.frame);
      }, 0);
    } else {
      this.rafId = window.requestAnimationFrame(this.frame);
    }
  }

  private afterDraw(cb: () => void): void {
    if (!this.isSoftwareGl) {
      cb();
      return;
    }
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== 'function') {
      this.timerId = window.setTimeout(cb, 0);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) {
      this.timerId = window.setTimeout(cb, 0);
      return;
    }
    gl.flush();
    const poll = () => {
      if (this.disposed || this.contextLost) {
        gl.deleteSync(sync);
        return;
      }
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        gl.deleteSync(sync);
        cb();
      } else {
        this.timerId = window.setTimeout(poll, 4);
      }
    };
    this.timerId = window.setTimeout(poll, 0);
  }

  private frame = (nowMs: number): void => {
    if (this.disposed || this.contextLost) return;
    const dt = Math.min(0.05, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    this.elapsedSec += dt;

    this.updateCameraTransform(dt);

    if (this.skeleton) {
      this.skeleton.applyPreviewReadyPose(this.elapsedSec);
      this.secondaryApplier?.update({
        dt,
        rootWorldPos: this._zeroRootPos,
        rootWorldQuat: this.skeleton.root.quaternion,
        speedMps: 0,
        stridePhase: 0,
        grounded: true,
        recoilImpulse: 0,
      });
    }

    this.renderer.render(this.scene, this.camera);
    this.afterDraw(() => this.scheduleNextFrame());
  };

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }

    this.unsubTacticalEquipment();
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('wheel', this.onWheel);
    dom.removeEventListener('dblclick', this.onDoubleClick);
    dom.removeEventListener('webglcontextlost', this.onContextLost);
    dom.removeEventListener('webglcontextrestored', this.onContextRestored);

    if (this.skeleton) {
      this.turntableGroup.remove(this.skeleton.root);
      this.skeleton.dispose();
      this.skeleton = null;
    }
    for (const item of this.stageDisposables) {
      item.dispose();
    }
    this.stageDisposables.length = 0;
    this.envRT.dispose();
    this.pmremGenerator.dispose();
    this.renderer.dispose();
    if (dom.parentElement === this.container) {
      this.container.removeChild(dom);
    }
  }
}

import * as THREE from 'three';
import {
  BallisticTrajectoryProfile,
  BodycamWeaponProfile,
  MaterialPenetrationResult,
  sampleDamageColorRGB,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import { WeaponAttachments } from '../data/attachments';
import { BallisticMaterialId } from '../data/ballisticMaterials';

export type BallisticsCameraPreset = 'cutaway' | 'full_range' | 'impact_plate';

export interface BallisticsSimMaterialSpec {
  id: string;
  label: string;
  materialId: BallisticMaterialId;
  thicknessM: number;
  tintHex: number;
}

export const BALLISTICS_TEST_MATERIALS: readonly BallisticsSimMaterialSpec[] = [
  { id: 'drywall', label: 'Drywall 16mm', materialId: 'wood', thicknessM: 0.016, tintHex: 0x94a3b8 },
  { id: 'wood', label: 'Pine Plank 45mm', materialId: 'wood', thicknessM: 0.045, tintHex: 0xa16207 },
  { id: 'mild_steel', label: 'Mild Steel 8mm', materialId: 'steel', thicknessM: 0.008, tintHex: 0x38bdf8 },
  { id: 'concrete', label: 'Concrete 180mm', materialId: 'concrete', thicknessM: 0.18, tintHex: 0x64748b },
  { id: 'ar500', label: 'AR500 Plate 18mm', materialId: 'steel', thicknessM: 0.018, tintHex: 0xf59e0b },
];

export interface BallisticsSimUpdatePayload {
  profile: BodycamWeaponProfile;
  attachments: WeaponAttachments;
  trajectory: BallisticTrajectoryProfile;
  penetration: MaterialPenetrationResult;
  testMaterial: BallisticsSimMaterialSpec;
  testRangeM: number;
  obliquityDeg: number;
  zeroElevationMrad: number;
  isSuppressed: boolean;
}

interface InternalWorkingsRig {
  group: THREE.Group;
  triggerPivot: THREE.Group;
  hammerPivot: THREE.Group;
  firingPin: THREE.Mesh;
  boltCarrier: THREE.Group;
  recoilSpring: THREE.Mesh;
  chamberRound: THREE.Group;
  magStack: THREE.Group;
  magSpring: THREE.Mesh;
  ejectedCasing: THREE.Group;
  boreBullet: THREE.Mesh;
  chamberFlash: THREE.Mesh;
  baffleFlashes: THREE.Mesh[];
  cylinderPivot: THREE.Group | null;
  boltBaseZ: number;
  boltTravelZ: number;
  springBaseZ: number;
  firingPinBaseZ: number;
  boreStartZ: number;
  boreEndZ: number;
  ejectionOrigin: THREE.Vector3;
  hasMagazine: boolean;
  isRevolver: boolean;
  cylinderAngle: number;
  dispose: () => void;
}

interface SparkParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

const CORRIDOR_END_X = 6.25;
const FLOOR_Y = -0.34;
const MAX_SIM_SPARKS = 48;

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

function createHelicalSpringGeometry(
  radius: number,
  length: number,
  turns: number,
  tubeRadius: number,
): THREE.TubeGeometry {
  const pts: THREE.Vector3[] = [];
  const steps = turns * 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, t * length));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, steps, tubeRadius, 5, false);
}

/**
 * Dedicated Military Wireframe 3D Ballistics & Internal Mechanical Simulator Viewport.
 * Deep blue/gray/black gradient backdrop, crisp bright white CAD wireframe outlines,
 * X-Ray animated firearm internals, Green->Red damage-scaled ballistic arc,
 * interactive pan + bounded zoom, and unlimited Test Fire playback.
 */
export class BallisticsSimViewport {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  private readonly weaponPivot = new THREE.Group();
  private weaponAssembly: WeaponModelAssembly | null = null;
  private weaponKey = '';
  private weaponWireframeExtras: Array<{ dispose: () => void }> = [];
  private internals: InternalWorkingsRig | null = null;

  private readonly trajectoryGroup = new THREE.Group();
  private trajectoryDisposables: Array<{ dispose: () => void }> = [];

  private readonly plateRoot = new THREE.Group();
  private readonly plateTiltGroup = new THREE.Group();
  private plateDisposables: Array<{ dispose: () => void }> = [];

  // Animated in-flight test-fire projectile & sparks
  private readonly flightBullet: THREE.Mesh;
  private readonly flightGlow: THREE.Mesh;
  private readonly impactRing: THREE.Mesh;
  private readonly exitTracerLine: THREE.Line;
  private readonly sparkInstanced: THREE.InstancedMesh;
  private readonly sparks: SparkParticle[] = [];

  // Camera Pan & Bounded Zoom State
  private targetPanX = 2.65;
  private targetPanY = -0.04;
  private currentPanX = 2.65;
  private currentPanY = -0.04;
  private targetDist = 4.9;
  private currentDist = 4.9;
  private targetOrbitYaw = 0.14;
  private currentOrbitYaw = 0.14;
  private targetOrbitPitch = 0.12;
  private currentOrbitPitch = 0.12;

  // Test-fire simulation state
  private simPlaying = false;
  private simTime = 0;
  private simSlowMo = false;
  private simImpactTriggered = false;
  private simMuzzleX = 0.42;
  private simPlateX = 2.5;
  private simPlateY = 0;
  private simPlateWorldPos = new THREE.Vector3();
  private lastPayload: BallisticsSimUpdatePayload | null = null;

  // Trajectory curve points in world space for smooth bullet playback
  private readonly curveWorldPts: THREE.Vector3[] = [];
  private readonly curveDamageRatios: number[] = [];
  private maxFlightDistM = 100;
  private totalFlightWorldLen = 1;

  // Loop & lifecycle
  private frameId = 0;
  private lastTs = 0;
  private disposed = false;
  private contextLost = false;
  private readonly resizeObserver: ResizeObserver;

  // Zero-GC scratch helpers
  private readonly _tmpColor = new THREE.Color();
  private readonly _tmpPos = new THREE.Vector3();
  private readonly _tmpPosB = new THREE.Vector3();
  private readonly _tmpDir = new THREE.Vector3();
  private readonly _tmpMat = new THREE.Matrix4();
  private readonly _tmpQuat = new THREE.Quaternion();
  private readonly _tmpScale = new THREE.Vector3();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);

  constructor(container: HTMLElement) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareGl();

    this.scene = new THREE.Scene();

    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.08, 120);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    // 1. Deep blue / gray / black military gradient backdrop
    this.buildGradientBackdrop();

    // 2. Crisp tactical lighting for X-Ray shell & brass internals
    const hemi = new THREE.HemisphereLight(0xa5c4e8, 0x0b1220, 1.35);
    const keyLight = new THREE.DirectionalLight(0xe2efff, 1.8);
    keyLight.position.set(2.5, 4.2, 5.0);
    const rimLight = new THREE.DirectionalLight(0x60a5fa, 1.0);
    rimLight.position.set(-3.0, 2.0, -4.0);
    this.scene.add(hemi, keyLight, rimLight);

    // 3. Military wireframe 3D tactical map floor grid & topographic range rings
    this.buildMilitaryMapGrid();

    // 4. Weapon pivot (faces +X so ejection port faces +Z toward viewer)
    this.weaponPivot.position.set(0, 0, 0);
    this.weaponPivot.rotation.set(0, -Math.PI * 0.5, 0);
    this.scene.add(this.weaponPivot);
    this.scene.add(this.trajectoryGroup);

    this.plateRoot.add(this.plateTiltGroup);
    this.scene.add(this.plateRoot);

    // 5. In-flight projectile & terminal impact VFX
    const bulletGeo = this.trackGeo(new THREE.SphereGeometry(0.022, 10, 10));
    const bulletMat = this.trackMat(
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.flightBullet = new THREE.Mesh(bulletGeo, bulletMat);
    this.flightBullet.visible = false;
    this.scene.add(this.flightBullet);

    const glowGeo = this.trackGeo(new THREE.CylinderGeometry(0.008, 0.002, 0.28, 6));
    glowGeo.rotateZ(Math.PI * 0.5);
    const glowMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x4ade80,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.flightGlow = new THREE.Mesh(glowGeo, glowMat);
    this.flightGlow.visible = false;
    this.scene.add(this.flightGlow);

    const ringGeo = this.trackGeo(new THREE.RingGeometry(0.025, 0.045, 24));
    const ringMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.impactRing = new THREE.Mesh(ringGeo, ringMat);
    this.impactRing.visible = false;
    this.scene.add(this.impactRing);

    const exitGeo = this.trackGeo(new THREE.BufferGeometry());
    exitGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    const exitMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.95 }),
    );
    this.exitTracerLine = new THREE.Line(exitGeo, exitMat);
    this.exitTracerLine.visible = false;
    this.scene.add(this.exitTracerLine);

    // Instanced sparks
    const sparkGeo = this.trackGeo(new THREE.BoxGeometry(0.007, 0.007, 0.065));
    const sparkMat = this.trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xfde047,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.sparkInstanced = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SIM_SPARKS);
    this.sparkInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkInstanced.frustumCulled = false;
    for (let i = 0; i < MAX_SIM_SPARKS; i++) {
      this.sparks.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0.3,
      });
      this._tmpMat.makeScale(0, 0, 0);
      this.sparkInstanced.setMatrixAt(i, this._tmpMat);
    }
    this.sparkInstanced.instanceMatrix.needsUpdate = true;
    this.scene.add(this.sparkInstanced);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.lastTs = performance.now();
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

  private buildGradientBackdrop(): void {
    const geo = this.trackGeo(new THREE.PlaneGeometry(2, 2));
    const mat = this.trackMat(
      new THREE.ShaderMaterial({
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uTopColor: { value: new THREE.Color(0x0c1726) },
          uMidColor: { value: new THREE.Color(0x132033) },
          uBotColor: { value: new THREE.Color(0x05070c) },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.9999, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uTopColor;
          uniform vec3 uMidColor;
          uniform vec3 uBotColor;
          varying vec2 vUv;
          void main() {
            float y = clamp(vUv.y, 0.0, 1.0);
            vec3 col = y < 0.48
              ? mix(uBotColor, uMidColor, smoothstep(0.0, 0.48, y))
              : mix(uMidColor, uTopColor, smoothstep(0.48, 1.0, y));
            // Subtle military slate radial vignette
            vec2 centered = (vUv - 0.5) * vec2(1.45, 1.15);
            float vig = 1.0 - dot(centered, centered) * 0.42;
            col *= clamp(vig, 0.55, 1.08);
            // Very faint technical blueprint scanline modulation
            float grid = smoothstep(0.975, 1.0, abs(sin(vUv.y * 120.0))) * 0.014;
            col += vec3(0.45, 0.62, 0.85) * grid;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    const quad = new THREE.Mesh(geo, mat);
    quad.frustumCulled = false;
    quad.renderOrder = -1000;
    this.scene.add(quad);
  }

  private buildMilitaryMapGrid(): void {
    // Ground tactical grid in crisp steel-gray & white major axes
    const minorPositions: number[] = [];
    const majorPositions: number[] = [];

    const minX = -1.6;
    const maxX = 8.4;
    const minZ = -3.0;
    const maxZ = 3.0;

    for (let x = -1.5; x <= 8.501; x += 0.25) {
      const isMajor = Math.abs(x - Math.round(x)) < 0.01;
      const target = isMajor ? majorPositions : minorPositions;
      target.push(x, FLOOR_Y, minZ, x, FLOOR_Y, maxZ);
    }
    for (let z = -3.0; z <= 3.001; z += 0.25) {
      const isMajor = Math.abs(z - Math.round(z)) < 0.01;
      const target = isMajor ? majorPositions : minorPositions;
      target.push(minX, FLOOR_Y, z, maxX, FLOOR_Y, z);
    }

    const minorGeo = this.trackGeo(new THREE.BufferGeometry());
    minorGeo.setAttribute('position', new THREE.Float32BufferAttribute(minorPositions, 3));
    const minorMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0x3b5373, transparent: true, opacity: 0.22 }),
    );
    this.scene.add(new THREE.LineSegments(minorGeo, minorMat));

    const majorGeo = this.trackGeo(new THREE.BufferGeometry());
    majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorPositions, 3));
    const majorMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.28 }),
    );
    this.scene.add(new THREE.LineSegments(majorGeo, majorMat));

    // Bright white firing-line centerline datum along floor
    const axisGeo = this.trackGeo(new THREE.BufferGeometry());
    axisGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.9, FLOOR_Y + 0.002, 0, 7.6, FLOOR_Y + 0.002, 0], 3),
    );
    const axisMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }),
    );
    this.scene.add(new THREE.Line(axisGeo, axisMat));

    // Topographic military range arcs radiating from muzzle bench
    const ringMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.24 }),
    );
    const radii = [0.65, 1.4, 2.4, 3.6, 5.0, 6.4];
    for (const r of radii) {
      const arcPts: number[] = [];
      const segs = 36;
      for (let i = 0; i <= segs; i++) {
        const a = -Math.PI * 0.28 + (i / segs) * Math.PI * 0.56;
        arcPts.push(Math.cos(a) * r, FLOOR_Y + 0.001, Math.sin(a) * r);
      }
      const arcGeo = this.trackGeo(new THREE.BufferGeometry());
      arcGeo.setAttribute('position', new THREE.Float32BufferAttribute(arcPts, 3));
      this.scene.add(new THREE.Line(arcGeo, ringMat));
    }

    // Subtle wireframe elevation backdrop ticks behind the trajectory plane (z = -0.85)
    const backGridPts: number[] = [];
    for (let y = FLOOR_Y; y <= 1.25; y += 0.2) {
      backGridPts.push(-0.8, y, -0.85, 7.2, y, -0.85);
    }
    for (let x = 0; x <= 7.01; x += 1.0) {
      backGridPts.push(x, FLOOR_Y, -0.85, x, 1.25, -0.85);
    }
    const backGeo = this.trackGeo(new THREE.BufferGeometry());
    backGeo.setAttribute('position', new THREE.Float32BufferAttribute(backGridPts, 3));
    const backMat = this.trackMat(
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.16 }),
    );
    this.scene.add(new THREE.LineSegments(backGeo, backMat));
  }

  public setCameraPreset(preset: BallisticsCameraPreset): void {
    if (preset === 'cutaway') {
      this.targetPanX = 0.06;
      this.targetPanY = 0.01;
      this.targetDist = 0.92;
      this.targetOrbitYaw = 0.18;
      this.targetOrbitPitch = 0.08;
    } else if (preset === 'impact_plate') {
      this.targetPanX = this.simPlateX;
      this.targetPanY = this.simPlateY;
      this.targetDist = 1.45;
      this.targetOrbitYaw = -0.34;
      this.targetOrbitPitch = 0.14;
    } else {
      // full_range
      this.targetPanX = 2.85;
      this.targetPanY = -0.04;
      this.targetDist = 5.25;
      this.targetOrbitYaw = 0.10;
      this.targetOrbitPitch = 0.11;
    }
  }

  public panDrag(dx: number, dy: number, orbitMode = false): void {
    if (orbitMode) {
      this.targetOrbitYaw = THREE.MathUtils.clamp(this.targetOrbitYaw - dx * 0.0055, -0.78, 0.78);
      this.targetOrbitPitch = THREE.MathUtils.clamp(this.targetOrbitPitch + dy * 0.0045, -0.22, 0.62);
      return;
    }
    const scale = this.currentDist * 0.00145;
    this.targetPanX = THREE.MathUtils.clamp(this.targetPanX - dx * scale, -0.75, 6.8);
    this.targetPanY = THREE.MathUtils.clamp(this.targetPanY + dy * scale, -0.65, 1.05);
  }

  public zoomWheel(deltaY: number): void {
    const step = deltaY * 0.0022 * Math.max(0.35, this.targetDist * 0.35);
    this.targetDist = THREE.MathUtils.clamp(this.targetDist + step, 0.54, 7.6);
  }

  public triggerTestFire(slowMo: boolean): void {
    this.simSlowMo = slowMo;
    this.simPlaying = true;
    this.simTime = 0;
    this.simImpactTriggered = false;
    this.flightBullet.visible = false;
    this.flightGlow.visible = false;
    this.impactRing.visible = false;
    this.exitTracerLine.visible = false;
    if (this.internals?.isRevolver) {
      this.internals.cylinderAngle += Math.PI / 3;
    }
  }

  public setSlowMo(slowMo: boolean): void {
    this.simSlowMo = slowMo;
  }

  public updateConfig(payload: BallisticsSimUpdatePayload): void {
    this.lastPayload = payload;
    this.rebuildWeaponIfChanged(payload.profile, payload.attachments, payload.zeroElevationMrad);
    this.rebuildTrajectoryAndPlate(payload);
  }

  private rebuildWeaponIfChanged(
    profile: BodycamWeaponProfile,
    attachments: WeaponAttachments,
    zeroElevationMrad: number,
  ): void {
    const key = JSON.stringify({
      id: profile.id,
      railAdapter: attachments.railAdapter ?? null,
      optic: attachments.optic ?? null,
      canted: attachments.canted ?? null,
      muzzle: attachments.muzzle ?? null,
      tactical: attachments.tactical ?? null,
      foregrip: attachments.foregrip ?? null,
      magazine: attachments.magazine ?? null,
    });

    if (this.weaponKey === key && this.weaponAssembly) {
      if (this.weaponAssembly.elevationTurretMesh) {
        this.weaponAssembly.elevationTurretMesh.rotation.y = -(zeroElevationMrad / 10) * Math.PI * 2;
      }
      return;
    }

    this.clearWeapon();
    this.weaponKey = key;

    const safeProfile = profile.holdClass === 'unarmed' ? undefined : profile;
    if (!safeProfile) return;

    const asm = WeaponModelFactory.build(
      {
        id: safeProfile.id,
        holdClass: safeProfile.holdClass,
        barrelLengthM: safeProfile.barrelLengthM,
        visualStyle: safeProfile.visualStyle,
        finish: safeProfile.finish,
        railType: safeProfile.railType,
        isRevolver: safeProfile.isRevolver,
        boreAxisHeightM: safeProfile.boreAxisHeightM,
        modularCaliberId: safeProfile.defaultCaliberId,
        rightHandSocket: safeProfile.rightHandSocket,
        leftHandSocket: safeProfile.leftHandSocket,
        muzzleOffset: safeProfile.muzzleOffset,
        laserOffset: safeProfile.laserOffset,
        supportsSuppressor: safeProfile.supportsSuppressor,
        renderLayer: 0,
      },
      false,
    );

    WeaponAssembler.applyAttachments(
      asm,
      safeProfile.massKg,
      safeProfile.barrelLengthM,
      safeProfile.magCapacity,
      attachments,
    );

    if (asm.elevationTurretMesh) {
      asm.elevationTurretMesh.rotation.y = -(zeroElevationMrad / 10) * Math.PI * 2;
    }

    // Center vertically so bore centerline sits cleanly at y = 0
    const boreY = asm.muzzleSocket.position.y;
    asm.group.position.set(0, -boreY, 0.08);
    this.weaponPivot.add(asm.group);
    this.weaponAssembly = asm;

    // Convert weapon shell to military X-Ray translucent navy + crisp bright white wireframe outlines
    this.applyWireframeXRayStyle(asm);

    // Build animated internal mechanical workings inside the weapon's local frame
    this.internals = this.buildInternalWorkings(asm, safeProfile);
    asm.group.add(this.internals.group);

    this.weaponPivot.updateMatrixWorld(true);
    asm.muzzleSocket.getWorldPosition(this._tmpPos);
    this.simMuzzleX = Math.max(0.18, this._tmpPos.x);
  }

  private applyWireframeXRayStyle(asm: WeaponModelAssembly): void {
    const xrayMat = new THREE.MeshStandardMaterial({
      color: 0x0f1f38,
      emissive: 0x071222,
      emissiveIntensity: 0.4,
      roughness: 0.45,
      metalness: 0.35,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xf8fafc,
      transparent: true,
      opacity: 0.78,
    });
    this.weaponWireframeExtras.push(xrayMat, edgeMat);

    const meshesToOutline: THREE.Mesh[] = [];
    asm.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      // Skip reticle glass planes / shaders so optics don't show noisy diagonals
      const mat = obj.material;
      if (mat instanceof THREE.ShaderMaterial) {
        obj.visible = false;
        return;
      }
      obj.material = xrayMat;
      obj.castShadow = false;
      obj.receiveShadow = false;
      meshesToOutline.push(obj);
    });

    for (const mesh of meshesToOutline) {
      if (!mesh.geometry) continue;
      const edgesGeo = new THREE.EdgesGeometry(mesh.geometry, 24);
      const lines = new THREE.LineSegments(edgesGeo, edgeMat);
      lines.raycast = () => {};
      mesh.add(lines);
      this.weaponWireframeExtras.push(edgesGeo);
    }
  }

  private buildInternalWorkings(
    asm: WeaponModelAssembly,
    profile: BodycamWeaponProfile,
  ): InternalWorkingsRig {
    const disposables: Array<{ dispose: () => void }> = [];
    const tGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      disposables.push(g);
      return g;
    };
    const tMat = <T extends THREE.Material>(m: T): T => {
      disposables.push(m);
      return m;
    };

    const group = new THREE.Group();
    const isPistol = profile.holdClass === 'pistol' || profile.weightClass === 'pistol';
    const isRevolver = Boolean(profile.isRevolver);
    const boreY = asm.muzzleSocket.position.y;
    const muzzleZ = asm.muzzleSocket.position.z;
    const chamberZ = isPistol ? -0.025 : -0.035;
    const scale = isPistol ? 0.74 : 1.0;

    // Distinct high-contrast military CAD mechanical materials
    const steelMechMat = tMat(
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.32,
        roughness: 0.3,
        metalness: 0.85,
      }),
    );
    const boltEdgeMat = tMat(
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
    );
    const springMat = tMat(
      new THREE.MeshStandardMaterial({
        color: 0x7dd3fc,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.45,
        roughness: 0.35,
        metalness: 0.75,
      }),
    );
    const brassMat = tMat(
      new THREE.MeshStandardMaterial({
        color: 0xfbbf24,
        emissive: 0xb45309,
        emissiveIntensity: 0.35,
        roughness: 0.26,
        metalness: 0.9,
      }),
    );
    const copperTipMat = tMat(
      new THREE.MeshStandardMaterial({
        color: 0xf97316,
        emissive: 0x9a3412,
        emissiveIntensity: 0.32,
        roughness: 0.32,
        metalness: 0.85,
      }),
    );
    const triggerMat = tMat(
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        emissive: 0xf59e0b,
        emissiveIntensity: 0.45,
        roughness: 0.35,
        metalness: 0.7,
      }),
    );
    const boreLineMat = tMat(
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.22,
        wireframe: true,
      }),
    );

    const addCrispWire = (mesh: THREE.Mesh) => {
      const eg = tGeo(new THREE.EdgesGeometry(mesh.geometry, 20));
      mesh.add(new THREE.LineSegments(eg, boltEdgeMat));
    };

    // 1. Internal Rifled Bore Liner Tube
    const boreLen = Math.max(0.08, Math.abs(muzzleZ - chamberZ));
    const boreGeo = tGeo(new THREE.CylinderGeometry(0.0055 * scale, 0.0055 * scale, boreLen, 8, 1, true));
    boreGeo.rotateX(Math.PI * 0.5);
    const boreTube = new THREE.Mesh(boreGeo, boreLineMat);
    boreTube.position.set(0, boreY, (chamberZ + muzzleZ) * 0.5);
    group.add(boreTube);

    // 2. Trigger & Transfer Bar
    const triggerPivot = new THREE.Group();
    triggerPivot.position.set(0, boreY - 0.042 * scale, 0.025 * scale);
    const triggerBlade = new THREE.Mesh(
      tGeo(new THREE.BoxGeometry(0.006 * scale, 0.028 * scale, 0.009 * scale)),
      triggerMat,
    );
    triggerBlade.position.set(0, -0.012 * scale, -0.003 * scale);
    triggerBlade.rotation.x = 0.25;
    addCrispWire(triggerBlade);
    const searBar = new THREE.Mesh(
      tGeo(new THREE.BoxGeometry(0.005 * scale, 0.006 * scale, 0.052 * scale)),
      steelMechMat,
    );
    searBar.position.set(0, 0.012 * scale, 0.016 * scale);
    triggerPivot.add(triggerBlade, searBar);
    group.add(triggerPivot);

    // 3. Internal Hammer / Striker
    const hammerPivot = new THREE.Group();
    hammerPivot.position.set(0, boreY - 0.022 * scale, 0.068 * scale);
    const hammerHead = new THREE.Mesh(
      tGeo(new THREE.BoxGeometry(0.009 * scale, 0.032 * scale, 0.012 * scale)),
      triggerMat,
    );
    hammerHead.position.set(0, 0.014 * scale, 0);
    addCrispWire(hammerHead);
    hammerPivot.add(hammerHead);
    hammerPivot.rotation.x = 0.58; // Cocked back
    group.add(hammerPivot);

    // 4. Firing Pin
    const firingPinBaseZ = 0.035 * scale;
    const pinGeo = tGeo(new THREE.CylinderGeometry(0.0022 * scale, 0.0014 * scale, 0.056 * scale, 6));
    pinGeo.rotateX(Math.PI * 0.5);
    const firingPin = new THREE.Mesh(pinGeo, triggerMat);
    firingPin.position.set(0, boreY, firingPinBaseZ);
    group.add(firingPin);

    // 5. Bolt Carrier Group / Pistol Slide Internal Block + Gas Piston Rod
    const boltCarrier = new THREE.Group();
    const boltBaseZ = isPistol ? 0.012 : 0.02;
    const boltTravelZ = isPistol ? 0.045 : 0.088;
    boltCarrier.position.set(0, boreY, boltBaseZ);

    const carrierBlock = new THREE.Mesh(
      tGeo(new THREE.BoxGeometry(0.022 * scale, 0.022 * scale, 0.086 * scale)),
      steelMechMat,
    );
    addCrispWire(carrierBlock);
    boltCarrier.add(carrierBlock);

    // Locking lugs collar at bolt face
    const boltHeadGeo = tGeo(new THREE.CylinderGeometry(0.009 * scale, 0.009 * scale, 0.022 * scale, 8));
    boltHeadGeo.rotateX(Math.PI * 0.5);
    const boltHead = new THREE.Mesh(boltHeadGeo, steelMechMat);
    boltHead.position.set(0, 0, -0.048 * scale);
    addCrispWire(boltHead);
    boltCarrier.add(boltHead);

    // Operating gas rod / piston above barrel for rifles
    if (!isPistol && !isRevolver) {
      const rodLen = Math.min(0.24, boreLen * 0.58);
      const rodGeo = tGeo(new THREE.CylinderGeometry(0.0036, 0.0036, rodLen, 6));
      rodGeo.rotateX(Math.PI * 0.5);
      const gasRod = new THREE.Mesh(rodGeo, steelMechMat);
      gasRod.position.set(0, 0.017, -0.045 - rodLen * 0.5);
      boltCarrier.add(gasRod);
    }
    group.add(boltCarrier);

    // 6. Compressing Helical Recoil Spring
    const springLen = isPistol ? 0.068 : 0.135;
    const springGeo = tGeo(createHelicalSpringGeometry(0.0082 * scale, springLen, 10, 0.0014 * scale));
    const recoilSpring = new THREE.Mesh(springGeo, springMat);
    const springBaseZ = isPistol ? -0.085 : boltBaseZ + 0.044;
    recoilSpring.position.set(0, isPistol ? boreY - 0.018 : boreY, springBaseZ);
    group.add(recoilSpring);

    // 7. Helper to create a brass cartridge + copper bullet tip
    const makeCartridge = (): THREE.Group => {
      const cg = new THREE.Group();
      const caseGeo = tGeo(new THREE.CylinderGeometry(0.0044 * scale, 0.0048 * scale, 0.032 * scale, 8));
      caseGeo.rotateX(Math.PI * 0.5);
      const casing = new THREE.Mesh(caseGeo, brassMat);
      const tipGeo = tGeo(new THREE.ConeGeometry(0.0042 * scale, 0.016 * scale, 8));
      tipGeo.rotateX(-Math.PI * 0.5);
      const tip = new THREE.Mesh(tipGeo, copperTipMat);
      tip.position.set(0, 0, -0.024 * scale);
      cg.add(casing, tip);
      return cg;
    };

    const chamberRound = makeCartridge();
    chamberRound.position.set(0, boreY, chamberZ);
    group.add(chamberRound);

    // Spent brass casing for ejection animation
    const ejectedCasing = new THREE.Group();
    const spentGeo = tGeo(new THREE.CylinderGeometry(0.0044 * scale, 0.0048 * scale, 0.030 * scale, 8));
    spentGeo.rotateX(Math.PI * 0.5);
    ejectedCasing.add(new THREE.Mesh(spentGeo, brassMat));
    ejectedCasing.visible = false;
    group.add(ejectedCasing);

    // 8. Magazine internal round stack + follower spring (or Revolver cylinder chambers)
    const magStack = new THREE.Group();
    const magSpringGeo = tGeo(createHelicalSpringGeometry(0.006 * scale, 0.075 * scale, 7, 0.0011 * scale));
    magSpringGeo.rotateX(Math.PI * 0.5);
    const magSpring = new THREE.Mesh(magSpringGeo, springMat);
    const hasMagazine = !isRevolver;
    let cylinderPivot: THREE.Group | null = null;

    if (isRevolver) {
      cylinderPivot = new THREE.Group();
      cylinderPivot.position.set(0, boreY - 0.014 * scale, -0.015 * scale);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const r = makeCartridge();
        r.position.set(Math.sin(a) * 0.014 * scale, Math.cos(a) * 0.014 * scale, 0);
        cylinderPivot.add(r);
      }
      group.add(cylinderPivot);
      boltCarrier.visible = false;
      recoilSpring.visible = false;
    } else {
      const magPos = asm.magWellSocket.position;
      magStack.position.set(magPos.x, boreY - 0.036 * scale, isPistol ? 0.048 : magPos.z);
      for (let i = 0; i < 5; i++) {
        const rd = makeCartridge();
        rd.position.set(0, -i * 0.0115 * scale, i * 0.0015 * scale);
        magStack.add(rd);
      }
      magSpring.position.set(magStack.position.x, magStack.position.y - 0.058 * scale, magStack.position.z);
      group.add(magStack, magSpring);
    }

    // 9. Bore-travel projectile & Chamber ignition flash + Suppressor baffle glow
    const boreBulletGeo = tGeo(new THREE.ConeGeometry(0.0052 * scale, 0.022 * scale, 8));
    boreBulletGeo.rotateX(-Math.PI * 0.5);
    const boreBulletMat = tMat(
      new THREE.MeshBasicMaterial({ color: 0xfef08a }),
    );
    const boreBullet = new THREE.Mesh(boreBulletGeo, boreBulletMat);
    boreBullet.position.set(0, boreY, chamberZ);
    boreBullet.visible = false;
    group.add(boreBullet);

    const flashGeo = tGeo(new THREE.SphereGeometry(0.018 * scale, 10, 10));
    const flashMat = tMat(
      new THREE.MeshBasicMaterial({
        color: 0xffa94d,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const chamberFlash = new THREE.Mesh(flashGeo, flashMat);
    chamberFlash.position.set(0, boreY, chamberZ - 0.01);
    chamberFlash.visible = false;
    group.add(chamberFlash);

    const baffleFlashes: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const bGeo = tGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.014, 10));
      bGeo.rotateX(Math.PI * 0.5);
      const bMat = tMat(
        new THREE.MeshBasicMaterial({
          color: 0x38bdf8,
          transparent: true,
          opacity: 0.65,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      const bMesh = new THREE.Mesh(bGeo, bMat);
      bMesh.position.set(0, boreY, muzzleZ + 0.025 + i * 0.032);
      bMesh.visible = false;
      group.add(bMesh);
      baffleFlashes.push(bMesh);
    }

    const ejectionOrigin = asm.ejectionPortSocket.position.clone();
    if (ejectionOrigin.lengthSq() < 1e-4) {
      ejectionOrigin.set(0.016, boreY + 0.004, chamberZ + 0.015);
    }

    return {
      group,
      triggerPivot,
      hammerPivot,
      firingPin,
      boltCarrier,
      recoilSpring,
      chamberRound,
      magStack,
      magSpring,
      ejectedCasing,
      boreBullet,
      chamberFlash,
      baffleFlashes,
      cylinderPivot,
      boltBaseZ,
      boltTravelZ,
      springBaseZ,
      firingPinBaseZ,
      boreStartZ: chamberZ - 0.015,
      boreEndZ: muzzleZ,
      ejectionOrigin,
      hasMagazine,
      isRevolver,
      cylinderAngle: 0,
      dispose: () => {
        for (const d of disposables) d.dispose();
      },
    };
  }

  private mapDistToWorldX(distM: number, maxRangeM: number): number {
    const t = THREE.MathUtils.clamp(distM / Math.max(25, maxRangeM), 0, 1);
    return this.simMuzzleX + t * (CORRIDOR_END_X - this.simMuzzleX);
  }

  private mapRelYToWorldY(yRelSightM: number, hobM: number, maxDropAbsM: number): number {
    // Exaggerate vertical drop smoothly so sub-meter trajectories remain readable on the 3D map
    // while keeping sightline cleanly at y = +hobDisplay and bore origin at y = 0.
    const yScale = THREE.MathUtils.clamp(0.46 / Math.max(0.22, maxDropAbsM), 0.14, 1.35);
    const hobDisplay = Math.max(0.04, hobM * yScale);
    return hobDisplay + yRelSightM * yScale;
  }

  private rebuildTrajectoryAndPlate(payload: BallisticsSimUpdatePayload): void {
    this.clearTrajectoryAndPlate();

    const { trajectory, penetration, testMaterial, testRangeM, obliquityDeg } = payload;
    const maxRangeM = trajectory.maxRangeM;
    const hobM = trajectory.heightOverBoreM;

    let maxAbsY = 0.25;
    for (let i = 0; i < trajectory.points.length; i++) {
      const absY = Math.abs(trajectory.points[i].yRelSightM);
      if (absY > maxAbsY) maxAbsY = absY;
    }

    const yScale = THREE.MathUtils.clamp(0.46 / Math.max(0.22, maxAbsY), 0.14, 1.35);
    const sightlineY = Math.max(0.04, hobM * yScale);

    // 1. Green -> Red Bullet Trajectory Line (color represents damage at range)
    const positions: number[] = [];
    const colors: number[] = [];
    const ribbonPos: number[] = [];
    const ribbonColors: number[] = [];
    const ribbonIdx: number[] = [];

    this.curveWorldPts.length = 0;
    this.curveDamageRatios.length = 0;
    this.maxFlightDistM = Math.min(testRangeM, maxRangeM);

    const pts = trajectory.points;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const wx = this.mapDistToWorldX(pt.distanceM, maxRangeM);
      const wy = Math.max(FLOOR_Y + 0.02, sightlineY + pt.yRelSightM * yScale);

      positions.push(wx, wy, 0);
      sampleDamageColorRGB(pt.damageRatio, this._tmpColor);
      colors.push(this._tmpColor.r, this._tmpColor.g, this._tmpColor.b);

      // Thin additive ribbon for high legibility against deep blue/black gradient
      ribbonPos.push(wx, wy + 0.008, 0, wx, wy - 0.008, 0);
      ribbonColors.push(
        this._tmpColor.r,
        this._tmpColor.g,
        this._tmpColor.b,
        this._tmpColor.r,
        this._tmpColor.g,
        this._tmpColor.b,
      );
      if (i < pts.length - 1) {
        const b = i * 2;
        ribbonIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }

      if (pt.distanceM <= this.maxFlightDistM + 0.5) {
        this.curveWorldPts.push(new THREE.Vector3(wx, wy, 0));
        this.curveDamageRatios.push(pt.damageRatio);
      }
    }

    const trajGeo = new THREE.BufferGeometry();
    trajGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    trajGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const trajMat = new THREE.LineBasicMaterial({ vertexColors: true });
    const trajLine = new THREE.Line(trajGeo, trajMat);
    this.trajectoryGroup.add(trajLine);
    this.trajectoryDisposables.push(trajGeo, trajMat);

    const ribGeo = new THREE.BufferGeometry();
    ribGeo.setAttribute('position', new THREE.Float32BufferAttribute(ribbonPos, 3));
    ribGeo.setAttribute('color', new THREE.Float32BufferAttribute(ribbonColors, 3));
    ribGeo.setIndex(ribbonIdx);
    const ribMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ribMesh = new THREE.Mesh(ribGeo, ribMat);
    this.trajectoryGroup.add(ribMesh);
    this.trajectoryDisposables.push(ribGeo, ribMat);

    // 2. Crisp White Dashed Sightline Datum (y = sightlineY)
    const sightGeo = new THREE.BufferGeometry();
    sightGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0.0, sightlineY, 0, CORRIDOR_END_X + 0.15, sightlineY, 0], 3),
    );
    const sightMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.09,
      gapSize: 0.06,
      transparent: true,
      opacity: 0.62,
    });
    const sightLine = new THREE.Line(sightGeo, sightMat);
    sightLine.computeLineDistances();
    this.trajectoryGroup.add(sightLine);
    this.trajectoryDisposables.push(sightGeo, sightMat);

    // 3. Range-Gate Vertical Wireframe Datum Posts
    const gatePostPositions: number[] = [];
    for (const g of trajectory.rangeGates) {
      const gx = this.mapDistToWorldX(g.distanceM, maxRangeM);
      const gy = Math.max(FLOOR_Y + 0.02, sightlineY + g.yRelSightM * yScale);
      gatePostPositions.push(gx, FLOOR_Y, 0, gx, Math.max(sightlineY + 0.05, gy + 0.05), 0);
      // Cross tick on floor
      gatePostPositions.push(gx, FLOOR_Y + 0.002, -0.14, gx, FLOOR_Y + 0.002, 0.14);
    }
    const gateGeo = new THREE.BufferGeometry();
    gateGeo.setAttribute('position', new THREE.Float32BufferAttribute(gatePostPositions, 3));
    const gateMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.28,
    });
    this.trajectoryGroup.add(new THREE.LineSegments(gateGeo, gateMat));
    this.trajectoryDisposables.push(gateGeo, gateMat);

    // 4. Zero Crossover Bright White Diamond Reticles
    const addZeroMarker = (distM: number | null) => {
      if (distM === null || distM <= 1 || distM > maxRangeM) return;
      const zx = this.mapDistToWorldX(distM, maxRangeM);
      const r = 0.042;
      const dGeo = new THREE.BufferGeometry();
      dGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(
          [
            zx, sightlineY + r, 0.005,
            zx + r, sightlineY, 0.005,
            zx, sightlineY - r, 0.005,
            zx - r, sightlineY, 0.005,
            zx, sightlineY + r, 0.005,
          ],
          3,
        ),
      );
      const dMat = new THREE.LineBasicMaterial({ color: 0xffffff });
      this.trajectoryGroup.add(new THREE.Line(dGeo, dMat));
      this.trajectoryDisposables.push(dGeo, dMat);
    };
    addZeroMarker(trajectory.nearZeroM);
    addZeroMarker(trajectory.farZeroM);

    // 5. 3D Wireframe Ballistic Material Penetration Test Plate at `testRangeM`
    const plateDist = THREE.MathUtils.clamp(testRangeM, 15, maxRangeM);
    // Interpolate trajectory Y at plateDist
    let plateRelY = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      if (plateDist >= pts[i].distanceM && plateDist <= pts[i + 1].distanceM) {
        const span = Math.max(1e-4, pts[i + 1].distanceM - pts[i].distanceM);
        const f = (plateDist - pts[i].distanceM) / span;
        plateRelY = THREE.MathUtils.lerp(pts[i].yRelSightM, pts[i + 1].yRelSightM, f);
        break;
      }
    }
    this.simPlateX = this.mapDistToWorldX(plateDist, maxRangeM);
    this.simPlateY = Math.max(FLOOR_Y + 0.24, this.mapRelYToWorldY(plateRelY, hobM, maxAbsY));
    this.simPlateWorldPos.set(this.simPlateX, this.simPlateY, 0);

    // Ensure curve ends cleanly at impact point
    if (this.curveWorldPts.length > 0) {
      this.curveWorldPts.push(new THREE.Vector3(this.simPlateX, this.simPlateY, 0));
      const lastRatio = this.curveDamageRatios[this.curveDamageRatios.length - 1] ?? 0.5;
      this.curveDamageRatios.push(lastRatio);
    }
    this.totalFlightWorldLen = Math.max(0.2, this.simPlateX - this.simMuzzleX);

    this.plateRoot.position.set(this.simPlateX, this.simPlateY, 0);
    this.plateTiltGroup.rotation.set(0, THREE.MathUtils.degToRad(obliquityDeg), 0);

    const visualThick = THREE.MathUtils.clamp(testMaterial.thicknessM * 1.4, 0.022, 0.22);
    const slabGeo = new THREE.BoxGeometry(visualThick, 0.42, 0.34);
    const slabMat = new THREE.MeshStandardMaterial({
      color: testMaterial.tintHex,
      emissive: testMaterial.tintHex,
      emissiveIntensity: 0.16,
      transparent: true,
      opacity: 0.28,
      roughness: 0.45,
      metalness: 0.4,
      depthWrite: false,
    });
    const slabMesh = new THREE.Mesh(slabGeo, slabMat);
    const slabEdgeGeo = new THREE.EdgesGeometry(slabGeo, 15);
    const slabEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 });
    slabMesh.add(new THREE.LineSegments(slabEdgeGeo, slabEdgeMat));
    this.plateTiltGroup.add(slabMesh);

    // Steel wireframe target pedestal connecting plate down to floor
    const standH = Math.max(0.08, this.simPlateY - 0.21 - FLOOR_Y);
    const standGeo = new THREE.BoxGeometry(0.036, standH, 0.036);
    const standEdgeGeo = new THREE.EdgesGeometry(standGeo, 15);
    const standWire = new THREE.LineSegments(standEdgeGeo, slabEdgeMat);
    standWire.position.set(0, -0.21 - standH * 0.5, 0);
    this.plateRoot.add(standWire);

    const baseGeo = new THREE.BoxGeometry(0.26, 0.016, 0.30);
    const baseEdgeGeo = new THREE.EdgesGeometry(baseGeo, 15);
    const baseWire = new THREE.LineSegments(baseEdgeGeo, slabEdgeMat);
    baseWire.position.set(0, FLOOR_Y - this.simPlateY + 0.008, 0);
    this.plateRoot.add(baseWire);

    // Persistent terminal outcome vector visualization behind/off the plate
    const vecPts: number[] = [];
    let outcomeColor = 0x22c55e;
    if (penetration.outcome === 'penetrate') {
      outcomeColor = 0x22c55e;
      vecPts.push(visualThick * 0.5, 0, 0, visualThick * 0.5 + 0.58, -0.04, 0);
    } else if (penetration.outcome === 'ricochet') {
      outcomeColor = 0xf59e0b;
      const rad = THREE.MathUtils.degToRad(Math.max(12, 90 - obliquityDeg));
      vecPts.push(-visualThick * 0.5, 0, 0, -visualThick * 0.5 + Math.cos(rad) * 0.52, 0.14, Math.sin(rad) * 0.52);
    } else if (penetration.outcome === 'fragment') {
      outcomeColor = 0xf97316;
      const dirs: Array<[number, number, number]> = [
        [-0.36, 0.18, 0.16],
        [-0.34, -0.16, 0.18],
        [-0.38, 0.12, -0.18],
        [-0.32, -0.18, -0.14],
      ];
      for (const [dx, dy, dz] of dirs) {
        vecPts.push(-visualThick * 0.5, 0, 0, -visualThick * 0.5 + dx, dy, dz);
      }
    } else {
      outcomeColor = 0xef4444;
      const penFrac = THREE.MathUtils.clamp(
        penetration.penetrationDepthCm / Math.max(0.5, penetration.effectiveThicknessCm),
        0.15,
        0.92,
      );
      vecPts.push(-visualThick * 0.5, 0, 0, -visualThick * 0.5 + visualThick * penFrac, 0, 0);
    }

    const vecGeo = new THREE.BufferGeometry();
    vecGeo.setAttribute('position', new THREE.Float32BufferAttribute(vecPts, 3));
    const vecMat = new THREE.LineBasicMaterial({ color: outcomeColor, transparent: true, opacity: 0.92 });
    const vecLines = new THREE.LineSegments(vecGeo, vecMat);
    this.plateTiltGroup.add(vecLines);

    this.plateDisposables.push(
      slabGeo,
      slabMat,
      slabEdgeGeo,
      slabEdgeMat,
      standGeo,
      standEdgeGeo,
      baseGeo,
      baseEdgeGeo,
      vecGeo,
      vecMat,
    );
  }

  private spawnImpactBurst(): void {
    const payload = this.lastPayload;
    if (!payload) return;
    const outcome = payload.penetration.outcome;
    const origin = this.simPlateWorldPos;

    // Orient & show impact shock ring
    this.impactRing.position.copy(origin);
    this.impactRing.rotation.set(0, Math.PI * 0.5 + THREE.MathUtils.degToRad(payload.obliquityDeg), 0);
    this.impactRing.scale.setScalar(0.5);
    const ringMat = this.impactRing.material as THREE.MeshBasicMaterial;
    ringMat.color.setHex(
      outcome === 'penetrate'
        ? 0x4ade80
        : outcome === 'ricochet'
          ? 0xfbbf24
          : outcome === 'fragment'
            ? 0xf97316
            : 0xef4444,
    );
    ringMat.opacity = 0.95;
    this.impactRing.visible = true;

    // Exit / ricochet streak line
    const posAttr = this.exitTracerLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (outcome === 'penetrate') {
      posAttr.setXYZ(0, origin.x, origin.y, 0);
      posAttr.setXYZ(1, origin.x + 0.85, origin.y - 0.05, 0);
      (this.exitTracerLine.material as THREE.LineBasicMaterial).color.setHex(0x4ade80);
      this.exitTracerLine.visible = true;
    } else if (outcome === 'ricochet') {
      const obRad = THREE.MathUtils.degToRad(payload.obliquityDeg);
      posAttr.setXYZ(0, origin.x, origin.y, 0);
      posAttr.setXYZ(1, origin.x + Math.sin(obRad) * 0.65, origin.y + 0.28, Math.cos(obRad) * 0.55);
      (this.exitTracerLine.material as THREE.LineBasicMaterial).color.setHex(0xfbbf24);
      this.exitTracerLine.visible = true;
    } else {
      this.exitTracerLine.visible = false;
    }
    posAttr.needsUpdate = true;

    // Spawn directional sparks
    const count = outcome === 'fragment' ? 30 : outcome === 'penetrate' ? 22 : 16;
    for (let i = 0; i < count; i++) {
      const s = this.sparks[i % MAX_SIM_SPARKS];
      s.active = true;
      s.pos.copy(origin);
      const forwardSign = outcome === 'penetrate' ? 1 : -1;
      const spd = 1.6 + Math.random() * 2.8;
      s.vel.set(
        forwardSign * spd * (0.45 + Math.random() * 0.7),
        (Math.random() - 0.3) * spd * 0.85,
        (Math.random() - 0.5) * spd * 0.9,
      );
      s.maxLife = 0.26 + Math.random() * 0.24;
      s.life = s.maxLife;
    }
  }

  private stepTestFireAnimation(dt: number): void {
    const rig = this.internals;
    if (!this.simPlaying) {
      if (rig) {
        // Gentle idle settle back to battery
        rig.triggerPivot.rotation.x = THREE.MathUtils.damp(rig.triggerPivot.rotation.x, 0, 14, dt);
        rig.hammerPivot.rotation.x = THREE.MathUtils.damp(rig.hammerPivot.rotation.x, 0.58, 12, dt);
        rig.firingPin.position.z = THREE.MathUtils.damp(rig.firingPin.position.z, rig.firingPinBaseZ, 16, dt);
        rig.boltCarrier.position.z = THREE.MathUtils.damp(rig.boltCarrier.position.z, rig.boltBaseZ, 14, dt);
        rig.recoilSpring.scale.z = THREE.MathUtils.damp(rig.recoilSpring.scale.z, 1, 14, dt);
        rig.chamberRound.visible = true;
        rig.chamberRound.position.y = THREE.MathUtils.damp(
          rig.chamberRound.position.y,
          this.weaponAssembly?.muzzleSocket.position.y ?? 0,
          14,
          dt,
        );
        rig.chamberFlash.visible = false;
        rig.boreBullet.visible = false;
        rig.ejectedCasing.visible = false;
        for (const b of rig.baffleFlashes) b.visible = false;
        if (rig.cylinderPivot) {
          rig.cylinderPivot.rotation.z = THREE.MathUtils.damp(rig.cylinderPivot.rotation.z, rig.cylinderAngle, 14, dt);
        }
      }
      return;
    }

    const timeScale = this.simSlowMo ? 0.16 : 1.0;
    this.simTime += dt * timeScale;
    const t = this.simTime;

    if (rig) {
      // Phase 1 (0.00 - 0.09s): Trigger pull
      const trigPull = t < 0.09 ? THREE.MathUtils.smoothstep(t, 0.0, 0.085) : Math.max(0, 1 - (t - 0.18) / 0.18);
      rig.triggerPivot.rotation.x = -trigPull * 0.42;

      // Revolver cylinder index on trigger pull
      if (rig.cylinderPivot) {
        rig.cylinderPivot.rotation.z = THREE.MathUtils.damp(rig.cylinderPivot.rotation.z, rig.cylinderAngle, 18 * timeScale + 4, dt);
      }

      // Phase 2 (0.08 - 0.14s): Hammer strike & firing pin snap forward
      if (t >= 0.08 && t < 0.24) {
        const strike = THREE.MathUtils.clamp((t - 0.08) / 0.045, 0, 1);
        rig.hammerPivot.rotation.x = THREE.MathUtils.lerp(0.58, -0.28, strike);
        rig.firingPin.position.z = rig.firingPinBaseZ - strike * 0.018;
      } else if (t >= 0.24) {
        const recock = THREE.MathUtils.clamp((t - 0.24) / 0.12, 0, 1);
        rig.hammerPivot.rotation.x = THREE.MathUtils.lerp(-0.28, 0.58, recock);
        rig.firingPin.position.z = THREE.MathUtils.lerp(rig.firingPinBaseZ - 0.018, rig.firingPinBaseZ, recock);
      }

      // Phase 3 (0.125 - 0.21s): Chamber ignition flash
      if (t >= 0.125 && t <= 0.22) {
        const f = 1 - (t - 0.125) / 0.095;
        rig.chamberFlash.visible = true;
        rig.chamberFlash.scale.setScalar(0.6 + (1 - f) * 1.45);
        (rig.chamberFlash.material as THREE.MeshBasicMaterial).opacity = f * 0.92;
      } else {
        rig.chamberFlash.visible = false;
      }

      // Phase 4 (0.135 - 0.255s): Bullet travels down internal rifled bore + suppressor baffles
      if (t >= 0.135 && t <= 0.255) {
        const bf = (t - 0.135) / 0.12;
        rig.boreBullet.visible = true;
        rig.boreBullet.position.z = THREE.MathUtils.lerp(rig.boreStartZ, rig.boreEndZ, bf);

        const suppressed = Boolean(this.lastPayload?.isSuppressed);
        for (let i = 0; i < rig.baffleFlashes.length; i++) {
          const b = rig.baffleFlashes[i];
          if (!suppressed) {
            b.visible = false;
            continue;
          }
          const bStart = 0.21 + i * 0.014;
          if (t >= bStart && t <= bStart + 0.055) {
            const u = 1 - (t - bStart) / 0.055;
            b.visible = true;
            (b.material as THREE.MeshBasicMaterial).opacity = u * 0.72;
            b.scale.setScalar(0.85 + (1 - u) * 0.45);
          } else {
            b.visible = false;
          }
        }
      } else {
        rig.boreBullet.visible = false;
        for (const b of rig.baffleFlashes) b.visible = false;
      }

      // Phase 5 (0.16 - 0.46s): Bolt carrier recoil, helical spring compression, casing ejection & next round feed
      if (!rig.isRevolver) {
        let recoilFrac = 0;
        if (t >= 0.16 && t < 0.28) {
          recoilFrac = THREE.MathUtils.smoothstep(t, 0.16, 0.27);
        } else if (t >= 0.28 && t < 0.46) {
          recoilFrac = 1 - THREE.MathUtils.smoothstep(t, 0.28, 0.45);
        }
        rig.boltCarrier.position.z = rig.boltBaseZ + recoilFrac * rig.boltTravelZ;
        // Compress recoil spring cleanly as bolt travels rearward
        rig.recoilSpring.scale.z = Math.max(0.32, 1 - recoilFrac * 0.56);
        rig.recoilSpring.position.z = rig.springBaseZ + (rig.springBaseZ > 0 ? recoilFrac * rig.boltTravelZ * 0.72 : 0);

        // Hide chambered round while extracting; lift fresh round from mag stack as bolt closes
        rig.chamberRound.visible = t < 0.17 || t > 0.34;
        if (t >= 0.28 && t <= 0.44) {
          const feedFrac = THREE.MathUtils.clamp((t - 0.30) / 0.13, 0, 1);
          rig.magStack.position.y =
            (this.weaponAssembly?.muzzleSocket.position.y ?? 0) - 0.036 + Math.sin(feedFrac * Math.PI) * 0.011;
          rig.magSpring.scale.y = 1 + Math.sin(feedFrac * Math.PI) * 0.12;
        } else {
          rig.magSpring.scale.y = 1;
        }

        // Ejected spinning brass casing arc out of ejection port (+X in weapon space -> +Z toward viewer!)
        if (t >= 0.19 && t <= 0.68) {
          const et = t - 0.19;
          rig.ejectedCasing.visible = true;
          rig.ejectedCasing.position.set(
            rig.ejectionOrigin.x + et * 0.55,
            rig.ejectionOrigin.y + et * 0.42 - 0.5 * 2.2 * et * et,
            rig.ejectionOrigin.z + et * 0.18,
          );
          rig.ejectedCasing.rotation.set(et * 19, et * 14, et * 23);
        } else {
          rig.ejectedCasing.visible = false;
        }
      }
    }

    // Phase 6 (0.25 - 0.88s): Projectile flies down the Green -> Red trajectory curve into test plate
    const flightStart = 0.25;
    const flightEnd = 0.88;
    if (t >= flightStart && t <= flightEnd && this.curveWorldPts.length >= 2) {
      const u = THREE.MathUtils.clamp((t - flightStart) / (flightEnd - flightStart), 0, 1);
      const fIdx = u * (this.curveWorldPts.length - 1);
      const i0 = Math.min(this.curveWorldPts.length - 2, Math.floor(fIdx));
      const frac = fIdx - i0;
      const p0 = this.curveWorldPts[i0];
      const p1 = this.curveWorldPts[i0 + 1];

      this._tmpPos.lerpVectors(p0, p1, frac);
      this._tmpDir.subVectors(p1, p0).normalize();

      this.flightBullet.visible = true;
      this.flightBullet.position.copy(this._tmpPos);

      this.flightGlow.visible = true;
      this.flightGlow.position.copy(this._tmpPos).addScaledVector(this._tmpDir, -0.12);
      const angleZ = Math.atan2(this._tmpDir.y, this._tmpDir.x);
      this.flightGlow.rotation.set(0, 0, angleZ);

      const dmgRatio = THREE.MathUtils.lerp(
        this.curveDamageRatios[i0] ?? 0.8,
        this.curveDamageRatios[i0 + 1] ?? 0.5,
        frac,
      );
      sampleDamageColorRGB(dmgRatio, this._tmpColor);
      (this.flightGlow.material as THREE.MeshBasicMaterial).color.copy(this._tmpColor);
    } else if (t > flightEnd) {
      this.flightBullet.visible = false;
      this.flightGlow.visible = false;
      if (!this.simImpactTriggered) {
        this.simImpactTriggered = true;
        this.spawnImpactBurst();
      }
    }

    // Phase 7: Fade impact shock ring
    if (this.impactRing.visible) {
      const sinceImpact = Math.max(0, t - flightEnd);
      const scale = 0.55 + sinceImpact * 4.2;
      this.impactRing.scale.setScalar(scale);
      const ringMat = this.impactRing.material as THREE.MeshBasicMaterial;
      ringMat.opacity = Math.max(0, 0.95 - sinceImpact * 3.0);
      if (ringMat.opacity <= 0.01) {
        this.impactRing.visible = false;
      }
    }
    if (this.exitTracerLine.visible && t > flightEnd + 0.24) {
      this.exitTracerLine.visible = false;
    }

    if (t >= 1.25) {
      this.simPlaying = false;
    }
  }

  private stepSparks(dt: number): void {
    let dirty = false;
    const simDt = dt * (this.simPlaying && this.simSlowMo ? 0.35 : 1.0);
    for (let i = 0; i < MAX_SIM_SPARKS; i++) {
      const s = this.sparks[i];
      if (!s.active) continue;
      dirty = true;
      s.life -= simDt;
      if (s.life <= 0) {
        s.active = false;
        this._tmpMat.makeScale(0, 0, 0);
        this.sparkInstanced.setMatrixAt(i, this._tmpMat);
        continue;
      }
      s.vel.y -= 4.5 * simDt;
      s.pos.addScaledVector(s.vel, simDt);
      const spd = s.vel.length();
      if (spd > 0.02) {
        this._tmpDir.copy(s.vel).divideScalar(spd);
        this._tmpQuat.setFromUnitVectors(this._upVec, this._tmpDir);
      }
      const stretch = THREE.MathUtils.clamp((s.life / s.maxLife) * 1.4, 0.2, 1.4);
      this._tmpScale.set(1, 1, stretch);
      this._tmpMat.compose(s.pos, this._tmpQuat, this._tmpScale);
      this.sparkInstanced.setMatrixAt(i, this._tmpMat);
    }
    if (dirty) {
      this.sparkInstanced.instanceMatrix.needsUpdate = true;
    }
  }

  private tick = (): void => {
    if (this.disposed) return;

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTs) / 1000));
    this.lastTs = now;

    if (!this.contextLost) {
      // Smooth exponential camera pan & zoom damping
      this.currentPanX = THREE.MathUtils.damp(this.currentPanX, this.targetPanX, 11, dt);
      this.currentPanY = THREE.MathUtils.damp(this.currentPanY, this.targetPanY, 11, dt);
      this.currentDist = THREE.MathUtils.damp(this.currentDist, this.targetDist, 11, dt);
      this.currentOrbitYaw = THREE.MathUtils.damp(this.currentOrbitYaw, this.targetOrbitYaw, 11, dt);
      this.currentOrbitPitch = THREE.MathUtils.damp(this.currentOrbitPitch, this.targetOrbitPitch, 11, dt);

      const cosP = Math.cos(this.currentOrbitPitch);
      const sinP = Math.sin(this.currentOrbitPitch);
      const sinY = Math.sin(this.currentOrbitYaw);
      const cosY = Math.cos(this.currentOrbitYaw);

      this.camera.position.set(
        this.currentPanX + sinY * cosP * this.currentDist,
        this.currentPanY + sinP * this.currentDist,
        cosY * cosP * this.currentDist,
      );
      this._tmpPosB.set(this.currentPanX, this.currentPanY, 0);
      this.camera.lookAt(this._tmpPosB);

      this.stepTestFireAnimation(dt);
      this.stepSparks(dt);

      this.renderer.render(this.scene, this.camera);
    }

    this.scheduleNextFrame();
  };

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const sync = gl?.fenceSync?.(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl?.flush?.();
      const poll = () => {
        if (this.disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const st = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl?.SIGNALED;
        if (st === gl?.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 6);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(this.tick, 64);
        }
      };
      this.frameId = window.setTimeout(poll, 6);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  }

  private handleResize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private handleContextRestored = (): void => {
    this.contextLost = false;
  };

  private clearWeapon(): void {
    if (this.internals) {
      this.internals.group.parent?.remove(this.internals.group);
      this.internals.dispose();
      this.internals = null;
    }
    if (this.weaponAssembly) {
      this.weaponPivot.remove(this.weaponAssembly.group);
      this.weaponAssembly.dispose();
      this.weaponAssembly = null;
    }
    for (const d of this.weaponWireframeExtras) d.dispose();
    this.weaponWireframeExtras = [];
    this.weaponKey = '';
  }

  private clearTrajectoryAndPlate(): void {
    this.trajectoryGroup.clear();
    for (const d of this.trajectoryDisposables) d.dispose();
    this.trajectoryDisposables = [];

    this.plateTiltGroup.clear();
    // Keep plateTiltGroup inside plateRoot, remove pedestal children
    for (let i = this.plateRoot.children.length - 1; i >= 0; i--) {
      const ch = this.plateRoot.children[i];
      if (ch !== this.plateTiltGroup) this.plateRoot.remove(ch);
    }
    for (const d of this.plateDisposables) d.dispose();
    this.plateDisposables = [];
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);

    this.clearWeapon();
    this.clearTrajectoryAndPlate();
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

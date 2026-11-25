import * as THREE from 'three';

export interface ElectronicNodeSpec {
  id: string;
  label: string;
  /** Raycastable meshes belonging to this electronic device (tagged automatically) */
  hitMeshes: THREE.Object3D[];
  /** World-space origin for sparks and audio if hitPoint isn't available (e.g. explosions) */
  sparkOrigin: THREE.Vector3;
  /** Optional glowing meshes (tubes, buttons, LEDs) swapped to dead material on break */
  emissiveMeshes?: THREE.Mesh[];
  /** Optional individual materials whose emissive intensity is zeroed on break */
  emissiveMaterials?: THREE.MeshStandardMaterial[];
  /** Optional linked room/bay lights whose intensity is reduced or turned off on break */
  linkedLights?: Array<{ light: THREE.Light; dropFraction: number }>;
  /** True for glass fluorescent tubes / light fixtures (adds crisp filament glass pop to break SFX) */
  isLightFixture?: boolean;
  /** Optional logical interactable ID (e.g. 'ops_laptop', 'power_switch', 'perk_jugg', 'fob_terminal') */
  interactiveLinkId?: string;
  /** Whether the player can Hold [F] to repair this device (default true) */
  repairable?: boolean;
  /** Hold [F] duration in seconds (default 2.0s) */
  repairDurationSec?: number;
  /** Optional world-space repair anchor override (defaults to sparkOrigin) */
  repairAnchor?: THREE.Vector3;
  /** Callback invoked once when this device transitions from working -> broken */
  onBreak?: () => void;
  /** Callback invoked once when this device transitions from broken -> repaired */
  onRepair?: () => void;
}

interface SavedMaterialState {
  mat: THREE.MeshStandardMaterial;
  emissiveHex: number;
  emissiveIntensity: number;
  colorHex: number;
}

interface SavedLightState {
  light: THREE.Light;
  dropAmount: number;
  baseIntensity: number;
  wasVisible: boolean;
}

interface RegisteredElectronicNode {
  id: string;
  label: string;
  sparkOrigin: THREE.Vector3;
  repairAnchor: THREE.Vector3;
  hitMeshes: THREE.Object3D[];
  emissiveMeshes: Array<{ mesh: THREE.Mesh; originalMaterial: THREE.Material | THREE.Material[] }>;
  emissiveMaterials: SavedMaterialState[];
  linkedLights: SavedLightState[];
  isLightFixture: boolean;
  interactiveLinkId?: string;
  repairable: boolean;
  repairDurationSec: number;
  onBreak?: () => void;
  onRepair?: () => void;
  broken: boolean;
  residualTimerSec: number;
  nextResidualPopSec: number;
}

export interface BrokenElectronicRepairTarget {
  id: string;
  label: string;
  anchorPos: THREE.Vector3;
  durationSec: number;
  distanceM: number;
  interactiveLinkId?: string;
}

export interface AutoRegisterElectronicsOptions {
  /** Optional array of raycastable scene meshes to append discovered electronic hit meshes to */
  raycastMeshes?: THREE.Object3D[];
  /** Optional nightLights entries (from maps) to link directly to nearby lamp meshes */
  nightLights?: Array<{
    light?: THREE.Light;
    emissiveMat?: THREE.MeshStandardMaterial;
    baseLightIntensity?: number;
    baseEmissiveIntensity?: number;
  }>;
  /** Prefix to avoid ID collisions when registering multiple chunks/subtrees */
  idPrefix?: string;
  /** Maximum light-to-fixture matching radius (meters) */
  lightMatchRadiusM?: number;
}

interface SparkParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  scale: number;
}

export interface ElectronicBreakEvent {
  id: string;
  label: string;
  alreadyBroken: boolean;
  point: THREE.Vector3;
}

const MAX_SPARK_PARTICLES = 180;

const ELECTRONIC_NAME_RE =
  /(light|lamp|bulb|tube|fixture|flood|beacon|strobe|siren|monitor|screen|display|terminal|console|laptop|computer|radio|comms|radar|camera|cctv|panel|breaker|switch|generator|power|server|chrono|sign|neon|vending|perk|jugg|speed|revive|tap|crate|box|projector|spotlight|lantern|headlight|taillight|street)/i;

const LIGHT_NAME_RE =
  /(light|lamp|bulb|tube|fixture|flood|beacon|strobe|neon|lantern|spotlight|street)/i;

const NON_ELECTRONIC_NAME_RE =
  /(ground|terrain|floor|road|asphalt|grass|foliage|tree|bush|rock|stone|brick|wall|ceiling|roof|pillar|column|beam|crate_wood|sandbag|barricade|window_glass|door|water|sky|cloud|smoke|blood|tracer|decal|ragdoll|zombie|operator|weapon|bullet|shell|grass|leaf|leaves|bark|dirt|mud)/i;

/**
 * Procedural Web Audio synthesizer for shattering fluorescent tubes,
 * cracking monitors, electrical short-circuit spark pops, and tactile repair foley.
 */
class ElectronicsAudio {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private volume = 0.85;

  public setVolume(vol: number): void {
    this.volume = THREE.MathUtils.clamp(vol, 0, 1);
  }

  private ensureCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (!this.noiseBuf && this.ctx) {
      const len = Math.floor(this.ctx.sampleRate * 0.45);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuf = buf;
    }
    return this.ctx;
  }

  public playBreak(isLightFixture: boolean, distanceM: number): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.noiseBuf) return;
    const now = ctx.currentTime;
    const distAtten = THREE.MathUtils.clamp(1.0 - distanceM * 0.018, 0.22, 1.0);
    const gainScale = this.volume * distAtten;
    if (gainScale <= 0.01) return;

    // 1. Crisp glass/housing shatter transient
    const glassSrc = ctx.createBufferSource();
    glassSrc.buffer = this.noiseBuf;
    const glassFilter = ctx.createBiquadFilter();
    glassFilter.type = 'highpass';
    glassFilter.frequency.setValueAtTime(isLightFixture ? 3400 : 2200, now);
    const glassGain = ctx.createGain();
    glassGain.gain.setValueAtTime(0.42 * gainScale, now);
    glassGain.gain.exponentialRampToValueAtTime(0.001, now + (isLightFixture ? 0.24 : 0.16));
    glassSrc.connect(glassFilter);
    glassFilter.connect(glassGain);
    glassGain.connect(ctx.destination);
    glassSrc.start(now);
    glassSrc.stop(now + 0.26);

    // 2. High-voltage electrical arc buzz/pop (sawtooth + bandpass noise)
    const arcOsc = ctx.createOscillator();
    arcOsc.type = 'sawtooth';
    arcOsc.frequency.setValueAtTime(120 + Math.random() * 45, now);
    arcOsc.frequency.exponentialRampToValueAtTime(52, now + 0.14);
    const arcFilter = ctx.createBiquadFilter();
    arcFilter.type = 'bandpass';
    arcFilter.frequency.setValueAtTime(1650, now);
    arcFilter.Q.setValueAtTime(3.2, now);
    const arcGain = ctx.createGain();
    arcGain.gain.setValueAtTime(0.36 * gainScale, now);
    arcGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    arcOsc.connect(arcFilter);
    arcFilter.connect(arcGain);
    arcGain.connect(ctx.destination);
    arcOsc.start(now);
    arcOsc.stop(now + 0.19);

    // 3. Secondary sizzling crackle bursts
    for (let i = 0; i < 3; i++) {
      const t = now + 0.04 + i * (0.045 + Math.random() * 0.04);
      const popSrc = ctx.createBufferSource();
      popSrc.buffer = this.noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2800 + Math.random() * 2400, t);
      bp.Q.setValueAtTime(4.5, t);
      const pg = ctx.createGain();
      pg.gain.setValueAtTime(0.24 * gainScale, t);
      pg.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
      popSrc.connect(bp);
      bp.connect(pg);
      pg.connect(ctx.destination);
      popSrc.start(t);
      popSrc.stop(t + 0.05);
    }
  }

  public playSparkPop(distanceM: number, soft = false): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.noiseBuf) return;
    const now = ctx.currentTime;
    const distAtten = THREE.MathUtils.clamp(1.0 - distanceM * 0.028, 0.12, 1.0);
    const gainScale = this.volume * distAtten * (soft ? 0.55 : 0.85);
    if (gainScale <= 0.01) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3100 + Math.random() * 2000, now);
    bp.Q.setValueAtTime(5.0, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22 * gainScale, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.06);
  }

  /** Tactile wire-seat / connector click / panel tool foley during Hold [F] electronics repair */
  public playElectronicsRepairTick(phaseIndex: number): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.noiseBuf) return;
    const now = ctx.currentTime;
    const gainScale = this.volume * 0.72;
    if (gainScale <= 0.01) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600 + (phaseIndex % 3) * 650, now);
    bp.Q.setValueAtTime(4.2, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22 * gainScale, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.07);

    // Metallic connector latch click
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420 + (phaseIndex % 4) * 90, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.045);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.14 * gainScale, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(og);
    og.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
  }

  /** Relay clack + power-up hum when an electronic device finishes repairing */
  public playElectronicsPowerOn(distanceM: number): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const distAtten = THREE.MathUtils.clamp(1.0 - distanceM * 0.02, 0.35, 1.0);
    const gainScale = this.volume * distAtten;
    if (gainScale <= 0.01) return;

    // 1. Breaker relay snap
    const snap = ctx.createOscillator();
    snap.type = 'square';
    snap.frequency.setValueAtTime(540, now);
    snap.frequency.exponentialRampToValueAtTime(140, now + 0.04);
    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(0.2 * gainScale, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    snap.connect(snapGain);
    snapGain.connect(ctx.destination);
    snap.start(now);
    snap.stop(now + 0.05);

    // 2. Capacitor / ballast power-up rising chime-hum
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.setValueAtTime(118, now + 0.03);
    hum.frequency.exponentialRampToValueAtTime(240, now + 0.24);
    const humGain = ctx.createGain();
    humGain.gain.setValueAtTime(0.001, now + 0.03);
    humGain.gain.linearRampToValueAtTime(0.16 * gainScale, now + 0.08);
    humGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    hum.connect(humGain);
    humGain.connect(ctx.destination);
    hum.start(now + 0.03);
    hum.stop(now + 0.34);
  }

  public dispose(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.noiseBuf = null;
  }
}

/**
 * Universal Destructible & Repairable Electronics System used across Hideout,
 * Battle/Conquest maps, Infection maps, Gym, Survival, and Open World.
 * Handles high-voltage spark bursts, transient arc flashes, emissive/light death,
 * residual short-circuit crackles, interactive gating, and Hold [F] repairs.
 */
export class HideoutElectronicsSystem {
  private readonly root: THREE.Group;
  private readonly nodesById = new Map<string, RegisteredElectronicNode>();
  private readonly nodesByLinkId = new Map<string, RegisteredElectronicNode[]>();
  private readonly nodes: RegisteredElectronicNode[] = [];
  private readonly audio = new ElectronicsAudio();

  private readonly deadGlassMat: THREE.MeshStandardMaterial;
  private readonly sparkGeo: THREE.BoxGeometry;
  private readonly sparkMat: THREE.MeshBasicMaterial;
  private readonly sparkInst: THREE.InstancedMesh;
  private readonly sparks: SparkParticle[] = [];
  private sparkCursor = 0;

  private readonly arcFlashLight: THREE.PointLight;
  private arcFlashTimerSec = 0;

  private readonly raycastTargets: THREE.Object3D[] = [];
  private readonly _dummy = new THREE.Object3D();
  private readonly _velDir = new THREE.Vector3();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);
  private readonly _defaultNormal = new THREE.Vector3(0, -1, 0);
  private readonly _tmpColor = new THREE.Color();
  private readonly _tmpVecA = new THREE.Vector3();
  private readonly _tmpVecB = new THREE.Vector3();
  private readonly _tmpBox = new THREE.Box3();
  private readonly _brightSparkColor = new THREE.Color(0xfff4d6);
  private readonly _amberSparkColor = new THREE.Color(0xf59e0b);
  private readonly _cyanSparkColor = new THREE.Color(0x7dd3fc);

  constructor(parent: THREE.Object3D) {
    this.root = new THREE.Group();
    this.root.name = 'hideout_destructible_electronics';
    parent.add(this.root);

    this.deadGlassMat = new THREE.MeshStandardMaterial({
      color: 0x111316,
      roughness: 0.45,
      metalness: 0.25,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });

    // Zero-GC pooled elongated ember streaks for high-voltage sparks
    this.sparkGeo = new THREE.BoxGeometry(0.011, 0.011, 0.085);
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.sparkInst = new THREE.InstancedMesh(this.sparkGeo, this.sparkMat, MAX_SPARK_PARTICLES);
    this.sparkInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sparkInst.frustumCulled = false;

    this._dummy.position.set(0, -999, 0);
    this._dummy.scale.set(0.0001, 0.0001, 0.0001);
    this._dummy.updateMatrix();
    for (let i = 0; i < MAX_SPARK_PARTICLES; i++) {
      this.sparks.push({
        active: false,
        x: 0,
        y: -999,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 0.5,
        scale: 1,
      });
      this.sparkInst.setMatrixAt(i, this._dummy.matrix);
      this.sparkInst.setColorAt(i, this._amberSparkColor);
    }
    this.sparkInst.instanceMatrix.needsUpdate = true;
    if (this.sparkInst.instanceColor) {
      this.sparkInst.instanceColor.needsUpdate = true;
    }
    this.root.add(this.sparkInst);

    this.arcFlashLight = new THREE.PointLight(0x9be7ff, 0, 9.5, 1.8);
    this.arcFlashLight.position.set(0, -99, 0);
    this.root.add(this.arcFlashLight);
  }

  public setAudioVolume(vol: number): void {
    this.audio.setVolume(vol);
  }

  public getNodeCount(): number {
    return this.nodes.length;
  }

  public getRaycastTargets(): readonly THREE.Object3D[] {
    return this.raycastTargets;
  }

  public registerNode(spec: ElectronicNodeSpec, raycastMeshes?: THREE.Object3D[]): void {
    if (this.nodesById.has(spec.id)) return;

    const linkedLights: SavedLightState[] = (spec.linkedLights ?? []).map((entry) => {
      const baseIntensity =
        typeof entry.light.userData?.baseElectronicIntensity === 'number'
          ? (entry.light.userData.baseElectronicIntensity as number)
          : entry.light.intensity;
      entry.light.userData.baseElectronicIntensity = baseIntensity;
      return {
        light: entry.light,
        dropAmount: baseIntensity * THREE.MathUtils.clamp(entry.dropFraction, 0, 1),
        baseIntensity,
        wasVisible: entry.light.visible,
      };
    });

    const emissiveMeshes = (spec.emissiveMeshes ?? []).map((mesh) => ({
      mesh,
      originalMaterial: mesh.material,
    }));

    const emissiveMaterials: SavedMaterialState[] = (spec.emissiveMaterials ?? []).map((mat) => ({
      mat,
      emissiveHex: mat.emissive.getHex(),
      emissiveIntensity: mat.emissiveIntensity,
      colorHex: mat.color.getHex(),
    }));

    const node: RegisteredElectronicNode = {
      id: spec.id,
      label: spec.label,
      sparkOrigin: spec.sparkOrigin.clone(),
      repairAnchor: (spec.repairAnchor ?? spec.sparkOrigin).clone(),
      hitMeshes: [...spec.hitMeshes],
      emissiveMeshes,
      emissiveMaterials,
      linkedLights,
      isLightFixture: Boolean(spec.isLightFixture),
      interactiveLinkId: spec.interactiveLinkId,
      repairable: spec.repairable ?? true,
      repairDurationSec: THREE.MathUtils.clamp(spec.repairDurationSec ?? 2.0, 1.8, 2.5),
      onBreak: spec.onBreak,
      onRepair: spec.onRepair,
      broken: false,
      residualTimerSec: 0,
      nextResidualPopSec: 0,
    };

    for (const mesh of spec.hitMeshes) {
      mesh.userData.hideoutElectronicId = spec.id;
      if (!mesh.userData.surfaceMaterial) {
        mesh.userData.surfaceMaterial = spec.isLightFixture ? 'glass' : 'metal';
      }
      if (!this.raycastTargets.includes(mesh)) {
        this.raycastTargets.push(mesh);
      }
      if (raycastMeshes && !raycastMeshes.includes(mesh)) {
        raycastMeshes.push(mesh);
      }
    }

    this.nodesById.set(spec.id, node);
    this.nodes.push(node);
    if (spec.interactiveLinkId) {
      let list = this.nodesByLinkId.get(spec.interactiveLinkId);
      if (!list) {
        list = [];
        this.nodesByLinkId.set(spec.interactiveLinkId, list);
      }
      list.push(node);
    }
  }

  /**
   * Automatically scans a Three.js map/world subtree and registers light fixtures,
   * glowing lamps, screens, monitors, beacons, radios, cameras, and consoles into
   * the breakable/repairable electronics system.
   */
  public autoRegisterSceneElectronics(
    root: THREE.Object3D,
    options?: AutoRegisterElectronicsOptions,
  ): number {
    root.updateMatrixWorld(true);
    const idPrefix = options?.idPrefix ?? 'auto_elec';
    const matchRadius = options?.lightMatchRadiusM ?? 3.6;
    const matchRadiusSq = matchRadius * matchRadius;

    // Collect scene point/spot lights (excluding player flashlights/arc flash light)
    const sceneLights: Array<{ light: THREE.Light; worldPos: THREE.Vector3 }> = [];
    root.traverse((obj) => {
      if (obj === this.root || obj === this.arcFlashLight) return;
      if (obj instanceof THREE.PointLight || obj instanceof THREE.SpotLight) {
        if (obj.intensity <= 0.01 && obj.userData?.baseElectronicIntensity === undefined) return;
        const wp = new THREE.Vector3();
        obj.getWorldPosition(wp);
        sceneLights.push({ light: obj, worldPos: wp });
      }
    });

    // Also include explicit WeatherTimeSystem nightLights if provided
    const nightLightMatSet = new Set<THREE.MeshStandardMaterial>();
    if (options?.nightLights) {
      for (let i = 0; i < options.nightLights.length; i++) {
        const nl = options.nightLights[i];
        if (nl.light) {
          if (nl.baseLightIntensity !== undefined) {
            nl.light.userData.baseElectronicIntensity = nl.baseLightIntensity;
          }
          const exists = sceneLights.some((entry) => entry.light === nl.light);
          if (!exists) {
            const wp = new THREE.Vector3();
            nl.light.getWorldPosition(wp);
            sceneLights.push({ light: nl.light, worldPos: wp });
          }
        }
        if (nl.emissiveMat) {
          nightLightMatSet.add(nl.emissiveMat);
        }
      }
    }

    const candidates: Array<{
      mesh: THREE.Mesh;
      worldCenter: THREE.Vector3;
      isLight: boolean;
      label: string;
      emissiveMat?: THREE.MeshStandardMaterial;
      interactiveLinkId?: string;
      repairable?: boolean;
      repairDurationSec?: number;
    }> = [];

    root.traverse((obj) => {
      if (obj === this.root) return;
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj instanceof THREE.InstancedMesh) return;
      if (obj.userData?.hideoutElectronicId) return;
      if (obj.userData?.destructibleDoorId || obj.userData?.isRepairFrameProxy) return;

      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      if (!mat) return;

      const nameChain = `${obj.name ?? ''} ${obj.parent?.name ?? ''}`;
      if (NON_ELECTRONIC_NAME_RE.test(nameChain) && !ELECTRONIC_NAME_RE.test(nameChain)) {
        return;
      }

      let isEmissiveStd = false;
      let emissiveMat: THREE.MeshStandardMaterial | undefined;
      if (mat instanceof THREE.MeshStandardMaterial) {
        const hasEmissiveColor =
          mat.emissive && (mat.emissive.r > 0.06 || mat.emissive.g > 0.06 || mat.emissive.b > 0.06);
        if ((hasEmissiveColor && mat.emissiveIntensity >= 0.18) || nightLightMatSet.has(mat)) {
          isEmissiveStd = true;
          emissiveMat = mat;
        }
      }

      const nameLooksElectronic = ELECTRONIC_NAME_RE.test(nameChain);
      if (!isEmissiveStd && !nameLooksElectronic) return;

      // Measure bounding size so we skip huge structural meshes or tiny invisible dots
      this._tmpBox.setFromObject(obj);
      if (this._tmpBox.isEmpty()) return;
      this._tmpBox.getSize(this._tmpVecA);
      const maxDim = Math.max(this._tmpVecA.x, this._tmpVecA.y, this._tmpVecA.z);
      if (maxDim < 0.06 || maxDim > 4.2) return;

      const worldCenter = new THREE.Vector3();
      this._tmpBox.getCenter(worldCenter);
      const isLight =
        LIGHT_NAME_RE.test(nameChain) ||
        (isEmissiveStd && (worldCenter.y >= 2.15 || nightLightMatSet.has(emissiveMat!)));

      const explicitLabel =
        typeof obj.userData?.electronicLabel === 'string'
          ? (obj.userData.electronicLabel as string)
          : null;
      const explicitLinkId =
        typeof obj.userData?.interactiveLinkId === 'string'
          ? (obj.userData.interactiveLinkId as string)
          : undefined;
      const explicitRepairable =
        typeof obj.userData?.repairable === 'boolean'
          ? (obj.userData.repairable as boolean)
          : undefined;
      const explicitRepairDuration =
        typeof obj.userData?.repairDurationSec === 'number'
          ? (obj.userData.repairDurationSec as number)
          : undefined;

      const label =
        explicitLabel ??
        (isLight
          ? 'Light Fixture'
          : /monitor|screen|display/i.test(nameChain)
            ? 'Monitor'
            : /terminal|console|laptop|computer/i.test(nameChain)
              ? 'Terminal'
              : /radio|comms|radar/i.test(nameChain)
                ? 'Comms Unit'
                : /camera|cctv/i.test(nameChain)
                  ? 'Security Camera'
                  : /switch|breaker|power|generator/i.test(nameChain)
                    ? 'Power Panel'
                    : 'Electronic Fixture');

      candidates.push({
        mesh: obj,
        worldCenter,
        isLight,
        label,
        emissiveMat,
        interactiveLinkId: explicitLinkId,
        repairable: explicitRepairable,
        repairDurationSec: explicitRepairDuration,
      });
    });

    // Cluster nearby electronic meshes (< 0.85m) belonging to the same fixture/terminal
    const visited = new Uint8Array(candidates.length);
    let registeredCount = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const seed = candidates[i];
      const cluster = [seed];
      const avgPos = seed.worldCenter.clone();

      for (let j = i + 1; j < candidates.length; j++) {
        if (visited[j]) continue;
        const other = candidates[j];
        if (other.isLight !== seed.isLight) continue;
        if (other.interactiveLinkId !== seed.interactiveLinkId) continue;
        if (other.worldCenter.distanceToSquared(seed.worldCenter) <= 0.85 * 0.85) {
          visited[j] = 1;
          cluster.push(other);
          avgPos.add(other.worldCenter);
        }
      }
      avgPos.divideScalar(cluster.length);

      const hitMeshes: THREE.Object3D[] = [];
      const emissiveMeshes: THREE.Mesh[] = [];
      for (let k = 0; k < cluster.length; k++) {
        const c = cluster[k];
        hitMeshes.push(c.mesh);
        if (c.emissiveMat) {
          emissiveMeshes.push(c.mesh);
        }
      }

      // Link nearest scene light if within match radius
      const linkedLights: Array<{ light: THREE.Light; dropFraction: number }> = [];
      if (seed.isLight || emissiveMeshes.length > 0) {
        let bestLight: THREE.Light | null = null;
        let bestDistSq = matchRadiusSq;
        for (let l = 0; l < sceneLights.length; l++) {
          const sl = sceneLights[l];
          const dSq = sl.worldPos.distanceToSquared(avgPos);
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestLight = sl.light;
          }
        }
        if (bestLight) {
          linkedLights.push({ light: bestLight, dropFraction: 1.0 });
        }
      }

      // Compute reachable repair anchor (for high ceiling lights, place anchor below at chest height)
      const repairAnchor = avgPos.clone();
      if (repairAnchor.y > 2.35) {
        repairAnchor.y = Math.max(1.25, repairAnchor.y - 1.35);
      }

      this.registerNode(
        {
          id: `${idPrefix}_${registeredCount}`,
          label: seed.label,
          hitMeshes,
          sparkOrigin: avgPos,
          repairAnchor,
          emissiveMeshes,
          linkedLights,
          isLightFixture: seed.isLight,
          interactiveLinkId: seed.interactiveLinkId,
          repairable: seed.repairable ?? true,
          repairDurationSec: seed.repairDurationSec ?? (seed.isLight ? 1.85 : 2.05),
        },
        options?.raycastMeshes,
      );
      registeredCount++;
    }

    return registeredCount;
  }

  public isBroken(id: string): boolean {
    return this.nodesById.get(id)?.broken === true;
  }

  public isInteractiveLinkBroken(linkId: string): boolean {
    const list = this.nodesByLinkId.get(linkId);
    if (!list || list.length === 0) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].broken) return true;
    }
    return false;
  }

  public getNodeByLinkId(linkId: string): { id: string; label: string; broken: boolean; anchorPos: THREE.Vector3; durationSec: number } | null {
    const list = this.nodesByLinkId.get(linkId);
    if (!list || list.length === 0) return null;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.broken) {
        return {
          id: n.id,
          label: n.label,
          broken: true,
          anchorPos: n.repairAnchor.clone(),
          durationSec: n.repairDurationSec,
        };
      }
    }
    const first = list[0];
    return {
      id: first.id,
      label: first.label,
      broken: first.broken,
      anchorPos: first.repairAnchor.clone(),
      durationSec: first.repairDurationSec,
    };
  }

  /**
   * Finds the best nearby broken repairable electronic device in front of the player camera
   * so Hold [F] can repair broken consoles, perk machines, power switches, and reachable fixtures.
   */
  public findBrokenRepairTarget(
    camPos: Readonly<THREE.Vector3>,
    camDir: Readonly<THREE.Vector3>,
    maxDistM = 2.95,
  ): BrokenElectronicRepairTarget | null {
    let best: RegisteredElectronicNode | null = null;
    let bestScore = Infinity;
    let bestDist = Infinity;

    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (!n.broken || !n.repairable) continue;
      // Check both repairAnchor and sparkOrigin (takes whichever is closer so high wall fixtures are still reachable)
      const dAnchor = this._tmpVecA.copy(n.repairAnchor).sub(camPos).length();
      const dSpark = this._tmpVecB.copy(n.sparkOrigin).sub(camPos).length();
      const useAnchor = dAnchor <= dSpark;
      const dist = useAnchor ? dAnchor : dSpark;
      if (dist > maxDistM) continue;

      const dirVec = useAnchor ? this._tmpVecA : this._tmpVecB;
      if (dist > 0.001) {
        dirVec.divideScalar(dist);
      }
      const dot = dirVec.dot(camDir);
      if (dot < 0.42 && dist > 1.35) continue;

      // Prioritize devices closer to crosshair center and interactive terminals
      const linkBonus = n.interactiveLinkId ? -0.35 : 0;
      const score = dist * (1.25 - Math.max(0, dot) * 0.55) + linkBonus;
      if (score < bestScore) {
        bestScore = score;
        best = n;
        bestDist = dist;
      }
    }

    if (!best) return null;
    return {
      id: best.id,
      label: best.label,
      anchorPos: best.repairAnchor.clone(),
      durationSec: best.repairDurationSec,
      distanceM: bestDist,
      interactiveLinkId: best.interactiveLinkId,
    };
  }

  public getRepairAnchorWorldPos(id: string, outPos: THREE.Vector3): boolean {
    const node = this.nodesById.get(id);
    if (!node) return false;
    outPos.copy(node.repairAnchor);
    return true;
  }

  public playRepairWorkTick(pos: Readonly<THREE.Vector3>, phaseIndex: number): void {
    this.audio.playElectronicsRepairTick(phaseIndex);
    if (phaseIndex % 2 === 1) {
      // Small bright soldering / contact spark pop mid-repair
      this.spawnSparks(pos, this._defaultNormal, 5, 0.55);
      this.triggerArcFlash(pos, 3.2, 0.045);
    }
  }

  public repairNode(id: string, listenerPos: Readonly<THREE.Vector3>): boolean {
    const node = this.nodesById.get(id);
    if (!node || !node.broken || !node.repairable) return false;

    node.broken = false;
    node.residualTimerSec = 0;
    node.nextResidualPopSec = 0;

    for (let i = 0; i < node.emissiveMeshes.length; i++) {
      const entry = node.emissiveMeshes[i];
      entry.mesh.material = entry.originalMaterial;
      const mat = Array.isArray(entry.originalMaterial)
        ? entry.originalMaterial[0]
        : entry.originalMaterial;
      if (mat) {
        mat.userData.electronicBroken = false;
      }
    }
    for (let i = 0; i < node.emissiveMaterials.length; i++) {
      const saved = node.emissiveMaterials[i];
      saved.mat.emissive.setHex(saved.emissiveHex);
      saved.mat.emissiveIntensity = saved.emissiveIntensity;
      saved.mat.color.setHex(saved.colorHex);
      saved.mat.userData.electronicBroken = false;
      saved.mat.needsUpdate = true;
    }
    for (let i = 0; i < node.linkedLights.length; i++) {
      const ll = node.linkedLights[i];
      ll.light.userData.electronicBroken = false;
      ll.light.intensity = Math.min(ll.baseIntensity, ll.light.intensity + ll.dropAmount);
      if (ll.light.intensity > 0.02 || ll.wasVisible) {
        ll.light.visible = true;
      }
    }

    if (node.onRepair) {
      node.onRepair();
    }

    const distM = node.sparkOrigin.distanceTo(listenerPos);
    this.spawnSparks(node.sparkOrigin, this._defaultNormal, 8, 0.55);
    this.triggerArcFlash(node.sparkOrigin, 5.5, 0.08);
    this.audio.playElectronicsPowerOn(distM);
    return true;
  }

  public resolveElectronicId(obj: THREE.Object3D | null | undefined): string | null {
    let cur: THREE.Object3D | null | undefined = obj;
    while (cur) {
      const id = cur.userData?.hideoutElectronicId as string | undefined;
      if (id) return id;
      cur = cur.parent;
    }
    return null;
  }

  public handleImpact(
    obj: THREE.Object3D | null | undefined,
    hitPoint: THREE.Vector3,
    normal: THREE.Vector3 | null,
    listenerPos: THREE.Vector3,
  ): ElectronicBreakEvent | null {
    const id = this.resolveElectronicId(obj);
    if (!id) return null;
    const node = this.nodesById.get(id);
    if (!node) return null;

    const distM = hitPoint.distanceTo(listenerPos);
    const outNormal = normal && normal.lengthSq() > 0.01 ? normal : this._defaultNormal;

    if (node.broken) {
      // Already broken — kick up a smaller secondary spark shower on repeat hits
      this.spawnSparks(hitPoint, outNormal, 12, 0.85);
      this.triggerArcFlash(hitPoint, 6.5, 0.075);
      this.audio.playSparkPop(distM, false);
      return {
        id: node.id,
        label: node.label,
        alreadyBroken: true,
        point: hitPoint.clone(),
      };
    }

    this.breakNode(node, hitPoint, outNormal, distM);
    return {
      id: node.id,
      label: node.label,
      alreadyBroken: false,
      point: hitPoint.clone(),
    };
  }

  public handleExplosion(
    center: THREE.Vector3,
    radiusM: number,
    listenerPos: THREE.Vector3,
  ): ElectronicBreakEvent[] {
    const brokenEvents: ElectronicBreakEvent[] = [];
    const rSq = radiusM * radiusM;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.sparkOrigin.distanceToSquared(center) > rSq) continue;
      if (node.broken) continue;
      const distM = node.sparkOrigin.distanceTo(listenerPos);
      this.breakNode(node, node.sparkOrigin, this._defaultNormal, distM);
      brokenEvents.push({
        id: node.id,
        label: node.label,
        alreadyBroken: false,
        point: node.sparkOrigin.clone(),
      });
    }
    return brokenEvents;
  }

  private breakNode(
    node: RegisteredElectronicNode,
    impactPoint: THREE.Vector3,
    normal: THREE.Vector3,
    distM: number,
  ): void {
    node.broken = true;
    node.residualTimerSec = 5.5 + Math.random() * 3.0;
    node.nextResidualPopSec = 0.55 + Math.random() * 0.65;

    for (let i = 0; i < node.emissiveMeshes.length; i++) {
      const entry = node.emissiveMeshes[i];
      const mat = Array.isArray(entry.originalMaterial)
        ? entry.originalMaterial[0]
        : entry.originalMaterial;
      if (mat) {
        mat.userData.electronicBroken = true;
      }
      entry.mesh.material = this.deadGlassMat;
    }
    for (let i = 0; i < node.emissiveMaterials.length; i++) {
      const m = node.emissiveMaterials[i].mat;
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
      m.color.setHex(0x16181c);
      m.userData.electronicBroken = true;
      m.needsUpdate = true;
    }
    for (let i = 0; i < node.linkedLights.length; i++) {
      const ll = node.linkedLights[i];
      ll.light.userData.electronicBroken = true;
      ll.light.intensity = Math.max(0, ll.light.intensity - ll.dropAmount);
      if (ll.light.intensity <= 0.05) {
        ll.light.intensity = 0;
        ll.light.visible = false;
      }
    }

    if (node.onBreak) {
      node.onBreak();
    }

    this.spawnSparks(impactPoint, normal, node.isLightFixture ? 28 : 34, 1.15);
    this.triggerArcFlash(impactPoint, 14.0, 0.11);
    this.audio.playBreak(node.isLightFixture, distM);
  }

  private triggerArcFlash(pos: Readonly<THREE.Vector3>, intensity: number, durationSec: number): void {
    this.arcFlashLight.position.copy(pos);
    this.arcFlashLight.intensity = intensity;
    this.arcFlashTimerSec = durationSec;
  }

  private spawnSparks(
    origin: Readonly<THREE.Vector3>,
    normal: Readonly<THREE.Vector3>,
    count: number,
    speedScale: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % MAX_SPARK_PARTICLES;

      const spread = 1.9 + Math.random() * 2.8;
      const rx = (Math.random() - 0.5) * 2.0;
      const ry = (Math.random() - 0.35) * 2.0;
      const rz = (Math.random() - 0.5) * 2.0;

      p.active = true;
      p.x = origin.x + (Math.random() - 0.5) * 0.06;
      p.y = origin.y + (Math.random() - 0.5) * 0.06;
      p.z = origin.z + (Math.random() - 0.5) * 0.06;
      p.vx = (normal.x * 1.35 + rx) * spread * speedScale;
      p.vy = (normal.y * 1.15 + ry + 0.55) * spread * speedScale;
      p.vz = (normal.z * 1.35 + rz) * spread * speedScale;
      p.maxLife = 0.28 + Math.random() * 0.52;
      p.life = p.maxLife;
      p.scale = 0.65 + Math.random() * 0.85;

      // Mix incandescent white-amber sparks with occasional blue-white electrical arc sparks
      const roll = Math.random();
      if (roll < 0.22) {
        this._tmpColor.copy(this._cyanSparkColor);
      } else if (roll < 0.58) {
        this._tmpColor.copy(this._brightSparkColor);
      } else {
        this._tmpColor.copy(this._amberSparkColor);
      }
      this.sparkInst.setColorAt(this.sparkCursor === 0 ? MAX_SPARK_PARTICLES - 1 : this.sparkCursor - 1, this._tmpColor);
    }
    if (this.sparkInst.instanceColor) {
      this.sparkInst.instanceColor.needsUpdate = true;
    }
  }

  public update(dt: number, listenerPos?: THREE.Vector3): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);

    // Decay transient arc flash light
    if (this.arcFlashTimerSec > 0) {
      this.arcFlashTimerSec = Math.max(0, this.arcFlashTimerSec - clampedDt);
      if (this.arcFlashTimerSec <= 0) {
        this.arcFlashLight.intensity = 0;
      } else {
        this.arcFlashLight.intensity *= Math.pow(0.08, clampedDt * 8);
      }
    }

    // Residual intermittent short-circuit pops on recently broken devices
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (!node.broken || node.residualTimerSec <= 0) continue;
      node.residualTimerSec = Math.max(0, node.residualTimerSec - clampedDt);
      node.nextResidualPopSec -= clampedDt;
      if (node.nextResidualPopSec <= 0) {
        node.nextResidualPopSec = 0.75 + Math.random() * 1.45;
        this.spawnSparks(node.sparkOrigin, this._defaultNormal, 6 + Math.floor(Math.random() * 6), 0.65);
        this.triggerArcFlash(node.sparkOrigin, 4.2, 0.055);
        if (listenerPos) {
          this.audio.playSparkPop(node.sparkOrigin.distanceTo(listenerPos), true);
        }
      }
    }

    // Step pooled sparks zero-GC
    let anyDirty = false;
    const gravity = 9.81;
    for (let i = 0; i < MAX_SPARK_PARTICLES; i++) {
      const p = this.sparks[i];
      if (!p.active) continue;
      anyDirty = true;

      p.life -= clampedDt;
      if (p.life <= 0) {
        p.active = false;
        this._dummy.position.set(0, -999, 0);
        this._dummy.scale.set(0.0001, 0.0001, 0.0001);
        this._dummy.updateMatrix();
        this.sparkInst.setMatrixAt(i, this._dummy.matrix);
        continue;
      }

      p.vy -= gravity * clampedDt;
      const drag = Math.max(0, 1 - 1.8 * clampedDt);
      p.vx *= drag;
      p.vz *= drag;
      p.x += p.vx * clampedDt;
      p.y += p.vy * clampedDt;
      p.z += p.vz * clampedDt;

      // Floor bounce
      if (p.y < 0.025) {
        p.y = 0.025;
        p.vy = Math.abs(p.vy) * 0.42;
        p.vx *= 0.72;
        p.vz *= 0.72;
      }

      const lifeFrac = p.life / p.maxLife;
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      this._dummy.position.set(p.x, p.y, p.z);
      if (speed > 0.08) {
        this._velDir.set(p.vx / speed, p.vy / speed, p.vz / speed);
        this._dummy.lookAt(
          p.x + this._velDir.x,
          p.y + this._velDir.y,
          p.z + this._velDir.z,
        );
      } else {
        this._dummy.quaternion.setFromUnitVectors(this._upVec, this._upVec);
      }
      const stretch = THREE.MathUtils.clamp(0.45 + speed * 0.22, 0.35, 2.2) * lifeFrac;
      const thickness = p.scale * (0.45 + 0.55 * lifeFrac);
      this._dummy.scale.set(thickness, thickness, stretch * p.scale);
      this._dummy.updateMatrix();
      this.sparkInst.setMatrixAt(i, this._dummy.matrix);
    }

    if (anyDirty) {
      this.sparkInst.instanceMatrix.needsUpdate = true;
    }
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      n.sparkOrigin.x -= shiftX;
      n.sparkOrigin.z -= shiftZ;
      n.repairAnchor.x -= shiftX;
      n.repairAnchor.z -= shiftZ;
    }
    this.arcFlashLight.position.x -= shiftX;
    this.arcFlashLight.position.z -= shiftZ;
    for (let i = 0; i < MAX_SPARK_PARTICLES; i++) {
      const p = this.sparks[i];
      if (!p.active) continue;
      p.x -= shiftX;
      p.z -= shiftZ;
    }
  }

  public removeNodesByPrefix(prefix: string): void {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      if (!node.id.startsWith(prefix)) continue;
      this.nodesById.delete(node.id);
      if (node.interactiveLinkId) {
        const list = this.nodesByLinkId.get(node.interactiveLinkId);
        if (list) {
          const idx = list.indexOf(node);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) this.nodesByLinkId.delete(node.interactiveLinkId);
        }
      }
      for (let m = 0; m < node.hitMeshes.length; m++) {
        const idx = this.raycastTargets.indexOf(node.hitMeshes[m]);
        if (idx !== -1) this.raycastTargets.splice(idx, 1);
      }
      this.nodes.splice(i, 1);
    }
  }

  public dispose(): void {
    this.audio.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.deadGlassMat.dispose();
    this.root.removeFromParent();
  }
}

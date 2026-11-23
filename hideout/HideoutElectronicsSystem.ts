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
  /** True for glass fluorescent tubes (adds crisp filament glass pop to break SFX) */
  isLightFixture?: boolean;
  /** Callback invoked once when this device transitions from working -> broken */
  onBreak?: () => void;
}

interface RegisteredElectronicNode {
  id: string;
  label: string;
  sparkOrigin: THREE.Vector3;
  emissiveMeshes: THREE.Mesh[];
  emissiveMaterials: THREE.MeshStandardMaterial[];
  linkedLights: Array<{ light: THREE.Light; dropAmount: number }>;
  isLightFixture: boolean;
  onBreak?: () => void;
  broken: boolean;
  residualTimerSec: number;
  nextResidualPopSec: number;
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

/**
 * Procedural Web Audio synthesizer for shattering fluorescent tubes,
 * cracking monitors, and electrical short-circuit spark pops.
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

  public dispose(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.noiseBuf = null;
  }
}

/**
 * Session-only Destructible Electronics System for the Hideout Bunker.
 * All damage state lives purely in runtime memory — reloading refreshes every
 * console, monitor, chronograph, strobe beacon, and overhead light fixture.
 */
export class HideoutElectronicsSystem {
  private readonly root: THREE.Group;
  private readonly nodesById = new Map<string, RegisteredElectronicNode>();
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

  private readonly _dummy = new THREE.Object3D();
  private readonly _velDir = new THREE.Vector3();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);
  private readonly _defaultNormal = new THREE.Vector3(0, -1, 0);
  private readonly _tmpColor = new THREE.Color();
  private readonly _brightSparkColor = new THREE.Color(0xfff4d6);
  private readonly _amberSparkColor = new THREE.Color(0xf59e0b);
  private readonly _cyanSparkColor = new THREE.Color(0x7dd3fc);

  constructor(parent: THREE.Group) {
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

  public registerNode(spec: ElectronicNodeSpec, raycastMeshes?: THREE.Object3D[]): void {
    const linkedLights = (spec.linkedLights ?? []).map((entry) => ({
      light: entry.light,
      dropAmount: entry.light.intensity * THREE.MathUtils.clamp(entry.dropFraction, 0, 1),
    }));

    const node: RegisteredElectronicNode = {
      id: spec.id,
      label: spec.label,
      sparkOrigin: spec.sparkOrigin.clone(),
      emissiveMeshes: spec.emissiveMeshes ? [...spec.emissiveMeshes] : [],
      emissiveMaterials: spec.emissiveMaterials ? [...spec.emissiveMaterials] : [],
      linkedLights,
      isLightFixture: Boolean(spec.isLightFixture),
      onBreak: spec.onBreak,
      broken: false,
      residualTimerSec: 0,
      nextResidualPopSec: 0,
    };

    for (const mesh of spec.hitMeshes) {
      mesh.userData.hideoutElectronicId = spec.id;
      if (!mesh.userData.surfaceMaterial) {
        mesh.userData.surfaceMaterial = spec.isLightFixture ? 'glass' : 'metal';
      }
      if (raycastMeshes && !raycastMeshes.includes(mesh)) {
        raycastMeshes.push(mesh);
      }
    }

    this.nodesById.set(spec.id, node);
    this.nodes.push(node);
  }

  public isBroken(id: string): boolean {
    return this.nodesById.get(id)?.broken === true;
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
      node.emissiveMeshes[i].material = this.deadGlassMat;
    }
    for (let i = 0; i < node.emissiveMaterials.length; i++) {
      const m = node.emissiveMaterials[i];
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
      m.color.setHex(0x16181c);
      m.needsUpdate = true;
    }
    for (let i = 0; i < node.linkedLights.length; i++) {
      const ll = node.linkedLights[i];
      ll.light.intensity = Math.max(0, ll.light.intensity - ll.dropAmount);
      if (ll.light.intensity <= 0.05) {
        ll.light.intensity = 0;
      }
    }

    if (node.onBreak) {
      node.onBreak();
    }

    this.spawnSparks(impactPoint, normal, node.isLightFixture ? 28 : 34, 1.15);
    this.triggerArcFlash(impactPoint, 14.0, 0.11);
    this.audio.playBreak(node.isLightFixture, distM);
  }

  private triggerArcFlash(pos: THREE.Vector3, intensity: number, durationSec: number): void {
    this.arcFlashLight.position.copy(pos);
    this.arcFlashLight.intensity = intensity;
    this.arcFlashTimerSec = durationSec;
  }

  private spawnSparks(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
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

  public dispose(): void {
    this.audio.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.deadGlassMat.dispose();
    this.root.removeFromParent();
  }
}
